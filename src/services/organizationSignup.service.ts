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
import { generateAccessToken, generateRefreshToken } from "./auth.service";
import { getExpiryDate } from "../utils/token.util";
import { env } from "../config/env.config";
import { ApiError } from "../utils/ApiError";

export interface SignupOrganizationInput {
  organizationName: string;
  contactEmail: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
  adminPassword?: string;
  ipAddress?: string;
  userAgent?: string;
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
export async function signupOrganization(input: SignupOrganizationInput) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
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
          contactEmail: input.contactEmail.toLowerCase().trim(),
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
          email: input.adminEmail.toLowerCase().trim(),
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

    // 6. Generate access and refresh tokens for the created admin user (outside the transaction)
    const accessToken = generateAccessToken({
      userId: adminUser._id.toString(),
      organizationId: organization._id.toString(),
      isSuperAdmin: false,
    });

    const { token: refreshToken, hashedToken } = generateRefreshToken();
    const expiresAt = getExpiryDate(env.JWT_REFRESH_EXPIRY);

    // Update refresh tokens list for the admin user
    await User.findByIdAndUpdate(adminUser._id, {
      $push: {
        refreshTokens: {
          token: hashedToken,
          createdAt: new Date(),
          expiresAt,
          userAgent: input.userAgent,
          ipAddress: input.ipAddress,
        },
      },
      $set: {
        lastLoginAt: new Date(),
      },
    });

    // Remove sensitive fields from user response
    const { passwordHash: _passwordHash, refreshTokens: _refreshTokens, ...userResponse } = adminUser.toObject();

    return {
      organization,
      user: userResponse,
      accessToken,
      refreshToken,
    };
  } catch (error) {
    // Abort transaction on any failure to guarantee database consistency
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}
