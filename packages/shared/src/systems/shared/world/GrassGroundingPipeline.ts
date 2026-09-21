import type { GrassTerrainSurfaceSnapshot } from "../../../utils/workers/GrassTerrainSurfaceSnapshot";
import type { GrassGroundingWorkerResult } from "../../../utils/workers/GrassGroundingWorkerWire";
import { getGrassBladeLayout } from "./GrassBladeLayout";
import type { RetainedTerrainSurface } from "./TerrainGridSurface";
import {
  GRASS_BLADE_GROUNDING_LIMITS,
  captureGrassBankVerge,
  groundGrassBladeSteps,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
  type GrassGroundingRoadSegment,
} from "./GrassBladeGrounding";
import {
  projectGrassAnchorSteps,
  remapGrassGroundingSteps,
  type GrassGrounding,
} from "./GrassTerrainProjection";

export type GrassGroundingInputLease = {
  /** Other grass constraints invalidate the owning manager ticket. This check
   * additionally leases water-registry state, including newly arriving bodies. */
  isCurrent(): boolean;
  steps: Generator<
    string,
    {
      terrainSurface: GrassTerrainSurfaceSnapshot;
      roadSegments: GrassGroundingRoadSegment[];
    },
    void
  >;
};

type PipelineRequest = Omit<
  GrassBladeGroundingRequest,
  "terrainSurface" | "roadSegments"
>;
type ProjectedGrass =
  ReturnType<typeof projectGrassAnchorSteps> extends Generator<
    string,
    infer Result,
    void
  >
    ? Result
    : never;
type Constraints = {
  terrainSurface: GrassTerrainSurfaceSnapshot;
  roadSegments: GrassGroundingRoadSegment[];
};
type PipelineContext = {
  request: PipelineRequest;
  inputs: GrassGroundingInputLease;
  getWaterSurfaceAt: (x: number, z: number) => number;
  isExcludedAt: (x: number, z: number) => boolean;
};

/** Only phase boundaries execute pipeline control. Child yields pass through
 * directly instead of allocating/resuming an outer generator per blade step.
 * The existing continuation still sees exactly the same labels and resumptions. */
class GroundedGrassPipeline implements Generator<
  string,
  GrassBladeGroundingResult,
  void
> {
  private phase:
    | "initial"
    | "admission"
    | "inputs"
    | "project"
    | "blades"
    | "remap"
    | "closed" = "initial";
  private active: Generator<string, unknown, void> | null = null;
  private constraints: Constraints | null = null;
  private projected: ProjectedGrass | null = null;
  private result: Extract<
    GrassBladeGroundingResult,
    { status: "ready" }
  > | null = null;
  private running = false;
  private bankVerge: ReturnType<typeof captureGrassBankVerge>;

  constructor(private context: PipelineContext | null) {}

  [Symbol.iterator](): Generator<string, GrassBladeGroundingResult, void> {
    return this;
  }

  private close(): void {
    this.phase = "closed";
    this.active = null;
    this.constraints = null;
    this.projected = null;
    this.result = null;
    this.bankVerge = undefined;
    this.context = null;
  }

  next(): IteratorResult<string, GrassBladeGroundingResult> {
    return this.resume("next");
  }

  return(
    value: GrassBladeGroundingResult,
  ): IteratorResult<string, GrassBladeGroundingResult> {
    return this.resume("return", value);
  }

  throw(error: unknown): IteratorResult<string, GrassBladeGroundingResult> {
    return this.resume("throw", error);
  }

  private resume(
    method: "next" | "return" | "throw",
    value?: unknown,
  ): IteratorResult<string, GrassBladeGroundingResult> {
    // Keep native generator reentrancy semantics without closing an executing
    // outer call when its callback catches this error itself.
    if (this.running) throw new TypeError("Generator is already running");
    this.running = true;
    try {
      if (!this.active) {
        if (method === "throw") throw value;
        if (method === "return") {
          this.close();
          return { done: true, value: value as GrassBladeGroundingResult };
        }
        if (this.phase === "closed")
          return { done: true, value: undefined as never };
        if (this.phase === "initial") {
          // Snapshot nested optional wear before even the admission yield;
          // caller edits cannot change deformation during any suspension.
          this.bankVerge = captureGrassBankVerge(this.context!.request);
          this.phase = "admission";
          return { done: false, value: "pipeline_admission" };
        }
        const { request, inputs } = this.context!;
        if (
          !Number.isSafeInteger(request.data.count) ||
          request.data.count < 0 ||
          request.data.count > GRASS_BLADE_GROUNDING_LIMITS.maxClumps
        )
          throw new Error("Grass installation input exceeds clump capacity");
        this.phase = "inputs";
        this.active = inputs.steps;
      }
      let step =
        method === "return"
          ? this.active.return(value)
          : method === "throw"
            ? this.active.throw(value)
            : this.active.next();
      // A delegated return that yields from finally stays suspended. A later
      // normal next resumes normal delegation, just like native yield*.
      if (!step.done) return step;
      if (method === "return") {
        this.close();
        return step as IteratorReturnResult<GrassBladeGroundingResult>;
      }
      while (step.done) {
        const context = this.context!;
        switch (this.phase) {
          case "inputs":
            this.constraints = step.value as Constraints;
            this.phase = "project";
            this.active = projectGrassAnchorSteps(
              context.request.data,
              context.request.ownSurface,
              context.getWaterSurfaceAt,
              context.isExcludedAt,
            );
            break;
          case "project":
            this.projected = step.value as ProjectedGrass;
            this.phase = "blades";
            this.active = groundGrassBladeSteps({
              ...context.request,
              ...this.constraints!,
              data: this.projected,
              bankVerge: this.bankVerge,
            });
            break;
          case "blades": {
            const result = step.value as GrassBladeGroundingResult;
            if (result.status !== "ready") {
              this.close();
              return { done: true, value: result };
            }
            this.result = result;
            this.phase = "remap";
            this.active = remapGrassGroundingSteps(
              this.projected!.grounding,
              result.sourceIndices,
            );
            break;
          }
          case "remap": {
            const result = {
              ...this.result!,
              grounding: step.value as GrassGrounding,
            };
            this.close();
            return { done: true, value: result };
          }
          default:
            throw new Error("Invalid grass grounding pipeline phase");
        }
        step = this.active.next();
      }
      return step;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.running = false;
    }
  }
}

/** All input copying, projection, per-blade fitting and provenance compaction
 * share one continuation budget. No renderer-facing publication occurs here. */
export function prepareGroundedGrassSteps(
  request: PipelineRequest,
  inputs: GrassGroundingInputLease,
  getWaterSurfaceAt: (x: number, z: number) => number,
  isExcludedAt: (x: number, z: number) => boolean,
): Generator<string, GrassBladeGroundingResult, void> {
  return new GroundedGrassPipeline({
    request,
    inputs,
    getWaterSurfaceAt,
    isExcludedAt,
  });
}

/** Main-owned evidence captured before transfer. Tokens belong to this worker
 * lifetime; revisions alone never establish ownership of a rendered surface. */
export type GrassGroundingPublicationLease = Pick<
  GrassBladeGroundingRequest,
  "ownSurface" | "lod" | "geometryLayout" | "roadClearance"
> & {
  surfaces: readonly { token: number; surface: RetainedTerrainSurface }[];
  grounding: GrassGrounding;
};

/** Resume on the main scheduler with the worker's cumulative work, including
 * main dispatch/receive charges. The surrounding continuation must lease the
 * complete original region and constraints, including newly arriving owners.
 * This never creates a mesh or accepts a wire dependency as a live owner. */
export function* finishGroundedGrassWorkerSteps(
  result: GrassGroundingWorkerResult,
  lease: GrassGroundingPublicationLease,
): Generator<string, GrassBladeGroundingResult, void> {
  yield "worker_publication_admission";
  const { grounding, ownSurface, surfaces } = lease;
  const inputCount = grounding.computedHeights.length;
  const layout = getGrassBladeLayout(lease.lod, lease.geometryLayout);
  if (
    grounding.schemaVersion !== 1 ||
    grounding.surfaceRevision !== ownSurface.revision ||
    !(grounding.computedHeights instanceof Float32Array) ||
    !(grounding.ecologicalNormals instanceof Float32Array) ||
    grounding.ecologicalNormals.length !== inputCount * 3 ||
    inputCount > GRASS_BLADE_GROUNDING_LIMITS.maxClumps ||
    !surfaces.length ||
    surfaces.length > GRASS_BLADE_GROUNDING_LIMITS.maxSurfaces ||
    !surfaces.some((owner) => owner.surface === ownSurface) ||
    new Set(surfaces.map((owner) => owner.surface)).size !== surfaces.length
  )
    throw new Error("Invalid main-owned grounding publication lease");

  const owners = new Map<number, RetainedTerrainSurface>();
  for (const { token, surface } of surfaces) {
    yield "worker_publication_owner";
    if (
      !Number.isSafeInteger(token) ||
      token < 1 ||
      owners.has(token) ||
      surface.terrainProfileIdentity !== ownSurface.terrainProfileIdentity
    )
      throw new Error("Invalid grounding publication owner token");
    // Constant-time held-buffer revision check; never copy or rebuild terrain.
    surface.snapshotByteLength();
    owners.set(token, surface);
  }
  if (result.dependencies.length > surfaces.length)
    throw new Error("Invalid grounding publication dependency count");
  const dependencies: GrassBladeGroundingResult["dependencies"][number][] = [];
  const seen = new Set<number>();
  for (const dependency of result.dependencies) {
    yield "worker_publication_dependency";
    const surface = owners.get(dependency.token);
    if (
      !surface ||
      seen.has(dependency.token) ||
      dependency.sourceRevision !== surface.revision ||
      dependency.uses.length < 1 ||
      dependency.uses.length > 3 ||
      new Set(dependency.uses).size !== dependency.uses.length ||
      dependency.uses.some(
        (use) => use !== "endpoint" && use !== "edge" && use !== "envelope",
      )
    )
      throw new Error("Foreign or stale grounding publication dependency");
    seen.add(dependency.token);
    dependencies.push({ surface, uses: [...dependency.uses] });
  }
  const receipt = result.receipt;
  if (
    receipt.inputClumps !== inputCount ||
    receipt.bladesPerClump !== layout.bladesPerClump ||
    receipt.geometryLayout !== lease.geometryLayout ||
    receipt.roadClearance?.mode !== lease.roadClearance
  )
    throw new Error("Grounding publication request/receipt mismatch");
  if (result.status === "defer") return { ...result, dependencies };

  const { data, rootDeltas, sourceIndices, bladeVisibility, sweptBounds } =
    result;
  const count = data.count;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > inputCount ||
    receipt.processedClumps !== inputCount ||
    receipt.retainedClumps !== count ||
    !(rootDeltas instanceof Float32Array) ||
    rootDeltas.length !== count * layout.bladesPerClump * 2 ||
    rootDeltas.byteLength !== receipt.correctionBytes ||
    !(sourceIndices instanceof Uint32Array) ||
    sourceIndices.length !== count ||
    (lease.roadClearance
      ? !(bladeVisibility instanceof Uint32Array) ||
        bladeVisibility.length !== count ||
        receipt.roadClearance?.visibilityBytes !== bladeVisibility.byteLength
      : bladeVisibility !== undefined) ||
    (count === 0
      ? sweptBounds !== null
      : !sweptBounds ||
        ![
          sweptBounds.minX,
          sweptBounds.maxX,
          sweptBounds.minY,
          sweptBounds.maxY,
          sweptBounds.minZ,
          sweptBounds.maxZ,
        ].every(Number.isFinite) ||
        sweptBounds.minX > sweptBounds.maxX ||
        sweptBounds.minY > sweptBounds.maxY ||
        sweptBounds.minZ > sweptBounds.maxZ)
  )
    throw new Error("Invalid grounding publication output layout");

  const floats: Float32Array[] = [rootDeltas];
  for (const [key, stride] of [
    ["offsets", 3],
    ["rotScaleHash", 3],
    ["groundColors", 3],
    ["grassTints", 4],
    ["groundNormals", 3],
  ] as const) {
    const array = data[key];
    if (!(array instanceof Float32Array) || array.length !== count * stride)
      throw new Error("Invalid grounding publication instance layout");
    floats.push(array);
  }
  for (const array of floats) {
    for (let start = 0; start < array.length; start += 1024) {
      yield "worker_publication_values";
      const end = Math.min(start + 1024, array.length);
      for (let i = start; i < end; i++)
        if (!Number.isFinite(array[i]))
          throw new Error("Nonfinite grounding publication value");
    }
  }
  if (bladeVisibility) {
    const allBlades = (1 << layout.bladesPerClump) - 1;
    let retainedBlades = 0,
      partialClumps = 0;
    for (let start = 0; start < count; start += 256) {
      yield "worker_publication_visibility";
      const end = Math.min(start + 256, count);
      for (let i = start; i < end; i++) {
        let bits = bladeVisibility[i];
        if (!bits || (bits & ~allBlades) !== 0)
          throw new Error("Invalid grounding publication blade visibility");
        if (bits !== allBlades) partialClumps++;
        while (bits) {
          bits &= bits - 1;
          retainedBlades++;
        }
      }
    }
    const roads = receipt.roadClearance!;
    if (
      roads.retainedBlades !== retainedBlades ||
      roads.partialClumps !== partialClumps ||
      roads.maskedRetainedBlades !==
        count * layout.bladesPerClump - retainedBlades
    )
      throw new Error("Grounding publication blade receipt mismatch");
  }
  const remapped = yield* remapGrassGroundingSteps(grounding, sourceIndices);
  return { ...result, dependencies, grounding: remapped };
}
