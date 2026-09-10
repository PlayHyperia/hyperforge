import type { GroundItemDeathCommitRequest } from "../../types/network/database";

type FingerprintInput = Omit<
  GroundItemDeathCommitRequest,
  "requestFingerprint"
>;

/** Canonical byte payload hashed by both death and database authorities. */
export function serializeGroundItemDeathCommitFingerprint(
  input: FingerprintInput,
): string {
  return JSON.stringify({
    version: 1,
    operationId: input.operationId,
    playerId: input.playerId,
    deathTimestamp: input.deathTimestamp,
    position: {
      x: input.position.x,
      y: input.position.y,
      z: input.position.z,
    },
    killedBy: input.killedBy,
    zoneType: input.zoneType,
    sources: input.sources.map((source) => ({
      contributionId: source.contributionId,
      preferredSourceId: source.preferredSourceId,
      requestFingerprint: source.requestFingerprint,
      itemId: source.itemId,
      quantity: source.quantity,
      stackable: source.stackable,
      position: {
        x: source.position.x,
        y: source.position.y,
        z: source.position.z,
      },
      tile: { x: source.tile.x, z: source.tile.z },
      droppedBy: source.droppedBy,
      lifetimeMs: source.lifetimeMs,
      lootProtectionMs: source.lootProtectionMs,
      allowMerge: source.allowMerge,
    })),
  });
}
