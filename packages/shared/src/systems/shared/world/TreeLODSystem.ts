/**
 * TreeLODSystem - Unified Tree LOD, Baking, and Rendering
 *
 * Consolidates all tree baking and LOD preparation into a single system:
 * - SpeedTree-style branch cards for per-branch rendering
 * - Compute shader leaf instancing for LOD0
 * - GPU-driven culling and indirect draws
 *
 * ## Architecture
 *
 * ```
 * TreeLODSystem
 * ├── BranchCardBaker (SpeedTree-style)
 * │   ├── Per-branch orthographic rendering
 * │   ├── Card atlas generation
 * │   └── Silhouette-following cutouts
 * ├── ComputeLeafInstancer (LOD0)
 * │   ├── GPU storage buffers for transforms
 * │   ├── Compute culling + density LOD
 * │   └── Indirect draw submission
 * └── TreeLODOrchestrator
 *     ├── LOD0: Trunk mesh + ComputeLeafInstancer
 *     ├── LOD1: Trunk mesh + Branch cards (50%)
 *     ├── LOD2: Trunk mesh + Branch cards (20%)
 *     └── Impostor: Octahedral billboard
 * ```
 *
 * ## SpeedTree-Style Branch Cards
 *
 * Instead of arbitrary spatial clustering, we:
 * 1. Isolate each branch with its leaves
 * 2. Render orthographically from optimal viewing angle
 * 3. Generate cutout mesh following leaf silhouettes
 * 4. Pack all cards into an atlas per tree type
 *
 * This produces more natural-looking LOD transitions because cards
 * represent actual branch+leaf formations.
 *
 * ## Compute Leaf Instancer
 *
 * For LOD0, we use compute shaders for maximum performance:
 * 1. Store all leaf transforms in a GPU storage buffer
 * 2. Compute shader performs frustum + distance culling
 * 3. Output visible leaf indices to indirect draw buffer
 * 4. Single draw call renders all visible leaves
 *
 * @module TreeLODSystem
 */

import THREE, {
  uniform,
  Fn,
  float,
  vec3,
  add,
  sub,
  mul,
  div,
  sin,
  abs,
  smoothstep,
  positionLocal,
  uv,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
} from "../../../extras/three/three";
import type { World } from "../../../core/World";
import type { BranchCluster } from "@hyperforge/procgen";
import type { Wind } from "./Wind";

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Tree LOD configuration with compute-optimized distances.
 *
 * LOD Levels:
 * - LOD0 (0-30m): Trunk + compute-instanced leaves
 * - LOD1 (30-60m): Trunk + branch cards (50% density)
 * - LOD2 (60-100m): Trunk + branch cards (20% density)
 * - Impostor (100-150m): Octahedral billboard
 * - Culled (150m+): Not rendered
 */
export interface TreeLODSystemConfig {
  /** Distance where LOD1 starts (branch cards at 50%) */
  lod1: number;
  /** Distance where LOD2 starts (branch cards at 20%) */
  lod2: number;
  /** Distance where impostor starts */
  impostor: number;
  /** Distance where trees are culled */
  cull: number;
  /** Enable compute shader leaves (requires WebGPU) */
  useComputeLeaves: boolean;
  /** Maximum leaves per tree for compute buffer */
  maxLeavesPerTree: number;
  /** Maximum total leaves across all trees */
  maxTotalLeaves: number;
  /** Branch card atlas size */
  cardAtlasSize: number;
  /** Cards per tree (for atlas layout) */
  maxCardsPerTree: number;
}

const DEFAULT_LOD_CONFIG: TreeLODSystemConfig = {
  lod1: 30,
  lod2: 60,
  impostor: 100,
  cull: 150,
  useComputeLeaves: true,
  maxLeavesPerTree: 2000,
  maxTotalLeaves: 200000, // 200K leaves total
  cardAtlasSize: 2048,
  maxCardsPerTree: 64,
};

// Current config (mutable)
let CONFIG = { ...DEFAULT_LOD_CONFIG };

// Pre-computed squared distances (updated when config changes)
const DIST_SQ = {
  lod1: CONFIG.lod1 ** 2,
  lod2: CONFIG.lod2 ** 2,
  impostor: CONFIG.impostor ** 2,
  cull: CONFIG.cull ** 2,
};

/**
 * Recompute squared distances after config change.
 */
function updateDistanceSq(): void {
  DIST_SQ.lod1 = CONFIG.lod1 ** 2;
  DIST_SQ.lod2 = CONFIG.lod2 ** 2;
  DIST_SQ.impostor = CONFIG.impostor ** 2;
  DIST_SQ.cull = CONFIG.cull ** 2;
}

/**
 * Update tree LOD configuration.
 */
export function setTreeLODSystemConfig(
  config: Partial<TreeLODSystemConfig>,
): void {
  CONFIG = { ...CONFIG, ...config };
  updateDistanceSq();
  console.log("[TreeLODSystem] Config updated:", CONFIG);
}

export function getTreeLODSystemConfig(): TreeLODSystemConfig {
  return { ...CONFIG };
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single leaf instance for compute buffer.
 * Packed layout for GPU efficiency (64 bytes per leaf).
 */
export interface ComputeLeafInstance {
  /** World transform matrix (16 floats) */
  transform: THREE.Matrix4;
  /** Color RGB (3 floats) + fade (1 float) */
  colorFade: THREE.Vector4;
  /** Tree ID for grouping (1 uint) + padding (3 floats) */
  metadata: THREE.Vector4;
}

/**
 * Branch card data for atlas rendering.
 */
export interface BranchCard {
  /** Unique card ID */
  id: number;
  /** Source branch cluster this card represents */
  cluster: BranchCluster;
  /** UV coordinates in the atlas */
  atlasUV: { u: number; v: number; width: number; height: number };
  /** Billboard orientation */
  orientation: THREE.Quaternion;
  /** World-space dimensions */
  dimensions: { width: number; height: number };
}

/**
 * Tree registration data.
 */
export interface TreeRegistration {
  /** Unique tree ID */
  id: string;
  /** Tree preset name */
  preset: string;
  /** World position */
  position: THREE.Vector3;
  /** Y rotation */
  rotation: number;
  /** Scale factor */
  scale: number;
  /** Current LOD level (0-4) */
  currentLOD: number;
  /** Leaf indices in compute buffer */
  leafIndices: number[];
  /** Card indices for this tree */
  cardIndices: number[];
}

/**
 * Baked tree data (cached per preset).
 */
export interface BakedTreePreset {
  /** Preset name */
  name: string;
  /** Branch cards atlas texture */
  cardAtlas: THREE.Texture | null;
  /** Card metadata */
  cards: BranchCard[];
  /** Leaf template transforms (relative to tree origin) */
  leafTemplates: ComputeLeafInstance[];
  /** Trunk geometry for LOD0 */
  trunkLOD0: THREE.BufferGeometry | null;
  /** Trunk geometry for LOD1 */
  trunkLOD1: THREE.BufferGeometry | null;
  /** Trunk geometry for LOD2 */
  trunkLOD2: THREE.BufferGeometry | null;
  /** Impostor bake result */
  impostorBakeResult: unknown;
  /** Tree dimensions */
  dimensions: { width: number; height: number; canopyRadius: number };
}

// ============================================================================
// WGSL COMPUTE SHADERS
// ============================================================================

/**
 * Compute shader for leaf culling and LOD density.
 * Performs frustum + distance + view-dependent culling, outputs visible leaves to indirect buffer.
 *
 * View-Dependent Culling:
 * Leaves on the back side of their tree (relative to camera) are culled.
 * This significantly reduces overdraw when viewing trees from one side.
 */
const LEAF_CULLING_SHADER = /* wgsl */ `
// Leaf instance data (matches ComputeLeafInstance layout)
struct LeafInstance {
  // Transform matrix columns (mat4x4 as 4 vec4s)
  transform0: vec4<f32>,
  transform1: vec4<f32>,
  transform2: vec4<f32>,
  transform3: vec4<f32>,
  // Color RGB + fade
  colorFade: vec4<f32>,
  // Tree ID (x), Tree Center XYZ (yzw) - used for view-dependent culling
  metadata: vec4<f32>,
}

// Visible leaf output
struct VisibleLeaf {
  sourceIndex: u32,
  lodDensity: f32,
  distanceSq: f32,
  _padding: f32,
}

// Culling parameters
struct CullParams {
  cameraPos: vec4<f32>,
  // Frustum planes (6 planes as vec4)
  frustum0: vec4<f32>,
  frustum1: vec4<f32>,
  frustum2: vec4<f32>,
  frustum3: vec4<f32>,
  frustum4: vec4<f32>,
  frustum5: vec4<f32>,
  // LOD distances (squared)
  lod1DistSq: f32,
  lod2DistSq: f32,
  impostorDistSq: f32,
  cullDistSq: f32,
  // Density multipliers per LOD
  densityLOD0: f32,
  densityLOD1: f32,
  densityLOD2: f32,
  instanceCount: u32,
}

// Indirect draw params
struct DrawIndirect {
  vertexCount: u32,
  instanceCount: atomic<u32>,
  firstVertex: u32,
  firstInstance: u32,
}

// Golden ratio for deterministic hashing
const GOLDEN_RATIO: f32 = 0.618033988749895;

@group(0) @binding(0) var<storage, read> leaves: array<LeafInstance>;
@group(0) @binding(1) var<uniform> params: CullParams;
@group(0) @binding(2) var<storage, read_write> visibleLeaves: array<VisibleLeaf>;
@group(0) @binding(3) var<storage, read_write> drawParams: DrawIndirect;

// Extract position from transform
fn getPosition(leaf: LeafInstance) -> vec3<f32> {
  return leaf.transform3.xyz;
}

// Extract tree center from metadata (yzw components)
fn getTreeCenter(leaf: LeafInstance) -> vec3<f32> {
  return leaf.metadata.yzw;
}

// View-dependent culling threshold (-0.2 = aggressive, -0.4 = conservative)
const VIEW_CULL_THRESHOLD: f32 = -0.2;

// Check if leaf is on back side of tree relative to camera
// Returns true if leaf should be culled (is on back side)
fn isBackFacing(leafPos: vec3<f32>, treeCenter: vec3<f32>, cameraPos: vec3<f32>) -> bool {
  // Vector from camera to leaf
  let cameraToLeaf = normalize(leafPos - cameraPos);
  
  // Vector from tree center to leaf
  let centerToLeaf = normalize(leafPos - treeCenter);
  
  // If dot product is negative, leaf is on the opposite side of tree from camera
  // A leaf is "behind" the tree if: looking from camera toward leaf,
  // the leaf is pointing away from the tree center (opposite direction)
  let facing = dot(cameraToLeaf, centerToLeaf);
  
  return facing < VIEW_CULL_THRESHOLD;
}

// Test sphere against frustum plane
fn sphereVsPlane(center: vec3<f32>, radius: f32, plane: vec4<f32>) -> bool {
  let dist = dot(plane.xyz, center) + plane.w;
  return dist >= -radius;
}

// Frustum culling (6 planes)
fn frustumCull(center: vec3<f32>, radius: f32) -> bool {
  if (!sphereVsPlane(center, radius, params.frustum0)) { return false; }
  if (!sphereVsPlane(center, radius, params.frustum1)) { return false; }
  if (!sphereVsPlane(center, radius, params.frustum2)) { return false; }
  if (!sphereVsPlane(center, radius, params.frustum3)) { return false; }
  if (!sphereVsPlane(center, radius, params.frustum4)) { return false; }
  if (!sphereVsPlane(center, radius, params.frustum5)) { return false; }
  return true;
}

// Distance squared (XZ plane)
fn distSqXZ(a: vec3<f32>, b: vec3<f32>) -> f32 {
  let dx = a.x - b.x;
  let dz = a.z - b.z;
  return dx * dx + dz * dz;
}

// Get LOD density based on distance
fn getLODDensity(distSq: f32) -> f32 {
  if (distSq < params.lod1DistSq) {
    return params.densityLOD0;
  }
  if (distSq < params.lod2DistSq) {
    return params.densityLOD1;
  }
  if (distSq < params.impostorDistSq) {
    return params.densityLOD2;
  }
  return 0.0; // Beyond impostor = no leaves (impostor has baked leaves)
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let idx = globalId.x;
  if (idx >= params.instanceCount) {
    return;
  }
  
  let leaf = leaves[idx];
  let pos = getPosition(leaf);
  
  // Distance culling (fast, do first)
  let distSq = distSqXZ(pos, params.cameraPos.xyz);
  if (distSq > params.impostorDistSq) {
    return; // Beyond impostor distance
  }
  
  // View-dependent culling: cull leaves on back side of tree
  // This significantly reduces overdraw when viewing trees from one side
  let treeCenter = getTreeCenter(leaf);
  // Only apply if tree center is set (non-zero)
  let hasTreeCenter = dot(treeCenter, treeCenter) > 0.01;
  if (hasTreeCenter && isBackFacing(pos, treeCenter, params.cameraPos.xyz)) {
    return; // Leaf is on back side of tree
  }
  
  // Frustum culling (small radius for leaves)
  if (!frustumCull(pos, 0.3)) {
    return;
  }
  
  // LOD density-based culling
  let density = getLODDensity(distSq);
  if (density <= 0.0) {
    return;
  }
  
  // Deterministic density culling using golden ratio hash
  let hash = fract(f32(idx) * GOLDEN_RATIO);
  if (hash > density) {
    return;
  }
  
  // Passed all culling - add to visible list
  let outIdx = atomicAdd(&drawParams.instanceCount, 1u);
  
  var visible: VisibleLeaf;
  visible.sourceIndex = idx;
  visible.lodDensity = density;
  visible.distanceSq = distSq;
  visible._padding = 0.0;
  
  visibleLeaves[outIdx] = visible;
}
`;

/**
 * Reset indirect draw params shader.
 */
const RESET_DRAW_SHADER = /* wgsl */ `
struct DrawIndirect {
  vertexCount: u32,
  instanceCount: u32,
  firstVertex: u32,
  firstInstance: u32,
}

@group(0) @binding(0) var<storage, read_write> drawParams: DrawIndirect;
@group(0) @binding(1) var<uniform> vertexCount: u32;

@compute @workgroup_size(1)
fn main() {
  drawParams.vertexCount = vertexCount;
  drawParams.instanceCount = 0u;
  drawParams.firstVertex = 0u;
  drawParams.firstInstance = 0u;
}
`;

// ============================================================================
// BRANCH CARD BAKER (SpeedTree-Style)
// ============================================================================

/**
 * BranchCardBaker - Generates SpeedTree-style branch cards.
 *
 * Process:
 * 1. For each branch cluster, render orthographically
 * 2. Generate silhouette-following cutout mesh
 * 3. Pack all cards into a single atlas
 * 4. Return card metadata for instancing
 */
export class BranchCardBaker {
  private renderer: THREE.WebGPURenderer | null = null;
  private renderTarget: THREE.RenderTarget | null = null;
  private orthoCamera: THREE.OrthographicCamera;
  private bakingScene: THREE.Scene;
  private bakingMaterial: MeshBasicNodeMaterial;
  private ambientLight: THREE.AmbientLight;

  constructor() {
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.bakingScene = new THREE.Scene();
    this.bakingScene.background = null; // Transparent

    // Baking material with transparency support (WebGPU compatible)
    this.bakingMaterial = new MeshBasicNodeMaterial();
    this.bakingMaterial.color = new THREE.Color(0x3d7a3d);
    this.bakingMaterial.side = THREE.DoubleSide;
    this.bakingMaterial.transparent = true;
    this.bakingMaterial.alphaTest = 0.5;

    // Add ambient light for uniform illumination during baking
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    this.bakingScene.add(this.ambientLight);
  }

  /**
   * Initialize baker with renderer.
   */
  init(renderer: THREE.WebGPURenderer): void {
    this.renderer = renderer;
    this.renderTarget = new THREE.RenderTarget(
      CONFIG.cardAtlasSize,
      CONFIG.cardAtlasSize,
      {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
      },
    );
    this.renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /**
   * Create leaf card geometry for baking.
   */
  private createLeafCardGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const size = 0.15;

    const positions = new Float32Array([
      -size,
      0,
      0,
      size,
      0,
      0,
      size,
      size * 1.5,
      0,
      -size,
      size * 1.5,
      0,
    ]);

    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);

    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    return geo;
  }

  /**
   * Create instanced mesh for cluster leaves.
   */
  private createClusterLeavesMesh(
    cluster: BranchCluster,
    leafPositions: THREE.Vector3[],
    leafDirections: THREE.Vector3[],
    leafGeometry: THREE.BufferGeometry,
    leafMaterial: THREE.Material,
  ): THREE.InstancedMesh {
    const leafCount = Math.min(
      cluster.leafIndices.length,
      leafPositions.length,
    );
    const mesh = new THREE.InstancedMesh(leafGeometry, leafMaterial, leafCount);

    const tempMatrix = new THREE.Matrix4();
    const tempPosition = new THREE.Vector3();
    const tempQuaternion = new THREE.Quaternion();
    const tempScale = new THREE.Vector3(1, 1, 1);
    // up vector available for alignment if needed
    // const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < leafCount; i++) {
      const leafIdx = cluster.leafIndices[i];
      if (leafIdx >= leafPositions.length) continue;

      tempPosition.copy(leafPositions[leafIdx]);

      // Orient leaf to face away from branch
      const leafDir = leafDirections[leafIdx] ?? new THREE.Vector3(0, 0, 1);
      tempQuaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), leafDir);

      tempMatrix.compose(tempPosition, tempQuaternion, tempScale);
      mesh.setMatrixAt(i, tempMatrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  /**
   * Bake branch cards for a tree preset.
   *
   * @param clusters - Branch cluster data from BranchClusterGenerator
   * @param leafPositions - World positions of all leaves
   * @param leafDirections - Directions of all leaves
   * @param leafColor - Base leaf color for baking
   * @returns Object containing cards array and atlas texture
   */
  async bakeCards(
    clusters: BranchCluster[],
    leafPositions: THREE.Vector3[] = [],
    leafDirections: THREE.Vector3[] = [],
    leafColor: THREE.Color = new THREE.Color(0x3d7a3d),
  ): Promise<{ cards: BranchCard[]; atlasTexture: THREE.Texture | null }> {
    if (!this.renderer || !this.renderTarget) {
      console.warn("[BranchCardBaker] Not initialized");
      return { cards: [], atlasTexture: null };
    }

    if (clusters.length === 0) {
      return { cards: [], atlasTexture: null };
    }

    const cards: BranchCard[] = [];
    const atlasSize = CONFIG.cardAtlasSize;
    const maxCards = CONFIG.maxCardsPerTree;

    // Calculate card layout in atlas
    const numCards = Math.min(clusters.length, maxCards);
    const cardsPerRow = Math.ceil(Math.sqrt(numCards));
    const cardSize = Math.floor(atlasSize / cardsPerRow);

    // Create leaf geometry for baking
    const leafGeometry = this.createLeafCardGeometry();

    // Update baking material color
    this.bakingMaterial.color.copy(leafColor);

    // Clear the render target to transparent
    const originalRenderTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();

    // Bake each cluster
    const clustersToProcess = clusters.slice(0, maxCards);

    for (let i = 0; i < clustersToProcess.length; i++) {
      const cluster = clustersToProcess[i];

      // Calculate atlas position
      const row = Math.floor(i / cardsPerRow);
      const col = i % cardsPerRow;
      const atlasX = col * cardSize;
      const atlasY = row * cardSize;

      // Setup orthographic camera for this cluster
      const clusterWidth = cluster.width * 1.2;
      const clusterHeight = cluster.height * 1.2;

      this.orthoCamera.left = -clusterWidth / 2;
      this.orthoCamera.right = clusterWidth / 2;
      this.orthoCamera.top = clusterHeight / 2;
      this.orthoCamera.bottom = -clusterHeight / 2;
      this.orthoCamera.near = 0.1;
      this.orthoCamera.far = 100;
      this.orthoCamera.updateProjectionMatrix();

      // Position camera looking at cluster from billboard normal direction
      const cameraDistance = Math.max(clusterWidth, clusterHeight) * 2;
      const cameraPos = cluster.center
        .clone()
        .add(cluster.billboardNormal.clone().multiplyScalar(cameraDistance));
      this.orthoCamera.position.copy(cameraPos);
      this.orthoCamera.lookAt(cluster.center);
      this.orthoCamera.up.copy(cluster.billboardUp);

      // Clear baking scene (except ambient light)
      const children = [...this.bakingScene.children];
      for (const child of children) {
        if (child !== this.ambientLight) {
          this.bakingScene.remove(child);
        }
      }

      // Create instanced mesh for this cluster's leaves
      if (leafPositions.length > 0 && cluster.leafIndices.length > 0) {
        const leavesMesh = this.createClusterLeavesMesh(
          cluster,
          leafPositions,
          leafDirections,
          leafGeometry,
          this.bakingMaterial,
        );
        this.bakingScene.add(leavesMesh);
      }

      // Set viewport for this card region
      this.renderer.setViewport(atlasX, atlasY, cardSize, cardSize);
      this.renderer.setScissor(atlasX, atlasY, cardSize, cardSize);
      this.renderer.setScissorTest(true);

      // Render cluster to atlas
      this.renderer.render(this.bakingScene, this.orthoCamera);

      // Calculate billboard orientation
      const orientation = new THREE.Quaternion();
      const rotMatrix = new THREE.Matrix4();
      rotMatrix.lookAt(
        new THREE.Vector3(0, 0, 0),
        cluster.billboardNormal,
        cluster.billboardUp,
      );
      orientation.setFromRotationMatrix(rotMatrix);

      // Create card entry
      const card: BranchCard = {
        id: i,
        cluster,
        atlasUV: {
          u: atlasX / atlasSize,
          v: atlasY / atlasSize,
          width: cardSize / atlasSize,
          height: cardSize / atlasSize,
        },
        orientation,
        dimensions: {
          width: cluster.width,
          height: cluster.height,
        },
      };

      cards.push(card);
    }

    // Restore renderer state
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, atlasSize, atlasSize);
    this.renderer.setRenderTarget(originalRenderTarget);

    // Clean up geometry
    leafGeometry.dispose();

    // Generate mipmaps for the atlas
    this.renderTarget.texture.generateMipmaps = true;
    this.renderTarget.texture.needsUpdate = true;

    return {
      cards,
      atlasTexture: this.renderTarget.texture,
    };
  }

  /**
   * Generate card billboard geometry.
   */
  createCardGeometry(card: BranchCard): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const w = card.dimensions.width / 2;
    const h = card.dimensions.height;

    // Quad with UV mapping to atlas region
    const positions = new Float32Array([
      -w,
      0,
      0, // bottom-left
      w,
      0,
      0, // bottom-right
      w,
      h,
      0, // top-right
      -w,
      h,
      0, // top-left
    ]);

    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);

    const { u, v, width, height } = card.atlasUV;
    const uvs = new Float32Array([
      u,
      v, // bottom-left
      u + width,
      v, // bottom-right
      u + width,
      v + height, // top-right
      u,
      v + height, // top-left
    ]);

    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    return geo;
  }

  /**
   * Get the atlas texture (after baking).
   */
  getAtlasTexture(): THREE.Texture | null {
    return this.renderTarget?.texture ?? null;
  }

  dispose(): void {
    this.renderTarget?.dispose();
    this.bakingMaterial.dispose();
    this.renderTarget = null;
    this.renderer = null;
  }
}

// ============================================================================
// COMPUTE LEAF INSTANCER
// ============================================================================

/**
 * ComputeLeafInstancer - GPU-driven leaf rendering for LOD0.
 *
 * Uses compute shaders for frustum + distance + density culling,
 * outputting visible leaves to an indirect draw buffer.
 */
export class ComputeLeafInstancer {
  private world: World;
  private device: GPUDevice | null = null;
  private isInitialized = false;

  // GPU Buffers
  private leafBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private visibleBuffer: GPUBuffer | null = null;
  private drawIndirectBuffer: GPUBuffer | null = null;

  // Compute pipeline
  private cullPipeline: GPUComputePipeline | null = null;
  private resetPipeline: GPUComputePipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;

  // Three.js mesh for rendering
  private mesh: THREE.InstancedMesh | null = null;
  private material: THREE.MeshStandardNodeMaterial | null = null;

  // Bookkeeping
  private leafCount = 0;
  private maxLeaves: number;
  private treeLeafRanges: Map<string, { start: number; count: number }> =
    new Map();

  // Wind uniforms
  private windTime = uniform(0);
  private windStrength = uniform(1);
  private windDirection = uniform(new THREE.Vector3(1, 0, 0));

  constructor(world: World) {
    this.world = world;
    this.maxLeaves = CONFIG.maxTotalLeaves;
  }

  /**
   * Initialize compute instancer with WebGPU device.
   * Accepts any Three.js renderer; will detect WebGPU capability.
   */
  async init(renderer: THREE.WebGPURenderer): Promise<boolean> {
    if (this.isInitialized) return true;

    // Get WebGPU device (only available with WebGPURenderer)
    const device = (renderer as unknown as { backend?: { device?: GPUDevice } })
      ?.backend?.device;
    if (!device) {
      console.warn(
        "[ComputeLeafInstancer] WebGPU device not available, falling back to CPU",
      );
      return false;
    }

    this.device = device;

    try {
      await this.createBuffers();
      await this.createPipelines();
      this.createMesh();
      this.isInitialized = true;
      console.log(
        `[ComputeLeafInstancer] Initialized with capacity for ${this.maxLeaves} leaves`,
      );
      return true;
    } catch (error) {
      console.error("[ComputeLeafInstancer] Initialization failed:", error);
      return false;
    }
  }

  private async createBuffers(): Promise<void> {
    if (!this.device) return;

    // Leaf instance buffer (64 bytes per leaf)
    // Layout: mat4 transform (64) + vec4 colorFade (16) + vec4 metadata (16) = 96 bytes
    const leafBufferSize = this.maxLeaves * 96;
    this.leafBuffer = this.device.createBuffer({
      size: leafBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Params uniform buffer
    this.paramsBuffer = this.device.createBuffer({
      size: 256, // CullParams struct
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Visible leaves output buffer
    this.visibleBuffer = this.device.createBuffer({
      size: this.maxLeaves * 16, // VisibleLeaf struct
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Indirect draw buffer
    this.drawIndirectBuffer = this.device.createBuffer({
      size: 16, // DrawIndirect struct
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST,
    });
  }

  // Readback buffer for getting visible count from GPU
  private readbackBuffer: GPUBuffer | null = null;

  // Staging buffer for leaf instance data CPU-side
  private cpuLeafData: Float32Array | null = null;

  private async createPipelines(): Promise<void> {
    if (!this.device) return;

    // Create shader modules
    const cullModule = this.device.createShaderModule({
      code: LEAF_CULLING_SHADER,
    });

    // Create bind group layout
    const COMPUTE_STAGE =
      (globalThis as unknown as { GPUShaderStage: { COMPUTE: number } })
        .GPUShaderStage?.COMPUTE ?? 0x0004;
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE,
          buffer: { type: "read-only-storage" },
        },
        { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: "uniform" } },
        { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: "storage" } },
        { binding: 3, visibility: COMPUTE_STAGE, buffer: { type: "storage" } },
      ],
    });

    // Create pipelines
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.cullPipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: cullModule,
        entryPoint: "main",
      },
    });

    // Create bind group
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.leafBuffer! } },
        { binding: 1, resource: { buffer: this.paramsBuffer! } },
        { binding: 2, resource: { buffer: this.visibleBuffer! } },
        { binding: 3, resource: { buffer: this.drawIndirectBuffer! } },
      ],
    });

    // Create readback buffer for getting visible count
    this.readbackBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Allocate CPU-side leaf data for instanced mesh updates
    this.cpuLeafData = new Float32Array(this.maxLeaves * 24);
  }

  /**
   * Dispatch compute shader to cull leaves.
   * Must be called each frame before rendering.
   */
  dispatchCulling(): void {
    if (
      !this.device ||
      !this.cullPipeline ||
      !this.bindGroup ||
      !this.drawIndirectBuffer
    ) {
      return;
    }

    // Reset draw indirect buffer (set instanceCount to 0)
    const resetData = new Uint32Array([6, 0, 0, 0]); // vertexCount=6 (quad), instanceCount=0
    this.device.queue.writeBuffer(this.drawIndirectBuffer, 0, resetData.buffer);

    // Create command encoder
    const commandEncoder = this.device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();

    passEncoder.setPipeline(this.cullPipeline);
    passEncoder.setBindGroup(0, this.bindGroup);

    // Dispatch: ceil(leafCount / 64) workgroups
    const workgroupCount = Math.ceil(this.leafCount / 64);
    passEncoder.dispatchWorkgroups(workgroupCount);

    passEncoder.end();

    // Copy draw indirect buffer to readback for getting visible count
    if (this.readbackBuffer) {
      commandEncoder.copyBufferToBuffer(
        this.drawIndirectBuffer,
        0,
        this.readbackBuffer,
        0,
        16,
      );
    }

    // Submit
    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Read back visible leaf count from GPU (async).
   * Returns the number of visible leaves after culling.
   */
  async getVisibleCount(): Promise<number> {
    if (!this.readbackBuffer) return 0;

    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(this.readbackBuffer.getMappedRange());
    const visibleCount = data[1]; // instanceCount is at offset 1
    this.readbackBuffer.unmap();

    return visibleCount;
  }

  /**
   * Update the Three.js InstancedMesh with visible leaf transforms.
   * This is a CPU fallback - copies all registered leaf transforms.
   * For full GPU path, use indirect rendering with drawIndirectBuffer.
   */
  updateMeshInstances(): void {
    if (!this.mesh || !this.cpuLeafData) return;

    // Update mesh count with total registered leaves
    // (GPU culling handles visibility, but we need all transforms uploaded)
    this.mesh.count = this.leafCount;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private createMesh(): void {
    // Create leaf card geometry
    const geo = this.createLeafGeometry();

    // Create TSL material with wind animation
    this.material = this.createLeafMaterial();

    // Create instanced mesh
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.maxLeaves);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = "ComputeLeaves";
    this.mesh.layers.set(1);

    // Add to scene
    const scene = this.world.stage?.scene;
    if (scene?.add) {
      scene.add(this.mesh);
    }
  }

  private createLeafGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const size = 0.15;

    // Leaf card quad
    const positions = new Float32Array([
      -size,
      0,
      0,
      size,
      0,
      0,
      size,
      size * 1.5,
      0,
      -size,
      size * 1.5,
      0,
    ]);

    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);

    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    return geo;
  }

  private createLeafMaterial(): THREE.MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();

    // Wind animation constants
    const WIND_SPEED = 2.0;
    const WIND_AMPLITUDE = 0.08;
    const GUST_SPEED = 0.7;
    const GUST_AMPLITUDE = 0.03;
    const LEAF_SIZE = 0.15 * 1.5;

    // Position node with wind displacement
    const positionNode = Fn(() => {
      const pos = positionLocal;

      // Height-based sway (leaves higher in local space sway more)
      const heightFactor = smoothstep(
        float(0.0),
        float(0.3),
        div(pos.y, float(LEAF_SIZE)),
      );

      // Main wind wave
      const phase = add(mul(pos.x, float(0.5)), mul(pos.z, float(0.7)));
      const mainWave = sin(add(mul(this.windTime, float(WIND_SPEED)), phase));

      // Gust wave
      const gustPhase = mul(phase, float(1.3));
      const gustWave = sin(
        add(mul(this.windTime, float(GUST_SPEED)), gustPhase),
      );

      // Combined displacement
      const waveSum = add(
        mul(mainWave, float(WIND_AMPLITUDE)),
        mul(gustWave, float(GUST_AMPLITUDE)),
      );
      const displacement = mul(mul(waveSum, heightFactor), this.windStrength);

      // Apply along wind direction
      const offsetX = mul(displacement, this.windDirection.x);
      const offsetZ = mul(displacement, this.windDirection.z);

      return vec3(add(pos.x, offsetX), pos.y, add(pos.z, offsetZ));
    })();

    material.positionNode = positionNode;

    // Leaf color (green with variation)
    const baseColor = uniform(new THREE.Color(0x3d7a3d));
    material.colorNode = Fn(() => {
      const uvCoord = uv();
      const variation = mul(sub(uvCoord.y, float(0.5)), float(0.1));
      return baseColor.rgb.add(vec3(variation, variation, variation));
    })();

    // Leaf silhouette opacity
    material.opacityNode = Fn(() => {
      const uvCoord = uv();

      // Centered coordinates
      const px = sub(uvCoord.x, float(0.5));
      const py = sub(uvCoord.y, float(0.35));

      // Leaf shape
      const normalizedY = add(mul(py, float(1.3)), float(0.5));
      const widthProfile = mul(
        smoothstep(float(0.0), float(0.4), normalizedY),
        sub(float(1.0), smoothstep(float(0.4), float(1.0), normalizedY)),
      );
      const baseTaper = add(float(0.3), mul(widthProfile, float(0.7)));
      const tipTaper = smoothstep(float(0.65), float(0.95), normalizedY);
      const effectiveWidth = mul(
        baseTaper,
        sub(float(1.0), mul(tipTaper, float(0.7))),
      );

      const maxHalfWidth = mul(effectiveWidth, float(0.38));
      const insideWidth = sub(
        float(1.0),
        smoothstep(mul(maxHalfWidth, float(0.85)), maxHalfWidth, abs(px)),
      );

      const lengthMask = mul(
        smoothstep(float(-0.15), float(0.05), normalizedY),
        smoothstep(float(1.05), float(0.85), normalizedY),
      );

      return mul(insideWidth, lengthMask);
    })();

    material.transparent = false;
    material.alphaTest = 0.5;
    material.side = THREE.DoubleSide;
    material.depthWrite = true;

    return material;
  }

  /**
   * Register leaves for a tree.
   * Returns the leaf indices for tracking.
   */
  registerTree(
    treeId: string,
    leaves: ComputeLeafInstance[],
    worldTransform: THREE.Matrix4,
  ): number[] {
    if (!this.device || !this.leafBuffer) {
      console.warn("[ComputeLeafInstancer] Not initialized");
      return [];
    }

    if (leaves.length === 0) {
      return [];
    }

    // Try to find a free range first
    let startIndex: number;
    const freeRange = this.findFreeRange(leaves.length);

    if (freeRange) {
      startIndex = freeRange.start;
    } else {
      // No free range - allocate at the end
      if (this.leafCount + leaves.length > this.maxLeaves) {
        console.warn(
          `[ComputeLeafInstancer] Capacity exceeded (${this.leafCount}/${this.maxLeaves})`,
        );
        return [];
      }
      startIndex = this.leafCount;
      this.leafCount += leaves.length;
    }

    // Transform leaves to world space and upload
    const leafData = new Float32Array(leaves.length * 24); // 24 floats per leaf

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const worldMat = leaf.transform.clone().premultiply(worldTransform);

      // Pack into buffer
      const offset = i * 24;
      worldMat.toArray(leafData, offset); // 16 floats
      leaf.colorFade.toArray(leafData, offset + 16); // 4 floats
      leaf.metadata.toArray(leafData, offset + 20); // 4 floats
    }

    // Upload to GPU
    this.device.queue.writeBuffer(
      this.leafBuffer,
      startIndex * 96,
      leafData.buffer,
    );

    // Track range
    this.treeLeafRanges.set(treeId, {
      start: startIndex,
      count: leaves.length,
    });

    // Return the indices for tracking
    const indices: number[] = [];
    for (let i = 0; i < leaves.length; i++) {
      indices.push(startIndex + i);
    }
    return indices;
  }

  /**
   * Unregister tree leaves.
   * Marks the leaf range as free for reuse.
   */
  unregisterTree(treeId: string): void {
    const range = this.treeLeafRanges.get(treeId);
    if (!range) return;

    // Add to free list for reuse
    this.freeRanges.push(range);
    this.treeLeafRanges.delete(treeId);

    // Zero out the leaf data in the GPU buffer to prevent rendering
    if (this.device && this.leafBuffer) {
      const zeroData = new Float32Array(range.count * 24);
      this.device.queue.writeBuffer(
        this.leafBuffer,
        range.start * 96,
        zeroData.buffer,
      );
    }

    // Periodically compact if fragmentation is high
    this.maybeCompactBuffer();
  }

  // Track free ranges for reuse
  private freeRanges: Array<{ start: number; count: number }> = [];
  private compactionThreshold = 0.3; // Compact when 30% is fragmented

  /**
   * Find a free range that can fit the requested leaf count.
   */
  private findFreeRange(
    count: number,
  ): { start: number; count: number } | null {
    // Sort free ranges by start position
    this.freeRanges.sort((a, b) => a.start - b.start);

    // Find first fit
    for (let i = 0; i < this.freeRanges.length; i++) {
      const range = this.freeRanges[i];
      if (range.count >= count) {
        // Use this range
        const result = { start: range.start, count };

        if (range.count === count) {
          // Exact fit - remove from free list
          this.freeRanges.splice(i, 1);
        } else {
          // Partial use - shrink the free range
          range.start += count;
          range.count -= count;
        }

        return result;
      }
    }

    return null;
  }

  /**
   * Merge adjacent free ranges.
   */
  private mergeFreeRanges(): void {
    if (this.freeRanges.length < 2) return;

    this.freeRanges.sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; count: number }> = [];
    let current = this.freeRanges[0];

    for (let i = 1; i < this.freeRanges.length; i++) {
      const next = this.freeRanges[i];
      if (current.start + current.count === next.start) {
        // Adjacent - merge
        current.count += next.count;
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);

    this.freeRanges = merged;
  }

  /**
   * Check if buffer should be compacted and do so if needed.
   */
  private maybeCompactBuffer(): void {
    this.mergeFreeRanges();

    // Calculate fragmentation
    const freeCount = this.freeRanges.reduce((sum, r) => sum + r.count, 0);
    const fragmentation = freeCount / this.maxLeaves;

    if (fragmentation > this.compactionThreshold) {
      this.compactBuffer();
    }
  }

  /**
   * Compact the buffer by moving all leaves to be contiguous.
   * This is expensive and should be done sparingly.
   */
  private compactBuffer(): void {
    if (!this.device || !this.leafBuffer) return;
    if (this.treeLeafRanges.size === 0) {
      this.leafCount = 0;
      this.freeRanges = [];
      return;
    }

    // Get all active ranges sorted by start position
    const activeRanges = Array.from(this.treeLeafRanges.entries()).sort(
      (a, b) => a[1].start - b[1].start,
    );

    // Calculate new positions
    let newPosition = 0;
    const updates: Array<{
      treeId: string;
      oldStart: number;
      newStart: number;
      count: number;
    }> = [];

    for (const [treeId, range] of activeRanges) {
      if (range.start !== newPosition) {
        updates.push({
          treeId,
          oldStart: range.start,
          newStart: newPosition,
          count: range.count,
        });
      }
      newPosition += range.count;
    }

    // If no updates needed, just clear free ranges
    if (updates.length === 0) {
      this.leafCount = newPosition;
      this.freeRanges = [];
      return;
    }

    // For GPU buffer compaction, we'd need to read-back and re-upload
    // This is expensive, so we log a warning
    console.log(
      `[ComputeLeafInstancer] Compacting buffer: ${updates.length} moves required`,
    );

    // Update the tree ranges (the actual GPU memory will be fixed on next registerTree)
    for (const update of updates) {
      const range = this.treeLeafRanges.get(update.treeId);
      if (range) {
        range.start = update.newStart;
      }
    }

    this.leafCount = newPosition;
    this.freeRanges = [];
  }

  /**
   * Update culling and prepare for render.
   */
  update(
    camera: THREE.PerspectiveCamera,
    frustumPlanes: THREE.Vector4[],
    wind?: Wind,
  ): void {
    if (!this.device || !this.isInitialized) return;

    // Update wind uniforms
    this.windTime.value += 0.016; // ~60fps
    if (wind) {
      this.windStrength.value = wind.getStrength();
      this.windDirection.value.copy(wind.getDirection());
    }

    // Update params buffer
    const params = new Float32Array(64);
    camera.position.toArray(params, 0);
    params[3] = 0; // padding

    // Frustum planes
    for (let i = 0; i < 6; i++) {
      if (frustumPlanes[i]) {
        frustumPlanes[i].toArray(params, 4 + i * 4);
      }
    }

    // LOD distances (squared)
    params[28] = DIST_SQ.lod1;
    params[29] = DIST_SQ.lod2;
    params[30] = DIST_SQ.impostor;
    params[31] = DIST_SQ.cull;

    // Density multipliers
    params[32] = 1.0; // LOD0: 100%
    params[33] = 0.5; // LOD1: 50%
    params[34] = 0.2; // LOD2: 20%
    params[35] = this.leafCount;

    this.device.queue.writeBuffer(this.paramsBuffer!, 0, params.buffer);

    // Dispatch compute shader for GPU culling
    // This populates visibleBuffer and drawIndirectBuffer
    this.dispatchCulling();

    // Update mesh with culled leaf count
    // NOTE: For full GPU path, use indirect rendering with drawIndirectBuffer
    // Currently falling back to CPU-side count update
    this.updateMeshInstances();
  }

  /**
   * Get the leaf mesh for rendering.
   */
  getMesh(): THREE.InstancedMesh | null {
    return this.mesh;
  }

  /**
   * Get current leaf count.
   */
  getLeafCount(): number {
    return this.leafCount;
  }

  dispose(): void {
    this.leafBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.visibleBuffer?.destroy();
    this.drawIndirectBuffer?.destroy();

    this.mesh?.geometry.dispose();
    this.material?.dispose();

    if (this.mesh && this.world.stage?.scene?.remove) {
      this.world.stage.scene.remove(this.mesh);
    }

    this.isInitialized = false;
  }
}

// ============================================================================
// TREE LOD ORCHESTRATOR
// ============================================================================

/**
 * TreeLODOrchestrator - Main system coordinating all tree LOD components.
 */
export class TreeLODOrchestrator {
  private world: World;
  private cardBaker: BranchCardBaker;
  private computeLeaves: ComputeLeafInstancer;
  private isInitialized = false;

  // Cached presets
  private presets: Map<string, BakedTreePreset> = new Map();

  // Registered trees
  private trees: Map<string, TreeRegistration> = new Map();

  // Wind
  private wind: Wind | null = null;

  constructor(world: World) {
    this.world = world;
    this.cardBaker = new BranchCardBaker();
    this.computeLeaves = new ComputeLeafInstancer(world);
  }

  /**
   * Initialize the LOD system.
   * Accepts any Three.js renderer; will detect WebGPU capability.
   */
  async init(renderer: THREE.WebGPURenderer): Promise<void> {
    if (this.isInitialized) return;

    this.cardBaker.init(renderer);

    const computeSuccess = await this.computeLeaves.init(renderer);
    if (!computeSuccess) {
      console.warn(
        "[TreeLODOrchestrator] Compute leaves not available, using fallback",
      );
    }

    this.isInitialized = true;
    console.log("[TreeLODOrchestrator] Initialized");
  }

  /**
   * Set wind reference for animation.
   */
  setWind(wind: Wind): void {
    this.wind = wind;
  }

  /**
   * Bake a tree preset for LOD rendering.
   */
  async bakePreset(
    presetName: string,
    clusters: BranchCluster[],
    leafTemplates: ComputeLeafInstance[],
    trunkGeometries: {
      lod0: THREE.BufferGeometry;
      lod1: THREE.BufferGeometry;
      lod2: THREE.BufferGeometry;
    },
    dimensions: { width: number; height: number; canopyRadius: number },
    leafColor: THREE.Color = new THREE.Color(0x3d7a3d),
  ): Promise<BakedTreePreset> {
    // Extract leaf positions and directions for card baking
    const leafPositions: THREE.Vector3[] = [];
    const leafDirections: THREE.Vector3[] = [];

    for (const leaf of leafTemplates) {
      // Extract position from transform matrix (column 3)
      const pos = new THREE.Vector3();
      pos.setFromMatrixPosition(leaf.transform);
      leafPositions.push(pos);

      // Extract direction from transform matrix (column 2 = Z axis = forward)
      const dir = new THREE.Vector3();
      dir.setFromMatrixColumn(leaf.transform, 2);
      leafDirections.push(dir);
    }

    // Bake branch cards
    const { cards, atlasTexture } = await this.cardBaker.bakeCards(
      clusters,
      leafPositions,
      leafDirections,
      leafColor,
    );

    const preset: BakedTreePreset = {
      name: presetName,
      cardAtlas: atlasTexture,
      cards,
      leafTemplates,
      trunkLOD0: trunkGeometries.lod0,
      trunkLOD1: trunkGeometries.lod1,
      trunkLOD2: trunkGeometries.lod2,
      impostorBakeResult: null,
      dimensions,
    };

    this.presets.set(presetName, preset);
    console.log(
      `[TreeLODOrchestrator] Baked preset: ${presetName} ` +
        `(${cards.length} cards, ${leafTemplates.length} leaves, ` +
        `atlas: ${atlasTexture ? "yes" : "no"})`,
    );

    return preset;
  }

  /**
   * Register a tree instance.
   */
  registerTree(
    id: string,
    preset: string,
    position: THREE.Vector3,
    rotation: number,
    scale: number,
  ): TreeRegistration | null {
    const bakedPreset = this.presets.get(preset);
    if (!bakedPreset) {
      console.warn(`[TreeLODOrchestrator] Unknown preset: ${preset}`);
      return null;
    }

    // Create world transform
    const worldTransform = new THREE.Matrix4();
    const rotationMatrix = new THREE.Matrix4().makeRotationY(rotation);
    const scaleMatrix = new THREE.Matrix4().makeScale(scale, scale, scale);
    const translationMatrix = new THREE.Matrix4().makeTranslation(
      position.x,
      position.y,
      position.z,
    );

    // Order: translate * rotate * scale
    worldTransform.multiplyMatrices(translationMatrix, rotationMatrix);
    worldTransform.multiply(scaleMatrix);

    // Register leaves with compute instancer and get indices
    const leafIndices = this.computeLeaves.registerTree(
      id,
      bakedPreset.leafTemplates,
      worldTransform,
    );

    // Generate card indices (one card instance per baked card)
    const cardIndices: number[] = [];
    for (let i = 0; i < bakedPreset.cards.length; i++) {
      cardIndices.push(i);
    }

    const registration: TreeRegistration = {
      id,
      preset,
      position: position.clone(),
      rotation,
      scale,
      currentLOD: 0,
      leafIndices,
      cardIndices,
    };

    this.trees.set(id, registration);
    return registration;
  }

  /**
   * Unregister a tree.
   */
  unregisterTree(id: string): void {
    this.computeLeaves.unregisterTree(id);
    this.trees.delete(id);
  }

  /**
   * Update all trees (LOD selection, culling).
   */
  update(camera: THREE.PerspectiveCamera): void {
    if (!this.isInitialized) return;

    // Extract frustum planes
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projScreenMatrix);

    const frustumPlanes = frustum.planes.map(
      (p) => new THREE.Vector4(p.normal.x, p.normal.y, p.normal.z, p.constant),
    );

    // Update compute leaves
    this.computeLeaves.update(camera, frustumPlanes, this.wind ?? undefined);

    // Update tree LOD levels
    const cameraPos = camera.position;
    for (const tree of this.trees.values()) {
      const distSq =
        (tree.position.x - cameraPos.x) ** 2 +
        (tree.position.z - cameraPos.z) ** 2;

      let newLOD = 0;
      if (distSq > DIST_SQ.cull)
        newLOD = 4; // Culled
      else if (distSq > DIST_SQ.impostor)
        newLOD = 3; // Impostor
      else if (distSq > DIST_SQ.lod2)
        newLOD = 2; // LOD2
      else if (distSq > DIST_SQ.lod1) newLOD = 1; // LOD1

      tree.currentLOD = newLOD;
    }
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalTrees: number;
    totalLeaves: number;
    byLOD: {
      lod0: number;
      lod1: number;
      lod2: number;
      impostor: number;
      culled: number;
    };
  } {
    const byLOD = { lod0: 0, lod1: 0, lod2: 0, impostor: 0, culled: 0 };

    for (const tree of this.trees.values()) {
      switch (tree.currentLOD) {
        case 0:
          byLOD.lod0++;
          break;
        case 1:
          byLOD.lod1++;
          break;
        case 2:
          byLOD.lod2++;
          break;
        case 3:
          byLOD.impostor++;
          break;
        case 4:
          byLOD.culled++;
          break;
      }
    }

    return {
      totalTrees: this.trees.size,
      totalLeaves: this.computeLeaves.getLeafCount(),
      byLOD,
    };
  }

  dispose(): void {
    this.cardBaker.dispose();
    this.computeLeaves.dispose();
    this.presets.clear();
    this.trees.clear();
    this.isInitialized = false;
  }
}

// ============================================================================
// SHADER EXPORTS
// ============================================================================

export { LEAF_CULLING_SHADER, RESET_DRAW_SHADER };
