import type { GroundItemMobLootCommitRequest } from "../../types/network/database";

export type GroundItemMobLootIdentity = Omit<
  GroundItemMobLootCommitRequest,
  "requestFingerprint" | "sources"
>;

/**
 * Canonical death-occurrence identity hashed by loot and database authorities.
 * The first committed source roll is stored separately and wins every replay.
 */
export function serializeGroundItemMobLootCommitFingerprint(
  input: GroundItemMobLootIdentity,
): string {
  return JSON.stringify({
    version: 2,
    operationId: input.operationId,
    killedBy: input.killedBy,
    mobId: input.mobId,
    mobType: input.mobType,
    deathTimestamp: input.deathTimestamp,
    position: {
      x: input.position.x,
      y: input.position.y,
      z: input.position.z,
    },
    killToken: input.killToken,
    attackStyle: input.attackStyle,
    damageDealt: input.damageDealt,
  });
}
