import type THREE from "../../../extras/three/three";
import {
  GRASS_GROUNDING_WORKER_LIMITS,
  type GrassGroundingWorkerCachedRequest,
} from "../../../utils/workers/GrassGroundingWorkerWire";
import {
  GRASS_BLADE_GROUNDING_LIMITS,
  GRASS_BLADE_GROUNDING_JOB_LIMITS as limits,
  captureGrassBankVerge,
  validateGrassGroundingConsumedWork,
  type GrassBladeGroundingRequest,
  type GrassGroundingConsumedWork,
} from "./GrassBladeGrounding";
import { getGrassBladeLayout } from "./GrassBladeLayout";
import type { GrassGroundingInputLease } from "./GrassGroundingPipeline";
import {
  projectGrassAnchorSteps,
  type GrassAnchorData,
  type GrassGrounding,
} from "./GrassTerrainProjection";
import { RetainedTerrainSurface } from "./TerrainGridSurface";

export type GrassGroundingHandoffRequest = Omit<
  GrassBladeGroundingRequest,
  "terrainSurface" | "roadSegments"
>;

/** Only geometry/data are transferable numerical copies. Surface references and
 * ecological grounding provenance remain owned by the main-thread ticket. */
export type GrassGroundingPreparedInput = Pick<
  GrassGroundingWorkerCachedRequest,
  "geometry" | "data" | "constraints" | "settings"
> & {
  ownSurface: RetainedTerrainSurface;
  surfaces: readonly RetainedTerrainSurface[];
  grounding: GrassGrounding;
  /** Exact geometry/data typed-array payload, not terrain/JS/GPU heap bytes. */
  inputBytes: number;
};

const COPY_ELEMENTS = 1024;
const dataFields = [
  ["offsets", 3],
  ["rotScaleHash", 3],
  ["groundColors", 3],
  ["grassTints", 4],
  ["groundNormals", 3],
] as const;
type NumericArray = Float32Array | Uint16Array | Uint32Array;

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function captureFloatAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  itemSize: number,
  count: number,
) {
  const attribute = geometry.getAttribute(name);
  requireValue(
    attribute &&
      "version" in attribute &&
      attribute.array instanceof Float32Array &&
      attribute.array.buffer instanceof ArrayBuffer &&
      attribute.itemSize === itemSize &&
      attribute.count === count &&
      attribute.array.length === count * itemSize &&
      !attribute.normalized,
    "Invalid handoff blade attribute: " + name,
  );
  const array = attribute.array,
    version = attribute.version;
  return {
    array,
    current: () =>
      geometry.getAttribute(name) === attribute &&
      attribute.array === array &&
      attribute.version === version &&
      attribute.itemSize === itemSize &&
      attribute.count === count &&
      array.length === count * itemSize &&
      !attribute.normalized,
  };
}

function* copyInto(
  source: NumericArray,
  target: NumericArray,
  current: () => void,
  phase: string,
): Generator<string, void, void> {
  for (let offset = 0; offset < source.length; offset += COPY_ELEMENTS) {
    yield phase + "_copy";
    current();
    target.set(
      source.subarray(offset, Math.min(offset + COPY_ELEMENTS, source.length)),
      offset,
    );
    current();
  }
}

function* copyFloat(
  source: Float32Array,
  current: () => void,
  phase: string,
): Generator<string, Float32Array, void> {
  yield phase + "_allocation";
  current();
  const output = new Float32Array(source.length);
  current();
  yield* copyInto(source, output, current, phase);
  return output;
}

function* copyIndex(
  source: Uint16Array | Uint32Array,
  current: () => void,
): Generator<string, Uint16Array | Uint32Array, void> {
  yield "handoff_geometry_index_allocation";
  current();
  const output =
    source instanceof Uint16Array
      ? new Uint16Array(source.length)
      : new Uint32Array(source.length);
  current();
  yield* copyInto(source, output, current, "handoff_geometry_index");
  return output;
}

/** Projection uses the existing numerical kernel and input lease. Copies are
 * exact-sized even when projection/source attributes are subarrays. Every copy
 * batch checks published blade versions/identities; unannounced raw writes are
 * not independently observable. No terrain copy, worker dispatch or remap. */
export function* prepareGrassGroundingHandoffSteps(
  request: GrassGroundingHandoffRequest,
  inputs: GrassGroundingInputLease,
  getWaterSurfaceAt: (x: number, z: number) => number,
  isExcludedAt: (x: number, z: number) => boolean,
  maximumInputBytes = GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes,
): Generator<string, GrassGroundingPreparedInput, void> {
  const bankVerge = captureGrassBankVerge(request);
  const layout = getGrassBladeLayout(request.lod, request.geometryLayout);
  const geometry = request.geometry,
    revision = geometry.uuid;
  const position = captureFloatAttribute(
    geometry,
    "position",
    3,
    layout.verticesPerClump,
  );
  const normal = captureFloatAttribute(
    geometry,
    "normal",
    3,
    layout.verticesPerClump,
  );
  const uv = captureFloatAttribute(geometry, "uv", 2, layout.verticesPerClump);
  const index = geometry.getIndex();
  requireValue(
    index &&
      (index.array instanceof Uint16Array ||
        index.array instanceof Uint32Array) &&
      index.array.buffer instanceof ArrayBuffer &&
      index.itemSize === 1 &&
      !index.normalized &&
      index.count === layout.trianglesPerClump * 3 &&
      index.array.length === index.count,
    "Invalid handoff blade index",
  );
  const indices = index.array,
    indexVersion = index.version,
    indexCount = index.count;
  const drawCount = geometry.drawRange.count;
  requireValue(
    geometry.groups.length === 0 &&
      Object.keys(geometry.morphAttributes).length === 0 &&
      geometry.drawRange.start === 0 &&
      (drawCount === Infinity || drawCount === indexCount),
    "Invalid handoff blade draw range",
  );
  const source = request.data,
    sourceCount = source.count;
  requireValue(
    Number.isSafeInteger(sourceCount) &&
      sourceCount >= 0 &&
      sourceCount <= GRASS_BLADE_GROUNDING_LIMITS.maxClumps,
    "Grass handoff input exceeds clump capacity",
  );
  const sourceArrays = dataFields.map(([key, stride]) => {
    const array = source[key];
    requireValue(
      array instanceof Float32Array &&
        array.buffer instanceof ArrayBuffer &&
        array.length === sourceCount * stride,
      "Invalid handoff source array: " + key,
    );
    return { key, stride, array };
  });
  requireValue(
    Number.isSafeInteger(maximumInputBytes) &&
      maximumInputBytes >= 0 &&
      maximumInputBytes <= GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes,
    "Invalid grass handoff input byte bound",
  );
  requireValue(
    Array.isArray(request.surfaces) &&
      request.surfaces.length > 0 &&
      request.surfaces.length <= GRASS_BLADE_GROUNDING_LIMITS.maxSurfaces,
    "Invalid grass handoff surface count",
  );
  const ownSurface = request.ownSurface,
    surfaces = Object.freeze([...request.surfaces]);
  requireValue(
    ownSurface instanceof RetainedTerrainSurface &&
      surfaces.includes(ownSurface) &&
      new Set(surfaces).size === surfaces.length &&
      surfaces.every(
        (surface) =>
          surface instanceof RetainedTerrainSurface &&
          surface.terrainProfileIdentity === ownSurface.terrainProfileIdentity,
      ),
    "Invalid grass handoff surface owners",
  );
  const clearance = Object.getOwnPropertyDescriptor(request, "roadClearance");
  requireValue(
    !("roadClearance" in request) ||
      Boolean(
        clearance &&
        "value" in clearance &&
        (clearance.value === undefined || clearance.value === "per-blade-v1"),
      ),
    "Invalid handoff road clearance",
  );
  const settings: GrassGroundingPreparedInput["settings"] = {
    lod: request.lod,
    oceanLevel: request.oceanLevel,
    wind: { x: request.wind.x, z: request.wind.z },
    ...(request.geometryLayout === undefined
      ? {}
      : { geometryLayout: request.geometryLayout }),
    ...(clearance?.value === undefined
      ? {}
      : { roadClearance: "per-blade-v1" as const }),
    ...(bankVerge === undefined ? {} : { bankVerge }),
    ...(request.maximumBaseError === undefined
      ? {}
      : { maximumBaseError: request.maximumBaseError }),
    ...(request.workBudget === undefined
      ? {}
      : { workBudget: request.workBudget }),
  };
  const current = () => {
    requireValue(inputs.isCurrent(), "Grass handoff input lease invalidated");
    requireValue(
      request.geometry === geometry &&
        geometry.uuid === revision &&
        position.current() &&
        normal.current() &&
        uv.current() &&
        geometry.getIndex() === index &&
        index.array === indices &&
        index.version === indexVersion &&
        index.itemSize === 1 &&
        !index.normalized &&
        index.count === indexCount &&
        indices.length === indexCount &&
        geometry.drawRange.start === 0 &&
        geometry.drawRange.count === drawCount &&
        geometry.groups.length === 0 &&
        Object.keys(geometry.morphAttributes).length === 0,
      "Grass handoff blade geometry changed",
    );
    requireValue(
      request.data === source &&
        source.count === sourceCount &&
        sourceArrays.every(
          ({ key, stride, array }) =>
            source[key] === array && array.length === sourceCount * stride,
        ),
      "Grass handoff source data changed",
    );
    requireValue(
      request.ownSurface === ownSurface &&
        request.surfaces.length === surfaces.length &&
        surfaces.every((surface, i) => request.surfaces[i] === surface),
      "Grass handoff surface region changed",
    );
  };
  current();
  yield "handoff_admission";
  current();
  const constraints = yield* inputs.steps;
  current();
  const projected = yield* projectGrassAnchorSteps(
    source,
    ownSurface,
    getWaterSurfaceAt,
    isExcludedAt,
  );
  current();
  const inputBytes =
    position.array.byteLength +
    normal.array.byteLength +
    uv.array.byteLength +
    indices.byteLength +
    dataFields.reduce((total, [key]) => total + projected[key].byteLength, 0);
  requireValue(
    Number.isSafeInteger(inputBytes) && inputBytes <= maximumInputBytes,
    "Grass handoff exceeds input byte bound",
  );
  const data: GrassAnchorData = {
    count: projected.count,
    offsets: yield* copyFloat(
      projected.offsets,
      current,
      "handoff_data_offsets",
    ),
    rotScaleHash: yield* copyFloat(
      projected.rotScaleHash,
      current,
      "handoff_data_rotScaleHash",
    ),
    groundColors: yield* copyFloat(
      projected.groundColors,
      current,
      "handoff_data_groundColors",
    ),
    grassTints: yield* copyFloat(
      projected.grassTints,
      current,
      "handoff_data_grassTints",
    ),
    groundNormals: yield* copyFloat(
      projected.groundNormals,
      current,
      "handoff_data_groundNormals",
    ),
  };
  const copiedGeometry: GrassGroundingPreparedInput["geometry"] = {
    position: yield* copyFloat(
      position.array,
      current,
      "handoff_geometry_position",
    ),
    normal: yield* copyFloat(normal.array, current, "handoff_geometry_normal"),
    uv: yield* copyFloat(uv.array, current, "handoff_geometry_uv"),
    index: yield* copyIndex(indices, current),
    drawCount,
  };
  yield "handoff_finalize";
  current();
  return {
    geometry: copiedGeometry,
    data,
    constraints,
    settings,
    ownSurface,
    surfaces,
    grounding: projected.grounding,
    inputBytes,
  };
}

export type GrassGroundingPreparationState =
  | { status: "running" }
  | { status: "prepared"; prepared: GrassGroundingPreparedInput }
  | { status: "failed_budget"; reason: "operations" | "active_cpu" }
  | { status: "failed_input"; error: unknown }
  | { status: "cancelled"; reason: "caller" | "invalidated" };

/** A distinct preparation terminal type, never a fabricated ready grass result.
 * Carry these cumulative counters into the fitting and later remap continuation;
 * reaching another execution owner does not reset the per-job allowance. */
export class GrassGroundingPreparationContinuation {
  private iterator: Generator<string, GrassGroundingPreparedInput, void> | null;
  private current: GrassGroundingPreparationState = { status: "running" };
  operations = 0;
  activeMs = 0;
  lastSliceOperations = 0;
  lastSliceMs = 0;
  maximumSliceMs = 0;
  lastPhase: string | null = null;

  constructor(
    steps: Generator<string, GrassGroundingPreparedInput, void>,
    private readonly isCurrent: () => boolean,
    consumedWork?: GrassGroundingConsumedWork,
  ) {
    this.iterator = steps;
    if (consumedWork !== undefined) {
      const consumed = validateGrassGroundingConsumedWork(consumedWork);
      this.operations = consumed.operations;
      this.activeMs = consumed.activeMs;
      this.maximumSliceMs = consumed.maximumSliceMs;
    }
  }

  get state(): GrassGroundingPreparationState {
    return this.current;
  }

  private close(
    state: GrassGroundingPreparationState,
  ): GrassGroundingPreparationState {
    const iterator = this.iterator;
    this.iterator = null;
    this.current = state;
    iterator?.return(undefined as never);
    return this.current;
  }

  cancel(): GrassGroundingPreparationState {
    return this.current.status === "running"
      ? this.close({ status: "cancelled", reason: "caller" })
      : this.current;
  }

  private recordSlice(started: number): void {
    this.lastSliceMs = performance.now() - started;
    this.activeMs += this.lastSliceMs;
    this.maximumSliceMs = Math.max(this.maximumSliceMs, this.lastSliceMs);
    if (
      this.activeMs >= limits.maximumActiveMs &&
      (this.current.status === "running" || this.current.status === "prepared")
    )
      this.close({ status: "failed_budget", reason: "active_cpu" });
  }

  advance(
    maxOperations: number = limits.maximumSliceOperations,
    sharedDeadlineMs?: number,
  ): GrassGroundingPreparationState {
    if (
      !Number.isSafeInteger(maxOperations) ||
      maxOperations < 1 ||
      maxOperations > limits.maximumSliceOperations
    )
      throw new Error("Invalid grounding preparation slice operation bound");
    if (
      sharedDeadlineMs !== undefined &&
      (!Number.isFinite(sharedDeadlineMs) || sharedDeadlineMs < 0)
    )
      throw new Error("Invalid grounding preparation shared deadline");
    if (this.current.status !== "running") return this.current;
    const started = performance.now(),
      deadline = Math.min(
        sharedDeadlineMs ?? Infinity,
        started + limits.targetSliceMs,
      );
    this.lastSliceOperations = 0;
    let prepared: GrassGroundingPreparedInput | undefined;
    try {
      if (!this.isCurrent())
        return this.close({ status: "cancelled", reason: "invalidated" });
      while (this.iterator && this.lastSliceOperations < maxOperations) {
        if (this.operations >= limits.maximumOperations)
          return this.close({ status: "failed_budget", reason: "operations" });
        if (this.lastSliceOperations % limits.clockInterval === 0) {
          const now = performance.now();
          if (this.activeMs + now - started >= limits.maximumActiveMs)
            return this.close({
              status: "failed_budget",
              reason: "active_cpu",
            });
          if (now >= deadline) break;
        }
        const step = this.iterator.next();
        this.operations++;
        this.lastSliceOperations++;
        if (step.done) {
          prepared = step.value;
          break;
        }
        this.lastPhase = step.value;
      }
      if (!this.isCurrent())
        return this.close({ status: "cancelled", reason: "invalidated" });
      if (prepared) this.close({ status: "prepared", prepared });
    } catch (error) {
      this.close({ status: "failed_input", error });
    } finally {
      this.recordSlice(started);
    }
    return this.current;
  }
}
