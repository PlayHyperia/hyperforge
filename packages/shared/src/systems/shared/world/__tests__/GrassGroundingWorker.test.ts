import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BufferAttribute } from "three/src/core/BufferAttribute.js";
import {
  GRASS_GROUNDING_WORKER_LIMITS,
  grassGroundingWorkerInputTransfers,
  type GrassGroundingWorkerRequest,
  type GrassGroundingWorkerCachedRequest,
  type GrassGroundingWorkerPrepareSurface,
} from "../../../../utils/workers/GrassGroundingWorkerWire";
import {
  groundGrassBlades,
  GRASS_BLADE_GROUNDING_LIMITS,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
} from "../GrassBladeGrounding";
import {
  createSameFaceCase,
  sameFaceInputHash,
  type SameFaceCase,
} from "./fixtures/GrassBladeGroundingSameFaceCases";
import {
  type ActualGroundingWorker,
  bundleGrassGroundingWorker,
  createActualGroundingWorker,
  createGrassGroundingWorkerRequest as workerRequest,
  grassGroundingWorkerReply as reply,
  grassGroundingWorkerSemanticResult as semanticResult,
  runGrassGroundingWorker as run,
  prepareCachedGrassGroundingWorkerRequest,
} from "./fixtures/GrassGroundingWorkerHarness";
import {
  RetainedTerrainSurface,
  type RetainedTerrainSurfaceSnapshot,
} from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";

let bundledSource = "";
let bundledInputs: string[] = [];
const workers: ActualGroundingWorker[] = [];
async function actualWorker() {
  const worker = await createActualGroundingWorker(bundledSource);
  workers.push(worker);
  return worker;
}

function preparePacket(
  cold: GrassGroundingWorkerRequest,
  jobId: number,
  token: number,
): GrassGroundingWorkerPrepareSurface {
  return {
    type: "prepare_surface",
    schemaVersion: 1,
    jobId,
    generation: cold.generation,
    token,
    snapshot: cold.surfaces[0].snapshot,
    consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
  };
}

function cachedPacket(
  cold: GrassGroundingWorkerRequest,
  jobId: number,
  surfaceTokens = cold.surfaces.map(({ token }) => token),
): GrassGroundingWorkerCachedRequest {
  const { type, surfaces, ...fit } = cold;
  expect(type).toBe("start");
  expect(surfaceTokens).toHaveLength(surfaces.length);
  return {
    ...fit,
    type: "start_cached",
    jobId,
    surfaceTokens,
    ownSurfaceToken: surfaceTokens[cold.ownSurfaceToken - 1],
  };
}

async function prepare(
  worker: ActualGroundingWorker,
  request: GrassGroundingWorkerPrepareSurface,
) {
  const transfers = grassGroundingWorkerInputTransfers(request);
  const inputBytes = transfers.reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  worker.send(request, transfers);
  expect(transfers.every((buffer) => buffer.byteLength === 0)).toBe(true);
  expect(await reply(worker, "accepted", request.jobId)).toMatchObject({
    inputBytes,
    generation: request.generation,
  });
  const response = await reply(worker, "surface_prepared", request.jobId);
  expect(response.inputBytes).toBe(inputBytes);
  return response;
}

function copySurface(
  surface: RetainedTerrainSurface,
): RetainedTerrainSurfaceSnapshot {
  const steps = surface.copySnapshotSteps(surface.snapshotByteLength());
  for (let i = 0; i < 1_000_000; i++) {
    const step = steps.next();
    if (step.done) return step.value;
  }
  steps.return(undefined as never);
  throw new Error("Bounded test snapshot did not complete");
}

/** Real authored indexed grid; refined cells use four actual positive-winding
 * faces and shared boundary vertices, not a substitute surface implementation. */
function authoredGrid(resolution: number, indexed = false, refined = false) {
  const geometry = gridGeometry(100, resolution, () => 20);
  if (indexed) {
    const positions = Array.from(geometry.getAttribute("position").array);
    const indices: number[] = [],
      offsets = [0];
    for (let z = 0; z < resolution - 1; z++)
      for (let x = 0; x < resolution - 1; x++) {
        const a = z * resolution + x;
        if (refined) {
          const center = positions.length / 3;
          positions.push(
            (positions[a * 3] + positions[(a + 1) * 3]) / 2,
            20,
            (positions[a * 3 + 2] + positions[(a + resolution) * 3 + 2]) / 2,
          );
          const boundary = [a, a + resolution, a + resolution + 1, a + 1];
          for (let side = 0; side < 4; side++)
            indices.push(center, boundary[side], boundary[(side + 1) % 4]);
        } else
          indices.push(
            a,
            a + resolution,
            a + 1,
            a + 1,
            a + resolution,
            a + resolution + 1,
          );
        offsets.push(indices.length);
      }
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(positions), 3),
    );
    geometry.setIndex(indices);
    geometry.userData.terrainCellTopology = Object.freeze({
      schemaVersion: 1,
      resolution,
      surfaceVertexCount: positions.length / 3,
      cellIndexOffsets: Object.freeze(offsets),
    });
  }
  const surface = new RetainedTerrainSurface(
    101,
    "cached-worker-test-grid-v1",
    0,
    0,
    100,
    resolution,
    geometry,
  );
  return { surface, geometry, dispose: () => geometry.dispose() };
}

beforeAll(async () => {
  const bundled = await bundleGrassGroundingWorker();
  bundledSource = bundled.source;
  bundledInputs = bundled.inputs;
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
});

describe("actual isolated grass grounding worker", () => {
  it("bundles the production CPU core without renderer or server modules", async () => {
    expect(
      bundledInputs.some((path) => path.endsWith("GrassBladeGrounding.ts")),
    ).toBe(true);
    expect(
      bundledInputs.some((path) => path.endsWith("TerrainGridSurface.ts")),
    ).toBe(true);
    expect(
      bundledInputs.filter((path) =>
        /(?:three\/src\/renderers\/|Three\.WebGPU|extras\/three\/|\/server\/|\/World\.ts$|\/GrassVisualManager\.ts$|\/TerrainSystem\.ts$)/.test(
          path,
        ),
      ),
    ).toEqual([]);
    await actualWorker();
  });

  it.each<SameFaceCase>([
    "ordinary-lod0",
    "ordinary-lod1",
    "ordinary-lod2",
    "fine-lod0",
    "fine-lod1",
    "fine-lod2",
    "fine-near4",
    "refined-interiors",
    "adjacent-owners",
    "missing-neighbor",
    "mixed-exclusions",
    "empty",
  ])(
    "is bitwise equal to the real core for %s and transfers only owned copies",
    async (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const originalHash = sameFaceInputHash(fixture);
        const expected = groundGrassBlades(fixture.request);
        const input = workerRequest(fixture.request);
        const worker = await actualWorker();
        const response = await run(worker, input);
        expect(response.state.status).toBe(
          expected.status === "ready" ? "ready" : "waiting_support",
        );
        if (
          response.state.status !== "ready" &&
          response.state.status !== "waiting_support"
        )
          throw new Error(
            `Unexpected grounding terminal state: ${response.state.status}`,
          );
        expect(semanticResult(response.state.result, fixture.request)).toEqual(
          semanticResult(expected, fixture.request),
        );
        expect(response.work.operations).toBeGreaterThan(0);
        expect(response.work.operations).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
        );
        expect(response.work.activeMs).toBeGreaterThanOrEqual(0);
        expect(sameFaceInputHash(fixture)).toBe(originalHash);
        for (const owned of fixture.owned) {
          expect(
            owned.geometry.getAttribute("position").array.byteLength,
          ).toBeGreaterThan(0);
          expect(owned.geometry.getIndex()?.array.byteLength).toBeGreaterThan(
            0,
          );
          expect(owned.surface.matchesGeometry(owned.geometry)).toBe(true);
        }
      } finally {
        fixture.dispose();
      }
    },
  );

  it("preserves the core geometric-work budget instead of restarting exhausted work", async () => {
    const fixture = createSameFaceCase("budget-one");
    try {
      expect(groundGrassBlades(fixture.request)).toMatchObject({
        status: "defer",
        reason: "work_budget",
      });
      const response = await run(
        await actualWorker(),
        workerRequest(fixture.request),
      );
      expect(response.state).toEqual({
        status: "failed_budget",
        reason: "grounding_work",
      });
      expect(response.resultBytes).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    {
      operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
      activeMs: 0,
      maximumSliceMs: 0,
      reason: "operations",
    },
    {
      operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations - 1,
      activeMs: 0,
      maximumSliceMs: 0,
      reason: "operations",
    },
    {
      operations: 37,
      activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
      maximumSliceMs: 1.25,
      reason: "active_cpu",
    },
  ] as const)(
    "charges seeded cumulative work without resetting $reason",
    async ({ reason, ...consumed }) => {
      const fixture = createSameFaceCase("ordinary-lod1");
      try {
        const input = workerRequest(fixture.request);
        input.consumed = consumed;
        const response = await run(await actualWorker(), input);
        expect(response.state).toEqual({ status: "failed_budget", reason });
        expect(response.work.operations).toBeGreaterThanOrEqual(
          consumed.operations,
        );
        expect(response.work.operations).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
        );
        expect(response.work.activeMs).toBeGreaterThanOrEqual(
          consumed.activeMs,
        );
        expect(response.work.maximumSliceMs).toBeGreaterThanOrEqual(
          consumed.maximumSliceMs,
        );
        expect(response.resultBytes).toBe(0);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("retains nonexhausted seeded charges through reconstruction and ready output", async () => {
    const fixture = createSameFaceCase("fine-lod1");
    try {
      const input = workerRequest(fixture.request);
      input.consumed = { operations: 37, activeMs: 12.5, maximumSliceMs: 1.25 };
      const response = await run(await actualWorker(), input);
      expect(response.state.status).toBe("ready");
      expect(response.work.operations).toBeGreaterThan(37);
      expect(response.work.activeMs).toBeGreaterThanOrEqual(12.5);
      expect(response.work.maximumSliceMs).toBeGreaterThanOrEqual(1.25);
      if (response.state.status !== "ready")
        throw new Error("Expected ready grounding");
      expect(response.state.result.receipt.elapsedMs).toBe(
        response.work.activeMs,
      );
    } finally {
      fixture.dispose();
    }
  });

  it("rejects busy starts and wrong-generation cancels without consuming the next job ID", async () => {
    const fixture = createSameFaceCase("fine-dense-nonplanar");
    try {
      const worker = await actualWorker();
      const first = workerRequest(fixture.request, 1, 7);
      // A genuine maximum-clump numeric input cannot finish in the first
      // bounded continuation slice; no fake clock or scheduler is installed.
      const count = GRASS_BLADE_GROUNDING_LIMITS.maxClumps;
      for (const [key, stride] of [
        ["offsets", 3],
        ["rotScaleHash", 3],
        ["groundColors", 3],
        ["grassTints", 4],
        ["groundNormals", 3],
      ] as const) {
        const source = first.data[key],
          output = new Float32Array(count * stride);
        for (let i = 0; i < count; i++) {
          const offset = (i % first.data.count) * stride;
          output.set(source.subarray(offset, offset + stride), i * stride);
        }
        first.data[key] = output;
      }
      first.data.count = count;
      const busy = workerRequest(fixture.request, 2, 8);
      worker.send(first, grassGroundingWorkerInputTransfers(first));
      worker.send(busy, grassGroundingWorkerInputTransfers(busy));
      worker.send({
        type: "cancel",
        schemaVersion: 1,
        jobId: 1,
        generation: 8,
      });
      worker.send({
        type: "cancel",
        schemaVersion: 1,
        jobId: 1,
        generation: 7,
      });
      expect(await reply(worker, "accepted", 1)).toMatchObject({
        generation: 7,
      });
      expect(await reply(worker, "rejected", 2)).toMatchObject({
        generation: 8,
        reason: "busy",
      });
      expect(await reply(worker, "rejected", 1)).toMatchObject({
        generation: 8,
        reason: "stale",
      });
      const cancelled = await reply(worker, "result", 1);
      expect(cancelled).toMatchObject({
        generation: 7,
        state: { status: "cancelled", reason: "caller" },
        resultBytes: 0,
      });
      const next = await run(worker, workerRequest(fixture.request, 2, 8));
      expect(next.state.status).toBe("ready");
      const replay = workerRequest(fixture.request, 2, 9);
      worker.send(replay, grassGroundingWorkerInputTransfers(replay));
      expect(await reply(worker, "rejected", 2)).toMatchObject({
        generation: 9,
        reason: "stale",
      });
      worker.send({
        type: "cancel",
        schemaVersion: 1,
        jobId: 1,
        generation: 7,
      });
      expect(await reply(worker, "rejected", 1)).toMatchObject({
        generation: 7,
        reason: "stale",
      });
      const third = await run(worker, workerRequest(fixture.request, 3, 10));
      expect(third.state.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    "terrain-position",
    "refined-topology",
    "blade-position",
    "blade-uv",
  ] as const)(
    "rejects malformed %s through actual reconstruction/core validation without publishing output",
    async (malformation) => {
      const fixture = createSameFaceCase("refined-interiors");
      try {
        const input = workerRequest(fixture.request);
        if (malformation === "terrain-position")
          input.surfaces[0].snapshot.positions[0] += 1;
        if (malformation === "refined-topology") {
          const topology = input.surfaces[0].snapshot.topology;
          if (!topology)
            throw new Error("Expected actual refined fixture topology");
          topology.cellIndexOffsets[1] = 1;
        }
        if (malformation === "blade-position")
          input.geometry.position[0] = Number.NaN;
        if (malformation === "blade-uv") input.geometry.uv[1] = -1;
        const response = await run(await actualWorker(), input);
        expect(response.state.status).toBe("failed_input");
        expect(response.resultBytes).toBe(0);
        expect("result" in response.state).toBe(false);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    "subarray",
    "shared-buffer",
    "input-byte-cap",
    "consumed-over-cap",
  ] as const)(
    "rejects %s at transport admission and remains usable",
    async (malformation) => {
      const fixture = createSameFaceCase("ordinary-lod1");
      try {
        const worker = await actualWorker();
        const input = workerRequest(fixture.request);
        let malformedAliasTransfers: ArrayBuffer[] | undefined;
        if (malformation === "subarray")
          input.geometry.uv = input.geometry.uv.subarray(2);
        if (malformation === "shared-buffer") {
          const originalTransfers = grassGroundingWorkerInputTransfers(input);
          const displacedNormalBuffer = input.data.groundNormals.buffer;
          input.data.groundNormals = input.data.offsets;
          expect(() => grassGroundingWorkerInputTransfers(input)).toThrow(
            "must not alias buffers",
          );
          // Deliberately bypass ONLY the rejected sender helper for this wire
          // probe. Real transfer preserves the alias; the displaced unreferenced
          // copy is excluded and the remaining transfer list is explicitly unique.
          malformedAliasTransfers = [
            ...new Set(
              originalTransfers.filter(
                (buffer) => buffer !== displacedNormalBuffer,
              ),
            ),
          ];
        }
        if (malformation === "input-byte-cap") {
          const original = input.surfaces[0].snapshot;
          const positions = new Float32Array(
            GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes / 4 + 2,
          );
          input.surfaces[0].snapshot = {
            ...original,
            positions,
            positionCount: positions.length / 3,
            payloadBytes: positions.byteLength + original.indices.byteLength,
          };
        }
        if (malformation === "consumed-over-cap")
          input.consumed.operations =
            GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations + 1;
        worker.send(
          input,
          malformedAliasTransfers ?? grassGroundingWorkerInputTransfers(input),
        );
        expect(await reply(worker, "rejected", 1)).toMatchObject({
          reason: "invalid_message",
          generation: 1,
        });
        const next = await run(worker, workerRequest(fixture.request, 2));
        expect(next.state.status).toBe("ready");
      } finally {
        fixture.dispose();
      }
    },
  );
});

describe("explicit actual-worker retained terrain preparation", () => {
  it.each<SameFaceCase>([
    "ordinary-lod0",
    "ordinary-lod1",
    "ordinary-lod2",
    "fine-lod0",
    "fine-lod1",
    "fine-lod2",
    "fine-near4",
    "refined-interiors",
    "adjacent-owners",
    "missing-neighbor",
    "mixed-exclusions",
    "empty",
  ])(
    "preserves complete %s output with separately charged one-time preparation",
    async (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const original = sameFaceInputHash(fixture),
          expected = groundGrassBlades(fixture.request);
        const worker = await actualWorker(),
          cold = workerRequest(fixture.request);
        const sourceBytes = cold.surfaces.reduce(
          (total, { snapshot }) => total + snapshot.payloadBytes,
          0,
        );
        const { request, admissions } =
          await prepareCachedGrassGroundingWorkerRequest(worker, cold);
        expect(admissions).toHaveLength(fixture.request.surfaces.length);
        expect(
          admissions.reduce(
            (total, admission) => total + admission.inputBytes,
            0,
          ),
        ).toBe(sourceBytes);
        for (const admission of admissions) {
          expect(admission.work.operations).toBeGreaterThan(0);
          expect(admission.work.operations).toBeLessThanOrEqual(
            GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
          );
          expect(admission.work.activeMs).toBeGreaterThanOrEqual(0);
        }
        const repeated = structuredClone({
          ...request,
          jobId: request.jobId + 1,
        });
        for (const packet of [request, repeated]) {
          const result = await run(worker, packet);
          expect(result.terrainRebuildWork).toBeNull();
          expect(result.cache).toEqual(admissions[admissions.length - 1].cache);
          expect(result.state.status).toBe(
            expected.status === "ready" ? "ready" : "waiting_support",
          );
          if (
            result.state.status !== "ready" &&
            result.state.status !== "waiting_support"
          )
            throw new Error("Cached fitting failed: " + JSON.stringify(result));
          expect(semanticResult(result.state.result, fixture.request)).toEqual(
            semanticResult(expected, fixture.request),
          );
        }
        expect(sameFaceInputHash(fixture)).toBe(original);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    {
      operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
      activeMs: 0,
      maximumSliceMs: 0,
      reason: "operations",
    },
    {
      operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations - 1,
      activeMs: 0,
      maximumSliceMs: 0,
      reason: "operations",
    },
    {
      operations: 37,
      activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
      maximumSliceMs: 1.25,
      reason: "active_cpu",
    },
  ] as const)(
    "does not reset the cached-fitting $reason limit after preparation",
    async ({ reason, ...consumed }) => {
      const fixture = createSameFaceCase("fine-lod1");
      try {
        const worker = await actualWorker(),
          cold = workerRequest(fixture.request);
        cold.consumed = consumed;
        const { request, admissions } =
          await prepareCachedGrassGroundingWorkerRequest(worker, cold);
        expect(request.consumed).toEqual(consumed);
        expect(admissions[0].work.operations).toBeGreaterThan(0);
        const result = await run(worker, request);
        expect(result.state).toEqual({ status: "failed_budget", reason });
        expect(result.work.operations).toBeGreaterThanOrEqual(
          consumed.operations,
        );
        expect(result.work.operations).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
        );
        expect(result.work.activeMs).toBeGreaterThanOrEqual(consumed.activeMs);
        expect(result.work.maximumSliceMs).toBeGreaterThanOrEqual(
          consumed.maximumSliceMs,
        );
        expect(result.terrainRebuildWork).toBeNull();
        expect(result.cache).toEqual(admissions[0].cache);
        expect(result.resultBytes).toBe(0);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    {
      operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
      activeMs: 0,
      maximumSliceMs: 0,
      reason: "operations",
    },
    {
      operations: 0,
      activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
      maximumSliceMs: 1.25,
      reason: "active_cpu",
    },
  ] as const)(
    "charges preparation's seeded $reason cap and never publishes a partial owner",
    async ({ reason, ...consumed }) => {
      const fixture = createSameFaceCase("ordinary-lod1");
      try {
        const worker = await actualWorker(),
          request = preparePacket(workerRequest(fixture.request), 1, 1);
        request.consumed = consumed;
        const result = await prepare(worker, request);
        expect(result.state).toEqual({ status: "failed_budget", reason });
        expect(result.work.operations).toBe(consumed.operations);
        expect(result.work.activeMs).toBeGreaterThanOrEqual(consumed.activeMs);
        expect(result.cache).toEqual({
          owners: 0,
          inputBytes: 0,
          derivedBytesReserved: 0,
        });
        const reused = preparePacket(workerRequest(fixture.request), 2, 1);
        worker.send(reused, grassGroundingWorkerInputTransfers(reused));
        expect(await reply(worker, "rejected", 2)).toMatchObject({
          reason: "invalid_message",
        });
        expect(
          (
            await prepare(
              worker,
              preparePacket(workerRequest(fixture.request), 3, 2),
            )
          ).state.status,
        ).toBe("prepared");
      } finally {
        fixture.dispose();
      }
    },
  );

  it("cancels real sliced preparation, rejects busy/stale messages and burns its accepted token", async () => {
    // 47² genuine fan cells each validate four separate sides: more than one
    // 8192-operation slice, independent of machine speed or fake clocks.
    const grid = authoredGrid(48, true, true),
      fixture = createSameFaceCase("ordinary-lod1");
    try {
      const worker = await actualWorker();
      const first: GrassGroundingWorkerPrepareSurface = {
        type: "prepare_surface",
        schemaVersion: 1,
        jobId: 1,
        generation: 7,
        token: 1,
        snapshot: copySurface(grid.surface),
        consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
      };
      const busy = preparePacket(workerRequest(fixture.request, 2, 8), 2, 2);
      worker.send(first, grassGroundingWorkerInputTransfers(first));
      worker.send(busy, grassGroundingWorkerInputTransfers(busy));
      worker.send({
        type: "release_surfaces",
        schemaVersion: 1,
        jobId: 3,
        generation: 7,
        surfaceTokens: [],
      });
      worker.send({
        type: "cancel",
        schemaVersion: 1,
        jobId: 1,
        generation: 8,
      });
      worker.send({
        type: "cancel",
        schemaVersion: 1,
        jobId: 1,
        generation: 7,
      });
      expect(await reply(worker, "accepted", 1)).toMatchObject({
        generation: 7,
      });
      expect(await reply(worker, "rejected", 2)).toMatchObject({
        reason: "busy",
      });
      expect(await reply(worker, "rejected", 3)).toMatchObject({
        reason: "busy",
      });
      expect(await reply(worker, "rejected", 1)).toMatchObject({
        generation: 8,
        reason: "stale",
      });
      const cancelled = await reply(worker, "surface_prepared", 1);
      expect(cancelled.state).toEqual({
        status: "cancelled",
        reason: "caller",
      });
      expect(cancelled.cache).toEqual({
        owners: 0,
        inputBytes: 0,
        derivedBytesReserved: 0,
      });
      const stale = preparePacket(workerRequest(fixture.request), 1, 2);
      worker.send(stale, grassGroundingWorkerInputTransfers(stale));
      expect(await reply(worker, "rejected", 1)).toMatchObject({
        reason: "stale",
      });
      const reused = preparePacket(workerRequest(fixture.request), 2, 1);
      worker.send(reused, grassGroundingWorkerInputTransfers(reused));
      expect(await reply(worker, "rejected", 2)).toMatchObject({
        reason: "invalid_message",
      });
      const prepared = await prepare(
        worker,
        preparePacket(workerRequest(fixture.request), 2, 2),
      );
      expect(prepared.state).toMatchObject({ status: "prepared", token: 2 });
      const fit = await run(
        worker,
        cachedPacket(workerRequest(fixture.request), 3, [2]),
      );
      expect(fit.state.status).toBe("ready");
      expect(grid.surface.matchesGeometry(grid.geometry)).toBe(true);
    } finally {
      grid.dispose();
      fixture.dispose();
    }
  });

  it("rolls back invalid preparation and atomic invalid releases, then frees owned cache reservations", async () => {
    const fixture = createSameFaceCase("ordinary-lod1");
    try {
      const worker = await actualWorker();
      const original = sameFaceInputHash(fixture);
      const first = await prepare(
        worker,
        preparePacket(workerRequest(fixture.request), 1, 1),
      );
      expect(first.state.status).toBe("prepared");
      const bad = preparePacket(workerRequest(fixture.request), 2, 2);
      bad.snapshot.positions[0] += 1;
      const failed = await prepare(worker, bad);
      expect(failed.state.status).toBe("failed_input");
      expect(failed.cache).toEqual(first.cache);
      const reused = preparePacket(workerRequest(fixture.request), 3, 2);
      worker.send(reused, grassGroundingWorkerInputTransfers(reused));
      expect(await reply(worker, "rejected", 3)).toMatchObject({
        reason: "invalid_message",
      });
      const second = await prepare(
        worker,
        preparePacket(workerRequest(fixture.request), 4, 3),
      );
      expect(second.state.status).toBe("prepared");
      expect(second.cache.owners).toBe(2);
      for (const surfaceTokens of [
        [1, 999],
        [1, 1],
      ]) {
        worker.send({
          type: "release_surfaces",
          schemaVersion: 1,
          jobId: 5,
          generation: 1,
          surfaceTokens,
        });
        expect(await reply(worker, "rejected", 5)).toMatchObject({
          reason: "invalid_message",
        });
      }
      const fit = await run(
        worker,
        cachedPacket(workerRequest(fixture.request), 6),
      );
      expect(fit.state.status).toBe("ready");
      expect(fit.cache).toEqual(second.cache);
      worker.send({
        type: "release_surfaces",
        schemaVersion: 1,
        jobId: 7,
        generation: 1,
        surfaceTokens: [1, 3],
      });
      expect(await reply(worker, "surfaces_released", 7)).toMatchObject({
        surfaceTokens: [1, 3],
        cache: { owners: 0, inputBytes: 0, derivedBytesReserved: 0 },
      });
      const missing = cachedPacket(workerRequest(fixture.request), 8);
      worker.send(missing, grassGroundingWorkerInputTransfers(missing));
      expect(await reply(worker, "rejected", 8)).toMatchObject({
        reason: "invalid_message",
      });
      const releasedToken = preparePacket(workerRequest(fixture.request), 9, 3);
      worker.send(
        releasedToken,
        grassGroundingWorkerInputTransfers(releasedToken),
      );
      expect(await reply(worker, "rejected", 9)).toMatchObject({
        reason: "invalid_message",
      });
      expect(
        (
          await prepare(
            worker,
            preparePacket(workerRequest(fixture.request), 10, 4),
          )
        ).state.status,
      ).toBe("prepared");
      worker.send({
        type: "release_surfaces",
        schemaVersion: 1,
        jobId: 11,
        generation: 1,
        surfaceTokens: [4],
      });
      expect((await reply(worker, "surfaces_released", 11)).cache).toEqual({
        owners: 0,
        inputBytes: 0,
        derivedBytesReserved: 0,
      });
      expect(sameFaceInputHash(fixture)).toBe(original);
      for (const { surface, geometry } of fixture.owned)
        expect(surface.matchesGeometry(geometry)).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    { name: "legacy", indexed: false, refined: false, reserved: 0 },
    { name: "coarse topology", indexed: true, refined: false, reserved: 1281 },
    { name: "fan topology", indexed: true, refined: true, reserved: 1473 },
  ])(
    "reserves exact derived bytes for $name, including topology cell qualification",
    async ({ indexed, refined, reserved }) => {
      // Nine real cells. Both topology fixtures have fewer than nine faces per
      // cell, so their qualification arrays exist even with zero edge blocks.
      // Legacy geometry has no topology index and reserves no derived bytes.
      const grid = authoredGrid(4, indexed, refined);
      try {
        const worker = await actualWorker();
        const snapshot = copySurface(grid.surface),
          payloadBytes = snapshot.payloadBytes;
        const response = await prepare(worker, {
          type: "prepare_surface",
          schemaVersion: 1,
          jobId: 1,
          generation: 1,
          token: 1,
          snapshot,
          consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
        });
        expect(response.state.status).toBe("prepared");
        expect(response.inputBytes).toBe(payloadBytes);
        expect(response.derivedBytesReserved).toBe(reserved);
        expect(response.cache).toEqual({
          owners: 1,
          inputBytes: payloadBytes,
          derivedBytesReserved: reserved,
        });
        if (indexed) {
          expect(grid.surface.groundingEdgeIndexStats).toMatchObject({
            blocks: 0,
            qualifiedBlocks: 0,
            bytes: 49, // ten Uint32 offsets + nine Uint8 qualification flags
          });
        } else expect(grid.surface.groundingEdgeIndexStats).toBeNull();
        expect(grid.surface.matchesGeometry(grid.geometry)).toBe(true);
      } finally {
        grid.dispose();
      }
    },
  );

  it.each([
    {
      target: "owners",
      resolution: 16,
      indexed: false,
      limit: GRASS_GROUNDING_WORKER_LIMITS.maximumCachedSurfaces,
    },
    {
      target: "inputBytes",
      resolution: 256,
      indexed: false,
      limit: GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes,
    },
    {
      target: "derivedBytesReserved",
      resolution: 96,
      indexed: true,
      limit: GRASS_GROUNDING_WORKER_LIMITS.maximumDerivedBytes,
    },
  ] as const)(
    "enforces aggregate $target before admitting one more real surface",
    async ({ target, resolution, indexed, limit }) => {
      const grid = authoredGrid(resolution, indexed);
      try {
        const worker = await actualWorker();
        const next = (
          jobId: number,
          token: number,
        ): GrassGroundingWorkerPrepareSurface => ({
          type: "prepare_surface",
          schemaVersion: 1,
          jobId,
          generation: 1,
          token,
          snapshot: { ...copySurface(grid.surface), nodeId: token },
          consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
        });
        const first = await prepare(worker, next(1, 1));
        expect(first.state.status).toBe("prepared");
        const cost = first.cache[target];
        expect(cost).toBeGreaterThan(0);
        const capacity = Math.floor(limit / cost);
        expect(capacity).toBeGreaterThan(1);
        expect(capacity).toBeLessThanOrEqual(
          GRASS_GROUNDING_WORKER_LIMITS.maximumCachedSurfaces,
        );
        if (target !== "owners")
          expect(capacity).toBeLessThan(
            GRASS_GROUNDING_WORKER_LIMITS.maximumCachedSurfaces,
          );
        let retained = first;
        for (let token = 2; token <= capacity; token++) {
          retained = await prepare(worker, next(token, token));
          expect(retained.state.status).toBe("prepared");
          expect(retained.cache).toEqual({
            owners: token,
            inputBytes: first.cache.inputBytes * token,
            derivedBytesReserved: first.cache.derivedBytesReserved * token,
          });
        }
        const overflow = next(capacity + 1, capacity + 1);
        worker.send(overflow, grassGroundingWorkerInputTransfers(overflow));
        expect(await reply(worker, "rejected", capacity + 1)).toMatchObject({
          reason: "invalid_message",
        });
        worker.send({
          type: "release_surfaces",
          schemaVersion: 1,
          jobId: capacity + 2,
          generation: 1,
          surfaceTokens: [],
        });
        expect(
          (await reply(worker, "surfaces_released", capacity + 2)).cache,
        ).toEqual(retained.cache);
        worker.send({
          type: "release_surfaces",
          schemaVersion: 1,
          jobId: capacity + 3,
          generation: 1,
          surfaceTokens: Array.from({ length: capacity }, (_, i) => i + 1),
        });
        expect(
          (await reply(worker, "surfaces_released", capacity + 3)).cache,
        ).toEqual({ owners: 0, inputBytes: 0, derivedBytesReserved: 0 });
        const recovered = await prepare(
          worker,
          next(capacity + 4, capacity + 1),
        );
        expect(recovered.state.status).toBe("prepared");
        expect(recovered.cache).toEqual(first.cache);
        expect(grid.surface.matchesGeometry(grid.geometry)).toBe(true);
      } finally {
        grid.dispose();
      }
    },
  );
});
