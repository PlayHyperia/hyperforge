/**
 * ProcgenTreeCache - Cached Procedural Tree Variants with LOD Support
 *
 * Pre-generates and caches a limited number of tree mesh variants per preset.
 * This provides visual variety while maintaining performance through shared geometry.
 *
 * LOD Strategy:
 * - LOD0 (0-30m): Full detail tree with instanced leaf cards
 * - LOD1 (30-60m): Simplified tree - fewer branches, fewer leaves
 * - LOD2 (60-120m): Cross-billboard cards for foliage
 * - Impostor (120m+): Octahedral billboard from ImpostorManager
 *
 * Design:
 * - 3 variants per preset (good balance of variety vs memory)
 * - Variants are generated with different seeds for unique shapes
 * - LOD1/LOD2 meshes use progressively simpler geometry
 * - Clones are returned to callers (shared geometry, individual transforms)
 * - Additional variation via rotation/scale applied by ResourceEntity
 *
 * ============================================================================
 * AAA ENHANCEMENT TODOS
 * ============================================================================
 *
 * TODO(AAA-1): Cross-fade LOD transitions
 * - Implement dissolve shader that fades between LOD levels over ~0.3s
 * - Use noise-based alpha mask for organic-looking transitions
 * - Prevents hard "pop" when LOD changes
 * - Reference: packages/impostor DissolveConfig for existing dissolve system
 *
 * TODO(AAA-2): Wind animation at LOD1
 * - Add subtle vertex shader wind animation to LOD1 meshes
 * - Use world-space noise for coherent wind across trees
 * - Parameters: wind direction, speed, turbulence, leaf flutter
 * - Should be much cheaper than LOD0 wind (fewer vertices)
 *
 * TODO(AAA-3): Shadow LODs (separate shadow meshes)
 * - Create ultra-simplified meshes for shadow map rendering
 * - Shadow LOD0: ~500 tris (vs 5000 for visual LOD0)
 * - Shadow LOD1: ~50 tris (cylinder + cone)
 * - Shadow culling at closer distance than visual culling
 * - Reference: Three.js customDepthMaterial for shadow-specific geometry
 *
 * TODO(AAA-4): Texture atlasing for all tree types
 * - Combine all tree bark/leaf textures into single atlas
 * - Single material for ALL tree types = 1 draw call per LOD
 * - Would reduce draw calls from 32 to 4 (one per LOD level)
 * - Requires UV remapping in procgen or post-process
 *
 * TODO(AAA-5): GPU-driven culling (compute shader)
 * - Move frustum culling to GPU compute shader
 * - Add occlusion culling using hierarchical Z-buffer
 * - Output visible instance indices to indirect draw buffer
 * - Would eliminate CPU-side distance calculations entirely
 * - Requires WebGPU compute shader support
 *
 * TODO(AAA-6): Hierarchical LOD (HLOD) for distant clusters
 * - Merge groups of distant trees into single combined mesh
 * - At 300m+, replace 10 trees with 1 "tree cluster" impostor
 * - Further reduces draw calls for open world scenes
 * - Pre-bake cluster impostors during asset pipeline
 */

import type { Node } from "three/webgpu";
import * as THREE from "three";
import * as THREE_WEBGPU from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { ProcgenTreeInstancer } from "./ProcgenTreeInstancer";
import { applySkyFog } from "./FogConfig";
import type { World } from "../../../core/World";
import {
  procgenCacheDB,
  serializeGeometry,
  deserializeGeometry,
  serializeColor,
  deserializeColor,
  type SerializedTreeVariant,
  type SerializedGeometry,
  type SerializedLeafInstances,
} from "../../../utils/rendering/ProcgenCacheDB";

// ============================================================================
// TREE CARD BAKER - Renders actual tree geometry to billboard textures
// ============================================================================

/**
 * Renderer interface for tree card baking.
 * Compatible with WebGPURenderer (or WebGL fallback).
 */
interface CardBakerRenderer {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  renderAsync(scene: THREE.Scene, camera: THREE.Camera): Promise<void>;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  getRenderTarget(): THREE.WebGLRenderTarget | null;
  setClearColor(color: number, alpha: number): void;
  clear(): void;
  readRenderTargetPixelsAsync(
    renderTarget: THREE.WebGLRenderTarget,
    x: number,
    y: number,
    width: number,
    height: number,
    buffer: Uint8Array,
  ): Promise<void>;
}

/**
 * Configuration for tree card baking.
 */
const CARD_BAKER_CONFIG = {
  /** Resolution of each card texture (square) */
  textureSize: 512,
  /** Padding around tree in texture (0-1, percentage of dimension) */
  padding: 0.1,
  /** Background color for baking (transparent) */
  backgroundColor: 0x000000,
  /** Whether to use antialiasing during bake */
  antialias: true,
} as const;

/**
 * Baked card data for a tree variant.
 */
interface BakedCardData {
  /** Texture for card facing X axis */
  textureX: THREE.Texture;
  /** Texture for card facing Z axis */
  textureZ: THREE.Texture;
  /** Width of the card in world units */
  cardWidth: number;
  /** Height of the card in world units */
  cardHeight: number;
}

/**
 * TreeCardBaker - Renders tree meshes from orthographic views to create
 * accurate billboard textures for LOD2 cross-cards.
 *
 * This replaces procedural crown shaders with actual rendered tree appearance,
 * ensuring:
 * - Leaves properly cover branches
 * - Accurate silhouette matches the tree
 * - Colors and details are preserved
 */
class TreeCardBaker {
  private static instance: TreeCardBaker | null = null;

  private renderer: CardBakerRenderer | null = null;
  private renderTargetX: THREE.WebGLRenderTarget | null = null;
  private renderTargetZ: THREE.WebGLRenderTarget | null = null;
  private orthoCamera: THREE.OrthographicCamera;
  private bakingScene: THREE.Scene;
  private ambientLight: THREE.AmbientLight;
  private directionalLight: THREE.DirectionalLight;
  private initialized = false;
  private readPixelsWarned = false; // Only warn once about readPixels fallback

  private constructor() {
    // Orthographic camera for flat projection
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);

    // Dedicated scene for baking
    this.bakingScene = new THREE.Scene();
    this.bakingScene.background = null; // Transparent

    // Lighting for baking - ambient + soft directional for depth
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    this.bakingScene.add(this.ambientLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.directionalLight.position.set(1, 2, 1);
    this.bakingScene.add(this.directionalLight);
  }

  static getInstance(): TreeCardBaker {
    if (!TreeCardBaker.instance) {
      TreeCardBaker.instance = new TreeCardBaker();
    }
    return TreeCardBaker.instance;
  }

  /**
   * Initialize the baker with a renderer.
   * Must be called before baking.
   */
  init(renderer: CardBakerRenderer): boolean {
    if (this.initialized) return true;

    this.renderer = renderer;
    const { textureSize } = CARD_BAKER_CONFIG;

    // Create render targets for each card direction
    const rtOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      colorSpace: THREE.SRGBColorSpace,
    };

    this.renderTargetX = new THREE.WebGLRenderTarget(
      textureSize,
      textureSize,
      rtOptions,
    );
    this.renderTargetZ = new THREE.WebGLRenderTarget(
      textureSize,
      textureSize,
      rtOptions,
    );

    this.initialized = true;
    console.log(
      `[TreeCardBaker] Initialized with ${textureSize}x${textureSize} textures`,
    );
    return true;
  }

  /**
   * Check if baker is ready.
   */
  isReady(): boolean {
    return this.initialized && this.renderer !== null;
  }

  /**
   * Bake tree cards from a tree mesh group.
   *
   * Renders the tree from two orthogonal directions (X and Z) to create
   * textures for cross-billboard cards.
   *
   * @param treeGroup - The LOD0 tree mesh group to bake
   * @param dimensions - Tree dimensions for proper framing
   * @returns Baked card data with textures, or null if baking fails
   */
  async bakeTreeCards(
    treeGroup: THREE.Group,
    dimensions: { width: number; height: number; trunkHeight: number },
  ): Promise<BakedCardData | null> {
    if (!this.isReady()) {
      console.warn(
        "[TreeCardBaker] Not initialized - using procedural fallback",
      );
      return null;
    }

    const { padding } = CARD_BAKER_CONFIG;
    const { width, height, trunkHeight } = dimensions;

    // Crown dimensions (foliage area above trunk)
    const crownHeight = height - trunkHeight;
    const crownCenterY = trunkHeight + crownHeight * 0.5;

    // Card dimensions with padding
    const cardWidth = width * (1 + padding * 2);
    const cardHeight = (crownHeight + trunkHeight * 0.3) * (1 + padding * 2); // Include some trunk

    // Clone tree for baking (don't modify original)
    const bakeTree = treeGroup.clone(true);

    // Ensure all materials are double-sided for proper baking
    bakeTree.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const mat = child.material as THREE.Material;
        mat.side = THREE.DoubleSide;
      }
    });

    // Clear baking scene and add tree
    this.clearBakingScene();
    this.bakingScene.add(bakeTree);

    // Position tree at origin for consistent baking
    bakeTree.position.set(0, 0, 0);
    bakeTree.updateMatrixWorld(true);

    // Bake from X direction (looking along +X)
    const textureX = await this.bakeFromDirection(
      new THREE.Vector3(1, 0, 0),
      cardWidth,
      cardHeight,
      crownCenterY,
      this.renderTargetX!,
    );

    // Bake from Z direction (looking along +Z)
    const textureZ = await this.bakeFromDirection(
      new THREE.Vector3(0, 0, 1),
      cardWidth,
      cardHeight,
      crownCenterY,
      this.renderTargetZ!,
    );

    // Remove tree from baking scene
    this.bakingScene.remove(bakeTree);

    // Dispose cloned tree
    bakeTree.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Don't dispose geometry/material - they're shared with original
      }
    });

    if (!textureX || !textureZ) {
      console.warn("[TreeCardBaker] Failed to bake textures");
      return null;
    }

    return {
      textureX,
      textureZ,
      cardWidth,
      cardHeight,
    };
  }

  /**
   * Bake from a specific direction.
   * Creates a new texture with copied data for each bake.
   */
  private async bakeFromDirection(
    direction: THREE.Vector3,
    width: number,
    height: number,
    centerY: number,
    renderTarget: THREE.WebGLRenderTarget,
  ): Promise<THREE.Texture | null> {
    if (!this.renderer) return null;

    const { textureSize } = CARD_BAKER_CONFIG;

    // Setup orthographic camera bounds
    this.orthoCamera.left = -width / 2;
    this.orthoCamera.right = width / 2;
    this.orthoCamera.top = centerY + height / 2;
    this.orthoCamera.bottom = centerY - height / 2;
    this.orthoCamera.near = 0.01;
    this.orthoCamera.far = Math.max(width, height) * 4;
    this.orthoCamera.updateProjectionMatrix();

    // Position camera looking at tree center from the direction
    const cameraDistance = Math.max(width, height) * 2;
    const cameraTarget = new THREE.Vector3(0, centerY, 0);
    const cameraPos = cameraTarget
      .clone()
      .add(direction.clone().multiplyScalar(cameraDistance));

    this.orthoCamera.position.copy(cameraPos);
    this.orthoCamera.lookAt(cameraTarget);
    this.orthoCamera.up.set(0, 1, 0);

    // Render to target
    const originalRenderTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(renderTarget);
    this.renderer.setClearColor(CARD_BAKER_CONFIG.backgroundColor, 0);
    this.renderer.clear();

    // Render with WebGPU async
    await this.renderer.renderAsync(this.bakingScene, this.orthoCamera);

    // Read pixels back from render target to create independent texture
    // This ensures the texture data is captured before the render target is reused
    const pixelBuffer = new Uint8Array(textureSize * textureSize * 4);

    try {
      // WebGPU async read
      await this.renderer.readRenderTargetPixelsAsync(
        renderTarget,
        0,
        0,
        textureSize,
        textureSize,
        pixelBuffer,
      );
    } catch {
      // Fallback: use the render target texture directly
      // This is expected for WebGPU - the texture fallback works fine
      if (!this.readPixelsWarned) {
        console.log(
          "[TreeCardBaker] Using render target texture directly (WebGPU mode)",
        );
        this.readPixelsWarned = true;
      }
      this.renderer.setRenderTarget(originalRenderTarget);
      return renderTarget.texture;
    }

    // Restore render target
    this.renderer.setRenderTarget(originalRenderTarget);

    // Create DataTexture from pixel buffer
    const texture = new THREE.DataTexture(
      pixelBuffer,
      textureSize,
      textureSize,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.flipY = true; // WebGL/WebGPU render targets are flipped
    texture.needsUpdate = true;

    return texture;
  }

  /**
   * Clear the baking scene of all objects except lights.
   */
  private clearBakingScene(): void {
    const toRemove: THREE.Object3D[] = [];
    this.bakingScene.traverse((child) => {
      if (
        child !== this.bakingScene &&
        child !== this.ambientLight &&
        child !== this.directionalLight
      ) {
        toRemove.push(child);
      }
    });
    for (const obj of toRemove) {
      this.bakingScene.remove(obj);
    }
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this.renderTargetX?.dispose();
    this.renderTargetZ?.dispose();
    this.renderTargetX = null;
    this.renderTargetZ = null;
    this.renderer = null;
    this.initialized = false;
    TreeCardBaker.instance = null;
  }
}

/**
 * Get the global TreeCardBaker instance.
 */
export function getTreeCardBaker(): TreeCardBaker {
  return TreeCardBaker.getInstance();
}

/**
 * Initialize the tree card baker with a renderer.
 * Should be called once the renderer is available.
 */
export function initTreeCardBaker(renderer: CardBakerRenderer): boolean {
  return TreeCardBaker.getInstance().init(renderer);
}

// TSL functions from three/webgpu
const {
  Fn,
  uv,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  add,
  sub,
  mul,
  abs,
  sin,
  atan,
  pow,
  floor,
  fract,
  length,
  max,
  mix,
  smoothstep,
  dot,
} = THREE_WEBGPU.TSL;

/** Number of variants to cache per tree preset */
const VARIANTS_PER_PRESET = 3;

/**
 * USE TRADITIONAL CARDS FOR LOD2
 * When true, LOD2 uses cross-billboard cards instead of simplified trunk geometry.
 * This is the classic SpeedTree approach for distant trees:
 * - Simple trunk cylinder
 * - Two perpendicular billboard planes with procedural crown texture
 * - Looks good from any angle
 * - Only ~12 triangles per tree
 */
const USE_TRADITIONAL_CARDS_LOD2 = true;

/**
 * Cache version - increment this when the generation algorithm changes
 * to invalidate cached variants and force regeneration.
 *
 * Version 2: Mobile-optimized LOD geometry (cheaper trees, trunk-only LOD1/LOD2)
 * Version 5: Switch to traditional card trees for LOD2 (SpeedTree style)
 * Version 6: Baked tree card textures for accurate LOD2 appearance
 */
const CACHE_VERSION = 6; // Bumped to use baked tree cards for LOD2

/**
 * Crown shape types for LOD2 procedural billboards.
 * Different tree types have different crown silhouettes.
 */
type CrownType = "rounded" | "conical" | "weeping" | "columnar" | "spreading";

/**
 * Map tree presets to their appropriate crown shapes.
 * This ensures LOD2 billboards match the tree's silhouette.
 */
const PRESET_CROWN_TYPES: Record<string, CrownType> = {
  // Deciduous - rounded crowns
  quakingAspen: "rounded",
  blackOak: "spreading",
  blackTupelo: "rounded",
  acer: "spreading", // Japanese maple has wide spread
  sassafras: "rounded",
  hillCherry: "rounded",

  // Conifers - conical crowns
  balsamFir: "conical",
  douglasFir: "conical",
  europeanLarch: "conical",
  smallPine: "conical",

  // Special shapes
  weepingWillow: "weeping",
  lombardyPoplar: "columnar",
  palm: "spreading", // Palm fronds spread out
  fanPalm: "spreading",
  bamboo: "columnar",

  // Default for any unknown preset
  default: "rounded",
};

/**
 * Get the crown type for a tree preset.
 */
function getCrownType(presetName: string): CrownType {
  return PRESET_CROWN_TYPES[presetName] ?? PRESET_CROWN_TYPES.default!;
}

/** World reference for instancer registration */
let worldRef: World | null = null;

/**
 * Set the world reference for instancer registration.
 * Call this during game initialization.
 * Also initializes the tree card baker if renderer is available.
 */
export function setProcgenTreeWorld(world: World): void {
  worldRef = world;

  // Initialize tree card baker if renderer is available
  const graphics = world.graphics as
    { renderer?: CardBakerRenderer } | undefined;
  if (graphics?.renderer) {
    const baker = getTreeCardBaker();
    if (!baker.isReady()) {
      const success = baker.init(graphics.renderer);
      if (success) {
        console.log(
          "[ProcgenTreeCache] TreeCardBaker initialized with world renderer",
        );
      }
    }
  }
}

/** Base seeds for variant generation (spread apart for visual diversity) */
const VARIANT_SEEDS = [12345, 67890, 24680];

/**
 * ============================================================================
 * AAA TREE LOD CONFIGURATION
 * ============================================================================
 *
 * Performance budget per tree at each LOD:
 * - LOD0 (0-30m):    ~3000-5000 tris, full detail for close inspection
 * - LOD1 (30-60m):   ~200-500 tris, simplified silhouette
 * - LOD2 (60-120m):  ~20-40 tris, card billboards
 * - Impostor (120m+): 2 tris, octahedral billboard
 *
 * Total budget for 1000 trees at mixed distances:
 * - 50 trees at LOD0:  ~200K tris
 * - 200 trees at LOD1: ~60K tris
 * - 500 trees at LOD2: ~15K tris
 * - 250 impostors:     ~500 tris
 * - Total: ~275K tris (target: <500K for 60fps)
 */

/**
 * LOD0 geometry options - Mobile-optimized close-up detail
 * Target: ~500 triangles per tree (cheap but recognizable)
 *
 * LOD0 is used for trees within ~25m of the player.
 * Mobile-first: minimal geometry, leaves handled by clusters.
 *
 * Settings for efficient trees:
 * - maxStems: 20 for trunk + first branches only
 * - maxBranchDepth: 1 (trunk + main branches, no sub-branches)
 * - radialSegments: 3 (triangle cross-section, minimum)
 * - maxLeaves: 0 (clusters handle all foliage)
 * - segmentSamples: 2 for smooth enough curves
 *
 * Budget breakdown for a typical tree:
 * - 20 stems × ~6 ring samples × 3 radial × 2 tris = ~720 branch tris
 * - Leaves handled by GlobalLeafClusterInstancer (separate draw call)
 * - Total: ~720 tris (great for mobile LOD0)
 */
const LOD0_GEOMETRY_OPTIONS = {
  radialSegments: 3, // Triangle cross-section (minimum for smooth look)
  maxLeaves: 2000, // Generate leaf transforms for cluster system (actual leaves render via clusters)
  maxBranchDepth: 1, // Trunk + first level branches only
  maxStems: 20, // Minimal but recognizable structure
  segmentSamples: 2, // Smooth enough curves
};

/**
 * LOD1 geometry options - Trunk + main branches
 * Target: ~300-400 triangles per tree
 *
 * LOD1 is used for trees 25-50m away. Main branch structure visible.
 * Leaves at 50% density handled by clusters.
 *
 * Budget breakdown:
 * - 10 stems × ~6 ring samples × 3 radial × 2 tris = ~360 branch tris
 * - Leaf clusters at 50% density (separate draw call)
 */
const LOD1_GEOMETRY_OPTIONS = {
  radialSegments: 3, // Triangle cross-section
  maxLeaves: 0, // Clusters handle leaves at 50% density
  maxBranchDepth: 1, // Trunk + first level branches (main structure visible)
  maxStems: 10, // Fewer branches than LOD0 but still recognizable
  segmentSamples: 2,
};

/**
 * LOD2 geometry options - Trunk + main branches (same as LOD1)
 * Leaves at 80% culled (20% visible) via clusters
 *
 * At 50-100m, main branch structure + sparse clusters is sufficient.
 */
const LOD2_GEOMETRY_OPTIONS = {
  radialSegments: 3,
  maxLeaves: 0,
  maxBranchDepth: 1, // Trunk + first level branches (main structure visible)
  maxStems: 10, // Main branches visible at distance
  segmentSamples: 1, // Minimal curve detail
};

/**
 * LOD2 "Card Tree" - billboard cards for distant viewing (LEGACY)
 * Now only used as fallback if trunk geometry fails.
 * Primary LOD2 uses trunk mesh + leaf clusters.
 */
const LOD2_CARD_OPTIONS = {
  trunkSegments: 3, // 3-sided trunk (triangle)
  crownType: "rounded" as CrownType, // Default crown shape
  trunkHeightRatio: 0.35, // Trunk is 35% of tree height
  numCrossCards: 2, // 2 perpendicular billboard cards (cross pattern)
  cardSize: 0.8, // Cards are 80% of crown width for coverage
};

/**
 * Cached tree variant data.
 */
interface TreeVariant {
  /** The generated tree mesh group (LOD0 - full detail) */
  group: THREE.Group;
  /** LOD1 simplified mesh group */
  lod1Group: THREE.Group | null;
  /** LOD2 "card tree" mesh group (trunk + billboard cards) */
  lod2Group: THREE.Group | null;
  /** Vertex count for LOD0 */
  vertexCount: number;
  /** Triangle count for LOD0 */
  triangleCount: number;
  /** Vertex count for LOD1 */
  lod1VertexCount: number;
  /** Triangle count for LOD1 */
  lod1TriangleCount: number;
  /** Vertex count for LOD2 */
  lod2VertexCount: number;
  /** Triangle count for LOD2 */
  lod2TriangleCount: number;
  /** Tree dimensions (for LOD2 card generation) */
  dimensions: { width: number; height: number; trunkHeight: number };
  /** Leaf color extracted from LOD0 */
  leafColor: THREE.Color;
  /** Bark color extracted from LOD0 */
  barkColor: THREE.Color;
}

/**
 * Cache entry for a preset's variants.
 */
interface PresetCache {
  /** Array of generated variants */
  variants: TreeVariant[];
  /** Whether generation is in progress */
  loading: boolean;
  /** Promise for waiting on generation */
  loadPromise: Promise<void> | null;
}

/**
 * Global cache of tree variants per preset.
 */
const presetCache = new Map<string, PresetCache>();

/**
 * TreeGenerator import (lazy loaded to avoid circular deps).
 */
let TreeGenerator: typeof import("@hyperforge/procgen").TreeGenerator | null =
  null;
let procgenLoaded = false;
let procgenLoadPromise: Promise<void> | null = null;
let procgenLoadFailed = false;

/**
 * Lazy load the procgen module.
 * Only runs on client (browser) - returns immediately on server.
 */
async function loadProcgen(): Promise<boolean> {
  // Don't attempt to load on server (no logging - this is called frequently)
  if (typeof window === "undefined") {
    return false;
  }

  if (procgenLoaded) return true;
  if (procgenLoadFailed) return false;
  if (procgenLoadPromise) {
    await procgenLoadPromise;
    return procgenLoaded;
  }

  console.log("[ProcgenTreeCache] Loading @hyperforge/procgen...");

  procgenLoadPromise = (async () => {
    try {
      const procgen = await import("@hyperforge/procgen");
      TreeGenerator = procgen.TreeGenerator;
      procgenLoaded = true;
      console.log("[ProcgenTreeCache] Successfully loaded @hyperforge/procgen");
    } catch (error) {
      console.error(
        "[ProcgenTreeCache] Failed to load @hyperforge/procgen:",
        error,
      );
      procgenLoadFailed = true;
    }
  })();

  await procgenLoadPromise;
  return procgenLoaded;
}

/**
 * Generate LOD1 tree using procgen with reduced geometry settings.
 * This is much more efficient than decimating a high-poly mesh.
 */
async function generateLOD1Tree(
  presetName: string,
  seed: number,
): Promise<{
  group: THREE.Group;
  vertexCount: number;
  triangleCount: number;
} | null> {
  if (!TreeGenerator) {
    return null;
  }

  try {
    // Create generator with LOD1 geometry settings
    const generator = new TreeGenerator(presetName, {
      geometry: LOD1_GEOMETRY_OPTIONS,
    });

    const result = generator.generate(seed);

    // Count vertices and triangles
    let vertexCount = 0;
    let triangleCount = 0;

    result.group.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geo = child.geometry;
        if (geo.attributes.position) {
          vertexCount += geo.attributes.position.count;
        }
        if (geo.index) {
          triangleCount += geo.index.count / 3;
        } else if (geo.attributes.position) {
          triangleCount += geo.attributes.position.count / 3;
        }
      }
    });

    return {
      group: result.group,
      vertexCount,
      triangleCount,
    };
  } catch (error) {
    console.warn(
      `[ProcgenTreeCache] LOD1 generation failed for ${presetName}:`,
      error,
    );
    return null;
  }
}

/**
 * Generate LOD2 tree using procgen with trunk-only geometry.
 * This replaces the card tree approach with actual trunk mesh + leaf clusters.
 */
async function generateLOD2Tree(
  presetName: string,
  seed: number,
): Promise<{
  group: THREE.Group;
  vertexCount: number;
  triangleCount: number;
} | null> {
  if (!TreeGenerator) {
    return null;
  }

  try {
    // Create generator with LOD2 geometry settings (trunk only)
    const generator = new TreeGenerator(presetName, {
      geometry: LOD2_GEOMETRY_OPTIONS,
    });

    const result = generator.generate(seed);

    // Count vertices and triangles
    let vertexCount = 0;
    let triangleCount = 0;

    result.group.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geo = child.geometry;
        if (geo.attributes.position) {
          vertexCount += geo.attributes.position.count;
        }
        if (geo.index) {
          triangleCount += geo.index.count / 3;
        } else if (geo.attributes.position) {
          triangleCount += geo.attributes.position.count / 3;
        }
      }
    });

    return {
      group: result.group,
      vertexCount,
      triangleCount,
    };
  } catch (error) {
    console.warn(
      `[ProcgenTreeCache] LOD2 generation failed for ${presetName}:`,
      error,
    );
    return null;
  }
}

/**
 * Generate tree variants for a preset.
 * Generates LOD0, LOD1, and LOD2 with progressively simpler geometry.
 * Leaves are handled by GlobalLeafClusterInstancer at all LOD levels.
 */
/**
 * Extract colors and dimensions from a generated tree.
 * Handles both standard materials and shader materials (instanced leaves).
 */
function extractTreeMetadata(group: THREE.Group): {
  leafColor: THREE.Color;
  barkColor: THREE.Color;
  dimensions: { width: number; height: number; trunkHeight: number };
} {
  let leafColor = new THREE.Color(0x3d7a3d); // Default green
  let barkColor = new THREE.Color(0x5c4033); // Default brown

  // Extract colors from materials
  group.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      const mat = child.material;

      // Check for instanced leaves (ShaderMaterial with uColor uniform)
      if (
        (child.name === "InstancedLeaves" ||
          child.name === "Leaves" ||
          child.name.toLowerCase().includes("leaf")) &&
        mat instanceof THREE.ShaderMaterial &&
        mat.uniforms?.uColor
      ) {
        const uColor = mat.uniforms.uColor.value;
        if (uColor instanceof THREE.Color) {
          leafColor = uColor.clone();
        }
      }
      // Check for standard/node material leaves (supports both MeshStandardMaterial and MeshStandardNodeMaterial)
      else if (
        (child.name === "Leaves" ||
          child.name.toLowerCase().includes("leaf")) &&
        "color" in mat &&
        mat.color instanceof THREE.Color
      ) {
        leafColor = mat.color.clone();
      }
      // Check for trunk/branches (supports both MeshStandardMaterial and MeshStandardNodeMaterial)
      else if (
        (child.name === "Trunk" ||
          child.name === "Branches" ||
          child.name.toLowerCase().includes("branch")) &&
        "color" in mat &&
        mat.color instanceof THREE.Color
      ) {
        barkColor = mat.color.clone();
      }
    }
  });

  // Calculate dimensions from bounding box
  const bbox = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  return {
    leafColor,
    barkColor,
    dimensions: {
      width: Math.max(size.x, size.z),
      height: size.y,
      trunkHeight: size.y * LOD2_CARD_OPTIONS.trunkHeightRatio,
    },
  };
}

/**
 * TSL Crown material type with uniforms
 */
type TSLCrownMaterial = MeshBasicNodeMaterial & {
  crownUniforms: {
    color: { value: THREE.Color };
    seed: { value: number };
  };
};

/**
 * Create a procedural crown material for LOD2 billboard cards using TSL (WebGPU).
 * Generates a crown silhouette with leaf-like edges and color variation.
 * Supports different crown shapes: rounded, conical, weeping, columnar, spreading.
 */
function createProceduralCrownMaterialTSL(
  leafColor: THREE.Color,
  crownType: CrownType = "rounded",
  seed: number = 0,
): TSLCrownMaterial {
  const material = new MeshBasicNodeMaterial();

  // Uniforms
  const uColor = uniform(leafColor);
  const uSeed = uniform(seed);

  // ========== TSL HELPER FUNCTIONS ==========

  // Hash function for noise
  const hashFn = Fn(([p]: [Node<"vec2">]) => {
    return fract(mul(sin(dot(p, vec2(127.1, 311.7))), float(43758.5453123)));
  });

  // 2D noise function
  const noiseFn = Fn(([p]: [Node<"vec2">]) => {
    const i = floor(p);
    const f = fract(p);
    const smoothF = mul(mul(f, f), sub(vec2(3.0, 3.0), mul(f, float(2.0))));

    const a = hashFn(i);
    const b = hashFn(add(i, vec2(1.0, 0.0)));
    const c = hashFn(add(i, vec2(0.0, 1.0)));
    const d = hashFn(add(i, vec2(1.0, 1.0)));

    return mix(mix(a, b, smoothF.x), mix(c, d, smoothF.x), smoothF.y);
  });

  // 4-octave FBM (unrolled loop)
  const fbmFn = Fn(([p]: [Node<"vec2">]) => {
    const n1 = mul(noiseFn(p), float(0.5));
    const n2 = mul(noiseFn(mul(p, float(2.0))), float(0.25));
    const n3 = mul(noiseFn(mul(p, float(4.0))), float(0.125));
    const n4 = mul(noiseFn(mul(p, float(8.0))), float(0.0625));
    return add(add(add(n1, n2), n3), n4);
  });

  // Crown shape functions based on type (compile-time selection)
  const getCrownRadiusFn = Fn(
    ([p, edgeNoise]: [Node<"vec2">, Node<"float">]) => {
      if (crownType === "conical") {
        // Conical/pyramidal shape for conifers
        const baseRadius = add(
          float(0.15),
          mul(sub(float(0.5), p.y), float(0.6)),
        );
        const clampedRadius = max(baseRadius, float(0.05));
        return add(clampedRadius, mul(edgeNoise, float(0.5)));
      } else if (crownType === "weeping") {
        // Weeping shape - wider at top, droops down
        const baseRadius = float(0.35);
        const verticalShape = add(float(1.0), mul(p.y, float(0.4)));
        // Add droop effect at the bottom using smoothstep
        const droopAmount = mul(
          smoothstep(float(-0.1), float(-0.4), p.y),
          mul(abs(add(p.y, float(0.1))), float(0.5)),
        );
        return add(mul(baseRadius, add(verticalShape, droopAmount)), edgeNoise);
      } else if (crownType === "columnar") {
        // Narrow columnar shape (like Lombardy poplar)
        const baseRadius = float(0.15);
        const verticalShape = sub(float(1.0), mul(abs(p.y), float(0.2)));
        return add(mul(baseRadius, verticalShape), mul(edgeNoise, float(0.3)));
      } else if (crownType === "spreading") {
        // Wide spreading shape (like oak or maple)
        const baseRadius = float(0.45);
        const verticalShape = sub(
          float(1.0),
          mul(pow(abs(p.y), float(1.5)), float(0.4)),
        );
        return add(mul(baseRadius, verticalShape), edgeNoise);
      } else {
        // Default: rounded deciduous tree shape
        const baseRadius = float(0.4);
        const verticalShape = sub(float(1.0), mul(abs(p.y), float(0.3)));
        return add(mul(baseRadius, verticalShape), edgeNoise);
      }
    },
  );

  // ========== COLOR NODE ==========
  material.colorNode = Fn(() => {
    const uvCoord = uv();

    // Center UV around (0.5, 0.5)
    const p = sub(uvCoord, vec2(0.5, 0.5));

    // Angle and distance from center
    const angle = atan(p.y, p.x);
    const r = length(p);

    // Add noise-based variation to the edge (like leaf clusters)
    const edgeNoise = mul(
      fbmFn(vec2(add(mul(angle, float(3.0)), uSeed), uSeed)),
      float(0.12),
    );

    // Get crown radius based on shape type
    const crownRadius = getCrownRadiusFn(p, edgeNoise);

    // Alpha based on distance from center vs crown radius
    const alpha = sub(
      float(1.0),
      smoothstep(mul(crownRadius, float(0.85)), crownRadius, r),
    );

    // Add internal leaf cluster variation (darker/lighter spots)
    const internalNoise = fbmFn(add(mul(uvCoord, float(8.0)), uSeed));
    const clusterDark = smoothstep(float(0.3), float(0.7), internalNoise);

    // Color variation - simulate light/shadow on leaf clusters
    const darkColor = uColor.rgb.mul(0.6);
    const lightColor = uColor.rgb.mul(1.2);
    const baseColor = mix(darkColor, lightColor, clusterDark);

    // Add slight ambient occlusion at edges
    const ao = smoothstep(crownRadius, mul(crownRadius, float(0.5)), r);
    const finalColor = mul(baseColor, add(float(0.8), mul(ao, float(0.2))));

    return vec4(finalColor, alpha);
  })();

  // ========== OPACITY NODE ==========
  material.opacityNode = Fn(() => {
    const uvCoord = uv();
    const p = sub(uvCoord, vec2(0.5, 0.5));
    const angle = atan(p.y, p.x);
    const r = length(p);
    const edgeNoise = mul(
      fbmFn(vec2(add(mul(angle, float(3.0)), uSeed), uSeed)),
      float(0.12),
    );
    const crownRadius = getCrownRadiusFn(p, edgeNoise);
    return sub(
      float(1.0),
      smoothstep(mul(crownRadius, float(0.85)), crownRadius, r),
    );
  })();

  // Material settings
  material.side = THREE.DoubleSide;
  material.transparent = true;
  material.depthWrite = true;
  material.alphaTest = 0.1;

  // Store uniforms for runtime updates
  const tslMaterial = material as TSLCrownMaterial;
  tslMaterial.crownUniforms = {
    color: uColor,
    seed: uSeed,
  };

  applySkyFog(tslMaterial);

  return tslMaterial;
}

/**
 * Create a material using baked tree texture.
 * This shows the actual rendered tree appearance instead of procedural silhouette.
 */
function createBakedCardMaterial(
  texture: THREE.Texture,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();

  // Use the baked texture directly
  material.map = texture;
  material.transparent = true;
  material.alphaTest = 0.1;
  material.side = THREE.DoubleSide;
  material.depthWrite = true;

  applySkyFog(material);

  return material;
}

/**
 * Generate LOD2 "card tree" using BAKED textures from actual tree geometry.
 *
 * This creates cross-billboard cards with textures rendered from the actual
 * LOD0 tree, ensuring:
 * - Leaves properly cover branches
 * - Accurate silhouette matches the tree
 * - Colors and details are preserved
 *
 * Falls back to procedural if baking is not available.
 */
function generateLOD2CardTreeWithBakedTextures(
  dimensions: { width: number; height: number; trunkHeight: number },
  barkColor: THREE.Color,
  bakedData: BakedCardData,
): { group: THREE.Group; vertexCount: number; triangleCount: number } {
  const group = new THREE.Group();
  group.name = "LOD2_CardTree_Baked";

  const { width, height, trunkHeight } = dimensions;
  const trunkRadius = width * 0.06;
  const { cardWidth, cardHeight, textureX, textureZ } = bakedData;

  // Create simple trunk (3-sided for minimum tris)
  const trunkGeometry = new THREE.CylinderGeometry(
    trunkRadius * 0.6,
    trunkRadius,
    trunkHeight,
    LOD2_CARD_OPTIONS.trunkSegments,
    1,
    false,
  );
  const trunkMaterial = new MeshBasicNodeMaterial();
  trunkMaterial.color = new THREE.Color(barkColor);
  applySkyFog(trunkMaterial);
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
  trunk.position.y = trunkHeight / 2;
  trunk.name = "LOD2_Trunk";
  group.add(trunk);

  // Create card geometry matching baked dimensions
  const cardGeometry = new THREE.PlaneGeometry(cardWidth, cardHeight);

  // Position cards at crown center (accounting for trunk in baked image)
  const crownHeight = height - trunkHeight;
  const crownCenterY = trunkHeight + crownHeight * 0.5;

  // Card 1: Facing X axis - use textureX
  const card1Material = createBakedCardMaterial(textureX);
  const card1 = new THREE.Mesh(cardGeometry, card1Material);
  card1.position.set(0, crownCenterY, 0);
  card1.rotation.y = Math.PI / 2; // Face along X (perpendicular to X axis)
  card1.name = "LOD2_BakedCard_X";
  group.add(card1);

  // Card 2: Facing Z axis - use textureZ
  const card2Material = createBakedCardMaterial(textureZ);
  const card2 = new THREE.Mesh(cardGeometry, card2Material);
  card2.position.set(0, crownCenterY, 0);
  card2.rotation.y = 0; // Face along Z (perpendicular to Z axis)
  card2.name = "LOD2_BakedCard_Z";
  group.add(card2);

  // Calculate stats
  const trunkVerts = (LOD2_CARD_OPTIONS.trunkSegments + 1) * 2;
  const trunkTris = LOD2_CARD_OPTIONS.trunkSegments * 2;
  const cardVerts = 4 * 2;
  const cardTris = 2 * 2;

  return {
    group,
    vertexCount: trunkVerts + cardVerts,
    triangleCount: trunkTris + cardTris,
  };
}

/**
 * Generate LOD2 "card tree" using cross-billboard technique.
 *
 * Cross-billboard: Two perpendicular planes intersecting at center.
 * This is the industry-standard technique for distant vegetation:
 * - Looks good from any viewing angle
 * - Only 4 triangles for the foliage
 * - Procedural crown shader for organic silhouette (fallback)
 * - Crown shape matches tree type (rounded, conical, weeping, etc.)
 *
 * NOTE: When baked textures are available via generateLOD2CardTreeWithBakedTextures,
 * that function should be preferred for accurate tree appearance.
 *
 * Total: ~12 triangles per tree
 */
function generateLOD2CardTree(
  dimensions: { width: number; height: number; trunkHeight: number },
  leafColor: THREE.Color,
  barkColor: THREE.Color,
  presetName: string,
  seed: number = 0,
): { group: THREE.Group; vertexCount: number; triangleCount: number } {
  const crownType = getCrownType(presetName);
  const group = new THREE.Group();
  group.name = "LOD2_CardTree";

  const { width, height, trunkHeight } = dimensions;
  const crownHeight = height - trunkHeight;
  const trunkRadius = width * 0.06; // Thin trunk for LOD2

  // Create simple trunk (3-sided for minimum tris)
  const trunkGeometry = new THREE.CylinderGeometry(
    trunkRadius * 0.6, // Top radius (tapers significantly)
    trunkRadius, // Bottom radius
    trunkHeight,
    LOD2_CARD_OPTIONS.trunkSegments,
    1,
    false, // No caps needed at this distance
  );
  // Use MeshBasicNodeMaterial for WebGPU compatibility
  const trunkMaterial = new MeshBasicNodeMaterial();
  trunkMaterial.color = new THREE.Color(barkColor);
  applySkyFog(trunkMaterial);
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
  trunk.position.y = trunkHeight / 2;
  trunk.name = "LOD2_Trunk";
  group.add(trunk);

  // Create cross-billboard for foliage
  // Two perpendicular planes give good 360° coverage
  const cardWidth = width * LOD2_CARD_OPTIONS.cardSize;
  const cardHeight = crownHeight * 1.1; // Slightly taller to cover crown
  const cardGeometry = new THREE.PlaneGeometry(cardWidth, cardHeight);

  // Procedural crown material with organic leaf-cluster silhouette (TSL for WebGPU)
  const cardMaterial = createProceduralCrownMaterialTSL(
    leafColor,
    crownType,
    seed,
  );

  const crownCenter = trunkHeight + crownHeight * 0.45;

  // Card 1: Facing X axis
  const card1 = new THREE.Mesh(cardGeometry, cardMaterial);
  card1.position.set(0, crownCenter, 0);
  card1.rotation.y = 0; // Face along X
  card1.name = "LOD2_CrossCard_X";
  group.add(card1);

  // Card 2: Facing Z axis (perpendicular to Card 1)
  // Use different seed for visual variation between cards
  const card2Material = createProceduralCrownMaterialTSL(
    leafColor,
    crownType,
    seed + 12345,
  );
  const card2 = new THREE.Mesh(cardGeometry, card2Material);
  card2.position.set(0, crownCenter, 0);
  card2.rotation.y = Math.PI / 2; // Face along Z
  card2.name = "LOD2_CrossCard_Z";
  group.add(card2);

  // Calculate stats
  // Trunk: 3 segments, no caps = 6 verts, 6 tris
  // Cross cards: 2 cards × 4 verts = 8 verts, 2 cards × 2 tris = 4 tris
  const trunkVerts = (LOD2_CARD_OPTIONS.trunkSegments + 1) * 2;
  const trunkTris = LOD2_CARD_OPTIONS.trunkSegments * 2;
  const cardVerts = 4 * LOD2_CARD_OPTIONS.numCrossCards;
  const cardTris = 2 * LOD2_CARD_OPTIONS.numCrossCards;

  return {
    group,
    vertexCount: trunkVerts + cardVerts,
    triangleCount: trunkTris + cardTris,
  };
}

/**
 * Serialize a THREE.Group's meshes to an array of geometries.
 * Also returns leaf instances if found (for cluster generation).
 */
function serializeGroupGeometries(group: THREE.Group): SerializedGeometry[] {
  const geometries: SerializedGeometry[] = [];
  group.traverse((child) => {
    // Skip InstancedMesh (handled separately for leaf instances)
    const isInstancedMesh =
      (child as THREE.Object3D & { isInstancedMesh?: boolean })
        .isInstancedMesh === true;
    if (!isInstancedMesh && child instanceof THREE.Mesh && child.geometry) {
      geometries.push(serializeGeometry(child.geometry));
    }
  });
  return geometries;
}

/**
 * Extract and serialize leaf instances from a tree group.
 * Returns null if no InstancedMesh (leaves) found.
 */
function extractLeafInstances(
  group: THREE.Group,
): SerializedLeafInstances | null {
  let leafInstances: SerializedLeafInstances | null = null;

  group.traverse((child) => {
    const isInstancedMesh =
      (child as THREE.Object3D & { isInstancedMesh?: boolean })
        .isInstancedMesh === true;
    if (isInstancedMesh && !leafInstances) {
      const instancedMesh = child as THREE.InstancedMesh;
      const count = instancedMesh.count;
      const matrices: number[] = [];
      const tempMatrix = new THREE.Matrix4();

      // Extract all instance matrices
      for (let i = 0; i < count; i++) {
        instancedMesh.getMatrixAt(i, tempMatrix);
        matrices.push(...tempMatrix.elements);
      }

      leafInstances = {
        matrices,
        count,
        geometry: serializeGeometry(instancedMesh.geometry),
      };
    }
  });

  return leafInstances;
}

/**
 * Serialize a tree variant for IndexedDB storage.
 */
function serializeTreeVariant(variant: TreeVariant): SerializedTreeVariant {
  return {
    geometries: serializeGroupGeometries(variant.group),
    lod1Geometries: variant.lod1Group
      ? serializeGroupGeometries(variant.lod1Group)
      : undefined,
    lod2Geometries: variant.lod2Group
      ? serializeGroupGeometries(variant.lod2Group)
      : undefined,
    leafInstances: extractLeafInstances(variant.group) ?? undefined,
    dimensions: { ...variant.dimensions },
    leafColor: serializeColor(variant.leafColor),
    barkColor: serializeColor(variant.barkColor),
    vertexCount: variant.vertexCount,
    triangleCount: variant.triangleCount,
    lod1VertexCount: variant.lod1VertexCount,
    lod1TriangleCount: variant.lod1TriangleCount,
    lod2VertexCount: variant.lod2VertexCount,
    lod2TriangleCount: variant.lod2TriangleCount,
  };
}

/**
 * Deserialize a tree variant from IndexedDB storage.
 * Creates simplified meshes from stored geometry - materials are basic.
 */
async function deserializeTreeVariant(
  data: SerializedTreeVariant,
  presetName: string,
): Promise<TreeVariant> {
  const leafColor = deserializeColor(data.leafColor);
  const barkColor = deserializeColor(data.barkColor);

  // Reconstruct LOD0 group from geometries
  const group = new THREE.Group();
  group.name = `Tree_${presetName}_LOD0`;

  // Create meshes from serialized geometries (trunk/branches)
  for (let i = 0; i < data.geometries.length; i++) {
    const geo = deserializeGeometry(data.geometries[i]);
    const mat = new MeshBasicNodeMaterial();

    // Use vertex colors if available, otherwise use bark color
    if (geo.attributes.color) {
      mat.vertexColors = true;
    } else {
      mat.color = barkColor.clone();
    }

    applySkyFog(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = i === 0 ? "Trunk" : `Branch_${i}`;
    group.add(mesh);
  }

  // Recreate leaf InstancedMesh from serialized data (critical for cluster generation)
  if (data.leafInstances && data.leafInstances.count > 0) {
    const leafGeo = deserializeGeometry(data.leafInstances.geometry);
    const leafMat = new MeshBasicNodeMaterial();
    leafMat.color = leafColor.clone();
    leafMat.side = THREE.DoubleSide;
    applySkyFog(leafMat);

    const instancedLeaves = new THREE.InstancedMesh(
      leafGeo,
      leafMat,
      data.leafInstances.count,
    );
    instancedLeaves.name = "Leaves";

    // Restore instance matrices
    const tempMatrix = new THREE.Matrix4();
    for (let i = 0; i < data.leafInstances.count; i++) {
      const offset = i * 16;
      tempMatrix.fromArray(data.leafInstances.matrices, offset);
      instancedLeaves.setMatrixAt(i, tempMatrix);
    }
    instancedLeaves.instanceMatrix.needsUpdate = true;

    group.add(instancedLeaves);
    console.log(
      `[ProcgenTreeCache] Restored ${data.leafInstances.count} leaf instances for ${presetName}`,
    );
  }

  // Reconstruct LOD1 group
  let lod1Group: THREE.Group | null = null;
  if (data.lod1Geometries && data.lod1Geometries.length > 0) {
    lod1Group = new THREE.Group();
    lod1Group.name = `Tree_${presetName}_LOD1`;
    for (let i = 0; i < data.lod1Geometries.length; i++) {
      const geo = deserializeGeometry(data.lod1Geometries[i]);
      const mat = new MeshBasicNodeMaterial();
      if (geo.attributes.color) {
        mat.vertexColors = true;
      } else {
        mat.color = i === 0 ? barkColor.clone() : leafColor.clone();
      }
      applySkyFog(mat);
      const mesh = new THREE.Mesh(geo, mat);
      lod1Group.add(mesh);
    }
  }

  // Regenerate LOD2 trunk mesh (same as initial generation)
  // Falls back to card tree if trunk generation fails
  const seed = VARIANT_SEEDS[0]; // Use first seed for consistency
  let lod2Group: THREE.Group;
  let lod2VertexCount: number;
  let lod2TriangleCount: number;

  // Try trunk-only generation first (matches initial generation behavior)
  const lod2TrunkResult = await generateLOD2Tree(presetName, seed);
  if (lod2TrunkResult) {
    lod2Group = lod2TrunkResult.group;
    lod2VertexCount = lod2TrunkResult.vertexCount;
    lod2TriangleCount = lod2TrunkResult.triangleCount;
  } else {
    // Fallback to card tree
    const lod2CardResult = generateLOD2CardTree(
      data.dimensions,
      leafColor,
      barkColor,
      presetName,
      seed,
    );
    lod2Group = lod2CardResult.group;
    lod2VertexCount = lod2CardResult.vertexCount;
    lod2TriangleCount = lod2CardResult.triangleCount;
  }

  return {
    group,
    lod1Group,
    lod2Group,
    vertexCount: data.vertexCount,
    triangleCount: data.triangleCount,
    lod1VertexCount: data.lod1VertexCount,
    lod1TriangleCount: data.lod1TriangleCount,
    lod2VertexCount,
    lod2TriangleCount,
    dimensions: { ...data.dimensions },
    leafColor,
    barkColor,
  };
}

async function generateVariants(presetName: string): Promise<TreeVariant[]> {
  const loaded = await loadProcgen();

  if (!loaded || !TreeGenerator) {
    return []; // Return empty - caller will fall back to GLB
  }

  const variants: TreeVariant[] = [];
  let totalVerts = 0;
  let totalTris = 0;
  let totalLod1Verts = 0;
  let totalLod1Tris = 0;
  let totalLod2Verts = 0;
  let totalLod2Tris = 0;

  // Helper to yield to main thread - allows WASM loading and other async work
  const yield_ = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  for (let i = 0; i < VARIANTS_PER_PRESET; i++) {
    const seed = VARIANT_SEEDS[i];

    // Yield between variants to prevent blocking main thread during pre-warm
    // This spreads CPU-intensive tree generation across multiple frames
    if (i > 0) {
      await yield_();
    }

    try {
      // Generate LOD0 (full detail) with controlled geometry settings
      const generator = new TreeGenerator(presetName, {
        geometry: LOD0_GEOMETRY_OPTIONS,
      });
      const result = generator.generate(seed);

      // Yield after heavy LOD0 generation to allow WASM loading
      await yield_();

      // Count vertices and triangles for LOD0
      let vertexCount = 0;
      let triangleCount = 0;

      result.group.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry) {
          const geo = child.geometry;
          if (geo.attributes.position) {
            vertexCount += geo.attributes.position.count;
          }
          if (geo.index) {
            triangleCount += geo.index.count / 3;
          } else if (geo.attributes.position) {
            triangleCount += geo.attributes.position.count / 3;
          }
        }
      });

      // Extract metadata from LOD0 for LOD2 generation
      const { leafColor, barkColor, dimensions } = extractTreeMetadata(
        result.group,
      );

      // Generate LOD1 using procgen with trunk-only settings (same seed for visual consistency)
      const lod1Result = await generateLOD1Tree(presetName, seed);

      // Yield after LOD1 generation
      await yield_();

      // Generate LOD2 geometry - prioritize BAKED textures for accurate appearance
      // Baked cards render the actual LOD0 tree to textures (best quality)
      // Falls back to procedural cards if baking not available
      let lod2Result: {
        group: THREE.Group;
        vertexCount: number;
        triangleCount: number;
      };

      if (USE_TRADITIONAL_CARDS_LOD2) {
        // Try to bake actual tree textures for accurate LOD2 cards
        const baker = getTreeCardBaker();
        let bakedData: BakedCardData | null = null;

        if (baker.isReady()) {
          try {
            bakedData = await baker.bakeTreeCards(result.group, dimensions);
          } catch (err) {
            console.warn(
              `[ProcgenTreeCache] Failed to bake tree cards for ${presetName}:`,
              err,
            );
          }
        }

        if (bakedData) {
          // Use baked textures (best quality - actual tree appearance)
          lod2Result = generateLOD2CardTreeWithBakedTextures(
            dimensions,
            barkColor,
            bakedData,
          );
          console.log(
            `[ProcgenTreeCache] ${presetName} LOD2: Using BAKED card tree (${lod2Result.triangleCount} tris)`,
          );
        } else {
          // Fallback to procedural crown shader
          lod2Result = generateLOD2CardTree(
            dimensions,
            leafColor,
            barkColor,
            presetName,
            seed,
          );
          console.log(
            `[ProcgenTreeCache] ${presetName} LOD2: Using procedural card tree (${lod2Result.triangleCount} tris)`,
          );
        }
      } else {
        // Use trunk-only geometry (leaves handled by clusters)
        const trunkResult = await generateLOD2Tree(presetName, seed);
        if (trunkResult) {
          lod2Result = trunkResult;
        } else {
          // Fallback to card tree if trunk generation fails
          lod2Result = generateLOD2CardTree(
            dimensions,
            leafColor,
            barkColor,
            presetName,
            seed,
          );
        }
      }

      // Store the variant
      variants.push({
        group: result.group,
        lod1Group: lod1Result?.group ?? null,
        lod2Group: lod2Result.group,
        vertexCount,
        triangleCount,
        lod1VertexCount: lod1Result?.vertexCount ?? 0,
        lod1TriangleCount: lod1Result?.triangleCount ?? 0,
        lod2VertexCount: lod2Result.vertexCount,
        lod2TriangleCount: lod2Result.triangleCount,
        dimensions,
        leafColor,
        barkColor,
      });

      totalVerts += vertexCount;
      totalTris += triangleCount;
      totalLod1Verts += lod1Result?.vertexCount ?? 0;
      totalLod1Tris += lod1Result?.triangleCount ?? 0;
      totalLod2Verts += lod2Result.vertexCount;
      totalLod2Tris += lod2Result.triangleCount;
    } catch (error) {
      console.error(
        `[ProcgenTreeCache] Failed to generate ${presetName} variant ${i}:`,
        error,
      );
      // Continue with other variants
    }
  }

  // Single log per preset
  if (variants.length > 0) {
    const lod1Reduction =
      totalVerts > 0 ? Math.round((1 - totalLod1Verts / totalVerts) * 100) : 0;
    const lod2Reduction =
      totalVerts > 0 ? Math.round((1 - totalLod2Verts / totalVerts) * 100) : 0;
    console.log(
      `[ProcgenTreeCache] Generated ${variants.length} ${presetName} variants: ` +
        `LOD0=${totalVerts} verts/${Math.round(totalTris)} tris, ` +
        `LOD1=${totalLod1Verts} verts/${Math.round(totalLod1Tris)} tris (${lod1Reduction}% reduction), ` +
        `LOD2=${totalLod2Verts} verts/${Math.round(totalLod2Tris)} tris (${lod2Reduction}% reduction)`,
    );

    // Save to IndexedDB for persistence
    const serialized = variants.map(serializeTreeVariant);
    procgenCacheDB
      .saveCachedVariants("trees", presetName, serialized, CACHE_VERSION)
      .catch((err) =>
        console.warn(
          `[ProcgenTreeCache] Failed to persist ${presetName}:`,
          err,
        ),
      );

    // Register first variant with instancer for batched rendering
    // All instances will share this geometry via instancing
    if (worldRef && variants.length > 0) {
      try {
        const instancer = ProcgenTreeInstancer.getInstance(worldRef);
        instancer.registerPreset(
          presetName,
          variants[0].group,
          variants[0].lod1Group,
          variants[0].lod2Group,
        );
      } catch (error) {
        console.warn(
          `[ProcgenTreeCache] Failed to register with instancer:`,
          error,
        );
      }
    }
  }

  return variants;
}

/**
 * Get or create the cache entry for a preset.
 */
function getOrCreateCacheEntry(presetName: string): PresetCache {
  let cache = presetCache.get(presetName);
  if (!cache) {
    cache = {
      variants: [],
      loading: false,
      loadPromise: null,
    };
    presetCache.set(presetName, cache);
  }
  return cache;
}

/**
 * Ensure variants are loaded for a preset.
 * Checks IndexedDB cache first, generates only if not found.
 */
async function ensureVariantsLoaded(presetName: string): Promise<PresetCache> {
  const cache = getOrCreateCacheEntry(presetName);

  if (cache.variants.length > 0) {
    return cache;
  }

  if (cache.loading && cache.loadPromise) {
    await cache.loadPromise;
    return cache;
  }

  cache.loading = true;
  cache.loadPromise = (async () => {
    try {
      // Try to load from IndexedDB first
      const cached =
        await procgenCacheDB.loadCachedVariants<SerializedTreeVariant>(
          "trees",
          presetName,
          CACHE_VERSION,
        );

      if (cached && cached.length > 0) {
        // Deserialize from cache (async due to LOD2 trunk generation)
        cache.variants = await Promise.all(
          cached.map((data) => deserializeTreeVariant(data, presetName)),
        );
        console.log(
          `[ProcgenTreeCache] Loaded ${cache.variants.length} cached variants for "${presetName}"`,
        );

        // Register first variant with instancer for batched rendering
        if (worldRef && cache.variants.length > 0) {
          try {
            const instancer = ProcgenTreeInstancer.getInstance(worldRef);
            instancer.registerPreset(
              presetName,
              cache.variants[0].group,
              cache.variants[0].lod1Group,
              cache.variants[0].lod2Group,
            );
          } catch (error) {
            console.warn(
              `[ProcgenTreeCache] Failed to register with instancer:`,
              error,
            );
          }
        }
      } else {
        // Generate fresh variants
        cache.variants = await generateVariants(presetName);
      }
    } finally {
      cache.loading = false;
    }
  })();

  await cache.loadPromise;
  return cache;
}

/**
 * Get a deterministic variant index from an entity ID or seed.
 *
 * @param entityIdOrSeed - Entity ID string or numeric seed
 * @returns Variant index (0 to VARIANTS_PER_PRESET-1)
 */
export function getVariantIndex(entityIdOrSeed: string | number): number {
  let hash: number;

  if (typeof entityIdOrSeed === "number") {
    hash = entityIdOrSeed;
  } else {
    // Simple string hash
    hash = 0;
    for (let i = 0; i < entityIdOrSeed.length; i++) {
      hash = (hash * 31 + entityIdOrSeed.charCodeAt(i)) | 0;
    }
  }

  return Math.abs(hash) % VARIANTS_PER_PRESET;
}

/**
 * Get a tree mesh clone for a given preset and entity.
 *
 * Returns a clone of a pre-generated variant. The clone shares geometry
 * but has its own transform, allowing efficient instancing-like behavior.
 *
 * @param presetName - Procgen preset name (e.g., "blackOak", "weepingWillow")
 * @param entityIdOrSeed - Entity ID or seed for deterministic variant selection
 * @returns Promise resolving to cloned tree group, or null if unavailable
 */
export async function getTreeMeshClone(
  presetName: string,
  entityIdOrSeed: string | number,
): Promise<THREE.Group | null> {
  // Early exit on server
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const cache = await ensureVariantsLoaded(presetName);

    if (cache.variants.length === 0) {
      // Don't warn - this is expected if procgen failed to load
      return null;
    }

    const variantIndex = getVariantIndex(entityIdOrSeed);
    const variant = cache.variants[variantIndex % cache.variants.length];

    // Clone the group (shares geometry, creates new Object3D hierarchy)
    const clone = variant.group.clone(true);

    return clone;
  } catch (error) {
    console.error(
      `[ProcgenTreeCache] Error getting tree mesh for ${presetName}:`,
      error,
    );
    return null;
  }
}

/**
 * Get a LOD1 (decimated) tree mesh clone for a given preset and entity.
 *
 * Returns a clone of the pre-generated LOD1 variant with reduced polygon count.
 * Used for medium-distance rendering before impostor kicks in.
 *
 * @param presetName - Procgen preset name (e.g., "blackOak", "weepingWillow")
 * @param entityIdOrSeed - Entity ID or seed for deterministic variant selection
 * @returns Promise resolving to cloned LOD1 group, or null if unavailable
 */
export async function getTreeLOD1Clone(
  presetName: string,
  entityIdOrSeed: string | number,
): Promise<THREE.Group | null> {
  // Early exit on server
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const cache = await ensureVariantsLoaded(presetName);

    if (cache.variants.length === 0) {
      return null;
    }

    const variantIndex = getVariantIndex(entityIdOrSeed);
    const variant = cache.variants[variantIndex % cache.variants.length];

    // Return null if LOD1 wasn't generated
    if (!variant.lod1Group) {
      return null;
    }

    // Clone the LOD1 group
    const clone = variant.lod1Group.clone(true);

    return clone;
  } catch (error) {
    console.error(
      `[ProcgenTreeCache] Error getting LOD1 mesh for ${presetName}:`,
      error,
    );
    return null;
  }
}

/**
 * Yield to the main event loop.
 * Uses requestIdleCallback for better scheduling when available,
 * falls back to setTimeout for compatibility.
 */
function yieldToMainThread(delayMs = 10): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== "undefined") {
      // Use requestIdleCallback for better scheduling - yields when browser is idle
      requestIdleCallback(() => resolve(), { timeout: 100 });
    } else {
      // Fallback: setTimeout with small delay to allow other async tasks
      setTimeout(resolve, delayMs);
    }
  });
}

/**
 * Pre-warm the cache for common presets.
 * Call this during game initialization to avoid hitches during gameplay.
 * Does nothing on server.
 *
 * This function processes presets sequentially (not in parallel) and yields
 * between each preset to allow other important initialization tasks like
 * WASM loading to get CPU time. This prevents PhysX WASM timeouts during
 * heavy tree generation.
 *
 * @param presetNames - Array of preset names to pre-load
 */
export async function prewarmCache(presetNames: string[]): Promise<void> {
  // Skip on server
  if (typeof window === "undefined") {
    return;
  }

  // Try to load procgen first
  const loaded = await loadProcgen();
  if (!loaded) {
    console.warn("[ProcgenTreeCache] Procgen not available, skipping pre-warm");
    return;
  }

  console.log(
    `[ProcgenTreeCache] Pre-warming cache for ${presetNames.length} presets (sequential with yielding)...`,
  );

  const startTime = Date.now();

  // Process presets sequentially with yielding between each
  // This prevents blocking the main thread for too long and allows
  // other important async work (like WASM instantiation) to complete
  for (let i = 0; i < presetNames.length; i++) {
    const name = presetNames[i];

    // Yield before each preset (except the first) to give other tasks CPU time
    // This is critical for allowing PhysX WASM to load during tree generation
    if (i > 0) {
      await yieldToMainThread();
    }

    await ensureVariantsLoaded(name);

    // Log progress periodically
    if ((i + 1) % 4 === 0 || i === presetNames.length - 1) {
      console.log(
        `[ProcgenTreeCache] Pre-warm progress: ${i + 1}/${presetNames.length} presets`,
      );
    }
  }

  const elapsed = Date.now() - startTime;
  const stats = getCacheStats();
  console.log(
    `[ProcgenTreeCache] Pre-warm complete in ${elapsed}ms (${stats.totalVariants} variants, ${stats.totalVertices} verts)`,
  );
}

/**
 * Get cache statistics for debugging.
 */
export function getCacheStats(): {
  presetCount: number;
  totalVariants: number;
  totalVertices: number;
  totalTriangles: number;
  lod1Vertices: number;
  lod1Triangles: number;
} {
  let totalVariants = 0;
  let totalVertices = 0;
  let totalTriangles = 0;
  let lod1Vertices = 0;
  let lod1Triangles = 0;

  for (const cache of presetCache.values()) {
    totalVariants += cache.variants.length;
    for (const variant of cache.variants) {
      totalVertices += variant.vertexCount;
      totalTriangles += variant.triangleCount;
      lod1Vertices += variant.lod1VertexCount;
      lod1Triangles += variant.lod1TriangleCount;
    }
  }

  return {
    presetCount: presetCache.size,
    totalVariants,
    totalVertices,
    totalTriangles: Math.round(totalTriangles),
    lod1Vertices,
    lod1Triangles: Math.round(lod1Triangles),
  };
}

/**
 * Clear the cache (for testing or memory management).
 */
/**
 * Clear the cache (memory only, for testing or memory management).
 */
export function clearCache(): void {
  for (const cache of presetCache.values()) {
    for (const variant of cache.variants) {
      // Dispose geometries and materials
      variant.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (child.geometry) {
            child.geometry.dispose();
          }
          if (child.material) {
            const materials = Array.isArray(child.material)
              ? child.material
              : [child.material];
            for (const mat of materials) {
              mat.dispose();
            }
          }
        }
      });
    }
  }

  presetCache.clear();
  console.log("[ProcgenTreeCache] Memory cache cleared");
}

/**
 * Clear all cached tree variants (memory + IndexedDB).
 * Use this to force regeneration on next load.
 */
export async function clearCacheAll(): Promise<void> {
  clearCache();
  await procgenCacheDB.clearStore("trees");
  console.log("[ProcgenTreeCache] All caches cleared (memory + IndexedDB)");
}

/**
 * Check if procgen module is available.
 * Returns false on server or if procgen failed to load.
 */
export function isProcgenAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return procgenLoaded && !procgenLoadFailed;
}

/**
 * Get the number of variants per preset.
 */
export function getVariantsPerPreset(): number {
  return VARIANTS_PER_PRESET;
}

/**
 * All procgen tree presets used in the game.
 * Use with prewarmCache() to load all variants at startup.
 */
export const TREE_PRESETS = [
  "quakingAspen", // tree_normal
  "blackOak", // tree_oak
  "weepingWillow", // tree_willow
  "blackTupelo", // tree_teak
  "acer", // tree_maple
  "sassafras", // tree_mahogany
  "europeanLarch", // tree_yew
  "hillCherry", // tree_magic
] as const;

export type TreePreset = (typeof TREE_PRESETS)[number];

/**
 * Add a tree instance using instanced rendering.
 * This is the preferred method for rendering procgen trees - uses batched draw calls.
 *
 * @param presetName - Tree preset name
 * @param entityId - Unique entity ID
 * @param position - World position
 * @param rotation - Y-axis rotation in radians
 * @param scale - Uniform scale
 * @param lodLevel - LOD level (0 or 1)
 * @returns True if instance was added
 */
export async function addTreeInstance(
  presetName: string,
  entityId: string,
  position: THREE.Vector3,
  rotation: number,
  scale: number,
  lodLevel: number = 0,
): Promise<boolean> {
  // Ensure variants are loaded first
  await ensureVariantsLoaded(presetName);

  if (!worldRef) {
    console.warn("[ProcgenTreeCache] World not set - cannot add instance");
    return false;
  }

  try {
    const instancer = ProcgenTreeInstancer.getInstance(worldRef);
    return instancer.addInstance(
      presetName,
      entityId,
      position,
      rotation,
      scale,
      lodLevel,
    );
  } catch (error) {
    console.warn("[ProcgenTreeCache] Failed to add instance:", error);
    return false;
  }
}

/**
 * Remove a tree instance.
 */
export function removeTreeInstance(
  presetName: string,
  entityId: string,
  lodLevel: number = 0,
): void {
  if (!worldRef) return;

  try {
    const instancer = ProcgenTreeInstancer.getInstance(worldRef);
    instancer.removeInstance(presetName, entityId, lodLevel);
  } catch (error) {
    console.warn(
      `[ProcgenTreeCache] Failed to remove instance ${entityId} from ${presetName}:`,
      error,
    );
  }
}

/**
 * Update instanced tree matrices, LOD transitions, and wind animation.
 * Call once per frame from the game loop.
 *
 * @param cameraPosition - Optional camera position for LOD calculations
 * @param deltaTime - Time since last frame in seconds (for wind animation)
 */
export function updateTreeInstances(
  cameraPosition?: THREE.Vector3,
  deltaTime: number = 0.016,
): void {
  if (!worldRef) return;

  const instancer = ProcgenTreeInstancer.getInstance(worldRef);
  instancer.update(cameraPosition, deltaTime);
}

/**
 * Get instancing statistics.
 */
export function getTreeInstanceStats(): {
  presets: number;
  totalInstances: number;
  drawCalls: number;
  byLOD: {
    lod0: number;
    lod1: number;
    lod2: number;
    impostor: number;
    culled: number;
  };
  details: Record<
    string,
    { lod0: number; lod1: number; lod2: number; impostor: number }
  >;
} | null {
  if (!worldRef) return null;

  try {
    const instancer = ProcgenTreeInstancer.getInstance(worldRef);
    return instancer.getStats();
  } catch (error) {
    console.warn("[ProcgenTreeCache] Failed to get instancer stats:", error);
    return null;
  }
}

/**
 * Get instancing statistics (alias for getTreeInstanceStats with globalLeaves).
 * Used by DevStats for displaying tree instancing information.
 */
export function getInstancingStats(): {
  presets: number;
  totalInstances: number;
  drawCalls: number;
  byLOD: {
    lod0: number;
    lod1: number;
    lod2: number;
    impostor: number;
    culled: number;
  };
  details: Record<
    string,
    { lod0: number; lod1: number; lod2: number; impostor: number }
  >;
  globalLeaves: { count: number } | null;
} | null {
  const stats = getTreeInstanceStats();
  if (!stats) return null;

  // Add globalLeaves for backwards compatibility with DevStats
  return {
    ...stats,
    globalLeaves: null, // No leaf data currently tracked
  };
}
