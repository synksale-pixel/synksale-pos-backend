/**
 * Purpose: Organization Signup Service.
 * Implements the atomic signup flow for new organizations/tenants.
 * Uses a Mongoose transaction to ensure that organization creation, default role seeding,
 * and organization admin user creation succeed or fail together.
 */

import mongoose from "mongoose";
import { Organization } from "../models/organization.model";
import { User } from "../models/user.model";
import { Role } from "../models/role.model";
import { seedDefaultRolesForOrganization } from "./roleSeed.service";
import { ApiError } from "../utils/ApiError";

export interface SignupOrganizationInput {
  organizationName: string;
  contactEmail?: string;
  contactPhone: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
  adminPassword?: string;
}

/**
 * Generates a URL slug from the organization name.
 * Simple inline implementation to avoid adding external dependencies.
 */
function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-") // Replace spaces with -
    .replace(/[^\w-]+/g, "") // Remove all non-word chars
    .replace(/--+/g, "-"); // Replace multiple - with single -
}

/**
 * Handles the signup flow of an organization and its admin user.
 * Runs atomically inside a transaction to prevent leaving dangling or broken organizations.
 */
async function signupOrganizationOnce(input: SignupOrganizationInput) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 0. Block duplicate applications: the admin email must not already have an
    // organization that is pending review or approved. Rejected organizations are
    // ignored so the applicant is not locked out (a re-apply flow will come later).
    // The pending half is also enforced by a unique index (see organization.model.ts).
    const adminEmail = input.adminEmail.toLowerCase().trim();
    const activeApplication = await Organization.exists({
      applicantEmail: adminEmail,
      approvalStatus: { $in: ["pending", "approved"] },
    }).session(session);

    if (activeApplication) {
      throw new ApiError(
        409,
        "An organization application with this admin email already exists."
      );
    }

    // 1. Generate a unique slug for the organization
    let slug = slugify(input.organizationName);
    let isUnique = false;
    let attempts = 0;
    
    // Attempt collision handling by appending random string if slug exists
    while (!isUnique && attempts < 10) {
      const existing = await Organization.findOne({ slug }).session(session);
      if (!existing) {
        isUnique = true;
      } else {
        const suffix = Math.random().toString(36).substring(2, 6);
        slug = `${slugify(input.organizationName)}-${suffix}`;
        attempts++;
      }
    }

    if (!isUnique) {
      throw new ApiError(
        500,
        "Failed to generate a unique slug for the organization after multiple attempts."
      );
    }

    // 2. Create the Organization document
    // We default settings.timezone to 'UTC' since timezone is required by the schema.
    const [organization] = await Organization.create(
      [
        {
          name: input.organizationName.trim(),
          slug,
          applicantEmail: adminEmail,
          // Falls back to the admin email when no contact email is provided
          contactEmail: (input.contactEmail || input.adminEmail).toLowerCase().trim(),
          contactPhone: input.contactPhone.trim(),
          settings: {
            currency: "INR",
            timezone: "UTC",
          },
        },
      ],
      { session }
    );

    // 3. Seed default roles for this new organization
    await seedDefaultRolesForOrganization(organization._id, { session });

    // 4. Fetch the org_admin role we just seeded to assign to the first user
    const adminRole = await Role.findOne({
      organizationId: organization._id,
      slug: "org_admin",
    }).session(session);

    if (!adminRole) {
      throw new ApiError(
        500,
        "Crucial system configuration error: 'org_admin' role failed to seed."
      );
    }

    // 5. Create the admin user
    // Plaintext password is passed here; the model pre-save hook handles the hashing.
    const [adminUser] = await User.create(
      [
        {
          organizationId: organization._id,
          email: adminEmail,
          passwordHash: input.adminPassword,
          firstName: input.adminFirstName.trim(),
          lastName: input.adminLastName.trim(),
          isSuperAdmin: false,
          orgRoleId: adminRole._id,
          isActive: true,
          inviteStatus: "accepted", // Automatically accepted upon signup
        },
      ],
      { session }
    );

    // Commit the transaction to persist the organization, roles, and admin user
    await session.commitTransaction();
    session.endSession();

    // NOTE: No tokens are issued here. The organization is created with
    // approvalStatus: "pending" (schema default) and cannot authenticate until
    // a Super Admin approves it via the platform organization review API.
    const { passwordHash: _passwordHash, refreshTokens: _refreshTokens, ...userResponse } = adminUser.toObject();

    return {
      organization,
      user: userResponse,
    };
  } catch (error) {
    // Abort transaction on any failure to guarantee database consistency
    await session.abortTransaction();
    session.endSession();

    // Concurrent duplicate application caught by the pending-applicant unique index
    const dupKey = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (dupKey.code === 11000 && dupKey.keyPattern?.applicantEmail) {
      throw new ApiError(409, "An organization application with this admin email already exists.");
    }
    throw error;
  }
}

/**
 * Public entry point. Concurrent signups for the same applicant collide on the pending
 * unique index as a transient WriteConflict rather than E11000, so retry a few times:
 * once the winner commits, the retry sees its org in the pre-check and returns a clean 409.
 */
export async function signupOrganization(input: SignupOrganizationInput) {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return await signupOrganizationOnce(input);
    } catch (error) {
      const labels = (error as { errorLabels?: string[] }).errorLabels;
      const transient = Array.isArray(labels) && labels.includes("TransientTransactionError");
      if (!transient || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}
