import { eq } from "drizzle-orm";
import {
  getProcessingRequestOperationId,
  normalizeProcessingRequestEnvelope,
  normalizeProcessingRequestId,
  type ProcessingSkill,
} from "@hyperforge/shared";

import type { Database } from "../database/client.js";
import { operationsLog } from "../database/schema.js";
import type { AgentAutonomyActionResult } from "./agentAutonomyCheckpoint.js";
import type { AgentAutonomyProgressionAttempt } from "./agentAutonomyProgression.js";

export type OrdinaryProcessingActionType =
  | "firemake"
  | "cook"
  | "smelt"
  | "smith"
  | "craft"
  | "fletch"
  | "runecraft"
  | "tan";

type ProcessingCustodySkill =
  | "firemaking"
  | "cooking"
  | "smithing"
  | "crafting"
  | "fletching"
  | "runecrafting";

type ProcessingActionIdentity = {
  requestSkill: ProcessingSkill;
  custodySkill: ProcessingCustodySkill;
};

const PROCESSING_ACTION_IDENTITIES: Readonly<
  Record<OrdinaryProcessingActionType, ProcessingActionIdentity>
> = Object.freeze({
  firemake: { requestSkill: "firemaking", custodySkill: "firemaking" },
  cook: { requestSkill: "cooking", custodySkill: "cooking" },
  smelt: { requestSkill: "smelting", custodySkill: "smithing" },
  smith: { requestSkill: "smithing", custodySkill: "smithing" },
  craft: { requestSkill: "crafting", custodySkill: "crafting" },
  fletch: { requestSkill: "fletching", custodySkill: "fletching" },
  runecraft: {
    requestSkill: "runecrafting",
    custodySkill: "runecrafting",
  },
  tan: { requestSkill: "tanning", custodySkill: "crafting" },
});

const PROCESSING_ACTION_TYPES = new Set<OrdinaryProcessingActionType>(
  Object.keys(PROCESSING_ACTION_IDENTITIES) as OrdinaryProcessingActionType[],
);

function isOrdinaryProcessingActionType(
  value: AgentAutonomyProgressionAttempt["actionType"],
): value is OrdinaryProcessingActionType {
  return PROCESSING_ACTION_TYPES.has(value as OrdinaryProcessingActionType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeNonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isItemQuantity(
  value: unknown,
): value is Record<string, unknown> & { itemId: string; quantity: number } {
  if (!isRecord(value)) return false;
  return (
    typeof value.itemId === "string" &&
    value.itemId.length > 0 &&
    value.itemId.length <= 256 &&
    Number.isSafeInteger(value.quantity) &&
    Number(value.quantity) > 0
  );
}

function isOutput(value: unknown): boolean {
  return isItemQuantity(value) && typeof value.stackable === "boolean";
}

function isConsumable(
  value: unknown,
): value is Record<string, unknown> & { itemId: string; usesPerItem: number } {
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    value.itemId.length > 0 &&
    value.itemId.length <= 256 &&
    Number.isSafeInteger(value.usesPerItem) &&
    Number(value.usesPerItem) > 0
  );
}

function isConsumableState(value: unknown): boolean {
  if (!isConsumable(value)) return false;
  const usesPerItem = Number(value.usesPerItem);
  const remainingUses = Number(value.remainingUses);
  const consumedQuantity = Number(value.consumedQuantity);
  return (
    Number.isSafeInteger(remainingUses) &&
    remainingUses >= 0 &&
    remainingUses < usesPerItem &&
    (consumedQuantity === 0 || consumedQuantity === 1) &&
    ((consumedQuantity === 1 && remainingUses === 0) ||
      (consumedQuantity === 0 && remainingUses > 0))
  );
}

function isPosition(value: unknown): boolean {
  return (
    isRecord(value) &&
    [value.x, value.y, value.z].every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  );
}

function isTile(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.x) &&
    Number.isSafeInteger(value.z)
  );
}

function isCommittedFireEffect(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.kind === "fire" &&
    typeof value.fireId === "string" &&
    value.fireId.length > 0 &&
    value.fireId.length <= 256 &&
    isPosition(value.position) &&
    isTile(value.tile) &&
    isSafeNonnegative(value.createdAt) &&
    isSafeNonnegative(value.expiresAt) &&
    Number(value.expiresAt) > Number(value.createdAt)
  );
}

function hasValidCommittedProcessingState(
  value: unknown,
  expectedSkill: ProcessingCustodySkill,
): boolean {
  if (!isRecord(value)) return false;
  const inputs = value.inputs;
  const requiredItems = value.requiredItems;
  const consumables = value.consumables;
  const consumableStates = value.consumableStates;
  const outputs = value.outputs;
  if (
    value.version !== 1 ||
    typeof value.requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.requestFingerprint) ||
    value.skill !== expectedSkill ||
    !isFiniteNonnegative(value.xpAmount) ||
    !Array.isArray(inputs) ||
    inputs.length === 0 ||
    inputs.length > 28 ||
    !inputs.every(isItemQuantity) ||
    !Array.isArray(requiredItems) ||
    requiredItems.length > 28 ||
    !requiredItems.every(isItemQuantity) ||
    !Array.isArray(consumables) ||
    consumables.length > 28 ||
    !consumables.every(isConsumable) ||
    !Array.isArray(consumableStates) ||
    consumableStates.length !== consumables.length ||
    !consumableStates.every(isConsumableState) ||
    !Array.isArray(outputs) ||
    outputs.length > 28 ||
    !outputs.every(isOutput) ||
    !isFiniteNonnegative(value.awardedXp) ||
    Number(value.awardedXp) > Number(value.xpAmount) ||
    !isFiniteNonnegative(value.operationCommittedXp) ||
    (value.coinCost !== undefined && !isSafeNonnegative(value.coinCost)) ||
    (value.worldEffect !== undefined &&
      !isCommittedFireEffect(value.worldEffect))
  ) {
    return false;
  }
  const consumableIds = consumables.map((entry) => entry.itemId);
  const consumableStateIds = consumableStates.map((entry) => entry.itemId);
  return (
    new Set(consumableIds).size === consumableIds.length &&
    new Set(consumableStateIds).size === consumableStateIds.length &&
    consumableIds.every((itemId) => consumableStateIds.includes(itemId))
  );
}

function hasValidRejectedProcessingState(
  value: unknown,
  requestId: string,
  expectedSkill: ProcessingSkill,
): boolean {
  if (!isRecord(value)) return false;
  const envelope = normalizeProcessingRequestEnvelope(
    expectedSkill,
    value.envelope,
  );
  return (
    value.version === 1 &&
    normalizeProcessingRequestId(value.requestId) === requestId &&
    value.skill === expectedSkill &&
    typeof value.ownerId === "string" &&
    value.ownerId.length > 0 &&
    isSafeNonnegative(value.acceptedAt) &&
    isSafeNonnegative(value.heartbeatAt) &&
    Number(value.heartbeatAt) >= Number(value.acceptedAt) &&
    envelope !== null &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 64 &&
    typeof value.retryable === "boolean" &&
    isSafeNonnegative(value.rejectedAt) &&
    Number(value.rejectedAt) >= Number(value.heartbeatAt)
  );
}

export function getOrdinaryProcessingOperationId(
  actionType: OrdinaryProcessingActionType,
  attemptId: string,
): string {
  const operationId = getProcessingRequestOperationId(
    PROCESSING_ACTION_IDENTITIES[actionType].requestSkill,
    attemptId,
  );
  if (!operationId) {
    throw new Error("ordinary_processing_attempt_id_invalid");
  }
  return operationId;
}

/** Resolve a process-killed processing action from its exact terminal receipt. */
export async function resolveOrdinaryProcessingRecovery(
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<AgentAutonomyActionResult | null> {
  if (!isOrdinaryProcessingActionType(attempt.actionType)) return null;
  const identity = PROCESSING_ACTION_IDENTITIES[attempt.actionType];
  const requestId = normalizeProcessingRequestId(attempt.attemptId);
  if (!requestId) throw new Error("ordinary_processing_attempt_id_invalid");
  const operationId = getOrdinaryProcessingOperationId(
    attempt.actionType,
    requestId,
  );
  const rows = await db
    .select({
      playerId: operationsLog.playerId,
      operationType: operationsLog.operationType,
      operationState: operationsLog.operationState,
      completed: operationsLog.completed,
    })
    .from(operationsLog)
    .where(eq(operationsLog.id, operationId))
    .limit(1);
  const receipt = rows[0];
  if (!receipt || receipt.completed !== true) return null;
  if (
    receipt.playerId !== attempt.characterId ||
    (receipt.operationType !== "processing_action" &&
      receipt.operationType !== "processing_request_rejected")
  ) {
    throw new Error("ordinary_processing_recovery_receipt_identity_mismatch");
  }
  if (receipt.operationType === "processing_action") {
    if (
      !hasValidCommittedProcessingState(
        receipt.operationState,
        identity.custodySkill,
      )
    ) {
      throw new Error("ordinary_processing_recovery_receipt_invalid");
    }
    return {
      attemptedActionType: attempt.actionType,
      appliedActionType: attempt.actionType,
      outcome: "completed",
    };
  }
  if (
    !hasValidRejectedProcessingState(
      receipt.operationState,
      requestId,
      identity.requestSkill,
    )
  ) {
    throw new Error("ordinary_processing_recovery_receipt_invalid");
  }
  return {
    attemptedActionType: attempt.actionType,
    appliedActionType: null,
    outcome: "rejected",
  };
}
