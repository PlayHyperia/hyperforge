/**
 * Geometry Utilities
 * Helper functions for mesh generation and optimization
 */

import * as THREE from "three";
import { applyWorldSpaceUVs, applyWallUVs, applyFloorUVs } from "./uvUtils";

// ============================================================================
// TANGENT COMPUTATION FOR NON-INDEXED GEOMETRY
// ============================================================================

/**
 * Compute tangents for non-indexed geometry using MikkTSpace algorithm.
 *
 * For each triangle, computes the tangent from the UV gradient direction.
 * This ensures tangents align with UV mapping for correct normal map application.
 *
 * Requires: position, normal, uv attributes (all non-indexed)
 *
 * @param geometry - Non-indexed BufferGeometry with position, normal, uv
 * @returns The same geometry with tangent attribute added (vec4: xyz = tangent, w = handedness)
 */
/**
 * Compute flat face normals for non-indexed geometry.
 *
 * For each triangle, computes the face normal from the cross product of edge vectors
 * and assigns the same normal to all three vertices of that triangle.
 * This produces flat shading with hard edges - correct for architectural geometry.
 *
 * IMPORTANT: Unlike computeVertexNormals() which may smooth normals at shared vertices,
 * this function guarantees each face has its own independent normal.
 *
 * @param geometry - Non-indexed BufferGeometry (must have position attribute)
 * @returns The same geometry with flat normal attribute added/replaced
 */
export function computeFlatNormals(
  geometry: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const positionAttr = geometry.getAttribute("position");

  if (!positionAttr) {
    // This is a critical error - geometry without positions is invalid
    throw new Error(
      "[computeFlatNormals] Missing position attribute - geometry is invalid",
    );
  }

  const vertexCount = positionAttr.count;
  if (vertexCount % 3 !== 0) {
    // This indicates corrupted geometry - should not happen with valid Three.js geometry
    throw new Error(
      `[computeFlatNormals] Vertex count (${vertexCount}) not divisible by 3 - geometry is not valid triangles`,
    );
  }

  if (vertexCount === 0) {
    // Empty geometry is valid but has nothing to compute
    return geometry;
  }

  const normals = new Float32Array(vertexCount * 3);

  // Temporary vectors for calculations
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  // Compute bounding box center to verify normal direction
  geometry.computeBoundingBox();
  const boundingBox = geometry.boundingBox;
  const center = boundingBox
    ? new THREE.Vector3()
        .addVectors(boundingBox.min, boundingBox.max)
        .multiplyScalar(0.5)
    : new THREE.Vector3(0, 0, 0);

  // Process each triangle
  const triangleCount = vertexCount / 3;
  for (let t = 0; t < triangleCount; t++) {
    const i0 = t * 3;
    const i1 = t * 3 + 1;
    const i2 = t * 3 + 2;

    // Get vertex positions
    p0.set(positionAttr.getX(i0), positionAttr.getY(i0), positionAttr.getZ(i0));
    p1.set(positionAttr.getX(i1), positionAttr.getY(i1), positionAttr.getZ(i1));
    p2.set(positionAttr.getX(i2), positionAttr.getY(i2), positionAttr.getZ(i2));

    // Compute edge vectors
    edge1.subVectors(p1, p0);
    edge2.subVectors(p2, p0);

    // Compute face normal from cross product
    // Three.js uses CCW winding for outward-facing normals
    // cross(edge1, edge2) = cross(p1-p0, p2-p0) gives outward normal for CCW winding
    faceNormal.crossVectors(edge1, edge2);

    // Handle degenerate triangles (zero-area)
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

      // If normal points toward center (negative dot product), flip it
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
      normals[idx] = faceNormal.x;
      normals[idx + 1] = faceNormal.y;
      normals[idx + 2] = faceNormal.z;
    }
  }

  // Add or replace normal attribute
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

  return geometry;
}

/**
 * Compute tangents for non-indexed geometry using MikkTSpace-like algorithm.
 *
 * NOTE: This function is currently NOT INTEGRATED into the building generation pipeline.
 * The current building materials use procedural patterns (TSL) that don't require normal maps,
 * so tangents are not needed. This function is available for future use when/if
 * normal-mapped materials are added.
 *
 * To integrate: Call this after computeFlatNormals() in removeInternalFaces() or
 * after geometry is cleaned in the BuildingGenerator.
 *
 * @param geometry - Non-indexed BufferGeometry with position, normal, and uv attributes
 * @returns The same geometry with tangent attribute added (vec4: xyz = tangent, w = handedness)
 */
export function computeTangentsForNonIndexed(
  geometry: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const positionAttr = geometry.getAttribute("position");
  const normalAttr = geometry.getAttribute("normal");
  const uvAttr = geometry.getAttribute("uv");

  if (!positionAttr || !normalAttr || !uvAttr) {
    console.warn(
      "[computeTangentsForNonIndexed] Missing required attributes (position, normal, uv)",
    );
    return geometry;
  }

  const vertexCount = positionAttr.count;
  if (vertexCount % 3 !== 0) {
    console.warn(
      "[computeTangentsForNonIndexed] Vertex count not divisible by 3 (not triangles)",
    );
    return geometry;
  }

  // Tangent storage (vec4: xyz = tangent direction, w = handedness)
  const tangents = new Float32Array(vertexCount * 4);

  // Temporary vectors for calculations
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();

  // Process each triangle
  const triangleCount = vertexCount / 3;
  for (let t = 0; t < triangleCount; t++) {
    const i0 = t * 3;
    const i1 = t * 3 + 1;
    const i2 = t * 3 + 2;

    // Get vertex positions
    p0.set(positionAttr.getX(i0), positionAttr.getY(i0), positionAttr.getZ(i0));
    p1.set(positionAttr.getX(i1), positionAttr.getY(i1), positionAttr.getZ(i1));
    p2.set(positionAttr.getX(i2), positionAttr.getY(i2), positionAttr.getZ(i2));

    // Get UVs
    const u0 = uvAttr.getX(i0);
    const v0 = uvAttr.getY(i0);
    const u1 = uvAttr.getX(i1);
    const v1 = uvAttr.getY(i1);
    const u2 = uvAttr.getX(i2);
    const v2 = uvAttr.getY(i2);

    // Compute edge vectors
    edge1.subVectors(p1, p0);
    edge2.subVectors(p2, p0);

    // Compute UV deltas
    const deltaU1 = u1 - u0;
    const deltaV1 = v1 - v0;
    const deltaU2 = u2 - u0;
    const deltaV2 = v2 - v0;

    // Compute tangent using MikkTSpace formula
    const det = deltaU1 * deltaV2 - deltaU2 * deltaV1;

    if (Math.abs(det) < 1e-8) {
      // Degenerate UV mapping - fall back to normal-derived tangent
      normal.set(normalAttr.getX(i0), normalAttr.getY(i0), normalAttr.getZ(i0));

      // For mostly-horizontal surfaces, use world X as tangent
      // For mostly-vertical surfaces, compute tangent from cross(up, normal)
      if (Math.abs(normal.y) > 0.7) {
        tangent.set(1, 0, 0);
      } else {
        tangent.set(0, 1, 0).cross(normal).normalize();
        if (tangent.lengthSq() < 0.001) {
          tangent.set(1, 0, 0);
        }
      }

      // Store tangent for all 3 vertices (handedness = 1)
      for (let vi = 0; vi < 3; vi++) {
        const idx = (t * 3 + vi) * 4;
        tangents[idx] = tangent.x;
        tangents[idx + 1] = tangent.y;
        tangents[idx + 2] = tangent.z;
        tangents[idx + 3] = 1.0; // Handedness
      }
      continue;
    }

    const invDet = 1.0 / det;

    // Tangent: direction of increasing U
    tangent
      .set(
        invDet * (deltaV2 * edge1.x - deltaV1 * edge2.x),
        invDet * (deltaV2 * edge1.y - deltaV1 * edge2.y),
        invDet * (deltaV2 * edge1.z - deltaV1 * edge2.z),
      )
      .normalize();

    // Bitangent: direction of increasing V
    bitangent
      .set(
        invDet * (-deltaU2 * edge1.x + deltaU1 * edge2.x),
        invDet * (-deltaU2 * edge1.y + deltaU1 * edge2.y),
        invDet * (-deltaU2 * edge1.z + deltaU1 * edge2.z),
      )
      .normalize();

    // Get face normal (average of vertex normals for this face)
    normal
      .set(
        (normalAttr.getX(i0) + normalAttr.getX(i1) + normalAttr.getX(i2)) / 3,
        (normalAttr.getY(i0) + normalAttr.getY(i1) + normalAttr.getY(i2)) / 3,
        (normalAttr.getZ(i0) + normalAttr.getZ(i1) + normalAttr.getZ(i2)) / 3,
      )
      .normalize();

    // Orthogonalize tangent (Gram-Schmidt)
    const nDotT = normal.dot(tangent);
    tangent.sub(normal.clone().multiplyScalar(nDotT)).normalize();

    // Compute handedness (sign of determinant of TBN matrix)
    const handedness =
      normal.clone().cross(tangent).dot(bitangent) < 0 ? -1.0 : 1.0;

    // Store tangent for all 3 vertices of this triangle
    for (let vi = 0; vi < 3; vi++) {
      const idx = (t * 3 + vi) * 4;
      tangents[idx] = tangent.x;
      tangents[idx + 1] = tangent.y;
      tangents[idx + 2] = tangent.z;
      tangents[idx + 3] = handedness;
    }
  }

  // Add tangent attribute to geometry
  geometry.setAttribute("tangent", new THREE.BufferAttribute(tangents, 4));

  return geometry;
}

/**
 * Fractional part of a number
 */
export function fract(value: number): number {
  return value - Math.floor(value);
}

/**
 * Simple 3D noise function
 */
export function noise3(x: number, y: number, z: number): number {
  return fract(Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453);
}

/**
 * Layered noise for procedural texturing
 */
export function layeredNoise(x: number, y: number, z: number): number {
  const n1 = noise3(x, y, z);
  const n2 = noise3(x * 2.15, y * 2.15, z * 2.15) * 0.5;
  const n3 = noise3(x * 4.7, y * 4.7, z * 4.7) * 0.25;
  return (n1 + n2 + n3) / 1.75;
}

/**
 * Configuration for geometry attributes (vertex colors and UVs)
 */
export interface GeometryAttributeConfig {
  /** UV scale (world units per UV unit). Default: 1.0 */
  uvScale?: number;
  /** Whether to apply UVs. Default: true */
  applyUVs?: boolean;
  /** UV offset. Default: { u: 0, v: 0 } */
  uvOffset?: { u: number; v: number };
  /** Noise scale for vertex color variation. Default: 0.35 */
  noiseScale?: number;
  /** Noise amplitude for vertex color variation. Default: 0.35 */
  noiseAmp?: number;
  /** Minimum shade value for vertex colors. Default: 0.78 */
  minShade?: number;
  /**
   * Material ID for shader pattern selection. Stored in UV2.x
   * Values: 0.0 = brick, 0.2 = stone, 0.4 = timber, 0.6 = stucco, 0.8 = wood (vertical), 0.85 = siding (horizontal), 1.0 = solid
   */
  materialId?: number;
}

/**
 * Surface type encoding for UV2.y
 * These values are read by the shader to determine which pattern/texture to use.
 *
 * IMPORTANT: The shader can NOT reliably detect roofs vs floors by normal direction
 * because flat roofs have normalY = 1.0 (same as floors). We must encode the
 * surface type explicitly.
 */
export const SURFACE_TYPE_IDS: Record<string, number> = {
  WALL: 0.0, // Walls, foundations, stairs - use wall material pattern
  FLOOR: 0.33, // Interior floors - use wood plank pattern
  ROOF: 0.67, // Roofs (flat or sloped) - use shingle pattern, exterior lighting
  CEILING: 1.0, // Interior ceilings - use floor pattern but facing down
};

/**
 * Apply UV2 attribute for material ID and surface type encoding.
 * - UV2.x = material ID (0.0=brick, 0.2=stone, 0.4=timber, 0.6=stucco, 0.8=wood (vertical), 0.85=siding (horizontal), 1.0=solid)
 * - UV2.y = surface type (0.0=wall, 0.33=floor, 0.67=roof, 1.0=ceiling)
 *
 * CRITICAL: This MUST be called on ALL building geometries to ensure consistent
 * attributes when merging. mergeGeometries requires all input geometries to have
 * the same attributes, or it will produce undefined/garbage results.
 *
 * @param geometry - BufferGeometry to modify
 * @param materialId - Material ID value (0.0-1.0), defaults to 0.0 (brick)
 * @param surfaceType - Surface type ID from SURFACE_TYPE_IDS, defaults to WALL
 */
function applyMaterialIdUV2(
  geometry: THREE.BufferGeometry,
  materialId: number = 0.0,
  surfaceType: number = SURFACE_TYPE_IDS.WALL,
): void {
  const positionAttr = geometry.getAttribute("position");
  if (!positionAttr) return;

  const vertexCount = positionAttr.count;
  const uv2 = new Float32Array(vertexCount * 2);

  // Store materialId in U, surfaceType in V
  for (let i = 0; i < vertexCount; i++) {
    uv2[i * 2] = materialId;
    uv2[i * 2 + 1] = surfaceType;
  }

  geometry.setAttribute("uv2", new THREE.BufferAttribute(uv2, 2));
}

/**
 * Surface type for UV projection
 */
export type SurfaceType = "wall" | "floor" | "ceiling" | "roof" | "generic";

/**
 * Apply vertex colors to a geometry with optional noise variation.
 *
 * IMPORTANT: This function also adds UV2 attribute for material ID encoding
 * to ensure ALL building geometries have consistent attributes for mergeGeometries.
 *
 * @param materialId - Material ID for shader pattern selection (0.0=brick, 1.0=solid, etc.)
 *                     Use 1.0 for trim elements that should use solid vertex colors only.
 */
export function applyVertexColors(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  noiseScale = 0.35,
  noiseAmp = 0.35,
  minShade = 0.78,
  materialId = 0.0,
): void {
  const position = geometry.attributes.position;
  if (!position) return;
  const colors = new Float32Array(position.count * 3);

  const baseR = color.r * minShade;
  const baseG = color.g * minShade;
  const baseB = color.b * minShade;

  if (noiseAmp === 0) {
    for (let i = 0; i < position.count; i += 1) {
      const idx = i * 3;
      colors[idx] = baseR;
      colors[idx + 1] = baseG;
      colors[idx + 2] = baseB;
    }
  } else {
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);

      const noise = layeredNoise(
        x * noiseScale,
        y * noiseScale,
        z * noiseScale,
      );
      const shade = minShade + noise * noiseAmp;
      const r = Math.min(1, color.r * shade);
      const g = Math.min(1, color.g * shade);
      const b = Math.min(1, color.b * shade);

      const idx = i * 3;
      colors[idx] = r;
      colors[idx + 1] = g;
      colors[idx + 2] = b;
    }
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  // CRITICAL: Also add UV2 for material ID encoding
  // This ensures ALL building geometries have consistent attributes for mergeGeometries
  if (!geometry.hasAttribute("uv2")) {
    const uv2 = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i++) {
      uv2[i * 2] = materialId;
      uv2[i * 2 + 1] = 0.0; // surface type (unused for most cases)
    }
    geometry.setAttribute("uv2", new THREE.BufferAttribute(uv2, 2));
  }
}

/**
 * Apply both vertex colors and UV coordinates to a geometry.
 *
 * This is the primary function for preparing building geometry with:
 * - Vertex colors for ambient occlusion and subtle color variation
 * - UV coordinates for procedural texture sampling
 *
 * @param geometry - BufferGeometry to process
 * @param color - Base color for vertex coloring
 * @param surfaceType - Type of surface for appropriate UV projection
 * @param config - Configuration options
 * @param isVerticalWall - For wall surfaces, whether wall runs along Z axis
 */
export function applyGeometryAttributes(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  surfaceType: SurfaceType = "generic",
  config: GeometryAttributeConfig = {},
  isVerticalWall: boolean = false,
): void {
  const {
    uvScale = 1.0,
    applyUVs = true,
    uvOffset = { u: 0, v: 0 },
    noiseScale = 0.35,
    noiseAmp = 0.35,
    minShade = 0.78,
    materialId,
  } = config;

  // Apply vertex colors
  applyVertexColors(geometry, color, noiseScale, noiseAmp, minShade);

  // Apply UVs based on surface type
  if (applyUVs) {
    const uvConfig = {
      scale: uvScale,
      offset: uvOffset,
    };

    switch (surfaceType) {
      case "wall":
        applyWallUVs(geometry, uvConfig, isVerticalWall);
        break;
      case "floor":
      case "ceiling":
        applyFloorUVs(geometry, uvConfig);
        break;
      case "roof":
        // Roof uses generic world-space projection
        // Could be enhanced with applyRoofUVs for sloped surfaces
        applyWorldSpaceUVs(geometry, uvConfig);
        break;
      case "generic":
      default:
        applyWorldSpaceUVs(geometry, uvConfig);
        break;
    }
  }

  // CRITICAL: ALWAYS apply UV2 for material ID and surface type encoding
  // mergeGeometries requires all geometries to have consistent attributes
  // Determine surface type from the surfaceType parameter
  let surfaceTypeId: number = SURFACE_TYPE_IDS.WALL;
  if (surfaceType === "floor") {
    surfaceTypeId = SURFACE_TYPE_IDS.FLOOR;
  } else if (surfaceType === "ceiling") {
    surfaceTypeId = SURFACE_TYPE_IDS.CEILING;
  } else if (surfaceType === "roof") {
    surfaceTypeId = SURFACE_TYPE_IDS.ROOF;
  }
  applyMaterialIdUV2(geometry, materialId ?? 0.0, surfaceTypeId);
}

/**
 * Apply wall-specific geometry attributes.
 *
 * Convenience function for wall geometry with appropriate defaults.
 *
 * @param geometry - Wall geometry
 * @param color - Wall color
 * @param isVertical - Whether wall runs along Z axis (true) or X axis (false)
 * @param uvScale - UV scale for texture density
 */
export function applyWallAttributes(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  isVertical: boolean,
  uvScale: number = 1.0,
  materialId?: number,
): void {
  applyGeometryAttributes(
    geometry,
    color,
    "wall",
    { uvScale, materialId },
    isVertical,
  );
}

/**
 * Apply floor/ceiling-specific geometry attributes.
 *
 * @param geometry - Floor or ceiling geometry
 * @param color - Surface color
 * @param uvScale - UV scale for texture density
 */
export function applyFloorAttributes(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  uvScale: number = 1.0,
): void {
  applyGeometryAttributes(geometry, color, "floor", { uvScale });
}

/**
 * Apply roof-specific geometry attributes.
 *
 * @param geometry - Roof geometry
 * @param color - Roof color
 * @param uvScale - UV scale for texture density
 */
export function applyRoofAttributes(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  uvScale: number = 0.3,
): void {
  applyGeometryAttributes(geometry, color, "roof", { uvScale });
}

/**
 * Optimize a merged geometry by:
 * 1. Removing internal/duplicate faces (coplanar overlapping triangles)
 * 2. Removing back-to-back faces (adjacent boxes sharing a face)
 * 3. Merging vertices ONLY where position, color, AND normal match
 * 4. Computing per-face normals (hard edges for architectural geometry)
 *
 * IMPORTANT: This preserves:
 * - Vertex colors at material boundaries (no color bleeding)
 * - Hard edges at corners (no smooth shading on box geometry)
 */
export function removeInternalFaces(
  geometry: THREE.BufferGeometry | null,
): THREE.BufferGeometry {
  if (!geometry) {
    return new THREE.BufferGeometry();
  }

  // Step 1: Convert to non-indexed to work with individual triangles
  const nonIndexed = geometry.toNonIndexed();
  const position = nonIndexed.attributes.position;
  const color = nonIndexed.attributes.color;
  const uv = nonIndexed.attributes.uv;
  const uv2 = nonIndexed.attributes.uv2; // CRITICAL: Preserve UV2 for material ID
  const posArray = position.array as Float32Array;
  const colorArray = color ? (color.array as Float32Array) : null;
  const uvArray = uv ? (uv.array as Float32Array) : null;
  const uv2Array = uv2 ? (uv2.array as Float32Array) : null;
  const triCount = position.count / 3;

  const precision = 1000; // Snap to 1mm precision
  const colorPrecision = 100; // Color precision (1% increments)

  // Helper to create a sorted vertex key for a triangle (position only)
  const makeVertexKey = (i0: number, i1: number, i2: number): string => {
    const verts = [i0, i1, i2].map((idx) => {
      const x = Math.round(position.getX(idx) * precision);
      const y = Math.round(position.getY(idx) * precision);
      const z = Math.round(position.getZ(idx) * precision);
      return `${x},${y},${z}`;
    });
    verts.sort();
    return verts.join("|");
  };

  // Helper to compute triangle normal
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  const getTriNormal = (i0: number, i1: number, i2: number): THREE.Vector3 => {
    v0.set(position.getX(i0), position.getY(i0), position.getZ(i0));
    v1.set(position.getX(i1), position.getY(i1), position.getZ(i1));
    v2.set(position.getX(i2), position.getY(i2), position.getZ(i2));
    edge1.subVectors(v1, v0);
    edge2.subVectors(v2, v0);
    normal.crossVectors(edge1, edge2).normalize();
    return normal.clone();
  };

  // Step 2: Group triangles by their vertex positions (same vertices = same face location)
  const faceGroups = new Map<
    string,
    Array<{ tri: number; normal: THREE.Vector3 }>
  >();

  for (let tri = 0; tri < triCount; tri += 1) {
    const i0 = tri * 3;
    const i1 = tri * 3 + 1;
    const i2 = tri * 3 + 2;
    const key = makeVertexKey(i0, i1, i2);
    const triNormal = getTriNormal(i0, i1, i2);

    if (!faceGroups.has(key)) {
      faceGroups.set(key, []);
    }
    faceGroups.get(key)!.push({ tri, normal: triNormal });
  }

  // Step 3: Mark triangles to remove
  // - Exact duplicates (same vertices, same or similar normal)
  // - Back-to-back faces (same vertices, opposite normals)
  const keep = new Array(triCount).fill(true);

  for (const faces of faceGroups.values()) {
    if (faces.length > 1) {
      // Multiple triangles at the same position
      // Check if they're duplicates or back-to-back

      // Group by normal direction
      const normalGroups: Array<{ normal: THREE.Vector3; tris: number[] }> = [];

      for (const face of faces) {
        let found = false;
        for (const group of normalGroups) {
          // Check if normals are similar (same direction) or opposite
          const dot = face.normal.dot(group.normal);
          if (Math.abs(dot) > 0.99) {
            // Same or opposite direction
            group.tris.push(face.tri);
            found = true;
            break;
          }
        }
        if (!found) {
          normalGroups.push({ normal: face.normal.clone(), tris: [face.tri] });
        }
      }

      // For each group, if there are faces with opposite normals, remove all
      // (they're internal back-to-back faces)
      for (const group of normalGroups) {
        if (group.tris.length > 1) {
          // Check for opposing normals within this group
          let hasOpposing = false;
          for (let i = 0; i < group.tris.length && !hasOpposing; i++) {
            const n1 = faces.find((f) => f.tri === group.tris[i])!.normal;
            for (let j = i + 1; j < group.tris.length; j++) {
              const n2 = faces.find((f) => f.tri === group.tris[j])!.normal;
              if (n1.dot(n2) < -0.99) {
                hasOpposing = true;
                break;
              }
            }
          }

          if (hasOpposing) {
            // Remove all faces in this group (back-to-back internal faces)
            for (const tri of group.tris) {
              keep[tri] = false;
            }
          } else if (group.tris.length > 1) {
            // Exact duplicates (same normal), keep only the first
            for (let i = 1; i < group.tris.length; i++) {
              keep[group.tris[i]] = false;
            }
          }
        }
      }
    }
  }

  let keptCount = 0;
  for (let tri = 0; tri < triCount; tri += 1) {
    if (keep[tri]) keptCount += 1;
  }

  // Step 4: Build cleaned geometry with only external faces
  const newPos = new Float32Array(keptCount * 9);
  const newColor = colorArray ? new Float32Array(keptCount * 9) : null;
  const newUV = uvArray ? new Float32Array(keptCount * 6) : null; // 2 components per vertex, 3 vertices per tri = 6
  const newUV2 = uv2Array ? new Float32Array(keptCount * 6) : null; // CRITICAL: Preserve UV2 for material ID
  let dst = 0;
  let uvDst = 0;

  for (let tri = 0; tri < triCount; tri += 1) {
    if (!keep[tri]) continue;
    const src = tri * 9;
    const uvSrc = tri * 6;
    for (let i = 0; i < 9; i += 1) {
      newPos[dst + i] = posArray[src + i];
      if (newColor && colorArray) {
        newColor[dst + i] = colorArray[src + i];
      }
    }
    if (newUV && uvArray) {
      for (let i = 0; i < 6; i += 1) {
        newUV[uvDst + i] = uvArray[uvSrc + i];
      }
    }
    if (newUV2 && uv2Array) {
      for (let i = 0; i < 6; i += 1) {
        newUV2[uvDst + i] = uv2Array[uvSrc + i];
      }
    }
    uvDst += 6;
    dst += 9;
  }

  // Dispose the intermediate non-indexed geometry
  nonIndexed.dispose();

  const cleaned = new THREE.BufferGeometry();
  cleaned.setAttribute("position", new THREE.BufferAttribute(newPos, 3));
  if (newColor) {
    cleaned.setAttribute("color", new THREE.BufferAttribute(newColor, 3));
  }
  if (newUV) {
    cleaned.setAttribute("uv", new THREE.BufferAttribute(newUV, 2));
  }
  if (newUV2) {
    cleaned.setAttribute("uv2", new THREE.BufferAttribute(newUV2, 2));
  }

  // Step 5: Always compute flat normals for architectural geometry
  // BoxGeometry uses smooth normals (averaged at vertices), but we need flat normals
  // for hard edges and correct lighting. Flat normals ensure each face has its own
  // independent normal pointing outward, which is critical for proper PBR lighting.
  computeFlatNormals(cleaned);

  // Step 6: Smart vertex merging - only merge vertices with SAME position, color, AND normal
  // This preserves:
  // - Hard edges (vertices with different normals stay separate)
  // - Material boundaries (vertices with different colors stay separate)
  const optimized = mergeVerticesPreservingAttributes(
    cleaned,
    precision,
    colorPrecision,
  );
  cleaned.dispose();

  return optimized;
}

/**
 * Merge vertices that have the same position, color, normal, UV, AND UV2.
 * Unlike Three.js mergeVertices, this preserves hard edges and color boundaries.
 *
 * @param geometry - Non-indexed geometry with position, color, normal, uv, and uv2 attributes
 * @param posPrecision - Position precision (vertices within 1/precision are considered same)
 * @param colorPrecision - Color precision (colors within 1/colorPrecision are considered same)
 */
function mergeVerticesPreservingAttributes(
  geometry: THREE.BufferGeometry,
  posPrecision: number,
  colorPrecision: number,
): THREE.BufferGeometry {
  const position = geometry.attributes.position;
  const color = geometry.attributes.color;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const uv2 = geometry.attributes.uv2; // CRITICAL: Preserve UV2 for material ID

  if (!position) return geometry;

  const vertexCount = position.count;
  const uvPrecision = 1000; // UV precision

  // Build a map of unique vertices (position + color + normal + uv + uv2)
  const vertexMap = new Map<string, number>();
  const uniquePositions: number[] = [];
  const uniqueColors: number[] = [];
  const uniqueNormals: number[] = [];
  const uniqueUVs: number[] = [];
  const uniqueUV2s: number[] = [];
  const indexMap: number[] = []; // Maps old vertex index to new index

  for (let i = 0; i < vertexCount; i++) {
    // Create key from position, color, normal, uv, and uv2
    const px = Math.round(position.getX(i) * posPrecision);
    const py = Math.round(position.getY(i) * posPrecision);
    const pz = Math.round(position.getZ(i) * posPrecision);

    let key = `${px},${py},${pz}`;

    if (color) {
      const cr = Math.round(color.getX(i) * colorPrecision);
      const cg = Math.round(color.getY(i) * colorPrecision);
      const cb = Math.round(color.getZ(i) * colorPrecision);
      key += `|${cr},${cg},${cb}`;
    }

    if (normal) {
      // Round normals to 2 decimal places (enough for axis-aligned normals)
      const nx = Math.round(normal.getX(i) * 100);
      const ny = Math.round(normal.getY(i) * 100);
      const nz = Math.round(normal.getZ(i) * 100);
      key += `|${nx},${ny},${nz}`;
    }

    if (uv) {
      const uvU = Math.round(uv.getX(i) * uvPrecision);
      const uvV = Math.round(uv.getY(i) * uvPrecision);
      key += `|${uvU},${uvV}`;
    }

    if (uv2) {
      // UV2 stores material ID, include in key to preserve material boundaries
      const uv2U = Math.round(uv2.getX(i) * uvPrecision);
      const uv2V = Math.round(uv2.getY(i) * uvPrecision);
      key += `|${uv2U},${uv2V}`;
    }

    let newIndex = vertexMap.get(key);
    if (newIndex === undefined) {
      // New unique vertex
      newIndex = uniquePositions.length / 3;
      vertexMap.set(key, newIndex);

      uniquePositions.push(
        position.getX(i),
        position.getY(i),
        position.getZ(i),
      );
      if (color) {
        uniqueColors.push(color.getX(i), color.getY(i), color.getZ(i));
      }
      if (normal) {
        uniqueNormals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      }
      if (uv) {
        uniqueUVs.push(uv.getX(i), uv.getY(i));
      }
      if (uv2) {
        uniqueUV2s.push(uv2.getX(i), uv2.getY(i));
      }
    }

    indexMap.push(newIndex);
  }

  // If no vertices were merged, return original geometry
  if (uniquePositions.length === vertexCount * 3) {
    return geometry;
  }

  // Build indexed geometry
  const result = new THREE.BufferGeometry();
  result.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(uniquePositions), 3),
  );

  if (color && uniqueColors.length > 0) {
    result.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(uniqueColors), 3),
    );
  }

  if (normal && uniqueNormals.length > 0) {
    result.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(uniqueNormals), 3),
    );
  }

  if (uv && uniqueUVs.length > 0) {
    result.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(uniqueUVs), 2),
    );
  }

  if (uv2 && uniqueUV2s.length > 0) {
    result.setAttribute(
      "uv2",
      new THREE.BufferAttribute(new Float32Array(uniqueUV2s), 2),
    );
  }

  // Set index buffer
  const indices = new Uint32Array(indexMap);
  result.setIndex(new THREE.BufferAttribute(indices, 1));

  return result;
}

// ============================================================
// GREEDY MESHING - Optimize large flat surfaces
// ============================================================

/**
 * A rectangular region in a 2D grid
 */
export interface GridRect {
  col: number;
  row: number;
  width: number; // columns
  height: number; // rows
}

/**
 * Greedy mesh a 2D boolean grid into minimal rectangles.
 * This dramatically reduces geometry for floors, ceilings, and other flat surfaces.
 *
 * Algorithm: Scan left-to-right, top-to-bottom. For each unvisited cell,
 * expand right as far as possible, then expand down as far as possible
 * while maintaining a rectangular shape.
 *
 * @param grid - 2D boolean array (true = filled)
 * @returns Array of rectangles that cover all true cells
 */
export function greedyMesh2D(grid: boolean[][]): GridRect[] {
  if (grid.length === 0) return [];

  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (cols === 0) return [];

  // Track which cells have been included in a rectangle
  const visited: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => false),
  );

  const rects: GridRect[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Skip if not filled or already visited
      if (!grid[row][col] || visited[row][col]) continue;

      // Find max width (expand right)
      let width = 1;
      while (
        col + width < cols &&
        grid[row][col + width] &&
        !visited[row][col + width]
      ) {
        width++;
      }

      // Find max height (expand down) while maintaining width
      let height = 1;
      outer: while (row + height < rows) {
        // Check if entire row segment is available
        for (let c = col; c < col + width; c++) {
          if (!grid[row + height][c] || visited[row + height][c]) {
            break outer;
          }
        }
        height++;
      }

      // Mark all cells in this rect as visited
      for (let r = row; r < row + height; r++) {
        for (let c = col; c < col + width; c++) {
          visited[r][c] = true;
        }
      }

      rects.push({ col, row, width, height });
    }
  }

  return rects;
}

/**
 * Greedy mesh with color support - groups cells by color before meshing.
 * Use when different cells have different vertex colors.
 *
 * @param grid - 2D boolean array (true = filled)
 * @param colorGrid - 2D array of color indices (cells with same index are merged)
 * @returns Map of color index to rectangles
 */
export function greedyMesh2DWithColors(
  grid: boolean[][],
  colorGrid: number[][],
): Map<number, GridRect[]> {
  if (grid.length === 0) return new Map();

  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (cols === 0) return new Map();

  // Group cells by color
  const colorGroups = new Map<number, boolean[][]>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!grid[row][col]) continue;

      const colorIdx = colorGrid[row]?.[col] ?? 0;
      if (!colorGroups.has(colorIdx)) {
        colorGroups.set(
          colorIdx,
          Array.from({ length: rows }, () =>
            Array.from({ length: cols }, () => false),
          ),
        );
      }
      colorGroups.get(colorIdx)![row][col] = true;
    }
  }

  // Greedy mesh each color group
  const result = new Map<number, GridRect[]>();
  for (const [colorIdx, colorMask] of colorGroups) {
    result.set(colorIdx, greedyMesh2D(colorMask));
  }

  return result;
}

/**
 * Create a single flat quad geometry (floor/ceiling tile)
 * More efficient than BoxGeometry for thin slabs
 */
export function createFlatQuad(
  width: number,
  depth: number,
  thickness: number,
  _faceUp: boolean = true,
): THREE.BufferGeometry {
  // Use BoxGeometry with 1,1,1 segments for minimal triangles
  const geometry = new THREE.BoxGeometry(width, thickness, depth, 1, 1, 1);
  return geometry;
}

// ============================================================
// INTERIOR SURFACE GEOMETRY - NO SIDE FACES
// ============================================================

/**
 * Create a flat plane for interior floors (top face only, no side faces).
 * This prevents z-fighting with walls and eliminates unnecessary geometry.
 *
 * @param width - Width of the plane (X axis)
 * @param depth - Depth of the plane (Z axis)
 * @returns PlaneGeometry rotated to face upward (+Y)
 */
export function createFloorPlane(
  width: number,
  depth: number,
): THREE.BufferGeometry {
  // PlaneGeometry is created facing +Z by default, rotate to face +Y
  const geometry = new THREE.PlaneGeometry(width, depth);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * Create a flat plane for interior ceilings (bottom face only, no side faces).
 * This prevents z-fighting with walls and eliminates unnecessary geometry.
 *
 * @param width - Width of the plane (X axis)
 * @param depth - Depth of the plane (Z axis)
 * @returns PlaneGeometry rotated to face downward (-Y)
 */
export function createCeilingPlane(
  width: number,
  depth: number,
): THREE.BufferGeometry {
  // PlaneGeometry is created facing +Z by default, rotate to face -Y
  const geometry = new THREE.PlaneGeometry(width, depth);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/**
 * Create floor plane geometry for a merged region with per-edge insets.
 * Uses a single upward-facing plane instead of a box - no side faces.
 *
 * @param rect - The grid rectangle from greedy meshing
 * @param cellSize - Size of each cell in world units
 * @param y - Y position of the floor surface (top of floor slab)
 * @param gridWidth - Total grid width in cells
 * @param gridDepth - Total grid depth in cells
 * @param edgeInsets - Per-edge inset amounts (0 for interior edges, INTERIOR_INSET for exterior)
 */
export function createInteriorFloorGeometry(
  rect: GridRect,
  cellSize: number,
  y: number,
  gridWidth: number,
  gridDepth: number,
  edgeInsets: EdgeInsets,
): THREE.BufferGeometry {
  const halfGridWidth = (gridWidth * cellSize) / 2;
  const halfGridDepth = (gridDepth * cellSize) / 2;

  // Calculate base world position (without insets)
  const baseStartX = rect.col * cellSize - halfGridWidth;
  const baseStartZ = rect.row * cellSize - halfGridDepth;
  const baseWidth = rect.width * cellSize;
  const baseDepth = rect.height * cellSize;

  // Apply per-edge insets
  const startX = baseStartX + edgeInsets.west;
  const startZ = baseStartZ + edgeInsets.north;
  const width = baseWidth - edgeInsets.west - edgeInsets.east;
  const depth = baseDepth - edgeInsets.north - edgeInsets.south;

  // Ensure minimum size to avoid degenerate geometry
  const finalWidth = Math.max(width, 0.01);
  const finalDepth = Math.max(depth, 0.01);

  const centerX = startX + finalWidth / 2;
  const centerZ = startZ + finalDepth / 2;

  // Use flat plane instead of box - only visible face, no side faces
  const geometry = createFloorPlane(finalWidth, finalDepth);
  geometry.translate(centerX, y, centerZ);

  return geometry;
}

/**
 * Create ceiling plane geometry for a merged region with per-edge insets.
 * Uses a single downward-facing plane instead of a box - no side faces.
 *
 * @param rect - The grid rectangle from greedy meshing
 * @param cellSize - Size of each cell in world units
 * @param y - Y position of the ceiling surface (bottom of ceiling slab)
 * @param gridWidth - Total grid width in cells
 * @param gridDepth - Total grid depth in cells
 * @param edgeInsets - Per-edge inset amounts (0 for interior edges, INTERIOR_INSET for exterior)
 */
export function createInteriorCeilingGeometry(
  rect: GridRect,
  cellSize: number,
  y: number,
  gridWidth: number,
  gridDepth: number,
  edgeInsets: EdgeInsets,
): THREE.BufferGeometry {
  const halfGridWidth = (gridWidth * cellSize) / 2;
  const halfGridDepth = (gridDepth * cellSize) / 2;

  // Calculate base world position (without insets)
  const baseStartX = rect.col * cellSize - halfGridWidth;
  const baseStartZ = rect.row * cellSize - halfGridDepth;
  const baseWidth = rect.width * cellSize;
  const baseDepth = rect.height * cellSize;

  // Apply per-edge insets
  const startX = baseStartX + edgeInsets.west;
  const startZ = baseStartZ + edgeInsets.north;
  const width = baseWidth - edgeInsets.west - edgeInsets.east;
  const depth = baseDepth - edgeInsets.north - edgeInsets.south;

  // Ensure minimum size to avoid degenerate geometry
  const finalWidth = Math.max(width, 0.01);
  const finalDepth = Math.max(depth, 0.01);

  const centerX = startX + finalWidth / 2;
  const centerZ = startZ + finalDepth / 2;

  // Use flat plane instead of box - only visible face, no side faces
  const geometry = createCeilingPlane(finalWidth, finalDepth);
  geometry.translate(centerX, y, centerZ);

  return geometry;
}

/**
 * Create geometry for a merged floor/ceiling region
 */
export function createMergedFloorGeometry(
  rect: GridRect,
  cellSize: number,
  thickness: number,
  y: number,
  gridWidth: number,
  gridDepth: number,
  inset: number = 0,
): THREE.BufferGeometry {
  const halfGridWidth = (gridWidth * cellSize) / 2;
  const halfGridDepth = (gridDepth * cellSize) / 2;

  // Calculate world position and size
  const startX = rect.col * cellSize - halfGridWidth + inset;
  const startZ = rect.row * cellSize - halfGridDepth + inset;
  const width = rect.width * cellSize - inset * 2;
  const depth = rect.height * cellSize - inset * 2;

  const centerX = startX + width / 2;
  const centerZ = startZ + depth / 2;

  const geometry = new THREE.BoxGeometry(width, thickness, depth, 1, 1, 1);
  geometry.translate(centerX, y, centerZ);

  return geometry;
}

/**
 * Per-edge inset configuration for floor/ceiling tiles
 */
export interface EdgeInsets {
  /** Inset from west (negative X) edge */
  west: number;
  /** Inset from east (positive X) edge */
  east: number;
  /** Inset from north (negative Z) edge */
  north: number;
  /** Inset from south (positive Z) edge */
  south: number;
}

/**
 * Create geometry for a merged floor/ceiling region with per-edge insets.
 * This properly handles interior edges (no inset) vs exterior edges (inset from walls).
 *
 * @param rect - The grid rectangle from greedy meshing
 * @param cellSize - Size of each cell in world units
 * @param thickness - Thickness of the floor/ceiling slab
 * @param y - Y position (center of slab)
 * @param gridWidth - Total grid width in cells
 * @param gridDepth - Total grid depth in cells
 * @param edgeInsets - Per-edge inset amounts (0 for interior edges, WALL_THICKNESS/2 for exterior)
 */
export function createMergedFloorGeometryWithEdgeInsets(
  rect: GridRect,
  cellSize: number,
  thickness: number,
  y: number,
  gridWidth: number,
  gridDepth: number,
  edgeInsets: EdgeInsets,
): THREE.BufferGeometry {
  const halfGridWidth = (gridWidth * cellSize) / 2;
  const halfGridDepth = (gridDepth * cellSize) / 2;

  // Calculate base world position (without insets)
  const baseStartX = rect.col * cellSize - halfGridWidth;
  const baseStartZ = rect.row * cellSize - halfGridDepth;
  const baseWidth = rect.width * cellSize;
  const baseDepth = rect.height * cellSize;

  // Apply per-edge insets
  const startX = baseStartX + edgeInsets.west;
  const startZ = baseStartZ + edgeInsets.north;
  const width = baseWidth - edgeInsets.west - edgeInsets.east;
  const depth = baseDepth - edgeInsets.north - edgeInsets.south;

  // Ensure minimum size to avoid degenerate geometry
  const finalWidth = Math.max(width, 0.01);
  const finalDepth = Math.max(depth, 0.01);

  const centerX = startX + finalWidth / 2;
  const centerZ = startZ + finalDepth / 2;

  const geometry = new THREE.BoxGeometry(
    finalWidth,
    thickness,
    finalDepth,
    1,
    1,
    1,
  );
  geometry.translate(centerX, y, centerZ);

  return geometry;
}

/**
 * Calculate edge insets for a merged floor/ceiling rectangle based on building footprint.
 * Returns insets for edges that are against external walls (outside the footprint).
 *
 * @param rect - The grid rectangle from greedy meshing
 * @param footprint - The building footprint (true = cell exists)
 * @param wallInset - The inset amount for edges against external walls (typically WALL_THICKNESS/2)
 * @returns EdgeInsets with appropriate inset for each edge
 */
export function calculateEdgeInsetsForRect(
  rect: GridRect,
  footprint: boolean[][],
  wallInset: number,
): EdgeInsets {
  const rows = footprint.length;
  const cols = footprint[0]?.length ?? 0;

  // Helper to check if a cell is occupied in the footprint
  const isCellOccupied = (col: number, row: number): boolean => {
    if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
    return footprint[row][col] ?? false;
  };

  // Check if entire edge is against external wall (no cells adjacent on that side)
  // West edge: check column to the left of rect.col
  let westIsExternal = true;
  for (let r = rect.row; r < rect.row + rect.height && westIsExternal; r++) {
    if (isCellOccupied(rect.col - 1, r)) {
      westIsExternal = false;
    }
  }

  // East edge: check column to the right of rect.col + rect.width - 1
  let eastIsExternal = true;
  for (let r = rect.row; r < rect.row + rect.height && eastIsExternal; r++) {
    if (isCellOccupied(rect.col + rect.width, r)) {
      eastIsExternal = false;
    }
  }

  // North edge: check row above rect.row
  let northIsExternal = true;
  for (let c = rect.col; c < rect.col + rect.width && northIsExternal; c++) {
    if (isCellOccupied(c, rect.row - 1)) {
      northIsExternal = false;
    }
  }

  // South edge: check row below rect.row + rect.height - 1
  let southIsExternal = true;
  for (let c = rect.col; c < rect.col + rect.width && southIsExternal; c++) {
    if (isCellOccupied(c, rect.row + rect.height)) {
      southIsExternal = false;
    }
  }

  return {
    west: westIsExternal ? wallInset : 0,
    east: eastIsExternal ? wallInset : 0,
    north: northIsExternal ? wallInset : 0,
    south: southIsExternal ? wallInset : 0,
  };
}

// ============================================================
// WALL SEGMENT MERGING
// ============================================================

/**
 * A wall segment that can be merged with adjacent segments
 */
export interface WallSegment {
  x: number;
  z: number;
  length: number;
  isVertical: boolean;
  hasOpening: boolean;
  openingType?: string;
}

/**
 * Merge adjacent wall segments into longer walls.
 * Only merges segments that don't have openings (doors/windows).
 *
 * @param segments - Array of wall segments on the same edge
 * @param isVertical - Whether walls run along Z axis
 * @returns Merged wall segments
 */
export function mergeWallSegments(
  segments: WallSegment[],
  isVertical: boolean,
): WallSegment[] {
  if (segments.length <= 1) return segments;

  // Sort by position
  const sorted = [...segments].sort((a, b) =>
    isVertical ? a.z - b.z : a.x - b.x,
  );

  const merged: WallSegment[] = [];
  let current: WallSegment | null = null;

  for (const seg of sorted) {
    if (seg.hasOpening) {
      // Can't merge segments with openings
      if (current) {
        merged.push(current);
        current = null;
      }
      merged.push(seg);
      continue;
    }

    if (!current) {
      current = { ...seg };
      continue;
    }

    // Check if segments are adjacent
    const currentEnd = isVertical
      ? current.z + current.length / 2
      : current.x + current.length / 2;
    const segStart = isVertical
      ? seg.z - seg.length / 2
      : seg.x - seg.length / 2;

    const gap = Math.abs(currentEnd - segStart);

    if (gap < 0.01) {
      // Merge: extend current segment
      current.length += seg.length;
      // Update center position
      if (isVertical) {
        current.z = (current.z + seg.z) / 2 + seg.length / 4;
      } else {
        current.x = (current.x + seg.x) / 2 + seg.length / 4;
      }
    } else {
      // Gap too large, start new segment
      merged.push(current);
      current = { ...seg };
    }
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

// ============================================================
// LOD GENERATION
// ============================================================

// LODLevel enum is defined in ./types.ts - import from there if needed

/**
 * Create a simplified LOD1 building geometry (merged walls, no openings)
 */
export function createLOD1Geometry(
  width: number,
  depth: number,
  height: number,
  foundationHeight: number,
): THREE.BufferGeometry {
  // Single box for the entire building shell
  const geometry = new THREE.BoxGeometry(width, height, depth, 1, 1, 1);
  geometry.translate(0, foundationHeight + height / 2, 0);
  return geometry;
}

/**
 * Create a minimal LOD2 building geometry (just a box)
 */
export function createLOD2Geometry(
  width: number,
  depth: number,
  totalHeight: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, totalHeight, depth, 1, 1, 1);
  geometry.translate(0, totalHeight / 2, 0);
  return geometry;
}

// ============================================================
// GEOMETRY CACHING
// ============================================================

/**
 * Simple geometry cache for reusable building elements
 */
class GeometryCache {
  private cache = new Map<string, THREE.BufferGeometry>();

  /**
   * Get or create a cached geometry
   */
  getOrCreate(
    key: string,
    factory: () => THREE.BufferGeometry,
  ): THREE.BufferGeometry {
    let geometry = this.cache.get(key);
    if (!geometry) {
      geometry = factory();
      this.cache.set(key, geometry);
    }
    // Return a clone so the cached version isn't modified
    return geometry.clone();
  }

  /**
   * Clear all cached geometries
   */
  clear(): void {
    for (const geometry of this.cache.values()) {
      geometry.dispose();
    }
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { count: number; keys: string[] } {
    return {
      count: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/** Global geometry cache instance */
export const geometryCache = new GeometryCache();

/**
 * Get cached box geometry
 */
export function getCachedBox(
  width: number,
  height: number,
  depth: number,
): THREE.BufferGeometry {
  // Round dimensions to avoid floating point key issues
  const w = Math.round(width * 1000) / 1000;
  const h = Math.round(height * 1000) / 1000;
  const d = Math.round(depth * 1000) / 1000;
  const key = `box_${w}_${h}_${d}`;

  return geometryCache.getOrCreate(
    key,
    () => new THREE.BoxGeometry(w, h, d, 1, 1, 1),
  );
}

// ============================================================
// ORIGINAL GEOMETRY FUNCTIONS
// ============================================================

/**
 * Create an arch top geometry (half-circle)
 */
export function createArchTopGeometry(
  width: number,
  thickness: number,
  _segments = 12,
): THREE.BufferGeometry {
  const radius = width / 2;
  const shape = new THREE.Shape();

  shape.moveTo(-radius, 0);
  shape.absarc(0, 0, radius, Math.PI, 0, true);
  shape.lineTo(-radius, 0);

  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    steps: 1,
    depth: thickness,
    bevelEnabled: false,
  };

  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/**
 * Create a mitered box geometry for wall corners
 */
export function createMiteredBoxGeometry(
  width: number,
  height: number,
  depth: number,
  miterSide: "left" | "right" | "both" | "none" = "none",
): THREE.BufferGeometry {
  if (miterSide === "none") {
    return new THREE.BoxGeometry(width, height, depth);
  }

  const shape = new THREE.Shape();
  const halfW = width / 2;
  const halfD = depth / 2;

  if (miterSide === "both") {
    shape.moveTo(-halfW + depth, -halfD);
    shape.lineTo(halfW - depth, -halfD);
    shape.lineTo(halfW, -halfD + depth);
    shape.lineTo(halfW, halfD - depth);
    shape.lineTo(halfW - depth, halfD);
    shape.lineTo(-halfW + depth, halfD);
    shape.lineTo(-halfW, halfD - depth);
    shape.lineTo(-halfW, -halfD + depth);
    shape.closePath();
  } else if (miterSide === "left") {
    shape.moveTo(-halfW + depth, -halfD);
    shape.lineTo(halfW, -halfD);
    shape.lineTo(halfW, halfD);
    shape.lineTo(-halfW + depth, halfD);
    shape.lineTo(-halfW, halfD - depth);
    shape.lineTo(-halfW, -halfD + depth);
    shape.closePath();
  } else {
    shape.moveTo(-halfW, -halfD);
    shape.lineTo(halfW - depth, -halfD);
    shape.lineTo(halfW, -halfD + depth);
    shape.lineTo(halfW, halfD - depth);
    shape.lineTo(halfW - depth, halfD);
    shape.lineTo(-halfW, halfD);
    shape.closePath();
  }

  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    steps: 1,
    depth: height,
    bevelEnabled: false,
  };

  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * Get the center position of a cell in world coordinates
 */
export function getCellCenter(
  col: number,
  row: number,
  cellSize: number,
  width: number,
  depth: number,
): { x: number; z: number } {
  const halfWidth = (width * cellSize) / 2;
  const halfDepth = (depth * cellSize) / 2;
  return {
    x: col * cellSize + cellSize / 2 - halfWidth,
    z: row * cellSize + cellSize / 2 - halfDepth,
  };
}

/**
 * Corner chamfer configuration for wall segments
 */
export type ChamferConfig = {
  startChamfer: "none" | "left" | "right"; // Chamfer at the negative end of the wall
  endChamfer: "none" | "left" | "right"; // Chamfer at the positive end of the wall
};

/**
 * Create a wall geometry with chamfered corners for proper joining
 * Uses BoxGeometry for compatibility with mergeGeometries
 *
 * Instead of actual chamfers, we use a simplified approach:
 * - Full-length walls meet at 90-degree corners
 * - The removeInternalFaces function handles overlapping geometry
 *
 * @param length - Length of the wall (along its primary axis)
 * @param height - Height of the wall
 * @param thickness - Thickness of the wall
 * @param isVertical - If true, wall runs along Z axis; if false, along X axis
 * @param chamfer - Configuration for chamfered corners (determines if we need to adjust length)
 */
export function createChamferedWallGeometry(
  length: number,
  height: number,
  thickness: number,
  isVertical: boolean,
  chamfer: ChamferConfig,
): THREE.BufferGeometry {
  // For simplicity and compatibility, we create standard box geometry
  // The removeInternalFaces step handles overlapping faces at corners

  // Calculate adjusted length based on chamfer configuration
  // At corners, we shorten walls by full thickness to prevent overlap
  // This ensures perpendicular walls meet cleanly without intersection
  let adjustedLength = length;
  let offset = 0;

  // At corners, shorten the wall by the full thickness
  // This eliminates the corner overlap region
  if (chamfer.startChamfer !== "none") {
    adjustedLength -= thickness;
    offset += thickness / 2;
  }
  if (chamfer.endChamfer !== "none") {
    adjustedLength -= thickness;
    offset -= thickness / 2;
  }

  const geometry = isVertical
    ? new THREE.BoxGeometry(thickness, height, adjustedLength)
    : new THREE.BoxGeometry(adjustedLength, height, thickness);

  // Apply offset to center the shortened wall properly
  if (isVertical) {
    geometry.translate(0, height / 2, offset);
  } else {
    geometry.translate(offset, height / 2, 0);
  }

  return geometry;
}

/**
 * Merge complete triangle buffers, preserving normals and common color/UV/UV2
 * attributes. Multi-input output is non-indexed; each indexed triangle corner
 * is expanded in its original order. Groups/draw ranges are not material splits.
 * Inputs are borrowed until a successful merge, then consumed if requested.
 * The historical singleton identity/clone behavior is intentionally retained.
 * @param geometries - Array of geometries to merge
 * @param disposeSource - Whether to dispose source geometries after merge (default: true)
 */
export function mergeBufferGeometries(
  geometries: THREE.BufferGeometry[],
  disposeSource: boolean = true,
): THREE.BufferGeometry {
  if (geometries.length === 0) return new THREE.BufferGeometry();
  // Architectural batches are small. Bound validation and allocation before
  // touching inputs (3M expanded corners need at most 156 MB of output arrays).
  const maximumCorners = 3_000_000;
  if (geometries.length > 4096)
    throw new Error("[mergeBufferGeometries] Too many source geometries");
  let totalVertices = 0;
  let sourceVertices = 0;
  let hasColor = true;
  let hasUV = true;
  let hasUV2 = true;
  for (const geo of geometries) {
    const pos = geo.attributes.position;
    if (!pos) {
      if (geo.index || Object.keys(geo.attributes).length > 0)
        throw new Error("[mergeBufferGeometries] Missing position attribute");
    } else {
      const count = geo.index?.count ?? pos.count;
      if (
        !Number.isSafeInteger(pos.count) ||
        pos.count < 0 ||
        pos.count > maximumCorners - sourceVertices ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count % 3 !== 0 ||
        count > maximumCorners - totalVertices
      )
        throw new Error("[mergeBufferGeometries] Invalid triangle count");
      totalVertices += count;
      sourceVertices += pos.count;
      for (const [name, size] of [
        ["position", 3],
        ["normal", 3],
        ["color", 3],
        ["uv", 2],
        ["uv2", 2],
      ] as const) {
        const attr = geo.attributes[name];
        if (!attr) continue;
        if (attr.itemSize !== size || attr.count !== pos.count)
          throw new Error(`[mergeBufferGeometries] Invalid ${name} shape`);
        for (let i = 0; i < attr.count; i++) {
          for (let component = 0; component < size; component++) {
            if (!Number.isFinite(Math.fround(attr.getComponent(i, component))))
              throw new Error(`[mergeBufferGeometries] Invalid ${name} value`);
          }
        }
      }
      if (geo.index) {
        if (geo.index.itemSize !== 1 || geo.index.normalized)
          throw new Error("[mergeBufferGeometries] Invalid index shape");
        for (let i = 0; i < geo.index.count; i++) {
          const index = geo.index.getX(i);
          if (!Number.isSafeInteger(index) || index < 0 || index >= pos.count)
            throw new Error("[mergeBufferGeometries] Invalid triangle index");
        }
      }
    }
    if (!geo.attributes.color) hasColor = false;
    if (!geo.attributes.uv) hasUV = false;
    if (!geo.attributes.uv2) hasUV2 = false;
  }
  if (geometries.length === 1)
    return disposeSource ? geometries[0] : geometries[0].clone();

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colors = hasColor ? new Float32Array(totalVertices * 3) : null;
  const uvs = hasUV ? new Float32Array(totalVertices * 2) : null;
  const uv2s = hasUV2 ? new Float32Array(totalVertices * 2) : null;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  let offset = 0;
  for (const geo of geometries) {
    const pos = geo.attributes.position;
    if (!pos) continue;

    const count = geo.index?.count ?? pos.count;
    const attributes = [
      [geo.attributes.position, positions, 3],
      [geo.attributes.normal, normals, 3],
      [geo.attributes.color, colors, 3],
      [geo.attributes.uv, uvs, 2],
      [geo.attributes.uv2, uv2s, 2],
    ] as const;
    for (let corner = 0; corner < count; corner++) {
      const index = geo.index ? geo.index.getX(corner) : corner;
      for (const [attr, destination, size] of attributes) {
        if (!destination || !attr) continue;
        for (let component = 0; component < size; component++) {
          destination[(offset + corner) * size + component] = attr.getComponent(
            index,
            component,
          );
        }
      }
    }
    if (!geo.attributes.normal) {
      // Generate flat normals only for these owned, expanded corners. Do not
      // mutate borrowed inputs, smooth across faces, or flip authored winding.
      for (let corner = 0; corner < count; corner += 3) {
        const start = (offset + corner) * 3;
        a.fromArray(positions, start);
        b.fromArray(positions, start + 3).sub(a);
        c.fromArray(positions, start + 6).sub(a);
        b.cross(c).normalize();
        for (let vertex = 0; vertex < 3; vertex++)
          b.toArray(normals, start + vertex * 3);
      }
    }

    offset += count;
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  result.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (colors)
    result.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (uvs) result.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (uv2s) result.setAttribute("uv2", new THREE.BufferAttribute(uv2s, 2));

  if (disposeSource) {
    // A repeated reference contributes geometry twice but has one owner.
    for (const geo of new Set(geometries)) geo.dispose();
  }

  return result;
}

// ============================================================
// GEOMETRY INTERSECTION VALIDATION
// ============================================================

/**
 * Axis-aligned bounding box for intersection detection
 */
export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  label: string;
}

/**
 * Result of geometry intersection validation
 */
export interface GeometryIntersectionResult {
  valid: boolean;
  intersections: Array<{
    label1: string;
    label2: string;
    overlapVolume: number;
  }>;
}

/**
 * Extract AABB from a BufferGeometry
 */
export function geometryToAABB(
  geometry: THREE.BufferGeometry,
  label: string,
): AABB {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;

  if (!box) {
    return {
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      minZ: 0,
      maxZ: 0,
      label,
    };
  }

  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
    minZ: box.min.z,
    maxZ: box.max.z,
    label,
  };
}

/**
 * Calculate the volume of overlap between two AABBs
 * Returns 0 if no overlap
 */
export function getAABBOverlapVolume(a: AABB, b: AABB): number {
  const overlapX = Math.max(
    0,
    Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX),
  );
  const overlapY = Math.max(
    0,
    Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY),
  );
  const overlapZ = Math.max(
    0,
    Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ),
  );
  return overlapX * overlapY * overlapZ;
}

/**
 * Check if two AABBs overlap beyond a small epsilon tolerance.
 * Returns true if boxes overlap in volume (not just touch at faces/edges/corners)
 */
export function aabbsOverlap(
  a: AABB,
  b: AABB,
  epsilon: number = 0.001,
): boolean {
  // Boxes overlap if they overlap on ALL three axes
  const overlapX = a.minX < b.maxX - epsilon && a.maxX > b.minX + epsilon;
  const overlapY = a.minY < b.maxY - epsilon && a.maxY > b.minY + epsilon;
  const overlapZ = a.minZ < b.maxZ - epsilon && a.maxZ > b.minZ + epsilon;
  return overlapX && overlapY && overlapZ;
}

/**
 * Validate that building geometry pieces don't intersect beyond a tolerance.
 *
 * @param geometries - Array of geometries with labels to check
 * @param epsilon - Tolerance for intersection detection (default 0.001 = 1mm)
 * @param minOverlapVolume - Minimum overlap volume to report (default 0.0001 = 0.1 cm³)
 * @returns Validation result with any detected intersections
 */
export function validateGeometryNoIntersections(
  geometries: Array<{ geometry: THREE.BufferGeometry; label: string }>,
  epsilon: number = 0.001,
  minOverlapVolume: number = 0.0001,
): GeometryIntersectionResult {
  const aabbs: AABB[] = geometries.map(({ geometry, label }) =>
    geometryToAABB(geometry, label),
  );

  const intersections: GeometryIntersectionResult["intersections"] = [];

  // Check all pairs of AABBs for intersection
  for (let i = 0; i < aabbs.length; i++) {
    for (let j = i + 1; j < aabbs.length; j++) {
      const a = aabbs[i];
      const b = aabbs[j];

      if (aabbsOverlap(a, b, epsilon)) {
        const overlapVolume = getAABBOverlapVolume(a, b);

        // Only report if overlap volume is significant
        if (overlapVolume > minOverlapVolume) {
          intersections.push({
            label1: a.label,
            label2: b.label,
            overlapVolume,
          });
        }
      }
    }
  }

  return {
    valid: intersections.length === 0,
    intersections,
  };
}

/**
 * Check if a geometry's vertices are within acceptable bounds relative to another geometry.
 * Useful for verifying floor/ceiling tiles don't protrude past wall boundaries.
 *
 * @param innerGeometry - The geometry that should be contained (e.g., ceiling tile)
 * @param outerGeometry - The geometry that should contain it (e.g., wall perimeter)
 * @param epsilon - Tolerance for boundary checking
 * @returns True if inner geometry is within outer bounds (with epsilon tolerance)
 */
export function geometryWithinBounds(
  innerGeometry: THREE.BufferGeometry,
  outerBounds: AABB,
  epsilon: number = 0.001,
): boolean {
  innerGeometry.computeBoundingBox();
  const innerBox = innerGeometry.boundingBox;

  if (!innerBox) return true;

  return (
    innerBox.min.x >= outerBounds.minX - epsilon &&
    innerBox.max.x <= outerBounds.maxX + epsilon &&
    innerBox.min.y >= outerBounds.minY - epsilon &&
    innerBox.max.y <= outerBounds.maxY + epsilon &&
    innerBox.min.z >= outerBounds.minZ - epsilon &&
    innerBox.max.z <= outerBounds.maxZ + epsilon
  );
}

/**
 * Verify a floor/ceiling tile doesn't extend past wall boundaries on any side.
 * This is a more targeted check than general intersection detection.
 *
 * @param tileGeometry - The floor/ceiling tile geometry
 * @param wallInset - The expected inset from wall surfaces (typically WALL_THICKNESS/2)
 * @param cellBounds - The cell boundaries where the tile exists
 * @param externalEdges - Which edges of the cell have external walls
 * @param epsilon - Tolerance for the check
 * @returns Object with validity and any violations
 */
export function validateTileInset(
  tileGeometry: THREE.BufferGeometry,
  wallInset: number,
  cellBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  externalEdges: {
    north: boolean;
    south: boolean;
    east: boolean;
    west: boolean;
  },
  epsilon: number = 0.001,
): { valid: boolean; violations: string[] } {
  tileGeometry.computeBoundingBox();
  const box = tileGeometry.boundingBox;

  if (!box) return { valid: true, violations: [] };

  const violations: string[] = [];

  // Check each edge
  if (externalEdges.west) {
    const expectedMinX = cellBounds.minX + wallInset;
    if (box.min.x < expectedMinX - epsilon) {
      violations.push(
        `West edge extends ${(expectedMinX - box.min.x).toFixed(4)}m past expected inset`,
      );
    }
  }

  if (externalEdges.east) {
    const expectedMaxX = cellBounds.maxX - wallInset;
    if (box.max.x > expectedMaxX + epsilon) {
      violations.push(
        `East edge extends ${(box.max.x - expectedMaxX).toFixed(4)}m past expected inset`,
      );
    }
  }

  if (externalEdges.north) {
    const expectedMinZ = cellBounds.minZ + wallInset;
    if (box.min.z < expectedMinZ - epsilon) {
      violations.push(
        `North edge extends ${(expectedMinZ - box.min.z).toFixed(4)}m past expected inset`,
      );
    }
  }

  if (externalEdges.south) {
    const expectedMaxZ = cellBounds.maxZ - wallInset;
    if (box.max.z > expectedMaxZ + epsilon) {
      violations.push(
        `South edge extends ${(box.max.z - expectedMaxZ).toFixed(4)}m past expected inset`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
