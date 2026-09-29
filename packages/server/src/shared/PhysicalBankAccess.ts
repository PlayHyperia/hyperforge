import {
  INTERACTION_DISTANCE,
  NPCEntity,
  SessionType,
  getNPCById,
  type World,
} from "@hyperforge/shared";

export type PhysicalBankAccessFailure =
  | "player_unavailable"
  | "duel_locked"
  | "bank_target_invalid"
  | "bank_out_of_range";

type Position = { x: number; y: number; z: number };

function getPosition(entity: unknown): Position | null {
  const source = entity as {
    position?: { x?: number; y?: number; z?: number } | number[];
    data?: {
      position?: { x?: number; y?: number; z?: number } | number[];
    };
  } | null;
  const value = source?.position ?? source?.data?.position;
  if (Array.isArray(value)) {
    const [x, y, z] = value.map(Number);
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  }
  if (value && typeof value === "object") {
    const x = Number(value.x);
    const y = Number(value.y ?? 0);
    const z = Number(value.z);
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  }
  return null;
}

/**
 * Validate one ordinary physical bank interaction against exact server-owned
 * identity, duel state, and the shared two-tile Chebyshev boundary.
 */
export function validatePhysicalBankAccess(
  world: World,
  playerId: string,
  bankId: string,
): PhysicalBankAccessFailure | null {
  const player = world.entities.get(playerId);
  if (!player) return "player_unavailable";
  if (
    (player.data as { inStreamingDuel?: boolean } | undefined)
      ?.inStreamingDuel === true
  ) {
    return "duel_locked";
  }
  const duelSystem = world.getSystem("duel") as
    { isPlayerInDuel?: (id: string) => boolean } | undefined;
  try {
    if (duelSystem?.isPlayerInDuel?.(playerId) === true) return "duel_locked";
  } catch {
    return "duel_locked";
  }

  const bank = world.entities.get(bankId);
  const bankData = bank?.data as
    { type?: unknown; entityType?: unknown } | undefined;
  const runtimeEntityType = (bank as { entityType?: unknown } | undefined)
    ?.entityType;
  if (!bank || bank.destroyed) return "bank_target_invalid";

  // An NPC's client-facing label/services are not authority. Require the exact
  // live server-owned entity, its role, and the loaded manifest's bank service.
  // Keep this separate from the existing chest branch so an NPC cannot enter
  // that branch by changing its serialized entityType.
  if (bank instanceof NPCEntity) {
    const manager = world.getSystem("entity-manager") as
      { getEntity(id: string): unknown } | undefined;
    const manifest = getNPCById(bank.config.npcId);
    if (
      !world.isServer ||
      bank.world !== world ||
      bank.id !== bankId ||
      manager?.getEntity(bankId) !== bank ||
      bank.config.npcType !== "bank" ||
      !bank.config.services?.includes("bank") ||
      manifest?.services?.enabled !== true ||
      !manifest.services.types.includes("bank")
    ) {
      return "bank_target_invalid";
    }
  } else if (
    bankData?.type !== "bank" &&
    bankData?.entityType !== "bank" &&
    runtimeEntityType !== "bank"
  ) {
    return "bank_target_invalid";
  }

  const playerPosition = getPosition(player);
  const bankPosition = getPosition(bank);
  if (!playerPosition || !bankPosition) return "bank_target_invalid";
  const distance = Math.max(
    Math.abs(playerPosition.x - bankPosition.x),
    Math.abs(playerPosition.z - bankPosition.z),
  );
  return distance <= INTERACTION_DISTANCE[SessionType.BANK]
    ? null
    : "bank_out_of_range";
}
