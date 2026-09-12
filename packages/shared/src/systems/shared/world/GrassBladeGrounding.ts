import type THREE from "../../../extras/three/three";
import {
  createGrassTerrainSurfaceOperations,
  type GrassTerrainSurfaceSnapshot,
} from "../../../utils/workers/GrassTerrainSurfaceSnapshot";
import type { GrassAnchorData } from "./GrassTerrainProjection";
import {
  RetainedTerrainSurface,
  type TerrainGridBounds,
  type TerrainGridSample,
} from "./TerrainGridSurface";

export const GRASS_BLADE_GROUNDING_LIMITS = Object.freeze({
  maxClumps: 4096,
  maxSurfaces: 16,
  maxRoadSegments: 4096,
  maxScale: 4,
  defaultWorkBudget: 1_000_000,
  maximumWorkBudget: 1_000_000,
});

const LODS = [
  { blades: 24, segments: 3 },
  { blades: 12, segments: 2 },
  { blades: 4, segments: 1 },
] as const;
const NUMERIC_GUARD = 0.00001;

export type GrassGroundingRoadSegment = {
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  width: number;
};

export type GrassBladeGroundingRequest = {
  /** Already projected by projectGrassAnchors; never mutated or reseeded. */
  data: GrassAnchorData;
  geometry: THREE.BufferGeometry;
  lod: 0 | 1 | 2;
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
  endpointQueries: number;
  triangleVisits: number;
  workUnits: number;
  workBudget: number;
  correctionBytes: number;
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
      sourceIndices: Uint32Array;
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
  for (const [start, end, min, max] of [
    [s.startX, s.endX, b.minX, b.maxX],
    [s.startZ, s.endZ, b.minZ, b.maxZ],
  ]) {
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
  for (const [x, z] of [
    [b.minX, b.minZ],
    [b.minX, b.maxZ],
    [b.maxX, b.minZ],
    [b.maxX, b.maxZ],
  ]) {
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

function validateGeometry(geometry: THREE.BufferGeometry, lod: 0 | 1 | 2) {
  const tier = LODS[lod];
  if (!tier) throw new Error("Invalid grass grounding LOD");
  const { blades, segments } = tier,
    verticesPerBlade = segments * 2 + 1;
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
      attribute.normalized ||
      !Array.from(attribute.array).every(Number.isFinite)
    )
      throw new Error("Invalid grass grounding vertex attributes");
  }
  if (
    !index ||
    index.itemSize !== 1 ||
    index.normalized ||
    index.count !== blades * ((segments - 1) * 2 + 1) * 3 ||
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
    for (let row = 0; row < segments - 1; row++) {
      const a = first + row * 2;
      for (const value of [a, a + 1, a + 2, a + 1, a + 3, a + 2])
        expectIndex(value);
    }
    for (const value of [tip - 2, tip - 1, tip]) expectIndex(value);
  }
  for (let v = 0; v < vertices; v++) {
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
 * `work_budget` is NOT a resumable result: retrying identical input/budget cannot
 * make progress. Integration must either establish admitted work fits the budget
 * or add an explicit bounded continuation; never requeue this result forever.
 */
export function groundGrassBlades(
  request: GrassBladeGroundingRequest,
): GrassBladeGroundingResult {
  const started = performance.now();
  const { data, ownSurface, geometry, lod, wind } = request;
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
    for (const value of values)
      if (!Number.isFinite(value))
        throw new Error("Nonfinite grass grounding instance value");
  }
  for (let i = 0; i < data.count; i++) {
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
  const snapshot = createGrassTerrainSurfaceOperations().validateSnapshot(
    request.terrainSurface,
  );
  if (
    !Array.isArray(request.roadSegments) ||
    request.roadSegments.length > GRASS_BLADE_GROUNDING_LIMITS.maxRoadSegments
  )
    throw new Error("Invalid grass grounding road count");
  for (const road of request.roadSegments) {
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
  }
  const { blades, verticesPerBlade, position, uv } = validateGeometry(
    geometry,
    lod,
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
  const used = new Map<RetainedTerrainSurface, Set<SurfaceUse>>();
  const receipt: GrassBladeGroundingReceipt = {
    elapsedMs: 0,
    inputClumps: data.count,
    processedClumps: 0,
    retainedClumps: 0,
    bladesPerClump: blades,
    endpointQueries: 0,
    triangleVisits: 0,
    workUnits: 0,
    workBudget,
    correctionBytes: 0,
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
  const sampleEndpoint = (point: Point) => {
    receipt.endpointQueries++;
    // Half-open ownership matches TerrainVisualManager; allow a sole outer edge.
    let selected: SurfaceEntry | undefined;
    for (const entry of entries) {
      take();
      const b = entry.box;
      if (
        point.x >= b.minX &&
        point.x < b.maxX &&
        point.z >= b.minZ &&
        point.z < b.maxZ
      ) {
        selected = entry;
        break;
      }
      if (
        !selected &&
        point.x >= b.minX &&
        point.x <= b.maxX &&
        point.z >= b.minZ &&
        point.z <= b.maxZ
      )
        selected = entry;
    }
    if (
      !selected ||
      !selected.surface.sample(
        point.x - selected.surface.centerX,
        point.z - selected.surface.centerZ,
        sample,
      )
    )
      throw new DeferredGrounding("missing_surface");
    markSurface(selected.surface, "endpoint");
    return sample.height;
  };
  const ensureCoverage = (box: TerrainGridBounds) => {
    let covered = 0;
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      take();
      const area = overlapArea(box, a.box);
      if (!area) continue;
      markSurface(a.surface, "envelope");
      covered += area;
      for (let j = i + 1; j < entries.length; j++) {
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
  const edgeError = (a: Point, b: Point) => {
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
    for (const entry of entries) {
      take();
      if (!overlaps(box, entry.box)) continue;
      const surface = entry.surface,
        ox = surface.centerX,
        oz = surface.centerZ;
      const result = surface.visitTrianglesInBounds(
        {
          minX: box.minX - ox,
          maxX: box.maxX - ox,
          minZ: box.minZ - oz,
          maxZ: box.maxZ - oz,
        },
        (ax, ay, az, bx, by, bz, cx, cy, cz) => {
          take();
          receipt.triangleVisits++;
          const det = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
          const u0 =
            ((a.x - ox - ax) * (cz - az) - (a.z - oz - az) * (cx - ax)) / det;
          const v0 =
            ((bx - ax) * (a.z - oz - az) - (bz - az) * (a.x - ox - ax)) / det;
          const du = (dx * (cz - az) - dz * (cx - ax)) / det;
          const dv = ((bx - ax) * dz - (bz - az) * dx) / det;
          let lo = 0,
            hi = 1;
          for (const [start, change] of [
            [u0, du],
            [v0, dv],
            [1 - u0 - v0, -du - dv],
          ]) {
            if (Math.abs(change) < 1e-14) {
              if (start < -1e-10) return;
            } else if (change > 0) lo = Math.max(lo, -start / change);
            else hi = Math.min(hi, -start / change);
          }
          if (lo > hi + 1e-10 || hi < 0 || lo > 1) return;
          lo = Math.max(0, lo);
          hi = Math.min(1, hi);
          markSurface(surface, "edge");
          intervals.push([lo, hi]);
          for (const t of [lo, hi]) {
            const terrainY =
              ay + (u0 + du * t) * (by - ay) + (v0 + dv * t) * (cy - ay);
            maxError = Math.max(
              maxError,
              Math.abs(a.y + (b.y - a.y) * t - terrainY),
            );
          }
        },
        workBudget - receipt.workUnits,
      );
      if (result.exhausted) throw new DeferredGrounding("work_budget");
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let until = 0;
    for (const [lo, hi] of intervals) {
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
  const padOverlap = (box: TerrainGridBounds) => {
    for (const zone of snapshot.zones) {
      take();
      if (zone.excludeGrass === false) continue;
      if (zone.radialPond) {
        if (
          pointBoxDistance(zone.centerX, zone.centerZ, box) <
          zone.radialPond.bankOuterRadius + zone.blendRadius
        )
          return true;
      } else if (zone.tileMask) {
        for (const key of zone.tileMask) {
          take();
          const [x, z] = key.split(",").map(Number);
          if (overlaps(box, { minX: x, maxX: x + 1, minZ: z, maxZ: z + 1 }))
            return true;
        }
        if (zone.blendRadius > 0)
          for (const tile of zone.tileMaskTiles ?? []) {
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
  const deltas = new Float32Array(data.count * blades * 2),
    retained: number[] = [];
  try {
    for (let i = 0; i < data.count; i++) {
      const k = i * 3,
        x = ownSurface.centerX + data.offsets[k],
        y = data.offsets[k + 1],
        z = ownSurface.centerZ + data.offsets[k + 2];
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
      const rotation = data.rotScaleHash[k],
        scale = data.rotScaleHash[k + 1],
        cos = Math.cos(rotation),
        sin = Math.sin(rotation);
      const nx = data.groundNormals[k],
        ny = data.groundNormals[k + 1],
        nz = data.groundNormals[k + 2],
        q = 1 / (1 + ny),
        cross = -nx * nz * q;
      const transform = (v: number, fade: number): Point => {
        const rx = (position.getX(v) * cos - position.getZ(v) * sin) * scale,
          rz = (position.getX(v) * sin + position.getZ(v) * cos) * scale,
          ry = position.getY(v) * scale * fade;
        return {
          x: x + rx * (ny + nz * nz * q) + ry * nx + rz * cross,
          y: y - rx * nx + ry * ny - rz * nz,
          z: z + rx * cross + ry * nz + rz * (ny + nx * nx * q),
        };
      };
      let baseError = 0;
      for (let blade = 0; blade < blades; blade++) {
        const left = transform(blade * verticesPerBlade, 1),
          right = transform(blade * verticesPerBlade + 1, 1);
        const deltaLeft = Math.fround(sampleEndpoint(left) - left.y),
          deltaRight = Math.fround(sampleEndpoint(right) - right.y);
        if (![deltaLeft, deltaRight].every(Number.isFinite))
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
        baseError = Math.max(baseError, edgeError(left, right));
      }
      receipt.maxCorrectedBaseError = Math.max(
        receipt.maxCorrectedBaseError,
        baseError,
      );
      const box = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };
      let minY = Infinity;
      for (let v = 0; v < position.count; v++) {
        const blade = Math.floor(v / verticesPerBlade),
          d = (i * blades + blade) * 2;
        const correction =
          deltas[d] * (1 - uv.getX(v)) + deltas[d + 1] * uv.getX(v);
        const windFactor = uv.getY(v) ** 1.8;
        for (const fade of [0, 1]) {
          take();
          const point = transform(v, fade);
          box.minX = Math.min(
            box.minX,
            point.x - wind.x * windFactor - NUMERIC_GUARD,
          );
          box.maxX = Math.max(
            box.maxX,
            point.x + wind.x * windFactor + NUMERIC_GUARD,
          );
          box.minZ = Math.min(
            box.minZ,
            point.z - wind.z * windFactor - NUMERIC_GUARD,
          );
          box.maxZ = Math.max(
            box.maxZ,
            point.z + wind.z * windFactor + NUMERIC_GUARD,
          );
          minY = Math.min(minY, point.y + correction - NUMERIC_GUARD);
        }
      }
      if (
        ![box.minX, box.maxX, box.minZ, box.maxZ, minY].every(Number.isFinite)
      )
        throw new Error("Nonfinite corrected grass envelope");
      ensureCoverage(box);
      let rejection: RejectionReason | null =
        baseError > maximumBaseError ? "terrain_edge" : null;
      if (!rejection && padOverlap(box)) rejection = "pad";
      if (!rejection)
        for (const road of request.roadSegments) {
          take();
          if (segmentBoxDistance(road, box) <= road.width / 2 + roadFeather) {
            rejection = "road";
            break;
          }
        }
      if (!rejection) {
        let highest = -Infinity,
          coveredByBody = false;
        for (const body of snapshot.waterBodies) {
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
        retained.push(i);
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
  retained.forEach((source, dst) => {
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
  });
  receipt.retainedClumps = count;
  receipt.correctionBytes = rootDeltas.byteLength;
  return {
    status: "ready",
    data: output,
    rootDeltas,
    sourceIndices: Uint32Array.from(retained),
    dependencies: dependencies(),
    receipt: finish(),
  };
}
