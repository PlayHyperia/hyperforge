import { BufferGeometry } from "three/src/core/BufferGeometry.js";
import { BufferAttribute } from "three/src/core/BufferAttribute.js";
import {
  GRASS_BLADE_GROUNDING_JOB_LIMITS as jobLimits,
  GrassGroundingContinuation,
  groundGrassBladeSteps,
  validateGrassGroundingConsumedWork,
  type GrassBladeGroundingResult,
  type GrassGroundingConsumedWork,
} from "../../systems/shared/world/GrassBladeGrounding";
import { getGrassBladeLayout } from "../../systems/shared/world/GrassBladeLayout";
import {
  RetainedTerrainSurface,
  type TerrainCellTopology,
  type RetainedTerrainSurfaceSnapshot,
} from "../../systems/shared/world/TerrainGridSurface";
import {
  GRASS_GROUNDING_WORKER_LIMITS as limits,
  grassGroundingWorkerInputTransfers,
  type GrassGroundingWorkerRequest,
  type GrassGroundingWorkerCachedRequest,
  type GrassGroundingWorkerPrepareSurface,
  type GrassGroundingWorkerCacheReceipt,
  type GrassGroundingWorkerResponse,
  type GrassGroundingWorkerResult,
} from "./GrassGroundingWorkerWire";

// The same browser bundle is exercised by the Node worker transport adapter.
// No rendering, scene, DOM or game publication is owned by this entry.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(
    message: GrassGroundingWorkerResponse,
    transfer?: ArrayBuffer[],
  ): void;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
    "Invalid grounding message object",
  );
  const keys = Reflect.ownKeys(value);
  requireValue(
    keys.length >= required.length &&
      keys.length <= required.length + optional.length &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          (required.includes(key) || optional.includes(key)),
      ),
    "Invalid grounding message fields",
  );
  for (const key of [...required, ...optional]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor && optional.includes(key)) continue;
    requireValue(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "Invalid grounding message property",
    );
  }
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}
function completeView(
  value: unknown,
): asserts value is Float32Array | Uint16Array | Uint32Array {
  requireValue(
    (value instanceof Float32Array ||
      value instanceof Uint16Array ||
      value instanceof Uint32Array) &&
      value.buffer instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength,
    "Grounding transport requires complete owned typed-array views",
  );
}
function floatView(
  value: unknown,
  length: number,
): asserts value is Float32Array {
  completeView(value);
  requireValue(
    value instanceof Float32Array && value.length === length,
    "Invalid grounding float payload",
  );
}

function admitSurface(value: unknown) {
  const s = object(value, [
    "schemaVersion",
    "nodeId",
    "terrainProfileIdentity",
    "revision",
    "centerX",
    "centerZ",
    "size",
    "resolution",
    "positions",
    "indices",
    "topology",
    "positionVersion",
    "indexVersion",
    "positionCount",
    "indexCount",
    "payloadBytes",
  ]);
  requireValue(
    s.schemaVersion === 1 &&
      integer(s.nodeId) &&
      text(s.revision, 128) &&
      text(s.terrainProfileIdentity, 65536) &&
      integer(s.resolution, 2, 256) &&
      typeof s.centerX === "number" &&
      Number.isFinite(s.centerX) &&
      typeof s.centerZ === "number" &&
      Number.isFinite(s.centerZ) &&
      typeof s.size === "number" &&
      Number.isFinite(s.size) &&
      s.size > 0 &&
      integer(s.positionVersion) &&
      integer(s.indexVersion) &&
      integer(s.positionCount) &&
      integer(s.indexCount) &&
      integer(s.payloadBytes, 0, limits.maximumInputBytes),
    "Invalid grounding surface descriptor",
  );
  floatView(s.positions, s.positionCount * 3);
  completeView(s.indices);
  requireValue(
    (s.indices instanceof Uint16Array || s.indices instanceof Uint32Array) &&
      s.indices.length === s.indexCount,
    "Invalid grounding index payload",
  );
  let inputBytes = s.positions.byteLength + s.indices.byteLength;
  let derivedBytes = 0;
  if (s.topology !== null) {
    const topology = object(s.topology, [
      "schemaVersion",
      "resolution",
      "surfaceVertexCount",
      "cellIndexOffsets",
    ]);
    requireValue(
      topology.schemaVersion === 1 &&
        topology.resolution === s.resolution &&
        integer(topology.surfaceVertexCount, s.resolution ** 2, 131072),
      "Invalid grounding topology descriptor",
    );
    completeView(topology.cellIndexOffsets);
    requireValue(
      topology.cellIndexOffsets instanceof Uint32Array &&
        topology.cellIndexOffsets.length === (s.resolution - 1) ** 2 + 1,
      "Invalid grounding topology offset payload",
    );
    inputBytes += topology.cellIndexOffsets.byteLength;
    // Conservative edge-index bound: parent plus both child bounds. Packed
    // offsets and unpacked numeric slots are separate; this is not JS heap size.
    derivedBytes =
      (Math.ceil(s.indices.length / 24) + (s.resolution - 1) ** 2) * 96 +
      topology.cellIndexOffsets.length * 12;
  }
  requireValue(
    inputBytes === s.payloadBytes,
    "Grounding surface payload receipt mismatch",
  );
  return {
    snapshot: value as RetainedTerrainSurfaceSnapshot,
    inputBytes,
    derivedBytes,
  };
}

function surfaceTokens(value: unknown, allowEmpty = false): number[] {
  requireValue(
    Array.isArray(value) &&
      value.length <= limits.maximumCachedSurfaces &&
      (allowEmpty || value.length > 0),
    "Invalid grounding surface count",
  );
  const seen = new Set<number>();
  for (const token of value) {
    requireValue(
      integer(token, 1) && !seen.has(token),
      "Invalid grounding surface token",
    );
    seen.add(token);
  }
  return value as number[];
}

/** Constant-count boundary checks reserve payload BEFORE any terrain rebuild.
 * Detailed geometry/topology/constraint checks run in the real sliced core. */
function admit(value: unknown, cached: boolean) {
  const r = object(value, [
    "type",
    "schemaVersion",
    "jobId",
    "generation",
    "ownSurfaceToken",
    cached ? "surfaceTokens" : "surfaces",
    "geometry",
    "data",
    "constraints",
    "settings",
    "consumed",
  ]);
  requireValue(
    r.type === (cached ? "start_cached" : "start") &&
      r.schemaVersion === 1 &&
      integer(r.jobId, 1) &&
      integer(r.generation, 1) &&
      integer(r.ownSurfaceToken, 1),
    "Invalid grounding job identity",
  );
  let derivedBytes = 0;
  const tokens = new Set<number>();
  let profile: string | undefined;
  const acceptProfile = (next: string) => {
    if (profile === undefined) profile = next;
    requireValue(next === profile, "Mixed grounding terrain profiles");
  };
  if (cached) {
    for (const token of surfaceTokens(r.surfaceTokens)) {
      const owner = surfaceCache.get(token);
      requireValue(owner, "Missing cached grounding surface");
      tokens.add(token);
      acceptProfile(owner.surface.terrainProfileIdentity);
    }
  } else {
    requireValue(
      Array.isArray(r.surfaces) &&
        r.surfaces.length > 0 &&
        r.surfaces.length <= limits.maximumCachedSurfaces,
      "Invalid grounding surface count",
    );
    for (const row of r.surfaces) {
      const surface = object(row, ["token", "snapshot"]);
      requireValue(
        integer(surface.token, 1) && !tokens.has(surface.token),
        "Invalid grounding surface token",
      );
      tokens.add(surface.token);
      const admitted = admitSurface(surface.snapshot);
      acceptProfile(admitted.snapshot.terrainProfileIdentity);
      derivedBytes += admitted.derivedBytes;
    }
  }
  requireValue(tokens.has(r.ownSurfaceToken), "Missing own grounding surface");
  const settings = object(
    r.settings,
    ["lod", "oceanLevel", "wind"],
    [
      "geometryLayout",
      "roadClearance",
      "bankVerge",
      "maximumBaseError",
      "workBudget",
    ],
  );
  const layout = getGrassBladeLayout(
    settings.lod as number,
    settings.geometryLayout as GrassGroundingWorkerRequest["settings"]["geometryLayout"],
  );
  object(settings.wind, ["x", "z"]);
  const geometry = object(r.geometry, [
    "position",
    "normal",
    "uv",
    "index",
    "drawCount",
  ]);
  floatView(geometry.position, layout.verticesPerClump * 3);
  floatView(geometry.normal, layout.verticesPerClump * 3);
  floatView(geometry.uv, layout.verticesPerClump * 2);
  completeView(geometry.index);
  requireValue(
    (geometry.index instanceof Uint16Array ||
      geometry.index instanceof Uint32Array) &&
      geometry.index.length === layout.trianglesPerClump * 3 &&
      (geometry.drawCount === Infinity ||
        geometry.drawCount === geometry.index.length),
    "Invalid grounding blade geometry payload",
  );
  const data = object(r.data, [
    "count",
    "offsets",
    "rotScaleHash",
    "groundColors",
    "grassTints",
    "groundNormals",
  ]);
  requireValue(
    integer(data.count, 0, 4096),
    "Invalid grounding instance capacity",
  );
  for (const key of [
    "offsets",
    "rotScaleHash",
    "groundColors",
    "groundNormals",
  ])
    floatView(data[key], data.count * 3);
  floatView(data.grassTints, data.count * 4);
  const constraints = object(r.constraints, ["terrainSurface", "roadSegments"]);
  requireValue(
    Array.isArray(constraints.roadSegments) &&
      constraints.roadSegments.length <= 4096,
    "Invalid grounding road capacity",
  );
  validateGrassGroundingConsumedWork(r.consumed);
  const request = value as
    GrassGroundingWorkerRequest | GrassGroundingWorkerCachedRequest;
  const buffers = grassGroundingWorkerInputTransfers(request);
  const inputBytes = buffers.reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0,
  );
  assertReservation(inputBytes, derivedBytes);
  return { request, inputBytes, derivedBytes };
}

type CachedSurface = {
  surface: RetainedTerrainSurface;
  geometry: BufferGeometry;
  inputBytes: number;
  derivedBytes: number;
};
const surfaceCache = new Map<number, CachedSurface>();
let lastAcceptedSurfaceToken = 0;

function cacheReceipt(): GrassGroundingWorkerCacheReceipt {
  let inputBytes = 0,
    derivedBytesReserved = 0;
  for (const owner of surfaceCache.values()) {
    inputBytes += owner.inputBytes;
    derivedBytesReserved += owner.derivedBytes;
  }
  return { owners: surfaceCache.size, inputBytes, derivedBytesReserved };
}

function assertReservation(inputBytes: number, derivedBytes: number): void {
  const cache = cacheReceipt();
  requireValue(
    inputBytes + cache.inputBytes <= limits.maximumInputBytes &&
      derivedBytes + cache.derivedBytesReserved <= limits.maximumDerivedBytes,
    "Grounding worker payload reservation exceeded",
  );
}

type SurfaceOwners = Map<
  RetainedTerrainSurface,
  { token: number; sourceRevision: string }
>;
type ActiveFit = ReturnType<typeof admit> & {
  kind: "fit";
  job: GrassGroundingContinuation;
  owners: SurfaceOwners;
  geometries: BufferGeometry[];
  terrainRebuildWork: GrassGroundingConsumedWork | null;
  sliceStartedAt: number | null;
};
type PreparationState =
  | { status: "running" }
  | { status: "prepared"; surface: RetainedTerrainSurface }
  | { status: "failed_budget"; reason: "operations" | "active_cpu" }
  | { status: "failed_input"; error: unknown }
  | { status: "cancelled"; reason: "caller" | "invalidated" };

/** Surface admission has its own real result type and ledger. It never pretends
 * to be ready grass. The fitting continuation and its caps remain unchanged. */
class SurfacePreparationContinuation {
  private iterator: Generator<string, RetainedTerrainSurface, void> | null;
  private current: PreparationState = { status: "running" };
  operations: number;
  activeMs: number;
  maximumSliceMs: number;
  lastPhase: string | null = null;

  constructor(
    steps: Generator<string, RetainedTerrainSurface, void>,
    private readonly isCurrent: () => boolean,
    consumed: GrassGroundingConsumedWork,
  ) {
    const admitted = validateGrassGroundingConsumedWork(consumed);
    this.iterator = steps;
    this.operations = admitted.operations;
    this.activeMs = admitted.activeMs;
    this.maximumSliceMs = admitted.maximumSliceMs;
  }

  get state(): PreparationState {
    return this.current;
  }

  private close(state: PreparationState): void {
    const iterator = this.iterator;
    this.iterator = null;
    this.current = state;
    iterator?.return(undefined as never);
  }

  cancel(): void {
    if (this.state.status === "running")
      this.close({ status: "cancelled", reason: "caller" });
  }

  private recordSlice(started: number): void {
    const sliceMs = performance.now() - started;
    this.activeMs += sliceMs;
    this.maximumSliceMs = Math.max(this.maximumSliceMs, sliceMs);
    if (
      this.activeMs >= jobLimits.maximumActiveMs &&
      (this.current.status === "running" || this.current.status === "prepared")
    )
      this.close({ status: "failed_budget", reason: "active_cpu" });
  }

  advance(): void {
    if (this.state.status !== "running") return;
    const started = performance.now(),
      deadline = started + jobLimits.targetSliceMs;
    let sliceOperations = 0;
    try {
      if (!this.isCurrent()) {
        this.close({ status: "cancelled", reason: "invalidated" });
        return;
      }
      while (
        this.iterator &&
        sliceOperations < jobLimits.maximumSliceOperations
      ) {
        if (this.operations >= jobLimits.maximumOperations) {
          this.close({ status: "failed_budget", reason: "operations" });
          return;
        }
        if (sliceOperations % jobLimits.clockInterval === 0) {
          const now = performance.now();
          if (this.activeMs + now - started >= jobLimits.maximumActiveMs) {
            this.close({ status: "failed_budget", reason: "active_cpu" });
            return;
          }
          if (now >= deadline) break;
        }
        const step = this.iterator.next();
        this.operations++;
        sliceOperations++;
        if (step.done) {
          this.close({ status: "prepared", surface: step.value });
          break;
        }
        this.lastPhase = step.value;
      }
      if (!this.isCurrent())
        this.close({ status: "cancelled", reason: "invalidated" });
    } catch (error) {
      this.close({ status: "failed_input", error });
    } finally {
      this.recordSlice(started);
    }
  }
}

type ActivePreparation = {
  kind: "prepare";
  request: GrassGroundingWorkerPrepareSurface;
  inputBytes: number;
  derivedBytes: number;
  geometries: BufferGeometry[];
  job: SurfacePreparationContinuation;
};
type Active = ActiveFit | ActivePreparation;
let active: Active | null = null;
let lastAcceptedId = 0;
let scheduled = false;
const channel = new globalThis.MessageChannel();

function* rebuildSurface(
  s: RetainedTerrainSurfaceSnapshot,
  geometries: BufferGeometry[],
): Generator<string, RetainedTerrainSurface, void> {
  yield "worker_surface_rebuild";
  const geometry = new BufferGeometry();
  geometries.push(geometry);
  // UUID attests the borrowed source, not a new world owner. Main publication
  // must still map token+revision to its exact held object and complete lease.
  geometry.uuid = s.revision;
  const position = new BufferAttribute(s.positions, 3),
    index = new BufferAttribute(s.indices, 1);
  position.version = s.positionVersion;
  index.version = s.indexVersion;
  geometry.setAttribute("position", position);
  geometry.setIndex(index);
  if (s.topology) {
    const offsets: number[] = [];
    for (
      let start = 0;
      start < s.topology.cellIndexOffsets.length;
      start += 256
    ) {
      yield "worker_topology_unpack";
      const end = Math.min(start + 256, s.topology.cellIndexOffsets.length);
      for (let i = start; i < end; i++)
        offsets.push(s.topology.cellIndexOffsets[i]);
    }
    const topology: TerrainCellTopology = Object.freeze({
      schemaVersion: 1,
      resolution: s.topology.resolution,
      surfaceVertexCount: s.topology.surfaceVertexCount,
      cellIndexOffsets: Object.freeze(offsets),
    });
    geometry.userData.terrainCellTopology = topology;
  }
  return yield* RetainedTerrainSurface.prepare(
    s.nodeId,
    s.terrainProfileIdentity,
    s.centerX,
    s.centerZ,
    s.size,
    s.resolution,
    geometry,
  );
}

function* execute(
  request: GrassGroundingWorkerRequest | GrassGroundingWorkerCachedRequest,
  owners: SurfaceOwners,
  geometries: BufferGeometry[],
  rebuilt: () => void,
): Generator<string, GrassBladeGroundingResult, void> {
  const surfaces: RetainedTerrainSurface[] = [];
  let ownSurface: RetainedTerrainSurface | undefined;
  if (request.type === "start_cached") {
    for (const token of request.surfaceTokens) {
      yield "worker_cached_surface";
      const owner = surfaceCache.get(token);
      requireValue(owner, "Missing cached grounding surface");
      owners.set(owner.surface, {
        token,
        sourceRevision: owner.surface.revision,
      });
      surfaces.push(owner.surface);
      if (token === request.ownSurfaceToken) ownSurface = owner.surface;
    }
  } else {
    for (const row of request.surfaces) {
      const surface = yield* rebuildSurface(row.snapshot, geometries);
      owners.set(surface, {
        token: row.token,
        sourceRevision: row.snapshot.revision,
      });
      surfaces.push(surface);
      if (row.token === request.ownSurfaceToken) ownSurface = surface;
    }
    rebuilt();
  }
  requireValue(ownSurface, "Missing rebuilt own surface");
  yield "worker_blade_geometry";
  const geometry = new BufferGeometry(),
    source = request.geometry;
  geometries.push(geometry);
  geometry.setAttribute("position", new BufferAttribute(source.position, 3));
  geometry.setAttribute("normal", new BufferAttribute(source.normal, 3));
  geometry.setAttribute("uv", new BufferAttribute(source.uv, 2));
  geometry.setIndex(new BufferAttribute(source.index, 1));
  geometry.setDrawRange(0, source.drawCount);
  return yield* groundGrassBladeSteps({
    ...request.settings,
    ...request.constraints,
    data: request.data,
    geometry,
    ownSurface,
    surfaces,
  });
}

type ResultResponse = Extract<GrassGroundingWorkerResponse, { type: "result" }>;

function failureResponse(row: ActiveFit, error: unknown): ResultResponse {
  return {
    type: "result",
    jobId: row.request.jobId,
    generation: row.request.generation,
    state: {
      status: "failed_input",
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        1024,
      ),
    },
    work: {
      operations: row.job.operations,
      activeMs: row.job.activeMs,
      maximumSliceMs: row.job.maximumSliceMs,
    },
    lastPhase: row.job.lastPhase,
    terrainRebuildWork: row.terrainRebuildWork,
    inputBytes: row.inputBytes,
    derivedBytesReserved: row.derivedBytes,
    resultBytes: 0,
    cache: cacheReceipt(),
  };
}

function packResult(row: ActiveFit): {
  response: ResultResponse;
  transfers: ArrayBuffer[];
} {
  const state = row.job.state;
  requireValue(state.status !== "running", "Grounding job is not terminal");
  const transfers: ArrayBuffer[] = [];
  let output: Extract<
    GrassGroundingWorkerResponse,
    { type: "result" }
  >["state"];
  if (state.status === "ready" || state.status === "waiting_support") {
    const result: GrassGroundingWorkerResult = {
      ...state.result,
      dependencies: state.result.dependencies.map(({ surface, uses }) => {
        const owner = row.owners.get(surface);
        requireValue(owner, "Foreign grounding dependency");
        return { ...owner, uses };
      }),
    };
    if (result.status === "ready") {
      const arrays = [
        result.data.offsets,
        result.data.rotScaleHash,
        result.data.groundColors,
        result.data.grassTints,
        result.data.groundNormals,
        result.rootDeltas,
        result.sourceIndices,
        ...(result.bladeVisibility ? [result.bladeVisibility] : []),
      ];
      const unique = new Set<ArrayBuffer>();
      for (const array of arrays) {
        requireValue(
          array.buffer instanceof ArrayBuffer,
          "Invalid grounding result buffer",
        );
        unique.add(array.buffer);
      }
      transfers.push(...unique);
    }
    output = { status: state.status, result };
  } else if (state.status === "failed_input")
    output = {
      status: "failed_input",
      error: String(
        state.error instanceof Error ? state.error.message : state.error,
      ).slice(0, 1024),
    };
  else output = state;
  const resultBytes = transfers.reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0,
  );
  if (resultBytes > limits.maximumResultBytes) {
    output = {
      status: "failed_input",
      error: "Grounding worker result reservation exceeded",
    };
    transfers.length = 0;
  }
  const response: ResultResponse = {
    type: "result",
    jobId: row.request.jobId,
    generation: row.request.generation,
    state: output,
    work: {
      operations: row.job.operations,
      activeMs: row.job.activeMs,
      maximumSliceMs: row.job.maximumSliceMs,
    },
    lastPhase: row.job.lastPhase,
    terrainRebuildWork: row.terrainRebuildWork,
    inputBytes: row.inputBytes,
    derivedBytesReserved: row.derivedBytes,
    resultBytes: transfers.length ? resultBytes : 0,
    cache: cacheReceipt(),
  };
  return { response, transfers };
}

function terminalFit(row: ActiveFit): void {
  if (row.job.state.status === "running") return;
  try {
    try {
      const { response, transfers } = packResult(row);
      scope.postMessage(response, transfers);
    } catch (error) {
      // A packing or structured-clone failure must not wedge the worker. This
      // fallback has no transferable buffers and preserves cumulative work.
      // If even the transport is unavailable, let the worker error surface;
      // the finally still releases local ownership for supervisor teardown.
      scope.postMessage(failureResponse(row, error));
    }
  } finally {
    if (active === row) active = null;
    row.owners.clear();
    const geometries = row.geometries.splice(0);
    for (const geometry of geometries) geometry.dispose();
  }
}

function terminalPreparation(row: ActivePreparation): void {
  const state = row.job.state;
  if (state.status === "running") return;
  type Response = Extract<
    GrassGroundingWorkerResponse,
    { type: "surface_prepared" }
  >;
  let committed = false;
  let staged = false;
  const response = (output: Response["state"]): Response => ({
    type: "surface_prepared",
    jobId: row.request.jobId,
    generation: row.request.generation,
    state: output,
    work: {
      operations: row.job.operations,
      activeMs: row.job.activeMs,
      maximumSliceMs: row.job.maximumSliceMs,
    },
    lastPhase: row.job.lastPhase,
    inputBytes: row.inputBytes,
    derivedBytesReserved: row.derivedBytes,
    cache: cacheReceipt(),
  });
  try {
    try {
      let output: Response["state"];
      if (state.status === "prepared") {
        requireValue(
          row.geometries.length === 1 && !surfaceCache.has(row.request.token),
          "Invalid prepared surface ownership",
        );
        surfaceCache.set(row.request.token, {
          surface: state.surface,
          geometry: row.geometries[0],
          inputBytes: row.inputBytes,
          derivedBytes: row.derivedBytes,
        });
        staged = true;
        output = {
          status: "prepared",
          token: row.request.token,
          sourceRevision: state.surface.revision,
        };
      } else if (state.status === "failed_input") {
        output = {
          status: "failed_input",
          error: String(
            state.error instanceof Error ? state.error.message : state.error,
          ).slice(0, 1024),
        };
      } else output = state;
      scope.postMessage(response(output));
      committed = state.status === "prepared";
    } catch (error) {
      if (staged) surfaceCache.delete(row.request.token);
      scope.postMessage(
        response({
          status: "failed_input",
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            1024,
          ),
        }),
      );
    }
  } finally {
    if (active === row) active = null;
    if (staged && !committed) surfaceCache.delete(row.request.token);
    const geometries = row.geometries.splice(0);
    if (!committed) for (const geometry of geometries) geometry.dispose();
  }
}

function terminal(row: Active): void {
  if (row.kind === "prepare") terminalPreparation(row);
  else terminalFit(row);
}

function admitPreparation(value: unknown) {
  const r = object(value, [
    "type",
    "schemaVersion",
    "jobId",
    "generation",
    "token",
    "snapshot",
    "consumed",
  ]);
  requireValue(
    r.type === "prepare_surface" &&
      r.schemaVersion === 1 &&
      integer(r.jobId, 1) &&
      integer(r.generation, 1) &&
      integer(r.token, 1),
    "Invalid grounding preparation identity",
  );
  requireValue(
    r.token > lastAcceptedSurfaceToken,
    "Stale grounding surface token",
  );
  requireValue(
    surfaceCache.size < limits.maximumCachedSurfaces,
    "Grounding surface cache capacity exceeded",
  );
  const admitted = admitSurface(r.snapshot);
  validateGrassGroundingConsumedWork(r.consumed);
  const request = value as GrassGroundingWorkerPrepareSurface;
  // The helper also rejects aliasing between individual snapshot fields.
  grassGroundingWorkerInputTransfers(request);
  assertReservation(admitted.inputBytes, admitted.derivedBytes);
  return {
    request,
    inputBytes: admitted.inputBytes,
    derivedBytes: admitted.derivedBytes,
  };
}

function releaseSurfaces(value: unknown): void {
  const r = object(value, [
    "type",
    "schemaVersion",
    "jobId",
    "generation",
    "surfaceTokens",
  ]);
  requireValue(
    r.type === "release_surfaces" &&
      r.schemaVersion === 1 &&
      integer(r.jobId, 1) &&
      integer(r.generation, 1),
    "Invalid grounding release identity",
  );
  const tokens = surfaceTokens(r.surfaceTokens, true);
  // Validate the entire command before releasing even one owner.
  for (const token of tokens)
    requireValue(surfaceCache.has(token), "Missing cached grounding surface");
  const projected = cacheReceipt();
  for (const token of tokens) {
    const owner = surfaceCache.get(token)!;
    projected.owners--;
    projected.inputBytes -= owner.inputBytes;
    projected.derivedBytesReserved -= owner.derivedBytes;
  }
  // A failed acknowledgement must leave the cache intact. The synchronous
  // commit finishes before the worker can accept the next incoming message.
  scope.postMessage({
    type: "surfaces_released",
    jobId: r.jobId,
    generation: r.generation,
    surfaceTokens: tokens,
    cache: projected,
  });
  lastAcceptedId = r.jobId;
  for (const token of tokens) {
    const owner = surfaceCache.get(token)!;
    surfaceCache.delete(token);
    owner.geometry.dispose();
  }
}

function schedule() {
  if (!scheduled && active) {
    scheduled = true;
    channel.port2.postMessage(null);
  }
}
channel.port1.onmessage = () => {
  scheduled = false;
  const row = active;
  if (!row) return;
  if (row.kind === "fit") row.sliceStartedAt = performance.now();
  try {
    row.job.advance();
  } finally {
    if (row.kind === "fit") row.sliceStartedAt = null;
  }
  if (row.job.state.status === "running") schedule();
  else terminal(row);
};
scope.onmessage = ({ data }) => {
  let jobId: number | null = null,
    generation: number | null = null;
  try {
    requireValue(
      data !== null && typeof data === "object",
      "Invalid grounding message",
    );
    const identity = data as Record<string, unknown>;
    if (integer(identity.jobId, 1)) jobId = identity.jobId;
    if (integer(identity.generation, 1)) generation = identity.generation;
    if (identity.type === "cancel") {
      object(data, ["type", "schemaVersion", "jobId", "generation"]);
      requireValue(
        identity.schemaVersion === 1 && jobId !== null && generation !== null,
        "Invalid grounding cancellation",
      );
      if (
        !active ||
        active.request.jobId !== jobId ||
        active.request.generation !== generation
      ) {
        scope.postMessage({
          type: "rejected",
          jobId,
          generation,
          reason: "stale",
        });
        return;
      }
      const row = active;
      row.job.cancel();
      terminal(row);
      return;
    }
    if (active) {
      scope.postMessage({
        type: "rejected",
        jobId,
        generation,
        reason: "busy",
      });
      return;
    }
    requireValue(
      jobId !== null && generation !== null,
      "Invalid grounding identity",
    );
    if (jobId <= lastAcceptedId) {
      scope.postMessage({
        type: "rejected",
        jobId,
        generation,
        reason: "stale",
      });
      return;
    }
    if (identity.type === "release_surfaces") {
      releaseSurfaces(data);
      return;
    }
    let row: Active;
    if (identity.type === "prepare_surface") {
      const admitted = admitPreparation(data);
      const geometries: BufferGeometry[] = [];
      const preparing: ActivePreparation = {
        kind: "prepare",
        ...admitted,
        geometries,
        job: new SurfacePreparationContinuation(
          rebuildSurface(admitted.request.snapshot, geometries),
          () => active === preparing,
          admitted.request.consumed,
        ),
      };
      lastAcceptedSurfaceToken = admitted.request.token;
      row = preparing;
    } else {
      const admitted = admit(data, identity.type === "start_cached");
      const owners: SurfaceOwners = new Map(),
        geometries: BufferGeometry[] = [];
      const fitting: ActiveFit = {
        kind: "fit",
        ...admitted,
        owners,
        geometries,
        terrainRebuildWork: null,
        sliceStartedAt: null,
        job: new GrassGroundingContinuation(
          execute(admitted.request, owners, geometries, () => {
            const sliceMs = performance.now() - fitting.sliceStartedAt!;
            fitting.terrainRebuildWork = {
              operations: fitting.job.operations,
              activeMs: fitting.job.activeMs + sliceMs,
              maximumSliceMs: Math.max(fitting.job.maximumSliceMs, sliceMs),
            };
          }),
          () => active === fitting,
          admitted.request.consumed,
        ),
      };
      row = fitting;
    }
    active = row;
    lastAcceptedId = row.request.jobId;
    try {
      scope.postMessage({
        type: "accepted",
        jobId,
        generation,
        inputBytes: row.inputBytes,
        derivedBytesReserved: row.derivedBytes,
        cache: cacheReceipt(),
      });
    } catch (error) {
      row.job.cancel();
      active = null;
      throw error;
    }
    schedule();
  } catch (error) {
    scope.postMessage({
      type: "rejected",
      jobId,
      generation,
      reason: "invalid_message",
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        1024,
      ),
    });
  }
};
