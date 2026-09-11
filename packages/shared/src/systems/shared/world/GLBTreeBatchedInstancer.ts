/**
 * GLBTreeBatchedInstancer — BatchedMesh-based rendering for multi-variant trees.
 *
 * Loads all model variants for each tree type once, registers their
 * geometries in a shared BatchedMesh per material slot per LOD level.
 * Each tree instance picks a variant via addInstance(geometryId).
 *
 * One BatchedMesh per material slot (bark, leaves) per LOD = minimal
 * draw calls regardless of how many variants a tree type has.
 *
 * Used when a tree type has `modelVariants` in its manifest.
 * For single-model resources, use GLBTreeInstancer (InstancedMesh-based).
 *
 * @module GLBTreeBatchedInstancer
 */

import THREE from "../../../extras/three/three";
import type { World } from "../../../core/World";
import { SNOW_BIOMES } from "./TerrainBiomeTypes";
import { modelCache } from "../../../utils/rendering/ModelCache";
import {
  createTreeDissolveMaterial,
  GPU_VEG_CONFIG,
  type DissolveMaterial,
  type TreeDissolveMaterial,
  type TreeMaterialOptions,
} from "./GPUMaterials";
import type { Wind } from "./Wind";
import type { TerrainSystem } from "./TerrainSystem";
import { getLODDistances, inferLOD1Path, inferLOD2Path } from "./LODConfig";
import {
  type DissolveAnim,
  startDissolve as startDissolveAnim,
  tickDissolveAnims,
} from "./DissolveAnimation";
import { shouldStreamVegetationBackgroundLods } from "../../../runtime/clientViewportMode";

const MAX_INSTANCES = 512;

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

// ---- Per-instance frustum culling (Option B: setVisibleAt) ----
// We build a world-space bounding sphere per tree slot each frame and call
// setVisibleAt(id, false) for slots outside the frustum or beyond the far fade
// distance. This is safe with sortObjects=false because setVisibleAt only marks
// slots; it does not remove them from the buffer, so the indirect drawIndex →
// instanceId mapping never shifts (avoiding the tree-swap bug from perObjectFrustumCulled).
const _cullFrustum = new THREE.Frustum();
const _cullProjScreenMatrix = new THREE.Matrix4();
const _cullSphere = new THREE.Sphere();
// Extra world-space padding beyond the tree's computed radius to avoid pops at edges.
const TREE_CULL_SPHERE_BUFFER = 4; // meters
// Max squared distance beyond which trees are always invisible (matches shader FADE_END).
const TREE_MAX_RENDER_DIST = GPU_VEG_CONFIG.FADE_END;
const TREE_MAX_RENDER_DIST_SQ = TREE_MAX_RENDER_DIST * TREE_MAX_RENDER_DIST;

// ---- Batch color channel layout ----
// R = highlight intensity (1.0 = normal, >1.0 = highlighted via HL_COLOR_INTENSITY)
// G = biome snow weight (0.0 = no snow, 1.0 = full snow) — set once on add/LOD swap
// B = 1.0 - dissolveVal (1.0 = fully visible, 0.0 = fully dissolved)
// Only modify channels through applyHighlightColor (R), applyDissolveColor (B),
// and addToPool (G for snow).
// NOTE: If the underlying color buffer is Uint8 (256 levels), dissolve precision is
// ~0.004 per step. At 0.3s duration / 60fps (~18 steps) this is more than sufficient.
const _defaultColor = new THREE.Color(1, 1, 1);
const _tmpColor = new THREE.Color();
/** Highlight multiplier for R/G channels (>1.0 brightens; shader detects via step(1.01)) */
const HL_COLOR_INTENSITY = 1.15;

interface TreeSlot {
  entityId: string;
  position: THREE.Vector3;
  rotation: number;
  scale: number;
  yOffset: number;
  currentLOD: 0 | 1 | 2;
  variantIndex: number;
  snowWeight: number;
}

interface BatchedLODPool {
  /** One BatchedMesh per material slot (e.g. [bark, leaves]) */
  batches: THREE.BatchedMesh[];
  materials: DissolveMaterial[];
  /**
   * geometryIds[materialSlot][variantIndex] = geometryId returned by
   * BatchedMesh.addGeometry() for that variant's geometry.
   */
  geometryIds: number[][];
  /** entityId → array of instanceIds (one per BatchedMesh/material slot) */
  instanceIds: Map<string, number[]>;
  /**
   * sourceGeometries[variantIndex][materialSlot] = original BufferGeometry.
   * Retained so collision proxies can use the actual model shape.
   */
  sourceGeometries: THREE.BufferGeometry[][];
}

interface TreeTypePool {
  treeType: string;
  variantPaths: string[];
  lod0: BatchedLODPool | null;
  lod1: BatchedLODPool | null;
  lod2: BatchedLODPool | null;
  instances: Map<string, TreeSlot>;
  yOffset: number;
  modelHeight: number;
  modelRadius: number;
}

const resourceLOD = getLODDistances("tree");

// ---- Module state ----
let scene: THREE.Scene | null = null;
let world: World | null = null;
const pools = new Map<string, TreeTypePool>();
const entityToTreeType = new Map<string, string>();

// ---- Geometry extraction ----

interface MeshPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

function extractAllMeshParts(root: THREE.Object3D): MeshPart[] {
  const parts: MeshPart[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      if (Array.isArray(child.material)) {
        for (const mat of child.material) {
          parts.push({ geometry: child.geometry, material: mat });
        }
      } else {
        parts.push({ geometry: child.geometry, material: child.material });
      }
    }
  });
  return parts;
}

let _fingerprintId = 0;

/**
 * Returns a string key that identifies a material's diffuse texture.
 * Used to match the same material slot across different model variants.
 */
function getTextureFingerprint(mat: THREE.Material): string {
  const std = mat as THREE.MeshStandardMaterial;
  if (std.map?.image) {
    const img = std.map.image as {
      width?: number;
      height?: number;
      src?: string;
      uuid?: string;
    };
    return `tex:${img.width}x${img.height}:${img.src ?? img.uuid ?? ""}`;
  }
  if (std.name) return `name:${std.name}`;
  // Deterministic fallback — monotonic counter avoids random fingerprints
  // that would silently prevent variant matching.
  return `idx:${_fingerprintId++}`;
}

/**
 * Reorder `parts` so that each part's texture fingerprint matches
 * the corresponding `refFingerprints[slotIdx]`.
 * Returns reordered array, or null if matching fails.
 */
function matchPartsToReference(
  refFingerprints: string[],
  parts: MeshPart[],
): MeshPart[] | null {
  if (parts.length !== refFingerprints.length) return null;
  const partFingerprints = parts.map((p) => getTextureFingerprint(p.material));
  const used = new Set<number>();
  const reordered: MeshPart[] = [];

  for (let slot = 0; slot < refFingerprints.length; slot++) {
    let matched = -1;
    for (let pi = 0; pi < partFingerprints.length; pi++) {
      if (!used.has(pi) && partFingerprints[pi] === refFingerprints[slot]) {
        matched = pi;
        break;
      }
    }
    if (matched === -1) {
      // Fallback: try matching by material name
      const refName = refFingerprints[slot].startsWith("name:")
        ? refFingerprints[slot].slice(5)
        : "";
      for (let pi = 0; pi < parts.length; pi++) {
        if (
          !used.has(pi) &&
          (parts[pi].material as THREE.MeshStandardMaterial).name === refName
        ) {
          matched = pi;
          break;
        }
      }
    }
    if (matched === -1) return null;
    used.add(matched);
    reordered.push(parts[matched]);
  }
  return reordered;
}

function computeModelBounds(
  root: THREE.Object3D,
  scale: number,
): {
  yOffset: number;
  height: number;
  radius: number;
} {
  const saved = root.scale.clone();
  root.scale.set(scale, scale, scale);
  const bbox = new THREE.Box3().setFromObject(root);
  root.scale.copy(saved);
  const height = bbox.max.y - bbox.min.y;
  const dx = Math.max(Math.abs(bbox.min.x), Math.abs(bbox.max.x));
  const dz = Math.max(Math.abs(bbox.min.z), Math.abs(bbox.max.z));
  return { yOffset: 0, height, radius: Math.max(dx, dz) };
}

async function loadLODParts(path: string): Promise<MeshPart[] | null> {
  try {
    const { scene: lodScene } = await modelCache.loadModel(path, world!);
    const parts = extractAllMeshParts(lodScene);
    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

// ---- BatchedLODPool creation ----

function countGeometry(geo: THREE.BufferGeometry): {
  vertexCount: number;
  indexCount: number;
} {
  const vertexCount = geo.getAttribute("position")?.count ?? 0;
  const indexCount = geo.index?.count ?? 0;
  return { vertexCount, indexCount };
}

/**
 * Build a BatchedLODPool from multiple variants' parts.
 * variantParts[variant][materialSlot] = { geometry, material }
 * All variants must have the same number of material slots.
 */
function createBatchedLODPool(
  variantParts: {
    geometry: THREE.BufferGeometry;
    material: DissolveMaterial;
  }[][],
): BatchedLODPool {
  const numSlots = variantParts[0].length;
  const numVariants = variantParts.length;

  const batches: THREE.BatchedMesh[] = [];
  const materials: DissolveMaterial[] = [];
  const geometryIds: number[][] = [];

  for (let slot = 0; slot < numSlots; slot++) {
    const mat = variantParts[0][slot].material;

    let totalVerts = 0;
    let totalIndices = 0;
    for (let v = 0; v < numVariants; v++) {
      const counts = countGeometry(variantParts[v][slot].geometry);
      totalVerts += counts.vertexCount;
      totalIndices += counts.indexCount;
    }

    const bm = new THREE.BatchedMesh(
      MAX_INSTANCES,
      totalVerts,
      totalIndices > 0 ? totalIndices : undefined,
      mat,
    );
    bm.frustumCulled = false;
    bm.perObjectFrustumCulled = false;
    bm.sortObjects = false;
    bm.castShadow = true;
    bm.receiveShadow =
      (mat as TreeDissolveMaterial).treeLighting.mode ===
      "scene-pbr-mask-safe-v1";
    bm.layers.set(1);

    const slotGeoIds: number[] = [];
    for (let v = 0; v < numVariants; v++) {
      const geoId = bm.addGeometry(variantParts[v][slot].geometry);
      slotGeoIds.push(geoId);
    }

    // Force-init colors texture so BatchNode sets up vBatchColor varying
    // before the first shader compilation.
    const initId = bm.addInstance(slotGeoIds[0]);
    bm.setColorAt(initId, _defaultColor);
    bm.deleteInstance(initId);

    scene!.add(bm);
    batches.push(bm);
    materials.push(mat);
    geometryIds.push(slotGeoIds);
  }

  // Store source geometries per variant for collision proxy use
  const sourceGeometries: THREE.BufferGeometry[][] = [];
  for (let v = 0; v < numVariants; v++) {
    sourceGeometries.push(variantParts[v].map((p) => p.geometry));
  }

  return {
    batches,
    materials,
    geometryIds,
    instanceIds: new Map(),
    sourceGeometries,
  };
}

// ---- Texture helpers ----

function enableTextureRepeat(mat: DissolveMaterial): void {
  const texProps = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
    "alphaMap",
  ] as const;
  for (const key of texProps) {
    const tex = (mat as unknown as Record<string, unknown>)[key] as
      THREE.Texture | undefined;
    if (tex) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
    }
  }
}

// ---- Tree type pool lifecycle ----

const pendingEnsure = new Map<string, Promise<TreeTypePool>>();

async function ensureTreeTypePool(
  treeType: string,
  variantPaths: string[],
): Promise<TreeTypePool> {
  const existing = pools.get(treeType);
  if (existing) return existing;

  const pending = pendingEnsure.get(treeType);
  if (pending) return pending;

  const promise = (async (): Promise<TreeTypePool> => {
    const terrain = world!.getSystem<TerrainSystem>("terrain");
    const terrainProfile = terrain?.getWorldTerrainProfile();
    const dissolveOpts = {
      fadeStart: GPU_VEG_CONFIG.FADE_START,
      fadeEnd: GPU_VEG_CONFIG.FADE_END,
      enableNearFade: false,
      enableWaterCulling: false,
      enableOcclusionDissolve: false,
      enableRimHighlight: true,
    };

    function buildMaterialForPart(p: MeshPart): DissolveMaterial {
      const dm = createTreeDissolveMaterial(p.material, {
        ...dissolveOpts,
        batched: true,
        treePalette: terrainProfile
          ? { terrainProfile, species: treeType }
          : undefined,
      } as TreeMaterialOptions);
      dm.side = THREE.DoubleSide;
      enableTextureRepeat(dm);
      world!.setupMaterial(dm);
      return dm;
    }

    // Load all variant LOD0s in parallel
    const lod0Scenes = await Promise.all(
      variantPaths.map(async (vp) => {
        const { scene: s } = await modelCache.loadModel(vp, world!);
        return s;
      }),
    );

    // Extract parts per variant
    const allLod0Parts = lod0Scenes.map((s) => extractAllMeshParts(s));
    if (allLod0Parts[0].length === 0)
      throw new Error(`No mesh found in ${variantPaths[0]}`);

    const numSlots = allLod0Parts[0].length;

    // Build a texture fingerprint for each part in variant 0 to define slot identity
    const refFingerprints = allLod0Parts[0].map((p) =>
      getTextureFingerprint(p.material),
    );

    // Reorder each subsequent variant's parts to match variant 0's slot order
    for (let v = 1; v < allLod0Parts.length; v++) {
      const parts = allLod0Parts[v];
      if (parts.length !== numSlots) {
        console.warn(
          `[GLBTreeBatchedInstancer] Variant ${variantPaths[v]} has ${parts.length} parts, expected ${numSlots}!`,
        );
        continue;
      }
      const reordered = matchPartsToReference(refFingerprints, parts);
      if (reordered) {
        allLod0Parts[v] = reordered;
      } else {
        console.warn(
          `[GLBTreeBatchedInstancer] Could not match parts for ${variantPaths[v]} — using original order`,
        );
      }
    }

    // Build materials from first variant (shared for all variants)
    const sharedMaterials = allLod0Parts[0].map((p) => buildMaterialForPart(p));

    // Build variant parts for LOD0
    const lod0VariantParts = allLod0Parts.map((parts) =>
      parts.map((p, slotIdx) => ({
        geometry: p.geometry,
        material: sharedMaterials[slotIdx % sharedMaterials.length],
      })),
    );

    const lod0Pool = createBatchedLODPool(lod0VariantParts);

    // Compute bounds from first variant
    const bounds = computeModelBounds(lod0Scenes[0], 1);

    // Broadcast/spectator viewports do not traverse the exploration world.
    // Keep their LOD0 fallback and omit the two background model/decode/upload
    // waves that otherwise interrupt the first arena frames.
    const loadBackgroundLods = shouldStreamVegetationBackgroundLods();

    // Load LOD1 variants in parallel
    let lod1Pool: BatchedLODPool | null = null;
    const lod1Results = loadBackgroundLods
      ? await Promise.all(
          variantPaths.map((vp) => loadLODParts(inferLOD1Path(vp))),
        )
      : [];
    const validLod1 = lod1Results.filter(
      (r): r is MeshPart[] => r !== null && r.length === numSlots,
    );
    if (validLod1.length > 0) {
      const lod1Ref = validLod1[0].map((p) =>
        getTextureFingerprint(p.material),
      );
      for (let v = 1; v < validLod1.length; v++) {
        const matched = matchPartsToReference(lod1Ref, validLod1[v]);
        if (matched) validLod1[v] = matched;
      }
      const lod1Materials = validLod1[0].map((p) => buildMaterialForPart(p));
      const lod1VariantParts = validLod1.map((parts) =>
        parts.map((p, slotIdx) => ({
          geometry: p.geometry,
          material: lod1Materials[slotIdx],
        })),
      );
      lod1Pool = createBatchedLODPool(lod1VariantParts);
    }

    // Load LOD2 variants in parallel
    let lod2Pool: BatchedLODPool | null = null;
    const lod2Results = loadBackgroundLods
      ? await Promise.all(
          variantPaths.map((vp) => loadLODParts(inferLOD2Path(vp))),
        )
      : [];
    const validLod2 = lod2Results.filter(
      (r): r is MeshPart[] => r !== null && r.length === numSlots,
    );
    if (validLod2.length > 0) {
      const lod2Ref = validLod2[0].map((p) =>
        getTextureFingerprint(p.material),
      );
      for (let v = 1; v < validLod2.length; v++) {
        const matched = matchPartsToReference(lod2Ref, validLod2[v]);
        if (matched) validLod2[v] = matched;
      }
      const lod2Materials = validLod2[0].map((p) => buildMaterialForPart(p));
      const lod2VariantParts = validLod2.map((parts) =>
        parts.map((p, slotIdx) => ({
          geometry: p.geometry,
          material: lod2Materials[slotIdx],
        })),
      );
      lod2Pool = createBatchedLODPool(lod2VariantParts);
    }

    const pool: TreeTypePool = {
      treeType,
      variantPaths,
      lod0: lod0Pool,
      lod1: lod1Pool,
      lod2: lod2Pool,
      instances: new Map(),
      yOffset: bounds.yOffset,
      modelHeight: bounds.height,
      modelRadius: bounds.radius,
    };
    pools.set(treeType, pool);

    return pool;
  })();

  pendingEnsure.set(treeType, promise);
  try {
    return await promise;
  } finally {
    pendingEnsure.delete(treeType);
  }
}

// ---- Instance matrix helper ----

function composeInstanceMatrix(
  position: THREE.Vector3,
  rotation: number,
  scale: number,
  yOffset: number,
): THREE.Matrix4 {
  _position.set(position.x, position.y + yOffset * scale, position.z);
  _quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotation);
  _scale.set(scale, scale, scale);
  return _matrix.compose(_position, _quaternion, _scale);
}

// ---- Pool add/remove ----

function addToPool(
  pool: BatchedLODPool,
  entityId: string,
  mat: THREE.Matrix4,
  variantIndex: number,
  dissolve = 0,
  snowWeight = 0,
): void {
  for (let i = 0; i < pool.batches.length; i++) {
    const numVariants = pool.geometryIds[i].length;
    const clampedIdx = variantIndex % numVariants;
    if (pool.geometryIds[i][clampedIdx] === undefined) {
      console.warn(
        `[GLBTreeBatchedInstancer] geoId undefined: slot=${i} variant=${clampedIdx} available=${numVariants}, aborting addToPool`,
      );
      return;
    }
  }

  const ids: number[] = new Array(pool.batches.length);
  _tmpColor.setRGB(1, snowWeight, 1.0 - dissolve);
  for (let i = 0; i < pool.batches.length; i++) {
    const numVariants = pool.geometryIds[i].length;
    const clampedIdx = variantIndex % numVariants;
    const geoId = pool.geometryIds[i][clampedIdx];
    const instId = pool.batches[i].addInstance(geoId);
    pool.batches[i].setMatrixAt(instId, mat);
    pool.batches[i].setColorAt(instId, _tmpColor);
    ids[i] = instId;
  }
  pool.instanceIds.set(entityId, ids);
}

function removeFromPool(pool: BatchedLODPool, entityId: string): void {
  const ids = pool.instanceIds.get(entityId);
  if (!ids) return;
  for (let i = 0; i < pool.batches.length; i++) {
    pool.batches[i].deleteInstance(ids[i]);
  }
  pool.instanceIds.delete(entityId);
}

function isHighlighted(pool: BatchedLODPool, entityId: string): boolean {
  const ids = pool.instanceIds.get(entityId);
  if (!ids || ids.length === 0) return false;
  pool.batches[0].getColorAt(ids[0], _tmpColor);
  return _tmpColor.r > 1.01;
}

function applyHighlightColor(
  pool: BatchedLODPool,
  entityId: string,
  on: boolean,
): void {
  const ids = pool.instanceIds.get(entityId);
  if (!ids) return;
  const r = on ? HL_COLOR_INTENSITY : 1.0;
  for (let i = 0; i < pool.batches.length; i++) {
    // Only modify R (highlight); preserve G (snow weight) and B (dissolve)
    pool.batches[i].getColorAt(ids[i], _tmpColor);
    _tmpColor.setRGB(r, _tmpColor.g, _tmpColor.b);
    pool.batches[i].setColorAt(ids[i], _tmpColor);
  }
}

// ---- Public API ----

export function initGLBTreeBatchedInstancer(s: THREE.Scene, w: World): void {
  scene = s;
  world = w;
}

/**
 * NOTE: Caller must also call clearProxyGeometryCache() (from TreeGLBVisualStrategy)
 * after this to dispose cached proxy geometries that reference sourceGeometries.
 */
export function destroyGLBTreeBatchedInstancer(): void {
  for (const pool of pools.values()) {
    for (const lodPool of [pool.lod0, pool.lod1, pool.lod2]) {
      if (!lodPool) continue;
      for (const bm of lodPool.batches) {
        scene?.remove(bm);
        bm.dispose();
      }
      for (const mat of lodPool.materials) mat.dispose();
      lodPool.sourceGeometries.length = 0;
    }
  }
  pools.clear();
  entityToTreeType.clear();
  pendingEnsure.clear();
  dissolveAnims.clear();
  scene = null;
  world = null;
}

export async function addInstance(
  treeType: string,
  variantPaths: string[],
  variantIndex: number,
  entityId: string,
  position: THREE.Vector3,
  rotation: number,
  scale: number,
  initialDissolve = 0,
): Promise<boolean> {
  if (!scene || !world) return false;

  if (entityToTreeType.has(entityId)) {
    removeInstance(entityId);
  }

  try {
    const pool = await ensureTreeTypePool(treeType, variantPaths);

    // Pick initial LOD based on camera distance to avoid LOD0 pop-in at range
    let initialLOD: 0 | 1 | 2 = 0;
    if (world?.camera) {
      const cp = world.camera.position;
      const dx = cp.x - position.x;
      const dz = cp.z - position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= resourceLOD.lod2DistanceSq) {
        initialLOD = pool.lod2 ? 2 : pool.lod1 ? 1 : 0;
      } else if (distSq >= resourceLOD.lod1DistanceSq) {
        initialLOD = pool.lod1 ? 1 : 0;
      }
    }

    let snowWeight = 0;
    {
      const terrain = world!.getSystem<any>("terrain");
      if (terrain?.computeBiomeWeightsByPosition) {
        const weights = terrain.computeBiomeWeightsByPosition(
          position.x,
          position.z,
        ) as Record<string, number>;
        const totalWeight = Object.values(weights).reduce(
          (a: number, b: number) => a + b,
          0,
        );
        if (totalWeight > 0) {
          let snowSum = 0;
          for (const [biome, w] of Object.entries(weights)) {
            if (SNOW_BIOMES.has(biome)) snowSum += w;
          }
          snowWeight = snowSum / totalWeight;
        }
      } else {
        snowWeight = 1.0;
      }
    }

    const slot: TreeSlot = {
      entityId,
      position: position.clone(),
      rotation,
      scale,
      yOffset: pool.yOffset,
      currentLOD: initialLOD,
      variantIndex,
      snowWeight,
    };

    pool.instances.set(entityId, slot);
    entityToTreeType.set(entityId, treeType);

    const mat = composeInstanceMatrix(position, rotation, scale, pool.yOffset);
    const initialPool =
      initialLOD === 0 ? pool.lod0 : initialLOD === 1 ? pool.lod1 : pool.lod2;
    if (initialPool)
      addToPool(
        initialPool,
        entityId,
        mat,
        variantIndex,
        initialDissolve,
        snowWeight,
      );

    return true;
  } catch (error) {
    console.warn(
      `[GLBTreeBatchedInstancer] Failed to add instance ${entityId}:`,
      error,
    );
    return false;
  }
}

export function removeInstance(entityId: string): void {
  const treeType = entityToTreeType.get(entityId);
  if (!treeType) return;

  const pool = pools.get(treeType);
  if (!pool) return;

  const slot = pool.instances.get(entityId);
  if (!slot) return;

  const lodPool = getLodPool(pool, slot);
  if (lodPool) removeFromPool(lodPool, entityId);

  pool.instances.delete(entityId);
  entityToTreeType.delete(entityId);
  dissolveAnims.delete(entityId);
}

function getLodPool(pool: TreeTypePool, slot: TreeSlot): BatchedLODPool | null {
  return slot.currentLOD === 0
    ? pool.lod0
    : slot.currentLOD === 1
      ? pool.lod1
      : pool.lod2;
}

export function hasInstance(entityId: string): boolean {
  return entityToTreeType.has(entityId);
}

export function getModelDimensions(
  entityId: string,
): { height: number; radius: number } | null {
  const treeType = entityToTreeType.get(entityId);
  if (!treeType) return null;
  const pool = pools.get(treeType);
  if (!pool) return null;
  return { height: pool.modelHeight, radius: pool.modelRadius };
}

/**
 * Returns the lowest-available LOD geometries for use as a collision proxy,
 * plus the yOffset needed to align the geometry with the visual instance.
 * Prefers LOD2 → LOD1 → LOD0, using the entity's assigned variant.
 * Returns null if the entity isn't registered.
 *
 * **Important**: Returned geometries are shared by the instancer pool.
 * Callers MUST clone before mutating (e.g. scaling).
 */
export function getProxyGeometry(
  entityId: string,
): { geometries: THREE.BufferGeometry[]; yOffset: number } | null {
  const treeType = entityToTreeType.get(entityId);
  if (!treeType) return null;
  const pool = pools.get(treeType);
  if (!pool) return null;
  const slot = pool.instances.get(entityId);
  if (!slot) return null;
  const lodPool = pool.lod2 ?? pool.lod1 ?? pool.lod0;
  if (!lodPool) return null;
  const vi = slot.variantIndex % lodPool.sourceGeometries.length;
  return {
    geometries: lodPool.sourceGeometries[vi],
    yOffset: pool.yOffset,
  };
}

let highlightedEntityId: string | null = null;

export function setHighlight(entityId: string, on: boolean): void {
  if (on && highlightedEntityId && highlightedEntityId !== entityId) {
    setHighlight(highlightedEntityId, false);
  }

  const treeType = entityToTreeType.get(entityId);
  if (!treeType) return;

  const pool = pools.get(treeType);
  if (!pool) return;

  const slot = pool.instances.get(entityId);
  if (!slot) return;

  const lodPool = getLodPool(pool, slot);
  if (!lodPool) return;

  applyHighlightColor(lodPool, entityId, on);
  highlightedEntityId = on ? entityId : null;
}

export function clearHighlight(): void {
  if (highlightedEntityId) {
    setHighlight(highlightedEntityId, false);
  }
}

// ---- Dissolve (tree depletion/respawn) ----

const DISSOLVE_MAX = GPU_VEG_CONFIG.DISSOLVE_MAX;

const dissolveAnims = new Map<string, DissolveAnim>();

function applyDissolveColor(
  pool: BatchedLODPool,
  entityId: string,
  dissolveVal: number,
): void {
  const ids = pool.instanceIds.get(entityId);
  if (!ids || ids.length === 0) return;
  // Skip redundant writes — read from batches[0] (all batches are kept uniform)
  pool.batches[0].getColorAt(ids[0], _tmpColor);
  const encoded = 1.0 - dissolveVal;
  if (Math.abs(_tmpColor.b - encoded) < 1e-6) return;
  // Reuse R/G from the first read — only blue changes for dissolve
  const r = _tmpColor.r;
  const g = _tmpColor.g;
  for (let i = 0; i < pool.batches.length; i++) {
    _tmpColor.setRGB(r, g, encoded);
    pool.batches[i].setColorAt(ids[i], _tmpColor);
  }
}

function applyDissolveValue(entityId: string, value: number): void {
  const treeType = entityToTreeType.get(entityId);
  if (!treeType) return;

  const pool = pools.get(treeType);
  if (!pool) return;

  const slot = pool.instances.get(entityId);
  if (!slot) return;

  // Use slot.currentLOD for O(1) pool lookup instead of searching all 3 pools.
  const lodPool = getLodPool(pool, slot);
  if (!lodPool) return;

  applyDissolveColor(lodPool, entityId, value);
}

export function startDissolve(
  entityId: string,
  direction: 1 | -1,
  instant = false,
): void {
  startDissolveAnim(
    dissolveAnims,
    entityId,
    direction,
    instant,
    applyDissolveValue,
  );
}

let lastUpdateFrame = -1;

export function updateGLBTreeBatchedInstancer(deltaTime: number): void {
  if (!world) return;
  if (world.frame === lastUpdateFrame) return;
  lastUpdateFrame = world.frame;

  const camera = world.camera;
  if (!camera) return;

  const camPos = camera.position;
  const lod1DistSq = resourceLOD.lod1DistanceSq;
  const lod2DistSq = resourceLOD.lod2DistanceSq;
  const hysteresisSq = 0.81;

  for (const pool of pools.values()) {
    for (const slot of pool.instances.values()) {
      const dx = camPos.x - slot.position.x;
      const dz = camPos.z - slot.position.z;
      const distSq = dx * dx + dz * dz;

      let targetLOD: 0 | 1 | 2;
      if (distSq < lod1DistSq * hysteresisSq) {
        targetLOD = 0;
      } else if (distSq < lod1DistSq) {
        targetLOD = slot.currentLOD === 0 ? 0 : pool.lod1 ? 1 : 0;
      } else if (distSq < lod2DistSq * hysteresisSq) {
        targetLOD = pool.lod1 ? 1 : 0;
      } else if (distSq < lod2DistSq) {
        if (slot.currentLOD <= 1) {
          targetLOD = pool.lod1 ? 1 : 0;
        } else {
          targetLOD = pool.lod2 ? 2 : pool.lod1 ? 1 : 0;
        }
      } else {
        targetLOD = pool.lod2 ? 2 : pool.lod1 ? 1 : 0;
      }

      if (targetLOD === slot.currentLOD) continue;

      const oldPool = getLodPool(pool, slot);
      const wasHl = oldPool ? isHighlighted(oldPool, slot.entityId) : false;
      // Read dissolve state from old pool's color before removing.
      // Safe to sample batches[0] only — applyDissolveColor sets all batches uniformly.
      // Defaults to 0 (fully visible) if instance IDs are missing — this edge case
      // can only occur if the entity wasn't fully added, which shouldn't happen in practice.
      let wasDissolveVal = 0;
      if (oldPool) {
        const oldIds = oldPool.instanceIds.get(slot.entityId);
        if (oldIds && oldIds.length > 0) {
          oldPool.batches[0].getColorAt(oldIds[0], _tmpColor);
          wasDissolveVal = Math.max(
            0,
            Math.min(DISSOLVE_MAX, 1.0 - _tmpColor.b),
          );
        }
        removeFromPool(oldPool, slot.entityId);
      }

      slot.currentLOD = targetLOD;

      const newPool = getLodPool(pool, slot);
      if (newPool) {
        const mat = composeInstanceMatrix(
          slot.position,
          slot.rotation,
          slot.scale,
          slot.yOffset,
        );
        addToPool(
          newPool,
          slot.entityId,
          mat,
          slot.variantIndex,
          wasDissolveVal,
          slot.snowWeight,
        );
        if (wasHl) applyHighlightColor(newPool, slot.entityId, true);
      }
    }
  }

  // Tick dissolve animations — runs AFTER LOD transitions above so that
  // applyDissolveValue always finds the entity in its current (post-swap) pool.
  tickDissolveAnims(dissolveAnims, deltaTime, applyDissolveValue);

  // ---- Per-instance frustum + distance culling ----
  // Build camera frustum once for all trees this frame.
  _cullProjScreenMatrix.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  _cullFrustum.setFromProjectionMatrix(_cullProjScreenMatrix);

  for (const pool of pools.values()) {
    for (const slot of pool.instances.values()) {
      const lodPool = getLodPool(pool, slot);
      if (!lodPool) continue;
      const ids = lodPool.instanceIds.get(slot.entityId);
      if (!ids) continue;

      // Quick distance check from camera (horizontal only, same as LOD loop).
      const dx = camPos.x - slot.position.x;
      const dz = camPos.z - slot.position.z;
      const distSq = dx * dx + dz * dz;

      let visible: boolean;
      if (distSq > TREE_MAX_RENDER_DIST_SQ) {
        // Beyond shader fade end — always invisible.
        visible = false;
      } else {
        // Frustum sphere test. Center at mid-height so tall canopies aren't culled
        // while the tree base is still just inside the frustum.
        _cullSphere.center.set(
          slot.position.x,
          slot.position.y + pool.modelHeight * slot.scale * 0.5,
          slot.position.z,
        );
        _cullSphere.radius =
          Math.max(pool.modelRadius, pool.modelHeight * 0.5) * slot.scale +
          TREE_CULL_SPHERE_BUFFER;
        visible = _cullFrustum.intersectsSphere(_cullSphere);
      }

      for (let i = 0; i < lodPool.batches.length; i++) {
        lodPool.batches[i].setVisibleAt(ids[i], visible);
      }
    }
  }

  // Update dissolve uniforms
  const camY = camPos.y;
  const players = world.getPlayers();
  const localPlayer = players && players.length > 0 ? players[0] : null;
  const playerPos = localPlayer?.node?.position ?? camPos;

  const env = world.getSystem("environment") as {
    sunLight?: { intensity: number };
    lightDirection?: THREE.Vector3;
    hemisphereLight?: { color: THREE.Color };
    getDayIntensity?: () => number;
  } | null;

  const wind = world.getSystem("wind") as Wind | null;

  for (const pool of pools.values()) {
    for (const lodPool of [pool.lod0, pool.lod1, pool.lod2]) {
      if (!lodPool) continue;

      for (const mat of lodPool.materials) {
        mat.dissolveUniforms.cameraPos.value.set(camPos.x, camY, camPos.z);
        mat.dissolveUniforms.playerPos.value.set(
          playerPos.x,
          playerPos.y,
          playerPos.z,
        );

        const treeMat = mat as TreeDissolveMaterial;
        if (treeMat.treeUniforms) {
          if (env?.lightDirection) {
            treeMat.treeUniforms.sunDirection.value
              .copy(env.lightDirection)
              .negate();
          }
          if (env?.sunLight) {
            treeMat.treeUniforms.sunIntensity.value = Math.min(
              env.sunLight.intensity,
              2.0,
            );
          }
          if (env?.getDayIntensity) {
            treeMat.treeUniforms.dayIntensity.value = env.getDayIntensity();
          }
          if (wind) {
            treeMat.treeUniforms.windTime.value = wind.uniforms.time.value;
            treeMat.treeUniforms.windStrength.value =
              wind.uniforms.windStrength.value;
            const wd = wind.uniforms.windDirection.value;
            treeMat.treeUniforms.windDirection.value.set(wd.x, wd.z);
          }
        }
      }
    }
  }
}
