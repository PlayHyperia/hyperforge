import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  GrassGroundingContinuation,
  type GrassBladeGroundingResult,
} from "../GrassBladeGrounding";
import {
  finishGroundedGrassWorkerSteps,
  prepareGroundedGrassSteps,
  type GrassGroundingInputLease,
  type GrassGroundingPublicationLease,
} from "../GrassGroundingPipeline";
import {
  GrassGroundingPreparationContinuation,
  prepareGrassGroundingHandoffSteps,
} from "../GrassGroundingHandoff";
import {
  createSameFaceCase,
  type SameFaceCase,
} from "./fixtures/GrassBladeGroundingSameFaceCases";
import {
  bundleGrassGroundingWorker,
  createActualGroundingWorker,
  createGrassGroundingWorkerRequest,
  grassGroundingWorkerSemanticResult,
  prepareCachedGrassGroundingWorkerRequest,
  runGrassGroundingWorker,
  type ActualGroundingWorker,
} from "./fixtures/GrassGroundingWorkerHarness";

let source = "";
const workers: ActualGroundingWorker[] = [];
const cases: ReturnType<typeof createSameFaceCase>[] = [];
beforeAll(async () => {
  source = (await bundleGrassGroundingWorker()).source;
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const item of cases.splice(0)) item.dispose();
});

function drain<T>(steps: Generator<string, T, void>): T {
  for (let i = 0; i < 1_000_000; i++) {
    const step = steps.next();
    if (step.done) return step.value;
  }
  steps.return(undefined as never);
  throw new Error("Publication fixture exceeded bounded resumptions");
}

async function completed(id: SameFaceCase = "fine-near4", roads = false) {
  const item = createSameFaceCase(id);
  cases.push(item);
  const request = {
    ...item.request,
    ...(roads ? { roadClearance: "per-blade-v1" as const } : {}),
  };
  const inputs = (): GrassGroundingInputLease => ({
    isCurrent: () =>
      item.owned.every(({ surface, geometry }) =>
        surface.matchesGeometry(geometry),
      ),
    steps: (function* () {
      yield "real_test_constraint_lease";
      return {
        terrainSurface: request.terrainSurface,
        roadSegments: [...request.roadSegments],
      };
    })(),
  });
  const getWater = () => request.oceanLevel;
  const excluded = () => false;
  const reference = drain(
    prepareGroundedGrassSteps(request, inputs(), getWater, excluded),
  );
  const inputLease = inputs();
  const preparation = new GrassGroundingPreparationContinuation(
    prepareGrassGroundingHandoffSteps(request, inputLease, getWater, excluded),
    inputLease.isCurrent,
  );
  for (let i = 0; i < 1000 && preparation.state.status === "running"; i++)
    preparation.advance();
  const ready = preparation.state;
  expect(ready.status).toBe("prepared");
  if (ready.status !== "prepared")
    throw new Error("Actual projection did not prepare");
  const prepared = ready.prepared;
  const worker = await createActualGroundingWorker(source);
  workers.push(worker);
  const cold = createGrassGroundingWorkerRequest(request);
  // Fixture copies admit only actual held surfaces. Production preparation
  // supplies all fitting buffers, settings, and the cumulative fitting seed.
  const cached = await prepareCachedGrassGroundingWorkerRequest(worker, cold);
  const packet = {
    ...cached.request,
    geometry: prepared.geometry,
    data: prepared.data,
    settings: prepared.settings,
    constraints: prepared.constraints,
    consumed: {
      operations: preparation.operations,
      activeMs: preparation.activeMs,
      maximumSliceMs: preparation.maximumSliceMs,
    },
  };
  const response = await runGrassGroundingWorker(worker, packet);
  if (
    response.state.status !== "ready" &&
    response.state.status !== "waiting_support"
  )
    throw new Error("Actual fitting failed: " + JSON.stringify(response));
  const result = response.state.result;
  const lease: GrassGroundingPublicationLease = {
    ownSurface: prepared.ownSurface,
    surfaces: prepared.surfaces.map((surface, index) => ({
      token: index + 1,
      surface,
    })),
    grounding: prepared.grounding,
    lod: prepared.settings.lod,
    geometryLayout: prepared.settings.geometryLayout,
    roadClearance: prepared.settings.roadClearance,
  };
  return {
    item,
    request,
    reference,
    result,
    lease,
    response,
    preparation,
    prepared,
    inputLease,
  };
}

function comparable(
  result: GrassBladeGroundingResult,
  request: ReturnType<typeof createSameFaceCase>["request"],
) {
  const semantic = grassGroundingWorkerSemanticResult(result, request);
  return {
    ...semantic,
    ...(result.status === "ready"
      ? {
          grounding: {
            ...result.grounding!,
            computedHeights: Array.from(result.grounding!.computedHeights),
            ecologicalNormals: Array.from(result.grounding!.ecologicalNormals),
          },
        }
      : {}),
  };
}

describe("actual projected worker result publication", () => {
  it.each([
    "ordinary-lod0",
    "ordinary-lod1",
    "ordinary-lod2",
    "fine-near4",
    "fine-lod1",
    "refined-interiors",
    "adjacent-owners",
    "missing-neighbor",
    "overlapping-owners",
    "mixed-exclusions",
    "empty",
  ] satisfies SameFaceCase[])(
    "matches the complete main pipeline: %s",
    async (id) => {
      const row = await completed(id);
      const job = new GrassGroundingContinuation(
        finishGroundedGrassWorkerSteps(row.result, row.lease),
        row.inputLease.isCurrent,
        row.response.work,
      );
      for (let i = 0; i < 1000 && job.state.status === "running"; i++)
        job.advance(7);
      const state = job.state;
      if (state.status !== "ready" && state.status !== "waiting_support")
        throw new Error("Publication failed: " + JSON.stringify(state));
      expect(comparable(state.result, row.request)).toEqual(
        comparable(row.reference, row.request),
      );
      expect(job.operations).toBeGreaterThan(row.response.work.operations);
      expect(job.activeMs).toBeGreaterThanOrEqual(row.response.work.activeMs);
      expect(row.response.work.operations).toBeGreaterThan(
        row.preparation.operations,
      );
      expect(row.prepared.data.offsets.byteLength).toBe(0);
      expect(row.prepared.grounding.computedHeights.length).toBe(
        row.reference.receipt.inputClumps,
      );
      for (const dependency of state.result.dependencies)
        expect(row.request.surfaces.includes(dependency.surface)).toBe(true);
    },
  );

  it("retains actual per-blade road visibility and original owner references", async () => {
    const row = await completed("mixed-exclusions", true);
    const output = drain(finishGroundedGrassWorkerSteps(row.result, row.lease));
    expect(comparable(output, row.request)).toEqual(
      comparable(row.reference, row.request),
    );
    if (output.status !== "ready" || row.result.status !== "ready")
      throw new Error("Expected ready");
    expect(output.rootDeltas).toBe(row.result.rootDeltas);
    expect(output.bladeVisibility).toBe(row.result.bladeVisibility);
    expect(output.grounding).not.toBe(row.lease.grounding);
  });

  it.each(["token", "revision", "duplicate", "uses"] as const)(
    "rejects a changed dependency: %s",
    async (change) => {
      const row = await completed();
      const dependencies = row.result.dependencies;
      expect(dependencies.length).toBeGreaterThan(0);
      if (change === "token") dependencies[0].token = 999;
      if (change === "revision") dependencies[0].sourceRevision += "-retired";
      if (change === "duplicate") dependencies.push({ ...dependencies[0] });
      if (change === "uses") dependencies[0].uses = ["edge", "edge"];
      expect(() =>
        drain(finishGroundedGrassWorkerSteps(row.result, row.lease)),
      ).toThrow(/dependency/);
    },
  );

  it.each([
    "nan",
    "indices",
    "bounds",
    "missing-bound",
    "receipt",
    "visibility",
  ] as const)("rejects corrupted returned output: %s", async (change) => {
    const row = await completed("fine-near4", true);
    if (row.result.status !== "ready") throw new Error("Expected ready");
    expect(row.result.data.count).toBeGreaterThan(0);
    if (change === "nan") row.result.rootDeltas[0] = NaN;
    if (change === "indices") row.result.sourceIndices[0] = 0xffffffff;
    if (change === "bounds") row.result.sweptBounds!.minY = Infinity;
    if (change === "missing-bound")
      Reflect.deleteProperty(row.result.sweptBounds!, "minY");
    if (change === "receipt") row.result.receipt.inputClumps++;
    if (change === "visibility") row.result.bladeVisibility![0] = 0;
    expect(() =>
      drain(finishGroundedGrassWorkerSteps(row.result, row.lease)),
    ).toThrow();
  });

  it("cancels between remap slices when the complete original lease changes", async () => {
    const row = await completed();
    let current = true;
    const job = new GrassGroundingContinuation(
      finishGroundedGrassWorkerSteps(row.result, row.lease),
      () => current,
      row.response.work,
    );
    while (
      job.state.status === "running" &&
      job.lastPhase !== "provenance_remap"
    )
      job.advance(1);
    expect(job.state.status).toBe("running");
    const operations = job.operations;
    current = false;
    expect(job.advance()).toEqual({
      status: "cancelled",
      reason: "invalidated",
    });
    expect(job.operations).toBe(operations);
  });

  it("does not reset the cumulative operation cap before publication", async () => {
    const row = await completed();
    const job = new GrassGroundingContinuation(
      finishGroundedGrassWorkerSteps(row.result, row.lease),
      () => true,
      { operations: 1_000_000, activeMs: 10, maximumSliceMs: 2 },
    );
    expect(job.advance()).toEqual({
      status: "failed_budget",
      reason: "operations",
    });
  });

  it.each([
    "worker_publication_owner",
    "worker_publication_values",
    "provenance_remap",
  ])("rejects a published terrain revision change at %s", async (phase) => {
    const row = await completed();
    const job = new GrassGroundingContinuation(
      finishGroundedGrassWorkerSteps(row.result, row.lease),
      row.inputLease.isCurrent,
      row.response.work,
    );
    while (job.state.status === "running" && job.lastPhase !== phase)
      job.advance(1);
    expect(job.state.status).toBe("running");
    const geometry = row.item.owned[0].geometry;
    const position = geometry.getAttribute("position");
    position.setY(0, position.getY(0) + 0.01);
    position.needsUpdate = true;
    expect(row.inputLease.isCurrent()).toBe(false);
    const operations = job.operations;
    expect(job.advance()).toEqual({
      status: "cancelled",
      reason: "invalidated",
    });
    expect(job.operations).toBe(operations);
  });

  it("exhausts the original operation allowance during real publication", async () => {
    const row = await completed();
    const job = new GrassGroundingContinuation(
      finishGroundedGrassWorkerSteps(row.result, row.lease),
      row.inputLease.isCurrent,
      { operations: 999_997, activeMs: 10, maximumSliceMs: 2 },
    );
    expect(job.advance()).toEqual({
      status: "failed_budget",
      reason: "operations",
    });
    expect(job.operations).toBe(1_000_000);
    expect(job.lastSliceOperations).toBe(3);
  });
});
