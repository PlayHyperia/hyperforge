import { describe, expect, it } from "vitest";
import { World } from "../core/World";
import THREE from "../extras/three/three";
import { DuelArenaVisualsSystem } from "../systems/client/DuelArenaVisualsSystem";
import { TerrainSystem } from "../systems/shared/world/TerrainSystem";
import { WaterBodyRegistry } from "../systems/shared/world/WaterBodyRegistry";
import { ALL_WORLD_AREAS } from "./world-areas";
import { resolvePlayerRootHeight } from "../utils/movement/PlayerSupport";
import {
  getDuelArenaConfig,
  isPositionInsideCombatArena,
} from "./duel-manifest";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
  getDuelArenaLobbyReturnPosition,
  getDuelArenaEgressPosition,
  resolveDuelArenaFloorHeight,
  DUEL_ARENA_FLOOR_GROUND_OFFSET,
  DUEL_ARENA_FLOOR_CENTER_OFFSET,
  DUEL_ARENA_FLOOR_THICKNESS,
} from "./arena-grading";

/** Actual source initialization through the pre-tile phase; no renderer or physics. */
function actualTerrain() {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  terrain["initializeTerrainGenerator"]();
  terrain["waterBodyRegistry"] = new WaterBodyRegistry(
    terrain.getWorldTerrainProfile().water.threshold,
  );
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  return { world, terrain };
}

describe("authored shared duel arena grade", () => {
  it("requires one explicit campus height covering the complete authored area", () => {
    const area = ALL_WORLD_AREAS.duel_arena;
    const grade = getDuelArenaGradeHeight();
    expect(grade).toBe(28.419301523097687);
    expect(
      ALL_WORLD_AREAS.preparation_training_grounds.flatZones?.find(
        (zone) => zone.id === "preparation_campus_grade",
      )?.height,
    ).toBe(grade);
    expect(() => getDuelArenaGradeHeight({})).toThrow(/exactly one authored/);
    const campus = area.flatZones![0];
    for (const flatZones of [
      [],
      [campus, campus],
      [{ ...campus, height: undefined }],
      [{ ...campus, width: 1 }],
      [{ ...campus, heightOffset: 1 }],
    ]) {
      expect(() =>
        getDuelArenaGradeHeight({ duel_arena: { ...area, flatZones } }),
      ).toThrow(/authored campus grade/);
    }
  });

  it("retains only the single arena, lobby and hospital floors at one common height", () => {
    const cfg = getDuelArenaConfig();
    const zones = createDuelArenaFloorZones(cfg, getDuelArenaGradeHeight());
    expect(zones.map((zone) => zone.id)).toEqual([
      "duel_arena_floor_1",
      "duel_lobby_floor",
      "duel_hospital_floor",
    ]);
    expect(new Set(zones.map((zone) => zone.height)).size).toBe(1);
    for (const zone of zones) {
      expect(zone.height).toBe(
        getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_GROUND_OFFSET,
      );
      expect(zone.blendRadius).toBe(1);
      expect(zone.carveInset).toBe(1);
    }
    expect(zones[0]).toMatchObject({
      centerX: 350,
      centerZ: 406,
      width: 20,
      depth: 24,
    });
    expect(zones.find((zone) => zone.id === "duel_lobby_floor")).toMatchObject({
      centerX: 385,
      centerZ: 376,
      width: 40,
      depth: 25,
    });
    expect(
      zones.find((zone) => zone.id === "duel_hospital_floor"),
    ).toMatchObject({
      centerX: 345,
      centerZ: 376,
      width: 28,
      depth: 23,
    });
    expect(() =>
      createDuelArenaFloorZones({ ...cfg, arenaCount: 100000 }, 0),
    ).toThrow(/Invalid/);
    expect(() => createDuelArenaFloorZones(cfg, NaN)).toThrow(/Invalid/);
  });

  it("gives independently initialized terrain instances identical whole-floor heights and continuous perimeter ramps", () => {
    const a = actualTerrain().terrain;
    const b = actualTerrain().terrain;
    const base = getDuelArenaGradeHeight();
    const zones = createDuelArenaFloorZones(getDuelArenaConfig(), base);
    expect(a["flatZones"].size).toBe(18);
    expect(b["flatZones"].size).toBe(18);
    let sampled = 0;
    for (const zone of zones) {
      for (let dx = -zone.width / 2; dx <= zone.width / 2; dx += 1) {
        for (let dz = -zone.depth / 2; dz <= zone.depth / 2; dz += 1) {
          const x = zone.centerX + dx;
          const z = zone.centerZ + dz;
          expect(a.getHeightAt(x, z)).toBe(zone.height);
          expect(b.getHeightAt(x, z)).toBe(zone.height);
          sampled++;
        }
      }
      for (const [nx, nz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
      ]) {
        let previous = zone.height;
        for (const distance of [
          0, 0.000001, 0.25, 0.5, 0.75, 0.999999, 1, 1.000001,
        ]) {
          const x = zone.centerX + nx * (zone.width / 2 + distance);
          const z = zone.centerZ + nz * (zone.depth / 2 + distance);
          const expected =
            resolveDuelArenaFloorHeight(zone, x, z, base) ?? base;
          expect(a.getHeightAt(x, z)).toBeCloseTo(expected, 10);
          expect(b.getHeightAt(x, z)).toBeCloseTo(expected, 10);
          expect(expected).toBeLessThanOrEqual(previous + 1e-12);
          expect(expected).toBeGreaterThanOrEqual(base - 1e-12);
          previous = expected;
        }
      }
    }
    expect(sampled).toBe(
      zones.reduce(
        (total, zone) => total + (zone.width + 1) * (zone.depth + 1),
        0,
      ),
    );
    // Same-grade overlap links the preparation campus to both southern rooms.
    for (let z = 340; z <= 363; z += 0.25) {
      expect(a.getHeightAt(350, z)).toBe(base);
      expect(b.getHeightAt(350, z)).toBe(base);
    }
  });

  it("constructs actual arena/hospital meshes at the shared platform top and does not own terrain lifetime", () => {
    const { world, terrain } = actualTerrain();
    const visuals = new DuelArenaVisualsSystem(world);
    visuals["arenaCfg"] = getDuelArenaConfig();
    visuals["terrainSystem"] = terrain;
    visuals["arenaGroup"] = new THREE.Group();
    world.stage.scene.add(visuals["arenaGroup"]);
    const idsBefore = [...terrain["flatZones"].keys()];
    try {
      visuals["assertSharedArenaFloors"]();
      visuals["createSharedMaterials"]();
      visuals["createArenaFloors"]();
      visuals["createHospitalFloor"]();
      const floors = visuals["arenaGroup"].children.filter(
        (object) =>
          object.name.startsWith("ArenaFloor_") ||
          object.name === "HospitalFloor",
      );
      expect(floors.map((floor) => floor.name)).toEqual([
        "ArenaFloor_1",
        "HospitalFloor",
      ]);
      for (const floor of floors) {
        const bounds = new THREE.Box3().setFromObject(floor);
        expect(floor.position.y).toBe(
          getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_CENTER_OFFSET,
        );
        expect(bounds.max.y).toBeCloseTo(
          getDuelArenaGradeHeight() +
            DUEL_ARENA_FLOOR_CENTER_OFFSET +
            DUEL_ARENA_FLOOR_THICKNESS / 2,
          7,
        );
        expect(
          bounds.max.y -
            terrain.getHeightAt(floor.position.x, floor.position.z),
        ).toBeCloseTo(0.02, 7);
      }
      const zone = terrain["flatZones"].get("duel_arena_floor_1")!;
      terrain.unregisterFlatZone(zone.id);
      expect(() => visuals["assertSharedArenaFloors"]()).toThrow(
        /shared floor is not ready: duel_arena_floor_1/,
      );
      terrain["loadFlatZonesFromManifest"]();
      visuals["assertSharedArenaFloors"]();
    } finally {
      visuals.destroy();
    }
    expect([...terrain["flatZones"].keys()].sort()).toEqual(idsBefore.sort());
    expect(terrain.getHeightAt(350, 406)).toBe(getDuelArenaGradeHeight() + 0.4);
    expect(world.stage.scene.children).toHaveLength(0);
  });

  it("returns separated winner/loser and egress positions on actual lobby ground inside the island", () => {
    const terrain = actualTerrain().terrain;
    const winner = getDuelArenaLobbyReturnPosition(true);
    const loser = getDuelArenaLobbyReturnPosition(false);
    const egress = getDuelArenaEgressPosition();
    expect(winner.x).toBe(382);
    expect(loser.x).toBe(388);
    expect(egress.x).toBe(385);
    const bounds = terrain.getWorldTerrainProfile().bounds;
    for (const position of [winner, loser, egress]) {
      expect(position.z).toBe(374);
      expect(position.y).toBeCloseTo(
        resolvePlayerRootHeight(position.x, position.z, terrain)!,
        12,
      );
      expect(isPositionInsideCombatArena(position.x, position.z)).toBe(false);
      expect(position.x).toBeGreaterThan(bounds.minX);
      expect(position.x).toBeLessThan(bounds.maxX);
      expect(position.z).toBeGreaterThan(bounds.minZ);
      expect(position.z).toBeLessThan(bounds.maxZ);
    }
  });
});
