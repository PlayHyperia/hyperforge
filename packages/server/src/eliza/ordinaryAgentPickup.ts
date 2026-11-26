import { eq } from "drizzle-orm";
import { getGroundItemPickupOperationIdForAttempt } from "@hyperforge/shared";

import type { Database } from "../database/client.js";
import { operationsLog } from "../database/schema.js";
import type { AgentAutonomyActionResult } from "./agentAutonomyCheckpoint.js";
import type { AgentAutonomyProgressionAttempt } from "./agentAutonomyProgression.js";

type StoredGroundItemPickupOperation = {
  version: 1;
  requestFingerprint: string;
  sourceEntityId: string;
  itemId: string;
  quantity: number;
  stackable: boolean;
  operationCommittedCoins: number | null;
};

function isStoredGroundItemPickupOperation(
  value: unknown,
): value is StoredGroundItemPickupOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    typeof state.requestFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(state.requestFingerprint) &&
    typeof state.sourceEntityId === "string" &&
    state.sourceEntityId.length > 0 &&
    state.sourceEntityId.length <= 256 &&
    typeof state.itemId === "string" &&
    state.itemId.length > 0 &&
    state.itemId.length <= 256 &&
    Number.isSafeInteger(state.quantity) &&
    Number(state.quantity) > 0 &&
    typeof state.stackable === "boolean" &&
    (state.operationCommittedCoins === null ||
      (Number.isSafeInteger(state.operationCommittedCoins) &&
        Number(state.operationCommittedCoins) >= 0))
  );
}

export function getOrdinaryPickupOperationId(attemptId: string): string {
  const operationId = getGroundItemPickupOperationIdForAttempt(attemptId);
  if (!operationId) throw new Error("ordinary_pickup_attempt_id_invalid");
  return operationId;
}

/** Resolve process-killed pickup only from its exact completed custody receipt. */
export async function resolveOrdinaryPickupRecovery(
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<AgentAutonomyActionResult | null> {
  if (attempt.actionType !== "pickup") return null;
  const operationId = getOrdinaryPickupOperationId(attempt.attemptId);
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
    receipt.operationType !== "ground_item_pickup"
  ) {
    throw new Error("ordinary_pickup_recovery_receipt_identity_mismatch");
  }
  if (!isStoredGroundItemPickupOperation(receipt.operationState)) {
    throw new Error("ordinary_pickup_recovery_receipt_invalid");
  }
  return {
    attemptedActionType: "pickup",
    appliedActionType: "pickup",
    outcome: "completed",
  };
}
