import {
  validateWorldTerrainProfile,
  type WorldTerrainProfile,
} from "../systems/shared/world/WorldTerrainProfile";

export type WorldSpawnPositionResolution = {
  position: [number, number, number];
  rehomed: boolean;
  reason: "invalid-position" | "outside-world-bounds" | null;
};

/**
 * Admit persisted or configured spawn coordinates to the active world envelope.
 * This does not translate coordinates, alter saved progress, or prove that a
 * position is walkable. Existing authoritative terrain grounding runs afterward.
 */
export function resolveWorldSpawnPosition(
  candidate: unknown,
  lobbySpawn: readonly [number, number, number],
  profile: WorldTerrainProfile,
): WorldSpawnPositionResolution {
  const { bounds } = validateWorldTerrainProfile(profile);
  const finitePosition = (value: unknown): value is [number, number, number] =>
    Array.isArray(value) &&
    value.length === 3 &&
    [value[0], value[1], value[2]].every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    );
  const contained = (position: readonly [number, number, number]): boolean =>
    position[0] >= bounds.minX &&
    position[0] <= bounds.maxX &&
    position[2] >= bounds.minZ &&
    position[2] <= bounds.maxZ;

  // A broken fallback is a configuration failure, never an origin/clamp escape.
  if (!finitePosition(lobbySpawn) || !contained(lobbySpawn)) {
    throw new Error(
      "World lobby spawn must be finite and inside the active terrain bounds",
    );
  }

  const reason = !finitePosition(candidate)
    ? "invalid-position"
    : !contained(candidate)
      ? "outside-world-bounds"
      : null;
  const admitted =
    reason === null ? (candidate as [number, number, number]) : lobbySpawn;
  return {
    position: [admitted[0], admitted[1], admitted[2]],
    rehomed: reason !== null,
    reason,
  };
}
