import { afterEach, describe, expect, it, vi } from "vitest";

import { BIOMES } from "../../../../data/world-structure";
import { EventType } from "../../../../types/events";
import { EventBus } from "../../infrastructure/EventBus";
import { MobNPCSpawnerSystem } from "../../entities/MobNPCSpawnerSystem";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { CollisionMatrix } from "../../movement/CollisionMatrix";
import { TerrainSystem } from "../TerrainSystem";

type MobSpawnerInternals = {
  spawnedMobs: Map<string, string>;
  spawnedMobDetails: Map<string, Record<string, unknown>>;
  entityIdToSpawnKey: Map<string, string>;
  tileSpawnKeys: Map<string, Set<string>>;
  activeMobTiles: Set<string>;
  spawnedBossHotspots: Set<string>;
  spawnMobFromData(
    mobData: Record<string, unknown>,
    position: { x: number; y: number; z: number },
    options: Record<string, unknown>,
  ): Promise<void>;
};

function createSpawnerHarness() {
  const eventBus = new EventBus();
  const destroyedEntityIds: string[] = [];
  let resolveSpawn: (() => void) | null = null;
  const spawnBarrier = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });
  const entityManager = {
    getEntitiesByType: () => [],
    getScaledMobStats: () => ({
      maxHealth: 10,
      attack: 1,
      attackPower: 1,
      defense: 1,
      defenseBonus: 0,
      attackSpeedTicks: 4,
      moveSpeed: 1,
      xpReward: 1,
      aggroRange: 4,
      combatRange: 1,
      wanderRadius: 2,
    }),
    spawnEntity: vi.fn(() => spawnBarrier),
    destroyEntity: vi.fn((entityId: string) => {
      destroyedEntityIds.push(entityId);
      return true;
    }),
  };
  const terrain = {
    getTileSize: () => 100,
    getMobSpawnPositionsForTile: () => [],
    createDeterministicRng: () => () => 0.5,
    getBossHotspots: () => [],
  };
  const world = {
    isServer: true,
    $eventBus: eventBus,
    getSystem: (name: string) => {
      if (name === "terrain") return terrain;
      if (name === "entity-manager") return entityManager;
      return null;
    },
  };
  const spawner = new MobNPCSpawnerSystem(world as never);
  return {
    destroyedEntityIds,
    entityManager,
    eventBus,
    resolveSpawn: () => resolveSpawn?.(),
    spawner,
    internals: spawner as unknown as MobSpawnerInternals,
  };
}

afterEach(() => {
  delete BIOMES.__terrain_mob_lifecycle_test__;
  delete BIOMES.__terrain_walkability_test__;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("terrain generation intent", () => {
  it("upgrades a queued horizon tile when full content is requested", () => {
    const terrain = new TerrainSystem({} as never) as unknown as {
      enqueueTileForGeneration(
        tileX: number,
        tileZ: number,
        generateContent: boolean,
      ): void;
      pendingTileKeys: string[];
      pendingTileContent: Map<string, boolean>;
    };

    terrain.enqueueTileForGeneration(4, -2, false);
    terrain.enqueueTileForGeneration(4, -2, true);

    expect(terrain.pendingTileKeys).toEqual(["4_-2"]);
    expect(terrain.pendingTileContent.get("4_-2")).toBe(true);
  });

  it("prunes obsolete queued tiles after a duel teleport", () => {
    const terrain = new TerrainSystem({} as never) as unknown as {
      prunePendingTileQueue(neededTiles: ReadonlySet<string>): void;
      pendingTileKeys: string[];
      pendingTileSet: Set<string>;
      pendingTileContent: Map<string, boolean>;
      pendingWorkerTiles: Array<{ tileX: number; tileZ: number }>;
      pendingWorkerResults: Map<string, unknown>;
      pendingWorkerTileKeys: Set<string>;
      workerFallbackTileKeys: Set<string>;
    };
    terrain.pendingTileKeys.push("1_1", "50_50", "2_2");
    terrain.pendingTileSet.add("1_1");
    terrain.pendingTileSet.add("50_50");
    terrain.pendingTileSet.add("2_2");
    terrain.pendingTileContent.set("1_1", true);
    terrain.pendingTileContent.set("50_50", true);
    terrain.pendingTileContent.set("2_2", false);
    terrain.pendingWorkerTiles.push(
      { tileX: 1, tileZ: 1 },
      { tileX: 50, tileZ: 50 },
    );
    terrain.pendingWorkerResults.set("50_50", {});
    terrain.pendingWorkerTileKeys.add("1_1");
    terrain.pendingWorkerTileKeys.add("50_50");
    terrain.workerFallbackTileKeys.add("50_50");

    terrain.prunePendingTileQueue(new Set(["1_1", "2_2"]));

    expect(terrain.pendingTileKeys).toEqual(["1_1", "2_2"]);
    expect(terrain.pendingTileSet.has("50_50")).toBe(false);
    expect(terrain.pendingTileContent.has("50_50")).toBe(false);
    expect(terrain.pendingWorkerResults.has("50_50")).toBe(false);
    expect(terrain.pendingWorkerTileKeys.has("50_50")).toBe(false);
    expect(terrain.workerFallbackTileKeys.has("50_50")).toBe(false);
    expect(terrain.pendingWorkerTiles).toEqual([{ tileX: 1, tileZ: 1 }]);
  });

  it("waits for an in-flight client worker instead of synchronously generating the same tile", () => {
    const generateTile = vi.fn(() => ({}));
    const terrain = new TerrainSystem({} as never) as unknown as {
      runtimeIsClient: boolean;
      CONFIG: { USE_WORKERS: boolean };
      processTileGenerationQueue(): void;
      generateTile: typeof generateTile;
      pendingTileKeys: string[];
      pendingTileSet: Set<string>;
      pendingTileContent: Map<string, boolean>;
      pendingWorkerTileKeys: Set<string>;
      workerFallbackTileKeys: Set<string>;
    };
    terrain.runtimeIsClient = true;
    terrain.CONFIG.USE_WORKERS = true;
    terrain.generateTile = generateTile;
    terrain.pendingTileKeys.push("4_7");
    terrain.pendingTileSet.add("4_7");
    terrain.pendingTileContent.set("4_7", true);
    terrain.pendingWorkerTileKeys.add("4_7");

    terrain.processTileGenerationQueue();

    expect(generateTile).not.toHaveBeenCalled();
    expect(terrain.pendingTileKeys).toEqual(["4_7"]);
    expect(terrain.pendingTileSet.has("4_7")).toBe(true);
    expect(terrain.pendingTileContent.get("4_7")).toBe(true);

    terrain.pendingWorkerTileKeys.delete("4_7");
    terrain.workerFallbackTileKeys.add("4_7");
    terrain.processTileGenerationQueue();

    expect(generateTile).toHaveBeenCalledOnce();
    expect(generateTile).toHaveBeenCalledWith(4, 7, true);
    expect(terrain.pendingTileKeys).toEqual([]);
    expect(terrain.pendingTileSet.has("4_7")).toBe(false);
    expect(terrain.workerFallbackTileKeys.has("4_7")).toBe(false);
  });

  it("queues each client tile for worker generation only once", () => {
    const terrain = new TerrainSystem({} as never) as unknown as {
      runtimeIsClient: boolean;
      CONFIG: { USE_WORKERS: boolean };
      enqueueTileForGeneration(
        tileX: number,
        tileZ: number,
        generateContent: boolean,
      ): void;
      pendingWorkerTiles: Array<{ tileX: number; tileZ: number }>;
      pendingWorkerTileKeys: Set<string>;
    };
    terrain.runtimeIsClient = true;
    terrain.CONFIG.USE_WORKERS = true;

    terrain.enqueueTileForGeneration(5, -3, false);
    terrain.enqueueTileForGeneration(5, -3, true);

    expect(terrain.pendingWorkerTiles).toEqual([{ tileX: 5, tileZ: -3 }]);
    expect(terrain.pendingWorkerTileKeys).toEqual(new Set(["5_-3"]));
  });

  it("uses a bounded server tile range centered on the duel lobby", () => {
    const terrain = new TerrainSystem({
      getPlayers: () => [],
    } as never) as unknown as {
      initializeChunkLoadingSystem(): void;
      getTerrainCenters(): Array<{
        id: string;
        position: { x: number; y: number; z: number };
      }>;
      coreChunkRange: number;
      ringChunkRange: number;
      terrainOnlyChunkRange: number;
      maxTilesPerFrame: number;
    };

    terrain.initializeChunkLoadingSystem();
    const centers = terrain.getTerrainCenters();

    expect(terrain.coreChunkRange).toBe(1);
    expect(terrain.ringChunkRange).toBe(2);
    expect(terrain.terrainOnlyChunkRange).toBe(2);
    expect(terrain.maxTilesPerFrame).toBe(1);
    expect(centers).toHaveLength(1);
    expect(centers[0].id).toBe("server-arena-lobby");
    expect(centers[0].position.x).toBeCloseTo(385);
    expect(centers[0].position.z).toBeCloseTo(374);
  });

  it("uses the bounded spectator tile range on the dedicated stream page", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/stream.html", search: "" },
    });
    const terrain = new TerrainSystem({
      network: { isClient: true },
    } as never) as unknown as {
      initializeChunkLoadingSystem(): void;
      coreChunkRange: number;
      ringChunkRange: number;
      terrainOnlyChunkRange: number;
      maxTilesPerFrame: number;
      generationBudgetMsPerFrame: number;
    };

    terrain.initializeChunkLoadingSystem();

    expect(terrain.coreChunkRange).toBe(1);
    expect(terrain.ringChunkRange).toBe(2);
    expect(terrain.terrainOnlyChunkRange).toBe(2);
    expect(terrain.maxTilesPerFrame).toBe(4);
    expect(terrain.generationBudgetMsPerFrame).toBe(10);
  });

  it("keeps one fixed duel-arena center and ignores scripted agent travel", () => {
    vi.stubEnv("STREAMING_DUEL_ENABLED", "true");
    const humanPosition = { x: 1200, y: 4, z: -800 };
    const terrain = new TerrainSystem({
      getPlayers: () => [
        {
          id: "scripted-agent",
          isAgent: true,
          node: { position: { x: 0, y: 0, z: 0 } },
        },
        {
          id: "embedded-agent",
          data: { isEmbeddedAgent: true },
          node: { position: { x: -2500, y: 0, z: 3100 } },
        },
        {
          id: "human-player",
          node: { position: humanPosition },
        },
      ],
    } as never) as unknown as {
      runtimeIsServer: boolean;
      getTerrainCenters(): Array<{
        id: string;
        position: { x: number; y: number; z: number };
      }>;
    };
    terrain.runtimeIsServer = true;

    const centers = terrain.getTerrainCenters();

    expect(centers.map((center) => center.id)).toEqual([
      "server-arena-lobby",
      "human-player",
    ]);
    expect(centers[0].position.x).toBeCloseTo(385);
    expect(centers[0].position.z).toBeCloseTo(374);
    expect(centers[1].position).toBe(humanPosition);
  });

  it("retains only exact launch-preparation manifest tiles", () => {
    vi.stubEnv("STREAMING_DUEL_ENABLED", "true");
    const terrain = new TerrainSystem({} as never) as unknown as {
      runtimeIsServer: boolean;
      getServerLaunchPreparationAreas(): Array<{
        bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
      }>;
      addServerLaunchPreparationTiles(tileKeys: Set<string>): void;
    };
    terrain.runtimeIsServer = true;
    terrain.getServerLaunchPreparationAreas = () => [
      { bounds: { minX: -36, maxX: 36, minZ: -36, maxZ: 36 } },
    ];
    const tileKeys = new Set(["3_3"]);

    terrain.addServerLaunchPreparationTiles(tileKeys);

    expect(tileKeys).toEqual(new Set(["3_3", "0_0"]));
  });

  it("bakes manifest preparation terrain during initial duel-server loading", () => {
    vi.stubEnv("STREAMING_DUEL_ENABLED", "true");
    const generateTile = vi.fn(() => ({}));
    const terrain = new TerrainSystem({
      getPlayers: () => [],
    } as never) as unknown as {
      runtimeIsServer: boolean;
      coreChunkRange: number;
      ringChunkRange: number;
      terrainOnlyChunkRange: number;
      terrainTiles: Map<string, unknown>;
      generateTile: typeof generateTile;
      getServerLaunchPreparationAreas(): Array<{
        bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
      }>;
      loadInitialTiles(): void;
    };
    terrain.runtimeIsServer = true;
    terrain.coreChunkRange = 0;
    terrain.ringChunkRange = 0;
    terrain.terrainOnlyChunkRange = 0;
    terrain.terrainTiles = new Map();
    terrain.generateTile = generateTile;
    terrain.getServerLaunchPreparationAreas = () => [
      { bounds: { minX: -36, maxX: 36, minZ: -36, maxZ: 36 } },
    ];

    terrain.loadInitialTiles();

    expect(generateTile).toHaveBeenCalledWith(0, 0, true);
  });

  it("keeps stream-page terrain pinned to authoritative arena positions during cleanup teleports", () => {
    const remotePosition = { x: 2_500, y: 0, z: -1_900 };
    const fakeWindow = {
      location: { pathname: "/stream.html", search: "" },
      __HYPERIA_STREAM_STATE__: {
        cycle: {
          arenaPositions: {
            agent1: [350, 1, 405],
            agent2: [350, 1, 415],
          },
        },
      },
    };
    vi.stubGlobal("window", fakeWindow);

    const terrain = new TerrainSystem({
      getPlayer: () => null,
      getSystem: () => ({ spectatorFollowEntity: "winner" }),
      entities: {
        items: new Map([["winner", { position: remotePosition }]]),
        players: new Map(),
      },
    } as never) as unknown as {
      runtimeIsClient: boolean;
      getTerrainCenters(): Array<{
        id: string;
        position: { x: number; y: number; z: number };
      }>;
    };
    terrain.runtimeIsClient = true;

    const active = terrain.getTerrainCenters();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("streaming-arena-focus");
    expect(active[0].position).toMatchObject({ x: 350, y: 1, z: 410 });

    remotePosition.x = -4_000;
    remotePosition.z = 3_000;
    fakeWindow.__HYPERIA_STREAM_STATE__.cycle.arenaPositions = null as never;
    const cleanup = terrain.getTerrainCenters();

    expect(cleanup[0].id).toBe("streaming-arena-focus");
    expect(cleanup[0].position).toMatchObject({ x: 350, y: 1, z: 410 });
  });

  it("keeps both active preparation and arena terrain resident for a seamless broadcast handoff", () => {
    const agentA = {
      position: { x: -8.75, y: 28.08, z: -10.75 },
      data: {
        gatheringToolPresentation: { revision: 1, itemId: "harpoon" },
      },
    };
    const agentB = {
      position: { x: -1.75, y: 28.08, z: -12.5 },
      data: {
        gatheringToolPresentation: { revision: 1, itemId: "harpoon" },
      },
    };
    vi.stubGlobal("window", {
      location: { pathname: "/stream.html", search: "" },
      __HYPERIA_STREAM_STATE__: {
        cycle: {
          phase: "IDLE",
          agent1: { id: "agent-a" },
          agent2: { id: "agent-b" },
          arenaPositions: {
            agent1: [350, 1, 405],
            agent2: [350, 1, 415],
          },
        },
      },
    });

    const entities = new Map<string, unknown>([
      ["agent-a", agentA],
      ["agent-b", agentB],
    ]);
    const terrain = new TerrainSystem({
      getPlayer: () => null,
      entities: { get: (id: string) => entities.get(id) },
    } as never) as unknown as {
      runtimeIsClient: boolean;
      getTerrainCenters(): Array<{
        id: string;
        position: { x: number; y: number; z: number };
      }>;
    };
    terrain.runtimeIsClient = true;

    expect(terrain.getTerrainCenters()).toMatchObject([
      {
        id: "streaming-preparation-focus",
        position: { x: -5.25, y: 28.08, z: -11.625 },
      },
      {
        id: "streaming-arena-focus",
        position: { x: 350, y: 1, z: 410 },
      },
    ]);

    agentA.data.gatheringToolPresentation.itemId = null as never;
    agentB.data.gatheringToolPresentation.itemId = null as never;
    expect(terrain.getTerrainCenters()).toMatchObject([
      {
        id: "streaming-arena-focus",
        position: { x: 350, y: 1, z: 410 },
      },
    ]);
  });

  it("generates deterministic biome-mob positions for a tile", () => {
    BIOMES.__terrain_mob_lifecycle_test__ = {
      difficulty: 1,
      mobTypes: ["test-mob"],
    } as (typeof BIOMES)[string];

    const terrain = new TerrainSystem({ config: { terrainSeed: 91 } } as never);
    const internals = terrain as unknown as {
      getBiomeAt: (tileX: number, tileZ: number) => string;
      getTerrainInfoAt: (
        x: number,
        z: number,
      ) => {
        walkable: boolean;
        underwater: boolean;
        height: number;
      };
      isPositionNearRoad: () => boolean;
      isPositionNearTown: () => boolean;
    };
    internals.getBiomeAt = () => "__terrain_mob_lifecycle_test__";
    internals.getTerrainInfoAt = () => ({
      walkable: true,
      underwater: false,
      height: 7,
    });
    internals.isPositionNearRoad = () => false;
    internals.isPositionNearTown = () => false;

    const first = terrain.getMobSpawnPositionsForTile(3, -4, 3);
    const second = terrain.getMobSpawnPositionsForTile(3, -4, 3);
    const anotherTile = terrain.getMobSpawnPositionsForTile(4, -4, 3);

    expect(second).toEqual(first);
    expect(anotherTile.map((spawn) => spawn.position)).not.toEqual(
      first.map((spawn) => spawn.position),
    );
  });

  it("bakes centered terrain collision with bounded height sampling", () => {
    BIOMES.__terrain_walkability_test__ = {
      maxSlope: 0.5,
    } as (typeof BIOMES)[string];
    const collision = new CollisionMatrix();
    const terrain = new TerrainSystem({
      collision,
      getSystem: () => null,
    } as never);
    const getHeightAt = vi.fn((x: number) => 100 + x * 2);
    const internals = terrain as unknown as {
      waterBodyRegistry: { getBodiesInTile: () => [] };
      getHeightAt: (x: number, z: number) => number;
      getBiomeAt: (tileX: number, tileZ: number) => string;
      bakeWalkabilityFlags(tileX: number, tileZ: number): void;
    };
    internals.waterBodyRegistry = { getBodiesInTile: () => [] };
    internals.getHeightAt = getHeightAt;
    internals.getBiomeAt = () => "__terrain_walkability_test__";
    collision.addFlags(50, -150, CollisionFlag.BLOCKED);

    internals.bakeWalkabilityFlags(1, -1);

    expect(collision.getFlags(50, -150)).toBe(
      CollisionFlag.BLOCKED | CollisionFlag.STEEP_SLOPE,
    );
    expect(collision.getFlags(149, -51)).toBe(CollisionFlag.STEEP_SLOPE);
    expect(collision.getFlags(49, -150)).toBe(0);
    expect(collision.getFlags(150, -51)).toBe(0);
    expect(getHeightAt.mock.calls.length).toBeLessThan(17_000);

    internals.getHeightAt = () => 100;
    internals.bakeWalkabilityFlags(1, -1);
    expect(collision.getFlags(50, -150)).toBe(CollisionFlag.BLOCKED);
    expect(collision.getFlags(149, -51)).toBe(0);
  });
});

describe("terrain-owned mob lifecycle", () => {
  it("does not spawn mobs for geometry-only horizon tiles", async () => {
    const harness = createSpawnerHarness();
    await harness.spawner.init();

    harness.eventBus.emitEvent(
      EventType.TERRAIN_TILE_GENERATED,
      {
        tileId: "8,9",
        tileX: 8,
        tileZ: 9,
        position: { x: 800, z: 900 },
        biome: "grassland",
        contentGenerated: false,
        resources: [],
      },
      "test",
    );

    expect(harness.internals.activeMobTiles.has("8_9")).toBe(false);
    expect(harness.internals.spawnedMobs.size).toBe(0);
    harness.spawner.destroy();
  });

  it("despawns only the mobs owned by an unloaded terrain tile", async () => {
    const harness = createSpawnerHarness();
    await harness.spawner.init();
    const deaths: string[] = [];
    harness.eventBus.subscribe(EventType.ENTITY_DEATH, (event) => {
      deaths.push(event.data.entityId);
    });

    harness.internals.activeMobTiles.add("1_2");
    harness.internals.activeMobTiles.add("5_6");
    harness.internals.spawnedMobs.set("spawn-a", "mob-a");
    harness.internals.spawnedMobs.set("boss_hotspot", "mob-b");
    harness.internals.spawnedMobs.set("spawn-c", "mob-c");
    harness.internals.entityIdToSpawnKey.set("mob-a", "spawn-a");
    harness.internals.entityIdToSpawnKey.set("mob-b", "boss_hotspot");
    harness.internals.entityIdToSpawnKey.set("mob-c", "spawn-c");
    harness.internals.spawnedMobDetails.set("spawn-a", {
      sourceTileKey: "1_2",
      isBoss: false,
    });
    harness.internals.spawnedMobDetails.set("boss_hotspot", {
      sourceTileKey: "1_2",
      isBoss: true,
    });
    harness.internals.spawnedMobDetails.set("spawn-c", {
      sourceTileKey: "5_6",
      isBoss: false,
    });
    harness.internals.spawnedBossHotspots.add("hotspot");
    harness.internals.tileSpawnKeys.set(
      "1_2",
      new Set(["spawn-a", "boss_hotspot"]),
    );
    harness.internals.tileSpawnKeys.set("5_6", new Set(["spawn-c"]));

    harness.eventBus.emitEvent(
      EventType.TERRAIN_TILE_UNLOADED,
      { tileId: "1,2", tileX: 1, tileZ: 2 },
      "test",
    );

    expect(deaths).toEqual(["mob-a", "mob-b"]);
    expect(harness.internals.activeMobTiles.has("1_2")).toBe(false);
    expect(harness.internals.spawnedMobs.has("spawn-a")).toBe(false);
    expect(harness.internals.spawnedMobs.has("boss_hotspot")).toBe(false);
    expect(harness.internals.spawnedBossHotspots.has("hotspot")).toBe(false);
    expect(harness.internals.spawnedMobs.get("spawn-c")).toBe("mob-c");
    expect(harness.internals.tileSpawnKeys.get("5_6")).toEqual(
      new Set(["spawn-c"]),
    );
    harness.spawner.destroy();
  });

  it("removes a spawn that completes after its source tile unloads", async () => {
    const harness = createSpawnerHarness();
    await harness.spawner.init();
    harness.internals.activeMobTiles.add("2_3");

    const spawn = harness.internals.spawnMobFromData(
      {
        id: "lifecycle-test-mob",
        name: "Lifecycle test mob",
        description: "test",
        category: "mob",
        appearance: { scale: 1, modelPath: "asset://test.glb" },
        stats: { level: 1, health: 10 },
        combat: {
          attackSpeedTicks: 4,
          respawnTime: 1000,
          aggressive: false,
          retaliates: true,
          attackable: true,
          aggroRange: 4,
          combatRange: 1,
          leashRange: 5,
        },
        movement: { type: "wander", wanderRadius: 2 },
        drops: { common: [] },
      },
      { x: 210, y: 7, z: 310 },
      { sourceTileKey: "2_3", spawnKey: "late-spawn" },
    );

    await Promise.resolve();
    harness.eventBus.emitEvent(
      EventType.TERRAIN_TILE_UNLOADED,
      { tileId: "2,3", tileX: 2, tileZ: 3 },
      "test",
    );
    harness.resolveSpawn();
    await spawn;

    expect(harness.entityManager.spawnEntity).toHaveBeenCalledTimes(1);
    expect(harness.destroyedEntityIds).toEqual(["gdd_lifecycle-test-mob_0"]);
    expect(harness.internals.spawnedMobs.has("late-spawn")).toBe(false);
    expect(harness.internals.tileSpawnKeys.has("2_3")).toBe(false);
    harness.spawner.destroy();
  });
});
