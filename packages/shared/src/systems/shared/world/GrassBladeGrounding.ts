import type THREE from "../../../extras/three/three";
import {
  createGrassTerrainSurfaceOperations,
  type GrassTerrainSurfaceSnapshot,
} from "../../../utils/workers/GrassTerrainSurfaceSnapshot";
import type { GrassAnchorData, GrassGrounding } from "./GrassTerrainProjection";
import { roadInfluenceOperations } from "./RoadInfluence";
import {
  createCompactTerrainColorOperations,
  type CompactTerrainBankVerge,
} from "./CompactTerrainPalette";
import {
  getGrassBladeLayout,
  getGrassBladeWindFactor,
  getFoldedGrassBladeIndices,
  isFoldedGrassBladeLayout,
  type FineGrassGeometryLayout,
} from "./GrassBladeLayout";
import {
  RetainedTerrainSurface,
  type TerrainGridBounds,
  type TerrainGridHeightSample,
  type TerrainGridSample,
  type TerrainGridTriangle,
} from "./TerrainGridSurface";

export const GRASS_BLADE_GROUNDING_LIMITS = Object.freeze({
  maxClumps: 4096,
  maxSurfaces: 16,
  maxRoadSegments: 4096,
  maxScale: 4,
  defaultWorkBudget: 1_000_000,
  maximumWorkBudget: 1_000_000,
});

const NUMERIC_GUARD = 0.00001;
// Bound cheap validation work without allocating an iterator result per float.
// This is not the geometric work budget, which still charges every take().
const INSTANCE_VALUE_BATCH_SIZE = 32;
// Each indexed cursor step is bounded and validates the retained geometry.
// Share one suspension across four steps without skipping any work charge.
const INDEXED_EDGE_STEP_BATCH_SIZE = 4;
// Fixed storage, independent of authored road lengths or world coordinates.
const ROAD_GRID_AXIS = 8;
const compactTerrainColorOperations = createCompactTerrainColorOperations();

export type GrassGroundingRoadSegment = {
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  width: number;
  /** Missing retains the original 0.5m fade, including its exact inverse. */
  blendWidth?: number;
  /** Missing retains full road exclusion; partial shoulders may stay grassy. */
  maxInfluence?: number;
};

export type GrassBladeGroundingRequest = {
  /** Already projected by projectGrassAnchors; never mutated or reseeded. */
  data: GrassAnchorData;
  geometry: THREE.BufferGeometry;
  lod: 0 | 1 | 2;
  /** Omission is the ordinary layout, not automatic fine topology detection. */
  geometryLayout?: FineGrassGeometryLayout;
  /** Explicit candidate: retain only blades whose full sweep clears roads. */
  roadClearance?: "per-blade-v1";
  /** Explicit fine-meadow vertical deformation; never changes root sampling. */
  bankVerge?: CompactTerrainBankVerge;
  /** Bounded service wear; root admission is unchanged. */
  pondServiceGround?: CompactTerrainBankVerge;
  ownSurface: RetainedTerrainSurface;
  /** Exact currently drawn own/neighbour surfaces, with no parent overlap. */
  surfaces: readonly RetainedTerrainSurface[];
  terrainSurface: GrassTerrainSurfaceSnapshot;
  roadSegments: readonly GrassGroundingRoadSegment[];
  oceanLevel: number;
  /** Absolute world-X/Z wind amplitudes, not direction or normalized values. */
  wind: { x: number; z: number };
  maximumBaseError?: number;
  workBudget?: number;
};

/** Snapshot the optional art descriptor before a resumable job borrows it.
 * Reject inherited/accessor fields instead of executing mutable input code. */
export function captureGrassBankVerge(
  request: Pick<
    GrassBladeGroundingRequest,
    "bankVerge" | "pondServiceGround" | "geometryLayout"
  >,
  fieldName: "bankVerge" | "pondServiceGround" = "bankVerge",
): CompactTerrainBankVerge | undefined {
  const captured = compactTerrainColorOperations.captureGroundVerge(
    request,
    fieldName,
  );
  if (
    captured &&
    request.geometryLayout !== "fine-linear-sweep-3seg-v1" &&
    request.geometryLayout !== "fine-linear-sweep-near4-v1" &&
    request.geometryLayout !== "fine-folded-lancet-v1" &&
    request.geometryLayout !== "fine-folded-sheath-near5-v1"
  )
    throw new Error("Invalid grass bank-verge descriptor");
  return captured;
}

type DeferredReason = "missing_surface" | "overlapping_surface" | "work_budget";
type SurfaceUse = "endpoint" | "edge" | "envelope";
type RejectionReason = "terrain_edge" | "pad" | "road" | "water";

export type GrassBladeGroundingDependency = {
  surface: RetainedTerrainSurface;
  uses: readonly SurfaceUse[];
};

export type GrassBladeGroundingReceipt = {
  elapsedMs: number;
  inputClumps: number;
  processedClumps: number;
  retainedClumps: number;
  bladesPerClump: number;
  geometryLayout?: FineGrassGeometryLayout;
  endpointQueries: number;
  triangleVisits: number;
  /** Base edges proved strictly inside their one retained sampled face. */
  sameFaceEdges: number;
  /** Subset of sameFaceEdges admitted by the refined whole-cell certificate. */
  refinedSameFaceEdges: number;
  workUnits: number;
  workBudget: number;
  correctionBytes: number;
  roadClearance?: {
    mode: "per-blade-v1";
    retainedBlades: number;
    partialClumps: number;
    maskedRetainedBlades: number;
    visibilityBytes: number;
  };
  maxEndpointCorrection: number;
  maxCorrectedBaseError: number;
  maxAcceptedBaseError: number;
  rejected: Record<RejectionReason, number>;
};

export type GrassBladeGroundingResult =
  | {
      status: "ready";
      data: GrassAnchorData;
      /** Two world-Y deltas per blade: left/right. Apply after tilt, never fade. */
      rootDeltas: Float32Array;
      /** Optional bit per blade, compacted with data/sourceIndices. */
      bladeVisibility?: Uint32Array;
      sourceIndices: Uint32Array;
      /** Accepted world-space vertices through the complete fade/wind envelope.
       * Null means validated empty output, never missing or deferred support. */
      sweptBounds: (TerrainGridBounds & { minY: number; maxY: number }) | null;
      /** Present only after the installation pipeline remaps source evidence. */
      grounding?: GrassGrounding;
      dependencies: readonly GrassBladeGroundingDependency[];
      receipt: GrassBladeGroundingReceipt;
    }
  | {
      status: "defer";
      reason: DeferredReason;
      dependencies: readonly GrassBladeGroundingDependency[];
      receipt: GrassBladeGroundingReceipt;
    };

class DeferredGrounding extends Error {
  constructor(readonly reason: DeferredReason) {
    super(reason);
  }
}

type Point = { x: number; y: number; z: number };
type SurfaceEntry = { surface: RetainedTerrainSurface; box: TerrainGridBounds };
type EndpointFace = {
  surface: RetainedTerrainSurface | null;
  faceIndex: number;
};

function overlaps(a: TerrainGridBounds, b: TerrainGridBounds): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ
  );
}

function overlapArea(a: TerrainGridBounds, b: TerrainGridBounds): number {
  return (
    Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) *
    Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ))
  );
}

function pointBoxDistance(x: number, z: number, b: TerrainGridBounds): number {
  return Math.hypot(
    Math.max(b.minX - x, 0, x - b.maxX),
    Math.max(b.minZ - z, 0, z - b.maxZ),
  );
}

function segmentBoxDistance(
  s: GrassGroundingRoadSegment,
  b: TerrainGridBounds,
): number {
  let lo = 0,
    hi = 1;
  // Keep the exact axis/corner order without short-lived tuple arrays in the
  // per-clump road loop. These temporaries scale with clumps × road segments.
  for (let axis = 0; axis < 2; axis++) {
    const start = axis === 0 ? s.startX : s.startZ,
      end = axis === 0 ? s.endX : s.endZ,
      min = axis === 0 ? b.minX : b.minZ,
      max = axis === 0 ? b.maxX : b.maxZ;
    const d = end - start;
    if (!d) {
      if (start < min || start > max) {
        lo = 1;
        hi = 0;
        break;
      }
    } else {
      const a = (min - start) / d,
        c = (max - start) / d;
      lo = Math.max(lo, Math.min(a, c));
      hi = Math.min(hi, Math.max(a, c));
    }
  }
  if (lo <= hi) return 0;
  const dx = s.endX - s.startX,
    dz = s.endZ - s.startZ,
    lengthSquared = dx * dx + dz * dz;
  let distance = Math.min(
    pointBoxDistance(s.startX, s.startZ, b),
    pointBoxDistance(s.endX, s.endZ, b),
  );
  for (let corner = 0; corner < 4; corner++) {
    const x = corner < 2 ? b.minX : b.maxX,
      z = corner % 2 === 0 ? b.minZ : b.maxZ;
    const numerator = (x - s.startX) * dx + (z - s.startZ) * dz;
    if (!Number.isFinite(numerator))
      throw new Error("Grass grounding road projection overflow");
    const t =
      lengthSquared < 0.001
        ? 0
        : Math.max(0, Math.min(1, numerator / lengthSquared));
    distance = Math.min(
      distance,
      Math.hypot(x - s.startX - t * dx, z - s.startZ - t * dz),
    );
  }
  if (!Number.isFinite(distance))
    throw new Error("Grass grounding road distance overflow");
  return distance;
}

function* validateGeometry(
  geometry: THREE.BufferGeometry,
  lod: 0 | 1 | 2,
  geometryLayout?: FineGrassGeometryLayout,
) {
  const {
    bladesPerClump: blades,
    bladeSegments: segments,
    verticesPerBlade,
    trianglesPerClump,
  } = getGrassBladeLayout(lod, geometryLayout);
  const folded = isFoldedGrassBladeLayout(lod, geometryLayout);
  const vertices = blades * verticesPerBlade;
  const position = geometry.getAttribute("position"),
    normal = geometry.getAttribute("normal"),
    uv = geometry.getAttribute("uv"),
    index = geometry.getIndex();
  for (const [attribute, size] of [
    [position, 3],
    [normal, 3],
    [uv, 2],
  ] as const) {
    if (
      !attribute ||
      !("version" in attribute) ||
      !(attribute.array instanceof Float32Array) ||
      attribute.itemSize !== size ||
      attribute.count !== vertices ||
      attribute.normalized
    )
      throw new Error("Invalid grass grounding vertex attributes");
    for (const value of attribute.array) {
      yield "geometry_value";
      if (!Number.isFinite(value))
        throw new Error("Invalid grass grounding vertex attributes");
    }
  }
  if (
    !index ||
    index.itemSize !== 1 ||
    index.normalized ||
    index.count !== trianglesPerClump * 3 ||
    geometry.groups.length ||
    Object.keys(geometry.morphAttributes).length ||
    geometry.drawRange.start !== 0 ||
    (geometry.drawRange.count !== Infinity &&
      geometry.drawRange.count !== index.count)
  )
    throw new Error("Invalid grass grounding triangle layout");
  let cursor = 0;
  const expectIndex = (value: number) => {
    if (index.getX(cursor++) !== value)
      throw new Error("Invalid grass grounding triangle order");
  };
  for (let blade = 0; blade < blades; blade++) {
    yield "geometry_blade";
    const first = blade * verticesPerBlade;
    for (let row = 0; row < segments; row++) {
      for (let side = 0; side < 2; side++) {
        const v = first + row * 2 + side;
        if (
          uv.getX(v) !== side ||
          uv.getY(v) !== Math.fround(row / segments) ||
          (row === 0 && position.getY(v) !== 0)
        )
          throw new Error("Invalid grass grounding blade topology");
      }
    }
    const tip = first + segments * 2;
    if (
      uv.getX(tip) !== 0.5 ||
      uv.getY(tip) !== 1 ||
      Math.hypot(
        position.getX(first) - position.getX(first + 1),
        position.getZ(first) - position.getZ(first + 1),
      ) <= 0
    )
      throw new Error("Invalid grass grounding blade root");
    if (folded) {
      for (let row = 1; row < segments; row++) {
        const center = tip + row;
        if (
          uv.getX(center) !== 0.5 ||
          uv.getY(center) !== Math.fround(row / segments) ||
          position.getY(center) !== position.getY(first + row * 2)
        )
          throw new Error("Invalid grass grounding folded center topology");
      }
      for (const value of getFoldedGrassBladeIndices(segments))
        expectIndex(first + value);
    } else {
      for (let row = 0; row < segments - 1; row++) {
        const a = first + row * 2;
        for (const value of [a, a + 1, a + 2, a + 1, a + 3, a + 2])
          expectIndex(value);
      }
      for (const value of [tip - 2, tip - 1, tip]) expectIndex(value);
    }
  }
  for (let v = 0; v < vertices; v++) {
    yield "geometry_vertex";
    if (
      position.getY(v) < 0 ||
      Math.hypot(position.getX(v), position.getY(v), position.getZ(v)) > 16
    )
      throw new Error("Grass grounding geometry exceeds bounded envelope");
  }
  return { blades, verticesPerBlade, position, uv };
}

/**
 * CPU-only prospective worker/sync installation seam. Never changes sampling,
 * RNG, geometry or input attributes. Callers must revalidate every returned
 * surface identity against its live owner before publication and on replacement.
 *
 * Suspension points retain the exact math cursor. The old total-work limit
 * still terminates the input epoch; a deferred result is never restarted here.
 * Outer GrassBladeGroundingJob additionally charges validation, sorting and copies.
 */
export function* groundGrassBladeSteps(
  request: GrassBladeGroundingRequest,
): Generator<string, GrassBladeGroundingResult, void> {
  yield "request_bounds";
  const started = performance.now();
  const { data, ownSurface, geometry, lod, wind, geometryLayout } = request;
  const bankVerge = captureGrassBankVerge(request);
  const pondServiceGround = captureGrassBankVerge(request, "pondServiceGround");
  const bankField =
    bankVerge || pondServiceGround
      ? { coastalMeadow: true as const, bankVerge, pondServiceGround }
      : null;
  const clearanceProperty = Object.getOwnPropertyDescriptor(
    request,
    "roadClearance",
  );
  if (
    "roadClearance" in request &&
    (!clearanceProperty ||
      !("value" in clearanceProperty) ||
      (clearanceProperty.value !== undefined &&
        clearanceProperty.value !== "per-blade-v1"))
  )
    throw new Error("Invalid grass road-clearance mode");
  const perBladeRoads = clearanceProperty?.value === "per-blade-v1";
  const workBudget =
    request.workBudget ?? GRASS_BLADE_GROUNDING_LIMITS.defaultWorkBudget;
  const maximumBaseError = request.maximumBaseError ?? 0.02;
  if (
    !Number.isSafeInteger(data.count) ||
    data.count < 0 ||
    data.count > GRASS_BLADE_GROUNDING_LIMITS.maxClumps ||
    !Number.isSafeInteger(workBudget) ||
    workBudget < 1 ||
    workBudget > GRASS_BLADE_GROUNDING_LIMITS.maximumWorkBudget ||
    !Number.isFinite(maximumBaseError) ||
    maximumBaseError < 0 ||
    maximumBaseError > 0.05 ||
    !Number.isFinite(request.oceanLevel) ||
    ![wind.x, wind.z].every((v) => Number.isFinite(v) && v >= 0 && v <= 8)
  )
    throw new Error("Invalid grass grounding request bounds");
  for (const [key, stride] of [
    ["offsets", 3],
    ["rotScaleHash", 3],
    ["groundColors", 3],
    ["grassTints", 4],
    ["groundNormals", 3],
  ] as const) {
    const values = data[key];
    if (
      !(values instanceof Float32Array) ||
      values.length !== data.count * stride
    )
      throw new Error("Invalid grass grounding instance buffers");
    for (
      let start = 0;
      start < values.length;
      start += INSTANCE_VALUE_BATCH_SIZE
    ) {
      yield "instance_value";
      const end = Math.min(start + INSTANCE_VALUE_BATCH_SIZE, values.length);
      for (let index = start; index < end; index++) {
        if (!Number.isFinite(values[index]))
          throw new Error("Nonfinite grass grounding instance value");
      }
    }
  }
  for (let i = 0; i < data.count; i++) {
    yield "instance_transform";
    const k = i * 3;
    if (
      data.rotScaleHash[k] < 0 ||
      data.rotScaleHash[k] > Math.PI * 2 + 0.000001 ||
      data.rotScaleHash[k + 1] <= 0 ||
      data.rotScaleHash[k + 1] > GRASS_BLADE_GROUNDING_LIMITS.maxScale ||
      data.groundNormals[k + 1] <= 0 ||
      Math.abs(
        Math.hypot(
          data.groundNormals[k],
          data.groundNormals[k + 1],
          data.groundNormals[k + 2],
        ) - 1,
      ) > 0.0001
    )
      throw new Error("Invalid grass grounding instance transform");
  }
  if (
    !(ownSurface instanceof RetainedTerrainSurface) ||
    !Array.isArray(request.surfaces) ||
    !request.surfaces.length ||
    request.surfaces.length > GRASS_BLADE_GROUNDING_LIMITS.maxSurfaces ||
    new Set(request.surfaces).size !== request.surfaces.length ||
    !request.surfaces.includes(ownSurface) ||
    request.surfaces.some(
      (s) =>
        !(s instanceof RetainedTerrainSurface) ||
        s.terrainProfileIdentity !== ownSurface.terrainProfileIdentity,
    )
  )
    throw new Error("Invalid grass grounding surface identities");
  const surfaceOperations = createGrassTerrainSurfaceOperations();
  const snapshot = yield* surfaceOperations.validateSnapshotSteps(
    request.terrainSurface,
  );
  if (
    !Array.isArray(request.roadSegments) ||
    request.roadSegments.length > GRASS_BLADE_GROUNDING_LIMITS.maxRoadSegments
  )
    throw new Error("Invalid grass grounding road count");
  for (const road of request.roadSegments) {
    yield "road_validation";
    const dx = road.endX - road.startX,
      dz = road.endZ - road.startZ;
    if (
      ![road.startX, road.startZ, road.endX, road.endZ, road.width].every(
        Number.isFinite,
      ) ||
      ![dx, dz, dx * dx + dz * dz].every(Number.isFinite) ||
      road.width <= 0 ||
      road.width > 1024
    )
      throw new Error("Invalid grass grounding road segment");
    for (const key of ["blendWidth", "maxInfluence"] as const) {
      if (!(key in road)) continue;
      const property = Object.getOwnPropertyDescriptor(road, key);
      if (
        !property ||
        !("value" in property) ||
        typeof property.value !== "number" ||
        !Number.isFinite(property.value) ||
        property.value < 0 ||
        property.value > (key === "blendWidth" ? 1024 : 1)
      )
        throw new Error("Invalid grass grounding road influence profile");
    }
  }
  const { blades, verticesPerBlade, position, uv } = yield* validateGeometry(
    geometry,
    lod,
    geometryLayout,
  );
  const entries: SurfaceEntry[] = request.surfaces.map((surface) => ({
    surface,
    box: {
      minX: surface.centerX - surface.size / 2,
      maxX: surface.centerX + surface.size / 2,
      minZ: surface.centerZ - surface.size / 2,
      maxZ: surface.centerZ + surface.size / 2,
    },
  }));
  // Distinct job-local scratch: never clear the full surface-owner list.
  const baseEntries: SurfaceEntry[] = [];
  const baseBounds: TerrainGridBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  const box: TerrainGridBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  const used = new Map<RetainedTerrainSurface, Set<SurfaceUse>>();
  const receipt: GrassBladeGroundingReceipt = {
    elapsedMs: 0,
    inputClumps: data.count,
    processedClumps: 0,
    retainedClumps: 0,
    bladesPerClump: blades,
    ...(geometryLayout === undefined ? {} : { geometryLayout }),
    endpointQueries: 0,
    triangleVisits: 0,
    sameFaceEdges: 0,
    refinedSameFaceEdges: 0,
    workUnits: 0,
    workBudget,
    correctionBytes: 0,
    ...(perBladeRoads
      ? {
          roadClearance: {
            mode: "per-blade-v1" as const,
            retainedBlades: 0,
            partialClumps: 0,
            maskedRetainedBlades: 0,
            visibilityBytes: 0,
          },
        }
      : {}),
    maxEndpointCorrection: 0,
    maxCorrectedBaseError: 0,
    maxAcceptedBaseError: 0,
    rejected: { terrain_edge: 0, pad: 0, road: 0, water: 0 },
  };
  const take = (units = 1) => {
    if (receipt.workUnits + units > workBudget)
      throw new DeferredGrounding("work_budget");
    receipt.workUnits += units;
  };
  const markSurface = (surface: RetainedTerrainSurface, kind: SurfaceUse) => {
    let kinds = used.get(surface);
    if (!kinds) {
      kinds = new Set();
      used.set(surface, kinds);
    }
    kinds.add(kind);
  };
  const dependencies = () =>
    [...used].map(([surface, uses]) => ({ surface, uses: [...uses] }));
  const finish = () => {
    receipt.elapsedMs = performance.now() - started;
    return receipt;
  };
  const sample: TerrainGridSample = {
    height: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    faceIndex: 0,
  };
  const endpointSample: TerrainGridHeightSample = { height: 0, faceIndex: 0 };
  const leftFace: EndpointFace = { surface: null, faceIndex: -1 },
    rightFace: EndpointFace = { surface: null, faceIndex: -1 };
  let disjointSurfaceBoxes: boolean | undefined;
  const ensureCoverage = function* (box: TerrainGridBounds) {
    if (disjointSurfaceBoxes === undefined) {
      // Owner boxes are fixed job-local snapshots. Certify their disjointness
      // once; touching boundaries are safe, but any positive overlap retains
      // the original per-clump overlap/dependency checks below.
      let disjoint = true;
      ownerPairs: for (let i = 0; i < entries.length; i++) {
        const a = entries[i].box;
        for (let j = i + 1; j < entries.length; j++) {
          yield "coverage_owner_pair";
          take();
          const b = entries[j].box;
          if (
            Math.max(a.minX, b.minX) < Math.min(a.maxX, b.maxX) &&
            Math.max(a.minZ, b.minZ) < Math.min(a.maxZ, b.maxZ)
          ) {
            disjoint = false;
            break ownerPairs;
          }
        }
      }
      disjointSurfaceBoxes = disjoint;
    }
    let covered = 0;
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      yield "coverage_owner";
      take();
      const area = overlapArea(box, a.box);
      if (!area) continue;
      markSurface(a.surface, "envelope");
      covered += area;
      if (disjointSurfaceBoxes) continue;
      for (let j = i + 1; j < entries.length; j++) {
        yield "coverage_overlap";
        take();
        const b = entries[j];
        const intersection = {
          minX: Math.max(a.box.minX, b.box.minX),
          maxX: Math.min(a.box.maxX, b.box.maxX),
          minZ: Math.max(a.box.minZ, b.box.minZ),
          maxZ: Math.min(a.box.maxZ, b.box.maxZ),
        };
        if (
          intersection.minX < intersection.maxX &&
          intersection.minZ < intersection.maxZ &&
          overlapArea(box, intersection) > 1e-8
        ) {
          markSurface(b.surface, "envelope");
          throw new DeferredGrounding("overlapping_surface");
        }
      }
    }
    const expected = (box.maxX - box.minX) * (box.maxZ - box.minZ);
    if (Math.abs(covered - expected) > Math.max(1e-7, expected * 1e-7))
      throw new DeferredGrounding("missing_surface");
  };
  // Job-local scratch never escapes into output or dependencies. An edge query
  // is fully drained before the next blade, including across suspended slices.
  const triangle: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const canonicalBounds: TerrainGridBounds = {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
  };
  const sameFaceEdgeError = (a: Point, b: Point): number | null => {
    // A convex face contains the entire segment when both endpoints are safely
    // interior. Keep the original clipper for boundaries, multiple owners and
    // poorly conditioned arithmetic. Refined faces require the separate
    // whole-cell certificate: endpoint equality alone cannot exclude a thin
    // neighbour's clipping tolerance.
    // An indexed owner may contain untouched canonical cells. Admit one only
    // when this exact query's bounds prove the old cursor visits that cell
    // alone, so a refined neighbour cannot contribute through its tolerance.
    // The continuation's full region/input lease still guards every slice and
    // publication; no face cache survives it.
    const owner = leftFace.surface;
    if (
      baseEntries.length === 1 &&
      owner !== null &&
      owner === baseEntries[0].surface &&
      owner === rightFace.surface &&
      leftFace.faceIndex === rightFace.faceIndex
    ) {
      if (!owner.isRegularGrid) {
        // Preserve createTriangleCursor's original local-AABB expressions.
        canonicalBounds.minX = Math.min(a.x, b.x) - owner.centerX;
        canonicalBounds.maxX = Math.max(a.x, b.x) - owner.centerX;
        canonicalBounds.minZ = Math.min(a.z, b.z) - owner.centerZ;
        canonicalBounds.maxZ = Math.max(a.z, b.z) - owner.centerZ;
      }
      const canonicalInterior = owner.isRegularGrid
          ? owner.readTriangle(leftFace.faceIndex, triangle)
          : owner.readCanonicalTriangleInBounds(
              leftFace.faceIndex,
              canonicalBounds,
              triangle,
            ),
        refinedInterior =
          !canonicalInterior &&
          owner.readGroundingInteriorTriangle(
            leftFace.faceIndex,
            a.x,
            a.z,
            b.x,
            b.z,
            triangle,
          );
      if (canonicalInterior || refinedInterior) {
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = triangle;
        const dx = b.x - a.x,
          dz = b.z - a.z,
          ox = owner.centerX,
          oz = owner.centerZ;
        const det = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        const determinantScale =
          Math.abs((bx - ax) * (cz - az)) + Math.abs((bz - az) * (cx - ax));
        // Both canonical face orders span the full rectangular cell on these
        // edges. Extremely disproportionate Float32 cells keep the full path.
        const spanX = Math.abs(cx - bx),
          spanZ = Math.abs(bz - az);
        if (
          (refinedInterior ||
            (spanX > 0 &&
              spanZ > 0 &&
              spanX <= 2 * spanZ &&
              spanZ <= 2 * spanX)) &&
          Number.isFinite(det) &&
          Math.abs(det) > determinantScale * Number.EPSILON * 64
        ) {
          const u0 =
            ((a.x - ox - ax) * (cz - az) - (a.z - oz - az) * (cx - ax)) / det;
          const v0 =
            ((bx - ax) * (a.z - oz - az) - (bz - az) * (a.x - ox - ax)) / det;
          const du = (dx * (cz - az) - dz * (cx - ax)) / det;
          const dv = ((bx - ax) * dz - (bz - az) * dx) / det;
          const u1 = u0 + du,
            v1 = v0 + dv,
            w0 = 1 - u0 - v0,
            w1 = w0 + (-du - dv);
          // This is deliberately much stricter than the clipper's 1e-10 edge
          // allowance. NaN/infinite coordinates cannot satisfy all six bounds.
          const interior = 1e-7;
          if (
            u0 > interior &&
            v0 > interior &&
            w0 > interior &&
            u1 > interior &&
            v1 > interior &&
            w1 > interior
          ) {
            take();
            receipt.triangleVisits++;
            receipt.sameFaceEdges++;
            if (refinedInterior) receipt.refinedSameFaceEdges++;
            markSurface(owner, "edge");
            let maxError = 0;
            // Preserve the clipper's exact expression/order at lo=0 and hi=1,
            // including corrected endpoint heights and floating-point rounding.
            for (let endpoint = 0; endpoint < 2; endpoint++) {
              const t = endpoint === 0 ? 0 : 1;
              const terrainY =
                ay + (u0 + du * t) * (by - ay) + (v0 + dv * t) * (cy - ay);
              maxError = Math.max(
                maxError,
                Math.abs(a.y + (b.y - a.y) * t - terrainY),
              );
            }
            return maxError;
          }
        }
      }
    }
    return null;
  };
  // The common certified-face path does not suspend. Only allocate a delegated
  // generator for an edge that actually needs the original clipping traversal.
  const edgeError = function* (a: Point, b: Point) {
    const dx = b.x - a.x,
      dz = b.z - a.z,
      intervals: [number, number][] = [];
    let maxError = 0;
    const box = {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z),
      maxZ: Math.max(a.z, b.z),
    };
    for (const entry of baseEntries) {
      yield "edge_owner";
      take();
      if (!overlaps(box, entry.box)) continue;
      const surface = entry.surface,
        ox = surface.centerX,
        oz = surface.centerZ;
      const edgeCursor = surface.createGroundingEdgeCursor(a.x, a.z, b.x, b.z);
      const cursor = edgeCursor
        ? null
        : surface.createTriangleCursor({
            minX: box.minX - ox,
            maxX: box.maxX - ox,
            minZ: box.minZ - oz,
            maxZ: box.maxZ - oz,
          });
      let indexedSteps = 0;
      while (true) {
        const step = edgeCursor
          ? edgeCursor.step(triangle)
          : cursor!.next(triangle)
            ? "triangle"
            : null;
        if (step === null) break;
        if (!edgeCursor || indexedSteps++ % INDEXED_EDGE_STEP_BATCH_SIZE === 0)
          yield "edge_triangle_batch";
        // Broadphase rejection is real work, not an uncharged scan hidden in
        // next(). Retained triangles keep their original order and clipper.
        take();
        if (step === "block") continue;
        receipt.triangleVisits++;
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = triangle;
        const det = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        const u0 =
          ((a.x - ox - ax) * (cz - az) - (a.z - oz - az) * (cx - ax)) / det;
        const v0 =
          ((bx - ax) * (a.z - oz - az) - (bz - az) * (a.x - ox - ax)) / det;
        const du = (dx * (cz - az) - dz * (cx - ax)) / det;
        const dv = ((bx - ax) * dz - (bz - az) * dx) / det;
        let lo = 0,
          hi = 1;
        for (let edge = 0; edge < 3; edge++) {
          const start = edge === 0 ? u0 : edge === 1 ? v0 : 1 - u0 - v0,
            change = edge === 0 ? du : edge === 1 ? dv : -du - dv;
          if (Math.abs(change) < 1e-14) {
            if (start < -1e-10) {
              lo = 1;
              hi = 0;
              break;
            }
          } else if (change > 0) lo = Math.max(lo, -start / change);
          else hi = Math.min(hi, -start / change);
        }
        if (lo > hi + 1e-10 || hi < 0 || lo > 1) continue;
        lo = Math.max(0, lo);
        hi = Math.min(1, hi);
        markSurface(surface, "edge");
        intervals.push([lo, hi]);
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          const t = endpoint === 0 ? lo : hi;
          const terrainY =
            ay + (u0 + du * t) * (by - ay) + (v0 + dv * t) * (cy - ay);
          maxError = Math.max(
            maxError,
            Math.abs(a.y + (b.y - a.y) * t - terrainY),
          );
        }
      }
    }
    yield* sortedIntervals(intervals);
    let until = 0;
    for (const [lo, hi] of intervals) {
      yield "edge_interval";
      if (lo > until + 1e-7) throw new DeferredGrounding("missing_surface");
      until = Math.max(until, hi);
    }
    if (until < 1 - 1e-7) throw new DeferredGrounding("missing_surface");
    return maxError;
  };
  // Exact inverse of the existing cubic road fade at its 0.8 exclusion gate.
  let low = 0,
    high = 1;
  for (let i = 0; i < 48; i++) {
    const m = (low + high) / 2;
    if (m * m * (3 - 2 * m) < 0.8) low = m;
    else high = m;
  }
  const roadFeather = 0.5 * (1 - (low + high) / 2);
  // Only explicitly extended roads need cached profiles. Missing fields keep
  // the original inverse and loop/work accounting above and below unchanged.
  // Peak<=0.8 has no hard-exclusion capsule; all pad/water/terrain guards remain.
  const explicitRoadFeathers = new Map<number, number | null>();
  const profileFeathers = new Map<string, number | null>();
  const roadCells: number[][] = Array.from(
    { length: ROAD_GRID_AXIS * ROAD_GRID_AXIS },
    () => [],
  );
  const roadCell = (value: number, center: number) =>
    Math.max(
      0,
      Math.min(
        ROAD_GRID_AXIS - 1,
        Math.floor(
          ((value - center + ownSurface.size / 2) / ownSurface.size) *
            ROAD_GRID_AXIS,
        ),
      ),
    );
  // Only one road mode runs for a clump and is fully drained before reuse.
  const seenRoads = new Set<number>();
  const roadsNear = function* (box: TerrainGridBounds) {
    seenRoads.clear();
    for (
      let gx = roadCell(box.minX, ownSurface.centerX);
      gx <= roadCell(box.maxX, ownSurface.centerX);
      gx++
    ) {
      for (
        let gz = roadCell(box.minZ, ownSurface.centerZ);
        gz <= roadCell(box.maxZ, ownSurface.centerZ);
        gz++
      ) {
        yield "grounding_operation";
        take();
        for (const index of roadCells[gx * ROAD_GRID_AXIS + gz]) {
          yield "grounding_operation";
          take();
          if (seenRoads.has(index)) continue;
          seenRoads.add(index);
          const road = request.roadSegments[index];
          const explicitFeather = explicitRoadFeathers.get(index);
          if (
            explicitFeather !== null &&
            segmentBoxDistance(road, box) <=
              road.width / 2 + (explicitFeather ?? roadFeather)
          )
            return true;
        }
      }
    }
    return false;
  };
  const padOverlap = function* (box: TerrainGridBounds) {
    // Extend static grass rejection to all-LOD rock silhouettes. Test the full
    // swept blade box, not only its root, so wind cannot enter adjacent rocks.
    for (const polygon of snapshot.exclusionPolygons ?? []) {
      // Preserve the original initial yield -> charge -> bounds check. Known
      // misses need no SAT generator; possible hits retain the same edge work.
      yield "grounding_operation";
      take();
      if (!surfaceOperations.exclusionBoundsOverlap(polygon, box)) continue;
      const steps = surfaceOperations.intersectsExclusionSteps(polygon, box);
      let step = steps.next();
      if (step.done || step.value !== "polygon_bounds")
        throw new Error("Invalid grass exclusion bounds continuation");
      // The public iterator's initial bounds yield was already charged above.
      // Resume synchronously: do not cache geometry/bounds across another yield.
      step = steps.next();
      while (!step.done) {
        yield "grounding_operation";
        take();
        step = steps.next();
      }
      if (step.value) return true;
    }
    for (const zone of snapshot.zones) {
      yield "grounding_operation";
      take();
      if (zone.excludeGrass === false) continue;
      if (zone.grassExclusionBounds) {
        if (overlaps(box, zone.grassExclusionBounds)) return true;
      } else if (zone.radialPond) {
        if (
          pointBoxDistance(zone.centerX, zone.centerZ, box) <
          zone.radialPond.bankOuterRadius + zone.blendRadius
        )
          return true;
      } else if (zone.tileMask) {
        for (const key of zone.tileMask) {
          yield "grounding_operation";
          take();
          const [x, z] = key.split(",").map(Number);
          if (overlaps(box, { minX: x, maxX: x + 1, minZ: z, maxZ: z + 1 }))
            return true;
        }
        if (zone.blendRadius > 0)
          for (const tile of zone.tileMaskTiles ?? []) {
            yield "grounding_operation";
            take();
            const distance = Math.hypot(
              Math.max(box.minX - tile.x - 1, 0, tile.x - box.maxX),
              Math.max(box.minZ - tile.z - 1, 0, tile.z - box.maxZ),
            );
            if (distance <= zone.blendRadius) return true;
          }
      } else if (
        overlaps(box, {
          minX: zone.centerX - zone.width / 2 - zone.blendRadius,
          maxX: zone.centerX + zone.width / 2 + zone.blendRadius,
          minZ: zone.centerZ - zone.depth / 2 - zone.blendRadius,
          maxZ: zone.centerZ + zone.depth / 2 + zone.blendRadius,
        })
      )
        return true;
    }
    return false;
  };
  yield "bounded_staging_allocation";
  const deltas = new Float32Array(data.count * blades * 2),
    retained: number[] = [];
  const visibility = perBladeRoads ? new Uint32Array(data.count) : undefined;
  // Fixed clump-local fitting scratch, reused across every clump and road.
  // The main sweep already evaluates these exact XZ extrema. Borrowed source
  // checks below allow road admission to reuse them without a second transform.
  const bladeBounds = perBladeRoads ? new Float64Array(blades * 4) : undefined;
  // At the largest admitted layout these add 11,928 bytes: 360 * 4 doubles,
  // 24 * 2 doubles and 24 flags. This is core-layout-bounded fitting scratch,
  // not retained topology counted by the worker's maximumDerivedBytes limit.
  // Doubles preserve exact attribute reads and signed zero across suspension.
  const sweptBladeSources = perBladeRoads
    ? new Float64Array(blades * verticesPerBlade * 4)
    : undefined;
  const sweptBladeWind = perBladeRoads
    ? new Float64Array(blades * 2)
    : undefined;
  const sweptBladeReusable = perBladeRoads ? new Uint8Array(blades) : undefined;
  const allBlades = (1 << blades) - 1;
  const bladeBox: TerrainGridBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  const roadBladeVisibility = function* (
    box: TerrainGridBounds,
    transform: (v: number, fade: number, target: Point) => void,
    bankHeightScale: number,
    scale: number,
  ): Generator<string, number, void> {
    if (
      !bladeBounds ||
      !sweptBladeSources ||
      !sweptBladeWind ||
      !sweptBladeReusable
    )
      throw new Error("Missing grass blade bounds scratch");
    let mask = allBlades,
      built = false;
    seenRoads.clear();
    for (
      let gx = roadCell(box.minX, ownSurface.centerX);
      gx <= roadCell(box.maxX, ownSurface.centerX);
      gx++
    ) {
      for (
        let gz = roadCell(box.minZ, ownSurface.centerZ);
        gz <= roadCell(box.maxZ, ownSurface.centerZ);
        gz++
      ) {
        yield "grounding_operation";
        take();
        for (const index of roadCells[gx * ROAD_GRID_AXIS + gz]) {
          yield "grounding_operation";
          take();
          if (seenRoads.has(index)) continue;
          seenRoads.add(index);
          const road = request.roadSegments[index];
          const explicitFeather = explicitRoadFeathers.get(index);
          if (explicitFeather === null) continue;
          const margin = road.width / 2 + (explicitFeather ?? roadFeather);
          if (segmentBoxDistance(road, box) > margin) continue;
          if (!built) {
            for (let blade = 0; blade < blades; blade++) {
              yield "road_blade_bounds";
              const b = blade * 4;
              const windX = Object.getOwnPropertyDescriptor(wind, "x"),
                windZ = Object.getOwnPropertyDescriptor(wind, "z");
              let reuse =
                sweptBladeReusable[blade] === 1 &&
                windX !== undefined &&
                windZ !== undefined &&
                "value" in windX &&
                "value" in windZ &&
                Object.is(windX.value, sweptBladeWind[blade * 2]) &&
                Object.is(windZ.value, sweptBladeWind[blade * 2 + 1]);
              const end = (blade + 1) * verticesPerBlade;
              if (reuse) {
                for (let v = blade * verticesPerBlade; v < end; v++) {
                  // Charge each bounded live-source check, not just transforms.
                  // Attribute versions alone miss writes without needsUpdate.
                  take();
                  const source = v * 4;
                  if (
                    !Object.is(position.getX(v), sweptBladeSources[source]) ||
                    !Object.is(
                      position.getY(v),
                      sweptBladeSources[source + 1],
                    ) ||
                    !Object.is(
                      position.getZ(v),
                      sweptBladeSources[source + 2],
                    ) ||
                    !Object.is(uv.getY(v), sweptBladeSources[source + 3])
                  ) {
                    reuse = false;
                    break;
                  }
                }
              }
              if (reuse) continue;
              // Changed borrowed inputs retain the original per-vertex,
              // two-fade evaluation and charges after this same blade yield.
              bladeBounds[b] = bladeBounds[b + 2] = Infinity;
              bladeBounds[b + 1] = bladeBounds[b + 3] = -Infinity;
              for (let v = blade * verticesPerBlade; v < end; v++) {
                const windFactor = getGrassBladeWindFactor(
                  uv.getY(v),
                  position.getY(v),
                  scale,
                  geometryLayout,
                );
                for (let fade = 0; fade < 2; fade++) {
                  take();
                  transform(v, fade, point);
                  bladeBounds[b] = Math.min(
                    bladeBounds[b],
                    point.x -
                      wind.x * bankHeightScale * windFactor -
                      NUMERIC_GUARD,
                  );
                  bladeBounds[b + 1] = Math.max(
                    bladeBounds[b + 1],
                    point.x +
                      wind.x * bankHeightScale * windFactor +
                      NUMERIC_GUARD,
                  );
                  bladeBounds[b + 2] = Math.min(
                    bladeBounds[b + 2],
                    point.z -
                      wind.z * bankHeightScale * windFactor -
                      NUMERIC_GUARD,
                  );
                  bladeBounds[b + 3] = Math.max(
                    bladeBounds[b + 3],
                    point.z +
                      wind.z * bankHeightScale * windFactor +
                      NUMERIC_GUARD,
                  );
                }
              }
            }
            built = true;
          }
          for (let blade = 0; blade < blades; blade++) {
            if (!(mask & (1 << blade))) continue;
            yield "road_blade";
            take();
            const b = blade * 4;
            bladeBox.minX = bladeBounds[b];
            bladeBox.maxX = bladeBounds[b + 1];
            bladeBox.minZ = bladeBounds[b + 2];
            bladeBox.maxZ = bladeBounds[b + 3];
            if (segmentBoxDistance(road, bladeBox) <= margin)
              mask &= ~(1 << blade);
          }
          if (!mask) return 0;
        }
      }
    }
    return mask;
  };
  let sweptBounds: (TerrainGridBounds & { minY: number; maxY: number }) | null =
    null;
  const left: Point = { x: 0, y: 0, z: 0 },
    right: Point = { x: 0, y: 0, z: 0 },
    point: Point = { x: 0, y: 0, z: 0 };
  // Reuse the endpoint transforms already required for terrain fitting. These
  // fixed, clump-local buffers preserve doubles and signed zero; they are not
  // a geometry snapshot. Borrowed root coordinates must still match at use.
  const fittedRootSource = new Float64Array(blades * 2 * 3),
    fittedRootWorld = new Float64Array(blades * 2 * 3);
  try {
    for (let index = 0; index < request.roadSegments.length; index++) {
      const road = request.roadSegments[index];
      let feather = roadFeather;
      if (
        Object.prototype.hasOwnProperty.call(road, "blendWidth") ||
        Object.prototype.hasOwnProperty.call(road, "maxInfluence")
      ) {
        const blend = road.blendWidth ?? 0.5;
        const peak = road.maxInfluence ?? 1;
        const profile = `${blend}:${peak}`;
        let cached = profileFeathers.get(profile);
        if (cached === undefined) {
          cached = roadInfluenceOperations.getExclusionFeather(blend, peak);
          profileFeathers.set(profile, cached);
        }
        explicitRoadFeathers.set(index, cached);
        if (cached === null) continue;
        feather = cached;
      }
      const margin = road.width / 2 + feather + NUMERIC_GUARD;
      // Clamp both road and query bounds to the same edge cells. This retains
      // roads and swept blades outside the owner; it never discards border work.
      for (
        let gx = roadCell(
          Math.min(road.startX, road.endX) - margin,
          ownSurface.centerX,
        );
        gx <=
        roadCell(Math.max(road.startX, road.endX) + margin, ownSurface.centerX);
        gx++
      ) {
        for (
          let gz = roadCell(
            Math.min(road.startZ, road.endZ) - margin,
            ownSurface.centerZ,
          );
          gz <=
          roadCell(
            Math.max(road.startZ, road.endZ) + margin,
            ownSurface.centerZ,
          );
          gz++
        ) {
          yield "grounding_operation";
          take();
          roadCells[gx * ROAD_GRID_AXIS + gz].push(index);
        }
      }
    }
    for (let i = 0; i < data.count; i++) {
      const k = i * 3,
        x = ownSurface.centerX + data.offsets[k],
        y = data.offsets[k + 1],
        z = ownSurface.centerZ + data.offsets[k + 2];
      yield "anchor_surface";
      take();
      if (
        !ownSurface.sample(data.offsets[k], data.offsets[k + 2], sample) ||
        Math.abs(y - sample.height) > 0.0001 ||
        Math.abs(data.groundNormals[k] - sample.nx) > 0.00001 ||
        Math.abs(data.groundNormals[k + 1] - sample.ny) > 0.00001 ||
        Math.abs(data.groundNormals[k + 2] - sample.nz) > 0.00001
      )
        throw new Error(
          "Grass grounding requires projected anchor height/normal",
        );
      markSurface(ownSurface, "endpoint");
      const bankHeightScale = bankField
        ? compactTerrainColorOperations.bankVergeHeightScale(x, z, bankField)
        : 1;
      const rotation = data.rotScaleHash[k],
        scale = data.rotScaleHash[k + 1],
        cos = Math.cos(rotation),
        sin = Math.sin(rotation);
      const nx = data.groundNormals[k],
        ny = data.groundNormals[k + 1],
        nz = data.groundNormals[k + 2],
        q = 1 / (1 + ny),
        cross = -nx * nz * q,
        tiltX = ny + nz * nz * q,
        tiltZ = ny + nx * nx * q;
      const applyTransform = (
        rx: number,
        ry: number,
        rz: number,
        target: Point,
      ): void => {
        target.x = x + rx * tiltX + ry * nx + rz * cross;
        target.y = y - rx * nx + ry * ny - rz * nz;
        target.z = z + rx * cross + ry * nz + rz * tiltZ;
      };
      const transform = (v: number, fade: number, target: Point): void => {
        const rx = (position.getX(v) * cos - position.getZ(v) * sin) * scale,
          rz = (position.getX(v) * sin + position.getZ(v) * cos) * scale,
          ry = position.getY(v) * bankHeightScale * scale * fade;
        applyTransform(rx, ry, rz, target);
      };
      baseBounds.minX = baseBounds.minZ = Infinity;
      baseBounds.maxX = baseBounds.maxZ = -Infinity;
      for (let blade = 0; blade < blades; blade++) {
        yield "blade_base_bounds";
        for (let side = 0; side < 2; side++) {
          take();
          transform(blade * verticesPerBlade + side, 1, point);
          baseBounds.minX = Math.min(baseBounds.minX, point.x);
          baseBounds.maxX = Math.max(baseBounds.maxX, point.x);
          baseBounds.minZ = Math.min(baseBounds.minZ, point.z);
          baseBounds.maxZ = Math.max(baseBounds.maxZ, point.z);
        }
      }
      baseEntries.length = 0;
      for (const entry of entries) {
        yield "blade_base_owner";
        take();
        if (overlaps(baseBounds, entry.box)) baseEntries.push(entry);
      }
      // Filtering is inclusive and order-preserving: shared-edge ownership and
      // every crossed base triangle stay identical. Full wind/fade coverage
      // still checks all retained surfaces, including overlap rejection.
      let baseError = 0;
      for (let blade = 0; blade < blades; blade++) {
        transform(blade * verticesPerBlade, 1, left);
        transform(blade * verticesPerBlade + 1, 1, right);
        // Capture before any endpoint suspension or terrain-Y correction.
        for (let side = 0; side < 2; side++) {
          const v = blade * verticesPerBlade + side,
            root = (blade * 2 + side) * 3,
            endpoint = side === 0 ? left : right;
          fittedRootSource[root] = position.getX(v);
          fittedRootSource[root + 1] = position.getY(v);
          fittedRootSource[root + 2] = position.getZ(v);
          fittedRootWorld[root] = endpoint.x;
          fittedRootWorld[root + 1] = endpoint.y;
          fittedRootWorld[root + 2] = endpoint.z;
        }
        let deltaLeft = 0,
          deltaRight = 0;
        // Keep endpoint order, suspension points and charges in this existing
        // continuation instead of allocating two inner generators per blade.
        for (let side = 0; side < 2; side++) {
          const endpoint = side === 0 ? left : right,
            face = side === 0 ? leftFace : rightFace;
          receipt.endpointQueries++;
          // Half-open ownership; retain a sole outer edge as the fallback.
          let selected: SurfaceEntry | undefined;
          for (const entry of baseEntries) {
            yield "endpoint_owner";
            take();
            const b = entry.box;
            if (
              endpoint.x >= b.minX &&
              endpoint.x < b.maxX &&
              endpoint.z >= b.minZ &&
              endpoint.z < b.maxZ
            ) {
              selected = entry;
              break;
            }
            if (
              !selected &&
              endpoint.x >= b.minX &&
              endpoint.x <= b.maxX &&
              endpoint.z >= b.minZ &&
              endpoint.z <= b.maxZ
            )
              selected = entry;
          }
          if (
            !selected ||
            !selected.surface.sampleHeight(
              endpoint.x - selected.surface.centerX,
              endpoint.z - selected.surface.centerZ,
              endpointSample,
            )
          )
            throw new DeferredGrounding("missing_surface");
          markSurface(selected.surface, "endpoint");
          face.surface = selected.surface;
          face.faceIndex = endpointSample.faceIndex;
          const delta = Math.fround(endpointSample.height - endpoint.y);
          if (side === 0) deltaLeft = delta;
          else deltaRight = delta;
        }
        if (!Number.isFinite(deltaLeft) || !Number.isFinite(deltaRight))
          throw new Error("Nonfinite grass grounding correction");
        const d = (i * blades + blade) * 2;
        deltas[d] = deltaLeft;
        deltas[d + 1] = deltaRight;
        receipt.maxEndpointCorrection = Math.max(
          receipt.maxEndpointCorrection,
          Math.abs(deltaLeft),
          Math.abs(deltaRight),
        );
        left.y += deltaLeft;
        right.y += deltaRight;
        baseError = Math.max(
          baseError,
          sameFaceEdgeError(left, right) ?? (yield* edgeError(left, right)),
        );
      }
      receipt.maxCorrectedBaseError = Math.max(
        receipt.maxCorrectedBaseError,
        baseError,
      );
      box.minX = box.minZ = Infinity;
      box.maxX = box.maxZ = -Infinity;
      let minY = Infinity,
        maxY = -Infinity;
      // Never borrow an earlier clump's cache. State 2 is accumulation in
      // progress; only a completely visited blade may become reusable (1).
      sweptBladeReusable?.fill(0);
      for (let v = 0; v < position.count; v++) {
        // One blade is a bounded batch: at most fifteen vertices / thirty
        // transforms at LOD0. Keep every suspension point and floating-point
        // expression. A zero-height vertex has identical fade endpoints, so
        // evaluate its one distinct point once rather than charging/computing
        // duplicate transforms and idempotent extrema. This does not omit any
        // actual swept vertex. Root transforms can also be reused below, but
        // only after checking their borrowed coordinates across suspension.
        if (v % verticesPerBlade === 0) yield "blade_swept_bounds";
        const blade = Math.floor(v / verticesPerBlade),
          d = (i * blades + blade) * 2;
        // Reread borrowed attributes and wind on resumption. Root correction
        // and wind remain live even when the unchanged root transform is reused.
        const u = uv.getX(v),
          px = position.getX(v),
          py = position.getY(v),
          pz = position.getZ(v);
        const correction = deltas[d] * (1 - u) + deltas[d + 1] * u;
        const t = uv.getY(v);
        const windFactor = getGrassBladeWindFactor(
          t,
          py,
          scale,
          geometryLayout,
        );
        const windAmplitudeX = wind.x,
          windAmplitudeZ = wind.z,
          windX = windAmplitudeX * bankHeightScale * windFactor,
          windZ = windAmplitudeZ * bankHeightScale * windFactor;
        const rx = (px * cos - pz * sin) * scale,
          rz = (px * sin + pz * cos) * scale,
          scaledY = py * bankHeightScale * scale;
        const localVertex = v % verticesPerBlade,
          root = (blade * 2 + localVertex) * 3,
          reuseRoot =
            localVertex < 2 &&
            scaledY === 0 &&
            Object.is(px, fittedRootSource[root]) &&
            Object.is(py, fittedRootSource[root + 1]) &&
            Object.is(pz, fittedRootSource[root + 2]);
        if (
          bladeBounds &&
          sweptBladeSources &&
          sweptBladeWind &&
          sweptBladeReusable
        ) {
          const source = v * 4;
          sweptBladeSources[source] = px;
          sweptBladeSources[source + 1] = py;
          sweptBladeSources[source + 2] = pz;
          sweptBladeSources[source + 3] = t;
          if (localVertex === 0) {
            const b = blade * 4;
            bladeBounds[b] = bladeBounds[b + 2] = Infinity;
            bladeBounds[b + 1] = bladeBounds[b + 3] = -Infinity;
            sweptBladeWind[blade * 2] = windAmplitudeX;
            sweptBladeWind[blade * 2 + 1] = windAmplitudeZ;
            // Numeric samples determine these bounds; inspect live property
            // descriptors only when a road actually needs to reuse them.
            sweptBladeReusable[blade] = 2;
          } else if (
            !Object.is(windAmplitudeX, sweptBladeWind[blade * 2]) ||
            !Object.is(windAmplitudeZ, sweptBladeWind[blade * 2 + 1])
          )
            sweptBladeReusable[blade] = 0;
        }
        for (let fade = 0; fade < (scaledY === 0 ? 1 : 2); fade++) {
          if (reuseRoot) {
            point.x = fittedRootWorld[root];
            point.y = fittedRootWorld[root + 1];
            point.z = fittedRootWorld[root + 2];
          } else {
            take();
            applyTransform(rx, scaledY * fade, rz, point);
          }
          const vertexMinX = point.x - windX - NUMERIC_GUARD,
            vertexMaxX = point.x + windX + NUMERIC_GUARD,
            vertexMinZ = point.z - windZ - NUMERIC_GUARD,
            vertexMaxZ = point.z + windZ + NUMERIC_GUARD;
          box.minX = Math.min(box.minX, vertexMinX);
          box.maxX = Math.max(box.maxX, vertexMaxX);
          box.minZ = Math.min(box.minZ, vertexMinZ);
          box.maxZ = Math.max(box.maxZ, vertexMaxZ);
          if (bladeBounds) {
            const b = blade * 4;
            bladeBounds[b] = Math.min(bladeBounds[b], vertexMinX);
            bladeBounds[b + 1] = Math.max(bladeBounds[b + 1], vertexMaxX);
            bladeBounds[b + 2] = Math.min(bladeBounds[b + 2], vertexMinZ);
            bladeBounds[b + 3] = Math.max(bladeBounds[b + 3], vertexMaxZ);
          }
          const correctedY = point.y + correction;
          minY = Math.min(minY, correctedY - NUMERIC_GUARD);
          maxY = Math.max(maxY, correctedY + NUMERIC_GUARD);
        }
        if (
          sweptBladeReusable &&
          localVertex === verticesPerBlade - 1 &&
          sweptBladeReusable[blade] === 2
        )
          sweptBladeReusable[blade] = 1;
      }
      if (
        ![box.minX, box.maxX, box.minZ, box.maxZ, minY, maxY].every(
          Number.isFinite,
        )
      )
        throw new Error("Nonfinite corrected grass envelope");
      yield* ensureCoverage(box);
      let rejection: RejectionReason | null =
        baseError > maximumBaseError ? "terrain_edge" : null;
      if (!rejection && (yield* padOverlap(box))) rejection = "pad";
      let visibleBlades = allBlades;
      if (!rejection) {
        if (perBladeRoads) {
          visibleBlades = yield* roadBladeVisibility(
            box,
            transform,
            bankHeightScale,
            scale,
          );
          if (!visibleBlades) rejection = "road";
        } else if (yield* roadsNear(box)) rejection = "road";
      }
      if (!rejection) {
        let highest = -Infinity,
          coveredByBody = false;
        for (const body of snapshot.waterBodies) {
          yield "grounding_operation";
          take();
          if (pointBoxDistance(body.centerX, body.centerZ, box) > body.radius)
            continue;
          highest = Math.max(highest, body.surfaceY);
          if (
            [
              [box.minX, box.minZ],
              [box.minX, box.maxZ],
              [box.maxX, box.minZ],
              [box.maxX, box.maxZ],
            ].every(
              ([wx, wz]) =>
                Math.hypot(wx - body.centerX, wz - body.centerZ) <= body.radius,
            )
          )
            coveredByBody = true;
        }
        // A single containing body removes ocean fallback. Otherwise retaining
        // ocean is conservative when several smaller bodies cover the box.
        if (!coveredByBody) highest = Math.max(highest, request.oceanLevel);
        if (minY < highest + 0.1) rejection = "water";
      }
      receipt.processedClumps++;
      if (rejection) receipt.rejected[rejection]++;
      else {
        if (visibility && receipt.roadClearance) {
          yield "road_blade_receipt";
          take();
          visibility[i] = visibleBlades;
          let remaining = visibleBlades,
            visibleCount = 0;
          while (remaining) {
            remaining &= remaining - 1;
            visibleCount++;
          }
          receipt.roadClearance.retainedBlades += visibleCount;
          receipt.roadClearance.maskedRetainedBlades += blades - visibleCount;
          if (visibleBlades !== allBlades) {
            receipt.roadClearance.partialClumps++;
            // Hidden triangles collapse to this anchor in the GPU binding.
            // Extend output culling bounds only, after all unchanged admission
            // checks: a valid blade layout need not surround its common anchor.
            box.minX = Math.min(box.minX, x);
            box.maxX = Math.max(box.maxX, x);
            box.minZ = Math.min(box.minZ, z);
            box.maxZ = Math.max(box.maxZ, z);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
        retained.push(i);
        if (!sweptBounds) sweptBounds = { ...box, minY, maxY };
        else {
          sweptBounds.minX = Math.min(sweptBounds.minX, box.minX);
          sweptBounds.maxX = Math.max(sweptBounds.maxX, box.maxX);
          sweptBounds.minZ = Math.min(sweptBounds.minZ, box.minZ);
          sweptBounds.maxZ = Math.max(sweptBounds.maxZ, box.maxZ);
          sweptBounds.minY = Math.min(sweptBounds.minY, minY);
          sweptBounds.maxY = Math.max(sweptBounds.maxY, maxY);
        }
        receipt.maxAcceptedBaseError = Math.max(
          receipt.maxAcceptedBaseError,
          baseError,
        );
      }
    }
  } catch (error) {
    if (error instanceof DeferredGrounding)
      return {
        status: "defer",
        reason: error.reason,
        dependencies: dependencies(),
        receipt: finish(),
      };
    throw error;
  }
  yield "bounded_output_allocation";
  const count = retained.length;
  const output: GrassAnchorData = {
    count,
    offsets: new Float32Array(count * 3),
    rotScaleHash: new Float32Array(count * 3),
    groundColors: new Float32Array(count * 3),
    grassTints: new Float32Array(count * 4),
    groundNormals: new Float32Array(count * 3),
  };
  const rootDeltas = new Float32Array(count * blades * 2);
  const sourceIndices = new Uint32Array(count);
  const bladeVisibility = perBladeRoads ? new Uint32Array(count) : undefined;
  for (let dst = 0; dst < count; dst++) {
    yield "output_clump";
    const source = retained[dst];
    sourceIndices[dst] = source;
    if (bladeVisibility && visibility)
      bladeVisibility[dst] = visibility[source];
    for (const [key, stride] of [
      ["offsets", 3],
      ["rotScaleHash", 3],
      ["groundColors", 3],
      ["grassTints", 4],
      ["groundNormals", 3],
    ] as const)
      output[key].set(
        data[key].subarray(source * stride, (source + 1) * stride),
        dst * stride,
      );
    rootDeltas.set(
      deltas.subarray(source * blades * 2, (source + 1) * blades * 2),
      dst * blades * 2,
    );
  }
  receipt.retainedClumps = count;
  receipt.correctionBytes = rootDeltas.byteLength;
  if (receipt.roadClearance && bladeVisibility)
    receipt.roadClearance.visibilityBytes = bladeVisibility.byteLength;
  return {
    status: "ready",
    data: output,
    rootDeltas,
    ...(bladeVisibility === undefined ? {} : { bladeVisibility }),
    sourceIndices,
    sweptBounds,
    dependencies: dependencies(),
    receipt: finish(),
  };
}

export const GRASS_BLADE_GROUNDING_JOB_LIMITS = Object.freeze({
  maximumSliceOperations: 8192,
  targetSliceMs: 2,
  clockInterval: 64,
  maximumOperations: 1_000_000,
  maximumActiveMs: 250,
});

/** Cumulative work already spent before a continuation changes execution owner. */
export type GrassGroundingConsumedWork = {
  operations: number;
  activeMs: number;
  maximumSliceMs: number;
};

export type GrassGroundingTimingSpan = Readonly<{
  elapsedMs: number;
  startOperations: number;
  endOperations: number;
  startPhase: string | null;
  endPhase: string | null;
}>;

/** Local observations only: a handed-off maximum has no local phase evidence.
 * Existing clock reads bound the samples. They cannot identify GC or off-CPU
 * time, and never subtract apparent stalls from the real budget. */
export type GrassGroundingTiming = Readonly<{
  timeBasis: "slice-elapsed-including-preemption";
  scope: "local-continuation";
  peakSlice: GrassGroundingTimingSpan | null;
  peakClockInterval: GrassGroundingTimingSpan | null;
}>;

class GroundingTimingSpan {
  elapsedMs = -1;
  startOperations = 0;
  endOperations = 0;
  startPhase: string | null = null;
  endPhase: string | null = null;

  capture(): GrassGroundingTimingSpan | null {
    return this.elapsedMs < 0
      ? null
      : Object.freeze({
          elapsedMs: this.elapsedMs,
          startOperations: this.startOperations,
          endOperations: this.endOperations,
          startPhase: this.startPhase?.slice(0, 128) ?? null,
          endPhase: this.endPhase?.slice(0, 128) ?? null,
        });
  }
}

/** Admit a detached wire snapshot without invoking user-defined field accessors.
 * Operation counts are integers; clock measurements retain fractional ms. */
export function validateGrassGroundingConsumedWork(
  value: unknown,
): Readonly<GrassGroundingConsumedWork> {
  const fail = (): never => {
    throw new Error("Invalid grass grounding consumed work");
  };
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    fail();
  const keys = ["operations", "activeMs", "maximumSliceMs"] as const;
  const ownKeys = Reflect.ownKeys(value as object);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => !keys.includes(key as (typeof keys)[number]))
  )
    fail();
  const captured: GrassGroundingConsumedWork = {
    operations: 0,
    activeMs: 0,
    maximumSliceMs: 0,
  };
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      !property ||
      !("value" in property) ||
      !property.enumerable ||
      typeof property.value !== "number" ||
      !Number.isFinite(property.value) ||
      property.value < 0
    )
      fail();
    captured[key] = property!.value;
  }
  if (
    !Number.isSafeInteger(captured.operations) ||
    captured.operations > GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations ||
    captured.activeMs > GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs ||
    captured.maximumSliceMs > captured.activeMs
  )
    fail();
  return Object.freeze(captured);
}

export type GrassBladeGroundingJobState =
  | { status: "running" }
  | {
      status: "ready";
      result: Extract<GrassBladeGroundingResult, { status: "ready" }>;
    }
  | {
      status: "waiting_support";
      result: Extract<GrassBladeGroundingResult, { status: "defer" }>;
    }
  | {
      status: "failed_budget";
      reason: "operations" | "active_cpu" | "grounding_work";
    }
  | { status: "failed_input"; error: unknown }
  | { status: "cancelled"; reason: "caller" | "invalidated" };

export class GrassGroundingContinuation {
  private iterator: ReturnType<typeof groundGrassBladeSteps> | null;
  private current: GrassBladeGroundingJobState = { status: "running" };
  private readonly peakSlice = new GroundingTimingSpan();
  private readonly peakClockInterval = new GroundingTimingSpan();
  private clockMarkMs = 0;
  private clockMarkOperations = 0;
  private clockMarkPhase: string | null = null;
  private sliceStartOperations = 0;
  private sliceStartPhase: string | null = null;
  /** Generator resumptions, not receipt.workUnits (geometric work charges). */
  operations = 0;
  activeMs = 0;
  lastSliceOperations = 0;
  lastSliceMs = 0;
  maximumSliceMs = 0;
  lastPhase: string | null = null;

  /** isCurrent must check the complete borrowed input/region epoch, including
   * missing neighbors and constraints. This class does not invent that owner. */
  constructor(
    steps: Generator<string, GrassBladeGroundingResult, void>,
    private readonly isCurrent: () => boolean,
    consumedWork?: GrassGroundingConsumedWork,
  ) {
    const consumed =
      consumedWork === undefined
        ? undefined
        : validateGrassGroundingConsumedWork(consumedWork);
    this.iterator = steps;
    if (consumed) {
      this.operations = consumed.operations;
      this.activeMs = consumed.activeMs;
      this.maximumSliceMs = consumed.maximumSliceMs;
    }
  }

  get state(): GrassBladeGroundingJobState {
    return this.current;
  }

  /** Snapshot only on demand; two reusable spans, no history or per-tick
   * allocation. Recording uses the continuation's existing clock reads. */
  captureTiming(): GrassGroundingTiming {
    return Object.freeze({
      timeBasis: "slice-elapsed-including-preemption",
      scope: "local-continuation",
      peakSlice: this.peakSlice.capture(),
      peakClockInterval: this.peakClockInterval.capture(),
    });
  }

  private recordClockInterval(now: number): void {
    const elapsed = now - this.clockMarkMs;
    const peak = this.peakClockInterval;
    if (elapsed > peak.elapsedMs) {
      peak.elapsedMs = elapsed;
      peak.startOperations = this.clockMarkOperations;
      peak.endOperations = this.operations;
      peak.startPhase = this.clockMarkPhase;
      peak.endPhase = this.lastPhase;
    }
    this.clockMarkMs = now;
    this.clockMarkOperations = this.operations;
    this.clockMarkPhase = this.lastPhase;
  }

  private close(
    state: GrassBladeGroundingJobState,
  ): GrassBladeGroundingJobState {
    const iterator = this.iterator;
    this.iterator = null;
    this.current = state;
    // Generator has no publication or other external side effects. return
    // releases suspended locals; an unfinished result is never exposed.
    iterator?.return(undefined as never);
    return state;
  }

  cancel(): GrassBladeGroundingJobState {
    if (this.current.status !== "running") return this.current;
    return this.close({ status: "cancelled", reason: "caller" });
  }

  rejectPublication(error: unknown): GrassBladeGroundingJobState {
    if (this.current.status !== "ready")
      throw new Error("Only completed grounding can fail publication");
    return this.close({ status: "failed_input", error });
  }

  private recordSlice(started: number): void {
    const now = performance.now();
    this.lastSliceMs = now - started;
    this.recordClockInterval(now);
    if (this.lastSliceMs > this.peakSlice.elapsedMs) {
      this.peakSlice.elapsedMs = this.lastSliceMs;
      this.peakSlice.startOperations = this.sliceStartOperations;
      this.peakSlice.endOperations = this.operations;
      this.peakSlice.startPhase = this.sliceStartPhase;
      this.peakSlice.endPhase = this.lastPhase;
    }
    this.activeMs += this.lastSliceMs;
    this.maximumSliceMs = Math.max(this.maximumSliceMs, this.lastSliceMs);
    // Core wall time includes suspension; record only active-slice elapsed time.
    if (
      this.current.status === "ready" ||
      this.current.status === "waiting_support"
    )
      this.current.result.receipt.elapsedMs = this.activeMs;
    if (
      this.activeMs >= GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs &&
      (this.current.status === "running" || this.current.status === "ready")
    )
      this.close({ status: "failed_budget", reason: "active_cpu" });
  }

  advance(
    maxOperations: number = GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations,
    sharedDeadlineMs?: number,
  ): GrassBladeGroundingJobState {
    if (
      !Number.isSafeInteger(maxOperations) ||
      maxOperations < 1 ||
      maxOperations > GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations
    )
      throw new Error("Invalid grounding slice operation bound");
    if (
      sharedDeadlineMs !== undefined &&
      (!Number.isFinite(sharedDeadlineMs) || sharedDeadlineMs < 0)
    )
      throw new Error("Invalid grounding shared deadline");
    if (this.current.status !== "running") return this.current;
    const started = performance.now();
    this.clockMarkMs = started;
    this.clockMarkOperations = this.operations;
    this.clockMarkPhase = this.lastPhase;
    this.sliceStartOperations = this.operations;
    this.sliceStartPhase = this.lastPhase;
    // An owner may hand off only what remains of one shared slice. A later
    // caller deadline can never extend this continuation's standalone limit.
    const deadline = Math.min(
      sharedDeadlineMs ?? Infinity,
      started + GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs,
    );
    this.lastSliceOperations = 0;
    let result: GrassBladeGroundingResult | undefined;
    try {
      if (!this.isCurrent())
        return this.close({ status: "cancelled", reason: "invalidated" });
      while (this.iterator && this.lastSliceOperations < maxOperations) {
        if (
          this.operations >= GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations
        )
          return this.close({ status: "failed_budget", reason: "operations" });
        // This caps synchronous work between checks, not one JS operation's
        // duration. Native allocations/GC cannot be preempted; retain overshoot.
        if (
          this.lastSliceOperations %
            GRASS_BLADE_GROUNDING_JOB_LIMITS.clockInterval ===
          0
        ) {
          const now = performance.now();
          this.recordClockInterval(now);
          const elapsed = now - started;
          if (
            this.activeMs + elapsed >=
            GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs
          )
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
          result = step.value;
          break;
        }
        this.lastPhase = step.value;
      }
      if (!this.isCurrent())
        return this.close({ status: "cancelled", reason: "invalidated" });
      if (result) {
        if (result.status === "ready") this.close({ status: "ready", result });
        else if (result.reason === "work_budget")
          this.close({ status: "failed_budget", reason: "grounding_work" });
        else this.close({ status: "waiting_support", result });
      }
    } catch (error) {
      this.close({ status: "failed_input", error });
    } finally {
      this.recordSlice(started);
    }
    return this.current;
  }
}

export type GrassGroundingFailureOwner = Readonly<{
  key: string;
  nodeId: number;
  lod: 0 | 1 | 2;
  isLodSwap: boolean;
  bounds: Readonly<TerrainGridBounds>;
}>;

/** Bounded terminal snapshot for the owner's existing one-shot failure log.
 * Active time is cumulative slice elapsed time, not measured CPU utilization.
 * The owner supplies ticket/frame identity; no input arrays or error graph are
 * retained, and observing never advances or changes the continuation.
 * Optional clocks mark observation on this agent, not remote worker execution.
 * Wall time can jump; the monotonic origin does not prove sleep-clock behavior. */
export function captureGrassGroundingFailure(
  job: Pick<
    GrassGroundingContinuation,
    | "state"
    | "activeMs"
    | "operations"
    | "lastSliceOperations"
    | "lastSliceMs"
    | "maximumSliceMs"
    | "lastPhase"
  > & { readonly cumulativeMaximumSliceMs?: number },
  owner?: GrassGroundingFailureOwner,
) {
  const state = job.state;
  if (state.status !== "failed_budget" && state.status !== "failed_input")
    return null;
  let inputError: string | null = null;
  if (owner && state.status === "failed_input") {
    inputError = "Non-string grounding input failure";
    if (typeof state.error === "string") inputError = state.error;
    else if (state.error !== null && typeof state.error === "object") {
      // Diagnostics must not invoke an error object's accessor or toString.
      try {
        const message = Object.getOwnPropertyDescriptor(state.error, "message");
        if (message && "value" in message && typeof message.value === "string")
          inputError = message.value;
      } catch {
        inputError = "Unreadable grounding input failure";
      }
    }
    inputError = inputError.slice(0, 256);
  }
  return Object.freeze({
    status: state.status,
    reason: state.status === "failed_budget" ? state.reason : "input",
    activeMs: job.activeMs,
    operations: job.operations,
    lastSliceOperations: job.lastSliceOperations,
    lastSliceMs: job.lastSliceMs,
    maximumSliceMs: job.maximumSliceMs,
    lastPhase: job.lastPhase,
    activeLimitMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
    targetSliceMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs,
    ...(owner
      ? {
          observation: Object.freeze({
            observedAtMs: performance.now(),
            observedAtUnixMs: Date.now(),
            timeOriginUnixMs: performance.timeOrigin,
            // Coordinator maximumSliceMs covers only main-thread advances;
            // its cumulative diagnostic also includes remote fitting slices.
            cumulativeMaximumSliceMs:
              job.cumulativeMaximumSliceMs ?? job.maximumSliceMs,
            inputError,
            key: owner.key.slice(0, 128),
            keyTruncated: owner.key.length > 128,
            nodeId: owner.nodeId,
            lod: owner.lod,
            isLodSwap: owner.isLodSwap,
            bounds: Object.freeze({
              minX: owner.bounds.minX,
              maxX: owner.bounds.maxX,
              minZ: owner.bounds.minZ,
              maxZ: owner.bounds.maxZ,
            }),
          }),
        }
      : {}),
  });
}

/** Numerical-only entry point; installation composes projection and provenance
 * into GrassGroundingContinuation so those phases share the same slice budget. */
export class GrassBladeGroundingJob extends GrassGroundingContinuation {
  constructor(request: GrassBladeGroundingRequest, isCurrent: () => boolean) {
    super(groundGrassBladeSteps(request), isCurrent);
  }
}
/** Stable, in-place interval ordering. A pair needs one comparison and at most
 * two reference stores, not a scratch array and merge/copy passes. Larger lists
 * retain the resumable bottom-up merge sort and explicit scratch allocation.
 * Only clipped edge intervals from the grounding core are admitted. */
function* sortedIntervals(
  values: [number, number][],
): Generator<string, void, void> {
  if (values.length < 2) return;
  if (values.length === 2) {
    yield "interval_pair_order";
    // Match the merge's original comparison, including stable equal starts.
    // These intervals are job-local; no borrowed geometry is cached or changed.
    if (!(values[0][0] <= values[1][0])) {
      const first = values[0];
      values[0] = values[1];
      values[1] = first;
    }
    return;
  }
  yield "interval_scratch_allocation";
  const scratch = new Array<[number, number]>(values.length);
  for (let width = 1; width < values.length; width *= 2) {
    for (let first = 0; first < values.length; first += width * 2) {
      const middle = Math.min(first + width, values.length);
      const end = Math.min(first + width * 2, values.length);
      let left = first,
        right = middle;
      for (let dst = first; dst < end; dst++) {
        yield "interval_merge";
        scratch[dst] =
          right >= end || (left < middle && values[left][0] <= values[right][0])
            ? values[left++]
            : values[right++];
      }
    }
    for (let i = 0; i < values.length; i++) {
      yield "interval_copy";
      values[i] = scratch[i];
    }
  }
}

/** Synchronous offline/test API. Shares every validation and numerical step
 * with the resumable job; never call this drain from a live frame install. */
export function groundGrassBlades(
  request: GrassBladeGroundingRequest,
): GrassBladeGroundingResult {
  const steps = groundGrassBladeSteps(request);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
