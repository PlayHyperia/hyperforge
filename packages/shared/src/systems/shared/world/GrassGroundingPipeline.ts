import type { GrassTerrainSurfaceSnapshot } from "../../../utils/workers/GrassTerrainSurfaceSnapshot";
import {
  GRASS_BLADE_GROUNDING_LIMITS,
  groundGrassBladeSteps,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
  type GrassGroundingRoadSegment,
} from "./GrassBladeGrounding";
import {
  projectGrassAnchorSteps,
  remapGrassGroundingSteps,
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

/** All input copying, projection, per-blade fitting and provenance compaction
 * share one continuation budget. No renderer-facing publication occurs here. */
export function* prepareGroundedGrassSteps(
  request: Omit<GrassBladeGroundingRequest, "terrainSurface" | "roadSegments">,
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
