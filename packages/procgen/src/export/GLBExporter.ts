/**
 * GLB Export Utilities
 *
 * Unified GLB export functionality for procedural generators.
 * Supports exporting Three.js Groups, Meshes, and complex hierarchies.
 */

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

/**
 * Export options for GLB generation
 */
export interface GLBExportOptions {
  /** Filename without extension */
  filename?: string;
  /** Whether to download automatically (browser only) */
  download?: boolean;
  /** Include animations if present */
  includeAnimations?: boolean;
  /** Force leaf geometry to use indices (better compression) */
  forceIndexedGeometry?: boolean;
  /** Apply transforms to geometry (bake transforms) */
  bakeTransforms?: boolean;
  /** Maximum texture size (for embedded textures) */
  maxTextureSize?: number;
}

/**
 * Export result containing the GLB data
 */
export interface GLBExportResult {
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
    textureCount: number;
    fileSizeBytes: number;
  };
}

async function writeArrayBufferToFile(
  outputPath: string,
  data: ArrayBuffer,
): Promise<void> {
  const globalObj = globalThis as Record<string, unknown>;
  if (
    globalObj.Bun &&
    typeof (globalObj.Bun as { write: unknown }).write === "function"
  ) {
    const bunRuntime = globalObj.Bun as {
      write: (path: string, data: ArrayBuffer) => Promise<void>;
    };
    await bunRuntime.write(outputPath, data);
    return;
  }

  const fsModuleId = "node:fs/promises";
  const { writeFile } = (await import(/* @vite-ignore */ fsModuleId)) as {
    writeFile: (path: string, data: Uint8Array) => Promise<void>;
  };
  await writeFile(outputPath, new Uint8Array(data));
}

/**
 * Export a Three.js Object3D (Group, Mesh, Scene) to GLB format
 *
 * @param object - The Three.js object to export
 * @param options - Export options
 * @returns Promise resolving to export result
 */
export async function exportToGLB(
  object: THREE.Object3D,
  options: GLBExportOptions = {},
): Promise<GLBExportResult> {
  const exporter = new GLTFExporter();
  const filename = options.filename || "model";

  // Clone the object to avoid modifying the original
  const exportObject = object.clone(true);

  // Reset root position for export (keep children relative positions)
  exportObject.position.set(0, 0, 0);
  exportObject.rotation.set(0, 0, 0);
  exportObject.scale.set(1, 1, 1);
  exportObject.updateMatrixWorld(true);

  // Apply transforms if requested (bakes world transforms into geometry)
  if (options.bakeTransforms) {
    bakeTransformsToGeometry(exportObject);
  }

  // Convert instanced meshes to regular meshes for better compatibility
  convertInstancedMeshes(exportObject);

  // Ensure all geometries have indices for better compression
  if (options.forceIndexedGeometry !== false) {
    ensureIndexedGeometry(exportObject);
  }

  // Collect statistics before export
  const stats = collectStats(exportObject);

  return new Promise((resolve, reject) => {
    exporter.parse(
      exportObject,
      (result) => {
        const data = result as ArrayBuffer;
        stats.fileSizeBytes = data.byteLength;

        const exportResult: GLBExportResult = {
          data,
          filename: `${filename}.glb`,
          mimeType: "model/gltf-binary",
          stats,
        };

        // Trigger download in browser if requested
        if (
          options.download &&
          typeof window !== "undefined" &&
          typeof document !== "undefined"
        ) {
          downloadBlob(
            new Blob([data], { type: exportResult.mimeType }),
            exportResult.filename,
          );
        }

        // Clean up cloned object
        disposeObject(exportObject);

        resolve(exportResult);
      },
      (error) => {
        disposeObject(exportObject);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
      {
        binary: true,
        includeCustomExtensions: false,
        animations: options.includeAnimations
          ? collectAnimations(exportObject)
          : [],
        maxTextureSize: options.maxTextureSize,
      },
    );
  });
}

/**
 * Export a mesh to GLB and write to file (Node.js/Bun environment)
 *
 * @param object - The Three.js object to export
 * @param outputPath - Full path to output file
 * @param options - Export options
 * @returns Promise resolving to export result
 */
export async function exportToGLBFile(
  object: THREE.Object3D,
  outputPath: string,
  options: Omit<GLBExportOptions, "download"> = {},
): Promise<GLBExportResult> {
  const result = await exportToGLB(object, { ...options, download: false });

  // Write file using available runtime APIs
  // Check for Bun runtime
  const globalObj = globalThis as Record<string, unknown>;
  if (
    globalObj.Bun &&
    typeof (globalObj.Bun as { write: unknown }).write === "function"
  ) {
    const BunRuntime = globalObj.Bun as {
      write: (path: string, data: ArrayBuffer) => Promise<void>;
    };
    await BunRuntime.write(outputPath, result.data);
  } else {
    await writeArrayBufferToFile(outputPath, result.data);
  }

  return result;
}

/**
 * Bake world transforms into geometry vertices
 * This flattens the hierarchy so all meshes are at origin with identity transforms
 */
function bakeTransformsToGeometry(object: THREE.Object3D): void {
  object.updateMatrixWorld(true);

  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const geometry = child.geometry;

      // Apply world matrix to geometry
      geometry.applyMatrix4(child.matrixWorld);

      // Reset the mesh's transform
      child.position.set(0, 0, 0);
      child.rotation.set(0, 0, 0);
      child.scale.set(1, 1, 1);
      child.updateMatrix();
      child.updateMatrixWorld(true);
    }
  });
}

/**
 * Convert InstancedMesh to regular Mesh by merging instances
 * GLB format has limited InstancedMesh support, so we expand them
 */
function convertInstancedMeshes(object: THREE.Object3D): void {
  const instancedMeshes: THREE.InstancedMesh[] = [];

  object.traverse((child) => {
    if (child instanceof THREE.InstancedMesh) {
      instancedMeshes.push(child);
    }
  });

  for (const instancedMesh of instancedMeshes) {
    const parent = instancedMesh.parent;
    if (!parent) continue;

    const mergedGeometry = mergeInstancedGeometry(instancedMesh);
    const regularMesh = new THREE.Mesh(mergedGeometry, instancedMesh.material);
    regularMesh.name = instancedMesh.name;
    regularMesh.castShadow = instancedMesh.castShadow;
    regularMesh.receiveShadow = instancedMesh.receiveShadow;

    // Replace instanced mesh with regular mesh
    parent.remove(instancedMesh);
    parent.add(regularMesh);

    // Dispose old instanced mesh
    instancedMesh.geometry.dispose();
    instancedMesh.dispose();
  }
}

/**
 * Merge instanced geometry into a single BufferGeometry
 */
function mergeInstancedGeometry(
  instancedMesh: THREE.InstancedMesh,
): THREE.BufferGeometry {
  const baseGeometry = instancedMesh.geometry;
  const count = instancedMesh.count;

  // Get base geometry attributes
  const basePositions = baseGeometry.attributes.position;
  const baseNormals = baseGeometry.attributes.normal;
  const baseUVs = baseGeometry.attributes.uv;
  const baseColors = baseGeometry.attributes.color;
  const baseIndices = baseGeometry.index;

  const verticesPerInstance = basePositions.count;
  const totalVertices = verticesPerInstance * count;

  // Create merged arrays
  const positions = new Float32Array(totalVertices * 3);
  const normals = baseNormals ? new Float32Array(totalVertices * 3) : null;
  const uvs = baseUVs ? new Float32Array(totalVertices * 2) : null;
  const colors = baseColors
    ? new Float32Array(totalVertices * baseColors.itemSize)
    : null;

  // Indices handling
  let indices: Uint32Array | null = null;
  if (baseIndices) {
    const indicesPerInstance = baseIndices.count;
    indices = new Uint32Array(indicesPerInstance * count);
  }

  // Transform matrix for each instance
  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    instancedMesh.getMatrixAt(i, matrix);
    normalMatrix.getNormalMatrix(matrix);

    const vertexOffset = i * verticesPerInstance;

    // Transform positions
    for (let v = 0; v < verticesPerInstance; v++) {
      position.fromBufferAttribute(basePositions, v);
      position.applyMatrix4(matrix);

      const idx = (vertexOffset + v) * 3;
      positions[idx] = position.x;
      positions[idx + 1] = position.y;
      positions[idx + 2] = position.z;

      // Transform normals
      if (baseNormals && normals) {
        normal.fromBufferAttribute(baseNormals, v);
        normal.applyMatrix3(normalMatrix).normalize();
        normals[idx] = normal.x;
        normals[idx + 1] = normal.y;
        normals[idx + 2] = normal.z;
      }

      // Copy UVs (no transform needed)
      if (baseUVs && uvs) {
        const uvIdx = (vertexOffset + v) * 2;
        uvs[uvIdx] = baseUVs.getX(v);
        uvs[uvIdx + 1] = baseUVs.getY(v);
      }

      // Copy colors (no transform needed)
      if (baseColors && colors) {
        const colorIdx = (vertexOffset + v) * baseColors.itemSize;
        for (let c = 0; c < baseColors.itemSize; c++) {
          colors[colorIdx + c] = baseColors.array[v * baseColors.itemSize + c];
        }
      }
    }

    // Offset indices
    if (baseIndices && indices) {
      const indexOffset = i * baseIndices.count;
      for (let j = 0; j < baseIndices.count; j++) {
        indices[indexOffset + j] = baseIndices.array[j] + vertexOffset;
      }
    }
  }

  // Create merged geometry
  const mergedGeometry = new THREE.BufferGeometry();
  mergedGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3),
  );

  if (normals) {
    mergedGeometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(normals, 3),
    );
  }

  if (uvs) {
    mergedGeometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }

  if (colors) {
    mergedGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(colors, baseColors!.itemSize),
    );
  }

  if (indices) {
    mergedGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
  }

  mergedGeometry.computeBoundingBox();
  mergedGeometry.computeBoundingSphere();

  return mergedGeometry;
}

/**
 * Ensure all geometries have indices (indexed geometry)
 * Non-indexed geometry doesn't compress as well in GLB
 */
function ensureIndexedGeometry(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const geometry = child.geometry;

      if (!geometry.index) {
        // Create indices for non-indexed geometry
        const positionCount = geometry.attributes.position.count;
        const indices = new Uint32Array(positionCount);
        for (let i = 0; i < positionCount; i++) {
          indices[i] = i;
        }
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      }
    }
  });
}

/**
 * Collect statistics about the object
 */
function collectStats(object: THREE.Object3D): GLBExportResult["stats"] {
  let vertexCount = 0;
  let triangleCount = 0;
  let meshCount = 0;
  const textures = new Set<THREE.Texture>();

  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
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

      // Collect textures from material
      if (child.material) {
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const mat of materials) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            if (mat.map) textures.add(mat.map);
            if (mat.normalMap) textures.add(mat.normalMap);
            if (mat.roughnessMap) textures.add(mat.roughnessMap);
            if (mat.metalnessMap) textures.add(mat.metalnessMap);
            if (mat.aoMap) textures.add(mat.aoMap);
          }
        }
      }
    }
  });

  return {
    vertexCount,
    triangleCount,
    meshCount,
    textureCount: textures.size,
    fileSizeBytes: 0, // Will be set after export
  };
}

/**
 * Collect animations from object hierarchy
 */
function collectAnimations(object: THREE.Object3D): THREE.AnimationClip[] {
  const animations: THREE.AnimationClip[] = [];

  // Check if object has animations property (Scene, etc.)
  if ("animations" in object && Array.isArray(object.animations)) {
    animations.push(...object.animations);
  }

  return animations;
}

/**
 * Download a blob as a file (browser only)
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Dispose of all resources in an object hierarchy
 */
function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
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
