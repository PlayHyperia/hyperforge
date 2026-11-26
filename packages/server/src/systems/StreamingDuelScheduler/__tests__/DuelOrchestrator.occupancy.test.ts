import {
  DataManager,
  EntityOccupancyMap,
  createEntityID,
  getDuelArenaConfig,
  isPositionInsideCombatArena,
  worldToTile,
} from "@hyperforge/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TileMovementManager } from "../../ServerNetwork/tile-movement";
import { DuelOrchestrator } from "../managers/DuelOrchestrator";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

type TestEntity = {
  position: {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
  };
  data: Record<string, unknown>;
};

function streamingCombatMarks(): readonly [
  [number, number, number],
  [number, number, number],
] {
  const config = getDuelArenaConfig();
  const centerX = config.baseX + config.arenaWidth / 2;
  const centerZ = config.baseZ + config.arenaLength / 2;
  const centerTileX = Math.floor(centerX) + 0.5;
  const centerTileZ = Math.floor(centerZ) + 0.5;
  const boundaryX = Math.round(centerX);
  const boundaryZ = Math.round(centerZ);

  if (config.spawnLayout === "alongWidth") {
    return [
      [boundaryX - 0.65, config.baseY, centerTileZ],
      [boundaryX + 0.65, config.baseY, centerTileZ],
    ];
  }
  return [
    [centerTileX, config.baseY, boundaryZ - 0.65],
    [centerTileX, config.baseY, boundaryZ + 0.65],
  ];
}

function createPopulationHarness() {
  const occupancy = new EntityOccupancyMap();
  const entities = new Map<string, TestEntity>();
  const makeEntity = (x: number, z: number): TestEntity => {
    const position = {
      x,
      y: 0,
      z,
      set(nextX: number, nextY: number, nextZ: number): void {
        this.x = nextX;
        this.y = nextY;
        this.z = nextZ;
      },
    };
    return {
      position,
      data: {
        position: [x, 0, z],
        health: 10,
        maxHealth: 10,
        alive: true,
      },
    };
  };

  let movement: TileMovementManager;
  const emit = vi.fn(
    (event: string, payload: { playerId?: string; position?: unknown }) => {
      if (
        event !== "player:teleport" ||
        !payload.playerId ||
        !payload.position ||
        typeof payload.position !== "object"
      ) {
        return;
      }
      const position = payload.position as {
        x: number;
        y: number;
        z: number;
      };
      movement.cleanup(payload.playerId);
      movement.syncPlayerPosition(payload.playerId, position);
    },
  );
  const world = {
    entities,
    entityOccupancy: occupancy,
    emit,
    getSystem: () => null,
    collision: {
      hasFlags: () => false,
      isBlocked: () => false,
    },
    faceDirectionManager: { markPlayerMoved: vi.fn() },
  };
  movement = new TileMovementManager(world as never, vi.fn());
  const orchestrator = new DuelOrchestrator(
    world as never,
    () => null,
    () => {},
    () => new Map(),
    () => {},
    () => {},
    () => [],
    () => [],
  );

  const addPlayer = (id: string, x: number, z: number): void => {
    const entity = makeEntity(x, z);
    entities.set(id, entity);
    movement.syncPlayerPosition(id, entity.position);
  };

  return { occupancy, entities, emit, movement, orchestrator, addPlayer };
}

function assertUniquePlayerOccupancy(
  entities: Map<string, TestEntity>,
  occupancy: EntityOccupancyMap,
): void {
  const occupied = new Set<string>();
  for (const [id, entity] of entities) {
    const tile = worldToTile(entity.position.x, entity.position.z);
    occupied.add(`${tile.x},${tile.z}`);
    expect(String(occupancy.getOccupant(tile)?.entityId)).toBe(id);
  }
  expect(occupied.size).toBe(entities.size);
  expect(occupancy.getStats()).toMatchObject({
    occupiedTileCount: entities.size,
    trackedEntityCount: entities.size,
    playerTileCount: entities.size,
    mobTileCount: 0,
  });
}

describe("DuelOrchestrator production-population occupancy", () => {
  it("keeps 25 agents unique through 100 obstructed ingress/recovery cycles", () => {
    const harness = createPopulationHarness();
    const ids = Array.from({ length: 25 }, (_, index) => `agent-${index}`);
    for (let index = 0; index < ids.length; index++) {
      harness.addPlayer(
        ids[index],
        319.5 + (index % 5) * 3,
        289.5 + Math.floor(index / 5) * 3,
      );
    }
    assertUniquePlayerOccupancy(harness.entities, harness.occupancy);

    const marks = streamingCombatMarks();
    const markTiles = marks.map(([x, , z]) => worldToTile(x, z));
    const restore = (
      harness.orchestrator as unknown as {
        restoreCycleContestants(
          cycle: {
            agent1: {
              characterId: string;
              originalPosition: [number, number, number];
            };
            agent2: {
              characterId: string;
              originalPosition: [number, number, number];
            };
          },
          suppressEffect: boolean,
        ): void;
      }
    ).restoreCycleContestants.bind(harness.orchestrator);

    for (let cycle = 0; cycle < 100; cycle++) {
      const agent1Id = ids[cycle % ids.length];
      const agent2Id = ids[(cycle + 7) % ids.length];
      const bystanderId = ids[(cycle + 13) % ids.length];
      const agent1 = harness.entities.get(agent1Id)!;
      const agent2 = harness.entities.get(agent2Id)!;
      const original1: [number, number, number] = [
        agent1.position.x,
        agent1.position.y,
        agent1.position.z,
      ];
      const original2: [number, number, number] = [
        agent2.position.x,
        agent2.position.y,
        agent2.position.z,
      ];

      // Force one real non-contestant onto a combat mark before every ingress.
      harness.emit("player:teleport", {
        playerId: bystanderId,
        position: { x: marks[0][0], y: marks[0][1], z: marks[0][2] },
      });
      expect(
        String(harness.occupancy.getOccupant(markTiles[0])?.entityId),
      ).toBe(bystanderId);

      harness.orchestrator.teleportToCombatPositions(agent1Id, agent2Id);
      expect(
        String(harness.occupancy.getOccupant(markTiles[0])?.entityId),
      ).toBe(agent1Id);
      expect(
        String(harness.occupancy.getOccupant(markTiles[1])?.entityId),
      ).toBe(agent2Id);
      assertUniquePlayerOccupancy(harness.entities, harness.occupancy);

      restore(
        {
          agent1: { characterId: agent1Id, originalPosition: original1 },
          agent2: { characterId: agent2Id, originalPosition: original2 },
        },
        true,
      );
      for (const id of [agent1Id, agent2Id]) {
        const position = harness.entities.get(id)!.position;
        expect(isPositionInsideCombatArena(position.x, position.z)).toBe(false);
      }
      assertUniquePlayerOccupancy(harness.entities, harness.occupancy);
    }
  });

  it("refuses ingress without disturbing contestants when a live mob owns a mark", () => {
    const harness = createPopulationHarness();
    harness.addPlayer("agent-a", 350.5, 320.5);
    harness.addPlayer("agent-b", 351.5, 320.5);
    const marks = streamingCombatMarks();
    const blockedMark = worldToTile(marks[0][0], marks[0][2]);
    harness.entities.set("arena-mob", {
      position: {
        x: marks[0][0],
        y: marks[0][1],
        z: marks[0][2],
        set() {},
      },
      data: {},
    });
    harness.occupancy.occupy(
      createEntityID("arena-mob"),
      [blockedMark],
      1,
      "mob",
      false,
    );

    expect(() =>
      harness.orchestrator.teleportToCombatPositions("agent-a", "agent-b"),
    ).toThrow("streaming_arena_mark_occupied_by_live_mob");
    expect(
      String(harness.occupancy.getOccupant({ x: 350, z: 320 })?.entityId),
    ).toBe("agent-a");
    expect(
      String(harness.occupancy.getOccupant({ x: 351, z: 320 })?.entityId),
    ).toBe("agent-b");
    expect(String(harness.occupancy.getOccupant(blockedMark)?.entityId)).toBe(
      "arena-mob",
    );
  });
});
