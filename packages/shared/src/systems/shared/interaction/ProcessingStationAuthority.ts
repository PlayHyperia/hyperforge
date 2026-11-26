export type ProcessingStationType = "anvil" | "furnace";

/** Minimal world authority required by processing admission checks. */
export interface PreparationActionAuthorityWorld {
  entities: { get(id: string): unknown };
  getPlayer(id: string): unknown;
  getSystem(name: string): unknown;
}

interface PositionLike {
  x: number;
  y: number;
  z: number;
}

interface PlayerLike {
  position?: unknown;
  node?: { position?: unknown };
  getPosition?: () => unknown;
  data?: { inStreamingDuel?: unknown };
}

interface StationLike {
  entityType?: unknown;
  canInteract?: (playerId: string, position: PositionLike) => boolean;
}

export interface PreparationActionFence {
  readonly playerId: string;
  isReleased(): boolean;
  release(): void;
}

const preparationActionFences = new WeakMap<
  PreparationActionAuthorityWorld,
  Map<string, Set<symbol>>
>();

function isPlayerPreparationActionFenced(
  world: PreparationActionAuthorityWorld,
  playerId: string,
): boolean {
  return (preparationActionFences.get(world)?.get(playerId)?.size ?? 0) > 0;
}

/**
 * Block new processing admissions for one player while already-admitted
 * durable work is settled or cancelled. Each caller owns an independent token
 * so one release cannot reopen another authority's fence.
 */
export function acquirePreparationActionFence(
  world: PreparationActionAuthorityWorld,
  playerId: string,
): PreparationActionFence {
  if (typeof playerId !== "string" || !playerId) {
    throw new Error("Preparation action fence requires a player ID");
  }
  let players = preparationActionFences.get(world);
  if (!players) {
    players = new Map();
    preparationActionFences.set(world, players);
  }
  let tokens = players.get(playerId);
  if (!tokens) {
    tokens = new Set();
    players.set(playerId, tokens);
  }
  const token = Symbol(playerId);
  tokens.add(token);
  let released = false;
  return {
    playerId,
    isReleased: () => released,
    release: () => {
      if (released) return;
      released = true;
      const currentPlayers = preparationActionFences.get(world);
      const currentTokens = currentPlayers?.get(playerId);
      currentTokens?.delete(token);
      if (currentTokens?.size === 0) currentPlayers?.delete(playerId);
      if (currentPlayers?.size === 0) preparationActionFences.delete(world);
    },
  };
}

function getFinitePosition(entity: unknown): PositionLike | null {
  if (!entity || typeof entity !== "object") return null;
  const candidate = entity as PlayerLike;
  let raw = candidate.position ?? candidate.node?.position;
  if (!raw && typeof candidate.getPosition === "function") {
    try {
      raw = candidate.getPosition();
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const position = raw as Partial<PositionLike>;
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    return null;
  }
  return {
    x: position.x as number,
    y: position.y as number,
    z: position.z as number,
  };
}

/** Fail-closed preparation-action eligibility shared by processing systems. */
export function canPlayerPerformPreparationAction(
  world: PreparationActionAuthorityWorld,
  playerId: string,
): boolean {
  if (typeof playerId !== "string" || !playerId) return false;
  if (isPlayerPreparationActionFenced(world, playerId)) return false;
  const player = world.getPlayer(playerId) ?? world.entities.get(playerId);
  if (!player || !getFinitePosition(player)) return false;
  if ((player as PlayerLike).data?.inStreamingDuel === true) return false;

  const duel = world.getSystem("duel") as
    { isPlayerInDuel?: (id: string) => boolean } | undefined;
  try {
    return duel?.isPlayerInDuel?.(playerId) !== true;
  } catch {
    return false;
  }
}

/**
 * Resolve one exact, server-owned workstation and apply its own footprint-aware
 * interaction range. Client-supplied positions and display names are ignored.
 */
export function canPlayerUseProcessingStation(
  world: PreparationActionAuthorityWorld,
  playerId: string,
  stationId: string,
  expectedType: ProcessingStationType,
): boolean {
  if (
    typeof stationId !== "string" ||
    !stationId ||
    !canPlayerPerformPreparationAction(world, playerId)
  ) {
    return false;
  }

  const player = world.getPlayer(playerId) ?? world.entities.get(playerId);
  const station = world.entities.get(stationId) as unknown as
    StationLike | undefined;
  const position = getFinitePosition(player);
  if (
    !station ||
    station.entityType !== expectedType ||
    typeof station.canInteract !== "function" ||
    !position
  ) {
    return false;
  }

  try {
    return station.canInteract(playerId, position) === true;
  } catch {
    return false;
  }
}
