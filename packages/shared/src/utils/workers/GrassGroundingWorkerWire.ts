import type { GrassAnchorData } from "../../systems/shared/world/GrassTerrainProjection";
import type {
  GrassBladeGroundingRequest,
  GrassBladeGroundingResult,
  GrassGroundingConsumedWork,
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
    | "bankVerge"
    | "oceanLevel"
    | "wind"
    | "maximumBaseError"
    | "workBudget"
  >;
  consumed: GrassGroundingConsumedWork;
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
            reason: "operations" | "active_cpu" | "grounding_work";
          }
        | { status: "failed_input"; error: string }
        | { status: "cancelled"; reason: "caller" | "invalidated" };
      work: GrassGroundingConsumedWork;
      /** Terminal progress only; never retains input arrays or error graphs. */
      lastPhase: string | null;
      /** Cumulative counter snapshot at the rebuild/fitting boundary, or null
       * if preparation did not finish. The boundary resumption is still active. */
      terrainRebuildWork: GrassGroundingConsumedWork | null;
      inputBytes: number;
      derivedBytesReserved: number;
      resultBytes: number;
      cache?: GrassGroundingWorkerCacheReceipt;
    }
  | {
      type: "surface_prepared";
      jobId: number;
      generation: number;
      state:
        | { status: "prepared"; token: number; sourceRevision: string }
        | { status: "failed_budget"; reason: "operations" | "active_cpu" }
        | { status: "failed_input"; error: string }
        | { status: "cancelled"; reason: "caller" | "invalidated" };
      work: GrassGroundingConsumedWork;
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
