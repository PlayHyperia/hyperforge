const GROUND_ITEM_ENTITY_PREFIX = "ground_item_";

/**
 * Allocate one process-independent identity for a newly created ground source.
 * A secure UUID is required because pickup receipts outlive a world process;
 * reusing a counter after restart could make a new drop look already claimed.
 */
export function generateGroundItemSourceEntityId(): string {
  const sourceId = globalThis.crypto?.randomUUID?.();
  if (!sourceId) {
    throw new Error("ground_item_secure_identity_unavailable");
  }
  return `${GROUND_ITEM_ENTITY_PREFIX}${sourceId}`;
}

/** Idempotency key for one exact contribution to a ground source. */
export function generateGroundItemSourceContributionId(): string {
  const contributionId = globalThis.crypto?.randomUUID?.();
  if (!contributionId) {
    throw new Error("ground_item_secure_identity_unavailable");
  }
  return `ground-item-source:${contributionId}`;
}

/** Idempotency identity for one inventory/coin debit plus source creation. */
export function generateGroundItemDropOperationId(): string {
  const operationId = globalThis.crypto?.randomUUID?.();
  if (!operationId) {
    throw new Error("ground_item_secure_identity_unavailable");
  }
  return `ground-item-drop:${operationId}`;
}

/** Idempotency identity for one public death clear plus source batch. */
export function generateGroundItemDeathOperationId(): string {
  const operationId = globalThis.crypto?.randomUUID?.();
  if (!operationId) {
    throw new Error("ground_item_secure_identity_unavailable");
  }
  return `ground-item-death:${operationId}`;
}

/** Stable identity for one mob life, its loot roll, and every resulting source. */
export function generateGroundItemMobLootOperationId(): string {
  const operationId = globalThis.crypto?.randomUUID?.();
  if (!operationId) {
    throw new Error("ground_item_secure_identity_unavailable");
  }
  return `ground-item-mob-loot:${operationId}`;
}
