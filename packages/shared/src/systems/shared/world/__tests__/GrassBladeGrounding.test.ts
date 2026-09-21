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
import type {
  GrassTerrainSurfaceSnapshot,
  GrassTerrainExclusionPolygon,
} from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import {
  groundGrassBlades,
  groundGrassBladeSteps,
  GrassBladeGroundingJob,
  GrassGroundingContinuation,
  GRASS_BLADE_GROUNDING_LIMITS,
  captureGrassBankVerge,
  captureGrassGroundingFailure,
  validateGrassGroundingConsumedWork,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
  type GrassGroundingRoadSegment,
  type GrassGroundingConsumedWork,
} from "../GrassBladeGrounding";
import {
  GrassVisualManager,
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  COMPACT_MEADOW_APPEARANCE,
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
  createClumpGeometry,
} from "../GrassVisualManager";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import {
  projectGrassAnchors,
  projectGrassAnchorSteps,
  remapGrassGroundingSteps,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
} from "../TerrainGridSurface";
import { TerrainSystem } from "../TerrainSystem";
import { createCompactLandscapeRockFootprints } from "../CompactLandscapeRockFootprints";
import { createGrassTerrainSurfaceOperations } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../TerrainQuadChunkGenerator";
import { gridGeometry } from "./terrain-grid.fixture";
import { getGrassBladeLayout } from "../GrassBladeLayout";
import {
  prepareGroundedGrassSteps,
  type GrassGroundingInputLease,
} from "../GrassGroundingPipeline";
import { groundGrassBladeSteps as legacyGroundGrassBladeSteps } from "./fixtures/LegacyGrassBladeGroundingReference";
import { sameFaceHash } from "./fixtures/GrassBladeGroundingSameFaceCases";

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

function analyticOwner(
  appearance: "ordinary" | "fine" | "isolated-fine-near4" = "ordinary",
) {
  const fine = appearance !== "ordinary";
  const geometryLayout = !fine
    ? undefined
    : appearance === "isolated-fine-near4"
      ? "fine-linear-sweep-near4-v1"
      : FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT;
  const config = fine
    ? createTerrainWorkerConfig(SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE, 16)
    : null;
  const identity = config?.TERRAIN_PROFILE_IDENTITY ?? "analytic";
  const manager = new GrassVisualManager(
    identity,
    new THREE.Group(),
    () => null,
    () => 20,
    config?.WATER_THRESHOLD ?? 0,
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
    config
      ? {
          terrainConfig: config,
          seed: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE.seed,
          biomeCenters: [],
          biomes: {},
          grassConfigs: {},
          tileSize: config.TILE_SIZE,
          getRoadSegmentsForRegion: () => [],
          getTerrainSurfaceForRegion: emptySnapshot,
        }
      : undefined,
    fine ? FINE_MEADOW_GRASS_VISUAL_PROFILE : {},
    undefined,
    undefined,
    undefined,
    fine ? FINE_MEADOW_APPEARANCE.id : undefined,
  );
  const geometries: THREE.BufferGeometry[] = [];
  // Explicit four-layout geometry exercises the real generator/grounding seam,
  // not an active four-layout manager or a private-array replacement.
  const bladeGeometries =
    appearance === "isolated-fine-near4"
      ? [0, 1, 2].map((lod) => {
          const layout = getGrassBladeLayout(lod, geometryLayout);
          const geometry = createClumpGeometry(
            layout.bladesPerClump,
            layout.bladeSegments,
            FINE_MEADOW_APPEARANCE,
          );
          geometries.push(geometry);
          return geometry;
        })
      : manager["lodGeometries"];
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
      identity,
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
    ...(geometryLayout === undefined ? {} : { geometryLayout }),
    geometry: bladeGeometries[lod],
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

/** Exact pre-optimization coordinator: independent of the candidate iterator.
 * Its real projection/grounding children are intentionally unchanged. */
function* historicalGroundedPipeline(
  request: Parameters<typeof prepareGroundedGrassSteps>[0],
  inputs: GrassGroundingInputLease,
  getWaterSurfaceAt: (x: number, z: number) => number,
  isExcludedAt: (x: number, z: number) => boolean,
): Generator<string, GrassBladeGroundingResult, void> {
  yield "pipeline_admission";
  if (
    !Number.isSafeInteger(request.data.count) ||
    request.data.count < 0 ||
    request.data.count > GRASS_BLADE_GROUNDING_LIMITS.maxClumps
  )
    throw new Error("Grass installation input exceeds clump capacity");
  const constraints = yield* inputs.steps;
  const projected = yield* projectGrassAnchorSteps(
    request.data,
    request.ownSurface,
    getWaterSurfaceAt,
    isExcludedAt,
  );
  const result = yield* groundGrassBladeSteps({
    ...request,
    ...constraints,
    data: projected,
  });
  if (result.status !== "ready") return result;
  const grounding = yield* remapGrassGroundingSteps(
    projected.grounding,
    result.sourceIndices,
  );
  return { ...result, grounding };
}

function pipelineInputs(
  request: GrassBladeGroundingRequest,
  events: string[] = [],
  yieldOnClose = false,
): GrassGroundingInputLease {
  return {
    isCurrent: () => true,
    steps: (function* () {
      try {
        events.push("started");
        const terrainSurface =
          yield* createGrassTerrainSurfaceOperations().cloneSnapshotSteps(
            request.terrainSurface,
          );
        return {
          terrainSurface,
          roadSegments: request.roadSegments.map((road) => ({ ...road })),
        };
      } finally {
        events.push("closed");
        if (yieldOnClose) yield "input_finally";
      }
    })(),
  };
}

function drainPipeline(
  steps: Generator<string, GrassBladeGroundingResult, void>,
) {
  const trace: string[] = [];
  for (let i = 0; i <= 1_000_000; i++) {
    const step = steps.next();
    if (step.done) return { trace, result: step.value };
    trace.push(step.value);
  }
  throw new Error("Grounding trace exceeded the unchanged operation cap");
}

describe("grounding pipeline exact forwarding (real numerical children)", () => {
  it.each(["ready", "empty", "pad", "road", "water", "missing", "budget"])(
    "retains the complete historical yield trace, bytes and dependencies: %s",
    (scenario) => {
      const f = analyticOwner();
      try {
        const surface = f.makeSurface();
        const request = f.request(
          surface,
          f.dataAt(
            surface,
            scenario === "empty"
              ? []
              : scenario === "missing"
                ? [[49.95, 0]]
                : [
                    [0, 0, 0.4],
                    [10, 3, 1.1],
                  ],
          ),
        );
        if (scenario === "pad")
          request.terrainSurface.zones.push({
            id: "pipeline-pad",
            centerX: 0,
            centerZ: 0,
            width: 2,
            depth: 2,
            height: 20,
            blendRadius: 0,
          });
        if (scenario === "road")
          request.roadSegments = [
            {
              startX: -5,
              startZ: 0,
              endX: 5,
              endZ: 0,
              width: 2,
            },
          ];
        if (scenario === "water") request.oceanLevel = 21;
        if (scenario === "missing") request.wind = { x: 3, z: 3 };
        if (scenario === "budget") request.workBudget = 1;
        const before = drainPipeline(
          historicalGroundedPipeline(
            request,
            pipelineInputs(request),
            () => -1000,
            () => false,
          ),
        );
        const after = drainPipeline(
          prepareGroundedGrassSteps(
            request,
            pipelineInputs(request),
            () => -1000,
            () => false,
          ),
        );
        expect(after.trace).toEqual(before.trace);
        expect(after.trace[0]).toBe("pipeline_admission");
        const withoutElapsed = (result: GrassBladeGroundingResult) => ({
          ...result,
          receipt: { ...result.receipt, elapsedMs: 0 },
        });
        expect(withoutElapsed(after.result)).toEqual(
          withoutElapsed(before.result),
        );
        expect(after.result.dependencies.map((d) => d.uses)).toEqual(
          before.result.dependencies.map((d) => d.uses),
        );
        after.result.dependencies.forEach((d, i) =>
          expect(d.surface).toBe(before.result.dependencies[i].surface),
        );
        if (
          before.result.status === "ready" &&
          after.result.status === "ready"
        ) {
          for (const key of [
            "offsets",
            "rotScaleHash",
            "groundColors",
            "grassTints",
            "groundNormals",
          ] as const) {
            const a = before.result.data[key],
              b = after.result.data[key];
            expect(
              new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
            ).toEqual(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
          }
          for (const key of ["rootDeltas", "sourceIndices"] as const) {
            const a = before.result[key],
              b = after.result[key];
            expect(
              new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
            ).toEqual(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
          }
          expect(after.result.data.count).toBe(
            scenario === "empty" || scenario === "water"
              ? 0
              : scenario === "pad" || scenario === "road"
                ? 1
                : 2,
          );
        } else {
          expect(after.result).toMatchObject({
            status: "defer",
            reason: scenario === "budget" ? "work_budget" : "missing_surface",
          });
        }
      } finally {
        f.close();
      }
    },
  );

  it.each([
    "unstarted",
    "pipeline_admission",
    "snapshot_header",
    "anchor_validation",
    "request_bounds",
    "provenance_validation",
  ])("keeps lazy return/throw closure exact at %s", (phase) => {
    const f = analyticOwner();
    try {
      const request = f.request(f.makeSurface());
      for (const method of ["return", "throw"] as const) {
        const error = new Error("caller identity");
        const runs = [
          historicalGroundedPipeline,
          prepareGroundedGrassSteps,
        ].map((make) => {
          const events: string[] = [];
          const inputs = pipelineInputs(request, events);
          const steps = make(
            request,
            inputs,
            () => -1000,
            () => false,
          );
          expect(events).toEqual([]);
          if (phase !== "unstarted") {
            let found = false;
            for (let i = 0; i < 10000; i++) {
              const next = steps.next();
              if (next.done) throw Error("Missing requested pipeline phase");
              if (next.value === phase) {
                found = true;
                break;
              }
            }
            expect(found).toBe(true);
          }
          if (method === "return")
            expect(steps.return(undefined as never)).toEqual({
              done: true,
              value: undefined,
            });
          else {
            let caught: unknown;
            try {
              steps.throw(error);
            } catch (e) {
              caught = e;
            }
            expect(caught).toBe(error);
          }
          expect(steps.next()).toEqual({ done: true, value: undefined });
          expect(steps.return(undefined as never)).toEqual({
            done: true,
            value: undefined,
          });
          expect(() => steps.throw(error)).toThrow(error);
          return { events, inputAfter: inputs.steps.next() };
        });
        expect(runs[1]).toEqual(runs[0]);
      }
    } finally {
      f.close();
    }
  });

  it("preserves child finally yields during return and the original thrown error", () => {
    const f = analyticOwner();
    try {
      const request = f.request(f.makeSurface());
      const sentinel = new Error("projection callback identity");
      for (const make of [
        historicalGroundedPipeline,
        prepareGroundedGrassSteps,
      ]) {
        const inputs = pipelineInputs(request, [], true);
        const steps = make(
          request,
          inputs,
          () => {
            throw sentinel;
          },
          () => false,
        );
        expect(steps[Symbol.iterator]()).toBe(steps);
        expect(steps.next().value).toBe("pipeline_admission");
        expect(steps.next().value).toBe("snapshot_header");
        // Supplying a real constraint value allows native yield* to continue
        // after the delegated finally yields; the candidate must do the same.
        const constraints = {
          terrainSurface: emptySnapshot(),
          roadSegments: [],
        };
        expect(
          steps.return(constraints as unknown as GrassBladeGroundingResult),
        ).toEqual({ done: false, value: "input_finally" });
        expect(steps.next().value).toBe("anchor_validation");
        expect(steps.next().value).toBe("anchor_projection");
        let caught: unknown;
        try {
          steps.next();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(sentinel);
        expect(steps.next()).toEqual({ done: true, value: undefined });
      }
    } finally {
      f.close();
    }
  });

  it("keeps admission lazy and rejects reentrant resume without closing the outer call", () => {
    const f = analyticOwner();
    try {
      const request = f.request(f.makeSurface());
      for (const make of [
        historicalGroundedPipeline,
        prepareGroundedGrassSteps,
      ]) {
        const invalid = { ...request, data: { ...request.data, count: 4097 } };
        const events: string[] = [];
        const steps = make(
          invalid,
          pipelineInputs(invalid, events),
          () => -1000,
          () => false,
        );
        expect(steps.next()).toEqual({
          done: false,
          value: "pipeline_admission",
        });
        expect(events).toEqual([]);
        expect(() => steps.next()).toThrow(
          "Grass installation input exceeds clump capacity",
        );
        expect(steps.next()).toEqual({ done: true, value: undefined });
        expect(events).toEqual([]);
        let reentrant: Generator<string, GrassBladeGroundingResult, void>;
        let caught: unknown;
        reentrant = make(
          request,
          pipelineInputs(request),
          () => {
            try {
              reentrant.next();
            } catch (error) {
              caught = error;
            }
            return -1000;
          },
          () => false,
        );
        expect(drainPipeline(reentrant).result.status).toBe("ready");
        expect(caught).toBeInstanceOf(TypeError);
        expect((caught as Error).message).toBe("Generator is already running");
      }
    } finally {
      f.close();
    }
  });
});

describe("two-interval ordering on actual retained terrain", () => {
  const crossingRequest = (
    owner: ReturnType<typeof analyticOwner>,
    rotation: number,
    dense = false,
  ) => {
    const surface = owner.makeSurface(
      1,
      0,
      0,
      dense ? 129 : 3,
      () => 20,
      dense ? 16 : 100,
    );
    const data = owner.dataAt(surface, [[0, 0, rotation]]);
    if (dense) data.rotScaleHash[1] = 4;
    const request = owner.request(surface, data, 1);
    const left = transformedVertex(data, surface, request.geometry, 0, 0);
    const right = transformedVertex(data, surface, request.geometry, 0, 1);
    // One regular cell's interior diagonal for the pair case; a shared grid
    // vertex for the dense case. Keep the generated blade vertices unchanged.
    const center = dense ? 0 : -25;
    data.offsets[0] = center - (left.x + right.x) / 2;
    data.offsets[2] = center - (left.z + right.z) / 2;
    return request;
  };

  it.each([0, Math.PI])(
    "orders a real diagonal crossing at rotation %s with exact oracle and sliced results",
    (rotation) => {
      const owner = analyticOwner("fine");
      try {
        const request = crossingRequest(owner, rotation);
        const before = structuredClone(request.data);
        const faces = [0, 1].map((vertex) => {
          const point = transformedVertex(
            request.data,
            request.ownSurface,
            request.geometry,
            0,
            vertex,
          );
          const result = sample();
          expect(request.ownSurface.sample(point.x, point.z, result)).toBe(
            true,
          );
          return result.faceIndex;
        });
        // Both roots are in the same coarse cell, but on opposite faces.
        // Therefore this real first edge crosses exactly two triangles.
        expect([...faces].sort((a, b) => a - b)).toEqual([0, 1]);
        const actual = drainPipeline(groundGrassBladeSteps(request));
        const historical = drainPipeline(legacyGroundGrassBladeSteps(request));
        const pairIndex = actual.trace.indexOf("interval_pair_order");
        expect(pairIndex).toBeGreaterThanOrEqual(0);
        expect(actual.trace.slice(pairIndex + 1, pairIndex + 3)).toEqual([
          "edge_interval",
          "edge_interval",
        ]);
        expect(actual.trace).not.toContain("interval_scratch_allocation");
        expect(actual.trace).not.toContain("interval_merge");
        expect(actual.trace).not.toContain("interval_copy");
        expect(actual.result.status).toBe("ready");
        expect(sameFaceHash(actual.result)).toBe(
          sameFaceHash(historical.result),
        );
        const synchronous = groundGrassBlades(request);
        expect(withoutGroundingElapsed(actual.result)).toEqual(
          withoutGroundingElapsed(synchronous),
        );
        for (const sliceSize of [1, 7, 64]) {
          const job = new GrassBladeGroundingJob(request, () =>
            request.ownSurface.matchesGeometry(owner.geometries[0]),
          );
          while (job.state.status === "running") {
            job.advance(sliceSize);
            expect(job.lastSliceOperations).toBeLessThanOrEqual(sliceSize);
          }
          expect(job.state.status).toBe("ready");
          if (job.state.status !== "ready") throw Error(job.state.status);
          expect(withoutGroundingElapsed(job.state.result)).toEqual(
            withoutGroundingElapsed(synchronous),
          );
        }
        expect(request.data).toEqual(before);
      } finally {
        owner.close();
      }
    },
  );

  it("retains the general merge path for a real multi-cell root crossing", () => {
    const owner = analyticOwner("fine");
    try {
      const request = crossingRequest(owner, 0, true);
      // The full scaled clump, not just its first root, needs real support.
      // Verify both fade endpoints independently before asking the core to fit.
      const half = request.ownSurface.size / 2;
      for (
        let vertex = 0;
        vertex < request.geometry.getAttribute("position").count;
        vertex++
      ) {
        for (const fade of [0, 1]) {
          const point = transformedVertex(
            request.data,
            request.ownSurface,
            request.geometry,
            0,
            vertex,
            fade,
          );
          expect(Math.abs(point.x)).toBeLessThan(half - 0.00001);
          expect(Math.abs(point.z)).toBeLessThan(half - 0.00001);
        }
      }
      const actual = drainPipeline(groundGrassBladeSteps(request));
      const historical = drainPipeline(legacyGroundGrassBladeSteps(request));
      expect(
        actual.result.status,
        actual.result.status === "defer" ? actual.result.reason : undefined,
      ).toBe("ready");
      expect(actual.trace).toContain("interval_scratch_allocation");
      expect(actual.trace).toContain("interval_merge");
      expect(actual.trace).toContain("interval_copy");
      const firstMerge = actual.trace.indexOf("interval_scratch_allocation");
      const firstCoverage = actual.trace.indexOf("edge_interval", firstMerge);
      let coverageCount = 0;
      for (
        let i = firstCoverage;
        i >= 0 && actual.trace[i] === "edge_interval";
        i++
      )
        coverageCount++;
      expect(coverageCount).toBeGreaterThan(2);
      expect(sameFaceHash(actual.result)).toBe(sameFaceHash(historical.result));
    } finally {
      owner.close();
    }
  });

  it.each(["caller", "invalidated"] as const)(
    "retires %s work while the real two-interval ordering is suspended",
    (reason) => {
      const owner = analyticOwner("fine");
      try {
        const request = crossingRequest(owner, 0);
        const geometry = owner.geometries[0];
        const job = new GrassBladeGroundingJob(request, () =>
          request.ownSurface.matchesGeometry(geometry),
        );
        while (
          job.state.status === "running" &&
          job.lastPhase !== "interval_pair_order"
        )
          job.advance(1);
        expect(job.state.status).toBe("running");
        expect(job.lastPhase).toBe("interval_pair_order");
        const operations = job.operations;
        if (reason === "invalidated") {
          geometry.setAttribute(
            "position",
            geometry.getAttribute("position").clone(),
          );
          job.advance(1);
        } else job.cancel();
        expect(job.state).toEqual({ status: "cancelled", reason });
        expect(job.operations).toBe(operations);
        expect("result" in job.state).toBe(false);
        const terminal = job.state;
        expect(job.advance(64)).toBe(terminal);
        expect(job.operations).toBe(operations);
      } finally {
        owner.close();
      }
    },
  );
});

describe("CPU per-blade grounding prototype (no renderer/GPU)", () => {
  it("requires an explicit near-four layout and retains two corrections per blade", () => {
    const fine = analyticOwner("isolated-fine-near4"),
      ordinary = analyticOwner();
    try {
      const surface = fine.makeSurface(),
        request = fine.request(surface, undefined, 0);
      expect(request.geometryLayout).toBe("fine-linear-sweep-near4-v1");
      expect(request.geometry.getAttribute("position").count).toBe(216);
      expect(request.geometry.index!.count).toBe(168 * 3);
      const wrongProgress = request.geometry.clone();
      fine.geometries.push(wrongProgress);
      wrongProgress.getAttribute("uv").setY(2, Math.fround(1 / 3));
      expect(() =>
        groundGrassBlades({ ...request, geometry: wrongProgress }),
      ).toThrow(/topology/);
      const result = groundGrassBlades(request);
      if (result.status !== "ready") throw new Error(result.reason);
      expect(result.receipt.geometryLayout).toBe(request.geometryLayout);
      expect(result.receipt.bladesPerClump).toBe(24);
      expect(result.data.count).toBe(1);
      expect(result.rootDeltas.length).toBe(48);
      expect(result.receipt.correctionBytes).toBe(48 * 4);
      for (const geometryLayout of [
        undefined,
        "fine-linear-sweep-3seg-v1",
      ] as const)
        expect(() => groundGrassBlades({ ...request, geometryLayout })).toThrow(
          /vertex attributes/,
        );
      expect(() =>
        groundGrassBlades({
          ...request,
          geometry: ordinary.manager["lodGeometries"][0],
        }),
      ).toThrow(/vertex attributes/);
      expect(() =>
        groundGrassBlades({
          ...request,
          geometryLayout: "" as typeof request.geometryLayout,
        }),
      ).toThrow(/layout/);

      // An explicit fine three-segment contract is independently still admitted;
      // this CPU topology test does not claim the ordinary shape is fine art.
      const old = groundGrassBlades({
        ...request,
        geometry: ordinary.manager["lodGeometries"][0],
        geometryLayout: "fine-linear-sweep-3seg-v1",
      });
      expect(old.receipt.geometryLayout).toBe("fine-linear-sweep-3seg-v1");
      const legacy = groundGrassBlades(
        ordinary.request(ordinary.makeSurface(), undefined, 0),
      );
      expect(
        Object.prototype.hasOwnProperty.call(legacy.receipt, "geometryLayout"),
      ).toBe(false);
      const exhausted = groundGrassBlades({
        ...request,
        workBudget: result.receipt.workUnits - 1,
      });
      expect(exhausted).toMatchObject({
        status: "defer",
        reason: "work_budget",
      });
      expect("rootDeltas" in exhausted).toBe(false);
    } finally {
      fine.close();
      ordinary.close();
    }
  });

  it.each([
    ["ordinary", 0],
    ["ordinary", 1],
    ["ordinary", 2],
    ["fine", 0],
    ["fine", 1],
    ["isolated-fine-near4", 0],
  ] as const)(
    "preserves exact %s LOD%s output and every distant-polygon work/yield charge",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
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
            [0, 0, 0.7],
            [4, 3, 1.8],
            [-3, 5, 4.7],
          ]),
          lod,
        );
        const drain = (input: GrassBladeGroundingRequest) => {
          const steps = groundGrassBladeSteps(input);
          const phases: Record<string, number> = {};
          let step = steps.next();
          while (!step.done) {
            phases[step.value] = (phases[step.value] ?? 0) + 1;
            step = steps.next();
          }
          return { phases, result: step.value };
        };
        const baseline = drain(request);
        expect(baseline.result.status).toBe("ready");
        if (baseline.result.status !== "ready")
          throw Error("Expected real retained support");
        expect(baseline.result.data.count).toBe(3);
        const original = structuredClone(request.data);
        for (const [count, vertices] of [
          [1, 3],
          [24, 64],
        ]) {
          const polygons: GrassTerrainExclusionPolygon[] = Array.from(
            { length: count },
            (_, index) => {
              const points = Array.from({ length: vertices }, (_, i) => ({
                x:
                  1000 +
                  index * 10 +
                  2 * Math.cos((i * 2 * Math.PI) / vertices),
                z: 1000 + 2 * Math.sin((i * 2 * Math.PI) / vertices),
              }));
              return {
                id: `distant-${index}`,
                vertices: points,
                minX: Math.min(...points.map((p) => p.x)),
                maxX: Math.max(...points.map((p) => p.x)),
                minZ: Math.min(...points.map((p) => p.z)),
                maxZ: Math.max(...points.map((p) => p.z)),
              };
            },
          );
          const input = {
            ...request,
            terrainSurface: { ...emptySnapshot(), exclusionPolygons: polygons },
          };
          const before = structuredClone(input.terrainSurface);
          const actual = drain(input);
          expect(actual.result.status).toBe("ready");
          if (actual.result.status !== "ready")
            throw Error("Distant bounds changed admission");
          const {
            elapsedMs: _baselineElapsed,
            workUnits: baselineWork,
            ...baselineReceipt
          } = baseline.result.receipt;
          const {
            elapsedMs: _actualElapsed,
            workUnits: actualWork,
            ...actualReceipt
          } = actual.result.receipt;
          // All five attributes, source indices, root deltas, accepted bounds,
          // dependencies/leases and all other receipt values remain exact.
          expect({ ...actual.result, receipt: actualReceipt }).toEqual({
            ...baseline.result,
            receipt: baselineReceipt,
          });
          expect(actualWork - baselineWork).toBe(count * request.data.count);
          expect(actual.phases).toEqual({
            ...baseline.phases,
            snapshot_polygon: count,
            snapshot_polygon_vertex: count * vertices,
            snapshot_polygon_convexity: count * vertices * vertices,
            grounding_operation:
              baseline.phases.grounding_operation + count * request.data.count,
          });
          expect(request.data).toEqual(original);
          expect(input.terrainSurface).toEqual(before);
          const exhausted = groundGrassBlades({
            ...input,
            workBudget: actualWork - 1,
          });
          expect(exhausted).toMatchObject({
            status: "defer",
            reason: "work_budget",
          });
          expect(exhausted.receipt.workUnits).toBe(actualWork - 1);
          expect("rootDeltas" in exhausted).toBe(false);
        }
      } finally {
        f.close();
      }
    },
  );

  it("retains swept-boundary contact rejection and exact output immediately outside an exclusion", () => {
    const f = analyticOwner("fine");
    try {
      const surface = f.makeSurface();
      const request = {
        ...f.request(surface, f.dataAt(surface, [[0, 0, 0.71]]), 0),
        wind: { x: 0.3, z: 0.165 },
      };
      const baseline = groundGrassBlades(request);
      if (baseline.status !== "ready" || !baseline.sweptBounds)
        throw Error("Expected one grounded clump");
      const box = baseline.sweptBounds;
      const rectangle = (minimum: number): GrassTerrainExclusionPolygon => ({
        id: "touching-rock",
        minX: minimum,
        maxX: minimum + 1,
        minZ: box.minZ,
        maxZ: box.maxZ,
        vertices: [
          { x: minimum, z: box.minZ },
          { x: minimum + 1, z: box.minZ },
          { x: minimum + 1, z: box.maxZ },
          { x: minimum, z: box.maxZ },
        ],
      });
      const touching = groundGrassBlades({
        ...request,
        terrainSurface: {
          ...emptySnapshot(),
          exclusionPolygons: [rectangle(box.maxX)],
        },
      });
      expect(touching).toMatchObject({
        status: "ready",
        data: { count: 0 },
        sweptBounds: null,
        receipt: { rejected: { pad: 1 } },
      });
      const outside = groundGrassBlades({
        ...request,
        terrainSurface: {
          ...emptySnapshot(),
          exclusionPolygons: [rectangle(box.maxX + 1e-10)],
        },
      });
      if (outside.status !== "ready")
        throw Error("Separated exclusion deferred");
      const {
        elapsedMs: _baselineElapsed,
        workUnits: baselineWork,
        ...baselineReceipt
      } = baseline.receipt;
      const {
        elapsedMs: _outsideElapsed,
        workUnits: outsideWork,
        ...outsideReceipt
      } = outside.receipt;
      expect({ ...outside, receipt: outsideReceipt }).toEqual({
        ...baseline,
        receipt: baselineReceipt,
      });
      expect(outsideWork).toBe(baselineWork + 1);
    } finally {
      f.close();
    }
  });

  it.each([
    ["ordinary", 0],
    ["ordinary", 1],
    ["ordinary", 2],
    ["fine", 0],
    ["fine", 1],
    ["isolated-fine-near4", 0],
  ] as const)(
    "retains exact %s road clearance at all spatial-cell boundaries at LOD%s",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
      try {
        const surface = f.makeSurface();
        for (const x of [-37.5, -25, -12.5, 0, 12.5, 25, 37.5]) {
          const data = f.dataAt(surface, [
            [x, x - 0.00001, 0.71],
            [x, x + 0.00001, 1.37],
          ]);
          const request = {
            ...f.request(surface, data, lod),
            wind: { x: 0.3, z: 0.2 },
          };
          const road = {
            startX: x,
            endX: x,
            startZ: -120,
            endZ: 120,
            width: 0.001,
          };
          const crossing = groundGrassBlades({
            ...request,
            roadSegments: [road],
          });
          expect(crossing.status).toBe("ready");
          expect(crossing.receipt.rejected.road).toBe(2);
          const distant = groundGrassBlades({
            ...request,
            roadSegments: [{ ...road, startX: 1e6, endX: 1e6 }],
          });
          expect(distant.status).toBe("ready");
          expect(distant.receipt.retainedClumps).toBe(2);
          // Multiple cells and duplicate references must still produce one result
          // per clump; the final capsule predicate, not an AABB, rejects grass.
          const duplicate = groundGrassBlades({
            ...request,
            roadSegments: [road, road, { ...road, width: 1024 }],
          });
          expect(duplicate.status).toBe("ready");
          expect(duplicate.receipt.rejected.road).toBe(2);
        }
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ["ordinary", 0],
    ["ordinary", 1],
    ["ordinary", 2],
    ["fine", 0],
    ["fine", 1],
    ["isolated-fine-near4", 0],
  ] as const)(
    "retains %s LOD%s swept grass through partial road shoulders without bypassing full cores, pads or water",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
      try {
        const surface = f.makeSurface();
        const request = {
          ...f.request(surface, f.dataAt(surface, [[0, 0, 0.71]]), lod),
          wind: { x: 0.4, z: 0.3 },
        };
        const baseline = groundGrassBlades(request);
        expect(baseline.status).toBe("ready");
        if (baseline.status !== "ready") throw Error(baseline.reason);
        expect(baseline.data.count).toBe(1);
        const before = structuredClone(request.data);
        const core: GrassGroundingRoadSegment = {
          startX: 0,
          startZ: -10,
          endX: 0,
          endZ: 10,
          width: 2,
        };
        const { elapsedMs: _baselineElapsed, ...baselineReceipt } =
          baseline.receipt;
        for (const maxInfluence of [0, 0.45, 0.65, 0.8]) {
          const shoulder = { ...core, blendWidth: 4, maxInfluence };
          const result = groundGrassBlades({
            ...request,
            // Repeated/overlapping partial masks combine by max, not sum.
            roadSegments: [shoulder, shoulder, { ...shoulder, width: 1024 }],
          });
          const { elapsedMs: _elapsed, ...receipt } = result.receipt;
          expect({ ...result, receipt }).toEqual({
            ...baseline,
            receipt: baselineReceipt,
          });
          expect(request.data).toEqual(before);
        }
        const shoulder = { ...core, blendWidth: 4, maxInfluence: 0.65 };
        for (const roadSegments of [[core], [shoulder, core], [core, shoulder]])
          expect(groundGrassBlades({ ...request, roadSegments })).toMatchObject(
            {
              status: "ready",
              receipt: { retainedClumps: 0, rejected: { road: 1 } },
            },
          );
        expect(
          groundGrassBlades({
            ...request,
            roadSegments: [shoulder],
            terrainSurface: {
              ...emptySnapshot(),
              zones: [
                {
                  id: "partial-shoulder-pad",
                  centerX: 0,
                  centerZ: 0,
                  width: 2,
                  depth: 2,
                  height: 20,
                  blendRadius: 0,
                },
              ],
            },
          }),
        ).toMatchObject({
          status: "ready",
          receipt: { retainedClumps: 0, rejected: { pad: 1, road: 0 } },
        });
        expect(
          groundGrassBlades({
            ...request,
            roadSegments: [shoulder],
            terrainSurface: {
              ...emptySnapshot(),
              waterBodies: [
                {
                  id: "partial-shoulder-water",
                  centerX: 0,
                  centerZ: 0,
                  radius: 10,
                  surfaceY: 19.95,
                },
              ],
            },
          }),
        ).toMatchObject({
          status: "ready",
          receipt: { retainedClumps: 0, rejected: { water: 1, road: 0 } },
        });
        expect(
          groundGrassBlades({
            ...request,
            roadSegments: [shoulder],
            workBudget: baseline.receipt.workUnits - 1,
          }),
        ).toMatchObject({ status: "defer", reason: "work_budget" });
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ["ordinary", 0],
    ["ordinary", 1],
    ["ordinary", 2],
    ["fine", 0],
    ["fine", 1],
  ] as const)(
    "keeps absent %s LOD%s road fields and explicit legacy defaults byte/work equivalent",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
      try {
        const surface = f.makeSurface();
        const road = {
          startX: 0,
          startZ: -10,
          endX: 0,
          endZ: 10,
          width: 1,
        };
        const request = {
          ...f.request(
            surface,
            f.dataAt(surface, [
              [-4, 0, 0.3],
              [0, 0, 1.2],
              [4, 0, 2.1],
            ]),
            lod,
          ),
          wind: { x: 0.2, z: 0.1 },
        };
        const historical = groundGrassBlades({
          ...request,
          roadSegments: [road],
        });
        expect(historical.status).toBe("ready");
        if (historical.status !== "ready") throw Error(historical.reason);
        expect(Array.from(historical.sourceIndices)).toEqual([0, 2]);
        const { elapsedMs: _historicalElapsed, ...historicalReceipt } =
          historical.receipt;
        for (const extension of [
          { blendWidth: 0.5 },
          { maxInfluence: 1 },
          { blendWidth: 0.5, maxInfluence: 1 },
        ]) {
          const result = groundGrassBlades({
            ...request,
            roadSegments: [{ ...road, ...extension }],
          });
          const { elapsedMs: _elapsed, ...receipt } = result.receipt;
          expect({ ...result, receipt }).toEqual({
            ...historical,
            receipt: historicalReceipt,
          });
        }
        expect(Object.prototype.hasOwnProperty.call(road, "blendWidth")).toBe(
          false,
        );
        expect(Object.prototype.hasOwnProperty.call(road, "maxInfluence")).toBe(
          false,
        );
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ["ordinary", 1],
    ["fine", 0],
    ["fine", 1],
  ] as const)(
    "uses the independently inverted >0.8 %s LOD%s shoulder boundary for the full swept envelope",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
      try {
        const surface = f.makeSurface();
        const request = {
          ...f.request(surface, f.dataAt(surface, [[0, 0, 0.91]]), lod),
          wind: { x: 0.35, z: 0.25 },
        };
        const baseline = groundGrassBlades(request);
        expect(baseline.status).toBe("ready");
        if (baseline.status !== "ready" || !baseline.sweptBounds)
          throw Error("Expected actual swept grounding envelope");
        for (const [blendWidth, maxInfluence] of [
          [0.25, 0.81],
          [4, 0.9],
          [0, 1],
          [2, 1],
        ] as const) {
          // Closed-form inverse is independent of the production bisection.
          const inverse =
            0.5 - Math.sin(Math.asin(1 - (2 * 0.8) / maxInfluence) / 3);
          const radius = 0.1 + blendWidth * (1 - inverse);
          for (const offset of [-1e-7, 1e-7]) {
            const x = baseline.sweptBounds.maxX + radius + offset;
            const result = groundGrassBlades({
              ...request,
              roadSegments: [
                {
                  startX: x,
                  startZ: -10,
                  endX: x,
                  endZ: 10,
                  width: 0.2,
                  blendWidth,
                  maxInfluence,
                },
              ],
            });
            expect(result.status).toBe("ready");
            expect(result.receipt.rejected.road).toBe(Number(offset < 0));
            expect(result.receipt.retainedClumps).toBe(Number(offset > 0));
          }
        }
      } finally {
        f.close();
      }
    },
  );

  it("rejects malformed optional road profiles even when their partial peak would skip exclusion", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      const request = f.request(surface);
      const original = structuredClone(request.data);
      for (const [key, values] of [
        ["blendWidth", [undefined, null, NaN, Infinity, -0.01, 1024.01, "2"]],
        ["maxInfluence", [undefined, null, NaN, Infinity, -0.01, 1.01, "0.65"]],
      ] as const) {
        for (const value of values) {
          const road: GrassGroundingRoadSegment = {
            startX: 0,
            startZ: -5,
            endX: 0,
            endZ: 5,
            width: 2,
            maxInfluence: 0.65,
          };
          Object.defineProperty(road, key, { value, enumerable: true });
          expect(() =>
            groundGrassBlades({ ...request, roadSegments: [road] }),
          ).toThrow(/road influence profile/);
          expect(request.data).toEqual(original);
        }
      }
      const inherited: GrassGroundingRoadSegment = {
        startX: 0,
        startZ: -5,
        endX: 0,
        endZ: 5,
        width: 2,
      };
      Object.setPrototypeOf(inherited, { maxInfluence: 0.65 });
      expect(() =>
        groundGrassBlades({ ...request, roadSegments: [inherited] }),
      ).toThrow(/road influence profile/);
      const accessor: GrassGroundingRoadSegment = {
        startX: 0,
        startZ: -5,
        endX: 0,
        endZ: 5,
        width: 2,
      };
      let getterReads = 0;
      Object.defineProperty(accessor, "blendWidth", {
        get: () => {
          getterReads++;
          return 2;
        },
      });
      expect(() =>
        groundGrassBlades({ ...request, roadSegments: [accessor] }),
      ).toThrow(/road influence profile/);
      expect(getterReads).toBe(0);
    } finally {
      f.close();
    }
  });

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

  it.each([
    ["ordinary", 0],
    ["ordinary", 1],
    ["ordinary", 2],
    ["fine", 0],
    ["fine", 1],
    ["isolated-fine-near4", 0],
  ] as const)(
    "bounds every corrected %s LOD%s vertex through fade and wind using independent Three transforms",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
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
        const tier = getGrassBladeLayout(lod, request.geometryLayout),
          vpb = tier.verticesPerBlade;
        const expectedBounds = new THREE.Box3();
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
                  expectedBounds.expandByPoint(p);
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
        // Pin all six extrema, not merely containment by an oversized box.
        // Independent quaternion math may differ by sub-micrometre rounding
        // from the scalar transform on Float32 normals. The production guard
        // is still exactly 1e-5; scale/rotation/fade/wind are all represented.
        expectedBounds.expandByScalar(1e-5);
        for (const [actual, expected] of [
          [b.minX, expectedBounds.min.x],
          [b.maxX, expectedBounds.max.x],
          [b.minY, expectedBounds.min.y],
          [b.maxY, expectedBounds.max.y],
          [b.minZ, expectedBounds.min.z],
          [b.maxZ, expectedBounds.max.z],
        ])
          expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
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

  it("shares an absolute grounding deadline without renewing time or operation allowances", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      const first = new GrassBladeGroundingJob(f.request(surface), () => true);
      const second = new GrassBladeGroundingJob(f.request(surface), () => true);
      const expired = performance.now();
      expect(first.advance(7, expired).status).toBe("running");
      expect(first.operations).toBe(0);
      expect(first.lastSliceOperations).toBe(0);
      expect(second.advance(7, expired).status).toBe("running");
      expect(second.operations).toBe(0);
      for (const deadline of [NaN, Infinity, -Infinity, -1])
        expect(() => first.advance(7, deadline)).toThrow(
          "Invalid grounding shared deadline",
        );
      const deadline =
        performance.now() + GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs;
      first.advance(3, deadline);
      second.advance(7 - first.lastSliceOperations, deadline);
      expect(first.operations + second.operations).toBeLessThanOrEqual(7);
      const before = second.operations;
      second.advance(7, expired);
      expect(second.operations).toBe(before);
      expect(second.lastSliceOperations).toBe(0);
      while (first.state.status === "running") first.advance();
      while (second.state.status === "running") second.advance();
      expect(first.state.status).toBe("ready");
      expect(second.state.status).toBe("ready");
      if (first.state.status !== "ready" || second.state.status !== "ready")
        throw new Error("Actual shared-deadline jobs must complete");
      expect(second.state.result.data).toEqual(first.state.result.data);
      expect(second.state.result.rootDeltas).toEqual(
        first.state.result.rootDeltas,
      );
      const terminal = first.state;
      expect(first.advance(7, expired)).toBe(terminal);
    } finally {
      f.close();
    }
  });

  it("rejects malformed consumed-work snapshots without executing accessors or advancing the real core", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      const valid = { operations: 4, activeMs: 1.25, maximumSliceMs: 0.75 };
      let getterCalls = 0;
      const accessor = { ...valid };
      Object.defineProperty(accessor, "activeMs", {
        enumerable: true,
        get() {
          getterCalls++;
          return 0;
        },
      });
      const hidden = { ...valid };
      Object.defineProperty(hidden, "operations", {
        value: 4,
        enumerable: false,
      });
      const invalid: unknown[] = [
        null,
        false,
        0,
        "work",
        [],
        new Date(),
        {},
        { operations: 0, activeMs: 0 },
        { ...valid, extra: 0 },
        { ...valid, [Symbol("extra")]: 0 },
        Object.create(valid),
        accessor,
        hidden,
        { ...valid, operations: -1 },
        { ...valid, operations: 0.5 },
        { ...valid, operations: Number.MAX_SAFE_INTEGER + 1 },
        {
          ...valid,
          operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations + 1,
        },
        { ...valid, operations: "4" },
        { ...valid, activeMs: -1 },
        { ...valid, activeMs: "1" },
        {
          ...valid,
          activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs + 0.01,
        },
        { ...valid, maximumSliceMs: -1 },
        { ...valid, maximumSliceMs: 1.5 },
        ...[NaN, Infinity, -Infinity].flatMap((value) =>
          ["operations", "activeMs", "maximumSliceMs"].map((key) => ({
            ...valid,
            [key]: value,
          })),
        ),
      ];
      expect(() => validateGrassGroundingConsumedWork(undefined)).toThrow(
        "Invalid grass grounding consumed work",
      );
      for (const value of invalid) {
        const steps = groundGrassBladeSteps(f.request(surface));
        expect(() => validateGrassGroundingConsumedWork(value)).toThrow(
          "Invalid grass grounding consumed work",
        );
        expect(
          () =>
            new GrassGroundingContinuation(
              steps,
              () => true,
              value as GrassGroundingConsumedWork,
            ),
        ).toThrow("Invalid grass grounding consumed work");
        expect(steps.next()).toEqual({ done: false, value: "request_bounds" });
        steps.return(undefined as never);
      }
      expect(getterCalls).toBe(0);
      for (const source of [valid, Object.assign(Object.create(null), valid)]) {
        const captured = validateGrassGroundingConsumedWork(source);
        expect(captured).toEqual(valid);
        expect(captured).not.toBe(source);
        expect(Object.isFrozen(captured)).toBe(true);
      }
    } finally {
      f.close();
    }
  });

  it("rejects cumulative counters at either exact cap before advancing the core and preserves terminal budget reasons", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      for (const [consumed, reason] of [
        [
          {
            operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
            activeMs: 0,
            maximumSliceMs: 0,
          },
          "operations",
        ],
        [
          {
            operations: 9,
            activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
            maximumSliceMs: 2,
          },
          "active_cpu",
        ],
        [
          {
            operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
            activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
            maximumSliceMs: 2,
          },
          "operations",
        ],
      ] as const) {
        const steps = groundGrassBladeSteps(f.request(surface));
        const job = new GrassGroundingContinuation(steps, () => true, consumed);
        expect(job.state.status).toBe("running");
        expect(job.operations).toBe(consumed.operations);
        expect(job.activeMs).toBe(consumed.activeMs);
        expect(job.maximumSliceMs).toBe(consumed.maximumSliceMs);
        expect(job.advance(1)).toEqual({ status: "failed_budget", reason });
        expect(job.operations).toBe(consumed.operations);
        expect(job.lastSliceOperations).toBe(0);
        expect(job.lastPhase).toBeNull();
        expect(steps.next().done).toBe(true);
        const terminal = job.state;
        const failure = captureGrassGroundingFailure(job);
        expect(failure?.reason).toBe(reason);
        expect(failure?.activeMs).toBeGreaterThanOrEqual(consumed.activeMs);
        expect(failure?.maximumSliceMs).toBeGreaterThanOrEqual(
          consumed.maximumSliceMs,
        );
        expect(job.advance()).toBe(terminal);
        expect(job.cancel()).toBe(terminal);
        expect(captureGrassGroundingFailure(job)).toEqual(failure);
      }
    } finally {
      f.close();
    }
  });

  it("charges real post-handoff core resumptions against the remaining operation allowance", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      const consumed = {
        operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations - 1,
        activeMs: 2.5,
        maximumSliceMs: 0.5,
      };
      const job = new GrassGroundingContinuation(
        groundGrassBladeSteps(f.request(surface)),
        () => true,
        consumed,
      );
      expect(job.advance(1).status).toBe("running");
      expect(job.operations).toBe(
        GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
      );
      expect(job.lastPhase).toBe("request_bounds");
      expect(job.lastSliceOperations).toBe(1);
      expect(job.advance(1)).toEqual({
        status: "failed_budget",
        reason: "operations",
      });
      expect(job.lastSliceOperations).toBe(0);
      expect(job.lastPhase).toBe("request_bounds");
      expect(job.activeMs).toBeGreaterThanOrEqual(consumed.activeMs);
    } finally {
      f.close();
    }
  });

  it("charges actual resumed work against consumed active time without resetting the hard cap", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      const request = f.request(surface);
      function* resumedCore(): Generator<
        string,
        GrassBladeGroundingResult,
        void
      > {
        // Controlled real-clock workload around the actual core, solely to
        // cross the budget boundary deterministically; not a performance test.
        const until = performance.now() + 2;
        while (performance.now() < until) {
          /* No clock replacement. */
        }
        return yield* groundGrassBladeSteps(request);
      }
      const consumed = {
        operations: 17,
        activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs - 0.5,
        maximumSliceMs: 0.5,
      };
      const job = new GrassGroundingContinuation(
        resumedCore(),
        () => true,
        consumed,
      );
      expect(job.advance(1)).toEqual({
        status: "failed_budget",
        reason: "active_cpu",
      });
      expect(job.operations).toBe(consumed.operations + 1);
      expect(job.lastSliceOperations).toBe(1);
      expect(job.lastPhase).toBe("request_bounds");
      expect(job.activeMs).toBeGreaterThanOrEqual(
        GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
      );
      expect(job.maximumSliceMs).toBe(
        Math.max(consumed.maximumSliceMs, job.lastSliceMs),
      );
      const terminal = job.state;
      expect(job.advance()).toBe(terminal);
      expect(job.cancel()).toBe(terminal);
    } finally {
      f.close();
    }
  });

  it.each(["ready", "waiting_support"] as const)(
    "reports cumulative counters and elapsed receipt after real %s completion",
    (status) => {
      const f = analyticOwner();
      try {
        const surface = f.makeSurface();
        const request =
          status === "ready"
            ? f.request(surface)
            : f.request(surface, f.dataAt(surface, [[49.8, 0]]));
        const expected = groundGrassBlades(request);
        const consumed = {
          operations: 27,
          activeMs: 10.25,
          maximumSliceMs: 3.5,
        };
        const job = new GrassGroundingContinuation(
          groundGrassBladeSteps(request),
          () => true,
          consumed,
        );
        let operations = consumed.operations,
          activeMs = consumed.activeMs,
          maximumSliceMs = consumed.maximumSliceMs;
        // The caller's wire object cannot later rewrite the admitted counters.
        consumed.operations = 0;
        consumed.activeMs = 0;
        consumed.maximumSliceMs = 0;
        while (job.state.status === "running") {
          job.advance(17);
          operations += job.lastSliceOperations;
          activeMs += job.lastSliceMs;
          maximumSliceMs = Math.max(maximumSliceMs, job.lastSliceMs);
        }
        expect(job.state.status).toBe(status);
        if (
          job.state.status !== "ready" &&
          job.state.status !== "waiting_support"
        )
          throw new Error("Expected actual core completion");
        expect(job.operations).toBe(operations);
        expect(job.activeMs).toBe(activeMs);
        expect(job.maximumSliceMs).toBe(maximumSliceMs);
        expect(job.state.result.receipt.elapsedMs).toBe(activeMs);
        const { elapsedMs: _expectedElapsed, ...expectedReceipt } =
          expected.receipt;
        const { elapsedMs: _elapsed, ...receipt } = job.state.result.receipt;
        expect({ ...job.state.result, receipt }).toEqual({
          ...expected,
          receipt: expectedReceipt,
        });
        const terminal = job.state;
        expect(job.advance()).toBe(terminal);
        expect(job.operations).toBe(operations);
        expect(job.activeMs).toBe(activeMs);
      } finally {
        f.close();
      }
    },
  );

  it("preserves consumed work through explicit cancellation and real owner invalidation", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        geometry = f.geometries[0];
      const consumed = { operations: 19, activeMs: 4.5, maximumSliceMs: 1.5 };
      const cancelled = new GrassGroundingContinuation(
        groundGrassBladeSteps(f.request(surface)),
        () => true,
        consumed,
      );
      expect(cancelled.cancel()).toEqual({
        status: "cancelled",
        reason: "caller",
      });
      expect(cancelled.operations).toBe(consumed.operations);
      expect(cancelled.activeMs).toBe(consumed.activeMs);
      expect(cancelled.maximumSliceMs).toBe(consumed.maximumSliceMs);
      expect(cancelled.lastPhase).toBeNull();
      expect(cancelled.advance()).toBe(cancelled.state);
      const invalidated = new GrassGroundingContinuation(
        groundGrassBladeSteps(f.request(surface)),
        () => surface.matchesGeometry(geometry),
        consumed,
      );
      geometry.setAttribute(
        "position",
        geometry.getAttribute("position").clone(),
      );
      expect(invalidated.advance()).toEqual({
        status: "cancelled",
        reason: "invalidated",
      });
      expect(invalidated.operations).toBe(consumed.operations);
      expect(invalidated.lastSliceOperations).toBe(0);
      expect(invalidated.lastPhase).toBeNull();
      expect(invalidated.activeMs).toBeGreaterThanOrEqual(consumed.activeMs);
      expect(invalidated.maximumSliceMs).toBeGreaterThanOrEqual(
        consumed.maximumSliceMs,
      );
    } finally {
      f.close();
    }
  });

  it("retains real grounding-work and input failures after seeded cumulative work", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      for (const reason of ["grounding_work", "input"] as const) {
        const request = f.request(surface);
        if (reason === "grounding_work") request.workBudget = 1;
        else request.data.offsets[0] = NaN;
        const consumed = { operations: 31, activeMs: 5.5, maximumSliceMs: 1.5 };
        const job = new GrassGroundingContinuation(
          groundGrassBladeSteps(request),
          () => true,
          consumed,
        );
        while (job.state.status === "running") job.advance();
        const state = job.state;
        expect(captureGrassGroundingFailure(job)?.reason).toBe(reason);
        expect(job.operations).toBeGreaterThan(consumed.operations);
        expect(job.activeMs).toBeGreaterThanOrEqual(consumed.activeMs);
        expect(job.maximumSliceMs).toBeGreaterThanOrEqual(
          consumed.maximumSliceMs,
        );
        expect(job.advance()).toBe(state);
        expect(job.cancel()).toBe(state);
      }
    } finally {
      f.close();
    }
  });

  it("retains cancellation and malformed-input ownership checks with a shared deadline", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        geometry = f.geometries[0];
      const request = f.request(surface);
      const job = new GrassBladeGroundingJob(request, () =>
        surface.matchesGeometry(geometry),
      );
      geometry.setAttribute(
        "position",
        geometry.getAttribute("position").clone(),
      );
      expect(job.advance(7, performance.now())).toEqual({
        status: "cancelled",
        reason: "invalidated",
      });
      expect(job.operations).toBe(0);
      const fresh = f.makeSurface(2);
      const malformed = f.request(fresh);
      malformed.data.offsets[0] = NaN;
      const invalid = new GrassBladeGroundingJob(malformed, () => true);
      while (invalid.state.status === "running")
        invalid.advance(
          7,
          performance.now() + GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs,
        );
      expect(invalid.state.status).toBe("failed_input");
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

  it("captures bounded immutable failure context from actual jobs without advancing them", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface();
      for (const failure of [
        "grounding_work",
        "input",
        "active_cpu",
      ] as const) {
        const request = f.request(surface);
        if (failure === "grounding_work") request.workBudget = 1;
        if (failure === "input") request.data.offsets[0] = NaN;
        const job = new GrassBladeGroundingJob(request, () => true);
        expect(captureGrassGroundingFailure(job)).toBeNull();
        if (failure === "active_cpu") {
          // Exercise the real continuation's cap branch deterministically;
          // this seeded counter is not a CPU timing measurement.
          expect(job.advance(1).status).toBe("running");
          job.activeMs = GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs;
        }
        while (job.state.status === "running") job.advance(7);
        const state = job.state;
        const snapshot = captureGrassGroundingFailure(job)!;
        expect(snapshot).toEqual({
          status: failure === "input" ? "failed_input" : "failed_budget",
          reason: failure,
          activeMs: job.activeMs,
          operations: job.operations,
          lastSliceOperations: job.lastSliceOperations,
          lastSliceMs: job.lastSliceMs,
          maximumSliceMs: job.maximumSliceMs,
          lastPhase: job.lastPhase,
          activeLimitMs: 250,
          targetSliceMs: 2,
        });
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(
          Object.values(snapshot).every(
            (v) => v === null || typeof v !== "object",
          ),
        ).toBe(true);
        expect(job.state).toBe(state);
        expect(job.advance()).toBe(state);
        expect(captureGrassGroundingFailure(job)).toEqual(snapshot);
        const recordedMs = snapshot.activeMs;
        job.activeMs += 1;
        expect(snapshot.activeMs).toBe(recordedMs);
      }
      const ready = new GrassBladeGroundingJob(f.request(surface), () => true);
      while (ready.state.status === "running") ready.advance();
      expect(ready.state.status).toBe("ready");
      expect(captureGrassGroundingFailure(ready)).toBeNull();
      const cancelled = new GrassBladeGroundingJob(
        f.request(surface),
        () => true,
      );
      cancelled.cancel();
      expect(captureGrassGroundingFailure(cancelled)).toBeNull();
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

  it.each([
    ["ordinary", 1],
    ["fine", 0],
    ["fine", 1],
    ["isolated-fine-near4", 0],
  ] as const)(
    "keeps %s LOD%s grass-only pad sweeps inclusive while releasing the unchanged grading shoulder",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
      try {
        const surface = f.makeSurface();
        const request = {
          ...f.request(surface, f.dataAt(surface, [[0, 0, 0.71]]), lod),
          wind: { x: 0.4, z: 0.165 },
        };
        const before = structuredClone(request.data);
        const baseline = groundGrassBlades(request);
        if (baseline.status !== "ready" || !baseline.sweptBounds)
          throw Error("Expected admitted unexcluded clump");
        const box = baseline.sweptBounds;
        const grade = {
          id: "unchanged-grade",
          centerX: 0,
          centerZ: 0,
          width: 30,
          depth: 30,
          height: 20,
          blendRadius: 2,
        };
        const resultFor = (grassExclusionBounds?: {
          minX: number;
          maxX: number;
          minZ: number;
          maxZ: number;
        }) =>
          groundGrassBlades({
            ...request,
            terrainSurface: {
              ...emptySnapshot(),
              zones: [
                {
                  ...grade,
                  ...(grassExclusionBounds ? { grassExclusionBounds } : {}),
                },
              ],
            },
          });
        const old = resultFor();
        expect(old).toMatchObject({
          status: "ready",
          data: { count: 0 },
          receipt: { rejected: { pad: 1 } },
        });
        const full = resultFor({ minX: -17, maxX: 17, minZ: -17, maxZ: 17 });
        if (old.status !== "ready" || full.status !== "ready")
          throw Error("Legacy and explicit full exclusion must complete");
        const { elapsedMs: _oldTime, ...oldReceipt } = old.receipt;
        const { elapsedMs: _fullTime, ...fullReceipt } = full.receipt;
        expect(fullReceipt).toEqual(oldReceipt);
        expect(full.data).toEqual(old.data);
        expect(full.rootDeltas).toEqual(old.rootDeltas);
        const touchingBounds = {
          minX: box.maxX,
          maxX: box.maxX + 1,
          minZ: box.minZ,
          maxZ: box.maxZ,
        };
        expect(touchingBounds.minX).toBeGreaterThan(0);
        let stillMaxX = -Infinity;
        for (
          let v = 0;
          v < request.geometry.getAttribute("position").count;
          v++
        )
          stillMaxX = Math.max(
            stillMaxX,
            transformedVertex(request.data, surface, request.geometry, 0, v).x,
          );
        expect(touchingBounds.minX).toBeGreaterThan(stillMaxX);
        expect(resultFor(touchingBounds)).toMatchObject({
          status: "ready",
          data: { count: 0 },
          sweptBounds: null,
          receipt: { rejected: { pad: 1 } },
        });
        const outside = resultFor({
          ...touchingBounds,
          minX: box.maxX + 1e-10,
        });
        if (outside.status !== "ready")
          throw Error("Released grading shoulder deferred");
        expect(outside.data).toEqual(baseline.data);
        expect(outside.rootDeltas).toEqual(baseline.rootDeltas);
        expect(outside.sourceIndices).toEqual(baseline.sourceIndices);
        expect(outside.sweptBounds).toEqual(baseline.sweptBounds);
        expect(outside.receipt.rejected).toEqual(baseline.receipt.rejected);
        // One existing per-zone pad charge: optional bounds add no operation or
        // continuation and do not change the root-query or output algorithms.
        expect(outside.receipt.workUnits).toBe(baseline.receipt.workUnits + 1);
        expect(outside.receipt.workBudget).toBe(baseline.receipt.workBudget);
        expect(outside.receipt.workUnits).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_LIMITS.maximumWorkBudget,
        );
        expect(request.data).toEqual(before);
        for (const grassExclusionBounds of [
          undefined,
          { ...touchingBounds, minX: NaN },
          { ...touchingBounds, maxX: 18 },
        ]) {
          const malformed = { ...grade, grassExclusionBounds };
          expect(() =>
            groundGrassBlades({
              ...request,
              terrainSurface: { ...emptySnapshot(), zones: [malformed] },
            }),
          ).toThrow(/grassExclusionBounds/);
        }
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ["ordinary", 1],
    ["fine", 0],
    ["fine", 1],
    ["isolated-fine-near4", 0],
  ] as const)(
    "checks %s LOD%s swept pads, road capsules and elevated-water circles outside the anchor",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
      try {
        const surface = f.makeSurface(),
          request = f.request(surface, undefined, lod),
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
        const polygon: GrassTerrainExclusionPolygon = {
          id: "swept-rock",
          minX: x - 0.05,
          maxX: x + 0.05,
          minZ: -5,
          maxZ: 5,
          vertices: [
            { x: x - 0.05, z: -5 },
            { x: x + 0.05, z: -5 },
            { x: x + 0.05, z: 5 },
            { x: x - 0.05, z: 5 },
          ],
        };
        const cases: {
          input: GrassBladeGroundingRequest;
          reason: keyof GrassBladeGroundingResult["receipt"]["rejected"];
        }[] = [
          {
            input: {
              ...base,
              terrainSurface: {
                ...emptySnapshot(),
                exclusionPolygons: [polygon],
              },
            },
            reason: "pad",
          },
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
        ];
        for (const { input, reason } of cases) {
          const before = structuredClone(input.data);
          const result = groundGrassBlades(input);
          expect(result.status).toBe("ready");
          if (result.status !== "ready") throw Error(result.reason);
          expect(result.data.count).toBe(0);
          expect(result.receipt.rejected[reason]).toBe(1);
          expect(result.receipt.workUnits).toBeLessThanOrEqual(
            GRASS_BLADE_GROUNDING_LIMITS.maximumWorkBudget,
          );
          expect(input.data).toEqual(before);
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
        if (belowOcean.status === "ready")
          expect(belowOcean.data.count).toBe(1);
      } finally {
        f.close();
      }
    },
  );

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

/** Independent Three transforms bound each actual generated blade. The CPU
 * correction is world-Y only, so it cannot change these road-clearance bounds. */
function independentBladeBoxes(
  request: GrassBladeGroundingRequest,
  instance = 0,
  heightScale = 1,
) {
  const layout = getGrassBladeLayout(request.lod, request.geometryLayout);
  const uv = request.geometry.getAttribute("uv");
  return Array.from({ length: layout.bladesPerClump }, (_, blade) => {
    const box = new THREE.Box3();
    for (let local = 0; local < layout.verticesPerBlade; local++) {
      const vertex = blade * layout.verticesPerBlade + local;
      for (const fade of [0, 0.5, 1])
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) {
            const point = transformedVertex(
              request.data,
              request.ownSurface,
              request.geometry,
              instance,
              vertex,
              fade * heightScale,
            );
            point.x +=
              sx * request.wind.x * heightScale * uv.getY(vertex) ** 1.8;
            point.z +=
              sz * request.wind.z * heightScale * uv.getY(vertex) ** 1.8;
            box.expandByPoint(point);
          }
    }
    return box.expandByScalar(1e-5);
  });
}

/** Deliberately bounded test oracle: exact vertical capsules and zero-length
 * capsules, independent of the production segment/box clipping implementation. */
function independentRoadMask(
  boxes: THREE.Box3[],
  roads: readonly GrassGroundingRoadSegment[],
) {
  let mask = 0;
  boxes.forEach((box, blade) => {
    const clear = roads.every((road) => {
      if ((road.maxInfluence ?? 1) <= 0.8) return true;
      if (road.blendWidth !== 0 || road.startX !== road.endX)
        throw Error(
          "This test oracle only admits explicit zero-blend vertical capsules",
        );
      const dx = Math.max(box.min.x - road.startX, 0, road.startX - box.max.x);
      const dz = Math.max(
        box.min.z - Math.max(road.startZ, road.endZ),
        0,
        Math.min(road.startZ, road.endZ) - box.max.z,
      );
      return Math.hypot(dx, dz) > road.width / 2;
    });
    if (clear) mask |= 1 << blade;
  });
  return mask;
}

const maskPopulation = (mask: number) =>
  mask.toString(2).replaceAll("0", "").length;
const withoutGroundingElapsed = (result: GrassBladeGroundingResult) => ({
  ...result,
  receipt: { ...result.receipt, elapsedMs: 0 },
});

const BANK_VERGE_HEIGHT_TRIAL = Object.freeze({
  minX: 340,
  maxX: 357,
  minZ: 310,
  maxZ: 324,
  feather: 2,
  wearStart: 0.1,
  wearEnd: 0.8,
  minimumScale: 0.55,
  heightScale: 0.65,
  // Keep the independently historical native39-height recipe neutral to wear.
  wear: Object.freeze([]),
  wornHeightScale: 0.65,
  grassTint: Object.freeze([0.96, 0.88, 1] as const),
  tipBrightness: 1.08,
});

function currentBankVergeWear() {
  return createCompactTerrainColorOperations().macroField(
    validateWorldTerrainProfile({
      ...SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
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
    }),
  )!.bankVerge!;
}

describe("opt-in bank-verge grounding deformation (actual generated blades)", () => {
  it("rejects malformed, inherited, accessor and non-fine descriptors without invoking getters", () => {
    let reads = 0;
    const valid = {
      geometryLayout: "fine-linear-sweep-3seg-v1" as const,
      bankVerge: BANK_VERGE_HEIGHT_TRIAL,
    };
    const scalarGetter = Object.defineProperty(
      { ...BANK_VERGE_HEIGHT_TRIAL },
      "heightScale",
      {
        get() {
          reads++;
          return 0.65;
        },
      },
    );
    const tintGetter = [0.96, 0.88, 1];
    Object.defineProperty(tintGetter, "0", {
      get() {
        reads++;
        return 0.96;
      },
    });
    for (const bad of [
      null,
      {},
      Object.create(BANK_VERGE_HEIGHT_TRIAL),
      scalarGetter,
      { ...BANK_VERGE_HEIGHT_TRIAL, heightScale: 0 },
      { ...BANK_VERGE_HEIGHT_TRIAL, heightScale: 1.01 },
      { ...BANK_VERGE_HEIGHT_TRIAL, heightScale: NaN },
      { ...BANK_VERGE_HEIGHT_TRIAL, feather: 8 },
      { ...BANK_VERGE_HEIGHT_TRIAL, minX: 357 },
      { ...BANK_VERGE_HEIGHT_TRIAL, grassTint: tintGetter },
      { ...BANK_VERGE_HEIGHT_TRIAL, grassTint: [0.96, Infinity, 1] },
      { ...BANK_VERGE_HEIGHT_TRIAL, extra: true },
    ])
      expect(() =>
        captureGrassBankVerge({ ...valid, bankVerge: bad } as never),
      ).toThrow("Invalid grass bank-verge descriptor");
    expect(() =>
      captureGrassBankVerge(
        Object.assign(Object.create({ bankVerge: BANK_VERGE_HEIGHT_TRIAL }), {
          geometryLayout: valid.geometryLayout,
        }),
      ),
    ).toThrow();
    expect(() =>
      captureGrassBankVerge(
        Object.defineProperty(
          { geometryLayout: valid.geometryLayout },
          "bankVerge",
          {
            get() {
              reads++;
              return BANK_VERGE_HEIGHT_TRIAL;
            },
          },
        ),
      ),
    ).toThrow();
    expect(() =>
      captureGrassBankVerge({ bankVerge: BANK_VERGE_HEIGHT_TRIAL }),
    ).toThrow();
    expect(reads).toBe(0);
    const snapshot = captureGrassBankVerge(valid)!;
    expect(snapshot).toEqual(BANK_VERGE_HEIGHT_TRIAL);
    expect(snapshot).not.toBe(BANK_VERGE_HEIGHT_TRIAL);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.grassTint)).toBe(true);
  });

  it("deep-captures at most three actual wear ribbons and rejects malformed nested descriptors without getters", () => {
    const descriptor = currentBankVergeWear();
    const valid = {
      geometryLayout: "fine-linear-sweep-3seg-v1" as const,
      bankVerge: descriptor,
    };
    expect(descriptor.wear).toHaveLength(3);
    expect(descriptor.wornHeightScale).toBe(0.35);
    let reads = 0;
    const itemGetter = [descriptor.wear[0]];
    Object.defineProperty(itemGetter, "0", {
      get() {
        reads++;
        return descriptor.wear[0];
      },
    });
    const fieldGetter = Object.defineProperty(
      { ...descriptor.wear[0] },
      "strength",
      {
        get() {
          reads++;
          return 0.8;
        },
      },
    );
    const arrayGetter = Object.defineProperty({ ...descriptor }, "wear", {
      get() {
        reads++;
        return descriptor.wear;
      },
    });
    const row = descriptor.wear[0];
    for (const bad of [
      { ...descriptor, wornHeightScale: 0 },
      { ...descriptor, wornHeightScale: descriptor.heightScale + 0.01 },
      { ...descriptor, wornHeightScale: NaN },
      { ...descriptor, wear: null },
      { ...descriptor, wear: [...descriptor.wear, row] },
      { ...descriptor, wear: new Array(1) },
      { ...descriptor, wear: Object.assign([row], { extra: true }) },
      { ...descriptor, wear: itemGetter },
      { ...descriptor, wear: [fieldGetter] },
      { ...descriptor, wear: [Object.create(row)] },
      { ...descriptor, wear: [{ ...row, extra: 1 }] },
      { ...descriptor, wear: [{ ...row, startX: Infinity }] },
      { ...descriptor, wear: [{ ...row, endX: 1e6 + 1 }] },
      { ...descriptor, wear: [{ ...row, endX: row.startX, endZ: row.startZ }] },
      { ...descriptor, wear: [{ ...row, coreRadius: -1 }] },
      { ...descriptor, wear: [{ ...row, coreRadius: 0, outerRadius: 1e-200 }] },
      { ...descriptor, wear: [{ ...row, outerRadius: row.coreRadius }] },
      { ...descriptor, wear: [{ ...row, outerRadius: 1e6 + 1 }] },
      { ...descriptor, wear: [{ ...row, strength: -0.01 }] },
      { ...descriptor, wear: [{ ...row, strength: 1.01 }] },
      arrayGetter,
    ])
      expect(() =>
        captureGrassBankVerge({ ...valid, bankVerge: bad } as never),
      ).toThrow("Invalid grass bank-verge descriptor");
    expect(reads).toBe(0);
    const snapshot = captureGrassBankVerge(valid)!;
    expect(snapshot).toEqual(descriptor);
    expect(snapshot.wear).not.toBe(descriptor.wear);
    expect(Object.isFrozen(snapshot.wear)).toBe(true);
    snapshot.wear.forEach((item, i) => {
      expect(item).not.toBe(descriptor.wear[i]);
      expect(Object.isFrozen(item)).toBe(true);
    });
  });

  it("keeps absent, undefined and outside-bank outputs and work exactly unchanged", () => {
    const f = analyticOwner("fine");
    try {
      const surface = f.makeSurface();
      const request = {
        ...f.request(surface, undefined, 0),
        wind: { x: 0.3, z: 0.165 },
      };
      const original = drainPipeline(groundGrassBladeSteps(request));
      for (const bankVerge of [undefined, BANK_VERGE_HEIGHT_TRIAL]) {
        const actual = drainPipeline(
          groundGrassBladeSteps({ ...request, bankVerge }),
        );
        expect(actual.trace).toEqual(original.trace);
        expect(withoutGroundingElapsed(actual.result)).toEqual(
          withoutGroundingElapsed(original.result),
        );
      }
    } finally {
      f.close();
    }
  });

  it.each([0, 1, 2] as const)(
    "bounds every LOD%s vertex with unchanged roots, independent slope/fade/wind transforms and actual bank locality",
    (lod) => {
      const f = analyticOwner("fine");
      try {
        const surface = f.makeSurface(
          1,
          350,
          318,
          64,
          (x, z) => 20 + 0.2 * (x - 350) - 0.13 * (z - 318),
        );
        // Interior, half-feather and outside: factors independently known.
        const data = f.dataAt(surface, [
          [0, 0, 0.8],
          [-9, 0, 2.4],
          [-11, 0, 5.1],
        ]);
        data.rotScaleHash[1] = 0.2;
        data.rotScaleHash[4] = 4;
        const request = {
          ...f.request(surface, data, lod),
          wind: { x: 0.3, z: 0.165 },
        };
        const original = groundGrassBlades(request);
        const actual = groundGrassBlades({
          ...request,
          bankVerge: BANK_VERGE_HEIGHT_TRIAL,
        });
        if (
          original.status !== "ready" ||
          actual.status !== "ready" ||
          !actual.sweptBounds
        )
          throw Error("Expected complete verge geometry bounds");
        expect(actual.data).toEqual(original.data);
        expect(actual.sourceIndices).toEqual(original.sourceIndices);
        expect(actual.rootDeltas).toEqual(original.rootDeltas);
        expect(actual.receipt.endpointQueries).toBe(
          original.receipt.endpointQueries,
        );
        const tier = getGrassBladeLayout(lod, request.geometryLayout),
          uv = request.geometry.getAttribute("uv"),
          box = new THREE.Box3();
        for (let i = 0; i < data.count; i++) {
          const h = [0.65, 0.825, 1][i];
          for (let v = 0; v < uv.count; v++) {
            const d =
              (i * tier.bladesPerClump +
                Math.floor(v / tier.verticesPerBlade)) *
              2;
            for (const fade of [0, 0.5, 1])
              for (const sx of [-1, 1])
                for (const sz of [-1, 1]) {
                  const p = transformedVertex(
                    actual.data,
                    surface,
                    request.geometry,
                    i,
                    v,
                    fade * h,
                  );
                  p.y +=
                    actual.rootDeltas[d] * (1 - uv.getX(v)) +
                    actual.rootDeltas[d + 1] * uv.getX(v);
                  p.x += sx * request.wind.x * h * uv.getY(v) ** 1.8;
                  p.z += sz * request.wind.z * h * uv.getY(v) ** 1.8;
                  box.expandByPoint(p);
                  if (uv.getY(v) === 0)
                    expect(p).toEqual(
                      transformedVertex(
                        original.data,
                        surface,
                        request.geometry,
                        i,
                        v,
                        fade,
                      ).add(
                        new THREE.Vector3(
                          0,
                          actual.rootDeltas[d] * (1 - uv.getX(v)) +
                            actual.rootDeltas[d + 1] * uv.getX(v),
                          0,
                        ),
                      ),
                    );
                }
          }
        }
        box.expandByScalar(1e-5);
        for (const [value, expected] of [
          [actual.sweptBounds.minX, box.min.x],
          [actual.sweptBounds.maxX, box.max.x],
          [actual.sweptBounds.minY, box.min.y],
          [actual.sweptBounds.maxY, box.max.y],
          [actual.sweptBounds.minZ, box.min.z],
          [actual.sweptBounds.maxZ, box.max.z],
        ])
          expect(Math.abs(value - expected)).toBeLessThan(1e-6);
        expect(actual.receipt.workUnits).toBeLessThanOrEqual(
          actual.receipt.workBudget,
        );
      } finally {
        f.close();
      }
    },
  );

  it("matches independent deformed per-blade road masks while retaining hard pad rejection", () => {
    const f = analyticOwner("fine");
    try {
      const surface = f.makeSurface(
        1,
        350,
        318,
        64,
        (x, z) => 20 + 0.15 * (x - 350) + 0.05 * (z - 318),
      );
      const request: GrassBladeGroundingRequest = {
        ...f.request(surface, undefined, 0),
        bankVerge: BANK_VERGE_HEIGHT_TRIAL,
        roadClearance: "per-blade-v1",
        wind: { x: 0.3, z: 0.165 },
      };
      const boxes = independentBladeBoxes(request, 0, 0.65);
      const maxima = boxes.map((box) => box.max.x);
      const x = (Math.min(...maxima) + Math.max(...maxima)) / 2 + 0.125;
      request.roadSegments = [
        {
          startX: x,
          endX: x,
          startZ: 308,
          endZ: 328,
          width: 0.25,
          blendWidth: 0,
        },
      ];
      const expectedMask = independentRoadMask(boxes, request.roadSegments);
      expect(expectedMask).toBeGreaterThan(0);
      expect(expectedMask).toBeLessThan((1 << 24) - 1);
      const actual = groundGrassBlades(request);
      if (actual.status !== "ready")
        throw Error("Expected deformed road result");
      expect(Array.from(actual.bladeVisibility!)).toEqual([expectedMask]);
      request.terrainSurface.zones.push({
        id: "required-bank-clearance",
        centerX: 350,
        centerZ: 318,
        width: 2,
        depth: 2,
        height: 20,
        blendRadius: 0,
      });
      const blocked = groundGrassBlades(request);
      expect(blocked.receipt.rejected.pad).toBe(1);
      expect(blocked.receipt.retainedClumps).toBe(0);
    } finally {
      f.close();
    }
  });

  it.each([0, 1, 2] as const)(
    "matches current authored short/long LOD%s bounds, roots and wind with independent transforms",
    (lod) => {
      const f = analyticOwner("fine");
      try {
        const surface = f.makeSurface(
          1,
          350,
          318,
          64,
          (x, z) => 20 + 0.15 * (x - 350) - 0.09 * (z - 318),
        );
        const descriptor = currentBankVergeWear();
        // Actual connected apron/clerk/shopkeeper cores, unaffected long grass,
        // the existing half-locality feather, and outside: independent factors.
        for (const [x, z, h] of [
          [348, 319.25, 0.41],
          [354, 321, 0.464],
          [342.5, 322, 0.485],
          [350, 313, 0.65],
          [341, 318, 0.825],
          [338, 318, 1],
        ]) {
          const request = {
            ...f.request(
              surface,
              f.dataAt(surface, [[x - 350, z - 318, 0.83]]),
              lod,
            ),
            wind: { x: 0.3, z: 0.165 },
          };
          const original = groundGrassBlades(request);
          const actual = groundGrassBlades({
            ...request,
            bankVerge: descriptor,
          });
          if (
            original.status !== "ready" ||
            actual.status !== "ready" ||
            !actual.sweptBounds
          )
            throw Error("Expected current authored wear bounds");
          expect(actual.data).toEqual(original.data);
          expect(actual.rootDeltas).toEqual(original.rootDeltas);
          expect(actual.sourceIndices).toEqual(original.sourceIndices);
          const tier = getGrassBladeLayout(lod, request.geometryLayout);
          const uv = request.geometry.getAttribute("uv"),
            box = new THREE.Box3();
          for (let v = 0; v < uv.count; v++) {
            const d = Math.floor(v / tier.verticesPerBlade) * 2;
            for (const fade of [0, 0.5, 1])
              for (const sx of [-1, 1])
                for (const sz of [-1, 1]) {
                  const p = transformedVertex(
                    actual.data,
                    surface,
                    request.geometry,
                    0,
                    v,
                    fade * h,
                  );
                  p.y +=
                    actual.rootDeltas[d] * (1 - uv.getX(v)) +
                    actual.rootDeltas[d + 1] * uv.getX(v);
                  p.x += sx * request.wind.x * h * uv.getY(v) ** 1.8;
                  p.z += sz * request.wind.z * h * uv.getY(v) ** 1.8;
                  box.expandByPoint(p);
                  if (uv.getY(v) === 0)
                    expect(
                      transformedVertex(
                        actual.data,
                        surface,
                        request.geometry,
                        0,
                        v,
                        fade * h,
                      ),
                    ).toEqual(
                      transformedVertex(
                        original.data,
                        surface,
                        request.geometry,
                        0,
                        v,
                        fade,
                      ),
                    );
                }
          }
          box.expandByScalar(1e-5);
          for (const [value, expected] of [
            [actual.sweptBounds.minX, box.min.x],
            [actual.sweptBounds.maxX, box.max.x],
            [actual.sweptBounds.minY, box.min.y],
            [actual.sweptBounds.maxY, box.max.y],
            [actual.sweptBounds.minZ, box.min.z],
            [actual.sweptBounds.maxZ, box.max.z],
          ])
            expect(Math.abs(value - expected)).toBeLessThan(1e-6);
          if (h === 1)
            expect(withoutGroundingElapsed(actual)).toEqual(
              withoutGroundingElapsed(original),
            );
        }
      } finally {
        f.close();
      }
    },
  );

  it("snapshots the optional descriptor before pipeline yields without changing its root inputs", () => {
    const f = analyticOwner("fine");
    try {
      const surface = f.makeSurface(1, 350, 318);
      const current = currentBankVergeWear();
      const bankVerge = {
        ...current,
        heightScale: Number(current.heightScale),
        wornHeightScale: Number(current.wornHeightScale),
        wear: current.wear.map((row) => ({ ...row })),
        grassTint: [...current.grassTint] as [number, number, number],
      };
      const request = {
        ...f.request(surface, undefined, 0),
        bankVerge,
        wind: { x: 0.3, z: 0.165 },
      };
      const expected = drainPipeline(
        prepareGroundedGrassSteps(
          request,
          pipelineInputs(request),
          () => -1000,
          () => false,
        ),
      );
      const steps = prepareGroundedGrassSteps(
        request,
        pipelineInputs(request),
        () => -1000,
        () => false,
      );
      expect(steps.next().value).toBe("pipeline_admission");
      bankVerge.heightScale = 1;
      bankVerge.wornHeightScale = 1;
      bankVerge.grassTint[0] = 1;
      bankVerge.wear[0].startX = 0;
      bankVerge.wear[0].strength = 0;
      bankVerge.wear.splice(1);
      const actual = drainPipeline(steps);
      expect(withoutGroundingElapsed(actual.result)).toEqual(
        withoutGroundingElapsed(expected.result),
      );
    } finally {
      f.close();
    }
  });
});

describe("opt-in per-blade road clearance (real generated geometry, CPU only)", () => {
  it("requires an own plain exact mode and preserves omitted/undefined legacy keys, bytes, yields and work", () => {
    const f = analyticOwner("fine");
    try {
      const surface = f.makeSurface();
      const request = f.request(
        surface,
        f.dataAt(surface, [
          [0, 0],
          [5, 0],
        ]),
        0,
      );
      request.roadSegments = [
        { startX: 0, endX: 0, startZ: -10, endZ: 10, width: 1 },
      ];
      const omitted = drainPipeline(groundGrassBladeSteps(request));
      const explicit = drainPipeline(
        groundGrassBladeSteps({ ...request, roadClearance: undefined }),
      );
      expect(explicit.trace).toEqual(omitted.trace);
      expect(withoutGroundingElapsed(explicit.result)).toEqual(
        withoutGroundingElapsed(omitted.result),
      );
      expect(
        Object.prototype.hasOwnProperty.call(omitted.result, "bladeVisibility"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(
          omitted.result.receipt,
          "roadClearance",
        ),
      ).toBe(false);
      expect(omitted.result.receipt.retainedClumps).toBe(1);
      const noRoads = groundGrassBlades({ ...request, roadSegments: [] });
      const optInNoRoads = groundGrassBlades({
        ...request,
        roadSegments: [],
        roadClearance: "per-blade-v1",
      });
      if (noRoads.status !== "ready" || optInNoRoads.status !== "ready")
        throw Error("Expected unexcluded mode comparison");
      for (const key of [
        "data",
        "rootDeltas",
        "sourceIndices",
        "sweptBounds",
        "dependencies",
      ] as const)
        expect(optInNoRoads[key]).toEqual(noRoads[key]);
      const fullMask = (1 << noRoads.receipt.bladesPerClump) - 1;
      expect(Array.from(optInNoRoads.bladeVisibility!)).toEqual([
        fullMask,
        fullMask,
      ]);
      expect(optInNoRoads.receipt.roadClearance).toEqual({
        mode: "per-blade-v1",
        retainedBlades: 48,
        partialClumps: 0,
        maskedRetainedBlades: 0,
        visibilityBytes: 8,
      });
      for (const value of [null, false, 0, "", "per-blade-v2", {}, []]) {
        const invalid = { ...request };
        Object.defineProperty(invalid, "roadClearance", {
          value,
          enumerable: true,
        });
        expect(() => groundGrassBlades(invalid)).toThrow(
          "Invalid grass road-clearance mode",
        );
      }
      const inherited = { ...request };
      Object.setPrototypeOf(inherited, { roadClearance: "per-blade-v1" });
      expect(() => groundGrassBlades(inherited)).toThrow(
        "Invalid grass road-clearance mode",
      );
      let reads = 0;
      const accessor = { ...request };
      Object.defineProperty(accessor, "roadClearance", {
        get: () => {
          reads++;
          return "per-blade-v1";
        },
      });
      expect(() => groundGrassBlades(accessor)).toThrow(
        "Invalid grass road-clearance mode",
      );
      expect(reads).toBe(0);
    } finally {
      f.close();
    }
  });

  it.each([
    ["ordinary", 2],
    ["ordinary", 1],
    ["fine", 0],
    ["isolated-fine-near4", 0],
  ] as const)(
    "retains exact partial/full %s LOD%s masks and safely excludes every visible triangle throughout tilt/fade/wind",
    (appearance, lod) => {
      const f = analyticOwner(appearance);
      try {
        const surface = f.makeSurface(
          1,
          0,
          0,
          64,
          (x, z) => 20 + 0.2 * x - 0.13 * z,
        );
        const request = {
          ...f.request(
            surface,
            f.dataAt(surface, [
              [0, 0, 0.71],
              [8, 0, 0.71],
              [-8, 0, 0.71],
            ]),
            lod,
          ),
          wind: { x: 0.3, z: 0.165 },
        };
        const original = structuredClone(request.data);
        const boxes = independentBladeBoxes(request);
        const maxima = boxes.map((box) => box.max.x).sort((a, b) => a - b);
        const roadX = (maxima[0] + maxima.at(-1)!) / 2 + 0.125;
        const road = {
          startX: roadX,
          endX: roadX,
          startZ: -10,
          endZ: 10,
          width: 0.25,
          blendWidth: 0,
        };
        const roads = [road, { ...road, startX: -8, endX: -8, width: 4 }];
        const layout = getGrassBladeLayout(lod, request.geometryLayout);
        const fullMask = (1 << layout.bladesPerClump) - 1;
        const expected = independentRoadMask(boxes, roads);
        expect(expected).toBeGreaterThan(0);
        expect(expected).toBeLessThan(fullMask);
        const baseline = groundGrassBlades(request);
        const legacy = groundGrassBlades({ ...request, roadSegments: roads });
        const result = groundGrassBlades({
          ...request,
          roadSegments: roads,
          roadClearance: "per-blade-v1",
        });
        if (
          baseline.status !== "ready" ||
          result.status !== "ready" ||
          legacy.status !== "ready"
        )
          throw Error("Expected fully supported road fixtures");
        expect(Array.from(legacy.sourceIndices)).toEqual([1]);
        expect(Array.from(result.sourceIndices)).toEqual([0, 1]);
        expect(result.bladeVisibility).toBeInstanceOf(Uint32Array);
        expect(Array.from(result.bladeVisibility!)).toEqual([
          expected,
          fullMask,
        ]);
        expect(result.receipt.roadClearance).toEqual({
          mode: "per-blade-v1",
          retainedBlades: maskPopulation(expected) + layout.bladesPerClump,
          partialClumps: 1,
          maskedRetainedBlades:
            layout.bladesPerClump - maskPopulation(expected),
          visibilityBytes: 8,
        });
        expect(result.receipt.rejected.road).toBe(1);
        expect(result.data).toEqual({
          ...baseline.data,
          count: 2,
          offsets: baseline.data.offsets.slice(0, 6),
          rotScaleHash: baseline.data.rotScaleHash.slice(0, 6),
          groundColors: baseline.data.groundColors.slice(0, 6),
          grassTints: baseline.data.grassTints.slice(0, 8),
          groundNormals: baseline.data.groundNormals.slice(0, 6),
        });
        expect(result.rootDeltas).toEqual(
          baseline.rootDeltas.slice(0, 4 * layout.bladesPerClump),
        );
        expect(request.data).toEqual(original);

        const index = request.geometry.getIndex()!,
          uv = request.geometry.getAttribute("uv");
        for (let instance = 0; instance < result.data.count; instance++) {
          const visible = result.bladeVisibility![instance];
          const sourceBoxes = independentBladeBoxes(
            request,
            result.sourceIndices[instance],
          );
          expect(visible).toBe(independentRoadMask(sourceBoxes, roads));
          for (let triangle = 0; triangle < index.count; triangle += 3) {
            const blade = Math.floor(
              index.getX(triangle) / layout.verticesPerBlade,
            );
            if (!(visible & (1 << blade))) continue;
            for (const fade of [0, 0.23, 0.67, 1])
              for (const sx of [-1, 0, 1])
                for (const sz of [-1, 0, 1]) {
                  const vertices = [0, 1, 2].map((corner) => {
                    const v = index.getX(triangle + corner);
                    const p = transformedVertex(
                      result.data,
                      surface,
                      request.geometry,
                      instance,
                      v,
                      fade,
                    );
                    p.x += sx * request.wind.x * uv.getY(v) ** 1.8;
                    p.z += sz * request.wind.z * uv.getY(v) ** 1.8;
                    return p;
                  });
                  // Convexity proves the entire triangle lies inside its safe
                  // swept box; additionally sample its interior independently.
                  for (const p of [
                    ...vertices,
                    vertices[0]
                      .clone()
                      .add(vertices[1])
                      .add(vertices[2])
                      .multiplyScalar(1 / 3),
                  ]) {
                    const box = sourceBoxes[blade];
                    expect(
                      p.x >= box.min.x &&
                        p.x <= box.max.x &&
                        p.z >= box.min.z &&
                        p.z <= box.max.z,
                    ).toBe(true);
                    for (const capsule of roads) {
                      const segment = new THREE.Line3(
                        new THREE.Vector3(capsule.startX, 0, capsule.startZ),
                        new THREE.Vector3(capsule.endX, 0, capsule.endZ),
                      );
                      const point = new THREE.Vector3(p.x, 0, p.z);
                      expect(
                        point.distanceTo(
                          segment.closestPointToPoint(
                            point,
                            true,
                            new THREE.Vector3(),
                          ),
                        ),
                      ).toBeGreaterThan(capsule.width / 2);
                    }
                  }
                }
          }
        }
      } finally {
        f.close();
      }
    },
  );

  it("includes an offset geometry's hidden collapse anchor only in partial output bounds, never in exclusion guards", () => {
    const f = analyticOwner("fine");
    try {
      const surface = f.makeSurface(
        1,
        10,
        -20,
        64,
        (x, z) => 20 + 0.15 * x + 0.05 * z,
      );
      const request = f.request(surface, undefined, 0);
      const geometry = request.geometry.clone().translate(3, 0, 4);
      f.geometries.push(geometry);
      request.geometry = geometry;
      const anchor = new THREE.Vector3(
        surface.centerX + request.data.offsets[0],
        request.data.offsets[1],
        surface.centerZ + request.data.offsets[2],
      );
      request.terrainSurface = {
        ...emptySnapshot(),
        zones: [
          {
            id: "collapse-anchor-pad",
            centerX: anchor.x,
            centerZ: anchor.z,
            width: 0.5,
            depth: 0.5,
            height: anchor.y,
            blendRadius: 0,
          },
        ],
        waterBodies: [
          {
            id: "collapse-anchor-water",
            centerX: anchor.x,
            centerZ: anchor.z,
            radius: 0.25,
            surfaceY: anchor.y + 10,
          },
        ],
      };
      const anchorRoad = {
        startX: anchor.x,
        endX: anchor.x,
        startZ: anchor.z - 10,
        endZ: anchor.z + 10,
        width: 0.5,
        blendWidth: 0,
      };
      request.roadSegments = [anchorRoad];
      const legacy = groundGrassBlades(request);
      const full = groundGrassBlades({
        ...request,
        roadClearance: "per-blade-v1",
      });
      if (
        legacy.status !== "ready" ||
        full.status !== "ready" ||
        !legacy.sweptBounds
      )
        throw Error(
          "Expected supported offset geometry outside anchor exclusions",
        );
      expect(legacy.data.count).toBe(1);
      const originalBounds = legacy.sweptBounds;
      // This real translated layout puts the collapse point outside all three
      // lower bounds; root-Y corrections still follow the retained slope.
      expect(anchor.x).toBeLessThan(originalBounds.minX);
      expect(anchor.y).toBeLessThan(originalBounds.minY);
      expect(anchor.z).toBeLessThan(originalBounds.minZ);
      expect(full.sweptBounds).toEqual(originalBounds);
      expect(Array.from(full.bladeVisibility!)).toEqual([(1 << 24) - 1]);
      const omitted = drainPipeline(groundGrassBladeSteps(request));
      const explicit = drainPipeline(
        groundGrassBladeSteps({ ...request, roadClearance: undefined }),
      );
      expect(explicit.trace).toEqual(omitted.trace);
      expect(withoutGroundingElapsed(explicit.result)).toEqual(
        withoutGroundingElapsed(omitted.result),
      );

      const boxes = independentBladeBoxes(request);
      const maxima = boxes.map((box) => box.max.x);
      const x = (Math.min(...maxima) + Math.max(...maxima)) / 2 + 0.125;
      const roads = [
        anchorRoad,
        {
          startX: x,
          endX: x,
          startZ: anchor.z - 10,
          endZ: anchor.z + 10,
          width: 0.25,
          blendWidth: 0,
        },
      ];
      const partial = groundGrassBlades({
        ...request,
        roadSegments: roads,
        roadClearance: "per-blade-v1",
      });
      if (partial.status !== "ready") throw Error(partial.reason);
      const expectedMask = independentRoadMask(boxes, roads);
      expect(expectedMask).toBeGreaterThan(0);
      expect(expectedMask).toBeLessThan((1 << 24) - 1);
      expect(Array.from(partial.bladeVisibility!)).toEqual([expectedMask]);
      expect(partial.receipt.roadClearance?.partialClumps).toBe(1);
      expect(partial.receipt.rejected).toEqual({
        terrain_edge: 0,
        pad: 0,
        road: 0,
        water: 0,
      });
      expect(partial.data).toEqual(legacy.data);
      expect(partial.rootDeltas).toEqual(legacy.rootDeltas);
      expect(partial.sourceIndices).toEqual(legacy.sourceIndices);
      expect(partial.dependencies).toEqual(legacy.dependencies);
      expect(partial.sweptBounds).toEqual({
        ...originalBounds,
        minX: anchor.x,
        minY: anchor.y,
        minZ: anchor.z,
      });
      // The added anchor overlaps every exclusion above. Retaining the clump
      // therefore proves admission used the original geometry envelope, while
      // final culling contains the hidden triangles' actual collapse point.
      expect(
        groundGrassBlades({ ...request, roadSegments: roads }),
      ).toMatchObject({
        status: "ready",
        data: { count: 0 },
        receipt: { rejected: { road: 1, pad: 0, water: 0 } },
      });
    } finally {
      f.close();
    }
  });

  it("keeps capsule tangency inclusive, handles degenerate/duplicate roads, and checks later roads against surviving bits", () => {
    const f = analyticOwner("fine");
    try {
      const request = f.request(f.makeSurface(), undefined, 0);
      const boxes = independentBladeBoxes(request),
        fullMask = (1 << boxes.length) - 1;
      const extreme = boxes.reduce(
        (best, box, i) => (box.max.x > boxes[best].max.x ? i : best),
        0,
      );
      const x = boxes[extreme].max.x + 0.125;
      const tangent = {
        startX: x,
        endX: x,
        startZ: -10,
        endZ: 10,
        width: 2 * (x - boxes[extreme].max.x),
        blendWidth: 0,
      };
      const resultMask = (roads: GrassGroundingRoadSegment[]) => {
        const result = groundGrassBlades({
          ...request,
          roadClearance: "per-blade-v1",
          roadSegments: roads,
        });
        if (result.status !== "ready") throw Error(result.reason);
        const expected = independentRoadMask(boxes, roads);
        expect(Array.from(result.bladeVisibility!)).toEqual(
          expected ? [expected] : [],
        );
        expect(result.data.count).toBe(Number(expected !== 0));
        expect(result.receipt.rejected.road).toBe(Number(expected === 0));
        return expected;
      };
      const at = resultMask([tangent]);
      expect(at & (1 << extreme)).toBe(0);
      const outside = resultMask([
        { ...tangent, startX: x + 1e-7, endX: x + 1e-7 },
      ]);
      expect(outside & (1 << extreme)).not.toBe(0);
      expect(
        resultMask([{ ...tangent, startX: x - 1e-7, endX: x - 1e-7 }]) &
          (1 << extreme),
      ).toBe(0);
      expect(resultMask([tangent, tangent])).toBe(at);
      expect(resultMask([{ ...tangent, width: 100, maxInfluence: 0.8 }])).toBe(
        fullMask,
      );
      const surviving = boxes.findIndex((_, blade) => at & (1 << blade));
      expect(surviving).toBeGreaterThanOrEqual(0);
      const center = boxes[surviving].getCenter(new THREE.Vector3());
      const pointRoad = {
        startX: center.x,
        endX: center.x,
        startZ: center.z,
        endZ: center.z,
        width: 0.01,
        blendWidth: 0,
      };
      const pointMask = resultMask([pointRoad]);
      expect(pointMask & (1 << surviving)).toBe(0);
      expect(resultMask([tangent, pointRoad])).toBe(at & pointMask);
      expect(resultMask([pointRoad, tangent, pointRoad])).toBe(at & pointMask);
      expect(resultMask([{ ...tangent, startX: 0, endX: 0, width: 100 }])).toBe(
        0,
      );
    } finally {
      f.close();
    }
  });

  it("retains whole-clump pad/water/base/support guards and their original rejection precedence", () => {
    const f = analyticOwner();
    try {
      const surface = f.makeSurface(),
        request = f.request(surface);
      const road = {
        startX: 0,
        endX: 0,
        startZ: -10,
        endZ: 10,
        width: 100,
        blendWidth: 0,
      };
      const pad = {
        id: "per-blade-pad",
        centerX: 0,
        centerZ: 0,
        width: 10,
        depth: 10,
        height: 20,
        blendRadius: 0,
      };
      const input = {
        ...request,
        roadClearance: "per-blade-v1" as const,
        roadSegments: [road],
        oceanLevel: 30,
      };
      const cases: [GrassBladeGroundingRequest, "pad" | "road" | "water"][] = [
        [
          { ...input, terrainSurface: { ...emptySnapshot(), zones: [pad] } },
          "pad",
        ],
        [input, "road"],
        [{ ...input, roadSegments: [] }, "water"],
      ];
      for (const [test, reason] of cases) {
        const result = groundGrassBlades(test);
        if (result.status !== "ready") throw Error(result.reason);
        expect(result.data.count).toBe(0);
        expect(result.bladeVisibility).toEqual(new Uint32Array());
        expect(result.receipt.rejected).toEqual({
          terrain_edge: 0,
          pad: 0,
          road: 0,
          water: 0,
          [reason]: 1,
        });
        expect(result.receipt.roadClearance).toEqual({
          mode: "per-blade-v1",
          retainedBlades: 0,
          partialClumps: 0,
          maskedRetainedBlades: 0,
          visibilityBytes: 0,
        });
      }
      const missing = groundGrassBlades({
        ...input,
        data: f.dataAt(surface, [[49.8, 0]]),
      });
      expect(missing).toMatchObject({
        status: "defer",
        reason: "missing_surface",
      });
      expect(
        Object.prototype.hasOwnProperty.call(missing, "bladeVisibility"),
      ).toBe(false);
      const crease = f.makeSurface(2, 0, 0, 3, (x) => 20 + 20 * Math.abs(x));
      const p = request.geometry.getAttribute("position"),
        ny = 1 / Math.hypot(20, 1);
      const data = f.dataAt(crease, [
        [(-(p.getX(0) + p.getX(1)) / 2) * ny, -(p.getZ(0) + p.getZ(1)) / 2],
      ]);
      expect(
        groundGrassBlades({
          ...f.request(crease, data),
          roadClearance: "per-blade-v1",
          roadSegments: [road],
          maximumBaseError: 0.001,
        }),
      ).toMatchObject({
        status: "ready",
        data: { count: 0 },
        receipt: { rejected: { terrain_edge: 1, road: 0 } },
      });
    } finally {
      f.close();
    }
  });

  it("preserves sync/sliced results and fails closed on exact work exhaustion or cancellation during a road blade", () => {
    const f = analyticOwner("fine");
    try {
      const surface = f.makeSurface();
      const request = {
        ...f.request(
          surface,
          f.dataAt(surface, [
            [0, 0, 0.7],
            [5, 0, 1.2],
          ]),
          0,
        ),
        roadClearance: "per-blade-v1" as const,
      };
      const boxes = independentBladeBoxes(request),
        x = boxes[0].max.x + 0.1;
      request.roadSegments = [
        {
          startX: x,
          endX: x,
          startZ: -10,
          endZ: 10,
          width: 0.2,
          blendWidth: 0,
        },
      ];
      const expected = groundGrassBlades(request);
      if (expected.status !== "ready") throw Error(expected.reason);
      expect(expected.bladeVisibility).toHaveLength(expected.data.count);
      for (const size of [1, 7, 1024]) {
        const job = new GrassBladeGroundingJob(request, () => true);
        let slices = 0;
        while (job.state.status === "running") {
          expect(
            Object.prototype.hasOwnProperty.call(job.state, "result"),
          ).toBe(false);
          job.advance(size);
          expect(job.lastSliceOperations).toBeLessThanOrEqual(size);
          if (++slices > 100000)
            throw Error("Unexpected unbounded road-clearance continuation");
        }
        if (job.state.status !== "ready") throw Error(job.state.status);
        expect(withoutGroundingElapsed(job.state.result)).toEqual(
          withoutGroundingElapsed(expected),
        );
      }
      const exact = groundGrassBlades({
        ...request,
        workBudget: expected.receipt.workUnits,
      });
      expect(exact.status).toBe("ready");
      const exhausted = {
        ...request,
        workBudget: expected.receipt.workUnits - 1,
      };
      const failed = groundGrassBlades(exhausted);
      expect(failed).toMatchObject({ status: "defer", reason: "work_budget" });
      for (const key of [
        "data",
        "rootDeltas",
        "bladeVisibility",
        "sourceIndices",
      ])
        expect(Object.prototype.hasOwnProperty.call(failed, key)).toBe(false);
      const budgetJob = new GrassBladeGroundingJob(exhausted, () => true);
      while (budgetJob.state.status === "running") budgetJob.advance(7);
      expect(budgetJob.state).toEqual({
        status: "failed_budget",
        reason: "grounding_work",
      });
      for (const invalidated of [false, true]) {
        const geometry = f.geometries[0];
        const job = new GrassBladeGroundingJob(request, () =>
          surface.matchesGeometry(geometry),
        );
        while (job.state.status === "running" && job.lastPhase !== "road_blade")
          job.advance(1);
        expect(job.lastPhase).toBe("road_blade");
        expect(job.state.status).toBe("running");
        const operations = job.operations;
        if (invalidated) {
          geometry.setAttribute(
            "position",
            geometry.getAttribute("position").clone(),
          );
          job.advance(1);
        } else job.cancel();
        expect(job.state).toEqual({
          status: "cancelled",
          reason: invalidated ? "invalidated" : "caller",
        });
        expect(job.operations).toBe(operations);
        expect(Object.prototype.hasOwnProperty.call(job.state, "result")).toBe(
          false,
        );
        const terminal = job.state;
        expect(job.advance(1)).toBe(terminal);
      }
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
  let runWorker: (input: GrassWorkerInput) => Promise<GrassWorkerOutput>;
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
    terrain["landscapeGrassSurface"].exclusionPolygons = [];
    terrain.unregisterFlatZone("central_haven_lodge_grass_clearance");
    const plaza = terrain["flatZones"].get("central_haven_plaza")!;
    terrain.registerFlatZone({ ...plaza, excludeGrass: undefined });
    const grade = terrain["flatZones"].get("duel_arena_campus_grade")!;
    terrain.registerFlatZone({ ...grade, excludeGrass: undefined });
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
      (x, z) => terrain["getHeightAtComputed"](x, z),
      profile.water.threshold,
      (x, z) => terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
      (x, z) => terrain["isGrassExcludedAt"](x, z),
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
    runWorker = (input: GrassWorkerInput) =>
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
      outputs.push(await runWorker({ ...input, clumpSpacing: 2.1 }));
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
      (wx, wz) => terrain["isGrassExcludedAt"](wx, wz),
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

  it("excludes actual rock footprints in the production worker without resampling or changing any surviving grass attributes", async () => {
    const node = tree.createNode(null, null, 100, 350, 250, 4);
    const polygons = createCompactLandscapeRockFootprints(
      DataManager.getWorldConfig()!.compactLandscapeRocks,
    );
    const previous = terrain["landscapeGrassSurface"].exclusionPolygons;
    try {
      terrain["landscapeGrassSurface"].exclusionPolygons = polygons;
      const input = manager["createWorkerInput"](
        node,
        "rock-footprint-parity",
        1,
      );
      const result = await runWorker({ ...input, clumpSpacing: 2.1 });
      const before = outputs[1],
        operations = createGrassTerrainSurfaceOperations();
      const excluded = Array.from({ length: before.count }, (_, i) =>
        operations.isGrassExcluded(
          { exclusionPolygons: polygons },
          before.offsets[i * 3] + 350,
          before.offsets[i * 3 + 2] + 250,
        ),
      ).filter(Boolean).length;
      expect(excluded).toBeGreaterThan(0);
      expect(result.count).toBe(before.count - excluded);
      const sourceByHash = new Map(
        Array.from({ length: before.count }, (_, i) => [
          before.rotScaleHash[i * 3 + 2],
          i,
        ]),
      );
      for (let i = 0; i < result.count; i++) {
        const original = sourceByHash.get(result.rotScaleHash[i * 3 + 2]);
        expect(original).toBeDefined();
        for (const [key, stride] of [
          ["offsets", 3],
          ["rotScaleHash", 3],
          ["groundColors", 3],
          ["grassTints", 4],
          ["groundNormals", 3],
        ] as const)
          expect(result[key].slice(i * stride, (i + 1) * stride)).toEqual(
            before[key].slice(original! * stride, (original! + 1) * stride),
          );
        const x = result.offsets[i * 3] + 350,
          z = result.offsets[i * 3 + 2] + 250;
        expect(
          operations.isGrassExcluded({ exclusionPolygons: polygons }, x, z),
        ).toBe(false);
      }
    } finally {
      terrain["landscapeGrassSurface"].exclusionPolygons = previous;
    }
  });

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
    const receipts: (GrassBladeGroundingResult["receipt"] & {
      center: number[];
    })[] = [];
    for (const index of [0, 1]) {
      const request = requestAt(index),
        before = structuredClone(request.data),
        result = groundGrassBlades(request);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw Error(result.reason);
      expect(request.data).toEqual(before);
      expect(request.data.count).toBe([478, 600][index]);
      expect(result.data.count).toBe([458, 588][index]);
      // The pre-shortcut quantized-field census visited 11,574 / 15,462
      // triangles for these same raw/accepted populations. Prove real work
      // removal, not a density reduction; numerical parity is checked below
      // and by the independent frozen same-face regression signatures.
      expect(result.receipt.triangleVisits).toBeLessThan([11574, 15462][index]);
      expect(result.receipt.sameFaceEdges).toBeGreaterThan(0);
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
        (x, z) => terrain["isGrassExcludedAt"](x, z),
      ),
      projectedWorker = projectGrassAnchors(
        prefix,
        request.ownSurface,
        (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
        (x, z) => terrain["isGrassExcludedAt"](x, z),
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
