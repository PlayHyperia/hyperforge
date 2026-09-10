import { eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { BoneBurialReceipt } from "@hyperforge/shared";

import type { Database } from "../database/client.js";
import { boneBurialOperations } from "../database/schema.js";
import type { AgentAutonomyActionResult } from "./agentAutonomyCheckpoint.js";
import type { AgentAutonomyProgressionAttempt } from "./agentAutonomyProgression.js";
import type { AgentInstance } from "./managers/AgentBehaviorTicker.js";

const ORDINARY_BONE_OPERATION_NAMESPACE =
  "8446a6ab-51cc-4c31-9edc-5cece92503b3";
const INITIAL_RECONCILIATION_DELAY_MS = 25;
const MAX_RECONCILIATION_DELAY_MS = 1_000;

export interface OrdinaryBoneBurialExecutionResult {
  settled: boolean;
  applied: boolean;
  receipt: BoneBurialReceipt | null;
  operationId: string;
  reconciliationAttempts: number;
}

export function getOrdinaryBoneBurialOperationId(attemptId: string): string {
  return uuidv5(
    `ordinary-bone-burial:v1:${attemptId}`,
    ORDINARY_BONE_OPERATION_NAMESPACE,
  );
}

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * Hold one logical burial open until the immutable receipt and every live view
 * agree. A lost COMMIT response or failed post-commit reload always reuses the
 * same attempt-derived operation ID; shutdown leaves recovery to startup.
 */
export async function executeOrdinaryBoneBurial(
  instance: AgentInstance,
  itemId: string,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<OrdinaryBoneBurialExecutionResult> {
  const operationId = getOrdinaryBoneBurialOperationId(attempt.attemptId);
  let reconciliationAttempts = 0;
  let delayMs = INITIAL_RECONCILIATION_DELAY_MS;
  let lastReceipt: BoneBurialReceipt | null = null;

  while (instance.state === "running") {
    try {
      lastReceipt = await instance.service.executeBury(itemId, operationId);
    } catch {
      lastReceipt = null;
    }
    reconciliationAttempts += 1;

    if (lastReceipt?.ok && lastReceipt.liveStateApplied) {
      return {
        settled: true,
        applied: true,
        receipt: lastReceipt,
        operationId,
        reconciliationAttempts,
      };
    }
    if (lastReceipt && !lastReceipt.retryable) {
      return {
        settled: true,
        applied: false,
        receipt: lastReceipt,
        operationId,
        reconciliationAttempts,
      };
    }

    await wait(delayMs);
    delayMs = Math.min(delayMs * 2, MAX_RECONCILIATION_DELAY_MS);
  }

  return {
    settled: false,
    applied: false,
    receipt: lastReceipt,
    operationId,
    reconciliationAttempts,
  };
}

/** Resolve a process-killed burial from its exact immutable receipt. */
export async function resolveOrdinaryBoneBurialRecovery(
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
): Promise<AgentAutonomyActionResult | null> {
  if (attempt.actionType !== "bury") return null;
  const operationId = getOrdinaryBoneBurialOperationId(attempt.attemptId);
  const rows = await db
    .select({ playerId: boneBurialOperations.playerId })
    .from(boneBurialOperations)
    .where(eq(boneBurialOperations.operationId, operationId))
    .limit(1);
  const receipt = rows[0];
  if (!receipt) return null;
  if (receipt.playerId !== attempt.characterId) {
    throw new Error("ordinary_bone_recovery_receipt_identity_mismatch");
  }
  return {
    attemptedActionType: "bury",
    appliedActionType: "bury",
    outcome: "completed",
  };
}
