import { validateUUID } from "./CombatValidation";

const GROUND_ITEM_PICKUP_OPERATION_PREFIX = "ground-item-pickup:";

/**
 * Derive one immutable pickup receipt from an autonomous progression attempt.
 * The caller-owned target never supplies or influences the operation identity.
 */
export function getGroundItemPickupOperationIdForAttempt(
  attemptId: unknown,
): string | null {
  return validateUUID(attemptId)
    ? `${GROUND_ITEM_PICKUP_OPERATION_PREFIX}${attemptId}`
    : null;
}
