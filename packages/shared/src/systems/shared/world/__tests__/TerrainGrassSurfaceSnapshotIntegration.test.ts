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
      expect(complete.zones).toHaveLength(18);
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
      expect(snapshot.zones).toHaveLength(18);
      expect(snapshot.waterBodies).toHaveLength(1);
    });
  });

  it("loads only the intended natural grade/pond grass opt-ins while default pads stay excluded", async () => {
    await withTerrain((terrain, internals) => {
      const expectedAllowedIds = [
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
      // Southern preparation ground overlaps the deliberately bare arena-grade
      // blend. Use the northwest natural patch outside that exclusion instead.
      expect(internals.isGrassExcludedAt(320, 310)).toBe(false);
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
