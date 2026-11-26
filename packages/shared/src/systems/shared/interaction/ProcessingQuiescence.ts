import type { PreparationActionAuthorityWorld } from "./ProcessingStationAuthority";

export const PROCESSING_QUIESCENCE_SYSTEM_NAMES = [
  "processing",
  "smelting",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
  "tanning",
] as const;

export type ProcessingQuiescenceSystemName =
  (typeof PROCESSING_QUIESCENCE_SYSTEM_NAMES)[number];

export interface PlayerProcessingQuiescenceSystem {
  requestPlayerProcessingQuiescence(playerId: string): void;
  isPlayerProcessingQuiescent(playerId: string): boolean;
}

export type ProcessingQuiescenceRequestResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_player_id"
        | "invalid_system_contract"
        | "quiescence_request_failed";
      systemName?: ProcessingQuiescenceSystemName;
    };

function getQuiescenceSystem(
  world: PreparationActionAuthorityWorld,
  systemName: ProcessingQuiescenceSystemName,
): PlayerProcessingQuiescenceSystem | null | undefined {
  const candidate = world.getSystem(systemName) as
    Partial<PlayerProcessingQuiescenceSystem> | null | undefined;
  if (!candidate) return null;
  if (
    typeof candidate.requestPlayerProcessingQuiescence !== "function" ||
    typeof candidate.isPlayerProcessingQuiescent !== "function"
  ) {
    return undefined;
  }
  return candidate as PlayerProcessingQuiescenceSystem;
}

/**
 * Cancel pre-commit work and mark admitted durable actions stop-after-settle.
 * Missing systems are inactive by construction; a present system with a stale
 * contract fails closed.
 */
export function requestPlayerProcessingQuiescence(
  world: PreparationActionAuthorityWorld,
  playerId: string,
): ProcessingQuiescenceRequestResult {
  if (typeof playerId !== "string" || !playerId) {
    return { ok: false, reason: "invalid_player_id" };
  }
  for (const systemName of PROCESSING_QUIESCENCE_SYSTEM_NAMES) {
    const system = getQuiescenceSystem(world, systemName);
    if (system === undefined) {
      return { ok: false, reason: "invalid_system_contract", systemName };
    }
    if (!system) continue;
    try {
      system.requestPlayerProcessingQuiescence(playerId);
    } catch {
      return { ok: false, reason: "quiescence_request_failed", systemName };
    }
  }
  return { ok: true };
}

/** Return true only when every loaded processing system proves this player idle. */
export function isPlayerProcessingQuiescent(
  world: PreparationActionAuthorityWorld,
  playerId: string,
): boolean {
  if (typeof playerId !== "string" || !playerId) return false;
  for (const systemName of PROCESSING_QUIESCENCE_SYSTEM_NAMES) {
    const system = getQuiescenceSystem(world, systemName);
    if (system === undefined) return false;
    if (!system) continue;
    try {
      if (system.isPlayerProcessingQuiescent(playerId) !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}
