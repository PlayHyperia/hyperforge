import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import {
  HOSPITAL_CENTER_X,
  HOSPITAL_CENTER_Z,
  HOSPITAL_WIDTH,
  HOSPITAL_LENGTH,
} from "../../../../data/arena-layout";
import {
  createDuelArenaFloorZones,
  getDuelArenaSolidSurfaceHeight,
  getDuelArenaGradeHeight,
} from "../../../../data/arena-grading";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import {
  PLAYER_ROOT_CLEARANCE,
  resolvePlayerRootHeight,
} from "../../../../utils/movement/PlayerSupport";
import THREE from "../../../../extras/three/three";
import {
  TerrainSystem,
  STREAMING_TERRAIN_QUADTREE_RESOLUTION,
} from "../TerrainSystem";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";

type Point = [x: number, y: number, z: number];
type TerrainInternals = {
  CONFIG: {
    TILE_SIZE: number;
    QUADTREE_SKIRT_DROP: number;
    QUADTREE_MIN_SIZE: number;
  };
  loadFlatZonesFromManifest(): void;
  buildChunkTerrainProvider(): FullTerrainProvider;
};

/** Clip an affine triangle without discarding edge/interior height extrema. */
function clipHalfPlane(
  polygon: Point[],
  axis: 0 | 2,
  boundary: number,
  direction: 1 | -1,
): Point[] {
  const clipped: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const previous = polygon[(i + polygon.length - 1) % polygon.length];
    const currentInside = direction * (current[axis] - boundary) >= 0;
    const previousInside = direction * (previous[axis] - boundary) >= 0;
    if (currentInside !== previousInside) {
      const fraction =
        (boundary - previous[axis]) / (current[axis] - previous[axis]);
      const intersection: Point = [
        previous[0] + fraction * (current[0] - previous[0]),
        previous[1] + fraction * (current[1] - previous[1]),
        previous[2] + fraction * (current[2] - previous[2]),
      ];
      intersection[axis] = boundary;
      clipped.push(intersection);
    }
    if (currentInside) clipped.push(current);
  }
  return clipped;
}

function horizontalArea(polygon: Point[]): number {
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twiceArea += a[0] * b[2] - b[0] * a[2];
  }
  return Math.abs(twiceArea) / 2;
}

describe("actual compact terrain replacing the removed recovery court", () => {
  it("covers the whole former footprint with walkable ground and no platform or carve", async () => {
    await DataManager.getInstance().initialize();
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    try {
      // Actual admitted profile/noise/biomes, followed by the production grades.
      // This CPU geometry regression does not certify native movement or pixels.
      await terrain.init();
      internals.loadFlatZonesFromManifest();
      const provider = internals.buildChunkTerrainProvider();
      const size = terrain.getWorldTerrainProfile().terrainTileSize;
      // This fixture covers final streaming leaves, not an arbitrary tile mesh.
      expect(size).toBe(internals.CONFIG.QUADTREE_MIN_SIZE);
      const resolution = STREAMING_TERRAIN_QUADTREE_RESOLUTION;
      const minX = HOSPITAL_CENTER_X - HOSPITAL_WIDTH / 2;
      const maxX = HOSPITAL_CENTER_X + HOSPITAL_WIDTH / 2;
      const minZ = HOSPITAL_CENTER_Z - HOSPITAL_LENGTH / 2;
      const maxZ = HOSPITAL_CENTER_Z + HOSPITAL_LENGTH / 2;
      expect(
        createDuelArenaFloorZones(
          getDuelArenaConfig(),
          getDuelArenaGradeHeight(),
        ).map((zone) => zone.id),
      ).toEqual(["duel_arena_floor_1", "duel_lobby_floor"]);
      // Exercise the actual regular-tile carve path as well as the final
      // quadtree geometry below: no invisible hole may outlive the platform.
      const tileX = Math.floor(HOSPITAL_CENTER_X / internals.CONFIG.TILE_SIZE);
      const tileZ = Math.floor(HOSPITAL_CENTER_Z / internals.CONFIG.TILE_SIZE);
      const patch = new THREE.PlaneGeometry(
        HOSPITAL_WIDTH,
        HOSPITAL_LENGTH,
        12,
        12,
      );
      try {
        patch.rotateX(-Math.PI / 2);
        patch.translate(
          HOSPITAL_CENTER_X - tileX * internals.CONFIG.TILE_SIZE,
          0,
          HOSPITAL_CENTER_Z - tileZ * internals.CONFIG.TILE_SIZE,
        );
        const before = patch.index!.array.slice();
        terrain["applyFlatZoneCarve"](patch, tileX, tileZ);
        expect(patch.index!.array).toEqual(before);
      } finally {
        patch.dispose();
      }
      let coveredArea = 0;
      let intersectingTriangles = 0;
      const measuredBounds = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };

      // Include every intersecting production leaf, even if the shared layout
      // later moves the safe-ground footprint across a chunk boundary. Skirts do not cover
      // additional horizontal area and never rise above their boundary grid.
      for (
        let tileZ = Math.floor(minZ / size);
        tileZ < Math.ceil(maxZ / size);
        tileZ++
      ) {
        for (
          let tileX = Math.floor(minX / size);
          tileX < Math.ceil(maxX / size);
          tileX++
        ) {
          const centerX = (tileX + 0.5) * size;
          const centerZ = (tileZ + 0.5) * size;
          const { geometry } = assembleQuadChunkGeometry(
            generateQuadChunkDataSync(
              centerX,
              centerZ,
              size,
              resolution,
              provider,
            ),
            provider,
            internals.CONFIG.QUADTREE_SKIRT_DROP,
          );
          try {
            const positions = geometry.getAttribute("position");
            const indices = geometry.getIndex()!;
            const mainIndexCount = (resolution - 1) ** 2 * 6;
            expect(indices.count).toBeGreaterThanOrEqual(mainIndexCount);
            for (let offset = 0; offset < mainIndexCount; offset += 3) {
              let polygon: Point[] = [0, 1, 2].map((corner) => {
                const index = indices.getX(offset + corner);
                return [
                  centerX + positions.getX(index),
                  positions.getY(index),
                  centerZ + positions.getZ(index),
                ];
              });
              polygon = clipHalfPlane(polygon, 0, minX, 1);
              polygon = clipHalfPlane(polygon, 0, maxX, -1);
              polygon = clipHalfPlane(polygon, 2, minZ, 1);
              polygon = clipHalfPlane(polygon, 2, maxZ, -1);
              if (polygon.length === 0) continue;
              intersectingTriangles++;
              coveredArea += horizontalArea(polygon);
              // Height is affine on each clipped polygon: testing its vertices
              // proves the entire triangle/footprint intersection, not a grid.
              for (const point of polygon) {
                expect(point.every(Number.isFinite)).toBe(true);
                measuredBounds.minX = Math.min(measuredBounds.minX, point[0]);
                measuredBounds.maxX = Math.max(measuredBounds.maxX, point[0]);
                measuredBounds.minZ = Math.min(measuredBounds.minZ, point[2]);
                measuredBounds.maxZ = Math.max(measuredBounds.maxZ, point[2]);
                expect(
                  getDuelArenaSolidSurfaceHeight(point[0], point[2]),
                ).toBeNull();
                const ground = terrain.getHeightAt(point[0], point[2]);
                expect(point[1]).toBeCloseTo(ground, 5);
                expect(ground).toBe(getDuelArenaGradeHeight());
                expect(
                  resolvePlayerRootHeight(point[0], point[2], terrain),
                ).toBeCloseTo(ground + PLAYER_ROOT_CLEARANCE, 7);
              }
            }
          } finally {
            geometry.dispose();
          }
        }
      }
      expect(intersectingTriangles).toBeGreaterThan(0);
      expect(coveredArea).toBeCloseTo(HOSPITAL_WIDTH * HOSPITAL_LENGTH, 7);
      expect(measuredBounds).toEqual({ minX, maxX, minZ, maxZ });
    } finally {
      terrain.destroy();
    }
  });
});
