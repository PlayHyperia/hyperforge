import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  createGrassTerrainSurfaceOperations,
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  type GrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceZone,
} from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { createAuthoredTerrainSurfaceOperations } from "../AuthoredTerrainSurface";
import { TerrainSystem } from "../TerrainSystem";
import { resolveWorldTerrainProfile } from "../WorldTerrainProfile";
import type { GrassWorkerSetup } from "../GrassVisualManager";
import {
  COMPACT_TERRAIN_COMPOSITION,
  type CompactPondBankField,
} from "../CompactTerrainPalette";

type Internals = {
  flatZones: Map<string, GrassTerrainSurfaceZone>;
  arenaFloorZoneIds: Set<string>;
  arenaGradeHeight: number | null;
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  bindCompactPondBankField(): CompactPondBankField;
  getAuthoredSurfaceCandidates(
    x: number,
    z: number,
  ): readonly GrassTerrainSurfaceZone[];
  getFlatZoneHeight(x: number, z: number): number | null;
  getHeightAtComputed(x: number, z: number): number;
  getTerrainSurfaceForRegion(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): GrassTerrainSurfaceSnapshot;
  isGrassExcludedAt(x: number, z: number): boolean;
};

const snapshotOperations = createGrassTerrainSurfaceOperations();
const surfaceOperations = createAuthoredTerrainSurfaceOperations();

/** Real initialized CPU world and manifest loaders; no rendering or server start. */
async function withTerrain(
  run: (terrain: TerrainSystem, internals: Internals) => void,
  compositionProfile = false,
) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  try {
    if (compositionProfile) {
      await DataManager.getInstance().initialize();
      terrain["activeTerrainProfile"] = resolveWorldTerrainProfile({
        ...DataManager.getWorldTerrainProfile(),
        southernMeadow: {
          schemaVersion: 1,
          minX: 304,
          maxX: 500,
          minZ: 345,
          maxZ: 535,
          featherX: 24,
          featherZ: 24,
          northHeight: 26.8,
          southHeight: 25.3,
          crossFall: 1,
          rollAmplitude: 0.65,
          rollWavelength: 100,
        },
      });
    }
    await terrain.init();
    const internals = terrain as unknown as Internals;
    internals.loadWaterBodiesFromManifest();
    internals.loadFlatZonesFromManifest();
    run(terrain, internals);
  } finally {
    world.destroy();
  }
}

async function withCompositionTerrain(
  run: (terrain: TerrainSystem, internals: Internals) => void,
) {
  await withTerrain(run, true);
}

/** Copy the actual authored pond; only add valid, manifest-shaped composition. */
function compositionZone(internals: Internals): GrassTerrainSurfaceZone {
  const zone = structuredClone(internals.flatZones.get("haven_pond_floor")!);
  const radial = zone.radialPond!;
  const bankSectors = radial.bankSectors?.length
    ? radial.bankSectors
    : [-Math.PI / 2, Math.PI / 2].map((bearing) => ({
        bearing,
        halfWidth: Math.PI / 4,
        innerRadius: (radial.bedRadius + radial.bankInnerRadius) / 2,
        innerHeight: radial.bankHeight,
      }));
  return {
    ...zone,
    radialPond: {
      ...radial,
      bankSectors,
      bankComposition: {
        schemaVersion: 1,
        sectors: [{ sectorIndex: 0, surface: "sedge-shelf" }],
      },
    },
  };
}

describe("actual restart-owned pond composition", () => {
  it("tracks groundCover addition, edits and omission in canonical identity and seals nested metadata at bind", async () => {
    await withCompositionTerrain((terrain, internals) => {
      const input = compositionZone(internals);
      terrain.registerFlatZone(input);
      const before = terrain.captureCanonicalGroundLease();
      const changed = structuredClone(input);
      Object.assign(changed.radialPond!.bankComposition!.sectors[0], {
        groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
      });
      terrain.registerFlatZone(changed);
      expect(before.isCurrent()).toBe(false);
      const stable = terrain.captureCanonicalGroundLease();
      terrain.registerFlatZone(structuredClone(changed));
      expect(stable.isCurrent()).toBe(true);
      const edited = structuredClone(changed);
      Reflect.set(
        edited.radialPond!.bankComposition!.sectors[0].groundCover!,
        "fullHeight",
        0.16,
      );
      terrain.registerFlatZone(edited);
      expect(stable.isCurrent()).toBe(false);
      const current = terrain.captureCanonicalGroundLease();
      const field = internals.bindCompactPondBankField();
      expect(Object.isFrozen(field.sectors[0].groundCover)).toBe(true);
      const owned = internals.flatZones.get(input.id)!.radialPond!
        .bankComposition!.sectors[0].groundCover!;
      expect(Object.isFrozen(owned)).toBe(true);
      expect(Reflect.set(owned, "fullHeight", 0.2)).toBe(false);
      expect(() => terrain.registerFlatZone(changed)).toThrow();
      expect(() => terrain.registerFlatZone(input)).toThrow();
      expect(current.isCurrent()).toBe(true);
      const remote = internals.getTerrainSurfaceForRegion(800, 800, 801, 801);
      const copy = remote.zones.find((zone) => zone.id === input.id)!
        .radialPond!.bankComposition!.sectors[0].groundCover!;
      expect(copy).toEqual({ emergenceHeight: 0.04, fullHeight: 0.16 });
      expect(copy).not.toBe(owned);
      expect(Object.isFrozen(copy)).toBe(true);
    });
  });
  it("binds detached immutable owners and includes the exact terrain/water pair in distant snapshots", async () => {
    await withCompositionTerrain((terrain, internals) => {
      const input = compositionZone(internals);
      terrain.registerFlatZone(input);
      const field = internals.bindCompactPondBankField();
      const owned = internals.flatZones.get(input.id)!;
      const composition = owned.radialPond!.bankComposition!;
      expect(field).toMatchObject({
        id: "composition-v1",
        zoneId: "haven_pond_floor",
        centerX: input.centerX,
        centerZ: input.centerZ,
        pond: { id: "haven_pond_water" },
      });
      expect(field.sectors[0].surface).toBe("sedge-shelf");
      expect(field.sectors[0]).not.toBe(input.radialPond!.bankSectors![0]);
      expect(composition).not.toBe(input.radialPond!.bankComposition);
      for (const value of [
        field,
        field.pond,
        field.sectors,
        ...field.sectors,
        composition,
        composition.sectors,
        ...composition.sectors,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      expect(
        Reflect.set(
          input.radialPond!.bankComposition!.sectors[0],
          "surface",
          "cutbank",
        ),
      ).toBe(true);
      expect(composition.sectors[0].surface).toBe("sedge-shelf");
      expect(field.sectors[0].surface).toBe("sedge-shelf");
      expect(internals.bindCompactPondBankField()).toBe(field);

      for (const [x, z] of [
        [-500, -500],
        [900, 900],
      ]) {
        const snapshot = internals.getTerrainSurfaceForRegion(
          x,
          z,
          x + 1,
          z + 1,
        );
        expect(snapshot.zones.map((zone) => zone.id)).toEqual([input.id]);
        expect(snapshot.waterBodies.map((body) => body.id)).toEqual([
          field.pond.id,
        ]);
        expect(snapshot.zones[0].radialPond!.bankComposition).toEqual(
          composition,
        );
        expect(snapshot.zones[0].radialPond!.bankComposition).not.toBe(
          composition,
        );
        expect(snapshot.waterBodies[0]).toMatchObject(field.pond);
        expect(snapshot.waterBodies[0]).not.toBe(field.pond);
        expect(
          Object.isFrozen(
            snapshot.zones[0].radialPond!.bankComposition!.sectors[0],
          ),
        ).toBe(true);
        expect(snapshotOperations.getWaterSurfaceAt(snapshot, 16, x, z)).toBe(
          16,
        );
      }
    });
  });

  it("includes composition in canonical equality before binding and preserves identical registration leases", async () => {
    await withCompositionTerrain((terrain, internals) => {
      const input = compositionZone(internals);
      terrain.registerFlatZone(input);
      const setup = internals.buildGrassWorkerSetup();
      const region = {
        minX: input.centerX - 1,
        maxX: input.centerX + 1,
        minZ: input.centerZ - 1,
        maxZ: input.centerZ + 1,
      };
      const canonical = terrain.captureCanonicalGroundLease();
      const grass = setup.prepareGroundingInputs!(region);
      const revision = terrain["grassSurfaceRevision"];
      terrain.registerFlatZone(structuredClone(input));
      expect(canonical.isCurrent()).toBe(true);
      expect(grass.isCurrent()).toBe(true);
      expect(terrain["grassSurfaceRevision"]).toBe(revision);
      const changed = structuredClone(input);
      Reflect.set(
        changed.radialPond!.bankComposition!.sectors[0],
        "surface",
        "cutbank",
      );
      terrain.registerFlatZone(changed);
      expect(canonical.isCurrent()).toBe(false);
      expect(grass.isCurrent()).toBe(false);
      const next = terrain.captureCanonicalGroundLease();
      const absent = structuredClone(changed);
      delete absent.radialPond!.bankComposition;
      terrain.registerFlatZone(absent);
      expect(next.isCurrent()).toBe(false);
      expect(internals.flatZones.get(input.id)!.radialPond).not.toHaveProperty(
        "bankComposition",
      );
    });
  });

  it("rejects bound mutations, removals and overlapping registrations before changing leases or owned maps", async () => {
    await withCompositionTerrain((terrain, internals) => {
      const input = compositionZone(internals);
      terrain.registerFlatZone(input);
      const remote = {
        id: "composition-remote-zone",
        centerX: 800,
        centerZ: 800,
        width: 2,
        depth: 2,
        height: 28,
        blendRadius: 1,
      };
      terrain.registerFlatZone(remote);
      const field = internals.bindCompactPondBankField();
      const setup = internals.buildGrassWorkerSetup();
      const region = {
        minX: input.centerX - 1,
        maxX: input.centerX + 1,
        minZ: input.centerZ - 1,
        maxZ: input.centerZ + 1,
      };
      const canonical = terrain.captureCanonicalGroundLease();
      const grass = setup.prepareGroundingInputs!(region);
      const revision = terrain["grassSurfaceRevision"];
      terrain.registerFlatZone(structuredClone(input));
      expect(canonical.isCurrent()).toBe(true);
      expect(grass.isCurrent()).toBe(true);
      expect(terrain["grassSurfaceRevision"]).toBe(revision);
      const owned = internals.flatZones.get(input.id);
      const entries = [...internals.flatZones];
      const changed = structuredClone(input);
      Reflect.set(
        changed.radialPond!.bankComposition!.sectors[0],
        "surface",
        "cutbank",
      );
      const absent = structuredClone(input);
      delete absent.radialPond!.bankComposition;
      const cases = [
        () => terrain.registerFlatZone(changed),
        () => terrain.registerFlatZone(absent),
        () =>
          terrain.registerFlatZone({ ...input, height: input.height + 0.01 }),
        () =>
          terrain.registerFlatZone({
            ...input,
            excludeGrass: !input.excludeGrass,
          }),
        () => terrain.unregisterFlatZone(input.id),
        () =>
          terrain.registerFlatZone({
            ...remote,
            id: "composition-overlap",
            centerX: input.centerX,
            centerZ: input.centerZ,
          }),
        () =>
          terrain.registerFlatZone({
            ...remote,
            centerX: input.centerX,
            centerZ: input.centerZ,
          }),
      ];
      for (const edit of cases) {
        expect(edit).toThrow(/require restart/);
        expect([...internals.flatZones]).toEqual(entries);
        expect(internals.flatZones.get(input.id)).toBe(owned);
        expect(terrain["grassSurfaceRevision"]).toBe(revision);
        expect(canonical.isCurrent()).toBe(true);
        expect(grass.isCurrent()).toBe(true);
        expect(internals.bindCompactPondBankField()).toBe(field);
      }
      terrain.registerFlatZone({ ...remote, height: 29 });
      expect(canonical.isCurrent()).toBe(false);
      expect(grass.isCurrent()).toBe(true);
      expect(internals.bindCompactPondBankField()).toBe(field);
      terrain.unregisterFlatZone(remote.id);
      expect(internals.flatZones.has(remote.id)).toBe(false);
      expect(grass.isCurrent()).toBe(true);
    });
  });

  it("protects actual mask support outside rectangular metadata before accepting any bound edit", async () => {
    await withCompositionTerrain((terrain, internals) => {
      const input = compositionZone(internals);
      terrain.registerFlatZone(input);
      const tile = {
        x: Math.floor(input.centerX),
        z: Math.floor(input.centerZ),
      };
      const key = `${tile.x},${tile.z}`;
      // The actual tile lies in the pond, while the small descriptive rectangle
      // is 30 m away but remains in the real 3x3 authored candidate neighborhood.
      const remoteRectangle = {
        id: "bound-mask-prior-owner",
        centerX: input.centerX + 30,
        centerZ: input.centerZ,
        width: 2,
        depth: 2,
        height: input.height,
        blendRadius: 1,
      };
      const prior = { ...remoteRectangle, tileMask: new Set([key]) };
      terrain.registerFlatZone(prior);
      expect(internals.isGrassExcludedAt(tile.x + 0.25, tile.z + 0.25)).toBe(
        true,
      );
      internals.bindCompactPondBankField();
      const setup = internals.buildGrassWorkerSetup();
      const bounds = {
        minX: tile.x,
        maxX: tile.x + 1,
        minZ: tile.z,
        maxZ: tile.z + 1,
      };
      const canonical = terrain.captureCanonicalGroundLease();
      const grass = setup.prepareGroundingInputs!(bounds);
      const revision = terrain["grassSurfaceRevision"];
      const entries = [...internals.flatZones];
      const candidates = [
        { ...remoteRectangle, id: "bound-mask-set", tileMask: new Set([key]) },
        // The admitted tile-list form contributes to canonical support bounds;
        // guarding it is conservative even without a matching core Set.
        {
          ...remoteRectangle,
          id: "bound-mask-tiles",
          tileMaskTiles: [{ ...tile }],
        },
        {
          ...remoteRectangle,
          id: "bound-mask-both",
          tileMask: new Set([key]),
          tileMaskTiles: [{ ...tile }],
          tileMaskBounds: {
            minX: tile.x,
            maxX: tile.x,
            minZ: tile.z,
            maxZ: tile.z,
          },
        },
      ];
      for (const candidate of candidates) {
        expect(() => terrain.registerFlatZone(candidate)).toThrow(
          /require restart/,
        );
        expect([...internals.flatZones]).toEqual(entries);
        expect(terrain["grassSurfaceRevision"]).toBe(revision);
        expect(canonical.isCurrent()).toBe(true);
        expect(grass.isCurrent()).toBe(true);
      }
      expect(() => terrain.unregisterFlatZone(prior.id)).toThrow(
        /require restart/,
      );
      expect(internals.flatZones.get(prior.id)).toBe(
        entries.find(([id]) => id === prior.id)![1],
      );
      // Unlike tile masks, remote grass-only bounds are already invalid data.
      expect(() =>
        terrain.registerFlatZone({
          ...remoteRectangle,
          id: "bound-grass-bounds-invalid",
          grassExclusionBounds: bounds,
        }),
      ).toThrow(/grassExclusionBounds must remain inside grading support/);
      expect([...internals.flatZones]).toEqual(entries);
      expect(terrain["grassSurfaceRevision"]).toBe(revision);
      expect(canonical.isCurrent()).toBe(true);
      expect(grass.isCurrent()).toBe(true);
    });
  });

  it("seals previously exposed real water bodies and the array, not merely register()", async () => {
    await withCompositionTerrain((terrain, internals) => {
      terrain.registerFlatZone(compositionZone(internals));
      const registry = terrain.getWaterBodyRegistry();
      const bodies = registry.getAllBodies();
      const body = bodies.find((entry) => entry.id === "haven_pond_water")!;
      const expected = structuredClone(body);
      const waterLease = registry.captureRegion({
        minX: body.centerX,
        maxX: body.centerX,
        minZ: body.centerZ,
        maxZ: body.centerZ,
      });
      internals.bindCompactPondBankField();
      expect(Object.isFrozen(bodies)).toBe(true);
      expect(Object.isFrozen(body)).toBe(true);
      expect(registry.getBodyAt(body.centerX, body.centerZ)).toBe(body);
      expect(() =>
        registry.register({ ...body, id: "sealed-added-water" }),
      ).toThrow(/require restart/);
      expect(() => registry.register({ ...body })).toThrow(/require restart/);
      expect(Reflect.set(body, "surfaceY", body.surfaceY + 1)).toBe(false);
      expect(() =>
        Object.defineProperty(body, "radius", { value: body.radius + 1 }),
      ).toThrow(TypeError);
      expect(() =>
        Array.prototype.push.call(bodies, { ...body, id: "array-bypass" }),
      ).toThrow(TypeError);
      expect(Reflect.set(bodies, "0", { ...body, surfaceY: 0 })).toBe(false);
      expect(Reflect.deleteProperty(bodies, "0")).toBe(false);
      expect(registry.getAllBodies()).toBe(bodies);
      expect(body).toEqual(expected);
      expect(waterLease.isCurrent()).toBe(true);
      expect(registry.getWaterSurfaceAt(body.centerX, body.centerZ)).toBe(
        expected.surfaceY,
      );
    });
  });

  it("does not seal or bind when registered water disagrees with the material owner", async () => {
    await withCompositionTerrain((terrain, internals) => {
      terrain.registerFlatZone(compositionZone(internals));
      const registry = terrain.getWaterBodyRegistry();
      const body = registry
        .getAllBodies()
        .find((entry) => entry.id === "haven_pond_water")!;
      const surfaceY = body.surfaceY;
      body.surfaceY += 0.01;
      expect(() => internals.bindCompactPondBankField()).toThrow(
        /water differs from material/,
      );
      expect(Object.isFrozen(body)).toBe(false);
      expect(Object.isFrozen(registry.getAllBodies())).toBe(false);
      body.surfaceY = surfaceY;
      expect(internals.bindCompactPondBankField().pond.surfaceY).toBe(surfaceY);
    });
  });

  it("retains the unselected mutable terrain/water lifecycle and regional omissions", async () => {
    await withTerrain((terrain, internals) => {
      const zone = compositionZone(internals);
      terrain.registerFlatZone(zone);
      const registry = terrain.getWaterBodyRegistry();
      const body = registry
        .getAllBodies()
        .find((entry) => entry.id === "haven_pond_water")!;
      expect(Object.isFrozen(body)).toBe(false);
      expect(Object.isFrozen(registry.getAllBodies())).toBe(false);
      const snapshot = internals.getTerrainSurfaceForRegion(900, 900, 901, 901);
      expect(snapshot.zones).toEqual([]);
      expect(snapshot.waterBodies).toEqual([]);
      const ground = terrain.captureCanonicalGroundLease();
      terrain.registerFlatZone({ ...zone, height: zone.height + 0.01 });
      expect(ground.isCurrent()).toBe(false);
      const originalY = body.surfaceY;
      body.surfaceY += 0.01;
      expect(registry.getWaterSurfaceAt(body.centerX, body.centerZ)).toBe(
        originalY + 0.01,
      );
      registry.register({
        ...body,
        id: "unselected-added-water",
        centerX: 900,
        centerZ: 900,
      });
      expect(registry.getBodyAt(900, 900)?.id).toBe("unselected-added-water");
      terrain.unregisterFlatZone(zone.id);
      expect(internals.flatZones.has(zone.id)).toBe(false);
    });
  });
});

describe("actual TerrainSystem regional grass snapshots", () => {
  it("owns rounded blend geometry and invalidates canonical ground and grass when it changes", async () => {
    await withTerrain((terrain, internals) => {
      const zone: GrassTerrainSurfaceZone = {
        id: "rounded-blend-lifecycle",
        centerX: 300,
        centerZ: 450,
        width: 10,
        depth: 10,
        blendRadius: 5,
        height: 40,
        excludeGrass: false,
      };
      terrain.registerFlatZone(zone);
      const setup = internals.buildGrassWorkerSetup();
      const region = { minX: 290, minZ: 440, maxX: 310, maxZ: 460 };
      const grass = setup.prepareGroundingInputs!(region);
      const ground = terrain.captureCanonicalGroundLease();
      const oldSnapshot = setup.getTerrainSurfaceForRegion(290, 440, 310, 460);
      const oldHeight = internals.getFlatZoneHeight(309, 459);
      const rounded = { ...zone, blendShape: "rounded" as const };
      terrain.registerFlatZone(rounded);
      expect(ground.isCurrent()).toBe(false);
      expect(grass.isCurrent()).toBe(false);
      expect(internals.flatZones.get(zone.id)!.blendShape).toBe("rounded");
      expect(
        oldSnapshot.zones.find((entry) => entry.id === zone.id),
      ).not.toHaveProperty("blendShape");
      expect(internals.getFlatZoneHeight(309, 459)).not.toBe(oldHeight);
      const currentGround = terrain.captureCanonicalGroundLease();
      const currentGrass = setup.prepareGroundingInputs!(region);
      terrain.registerFlatZone(rounded);
      expect(currentGround.isCurrent()).toBe(true);
      expect(currentGrass.isCurrent()).toBe(true);
      const owned = internals.flatZones.get(zone.id);
      expect(() =>
        terrain.registerFlatZone({ ...rounded, blendShape: undefined }),
      ).toThrow(/blendShape/);
      expect(internals.flatZones.get(zone.id)).toBe(owned);
      expect(currentGround.isCurrent()).toBe(true);
      expect(currentGrass.isCurrent()).toBe(true);
      const regionSnapshot = setup.getTerrainSurfaceForRegion(
        290,
        440,
        310,
        460,
      );
      expect(
        regionSnapshot.zones.find((entry) => entry.id === zone.id)!.blendShape,
      ).toBe("rounded");
      for (const [x, z] of [
        [310, 455],
        [308, 459],
        [309, 459],
      ]) {
        const candidates = snapshotOperations
          .createZoneIndex(regionSnapshot, 100)
          .getZonesAt(x, z);
        expect(
          surfaceOperations.resolveHeight(
            candidates,
            x,
            z,
            () => terrain.getProceduralHeightAt(x, z),
            new Set(regionSnapshot.arenaFloorIds),
            regionSnapshot.arenaGradeHeight,
          ),
        ).toBe(internals.getFlatZoneHeight(x, z));
      }
      const composed = {
        ...rounded,
        blendComposition: "smooth-union" as const,
      };
      terrain.registerFlatZone(composed);
      expect(currentGround.isCurrent()).toBe(false);
      expect(currentGrass.isCurrent()).toBe(false);
      expect(
        regionSnapshot.zones.find((entry) => entry.id === zone.id),
      ).not.toHaveProperty("blendComposition");
      const unionGround = terrain.captureCanonicalGroundLease();
      const unionGrass = setup.prepareGroundingInputs!(region);
      const unionSnapshot = setup.getTerrainSurfaceForRegion(
        290,
        440,
        310,
        460,
      );
      expect(
        unionSnapshot.zones.find((entry) => entry.id === zone.id)!
          .blendComposition,
      ).toBe("smooth-union");
      terrain.registerFlatZone(composed);
      expect(unionGround.isCurrent()).toBe(true);
      expect(unionGrass.isCurrent()).toBe(true);
      expect(() =>
        terrain.registerFlatZone({ ...composed, blendComposition: undefined }),
      ).toThrow(/blendComposition/);
      expect(unionGround.isCurrent()).toBe(true);
      expect(unionGrass.isCurrent()).toBe(true);
      terrain.registerFlatZone(zone);
      expect(unionGround.isCurrent()).toBe(false);
      expect(unionGrass.isCurrent()).toBe(false);
      expect(internals.getFlatZoneHeight(309, 459)).toBe(oldHeight);
    });
  });

  it("keeps distant inputs current through local edits with bounded revision history", async () => {
    await withTerrain((terrain, internals) => {
      const setup = internals.buildGrassWorkerSetup();
      const region = { minX: 310, minZ: 310, maxX: 320, maxZ: 320 };
      const untouched = setup.prepareGroundingInputs!(region);
      const regularlyChecked = setup.prepareGroundingInputs!(region);
      const remote = {
        id: "remote-grass-lifecycle",
        centerX: 450,
        centerZ: 450,
        width: 2,
        depth: 2,
        height: 28,
        blendRadius: 1,
      };
      terrain.registerFlatZone(remote);
      const revision = terrain["grassSurfaceRevision"];
      terrain.registerFlatZone(remote);
      expect(terrain["grassSurfaceRevision"]).toBe(revision);
      for (let i = 0; i < 34; i++) {
        // Exhaust history with actual height changes; identical registrations
        // deliberately do not invalidate canonical ground or grass anymore.
        terrain.registerFlatZone({ ...remote, height: 29 + (i % 2) });
        expect(regularlyChecked.isCurrent()).toBe(true);
      }
      expect(terrain["grassSurfaceChanges"]).toHaveLength(64);
      expect(untouched.isCurrent()).toBe(false);
      const local = setup.prepareGroundingInputs!({
        minX: 448,
        minZ: 448,
        maxX: 448,
        maxZ: 448,
      });
      terrain.unregisterFlatZone(remote.id);
      expect(local.isCurrent()).toBe(false); // Inclusive grading-support contact.
      expect(regularlyChecked.isCurrent()).toBe(true);
    });
  });

  it("owns grass-only bounds and invalidates leases without changing grading on replacement", async () => {
    await withTerrain((terrain, internals) => {
      const zone: GrassTerrainSurfaceZone = {
        id: "station-clearance-lifecycle",
        centerX: 320,
        centerZ: 320,
        width: 8,
        depth: 6,
        blendRadius: 2,
        height: 28,
        grassExclusionBounds: { minX: 319, maxX: 321, minZ: 319, maxZ: 321 },
      };
      terrain.registerFlatZone(zone);
      const setup = internals.buildGrassWorkerSetup();
      const region = { minX: 312, minZ: 312, maxX: 328, maxZ: 328 };
      const lease = setup.prepareGroundingInputs!(region);
      const oldSnapshot = setup.getTerrainSurfaceForRegion(312, 312, 328, 328);
      const oldBounds = structuredClone(zone.grassExclusionBounds);
      const heights: number[] = [];
      for (let x = 313; x <= 327; x += 0.5)
        for (let z = 314; z <= 326; z += 0.5)
          heights.push(internals.getHeightAtComputed(x, z));
      zone.grassExclusionBounds!.minX = 0;
      zone.height = 99;
      expect(internals.flatZones.get(zone.id)!.grassExclusionBounds).toEqual(
        oldBounds,
      );
      expect(internals.flatZones.get(zone.id)!.height).toBe(28);
      expect(lease.isCurrent()).toBe(true);
      const registered = internals.flatZones.get(zone.id)!;
      expect(() =>
        terrain.registerFlatZone({
          ...registered,
          grassExclusionBounds: { minX: 0, maxX: 321, minZ: 319, maxZ: 321 },
        }),
      ).toThrow();
      expect(internals.flatZones.get(zone.id)).toBe(registered);
      expect(lease.isCurrent()).toBe(true);
      terrain.registerFlatZone({
        ...registered,
        grassExclusionBounds: {
          minX: 319.5,
          maxX: 320.5,
          minZ: 319.5,
          maxZ: 320.5,
        },
      });
      expect(lease.isCurrent()).toBe(false);
      expect(
        oldSnapshot.zones.find((entry) => entry.id === zone.id)!
          .grassExclusionBounds,
      ).toEqual(oldBounds);
      const after: number[] = [];
      for (let x = 313; x <= 327; x += 0.5)
        for (let z = 314; z <= 326; z += 0.5)
          after.push(internals.getHeightAtComputed(x, z));
      expect(after).toEqual(heights);
      const next = setup.prepareGroundingInputs!(region);
      expect(next.isCurrent()).toBe(true);
      terrain.unregisterFlatZone(zone.id);
      expect(next.isCurrent()).toBe(false);
    });
  });

  it("owns bounded polygon contributions independently, preserves rocks and rejects collisions atomically", async () => {
    await withTerrain((terrain, internals) => {
      const setup = internals.buildGrassWorkerSetup();
      const region = { minX: 200, minZ: 200, maxX: 500, maxZ: 500 };
      const snapshot = () =>
        setup.getTerrainSurfaceForRegion(200, 200, 500, 500);
      const original = snapshot();
      expect(original.exclusionPolygons!.length).toBe(17);
      const polygon = {
        id: "owned-grass-footing",
        minX: 319.85,
        maxX: 320.15,
        minZ: 319.85,
        maxZ: 320.15,
        vertices: [
          { x: 319.85, z: 319.85 },
          { x: 320.15, z: 319.85 },
          { x: 320.15, z: 320.15 },
          { x: 319.85, z: 320.15 },
        ],
      };
      const input = setup.prepareGroundingInputs!(region);
      const owner = terrain.acquireGrassExclusionPolygons([polygon]);
      expect(input.isCurrent()).toBe(false);
      const added = snapshot();
      expect(added.zones).toEqual(original.zones);
      expect(added.exclusionPolygons!.slice(0, 17)).toEqual(
        original.exclusionPolygons,
      );
      expect(snapshotOperations.isGrassExcluded(added, 320, 320)).toBe(true);
      polygon.vertices[0].x = 100;
      expect(snapshot()).toEqual(added);
      const lease = setup.prepareGroundingInputs!(region);
      expect(() =>
        terrain.acquireGrassExclusionPolygons([added.exclusionPolygons![17]]),
      ).toThrow();
      expect(lease.isCurrent()).toBe(true);
      expect(snapshot()).toEqual(added);
      const second = terrain.acquireGrassExclusionPolygons([
        { ...added.exclusionPolygons![17], id: "second-owner" },
      ]);
      expect(lease.isCurrent()).toBe(false);
      expect(snapshot().exclusionPolygons).toHaveLength(19);
      owner.release();
      expect(
        snapshot().exclusionPolygons!.map((entry) => entry.id),
      ).not.toContain(polygon.id);
      expect(snapshot().exclusionPolygons!.at(-1)!.id).toBe("second-owner");
      const released = setup.prepareGroundingInputs!(region);
      owner.release();
      expect(released.isCurrent()).toBe(true);
      second.release();
      expect(snapshot()).toEqual(original);
      expect(added.exclusionPolygons).toHaveLength(18);
      const remainingCapacity =
        snapshotOperations.limits.maxExclusionPolygons -
        original.exclusionPolygons!.length;
      const capacity = Array.from(
        { length: remainingCapacity + 1 },
        (_, i) => ({
          ...added.exclusionPolygons![17],
          id: `overflow-${i}`,
        }),
      );
      expect(() => terrain.acquireGrassExclusionPolygons(capacity)).toThrow();
      expect(snapshot()).toEqual(original);
      const atCapacity = terrain.acquireGrassExclusionPolygons(
        capacity.slice(0, -1),
      );
      expect(snapshot().exclusionPolygons).toHaveLength(
        snapshotOperations.limits.maxExclusionPolygons,
      );
      const full = snapshot();
      expect(() =>
        terrain.acquireGrassExclusionPolygons(capacity.slice(-1)),
      ).toThrow();
      expect(snapshot()).toEqual(full);
      atCapacity.release();
      expect(snapshot()).toEqual(original);
    });
  });

  it("retains global registration order, exact 3x3 candidate universe, floors and final-height stencil samples", async () => {
    await withTerrain((terrain, internals) => {
      const setup = internals.buildGrassWorkerSetup();
      const halo = GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE;
      const bounds = terrain.getWorldTerrainProfile().bounds;
      const regions = [
        [330, 290, 370, 340],
        [349.75, 349.75, 350.25, 350.25],
        [367, 373, 388, 399],
        [315, 445, 345, 485],
        [-50.25, -50.25, -49.75, -49.75],
        [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ],
      ];
      let samples = 0;
      for (const [minX, minZ, maxX, maxZ] of regions) {
        const snapshot = setup.getTerrainSurfaceForRegion(
          minX - halo,
          minZ - halo,
          maxX + halo,
          maxZ + halo,
        );
        const ids = new Set(snapshot.zones.map((zone) => zone.id));
        expect(snapshot.zones.map((zone) => zone.id)).toEqual(
          [...internals.flatZones.keys()].filter((id) => ids.has(id)),
        );
        expect(snapshot.arenaFloorIds).toEqual(
          [...internals.arenaFloorZoneIds].filter((id) => ids.has(id)),
        );
        expect(snapshot.arenaGradeHeight).toBe(internals.arenaGradeHeight);
        snapshotOperations.validateSnapshot(snapshot);
        const index = snapshotOperations.createZoneIndex(
          snapshot,
          setup.tileSize,
        );
        const floorIds = new Set(snapshot.arenaFloorIds);
        for (const x of [minX, (minX + maxX) / 2, maxX]) {
          for (const z of [minZ, (minZ + maxZ) / 2, maxZ]) {
            for (const [dx, dz] of [
              [0, 0],
              [-halo, 0],
              [halo, 0],
              [0, -halo],
              [0, halo],
            ]) {
              const sx = x + dx,
                sz = z + dz;
              const candidates = index.getZonesAt(sx, sz);
              expect(candidates.map((zone) => zone.id)).toEqual(
                internals
                  .getAuthoredSurfaceCandidates(sx, sz)
                  .map((zone) => zone.id),
              );
              const flat = surfaceOperations.resolveHeight(
                candidates,
                sx,
                sz,
                () => terrain.getProceduralHeightAt(sx, sz),
                floorIds,
                snapshot.arenaGradeHeight,
              );
              expect(flat).toBe(internals.getFlatZoneHeight(sx, sz));
              expect(
                surfaceOperations.isGrassExcluded(candidates, sx, sz),
              ).toBe(internals.isGrassExcludedAt(sx, sz));
              expect(
                snapshotOperations.getWaterSurfaceAt(
                  snapshot,
                  setup.terrainConfig.WATER_THRESHOLD,
                  sx,
                  sz,
                ),
              ).toBe(terrain.getWaterBodyRegistry().getWaterSurfaceAt(sx, sz));
              if (flat !== null)
                expect(flat).toBe(internals.getHeightAtComputed(sx, sz));
              samples++;
            }
          }
        }
      }
      expect(samples).toBe(270);
      const complete = setup.getTerrainSurfaceForRegion(
        bounds.minX,
        bounds.minZ,
        bounds.maxX,
        bounds.maxZ,
      );
      expect(complete.zones).toHaveLength(19);
      expect(
        complete.zones.find(
          (zone) => zone.id === "central_haven_lodge_grass_clearance",
        ),
      ).toMatchObject({ excludeGrass: true, width: 10, depth: 12.06 });
      expect(complete.arenaFloorIds).toHaveLength(3);
      expect(complete.waterBodies).toHaveLength(1);
    });
  });

  it("detaches queued geometry from later mutations of real registered zones and water", async () => {
    await withTerrain((terrain, internals) => {
      const masked: GrassTerrainSurfaceZone = {
        id: "snapshot-mask-detachment",
        centerX: 320,
        centerZ: 320,
        width: 4,
        depth: 4,
        height: 28,
        blendRadius: 1,
        excludeGrass: false,
        tileMask: new Set(["319,319", "320,319", "320,320"]),
        tileMaskTiles: [
          { x: 319, z: 319 },
          { x: 320, z: 319 },
          { x: 320, z: 320 },
        ],
        tileMaskBounds: { minX: 319, maxX: 320, minZ: 319, maxZ: 320 },
      };
      terrain.registerFlatZone(masked);
      const snapshot = internals.getTerrainSurfaceForRegion(150, 200, 550, 600);
      const expected = structuredClone(snapshot);
      masked.height = 90;
      masked.tileMask!.clear();
      masked.tileMaskTiles![0].x = 999;
      masked.tileMaskBounds!.minX = 999;
      const pond = internals.flatZones.get("haven_pond_floor")!;
      const bankHeight = pond.radialPond!.bankHeight;
      expect(Object.isFrozen(pond.radialPond)).toBe(true);
      expect(Reflect.set(pond.radialPond!, "bankHeight", bankHeight + 10)).toBe(
        false,
      );
      // Real authored updates go through registration so staged consumers can
      // retire; the previously queued snapshot must still stay detached.
      terrain.registerFlatZone({
        ...pond,
        radialPond: { ...pond.radialPond!, bankHeight: bankHeight + 10 },
      });
      expect(internals.flatZones.get(pond.id)!.radialPond!.bankHeight).toBe(
        bankHeight + 10,
      );
      terrain.getWaterBodyRegistry().getAllBodies()[0].surfaceY += 10;
      internals.arenaFloorZoneIds.clear();
      expect(snapshot).toEqual(expected);
      expect(
        snapshot.zones.find((zone) => zone.id === masked.id)?.tileMask,
      ).toEqual(new Set(["319,319", "320,319", "320,320"]));
      expect(snapshot.arenaFloorIds).toHaveLength(3);
    });
  });

  it("retains pond-bank material metadata for 3m without expanding the actual water circle", async () => {
    await withTerrain((terrain, internals) => {
      const pond = terrain.getWaterBodyRegistry().getAllBodies()[0];
      const edge = pond.centerX + pond.radius;
      const atEdge = internals.getTerrainSurfaceForRegion(
        edge,
        pond.centerZ,
        edge,
        pond.centerZ,
      );
      const outside = internals.getTerrainSurfaceForRegion(
        edge + 1e-6,
        pond.centerZ,
        edge + 2e-6,
        pond.centerZ,
      );
      expect(atEdge.waterBodies.map((body) => body.id)).toEqual([pond.id]);
      expect(
        snapshotOperations.getWaterSurfaceAt(atEdge, 16, edge, pond.centerZ),
      ).toBe(pond.surfaceY);
      expect(outside.waterBodies.map((body) => body.id)).toEqual([pond.id]);
      expect(outside.waterBodies[0].radius).toBe(pond.radius);
      expect(
        snapshotOperations.getWaterSurfaceAt(
          outside,
          16,
          edge + 1e-6,
          pond.centerZ,
        ),
      ).toBe(16);
      expect(COMPACT_TERRAIN_COMPOSITION.pondBankReach).toBe(3);
      const haloEdge = edge + COMPACT_TERRAIN_COMPOSITION.pondBankReach;
      const halo = internals.getTerrainSurfaceForRegion(
        haloEdge,
        pond.centerZ,
        haloEdge,
        pond.centerZ,
      );
      expect(halo.waterBodies.map((body) => body.id)).toEqual([pond.id]);
      expect(
        snapshotOperations.getWaterSurfaceAt(halo, 16, haloEdge, pond.centerZ),
      ).toBe(16);
      const beyond = internals.getTerrainSurfaceForRegion(
        haloEdge + 1e-6,
        pond.centerZ,
        haloEdge + 2e-6,
        pond.centerZ,
      );
      expect(beyond.waterBodies).toEqual([]);
    });
  });

  it("rejects invalid AABBs and completes huge finite queries with registered-zone-bounded work", async () => {
    await withTerrain((_terrain, internals) => {
      for (const [minX, minZ, maxX, maxZ] of [
        [NaN, 0, 1, 1],
        [-Infinity, 0, 1, 1],
        [0, 0, Infinity, 1],
        [2, 0, 1, 1],
        [0, 2, 1, 1],
        [-1e308, -1, 1e308, 1],
      ])
        expect(() =>
          internals.getTerrainSurfaceForRegion(minX, minZ, maxX, maxZ),
        ).toThrow(/grass surface query|Grass surface query/);
      const started = performance.now();
      const snapshot = internals.getTerrainSurfaceForRegion(
        -1e8,
        -1e8,
        1e8,
        1e8,
      );
      // A watchdog-style bound, not a performance acceptance measurement.
      expect(performance.now() - started).toBeLessThan(1000);
      expect(snapshot.zones.map((zone) => zone.id)).toEqual([
        ...internals.flatZones.keys(),
      ]);
      expect(snapshot.zones).toHaveLength(19);
      expect(snapshot.waterBodies).toHaveLength(1);
    });
  });

  it("loads only the intended natural grade/pond grass opt-ins while default pads stay excluded", async () => {
    await withTerrain((terrain, internals) => {
      const expectedAllowedIds = [
        "central_haven_plaza",
        "duel_arena_campus_grade",
        "haven_pond_floor",
        "preparation_campus_grade",
      ];
      const authored = Object.values(ALL_WORLD_AREAS).flatMap(
        (area) => area.flatZones ?? [],
      );
      expect(
        authored
          .filter((zone) => zone.excludeGrass === false)
          .map((zone) => zone.id)
          .sort(),
      ).toEqual(expectedAllowedIds);
      const snapshot = internals.getTerrainSurfaceForRegion(150, 200, 550, 600);
      expect(
        snapshot.zones
          .filter((zone) => zone.excludeGrass === false)
          .map((zone) => zone.id)
          .sort(),
      ).toEqual(expectedAllowedIds);
      // Broad grades shape the land; only actual structures and station pads
      // clear vegetation. The arena grade must not erase the preparation meadow.
      for (const [x, z] of [
        [320, 310],
        [326, 325],
        [330, 328],
        [320, 340],
        [380, 330],
      ]) {
        expect(internals.isGrassExcludedAt(x, z)).toBe(false);
        const index = snapshotOperations.createZoneIndex(snapshot, 100);
        expect(
          surfaceOperations.isGrassExcluded(index.getZonesAt(x, z), x, z),
        ).toBe(false);
      }
      expect(internals.isGrassExcludedAt(350, 320)).toBe(true);
      const station = snapshot.zones.find((zone) =>
        zone.id.startsWith("station_"),
      )!;
      expect(
        internals.isGrassExcludedAt(station.centerX, station.centerZ),
      ).toBe(true);
      for (const floorId of snapshot.arenaFloorIds) {
        const floor = internals.flatZones.get(floorId)!;
        expect(internals.isGrassExcludedAt(floor.centerX, floor.centerZ)).toBe(
          true,
        );
      }
      const pond = terrain.getWaterBodyRegistry().getAllBodies()[0];
      expect(
        internals.getHeightAtComputed(pond.centerX, pond.centerZ),
      ).toBeLessThan(pond.surfaceY + 0.1);
      const rawPond = internals.flatZones.get("haven_pond_floor")!;
      const bankZ = pond.centerZ - rawPond.radialPond!.bankOuterRadius;
      expect(internals.isGrassExcludedAt(pond.centerX, bankZ)).toBe(false);
      expect(
        internals.getHeightAtComputed(pond.centerX, bankZ),
      ).toBeGreaterThan(
        terrain.getWaterBodyRegistry().getWaterSurfaceAt(pond.centerX, bankZ) +
          0.1,
      );
    });
  });
});
