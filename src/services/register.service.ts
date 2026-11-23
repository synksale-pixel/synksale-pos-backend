/**
 * Purpose: Register Service (Phase 4a-2).
 * Listing, reading, creating, renaming/deactivating and deleting a store's registers, and the
 * default register every store is created with.
 * Register is organization+store scoped by the tenantScopePlugin (the route's scopeToStore puts
 * the store in the request context); organizationId and storeId are still passed explicitly.
 */

import mongoose from "mongoose";
import { Register, RegisterDocument, DEFAULT_REGISTER_NAME, registerNameKey } from "../models/register.model";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";
import type { CreateRegisterInput, UpdateRegisterInput } from "../validators/register.validator";

function notFound(): ApiError {
  return ApiError.coded(404, "REGISTER_NOT_FOUND", "Register not found.", [{ field: "registerId", code: "REGISTER_NOT_FOUND" }]);
}

function nameTaken(name: string): ApiError {
  return ApiError.coded(409, "REGISTER_NAME_TAKEN", `Another register in this store is already named '${name}'.`, [
    { field: "name", code: "REGISTER_NAME_TAKEN" },
  ]);
}

function inUse(shiftCount: number): ApiError {
  return ApiError.coded(409, "REGISTER_IN_USE", "This register has shifts and cannot be deleted. Deactivate it instead.", [
    { code: "REGISTER_IN_USE", meta: { shiftCount } },
  ]);
}

function isDuplicateName(error: unknown): boolean {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  return dup.code === 11000 && Boolean(dup.keyPattern?.nameKey);
}

function toView(register: RegisterDocument) {
  return {
    _id: register._id,
    id: register._id,
    organizationId: register.organizationId,
    storeId: register.storeId,
    name: register.name,
    isActive: register.isActive,
    createdAt: register.createdAt,
    updatedAt: register.updatedAt,
  };
}

async function findRegisterOrThrow(organizationId: string, storeId: string, registerId: string) {
  const register = await Register.findOne({ _id: registerId, organizationId, storeId });
  if (!register) throw notFound();
  return register;
}

async function nameExists(organizationId: string, storeId: string, name: string, excludeId?: mongoose.Types.ObjectId) {
  const filter: Record<string, unknown> = { organizationId, storeId, nameKey: registerNameKey(name) };
  if (excludeId) filter._id = { $ne: excludeId };
  return Boolean(await Register.exists(filter));
}

/** Every register of the store (a store has few), sorted by name. Not paginated. */
export async function listRegisters(organizationId: string, storeId: string, input: { isActive?: boolean }) {
  const filter: Record<string, unknown> = { organizationId, storeId };
  if (input.isActive !== undefined) filter.isActive = input.isActive;
  const registers = await Register.find(filter).sort({ nameKey: 1, _id: 1 });
  return { registers: registers.map(toView) };
}

export async function getRegister(organizationId: string, storeId: string, registerId: string) {
  return toView(await findRegisterOrThrow(organizationId, storeId, registerId));
}

export async function createRegister(organizationId: string, storeId: string, input: CreateRegisterInput, actorUserId: string) {
  if (await nameExists(organizationId, storeId, input.name)) throw nameTaken(input.name);

  const register = new Register({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    storeId: new mongoose.Types.ObjectId(storeId),
    name: input.name,
    isActive: input.isActive ?? true,
  });
  try {
    await register.save();
  } catch (error) {
    if (isDuplicateName(error)) throw nameTaken(input.name);
    throw error;
  }

  logger.info(`Register created: ${register._id} store=${storeId} org=${organizationId} by user=${actorUserId}`);
  return toView(register);
}

/** Renames, deactivates or reactivates. From 4b, deactivating needs no open shift. */
export async function updateRegister(
  organizationId: string,
  storeId: string,
  registerId: string,
  input: UpdateRegisterInput,
  actorUserId: string
) {
  const register = await findRegisterOrThrow(organizationId, storeId, registerId);

  if (input.name !== undefined && registerNameKey(input.name) !== register.nameKey) {
    if (await nameExists(organizationId, storeId, input.name, register._id)) throw nameTaken(input.name);
  }
  if (input.name !== undefined) register.name = input.name;
  if (input.isActive !== undefined) register.isActive = input.isActive;

  try {
    await register.save();
  } catch (error) {
    if (isDuplicateName(error)) throw nameTaken(input.name ?? register.name);
    throw error;
  }

  logger.info(`Register updated: ${registerId} store=${storeId} org=${organizationId} by user=${actorUserId}`);
  return toView(register);
}

/**
 * Soft-deletes a register that has never had a shift; its name becomes reusable. Conditional on
 * `shiftCount` being 0 in the same write, which 4b's shift open increments.
 */
export async function deleteRegister(organizationId: string, storeId: string, registerId: string, actorUserId: string) {
  const register = await findRegisterOrThrow(organizationId, storeId, registerId);
  const deleted = await Register.updateOne(
    { _id: register._id, organizationId, storeId, shiftCount: { $not: { $gt: 0 } } },
    { $set: { isDelete: true } }
  );
  if (deleted.matchedCount === 0) {
    const current = await Register.findOne({ _id: register._id, organizationId, storeId });
    if (!current) throw notFound();
    throw inUse(current.shiftCount);
  }
  logger.info(`Register deleted: ${registerId} store=${storeId} org=${organizationId} by user=${actorUserId}`);
}

/** Creates a new store's "Register 1", inside the store-create transaction. */
export async function createDefaultRegister(
  organizationId: mongoose.Types.ObjectId,
  storeId: mongoose.Types.ObjectId,
  session: mongoose.ClientSession
) {
  await Register.create([{ organizationId, storeId, name: DEFAULT_REGISTER_NAME }], { session });
}
