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
  DUEL_ARENA_FLOOR_CENTER_OFFSET,
  DUEL_ARENA_FLOOR_THICKNESS,
  getDuelArenaGradeHeight,
} from "../../../../data/arena-grading";
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
  CONFIG: { QUADTREE_SKIRT_DROP: number; QUADTREE_MIN_SIZE: number };
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

describe("actual compact terrain beneath the complete hospital floor", () => {
  it("covers the whole footprint and keeps every clipped terrain triangle at least 19mm below the floor", async () => {
    await DataManager.getInstance().initialize();
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    const floor = new THREE.BoxGeometry(
      HOSPITAL_WIDTH,
      DUEL_ARENA_FLOOR_THICKNESS,
      HOSPITAL_LENGTH,
    );
    try {
      // Actual admitted profile/noise/biomes, followed by the production grades.
      // This CPU geometry regression does not certify GPU depth precision.
      await terrain.init();
      internals.loadFlatZonesFromManifest();
      const provider = internals.buildChunkTerrainProvider();
      const size = terrain.getWorldTerrainProfile().terrainTileSize;
      // This fixture covers final streaming leaves, not an arbitrary tile mesh.
      expect(size).toBe(internals.CONFIG.QUADTREE_MIN_SIZE);
      const resolution = STREAMING_TERRAIN_QUADTREE_RESOLUTION;
      floor.computeBoundingBox();
      const floorTop =
        getDuelArenaGradeHeight() +
        DUEL_ARENA_FLOOR_CENTER_OFFSET +
        floor.boundingBox!.max.y;
      const minX = HOSPITAL_CENTER_X + floor.boundingBox!.min.x;
      const maxX = HOSPITAL_CENTER_X + floor.boundingBox!.max.x;
      const minZ = HOSPITAL_CENTER_Z + floor.boundingBox!.min.z;
      const maxZ = HOSPITAL_CENTER_Z + floor.boundingBox!.max.z;
      let coveredArea = 0;
      let intersectingTriangles = 0;
      let minimumClearance = Infinity;
      let nearestPoint: Point | null = null;
      const measuredBounds = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };

      // Include every intersecting production leaf, even if the shared layout
      // later moves the hospital across a chunk boundary. Skirts do not cover
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
                const clearance = floorTop - point[1];
                if (clearance < minimumClearance) {
                  minimumClearance = clearance;
                  nearestPoint = point;
                }
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
      expect(Number.isFinite(minimumClearance)).toBe(true);
      expect(
        minimumClearance,
        `Nearest terrain vertex ${JSON.stringify(nearestPoint)}; floor top ${floorTop}`,
      ).toBeGreaterThanOrEqual(0.019);
    } finally {
      floor.dispose();
      terrain.destroy();
    }
  });
});
