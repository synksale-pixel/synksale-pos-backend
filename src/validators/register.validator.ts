/**
 * Purpose: Register Validators (Phase 4a-2, contract).
 * A register is one till in a store. A shift opens on a register (4b) and every sale records
 * the register it was rung up on (decision 2: per-register numbering later, e.g. ZATCA).
 * Opening float, drawer limit and expected cash are per register and arrive with shifts in 4b.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

const nameField = z
  .string()
  .trim()
  .min(1, { message: "Register name is required." })
  .max(50, { message: "Register name must be at most 50 characters long." })
  .openapi({
    description: "Shown in the register picker and on receipts. Unique within the store (case-insensitive).",
    example: "Counter 2",
  });

export const createRegisterSchema = z
  .object({
    name: nameField,
    isActive: z.boolean().optional().openapi({ description: "Defaults to true.", example: true }),
  })
  .strict({ message: "Unknown field. Only name and isActive are accepted." })
  .openapi("CreateRegisterInput");

export const updateRegisterSchema = z
  .object({
    name: nameField.optional(),
    isActive: z.boolean().optional().openapi({
      description:
        "false hides the register from the picker and blocks opening a shift on it. From 4b, a register with an open shift cannot be deactivated (`REGISTER_HAS_OPEN_SHIFT`).",
      example: false,
    }),
  })
  .strict({ message: "Unknown field. Only name and isActive can be updated." })
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." })
  .openapi("UpdateRegisterInput");

export const listRegistersQuerySchema = z.object({
  isActive: z.enum(["true", "false"]).optional().openapi({
    description: "Omit for all registers; `true` for the picker.",
    example: "true",
  }),
});

export type CreateRegisterInput = z.infer<typeof createRegisterSchema>;
export type UpdateRegisterInput = z.infer<typeof updateRegisterSchema>;
