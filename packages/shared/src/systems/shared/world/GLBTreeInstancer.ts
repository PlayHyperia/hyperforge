/**
 * GLBTreeInstancer - InstancedMesh-based rendering for GLB-loaded trees.
 *
 * Instead of cloning the full GLB scene per tree (which deep-copies all
 * geometry buffers and causes FPS drops), this module loads each model
 * once, extracts its geometry by reference, and renders all instances
 * of that model via a single THREE.InstancedMesh per LOD level.
 *
 * LOD0, LOD1, and LOD2 each get their own InstancedMesh. The instancer
 * performs distance-based LOD switching per-instance every frame by
 * moving instances between pools (matrix swaps + count adjustment).
 *
 * ResourceEntity calls addInstance/removeInstance/setDepleted. It does
 * NOT need to track whether it's instanced — those calls are safe no-ops
 * when the entity isn't registered.
 *
 * @module GLBTreeInstancer
 */

import THREE from "../../../extras/three/three";
import type { World } from "../../../core/World";
import { modelCache } from "../../../utils/rendering/ModelCache";
import { createStorageInstancedMesh } from "../../../utils/rendering/createStorageInstancedMesh";
import {
  createTreeDissolveMaterial,
  GPU_VEG_CONFIG,
  type DissolveMaterial,
  type TreeDissolveMaterial,
  type TreeMaterialOptions,
} from "./GPUMaterials";
import type { Wind } from "./Wind";
import {
  assertTreeWindInstanceMatrix,
  cloneGeometryWithTreeWind,
  deriveTreeWindDescriptor,
  type TreeWindDescriptor,
  type TreeWindMode,
  type TreeWindPoolOptions,
} from "./TreeWind";
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
const _swapMatrix = new THREE.Matrix4();

/** Optional exact actor lifetime; legacy callers may continue to omit it. */
export interface TreeInstanceLifetime {
  isCurrent(): boolean;
  /** Read at insertion, after shared model loading, to avoid a depletion flash. */
  getInitialDissolve(): number;
}

interface TreeSlot {
  entityId: string;
  lifetime?: TreeInstanceLifetime;
  position: THREE.Vector3;
  rotation: number;
  scale: number;
  yOffset: number;
  currentLOD: 0 | 1 | 2;
}

interface LODPool {
  readonly windMode: TreeWindMode;
  /** One InstancedMesh per sub-mesh/primitive in the GLB */
  meshes: THREE.InstancedMesh[];
  materials: DissolveMaterial[];
  /** entityId → slot index (same across all meshes) */
  slots: Map<string, number>;
  activeCount: number;
  dirty: boolean;
  /** True when dissolveData has changed and needs GPU upload */
  dissolveDirty: boolean;
  /** Shared backing array for per-instance highlight intensity (0 or 1) */
  highlightData: Float32Array;
  /** Shared backing array for per-instance dissolve progress (0 = visible, 1 = dissolved) */
  dissolveData: Float32Array;
  /**
   * Snapshot of original source geometries (before InstancedBufferAttribute
   * additions). Retained so collision proxies can use the model shape without
   * depending on live InstancedMesh geometry references.
   */
  sourceGeometries: THREE.BufferGeometry[];
}

interface ModelPool {
  readonly windMode: TreeWindMode;
  modelPath: string;
  lod0: LODPool | null;
  lod1: LODPool | null;
  lod2: LODPool | null;
  instances: Map<string, TreeSlot>;
  yOffset: number;
  /** Unscaled model height from bounding box */
  modelHeight: number;
  /** Unscaled model horizontal radius from bounding box */
  modelRadius: number;
}

const resourceLOD = getLODDistances("resource");

// ---- Module state ----
let scene: THREE.Scene | null = null;
let world: World | null = null;
let windMode: TreeWindMode = "legacy-leaf-v1";
let poolGeneration = 0;
const cancelledPoolLoad = new Error("Tree pool world lifetime ended");
const pools = new Map<string, ModelPool>();
const entityToModel = new Map<string, string>();
const pendingInstances = new Map<string, { lifetime?: TreeInstanceLifetime }>();

// ---- Geometry extraction (reference, not clone) ----

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

function createSharedGeometry(
  source: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  for (const name in source.attributes) {
    geo.setAttribute(name, source.attributes[name].clone());
  }
  if (source.index) geo.setIndex(source.index.clone());
  if (source.morphAttributes) {
    for (const name in source.morphAttributes) {
      geo.morphAttributes[name as keyof typeof source.morphAttributes] =
        source.morphAttributes[
          name as keyof typeof source.morphAttributes
        ]!.map((a) => a.clone());
    }
  }
  if (source.groups.length > 0) {
    for (const group of source.groups) {
      geo.addGroup(group.start, group.count, group.materialIndex);
    }
  }
  if (source.boundingBox) geo.boundingBox = source.boundingBox.clone();
  if (source.boundingSphere) geo.boundingSphere = source.boundingSphere.clone();
  return geo;
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
  return { yOffset: -bbox.min.y, height, radius: Math.max(dx, dz) };
}

// ---- LODPool creation ----

function createLODPool(
  parts: { geometry: THREE.BufferGeometry; material: DissolveMaterial }[],
  loadScene: THREE.Scene,
  poolWindMode: TreeWindMode,
  descriptor?: TreeWindDescriptor,
): LODPool {
  const meshes: THREE.InstancedMesh[] = [];
  const materials: DissolveMaterial[] = [];
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const sourceGeometries: THREE.BufferGeometry[] = [];
  const hlData = new Float32Array(MAX_INSTANCES);
  const dissolveData = new Float32Array(MAX_INSTANCES);
  try {
    for (const part of parts) {
      // Store the original geometry before adding instanced attributes
      sourceGeometries.push(part.geometry);

      const geo = descriptor
        ? cloneGeometryWithTreeWind(part.geometry, descriptor)
        : createSharedGeometry(part.geometry);
      ownedGeometries.push(geo);
      if (descriptor && !geo.hasAttribute("normal")) geo.computeVertexNormals();

      const hlAttr = new THREE.InstancedBufferAttribute(hlData, 1);
      hlAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("instanceHighlight", hlAttr);

      const dsAttr = new THREE.InstancedBufferAttribute(dissolveData, 1);
      dsAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("instanceDissolve", dsAttr);

      const im = createStorageInstancedMesh(geo, part.material, MAX_INSTANCES);
      meshes.push(im);
      im.count = 0;
      // Shader wind does not change CPU geometry bounds. Native mesh culling
      // stays disabled for every camera/pass; collision/model bounds stay static.
      im.frustumCulled = false;
      im.castShadow = true;
      im.receiveShadow = false;
      im.layers.set(1);
      loadScene.add(im);
      materials.push(part.material);
    }
  } catch (error) {
    for (const im of meshes) {
      im.removeFromParent();
      im.dispose();
    }
    for (const geo of ownedGeometries) geo.dispose();
    // Input materials transfer ownership to this function, including parts
    // whose geometry could not be admitted before pool construction failed.
    for (const material of new Set(parts.map((part) => part.material)))
      material.dispose();
    throw error;
  }
  return {
    windMode: poolWindMode,
    meshes,
    materials,
    slots: new Map(),
    activeCount: 0,
    dirty: false,
    dissolveDirty: false,
    highlightData: hlData,
    dissolveData,
    sourceGeometries,
  };
}

function disposeLODPool(pool: LODPool): void {
  for (const im of pool.meshes) {
    im.removeFromParent();
    im.geometry.dispose();
    im.dispose();
  }
  for (const material of new Set(pool.materials)) material.dispose();
  // These are borrowed ModelCache geometries, never disposal targets.
  pool.sourceGeometries.length = 0;
}

async function loadLODParts(
  path: string,
  loadWorld: World,
): Promise<MeshPart[] | null> {
  try {
    const { scene: lodScene } = await modelCache.loadModel(path, loadWorld);
    const parts = extractAllMeshParts(lodScene);
    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

// ---- Model pool lifecycle ----

const pendingEnsure = new Map<string, Promise<ModelPool>>();

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

async function ensureModelPool(
  modelPath: string,
  lod1ModelPath?: string | null,
  lod2ModelPath?: string | null,
): Promise<ModelPool> {
  const existing = pools.get(modelPath);
  if (existing) return existing;

  const pending = pendingEnsure.get(modelPath);
  if (pending) return pending;

  if (!world || !scene) throw cancelledPoolLoad;
  const loadWorld = world;
  const loadScene = scene;
  const poolWindMode = windMode;
  const generation = poolGeneration;
  const assertCurrent = () => {
    if (
      generation !== poolGeneration ||
      world !== loadWorld ||
      scene !== loadScene
    ) {
      throw cancelledPoolLoad;
    }
  };
  const loadParts = async (path: string) => {
    const parts = await loadLODParts(path, loadWorld);
    assertCurrent();
    return parts;
  };

  const promise = (async (): Promise<ModelPool> => {
    const dissolveOpts = {
      fadeStart: GPU_VEG_CONFIG.FADE_START,
      fadeEnd: GPU_VEG_CONFIG.FADE_END,
      enableNearFade: false,
      enableWaterCulling: false,
      enableOcclusionDissolve: false,
      enableRimHighlight: true,
    };

    function buildTreeParts(
      parts: MeshPart[],
    ): { geometry: THREE.BufferGeometry; material: DissolveMaterial }[] {
      const built: {
        geometry: THREE.BufferGeometry;
        material: DissolveMaterial;
      }[] = [];
      try {
        for (const p of parts) {
          const dm = createTreeDissolveMaterial(p.material, {
            ...dissolveOpts,
            treeWind: poolWindMode,
          } as TreeMaterialOptions);
          // Own the material immediately: setupMaterial/texture setup may throw.
          built.push({ geometry: p.geometry, material: dm });
          dm.side = THREE.DoubleSide;
          enableTextureRepeat(dm);
          loadWorld.setupMaterial(dm);
        }
        return built;
      } catch (error) {
        for (const part of built) part.material.dispose();
        throw error;
      }
    }

    // LOD0
    const { scene: lod0Scene } = await modelCache.loadModel(
      modelPath,
      loadWorld,
    );
    assertCurrent();
    const lod0Parts = extractAllMeshParts(lod0Scene);
    if (lod0Parts.length === 0)
      throw new Error(`No mesh found in ${modelPath}`);

    const bounds = computeModelBounds(lod0Scene, 1);
    const descriptor =
      poolWindMode === "connected-v1"
        ? deriveTreeWindDescriptor(
            [...new Set(lod0Parts.map((part) => part.geometry))],
            -bounds.yOffset,
          )
        : undefined;

    // The fixed broadcast viewport has no exploration traversal and keeps LOD0
    // available as the visual fallback. Avoid decoding and uploading distant
    // tree LOD pools during its critical startup window.
    const loadBackgroundLods = shouldStreamVegetationBackgroundLods();

    // LOD1 — explicit path first, fall back to inferred naming convention
    let lod1Parts: MeshPart[] | null = null;
    if (loadBackgroundLods && lod1ModelPath) {
      lod1Parts = await loadParts(lod1ModelPath);
    }
    if (loadBackgroundLods && !lod1Parts) {
      lod1Parts = await loadParts(inferLOD1Path(modelPath));
    }

    // LOD2 — explicit path first, fall back to inferred naming convention
    let lod2Parts: MeshPart[] | null = null;
    if (loadBackgroundLods && lod2ModelPath) {
      lod2Parts = await loadParts(lod2ModelPath);
    }
    if (loadBackgroundLods && !lod2Parts) {
      lod2Parts = await loadParts(inferLOD2Path(modelPath));
    }

    // Publish scene-owned resources only after every load is admitted. Teardown
    // during an LOD await cannot leave a partly built pool outside the registry.
    assertCurrent();
    const completedLods: LODPool[] = [];
    const buildLOD = (parts: MeshPart[]) => {
      const lod = createLODPool(
        buildTreeParts(parts),
        loadScene,
        poolWindMode,
        descriptor,
      );
      completedLods.push(lod);
      return lod;
    };
    try {
      const lod0Pool = buildLOD(lod0Parts);
      const lod1Pool = lod1Parts ? buildLOD(lod1Parts) : null;
      const lod2Pool = lod2Parts ? buildLOD(lod2Parts) : null;
      assertCurrent();

      const pool: ModelPool = {
        windMode: poolWindMode,
        modelPath,
        lod0: lod0Pool,
        lod1: lod1Pool,
        lod2: lod2Pool,
        instances: new Map(),
        yOffset: bounds.yOffset,
        modelHeight: bounds.height,
        modelRadius: bounds.radius,
      };
      pools.set(modelPath, pool);

      return pool;
    } catch (error) {
      for (const lod of completedLods) disposeLODPool(lod);
      throw error;
    }
  })();

  pendingEnsure.set(modelPath, promise);
  try {
    return await promise;
  } finally {
    if (pendingEnsure.get(modelPath) === promise)
      pendingEnsure.delete(modelPath);
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

function addToPool(
  pool: LODPool,
  entityId: string,
  mat: THREE.Matrix4,
  dissolve = 0,
): boolean {
  if (pool.windMode === "connected-v1") assertTreeWindInstanceMatrix(mat);
  if (pool.activeCount >= MAX_INSTANCES) return false;
  const idx = pool.activeCount;
  for (const im of pool.meshes) {
    im.setMatrixAt(idx, mat);
    im.count = idx + 1;
  }
  pool.slots.set(entityId, idx);
  pool.dissolveData[idx] = dissolve;
  if (dissolve > 0) pool.dissolveDirty = true;
  pool.activeCount++;
  pool.dirty = true;
  return true;
}

function removeFromPool(pool: LODPool, entityId: string): void {
  const idx = pool.slots.get(entityId);
  if (idx === undefined) return;

  const lastIdx = pool.activeCount - 1;
  if (idx !== lastIdx) {
    for (const im of pool.meshes) {
      im.getMatrixAt(lastIdx, _swapMatrix);
      im.setMatrixAt(idx, _swapMatrix);
    }
    pool.highlightData[idx] = pool.highlightData[lastIdx];
    pool.dissolveData[idx] = pool.dissolveData[lastIdx];

    for (const [eid, eidIdx] of pool.slots) {
      if (eidIdx === lastIdx) {
        pool.slots.set(eid, idx);
        break;
      }
    }
  }
  pool.highlightData[lastIdx] = 0;
  pool.dissolveData[lastIdx] = 0;

  pool.slots.delete(entityId);
  pool.activeCount--;
  for (const im of pool.meshes) {
    im.count = pool.activeCount;
  }
  pool.dirty = true;
  // Swap may have moved dissolve data to a different slot — flush to GPU
  pool.dissolveDirty = true;
}

// ---- Public API ----

export function initGLBTreeInstancer(
  s: THREE.Scene,
  w: World,
  options: TreeWindPoolOptions = {},
): void {
  const nextWindMode = options.windMode ?? "legacy-leaf-v1";
  if (nextWindMode !== "legacy-leaf-v1" && nextWindMode !== "connected-v1")
    throw new Error("Unsupported tree pool wind mode");
  if (
    (nextWindMode !== windMode || s !== scene || w !== world) &&
    (pools.size > 0 || pendingEnsure.size > 0 || pendingInstances.size > 0)
  )
    throw new Error("Tree pool owner or wind mode change requires teardown");
  poolGeneration++;
  scene = s;
  world = w;
  windMode = nextWindMode;
}

/**
 * NOTE: Caller must also call clearProxyGeometryCache() (from TreeGLBVisualStrategy)
 * after this to dispose cached proxy geometries that reference sourceGeometries.
 */
export function destroyGLBTreeInstancer(): void {
  poolGeneration++;
  for (const pool of pools.values()) {
    for (const lodPool of [pool.lod0, pool.lod1, pool.lod2]) {
      if (!lodPool) continue;
      disposeLODPool(lodPool);
    }
  }
  pools.clear();
  entityToModel.clear();
  pendingInstances.clear();
  pendingEnsure.clear();
  dissolveAnims.clear();
  scene = null;
  world = null;
  windMode = "legacy-leaf-v1";
  highlightedEntityId = null;
  lastUpdateFrame = -1;
}

export async function addInstance(
  modelPath: string,
  entityId: string,
  position: THREE.Vector3,
  rotation: number,
  scale: number,
  lod1ModelPath?: string | null,
  lod2ModelPath?: string | null,
  initialDissolve = 0,
  lifetime?: TreeInstanceLifetime,
): Promise<boolean> {
  if (!scene || !world || (lifetime && !lifetime.isCurrent())) return false;
  const instanceWorld = world;
  const instanceScene = scene;
  const generation = poolGeneration;

  const request = { lifetime };

  try {
    // Reject malformed connected transforms before replacing even a pending
    // request. The real model offset is validated again after model admission.
    if (windMode === "connected-v1") {
      assertTreeWindInstanceMatrix(
        composeInstanceMatrix(position, rotation, scale, 0),
      );
    }
    pendingInstances.set(entityId, request);
    const pool = await ensureModelPool(modelPath, lod1ModelPath, lod2ModelPath);
    if (
      pendingInstances.get(entityId) !== request ||
      world !== instanceWorld ||
      scene !== instanceScene ||
      generation !== poolGeneration ||
      (lifetime && !lifetime.isCurrent())
    )
      return false;

    const mat = composeInstanceMatrix(position, rotation, scale, pool.yOffset);
    if (pool.windMode === "connected-v1") assertTreeWindInstanceMatrix(mat);

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

    const slot: TreeSlot = {
      entityId,
      lifetime,
      position: position.clone(),
      rotation,
      scale,
      yOffset: pool.yOffset,
      currentLOD: initialLOD,
    };

    const initialPool =
      initialLOD === 0 ? pool.lod0 : initialLOD === 1 ? pool.lod1 : pool.lod2;
    if (!initialPool) return false;
    if (
      initialPool.activeCount >= MAX_INSTANCES &&
      !initialPool.slots.has(entityId)
    ) {
      console.warn(
        `[GLBTreeInstancer] LOD${initialLOD} pool full for ${modelPath}, cannot add ${entityId}`,
      );
      return false;
    }

    // No await from admission through insertion. A replacement keeps its old
    // actor until the target LOD, capacity and transform have all been admitted.
    // Replacing within a full same-LOD pool reuses the actor's existing slot.
    const insertionDissolve = lifetime?.getInitialDissolve() ?? initialDissolve;
    removeInstance(entityId);
    if (!addToPool(initialPool, entityId, mat, insertionDissolve)) return false;

    pool.instances.set(entityId, slot);
    entityToModel.set(entityId, modelPath);
    return true;
  } catch (error) {
    if (error === cancelledPoolLoad) return false;
    console.warn(
      `[GLBTreeInstancer] Failed to add instance ${entityId}:`,
      error,
    );
    return false;
  } finally {
    if (pendingInstances.get(entityId) === request)
      pendingInstances.delete(entityId);
  }
}

export function removeInstance(
  entityId: string,
  lifetime?: TreeInstanceLifetime,
): void {
  const pending = pendingInstances.get(entityId);
  if (pending && (!lifetime || pending.lifetime === lifetime)) {
    pendingInstances.delete(entityId);
  }
  const modelPath = entityToModel.get(entityId);
  if (!modelPath) return;

  const pool = pools.get(modelPath);
  if (!pool) return;

  const slot = pool.instances.get(entityId);
  if (!slot || (lifetime && slot.lifetime !== lifetime)) return;

  const lodPool =
    slot.currentLOD === 0
      ? pool.lod0
      : slot.currentLOD === 1
        ? pool.lod1
        : pool.lod2;
  if (lodPool) removeFromPool(lodPool, entityId);

  pool.instances.delete(entityId);
  entityToModel.delete(entityId);
  dissolveAnims.delete(entityId);
}

export function hasInstance(
  entityId: string,
  lifetime?: TreeInstanceLifetime,
): boolean {
  const path = entityToModel.get(entityId);
  if (!path) return false;
  return (
    !lifetime || pools.get(path)?.instances.get(entityId)?.lifetime === lifetime
  );
}

/**
 * Returns static, unscaled model dimensions for an instanced entity.
 * Used to size collision proxies to match the actual model.
 * These are not the wind-swept visual envelope; native mesh culling is disabled.
 */
export function getModelDimensions(
  entityId: string,
): { height: number; radius: number } | null {
  const modelPath = entityToModel.get(entityId);
  if (!modelPath) return null;
  const pool = pools.get(modelPath);
  if (!pool) return null;
  return { height: pool.modelHeight, radius: pool.modelRadius };
}

/**
 * Returns the lowest-available LOD geometries for use as a collision proxy,
 * plus the yOffset needed to align the geometry with the visual instance.
 * Prefers LOD2 → LOD1 → LOD0.  Returns null if the entity isn't registered.
 *
 * NOTE: This instancer uses a single model per pool (no variants).
 * If multi-variant support is ever added, this must select by variant index
 * like GLBTreeBatchedInstancer.getProxyGeometry does.
 *
 * **Important**: Returned geometries are shared by the instancer pool.
 * Callers MUST clone before mutating (e.g. scaling).
 */
export function getProxyGeometry(
  entityId: string,
): { geometries: THREE.BufferGeometry[]; yOffset: number } | null {
  const modelPath = entityToModel.get(entityId);
  if (!modelPath) return null;
  const pool = pools.get(modelPath);
  if (!pool) return null;
  const lodPool = pool.lod2 ?? pool.lod1 ?? pool.lod0;
  if (!lodPool) return null;
  return {
    geometries: lodPool.sourceGeometries,
    yOffset: pool.yOffset,
  };
}

/** Track which entity is currently highlighted so we can clear it */
let highlightedEntityId: string | null = null;

/**
 * Set or clear shader-based rim highlight for an instanced tree entity.
 * Sets the per-instance `instanceHighlight` attribute to 1 or 0.
 */
export function setHighlight(entityId: string, on: boolean): void {
  if (on && highlightedEntityId && highlightedEntityId !== entityId) {
    setHighlight(highlightedEntityId, false);
  }

  const modelPath = entityToModel.get(entityId);
  if (!modelPath) return;

  const pool = pools.get(modelPath);
  if (!pool) return;

  const slot = pool.instances.get(entityId);
  if (!slot) return;

  const lodPool =
    slot.currentLOD === 0
      ? pool.lod0
      : slot.currentLOD === 1
        ? pool.lod1
        : pool.lod2;
  if (!lodPool) return;

  const idx = lodPool.slots.get(entityId);
  if (idx === undefined) return;

  const value = on ? 1.0 : 0.0;
  lodPool.highlightData[idx] = value;
  for (const im of lodPool.meshes) {
    const attr = im.geometry.getAttribute("instanceHighlight");
    if (attr) {
      (attr as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  highlightedEntityId = on ? entityId : null;
}

/**
 * Clear any active shader highlight (e.g. when hover leaves all entities).
 */
export function clearHighlight(): void {
  if (highlightedEntityId) {
    setHighlight(highlightedEntityId, false);
  }
}

// ---- Dissolve (tree depletion/respawn) ----

const dissolveAnims = new Map<string, DissolveAnim>();

function applyDissolveValue(entityId: string, value: number): void {
  const modelPath = entityToModel.get(entityId);
  if (!modelPath) return;

  const pool = pools.get(modelPath);
  if (!pool) return;

  const slot = pool.instances.get(entityId);
  if (!slot) return;

  // Use slot.currentLOD for O(1) pool lookup instead of searching all 3 pools.
  const lodPool =
    slot.currentLOD === 0
      ? pool.lod0
      : slot.currentLOD === 1
        ? pool.lod1
        : pool.lod2;
  if (!lodPool) return;

  const idx = lodPool.slots.get(entityId);
  if (idx === undefined) return;

  if (lodPool.dissolveData[idx] === value) return;
  lodPool.dissolveData[idx] = value;
  lodPool.dissolveDirty = true;
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

export function updateGLBTreeInstancer(deltaTime: number): void {
  if (!world) return;
  if (world.frame === lastUpdateFrame) return;
  lastUpdateFrame = world.frame;

  const camera = world.camera;
  if (!camera) return;

  const camPos = camera.position;
  const lod1DistSq = resourceLOD.lod1DistanceSq;
  const lod2DistSq = resourceLOD.lod2DistanceSq;
  const hysteresisSq = 0.81; // 0.9^2

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

      // Move instance between LOD pools
      const oldPool =
        slot.currentLOD === 0
          ? pool.lod0
          : slot.currentLOD === 1
            ? pool.lod1
            : pool.lod2;
      const newPool =
        targetLOD === 0 ? pool.lod0 : targetLOD === 1 ? pool.lod1 : pool.lod2;

      let wasHighlighted = 0;
      let wasDissolve = 0;
      if (oldPool && oldPool.slots.has(slot.entityId)) {
        const oldIdx = oldPool.slots.get(slot.entityId)!;
        wasHighlighted = oldPool.highlightData[oldIdx];
        wasDissolve = oldPool.dissolveData[oldIdx];
      }
      const mat = composeInstanceMatrix(
        slot.position,
        slot.rotation,
        slot.scale,
        slot.yOffset,
      );
      // Validate/admit the destination before releasing the visible source.
      // A full destination must not orphan an instance during LOD migration.
      if (!newPool || !addToPool(newPool, slot.entityId, mat, wasDissolve))
        continue;
      if (oldPool) removeFromPool(oldPool, slot.entityId);
      if (wasHighlighted > 0) {
        const newIdx = newPool.slots.get(slot.entityId);
        if (newIdx !== undefined) {
          newPool.highlightData[newIdx] = wasHighlighted;
          for (const im of newPool.meshes) {
            const attr = im.geometry.getAttribute("instanceHighlight");
            if (attr)
              (attr as THREE.InstancedBufferAttribute).needsUpdate = true;
          }
        }
      }
      slot.currentLOD = targetLOD;
    }
  }

  // Tick dissolve animations — runs AFTER LOD transitions above so that
  // applyDissolveValue always finds the entity in its current (post-swap) pool.
  tickDissolveAnims(dissolveAnims, deltaTime, applyDissolveValue);

  // Flush dirty pools + update dissolve uniforms
  const camY = camPos.y;
  const players = world.getPlayers();
  const localPlayer = players && players.length > 0 ? players[0] : null;
  const playerPos = localPlayer?.node?.position ?? camPos;

  // Get sun direction from Environment system
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

      if (lodPool.dirty) {
        for (const im of lodPool.meshes) {
          im.instanceMatrix.needsUpdate = true;
        }
        lodPool.dirty = false;
      }

      if (lodPool.dissolveDirty) {
        for (const im of lodPool.meshes) {
          const attr = im.geometry.getAttribute("instanceDissolve");
          if (attr) (attr as THREE.InstancedBufferAttribute).needsUpdate = true;
        }
        lodPool.dissolveDirty = false;
      }

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
