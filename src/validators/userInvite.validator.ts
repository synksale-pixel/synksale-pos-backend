/**
 * Purpose: User Invite Validators.
 * Provides Zod validation schemas for inviting users and accepting invitations.
 */

import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "./platformAuth.validator";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .email({ message: "Invalid email format." }),
  firstName: z
    .string()
    .trim()
    .min(1, { message: "First name is required." })
    .max(50, { message: "First name must be at most 50 characters long." }),
  lastName: z
    .string()
    .trim()
    .min(1, { message: "Last name is required." })
    .max(50, { message: "Last name must be at most 50 characters long." }),
  roleId: z
    .string()
    .regex(objectIdRegex, { message: "Invalid roleId format. Must be a 24-character hex string." }),
  storeId: z
    .string()
    .regex(objectIdRegex, { message: "Invalid storeId format. Must be a 24-character hex string." })
    .optional(),
});

export const acceptInviteSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, { message: "Invitation token is required." }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, {
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    }),
});
