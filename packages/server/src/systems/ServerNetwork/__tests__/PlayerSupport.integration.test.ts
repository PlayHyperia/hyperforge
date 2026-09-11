import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DataManager,
  World,
  TerrainSystem,
  TownSystem,
  PlayerEntity,
  resolvePlayerRootHeight,
  PLAYER_ROOT_CLEARANCE,
  getDuelArenaConfig,
  type BuildingCollisionService,
  type EntityID,
} from "@hyperforge/shared";
import type { BuildingLayoutInput } from "../../../../../shared/src/types/world/building-collision-types";
import { EmbeddedHyperiaService } from "../../../eliza/EmbeddedHyperiaService";
import { TileMovementManager } from "../tile-movement";
import { DuelOrchestrator } from "../../StreamingDuelScheduler/managers/DuelOrchestrator";

class CpuServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}
const worlds: World[] = [];
beforeAll(async () => {
  await DataManager.getInstance().initialize();
});
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});

async function fixture() {
  const world = new CpuServerWorld();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const towns = world.register("towns", TownSystem) as TownSystem;
  await terrain.init();
  const authored = terrain as unknown as {
    loadWaterBodiesFromManifest(): void;
    loadFlatZonesFromManifest(): void;
  };
  authored.loadWaterBodiesFromManifest();
  authored.loadFlatZonesFromManifest();
  await towns.init();
  const buildings = towns.getCollisionService();
  const floor = () => ({
    footprint: [
      [true, true],
      [true, true],
    ],
    roomMap: [
      [0, 0],
      [0, 0],
    ],
    internalOpenings: new Map<string, string>(),
    externalOpenings: new Map([["0,0,north", "door"]]),
  });
  const layout: BuildingLayoutInput = {
    width: 2,
    depth: 2,
    floors: 2,
    floorPlans: [floor(), floor()],
    stairs: null,
  };
  buildings.registerBuilding(
    "support-building",
    "test-town",
    layout,
    { x: 300, y: 35, z: 320 },
    0,
  );
  expect(world.getSystem("buildingCollision")).toBeUndefined();
  const packets: Array<{ name: string; data: unknown }> = [];
  const movement = new TileMovementManager(world, (name, data) => {
    packets.push({ name, data });
  });
  return { world, terrain, buildings, movement, packets };
}

function addPlayer(
  world: World,
  id: string,
  position: [number, number, number],
) {
  const player = new PlayerEntity(world, {
    id,
    name: id,
    type: "player",
    position,
    quaternion: [0, 0, 0, 1],
  });
  world.entities.set(id, player);
  return player;
}

function spawnHeight(
  service: EmbeddedHyperiaService,
  p: [number, number, number],
) {
  return (
    service as unknown as {
      groundSpawnPosition(
        p: [number, number, number],
      ): [number, number, number];
    }
  ).groundSpawnPosition(p);
}

describe("real server spawn and both tile-movement support paths", () => {
  it("retains solid-floor height when a second agent is relocated out of an occupied lobby spawn", async () => {
    const { world, terrain, movement, packets } = await fixture();
    const y = resolvePlayerRootHeight(385, 374, terrain)!;
    const first = addPlayer(world, "occupied-support-first", [385, y, 374]);
    const second = addPlayer(world, "occupied-support-second", [385, y, 374]);
    movement.syncPlayerPosition(first.id, first.position);
    const relocated = movement.syncPlayerPosition(second.id, second.position);
    expect([relocated.x, relocated.z]).not.toEqual([385, 374]);
    expect(relocated.y).toBe(y);
    expect(second.position.y).toBe(first.position.y);
    expect(
      relocated.y - terrain.getHeightAt(relocated.x, relocated.z),
    ).toBeCloseTo(0.03, 12);
    expect(second.data.position).toEqual([relocated.x, y, relocated.z]);
    expect(packets).toContainEqual({
      name: "tileMovementEnd",
      data: expect.objectContaining({
        id: second.id,
        reason: "occupied_spawn_relocation",
        worldPos: [relocated.x, y, relocated.z],
      }),
    });
    expect(movement.syncPlayerPosition(second.id, second.position)).toEqual(
      relocated,
    );
  });
  it("grounds actual streaming duel spawn and fallback return without altering valid saved-position repair policy", async () => {
    const { world, terrain } = await fixture();
    const unexpectedMutation = (): never => {
      throw new Error("Support queries must not mutate a duel");
    };
    const orchestrator = new DuelOrchestrator(
      world,
      () => null,
      unexpectedMutation,
      () => new Map(),
      unexpectedMutation,
      unexpectedMutation,
      () => [],
      () => [],
    );
    const config = getDuelArenaConfig();
    const x = config.baseX + config.arenaWidth / 2,
      z = config.baseZ + config.arenaLength / 2;
    expect(orchestrator.getGroundedY(x, z, config.baseY)).toBe(
      resolvePlayerRootHeight(x, z, terrain),
    );
    expect(
      orchestrator.getGroundedY(x, z, config.baseY) - terrain.getHeightAt(x, z),
    ).toBeCloseTo(0.03, 12);
    for (const id of ["support-return-a", "support-return-b"]) {
      const fallback = orchestrator.getFallbackLobbyPosition(id);
      expect(fallback[1]).toBe(
        resolvePlayerRootHeight(fallback[0], fallback[2], terrain),
      );
      expect(orchestrator.sanitizeRestorePosition(null, id)).toEqual(fallback);
      const validSaved: [number, number, number] = [
        fallback[0],
        fallback[1] + 1,
        fallback[2],
      ];
      expect(orchestrator.sanitizeRestorePosition(validSaved, id)).toEqual(
        validSaved,
      );
    }
  });
  for (const mode of ["all-players", "single-player"] as const)
    for (const floorIndex of [0, 1]) {
      it(`${mode} uses the actual town-owned floor${floorIndex} with identical spawn and movement clearance`, async () => {
        const { world, terrain, buildings, movement, packets } =
          await fixture();
        const floor =
          buildings.getBuilding("support-building")!.floors[floorIndex];
        const id = `support-${mode}-${floorIndex}`;
        const player = addPlayer(world, id, [
          297.5,
          floor.elevation + 0.1,
          317.5,
        ]);
        buildings.updatePlayerBuildingState(
          id as EntityID,
          297,
          317,
          floor.elevation,
        );
        expect(buildings.getPlayerFloor(id as EntityID)).toBe(floorIndex);
        const service = new EmbeddedHyperiaService(
          world,
          id,
          "test-account",
          id,
        );
        const spawn = spawnHeight(service, [
          297.5,
          floor.elevation + 0.1,
          317.5,
        ]);
        expect(spawn[1]).toBe(floor.elevation + PLAYER_ROOT_CLEARANCE);
        player.position.fromArray(spawn);
        player.data.position = spawn;
        movement.syncPlayerPosition(id, player.position);
        expect(
          movement.movePlayerToward(
            id,
            { x: 298.5, y: spawn[1], z: 317.5 },
            false,
          ),
        ).toBe(true);
        if (mode === "all-players") movement.onTick(1);
        else movement.processPlayerTick(id, 1);
        expect(player.position.toArray()).toEqual([
          298.5,
          floor.elevation + PLAYER_ROOT_CLEARANCE,
          317.5,
        ]);
        expect(player.data.position).toEqual(player.position.toArray());
        expect(player.position.y).toBe(
          resolvePlayerRootHeight(298.5, 317.5, terrain, buildings, floorIndex),
        );
        expect(packets.length).toBeGreaterThan(0);
        // No first-step9cm drop, and stopping does not create another clearance.
        const before = player.position.y;
        if (mode === "all-players") movement.onTick(2);
        else movement.processPlayerTick(id, 2);
        expect(player.position.y).toBe(before);
      });
    }

  for (const mode of ["all-players", "single-player"] as const)
    it(`${mode} follows actual lobby solid top on the first step`, async () => {
      const { world, terrain, movement } = await fixture();
      const id = `lobby-${mode}`;
      const service = new EmbeddedHyperiaService(world, id, "test-account", id);
      const spawn = spawnHeight(service, [382.5, 100, 374.5]);
      const player = addPlayer(world, id, spawn);
      expect(spawn[1] - terrain.getHeightAt(spawn[0], spawn[2])).toBeCloseTo(
        0.03,
        12,
      );
      movement.syncPlayerPosition(id, player.position);
      expect(
        movement.movePlayerToward(
          id,
          { x: 383.5, y: spawn[1], z: 374.5 },
          false,
        ),
      ).toBe(true);
      if (mode === "all-players") movement.onTick(1);
      else movement.processPlayerTick(id, 1);
      expect(player.position.x).toBe(383.5);
      expect(player.position.y).toBeCloseTo(spawn[1], 12);
    });

  it("resolves the town-owned service in the actual movement wall predicate", async () => {
    const { world, buildings, movement } = await fixture();
    const id = "wall-support";
    const floor = buildings.getBuilding("support-building")!.floors[0];
    const wall = floor.wallSegments.find(
      (row) => !row.hasOpening && row.side === "west",
    )!;
    const start = {
      x: wall.tileX - 0.5,
      y: floor.elevation,
      z: wall.tileZ + 0.5,
    };
    const player = addPlayer(world, id, [start.x, start.y, start.z]);
    movement.syncPlayerPosition(id, player.position);
    // Exercise the actual production predicate; this isn't an always-true world.
    const internals = movement as unknown as {
      isTileWalkable(
        tile: { x: number; z: number },
        floor: number,
        from: { x: number; z: number },
        buildingId: string | null,
      ): boolean;
      getBuildingCollision(): BuildingCollisionService | null;
    };
    expect(internals.getBuildingCollision()).toBe(buildings);
    expect(
      internals.isTileWalkable(
        { x: wall.tileX, z: wall.tileZ },
        0,
        { x: wall.tileX - 1, z: wall.tileZ },
        null,
      ),
    ).toBe(false);
  });
});
