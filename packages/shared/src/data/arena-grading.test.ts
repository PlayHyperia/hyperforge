import { describe, expect, it } from "vitest";
import { World } from "../core/World";
import THREE from "../extras/three/three";
import { DuelArenaVisualsSystem } from "../systems/client/DuelArenaVisualsSystem";
import { TerrainSystem } from "../systems/shared/world/TerrainSystem";
import { WaterBodyRegistry } from "../systems/shared/world/WaterBodyRegistry";
import { ALL_WORLD_AREAS, type WorldArea } from "./world-areas";
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
  getDuelArenaSolidSurfaceHeight,
  resolveDuelArenaFloorHeight,
  DUEL_ARENA_FLOOR_GROUND_OFFSET,
  DUEL_ARENA_FLOOR_CENTER_OFFSET,
  DUEL_ARENA_FLOOR_THICKNESS,
} from "./arena-grading";

/** Actual source initialization through the pre-tile phase; no renderer or physics. */
function actualTerrain(loadGrades = true) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  terrain["initializeTerrainGenerator"]();
  terrain["waterBodyRegistry"] = new WaterBodyRegistry(
    terrain.getWorldTerrainProfile().water.threshold,
  );
  terrain["loadWaterBodiesFromManifest"]();
  if (loadGrades) terrain["loadFlatZonesFromManifest"]();
  return { world, terrain };
}

/** Install actual area data only for a synchronous construction/query scope. */
function withArenaArea<T>(area: WorldArea, run: () => T): T {
  const previous = ALL_WORLD_AREAS.duel_arena;
  ALL_WORLD_AREAS.duel_arena = area;
  try {
    return run();
  } finally {
    ALL_WORLD_AREAS.duel_arena = previous;
  }
}

/** Real terrain and Three meshes; no renderer or simulated PhysX success. */
function actualFloorReceipt() {
  const { world, terrain } = actualTerrain();
  const base = getDuelArenaGradeHeight();
  const zones = createDuelArenaFloorZones(getDuelArenaConfig(), base);
  const samples: number[] = [];
  const solidHeights: Array<number | null> = [];
  for (const zone of zones) {
    for (
      let x = zone.centerX - zone.width / 2;
      x <= zone.centerX + zone.width / 2;
      x++
    ) {
      for (
        let z = zone.centerZ - zone.depth / 2;
        z <= zone.centerZ + zone.depth / 2;
        z++
      ) {
        samples.push(terrain.getHeightAt(x, z));
        solidHeights.push(getDuelArenaSolidSurfaceHeight(x, z));
      }
    }
    // Every side and corner, including both exact collar endpoints. Nothing
    // outside these factory collars is certified safe by this comparison.
    for (const nx of [-1, 0, 1]) {
      for (const nz of [-1, 0, 1]) {
        if (nx === 0 && nz === 0) continue;
        for (const distance of [0, 1e-6, 0.25, 0.5, 0.75, 1 - 1e-6, 1]) {
          const x = zone.centerX + nx * (zone.width / 2 + distance);
          const z = zone.centerZ + nz * (zone.depth / 2 + distance);
          const height = terrain.getHeightAt(x, z);
          expect(height).toBe(resolveDuelArenaFloorHeight(zone, x, z, base));
          samples.push(height);
        }
      }
    }
  }
  const destinations = [
    getDuelArenaLobbyReturnPosition(true),
    getDuelArenaLobbyReturnPosition(false),
    getDuelArenaEgressPosition(),
  ];
  for (const position of destinations) {
    expect(position.y).toBeCloseTo(
      resolvePlayerRootHeight(position.x, position.z, terrain)!,
      12,
    );
  }
  const visuals = new DuelArenaVisualsSystem(world);
  visuals["arenaCfg"] = getDuelArenaConfig();
  visuals["terrainSystem"] = terrain;
  visuals["arenaGroup"] = new THREE.Group();
  world.stage.scene.add(visuals["arenaGroup"]);
  try {
    visuals["assertSharedArenaFloors"]();
    visuals["createSharedMaterials"]();
    visuals["createArenaFloors"]();
    visuals["createLobbyFloor"]();
    visuals["createHospitalFloor"]();
    const names = ["ArenaFloor_1", "LobbyFloor", "HospitalFloor"];
    const meshBounds = names.map((name) => {
      const floor = visuals["arenaGroup"]!.getObjectByName(name)!;
      expect(floor).toBeDefined();
      const bounds = new THREE.Box3().setFromObject(floor);
      expect(floor.position.y).toBe(base + DUEL_ARENA_FLOOR_CENTER_OFFSET);
      expect(bounds.max.y).toBeCloseTo(base + 0.42, 7);
      return { name, min: bounds.min.toArray(), max: bounds.max.toArray() };
    });
    expect(
      meshBounds.map(({ min, max }) => [max[0] - min[0], max[2] - min[2]]),
    ).toEqual([
      [19, 23],
      [18, 16],
      [12, 12],
    ]);
    return {
      zones,
      heightBytes: new Uint8Array(new Float64Array(samples).buffer),
      solidHeights,
      destinations,
      meshBounds,
    };
  } finally {
    visuals.destroy();
    terrain.destroy();
  }
}

describe("authored shared duel arena grade", () => {
  it("rejects invalid explicit datum before a fresh terrain installs any authored surface", () => {
    const area = ALL_WORLD_AREAS.duel_arena;
    for (const arenaFloorDatum of [
      undefined,
      { height: Infinity },
      { height: getDuelArenaGradeHeight() + 1 },
    ]) {
      const { terrain } = actualTerrain(false);
      try {
        const invalid = { ...area, arenaFloorDatum };
        withArenaArea(invalid, () => {
          expect(() => terrain["loadFlatZonesFromManifest"]()).toThrow(
            /explicit arena floor datum/i,
          );
        });
        expect(terrain["flatZones"].size).toBe(0);
        expect(terrain["arenaFloorZoneIds"].size).toBe(0);
        expect(terrain["arenaGradeHeight"]).toBeNull();
      } finally {
        terrain.destroy();
      }
    }
    expect(ALL_WORLD_AREAS.duel_arena).toBe(area);
  });

  it("accepts an explicit datum independently of grading coverage without mutating inputs", () => {
    const area = ALL_WORLD_AREAS.duel_arena;
    const campus = area.flatZones![0];
    for (const height of [0, -7.125, 31.25]) {
      for (const flatZones of [
        undefined,
        [],
        [{ ...campus, height, width: 1, depth: 1 }],
      ]) {
        const explicit = Object.freeze({
          ...area,
          arenaFloorDatum: Object.freeze({ height }),
          flatZones,
        });
        const before = JSON.stringify(explicit);
        expect(getDuelArenaGradeHeight({ duel_arena: explicit })).toBe(height);
        expect(JSON.stringify(explicit)).toBe(before);
      }
    }
    const nullPrototypeDatum = Object.assign(Object.create(null) as object, {
      height: 31.25,
    });
    expect(
      getDuelArenaGradeHeight({
        duel_arena: {
          ...area,
          flatZones: [],
          arenaFloorDatum: nullPrototypeDatum,
        },
      }),
    ).toBe(31.25);
  });

  it("rejects malformed explicit metadata without evaluating accessors or falling back", () => {
    const area = ALL_WORLD_AREAS.duel_arena;
    let reads = 0;
    const accessorDatum = Object.defineProperty({}, "height", {
      enumerable: true,
      get() {
        reads++;
        return getDuelArenaGradeHeight();
      },
    });
    const hiddenHeight = Object.defineProperty({}, "height", { value: 12 });
    for (const arenaFloorDatum of [
      undefined,
      null,
      false,
      12,
      "12",
      [],
      {},
      { height: undefined },
      { height: null },
      { height: "12" },
      { height: NaN },
      { height: Infinity },
      { height: -Infinity },
      { height: 12, extra: true },
      { height: 12, [Symbol("extra")]: true },
      Object.create({ height: 12 }),
      accessorDatum,
      hiddenHeight,
    ]) {
      const malformed = { ...area, arenaFloorDatum } as unknown as WorldArea;
      expect(() => getDuelArenaGradeHeight({ duel_arena: malformed })).toThrow(
        /explicit arena floor datum/,
      );
    }
    const accessorArea = Object.defineProperty({ ...area }, "arenaFloorDatum", {
      enumerable: true,
      get() {
        reads++;
        return { height: 12 };
      },
    });
    const hiddenArea = Object.defineProperty({ ...area }, "arenaFloorDatum", {
      value: { height: 12 },
    });
    const inheritedArea = Object.assign(
      Object.create({ arenaFloorDatum: { height: 12 } }) as WorldArea,
      area,
    );
    for (const malformed of [accessorArea, hiddenArea, inheritedArea]) {
      expect(() => getDuelArenaGradeHeight({ duel_arena: malformed })).toThrow(
        /explicit arena floor datum/,
      );
    }
    expect(reads).toBe(0);
  });

  it("rejects unordered bounds and ambiguous or invalid campus grades with an explicit datum", () => {
    const area = ALL_WORLD_AREAS.duel_arena;
    const campus = area.flatZones![0];
    const height = getDuelArenaGradeHeight();
    const explicit = { ...area, arenaFloorDatum: { height } };
    for (const bounds of [
      { ...area.bounds, minX: NaN },
      { ...area.bounds, maxZ: Infinity },
      { ...area.bounds, minX: area.bounds.maxX },
      { ...area.bounds, minZ: area.bounds.maxZ + 1 },
    ]) {
      expect(() =>
        getDuelArenaGradeHeight({ duel_arena: { ...explicit, bounds } }),
      ).toThrow(/explicit arena floor datum area bounds/);
    }
    for (const flatZones of [
      [campus, campus],
      [{ ...campus, height: height + 1 }],
      [{ ...campus, height: undefined }],
      [{ ...campus, width: 0 }],
      [{ ...campus, depth: -1 }],
      [{ ...campus, centerX: NaN }],
      [{ ...campus, centerX: Number.MAX_VALUE, width: Number.MAX_VALUE }],
      [{ ...campus, blendRadius: -1 }],
      [{ ...campus, heightOffset: 1 }],
      [
        {
          ...campus,
          radialPond: {
            bedRadius: 1,
            bankInnerRadius: 2,
            bankOuterRadius: 3,
            bankHeight: height,
          },
        },
      ],
    ]) {
      expect(() =>
        getDuelArenaGradeHeight({ duel_arena: { ...explicit, flatZones } }),
      ).toThrow(/campus grade/);
    }
    for (const flatZones of [null, false, {}]) {
      const malformed = { ...explicit, flatZones } as unknown as WorldArea;
      expect(() => getDuelArenaGradeHeight({ duel_arena: malformed })).toThrow(
        /explicit arena floor datum area bounds or grades/,
      );
    }
  });

  it.each(["unchanged", "absent", "narrowed"] as const)(
    "preserves actual factory surfaces, solids, meshes and returns with %s campus grading",
    (mode) => {
      const area = ALL_WORLD_AREAS.duel_arena;
      expect(
        Object.prototype.hasOwnProperty.call(area, "arenaFloorDatum"),
      ).toBe(false);
      const baseline = actualFloorReceipt();
      const campus = area.flatZones![0];
      const explicit: WorldArea = {
        ...area,
        arenaFloorDatum: { height: getDuelArenaGradeHeight() },
        flatZones:
          mode === "unchanged"
            ? area.flatZones
            : mode === "absent"
              ? []
              : [{ ...campus, width: 1, depth: 1 }],
      };
      expect(withArenaArea(explicit, actualFloorReceipt)).toStrictEqual(
        baseline,
      );
      if (mode === "unchanged") {
        const sampleRegion = () => {
          const terrain = actualTerrain().terrain;
          try {
            const heights: number[] = [];
            // Only unchanged grading must preserve this nearby region beyond
            // floor cores/collars, including campus blends and procedural land.
            for (let x = 290; x <= 450; x += 10)
              for (let z = 270; z <= 460; z += 10)
                heights.push(terrain.getHeightAt(x, z));
            return new Uint8Array(new Float64Array(heights).buffer);
          } finally {
            terrain.destroy();
          }
        };
        expect(withArenaArea(explicit, sampleRegion)).toStrictEqual(
          sampleRegion(),
        );
      }
      expect(ALL_WORLD_AREAS.duel_arena).toBe(area);
      expect(
        Object.prototype.hasOwnProperty.call(area, "arenaFloorDatum"),
      ).toBe(false);
    },
  );

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
      width: 18,
      depth: 16,
    });
    expect(
      zones.find((zone) => zone.id === "duel_hospital_floor"),
    ).toMatchObject({
      centerX: 345,
      centerZ: 376,
      width: 12,
      depth: 12,
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
    // Five current manifest grades + eleven station pads + three floors. The
    // lodge grass-clearance grade was added after the original 18-zone census.
    expect(a["flatZones"].size).toBe(19);
    expect(b["flatZones"].size).toBe(19);
    for (const terrain of [a, b]) {
      expect(
        terrain["flatZones"].get("central_haven_lodge_grass_clearance"),
      ).toMatchObject({
        centerX: 350,
        centerZ: 326.97,
        width: 10,
        depth: 12.06,
        height: base,
        blendRadius: 0,
        excludeGrass: true,
      });
    }
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
