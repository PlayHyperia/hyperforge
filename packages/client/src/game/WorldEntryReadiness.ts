import type {
  ClientNetwork,
  PlayerLocal,
  TerrainSystem,
  World,
} from "@hyperforge/shared";

export type WorldEntryReadiness = {
  owner: object | null;
  connection: object | null;
  targetId: string | null;
  ownershipReady: boolean;
  ready: boolean;
  playerReady: boolean;
  physReady: boolean;
  terrainReady: boolean;
  blockedChunks: number;
  selecting: boolean;
  recovering: boolean;
};

/** Reads actual live owners; no cached READY/progress/terrain-timeout success. */
export function readWorldEntryReadiness(
  world: World,
  options: {
    initializationComplete: boolean;
    spectatorTargetId: string | null;
    spectator: boolean;
    selectedCharacterId: string | null;
    selecting: boolean;
    interrupted: boolean;
    kicked: boolean;
    includeVisualReadiness?: boolean;
  },
): WorldEntryReadiness {
  const network = world.network as ClientNetwork | undefined;
  const connection = network?.ws ?? null;
  const local = world.entities.player as PlayerLocal | undefined;
  const targetId = options.spectator
    ? options.spectatorTargetId
    : options.selectedCharacterId;
  const owner = options.spectator
    ? targetId
      ? world.entities.get(targetId)
      : null
    : local &&
        Boolean(network?.id) &&
        !local.destroyed &&
        world.entities.get(local.id) === local &&
        local.data.owner === network?.id &&
        (!targetId || local.id === targetId)
      ? local
      : null;
  const selecting = options.selecting && !owner;
  const recovering = Boolean(network?.entryRetryState);
  const ownershipReady = Boolean(
    options.initializationComplete &&
    owner &&
    !owner.destroyed &&
    connection?.readyState === 1 &&
    !network?.reconnecting &&
    !options.interrupted &&
    !options.kicked &&
    !selecting &&
    !recovering,
  );
  // Ordinary owners expose an explicit current mounted-avatar receipt.
  // Spectator presentation retains its existing avatar-presence condition;
  // this is not a new embedded-stream qualification.
  const inspectVisuals = options.includeVisualReadiness !== false;
  const playerReady = Boolean(
    inspectVisuals &&
    owner &&
    (options.spectator
      ? (owner as { avatar?: unknown }).avatar &&
        (owner as { avatarUrl?: string }).avatarUrl
      : local?.isAvatarReadyForPresentation() === true),
  );
  const physReady = world.physics?.isInitialized() === true;
  const terrain = world.getSystem<TerrainSystem>("terrain");
  const visuals = inspectVisuals
    ? terrain?.getStreamingVisualReadiness()
    : undefined;
  const blockedChunks = visuals?.grass?.blockedChunks ?? 0;
  const terrainReady =
    terrain?.isReady() === true &&
    visuals?.ready === true &&
    blockedChunks === 0;
  return {
    owner,
    connection,
    targetId,
    ownershipReady,
    ready: ownershipReady && playerReady && physReady && terrainReady,
    playerReady,
    physReady,
    terrainReady,
    blockedChunks,
    selecting,
    recovering,
  };
}

export type WorldEntryPresentationPhase =
  "loading" | "settling" | "fading" | "committed";

/**
 * Pure entry clock. Callers supply a fresh live snapshot and monotonic time.
 * Every boundary revalidates ownership/readiness. After commit, ordinary LOD
 * streaming does not reopen loading, but loss/change of the owner still does.
 */
export class WorldEntryPresentationGate {
  phase: WorldEntryPresentationPhase = "loading";
  private owner: object | null = null;
  private connection: object | null = null;
  private targetId: string | null = null;
  private deadline = 0;
  private lastNow = -Infinity;
  private disposed = false;

  advance(
    snapshot: WorldEntryReadiness,
    now: number,
  ): WorldEntryPresentationPhase {
    if (this.disposed) return "loading";
    if (!Number.isFinite(now) || now < this.lastNow) {
      this.reset();
      throw new Error("Entry readiness requires finite monotonic time");
    }
    this.lastNow = now;
    const sameOwner =
      snapshot.owner === this.owner &&
      snapshot.connection === this.connection &&
      snapshot.targetId === this.targetId;
    if (!snapshot.ownershipReady || !snapshot.owner || !snapshot.connection) {
      this.reset();
      return this.phase;
    }
    if (!sameOwner) this.reset();
    if (this.phase === "committed") return this.phase;
    if (!snapshot.ready) {
      this.reset();
      return this.phase;
    }
    if (this.phase === "loading") {
      this.owner = snapshot.owner;
      this.connection = snapshot.connection;
      this.targetId = snapshot.targetId;
      this.phase = "settling";
      this.deadline = now + 300;
    } else if (this.phase === "settling" && now >= this.deadline) {
      this.phase = "fading";
      this.deadline = now + 220;
    } else if (this.phase === "fading" && now >= this.deadline) {
      this.phase = "committed";
    }
    return this.phase;
  }

  nextDelay(now: number): number {
    return this.phase === "settling" || this.phase === "fading"
      ? Math.max(0, Math.min(250, this.deadline - now))
      : 250;
  }

  reset(): void {
    this.phase = "loading";
    this.owner = null;
    this.connection = null;
    this.targetId = null;
    this.deadline = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }
}
