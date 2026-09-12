import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import type { GrassTerrainSurfaceSnapshot } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import {
  groundGrassBlades,
  groundGrassBladeSteps,
  GrassBladeGroundingJob,
  GRASS_BLADE_GROUNDING_LIMITS,
  type GrassBladeGroundingRequest,
} from "../GrassBladeGrounding";
import {
  GrassVisualManager,
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  COMPACT_MEADOW_APPEARANCE,
  GRASS_CONFIG,
} from "../GrassVisualManager";
import {
  projectGrassAnchors,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
} from "../TerrainGridSurface";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../TerrainQuadChunkGenerator";
import { gridGeometry } from "./terrain-grid.fixture";

const emptySnapshot = (): GrassTerrainSurfaceSnapshot => ({
  schemaVersion: 1,
  zones: [],
  waterBodies: [],
  arenaFloorIds: [],
  arenaGradeHeight: null,
});
const sample = (): TerrainGridSample => ({
  height: 0,
  nx: 0,
  ny: 1,
  nz: 0,
  faceIndex: 0,
});

function analyticOwner() {
  const manager = new GrassVisualManager(
    "analytic",
    new THREE.Group(),
    () => null,
    () => 20,
    0,
    () => 0,
    () => false,
    () => ({
      r: 0.2,
      g: 0.3,
      b: 0.1,
      grassWeight: 1,
      grassPlacement: 1,
      grassHeightScale: 1,
    }),
  );
  const geometries: THREE.BufferGeometry[] = [];
  const makeSurface = (
    id = 1,
    centerX = 0,
    centerZ = 0,
    resolution = 16,
    height: (x: number, z: number) => number = () => 20,
    size = 100,
  ) => {
    const geometry = gridGeometry(size, resolution, (x, z) =>
      height(x + centerX, z + centerZ),
    );
    geometries.push(geometry);
    return new RetainedTerrainSurface(
      id,
      "analytic",
      centerX,
      centerZ,
      size,
      resolution,
      geometry,
    );
  };
  const dataAt = (
    surface: RetainedTerrainSurface,
    points: readonly [number, number, number?][],
  ): GrassAnchorData => {
    const data = {
      count: points.length,
      offsets: new Float32Array(points.length * 3),
      rotScaleHash: new Float32Array(points.length * 3),
      groundColors: new Float32Array(points.length * 3),
      grassTints: new Float32Array(points.length * 4),
      groundNormals: new Float32Array(points.length * 3),
    };
    points.forEach(([x, z, rotation = 0], i) => {
      data.offsets.set([x, 20, z], i * 3);
      data.rotScaleHash.set([rotation, 1, 0.4], i * 3);
      data.groundColors.set([0.2, 0.3, 0.1], i * 3);
      data.grassTints.set([1, 1, 1, 0.2], i * 4);
      data.groundNormals.set([0, 1, 0], i * 3);
    });
    return projectGrassAnchors(
      data,
      surface,
      () => -1000,
      () => false,
    );
  };
  const request = (
    surface: RetainedTerrainSurface,
    data = dataAt(surface, [[0, 0]]),
    lod: 0 | 1 | 2 = 1,
  ): GrassBladeGroundingRequest => ({
    data,
    lod,
    geometry: manager["lodGeometries"][lod],
    ownSurface: surface,
    surfaces: [surface],
    terrainSurface: emptySnapshot(),
    roadSegments: [],
    oceanLevel: 0,
    wind: { x: 0, z: 0 },
  });
  return {
    manager,
    geometries,
    makeSurface,
    dataAt,
    request,
    close() {
      manager.destroy();
      geometries.forEach((g) => g.dispose());
    },
  };
}

/** Independent native Three quaternion transform, not the prototype's formula. */
function transformedVertex(
  data: GrassAnchorData,
  surface: RetainedTerrainSurface,
  geometry: THREE.BufferGeometry,
  instance: number,
  vertex: number,
  fade = 1,
) {
  const k = instance * 3,
    p = geometry.getAttribute("position");
  const normal = new THREE.Vector3().fromArray(data.groundNormals, k);
  const rotation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    normal,
  );
  return new THREE.Vector3(
    p.getX(vertex),
    p.getY(vertex) * fade,
    p.getZ(vertex),
  )
    .multiplyScalar(data.rotScaleHash[k + 1])
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), -data.rotScaleHash[k])
    .applyQuaternion(rotation)
    .add(
      new THREE.Vector3(
        surface.centerX + data.offsets[k],
        data.offsets[k + 1],
        surface.centerZ + data.offsets[k + 2],
      ),
    );
}

function one(data: GrassAnchorData, index: number): GrassAnchorData {
  return {
    count: 1,
    offsets: data.offsets.slice(index * 3, index * 3 + 3),
    rotScaleHash: data.rotScaleHash.slice(index * 3, index * 3 + 3),
    groundColors: data.groundColors.slice(index * 3, index * 3 + 3),
    grassTints: data.grassTints.slice(index * 4, index * 4 + 4),
    groundNormals: data.groundNormals.slice(index * 3, index * 3 + 3),
  };
}

describe("CPU per-blade grounding prototype (no renderer/GPU)", () => {
  it("keeps reusable point/triangle scratch private across suspended LOD jobs", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(
        1,
        0,
        0,
        64,
        (x, z) => 20 + 0.1 * x - 0.08 * z + 0.003 * x * z,
      );
      const requests = ([0, 1, 2] as const).map((lod) => {
        const data = f.dataAt(surface, [
          [-4, 3, lod * 0.7],
          [1, -2, 1.8],
          [5, 6, 3.2],
        ]);
        data.rotScaleHash[1] = 0.7 + lod * 0.4;
        return { ...f.request(surface, data, lod), wind: { x: 0.06, z: 0.03 } };
      });
      const expected = requests.map(groundGrassBlades);
      const jobs = requests.map(
        (request) => new GrassBladeGroundingJob(request, () => true),
      );
      let rounds = 0;
      while (jobs.some((job) => job.state.status === "running")) {
        for (const job of jobs) job.advance(7);
        if (++rounds > 10000)
          throw new Error("Suspended jobs failed to complete");
      }
      jobs.forEach((job, index) => {
        const state = job.state;
        expect(state.status).toBe("ready");
        if (state.status !== "ready")
          throw new Error("Missing grounded result");
        const { elapsedMs: _actualElapsed, ...actualReceipt } =
          state.result.receipt;
        const { elapsedMs: _expectedElapsed, ...expectedReceipt } =
          expected[index].receipt;
        expect({ ...state.result, receipt: actualReceipt }).toEqual({
          ...expected[index],
          receipt: expectedReceipt,
        });
      });
    } finally {
      f.close();
    }
  });

  it.each([0, 1, 2] as const)(
    "bounds every corrected LOD%s vertex through fade and wind using independent Three transforms",
    (lod) => {
      const f = analyticOwner();
      try {
        const surface = f.makeSurface(
          1,
          0,
          0,
          64,
          (x, z) => 20 + 0.2 * x - 0.13 * z,
        );
        const data = f.dataAt(surface, [
          [0, 0, 0.8],
          [5, -4, 2.4],
          [-3, 3, 5.1],
        ]);
        data.rotScaleHash[1] = 0.2;
        data.rotScaleHash[4] = 4;
        const request = {
          ...f.request(surface, data, lod),
          wind: { x: 0.3, z: 0.165 },
        };
        const result = groundGrassBlades(request);
        if (result.status !== "ready" || !result.sweptBounds)
          throw new Error("Expected admitted bounds");
        expect(result.data.count).toBe(3);
        const b = result.sweptBounds,
          uv = request.geometry.getAttribute("uv");
        const tier = GRASS_CONFIG.LOD_TIERS[lod],
          vpb = tier.bladeSegments * 2 + 1;
        for (let i = 0; i < result.data.count; i++)
          for (let v = 0; v < uv.count; v++) {
            const d = (i * tier.bladesPerClump + Math.floor(v / vpb)) * 2;
            for (const fade of [0, 0.5, 1])
              for (const sx of [-1, 1])
                for (const sz of [-1, 1]) {
                  const p = transformedVertex(
                    result.data,
                    surface,
                    request.geometry,
                    i,
                    v,
                    fade,
                  );
                  p.y +=
                    result.rootDeltas[d] * (1 - uv.getX(v)) +
                    result.rootDeltas[d + 1] * uv.getX(v);
                  p.x += sx * request.wind.x * uv.getY(v) ** 1.8;
                  p.z += sz * request.wind.z * uv.getY(v) ** 1.8;
                  expect(
                    p.x >= b.minX &&
                      p.x <= b.maxX &&
                      p.y >= b.minY &&
                      p.y <= b.maxY &&
                      p.z >= b.minZ &&
                      p.z <= b.maxZ,
                  ).toBe(true);
                }
          }
      } finally {
        f.close();
      }
    },
  );

  it("does not include rejected clumps in culling bounds and gives empty output no box", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        data = f.dataAt(surface, [
          [0, 0],
          [20, 20],
        ]);
      const request = f.request(surface, data);
      request.terrainSurface.zones.push({
        id: "excluded",
        centerX: 20,
        centerZ: 20,
        width: 5,
        depth: 5,
        height: 20,
        blendRadius: 0,
        excludeGrass: true,
      });
      const result = groundGrassBlades(request);
      if (result.status !== "ready")
        throw new Error("Expected complete support");
      expect(result.sourceIndices).toEqual(new Uint32Array([0]));
      expect(result.sweptBounds!.maxX).toBeLessThan(5);
      expect(result.sweptBounds!.maxZ).toBeLessThan(5);
      request.terrainSurface.zones[0].width = 100;
      request.terrainSurface.zones[0].depth = 100;
      const empty = groundGrassBlades(request);
      expect(empty).toMatchObject({
        status: "ready",
        data: { count: 0 },
        sweptBounds: null,
      });
    } finally {
      f.close();
    }
  });

  it.each([0, 1, 2] as const)(
    "resumes the LOD%s production core at different slice boundaries without changing arrays",
    (lod) => {
      const f = analyticOwner();
      try {
        const surface = f.makeSurface(
          1,
          0,
          0,
          64,
          (x, z) => 20 + 0.07 * x - 0.05 * z,
        );
        const request = f.request(
          surface,
          f.dataAt(surface, [
            [0, 0],
            [4, 3, 1.2],
            [-3, 5, 4.7],
          ]),
          lod,
        );
        const expected = groundGrassBlades(request);
        const before = structuredClone(request.data);
        for (const size of [1, 7, 64, 1024, 8192]) {
          const job = new GrassBladeGroundingJob(request, () =>
            surface.matchesGeometry(f.geometries[0]),
          );
          while (job.state.status === "running") {
            expect(job.advance(size)).toBe(job.state);
            expect(job.lastSliceOperations).toBeLessThanOrEqual(size);
          }
          expect(job.state.status).toBe("ready");
          if (job.state.status !== "ready")
            throw Error(JSON.stringify(job.state));
          const { elapsedMs: _expectedTime, ...expectedReceipt } =
            expected.receipt;
          const { elapsedMs: _actualTime, ...receipt } =
            job.state.result.receipt;
          expect({ ...job.state.result, receipt }).toEqual({
            ...expected,
            receipt: expectedReceipt,
          });
          expect(request.data).toEqual(before);
          const terminal = job.state,
            operations = job.operations;
          expect(job.advance(1)).toBe(terminal);
          expect(job.operations).toBe(operations);
        }
      } finally {
        f.close();
      }
    },
  );

  it("validates every float in bounded batches, including partial tails", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      const points = Array.from({ length: 11 }, (_, i): [number, number] => [
        i - 5,
        0,
      ]);
      const request = f.request(surface, f.dataAt(surface, points));
      const before = structuredClone(request.data);
      const steps = groundGrassBladeSteps(request);
      let batches = 0;
      for (const phase of steps) if (phase === "instance_value") batches++;
      // Four 33-float arrays and one 44-float array: two batches each.
      expect(batches).toBe(10);
      expect(request.data).toEqual(before);
      for (const key of [
        "offsets",
        "rotScaleHash",
        "groundColors",
        "grassTints",
        "groundNormals",
      ] as const) {
        for (const index of [0, 31, 32, request.data[key].length - 1]) {
          for (const value of [NaN, Infinity, -Infinity]) {
            const invalid = { ...request, data: structuredClone(before) };
            invalid.data[key][index] = value;
            expect(() => groundGrassBlades(invalid)).toThrow(
              "Nonfinite grass grounding instance value",
            );
          }
        }
      }
    } finally {
      f.close();
    }
  });

  it("cancels between validation batches without examining unpublished input", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      const request = f.request(
        surface,
        f.dataAt(
          surface,
          Array.from({ length: 11 }, (_, i): [number, number] => [i - 5, 0]),
        ),
      );
      const geometry = f.geometries[0];
      const job = new GrassBladeGroundingJob(request, () =>
        surface.matchesGeometry(geometry),
      );
      expect(job.advance(3).status).toBe("running");
      expect(job.lastPhase).toBe("instance_value");
      request.data.offsets[32] = NaN;
      geometry.setAttribute(
        "position",
        geometry.getAttribute("position").clone(),
      );
      const before = job.operations;
      expect(job.advance(1)).toEqual({
        status: "cancelled",
        reason: "invalidated",
      });
      expect(job.operations).toBe(before);
    } finally {
      f.close();
    }
  });

  it("cancels a real retained geometry replacement before more work and keeps missing support/budget failure terminal", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        geometry = f.geometries[0],
        request = f.request(surface);
      const job = new GrassBladeGroundingJob(request, () =>
        surface.matchesGeometry(geometry),
      );
      expect(job.advance(4).status).toBe("running");
      geometry.setAttribute(
        "position",
        geometry.getAttribute("position").clone(),
      );
      const before = job.operations;
      expect(job.advance(4)).toEqual({
        status: "cancelled",
        reason: "invalidated",
      });
      expect(job.operations).toBe(before);
      const fresh = f.makeSurface(2);
      for (const [input, status] of [
        [f.request(fresh, f.dataAt(fresh, [[49.8, 0]])), "waiting_support"],
        [{ ...f.request(fresh), workBudget: 1 }, "failed_budget"],
      ] as const) {
        const next = new GrassBladeGroundingJob(input, () =>
          fresh.matchesGeometry(f.geometries[1]),
        );
        while (next.state.status === "running") next.advance(7);
        expect(next.state.status).toBe(status);
        const terminal = next.state,
          units = next.operations;
        expect(next.advance()).toBe(terminal);
        expect(next.operations).toBe(units);
      }
    } finally {
      f.close();
    }
  });

  it.each([0, 1, 2] as const)(
    "uses original LOD%s geometry and keeps every base anchored through full/zero fade",
    (lod) => {
      const f = analyticOwner();
      try {
        const surface = f.makeSurface(
          1,
          0,
          0,
          64,
          (x, z) => 20 + 0.07 * x - 0.05 * z,
        );
        const data = f.dataAt(surface, [
            [0, 0],
            [4, 3, 1.2],
            [-3, 5, 4.7],
          ]),
          request = f.request(surface, data, lod);
        const before = structuredClone(data),
          position = request.geometry.getAttribute("position").array.slice(),
          index = request.geometry.index!.array.slice();
        const result = groundGrassBlades(request);
        expect(result.status).toBe("ready");
        if (result.status !== "ready") throw Error(result.reason);
        expect(result.data.count).toBe(data.count);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundColors",
          "grassTints",
          "groundNormals",
        ] as const) {
          expect(result.data[key]).toEqual(data[key]);
        }
        expect(data).toEqual(before);
        expect(result.data.offsets).not.toBe(data.offsets);
        expect(request.geometry.getAttribute("position").array).toEqual(
          position,
        );
        expect(request.geometry.index!.array).toEqual(index);
        expect(result.rootDeltas.byteLength).toBe(
          data.count * [192, 96, 32][lod],
        );
        const tier = GRASS_CONFIG.LOD_TIERS[lod],
          vpb = tier.bladeSegments * 2 + 1,
          out = sample();
        for (let i = 0; i < data.count; i++)
          for (let blade = 0; blade < tier.bladesPerClump; blade++)
            for (const side of [0, 1])
              for (const fade of [0, 0.5, 1]) {
                const point = transformedVertex(
                  data,
                  surface,
                  request.geometry,
                  i,
                  blade * vpb + side,
                  fade,
                );
                point.y +=
                  result.rootDeltas[
                    (i * tier.bladesPerClump + blade) * 2 + side
                  ];
                expect(surface.sample(point.x, point.z, out)).toBe(true);
                expect(Math.abs(point.y - out.height)).toBeLessThan(0.00001);
              }
        expect(result.dependencies).toEqual([
          { surface, uses: ["endpoint", "edge", "envelope"] },
        ]);
        expect(result.receipt.endpointQueries).toBe(
          data.count * tier.bladesPerClump * 2,
        );
        expect(result.receipt.workUnits).toBeLessThan(
          result.receipt.workBudget,
        );
        expect(result.receipt.elapsedMs).toBeGreaterThan(0);
      } finally {
        f.close();
      }
    },
  );

  it("checks the full corrected base edge, not only perfectly grounded endpoints", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(1, 0, 0, 3, (x) => 20 + 20 * Math.abs(x));
      const geometry = f.manager["lodGeometries"][1],
        p = geometry.getAttribute("position");
      const nx = 20 / Math.hypot(20, 1),
        ny = 1 / Math.hypot(20, 1);
      const x = (-(p.getX(0) + p.getX(1)) / 2) * ny,
        z = -(p.getZ(0) + p.getZ(1)) / 2;
      expect(x).toBeLessThan(0);
      expect(nx).toBeGreaterThan(0.99);
      const data = f.dataAt(surface, [[x, z]]),
        result = groundGrassBlades({
          ...f.request(surface, data),
          maximumBaseError: 0.001,
        });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw Error(result.reason);
      expect(result.data.count).toBe(0);
      expect(result.receipt.rejected.terrain_edge).toBe(1);
      expect(result.receipt.maxCorrectedBaseError).toBeGreaterThan(0.001);
    } finally {
      f.close();
    }
  });

  it("defers missing/overlapping neighbours and returns exact replacement identities", () => {
    const f = analyticOwner();
    try {
      const own = f.makeSurface(),
        adjacent = f.makeSurface(2, 100, 0, 64);
      const request = f.request(own, f.dataAt(own, [[49.8, 0]]));
      expect(groundGrassBlades(request)).toMatchObject({
        status: "defer",
        reason: "missing_surface",
      });
      const ready = groundGrassBlades({
        ...request,
        surfaces: [own, adjacent],
      });
      expect(ready.status).toBe("ready");
      if (ready.status !== "ready") throw Error(ready.reason);
      expect(
        ready.dependencies.find((d) => d.surface === adjacent)?.uses,
      ).toEqual(expect.arrayContaining(["endpoint", "edge", "envelope"]));
      const replacement = f.makeSurface(3, 100, 0, 16);
      const next = groundGrassBlades({
        ...request,
        surfaces: [own, replacement],
      });
      expect(next.status).toBe("ready");
      expect(next.dependencies.some((d) => d.surface === replacement)).toBe(
        true,
      );
      expect(next.dependencies.some((d) => d.surface === adjacent)).toBe(false);
      const overlap = f.makeSurface(4, 50, 0, 16, () => 20, 200);
      expect(
        groundGrassBlades({ ...request, surfaces: [own, adjacent, overlap] }),
      ).toMatchObject({ status: "defer", reason: "overlapping_surface" });
    } finally {
      f.close();
    }
  });

  it("checks swept pads, road capsules and elevated-water circles outside the anchor", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        request = f.request(surface),
        geometry = request.geometry;
      let maxX = -Infinity;
      for (let v = 0; v < geometry.getAttribute("position").count; v++)
        maxX = Math.max(
          maxX,
          transformedVertex(request.data, surface, geometry, 0, v).x,
        );
      const x = maxX + 0.1;
      const base = { ...request, wind: { x: 0.4, z: 0.1 } };
      const pad = {
        id: "swept",
        centerX: x,
        centerZ: 0,
        width: 0.1,
        depth: 10,
        height: 20,
        blendRadius: 0,
      };
      const cases = [
        {
          input: {
            ...base,
            terrainSurface: { ...emptySnapshot(), zones: [pad] },
          },
          reason: "pad",
        },
        {
          input: {
            ...base,
            roadSegments: [
              { startX: x, startZ: -5, endX: x, endZ: 5, width: 0.05 },
            ],
          },
          reason: "road",
        },
        {
          input: {
            ...base,
            terrainSurface: {
              ...emptySnapshot(),
              waterBodies: [
                {
                  id: "water",
                  centerX: x,
                  centerZ: 0,
                  radius: 0.2,
                  surfaceY: 19.95,
                },
              ],
            },
          },
          reason: "water",
        },
      ] as const;
      for (const { input, reason } of cases) {
        const result = groundGrassBlades(input);
        expect(result.status).toBe("ready");
        if (result.status !== "ready") throw Error(result.reason);
        expect(result.data.count).toBe(0);
        expect(result.receipt.rejected[reason]).toBe(1);
      }
      const belowOcean = groundGrassBlades({
        ...request,
        oceanLevel: 25,
        terrainSurface: {
          ...emptySnapshot(),
          waterBodies: [
            { id: "low", centerX: 0, centerZ: 0, radius: 20, surfaceY: 15 },
          ],
        },
      });
      expect(belowOcean.status).toBe("ready");
      if (belowOcean.status === "ready") expect(belowOcean.data.count).toBe(1);
    } finally {
      f.close();
    }
  });

  it("compacts all attributes in original accepted order without input/RNG mutation", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        data = f.dataAt(surface, [
          [-10, 0],
          [0, 0],
          [10, 0],
        ]),
        original = structuredClone(data);
      const request = {
        ...f.request(surface, data),
        terrainSurface: {
          ...emptySnapshot(),
          zones: [
            {
              id: "pad",
              centerX: 0,
              centerZ: 0,
              width: 4,
              depth: 4,
              height: 20,
              blendRadius: 0,
            },
          ],
        },
      };
      const a = groundGrassBlades(request),
        b = groundGrassBlades(request);
      expect(a.status).toBe("ready");
      expect(b.status).toBe("ready");
      if (a.status !== "ready" || b.status !== "ready") throw Error("deferred");
      expect(a.sourceIndices).toEqual(new Uint32Array([0, 2]));
      expect(a.rootDeltas).toEqual(b.rootDeltas);
      expect(data).toEqual(original);
      for (const [key, stride] of [
        ["offsets", 3],
        ["rotScaleHash", 3],
        ["groundColors", 3],
        ["grassTints", 4],
        ["groundNormals", 3],
      ] as const) {
        expect(a.data[key]).toEqual(
          Float32Array.from([
            ...data[key].slice(0, stride),
            ...data[key].slice(2 * stride, 3 * stride),
          ]),
        );
      }
    } finally {
      f.close();
    }
  });

  it("rejects malformed buffers/topology and explicitly cannot progress with an identical exhausted budget", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        request = f.request(surface);
      for (const key of [
        "offsets",
        "rotScaleHash",
        "groundColors",
        "grassTints",
        "groundNormals",
      ] as const) {
        const data = structuredClone(request.data);
        data[key][0] = NaN;
        expect(() => groundGrassBlades({ ...request, data })).toThrow(
          /Nonfinite/,
        );
      }
      expect(() =>
        groundGrassBlades({ ...request, wind: { x: Infinity, z: 0 } }),
      ).toThrow();
      expect(() =>
        groundGrassBlades({
          ...request,
          data: {
            ...request.data,
            count: GRASS_BLADE_GROUNDING_LIMITS.maxClumps + 1,
          },
        }),
      ).toThrow();
      expect(() =>
        groundGrassBlades({
          ...request,
          roadSegments: [
            { startX: 0, startZ: 0, endX: Infinity, endZ: 1, width: 2 },
          ],
        }),
      ).toThrow();
      expect(() =>
        groundGrassBlades({ ...request, surfaces: [surface, surface] }),
      ).toThrow();
      const invalid = request.geometry.clone();
      f.geometries.push(invalid);
      invalid.index!.setX(0, 9);
      expect(() =>
        groundGrassBlades({ ...request, geometry: invalid }),
      ).toThrow(/triangle order/);
      const invalidUv = request.geometry.clone();
      f.geometries.push(invalidUv);
      invalidUv.getAttribute("uv").setY(0, 0.5);
      expect(() =>
        groundGrassBlades({ ...request, geometry: invalidUv }),
      ).toThrow(/topology/);
      const a = groundGrassBlades({ ...request, workBudget: 3 }),
        b = groundGrassBlades({ ...request, workBudget: 3 });
      expect(a).toMatchObject({ status: "defer", reason: "work_budget" });
      expect(b).toMatchObject({ status: "defer", reason: "work_budget" });
      expect(a.receipt.workUnits).toBe(b.receipt.workUnits);
      expect("rootDeltas" in a).toBe(false);
    } finally {
      f.close();
    }
  });

  it("fails closed for finite road coordinates whose derived metrics overflow", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(1, 350, 0),
        request = f.request(surface),
        before = structuredClone(request.data);
      const finite = groundGrassBlades({
        ...request,
        roadSegments: [{ startX: 0, startZ: 2, endX: 1000, endZ: 2, width: 3 }],
      });
      expect(finite.status).toBe("ready");
      if (finite.status !== "ready") throw Error(finite.reason);
      expect(finite.receipt.rejected.road).toBe(1);
      for (const road of [
        { startX: 0, startZ: 2, endX: 1e308, endZ: 2, width: 3 },
        { startX: -1e308, startZ: 2, endX: 1e308, endZ: 2, width: 3 },
        { startX: 0, startZ: 0, endX: 1e154, endZ: 1e154, width: 3 },
      ]) {
        expect(Object.values(road).every(Number.isFinite)).toBe(true);
        expect(() =>
          groundGrassBlades({ ...request, roadSegments: [road] }),
        ).toThrow(/road segment/);
        expect(request.data).toEqual(before);
      }
    } finally {
      f.close();
    }
  });

  it("visits only original triangles with a strict budget and unchanged geometry", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(
          1,
          0,
          0,
          4,
          (x, z) => 20 + x * 0.1 - z * 0.2,
        ),
        geometry = f.geometries[0],
        before = geometry.getAttribute("position").array.slice();
      const triangles: number[][] = [];
      const result = surface.visitTrianglesInBounds(
        { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
        (...values) => triangles.push(values),
        5,
      );
      expect(result).toEqual({ visited: 5, exhausted: true });
      expect(triangles).toHaveLength(5);
      for (let face = 0; face < 5; face++) {
        const row = triangles[face];
        expect(row[9]).toBe(face);
        for (let v = 0; v < 3; v++) {
          const index = geometry.index!.getX(face * 3 + v),
            p = geometry.getAttribute("position");
          expect(row.slice(v * 3, v * 3 + 3)).toEqual([
            p.getX(index),
            p.getY(index),
            p.getZ(index),
          ]);
        }
      }
      expect(geometry.getAttribute("position").array).toEqual(before);
      expect(() =>
        surface.visitTrianglesInBounds(
          { minX: NaN, maxX: 1, minZ: 0, maxZ: 1 },
          () => {},
          1,
        ),
      ).toThrow();
    } finally {
      f.close();
    }
  });

  it("includes both exact Float32 boundary cells but no distant cells", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        p = f.geometries[0].getAttribute("position"),
        x = p.getX(7),
        z = p.getZ(7 * 16);
      const count = (px: number, pz: number) =>
        surface.visitTrianglesInBounds(
          { minX: px, maxX: px, minZ: pz, maxZ: pz },
          () => {},
          8,
        );
      expect(count(x, z)).toEqual({ visited: 8, exhausted: false });
      expect(count(x, z + 0.001)).toEqual({ visited: 4, exhausted: false });
      expect(count(x - 0.001, z + 0.001)).toEqual({
        visited: 2,
        exhausted: false,
      });
      expect(count(-50, -50)).toEqual({ visited: 2, exhausted: false });
      expect(count(-50.001, -50)).toEqual({ visited: 0, exhausted: false });
    } finally {
      f.close();
    }
  });
});

describe("actual v4 production-worker contact regressions and per-install CPU receipts", () => {
  let world: World,
    terrain: TerrainSystem,
    roads: RoadNetworkSystem,
    manager: GrassVisualManager,
    tree: TerrainQuadTree,
    worker: Worker;
  const geometries: THREE.BufferGeometry[] = [],
    surfaces = new Map<string, RetainedTerrainSurface>();
  let outputs: GrassWorkerOutput[] = [];
  beforeAll(async () => {
    await DataManager.getInstance().initialize();
    world = new World();
    terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
    await terrain.init();
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
    // Recorded blade IDs and gap magnitudes belong to the previous plaza.
    // Preserve the original regression input, not newly re-phased blade IDs.
    terrain.unregisterFlatZone("central_haven_lodge_grass_clearance");
    const plaza = terrain["flatZones"].get("central_haven_plaza")!;
    terrain.registerFlatZone({ ...plaza, excludeGrass: undefined });
    terrain["subscribeRoadNetworkEvents"]();
    await roads.init();
    await roads.start();
    const profile = terrain.getWorldTerrainProfile(),
      setup = terrain["buildGrassWorkerSetup"]();
    tree = new TerrainQuadTree({
      minSize: 100,
      maxDepth: 4,
      resolution: 16,
      fineDetailRegions: createCompactPreparationDetailRegions(
        profile,
        DataManager.getInstance().getAllWorldAreas(),
        64,
      ),
    });
    manager = new GrassVisualManager(
      setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
      new THREE.Group(),
      () => null,
      (x, z) => terrain.getHeightAtComputed(x, z),
      profile.water.threshold,
      (x, z) => terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
      (x, z) => terrain.isGrassExcludedAt(x, z),
      (x, z, e) => terrain.getTerrainColorAt(x, z, true, e),
      setup,
      COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
    );
    const provider = terrain["buildChunkTerrainProvider"]();
    for (let x = 250; x <= 550; x += 100)
      for (let z = 150; z <= 450; z += 100) {
        const node = tree.createNode(null, null, 100, x, z, 4);
        const { geometry } = assembleQuadChunkGeometry(
          generateQuadChunkDataSync(x, z, 100, node.resolution, provider),
          provider,
          terrain["CONFIG"].QUADTREE_SKIRT_DROP,
        );
        geometries.push(geometry);
        surfaces.set(
          `${x},${z}`,
          new RetainedTerrainSurface(
            node.id,
            provider.terrainProfileIdentity,
            x,
            z,
            100,
            node.resolution,
            geometry,
          ),
        );
      }
    worker = new Worker(
      `const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};${GRASS_WORKER_CODE};parentPort.on('message',data=>self.onmessage({data}));`,
      { eval: true, env: {} },
    );
    const run = (input: GrassWorkerInput) =>
      new Promise<GrassWorkerOutput>((resolve, reject) => {
        const error = (e: Error) => {
            worker.off("message", message);
            reject(e);
          },
          message = (m: { result?: GrassWorkerOutput; error?: string }) => {
            worker.off("error", error);
            if (m.error) reject(Error(m.error));
            else if (m.result) resolve(m.result);
            else reject(Error("Missing actual worker result"));
          };
        worker.once("error", error);
        worker.once("message", message);
        worker.postMessage(input);
      });
    outputs = [];
    for (const [x, z] of [
      [450, 350],
      [350, 250],
    ]) {
      const node = tree.createNode(null, null, 100, x, z, 4),
        input = manager["createWorkerInput"](node, `blade_${x}_${z}`, 1);
      outputs.push(await run({ ...input, clumpSpacing: 2.1 }));
    }
  }, 30000);
  afterAll(async () => {
    await worker?.terminate();
    manager?.destroy();
    tree?.dispose();
    geometries.forEach((g) => g.dispose());
    world?.destroy();
  });

  function requestAt(
    index: number,
    data?: GrassAnchorData,
  ): GrassBladeGroundingRequest {
    const [x, z] = [
        [450, 350],
        [350, 250],
      ][index],
      surface = surfaces.get(`${x},${z}`)!;
    const projected = projectGrassAnchors(
      outputs[index],
      surface,
      (wx, wz) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(wx, wz),
      (wx, wz) => terrain.isGrassExcludedAt(wx, wz),
    );
    const neighbourhood = [...surfaces.values()].filter(
      (s) => Math.abs(s.centerX - x) <= 100 && Math.abs(s.centerZ - z) <= 100,
    );
    return {
      data: data ?? projected,
      geometry: manager["lodGeometries"][1],
      lod: 1,
      ownSurface: surface,
      surfaces: neighbourhood,
      terrainSurface: terrain[
        "buildGrassWorkerSetup"
      ]().getTerrainSurfaceForRegion(x - 60, z - 60, x + 60, z + 60),
      roadSegments: roads.getRoadSegmentsForGPU(),
      oceanLevel: terrain.getWorldTerrainProfile().water.threshold,
      wind: {
        x:
          GRASS_CONFIG.WIND_STRENGTH *
          COMPACT_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX,
        z:
          GRASS_CONFIG.WIND_STRENGTH *
          COMPACT_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX *
          0.55,
      },
    };
  }

  it.each([
    [0, 70, 0.18737495046320163],
    [1, 506, 0.5674797854323792],
  ])(
    "reproduces measured gap %s/%s and validates every corrected base",
    (index, instance, expectedGap) => {
      const full = requestAt(index),
        data = one(full.data, instance),
        request = { ...full, data },
        out = sample();
      let originalGap = 0;
      for (let blade = 0; blade < 12; blade++)
        for (const side of [0, 1]) {
          const p = transformedVertex(
            data,
            request.ownSurface,
            request.geometry,
            0,
            blade * 5 + side,
          );
          const s = request.surfaces.find(
            (s) =>
              p.x >= s.centerX - 50 &&
              p.x < s.centerX + 50 &&
              p.z >= s.centerZ - 50 &&
              p.z < s.centerZ + 50,
          )!;
          expect(s.sample(p.x - s.centerX, p.z - s.centerZ, out)).toBe(true);
          originalGap = Math.max(originalGap, p.y - out.height);
        }
      expect(originalGap).toBeCloseTo(expectedGap, 5);
      const result = groundGrassBlades(request);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw Error(result.reason);
      expect(result.receipt.maxEndpointCorrection).toBeGreaterThan(
        expectedGap - 0.00001,
      );
      if (result.data.count) {
        for (let blade = 0; blade < 12; blade++) {
          const a = transformedVertex(
              data,
              request.ownSurface,
              request.geometry,
              0,
              blade * 5,
            ),
            b = transformedVertex(
              data,
              request.ownSurface,
              request.geometry,
              0,
              blade * 5 + 1,
            );
          a.y += result.rootDeltas[blade * 2];
          b.y += result.rootDeltas[blade * 2 + 1];
          for (let step = 0; step <= 16; step++) {
            const p = a.clone().lerp(b, step / 16),
              s = request.surfaces.find(
                (s) =>
                  p.x >= s.centerX - 50 &&
                  p.x < s.centerX + 50 &&
                  p.z >= s.centerZ - 50 &&
                  p.z < s.centerZ + 50,
              )!;
            expect(s.sample(p.x - s.centerX, p.z - s.centerZ, out)).toBe(true);
            expect(Math.abs(p.y - out.height)).toBeLessThan(0.02001);
          }
        }
      } else expect(result.receipt.rejected.terrain_edge).toBe(1);
      if (index === 1)
        expect(
          result.dependencies.some(
            (d) =>
              d.surface === surfaces.get("250,250") && d.uses.includes("edge"),
          ),
        ).toBe(true);
    },
  );

  it("measures actual dense per-install work and preserves unmodified worker buffers", () => {
    const receipts = [];
    for (const index of [0, 1]) {
      const request = requestAt(index),
        before = structuredClone(request.data),
        result = groundGrassBlades(request);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw Error(result.reason);
      expect(request.data).toEqual(before);
      expect(request.data.count).toBe([478, 600][index]);
      expect(result.data.count).toBe([458, 588][index]);
      expect(result.receipt.triangleVisits).toBe([11574, 15454][index]);
      expect(result.receipt.workUnits).toBeLessThan(400_000);
      expect(result.receipt.maxAcceptedBaseError).toBeLessThanOrEqual(0.02);
      expect(result.rootDeltas.byteLength).toBe(result.data.count * 96);
      receipts.push({
        center: [request.ownSurface.centerX, request.ownSurface.centerZ],
        ...result.receipt,
      });
    }
    console.info(
      "GrassBladeGrounding actual CPU install receipts",
      JSON.stringify(receipts),
    );
  });

  it("uses the same grounding seam for actual sync output and its worker prefix", () => {
    const request = requestAt(0),
      node = tree.createNode(null, null, 100, 450, 350, 4),
      sync = manager["generateInstanceData"](
        node,
        GRASS_CONFIG.LOD_TIERS[1].spacingMul,
      );
    if (!sync) throw Error("Expected the real populated sync leaf");
    const worker = outputs[0],
      prefix = {
        ...worker,
        count: sync.count,
        offsets: worker.offsets.slice(0, sync.count * 3),
        rotScaleHash: worker.rotScaleHash.slice(0, sync.count * 3),
        groundColors: worker.groundColors.slice(0, sync.count * 3),
        grassTints: worker.grassTints.slice(0, sync.count * 4),
        groundNormals: worker.groundNormals.slice(0, sync.count * 3),
      };
    const projectedSync = projectGrassAnchors(
        { ...prefix, ...sync },
        request.ownSurface,
        (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
        (x, z) => terrain.isGrassExcludedAt(x, z),
      ),
      projectedWorker = projectGrassAnchors(
        prefix,
        request.ownSurface,
        (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
        (x, z) => terrain.isGrassExcludedAt(x, z),
      );
    const a = groundGrassBlades({ ...request, data: projectedSync }),
      b = groundGrassBlades({ ...request, data: projectedWorker });
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    if (a.status !== "ready" || b.status !== "ready")
      throw Error("Deferred fixture");
    expect(a.sourceIndices).toEqual(b.sourceIndices);
    expect(a.rootDeltas).toEqual(b.rootDeltas);
    expect(a.data.offsets).toEqual(b.data.offsets);
    expect(a.data.rotScaleHash).toEqual(b.data.rotScaleHash);
    expect(a.data.groundNormals).toEqual(b.data.groundNormals);
    expect(a.dependencies).toEqual(b.dependencies);
  });
});
