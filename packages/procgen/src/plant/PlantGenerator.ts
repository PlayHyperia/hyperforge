/**
 * PlantGenerator - Main procedural plant generation API
 *
 * Provides the primary interface for generating procedural plants
 * with full Three.js integration.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
  Group,
  Mesh,
  CanvasTexture,
  DoubleSide,
  Color,
  type Object3D,
  type Material,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import type {
  Point3D,
  MeshData,
  LeafParamDict,
  LeafBundle,
  PlantGenerationOptions,
  PlantGenerationResult,
  PlantPresetName,
  RenderQuality,
  QualitySettings,
  HSLColor,
} from "./types.js";
import { LPK, RenderQuality as RQ } from "./types.js";

import { SeededRandom } from "./math/Random.js";
import { getExtents3D, add3D } from "./math/Vector.js";

import { generateLeafShape } from "./shape/LeafShape.js";
import {
  createDefaultParams,
  getParamValue,
  getParamColorValue,
} from "./params/LeafParamDefaults.js";
import { generateLeafVeins, getMidrib } from "./veins/LeafVeins.js";
import { triangulateLeaf } from "./mesh/Triangulation.js";
import { extrudeLeafMesh, applyMidribGroove } from "./mesh/Extrusion.js";
import { applyDistortions } from "./distortion/LeafDistortion.js";
import { generateAllTextures } from "./texture/TextureGenerator.js";
import {
  generateTrunk,
  generateStem,
  calculateArrangements,
  applyCollisionAvoidance,
} from "./assembly/Arrangement.js";
import {
  PRESETS,
  getPreset,
  getPresetNames,
  applyPreset,
  createParamsFromPreset,
} from "./presets/PlantPresets.js";

// =============================================================================
// COLOR UTILITIES
// =============================================================================

/**
 * Convert HSL color to RGB values (0-255)
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Convert HSL to hex color number for Three.js
 */
function hslToHex(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb(h, s, l);
  return (r << 16) | (g << 8) | b;
}

/**
 * Lerp between two HSL colors
 */
function lerpHsl(a: HSLColor, b: HSLColor, t: number): HSLColor {
  return {
    h: a.h + (b.h - a.h) * t,
    s: a.s + (b.s - a.s) * t,
    l: a.l + (b.l - a.l) * t,
  };
}

/**
 * Adjust HSL color values
 */
function adjustHsl(
  base: HSLColor,
  hueOffset: number,
  satOffset: number,
  litOffset: number,
): HSLColor {
  return {
    h: (((base.h + hueOffset) % 1) + 1) % 1, // Keep in 0-1 range
    s: Math.max(0, Math.min(1, base.s + satOffset)),
    l: Math.max(0, Math.min(1, base.l + litOffset)),
  };
}

// =============================================================================
// GLB EXPORT TYPES
// =============================================================================

/**
 * Export options for GLB generation
 */
export interface PlantGLBExportOptions {
  /** Filename without extension */
  filename?: string;
  /** Whether to download automatically (browser only) */
  download?: boolean;
  /** Apply transforms to geometry (bake transforms) */
  bakeTransforms?: boolean;
}

/**
 * Export result containing the GLB data
 */
export interface PlantGLBExportResult {
  /** Raw GLB data as ArrayBuffer */
  data: ArrayBuffer;
  /** Suggested filename with extension */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** Statistics about the export */
  stats: {
    vertexCount: number;
    triangleCount: number;
    meshCount: number;
    fileSizeBytes: number;
  };
}

// =============================================================================
// QUALITY SETTINGS
// =============================================================================

/**
 * Quality presets for plant generation.
 *
 * - Minimum: Low detail for distant LOD (LOD2)
 * - Medium: Balanced detail for mid-range (LOD1)
 * - Maximum: Full detail for close-up (LOD0)
 * - Current: Alias for Medium - use for "default" quality
 * - Custom: High quality with lower subdivision - use for runtime customization
 */
const QUALITY_SETTINGS: Record<RenderQuality, QualitySettings> = {
  [RQ.Minimum]: {
    subdivSteps: 0,
    renderLineSteps: 6,
    textureDownsample: 4,
    meshDensity: 0.5,
  },
  [RQ.Medium]: {
    subdivSteps: 1,
    renderLineSteps: 10,
    textureDownsample: 2,
    meshDensity: 0.75,
  },
  [RQ.Maximum]: {
    subdivSteps: 2,
    renderLineSteps: 15,
    textureDownsample: 1,
    meshDensity: 1.0,
  },
  // Current: Alias for Medium - provides a stable "default" quality level
  [RQ.Current]: {
    subdivSteps: 1,
    renderLineSteps: 10,
    textureDownsample: 2,
    meshDensity: 0.75,
  },
  // Custom: High mesh density with single subdivision - balanced for runtime use
  [RQ.Custom]: {
    subdivSteps: 1,
    renderLineSteps: 12, // Slightly higher than Medium
    textureDownsample: 1, // Full texture resolution
    meshDensity: 0.9, // High but not maximum density
  },
};

// =============================================================================
// MESH DATA TO BUFFER GEOMETRY
// =============================================================================

/**
 * Convert MeshData to Three.js BufferGeometry
 */
function meshDataToBufferGeometry(meshData: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();

  // Vertices
  const positions = new Float32Array(meshData.vertices.length * 3);
  for (let i = 0; i < meshData.vertices.length; i++) {
    positions[i * 3] = meshData.vertices[i].x;
    positions[i * 3 + 1] = meshData.vertices[i].y;
    positions[i * 3 + 2] = meshData.vertices[i].z;
  }
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));

  // Normals
  const normals = new Float32Array(meshData.normals.length * 3);
  for (let i = 0; i < meshData.normals.length; i++) {
    normals[i * 3] = meshData.normals[i].x;
    normals[i * 3 + 1] = meshData.normals[i].y;
    normals[i * 3 + 2] = meshData.normals[i].z;
  }
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));

  // UVs
  const uvs = new Float32Array(meshData.uvs.length * 2);
  for (let i = 0; i < meshData.uvs.length; i++) {
    uvs[i * 2] = meshData.uvs[i].x;
    uvs[i * 2 + 1] = meshData.uvs[i].y;
  }
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));

  // Vertex Colors (RGBA)
  if (meshData.colors && meshData.colors.length > 0) {
    // Colors are stored as flat RGBA array (4 values per vertex)
    const expectedLength = meshData.vertices.length * 4;
    if (meshData.colors.length >= expectedLength) {
      // Three.js uses RGB (3 values) for vertex colors
      const colorArray = new Float32Array(meshData.vertices.length * 3);
      for (let i = 0; i < meshData.vertices.length; i++) {
        colorArray[i * 3] = meshData.colors[i * 4]; // R
        colorArray[i * 3 + 1] = meshData.colors[i * 4 + 1]; // G
        colorArray[i * 3 + 2] = meshData.colors[i * 4 + 2]; // B
        // Alpha is ignored for vertex colors in Three.js MeshStandardMaterial
      }
      geometry.setAttribute("color", new Float32BufferAttribute(colorArray, 3));
    }
  }

  // Triangles
  geometry.setIndex(
    new Uint32BufferAttribute(new Uint32Array(meshData.triangles), 1),
  );

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

/**
 * Convert ImageData to Three.js CanvasTexture
 * @throws Error if canvas 2D context cannot be obtained
 */
function imageDataToTexture(imageData: ImageData): CanvasTexture {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(
      "[PlantGenerator] Failed to get 2D context from OffscreenCanvas for texture generation",
    );
  }
  ctx.putImageData(imageData, 0, 0);

  // Create a regular canvas for Three.js compatibility
  const regularCanvas = document.createElement("canvas");
  regularCanvas.width = imageData.width;
  regularCanvas.height = imageData.height;
  const regularCtx = regularCanvas.getContext("2d");
  if (!regularCtx) {
    throw new Error(
      "[PlantGenerator] Failed to get 2D context from canvas for texture generation",
    );
  }
  regularCtx.putImageData(imageData, 0, 0);

  return new CanvasTexture(regularCanvas);
}

// =============================================================================
// STEM MESH GENERATION
// =============================================================================

/**
 * Calculate stem shape scale at a given percentage along the stem
 * Matches original C# LeafStem.ShapeScaleAtPercent
 * Only tapers in the last 5% (0.95 to 1.0)
 * Exported for testing
 */
export function shapeScaleAtPercent(perc: number): number {
  if (perc <= 0.95) return 1;
  // 1.0 to 0.0 from 0.95 to 1.0
  let ret = 1 - (perc - 0.95) * 20;
  const floor = 0.25;
  // Scale from 1.0 to floor
  ret = ret * (1 - floor) + floor;
  // EaseOutQuad
  ret = 1 - (1 - ret) * (1 - ret);
  return ret;
}

/**
 * Evaluate cubic bezier curve at t
 * Exported for testing
 */
export function evaluateBezierPoint(
  curve: { p0: Point3D; h0: Point3D; h1: Point3D; p1: Point3D },
  t: number,
): Point3D {
  const t2 = t * t;
  const t3 = t2 * t;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;

  return {
    x:
      mt3 * curve.p0.x +
      3 * mt2 * t * curve.h0.x +
      3 * mt * t2 * curve.h1.x +
      t3 * curve.p1.x,
    y:
      mt3 * curve.p0.y +
      3 * mt2 * t * curve.h0.y +
      3 * mt * t2 * curve.h1.y +
      t3 * curve.p1.y,
    z:
      mt3 * curve.p0.z +
      3 * mt2 * t * curve.h0.z +
      3 * mt * t2 * curve.h1.z +
      t3 * curve.p1.z,
  };
}

/**
 * Get first derivative (tangent) of cubic bezier at t
 * Exported for testing
 */
export function getBezierTangent(
  curve: { p0: Point3D; h0: Point3D; h1: Point3D; p1: Point3D },
  t: number,
): Point3D {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  // First derivative of cubic bezier
  return {
    x:
      3 * mt2 * (curve.h0.x - curve.p0.x) +
      6 * mt * t * (curve.h1.x - curve.h0.x) +
      3 * t2 * (curve.p1.x - curve.h1.x),
    y:
      3 * mt2 * (curve.h0.y - curve.p0.y) +
      6 * mt * t * (curve.h1.y - curve.h0.y) +
      3 * t2 * (curve.p1.y - curve.h1.y),
    z:
      3 * mt2 * (curve.h0.z - curve.p0.z) +
      6 * mt * t * (curve.h1.z - curve.h0.z) +
      3 * t2 * (curve.p1.z - curve.h1.z),
  };
}

/**
 * Create quaternion that rotates to look along direction
 * Matches Unity's Quaternion.LookRotation(forward, up)
 * Exported for testing
 */
export function lookRotation(
  forward: Point3D,
  up: Point3D = { x: 0, y: 1, z: 0 },
): { x: number; y: number; z: number; w: number } {
  // Normalize forward
  const fLen = Math.sqrt(
    forward.x * forward.x + forward.y * forward.y + forward.z * forward.z,
  );
  if (fLen < 0.0001) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const fwd = { x: forward.x / fLen, y: forward.y / fLen, z: forward.z / fLen };

  // Calculate right = cross(up, forward)
  let right = {
    x: up.y * fwd.z - up.z * fwd.y,
    y: up.z * fwd.x - up.x * fwd.z,
    z: up.x * fwd.y - up.y * fwd.x,
  };
  const rLen = Math.sqrt(
    right.x * right.x + right.y * right.y + right.z * right.z,
  );
  if (rLen < 0.0001) {
    // up and forward are parallel, pick arbitrary right
    right = { x: 1, y: 0, z: 0 };
  } else {
    right = { x: right.x / rLen, y: right.y / rLen, z: right.z / rLen };
  }

  // Recalculate up = cross(forward, right)
  const newUp = {
    x: fwd.y * right.z - fwd.z * right.y,
    y: fwd.z * right.x - fwd.x * right.z,
    z: fwd.x * right.y - fwd.y * right.x,
  };

  // Build rotation matrix and extract quaternion
  // Matrix is [right, newUp, fwd] as columns
  const m00 = right.x,
    m01 = newUp.x,
    m02 = fwd.x;
  const m10 = right.y,
    m11 = newUp.y,
    m12 = fwd.y;
  const m20 = right.z,
    m21 = newUp.z,
    m22 = fwd.z;

  const trace = m00 + m11 + m22;
  let qw: number, qx: number, qy: number, qz: number;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }

  return { x: qx, y: qy, z: qz, w: qw };
}

/**
 * Rotate a 3D point by quaternion
 * Exported for testing
 */
export function rotatePointByQuat(
  p: Point3D,
  q: { x: number; y: number; z: number; w: number },
): Point3D {
  // Quaternion * vector * quaternion conjugate
  const ix = q.w * p.x + q.y * p.z - q.z * p.y;
  const iy = q.w * p.y + q.z * p.x - q.x * p.z;
  const iz = q.w * p.z + q.x * p.y - q.y * p.x;
  const iw = -q.x * p.x - q.y * p.y - q.z * p.z;

  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function alignLeafMeshBase(mesh: MeshData): void {
  if (mesh.vertices.length === 0) return;

  let minY = Infinity;
  for (const v of mesh.vertices) {
    if (v.y < minY) minY = v.y;
  }

  const epsilon = 0.001;
  let sumX = 0;
  let sumZ = 0;
  let count = 0;

  for (const v of mesh.vertices) {
    if (v.y <= minY + epsilon) {
      sumX += v.x;
      sumZ += v.z;
      count++;
    }
  }

  const baseX = count > 0 ? sumX / count : 0;
  const baseZ = count > 0 ? sumZ / count : 0;

  for (const v of mesh.vertices) {
    v.x -= baseX;
    v.y -= minY;
    v.z -= baseZ;
  }
}

/**
 * Get stem points and normals from all curves
 * Matches original C# StemRenderer.GetStemPoints
 */
/**
 * Get stem points and tangents from curves
 * MATCHES C# StemRenderer.GetStemPoints
 */
function getStemPoints(
  curves: { p0: Point3D; h0: Point3D; h1: Point3D; p1: Point3D }[],
  baseLineSteps: number,
  threshold: number = 0.2,
): { points: Point3D[]; normals: Point3D[] } {
  const points: Point3D[] = [];
  const normals: Point3D[] = [];

  for (let curveIdx = 0; curveIdx < curves.length; curveIdx++) {
    const curve = curves[curveIdx];

    // Calculate curve length for adaptive stepping (like C#)
    const curveLen = fastCurveLength3D(curve);

    // Adaptive lineSteps based on curve length (matches C#)
    // Original: lineSteps = Min(baseLineSteps, Round(len / threshold))
    const lineSteps = Math.min(
      baseLineSteps,
      Math.max(1, Math.round(curveLen / threshold)),
    );

    // Skip first point of subsequent curves to avoid duplicates (matches C#)
    const startIdx = curveIdx === 0 ? 0 : 1;

    for (let i = startIdx; i <= lineSteps; i++) {
      const t = i / lineSteps;
      points.push(evaluateBezierPoint(curve, t));
      normals.push(getBezierTangent(curve, t));
    }
  }

  return { points, normals };
}

/**
 * Fast approximation of 3D bezier curve length
 */
function fastCurveLength3D(curve: {
  p0: Point3D;
  h0: Point3D;
  h1: Point3D;
  p1: Point3D;
}): number {
  // Approximate by averaging chord and control polygon lengths
  const chordLen = Math.sqrt(
    Math.pow(curve.p1.x - curve.p0.x, 2) +
      Math.pow(curve.p1.y - curve.p0.y, 2) +
      Math.pow(curve.p1.z - curve.p0.z, 2),
  );

  const seg1 = Math.sqrt(
    Math.pow(curve.h0.x - curve.p0.x, 2) +
      Math.pow(curve.h0.y - curve.p0.y, 2) +
      Math.pow(curve.h0.z - curve.p0.z, 2),
  );
  const seg2 = Math.sqrt(
    Math.pow(curve.h1.x - curve.h0.x, 2) +
      Math.pow(curve.h1.y - curve.h0.y, 2) +
      Math.pow(curve.h1.z - curve.h0.z, 2),
  );
  const seg3 = Math.sqrt(
    Math.pow(curve.p1.x - curve.h1.x, 2) +
      Math.pow(curve.p1.y - curve.h1.y, 2) +
      Math.pow(curve.p1.z - curve.h1.z, 2),
  );

  const polyLen = seg1 + seg2 + seg3;
  return (chordLen + polyLen) / 2;
}

/**
 * Get leaf attachment info from stem curves
 * Matches original C# StemRenderer.GetAttachmentInfo
 */
function getLeafAttachmentInfo(
  curves: { p0: Point3D; h0: Point3D; h1: Point3D; p1: Point3D }[],
  leafZAngle: number,
): {
  position: Point3D;
  rotation: { x: number; y: number; z: number; w: number };
} {
  const { points, normals } = getStemPoints(curves, 2);

  if (points.length === 0 || normals.length === 0) {
    // This indicates invalid stem curve data - fail early instead of producing wrong geometry
    throw new Error(
      "[PlantGenerator] getLeafAttachmentInfo: empty stem points/normals - stem curves are invalid",
    );
  }

  const lastPoint = points[points.length - 1];
  const lastNormal = normals[normals.length - 1];

  // CRITICAL: Apply the same coordinate transformation as generateStemMesh
  // Original stem curves: Y is extension (length), X is flop offset
  // Transformed for mesh: X is extension (outward), Y is NEGATIVE flop (droop goes DOWN)
  const transformedLastPoint: Point3D = {
    x: lastPoint.y, // Extension becomes outward (+X)
    y: -lastPoint.x, // Flop offset becomes downward (-Y for droop)
    z: lastPoint.z, // Z stays as wobble
  };

  const transformedNormal: Point3D = {
    x: lastNormal.y,
    y: -lastNormal.x, // Negate to match position transform
    z: lastNormal.z,
  };

  // Normalize the transformed normal
  const nLen = Math.sqrt(
    transformedNormal.x * transformedNormal.x +
      transformedNormal.y * transformedNormal.y +
      transformedNormal.z * transformedNormal.z,
  );
  const normalizedNormal =
    nLen > 0.0001
      ? {
          x: transformedNormal.x / nLen,
          y: transformedNormal.y / nLen,
          z: transformedNormal.z / nLen,
        }
      : { x: 1, y: 0, z: 0 }; // Default to outward (+X) direction

  // Add small buffer along normal direction (0.02 units)
  const buffer = 0.02;
  const position: Point3D = {
    x: transformedLastPoint.x + normalizedNormal.x * buffer,
    y: transformedLastPoint.y + normalizedNormal.y * buffer,
    z: transformedLastPoint.z + normalizedNormal.z * buffer,
  };

  // Calculate rotation for leaf attachment
  // Real plants orient their leaf blades outward from the plant center and facing
  // upward toward light, regardless of how much the stem (petiole) droops.
  // Using the stem tip tangent directly causes leaves to point straight down when
  // stems have significant flop/droop. Instead, use the direction from the stem
  // base (origin) to the stem tip to get a natural outward-pointing leaf direction.
  //
  // Build rotation matrix with Y along outward direction, Z perpendicular:
  // Y = outward direction from trunk to leaf
  // X = cross(up, Y) - perpendicular to Y and up
  // Z = cross(Y, X) - perpendicular to both (face normal)
  //
  // Leaf meshes extend along negative local Y, so align -Y with outward direction.

  // Direction from stem base (origin in local space) to stem tip
  // Then flatten it to be mostly horizontal - real leaves orient toward light,
  // not following the droop of their petiole. We keep just enough Y to look natural.
  const horizontalDir = {
    x: transformedLastPoint.x,
    y: transformedLastPoint.y * 0.15, // Heavily dampen vertical droop
    z: transformedLastPoint.z,
  };
  const horizLen = Math.sqrt(
    horizontalDir.x * horizontalDir.x +
      horizontalDir.y * horizontalDir.y +
      horizontalDir.z * horizontalDir.z,
  );
  const leafDir =
    horizLen > 0.0001
      ? {
          x: horizontalDir.x / horizLen,
          y: horizontalDir.y / horizLen,
          z: horizontalDir.z / horizLen,
        }
      : normalizedNormal;

  const tangentY = {
    x: -leafDir.x,
    y: -leafDir.y,
    z: -leafDir.z,
  };
  const worldUp = { x: 0, y: 1, z: 0 };

  // X = up × Y (cross product)
  let leafX = {
    x: worldUp.y * tangentY.z - worldUp.z * tangentY.y,
    y: worldUp.z * tangentY.x - worldUp.x * tangentY.z,
    z: worldUp.x * tangentY.y - worldUp.y * tangentY.x,
  };
  let xLen = Math.sqrt(
    leafX.x * leafX.x + leafX.y * leafX.y + leafX.z * leafX.z,
  );
  if (xLen < 0.0001) {
    // Tangent is vertical, use arbitrary X
    leafX = { x: 1, y: 0, z: 0 };
    xLen = 1;
  }
  leafX = { x: leafX.x / xLen, y: leafX.y / xLen, z: leafX.z / xLen };

  // Z = X × Y (cross product) - must be right-handed for valid rotation matrix
  let leafZ = {
    x: leafX.y * tangentY.z - leafX.z * tangentY.y,
    y: leafX.z * tangentY.x - leafX.x * tangentY.z,
    z: leafX.x * tangentY.y - leafX.y * tangentY.x,
  };

  // Ensure leaf face (local +Z) generally points upward
  const upDot = leafZ.y;
  if (upDot < 0) {
    leafX = { x: -leafX.x, y: -leafX.y, z: -leafX.z };
    leafZ = { x: -leafZ.x, y: -leafZ.y, z: -leafZ.z };
  }

  // Build quaternion from rotation matrix [X, Y, Z]
  // m00=X.x, m01=Y.x, m02=Z.x
  // m10=X.y, m11=Y.y, m12=Z.y
  // m20=X.z, m21=Y.z, m22=Z.z
  const m00 = leafX.x,
    m01 = tangentY.x,
    m02 = leafZ.x;
  const m10 = leafX.y,
    m11 = tangentY.y,
    m12 = leafZ.y;
  const m20 = leafX.z,
    m21 = tangentY.z,
    m22 = leafZ.z;

  const trace = m00 + m11 + m22;
  let lookRot: { x: number; y: number; z: number; w: number };
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    lookRot = {
      w: 0.25 / s,
      x: (m21 - m12) * s,
      y: (m02 - m20) * s,
      z: (m10 - m01) * s,
    };
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    lookRot = {
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    };
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    lookRot = {
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    };
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    lookRot = {
      w: (m10 - m01) / s,
      x: (m02 + m20) / s,
      y: (m12 + m21) / s,
      z: 0.25 * s,
    };
  }

  // Apply leafZAngle rotation around Z axis
  const eulerRad = { x: 0, y: 0, z: (leafZAngle * Math.PI) / 180 };
  const cx = Math.cos(eulerRad.x / 2);
  const cy = Math.cos(eulerRad.y / 2);
  const cz = Math.cos(eulerRad.z / 2);
  const sx = Math.sin(eulerRad.x / 2);
  const sy = Math.sin(eulerRad.y / 2);
  const sz = Math.sin(eulerRad.z / 2);

  const eulerQuat = {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };

  // Multiply quaternions: lookRot * eulerQuat
  const rotation = {
    x:
      lookRot.w * eulerQuat.x +
      lookRot.x * eulerQuat.w +
      lookRot.y * eulerQuat.z -
      lookRot.z * eulerQuat.y,
    y:
      lookRot.w * eulerQuat.y -
      lookRot.x * eulerQuat.z +
      lookRot.y * eulerQuat.w +
      lookRot.z * eulerQuat.x,
    z:
      lookRot.w * eulerQuat.z +
      lookRot.x * eulerQuat.y -
      lookRot.y * eulerQuat.x +
      lookRot.z * eulerQuat.w,
    w:
      lookRot.w * eulerQuat.w -
      lookRot.x * eulerQuat.x -
      lookRot.y * eulerQuat.y -
      lookRot.z * eulerQuat.z,
  };

  return { position, rotation };
}

/**
 * Create stem shape points - circular cross-section in the XZ plane
 * The stem extends along the Y axis, so cross-section is perpendicular to Y
 * Exported for testing
 */
export function createStemShape(width: number, sides: number = 6): Point3D[] {
  const shape: Point3D[] = [];
  const PI2 = Math.PI * 2;

  for (let i = 0; i < sides; i++) {
    // Create circular cross-section in XZ plane (perpendicular to Y-axis)
    const angle = (i / sides) * PI2;
    shape.push({
      x: width * Math.cos(angle),
      y: 0,
      z: width * Math.sin(angle),
    });
  }

  return shape;
}

/**
 * Generate stem mesh from ALL curves
 *
 * CRITICAL: The stem curves are generated in 2D (XY plane) where:
 * - X is the horizontal offset (flop direction)
 * - Y is the extension direction (stem length)
 * - Z is minimal wobble
 *
 * When the stem is placed in the scene, it needs to extend OUTWARD from the trunk
 * (horizontally), not upward. This is achieved by swapping axes: what was Y (extension)
 * becomes X (outward), and what was X (flop offset) becomes Y (vertical droop).
 */
function generateStemMesh(
  stem: { curves: { p0: Point3D; h0: Point3D; h1: Point3D; p1: Point3D }[] },
  width: number,
  segments: number = 6,
  baseColor?: HSLColor,
  topColor?: HSLColor,
  colorBias: number = 0,
): MeshData {
  const vertices: Point3D[] = [];
  const triangles: number[] = [];
  const uvs: { x: number; y: number }[] = [];
  const normals: Point3D[] = [];
  const colors: number[] = [];

  // Default colors if not provided
  const defaultBaseColor: HSLColor = { h: 0.33, s: 0.8, l: 0.15 }; // Dark green
  const defaultTopColor: HSLColor = { h: 0.33, s: 0.7, l: 0.25 }; // Lighter green
  const actualBaseColor = baseColor || defaultBaseColor;
  const actualTopColor = topColor || defaultTopColor;

  // Get all stem points and tangents from ALL curves
  const baseLineSteps = 8; // Increased for smoother curves
  const { points: stemPoints, normals: stemTangents } = getStemPoints(
    stem.curves,
    baseLineSteps,
  );

  if (stemPoints.length === 0) {
    // Stem curves must produce at least one point - fail early
    throw new Error(
      "[PlantGenerator] generateStemMesh: no stem points from curves - stem curve data is invalid",
    );
  }

  // Create circular cross-section shape
  const shapePoints = createStemShape(width, segments);

  // Generate vertices for each stem point
  for (let i = 0; i < stemPoints.length; i++) {
    const stemPoint = stemPoints[i];
    const tangent = stemTangents[i];
    const perc = i / Math.max(1, stemPoints.length - 1);

    // Transform stem point: swap X and Y so stem extends along X (outward from trunk)
    // Original: Y is extension (length), X is flop offset (horizontal displacement)
    // Transformed: X is extension (outward), Y is NEGATIVE flop (so droop goes DOWN)
    const transformedStemPoint: Point3D = {
      x: stemPoint.y, // Extension becomes outward (+X)
      y: -stemPoint.x, // Flop offset becomes downward (-Y for droop)
      z: stemPoint.z, // Z stays as wobble
    };

    // Transform tangent the same way
    const transformedTangent: Point3D = {
      x: tangent.y,
      y: -tangent.x, // Negate to match position transform
      z: tangent.z,
    };

    // Normalize the tangent
    const tLen = Math.sqrt(
      transformedTangent.x * transformedTangent.x +
        transformedTangent.y * transformedTangent.y +
        transformedTangent.z * transformedTangent.z,
    );

    let forward: Point3D;
    if (tLen > 0.0001) {
      forward = {
        x: transformedTangent.x / tLen,
        y: transformedTangent.y / tLen,
        z: transformedTangent.z / tLen,
      };
    } else {
      forward = { x: 1, y: 0, z: 0 }; // Default to outward (+X)
    }

    // Calculate up vector (perpendicular to forward, trying to stay vertical)
    // Use world up as reference, then orthogonalize
    let up: Point3D = { x: 0, y: 1, z: 0 };
    const dotUp = forward.x * up.x + forward.y * up.y + forward.z * up.z;

    // If forward is nearly vertical, use a different reference
    if (Math.abs(dotUp) > 0.99) {
      up = { x: 0, y: 0, z: 1 };
    }

    // Calculate right = forward x up
    const right: Point3D = {
      x: forward.y * up.z - forward.z * up.y,
      y: forward.z * up.x - forward.x * up.z,
      z: forward.x * up.y - forward.y * up.x,
    };
    const rLen = Math.sqrt(
      right.x * right.x + right.y * right.y + right.z * right.z,
    );
    if (rLen > 0.0001) {
      right.x /= rLen;
      right.y /= rLen;
      right.z /= rLen;
    }

    // Recalculate up = right x forward (to ensure orthogonal)
    up = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x,
    };

    // Width modifier based on position (taper at tip)
    const widthMod = shapeScaleAtPercent(perc);

    for (let j = 0; j < segments; j++) {
      const shapePoint = shapePoints[j];

      // Scale the shape point
      const scaledX = shapePoint.x * widthMod;
      const scaledZ = shapePoint.z * widthMod;

      // Transform shape point to world space using the basis vectors
      // Shape is in XZ plane (perpendicular to Y), but we want it perpendicular to forward
      // So shape.x maps to 'up' direction and shape.z maps to 'right' direction
      const worldPoint: Point3D = {
        x: transformedStemPoint.x + up.x * scaledX + right.x * scaledZ,
        y: transformedStemPoint.y + up.y * scaledX + right.y * scaledZ,
        z: transformedStemPoint.z + up.z * scaledX + right.z * scaledZ,
      };

      vertices.push(worldPoint);

      uvs.push({
        x: j / segments,
        y: perc,
      });

      // Calculate outward normal
      const outward = {
        x: worldPoint.x - transformedStemPoint.x,
        y: worldPoint.y - transformedStemPoint.y,
        z: worldPoint.z - transformedStemPoint.z,
      };
      const outLen = Math.sqrt(
        outward.x * outward.x + outward.y * outward.y + outward.z * outward.z,
      );
      normals.push(
        outLen > 0.0001
          ? {
              x: outward.x / outLen,
              y: outward.y / outLen,
              z: outward.z / outLen,
            }
          : { x: 0, y: 1, z: 0 },
      );

      // Generate vertex color with gradient from base to top
      // Apply color bias to shift gradient towards base or top
      let colorT = perc;
      if (colorBias !== 0) {
        // Positive bias = more base color, negative = more top color
        colorT = Math.pow(colorT, 1 + colorBias);
      }
      const vertexColor = lerpHsl(actualBaseColor, actualTopColor, colorT);
      const [r, g, b] = hslToRgb(vertexColor.h, vertexColor.s, vertexColor.l);
      colors.push(r / 255, g / 255, b / 255, 1.0);
    }
  }

  // Generate triangles
  for (let ring = 0; ring < stemPoints.length - 1; ring++) {
    const floor = ring * segments;
    const ceil = floor + segments;

    for (let vn = floor; vn < ceil; vn++) {
      let lessOne = vn - 1;
      if (lessOne < floor) lessOne += segments;

      triangles.push(vn, vn + segments, lessOne);
      triangles.push(vn + segments, lessOne + segments, lessOne);
    }
  }

  return {
    vertices,
    triangles,
    uvs,
    normals,
    colors,
    orderedEdgeVerts: [],
  };
}

/**
 * Trunk taper function - MATCHES C# PlantTrunk.ShapeScaleAtPercent
 * Tapers quadratically from taperStartPerc to 1.0
 * Exported for testing
 */
export function trunkShapeScaleAtPercent(
  perc: number,
  taperStartPerc: number,
): number {
  if (perc <= taperStartPerc) return 1;
  if (perc >= 0.99) return 0;

  // Remap perc from [taperStartPerc, 1] to [0, 1]
  const newPerc = (perc - taperStartPerc) / (1.0 - taperStartPerc);
  // Quadratic ease (square)
  const squared = newPerc * newPerc;
  // Taper from 1 to 0
  return 1 - squared;
}

/**
 * Generate trunk mesh with proper trunk taper
 *
 * Unlike stems, the trunk grows VERTICALLY (Y is up), which is correct for the trunk.
 * The trunk curves are already in the correct orientation for world space.
 */
function generateTrunkMesh(
  trunk: { curves: { p0: Point3D; h0: Point3D; h1: Point3D; p1: Point3D }[] },
  width: number,
  segments: number = 16,
  taperStartPerc: number = 0.9,
  baseColor?: HSLColor,
  topColor?: HSLColor,
  browning: number = 0.2,
  lightness: number = 0.2,
): MeshData {
  const vertices: Point3D[] = [];
  const triangles: number[] = [];
  const uvs: { x: number; y: number }[] = [];
  const normals: Point3D[] = [];
  const colors: number[] = [];

  // Default trunk colors - brown/green gradient
  // Apply browning and lightness adjustments
  const defaultBaseColor: HSLColor = {
    h: 0.33 - browning * 0.2, // Shift hue towards brown
    s: 0.6 - browning * 0.2,
    l: 0.12 + lightness * 0.1,
  };
  const defaultTopColor: HSLColor = {
    h: 0.33, // More green at top
    s: 0.7,
    l: 0.18 + lightness * 0.15,
  };
  const actualBaseColor = baseColor || defaultBaseColor;
  const actualTopColor = topColor || defaultTopColor;

  const baseLineSteps = 10;
  const { points: trunkPoints, normals: trunkTangents } = getStemPoints(
    trunk.curves,
    baseLineSteps,
  );

  if (trunkPoints.length === 0) {
    // Trunk curves must produce at least one point - fail early
    throw new Error(
      "[PlantGenerator] generateTrunkMesh: no trunk points from curves - trunk curve data is invalid",
    );
  }

  // Create circular cross-section shape
  const shapePoints = createStemShape(width, segments);

  for (let i = 0; i < trunkPoints.length; i++) {
    const trunkPoint = trunkPoints[i];
    const tangent = trunkTangents[i];
    const perc = i / Math.max(1, trunkPoints.length - 1);

    // Normalize the tangent (direction the trunk is growing)
    const tLen = Math.sqrt(
      tangent.x * tangent.x + tangent.y * tangent.y + tangent.z * tangent.z,
    );

    let forward: Point3D;
    if (tLen > 0.0001) {
      forward = {
        x: tangent.x / tLen,
        y: tangent.y / tLen,
        z: tangent.z / tLen,
      };
    } else {
      forward = { x: 0, y: 1, z: 0 }; // Default to upward
    }

    // Calculate perpendicular basis for the cross-section
    // Use world X as reference for creating perpendicular vectors
    let refVec: Point3D = { x: 1, y: 0, z: 0 };
    const dotRef =
      forward.x * refVec.x + forward.y * refVec.y + forward.z * refVec.z;
    if (Math.abs(dotRef) > 0.95) {
      refVec = { x: 0, y: 0, z: 1 };
    }

    // right = forward x refVec
    const right: Point3D = {
      x: forward.y * refVec.z - forward.z * refVec.y,
      y: forward.z * refVec.x - forward.x * refVec.z,
      z: forward.x * refVec.y - forward.y * refVec.x,
    };
    const rLen = Math.sqrt(
      right.x * right.x + right.y * right.y + right.z * right.z,
    );
    if (rLen > 0.0001) {
      right.x /= rLen;
      right.y /= rLen;
      right.z /= rLen;
    }

    // up = right x forward
    const up: Point3D = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x,
    };

    // Width modifier based on position (taper near top)
    const widthMod = trunkShapeScaleAtPercent(perc, taperStartPerc);

    for (let j = 0; j < segments; j++) {
      const shapePoint = shapePoints[j];

      // Scale the shape point
      const scaledX = shapePoint.x * widthMod;
      const scaledZ = shapePoint.z * widthMod;

      // Transform shape point to world space
      // Shape is in XZ plane, we map X to 'right' and Z to 'up'
      const worldPoint: Point3D = {
        x: trunkPoint.x + right.x * scaledX + up.x * scaledZ,
        y: trunkPoint.y + right.y * scaledX + up.y * scaledZ,
        z: trunkPoint.z + right.z * scaledX + up.z * scaledZ,
      };

      vertices.push(worldPoint);

      uvs.push({
        x: j / segments,
        y: perc,
      });

      // Calculate outward normal
      const outward = {
        x: worldPoint.x - trunkPoint.x,
        y: worldPoint.y - trunkPoint.y,
        z: worldPoint.z - trunkPoint.z,
      };
      const outLen = Math.sqrt(
        outward.x * outward.x + outward.y * outward.y + outward.z * outward.z,
      );
      normals.push(
        outLen > 0.0001
          ? {
              x: outward.x / outLen,
              y: outward.y / outLen,
              z: outward.z / outLen,
            }
          : { x: 1, y: 0, z: 0 },
      );

      // Generate vertex color with gradient from base to top
      const vertexColor = lerpHsl(actualBaseColor, actualTopColor, perc);
      const [r, g, b] = hslToRgb(vertexColor.h, vertexColor.s, vertexColor.l);
      colors.push(r / 255, g / 255, b / 255, 1.0);
    }
  }

  // Generate triangles
  for (let ring = 0; ring < trunkPoints.length - 1; ring++) {
    const floor = ring * segments;
    const ceil = floor + segments;

    for (let vn = floor; vn < ceil; vn++) {
      let lessOne = vn - 1;
      if (lessOne < floor) lessOne += segments;

      triangles.push(vn, vn + segments, lessOne);
      triangles.push(vn + segments, lessOne + segments, lessOne);
    }
  }

  return {
    vertices,
    triangles,
    uvs,
    normals,
    colors,
    orderedEdgeVerts: [],
  };
}

// =============================================================================
// STUMP MESH GENERATION
// =============================================================================

/**
 * Default stump height in meters
 */
export const STUMP_HEIGHT = 1.0;

/**
 * Stump generation result containing mesh data
 */
export interface StumpGenerationResult {
  /** The stump mesh data (vertices, triangles, etc.) */
  meshData: MeshData;
  /** The BufferGeometry ready for Three.js */
  geometry: BufferGeometry;
  /** The stump height used */
  height: number;
  /** The stump width at base */
  width: number;
}

/**
 * Generate a tree stump mesh by cutting the trunk at a specified height.
 * Creates a cylindrical stump with a flat top cap.
 *
 * @param trunk - Trunk curve data (from generateTrunk)
 * @param width - Base trunk width
 * @param stumpHeight - Height to cut the trunk at (default 1.0m)
 * @param segments - Number of radial segments (default 8 for performance)
 * @param baseColor - Base bark color (HSL)
 * @param topColor - Top bark color (HSL)
 * @param browning - Browning adjustment for bark color
 * @param lightness - Lightness adjustment for bark color
 * @returns MeshData for the stump
 */
export function generateStumpMesh(
  trunk: { curves: { p0: Point3D; h0: Point3D; h1: Point3D; p1: Point3D }[] },
  width: number,
  stumpHeight: number = STUMP_HEIGHT,
  segments: number = 8,
  baseColor?: HSLColor,
  topColor?: HSLColor,
  browning: number = 0.2,
  lightness: number = 0.2,
): MeshData {
  const vertices: Point3D[] = [];
  const triangles: number[] = [];
  const uvs: { x: number; y: number }[] = [];
  const normals: Point3D[] = [];
  const colors: number[] = [];

  // Default trunk colors - brown gradient
  const defaultBaseColor: HSLColor = {
    h: 0.33 - browning * 0.2,
    s: 0.6 - browning * 0.2,
    l: 0.12 + lightness * 0.1,
  };
  const defaultTopColor: HSLColor = {
    h: 0.33,
    s: 0.7,
    l: 0.18 + lightness * 0.15,
  };
  const actualBaseColor = baseColor || defaultBaseColor;
  const actualTopColor = topColor || defaultTopColor;

  // Cut surface color - lighter, more yellowish (exposed wood)
  const cutSurfaceColor: HSLColor = {
    h: 0.12, // More yellow/tan
    s: 0.4,
    l: 0.35 + lightness * 0.1,
  };

  // Get trunk curve points up to stump height only
  const baseLineSteps = 6; // Fewer steps since stump is short
  const { points: allTrunkPoints, normals: allTrunkTangents } = getStemPoints(
    trunk.curves,
    baseLineSteps,
  );

  if (allTrunkPoints.length === 0) {
    throw new Error(
      "[PlantGenerator] generateStumpMesh: no trunk points from curves",
    );
  }

  // Find the total trunk height to calculate percentages
  const fullTrunkHeight = allTrunkPoints[allTrunkPoints.length - 1].y;

  // Filter points that are at or below stump height, and add interpolated cut point
  const trunkPoints: Point3D[] = [];
  const trunkTangents: Point3D[] = [];

  for (let i = 0; i < allTrunkPoints.length; i++) {
    const point = allTrunkPoints[i];
    const tangent = allTrunkTangents[i];

    if (point.y <= stumpHeight) {
      trunkPoints.push(point);
      trunkTangents.push(tangent);
    } else {
      // This point is above stump height - interpolate the cut point
      if (i > 0) {
        const prevPoint = allTrunkPoints[i - 1];
        const prevTangent = allTrunkTangents[i - 1];

        // Interpolation factor
        const t =
          (stumpHeight - prevPoint.y) / Math.max(0.001, point.y - prevPoint.y);

        // Interpolate position
        const cutPoint: Point3D = {
          x: prevPoint.x + (point.x - prevPoint.x) * t,
          y: stumpHeight,
          z: prevPoint.z + (point.z - prevPoint.z) * t,
        };

        // Interpolate tangent
        const cutTangent: Point3D = {
          x: prevTangent.x + (tangent.x - prevTangent.x) * t,
          y: prevTangent.y + (tangent.y - prevTangent.y) * t,
          z: prevTangent.z + (tangent.z - prevTangent.z) * t,
        };

        trunkPoints.push(cutPoint);
        trunkTangents.push(cutTangent);
      }
      break;
    }
  }

  // Ensure we have at least 2 points for the stump
  if (trunkPoints.length < 2) {
    // Add base point if missing
    if (trunkPoints.length === 0) {
      trunkPoints.push({ x: 0, y: 0, z: 0 });
      trunkTangents.push({ x: 0, y: 1, z: 0 });
    }
    // Add top point at stump height
    trunkPoints.push({ x: 0, y: stumpHeight, z: 0 });
    trunkTangents.push({ x: 0, y: 1, z: 0 });
  }

  // Create circular cross-section shape
  const shapePoints = createStemShape(width, segments);

  // No taper for stump - full width all the way up (stumps don't taper visually)
  const taperStartPerc = 1.0;

  // Generate trunk cylinder vertices
  for (let i = 0; i < trunkPoints.length; i++) {
    const trunkPoint = trunkPoints[i];
    const tangent = trunkTangents[i];
    const perc = fullTrunkHeight > 0 ? trunkPoint.y / fullTrunkHeight : 0;

    // Normalize the tangent
    const tLen = Math.sqrt(
      tangent.x * tangent.x + tangent.y * tangent.y + tangent.z * tangent.z,
    );

    let forward: Point3D;
    if (tLen > 0.0001) {
      forward = {
        x: tangent.x / tLen,
        y: tangent.y / tLen,
        z: tangent.z / tLen,
      };
    } else {
      forward = { x: 0, y: 1, z: 0 };
    }

    // Calculate perpendicular basis
    let refVec: Point3D = { x: 1, y: 0, z: 0 };
    const dotRef =
      forward.x * refVec.x + forward.y * refVec.y + forward.z * refVec.z;
    if (Math.abs(dotRef) > 0.95) {
      refVec = { x: 0, y: 0, z: 1 };
    }

    // right = forward x refVec
    const right: Point3D = {
      x: forward.y * refVec.z - forward.z * refVec.y,
      y: forward.z * refVec.x - forward.x * refVec.z,
      z: forward.x * refVec.y - forward.y * refVec.x,
    };
    const rLen = Math.sqrt(
      right.x * right.x + right.y * right.y + right.z * right.z,
    );
    if (rLen > 0.0001) {
      right.x /= rLen;
      right.y /= rLen;
      right.z /= rLen;
    }

    // up = right x forward
    const up: Point3D = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x,
    };

    // Width modifier - no taper for stumps
    const widthMod = trunkShapeScaleAtPercent(perc, taperStartPerc);

    for (let j = 0; j < segments; j++) {
      const shapePoint = shapePoints[j];
      const scaledX = shapePoint.x * widthMod;
      const scaledZ = shapePoint.z * widthMod;

      const worldPoint: Point3D = {
        x: trunkPoint.x + right.x * scaledX + up.x * scaledZ,
        y: trunkPoint.y + right.y * scaledX + up.y * scaledZ,
        z: trunkPoint.z + right.z * scaledX + up.z * scaledZ,
      };

      vertices.push(worldPoint);

      uvs.push({
        x: j / segments,
        y: perc,
      });

      // Outward normal
      const outward = {
        x: worldPoint.x - trunkPoint.x,
        y: worldPoint.y - trunkPoint.y,
        z: worldPoint.z - trunkPoint.z,
      };
      const outLen = Math.sqrt(
        outward.x * outward.x + outward.y * outward.y + outward.z * outward.z,
      );
      normals.push(
        outLen > 0.0001
          ? {
              x: outward.x / outLen,
              y: outward.y / outLen,
              z: outward.z / outLen,
            }
          : { x: 1, y: 0, z: 0 },
      );

      // Bark color gradient
      const vertexColor = lerpHsl(actualBaseColor, actualTopColor, perc);
      const [r, g, b] = hslToRgb(vertexColor.h, vertexColor.s, vertexColor.l);
      colors.push(r / 255, g / 255, b / 255, 1.0);
    }
  }

  // Generate trunk cylinder triangles
  for (let ring = 0; ring < trunkPoints.length - 1; ring++) {
    const floor = ring * segments;
    const ceil = floor + segments;

    for (let vn = floor; vn < ceil; vn++) {
      let lessOne = vn - 1;
      if (lessOne < floor) lessOne += segments;

      triangles.push(vn, vn + segments, lessOne);
      triangles.push(vn + segments, lessOne + segments, lessOne);
    }
  }

  // =========================================================================
  // GENERATE FLAT TOP CAP (cut surface)
  // =========================================================================

  // Get the top ring of vertices (the cut edge)
  const topRingStartIdx = (trunkPoints.length - 1) * segments;
  const topTrunkPoint = trunkPoints[trunkPoints.length - 1];

  // Add center vertex for the cap
  const centerIdx = vertices.length;
  vertices.push({
    x: topTrunkPoint.x,
    y: topTrunkPoint.y,
    z: topTrunkPoint.z,
  });
  uvs.push({ x: 0.5, y: 0.5 });
  normals.push({ x: 0, y: 1, z: 0 }); // Pointing up

  // Cut surface color (exposed wood)
  const [cr, cg, cb] = hslToRgb(
    cutSurfaceColor.h,
    cutSurfaceColor.s,
    cutSurfaceColor.l,
  );
  colors.push(cr / 255, cg / 255, cb / 255, 1.0);

  // Duplicate the top ring vertices for the cap (different normals needed)
  const capRingStartIdx = vertices.length;
  for (let j = 0; j < segments; j++) {
    const originalIdx = topRingStartIdx + j;
    const originalVert = vertices[originalIdx];

    vertices.push({ ...originalVert });

    // UV for cap - radial mapping
    const angle = (j / segments) * Math.PI * 2;
    uvs.push({
      x: 0.5 + Math.cos(angle) * 0.5,
      y: 0.5 + Math.sin(angle) * 0.5,
    });

    // Cap vertices point upward
    normals.push({ x: 0, y: 1, z: 0 });

    // Cut surface color
    colors.push(cr / 255, cg / 255, cb / 255, 1.0);
  }

  // Generate cap triangles (fan from center)
  for (let j = 0; j < segments; j++) {
    const curr = capRingStartIdx + j;
    const next = capRingStartIdx + ((j + 1) % segments);

    // Triangle from center to edge (winding order for upward facing)
    triangles.push(centerIdx, next, curr);
  }

  return {
    vertices,
    triangles,
    uvs,
    normals,
    colors,
    orderedEdgeVerts: [],
  };
}

/**
 * Generate a complete stump from plant parameters.
 * Convenience function that handles trunk generation and stump mesh creation.
 *
 * @param params - Plant parameters (from preset)
 * @param stumpHeight - Height to cut at (default STUMP_HEIGHT)
 * @param seed - Random seed for trunk generation
 * @param segments - Radial segments (default 8)
 * @returns StumpGenerationResult with mesh data and geometry
 */
export function generateStumpFromParams(
  params: LeafParamDict,
  stumpHeight: number = STUMP_HEIGHT,
  seed: number = 12345,
  segments: number = 8,
): StumpGenerationResult {
  // Generate trunk data (we only need curves and width)
  // Use a minimal trunk height that's at least stumpHeight
  const trunk = generateTrunk(params, Math.max(stumpHeight * 1.5, 2.0), seed);

  // Get trunk width from params
  const trunkWidth = Math.max(0.15, trunk.width * 0.8);

  // Get color parameters
  const trunkBrowning = getParamValue(params, LPK.TrunkBrowning);
  const trunkLightness = getParamValue(params, LPK.TrunkLightness);

  // Generate stump mesh
  const meshData = generateStumpMesh(
    { curves: trunk.curves },
    trunkWidth,
    stumpHeight,
    segments,
    undefined,
    undefined,
    trunkBrowning,
    trunkLightness,
  );

  // Convert to BufferGeometry
  const geometry = meshDataToBufferGeometry(meshData);

  return {
    meshData,
    geometry,
    height: stumpHeight,
    width: trunkWidth,
  };
}

// =============================================================================
// PLANT GENERATOR CLASS
// =============================================================================

/**
 * Main plant generator class
 */
export class PlantGenerator {
  private params: LeafParamDict;
  private options: PlantGenerationOptions;
  private random: SeededRandom;

  constructor(options?: Partial<PlantGenerationOptions>) {
    this.options = {
      seed: Date.now(),
      quality: RQ.Maximum,
      distortionInstances: 1,
      generateTextures: true,
      textureSize: 1024,
      ...options,
    };

    this.random = new SeededRandom(this.options.seed);
    this.params = createDefaultParams();
  }

  /**
   * Set the random seed
   */
  setSeed(seed: number): this {
    this.options.seed = seed;
    this.random.setSeed(seed);
    return this;
  }

  /**
   * Set quality level
   */
  setQuality(quality: RenderQuality): this {
    this.options.quality = quality;
    return this;
  }

  /**
   * Set texture size
   */
  setTextureSize(size: number): this {
    this.options.textureSize = size;
    return this;
  }

  /**
   * Enable/disable texture generation
   */
  setGenerateTextures(enabled: boolean): this {
    this.options.generateTextures = enabled;
    return this;
  }

  /**
   * Set number of distortion instances
   */
  setDistortionInstances(count: number): this {
    this.options.distortionInstances = Math.max(1, count);
    return this;
  }

  /**
   * Load a preset
   */
  loadPreset(presetName: PlantPresetName): this {
    const preset = getPreset(presetName);
    applyPreset(this.params, preset);
    return this;
  }

  /**
   * Get current parameters
   */
  getParams(): LeafParamDict {
    return this.params;
  }

  /**
   * Set parameters (batch update)
   */
  setParams(paramsUpdate: Partial<Record<LPK, number>>): this {
    for (const [key, value] of Object.entries(paramsUpdate)) {
      const lpk = key as LPK;
      if (this.params[lpk] && value !== undefined) {
        const param = this.params[lpk];
        param.value = Math.max(
          param.range.min,
          Math.min(param.range.max, value),
        );
        param.enabled = true;
      }
    }
    return this;
  }

  /**
   * Replace all parameters
   */
  replaceParams(params: LeafParamDict): this {
    this.params = params;
    return this;
  }

  /**
   * Set a single parameter value
   */
  setParam(key: LPK, value: number): this {
    const param = this.params[key];
    if (param) {
      param.value = Math.max(param.range.min, Math.min(param.range.max, value));
      param.enabled = true;
    }
    return this;
  }

  /**
   * Generate a complete plant
   */
  generate(): PlantGenerationResult {
    const startTime = performance.now();

    const quality = QUALITY_SETTINGS[this.options.quality];
    const seed = this.options.seed;

    // Generate leaf shape
    const shape = generateLeafShape(this.params);

    // Generate veins
    const veins = generateLeafVeins(shape, this.params, seed);
    const midrib = getMidrib(veins);

    // Triangulate mesh
    let baseMesh = triangulateLeaf(shape.curves, {
      lineSteps: quality.renderLineSteps,
      addInternalPoints: true,
    });

    // Apply extrusion
    baseMesh = extrudeLeafMesh(baseMesh, this.params);

    // Apply midrib groove if midrib exists
    if (midrib) {
      const midribWidth =
        getParamValue(this.params, LPK.NormalMidribWidth) * 0.1;
      const midribDepth =
        getParamValue(this.params, LPK.NormalMidribDepth) * 0.02;
      applyMidribGroove(baseMesh, midribWidth, midribDepth);
    }

    // Apply distortions
    let leafMesh = baseMesh;
    if (midrib) {
      leafMesh = applyDistortions(baseMesh, midrib, this.params, seed);
    }

    alignLeafMeshBase(leafMesh);

    alignLeafMeshBase(leafMesh);

    // Generate textures
    let textures: {
      albedo: ImageData | null;
      normal: ImageData | null;
      height: ImageData | null;
    } = {
      albedo: null,
      normal: null,
      height: null,
    };

    if (this.options.generateTextures) {
      const textureSize = this.options.textureSize / quality.textureDownsample;
      const generated = generateAllTextures(
        shape,
        veins,
        this.params,
        textureSize,
        seed,
      );
      textures = generated;
    }

    // Generate trunk
    // Original C# trunk height: topStemPos + NodeDistance (for taper)
    // topStemPos = NodeDistance * (LeafCount - 1) + NodeInitialY + potYAdd
    const leafCount = Math.floor(getParamValue(this.params, LPK.LeafCount));
    const nodeDistance = getParamValue(this.params, LPK.NodeDistance);
    const nodeInitialY = getParamValue(this.params, LPK.NodeInitialY);
    // Top stem position (where the last leaf attaches)
    const topStemPos = nodeDistance * Math.max(0, leafCount - 1) + nodeInitialY;
    // Trunk extends one NodeDistance above last leaf for tapering (matches C#)
    const taperDist = nodeDistance;
    const trunkHeight = topStemPos + taperDist;
    const trunk = generateTrunk(this.params, Math.max(0.1, trunkHeight), seed);

    // Calculate arrangements
    const arrangements = calculateArrangements(this.params, trunk, seed);

    // Generate leaf bundles
    const leafBundles: LeafBundle[] = [];
    const leafGeometry = meshDataToBufferGeometry(leafMesh);
    const baseAABB = {
      min: getExtents3D(leafMesh.vertices).min,
      max: getExtents3D(leafMesh.vertices).max,
    };

    // Pre-compute stem color parameters for all bundles
    const bundleStemBaseColor = getParamColorValue(
      this.params,
      LPK.StemBaseColor,
    );
    const bundleStemTopColorHue = getParamValue(
      this.params,
      LPK.StemTopColorHue,
    );
    const bundleStemTopColorLit = getParamValue(
      this.params,
      LPK.StemTopColorLit,
    );
    const bundleStemTopColorSat = getParamValue(
      this.params,
      LPK.StemTopColorSat,
    );
    const bundleStemColorBias = getParamValue(this.params, LPK.StemColorBias);

    // Calculate stem top color from base color with adjustments
    const bundleStemTopColor = adjustHsl(
      bundleStemBaseColor,
      bundleStemTopColorHue * 0.1,
      bundleStemTopColorSat * 0.3,
      bundleStemTopColorLit * 0.3,
    );

    for (let i = 0; i < arrangements.length; i++) {
      const arrangement = arrangements[i];

      // Generate stem (at origin in bundle-local space, positioned by bundle transform)
      const stemData = generateStem(this.params, arrangement, seed + i);

      // Generate stem mesh with color gradient
      // Stem width uses the StemWidth parameter with a minimum base width
      // The scale factor is applied more gently to prevent tiny stems on small leaves
      const baseStemWidth = getParamValue(this.params, LPK.StemWidth);
      // Use square root of scale to reduce the impact of small scales on stem width
      const scaleAdjusted = Math.sqrt(arrangement.scale);
      // Minimum stem width of 0.08 to ensure visibility
      const stemWidth = Math.max(0.08, baseStemWidth * 0.5 * scaleAdjusted);
      const stemMeshData = generateStemMesh(
        stemData,
        stemWidth,
        8, // 8 segments for smoother stems
        bundleStemBaseColor,
        bundleStemTopColor,
        bundleStemColorBias,
      );
      const stemGeometry = meshDataToBufferGeometry(stemMeshData);

      leafBundles.push({
        leafMesh: leafGeometry.clone(),
        stemMesh: stemGeometry,
        leafStem: stemData,
        arrangementData: arrangement,
        collisionAdjustment: { x: 0, y: 0, z: 0 },
        visible: true,
      });
    }

    // Apply collision avoidance
    applyCollisionAvoidance(leafBundles, baseAABB, this.params);

    // Generate trunk mesh with proper taper
    // Trunk taper: starts at topStemPos / trunkHeight, goes to 0 at tip
    const taperStartPerc = trunkHeight > 0 ? topStemPos / trunkHeight : 0.9;
    // Trunk width should be substantial - use the full width parameter
    const trunkWidthFinal = Math.max(0.15, trunk.width * 0.8);

    // Get trunk color parameters
    const trunkBrowning = getParamValue(this.params, LPK.TrunkBrowning);
    const trunkLightness = getParamValue(this.params, LPK.TrunkLightness);

    const trunkMeshData = generateTrunkMesh(
      { curves: trunk.curves },
      trunkWidthFinal,
      16, // 16 sides for smoother trunk
      taperStartPerc,
      undefined, // Use default base color (will be affected by browning/lightness)
      undefined, // Use default top color
      trunkBrowning,
      trunkLightness,
    );
    const trunkGeometry = meshDataToBufferGeometry(trunkMeshData);

    // Create Three.js group
    const group = new Group();
    group.name = "Plant";

    // Get stem color parameters for material
    const stemBaseColor = getParamColorValue(this.params, LPK.StemBaseColor);
    const stemShine = getParamValue(this.params, LPK.StemShine);

    // Get leaf base color for material fallback (when textures not available)
    const leafBaseColor = getParamColorValue(this.params, LPK.TexBaseColor);
    const leafColorHex = hslToHex(
      leafBaseColor.h,
      leafBaseColor.s,
      leafBaseColor.l,
    );

    // Create leaf material using TexBaseColor as base (WebGPU compatible)
    const leafMaterial = new MeshStandardNodeMaterial();
    leafMaterial.color = new Color(leafColorHex);
    leafMaterial.roughness = 0.7;
    leafMaterial.metalness = 0.0;
    leafMaterial.side = DoubleSide;

    if (textures.albedo) {
      leafMaterial.map = imageDataToTexture(textures.albedo);
    }
    if (textures.normal) {
      leafMaterial.normalMap = imageDataToTexture(textures.normal);
    }

    // Create stem/trunk material using stem color parameters with vertex colors (WebGPU compatible)
    const stemBaseColorHex = hslToHex(
      stemBaseColor.h,
      stemBaseColor.s,
      stemBaseColor.l,
    );
    const stemMaterial = new MeshStandardNodeMaterial();
    stemMaterial.color = new Color(stemBaseColorHex);
    stemMaterial.roughness = 1.0 - stemShine * 0.5; // Higher shine = lower roughness
    stemMaterial.metalness = stemShine * 0.1; // Slight metalness for shine
    stemMaterial.vertexColors = true; // Enable vertex colors for gradients

    // Add trunk mesh
    const trunkMesh = new Mesh(trunkGeometry, stemMaterial);
    trunkMesh.name = "Trunk";
    group.add(trunkMesh);

    // Add leaf bundles
    for (let i = 0; i < leafBundles.length; i++) {
      const bundle = leafBundles[i];
      if (!bundle.visible) continue;

      const leafGroup = new Group();
      leafGroup.name = `LeafBundle_${i}`;

      // Position bundle at trunk attachment point
      // Original C#: transform.localPosition = d.pos + collisionAdjustment
      const pos = add3D(bundle.arrangementData.pos, bundle.collisionAdjustment);
      leafGroup.position.set(pos.x, pos.y, pos.z);

      // Rotation of the entire bundle (stem rotation around Y)
      // Original C#: transform.localRotation = d.stemRotation
      const q = bundle.arrangementData.stemRotation;
      leafGroup.quaternion.set(q.x, q.y, q.z, q.w);

      // IMPORTANT: Scale is NOT applied to the bundle!
      // Original C# only scales the leaf child, not the stem
      // leafGroup.scale stays at (1, 1, 1)

      // Add stem mesh (unscaled)
      const stemMeshObj = new Mesh(bundle.stemMesh, stemMaterial);
      stemMeshObj.name = "Stem";
      leafGroup.add(stemMeshObj);

      // Add leaf at end of stem with proper attachment
      const leafMeshObj = new Mesh(bundle.leafMesh, leafMaterial);
      leafMeshObj.name = "Leaf";

      // Get leaf attachment info using stem curves (matches StemRenderer.GetAttachmentInfo)
      const stemCurves = bundle.leafStem.curves;
      const attachmentInfo = getLeafAttachmentInfo(
        stemCurves,
        bundle.arrangementData.leafZAngle,
      );

      // Position leaf at attachment point
      leafMeshObj.position.set(
        attachmentInfo.position.x,
        attachmentInfo.position.y,
        attachmentInfo.position.z,
      );

      // Apply attachment rotation
      // The attachment angle tilts the leaf around its local X axis (width direction)
      // to make it face more upward or downward relative to the stem
      const stemAttachmentAngle = getParamValue(
        this.params,
        LPK.StemAttachmentAngle,
      );

      // Create rotation around local X axis (leaf width)
      const attachAngleRad = (stemAttachmentAngle * Math.PI) / 180;
      const attachQuat = {
        x: Math.sin(attachAngleRad / 2),
        y: 0,
        z: 0,
        w: Math.cos(attachAngleRad / 2),
      };

      // The final rotation is: baseRot * attachQuat
      // This applies baseRot first (orientation), then attachQuat (tilt around local X)
      // Note: In quaternion multiplication, q1*q2 applied to point means q2 first, then q1
      // So baseRot * attachQuat means: attachQuat (tilt) is applied in the baseRot-rotated space
      const baseRot = attachmentInfo.rotation;
      const finalRot = {
        x:
          baseRot.w * attachQuat.x +
          baseRot.x * attachQuat.w +
          baseRot.y * attachQuat.z -
          baseRot.z * attachQuat.y,
        y:
          baseRot.w * attachQuat.y -
          baseRot.x * attachQuat.z +
          baseRot.y * attachQuat.w +
          baseRot.z * attachQuat.x,
        z:
          baseRot.w * attachQuat.z +
          baseRot.x * attachQuat.y -
          baseRot.y * attachQuat.x +
          baseRot.z * attachQuat.w,
        w:
          baseRot.w * attachQuat.w -
          baseRot.x * attachQuat.x -
          baseRot.y * attachQuat.y -
          baseRot.z * attachQuat.z,
      };

      leafMeshObj.quaternion.set(
        finalRot.x,
        finalRot.y,
        finalRot.z,
        finalRot.w,
      );

      // Scale ONLY the leaf, not the stem
      // Original C#: t.localScale = new Vector3(d.scale, d.scale, d.scale)
      const scale = bundle.arrangementData.scale;
      leafMeshObj.scale.set(scale, scale, scale);

      leafGroup.add(leafMeshObj);
      group.add(leafGroup);
    }

    const endTime = performance.now();

    // Create dispose function
    const dispose = (): void => {
      group.traverse((obj) => {
        if (obj instanceof Mesh) {
          obj.geometry.dispose();
          const mat = obj.material as Material & {
            map?: { dispose: () => void };
            normalMap?: { dispose: () => void };
          };
          if (mat && typeof mat.dispose === "function") {
            mat.dispose();
            if (mat.map) mat.map.dispose();
            if (mat.normalMap) mat.normalMap.dispose();
          }
        }
      });
    };

    // Calculate stats
    let totalVertices = 0;
    let totalTriangles = 0;
    group.traverse((obj) => {
      if (obj instanceof Mesh) {
        const geo = obj.geometry;
        totalVertices += geo.attributes.position?.count ?? 0;
        totalTriangles += (geo.index?.count ?? 0) / 3;
      }
    });

    return {
      group,
      leafBundles,
      trunkMesh: trunkGeometry,
      textures: {
        albedo: textures.albedo,
        normal: textures.normal,
        height: textures.height,
      },
      stats: {
        vertexCount: totalVertices,
        triangleCount: totalTriangles,
        leafCount: leafBundles.filter((b) => b.visible).length,
        generationTimeMs: endTime - startTime,
      },
      dispose,
    };
  }

  /**
   * Generate just the leaf mesh (for LOD or instancing)
   */
  generateLeafOnly(): {
    mesh: MeshData;
    geometry: BufferGeometry;
    textures: {
      albedo: ImageData;
      normal: ImageData;
      height: ImageData;
    } | null;
  } {
    const quality = QUALITY_SETTINGS[this.options.quality];
    const seed = this.options.seed;

    // Generate leaf shape
    const shape = generateLeafShape(this.params);

    // Generate veins
    const veins = generateLeafVeins(shape, this.params, seed);
    const midrib = getMidrib(veins);

    // Triangulate mesh
    let baseMesh = triangulateLeaf(shape.curves, {
      lineSteps: quality.renderLineSteps,
      addInternalPoints: true,
    });

    // Apply extrusion
    baseMesh = extrudeLeafMesh(baseMesh, this.params);

    // Apply distortions
    let leafMesh = baseMesh;
    if (midrib) {
      leafMesh = applyDistortions(baseMesh, midrib, this.params, seed);
    }

    // Generate textures if enabled
    let textures: {
      albedo: ImageData;
      normal: ImageData;
      height: ImageData;
    } | null = null;

    if (
      this.options.generateTextures &&
      typeof OffscreenCanvas !== "undefined"
    ) {
      const textureSize = this.options.textureSize / quality.textureDownsample;
      const generated = generateAllTextures(
        shape,
        veins,
        this.params,
        textureSize,
        seed,
      );
      textures = {
        albedo: generated.albedo!,
        normal: generated.normal!,
        height: generated.height!,
      };
    }

    return {
      mesh: leafMesh,
      geometry: meshDataToBufferGeometry(leafMesh),
      textures,
    };
  }

  /**
   * Generate multiple LOD levels
   */
  generateLODs(): {
    Minimum: MeshData;
    Medium: MeshData;
    Maximum: MeshData;
  } {
    const originalQuality = this.options.quality;
    const originalTextures = this.options.generateTextures;
    this.options.generateTextures = false;

    this.options.quality = RQ.Maximum;
    const Maximum = this.generateLeafOnly().mesh;

    this.options.quality = RQ.Medium;
    const Medium = this.generateLeafOnly().mesh;

    this.options.quality = RQ.Minimum;
    const Minimum = this.generateLeafOnly().mesh;

    this.options.quality = originalQuality;
    this.options.generateTextures = originalTextures;

    return { Minimum, Medium, Maximum };
  }

  /**
   * Export a plant result to GLB format.
   *
   * @param result - Plant generation result to export
   * @param options - Export options
   * @returns Promise resolving to export result
   */
  async exportToGLB(
    result: PlantGenerationResult,
    options: PlantGLBExportOptions = {},
  ): Promise<PlantGLBExportResult> {
    return exportPlantToGLB(result, options);
  }

  /**
   * Export a plant result to a GLB file.
   *
   * @param result - Plant generation result to export
   * @param outputPath - Full path to output file
   * @param options - Export options
   * @returns Promise resolving to export result
   */
  async exportToGLBFile(
    result: PlantGenerationResult,
    outputPath: string,
    options: Omit<PlantGLBExportOptions, "download"> = {},
  ): Promise<PlantGLBExportResult> {
    return exportPlantToGLBFile(result, outputPath, options);
  }

  /**
   * Generate a plant and immediately export it to GLB.
   *
   * @param options - Export options
   * @returns Promise resolving to generation result and GLB data
   */
  async generateAndExport(
    options: PlantGLBExportOptions = {},
  ): Promise<{ plant: PlantGenerationResult; glb: PlantGLBExportResult }> {
    const plant = this.generate();
    const glb = await this.exportToGLB(plant, options);
    return { plant, glb };
  }
}

// =============================================================================
// GLB EXPORT FUNCTIONS
// =============================================================================

/**
 * Export a plant result to GLB format.
 *
 * @param result - Plant generation result to export
 * @param options - Export options
 * @returns Promise resolving to export result
 */
export async function exportPlantToGLB(
  result: PlantGenerationResult,
  options: PlantGLBExportOptions = {},
): Promise<PlantGLBExportResult> {
  const exporter = new GLTFExporter();
  const filename = options.filename || "plant";

  // Clone the group to avoid modifying the original
  const exportGroup = result.group.clone(true);

  // Reset root position for export
  exportGroup.position.set(0, 0, 0);
  exportGroup.rotation.set(0, 0, 0);
  exportGroup.scale.set(1, 1, 1);
  exportGroup.updateMatrixWorld(true);

  // Bake transforms if requested
  if (options.bakeTransforms) {
    bakeTransformsToGeometry(exportGroup);
  }

  // Collect statistics
  const stats = collectPlantStats(exportGroup);

  return new Promise((resolve, reject) => {
    exporter.parse(
      exportGroup,
      (gltf) => {
        const data = gltf as ArrayBuffer;
        stats.fileSizeBytes = data.byteLength;

        const exportResult: PlantGLBExportResult = {
          data,
          filename: `${filename}.glb`,
          mimeType: "model/gltf-binary",
          stats,
        };

        // Download in browser if requested
        if (
          options.download &&
          typeof window !== "undefined" &&
          typeof document !== "undefined"
        ) {
          const blob = new Blob([data], { type: exportResult.mimeType });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = exportResult.filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        }

        // Clean up cloned group
        disposePlantGroup(exportGroup);

        resolve(exportResult);
      },
      (error) => {
        disposePlantGroup(exportGroup);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
      { binary: true },
    );
  });
}

/**
 * Export a plant result to a GLB file.
 *
 * @param result - Plant generation result to export
 * @param outputPath - Full path to output file
 * @param options - Export options
 * @returns Promise resolving to export result
 */
export async function exportPlantToGLBFile(
  result: PlantGenerationResult,
  outputPath: string,
  options: Omit<PlantGLBExportOptions, "download"> = {},
): Promise<PlantGLBExportResult> {
  const glbResult = await exportPlantToGLB(result, {
    ...options,
    download: false,
  });

  // Write file using available runtime APIs
  const globalObj = globalThis as Record<string, unknown>;
  if (
    globalObj.Bun &&
    typeof (globalObj.Bun as { write: unknown }).write === "function"
  ) {
    const BunRuntime = globalObj.Bun as {
      write: (path: string, data: ArrayBuffer) => Promise<void>;
    };
    await BunRuntime.write(outputPath, glbResult.data);
  } else {
    const fsModuleId = "node:fs/promises";
    const { writeFile } = (await import(/* @vite-ignore */ fsModuleId)) as {
      writeFile: (path: string, data: Uint8Array) => Promise<void>;
    };
    await writeFile(outputPath, new Uint8Array(glbResult.data));
  }

  return glbResult;
}

/**
 * Generate a plant from a preset and immediately export it to GLB.
 *
 * @param presetName - Name of the preset to use
 * @param seed - Random seed
 * @param options - Export options
 * @returns Promise resolving to generation result and GLB data
 */
export async function generateAndExportPlant(
  presetName: PlantPresetName,
  seed: number = Date.now(),
  options: PlantGLBExportOptions & {
    generateTextures?: boolean;
    textureSize?: number;
    quality?: RenderQuality;
  } = {},
): Promise<{ plant: PlantGenerationResult; glb: PlantGLBExportResult }> {
  const generator = new PlantGenerator({
    seed,
    generateTextures: options.generateTextures ?? true,
    textureSize: options.textureSize ?? 1024,
    quality: options.quality ?? RQ.Maximum,
  });
  generator.loadPreset(presetName);
  const plant = generator.generate();
  const glb = await exportPlantToGLB(plant, options);
  return { plant, glb };
}

/**
 * Bake world transforms into geometry vertices
 */
function bakeTransformsToGeometry(object: Object3D): void {
  object.updateMatrixWorld(true);

  object.traverse((child) => {
    if (child instanceof Mesh && child.geometry) {
      const geometry = child.geometry;
      geometry.applyMatrix4(child.matrixWorld);

      child.position.set(0, 0, 0);
      child.rotation.set(0, 0, 0);
      child.scale.set(1, 1, 1);
      child.updateMatrix();
      child.updateMatrixWorld(true);
    }
  });
}

/**
 * Collect statistics about the plant
 */
function collectPlantStats(object: Object3D): PlantGLBExportResult["stats"] {
  let vertexCount = 0;
  let triangleCount = 0;
  let meshCount = 0;

  object.traverse((child) => {
    if (child instanceof Mesh && child.geometry) {
      meshCount++;
      const geometry = child.geometry;
      const positions = geometry.attributes.position;

      if (positions) {
        vertexCount += positions.count;
      }

      if (geometry.index) {
        triangleCount += geometry.index.count / 3;
      } else if (positions) {
        triangleCount += positions.count / 3;
      }
    }
  });

  return {
    vertexCount,
    triangleCount,
    meshCount,
    fileSizeBytes: 0,
  };
}

/**
 * Dispose of all resources in a plant group
 */
function disposePlantGroup(group: Group): void {
  group.traverse((child) => {
    if (child instanceof Mesh) {
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

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Quick generation from preset
 */
export function generateFromPreset(
  presetName: PlantPresetName,
  seed: number = Date.now(),
  options?: {
    generateTextures?: boolean;
    textureSize?: number;
    leafCount?: number;
    quality?: RenderQuality;
  },
): PlantGenerationResult {
  const generator = new PlantGenerator({
    seed,
    generateTextures: options?.generateTextures ?? true,
    textureSize: options?.textureSize ?? 1024,
    quality: options?.quality ?? RQ.Maximum,
  });
  generator.loadPreset(presetName);
  if (options?.leafCount !== undefined) {
    generator.setParam(LPK.LeafCount, options.leafCount);
  }
  return generator.generate();
}

/**
 * Generate a random plant
 */
export function generateRandom(
  seed: number = Date.now(),
  options?: {
    generateTextures?: boolean;
    textureSize?: number;
    leafCount?: number;
    quality?: RenderQuality;
  },
): PlantGenerationResult {
  const presets = getPresetNames();
  const random = new SeededRandom(seed);
  const presetName = random.pick(presets);

  const generator = new PlantGenerator({
    seed,
    generateTextures: options?.generateTextures ?? true,
    textureSize: options?.textureSize ?? 1024,
    quality: options?.quality ?? RQ.Maximum,
  });
  generator.loadPreset(presetName);
  if (options?.leafCount !== undefined) {
    generator.setParam(LPK.LeafCount, options.leafCount);
  }
  return generator.generate();
}

/**
 * Create a generator with default settings
 */
export function createGenerator(
  options?: Partial<PlantGenerationOptions>,
): PlantGenerator {
  return new PlantGenerator(options);
}

// Re-export key types and utilities
export {
  PRESETS,
  getPreset,
  getPresetNames,
  createParamsFromPreset,
  createDefaultParams,
};
