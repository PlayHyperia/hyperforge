import { describe, expect, it, vi } from "vitest";

import { ResourceSystem } from "../ResourceSystem";

type TestResource = {
  id: string;
  type: "tree";
  name: string;
  position: { x: number; y: number; z: number };
  skillRequired: "woodcutting";
  isAvailable: boolean;
  drops: [];
};

function createFixture() {
  const entities = new Map<string, unknown>();
  const destroyEntity = vi.fn((id: string) => entities.delete(id));
  const world = {
    isServer: true,
    currentTick: 0,
    entities,
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getPlayer: vi.fn(),
    getSystem: vi.fn((name: string) =>
      name === "entity-manager" ? { destroyEntity } : null,
    ),
    $eventBus: {
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      subscribeOnce: vi.fn(() => ({ unsubscribe: vi.fn() })),
      emitEvent: vi.fn(),
      request: vi.fn(),
      respond: vi.fn(),
    },
  };
  const system = new ResourceSystem(world as never);
  const internals = system as unknown as {
    resources: Map<string, TestResource>;
    activeGathering: Map<
      string,
      { playerId: string; resourceId: string; toolItemId: null }
    >;
    resourceVariants: Map<string, string>;
    resourceTimers: Map<
      string,
      {
        currentTicks: number;
        maxTicks: number;
        hasReceivedFirstLog: boolean;
        activeGatherers: Set<string>;
        lastUpdateTick: number;
      }
    >;
    respawnAtTick: Map<string, number>;
    fishingSpotMoveTimers: Map<
      string,
      {
        moveAtTick: number;
        originalPosition: { x: number; y: number; z: number };
      }
    >;
    manifestResourceIds: Set<string>;
    playerSkills: Map<string, Record<string, { level: number; xp: number }>>;
    gatherRateLimits: Map<string, number>;
    suspiciousPatterns: Map<string, unknown>;
    pendingFishingAreas: Map<string, unknown>;
    onTerrainTileUnloaded(data: {
      tileId: string;
      tileX: number;
      tileZ: number;
    }): void;
    cleanupPlayerGathering(playerId: string): void;
  };

  return { world, system, internals, destroyEntity };
}

function addResource(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  x: number,
  z: number,
  manifest = false,
): void {
  const position = { x, y: 0, z };
  fixture.internals.resources.set(id, {
    id,
    type: "tree",
    name: id,
    position,
    skillRequired: "woodcutting",
    isAvailable: true,
    drops: [],
  });
  fixture.world.entities.set(id, { id });
  fixture.internals.resourceVariants.set(id, "tree_normal");
  fixture.internals.resourceTimers.set(id, {
    currentTicks: 5,
    maxTicks: 10,
    hasReceivedFirstLog: true,
    activeGatherers: new Set(),
    lastUpdateTick: 1,
  });
  fixture.internals.respawnAtTick.set(id, 100);
  fixture.internals.fishingSpotMoveTimers.set(id, {
    moveAtTick: 100,
    originalPosition: position,
  });
  if (manifest) fixture.internals.manifestResourceIds.add(id);
}

describe("ResourceSystem terrain and population lifecycle", () => {
  it.each([
    {
      label: "positive centered half",
      target: { x: 75, z: 75 },
      tile: { x: 1, z: 1 },
      survivor: { x: 25, z: 25 },
    },
    {
      label: "negative centered half",
      target: { x: -25, z: -25 },
      tile: { x: 0, z: 0 },
      survivor: { x: -75, z: -75 },
    },
  ])(
    "unloads resources from the $label using TerrainSystem's centered chunk index",
    ({ target, tile, survivor }) => {
      const fixture = createFixture();
      addResource(fixture, "target-tree", target.x, target.z);
      addResource(fixture, "survivor-tree", survivor.x, survivor.z);
      fixture.internals.activeGathering.set("agent-1", {
        playerId: "agent-1",
        resourceId: "target-tree",
        toolItemId: null,
      });
      fixture.internals.resourceTimers
        .get("target-tree")!
        .activeGatherers.add("agent-1");

      fixture.internals.onTerrainTileUnloaded({
        tileId: `${tile.x},${tile.z}`,
        tileX: tile.x,
        tileZ: tile.z,
      });

      expect(fixture.internals.resources.has("target-tree")).toBe(false);
      expect(fixture.world.entities.has("target-tree")).toBe(false);
      expect(fixture.internals.activeGathering.has("agent-1")).toBe(false);
      expect(fixture.internals.resourceVariants.has("target-tree")).toBe(false);
      expect(fixture.internals.resourceTimers.has("target-tree")).toBe(false);
      expect(fixture.internals.respawnAtTick.has("target-tree")).toBe(false);
      expect(fixture.internals.fishingSpotMoveTimers.has("target-tree")).toBe(
        false,
      );
      expect(fixture.destroyEntity).toHaveBeenCalledWith("target-tree");

      expect(fixture.internals.resources.has("survivor-tree")).toBe(true);
      expect(fixture.world.entities.has("survivor-tree")).toBe(true);
      expect(fixture.internals.resourceVariants.has("survivor-tree")).toBe(
        true,
      );
    },
  );

  it("keeps authored manifest resources resident when their terrain chunk unloads", () => {
    const fixture = createFixture();
    addResource(fixture, "manifest-tree", 75, 75, true);

    fixture.internals.onTerrainTileUnloaded({
      tileId: "1,1",
      tileX: 1,
      tileZ: 1,
    });

    expect(fixture.internals.resources.has("manifest-tree")).toBe(true);
    expect(fixture.world.entities.has("manifest-tree")).toBe(true);
    expect(fixture.destroyEntity).not.toHaveBeenCalled();
  });

  it("reports a structurally complete resource ecology snapshot", () => {
    const fixture = createFixture();
    addResource(fixture, "available-manifest-tree", 25, 25, true);
    addResource(fixture, "depleted-terrain-tree", 75, 75);
    fixture.internals.resources.get("depleted-terrain-tree")!.isAvailable =
      false;
    fixture.internals.activeGathering.set("agent-1", {
      playerId: "agent-1",
      resourceId: "available-manifest-tree",
      toolItemId: null,
    });
    fixture.internals.resourceTimers
      .get("available-manifest-tree")!
      .activeGatherers.add("agent-1");
    fixture.internals.playerSkills.set("agent-1", {
      woodcutting: { level: 10, xp: 1_000 },
    });
    fixture.internals.gatherRateLimits.set("agent-1", Date.now());
    fixture.internals.suspiciousPatterns.set("agent-1", { attempts: 1 });
    fixture.internals.pendingFishingAreas.set("pond", { id: "pond" });

    expect(fixture.system.getResourceEcologyStats()).toEqual({
      totalResources: 2,
      availableResources: 1,
      depletedResources: 1,
      manifestResources: 1,
      resourceVariants: 2,
      forestryTimers: 2,
      forestryActiveGatherers: 1,
      scheduledRespawns: 2,
      fishingMovementTimers: 2,
      pendingFishingAreas: 1,
      playerSkillSnapshots: 1,
      gatherRateLimits: 1,
      suspiciousPatternEntries: 1,
      custody: {
        activeSessions: 1,
        pendingRewards: 0,
        inFlightRewards: 0,
        retryWaitingRewards: 0,
        resourceReservations: 0,
        maxRetryCount: 0,
      },
    });
  });

  it("keeps every terrain-resource index bounded through 60,000 ticks of 25-agent chunk churn", () => {
    const fixture = createFixture();
    const simulatedTicks = 60_000;
    const churnIntervalTicks = 60;
    let churnCycles = 0;

    for (let tick = 0; tick <= simulatedTicks; tick += churnIntervalTicks) {
      fixture.world.currentTick = tick;
      for (let index = 0; index < 25; index++) {
        const resourceId = `terrain-tree-${index}`;
        const playerId = `population-agent-${index}`;
        const x = 51 + (index % 5) * 8;
        const z = 51 + Math.floor(index / 5) * 8;
        addResource(fixture, resourceId, x, z);
        fixture.internals.activeGathering.set(playerId, {
          playerId,
          resourceId,
          toolItemId: null,
        });
        fixture.internals.resourceTimers
          .get(resourceId)!
          .activeGatherers.add(playerId);
      }

      expect(fixture.internals.resources.size).toBe(25);
      expect(fixture.world.entities.size).toBe(25);
      expect(fixture.internals.activeGathering.size).toBe(25);

      fixture.internals.onTerrainTileUnloaded({
        tileId: "1,1",
        tileX: 1,
        tileZ: 1,
      });
      churnCycles++;

      expect(fixture.internals.resources.size).toBe(0);
      expect(fixture.world.entities.size).toBe(0);
      expect(fixture.internals.activeGathering.size).toBe(0);
      expect(fixture.internals.resourceVariants.size).toBe(0);
      expect(fixture.internals.resourceTimers.size).toBe(0);
      expect(fixture.internals.respawnAtTick.size).toBe(0);
      expect(fixture.internals.fishingSpotMoveTimers.size).toBe(0);
      fixture.destroyEntity.mockClear();
    }

    expect(churnCycles).toBe(1_001);
  });

  it("releases disconnected skill snapshots and clears every retained lifecycle index on destroy", () => {
    const fixture = createFixture();
    fixture.internals.playerSkills.set("agent-1", {
      woodcutting: { level: 10, xp: 1_000 },
    });
    fixture.internals.gatherRateLimits.set("agent-1", Date.now());

    fixture.internals.cleanupPlayerGathering("agent-1");

    expect(fixture.internals.playerSkills.has("agent-1")).toBe(false);
    expect(fixture.internals.gatherRateLimits.has("agent-1")).toBe(false);

    addResource(fixture, "terrain-tree", 75, 75);
    fixture.internals.playerSkills.set("agent-2", {
      mining: { level: 1, xp: 0 },
    });
    fixture.internals.suspiciousPatterns.set("agent-2", { attempts: 1 });
    fixture.internals.pendingFishingAreas.set("pond", { id: "pond" });

    fixture.system.destroy();

    expect(fixture.internals.resources.size).toBe(0);
    expect(fixture.internals.resourceVariants.size).toBe(0);
    expect(fixture.internals.resourceTimers.size).toBe(0);
    expect(fixture.internals.respawnAtTick.size).toBe(0);
    expect(fixture.internals.fishingSpotMoveTimers.size).toBe(0);
    expect(fixture.internals.playerSkills.size).toBe(0);
    expect(fixture.internals.suspiciousPatterns.size).toBe(0);
    expect(fixture.internals.pendingFishingAreas.size).toBe(0);
  });
});
