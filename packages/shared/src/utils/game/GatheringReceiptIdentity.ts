import { validateUUID } from "./CombatValidation";

const GATHERING_REWARD_OPERATION_PREFIX = "gathering-reward:";

/**
 * Derive the immutable first-reward receipt identity for one autonomous
 * gathering action. Invalid or untrusted attempt identities fail closed.
 */
export function getGatheringRewardOperationIdForAttempt(
  attemptId: unknown,
): string | null {
  return validateUUID(attemptId)
    ? `${GATHERING_REWARD_OPERATION_PREFIX}${attemptId}`
    : null;
}
