import THREE from "../../../extras/three/three";
import {
  createGrassTerrainSurfaceOperations,
  type GrassTerrainSurfaceSnapshot,
} from "../../../utils/workers/GrassTerrainSurfaceSnapshot";
import type { GrassGroundingInputLease } from "./GrassGroundingPipeline";
import type { GrassGroundingRoadSegment } from "./GrassBladeGrounding";
import type { FlowerResourceClearanceSnapshot } from "./FlowerResourceClearance";
import { getRootedFlowerWindBounds } from "./RootedFlowerMaterial";
import {
  RetainedTerrainSurface,
  type TerrainGridBounds,
  type TerrainGridSample,
} from "./TerrainGridSurface";
import type { RetainedTerrainRegion } from "./TerrainVisualManager";

export const ROOTED_FLOWER_PLACEMENT_LIMITS = Object.freeze({
  cellSize: 8,
  visibleRadius: 32,
  margin: 8,
  cellRadius: 5,
  candidatesPerCell: 4,
  maxCandidates: 484,
  maxSurfaces: 16,
  maxRoadSegments: 4096,
  maxInputSteps: 100_000,
  maxSteps: 4_000_000,
  minScale: 0.85,
  maxScale: 1.15,
});

export type RootedFlowerPlacementRequest = Readonly<{
  /** floor(focus / 8) * 8 + 4 on both axes. */
  origin: Readonly<{ x: number; z: number }>;
  seed: number;
  geometry: THREE.BufferGeometry;
  region: RetainedTerrainRegion;
  inputs: GrassGroundingInputLease;
  resources: FlowerResourceClearanceSnapshot;
  /** Captured world habitat eligibility; no height fallback or grass RNG. */
  grassPlacement: (x: number, z: number) => number;
  oceanLevel: number;
}>;

export type RootedFlowerPlacementDiagnostics = Readonly<{
  candidates: number;
  accepted: number;
  steps: number;
  inputSteps: number;
  deferredTerrain: number;
  maximumHorizontalReach: number;
  maximumRootYRoundingError: number;
  rejected: Readonly<
    Record<
      | "horizon"
      | "habitat"
      | "coverage"
      | "overlap"
      | "surface"
      | "slope"
      | "road"
      | "zone"
      | "water"
      | "resource",
      number
    >
  >;
}>;

export type RootedFlowerPlacementResult = Readonly<{
  /** Detached column-major Float32 matrices; root centers only are ground-fit.
   * Upright stems do not fit every root-ring vertex to sloping terrain. */
  matrices: Float32Array;
  count: number;
  diagnostics: RootedFlowerPlacementDiagnostics;
  /** Full resource re-scan: call at publication/lifecycle, never per candidate. */
  isCurrent(): boolean;
}>;

function hash(seed: number, x: number, z: number, ordinal: number): number {
  let value =
    (seed ^
      Math.imul(x, 0x9e3779b1) ^
      Math.imul(z, 0x85ebca77) ^
      Math.imul(ordinal, 0xc2b2ae3d)) >>>
    0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

/** One jittered candidate per 4m quadrant, independent of the current focus.
 * Spread the existing four roots through suitable meadow instead of placing
 * every sprig in one tiny cluster. Patch, acceptance, yaw and scale hash lanes
 * stay independent. Roots retain a 1m cell inset and >=2m pair separation,
 * including adjacent cells and Float32 rounding in the admitted domain.
 * These root distances do not replace the full geometry/wind clearance checks.
 */
export function getRootedFlowerCandidatePosition(
  seed: number,
  cellX: number,
  cellZ: number,
  ordinal: number,
): Readonly<{ x: number; z: number }> {
  if (
    !Number.isSafeInteger(seed) ||
    seed < -2147483648 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger(cellX) ||
    !Number.isSafeInteger(cellZ) ||
    cellX < -(2 ** 17) - 5 ||
    cellX > 2 ** 17 + 4 ||
    cellZ < -(2 ** 17) - 5 ||
    cellZ > 2 ** 17 + 4 ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= 4
  )
    throw new Error("Invalid bounded rooted flower candidate");
  const centerX = cellX * 8 + 2 + (ordinal % 2) * 4;
  const centerZ = cellZ * 8 + 2 + Math.floor(ordinal / 2) * 4;
  return {
    x: Math.fround(centerX + (hash(seed, cellX, cellZ, ordinal * 8) - 0.5) * 2),
    z: Math.fround(
      centerZ + (hash(seed, cellX, cellZ, ordinal * 8 + 1) - 0.5) * 2,
    ),
  };
}

function overlap(a: TerrainGridBounds, b: TerrainGridBounds): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ
  );
}

function area(a: TerrainGridBounds, b: TerrainGridBounds): number {
  return (
    Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) *
    Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ))
  );
}

function pointSegmentDistance(
  x: number,
  z: number,
  road: GrassGroundingRoadSegment,
): number {
  const dx = road.endX - road.startX,
    dz = road.endZ - road.startZ;
  const squared = dx * dx + dz * dz;
  const t =
    squared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((x - road.startX) * dx + (z - road.startZ) * dz) / squared,
          ),
        );
  return Math.hypot(x - road.startX - t * dx, z - road.startZ - t * dz);
}

/** One bounded (<=700 vertex) cold-path query shared by capture and placement.
 * No cached bounding volume or registered instance matrix storage is modified. */
export function getRootedFlowerPlacementBounds(
  geometry: THREE.BufferGeometry,
  origin: Readonly<{ x: number; z: number }>,
): TerrainGridBounds {
  if (
    !(geometry instanceof THREE.BufferGeometry) ||
    !Number.isSafeInteger((origin.x - 4) / 8) ||
    !Number.isSafeInteger((origin.z - 4) / 8) ||
    Math.abs(origin.x) > 2 ** 20 ||
    Math.abs(origin.z) > 2 ** 20
  )
    throw new Error("Invalid rooted flower placement bounds origin");
  const position = geometry.getAttribute("position"),
    height = geometry.getAttribute("flowerHeight");
  if (
    !(position instanceof THREE.BufferAttribute) ||
    !(position.array instanceof Float32Array) ||
    position.itemSize !== 3 ||
    position.normalized ||
    !Number.isInteger(position.count) ||
    position.count < 3 ||
    position.count > 700 ||
    !(height instanceof THREE.BufferAttribute) ||
    !(height.array instanceof Float32Array) ||
    height.itemSize !== 2 ||
    height.count !== position.count ||
    height.normalized
  )
    throw new Error("Invalid rooted flower placement bounds geometry");
  const fullHeight = height.getY(0);
  let radius = 0,
    minY = Infinity;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const x = position.getX(vertex),
      y = position.getY(vertex),
      z = position.getZ(vertex);
    if (
      ![x, y, z].every(Number.isFinite) ||
      y < 0 ||
      height.getX(vertex) !== y ||
      height.getY(vertex) !== fullHeight
    )
      throw new Error("Invalid rooted flower placement bounds metadata");
    radius = Math.max(radius, Math.hypot(x, z));
    minY = Math.min(minY, y);
  }
  if (minY !== 0)
    throw new Error("Rooted flower placement bounds require an authored root");
  const scale = Math.fround(ROOTED_FLOWER_PLACEMENT_LIMITS.maxScale);
  const wind = getRootedFlowerWindBounds(fullHeight, scale);
  const reach = radius * scale * (1 + 2e-6) + Math.hypot(wind.x, wind.z) + 1e-5;
  if (!Number.isFinite(reach) || reach > 1)
    throw new Error("Rooted flower placement reach exceeds margin admission");
  return {
    minX: origin.x - 44 - reach,
    maxX: origin.x + 44 + reach,
    minZ: origin.z - 44 - reach,
    maxZ: origin.z + 44 + reach,
  };
}

/** Opt-in candidate cooperative CPU placement. Randomness is keyed by world cell
 * and ordinal, so moving a horizon cannot reshuffle a retained cell. Each resume
 * does one candidate/owner/constraint operation or one bounded native helper
 * step; no elapsed-time budget, grass RNG, lease ownership or publication lives
 * here. Retained admission already proves every owner's full rectangular grid
 * coverage (including indexed refinement); region rectangles alone do not.
 */
export function* createRootedFlowerPlacementSteps(
  request: RootedFlowerPlacementRequest,
): Generator<string, RootedFlowerPlacementResult, void> {
  const { geometry, region, inputs, resources, grassPlacement, oceanLevel } =
    request;
  const origin = { x: request.origin.x, z: request.origin.z };
  const seed = request.seed;
  if (
    !Number.isSafeInteger(seed) ||
    seed < -2147483648 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger((origin.x - 4) / 8) ||
    !Number.isSafeInteger((origin.z - 4) / 8) ||
    Math.abs(origin.x) > 2 ** 20 ||
    Math.abs(origin.z) > 2 ** 20 ||
    !Number.isFinite(oceanLevel) ||
    typeof grassPlacement !== "function" ||
    !(geometry instanceof THREE.BufferGeometry) ||
    geometry.hasAttribute("tangent") ||
    !Array.isArray(region.surfaces) ||
    region.surfaces.length > 16
  )
    throw new Error("Invalid rooted flower placement request");
  const position = geometry.getAttribute("position");
  const height = geometry.getAttribute("flowerHeight");
  if (
    !(position instanceof THREE.BufferAttribute) ||
    !(position.array instanceof Float32Array) ||
    position.itemSize !== 3 ||
    position.count < 3 ||
    position.count > 700 ||
    !Number.isInteger(position.count) ||
    position.normalized ||
    !(height instanceof THREE.BufferAttribute) ||
    !(height.array instanceof Float32Array) ||
    height.itemSize !== 2 ||
    height.count !== position.count ||
    height.normalized
  )
    throw new Error("Invalid rooted flower placement geometry");
  const positionArray = position.array,
    heightArray = height.array;
  const positionVersion = position.version,
    heightVersion = height.version;
  const vertexCount = position.count;
  const surfaces = [...region.surfaces];
  let stale = false;
  const isGeometryCurrent = () => {
    if (stale) return false;
    try {
      stale =
        geometry.getAttribute("position") !== position ||
        geometry.getAttribute("flowerHeight") !== height ||
        position.array !== positionArray ||
        height.array !== heightArray ||
        position.version !== positionVersion ||
        height.version !== heightVersion ||
        position.count !== vertexCount ||
        height.count !== vertexCount ||
        position.itemSize !== 3 ||
        height.itemSize !== 2 ||
        position.normalized ||
        height.normalized;
    } catch {
      stale = true;
    }
    return !stale;
  };
  const isLeaseCurrent = () => {
    if (!isGeometryCurrent()) return false;
    try {
      stale =
        !region.isCurrent() ||
        !inputs.isCurrent() ||
        region.surfaces.length !== surfaces.length ||
        surfaces.some((surface, index) => region.surfaces[index] !== surface);
    } catch {
      stale = true;
    }
    return !stale;
  };
  const requireLiveLeases = () => {
    if (!isLeaseCurrent())
      throw new Error("Stale rooted flower placement leases");
  };
  const isCurrent = () => {
    if (!isLeaseCurrent()) return false;
    try {
      stale = !resources.isCurrent();
    } catch {
      stale = true;
    }
    return !stale;
  };
  const check = () => {
    if (!isGeometryCurrent())
      throw new Error("Stale rooted flower placement geometry");
    if (++diagnostics.steps > ROOTED_FLOWER_PLACEMENT_LIMITS.maxSteps)
      throw new Error("Rooted flower placement step cap exceeded");
  };
  const diagnostics = {
    candidates: 0,
    accepted: 0,
    steps: 0,
    inputSteps: 0,
    deferredTerrain: 0,
    maximumHorizontalReach: 0,
    maximumRootYRoundingError: 0,
    rejected: {
      horizon: 0,
      habitat: 0,
      coverage: 0,
      overlap: 0,
      surface: 0,
      slope: 0,
      road: 0,
      zone: 0,
      water: 0,
      resource: 0,
    },
  };
  if (!isCurrent()) throw new Error("Stale rooted flower placement leases");
  const fullHeight = height.getY(0);
  let staticRadius = 0,
    minimumY = Infinity;
  for (let vertex = 0; vertex < position.count; vertex++) {
    yield "flower_geometry";
    check();
    const x = position.getX(vertex),
      y = position.getY(vertex),
      z = position.getZ(vertex);
    if (
      ![x, y, z].every(Number.isFinite) ||
      y < 0 ||
      height.getX(vertex) !== y ||
      height.getY(vertex) !== fullHeight
    )
      throw new Error("Invalid rooted flower placement authored metadata");
    staticRadius = Math.max(staticRadius, Math.hypot(x, z));
    minimumY = Math.min(minimumY, y);
  }
  if (minimumY !== 0)
    throw new Error("Rooted flower placement requires an authored root");
  // Rotation entries are independently Float32-rounded. 2e-6 covers their
  // relative norm error; the final 1e-5 is conservative contact clearance.
  const needed = getRootedFlowerPlacementBounds(geometry, origin);
  if (
    ![
      region.bounds.minX,
      region.bounds.maxX,
      region.bounds.minZ,
      region.bounds.maxZ,
    ].every(Number.isFinite) ||
    region.bounds.minX > needed.minX ||
    region.bounds.maxX < needed.maxX ||
    region.bounds.minZ > needed.minZ ||
    region.bounds.maxZ < needed.maxZ
  )
    throw new Error(
      "Rooted flower retained region omits complete swept horizon",
    );
  const owners: { surface: RetainedTerrainSurface; box: TerrainGridBounds }[] =
    [];
  for (const surface of surfaces) {
    yield "flower_surface_admission";
    check();
    if (
      !(surface instanceof RetainedTerrainSurface) ||
      ![surface.centerX, surface.centerZ, surface.size].every(
        Number.isFinite,
      ) ||
      surface.size <= 0 ||
      owners.some((entry) => entry.surface === surface)
    )
      throw new Error("Invalid rooted flower retained owner");
    owners.push({
      surface,
      box: {
        minX: surface.centerX - surface.size / 2,
        maxX: surface.centerX + surface.size / 2,
        minZ: surface.centerZ - surface.size / 2,
        maxZ: surface.centerZ + surface.size / 2,
      },
    });
  }

  // Consume this fresh lease exactly once. Cancellation closes its unfinished
  // iterator, never its terrain/resource owners. Every child yield is forwarded.
  let consumed = false;
  let constraints: ReturnType<
    GrassGroundingInputLease["steps"]["next"]
  >["value"];
  try {
    for (;;) {
      check();
      if (
        ++diagnostics.inputSteps > ROOTED_FLOWER_PLACEMENT_LIMITS.maxInputSteps
      )
        throw new Error("Rooted flower input step cap exceeded");
      const next = inputs.steps.next();
      if (next.done) {
        consumed = true;
        constraints = next.value;
        break;
      }
      yield next.value;
    }
  } finally {
    if (!consumed) inputs.steps.return(undefined as never);
  }
  if (
    !constraints ||
    typeof constraints === "string" ||
    !Array.isArray(constraints.roadSegments) ||
    constraints.roadSegments.length > 4096
  )
    throw new Error("Invalid or reused rooted flower constraint inputs");
  const operations = createGrassTerrainSurfaceOperations();
  const clone = operations.cloneSnapshotSteps(constraints.terrainSurface);
  let snapshot: GrassTerrainSurfaceSnapshot | undefined;
  try {
    for (;;) {
      check();
      const next = clone.next();
      if (next.done) {
        snapshot = next.value;
        break;
      }
      yield next.value;
    }
  } finally {
    clone.return(undefined as never);
  }
  if (!snapshot) throw new Error("Missing rooted flower constraint snapshot");
  const roads: GrassGroundingRoadSegment[] = [];
  const roadCount = constraints.roadSegments.length;
  for (let roadIndex = 0; roadIndex < roadCount; roadIndex++) {
    yield "flower_road_admission";
    check();
    const road = constraints.roadSegments[roadIndex];
    if (!road) throw new Error("Invalid rooted flower road capsule");
    const blendWidth = road.blendWidth ?? 0.5;
    if (
      ![
        road.startX,
        road.startZ,
        road.endX,
        road.endZ,
        road.width,
        blendWidth,
      ].every(Number.isFinite) ||
      road.width < 0 ||
      blendWidth < 0 ||
      Math.max(
        Math.abs(road.startX),
        Math.abs(road.startZ),
        Math.abs(road.endX),
        Math.abs(road.endZ),
        road.width,
        blendWidth,
      ) >
        2 ** 21
    )
      throw new Error("Invalid rooted flower road capsule");
    // Validate every supplied segment before this broad phase. The retained
    // horizon already includes the maximum flower sweep; a strictly disjoint
    // expanded road AABB cannot affect any candidate's exact capsule check.
    const padding = road.width / 2 + blendWidth;
    if (
      Math.max(road.startX, road.endX) + padding < needed.minX ||
      Math.min(road.startX, road.endX) - padding > needed.maxX ||
      Math.max(road.startZ, road.endZ) + padding < needed.minZ ||
      Math.min(road.startZ, road.endZ) - padding > needed.maxZ
    )
      continue;
    roads.push({
      startX: road.startX,
      startZ: road.startZ,
      endX: road.endX,
      endZ: road.endZ,
      width: road.width,
      blendWidth,
    });
  }
  requireLiveLeases();
  const exclusions: TerrainGridBounds[] = [];
  for (const zone of snapshot.zones) {
    yield "flower_zone_admission";
    check();
    if (zone.excludeGrass === false) continue;
    if (zone.grassExclusionBounds) {
      exclusions.push({ ...zone.grassExclusionBounds });
      continue;
    }
    if (zone.radialPond) {
      const r = zone.radialPond.bankOuterRadius + zone.blendRadius;
      exclusions.push({
        minX: zone.centerX - r,
        maxX: zone.centerX + r,
        minZ: zone.centerZ - r,
        maxZ: zone.centerZ + r,
      });
    } else if (zone.tileMask) {
      const box = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };
      for (const key of zone.tileMask) {
        yield "flower_mask_envelope";
        check();
        const [x, z] = key.split(",").map(Number);
        box.minX = Math.min(box.minX, x - zone.blendRadius);
        box.maxX = Math.max(box.maxX, x + 1 + zone.blendRadius);
        box.minZ = Math.min(box.minZ, z - zone.blendRadius);
        box.maxZ = Math.max(box.maxZ, z + 1 + zone.blendRadius);
      }
      for (const tile of zone.tileMaskTiles ?? []) {
        yield "flower_mask_envelope";
        check();
        box.minX = Math.min(box.minX, tile.x - zone.blendRadius);
        box.maxX = Math.max(box.maxX, tile.x + 1 + zone.blendRadius);
        box.minZ = Math.min(box.minZ, tile.z - zone.blendRadius);
        box.maxZ = Math.max(box.maxZ, tile.z + 1 + zone.blendRadius);
      }
      if (box.minX <= box.maxX) exclusions.push(box);
    } else {
      exclusions.push({
        minX: zone.centerX - zone.width / 2 - zone.blendRadius,
        maxX: zone.centerX + zone.width / 2 + zone.blendRadius,
        minZ: zone.centerZ - zone.depth / 2 - zone.blendRadius,
        maxZ: zone.centerZ + zone.depth / 2 + zone.blendRadius,
      });
    }
  }
  for (const polygon of snapshot.exclusionPolygons ?? []) {
    yield "flower_polygon_envelope";
    check();
    // Deliberately conservative full polygon AABB, not sparse point probes.
    exclusions.push({
      minX: polygon.minX,
      maxX: polygon.maxX,
      minZ: polygon.minZ,
      maxZ: polygon.maxZ,
    });
  }
  const matrices: number[] = [];
  const matrix = new THREE.Matrix4();
  const stored = new Float32Array(16);
  const sample: TerrainGridSample = {
    height: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    faceIndex: 0,
  };
  const centerX = (origin.x - 4) / 8,
    centerZ = (origin.z - 4) / 8;
  for (let cx = centerX - 5; cx <= centerX + 5; cx++)
    for (let cz = centerZ - 5; cz <= centerZ + 5; cz++) {
      // Broad meadow coverage with subtle regional thinning. Habitat and full
      // swept clearances still reject roads, water, resources and poor ground;
      // no extra candidate, pool capacity or scheduling allowance is added.
      const patch = hash(seed, Math.floor(cx / 3), Math.floor(cz / 3), 100);
      for (let ordinal = 0; ordinal < 4; ordinal++) {
        yield "flower_candidate";
        check();
        diagnostics.candidates++;
        const { x, z } = getRootedFlowerCandidatePosition(
          seed,
          cx,
          cz,
          ordinal,
        );
        if (Math.hypot(x - origin.x, z - origin.z) > 40) {
          diagnostics.rejected.horizon++;
          continue;
        }
        const habitat = grassPlacement(x, z);
        if (!Number.isFinite(habitat) || habitat < 0 || habitat > 1)
          throw new Error("Invalid rooted flower habitat eligibility");
        if (
          hash(seed, cx, cz, ordinal * 8 + 2) >=
          habitat * (0.9 + 0.1 * (1 - patch))
        ) {
          diagnostics.rejected.habitat++;
          continue;
        }
        const yaw = hash(seed, cx, cz, ordinal * 8 + 3) * Math.PI * 2;
        const scale = 0.85 + hash(seed, cx, cz, ordinal * 8 + 4) * 0.3;
        matrix.compose(
          new THREE.Vector3(x, 0, z),
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            yaw,
          ),
          new THREE.Vector3(scale, scale, scale),
        );
        matrix.toArray(stored);
        const actualScale = stored[5];
        const wind = getRootedFlowerWindBounds(fullHeight, actualScale);
        const horizontalScale = Math.max(
          Math.hypot(stored[0], stored[2]),
          Math.hypot(stored[8], stored[10]),
        );
        const reach =
          staticRadius * horizontalScale * (1 + 2e-6) +
          Math.hypot(wind.x, wind.z) +
          1e-5;
        diagnostics.maximumHorizontalReach = Math.max(
          diagnostics.maximumHorizontalReach,
          reach,
        );
        const box = {
          minX: x - reach,
          maxX: x + reach,
          minZ: z - reach,
          maxZ: z + reach,
        };
        // These complete horizontal envelopes can prove rejection without any
        // terrain residency. Do not turn known roads/water/pads into deferred work.
        let rejected = false;
        for (const road of roads) {
          yield "flower_road";
          check();
          if (
            pointSegmentDistance(x, z, road) <=
            road.width / 2 + (road.blendWidth ?? 0.5) + reach
          ) {
            diagnostics.rejected.road++;
            rejected = true;
            break;
          }
        }
        if (rejected) continue;
        for (const exclusion of exclusions) {
          yield "flower_exclusion";
          check();
          if (overlap(box, exclusion)) {
            diagnostics.rejected.zone++;
            rejected = true;
            break;
          }
        }
        if (rejected) continue;
        for (const body of snapshot.waterBodies) {
          yield "flower_water";
          check();
          if (
            Math.hypot(x - body.centerX, z - body.centerZ) <=
            body.radius + reach
          ) {
            diagnostics.rejected.water++;
            rejected = true;
            break;
          }
        }
        if (rejected) continue;
        yield "flower_resource";
        check();
        if (!resources.accepts({ x, z }, reach)) {
          diagnostics.rejected.resource++;
          continue;
        }
        const nearby: typeof owners = [];
        let covered = 0;
        const rootOwners: RetainedTerrainSurface[] = [];
        for (const entry of owners) {
          yield "flower_coverage";
          check();
          const overlapArea = area(box, entry.box);
          if (overlapArea > 0) {
            nearby.push(entry);
            covered += overlapArea;
          }
          if (
            x >= entry.box.minX &&
            x <= entry.box.maxX &&
            z >= entry.box.minZ &&
            z <= entry.box.maxZ
          )
            rootOwners.push(entry.surface);
        }
        let ambiguous = false;
        for (let a = 0; a < nearby.length; a++)
          for (let b = a + 1; b < nearby.length; b++) {
            yield "flower_owner_overlap";
            check();
            const intersection = {
              minX: Math.max(nearby[a].box.minX, nearby[b].box.minX),
              maxX: Math.min(nearby[a].box.maxX, nearby[b].box.maxX),
              minZ: Math.max(nearby[a].box.minZ, nearby[b].box.minZ),
              maxZ: Math.min(nearby[a].box.maxZ, nearby[b].box.maxZ),
            };
            if (
              intersection.minX < intersection.maxX &&
              intersection.minZ < intersection.maxZ &&
              area(box, intersection) > 0
            )
              ambiguous = true;
          }
        if (ambiguous) {
          diagnostics.rejected.overlap++;
          diagnostics.deferredTerrain++;
          continue;
        }
        const expected = 4 * reach * reach;
        if (
          rootOwners.length === 0 ||
          Math.abs(covered - expected) > Math.max(1e-12, expected * 1e-9)
        ) {
          diagnostics.rejected.coverage++;
          diagnostics.deferredTerrain++;
          continue;
        }
        // Only zero-area shared edges/corners can reach this branch with more
        // than one owner: positive-area overlaps were rejected above. Stable
        // ordering makes the selected receipt independent of region enumeration.
        rootOwners.sort(
          (a, b) =>
            a.nodeId - b.nodeId ||
            a.centerX - b.centerX ||
            a.centerZ - b.centerZ ||
            a.size - b.size ||
            a.revision.localeCompare(b.revision),
        );
        let rootY: number | undefined,
          minimumNormalY = 1,
          rounding = 0,
          sampleFailed = false;
        for (const rootOwner of rootOwners) {
          yield "flower_root_sample";
          check();
          requireLiveLeases();
          // Native sample is bounded to one admitted <=512-face cell. Shared
          // owners must agree at the *same Float32 root Y*: no arbitrary epsilon
          // bridges a crack. Each raw height may differ only by its rounding to
          // that identical stored coordinate, and all such errors are reported.
          if (
            !rootOwner.sample(
              x - rootOwner.centerX,
              z - rootOwner.centerZ,
              sample,
            ) ||
            ![sample.height, sample.nx, sample.ny, sample.nz].every(
              Number.isFinite,
            )
          ) {
            sampleFailed = true;
            break;
          }
          const roundedY = Math.fround(sample.height);
          if (
            !Number.isFinite(roundedY) ||
            (rootY !== undefined && roundedY !== rootY)
          ) {
            sampleFailed = true;
            break;
          }
          rootY ??= roundedY;
          minimumNormalY = Math.min(minimumNormalY, sample.ny);
          rounding = Math.max(rounding, Math.abs(roundedY - sample.height));
        }
        if (sampleFailed || rootY === undefined) {
          diagnostics.rejected.surface++;
          diagnostics.deferredTerrain++;
          continue;
        }
        if (minimumNormalY < 0.9) {
          diagnostics.rejected.slope++;
          continue;
        }
        stored[13] = rootY;
        diagnostics.maximumRootYRoundingError = Math.max(
          diagnostics.maximumRootYRoundingError,
          rounding,
        );
        // Global ocean remains a conservative floor, even under a local body.
        if (stored[13] - wind.y <= oceanLevel + 0.1) {
          diagnostics.rejected.water++;
          continue;
        }
        for (let component = 0; component < 16; component++)
          matrices.push(stored[component]);
        diagnostics.accepted++;
      }
    }
  yield "flower_result_allocation";
  check();
  requireLiveLeases();
  const detached = new Float32Array(matrices);
  return Object.freeze({
    matrices: detached,
    count: diagnostics.accepted,
    diagnostics: Object.freeze({
      ...diagnostics,
      rejected: Object.freeze({ ...diagnostics.rejected }),
    }),
    isCurrent,
  });
}
