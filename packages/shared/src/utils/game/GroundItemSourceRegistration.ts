import type { GroundItemSourceRegistrationRequest } from "../../types/network/database";

type FingerprintInput = Omit<
  GroundItemSourceRegistrationRequest,
  "requestFingerprint"
>;

/** Canonical byte payload hashed by both world and database authorities. */
export function serializeGroundItemSourceRegistrationFingerprint(
  input: FingerprintInput,
): string {
  return JSON.stringify({
    version: 1,
    contributionId: input.contributionId,
    preferredSourceId: input.preferredSourceId,
    itemId: input.itemId,
    quantity: input.quantity,
    stackable: input.stackable,
    position: {
      x: input.position.x,
      y: input.position.y,
      z: input.position.z,
    },
    tile: { x: input.tile.x, z: input.tile.z },
    droppedBy: input.droppedBy,
    lifetimeMs: input.lifetimeMs,
    lootProtectionMs: input.lootProtectionMs,
    allowMerge: input.allowMerge,
  });
}
