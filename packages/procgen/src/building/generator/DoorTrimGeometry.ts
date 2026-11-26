/**
 * Door Trim Geometry Generation
 *
 * Creates door frames, thresholds, lintels, and architraves for procedural buildings.
 */

import * as THREE from "three";
import { applyVertexColors, mergeBufferGeometries } from "./geometry";
import {
  DOOR_WIDTH,
  DOOR_HEIGHT,
  WALL_THICKNESS,
  ARCH_WIDTH,
} from "./constants";

// ============================================================================
// TYPES
// ============================================================================

export type DoorFrameStyle =
  "simple" | "with-lintel" | "architrave" | "rustic" | "arched" | "grand";

export interface DoorFrameConfig {
  width: number;
  height: number;
  frameWidth: number;
  frameDepth: number;
  style: DoorFrameStyle;
  isVertical: boolean;
  isArched: boolean;
  includeThreshold: boolean;
}

export interface DoorFrameGeometryResult {
  frame: THREE.BufferGeometry | null;
  threshold: THREE.BufferGeometry | null;
  lintel: THREE.BufferGeometry | null;
  architrave: THREE.BufferGeometry | null;
  archTrim: THREE.BufferGeometry | null;
}

const DEFAULT_DOOR_CONFIG: DoorFrameConfig = {
  width: DOOR_WIDTH,
  height: DOOR_HEIGHT,
  frameWidth: 0.08,
  frameDepth: WALL_THICKNESS * 0.6,
  style: "simple",
  isVertical: false,
  isArched: false,
  includeThreshold: true,
};

// Color palette - all trim uses solid wood colors (no stone/brick)
// Wood trim colors: black (0x1a1a1a), dark brown, medium brown, light brown
const palette = {
  frame: new THREE.Color(0x5c4033), // Dark brown wood
  frameDark: new THREE.Color(0x3c2a1e), // Very dark brown wood
  threshold: new THREE.Color(0x4a3728), // Dark stained wood (ground level, darker)
  lintel: new THREE.Color(0x5c4033), // Dark brown wood (structural header beam)
  architrave: new THREE.Color(0x6e5d52), // Medium brown wood (decorative molding)
};

// Material ID for solid trim (vertex colors only, no procedural pattern)
const SOLID_MATERIAL_ID = 1.0;

// ============================================================================
// GEOMETRY GENERATION
// ============================================================================

/**
 * Create door jambs (vertical side pieces) - height excludes header overlap
 */
function createDoorJambs(
  width: number,
  height: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry[] {
  const jambs: THREE.BufferGeometry[] = [];

  // Jamb height stops below the header to avoid overlap
  const jambHeight = height;

  // Left jamb
  const leftJamb = new THREE.BoxGeometry(
    isVertical ? frameDepth : frameWidth,
    jambHeight,
    isVertical ? frameWidth : frameDepth,
  );
  if (isVertical) {
    leftJamb.translate(0, jambHeight / 2, -width / 2 - frameWidth / 2);
  } else {
    leftJamb.translate(-width / 2 - frameWidth / 2, jambHeight / 2, 0);
  }
  applyVertexColors(
    leftJamb,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  jambs.push(leftJamb);

  // Right jamb
  const rightJamb = new THREE.BoxGeometry(
    isVertical ? frameDepth : frameWidth,
    jambHeight,
    isVertical ? frameWidth : frameDepth,
  );
  if (isVertical) {
    rightJamb.translate(0, jambHeight / 2, width / 2 + frameWidth / 2);
  } else {
    rightJamb.translate(width / 2 + frameWidth / 2, jambHeight / 2, 0);
  }
  applyVertexColors(
    rightJamb,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  jambs.push(rightJamb);

  return jambs;
}

/**
 * Create door header (horizontal top piece) with corner boxes to avoid overlap
 */
function createDoorHeader(
  width: number,
  height: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];

  // Center header piece (between jambs)
  const centerHeader = new THREE.BoxGeometry(
    isVertical ? frameDepth : width,
    frameWidth,
    isVertical ? width : frameDepth,
  );
  centerHeader.translate(0, height + frameWidth / 2, 0);
  applyVertexColors(
    centerHeader,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(centerHeader);

  // Left corner piece (above left jamb)
  const leftCorner = new THREE.BoxGeometry(
    isVertical ? frameDepth : frameWidth,
    frameWidth,
    isVertical ? frameWidth : frameDepth,
  );
  if (isVertical) {
    leftCorner.translate(
      0,
      height + frameWidth / 2,
      -width / 2 - frameWidth / 2,
    );
  } else {
    leftCorner.translate(
      -width / 2 - frameWidth / 2,
      height + frameWidth / 2,
      0,
    );
  }
  applyVertexColors(
    leftCorner,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftCorner);

  // Right corner piece (above right jamb)
  const rightCorner = new THREE.BoxGeometry(
    isVertical ? frameDepth : frameWidth,
    frameWidth,
    isVertical ? frameWidth : frameDepth,
  );
  if (isVertical) {
    rightCorner.translate(
      0,
      height + frameWidth / 2,
      width / 2 + frameWidth / 2,
    );
  } else {
    rightCorner.translate(
      width / 2 + frameWidth / 2,
      height + frameWidth / 2,
      0,
    );
  }
  applyVertexColors(
    rightCorner,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightCorner);

  return mergeBufferGeometries(geometries);
}

/**
 * Create door threshold
 */
function createDoorThreshold(
  width: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const thresholdWidth = width + frameWidth;
  const thresholdDepth = frameDepth * 1.5;
  const thresholdHeight = frameWidth * 0.5;

  const threshold = new THREE.BoxGeometry(
    isVertical ? thresholdDepth : thresholdWidth,
    thresholdHeight,
    isVertical ? thresholdWidth : thresholdDepth,
  );

  // Position at floor level, slightly protruding
  if (isVertical) {
    threshold.translate(
      thresholdDepth / 2 - frameDepth / 2,
      thresholdHeight / 2,
      0,
    );
  } else {
    threshold.translate(
      0,
      thresholdHeight / 2,
      thresholdDepth / 2 - frameDepth / 2,
    );
  }
  applyVertexColors(
    threshold,
    palette.threshold,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );

  return threshold;
}

/**
 * Create protruding lintel (wood beam above door)
 */
function createProtrudingLintel(
  width: number,
  height: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const lintelWidth = width + frameWidth * 4;
  const lintelDepth = frameDepth * 2;
  const lintelHeight = frameWidth * 2;

  const lintel = new THREE.BoxGeometry(
    isVertical ? lintelDepth : lintelWidth,
    lintelHeight,
    isVertical ? lintelWidth : lintelDepth,
  );

  // Position above door opening, sitting on top of the header
  lintel.translate(0, height + frameWidth + lintelHeight / 2, 0);

  // Apply wood color
  applyVertexColors(
    lintel,
    palette.lintel,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );

  return lintel;
}

/**
 * Create decorative architrave (molded surround) using non-overlapping boxes
 */
function createArchitrave(
  width: number,
  height: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];

  const architraveWidth = frameWidth * 1.5;
  const architraveDepth = frameDepth * 0.3;

  // Vertical height (stops below the top corner)
  const sideHeight = height + frameWidth;
  // Horizontal span (just the center, not including corners)
  const centerSpan = width + frameWidth * 2;

  // Left vertical piece (stops at corner)
  const leftArchitrave = new THREE.BoxGeometry(
    isVertical ? architraveDepth : architraveWidth,
    sideHeight,
    isVertical ? architraveWidth : architraveDepth,
  );
  if (isVertical) {
    leftArchitrave.translate(
      frameDepth / 2 + architraveDepth / 2,
      sideHeight / 2,
      -width / 2 - frameWidth - architraveWidth / 2,
    );
  } else {
    leftArchitrave.translate(
      -width / 2 - frameWidth - architraveWidth / 2,
      sideHeight / 2,
      frameDepth / 2 + architraveDepth / 2,
    );
  }
  applyVertexColors(
    leftArchitrave,
    palette.architrave,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftArchitrave);

  // Right vertical piece (stops at corner)
  const rightArchitrave = new THREE.BoxGeometry(
    isVertical ? architraveDepth : architraveWidth,
    sideHeight,
    isVertical ? architraveWidth : architraveDepth,
  );
  if (isVertical) {
    rightArchitrave.translate(
      frameDepth / 2 + architraveDepth / 2,
      sideHeight / 2,
      width / 2 + frameWidth + architraveWidth / 2,
    );
  } else {
    rightArchitrave.translate(
      width / 2 + frameWidth + architraveWidth / 2,
      sideHeight / 2,
      frameDepth / 2 + architraveDepth / 2,
    );
  }
  applyVertexColors(
    rightArchitrave,
    palette.architrave,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightArchitrave);

  // Top center piece (between corners)
  const topArchitrave = new THREE.BoxGeometry(
    isVertical ? architraveDepth : centerSpan,
    architraveWidth,
    isVertical ? centerSpan : architraveDepth,
  );
  if (isVertical) {
    topArchitrave.translate(
      frameDepth / 2 + architraveDepth / 2,
      height + frameWidth + architraveWidth / 2,
      0,
    );
  } else {
    topArchitrave.translate(
      0,
      height + frameWidth + architraveWidth / 2,
      frameDepth / 2 + architraveDepth / 2,
    );
  }
  applyVertexColors(
    topArchitrave,
    palette.architrave,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(topArchitrave);

  // Top left corner piece
  const leftCorner = new THREE.BoxGeometry(
    isVertical ? architraveDepth : architraveWidth,
    architraveWidth,
    isVertical ? architraveWidth : architraveDepth,
  );
  if (isVertical) {
    leftCorner.translate(
      frameDepth / 2 + architraveDepth / 2,
      height + frameWidth + architraveWidth / 2,
      -width / 2 - frameWidth - architraveWidth / 2,
    );
  } else {
    leftCorner.translate(
      -width / 2 - frameWidth - architraveWidth / 2,
      height + frameWidth + architraveWidth / 2,
      frameDepth / 2 + architraveDepth / 2,
    );
  }
  applyVertexColors(
    leftCorner,
    palette.architrave,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftCorner);

  // Top right corner piece
  const rightCorner = new THREE.BoxGeometry(
    isVertical ? architraveDepth : architraveWidth,
    architraveWidth,
    isVertical ? architraveWidth : architraveDepth,
  );
  if (isVertical) {
    rightCorner.translate(
      frameDepth / 2 + architraveDepth / 2,
      height + frameWidth + architraveWidth / 2,
      width / 2 + frameWidth + architraveWidth / 2,
    );
  } else {
    rightCorner.translate(
      width / 2 + frameWidth + architraveWidth / 2,
      height + frameWidth + architraveWidth / 2,
      frameDepth / 2 + architraveDepth / 2,
    );
  }
  applyVertexColors(
    rightCorner,
    palette.architrave,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightCorner);

  return mergeBufferGeometries(geometries);
}

/**
 * Create heavy timber frame (rustic style) using non-overlapping boxes
 */
function createRusticFrame(
  width: number,
  height: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];

  // Thicker frame members for rustic look
  const rusticWidth = frameWidth * 2;
  const rusticDepth = frameDepth * 1.5;
  const headerHeight = rusticWidth * 1.5;

  // Post height stops below header
  const postHeight = height;

  // Left post (stops at header)
  const leftPost = new THREE.BoxGeometry(
    isVertical ? rusticDepth : rusticWidth,
    postHeight,
    isVertical ? rusticWidth : rusticDepth,
  );
  if (isVertical) {
    leftPost.translate(0, postHeight / 2, -width / 2 - rusticWidth / 2);
  } else {
    leftPost.translate(-width / 2 - rusticWidth / 2, postHeight / 2, 0);
  }
  applyVertexColors(
    leftPost,
    palette.frameDark,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftPost);

  // Right post (stops at header)
  const rightPost = new THREE.BoxGeometry(
    isVertical ? rusticDepth : rusticWidth,
    postHeight,
    isVertical ? rusticWidth : rusticDepth,
  );
  if (isVertical) {
    rightPost.translate(0, postHeight / 2, width / 2 + rusticWidth / 2);
  } else {
    rightPost.translate(width / 2 + rusticWidth / 2, postHeight / 2, 0);
  }
  applyVertexColors(
    rightPost,
    palette.frameDark,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightPost);

  // Center header beam (between posts)
  const centerBeam = new THREE.BoxGeometry(
    isVertical ? rusticDepth : width,
    headerHeight,
    isVertical ? width : rusticDepth,
  );
  centerBeam.translate(0, height + headerHeight / 2, 0);
  applyVertexColors(
    centerBeam,
    palette.frameDark,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(centerBeam);

  // Left header corner (above left post)
  const leftCorner = new THREE.BoxGeometry(
    isVertical ? rusticDepth : rusticWidth,
    headerHeight,
    isVertical ? rusticWidth : rusticDepth,
  );
  if (isVertical) {
    leftCorner.translate(
      0,
      height + headerHeight / 2,
      -width / 2 - rusticWidth / 2,
    );
  } else {
    leftCorner.translate(
      -width / 2 - rusticWidth / 2,
      height + headerHeight / 2,
      0,
    );
  }
  applyVertexColors(
    leftCorner,
    palette.frameDark,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftCorner);

  // Right header corner (above right post)
  const rightCorner = new THREE.BoxGeometry(
    isVertical ? rusticDepth : rusticWidth,
    headerHeight,
    isVertical ? rusticWidth : rusticDepth,
  );
  if (isVertical) {
    rightCorner.translate(
      0,
      height + headerHeight / 2,
      width / 2 + rusticWidth / 2,
    );
  } else {
    rightCorner.translate(
      width / 2 + rusticWidth / 2,
      height + headerHeight / 2,
      0,
    );
  }
  applyVertexColors(
    rightCorner,
    palette.frameDark,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightCorner);

  // Header overhang extensions (rustic style extends past posts)
  const overhangSize = rusticWidth * 0.5;

  // Left overhang
  const leftOverhang = new THREE.BoxGeometry(
    isVertical ? rusticDepth : overhangSize,
    headerHeight,
    isVertical ? overhangSize : rusticDepth,
  );
  if (isVertical) {
    leftOverhang.translate(
      0,
      height + headerHeight / 2,
      -width / 2 - rusticWidth - overhangSize / 2,
    );
  } else {
    leftOverhang.translate(
      -width / 2 - rusticWidth - overhangSize / 2,
      height + headerHeight / 2,
      0,
    );
  }
  applyVertexColors(
    leftOverhang,
    palette.frameDark,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftOverhang);

  // Right overhang
  const rightOverhang = new THREE.BoxGeometry(
    isVertical ? rusticDepth : overhangSize,
    headerHeight,
    isVertical ? overhangSize : rusticDepth,
  );
  if (isVertical) {
    rightOverhang.translate(
      0,
      height + headerHeight / 2,
      width / 2 + rusticWidth + overhangSize / 2,
    );
  } else {
    rightOverhang.translate(
      width / 2 + rusticWidth + overhangSize / 2,
      height + headerHeight / 2,
      0,
    );
  }
  applyVertexColors(
    rightOverhang,
    palette.frameDark,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightOverhang);

  return mergeBufferGeometries(geometries);
}

/**
 * Create arched door trim using simple box geometry
 * Instead of rotated segments, use a stepped arch approximation with axis-aligned boxes
 */
function createArchTrim(
  width: number,
  height: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];

  // Create stepped arch using horizontal boxes at different heights
  // This avoids rotated geometry and Z-fighting
  const archRadius = width / 2;
  const steps = 5; // Number of horizontal steps to approximate arch

  for (let i = 0; i < steps; i++) {
    // Calculate the width at this step height
    const stepFraction = (i + 0.5) / steps;
    const stepY = stepFraction * archRadius;
    const stepWidth =
      2 * Math.sqrt(Math.max(0, archRadius * archRadius - stepY * stepY));

    if (stepWidth < frameWidth * 2) continue; // Skip if too narrow

    // Create horizontal box for this step
    const stepGeo = new THREE.BoxGeometry(
      isVertical ? frameDepth : stepWidth + frameWidth * 2,
      archRadius / steps,
      isVertical ? stepWidth + frameWidth * 2 : frameDepth,
    );

    stepGeo.translate(0, height + stepY, 0);
    applyVertexColors(
      stepGeo,
      palette.frame,
      0.35,
      0.35,
      0.78,
      SOLID_MATERIAL_ID,
    );
    geometries.push(stepGeo);
  }

  // Add vertical jambs that connect to the arch
  const jambHeight = height;
  const jambs = createDoorJambs(
    width,
    jambHeight,
    frameWidth,
    frameDepth,
    isVertical,
  );
  geometries.push(...jambs);

  return mergeBufferGeometries(geometries);
}

/**
 * Create grand entrance frame (large decorative) using non-overlapping boxes
 */
function createGrandFrame(
  width: number,
  height: number,
  frameWidth: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];

  const grandFrameWidth = frameWidth * 1.5;
  const capitalSize = frameWidth * 2;
  const capitalDepth = frameDepth * 1.5;

  // Shortened jamb height to make room for capitals
  const jambHeight = height - capitalSize;

  // Left jamb (shortened for capital)
  const leftJamb = new THREE.BoxGeometry(
    isVertical ? frameDepth : grandFrameWidth,
    jambHeight,
    isVertical ? grandFrameWidth : frameDepth,
  );
  if (isVertical) {
    leftJamb.translate(0, jambHeight / 2, -width / 2 - grandFrameWidth / 2);
  } else {
    leftJamb.translate(-width / 2 - grandFrameWidth / 2, jambHeight / 2, 0);
  }
  applyVertexColors(
    leftJamb,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftJamb);

  // Right jamb (shortened for capital)
  const rightJamb = new THREE.BoxGeometry(
    isVertical ? frameDepth : grandFrameWidth,
    jambHeight,
    isVertical ? grandFrameWidth : frameDepth,
  );
  if (isVertical) {
    rightJamb.translate(0, jambHeight / 2, width / 2 + grandFrameWidth / 2);
  } else {
    rightJamb.translate(width / 2 + grandFrameWidth / 2, jambHeight / 2, 0);
  }
  applyVertexColors(
    rightJamb,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightJamb);

  // Decorative capitals (sit on top of jambs, no overlap)
  // Left capital
  const leftCapital = new THREE.BoxGeometry(
    isVertical ? capitalDepth : capitalSize,
    capitalSize,
    isVertical ? capitalSize : capitalDepth,
  );
  if (isVertical) {
    leftCapital.translate(
      0,
      jambHeight + capitalSize / 2,
      -width / 2 - grandFrameWidth / 2,
    );
  } else {
    leftCapital.translate(
      -width / 2 - grandFrameWidth / 2,
      jambHeight + capitalSize / 2,
      0,
    );
  }
  applyVertexColors(
    leftCapital,
    palette.lintel,
    0.3,
    0.2,
    0.9,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftCapital);

  // Right capital
  const rightCapital = new THREE.BoxGeometry(
    isVertical ? capitalDepth : capitalSize,
    capitalSize,
    isVertical ? capitalSize : capitalDepth,
  );
  if (isVertical) {
    rightCapital.translate(
      0,
      jambHeight + capitalSize / 2,
      width / 2 + grandFrameWidth / 2,
    );
  } else {
    rightCapital.translate(
      width / 2 + grandFrameWidth / 2,
      jambHeight + capitalSize / 2,
      0,
    );
  }
  applyVertexColors(
    rightCapital,
    palette.lintel,
    0.3,
    0.2,
    0.9,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightCapital);

  // Header (center piece, between capitals)
  const header = new THREE.BoxGeometry(
    isVertical ? frameDepth : width,
    grandFrameWidth,
    isVertical ? width : frameDepth,
  );
  header.translate(0, height + grandFrameWidth / 2, 0);
  applyVertexColors(header, palette.frame, 0.35, 0.35, 0.78, SOLID_MATERIAL_ID);
  geometries.push(header);

  // Header corner pieces (above capitals)
  const leftHeaderCorner = new THREE.BoxGeometry(
    isVertical ? frameDepth : grandFrameWidth,
    grandFrameWidth,
    isVertical ? grandFrameWidth : frameDepth,
  );
  if (isVertical) {
    leftHeaderCorner.translate(
      0,
      height + grandFrameWidth / 2,
      -width / 2 - grandFrameWidth / 2,
    );
  } else {
    leftHeaderCorner.translate(
      -width / 2 - grandFrameWidth / 2,
      height + grandFrameWidth / 2,
      0,
    );
  }
  applyVertexColors(
    leftHeaderCorner,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftHeaderCorner);

  const rightHeaderCorner = new THREE.BoxGeometry(
    isVertical ? frameDepth : grandFrameWidth,
    grandFrameWidth,
    isVertical ? grandFrameWidth : frameDepth,
  );
  if (isVertical) {
    rightHeaderCorner.translate(
      0,
      height + grandFrameWidth / 2,
      width / 2 + grandFrameWidth / 2,
    );
  } else {
    rightHeaderCorner.translate(
      width / 2 + grandFrameWidth / 2,
      height + grandFrameWidth / 2,
      0,
    );
  }
  applyVertexColors(
    rightHeaderCorner,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightHeaderCorner);

  // Cornice (decorative top) - sits above header
  const corniceWidth = width + grandFrameWidth * 4;
  const corniceHeight = frameWidth * 1.5;
  const corniceDepth = frameDepth * 2;

  const cornice = new THREE.BoxGeometry(
    isVertical ? corniceDepth : corniceWidth,
    corniceHeight,
    isVertical ? corniceWidth : corniceDepth,
  );
  cornice.translate(0, height + grandFrameWidth + corniceHeight / 2, 0);
  applyVertexColors(
    cornice,
    palette.lintel,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(cornice);

  return mergeBufferGeometries(geometries);
}

// ============================================================================
// MAIN API
// ============================================================================

/**
 * Create door frame geometry for a given style and configuration
 */
export function createDoorFrameGeometry(
  config: Partial<DoorFrameConfig> = {},
): DoorFrameGeometryResult {
  const fullConfig: DoorFrameConfig = { ...DEFAULT_DOOR_CONFIG, ...config };
  const {
    width,
    height,
    frameWidth,
    frameDepth,
    style,
    isVertical,
    isArched,
    includeThreshold,
  } = fullConfig;

  const result: DoorFrameGeometryResult = {
    frame: null,
    threshold: null,
    lintel: null,
    architrave: null,
    archTrim: null,
  };

  // Handle arched doors specially
  if (isArched) {
    result.archTrim = createArchTrim(
      width,
      height,
      frameWidth,
      frameDepth,
      isVertical,
    );
    if (includeThreshold) {
      result.threshold = createDoorThreshold(
        width,
        frameWidth,
        frameDepth,
        isVertical,
      );
    }
    return result;
  }

  // Build frame based on style
  switch (style) {
    case "simple": {
      const jambs = createDoorJambs(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      const header = createDoorHeader(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      result.frame = mergeBufferGeometries([...jambs, header]);
      break;
    }

    case "with-lintel": {
      const jambs = createDoorJambs(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      const header = createDoorHeader(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      result.frame = mergeBufferGeometries([...jambs, header]);
      result.lintel = createProtrudingLintel(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      break;
    }

    case "architrave": {
      const jambs = createDoorJambs(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      const header = createDoorHeader(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      result.frame = mergeBufferGeometries([...jambs, header]);
      result.architrave = createArchitrave(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      break;
    }

    case "rustic": {
      result.frame = createRusticFrame(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      break;
    }

    case "grand": {
      result.frame = createGrandFrame(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      break;
    }

    default: {
      const jambs = createDoorJambs(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      const header = createDoorHeader(
        width,
        height,
        frameWidth,
        frameDepth,
        isVertical,
      );
      result.frame = mergeBufferGeometries([...jambs, header]);
    }
  }

  // Add threshold if requested
  if (includeThreshold) {
    result.threshold = createDoorThreshold(
      width,
      frameWidth,
      frameDepth,
      isVertical,
    );
  }

  return result;
}

/** Get recommended door frame style for a building type */
export function getDoorFrameStyleForBuildingType(
  buildingType: string,
  isEntrance: boolean = false,
): DoorFrameStyle {
  if (!isEntrance) return "simple";

  const styleMap: Record<string, DoorFrameStyle> = {
    // Grand entrances for religious buildings
    church: "grand",
    cathedral: "grand",
    chapel: "grand",
    // Formal architrave for wealthy/official buildings
    bank: "architrave",
    "guild-hall": "architrave",
    mansion: "architrave",
    // Heavy lintel for fortified buildings
    keep: "with-lintel",
    fortress: "with-lintel",
    // Rustic style for common buildings
    inn: "rustic",
    tavern: "rustic",
    store: "simple",
    shop: "simple",
    smithy: "with-lintel",
    blacksmith: "with-lintel",
    // Residential
    house: "simple",
    cottage: "rustic",
    farmhouse: "rustic",
    "long-house": "rustic",
    "simple-house": "simple",
    // Other
    warehouse: "simple",
    barracks: "with-lintel",
    stable: "rustic",
  };
  const style = styleMap[buildingType];
  if (!style) {
    // Default to simple for unknown types instead of throwing
    console.warn(
      `[DoorTrimGeometry] Unknown building type: ${buildingType}, using 'simple' style.`,
    );
    return "simple";
  }
  return style;
}

/** Get door frame config for arch openings */
export function getArchDoorConfig(isVertical: boolean): DoorFrameConfig {
  return {
    ...DEFAULT_DOOR_CONFIG,
    width: ARCH_WIDTH,
    isVertical,
    isArched: true,
    style: "arched",
  };
}
