import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { BIOMES } from "../../../../data/world-structure";
import type { FlatZone } from "../../../../types/world/terrain";
import { BIOME_CONFIGS } from "../TerrainHeightParams";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainSystem } from "../TerrainSystem";

// Real terrain/data/water owners. These are canonical CPU/lifecycle checks,
// not substitutes for the native texture, camera or visual qualification.
const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
function createTerrain() {
  const world = new World();
  worlds.push(world);
  return {
    world,
    terrain: world.register("terrain", TerrainSystem) as TerrainSystem,
  };
}
async function fixture(loadGrades = false) {
  const value = createTerrain();
  await value.terrain.init();
  if (loadGrades) {
    value.terrain["loadWaterBodiesFromManifest"]();
    value.terrain["loadFlatZonesFromManifest"]();
  }
  return value;
}
function grade(overrides: Partial<FlatZone> = {}): FlatZone {
  return {
    id: "canonical-test-grade",
    centerX: 350,
    centerZ: 400,
    width: 12,
    depth: 8,
    height: 36,
    blendRadius: 2,
    ...overrides,
  };
}

function preparationProvider(terrain: TerrainSystem) {
  const actual = terrain["buildChunkTerrainProvider"]();
  const worker = terrain["buildGrassWorkerSetup"]();
  return {
    actual,
    worker,
    getHeightAtComputed: actual.getHeightAtComputed,
    getBiomeColor: actual.getBiomeColor,
    capturePreparationLease: () =>
      actual.capturePreparationLease(worker.biomeCenters, worker.biomes),
  };
}

describe("owned canonical ground leases", () => {
  it("reuses one exact ordered neighborhood across stencils and replaces it at centered tile boundaries", async () => {
    const { terrain } = await fixture();
    for (const x of [-160, -80, 0, 80, 160])
      for (const z of [-160, -80, 0, 80, 160])
        terrain.registerFlatZone(
          grade({
            id: `ordered-${x}-${z}`,
            centerX: x,
            centerZ: z,
            width: 110,
            depth: 90,
            blendRadius: 18,
          }),
        );
    const offsets = [
      [-1, -1],
      [-1, 0],
      [-1, 1],
      [0, -1],
      [0, 0],
      [0, 1],
      [1, -1],
      [1, 0],
      [1, 1],
    ];
    const size = terrain["CONFIG"].TILE_SIZE;
    const ownedArray = terrain["getAuthoredSurfaceCandidates"](0, 0);
    // Include both sides and the exact Float64 boundary, in both directions.
    const axis = [
      -250, -150.000001, -150, -149.999999, -50.000001, -50, -49.999999, 0,
      49.999999, 50, 50.000001, 150, 250, 10000,
    ];
    for (const x of [...axis, ...[...axis].reverse()])
      for (const z of axis) {
        const tx = Math.floor((x + size / 2) / size);
        const tz = Math.floor((z + size / 2) / size);
        const all = offsets.flatMap(
          ([dx, dz]) =>
            terrain["flatZonesByTile"].get(`${tx + dx}_${tz + dz}`) ?? [],
        );
        const expected = all.filter(
          (zone, i) => all.findIndex((other) => other.id === zone.id) === i,
        );
        for (const delta of [0, 0.03125, -0.03125]) {
          const actualX = x + delta;
          if (Math.floor((actualX + size / 2) / size) !== tx) continue;
          const actual = terrain["getAuthoredSurfaceCandidates"](actualX, z);
          expect(actual).toBe(ownedArray); // Bounded to the existing one vector.
          expect(actual.length).toBe(expected.length);
          for (let i = 0; i < expected.length; i++)
            expect(actual[i]).toBe(expected[i]);
        }
      }
  });

  it("refreshes the warm neighborhood for every owned index replacement and destruction", async () => {
    const { terrain, world } = await fixture();
    const input = grade();
    const candidates = () => terrain["getAuthoredSurfaceCandidates"](350, 400);
    expect(candidates()).toHaveLength(0); // An empty cached tile must invalidate too.
    terrain.registerFlatZone(input);
    expect(candidates()).toEqual([terrain["flatZones"].get(input.id)]);
    expect(terrain["isGrassExcludedAt"](350, 400)).toBe(true);
    const lease = terrain.captureCanonicalGroundLease();
    const previous = candidates()[0];
    terrain.registerFlatZone({ ...input, excludeGrass: false });
    expect(lease.isCurrent()).toBe(true);
    expect(terrain["isGrassExcludedAt"](350, 400)).toBe(false);
    expect(candidates()[0]).not.toBe(previous);
    for (const replacement of [
      { ...input, excludeGrass: false },
      { ...input, excludeGrass: false, carveInset: 0.2 },
      { ...input, height: 42 },
      { ...input, centerX: 950 },
    ]) {
      terrain.registerFlatZone(replacement);
      const owned = terrain["flatZones"].get(input.id)!;
      if (replacement.centerX === 950) expect(candidates()).toHaveLength(0);
      else expect(candidates()[0]).toBe(owned);
      expect(
        terrain["getAuthoredSurfaceCandidates"](replacement.centerX, 400),
      ).toContain(owned);
    }
    terrain.unregisterFlatZone(input.id);
    expect(terrain["getAuthoredSurfaceCandidates"](950, 400)).toHaveLength(0);
    terrain.registerFlatZone(input);
    expect(candidates()).toHaveLength(1);
    world.destroy();
    expect(terrain["authoredSurfaceCandidates"]).toHaveLength(0);
    expect(terrain["authoredSurfaceCandidateTileX"]).toBeUndefined();
  });

  it("rejects before initialization and after destruction; samples the actual admitted profile exactly", async () => {
    const { world, terrain } = createTerrain();
    expect(() => terrain.captureCanonicalGroundLease()).toThrow(
      /initialized live terrain/,
    );
    const pending = terrain.init();
    expect(() => terrain.captureCanonicalGroundLease()).toThrow(
      /initialized live terrain/,
    );
    await pending;
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
    const lease = terrain.captureCanonicalGroundLease();
    expect(lease.profile).toBe(terrain.getWorldTerrainProfile());
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.profile)).toBe(true);
    expect(lease.supportBounds).toHaveLength(19);
    for (const bounds of lease.supportBounds) {
      expect(bounds.minX).toBeGreaterThanOrEqual(lease.profile.bounds.minX);
      expect(bounds.maxX).toBeLessThanOrEqual(lease.profile.bounds.maxX);
      expect(bounds.minZ).toBeGreaterThanOrEqual(lease.profile.bounds.minZ);
      expect(bounds.maxZ).toBeLessThanOrEqual(lease.profile.bounds.maxZ);
    }
    for (const [x, z] of [
      [150, 200],
      [350, 400],
      [343, 302],
      [414.1, 471.2],
      [550, 600],
    ]) {
      expect(lease.sampleHeight(x, z)).toBe(
        terrain.getResourceGroundHeight(x, z),
      );
    }
    expect(() => lease.sampleHeight(NaN, 400)).toThrow(
      /finite world coordinates/,
    );
    expect(lease.isCurrent()).toBe(true);
    world.destroy();
    expect(lease.isCurrent()).toBe(false);
    expect(() => lease.sampleHeight(350, 400)).toThrow(/stale/);
    expect(() => terrain.captureCanonicalGroundLease()).toThrow(
      /initialized live terrain/,
    );
    expect(() => terrain.registerFlatZone(grade())).toThrow(/destroyed/);
  });

  it("owns masked grades and returns detached copies, so caller and query mutations cannot bypass the revision", async () => {
    const { terrain } = await fixture();
    const input = grade({
      centerX: 350.5,
      centerZ: 400.5,
      tileMask: new Set(["350,400", "351,400"]),
      tileMaskTiles: [
        { x: 350, z: 400 },
        { x: 351, z: 400 },
      ],
      tileMaskBounds: { minX: 350, maxX: 351, minZ: 400, maxZ: 400 },
    });
    terrain.registerFlatZone(input);
    const lease = terrain.captureCanonicalGroundLease();
    const owned = terrain["flatZones"].get(input.id)!;
    expect(owned).not.toBe(input);
    expect(owned.tileMask).not.toBe(input.tileMask);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.tileMaskTiles)).toBe(true);
    expect(Object.isFrozen(owned.tileMaskTiles![0])).toBe(true);
    expect(Object.isFrozen(owned.tileMaskBounds)).toBe(true);
    expect(lease.sampleHeight(350.5, 400.5)).toBe(36);

    input.height = 80;
    input.centerX = 900;
    input.tileMask!.clear();
    input.tileMaskTiles![0].x = 900;
    input.tileMaskBounds!.minX = 900;
    const detached = terrain.getFlatZoneAt(350.5, 400.5)!;
    expect(detached).not.toBe(owned);
    expect(detached.tileMask).not.toBe(owned.tileMask);
    detached.height = 70;
    detached.tileMask!.clear();
    detached.tileMaskTiles![0].z = 900;
    detached.tileMaskBounds!.minZ = 900;
    expect(lease.isCurrent()).toBe(true);
    expect(lease.sampleHeight(350.5, 400.5)).toBe(36);
    expect(terrain.getFlatZoneAt(350.5, 400.5)!.tileMask).toEqual(
      new Set(["350,400", "351,400"]),
    );
    expect(terrain.captureCanonicalGroundLease().revision).toBe(lease.revision);
  });

  it("owns radial profiles and immutable full grading supports, independent of narrower grass bounds", async () => {
    const { terrain } = await fixture();
    const radial = grade({
      id: "canonical-radial",
      centerX: 340,
      centerZ: 300,
      width: 24,
      depth: 24,
      height: 22,
      radialPond: {
        bedRadius: 3,
        bankInnerRadius: 5,
        bankOuterRadius: 10,
        bankHeight: 29,
        shorelineAmplitude: 0.5,
      },
    });
    const rectangular = grade({
      grassExclusionBounds: { minX: 349, maxX: 351, minZ: 399, maxZ: 401 },
    });
    terrain.registerFlatZone(radial);
    terrain.registerFlatZone(rectangular);
    const lease = terrain.captureCanonicalGroundLease();
    expect(lease.supportBounds).toEqual([
      { minX: 328, maxX: 352, minZ: 288, maxZ: 312 },
      { minX: 342, maxX: 358, minZ: 394, maxZ: 406 },
    ]);
    expect(Object.isFrozen(lease.supportBounds)).toBe(true);
    expect(Reflect.set(lease.supportBounds[0], "minX", 0)).toBe(false);
    const before = lease.sampleHeight(348, 300);
    radial.radialPond!.bankHeight = 90;
    rectangular.grassExclusionBounds!.maxX = 355;
    terrain.getFlatZoneAt(340, 300)!.radialPond!.bankHeight = 80;
    expect(
      Object.isFrozen(terrain["flatZones"].get(radial.id)!.radialPond),
    ).toBe(true);
    expect(lease.sampleHeight(348, 300)).toBe(before);
    expect(lease.isCurrent()).toBe(true);
  });

  it("owns optional pond outer knots and invalidates ground, preparation and grass revisions on pair changes", async () => {
    const { terrain } = await fixture();
    const radial = grade({
      id: "canonical-paired-pond",
      centerX: 340,
      centerZ: 300,
      width: 22,
      depth: 22,
      height: 26.6,
      radialPond: {
        bedRadius: 5,
        bankInnerRadius: 7,
        bankOuterRadius: 9,
        bankHeight: 28.08,
        shorelineAmplitude: 0.9,
        bankSectors: [
          {
            bearing: -2.32,
            halfWidth: 0.7,
            innerRadius: 6,
            innerHeight: 27.98,
          },
        ],
      },
    });
    terrain.registerFlatZone(radial);
    const provider = preparationProvider(terrain);
    const replace = (input: FlatZone) => {
      const ground = terrain.captureCanonicalGroundLease();
      const preparation = provider.capturePreparationLease();
      const grassRevision = terrain["grassSurfaceRevision"];
      terrain.registerFlatZone(input);
      expect(ground.isCurrent()).toBe(false);
      expect(preparation.isCurrent()).toBe(false);
      expect(terrain["grassSurfaceRevision"]).toBeGreaterThan(grassRevision);
      expect(terrain.captureCanonicalGroundLease().supportBounds).toEqual([
        { minX: 329, maxX: 351, minZ: 289, maxZ: 311 },
      ]);
    };

    const paired = terrain.getFlatZoneAt(340, 300)!;
    Object.assign(paired.radialPond!.bankSectors![0], {
      outerRadius: 8.2,
      outerHeight: 28.55,
    });
    replace(paired);
    const owned = terrain["flatZones"].get(radial.id)!;
    expect(owned.radialPond!.bankSectors![0]).not.toBe(
      paired.radialPond!.bankSectors![0],
    );
    expect(Object.isFrozen(owned.radialPond!.bankSectors![0])).toBe(true);
    expect(
      Reflect.set(owned.radialPond!.bankSectors![0], "outerHeight", 28.6),
    ).toBe(false);
    const ground = terrain.captureCanonicalGroundLease();
    const preparation = provider.capturePreparationLease();
    const grassRevision = terrain["grassSurfaceRevision"];
    const detached = terrain["getTerrainSurfaceForRegion"](329, 289, 351, 311);
    expect(detached.zones[0].radialPond!.bankSectors![0].outerHeight).toBe(
      28.55,
    );
    paired.radialPond!.bankSectors![0].outerHeight = 28.6;
    terrain.getFlatZoneAt(340, 300)!.radialPond!.bankSectors![0].outerRadius =
      8.8;
    expect(ground.isCurrent()).toBe(true);
    expect(preparation.isCurrent()).toBe(true);
    expect(terrain["grassSurfaceRevision"]).toBe(grassRevision);
    terrain.registerFlatZone(terrain.getFlatZoneAt(340, 300)!);
    expect(ground.isCurrent()).toBe(true);
    expect(preparation.isCurrent()).toBe(true);
    expect(terrain["grassSurfaceRevision"]).toBe(grassRevision);

    for (const [key, value] of [
      ["outerRadius", 8.4],
      ["outerHeight", 28.6],
    ] as const) {
      const changed = terrain.getFlatZoneAt(340, 300)!;
      changed.radialPond!.bankSectors![0][key] = value;
      replace(changed);
    }
    expect(detached.zones[0].radialPond!.bankSectors![0].outerRadius).toBe(8.2);
    expect(detached.zones[0].radialPond!.bankSectors![0].outerHeight).toBe(
      28.55,
    );
    const removed = terrain.getFlatZoneAt(340, 300)!;
    delete removed.radialPond!.bankSectors![0].outerRadius;
    delete removed.radialPond!.bankSectors![0].outerHeight;
    replace(removed);
    const row = terrain.getFlatZoneAt(340, 300)!.radialPond!.bankSectors![0];
    expect(row).not.toHaveProperty("outerRadius");
    expect(row).not.toHaveProperty("outerHeight");
    const restored = terrain.getFlatZoneAt(340, 300)!;
    Object.assign(restored.radialPond!.bankSectors![0], {
      outerRadius: 8.2,
      outerHeight: 28.55,
    });
    replace(restored);
  });

  it("includes actual mask tiles and their blends in finite-field support admission", async () => {
    const { terrain } = await fixture();
    terrain.registerFlatZone(
      grade({
        centerX: 350.5,
        centerZ: 400.5,
        width: 1,
        depth: 1,
        blendRadius: 2,
        tileMask: new Set(["349,400", "351,402"]),
        tileMaskTiles: [
          { x: 349, z: 400 },
          { x: 351, z: 402 },
        ],
        tileMaskBounds: { minX: 349, maxX: 351, minZ: 400, maxZ: 402 },
      }),
    );
    expect(terrain.captureCanonicalGroundLease().supportBounds).toEqual([
      { minX: 347, maxX: 354, minZ: 398, maxZ: 405 },
    ]);
  });

  it("keeps strict-distance height precedence on grass-only replacements and exact noops", async () => {
    const { terrain } = await fixture();
    const first = grade({ id: "tie-first", height: 30 });
    const second = grade({ id: "tie-second", height: 40 });
    terrain.registerFlatZone(first);
    terrain.registerFlatZone(second);
    const lease = terrain.captureCanonicalGroundLease();
    expect(lease.sampleHeight(350, 400)).toBe(30);
    terrain.registerFlatZone({ ...first, excludeGrass: false });
    expect(lease.isCurrent()).toBe(true);
    expect(lease.sampleHeight(350, 400)).toBe(30);
    expect(
      terrain["flatZonesByTile"].get("3_4")!.map((zone) => zone.id),
    ).toEqual(["tie-first", "tie-second"]);
    const withBounds = {
      ...first,
      grassExclusionBounds: { minX: 349, maxX: 351, minZ: 399, maxZ: 401 },
    };
    terrain.registerFlatZone(withBounds);
    expect(lease.isCurrent()).toBe(true);
    expect(lease.sampleHeight(350, 400)).toBe(30);
    const grassRevision = terrain["grassSurfaceRevision"];
    terrain.registerFlatZone({ ...withBounds });
    expect(terrain["grassSurfaceRevision"]).toBe(grassRevision);
    expect(terrain.captureCanonicalGroundLease().revision).toBe(lease.revision);
    terrain.registerFlatZone({ ...withBounds, carveInset: 0.2 });
    expect(lease.isCurrent()).toBe(true); // Mesh carving does not change canonical h(x,z).
    expect(lease.sampleHeight(350, 400)).toBe(30);
  });

  it("invalidates on actual grade changes/removal without reviving superseded leases", async () => {
    const { terrain } = await fixture();
    const original = grade();
    const before = terrain.captureCanonicalGroundLease();
    terrain.registerFlatZone(original);
    expect(before.isCurrent()).toBe(false);
    const first = terrain.captureCanonicalGroundLease();
    terrain.registerFlatZone({ ...original, height: 41 });
    expect(first.isCurrent()).toBe(false);
    expect(() => first.sampleHeight(350, 400)).toThrow(/stale/);
    const second = terrain.captureCanonicalGroundLease();
    expect(second.sampleHeight(350, 400)).toBe(41);
    terrain.registerFlatZone(original);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
    const restored = terrain.captureCanonicalGroundLease();
    terrain.unregisterFlatZone("missing-grade");
    expect(restored.isCurrent()).toBe(true);
    terrain.unregisterFlatZone(original.id);
    expect(restored.isCurrent()).toBe(false);
    expect(terrain.captureCanonicalGroundLease().supportBounds).toEqual([]);
  });

  it("keeps actual arena membership and height stable through metadata updates and repeated manifest loading", async () => {
    const { terrain } = await fixture(true);
    const ids = [...terrain["arenaFloorZoneIds"]];
    expect(ids).toHaveLength(3);
    const floor = terrain["flatZones"].get(ids[0])!;
    const lease = terrain.captureCanonicalGroundLease();
    const height = lease.sampleHeight(floor.centerX, floor.centerZ);
    terrain.registerFlatZone({ ...floor, excludeGrass: false });
    expect([...terrain["arenaFloorZoneIds"]]).toEqual(ids);
    expect(lease.isCurrent()).toBe(true);
    expect(lease.sampleHeight(floor.centerX, floor.centerZ)).toBe(height);
    terrain["loadFlatZonesFromManifest"]();
    expect(lease.isCurrent()).toBe(true);
    expect(lease.sampleHeight(floor.centerX, floor.centerZ)).toBe(height);
    expect([...terrain["arenaFloorZoneIds"]]).toEqual(ids);
    expect(terrain.captureCanonicalGroundLease().supportBounds).toHaveLength(
      19,
    );
    const base = terrain["arenaGradeHeight"]!;
    terrain["setCanonicalArenaGrade"](new Set(ids), base);
    expect(lease.isCurrent()).toBe(true);
    terrain["setCanonicalArenaGrade"](new Set(ids), base + 1);
    expect(lease.isCurrent()).toBe(false);
    const changed = terrain.captureCanonicalGroundLease();
    terrain["setCanonicalArenaGrade"](new Set(ids.slice(1)), base + 1);
    expect(changed.isCurrent()).toBe(false);
  });

  it("does not invalidate canonical ground for lifecycle-owned grass-only silhouettes", async () => {
    const { terrain } = await fixture(true);
    const lease = terrain.captureCanonicalGroundLease();
    const height = lease.sampleHeight(350, 400);
    const owner = terrain.acquireGrassExclusionPolygons([
      {
        id: "canonical-grass-only",
        minX: 348,
        maxX: 352,
        minZ: 398,
        maxZ: 402,
        vertices: [
          { x: 348, z: 398 },
          { x: 352, z: 398 },
          { x: 352, z: 402 },
          { x: 348, z: 402 },
        ],
      },
    ]);
    expect(lease.isCurrent()).toBe(true);
    expect(lease.sampleHeight(350, 400)).toBe(height);
    owner.release();
    owner.release();
    expect(lease.isCurrent()).toBe(true);
    expect(terrain.captureCanonicalGroundLease().revision).toBe(lease.revision);
  });
});

describe("complete cooperative terrain preparation leases", () => {
  it("binds exact actual worker centers and linear palette at admission and every resume", async () => {
    const { terrain } = await fixture();
    const { actual, worker } = preparationProvider(terrain);
    const centers = structuredClone(worker.biomeCenters);
    const biomes = structuredClone(worker.biomes);
    const capture = () => actual.capturePreparationLease(centers, biomes);
    const lease = capture();
    expect(lease.isCurrent()).toBe(true);
    centers[0].influence++;
    expect(lease.isCurrent()).toBe(false);
    expect(capture().isCurrent()).toBe(false);
    centers[0].influence--;
    expect(lease.isCurrent()).toBe(false);
    expect(capture().isCurrent()).toBe(true);
    const name = Object.keys(biomes)[0];
    const red = biomes[name].color.r;
    const paletteLease = capture();
    biomes[name].color.r = red + 0.01;
    expect(paletteLease.isCurrent()).toBe(false);
    expect(capture().isCurrent()).toBe(false);
    biomes[name].color.r = red;
    expect(paletteLease.isCurrent()).toBe(false);
    const missing = biomes[name];
    delete biomes[name];
    expect(capture().isCurrent()).toBe(false);
    biomes[name] = missing;
    expect(capture().isCurrent()).toBe(true);
  });

  it("keeps unchanged inputs current, but never revives changed grades, scalar config or terminal owners", async () => {
    const { terrain, world } = await fixture(true);
    const provider = preparationProvider(terrain);
    const unchanged = provider.capturePreparationLease();
    for (const [x, z] of [
      [350, 400],
      [339, 393],
      [450, 458],
    ]) {
      expect(Number.isFinite(provider.getHeightAtComputed(x, z))).toBe(true);
      expect(unchanged.isCurrent()).toBe(true);
    }
    terrain.registerFlatZone(grade());
    expect(unchanged.isCurrent()).toBe(false);
    terrain.unregisterFlatZone("canonical-test-grade");
    expect(unchanged.isCurrent()).toBe(false);

    const tileLease = provider.capturePreparationLease();
    const size = terrain["CONFIG"].TILE_SIZE;
    terrain["CONFIG"].TILE_SIZE = size * 2;
    expect(tileLease.isCurrent()).toBe(false);
    expect(provider.capturePreparationLease().isCurrent()).toBe(false);
    terrain["CONFIG"].TILE_SIZE = size;
    expect(tileLease.isCurrent()).toBe(false);
    const waterLease = provider.capturePreparationLease();
    terrain["CONFIG"].WATER_THRESHOLD++;
    expect(waterLease.isCurrent()).toBe(false);
    terrain["CONFIG"].WATER_THRESHOLD--;
    expect(waterLease.isCurrent()).toBe(false);

    const live = provider.capturePreparationLease();
    expect(live.isCurrent()).toBe(true);
    world.destroy();
    expect(live.isCurrent()).toBe(false);
    expect(() => provider.capturePreparationLease()).toThrow(
      /initialized live terrain/,
    );
  });

  it("detects in-place biome centers, colors and height-config edits without reviving a checked stale lease", async () => {
    const { terrain } = await fixture();
    const provider = preparationProvider(terrain);
    const center = terrain["biomeSystem"].getBiomeCenters()[0];
    const centerX = center.x;
    const centerLease = provider.capturePreparationLease();
    center.x++;
    expect(centerLease.isCurrent()).toBe(false);
    expect(provider.capturePreparationLease().isCurrent()).toBe(false);
    provider.worker.biomeCenters[0].x = center.x;
    expect(provider.capturePreparationLease().isCurrent()).toBe(true);
    center.x = centerX;
    provider.worker.biomeCenters[0].x = centerX;
    expect(centerLease.isCurrent()).toBe(false);

    const name = Object.keys(BIOMES)[0];
    const color = BIOMES[name].color;
    const original = provider.getBiomeColor(name);
    expect(Object.isFrozen(original)).toBe(true);
    const colorLease = provider.capturePreparationLease();
    try {
      BIOMES[name].color = color === 0 ? 0xffffff : 0;
      expect(colorLease.isCurrent()).toBe(false);
      expect(provider.getBiomeColor(name)).not.toBe(original);
      expect(provider.capturePreparationLease().isCurrent()).toBe(false);
      provider.worker.biomes[name].color = { ...provider.getBiomeColor(name) };
      expect(provider.capturePreparationLease().isCurrent()).toBe(true);
    } finally {
      BIOMES[name].color = color;
      provider.worker.biomes[name].color = { ...original };
    }
    expect(colorLease.isCurrent()).toBe(false);

    const config = BIOME_CONFIGS[Object.keys(BIOME_CONFIGS)[0]];
    const amplitude = config.amplitude;
    const configLease = provider.capturePreparationLease();
    try {
      config.amplitude++;
      expect(configLease.isCurrent()).toBe(false);
      expect(provider.capturePreparationLease().isCurrent()).toBe(false);
      expect(
        preparationProvider(terrain).capturePreparationLease().isCurrent(),
      ).toBe(false);
    } finally {
      config.amplitude = amplitude;
    }
    expect(configLease.isCurrent()).toBe(false);
    const biomeOwnerLease = provider.capturePreparationLease();
    terrain["initializeTerrainGenerator"]();
    expect(biomeOwnerLease.isCurrent()).toBe(false);
  });

  it("detects road registration, same-owner rebuilds and public in-place authoring edits", async () => {
    const { terrain, world } = await fixture(true);
    const provider = preparationProvider(terrain);
    const beforeRoads = provider.capturePreparationLease();
    const roads = world.register(
      "roads",
      RoadNetworkSystem,
    ) as RoadNetworkSystem;
    expect(beforeRoads.isCurrent()).toBe(false);
    const uninitialized = provider.capturePreparationLease();
    expect(uninitialized.isCurrent()).toBe(false);
    await roads.init();
    // World.init awaits every init wave before Terrain.start/precompile runs;
    // this empty initialized road owner is valid before RoadNetwork.start.
    const initializedBeforeStart = provider.capturePreparationLease();
    expect(initializedBeforeStart.isCurrent()).toBe(true);
    expect(provider.actual.calculateRoadInfluenceAtVertex(350, 400, 3, 4)).toBe(
      0,
    );
    await roads.start();
    expect(initializedBeforeStart.isCurrent()).toBe(false);
    expect(uninitialized.isCurrent()).toBe(false);
    const rebuilt = provider.capturePreparationLease();
    expect(rebuilt.isCurrent()).toBe(true);
    roads["buildTileCache"]();
    expect(rebuilt.isCurrent()).toBe(false);
    const road = roads.getRoads()[0];
    const width = road.width;
    const widthLease = provider.capturePreparationLease();
    road.width += 0.5;
    expect(widthLease.isCurrent()).toBe(false);
    road.width = width;
    expect(widthLease.isCurrent()).toBe(false);
    const x = road.path[0].x;
    const pointLease = provider.capturePreparationLease();
    road.path[0].x++;
    expect(pointLease.isCurrent()).toBe(false);
    road.path[0].x = x;
    expect(pointLease.isCurrent()).toBe(false);
    const listLease = provider.capturePreparationLease();
    const removed = roads.getRoads().pop()!;
    expect(listLease.isCurrent()).toBe(false);
    roads.getRoads().push(removed);
    expect(listLease.isCurrent()).toBe(false);

    const configuredWidth = roads.config.roadWidth;
    const configLease = provider.capturePreparationLease();
    roads.config.roadWidth++;
    expect(configLease.isCurrent()).toBe(false);
    roads.config.roadWidth = configuredWidth;
    expect(configLease.isCurrent()).toBe(false);

    const beforeCacheBuild = provider.capturePreparationLease();
    const cacheBuild = roads["buildTileCacheAsync"]();
    const duringCacheBuild = provider.capturePreparationLease();
    expect(beforeCacheBuild.isCurrent()).toBe(false);
    expect(duringCacheBuild.isCurrent()).toBe(false);
    await cacheBuild;
    expect(duringCacheBuild.isCurrent()).toBe(false);
    expect(provider.capturePreparationLease().isCurrent()).toBe(true);

    const generating = roads.start();
    const midGeneration = provider.capturePreparationLease();
    expect(midGeneration.isCurrent()).toBe(false);
    await generating;
    expect(midGeneration.isCurrent()).toBe(false);
    expect(provider.capturePreparationLease().isCurrent()).toBe(true);
    const live = provider.capturePreparationLease();
    roads.destroy();
    expect(live.isCurrent()).toBe(false);
    expect(provider.capturePreparationLease().isCurrent()).toBe(false);
  });

  it("owns shared road query publications and detects authoritative segment and boundary edits", async () => {
    const { terrain, world } = await fixture(true);
    const roads = world.register(
      "roads",
      RoadNetworkSystem,
    ) as RoadNetworkSystem;
    await roads.init();
    await roads.start();
    const provider = preparationProvider(terrain);
    const lease = provider.capturePreparationLease();
    const segments = roads.getRoadSegmentsForTile(3, 3);
    expect(segments.length).toBeGreaterThan(0);
    expect(Object.isFrozen(segments)).toBe(true);
    expect(Object.isFrozen(segments[0])).toBe(true);
    expect(Object.isFrozen(segments[0].start)).toBe(true);
    expect(Reflect.set(segments[0].start, "x", 999)).toBe(false);
    expect(Reflect.set(segments, "length", 0)).toBe(false);
    // Populating more derived caches must not invalidate a stable lease.
    roads.getRoadSegmentsForTile(2, 3);
    roads.getRoadSegmentsForTile(-1, 0);
    expect(lease.isCurrent()).toBe(true);
    const stored = [...roads["tileRoadCache"].values()].find(
      (values) => values.length > 0,
    )![0];
    const x = stored.start.x;
    stored.start.x++;
    expect(lease.isCurrent()).toBe(false);
    stored.start.x = x;
    expect(lease.isCurrent()).toBe(false);

    const boundaryLease = provider.capturePreparationLease();
    roads["recordBoundaryExitForClip"](
      400,
      350,
      0,
      roads.getRoads()[0].id,
      3,
      3,
      "east",
    );
    expect(boundaryLease.isCurrent()).toBe(false);
    const exit = roads.getAllBoundaryExits()[0];
    const exitLease = provider.capturePreparationLease();
    exit.position.x++;
    expect(exitLease.isCurrent()).toBe(false);
    exit.position.x--;
    expect(exitLease.isCurrent()).toBe(false);
  });

  it("reports actual compact-road lease capture/check cost without a machine-dependent timing assertion", async () => {
    const { terrain, world } = await fixture(true);
    const roads = world.register(
      "roads",
      RoadNetworkSystem,
    ) as RoadNetworkSystem;
    await roads.init();
    await roads.start();
    const provider = preparationProvider(terrain);
    const captures: number[] = [],
      checks: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const lease = provider.capturePreparationLease();
      captures.push(performance.now() - start);
      const checkStart = performance.now();
      let current = true;
      for (let j = 0; j < 10; j++) current &&= lease.isCurrent();
      checks.push((performance.now() - checkStart) / 10);
      expect(current).toBe(true);
    }
    captures.sort((a, b) => a - b);
    checks.sort((a, b) => a - b);
    const receipt = {
      roads: roads.getRoads().length,
      points: roads.getRoads().reduce((sum, road) => sum + road.path.length, 0),
      cachedSegments: [...roads["tileRoadCache"].values()].reduce(
        (sum, values) => sum + values.length,
        0,
      ),
      captureMedianMs: captures[50],
      captureP95Ms: captures[95],
      captureMaxMs: captures[99],
      checkMedianMs: checks[50],
      checkP95Ms: checks[95],
      checkMaxMs: checks[99],
    };
    process.stdout.write(
      `[TerrainPreparationLease CPU] ${JSON.stringify(receipt)}\n`,
    );
  });
});
