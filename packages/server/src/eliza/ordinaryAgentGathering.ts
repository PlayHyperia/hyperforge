import { eq } from "drizzle-orm";
import { getGatheringRewardOperationIdForAttempt } from "@hyperforge/shared";

import type { Database } from "../database/client.js";
import { operationsLog } from "../database/schema.js";
import type { AgentAutonomyActionResult } from "./agentAutonomyCheckpoint.js";
import type { AgentAutonomyProgressionAttempt } from "./agentAutonomyProgression.js";

type StoredGatheringRewardOperation = {
  version: 2;
  requestFingerprint: string;
  resourceId: string;
  depleteAfterCommit: boolean;
  respawnTicks: number;
  depletedUntil: number | null;
  skill: "woodcutting" | "mining" | "fishing";
  xpAmount: number;
  reward: { itemId: string; quantity: number; stackable: boolean };
  secondaryItemId: string | null;
  awardedXp: number;
  operationCommittedXp: number;
};

const GATHERING_SKILLS = new Set(["woodcutting", "mining", "fishing"]);

function isSafeNonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStoredGatheringRewardOperation(
  value: unknown,
): value is StoredGatheringRewardOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const reward = state.reward;
  if (!reward || typeof reward !== "object" || Array.isArray(reward)) {
    return false;
  }
  const rewardState = reward as Record<string, unknown>;
  const depletionIsValid =
    state.depletedUntil === null || isSafeNonnegative(state.depletedUntil);
  return (
    state.version === 2 &&
    typeof state.requestFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(state.requestFingerprint) &&
    typeof state.resourceId === "string" &&
    state.resourceId.length > 0 &&
    state.resourceId.length <= 256 &&
    typeof state.depleteAfterCommit === "boolean" &&
    isSafeNonnegative(state.respawnTicks) &&
    depletionIsValid &&
    typeof state.skill === "string" &&
    GATHERING_SKILLS.has(state.skill) &&
    typeof state.xpAmount === "number" &&
    Number.isFinite(state.xpAmount) &&
    state.xpAmount > 0 &&
    typeof rewardState.itemId === "string" &&
    rewardState.itemId.length > 0 &&
    isSafeNonnegative(rewardState.quantity) &&
    rewardState.quantity > 0 &&
    typeof rewardState.stackable === "boolean" &&
    (state.secondaryItemId === null ||
      (typeof state.secondaryItemId === "string" &&
        state.secondaryItemId.length > 0)) &&
    isSafeNonnegative(state.awardedXp) &&
    isSafeNonnegative(state.operationCommittedXp)
  );
}

export function getOrdinaryGatheringRewardOperationId(
  attemptId: string,
): string {
  const operationId = getGatheringRewardOperationIdForAttempt(attemptId);
  if (!operationId) {
    throw new Error("ordinary_gathering_attempt_id_invalid");
  }
  return operationId;
}

/** Resolve a process-killed gather only from its exact committed first reward. */
export async function resolveOrdinaryGatheringRecovery(
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<AgentAutonomyActionResult | null> {
  if (attempt.actionType !== "gather") return null;
  const operationId = getOrdinaryGatheringRewardOperationId(attempt.attemptId);
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
    receipt.operationType !== "gathering_reward"
  ) {
    throw new Error("ordinary_gathering_recovery_receipt_identity_mismatch");
  }
  if (!isStoredGatheringRewardOperation(receipt.operationState)) {
    throw new Error("ordinary_gathering_recovery_receipt_invalid");
  }
  return {
    attemptedActionType: "gather",
    appliedActionType: "gather",
    outcome: "completed",
  };
}
