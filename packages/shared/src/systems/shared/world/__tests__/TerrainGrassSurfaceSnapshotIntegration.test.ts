import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  createGrassTerrainSurfaceOperations,
  GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE,
  type GrassTerrainSurfaceSnapshot,
  type GrassTerrainSurfaceZone,
} from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { createAuthoredTerrainSurfaceOperations } from "../AuthoredTerrainSurface";
import { TerrainSystem } from "../TerrainSystem";
import type { GrassWorkerSetup } from "../GrassVisualManager";
import { COMPACT_TERRAIN_COMPOSITION } from "../CompactTerrainPalette";

type Internals = {
  flatZones: Map<string, GrassTerrainSurfaceZone>;
  arenaFloorZoneIds: Set<string>;
  arenaGradeHeight: number | null;
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
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
) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  try {
    await terrain.init();
    const internals = terrain as unknown as Internals;
    internals.loadWaterBodiesFromManifest();
    internals.loadFlatZonesFromManifest();
    run(terrain, internals);
  } finally {
    world.destroy();
  }
}

describe("actual TerrainSystem regional grass snapshots", () => {
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
      for (let i = 0; i < 34; i++) {
        terrain.registerFlatZone(remote);
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
      const heights = [];
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
      const after = [];
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
      const capacity = Array.from({ length: 8 }, (_, i) => ({
        ...added.exclusionPolygons![17],
        id: `overflow-${i}`,
      }));
      expect(() => terrain.acquireGrassExclusionPolygons(capacity)).toThrow();
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
      pond.radialPond!.bankHeight += 10;
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
