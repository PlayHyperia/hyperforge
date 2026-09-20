import type { GrassTerrainSurfaceSnapshot } from "../../../utils/workers/GrassTerrainSurfaceSnapshot";
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
