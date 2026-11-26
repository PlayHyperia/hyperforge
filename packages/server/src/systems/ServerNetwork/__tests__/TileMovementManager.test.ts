import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import {
  AttackType,
  DataManager,
  canPlayerPerformPreparationAction,
  DeathState,
  EntityOccupancyMap,
  resolveFootprint,
  stationDataProvider,
} from "@hyperforge/shared";

import modelBoundsManifest from "../../../../world/assets/manifests/model-bounds.json";
import stationsManifest from "../../../../world/assets/manifests/stations.json";
import worldAreasManifest from "../../../../world/assets/manifests/world-areas.json";
import { TileMovementManager } from "../tile-movement";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

// Mocks
const createMockWorld = () => ({
  entities: {
    get: vi.fn(),
    players: new Map<string, unknown>(),
  },
  entityOccupancy: {
    isBlocked: vi.fn().mockReturnValue(false),
    isOccupied: vi.fn().mockReturnValue(false),
    getOccupant: vi.fn().mockReturnValue(null),
    occupy: vi.fn(),
    move: vi.fn(),
    vacate: vi.fn(),
    getStats: vi.fn(() => ({
      occupiedTileCount: 0,
      trackedEntityCount: 0,
      mobTileCount: 0,
      playerTileCount: 0,
      collisionIgnoringEntities: 0,
    })),
  },
  getSystem: vi.fn(),
  collision: {
    hasFlags: vi.fn().mockReturnValue(false),
    isBlocked: vi.fn().mockReturnValue(false),
  },
  emit: vi.fn(),
  faceDirectionManager: { markPlayerMoved: vi.fn() },
});

const createMockBuildingService = () => ({
  getBuildingAt: vi.fn(),
  getPlayerFloor: vi.fn(),
  getFloorHeight: vi.fn(),
  getFloor: vi.fn().mockReturnValue(undefined),
  getStepHeightAtWorld: vi.fn().mockReturnValue(null),
  handleStairTransition: vi.fn(),
  isTileWalkableInBuilding: vi.fn(),
  checkBuildingMovement: vi.fn().mockReturnValue({
    buildingAllowsMovement: true,
    targetInBuildingFootprint: false,
  }),
});

describe("TileMovementManager - Building Integration", () => {
  let manager: TileMovementManager;
  let mockWorld: any;
  let mockBuildingService: any;
  let mockSendFn: any;

  beforeEach(() => {
    mockWorld = createMockWorld();
    mockBuildingService = createMockBuildingService();
    mockSendFn = vi.fn();

    mockWorld.getSystem.mockImplementation((name: string) => {
      if (name === "buildingCollision") return mockBuildingService;
      return null;
    });

    manager = new TileMovementManager(mockWorld, mockSendFn);
  });

  it("returns a truthful movement admission receipt", () => {
    expect(
      manager.movePlayerToward(
        "missing-player",
        { x: 1.5, y: 0, z: 0.5 },
        false,
      ),
    ).toBe(false);

    const playerId = "movement-receipt-player";
    const position = {
      x: 0.5,
      y: 0,
      z: 0.5,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
        deathState: DeathState.ALIVE,
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );
    manager.syncPlayerPosition(playerId, position);

    expect(
      manager.movePlayerToward(playerId, { x: 1.5, y: 0, z: 0.5 }, false),
    ).toBe(true);
    expect(mockSendFn).toHaveBeenCalledWith(
      "tileMovementStart",
      expect.objectContaining({ id: playerId, moveSeq: 1 }),
    );

    entity.data.deathState = DeathState.DEAD;
    expect(
      manager.movePlayerToward(playerId, { x: 2.5, y: 0, z: 0.5 }, false),
    ).toBe(false);
  });

  it("stops an active combat path when the actor is already in exact attack range", () => {
    const playerId = "combat-arrival-player";
    const position = {
      x: 0.5,
      y: 0,
      z: 0.5,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
        deathState: DeathState.ALIVE,
        tileMovementActive: false,
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );
    manager.syncPlayerPosition(playerId, position);

    expect(
      manager.movePlayerToward(
        playerId,
        { x: 4.5, y: 0, z: 0.5 },
        true,
        1,
        AttackType.MELEE,
      ),
    ).toBe(true);
    expect(manager.getPlayerMovementDebug(playerId).activePath).toBe(true);

    position.x = 3.5;
    entity.data.position = [position.x, position.y, position.z];
    mockSendFn.mockClear();

    expect(
      manager.movePlayerToward(
        playerId,
        { x: 4.5, y: 0, z: 0.5 },
        true,
        1,
        AttackType.MELEE,
      ),
    ).toBe(true);
    expect(manager.getPlayerMovementDebug(playerId)).toEqual(
      expect.objectContaining({
        activePath: false,
        currentTile: { x: 3, z: 0 },
        remainingPathTiles: 0,
      }),
    );
    expect(entity.data.tileMovementActive).toBe(false);
    expect(mockSendFn).toHaveBeenCalledWith(
      "tileMovementEnd",
      expect.objectContaining({
        id: playerId,
        tile: { x: 3, z: 0 },
        emote: "idle",
      }),
    );
  });

  it("persists settled open-world endpoints without overwriting duel recovery positions", () => {
    const playerId = "settled-position-player";
    const savePlayer = vi.fn();
    mockWorld.getSystem.mockImplementation((name: string) => {
      if (name === "buildingCollision") return mockBuildingService;
      if (name === "database") return { savePlayer };
      return null;
    });
    const position = {
      x: 0.5,
      y: 0,
      z: 0.5,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
        deathState: DeathState.ALIVE,
        inStreamingDuel: false,
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );
    manager.syncPlayerPosition(playerId, position);

    expect(
      manager.movePlayerToward(playerId, { x: 1.5, y: 0, z: 0.5 }, false),
    ).toBe(true);
    manager.processPlayerTick(playerId, 1);
    expect(savePlayer).toHaveBeenCalledTimes(1);
    expect(savePlayer).toHaveBeenLastCalledWith(playerId, {
      positionX: 1.5,
      positionY: 0.01,
      positionZ: 0.5,
    });

    entity.data.inStreamingDuel = true;
    expect(
      manager.movePlayerToward(playerId, { x: 2.5, y: 0, z: 0.5 }, false),
    ).toBe(true);
    manager.processPlayerTick(playerId, 2);
    expect(savePlayer).toHaveBeenCalledTimes(1);
  });

  it("should call handleStairTransition during movement", () => {
    const playerId = "player1";
    manager.syncPlayerPosition(playerId, { x: 10, y: 0, z: 10 });

    const state = (manager as any).playerStates.get(playerId);
    state.path = [{ x: 11, z: 10 }];
    state.pathIndex = 0;
    state.previousTile = { x: 10, z: 10 };

    mockWorld.entities.get.mockReturnValue({
      position: { set: vi.fn() },
      data: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      node: { quaternion: { copy: vi.fn() } },
    });

    // Capture mutable arguments
    const capturedFrom: any = {};
    const capturedTo: any = {};
    mockBuildingService.handleStairTransition.mockImplementation(
      (_id: string, from: any, to: any) => {
        Object.assign(capturedFrom, from);
        Object.assign(capturedTo, to);
      },
    );

    manager.processPlayerTick(playerId, 1);

    expect(capturedFrom).toEqual({ x: 10, z: 10 });
    expect(capturedTo).toEqual({ x: 11, z: 10 });
  });

  it("should use floor height from BuildingCollisionService when in building", () => {
    const playerId = "player1";
    manager.syncPlayerPosition(playerId, { x: 10, y: 0, z: 10 });
    const state = (manager as any).playerStates.get(playerId);
    state.path = [{ x: 11, z: 10 }];
    state.pathIndex = 0;
    state.previousTile = { x: 10, z: 10 };

    const mockSetPosition = vi.fn();
    mockWorld.entities.get.mockReturnValue({
      position: { set: mockSetPosition },
      data: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      node: { quaternion: { copy: vi.fn() } },
    });

    mockBuildingService.getPlayerFloor.mockReturnValue(1);
    mockBuildingService.getBuildingAt.mockReturnValue("building1");
    mockBuildingService.getFloorHeight.mockReturnValue(5.0);
    mockBuildingService.getFloor.mockReturnValue({
      elevation: 5.0,
      walkableTiles: new Set(["11,10"]),
    });
    mockBuildingService.isTileWalkableInBuilding.mockReturnValue(true);

    manager.processPlayerTick(playerId, 1);

    expect(mockSetPosition).toHaveBeenCalledWith(11.5, 5.01, 10.5);
  });

  it("should use terrain height when not in building", () => {
    const playerId = "player1";
    manager.syncPlayerPosition(playerId, { x: 10, y: 0, z: 10 });
    const state = (manager as any).playerStates.get(playerId);
    state.path = [{ x: 11, z: 10 }];
    state.pathIndex = 0;
    state.previousTile = { x: 10, z: 10 };

    const mockSetPosition = vi.fn();
    mockWorld.entities.get.mockReturnValue({
      position: { set: mockSetPosition },
      data: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      node: { quaternion: { copy: vi.fn() } },
    });

    mockBuildingService.getPlayerFloor.mockReturnValue(0);
    mockBuildingService.getBuildingAt.mockReturnValue(null);

    const mockTerrain = {
      getHeightAt: vi.fn().mockReturnValue(2.0),
      isPositionWalkableFast: vi.fn().mockReturnValue(true),
    };
    mockWorld.getSystem.mockImplementation((name: string) => {
      if (name === "buildingCollision") return mockBuildingService;
      if (name === "terrain") return mockTerrain;
      return null;
    });

    manager.processPlayerTick(playerId, 1);

    expect(mockSetPosition).toHaveBeenCalledWith(11.5, 2.01, 10.5);
  });

  it("follows pre-computed path and clears on arrival", () => {
    // processPlayerTick follows the path produced by BFS pathfinding.
    // When the path is fully consumed, pathIndex and path are reset.
    const moverId = "mover";
    const manager = new TileMovementManager(mockWorld, mockSendFn);

    manager.syncPlayerPosition(moverId, { x: 10, y: 0, z: 10 });
    const state = (
      manager as unknown as { playerStates: Map<string, unknown> }
    ).playerStates.get(moverId) as {
      path: Array<{ x: number; z: number }>;
      pathIndex: number;
      previousTile: { x: number; z: number };
      currentTile: { x: number; z: number };
    };
    state.path = [{ x: 11, z: 10 }];
    state.pathIndex = 0;
    state.previousTile = { x: 10, z: 10 };

    mockWorld.entities.get.mockReturnValue({
      position: { set: vi.fn(), x: 10.5, y: 0, z: 10.5 },
      data: {
        position: [10.5, 0, 10.5],
        quaternion: [0, 0, 0, 1],
        tileMovementActive: true,
      },
      node: { quaternion: { copy: vi.fn() } },
    });

    manager.processPlayerTick(moverId, 1);

    // Player arrived at destination; path is cleared on arrival
    expect(state.currentTile).toEqual({ x: 11, z: 10 });
    expect(state.path).toHaveLength(0);
    expect(state.pathIndex).toBe(0);
  });

  it("resolves the current authoritative emote at movement end", () => {
    const playerId = "arrival-authority";
    const resolveAtArrival = vi.fn(() => "small_fishing_net");
    manager.syncPlayerPosition(playerId, { x: 10.5, y: 0, z: 10.5 });
    const state = (
      manager as unknown as { playerStates: Map<string, unknown> }
    ).playerStates.get(playerId) as {
      path: Array<{ x: number; z: number }>;
      pathIndex: number;
      previousTile: { x: number; z: number };
    };
    state.path = [{ x: 11, z: 10 }];
    state.pathIndex = 0;
    state.previousTile = { x: 10, z: 10 };
    mockWorld.entities.get.mockReturnValue({
      position: { set: vi.fn(), x: 10.5, y: 0, z: 10.5 },
      data: {
        position: [10.5, 0, 10.5],
        quaternion: [0, 0, 0, 1],
        tileMovementActive: true,
      },
      node: { quaternion: { copy: vi.fn() } },
    });
    manager.setArrivalEmote(playerId, "fishing_rod", resolveAtArrival);

    manager.processPlayerTick(playerId, 1);

    expect(resolveAtArrival).toHaveBeenCalledOnce();
    expect(mockSendFn).toHaveBeenCalledWith(
      "tileMovementEnd",
      expect.objectContaining({ id: playerId, emote: "small_fishing_net" }),
    );
    expect(mockSendFn).toHaveBeenCalledWith(
      "entityModified",
      expect.objectContaining({
        id: playerId,
        changes: expect.objectContaining({ e: "small_fishing_net" }),
      }),
    );
  });

  it.each([
    ["revoked", () => null],
    [
      "resolver failure",
      () => {
        throw new Error("custody unavailable");
      },
    ],
  ])("fails %s arrival authority closed to idle", (_label, resolver) => {
    const playerId = `arrival-${_label}`;
    manager.syncPlayerPosition(playerId, { x: 10.5, y: 0, z: 10.5 });
    const state = (
      manager as unknown as { playerStates: Map<string, unknown> }
    ).playerStates.get(playerId) as {
      path: Array<{ x: number; z: number }>;
      pathIndex: number;
      previousTile: { x: number; z: number };
    };
    state.path = [{ x: 11, z: 10 }];
    state.pathIndex = 0;
    state.previousTile = { x: 10, z: 10 };
    mockWorld.entities.get.mockReturnValue({
      position: { set: vi.fn(), x: 10.5, y: 0, z: 10.5 },
      data: {
        position: [10.5, 0, 10.5],
        quaternion: [0, 0, 0, 1],
        tileMovementActive: true,
      },
      node: { quaternion: { copy: vi.fn() } },
    });
    manager.setArrivalEmote(playerId, "fishing_rod", resolver);

    expect(() => manager.processPlayerTick(playerId, 1)).not.toThrow();

    expect(mockSendFn).toHaveBeenCalledWith(
      "tileMovementEnd",
      expect.objectContaining({ id: playerId, emote: "idle" }),
    );
    expect(mockSendFn).toHaveBeenCalledWith(
      "entityModified",
      expect.objectContaining({
        id: playerId,
        changes: expect.objectContaining({ e: "idle" }),
      }),
    );
  });

  it("arbitrates a shared destination without overlapping player tiles", () => {
    const entities = new Map<string, any>();
    const occupancy = new EntityOccupancyMap();
    const sends = vi.fn();
    const world = {
      entities,
      entityOccupancy: occupancy,
      getSystem: vi.fn(() => null),
      collision: {
        hasFlags: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
      },
      emit: vi.fn(),
      faceDirectionManager: { markPlayerMoved: vi.fn() },
    };
    const movement = new TileMovementManager(world as never, sends);
    const addPlayer = (id: string, tileX: number) => {
      const position = {
        x: tileX + 0.5,
        y: 0,
        z: 0.5,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      return movement.syncPlayerPosition(id, position);
    };
    addPlayer("occupancy-a", 0);
    addPlayer("occupancy-b", 2);

    const states = (
      movement as unknown as {
        playerStates: Map<
          string,
          {
            currentTile: { x: number; z: number };
            path: Array<{ x: number; z: number }>;
            pathIndex: number;
            requestedDestination: { x: number; z: number } | null;
          }
        >;
      }
    ).playerStates;
    Object.assign(states.get("occupancy-a")!, {
      path: [{ x: 1, z: 0 }],
      pathIndex: 0,
      requestedDestination: { x: 1, z: 0 },
    });
    Object.assign(states.get("occupancy-b")!, {
      path: [{ x: 1, z: 0 }],
      pathIndex: 0,
      requestedDestination: { x: 1, z: 0 },
    });

    movement.processPlayerTick("occupancy-a", 1);
    movement.processPlayerTick("occupancy-b", 1);

    expect(movement.getCurrentTile("occupancy-a")).toEqual({ x: 1, z: 0 });
    expect(movement.getCurrentTile("occupancy-b")).toEqual({ x: 2, z: 0 });
    expect(occupancy.getOccupant({ x: 1, z: 0 })?.entityId).toBe("occupancy-a");
    expect(occupancy.getOccupant({ x: 2, z: 0 })?.entityId).toBe("occupancy-b");
    expect(sends).toHaveBeenCalledWith(
      "tileMovementEnd",
      expect.objectContaining({
        id: "occupancy-b",
        tile: { x: 2, z: 0 },
        reason: "dynamic_obstruction",
      }),
    );

    Object.assign(states.get("occupancy-a")!, {
      path: [{ x: 0, z: 0 }],
      pathIndex: 0,
      requestedDestination: { x: 0, z: 0 },
    });
    movement.processPlayerTick("occupancy-a", 2);
    movement.processPlayerTick("occupancy-b", 2);

    expect(movement.getCurrentTile("occupancy-a")).toEqual({ x: 0, z: 0 });
    expect(movement.getCurrentTile("occupancy-b")).toEqual({ x: 1, z: 0 });
    expect(occupancy.getStats()).toMatchObject({
      occupiedTileCount: 2,
      trackedEntityCount: 2,
      playerTileCount: 2,
    });
  });

  it("relocates a colliding spawn to the nearest unoccupied tile", () => {
    const entities = new Map<string, any>();
    const occupancy = new EntityOccupancyMap();
    const sends = vi.fn();
    const world = {
      entities,
      entityOccupancy: occupancy,
      getSystem: vi.fn(() => null),
      collision: {
        hasFlags: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
      },
      emit: vi.fn(),
      faceDirectionManager: { markPlayerMoved: vi.fn() },
    };
    const movement = new TileMovementManager(world as never, sends);
    const addPlayer = (id: string) => {
      const position = {
        x: 0.5,
        y: 0,
        z: 0.5,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      return movement.syncPlayerPosition(id, position);
    };

    const firstPosition = addPlayer("spawn-a");
    const secondPosition = addPlayer("spawn-b");

    expect(firstPosition).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(secondPosition).not.toEqual(firstPosition);
    expect(movement.getCurrentTile("spawn-a")).toEqual({ x: 0, z: 0 });
    expect(movement.getCurrentTile("spawn-b")).not.toEqual({ x: 0, z: 0 });
    expect(occupancy.getStats()).toMatchObject({
      occupiedTileCount: 2,
      trackedEntityCount: 2,
      playerTileCount: 2,
    });
    expect(sends).toHaveBeenCalledWith(
      "tileMovementEnd",
      expect.objectContaining({
        id: "spawn-b",
        reason: "occupied_spawn_relocation",
      }),
    );
  });

  it("places 25 simultaneous same-point joins on 25 unique authoritative tiles", () => {
    const entities = new Map<string, any>();
    const occupancy = new EntityOccupancyMap();
    const world = {
      entities,
      entityOccupancy: occupancy,
      getSystem: vi.fn(() => null),
      collision: {
        hasFlags: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
      },
      emit: vi.fn(),
      faceDirectionManager: { markPlayerMoved: vi.fn() },
    };
    const movement = new TileMovementManager(world as never, vi.fn());
    const positions: string[] = [];

    for (let index = 0; index < 25; index++) {
      const id = `crowded-spawn-${index}`;
      const position = {
        x: 0.5,
        y: 0,
        z: 0.5,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      entities.set(id, {
        position,
        data: { position: [position.x, position.y, position.z] },
      });
      const resolved = movement.syncPlayerPosition(id, position);
      positions.push(`${resolved.x},${resolved.z}`);
    }

    expect(new Set(positions).size).toBe(25);
    expect(occupancy.getStats()).toMatchObject({
      occupiedTileCount: 25,
      trackedEntityCount: 25,
      playerTileCount: 25,
    });
  });

  it("reports bounded slow-tick workload context without exposing path data", () => {
    manager.syncPlayerPosition("moving", { x: 10, y: 0, z: 10 });
    manager.syncPlayerPosition("idle", { x: 20, y: 0, z: 20 });

    const movingState = (
      manager as unknown as {
        playerStates: Map<
          string,
          { path: Array<{ x: number; z: number }>; pathIndex: number }
        >;
      }
    ).playerStates.get("moving")!;
    movingState.path = [
      { x: 11, z: 10 },
      { x: 12, z: 10 },
      { x: 13, z: 10 },
    ];
    movingState.pathIndex = 1;

    expect(manager.getPerformanceContext()).toEqual({
      players: 2,
      activePaths: 1,
      queuedPathTiles: 2,
      bfsIterations: 0,
      walkabilityCacheEntries: 0,
      directionalBlockCacheEntries: 0,
      pendingObstructionReplans: 0,
      pendingNonCombatMoves: 0,
      precomputedPathSegments: 0,
      occupiedPlayerTiles: 0,
      occupiedMobTiles: 0,
      trackedOccupants: 0,
    });
  });

  it("starts 25 simultaneous preparation routes without exhausting the shared budget", () => {
    const agentCount = 25;
    const destinationTile = { x: 30, z: 0 };
    const entities = new Map<string, any>();
    const firstStartTick = new Map<string, number>();
    const endEvents: Array<{
      id: string;
      tile: { x: number; z: number };
      emote?: string;
      tick: number;
    }> = [];
    let currentTick = 0;
    let continuationStarts = 0;

    const scenarioWorld = createMockWorld();
    scenarioWorld.entities.get.mockImplementation((id: string) =>
      entities.get(id),
    );
    scenarioWorld.getSystem.mockReturnValue(null);
    const scenarioSend = vi.fn((event: string, payload: any) => {
      if (event === "tileMovementStart") {
        if (!payload.isContinuation && !firstStartTick.has(payload.id)) {
          firstStartTick.set(payload.id, currentTick);
        }
        if (payload.isContinuation) continuationStarts++;

        const segmentEnd = payload.path.at(-1);
        expect(payload.destinationTile).toEqual(segmentEnd);
      }
      if (event === "tileMovementEnd") {
        endEvents.push({
          id: payload.id,
          tile: { ...payload.tile },
          emote: payload.emote,
          tick: currentTick,
        });
      }
    });
    const scenarioManager = new TileMovementManager(
      scenarioWorld as never,
      scenarioSend,
    );

    for (let index = 0; index < agentCount; index++) {
      const id = `preparation-contention-agent-${index}`;
      const position = {
        x: 0.5,
        y: 0,
        z: 0.5,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      scenarioManager.syncPlayerPosition(id, position);
      scenarioManager.setArrivalEmote(id, "banking");
    }

    for (const [id] of entities) {
      scenarioManager.movePlayerToward(
        id,
        { x: destinationTile.x + 0.5, y: 0, z: destinationTile.z + 0.5 },
        false,
      );
    }

    expect(scenarioManager.getPerformanceContext()).toMatchObject({
      pendingNonCombatMoves: 0,
      precomputedPathSegments: 0,
    });
    expect(scenarioManager.getPerformanceContext().bfsIterations).toBeLessThan(
      2_000,
    );

    let completionTick = 0;
    for (currentTick = 1; currentTick <= 80; currentTick++) {
      scenarioManager.onTick(currentTick);
      const everyAgentArrived = [...entities.keys()].every((id) =>
        tilesMatch(scenarioManager.getCurrentTile(id), destinationTile),
      );
      const context = scenarioManager.getPerformanceContext();
      if (
        everyAgentArrived &&
        context.activePaths === 0 &&
        context.pendingNonCombatMoves === 0 &&
        context.precomputedPathSegments === 0
      ) {
        completionTick = currentTick;
        break;
      }
    }

    expect(firstStartTick.size).toBe(agentCount);
    // Production contention SLO: every retained route starts within 6 ticks
    // (3.6s) and all 25 walking agents finish this 30-tile route within 20
    // ticks (12s), including segmented-path scheduling pressure.
    expect(Math.max(...firstStartTick.values())).toBeLessThanOrEqual(6);
    expect(completionTick).toBeGreaterThan(0);
    expect(completionTick).toBeLessThanOrEqual(20);
    expect(continuationStarts).toBe(0);
    expect(scenarioManager.getPerformanceContext()).toMatchObject({
      activePaths: 0,
      pendingNonCombatMoves: 0,
      precomputedPathSegments: 0,
    });

    expect(endEvents).toHaveLength(agentCount);
    for (const event of endEvents) {
      expect(event.tile).toEqual(destinationTile);
      expect(event.emote).toBe("banking");
    }
  });

  it("preserves a look-ahead segment when the planner restates the same route", () => {
    const playerId = "repeated-preparation-route-agent";
    const destinationTile = { x: 30, z: 0 };
    const position = {
      x: 0.5,
      y: 0,
      z: 0.5,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
        tileMovementActive: true,
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );
    mockWorld.getSystem.mockReturnValue(null);

    const movementEnds: any[] = [];
    mockSendFn.mockImplementation((event: string, payload: any) => {
      if (event === "tileMovementStart") {
        expect(payload.destinationTile).toEqual(payload.path.at(-1));
      }
      if (event === "tileMovementEnd") movementEnds.push(payload);
    });
    manager.syncPlayerPosition(playerId, position);
    const resolveAtArrival = vi.fn(() => "banking");
    manager.setArrivalEmote(playerId, "stale-banking", resolveAtArrival);

    const state = (
      manager as unknown as {
        playerStates: Map<
          string,
          {
            path: Array<{ x: number; z: number }>;
            pathIndex: number;
            isRunning: boolean;
            lastPathPartial: boolean;
            requestedDestination: { x: number; z: number } | null;
          }
        >;
      }
    ).playerStates.get(playerId)!;
    state.path = [
      { x: 1, z: 0 },
      { x: 2, z: 0 },
      { x: 3, z: 0 },
    ];
    state.pathIndex = 0;
    state.isRunning = false;
    state.lastPathPartial = true;
    state.requestedDestination = destinationTile;

    manager.onTick(1);
    expect(manager.getPerformanceContext().precomputedPathSegments).toBe(1);
    const startsBeforeRestatement = mockSendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "tileMovementStart",
    ).length;

    manager.movePlayerToward(
      playerId,
      { x: destinationTile.x + 0.5, y: 0, z: destinationTile.z + 0.5 },
      false,
    );

    expect(manager.getPerformanceContext().precomputedPathSegments).toBe(1);
    expect(
      mockSendFn.mock.calls.filter(
        (call: unknown[]) => call[0] === "tileMovementStart",
      ),
    ).toHaveLength(startsBeforeRestatement);

    for (let tick = 2; tick <= 20; tick++) {
      manager.onTick(tick);
      if (tilesMatch(manager.getCurrentTile(playerId), destinationTile)) break;
    }

    expect(manager.getCurrentTile(playerId)).toEqual(destinationTile);
    expect(manager.getPerformanceContext()).toMatchObject({
      activePaths: 0,
      pendingNonCombatMoves: 0,
      precomputedPathSegments: 0,
    });
    expect(movementEnds).toHaveLength(1);
    expect(resolveAtArrival).toHaveBeenCalledOnce();
    expect(movementEnds[0]).toMatchObject({
      id: playerId,
      tile: destinationTile,
      emote: "banking",
    });
  });

  it("cancels retained non-combat movement intents on stop, sync, and cleanup", () => {
    const playerId = "queued-preparation-agent";
    const position = {
      x: 0.5,
      y: 0,
      z: 0.5,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );
    mockWorld.getSystem.mockReturnValue(null);
    manager.syncPlayerPosition(playerId, position);

    const exhaustBudget = () => {
      (
        manager as unknown as { _bfsIterationsThisTick: number }
      )._bfsIterationsThisTick = 12_000;
    };
    const queueMove = () => {
      manager.movePlayerToward(playerId, { x: 30.5, y: 0, z: 0.5 }, false);
      expect(manager.getPerformanceContext().pendingNonCombatMoves).toBe(1);
    };

    exhaustBudget();
    queueMove();
    manager.stopPlayer(playerId);
    expect(manager.getPerformanceContext().pendingNonCombatMoves).toBe(0);

    exhaustBudget();
    queueMove();
    manager.syncPlayerPosition(playerId, position);
    expect(manager.getPerformanceContext().pendingNonCombatMoves).toBe(0);

    exhaustBudget();
    queueMove();
    manager.cleanup(playerId);
    expect(manager.getPerformanceContext()).toMatchObject({
      players: 0,
      pendingNonCombatMoves: 0,
      precomputedPathSegments: 0,
    });
  });

  it("takes the first server-controlled step after a fresh position sync", () => {
    const playerId = "fresh-arena-agent";
    const position = {
      x: 10.5,
      y: 0,
      z: 10.5,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
        isEmbeddedAgent: true,
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );

    manager.syncPlayerPosition(playerId, position);
    manager.movePlayerToward(playerId, { x: 11.5, y: 0, z: 10.5 }, false);

    expect(() => manager.processPlayerTick(playerId, 1)).not.toThrow();
    expect(manager.getCurrentTile(playerId)).toEqual({ x: 11, z: 10 });
    expect(manager.getPreviousTile(playerId)).toEqual({ x: 10, z: 10 });
  });

  it("keeps streaming duel contestants from entering the opponent's tick-start tile", () => {
    const entities = new Map<string, any>();
    const scenarioWorld = createMockWorld();
    scenarioWorld.getSystem.mockReturnValue(null);
    scenarioWorld.entities.get.mockImplementation((id: string) =>
      entities.get(id),
    );
    const scenarioManager = new TileMovementManager(
      scenarioWorld as never,
      vi.fn(),
    );
    const createDueler = (
      id: string,
      opponentId: string,
      x: number,
      z: number,
    ) => {
      const position = {
        x: x + 0.5,
        y: 0,
        z: z + 0.5,
        set(nextX: number, nextY: number, nextZ: number) {
          this.x = nextX;
          this.y = nextY;
          this.z = nextZ;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
          inStreamingDuel: true,
          duelAiControlsMovement: true,
          streamingDuelOpponentId: opponentId,
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      scenarioManager.syncPlayerPosition(id, position);
    };

    createDueler("melee", "mage", 347, 414);
    createDueler("mage", "melee", 346, 415);

    const states = (
      scenarioManager as unknown as {
        playerStates: Map<
          string,
          {
            path: Array<{ x: number; z: number }>;
            pathIndex: number;
            previousTile: { x: number; z: number } | null;
            isRunning: boolean;
          }
        >;
      }
    ).playerStates;
    Object.assign(states.get("melee")!, {
      path: [{ x: 346, z: 415 }],
      pathIndex: 0,
      previousTile: { x: 347, z: 414 },
      isRunning: false,
    });
    Object.assign(states.get("mage")!, {
      path: [
        { x: 347, z: 415 },
        { x: 348, z: 415 },
      ],
      pathIndex: 0,
      previousTile: { x: 346, z: 415 },
      isRunning: true,
    });

    scenarioManager.onTick(1);

    expect(scenarioManager.getCurrentTile("melee")).toEqual({
      x: 347,
      z: 414,
    });
    expect(scenarioManager.getCurrentTile("mage")).toEqual({
      x: 348,
      z: 415,
    });
  });

  it("cancels a conflicting duel path before broadcasting both actors through each other", () => {
    const entities = new Map<string, any>();
    const scenarioWorld = createMockWorld();
    scenarioWorld.getSystem.mockReturnValue(null);
    scenarioWorld.entities.get.mockImplementation((id: string) =>
      entities.get(id),
    );
    const scenarioSend = vi.fn();
    const scenarioManager = new TileMovementManager(
      scenarioWorld as never,
      scenarioSend,
    );
    const addDueler = (
      id: string,
      opponentId: string,
      tile: { x: number; z: number },
    ) => {
      const position = {
        x: tile.x + 0.5,
        y: 0,
        z: tile.z + 0.5,
        set(nextX: number, nextY: number, nextZ: number) {
          this.x = nextX;
          this.y = nextY;
          this.z = nextZ;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
          inStreamingDuel: true,
          duelAiControlsMovement: true,
          streamingDuelOpponentId: opponentId,
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      scenarioManager.syncPlayerPosition(id, position);
    };

    addDueler("melee", "mage", { x: 347, z: 414 });
    addDueler("mage", "melee", { x: 346, z: 415 });
    scenarioManager.movePlayerToward(
      "melee",
      { x: 346.5, y: 0, z: 415.5 },
      false,
    );
    scenarioManager.movePlayerToward(
      "mage",
      { x: 348.5, y: 0, z: 415.5 },
      true,
    );

    expect(scenarioManager.getPlayerMovementDebug("melee").activePath).toBe(
      false,
    );
    expect(scenarioManager.getPlayerMovementDebug("mage").activePath).toBe(
      true,
    );
    const movementEvents = scenarioSend.mock.calls
      .filter(([event]) =>
        ["tileMovementStart", "tileMovementEnd"].includes(event),
      )
      .map(([event, payload]) => ({ event, id: payload.id }));
    expect(movementEvents).toEqual([
      { event: "tileMovementStart", id: "mage" },
    ]);
  });

  it("replaces an already-broadcast diagonal crossing with one deterministic duel path", () => {
    const entities = new Map<string, any>();
    const scenarioWorld = createMockWorld();
    scenarioWorld.getSystem.mockReturnValue(null);
    scenarioWorld.entities.get.mockImplementation((id: string) =>
      entities.get(id),
    );
    const scenarioSend = vi.fn();
    const scenarioManager = new TileMovementManager(
      scenarioWorld as never,
      scenarioSend,
    );
    const addDueler = (
      id: string,
      opponentId: string,
      tile: { x: number; z: number },
    ) => {
      const position = {
        x: tile.x + 0.5,
        y: 0,
        z: tile.z + 0.5,
        set(nextX: number, nextY: number, nextZ: number) {
          this.x = nextX;
          this.y = nextY;
          this.z = nextZ;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
          inStreamingDuel: true,
          duelAiControlsMovement: true,
          streamingDuelOpponentId: opponentId,
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      scenarioManager.syncPlayerPosition(id, position);
    };

    addDueler("alpha", "beta", { x: 0, z: 0 });
    addDueler("beta", "alpha", { x: 1, z: 0 });
    scenarioManager.movePlayerToward("beta", { x: 0.5, y: 0, z: 1.5 }, false);
    scenarioManager.movePlayerToward("alpha", { x: 1.5, y: 0, z: 1.5 }, false);

    expect(scenarioManager.getPlayerMovementDebug("alpha").activePath).toBe(
      true,
    );
    expect(scenarioManager.getPlayerMovementDebug("beta").activePath).toBe(
      false,
    );
    const movementEvents = scenarioSend.mock.calls
      .filter(([event]) =>
        ["tileMovementStart", "tileMovementEnd"].includes(event),
      )
      .map(([event, payload]) => ({ event, id: payload.id }));
    expect(movementEvents).toEqual([
      { event: "tileMovementStart", id: "beta" },
      { event: "tileMovementEnd", id: "beta" },
      { event: "tileMovementStart", id: "alpha" },
    ]);
  });

  it("deterministically yields one streaming dueler when diagonal paths cross", () => {
    const entities = new Map<string, any>();
    const scenarioWorld = createMockWorld();
    scenarioWorld.getSystem.mockReturnValue(null);
    scenarioWorld.entities.get.mockImplementation((id: string) =>
      entities.get(id),
    );
    const scenarioManager = new TileMovementManager(
      scenarioWorld as never,
      vi.fn(),
    );
    const addDueler = (
      id: string,
      opponentId: string,
      tile: { x: number; z: number },
      nextTile: { x: number; z: number },
    ) => {
      const position = {
        x: tile.x + 0.5,
        y: 0,
        z: tile.z + 0.5,
        set(nextX: number, nextY: number, nextZ: number) {
          this.x = nextX;
          this.y = nextY;
          this.z = nextZ;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
          inStreamingDuel: true,
          duelAiControlsMovement: true,
          streamingDuelOpponentId: opponentId,
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      scenarioManager.syncPlayerPosition(id, position);
      const state = (
        scenarioManager as unknown as {
          playerStates: Map<
            string,
            {
              path: Array<{ x: number; z: number }>;
              pathIndex: number;
              previousTile: { x: number; z: number } | null;
              isRunning: boolean;
            }
          >;
        }
      ).playerStates.get(id)!;
      Object.assign(state, {
        path: [nextTile],
        pathIndex: 0,
        previousTile: { ...tile },
        isRunning: false,
      });
    };

    addDueler("alpha", "beta", { x: 0, z: 0 }, { x: 1, z: 1 });
    addDueler("beta", "alpha", { x: 1, z: 0 }, { x: 0, z: 1 });

    scenarioManager.onTick(1);

    expect(scenarioManager.getCurrentTile("alpha")).toEqual({ x: 1, z: 1 });
    expect(scenarioManager.getCurrentTile("beta")).toEqual({ x: 1, z: 0 });
  });

  it("clamps every server-controlled movement target inside duel arena bounds", () => {
    const playerId = "arena-agent";
    const entity = {
      position: { x: 350.5, y: 0, z: 406.5 },
      data: {
        position: [350.5, 0, 406.5],
        quaternion: [0, 0, 0, 1],
        arenaBounds: { minX: 340, maxX: 360, minZ: 394, maxZ: 418 },
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockReturnValue(entity);
    mockWorld.getSystem.mockReturnValue(null);
    manager.syncPlayerPosition(playerId, entity.position);

    manager.movePlayerToward(playerId, { x: 10_000, y: 0, z: -10_000 }, true);

    const movement = manager.getPlayerMovementDebug(playerId);
    expect(movement.activePath).toBe(true);
    expect(movement.destinationTile).toEqual({ x: 358, z: 396 });
    expect(mockSendFn).toHaveBeenCalledWith(
      "tileMovementStart",
      expect.objectContaining({
        id: playerId,
        destinationTile: { x: 358, z: 396 },
      }),
    );
  });

  it("replans before taking a path step that became blocked", () => {
    const playerId = "preparation-agent";
    const position = {
      x: 0.5,
      y: 0,
      z: 0.5,
      set: vi.fn((x: number, y: number, z: number) => {
        position.x = x;
        position.y = y;
        position.z = z;
      }),
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );
    mockWorld.getSystem.mockReturnValue(null);

    let obstructionEnabled = false;
    mockWorld.collision.hasFlags.mockImplementation(
      (x: number, z: number) => obstructionEnabled && x === 1 && z === 0,
    );

    manager.syncPlayerPosition(playerId, position);
    manager.movePlayerToward(playerId, { x: 4.5, y: 0, z: 0.5 }, false);
    obstructionEnabled = true;

    manager.onTick(1);

    expect(manager.getCurrentTile(playerId)).toEqual({ x: 0, z: 0 });
    expect(manager.getPerformanceContext().pendingObstructionReplans).toBe(1);

    manager.onTick(2);

    expect(manager.getCurrentTile(playerId)).not.toEqual({ x: 1, z: 0 });
    expect(manager.getCurrentTile(playerId)).not.toEqual({ x: 0, z: 0 });
    expect(manager.getPerformanceContext().pendingObstructionReplans).toBe(0);
    expect(
      mockSendFn.mock.calls.filter(
        (call: unknown[]) => call[0] === "tileMovementStart",
      ),
    ).toHaveLength(2);
  });

  it("recovers across a deterministic randomized obstruction matrix", () => {
    let seed = 0x5eed1234;
    const nextRandom = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let scenario = 0; scenario < 16; scenario++) {
      const scenarioWorld = createMockWorld();
      const scenarioSend = vi.fn();
      const scenarioManager = new TileMovementManager(
        scenarioWorld as never,
        scenarioSend,
      );
      const playerId = `randomized-preparation-agent-${scenario}`;
      const position = {
        x: 0.5,
        y: 0,
        z: 0.5,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      const entity = {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
        },
        node: { quaternion: { copy: vi.fn() } },
      };
      scenarioWorld.entities.get.mockImplementation((id: string) =>
        id === playerId ? entity : null,
      );
      scenarioWorld.getSystem.mockReturnValue(null);

      const angle = nextRandom() * Math.PI * 2;
      const radius = 5 + Math.floor(nextRandom() * 4);
      const targetX = Math.round(Math.cos(angle) * radius);
      const targetZ = Math.round(Math.sin(angle) * radius);
      scenarioManager.syncPlayerPosition(playerId, position);
      scenarioManager.movePlayerToward(
        playerId,
        { x: targetX + 0.5, y: 0, z: targetZ + 0.5 },
        false,
      );

      const state = (
        scenarioManager as unknown as {
          playerStates: Map<
            string,
            {
              path: Array<{ x: number; z: number }>;
            }
          >;
        }
      ).playerStates.get(playerId)!;
      const obstructedStep = { ...state.path[0] };
      scenarioWorld.collision.hasFlags.mockImplementation(
        (x: number, z: number) =>
          x === obstructedStep.x && z === obstructedStep.z,
      );

      scenarioManager.onTick(1);
      scenarioManager.onTick(2);

      expect(scenarioManager.getCurrentTile(playerId)).not.toEqual(
        obstructedStep,
      );
      expect(
        scenarioManager.getPerformanceContext().pendingObstructionReplans,
      ).toBe(0);
      expect(
        scenarioSend.mock.calls.filter(
          (call: unknown[]) => call[0] === "tileMovementStart",
        ),
      ).toHaveLength(2);
    }
  });

  it("abandons an enclosed dynamic obstruction after three bounded replans", () => {
    const playerId = "enclosed-preparation-agent";
    const position = {
      x: 0.5,
      y: 0,
      z: 0.5,
      set: vi.fn((x: number, y: number, z: number) => {
        position.x = x;
        position.y = y;
        position.z = z;
      }),
    };
    const entity = {
      position,
      data: {
        position: [position.x, position.y, position.z],
        quaternion: [0, 0, 0, 1],
      },
      node: { quaternion: { copy: vi.fn() } },
    };
    mockWorld.entities.get.mockImplementation((id: string) =>
      id === playerId ? entity : null,
    );
    mockWorld.getSystem.mockReturnValue(null);

    let enclosed = false;
    mockWorld.collision.hasFlags.mockImplementation(
      (x: number, z: number) => enclosed && (x !== 0 || z !== 0),
    );

    manager.syncPlayerPosition(playerId, position);
    manager.movePlayerToward(playerId, { x: 4.5, y: 0, z: 0.5 }, false);
    enclosed = true;

    manager.onTick(1);
    expect(manager.getPerformanceContext().pendingObstructionReplans).toBe(1);

    manager.onTick(2);
    manager.onTick(3);
    manager.onTick(4);

    expect(manager.getCurrentTile(playerId)).toEqual({ x: 0, z: 0 });
    expect(manager.getPerformanceContext().pendingObstructionReplans).toBe(0);
    expect(
      mockSendFn.mock.calls.filter(
        (call: unknown[]) => call[0] === "tileMovementStart",
      ),
    ).toHaveLength(1);
  });

  it("queues and cycles 25 agents through the saturated production range boundary", () => {
    stationDataProvider.loadStations(stationsManifest);
    stationDataProvider.loadModelBounds(modelBoundsManifest);
    const footprint = resolveFootprint(
      stationDataProvider.getFootprint("range"),
    );
    expect(footprint).toEqual({ x: 2, z: 1 });

    const rangePlacement =
      worldAreasManifest.starterTowns.central_haven.stations.find(
        (station) => station.type === "range",
      );
    expect(rangePlacement).toBeDefined();
    const stationId = rangePlacement!.id;
    const stationPosition = rangePlacement!.position;
    const centerTile = {
      x: Math.floor(stationPosition.x),
      z: Math.floor(stationPosition.z),
    };
    const footprintMinX = centerTile.x - Math.floor(footprint.x / 2);
    const footprintMaxX = footprintMinX + footprint.x - 1;
    const footprintMinZ = centerTile.z - Math.floor(footprint.z / 2);
    const footprintMaxZ = footprintMinZ + footprint.z - 1;

    const entities = new Map<string, any>();
    const occupancy = new EntityOccupancyMap();
    const blockedFootprint = new Set<string>();
    for (let x = footprintMinX; x <= footprintMaxX; x++) {
      for (let z = footprintMinZ; z <= footprintMaxZ; z++) {
        blockedFootprint.add(`${x},${z}`);
      }
    }
    entities.set(stationId, {
      entityType: "range",
      position: stationPosition,
      canInteract: (_playerId: string, position: { x: number; z: number }) => {
        const tileX = Math.floor(position.x);
        const tileZ = Math.floor(position.z);
        if (blockedFootprint.has(`${tileX},${tileZ}`)) return false;
        const dx =
          tileX < footprintMinX
            ? footprintMinX - tileX
            : Math.max(0, tileX - footprintMaxX);
        const dz =
          tileZ < footprintMinZ
            ? footprintMinZ - tileZ
            : Math.max(0, tileZ - footprintMaxZ);
        return Math.max(dx, dz) <= 1;
      },
    });
    const world = {
      entities,
      getPlayer: (id: string) => entities.get(id),
      entityOccupancy: occupancy,
      getSystem: vi.fn(() => null),
      collision: {
        hasFlags: vi.fn((x: number, z: number) =>
          blockedFootprint.has(`${x},${z}`),
        ),
        isBlocked: vi.fn(() => false),
      },
      emit: vi.fn(),
      faceDirectionManager: { markPlayerMoved: vi.fn() },
    };
    const movement = new TileMovementManager(world as never, vi.fn());
    const startTiles: Array<{ x: number; z: number }> = [];
    for (let x = centerTile.x - 7; x <= centerTile.x + 7; x++) {
      startTiles.push({ x, z: centerTile.z - 7 });
    }
    for (let x = centerTile.x - 7; x <= centerTile.x + 2; x++) {
      startTiles.push({ x, z: centerTile.z + 7 });
    }

    for (let index = 0; index < 25; index++) {
      const id = `preparation-agent-${index}`;
      const start = startTiles[index];
      const position = {
        x: start.x + 0.5,
        y: 0,
        z: start.z + 0.5,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      entities.set(id, {
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
          isEmbeddedAgent: true,
        },
        node: { quaternion: { copy: vi.fn() } },
      });
      movement.syncPlayerPosition(id, position);
      movement.movePlayerToward(id, stationPosition, true, 0, undefined, {
        interactionRange: 1,
        footprintWidth: footprint.x,
        footprintDepth: footprint.z,
      });
    }

    const arrived = new Set<string>();
    const arrivalTickByAgent = new Map<string, number>();
    for (let tick = 1; tick <= 40 && arrived.size < 25; tick++) {
      movement.onTick(tick);
      const currentTiles: string[] = [];
      for (let index = 0; index < 25; index++) {
        const id = `preparation-agent-${index}`;
        const tile = movement.getCurrentTile(id)!;
        currentTiles.push(`${tile.x},${tile.z}`);
        expect(blockedFootprint.has(`${tile.x},${tile.z}`)).toBe(false);
        const dx =
          tile.x < footprintMinX
            ? footprintMinX - tile.x
            : Math.max(0, tile.x - footprintMaxX);
        const dz =
          tile.z < footprintMinZ
            ? footprintMinZ - tile.z
            : Math.max(0, tile.z - footprintMaxZ);
        if (!arrived.has(id) && Math.max(dx, dz) <= 1) {
          expect(canPlayerPerformPreparationAction(world as never, id)).toBe(
            true,
          );
          expect(
            entities.get(stationId).canInteract(id, entities.get(id).position),
          ).toBe(true);
          arrived.add(id);
          arrivalTickByAgent.set(id, tick);
          const start = startTiles[index];
          movement.movePlayerToward(
            id,
            { x: start.x + 0.5, y: 0, z: start.z + 0.5 },
            true,
          );
        }
      }
      expect(new Set(currentTiles).size).toBe(25);
    }

    expect(arrived.size).toBe(25);
    expect(arrivalTickByAgent.size).toBe(25);
    expect(Math.max(...arrivalTickByAgent.values())).toBeLessThanOrEqual(40);
    expect(movement.getPerformanceContext().occupiedPlayerTiles).toBe(25);
  });
});

function tilesMatch(
  actual: { x: number; z: number } | null,
  expected: { x: number; z: number },
): boolean {
  return actual?.x === expected.x && actual.z === expected.z;
}
