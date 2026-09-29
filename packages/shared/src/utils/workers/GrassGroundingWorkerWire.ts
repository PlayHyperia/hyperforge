import type { GrassAnchorData } from "../../systems/shared/world/GrassTerrainProjection";
import { GRASS_GROUNDING_DIAGNOSTIC_SUBCELL_SIZE } from "../../systems/shared/world/GrassBladeGrounding";
import type {
  GrassBladeGroundingRequest,
  GrassBladeGroundingResult,
  GrassGroundingConsumedWork,
  GrassGroundingTiming,
  GrassGroundingExecution,
} from "../../systems/shared/world/GrassBladeGrounding";
import type { RetainedTerrainSurfaceSnapshot } from "../../systems/shared/world/TerrainGridSurface";

/** Dedicated one-job transport budgets. Payload bounds are not JS/GPU heap
 * measurements. No game scheduling limit or rendering setting is changed. */
export const GRASS_GROUNDING_WORKER_LIMITS = Object.freeze({
  maximumInputBytes: 16 * 1024 * 1024,
  // Retained query-index arrays and unpacked topology slots only. Admission
  // validation and fitting scratch are separately bounded by their core input
  // limits, not counted here or qualified as a total transient heap budget.
  maximumDerivedBytes: 16 * 1024 * 1024,
  maximumResultBytes: 2 * 1024 * 1024,
  maximumDiagnosticSubcells: 4096,
  maximumCachedSurfaces: 16,
});

export type GrassGroundingGeometrySnapshot = {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint16Array | Uint32Array;
  drawCount: number;
};

export type GrassGroundingWorkerRequest = {
  type: "start";
  schemaVersion: 1;
  /** Strictly increasing for this worker lifetime; never reused after cancel. */
  jobId: number;
  generation: number;
  ownSurfaceToken: number;
  surfaces: { token: number; snapshot: RetainedTerrainSurfaceSnapshot }[];
  geometry: GrassGroundingGeometrySnapshot;
  data: GrassAnchorData;
  constraints: Pick<
    GrassBladeGroundingRequest,
    "terrainSurface" | "roadSegments"
  >;
  settings: Pick<
    GrassBladeGroundingRequest,
    | "lod"
    | "geometryLayout"
    | "roadClearance"
    | "diagnosticSubcells"
    | "bankVerge"
    | "pondServiceGround"
    | "oceanLevel"
    | "wind"
    | "maximumBaseError"
    | "workBudget"
  >;
  consumed: GrassGroundingConsumedWork;
  /** Opt-in only; one original absolute deadline, never a per-stage renewal. */
  execution?: GrassGroundingExecution;
};

export type GrassGroundingWorkerCancel = {
  type: "cancel";
  schemaVersion: 1;
  jobId: number;
  generation: number;
};

/** Admission is an explicit owned task, not an unmeasured fitting-job warmup. */
export type GrassGroundingWorkerPrepareSurface = {
  type: "prepare_surface";
  schemaVersion: 1;
  jobId: number;
  generation: number;
  /** Strictly increasing across accepted preparations, including failed ones. */
  token: number;
  snapshot: RetainedTerrainSurfaceSnapshot;
  consumed: GrassGroundingConsumedWork;
  execution?: GrassGroundingExecution;
};

export type GrassGroundingWorkerCachedRequest = Omit<
  GrassGroundingWorkerRequest,
  "type" | "surfaces"
> & {
  type: "start_cached";
  /** Exact original region order; no inferred neighbors or sorted replacement. */
  surfaceTokens: number[];
};

export type GrassGroundingWorkerReleaseSurfaces = {
  type: "release_surfaces";
  schemaVersion: 1;
  jobId: number;
  generation: number;
  surfaceTokens: number[];
  execution?: GrassGroundingExecution;
};

export type GrassGroundingWorkerCacheReceipt = {
  owners: number;
  inputBytes: number;
  derivedBytesReserved: number;
};

export type GrassGroundingWorkerDependency = {
  token: number;
  sourceRevision: string;
  uses: readonly ("endpoint" | "edge" | "envelope")[];
};

type WireResult<R> = R extends GrassBladeGroundingResult
  ? Omit<R, "dependencies"> & { dependencies: GrassGroundingWorkerDependency[] }
  : never;
export type GrassGroundingWorkerResult = WireResult<GrassBladeGroundingResult>;

/** Strict optional numerical diagnostic boundary shared by worker, supervisor
 * and publication. Bytes cover cellSize and nine doubles per cell, not strings,
 * object/array overhead or total JS heap. Omission performs no allocation. */
export function validateGrassGroundingDiagnosticSubcells(
  value: unknown,
  expectedMode: GrassBladeGroundingRequest["diagnosticSubcells"],
  count: number,
  sweptBounds: unknown,
): number {
  if (expectedMode === undefined) {
    if (value !== undefined)
      throw new Error("Unexpected grounding diagnostic subcells");
    return 0;
  }
  const fail: () => never = () => {
    throw new Error("Invalid grounding diagnostic subcells");
  };
  if (
    expectedMode !== "world-grid-6.25m-v1" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 4096
  )
    fail();
  const record = (input: unknown, fields: readonly string[]) => {
    if (
      input === null ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      fail();
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      fail();
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        fail();
    }
    return input as Record<string, unknown>;
  };
  const fields = ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"] as const;
  const bounds = (input: unknown) => {
    const row = record(input, fields);
    for (const key of fields)
      if (typeof row[key] !== "number" || !Number.isFinite(row[key])) fail();
    const result = row as Record<(typeof fields)[number], number>;
    for (const axis of ["X", "Y", "Z"] as const)
      if (result[`min${axis}`] > result[`max${axis}`]) fail();
    return result;
  };
  const metadata = record(value, ["mode", "cellSize", "cells"]);
  if (
    metadata.mode !== expectedMode ||
    metadata.cellSize !== GRASS_GROUNDING_DIAGNOSTIC_SUBCELL_SIZE
  )
    fail();
  const cells = metadata.cells;
  if (
    !Array.isArray(cells) ||
    Object.getPrototypeOf(cells) !== Array.prototype ||
    cells.length > GRASS_GROUNDING_WORKER_LIMITS.maximumDiagnosticSubcells ||
    cells.length > count ||
    Reflect.ownKeys(cells).length !== cells.length + 1
  )
    fail();
  if (count === 0) {
    if (sweptBounds !== null || cells.length !== 0) fail();
    return 8;
  }
  const aggregate = bounds(sweptBounds);
  const union = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  let total = 0,
    previousX = -Infinity,
    previousZ = -Infinity;
  for (let index = 0; index < cells.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(cells, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail();
    const cell = record(descriptor.value, ["x", "z", "count", "bounds"]);
    const x = cell.x,
      z = cell.z,
      cellCount = cell.count;
    if (
      typeof x !== "number" ||
      !Number.isSafeInteger(x) ||
      Object.is(x, -0) ||
      typeof z !== "number" ||
      !Number.isSafeInteger(z) ||
      Object.is(z, -0) ||
      typeof cellCount !== "number" ||
      !Number.isSafeInteger(cellCount) ||
      cellCount <= 0 ||
      cellCount > count ||
      x < previousX ||
      (x === previousX && z <= previousZ)
    )
      fail();
    previousX = x;
    previousZ = z;
    total += cellCount;
    if (total > count) fail();
    const box = bounds(cell.bounds);
    for (const axis of ["X", "Y", "Z"] as const) {
      const min = `min${axis}` as const,
        max = `max${axis}` as const;
      if (box[min] < aggregate[min] || box[max] > aggregate[max]) fail();
      union[min] = Math.min(union[min], box[min]);
      union[max] = Math.max(union[max], box[max]);
    }
  }
  if (total !== count || fields.some((key) => union[key] !== aggregate[key]))
    fail();
  return 8 + cells.length * 9 * 8;
}

export type GrassGroundingWorkerResponse =
  | {
      type: "accepted";
      jobId: number;
      generation: number;
      inputBytes: number;
      derivedBytesReserved: number;
      cache?: GrassGroundingWorkerCacheReceipt;
    }
  | {
      type: "rejected";
      jobId: number | null;
      generation: number | null;
      reason: "busy" | "invalid_message" | "stale";
      error?: string;
    }
  | {
      type: "result";
      jobId: number;
      generation: number;
      state:
        | {
            status: "ready" | "waiting_support";
            result: GrassGroundingWorkerResult;
          }
        | {
            status: "failed_budget";
            reason: "operations" | "active_cpu" | "grounding_work" | "lifetime";
          }
        | { status: "failed_input"; error: string }
        | { status: "cancelled"; reason: "caller" | "invalidated" };
      work: GrassGroundingConsumedWork;
      /** Optional failure-only local continuation observations; not exclusive CPU. */
      timing?: GrassGroundingTiming;
      /** Terminal progress only; never retains input arrays or error graphs. */
      lastPhase: string | null;
      /** Cumulative counter snapshot at the rebuild/fitting boundary, or null
       * if preparation did not finish. The boundary resumption is still active. */
      terrainRebuildWork: GrassGroundingConsumedWork | null;
      inputBytes: number;
      derivedBytesReserved: number;
      /** Transferable buffers plus selected diagnostic numerical slots;
       * excludes structured-clone object/string overhead and JS/GPU heap. */
      resultBytes: number;
      cache?: GrassGroundingWorkerCacheReceipt;
    }
  | {
      type: "surface_prepared";
      jobId: number;
      generation: number;
      state:
        | { status: "prepared"; token: number; sourceRevision: string }
        | {
            status: "failed_budget";
            reason: "operations" | "active_cpu" | "lifetime";
          }
        | { status: "failed_input"; error: string }
        | { status: "cancelled"; reason: "caller" | "invalidated" };
      work: GrassGroundingConsumedWork;
      /** Failure-only local preparation observations; never inherited seed time. */
      timing?: GrassGroundingTiming;
      lastPhase: string | null;
      inputBytes: number;
      derivedBytesReserved: number;
      cache: GrassGroundingWorkerCacheReceipt;
    }
  | {
      type: "surfaces_released";
      jobId: number;
      generation: number;
      surfaceTokens: number[];
      cache: GrassGroundingWorkerCacheReceipt;
    };

/** Exactly the owned copied payload, not the caller's renderer arrays.
 * Admission validates canonical complete views before this list is used. */
export function grassGroundingWorkerInputTransfers(
  request:
    | GrassGroundingWorkerRequest
    | GrassGroundingWorkerCachedRequest
    | GrassGroundingWorkerPrepareSurface,
): ArrayBuffer[] {
  const snapshots =
    request.type === "prepare_surface"
      ? [request.snapshot]
      : request.type === "start"
        ? request.surfaces.map((row) => row.snapshot)
        : [];
  const arrays = [
    ...snapshots.flatMap((snapshot) => [
      snapshot.positions,
      snapshot.indices,
      ...(snapshot.topology ? [snapshot.topology.cellIndexOffsets] : []),
    ]),
    ...(request.type === "prepare_surface"
      ? []
      : [
          request.geometry.position,
          request.geometry.normal,
          request.geometry.uv,
          request.geometry.index,
          request.data.offsets,
          request.data.rotScaleHash,
          request.data.groundColors,
          request.data.grassTints,
          request.data.groundNormals,
        ]),
  ];
  const buffers = arrays.map((array) => {
    if (!(array.buffer instanceof ArrayBuffer))
      throw new Error("Grounding transport requires owned ArrayBuffers");
    return array.buffer;
  });
  if (new Set(buffers).size !== buffers.length)
    throw new Error(
      "Grounding transport payload fields must not alias buffers",
    );
  return buffers;
}
