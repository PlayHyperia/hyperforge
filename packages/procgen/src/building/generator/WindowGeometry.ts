/**
 * Window Geometry Generation
 *
 * Creates window frames, panes, mullions, and shutters for procedural buildings.
 */

import * as THREE from "three";
import { applyVertexColors, mergeBufferGeometries } from "./geometry";
import { WINDOW_WIDTH, WINDOW_HEIGHT, WALL_THICKNESS } from "./constants";

// ============================================================================
// TYPES
// ============================================================================

export type WindowStyle =
  | "simple"
  | "crossbar-2x2"
  | "crossbar-2x3"
  | "crossbar-3x3"
  | "arched"
  | "shuttered"
  | "shuttered-open"
  | "leaded"
  | "slit";

export interface ShutterConfig {
  style: "solid" | "louvered" | "paneled";
  openAngle: number;
  thickness: number;
}

export interface WindowConfig {
  width: number;
  height: number;
  frameThickness: number;
  frameDepth: number;
  style: WindowStyle;
  shutterConfig?: ShutterConfig;
  isVertical: boolean;
}

export interface WindowGeometryResult {
  frame: THREE.BufferGeometry | null;
  panes: THREE.BufferGeometry[];
  mullions: THREE.BufferGeometry | null;
  shutters: THREE.BufferGeometry[];
  sill: THREE.BufferGeometry | null;
}

const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
  frameThickness: 0.04,
  frameDepth: WALL_THICKNESS * 0.8,
  style: "simple",
  isVertical: false,
};

// Color palette - all trim uses solid wood colors (no stone/brick)
// Wood trim colors: black, dark brown, medium brown, light brown
const palette = {
  frame: new THREE.Color(0x5c4033), // Dark brown wood
  frameDark: new THREE.Color(0x3c2a1e), // Very dark brown wood
  shutter: new THREE.Color(0x4a3728), // Dark stained wood
  sill: new THREE.Color(0x5c4033), // Dark brown wood (matches frame for cohesive look)
  lead: new THREE.Color(0x3c3c3c),
};

// Material ID for solid trim (vertex colors only, no procedural pattern)
const SOLID_MATERIAL_ID = 1.0;

// ============================================================================
// GEOMETRY GENERATION
// ============================================================================

/**
 * Create a window frame (rectangular border) using non-overlapping boxes
 * Corner boxes are separate to avoid Z-fighting
 */
function createWindowFrame(
  width: number,
  height: number,
  thickness: number,
  depth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];

  // Frame dimensions - inner sections don't overlap corners
  const innerWidth = width - thickness * 2;
  const innerHeight = height - thickness * 2;

  // Four corner boxes
  const corners = [
    { x: -1, y: 1 }, // top-left
    { x: 1, y: 1 }, // top-right
    { x: -1, y: -1 }, // bottom-left
    { x: 1, y: -1 }, // bottom-right
  ];

  for (const corner of corners) {
    const cornerGeo = new THREE.BoxGeometry(
      isVertical ? depth : thickness,
      thickness,
      isVertical ? thickness : depth,
    );
    if (isVertical) {
      cornerGeo.translate(
        0,
        (corner.y * (height - thickness)) / 2,
        (corner.x * (width - thickness)) / 2,
      );
    } else {
      cornerGeo.translate(
        (corner.x * (width - thickness)) / 2,
        (corner.y * (height - thickness)) / 2,
        0,
      );
    }
    applyVertexColors(
      cornerGeo,
      palette.frame,
      0.35,
      0.35,
      0.78,
      SOLID_MATERIAL_ID,
    );
    geometries.push(cornerGeo);
  }

  // Top frame member (between corners)
  const topGeo = new THREE.BoxGeometry(
    isVertical ? depth : innerWidth,
    thickness,
    isVertical ? innerWidth : depth,
  );
  topGeo.translate(0, height / 2 - thickness / 2, 0);
  applyVertexColors(topGeo, palette.frame, 0.35, 0.35, 0.78, SOLID_MATERIAL_ID);
  geometries.push(topGeo);

  // Bottom frame member (between corners)
  const bottomGeo = new THREE.BoxGeometry(
    isVertical ? depth : innerWidth,
    thickness,
    isVertical ? innerWidth : depth,
  );
  bottomGeo.translate(0, -height / 2 + thickness / 2, 0);
  applyVertexColors(
    bottomGeo,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(bottomGeo);

  // Left frame member (between corners)
  const leftGeo = new THREE.BoxGeometry(
    isVertical ? depth : thickness,
    innerHeight,
    isVertical ? thickness : depth,
  );
  if (isVertical) {
    leftGeo.translate(0, 0, -width / 2 + thickness / 2);
  } else {
    leftGeo.translate(-width / 2 + thickness / 2, 0, 0);
  }
  applyVertexColors(
    leftGeo,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(leftGeo);

  // Right frame member (between corners)
  const rightGeo = new THREE.BoxGeometry(
    isVertical ? depth : thickness,
    innerHeight,
    isVertical ? thickness : depth,
  );
  if (isVertical) {
    rightGeo.translate(0, 0, width / 2 - thickness / 2);
  } else {
    rightGeo.translate(width / 2 - thickness / 2, 0, 0);
  }
  applyVertexColors(
    rightGeo,
    palette.frame,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );
  geometries.push(rightGeo);

  // Merge geometries
  const merged = mergeBufferGeometries(geometries);

  return merged;
}

// Glass pane creation removed - transparency effects weren't working properly
// Windows now show as open frames without glass

/**
 * Create mullions (dividers) for crossbar windows
 */
function createMullions(
  width: number,
  height: number,
  thickness: number,
  depth: number,
  columns: number,
  rows: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];

  const innerWidth = width - thickness * 2;
  const innerHeight = height - thickness * 2;
  const mullionThickness = thickness * 0.6;

  // Vertical mullions
  if (columns > 1) {
    const spacing = innerWidth / columns;
    for (let i = 1; i < columns; i++) {
      const x = -innerWidth / 2 + spacing * i;
      const mullion = new THREE.BoxGeometry(
        isVertical ? depth : mullionThickness,
        innerHeight,
        isVertical ? mullionThickness : depth,
      );
      if (isVertical) {
        mullion.translate(0, 0, x);
      } else {
        mullion.translate(x, 0, 0);
      }
      applyVertexColors(
        mullion,
        palette.frameDark,
        0.35,
        0.35,
        0.78,
        SOLID_MATERIAL_ID,
      );
      geometries.push(mullion);
    }
  }

  // Horizontal mullions (muntins)
  if (rows > 1) {
    const spacing = innerHeight / rows;
    for (let i = 1; i < rows; i++) {
      const y = -innerHeight / 2 + spacing * i;
      const muntin = new THREE.BoxGeometry(
        isVertical ? depth : innerWidth,
        mullionThickness,
        isVertical ? innerWidth : depth,
      );
      muntin.translate(0, y, 0);
      applyVertexColors(
        muntin,
        palette.frameDark,
        0.35,
        0.35,
        0.78,
        SOLID_MATERIAL_ID,
      );
      geometries.push(muntin);
    }
  }

  if (geometries.length === 0) {
    return new THREE.BufferGeometry();
  }

  const merged = mergeBufferGeometries(geometries);

  return merged;
}

// Glass pane creation removed - windows show as open frames without glass

/**
 * Create a window shutter
 */
function createShutter(
  width: number,
  height: number,
  config: ShutterConfig,
  isLeft: boolean,
  isVertical: boolean,
): THREE.BufferGeometry {
  const shutterWidth = width / 2 - 0.01; // Slightly smaller to fit
  const geometries: THREE.BufferGeometry[] = [];

  if (config.style === "solid") {
    // Solid panel shutter
    const panel = new THREE.BoxGeometry(
      isVertical ? config.thickness : shutterWidth,
      height,
      isVertical ? shutterWidth : config.thickness,
    );
    applyVertexColors(
      panel,
      palette.shutter,
      0.35,
      0.35,
      0.78,
      SOLID_MATERIAL_ID,
    );
    geometries.push(panel);
  } else if (config.style === "louvered") {
    // Louvered shutter with horizontal slats
    const slats = 8;
    const slatHeight = height / (slats * 2);
    const slatSpacing = height / slats;

    // Frame
    const frameThick = 0.02;

    // Vertical sides
    const leftSide = new THREE.BoxGeometry(
      isVertical ? config.thickness : frameThick,
      height,
      isVertical ? frameThick : config.thickness,
    );
    if (isVertical) {
      leftSide.translate(0, 0, -shutterWidth / 2 + frameThick / 2);
    } else {
      leftSide.translate(-shutterWidth / 2 + frameThick / 2, 0, 0);
    }
    applyVertexColors(
      leftSide,
      palette.shutter,
      0.35,
      0.35,
      0.78,
      SOLID_MATERIAL_ID,
    );
    geometries.push(leftSide);

    const rightSide = new THREE.BoxGeometry(
      isVertical ? config.thickness : frameThick,
      height,
      isVertical ? frameThick : config.thickness,
    );
    if (isVertical) {
      rightSide.translate(0, 0, shutterWidth / 2 - frameThick / 2);
    } else {
      rightSide.translate(shutterWidth / 2 - frameThick / 2, 0, 0);
    }
    applyVertexColors(
      rightSide,
      palette.shutter,
      0.35,
      0.35,
      0.78,
      SOLID_MATERIAL_ID,
    );
    geometries.push(rightSide);

    // Horizontal slats
    for (let i = 0; i < slats; i++) {
      const y = -height / 2 + slatSpacing * (i + 0.5);
      const slat = new THREE.BoxGeometry(
        isVertical ? config.thickness : shutterWidth - frameThick * 2,
        slatHeight,
        isVertical ? shutterWidth - frameThick * 2 : config.thickness,
      );
      slat.translate(0, y, 0);
      applyVertexColors(
        slat,
        palette.shutter,
        0.35,
        0.35,
        0.78,
        SOLID_MATERIAL_ID,
      );
      geometries.push(slat);
    }
  } else {
    // Paneled shutter (default)
    const panel = new THREE.BoxGeometry(
      isVertical ? config.thickness : shutterWidth,
      height,
      isVertical ? shutterWidth : config.thickness,
    );
    applyVertexColors(
      panel,
      palette.shutter,
      0.35,
      0.35,
      0.78,
      SOLID_MATERIAL_ID,
    );
    geometries.push(panel);

    // Add raised panel detail
    const inset = 0.03;
    const raisedPanel = new THREE.BoxGeometry(
      isVertical ? config.thickness + 0.005 : shutterWidth - inset * 2,
      height - inset * 2,
      isVertical ? shutterWidth - inset * 2 : config.thickness + 0.005,
    );
    applyVertexColors(
      raisedPanel,
      palette.shutter,
      0.3,
      0.2,
      0.85,
      SOLID_MATERIAL_ID,
    );
    geometries.push(raisedPanel);
  }

  const merged = mergeBufferGeometries(geometries);

  // Position shutter at hinge point
  const hingeOffset = (isLeft ? -1 : 1) * (width / 2);

  if (config.openAngle > 0) {
    // Open shutter - rotate around hinge
    // Note: Rotation would need to be applied via matrix transform
    // For now, position the shutter at an angle
    const openOffset = Math.sin(config.openAngle) * shutterWidth;
    const depthOffset = (Math.cos(config.openAngle) * shutterWidth) / 2;

    if (isVertical) {
      merged.translate(
        (isLeft ? 1 : -1) * depthOffset,
        0,
        hingeOffset + (isLeft ? 1 : -1) * (shutterWidth / 2 - openOffset / 2),
      );
    } else {
      merged.translate(
        hingeOffset + (isLeft ? 1 : -1) * (shutterWidth / 2 - openOffset / 2),
        0,
        (isLeft ? -1 : 1) * depthOffset,
      );
    }
  } else {
    // Closed shutter
    if (isVertical) {
      merged.translate(
        0,
        0,
        hingeOffset + ((isLeft ? 1 : -1) * shutterWidth) / 2,
      );
    } else {
      merged.translate(
        hingeOffset + ((isLeft ? 1 : -1) * shutterWidth) / 2,
        0,
        0,
      );
    }
  }

  return merged;
}

/**
 * Create a window sill using simple cube geometry
 * Sill sits below the window frame, extending outward from the wall
 */
function createWindowSill(
  width: number,
  frameThickness: number,
  frameDepth: number,
  isVertical: boolean,
): THREE.BufferGeometry {
  // Simple cube dimensions - sill extends past window frame on each side
  const sillWidth = width + frameThickness * 2;
  const sillHeight = frameThickness; // Match frame thickness for consistency
  const sillDepth = frameDepth * 1.3; // Protrude outward

  // Create a simple box geometry
  const geometry = new THREE.BoxGeometry(
    isVertical ? sillDepth : sillWidth,
    sillHeight,
    isVertical ? sillWidth : sillDepth,
  );

  // Position sill directly below the window frame (no overlap)
  // The sill sits at the bottom edge of the frame, offset down by half its height
  // and pushed outward to protrude from the wall
  const outwardOffset = (sillDepth - frameDepth) / 2;
  if (isVertical) {
    geometry.translate(outwardOffset, -frameThickness / 2 - sillHeight / 2, 0);
  } else {
    geometry.translate(0, -frameThickness / 2 - sillHeight / 2, outwardOffset);
  }

  applyVertexColors(
    geometry,
    palette.sill,
    0.35,
    0.35,
    0.78,
    SOLID_MATERIAL_ID,
  );

  return geometry;
}

/**
 * Create leaded glass pattern using simple grid of boxes (no rotated geometry)
 * Uses horizontal and vertical lead strips instead of diagonal diamonds
 */
function createLeadedGlass(
  width: number,
  height: number,
  frameThickness: number,
  depth: number,
  isVertical: boolean,
): { leads: THREE.BufferGeometry } {
  const innerWidth = width - frameThickness * 2;
  const innerHeight = height - frameThickness * 2;

  const leadGeometries: THREE.BufferGeometry[] = [];

  // Grid spacing for a nice leaded look
  const gridSpacingX = 0.06;
  const gridSpacingY = 0.08;
  const leadThickness = 0.006;
  const leadDepth = depth * 0.15;

  // Create vertical lead strips
  const numVertical = Math.floor(innerWidth / gridSpacingX);
  for (let i = 1; i < numVertical; i++) {
    const x = -innerWidth / 2 + i * gridSpacingX;
    const lead = new THREE.BoxGeometry(
      isVertical ? leadDepth : leadThickness,
      innerHeight,
      isVertical ? leadThickness : leadDepth,
    );
    if (isVertical) {
      lead.translate(0, 0, x);
    } else {
      lead.translate(x, 0, 0);
    }
    applyVertexColors(lead, palette.lead, 0.35, 0.35, 0.78, SOLID_MATERIAL_ID);
    leadGeometries.push(lead);
  }

  // Create horizontal lead strips
  const numHorizontal = Math.floor(innerHeight / gridSpacingY);
  for (let i = 1; i < numHorizontal; i++) {
    const y = -innerHeight / 2 + i * gridSpacingY;
    const lead = new THREE.BoxGeometry(
      isVertical ? leadDepth : innerWidth,
      leadThickness,
      isVertical ? innerWidth : leadDepth,
    );
    lead.translate(0, y, 0);
    applyVertexColors(lead, palette.lead, 0.35, 0.35, 0.78, SOLID_MATERIAL_ID);
    leadGeometries.push(lead);
  }

  if (leadGeometries.length === 0) {
    return { leads: new THREE.BufferGeometry() };
  }

  const leads = mergeBufferGeometries(leadGeometries);

  return { leads };
}

/**
 * Create an arrow slit window (narrow vertical opening)
 */
function createArrowSlit(
  height: number,
  depth: number,
  isVertical: boolean,
): WindowGeometryResult {
  const slitWidth = 0.15;
  const frameThickness = 0.03;

  // Frame
  const frame = createWindowFrame(
    slitWidth,
    height,
    frameThickness,
    depth,
    isVertical,
  );

  return {
    frame,
    panes: [], // Arrow slits have no glass
    mullions: null,
    shutters: [],
    sill: null,
  };
}

// ============================================================================
// MAIN API
// ============================================================================

/**
 * Create window geometry for a given style and configuration
 */
export function createWindowGeometry(
  config: Partial<WindowConfig> = {},
): WindowGeometryResult {
  const fullConfig: WindowConfig = { ...DEFAULT_WINDOW_CONFIG, ...config };
  const {
    width,
    height,
    frameThickness,
    frameDepth,
    style,
    isVertical,
    shutterConfig,
  } = fullConfig;

  // Handle special cases
  if (style === "slit") {
    return createArrowSlit(height, frameDepth, isVertical);
  }

  // Create frame
  const frame = createWindowFrame(
    width,
    height,
    frameThickness,
    frameDepth,
    isVertical,
  );

  // Create sill
  const sill = createWindowSill(width, frameThickness, frameDepth, isVertical);

  // Style-specific components - no glass panes (transparency wasn't working)
  let mullions: THREE.BufferGeometry | null = null;
  let shutters: THREE.BufferGeometry[] = [];

  switch (style) {
    case "simple":
      // Frame only, no glass
      break;

    case "crossbar-2x2":
      mullions = createMullions(
        width,
        height,
        frameThickness,
        frameDepth,
        2,
        2,
        isVertical,
      );
      break;

    case "crossbar-2x3":
      mullions = createMullions(
        width,
        height,
        frameThickness,
        frameDepth,
        2,
        3,
        isVertical,
      );
      break;

    case "crossbar-3x3":
      mullions = createMullions(
        width,
        height,
        frameThickness,
        frameDepth,
        3,
        3,
        isVertical,
      );
      break;

    case "shuttered":
    case "shuttered-open": {
      // Shutters without glass
      const shutterConf: ShutterConfig = shutterConfig ?? {
        style: "louvered",
        openAngle: style === "shuttered-open" ? Math.PI / 12 : 0,
        thickness: 0.02,
      };

      shutters = [
        createShutter(width, height, shutterConf, true, isVertical),
        createShutter(width, height, shutterConf, false, isVertical),
      ];
      break;
    }

    case "leaded": {
      const leaded = createLeadedGlass(
        width,
        height,
        frameThickness,
        frameDepth,
        isVertical,
      );
      mullions = leaded.leads;
      break;
    }

    case "arched":
      // Frame only for arched windows
      break;

    default:
      // Frame only
      break;
  }

  return {
    frame,
    panes: [], // No glass panes - transparency wasn't working
    mullions,
    shutters,
    sill,
  };
}

/** Get recommended window style for a building type */
export function getWindowStyleForBuildingType(
  buildingType: string,
): WindowStyle {
  const styleMap: Record<string, WindowStyle> = {
    // Religious - ornate leaded glass
    church: "leaded",
    cathedral: "leaded",
    chapel: "leaded",
    // Fortified - defensive slits
    keep: "slit",
    fortress: "slit",
    barracks: "slit",
    // Wealthy/Official - large divided windows
    mansion: "crossbar-3x3",
    "guild-hall": "crossbar-3x3",
    // Commercial/Common - medium divided windows
    inn: "crossbar-2x3",
    tavern: "crossbar-2x3",
    bank: "crossbar-2x3",
    // Working buildings - shuttered
    store: "shuttered",
    shop: "shuttered",
    smithy: "shuttered",
    blacksmith: "shuttered",
    warehouse: "shuttered",
    stable: "shuttered",
    // Residential
    house: "crossbar-2x3",
    cottage: "shuttered",
    farmhouse: "shuttered",
    "long-house": "shuttered",
    "simple-house": "crossbar-2x3",
  };
  const style = styleMap[buildingType];
  if (!style) {
    // Default to crossbar-2x3 for unknown types instead of throwing
    console.warn(
      `[WindowGeometry] Unknown building type: ${buildingType}, using 'crossbar-2x3' style.`,
    );
    return "crossbar-2x3";
  }
  return style;
}
