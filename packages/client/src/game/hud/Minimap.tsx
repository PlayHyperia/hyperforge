/**
 * Minimap.tsx - 2D Minimap Component
 *
 * Shows player position, nearby entities, and terrain on a 2D minimap.
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import { useThemeStore, useQuestSelectionStore } from "@/ui";
import {
  Entity,
  EventType,
  THREE,
  TERRAIN_CONSTANTS,
  INPUT,
  ALL_WORLD_AREAS,
  resolveZoneNavigationMode,
} from "@hyperforge/shared";
import type { ClientWorld } from "../../types";
import { type EntityPip, useMinimapEntityPips } from "./useMinimapEntityPips";
import { useQuestStatusSync } from "./useQuestStatusSync";
import {
  type MinimapRoad,
  type MinimapRoadWithAABB,
  type MinimapTown,
  useMinimapWorldCaches,
} from "./useMinimapWorldCaches";
import {
  MINIMAP_TERRAIN_OVERSHOOT,
  useMinimapTerrainCache,
} from "./useMinimapTerrainCache";
import {
  MinimapZoneNavigationState,
  updateMinimapZoneNavigation,
} from "./minimapZoneNavigation";
// Shared with terrain-cache generation so draw-time coverage matches the
// cached snapshot's real world footprint.
const TERRAIN_OVERSHOOT = MINIMAP_TERRAIN_OVERSHOOT;

// Terrain draw is just a transformed drawImage() pass, so keep it in sync with
// live overlay motion instead of throttling it behind the player.
const RENDER_EVERY_N_FRAMES = 1;

// Zoom bounds and step size — kept at module scope for stability across re-renders
const MIN_EXTENT = 20;
const MAX_EXTENT = 1000;
const STEP_EXTENT = 10;

// Reference minimap pixel size at which the initial zoom level is 1:1.
// sizeBasedExtent = zoom × (avgSize / MINIMAP_BASE_SIZE_PX)
const MINIMAP_BASE_SIZE_PX = 200;

// Fixed road/building pixel widths — do NOT scale with zoom
const ROAD_LINE_WIDTH_PX = 5;
const ROAD_OUTLINE_WIDTH_PX = 7;
const BUILDING_LINE_WIDTH_PX = 0.5;
const ROAD_OUTLINE_COLOR = "rgb(56, 60, 68)";
const ROAD_FILL_COLOR = "rgb(164, 151, 128)";
const BUILDING_FILL_COLOR = "rgba(84, 92, 104, 0.92)";
const BUILDING_STROKE_COLOR = "rgb(34, 39, 46)";

/** 2D context interface for minimap drawing — satisfied by both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D */
interface MinimapDrawContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "bevel" | "round" | "miter";
}

/**
 * Pre-allocated flat pixel-path buffer — zero heap allocation per road per frame.
 * Stores (x, y) pairs for all visible road points in a single contiguous block.
 * Grows by doubling when capacity is exceeded; never shrinks.
 */
function ensureRoadPixelBufCapacity(
  roadPixelBufRef: React.MutableRefObject<Float32Array>,
  needed: number,
): void {
  if (roadPixelBufRef.current.length >= needed * 2) return;
  let n = roadPixelBufRef.current.length;
  while (n < needed * 2) n *= 2;
  roadPixelBufRef.current = new Float32Array(n);
}

/** Per-road projected data — populated once per frame, two-pass rendered */
type ProjectedRoad = {
  pts: Float32Array;
  len: number;
  fill: number;
  outline: number;
};
/**
 * Project a world XZ point to canvas pixel coordinates using the camera's
 * projection-view matrix — the same transform used for entity pips.
 *
 * This replaces the old worldToPx() which used a separate (often stale)
 * center/extent/up coordinate system that would drift out of sync with the
 * terrain on zoom, pan, or rotate.
 */
function worldToPx(
  wx: number,
  wz: number,
  projectionViewMatrix: THREE.Matrix4,
  scratchVec: THREE.Vector3,
  cw: number,
  ch: number,
): void {
  scratchVec.set(wx, 0, wz);
  scratchVec.applyMatrix4(projectionViewMatrix);
  scratchVec.x = (scratchVec.x * 0.5 + 0.5) * cw;
  scratchVec.y = (scratchVec.y * -0.5 + 0.5) * ch;
}

/**
 * Draw roads and buildings on the overlay canvas.
 *
 * Uses camera-matrix projection (same as entity pips) so roads zoom, pan, and
 * rotate in perfect lockstep with pips — no separate coordinate system, no
 * terrain-cache dependency, no desync on zoom or rotation.
 *
 * Roads use fixed pixel widths (ROAD_LINE_WIDTH_PX / ROAD_OUTLINE_WIDTH_PX) so
 * they don't visually scale when the player zooms in/out — only the terrain
 * background scales.
 */
function drawRoadsAndBuildingsOverlay(
  ctx: CanvasRenderingContext2D,
  roads: MinimapRoadWithAABB[] | null,
  towns: MinimapTown[] | null,
  roadPixelBufRef: React.MutableRefObject<Float32Array>,
  projectedRoadsRef: React.MutableRefObject<ProjectedRoad[]>,
  projectionViewMatrix: THREE.Matrix4,
  scratchVec: THREE.Vector3,
  camX: number,
  camZ: number,
  viewRadius: number,
  /** Pixels per world unit: cw / (2 * extent). Used to scale road widths with zoom. */
  worldToPixel: number,
  cw: number,
  ch: number,
): void {
  if (roads && roads.length > 0) {
    // Two-pass rendering: all outlines first, all fills second.
    // Drawing per-road (outline→fill→outline→fill…) leaves dark outline bands
    // wherever roads cross because each road's outline paints over the previous
    // road's fill.  Batching outlines then fills means every fill covers every
    // outline edge, so intersections look seamless.

    // Pass 0 — count total visible points so we can pre-size the global buffer
    // in one shot, avoiding any mid-loop reallocation.
    let totalVisiblePts = 0;
    for (const road of roads) {
      if (road.path.length < 2) continue;
      if (
        road.maxX < camX - viewRadius ||
        road.minX > camX + viewRadius ||
        road.maxZ < camZ - viewRadius ||
        road.minZ > camZ + viewRadius
      )
        continue;
      totalVisiblePts += road.path.length;
    }
    ensureRoadPixelBufCapacity(roadPixelBufRef, totalVisiblePts);
    const roadPixelBuf = roadPixelBufRef.current;
    const projectedRoads = projectedRoadsRef.current;

    // Pass 1 (projection) — write XY pairs into _roadPixelBuf, store subarray
    // views in _projectedRoads.  Zero Float32Array allocations per frame.
    projectedRoads.length = 0;
    let _bufOffset = 0;

    for (const road of roads) {
      if (road.path.length < 2) continue;
      if (
        road.maxX < camX - viewRadius ||
        road.minX > camX + viewRadius ||
        road.maxZ < camZ - viewRadius ||
        road.minZ > camZ + viewRadius
      )
        continue;

      const worldWidth = road.width > 0 ? road.width : 4;
      const scaledFill = Math.max(
        ROAD_LINE_WIDTH_PX,
        Math.min(40, worldWidth * worldToPixel),
      );
      const scaledOutline = Math.max(ROAD_OUTLINE_WIDTH_PX, scaledFill + 2);

      const ptsBase = _bufOffset;
      for (let ri = 0; ri < road.path.length; ri++) {
        worldToPx(
          road.path[ri].x,
          road.path[ri].z,
          projectionViewMatrix,
          scratchVec,
          cw,
          ch,
        );
        roadPixelBuf[_bufOffset++] = scratchVec.x;
        roadPixelBuf[_bufOffset++] = scratchVec.y;
      }
      projectedRoads.push({
        pts: roadPixelBuf.subarray(ptsBase, _bufOffset),
        len: road.path.length,
        fill: scaledFill,
        outline: scaledOutline,
      });
    }

    if (projectedRoads.length > 0) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Pass 2 — outlines only (all roads)
      ctx.strokeStyle = ROAD_OUTLINE_COLOR;
      for (const r of projectedRoads) {
        ctx.lineWidth = r.outline;
        ctx.beginPath();
        ctx.moveTo(r.pts[0], r.pts[1]);
        for (let i = 1; i < r.len; i++)
          ctx.lineTo(r.pts[i * 2], r.pts[i * 2 + 1]);
        ctx.stroke();
      }

      // Pass 3 — fills only (all roads)
      ctx.strokeStyle = ROAD_FILL_COLOR;
      for (const r of projectedRoads) {
        ctx.lineWidth = r.fill;
        ctx.beginPath();
        ctx.moveTo(r.pts[0], r.pts[1]);
        for (let i = 1; i < r.len; i++)
          ctx.lineTo(r.pts[i * 2], r.pts[i * 2 + 1]);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  if (towns && towns.length > 0) {
    ctx.save();
    // Building stroke scales with zoom but clamped to a thin line
    ctx.lineWidth = Math.max(
      BUILDING_LINE_WIDTH_PX + 0.25,
      Math.min(3.25, worldToPixel * 0.35),
    );
    for (const town of towns) {
      for (const building of town.buildings) {
        const bx = building.position.x;
        const bz = building.position.z;
        if (
          Math.abs(bx - camX) > viewRadius ||
          Math.abs(bz - camZ) > viewRadius
        )
          continue;

        const hw = building.size.width * 0.5;
        const hd = building.size.depth * 0.5;
        const cos = Math.cos(building.rotation);
        const sin = Math.sin(building.rotation);

        // Project 4 rotated corners through the camera matrix
        worldToPx(
          bx + cos * hw - sin * hd,
          bz + sin * hw + cos * hd,
          projectionViewMatrix,
          scratchVec,
          cw,
          ch,
        );
        const p0x = scratchVec.x;
        const p0y = scratchVec.y;

        worldToPx(
          bx - cos * hw - sin * hd,
          bz - sin * hw + cos * hd,
          projectionViewMatrix,
          scratchVec,
          cw,
          ch,
        );
        const p1x = scratchVec.x;
        const p1y = scratchVec.y;

        worldToPx(
          bx - cos * hw + sin * hd,
          bz - sin * hw - cos * hd,
          projectionViewMatrix,
          scratchVec,
          cw,
          ch,
        );
        const p2x = scratchVec.x;
        const p2y = scratchVec.y;

        worldToPx(
          bx + cos * hw + sin * hd,
          bz + sin * hw - cos * hd,
          projectionViewMatrix,
          scratchVec,
          cw,
          ch,
        );
        const p3x = scratchVec.x;
        const p3y = scratchVec.y;

        ctx.beginPath();
        ctx.moveTo(p0x, p0y);
        ctx.lineTo(p1x, p1y);
        ctx.lineTo(p2x, p2y);
        ctx.lineTo(p3x, p3y);
        ctx.closePath();
        ctx.fillStyle = BUILDING_FILL_COLOR;
        ctx.fill();
        ctx.strokeStyle = BUILDING_STROKE_COLOR;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/**
 * Per-instance render state factory.
 *
 * Previously these were module-level constants, which meant multiple simultaneous
 * Minimap instances would corrupt each other's temp vectors mid-frame.  Each
 * component instance now gets its own isolated set via renderStateRef.
 */
interface MinimapRenderState {
  /** Reusable zone POI and edge-cue layout storage. */
  zoneNavigation: MinimapZoneNavigationState;
  /** Camera forward direction (XZ) */
  forwardVec: THREE.Vector3;
  /** Pip world→screen projection scratch */
  projectVec: THREE.Vector3;
  /** Destination marker projection scratch */
  destVec: THREE.Vector3;
  /** screenToWorldXZ unprojection scratch */
  unprojectVec: THREE.Vector3;
  /** Camera follow target position scratch */
  targetPos: { x: number; z: number };
  /** Combined projection-view matrix, updated once per frame */
  projectionViewMatrix: THREE.Matrix4;
  /** Whether projectionViewMatrix has been populated this session */
  hasCachedMatrix: boolean;
}

function createRenderState(): MinimapRenderState {
  return {
    zoneNavigation: new MinimapZoneNavigationState(),
    forwardVec: new THREE.Vector3(),
    projectVec: new THREE.Vector3(),
    destVec: new THREE.Vector3(),
    unprojectVec: new THREE.Vector3(),
    targetPos: { x: 0, z: 0 },
    projectionViewMatrix: new THREE.Matrix4(),
    hasCachedMatrix: false,
  };
}

/** Augmented window type covering all Hyperia globals written to window */
type HyperiaWindow = Window &
  typeof globalThis & {
    __lastRaycastTarget?: { x: number; y: number; z: number; method: string };
    __HYPERIA_CONFIG__?: { mode?: string; followEntity?: string };
  };

/** Camera info shape returned by the client-camera-system */
interface SpectatorTarget {
  id?: string;
  position: { x: number; z: number };
}

/**
 * Returns the spectated entity's position when in spectator mode, or null.
 * Centralises the duplicated window.__HYPERIA_CONFIG__ + camera-system reads
 * that previously appeared independently in the entity interval and the RAF loop.
 */
function getSpectatorTarget(world: ClientWorld): SpectatorTarget | null {
  if ((window as HyperiaWindow).__HYPERIA_CONFIG__?.mode !== "spectator")
    return null;
  const cameraSystem = world.getSystem("client-camera-system") as {
    getCameraInfo?: () => {
      target?: {
        id?: string;
        node?: { position?: THREE.Vector3 };
        position?: { x: number; z: number };
      };
    };
  } | null;
  const info = cameraSystem?.getCameraInfo?.();
  if (!info?.target) return null;
  // Entity-interval callers need node.position (Vector3); RAF needs target.position ({x,z}).
  // Return the first available position shape.
  const pos = info.target.node?.position ?? info.target.position;
  if (!pos) return null;
  return { id: info.target.id, position: { x: pos.x, z: pos.z } };
}

/** Color palette for group members (up to 8 unique) */
const GROUP_COLORS = [
  "#4CAF50", // Green - party leader
  "#2196F3", // Blue
  "#9C27B0", // Purple
  "#FF9800", // Orange
  "#00BCD4", // Cyan
  "#E91E63", // Pink
  "#CDDC39", // Lime
  "#607D8B", // Blue-grey
];

/**
 * Draw a star shape on canvas for quest markers
 */
function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  points: number = 5,
): void {
  const step = Math.PI / points;
  ctx.beginPath();
  for (let i = 0; i < 2 * points; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = i * step - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

/**
 * Draw a diamond shape on canvas
 */
function drawDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - size); // Top
  ctx.lineTo(cx + size, cy); // Right
  ctx.lineTo(cx, cy + size); // Bottom
  ctx.lineTo(cx - size, cy); // Left
  ctx.closePath();
}

/**
 * Draw a red flag destination marker (modern MMORPG-style)
 * Simple: thin pole + small filled triangle flag
 */
function drawFlag(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  // Pole
  ctx.strokeStyle = "#880000";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy + 3);
  ctx.lineTo(cx, cy - 5);
  ctx.stroke();

  // Flag (small filled triangle off the pole)
  ctx.fillStyle = "#ff0000";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx + 5, cy - 3);
  ctx.lineTo(cx, cy - 1);
  ctx.closePath();
  ctx.fill();
}

/**
 * Flyweight icon cache: each distinct subType is rendered exactly ONCE into a
 * 16×16 OffscreenCanvas and stored here.  Every subsequent call uses drawImage()
 * which is GPU-accelerated and ~10–20× faster than re-executing path drawing code.
 *
 * The cache is populated lazily so fonts are guaranteed to be loaded by first use.
 */
const _iconCache = new Map<string, OffscreenCanvas | null>();
const _ICON_SIZE = 16;

function _renderIconOnce(subType: string): OffscreenCanvas | null {
  const offscreen = new OffscreenCanvas(_ICON_SIZE, _ICON_SIZE);
  const raw = offscreen.getContext("2d");
  if (!raw) return null;
  // OffscreenCanvasRenderingContext2D satisfies all properties in the extended
  // MinimapDrawContext intersection — this cast is safe.
  const ictx = raw as Parameters<typeof _drawIconGlyph>[0];
  const cx = _ICON_SIZE / 2;
  const cy = _ICON_SIZE / 2;
  const drawn = _drawIconGlyph(ictx, cx, cy, subType);
  return drawn ? offscreen : null;
}

/**
 * Draw minimap icon for a location type.
 * Returns true if drawn, false for unknown subType (caller falls back to a dot).
 *
 * On first call per subType, renders to an OffscreenCanvas and caches it.
 * All subsequent calls use drawImage() — zero path drawing overhead.
 */
function drawMinimapIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  subType: string,
): boolean {
  let icon = _iconCache.get(subType);
  if (icon === undefined) {
    // First time — render and cache (null = unknown type, skip caching a blank canvas)
    icon = _renderIconOnce(subType);
    _iconCache.set(subType, icon);
  }
  if (!icon) return false;
  ctx.drawImage(
    icon,
    cx - _ICON_SIZE / 2,
    cy - _ICON_SIZE / 2,
    _ICON_SIZE,
    _ICON_SIZE,
  );
  return true;
}

/** Inner glyph renderer — only called once per subType. */
function _drawIconGlyph(
  ctx: MinimapDrawContext & {
    font: string;
    textAlign: "left" | "right" | "center" | "start" | "end";
    textBaseline:
      "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom";
    fillText(text: string, x: number, y: number): void;
    fillRect(x: number, y: number, w: number, h: number): void;
    strokeRect(x: number, y: number, w: number, h: number): void;
    arc(x: number, y: number, r: number, sA: number, eA: number): void;
    ellipse(
      x: number,
      y: number,
      rX: number,
      rY: number,
      rot: number,
      sA: number,
      eA: number,
    ): void;
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  },
  cx: number,
  cy: number,
  subType: string,
): boolean {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#000000";

  switch (subType) {
    // Zone safety does not imply a town/building: use a shield, not a house.
    case "zone_safe":
      ctx.fillStyle = "#82b8a0";
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy - 5);
      ctx.lineTo(cx + 5, cy - 5);
      ctx.lineTo(cx + 4, cy + 2);
      ctx.lineTo(cx, cy + 6);
      ctx.lineTo(cx - 4, cy + 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;

    case "zone_arena":
      // Crisp, cached crossed blades; no platform emoji or baked glow.
      ctx.lineCap = "round";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + 5);
      ctx.lineTo(cx + 5, cy - 5);
      ctx.moveTo(cx + 5, cy + 5);
      ctx.lineTo(cx - 5, cy - 5);
      ctx.stroke();
      ctx.strokeStyle = "#d9dfdf";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = "#b39b67";
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy + 1);
      ctx.lineTo(cx - 1, cy + 6);
      ctx.moveTo(cx + 1, cy + 6);
      ctx.lineTo(cx + 6, cy + 1);
      ctx.stroke();
      break;

    // --- Bank: gold coin ($) ---
    case "bank":
      ctx.fillStyle = "#daa520";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("$", cx + 0.5, cy + 1);
      break;

    // --- Shop: small open-top bag ---
    case "shop":
      ctx.fillStyle = "#daa520";
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy - 4);
      ctx.lineTo(cx - 4, cy + 5);
      ctx.lineTo(cx + 4, cy + 5);
      ctx.lineTo(cx + 5, cy - 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;

    // --- Prayer altar: simple cross ---
    case "altar":
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - 1.5, cy - 6, 3, 12);
      ctx.fillRect(cx - 5, cy - 2.5, 10, 3);
      ctx.strokeRect(cx - 1.5, cy - 6, 3, 12);
      ctx.strokeRect(cx - 5, cy - 2.5, 10, 3);
      break;

    // --- Runecrafting altar: purple circle ---
    case "runecrafting_altar":
      ctx.fillStyle = "#7744cc";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("R", cx + 0.5, cy + 1);
      break;

    // --- Anvil: dark flat anvil silhouette ---
    case "anvil":
      ctx.fillStyle = "#666666";
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy + 4);
      ctx.lineTo(cx - 4, cy - 1);
      ctx.lineTo(cx - 5, cy - 4);
      ctx.lineTo(cx + 5, cy - 4);
      ctx.lineTo(cx + 4, cy - 1);
      ctx.lineTo(cx + 6, cy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;

    // --- Furnace: orange circle with flame ---
    case "furnace":
      ctx.fillStyle = "#dd5500";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Simple flame (inverted drop)
      ctx.fillStyle = "#ffcc00";
      ctx.beginPath();
      ctx.moveTo(cx, cy - 4);
      ctx.quadraticCurveTo(cx + 3, cy + 1, cx, cy + 4);
      ctx.quadraticCurveTo(cx - 3, cy + 1, cx, cy - 4);
      ctx.fill();
      break;

    // --- Cooking range: brown circle with steam ---
    case "range":
      ctx.fillStyle = "#8b5e3c";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Two short steam lines
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 2, cy + 1);
      ctx.lineTo(cx - 2, cy - 3);
      ctx.moveTo(cx + 2, cy + 1);
      ctx.lineTo(cx + 2, cy - 3);
      ctx.stroke();
      break;

    // --- Fishing spot: cyan dot with fish ---
    case "fishing":
      ctx.fillStyle = "#2288cc";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.stroke();
      // Tiny fish shape
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(cx - 1, cy, 3.5, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      // Tail
      ctx.beginPath();
      ctx.moveTo(cx + 2.5, cy);
      ctx.lineTo(cx + 5, cy - 2.5);
      ctx.lineTo(cx + 5, cy + 2.5);
      ctx.closePath();
      ctx.fill();
      break;

    // --- Mining rock: brown dot with pickaxe ---
    case "mining":
      ctx.fillStyle = "#8b6914";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.stroke();
      // Diagonal pick handle
      ctx.strokeStyle = "#dddddd";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 3.5, cy + 3.5);
      ctx.lineTo(cx + 3.5, cy - 3.5);
      ctx.stroke();
      // Pick head
      ctx.beginPath();
      ctx.moveTo(cx + 1, cy - 5);
      ctx.lineTo(cx + 5, cy - 1);
      ctx.stroke();
      break;

    // --- Tree: green circle ---
    case "tree":
      ctx.fillStyle = "#228822";
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#115511";
      ctx.stroke();
      break;

    // --- Quest NPC (available): blue circle with white "!" ---
    case "quest_available":
    case "quest":
      ctx.fillStyle = "#2196F3";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", cx + 0.5, cy + 1);
      break;

    // --- Quest NPC (in progress): blue circle with white "?" ---
    case "quest_in_progress":
      ctx.fillStyle = "#2196F3";
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", cx + 0.5, cy + 1);
      break;

    default:
      ctx.restore();
      return false;
  }

  ctx.restore();
  return true;
}

/** Terrain system interface used for height sampling and click-to-move */
interface TerrainSystemLike {
  getHeightAt: (x: number, z: number) => number;
  getWaterBodyRegistry?: () => {
    getWaterSurfaceAt: (x: number, z: number) => number;
  };
}

/** Network send interface needed for server-authoritative move requests */
interface WorldNetworkSend {
  network: { send: (method: string, data: unknown) => void };
}

/** Minimal structural interface for elements that can be rotated via inline style */
interface CSSStylable {
  style: { transform: string };
}

/** Drag handle props passed from Window component for edit mode dragging */
interface DragHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  style: React.CSSProperties;
}

interface MinimapProps {
  world: ClientWorld;
  width?: number;
  height?: number;
  zoom?: number;
  className?: string;
  style?: React.CSSProperties;
  onCompassClick?: () => void;
  isVisible?: boolean;
  /** If true, minimap can be resized by dragging corners */
  resizable?: boolean;
  /** Callback when size changes */
  onSizeChange?: (width: number, height: number) => void;
  /** Minimum size when resizable */
  minSize?: number;
  /** Maximum size when resizable */
  maxSize?: number;
  /** If true, removes decorative border/shadow for embedding in panels */
  embedded?: boolean;
  /** If true, minimap can be collapsed to a corner icon */
  collapsible?: boolean;
  /** Initial collapsed state */
  defaultCollapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapseChange?: (collapsed: boolean) => void;
  /** Drag handle props for edit mode (passed from Window component) */
  dragHandleProps?: DragHandleProps;
  /** Whether edit mode is unlocked (shows drag border) */
  isUnlocked?: boolean;
}

function MinimapInner({
  world,
  width: initialWidth = 200,
  height: initialHeight = 200,
  zoom = 10,
  className = "",
  style = {},
  onCompassClick: _onCompassClick,
  isVisible = true,
  resizable = true,
  onSizeChange,
  minSize = 80,
  maxSize,
  embedded: _embedded = false,
  collapsible = false,
  defaultCollapsed = false,
  onCollapseChange,
  dragHandleProps,
  isUnlocked = false,
}: MinimapProps) {
  const theme = useThemeStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const entityPipsRefForRender = useRef<EntityPip[]>([]);
  const entityCacheRef = useRef<Map<string, EntityPip>>(new Map());
  const roadPixelBufRef = useRef(new Float32Array(4096 * 2));
  const projectedRoadsRef = useRef<ProjectedRoad[]>([]);
  // Per-instance render state — isolated from other Minimap instances
  const renderStateRef = useRef<MinimapRenderState>(createRenderState());

  const {
    terrainOffscreenRef,
    terrainCacheCenterRef,
    terrainCacheExtentRef,
    terrainCacheUpRef,
    invalidateTerrainCache,
    clearTerrainCache,
    ensureTerrainCache,
  } = useMinimapTerrainCache(world);

  // Cached 2D rendering contexts — avoids DOM query every frame
  const mainCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const overlayCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Static world feature caches — populated once, used for overlay with fixed pixel sizes
  const roadsCacheRef = useRef<MinimapRoad[] | null>(null);
  // Roads enriched with pre-computed AABBs — built once when the road cache is first
  // populated so the per-frame visibility check is O(1) instead of O(path_length).
  const roadsWithAABBRef = useRef<MinimapRoadWithAABB[] | null>(null);
  const townsCacheRef = useRef<MinimapTown[] | null>(null);

  // Quest statuses for minimap quest icons (ref for access in entity loop)
  const questStatusesRef = useRef<Map<string, string>>(new Map());
  const setQuestStatuses = useQuestSelectionStore((s) => s.setQuestStatuses);

  useQuestStatusSync({ world, questStatusesRef, setQuestStatuses });

  // Collapsed state for collapsible minimap
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  // Handle collapse toggle
  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const newValue = !prev;
      onCollapseChange?.(newValue);
      return newValue;
    });
  }, [onCollapseChange]);

  // Current size state (for resizing)
  const [currentWidth, setCurrentWidth] = useState(initialWidth);
  const [currentHeight, setCurrentHeight] = useState(initialHeight);
  const width = currentWidth;
  const height = currentHeight;

  // Refs for width/height to allow RAF loop to access current values without stale closures
  const widthRef = useRef(width);
  const heightRef = useRef(height);

  // Keep dimension refs updated for RAF loop access
  useEffect(() => {
    widthRef.current = width;
    heightRef.current = height;
  }, [width, height]);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Tracks the latest clamped size so handleUp always reads the post-drag value,
  // not the stale closure-captured size from when the pointerdown fired.
  const latestSizeRef = useRef({ w: initialWidth, h: initialHeight });

  // Calculate extent based on size - larger size = more visible area (not scaled)
  // Use the average of width/height to determine extent
  const sizeBasedExtent = useMemo(() => {
    const avgSize = (width + height) / 2;
    return zoom * (avgSize / MINIMAP_BASE_SIZE_PX);
  }, [width, height, zoom]);

  // Minimap zoom state (orthographic half-extent in world units)
  const [targetExtent, setTargetExtent] = useState<number>(sizeBasedExtent);
  const targetExtentRef = useRef<number>(targetExtent);
  const extentRef = useRef<number>(targetExtent); // Live displayed extent for render loop
  // Update extent when size changes (reveals more map)
  useEffect(() => {
    setTargetExtent(sizeBasedExtent);
  }, [sizeBasedExtent]);

  // Always rotate with the main camera (modern MMORPG-style).
  const rotateWithCameraRef = useRef<boolean>(true);
  // Direct ref to the collapsed compass SVG — yaw is written via DOM to avoid
  // triggering React reconciliation from inside requestAnimationFrame.
  const compassRef = useRef<CSSStylable | null>(null);

  // Destination in world space — written by handleMinimapClick, cleared by RAF on arrival.
  // Ref-only: the RAF loop reads it synchronously, no React state needed.
  const lastDestinationWorldRef = useRef<{ x: number; z: number } | null>(null);
  // Debounce: ignore minimap clicks within 150ms of the previous one to prevent
  // flooding the server with moveRequest packets during accidental double-clicks.
  const lastClickTimeRef = useRef<number>(0);

  // Initialize minimap camera (no WebGPU renderer needed — Canvas 2D handles all drawing)
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!canvas || !overlayCanvas) return;

    // Create orthographic camera for overhead view
    const camera = new THREE.OrthographicCamera(
      -targetExtentRef.current,
      targetExtentRef.current,
      targetExtentRef.current,
      -targetExtentRef.current,
      0.1,
      2000,
    );
    // Orient minimap to match main camera heading on XZ plane
    const initialForward = new THREE.Vector3();
    if (world?.camera) {
      world.camera.getWorldDirection(initialForward);
    } else {
      initialForward.set(0, 0, -1);
    }
    initialForward.y = 0;
    if (initialForward.lengthSq() < 0.0001) {
      initialForward.set(0, 0, -1);
    } else {
      initialForward.normalize();
    }
    camera.up.copy(initialForward);
    camera.position.set(0, 500, 0);
    camera.lookAt(0, 0, 0);

    // Mark camera as minimap for systems that need to check (e.g., water system)
    camera.userData.isMinimap = true;

    cameraRef.current = camera;

    // Ensure both canvases have the correct backing size
    canvas.width = width;
    canvas.height = height;
    overlayCanvas.width = width;
    overlayCanvas.height = height;

    // Cache 2D contexts once (getContext is a DOM query — avoid calling every frame)
    mainCtxRef.current = canvas.getContext("2d");
    overlayCtxRef.current = overlayCanvas.getContext("2d");

    // Invalidate terrain cache when canvas dimensions change
    invalidateTerrainCache();

    // Note: extent intentionally omitted - changes handled via extentRef in render loop
  }, [width, height, world]);

  // Cleanup camera reference and terrain cache when component unmounts
  useEffect(() => {
    return () => {
      // Clear camera reference and userData
      if (cameraRef.current) {
        cameraRef.current.userData = {};
        cameraRef.current = null;
      }

      clearTerrainCache();
      roadsCacheRef.current = null;
      roadsWithAABBRef.current = null;
      townsCacheRef.current = null;

      // Clear entity cache to prevent memory retention
      entityCacheRef.current.clear();
      // Clear icon flyweight cache so OffscreenCanvas objects can be GC'd
      _iconCache.clear();
      // Remove any dangling resize listeners if unmounted mid-drag
      resizeCleanupRef.current?.();
    };
  }, [clearTerrainCache]);

  // Keep extent ref in sync with state for render loop access
  useEffect(() => {
    targetExtentRef.current = targetExtent;
  }, [targetExtent]);

  useMinimapEntityPips({
    world,
    isVisible,
    extentRef,
    questStatusesRef,
    entityPipsRefForRender,
    entityCacheRef,
  });
  useMinimapWorldCaches({
    world,
    roadsCacheRef,
    roadsWithAABBRef,
    townsCacheRef,
  });

  // Single unified render loop - handles camera position, frustum, and rendering
  // Uses refs for all state access to avoid restarting the RAF loop
  useEffect(() => {
    const overlayCanvas = overlayCanvasRef.current;
    if (!overlayCanvas || !isVisible) return;

    let rafId: number | null = null;
    let frameCount = 0;
    // Candidate-only, matching the world-marker policy at session startup.
    // Broadcast/embedded spectator viewports resolve to "none".
    const showZoneNavigation = resolveZoneNavigationMode() === "minimap-v1";

    const render = () => {
      frameCount++;
      // Cache time once per frame — reused for pulse animations, avoids Date.now() per-pip
      const frameTimeMs = performance.now();
      const cam = cameraRef.current;

      // Destructure per-instance render state — object aliases let us mutate through them
      // without changing any of the hot-path code that uses these names.
      const rs = renderStateRef.current;
      const _tempForwardVec = rs.forwardVec;
      const _tempProjectVec = rs.projectVec;
      const _tempDestVec = rs.destVec;
      const _tempTargetPos = rs.targetPos;
      const _cachedProjectionViewMatrix = rs.projectionViewMatrix;

      // --- Camera Position Update (follow player or spectated entity) ---
      const player = world.entities?.player as Entity | undefined;
      let hasTarget = false;

      if (player) {
        // Normal mode: follow local player
        _tempTargetPos.x = player.node.position.x;
        _tempTargetPos.z = player.node.position.z;
        hasTarget = true;
      } else {
        // Spectator mode: get camera target from camera system
        const spectatorTarget = getSpectatorTarget(world);
        if (spectatorTarget) {
          _tempTargetPos.x = spectatorTarget.position.x;
          _tempTargetPos.z = spectatorTarget.position.z;
          hasTarget = true;
        }
      }

      if (cam && hasTarget) {
        // Keep centered on target (player or spectated entity)
        // Using pre-allocated _tempTargetPos to avoid GC pressure
        cam.position.x = _tempTargetPos.x;
        cam.position.z = _tempTargetPos.z;
        cam.lookAt(_tempTargetPos.x, 0, _tempTargetPos.z);

        // Rotate minimap with main camera yaw if enabled
        if (rotateWithCameraRef.current && world.camera) {
          const worldCam = world.camera;
          // Reuse pre-allocated vector to avoid GC pressure
          worldCam.getWorldDirection(_tempForwardVec);
          _tempForwardVec.y = 0;
          if (_tempForwardVec.lengthSq() > 1e-6) {
            _tempForwardVec.normalize();
            // Compute yaw so that up vector rotates the minimap
            const yaw = Math.atan2(_tempForwardVec.x, -_tempForwardVec.z);
            const upX = Math.sin(yaw);
            const upZ = -Math.cos(yaw);
            cam.up.set(upX, 0, upZ);
            // Update compass arrow via direct DOM write — no React re-render
            if (compassRef.current) {
              compassRef.current.style.transform = `rotate(${THREE.MathUtils.radToDeg(yaw)}deg)`;
            }
          }
        } else {
          cam.up.set(0, 0, -1);
        }

        // Clear destination when reached
        const destWorld = lastDestinationWorldRef.current;
        if (destWorld) {
          const dx = destWorld.x - _tempTargetPos.x;
          const dz = destWorld.z - _tempTargetPos.z;
          if (dx * dx + dz * dz < 0.36) {
            lastDestinationWorldRef.current = null;
          }
        }

        // Also clear global raycast target when player reaches it
        const hw = window as HyperiaWindow;
        if (hw.__lastRaycastTarget) {
          const dx = hw.__lastRaycastTarget.x - _tempTargetPos.x;
          const dz = hw.__lastRaycastTarget.z - _tempTargetPos.z;
          if (dx * dx + dz * dz < 0.36) delete hw.__lastRaycastTarget;
        }
      }

      // --- Camera Frustum Update (for zoom) ---
      if (cam) {
        const currentExtent = extentRef.current;
        const desiredExtent = targetExtentRef.current;
        if (Math.abs(desiredExtent - currentExtent) > 0.01) {
          const zoomDelta = desiredExtent - currentExtent;
          const zoomStep =
            Math.sign(zoomDelta) *
            Math.min(60, Math.max(2, Math.abs(zoomDelta) * 0.24));
          const nextExtent =
            Math.abs(zoomDelta) <= Math.abs(zoomStep)
              ? desiredExtent
              : currentExtent + zoomStep;
          extentRef.current = nextExtent;
        }
        const liveExtent = extentRef.current;
        if (cam.right !== liveExtent) {
          cam.left = -liveExtent;
          cam.right = liveExtent;
          cam.top = liveExtent;
          cam.bottom = -liveExtent;
          cam.updateProjectionMatrix();
        }
      }

      // --- Update camera matrices every frame for smooth pip rendering ---
      // Pips represent live entity positions and must stay fluid at 60fps.
      // Road/building overlays use the terrain-snapshot parameters (below) so they
      // remain locked to the terrain ImageData regardless of this live matrix.
      if (cam) {
        cam.updateMatrixWorld();
        _cachedProjectionViewMatrix.multiplyMatrices(
          cam.projectionMatrix,
          cam.matrixWorldInverse,
        );
        rs.hasCachedMatrix = true;
      }

      // --- Canvas 2D terrain background (throttled, same cadence as old 3D render) ---
      const shouldRedrawTerrain = frameCount % RENDER_EVERY_N_FRAMES === 0;
      if (shouldRedrawTerrain && cam) {
        const mainCanvas = canvasRef.current;
        // Use cached context — avoids a DOM query every frame
        const mainCtx = mainCtxRef.current;
        if (mainCanvas && mainCtx) {
          {
            const cw = mainCanvas.width;
            const ch = mainCanvas.height;

            // Snapshot camera state — used for both terrain generation and overlay drawing
            // so all layers are guaranteed to be aligned with each other.
            const centerX = cam.position.x;
            const centerZ = cam.position.z;
            const currentExtent = extentRef.current;
            const upX = cam.up.x;
            const upZ = cam.up.z;

            // Compute the rotation delta between the live camera and the cached terrain angle.
            // KEY INSIGHT: rotating the canvas context by +deltaYaw around the canvas center
            // is mathematically equivalent to re-drawing everything with the live worldToPx
            // camera orientation (proven by coordinate algebra). This means terrain, roads,
            // and buildings all rotate INSTANTLY without needing terrain regeneration.
            const cachedYaw = Math.atan2(
              terrainCacheUpRef.current.x,
              -terrainCacheUpRef.current.z,
            );
            const currentYaw = Math.atan2(upX, -upZ);
            const deltaYaw = currentYaw - cachedYaw;

            // Terrain regeneration is triggered by POSITION or EXTENT change only —
            // NOT by camera rotation (canvas rotation handles that instantly).
            // This eliminates the restart-cancel deadlock: previously, every 4-frame
            // terrain check during rotation would increment the version token and cancel
            // the in-flight generation before it could finish, freezing the minimap.
            ensureTerrainCache({
              centerX,
              centerZ,
              currentExtent,
              upX,
              upZ,
              viewportPixels: Math.max(cw, ch),
            });

            // Apply a single canvas rotation transform so terrain + all vector overlays
            // rotate to the live camera orientation in one GPU operation.
            // Negative deltaYaw so minimap rotates same direction as camera (canvas
            // positive angle = clockwise; user "rotate left" = counterclockwise = we need -deltaYaw).
            mainCtx.save();
            mainCtx.translate(cw / 2, ch / 2);
            mainCtx.rotate(-deltaYaw);
            mainCtx.translate(-cw / 2, -ch / 2);

            if (terrainOffscreenRef.current) {
              mainCtx.imageSmoothingEnabled = true;
              mainCtx.imageSmoothingQuality = "high";
              const cachedExt = terrainCacheExtentRef.current;
              const extentScale = cachedExt > 0 ? cachedExt / currentExtent : 1;
              // Draw stale snapshots at their true world scale. When rapidly
              // zooming out, keep at least viewport coverage so we never expose
              // a hard black box while the replacement cache is generated.
              const drawScale = Math.max(1 / TERRAIN_OVERSHOOT, extentScale);
              const drawW = cw * TERRAIN_OVERSHOOT * drawScale;
              const drawH = ch * TERRAIN_OVERSHOOT * drawScale;
              const cachedUpX = terrainCacheUpRef.current.x;
              const cachedUpZ = terrainCacheUpRef.current.z;
              const cachedRightX = -cachedUpZ;
              const cachedRightZ = cachedUpX;
              const cachedCenterX = terrainCacheCenterRef.current.x;
              const cachedCenterZ = terrainCacheCenterRef.current.z;
              const centerDeltaX = centerX - cachedCenterX;
              const centerDeltaZ = centerZ - cachedCenterZ;
              // Project center deltas into the cached terrain basis, not the
              // live camera basis. The cached image is authored in that older
              // orientation and then globally rotated above via deltaYaw.
              const offsetRight =
                centerDeltaX * cachedRightX + centerDeltaZ * cachedRightZ;
              const offsetUp =
                centerDeltaX * cachedUpX + centerDeltaZ * cachedUpZ;
              const pixelsPerWorldX = cw / (2 * currentExtent);
              const pixelsPerWorldY = ch / (2 * currentExtent);
              const offsetX = -offsetRight * pixelsPerWorldX;
              const offsetY = offsetUp * pixelsPerWorldY;
              mainCtx.fillStyle = "#11161c";
              mainCtx.fillRect(0, 0, cw, ch);
              mainCtx.drawImage(
                terrainOffscreenRef.current,
                cw / 2 - drawW / 2 + offsetX,
                ch / 2 - drawH / 2 + offsetY,
                drawW,
                drawH,
              );
            } else {
              // Fallback: dark background until terrain system is ready
              mainCtx.fillStyle = "#11161c";
              mainCtx.fillRect(0, 0, cw, ch);
            }

            // Restore canvas transform — terrain only, no overlays here
            mainCtx.restore();
          }
        }
      }

      // Draw 2D overlay (roads → buildings → zone POIs → pips → flag) every frame
      const ctx = overlayCtxRef.current;
      if (ctx) {
        const cw = overlayCanvas.width;
        const ch = overlayCanvas.height;
        const viewportW = widthRef.current;
        const viewportH = heightRef.current;
        ctx.clearRect(0, 0, cw, ch);

        // ── Roads & buildings ─────────────────────────────────────────────────
        // Same camera-matrix projection as entity pips — moves, zooms, and
        // rotates in perfect sync with no separate coordinate system.
        if (rs.hasCachedMatrix && cam) {
          const currentExtent = extentRef.current;
          drawRoadsAndBuildingsOverlay(
            ctx,
            roadsWithAABBRef.current,
            townsCacheRef.current,
            roadPixelBufRef,
            projectedRoadsRef,
            _cachedProjectionViewMatrix,
            _tempProjectVec,
            cam.position.x,
            cam.position.z,
            currentExtent * 2,
            // pixels per world unit — drives road width scaling with zoom
            cw / (2 * currentExtent),
            cw,
            ch,
          );
        }

        if (showZoneNavigation && rs.hasCachedMatrix && cam && hasTarget) {
          const navigation = rs.zoneNavigation;
          updateMinimapZoneNavigation(
            navigation,
            ALL_WORLD_AREAS,
            _cachedProjectionViewMatrix.elements,
            _tempTargetPos.x,
            _tempTargetPos.z,
            cw,
            ch,
          );
          ctx.save();
          // Keep this overlay's drawing inside its canvas viewport.
          ctx.beginPath();
          ctx.rect(0, 0, cw, ch);
          ctx.clip();
          for (let index = 0; index < navigation.count; index++) {
            const marker = navigation.markers[index];
            drawMinimapIcon(
              ctx,
              marker.x,
              marker.y,
              marker.kind === "safe" ? "zone_safe" : "zone_arena",
            );
            if (marker.offMap) {
              const ux = marker.directionX;
              const uy = marker.directionY;
              ctx.beginPath();
              ctx.moveTo(
                marker.x + ux * 8 - uy * 3,
                marker.y + uy * 8 + ux * 3,
              );
              ctx.lineTo(marker.x + ux * 11, marker.y + uy * 11);
              ctx.lineTo(
                marker.x + ux * 8 + uy * 3,
                marker.y + uy * 8 - ux * 3,
              );
              ctx.strokeStyle = "#172321";
              ctx.lineWidth = 3;
              ctx.stroke();
              ctx.strokeStyle = "#e0e8e2";
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
          ctx.restore();
        }

        // ── Entity pips ───────────────────────────────────────────────────────
        const pipsArray = entityPipsRefForRender.current;
        // World-space cull radius: extent + small pip margin so pips near the edge
        // aren't clipped mid-frame. 8 world units covers the largest icon (16px icon
        // at typical zoom ≈ 4 world units; double for safety).
        const pipCullRadius = extentRef.current + 8;
        const camPX = cam ? cam.position.x : 0;
        const camPZ = cam ? cam.position.z : 0;
        for (let pipIdx = 0; pipIdx < pipsArray.length; pipIdx++) {
          const pip = pipsArray[pipIdx];
          // World-space pre-cull: skip projection entirely for off-screen pips.
          // Uses Chebyshev distance (max of |dx|, |dz|) — tighter than circle,
          // safe because the minimap is square-ish.
          if (
            Math.abs(pip.position.x - camPX) > pipCullRadius ||
            Math.abs(pip.position.z - camPZ) > pipCullRadius
          )
            continue;

          // Convert world position to screen position using cached matrix
          // This keeps pips synced with the throttled 3D render (not the live camera)
          if (rs.hasCachedMatrix) {
            // Reuse pre-allocated vector instead of cloning to avoid GC pressure
            _tempProjectVec.copy(pip.position);
            // Apply cached projection-view matrix manually instead of using project()
            _tempProjectVec.applyMatrix4(_cachedProjectionViewMatrix);

            // Use refs for width/height to avoid stale closure values during resize
            const x = (_tempProjectVec.x * 0.5 + 0.5) * viewportW;
            const y = (_tempProjectVec.y * -0.5 + 0.5) * viewportH;

            // Only draw if within bounds (use refs for current dimensions)
            if (x >= 0 && x <= viewportW && y >= 0 && y <= viewportH) {
              // Pip radius — default 3px; player and quest are the only exceptions
              let radius = 3;
              const borderColor = "#000000";
              const borderWidth = 1;
              if (pip.type === "player") {
                radius =
                  pip.groupIndex !== undefined && pip.groupIndex >= 0 ? 4 : 3;
              } else if (pip.type === "quest") {
                radius = pip.isActive ? 7 : 5;
              }

              // Determine pip color (group members use GROUP_COLORS)
              let pipColor = pip.color;
              if (
                pip.type === "player" &&
                pip.groupIndex !== undefined &&
                pip.groupIndex >= 0
              ) {
                pipColor = GROUP_COLORS[pip.groupIndex % GROUP_COLORS.length];
              }

              // Apply pulse animation for active pips (quests, etc.)
              let pulseScale = 1;
              if (pip.isActive) {
                // frameTimeMs is cached once per frame — avoid per-pip Date.now() call
                const pulseTime = frameTimeMs / 500; // 500ms per cycle
                pulseScale = 1 + 0.15 * Math.sin(pulseTime * Math.PI * 2);
              }

              // Draw pip — subtype icons use drawImage (no path needed).
              // beginPath() is deferred past the icon check to avoid building
              // a path that gets discarded for every icon-bearing pip.
              ctx.fillStyle = pipColor;

              if (pip.subType && drawMinimapIcon(ctx, x, y, pip.subType)) {
                // Icon drawn via cached OffscreenCanvas — no path work needed
              } else if (pip.isLocalPlayer) {
                // modern MMORPG/classic MMORPG: local player is a white square (slightly larger than dots)
                const sqHalf = 2.5;
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(x - sqHalf, y - sqHalf, sqHalf * 2, sqHalf * 2);
              } else if (pip.type === "quest" || pip.icon === "star") {
                // Star for quest markers.
                // Shadow is set BEFORE the fill so one draw call produces both
                // the solid star and its glow ring — then cleared before stroke
                // so the outline stays crisp with no halo artefacts.
                const scaledRadius = radius * pulseScale;
                if (pip.isActive) {
                  ctx.shadowColor = pipColor;
                  ctx.shadowBlur = 8;
                }
                drawStar(ctx, x, y, scaledRadius, scaledRadius * 0.5, 5);
                ctx.fill();
                ctx.shadowBlur = 0; // reset before stroke
                ctx.strokeStyle = borderColor;
                ctx.lineWidth = borderWidth;
                ctx.stroke();
              } else if (pip.icon === "diamond") {
                // Diamond shape
                drawDiamond(ctx, x, y, radius);
                ctx.fill();
                ctx.strokeStyle = borderColor;
                ctx.lineWidth = borderWidth;
                ctx.stroke();
              } else {
                // Circle for everything else (players, mobs, items)
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, 2 * Math.PI);
                ctx.fill();

                // Add border for better visibility
                ctx.strokeStyle = borderColor;
                ctx.lineWidth = borderWidth;
                ctx.stroke();
              }
            }
          }
        }

        // Draw destination like world clicks: project world target to minimap
        const lastTarget = (window as HyperiaWindow).__lastRaycastTarget;
        const destWorldRef = lastDestinationWorldRef.current;
        const hasLastTarget =
          lastTarget &&
          Number.isFinite(lastTarget.x) &&
          Number.isFinite(lastTarget.z);
        const targetX = hasLastTarget ? lastTarget.x : destWorldRef?.x;
        const targetZ = hasLastTarget ? lastTarget.z : destWorldRef?.z;

        if (
          rs.hasCachedMatrix &&
          targetX !== undefined &&
          targetZ !== undefined
        ) {
          // Reuse pre-allocated vector instead of creating new one
          _tempDestVec.set(targetX, 0, targetZ);
          // Apply cached projection-view matrix to stay synced with throttled 3D render
          _tempDestVec.applyMatrix4(_cachedProjectionViewMatrix);
          // Use refs for width/height to avoid stale closure values during resize
          const sx = (_tempDestVec.x * 0.5 + 0.5) * viewportW;
          const sy = (_tempDestVec.y * -0.5 + 0.5) * viewportH;
          // modern MMORPG-style red flag destination marker
          drawFlag(ctx, sx, sy);
        }
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [isVisible, world]);

  // Convert a click in the minimap to a world XZ position
  const screenToWorldXZ = useCallback(
    (clientX: number, clientY: number): { x: number; z: number } | null => {
      const cam = cameraRef.current;
      const cvs = overlayCanvasRef.current || canvasRef.current;
      if (!cam || !cvs) return null;

      const rect = cvs.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
      // Per-instance scratch vector — safe when multiple Minimaps exist simultaneously
      const vec = renderStateRef.current.unprojectVec;
      vec.set(ndcX, ndcY, 0);
      vec.unproject(cam);
      return { x: vec.x, z: vec.z };
    },
    [],
  );

  // Shared click handler core
  const handleMinimapClick = useCallback(
    (clientX: number, clientY: number) => {
      // Debounce: drop clicks within 150ms to prevent moveRequest flooding
      const now = performance.now();
      if (now - lastClickTimeRef.current < 150) return;
      lastClickTimeRef.current = now;

      const worldPos = screenToWorldXZ(clientX, clientY);
      if (!worldPos) return;

      const player = world.entities?.player as
        { position?: { x: number; z: number }; runMode?: boolean } | undefined;
      if (!player?.position) return;
      const dx = worldPos.x - player.position.x;
      const dz = worldPos.z - player.position.z;
      const dist = Math.hypot(dx, dz);
      let targetX = worldPos.x;
      let targetZ = worldPos.z;
      if (dist > INPUT.MAX_CLICK_DISTANCE_TILES) {
        const scale = INPUT.MAX_CLICK_DISTANCE_TILES / dist;
        targetX = player.position.x + dx * scale;
        targetZ = player.position.z + dz * scale;
      }

      const terrainSystem = world.getSystem("terrain") as unknown as
        TerrainSystemLike | null | undefined;
      let targetY = 0;
      if (terrainSystem?.getHeightAt) {
        const h = terrainSystem.getHeightAt(targetX, targetZ);
        targetY = (Number.isFinite(h) ? h : 0) + 0.1;
      }

      // Send server-authoritative move request instead of local movement
      const currentRun = (player as { runMode?: boolean }).runMode === true;
      (world as unknown as WorldNetworkSend).network.send("moveRequest", {
        target: [targetX, targetY, targetZ],
        runMode: currentRun,
        cancel: false,
      });

      // Persist destination until arrival (no auto-fade)
      lastDestinationWorldRef.current = { x: targetX, z: targetZ };
      // Expose same diagnostic target used by world clicks so minimap renders dot identically
      (window as HyperiaWindow).__lastRaycastTarget = {
        x: targetX,
        y: targetY,
        z: targetZ,
        method: "minimap",
      };
    },
    [screenToWorldXZ, world],
  );

  const onOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      e.stopPropagation();
      handleMinimapClick(e.clientX, e.clientY);
    },
    [handleMinimapClick],
  );

  // Stable prevent-default-only handler — no deps, never recreated
  const onPreventDefault = useCallback(
    (e: React.SyntheticEvent) => e.preventDefault(),
    [],
  );

  // Stable stop-propagation + prevent-default handler for canvas events
  const onStopAndPrevent = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Collapse button click — same as toggleCollapse but also swallows the event
  const onCollapseButtonClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCollapse();
    },
    [toggleCollapse],
  );

  // Wheel handler for minimap zoom - uses native WheelEvent for passive: false support
  // Uses functional update to ensure correct extent value during rapid scrolling
  // No dependencies - handler is stable and listener doesn't need to be re-attached
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const sign = Math.sign(e.deltaY);
      if (sign === 0) return;
      // Notched steps for smooth zoom
      const steps = Math.max(
        1,
        Math.min(5, Math.round(Math.abs(e.deltaY) / 100)),
      );
      // Use functional update to always have the latest extent value
      setTargetExtent((prev) =>
        THREE.MathUtils.clamp(
          prev + sign * steps * STEP_EXTENT,
          MIN_EXTENT,
          MAX_EXTENT,
        ),
      );
    },
    [], // No dependencies - uses functional update
  );

  // Attach wheel listener with { passive: false } to allow preventDefault()
  // React's onWheel is passive by default, causing "Unable to preventDefault" errors
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  // SE corner drag handler — widens right and down (matching the only rendered handle)
  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!resizable) return;
      e.preventDefault();
      e.stopPropagation();

      setIsResizing(true);
      resizeStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        w: width,
        h: height,
      };

      const handleMove = (moveEvent: PointerEvent) => {
        if (!resizeStartRef.current) return;

        const dx = moveEvent.clientX - resizeStartRef.current.x;
        const dy = moveEvent.clientY - resizeStartRef.current.y;
        const newW = resizeStartRef.current.w + dx;
        const newH = resizeStartRef.current.h + dy;

        // Clamp to bounds independently for width and height
        const effectiveMaxSize = maxSize ?? Infinity;
        const clampedW = Math.max(
          minSize,
          Math.min(effectiveMaxSize, Math.round(newW / 8) * 8),
        );
        const clampedH = Math.max(
          minSize,
          Math.min(effectiveMaxSize, Math.round(newH / 8) * 8),
        );
        setCurrentWidth(clampedW);
        setCurrentHeight(clampedH);
        // Write latest clamped size into the ref so handleUp always sees the
        // post-drag final size, not the stale closure-captured initial values.
        latestSizeRef.current = { w: clampedW, h: clampedH };
      };

      const cleanupResize = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        resizeCleanupRef.current = null;
      };

      const handleUp = () => {
        setIsResizing(false);
        resizeStartRef.current = null;
        // Read from ref — immune to stale closure over currentWidth/currentHeight
        onSizeChange?.(latestSizeRef.current.w, latestSizeRef.current.h);
        cleanupResize();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      resizeCleanupRef.current = cleanupResize;
    },
    [resizable, width, height, minSize, maxSize, onSizeChange],
  );

  // Render collapsed state as a 32x32 icon
  if (collapsible && isCollapsed) {
    return (
      <div
        className={`minimap-collapsed cursor-pointer select-none ${className}`}
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: `2px solid ${theme.colors.border.decorative}`,
          backgroundColor: theme.colors.background.glass,
          boxShadow: `${theme.shadows.md}, inset 0 1px 0 rgba(255, 255, 255, 0.1)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...style,
        }}
        onClick={toggleCollapse}
        title="Expand Minimap (Tab)"
      >
        {/* Player direction arrow in collapsed state — rotated via direct DOM write in RAF */}
        <svg
          ref={(el) => {
            compassRef.current = el;
          }}
          width="18"
          height="18"
          viewBox="0 0 18 18"
          style={{
            transform: "rotate(0deg)",
            transition: "transform 0.1s ease-out",
          }}
        >
          <polygon
            points="9,2 14,14 9,11 4,14"
            fill={theme.colors.accent.primary}
            stroke={theme.colors.text.primary}
            strokeWidth="1"
          />
        </svg>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`minimap overflow-hidden relative touch-none select-none ${className}`}
      style={{
        width,
        height,
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        ...style,
      }}
      onMouseDown={onPreventDefault}
      onContextMenu={onPreventDefault}
    >
      {/* 3D canvas */}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="absolute inset-0 block w-full h-full z-0"
      />
      {/* 2D overlay for pips */}
      <canvas
        ref={overlayCanvasRef}
        width={width}
        height={height}
        className="absolute inset-0 block w-full h-full pointer-events-auto cursor-crosshair z-[1]"
        onClick={onOverlayClick}
        onMouseDown={onStopAndPrevent}
        onContextMenu={onStopAndPrevent}
      />
      {/* Resize handles (SE corner only for simplicity) */}
      {resizable && (
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-20 pointer-events-auto"
          style={{
            background: `linear-gradient(135deg, transparent 50%, ${theme.colors.border.decorative} 50%)`,
          }}
          onPointerDown={handleResizeStart}
        />
      )}

      {/* Resize indicator overlay when resizing */}
      {isResizing && (
        <div className="absolute inset-0 border-2 border-yellow-400/50 rounded-lg pointer-events-none z-30" />
      )}

      {/* Edit mode drag overlay - makes the entire minimap content draggable */}
      {/* This is positioned INSIDE the edges so resize handles remain accessible */}
      {/* Corners (12px) and edges (8px) are reserved for resize, interior is for drag */}
      {isUnlocked && dragHandleProps && (
        <div
          className="absolute cursor-move pointer-events-auto"
          style={{
            zIndex: 50,
            // Inset from all edges to leave room for resize handles
            // Edges are 8px wide, corners are 12px
            top: 10,
            left: 10,
            right: 10,
            bottom: 10,
            // Subtle visual feedback for drag area
            background: "rgba(100, 180, 255, 0.08)",
            border: "1px dashed rgba(100, 180, 255, 0.4)",
            borderRadius: 4,
          }}
          onPointerDown={dragHandleProps.onPointerDown}
          title="Drag to move minimap"
        />
      )}

      {/* Collapse button (top-right) - only shown when collapsible */}
      {collapsible && (
        <button
          className="absolute z-20 pointer-events-auto cursor-pointer"
          style={{
            top: 4,
            right: 4,
            width: 20,
            height: 20,
            borderRadius: theme.borderRadius.sm,
            border: `1px solid ${theme.colors.border.default}`,
            backgroundColor: theme.colors.background.glass,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            color: theme.colors.text.secondary,
            padding: 0,
          }}
          onClick={onCollapseButtonClick}
          title="Collapse Minimap (Tab)"
        >
          −
        </button>
      )}
    </div>
  );
}

export const Minimap = memo(MinimapInner);
