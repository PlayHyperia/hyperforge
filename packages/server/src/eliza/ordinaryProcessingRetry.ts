import type { EmbeddedBehaviorAction } from "./managers/AgentBehaviorTicker.js";

export type OrdinaryProcessingAction = Extract<
  EmbeddedBehaviorAction,
  {
    type:
      | "cook"
      | "smelt"
      | "smith"
      | "runecraft"
      | "craft"
      | "fletch"
      | "tan"
      | "firemake";
  }
>;

export type OrdinaryProcessingActionType = OrdinaryProcessingAction["type"];

export interface OrdinaryProcessingRetrySuppression {
  actionType: OrdinaryProcessingActionType;
  intentId: string;
  retryAfter: number;
}

export interface OrdinaryProcessingRetryState extends OrdinaryProcessingRetrySuppression {
  consecutiveFailures: number;
  lastRejectedAt: number;
}

export interface OrdinaryProcessingRetryHolder {
  ordinaryProcessingRetries?: OrdinaryProcessingRetryState[];
  ordinaryProcessingAcquisition?: { expiresAt: number } | null;
  bankStageRetryAfter?: number;
}

type ProcessingActionOutcome = {
  outcome:
    | "idle"
    | "rejected"
    | "dispatched"
    | "completed"
    | "failed"
    | "unknown_after_restart";
  appliedActionType: EmbeddedBehaviorAction["type"] | null;
};

/**
 * Technical anti-storm timing only. This does not define duel, betting,
 * economic, or player-facing timing. A rejected exact processing intent is
 * retried after 30 seconds, with repeated failures capped at five minutes.
 */
export const ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS = 30_000;
export const ORDINARY_PROCESSING_RETRY_MAX_DELAY_MS = 300_000;

const ORDINARY_PROCESSING_RETRY_RESET_AFTER_MS =
  ORDINARY_PROCESSING_RETRY_MAX_DELAY_MS * 2;
const MAX_ORDINARY_PROCESSING_RETRY_STATES = 128;

export function getOrdinaryProcessingIntent(
  action: EmbeddedBehaviorAction,
): Pick<OrdinaryProcessingRetrySuppression, "actionType" | "intentId"> | null {
  switch (action.type) {
    case "cook":
      return { actionType: action.type, intentId: action.itemId };
    case "smelt":
    case "smith":
      return { actionType: action.type, intentId: action.recipe };
    case "runecraft":
      return { actionType: action.type, intentId: action.runeType };
    case "craft":
    case "fletch":
      return { actionType: action.type, intentId: action.recipeId };
    case "tan":
      return { actionType: action.type, intentId: action.inputItemId };
    case "firemake":
      return { actionType: action.type, intentId: action.logsItemId };
    default:
      return null;
  }
}

function sameIntent(
  left: Pick<OrdinaryProcessingRetrySuppression, "actionType" | "intentId">,
  right: Pick<OrdinaryProcessingRetrySuppression, "actionType" | "intentId">,
): boolean {
  return (
    left.actionType === right.actionType && left.intentId === right.intentId
  );
}

export function isOrdinaryProcessingActionSuppressed(
  suppressions: readonly OrdinaryProcessingRetrySuppression[] | undefined,
  action: EmbeddedBehaviorAction,
  now = Date.now(),
): boolean {
  const intent = getOrdinaryProcessingIntent(action);
  if (!intent) return false;
  return (
    suppressions?.some(
      (suppression) =>
        suppression.retryAfter > now && sameIntent(suppression, intent),
    ) ?? false
  );
}

/**
 * Return only active structured-clone-safe suppressions for the worker. Quiet
 * entries are retained briefly on the main thread so repeated failures can
 * continue their bounded exponential backoff, then forgotten automatically.
 */
export function snapshotOrdinaryProcessingRetrySuppressions(
  holder: OrdinaryProcessingRetryHolder,
  now = Date.now(),
): OrdinaryProcessingRetrySuppression[] {
  const retained = (holder.ordinaryProcessingRetries ?? []).filter(
    (entry) =>
      now - entry.lastRejectedAt <= ORDINARY_PROCESSING_RETRY_RESET_AFTER_MS,
  );
  holder.ordinaryProcessingRetries = retained;
  return retained
    .filter((entry) => entry.retryAfter > now)
    .map(({ actionType, intentId, retryAfter }) => ({
      actionType,
      intentId,
      retryAfter,
    }));
}

/**
 * Apply terminal main-process truth for one exact processing intent. Success
 * clears that intent. A rejection or exception adds bounded exponential
 * backoff. Useful alternate work (for example, cook falling back to gathering)
 * neither creates nor extends a rejection suppression.
 */
export function recordOrdinaryProcessingActionOutcome(
  holder: OrdinaryProcessingRetryHolder,
  action: EmbeddedBehaviorAction,
  execution: ProcessingActionOutcome,
  now = Date.now(),
): OrdinaryProcessingRetryState | null {
  const intent = getOrdinaryProcessingIntent(action);
  if (!intent) return null;

  const states = holder.ordinaryProcessingRetries ?? [];
  const existingIndex = states.findIndex((entry) => sameIntent(entry, intent));

  if (
    execution.outcome === "completed" &&
    execution.appliedActionType === intent.actionType
  ) {
    if (existingIndex >= 0) states.splice(existingIndex, 1);
    holder.ordinaryProcessingRetries = states;
    if (holder.ordinaryProcessingAcquisition) {
      holder.ordinaryProcessingAcquisition = null;
      holder.bankStageRetryAfter = 0;
    }
    return null;
  }

  if (
    execution.appliedActionType !== null ||
    (execution.outcome !== "rejected" && execution.outcome !== "failed")
  ) {
    return existingIndex >= 0 ? states[existingIndex] : null;
  }

  const existing = existingIndex >= 0 ? states[existingIndex] : null;
  const withinFailureWindow =
    existing !== null &&
    now - existing.lastRejectedAt <= ORDINARY_PROCESSING_RETRY_RESET_AFTER_MS;
  const consecutiveFailures = withinFailureWindow
    ? existing.consecutiveFailures + 1
    : 1;
  const delay = Math.min(
    ORDINARY_PROCESSING_RETRY_BASE_DELAY_MS *
      2 ** Math.min(consecutiveFailures - 1, 30),
    ORDINARY_PROCESSING_RETRY_MAX_DELAY_MS,
  );
  const next: OrdinaryProcessingRetryState = {
    ...intent,
    consecutiveFailures,
    lastRejectedAt: now,
    retryAfter: now + delay,
  };

  if (existingIndex >= 0) {
    states[existingIndex] = next;
  } else {
    states.push(next);
  }
  if (states.length > MAX_ORDINARY_PROCESSING_RETRY_STATES) {
    states.sort(
      (left, right) =>
        right.lastRejectedAt - left.lastRejectedAt ||
        left.actionType.localeCompare(right.actionType) ||
        left.intentId.localeCompare(right.intentId),
    );
    states.length = MAX_ORDINARY_PROCESSING_RETRY_STATES;
  }
  holder.ordinaryProcessingRetries = states;
  return next;
}
