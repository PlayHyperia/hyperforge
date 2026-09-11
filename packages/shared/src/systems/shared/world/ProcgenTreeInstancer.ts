/**
 * ProcgenTreeInstancer - AAA Instanced Rendering for Procedural Trees
 *
 * Architecture:
 * - TRUNK INSTANCING: Each tree's trunk/branches are instanced per-tree
 * - GLOBAL LEAF INSTANCING: All leaves across all trees share ONE InstancedMesh
 *   - Single leaf card geometry (2 triangles)
 *   - Per-leaf attributes: world transform, color, fade
 *   - ONE draw call for ALL leaves = massive performance win
 *
 * Features:
 * - Cross-fade LOD transitions (AAA-1): Screen-space dithering dissolve
 * - Wind animation (AAA-2): TSL vertex shader displacement on leaves
 * - Shadow LODs (AAA-3): Simplified cone+cylinder shadow geometry
 * - Vertex color batching (AAA-4): Single material per LOD level
 * - GPU-instanced leaves (AAA-5): Single draw call for all foliage
 *
 * LOD Levels: LOD0 (0-30m) → LOD1 (30-60m) → LOD2 (60-120m) → Impostor (120-200m) → Culled
 */

import type { Node } from "three/webgpu";
import THREE, {
  uniform,
  Fn,
  float,
  vec2,
  vec3,
  add,
  sub,
  mul,
  div,
  sin,
  cos,
  fract,
  floor,
  sqrt,
  smoothstep,
  mix,
  atan,
  abs,
  max,
  dot,
  normalize,
  positionLocal,
  positionWorld,
  normalWorld,
  cameraPosition,
  screenUV,
  viewportSize,
  uv,
  attribute,
  instanceIndex,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  Discard,
  If,
} from "../../../extras/three/three";
import type { World } from "../../../core/World";
import type { UniformNode } from "three/webgpu";
import {
  ImpostorManager,
  BakePriority,
  ImpostorBakeMode,
} from "../rendering/ImpostorManager";
import {
  createTSLImpostorMaterial,
  buildOctahedronMesh,
  lerpOctahedronGeometry,
  OctahedronType,
  type TSLImpostorMaterial,
} from "@hyperforge/impostor";
import type { Wind } from "./Wind";
import { applySkyFog } from "./FogConfig";

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_INSTANCES = 2000;
const LOD_FADE_MS = 300;
const LOD_UPDATE_MS = 100;
const LOD_UPDATES_PER_FRAME = 50;
const IMPOSTOR_SIZE = 1024;
const HYSTERESIS_SQ = 25; // 5m buffer

/**
 * Tree LOD configuration - mobile-optimized defaults.
 * Can be modified via setTreeLODConfig() before initialization.
 *
 * LOD levels:
 * - LOD0 (0-25m): Trunk + first branches, full leaf clusters
 * - LOD1 (25-50m): Trunk only, 50% leaf clusters
 * - LOD2 (50-100m): Trunk only, 20% leaf clusters (80% culled)
 * - Impostor (100-150m): Octahedral billboard
 * - Culled (150m+): Not rendered
 */
export interface TreeLODConfig {
  lod1: number; // Distance where LOD1 starts
  lod2: number; // Distance where LOD2 starts
  impostor: number; // Distance where impostor starts
  cull: number; // Distance where trees are culled
}

// LOD distances - AAA progressive detail reduction:
// LOD0: Full trunk + branches + individual instanced leaves
// LOD1: Trunk + primary branches + cluster cards (reduced leaves)
// LOD2: Trunk only + cluster cards (minimal leaves)
// Impostor: Octahedral billboard for very distant trees
const DEFAULT_LOD_CONFIG: TreeLODConfig = {
  lod1: 35, // LOD1 starts at 35m - switch to cluster cards
  lod2: 70, // LOD2 starts at 70m - trunk + sparse clusters
  impostor: 110, // Impostor at 110m - billboard only
  cull: 160, // Trees culled at 160m
};

// Distance-based fade zone - trees dissolve in/out over this distance
// Trees are invisible at cull distance, fully visible at (cull - FADE_ZONE_DISTANCE)
const FADE_ZONE_DISTANCE = 10; // 10 meters of fade

// Computed fade zone boundaries (updated by setTreeLODConfig)
const FADE_ZONE_SQ = {
  start: (DEFAULT_LOD_CONFIG.cull - FADE_ZONE_DISTANCE) ** 2, // 100m squared
  end: DEFAULT_LOD_CONFIG.cull ** 2, // 110m squared
};

// Current LOD configuration (mutable)
let LOD_CONFIG = { ...DEFAULT_LOD_CONFIG };

/**
 * Set custom LOD distances for tree rendering.
 * Call this before game initialization to customize thresholds.
 *
 * @param config - Partial config to override defaults
 */
export function setTreeLODConfig(config: Partial<TreeLODConfig>): void {
  LOD_CONFIG = { ...LOD_CONFIG, ...config };
  // Recompute squared distances
  LOD_DIST_SQ.lod1 = LOD_CONFIG.lod1 ** 2;
  LOD_DIST_SQ.lod2 = LOD_CONFIG.lod2 ** 2;
  LOD_DIST_SQ.impostor = LOD_CONFIG.impostor ** 2;
  LOD_DIST_SQ.cull = LOD_CONFIG.cull ** 2;
  // Update fade zone boundaries
  FADE_ZONE_SQ.start = (LOD_CONFIG.cull - FADE_ZONE_DISTANCE) ** 2;
  FADE_ZONE_SQ.end = LOD_CONFIG.cull ** 2;
  console.log(
    `[TreeInstancer] LOD config updated:`,
    LOD_CONFIG,
    `Fade zone: ${LOD_CONFIG.cull - FADE_ZONE_DISTANCE}m - ${LOD_CONFIG.cull}m`,
  );
}

/**
 * Get current LOD configuration.
 */
export function getTreeLODConfig(): TreeLODConfig {
  return { ...LOD_CONFIG };
}

// Legacy alias for backwards compatibility
const LOD_DIST = LOD_CONFIG;

// Pre-computed squared distances for fast comparisons
const LOD_DIST_SQ = {
  lod1: LOD_CONFIG.lod1 ** 2,
  lod2: LOD_CONFIG.lod2 ** 2,
  impostor: LOD_CONFIG.impostor ** 2,
  cull: LOD_CONFIG.cull ** 2,
};

const WIND = {
  speed: 0.8,
  maxBend: 0.25,
  heightThreshold: 0.3,
  spatialFreq: 0.08,
  gustSpeed: 0.4,
};

/**
 * IMPOSTOR DISABLE FLAG
 * When true, trees use dissolve fade-out at distance instead of impostor billboards.
 * When false, trees transition to octahedral impostors at far distance.
 *
 * Set to false for AAA quality with proper impostor LOD.
 */
const DISABLE_IMPOSTORS = true;

/**
 * ENABLE INDIVIDUAL LEAVES (LOD0)
 * When true, LOD0 shows computational instanced leaves via GlobalLeafInstancer.
 * These are high-detail individual leaf quads with wind animation.
 */
const ENABLE_LOD0_LEAVES = true;

/**
 * ENABLE CLUSTER CARDS (LOD1)
 * When true, LOD1 shows procedural billboard clusters via GlobalLeafClusterInstancer.
 * This provides SpeedTree-style cluster cards for medium distance viewing.
 *
 * AAA trees need this for proper detail reduction at LOD1.
 */
const ENABLE_LOD1_CLUSTERS = true;

/**
 * ENABLE LOD2 CLUSTERS
 * When true, LOD2 uses sparse clusters (20% density).
 * This provides minimal foliage representation before transitioning to impostors.
 *
 * AAA trees need this for smooth LOD2 rendering.
 */
const ENABLE_LOD2_CLUSTERS = true;

/**
 * SKIP LOD2 MESH ENTIRELY
 * When true, LOD2 mesh registration is skipped - trees only use LOD0 and LOD1.
 * When false, LOD2 shows trunk with cluster cards.
 *
 * Set to false for proper LOD2 rendering.
 */
const SKIP_LOD2_MESH = false;

/**
 * Leaf cluster density per LOD level.
 * Using clusters everywhere for mobile performance:
 * - LOD0: Full density (100%) - close-up view
 * - LOD1: Half density (50%) - medium distance
 * - LOD2: Sparse density (20%) - far distance
 * - LOD3+: No clusters (impostors have baked leaves)
 *
 * NOTE: Ignored when DISABLE_CLUSTERS is true.
 */
export interface ClusterDensityConfig {
  lod0: number; // 0-1 (1.0 = 100%)
  lod1: number;
  lod2: number;
}

const DEFAULT_CLUSTER_DENSITY: ClusterDensityConfig = {
  lod0: 1.0, // 100% - full clusters at close range
  lod1: 0.5, // 50% - half clusters at medium range
  lod2: 0.2, // 20% - sparse clusters at far range
};

let CLUSTER_DENSITY = { ...DEFAULT_CLUSTER_DENSITY };

/**
 * Set custom cluster density per LOD level.
 * @param config - Partial config to override defaults
 */
export function setClusterDensityConfig(
  config: Partial<ClusterDensityConfig>,
): void {
  CLUSTER_DENSITY = { ...CLUSTER_DENSITY, ...config };
  console.log(`[TreeInstancer] Cluster density config:`, CLUSTER_DENSITY);
}

/**
 * Get current cluster density configuration.
 */
export function getClusterDensityConfig(): ClusterDensityConfig {
  return { ...CLUSTER_DENSITY };
}

// ============================================================================
// TYPES
// ============================================================================

interface TreeInstance {
  id: string;
  position: THREE.Vector3;
  rotation: number;
  scale: number;
  currentLOD: number; // 0-4: lod0, lod1, lod2, impostor, culled
  lodIndices: [number, number, number, number]; // [lod0, lod1, lod2, impostor] mesh indices
  transition: { from: number; to: number; start: number } | null;
  radius: number;
  hasGlobalLeaves: boolean; // Has individual leaves (LOD0 only)
  clusterLOD: number; // Current cluster LOD level (-1 = no clusters, 1-2 = clusters)
  clusterDensity: number; // Current cluster density (0-1)
  distanceFade: number; // Distance-based fade (0 = culled, 1 = fully visible)
}

interface MeshData {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  mesh: THREE.InstancedMesh;
  fadeAttr: THREE.InstancedBufferAttribute;
  idxToId: Map<number, string>;
  nextIdx: number;
  count: number;
  dirty: boolean;
  shadowMesh: THREE.InstancedMesh | null;
  shadowGeo: THREE.BufferGeometry | null;
}

interface ImpostorMeshData {
  geometry: THREE.BufferGeometry;
  material: TSLImpostorMaterial;
  mesh: THREE.InstancedMesh;
  idxToId: Map<number, string>;
  nextIdx: number;
  count: number;
  dirty: boolean;
  width: number;
  height: number;
}

interface TreeDims {
  width: number;
  height: number;
  canopyR: number;
  trunkH: number;
}

interface WindMat extends THREE.MeshStandardNodeMaterial {
  windUniforms: {
    time: { value: number };
    strength: { value: number };
    direction: { value: THREE.Vector3 };
  };
}

type LODKey = "lod0" | "lod1" | "lod2";

interface LeafNodeMaterial extends THREE.MeshStandardNodeMaterial {
  leafUniforms: {
    time: UniformNode<"float", number>;
    windStrength: UniformNode<"float", number>;
    windDirection: UniformNode<"vec3", THREE.Vector3>;
    baseColor: UniformNode<"color", THREE.Color>;
    sunDirection: UniformNode<"vec3", THREE.Vector3>;
    dayNightMix: UniformNode<"float", number>;
  };
}

// ============================================================================
// GLOBAL LEAF INSTANCER
// ============================================================================

const MAX_GLOBAL_LEAVES = 100000; // 100K leaves total capacity
const LEAF_CARD_SIZE = 0.15; // Base leaf card size in meters

/**
 * Global leaf instance manager - renders ALL leaves with ONE draw call.
 *
 * Instead of merging leaf geometry into each tree, we maintain a global
 * buffer of leaf transforms. When a tree is shown/hidden/LOD-changed,
 * we update its leaves' visibility in the global buffer.
 *
 * IMPLEMENTATION NOTES:
 * - Uses TSL positionNode for vertex shader wind animation (verified pattern from ProceduralGrass.ts)
 * - mesh.layers.set(1) must match camera layer configuration for visibility
 * - Wind uniforms are updated via leafUniforms.xxx.value property (TSL uniform pattern)
 * - Pre-allocates MAX_GLOBAL_LEAVES matrices (~6.4MB) - adjust for mobile if needed
 */
class GlobalLeafInstancer {
  private geometry: THREE.BufferGeometry;
  private material: LeafNodeMaterial;
  private mesh: THREE.InstancedMesh;

  // Instance attributes
  private matrices: THREE.Matrix4[];
  private colors: Float32Array;
  private fades: Float32Array;
  private matrixAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private fadeAttr: THREE.InstancedBufferAttribute;

  // Bookkeeping
  private leafMap: Map<string, number[]> = new Map(); // treeId -> leaf indices
  private freeIndices: number[] = [];
  private nextIndex = 0;
  private count = 0;
  private dirty = false;

  // Wind uniforms
  private windTime = 0;
  private windStrength = 1;
  private windDir = new THREE.Vector3(1, 0, 0);

  constructor(scene: THREE.Scene) {
    // Create single leaf card geometry (2 triangles)
    this.geometry = this.createLeafCardGeometry();

    // Create instanced leaf material with wind animation
    this.material = this.createLeafMaterial();

    // Create instanced mesh
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_GLOBAL_LEAVES,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = "GlobalLeaves";
    this.mesh.layers.set(1); // Match other tree meshes for camera layer filtering
    scene.add(this.mesh);

    // Initialize instance arrays
    this.matrices = new Array(MAX_GLOBAL_LEAVES)
      .fill(null)
      .map(() => new THREE.Matrix4());
    this.colors = new Float32Array(MAX_GLOBAL_LEAVES * 3);
    this.fades = new Float32Array(MAX_GLOBAL_LEAVES).fill(1);

    // Create custom attributes for color and fade
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("instanceColor", this.colorAttr);

    this.fadeAttr = new THREE.InstancedBufferAttribute(this.fades, 1);
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("instanceFade", this.fadeAttr);

    // Matrix attribute is built into InstancedMesh
    this.matrixAttr = this.mesh
      .instanceMatrix as THREE.InstancedBufferAttribute;
  }

  private createLeafCardGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const s = LEAF_CARD_SIZE;

    // Simple quad centered at origin
    const positions = new Float32Array([
      -s,
      0,
      0, // bottom-left
      s,
      0,
      0, // bottom-right
      s,
      s * 1.5,
      0, // top-right
      -s,
      s * 1.5,
      0, // top-left
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

  private createLeafMaterial(): LeafNodeMaterial {
    const material = new MeshStandardNodeMaterial();

    // Create uniforms for wind animation
    const uTime = uniform(0);
    const uWindStrength = uniform(1);
    const uWindDirection = uniform(new THREE.Vector3(1, 0, 0));
    const uBaseColor = uniform(new THREE.Color(0x3d7a3d));
    // Lighting uniforms for day/night cycle
    const uSunDirection = uniform(new THREE.Vector3(0.5, 1.0, 0.3).normalize());
    const uDayNightMix = uniform(1.0); // 1.0 = full day, 0.0 = night

    // Get per-instance attributes
    const instanceColor = attribute<"vec3">("instanceColor", "vec3");
    const instanceFade = attribute<"float">("instanceFade", "float");

    // Wind animation constants
    const WIND_SPEED = 2.0;
    const WIND_AMPLITUDE = 0.08;
    const GUST_SPEED = 0.7;
    const GUST_AMPLITUDE = 0.03;

    // Position node with ACTUAL wind animation
    // This displaces leaf vertices based on wind uniforms
    const positionNode = Fn(() => {
      const pos = positionLocal;

      // Use world position (approximated from local) for spatial variation
      // Leaves higher in local space sway more
      const heightFactor = smoothstep(
        0.0,
        0.3,
        pos.y.div(LEAF_CARD_SIZE * 1.5),
      );

      // Main wind wave using time and position for spatial coherence
      const phase = add(mul(pos.x, 0.5), mul(pos.z, 0.7));
      const mainWave = sin(add(mul(uTime, WIND_SPEED), phase));

      // Secondary gust wave at different frequency
      const gustPhase = mul(phase, 1.3);
      const gustWave = sin(add(mul(uTime, GUST_SPEED), gustPhase));

      // Combine waves with wind strength
      const waveSum = add(
        mul(mainWave, WIND_AMPLITUDE),
        mul(gustWave, GUST_AMPLITUDE),
      );
      const displacement = mul(mul(waveSum, heightFactor), uWindStrength);

      // Apply displacement along wind direction
      const offsetX = mul(displacement, uWindDirection.x);
      const offsetZ = mul(displacement, uWindDirection.z);

      return vec3(add(pos.x, offsetX), pos.y, add(pos.z, offsetZ));
    })();

    material.positionNode = positionNode;

    // Color node: provides diffuse color for PBR lighting (returns vec3)
    // Uses instance color directly - each leaf gets its tree's color from the instance attribute
    material.colorNode = Fn(() => {
      // Get the instance color length to check if it's valid (non-black)
      const colorLen = add(
        add(instanceColor.x, instanceColor.y),
        instanceColor.z,
      );

      // If instance color is set (sum > 0.03), use it. Otherwise use base color uniform.
      const useInstanceColor = smoothstep(0.03, 0.1, colorLen);
      const baseColor = mix(uBaseColor, instanceColor, useInstanceColor);

      // Add subtle variation based on UV for more natural look
      const uvCoord = uv();
      const variation = mul(sub(uvCoord.y, 0.5), 0.08); // Slightly darker at bottom
      const variedColor = add(baseColor, vec3(variation, variation, variation));

      return variedColor; // vec3 for colorNode
    })();

    // ========== LEAF SHAPE FUNCTION ==========
    // Define leaf shape as a separate function (matching procgen pattern)
    const getLeafAlpha = Fn(([uvCoord]: [Node<"vec2">]) => {
      // Centered coordinates
      const px = sub(uvCoord.x, float(0.5));
      const py = sub(uvCoord.y, float(0.35));

      // Normalized Y (0 at stem, 1 at tip)
      const normalizedY = add(mul(py, float(1.3)), float(0.5));

      // Width profile - widest at ~40%, tapers toward tip
      const widthProfile = mul(
        smoothstep(float(0.0), float(0.4), normalizedY),
        sub(float(1.0), smoothstep(float(0.4), float(1.0), normalizedY)),
      );
      const baseTaper = add(float(0.3), mul(widthProfile, float(0.7)));

      // Pointed tip taper
      const tipTaper = smoothstep(float(0.65), float(0.95), normalizedY);
      const effectiveWidth = mul(
        baseTaper,
        sub(float(1.0), mul(tipTaper, float(0.7))),
      );

      // Subtle serration
      const serration = mul(
        sin(mul(normalizedY, float(24.0))),
        mul(float(0.06), sub(float(1.0), tipTaper)),
      );

      // Calculate leaf boundary
      const maxHalfWidth = add(mul(effectiveWidth, float(0.4)), serration);
      const insideWidth = sub(
        float(1.0),
        smoothstep(mul(maxHalfWidth, float(0.85)), maxHalfWidth, abs(px)),
      );

      // Length mask
      const lengthMask = mul(
        smoothstep(float(-0.1), float(0.08), normalizedY),
        smoothstep(float(1.02), float(0.88), normalizedY),
      );

      return mul(insideWidth, lengthMask);
    });

    // ========== OPACITY NODE ==========
    // Handles leaf shape cutout, LOD fade, and view-dependent culling
    const opacityNode = Fn(() => {
      const uvCoord = uv();
      const leafAlpha = getLeafAlpha(uvCoord);

      // Dither-based fade for LOD transitions
      const screenCoord = mul(screenUV, viewportSize);
      const ditherS = add(
        mul(screenCoord.x, float(12.9898)),
        mul(screenCoord.y, float(78.233)),
      );
      const ditherVal = fract(mul(sin(ditherS), float(43758.5453)));
      const fadeAlpha = smoothstep(
        float(0.0),
        float(0.1),
        sub(instanceFade, ditherVal),
      );

      // View-dependent culling: fade out leaves facing away from camera
      // This reduces overdraw by ~30-40% without pre-baking visibility
      const worldPos = positionWorld;
      const viewDir = normalize(sub(cameraPosition, worldPos));
      const worldNorm = normalWorld;

      // Dot product: 1 = facing camera, -1 = facing away
      const NdotV = dot(worldNorm, viewDir);

      // Smooth falloff: fully visible when facing camera (NdotV > 0.1),
      // fades to 0 when facing away (NdotV < -0.3)
      // This keeps leaves visible from the side but culls back-facing ones
      const viewCull = smoothstep(float(-0.3), float(0.1), NdotV);

      return mul(mul(leafAlpha, fadeAlpha), viewCull);
    });

    material.opacityNode = opacityNode();

    // Emissive node: Subsurface scattering for backlit leaves
    // Simulates light passing through leaves when backlit by the sun
    const emissiveNode = Fn(() => {
      // Get base leaf color for subsurface tint
      const colorLen = add(
        add(instanceColor.x, instanceColor.y),
        instanceColor.z,
      );
      const useInstanceColor = smoothstep(0.03, 0.1, colorLen);
      const leafColor = mix(uBaseColor, instanceColor, useInstanceColor);

      // View direction (from fragment to camera)
      const worldPos = positionWorld;
      const viewDir = normalize(sub(cameraPosition, worldPos));

      // World normal
      const worldNorm = normalWorld;

      // Check if backlit: light coming through the leaf from behind
      const NdotSun = dot(worldNorm, uSunDirection);
      const VdotSun = dot(viewDir, uSunDirection);

      // Backlit when normal faces away from sun but we're looking toward sun
      const backlitAmount = max(
        float(0.0),
        mul(mul(NdotSun, float(-1.0)), max(float(0.0), VdotSun)),
      );

      // Subsurface scattering intensity - warmer, brighter color
      const subsurfaceColor = mul(leafColor, vec3(1.3, 1.1, 0.7)); // Warm yellow-green tint
      const sssIntensity = mul(mul(backlitAmount, float(0.35)), uDayNightMix);

      return mul(subsurfaceColor, sssIntensity);
    })();

    material.emissiveNode = emissiveNode;

    // Alpha test node - returns threshold for alpha cutoff
    // Fragment is discarded when opacity < alphaTestNode
    // This is required for TSL materials - alphaTest property alone doesn't work
    material.alphaTestNode = float(0.5);

    material.side = THREE.DoubleSide;
    material.transparent = false; // Use alpha test cutout, not transparency
    material.alphaTest = 0.5; // Fallback for non-TSL path
    material.depthWrite = true;
    material.roughness = 0.75; // Matte leaf surface
    material.metalness = 0.0;
    material.envMapIntensity = 0.2; // Reduce environment reflection
    material.color = new THREE.Color(0x3d7a3d); // Base green color

    // Store uniforms for updates
    (material as LeafNodeMaterial).leafUniforms = {
      time: uTime,
      windStrength: uWindStrength,
      windDirection: uWindDirection,
      baseColor: uBaseColor,
      sunDirection: uSunDirection,
      dayNightMix: uDayNightMix,
    };

    applySkyFog(material);
    return material as LeafNodeMaterial;
  }

  /**
   * Add leaves for a tree.
   * @param treeId Unique tree identifier
   * @param leafTransforms Array of world-space transforms for each leaf
   * @param color Leaf color for this tree
   * @returns Array of indices allocated for these leaves
   */
  addTreeLeaves(
    treeId: string,
    leafTransforms: THREE.Matrix4[],
    color: THREE.Color = new THREE.Color(0x3d7a3d),
  ): number[] {
    // Remove existing leaves for this tree if any
    this.removeTreeLeaves(treeId);

    const indices: number[] = [];
    const r = color.r,
      g = color.g,
      b = color.b;

    let skipped = 0;
    for (const transform of leafTransforms) {
      // Get next available index
      const idx = this.freeIndices.pop() ?? this.nextIndex++;
      if (idx >= MAX_GLOBAL_LEAVES) {
        skipped++;
        continue;
      }

      indices.push(idx);

      // Set transform
      this.matrices[idx].copy(transform);
      this.mesh.setMatrixAt(idx, this.matrices[idx]);

      // Set color
      this.colors[idx * 3] = r;
      this.colors[idx * 3 + 1] = g;
      this.colors[idx * 3 + 2] = b;

      // Set fade to visible
      this.fades[idx] = 1;

      this.count = Math.max(this.count, idx + 1);
    }

    // Warn if capacity exceeded
    if (skipped > 0) {
      console.warn(
        `[GlobalLeafInstancer] Capacity exceeded: skipped ${skipped} leaves for tree ${treeId}. ` +
          `Consider increasing MAX_GLOBAL_LEAVES (currently ${MAX_GLOBAL_LEAVES}).`,
      );
    }

    this.leafMap.set(treeId, indices);
    this.dirty = true;

    return indices;
  }

  /**
   * Remove all leaves for a tree.
   */
  removeTreeLeaves(treeId: string): void {
    const indices = this.leafMap.get(treeId);
    if (!indices) return;

    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

    for (const idx of indices) {
      // Hide by setting scale to 0
      this.mesh.setMatrixAt(idx, zeroMatrix);
      this.freeIndices.push(idx);
    }

    this.leafMap.delete(treeId);
    this.dirty = true;
  }

  /**
   * Set fade level for a tree's leaves (for LOD transitions).
   */
  setTreeFade(treeId: string, fade: number): void {
    const indices = this.leafMap.get(treeId);
    if (!indices) return;

    for (const idx of indices) {
      this.fades[idx] = fade;
    }
    this.fadeAttr.needsUpdate = true;
  }

  /**
   * Update wind and flush dirty state.
   */
  update(dt: number, windStrength: number, windDir: THREE.Vector3): void {
    this.windTime += dt;
    this.windStrength = windStrength;
    this.windDir.copy(windDir);

    // Update TSL uniforms
    this.material.leafUniforms.time.value = this.windTime;
    this.material.leafUniforms.windStrength.value = windStrength;
    this.material.leafUniforms.windDirection.value.copy(windDir);

    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.fadeAttr.needsUpdate = true;
      this.mesh.count = this.count;
      this.dirty = false;
    }
  }

  /**
   * Update lighting parameters for day/night cycle.
   * @param sunDir - Direction TO the sun (normalized)
   * @param dayMix - Day/night mix factor (0 = night, 1 = day)
   */
  updateLighting(sunDir: THREE.Vector3, dayMix: number): void {
    this.material.leafUniforms.sunDirection.value.copy(sunDir);
    this.material.leafUniforms.dayNightMix.value = dayMix;
  }

  getStats(): { count: number; capacity: number; drawCalls: number } {
    return {
      count: this.leafMap.size,
      capacity: MAX_GLOBAL_LEAVES,
      drawCalls: 1, // Always 1!
    };
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// ============================================================================
// GLOBAL LEAF CLUSTER INSTANCER (LOD2 Optimization)
// ============================================================================

const MAX_CLUSTER_INSTANCES = 50000;

/**
 * Cluster data per tree preset - from LeafClusterGenerator.
 */
interface PresetClusterData {
  /** Cluster center positions (local to tree) */
  centers: THREE.Vector3[];
  /** Cluster sizes (width, height) */
  sizes: Array<{ width: number; height: number }>;
  /** Cluster densities (normalized 0-1) for alpha variation */
  densities: number[];
  /** Leaf count per cluster (for size scaling) */
  leafCounts: number[];
  /** Octree cell ID for each cluster (0-63 for 4x4x4 grid) */
  octreeCellIds: number[];
  /** Average leaf color */
  color: THREE.Color;
  /** Total leaf count for stats */
  totalLeaves: number;
  /** Bounding box used for octree cell assignment */
  bounds: THREE.Box3;
}

/**
 * Global leaf cluster instancer - renders billboard clusters at LOD2.
 *
 * AAA TECHNIQUE: At 60-120m distance, individual leaves are too small to distinguish.
 * Instead, we render larger "cluster cards" that approximate groups of 15-30 leaves.
 * This bridges the gap between individual leaves (LOD0/1) and impostors (LOD3).
 *
 * PERFORMANCE:
 * - 1000 individual leaves → ~40 cluster cards
 * - ONE draw call for ALL clusters across ALL trees
 * - GPU-driven wind animation and camera-facing billboards
 *
 * VISUAL QUALITY:
 * - Procedural leaf-like noise pattern (not just radial gradient)
 * - Density-based alpha variation per cluster
 * - Proper two-sided lighting with subsurface approximation
 * - Smooth LOD fade with screen-space dithering
 */
// Type for cluster node material with wind uniforms
type ClusterNodeMaterial = THREE.MeshStandardNodeMaterial & {
  uniforms: {
    time: { value: number };
    windStrength: { value: number };
    windDirection: { value: THREE.Vector3 };
    cameraPosition: { value: THREE.Vector3 };
    cameraMatrix: { value: THREE.Matrix4 }; // MVP matrix for frustum culling
    alphaTest: { value: number };
  };
};

class GlobalLeafClusterInstancer {
  private geometry: THREE.BufferGeometry;
  private material: ClusterNodeMaterial;
  private mesh: THREE.InstancedMesh;

  // Per-instance attributes
  private colors: Float32Array;
  private fades: Float32Array;
  private densities: Float32Array; // Alpha multiplier per cluster
  private treeCenters: Float32Array; // Tree center position for view culling (x, y, z)
  private cellIds: Float32Array; // Octree cell ID for visibility culling
  private colorAttr: THREE.InstancedBufferAttribute;
  private fadeAttr: THREE.InstancedBufferAttribute;
  private densityAttr: THREE.InstancedBufferAttribute;
  private treeCenterAttr: THREE.InstancedBufferAttribute;
  private cellIdAttr: THREE.InstancedBufferAttribute;

  // Bookkeeping
  private clusterMap: Map<string, number[]> = new Map();
  private presetClusters: Map<string, PresetClusterData> = new Map();
  private freeIndices: number[] = [];
  private nextIndex = 0;
  private count = 0;
  private dirty = false;

  // Wind and camera state
  private windTime = 0;
  private windStrength = 1;
  private windDir = new THREE.Vector3(1, 0, 0);
  private cameraPosition = new THREE.Vector3();
  private mvpMatrix = new THREE.Matrix4(); // For frustum culling

  constructor(scene: THREE.Scene) {
    this.geometry = this.createClusterCardGeometry();
    this.material = this.createClusterMaterial();

    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_CLUSTER_INSTANCES,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = "GlobalLeafClusters";
    this.mesh.layers.set(1);
    scene.add(this.mesh);

    // Initialize instance arrays
    this.colors = new Float32Array(MAX_CLUSTER_INSTANCES * 3);
    this.fades = new Float32Array(MAX_CLUSTER_INSTANCES).fill(1);
    this.densities = new Float32Array(MAX_CLUSTER_INSTANCES).fill(1);
    this.treeCenters = new Float32Array(MAX_CLUSTER_INSTANCES * 3); // x, y, z per cluster
    this.cellIds = new Float32Array(MAX_CLUSTER_INSTANCES); // 0-63 cell ID

    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("instanceColor", this.colorAttr);

    this.fadeAttr = new THREE.InstancedBufferAttribute(this.fades, 1);
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("instanceFade", this.fadeAttr);

    this.densityAttr = new THREE.InstancedBufferAttribute(this.densities, 1);
    this.densityAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("instanceDensity", this.densityAttr);

    this.treeCenterAttr = new THREE.InstancedBufferAttribute(
      this.treeCenters,
      3,
    );
    this.treeCenterAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("instanceTreeCenter", this.treeCenterAttr);

    this.cellIdAttr = new THREE.InstancedBufferAttribute(this.cellIds, 1);
    this.cellIdAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("instanceCellId", this.cellIdAttr);
  }

  private createClusterCardGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();

    // Unit quad centered at bottom (will be scaled per-instance)
    const positions = new Float32Array([
      -0.5,
      0,
      0, // bottom-left
      0.5,
      0,
      0, // bottom-right
      0.5,
      1,
      0, // top-right
      -0.5,
      1,
      0, // top-left
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

  private createClusterMaterial(): ClusterNodeMaterial {
    // TSL-based cluster material for WebGPU compatibility
    const material = new MeshStandardNodeMaterial() as ClusterNodeMaterial;

    // Create uniforms for wind animation, frustum culling, and rendering
    const uTime = uniform(0);
    const uWindStrength = uniform(1);
    const uWindDirection = uniform(new THREE.Vector3(1, 0, 0));
    const uCameraPosition = uniform(new THREE.Vector3());
    const uCameraMatrix = uniform(new THREE.Matrix4()); // MVP matrix for frustum culling
    const uAlphaTest = uniform(0.15);

    // Store uniforms for external access
    material.uniforms = {
      time: uTime,
      windStrength: uWindStrength,
      windDirection: uWindDirection,
      cameraPosition: uCameraPosition,
      cameraMatrix: uCameraMatrix,
      alphaTest: uAlphaTest,
    };

    // Get per-instance attributes
    const instanceColor = attribute<"vec3">("instanceColor", "vec3");
    const instanceFade = attribute<"float">("instanceFade", "float");
    const instanceDensity = attribute<"float">("instanceDensity", "float");
    const instanceTreeCenter = attribute<"vec3">("instanceTreeCenter", "vec3");
    // instanceCellId available via attribute but not used currently
    // const instanceCellId = attribute("instanceCellId", "float");

    // TSL hash function for variation
    const hash = Fn(([n]: [Node<"float">]) => {
      return fract(mul(sin(mul(n, 127.1)), 43758.5453123));
    });

    // TSL hash2D function for noise
    const hash2D = Fn(([p]: [Node<"vec2">]) => {
      const dotProd = add(mul(p.x, 127.1), mul(p.y, 311.7));
      return fract(mul(sin(dotProd), 43758.5453123));
    });

    // TSL value noise function
    const noise2D = Fn(([p]: [Node<"vec2">]) => {
      const i = floor(p);
      const f = fract(p);
      // Smoothstep interpolation: f * f * (3.0 - 2.0 * f)
      const fSmooth = mul(mul(f, f), sub(vec2(3.0, 3.0), mul(f, 2.0)));

      const a = hash2D(i);
      const b = hash2D(add(i, vec2(1.0, 0.0)));
      const c = hash2D(add(i, vec2(0.0, 1.0)));
      const d = hash2D(add(i, vec2(1.0, 1.0)));

      // Bilinear interpolation
      const mixAB = mix(a, b, fSmooth.x);
      const mixCD = mix(c, d, fSmooth.x);
      return mix(mixAB, mixCD, fSmooth.y);
    });

    // TSL FBM (fractal Brownian motion) function - available for advanced noise effects
    // Currently using simpler noise2D for performance
    // const fbm = Fn(([p]: [ReturnType<typeof vec2>]) => {
    //   const octave1 = mul(noise2D(p), 0.5);
    //   const octave2 = mul(noise2D(mul(p, 2.0)), 0.25);
    //   return add(octave1, octave2);
    // });

    // Position node with BILLBOARD rotation and wind animation
    // Clusters should always face the camera for proper visibility
    const positionNode = Fn(() => {
      const pos = positionLocal;

      // Get instance index for variation
      const idx = float(instanceIndex);
      const windPhase = mul(hash(idx), 6.28318);

      // ========== BILLBOARD ROTATION ==========
      // Make the cluster card face the camera by rotating the quad
      // We need to rotate the local position to face the camera
      // The quad is in XY plane, we need to rotate it around Y axis to face camera

      // Get world position from instance matrix (approximated from tree center attribute)
      const worldCenter = instanceTreeCenter;

      // Calculate direction from cluster to camera (in XZ plane for Y-axis billboard)
      const toCamera = sub(uCameraPosition, worldCenter);
      const toCameraXZ = vec2(toCamera.x, toCamera.z);
      // distXZ available for distance-based effects if needed
      // const distXZ = sqrt(add(mul(toCameraXZ.x, toCameraXZ.x), mul(toCameraXZ.y, toCameraXZ.y)));

      // Angle to rotate around Y axis (atan2 of camera direction)
      // When camera is at +Z, angle = 0; at +X, angle = -PI/2
      const billboardAngle = atan(toCameraXZ.x, toCameraXZ.y);

      // Rotate local position around Y axis
      const cosAngle = cos(billboardAngle);
      const sinAngle = sin(billboardAngle);
      const rotatedX = sub(mul(pos.x, cosAngle), mul(pos.z, sinAngle));
      const rotatedZ = add(mul(pos.x, sinAngle), mul(pos.z, cosAngle));

      // ========== WIND ANIMATION ==========
      // Height factor for wind (0 at bottom, 1 at top of cluster)
      const heightFactor = pos.y;
      const windAmount = mul(mul(uWindStrength, heightFactor), 0.15);

      // Multi-frequency wind for natural look
      const wave1 = sin(add(mul(uTime, 2.0), windPhase));
      const wave2 = mul(sin(add(mul(uTime, 1.3), mul(windPhase, 0.7))), 0.5);
      const wave3 = mul(sin(add(mul(uTime, 3.1), mul(windPhase, 1.3))), 0.25);
      const combined = mul(add(add(wave1, wave2), wave3), windAmount);

      // Wind displacement applied after billboard rotation
      const windX = mul(combined, uWindDirection.x);
      const windZ = mul(combined, uWindDirection.z);
      const windY = mul(
        mul(sin(add(mul(uTime, 4.0), mul(windPhase, 2.0))), windAmount),
        0.08,
      );

      // Final position: rotated billboard + wind
      return vec3(
        add(rotatedX, windX),
        add(pos.y, windY),
        add(rotatedZ, windZ),
      );
    })();

    material.positionNode = positionNode;

    // Color node with lighting
    const colorNode = Fn(() => {
      // Per-instance seed for variation
      const idx = float(instanceIndex);
      const instanceSeed = fract(mul(idx, 0.1));

      // Color variation
      const colorVariation = add(0.9, mul(hash(instanceSeed), 0.2));
      return mul(instanceColor, colorVariation);
    })();

    material.colorNode = colorNode;

    // ========== PROCEDURAL LEAF SILHOUETTE FUNCTIONS ==========
    // Creates believable leaf shapes with proper silhouettes, not round blobs

    // Single leaf silhouette - creates an actual leaf shape with pointed tip and lobed edges
    const leafSilhouette = Fn(
      ([p, leafAngle, leafScale, seed]: [
        Node<"vec2">,
        Node<"float">,
        Node<"float">,
        Node<"float">,
      ]) => {
        // Rotate point to leaf orientation
        const cosA = cos(leafAngle);
        const sinA = sin(leafAngle);
        const rotX = sub(mul(p.x, cosA), mul(p.y, sinA));
        const rotY = add(mul(p.x, sinA), mul(p.y, cosA));

        // Scale to leaf size
        const lx = div(rotX, leafScale);
        const ly = div(rotY, leafScale);

        // Leaf body - elongated ellipse that tapers toward tip
        // Width varies along length: widest in middle, tapers to point
        const normalizedY = add(mul(ly, 0.5), 0.5); // 0 at bottom, 1 at top
        const widthMod = mul(mul(normalizedY, sub(1.0, normalizedY)), 4.0); // Parabola: max at 0.5

        // Additional taper toward tip
        const tipTaper = smoothstep(0.7, 1.0, normalizedY);
        const effectiveWidth = mul(widthMod, sub(1.0, mul(tipTaper, 0.6)));

        // Leaf edge with serrations based on seed
        const serrationFreq = add(5.0, mul(fract(mul(seed, 7.3)), 4.0));
        const serrationAmp = mul(0.15, sub(1.0, tipTaper)); // No serration at tip
        const serration = mul(
          sin(mul(normalizedY, mul(serrationFreq, 6.28))),
          serrationAmp,
        );

        // Calculate if point is inside leaf
        const maxWidth = add(mul(effectiveWidth, 0.35), serration);
        const leafShape = sub(
          1.0,
          smoothstep(mul(maxWidth, 0.8), maxWidth, abs(lx)),
        );

        // Mask out areas outside leaf length
        const lengthMask = mul(
          smoothstep(-0.05, 0.1, normalizedY),
          smoothstep(1.05, 0.9, normalizedY),
        );

        return mul(leafShape, lengthMask);
      },
    );

    // Opacity node with AAA-quality leaf cluster pattern
    const opacityNode = Fn(() => {
      const uvCoord = uv();
      const idx = float(instanceIndex);
      const instanceSeed = fract(mul(idx, 0.1));

      // Center UV for calculations (-1 to 1 range)
      const centered = sub(mul(uvCoord, 2.0), vec2(1.0, 1.0));

      // Distance from center for overall cluster boundary
      const dist = sqrt(
        add(mul(centered.x, centered.x), mul(centered.y, centered.y)),
      );

      // Soft cluster boundary - leaves can extend slightly beyond
      const clusterMask = sub(1.0, smoothstep(0.7, 1.1, dist));

      // Generate multiple leaf silhouettes scattered across the cluster
      // Use deterministic positioning based on instance seed
      // 12 leaves for good density coverage

      // Helper to create a leaf with seed-based positioning
      // Leaves are positioned in a roughly circular pattern with variation

      // Leaf 1 - center
      const seed1 = instanceSeed;
      const leaf1Pos = vec2(
        mul(sin(mul(seed1, 17.3)), 0.1),
        mul(cos(mul(seed1, 23.7)), 0.1),
      );
      const leaf1 = mul(
        leafSilhouette(
          sub(centered, leaf1Pos),
          mul(seed1, 6.28),
          add(0.38, mul(fract(mul(seed1, 3.7)), 0.12)),
          seed1,
        ),
        0.95,
      );

      // Leaf 2 - upper right
      const seed2 = fract(add(instanceSeed, 0.083));
      const leaf2Pos = vec2(
        add(0.25, mul(sin(mul(seed2, 19.1)), 0.1)),
        add(0.3, mul(cos(mul(seed2, 29.3)), 0.1)),
      );
      const leaf2 = mul(
        leafSilhouette(
          sub(centered, leaf2Pos),
          mul(seed2, 6.28),
          add(0.32, mul(fract(mul(seed2, 5.3)), 0.1)),
          seed2,
        ),
        0.9,
      );

      // Leaf 3 - upper left
      const seed3 = fract(add(instanceSeed, 0.166));
      const leaf3Pos = vec2(
        sub(mul(sin(mul(seed3, 13.7)), 0.1), 0.28),
        add(0.25, mul(cos(mul(seed3, 31.1)), 0.1)),
      );
      const leaf3 = mul(
        leafSilhouette(
          sub(centered, leaf3Pos),
          mul(seed3, 6.28),
          add(0.3, mul(fract(mul(seed3, 7.1)), 0.1)),
          seed3,
        ),
        0.88,
      );

      // Leaf 4 - right
      const seed4 = fract(add(instanceSeed, 0.25));
      const leaf4Pos = vec2(
        add(0.35, mul(sin(mul(seed4, 21.3)), 0.1)),
        mul(cos(mul(seed4, 17.9)), 0.15),
      );
      const leaf4 = mul(
        leafSilhouette(
          sub(centered, leaf4Pos),
          mul(seed4, 6.28),
          add(0.28, mul(fract(mul(seed4, 11.3)), 0.1)),
          seed4,
        ),
        0.85,
      );

      // Leaf 5 - left
      const seed5 = fract(add(instanceSeed, 0.333));
      const leaf5Pos = vec2(
        sub(mul(sin(mul(seed5, 27.7)), 0.1), 0.38),
        mul(cos(mul(seed5, 11.3)), 0.12),
      );
      const leaf5 = mul(
        leafSilhouette(
          sub(centered, leaf5Pos),
          mul(seed5, 6.28),
          add(0.26, mul(fract(mul(seed5, 13.7)), 0.1)),
          seed5,
        ),
        0.82,
      );

      // Leaf 6 - lower right
      const seed6 = fract(add(instanceSeed, 0.416));
      const leaf6Pos = vec2(
        add(0.22, mul(sin(mul(seed6, 33.1)), 0.1)),
        sub(mul(cos(mul(seed6, 19.7)), 0.1), 0.25),
      );
      const leaf6 = mul(
        leafSilhouette(
          sub(centered, leaf6Pos),
          mul(seed6, 6.28),
          add(0.25, mul(fract(mul(seed6, 17.3)), 0.08)),
          seed6,
        ),
        0.8,
      );

      // Leaf 7 - lower left
      const seed7 = fract(add(instanceSeed, 0.5));
      const leaf7Pos = vec2(
        sub(mul(sin(mul(seed7, 23.9)), 0.1), 0.2),
        sub(mul(cos(mul(seed7, 37.1)), 0.1), 0.28),
      );
      const leaf7 = mul(
        leafSilhouette(
          sub(centered, leaf7Pos),
          mul(seed7, 6.28),
          add(0.24, mul(fract(mul(seed7, 19.1)), 0.08)),
          seed7,
        ),
        0.78,
      );

      // Leaf 8 - top
      const seed8 = fract(add(instanceSeed, 0.583));
      const leaf8Pos = vec2(
        mul(sin(mul(seed8, 29.3)), 0.12),
        add(0.4, mul(cos(mul(seed8, 41.7)), 0.08)),
      );
      const leaf8 = mul(
        leafSilhouette(
          sub(centered, leaf8Pos),
          mul(seed8, 6.28),
          add(0.22, mul(fract(mul(seed8, 23.3)), 0.08)),
          seed8,
        ),
        0.75,
      );

      // Leaf 9 - bottom
      const seed9 = fract(add(instanceSeed, 0.666));
      const leaf9Pos = vec2(
        mul(sin(mul(seed9, 31.7)), 0.15),
        sub(mul(cos(mul(seed9, 43.9)), 0.08), 0.35),
      );
      const leaf9 = mul(
        leafSilhouette(
          sub(centered, leaf9Pos),
          mul(seed9, 6.28),
          add(0.2, mul(fract(mul(seed9, 29.7)), 0.08)),
          seed9,
        ),
        0.72,
      );

      // Leaf 10 - fill upper
      const seed10 = fract(add(instanceSeed, 0.75));
      const leaf10Pos = vec2(
        mul(sin(mul(seed10, 37.3)), 0.2),
        add(0.18, mul(cos(mul(seed10, 47.1)), 0.15)),
      );
      const leaf10 = mul(
        leafSilhouette(
          sub(centered, leaf10Pos),
          mul(seed10, 6.28),
          add(0.2, mul(fract(mul(seed10, 31.1)), 0.06)),
          seed10,
        ),
        0.7,
      );

      // Leaf 11 - fill lower
      const seed11 = fract(add(instanceSeed, 0.833));
      const leaf11Pos = vec2(
        mul(sin(mul(seed11, 41.9)), 0.22),
        sub(mul(cos(mul(seed11, 53.3)), 0.12), 0.15),
      );
      const leaf11 = mul(
        leafSilhouette(
          sub(centered, leaf11Pos),
          mul(seed11, 6.28),
          add(0.18, mul(fract(mul(seed11, 37.7)), 0.06)),
          seed11,
        ),
        0.68,
      );

      // Leaf 12 - edge fill
      const seed12 = fract(add(instanceSeed, 0.916));
      const leaf12Pos = vec2(
        mul(sin(mul(seed12, 47.1)), 0.32),
        mul(cos(mul(seed12, 59.9)), 0.28),
      );
      const leaf12 = mul(
        leafSilhouette(
          sub(centered, leaf12Pos),
          mul(seed12, 6.28),
          add(0.16, mul(fract(mul(seed12, 43.3)), 0.06)),
          seed12,
        ),
        0.65,
      );

      // Combine all 12 leaves using chained max operations
      const leaves1_4 = max(max(max(leaf1, leaf2), leaf3), leaf4);
      const leaves5_8 = max(max(max(leaf5, leaf6), leaf7), leaf8);
      const leaves9_12 = max(max(max(leaf9, leaf10), leaf11), leaf12);
      const leafAccum = max(max(leaves1_4, leaves5_8), leaves9_12);

      // Add subtle noise for organic variation
      const noiseScale = add(6.0, mul(fract(mul(instanceSeed, 41.7)), 4.0));
      const noiseVal = noise2D(mul(uvCoord, noiseScale));
      const organicVariation = add(0.85, mul(noiseVal, 0.3));

      // Combine leaves with cluster mask and organic variation
      const baseAlpha = mul(mul(leafAccum, clusterMask), organicVariation);

      // Modulate by cluster density (denser clusters are more opaque)
      const densityModulated = mul(
        baseAlpha,
        add(0.6, mul(instanceDensity, 0.4)),
      );

      // Apply LOD fade
      const finalAlpha = mul(densityModulated, instanceFade);

      return finalAlpha;
    })();

    material.opacityNode = opacityNode;

    // Use If/Discard for alpha test
    material.alphaTest = 0.15;
    material.side = THREE.DoubleSide;
    material.transparent = true;
    material.depthWrite = true;

    applySkyFog(material);
    return material;
  }

  /**
   * Register cluster data for a preset using octree-based spatial clustering.
   * Called once during tree registration - generates optimal clusters for LOD2.
   */
  registerPresetClusters(
    presetName: string,
    leafTransforms: THREE.Matrix4[],
    leafColor: THREE.Color,
    treeDims: { height: number; canopyR: number },
  ): void {
    if (leafTransforms.length === 0) {
      this.presetClusters.set(presetName, {
        centers: [],
        sizes: [],
        densities: [],
        leafCounts: [],
        octreeCellIds: [],
        color: leafColor.clone(),
        totalLeaves: 0,
        bounds: new THREE.Box3(),
      });
      return;
    }

    // Extract leaf positions
    const positions: THREE.Vector3[] = [];
    const tempVec = new THREE.Vector3();
    for (const mat of leafTransforms) {
      tempVec.setFromMatrixPosition(mat);
      positions.push(tempVec.clone());
    }

    // Generate clusters using octree-based spatial subdivision
    const clusterResult = this.generateClusters(positions, treeDims);

    this.presetClusters.set(presetName, {
      centers: clusterResult.centers,
      sizes: clusterResult.sizes,
      densities: clusterResult.densities,
      leafCounts: clusterResult.leafCounts,
      octreeCellIds: clusterResult.octreeCellIds,
      color: leafColor.clone(),
      totalLeaves: positions.length,
      bounds: clusterResult.bounds,
    });

    console.log(
      `[LeafClusters] ${presetName}: ${positions.length} leaves → ${clusterResult.centers.length} clusters ` +
        `(${(positions.length / clusterResult.centers.length).toFixed(1)} leaves/cluster avg, 4x4x4 octree)`,
    );
  }

  /**
   * Octree-based spatial clustering for optimal LOD2 representation.
   */
  private generateClusters(
    positions: THREE.Vector3[],
    treeDims: { height: number; canopyR: number },
  ): {
    centers: THREE.Vector3[];
    sizes: Array<{ width: number; height: number }>;
    densities: number[];
    leafCounts: number[];
    octreeCellIds: number[];
    bounds: THREE.Box3;
  } {
    // Calculate bounds
    const bounds = new THREE.Box3();
    for (const pos of positions) {
      bounds.expandByPoint(pos);
    }

    // Target cluster count based on tree size and leaf count
    // Larger trees with more leaves need more clusters for visual fidelity
    // Increased density: ~15 leaves per cluster for better visual quality
    const leafCount = positions.length;
    const treeSize = Math.max(treeDims.height, treeDims.canopyR * 2);
    const baseClusterCount = Math.max(
      30, // Minimum 30 clusters
      Math.min(150, Math.ceil(leafCount / 15)), // More clusters (was /25)
    );
    const sizeMultiplier = Math.max(1, treeSize / 4); // More aggressive scaling for larger trees
    const targetClusters = Math.min(
      200, // Increased max from 100 to 200
      Math.ceil(baseClusterCount * sizeMultiplier),
    );

    // Calculate octree cell size
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const avgDim = (size.x + size.y + size.z) / 3;
    const cellSize = avgDim / Math.cbrt(targetClusters);

    // Build octree grid
    const cellMap = new Map<string, number[]>(); // cell key -> leaf indices
    const cellKey = (pos: THREE.Vector3) => {
      const x = Math.floor((pos.x - bounds.min.x) / cellSize);
      const y = Math.floor((pos.y - bounds.min.y) / cellSize);
      const z = Math.floor((pos.z - bounds.min.z) / cellSize);
      return `${x},${y},${z}`;
    };

    for (let i = 0; i < positions.length; i++) {
      const key = cellKey(positions[i]);
      if (!cellMap.has(key)) cellMap.set(key, []);
      cellMap.get(key)!.push(i);
    }

    // Extract clusters from cells
    const centers: THREE.Vector3[] = [];
    const sizes: Array<{ width: number; height: number }> = [];
    const leafCounts: number[] = [];
    const rawDensities: number[] = [];

    const minLeavesPerCluster = 2; // Allow smaller clusters
    const maxLeavesPerCluster = 30; // Reduced from 50 for more, smaller clusters

    for (const [, indices] of cellMap) {
      if (indices.length < minLeavesPerCluster) continue;

      // If cluster has too many leaves, subdivide
      if (indices.length > maxLeavesPerCluster) {
        // Simple split along longest axis
        const cellBounds = new THREE.Box3();
        for (const idx of indices) cellBounds.expandByPoint(positions[idx]);

        const cellSize3 = new THREE.Vector3();
        cellBounds.getSize(cellSize3);

        // Find longest axis
        let splitAxis: "x" | "y" | "z" = "x";
        if (cellSize3.y > cellSize3.x && cellSize3.y > cellSize3.z)
          splitAxis = "y";
        else if (cellSize3.z > cellSize3.x) splitAxis = "z";

        const splitValue = cellBounds.min[splitAxis] + cellSize3[splitAxis] / 2;

        const left: number[] = [];
        const right: number[] = [];
        for (const idx of indices) {
          if (positions[idx][splitAxis] < splitValue) left.push(idx);
          else right.push(idx);
        }

        // Process both halves
        for (const half of [left, right]) {
          if (half.length < minLeavesPerCluster) continue;
          this.addClusterFromIndices(
            half,
            positions,
            centers,
            sizes,
            leafCounts,
            rawDensities,
          );
        }
      } else {
        this.addClusterFromIndices(
          indices,
          positions,
          centers,
          sizes,
          leafCounts,
          rawDensities,
        );
      }
    }

    // Normalize densities to 0-1 range
    const maxDensity = Math.max(...rawDensities, 0.001);
    const minDensity = Math.min(...rawDensities);
    const densityRange = Math.max(0.001, maxDensity - minDensity);
    const densities = rawDensities.map((d) => (d - minDensity) / densityRange);

    // Compute octree cell IDs for each cluster (4x4x4 = 64 cells)
    const octreeCellIds = centers.map((center) =>
      this.computeOctreeCellId(center, bounds),
    );

    return { centers, sizes, densities, leafCounts, octreeCellIds, bounds };
  }

  /**
   * Compute octree cell ID for a position within bounds.
   * Uses 4x4x4 grid = 64 cells (fits in 6 bits).
   */
  private computeOctreeCellId(
    position: THREE.Vector3,
    bounds: THREE.Box3,
  ): number {
    const size = new THREE.Vector3();
    bounds.getSize(size);

    // Normalize position to 0-1 range within bounds
    const nx = size.x > 0 ? (position.x - bounds.min.x) / size.x : 0.5;
    const ny = size.y > 0 ? (position.y - bounds.min.y) / size.y : 0.5;
    const nz = size.z > 0 ? (position.z - bounds.min.z) / size.z : 0.5;

    // Convert to cell indices (0-3)
    const cx = Math.min(3, Math.floor(nx * 4));
    const cy = Math.min(3, Math.floor(ny * 4));
    const cz = Math.min(3, Math.floor(nz * 4));

    // Pack into single number (0-63)
    return cx + cy * 4 + cz * 16;
  }

  private addClusterFromIndices(
    indices: number[],
    positions: THREE.Vector3[],
    centers: THREE.Vector3[],
    sizes: Array<{ width: number; height: number }>,
    leafCounts: number[],
    rawDensities: number[],
  ): void {
    // Calculate center
    const center = new THREE.Vector3();
    for (const idx of indices) center.add(positions[idx]);
    center.divideScalar(indices.length);

    // Calculate bounds
    const clusterBounds = new THREE.Box3();
    for (const idx of indices) clusterBounds.expandByPoint(positions[idx]);

    const clusterSize = new THREE.Vector3();
    clusterBounds.getSize(clusterSize);

    // Calculate density (leaves per volume)
    const volume = Math.max(
      0.001,
      clusterSize.x * clusterSize.y * clusterSize.z,
    );
    const density = indices.length / volume;

    // Size with padding for visual coverage (reduced for tighter clusters)
    const padding = 1.15;
    const width = Math.max(
      0.3, // Reduced minimum from 0.5
      Math.max(clusterSize.x, clusterSize.z) * padding,
    );
    const height = Math.max(0.3, clusterSize.y * padding);

    centers.push(center);
    sizes.push({ width, height });
    leafCounts.push(indices.length);
    rawDensities.push(density);
  }

  /**
   * Add clusters for a tree instance with density-based culling.
   *
   * @param treeId - Unique tree identifier
   * @param presetName - Tree preset name
   * @param position - World position
   * @param rotation - Y rotation in radians
   * @param scale - Uniform scale
   * @param density - Cluster density (0-1), defaults to 1.0 (all clusters)
   * @param seed - Random seed for deterministic culling (defaults to hash of treeId)
   */
  addTree(
    treeId: string,
    presetName: string,
    position: THREE.Vector3,
    rotation: number,
    scale: number,
    density: number = 1.0,
    seed?: number,
  ): void {
    const preset = this.presetClusters.get(presetName);
    if (!preset || preset.centers.length === 0) return;

    // Remove existing if present
    this.removeTree(treeId);

    const indices: number[] = [];
    const tempMatrix = new THREE.Matrix4();
    const tempQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      rotation,
    );
    const tempScale = new THREE.Vector3();

    // Deterministic seed from tree ID for consistent culling
    const cullSeed = seed ?? this.hashString(treeId);

    for (let i = 0; i < preset.centers.length; i++) {
      // Density-based stochastic culling using deterministic hash
      // Each cluster has a consistent visibility threshold based on its index + tree seed
      if (density < 1.0) {
        const clusterHash = this.pcgHash(cullSeed + i * 12345);
        const threshold = clusterHash / 0xffffffff; // Normalize to 0-1
        if (threshold > density) {
          // Skip this cluster (culled)
          continue;
        }
      }

      const idx = this.allocateIndex();
      if (idx < 0) {
        console.warn("[LeafClusters] Max instances reached");
        break;
      }

      // Calculate world position
      const worldPos = preset.centers[i]
        .clone()
        .applyQuaternion(tempQuat)
        .multiplyScalar(scale)
        .add(position);

      // Calculate cluster scale (width, height, 1 for billboard)
      const s = preset.sizes[i];
      tempScale.set(s.width * scale, s.height * scale, 1);

      // Create matrix (position + scale)
      tempMatrix.identity();
      tempMatrix.setPosition(worldPos);
      tempMatrix.scale(tempScale);

      this.mesh.setMatrixAt(idx, tempMatrix);

      // Set color with slight variation
      const c = preset.color;
      const variation = 0.95 + Math.random() * 0.1;
      this.colors[idx * 3] = c.r * variation;
      this.colors[idx * 3 + 1] = c.g * variation;
      this.colors[idx * 3 + 2] = c.b * variation;

      // Set density for alpha modulation
      this.densities[idx] = preset.densities[i];

      // Set fade to visible
      this.fades[idx] = 1;

      // Set tree center for view-dependent culling
      this.treeCenters[idx * 3] = position.x;
      this.treeCenters[idx * 3 + 1] = position.y;
      this.treeCenters[idx * 3 + 2] = position.z;

      // Set octree cell ID for visibility culling
      this.cellIds[idx] = preset.octreeCellIds[i] ?? 0;

      indices.push(idx);
    }

    this.clusterMap.set(treeId, indices);
    this.count = Math.max(this.count, ...indices.map((i) => i + 1));
    this.dirty = true;
  }

  removeTree(treeId: string): void {
    const indices = this.clusterMap.get(treeId);
    if (!indices) return;

    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const idx of indices) {
      this.mesh.setMatrixAt(idx, zeroMatrix);
      this.freeIndices.push(idx);
    }

    this.clusterMap.delete(treeId);
    this.dirty = true;
  }

  setFade(treeId: string, fade: number): void {
    const indices = this.clusterMap.get(treeId);
    if (!indices) return;

    for (const idx of indices) {
      this.fades[idx] = fade;
    }
    this.fadeAttr.needsUpdate = true;
  }

  private allocateIndex(): number {
    if (this.freeIndices.length > 0) {
      return this.freeIndices.pop()!;
    }
    if (this.nextIndex >= MAX_CLUSTER_INSTANCES) return -1;
    return this.nextIndex++;
  }

  /**
   * Simple string hash for deterministic culling.
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash >>> 0; // Ensure unsigned
  }

  /**
   * PCG hash for deterministic random numbers.
   */
  private pcgHash(seed: number): number {
    let state = seed >>> 0;
    state = Math.imul(state ^ (state >>> 16), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 13), 0xc2b2ae35);
    return (state ^ (state >>> 16)) >>> 0;
  }

  update(wind: Wind | null, dt: number, camera?: THREE.Camera): void {
    this.windTime += dt;
    if (wind) {
      this.windDir.copy(wind.uniforms.windDirection.value);
      this.windStrength = wind.uniforms.windStrength.value;
    }

    // Update camera position and matrix for frustum culling
    if (camera) {
      camera.getWorldPosition(this.cameraPosition);
      this.material.uniforms.cameraPosition.value.copy(this.cameraPosition);

      // Compute MVP matrix for frustum culling (projection * view)
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const perspCam = camera as THREE.PerspectiveCamera;
        perspCam.updateMatrixWorld();
        this.mvpMatrix.multiplyMatrices(
          perspCam.projectionMatrix,
          perspCam.matrixWorldInverse,
        );
        this.material.uniforms.cameraMatrix.value.copy(this.mvpMatrix);
      }
    }

    this.material.uniforms.time.value = this.windTime;
    this.material.uniforms.windStrength.value = this.windStrength;
    this.material.uniforms.windDirection.value.copy(this.windDir);

    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.fadeAttr.needsUpdate = true;
      this.densityAttr.needsUpdate = true;
      this.treeCenterAttr.needsUpdate = true;
      this.cellIdAttr.needsUpdate = true;
      this.mesh.count = this.count;
      this.dirty = false;
    }
  }

  hasPreset(presetName: string): boolean {
    return this.presetClusters.has(presetName);
  }

  getStats(): {
    treesWithClusters: number;
    totalClusters: number;
    capacity: number;
    drawCalls: number;
    presetsRegistered: number;
  } {
    let totalClusters = 0;
    for (const indices of this.clusterMap.values()) {
      totalClusters += indices.length;
    }

    return {
      treesWithClusters: this.clusterMap.size,
      totalClusters,
      capacity: MAX_CLUSTER_INSTANCES,
      drawCalls: 1,
      presetsRegistered: this.presetClusters.size,
    };
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// ============================================================================
// MATERIAL HELPERS
// ============================================================================

/** Copy material properties from source to target including textures */
function copyMaterialProps(
  target: THREE.MeshStandardNodeMaterial,
  source: THREE.Material,
): void {
  // Handle MeshStandardNodeMaterial (from procgen) or MeshStandardMaterial (from GLB)
  // Check for PBR properties using duck typing to support both material types
  const srcWithPBR = source as THREE.Material & {
    color?: THREE.Color;
    roughness?: number;
    metalness?: number;
    map?: THREE.Texture | null;
    normalMap?: THREE.Texture | null;
    normalScale?: THREE.Vector2;
    roughnessMap?: THREE.Texture | null;
    metalnessMap?: THREE.Texture | null;
    aoMap?: THREE.Texture | null;
    aoMapIntensity?: number;
    emissive?: THREE.Color;
    emissiveMap?: THREE.Texture | null;
    emissiveIntensity?: number;
    envMap?: THREE.Texture | null;
    envMapIntensity?: number;
    vertexColors?: boolean;
    flatShading?: boolean;
  };

  // Check if source has PBR properties (MeshStandardMaterial or MeshStandardNodeMaterial)
  if (
    srcWithPBR.roughness !== undefined &&
    srcWithPBR.metalness !== undefined
  ) {
    // Color and basic properties
    // NOTE: Use setRGB instead of copy for cross-build compatibility (three vs three/webgpu)
    if (srcWithPBR.color && "r" in srcWithPBR.color) {
      target.color.setRGB(
        srcWithPBR.color.r,
        srcWithPBR.color.g,
        srcWithPBR.color.b,
      );
    }
    target.roughness = srcWithPBR.roughness;
    target.metalness = srcWithPBR.metalness;
    target.side = source.side;
    target.opacity = source.opacity;
    target.alphaTest = source.alphaTest;
    if (srcWithPBR.flatShading !== undefined)
      target.flatShading = srcWithPBR.flatShading;

    // Textures - critical for proper rendering
    if (srcWithPBR.map) {
      target.map = srcWithPBR.map;
      target.map.needsUpdate = true;
    }
    if (srcWithPBR.normalMap) {
      target.normalMap = srcWithPBR.normalMap;
      if (srcWithPBR.normalScale)
        target.normalScale.copy(srcWithPBR.normalScale);
    }
    if (srcWithPBR.roughnessMap) target.roughnessMap = srcWithPBR.roughnessMap;
    if (srcWithPBR.metalnessMap) target.metalnessMap = srcWithPBR.metalnessMap;
    if (srcWithPBR.aoMap) {
      target.aoMap = srcWithPBR.aoMap;
      target.aoMapIntensity = srcWithPBR.aoMapIntensity ?? 1.0;
    }
    if (srcWithPBR.emissiveMap) {
      target.emissiveMap = srcWithPBR.emissiveMap;
      if (srcWithPBR.emissive && "r" in srcWithPBR.emissive) {
        target.emissive.setRGB(
          srcWithPBR.emissive.r,
          srcWithPBR.emissive.g,
          srcWithPBR.emissive.b,
        );
      }
      target.emissiveIntensity = srcWithPBR.emissiveIntensity ?? 1.0;
    }
    if (srcWithPBR.envMap) {
      target.envMap = srcWithPBR.envMap;
      target.envMapIntensity = srcWithPBR.envMapIntensity ?? 1.0;
    }

    // Copy vertex colors flag
    if (srcWithPBR.vertexColors !== undefined)
      target.vertexColors = srcWithPBR.vertexColors;
  } else {
    // Duck type for LambertMaterial or BasicMaterial (cross-build compatible)
    // Check for common material properties using type assertion
    const srcBasic = source as THREE.Material & {
      color?: THREE.Color;
      map?: THREE.Texture | null;
      aoMap?: THREE.Texture | null;
      aoMapIntensity?: number;
      emissive?: THREE.Color;
      emissiveMap?: THREE.Texture | null;
      emissiveIntensity?: number;
      envMap?: THREE.Texture | null;
      flatShading?: boolean;
      vertexColors?: boolean;
    };

    // Copy color if present (both Lambert and Basic have this)
    if (srcBasic.color && "r" in srcBasic.color) {
      target.color.setRGB(srcBasic.color.r, srcBasic.color.g, srcBasic.color.b);
    }
    target.side = source.side;
    target.opacity = source.opacity;
    target.alphaTest = source.alphaTest;
    if (srcBasic.flatShading !== undefined)
      target.flatShading = srcBasic.flatShading;
    if (srcBasic.vertexColors !== undefined)
      target.vertexColors = srcBasic.vertexColors;
    if (srcBasic.map) {
      target.map = srcBasic.map;
      target.map.needsUpdate = true;
    }
    if (srcBasic.aoMap) {
      target.aoMap = srcBasic.aoMap;
      target.aoMapIntensity = srcBasic.aoMapIntensity ?? 1.0;
    }
    if (srcBasic.emissiveMap) {
      target.emissiveMap = srcBasic.emissiveMap;
      if (srcBasic.emissive && "r" in srcBasic.emissive) {
        target.emissive.setRGB(
          srcBasic.emissive.r,
          srcBasic.emissive.g,
          srcBasic.emissive.b,
        );
      }
      target.emissiveIntensity = srcBasic.emissiveIntensity ?? 1.0;
    }
    if (srcBasic.envMap) {
      target.envMap = srcBasic.envMap;
    }
  }

  // Mark material for recompilation
  target.needsUpdate = true;
}

/** Create screen-space dithering opacity node */
function createDitherOpacity() {
  const fade = attribute<"float">("instanceFade", "float");
  return Fn(() => {
    const screen = screenUV.mul(viewportSize);
    const px = floor(screen.x).mod(float(4));
    const py = floor(screen.y).mod(float(4));
    const threshold = fract(mul(add(mul(py, float(4)), px), float(0.0625)));
    If(fade.greaterThan(threshold).not(), () => Discard());
    return float(1);
  })();
}

/** Create wind-animated material for LOD1 */
function createWindMaterial(base: THREE.Material, dims: TreeDims): WindMat {
  const mat = new MeshStandardNodeMaterial();
  copyMaterialProps(mat, base);

  const uTime = uniform(0);
  const uStrength = uniform(1);
  const uDir = uniform(new THREE.Vector3(1, 0, 0));
  const h = float(dims.height);

  mat.positionNode = Fn(() => {
    const pos = positionLocal;
    const normH = pos.y.div(h);
    const influence = smoothstep(float(WIND.heightThreshold), float(1), normH);
    const topInf = mul(influence, influence);

    const phase = add(
      mul(pos.x, float(WIND.spatialFreq)),
      mul(pos.z, float(WIND.spatialFreq * 1.3)),
    );
    const wave1 = sin(add(mul(uTime, float(WIND.speed)), phase));
    const wave2 = sin(
      add(mul(uTime, float(WIND.gustSpeed)), mul(phase, float(0.7))),
    );
    const combined = add(mul(wave1, float(0.7)), mul(wave2, float(0.3)));
    const bend = mul(
      mul(combined, topInf),
      mul(uStrength, float(WIND.maxBend)),
    );

    const bendX = mul(mul(bend, uDir.x), pos.y);
    const bendZ = mul(mul(bend, uDir.z), pos.y);
    return vec3(add(pos.x, bendX), pos.y, add(pos.z, bendZ));
  })();

  mat.opacityNode = createDitherOpacity();
  mat.side = THREE.DoubleSide;
  mat.shadowSide = THREE.FrontSide;
  mat.transparent = false;

  const windMat = mat as WindMat;
  windMat.windUniforms = { time: uTime, strength: uStrength, direction: uDir };
  applySkyFog(mat);
  return windMat;
}

/** Create dissolve material for LOD0/LOD2 */
function createDissolveMaterial(
  base: THREE.Material,
): THREE.MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  copyMaterialProps(mat, base);
  mat.opacityNode = createDitherOpacity();
  mat.side = THREE.DoubleSide;
  mat.transparent = false;
  mat.alphaTest = 0;
  applySkyFog(mat);
  return mat;
}

// ============================================================================
// GEOMETRY HELPERS
// ============================================================================

/** Merge buffer geometries into one */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 0) return new THREE.BufferGeometry();
  if (geos.length === 1) return geos[0];

  let totalVerts = 0,
    totalIdx = 0;
  // Check if any geometry has UVs or colors
  let hasUvs = false;
  let hasColors = false;
  for (const g of geos) {
    const p = g.attributes.position;
    if (p) totalVerts += p.count;
    totalIdx += g.index?.count ?? p?.count ?? 0;
    if (g.attributes.uv) hasUvs = true;
    if (g.attributes.color) hasColors = true;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIdx);
  // Allocate UV and color arrays if needed
  const uvs = hasUvs ? new Float32Array(totalVerts * 2) : null;
  const colors = hasColors ? new Float32Array(totalVerts * 3) : null;

  let vOff = 0,
    iOff = 0,
    vBase = 0;
  for (const g of geos) {
    const pos = g.attributes.position;
    if (!pos) continue;

    positions.set(pos.array as Float32Array, vOff * 3);
    if (g.attributes.normal)
      normals.set(g.attributes.normal.array as Float32Array, vOff * 3);

    // Copy UVs if present
    if (uvs && g.attributes.uv) {
      uvs.set(g.attributes.uv.array as Float32Array, vOff * 2);
    } else if (uvs) {
      // Fill with zeros for geometries without UVs
      uvs.fill(0, vOff * 2, (vOff + pos.count) * 2);
    }

    // Copy vertex colors if present
    if (colors && g.attributes.color) {
      colors.set(g.attributes.color.array as Float32Array, vOff * 3);
    } else if (colors) {
      // Fill with white (1,1,1) for geometries without colors
      for (let i = 0; i < pos.count * 3; i++) {
        colors[vOff * 3 + i] = 1.0;
      }
    }

    if (g.index) {
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vBase;
      iOff += idx.length;
    } else {
      for (let i = 0; i < pos.count; i++) indices[iOff + i] = i + vBase;
      iOff += pos.count;
    }
    vBase += pos.count;
    vOff += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  // Add UV attribute if any geometry had UVs
  if (uvs) {
    merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }

  // Add color attribute if any geometry had colors
  if (colors) {
    merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }

  if (normals.every((n) => n === 0)) merged.computeVertexNormals();
  return merged;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

export class ProcgenTreeInstancer {
  private static inst: ProcgenTreeInstancer | null = null;

  /**
   * Debug flag to show floating impostors above all trees.
   * When enabled, creates a debug impostor 5m above each tree that is ALWAYS visible
   * (no LOD, no distance culling) to help debug impostor texture issues.
   *
   * Toggle at runtime: ProcgenTreeInstancer.DEBUG_IMPOSTORS = true;
   */
  static DEBUG_IMPOSTORS = false;

  private world: World;
  private scene: THREE.Scene;
  private meshes = new Map<string, Map<LODKey, MeshData>>();
  private impostors = new Map<string, ImpostorMeshData>();
  private instances = new Map<string, { preset: string; inst: TreeInstance }>();
  private dims = new Map<string, TreeDims>();
  private windSys: Wind | null;
  private windMats: WindMat[] = [];
  private isWebGPU: boolean;

  // Global leaf instancing
  private globalLeaves: GlobalLeafInstancer | null = null;
  private presetLeafData = new Map<
    string,
    { transforms: THREE.Matrix4[]; color: THREE.Color }
  >();
  private useGlobalLeaves = true; // Enable by default for optimal performance

  // Global leaf cluster instancing (LOD2 optimization)
  private globalClusters: GlobalLeafClusterInstancer | null = null;

  // Track pending impostor bakes - trees will use LOD2/LOD1 fallback until ready
  private pendingImpostors = new Set<string>();

  // Debug impostor meshes - separate from regular impostors, always visible
  private debugImpostors = new Map<string, ImpostorMeshData>();
  private debugImpostorCreated = new Set<string>(); // Track which presets have debug impostors
  // Store bake results for runtime debug impostor creation (includes all atlas textures)
  private impostorBakeResults = new Map<
    string,
    {
      atlasTexture: THREE.Texture;
      normalAtlasTexture: THREE.Texture | undefined;
      depthAtlasTexture: THREE.Texture | undefined;
      gridSizeX: number;
      gridSizeY: number;
    }
  >();

  // Debug atlas display - shows color/normal/depth atlases above trees
  private debugAtlasPlanes = new Map<
    string,
    {
      colorMesh: THREE.InstancedMesh;
      normalMesh: THREE.InstancedMesh | null;
      depthMesh: THREE.InstancedMesh | null;
      idxToId: Map<number, string>;
      nextIdx: number;
      count: number;
      dirty: boolean;
      width: number;
      height: number;
    }
  >();
  private debugAtlasCreated = new Set<string>();

  private dummy = new THREE.Object3D();
  private zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  private camPos = new THREE.Vector3();
  private tempWindDir = new THREE.Vector3();

  private lodEnabled = true;
  private lastLodUpdate = 0;
  private lodIdx = 0;
  private instArray: Array<{ preset: string; inst: TreeInstance }> = [];
  private time = 0;
  private transitions = new Set<string>();

  // Spatial partitioning for efficient LOD updates
  // Trees are binned into chunks for distance-based prioritization
  private readonly SPATIAL_CHUNK_SIZE = 32; // 32m chunks (smaller than entity chunks for finer granularity)
  private spatialChunks = new Map<string, Set<string>>(); // chunkKey -> Set<treeId>
  private treeChunkKeys = new Map<string, string>(); // treeId -> chunkKey
  private sortedChunks: string[] = []; // Chunks sorted by distance from camera
  private spatialDirty = true; // Need to resort chunks
  private lastSpatialSort = 0;
  private readonly SPATIAL_SORT_INTERVAL = 500; // Resort every 500ms

  // Lighting sync for impostors
  private _lastLightUpdate = 0;
  private _lightDir = new THREE.Vector3(0.5, 0.8, 0.3);
  private _lightColor = new THREE.Vector3(1, 1, 1);
  private _ambientColor = new THREE.Vector3(0.7, 0.8, 1.0);

  // View sampling for octahedral impostors
  private octMesh: ReturnType<typeof buildOctahedronMesh> | null = null;
  private raycaster = new THREE.Raycaster();
  private _faceIndices = new THREE.Vector3();
  private _faceWeights = new THREE.Vector3(1, 0, 0);
  private _viewDir = new THREE.Vector3();

  private constructor(world: World) {
    this.world = world;
    this.scene = world.stage?.scene as THREE.Scene;
    this.windSys = world.getSystem("wind") as Wind | null;
    this.isWebGPU = this.checkWebGPU();

    // Initialize global leaf instancer if scene is available
    if (this.scene && this.useGlobalLeaves) {
      this.globalLeaves = new GlobalLeafInstancer(this.scene);
      // Also initialize cluster instancer for LOD2 optimization
      this.globalClusters = new GlobalLeafClusterInstancer(this.scene);
    }

    // Initialize octahedron mesh for view sampling (16x8 hemisphere grid)
    this.octMesh = buildOctahedronMesh(
      OctahedronType.HEMI,
      16,
      8,
      [0, 0, 0],
      true,
    );
    lerpOctahedronGeometry(this.octMesh, 1.0);
    this.octMesh.filledMesh.geometry.computeBoundingSphere();
    this.octMesh.filledMesh.geometry.computeBoundingBox();
  }

  static getInstance(world: World): ProcgenTreeInstancer {
    if (!ProcgenTreeInstancer.inst) {
      ProcgenTreeInstancer.inst = new ProcgenTreeInstancer(world);
    }
    return ProcgenTreeInstancer.inst;
  }

  private checkWebGPU(): boolean {
    const stage = this.world.stage as
      { renderer?: { isWebGPURenderer?: boolean } } | undefined;
    return stage?.renderer?.isWebGPURenderer === true;
  }

  // ---------------------------------------------------------------------------
  // REGISTRATION
  // ---------------------------------------------------------------------------

  registerPreset(
    name: string,
    lod0: THREE.Group,
    lod1?: THREE.Group | null,
    lod2?: THREE.Group | null,
  ): void {
    if (this.meshes.has(name)) return;

    const d = this.calcDims(lod0);
    this.dims.set(name, d);

    const data = new Map<LODKey, MeshData>();
    const m0 = this.createMeshData(lod0, name, "lod0", d);
    if (m0) data.set("lod0", m0);
    if (lod1) {
      const m1 = this.createMeshData(lod1, name, "lod1", d);
      if (m1) data.set("lod1", m1);
    }
    // Skip LOD2 when SKIP_LOD2_MESH is true - prevents card tree/billboard rendering
    if (lod2 && !SKIP_LOD2_MESH) {
      const m2 = this.createMeshData(lod2, name, "lod2", d);
      if (m2) data.set("lod2", m2);
    }

    this.meshes.set(name, data);

    // Start impostor bake in background - trees will use LOD fallback until ready
    // Skip when DISABLE_IMPOSTORS is true - trees fade out via GPU dissolve shader
    if (!DISABLE_IMPOSTORS) {
      this.pendingImpostors.add(name);
      this.bakeImpostor(name, lod0).finally(() => {
        this.pendingImpostors.delete(name);
      });
    }

    console.log(
      `[TreeInstancer] ${name}: LOD0=${data.has("lod0")} LOD1=${data.has("lod1")} LOD2=${data.has("lod2")} h=${d.height.toFixed(1)}m`,
    );
  }

  private calcDims(group: THREE.Group): TreeDims {
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    return {
      width: Math.max(size.x, size.z),
      height: size.y,
      canopyR: Math.max(size.x, size.z) * 0.5,
      trunkH: size.y * 0.35,
    };
  }

  private async bakeImpostor(name: string, src: THREE.Group): Promise<void> {
    // Skip impostor baking when disabled - trees fade out via GPU dissolve shader
    if (DISABLE_IMPOSTORS) return;

    const mgr = ImpostorManager.getInstance(this.world);
    if (!mgr.initBaker()) return;

    // Use FULL bake mode to get normals + depth atlas for AAA quality:
    // - Normal atlas: dynamic lighting
    // - Depth atlas: depth-based frame blending (reduces ghosting/artifacts)
    // v7: Fixed framing to use max dimension instead of sphere radius
    //     Impostor now fills the cell properly for tall narrow trees
    const result = await mgr.getOrCreate(`procgen_tree_${name}_v7`, src, {
      atlasSize: IMPOSTOR_SIZE,
      hemisphere: true,
      priority: BakePriority.NORMAL,
      category: "tree_resource",
      gridSizeX: 16,
      gridSizeY: 8,
      bakeMode: ImpostorBakeMode.FULL, // Bake with normals + depth for AAA quality
    });

    if (!result.atlasTexture) return;

    // Store bake result for debug impostor/atlas creation (all textures)
    this.impostorBakeResults.set(name, {
      atlasTexture: result.atlasTexture,
      normalAtlasTexture: result.normalAtlasTexture,
      depthAtlasTexture: result.depthAtlasTexture,
      gridSizeX: result.gridSizeX,
      gridSizeY: result.gridSizeY,
    });

    // Calculate impostor dimensions to match baking
    // Baking fills a square cell based on MAX dimension (typically height for trees)
    // So the impostor plane must also be square based on max dimension
    const box = new THREE.Box3().setFromObject(src);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    // Use max dimension for both width and height to match baked square cell
    const w = maxDim;
    const h = maxDim;

    const geo = new THREE.PlaneGeometry(1, 1);

    // Diagnostic: check if atlas texture has content
    const tex = result.atlasTexture;
    const hasImage = !!tex?.image;
    const atlasImage = tex?.image as
      { width?: number; height?: number } | undefined;
    const imgWidth = atlasImage?.width ?? 0;
    const imgHeight = atlasImage?.height ?? 0;
    console.log(
      `[TreeInstancer] Creating impostor material for ${name}: ` +
        `hasImage=${hasImage}, size=${imgWidth}x${imgHeight}, ` +
        `hasNormals=${!!result.normalAtlasTexture}, hasDepth=${!!result.depthAtlasTexture}`,
    );

    if (!hasImage || imgWidth === 0) {
      console.error(
        `[TreeInstancer] WARNING: Atlas texture for ${name} has no image data!`,
      );
    }

    // Pass normal + depth atlas textures for AAA quality
    const mat = createTSLImpostorMaterial({
      atlasTexture: result.atlasTexture,
      normalAtlasTexture: result.normalAtlasTexture, // Enable dynamic lighting
      depthAtlasTexture: result.depthAtlasTexture, // Enable depth-based blending
      gridSizeX: result.gridSizeX,
      gridSizeY: result.gridSizeY,
      transparent: true,
      depthWrite: true,
      enableAAA: true, // Enable AAA features
    });
    this.world.setupMaterial?.(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.layers.set(1);
    mesh.name = `Tree_${name}_impostor`;
    this.scene?.add(mesh);

    this.impostors.set(name, {
      geometry: geo,
      material: mat,
      mesh,
      idxToId: new Map(),
      nextIdx: 0,
      count: 0,
      dirty: false,
      width: w,
      height: h,
    });

    // If debug mode is enabled, also create debug displays
    if (ProcgenTreeInstancer.DEBUG_IMPOSTORS) {
      this.createDebugImpostor(name, result, w, h);
      // Create atlas display showing color/normal/depth textures
      this.createDebugAtlasDisplay(
        name,
        {
          atlasTexture: result.atlasTexture,
          normalAtlasTexture: result.normalAtlasTexture,
          depthAtlasTexture: result.depthAtlasTexture,
          gridSizeX: result.gridSizeX,
          gridSizeY: result.gridSizeY,
        },
        w,
        h,
      );
    }
  }

  /**
   * Create a debug impostor mesh that floats 5m above trees.
   * Debug impostors are ALWAYS visible (no LOD, no distance culling).
   * Uses debug mode 0 (normal rendering) to show actual texture content.
   */
  private createDebugImpostor(
    name: string,
    result: {
      atlasTexture: THREE.Texture;
      gridSizeX: number;
      gridSizeY: number;
    },
    width: number,
    height: number,
  ): void {
    if (this.debugImpostorCreated.has(name)) return;
    this.debugImpostorCreated.add(name);

    const geo = new THREE.PlaneGeometry(1, 1);

    // Create debug material - use debugMode 0 for normal rendering
    // This helps verify if the texture has content
    const mat = createTSLImpostorMaterial({
      atlasTexture: result.atlasTexture,
      gridSizeX: result.gridSizeX,
      gridSizeY: result.gridSizeY,
      transparent: true,
      depthWrite: true,
      debugMode: 0, // Normal rendering to see actual texture
    });
    mat.side = THREE.DoubleSide;

    const mesh = new THREE.InstancedMesh(geo, mat, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.layers.set(1);
    mesh.name = `Tree_${name}_debug_impostor`;
    this.scene?.add(mesh);

    this.debugImpostors.set(name, {
      geometry: geo,
      material: mat,
      mesh,
      idxToId: new Map(),
      nextIdx: 0,
      count: 0,
      dirty: false,
      width: width,
      height: height,
    });

    console.log(
      `[TreeInstancer] Created debug impostor for ${name}: ` +
        `size=${width.toFixed(1)}x${height.toFixed(1)}, grid=${result.gridSizeX}x${result.gridSizeY}`,
    );
  }

  /**
   * Add a tree instance to the debug impostor mesh (floats 5m above tree).
   */
  private addToDebugImpostor(preset: string, inst: TreeInstance): void {
    const data = this.debugImpostors.get(preset);
    if (!data) return;

    const idx = data.nextIdx++;
    if (data.nextIdx >= MAX_INSTANCES) data.nextIdx = 0;

    // Position 5m above the tree
    this.dummy.position.copy(inst.position);
    this.dummy.position.y += data.height * inst.scale * 0.5 + 5; // 5m above normal impostor position
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(data.width * inst.scale, data.height * inst.scale, 1);
    this.dummy.updateMatrix();

    data.mesh.setMatrixAt(idx, this.dummy.matrix);
    data.idxToId.set(idx, inst.id);
    data.count = Math.max(data.count, idx + 1);
    data.mesh.count = data.count;
    data.dirty = true;
  }

  /**
   * Update debug impostors when DEBUG_IMPOSTORS flag is toggled on.
   * Creates debug impostors for any presets that have regular impostors but no debug version.
   */
  private updateDebugImpostors(): void {
    // IMPOSTORS COMPLETELY DISABLED - hide all debug impostors and return
    if (DISABLE_IMPOSTORS) {
      for (const data of this.debugImpostors.values()) {
        data.mesh.visible = false;
        data.mesh.count = 0;
      }
      return;
    }

    if (!ProcgenTreeInstancer.DEBUG_IMPOSTORS) {
      // Hide debug impostors when disabled
      for (const data of this.debugImpostors.values()) {
        data.mesh.visible = false;
      }
      return;
    }

    // Show debug impostors when enabled
    for (const data of this.debugImpostors.values()) {
      data.mesh.visible = true;
    }

    // Check if we need to create debug impostors for any new presets
    for (const [preset, impData] of this.impostors.entries()) {
      if (!this.debugImpostorCreated.has(preset)) {
        // Get stored bake result for this preset
        const bakeResult = this.impostorBakeResults.get(preset);
        if (!bakeResult) {
          console.warn(
            `[TreeInstancer] No bake result stored for ${preset}, cannot create debug impostor`,
          );
          continue;
        }

        // Create debug impostor from the stored bake result
        this.createDebugImpostor(
          preset,
          bakeResult,
          impData.width,
          impData.height,
        );

        // Add all existing instances to the debug impostor
        for (const { preset: p, inst } of this.instances.values()) {
          if (p === preset) {
            this.addToDebugImpostor(preset, inst);
          }
        }
      }
    }

    // Update dirty debug impostor matrices
    for (const data of this.debugImpostors.values()) {
      if (data.dirty) {
        data.mesh.instanceMatrix.needsUpdate = true;
        data.dirty = false;
      }
    }

    // Also update debug atlas display if enabled
    this.updateDebugAtlasDisplay();
  }

  /**
   * Create debug atlas display planes showing color/normal/depth atlases 5m above trees.
   * Shows the raw atlas textures as flat planes for visual debugging.
   */
  private createDebugAtlasDisplay(
    name: string,
    bakeResult: {
      atlasTexture: THREE.Texture;
      normalAtlasTexture: THREE.Texture | undefined;
      depthAtlasTexture: THREE.Texture | undefined;
      gridSizeX: number;
      gridSizeY: number;
    },
    _width: number,
    _height: number,
  ): void {
    if (this.debugAtlasCreated.has(name)) return;
    this.debugAtlasCreated.add(name);

    const atlasWidth = 2; // Display size for each atlas plane
    const atlasHeight =
      atlasWidth * (bakeResult.gridSizeY / bakeResult.gridSizeX);
    // spacing available for layout if multiple atlases displayed
    // const spacing = 0.2;

    // Helper to create a simple textured plane material
    const createAtlasMaterial = (
      tex: THREE.Texture,
      label: string,
    ): MeshBasicNodeMaterial => {
      const mat = new MeshBasicNodeMaterial();
      // Ensure texture is marked for GPU upload (render target textures may need this)
      tex.needsUpdate = true;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      mat.map = tex;
      mat.transparent = true;
      mat.side = THREE.DoubleSide;
      mat.name = `Atlas_${name}_${label}`;
      return mat;
    };

    const geo = new THREE.PlaneGeometry(1, 1);

    // Color atlas (always present)
    const colorMat = createAtlasMaterial(bakeResult.atlasTexture, "color");
    const colorMesh = new THREE.InstancedMesh(geo, colorMat, MAX_INSTANCES);
    colorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    colorMesh.count = 0;
    colorMesh.frustumCulled = false;
    colorMesh.layers.set(1);
    colorMesh.name = `Tree_${name}_atlas_color`;
    this.scene?.add(colorMesh);

    // Normal atlas (if available)
    let normalMesh: THREE.InstancedMesh | null = null;
    if (bakeResult.normalAtlasTexture) {
      const normalMat = createAtlasMaterial(
        bakeResult.normalAtlasTexture,
        "normal",
      );
      normalMesh = new THREE.InstancedMesh(
        geo.clone(),
        normalMat,
        MAX_INSTANCES,
      );
      normalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      normalMesh.count = 0;
      normalMesh.frustumCulled = false;
      normalMesh.layers.set(1);
      normalMesh.name = `Tree_${name}_atlas_normal`;
      this.scene?.add(normalMesh);
    }

    // Depth atlas (if available)
    let depthMesh: THREE.InstancedMesh | null = null;
    if (bakeResult.depthAtlasTexture) {
      const depthMat = createAtlasMaterial(
        bakeResult.depthAtlasTexture,
        "depth",
      );
      depthMesh = new THREE.InstancedMesh(geo.clone(), depthMat, MAX_INSTANCES);
      depthMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      depthMesh.count = 0;
      depthMesh.frustumCulled = false;
      depthMesh.layers.set(1);
      depthMesh.name = `Tree_${name}_atlas_depth`;
      this.scene?.add(depthMesh);
    }

    this.debugAtlasPlanes.set(name, {
      colorMesh,
      normalMesh,
      depthMesh,
      idxToId: new Map(),
      nextIdx: 0,
      count: 0,
      dirty: false,
      width: atlasWidth,
      height: atlasHeight,
    });

    console.log(
      `[TreeInstancer] Created debug atlas display for ${name}: ` +
        `color=yes, normal=${!!normalMesh}, depth=${!!depthMesh}, ` +
        `size=${atlasWidth.toFixed(1)}x${atlasHeight.toFixed(1)}`,
    );
  }

  /**
   * Add a tree instance to the debug atlas display (5m above tree, shows 3 atlases side by side).
   */
  private addToDebugAtlasDisplay(preset: string, inst: TreeInstance): void {
    const data = this.debugAtlasPlanes.get(preset);
    if (!data) return;

    const idx = data.nextIdx++;
    if (data.nextIdx >= MAX_INSTANCES) data.nextIdx = 0;

    const spacing = 0.3;
    const totalWidth = data.width * 3 + spacing * 2;
    const baseX = -totalWidth / 2 + data.width / 2;

    // Position 5m above the tree center
    const baseY = inst.position.y + 5;

    // Color atlas (left)
    this.dummy.position.set(inst.position.x + baseX, baseY, inst.position.z);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(data.width, data.height, 1);
    this.dummy.updateMatrix();
    data.colorMesh.setMatrixAt(idx, this.dummy.matrix);

    // Normal atlas (center)
    if (data.normalMesh) {
      this.dummy.position.set(
        inst.position.x + baseX + data.width + spacing,
        baseY,
        inst.position.z,
      );
      this.dummy.updateMatrix();
      data.normalMesh.setMatrixAt(idx, this.dummy.matrix);
    }

    // Depth atlas (right)
    if (data.depthMesh) {
      this.dummy.position.set(
        inst.position.x + baseX + (data.width + spacing) * 2,
        baseY,
        inst.position.z,
      );
      this.dummy.updateMatrix();
      data.depthMesh.setMatrixAt(idx, this.dummy.matrix);
    }

    data.idxToId.set(idx, inst.id);
    data.count = Math.max(data.count, idx + 1);
    data.colorMesh.count = data.count;
    if (data.normalMesh) data.normalMesh.count = data.count;
    if (data.depthMesh) data.depthMesh.count = data.count;
    data.dirty = true;
  }

  /**
   * Update debug atlas display when DEBUG_IMPOSTORS flag is toggled on.
   */
  private updateDebugAtlasDisplay(): void {
    // IMPOSTORS COMPLETELY DISABLED - hide all debug atlas planes and return
    if (DISABLE_IMPOSTORS) {
      for (const data of this.debugAtlasPlanes.values()) {
        data.colorMesh.visible = false;
        data.colorMesh.count = 0;
        if (data.normalMesh) {
          data.normalMesh.visible = false;
          data.normalMesh.count = 0;
        }
        if (data.depthMesh) {
          data.depthMesh.visible = false;
          data.depthMesh.count = 0;
        }
      }
      return;
    }

    if (!ProcgenTreeInstancer.DEBUG_IMPOSTORS) {
      // Hide debug atlas planes when disabled
      for (const data of this.debugAtlasPlanes.values()) {
        data.colorMesh.visible = false;
        if (data.normalMesh) data.normalMesh.visible = false;
        if (data.depthMesh) data.depthMesh.visible = false;
      }
      return;
    }

    // Show debug atlas planes when enabled
    for (const data of this.debugAtlasPlanes.values()) {
      data.colorMesh.visible = true;
      if (data.normalMesh) data.normalMesh.visible = true;
      if (data.depthMesh) data.depthMesh.visible = true;
    }

    // Check if we need to create debug atlas planes for any new presets
    for (const [preset, impData] of this.impostors.entries()) {
      if (!this.debugAtlasCreated.has(preset)) {
        const bakeResult = this.impostorBakeResults.get(preset);
        if (!bakeResult) continue;

        this.createDebugAtlasDisplay(
          preset,
          bakeResult,
          impData.width,
          impData.height,
        );

        // Add all existing instances
        for (const { preset: p, inst } of this.instances.values()) {
          if (p === preset) {
            this.addToDebugAtlasDisplay(preset, inst);
          }
        }
      }
    }

    // Update dirty matrices
    for (const data of this.debugAtlasPlanes.values()) {
      if (data.dirty) {
        data.colorMesh.instanceMatrix.needsUpdate = true;
        if (data.normalMesh) data.normalMesh.instanceMatrix.needsUpdate = true;
        if (data.depthMesh) data.depthMesh.instanceMatrix.needsUpdate = true;
        data.dirty = false;
      }
    }
  }

  private createMeshData(
    group: THREE.Group,
    name: string,
    lod: LODKey,
    dims: TreeDims,
  ): MeshData | null {
    const geos: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    const leafTransforms: THREE.Matrix4[] = [];
    let leafColor = new THREE.Color(0x3d7a3d);

    group.traverse((child) => {
      // Skip InstancedMesh (leaves) - we handle them separately
      // NOTE: We use isInstancedMesh property instead of instanceof because
      // procgen uses 'three' while shared uses 'three/webgpu' - different classes!
      const isInstancedMesh =
        (child as THREE.Object3D & { isInstancedMesh?: boolean })
          .isInstancedMesh === true;
      if (isInstancedMesh) {
        const instancedChild = child as THREE.InstancedMesh;
        // Extract leaf transforms for global instancing
        if (this.useGlobalLeaves && lod === "lod0") {
          const instanceCount = instancedChild.count;
          const tempMatrix = new THREE.Matrix4();

          for (let i = 0; i < instanceCount; i++) {
            instancedChild.getMatrixAt(i, tempMatrix);
            leafTransforms.push(tempMatrix.clone());
          }

          // Extract leaf color from material
          // Handle standard materials, shader materials, and TSL node materials
          // NOTE: Use duck typing for ShaderMaterial too - different classes between three/webgpu and three
          const mat = Array.isArray(instancedChild.material)
            ? instancedChild.material[0]
            : instancedChild.material;
          if (mat) {
            let colorSource = "none";

            // Duck type check for ShaderMaterial with uColor uniform (procgen leaves)
            const shaderMat = mat as THREE.ShaderMaterial & {
              uniforms?: Record<string, { value: unknown }>;
            };
            if (shaderMat.uniforms?.uColor?.value) {
              const uColor = shaderMat.uniforms.uColor.value;
              if (
                uColor &&
                typeof uColor === "object" &&
                "r" in uColor &&
                "g" in uColor &&
                "b" in uColor
              ) {
                leafColor = new THREE.Color(
                  (uColor as THREE.Color).r,
                  (uColor as THREE.Color).g,
                  (uColor as THREE.Color).b,
                );
                colorSource = "ShaderMaterial.uniforms.uColor";
              }
            } else if (
              mat instanceof MeshStandardNodeMaterial &&
              "leafUniforms" in mat
            ) {
              // TSL node material with leafUniforms (GlobalLeafInstancer style)
              const leafMat = mat as LeafNodeMaterial;
              if (leafMat.leafUniforms?.baseColor?.value) {
                leafColor = leafMat.leafUniforms.baseColor.value.clone();
                colorSource = "leafUniforms.baseColor";
              }
            } else if ("color" in mat) {
              // Standard material with color property
              const colorMat = mat as { color?: THREE.Color };
              if (colorMat.color && "r" in colorMat.color) {
                leafColor = new THREE.Color(
                  colorMat.color.r,
                  colorMat.color.g,
                  colorMat.color.b,
                );
                colorSource = "mat.color";
              }
            }

            // Debug log leaf color extraction
            console.log(
              `[TreeInstancer] ${name} leaf color: rgb(${leafColor.r.toFixed(2)}, ${leafColor.g.toFixed(2)}, ${leafColor.b.toFixed(2)}) from ${colorSource}, mat.type=${mat.type}`,
            );
          }
        }
        return;
      }

      // Regular Mesh - merge into trunk geometry
      // NOTE: Use isMesh property for cross-build compatibility (three vs three/webgpu)
      const isMesh =
        (child as THREE.Object3D & { isMesh?: boolean }).isMesh === true;
      const meshChild = child as THREE.Mesh;
      if (isMesh && meshChild.geometry) {
        const geo = meshChild.geometry.clone();
        if (!meshChild.matrix.equals(new THREE.Matrix4().identity()))
          geo.applyMatrix4(meshChild.matrix);
        geos.push(geo);
        const m = Array.isArray(meshChild.material)
          ? meshChild.material[0]
          : meshChild.material;
        if (m && !mats.includes(m)) mats.push(m);
      }
    });

    // Store leaf data for this preset
    if (leafTransforms.length > 0 && lod === "lod0") {
      this.presetLeafData.set(name, {
        transforms: leafTransforms,
        color: leafColor,
      });
      console.log(
        `[TreeInstancer] ${name}: Extracted ${leafTransforms.length} leaf transforms for global instancing`,
      );

      // Also register cluster data for LOD2 optimization
      if (this.globalClusters) {
        this.globalClusters.registerPresetClusters(
          name,
          leafTransforms,
          leafColor,
          { height: dims.height, canopyR: dims.canopyR },
        );
        console.log(
          `[TreeInstancer] ${name}: Registered leaf clusters for LOD2`,
        );
      }
    }

    if (geos.length === 0) return null;

    const merged = mergeGeometries(geos);
    const baseMat =
      mats[0] ?? new THREE.MeshLambertMaterial({ color: 0x228b22 });

    const material =
      lod === "lod1"
        ? createWindMaterial(baseMat, dims)
        : createDissolveMaterial(baseMat);

    // Enable vertex colors if the merged geometry has them
    if (merged.attributes.color) {
      material.vertexColors = true;
    }

    if (lod === "lod1") this.windMats.push(material as WindMat);
    this.world.setupMaterial?.(material);

    const mesh = new THREE.InstancedMesh(merged, material, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    // Let the actual tree geometry cast shadows - looks much better than simplified shapes
    mesh.castShadow = lod === "lod0" || lod === "lod1";
    mesh.receiveShadow = true;
    mesh.layers.set(1);
    mesh.name = `Tree_${name}_${lod}`;

    const fadeArr = new Float32Array(MAX_INSTANCES).fill(1);
    const fadeAttr = new THREE.InstancedBufferAttribute(fadeArr, 1);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute("instanceFade", fadeAttr);

    // No separate shadow mesh - main mesh casts shadows directly
    const shadowMesh: THREE.InstancedMesh | null = null;
    const shadowGeo: THREE.BufferGeometry | null = null;

    this.scene?.add(mesh);

    return {
      geometry: merged,
      material,
      mesh,
      fadeAttr,
      idxToId: new Map(),
      nextIdx: 0,
      count: 0,
      dirty: false,
      shadowMesh,
      shadowGeo,
    };
  }

  // ---------------------------------------------------------------------------
  // INSTANCE MANAGEMENT
  // ---------------------------------------------------------------------------

  addInstance(
    preset: string,
    id: string,
    pos: THREE.Vector3,
    rot: number,
    scale: number,
    _lodLevel = 0,
  ): boolean {
    if (!this.meshes.has(preset) || this.instances.has(id))
      return this.instances.has(id);

    const d = this.dims.get(preset);
    const inst: TreeInstance = {
      id,
      position: pos.clone(),
      rotation: rot,
      scale,
      currentLOD: -1,
      lodIndices: [-1, -1, -1, -1],
      transition: null,
      radius: d ? Math.max(d.width, d.height) * scale * 0.5 : 5,
      hasGlobalLeaves: false,
      clusterLOD: -1,
      clusterDensity: 0,
      distanceFade: 1, // Start fully visible, will be updated by LOD system
    };

    this.instances.set(id, { preset, inst });

    // Add to spatial partitioning for efficient LOD updates
    this.addToSpatialChunk(id, pos.x, pos.z);

    this.updateLOD(preset, inst);

    // NOTE: Grass exclusion is handled by ProceduralGrass.collectAndRefreshExclusionTexture()
    // which reads all tree positions at once. No per-tree registration needed.

    // If debug mode is enabled, also add to debug displays
    if (ProcgenTreeInstancer.DEBUG_IMPOSTORS) {
      if (this.debugImpostors.has(preset)) {
        this.addToDebugImpostor(preset, inst);
      }
      if (this.debugAtlasPlanes.has(preset)) {
        this.addToDebugAtlasDisplay(preset, inst);
      }
    }

    return true;
  }

  // NOTE: Individual leaves are now active and shown at ALL LOD levels
  // They fade together with the trunk mesh at cull distance
  // Clusters are disabled (ENABLE_LOD1_CLUSTERS = false, ENABLE_LOD2_CLUSTERS = false)

  /**
   * Add leaf clusters for a tree with specified density.
   * @param preset - Tree preset name
   * @param inst - Tree instance
   * @param density - Cluster density (0-1), defaults to 1.0
   */
  private addTreeClustersToGlobal(
    preset: string,
    inst: TreeInstance,
    density: number = 1.0,
  ): void {
    if (!this.globalClusters) return;

    // Remove existing clusters first if present
    if (inst.clusterLOD >= 0) {
      this.globalClusters.removeTree(inst.id);
    }

    // Clusters are pre-computed during preset registration
    // Pass density for LOD-based stochastic culling
    this.globalClusters.addTree(
      inst.id,
      preset,
      inst.position,
      inst.rotation,
      inst.scale,
      density,
    );
  }

  /**
   * Remove leaf clusters for a tree.
   */
  private removeTreeClustersFromGlobal(inst: TreeInstance): void {
    if (!this.globalClusters || inst.clusterLOD < 0) return;

    this.globalClusters.removeTree(inst.id);
    inst.clusterLOD = -1;
    inst.clusterDensity = 0;
  }

  /**
   * Add individual leaves for a tree (LOD0 only - high detail).
   */
  private addTreeLeavesToGlobal(preset: string, inst: TreeInstance): void {
    if (!this.globalLeaves || inst.hasGlobalLeaves) return;

    const leafData = this.presetLeafData.get(preset);
    if (!leafData || leafData.transforms.length === 0) return;

    // Apply tree transform to leaf matrices
    const worldTransforms: THREE.Matrix4[] = [];
    const treeMat = new THREE.Matrix4();
    treeMat.makeRotationY(inst.rotation);
    treeMat.setPosition(inst.position);
    treeMat.scale(new THREE.Vector3(inst.scale, inst.scale, inst.scale));

    for (const localMat of leafData.transforms) {
      const worldMat = new THREE.Matrix4().multiplyMatrices(treeMat, localMat);
      worldTransforms.push(worldMat);
    }

    this.globalLeaves.addTreeLeaves(inst.id, worldTransforms, leafData.color);
    inst.hasGlobalLeaves = true;
  }

  /**
   * Remove individual leaves for a tree.
   */
  private removeTreeLeavesFromGlobal(inst: TreeInstance): void {
    if (!this.globalLeaves || !inst.hasGlobalLeaves) return;

    this.globalLeaves.removeTreeLeaves(inst.id);
    inst.hasGlobalLeaves = false;
  }

  removeInstance(_preset: string, id: string, _lodLevel = 0): void {
    const tracked = this.instances.get(id);
    if (!tracked) return;

    this.removeTreeLeavesFromGlobal(tracked.inst);
    this.removeTreeClustersFromGlobal(tracked.inst);

    this.transitions.delete(id);
    for (let lod = 0; lod < 4; lod++)
      this.removeFromLOD(tracked.preset, tracked.inst, lod);

    this.removeFromSpatialChunk(id);

    this.instances.delete(id);
  }

  // ---------------------------------------------------------------------------
  // SPATIAL PARTITIONING
  // ---------------------------------------------------------------------------

  /**
   * Get chunk key for a world position.
   */
  private getSpatialChunkKey(x: number, z: number): string {
    const cx = Math.floor(x / this.SPATIAL_CHUNK_SIZE);
    const cz = Math.floor(z / this.SPATIAL_CHUNK_SIZE);
    return `${cx}_${cz}`;
  }

  /**
   * Add a tree to its spatial chunk.
   */
  private addToSpatialChunk(treeId: string, x: number, z: number): void {
    const chunkKey = this.getSpatialChunkKey(x, z);

    let chunk = this.spatialChunks.get(chunkKey);
    if (!chunk) {
      chunk = new Set();
      this.spatialChunks.set(chunkKey, chunk);
    }
    chunk.add(treeId);

    this.treeChunkKeys.set(treeId, chunkKey);
    this.spatialDirty = true;
  }

  /**
   * Remove a tree from its spatial chunk.
   */
  private removeFromSpatialChunk(treeId: string): void {
    const chunkKey = this.treeChunkKeys.get(treeId);
    if (!chunkKey) return;

    const chunk = this.spatialChunks.get(chunkKey);
    if (chunk) {
      chunk.delete(treeId);
      if (chunk.size === 0) {
        this.spatialChunks.delete(chunkKey);
      }
    }

    this.treeChunkKeys.delete(treeId);
    this.spatialDirty = true;
  }

  /**
   * Get chunk center position for distance calculations.
   */
  private getChunkCenter(chunkKey: string): { x: number; z: number } {
    const [cx, cz] = chunkKey.split("_").map(Number);
    return {
      x: (cx + 0.5) * this.SPATIAL_CHUNK_SIZE,
      z: (cz + 0.5) * this.SPATIAL_CHUNK_SIZE,
    };
  }

  /**
   * Sort chunks by distance from camera (nearest first).
   * Called periodically to update prioritization.
   */
  private sortChunksByDistance(): void {
    this.sortedChunks = Array.from(this.spatialChunks.keys());

    // Sort by distance from camera
    this.sortedChunks.sort((a, b) => {
      const centerA = this.getChunkCenter(a);
      const centerB = this.getChunkCenter(b);

      const distSqA =
        (centerA.x - this.camPos.x) ** 2 + (centerA.z - this.camPos.z) ** 2;
      const distSqB =
        (centerB.x - this.camPos.x) ** 2 + (centerB.z - this.camPos.z) ** 2;

      return distSqA - distSqB;
    });

    this.spatialDirty = false;
  }

  // Spatial update tracking
  private spatialChunkIdx = 0;
  private spatialTreeIdxInChunk = 0;
  private chunkTreeArrays = new Map<string, string[]>(); // Cached arrays for iteration

  /**
   * Get trees to update this frame, prioritized by distance.
   * Cycles through chunks in distance order, updating some trees from each.
   *
   * Strategy: Weighted round-robin based on distance
   * - Nearby chunks (LOD0 range): Update every frame
   * - Medium chunks (LOD1 range): Update every other cycle
   * - Far chunks (LOD2 range): Update every 4th cycle
   */
  private getTreesToUpdate(maxCount: number): Array<{
    preset: string;
    inst: TreeInstance;
  }> {
    // Resort chunks periodically or when dirty
    if (
      this.spatialDirty ||
      this.time - this.lastSpatialSort >= this.SPATIAL_SORT_INTERVAL
    ) {
      this.sortChunksByDistance();
      this.lastSpatialSort = this.time;
      // Rebuild tree arrays for iteration
      this.chunkTreeArrays.clear();
      for (const [key, set] of this.spatialChunks) {
        this.chunkTreeArrays.set(key, Array.from(set));
      }
    }

    const result: Array<{ preset: string; inst: TreeInstance }> = [];
    const lodDistSq = {
      lod0: LOD_DIST_SQ.lod1, // Trees within LOD1 distance are high priority
      lod1: LOD_DIST_SQ.lod2, // Trees within LOD2 distance are medium priority
    };

    // Process chunks in distance order with weighted priority
    const numChunks = this.sortedChunks.length;
    if (numChunks === 0) return result;

    let remaining = maxCount;
    let chunksProcessed = 0;
    const maxChunksPerFrame = Math.min(20, numChunks); // Limit chunks per frame

    // Start from current chunk index and cycle
    let chunkIdx = this.spatialChunkIdx;

    while (remaining > 0 && chunksProcessed < maxChunksPerFrame) {
      const chunkKey = this.sortedChunks[chunkIdx % numChunks];
      const treeArray = this.chunkTreeArrays.get(chunkKey);

      if (treeArray && treeArray.length > 0) {
        // Determine how many trees to update from this chunk based on distance
        const center = this.getChunkCenter(chunkKey);
        const chunkDistSq =
          (center.x - this.camPos.x) ** 2 + (center.z - this.camPos.z) ** 2;

        // Priority based on distance:
        // - Near (< LOD1 dist): Update up to 5 trees
        // - Medium (LOD1-LOD2): Update up to 2 trees
        // - Far (> LOD2): Update 1 tree
        let treesFromChunk: number;
        if (chunkDistSq < lodDistSq.lod0) {
          treesFromChunk = Math.min(5, treeArray.length, remaining);
        } else if (chunkDistSq < lodDistSq.lod1) {
          treesFromChunk = Math.min(2, treeArray.length, remaining);
        } else {
          treesFromChunk = Math.min(1, treeArray.length, remaining);
        }

        // Get trees from this chunk
        for (let i = 0; i < treesFromChunk; i++) {
          const treeId =
            treeArray[(this.spatialTreeIdxInChunk + i) % treeArray.length];
          const tracked = this.instances.get(treeId);
          if (tracked) {
            result.push(tracked);
            remaining--;
          }
        }

        this.spatialTreeIdxInChunk =
          (this.spatialTreeIdxInChunk + treesFromChunk) %
          Math.max(1, treeArray.length);
      }

      chunkIdx++;
      chunksProcessed++;
    }

    // Update chunk index for next frame
    this.spatialChunkIdx = chunkIdx % Math.max(1, numChunks);

    return result;
  }

  setPresetVisible(preset: string, visible: boolean): void {
    const data = this.meshes.get(preset);
    if (data) {
      for (const d of data.values()) {
        d.mesh.visible = visible;
        if (d.shadowMesh) d.shadowMesh.visible = visible;
      }
    }
    const imp = this.impostors.get(preset);
    if (imp) imp.mesh.visible = visible;
  }

  // ---------------------------------------------------------------------------
  // LOD MANAGEMENT
  // ---------------------------------------------------------------------------

  private updateLOD(preset: string, inst: TreeInstance): void {
    const dx = inst.position.x - this.camPos.x;
    const dz = inst.position.z - this.camPos.z;
    const distSq = dx * dx + dz * dz;
    const cur = inst.currentLOD;
    const meshMap = this.meshes.get(preset);
    const hasImpostor = !DISABLE_IMPOSTORS && this.impostors.has(preset);

    // Calculate distance-based fade for dissolve effect
    // Trees dissolve in/out over the fade zone (100m to 110m)
    let distanceFade = 1.0;
    if (distSq >= FADE_ZONE_SQ.end) {
      distanceFade = 0.0; // Beyond cull distance - invisible
    } else if (distSq > FADE_ZONE_SQ.start) {
      // In fade zone - interpolate based on distance
      // fade = 1 at start, 0 at end
      const t =
        (distSq - FADE_ZONE_SQ.start) / (FADE_ZONE_SQ.end - FADE_ZONE_SQ.start);
      distanceFade = 1.0 - t; // Linear fade, smooth would be: 1.0 - (t * t * (3 - 2 * t));
    }

    // Store current fade on instance for continuous updates
    inst.distanceFade = distanceFade;

    // Check what LODs are available for this preset
    const hasLOD0 = meshMap?.has("lod0") ?? false;
    const hasLOD1 = meshMap?.has("lod1") ?? false;
    const hasLOD2 = meshMap?.has("lod2") ?? false;

    // Force impostor mode when rendering for reflection camera (performance)
    // Only when impostors are enabled
    const forceImpostor =
      !DISABLE_IMPOSTORS && this.world.isRenderingReflection && hasImpostor;

    // Determine target LOD with hysteresis, considering availability
    // When DISABLE_IMPOSTORS is true, stay on best available 3D LOD and let GPU dissolve fade
    let target: number;
    if (distSq >= LOD_DIST_SQ.cull) {
      target = 4; // Culled
    } else if (DISABLE_IMPOSTORS) {
      // IMPOSTORS DISABLED: Stay on best available 3D LOD, let GPU shader dissolve fade
      if (distSq >= LOD_DIST_SQ.lod2 - (cur === 2 ? HYSTERESIS_SQ : 0)) {
        target = hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
      } else if (distSq >= LOD_DIST_SQ.lod1 - (cur === 1 ? HYSTERESIS_SQ : 0)) {
        target = hasLOD1 ? 1 : 0;
      } else {
        target = 0;
      }
    } else if (
      forceImpostor ||
      distSq >= LOD_DIST_SQ.impostor - (cur === 3 ? HYSTERESIS_SQ : 0)
    ) {
      // Impostor distance: use impostor if available, else fallback
      target = hasImpostor ? 3 : hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
    } else if (distSq >= LOD_DIST_SQ.lod2 - (cur === 2 ? HYSTERESIS_SQ : 0)) {
      // LOD2 distance: use LOD2 if available, else fallback to LOD1 or LOD0
      target = hasLOD2 ? 2 : hasLOD1 ? 1 : 0;
    } else if (distSq >= LOD_DIST_SQ.lod1 - (cur === 1 ? HYSTERESIS_SQ : 0)) {
      // LOD1 distance: use LOD1 if available, else LOD0
      target = hasLOD1 ? 1 : 0;
    } else {
      target = 0; // LOD0 always available
    }

    if (target === cur) return;

    // Handle foliage visibility:
    // Leaves stay visible at ALL LOD levels (0, 1, 2) and fade with the trunk
    // Only removed when tree is culled (LOD4)
    // This ensures trunk and leaves dissolve together at the same distance

    const hadIndividualLeaves = inst.hasGlobalLeaves;
    const hadClusters = inst.clusterLOD >= 0;

    // Individual leaves transitions - stay visible until culled
    // Leaves shown at LOD0, LOD1, LOD2 (target < 4) - removed only when culled
    const wantsIndividualLeaves = ENABLE_LOD0_LEAVES && target < 4;
    if (wantsIndividualLeaves && !hadIndividualLeaves) {
      // Tree becoming visible - add individual instanced leaves
      this.addTreeLeavesToGlobal(preset, inst);
    } else if (!wantsIndividualLeaves && hadIndividualLeaves) {
      // Tree being culled - remove individual leaves
      this.removeTreeLeavesFromGlobal(inst);
    }

    // Cluster transitions (LOD1 and optionally LOD2)
    const wantsLOD1Clusters = ENABLE_LOD1_CLUSTERS && target === 1;
    const wantsLOD2Clusters = ENABLE_LOD2_CLUSTERS && target === 2;
    const wantsClusters = wantsLOD1Clusters || wantsLOD2Clusters;

    const targetDensity = wantsLOD1Clusters
      ? CLUSTER_DENSITY.lod1
      : wantsLOD2Clusters
        ? CLUSTER_DENSITY.lod2
        : 0;

    if (wantsClusters) {
      if (!hadClusters) {
        // Entering cluster LODs - add clusters with target density
        this.addTreeClustersToGlobal(preset, inst, targetDensity);
        inst.clusterLOD = target;
        inst.clusterDensity = targetDensity;
      } else if (inst.clusterDensity !== targetDensity) {
        // Changing LOD within cluster range - update density
        this.removeTreeClustersFromGlobal(inst);
        this.addTreeClustersToGlobal(preset, inst, targetDensity);
        inst.clusterLOD = target;
        inst.clusterDensity = targetDensity;
      }
    } else if (hadClusters) {
      // Leaving cluster LODs - remove clusters
      this.removeTreeClustersFromGlobal(inst);
      inst.clusterLOD = -1;
      inst.clusterDensity = 0;
    }

    // Cross-fade only for LOD0 <-> LOD1 (both must be available)
    const crossFade =
      cur >= 0 &&
      hasLOD0 &&
      hasLOD1 &&
      ((cur === 0 && target === 1) || (cur === 1 && target === 0));

    if (crossFade) {
      inst.transition = { from: cur, to: target, start: this.time };
      this.transitions.add(inst.id);
      this.addToLOD(preset, inst, target);
      this.setFade(preset, inst, target, 0);
      this.setFade(preset, inst, cur, 1);
    } else {
      this.removeFromLOD(preset, inst, cur);
      this.addToLOD(preset, inst, target);

      // Apply distance-based fade for non-crossfade transitions
      // This makes trees dissolve in/out based on distance
      if (target >= 0 && target <= 2) {
        this.setFade(preset, inst, target, distanceFade);
      }
    }
    inst.currentLOD = target;
  }

  /**
   * Update distance-based fades for all visible trees.
   * Called every frame to ensure smooth dissolve effects.
   */
  private updateDistanceFades(): void {
    for (const tracked of this.instances.values()) {
      const { preset, inst } = tracked;

      // Skip trees that are culled or in transition
      if (inst.currentLOD < 0 || inst.currentLOD >= 4 || inst.transition)
        continue;

      // Calculate distance-based fade
      const dx = inst.position.x - this.camPos.x;
      const dz = inst.position.z - this.camPos.z;
      const distSq = dx * dx + dz * dz;

      let distanceFade = 1.0;
      if (distSq >= FADE_ZONE_SQ.end) {
        distanceFade = 0.0;
      } else if (distSq > FADE_ZONE_SQ.start) {
        const t =
          (distSq - FADE_ZONE_SQ.start) /
          (FADE_ZONE_SQ.end - FADE_ZONE_SQ.start);
        distanceFade = 1.0 - t;
      }

      // Only update if fade changed significantly (avoid constant GPU uploads)
      if (Math.abs(distanceFade - inst.distanceFade) > 0.02) {
        inst.distanceFade = distanceFade;
        this.setFade(preset, inst, inst.currentLOD, distanceFade);
      }
    }
  }

  private setFade(
    preset: string,
    inst: TreeInstance,
    lod: number,
    fade: number,
  ): void {
    if (lod < 0 || lod > 3) return;

    // Handle mesh fades (LOD0, LOD1, LOD2 trunk/branches)
    if (lod <= 2) {
      const key = ["lod0", "lod1", "lod2"][lod] as LODKey;
      const data = this.meshes.get(preset)?.get(key);
      const idx = inst.lodIndices[lod];
      if (data && idx >= 0) {
        data.fadeAttr.setX(idx, fade);
        data.fadeAttr.needsUpdate = true;
      }
    }

    // Handle individual leaf fades - apply at ALL LODs when tree has leaves
    // This ensures leaves fade together with the trunk
    if (this.globalLeaves && inst.hasGlobalLeaves) {
      this.globalLeaves.setTreeFade(inst.id, fade);
    }

    // Handle cluster fades (LOD1 and LOD2 only)
    if (
      (lod === 1 || lod === 2) &&
      this.globalClusters &&
      inst.clusterLOD >= 0
    ) {
      this.globalClusters.setFade(inst.id, fade);
    }
  }

  private addToLOD(preset: string, inst: TreeInstance, lod: number): void {
    const meshMap = this.meshes.get(preset);

    // LOD availability is already checked in updateLOD, so we can use direct access
    if (lod === 0) {
      const d = meshMap?.get("lod0");
      if (d) inst.lodIndices[0] = this.showInMesh(d, inst);
    } else if (lod === 1) {
      const d = meshMap?.get("lod1");
      if (d) inst.lodIndices[1] = this.showInMesh(d, inst);
    } else if (lod === 2) {
      const d = meshMap?.get("lod2");
      if (d) inst.lodIndices[2] = this.showInMesh(d, inst);
    } else if (lod === 3) {
      // IMPOSTORS DISABLED - this code path should never execute
      // but guard it anyway to prevent any black quad rendering
      if (!DISABLE_IMPOSTORS) {
        const d = this.impostors.get(preset);
        if (d) inst.lodIndices[3] = this.showImpostor(d, inst);
      }
    }
    // LOD 4 = culled, nothing to add
  }

  private removeFromLOD(preset: string, inst: TreeInstance, lod: number): void {
    const idx = inst.lodIndices[lod];
    if (idx < 0) return;

    if (lod < 3) {
      const key = ["lod0", "lod1", "lod2"][lod] as LODKey;
      const data = this.meshes.get(preset)?.get(key);
      if (data) {
        data.mesh.setMatrixAt(idx, this.zeroMatrix);
        data.shadowMesh?.setMatrixAt(idx, this.zeroMatrix);
        data.shadowMesh && (data.shadowMesh.instanceMatrix.needsUpdate = true);
        data.idxToId.delete(idx);
        data.dirty = true;
      }
    } else {
      const imp = this.impostors.get(preset);
      if (imp) {
        imp.mesh.setMatrixAt(idx, this.zeroMatrix);
        imp.idxToId.delete(idx);
        imp.dirty = true;
      }
    }
    inst.lodIndices[lod] = -1;
  }

  private showInMesh(data: MeshData, inst: TreeInstance): number {
    if (data.count >= MAX_INSTANCES) {
      console.warn(
        `[ProcgenTreeInstancer] MAX_INSTANCES (${MAX_INSTANCES}) reached, cannot show ${inst.id}`,
      );
      return -1;
    }

    const idx = data.nextIdx++;
    if (data.nextIdx >= MAX_INSTANCES) data.nextIdx = 0;

    this.dummy.position.copy(inst.position);
    this.dummy.rotation.set(0, inst.rotation, 0);
    this.dummy.scale.setScalar(inst.scale);
    this.dummy.updateMatrix();

    data.mesh.setMatrixAt(idx, this.dummy.matrix);
    if (data.shadowMesh) {
      data.shadowMesh.setMatrixAt(idx, this.dummy.matrix);
      data.shadowMesh.count = Math.max(data.shadowMesh.count, idx + 1);
      data.shadowMesh.instanceMatrix.needsUpdate = true;
    }

    data.fadeAttr.setX(idx, 1);
    data.fadeAttr.needsUpdate = true;
    data.idxToId.set(idx, inst.id);
    data.count = Math.max(data.count, idx + 1);
    data.mesh.count = data.count;
    data.dirty = true;
    return idx;
  }

  private showImpostor(data: ImpostorMeshData, inst: TreeInstance): number {
    // IMPOSTORS DISABLED - return -1 to prevent any rendering
    if (DISABLE_IMPOSTORS) return -1;

    const idx = data.nextIdx++;
    if (data.nextIdx >= MAX_INSTANCES) data.nextIdx = 0;

    this.dummy.position.copy(inst.position);
    this.dummy.position.y += data.height * inst.scale * 0.5;
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(data.width * inst.scale, data.height * inst.scale, 1);
    this.dummy.updateMatrix();

    data.mesh.setMatrixAt(idx, this.dummy.matrix);
    data.idxToId.set(idx, inst.id);
    data.count = Math.max(data.count, idx + 1);
    data.mesh.count = data.count;
    data.dirty = true;
    return idx;
  }

  // ---------------------------------------------------------------------------
  // UPDATE LOOP
  // ---------------------------------------------------------------------------

  update(camPos?: THREE.Vector3, dt = 0.016): void {
    this.time = performance.now();
    if (camPos) this.camPos.copy(camPos);
    else this.world.camera?.getWorldPosition(this.camPos);

    this.updateWind(dt);
    this.updateTransitions();
    this.updateDistanceFades(); // Distance-based dissolve every frame

    if (this.lodEnabled && this.time - this.lastLodUpdate >= LOD_UPDATE_MS) {
      this.lastLodUpdate = this.time;

      // Use spatial partitioning for distance-prioritized LOD updates
      // This ensures nearby trees are updated more frequently than distant ones
      if (this.spatialChunks.size > 0) {
        const treesToUpdate = this.getTreesToUpdate(LOD_UPDATES_PER_FRAME);
        for (const t of treesToUpdate) {
          this.updateLOD(t.preset, t.inst);
        }
      } else {
        // Fallback to linear iteration if no spatial data
        if (this.instArray.length !== this.instances.size) {
          this.instArray = Array.from(this.instances.values());
        }
        const count = this.instArray.length;
        if (count > 0) {
          const n = Math.min(LOD_UPDATES_PER_FRAME, count);
          for (let i = 0; i < n; i++) {
            const t = this.instArray[(this.lodIdx + i) % count];
            if (t) this.updateLOD(t.preset, t.inst);
          }
          this.lodIdx = (this.lodIdx + n) % count;
        }
      }
    }

    // Upload dirty matrices
    for (const data of this.meshes.values()) {
      for (const d of data.values()) {
        if (d.dirty) {
          d.mesh.instanceMatrix.needsUpdate = true;
          d.dirty = false;
        }
      }
    }
    // IMPOSTORS DISABLED - hide any existing impostor meshes and skip updates
    if (DISABLE_IMPOSTORS) {
      for (const d of this.impostors.values()) {
        d.mesh.visible = false;
        d.mesh.count = 0;
      }
    } else {
      for (const d of this.impostors.values()) {
        if (d.dirty) {
          d.mesh.instanceMatrix.needsUpdate = true;
          d.dirty = false;
        }
      }
    }

    // Update debug impostors (when DEBUG_IMPOSTORS flag is enabled)
    this.updateDebugImpostors();

    // Update impostor view sampling based on camera direction
    this.updateViewSampling();

    // Sync impostor lighting with scene sun light
    this.syncImpostorLighting();

    // Sync tree leaf lighting with scene lights (day/night cycle)
    this.syncTreeLighting();

    // Update global leaves
    if (this.globalLeaves) {
      const strength = this.windSys?.uniforms.windStrength.value ?? 1;
      const windDir =
        this.windSys?.uniforms.windDirection.value ??
        new THREE.Vector3(1, 0, 0);
      this.globalLeaves.update(dt, strength, windDir);
    }

    // Update global leaf clusters (LOD2)
    if (this.globalClusters) {
      this.globalClusters.update(
        this.windSys,
        dt,
        this.world.camera ?? undefined,
      );
    }
  }

  private updateWind(dt: number): void {
    const strength = this.windSys?.uniforms.windStrength.value ?? 1;
    this.tempWindDir.copy(
      this.windSys?.uniforms.windDirection.value ?? new THREE.Vector3(1, 0, 0),
    );

    for (const mat of this.windMats) {
      mat.windUniforms.time.value += dt;
      mat.windUniforms.strength.value = strength;
      mat.windUniforms.direction.value.copy(this.tempWindDir);
    }
  }

  private updateTransitions(): void {
    const toRemove: string[] = [];

    for (const id of this.transitions) {
      const tracked = this.instances.get(id);
      if (!tracked) {
        toRemove.push(id);
        continue;
      }

      const { inst, preset } = tracked;
      const tr = inst.transition;
      if (!tr) {
        toRemove.push(id);
        continue;
      }

      const progress = Math.min(1, (this.time - tr.start) / LOD_FADE_MS);
      this.setFade(preset, inst, tr.to, progress);
      this.setFade(preset, inst, tr.from, 1 - progress);

      if (progress >= 1) {
        this.removeFromLOD(preset, inst, tr.from);
        inst.transition = null;
        toRemove.push(id);
      }
    }

    for (const id of toRemove) this.transitions.delete(id);
  }

  /**
   * Sync impostor lighting with scene's sun light.
   * Throttled to once per frame (~16ms) to avoid redundant updates.
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   */
  private syncImpostorLighting(): void {
    if (DISABLE_IMPOSTORS) return; // Impostors disabled - using dissolve fade instead
    const now = performance.now();
    // Only update lighting once per frame (~16ms)
    if (now - this._lastLightUpdate < 16) return;
    this._lastLightUpdate = now;

    // Get environment system for sun light
    const env = this.world.getSystem("environment") as {
      sunLight?: THREE.DirectionalLight;
      lightDirection?: THREE.Vector3;
    } | null;

    if (!env?.sunLight) return;

    const sun = env.sunLight;
    // Light direction is negated (light goes FROM direction TO target)
    if (env.lightDirection) {
      this._lightDir.copy(env.lightDirection).negate();
    } else {
      this._lightDir.set(0.5, 0.8, 0.3);
    }
    this._lightColor.set(sun.color.r, sun.color.g, sun.color.b);

    // Update all impostor materials - skip when disabled
    if (DISABLE_IMPOSTORS) return;
    for (const data of this.impostors.values()) {
      const material = data.material as TSLImpostorMaterial;
      if (material.updateLighting) {
        material.updateLighting({
          ambientColor: this._ambientColor,
          ambientIntensity: 0.4,
          directionalLights: [
            {
              direction: this._lightDir,
              color: this._lightColor,
              intensity: sun.intensity,
            },
          ],
          specular: {
            f0: 0.02, // Trees are non-metallic
            shininess: 16,
            intensity: 0.15,
          },
        });
      }
    }
  }

  /**
   * Sync tree leaf lighting with scene lights (day/night cycle).
   * Updates the globalLeaves material to match current sun direction and day intensity.
   */
  private syncTreeLighting(): void {
    if (!this.globalLeaves) return;

    // Get environment system for sun light and sky system for day/night
    const env = this.world.getSystem("environment") as {
      sunLight?: THREE.DirectionalLight;
      lightDirection?: THREE.Vector3;
      skySystem?: {
        sunDirection?: THREE.Vector3;
        dayIntensity?: number;
      };
    } | null;

    if (!env) return;

    // Get sun direction (direction TO the sun for SSS calculation)
    const sunDir = this._lightDir;
    if (env.lightDirection) {
      // lightDirection points FROM the light, so negate it to get direction TO sun
      sunDir.copy(env.lightDirection).negate();
    } else {
      sunDir.set(0.5, 0.8, 0.3).normalize();
    }

    // Get day/night mix from environment (derived from sun intensity)
    // When sun is up (day), intensity is high; when moon is up (night), intensity is low
    let dayMix = 1.0;
    if (env.sunLight) {
      // Sun intensity ranges from ~0.6-1.8 during day, ~0.3-0.6 during night (moonlight)
      // Normalize to 0-1 range for day/night mix
      const intensity = env.sunLight.intensity;
      dayMix = Math.max(0, Math.min(1, (intensity - 0.3) / 1.5));
    }

    // Update global leaves lighting
    this.globalLeaves.updateLighting(sunDir, dayMix);
  }

  /**
   * Update view sampling for octahedral impostors.
   * Computes which faces of the octahedron atlas to sample based on camera direction.
   *
   * The octahedron mesh represents view directions - we raycast from outside
   * the octahedron (opposite camera direction) towards the center to find
   * which face corresponds to the current view angle.
   *
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   */
  private updateViewSampling(): void {
    if (DISABLE_IMPOSTORS) return; // Impostors disabled - using dissolve fade instead
    if (!this.octMesh) return;

    // Guard: skip if camera position is zero/uninitialized (would cause NaN)
    const camLenSq =
      this.camPos.x * this.camPos.x +
      this.camPos.y * this.camPos.y +
      this.camPos.z * this.camPos.z;
    if (camLenSq < 0.001) return;

    // Compute view direction: from origin TO camera (negative of camera-to-origin)
    // This matches AtlasedRockPlantImpostorManager's approach
    this._viewDir.set(0, 0, 0).sub(this.camPos).normalize();

    // Raycast: start outside octahedron in the view direction, shoot towards center
    // Origin is at -viewDir * 2 (behind octahedron relative to camera)
    // Direction is +viewDir (towards camera/center)
    this.raycaster.ray.origin.copy(this._viewDir).multiplyScalar(2);
    this.raycaster.ray.direction.copy(this._viewDir).negate();

    const hits = this.raycaster.intersectObject(this.octMesh.filledMesh, false);
    if (hits.length > 0 && hits[0].face && hits[0].barycoord) {
      const { face, barycoord } = hits[0];
      this._faceIndices.set(face.a, face.b, face.c);
      this._faceWeights.copy(barycoord);

      // Update all impostor materials with new view direction
      for (const data of this.impostors.values()) {
        const material = data.material as TSLImpostorMaterial;
        material.updateView(this._faceIndices, this._faceWeights);
      }
    }
  }

  setLODUpdatesEnabled(enabled: boolean): void {
    this.lodEnabled = enabled;
  }

  // ---------------------------------------------------------------------------
  // STATS & CLEANUP
  // ---------------------------------------------------------------------------

  getStats() {
    let draws = 0;
    const byLOD = { lod0: 0, lod1: 0, lod2: 0, impostor: 0, culled: 0 };
    const details: Record<
      string,
      {
        lod0: number;
        lod1: number;
        lod2: number;
        impostor: number;
        hasLOD0: boolean;
        hasLOD1: boolean;
        hasLOD2: boolean;
        hasImpostor: boolean;
      }
    > = {};

    for (const [p, data] of this.meshes) {
      const l0 = data.get("lod0"),
        l1 = data.get("lod1"),
        l2 = data.get("lod2");
      const imp = this.impostors.get(p);

      const c0 = l0?.count ?? 0,
        c1 = l1?.count ?? 0,
        c2 = l2?.count ?? 0,
        ci = imp?.count ?? 0;
      if (l0 && c0 > 0) draws++;
      if (l1 && c1 > 0) draws++;
      if (l2 && c2 > 0) draws++;
      if (imp && ci > 0) draws++;
      if (l0?.shadowMesh && l0.shadowMesh.count > 0) draws++;
      if (l1?.shadowMesh && l1.shadowMesh.count > 0) draws++;

      details[p] = {
        lod0: c0,
        lod1: c1,
        lod2: c2,
        impostor: ci,
        hasLOD0: !!l0,
        hasLOD1: !!l1,
        hasLOD2: !!l2,
        hasImpostor: !!imp,
      };
    }

    for (const { inst } of this.instances.values()) {
      const l = inst.currentLOD;
      if (l === 0) byLOD.lod0++;
      else if (l === 1) byLOD.lod1++;
      else if (l === 2) byLOD.lod2++;
      else if (l === 3) byLOD.impostor++;
      else byLOD.culled++;
    }

    // Get global leaf stats
    const leafStats = this.globalLeaves?.getStats() ?? {
      count: 0,
      capacity: 0,
      drawCalls: 0,
    };

    // Get cluster stats
    const clusterStats = this.globalClusters?.getStats() ?? {
      treesWithClusters: 0,
      totalClusters: 0,
      capacity: 0,
      drawCalls: 0,
      presetsRegistered: 0,
    };

    return {
      presets: this.meshes.size,
      totalInstances: this.instances.size,
      drawCalls: draws + leafStats.drawCalls + clusterStats.drawCalls,
      byLOD,
      activeTransitions: this.transitions.size,
      pendingImpostors: this.pendingImpostors.size,
      gpuCullingAvailable: this.isWebGPU,
      lodDistances: LOD_DIST,
      globalLeaves: leafStats,
      globalClusters: clusterStats,
      details,
    };
  }

  /**
   * Get all tree instance positions and radii for grass exclusion.
   * Used by ProceduralGrass to exclude grass under tree trunks.
   */
  getInstancesForGrassExclusion(): Array<{
    position: THREE.Vector3;
    radius: number;
  }> {
    const result: Array<{ position: THREE.Vector3; radius: number }> = [];
    for (const { inst } of this.instances.values()) {
      result.push({
        position: inst.position,
        radius: inst.radius,
      });
    }
    return result;
  }

  /**
   * Get detailed LOD info for a specific tree.
   * Useful for debugging LOD transitions.
   */
  getTreeLODInfo(treeId: string): {
    preset: string;
    currentLOD: number;
    lodName: string;
    distance: number;
    hasClusters: boolean;
    clusterDensity: number;
    position: THREE.Vector3;
    transition: { from: number; to: number; progress: number } | null;
  } | null {
    const tracked = this.instances.get(treeId);
    if (!tracked) return null;

    const { inst, preset } = tracked;
    const dx = inst.position.x - this.camPos.x;
    const dz = inst.position.z - this.camPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const lodNames = ["LOD0", "LOD1", "LOD2", "Impostor", "Culled"];

    let transition: { from: number; to: number; progress: number } | null =
      null;
    if (inst.transition) {
      const progress = Math.min(
        1,
        (this.time - inst.transition.start) / LOD_FADE_MS,
      );
      transition = {
        from: inst.transition.from,
        to: inst.transition.to,
        progress,
      };
    }

    return {
      preset,
      currentLOD: inst.currentLOD,
      lodName: lodNames[inst.currentLOD] ?? "Unknown",
      distance: dist,
      hasClusters: inst.clusterLOD >= 0,
      clusterDensity: inst.clusterDensity,
      position: inst.position.clone(),
      transition,
    };
  }

  /**
   * Get LOD info for all nearby trees.
   * Useful for debugging LOD distribution.
   */
  getNearbyTreesLODInfo(maxDistance = 300): Array<{
    id: string;
    preset: string;
    lod: number;
    lodName: string;
    distance: number;
  }> {
    const result: Array<{
      id: string;
      preset: string;
      lod: number;
      lodName: string;
      distance: number;
    }> = [];

    const lodNames = ["LOD0", "LOD1", "LOD2", "Impostor", "Culled"];

    for (const [id, { inst, preset }] of this.instances) {
      const dx = inst.position.x - this.camPos.x;
      const dz = inst.position.z - this.camPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist <= maxDistance) {
        result.push({
          id,
          preset,
          lod: inst.currentLOD,
          lodName: lodNames[inst.currentLOD] ?? "Unknown",
          distance: Math.round(dist * 10) / 10,
        });
      }
    }

    // Sort by distance
    result.sort((a, b) => a.distance - b.distance);
    return result;
  }

  /**
   * Debug utility: Print LOD summary to console.
   */
  debugPrintLODSummary(): void {
    const stats = this.getStats();
    console.log("=== Tree LOD Summary ===");
    console.log(`Total trees: ${stats.totalInstances}`);
    console.log(`LOD0 (0-${LOD_DIST.lod1}m): ${stats.byLOD.lod0}`);
    console.log(
      `LOD1 (${LOD_DIST.lod1}-${LOD_DIST.lod2}m): ${stats.byLOD.lod1}`,
    );
    console.log(
      `LOD2 (${LOD_DIST.lod2}-${LOD_DIST.impostor}m): ${stats.byLOD.lod2}`,
    );
    console.log(
      `Impostor (${LOD_DIST.impostor}-${LOD_DIST.cull}m): ${stats.byLOD.impostor}`,
    );
    console.log(`Culled (>${LOD_DIST.cull}m): ${stats.byLOD.culled}`);
    console.log(`Draw calls: ${stats.drawCalls}`);
    console.log(
      `Global leaves: ${stats.globalLeaves.count} trees, ${stats.globalLeaves.drawCalls} draw calls`,
    );
    console.log(
      `Global clusters: ${stats.globalClusters.treesWithClusters} trees, ${stats.globalClusters.totalClusters} clusters`,
    );
    console.log(`Active transitions: ${stats.activeTransitions}`);
    console.log(`Pending impostors: ${stats.pendingImpostors}`);
    console.log("========================");
  }

  dispose(): void {
    // Dispose global leaves
    this.globalLeaves?.dispose();
    this.globalLeaves = null;
    this.presetLeafData.clear();

    // Dispose global clusters
    this.globalClusters?.dispose();
    this.globalClusters = null;

    for (const data of this.meshes.values()) {
      for (const d of data.values()) {
        d.mesh.parent?.remove(d.mesh);
        d.geometry.dispose();
        d.material.dispose();
        d.mesh.dispose();
        d.shadowMesh?.parent?.remove(d.shadowMesh);
        d.shadowMesh?.dispose();
        d.shadowGeo?.dispose();
      }
    }
    this.meshes.clear();

    for (const d of this.impostors.values()) {
      d.mesh.parent?.remove(d.mesh);
      d.geometry.dispose();
      d.material.dispose();
      d.mesh.dispose();
    }
    this.impostors.clear();

    this.instances.clear();
    this.transitions.clear();
    this.windMats = [];
    ProcgenTreeInstancer.inst = null;
  }
}

export default ProcgenTreeInstancer;
