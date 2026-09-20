/**
 * Purpose: Platform Organization Review Service.
 * Implements Super Admin review actions for the sales-assisted/gated onboarding model:
 * listing, inspecting, approving, and rejecting organization applications.
 */

import mongoose from "mongoose";
import { Organization, IOrganization } from "../models/organization.model";
import { ApiError } from "../utils/ApiError";

export interface ListOrganizationsInput {
  status?: "pending" | "approved" | "rejected";
  page?: number;
  limit?: number;
}

/**
 * Lists organizations with optional approvalStatus filtering and pagination.
 */
export async function listOrganizations(input: ListOrganizationsInput) {
  const page = input.page && input.page > 0 ? input.page : 1;
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;

  const filter = input.status ? { approvalStatus: input.status } : {};

  const [organizations, total] = await Promise.all([
    Organization.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Organization.countDocuments(filter),
  ]);

  return {
    organizations,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Fetches a single organization by ID for Super Admin review.
 */
export async function getOrganizationById(id: string): Promise<IOrganization> {
  const organization = await Organization.findById(id);
  if (!organization) {
    throw new ApiError(404, "Organization not found.");
  }
  return organization;
}

/**
 * Approves a pending (or previously rejected) organization application, granting it
 * the ability to authenticate. The status transition is a single conditional update,
 * so concurrent approve/reject calls cannot both succeed.
 */
export async function approveOrganization(
  id: string,
  approvedByUserId: string,
  slugOverride?: string
) {
  const organization = await Organization.findById(id);
  if (!organization) {
    throw new ApiError(404, "Organization not found.");
  }

  if (organization.approvalStatus === "approved") {
    throw new ApiError(400, "This organization is already approved.");
  }

  // Re-approving a rejected org must not give the same applicant two live organizations
  // (e.g. they re-applied after the rejection).
  if (organization.applicantEmail) {
    const sibling = await Organization.exists({
      _id: { $ne: organization._id },
      applicantEmail: organization.applicantEmail,
      approvalStatus: { $in: ["pending", "approved"] },
    });
    if (sibling) {
      throw new ApiError(
        409,
        "Another pending or approved organization already exists for this applicant email."
      );
    }
  }

  const set: Record<string, unknown> = {
    approvalStatus: "approved",
    approvedBy: new mongoose.Types.ObjectId(approvedByUserId),
    approvedAt: new Date(),
    // Clear any prior rejection state in case this is a re-review after an earlier rejection
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
  };

  // Optional slug correction at approval time (e.g. a squatted/suffixed slug).
  // Only allowed here, before the tenant can authenticate, since login resolves by slug.
  if (slugOverride && slugOverride !== organization.slug) {
    const taken = await Organization.exists({ slug: slugOverride, _id: { $ne: organization._id } });
    if (taken) {
      throw new ApiError(409, "This slug is already in use by another organization.");
    }
    set.slug = slugOverride;
  }

  let updated;
  try {
    updated = await Organization.findOneAndUpdate(
      { _id: organization._id, approvalStatus: { $in: ["pending", "rejected"] } },
      { $set: set },
      { new: true }
    );
  } catch (error) {
    // Race with another org claiming the slug between the check above and the update
    if ((error as { code?: number }).code === 11000) {
      throw new ApiError(409, "This slug is already in use by another organization.");
    }
    throw error;
  }

  if (!updated) {
    throw new ApiError(409, "This organization's status changed concurrently. Reload and retry.");
  }
  return updated;
}

/**
 * Rejects a pending organization application, permanently blocking authentication
 * until (and unless) a Super Admin later approves it.
 */
export async function rejectOrganization(
  id: string,
  rejectedByUserId: string,
  reason: string
) {
  // Only pending applications can be rejected. Rejecting an approved org would log out
  // every user mid-shift (authenticate re-checks approvalStatus per request); use
  // `isActive` to suspend a live organization instead. The status check is part of the
  // update filter so it is atomic with the transition.
  const updated = await Organization.findOneAndUpdate(
    { _id: id, approvalStatus: "pending" },
    {
      $set: {
        approvalStatus: "rejected",
        rejectedBy: new mongoose.Types.ObjectId(rejectedByUserId),
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
    },
    { new: true }
  );

  if (!updated) {
    const existing = await Organization.findById(id);
    if (!existing) {
      throw new ApiError(404, "Organization not found.");
    }
    throw new ApiError(
      400,
      `Only pending organizations can be rejected. This organization is ${existing.approvalStatus}.`
    );
  }
  return updated;
}
