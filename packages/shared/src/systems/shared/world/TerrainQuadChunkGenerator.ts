/**
 * TerrainQuadChunkGenerator — Assembles terrain geometry for quad-tree chunks
 * from pre-computed worker output.
 *
 * The heavy lifting (noise, heights, normals, biome blending) is done by
 * QuadChunkWorker on a background thread. This module handles:
 * - Road influence sampling (needs live road network)
 * - Flat-zone height overrides via getFlatZoneHeight (needs live building data)
 * - Skirt geometry generation
 * - Index buffer generation
 * - THREE.BufferGeometry assembly
 *
 * A synchronous data generator (generateQuadChunkDataSync) is also provided
 * as a fallback when workers are unavailable. It produces the same
 * QuadChunkWorkerOutput format and feeds it through assembleQuadChunkGeometry,
 * keeping all assembly logic in one place.
 *
 * CLIENT-ONLY: Server terrain uses the flat tile grid.
 */

import THREE from "../../../extras/three/three";
import type { QuadChunkWorkerOutput } from "../../../utils/workers/QuadChunkWorker";
import { BiomeType, DEFAULT_BIOME } from "./TerrainBiomeTypes";

/** Canonical rectangular floor core and its max-axis smooth blend collar. */
export type TerrainSurfaceRefinementZone = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  blendRadius: number;
}>;

/** Conservative envelope of a curved bank; heights remain provider-owned. */
export type TerrainSurfaceRefinementAnnulus = Readonly<{
  centerX: number;
  centerZ: number;
  innerRadius: number;
  outerRadius: number;
  /** Optional paired angular support for an explicitly authored outer shoulder. */
  bearing?: number;
  halfWidth?: number;
}>;

type LocalSurfaceRefinement =
  | (TerrainSurfaceRefinementZone & { kind: "collar" })
  | (TerrainSurfaceRefinementZone &
      TerrainSurfaceRefinementAnnulus & {
        kind: "annulus";
        broadAdaptive?: boolean;
        angularPlanes?: readonly [number, number, number, number];
      });

/** Tight support bounds, including cardinal extrema and both radial edges. */
function annularRefinementBounds(
  zone: TerrainSurfaceRefinementAnnulus,
): TerrainSurfaceRefinementZone {
  if (zone.bearing === undefined || zone.halfWidth === undefined)
    return {
      minX: zone.centerX - zone.outerRadius,
      maxX: zone.centerX + zone.outerRadius,
      minZ: zone.centerZ - zone.outerRadius,
      maxZ: zone.centerZ + zone.outerRadius,
      blendRadius: 0,
    };
  const angles = [zone.bearing - zone.halfWidth, zone.bearing + zone.halfWidth];
  for (const angle of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
    const difference = Math.abs(angle - zone.bearing);
    if (Math.min(difference, 2 * Math.PI - difference) <= zone.halfWidth)
      angles.push(angle);
  }
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const angle of angles)
    for (const radius of [zone.innerRadius, zone.outerRadius]) {
      const x = zone.centerX + radius * Math.cos(angle);
      const z = zone.centerZ + radius * Math.sin(angle);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  return { minX, maxX, minZ, maxZ, blendRadius: 0 };
}

/**
 * Main-thread callbacks for game-state queries that can't run in a worker.
 * Used by assembleQuadChunkGeometry for road influence and flat-zone overrides.
 */
export interface ChunkTerrainProvider {
  /** Cached identity of the explicitly selected world terrain profile. */
  readonly terrainProfileIdentity: string;
  /** Optional live owned features; omission retains the original regular mesh. */
  readonly surfaceRefinementZones?: readonly TerrainSurfaceRefinementZone[];
  readonly surfaceRefinementAnnuli?: readonly TerrainSurfaceRefinementAnnulus[];
  calculateRoadInfluenceAtVertex(
    worldX: number,
    worldZ: number,
    tileX: number,
    tileZ: number,
  ): number;
  /**
   * Returns the final terrain height at this position if a flat zone applies,
   * including smooth blend transitions. Returns null if no flat zone affects
   * this point. This delegates to TerrainSystem.getFlatZoneHeight() which
   * handles core/blend classification and smoothstep interpolation.
   */
  getFlatZoneHeight(worldX: number, worldZ: number): number | null;
  getHeightAtComputed(worldX: number, worldZ: number): number;
  readonly TILE_SIZE: number;
}

/**
 * Extended provider that includes sync fallback methods for the data generator.
 * Used by generateQuadChunkDataSync (main-thread fallback) and by the
 * TerrainVisualManager for worker dispatch.
 */
export interface FullTerrainProvider extends ChunkTerrainProvider {
  computeBiomeWeightsAtPosition(
    worldX: number,
    worldZ: number,
  ): { biomeWeightMap: Map<string, number>; totalWeight: number };
  computeBiomeWeightsByPosition(
    worldX: number,
    worldZ: number,
  ): Record<string, number>;
  getBiomeId(biomeName: string): number;
  getBiomeColor(biomeName: string): { r: number; g: number; b: number };
  readonly WATER_LEVEL_NORMALIZED: number;
  readonly SHORELINE_THRESHOLD: number;
  readonly SHORELINE_STRENGTH: number;
  readonly MAX_HEIGHT: number;
}

export interface ChunkGeometryResult {
  geometry: THREE.BufferGeometry;
  /** Final main-grid heights, including live flat zones, without skirt vertices. */
  heightData: Float32Array;
}

/**
 * Assemble a THREE.BufferGeometry from worker-computed height/normal/color/biome
 * data, adding flat-zone overrides, road influence, and skirts on the main thread.
 */
export function assembleQuadChunkGeometry(
  workerData: QuadChunkWorkerOutput,
  provider: ChunkTerrainProvider,
  skirtDrop: number,
): ChunkGeometryResult {
  return drainSteps(
    assembleQuadChunkGeometrySteps(workerData, provider, skirtDrop),
  );
}

function drainSteps<T>(steps: Generator<string, T, void>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Private preparation only: callers must keep provider inputs stable between
 * resumes. A cancelled/failed iterator never publishes partially built geometry.
 * Native typed-array allocations/copies and final bounding-volume calls remain
 * atomic; phase yields bound the surrounding JavaScript and provider work. */
export function* assembleQuadChunkGeometrySteps(
  workerData: QuadChunkWorkerOutput,
  provider: ChunkTerrainProvider,
  skirtDrop: number,
): Generator<string, ChunkGeometryResult, void> {
  // Reject cross-world or unversioned output before allocating any geometry.
  if (
    typeof provider.terrainProfileIdentity !== "string" ||
    provider.terrainProfileIdentity.length === 0 ||
    workerData.terrainProfileIdentity !== provider.terrainProfileIdentity
  ) {
    throw new Error("Quad chunk terrain profile identity mismatch");
  }
  const {
    centerX,
    centerZ,
    size,
    resolution,
    heightData,
    normalData,
    colorData,
    biomeData,
    biomeForestWeight,
    biomeCanyonWeight,
    riverProximity: riverProximityData,
  } = workerData;
  const segments = resolution;
  const halfSize = size * 0.5;
  const gridStep = size / (segments - 1);

  const skirtCount = segments * 4;
  const totalVertices = segments * segments + skirtCount;
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colors = new Float32Array(totalVertices * 3);
  const biomeIds = new Float32Array(totalVertices);
  const forestWeights = new Float32Array(totalVertices);
  const canyonWeights = new Float32Array(totalVertices);
  const roadInfluences = new Float32Array(totalVertices);
  const riverProximities = new Float32Array(totalVertices);
  yield "assembly_allocate_grid";

  let flatZoneModified = false;
  // Preserve the worker result: it can still be held by a caller/cache. Chunks
  // without live overrides keep the original allocation; modified chunks expose
  // the same Float32 heights as their rendered main-grid position attribute.
  let surfaceHeights = heightData;

  for (let iz = 0; iz < segments; iz++) {
    const localZ = -halfSize + iz * gridStep;
    const worldZ = centerZ + localZ;

    for (let ix = 0; ix < segments; ix++) {
      const localX = -halfSize + ix * gridStep;
      const worldX = centerX + localX;
      const idx = iz * segments + ix;
      const i3 = idx * 3;

      let height = heightData[idx];

      const flatHeight = provider.getFlatZoneHeight(worldX, worldZ);
      if (flatHeight !== null) {
        height = flatHeight;
        if (!flatZoneModified) surfaceHeights = heightData.slice();
        surfaceHeights[idx] = height;
        flatZoneModified = true;
      }

      positions[i3] = localX;
      positions[i3 + 1] = height;
      positions[i3 + 2] = localZ;

      normals[i3] = normalData[i3];
      normals[i3 + 1] = normalData[i3 + 1];
      normals[i3 + 2] = normalData[i3 + 2];

      colors[i3] = colorData[i3];
      colors[i3 + 1] = colorData[i3 + 1];
      colors[i3 + 2] = colorData[i3 + 2];

      biomeIds[idx] = biomeData[idx];
      forestWeights[idx] = biomeForestWeight[idx];
      canyonWeights[idx] = biomeCanyonWeight[idx];
      riverProximities[idx] = riverProximityData?.[idx] ?? 0;

      const roadTileX = Math.floor(worldX / provider.TILE_SIZE);
      const roadTileZ = Math.floor(worldZ / provider.TILE_SIZE);
      roadInfluences[idx] = provider.calculateRoadInfluenceAtVertex(
        worldX,
        worldZ,
        roadTileX,
        roadTileZ,
      );
      if ((ix + 1) % 32 === 0) yield "assembly_grid_vertices";
    }
    if (segments % 32 !== 0) yield "assembly_grid_vertices";
  }

  // A neighboring grade can change an edge normal without touching any vertex
  // inside this chunk. Check only the normal stencil's outer samples in that
  // case; ungraded chunks still avoid all computed-height queries.
  if (
    flatZoneModified ||
    (yield* hasGradingInNormalBorderSteps(
      segments,
      gridStep,
      centerX - halfSize,
      centerZ - halfSize,
      provider,
    ))
  ) {
    yield* recomputeNormalsSteps(
      positions,
      normals,
      segments,
      gridStep,
      centerX - halfSize,
      centerZ - halfSize,
      provider,
    );
  }

  // =========================================================================
  // Skirt geometry
  // =========================================================================
  let skirtIdx = segments * segments;

  const copyEdgeVertex = (mainIdx: number) => {
    const si3 = skirtIdx * 3;
    const mi3 = mainIdx * 3;
    positions[si3] = positions[mi3];
    positions[si3 + 1] = positions[mi3 + 1] - skirtDrop;
    positions[si3 + 2] = positions[mi3 + 2];
    normals[si3] = normals[mi3];
    normals[si3 + 1] = normals[mi3 + 1];
    normals[si3 + 2] = normals[mi3 + 2];
    colors[si3] = colors[mi3];
    colors[si3 + 1] = colors[mi3 + 1];
    colors[si3 + 2] = colors[mi3 + 2];
    biomeIds[skirtIdx] = biomeIds[mainIdx];
    forestWeights[skirtIdx] = forestWeights[mainIdx];
    canyonWeights[skirtIdx] = canyonWeights[mainIdx];
    roadInfluences[skirtIdx] = roadInfluences[mainIdx];
    riverProximities[skirtIdx] = riverProximities[mainIdx];
    skirtIdx++;
  };

  for (let ix = 0; ix < segments; ix++) {
    copyEdgeVertex(ix);
    if ((ix + 1) % 128 === 0) yield "assembly_grid_skirts";
  }
  yield "assembly_grid_skirts";
  for (let ix = 0; ix < segments; ix++) {
    copyEdgeVertex((segments - 1) * segments + ix);
    if ((ix + 1) % 128 === 0) yield "assembly_grid_skirts";
  }
  yield "assembly_grid_skirts";
  for (let iz = 0; iz < segments; iz++) {
    copyEdgeVertex(iz * segments);
    if ((iz + 1) % 128 === 0) yield "assembly_grid_skirts";
  }
  yield "assembly_grid_skirts";
  for (let iz = 0; iz < segments; iz++) {
    copyEdgeVertex(iz * segments + (segments - 1));
    if ((iz + 1) % 128 === 0) yield "assembly_grid_skirts";
  }
  yield "assembly_grid_skirts";

  // =========================================================================
  // Indices
  // =========================================================================
  const subs = segments - 1;
  const mainFaceCount = subs * subs;
  const skirtFaceCount = subs * 4;
  const totalIndices = (mainFaceCount + skirtFaceCount) * 6;
  const indices = new Uint32Array(totalIndices);
  yield "assembly_allocate_indices";
  let ii = 0;

  for (let iz = 0; iz < subs; iz++) {
    for (let ix = 0; ix < subs; ix++) {
      const a = iz * segments + ix;
      const b = a + 1;
      const c = a + segments;
      const d = c + 1;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
    yield "assembly_grid_indices";
  }

  const skirtBase = segments * segments;
  const northSkirtBase = skirtBase;
  const southSkirtBase = skirtBase + segments;
  const westSkirtBase = skirtBase + segments * 2;
  const eastSkirtBase = skirtBase + segments * 3;

  for (let ix = 0; ix < subs; ix++) {
    const mainA = ix;
    const mainB = ix + 1;
    const skirtA = northSkirtBase + ix;
    const skirtB = northSkirtBase + ix + 1;
    indices[ii++] = skirtA;
    indices[ii++] = mainA;
    indices[ii++] = skirtB;
    indices[ii++] = skirtB;
    indices[ii++] = mainA;
    indices[ii++] = mainB;
    if ((ix + 1) % 128 === 0) yield "assembly_skirt_indices";
  }
  yield "assembly_skirt_indices";

  for (let ix = 0; ix < subs; ix++) {
    const mainA = (segments - 1) * segments + ix;
    const mainB = mainA + 1;
    const skirtA = southSkirtBase + ix;
    const skirtB = southSkirtBase + ix + 1;
    indices[ii++] = mainA;
    indices[ii++] = skirtA;
    indices[ii++] = mainB;
    indices[ii++] = mainB;
    indices[ii++] = skirtA;
    indices[ii++] = skirtB;
    if ((ix + 1) % 128 === 0) yield "assembly_skirt_indices";
  }
  yield "assembly_skirt_indices";

  for (let iz = 0; iz < subs; iz++) {
    const mainA = iz * segments;
    const mainB = (iz + 1) * segments;
    const skirtA = westSkirtBase + iz;
    const skirtB = westSkirtBase + iz + 1;
    indices[ii++] = mainA;
    indices[ii++] = skirtA;
    indices[ii++] = mainB;
    indices[ii++] = mainB;
    indices[ii++] = skirtA;
    indices[ii++] = skirtB;
    if ((iz + 1) % 128 === 0) yield "assembly_skirt_indices";
  }
  yield "assembly_skirt_indices";

  for (let iz = 0; iz < subs; iz++) {
    const mainA = iz * segments + (segments - 1);
    const mainB = (iz + 1) * segments + (segments - 1);
    const skirtA = eastSkirtBase + iz;
    const skirtB = eastSkirtBase + iz + 1;
    indices[ii++] = skirtA;
    indices[ii++] = mainA;
    indices[ii++] = skirtB;
    indices[ii++] = skirtB;
    indices[ii++] = mainA;
    indices[ii++] = mainB;
    if ((iz + 1) % 128 === 0) yield "assembly_skirt_indices";
  }
  yield "assembly_skirt_indices";

  // =========================================================================
  // Build BufferGeometry
  // =========================================================================
  const geometry = new THREE.BufferGeometry();
  let returned = false;
  try {
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("biomeId", new THREE.BufferAttribute(biomeIds, 1));
    geometry.setAttribute(
      "biomeForestWeight",
      new THREE.BufferAttribute(forestWeights, 1),
    );
    geometry.setAttribute(
      "biomeCanyonWeight",
      new THREE.BufferAttribute(canyonWeights, 1),
    );
    geometry.setAttribute(
      "roadInfluence",
      new THREE.BufferAttribute(roadInfluences, 1),
    );
    geometry.setAttribute(
      "riverProximity",
      new THREE.BufferAttribute(riverProximities, 1),
    );
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    yield "assembly_geometry_attributes";
    const refinementZones = provider.surfaceRefinementZones;
    const refinementAnnuli = provider.surfaceRefinementAnnuli;
    if (refinementZones?.length || refinementAnnuli?.length) {
      yield* refineSurfaceFeaturesSteps(
        geometry,
        segments,
        centerX,
        centerZ,
        size,
        skirtDrop,
        refinementZones ?? [],
        refinementAnnuli ?? [],
        provider,
      );
      yield* refineCollarBoundaryNormalsSteps(
        geometry,
        segments,
        centerX,
        centerZ,
        size,
        [
          ...(refinementZones ?? []),
          ...(refinementAnnuli ?? []).map(annularRefinementBounds),
        ],
        provider,
      );
    }
    geometry.computeBoundingBox();
    yield "assembly_bounding_box";
    geometry.computeBoundingSphere();
    yield "assembly_bounding_sphere";

    returned = true;
    return { geometry, heightData: surfaceHeights };
  } finally {
    if (!returned) geometry.dispose();
  }
}

/** Safety ceilings, not an accepted scene/performance budget. */
const COLLAR_STEP = 0.125;
// Historical curved banks use one bounded extra level where canonical error
// warrants it. Oversized annuli use the bounded hierarchy below, keeping this
// same finest level. This is not a frame budget; pond leaves retain resolution128.
const ANNULAR_STEP = 0.125;
const ANNULAR_FINE_STEP = 0.0625;
// Only explicit angular outer shoulders use this coarser bounded lattice.
// Historical full-ring refinement and all acceptance thresholds stay fixed.
const SHOULDER_STEP = 0.25;
const SHOULDER_FINE_STEP = 0.125;
const BROAD_BANK_STEP = 0.5;
const BROAD_BANK_STEPS = [
  SHOULDER_STEP,
  ANNULAR_STEP,
  ANNULAR_FINE_STEP,
] as const;
const BROAD_SHOULDER_STEPS = [SHOULDER_STEP, SHOULDER_FINE_STEP] as const;
const BANK_STEPS = [ANNULAR_FINE_STEP] as const;
const SHOULDER_STEPS = [SHOULDER_FINE_STEP] as const;
const MAX_REFINEMENT_ZONES = 16;
const MAX_EXTRA_SURFACE_VERTICES = 65536;
const MAX_SURFACE_VERTICES = 131072;
const MAX_CELL_FACES = 512;
const MAX_MAIN_FACES = 1000000;

/** A feature can affect a shared-edge normal without intersecting this chunk's
 * interior. Both neighbours use this same small canonical stencil on the halo;
 * no new geometry is created in the outside chunk. Skirt copies share it too. */
function* refineCollarBoundaryNormalsSteps(
  geometry: THREE.BufferGeometry,
  resolution: number,
  centerX: number,
  centerZ: number,
  size: number,
  zones: readonly TerrainSurfaceRefinementZone[],
  provider: ChunkTerrainProvider,
): Generator<string, void, void> {
  const p = geometry.getAttribute("position"),
    n = geometry.getAttribute("normal");
  const minX = p.getX(0),
    maxX = p.getX(resolution - 1);
  const minZ = p.getZ(0),
    maxZ = p.getZ(resolution * (resolution - 1));
  const halo = (2 * size) / (resolution - 1);
  const nearby = zones.filter(
    (zone) =>
      zone.maxX + zone.blendRadius + halo >= centerX + minX &&
      zone.minX - zone.blendRadius - halo <= centerX + maxX &&
      zone.maxZ + zone.blendRadius + halo >= centerZ + minZ &&
      zone.minZ - zone.blendRadius - halo <= centerZ + maxZ,
  );
  if (nearby.length === 0) return;
  const cache = new Map<string, readonly [number, number, number]>();
  const step = COLLAR_STEP / 4;
  const apply = (id: number) => {
    const x = centerX + p.getX(id),
      z = centerZ + p.getZ(id);
    if (
      !nearby.some(
        (zone) =>
          x >= zone.minX - zone.blendRadius - halo &&
          x <= zone.maxX + zone.blendRadius + halo &&
          z >= zone.minZ - zone.blendRadius - halo &&
          z <= zone.maxZ + zone.blendRadius + halo,
      )
    )
      return;
    const key = `${p.getX(id)},${p.getZ(id)}`;
    let normal = cache.get(key);
    if (!normal) {
      const nx =
        -(
          provider.getHeightAtComputed(x + step, z) -
          provider.getHeightAtComputed(x - step, z)
        ) /
        (2 * step);
      const nz =
        -(
          provider.getHeightAtComputed(x, z + step) -
          provider.getHeightAtComputed(x, z - step)
        ) /
        (2 * step);
      const length = Math.hypot(nx, 1, nz);
      if (!Number.isFinite(length))
        throw new Error("Non-finite terrain collar boundary normal");
      normal = [nx / length, 1 / length, nz / length];
      cache.set(key, normal);
    }
    n.setXYZ(id, normal[0], normal[1], normal[2]);
  };
  for (let i = 0; i < resolution; i++) {
    apply(i);
    apply((resolution - 1) * resolution + i);
    apply(i * resolution);
    apply(i * resolution + resolution - 1);
    if ((i + 1) % 8 === 0) yield "collar_boundary_normals";
  }
  yield "collar_boundary_normals";
  for (let id = resolution * resolution; id < p.count; id++) {
    if (
      p.getX(id) === minX ||
      p.getX(id) === maxX ||
      p.getZ(id) === minZ ||
      p.getZ(id) === maxZ
    )
      apply(id);
    if ((id + 1) % 32 === 0) yield "collar_boundary_normals";
  }
  yield "collar_boundary_normals";
}

/**
 * Insert finite feature-aligned partitions without moving the original grid.
 * The square collar's diagonal max-axis crease is explicit, rather than sampled
 * across by a coarse triangle. Curved banks receive a world-anchored lattice in
 * both axes only in cells intersecting their conservative annulus. Every axis
 * edge is split at all shared vertices,
 * including neighbouring unrefined cells. Skirts follow the final outer edges.
 */
function* refineSurfaceFeaturesSteps(
  geometry: THREE.BufferGeometry,
  resolution: number,
  centerX: number,
  centerZ: number,
  size: number,
  skirtDrop: number,
  input: readonly TerrainSurfaceRefinementZone[],
  annuli: readonly TerrainSurfaceRefinementAnnulus[],
  provider: ChunkTerrainProvider,
): Generator<string, void, void> {
  if (input.length + annuli.length > MAX_REFINEMENT_ZONES)
    throw new Error("Terrain collar refinement feature limit exceeded");
  const half = size / 2;
  const boundaryHalo = size / (resolution - 1);
  const zones: LocalSurfaceRefinement[] = [];
  for (const zone of input) {
    if (
      ![zone.minX, zone.maxX, zone.minZ, zone.maxZ, zone.blendRadius].every(
        Number.isFinite,
      ) ||
      zone.minX >= zone.maxX ||
      zone.minZ >= zone.maxZ ||
      zone.blendRadius < COLLAR_STEP ||
      zone.blendRadius > 4
    )
      throw new Error("Invalid terrain collar refinement feature");
    if (
      zone.maxX + zone.blendRadius <= centerX - half ||
      zone.minX - zone.blendRadius >= centerX + half ||
      zone.maxZ + zone.blendRadius <= centerZ - half ||
      zone.minZ - zone.blendRadius >= centerZ + half
    )
      continue;
    zones.push({
      kind: "collar",
      minX: Math.fround(zone.minX - centerX),
      maxX: Math.fround(zone.maxX - centerX),
      minZ: Math.fround(zone.minZ - centerZ),
      maxZ: Math.fround(zone.maxZ - centerZ),
      blendRadius: zone.blendRadius,
    });
  }
  for (const zone of annuli) {
    if (
      ![zone.centerX, zone.centerZ, zone.innerRadius, zone.outerRadius].every(
        Number.isFinite,
      ) ||
      zone.innerRadius < 0 ||
      zone.outerRadius <= zone.innerRadius ||
      zone.outerRadius > 64
    )
      throw new Error("Invalid terrain annular refinement feature");
    const bearing = Object.getOwnPropertyDescriptor(zone, "bearing");
    const halfWidth = Object.getOwnPropertyDescriptor(zone, "halfWidth");
    if (
      ("bearing" in zone || "halfWidth" in zone) &&
      (!bearing ||
        !halfWidth ||
        !bearing.enumerable ||
        !halfWidth.enumerable ||
        !("value" in bearing) ||
        !("value" in halfWidth) ||
        typeof bearing.value !== "number" ||
        typeof halfWidth.value !== "number" ||
        !Number.isFinite(bearing.value) ||
        !Number.isFinite(halfWidth.value) ||
        bearing.value < -Math.PI ||
        bearing.value > Math.PI ||
        halfWidth.value <= 0 ||
        halfWidth.value > Math.PI / 2)
    )
      throw new Error("Invalid terrain angular shoulder refinement feature");
    const bounds = annularRefinementBounds(zone);
    if (
      bounds.maxX + boundaryHalo <= centerX - half ||
      bounds.minX - boundaryHalo >= centerX + half ||
      bounds.maxZ + boundaryHalo <= centerZ - half ||
      bounds.minZ - boundaryHalo >= centerZ + half
    )
      continue;
    const x = zone.centerX - centerX,
      z = zone.centerZ - centerZ;
    zones.push({
      kind: "annulus",
      // A broad smooth basin must not spend the entire extra-vertex allowance
      // on an unconditional fine lattice before checking geometric error.
      // This decision depends on the authored feature, not the current leaf,
      // so adjacent chunks select identical shared-boundary detail.
      broadAdaptive: annuli.some(
        (ring) =>
          ring.bearing === undefined &&
          ring.centerX === zone.centerX &&
          ring.centerZ === zone.centerZ &&
          (ring === zone || ring.outerRadius === zone.innerRadius) &&
          (Math.PI * (ring.outerRadius ** 2 - ring.innerRadius ** 2)) /
            ANNULAR_STEP ** 2 >
            MAX_EXTRA_SURFACE_VERTICES,
      ),
      centerX: x,
      centerZ: z,
      innerRadius: zone.innerRadius,
      outerRadius: zone.outerRadius,
      ...(zone.bearing === undefined
        ? {}
        : {
            bearing: zone.bearing,
            halfWidth: zone.halfWidth,
            angularPlanes: [
              -Math.sin(zone.bearing - zone.halfWidth!),
              Math.cos(zone.bearing - zone.halfWidth!),
              Math.sin(zone.bearing + zone.halfWidth!),
              -Math.cos(zone.bearing + zone.halfWidth!),
            ] as const,
          }),
      minX:
        zone.bearing === undefined
          ? x - zone.outerRadius
          : bounds.minX - centerX,
      maxX:
        zone.bearing === undefined
          ? x + zone.outerRadius
          : bounds.maxX - centerX,
      minZ:
        zone.bearing === undefined
          ? z - zone.outerRadius
          : bounds.minZ - centerZ,
      maxZ:
        zone.bearing === undefined
          ? z + zone.outerRadius
          : bounds.maxZ - centerZ,
      blendRadius: 0,
    });
  }
  if (zones.length === 0) return;
  const original = geometry.getAttribute("position");
  const baseCount = resolution * resolution,
    cellsPerAxis = resolution - 1;
  const p: number[] = [];
  for (let i = 0; i < baseCount * 3; i++) {
    p.push(original.array[i]);
    if ((i + 1) % 384 === 0) yield "collar_copy_grid";
  }
  yield "collar_copy_grid";
  const vertexIds = new Map<string, number>();
  for (let i = 0; i < baseCount; i++) {
    vertexIds.set(`${p[i * 3]},${p[i * 3 + 2]}`, i);
    if ((i + 1) % 128 === 0) yield "collar_vertex_index";
  }
  yield "collar_vertex_index";
  const vertex = (x: number, z: number): number => {
    x = Math.fround(x);
    z = Math.fround(z);
    const key = `${x},${z}`,
      existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const id = p.length / 3;
    if (
      id >= MAX_SURFACE_VERTICES ||
      id - baseCount >= MAX_EXTRA_SURFACE_VERTICES
    )
      throw new Error(
        `Terrain collar refinement vertex limit exceeded at ${centerX + x},${centerZ + z} (${id - baseCount} extra vertices)`,
      );
    const height = Math.fround(
      provider.getHeightAtComputed(centerX + x, centerZ + z),
    );
    if (!Number.isFinite(height))
      throw new Error("Non-finite terrain collar height");
    p.push(x, height, z);
    vertexIds.set(key, id);
    return id;
  };
  const intersectsCollar = (
    zone: LocalSurfaceRefinement,
    x0: number,
    x1: number,
    z0: number,
    z1: number,
  ) => {
    if (zone.kind === "annulus") {
      // Nearest/farthest rectangle distances include crossings with no corner
      // inside the ring. Corner-only classification can leave coarse holes.
      const dx = Math.max(x0 - zone.centerX, 0, zone.centerX - x1);
      const dz = Math.max(z0 - zone.centerZ, 0, zone.centerZ - z1);
      const farX = Math.max(
        Math.abs(x0 - zone.centerX),
        Math.abs(x1 - zone.centerX),
      );
      const farZ = Math.max(
        Math.abs(z0 - zone.centerZ),
        Math.abs(z1 - zone.centerZ),
      );
      const radialIntersection =
        dx * dx + dz * dz <= zone.outerRadius * zone.outerRadius &&
        farX * farX + farZ * farZ >= zone.innerRadius * zone.innerRadius;
      if (!radialIntersection || zone.bearing === undefined)
        return radialIntersection;
      // A wedge at most PI wide is the intersection of two halfplanes. Reject
      // only if the entire cell lies outside either one; testing corner angles
      // alone misses thin sectors that cross a cell without containing a corner.
      const planes = zone.angularPlanes!;
      for (let plane = 0; plane < 4; plane += 2) {
        const nx = planes[plane],
          nz = planes[plane + 1];
        const maximum =
          nx * ((nx >= 0 ? x1 : x0) - zone.centerX) +
          nz * ((nz >= 0 ? z1 : z0) - zone.centerZ);
        if (maximum < -1e-9 * Math.max(1, zone.outerRadius)) return false;
      }
      return true;
    }
    return (
      x1 > zone.minX - zone.blendRadius &&
      x0 < zone.maxX + zone.blendRadius &&
      z1 > zone.minZ - zone.blendRadius &&
      z0 < zone.maxZ + zone.blendRadius &&
      !(
        x0 >= zone.minX &&
        x1 <= zone.maxX &&
        z0 >= zone.minZ &&
        z1 <= zone.maxZ
      )
    );
  };
  const cuts = (
    lo: number,
    hi: number,
    active: readonly LocalSurfaceRefinement[],
    axis: "X" | "Z",
  ) => {
    const values = new Set([lo, hi]);
    for (const zone of active) {
      if (zone.kind === "annulus") {
        const origin = axis === "X" ? centerX : centerZ;
        const step = zone.broadAdaptive
          ? BROAD_BANK_STEP
          : zone.bearing === undefined
            ? ANNULAR_STEP
            : SHOULDER_STEP;
        const start = Math.floor((origin + lo) / step) + 1;
        const end = Math.ceil((origin + hi) / step);
        // Reject coarse partitions before iterating or allocating their cuts.
        if (end - start > MAX_CELL_FACES)
          throw new Error("Terrain annular refinement axis limit exceeded");
        for (let k = start; k < end; k++) {
          const value = Math.fround(k * step - origin);
          if (value > lo && value < hi) values.add(value);
        }
        continue;
      }
      const n = Math.ceil(zone.blendRadius / COLLAR_STEP);
      const a = axis === "X" ? zone.minX : zone.minZ;
      const b = axis === "X" ? zone.maxX : zone.maxZ;
      for (let k = 0; k <= n; k++)
        for (const point of [
          a - (zone.blendRadius * k) / n,
          b + (zone.blendRadius * k) / n,
        ]) {
          const value = Math.fround(point);
          if (value > lo && value < hi) values.add(value);
        }
    }
    return [...values].sort((a, b) => a - b);
  };
  const refineBankPatch = (
    polygon: number[],
    steps: readonly number[],
    stepIndex = 0,
  ): number[][] => {
    const fineStep = steps[stepIndex],
      hasNext = stepIndex + 1 < steps.length;
    const [a, b, c, d] = polygon;
    const left = p[a * 3],
      right = p[c * 3];
    const top = p[a * 3 + 2],
      bottom = p[c * 3 + 2];
    const width = right - left,
      depth = bottom - top;
    const middleX = (left + right) / 2,
      middleZ = (top + bottom) / 2;
    // Do not emit decision probes: unused vertices would invalidate topology.
    const canonical = (x: number, z: number) => {
      const height = provider.getHeightAtComputed(centerX + x, centerZ + z);
      if (!Number.isFinite(height))
        throw new Error("Non-finite terrain bank probe");
      return height;
    };
    const north = canonical(middleX, top),
      south = canonical(middleX, bottom);
    const west = canonical(left, middleZ),
      east = canonical(right, middleZ);
    const middle = canonical(middleX, middleZ);
    const ha = p[a * 3 + 1],
      hb = p[b * 3 + 1];
    const hc = p[c * 3 + 1],
      hd = p[d * 3 + 1];
    const error = Math.max(
      Math.abs(north - (ha + hd) / 2),
      Math.abs(south - (hb + hc) / 2),
      Math.abs(west - (ha + hb) / 2),
      Math.abs(east - (hd + hc) / 2),
      Math.abs(middle - (ha + hc) / 2),
    );
    const gx = (east - west) / width,
      gz = (south - north) / depth;
    const canonicalLength = Math.hypot(gx, 1, gz);
    const normalAgreement = (dx: number, dz: number) =>
      (gx * dx + 1 + gz * dz) / (canonicalLength * Math.hypot(dx, 1, dz));
    // Horizontalized error catches the nearly flat upper contour. The vertical
    // and angular guards also protect steeper bank surfaces. These finite
    // probes select detail; retained/contact tests still establish acceptance.
    const boundary =
      left === -half || right === half || top === -half || bottom === half;
    const refine =
      boundary ||
      error > 0.002 ||
      error > Math.max(0.00001, Math.hypot(gx, gz) * 0.01) ||
      Math.min(
        normalAgreement((hc - hb) / width, (hb - ha) / depth),
        normalAgreement((hd - ha) / width, (hc - hd) / depth),
      ) < Math.cos(Math.PI / 30);
    if (!refine) return [polygon];
    const axis = (lo: number, hi: number, origin: number) => {
      const values = [lo];
      for (
        let k = Math.floor((origin + lo) / fineStep) + 1;
        k < Math.ceil((origin + hi) / fineStep);
        k++
      ) {
        const value = Math.fround(k * fineStep - origin);
        if (value > lo && value < hi) values.push(value);
      }
      values.push(hi);
      return values;
    };
    const xs = axis(left, right, centerX),
      zs = axis(top, bottom, centerZ);
    const parts: number[][] = [];
    for (let z = 0; z < zs.length - 1; z++)
      for (let x = 0; x < xs.length - 1; x++) {
        const part = [
          vertex(xs[x], zs[z]),
          vertex(xs[x], zs[z + 1]),
          vertex(xs[x + 1], zs[z + 1]),
          vertex(xs[x + 1], zs[z]),
        ];
        // Broad banks receive the same error decision again at the original
        // .125 m scale, with the same .0625 m finest detail and forced seams.
        parts.push(
          ...(!hasNext ? [part] : refineBankPatch(part, steps, stepIndex + 1)),
        );
      }
    return parts;
  };
  const clip = (
    polygon: number[],
    nx: number,
    nz: number,
    offset: number,
    side: number,
  ): number[] => {
    const output: number[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const da = (p[a * 3] * nx + p[a * 3 + 2] * nz - offset) * side;
      const db = (p[b * 3] * nx + p[b * 3 + 2] * nz - offset) * side;
      if (da >= 0) output.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        output.push(
          vertex(
            p[a * 3] + (p[b * 3] - p[a * 3]) * t,
            p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * t,
          ),
        );
      }
    }
    return output.filter(
      (id, i) => id !== output[(i + output.length - 1) % output.length],
    );
  };
  const locate = (value: number, stride: number, component: number) => {
    let lo = 0,
      hi = resolution - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (p[mid * stride + component] <= value) lo = mid;
      else hi = mid;
    }
    return Math.min(lo, resolution - 2);
  };
  const canMirrorAnnularCell = (
    zone: Extract<LocalSurfaceRefinement, { kind: "annulus" }>,
    x0: number,
    x1: number,
    z0: number,
    z1: number,
  ) => {
    const step = zone.broadAdaptive
      ? BROAD_BANK_STEP
      : zone.bearing === undefined
        ? ANNULAR_STEP
        : SHOULDER_STEP;
    const partitions = (lo: number, hi: number, origin: number) =>
      Math.ceil((origin + hi) / step) - Math.floor((origin + lo) / step);
    // Mirror only a neighbouring partition that can pass the SAME coarse
    // lattice preflight below. An unsupported coarse neighbour cannot publish
    // shared-edge subdivisions; projecting its entire cell across the edge
    // would manufacture remote refinement, sometimes hundreds of metres from
    // the feature. Direct intersections still fail closed under every existing
    // cap. This does not substitute lower-detail geometry for an admitted bank.
    return (
      partitions(x0, x1, centerX) * partitions(z0, z1, centerZ) * 2 <=
      MAX_CELL_FACES
    );
  };
  const activeCells = new Map<number, LocalSurfaceRefinement[]>();
  for (const zone of zones) {
    const ix0 = locate(zone.minX - zone.blendRadius, 3, 0);
    const ix1 = locate(zone.maxX + zone.blendRadius, 3, 0);
    const iz0 = locate(zone.minZ - zone.blendRadius, resolution * 3, 2);
    const iz1 = locate(zone.maxZ + zone.blendRadius, resolution * 3, 2);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const a = iz * resolution + ix;
        const x0 = p[a * 3],
          x1 = p[(a + 1) * 3];
        const z0 = p[a * 3 + 2],
          z1 = p[(a + resolution) * 3 + 2];
        // Both neighbours own a shared edge's subdivisions even when just one
        // incident cell intersects the ring. The one-cell mirrored halo also
        // handles features lying wholly across a chunk boundary. Interior
        // cells retain the exact annulus classification.
        const directIntersection = intersectsCollar(zone, x0, x1, z0, z1);
        const mirrorIntersects =
          !directIntersection &&
          zone.kind === "annulus" &&
          ((ix === 0 &&
            canMirrorAnnularCell(zone, x0 - (x1 - x0), x0, z0, z1) &&
            intersectsCollar(zone, x0 - (x1 - x0), x0, z0, z1)) ||
            (ix === cellsPerAxis - 1 &&
              canMirrorAnnularCell(zone, x1, x1 + (x1 - x0), z0, z1) &&
              intersectsCollar(zone, x1, x1 + (x1 - x0), z0, z1)) ||
            (iz === 0 &&
              canMirrorAnnularCell(zone, x0, x1, z0 - (z1 - z0), z0) &&
              intersectsCollar(zone, x0, x1, z0 - (z1 - z0), z0)) ||
            (iz === cellsPerAxis - 1 &&
              canMirrorAnnularCell(zone, x0, x1, z1, z1 + (z1 - z0)) &&
              intersectsCollar(zone, x0, x1, z1, z1 + (z1 - z0))));
        if (!directIntersection && !mirrorIntersects) continue;
        const cell = iz * cellsPerAxis + ix;
        if (!activeCells.has(cell)) activeCells.set(cell, []);
        activeCells.get(cell)!.push(zone);
      }
      yield "collar_active_cells";
    }
  }
  const plans = new Map<number, number[][]>();
  const orderedCells = [...activeCells.keys()].sort((a, b) => a - b);
  yield "collar_order_cells";
  for (const cell of orderedCells) {
    const iz = Math.floor(cell / cellsPerAxis),
      ix = cell % cellsPerAxis;
    const a = iz * resolution + ix;
    const x0 = p[a * 3],
      x1 = p[(a + 1) * 3];
    const z0 = p[a * 3 + 2],
      z1 = p[(a + resolution) * 3 + 2];
    const active = activeCells.get(cell)!;
    const xs = cuts(x0, x1, active, "X"),
      zs = cuts(z0, z1, active, "Z");
    // This preflight bound precedes potentially large polygon allocation.
    if ((xs.length - 1) * (zs.length - 1) * 2 > MAX_CELL_FACES)
      throw new Error(
        "Terrain collar refinement cell partition limit exceeded",
      );
    const polygons: number[][] = [];
    let plannedFaceCount = 0;
    for (let j = 0; j < zs.length - 1; j++)
      for (let i = 0; i < xs.length - 1; i++) {
        const left = xs[i],
          right = xs[i + 1],
          top = zs[j],
          bottom = zs[j + 1];
        let parts = [
          [
            vertex(left, top),
            vertex(left, bottom),
            vertex(right, bottom),
            vertex(right, top),
          ],
        ];
        if (active.some((zone) => zone.kind === "annulus")) {
          const fullRings = active.filter(
            (zone) => zone.kind === "annulus" && zone.bearing === undefined,
          );
          const broadAdaptive =
            fullRings.length > 0 &&
            fullRings.every(
              (zone) => zone.kind === "annulus" && zone.broadAdaptive,
            );
          const broadShoulder =
            fullRings.length === 0 &&
            active
              .filter((zone) => zone.kind === "annulus")
              .every((zone) => zone.kind === "annulus" && zone.broadAdaptive);
          parts = refineBankPatch(
            parts[0],
            broadAdaptive
              ? BROAD_BANK_STEPS
              : broadShoulder
                ? BROAD_SHOULDER_STEPS
                : fullRings.length > 0
                  ? BANK_STEPS
                  : SHOULDER_STEPS,
          );
        }
        for (const zone of active) {
          if (zone.kind === "annulus") continue;
          const west = right <= zone.minX,
            east = left >= zone.maxX;
          const north = bottom <= zone.minZ,
            south = top >= zone.maxZ;
          if (!(west || east) || !(north || south)) continue;
          const nx = west ? -1 : 1,
            nz = north ? 1 : -1;
          const offset =
            nx * (west ? zone.minX : zone.maxX) +
            nz * (north ? zone.minZ : zone.maxZ);
          parts = parts.flatMap((part) => {
            let positive = false,
              negative = false;
            for (const id of part) {
              const d = nx * p[id * 3] + nz * p[id * 3 + 2] - offset;
              if (d > 0) positive = true;
              if (d < 0) negative = true;
            }
            return positive && negative
              ? [clip(part, nx, nz, offset, 1), clip(part, nx, nz, offset, -1)]
              : [part];
          });
        }
        for (const part of parts) {
          if (part.length < 3) continue;
          plannedFaceCount += part.length - 2;
          if (plannedFaceCount > MAX_CELL_FACES)
            throw new Error(
              "Terrain bank refinement cell partition limit exceeded",
            );
          polygons.push(part);
        }
        yield "collar_partition";
      }
    plans.set(iz * cellsPerAxis + ix, polygons);
    yield "collar_cell_plan";
  }
  if (plans.size === 0) return;

  // A base-grid line can lie millimetres from the world-anchored bank lattice.
  // Unequal subdivisions of the two long edges of such a strip must not be
  // joined through a centre fan: longitudinal curvature then becomes a false
  // transverse slope. Match the already-required opposite-edge cuts instead.
  // Only broad adaptive banks need this extra closure; historical plans retain
  // their exact bytes. All added vertices still sample the canonical owner.
  if (zones.some((zone) => zone.kind === "annulus" && zone.broadAdaptive)) {
    const atX = new Map<number, Set<number>>(),
      atZ = new Map<number, Set<number>>();
    const retain = (x: number, z: number) => {
      if (!atX.has(x)) atX.set(x, new Set());
      if (!atZ.has(z)) atZ.set(z, new Set());
      atX.get(x)!.add(z);
      atZ.get(z)!.add(x);
    };
    for (let id = 0; id < p.length / 3; id++) retain(p[id * 3], p[id * 3 + 2]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const cell of orderedCells) {
        if (
          !activeCells
            .get(cell)!
            .some((zone) => zone.kind === "annulus" && zone.broadAdaptive)
        )
          continue;
        const balanced: number[][] = [];
        for (const polygon of plans.get(cell)!) {
          if (polygon.length !== 4) {
            balanced.push(polygon);
            continue;
          }
          const [a, b, c, d] = polygon;
          const left = p[a * 3],
            right = p[c * 3],
            top = p[a * 3 + 2],
            bottom = p[c * 3 + 2];
          const width = right - left,
            depth = bottom - top;
          if (
            p[b * 3] !== left ||
            p[b * 3 + 2] !== bottom ||
            p[d * 3] !== right ||
            p[d * 3 + 2] !== top ||
            Math.max(width, depth) <= 4 * Math.min(width, depth)
          ) {
            balanced.push(polygon);
            continue;
          }
          const vertical = depth > width,
            lo = vertical ? top : left,
            hi = vertical ? bottom : right;
          const map = vertical ? atX : atZ;
          const lower = vertical ? left : top,
            upper = vertical ? right : bottom;
          const cuts = [
            ...new Set([lo, hi, ...map.get(lower)!, ...map.get(upper)!]),
          ]
            .filter((value) => value >= lo && value <= hi)
            .sort((a, b) => a - b);
          if (cuts.length === 2) {
            balanced.push(polygon);
            continue;
          }
          for (let i = 0; i < cuts.length - 1; i++) {
            const x0 = vertical ? left : cuts[i],
              x1 = vertical ? right : cuts[i + 1];
            const z0 = vertical ? cuts[i] : top,
              z1 = vertical ? cuts[i + 1] : bottom;
            balanced.push([
              vertex(x0, z0),
              vertex(x0, z1),
              vertex(x1, z1),
              vertex(x1, z0),
            ]);
            retain(x0, z0);
            retain(x0, z1);
            retain(x1, z1);
            retain(x1, z0);
          }
          changed = true;
        }
        plans.set(cell, balanced);
        yield "collar_sliver_balance";
      }
    }
  }

  // Only a cell containing a feature partition or an added point on its edge
  // needs polygon work. All other cells retain their two original triangles.
  const touched = new Set(plans.keys());
  const gridXs = new Map<number, number>(),
    gridZs = new Map<number, number>();
  for (let i = 0; i < resolution; i++) {
    gridXs.set(p[i * 3], i);
    gridZs.set(p[i * resolution * 3 + 2], i);
    if ((i + 1) % 128 === 0) yield "collar_grid_axes";
  }
  yield "collar_grid_axes";
  for (let id = baseCount; id < p.length / 3; id++) {
    const x = p[id * 3],
      z = p[id * 3 + 2];
    const gx = gridXs.get(x),
      gz = gridZs.get(z);
    if (gx !== undefined) {
      const iz = locate(z, resolution * 3, 2);
      if (gx > 0) touched.add(iz * cellsPerAxis + gx - 1);
      if (gx < cellsPerAxis) touched.add(iz * cellsPerAxis + gx);
    }
    if (gz !== undefined) {
      const ix = locate(x, 3, 0);
      if (gz > 0) touched.add((gz - 1) * cellsPerAxis + ix);
      if (gz < cellsPerAxis) touched.add(gz * cellsPerAxis + ix);
    }
    if ((id + 1) % 128 === 0) yield "collar_touched_cells";
  }
  yield "collar_touched_cells";

  // Global axis lists split every shared edge, including feature-line endpoints
  // and neighbouring coarse cells. Original grid points participate as well.
  const alongX = new Map<number, number[]>(),
    alongZ = new Map<number, number[]>();
  for (let id = 0; id < p.length / 3; id++) {
    const x = p[id * 3],
      z = p[id * 3 + 2];
    if (!alongX.has(z)) alongX.set(z, []);
    if (!alongZ.has(x)) alongZ.set(x, []);
    alongX.get(z)!.push(id);
    alongZ.get(x)!.push(id);
    if ((id + 1) % 128 === 0) yield "collar_axis_index";
  }
  yield "collar_axis_index";
  for (const ids of alongX.values()) {
    ids.sort((a, b) => p[a * 3] - p[b * 3]);
    yield "collar_axis_sort";
  }
  for (const ids of alongZ.values()) {
    ids.sort((a, b) => p[a * 3 + 2] - p[b * 3 + 2]);
    yield "collar_axis_sort";
  }
  const splitEdges = (polygon: number[]) => {
    const result: number[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      result.push(a);
      const vertical = p[a * 3] === p[b * 3];
      const horizontal = p[a * 3 + 2] === p[b * 3 + 2];
      if (!vertical && !horizontal) continue;
      const coordinate = vertical ? 2 : 0;
      const candidates = vertical
        ? alongZ.get(p[a * 3])!
        : alongX.get(p[a * 3 + 2])!;
      const start = p[a * 3 + coordinate],
        end = p[b * 3 + coordinate];
      const lower = Math.min(start, end),
        upper = Math.max(start, end);
      let lo = 0,
        hi = candidates.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (p[candidates[mid] * 3 + coordinate] <= lower) lo = mid + 1;
        else hi = mid;
      }
      const begin = lo;
      while (
        lo < candidates.length &&
        p[candidates[lo] * 3 + coordinate] < upper
      )
        lo++;
      if (start < end)
        for (let j = begin; j < lo; j++) result.push(candidates[j]);
      else for (let j = lo - 1; j >= begin; j--) result.push(candidates[j]);
    }
    return result;
  };
  const indices: number[] = [],
    offsets = [0];
  const normalVertices = new Set<number>();
  const triangle = (a: number, b: number, c: number) => {
    const area =
      (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]) -
      (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]);
    if (!(area < 0))
      throw new Error("Degenerate/reversed terrain collar triangle");
    indices.push(a, b, c);
  };
  for (let iz = 0; iz < cellsPerAxis; iz++)
    for (let ix = 0; ix < cellsPerAxis; ix++) {
      const cell = iz * cellsPerAxis + ix,
        a = iz * resolution + ix;
      const b = a + 1,
        c = a + resolution,
        d = c + 1;
      if (!touched.has(cell)) {
        indices.push(a, c, b, b, c, d);
        offsets.push(indices.length);
        if ((cell + 1) % 128 === 0) yield "collar_regular_indices";
        continue;
      }
      const plan = plans.get(cell),
        polygons = plan ?? [[a, c, d, b]];
      for (const polygon of polygons) {
        const boundary = splitEdges(polygon);
        if (!plan && boundary.length === 4) {
          triangle(a, c, b);
          triangle(b, c, d);
          continue;
        }
        for (const id of boundary) normalVertices.add(id);
        if (boundary.length > polygon.length) {
          // A centre fan retains every collinear boundary subdivision; a corner
          // fan would skip such vertices and create a new interior T junction.
          const center = vertex(
            boundary.reduce((sum, id) => sum + p[id * 3], 0) / boundary.length,
            boundary.reduce((sum, id) => sum + p[id * 3 + 2], 0) /
              boundary.length,
          );
          normalVertices.add(center);
          for (let i = 0; i < boundary.length; i++)
            triangle(center, boundary[i], boundary[(i + 1) % boundary.length]);
        } else {
          for (let i = 1; i < boundary.length - 1; i++)
            triangle(boundary[0], boundary[i], boundary[i + 1]);
        }
        yield "collar_polygon_indices";
      }
      if (
        (indices.length - offsets[offsets.length - 1]) / 3 > MAX_CELL_FACES ||
        indices.length / 3 > MAX_MAIN_FACES
      )
        throw new Error("Terrain collar refinement triangle limit exceeded");
      offsets.push(indices.length);
      yield "collar_cell_indices";
    }
  const surfaceVertexCount = p.length / 3;
  const edges = [
    alongX.get(p[2])!,
    alongX.get(p[resolution * (resolution - 1) * 3 + 2])!,
    alongZ.get(p[0])!,
    alongZ.get(p[(resolution - 1) * 3])!,
  ];
  const skirtCount = edges.reduce((sum, edge) => sum + edge.length, 0);
  const total = surfaceVertexCount + skirtCount;
  const attributes: Record<string, Float32Array> = {};
  // Source attributes stay unchanged until installation below. Retain their
  // ordered entries once instead of allocating them for every added vertex.
  const attributeEntries = Object.entries(geometry.attributes);
  for (const [name, attribute] of attributeEntries) {
    const array = new Float32Array(total * attribute.itemSize);
    array.set(
      (attribute.array as Float32Array).subarray(
        0,
        baseCount * attribute.itemSize,
      ),
    );
    attributes[name] = array;
    yield "collar_allocate_attribute";
  }
  attributes.position.set(p);
  yield "collar_copy_positions";
  for (let id = baseCount; id < surfaceVertexCount; id++) {
    const x = p[id * 3],
      z = p[id * 3 + 2];
    const ix = locate(x, 3, 0),
      iz = locate(z, resolution * 3, 2);
    const a = iz * resolution + ix,
      b = a + 1,
      c = a + resolution,
      d = c + 1;
    const u = (x - p[a * 3]) / (p[b * 3] - p[a * 3]);
    const v = (z - p[a * 3 + 2]) / (p[c * 3 + 2] - p[a * 3 + 2]);
    for (const [name, attribute] of attributeEntries) {
      if (name === "position" || name === "normal" || name === "roadInfluence")
        continue;
      const array = attributes[name],
        source = attribute.array;
      for (let component = 0; component < attribute.itemSize; component++) {
        array[id * attribute.itemSize + component] =
          name === "biomeId"
            ? source[
                (v < 0.5 ? (u < 0.5 ? a : b) : u < 0.5 ? c : d) *
                  attribute.itemSize +
                  component
              ]
            : (1 - v) *
                ((1 - u) * source[a * attribute.itemSize + component] +
                  u * source[b * attribute.itemSize + component]) +
              v *
                ((1 - u) * source[c * attribute.itemSize + component] +
                  u * source[d * attribute.itemSize + component]);
      }
    }
    attributes.roadInfluence[id] = provider.calculateRoadInfluenceAtVertex(
      centerX + x,
      centerZ + z,
      Math.floor((centerX + x) / provider.TILE_SIZE),
      Math.floor((centerZ + z) / provider.TILE_SIZE),
    );
    if ((id + 1) % 32 === 0) yield "collar_vertex_attributes";
  }
  yield "collar_vertex_attributes";
  // Small canonical stencils agree at independently assembled chunk edges and
  // do not wash a one-metre floor collar into the original coarse-grid normals.
  const normalStep = COLLAR_STEP / 4;
  let normalCount = 0;
  for (const id of normalVertices) {
    const x = centerX + p[id * 3],
      z = centerZ + p[id * 3 + 2];
    const nx =
      -(
        provider.getHeightAtComputed(x + normalStep, z) -
        provider.getHeightAtComputed(x - normalStep, z)
      ) /
      (2 * normalStep);
    const nz =
      -(
        provider.getHeightAtComputed(x, z + normalStep) -
        provider.getHeightAtComputed(x, z - normalStep)
      ) /
      (2 * normalStep);
    const length = Math.hypot(nx, 1, nz);
    if (!Number.isFinite(length))
      throw new Error("Non-finite terrain collar normal");
    attributes.normal[id * 3] = nx / length;
    attributes.normal[id * 3 + 1] = 1 / length;
    attributes.normal[id * 3 + 2] = nz / length;
    if (++normalCount % 32 === 0) yield "collar_vertex_normals";
  }
  yield "collar_vertex_normals";
  let skirt = surfaceVertexCount;
  for (let side = 0; side < edges.length; side++) {
    const edge = edges[side];
    const start = skirt;
    for (const id of edge) {
      for (const [name, attribute] of attributeEntries)
        for (let j = 0; j < attribute.itemSize; j++)
          attributes[name][skirt * attribute.itemSize + j] =
            attributes[name][id * attribute.itemSize + j];
      attributes.position[skirt * 3 + 1] =
        attributes.position[id * 3 + 1] - skirtDrop;
      skirt++;
      if (skirt % 128 === 0) yield "collar_skirt_attributes";
    }
    yield "collar_skirt_attributes";
    for (let i = 0; i < edge.length - 1; i++) {
      const a = edge[i],
        b = edge[i + 1],
        sa = start + i,
        sb = sa + 1;
      if (side === 0 || side === 3) indices.push(sa, a, sb, sb, a, b);
      else indices.push(a, sa, b, b, sa, sb);
      if ((i + 1) % 128 === 0) yield "collar_skirt_indices";
    }
    yield "collar_skirt_indices";
  }
  for (const [name, attribute] of attributeEntries)
    geometry.setAttribute(
      name,
      new THREE.BufferAttribute(attributes[name], attribute.itemSize),
    );
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  yield "collar_install_attributes";
  geometry.userData.terrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution,
    cellIndexOffsets: Object.freeze(offsets),
    surfaceVertexCount,
  });
  yield "collar_freeze_topology";
}

/**
 * Test the four one-step-outside normal stencils, not the whole neighboring
 * chunk. At most 4N grading queries are needed; stop at the first affected one.
 * No height query is needed when all these samples are ungraded.
 */
function* hasGradingInNormalBorderSteps(
  segments: number,
  gridStep: number,
  minX: number,
  minZ: number,
  provider: ChunkTerrainProvider,
): Generator<string, boolean, void> {
  const maxX = minX + (segments - 1) * gridStep;
  const maxZ = minZ + (segments - 1) * gridStep;
  for (let i = 0; i < segments; i++) {
    const x = minX + i * gridStep;
    const z = minZ + i * gridStep;
    if (
      provider.getFlatZoneHeight(minX - gridStep, z) !== null ||
      provider.getFlatZoneHeight(maxX + gridStep, z) !== null ||
      provider.getFlatZoneHeight(x, minZ - gridStep) !== null ||
      provider.getFlatZoneHeight(x, maxZ + gridStep) !== null
    ) {
      return true;
    }
    if ((i + 1) % 16 === 0) yield "assembly_grading_border";
  }
  yield "assembly_grading_border";
  return false;
}

/**
 * Recompute normals for the main grid after flat-zone height overrides.
 * Uses centered finite differences from the final position buffer. At chunk
 * edges, sample the final height field one grid step beyond the chunk rather
 * than clamping to the edge (which halves the slope and creates lighting seams).
 * Extra terrain work is bounded to four samples per grid row/column, not one
 * procedural evaluation per interior vertex.
 */
function* recomputeNormalsSteps(
  positions: Float32Array,
  normals: Float32Array,
  segments: number,
  gridStep: number,
  minX: number,
  minZ: number,
  provider: ChunkTerrainProvider,
): Generator<string, void, void> {
  const invTwoStep = 1 / (2 * gridStep);

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const idx = iz * segments + ix;
      const i3 = idx * 3;

      const worldX = minX + ix * gridStep;
      const worldZ = minZ + iz * gridStep;
      const hL =
        ix > 0
          ? positions[(idx - 1) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX - gridStep, worldZ),
            );
      const hR =
        ix < segments - 1
          ? positions[(idx + 1) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX + gridStep, worldZ),
            );
      const hD =
        iz > 0
          ? positions[(idx - segments) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX, worldZ - gridStep),
            );
      const hU =
        iz < segments - 1
          ? positions[(idx + segments) * 3 + 1]
          : Math.fround(
              provider.getHeightAtComputed(worldX, worldZ + gridStep),
            );

      const dhdx = (hR - hL) * invTwoStep;
      const dhdz = (hU - hD) * invTwoStep;
      const nx = -dhdx;
      const ny = 1;
      const nz = -dhdz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

      normals[i3] = nx / len;
      normals[i3 + 1] = ny / len;
      normals[i3 + 2] = nz / len;
      if ((ix + 1) % 32 === 0) yield "assembly_grid_normals";
    }
    if (segments % 32 !== 0) yield "assembly_grid_normals";
  }
}

/**
 * Synchronous data generator — produces QuadChunkWorkerOutput on the main thread.
 * Used as fallback when workers are unavailable. The output feeds directly into
 * assembleQuadChunkGeometry, keeping all assembly logic in one place.
 */
export function generateQuadChunkDataSync(
  centerX: number,
  centerZ: number,
  size: number,
  resolution: number,
  provider: FullTerrainProvider,
): QuadChunkWorkerOutput {
  return drainSteps(
    generateQuadChunkDataSteps(centerX, centerZ, size, resolution, provider),
  );
}

/** The synchronous fallback's exact arithmetic, resumable before installation.
 * The caller owns input leases and must discard this iterator if they expire. */
export function* generateQuadChunkDataSteps(
  centerX: number,
  centerZ: number,
  size: number,
  resolution: number,
  provider: FullTerrainProvider,
): Generator<string, QuadChunkWorkerOutput, void> {
  const terrainProfileIdentity = provider.terrainProfileIdentity;
  if (typeof terrainProfileIdentity !== "string" || !terrainProfileIdentity) {
    throw new Error("Quad chunk terrain profile identity is required");
  }
  const segments = resolution;
  const halfSize = size * 0.5;
  const gridStep = size / (segments - 1);
  const vertexCount = segments * segments;

  // Overflow grid for normals: (segments+2)^2
  const gRes = segments + 2;
  const overflowGrid = new Float32Array(gRes * gRes);
  yield "sync_allocate_heights";

  for (let gz = 0; gz < gRes; gz++) {
    const localZ = -halfSize + (gz - 1) * gridStep;
    const worldZ = centerZ + localZ;
    for (let gx = 0; gx < gRes; gx++) {
      const localX = -halfSize + (gx - 1) * gridStep;
      const worldX = centerX + localX;
      overflowGrid[gz * gRes + gx] = provider.getHeightAtComputed(
        worldX,
        worldZ,
      );
      if ((gx + 1) % 32 === 0) yield "sync_height_samples";
    }
    if (gRes % 32 !== 0) yield "sync_height_samples";
  }

  const heightData = new Float32Array(vertexCount);
  for (let iz = 0; iz < segments; iz++) {
    const srcRow = (iz + 1) * gRes + 1;
    const dstRow = iz * segments;
    for (let ix = 0; ix < segments; ix++) {
      heightData[dstRow + ix] = overflowGrid[srcRow + ix];
    }
    yield "sync_copy_heights";
  }

  // Normals via centered finite differences on the overflow grid
  const normalData = new Float32Array(vertexCount * 3);
  const invTwoStep = 1 / (2 * gridStep);
  for (let iz = 0; iz < segments; iz++) {
    const gz = iz + 1;
    for (let ix = 0; ix < segments; ix++) {
      const gx = ix + 1;
      const hL = overflowGrid[gz * gRes + (gx - 1)];
      const hR = overflowGrid[gz * gRes + (gx + 1)];
      const hD = overflowGrid[(gz - 1) * gRes + gx];
      const hU = overflowGrid[(gz + 1) * gRes + gx];
      const dhdx = (hR - hL) * invTwoStep;
      const dhdz = (hU - hD) * invTwoStep;
      const nx = -dhdx;
      const ny = 1;
      const nz = -dhdz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const i3 = (iz * segments + ix) * 3;
      normalData[i3] = nx / len;
      normalData[i3 + 1] = ny / len;
      normalData[i3 + 2] = nz / len;
    }
    yield "sync_normals";
  }

  // Colors and biome IDs
  const colorData = new Float32Array(vertexCount * 3);
  const biomeData = new Uint8Array(vertexCount);
  const biomeForestWeight = new Float32Array(vertexCount);
  const biomeCanyonWeight = new Float32Array(vertexCount);
  yield "sync_allocate_biomes";

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const idx = iz * segments + ix;
      const height = heightData[idx];
      const normalizedHeight = height / provider.MAX_HEIGHT;

      const localX = -halfSize + ix * gridStep;
      const localZ = -halfSize + iz * gridStep;
      const worldX = centerX + localX;
      const worldZ = centerZ + localZ;

      const { biomeWeightMap, totalWeight } =
        provider.computeBiomeWeightsAtPosition(worldX, worldZ);

      let dominantBiome: string = DEFAULT_BIOME;
      let dominantWeight = -Infinity;
      let cr = 0,
        cg = 0,
        cb = 0;

      if (totalWeight > 0) {
        const invTotal = 1 / totalWeight;
        for (const [type, rawWeight] of biomeWeightMap) {
          const weight = rawWeight * invTotal;
          if (weight > dominantWeight) {
            dominantWeight = weight;
            dominantBiome = type;
          }
          const bc = provider.getBiomeColor(type);
          cr += bc.r * weight;
          cg += bc.g * weight;
          cb += bc.b * weight;
        }
      } else {
        const bc = provider.getBiomeColor(DEFAULT_BIOME);
        cr = bc.r;
        cg = bc.g;
        cb = bc.b;
      }

      biomeData[idx] = provider.getBiomeId(dominantBiome);

      const fwNorm =
        totalWeight > 0
          ? (biomeWeightMap.get(BiomeType.Forest) || 0) / totalWeight
          : 0;
      const dwNorm =
        totalWeight > 0
          ? (biomeWeightMap.get(BiomeType.Canyon) || 0) / totalWeight
          : 0;
      biomeForestWeight[idx] = fwNorm;
      biomeCanyonWeight[idx] = dwNorm;

      const waterLevel = provider.WATER_LEVEL_NORMALIZED;
      const shoreThreshold = provider.SHORELINE_THRESHOLD;
      if (normalizedHeight > waterLevel && normalizedHeight < shoreThreshold) {
        const shoreFactor =
          (1.0 -
            (normalizedHeight - waterLevel) / (shoreThreshold - waterLevel)) *
          provider.SHORELINE_STRENGTH;
        cr += (0.545 - cr) * shoreFactor;
        cg += (0.451 - cg) * shoreFactor;
        cb += (0.333 - cb) * shoreFactor;
      }

      colorData[idx * 3] = cr;
      colorData[idx * 3 + 1] = cg;
      colorData[idx * 3 + 2] = cb;
      if ((ix + 1) % 32 === 0) yield "sync_biomes";
    }
    if (segments % 32 !== 0) yield "sync_biomes";
  }

  // River proximity not computed in sync fallback — zeros (shader uses attribute default)
  const riverProximity = new Float32Array(vertexCount);
  yield "sync_allocate_rivers";

  return {
    type: "quadChunkResult",
    terrainProfileIdentity,
    centerX,
    centerZ,
    size,
    resolution,
    heightData,
    normalData,
    colorData,
    biomeData,
    biomeForestWeight,
    biomeCanyonWeight,
    riverProximity,
  };
}
