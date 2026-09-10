import type { GroundItemDropCommitRequest } from "../../types/network/database";

type FingerprintInput = Omit<GroundItemDropCommitRequest, "requestFingerprint">;

/** Canonical byte payload hashed by both inventory and database authorities. */
export function serializeGroundItemDropCommitFingerprint(
  input: FingerprintInput,
): string {
  return JSON.stringify({
    version: 1,
    operationId: input.operationId,
    playerId: input.playerId,
    itemId: input.itemId,
    quantity: input.quantity,
    slotIndex: input.slotIndex,
    source: {
      contributionId: input.source.contributionId,
      preferredSourceId: input.source.preferredSourceId,
      requestFingerprint: input.source.requestFingerprint,
      itemId: input.source.itemId,
      quantity: input.source.quantity,
      stackable: input.source.stackable,
      position: {
        x: input.source.position.x,
        y: input.source.position.y,
        z: input.source.position.z,
      },
      tile: { x: input.source.tile.x, z: input.source.tile.z },
      droppedBy: input.source.droppedBy,
      lifetimeMs: input.source.lifetimeMs,
      lootProtectionMs: input.source.lootProtectionMs,
      allowMerge: input.source.allowMerge,
    },
  });
}
