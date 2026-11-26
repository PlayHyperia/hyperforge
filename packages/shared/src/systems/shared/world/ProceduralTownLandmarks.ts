/**
 * ProceduralTownLandmarks.ts - GPU-accelerated Town Landmark System
 *
 * Renders procedural town landmarks (fences, lampposts, wells, signposts) using
 * TSL shaders and instanced rendering for optimal performance.
 *
 * Architecture:
 * - Uses MeshStandardNodeMaterial with TSL where needed (lamppost emissive)
 * - Instanced rendering for efficient draw calls
 * - Integrates with TownSystem and RoadNetworkSystem for data
 * - Signposts show directional destinations to connected towns
 *
 * @module ProceduralTownLandmarks
 */

import THREE, {
  MeshStandardNodeMaterial,
  float,
  mul,
  uniform,
  vec3,
} from "../../../extras/three/three";
import type { UniformNode } from "three/webgpu";
import { System } from "../infrastructure/System";
import type { SystemDependencies } from "../infrastructure/System";
import type { World } from "../../../types";
import type { TownLandmarkType } from "../../../types/world/world-types";
import { Logger } from "../../../utils/Logger";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { TownSystem } from "./TownSystem";
import { getGlobalTerrainComputeContext } from "../../../utils/compute";
import {
  clearLamppostLightTexture,
  setLamppostLightTextureData,
} from "./LamppostLightMask";
import { applySkyFog } from "./FogConfig";

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * KNOWN LIMITATIONS:
 * 1. Lampposts do not emit per-instance PointLights (too expensive at scale).
 *    We use emissive housing + terrain vertex lighting instead.
 * 2. Signpost destination text is stored in metadata but not rendered visually.
 *    Would require 3D text rendering system (TextGeometry or SDF text).
 * 3. Colors are per-type, not per-instance (instancing limitation).
 * 4. Geometry dimensions are hardcoded in create*Geometry functions.
 * 5. No distance-based culling/LOD - all landmarks render regardless of distance.
 */

// ============================================================================
// LANDMARK INSTANCE DATA
// ============================================================================

interface LandmarkInstance {
  position: THREE.Vector3;
  rotation: number;
  type: TownLandmarkType;
  scale: THREE.Vector3;
  townId: string; // Which town this landmark belongs to
  metadata?: {
    destination?: string;
    destinationId?: string;
  };
}

// ============================================================================
// PROCEDURAL GEOMETRY GENERATORS
// ============================================================================

/**
 * Merge multiple geometries into one using BufferGeometryUtils
 * This properly handles indices and attributes
 */
function mergeGeometries(
  geometries: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  if (geometries.length === 0) {
    // Return empty geometry for edge case
    return new THREE.BufferGeometry();
  }

  if (geometries.length === 1) {
    // Single geometry, just return it
    return geometries[0];
  }

  try {
    // Ensure all geometries are non-indexed for consistent merging
    const nonIndexed = geometries.map((g) => {
      if (g.index) {
        return g.toNonIndexed();
      }
      return g;
    });

    const merged = BufferGeometryUtils.mergeGeometries(nonIndexed, false);

    if (!merged) {
      Logger.systemWarn(
        "ProceduralTownLandmarks",
        "Geometry merge returned null, using fallback",
      );
      return geometries[0]; // Fallback to first geometry
    }

    // Dispose original geometries
    for (const g of geometries) {
      g.dispose();
    }

    return merged;
  } catch (error) {
    Logger.systemError(
      "ProceduralTownLandmarks",
      `Geometry merge failed: ${error}`,
    );
    // Return first geometry as fallback
    return geometries[0];
  }
}

/**
 * Smoothstep for scalar values (CPU-side)
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Create a procedural fence post geometry with connecting rails
 * Dimensions: 0.12m x 0.12m x 1.2m (realistic wooden post)
 * Includes 3.0m rails centered on the post to bridge adjacent posts
 */
function createFencePostGeometry(): THREE.BufferGeometry {
  // Main vertical post
  const post = new THREE.BoxGeometry(0.12, 1.2, 0.12);
  post.translate(0, 0.6, 0); // Origin at bottom

  // Top rail (3.0m long, centered to connect to adjacent posts)
  const topRail = new THREE.BoxGeometry(0.08, 0.06, 3.0);
  topRail.translate(0, 1.0, 0);

  // Bottom rail (3.0m long, centered)
  const bottomRail = new THREE.BoxGeometry(0.08, 0.06, 3.0);
  bottomRail.translate(0, 0.4, 0);

  return mergeGeometries([post, topRail, bottomRail]);
}

/**
 * Create a procedural lamppost geometry (detailed post + lantern housing)
 * Dimensions: 4m tall (realistic street lamp height)
 */
function createLamppostGeometry(): THREE.BufferGeometry {
  // ── Base section ──
  // Square plinth for stability (chamfered look via octagonal)
  const baseGeo = new THREE.CylinderGeometry(0.18, 0.22, 0.16, 8);
  baseGeo.translate(0, 0.08, 0);

  // Stepped collar transition from plinth to post
  const baseCollar1 = new THREE.CylinderGeometry(0.14, 0.18, 0.08, 8);
  baseCollar1.translate(0, 0.2, 0);
  const baseCollar2 = new THREE.CylinderGeometry(0.11, 0.14, 0.06, 8);
  baseCollar2.translate(0, 0.27, 0);

  // ── Main post (tapered) ──
  const postGeo = new THREE.CylinderGeometry(0.05, 0.1, 2.9, 10);
  postGeo.translate(0, 1.75, 0);

  // Lower ring detail
  const lowerRingGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.06, 8);
  lowerRingGeo.translate(0, 1.2, 0);

  // Mid ring detail
  const midRingGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.06, 8);
  midRingGeo.translate(0, 2.4, 0);

  // ── Decorative scroll brackets (4 sides, at top of post) ──
  // Small scrollwork detail where the arm meets the post
  const scrollGeo1 = new THREE.BoxGeometry(0.03, 0.18, 0.12);
  scrollGeo1.rotateX(Math.PI / 6);
  scrollGeo1.translate(0, 3.28, 0.1);
  const scrollGeo2 = scrollGeo1.clone();
  scrollGeo2.translate(0, 0, -0.2);

  // ── Upper collar ──
  const collarGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.08, 8);
  collarGeo.translate(0, 3.42, 0);

  // ── Lamp arm (curved via segmented bar) ──
  // Main horizontal arm
  const armGeo = new THREE.BoxGeometry(0.045, 0.045, 0.65);
  armGeo.translate(0, 3.52, 0.325);
  // Slight upturn at end
  const armTipGeo = new THREE.BoxGeometry(0.04, 0.12, 0.04);
  armTipGeo.translate(0, 3.52, 0.68);

  // Arm drop (vertical connector from arm to lantern)
  const dropGeo = new THREE.BoxGeometry(0.035, 0.22, 0.035);
  dropGeo.translate(0, 3.39, 0.7);

  // Diagonal arm brace (structural support)
  const braceGeo = new THREE.BoxGeometry(0.035, 0.32, 0.035);
  braceGeo.rotateX(Math.PI / 4);
  braceGeo.translate(0, 3.35, 0.2);

  // ── Lantern ──
  // Lantern cage (octagonal, slightly tapered for elegance)
  const housingGeo = new THREE.CylinderGeometry(0.16, 0.19, 0.45, 8);
  housingGeo.translate(0, 3.33, 0.78);

  // Lantern bottom plate with lip
  const housingBaseGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.035, 8);
  housingBaseGeo.translate(0, 3.1, 0.78);
  const housingBaseLipGeo = new THREE.CylinderGeometry(0.23, 0.23, 0.015, 8);
  housingBaseLipGeo.translate(0, 3.08, 0.78);

  // Inner light bulb / flame
  const bulbGeo = new THREE.SphereGeometry(0.09, 8, 6);
  bulbGeo.translate(0, 3.3, 0.78);

  // Lantern roof cap (pyramid-like)
  const capGeo = new THREE.ConeGeometry(0.22, 0.18, 8);
  capGeo.translate(0, 3.72, 0.78);
  // Cap rim ring
  const capRimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.02, 8);
  capRimGeo.translate(0, 3.63, 0.78);

  // Finial (decorative top point)
  const finialGeo = new THREE.ConeGeometry(0.05, 0.14, 6);
  finialGeo.translate(0, 3.95, 0.78);
  // Finial ball
  const finialBallGeo = new THREE.SphereGeometry(0.04, 6, 4);
  finialBallGeo.translate(0, 3.85, 0.78);

  return mergeGeometries([
    baseGeo,
    baseCollar1,
    baseCollar2,
    postGeo,
    lowerRingGeo,
    midRingGeo,
    scrollGeo1,
    scrollGeo2,
    collarGeo,
    armGeo,
    armTipGeo,
    dropGeo,
    braceGeo,
    housingGeo,
    housingBaseGeo,
    housingBaseLipGeo,
    bulbGeo,
    capGeo,
    capRimGeo,
    finialGeo,
    finialBallGeo,
  ]);
}

/**
 * Create a procedural well geometry (circular wall + roof posts + roof)
 * Dimensions: ~2m diameter, ~3m total height with roof
 */
function createWellGeometry(): THREE.BufferGeometry {
  // Well wall - low stone cylinder, 1m radius, 0.9m tall
  const wallGeo = new THREE.CylinderGeometry(1.0, 1.05, 0.9, 12, 1, true);
  wallGeo.translate(0, 0.45, 0);

  // Well floor (dark water surface inside)
  const floorGeo = new THREE.CircleGeometry(0.9, 12);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(0, 0.15, 0);

  // Well rim (top stone edge)
  const rimGeo = new THREE.TorusGeometry(1.0, 0.1, 6, 12);
  rimGeo.rotateX(Math.PI / 2);
  rimGeo.translate(0, 0.9, 0);

  // Roof support posts (2 wooden posts, thicker)
  const post1 = new THREE.BoxGeometry(0.12, 1.8, 0.12);
  post1.translate(-0.85, 1.8, 0);

  const post2 = new THREE.BoxGeometry(0.12, 1.8, 0.12);
  post2.translate(0.85, 1.8, 0);

  // Roof crossbar (horizontal beam)
  const crossbar = new THREE.BoxGeometry(0.1, 0.1, 2.0);
  crossbar.translate(0, 2.75, 0);

  // Bucket winch (cylinder on crossbar)
  const winch = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8);
  winch.rotateX(Math.PI / 2);
  winch.translate(0, 2.6, 0);

  // Simple peaked roof
  const roof1 = new THREE.BoxGeometry(0.7, 0.08, 2.3);
  roof1.rotateZ(Math.PI / 5);
  roof1.translate(-0.25, 2.95, 0);

  const roof2 = new THREE.BoxGeometry(0.7, 0.08, 2.3);
  roof2.rotateZ(-Math.PI / 5);
  roof2.translate(0.25, 2.95, 0);

  return mergeGeometries([
    wallGeo,
    floorGeo,
    rimGeo,
    post1,
    post2,
    crossbar,
    winch,
    roof1,
    roof2,
  ]);
}

/**
 * Create a procedural signpost geometry (post + directional sign)
 * Dimensions: 2.5m tall post with arrow sign
 */
function createSignpostGeometry(): THREE.BufferGeometry {
  // Main post - tapered wooden post
  const postGeo = new THREE.CylinderGeometry(0.05, 0.08, 2.5, 6);
  postGeo.translate(0, 1.25, 0);

  // Directional sign board (rectangular with pointed end)
  const signBase = new THREE.BoxGeometry(0.9, 0.22, 0.05);
  signBase.translate(0.35, 2.15, 0);

  // Arrow point triangular extension
  const arrowPoint = new THREE.BoxGeometry(0.18, 0.22, 0.05);
  arrowPoint.rotateZ(Math.PI / 4);
  arrowPoint.translate(0.85, 2.15, 0);

  // Small cap on top of post
  const cap = new THREE.ConeGeometry(0.07, 0.12, 6);
  cap.translate(0, 2.56, 0);

  return mergeGeometries([postGeo, signBase, arrowPoint, cap]);
}

/**
 * Create a hanging building sign geometry
 * A wrought-iron bracket mounted on the wall with a rectangular sign board
 * hanging from chains. This is the classic medieval/fantasy hanging shop sign.
 * Dimensions: ~1.2m wide, mounted at ~2.5m height, sign hangs below bracket
 */
function createBuildingSignGeometry(): THREE.BufferGeometry {
  // ── Wall bracket (L-shaped iron arm) ──
  // Horizontal arm extending from wall
  const bracketArm = new THREE.BoxGeometry(0.04, 0.04, 0.8);
  bracketArm.translate(0, 2.6, 0.4);

  // Vertical wall mount plate
  const wallPlate = new THREE.BoxGeometry(0.04, 0.35, 0.06);
  wallPlate.translate(0, 2.55, 0.0);

  // Diagonal brace (support under the arm)
  const brace = new THREE.BoxGeometry(0.03, 0.4, 0.03);
  brace.rotateX(-Math.PI / 4);
  brace.translate(0, 2.4, 0.18);

  // Decorative scroll at bracket tip (simple ball finial)
  const scrollBall = new THREE.SphereGeometry(0.04, 6, 4);
  scrollBall.translate(0, 2.6, 0.82);

  // ── Hanging chains (thin vertical connectors) ──
  const chainL = new THREE.BoxGeometry(0.02, 0.2, 0.02);
  chainL.translate(0, 2.47, 0.25);
  const chainR = new THREE.BoxGeometry(0.02, 0.2, 0.02);
  chainR.translate(0, 2.47, 0.65);

  // ── Sign board ──
  // Main rectangular board
  const signBoard = new THREE.BoxGeometry(0.04, 0.5, 0.55);
  signBoard.translate(0, 2.1, 0.45);

  // Top rail (decorative frame)
  const topRail = new THREE.BoxGeometry(0.05, 0.04, 0.6);
  topRail.translate(0, 2.36, 0.45);

  // Bottom rail
  const bottomRail = new THREE.BoxGeometry(0.05, 0.04, 0.6);
  bottomRail.translate(0, 1.84, 0.45);

  // Side rails
  const sideRailL = new THREE.BoxGeometry(0.05, 0.56, 0.04);
  sideRailL.translate(0, 2.1, 0.17);
  const sideRailR = new THREE.BoxGeometry(0.05, 0.56, 0.04);
  sideRailR.translate(0, 2.1, 0.73);

  return mergeGeometries([
    bracketArm,
    wallPlate,
    brace,
    scrollBall,
    chainL,
    chainR,
    signBoard,
    topRail,
    bottomRail,
    sideRailL,
    sideRailR,
  ]);
}

/**
 * Create a simple bench geometry
 * Dimensions: 1.5m wide, 0.45m seat height, 0.8m total height
 */
function createBenchGeometry(): THREE.BufferGeometry {
  // Seat plank
  const seat = new THREE.BoxGeometry(1.5, 0.06, 0.45);
  seat.translate(0, 0.45, 0);

  // Back rest
  const back = new THREE.BoxGeometry(1.5, 0.4, 0.05);
  back.translate(0, 0.7, -0.2);

  // Support frame (side panels)
  const sideL = new THREE.BoxGeometry(0.06, 0.45, 0.45);
  sideL.translate(-0.68, 0.225, 0);
  const sideR = new THREE.BoxGeometry(0.06, 0.45, 0.45);
  sideR.translate(0.68, 0.225, 0);

  // Arm rests
  const armL = new THREE.BoxGeometry(0.06, 0.06, 0.35);
  armL.translate(-0.68, 0.55, 0.05);
  const armR = new THREE.BoxGeometry(0.06, 0.06, 0.35);
  armR.translate(0.68, 0.55, 0.05);

  return mergeGeometries([seat, back, sideL, sideR, armL, armR]);
}

/**
 * Create a barrel geometry
 * Dimensions: ~0.6m diameter, 1m tall
 */
function createBarrelGeometry(): THREE.BufferGeometry {
  // Main barrel body - slightly bulging cylinder
  const barrel = new THREE.CylinderGeometry(0.28, 0.26, 1.0, 10);
  barrel.translate(0, 0.5, 0);

  // Top rim (metal band)
  const topRim = new THREE.TorusGeometry(0.28, 0.025, 4, 10);
  topRim.rotateX(Math.PI / 2);
  topRim.translate(0, 0.98, 0);

  // Bottom rim
  const bottomRim = new THREE.TorusGeometry(0.26, 0.025, 4, 10);
  bottomRim.rotateX(Math.PI / 2);
  bottomRim.translate(0, 0.02, 0);

  // Middle band
  const midBand = new THREE.TorusGeometry(0.29, 0.02, 4, 10);
  midBand.rotateX(Math.PI / 2);
  midBand.translate(0, 0.5, 0);

  // Top lid
  const lid = new THREE.CircleGeometry(0.26, 10);
  lid.rotateX(-Math.PI / 2);
  lid.translate(0, 1.0, 0);

  return mergeGeometries([barrel, topRim, bottomRim, midBand, lid]);
}

/**
 * Create a crate geometry
 * Dimensions: 0.7m x 0.55m x 0.55m wooden crate
 */
function createCrateGeometry(): THREE.BufferGeometry {
  // Main crate body
  const crate = new THREE.BoxGeometry(0.7, 0.55, 0.55);
  crate.translate(0, 0.275, 0);

  // Horizontal slats (decorative lines)
  const slat1 = new THREE.BoxGeometry(0.72, 0.04, 0.02);
  slat1.translate(0, 0.15, 0.27);
  const slat2 = new THREE.BoxGeometry(0.72, 0.04, 0.02);
  slat2.translate(0, 0.4, 0.27);

  // Corner reinforcement
  const corner1 = new THREE.BoxGeometry(0.04, 0.55, 0.04);
  corner1.translate(0.34, 0.275, 0.26);
  const corner2 = new THREE.BoxGeometry(0.04, 0.55, 0.04);
  corner2.translate(-0.34, 0.275, 0.26);

  return mergeGeometries([crate, slat1, slat2, corner1, corner2]);
}

/**
 * Create a planter geometry
 * Dimensions: ~0.7m wide, 0.6m tall with plants
 */
function createPlanterGeometry(): THREE.BufferGeometry {
  // Pot body - slightly tapered
  const pot = new THREE.BoxGeometry(0.65, 0.45, 0.65);
  pot.translate(0, 0.225, 0);

  // Rim around top
  const rim = new THREE.BoxGeometry(0.72, 0.06, 0.72);
  rim.translate(0, 0.48, 0);

  // Dirt/soil surface (darker)
  const soil = new THREE.CircleGeometry(0.28, 8);
  soil.rotateX(-Math.PI / 2);
  soil.translate(0, 0.44, 0);

  // Simple plant/flower stems
  const stem1 = new THREE.CylinderGeometry(0.02, 0.02, 0.25, 4);
  stem1.translate(0, 0.58, 0);
  const stem2 = new THREE.CylinderGeometry(0.02, 0.02, 0.2, 4);
  stem2.translate(0.08, 0.55, 0.05);
  const stem3 = new THREE.CylinderGeometry(0.02, 0.02, 0.18, 4);
  stem3.translate(-0.06, 0.54, -0.04);

  // Flower heads (small spheres)
  const flower1 = new THREE.SphereGeometry(0.06, 6, 4);
  flower1.translate(0, 0.72, 0);
  const flower2 = new THREE.SphereGeometry(0.05, 6, 4);
  flower2.translate(0.08, 0.67, 0.05);

  return mergeGeometries([
    pot,
    rim,
    soil,
    stem1,
    stem2,
    stem3,
    flower1,
    flower2,
  ]);
}

/**
 * Create a market stall geometry
 * Dimensions: ~3m wide, 2m deep, 2.5m tall
 */
function createMarketStallGeometry(): THREE.BufferGeometry {
  // Counter/table surface
  const counter = new THREE.BoxGeometry(3.0, 0.08, 1.0);
  counter.translate(0, 1.0, 0);

  // Front panel (display area)
  const frontPanel = new THREE.BoxGeometry(3.0, 0.85, 0.06);
  frontPanel.translate(0, 0.5, 0.47);

  // Back support poles (taller)
  const poleBackL = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6);
  poleBackL.translate(-1.4, 1.2, -0.4);
  const poleBackR = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6);
  poleBackR.translate(1.4, 1.2, -0.4);

  // Front support poles (shorter)
  const poleFrontL = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6);
  poleFrontL.translate(-1.4, 0.8, 0.4);
  const poleFrontR = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6);
  poleFrontR.translate(1.4, 0.8, 0.4);

  // Awning (sloped canvas/fabric roof)
  const awning = new THREE.BoxGeometry(3.2, 0.04, 1.3);
  awning.rotateX(-0.25);
  awning.translate(0, 2.2, 0);

  // Awning edge trim
  const awningTrim = new THREE.BoxGeometry(3.2, 0.12, 0.04);
  awningTrim.translate(0, 1.95, 0.6);

  // Sample goods on counter (boxes)
  const goods1 = new THREE.BoxGeometry(0.4, 0.25, 0.3);
  goods1.translate(-0.8, 1.2, 0.1);
  const goods2 = new THREE.BoxGeometry(0.35, 0.2, 0.25);
  goods2.translate(0.3, 1.15, 0.15);
  const goods3 = new THREE.BoxGeometry(0.5, 0.15, 0.35);
  goods3.translate(0.9, 1.12, 0);

  return mergeGeometries([
    counter,
    frontPanel,
    poleBackL,
    poleBackR,
    poleFrontL,
    poleFrontR,
    awning,
    awningTrim,
    goods1,
    goods2,
    goods3,
  ]);
}

/**
 * Create a fountain geometry
 * Dimensions: 4m diameter pool, ~2.5m tall center piece
 */
function createFountainGeometry(): THREE.BufferGeometry {
  // Outer pool wall (stone ring)
  const poolWall = new THREE.CylinderGeometry(2.0, 2.1, 0.5, 16, 1, true);
  poolWall.translate(0, 0.25, 0);

  // Pool water surface
  const water = new THREE.CircleGeometry(1.85, 16);
  water.rotateX(-Math.PI / 2);
  water.translate(0, 0.15, 0);

  // Pool rim (decorative edge)
  const rim = new THREE.TorusGeometry(2.0, 0.1, 6, 16);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.5, 0);

  // Center pedestal base
  const pedestalBase = new THREE.CylinderGeometry(0.5, 0.6, 0.3, 8);
  pedestalBase.translate(0, 0.3, 0);

  // Center column
  const column = new THREE.CylinderGeometry(0.25, 0.35, 1.2, 8);
  column.translate(0, 1.0, 0);

  // Upper basin
  const basin = new THREE.CylinderGeometry(0.5, 0.35, 0.3, 8);
  basin.translate(0, 1.7, 0);

  // Top ornament/spout
  const spout = new THREE.ConeGeometry(0.15, 0.4, 6);
  spout.translate(0, 2.1, 0);

  // Decorative sphere at top
  const topSphere = new THREE.SphereGeometry(0.12, 8, 6);
  topSphere.translate(0, 2.4, 0);

  return mergeGeometries([
    poolWall,
    water,
    rim,
    pedestalBase,
    column,
    basin,
    spout,
    topSphere,
  ]);
}

/**
 * Create a fence gate geometry
 * Dimensions: 1.2m wide, 1.1m tall (slightly lower than fence posts)
 */
function createFenceGateGeometry(): THREE.BufferGeometry {
  // Gate posts (taller than fence posts)
  const leftPost = new THREE.BoxGeometry(0.14, 1.3, 0.14);
  leftPost.translate(-0.6, 0.65, 0);
  const rightPost = new THREE.BoxGeometry(0.14, 1.3, 0.14);
  rightPost.translate(0.6, 0.65, 0);

  // Post caps
  const capL = new THREE.BoxGeometry(0.18, 0.06, 0.18);
  capL.translate(-0.6, 1.33, 0);
  const capR = new THREE.BoxGeometry(0.18, 0.06, 0.18);
  capR.translate(0.6, 1.33, 0);

  // Gate frame - top rail
  const topRail = new THREE.BoxGeometry(1.0, 0.08, 0.05);
  topRail.translate(0, 1.0, 0);

  // Gate frame - bottom rail
  const bottomRail = new THREE.BoxGeometry(1.0, 0.08, 0.05);
  bottomRail.translate(0, 0.25, 0);

  // Gate frame - middle rail
  const midRail = new THREE.BoxGeometry(1.0, 0.06, 0.05);
  midRail.translate(0, 0.6, 0);

  // Vertical pickets (5 pickets)
  const pickets: THREE.BufferGeometry[] = [];
  for (let i = -2; i <= 2; i++) {
    const picket = new THREE.BoxGeometry(0.06, 0.7, 0.035);
    picket.translate(i * 0.2, 0.62, 0);
    pickets.push(picket);
  }

  // Diagonal brace for strength
  const brace = new THREE.BoxGeometry(0.04, 0.9, 0.03);
  brace.rotateZ(Math.PI / 5);
  brace.translate(-0.15, 0.6, 0.03);

  return mergeGeometries([
    leftPost,
    rightPost,
    capL,
    capR,
    topRail,
    bottomRail,
    midRail,
    brace,
    ...pickets,
  ]);
}

// ============================================================================
// MATERIAL COLORS BY LANDMARK TYPE
// ============================================================================

const LANDMARK_COLORS: Record<TownLandmarkType, THREE.Color> = {
  fence_post: new THREE.Color(0.35, 0.25, 0.15),
  fence_gate: new THREE.Color(0.38, 0.28, 0.18),
  lamppost: new THREE.Color(0.18, 0.18, 0.22),
  well: new THREE.Color(0.45, 0.45, 0.5),
  fountain: new THREE.Color(0.5, 0.5, 0.55),
  signpost: new THREE.Color(0.4, 0.3, 0.2),
  building_sign: new THREE.Color(0.35, 0.25, 0.15), // Dark wood
  bench: new THREE.Color(0.35, 0.25, 0.18),
  barrel: new THREE.Color(0.4, 0.28, 0.15),
  crate: new THREE.Color(0.5, 0.4, 0.25),
  planter: new THREE.Color(0.5, 0.35, 0.25),
  market_stall: new THREE.Color(0.55, 0.4, 0.25),
  tree: new THREE.Color(0.25, 0.4, 0.2),
};

/**
 * Base geometry heights (in meters) - used for scaling
 * These match the actual geometry dimensions created in create*Geometry functions
 */
const GEOMETRY_BASE_HEIGHTS: Record<TownLandmarkType, number> = {
  fence_post: 1.2,
  fence_gate: 1.3,
  lamppost: 4.1,
  well: 3.0,
  fountain: 2.5,
  signpost: 2.6,
  building_sign: 2.7, // Top of bracket at ~2.6m
  bench: 0.9,
  barrel: 1.0,
  crate: 0.55,
  planter: 0.8,
  market_stall: 2.4,
  tree: 4.0,
};

// ============================================================================
// LAMPPOST LIGHTING CONFIG
// ============================================================================

// Light socket offset in local lamppost space (matches createLamppostGeometry)
const LAMP_LIGHT_SOCKET_OFFSET = new THREE.Vector3(0, 3.35, 0.78);
const LAMP_LIGHT_COLOR = new THREE.Color(1.0, 0.9, 0.6);
const LAMP_MASK_RANGE = 12;
const LAMP_MASK_MIN_TEXTURE_SIZE = 128;
const LAMP_MASK_MAX_TEXTURE_SIZE = 1024;
const LAMP_MASK_MIN_PIXELS_PER_RANGE = 2.5;

// ============================================================================
// PROCEDURAL TOWN LANDMARKS SYSTEM
// ============================================================================

export class ProceduralTownLandmarksSystem extends System {
  private readonly logTag = "ProceduralTownLandmarks";
  private meshGroups: Map<TownLandmarkType, THREE.InstancedMesh> = new Map();
  private signpostMeshes: THREE.Mesh[] = []; // Individual meshes for interactable signposts
  private landmarks: LandmarkInstance[] = [];
  private lamppostLightPositions: THREE.Vector3[] = [];
  private townDestinations: Map<string, string> = new Map(); // townId -> townName for signposts
  private scene: THREE.Scene | null = null;
  private lamppostNightMix: UniformNode<"float", number> | null = null;
  private lastNightMix = -1;

  // Geometry cache
  private geometries: Map<TownLandmarkType, THREE.BufferGeometry> = new Map();

  constructor(world: World) {
    super(world);
  }

  /**
   * Declare system dependencies for proper initialization order.
   * This ensures TownSystem and RoadNetworkSystem are initialized before us.
   */
  getDependencies(): SystemDependencies {
    return {
      required: ["town"],
      optional: ["roadNetwork"], // Roads are optional - towns work without roads
    };
  }

  /**
   * Initialize the system
   */
  async start(): Promise<void> {
    if (!this.world.isClient) return;

    const startTime = performance.now();
    Logger.system(
      this.logTag,
      "Initializing ProceduralTownLandmarks system...",
    );

    try {
      // Get scene from world
      const stage = this.world.stage as { scene?: THREE.Scene };
      this.scene = stage?.scene ?? null;

      if (!this.scene) {
        Logger.systemWarn(
          this.logTag,
          "No scene available - landmarks will not render",
        );
        return;
      }

      // Create geometries with timing
      const geoStart = performance.now();
      this.createGeometries();
      Logger.system(
        this.logTag,
        `Geometry creation took ${(performance.now() - geoStart).toFixed(1)}ms`,
      );

      // Collect landmark data from towns
      const collectStart = performance.now();
      this.collectLandmarkData();
      Logger.system(
        this.logTag,
        `Data collection took ${(performance.now() - collectStart).toFixed(1)}ms`,
      );

      // Create instanced meshes for each landmark type
      const meshStart = performance.now();
      this.createInstancedMeshes();
      Logger.system(
        this.logTag,
        `Mesh creation took ${(performance.now() - meshStart).toFixed(1)}ms`,
      );

      // Build baked lamppost light mask (GPU compute)
      const townSystem = this.world.getSystem("towns") as TownSystem | null;
      if (townSystem) {
        await this.buildLamppostLightMask(townSystem);
      }

      const totalTime = performance.now() - startTime;

      // Only mark as initialized if we actually have landmarks
      if (this.landmarks.length > 0) {
        this.initialized = true;
        Logger.system(
          this.logTag,
          `Initialized with ${this.landmarks.length} landmarks across ${this.meshGroups.size} types in ${totalTime.toFixed(1)}ms`,
        );
      } else {
        Logger.systemWarn(
          this.logTag,
          `No landmarks found - system not initialized (took ${totalTime.toFixed(1)}ms)`,
        );
      }
    } catch (error) {
      Logger.systemError(this.logTag, `Failed to initialize: ${error}`);
      // Clean up any partial state
      this.cleanup();
    }
  }

  /**
   * Internal cleanup helper
   *
   * IMPORTANT: Geometry ownership model:
   * - this.geometries map owns all geometry instances
   * - InstancedMesh and individual Mesh objects reference (not own) these geometries
   * - Only dispose geometries from the geometries map, never from mesh.geometry
   */
  private cleanup(): void {
    if (this.scene) {
      // Clean up instanced meshes - dispose materials only, NOT geometry
      // (geometry is owned by this.geometries map and disposed below)
      for (const mesh of this.meshGroups.values()) {
        this.scene.remove(mesh);
        // Don't dispose mesh.geometry here - it's shared from geometries map
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else if (mesh.material) {
          mesh.material.dispose();
        }
      }

      // Clean up individual signpost meshes - dispose materials only
      for (const mesh of this.signpostMeshes) {
        this.scene.remove(mesh);
        // Don't dispose geometry (shared from geometries map)
        // Only dispose cloned material
        if (mesh.material && !Array.isArray(mesh.material)) {
          mesh.material.dispose();
        }
      }
    }

    // Dispose all geometries once, from the canonical source
    for (const geo of this.geometries.values()) {
      geo.dispose();
    }

    this.meshGroups.clear();
    this.signpostMeshes = [];
    this.geometries.clear();
    this.landmarks = [];
    this.lamppostLightPositions = [];
    this.lamppostNightMix = null;
    this.lastNightMix = -1;
    clearLamppostLightTexture();
    this.initialized = false;
  }

  /**
   * Create all procedural geometries
   */
  private createGeometries(): void {
    this.geometries.set("fence_post", createFencePostGeometry());
    this.geometries.set("fence_gate", createFenceGateGeometry());
    this.geometries.set("lamppost", createLamppostGeometry());
    this.geometries.set("well", createWellGeometry());
    this.geometries.set("fountain", createFountainGeometry());
    this.geometries.set("signpost", createSignpostGeometry());
    this.geometries.set("building_sign", createBuildingSignGeometry());
    this.geometries.set("bench", createBenchGeometry());
    this.geometries.set("barrel", createBarrelGeometry());
    this.geometries.set("crate", createCrateGeometry());
    this.geometries.set("planter", createPlanterGeometry());
    this.geometries.set("market_stall", createMarketStallGeometry());

    // Tree uses a simple cone + cylinder
    const treeGeo = this.createTreeGeometry();
    this.geometries.set("tree", treeGeo);
  }

  /**
   * Calculate lamppost light mask texture size based on world size.
   */
  private calculateLamppostMaskTextureSize(worldSize: number): number {
    const metersPerPixelTarget =
      LAMP_MASK_RANGE / LAMP_MASK_MIN_PIXELS_PER_RANGE;
    const minResolution = Math.ceil(worldSize / metersPerPixelTarget);
    const pow2 = Math.pow(
      2,
      Math.ceil(Math.log2(Math.max(LAMP_MASK_MIN_TEXTURE_SIZE, minResolution))),
    );
    return Math.min(LAMP_MASK_MAX_TEXTURE_SIZE, pow2);
  }

  /**
   * Build baked lamppost light mask using GPU compute (nearest distance).
   */
  private async buildLamppostLightMask(townSystem: TownSystem): Promise<void> {
    if (!this.world.isClient) return;

    const lightPositions = this.lamppostLightPositions;
    if (lightPositions.length === 0) {
      clearLamppostLightTexture();
      return;
    }

    const worldSize = townSystem.getWorldSizeMeters?.() ?? 0;
    if (!Number.isFinite(worldSize) || worldSize <= 0) {
      Logger.systemWarn(
        this.logTag,
        "Lamppost mask skipped: invalid world size",
      );
      clearLamppostLightTexture();
      return;
    }

    const textureSize = this.calculateLamppostMaskTextureSize(worldSize);
    const centerX = 0;
    const centerZ = 0;
    const texelCount = textureSize * textureSize;
    const points = new Float32Array(texelCount * 3);
    const halfWorld = worldSize / 2;
    const step = worldSize / textureSize;

    let pIndex = 0;
    for (let z = 0; z < textureSize; z++) {
      const worldZ = centerZ - halfWorld + (z + 0.5) * step;
      for (let x = 0; x < textureSize; x++) {
        const worldX = centerX - halfWorld + (x + 0.5) * step;
        points[pIndex++] = worldX;
        points[pIndex++] = 0;
        points[pIndex++] = worldZ;
      }
    }

    const targets = new Float32Array(lightPositions.length * 3);
    for (let i = 0; i < lightPositions.length; i++) {
      const pos = lightPositions[i];
      const base = i * 3;
      targets[base] = pos.x;
      targets[base + 1] = pos.y;
      targets[base + 2] = pos.z;
    }

    const computeContext = getGlobalTerrainComputeContext();
    if (!computeContext.isReady()) {
      Logger.systemWarn(
        this.logTag,
        "Lamppost mask skipped: GPU compute not ready",
      );
      clearLamppostLightTexture();
      return;
    }

    const { distances } = await computeContext.computeNearestDistances(
      points,
      targets,
      true,
    );

    const data = new Float32Array(texelCount);
    for (let i = 0; i < texelCount; i++) {
      const dist = distances[i];
      const t = Math.max(0, Math.min(1, 1 - dist / LAMP_MASK_RANGE));
      data[i] = t * t;
    }

    setLamppostLightTextureData(
      data,
      textureSize,
      textureSize,
      worldSize,
      centerX,
      centerZ,
    );

    Logger.system(
      this.logTag,
      `Lamppost mask ready: ${textureSize}x${textureSize}, ${worldSize}m world`,
    );
  }

  /**
   * Create a simple decorative tree geometry
   * Dimensions: ~4m tall (shorter than real trees - this is for decoration)
   */
  private createTreeGeometry(): THREE.BufferGeometry {
    // Trunk
    const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1.8, 6);
    trunk.translate(0, 0.9, 0);

    // Lower foliage (wider cone)
    const foliageLower = new THREE.ConeGeometry(1.0, 1.8, 8);
    foliageLower.translate(0, 2.4, 0);

    // Upper foliage (narrower cone)
    const foliageUpper = new THREE.ConeGeometry(0.7, 1.4, 8);
    foliageUpper.translate(0, 3.4, 0);

    return mergeGeometries([trunk, foliageLower, foliageUpper]);
  }

  /**
   * Collect landmark data from TownSystem
   *
   * NOTE: Signpost destinations are already populated by TownSystem.populateSignpostDestinations()
   * which correctly matches signposts to their corresponding roads/entry points.
   * We simply use the metadata as-is from TownSystem.
   */
  private collectLandmarkData(): void {
    // Get TownSystem with proper typing
    const townSystem = this.world.getSystem("towns") as TownSystem | null;

    if (!townSystem?.getTowns) {
      Logger.systemWarn(
        this.logTag,
        "TownSystem not available or not initialized",
      );
      return;
    }

    const towns = townSystem.getTowns();
    this.landmarks = [];
    this.lamppostLightPositions = [];

    // Build town ID -> name mapping (useful for debugging and future features)
    for (const town of towns) {
      this.townDestinations.set(town.id, town.name);
    }

    // Collect all landmarks from all towns
    // Signpost metadata (destination, destinationId) is already populated by TownSystem
    for (const town of towns) {
      if (!town.landmarks) continue;

      for (const landmark of town.landmarks) {
        this.landmarks.push({
          position: new THREE.Vector3(
            landmark.position.x,
            landmark.position.y,
            landmark.position.z,
          ),
          rotation: landmark.rotation,
          type: landmark.type,
          scale: new THREE.Vector3(
            landmark.size.width,
            landmark.size.height,
            landmark.size.depth,
          ),
          townId: town.id,
          // Use metadata directly from TownSystem - it's already correct
          metadata: landmark.metadata,
        });

        if (landmark.type === "lamppost") {
          const baseHeight = GEOMETRY_BASE_HEIGHTS.lamppost ?? 1.0;
          const heightRatio = landmark.size.height / baseHeight;
          const sin = Math.sin(landmark.rotation);
          const cos = Math.cos(landmark.rotation);
          const offsetX =
            LAMP_LIGHT_SOCKET_OFFSET.x * cos - LAMP_LIGHT_SOCKET_OFFSET.z * sin;
          const offsetZ =
            LAMP_LIGHT_SOCKET_OFFSET.x * sin + LAMP_LIGHT_SOCKET_OFFSET.z * cos;
          this.lamppostLightPositions.push(
            new THREE.Vector3(
              landmark.position.x + offsetX,
              landmark.position.y + LAMP_LIGHT_SOCKET_OFFSET.y * heightRatio,
              landmark.position.z + offsetZ,
            ),
          );
        }
      }
    }

    Logger.system(
      this.logTag,
      `Collected ${this.landmarks.length} landmarks from ${towns.length} towns`,
    );
  }

  /**
   * Create instanced meshes for each landmark type
   */
  private createInstancedMeshes(): void {
    if (!this.scene) return;

    // Group landmarks by type
    const landmarksByType = new Map<TownLandmarkType, LandmarkInstance[]>();
    for (const landmark of this.landmarks) {
      const list = landmarksByType.get(landmark.type) ?? [];
      list.push(landmark);
      landmarksByType.set(landmark.type, list);
    }

    // Create instanced mesh for each type
    for (const [type, instances] of landmarksByType) {
      const geometry = this.geometries.get(type);
      if (!geometry) {
        Logger.systemWarn(
          this.logTag,
          `No geometry for landmark type: ${type}`,
        );
        continue;
      }

      // Create material with appropriate color
      const color = LANDMARK_COLORS[type] ?? new THREE.Color(0.5, 0.5, 0.5);
      const material =
        type === "lamppost"
          ? (() => {
              const nodeMaterial = new MeshStandardNodeMaterial();
              const baseColor = vec3(color.r, color.g, color.b);
              const nightMix = uniform(0.0);
              const emissiveColor = vec3(
                LAMP_LIGHT_COLOR.r,
                LAMP_LIGHT_COLOR.g,
                LAMP_LIGHT_COLOR.b,
              );
              nodeMaterial.colorNode = baseColor;
              nodeMaterial.emissiveNode = mul(
                emissiveColor,
                mul(float(1.2), nightMix),
              );
              nodeMaterial.roughness = 0.65;
              nodeMaterial.metalness = 0.35;
              this.lamppostNightMix = nightMix;
              applySkyFog(nodeMaterial);
              return nodeMaterial;
            })()
          : new THREE.MeshStandardMaterial({
              color,
              roughness: 0.8,
              metalness: 0.0,
            });

      // Signposts and building signs need individual meshes for raycasting/interaction.
      // Other landmarks can use instancing for performance.
      if (type === "signpost" || type === "building_sign") {
        for (let i = 0; i < instances.length; i++) {
          const inst = instances[i];
          const interactMesh = new THREE.Mesh(geometry, material.clone());
          interactMesh.position.copy(inst.position);
          interactMesh.rotation.y = inst.rotation;
          interactMesh.castShadow = true;
          interactMesh.receiveShadow = true;

          if (type === "signpost") {
            interactMesh.userData = {
              type: "signpost",
              entityId: `signpost_${inst.townId}_${i}`,
              entityType: "signpost",
              name: "Signpost",
              interactable: true,
              metadata: inst.metadata,
              townId: inst.townId,
            };
          } else {
            // Building sign — clickable to show building name
            const buildingType =
              (inst.metadata as { buildingType?: string } | undefined)
                ?.buildingType ?? "building";
            const buildingName =
              (inst.metadata as { buildingName?: string } | undefined)
                ?.buildingName ?? "";
            interactMesh.userData = {
              type: "building_sign",
              entityId: `building_sign_${inst.townId}_${i}`,
              entityType: "building_sign",
              name: buildingName || "Sign",
              interactable: true,
              metadata: inst.metadata,
              townId: inst.townId,
              buildingType,
            };
          }

          this.scene.add(interactMesh);
          if (!this.signpostMeshes) {
            this.signpostMeshes = [];
          }
          this.signpostMeshes.push(interactMesh);
        }
        continue; // Skip instanced mesh creation for interactable landmarks
      }

      // Create instanced mesh for other landmark types
      const mesh = new THREE.InstancedMesh(
        geometry,
        material,
        instances.length,
      );
      mesh.frustumCulled = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // Set instance matrices
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);

      // Get base geometry height for this type
      const baseHeight = GEOMETRY_BASE_HEIGHTS[type] ?? 1.0;

      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        position.copy(inst.position);
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), inst.rotation);

        // Scale height based on landmark size vs base geometry height
        // Only scale if the requested height differs significantly from base
        const heightRatio = inst.scale.y / baseHeight;
        if (Math.abs(heightRatio - 1.0) > 0.05) {
          // Scale Y axis to match requested height
          scale.set(1, heightRatio, 1);
        } else {
          scale.set(1, 1, 1);
        }

        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
      }

      mesh.instanceMatrix.needsUpdate = true;

      // Add to scene
      this.scene.add(mesh);
      this.meshGroups.set(type, mesh);
    }

    Logger.system(
      this.logTag,
      `Created ${this.meshGroups.size} instanced mesh groups`,
    );
  }

  /**
   * Update system (called every frame)
   */
  update(_deltaTime: number): void {
    if (!this.world.isClient || !this.lamppostNightMix) return;
    const environment = this.world.getSystem("environment") as {
      getDayIntensity?: () => number;
    } | null;
    const dayIntensity = environment?.getDayIntensity?.() ?? 1;
    const nightMix = smoothstep(0.4, 0.7, 1 - dayIntensity);
    if (Math.abs(nightMix - this.lastNightMix) > 0.002) {
      this.lamppostNightMix.value = nightMix;
      this.lastNightMix = nightMix;
    }
  }

  /**
   * Clean up resources
   */
  stop(): void {
    try {
      this.cleanup();
      Logger.system(this.logTag, "System stopped and resources cleaned up");
    } catch (error) {
      Logger.systemError(this.logTag, `Error during cleanup: ${error}`);
    }
  }

  // ============================================================================
  // PUBLIC API - Query methods for debugging, UI, and game logic
  // ============================================================================

  /**
   * Get landmark count, optionally filtered by type
   * Useful for: debugging, UI display ("25 lampposts in world"), analytics
   *
   * @param type - Optional landmark type to filter by
   * @returns Number of landmarks (total or filtered)
   */
  getLandmarkCount(type?: TownLandmarkType): number {
    if (type) {
      return this.landmarks.filter((l) => l.type === type).length;
    }
    return this.landmarks.length;
  }

  /**
   * Get signpost destinations for a specific town
   * Useful for: UI showing "Paths lead to: Riverdale, Stonewick", minimap labels
   *
   * @param townId - The town ID to get signpost destinations for
   * @returns Array of destination town names
   */
  getSignpostDestinations(townId: string): string[] {
    return this.landmarks
      .filter(
        (l) =>
          l.townId === townId &&
          l.type === "signpost" &&
          l.metadata?.destination,
      )
      .map((l) => l.metadata!.destination!);
  }

  /**
   * Check if system has any landmarks
   * Useful for: conditional logic, debugging empty worlds
   */
  hasLandmarks(): boolean {
    return this.landmarks.length > 0;
  }

  /**
   * Get lamppost light socket positions (world space)
   */
  getLamppostLightPositions(): ReadonlyArray<THREE.Vector3> {
    return this.lamppostLightPositions;
  }
}

// Export for use in world creation
export {
  createFencePostGeometry,
  createLamppostGeometry,
  createWellGeometry,
  createSignpostGeometry,
  createBuildingSignGeometry,
};
