/**
 * ProcgenStumpInstancer - Instanced Rendering for Tree Stumps
 *
 * A simplified instancer for tree stumps that appear when trees are cut down.
 * Unlike the tree instancer, stumps don't need complex LOD systems, impostors,
 * or leaf clusters - they're simple geometry that fades out at distance.
 *
 * Features:
 * - Per-preset instanced meshes for batched rendering
 * - Simple distance-based fade (no LOD transitions)
 * - Cull at reasonable distance since stumps are small
 * - Matches tree bark colors from the same preset
 */

import THREE, {
  uniform,
  attribute,
  Fn,
  float,
  vec3,
  mul,
  screenUV,
  fract,
  floor,
  Discard,
  If,
  MeshStandardNodeMaterial,
} from "../../../extras/three/three";
import type { World } from "../../../core/World";
import {
  generateStumpFromParams,
  createParamsFromPreset,
  STUMP_HEIGHT,
} from "@hyperforge/procgen/plant";
import { applySkyFog } from "./FogConfig";

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_INSTANCES_PER_PRESET = 200;
const CULL_DISTANCE = 80; // Stumps are small, cull early
const CULL_DISTANCE_SQ = CULL_DISTANCE ** 2;
const FADE_START = 60;
const FADE_START_SQ = FADE_START ** 2;
const UPDATE_INTERVAL_MS = 150; // Slower updates since stumps are static

// ============================================================================
// TYPES
// ============================================================================

interface StumpInstance {
  id: string;
  presetName: string;
  position: THREE.Vector3;
  rotation: number;
  scale: number;
  meshIndex: number;
  visible: boolean;
}

interface PresetMeshData {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  mesh: THREE.InstancedMesh;
  fadeAttr: THREE.InstancedBufferAttribute;
  idxToId: Map<number, string>;
  freeIndices: number[];
  nextIdx: number;
  count: number;
  dirty: boolean;
}

// ============================================================================
// STUMP INSTANCER CLASS
// ============================================================================

export class ProcgenStumpInstancer {
  private static instance: ProcgenStumpInstancer | null = null;

  private world: World;
  private scene: THREE.Scene;
  private camera: THREE.Camera;

  private instances: Map<string, StumpInstance> = new Map();
  private presetMeshes: Map<string, PresetMeshData> = new Map();
  private presetGeometries: Map<string, THREE.BufferGeometry> = new Map();

  private lastUpdate = 0;
  private tempMatrix = new THREE.Matrix4();
  private tempQuat = new THREE.Quaternion();
  private tempScale = new THREE.Vector3();
  private zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  // Shared bark material with dissolve fade
  private stumpMaterial: THREE.Material | null = null;
  private fadeUniform = uniform(1.0);

  private constructor(world: World) {
    this.world = world;
    this.scene = world.stage?.scene as THREE.Scene;
    this.camera = world.camera;
    this.createSharedMaterial();
  }

  /**
   * Get or create the singleton instancer.
   */
  static getInstance(world: World | null): ProcgenStumpInstancer | null {
    if (!world) return ProcgenStumpInstancer.instance;
    if (!ProcgenStumpInstancer.instance) {
      ProcgenStumpInstancer.instance = new ProcgenStumpInstancer(world);
    }
    return ProcgenStumpInstancer.instance;
  }

  /**
   * Destroy the singleton instance and clean up resources.
   */
  static destroy(): void {
    if (ProcgenStumpInstancer.instance) {
      ProcgenStumpInstancer.instance.dispose();
      ProcgenStumpInstancer.instance = null;
    }
  }

  /**
   * Create shared material for all stumps with distance fade.
   */
  private createSharedMaterial(): void {
    const material = new MeshStandardNodeMaterial();

    // Use vertex colors for bark gradient
    material.vertexColors = true;
    material.roughness = 0.9;
    material.metalness = 0.0;

    // Per-instance fade attribute for distance culling
    const instanceFade = attribute<"float">("instanceFade", "float");

    // Screen-space dithering dissolve based on fade
    const dissolveNode = Fn(() => {
      const fade = instanceFade;

      // Skip dissolve calculation if fully visible
      If(fade.greaterThanEqual(0.999), () => {
        // Fully visible, no dissolve needed
      }).Else(() => {
        // Screen-space dithering pattern
        const screenPos = screenUV;
        const pixelX = floor(mul(screenPos.x, 1920.0));
        const pixelY = floor(mul(screenPos.y, 1080.0));
        const ditherPattern = fract(
          mul(pixelX.add(pixelY.mul(0.5)), 0.25).add(mul(pixelX, 0.125)),
        );

        // Discard based on fade threshold
        If(ditherPattern.greaterThan(fade), () => {
          Discard();
        });
      });

      return float(1.0);
    });

    // Apply dissolve to opacity
    material.opacityNode = dissolveNode();
    material.transparent = true;
    material.alphaTest = 0.01;

    applySkyFog(material);

    this.stumpMaterial = material;
  }

  /**
   * Generate or retrieve cached stump geometry for a preset.
   */
  private async getOrCreateStumpGeometry(
    presetName: string,
  ): Promise<THREE.BufferGeometry> {
    const cached = this.presetGeometries.get(presetName);
    if (cached) return cached;

    // Map tree preset names to plant generator preset names
    const presetMapping: Record<string, string> = {
      quakingAspen: "quakingAspen",
      blackOak: "blackOak",
      weepingWillow: "weepingWillow",
      blackTupelo: "blackTupelo",
      acer: "acer",
      sassafras: "sassafras",
      europeanLarch: "europeanLarch",
      hillCherry: "hillCherry",
      // Legacy mappings
      tree_normal: "quakingAspen",
      tree_oak: "blackOak",
      tree_willow: "weepingWillow",
      tree_teak: "blackTupelo",
      tree_maple: "acer",
      tree_mahogany: "sassafras",
      tree_yew: "europeanLarch",
      tree_magic: "hillCherry",
    };

    const plantPreset = presetMapping[presetName] || "quakingAspen";

    // Generate stump geometry using plant generator
    const params = createParamsFromPreset(
      plantPreset as Parameters<typeof createParamsFromPreset>[0],
    );

    // Use a consistent seed for reproducible stumps
    const seed = this.hashString(presetName);
    const result = generateStumpFromParams(params, STUMP_HEIGHT, seed, 8);

    this.presetGeometries.set(presetName, result.geometry);
    return result.geometry;
  }

  /**
   * Simple string hash for consistent seed generation.
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Ensure preset mesh data exists.
   */
  private async ensurePresetLoaded(
    presetName: string,
  ): Promise<PresetMeshData> {
    let meshData = this.presetMeshes.get(presetName);
    if (meshData) return meshData;

    const geometry = await this.getOrCreateStumpGeometry(presetName);

    // Create instanced mesh
    const mesh = new THREE.InstancedMesh(
      geometry,
      this.stumpMaterial!,
      MAX_INSTANCES_PER_PRESET,
    );
    mesh.name = `Stump_${presetName}`;
    mesh.frustumCulled = false; // We handle culling manually
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;

    // Initialize all matrices to zero (hidden)
    for (let i = 0; i < MAX_INSTANCES_PER_PRESET; i++) {
      mesh.setMatrixAt(i, this.zeroMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // Create per-instance fade attribute
    const fadeArray = new Float32Array(MAX_INSTANCES_PER_PRESET).fill(1.0);
    const fadeAttr = new THREE.InstancedBufferAttribute(fadeArray, 1);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute("instanceFade", fadeAttr);

    // Add to scene
    this.scene.add(mesh);

    meshData = {
      geometry,
      material: this.stumpMaterial!,
      mesh,
      fadeAttr,
      idxToId: new Map(),
      freeIndices: [],
      nextIdx: 0,
      count: 0,
      dirty: false,
    };

    this.presetMeshes.set(presetName, meshData);
    return meshData;
  }

  /**
   * Add a stump instance at the given position.
   */
  async addStump(
    presetName: string,
    entityId: string,
    position: THREE.Vector3,
    rotation: number,
    scale: number,
  ): Promise<boolean> {
    // Don't add duplicates
    if (this.instances.has(entityId)) {
      return false;
    }

    const meshData = await this.ensurePresetLoaded(presetName);

    // Get an instance index
    let idx: number;
    if (meshData.freeIndices.length > 0) {
      idx = meshData.freeIndices.pop()!;
    } else {
      if (meshData.nextIdx >= MAX_INSTANCES_PER_PRESET) {
        console.warn(
          `[ProcgenStumpInstancer] Max instances reached for ${presetName}`,
        );
        return false;
      }
      idx = meshData.nextIdx++;
    }

    // Create instance record
    const instance: StumpInstance = {
      id: entityId,
      presetName,
      position: position.clone(),
      rotation,
      scale,
      meshIndex: idx,
      visible: true,
    };
    this.instances.set(entityId, instance);
    meshData.idxToId.set(idx, entityId);

    // Set the instance matrix
    this.tempQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
    this.tempScale.set(scale, scale, scale);
    this.tempMatrix.compose(position, this.tempQuat, this.tempScale);
    meshData.mesh.setMatrixAt(idx, this.tempMatrix);

    // Set initial fade (fully visible if close, faded if far)
    const distSq = this.camera.position.distanceToSquared(position);
    const fade = this.calculateFade(distSq);
    meshData.fadeAttr.setX(idx, fade);

    meshData.count++;
    meshData.mesh.count = Math.max(meshData.mesh.count, idx + 1);
    meshData.dirty = true;

    return true;
  }

  /**
   * Remove a stump instance.
   */
  removeStump(entityId: string): boolean {
    const instance = this.instances.get(entityId);
    if (!instance) return false;

    const meshData = this.presetMeshes.get(instance.presetName);
    if (meshData) {
      // Hide the instance by zeroing its matrix
      meshData.mesh.setMatrixAt(instance.meshIndex, this.zeroMatrix);
      meshData.fadeAttr.setX(instance.meshIndex, 0);

      // Return index to pool
      meshData.idxToId.delete(instance.meshIndex);
      meshData.freeIndices.push(instance.meshIndex);
      meshData.count--;
      meshData.dirty = true;
    }

    this.instances.delete(entityId);
    return true;
  }

  /**
   * Calculate fade value based on distance squared.
   */
  private calculateFade(distSq: number): number {
    if (distSq >= CULL_DISTANCE_SQ) return 0;
    if (distSq <= FADE_START_SQ) return 1;

    // Linear fade from FADE_START to CULL_DISTANCE
    const t = (distSq - FADE_START_SQ) / (CULL_DISTANCE_SQ - FADE_START_SQ);
    return 1.0 - t;
  }

  /**
   * Update fade values based on camera position.
   * Call this every frame.
   */
  update(_deltaTime: number): void {
    if (!this.camera) return;

    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    const camPos = this.camera.position;

    // Update fade for all instances
    for (const instance of this.instances.values()) {
      const meshData = this.presetMeshes.get(instance.presetName);
      if (!meshData) continue;

      const distSq =
        (instance.position.x - camPos.x) ** 2 +
        (instance.position.z - camPos.z) ** 2;

      const fade = this.calculateFade(distSq);
      const wasVisible = instance.visible;
      instance.visible = fade > 0;

      // Update fade attribute
      meshData.fadeAttr.setX(instance.meshIndex, fade);

      // If visibility changed, update matrix
      if (instance.visible !== wasVisible) {
        if (instance.visible) {
          this.tempQuat.setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            instance.rotation,
          );
          this.tempScale.set(instance.scale, instance.scale, instance.scale);
          this.tempMatrix.compose(
            instance.position,
            this.tempQuat,
            this.tempScale,
          );
          meshData.mesh.setMatrixAt(instance.meshIndex, this.tempMatrix);
        } else {
          meshData.mesh.setMatrixAt(instance.meshIndex, this.zeroMatrix);
        }
        meshData.dirty = true;
      }
    }

    // Apply updates
    for (const meshData of this.presetMeshes.values()) {
      if (meshData.dirty) {
        meshData.mesh.instanceMatrix.needsUpdate = true;
        meshData.fadeAttr.needsUpdate = true;
        meshData.dirty = false;
      }
    }
  }

  /**
   * Get statistics about stump instances.
   */
  getStats(): {
    totalInstances: number;
    presets: number;
    byPreset: Record<string, number>;
  } {
    const byPreset: Record<string, number> = {};
    for (const [preset, meshData] of this.presetMeshes) {
      byPreset[preset] = meshData.count;
    }
    return {
      totalInstances: this.instances.size,
      presets: this.presetMeshes.size,
      byPreset,
    };
  }

  /**
   * Clean up all resources.
   */
  dispose(): void {
    // Remove meshes from scene
    for (const meshData of this.presetMeshes.values()) {
      this.scene.remove(meshData.mesh);
      meshData.geometry.dispose();
      meshData.mesh.dispose();
    }

    // Dispose shared material
    if (this.stumpMaterial) {
      this.stumpMaterial.dispose();
    }

    // Dispose cached geometries
    for (const geometry of this.presetGeometries.values()) {
      geometry.dispose();
    }

    this.instances.clear();
    this.presetMeshes.clear();
    this.presetGeometries.clear();
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

let worldRef: World | null = null;

/**
 * Set the world reference for the stump instancer.
 */
export function setProcgenStumpWorld(world: World | null): void {
  worldRef = world;
  if (world) {
    ProcgenStumpInstancer.getInstance(world);
  }
}

/**
 * Add a stump instance.
 */
export async function addStumpInstance(
  presetName: string,
  entityId: string,
  position: THREE.Vector3,
  rotation: number,
  scale: number,
): Promise<boolean> {
  if (!worldRef) {
    console.warn("[ProcgenStumpInstancer] World not set - cannot add stump");
    return false;
  }

  const instancer = ProcgenStumpInstancer.getInstance(worldRef);
  if (!instancer) return false;

  return instancer.addStump(presetName, entityId, position, rotation, scale);
}

/**
 * Remove a stump instance.
 */
export function removeStumpInstance(entityId: string): boolean {
  if (!worldRef) return false;

  const instancer = ProcgenStumpInstancer.getInstance(worldRef);
  if (!instancer) return false;

  return instancer.removeStump(entityId);
}

/**
 * Update stump instances (call every frame).
 */
export function updateStumpInstances(deltaTime: number = 0.016): void {
  if (!worldRef) return;

  const instancer = ProcgenStumpInstancer.getInstance(worldRef);
  if (instancer) {
    instancer.update(deltaTime);
  }
}

/**
 * Get stump instancer statistics.
 */
export function getStumpStats(): {
  totalInstances: number;
  presets: number;
  byPreset: Record<string, number>;
} | null {
  if (!worldRef) return null;

  const instancer = ProcgenStumpInstancer.getInstance(worldRef);
  return instancer?.getStats() ?? null;
}

/**
 * Clean up stump instancer resources.
 */
export function disposeStumpInstancer(): void {
  ProcgenStumpInstancer.destroy();
  worldRef = null;
}
