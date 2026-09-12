import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
} from "../../../../data/arena-grading";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem, roadSegmentInfluence } from "../RoadNetworkSystem";
import {
  COMPACT_PATH_BLEND_WIDTH,
  compactPathIntersectsBounds,
  compactPathSegmentDistance,
  createCompactIslandPaths,
} from "../CompactIslandPaths";
import { COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";
import type { RoadTileSegment } from "../../../../types/world/world-types";
import {
  COMPACT_PREPARATION_LODGE,
  getCompactPreparationLodgeFootprint,
} from "../CompactPreparationLodge";

type TerrainInternals = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  subscribeRoadNetworkEvents(): void;
  calculateRoadInfluenceAtVertex(
    x: number,
    z: number,
    tileX: number,
    tileZ: number,
  ): number;
  computeRoadInfluenceBatchCPU(
    vertices: Float32Array,
    tileX: number,
    tileZ: number,
    segments: RoadTileSegment[],
  ): Float32Array;
  getWorldSpaceRoadSegmentsForRegion(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>;
};
type RoadInternals = {
  buildTileCache(): void;
  calculateRoadMaskTextureSize(worldSize: number): number;
  calculateRoadMaskBounds(
    segments: ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>,
  ): { worldSize: number; centerX: number; centerZ: number };
};

async function withRoads(
  run: (roads: RoadNetworkSystem, terrain: TerrainSystem) => void,
  beforeStart?: (roads: RoadNetworkSystem, terrain: TerrainSystem) => void,
) {
  const world = new World(),
    terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  try {
    await terrain.init();
    const internal = terrain as unknown as TerrainInternals;
    internal.loadWaterBodiesFromManifest();
    internal.loadFlatZonesFromManifest();
    await roads.init();
    beforeStart?.(roads, terrain);
    await roads.start();
    run(roads, terrain);
  } finally {
    world.destroy();
  }
}

describe("actual compact preparation paths and centered road mask", () => {
  it("clears a real previously empty terrain segment cache on the actual roads-generated event without resident terrain tiles", async () => {
    await withRoads(
      (roads, terrain) => {
        expect(roads.getRoadInfluenceAt(348, 321)).toBe(1);
        expect(
          (
            terrain as unknown as TerrainInternals
          ).calculateRoadInfluenceAtVertex(348, 321, 3, 3),
        ).toBe(1);
      },
      (_, terrain) => {
        const internal = terrain as unknown as TerrainInternals;
        internal.subscribeRoadNetworkEvents();
        expect(internal.calculateRoadInfluenceAtVertex(348, 321, 3, 3)).toBe(0);
      },
    );
  });

  it("keeps the actual256 mask's full bilinear support outside the water and authored floor footprints", async () => {
    await withRoads((roads) => {
      const bounds = (
        roads as unknown as RoadInternals
      ).calculateRoadMaskBounds(roads.getRoadSegmentsForGPU());
      expect(
        (roads as unknown as RoadInternals).calculateRoadMaskTextureSize(
          bounds.worldSize,
        ),
      ).toBe(256);
      const mask = roads.generateRoadInfluenceTexture(
        256,
        bounds.worldSize,
        0.5,
        bounds.centerX,
        bounds.centerZ,
      )!;
      const pixel = bounds.worldSize / 256;
      const areas = DataManager.getInstance().getAllWorldAreas();
      const floors = createDuelArenaFloorZones(
        getDuelArenaConfig(),
        getDuelArenaGradeHeight(areas),
      );
      const lodge = getCompactPreparationLodgeFootprint(
        COMPACT_PREPARATION_LODGE,
        false,
      );
      for (let iz = 0; iz < 256; iz++)
        for (let ix = 0; ix < 256; ix++) {
          if (mask.data[iz * 256 + ix] === 0) continue;
          const x = ix * pixel - bounds.worldSize / 2 + bounds.centerX;
          const z = iz * pixel - bounds.worldSize / 2 + bounds.centerZ;
          // Existing kernel samples texel-index/N; linear sampler texel centers are
          // (index+.5)/N and each nonzero texel has a one-pixel support radius.
          const support = {
            minX: x - 0.5 * pixel,
            maxX: x + 1.5 * pixel,
            minZ: z - 0.5 * pixel,
            maxZ: z + 1.5 * pixel,
          };
          for (const floor of floors) {
            const overlap =
              support.maxX > floor.centerX - floor.width / 2 &&
              support.minX < floor.centerX + floor.width / 2 &&
              support.maxZ > floor.centerZ - floor.depth / 2 &&
              support.minZ < floor.centerZ + floor.depth / 2;
            expect(overlap, floor.id).toBe(false);
          }
          expect(
            support.maxX > lodge.minX &&
              support.minX < lodge.maxX &&
              support.maxZ > lodge.minZ &&
              support.minZ < lodge.maxZ,
            `lodge mask footprint at ${ix},${iz}`,
          ).toBe(false);
          for (const water of Object.values(areas).flatMap(
            (area) => area.waterBodies ?? [],
          )) {
            const dx = Math.max(
              support.minX - water.centerX,
              0,
              water.centerX - support.maxX,
            );
            const dz = Math.max(
              support.minZ - water.centerZ,
              0,
              water.centerZ - support.maxZ,
            );
            expect(Math.hypot(dx, dz)).toBeGreaterThan(water.radius);
          }
        }
    });
  });
  it("keeps actual terrain point/batch and regional worker candidates consistent at every path and blend edge", async () => {
    await withRoads((roads, terrain) => {
      const internal = terrain as unknown as TerrainInternals;
      for (const road of roads.getRoads())
        for (let i = 1; i < road.path.length; i++) {
          const a = road.path[i - 1],
            b = road.path[i],
            length = Math.hypot(b.x - a.x, b.z - a.z);
          if (length === 0) continue;
          for (const offset of [
            0,
            road.width / 2,
            road.width / 2 + 0.25,
            road.width / 2 + 0.6,
          ]) {
            const x = (a.x + b.x) / 2 - ((b.z - a.z) / length) * offset;
            const z = (a.z + b.z) / 2 + ((b.x - a.x) / length) * offset;
            const tx = Math.floor(x / 100),
              tz = Math.floor(z / 100),
              expected = roads.getRoadInfluenceAt(x, z);
            expect(
              internal.calculateRoadInfluenceAtVertex(x, z, tx, tz),
            ).toBeCloseTo(expected, 10);
            const vertices = new Float32Array([x - tx * 100, z - tz * 100]);
            const batch = internal.computeRoadInfluenceBatchCPU(
              vertices,
              tx,
              tz,
              roads.getRoadSegmentsForTile(tx, tz),
            );
            expect(batch[0]).toBeCloseTo(
              roads.getRoadInfluenceAt(
                vertices[0] + tx * 100,
                vertices[1] + tz * 100,
              ),
              6,
            );
            const candidates = internal.getWorldSpaceRoadSegmentsForRegion(
              x - 0.25,
              z - 0.25,
              x + 0.25,
              z + 0.25,
            );
            const regionValue = candidates.reduce(
              (value, s) =>
                Math.max(
                  value,
                  roadSegmentInfluence(
                    x,
                    z,
                    s.startX,
                    s.startZ,
                    s.endX,
                    s.endZ,
                    s.width,
                    0.5,
                  ),
                ),
              0,
            );
            expect(regionValue).toBeCloseTo(expected, 10);
          }
        }
    });
  });

  it("retains real segment influence across positive and negative tile boundaries even when centerline stops short", async () => {
    await withRoads((roads, terrain) => {
      const stored = roads.getRoads(),
        exemplar = stored[0];
      stored.splice(
        0,
        stored.length,
        ...[300, 400, -100].map((boundary, index) => ({
          ...exemplar,
          id: "boundary-data-" + index,
          width: index === 1 ? 2.2 : 1.5,
          path: [
            { x: 398, z: boundary - 5, y: 28 },
            { x: 399.5, z: boundary - 0.4, y: 28 },
          ],
        })),
      );
      (roads as unknown as RoadInternals).buildTileCache();
      const internal = terrain as unknown as TerrainInternals;
      for (const boundary of [300, 400, -100])
        for (const x of [399.5, 400, 400.25])
          for (const z of [boundary - 0.25, boundary, boundary + 0.25]) {
            const tx = Math.floor(x / 100),
              tz = Math.floor(z / 100),
              expected = roads.getRoadInfluenceAt(x, z);
            expect(expected).toBeGreaterThan(0);
            expect(
              internal.calculateRoadInfluenceAtVertex(x, z, tx, tz),
            ).toBeCloseTo(expected, 10);
            const segments = internal.getWorldSpaceRoadSegmentsForRegion(
              x,
              z,
              x,
              z,
            );
            expect(
              segments.reduce(
                (value, s) =>
                  Math.max(
                    value,
                    roadSegmentInfluence(
                      x,
                      z,
                      s.startX,
                      s.startZ,
                      s.endX,
                      s.endZ,
                      s.width,
                      0.5,
                    ),
                  ),
                0,
              ),
            ).toBeCloseTo(expected, 10);
          }
    });
  });
  it("generates a bounded curved immutable network from admitted subjects without towns or changing terrain", async () => {
    await withRoads((roads, terrain) => {
      expect(DataManager.getInstance().isReady()).toBe(true);
      const areas = DataManager.getInstance().getAllWorldAreas(),
        profile = DataManager.getWorldTerrainProfile();
      const before = JSON.stringify(areas);
      const paths = createCompactIslandPaths(
        profile,
        areas,
        getDuelArenaConfig(),
        (x, z) => terrain.getHeightAt(x, z),
      );
      expect(paths).toHaveLength(11);
      expect(roads.getRoads()).toHaveLength(11);
      expect(roads.getRoadNetwork()?.towns).toEqual([]);
      expect(roads.getRoadNetwork()?.roads).toHaveLength(11);
      expect(roads.getDependencies().required).toEqual(["terrain"]);
      expect(JSON.stringify(areas)).toBe(before);
      expect(Object.isFrozen(paths)).toBe(true);
      for (const path of paths) {
        expect(Object.isFrozen(path)).toBe(true);
        expect(Object.isFrozen(path.path)).toBe(true);
        expect(path.path.length).toBeGreaterThan(7);
        expect(path.path.length).toBeLessThanOrEqual(256);
        expect(path.width).toBeGreaterThanOrEqual(1.5);
        expect(path.width).toBeLessThanOrEqual(4);
        expect(path.length).toBeLessThan(80);
        for (let i = 0; i < path.path.length; i++) {
          const p = path.path[i];
          expect(Object.isFrozen(p)).toBe(true);
          expect(p.y).toBe(terrain.getHeightAt(p.x, p.z));
          if (i)
            expect(
              Math.hypot(p.x - path.path[i - 1].x, p.z - path.path[i - 1].z),
            ).toBeLessThanOrEqual(1.000001);
        }
      }
      // Preserve the exact original six-path bounds, independent of the wider
      // additive surface-only forecourts.
      for (const path of paths.slice(0, 6)) {
        expect(path.id).toMatch(/^compact-path-/);
        expect(path.path.length).toBeGreaterThan(8);
        expect(path.width).toBeLessThanOrEqual(2.2);
      }
      expect(paths.slice(6).map((path) => path.id)).toEqual([
        "compact-clearing-bank-apron",
        "compact-clearing-bank-clerk-approach",
        "compact-clearing-bank-shopkeeper-approach",
        "compact-clearing-workshop-apron",
        "compact-clearing-workshop-supplier-approach",
      ]);
      const main = paths.find((p) => p.id === "compact-path-bank-lobby")!;
      expect(
        main.path.some(
          (p) =>
            compactPathSegmentDistance(p, main.path[0], main.path.at(-1)!) > 1,
        ),
      ).toBe(true);
      expect(
        paths.find((p) => p.id === "compact-path-pond-bank")?.path.at(-1),
      ).toEqual(main.path[0]);
      expect(main.toId).toBe(
        paths.find((p) => p.id === "compact-path-lobby-arena")?.fromId,
      );
    });
  });

  it("keeps every entire width-plus-blend segment outside water, lobby, hospital and the combat floor", async () => {
    await withRoads((roads) => {
      const areas = DataManager.getInstance().getAllWorldAreas();
      const floors = createDuelArenaFloorZones(
        getDuelArenaConfig(),
        getDuelArenaGradeHeight(areas),
      );
      let checked = 0;
      for (const road of roads.getRoads())
        for (let i = 1; i < road.path.length; i++) {
          const a = road.path[i - 1],
            b = road.path[i],
            padding = road.width / 2 + COMPACT_PATH_BLEND_WIDTH;
          for (const floor of floors)
            expect(
              compactPathIntersectsBounds(
                a,
                b,
                {
                  minX: floor.centerX - floor.width / 2,
                  maxX: floor.centerX + floor.width / 2,
                  minZ: floor.centerZ - floor.depth / 2,
                  maxZ: floor.centerZ + floor.depth / 2,
                },
                padding,
              ),
            ).toBe(false);
          for (const water of Object.values(areas).flatMap(
            (area) => area.waterBodies ?? [],
          ))
            expect(
              compactPathSegmentDistance(
                { x: water.centerX, z: water.centerZ },
                a,
                b,
              ),
            ).toBeGreaterThan(water.radius + padding);
          checked++;
        }
      expect(checked).toBeGreaterThan(100);
      for (const floor of floors)
        expect(roads.getRoadInfluenceAt(floor.centerX, floor.centerZ)).toBe(0);
      expect(roads.getRoadInfluenceAt(343, 302)).toBe(0);
    });
  });

  it("retains legacy profile behavior and rejects missing compact admitted station geometry", async () => {
    await withRoads((_, terrain) => {
      const areas = DataManager.getInstance().getAllWorldAreas();
      expect(
        createCompactIslandPaths(
          COMPACT_WORLD_TERRAIN_PROFILE,
          areas,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        ),
      ).toEqual([]);
      const changed = structuredClone(areas);
      changed.central_haven.stations = [];
      expect(() =>
        createCompactIslandPaths(
          DataManager.getWorldTerrainProfile(),
          changed,
          getDuelArenaConfig(),
          (x, z) => terrain.getHeightAt(x, z),
        ),
      ).toThrow(/station/);
    });
  });

  it("uses translated tight mask bounds and matches every CPU texel to the same per-width world sampling contract", async () => {
    await withRoads((roads) => {
      const segments = roads.getRoadSegmentsForGPU();
      const bounds = (
        roads as unknown as RoadInternals
      ).calculateRoadMaskBounds(segments);
      expect(bounds.centerX).toBeGreaterThan(330);
      expect(bounds.centerZ).toBeGreaterThan(320);
      expect(bounds.worldSize).toBeLessThan(110);
      const mask = roads.generateRoadInfluenceTexture(
        64,
        bounds.worldSize,
        0.5,
        bounds.centerX,
        bounds.centerZ,
      )!;
      let nonzero = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const wx =
            (x / 64) * bounds.worldSize - bounds.worldSize / 2 + bounds.centerX;
          const wz =
            (y / 64) * bounds.worldSize - bounds.worldSize / 2 + bounds.centerZ;
          expect(mask.data[y * 64 + x]).toBeCloseTo(
            roads.getRoadInfluenceAt(wx, wz),
            6,
          );
          if (mask.data[y * 64 + x] > 0) nonzero++;
        }
      expect(nonzero).toBeGreaterThan(100);
      expect(mask.centerX).toBe(bounds.centerX);
      expect(roads.generateRoadInfluenceTexture(64, 400)?.centerX).toBe(350);
      expect(roads.generateRoadInfluenceTexture(64, 400)?.centerZ).toBe(400);
    });
  });

  it("unions unequal widths instead of selecting only the nearest centerline, and keeps legacy equal-width math", async () => {
    await withRoads((roads) => {
      const originals = roads.getRoads().slice();
      roads.getRoads().splice(
        0,
        originals.length,
        ...[1, 6].map((width, index) => ({
          id: "width-test-" + index,
          fromType: "poi" as const,
          toType: "poi" as const,
          fromTownId: "",
          toTownId: "",
          width,
          material: "dirt" as const,
          length: 20,
          path: [
            { x: -10, y: 28, z: index * 3 },
            { x: 10, y: 28, z: index * 3 },
          ],
        })),
      );
      (roads as unknown as RoadInternals).buildTileCache();
      expect(roads.getRoadInfluenceAt(0, 1)).toBe(1);
      expect(roads.isOnRoad(0, 1)).toBe(true);
      expect(roadSegmentInfluence(0, 3.25, -10, 0, 10, 0, 6, 0.5)).toBe(0.5);
      expect(roadSegmentInfluence(0, 3.5, -10, 0, 10, 0, 6, 0.5)).toBe(0);
      expect(roadSegmentInfluence(0, 0, 0, 0, 0, 0, 6, 0.5)).toBe(1);
      const mask = roads.generateRoadInfluenceTexture(32, 32, 0.5, 0, 0)!;
      expect(mask.data[17 * 32 + 16]).toBe(1);
    });
  });
});
