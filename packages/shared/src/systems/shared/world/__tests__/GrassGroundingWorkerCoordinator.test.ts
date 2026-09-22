import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createGrassTerrainSurfaceOperations } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import {
  GRASS_GROUNDING_WORKER_LIMITS,
  type GrassGroundingWorkerResponse,
} from "../../../../utils/workers/GrassGroundingWorkerWire";
import {
  captureGrassGroundingFailure,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
  type GrassBladeGroundingResult,
  type GrassGroundingRoadSegment,
} from "../GrassBladeGrounding";
import {
  prepareGroundedGrassSteps,
  type GrassGroundingInputLease,
} from "../GrassGroundingPipeline";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import {
  GrassGroundingWorkerCoordinator,
  type GrassGroundingAdmissionFailure,
  type GrassGroundingFittingFailure,
  type GrassGroundingWorkerJob,
} from "../GrassGroundingWorkerCoordinator";
import { gridGeometry } from "./terrain-grid.fixture";
import {
  createSameFaceCase,
  sameFaceInputHash,
  type SameFaceCase,
} from "./fixtures/GrassBladeGroundingSameFaceCases";
import {
  bundleGrassGroundingWorker,
  grassGroundingWorkerSemanticResult,
} from "./fixtures/GrassGroundingWorkerHarness";
import { ActualGrassGroundingClientPort } from "./fixtures/ActualGrassGroundingClientPort";

type Fixture = ReturnType<typeof createSameFaceCase>;
let bundledSource = "";
const fixtures: Fixture[] = [];
const extraGeometries: ReturnType<typeof gridGeometry>[] = [];
type Session = {
  port: ActualGrassGroundingClientPort;
  owners: Map<RetainedTerrainSurface, ReturnType<typeof gridGeometry>>;
  coordinator: GrassGroundingWorkerCoordinator;
  terminal: Map<number, GrassGroundingWorkerResponse>;
  wait: (jobId: number) => Promise<void>;
  close: () => Promise<void>;
};
const sessions: Session[] = [];

async function session(): Promise<Session> {
  const port = new ActualGrassGroundingClientPort(bundledSource);
  try {
    await port.ready();
  } catch (error) {
    await port.close();
    throw error;
  }
  const owners = new Map<
    RetainedTerrainSurface,
    ReturnType<typeof gridGeometry>
  >();
  const coordinator = new GrassGroundingWorkerCoordinator(port, (surface) => {
    const geometry = owners.get(surface);
    return Boolean(geometry && surface.matchesGeometry(geometry));
  });
  const terminal = new Map<number, GrassGroundingWorkerResponse>();
  const waiting = new Map<
    number,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const observe = (event: MessageEvent<unknown>) => {
    const response = event.data as GrassGroundingWorkerResponse;
    if (response.type === "accepted" || response.jobId === null) return;
    if (terminal.size >= 100)
      throw new Error("Actual coordinator event bound exceeded");
    terminal.set(response.jobId, response);
    const waiter = waiting.get(response.jobId);
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiting.delete(response.jobId);
      waiter.resolve();
    }
  };
  port.addEventListener("message", observe);
  const wait = (jobId: number): Promise<void> => {
    if (terminal.has(jobId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiting.delete(jobId);
        reject(new Error("Actual coordinator response timed out"));
      }, 10_000);
      waiting.set(jobId, { resolve, reject, timeout });
    });
  };
  const value = {
    port,
    owners,
    coordinator,
    terminal,
    wait,
    close: async () => {
      coordinator.destroy();
      port.removeEventListener("message", observe);
      for (const waiter of waiting.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("Coordinator fixture closed"));
      }
      waiting.clear();
      await port.close();
    },
  };
  sessions.push(value);
  return value;
}

function start(value: Session, item: Fixture) {
  for (const { surface, geometry } of item.owned)
    value.owners.set(surface, geometry);
  const lease = sourceLease(item);
  const job = value.coordinator.createJob(
    item.request,
    lease.inputs(),
    lease.getWaterSurfaceAt,
    lease.isExcludedAt,
    lease.current,
  );
  return { job, lease };
}

function assertReservation(value: Session) {
  const receipt = value.coordinator.receipt;
  expect(receipt.reservedOwners).toBeLessThanOrEqual(
    GRASS_GROUNDING_WORKER_LIMITS.maximumCachedSurfaces,
  );
  expect(receipt.reservedInputBytes).toBeLessThanOrEqual(
    GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes,
  );
  expect(receipt.reservedDerivedBytes).toBeLessThanOrEqual(
    GRASS_GROUNDING_WORKER_LIMITS.maximumDerivedBytes,
  );
  expect(receipt.cacheOwners).toBeLessThanOrEqual(
    GRASS_GROUNDING_WORKER_LIMITS.maximumCachedSurfaces,
  );
}

function assertAdmissionFailureShape(failure: GrassGroundingAdmissionFailure) {
  const keys = (value: object, names: readonly string[]) =>
    expect(Reflect.ownKeys(value).sort()).toEqual([...names].sort());
  keys(failure, [
    "schemaVersion",
    "generation",
    "mainPhase",
    "status",
    "reason",
    "owner",
    "submittedWork",
    "response",
    "mergedWork",
  ]);
  keys(failure.owner, [
    "token",
    "nodeId",
    "sourceRevision",
    "centerX",
    "centerZ",
    "size",
    "resolution",
    "inputBytes",
    "derivedBytesReserved",
  ]);
  const workKeys = ["operations", "activeMs", "maximumSliceMs"];
  keys(failure.mergedWork, workKeys);
  if (failure.submittedWork) keys(failure.submittedWork, workKeys);
  if (failure.response) {
    keys(failure.response, [
      "status",
      "reason",
      "phase",
      "work",
      "workBeforeMerge",
      "jobId",
      "generation",
      "dispatchCpuMs",
      "chargedDispatchMs",
      "postMessageCpuMs",
      "receiveCpuMs",
    ]);
    keys(failure.response.workBeforeMerge, workKeys);
    if (failure.response.work) keys(failure.response.work, workKeys);
  }
  assertFrozenScalarDiagnostic(failure, 7);
}

function assertFittingFailureShape(failure: GrassGroundingFittingFailure) {
  const keys = (value: object, names: readonly string[]) =>
    expect(Reflect.ownKeys(value).sort()).toEqual([...names].sort());
  keys(failure, [
    "schemaVersion",
    "scope",
    "generation",
    "status",
    "reason",
    "submittedWork",
    "response",
    "mergedWork",
    ...(failure.workerTiming ? ["workerTiming"] : []),
  ]);
  keys(failure.response, [
    "status",
    "reason",
    "phase",
    "work",
    "workBeforeMerge",
    "jobId",
    "generation",
    "dispatchCpuMs",
    "chargedDispatchMs",
    "postMessageCpuMs",
    "receiveCpuMs",
  ]);
  const workKeys = ["operations", "activeMs", "maximumSliceMs"];
  keys(failure.submittedWork, workKeys);
  keys(failure.mergedWork, workKeys);
  keys(failure.response.workBeforeMerge, workKeys);
  if (!failure.response.work) throw new Error("Missing real fitting work");
  keys(failure.response.work, workKeys);
  if (failure.workerTiming) {
    keys(failure.workerTiming, [
      "timeBasis",
      "scope",
      "peakSlice",
      "peakClockInterval",
    ]);
    for (const span of [
      failure.workerTiming.peakSlice,
      failure.workerTiming.peakClockInterval,
    ])
      if (span)
        keys(span, [
          "elapsedMs",
          "startOperations",
          "endOperations",
          "startPhase",
          "endPhase",
        ]);
  }
  assertFrozenScalarDiagnostic(failure, failure.workerTiming ? 9 : 6);
}

function assertFrozenScalarDiagnostic(failure: object, maximumObjects: number) {
  // Reject all retained classes, buffers, collections, arrays and accessors;
  // the exact schema above bounds the graph, not only its serialized size.
  let objects = 0;
  const visit = (value: unknown): void => {
    if (value === null) return;
    if (typeof value === "string") {
      expect(value.length).toBeLessThanOrEqual(256);
      return;
    }
    if (typeof value === "number") {
      expect(Number.isFinite(value)).toBe(true);
      return;
    }
    expect(typeof value).toBe("object");
    if (typeof value !== "object") throw new Error("Non-scalar diagnostic");
    expect(++objects).toBeLessThanOrEqual(maximumObjects);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.isFrozen(value)).toBe(true);
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      expect("value" in descriptor).toBe(true);
      expect(descriptor.enumerable).toBe(true);
      expect(descriptor.writable).toBe(false);
      expect(descriptor.configurable).toBe(false);
      visit(descriptor.value);
    }
  };
  visit(failure);
}

async function finish(value: Session, job: GrassGroundingWorkerJob) {
  for (let i = 0; i < 100_000; i++) {
    if (job.state.status !== "running") return job.state;
    job.advance();
    assertReservation(value);
    const remoteId = value.coordinator.receipt.transportJobId;
    if (remoteId !== null) await value.wait(remoteId);
  }
  throw new Error(
    "Actual coordinator job did not finish within bounded advances",
  );
}

async function atPhase(
  value: Session,
  job: GrassGroundingWorkerJob,
  phase: GrassGroundingWorkerJob["phase"],
) {
  for (let i = 0; i < 100_000; i++) {
    if (job.phase === phase) return;
    if (job.state.status !== "running")
      throw new Error("Coordinator ended before " + phase);
    job.advance(1);
    const remoteId = value.coordinator.receipt.transportJobId;
    if (job.phase !== phase && remoteId !== null) await value.wait(remoteId);
  }
  throw new Error("Actual coordinator phase was not reached: " + phase);
}

async function atLabel(
  value: Session,
  job: GrassGroundingWorkerJob,
  label: string,
) {
  for (let i = 0; i < 100_000; i++) {
    if (job.lastPhase === label) return;
    if (job.state.status !== "running")
      throw new Error("Coordinator ended before " + label);
    job.advance(1);
    const remoteId = value.coordinator.receipt.transportJobId;
    if (job.lastPhase !== label && remoteId !== null)
      await value.wait(remoteId);
  }
  throw new Error("Actual coordinator phase label was not reached: " + label);
}

function fixture(id: SameFaceCase = "fine-lod1") {
  const value = createSameFaceCase(id);
  fixtures.push(value);
  return value;
}

/** Authored live-world inputs; real geometry versions and actual region-list
 * edits invalidate a captured lease. No terrain/query/worker methods are replaced. */
function sourceLease(item: Fixture) {
  const captured = [...item.request.surfaces];
  const geometryOwners = [...item.owned];
  const current = () =>
    captured.length === item.request.surfaces.length &&
    captured.every(
      (surface, index) => surface === item.request.surfaces[index],
    ) &&
    geometryOwners.every(({ surface, geometry }) =>
      surface.matchesGeometry(geometry),
    );
  const inputs = (): GrassGroundingInputLease => ({
    isCurrent: current,
    steps: (function* () {
      const terrainSurface =
        yield* createGrassTerrainSurfaceOperations().cloneSnapshotSteps(
          item.request.terrainSurface,
        );
      const roadSegments: GrassGroundingRoadSegment[] = [];
      for (const road of item.request.roadSegments) {
        yield "coordinator_test_road_copy";
        roadSegments.push({ ...road });
      }
      return { terrainSurface, roadSegments };
    })(),
  });
  return {
    current,
    inputs,
    getWaterSurfaceAt: () => item.request.oceanLevel,
    isExcludedAt: () => false,
  };
}

function drain<T>(steps: Generator<string, T, void>): T {
  for (let i = 0; i < 1_000_000; i++) {
    const step = steps.next();
    if (step.done) return step.value;
  }
  steps.return(undefined as never);
  throw new Error("Actual coordinator reference exceeded operation bound");
}

function expected(item: Fixture, lease = sourceLease(item)) {
  return drain(
    prepareGroundedGrassSteps(
      item.request,
      lease.inputs(),
      lease.getWaterSurfaceAt,
      lease.isExcludedAt,
    ),
  );
}

function bytes(array: ArrayBufferView) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString(
    "hex",
  );
}

function comparable(result: GrassBladeGroundingResult, item: Fixture) {
  return {
    ...grassGroundingWorkerSemanticResult(result, item.request),
    ...(result.status === "ready"
      ? {
          grounding: {
            ...result.grounding,
            computedHeights: bytes(result.grounding!.computedHeights),
            ecologicalNormals: bytes(result.grounding!.ecologicalNormals),
          },
        }
      : {}),
  };
}

function freshOwner(item: Fixture, id: number, resolution = 16) {
  const geometry = gridGeometry(100, resolution, () => 20);
  extraGeometries.push(geometry);
  const surface = new RetainedTerrainSurface(
    id,
    item.request.ownSurface.terrainProfileIdentity,
    0,
    0,
    100,
    resolution,
    geometry,
  );
  item.request.ownSurface = surface;
  item.request.surfaces = [surface];
  item.owned.splice(0, item.owned.length, { surface, geometry });
  return { surface, geometry };
}

beforeAll(async () => {
  bundledSource = (await bundleGrassGroundingWorker()).source;
});
afterEach(async () => {
  for (const value of sessions.splice(0)) await value.close();
  for (const item of fixtures.splice(0)) item.dispose();
  for (const geometry of extraGeometries.splice(0)) geometry.dispose();
});

describe("actual retained-terrain grounding worker coordinator", () => {
  it.each<SameFaceCase>([
    "ordinary-lod1",
    "fine-near4",
    "refined-interiors",
    "adjacent-reversed",
    "missing-neighbor",
    "overlapping-owners",
    "mixed-exclusions",
    "empty",
  ])(
    "matches complete projected %s output and reuses exact source owners across full jobs",
    async (id) => {
      const item = fixture(id),
        value = await session();
      for (let i = 0; i < item.request.data.count; i++) {
        item.request.data.offsets[i * 3 + 1] = 30.25 + i;
        item.request.data.groundNormals.set([0.6, 0.8, 0], i * 3);
      }
      const original = sameFaceInputHash(item),
        reference = expected(item);
      let previousGeneration: number | null = null;
      for (let pass = 0; pass < 2; pass++) {
        const { job } = start(value, item);
        const result = await finish(value, job);
        if (result.status !== "ready" && result.status !== "waiting_support")
          throw new Error(
            `Actual coordinator failed: ${JSON.stringify(result)}`,
          );
        expect(comparable(result.result, item)).toEqual(
          comparable(reference, item),
        );
        for (const dependency of result.result.dependencies)
          expect(item.request.surfaces.includes(dependency.surface)).toBe(true);
        expect(job.operations).toBeGreaterThan(0);
        expect(job.operations).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
        );
        expect(job.activeMs).toBeGreaterThanOrEqual(0);
        const fits = [...value.terminal.values()].filter(
          (response) => response.type === "result",
        );
        const fit = fits[fits.length - 1];
        if (!fit || fit.type !== "result")
          throw new Error("Missing actual fitting receipt");
        expect(fit.terrainRebuildWork).toBeNull();
        expect(job.operations).toBeGreaterThan(fit.work.operations);
        expect(job.activeMs).toBeGreaterThanOrEqual(fit.work.activeMs);
        expect(result.result.receipt.elapsedMs).toBe(job.activeMs);
        if (previousGeneration !== null)
          expect(fit.generation).toBeGreaterThan(previousGeneration);
        previousGeneration = fit.generation;
        const receipt = value.coordinator.receipt;
        expect(
          Object.prototype.hasOwnProperty.call(receipt, "lastFittingFailure"),
        ).toBe(false);
        expect(receipt.preparedOwners).toBe(item.request.surfaces.length);
        expect(
          [...value.terminal.values()].filter(
            (response) => response.type === "surface_prepared",
          ),
        ).toHaveLength(item.request.surfaces.length);
        if (pass === 1)
          expect(receipt.cacheHits).toBeGreaterThanOrEqual(
            item.request.surfaces.length,
          );
        expect(sameFaceInputHash(item)).toBe(original);
      }
    },
  );

  it("keeps only one active handoff and makes a second lightweight job wait without copying or dispatching", async () => {
    const item = fixture(),
      value = await session();
    const first = start(value, item).job,
      second = start(value, item).job;
    first.advance(1);
    expect(value.coordinator.activeJob).toBe(first);
    const calls = value.port.postCalls,
      receipt = value.coordinator.receipt;
    for (let i = 0; i < 5; i++) second.advance(1);
    expect(second.state.status).toBe("running");
    expect(second.operations).toBe(0);
    expect(value.port.postCalls).toBe(calls);
    expect(value.coordinator.receipt.preparedOwners).toBe(
      receipt.preparedOwners,
    );
    expect(value.coordinator.activeJob).toBe(first);
    expect((await finish(value, first)).status).toBe("ready");
    expect((await finish(value, second)).status).toBe("ready");
    expect(value.coordinator.receipt.preparedOwners).toBe(1);
  });

  it.each(["position", "index", "region"] as const)(
    "rejects live %s invalidation before source-copy publication",
    async (kind) => {
      const item = fixture(),
        value = await session(),
        { job } = start(value, item);
      // Position payload is actually copied; index allocation has not started.
      await atLabel(value, job, "snapshot-index-allocation");
      expect(job.phase).toBe("preparing");
      if (kind === "position")
        item.owned[0].geometry.getAttribute("position").needsUpdate = true;
      if (kind === "index")
        item.owned[0].geometry.getIndex()!.needsUpdate = true;
      if (kind === "region") {
        const neighbor = fixture("ordinary-lod1");
        item.request.surfaces = [
          ...item.request.surfaces,
          neighbor.request.ownSurface,
        ];
      }
      const result = await finish(value, job);
      expect(result.status).toBe("cancelled");
      expect(value.port.postCalls).toBe(0);
      expect(value.coordinator.receipt.preparedOwners).toBe(0);
      expect(value.coordinator.receipt.lastAdmissionFailure).toBeNull();
      const terminal = job.state,
        operations = job.operations;
      job.advance();
      expect(job.state).toBe(terminal);
      expect(job.operations).toBe(operations);
      expect(value.coordinator.receipt.lastAdmissionFailure).toBeNull();
    },
  );

  it("detects blade version changes between real handoff copy steps after caching terrain", async () => {
    const item = fixture(),
      value = await session(),
      { job } = start(value, item);
    await atLabel(value, job, "handoff_geometry_position_copy");
    expect(job.lastPhase).toBe("handoff_geometry_position_copy");
    item.request.geometry.getAttribute("position").needsUpdate = true;
    const result = await finish(value, job);
    expect(["failed_input", "cancelled"]).toContain(result.status);
    expect(
      [...value.terminal.values()].filter(
        (response) => response.type === "result",
      ),
    ).toHaveLength(0);
    expect(value.coordinator.receipt.preparedOwners).toBe(1);
  });

  it("cancels in-flight work on a changed region and cannot let an old job clear or publish its replacement", async () => {
    const item = fixture("fine-dense-nonplanar"),
      value = await session();
    const old = start(value, item).job;
    await atLabel(value, old, "worker_fit_dispatch");
    const oldId = old.transportJobId;
    if (oldId === null) throw new Error("Expected actual remote fitting");
    const neighbor = fixture("ordinary-lod1");
    item.request.surfaces = [
      ...item.request.surfaces,
      neighbor.request.ownSurface,
    ];
    old.advance(1);
    expect(old.state.status).toBe("cancelled");
    const replacementItem = fixture("ordinary-lod1");
    const replacement = start(value, replacementItem).job;
    replacement.advance(1);
    expect(replacement.operations).toBe(0);
    const calls = value.port.postCalls;
    old.advance();
    old.cancel();
    expect(value.port.postCalls).toBe(calls);
    await value.wait(oldId);
    value.coordinator.advanceMaintenance();
    const replaced = await finish(value, replacement);
    expect(replaced.status).toBe("ready");
    const replacementState = replacement.state;
    old.advance();
    value.coordinator.advanceMaintenance();
    expect(replacement.state).toBe(replacementState);
    expect(old.state.status).toBe("cancelled");
    const fits = [...value.terminal.values()].filter(
      (response) => response.type === "result",
    );
    expect(fits).toHaveLength(2);
    expect(fits[1].jobId).toBeGreaterThan(oldId);
    expect(fits[1].generation).toBeGreaterThan(fits[0].generation!);
  });

  it("cancels a completed remote result before remap when a live terrain version changes", async () => {
    const item = fixture(),
      value = await session(),
      { job } = start(value, item);
    await atLabel(value, job, "worker_fit_dispatch");
    const id = job.transportJobId;
    if (id === null) throw new Error("Missing fit identity");
    await value.wait(id);
    item.owned[0].geometry.getAttribute("position").needsUpdate = true;
    job.advance(1);
    expect(job.state.status).toBe("cancelled");
    expect(value.coordinator.receipt.lastFittingFailure).toBeUndefined();
    const terminal = job.state;
    value.coordinator.advanceMaintenance();
    job.advance();
    expect(job.state).toBe(terminal);
  });

  it("releases an invalid cached owner through an actual idle maintenance acknowledgement", async () => {
    const item = fixture(),
      value = await session(),
      { job } = start(value, item);
    expect((await finish(value, job)).status).toBe("ready");
    expect(value.coordinator.receipt.cacheOwners).toBe(1);
    item.owned[0].geometry.getAttribute("position").needsUpdate = true;
    for (
      let i = 0;
      i < 1000 && value.coordinator.receipt.transportJobId === null;
      i++
    )
      value.coordinator.advanceMaintenance();
    const releaseId = value.coordinator.receipt.transportJobId;
    if (releaseId === null)
      throw new Error("Expected explicit stale-owner release");
    const response = await value.port.waitFor("surfaces_released", releaseId);
    expect(response.cache.owners).toBe(0);
    value.coordinator.advanceMaintenance();
    expect(value.coordinator.receipt.cacheOwners).toBe(0);
    expect(value.coordinator.receipt.releasedOwners).toBe(1);
  });

  it.each(["owners", "input-bytes"] as const)(
    "evicts real least-recently used sources before %s capacity would be exceeded",
    async (limit) => {
      const item = fixture("ordinary-lod2"),
        value = await session();
      const resolution = limit === "owners" ? 16 : 256;
      const first = freshOwner(item, 1001, resolution);
      const capacity =
        limit === "owners"
          ? GRASS_GROUNDING_WORKER_LIMITS.maximumCachedSurfaces
          : Math.floor(
              (GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes - 2048) /
                first.surface.snapshotByteLength(),
            );
      expect(capacity).toBeGreaterThan(1);
      expect(capacity).toBeLessThanOrEqual(16);
      for (let i = 0; i <= capacity; i++) {
        if (i > 0) freshOwner(item, 1001 + i, resolution);
        const { job } = start(value, item);
        job.advance(1);
        assertReservation(value);
        expect((await finish(value, job)).status).toBe("ready");
        assertReservation(value);
      }
      const receipt = value.coordinator.receipt;
      expect(receipt.preparedOwners).toBe(capacity + 1);
      expect(receipt.releasedOwners).toBeGreaterThanOrEqual(1);
      expect(receipt.cacheOwners).toBe(capacity);
      const releases = [...value.terminal.values()].filter(
        (response) => response.type === "surfaces_released",
      );
      expect(releases.length).toBeGreaterThanOrEqual(1);
      const preparedBeforeReuse = receipt.preparedOwners;
      expect((await finish(value, start(value, item).job)).status).toBe(
        "ready",
      );
      expect(value.coordinator.receipt.preparedOwners).toBe(
        preparedBeforeReuse,
      );
      // The oldest owner was displaced, despite its geometry still being current.
      item.request.ownSurface = first.surface;
      item.request.surfaces = [first.surface];
      item.owned.splice(0, item.owned.length, first);
      expect((await finish(value, start(value, item).job)).status).toBe(
        "ready",
      );
      expect(value.coordinator.receipt.preparedOwners).toBe(
        preparedBeforeReuse + 1,
      );
    },
  );

  it("keeps genuine geometric-work failure stable without automatic fitting retries", async () => {
    const item = fixture(),
      value = await session();
    item.request.workBudget = 1;
    const { job } = start(value, item);
    const state = await finish(value, job);
    expect(state).toEqual({
      status: "failed_budget",
      reason: "grounding_work",
    });
    const surface = item.request.ownSurface;
    const failure = captureGrassGroundingFailure(job, {
      key: "actual-coordinator-failure",
      nodeId: surface.nodeId,
      lod: item.request.lod,
      isLodSwap: false,
      bounds: {
        minX: surface.centerX - surface.size / 2,
        maxX: surface.centerX + surface.size / 2,
        minZ: surface.centerZ - surface.size / 2,
        maxZ: surface.centerZ + surface.size / 2,
      },
    });
    expect(failure?.observation?.cumulativeMaximumSliceMs).toBe(
      job.cumulativeMaximumSliceMs,
    );
    expect(failure?.maximumSliceMs).toBe(job.maximumSliceMs);
    const calls = value.port.postCalls,
      operations = job.operations,
      activeMs = job.activeMs,
      cumulativeMaximum = job.cumulativeMaximumSliceMs;
    for (let i = 0; i < 10; i++) {
      job.advance();
      value.coordinator.advanceMaintenance();
    }
    expect(job.state).toBe(state);
    expect(job.operations).toBe(operations);
    expect(job.activeMs).toBe(activeMs);
    expect(job.cumulativeMaximumSliceMs).toBe(cumulativeMaximum);
    expect(value.port.postCalls).toBe(calls);
  });

  it("captures only the actual failed fitting settlement with exact elapsed-work decomposition", async () => {
    const item = fixture(),
      value = await session(),
      originalBudget = item.request.workBudget;
    expect(
      Object.prototype.hasOwnProperty.call(
        value.coordinator.receipt,
        "lastFittingFailure",
      ),
    ).toBe(false);
    // The actual worker exhausts its real geometric-work allowance. No clock,
    // response, cap constant or transport is replaced to manufacture a failure.
    item.request.workBudget = 1;
    const { job } = start(value, item);
    await atLabel(value, job, "worker_fit_dispatch");
    const id = job.transportJobId;
    if (id === null) throw new Error("Missing actual fitting dispatch");
    await value.wait(id);
    const response = value.terminal.get(id);
    if (!response || response.type !== "result")
      throw new Error("Missing actual worker result");
    expect(response.state).toEqual({
      status: "failed_budget",
      reason: "grounding_work",
    });
    // Receiving alone does not settle the coordinator or invent a diagnostic.
    expect(value.coordinator.receipt.lastFittingFailure).toBeUndefined();
    const before = {
      operations: job.operations,
      activeMs: job.activeMs,
      maximumSliceMs: job.cumulativeMaximumSliceMs,
    };
    const state = job.advance();
    expect(state).toEqual(response.state);
    const failure = value.coordinator.receipt.lastFittingFailure;
    if (!failure) throw new Error("Missing failed fitting settlement");
    assertFittingFailureShape(failure);
    expect(failure.schemaVersion).toBe(1);
    expect(failure.scope).toBe("settlement_before_main_supervision_tail");
    expect(failure.generation).toBe(response.generation);
    expect(failure.status).toBe("failed_budget");
    expect(failure.reason).toBe("grounding_work");
    expect(failure.response.status).toBe(response.state.status);
    expect(failure.response.reason).toBe("grounding_work");
    expect(failure.response.phase).toBe(response.lastPhase);
    expect(response.timing?.timeBasis).toBe(
      "slice-elapsed-including-preemption",
    );
    expect(failure.workerTiming).toEqual(response.timing);
    expect(failure.workerTiming).not.toBe(response.timing);
    expect(failure.workerTiming?.peakSlice).not.toBe(
      response.timing?.peakSlice,
    );
    expect(failure.workerTiming?.peakClockInterval).not.toBe(
      response.timing?.peakClockInterval,
    );
    expect(failure.response.jobId).toBe(id);
    expect(failure.response.generation).toBe(response.generation);
    expect(failure.response.work).toEqual(response.work);
    expect(failure.response.work).not.toBe(response.work);
    expect(failure.response.workBeforeMerge).toEqual(before);
    const submitted = failure.submittedWork,
      transport = failure.response;
    expect(submitted.operations).toBeGreaterThan(0);
    expect(response.work.operations).toBeGreaterThan(submitted.operations);
    expect(submitted.activeMs).toBeLessThanOrEqual(before.activeMs);
    expect(failure.mergedWork.operations).toBe(
      response.work.operations + (before.operations - submitted.operations),
    );
    expect(failure.mergedWork.activeMs).toBe(
      response.work.activeMs +
        (before.activeMs - submitted.activeMs) +
        Math.max(0, transport.dispatchCpuMs - transport.chargedDispatchMs) +
        transport.receiveCpuMs,
    );
    expect(failure.mergedWork.maximumSliceMs).toBe(
      Math.max(
        before.maximumSliceMs,
        response.work.maximumSliceMs,
        transport.dispatchCpuMs,
        transport.receiveCpuMs,
      ),
    );
    expect(transport.dispatchCpuMs).toBeGreaterThanOrEqual(
      transport.postMessageCpuMs,
    );
    for (const cost of [
      transport.dispatchCpuMs,
      transport.chargedDispatchMs,
      transport.postMessageCpuMs,
      transport.receiveCpuMs,
    ])
      expect(cost).toBeGreaterThanOrEqual(0);
    // The failed settlement snapshot intentionally precedes the real outer
    // advance's final accounting; it must not masquerade as the final total.
    expect(job.operations).toBe(
      failure.mergedWork.operations + job.lastSliceOperations,
    );
    expect(job.activeMs).toBe(failure.mergedWork.activeMs + job.lastSliceMs);
    expect(job.cumulativeMaximumSliceMs).toBe(
      Math.max(failure.mergedWork.maximumSliceMs, job.lastSliceMs),
    );
    expect(value.coordinator.receipt.lastAdmissionFailure).toBeNull();
    const calls = value.port.postCalls,
      serialized = JSON.stringify(failure),
      finalWork = [job.operations, job.activeMs, job.cumulativeMaximumSliceMs];
    for (let i = 0; i < 5; i++) {
      job.advance();
      value.coordinator.advanceMaintenance();
    }
    expect(job.state).toBe(state);
    expect(value.port.postCalls).toBe(calls);
    expect([
      job.operations,
      job.activeMs,
      job.cumulativeMaximumSliceMs,
    ]).toEqual(finalWork);
    // A distinct, explicitly submitted successful job cannot clear or replace
    // historical failure evidence. It is not an automatic retry of the failure.
    if (originalBudget === undefined) delete item.request.workBudget;
    else item.request.workBudget = originalBudget;
    expect((await finish(value, start(value, item).job)).status).toBe("ready");
    expect(value.coordinator.receipt.lastFittingFailure).toBe(failure);
    value.coordinator.destroy();
    expect(value.coordinator.receipt.reservedInputBytes).toBe(0);
    expect(value.coordinator.receipt.lastFittingFailure).toBe(failure);
    expect(JSON.stringify(failure)).toBe(serialized);
    assertFittingFailureShape(failure);
  });

  it("retains the exact real-worker admission failure through cached-owner propagation without input references", async () => {
    const item = fixture(),
      value = await session(),
      { surface, geometry } = item.owned[0],
      positions = geometry.getAttribute("position").array,
      originalHeight = positions[1];
    expect(value.coordinator.receipt.lastAdmissionFailure).toBeNull();
    // Deliberately malformed unannounced source data is outside the live
    // version lease guarantee. No methods or clocks are replaced: the actual
    // worker must reject its actual copied geometry during strict re-admission.
    positions[1] = NaN;
    expect(surface.matchesGeometry(geometry)).toBe(true);
    const { job } = start(value, item);
    const state = await finish(value, job);
    expect(state.status).toBe("failed_input");
    expect(value.coordinator.receipt.lastFittingFailure).toBeUndefined();
    expect(job.operations).toBe(0);
    expect(job.activeMs).toBe(0);
    const responses = [...value.terminal.values()];
    expect(responses).toHaveLength(1);
    const response = responses[0];
    if (response.type !== "surface_prepared")
      throw new Error("Malformed terrain never reached worker re-admission");
    expect(response.state.status).toBe("failed_input");
    expect(response.lastPhase).toBe("grid");
    const failure = value.coordinator.receipt.lastAdmissionFailure;
    if (!failure || !failure.response || !failure.submittedWork)
      throw new Error("Missing terminal terrain-admission diagnostic");
    assertAdmissionFailureShape(failure);
    expect(failure.schemaVersion).toBe(1);
    expect(failure.generation).toBe(response.generation);
    expect(failure.mainPhase).toBe("worker_surface_dispatch");
    expect(failure.status).toBe("failed_input");
    expect(failure.reason).toBeNull();
    expect(failure.owner).toEqual({
      token: 1,
      nodeId: surface.nodeId,
      sourceRevision: surface.revision.slice(0, 256),
      centerX: surface.centerX,
      centerZ: surface.centerZ,
      size: surface.size,
      resolution: surface.resolution,
      inputBytes: surface.snapshotByteLength(),
      derivedBytesReserved: response.derivedBytesReserved,
    });
    expect(failure.owner).not.toBe(surface);
    expect(failure.response.status).toBe(response.state.status);
    expect(failure.response.reason).toBeNull();
    expect(failure.response.phase).toBe(response.lastPhase);
    expect(failure.response.jobId).toBe(response.jobId);
    expect(failure.response.generation).toBe(response.generation);
    expect(failure.response.work).toEqual(response.work);
    expect(failure.response.work).not.toBe(response.work);
    expect(failure.submittedWork.operations).toBeGreaterThan(0);
    expect(response.work.operations).toBeGreaterThan(
      failure.submittedWork.operations,
    );
    const before = failure.response.workBeforeMerge,
      submitted = failure.submittedWork,
      transport = failure.response;
    expect(failure.mergedWork.operations).toBe(
      response.work.operations +
        (before.operations - submitted.operations) +
        job.lastSliceOperations,
    );
    expect(failure.mergedWork.activeMs).toBe(
      response.work.activeMs +
        (before.activeMs - submitted.activeMs) +
        Math.max(0, transport.dispatchCpuMs - transport.chargedDispatchMs) +
        transport.receiveCpuMs +
        job.lastSliceMs,
    );
    expect(failure.mergedWork.maximumSliceMs).toBe(
      Math.max(
        before.maximumSliceMs,
        response.work.maximumSliceMs,
        transport.dispatchCpuMs,
        transport.receiveCpuMs,
        job.lastSliceMs,
      ),
    );
    expect(transport.dispatchCpuMs).toBeGreaterThanOrEqual(
      transport.postMessageCpuMs,
    );
    expect(value.coordinator.receipt.cacheOwners).toBe(0);
    expect(value.coordinator.receipt.reservedOwners).toBe(0);
    expect(value.coordinator.receipt.preparedOwners).toBe(0);
    expect(value.coordinator.receipt.terminated).toBe(false);
    // Even after repairing the scalar, this exact failed owner must not retry
    // or replace the original receipt with a zero-work cache-propagation row.
    positions[1] = originalHeight;
    const calls = value.port.postCalls,
      serialized = JSON.stringify(failure),
      replacement = start(value, item).job;
    expect((await finish(value, replacement)).status).toBe("failed_input");
    expect(replacement.lastPhase).toBe("worker_cache_admission");
    expect(value.port.postCalls).toBe(calls);
    expect(value.coordinator.receipt.lastAdmissionFailure).toBe(failure);
    for (let i = 0; i < 5; i++) {
      job.advance();
      replacement.advance();
      value.coordinator.advanceMaintenance();
      expect(value.coordinator.receipt.lastAdmissionFailure).toBe(failure);
    }
    expect(JSON.stringify(failure)).toBe(serialized);
    expect(value.terminal.size).toBe(1);
    expect(value.port.postCalls).toBe(calls);
    assertAdmissionFailureShape(failure);
  });

  it.each(["owners", "input-bytes"] as const)(
    "rejects an intrinsically oversized %s region before copying or dispatch",
    async (limit) => {
      const item = fixture("ordinary-lod2"),
        value = await session();
      const count = limit === "owners" ? 17 : 8,
        resolution = limit === "owners" ? 16 : 256;
      const region = Array.from({ length: count }, (_, i) =>
        freshOwner(item, 2001 + i, resolution),
      );
      item.request.ownSurface = region[0].surface;
      item.request.surfaces = region.map(({ surface }) => surface);
      item.owned.splice(0, item.owned.length, ...region);
      if (limit === "input-bytes")
        expect(
          region.reduce(
            (total, { surface }) => total + surface.snapshotByteLength(),
            0,
          ),
        ).toBeGreaterThan(GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes);
      const { job } = start(value, item);
      expect((await finish(value, job)).status).toBe("failed_input");
      expect(value.port.postCalls).toBe(0);
      expect(value.coordinator.receipt.preparedOwners).toBe(0);
      // One metadata preflight operation is charged; no snapshot resumptions.
      expect(value.coordinator.receipt.admissionOperations).toBe(1);
      expect(job.lastPhase).toBe("worker_cache_admission");
      expect(value.coordinator.receipt.reservedInputBytes).toBe(0);
    },
  );

  it("retains original cumulative fitting limits across projection, worker fitting and publication", async () => {
    const item = fixture("fine-near4"),
      value = await session(),
      { job } = start(value, item);
    await atLabel(value, job, "worker_fit_dispatch");
    const projectedOperations = job.operations,
      projectedActiveMs = job.activeMs;
    expect(projectedOperations).toBeGreaterThan(0);
    await atPhase(value, job, "remapping");
    expect(job.operations).toBeGreaterThan(projectedOperations);
    expect(job.activeMs).toBeGreaterThanOrEqual(projectedActiveMs);
    const remoteOperations = job.operations,
      remoteActiveMs = job.activeMs;
    const state = await finish(value, job);
    expect(state.status).toBe("ready");
    expect(job.operations).toBeGreaterThan(remoteOperations);
    expect(job.activeMs).toBeGreaterThanOrEqual(remoteActiveMs);
    expect(job.operations).toBeLessThanOrEqual(
      GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
    );
    expect(job.activeMs).toBeLessThan(
      GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
    );
  });

  it("passively exposes cumulative fitting slice maxima without replacing main-thread advance maxima", async () => {
    const item = fixture("fine-near4"),
      value = await session();
    for (let pass = 0; pass < 2; pass++) {
      const { job } = start(value, item);
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(job),
        "cumulativeMaximumSliceMs",
      );
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      expect(job.cumulativeMaximumSliceMs).toBe(0);
      expect(job.maximumSliceMs).toBe(0);
      let mainMaximum = 0;
      let workerMaximum: number | null = null;
      let settledMaximum: number | null = null;
      let remappingSlices = 0;
      const observe = () => {
        const before = {
          state: job.state,
          phase: job.phase,
          lastPhase: job.lastPhase,
          operations: job.operations,
          activeMs: job.activeMs,
          lastSliceOperations: job.lastSliceOperations,
          lastSliceMs: job.lastSliceMs,
          maximumSliceMs: job.maximumSliceMs,
          transportJobId: job.transportJobId,
        };
        const receipt = value.coordinator.receipt;
        const calls = value.port.postCalls;
        const responses = value.terminal.size;
        const maximum = job.cumulativeMaximumSliceMs;
        for (let read = 0; read < 16; read++)
          expect(job.cumulativeMaximumSliceMs).toBe(maximum);
        expect(job.state).toBe(before.state);
        expect({
          state: job.state,
          phase: job.phase,
          lastPhase: job.lastPhase,
          operations: job.operations,
          activeMs: job.activeMs,
          lastSliceOperations: job.lastSliceOperations,
          lastSliceMs: job.lastSliceMs,
          maximumSliceMs: job.maximumSliceMs,
          transportJobId: job.transportJobId,
        }).toEqual(before);
        expect(value.coordinator.receipt).toEqual(receipt);
        expect(value.port.postCalls).toBe(calls);
        expect(value.terminal.size).toBe(responses);
      };
      observe();
      for (let advance = 0; advance < 100_000; advance++) {
        if (job.state.status !== "running") break;
        const beforePhase = job.phase;
        const beforeMaximum = job.cumulativeMaximumSliceMs;
        job.advance(1);
        mainMaximum = Math.max(mainMaximum, job.lastSliceMs);
        expect(job.maximumSliceMs).toBe(mainMaximum);
        expect(job.cumulativeMaximumSliceMs).toBeGreaterThanOrEqual(
          beforeMaximum,
        );
        if (beforePhase === "remapping") {
          remappingSlices++;
          // No remote work remains: publication's nested slice lies inside
          // this actual main advance and is charged only once by its owner.
          expect(job.cumulativeMaximumSliceMs).toBe(
            Math.max(beforeMaximum, job.lastSliceMs),
          );
        }
        if (job.phase === "remapping" && settledMaximum === null) {
          if (workerMaximum === null)
            throw new Error("Remapping began without an actual worker receipt");
          settledMaximum = job.cumulativeMaximumSliceMs;
          expect(settledMaximum).toBeGreaterThanOrEqual(workerMaximum);
          expect(settledMaximum).toBeGreaterThanOrEqual(job.lastSliceMs);
        }
        if (job.phase !== beforePhase) observe();
        const remoteId = job.transportJobId;
        if (remoteId !== null) {
          const beforeReceiveMaximum = job.cumulativeMaximumSliceMs;
          await value.wait(remoteId);
          const response = value.terminal.get(remoteId);
          if (!response) throw new Error("Missing actual worker response");
          if (response.type === "result")
            workerMaximum = response.work.maximumSliceMs;
          // Receiving does not advance this job or merge a pending ledger.
          expect(job.cumulativeMaximumSliceMs).toBe(beforeReceiveMaximum);
          expect(job.maximumSliceMs).toBe(mainMaximum);
          observe();
        }
      }
      expect(job.state.status).toBe("ready");
      if (workerMaximum === null)
        throw new Error("Actual fitting maximum was never observed");
      expect(settledMaximum).not.toBeNull();
      expect(remappingSlices).toBeGreaterThan(0);
      expect(job.cumulativeMaximumSliceMs).toBeGreaterThanOrEqual(
        workerMaximum,
      );
      expect(job.cumulativeMaximumSliceMs).toBeLessThanOrEqual(job.activeMs);
      expect(job.maximumSliceMs).toBe(mainMaximum);
      observe();
      if (pass === 1)
        expect(value.coordinator.receipt.cacheHits).toBeGreaterThanOrEqual(
          item.request.surfaces.length,
        );
    }
  });

  it("fails closed after actual worker death without relaunching or retrying", async () => {
    const item = fixture("fine-dense-nonplanar"),
      value = await session(),
      { job } = start(value, item);
    await atLabel(value, job, "worker_fit_dispatch");
    await value.port.terminateUnexpectedly();
    job.advance(1);
    expect(job.state.status).toBe("failed_input");
    expect(value.coordinator.receipt.lastFittingFailure).toBeUndefined();
    expect(value.coordinator.receipt.terminated).toBe(true);
    const state = job.state,
      calls = value.port.postCalls;
    for (let i = 0; i < 5; i++) {
      job.advance();
      value.coordinator.advanceMaintenance();
    }
    expect(job.state).toBe(state);
    expect(value.port.postCalls).toBe(calls);
  });

  it("releases the active transfer when a dormant job observes actual worker death first", async () => {
    const value = await session();
    const { job: active } = start(value, fixture("fine-dense-nonplanar"));
    await atLabel(value, active, "worker_fit_dispatch");
    const { job: dormant } = start(value, fixture());
    expect(value.coordinator.activeJob).toBe(active);
    expect(value.coordinator.receipt.reservedInputBytes).toBeGreaterThan(0);
    expect(dormant.transportJobId).toBeNull();

    await value.port.terminateUnexpectedly();
    // No maintenance or active.advance() before this different job observes it.
    dormant.advance(1);
    expect(active.state.status).toBe("failed_input");
    expect(dormant.state.status).toBe("failed_input");
    expect(value.coordinator.activeJob).toBeNull();
    expect(value.coordinator.receipt).toMatchObject({
      terminated: true,
      cacheOwners: 0,
      cacheInputBytes: 0,
      cacheDerivedBytesReserved: 0,
      reservedOwners: 0,
      reservedInputBytes: 0,
      reservedDerivedBytes: 0,
      transportJobId: null,
    });
    // Only this fixture's observation listener remains; transport listeners left.
    expect(value.port.listenerCount).toBe(1);
    const activeState = active.state,
      dormantState = dormant.state;
    const calls = value.port.postCalls;
    value.coordinator.destroy();
    value.coordinator.destroy();
    active.advance();
    dormant.advance();
    expect(active.state).toBe(activeState);
    expect(dormant.state).toBe(dormantState);
    expect(value.port.postCalls).toBe(calls);
    expect(value.port.terminateCalls).toBe(1);
    expect(value.coordinator.receipt.reservedInputBytes).toBe(0);
    await value.close();
    expect(value.port.listenerCount).toBe(0);
  });

  it.each(["cache", "waiting_worker", "remapping"] as const)(
    "destroys actual %s work without publication or retained reservations",
    async (phase) => {
      const item = fixture(),
        value = await session(),
        { job } = start(value, item);
      if (phase === "waiting_worker")
        await atLabel(value, job, "worker_fit_dispatch");
      else await atPhase(value, job, phase);
      value.coordinator.destroy();
      value.coordinator.destroy();
      expect(value.coordinator.receipt.terminated).toBe(true);
      expect(value.coordinator.receipt.cacheOwners).toBe(0);
      expect(value.coordinator.receipt.reservedInputBytes).toBe(0);
      expect(value.coordinator.receipt.reservedDerivedBytes).toBe(0);
      expect(value.port.terminateCalls).toBe(1);
      job.advance();
      expect(job.state.status).not.toBe("ready");
      expect(job.state.status).not.toBe("running");
    },
  );
});
