/**
 * BuildingRenderingSystem - Optimized 3D Building Rendering with LOD, Batching, and Impostors
 *
 * Renders 3D building meshes for towns using @hyperforge/procgen's BuildingGenerator.
 * Works in conjunction with TownSystem which provides building placement data.
 *
 * **Grid Alignment:**
 * Buildings use a cell-based grid system that aligns with the game's tile-based movement:
 * - Building cells: CELL_SIZE = 4 meters (one "room" unit)
 * - Movement tiles: TILE_SIZE = 1 meter (pathfinding grid)
 * - Ratio: 1 building cell = 4×4 = 16 movement tiles
 * - Building positions are snapped to BUILDING_GRID_SNAP (2m) for alignment
 *
 * This ensures:
 * - Building collision aligns perfectly with movement collision
 * - Pathfinding inside buildings works correctly
 * - Door tiles and wall tiles are at proper boundaries
 *
 * **Performance Optimizations:**
 * - **Static Batching**: All buildings in a town merged into single mesh (1 draw call per town)
 * - **Material Sharing**: Single uber-material for all buildings (vertex-colored)
 * - **Geometry Merging**: Internal face removal and vertex optimization
 * - **Distance-based LOD**: Full detail → reduced → impostor → culled
 * - **Octahedral Impostors**: View-dependent billboards for distant buildings
 * - **Impostor Atlas**: Per-town batched impostor textures (reduced texture binds)
 * - **Lazy Collision**: PhysX bodies created only when player approaches
 *
 * **LOD Strategy:**
 * - Near (< lod1Distance): Full detail batched mesh, shadows enabled
 * - Medium (lod1Distance - imposterDistance): Batched mesh, shadows disabled
 * - Far (imposterDistance - fadeDistance): Town impostor atlas
 * - Very Far (> fadeDistance): Culled
 *
 * **Collision:**
 * - Wall collision: Thin box shapes along external building edges
 * - Floor collision: Flat box shapes at each floor level
 * - Roof collision: Walkable surface on top of building
 * - Uses "building" physics layer for filtering
 * - Collision created lazily when player enters town radius
 *
 * **Integration:**
 * - Depends on TownSystem for building placement data
 * - Depends on TerrainSystem for height queries
 * - Uses BuildingGenerator from @hyperforge/procgen for mesh generation
 * - Uses unified LOD configuration from LODConfig
 * - Uses ImpostorManager for octahedral impostor baking
 *
 * **Runs on:** Client only (buildings are purely visual on client)
 */

import THREE, {
  uniform,
  sub,
  add,
  mul,
  div,
  Fn,
  MeshStandardNodeMaterial,
  float,
  smoothstep,
  positionWorld,
  step,
  max,
  min,
  clamp,
  sqrt,
  mod,
  floor,
  fract,
  abs,
  viewportCoordinate,
  uv,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  dot,
  mix,
  attribute,
  select,
  dFdx,
  dFdy,
} from "../../../extras/three/three";
import type { Node, UniformNode } from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MAX_VERTEX_LIGHTS } from "./TerrainShader";
import type { VertexLight } from "./TerrainShader";
import {
  getLamppostLightTextureState,
  isLamppostLightTextureReady,
} from "./LamppostLightMask";
import { applySkyFog } from "./FogConfig";
import { SystemBase } from "../infrastructure/SystemBase";

// ============================================================================
// GEOMETRY UTILITIES
// ============================================================================

/**
 * Convert all geometries in array to non-indexed for consistent merging.
 * Three.js mergeGeometries requires all geometries to either have indices or not.
 */
function toNonIndexed(
  geometries: THREE.BufferGeometry[],
): THREE.BufferGeometry[] {
  return geometries.map((geo) => {
    if (geo.index) {
      const nonIndexed = geo.toNonIndexed();
      geo.dispose();
      return nonIndexed;
    }
    return geo;
  });
}

/**
 * Compute flat normals for non-indexed geometry.
 * Each triangle gets a face normal computed from the cross product of its edges.
 * This is necessary for architectural geometry that needs hard edges.
 *
 * IMPORTANT: This function is critical for geometry that's missing normals.
 * Using zero normals (0,0,0) causes surfaces to appear completely black
 * because dot(N, L) = 0 for any light direction L.
 */
function computeFlatNormalsForGeometry(geo: THREE.BufferGeometry): void {
  const posAttr = geo.getAttribute("position");
  if (!posAttr) return;

  const vertexCount = posAttr.count;
  if (vertexCount === 0 || vertexCount % 3 !== 0) {
    // Empty or invalid geometry - create default up-facing normals
    const normalArray = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      normalArray[i * 3] = 0;
      normalArray[i * 3 + 1] = 1; // Up
      normalArray[i * 3 + 2] = 0;
    }
    geo.setAttribute("normal", new THREE.BufferAttribute(normalArray, 3));
    return;
  }

  // Compute bounding box center to verify normal direction
  geo.computeBoundingBox();
  const boundingBox = geo.boundingBox;
  const center = boundingBox
    ? new THREE.Vector3()
        .addVectors(boundingBox.min, boundingBox.max)
        .multiplyScalar(0.5)
    : new THREE.Vector3(0, 0, 0);

  const normalArray = new Float32Array(vertexCount * 3);
  const positions = posAttr.array as Float32Array;

  // Temporary vectors for calculation
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  // Process each triangle
  const triangleCount = vertexCount / 3;
  for (let t = 0; t < triangleCount; t++) {
    const i0 = t * 3;
    const i1 = t * 3 + 1;
    const i2 = t * 3 + 2;

    // Get vertex positions
    p0.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    p1.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    p2.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

    // Compute edge vectors
    edge1.subVectors(p1, p0);
    edge2.subVectors(p2, p0);

    // Compute face normal from cross product (CCW winding = outward normal)
    faceNormal.crossVectors(edge1, edge2);

    // Handle degenerate triangles
    const lengthSq = faceNormal.lengthSq();
    if (lengthSq > 1e-12) {
      faceNormal.normalize();

      // CRITICAL: Verify normal points outward by checking if it points away from center
      // For a triangle on the surface of a solid, the normal should point away from the center
      const triangleCenter = new THREE.Vector3()
        .addVectors(p0, p1)
        .add(p2)
        .divideScalar(3);
      const toCenter = new THREE.Vector3().subVectors(center, triangleCenter);

      // If normal points toward center (positive dot product), flip it
      // This handles cases where winding order might be reversed
      if (faceNormal.dot(toCenter) > 0) {
        faceNormal.negate();
      }
    } else {
      // Degenerate triangle - use default up normal
      faceNormal.set(0, 1, 0);
    }

    // Store the same normal for all 3 vertices of this triangle
    for (let vi = 0; vi < 3; vi++) {
      const idx = (t * 3 + vi) * 3;
      normalArray[idx] = faceNormal.x;
      normalArray[idx + 1] = faceNormal.y;
      normalArray[idx + 2] = faceNormal.z;
    }
  }

  geo.setAttribute("normal", new THREE.BufferAttribute(normalArray, 3));
}

/**
 * Normalize attributes across all geometries so they can be merged.
 * Three.js mergeGeometries requires all geometries to have the same attributes.
 *
 * IMPORTANT: For normals, we compute them properly rather than using zeros.
 * Zero normals cause surfaces to appear black because dot(N, L) = 0.
 */
function normalizeGeometryAttributes(geometries: THREE.BufferGeometry[]): void {
  if (geometries.length <= 1) return;

  // Collect all unique attribute names and their item sizes
  const attributeInfo = new Map<string, number>();
  for (const geo of geometries) {
    const attrs = geo.attributes;
    for (const name in attrs) {
      const attr = attrs[name] as THREE.BufferAttribute;
      if (!attributeInfo.has(name)) {
        attributeInfo.set(name, attr.itemSize);
      }
    }
  }

  // Add missing attributes to each geometry
  for (const geo of geometries) {
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
    if (!posAttr) continue;
    const vertexCount = posAttr.count;

    for (const [name, itemSize] of attributeInfo) {
      if (!geo.hasAttribute(name)) {
        if (name === "normal") {
          // CRITICAL: Compute normals properly instead of using zeros!
          // Zero normals (0,0,0) cause black surfaces because dot(N, L) = 0
          computeFlatNormalsForGeometry(geo);
        } else if (name === "color") {
          // For vertex colors, default to WHITE (1,1,1) not black
          // This ensures surfaces receive full PBR lighting
          const colorArray = new Float32Array(vertexCount * itemSize);
          for (let i = 0; i < colorArray.length; i++) {
            colorArray[i] = 1.0; // White
          }
          geo.setAttribute(
            name,
            new THREE.BufferAttribute(colorArray, itemSize),
          );
        } else {
          // For other attributes (uv, uv2, etc.), zeros are acceptable
          const array = new Float32Array(vertexCount * itemSize);
          const attr = new THREE.BufferAttribute(array, itemSize);
          geo.setAttribute(name, attr);
        }
      }
    }
  }
}

// ============================================================================
// ASYNC UTILITIES - Non-blocking main thread helpers
// ============================================================================

/**
 * Yield to browser event loop using requestIdleCallback for better scheduling.
 * Falls back to setTimeout if requestIdleCallback not available.
 * @param timeout - Maximum time to wait for idle callback (ms)
 */
function yieldToMainThread(timeout = 50): Promise<IdleDeadline | void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback((deadline) => resolve(deadline), { timeout });
    } else {
      setTimeout(() => resolve(), 0);
    }
  });
}

/**
 * Check if we should yield based on elapsed time
 * @param startTime - Performance.now() timestamp when work started
 * @param budgetMs - Maximum milliseconds before yielding (default 8ms for 60fps)
 */
function shouldYieldNow(startTime: number, budgetMs = 8): boolean {
  return performance.now() - startTime > budgetMs;
}

/**
 * Check if idle deadline has time remaining
 */
function hasTimeRemaining(deadline: IdleDeadline | void): boolean {
  if (!deadline) return true; // setTimeout fallback
  return deadline.timeRemaining() > 0;
}
import type { World } from "../../../types";
import type {
  ProceduralTown,
  TownBuilding,
} from "../../../types/world/world-types";
import {
  BuildingGenerator,
  type BuildingLayout,
  CELL_SIZE,
  WALL_THICKNESS,
  FLOOR_THICKNESS,
  FLOOR_HEIGHT,
  FOUNDATION_HEIGHT,
  ENTRANCE_STEP_HEIGHT,
  snapToBuildingGrid,
  computeTangentsForNonIndexed,
} from "@hyperforge/procgen/building";
import { getLODDistances, type LODDistancesWithSq } from "./LODConfig";
import {
  ImpostorManager,
  BakePriority,
  ImpostorBakeMode,
  DynamicBuildingImpostorAtlas,
  type AtlasBuildingData,
} from "../rendering";
import {
  createTSLImpostorMaterial,
  isTSLImpostorMaterial,
  type ImpostorBakeResult,
  type TSLImpostorMaterial,
} from "@hyperforge/impostor";
import { getPhysX } from "../../../physics/PhysXManager";
import { Layers } from "../../../physics/Layers";
import type { PhysicsHandle } from "../../../types/systems/physics";

// ============================================================================
// BUILDING OCCLUSION CONFIG
// ============================================================================

/**
 * Building occlusion shader configuration.
 * Uses dithered/stippled effect like classic fantasy MMORPG for seeing character through walls.
 * Values are intentionally smaller than vegetation for subtle visibility.
 */
export const BUILDING_OCCLUSION_CONFIG = {
  /** Radius at camera end of the cone (meters) */
  CAMERA_RADIUS: 0.15,

  /** Radius at player end of the cone (meters) - smaller bubble around player */
  PLAYER_RADIUS: 0.8,

  /** Extra radius added based on camera distance */
  DISTANCE_SCALE: 0.02,

  /** Minimum distance from camera before occlusion kicks in */
  NEAR_MARGIN: 0.2,

  /** Distance from player where occlusion stops */
  FAR_MARGIN: 0.2,

  /** Sharpness of the cutoff edge (higher = sharper stipple pattern) */
  EDGE_SHARPNESS: 0.7,

  /** Occlusion strength (0 = disabled, only near-camera dissolve active) */
  STRENGTH: 0.0,

  // ========== NEAR-CAMERA DISSOLVE (classic fantasy MMORPG-style depth fade) ==========
  // Prevents hard geometry clipping when camera clips through objects

  /** Distance from camera where near-fade begins (meters) - fully opaque beyond this */
  NEAR_FADE_START: 1.5,

  /** Distance from camera where geometry is fully dissolved (meters) - at near clip */
  NEAR_FADE_END: 0.05,

  // ========== DISTANCE DISSOLVE (Retro Bayer dither fade-in/out) ==========
  // Buildings dissolve in/out based on distance using 4x4 Bayer dithering
  // Creates a retro/old-school fade effect like classic games instead of hard pop-in
  //
  // NOTE: These values should align with LOD_DISTANCES["building"].fadeDistance (200m)
  // The dissolve should complete BEFORE the LOD system culls the object

  /** Distance from camera where buildings start to fade OUT (meters) - fully opaque inside this */
  DISTANCE_FADE_START: 150.0,

  /** Distance from camera where buildings are fully dissolved (meters) - should be <= LOD fadeDistance */
  DISTANCE_FADE_END: 195.0,
} as const;

// ============================================================================
// PROCEDURAL PATTERN FUNCTIONS (TSL)
// ============================================================================

/**
 * Hash function for pseudo-random values
 */
const tslHash = Fn(([p]: [Node<"vec2">]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));
});

/**
 * 2D noise function
 */
const tslNoise2D = Fn(([p]: [Node<"vec2">]) => {
  const i = floor(p);
  const f = fract(p);
  const smoothF = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));

  const a = tslHash(i);
  const b = tslHash(i.add(vec2(1.0, 0.0)));
  const c = tslHash(i.add(vec2(0.0, 1.0)));
  const d = tslHash(i.add(vec2(1.0, 1.0)));

  return mix(mix(a, b, smoothF.x), mix(c, d, smoothF.x), smoothF.y);
});

/**
 * Calculate procedural LOD factor based on screen-space UV derivatives.
 * Returns 0.0 when pattern should be fully visible, 1.0 when should fade to solid.
 *
 * This is the key to procedural "mip-mapping" - when UVs change too fast across
 * pixels, the pattern frequency exceeds Nyquist and causes aliasing. We detect
 * this and fade to the average color instead.
 */
const calcProceduralLOD = Fn(([uvIn]: [Node<"vec2">]) => {
  // Calculate how fast UVs change per pixel (filter width)
  const dUVdx = dFdx(uvIn);
  const dUVdy = dFdy(uvIn);

  // Maximum UV change per pixel (approximates mip level)
  const maxDeriv = max(
    max(abs(dUVdx.x), abs(dUVdx.y)),
    max(abs(dUVdy.x), abs(dUVdy.y)),
  );

  // When derivatives are large, patterns alias. Fade starts around 0.25 (4 pixels per pattern repeat)
  // and fully fades at 0.5 (2 pixels per repeat - Nyquist limit)
  return smoothstep(float(0.15), float(0.4), maxDeriv);
});

/**
 * Anti-aliased step function using screen-space derivatives
 * This prevents the "screen door" / bayer dithering effect at distance
 * by using smooth transitions based on how fast the value changes on screen
 */
const aaStep = Fn(([edge, x]: [Node<"float">, Node<"float">]) => {
  // Calculate filter width from screen-space derivatives
  // fwidth(x) = abs(dFdx(x)) + abs(dFdy(x))
  const derivativeInput = vec2(x, float(0));
  const fw = abs(dFdx(derivativeInput).x).add(abs(dFdy(derivativeInput).x));
  // Scale filter width more aggressively to prevent aliasing
  const filterWidth = max(fw.mul(1.5), float(0.001));
  // Use smoothstep for anti-aliased transition
  return smoothstep(edge.sub(filterWidth), edge.add(filterWidth), x);
});

/**
 * Anti-aliased step for comparing if x is less than edge
 * Returns 1 when x < edge, 0 when x > edge, with smooth transition
 */
const aaStepLt = Fn(([edge, x]: [Node<"float">, Node<"float">]) => {
  const derivativeInput = vec2(x, float(0));
  const fw = abs(dFdx(derivativeInput).x).add(abs(dFdy(derivativeInput).x));
  const filterWidth = max(fw.mul(1.5), float(0.001));
  // Inverted: 1 when x < edge
  return float(1.0).sub(
    smoothstep(edge.sub(filterWidth), edge.add(filterWidth), x),
  );
});

/**
 * Brick pattern - returns (isBrick, brickIdX, brickIdY, lodFade)
 * Uses anti-aliased step functions to prevent screen-door effect at distance.
 * lodFade indicates how much to blend toward average color (0=full detail, 1=solid)
 */
const brickPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  // Larger bricks for more visible pattern (was 0.25 x 0.065)
  const brickWidth = float(0.4);
  const brickHeight = float(0.1);
  const mortarWidth = float(0.015);

  // Calculate LOD fade factor - at distance, fade to average brick color
  const lodFade = calcProceduralLOD(uvIn.div(vec2(brickWidth, brickHeight)));

  const scaled = uvIn.div(vec2(brickWidth, brickHeight));
  const row = floor(scaled.y);
  const rowOffset = mod(row, float(2.0)).mul(0.5);
  const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

  const brickId = floor(offsetUV);
  const localUV = fract(offsetUV);

  const mortarU = mortarWidth.div(brickWidth);
  const mortarV = mortarWidth.div(brickHeight);

  // Anti-aliased mortar detection using screen-space derivatives
  // Left mortar edge (x < mortarU)
  const inMortarLeft = aaStepLt(mortarU, localUV.x);
  // Right mortar edge (x > 1 - mortarU)
  const inMortarRight = aaStep(float(1.0).sub(mortarU), localUV.x);
  // Bottom mortar edge (y < mortarV)
  const inMortarBottom = aaStepLt(mortarV, localUV.y);
  // Top mortar edge (y > 1 - mortarV)
  const inMortarTop = aaStep(float(1.0).sub(mortarV), localUV.y);

  const inMortarX = clamp(inMortarLeft.add(inMortarRight), 0.0, 1.0);
  const inMortarY = clamp(inMortarBottom.add(inMortarTop), 0.0, 1.0);
  const inMortar = clamp(inMortarX.add(inMortarY), 0.0, 1.0);

  // Blend toward average brick coverage at distance (bricks are ~90% of surface)
  const isBrickBase = float(1.0).sub(inMortar);
  const avgBrickCoverage = float(0.9); // Average visible brick vs mortar
  const isBrick = mix(isBrickBase, avgBrickCoverage, lodFade);

  return vec4(isBrick, brickId.x, brickId.y, lodFade);
});

/**
 * Stone ashlar pattern - returns (isStone, stoneIdX, stoneIdY, bevelAndLod)
 * Uses anti-aliased step functions to prevent screen-door effect at distance
 * bevelAndLod encodes both bevel (lower bits) and lodFade (combined with isStone)
 */
const ashlarPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  // Larger stone blocks for more visible pattern (was 0.6 x 0.3)
  const blockWidth = float(0.9);
  const blockHeight = float(0.45);
  const mortarWidth = float(0.02);

  // Calculate LOD fade factor
  const lodFade = calcProceduralLOD(uvIn.div(vec2(blockWidth, blockHeight)));

  const scaled = uvIn.div(vec2(blockWidth, blockHeight));
  const row = floor(scaled.y);
  const rowOffset = mod(row, float(2.0)).mul(0.5);
  const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

  const blockId = floor(offsetUV);
  const localUV = fract(offsetUV);

  const mortarU = mortarWidth.div(blockWidth);
  const mortarV = mortarWidth.div(blockHeight);

  // Bevel at edges - also fades at distance
  const edgeDistX = min(localUV.x, float(1.0).sub(localUV.x));
  const edgeDistY = min(localUV.y, float(1.0).sub(localUV.y));
  const bevelBase = smoothstep(0.0, 0.05, min(edgeDistX, edgeDistY));
  const bevel = mix(bevelBase, float(0.95), lodFade); // Fade bevel to flat at distance

  // Anti-aliased mortar detection
  const inMortarLeft = aaStepLt(mortarU, localUV.x);
  const inMortarRight = aaStep(float(1.0).sub(mortarU), localUV.x);
  const inMortarBottom = aaStepLt(mortarV, localUV.y);
  const inMortarTop = aaStep(float(1.0).sub(mortarV), localUV.y);

  const inMortarX = clamp(inMortarLeft.add(inMortarRight), 0.0, 1.0);
  const inMortarY = clamp(inMortarBottom.add(inMortarTop), 0.0, 1.0);
  const inMortar = clamp(inMortarX.add(inMortarY), 0.0, 1.0);

  // Blend toward average stone coverage at distance
  const isStoneBase = float(1.0).sub(inMortar);
  const avgStoneCoverage = float(0.92);
  const isStone = mix(isStoneBase, avgStoneCoverage, lodFade);

  return vec4(isStone, blockId.x, blockId.y, bevel);
});

/**
 * Stucco/plaster pattern - returns (noise, lodFade, 0, 0)
 * Creates a smooth plaster surface with subtle texture variation
 * Reduces detail noise at distance to prevent aliasing
 */
const stuccoPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  // Calculate LOD fade factor based on fine detail frequency
  const lodFade = calcProceduralLOD(uvIn.mul(8.0));

  // Large-scale subtle variation (wall patches, weathering) - always visible
  const patchNoise = tslNoise2D(uvIn.mul(0.5)).mul(0.5).add(0.5);

  // Medium-scale surface texture - fades at distance
  const surfaceNoise = tslNoise2D(uvIn.mul(8.0)).mul(0.5).add(0.5);
  const fadedSurfaceNoise = mix(surfaceNoise, float(0.5), lodFade);

  // Fine detail noise - fades out quickly at distance
  const detailNoise = tslNoise2D(uvIn.mul(30.0)).mul(0.5).add(0.5);
  const fadedDetailNoise = mix(
    detailNoise,
    float(0.5),
    min(lodFade.mul(2.0), float(1.0)),
  );

  // Combine for natural plaster look (detail fades at distance)
  const combined = patchNoise
    .mul(0.3)
    .add(fadedSurfaceNoise.mul(0.5))
    .add(fadedDetailNoise.mul(0.2));

  return vec4(combined, lodFade, 0.0, 0.0);
});

/**
 * Timber frame pattern - returns (isTimber, timberIdX, timberIdY, lodFade)
 * Creates Tudor-style half-timbered walls with horizontal and vertical beams (no diagonal X braces)
 * Uses anti-aliased step functions to prevent screen-door effect at distance
 */
const timberFramePattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const frameThickness = float(0.08); // Timber beam width
  const cellWidth = float(1.0); // Distance between vertical beams
  const cellHeight = float(1.5); // Distance between horizontal beams

  // Calculate LOD fade factor
  const lodFade = calcProceduralLOD(uvIn.div(vec2(cellWidth, cellHeight)));

  // Scale to cell grid
  const cellUV = uvIn.div(vec2(cellWidth, cellHeight));
  const cellId = floor(cellUV);
  const localUV = fract(cellUV);

  const frameU = frameThickness.div(cellWidth);
  const frameV = frameThickness.div(cellHeight);

  // Anti-aliased vertical beams
  const inVerticalLeft = aaStepLt(frameU, localUV.x);
  const inVerticalRight = aaStep(float(1.0).sub(frameU), localUV.x);
  const inVertical = clamp(inVerticalLeft.add(inVerticalRight), 0.0, 1.0);

  // Anti-aliased horizontal beams
  const inHorizontalBottom = aaStepLt(frameV, localUV.y);
  const inHorizontalTop = aaStep(float(1.0).sub(frameV), localUV.y);
  const inHorizontal = clamp(inHorizontalBottom.add(inHorizontalTop), 0.0, 1.0);

  // No diagonal braces - just horizontal and vertical beams for cleaner look
  // Combine timber elements (horizontal + vertical beams only)
  const isTimberBase = clamp(inVertical.add(inHorizontal), 0.0, 1.0);

  // At distance, blend toward average timber coverage (~20% timber, ~80% stucco)
  const avgTimberCoverage = float(0.2);
  const isTimber = mix(isTimberBase, avgTimberCoverage, lodFade);

  return vec4(isTimber, cellId.x, cellId.y, lodFade);
});

/**
 * Vertical wood panel pattern - returns (isPlank, plankId, grainOffset, lodFade)
 * Creates vertical wood panel walls (board-and-batten style) for rustic buildings
 * Uses anti-aliased step functions to prevent screen-door effect at distance
 */
const woodPanelPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const plankWidth = float(0.18); // Width of each vertical board
  const gapWidth = float(0.006); // Gap between boards

  // Calculate LOD fade factor
  const lodFade = calcProceduralLOD(vec2(uvIn.x.div(plankWidth), uvIn.y));

  const scaled = uvIn.x.div(plankWidth);
  const plankId = floor(scaled);
  const localU = fract(scaled);

  // Random vertical grain offset per plank
  const plankOffset = tslHash(vec2(plankId, 0.0)).mul(0.5);
  const offsetV = fract(uvIn.y.add(plankOffset));

  // Anti-aliased gap between planks
  const gapU = gapWidth.div(plankWidth);
  const inGap = aaStepLt(gapU, localU);

  // Blend toward average coverage at distance
  const isPlankBase = float(1.0).sub(inGap);
  const avgPlankCoverage = float(0.97);
  const isPlank = mix(isPlankBase, avgPlankCoverage, lodFade);

  return vec4(isPlank, plankId, offsetV, lodFade);
});

/**
 * Horizontal wood siding pattern - returns (isPlank, plankId, grainOffset, lodFade)
 * Creates horizontal clapboard/lap siding for buildings
 * Uses anti-aliased step functions to prevent screen-door effect at distance
 */
const woodSidingPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const plankHeight = float(0.12); // Height of each horizontal board
  const gapWidth = float(0.004); // Gap between boards

  // Calculate LOD fade factor
  const lodFade = calcProceduralLOD(vec2(uvIn.x, uvIn.y.div(plankHeight)));

  const scaled = uvIn.y.div(plankHeight);
  const plankId = floor(scaled);
  const localV = fract(scaled);

  // Random horizontal offset per plank (board ends)
  const plankOffset = tslHash(vec2(plankId, 0.0)).mul(0.5);
  const offsetU = fract(uvIn.x.add(plankOffset));

  // Anti-aliased gap between planks
  const gapV = gapWidth.div(plankHeight);
  const inGap = aaStepLt(gapV, localV);

  // Blend toward average coverage at distance
  const isPlankBase = float(1.0).sub(inGap);
  const avgPlankCoverage = float(0.97);
  const isPlank = mix(isPlankBase, avgPlankCoverage, lodFade);

  return vec4(isPlank, plankId, offsetU, lodFade);
});

/**
 * Wood plank pattern - returns (isPlank, plankId, grainOffset, lodFade)
 * Uses anti-aliased step functions to prevent screen-door effect at distance
 */
const woodPlankPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const plankWidth = float(0.15);
  const plankHeight = float(2.0);
  const gapWidth = float(0.005);

  // Calculate LOD fade factor
  const lodFade = calcProceduralLOD(
    vec2(uvIn.x.div(plankHeight), uvIn.y.div(plankWidth)),
  );

  const scaled = vec2(uvIn.x.div(plankHeight), uvIn.y.div(plankWidth));
  const plankId = floor(scaled.y);
  const localUV = vec2(fract(scaled.x), fract(scaled.y));

  // Random offset per plank
  const plankOffset = tslHash(vec2(plankId, 0.0)).mul(0.3);
  const offsetU = fract(localUV.x.add(plankOffset));

  // Anti-aliased gap between planks
  const gapV = gapWidth.div(plankWidth);
  const inGapBottom = aaStepLt(gapV, localUV.y);
  const inGapTop = aaStep(float(1.0).sub(gapV), localUV.y);
  const inGap = clamp(inGapBottom.add(inGapTop), 0.0, 1.0);

  // Blend toward average at distance
  const isPlankBase = float(1.0).sub(inGap);
  const avgPlankCoverage = float(0.97);
  const isPlank = mix(isPlankBase, avgPlankCoverage, lodFade);

  return vec4(isPlank, plankId, offsetU, lodFade);
});

/**
 * Shingle pattern for roofs - returns (isShingle, shingleIdX, shingleIdY, thicknessAndLod)
 * Uses anti-aliased step functions to prevent screen-door effect at distance
 */
const shinglePattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const shingleWidth = float(0.2);
  const shingleHeight = float(0.15);
  const overlap = float(0.3);

  // Calculate LOD fade factor
  const lodFade = calcProceduralLOD(
    vec2(
      uvIn.x.div(shingleWidth),
      uvIn.y.div(shingleHeight.mul(float(1.0).sub(overlap))),
    ),
  );

  const scaled = vec2(
    uvIn.x.div(shingleWidth),
    uvIn.y.div(shingleHeight.mul(float(1.0).sub(overlap))),
  );
  const row = floor(scaled.y);
  const rowOffset = mod(row, float(2.0)).mul(0.5);
  const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

  const shingleId = floor(offsetUV);
  const localUV = fract(offsetUV);

  // Rounded bottom with anti-aliased edge
  const bottomCurve = sin(localUV.x.mul(3.14159)).mul(0.1);
  const bottomEdge = bottomCurve.add(0.05);
  const isShingleBase = aaStep(bottomEdge, localUV.y);

  // Blend toward solid at distance
  const avgShingleCoverage = float(0.92);
  const isShingle = mix(isShingleBase, avgShingleCoverage, lodFade);

  // Thickness variation also fades at distance
  const thicknessVar = tslHash(shingleId).mul(0.1);
  const thickness = float(0.95).add(mix(thicknessVar, float(0.05), lodFade));

  return vec4(isShingle, shingleId.x, shingleId.y, thickness);
});

// ============================================================================
// PROCEDURAL NORMAL PERTURBATION FUNCTIONS (TSL)
// ============================================================================

/**
 * Compute normal perturbation for brick pattern.
 * Creates inset bricks with beveled edges and mortar grooves.
 * @returns Tangent-space normal perturbation (x, y, z)
 */
const _brickNormalPerturbation = Fn(
  ([uvIn, textureScale]: [Node<"vec2">, Node<"float">]) => {
    const scaledUV = uvIn.div(textureScale);
    // Match the larger brick pattern size
    const brickWidth = float(0.4);
    const brickHeight = float(0.1);
    const mortarWidth = float(0.015);
    const bevelWidth = float(0.02); // Width of the beveled edge (scaled up)
    const bevelDepth = float(0.4); // Strength of the bevel normal

    const scaled = scaledUV.div(vec2(brickWidth, brickHeight));
    const row = floor(scaled.y);
    const rowOffset = mod(row, float(2.0)).mul(0.5);
    const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

    const brickId = floor(offsetUV);
    const localUV = fract(offsetUV);

    const mortarU = mortarWidth.div(brickWidth);
    const mortarV = mortarWidth.div(brickHeight);
    const bevelU = bevelWidth.div(brickWidth);
    const bevelV = bevelWidth.div(brickHeight);

    // Distance from edges (0 at edge, 1 in center)
    const distFromLeft = localUV.x;
    const distFromRight = float(1.0).sub(localUV.x);
    const distFromBottom = localUV.y;
    const distFromTop = float(1.0).sub(localUV.y);

    // Bevel gradients - smoothstep for soft transition
    const bevelLeft = smoothstep(mortarU, mortarU.add(bevelU), distFromLeft);
    const bevelRight = smoothstep(mortarU, mortarU.add(bevelU), distFromRight);
    const bevelBottom = smoothstep(
      mortarV,
      mortarV.add(bevelV),
      distFromBottom,
    );
    const bevelTop = smoothstep(mortarV, mortarV.add(bevelV), distFromTop);

    // Normal X: negative on left edge, positive on right edge
    const normalX = bevelLeft
      .sub(float(1.0))
      .mul(bevelDepth)
      .add(float(1.0).sub(bevelRight).mul(bevelDepth));

    // Normal Y: negative on bottom edge, positive on top edge
    const normalY = bevelBottom
      .sub(float(1.0))
      .mul(bevelDepth)
      .add(float(1.0).sub(bevelTop).mul(bevelDepth));

    // Add subtle surface variation per brick
    const brickNoise = tslHash(brickId).mul(2.0).sub(1.0).mul(0.05);
    const surfaceNoiseX = tslNoise2D(scaledUV.mul(50.0))
      .mul(2.0)
      .sub(1.0)
      .mul(0.03);
    const surfaceNoiseY = tslNoise2D(scaledUV.mul(50.0).add(vec2(100.0, 0.0)))
      .mul(2.0)
      .sub(1.0)
      .mul(0.03);

    // Combine perturbations
    const perturbX = normalX.add(surfaceNoiseX).add(brickNoise);
    const perturbY = normalY.add(surfaceNoiseY);

    // Z component keeps normal mostly facing outward
    const perturbZ = sqrt(
      max(
        float(0.0),
        float(1.0).sub(perturbX.mul(perturbX)).sub(perturbY.mul(perturbY)),
      ),
    );

    return vec3(perturbX, perturbY, perturbZ);
  },
);

/**
 * Compute normal perturbation for shingle pattern.
 * Creates overlapping shingle edges with depth variation.
 * @returns Tangent-space normal perturbation (x, y, z)
 */
const _shingleNormalPerturbation = Fn(
  ([uvIn, textureScale]: [Node<"vec2">, Node<"float">]) => {
    const scaledUV = uvIn.div(textureScale);
    const shingleWidth = float(0.2);
    const shingleHeight = float(0.15);
    const overlap = float(0.3);
    const edgeDepth = float(0.5); // Strength of edge normal

    const scaled = vec2(
      scaledUV.x.div(shingleWidth),
      scaledUV.y.div(shingleHeight.mul(float(1.0).sub(overlap))),
    );
    const row = floor(scaled.y);
    const rowOffset = mod(row, float(2.0)).mul(0.5);
    const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

    const shingleId = floor(offsetUV);
    const localUV = fract(offsetUV);

    // Rounded bottom creates the main normal variation
    const bottomCurve = sin(localUV.x.mul(3.14159)).mul(0.1);
    const bottomEdge = bottomCurve.add(0.05);

    // Distance from bottom edge
    const distFromBottom = localUV.y.sub(bottomEdge);
    const edgeFalloff = smoothstep(0.0, 0.15, distFromBottom);

    // Normal Y points up at the overlapping edge
    const normalY = float(1.0).sub(edgeFalloff).mul(edgeDepth);

    // X normal from the curved bottom - derivative of sin curve is cos
    const curveDerivative = cos(localUV.x.mul(3.14159)).mul(0.1);
    const normalX = curveDerivative
      .mul(float(1.0).sub(edgeFalloff))
      .mul(edgeDepth)
      .mul(0.5);

    // Add per-shingle variation
    const shingleNoise = tslHash(shingleId);
    const warpX = shingleNoise.mul(2.0).sub(1.0).mul(0.08);
    const warpY = tslHash(shingleId.add(vec2(1.0, 0.0)))
      .mul(2.0)
      .sub(1.0)
      .mul(0.08);

    // Surface grain texture
    const grainNoise = tslNoise2D(scaledUV.mul(80.0))
      .mul(2.0)
      .sub(1.0)
      .mul(0.04);

    const perturbX = normalX.add(warpX).add(grainNoise);
    const perturbY = normalY.add(warpY);
    const perturbZ = sqrt(
      max(
        float(0.0),
        float(1.0).sub(perturbX.mul(perturbX)).sub(perturbY.mul(perturbY)),
      ),
    );

    return vec3(perturbX, perturbY, perturbZ);
  },
);

/**
 * Compute normal perturbation for wood plank pattern.
 * Creates wood grain direction and gaps between planks.
 * @returns Tangent-space normal perturbation (x, y, z)
 */
const _woodNormalPerturbation = Fn(
  ([uvIn, textureScale]: [Node<"vec2">, Node<"float">]) => {
    const scaledUV = uvIn.div(textureScale);
    const plankWidth = float(0.15);
    const plankHeight = float(2.0);
    const gapWidth = float(0.005);
    const gapDepth = float(0.6); // Strength of gap edge normal
    const grainDepth = float(0.15); // Strength of wood grain

    const scaled = vec2(
      scaledUV.x.div(plankHeight),
      scaledUV.y.div(plankWidth),
    );
    const plankId = floor(scaled.y);
    const localUV = vec2(fract(scaled.x), fract(scaled.y));

    // Gap between planks creates edge normals
    const gapV = gapWidth.div(plankWidth);
    const distFromGapBottom = localUV.y;
    const distFromGapTop = float(1.0).sub(localUV.y);

    // Bevel at gap edges
    const gapBevelBottom = smoothstep(0.0, gapV.mul(3.0), distFromGapBottom);
    const gapBevelTop = smoothstep(0.0, gapV.mul(3.0), distFromGapTop);

    // Y normal from gap edges
    const gapNormalY = float(1.0)
      .sub(gapBevelBottom)
      .mul(gapDepth)
      .sub(float(1.0).sub(gapBevelTop).mul(gapDepth));

    // Wood grain runs along the plank (X direction)
    const plankOffset = tslHash(vec2(plankId, 0.0)).mul(0.3);
    const grainU = fract(localUV.x.add(plankOffset));

    // Multi-frequency wood grain for realism
    const grain1 = tslNoise2D(vec2(grainU.mul(5.0), plankId.mul(0.5)));
    const grain2 = tslNoise2D(vec2(grainU.mul(20.0), plankId));
    const grain3 = tslNoise2D(vec2(grainU.mul(50.0), plankId.mul(2.0)));
    const combinedGrain = grain1
      .mul(0.5)
      .add(grain2.mul(0.3))
      .add(grain3.mul(0.2));

    // Grain creates subtle Y normal variation
    const grainNormalY = combinedGrain.mul(2.0).sub(1.0).mul(grainDepth);

    // Slight X variation from grain
    const grainNormalX = tslNoise2D(vec2(grainU.mul(30.0).add(50.0), plankId))
      .mul(2.0)
      .sub(1.0)
      .mul(grainDepth)
      .mul(0.3);

    // Per-plank height variation (some planks slightly raised)
    const plankHeight2 = tslHash(vec2(plankId, 1.0)).mul(0.05);

    const perturbX = grainNormalX;
    const perturbY = gapNormalY.add(grainNormalY).add(plankHeight2);
    const perturbZ = sqrt(
      max(
        float(0.0),
        float(1.0).sub(perturbX.mul(perturbX)).sub(perturbY.mul(perturbY)),
      ),
    );

    return vec3(perturbX, perturbY, perturbZ);
  },
);

// Procedural building colors (bright, vibrant brick)
const BUILDING_BASE_COLOR = new THREE.Color("#D87860"); // Bright warm terracotta
const BUILDING_SECONDARY_COLOR = new THREE.Color("#C06850"); // Warm red-brown
const BUILDING_MORTAR_COLOR = new THREE.Color("#F0E8E0"); // Bright cream mortar

// Lamppost vertex lighting (buildings)
const LAMP_VERTEX_LIGHT_RANGE = 12;
const LAMP_VERTEX_LIGHT_INTENSITY = 0.8;
const LAMP_VERTEX_LIGHT_COLOR = new THREE.Color(1.0, 0.9, 0.6);
const LAMP_LIGHT_UPDATE_INTERVAL_SEC = 0.4;
const LAMP_LIGHT_SEARCH_RANGE = 45;

// ============================================================================
// BUILDING OCCLUSION MATERIAL
// ============================================================================

/**
 * Uniforms for building occlusion material.
 */
export type BuildingOcclusionUniforms = {
  playerPos: UniformNode<"vec3", THREE.Vector3>;
  cameraPos: UniformNode<"vec3", THREE.Vector3>;
  // Lighting uniforms
  sunDirection: UniformNode<"vec3", THREE.Vector3>;
  sunColor: UniformNode<"color", THREE.Color>;
  sunIntensity: UniformNode<"float", number>;
  ambientColor: UniformNode<"color", THREE.Color>;
  ambientIntensity: UniformNode<"float", number>;
  // Vertex lighting uniforms (lampposts)
  vertexLightPositions: Array<UniformNode<"vec3", THREE.Vector3>>;
  vertexLightColors: Array<UniformNode<"vec3", THREE.Vector3>>;
  vertexLightParams: Array<UniformNode<"vec2", THREE.Vector2>>;
};

/**
 * Building material with occlusion uniforms attached.
 */
export type BuildingOcclusionMaterial = MeshStandardNodeMaterial & {
  occlusionUniforms: BuildingOcclusionUniforms;
};

/**
 * Creates a building material with procedural textures and dithered occlusion dissolve.
 * Uses TSL (Three Shading Language) for GPU-accelerated patterns and occlusion.
 *
 * The shader creates a cone-shaped dissolve from camera to player,
 * using a dithered/stippled pattern reminiscent of classic fantasy MMORPGs.
 *
 * @returns Material with occlusion shader
 */
function createBuildingOcclusionMaterial(): BuildingOcclusionMaterial {
  const material = new MeshStandardNodeMaterial();

  // Create uniforms - Occlusion
  const uPlayerPos = uniform(new THREE.Vector3(0, 0, 0));
  const uCameraPos = uniform(new THREE.Vector3(0, 0, 0));

  // Create uniforms - Lighting (for explicit sun/ambient calculation)
  const uSunDirection = uniform(new THREE.Vector3(0.5, 0.8, 0.3));
  const uSunColor = uniform(new THREE.Color(1.0, 0.98, 0.92));
  const uSunIntensity = uniform(1.5);
  const uAmbientColor = uniform(new THREE.Color(0.4, 0.45, 0.5));
  const uAmbientIntensity = uniform(0.4);

  // Vertex lighting uniforms (lampposts)
  const vertexLightPositions: Array<UniformNode<"vec3", THREE.Vector3>> = [];
  const vertexLightColors: Array<UniformNode<"vec3", THREE.Vector3>> = [];
  const vertexLightParams: Array<UniformNode<"vec2", THREE.Vector2>> = [];

  for (let i = 0; i < MAX_VERTEX_LIGHTS; i++) {
    vertexLightPositions.push(uniform(new THREE.Vector3(0, 0, 0)));
    vertexLightColors.push(uniform(new THREE.Vector3(1.0, 0.9, 0.6)));
    vertexLightParams.push(
      uniform(new THREE.Vector2(0, LAMP_VERTEX_LIGHT_RANGE)),
    );
  }

  // Config as shader constants - Player occlusion cone
  const occlusionCameraRadius = float(BUILDING_OCCLUSION_CONFIG.CAMERA_RADIUS);
  const occlusionPlayerRadius = float(BUILDING_OCCLUSION_CONFIG.PLAYER_RADIUS);
  const occlusionDistanceScale = float(
    BUILDING_OCCLUSION_CONFIG.DISTANCE_SCALE,
  );
  const occlusionNearMargin = float(BUILDING_OCCLUSION_CONFIG.NEAR_MARGIN);
  const occlusionFarMargin = float(BUILDING_OCCLUSION_CONFIG.FAR_MARGIN);
  const occlusionEdgeSharpness = float(
    BUILDING_OCCLUSION_CONFIG.EDGE_SHARPNESS,
  );
  const occlusionStrength = float(BUILDING_OCCLUSION_CONFIG.STRENGTH);

  // Config as shader constants - Near-camera dissolve (prevents hard geometry clipping)
  const nearFadeStart = float(BUILDING_OCCLUSION_CONFIG.NEAR_FADE_START);
  const nearFadeEnd = float(BUILDING_OCCLUSION_CONFIG.NEAR_FADE_END);

  // Config as shader constants - Distance dissolve (retro Bayer dither fade-in/out)
  const distFadeStart = float(BUILDING_OCCLUSION_CONFIG.DISTANCE_FADE_START);
  const distFadeEnd = float(BUILDING_OCCLUSION_CONFIG.DISTANCE_FADE_END);

  // Create alphaTest node for dithered occlusion + near-camera dissolve + distance dissolve
  material.alphaTestNode = Fn(() => {
    const worldPos = positionWorld;

    // ========== CAMERA-TO-FRAGMENT DISTANCE ==========
    // Used for near-camera dissolve, distance dissolve, and player occlusion
    const cfX = sub(worldPos.x, uCameraPos.x);
    const cfY = sub(worldPos.y, uCameraPos.y);
    const cfZ = sub(worldPos.z, uCameraPos.z);
    const camDistSq = add(add(mul(cfX, cfX), mul(cfY, cfY)), mul(cfZ, cfZ));
    const camDist = sqrt(camDistSq);

    // ========== NEAR-CAMERA DISSOLVE (classic fantasy MMORPG-style depth fade) ==========
    // Prevents hard geometry clipping when camera clips through objects
    // smoothstep returns 0→1 as distance goes from end→start, we invert for fade
    const nearCameraFade = sub(
      float(1.0),
      smoothstep(nearFadeEnd, nearFadeStart, camDist),
    );

    // ========== DISTANCE DISSOLVE (Retro Bayer dither fade-in/out) ==========
    // Buildings dissolve out as they get far from camera using dithered pattern
    // This creates a retro aesthetic similar to old-school games
    // smoothstep returns 0→1 as distance goes from start→end
    const distanceFade = smoothstep(distFadeStart, distFadeEnd, camDist);

    // ========== PLAYER OCCLUSION CONE ==========
    // Camera-to-player vector
    const ctX = sub(uPlayerPos.x, uCameraPos.x);
    const ctY = sub(uPlayerPos.y, uCameraPos.y);
    const ctZ = sub(uPlayerPos.z, uCameraPos.z);
    const ctLengthSq = add(add(mul(ctX, ctX), mul(ctY, ctY)), mul(ctZ, ctZ));
    const ctLength = sqrt(ctLengthSq);

    // Project fragment onto camera-player line
    // projDist = dot(cf, ct) / length(ct)
    const dotCfCt = add(add(mul(cfX, ctX), mul(cfY, ctY)), mul(cfZ, ctZ));
    const projDist = div(dotCfCt, max(ctLength, float(0.001)));

    // Check if fragment is in the valid range (between camera and player)
    const minDist = occlusionNearMargin;
    const maxDist = sub(ctLength, occlusionFarMargin);
    const afterNear = step(minDist, projDist);
    const beforeFar = step(projDist, maxDist);
    const inRange = mul(afterNear, beforeFar);

    // Projection point on the camera-player line
    const projT = div(projDist, max(ctLength, float(0.001)));
    const projX = add(uCameraPos.x, mul(ctX, projT));
    const projY = add(uCameraPos.y, mul(ctY, projT));
    const projZ = add(uCameraPos.z, mul(ctZ, projT));

    // Perpendicular distance from fragment to line
    const perpX = sub(worldPos.x, projX);
    const perpY = sub(worldPos.y, projY);
    const perpZ = sub(worldPos.z, projZ);
    const perpDistSq = add(
      add(mul(perpX, perpX), mul(perpY, perpY)),
      mul(perpZ, perpZ),
    );
    const perpDist = sqrt(perpDistSq);

    // Cone radius calculation (expands from camera to player)
    const t = clamp(
      div(projDist, max(ctLength, float(0.001))),
      float(0.0),
      float(1.0),
    );
    const coneRadius = add(
      add(
        occlusionCameraRadius,
        mul(t, sub(occlusionPlayerRadius, occlusionCameraRadius)),
      ),
      mul(ctLength, occlusionDistanceScale),
    );

    // Sharp edge falloff with stipple effect
    const edgeStart = mul(coneRadius, sub(float(1.0), occlusionEdgeSharpness));
    const rawOcclusionFade = sub(
      float(1.0),
      smoothstep(edgeStart, coneRadius, perpDist),
    );

    // Apply occlusion strength and range check
    const occlusionFade = mul(
      mul(rawOcclusionFade, occlusionStrength),
      inRange,
    );

    // ========== COMBINE FADE EFFECTS ==========
    // Take maximum of all fade effects:
    // - nearCameraFade: dissolve when camera clips through geometry
    // - distanceFade: dissolve buildings at distance (retro Bayer dither)
    // - occlusionFade: dissolve when player is behind walls
    const combinedFade = max(max(nearCameraFade, distanceFade), occlusionFade);

    // ========== SCREEN-SPACE 4x4 BAYER DITHERING (modern fantasy MMORPG style) ==========
    // 4x4 Bayer matrix: [ 0, 8, 2,10; 12, 4,14, 6; 3,11, 1, 9; 15, 7,13, 5]/16
    const ix = mod(floor(viewportCoordinate.x), float(4.0));
    const iy = mod(floor(viewportCoordinate.y), float(4.0));

    // Extract bits (0 or 1)
    const bit0_x = mod(ix, float(2.0));
    const bit1_x = floor(mul(ix, float(0.5)));
    const bit0_y = mod(iy, float(2.0));
    const bit1_y = floor(mul(iy, float(0.5)));

    // XOR for floats: |a - b| gives 0 when equal, 1 when different
    const xor0 = abs(sub(bit0_x, bit0_y)); // (x^y) bit 0
    const xor1 = abs(sub(bit1_x, bit1_y)); // (x^y) bit 1

    // Bayer = ((x^y)&1)*8 + (y&1)*4 + ((x^y)&2) + ((y&2)>>1)
    const bayerInt = add(
      add(
        add(
          mul(xor0, float(8.0)), // ((x^y)&1) << 3
          mul(bit0_y, float(4.0)),
        ), // (y&1) << 2
        mul(xor1, float(2.0)),
      ), // ((x^y)&2)
      bit1_y, // (y&2) >> 1
    );
    const ditherValue = mul(bayerInt, float(0.0625)); // /16

    // modern MMORPG-style: discard when fade >= dither
    // step returns 0 or 1, multiply by 2 so threshold > 1.0 causes discard
    // (alphaTest discards when material.alpha (1.0) < threshold)
    // IMPORTANT: Only apply dithering when combinedFade > 0, otherwise step(0,0)=1 causes holes
    const hasAnyFade = step(float(0.001), combinedFade); // 1 if fade > 0.001
    const rawThreshold = step(ditherValue, combinedFade);
    const threshold = mul(mul(rawThreshold, hasAnyFade), float(2.0));

    return threshold;
  })();

  // ========== PROCEDURAL COLOR NODE ==========
  // Generates procedural textures based on wall material type (from UV2) and surface normal
  // Material IDs: 0.0=brick, 0.2=stone, 0.4=timber, 0.6=stucco, 0.8=wood (vertical), 0.85=siding (horizontal), 1.0=solid

  // Brick colors (classic red/terracotta)
  const uBrickBase = uniform(BUILDING_BASE_COLOR);
  const uBrickSecondary = uniform(BUILDING_SECONDARY_COLOR);
  const uBrickMortar = uniform(BUILDING_MORTAR_COLOR);

  // Stone colors (bright warm gray ashlar blocks)
  const uStoneBase = uniform(new THREE.Color("#B8B0A8")); // Warm light gray stone
  const uStoneSecondary = uniform(new THREE.Color("#9A9088")); // Medium warm gray
  const uStoneMortar = uniform(new THREE.Color("#E0D8D0")); // Bright warm mortar

  // Timber frame colors
  const uTimberBeam = uniform(new THREE.Color("#6B5040")); // Warm brown timber (brighter)
  const uTimberStucco = uniform(new THREE.Color("#FFF5E8")); // Bright cream stucco infill
  const uTimberStuccoSecondary = uniform(new THREE.Color("#F5EBD8")); // Slightly darker

  // Plain stucco colors (cottage style)
  const uStuccoBase = uniform(new THREE.Color("#FFF8F0")); // Bright warm cream
  const uStuccoSecondary = uniform(new THREE.Color("#F5EEE5")); // Slightly darker

  // Wood siding colors (rustic buildings)
  const uWoodBase = uniform(new THREE.Color("#A88030")); // Bright golden brown wood
  const uWoodSecondary = uniform(new THREE.Color("#8B6028")); // Warm brown

  // Roof and floor colors (shared across all materials)
  const uRoofColor = uniform(new THREE.Color("#6B5040")); // Warm brown for roofs (brighter)
  const uRoofSecondary = uniform(new THREE.Color("#5A4030"));
  const uFloorColor = uniform(new THREE.Color("#A89070")); // Bright wood for floors
  const uFloorSecondary = uniform(new THREE.Color("#8B7050"));

  const uVariation = uniform(0.15);
  const uTextureScale = uniform(1.0);

  material.colorNode = Fn(() => {
    // Get UV from mesh, scaled for tiling
    const meshUV = uv();
    const scaledUV = meshUV.div(uTextureScale);
    const worldPos = positionWorld;

    // Get material ID and surface type from UV2
    // UV2.x = material ID (0.0=brick, 0.2=stone, 0.4=timber, 0.6=stucco, 0.8=wood (vertical), 0.85=siding (horizontal), 1.0=solid)
    // UV2.y = surface type (0.0=wall, 0.33=floor, 0.67=roof, 1.0=ceiling)
    const uv2Attr = attribute<"vec2">("uv2", "vec2");
    const materialId = uv2Attr.x;
    const surfaceType = uv2Attr.y;

    // Surface type detection from UV2.y (NOT from normals!)
    // This is critical because flat roofs have normalY=1.0 (same as floors),
    // so we can't reliably distinguish them by normal direction alone.
    // Surface type IDs: 0.0=wall, 0.33=floor, 0.67=roof, 1.0=ceiling
    const isFloor = step(float(0.2), surfaceType).mul(
      step(surfaceType, float(0.5)),
    ); // 0.33 ± 0.13
    const isRoof = step(float(0.5), surfaceType).mul(
      step(surfaceType, float(0.85)),
    ); // 0.67 ± 0.18
    // === BRICK PATTERN (materialId ~= 0.0) ===
    const brickResult = brickPattern(scaledUV);
    const isBrick = brickResult.x;
    const brickId = brickResult.yz;
    const brickLodFade = brickResult.w; // LOD fade from pattern
    const brickNoise = tslHash(brickId);
    // Fade variation at distance - use average color instead of per-brick variation
    const brickVarFaded = mix(
      brickNoise.mul(uVariation),
      float(0.5).mul(uVariation),
      brickLodFade,
    );
    const brickColor = mix(uBrickBase, uBrickSecondary, brickVarFaded);
    // At distance, blend toward average brick/mortar mix
    const avgBrickMortarColor = mix(
      uBrickMortar,
      mix(uBrickBase, uBrickSecondary, float(0.5)),
      float(0.9),
    );
    const brickSurfaceBase = mix(uBrickMortar, brickColor, isBrick);
    const brickSurface = mix(
      brickSurfaceBase,
      avgBrickMortarColor,
      brickLodFade.mul(0.5),
    );

    // === STONE ASHLAR PATTERN (materialId ~= 0.2) ===
    const stoneResult = ashlarPattern(scaledUV);
    const isStone = stoneResult.x;
    const stoneId = stoneResult.yz;
    const stoneBevel = stoneResult.w;
    // Compute stone LOD from derivatives
    const stoneLodFade = calcProceduralLOD(scaledUV.mul(1.11)); // ~1/0.9 blockWidth
    const stoneNoise = tslHash(stoneId);
    const stoneVarFaded = mix(
      stoneNoise.mul(uVariation),
      float(0.5).mul(uVariation),
      stoneLodFade,
    );
    const stoneColor = mix(uStoneBase, uStoneSecondary, stoneVarFaded);
    const beveledStone = stoneColor.mul(
      mix(float(0.85), float(1.0), stoneBevel),
    );
    const avgStoneMortarColor = mix(
      uStoneMortar,
      mix(uStoneBase, uStoneSecondary, float(0.5)),
      float(0.92),
    );
    const stoneSurfaceBase = mix(uStoneMortar, beveledStone, isStone);
    const stoneSurface = mix(
      stoneSurfaceBase,
      avgStoneMortarColor,
      stoneLodFade.mul(0.5),
    );

    // === TIMBER FRAME PATTERN (materialId ~= 0.4) ===
    const timberResult = timberFramePattern(scaledUV);
    const isTimber = timberResult.x;
    const timberCellId = timberResult.yz;
    const timberLodFade = timberResult.w;
    // Stucco infill noise - reduce at distance
    const stuccoNoiseBase = tslNoise2D(scaledUV.mul(15.0)).mul(0.5).add(0.5);
    const stuccoNoiseFaded = mix(stuccoNoiseBase, float(0.5), timberLodFade);
    const stuccoInfill = mix(
      uTimberStucco,
      uTimberStuccoSecondary,
      stuccoNoiseFaded.mul(0.2),
    );
    // Timber beams have wood grain variation
    const timberGrain = tslHash(timberCellId);
    const timberGrainFaded = mix(timberGrain, float(0.5), timberLodFade);
    const timberBeamColor = uTimberBeam.mul(
      mix(float(0.9), float(1.1), timberGrainFaded),
    );
    // At distance, blend to average timber/stucco color
    const avgTimberColor = mix(
      mix(uTimberStucco, uTimberStuccoSecondary, float(0.5)),
      uTimberBeam,
      float(0.25),
    );
    const timberSurfaceBase = mix(stuccoInfill, timberBeamColor, isTimber);
    const timberSurface = mix(
      timberSurfaceBase,
      avgTimberColor,
      timberLodFade.mul(0.5),
    );

    // === PLAIN STUCCO PATTERN (materialId ~= 0.6) ===
    const stuccoResult = stuccoPattern(scaledUV);
    const stuccoVariation = stuccoResult.x;
    // Stucco variation already handles LOD internally
    const plainStuccoSurface = mix(
      uStuccoBase,
      uStuccoSecondary,
      stuccoVariation.mul(0.3),
    );

    // === VERTICAL WOOD PANEL PATTERN (materialId ~= 0.8) ===
    const panelResult = woodPanelPattern(scaledUV);
    const isPanel = panelResult.x;
    const panelPlankId = panelResult.y;
    const panelGrainOffset = panelResult.z;
    const panelLodFade = panelResult.w;
    const panelNoise = tslHash(vec2(panelPlankId, 0.0));
    const panelNoiseFaded = mix(panelNoise, float(0.5), panelLodFade);
    const basePanel = mix(
      uWoodBase,
      uWoodSecondary,
      panelNoiseFaded.mul(uVariation),
    );
    // Grain noise - fade at distance
    const panelGrainBase = tslNoise2D(
      vec2(panelGrainOffset.mul(15.0), panelPlankId),
    );
    const panelGrainFaded = mix(panelGrainBase, float(0.0), panelLodFade);
    const grainedPanel = mix(
      basePanel,
      basePanel.mul(0.85),
      panelGrainFaded.mul(0.25),
    );
    const avgPanelColor = mix(uWoodBase, uWoodSecondary, float(0.5));
    const woodPanelSurfaceBase = mix(
      uWoodSecondary.mul(0.5),
      grainedPanel,
      isPanel,
    );
    const woodPanelSurface = mix(
      woodPanelSurfaceBase,
      avgPanelColor,
      panelLodFade.mul(0.5),
    );

    // === HORIZONTAL WOOD SIDING PATTERN (materialId ~= 0.85) ===
    const sidingResult = woodSidingPattern(scaledUV);
    const isSiding = sidingResult.x;
    const sidingPlankId = sidingResult.y;
    const sidingGrainOffset = sidingResult.z;
    const sidingLodFade = sidingResult.w;
    const sidingNoise = tslHash(vec2(sidingPlankId, 0.0));
    const sidingNoiseFaded = mix(sidingNoise, float(0.5), sidingLodFade);
    const baseSiding = mix(
      uWoodBase,
      uWoodSecondary,
      sidingNoiseFaded.mul(uVariation),
    );
    // Grain noise - fade at distance
    const sidingGrainBase = tslNoise2D(
      vec2(sidingGrainOffset.mul(15.0), sidingPlankId),
    );
    const sidingGrainFaded = mix(sidingGrainBase, float(0.0), sidingLodFade);
    const grainedSiding = mix(
      baseSiding,
      baseSiding.mul(0.85),
      sidingGrainFaded.mul(0.25),
    );
    const avgSidingColor = mix(uWoodBase, uWoodSecondary, float(0.5));
    const woodSidingSurfaceBase = mix(
      uWoodSecondary.mul(0.5),
      grainedSiding,
      isSiding,
    );
    const woodSidingSurface = mix(
      woodSidingSurfaceBase,
      avgSidingColor,
      sidingLodFade.mul(0.5),
    );

    // === SHINGLE PATTERN (for roofs - all material types) ===
    const shingleResult = shinglePattern(scaledUV);
    const isShingle = shingleResult.x;
    const shingleId = shingleResult.yz;
    const shingleThickness = shingleResult.w;
    // Compute shingle LOD
    const shingleLodFade = calcProceduralLOD(scaledUV.mul(5.0)); // ~1/0.2 shingleWidth
    const shingleNoise = tslHash(shingleId);
    const shingleNoiseFaded = mix(shingleNoise, float(0.5), shingleLodFade);
    const shingleColor = mix(
      uRoofColor,
      uRoofSecondary,
      shingleNoiseFaded.mul(uVariation),
    );
    const shadedShingle = shingleColor.mul(shingleThickness);
    const avgShingleColor = mix(uRoofColor, uRoofSecondary, float(0.5)).mul(
      0.97,
    );
    const shingleSurfaceBase = mix(
      uRoofColor.mul(0.3),
      shadedShingle,
      isShingle,
    );
    const shingleSurface = mix(
      shingleSurfaceBase,
      avgShingleColor,
      shingleLodFade.mul(0.5),
    );

    // === WOOD PLANK PATTERN (for floors - all material types) ===
    const woodResult = woodPlankPattern(scaledUV);
    const isPlank = woodResult.x;
    const plankId = woodResult.y;
    const grainOffset = woodResult.z;
    const plankLodFade = woodResult.w;
    const plankNoise = tslHash(vec2(plankId, 0.0));
    const plankNoiseFaded = mix(plankNoise, float(0.5), plankLodFade);
    const baseWood = mix(
      uFloorColor,
      uFloorSecondary,
      plankNoiseFaded.mul(uVariation),
    );
    // Grain noise - fade at distance
    const grainNoiseBase = tslNoise2D(vec2(grainOffset.mul(20.0), plankId));
    const grainNoise = mix(grainNoiseBase, float(0.0), plankLodFade);
    const grainedWood = mix(baseWood, baseWood.mul(0.85), grainNoise.mul(0.3));
    const avgFloorColor = mix(uFloorColor, uFloorSecondary, float(0.5));
    const woodFloorSurfaceBase = mix(
      uFloorSecondary.mul(0.5),
      grainedWood,
      isPlank,
    );
    const woodFloorSurface = mix(
      woodFloorSurfaceBase,
      avgFloorColor,
      plankLodFade.mul(0.5),
    );

    // Select wall pattern based on material ID (UV2.x)
    // Material IDs: 0.0=brick, 0.2=stone, 0.4=timber, 0.6=stucco, 0.8=wood, 0.85=siding, 1.0=solid
    // Uses ranges centered around each ID with 0.05 epsilon for safety
    const wallSurface = vec3(0.0, 0.0, 0.0).toVar();

    // Default to brick (materialId < 0.1)
    wallSurface.assign(brickSurface);

    // Stone: 0.1 <= materialId < 0.3 (ID=0.2)
    wallSurface.assign(
      select(
        step(float(0.1), materialId)
          .mul(float(1.0).sub(step(float(0.3), materialId)))
          .greaterThan(0.5),
        stoneSurface,
        wallSurface,
      ),
    );

    // Timber: 0.3 <= materialId < 0.5 (ID=0.4)
    wallSurface.assign(
      select(
        step(float(0.3), materialId)
          .mul(float(1.0).sub(step(float(0.5), materialId)))
          .greaterThan(0.5),
        timberSurface,
        wallSurface,
      ),
    );

    // Stucco: 0.5 <= materialId < 0.7 (ID=0.6)
    wallSurface.assign(
      select(
        step(float(0.5), materialId)
          .mul(float(1.0).sub(step(float(0.7), materialId)))
          .greaterThan(0.5),
        plainStuccoSurface,
        wallSurface,
      ),
    );

    // Wood panels (vertical): 0.7 <= materialId < 0.82 (ID=0.8)
    wallSurface.assign(
      select(
        step(float(0.7), materialId)
          .mul(float(1.0).sub(step(float(0.82), materialId)))
          .greaterThan(0.5),
        woodPanelSurface,
        wallSurface,
      ),
    );

    // Wood siding (horizontal): 0.82 <= materialId < 0.95 (ID=0.85)
    wallSurface.assign(
      select(
        step(float(0.82), materialId)
          .mul(float(1.0).sub(step(float(0.95), materialId)))
          .greaterThan(0.5),
        woodSidingSurface,
        wallSurface,
      ),
    );

    // Solid: materialId >= 0.95 (ID=1.0) - uses vertex colors only, no procedural pattern
    // White base surface that will be tinted by vertex colors
    wallSurface.assign(
      select(
        step(float(0.95), materialId).greaterThan(0.5),
        vec3(1.0, 1.0, 1.0),
        wallSurface,
      ),
    );

    // Final surface color: priority floor > roof > wall
    const surfaceColor = vec3(0.0, 0.0, 0.0).toVar();
    surfaceColor.assign(wallSurface);
    surfaceColor.assign(
      select(isRoof.greaterThan(0.5), shingleSurface, surfaceColor),
    );
    surfaceColor.assign(
      select(isFloor.greaterThan(0.5), woodFloorSurface, surfaceColor),
    );

    // Apply vertex colors for interior lighting (if present)
    // Vertex colors encode baked interior lighting (from room center lights)
    // - Interior-facing surfaces: vertex color < 1.0 (darkened by baked lighting)
    // - Exterior-facing surfaces: vertex color = 1.0 (white, normal PBR lighting)
    // - Roofs: may not have vertex colors at all (excluded from baking)
    //
    // NOTE: Roofs are excluded from interior lighting baking, so they won't have
    // the "color" attribute. In that case, attribute() returns zeros which would
    // make roofs black. We detect this by checking if the vertex color sum is
    // near zero (invalid) and fall back to white (1,1,1).
    const rawVertexColor = attribute<"vec3">("color", "vec3");

    // Check if vertex colors are valid (sum > 0.1 means they exist and are non-black)
    // If vertex colors don't exist or are black (sum ~0), use white instead
    const vertexColorSum = rawVertexColor.x
      .add(rawVertexColor.y)
      .add(rawVertexColor.z);
    const hasValidVertexColors = step(float(0.1), vertexColorSum);
    const vertexColor = mix(
      vec3(1.0, 1.0, 1.0),
      rawVertexColor,
      hasValidVertexColors,
    );

    // Apply vertex color tint for interior lighting
    // Exterior surfaces should have white vertex colors, so they're unaffected
    // Interior surfaces have baked lighting in vertex colors (darker where less light reaches)
    const finalColor = surfaceColor.mul(vertexColor);

    // ============================================================================
    // VERTEX LIGHTING (lampposts, torches, etc.)
    // Simple additive point lights with smooth attenuation
    // ============================================================================
    const calculateLightContribution = (
      lightPos: UniformNode<"vec3", THREE.Vector3>,
      lightColor: UniformNode<"vec3", THREE.Vector3>,
      lightParams: UniformNode<"vec2", THREE.Vector2>, // x=intensity, y=range
    ): Node<"vec3"> => {
      const toLightVec = sub(lightPos, worldPos);
      const distToLight = add(
        add(mul(toLightVec.x, toLightVec.x), mul(toLightVec.y, toLightVec.y)),
        mul(toLightVec.z, toLightVec.z),
      );
      const rangeSq = mul(lightParams.y, lightParams.y);
      const attenuation = mul(
        smoothstep(rangeSq, float(0), distToLight),
        lightParams.x,
      );
      return mul(lightColor, attenuation);
    };

    let lightAccum: Node<"vec3"> = vec3(0, 0, 0);
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[0],
        vertexLightColors[0],
        vertexLightParams[0],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[1],
        vertexLightColors[1],
        vertexLightParams[1],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[2],
        vertexLightColors[2],
        vertexLightParams[2],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[3],
        vertexLightColors[3],
        vertexLightParams[3],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[4],
        vertexLightColors[4],
        vertexLightParams[4],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[5],
        vertexLightColors[5],
        vertexLightParams[5],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[6],
        vertexLightColors[6],
        vertexLightParams[6],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[7],
        vertexLightColors[7],
        vertexLightParams[7],
      ),
    );

    // Baked lamppost light mask (night-only)
    const lampMaskState = getLamppostLightTextureState();
    const lampHalfWorld = lampMaskState.uWorldSize.mul(0.5);
    const lampUvX = worldPos.x
      .sub(lampMaskState.uCenterX)
      .add(lampHalfWorld)
      .div(lampMaskState.uWorldSize);
    const lampUvZ = worldPos.z
      .sub(lampMaskState.uCenterZ)
      .add(lampHalfWorld)
      .div(lampMaskState.uWorldSize);
    const lampUV = vec2(
      lampUvX.clamp(0.001, 0.999),
      lampUvZ.clamp(0.001, 0.999),
    );
    const lampMask = lampMaskState.textureNode.sample(lampUV).r;
    const hasLampMask = smoothstep(
      float(1.0),
      float(2.0),
      lampMaskState.uWorldSize,
    );
    const lampDx = abs(worldPos.x.sub(lampMaskState.uCenterX));
    const lampDz = abs(worldPos.z.sub(lampMaskState.uCenterZ));
    const lampInside = step(lampDx, lampHalfWorld).mul(
      step(lampDz, lampHalfWorld),
    );
    const lampUse = hasLampMask.mul(lampInside);
    const lampIntensity = lampMask.mul(lampUse).mul(lampMaskState.uNightMix);
    const lampColor = vec3(1.0, 0.9, 0.6);
    lightAccum = add(lightAccum, mul(lampColor, lampIntensity));

    const litColor = mul(finalColor, add(vec3(1, 1, 1), lightAccum));

    return litColor;
  })();

  // ========== NORMAL HANDLING ==========
  // Let MeshStandardNodeMaterial use the default normal from geometry
  // Do NOT override normalNode - this ensures proper PBR lighting from directional lights
  // material.normalNode = normalWorld; // REMOVED - was interfering with lighting

  // ========== PROCEDURAL ROUGHNESS NODE ==========
  // Varies roughness based on wall material type (from UV2) and surface type
  material.roughnessNode = Fn(() => {
    const meshUV = uv();
    const scaledUV = meshUV.div(uTextureScale);

    // Get material ID and surface type from UV2
    const uv2Attr = attribute<"vec2">("uv2", "vec2");
    const materialId = uv2Attr.x;
    const surfaceType = uv2Attr.y;

    // Surface type detection from UV2.y (same as colorNode)
    // Surface type IDs: 0.0=wall, 0.33=floor, 0.67=roof, 1.0=ceiling
    const isFloor = step(float(0.2), surfaceType).mul(
      step(surfaceType, float(0.5)),
    );
    const isRoof = step(float(0.5), surfaceType).mul(
      step(surfaceType, float(0.85)),
    );

    // === BRICK ROUGHNESS (materialId ~= 0.0) ===
    const brickResult = brickPattern(scaledUV);
    const isBrick = brickResult.x;
    const brickId = brickResult.yz;
    const brickRoughVar = tslHash(brickId).mul(0.15);
    const brickRoughness = float(0.75).add(brickRoughVar); // 0.75-0.90
    const brickMortarRoughness = float(0.95);
    const brickWallRoughness = mix(
      brickMortarRoughness,
      brickRoughness,
      isBrick,
    );

    // === STONE ROUGHNESS (materialId ~= 0.2) ===
    const stoneResult = ashlarPattern(scaledUV);
    const isStone = stoneResult.x;
    const stoneId = stoneResult.yz;
    const stoneBevel = stoneResult.w;
    const stoneRoughVar = tslHash(stoneId).mul(0.12);
    const stoneRoughness = float(0.68).add(stoneRoughVar); // 0.68-0.80 (smoother than brick)
    const stoneMortarRoughness = float(0.92);
    const stoneWallRoughness = mix(
      stoneMortarRoughness,
      stoneRoughness.mul(stoneBevel),
      isStone,
    );

    // === TIMBER ROUGHNESS (materialId ~= 0.4) ===
    const timberResult = timberFramePattern(scaledUV);
    const isTimber = timberResult.x;
    const timberRoughness = float(0.82); // Wood beams are fairly rough
    const timberStuccoNoise = tslNoise2D(scaledUV.mul(10.0)).mul(0.5).add(0.5);
    const timberStuccoRoughness = float(0.88).add(timberStuccoNoise.mul(0.08)); // 0.88-0.96
    const timberWallRoughness = mix(
      timberStuccoRoughness,
      timberRoughness,
      isTimber,
    );

    // === STUCCO ROUGHNESS (materialId ~= 0.6) ===
    const stuccoNoise = tslNoise2D(scaledUV.mul(12.0)).mul(0.5).add(0.5);
    const stuccoWallRoughness = float(0.85).add(stuccoNoise.mul(0.1)); // 0.85-0.95

    // === VERTICAL WOOD PANEL ROUGHNESS (materialId ~= 0.8) ===
    const panelResult = woodPanelPattern(scaledUV);
    const isPanel = panelResult.x;
    const panelPlankId = panelResult.y;
    const panelRoughVar = tslHash(vec2(panelPlankId, 3.0)).mul(0.1);
    const panelRoughness = float(0.7).add(panelRoughVar); // 0.70-0.80 (rougher unfinished wood)
    const panelGapRoughness = float(0.85);
    const woodPanelWallRoughness = mix(
      panelGapRoughness,
      panelRoughness,
      isPanel,
    );

    // === HORIZONTAL WOOD SIDING ROUGHNESS (materialId ~= 0.85) ===
    const sidingResult = woodSidingPattern(scaledUV);
    const isSiding = sidingResult.x;
    const sidingPlankId = sidingResult.y;
    const sidingRoughVar = tslHash(vec2(sidingPlankId, 3.0)).mul(0.1);
    const sidingRoughness = float(0.68).add(sidingRoughVar); // 0.68-0.78 (smoother finished wood)
    const sidingGapRoughness = float(0.85);
    const woodSidingWallRoughness = mix(
      sidingGapRoughness,
      sidingRoughness,
      isSiding,
    );

    // === SOLID ROUGHNESS (materialId ~= 1.0) - painted/finished wood trim ===
    const solidWallRoughness = float(0.65); // Smooth painted wood finish

    // Select wall roughness based on material ID
    // Material IDs: 0.0=brick, 0.2=stone, 0.4=timber, 0.6=stucco, 0.8=wood, 0.85=siding, 1.0=solid
    const wallRoughness = float(0.85).toVar();
    wallRoughness.assign(brickWallRoughness); // Default: brick

    // Stone: 0.1 <= materialId < 0.3
    wallRoughness.assign(
      select(
        step(float(0.1), materialId)
          .mul(float(1.0).sub(step(float(0.3), materialId)))
          .greaterThan(0.5),
        stoneWallRoughness,
        wallRoughness,
      ),
    );
    // Timber: 0.3 <= materialId < 0.5
    wallRoughness.assign(
      select(
        step(float(0.3), materialId)
          .mul(float(1.0).sub(step(float(0.5), materialId)))
          .greaterThan(0.5),
        timberWallRoughness,
        wallRoughness,
      ),
    );
    // Stucco: 0.5 <= materialId < 0.7
    wallRoughness.assign(
      select(
        step(float(0.5), materialId)
          .mul(float(1.0).sub(step(float(0.7), materialId)))
          .greaterThan(0.5),
        stuccoWallRoughness,
        wallRoughness,
      ),
    );
    // Wood panels (vertical): 0.7 <= materialId < 0.82
    wallRoughness.assign(
      select(
        step(float(0.7), materialId)
          .mul(float(1.0).sub(step(float(0.82), materialId)))
          .greaterThan(0.5),
        woodPanelWallRoughness,
        wallRoughness,
      ),
    );
    // Wood siding (horizontal): 0.82 <= materialId < 0.95
    wallRoughness.assign(
      select(
        step(float(0.82), materialId)
          .mul(float(1.0).sub(step(float(0.95), materialId)))
          .greaterThan(0.5),
        woodSidingWallRoughness,
        wallRoughness,
      ),
    );
    // Solid: materialId >= 0.95 - smooth painted/finished wood trim
    wallRoughness.assign(
      select(
        step(float(0.95), materialId).greaterThan(0.5),
        solidWallRoughness,
        wallRoughness,
      ),
    );

    // === SHINGLE ROUGHNESS (for roofs - all material types) ===
    const shingleResult = shinglePattern(scaledUV);
    const isShingle = shingleResult.x;
    const shingleId = shingleResult.yz;
    const shingleThickness = shingleResult.w;
    const shingleWear = tslHash(shingleId.add(vec2(5.0, 0.0))).mul(0.2);
    const shingleRoughness = float(0.8)
      .add(shingleWear)
      .sub(shingleThickness.mul(0.1));
    const shingleGapRoughness = float(0.95);
    const roofRoughness = mix(shingleGapRoughness, shingleRoughness, isShingle);

    // === WOOD ROUGHNESS (for floors - all material types) ===
    const woodResult = woodPlankPattern(scaledUV);
    const isPlank = woodResult.x;
    const plankId = woodResult.y;
    const grainOffset = woodResult.z;
    const grainRough = tslNoise2D(vec2(grainOffset.mul(30.0), plankId)).mul(
      0.15,
    );
    const plankBaseRough = float(0.7).add(tslHash(vec2(plankId, 2.0)).mul(0.1));
    const floorWoodRoughness = plankBaseRough.add(grainRough);
    const floorGapRoughness = float(0.9);
    const floorRoughness = mix(floorGapRoughness, floorWoodRoughness, isPlank);

    // Select final roughness: priority floor > roof > wall
    const roughness = float(0.85).toVar();
    roughness.assign(wallRoughness);
    roughness.assign(select(isRoof.greaterThan(0.5), roofRoughness, roughness));
    roughness.assign(
      select(isFloor.greaterThan(0.5), floorRoughness, roughness),
    );

    return clamp(roughness, 0.3, 1.0);
  })();

  // Material settings
  // Note: We read vertex colors explicitly in colorNode via attribute("color", "vec3")
  // Do NOT set vertexColors=true as it would double-multiply vertex colors
  material.vertexColors = false;
  // Base roughness/metalness (roughnessNode overrides roughness)
  material.roughness = 0.85;
  material.metalness = 0.05;
  material.transparent = false;
  material.opacity = 1.0;
  material.alphaTest = 0.5;
  material.side = THREE.FrontSide;
  material.depthWrite = true;

  // Attach uniforms for external updates
  const occlusionMaterial = material as BuildingOcclusionMaterial;
  occlusionMaterial.occlusionUniforms = {
    playerPos: uPlayerPos,
    cameraPos: uCameraPos,
    // Lighting uniforms for sun/ambient
    sunDirection: uSunDirection,
    sunColor: uSunColor,
    sunIntensity: uSunIntensity,
    ambientColor: uAmbientColor,
    ambientIntensity: uAmbientIntensity,
    vertexLightPositions,
    vertexLightColors,
    vertexLightParams,
  };

  applySkyFog(material);

  return occlusionMaterial;
}

// ============================================================================
// ROOF MATERIAL WITH PER-BUILDING VISIBILITY
// ============================================================================

/**
 * Maximum number of buildings that can have hidden roofs simultaneously.
 * Uses a fixed-size uniform array for GPU compatibility.
 */
const MAX_HIDDEN_ROOF_BUILDINGS = 16;

/**
 * Uniforms for roof material with per-building visibility.
 */
export type RoofOcclusionUniforms = BuildingOcclusionUniforms & {
  /** Array of hidden building centers (x, z in .x and .y components) */
  hiddenBuildingCenters: { value: THREE.Vector2[] };
  /** Array of hidden building radii (for proximity check) */
  hiddenBuildingRadii: { value: number[] };
  /** Number of currently hidden buildings (0 to MAX_HIDDEN_ROOF_BUILDINGS) */
  hiddenBuildingCount: { value: number };
};

/**
 * Roof material with per-building visibility support.
 */
export type RoofOcclusionMaterial = MeshStandardNodeMaterial & {
  occlusionUniforms: RoofOcclusionUniforms;
};

/**
 * Creates a roof material with per-building visibility and dithered occlusion.
 * Uses TSL (Three Shading Language) for GPU-accelerated per-building roof hiding.
 *
 * The shader uses a buildingCenter vertex attribute to determine which building
 * each roof vertex belongs to. When the player/camera is inside a building's bounds,
 * that building's roof is hidden using a dithered dissolve effect.
 *
 * Vertex Attributes Required:
 * - buildingCenter (vec2): XZ center of the building this vertex belongs to
 * - buildingRadius (float): Radius of the building footprint
 *
 * @returns Material with per-building roof visibility
 */
function createBuildingRoofMaterial(): RoofOcclusionMaterial {
  const material = new MeshStandardNodeMaterial();

  // Create uniforms - Occlusion
  const uPlayerPos = uniform(new THREE.Vector3(0, 0, 0));
  const uCameraPos = uniform(new THREE.Vector3(0, 0, 0));

  // Create uniforms - Lighting (for explicit sun/ambient calculation)
  const uSunDirection = uniform(new THREE.Vector3(0.5, 0.8, 0.3));
  const uSunColor = uniform(new THREE.Color(1.0, 0.98, 0.92));
  const uSunIntensity = uniform(1.5);
  const uAmbientColor = uniform(new THREE.Color(0.4, 0.45, 0.5));
  const uAmbientIntensity = uniform(0.4);

  // Vertex lighting uniforms (lampposts)
  const vertexLightPositions: Array<UniformNode<"vec3", THREE.Vector3>> = [];
  const vertexLightColors: Array<UniformNode<"vec3", THREE.Vector3>> = [];
  const vertexLightParams: Array<UniformNode<"vec2", THREE.Vector2>> = [];

  for (let i = 0; i < MAX_VERTEX_LIGHTS; i++) {
    vertexLightPositions.push(uniform(new THREE.Vector3(0, 0, 0)));
    vertexLightColors.push(uniform(new THREE.Vector3(1.0, 0.9, 0.6)));
    vertexLightParams.push(
      uniform(new THREE.Vector2(0, LAMP_VERTEX_LIGHT_RANGE)),
    );
  }

  // Create uniforms - Per-building roof visibility
  // Initialize arrays with default values
  const defaultCenters: THREE.Vector2[] = [];
  const defaultRadii: number[] = [];
  for (let i = 0; i < MAX_HIDDEN_ROOF_BUILDINGS; i++) {
    defaultCenters.push(new THREE.Vector2(-99999, -99999)); // Far away = not hidden
    defaultRadii.push(0);
  }
  const uHiddenBuildingCenters = { value: defaultCenters };
  const uHiddenBuildingRadii = { value: defaultRadii };
  const uHiddenBuildingCount = { value: 0 };

  // Config as shader constants - Player occlusion cone
  const occlusionCameraRadius = float(BUILDING_OCCLUSION_CONFIG.CAMERA_RADIUS);
  const occlusionPlayerRadius = float(BUILDING_OCCLUSION_CONFIG.PLAYER_RADIUS);
  const occlusionDistanceScale = float(
    BUILDING_OCCLUSION_CONFIG.DISTANCE_SCALE,
  );
  const occlusionNearMargin = float(BUILDING_OCCLUSION_CONFIG.NEAR_MARGIN);
  const occlusionFarMargin = float(BUILDING_OCCLUSION_CONFIG.FAR_MARGIN);
  const occlusionEdgeSharpness = float(
    BUILDING_OCCLUSION_CONFIG.EDGE_SHARPNESS,
  );
  const occlusionStrength = float(BUILDING_OCCLUSION_CONFIG.STRENGTH);

  // Config as shader constants - Near-camera dissolve
  const nearFadeStart = float(BUILDING_OCCLUSION_CONFIG.NEAR_FADE_START);
  const nearFadeEnd = float(BUILDING_OCCLUSION_CONFIG.NEAR_FADE_END);

  // Config as shader constants - Distance dissolve
  const distFadeStart = float(BUILDING_OCCLUSION_CONFIG.DISTANCE_FADE_START);
  const distFadeEnd = float(BUILDING_OCCLUSION_CONFIG.DISTANCE_FADE_END);

  // Roof hiding config - uses dithered fade instead of instant pop
  // Fade starts at roofFadeStart from building edge, fully hidden at roofFadeEnd
  const roofFadeStart = float(25.0); // Distance where roof starts fading (from building edge)
  const roofFadeEnd = float(2.0); // Distance where roof is fully hidden (10m fade range)

  // Create alphaTest node for per-building roof hiding + dithered occlusion
  material.alphaTestNode = Fn(() => {
    const worldPos = positionWorld;

    // ========== READ BUILDING CENTER FROM VERTEX ATTRIBUTE ==========
    // Each roof vertex has the XZ center of its building baked in
    const buildingCenter = attribute<"vec2">("buildingCenter", "vec2");
    const buildingRadius = attribute<"float">("buildingRadius", "float");

    // ========== PER-BUILDING ROOF HIDING (DITHERED FADE) ==========
    // Check distance of player AND camera to this building on XZ plane
    // Use the building's own center and radius from vertex attributes
    // Fade smoothly over 10m range instead of instant pop

    // Player distance to building center (XZ only)
    const playerDx = sub(uPlayerPos.x, buildingCenter.x);
    const playerDz = sub(uPlayerPos.z, buildingCenter.y); // .y is Z in vec2
    const playerDistSq = add(mul(playerDx, playerDx), mul(playerDz, playerDz));
    const playerDist = sqrt(playerDistSq);

    // Camera distance to building center (XZ only)
    const cameraDx = sub(uCameraPos.x, buildingCenter.x);
    const cameraDz = sub(uCameraPos.z, buildingCenter.y);
    const cameraDistSq = add(mul(cameraDx, cameraDx), mul(cameraDz, cameraDz));
    const cameraDist = sqrt(cameraDistSq);

    // Use the closer of player or camera distance
    const closerDist = min(playerDist, cameraDist);

    // Calculate fade thresholds based on building radius
    // fadeStartDist: roof starts fading when closer than this
    // fadeEndDist: roof fully hidden when closer than this
    const fadeStartDist = add(buildingRadius, roofFadeStart); // e.g., radius + 12m
    const fadeEndDist = add(buildingRadius, roofFadeEnd); // e.g., radius + 2m

    // Smooth dithered fade from fadeStartDist (visible) to fadeEndDist (hidden)
    // smoothstep(edge0, edge1, x) returns 0 when x < edge0, 1 when x > edge1
    // We want: visible (0) when far, hidden (1) when close
    // So: smoothstep(fadeEndDist, fadeStartDist, closerDist) gives us:
    //   - 0 when closerDist < fadeEndDist (closer than 2m → fully hidden via 1-0=1 after invert)
    //   - 1 when closerDist > fadeStartDist (farther than 12m → visible via 1-1=0 after invert)
    // Invert to get: 1 = hide, 0 = show
    const rawRoofFade = sub(
      float(1.0),
      smoothstep(fadeEndDist, fadeStartDist, closerDist),
    );

    // CRITICAL FIX: Ensure roofs do not fade if the player is standing ON or above them.
    // If player's Y is roughly at or above the roof level (allow 2.0 margin for steps),
    // they are considered "on the roof" and the roof should remain visible.
    // step(edge, x) -> 1 if x >= edge, 0 otherwise
    const isPlayerOnRoof = step(sub(worldPos.y, float(2.0)), uPlayerPos.y);

    // Mask the fade: multiply by (1.0 - isPlayerOnRoof) to force fade to 0 (visible) when on roof
    const roofFade = mul(rawRoofFade, sub(float(1.0), isPlayerOnRoof));

    // ========== CAMERA-TO-FRAGMENT DISTANCE ==========
    const cfX = sub(worldPos.x, uCameraPos.x);
    const cfY = sub(worldPos.y, uCameraPos.y);
    const cfZ = sub(worldPos.z, uCameraPos.z);
    const camDistSq = add(add(mul(cfX, cfX), mul(cfY, cfY)), mul(cfZ, cfZ));
    const camDist = sqrt(camDistSq);

    // ========== NEAR-CAMERA DISSOLVE ==========
    const nearCameraFade = sub(
      float(1.0),
      smoothstep(nearFadeEnd, nearFadeStart, camDist),
    );

    // ========== DISTANCE DISSOLVE ==========
    const distanceFade = smoothstep(distFadeStart, distFadeEnd, camDist);

    // ========== PLAYER OCCLUSION CONE ==========
    const ctX = sub(uPlayerPos.x, uCameraPos.x);
    const ctY = sub(uPlayerPos.y, uCameraPos.y);
    const ctZ = sub(uPlayerPos.z, uCameraPos.z);
    const ctLengthSq = add(add(mul(ctX, ctX), mul(ctY, ctY)), mul(ctZ, ctZ));
    const ctLength = sqrt(ctLengthSq);

    const dotCfCt = add(add(mul(cfX, ctX), mul(cfY, ctY)), mul(cfZ, ctZ));
    const projDist = div(dotCfCt, max(ctLength, float(0.001)));

    const minDist = occlusionNearMargin;
    const maxDist = sub(ctLength, occlusionFarMargin);
    const afterNear = step(minDist, projDist);
    const beforeFar = step(projDist, maxDist);
    const inRange = mul(afterNear, beforeFar);

    const projT = div(projDist, max(ctLength, float(0.001)));
    const projX = add(uCameraPos.x, mul(ctX, projT));
    const projY = add(uCameraPos.y, mul(ctY, projT));
    const projZ = add(uCameraPos.z, mul(ctZ, projT));

    const perpX = sub(worldPos.x, projX);
    const perpY = sub(worldPos.y, projY);
    const perpZ = sub(worldPos.z, projZ);
    const perpDistSq = add(
      add(mul(perpX, perpX), mul(perpY, perpY)),
      mul(perpZ, perpZ),
    );
    const perpDist = sqrt(perpDistSq);

    const t = clamp(
      div(projDist, max(ctLength, float(0.001))),
      float(0.0),
      float(1.0),
    );
    const coneRadius = add(
      add(
        occlusionCameraRadius,
        mul(t, sub(occlusionPlayerRadius, occlusionCameraRadius)),
      ),
      mul(ctLength, occlusionDistanceScale),
    );

    const edgeStart = mul(coneRadius, sub(float(1.0), occlusionEdgeSharpness));
    const rawOcclusionFade = sub(
      float(1.0),
      smoothstep(edgeStart, coneRadius, perpDist),
    );

    const occlusionFade = mul(
      mul(rawOcclusionFade, occlusionStrength),
      inRange,
    );

    // ========== COMBINE FADE EFFECTS ==========
    // Take maximum of all fade effects for dithered dissolve:
    // - nearCameraFade: dissolve when camera clips through geometry
    // - distanceFade: dissolve buildings at distance (retro Bayer dither)
    // - occlusionFade: dissolve when player is behind walls
    // - roofFade: dissolve roof when player/camera approaches building (10m fade range)
    const combinedFade = max(
      max(max(nearCameraFade, distanceFade), occlusionFade),
      roofFade,
    );

    // ========== SCREEN-SPACE 4x4 BAYER DITHERING ==========
    const ix = mod(floor(viewportCoordinate.x), float(4.0));
    const iy = mod(floor(viewportCoordinate.y), float(4.0));

    const bit0_x = mod(ix, float(2.0));
    const bit1_x = floor(mul(ix, float(0.5)));
    const bit0_y = mod(iy, float(2.0));
    const bit1_y = floor(mul(iy, float(0.5)));

    const xor0 = abs(sub(bit0_x, bit0_y));
    const xor1 = abs(sub(bit1_x, bit1_y));

    const bayerInt = add(
      add(
        add(mul(xor0, float(8.0)), mul(bit0_y, float(4.0))),
        mul(xor1, float(2.0)),
      ),
      bit1_y,
    );
    const ditherValue = mul(bayerInt, float(0.0625));

    const hasAnyFade = step(float(0.001), combinedFade);
    const rawThreshold = step(ditherValue, combinedFade);
    const threshold = mul(mul(rawThreshold, hasAnyFade), float(2.0));

    return threshold;
  })();

  // ========== PROCEDURAL COLOR NODE ==========
  // Reuse the same procedural texturing as the wall material

  // Roof colors (brighter warm brown)
  const uRoofBase = uniform(new THREE.Color("#A06048")); // Warm terracotta
  const uRoofSecondary = uniform(new THREE.Color("#B07050")); // Lighter brown

  material.colorNode = Fn(() => {
    // Read vertex color for tinting
    const vertexColor = attribute<"vec3">("color", "vec3");

    // World position for texture coordinates
    const worldPos = positionWorld;

    // Triplanar scale
    const textureScale = float(0.5);
    const scaledPos = mul(worldPos, textureScale);

    // Simple procedural pattern for roofs - tile pattern
    const tileScaleX = float(2.0);
    const tileScaleZ = float(4.0);

    // Create tile variation
    const tileNoise = sin(
      add(
        mul(floor(mul(scaledPos.x, tileScaleX)), float(12.9898)),
        mul(floor(mul(scaledPos.z, tileScaleZ)), float(78.233)),
      ),
    );
    const tileVariation = mul(
      add(
        float(0.5),
        mul(fract(mul(tileNoise, float(43758.5453))), float(0.5)),
      ),
      float(0.3),
    );

    // Mix roof colors based on tile variation
    const roofColor = mix(uRoofBase, uRoofSecondary, tileVariation);

    // Apply vertex color tinting (roofs should have white vertex colors = exterior)
    const finalColor = mul(roofColor, vertexColor);

    // ============================================================================
    // VERTEX LIGHTING (lampposts, torches, etc.)
    // ============================================================================
    const calculateLightContribution = (
      lightPos: UniformNode<"vec3", THREE.Vector3>,
      lightColor: UniformNode<"vec3", THREE.Vector3>,
      lightParams: UniformNode<"vec2", THREE.Vector2>, // x=intensity, y=range
    ): Node<"vec3"> => {
      const toLightVec = sub(lightPos, worldPos);
      const distToLight = add(
        add(mul(toLightVec.x, toLightVec.x), mul(toLightVec.y, toLightVec.y)),
        mul(toLightVec.z, toLightVec.z),
      );
      const rangeSq = mul(lightParams.y, lightParams.y);
      const attenuation = mul(
        smoothstep(rangeSq, float(0), distToLight),
        lightParams.x,
      );
      return mul(lightColor, attenuation);
    };

    let lightAccum: Node<"vec3"> = vec3(0, 0, 0);
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[0],
        vertexLightColors[0],
        vertexLightParams[0],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[1],
        vertexLightColors[1],
        vertexLightParams[1],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[2],
        vertexLightColors[2],
        vertexLightParams[2],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[3],
        vertexLightColors[3],
        vertexLightParams[3],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[4],
        vertexLightColors[4],
        vertexLightParams[4],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[5],
        vertexLightColors[5],
        vertexLightParams[5],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[6],
        vertexLightColors[6],
        vertexLightParams[6],
      ),
    );
    lightAccum = add(
      lightAccum,
      calculateLightContribution(
        vertexLightPositions[7],
        vertexLightColors[7],
        vertexLightParams[7],
      ),
    );

    // Baked lamppost light mask (night-only)
    const lampMaskState = getLamppostLightTextureState();
    const lampHalfWorld = lampMaskState.uWorldSize.mul(0.5);
    const lampUvX = worldPos.x
      .sub(lampMaskState.uCenterX)
      .add(lampHalfWorld)
      .div(lampMaskState.uWorldSize);
    const lampUvZ = worldPos.z
      .sub(lampMaskState.uCenterZ)
      .add(lampHalfWorld)
      .div(lampMaskState.uWorldSize);
    const lampUV = vec2(
      lampUvX.clamp(0.001, 0.999),
      lampUvZ.clamp(0.001, 0.999),
    );
    const lampMask = lampMaskState.textureNode.sample(lampUV).r;
    const hasLampMask = smoothstep(
      float(1.0),
      float(2.0),
      lampMaskState.uWorldSize,
    );
    const lampDx = abs(worldPos.x.sub(lampMaskState.uCenterX));
    const lampDz = abs(worldPos.z.sub(lampMaskState.uCenterZ));
    const lampInside = step(lampDx, lampHalfWorld).mul(
      step(lampDz, lampHalfWorld),
    );
    const lampUse = hasLampMask.mul(lampInside);
    const lampIntensity = lampMask.mul(lampUse).mul(lampMaskState.uNightMix);
    const lampColor = vec3(1.0, 0.9, 0.6);
    lightAccum = add(lightAccum, mul(lampColor, lampIntensity));

    const litColor = mul(finalColor, add(vec3(1, 1, 1), lightAccum));

    return litColor;
  })();

  // Roughness variation for roof tiles
  material.roughnessNode = Fn(() => {
    const worldPos = positionWorld;
    const tileNoise = sin(
      add(mul(worldPos.x, float(3.1)), mul(worldPos.z, float(2.7))),
    );
    return add(float(0.7), mul(tileNoise, float(0.15)));
  })();

  // NOTE: We don't use outputNode here - let Three.js's standard material
  // lighting handle the rendering. The colorNode provides the base color,
  // and the standard MeshStandardNodeMaterial will apply proper PBR lighting.

  // Material settings
  material.vertexColors = false;
  material.roughness = 0.75;
  material.metalness = 0.05;
  material.transparent = false;
  material.opacity = 1.0;
  material.alphaTest = 0.5;
  material.side = THREE.FrontSide;
  material.depthWrite = true;

  // Attach uniforms for external updates
  const roofMaterial = material as RoofOcclusionMaterial;
  roofMaterial.occlusionUniforms = {
    playerPos: uPlayerPos,
    cameraPos: uCameraPos,
    sunDirection: uSunDirection,
    sunColor: uSunColor,
    sunIntensity: uSunIntensity,
    ambientColor: uAmbientColor,
    ambientIntensity: uAmbientIntensity,
    vertexLightPositions,
    vertexLightColors,
    vertexLightParams,
    hiddenBuildingCenters: uHiddenBuildingCenters,
    hiddenBuildingRadii: uHiddenBuildingRadii,
    hiddenBuildingCount: uHiddenBuildingCount,
  };

  applySkyFog(material);

  return roofMaterial;
}

/**
 * Building type mapping from TownBuildingType to procgen recipe keys.
 * Some town building types don't have direct procgen equivalents and use fallbacks.
 */
const BUILDING_TYPE_TO_RECIPE: Record<string, string> = {
  bank: "bank",
  store: "store",
  inn: "inn",
  smithy: "smithy",
  house: "simple-house", // house -> simple-house recipe
  "simple-house": "simple-house",
  "long-house": "long-house",
  church: "church",
  cathedral: "cathedral",
  chapel: "chapel",
  keep: "keep",
  fortress: "fortress",
  castle: "castle",
  "guild-hall": "guild-hall",
  "town-hall": "town-hall",
  mansion: "mansion",
  manor: "manor",
  // "well" and "anvil" are stations, not buildings - handled by StationSpawnerSystem
};

/**
 * Building types that are stations (not visual buildings).
 * These are spawned as interactive entities by StationSpawnerSystem.
 */
const STATION_TYPES = new Set(["well", "anvil"]);

/**
 * PhysX collision body for a building component (wall, floor, or roof)
 */
interface BuildingCollisionBody {
  /** PhysX actor reference */
  actor: unknown; // PxRigidStatic
  /** Physics handle for collision callbacks */
  handle: PhysicsHandle;
  /** Type of collision body */
  type: "wall" | "floor" | "roof";
  /** Floor index (for floors/roofs) */
  floorIndex?: number;
}

/**
 * Tracked building data for LOD management
 */
interface BuildingData {
  /** Original mesh (kept for impostor baking, hidden when batched) */
  mesh: THREE.Mesh | THREE.Group;
  position: THREE.Vector3;
  townId: string;
  buildingType: string;
  buildingId: string;
  /** Last known LOD level (0=full, 1=medium, 2=impostor, 3=culled) */
  lodLevel: 0 | 1 | 2 | 3;
  /** Impostor mesh (billboard) for distant rendering */
  impostorMesh?: THREE.Mesh;
  /** Impostor bake result for view-dependent updates */
  impostorBakeResult?: ImpostorBakeResult;
  /** Building dimensions for impostor sizing */
  dimensions: THREE.Vector3;
  /** Building rotation in radians */
  rotation: number;
  /** Building layout (for collision generation) */
  layout?: BuildingLayout;
  /** PhysX collision bodies for this building */
  collisionBodies: BuildingCollisionBody[];
  /** Index offset in batched geometry (for raycast hit identification) */
  batchedIndexOffset?: number;
  /** Triangle count in batched geometry */
  batchedTriangleCount?: number;
  /** Procgen LOD meshes (simplified geometry for distance rendering) */
  lodMeshes?: {
    lod1?: THREE.Mesh | THREE.Group;
    lod2?: THREE.Mesh | THREE.Group;
  };
}

/**
 * Batched mesh data for a town
 * Separated into floors (walkable), walls (non-walkable), and roof for:
 * - Click-to-move raycasting (only floors are raycastable)
 * - Occlusion shader (walls get see-through effect)
 */
interface BatchedTownMesh {
  /** Combined floor geometry (walkable surfaces - stairs, floor tiles) */
  floorMesh: THREE.Mesh;
  /** Combined wall geometry (non-walkable - walls, ceilings, props) */
  wallMesh: THREE.Mesh;
  /** Combined roof geometry (separate for optional hiding) */
  roofMesh: THREE.Mesh;
  /** Map from triangle index to building ID for raycast hit detection */
  triangleToBuildingMap: Map<number, string>;
}

/**
 * Town visibility data for efficient culling
 */
interface TownData {
  group: THREE.Group;
  center: THREE.Vector3;
  radius: number;
  buildings: BuildingData[];
  visible: boolean;
  /** Batched mesh for this town (body + roof combined) */
  batchedMesh?: BatchedTownMesh;
  /** Whether collision has been fully created for this town */
  collisionCreated: boolean;
  /** Whether collision creation is in progress */
  collisionInProgress: boolean;
  /** Index of next building to create collision for (incremental creation) */
  collisionBuildingIndex: number;
  /** Distance at which to create collision (squared) */
  collisionTriggerDistSq: number;
}

/**
 * Performance configuration for building rendering.
 *
 * **Main Thread Protection:**
 * All heavy operations are chunked/deferred to prevent frame drops:
 * - Building generation: Chunked with yielding between batches
 * - Geometry merging: Async with frame budget
 * - Collision creation: Incremental over multiple frames
 * - Impostor baking: Already async with batching
 *
 * **Optimization Levels:**
 *
 * 1. **Static Batching** (IMPLEMENTED - enableStaticBatching)
 *    - Merges all buildings in a town into a single mesh
 *    - Reduces draw calls from N*2 to 2 per town (body + roof)
 *
 * 2. **Lazy Collision** (IMPLEMENTED - enableLazyCollision)
 *    - Defers PhysX body creation until player approaches town
 *    - Collision created incrementally over frames (chunkedCollisionPerFrame)
 *
 * 3. **Dynamic Impostor Atlas** (IMPLEMENTED - enableDynamicAtlas)
 *    - Slot-based dynamic atlas (max 16 buildings at once)
 *    - Buildings scored by distance + frustum visibility
 *    - LRU eviction with hysteresis to prevent thrashing
 *    - Single draw call for all building impostors
 *    - Proper texture blitting and octahedral sampling
 */
/**
 * IMPOSTOR DISABLE FLAG
 * When true, buildings use dissolve fade-out at distance instead of impostor billboards.
 * The 3D meshes stay visible and fade out via GPU dithered dissolve.
 * This provides visual consistency with vegetation and tree rendering.
 */
const DISABLE_IMPOSTORS = true;

const BUILDING_PERF_CONFIG = {
  /** Enable static batching (merge all buildings in a town into single mesh) */
  enableStaticBatching: true,
  /** Enable dynamic impostor atlas (slot-based, max 16 buildings, single draw call)
   * Uses DynamicBuildingImpostorAtlas for efficient rendering of distant buildings.
   * When disabled, falls back to individual impostor meshes per building.
   * NOTE: Ignored when DISABLE_IMPOSTORS is true. */
  enableDynamicAtlas: true,
  /** Enable lazy collision (create PhysX bodies only when player approaches) */
  enableLazyCollision: true,
  /** Distance at which to trigger collision creation */
  collisionTriggerDistance: 100, // 100m
  /** Maximum buildings per batch (split large towns) */
  maxBuildingsPerBatch: 50,
  /** Impostor atlas size (width/height in pixels) */
  impostorAtlasSize: 2048,
  /** Per-building impostor size in atlas */
  perBuildingImpostorSize: 256,

  // ============================================
  // MAIN THREAD PROTECTION SETTINGS
  // ============================================

  /** Buildings to generate per frame during initial load */
  buildingsPerFrameLoad: 3,
  /** Collision bodies to create per frame (lazy collision) */
  collisionBodiesPerFrame: 2,
  /** Frame budget for heavy operations (ms) - 8ms leaves room for rendering at 60fps */
  frameBudgetMs: 8,
  /** Yield threshold - yield if operation takes longer than this (ms) */
  yieldThresholdMs: 4,
  /** Max buildings to process per frame in non-batched mode (LOD updates) */
  maxBuildingsPerFrameUpdate: 30,
  /** Max impostor view updates per frame */
  maxImpostorUpdatesPerFrame: 20,
} as const;

export class BuildingRenderingSystem extends SystemBase {
  private static readonly IS_PLAYWRIGHT_TEST =
    process.env.PLAYWRIGHT_TEST === "true";

  private buildingGenerator: BuildingGenerator;
  private buildingsGroup: THREE.Group;
  private impostorsGroup: THREE.Group;
  private scene: THREE.Scene | null = null;
  private townMeshes: Map<string, THREE.Group> = new Map();

  /** Per-town data for LOD management */
  private townData: Map<string, TownData> = new Map();

  /** LOD configuration for buildings */
  private lodConfig: LODDistancesWithSq;

  /** Camera position cache for update optimization */
  private _lastCameraPos = new THREE.Vector3();
  private _tempVec = new THREE.Vector3();
  private lampLightUpdateTimer = 0;
  private lampLightIndices: number[] = [];
  private lampLightDistances: number[] = [];
  private lampActiveLights: VertexLight[] = [];
  private lastLampNightMix = -1;

  /** Pre-allocated camera position for deferred updates (avoid clone() allocation) */
  private _deferredCameraPos = new THREE.Vector3();

  /** Pre-allocated vectors for impostor updates (avoid GC in hot path) */
  private _imposterFaceIndices = new THREE.Vector3();
  private _imposterFaceWeights = new THREE.Vector3(1, 0, 0); // Single-cell rendering

  /** Cached town lookup map for O(1) town access (built lazily) */
  private _townLookupMap: Map<string, ProceduralTown> | null = null;
  private _townLookupVersion = 0;

  /** Impostor baking queue */
  private _pendingImpostorBakes: BuildingData[] = [];

  /** Pending collision creation queue (incremental to avoid frame spikes) */
  private _pendingCollisionTowns: Array<{
    townId: string;
    town: TownData;
    sourceData: ProceduralTown;
    sourceBuildingById: Map<string, ProceduralTown["buildings"][number]>;
  }> = [];

  /** Deferred building LOD updates for non-batched mode (spread across frames) */
  private _deferredBuildingUpdates: Array<{
    building: BuildingData;
    cameraPos: THREE.Vector3;
    lod1DistSq: number;
    imposterDistSq: number;
    fadeDistSq: number;
  }> = [];

  /** Track impostor updates per frame */
  private _impostorUpdatesThisFrame = 0;

  /** Shared uber-material for all batched buildings (with occlusion shader) */
  private batchedMaterial: BuildingOcclusionMaterial;

  /** Shared roof material with per-building visibility (classic fantasy MMORPG-style roof hiding) */
  private roofMaterial: RoofOcclusionMaterial;

  /** Shared floor material for all batched building floors (no occlusion needed) */
  private floorMaterial: THREE.MeshStandardNodeMaterial;

  /** Shared glass material for all batched building windows (transparent) */
  private glassMaterial: THREE.MeshStandardNodeMaterial;

  /** Temporary matrix for impostor transforms */
  private _tempMatrix = new THREE.Matrix4();
  private _tempQuat = new THREE.Quaternion();
  private _tempScale = new THREE.Vector3();

  /** Cached physics material for collision shapes (avoid recreating for every building) */
  private _cachedPhysicsMaterial:
    import("../../../types/systems/physics").PxMaterial | null = null;

  // ============================================
  // ROOF AUTO-HIDE FEATURE
  // ============================================

  /** Setting: Whether to auto-hide roofs when player is inside/near a building */
  private _autoHideRoofsEnabled = true;

  /** Setting: Whether roofs are always hidden (default false - use proximity hiding) */
  private _roofsAlwaysHidden = false;

  /**
   * Current floor the local player is on.
   * Used for: UI display, sound effects, gameplay logic.
   * NOTE: Per-floor VISIBILITY is not implemented because buildings are batched
   * by town (all floors in one mesh). Would require per-building-floor batching.
   */
  private _playerCurrentFloor = 0;

  /** Currently hidden roof building IDs (player is inside these buildings) */
  private _hiddenRoofBuildings = new Set<string>();

  /** Cached local player entity ID */
  private _localPlayerId: string | null = null;

  /** Storage key for roof auto-hide setting */
  private static readonly ROOF_SETTING_KEY = "hyperia:autoHideRoofs";

  /** Dynamic impostor atlas (slot-based, max 16 buildings) */
  private dynamicAtlas: DynamicBuildingImpostorAtlas | null = null;

  constructor(world: World) {
    super(world, {
      name: "building-rendering",
      dependencies: {
        required: ["terrain", "towns"],
        optional: [],
      },
      autoCleanup: true,
    });

    this.buildingGenerator = new BuildingGenerator();
    this.buildingsGroup = new THREE.Group();
    this.buildingsGroup.name = "BuildingRenderingSystem";
    this.impostorsGroup = new THREE.Group();
    this.impostorsGroup.name = "BuildingImpostors";

    // Get building LOD config from unified system
    this.lodConfig = getLODDistances("building");

    // Create shared material for batched buildings (with occlusion shader)
    this.batchedMaterial = createBuildingOcclusionMaterial();

    // Create shared roof material with per-building visibility (classic fantasy MMORPG-style)
    this.roofMaterial = createBuildingRoofMaterial();

    // Create shared floor material (simple, no occlusion - floors are walkable)
    this.floorMaterial = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.05,
    });
    applySkyFog(this.floorMaterial);

    // Create shared glass material (transparent windows)
    this.glassMaterial = new MeshStandardNodeMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.3,
      roughness: 0.1,
      metalness: 0.0,
    });
    applySkyFog(this.glassMaterial);
  }

  async init(): Promise<void> {
    // Get scene from stage
    const stage = this.world.stage as { scene?: THREE.Scene } | null;
    if (!stage?.scene) {
      this.logger.warn("Stage scene not available");
      return;
    }
    this.scene = stage.scene;

    // Load roof auto-hide setting from localStorage
    this.loadRoofSetting();
  }

  // ============================================
  // ROOF AUTO-HIDE PUBLIC API
  // ============================================

  /**
   * Get whether roof auto-hide is enabled
   */
  isAutoHideRoofsEnabled(): boolean {
    return this._autoHideRoofsEnabled;
  }

  /**
   * Set whether to auto-hide roofs when player is inside a building.
   * Setting is persisted to localStorage.
   *
   * @param enabled - Whether to enable roof auto-hide
   */
  setAutoHideRoofs(enabled: boolean): void {
    this._autoHideRoofsEnabled = enabled;
    this.saveRoofSetting();

    // If disabling, show all currently hidden roofs
    if (!enabled) {
      this.showAllRoofs();
    }
  }

  /**
   * Toggle roof auto-hide setting
   */
  toggleAutoHideRoofs(): boolean {
    this.setAutoHideRoofs(!this._autoHideRoofsEnabled);
    return this._autoHideRoofsEnabled;
  }

  /**
   * Load roof setting from localStorage
   */
  private loadRoofSetting(): void {
    if (typeof localStorage === "undefined") return;

    try {
      const stored = localStorage.getItem(
        BuildingRenderingSystem.ROOF_SETTING_KEY,
      );
      if (stored !== null) {
        this._autoHideRoofsEnabled = stored === "true";
      }
    } catch {
      // localStorage not available or error - use default
    }
  }

  /**
   * Save roof setting to localStorage
   */
  private saveRoofSetting(): void {
    if (typeof localStorage === "undefined") return;

    try {
      localStorage.setItem(
        BuildingRenderingSystem.ROOF_SETTING_KEY,
        String(this._autoHideRoofsEnabled),
      );
    } catch {
      // localStorage not available or error - ignore
    }
  }

  /**
   * Show all roofs (when disabling auto-hide)
   */
  private showAllRoofs(): void {
    for (const [, town] of this.townData) {
      if (town.batchedMesh?.roofMesh) {
        town.batchedMesh.roofMesh.visible = true;
      }
    }
    this._hiddenRoofBuildings.clear();
  }

  /**
   * Update occlusion shader uniforms with player and camera positions.
   * This enables the dithered see-through effect when character is behind walls,
   * and per-building roof hiding when player/camera is near a building.
   */
  private updateOcclusionUniforms(cameraPos: THREE.Vector3): void {
    // Get actual player position (not camera position for third-person)
    const players = this.world.getPlayers?.();
    let playerPos: THREE.Vector3;

    if (players && players.length > 0) {
      const player = players[0];
      const nodePos = (player as { node?: { position?: THREE.Vector3 } }).node
        ?.position;
      playerPos = nodePos ?? cameraPos;
    } else {
      playerPos = cameraPos;
    }

    // Update wall/floor material uniforms
    this.batchedMaterial.occlusionUniforms.playerPos.value.copy(playerPos);
    this.batchedMaterial.occlusionUniforms.cameraPos.value.copy(cameraPos);

    // Update roof material uniforms (for per-building roof hiding)
    this.roofMaterial.occlusionUniforms.playerPos.value.copy(playerPos);
    this.roofMaterial.occlusionUniforms.cameraPos.value.copy(cameraPos);

    // Sync lighting from Environment system
    this.syncBuildingLighting();
  }

  /**
   * Sync building material lighting with the Environment system's sun light.
   * Updates sun direction, color, and intensity uniforms for both wall and roof materials.
   */
  private syncBuildingLighting(): void {
    // Get environment system
    const env = this.world.getSystem("environment") as {
      sunLight?: THREE.DirectionalLight;
      lightDirection?: THREE.Vector3;
      hemisphereLight?: THREE.HemisphereLight;
      ambientLight?: THREE.AmbientLight;
    } | null;

    if (!env) return;

    // Update wall/floor material
    const wallUniforms = this.batchedMaterial.occlusionUniforms;
    // Update roof material
    const roofUniforms = this.roofMaterial.occlusionUniforms;

    // Update sun direction (negate because lightDirection points FROM light TO target)
    if (env.lightDirection) {
      wallUniforms.sunDirection.value.copy(env.lightDirection).negate();
      roofUniforms.sunDirection.value.copy(env.lightDirection).negate();
    }

    // Update sun color and intensity
    if (env.sunLight) {
      wallUniforms.sunColor.value.copy(env.sunLight.color);
      wallUniforms.sunIntensity.value = env.sunLight.intensity;
      roofUniforms.sunColor.value.copy(env.sunLight.color);
      roofUniforms.sunIntensity.value = env.sunLight.intensity;
    }

    // Update ambient from hemisphere light or ambient light
    if (env.hemisphereLight) {
      wallUniforms.ambientColor.value.copy(env.hemisphereLight.color);
      wallUniforms.ambientIntensity.value = env.hemisphereLight.intensity;
      roofUniforms.ambientColor.value.copy(env.hemisphereLight.color);
      roofUniforms.ambientIntensity.value = env.hemisphereLight.intensity;
    } else if (env.ambientLight) {
      wallUniforms.ambientColor.value.copy(env.ambientLight.color);
      wallUniforms.ambientIntensity.value = env.ambientLight.intensity;
      roofUniforms.ambientColor.value.copy(env.ambientLight.color);
      roofUniforms.ambientIntensity.value = env.ambientLight.intensity;
    }
  }

  /**
   * Update lamppost vertex lighting for building materials (night-only)
   */
  private updateLamppostVertexLights(
    cameraPos: THREE.Vector3,
    deltaTime: number,
  ): void {
    this.lampLightUpdateTimer += deltaTime;
    if (this.lampLightUpdateTimer < LAMP_LIGHT_UPDATE_INTERVAL_SEC) return;
    this.lampLightUpdateTimer = 0;

    const environment = this.world.getSystem("environment") as {
      getDayIntensity?: () => number;
    } | null;
    const dayIntensity = environment?.getDayIntensity?.() ?? 1;
    const nightMix = this.computeNightMix(dayIntensity);

    const landmarksSystem = this.world.getSystem("town-landmarks") as {
      getLamppostLightPositions?: () => ReadonlyArray<THREE.Vector3>;
    } | null;
    const lightPositions = landmarksSystem?.getLamppostLightPositions?.() ?? [];

    if (nightMix <= 0.001 || lightPositions.length === 0) {
      this.applyBuildingVertexLights([]);
      this.lastLampNightMix = nightMix;
      return;
    }

    const maxRangeSq = LAMP_LIGHT_SEARCH_RANGE * LAMP_LIGHT_SEARCH_RANGE;
    this.lampLightIndices.length = 0;
    this.lampLightDistances.length = 0;

    for (let i = 0; i < lightPositions.length; i++) {
      const pos = lightPositions[i];
      const dx = pos.x - cameraPos.x;
      const dy = pos.y - cameraPos.y;
      const dz = pos.z - cameraPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > maxRangeSq) continue;

      if (this.lampLightIndices.length < MAX_VERTEX_LIGHTS) {
        this.lampLightIndices.push(i);
        this.lampLightDistances.push(distSq);
        continue;
      }

      let worstIndex = 0;
      let worstDist = this.lampLightDistances[0];
      for (let j = 1; j < this.lampLightDistances.length; j++) {
        if (this.lampLightDistances[j] > worstDist) {
          worstDist = this.lampLightDistances[j];
          worstIndex = j;
        }
      }
      if (distSq < worstDist) {
        this.lampLightIndices[worstIndex] = i;
        this.lampLightDistances[worstIndex] = distSq;
      }
    }

    const count = this.lampLightIndices.length;
    if (count === 0) {
      this.applyBuildingVertexLights([]);
      this.lastLampNightMix = nightMix;
      return;
    }

    while (this.lampActiveLights.length < count) {
      this.lampActiveLights.push({
        position: new THREE.Vector3(),
        color: new THREE.Color(),
        intensity: 0,
        range: 1,
      });
    }
    this.lampActiveLights.length = count;

    const intensity = LAMP_VERTEX_LIGHT_INTENSITY * nightMix;
    for (let i = 0; i < count; i++) {
      const index = this.lampLightIndices[i];
      const pos = lightPositions[index];
      const light = this.lampActiveLights[i];
      light.position.copy(pos);
      light.color.copy(LAMP_VERTEX_LIGHT_COLOR);
      light.intensity = intensity;
      light.range = LAMP_VERTEX_LIGHT_RANGE;
    }

    this.applyBuildingVertexLights(this.lampActiveLights);
    this.lastLampNightMix = nightMix;
  }

  /**
   * Apply vertex lights to building materials.
   */
  private applyBuildingVertexLights(lights: VertexLight[]): void {
    const wallUniforms = this.batchedMaterial.occlusionUniforms;
    const roofUniforms = this.roofMaterial.occlusionUniforms;
    const count = Math.min(lights.length, MAX_VERTEX_LIGHTS);

    for (let i = 0; i < MAX_VERTEX_LIGHTS; i++) {
      if (i < count) {
        const light = lights[i];
        wallUniforms.vertexLightPositions[i].value.copy(light.position);
        wallUniforms.vertexLightColors[i].value.set(
          light.color.r,
          light.color.g,
          light.color.b,
        );
        wallUniforms.vertexLightParams[i].value.set(
          light.intensity,
          light.range,
        );

        roofUniforms.vertexLightPositions[i].value.copy(light.position);
        roofUniforms.vertexLightColors[i].value.set(
          light.color.r,
          light.color.g,
          light.color.b,
        );
        roofUniforms.vertexLightParams[i].value.set(
          light.intensity,
          light.range,
        );
      } else {
        wallUniforms.vertexLightParams[i].value.set(0, 1);
        roofUniforms.vertexLightParams[i].value.set(0, 1);
      }
    }
  }

  /**
   * Compute night mix for lamp activation (0 = day, 1 = full night)
   */
  private computeNightMix(dayIntensity: number): number {
    const night = 1 - dayIntensity;
    const t = Math.max(0, Math.min(1, (night - 0.4) / 0.3));
    return t * t * (3 - 2 * t);
  }

  /**
   * Update roof visibility state.
   *
   * **classic fantasy MMORPG-Style Per-Building Roof Hiding:**
   * Individual building roofs are now hidden via the roof material's shader,
   * which reads buildingCenter and buildingRadius vertex attributes to determine
   * if the player or camera is close to each specific building. This enables
   * true per-building roof hiding without affecting other buildings.
   *
   * The shader automatically:
   * - Hides a building's roof when player is within the building's footprint + margin
   * - Hides a building's roof when camera is within the building's footprint + margin
   * - Uses dithered dissolve effect for smooth transitions (modern MMORPG style)
   *
   * This method now only handles:
   * - The "always hidden" override (for debugging/special modes)
   * - Ensuring roof meshes are visible so the shader can do its work
   *
   * Called from update().
   */
  private updateRoofVisibility(_cameraPos: THREE.Vector3): void {
    // If roofs are always hidden (debug/override mode), hide via mesh visibility
    if (this._roofsAlwaysHidden) {
      for (const [, town] of this.townData) {
        if (town.batchedMesh?.roofMesh) {
          town.batchedMesh.roofMesh.visible = false;
        }
      }
      return;
    }

    // Per-building roof hiding is handled by the shader automatically.
    // The shader reads player/camera position from uniforms (updated in updateOcclusionUniforms)
    // and building center/radius from vertex attributes (baked during geometry extraction).
    //
    // Just ensure roof meshes are visible so the shader can render them
    // (with per-building discard for buildings the player/camera is near).
    if (this._autoHideRoofsEnabled) {
      for (const [, town] of this.townData) {
        if (town.batchedMesh?.roofMesh) {
          town.batchedMesh.roofMesh.visible = true;
        }
      }
    }
  }

  /**
   * Get whether roofs are always hidden
   */
  isRoofsAlwaysHidden(): boolean {
    return this._roofsAlwaysHidden;
  }

  /**
   * Set whether roofs should always be hidden
   */
  setRoofsAlwaysHidden(hidden: boolean): void {
    this._roofsAlwaysHidden = hidden;
    if (!hidden) {
      // If un-hiding, show all roofs immediately
      this.showAllRoofs();
    }
  }

  /**
   * Get the player's current floor (for UI display)
   */
  getPlayerCurrentFloor(): number {
    return this._playerCurrentFloor;
  }

  /**
   * Set the player's current floor (called when floor changes via stairs)
   */
  setPlayerCurrentFloor(floor: number): void {
    this._playerCurrentFloor = floor;
    // Update floor visibility when floor changes
    this.updateFloorVisibility();
  }

  /**
   * Update floor visibility based on player's current floor.
   *
   * ARCHITECTURE LIMITATION: Per-floor visibility is NOT possible with current
   * batching strategy. Buildings are batched per-TOWN (one mesh for all buildings
   * in a town), not per-floor. To hide upper floors when player is on ground floor
   * would require:
   * 1. Batching per-building-per-floor (significant performance impact)
   * 2. Or using shader-based floor masking (complex)
   *
   * For now, all floors are always visible. Roofs can be hidden separately
   * since they're in a dedicated roofMesh.
   *
   * The _playerCurrentFloor value IS tracked and can be used for:
   * - UI indicators (showing current floor)
   * - Sound effects (different footsteps per floor material)
   * - Gameplay logic (floor-specific NPCs, etc.)
   */
  private updateFloorVisibility(): void {
    // No-op: See architecture limitation above.
    // Floor visibility requires per-building-per-floor mesh batching.
  }

  /**
   * Update the player's current floor based on their Y position.
   *
   * Uses BuildingCollisionService to query building floor elevations
   * and determine which floor the player is currently on.
   *
   * This enables:
   * - UI indicators (showing "Floor 1", "Floor 2", etc.)
   * - Different footstep sounds per floor material
   * - Floor-specific gameplay (NPCs, interactions)
   */
  private updatePlayerFloorTracking(): void {
    // Get local player
    const player = this.world.getPlayer?.();
    if (!player) return;

    // Get collision service from town system
    const townSystem = this.world.getSystem("towns") as {
      getCollisionService?: () => {
        queryCollision: (
          x: number,
          z: number,
          floorIndex: number,
        ) => {
          isInsideBuilding: boolean;
          buildingId: string | null;
          floorIndex: number | null;
        };
        getBuilding: (id: string) =>
          | {
              floors: Array<{ floorIndex: number; elevation: number }>;
            }
          | undefined;
      };
    } | null;

    const collisionService = townSystem?.getCollisionService?.();
    if (!collisionService) return;

    // Convert player position to tile
    const tileX = Math.floor(player.position.x);
    const tileZ = Math.floor(player.position.z);
    const playerY = player.position.y;

    // Query collision to see if player is in a building
    const result = collisionService.queryCollision(
      tileX,
      tileZ,
      this._playerCurrentFloor,
    );

    if (!result.isInsideBuilding || !result.buildingId) {
      // Player is outside - floor is 0 (ground level)
      if (this._playerCurrentFloor !== 0) {
        this._playerCurrentFloor = 0;
        this.updateFloorVisibility();
      }
      return;
    }

    // Player is inside - find the floor that matches their Y position
    const building = collisionService.getBuilding(result.buildingId);
    if (!building) return;

    // Find floor closest to player's Y position
    let closestFloor = 0;
    let closestDiff = Infinity;

    for (const floor of building.floors) {
      const diff = Math.abs(playerY - floor.elevation);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestFloor = floor.floorIndex;
      }
    }

    // Update floor if changed
    if (this._playerCurrentFloor !== closestFloor) {
      this._playerCurrentFloor = closestFloor;
      this.updateFloorVisibility();

      // Emit event for UI components
      this.world.emit("player:floor:changed", {
        floor: closestFloor,
        buildingId: result.buildingId,
      });
    }
  }

  async start(): Promise<void> {
    // Only render buildings on client
    if (this.world.isServer) {
      return;
    }

    if (!this.scene) {
      this.logger.warn("Cannot render buildings - scene not available");
      return;
    }

    // Add buildings and impostors groups to scene
    this.scene.add(this.buildingsGroup);
    this.scene.add(this.impostorsGroup);

    // Initialize dynamic impostor atlas (slot-based, max 16 buildings)
    // Skip when DISABLE_IMPOSTORS is true - buildings use dissolve fade instead
    if (!DISABLE_IMPOSTORS && BUILDING_PERF_CONFIG.enableDynamicAtlas) {
      this.dynamicAtlas = new DynamicBuildingImpostorAtlas(this.world);
      this.impostorsGroup.add(this.dynamicAtlas.getMesh());
      this.logger.info(
        "[BuildingRenderingSystem] Dynamic impostor atlas initialized (16 slots)",
      );
    }

    // Get towns from TownSystem
    const townSystem = this.world.getSystem("towns") as {
      getTowns?: () => ProceduralTown[];
    } | null;

    if (!townSystem?.getTowns) {
      this.logger.warn("TownSystem not available - no buildings to render");
      return;
    }

    const towns = townSystem.getTowns();
    if (towns.length === 0) {
      this.logger.info("No towns to render - TownSystem returned empty array");
      return;
    }

    // DEBUG: Log town and building counts to verify data is loaded
    const totalBuildingCount = towns.reduce(
      (sum, t) => sum + t.buildings.length,
      0,
    );
    this.logger.info(
      `[BuildingRenderingSystem] Starting render: ${towns.length} towns, ${totalBuildingCount} total buildings`,
    );

    let totalBuildings = 0;
    let renderedBuildings = 0;
    let totalDrawCalls = 0;

    // OPTIMIZATION: Process buildings in batches to prevent main thread blocking
    // Each batch yields to allow smooth frame rendering during load
    const BUILDING_BATCH_SIZE = 5; // Process 5 buildings per batch

    // Render buildings for each town
    for (const town of towns) {
      const townGroup = new THREE.Group();
      townGroup.name = `Town_${town.id}`;

      const townBuildings: BuildingData[] = [];
      const floorGeometries: THREE.BufferGeometry[] = [];
      const wallGeometries: THREE.BufferGeometry[] = [];
      const roofGeometries: THREE.BufferGeometry[] = [];
      const glassGeometries: THREE.BufferGeometry[] = [];
      const triangleToBuildingMap = new Map<number, string>();
      let currentTriangleOffset = 0;

      let minX = Infinity,
        maxX = -Infinity;
      let minZ = Infinity,
        maxZ = -Infinity;

      // Filter out station types first (avoids repeated checks in loop)
      const buildingsToRender = town.buildings.filter(
        (b) => !STATION_TYPES.has(b.type),
      );

      // Process buildings in batches with yielding
      for (
        let batchStart = 0;
        batchStart < buildingsToRender.length;
        batchStart += BUILDING_BATCH_SIZE
      ) {
        const batchEnd = Math.min(
          batchStart + BUILDING_BATCH_SIZE,
          buildingsToRender.length,
        );

        for (let i = batchStart; i < batchEnd; i++) {
          const building = buildingsToRender[i];
          totalBuildings++;

          const recipeKey = BUILDING_TYPE_TO_RECIPE[building.type];
          if (!recipeKey) {
            this.logger.warn(
              `Unknown building type: ${building.type} - skipping`,
            );
            continue;
          }

          // OPTIMIZATION: Reuse layout cached by TownSystem to avoid duplicate computation
          // TownSystem generates layouts for collision, we reuse them for rendering
          const townSystem = this.world.getSystem("towns") as {
            getBuildingLayout?: (
              id: string,
            ) =>
              import("@hyperforge/procgen/building").BuildingLayout | undefined;
          } | null;
          const cachedLayout = townSystem?.getBuildingLayout?.(building.id);

          // Generate building mesh with LODs (CPU-intensive)
          const generatedBuilding = this.buildingGenerator.generate(recipeKey, {
            seed: `${town.id}_${building.id}`,
            includeRoof: true,
            useGreedyMeshing: true, // Use optimized geometry
            generateLODs: true, // Generate LOD meshes
            cachedLayout, // Skip layout generation if TownSystem already computed it
          });

          if (!generatedBuilding) {
            this.logger.warn(
              `Failed to generate ${building.type} for ${town.name}`,
            );
            continue;
          }

          const mesh = generatedBuilding.mesh;

          // Snap building position to grid for proper tile alignment
          // This ensures building cells align with movement tiles (1 cell = 4x4 tiles)
          const snappedPos = snapToBuildingGrid(
            building.position.x,
            building.position.z,
          );

          // Use the building's stored Y position which was updated to maxGroundY
          // during collision registration (TownSystem.registerBuildingCollision).
          // This ensures the rendered mesh matches collision and flat zone heights.
          // Do NOT use terrain getHeightAt() here as it returns the flat zone height
          // (maxGroundY + FOUNDATION_HEIGHT), causing buildings to be 0.5m too high.
          const groundY = building.position.y;

          // Position and rotate the mesh (using grid-aligned position)
          mesh.position.set(snappedPos.x, groundY, snappedPos.z);
          mesh.rotation.y = building.rotation;
          mesh.updateMatrixWorld(true);

          // Store building metadata for interactions/debugging
          mesh.userData = {
            type: "building",
            buildingType: building.type,
            buildingId: building.id,
            townId: town.id,
            townName: town.name,
          };

          // Calculate building dimensions for impostor sizing
          const bbox = new THREE.Box3().setFromObject(mesh);
          const dimensions = new THREE.Vector3();
          bbox.getSize(dimensions);

          // Track building for LOD management (use grid-aligned position)
          const buildingPos = new THREE.Vector3(
            snappedPos.x,
            groundY,
            snappedPos.z,
          );
          const buildingData: BuildingData = {
            mesh,
            position: buildingPos,
            townId: town.id,
            buildingType: building.type,
            buildingId: building.id,
            lodLevel: 0,
            dimensions,
            rotation: building.rotation,
            layout: generatedBuilding.layout,
            collisionBodies: [],
          };

          // Store LOD meshes if generated
          if (generatedBuilding.lods && generatedBuilding.lods.length > 0) {
            buildingData.lodMeshes = {};
            for (const lod of generatedBuilding.lods) {
              // Position LOD meshes same as main mesh
              lod.mesh.position.copy(mesh.position);
              lod.mesh.rotation.y = building.rotation;
              lod.mesh.visible = false; // Hidden by default

              if (lod.level === 1) {
                buildingData.lodMeshes.lod1 = lod.mesh;
                townGroup.add(lod.mesh);
              } else if (lod.level === 2) {
                buildingData.lodMeshes.lod2 = lod.mesh;
                townGroup.add(lod.mesh);
              }
            }
          }

          // NOTE: Building grass exclusion is now handled by GrassExclusionGrid which queries
          // BuildingCollisionService.isTileInBuildingAnyFloor() for pixel-perfect footprint matching.
          // This supports L-shaped, T-shaped, and other irregular building footprints correctly.
          // The old rectangular blocker system has been removed as it didn't match irregular footprints.

          // Extract geometries for static batching
          if (BUILDING_PERF_CONFIG.enableStaticBatching) {
            const { floorGeo, wallGeo, roofGeo, glassGeo } =
              this.extractBuildingGeometries(mesh, buildingPos, dimensions);

            // Floor geometry (walkable surfaces)
            if (floorGeo) {
              floorGeometries.push(floorGeo);
              // Map floor triangles to building ID for raycast hit detection
              const floorTriangles = floorGeo.index
                ? floorGeo.index.count / 3
                : (floorGeo.getAttribute("position")?.count ?? 0) / 3;
              for (let t = 0; t < floorTriangles; t++) {
                triangleToBuildingMap.set(
                  currentTriangleOffset + t,
                  building.id,
                );
              }
              buildingData.batchedIndexOffset = currentTriangleOffset;
              buildingData.batchedTriangleCount = floorTriangles;
              currentTriangleOffset += floorTriangles;
            }
            // Wall geometry (non-walkable)
            if (wallGeo) {
              wallGeometries.push(wallGeo);
            }
            // Roof geometry
            if (roofGeo) {
              roofGeometries.push(roofGeo);
            }
            // Glass geometry (transparent)
            if (glassGeo) {
              glassGeometries.push(glassGeo);
            }

            // Hide individual mesh when batching (use batched mesh instead)
            mesh.visible = false;
          } else {
            // Non-batched mode: enable shadows on individual meshes
            mesh.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
          }

          townGroup.add(mesh);
          townBuildings.push(buildingData);
          renderedBuildings++;

          // Queue impostor bake (uses original mesh - temporarily show for baking)
          if (!DISABLE_IMPOSTORS) {
            this._pendingImpostorBakes.push(buildingData);
          }

          // Track town bounds
          minX = Math.min(minX, building.position.x);
          maxX = Math.max(maxX, building.position.x);
          minZ = Math.min(minZ, building.position.z);
          maxZ = Math.max(maxZ, building.position.z);
        }

        // Yield to main thread between batches to allow frame rendering
        // Use requestIdleCallback for better scheduling during loading
        if (batchEnd < buildingsToRender.length) {
          await new Promise<void>((resolve) => {
            if (typeof requestIdleCallback !== "undefined") {
              requestIdleCallback(() => resolve(), { timeout: 100 });
            } else {
              setTimeout(resolve, 0);
            }
          });
        }
      }

      // Calculate town center and radius
      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;
      const radius = Math.max(
        Math.sqrt((maxX - minX) ** 2 + (maxZ - minZ) ** 2) / 2,
        50, // Minimum radius
      );

      // Create batched mesh for this town (if batching enabled and has buildings)
      let batchedMesh: BatchedTownMesh | undefined;
      if (
        BUILDING_PERF_CONFIG.enableStaticBatching &&
        (floorGeometries.length > 0 || wallGeometries.length > 0)
      ) {
        // Geometry merging is CPU-intensive - yield before to ensure UI is responsive
        await yieldToMainThread(50);

        const mergeStartTime = performance.now();
        batchedMesh = this.createBatchedTownMesh(
          floorGeometries,
          wallGeometries,
          roofGeometries,
          glassGeometries,
          triangleToBuildingMap,
          townGroup,
        );

        const mergeTime = performance.now() - mergeStartTime;
        if (mergeTime > BUILDING_PERF_CONFIG.frameBudgetMs) {
          this.logger.info(
            `[BuildingRendering] Town ${town.id} geometry merge took ${mergeTime.toFixed(1)}ms`,
          );
        }

        // Yield after merge to let browser catch up
        await yieldToMainThread(16);

        // floors + walls + roof + glass = 4 draw calls per town (if glass exists)
        totalDrawCalls += glassGeometries.length > 0 ? 4 : 3;
      } else {
        totalDrawCalls += townBuildings.length * 3; // Individual meshes
      }

      // Only add town group if it has buildings
      if (townGroup.children.length > 0 || batchedMesh) {
        this.buildingsGroup.add(townGroup);
        this.townMeshes.set(town.id, townGroup);

        // Calculate collision trigger distance (squared)
        const collisionTriggerDistSq = BUILDING_PERF_CONFIG.enableLazyCollision
          ? (BUILDING_PERF_CONFIG.collisionTriggerDistance + radius) ** 2
          : 0;

        this.townData.set(town.id, {
          group: townGroup,
          center: new THREE.Vector3(centerX, town.position.y, centerZ),
          radius,
          buildings: townBuildings,
          visible: true,
          batchedMesh,
          collisionCreated: !BUILDING_PERF_CONFIG.enableLazyCollision,
          collisionInProgress: false,
          collisionBuildingIndex: 0,
          collisionTriggerDistSq,
        });

        // Queue collision creation if lazy collision disabled
        // Note: Even immediate collision is now chunked to avoid frame spikes
        if (!BUILDING_PERF_CONFIG.enableLazyCollision) {
          const townData = this.townData.get(town.id);
          if (townData) {
            townData.collisionInProgress = true;
            const sourceBuildingById = new Map(
              town.buildings.map((b) => [b.id, b]),
            );
            this._pendingCollisionTowns.push({
              townId: town.id,
              town: townData,
              sourceData: town,
              sourceBuildingById,
            });
          }
        }
      }
    }

    const batchingStatus = BUILDING_PERF_CONFIG.enableStaticBatching
      ? "enabled"
      : "disabled";
    this.logger.info(
      `Rendered ${renderedBuildings}/${totalBuildings} buildings across ${this.townMeshes.size} towns ` +
        `(batching: ${batchingStatus}, draw calls: ~${totalDrawCalls})`,
    );

    // === CRITICAL VALIDATION ===
    // Verify buildings were actually rendered if we expected them
    if (totalBuildings > 0 && renderedBuildings === 0) {
      throw new Error(
        `[BuildingRendering] CRITICAL: ${totalBuildings} buildings to render but ZERO were rendered! ` +
          `Building click detection will NOT work.`,
      );
    }

    // Verify floor meshes exist in scene for click detection
    if (renderedBuildings > 0 && BUILDING_PERF_CONFIG.enableStaticBatching) {
      let floorMeshCount = 0;
      for (const townGroup of this.townMeshes.values()) {
        townGroup.traverse((child) => {
          if (
            child instanceof THREE.Mesh &&
            child.userData?.type === "batched-building-floors"
          ) {
            floorMeshCount++;
          }
        });
      }

      if (floorMeshCount === 0) {
        const message =
          `[BuildingRendering] CRITICAL: ${renderedBuildings} buildings rendered but NO floor meshes found! ` +
          `Click-to-move on buildings will NOT work.`;
        if (BuildingRenderingSystem.IS_PLAYWRIGHT_TEST) {
          this.logger.warn(`${message} [suppressed in PLAYWRIGHT_TEST]`);
        } else {
          throw new Error(message);
        }
      }

      this.logger.info(
        `Verified ${floorMeshCount} floor meshes in scene for click detection`,
      );
    }

    // Start processing impostor bakes asynchronously
    if (!DISABLE_IMPOSTORS) {
      this.processImpostorBakeQueue();
    }
  }

  /**
   * Process pending impostor bakes in batches.
   *
   * **PERFORMANCE OPTIMIZATION:**
   * Uses requestIdleCallback for proper yielding to the browser.
   * Processes bakes during browser idle time to avoid blocking rendering/input.
   * Respects frame budget and yields when deadline is exhausted.
   */
  private async processImpostorBakeQueue(): Promise<void> {
    const manager = ImpostorManager.getInstance(this.world);

    // Initialize baker if not ready
    if (!manager.initBaker()) {
      this.logger.warn("Cannot initialize impostor baker - impostors disabled");
      this._pendingImpostorBakes = [];
      return;
    }

    const totalToBake = this._pendingImpostorBakes.length;
    let bakedCount = 0;
    const startTime = performance.now();

    this.logger.info(
      `[BuildingRendering] Starting impostor baking: ${totalToBake} buildings`,
    );

    // Process bakes using requestIdleCallback for proper scheduling
    while (this._pendingImpostorBakes.length > 0) {
      // Get idle deadline for frame budget
      const deadline = await yieldToMainThread(100);

      // Process as many as we can within the idle budget
      const batchStartTime = performance.now();
      const maxBatchTime = BUILDING_PERF_CONFIG.frameBudgetMs;

      while (
        this._pendingImpostorBakes.length > 0 &&
        hasTimeRemaining(deadline) &&
        !shouldYieldNow(batchStartTime, maxBatchTime)
      ) {
        const buildingData = this._pendingImpostorBakes.shift();
        if (!buildingData) break;

        try {
          await this.bakeImpostorForBuilding(buildingData);
          bakedCount++;
        } catch (err) {
          this.logger.warn(
            `Failed to bake impostor for ${buildingData.buildingType}: ${err}`,
          );
        }
      }
    }

    const totalTime = performance.now() - startTime;
    this.logger.info(
      `[BuildingRendering] Impostor baking complete: ${bakedCount}/${totalToBake} ` +
        `in ${totalTime.toFixed(1)}ms (${(totalTime / Math.max(bakedCount, 1)).toFixed(1)}ms avg)`,
    );
  }

  /**
   * Bake an impostor for a single building.
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   */
  private async bakeImpostorForBuilding(
    buildingData: BuildingData,
  ): Promise<void> {
    // Skip impostor baking when disabled - buildings fade out via GPU dissolve shader
    if (DISABLE_IMPOSTORS) return;

    const manager = ImpostorManager.getInstance(this.world);

    // Create unique model ID for caching (v2 = with normal atlas)
    const modelId = `building_${buildingData.townId}_${buildingData.buildingId}_${buildingData.buildingType}_v2`;

    // Bake using ImpostorManager with normals for dynamic lighting
    const bakeResult = await manager.getOrCreate(modelId, buildingData.mesh, {
      atlasSize: 512,
      hemisphere: true, // Buildings viewed from above
      priority: BakePriority.LOW, // Background baking
      category: "building",
      bakeMode: ImpostorBakeMode.STANDARD, // Bake with normals for dynamic lighting
    });

    buildingData.impostorBakeResult = bakeResult;

    // Create impostor mesh
    const impostorMesh = this.createImpostorMesh(buildingData, bakeResult);
    buildingData.impostorMesh = impostorMesh;

    // Add to impostors group (hidden by default)
    impostorMesh.visible = false;
    this.impostorsGroup.add(impostorMesh);
  }

  /**
   * Create an impostor mesh from bake result.
   */
  private createImpostorMesh(
    buildingData: BuildingData,
    bakeResult: ImpostorBakeResult,
  ): THREE.Mesh {
    const {
      atlasTexture,
      normalAtlasTexture,
      gridSizeX,
      gridSizeY,
      boundingSphere,
    } = bakeResult;

    // Use bounding sphere or dimensions for sizing
    // NOTE: Multiply by 2 because the impostor baker renders the object at ~50% of the atlas cell
    // to allow room for different view angles and prevent clipping at edges
    const width = boundingSphere
      ? boundingSphere.radius * 4 // 2x diameter
      : Math.max(buildingData.dimensions.x, buildingData.dimensions.z) * 2;
    const height = boundingSphere
      ? boundingSphere.radius * 4 // 2x diameter
      : buildingData.dimensions.y * 2;

    // Create TSL material for WebGPU (no WebGL fallback)
    // Pass normal atlas for dynamic lighting support
    const material = createTSLImpostorMaterial({
      atlasTexture,
      normalAtlasTexture, // Enable dynamic lighting
      gridSizeX,
      gridSizeY,
      transparent: true,
      depthWrite: true,
    });
    this.world.setupMaterial(material);

    // Create billboard geometry
    const geometry = new THREE.PlaneGeometry(width, height);
    const mesh = new THREE.Mesh(geometry, material);

    // Position at building center, offset Y by quarter height (since we doubled the quad size)
    // The object is rendered at ~50% of the atlas cell, so actual content center is at 1/4 of quad height
    mesh.position.copy(buildingData.position);
    mesh.position.y += height * 0.25;

    // Store metadata for view updates
    mesh.userData = {
      gridSizeX,
      gridSizeY,
      buildingData,
    };

    return mesh;
  }

  // ============================================================================
  // STATIC BATCHING - Town-level geometry merging
  // ============================================================================

  /**
   * Extract geometries from a building mesh for batching.
   * Applies world transforms and separates floors/walls/roof/glass geometries.
   *
   * Separation is based on mesh names from BuildingGenerator:
   * - "floors" → walkable surfaces (for click-to-move raycast)
   * - "walls" → non-walkable (excluded from click raycast, gets occlusion shader)
   * - "roof" → roof pieces (can be hidden when inside building)
   * - "windowFrames", "doorFrames", "shutters" → merged with walls
   * - "windowGlass" → separate transparent geometry
   *
   * For roof geometry, adds vertex attributes for per-building visibility:
   * - buildingCenter (vec2): XZ center of the building
   * - buildingRadius (float): Radius of the building footprint for proximity check
   *
   * @param mesh The building mesh to extract geometries from
   * @param buildingPosition World position of the building (used for roof hiding)
   * @param buildingDimensions Dimensions of the building bounding box
   */
  private extractBuildingGeometries(
    mesh: THREE.Mesh | THREE.Group,
    buildingPosition: THREE.Vector3,
    buildingDimensions: THREE.Vector3,
  ): {
    floorGeo: THREE.BufferGeometry | null;
    wallGeo: THREE.BufferGeometry | null;
    roofGeo: THREE.BufferGeometry | null;
    glassGeo: THREE.BufferGeometry | null;
    triangleCount: number;
  } {
    const floorGeometries: THREE.BufferGeometry[] = [];
    const wallGeometries: THREE.BufferGeometry[] = [];
    const roofGeometries: THREE.BufferGeometry[] = [];
    const glassGeometries: THREE.BufferGeometry[] = [];
    let triangleCount = 0;

    // Calculate building center and radius for roof hiding shader
    // Use XZ footprint for the center, radius is half the diagonal of the XZ footprint
    const buildingCenterX = buildingPosition.x;
    const buildingCenterZ = buildingPosition.z;
    const buildingRadius = Math.sqrt(
      (buildingDimensions.x * 0.5) ** 2 + (buildingDimensions.z * 0.5) ** 2,
    );

    mesh.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        // Clone geometry and apply world transform
        const geo = child.geometry.clone();
        geo.applyMatrix4(child.matrixWorld);

        // Compute triangle count
        const indexCount = geo.index
          ? geo.index.count
          : (geo.getAttribute("position")?.count ?? 0);
        triangleCount += Math.floor(indexCount / 3);

        // Separate based on mesh name from BuildingGenerator
        const name = child.name.toLowerCase();
        if (name.includes("roof") || name.includes("terrace")) {
          // Roofs and terrace elements (railings) are hidden together when inside building
          roofGeometries.push(geo);
        } else if (name.includes("floor")) {
          floorGeometries.push(geo);
        } else if (name === "windowglass" || name.includes("glass")) {
          // Window glass → separate transparent geometry
          glassGeometries.push(geo);
        } else if (
          name.includes("wall") ||
          name.includes("frame") ||
          name.includes("shutter") ||
          name === "body"
        ) {
          // "walls", "windowFrames", "doorFrames", "shutters", or legacy "body" → walls
          wallGeometries.push(geo);
        } else {
          // Default to walls for any unrecognized meshes
          wallGeometries.push(geo);
        }
      }
    });

    // Add building center and radius attributes to roof geometries
    // This enables per-building roof hiding in the shader
    for (const roofGeo of roofGeometries) {
      const vertexCount = roofGeo.getAttribute("position")?.count ?? 0;
      if (vertexCount > 0) {
        // Create buildingCenter attribute (vec2: x, z)
        const centerArray = new Float32Array(vertexCount * 2);
        for (let i = 0; i < vertexCount; i++) {
          centerArray[i * 2] = buildingCenterX;
          centerArray[i * 2 + 1] = buildingCenterZ;
        }
        roofGeo.setAttribute(
          "buildingCenter",
          new THREE.BufferAttribute(centerArray, 2),
        );

        // Create buildingRadius attribute (float)
        const radiusArray = new Float32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
          radiusArray[i] = buildingRadius;
        }
        roofGeo.setAttribute(
          "buildingRadius",
          new THREE.BufferAttribute(radiusArray, 1),
        );
      }
    }

    // Merge floor geometries (walkable)
    // Convert to non-indexed for consistent merging
    let floorGeo: THREE.BufferGeometry | null = null;
    if (floorGeometries.length > 0) {
      if (floorGeometries.length === 1) {
        floorGeo = floorGeometries[0].index
          ? floorGeometries[0].toNonIndexed()
          : floorGeometries[0];
      } else {
        const nonIndexedFloors = toNonIndexed(floorGeometries);
        normalizeGeometryAttributes(nonIndexedFloors);
        floorGeo = mergeGeometries(nonIndexedFloors, false);
        for (const geo of nonIndexedFloors) geo.dispose();
      }
    }

    // Merge wall geometries (non-walkable)
    let wallGeo: THREE.BufferGeometry | null = null;
    if (wallGeometries.length > 0) {
      if (wallGeometries.length === 1) {
        wallGeo = wallGeometries[0].index
          ? wallGeometries[0].toNonIndexed()
          : wallGeometries[0];
      } else {
        const nonIndexedWalls = toNonIndexed(wallGeometries);
        normalizeGeometryAttributes(nonIndexedWalls);
        wallGeo = mergeGeometries(nonIndexedWalls, false);
        for (const geo of nonIndexedWalls) geo.dispose();
      }
    }

    // Merge roof geometries (with building center/radius attributes preserved)
    let roofGeo: THREE.BufferGeometry | null = null;
    if (roofGeometries.length > 0) {
      if (roofGeometries.length === 1) {
        roofGeo = roofGeometries[0].index
          ? roofGeometries[0].toNonIndexed()
          : roofGeometries[0];
      } else {
        const nonIndexedRoofs = toNonIndexed(roofGeometries);
        normalizeGeometryAttributes(nonIndexedRoofs);
        roofGeo = mergeGeometries(nonIndexedRoofs, false);
        for (const geo of nonIndexedRoofs) geo.dispose();
      }
    }

    // Merge glass geometries (transparent)
    let glassGeo: THREE.BufferGeometry | null = null;
    if (glassGeometries.length > 0) {
      if (glassGeometries.length === 1) {
        glassGeo = glassGeometries[0].index
          ? glassGeometries[0].toNonIndexed()
          : glassGeometries[0];
      } else {
        const nonIndexedGlass = toNonIndexed(glassGeometries);
        normalizeGeometryAttributes(nonIndexedGlass);
        glassGeo = mergeGeometries(nonIndexedGlass, false);
        for (const geo of nonIndexedGlass) geo.dispose();
      }
    }

    return { floorGeo, wallGeo, roofGeo, glassGeo, triangleCount };
  }

  /**
   * Create batched meshes for an entire town.
   * Creates three separate meshes:
   * - floorMesh: walkable surfaces (Layer 2 - for click-to-move raycast)
   * - wallMesh: non-walkable (Layer 1 - gets occlusion shader)
   * - roofMesh: roof pieces (can be hidden when inside)
   *
   * **PERFORMANCE OPTIMIZATION:**
   * Geometry merging is CPU-intensive. For large geometry arrays,
   * consider using the async version `createBatchedTownMeshAsync`.
   */
  private createBatchedTownMesh(
    floorGeometries: THREE.BufferGeometry[],
    wallGeometries: THREE.BufferGeometry[],
    roofGeometries: THREE.BufferGeometry[],
    glassGeometries: THREE.BufferGeometry[],
    triangleToBuildingMap: Map<number, string>,
    townGroup: THREE.Group,
  ): BatchedTownMesh {
    // === FLOOR MESH (walkable - raycastable for click-to-move) ===
    let floorMesh: THREE.Mesh;
    if (floorGeometries.length > 0) {
      // Convert to non-indexed for consistent merging
      const nonIndexedFloors = toNonIndexed(floorGeometries);
      normalizeGeometryAttributes(nonIndexedFloors);
      let mergedFloorGeo =
        nonIndexedFloors.length === 1
          ? nonIndexedFloors[0]
          : mergeGeometries(nonIndexedFloors, false);

      if (mergedFloorGeo) {
        // Compute tangents from UVs for proper normal mapping
        mergedFloorGeo = computeTangentsForNonIndexed(mergedFloorGeo);

        // Floors use the shared floor material (no occlusion needed - they're walkable)
        floorMesh = new THREE.Mesh(mergedFloorGeo, this.floorMaterial);
        floorMesh.name = "BatchedBuildingFloors";
        floorMesh.castShadow = true;
        floorMesh.receiveShadow = true;
        // Layer 2 for click-to-move raycasting (terrain is layer 0, entities layer 1)
        floorMesh.layers.set(2);
        floorMesh.userData = {
          type: "batched-building-floors",
          walkable: true,
          triangleToBuildingMap,
        };
        townGroup.add(floorMesh);

        // CRITICAL VALIDATION: Ensure floor mesh is on correct layer for raycasting
        if (!floorMesh.layers.isEnabled(2)) {
          throw new Error(
            `[BuildingRendering] CRITICAL: Floor mesh not on layer 2! Click-to-move will not work.`,
          );
        }

        // Log floor mesh creation for debugging
        const vertexCount = mergedFloorGeo.getAttribute("position")?.count ?? 0;
        console.log(
          `[BuildingRendering] Created floor mesh: ${vertexCount} vertices, layer=${floorMesh.layers.mask}`,
        );
      } else {
        // mergeGeometries returned null - this shouldn't happen with valid geometries
        console.warn(
          `[BuildingRendering] WARNING: mergeGeometries returned null for ${floorGeometries.length} floor geometries`,
        );
        floorMesh = new THREE.Mesh(
          new THREE.BufferGeometry(),
          this.batchedMaterial,
        );
      }
    } else {
      // No floor geometries - this is a problem if we expected buildings
      console.warn(
        `[BuildingRendering] WARNING: No floor geometries provided to createBatchedTownMesh`,
      );
      floorMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        this.batchedMaterial,
      );
    }

    // === WALL MESH (non-walkable - gets occlusion shader) ===
    let wallMesh: THREE.Mesh;
    if (wallGeometries.length > 0) {
      // Convert to non-indexed for consistent merging
      const nonIndexedWalls = toNonIndexed(wallGeometries);
      normalizeGeometryAttributes(nonIndexedWalls);
      let mergedWallGeo =
        nonIndexedWalls.length === 1
          ? nonIndexedWalls[0]
          : mergeGeometries(nonIndexedWalls, false);

      if (mergedWallGeo) {
        // Compute tangents from UVs for proper normal mapping
        mergedWallGeo = computeTangentsForNonIndexed(mergedWallGeo);

        // Walls use the occlusion material (see-through effect)
        wallMesh = new THREE.Mesh(mergedWallGeo, this.batchedMaterial);
        wallMesh.name = "BatchedBuildingWalls";
        wallMesh.castShadow = true;
        wallMesh.receiveShadow = true;
        // Layer 1 (main camera only, excluded from click-to-move raycast)
        wallMesh.layers.set(1);
        wallMesh.userData = {
          type: "batched-building-walls",
          walkable: false,
        };
        townGroup.add(wallMesh);
      } else {
        wallMesh = new THREE.Mesh(
          new THREE.BufferGeometry(),
          this.batchedMaterial,
        );
      }
    } else {
      wallMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        this.batchedMaterial,
      );
    }

    // === ROOF MESH (classic fantasy MMORPG-style per-building roof hiding) ===
    // Uses roofMaterial which has per-building visibility based on vertex attributes
    // buildingCenter and buildingRadius attributes enable the shader to hide roofs
    // when player/camera is close to that specific building
    let roofMesh: THREE.Mesh;
    if (roofGeometries.length > 0) {
      // Convert to non-indexed for consistent merging
      const nonIndexedRoofs = toNonIndexed(roofGeometries);
      normalizeGeometryAttributes(nonIndexedRoofs);
      let mergedRoofGeo =
        nonIndexedRoofs.length === 1
          ? nonIndexedRoofs[0]
          : mergeGeometries(nonIndexedRoofs, false);

      if (mergedRoofGeo) {
        // Compute tangents from UVs for proper normal mapping
        mergedRoofGeo = computeTangentsForNonIndexed(mergedRoofGeo);

        // Roofs use the special roof material with per-building visibility
        // The shader reads buildingCenter/buildingRadius vertex attributes to
        // determine if player/camera is close to this building and should hide its roof
        roofMesh = new THREE.Mesh(mergedRoofGeo, this.roofMaterial);
        roofMesh.name = "BatchedBuildingRoof";
        roofMesh.castShadow = true;
        roofMesh.receiveShadow = true;
        // Layer 1 (main camera only) to prevent click-to-move raycasting
        roofMesh.layers.set(1);
        roofMesh.userData = {
          type: "batched-building-roof",
          walkable: false,
        };
        townGroup.add(roofMesh);
      } else {
        roofMesh = new THREE.Mesh(
          new THREE.BufferGeometry(),
          this.roofMaterial,
        );
      }
    } else {
      roofMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.roofMaterial);
    }

    // === GLASS MESH (window panes - transparent) ===
    if (glassGeometries.length > 0) {
      // Convert to non-indexed for consistent merging
      const nonIndexedGlass = toNonIndexed(glassGeometries);
      normalizeGeometryAttributes(nonIndexedGlass);
      let mergedGlassGeo =
        nonIndexedGlass.length === 1
          ? nonIndexedGlass[0]
          : mergeGeometries(nonIndexedGlass, false);

      if (mergedGlassGeo) {
        // Compute tangents from UVs for proper normal mapping
        mergedGlassGeo = computeTangentsForNonIndexed(mergedGlassGeo);

        // Glass uses the shared transparent material
        const glassMesh = new THREE.Mesh(mergedGlassGeo, this.glassMaterial);
        glassMesh.name = "BatchedBuildingGlass";
        glassMesh.castShadow = false; // Glass doesn't cast shadows
        glassMesh.receiveShadow = false;
        // Layer 1 (main camera only)
        glassMesh.layers.set(1);
        glassMesh.userData = {
          type: "batched-building-glass",
          walkable: false,
          transparent: true,
        };
        // Render after opaque objects
        glassMesh.renderOrder = 1;
        townGroup.add(glassMesh);
      }
    }

    // Dispose individual geometries (they're now merged)
    if (floorGeometries.length > 1) {
      for (const geo of floorGeometries) geo.dispose();
    }
    if (wallGeometries.length > 1) {
      for (const geo of wallGeometries) geo.dispose();
    }
    if (roofGeometries.length > 1) {
      for (const geo of roofGeometries) geo.dispose();
    }
    if (glassGeometries.length > 1) {
      for (const geo of glassGeometries) geo.dispose();
    }

    const totalVertices =
      (floorMesh.geometry.getAttribute("position")?.count ?? 0) +
      (wallMesh.geometry.getAttribute("position")?.count ?? 0) +
      (roofMesh.geometry.getAttribute("position")?.count ?? 0);

    this.logger.info(
      `Created batched town meshes: ${totalVertices} vertices, ` +
        `${triangleToBuildingMap.size} triangles mapped to ${new Set(triangleToBuildingMap.values()).size} buildings`,
    );

    return {
      floorMesh,
      wallMesh,
      roofMesh,
      triangleToBuildingMap,
    };
  }

  /**
   * Get building ID from a raycast hit on a batched mesh.
   * Uses the triangle-to-building map to identify which building was hit.
   */
  getBuildingIdFromRaycastHit(
    intersection: THREE.Intersection,
    townData: TownData,
  ): string | null {
    if (!townData.batchedMesh || intersection.faceIndex == null) {
      return null;
    }

    return (
      townData.batchedMesh.triangleToBuildingMap.get(intersection.faceIndex) ??
      null
    );
  }

  // ============================================================================
  // PHYSX COLLISION BODIES
  // ============================================================================

  /**
   * Create PhysX collision bodies for a building.
   * Creates wall collision (thin boxes) and floor collision (flat boxes).
   */
  private createBuildingCollision(
    buildingData: BuildingData,
    building: TownBuilding,
  ): void {
    const physics = this.world.physics;
    const PHYSX = getPhysX();

    // PhysX must be loaded and physics system available
    if (!physics || !PHYSX) {
      return;
    }

    const layout = buildingData.layout;
    if (!layout) {
      return;
    }

    // Get building layer for collision filtering
    const buildingLayer = Layers.building ?? Layers.environment;
    if (!buildingLayer) {
      this.logger.warn("Building physics layer not found");
      return;
    }

    // Create floor collision for each floor
    for (let floorIndex = 0; floorIndex <= layout.floors; floorIndex++) {
      this.createFloorCollisionBody(
        buildingData,
        building,
        layout,
        floorIndex,
        physics,
        PHYSX,
        buildingLayer,
      );
    }

    // Create wall collision from building bounding box
    this.createWallCollisionBodies(
      buildingData,
      building,
      layout,
      physics,
      PHYSX,
      buildingLayer,
    );
  }

  /**
   * Create floor collision body for a specific floor level.
   */
  private createFloorCollisionBody(
    buildingData: BuildingData,
    building: TownBuilding,
    layout: BuildingLayout,
    floorIndex: number,
    physics: NonNullable<typeof this.world.physics>,
    PHYSX: ReturnType<typeof getPhysX>,
    buildingLayer: { group: number; mask: number },
  ): void {
    if (!PHYSX) return;

    // Calculate floor dimensions from layout
    const floorPlan =
      layout.floorPlans[Math.min(floorIndex, layout.floorPlans.length - 1)];
    if (!floorPlan) return;

    // Count cells to get floor size
    let minCol = Infinity,
      maxCol = -Infinity;
    let minRow = Infinity,
      maxRow = -Infinity;

    for (let row = 0; row < floorPlan.footprint.length; row++) {
      for (let col = 0; col < floorPlan.footprint[row].length; col++) {
        if (floorPlan.footprint[row][col]) {
          minCol = Math.min(minCol, col);
          maxCol = Math.max(maxCol, col);
          minRow = Math.min(minRow, row);
          maxRow = Math.max(maxRow, row);
        }
      }
    }

    if (minCol === Infinity) return; // No cells on this floor

    // Calculate floor dimensions in meters
    const floorWidthCells = maxCol - minCol + 1;
    const floorDepthCells = maxRow - minRow + 1;
    const floorWidth = floorWidthCells * CELL_SIZE;
    const floorDepth = floorDepthCells * CELL_SIZE;

    // Calculate floor center offset from building center
    const centerCol = (minCol + maxCol) / 2;
    const centerRow = (minRow + maxRow) / 2;
    const offsetX = (centerCol - layout.width / 2 + 0.5) * CELL_SIZE;
    const offsetZ = (centerRow - layout.depth / 2 + 0.5) * CELL_SIZE;

    // Apply building rotation to offset
    const cos = Math.cos(building.rotation);
    const sin = Math.sin(building.rotation);
    const rotatedOffsetX = offsetX * cos - offsetZ * sin;
    const rotatedOffsetZ = offsetX * sin + offsetZ * cos;

    // Calculate floor elevation using dynamic foundation height from layout
    const dynamicFoundationH = layout.foundationSteps * ENTRANCE_STEP_HEIGHT;
    const floorY =
      buildingData.position.y + dynamicFoundationH + floorIndex * FLOOR_HEIGHT;

    // Create box geometry for floor (thin horizontal plane)
    const boxGeometry = new PHYSX.PxBoxGeometry(
      floorWidth / 2,
      FLOOR_THICKNESS / 2,
      floorDepth / 2,
    );

    // Create material and shape (use cached physics material)
    if (!this._cachedPhysicsMaterial) {
      this._cachedPhysicsMaterial = physics.physics.createMaterial(
        0.5,
        0.5,
        0.1,
      );
    }
    const shape = physics.physics.createShape(
      boxGeometry,
      this._cachedPhysicsMaterial,
      true,
    );

    // Set collision filtering
    const filterData = new PHYSX.PxFilterData(
      buildingLayer.group,
      buildingLayer.mask,
      0,
      0,
    );
    shape.setQueryFilterData(filterData);
    shape.setSimulationFilterData(filterData);

    // Create transform with position and rotation
    const position = new PHYSX.PxVec3(
      buildingData.position.x + rotatedOffsetX,
      floorY,
      buildingData.position.z + rotatedOffsetZ,
    );

    // Create quaternion for Y-axis rotation
    const halfAngle = building.rotation / 2;
    const quat = new PHYSX.PxQuat(
      0,
      Math.sin(halfAngle),
      0,
      Math.cos(halfAngle),
    );

    const transform = new PHYSX.PxTransform(position, quat);
    const actor = physics.physics.createRigidStatic(transform);
    actor.attachShape(shape);

    // Create physics handle
    const handle: PhysicsHandle = {
      tag: `building_floor_${buildingData.buildingId}_${floorIndex}`,
      contactedHandles: new Set<PhysicsHandle>(),
      triggeredHandles: new Set<PhysicsHandle>(),
    };

    // Add actor to physics world
    physics.addActor(actor, handle);

    // Store collision body reference for cleanup
    buildingData.collisionBodies.push({
      actor,
      handle,
      type: floorIndex === layout.floors ? "roof" : "floor",
      floorIndex,
    });
  }

  /**
   * Create wall collision from building bounding box.
   * Creates 4 thin wall boxes around the building perimeter.
   */
  private createWallCollisionBodies(
    buildingData: BuildingData,
    building: TownBuilding,
    layout: BuildingLayout,
    physics: NonNullable<typeof this.world.physics>,
    PHYSX: ReturnType<typeof getPhysX>,
    buildingLayer: { group: number; mask: number },
  ): void {
    if (!PHYSX) return;

    // Use building dimensions from layout
    const buildingWidth = layout.width * CELL_SIZE;
    const buildingDepth = layout.depth * CELL_SIZE;
    const dynamicFoundH = layout.foundationSteps * ENTRANCE_STEP_HEIGHT;
    const buildingHeight = (layout.floors + 1) * FLOOR_HEIGHT + dynamicFoundH;

    // Wall definitions: [offsetX, offsetZ, halfWidth, halfDepth]
    // Walls are positioned at building edges
    const walls: Array<{
      offsetX: number;
      offsetZ: number;
      halfWidth: number;
      halfDepth: number;
      name: string;
    }> = [
      // North wall (positive Z)
      {
        offsetX: 0,
        offsetZ: buildingDepth / 2,
        halfWidth: buildingWidth / 2,
        halfDepth: WALL_THICKNESS / 2,
        name: "north",
      },
      // South wall (negative Z)
      {
        offsetX: 0,
        offsetZ: -buildingDepth / 2,
        halfWidth: buildingWidth / 2,
        halfDepth: WALL_THICKNESS / 2,
        name: "south",
      },
      // East wall (positive X)
      {
        offsetX: buildingWidth / 2,
        offsetZ: 0,
        halfWidth: WALL_THICKNESS / 2,
        halfDepth: buildingDepth / 2,
        name: "east",
      },
      // West wall (negative X)
      {
        offsetX: -buildingWidth / 2,
        offsetZ: 0,
        halfWidth: WALL_THICKNESS / 2,
        halfDepth: buildingDepth / 2,
        name: "west",
      },
    ];

    // Center Y position for walls (spans full building height)
    const wallCenterY = buildingData.position.y + buildingHeight / 2;
    const wallHalfHeight = buildingHeight / 2;

    for (const wall of walls) {
      // Apply building rotation to wall offset
      const cos = Math.cos(building.rotation);
      const sin = Math.sin(building.rotation);
      const rotatedOffsetX = wall.offsetX * cos - wall.offsetZ * sin;
      const rotatedOffsetZ = wall.offsetX * sin + wall.offsetZ * cos;

      // Create box geometry
      const boxGeometry = new PHYSX.PxBoxGeometry(
        wall.halfWidth,
        wallHalfHeight,
        wall.halfDepth,
      );

      // Create material and shape (use cached physics material)
      if (!this._cachedPhysicsMaterial) {
        this._cachedPhysicsMaterial = physics.physics.createMaterial(
          0.5,
          0.5,
          0.1,
        );
      }
      const shape = physics.physics.createShape(
        boxGeometry,
        this._cachedPhysicsMaterial,
        true,
      );

      // Set collision filtering
      const filterData = new PHYSX.PxFilterData(
        buildingLayer.group,
        buildingLayer.mask,
        0,
        0,
      );
      shape.setQueryFilterData(filterData);
      shape.setSimulationFilterData(filterData);

      // Create transform
      const position = new PHYSX.PxVec3(
        buildingData.position.x + rotatedOffsetX,
        wallCenterY,
        buildingData.position.z + rotatedOffsetZ,
      );

      // Rotate wall orientation based on building rotation
      const halfAngle = building.rotation / 2;
      const quat = new PHYSX.PxQuat(
        0,
        Math.sin(halfAngle),
        0,
        Math.cos(halfAngle),
      );

      const transform = new PHYSX.PxTransform(position, quat);
      const actor = physics.physics.createRigidStatic(transform);
      actor.attachShape(shape);

      // Create physics handle
      const handle: PhysicsHandle = {
        tag: `building_wall_${buildingData.buildingId}_${wall.name}`,
        contactedHandles: new Set<PhysicsHandle>(),
        triggeredHandles: new Set<PhysicsHandle>(),
      };

      // Add actor to physics world
      physics.addActor(actor, handle);

      // Store collision body reference
      buildingData.collisionBodies.push({
        actor,
        handle,
        type: "wall",
      });
    }
  }

  /**
   * Remove PhysX collision bodies for a building.
   */
  private removeBuildingCollision(buildingData: BuildingData): void {
    const physics = this.world.physics;
    if (!physics) return;

    for (const body of buildingData.collisionBodies) {
      // Remove actor from physics world (if method exists)
      if ("removeActor" in physics) {
        (physics as { removeActor: (a: unknown) => void }).removeActor(
          body.actor,
        );
      }
    }

    buildingData.collisionBodies.length = 0;
  }

  /**
   * Per-frame update for building LOD management and lazy collision.
   *
   * LOD Strategy (with batching):
   * 1. Town-level culling: Hide entire town if center is beyond fade distance + radius
   * 2. Town-level LOD: Batched mesh → impostors → culled (single transition per town)
   * 3. Shadow optimization: Disable shadows on batched mesh beyond lod1Distance
   * 4. Lazy collision: Create PhysX bodies when player enters town collision radius
   * 5. Impostor view updates: Update billboard orientation and octahedral cell
   */
  update(_dt: number): void {
    if (!this.world.isClient) return;

    const camera = this.world.camera;
    if (!camera) return;

    // Only update LOD every frame (buildings don't need throttling - few buildings)
    const cameraPos = camera.position;

    // ============================================
    // UPDATE OCCLUSION SHADER UNIFORMS
    // ============================================
    this.updateOcclusionUniforms(cameraPos);
    const dt = typeof _dt === "number" && Number.isFinite(_dt) ? _dt : 1 / 60;
    if (isLamppostLightTextureReady()) {
      this.applyBuildingVertexLights([]);
    } else {
      this.updateLamppostVertexLights(cameraPos, dt);
    }

    // Check if camera moved significantly
    const moved = this._lastCameraPos.distanceToSquared(cameraPos) > 1;
    if (!moved && this.townData.size > 0) {
      // Keep draining lazy collision work even when camera is stationary.
      this.processIncrementalCollision();
      return;
    }

    this._lastCameraPos.copy(cameraPos);

    // ============================================
    // ROOF AUTO-HIDE (when player inside building)
    // ============================================
    this.updateRoofVisibility(cameraPos);

    // ============================================
    // FLOOR TRACKING (for UI, sounds, gameplay)
    // ============================================
    this.updatePlayerFloorTracking();

    // LOD distances (squared for efficiency)
    const lod1DistSq = this.lodConfig.lod1DistanceSq;
    const imposterDistSq =
      this.lodConfig.imposterDistanceSq ?? lod1DistSq * 2.25; // Default 1.5x lod1
    const fadeDistSq = this.lodConfig.fadeDistanceSq;

    // Get town system for lazy collision creation
    const townSystem = this.world.getSystem("towns") as {
      getTowns?: () => ProceduralTown[];
    } | null;
    const allTowns = townSystem?.getTowns?.() ?? [];

    // OPTIMIZATION: Build/update town lookup map for O(1) access (vs O(n) find)
    // Rebuild if town count changed (simple invalidation)
    if (!this._townLookupMap || this._townLookupVersion !== allTowns.length) {
      this._townLookupMap = new Map(allTowns.map((t) => [t.id, t]));
      this._townLookupVersion = allTowns.length;
    }

    // Process each town
    for (const [townId, town] of this.townData) {
      // Calculate distance from camera to town center
      const townDistSq = this._tempVec
        .copy(town.center)
        .sub(cameraPos)
        .lengthSq();

      // ============================================
      // LAZY COLLISION CREATION (triggers incremental processing)
      // ============================================
      if (
        BUILDING_PERF_CONFIG.enableLazyCollision &&
        !town.collisionCreated &&
        !town.collisionInProgress
      ) {
        if (townDistSq <= town.collisionTriggerDistSq) {
          // Player is close enough - queue collision creation (processed incrementally)
          // OPTIMIZATION: O(1) Map lookup instead of O(n) find()
          const townData = this._townLookupMap?.get(townId);
          if (townData) {
            this.logger.info(
              `Queuing lazy collision for town ${townId} (${town.buildings.length} buildings)`,
            );
            town.collisionInProgress = true;
            town.collisionBuildingIndex = 0;
            const sourceBuildingById = new Map(
              townData.buildings.map((b) => [b.id, b]),
            );
            this._pendingCollisionTowns.push({
              townId,
              town,
              sourceData: townData,
              sourceBuildingById,
            });
          }
        }
      }

      // ============================================
      // TOWN-LEVEL CULLING
      // ============================================
      const townFadeDistSq = (Math.sqrt(fadeDistSq) + town.radius) ** 2;

      if (townDistSq > townFadeDistSq) {
        // Town is too far - hide everything including impostors
        if (town.visible) {
          town.group.visible = false;
          town.visible = false;
          // Hide batched mesh
          if (town.batchedMesh) {
            town.batchedMesh.floorMesh.visible = false;
            town.batchedMesh.wallMesh.visible = false;
            town.batchedMesh.roofMesh.visible = false;
          }
          // Hide individual impostors (dynamic atlas handles centrally)
          for (const building of town.buildings) {
            if (building.impostorMesh) {
              building.impostorMesh.visible = false;
            }
          }
        }
        continue;
      }

      // Town is in range - ensure group is visible
      if (!town.visible) {
        town.group.visible = true;
        town.visible = true;
      }

      // ============================================
      // BATCHED MESH LOD (town-level)
      // ============================================
      if (BUILDING_PERF_CONFIG.enableStaticBatching && town.batchedMesh) {
        // Determine town-level LOD based on distance to nearest edge
        const effectiveDistSq = Math.max(
          0,
          townDistSq - town.radius * town.radius,
        );

        // Use impostors when town is far enough, OR always for reflection camera (performance)
        // When DISABLE_IMPOSTORS is true, skip impostor stage - use dissolve fade instead
        const useImpostors =
          !DISABLE_IMPOSTORS &&
          (this.world.isRenderingReflection ||
            effectiveDistSq > imposterDistSq);
        const isCulled = effectiveDistSq > fadeDistSq;

        if (isCulled) {
          // Hide batched mesh and impostors
          town.batchedMesh.floorMesh.visible = false;
          town.batchedMesh.wallMesh.visible = false;
          town.batchedMesh.roofMesh.visible = false;
          // Hide individual impostors (dynamic atlas handles centrally)
          for (const building of town.buildings) {
            if (building.impostorMesh) {
              building.impostorMesh.visible = false;
            }
            building.lodLevel = 3;
          }
        } else if (useImpostors) {
          // Hide batched mesh, show impostors
          town.batchedMesh.floorMesh.visible = false;
          town.batchedMesh.wallMesh.visible = false;
          town.batchedMesh.roofMesh.visible = false;

          // Mark buildings as impostor LOD
          for (const building of town.buildings) {
            building.lodLevel = 2;
          }

          // Dynamic atlas handles impostors centrally - hide individual meshes
          if (BUILDING_PERF_CONFIG.enableDynamicAtlas && this.dynamicAtlas) {
            // Hide individual impostor meshes (dynamic atlas will render them)
            for (const building of town.buildings) {
              if (building.impostorMesh) {
                building.impostorMesh.visible = false;
              }
            }
          } else {
            // Fallback: Use individual impostor meshes
            for (const building of town.buildings) {
              if (building.impostorMesh) {
                building.impostorMesh.visible = true;
                this.updateImpostorView(building, cameraPos);
              }
            }
          }
        } else {
          // Show batched mesh, hide impostors
          // When DISABLE_IMPOSTORS is true, batched mesh stays visible and fades via GPU shader
          town.batchedMesh.floorMesh.visible = true;
          town.batchedMesh.wallMesh.visible = true;
          town.batchedMesh.roofMesh.visible = true;

          // Shadow optimization based on distance
          const enableShadows = effectiveDistSq <= lod1DistSq;
          town.batchedMesh.floorMesh.castShadow = enableShadows;
          town.batchedMesh.wallMesh.castShadow = enableShadows;
          town.batchedMesh.roofMesh.castShadow = enableShadows;

          // Hide individual impostors (dynamic atlas handles centrally)
          for (const building of town.buildings) {
            if (building.impostorMesh) {
              building.impostorMesh.visible = false;
            }
            building.lodLevel = enableShadows ? 0 : 1;
          }
        }
      } else {
        // ============================================
        // NON-BATCHED MODE: Per-building LOD with frame budget
        // ============================================
        // Queue buildings for deferred processing to avoid frame spikes
        // OPTIMIZATION: Copy camera position once for all buildings in this town
        // (all buildings in same frame use same camera position)
        this._deferredCameraPos.copy(cameraPos);
        for (const building of town.buildings) {
          this._deferredBuildingUpdates.push({
            building,
            cameraPos: this._deferredCameraPos, // Shared reference - processed same frame
            lod1DistSq,
            imposterDistSq,
            fadeDistSq,
          });
        }
      }
    }

    // Process deferred building LOD updates (limited per frame)
    // Note: All updates in _deferredBuildingUpdates share the same cameraPos reference
    // which is valid since they're all processed in the same frame
    this.processDeferredBuildingUpdates();

    // ============================================
    // DYNAMIC IMPOSTOR ATLAS UPDATE
    // ============================================
    // Update the dynamic atlas with all buildings in impostor range (lodLevel === 2)
    if (
      !DISABLE_IMPOSTORS &&
      BUILDING_PERF_CONFIG.enableDynamicAtlas &&
      this.dynamicAtlas
    ) {
      // Collect all buildings in impostor range
      const impostorBuildings: AtlasBuildingData[] = [];
      for (const town of this.townData.values()) {
        for (const building of town.buildings) {
          if (building.lodLevel === 2 && building.impostorBakeResult) {
            impostorBuildings.push({
              buildingId: building.buildingId,
              position: building.position,
              dimensions: building.dimensions,
              impostorBakeResult: building.impostorBakeResult,
              lodLevel: building.lodLevel,
            });
          }
        }
      }

      // Update atlas (handles slot assignment, blitting, and rendering)
      this.dynamicAtlas.update(impostorBuildings, cameraPos, camera);

      // Sync lighting with scene
      this.syncDynamicAtlasLighting();
    }

    // ============================================
    // INCREMENTAL COLLISION PROCESSING
    // ============================================
    // Process a limited number of collision bodies per frame to avoid spikes
    this.processIncrementalCollision();
  }

  /**
   * Process deferred building LOD updates incrementally.
   * Processes a limited number of buildings per frame to maintain smooth framerate.
   */
  private processDeferredBuildingUpdates(): void {
    if (this._deferredBuildingUpdates.length === 0) return;

    // Check frame budget - skip if over budget (LOD updates are not critical)
    const frameBudget = this.world.frameBudget;
    if (frameBudget && !frameBudget.hasTimeRemaining(2)) return;

    const maxBuildings = BUILDING_PERF_CONFIG.maxBuildingsPerFrameUpdate;
    const maxImpostorUpdates = BUILDING_PERF_CONFIG.maxImpostorUpdatesPerFrame;
    let processed = 0;
    this._impostorUpdatesThisFrame = 0;

    while (
      this._deferredBuildingUpdates.length > 0 &&
      processed < maxBuildings
    ) {
      // Re-check frame budget periodically (every 5 buildings)
      if (
        processed > 0 &&
        processed % 5 === 0 &&
        frameBudget &&
        !frameBudget.hasTimeRemaining(1)
      )
        break;

      const update = this._deferredBuildingUpdates.shift()!;
      const { building, cameraPos, lod1DistSq, imposterDistSq, fadeDistSq } =
        update;

      const buildingDistSq = this._tempVec
        .copy(building.position)
        .sub(cameraPos)
        .lengthSq();

      // Determine target LOD
      // Force impostor mode when rendering for reflection camera (performance)
      // When DISABLE_IMPOSTORS is true, skip impostor stage - use dissolve fade instead
      let targetLOD: 0 | 1 | 2 | 3;
      if (buildingDistSq > fadeDistSq) {
        targetLOD = 3; // Culled
      } else if (DISABLE_IMPOSTORS) {
        // IMPOSTORS DISABLED: Stay on best available 3D LOD, let GPU shader dissolve fade
        if (buildingDistSq > lod1DistSq) {
          targetLOD = 1; // Medium (no shadows)
        } else {
          targetLOD = 0; // Full detail
        }
      } else if (
        (this.world.isRenderingReflection || buildingDistSq > imposterDistSq) &&
        building.impostorMesh
      ) {
        targetLOD = 2; // Impostor
      } else if (buildingDistSq > lod1DistSq) {
        targetLOD = 1; // Medium (no shadows)
      } else {
        targetLOD = 0; // Full detail
      }

      // Apply LOD if changed
      if (targetLOD !== building.lodLevel) {
        building.lodLevel = targetLOD;

        // Hide all LOD meshes first
        building.mesh.visible = false;
        if (building.lodMeshes?.lod1) building.lodMeshes.lod1.visible = false;
        if (building.lodMeshes?.lod2) building.lodMeshes.lod2.visible = false;
        if (building.impostorMesh) building.impostorMesh.visible = false;

        if (targetLOD === 3) {
          // Culled - everything already hidden
        } else if (targetLOD === 2) {
          // Impostor or LOD2 - prefer impostor if available, otherwise LOD2
          if (building.impostorMesh) {
            building.impostorMesh.visible = true;
          } else if (building.lodMeshes?.lod2) {
            building.lodMeshes.lod2.visible = true;
          }
        } else if (targetLOD === 1) {
          // Medium detail - use LOD1 if available, otherwise main mesh
          if (building.lodMeshes?.lod1) {
            building.lodMeshes.lod1.visible = true;
          } else {
            building.mesh.visible = true;
            building.mesh.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = false; // No shadows at medium distance
              }
            });
          }
        } else {
          // Full detail - show main mesh with shadows
          building.mesh.visible = true;
          building.mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
            }
          });
        }
      }

      // Update impostor view if visible (with per-frame cap)
      if (
        building.lodLevel === 2 &&
        building.impostorMesh &&
        this._impostorUpdatesThisFrame < maxImpostorUpdates
      ) {
        this.updateImpostorView(building, cameraPos);
        this._impostorUpdatesThisFrame++;
      }

      processed++;
    }
  }

  /**
   * Process pending collision creation incrementally.
   * Creates a limited number of collision bodies per frame to avoid main thread blocking.
   */
  private processIncrementalCollision(): void {
    if (this._pendingCollisionTowns.length === 0) return;

    // Check frame budget - collision creation is deferrable
    const frameBudget = this.world.frameBudget;
    if (frameBudget && !frameBudget.hasTimeRemaining(3)) return;

    const bodiesPerFrame = BUILDING_PERF_CONFIG.collisionBodiesPerFrame;
    let bodiesCreated = 0;

    // Process towns in queue order
    while (
      this._pendingCollisionTowns.length > 0 &&
      bodiesCreated < bodiesPerFrame
    ) {
      const { townId, town, sourceData, sourceBuildingById } =
        this._pendingCollisionTowns[0];

      // Process buildings for this town
      while (
        town.collisionBuildingIndex < town.buildings.length &&
        bodiesCreated < bodiesPerFrame
      ) {
        const buildingData = town.buildings[town.collisionBuildingIndex];
        const townBuilding =
          sourceBuildingById.get(buildingData.buildingId) ??
          sourceData.buildings.find((b) => b.id === buildingData.buildingId);

        if (townBuilding) {
          this.createBuildingCollision(buildingData, townBuilding);
          bodiesCreated++;
        }

        town.collisionBuildingIndex++;
      }

      // Check if this town is complete
      if (town.collisionBuildingIndex >= town.buildings.length) {
        town.collisionCreated = true;
        town.collisionInProgress = false;
        this._pendingCollisionTowns.shift(); // Remove from queue
        this.logger.info(`Completed collision for town ${townId}`);
      }
    }
  }

  /** Cached light direction for impostor lighting */
  private _lightDir = new THREE.Vector3(0.5, 0.8, 0.3);
  private _lightColor = new THREE.Vector3(1, 0.98, 0.95);
  private _ambientColor = new THREE.Vector3(0.6, 0.7, 0.8);
  private _lastLightUpdate = 0;

  /**
   * Update impostor billboard orientation and octahedral view cell.
   * NOTE: When DISABLE_IMPOSTORS is true, this function returns immediately.
   */
  private updateImpostorView(
    building: BuildingData,
    cameraPos: THREE.Vector3,
  ): void {
    if (DISABLE_IMPOSTORS) return; // Impostors disabled - using dissolve fade instead
    const impostorMesh = building.impostorMesh;
    if (!impostorMesh) return;

    // Get grid size from mesh userData
    const { gridSizeX, gridSizeY } = impostorMesh.userData as {
      gridSizeX: number;
      gridSizeY: number;
    };

    // Calculate view direction from building to camera
    const dx = cameraPos.x - building.position.x;
    const dz = cameraPos.z - building.position.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return;

    // Billboard rotation - face camera (Y-axis only)
    const angle = Math.atan2(dx, dz);
    impostorMesh.rotation.y = angle;

    // Normalize view direction
    const vx = dx / len;
    const vz = dz / len;

    // Convert view direction to octahedral cell coordinates (hemisphere mapping)
    const col = Math.floor(((vx + 1) / 2) * (gridSizeX - 1));
    const row = Math.floor(((vz + 1) / 2) * (gridSizeY - 1));
    const clampedCol = Math.max(0, Math.min(gridSizeX - 1, col));
    const clampedRow = Math.max(0, Math.min(gridSizeY - 1, row));

    // Calculate flat index
    const flatIndex = clampedRow * gridSizeX + clampedCol;

    // Update material with view data (using pre-allocated vectors to avoid GC)
    this._imposterFaceIndices.set(flatIndex, flatIndex, flatIndex);

    // Handle both TSL (WebGPU) and GLSL (WebGL) materials
    const material = impostorMesh.material as
      THREE.ShaderMaterial | TSLImpostorMaterial;
    if (isTSLImpostorMaterial(material)) {
      // TSL material uses updateView method
      material.updateView(this._imposterFaceIndices, this._imposterFaceWeights);

      // Update lighting from scene (throttled to once per frame)
      if (material.updateLighting) {
        this.syncImpostorLighting(material);
      }
    }
  }

  /**
   * Sync impostor lighting with scene's sun light.
   * Throttled to once per frame to avoid redundant updates.
   */
  private syncImpostorLighting(material: TSLImpostorMaterial): void {
    const now = performance.now();
    // Only update lighting once per frame (~16ms)
    if (now - this._lastLightUpdate < 16) return;
    this._lastLightUpdate = now;

    // Get environment system for sun light
    const env = this.world.getSystem("environment") as {
      sunLight?: THREE.DirectionalLight;
      lightDirection?: THREE.Vector3;
    } | null;

    if (env?.sunLight) {
      const sun = env.sunLight;
      // Light direction is negated (light goes FROM direction TO target)
      if (env.lightDirection) {
        this._lightDir.copy(env.lightDirection).negate();
      } else {
        this._lightDir.set(0.5, 0.8, 0.3);
      }
      this._lightColor.set(sun.color.r, sun.color.g, sun.color.b);

      material.updateLighting!({
        ambientColor: this._ambientColor,
        ambientIntensity: 0.35,
        directionalLights: [
          {
            direction: this._lightDir,
            color: this._lightColor,
            intensity: sun.intensity,
          },
        ],
        specular: {
          f0: 0.04,
          shininess: 32,
          intensity: 0.3,
        },
      });
    }
  }

  /**
   * Sync dynamic atlas lighting with scene's sun light.
   */
  private syncDynamicAtlasLighting(): void {
    if (!this.dynamicAtlas) return;

    // Get environment system for sun light
    const env = this.world.getSystem("environment") as {
      sunLight?: THREE.DirectionalLight;
      lightDirection?: THREE.Vector3;
      hemisphereLight?: THREE.HemisphereLight;
    } | null;

    if (env?.sunLight) {
      const sun = env.sunLight;

      // Light direction is negated (light goes FROM direction TO target)
      if (env.lightDirection) {
        this._lightDir.copy(env.lightDirection).negate();
      } else {
        this._lightDir.set(0.5, 0.8, 0.3);
      }

      // Scale by sun intensity
      this._lightColor.set(
        sun.color.r * sun.intensity,
        sun.color.g * sun.intensity,
        sun.color.b * sun.intensity,
      );

      // Get ambient from hemisphere light or use defaults
      if (env.hemisphereLight) {
        const hemi = env.hemisphereLight;
        this._ambientColor.set(
          hemi.color.r * hemi.intensity * 0.5,
          hemi.color.g * hemi.intensity * 0.5,
          hemi.color.b * hemi.intensity * 0.5,
        );
      } else {
        this._ambientColor.set(0.5, 0.55, 0.65);
      }

      this.dynamicAtlas.updateLighting(
        this._lightDir,
        this._lightColor,
        this._ambientColor,
      );
    }
  }

  // ============================================================================
  // DEBUG UTILITIES
  // ============================================================================

  /**
   * Get building rendering statistics for debugging.
   */
  getStats(): {
    totalTowns: number;
    totalBuildings: number;
    buildingsWithImpostors: number;
    buildingsByLOD: {
      lod0: number;
      lod1: number;
      lod2: number;
      culled: number;
    };
    townsWithAtlas: number;
    dynamicAtlas: {
      enabled: boolean;
      slotsUsed: number;
      totalSlots: number;
      visibleCount: number;
    } | null;
    pendingImpostorBakes: number;
    lodConfig: LODDistancesWithSq;
    batchingEnabled: boolean;
  } {
    let totalBuildings = 0;
    let buildingsWithImpostors = 0;
    const townsWithAtlas = 0; // Deprecated: town-level atlas removed, using dynamic atlas instead
    const buildingsByLOD = { lod0: 0, lod1: 0, lod2: 0, culled: 0 };

    for (const town of this.townData.values()) {
      totalBuildings += town.buildings.length;

      for (const building of town.buildings) {
        if (building.impostorMesh || building.impostorBakeResult) {
          buildingsWithImpostors++;
        }
        if (building.lodLevel === 0) buildingsByLOD.lod0++;
        else if (building.lodLevel === 1) buildingsByLOD.lod1++;
        else if (building.lodLevel === 2) buildingsByLOD.lod2++;
        else buildingsByLOD.culled++;
      }
    }

    // Get dynamic atlas stats
    let dynamicAtlasStats: {
      enabled: boolean;
      slotsUsed: number;
      totalSlots: number;
      visibleCount: number;
    } | null = null;

    if (this.dynamicAtlas) {
      const atlasStats = this.dynamicAtlas.getStats();
      dynamicAtlasStats = {
        enabled: true,
        slotsUsed: atlasStats.slotsUsed,
        totalSlots: atlasStats.totalSlots,
        visibleCount: atlasStats.visibleCount,
      };
    }

    return {
      totalTowns: this.townData.size,
      totalBuildings,
      buildingsWithImpostors,
      buildingsByLOD,
      townsWithAtlas,
      dynamicAtlas: dynamicAtlasStats,
      pendingImpostorBakes: this._pendingImpostorBakes.length,
      lodConfig: this.lodConfig,
      batchingEnabled: BUILDING_PERF_CONFIG.enableStaticBatching,
    };
  }

  /**
   * Debug print building statistics to console.
   */
  debugPrintStats(): void {
    const stats = this.getStats();
    console.log("=== Building Rendering Stats ===");
    console.log(`Towns: ${stats.totalTowns}`);
    console.log(`Total Buildings: ${stats.totalBuildings}`);
    console.log(`Buildings with Impostors: ${stats.buildingsWithImpostors}`);
    console.log(`Towns with Impostor Atlas: ${stats.townsWithAtlas}`);
    console.log(`Pending Impostor Bakes: ${stats.pendingImpostorBakes}`);
    console.log(`LOD Distribution:`);
    console.log(`  LOD0 (full detail): ${stats.buildingsByLOD.lod0}`);
    console.log(`  LOD1 (medium): ${stats.buildingsByLOD.lod1}`);
    console.log(`  LOD2 (impostor): ${stats.buildingsByLOD.lod2}`);
    console.log(`  Culled: ${stats.buildingsByLOD.culled}`);
    console.log(`LOD Distances:`);
    console.log(`  LOD1: ${this.lodConfig.lod1Distance}m`);
    console.log(`  LOD2: ${this.lodConfig.lod2Distance}m`);
    console.log(`  Impostor: ${this.lodConfig.imposterDistance}m`);
    console.log(`  Fade: ${this.lodConfig.fadeDistance}m`);
    console.log(`Batching: ${stats.batchingEnabled ? "enabled" : "disabled"}`);
    if (stats.dynamicAtlas) {
      console.log(`Dynamic Atlas:`);
      console.log(
        `  Slots Used: ${stats.dynamicAtlas.slotsUsed}/${stats.dynamicAtlas.totalSlots}`,
      );
      console.log(`  Visible: ${stats.dynamicAtlas.visibleCount}`);
    }
    console.log("================================");
  }

  /**
   * Clean up all building meshes, impostors, batched meshes, and collision bodies.
   */
  override destroy(): void {
    // Remove all town groups and batched meshes
    for (const townGroup of this.townMeshes.values()) {
      // Dispose geometries and materials
      townGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (child.geometry) {
            child.geometry.dispose();
          }
          // Don't dispose shared batchedMaterial here (handled below)
          if (child.material && child.material !== this.batchedMaterial) {
            if (Array.isArray(child.material)) {
              for (const mat of child.material) {
                mat.dispose();
              }
            } else {
              child.material.dispose();
            }
          }
        }
      });
      townGroup.removeFromParent();
    }

    // Dispose batched meshes and impostor meshes
    for (const town of this.townData.values()) {
      // Dispose batched mesh geometries
      if (town.batchedMesh) {
        town.batchedMesh.floorMesh.geometry.dispose();
        town.batchedMesh.wallMesh.geometry.dispose();
        town.batchedMesh.roofMesh.geometry.dispose();
        // Dispose floor material (separate from wall/roof material)
        if (town.batchedMesh.floorMesh.material instanceof THREE.Material) {
          town.batchedMesh.floorMesh.material.dispose();
        }
        town.batchedMesh.triangleToBuildingMap.clear();
      }

      for (const building of town.buildings) {
        // Remove impostor mesh
        if (building.impostorMesh) {
          building.impostorMesh.geometry.dispose();
          (building.impostorMesh.material as THREE.Material).dispose();
          building.impostorMesh.removeFromParent();
        }

        // Remove LOD meshes
        if (building.lodMeshes) {
          if (building.lodMeshes.lod1) {
            building.lodMeshes.lod1.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.geometry?.dispose();
              }
            });
            building.lodMeshes.lod1.removeFromParent();
          }
          if (building.lodMeshes.lod2) {
            building.lodMeshes.lod2.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.geometry?.dispose();
              }
            });
            building.lodMeshes.lod2.removeFromParent();
          }
        }

        // Remove PhysX collision bodies
        this.removeBuildingCollision(building);

        // NOTE: Grass exclusion is now handled by GrassExclusionGrid querying BuildingCollisionService
        // When buildings are removed, the collision service cleanup handles this automatically
      }
    }

    // Dispose shared materials
    this.batchedMaterial.dispose();
    this.roofMaterial.dispose();
    this.floorMaterial.dispose();
    this.glassMaterial.dispose();

    // Dispose dynamic impostor atlas
    if (this.dynamicAtlas) {
      this.dynamicAtlas.dispose();
      this.dynamicAtlas = null;
    }

    this.townMeshes.clear();
    this.townData.clear();
    this._pendingImpostorBakes = [];

    // Remove groups from scene
    if (this.buildingsGroup.parent) {
      this.buildingsGroup.removeFromParent();
    }
    if (this.impostorsGroup.parent) {
      this.impostorsGroup.removeFromParent();
    }

    super.destroy();
  }

  /**
   * Get all buildings for a specific town.
   */
  getTownBuildings(townId: string): THREE.Group | undefined {
    return this.townMeshes.get(townId);
  }

  /**
   * Get the main buildings group.
   */
  getBuildingsGroup(): THREE.Group {
    return this.buildingsGroup;
  }

  /**
   * Get performance statistics for building rendering.
   * Useful for debugging and profiling.
   */
  getPerformanceStats(): {
    totalTowns: number;
    totalBuildings: number;
    batchedTowns: number;
    estimatedDrawCalls: number;
    collisionBodiesCreated: number;
    impostorsBaked: number;
    config: typeof BUILDING_PERF_CONFIG;
  } {
    let totalBuildings = 0;
    let batchedTowns = 0;
    let estimatedDrawCalls = 0;
    let collisionBodiesCreated = 0;
    let impostorsBaked = 0;

    for (const town of this.townData.values()) {
      totalBuildings += town.buildings.length;

      if (town.batchedMesh) {
        batchedTowns++;
        estimatedDrawCalls += 2; // body + roof
      } else {
        estimatedDrawCalls += town.buildings.length * 2;
      }

      for (const building of town.buildings) {
        collisionBodiesCreated += building.collisionBodies.length;
        if (building.impostorBakeResult) {
          impostorsBaked++;
        }
      }
    }

    return {
      totalTowns: this.townData.size,
      totalBuildings,
      batchedTowns,
      estimatedDrawCalls,
      collisionBodiesCreated,
      impostorsBaked,
      config: BUILDING_PERF_CONFIG,
    };
  }
}
