import { describe, expect, it } from "vitest";

import { BiomeType } from "../TerrainBiomeTypes";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";

type HeightField = (x: number, z: number) => number;
type GradingField = (x: number, z: number) => number | null;

/** Analytic terrain input: production generators and real geometry run unchanged. */
class AnalyticTerrain implements FullTerrainProvider {
  readonly terrainProfileIdentity = worldTerrainProfileIdentity(
    COMPACT_WORLD_TERRAIN_PROFILE,
  );
  readonly TILE_SIZE = 100;
  readonly WATER_LEVEL_NORMALIZED = 0.32;
  readonly SHORELINE_THRESHOLD = 0.25;
  readonly SHORELINE_STRENGTH = 0.6;
  readonly MAX_HEIGHT = 50;
  heightSamples = 0;
  gradingSamples = 0;

  constructor(
    private readonly height: HeightField,
    private readonly grading: GradingField = () => null,
  ) {}

  getFlatZoneHeight(x: number, z: number): number | null {
    this.gradingSamples++;
    return this.grading(x, z);
  }

  getHeightAtComputed(x: number, z: number): number {
    this.heightSamples++;
    return this.grading(x, z) ?? this.height(x, z);
  }

  calculateRoadInfluenceAtVertex(): number {
    return 0;
  }

  computeBiomeWeightsAtPosition() {
    return {
      biomeWeightMap: new Map([[BiomeType.Forest, 1]]),
      totalWeight: 1,
    };
  }

  computeBiomeWeightsByPosition(): Record<string, number> {
    return { [BiomeType.Forest]: 1 };
  }

  getBiomeId(): number {
    return 0;
  }

  getBiomeColor() {
    return { r: 0.2, g: 0.4, b: 0.1 };
  }
}

const plane: HeightField = (x, z) => 22 + x * 0.75 - z * 0.25;

describe("quad terrain final surface", () => {
  it("retains the worker height allocation when no live grading applies", () => {
    const terrain = new AnalyticTerrain(plane);
    const worker = generateQuadChunkDataSync(0, 0, 8, 5, terrain);
    terrain.heightSamples = 0;
    const result = assembleQuadChunkGeometry(worker, terrain, 3);
    try {
      expect(result.heightData).toBe(worker.heightData);
      expect(terrain.heightSamples).toBe(0);
      expect(terrain.gradingSamples).toBe(5 * 5 + 4 * 5);
      const positions = result.geometry.getAttribute("position");
      for (let i = 0; i < result.heightData.length; i++) {
        expect(positions.getY(i)).toBe(result.heightData[i]);
      }
    } finally {
      result.geometry.dispose();
    }
  });

  it("returns final Float32 main-grid heights without mutating worker data or including skirts", () => {
    const worker = generateQuadChunkDataSync(
      0,
      0,
      8,
      5,
      new AnalyticTerrain(plane),
    );
    const originalHeights = worker.heightData.slice();
    const terrain = new AnalyticTerrain(plane, (x, z) =>
      Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 28.419301523097687 : null,
    );
    const result = assembleQuadChunkGeometry(worker, terrain, 3);
    try {
      expect(result.heightData).not.toBe(worker.heightData);
      expect(worker.heightData).toEqual(originalHeights);
      expect(result.heightData.length).toBe(25);
      const positions = result.geometry.getAttribute("position");
      expect(positions.count).toBe(25 + 5 * 4);
      for (let i = 0; i < result.heightData.length; i++) {
        expect(positions.getY(i)).toBe(result.heightData[i]);
      }
      expect(result.heightData[12]).toBe(Math.fround(28.419301523097687));
      expect(result.heightData[0]).toBe(originalHeights[0]);
      for (let ix = 0; ix < 5; ix++) {
        expect(positions.getY(25 + ix)).toBe(
          Math.fround(result.heightData[ix] - 3),
        );
      }
      expect(terrain.heightSamples).toBe(4 * 5);
      expect(terrain.gradingSamples).toBe(5 * 5);
    } finally {
      result.geometry.dispose();
    }
  });

  it("keeps full plane gradients at every edge/corner and across adjacent chunks", () => {
    const terrain = new AnalyticTerrain(plane, plane);
    const expectedLength = Math.hypot(-0.75, 1, 0.25);
    const expected = [-0.75, 1, 0.25].map((value) => value / expectedLength);
    const results = [-4, 4].map((centerX) => {
      const worker = generateQuadChunkDataSync(centerX, 0, 8, 5, terrain);
      const before = terrain.heightSamples;
      const result = assembleQuadChunkGeometry(worker, terrain, 3);
      expect(terrain.heightSamples - before).toBe(4 * 5);
      return result;
    });
    try {
      for (const result of results) {
        const normals = result.geometry.getAttribute("normal");
        for (let i = 0; i < normals.count; i++) {
          expect(normals.getX(i)).toBeCloseTo(expected[0], 6);
          expect(normals.getY(i)).toBeCloseTo(expected[1], 6);
          expect(normals.getZ(i)).toBeCloseTo(expected[2], 6);
        }
      }
      for (let iz = 0; iz < 5; iz++) {
        expect(results[0].heightData[iz * 5 + 4]).toBe(
          results[1].heightData[iz * 5],
        );
      }
    } finally {
      for (const result of results) result.geometry.dispose();
    }
  });

  it("uses the same Float32 height precision in boundary and interior normal samples", () => {
    const field: HeightField = (x, z) =>
      28.419301523097687 + x * 0.71387913 - z * 0.29735597;
    const terrain = new AnalyticTerrain(field, field);
    const worker = generateQuadChunkDataSync(0, 0, 8, 5, terrain);
    const result = assembleQuadChunkGeometry(worker, terrain, 3);
    try {
      const normals = result.geometry.getAttribute("normal");
      for (let iz = 0; iz < 5; iz++) {
        for (let ix = 0; ix < 5; ix++) {
          const x = -4 + ix * 2;
          const z = -4 + iz * 2;
          const nx =
            -(Math.fround(field(x + 2, z)) - Math.fround(field(x - 2, z))) / 4;
          const nz =
            -(Math.fround(field(x, z + 2)) - Math.fround(field(x, z - 2))) / 4;
          const length = Math.sqrt(nx * nx + 1 + nz * nz);
          const index = iz * 5 + ix;
          expect(normals.getX(index)).toBe(Math.fround(nx / length));
          expect(normals.getY(index)).toBe(Math.fround(1 / length));
          expect(normals.getZ(index)).toBe(Math.fround(nz / length));
        }
      }
    } finally {
      result.geometry.dispose();
    }
  });

  it("matches shared-edge normals when only the neighboring chunk contains graded vertices", () => {
    const raw = new AnalyticTerrain(() => 22);
    const graded = new AnalyticTerrain(
      () => 22,
      (x) => (x <= -1 ? 24 : null),
    );
    const workers = [-4, 4].map((x) =>
      generateQuadChunkDataSync(x, 0, 8, 5, raw),
    );
    const results = workers.map((worker) =>
      assembleQuadChunkGeometry(worker, graded, 3),
    );
    try {
      expect(results[0].heightData).not.toBe(workers[0].heightData);
      expect(results[1].heightData).toBe(workers[1].heightData);
      expect(graded.heightSamples).toBe(2 * 4 * 5);
      const leftNormals = results[0].geometry.getAttribute("normal");
      const rightNormals = results[1].geometry.getAttribute("normal");
      for (let iz = 0; iz < 5; iz++) {
        const left = iz * 5 + 4;
        const right = iz * 5;
        expect(results[0].heightData[left]).toBe(22);
        expect(results[1].heightData[right]).toBe(22);
        expect(leftNormals.getX(left)).toBeGreaterThan(0);
        expect(rightNormals.getX(right)).toBe(leftNormals.getX(left));
        expect(rightNormals.getY(right)).toBe(leftNormals.getY(left));
        expect(rightNormals.getZ(right)).toBe(leftNormals.getZ(left));
      }
    } finally {
      for (const result of results) result.geometry.dispose();
    }
  });

  it.each([5, 16, 64])(
    "bounds the worst-case border-only grading check at resolution %i without changing main-grid heights",
    (resolution) => {
      const step = 8 / (resolution - 1);
      const raw = new AnalyticTerrain(() => 22);
      const worker = generateQuadChunkDataSync(0, 0, 8, resolution, raw);
      const terrain = new AnalyticTerrain(
        () => 22,
        // Only the final sample in the four-sided border scan is graded.
        (x, z) => (x === 4 && z === 4 + step ? 26 : null),
      );
      const result = assembleQuadChunkGeometry(worker, terrain, 3);
      try {
        expect(result.heightData).toBe(worker.heightData);
        expect([...result.heightData].every((height) => height === 22)).toBe(
          true,
        );
        expect(terrain.gradingSamples).toBe(
          resolution * resolution + 4 * resolution,
        );
        expect(terrain.heightSamples).toBe(4 * resolution);
        const normals = result.geometry.getAttribute("normal");
        const index = resolution * resolution - 1;
        const slope = 2 / step;
        const length = Math.sqrt(1 + slope * slope);
        expect(normals.getX(index)).toBeCloseTo(0, 12);
        expect(normals.getY(index)).toBe(Math.fround(1 / length));
        expect(normals.getZ(index)).toBe(Math.fround(-slope / length));
      } finally {
        result.geometry.dispose();
      }
    },
  );
});
