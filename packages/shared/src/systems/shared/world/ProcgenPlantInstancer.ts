/**
 * ProcgenPlantInstancer - Instanced Rendering for Procedural Plants
 *
 * Handles LOD transitions and instanced rendering for procedurally generated plants.
 * Plants are smaller than trees/rocks, so they use closer LOD distances.
 *
 * LOD Levels:
 * - LOD0 (0-30m): Full detail plant
 * - LOD1 (30-60m): Simplified plant
 * - LOD2 (60-100m): Cross-billboard cards
 * - Impostor (100-150m): Atlased octahedral billboard (16 shared slots with rocks)
 * - Culled (150m+): Not rendered
 *
 * Features:
 * - Cross-fade LOD transitions with screen-space dithering
 * - Per-preset instanced meshes
 * - Atlased impostor system (16 slots shared with rocks - if exceeded, no impostor)
 */

import THREE from "../../../extras/three/three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { World } from "../../../core/World";
import { AtlasedRockPlantImpostorManager } from "../rendering/AtlasedRockPlantImpostorManager";
import {
  getPlantVariant,
  ensurePlantVariantsLoaded,
} from "./ProcgenPlantCache";

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * TEMPORARY: Disable all plant impostors.
 * When true, plants use GPU dissolve fade instead of impostor billboards.
 * Set to false to re-enable impostor system.
 */
const DISABLE_IMPOSTORS = true;

const MAX_INSTANCES_PER_PRESET = 300;
const LOD_FADE_MS = 200;
const LOD_UPDATE_MS = 100;
const LOD_UPDATES_PER_FRAME = 40;
const HYSTERESIS_SQ = 9; // 3m buffer

const LOD_DIST = { lod1: 30, lod2: 60, impostor: 100, cull: 150 };
const LOD_DIST_SQ = {
  lod1: LOD_DIST.lod1 ** 2,
  lod2: LOD_DIST.lod2 ** 2,
  impostor: LOD_DIST.impostor ** 2,
  cull: LOD_DIST.cull ** 2,
};

// ============================================================================
// TYPES
// ============================================================================

interface PlantInstance {
  id: string;
  presetName: string;
  position: THREE.Vector3;
  rotation: number;
  scale: number;
  currentLOD: number;
  lodIndices: [number, number, number]; // LOD0, LOD1, LOD2 (impostor handled by atlas)
  hasImpostorSlot: boolean; // Whether this preset got an impostor slot
  transition: { from: number; to: number; start: number } | null;
  radius: number;
}

interface MeshData {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  mesh: THREE.InstancedMesh;
  fadeAttr: THREE.InstancedBufferAttribute;
  idxToId: Map<number, string>;
  freeIndices: number[]; // Recycled indices available for reuse
  nextIdx: number;
  count: number;
  dirty: boolean;
}

interface PresetMeshes {
  lod0: MeshData | null;
  lod1: MeshData | null;
  lod2: MeshData | null;
  /** Whether this preset has an impostor slot in the atlased manager */
  hasImpostorSlot: boolean;
  dimensions: { width: number; height: number; depth: number };
  leafColor: THREE.Color;
}

type LODKey = "lod0" | "lod1" | "lod2";

/** LOD key lookup array to avoid repeated array allocations */
const LOD_KEYS: readonly LODKey[] = ["lod0", "lod1", "lod2"] as const;

// ============================================================================
// GEOMETRY MERGING (for instancing)
// ============================================================================

interface MergedPlantGeometry {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
}

interface MaterialBucket {
  material: THREE.Material;
  geometries: THREE.BufferGeometry[];
}

function ensureColorAttribute(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute("color")) return;
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return;

  const colors = new Float32Array(posAttr.count * 3);
  colors.fill(1);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function bakeMeshGeometry(mesh: THREE.Mesh): THREE.BufferGeometry | null {
  if (!mesh.geometry) return null;
  const baked = mesh.geometry.clone();
  baked.applyMatrix4(mesh.matrixWorld);

  const nonIndexed = baked.index ? baked.toNonIndexed() : baked;
  if (nonIndexed !== baked) {
    baked.dispose();
  }

  ensureColorAttribute(nonIndexed);
  return nonIndexed;
}

function mergeGeometryBuckets(
  buckets: MaterialBucket[],
): MergedPlantGeometry | null {
  if (buckets.length === 0) return null;

  const mergedGeometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  for (const bucket of buckets) {
    const merged =
      bucket.geometries.length > 1
        ? mergeGeometries(bucket.geometries, false)
        : bucket.geometries[0];
    const mergedGeometry = merged ?? bucket.geometries[0];

    for (const geometry of bucket.geometries) {
      if (geometry !== mergedGeometry) {
        geometry.dispose();
      }
    }

    mergedGeometry.computeBoundingBox();
    mergedGeometry.computeBoundingSphere();
    mergedGeometries.push(mergedGeometry);
    materials.push(bucket.material);
  }

  if (mergedGeometries.length === 1) {
    return { geometry: mergedGeometries[0], materials };
  }

  const combined = mergeGeometries(mergedGeometries, true);
  if (!combined) {
    console.warn(
      "[ProcgenPlantInstancer] mergeGeometries returned null; using first material geometry only",
    );
    for (let i = 1; i < mergedGeometries.length; i++) {
      mergedGeometries[i].dispose();
    }
    return { geometry: mergedGeometries[0], materials: [materials[0]] };
  }

  for (const geometry of mergedGeometries) {
    geometry.dispose();
  }

  combined.computeBoundingBox();
  combined.computeBoundingSphere();
  return { geometry: combined, materials };
}

/**
 * Merge a plant group into a single geometry for instancing.
 * Exposed for testing the instanced-geometry path.
 */
export function mergePlantGroupForInstancing(
  group: THREE.Group,
): MergedPlantGeometry | null {
  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => {
    // Procgen builds its geometry with Three's core entry point while the
    // renderer imports the WebGPU entry point. Those entry points can expose
    // distinct runtime constructors even though they share the same Object3D
    // contract, so `instanceof THREE.Mesh` incorrectly rejects valid meshes.
    // `isMesh` is Three's cross-module runtime discriminator.
    if ((child as THREE.Mesh).isMesh === true) {
      meshes.push(child as THREE.Mesh);
    }
  });

  if (meshes.length === 0) return null;

  group.updateWorldMatrix(true, true);

  const buckets: MaterialBucket[] = [];
  const bucketMap = new Map<THREE.Material, THREE.BufferGeometry[]>();
  let warnedMultiMaterial = false;

  for (const mesh of meshes) {
    const materialRef = mesh.material;
    if (Array.isArray(materialRef)) {
      if (!warnedMultiMaterial) {
        console.warn(
          "[ProcgenPlantInstancer] Multi-material mesh detected; using first material for merge",
        );
        warnedMultiMaterial = true;
      }
    }

    const material = Array.isArray(materialRef) ? materialRef[0] : materialRef;
    if (!material) continue;

    const baked = bakeMeshGeometry(mesh);
    if (!baked) continue;

    let geometries = bucketMap.get(material);
    if (!geometries) {
      geometries = [];
      bucketMap.set(material, geometries);
      buckets.push({ material, geometries });
    }
    geometries.push(baked);
  }

  return mergeGeometryBuckets(buckets);
}

// ============================================================================
// PLANT INSTANCER CLASS
// ============================================================================

export class ProcgenPlantInstancer {
  private static instance: ProcgenPlantInstancer | null = null;

  private world: World;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private atlasedImpostorManager: AtlasedRockPlantImpostorManager;

  private instances: Map<string, PlantInstance> = new Map();
  private presetMeshes: Map<string, PresetMeshes> = new Map();

  private lastUpdate = 0;
  private updateQueue: string[] = [];
  private updateIndex = 0;

  private tempMatrix = new THREE.Matrix4();
  private tempPosition = new THREE.Vector3();
  private tempQuat = new THREE.Quaternion();
  private tempScale = new THREE.Vector3();

  // Lighting sync for impostors
  private _lastLightUpdate = 0;
  private _lightDir = new THREE.Vector3(0.5, 0.8, 0.3);
  private _lightColor = new THREE.Vector3(1, 1, 1);
  private _ambientColor = new THREE.Vector3(0.3, 0.35, 0.4);
  private _lightingLoggedOnce = false;

  private constructor(world: World) {
    this.world = world;
    this.scene = world.stage?.scene as THREE.Scene;
    this.camera = world.camera;
    this.atlasedImpostorManager =
      AtlasedRockPlantImpostorManager.getInstance(world);
    // Initialize the atlased manager
    void this.atlasedImpostorManager.init();
  }

  /**
   * Get or create the singleton instancer.
   */
  static getInstance(world: World | null): ProcgenPlantInstancer | null {
    if (!world) return ProcgenPlantInstancer.instance;
    if (!ProcgenPlantInstancer.instance) {
      ProcgenPlantInstancer.instance = new ProcgenPlantInstancer(world);
    }
    return ProcgenPlantInstancer.instance;
  }

  /**
   * Add a plant instance.
   */
  async addInstance(
    id: string,
    presetName: string,
    position: THREE.Vector3,
    rotation: number,
    scale: number,
  ): Promise<void> {
    await this.ensurePresetLoaded(presetName);

    const presetData = this.presetMeshes.get(presetName);
    if (!presetData) {
      console.warn(`[ProcgenPlantInstancer] Preset ${presetName} not loaded`);
      return;
    }

    const radius =
      Math.max(presetData.dimensions.width, presetData.dimensions.depth) *
      scale *
      0.5;

    const instance: PlantInstance = {
      id,
      presetName,
      position: position.clone(),
      rotation,
      scale,
      currentLOD: 4,
      lodIndices: [-1, -1, -1], // LOD0, LOD1, LOD2 (impostor handled by atlas)
      hasImpostorSlot: presetData.hasImpostorSlot,
      transition: null,
      radius,
    };

    this.instances.set(id, instance);

    const distSq = this.camera.position.distanceToSquared(position);
    const targetLOD = this.getLODForDistance(distSq, instance.hasImpostorSlot);

    await this.setInstanceLOD(instance, targetLOD, false);
    this.updateQueue.push(id);
  }

  /**
   * Remove a plant instance.
   * @returns true if instance was found and removed, false otherwise
   */
  removeInstance(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;

    this.removeFromLODMesh(instance, 0);
    this.removeFromLODMesh(instance, 1);
    this.removeFromLODMesh(instance, 2);

    // Remove from atlased impostor manager
    if (instance.hasImpostorSlot && instance.currentLOD === 3) {
      this.atlasedImpostorManager.removeInstance(id);
    }

    this.instances.delete(id);

    const queueIdx = this.updateQueue.indexOf(id);
    if (queueIdx !== -1) {
      this.updateQueue.splice(queueIdx, 1);
    }

    return true;
  }

  /**
   * Update LOD levels based on camera position.
   */
  update(_deltaTime: number): void {
    if (!this.camera) return;

    // Always update atlased impostor manager (billboarding, view sampling)
    // and sync lighting - these must happen every frame
    this.atlasedImpostorManager.update(this.camera);
    this.syncImpostorLighting();

    const now = performance.now();

    if (now - this.lastUpdate < LOD_UPDATE_MS) {
      this.updateTransitions(now);
      return;
    }
    this.lastUpdate = now;

    const batchSize = Math.min(LOD_UPDATES_PER_FRAME, this.updateQueue.length);
    if (batchSize === 0) return;

    for (let i = 0; i < batchSize; i++) {
      const idx = (this.updateIndex + i) % this.updateQueue.length;
      const id = this.updateQueue[idx];
      const instance = this.instances.get(id);

      if (instance) {
        const distSq = this.camera.position.distanceToSquared(
          instance.position,
        );
        const targetLOD = this.getLODForDistanceWithHysteresis(
          instance,
          distSq,
        );

        if (targetLOD !== instance.currentLOD && !instance.transition) {
          this.startLODTransition(instance, targetLOD, now);
        }
      }
    }

    this.updateIndex =
      (this.updateIndex + batchSize) % Math.max(1, this.updateQueue.length);
    this.updateTransitions(now);
    this.commitDirtyMeshes();

    // Update atlased impostor manager (handles billboarding and view sampling)
    this.atlasedImpostorManager.update(this.camera);
  }

  /**
   * Ensure a preset's meshes are loaded.
   */
  private async ensurePresetLoaded(presetName: string): Promise<void> {
    if (this.presetMeshes.has(presetName)) return;

    await ensurePlantVariantsLoaded(presetName);

    const variant = getPlantVariant(presetName, 0);
    if (!variant) {
      console.warn(
        `[ProcgenPlantInstancer] Failed to get variant for ${presetName}`,
      );
      return;
    }

    const presetData: PresetMeshes = {
      lod0: null,
      lod1: null,
      lod2: null,
      hasImpostorSlot: false,
      dimensions: variant.dimensions,
      leafColor: variant.leafColor,
    };

    // Merge plant group into a single instanced geometry
    const lod0Merged = mergePlantGroupForInstancing(variant.group);
    if (lod0Merged) {
      presetData.lod0 = this.createLODMesh(
        lod0Merged.geometry,
        lod0Merged.materials.length === 1
          ? lod0Merged.materials[0]
          : lod0Merged.materials,
        `Plant_${presetName}_LOD0`,
      );
    }

    // LOD1
    if (variant.lod1Group) {
      const lod1Merged = mergePlantGroupForInstancing(variant.lod1Group);
      if (lod1Merged) {
        presetData.lod1 = this.createLODMesh(
          lod1Merged.geometry,
          lod1Merged.materials.length === 1
            ? lod1Merged.materials[0]
            : lod1Merged.materials,
          `Plant_${presetName}_LOD1`,
        );
      }
    }

    // LOD2 - card group
    if (variant.lod2Group) {
      const cardMesh = variant.lod2Group.children[0] as THREE.Mesh;
      if (cardMesh) {
        presetData.lod2 = this.createLODMesh(
          cardMesh.geometry,
          cardMesh.material as THREE.Material,
          `Plant_${presetName}_LOD2`,
        );
      }
    }

    // Register with atlased impostor manager (may fail if all 16 slots full)
    // Skip when DISABLE_IMPOSTORS is true - plants fade out via GPU dissolve shader
    if (!DISABLE_IMPOSTORS && lod0Merged) {
      const lod0Material =
        lod0Merged.materials.length === 1
          ? lod0Merged.materials[0]
          : lod0Merged.materials;
      const lod0Mesh = new THREE.Mesh(lod0Merged.geometry, lod0Material);
      presetData.hasImpostorSlot =
        await this.atlasedImpostorManager.registerPreset(
          presetName,
          "plant",
          lod0Mesh,
        );

      if (!presetData.hasImpostorSlot) {
        console.warn(
          `[ProcgenPlantInstancer] No impostor slot for ${presetName} - will cull at impostor distance`,
        );
      }
    }

    this.presetMeshes.set(presetName, presetData);
  }

  /**
   * Create an instanced mesh for a LOD level.
   */
  private createLODMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    name: string,
  ): MeshData {
    const mesh = new THREE.InstancedMesh(
      geometry,
      material,
      MAX_INSTANCES_PER_PRESET,
    );
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const fades = new Float32Array(MAX_INSTANCES_PER_PRESET).fill(1);
    const fadeAttr = new THREE.InstancedBufferAttribute(fades, 1);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute("instanceFade", fadeAttr);

    this.scene.add(mesh);

    return {
      geometry,
      material,
      mesh,
      fadeAttr,
      idxToId: new Map(),
      freeIndices: [],
      nextIdx: 0,
      count: 0,
      dirty: false,
    };
  }

  /**
   * Get target LOD for distance squared.
   * Forces impostor mode (LOD 3) when rendering for reflection camera.
   * If no impostor slot, culls at impostor distance.
   *
   * NOTE: When DISABLE_IMPOSTORS is true, skip impostor LOD - plants fade out via GPU dissolve shader.
   */
  private getLODForDistance(distSq: number, hasImpostorSlot: boolean): number {
    // When DISABLE_IMPOSTORS is true, skip impostor stage - use dissolve fade instead
    if (DISABLE_IMPOSTORS) {
      if (distSq >= LOD_DIST_SQ.impostor) return 4; // Cull at impostor distance
      if (distSq >= LOD_DIST_SQ.lod2) return 2;
      if (distSq >= LOD_DIST_SQ.lod1) return 1;
      return 0;
    }

    // Force impostor mode when rendering for reflection camera (performance)
    if (this.world.isRenderingReflection) {
      return hasImpostorSlot ? 3 : 4; // Cull if no impostor slot
    }
    if (distSq >= LOD_DIST_SQ.cull) return 4;
    if (distSq >= LOD_DIST_SQ.impostor) {
      // If no impostor slot, cull instead of showing impostor
      return hasImpostorSlot ? 3 : 4;
    }
    if (distSq >= LOD_DIST_SQ.lod2) return 2;
    if (distSq >= LOD_DIST_SQ.lod1) return 1;
    return 0;
  }

  /**
   * Get target LOD with hysteresis.
   */
  private getLODForDistanceWithHysteresis(
    instance: PlantInstance,
    distSq: number,
  ): number {
    const targetLOD = this.getLODForDistance(distSq, instance.hasImpostorSlot);
    const currentLOD = instance.currentLOD;

    if (targetLOD < currentLOD) return targetLOD;

    if (targetLOD > currentLOD) {
      const thresholds = [
        0,
        LOD_DIST_SQ.lod1,
        LOD_DIST_SQ.lod2,
        LOD_DIST_SQ.impostor,
        LOD_DIST_SQ.cull,
      ];
      const threshold = thresholds[currentLOD + 1] ?? LOD_DIST_SQ.cull;
      if (distSq > threshold + HYSTERESIS_SQ) {
        return targetLOD;
      }
    }

    return currentLOD;
  }

  /**
   * Start a LOD transition.
   * Note: setInstanceLOD is synchronous in practice since preset is already loaded.
   */
  private startLODTransition(
    instance: PlantInstance,
    targetLOD: number,
    now: number,
  ): void {
    instance.transition = {
      from: instance.currentLOD,
      to: targetLOD,
      start: now,
    };

    // Safe to not await: preset is already loaded during addInstance
    void this.setInstanceLOD(instance, targetLOD, true);
  }

  /**
   * Update all active transitions.
   */
  private updateTransitions(now: number): void {
    for (const instance of this.instances.values()) {
      if (!instance.transition) continue;

      const elapsed = now - instance.transition.start;
      const progress = Math.min(1, elapsed / LOD_FADE_MS);

      if (progress >= 1) {
        // Transition complete - remove from old LOD
        const fromLOD = instance.transition.from;
        if (fromLOD < 3) {
          this.removeFromLODMesh(instance, fromLOD);
        } else if (fromLOD === 3 && instance.hasImpostorSlot) {
          // Remove from atlased impostor manager
          this.atlasedImpostorManager.removeInstance(instance.id);
        }
        this.setInstanceFade(instance, instance.currentLOD, 1);
        instance.transition = null;
      } else {
        // Update fades (only for LOD0-2, impostor doesn't support fade)
        if (instance.transition.from < 3) {
          this.setInstanceFade(
            instance,
            instance.transition.from,
            1 - progress,
          );
        }
        if (instance.transition.to < 3) {
          this.setInstanceFade(instance, instance.transition.to, progress);
        }
      }
    }
  }

  /**
   * Set instance to a specific LOD level.
   */
  private async setInstanceLOD(
    instance: PlantInstance,
    lod: number,
    fadeIn: boolean,
  ): Promise<void> {
    const presetData = this.presetMeshes.get(instance.presetName);
    if (!presetData) return;

    instance.currentLOD = lod;

    if (lod === 4) {
      return;
    }

    const meshKey = lod < 3 ? LOD_KEYS[lod] : null;

    if (lod < 3 && meshKey) {
      const meshData = presetData[meshKey];
      if (meshData) {
        const idx = this.addToMesh(meshData, instance.id);
        instance.lodIndices[lod] = idx;

        this.tempPosition.copy(instance.position);
        this.tempQuat.setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          instance.rotation,
        );
        this.tempScale.set(instance.scale, instance.scale, instance.scale);
        this.tempMatrix.compose(
          this.tempPosition,
          this.tempQuat,
          this.tempScale,
        );

        meshData.mesh.setMatrixAt(idx, this.tempMatrix);
        meshData.fadeAttr.setX(idx, fadeIn ? 0 : 1);
        meshData.fadeAttr.needsUpdate = true;
        meshData.mesh.instanceMatrix.needsUpdate = true;
        meshData.dirty = true;
      }
    } else if (lod === 3 && instance.hasImpostorSlot) {
      // Impostor - add to atlased manager
      this.atlasedImpostorManager.addInstance(
        instance.presetName,
        instance.id,
        instance.position,
        instance.rotation,
        instance.scale,
      );
    }
  }

  /**
   * Set fade value for an instance at a specific LOD.
   */
  private setInstanceFade(
    instance: PlantInstance,
    lod: number,
    fade: number,
  ): void {
    if (lod >= 3) return; // Impostor handled by atlased manager
    const presetData = this.presetMeshes.get(instance.presetName);
    if (!presetData) return;

    const idx = instance.lodIndices[lod];
    if (idx < 0) return;

    const meshData = presetData[LOD_KEYS[lod]];
    if (meshData && idx < meshData.fadeAttr.count) {
      meshData.fadeAttr.setX(idx, fade);
      meshData.fadeAttr.needsUpdate = true;
      meshData.dirty = true;
    }
  }

  /**
   * Add instance to a mesh's buffer, reusing freed indices when available.
   */
  private addToMesh(meshData: MeshData, id: string): number {
    const idx =
      meshData.freeIndices.length > 0
        ? meshData.freeIndices.pop()!
        : meshData.nextIdx++;

    meshData.idxToId.set(idx, id);
    meshData.count = Math.max(meshData.count, idx + 1);
    meshData.mesh.count = meshData.count;
    return idx;
  }

  /**
   * Remove instance from a LOD mesh, recycling its index.
   */
  private removeFromLODMesh(instance: PlantInstance, lod: number): void {
    if (lod >= 3) return; // Impostor handled by atlased manager
    const idx = instance.lodIndices[lod];
    if (idx < 0) return;

    const presetData = this.presetMeshes.get(instance.presetName);
    if (!presetData) return;

    const meshData = presetData[LOD_KEYS[lod]];
    if (meshData) {
      this.tempMatrix.makeScale(0, 0, 0);
      meshData.mesh.setMatrixAt(idx, this.tempMatrix);
      meshData.mesh.instanceMatrix.needsUpdate = true;
      meshData.idxToId.delete(idx);
      meshData.freeIndices.push(idx); // Recycle the index
      meshData.dirty = true;
    }

    instance.lodIndices[lod] = -1;
  }

  /**
   * Commit changes to dirty meshes.
   */
  private commitDirtyMeshes(): void {
    for (const presetData of this.presetMeshes.values()) {
      if (presetData.lod0?.dirty) {
        presetData.lod0.mesh.instanceMatrix.needsUpdate = true;
        presetData.lod0.dirty = false;
      }
      if (presetData.lod1?.dirty) {
        presetData.lod1.mesh.instanceMatrix.needsUpdate = true;
        presetData.lod1.dirty = false;
      }
      if (presetData.lod2?.dirty) {
        presetData.lod2.mesh.instanceMatrix.needsUpdate = true;
        presetData.lod2.dirty = false;
      }
      // Note: Impostor rendering handled by AtlasedRockPlantImpostorManager
    }
  }

  /**
   * Get instance count.
   */
  getInstanceCount(): number {
    return this.instances.size;
  }

  /**
   * Sync impostor lighting with scene's sun light.
   */
  private syncImpostorLighting(): void {
    const now = performance.now();
    // Only update lighting once per frame (~16ms)
    if (now - this._lastLightUpdate < 16) return;
    this._lastLightUpdate = now;

    // Get environment system for sun light and hemisphere light
    const env = this.world.getSystem("environment") as {
      sunLight?: THREE.DirectionalLight;
      lightDirection?: THREE.Vector3;
      hemisphereLight?: THREE.HemisphereLight;
    } | null;

    if (!env?.sunLight) return;

    const sun = env.sunLight;
    // Light direction is negated (light goes FROM direction TO target)
    if (env.lightDirection) {
      this._lightDir.copy(env.lightDirection).negate();
    } else {
      this._lightDir.set(0.5, 0.8, 0.3);
    }

    // Scale light color by intensity but clamp to reasonable range
    // MeshBasicNodeMaterial doesn't do tone mapping, so HDR values cause white blowout
    const sunIntensity = Math.min(sun.intensity, 1.5);
    this._lightColor.set(
      Math.min(sun.color.r * sunIntensity, 1.0),
      Math.min(sun.color.g * sunIntensity, 1.0),
      Math.min(sun.color.b * sunIntensity, 1.0),
    );

    // Get ambient from hemisphere light for proper world lighting sync
    if (env.hemisphereLight) {
      const hemi = env.hemisphereLight;
      const hemiIntensity = Math.min(hemi.intensity, 1.0) * 0.5;
      this._ambientColor.set(
        Math.min(hemi.color.r * hemiIntensity, 0.5),
        Math.min(hemi.color.g * hemiIntensity, 0.5),
        Math.min(hemi.color.b * hemiIntensity, 0.5),
      );
    } else {
      this._ambientColor.set(0.3, 0.35, 0.4);
    }

    // Diagnostic: log once when lighting is connected
    if (!this._lightingLoggedOnce) {
      console.log(
        `[ProcgenPlantInstancer] Lighting connected: dir=(${this._lightDir.x.toFixed(2)}, ${this._lightDir.y.toFixed(2)}, ${this._lightDir.z.toFixed(2)}), ` +
          `color=(${this._lightColor.x.toFixed(2)}, ${this._lightColor.y.toFixed(2)}, ${this._lightColor.z.toFixed(2)})`,
      );
      this._lightingLoggedOnce = true;
    }

    // Update atlased impostor manager lighting
    this.atlasedImpostorManager.updateLighting(
      this._lightDir,
      this._lightColor,
      this._ambientColor,
    );
  }

  /**
   * Get stats for debugging.
   */
  getStats(): {
    totalInstances: number;
    lodCounts: [number, number, number, number, number];
    presetCount: number;
  } {
    const lodCounts: [number, number, number, number, number] = [0, 0, 0, 0, 0];

    for (const instance of this.instances.values()) {
      lodCounts[instance.currentLOD]++;
    }

    return {
      totalInstances: this.instances.size,
      lodCounts,
      presetCount: this.presetMeshes.size,
    };
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    for (const presetData of this.presetMeshes.values()) {
      if (presetData.lod0) {
        this.scene.remove(presetData.lod0.mesh);
        presetData.lod0.mesh.dispose();
      }
      if (presetData.lod1) {
        this.scene.remove(presetData.lod1.mesh);
        presetData.lod1.mesh.dispose();
      }
      if (presetData.lod2) {
        this.scene.remove(presetData.lod2.mesh);
        presetData.lod2.mesh.dispose();
      }
      // Note: Impostor cleanup handled by AtlasedRockPlantImpostorManager
    }

    this.presetMeshes.clear();
    this.instances.clear();
    this.updateQueue = [];

    ProcgenPlantInstancer.instance = null;
  }
}
