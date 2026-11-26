import {
  EntityOccupancyMap,
  EventType,
  type TileCoord,
} from "@hyperforge/shared";
import { describe, expect, it, vi } from "vitest";

import { PendingGatherManager } from "../PendingGatherManager";
import { TileMovementManager } from "../tile-movement";

type TestEntity = {
  id: string;
  position: {
    x: number;
    y: number;
    z: number;
    set: (x: number, y: number, z: number) => void;
  };
  data: Record<string, unknown>;
  node: { quaternion: { copy: ReturnType<typeof vi.fn> } };
  skills: Record<string, { level: number; xp: number }>;
};

type TestResource = {
  id: string;
  position: { x: number; y: number; z: number };
  isAvailable: boolean;
  skillRequired: "woodcutting" | "mining" | "fishing";
  levelRequired: number;
  type: "tree" | "ore" | "fishing_spot";
  footprint: "standard";
};

describe("preparation resource physical occupancy", () => {
  it("routes 25 agents to distinct approaches across mixed live node types", () => {
    const resources: TestResource[] = [
      ["tree-mixed-a", 0, 0, "woodcutting", "tree"],
      ["ore-mixed-a", 15, 0, "mining", "ore"],
      ["tree-mixed-b", 30, 0, "woodcutting", "tree"],
      ["ore-mixed-b", 0, 20, "mining", "ore"],
      ["fish-mixed-a", 15, 20, "fishing", "fishing_spot"],
      ["tree-mixed-c", 30, 20, "woodcutting", "tree"],
      ["fish-mixed-b", 45, 20, "fishing", "fishing_spot"],
    ].map(([id, x, z, skillRequired, type]) => ({
      id: String(id),
      position: { x: Number(x) + 0.5, y: 0, z: Number(z) + 0.5 },
      isAvailable: true,
      skillRequired: skillRequired as TestResource["skillRequired"],
      levelRequired: 1,
      type: type as TestResource["type"],
      footprint: "standard",
    }));
    const resourceById = new Map(
      resources.map((resource) => [resource.id, resource]),
    );
    const fishingWaterTiles = new Set(
      resources
        .filter((resource) => resource.skillRequired === "fishing")
        .map(
          (resource) =>
            `${Math.floor(resource.position.x)},${Math.floor(resource.position.z)}`,
        ),
    );
    const entities = new Map<string, TestEntity>();
    const occupancy = new EntityOccupancyMap();
    const gatherEvents: Array<{
      playerId: string;
      resourceId: string;
      tile: TileCoord;
    }> = [];

    const world = {
      isServer: true,
      currentTick: 0,
      entities,
      entityOccupancy: occupancy,
      collision: {
        hasFlags: vi.fn((x: number, z: number) =>
          fishingWaterTiles.has(`${x},${z}`),
        ),
        isBlocked: vi.fn(() => false),
      },
      getPlayer: vi.fn((id: string) => entities.get(id)),
      getSystem: vi.fn((name: string) => {
        if (name === "resource") {
          return {
            getResource: (id: string) => resourceById.get(id) ?? null,
            playerHasRequiredToolForResource: () => true,
            isPlayerGatheringResource: () => false,
          };
        }
        return null;
      }),
      emit: vi.fn((event: string, payload: unknown) => {
        if (event !== EventType.RESOURCE_GATHER) return;
        const data = payload as { playerId: string; resourceId: string };
        const tile = movement.getCurrentTile(data.playerId);
        if (!tile)
          throw new Error("gather emitted without an authoritative tile");
        gatherEvents.push({
          playerId: data.playerId,
          resourceId: data.resourceId,
          tile: { ...tile },
        });
      }),
      faceDirectionManager: {
        markPlayerMoved: vi.fn(),
        setCardinalFaceTarget: vi.fn(),
      },
    };
    const movement = new TileMovementManager(world as never, vi.fn());
    const pending = new PendingGatherManager(world as never, movement, vi.fn());

    for (let index = 0; index < 25; index++) {
      const resource = resources[index % resources.length];
      const lane = Math.floor(index / resources.length);
      const startX = Math.floor(resource.position.x) - 7 + lane;
      const startZ = Math.floor(resource.position.z) - 7 - lane;
      const id = `mixed-resource-agent-${index.toString().padStart(2, "0")}`;
      const position = {
        x: startX + 0.5,
        y: 0,
        z: startZ + 0.5,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      const entity: TestEntity = {
        id,
        position,
        data: {
          position: [position.x, position.y, position.z],
          quaternion: [0, 0, 0, 1],
          isEmbeddedAgent: true,
        },
        node: { quaternion: { copy: vi.fn() } },
        skills: {
          woodcutting: { level: 1, xp: 0 },
          mining: { level: 1, xp: 0 },
          fishing: { level: 1, xp: 0 },
        },
      };
      entities.set(id, entity);
      movement.syncPlayerPosition(id, position);
      expect(pending.queuePendingGather(id, resource.id, 0, true)).toBe(true);
    }

    expect(occupancy.getStats()).toMatchObject({
      trackedEntityCount: 25,
      playerTileCount: 25,
    });

    for (let tick = 1; tick <= 40 && gatherEvents.length < 25; tick++) {
      world.currentTick = tick;
      movement.onTick(tick);
      pending.processTick(tick);
      expect(occupancy.getStats()).toMatchObject({
        occupiedTileCount: 25,
        trackedEntityCount: 25,
        playerTileCount: 25,
      });
    }

    expect(gatherEvents).toHaveLength(25);
    expect(new Set(gatherEvents.map((event) => event.playerId)).size).toBe(25);
    expect(
      new Set(gatherEvents.map((event) => `${event.tile.x},${event.tile.z}`))
        .size,
    ).toBe(25);
    expect(
      new Set(
        gatherEvents.map(
          (event) => resourceById.get(event.resourceId)?.skillRequired,
        ),
      ),
    ).toEqual(new Set(["woodcutting", "mining", "fishing"]));
  });
});
