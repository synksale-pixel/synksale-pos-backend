/**
 * Purpose: User Invite Validators.
 * Provides Zod validation schemas for inviting users and accepting invitations.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "./platformAuth.validator";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .email({ message: "Invalid email format." })
    .openapi({
      description:
        "Email of the person being invited. Must not already exist in your organization.",
      example: "priya.nair@sharmastore.in",
    }),
  firstName: z
    .string()
    .trim()
    .min(1, { message: "First name is required." })
    .max(50, { message: "First name must be at most 50 characters long." })
    .openapi({ example: "Priya" }),
  lastName: z
    .string()
    .trim()
    .min(1, { message: "Last name is required." })
    .max(50, { message: "Last name must be at most 50 characters long." })
    .openapi({ example: "Nair" }),
  roleId: z
    .string()
    .regex(objectIdRegex, { message: "Invalid roleId format. Must be a 24-character hex string." })
    .openapi({
      description:
        "ID of an existing role in YOUR organization to assign. You cannot assign a role above your own scope/permissions (403).",
      example: "665f1c2e8a4b3c0012ab34cd",
    }),
  storeId: z
    .string()
    .regex(objectIdRegex, { message: "Invalid storeId format. Must be a 24-character hex string." })
    .optional()
    .openapi({
      description:
        "Store the invitee is assigned to. REQUIRED when the role is store-scoped (400 otherwise); not used for organization-scoped roles. Must be a store you have access to (403 otherwise).",
      example: "665f1c2e8a4b3c0012ab34ef",
    }),
});

export const acceptInviteSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, { message: "Invitation token is required." })
    .openapi({
      description: "Plaintext invite token from the invitation link (?token=...).",
      example:
        "b7d1f0c39a8e4d2f6c5b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a39281706",
    }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, {
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    })
    .openapi({
      description: `Password for the new account. Minimum ${PASSWORD_MIN_LENGTH} characters.`,
      example: "S3cure!Passw0rd",
    }),
});
