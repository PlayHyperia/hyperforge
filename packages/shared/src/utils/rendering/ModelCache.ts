/**
 * Model Cache System
 *
 * Loads 3D models once and caches them for reuse across multiple entity instances.
 * This prevents loading the same GLB file hundreds of times for items/mobs.
 *
 * IMPORTANT: Materials are set up for WebGPU/CSM compatibility automatically.
 *
 * Persistent Processed Cache (IndexedDB):
 * - After GLTF parsing + transform baking, geometry and material properties are
 *   serialized and stored in IndexedDB as typed arrays.
 * - On subsequent loads, the processed cache is checked BEFORE GLTF parsing,
 *   skipping the expensive parse step entirely (~20-100ms saved per model).
 * - Materials are always re-created fresh (they contain GPU state).
 *
 * LOD Integration:
 * - Automatically generates LOD levels (LOD1, LOD2) via mesh decimation
 * - Automatically bakes octahedral impostors for distant rendering
 * - LODs are cached in IndexedDB for persistence across sessions
 * - Enable via options.generateLODs when loading
 */

import THREE, { MeshStandardNodeMaterial } from "../../extras/three/three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { World } from "../../core/World";
import {
  lodManager,
  type LODBundle,
  type LODCategory,
  type LODGenerationOptions,
} from "./LODManager";

/**
 * Collision data embedded in GLB extras by inject-model-collision.ts
 * This is the AAA approach - collision travels with the asset.
 */
export interface ModelCollisionData {
  /** Footprint in tiles at scale 1.0 */
  footprint: { width: number; depth: number };
  /** Bounding box in model space */
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  /** Model dimensions (max - min) */
  dimensions: { x: number; y: number; z: number };
}

interface CachedModel {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  loadedAt: number;
  cloneCount: number;
  /** Shared materials for this model type (one material per mesh index) */
  sharedMaterials: Map<number, THREE.Material | THREE.Material[]>;
  /** Collision data from GLB extras (if present) */
  collision?: ModelCollisionData;
  /** LOD bundle with decimated meshes and impostor (if generated) */
  lodBundle?: LODBundle;
}

// ─── Processed Model Cache (IndexedDB) ───────────────────────────────────────

const PROCESSED_DB_NAME = "hyperia-processed-models";
const PROCESSED_STORE_NAME = "models";
const PROCESSED_CACHE_VERSION = 6;

/** Serialized mesh data for IndexedDB storage */
interface SerializedMesh {
  name: string;
  type: "Mesh" | "SkinnedMesh";
  positions: ArrayBuffer; // Float32Array
  normals?: ArrayBuffer;
  uvs?: ArrayBuffer;
  uv2s?: ArrayBuffer;
  colors?: ArrayBuffer;
  colorItemSize?: number;
  indices?: ArrayBuffer;
  indexType?: "Uint16" | "Uint32";
  skinWeights?: ArrayBuffer;
  skinIndices?: ArrayBuffer;
  /** Material properties (not the GPU material itself) */
  material: SerializedMaterialProps | SerializedMaterialProps[];
}

/** Raw RGBA pixel data for a texture, stored as ArrayBuffer in IndexedDB. */
interface SerializedTextureData {
  pixels: ArrayBuffer;
  width: number;
  height: number;
}

/** Material properties that can be serialized (no GPU state) */
interface SerializedMaterialProps {
  name: string;
  color: number; // hex
  emissive: number;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
  opacity: number;
  transparent: boolean;
  alphaTest: number;
  side: number;
  flatShading: boolean;
  vertexColors: boolean;
  mapData?: SerializedTextureData;
  normalMapData?: SerializedTextureData;
  normalScaleX?: number;
  normalScaleY?: number;
  emissiveMapData?: SerializedTextureData;
  roughnessMapData?: SerializedTextureData;
  metalnessMapData?: SerializedTextureData;
  aoMapData?: SerializedTextureData;
  aoMapIntensity?: number;
}

/** Serialized scene node hierarchy */
interface SerializedNode {
  name: string;
  type: "Group" | "Object3D" | "Mesh" | "SkinnedMesh" | "Bone";
  meshIndex?: number; // Index into meshes array (for Mesh/SkinnedMesh)
  children: SerializedNode[];
}

/** Full serialized model stored in IndexedDB */
interface SerializedProcessedModel {
  version: number;
  url: string;
  /** Size of original GLB file — used for staleness detection */
  sourceSize: number;
  meshes: SerializedMesh[];
  hierarchy: SerializedNode;
  collision?: ModelCollisionData;
  /** Serialized animation clips (track names + keyframe data) */
  animations: Array<{
    name: string;
    duration: number;
    tracks: Array<{
      name: string;
      type: string; // "vector" | "quaternion" | "number" | "boolean" | "string" | "color"
      times: ArrayBuffer;
      values: ArrayBuffer;
      interpolation: number;
    }>;
  }>;
  cachedAt: number;
}

export class ModelCache {
  private static instance: ModelCache;
  private cache = new Map<string, CachedModel>();
  private loading = new Map<string, Promise<CachedModel>>();
  private gltfLoader: GLTFLoader;
  /**
   * Track all materials managed by the cache to prevent premature disposal.
   * When entities are destroyed, they should NOT dispose materials in this set.
   */
  private managedMaterials = new WeakSet<THREE.Material>();

  /** Track whether MeshoptDecoder WASM has been initialized */
  private decoderReady = false;
  private decoderReadyPromise: Promise<void> | null = null;

  /** Processed model cache IndexedDB */
  private processedDB: IDBDatabase | null = null;
  private processedDBReady: Promise<boolean> | null = null;

  private constructor() {
    // Use our own GLTFLoader to ensure we get pure THREE.Object3D (not HyperForge Nodes)
    this.gltfLoader = new GLTFLoader();
    // Enable meshopt decoder for compressed GLB files (EXT_meshopt_compression)
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);

    // Pre-initialize MeshoptDecoder WASM to prevent race conditions
    // The decoder has a 'ready' promise that must resolve before decoding
    this.initMeshoptDecoder();

    // Initialize processed model cache IndexedDB
    this.initProcessedDB();
  }

  /**
   * Pre-initialize the MeshoptDecoder WASM module.
   * This prevents race conditions where models start loading before WASM is ready.
   */
  private async initMeshoptDecoder(): Promise<void> {
    if (this.decoderReady) return;
    if (this.decoderReadyPromise) return this.decoderReadyPromise;

    this.decoderReadyPromise = (async () => {
      try {
        // MeshoptDecoder exports a 'ready' promise that resolves when WASM is initialized
        const decoder = MeshoptDecoder as {
          ready?: Promise<void>;
          supported?: boolean;
        };

        if (decoder.ready) {
          await decoder.ready;
        }
        this.decoderReady = true;
      } catch (error) {
        console.warn(
          "[ModelCache] MeshoptDecoder initialization warning:",
          error,
        );
        // Continue anyway - the decoder will try to initialize on first use
        this.decoderReady = true;
      }
    })();

    return this.decoderReadyPromise;
  }

  /**
   * Ensure MeshoptDecoder is ready before loading models.
   * Call this before the first model load in performance-critical scenarios.
   */
  async ensureDecoderReady(): Promise<void> {
    return this.initMeshoptDecoder();
  }

  // ─── Processed Model Cache (IndexedDB) ─────────────────────────────────────

  /**
   * Initialize IndexedDB for processed model storage.
   * Non-blocking — if IndexedDB is unavailable, we fall back to GLTF parsing.
   */
  private initProcessedDB(): Promise<boolean> {
    if (this.processedDBReady) return this.processedDBReady;

    this.processedDBReady = new Promise<boolean>((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(false);
        return;
      }
      try {
        const request = indexedDB.open(
          PROCESSED_DB_NAME,
          PROCESSED_CACHE_VERSION,
        );
        request.onerror = () => {
          console.warn(
            "[ModelCache] Processed model cache unavailable (IndexedDB error)",
          );
          resolve(false);
        };
        request.onsuccess = () => {
          this.processedDB = request.result;
          resolve(true);
        };
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(PROCESSED_STORE_NAME)) {
            db.createObjectStore(PROCESSED_STORE_NAME, { keyPath: "url" });
          }
        };
      } catch {
        resolve(false);
      }
    });

    return this.processedDBReady;
  }

  /**
   * Load a processed model from IndexedDB.
   * Returns the deserialized scene + materials if cached, null otherwise.
   */
  private async loadProcessedModel(
    url: string,
    sourceSize: number,
    world?: World,
  ): Promise<{
    scene: THREE.Object3D;
    animations: THREE.AnimationClip[];
    collision?: ModelCollisionData;
  } | null> {
    if (!this.processedDB) return null;

    return new Promise((resolve) => {
      try {
        const tx = this.processedDB!.transaction(
          PROCESSED_STORE_NAME,
          "readonly",
        );
        const request = tx.objectStore(PROCESSED_STORE_NAME).get(url);
        request.onsuccess = () => {
          const stored = request.result as SerializedProcessedModel | undefined;
          if (
            !stored ||
            stored.version !== PROCESSED_CACHE_VERSION ||
            stored.sourceSize !== sourceSize
          ) {
            resolve(null);
            return;
          }
          try {
            const result = this.deserializeScene(stored, world);
            resolve(result);
          } catch (err) {
            console.warn(
              `[ModelCache] Failed to deserialize cached model ${url}:`,
              err,
            );
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Save a processed model to IndexedDB for future sessions.
   * Fire-and-forget — does not block the loading pipeline.
   */
  private saveProcessedModel(
    url: string,
    sourceSize: number,
    scene: THREE.Object3D,
    animations: THREE.AnimationClip[],
    collision?: ModelCollisionData,
  ): void {
    if (!this.processedDB) return;

    try {
      const serialized = this.serializeScene(
        url,
        sourceSize,
        scene,
        animations,
        collision,
      );

      const tx = this.processedDB.transaction(
        PROCESSED_STORE_NAME,
        "readwrite",
      );
      const putReq = tx.objectStore(PROCESSED_STORE_NAME).put(serialized);
      putReq.onerror = () =>
        console.warn(
          `[ModelCache] IndexedDB put failed for ${url}:`,
          putReq.error,
        );
      tx.onerror = () =>
        console.warn(`[ModelCache] IndexedDB tx failed for ${url}:`, tx.error);
    } catch (err) {
      console.warn(`[ModelCache] Failed to cache processed model ${url}:`, err);
    }
  }

  /**
   * Serialize a processed scene into IndexedDB-storable format.
   * Captures geometry typed arrays and material properties (but not GPU state).
   */
  private serializeScene(
    url: string,
    sourceSize: number,
    scene: THREE.Object3D,
    animations: THREE.AnimationClip[],
    collision?: ModelCollisionData,
  ): SerializedProcessedModel {
    const meshes: SerializedMesh[] = [];
    const meshNodeToIndex = new Map<THREE.Object3D, number>();

    // Copy only the typed-array VIEW's bytes — not the entire underlying
    // ArrayBuffer. GLTF attributes are often views into one large GLB binary
    // chunk; buffer.slice(0) would copy megabytes of unrelated data and
    // cause deserialized geometries to have inflated vertex counts.
    const sliceView = (
      arr: ArrayLike<number> & {
        buffer: ArrayBuffer;
        byteOffset: number;
        byteLength: number;
      },
    ) => arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);

    // Extract a geometry attribute's data into a contiguous typed array buffer.
    // InterleavedBufferAttribute.array returns the FULL interleaved buffer
    // (containing positions + normals + UVs all packed together), so we must
    // deinterleave by reading each component individually via getComponent().
    // Without this, deserialized geometries get fractional vertex counts and
    // NaN bounding boxes because the byte length isn't divisible by itemSize*4.
    const extractAttr = (
      attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    ): ArrayBuffer => {
      if (
        (attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
      ) {
        const iba = attr as THREE.InterleavedBufferAttribute;
        const TypedArrayCtor = iba.data.array.constructor as new (
          len: number,
        ) => Float32Array | Uint16Array | Uint8Array | Int16Array;
        const out = new TypedArrayCtor(iba.count * iba.itemSize);
        for (let i = 0; i < iba.count; i++) {
          for (let j = 0; j < iba.itemSize; j++) {
            out[i * iba.itemSize + j] = iba.getComponent(i, j);
          }
        }
        return out.buffer as ArrayBuffer;
      }
      return sliceView(
        (attr as THREE.BufferAttribute).array as ArrayLike<number> & {
          buffer: ArrayBuffer;
          byteOffset: number;
          byteLength: number;
        },
      );
    };

    // Collect all meshes and build identity map (avoids name-collision bugs)
    scene.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh) {
        const geo = node.geometry;
        meshNodeToIndex.set(node, meshes.length);
        const sm: SerializedMesh = {
          name: node.name,
          type: node instanceof THREE.SkinnedMesh ? "SkinnedMesh" : "Mesh",
          positions: extractAttr(
            geo.getAttribute("position") as
              THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
          ),
          material: Array.isArray(node.material)
            ? node.material.map((m) => this.serializeMaterialProps(m))
            : this.serializeMaterialProps(node.material),
        };

        // Optional attributes
        const normals = geo.getAttribute("normal");
        if (normals)
          sm.normals = extractAttr(
            normals as THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
          );

        const uvs = geo.getAttribute("uv");
        if (uvs)
          sm.uvs = extractAttr(
            uvs as THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
          );

        const uv2s = geo.getAttribute("uv2");
        if (uv2s)
          sm.uv2s = extractAttr(
            uv2s as THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
          );

        const colors = geo.getAttribute("color");
        if (colors) {
          sm.colors = extractAttr(
            colors as THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
          );
          sm.colorItemSize = colors.itemSize;
        }

        if (geo.index) {
          sm.indices = sliceView(geo.index.array);
          sm.indexType =
            geo.index.array instanceof Uint16Array ? "Uint16" : "Uint32";
        }

        // Skinning data
        if (node instanceof THREE.SkinnedMesh) {
          const skinWeights = geo.getAttribute("skinWeight");
          const skinIndices = geo.getAttribute("skinIndex");
          if (skinWeights)
            sm.skinWeights = extractAttr(
              skinWeights as
                THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
            );
          if (skinIndices)
            sm.skinIndices = extractAttr(
              skinIndices as
                THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
            );
        }

        meshes.push(sm);
      }
    });

    // Serialize hierarchy (uses identity map, not name-based lookup)
    const hierarchy = this.serializeNode(scene, meshNodeToIndex);

    // Serialize animations
    const serializedAnimations = animations.map((clip) => ({
      name: clip.name,
      duration: clip.duration,
      tracks: clip.tracks.map((track) => ({
        name: track.name,
        type:
          track instanceof THREE.QuaternionKeyframeTrack
            ? "quaternion"
            : track instanceof THREE.VectorKeyframeTrack
              ? "vector"
              : track instanceof THREE.NumberKeyframeTrack
                ? "number"
                : track instanceof THREE.BooleanKeyframeTrack
                  ? "boolean"
                  : track instanceof THREE.ColorKeyframeTrack
                    ? "color"
                    : "number",
        times: new Float32Array(track.times).buffer as ArrayBuffer,
        values: new Float32Array(track.values).buffer as ArrayBuffer,
        interpolation: track.getInterpolation() as number,
      })),
    }));

    return {
      version: PROCESSED_CACHE_VERSION,
      url,
      sourceSize,
      meshes,
      hierarchy,
      collision,
      animations: serializedAnimations,
      cachedAt: Date.now(),
    };
  }

  /**
   * Extract raw RGBA pixel data from a texture for IndexedDB storage.
   * Synchronous via canvas drawImage + getImageData — the resulting
   * DataTexture is immediately usable on deserialization (no async load).
   */
  private textureToPixelData(
    texture: THREE.Texture,
  ): SerializedTextureData | null {
    // DataTexture already has raw pixel data — read it directly without canvas round-trip
    if ((texture as THREE.DataTexture).isDataTexture) {
      const img = texture.image as {
        data: Uint8ClampedArray | Uint8Array;
        width: number;
        height: number;
      };
      if (img?.data && img.width > 0 && img.height > 0) {
        const pixels = new Uint8ClampedArray(
          img.data.buffer,
          img.data.byteOffset,
          img.data.byteLength,
        );
        // Slice to get a plain ArrayBuffer (not SharedArrayBuffer) for serialization
        const plainBuffer =
          pixels.buffer instanceof ArrayBuffer
            ? pixels.buffer.slice(
                pixels.byteOffset,
                pixels.byteOffset + pixels.byteLength,
              )
            : new Uint8ClampedArray(pixels).buffer;
        return { pixels: plainBuffer, width: img.width, height: img.height };
      }
      return null;
    }

    const image = texture.source?.data ?? texture.image;
    if (!image) return null;

    const w =
      (image as HTMLImageElement).naturalWidth ||
      (image as ImageBitmap).width ||
      0;
    const h =
      (image as HTMLImageElement).naturalHeight ||
      (image as ImageBitmap).height ||
      0;
    if (w === 0 || h === 0) return null;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(image as CanvasImageSource, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      return { pixels: imageData.data.buffer, width: w, height: h };
    } catch (e) {
      console.warn("[ModelCache] Failed to extract texture pixels:", e);
      return null;
    }
  }

  /** Serialize material properties (no GPU state) */
  private serializeMaterialProps(mat: THREE.Material): SerializedMaterialProps {
    const m = mat as THREE.MeshStandardMaterial & {
      map?: THREE.Texture | null;
      normalMap?: THREE.Texture | null;
      normalScale?: THREE.Vector2;
      emissiveMap?: THREE.Texture | null;
      roughnessMap?: THREE.Texture | null;
      metalnessMap?: THREE.Texture | null;
      aoMap?: THREE.Texture | null;
      aoMapIntensity?: number;
    };

    const props: SerializedMaterialProps = {
      name: m.name || "",
      color: m.color?.getHex?.() ?? 0xffffff,
      emissive: m.emissive?.getHex?.() ?? 0x000000,
      emissiveIntensity: m.emissiveIntensity ?? 0,
      roughness: m.roughness ?? 0.7,
      metalness: m.metalness ?? 0.0,
      opacity: m.opacity ?? 1,
      transparent: m.transparent ?? false,
      alphaTest: m.alphaTest ?? 0,
      side: m.side ?? THREE.FrontSide,
      flatShading: m.flatShading ?? false,
      vertexColors: m.vertexColors ?? false,
    };

    if (m.map) {
      const d = this.textureToPixelData(m.map);
      if (d) props.mapData = d;
    }
    if (m.normalMap) {
      const d = this.textureToPixelData(m.normalMap);
      if (d) props.normalMapData = d;
    }
    if (m.normalScale) {
      props.normalScaleX = m.normalScale.x;
      props.normalScaleY = m.normalScale.y;
    }
    if (m.emissiveMap) {
      const d = this.textureToPixelData(m.emissiveMap);
      if (d) props.emissiveMapData = d;
    }
    if (m.roughnessMap) {
      const d = this.textureToPixelData(m.roughnessMap);
      if (d) props.roughnessMapData = d;
    }
    if (m.metalnessMap) {
      const d = this.textureToPixelData(m.metalnessMap);
      if (d) props.metalnessMapData = d;
    }
    if (m.aoMap) {
      const d = this.textureToPixelData(m.aoMap);
      if (d) props.aoMapData = d;
      props.aoMapIntensity = m.aoMapIntensity ?? 1.0;
    }

    return props;
  }

  /** Serialize scene hierarchy using object-identity mesh indices */
  private serializeNode(
    node: THREE.Object3D,
    meshNodeToIndex: Map<THREE.Object3D, number>,
  ): SerializedNode {
    let type: SerializedNode["type"] = "Object3D";
    let meshIndex: number | undefined;

    if (node instanceof THREE.SkinnedMesh) {
      type = "SkinnedMesh";
      meshIndex = meshNodeToIndex.get(node);
    } else if (node instanceof THREE.Mesh) {
      type = "Mesh";
      meshIndex = meshNodeToIndex.get(node);
    } else if (node instanceof THREE.Bone) {
      type = "Bone";
    } else if (node instanceof THREE.Group) {
      type = "Group";
    }

    return {
      name: node.name,
      type,
      meshIndex,
      children: node.children.map((child) =>
        this.serializeNode(child, meshNodeToIndex),
      ),
    };
  }

  /**
   * Deserialize a cached model back into a THREE.Object3D scene.
   * Reconstructs geometry from typed arrays and creates fresh materials.
   */
  private deserializeScene(
    stored: SerializedProcessedModel,
    world?: World,
  ): {
    scene: THREE.Object3D;
    animations: THREE.AnimationClip[];
    collision?: ModelCollisionData;
  } {
    // Reconstruct all meshes
    const reconstructedMeshes: THREE.Object3D[] = stored.meshes.map((sm) => {
      const geo = new THREE.BufferGeometry();

      // Restore geometry attributes
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(sm.positions), 3),
      );
      if (sm.normals) {
        geo.setAttribute(
          "normal",
          new THREE.BufferAttribute(new Float32Array(sm.normals), 3),
        );
      }
      if (sm.uvs) {
        geo.setAttribute(
          "uv",
          new THREE.BufferAttribute(new Float32Array(sm.uvs), 2),
        );
      }
      if (sm.uv2s) {
        geo.setAttribute(
          "uv2",
          new THREE.BufferAttribute(new Float32Array(sm.uv2s), 2),
        );
      }
      if (sm.colors) {
        geo.setAttribute(
          "color",
          new THREE.BufferAttribute(
            new Float32Array(sm.colors),
            sm.colorItemSize ?? 3,
          ),
        );
      }
      if (sm.indices) {
        const IndexArray =
          sm.indexType === "Uint16" ? Uint16Array : Uint32Array;
        geo.setIndex(new THREE.BufferAttribute(new IndexArray(sm.indices), 1));
      }
      if (sm.skinWeights) {
        geo.setAttribute(
          "skinWeight",
          new THREE.BufferAttribute(new Float32Array(sm.skinWeights), 4),
        );
      }
      if (sm.skinIndices) {
        geo.setAttribute(
          "skinIndex",
          new THREE.BufferAttribute(new Uint16Array(sm.skinIndices), 4),
        );
      }

      geo.computeBoundingSphere();
      geo.computeBoundingBox();

      // Reconstruct material(s) as MeshStandardNodeMaterial
      const createMat = (
        props: SerializedMaterialProps,
      ): MeshStandardNodeMaterial => {
        const mat = new MeshStandardNodeMaterial();
        mat.name = props.name;
        mat.color = new THREE.Color(props.color);
        mat.emissive = new THREE.Color(props.emissive);
        mat.emissiveIntensity = props.emissiveIntensity;
        mat.roughness = props.roughness;
        mat.metalness = props.metalness;
        mat.opacity = props.opacity;
        mat.transparent = props.transparent;
        mat.alphaTest = props.alphaTest;
        mat.side = props.side as THREE.Side;
        mat.flatShading = props.flatShading;
        mat.vertexColors = props.vertexColors;
        mat.fog = true;
        (mat as THREE.Material & { shadowSide?: number }).shadowSide =
          THREE.BackSide;

        const restoreTex = (
          td: SerializedTextureData,
          srgb: boolean,
        ): THREE.DataTexture => {
          const tex = new THREE.DataTexture(
            new Uint8ClampedArray(td.pixels),
            td.width,
            td.height,
            THREE.RGBAFormat,
          );
          tex.colorSpace = srgb
            ? THREE.SRGBColorSpace
            : THREE.LinearSRGBColorSpace;
          tex.needsUpdate = true;
          return tex;
        };

        if (props.mapData) mat.map = restoreTex(props.mapData, true);
        if (props.normalMapData) {
          mat.normalMap = restoreTex(props.normalMapData, false);
          if (props.normalScaleX !== undefined) {
            mat.normalScale.set(
              props.normalScaleX,
              props.normalScaleY ?? props.normalScaleX,
            );
          }
        }
        if (props.emissiveMapData)
          mat.emissiveMap = restoreTex(props.emissiveMapData, true);
        if (props.roughnessMapData)
          mat.roughnessMap = restoreTex(props.roughnessMapData, false);
        if (props.metalnessMapData)
          mat.metalnessMap = restoreTex(props.metalnessMapData, false);
        if (props.aoMapData) {
          mat.aoMap = restoreTex(props.aoMapData, false);
          mat.aoMapIntensity = props.aoMapIntensity ?? 1.0;
        }
        mat.needsUpdate = true;

        // CSM integration
        if (world?.setupMaterial) {
          world.setupMaterial(mat);
        }

        this.managedMaterials.add(mat);
        return mat;
      };

      const material = Array.isArray(sm.material)
        ? sm.material.map(createMat)
        : createMat(sm.material);

      // Create appropriate mesh type
      let mesh: THREE.Mesh;
      if (sm.type === "SkinnedMesh") {
        mesh = new THREE.SkinnedMesh(geo, material);
        (mesh as THREE.SkinnedMesh).frustumCulled = false;
      } else {
        mesh = new THREE.Mesh(geo, material);
      }
      mesh.name = sm.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      return mesh;
    });

    // Reconstruct hierarchy from serialized node tree
    const buildNode = (sn: SerializedNode): THREE.Object3D => {
      let node: THREE.Object3D;

      if (
        sn.meshIndex !== undefined &&
        sn.meshIndex < reconstructedMeshes.length
      ) {
        node = reconstructedMeshes[sn.meshIndex];
      } else if (sn.type === "Bone") {
        node = new THREE.Bone();
        node.name = sn.name;
      } else if (sn.type === "Group") {
        node = new THREE.Group();
        node.name = sn.name;
      } else {
        node = new THREE.Object3D();
        node.name = sn.name;
      }

      for (const childNode of sn.children) {
        node.add(buildNode(childNode));
      }

      return node;
    };

    const scene = buildNode(stored.hierarchy);

    // Reconstruct animations
    const animations = stored.animations.map((sa) => {
      const tracks = sa.tracks.map((st) => {
        const times = new Float32Array(st.times);
        const values = new Float32Array(st.values);

        let track: THREE.KeyframeTrack;
        switch (st.type) {
          case "quaternion":
            track = new THREE.QuaternionKeyframeTrack(st.name, times, values);
            break;
          case "vector":
            track = new THREE.VectorKeyframeTrack(st.name, times, values);
            break;
          case "color":
            track = new THREE.ColorKeyframeTrack(st.name, times, values);
            break;
          case "boolean":
            track = new THREE.BooleanKeyframeTrack(
              st.name,
              times as unknown as number[],
              Array.from(values).map((v) => v !== 0),
            );
            break;
          default:
            track = new THREE.NumberKeyframeTrack(st.name, times, values);
        }

        track.setInterpolation(st.interpolation as THREE.InterpolationModes);
        return track;
      });

      return new THREE.AnimationClip(sa.name, sa.duration, tracks);
    });

    return {
      scene,
      animations,
      collision: stored.collision,
    };
  }

  static getInstance(): ModelCache {
    if (!ModelCache.instance) {
      ModelCache.instance = new ModelCache();
    }
    return ModelCache.instance;
  }

  /**
   * Check if a material is managed by the cache.
   * Managed materials should NOT be disposed when entities are destroyed,
   * as they are shared across all instances of a model type.
   */
  isManagedMaterial(material: THREE.Material): boolean {
    return this.managedMaterials.has(material);
  }

  /**
   * Convert a material to MeshStandardNodeMaterial for proper PBR lighting with WebGPU/TSL support.
   * This ensures models respond correctly to sun, moon, and environment maps,
   * and enables WebGPU-native TSL dissolve effects (DistanceFade).
   */
  private convertToStandardMaterial(
    mat: THREE.Material,
    hasVertexColors = false,
  ): MeshStandardNodeMaterial {
    // Extract textures and colors from original material (handles MeshStandardMaterial, MeshPhysicalMaterial, etc.)
    const originalMat = mat as THREE.Material & {
      map?: THREE.Texture | null;
      normalMap?: THREE.Texture | null;
      normalScale?: THREE.Vector2;
      emissiveMap?: THREE.Texture | null;
      roughnessMap?: THREE.Texture | null;
      metalnessMap?: THREE.Texture | null;
      aoMap?: THREE.Texture | null;
      aoMapIntensity?: number;
      color?: THREE.Color;
      emissive?: THREE.Color;
      emissiveIntensity?: number;
      roughness?: number;
      metalness?: number;
      envMapIntensity?: number;
      opacity?: number;
      transparent?: boolean;
      alphaTest?: number;
      side?: THREE.Side;
      vertexColors?: boolean;
      flatShading?: boolean;
      fog?: boolean;
    };

    // Create WebGPU-compatible MeshStandardNodeMaterial
    const newMat = new MeshStandardNodeMaterial();

    // Copy color properties
    newMat.color = originalMat.color?.clone() || new THREE.Color(0xffffff);
    newMat.emissive =
      originalMat.emissive?.clone() || new THREE.Color(0x000000);
    newMat.emissiveIntensity = originalMat.emissiveIntensity ?? 0;

    // Copy PBR properties (preserve original values from MeshStandardMaterial)
    newMat.roughness = originalMat.roughness ?? 0.7;
    newMat.metalness = originalMat.metalness ?? 0.0;
    newMat.envMapIntensity = originalMat.envMapIntensity ?? 1.0;

    // Copy transparency/alpha properties
    newMat.opacity = originalMat.opacity ?? 1;
    newMat.transparent = originalMat.transparent ?? false;
    newMat.alphaTest = originalMat.alphaTest ?? 0;
    newMat.side = originalMat.side ?? THREE.FrontSide;

    // Copy other rendering properties
    newMat.flatShading = originalMat.flatShading ?? false;
    newMat.fog = originalMat.fog ?? true;

    // Enable vertex colors if the geometry has them
    newMat.vertexColors = hasVertexColors || originalMat.vertexColors || false;

    // Copy texture maps (only if they have actual values)
    if (originalMat.map) newMat.map = originalMat.map;
    if (originalMat.normalMap) {
      newMat.normalMap = originalMat.normalMap;
      if (originalMat.normalScale)
        newMat.normalScale.copy(originalMat.normalScale);
    }
    if (originalMat.emissiveMap) newMat.emissiveMap = originalMat.emissiveMap;
    if (originalMat.roughnessMap)
      newMat.roughnessMap = originalMat.roughnessMap;
    if (originalMat.metalnessMap)
      newMat.metalnessMap = originalMat.metalnessMap;
    if (originalMat.aoMap) {
      newMat.aoMap = originalMat.aoMap;
      newMat.aoMapIntensity = originalMat.aoMapIntensity ?? 1.0;
    }

    // Copy name for debugging
    newMat.name = originalMat.name || "GLB_NodeMaterial";

    // Dispose old material
    originalMat.dispose();

    return newMat;
  }

  /**
   * Bake all transforms into geometry.
   *
   * Uses the same approach as AssetNormalizationService in asset-forge.
   * This applies world transforms to geometry using Three.js's built-in
   * applyMatrix4 method, then resets all node transforms to identity.
   *
   * This handles all GLTF export variations:
   * - Transforms in position/rotation/scale
   * - Transforms baked into matrix
   * - Non-decomposable transforms (shear)
   *
   * Called ONCE when a model is first loaded, before caching.
   */
  private bakeTransformsToGeometry(scene: THREE.Object3D): void {
    // Ensure all matrices are up to date
    scene.updateMatrixWorld(true);

    // Apply transforms to each mesh's geometry
    scene.traverse((child) => {
      if (
        child instanceof THREE.Mesh &&
        !(child instanceof THREE.SkinnedMesh) &&
        child.geometry
      ) {
        // Clone geometry to avoid modifying shared geometry
        child.geometry = child.geometry.clone();

        // Apply world matrix to geometry (Three.js built-in method)
        // This handles positions, normals, and other attributes correctly
        child.geometry.applyMatrix4(child.matrixWorld);

        // Reset transform to identity
        child.position.set(0, 0, 0);
        child.rotation.set(0, 0, 0);
        child.scale.set(1, 1, 1);
        child.updateMatrix();
      }
    });

    // CRITICAL: Reset ALL node transforms to identity, not just meshes and root.
    // Intermediate Group/Object3D nodes can have transforms that would be
    // applied during rendering, causing double-transform issues (squishing).
    scene.traverse((child) => {
      if (child !== scene) {
        // Skip meshes - already handled above
        if (!(child instanceof THREE.Mesh)) {
          child.position.set(0, 0, 0);
          child.rotation.set(0, 0, 0);
          child.scale.set(1, 1, 1);
          child.updateMatrix();
        }
      }
    });

    // Reset root transform
    scene.position.set(0, 0, 0);
    scene.rotation.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    scene.updateMatrixWorld(true);
  }

  /**
   * Setup materials for WebGPU/CSM compatibility
   * This ensures proper shadows and rendering
   * Also converts non-PBR materials to MeshStandardMaterial for proper lighting
   */
  private setupMaterials(scene: THREE.Object3D, world?: World): void {
    scene.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh) {
        const mesh = node;

        // WebGPU lit materials need normals. Some compressed GLBs only ship
        // position/color data because they were authored for unlit rendering.
        // We convert those materials to MeshStandardNodeMaterial below, so
        // synthesize normals once during model setup before the scene is cached.
        if (mesh.geometry && !mesh.geometry.attributes.normal) {
          mesh.geometry.computeVertexNormals();
          mesh.geometry.attributes.normal.needsUpdate = true;
        }

        // Check if geometry has vertex colors
        const hasVertexColors = mesh.geometry?.attributes?.color !== undefined;

        // Convert ALL materials to MeshStandardNodeMaterial for WebGPU-native TSL dissolve support
        // This is required for DistanceFade dissolve effects to work on loaded models
        const convertMaterial = (mat: THREE.Material): THREE.Material => {
          // If already a MeshStandardNodeMaterial, just set it up
          if (mat instanceof MeshStandardNodeMaterial) {
            if (hasVertexColors && !mat.vertexColors) {
              mat.vertexColors = true;
              mat.needsUpdate = true;
            }
            this.setupSingleMaterial(mat, world);
            return mat;
          }
          // Convert ALL other materials (including MeshStandardMaterial) to MeshStandardNodeMaterial
          const newMat = this.convertToStandardMaterial(mat, hasVertexColors);
          this.setupSingleMaterial(newMat, world);
          return newMat;
        };

        // Handle material arrays
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((mat) => convertMaterial(mat));
        } else {
          mesh.material = convertMaterial(mesh.material);
        }

        // Enable shadows
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        // For skinned meshes, disable frustum culling
        if (mesh instanceof THREE.SkinnedMesh) {
          mesh.frustumCulled = false; // Prevent culling issues with animated meshes
          // NOTE: Do NOT bind skeleton here - entities will handle it after scaling
        }
      }
    });
  }

  /**
   * Extract and store materials from a scene for sharing across clones.
   * Called once when a model is first loaded.
   * Also registers materials in managedMaterials WeakSet to prevent premature disposal.
   */
  private extractSharedMaterials(
    scene: THREE.Object3D,
  ): Map<number, THREE.Material | THREE.Material[]> {
    const sharedMaterials = new Map<
      number,
      THREE.Material | THREE.Material[]
    >();
    let meshIndex = 0;

    scene.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh) {
        // Store the material(s) for this mesh index
        if (Array.isArray(node.material)) {
          sharedMaterials.set(meshIndex, [...node.material]);
          // Track each material in the managed set
          node.material.forEach((mat) => this.managedMaterials.add(mat));
        } else {
          sharedMaterials.set(meshIndex, node.material);
          // Track the material in the managed set
          this.managedMaterials.add(node.material);
        }
        meshIndex++;
      }
    });

    return sharedMaterials;
  }

  /**
   * Apply shared materials to a cloned scene.
   * This reuses materials instead of cloning them, reducing draw call overhead.
   */
  private applySharedMaterials(
    scene: THREE.Object3D,
    sharedMaterials: Map<number, THREE.Material | THREE.Material[]>,
  ): void {
    let meshIndex = 0;

    scene.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh) {
        const shared = sharedMaterials.get(meshIndex);
        if (shared) {
          node.material = shared;
        }
        meshIndex++;
      }
    });
  }

  /**
   * Converts an ImageBitmapTexture to a DataTexture so it uses WebGPU's
   * writeTexture upload path instead of copyExternalImageToTexture.
   * DataTextures upload raw bytes without browser-side colorspace conversion,
   * giving consistent rendering between fresh GLTF loads and cached loads.
   */
  private ensureDataTexture(
    texture: THREE.Texture,
    srgb: boolean,
  ): THREE.Texture {
    if ((texture as THREE.DataTexture).isDataTexture) return texture;
    const pixelData = this.textureToPixelData(texture);
    if (!pixelData) {
      console.warn(
        `[ModelCache] ensureDataTexture: could not read pixels from "${texture.name}" — sRGB decode may be incorrect`,
      );
      return texture;
    }
    const dt = new THREE.DataTexture(
      new Uint8ClampedArray(pixelData.pixels),
      pixelData.width,
      pixelData.height,
      THREE.RGBAFormat,
    );
    dt.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    dt.name = texture.name;
    dt.wrapS = texture.wrapS;
    dt.wrapT = texture.wrapT;
    dt.minFilter = texture.minFilter;
    dt.magFilter = texture.magFilter;
    dt.generateMipmaps = texture.generateMipmaps;
    dt.repeat.copy(texture.repeat);
    dt.offset.copy(texture.offset);
    dt.flipY = texture.flipY;
    dt.needsUpdate = true;
    return dt;
  }

  /**
   * Setup a single material for WebGPU/CSM
   */
  private setupSingleMaterial(material: THREE.Material, world?: World): void {
    // Call world's setupMaterial for CSM integration
    if (world && world.setupMaterial) {
      world.setupMaterial(material);
    }

    // Ensure shadowSide is set (prevents shadow acne)
    (material as THREE.Material & { shadowSide?: THREE.Side }).shadowSide =
      THREE.BackSide;

    // Ensure material can receive fog
    (material as THREE.Material & { fog?: boolean }).fog = true;

    // For WebGPU compatibility, ensure color space is correct
    // Strong type assumption - these material types have map and emissiveMap
    const materialWithMaps = material as THREE.Material & {
      map?: THREE.Texture | null;
      emissiveMap?: THREE.Texture | null;
    };

    if (
      material instanceof THREE.MeshStandardMaterial ||
      material instanceof THREE.MeshPhysicalMaterial ||
      material instanceof MeshStandardNodeMaterial
    ) {
      // Set up texture color spaces and force ImageBitmapTexture → DataTexture.
      // WebGPU uses two different upload paths:
      //   DataTexture   → writeTexture (raw bytes, reliable)
      //   ImageBitmap   → copyExternalImageToTexture (browser-side colorspace decode,
      //                   can double-apply sRGB and corrupt colors)
      // Converting here guarantees the raw-bytes path for both fresh and cached loads.
      if (materialWithMaps.map) {
        materialWithMaps.map = this.ensureDataTexture(
          materialWithMaps.map,
          true,
        );
      }
      if (materialWithMaps.emissiveMap) {
        materialWithMaps.emissiveMap = this.ensureDataTexture(
          materialWithMaps.emissiveMap,
          true,
        );
      }
      // Force metalness to 0 — the game has no environment map, so metallic
      // materials lose their diffuse component and appear black. Zeroing metalness
      // ensures base colors render fully via diffuse lighting.
      material.metalness = 0;
      material.envMapIntensity = material.envMapIntensity ?? 1.0;
    } else if (
      material instanceof THREE.MeshBasicMaterial ||
      material instanceof THREE.MeshPhongMaterial
    ) {
      if (materialWithMaps.map) {
        materialWithMaps.map = this.ensureDataTexture(
          materialWithMaps.map,
          true,
        );
      }
      if (materialWithMaps.emissiveMap) {
        materialWithMaps.emissiveMap = this.ensureDataTexture(
          materialWithMaps.emissiveMap,
          true,
        );
      }
    }

    // Mark material for update
    material.needsUpdate = true;
  }

  /**
   * Load a model (with caching)
   * Returns a cloned scene ready to use with materials properly set up
   *
   * NOTE: This returns pure THREE.Object3D, NOT HyperForge Nodes!
   * Use world.loader.load('model', url) if you need HyperForge Nodes.
   *
   * @param path - Model path (can be asset:// URL or absolute URL)
   * @param world - World instance for URL resolution and material setup
   * @param options.shareMaterials - If true, all instances share the same material (reduces draw calls)
   * @param options.generateLODs - If true, generates LOD1/LOD2 meshes and impostor atlas
   * @param options.lodCategory - Category for LOD presets (tree, bush, rock, etc.)
   * @param options.priority - Loading priority (uses LoadPriority enum from types)
   * @param options.position - World position for distance-based priority calculation
   * @param options.tile - Tile coordinates for tile-based priority calculation
   */
  async loadModel(
    path: string,
    world?: World,
    options?: {
      shareMaterials?: boolean;
      generateLODs?: boolean;
      lodCategory?: LODCategory;
      lodOptions?: Omit<LODGenerationOptions, "category">;
      /** Loading priority (0=CRITICAL, 1=HIGH, 2=NORMAL, 3=LOW, 4=PREFETCH) */
      priority?: number;
      /** World position for distance-based priority calculation */
      position?: THREE.Vector3;
      /** Tile coordinates for tile-based priority calculation */
      tile?: { x: number; z: number };
    },
  ): Promise<{
    scene: THREE.Object3D;
    animations: THREE.AnimationClip[];
    fromCache: boolean;
    /** Collision data from GLB extras (if present) */
    collision?: ModelCollisionData;
    /** LOD bundle with decimated meshes and impostor (if generateLODs was true) */
    lodBundle?: LODBundle;
  }> {
    // Ensure MeshoptDecoder WASM is ready before loading
    // This prevents "Invalid typed array length" errors from race conditions
    await this.initMeshoptDecoder();

    const shareMaterials = options?.shareMaterials ?? true; // Default to sharing
    const generateLODs = options?.generateLODs ?? false;
    // Resolve asset:// URLs to actual URLs
    let resolvedPath = world ? world.resolveURL(path) : path;

    // CRITICAL: If resolveURL failed (returned asset:// unchanged), manually resolve
    if (resolvedPath.startsWith("asset://")) {
      // Fallback chain: window.__CDN_URL → world.assetsUrl → same-origin /game-assets
      const cdnUrl =
        (typeof window !== "undefined" &&
          (window as Window & { __CDN_URL?: string }).__CDN_URL) ||
        world?.assetsUrl?.replace(/\/$/, "") ||
        (typeof window !== "undefined"
          ? `${window.location.origin}/game-assets`
          : "http://localhost:5555/game-assets");
      resolvedPath = resolvedPath.replace("asset://", `${cdnUrl}/`);
    }

    // Check cache first (use resolved path as key)
    const cached = this.cache.get(resolvedPath);
    if (cached) {
      // CRITICAL: Verify cached scene is pure THREE.Object3D
      if ("ctx" in cached.scene || "isDirty" in cached.scene) {
        console.error(
          "[ModelCache] Cached model is a HyperForge Node, not THREE.Object3D! Clearing cache...",
        );
        this.cache.delete(resolvedPath);
        // Retry load with fresh GLTFLoader
        return this.loadModel(path, world);
      }

      // Check if cached scene was mutated and needs reload
      let cachedHasMutation = false;
      cached.scene.traverse((child) => {
        const s = child.scale;
        if (s.x !== 1 || s.y !== 1 || s.z !== 1) {
          cachedHasMutation = true;
        }
      });
      if (cachedHasMutation) {
        this.cache.delete(resolvedPath);
        return this.loadModel(path, world);
      }

      cached.cloneCount++;

      // Bones/skeletons belong to the instance; geometry/materials remain shared.
      const clonedScene = cloneSkeleton(cached.scene);

      if (shareMaterials && cached.sharedMaterials.size > 0) {
        // Reuse shared materials (reduces draw calls)
        this.applySharedMaterials(clonedScene, cached.sharedMaterials);
      } else {
        // Create new materials for this clone (allows custom tinting)
        this.setupMaterials(clonedScene, world);
      }

      // Generate LODs if requested and not already cached
      let lodBundle = cached.lodBundle;
      if (generateLODs && !lodBundle && world) {
        lodBundle = await this.generateLODsForModel(
          resolvedPath,
          cached.scene,
          world,
          options?.lodCategory,
          options?.lodOptions,
        );
        cached.lodBundle = lodBundle;
      }

      return {
        scene: clonedScene,
        animations: cached.animations,
        fromCache: true,
        collision: cached.collision,
        lodBundle,
      };
    }

    // Check if already loading (use resolved path as key)
    const loadingPromise = this.loading.get(resolvedPath);
    if (loadingPromise) {
      const result = await loadingPromise;
      result.cloneCount++;
      const clonedScene = cloneSkeleton(result.scene);

      if (shareMaterials && result.sharedMaterials.size > 0) {
        // Reuse shared materials (reduces draw calls)
        this.applySharedMaterials(clonedScene, result.sharedMaterials);
      } else {
        // Create new materials for this clone
        this.setupMaterials(clonedScene, world);
      }

      // Generate LODs if requested and not already cached
      let lodBundle = result.lodBundle;
      if (generateLODs && !lodBundle && world) {
        lodBundle = await this.generateLODsForModel(
          resolvedPath,
          result.scene,
          world,
          options?.lodCategory,
          options?.lodOptions,
        );
        result.lodBundle = lodBundle;
      }

      return {
        scene: clonedScene,
        animations: result.animations,
        fromCache: true,
        collision: result.collision,
        lodBundle,
      };
    }

    // Load for the first time
    // First try IndexedDB processed cache (skip expensive GLTF parsing)
    // Then fall back to full GLTF load via ClientLoader
    await this.initProcessedDB();
    let sourceSize = 0; // Track GLB size for cache staleness detection
    const promise = (async () => {
      let gltf: Awaited<ReturnType<typeof this.gltfLoader.parseAsync>>;

      // Try to use ClientLoader for caching benefits (IndexedDB, deduplication)
      if (world?.loader) {
        const loader = world.loader as {
          loadFile: (url: string) => Promise<File | undefined>;
          loadFileWithPriority?: (
            url: string,
            priority: number,
            opts?: {
              position?: THREE.Vector3;
              tile?: { x: number; z: number };
            },
          ) => Promise<File | undefined>;
          clearCachedFile?: (url: string) => Promise<void>;
        };

        let file: File | undefined;

        // Use priority-based loading if priority is specified and loader supports it
        if (options?.priority !== undefined && loader.loadFileWithPriority) {
          file = await loader.loadFileWithPriority(
            resolvedPath,
            options.priority,
            {
              position: options.position,
              tile: options.tile,
            },
          );
        } else {
          // Standard loading (immediate, high priority)
          file = await loader.loadFile(resolvedPath);
        }

        if (file) {
          sourceSize = file.size;

          // ── Check processed model cache (IndexedDB) ──
          // If we have a processed version of this exact file, skip GLTF parsing entirely
          const processedResult = await this.loadProcessedModel(
            resolvedPath,
            sourceSize,
            world,
          );
          if (processedResult) {
            // Return a pseudo-GLTF result so downstream code works unchanged
            return {
              scene: processedResult.scene,
              animations: processedResult.animations,
              parser: undefined as unknown as typeof gltf.parser,
              _processedCacheHit: true,
              _collision: processedResult.collision,
            } as unknown as typeof gltf;
          }

          const buffer = await file.arrayBuffer();
          // Pass resolvedPath as base URL for resolving relative/data URIs in GLTF
          // Empty string "" causes issues with embedded base64 data URIs
          try {
            gltf = await this.gltfLoader.parseAsync(buffer, resolvedPath);
          } catch (parseError) {
            // Check for "Invalid typed array length" error - indicates corrupted file
            const errorMsg =
              parseError instanceof Error
                ? parseError.message
                : String(parseError);
            if (
              errorMsg.includes("Invalid typed array length") ||
              errorMsg.includes("RangeError") ||
              errorMsg.includes("Malformed buffer")
            ) {
              console.warn(
                `[ModelCache] Corrupted file detected for ${resolvedPath}, clearing cache and retrying...`,
              );

              // Clear corrupted file from IndexedDB cache
              if (loader.clearCachedFile) {
                await loader.clearCachedFile(resolvedPath);
              }

              // Retry with direct load (bypasses corrupted cache)
              gltf = await this.gltfLoader.loadAsync(resolvedPath);
            } else {
              throw parseError;
            }
          }
        } else {
          // Fallback to direct load if file fetch failed
          gltf = await this.gltfLoader.loadAsync(resolvedPath);
        }
      } else {
        // No ClientLoader available, use direct load
        gltf = await this.gltfLoader.loadAsync(resolvedPath);
      }

      return gltf;
    })()
      .then((gltf) => {
        // Check if this was a processed cache hit (skip all post-processing)
        const gltfWithMeta = gltf as typeof gltf & {
          _processedCacheHit?: boolean;
          _collision?: ModelCollisionData;
        };
        if (gltfWithMeta._processedCacheHit) {
          // Scene was already deserialized with fresh materials
          const sharedMaterials = this.extractSharedMaterials(gltf.scene);
          const cachedModel: CachedModel = {
            scene: gltf.scene,
            animations: gltf.animations,
            loadedAt: Date.now(),
            cloneCount: 0,
            sharedMaterials,
            collision: gltfWithMeta._collision,
          };
          this.cache.set(resolvedPath, cachedModel);
          this.loading.delete(resolvedPath);
          return cachedModel;
        }

        // CRITICAL: Verify we got a pure THREE.Object3D, not a HyperForge Node
        if ("ctx" in gltf.scene || "isDirty" in gltf.scene) {
          console.error(
            "[ModelCache] ERROR: GLTFLoader returned HyperForge Node instead of THREE.Object3D!",
          );
          console.error(
            "[ModelCache] Scene type:",
            gltf.scene.constructor.name,
          );
          throw new Error(
            "ModelCache received HyperForge Node - this indicates a loader system conflict",
          );
        }

        // CRITICAL: Bake all transforms into geometry BEFORE caching.
        // GLTF files can have transforms stored in matrices (not just scale property),
        // especially when exported without "Apply Transforms" in Blender.
        // This bakes ALL transforms into vertex positions, guaranteeing correct rendering.
        this.bakeTransformsToGeometry(gltf.scene);

        // Validate skeletons - filter out undefined bones (can happen with WebGPU)
        // Must happen before any cloning or animation setup
        gltf.scene.traverse((child) => {
          if (
            (child as THREE.SkinnedMesh).isSkinnedMesh &&
            (child as THREE.SkinnedMesh).skeleton
          ) {
            const skeleton = (child as THREE.SkinnedMesh).skeleton;
            const validBones = skeleton.bones.filter(
              (bone): bone is THREE.Bone => bone !== undefined && bone !== null,
            );
            if (validBones.length !== skeleton.bones.length) {
              console.warn(
                `[ModelCache] Cleaned ${skeleton.bones.length - validBones.length} undefined bones from ${resolvedPath}`,
              );
              skeleton.bones = validBones;
            }
          }
        });

        // CRITICAL: Setup materials on the original scene for WebGPU/CSM
        // This ensures all clones will have properly configured materials
        this.setupMaterials(gltf.scene, world);

        // Extract materials for sharing across clones
        const sharedMaterials = this.extractSharedMaterials(gltf.scene);

        // Extract collision data from GLB extras (AAA approach - collision travels with asset)
        let collision: ModelCollisionData | undefined;
        try {
          const extras = (
            gltf.parser?.json as {
              extras?: { hyperia?: { collision?: ModelCollisionData } };
            }
          )?.extras;
          if (extras?.hyperia?.collision) {
            collision = extras.hyperia.collision;
          }
        } catch {
          // No collision data in this model - that's fine
        }

        // ── Save to processed cache for future sessions (fire-and-forget) ──
        if (sourceSize > 0) {
          this.saveProcessedModel(
            resolvedPath,
            sourceSize,
            gltf.scene,
            gltf.animations,
            collision,
          );
        }

        const cachedModel: CachedModel = {
          scene: gltf.scene,
          animations: gltf.animations,
          loadedAt: Date.now(),
          cloneCount: 0,
          sharedMaterials,
          collision,
        };

        this.cache.set(resolvedPath, cachedModel);
        this.loading.delete(resolvedPath);

        return cachedModel;
      })
      .catch((error) => {
        this.loading.delete(resolvedPath);
        throw error;
      });

    this.loading.set(resolvedPath, promise);
    const result = await promise;
    result.cloneCount++;

    const clonedScene = cloneSkeleton(result.scene);

    // FINAL VALIDATION: Ensure we're returning pure THREE.Object3D
    if ("ctx" in clonedScene || "isDirty" in clonedScene) {
      console.error(
        "[ModelCache] CRITICAL: Cloned scene is a HyperForge Node!",
      );
      console.error(
        "[ModelCache] This should never happen. Scene type:",
        clonedScene.constructor.name,
      );
      throw new Error(
        "ModelCache clone produced HyperForge Node instead of THREE.Object3D",
      );
    }

    if (shareMaterials && result.sharedMaterials.size > 0) {
      // Reuse shared materials (reduces draw calls)
      this.applySharedMaterials(clonedScene, result.sharedMaterials);
    } else {
      // Create new materials for this clone
      this.setupMaterials(clonedScene, world);
    }

    // Generate LODs if requested
    let lodBundle: LODBundle | undefined;
    if (generateLODs && world) {
      lodBundle = await this.generateLODsForModel(
        resolvedPath,
        result.scene,
        world,
        options?.lodCategory,
        options?.lodOptions,
      );
      result.lodBundle = lodBundle;
    }

    return {
      scene: clonedScene,
      animations: result.animations,
      fromCache: false,
      collision: result.collision,
      lodBundle,
    };
  }

  /**
   * Generate LOD bundle for a model using worker-based decimation and GPU impostor baking.
   * Results are cached in IndexedDB for persistence across sessions.
   */
  private async generateLODsForModel(
    modelPath: string,
    scene: THREE.Object3D,
    world: World,
    category?: LODCategory,
    lodOptions?: Omit<LODGenerationOptions, "category">,
  ): Promise<LODBundle | undefined> {
    // Initialize LODManager if not already done
    lodManager.initialize(world);

    // Generate a stable ID from the model path
    const lodId = `model_${modelPath.replace(/[^a-zA-Z0-9]/g, "_")}`;

    // Determine category from path if not provided
    const effectiveCategory = category ?? this.inferCategoryFromPath(modelPath);

    const bundle = await lodManager.generateLODBundle(lodId, scene, {
      category: effectiveCategory,
      generateLOD1: true,
      generateLOD2: true,
      generateImpostor: true,
      useWorkers: true,
      ...lodOptions,
    });

    return bundle;
  }

  /**
   * Infer LOD category from model path based on common naming conventions.
   */
  private inferCategoryFromPath(path: string): LODCategory {
    const lowerPath = path.toLowerCase();
    if (lowerPath.includes("tree")) return "tree";
    if (lowerPath.includes("bush") || lowerPath.includes("shrub"))
      return "bush";
    if (
      lowerPath.includes("rock") ||
      lowerPath.includes("stone") ||
      lowerPath.includes("boulder")
    )
      return "rock";
    if (
      lowerPath.includes("plant") ||
      lowerPath.includes("flower") ||
      lowerPath.includes("grass")
    )
      return "plant";
    if (
      lowerPath.includes("building") ||
      lowerPath.includes("house") ||
      lowerPath.includes("structure")
    )
      return "building";
    if (
      lowerPath.includes("character") ||
      lowerPath.includes("npc") ||
      lowerPath.includes("mob")
    )
      return "character";
    if (
      lowerPath.includes("item") ||
      lowerPath.includes("weapon") ||
      lowerPath.includes("armor")
    )
      return "item";
    return "default";
  }

  /**
   * Check if a model is cached
   */
  has(path: string): boolean {
    return this.cache.has(path);
  }

  /**
   * Preload multiple models in parallel
   *
   * Efficiently loads many models at once by:
   * - Deduplicating requests (same path only loads once)
   * - Running loads in parallel (no unnecessary serialization)
   * - Caching results for instant subsequent access
   *
   * @param paths - Array of model paths to preload
   * @param world - World instance for URL resolution
   * @param options - Loading options
   * @returns Promise that resolves when all models are loaded (with success/failure info)
   */
  async preloadModels(
    paths: string[],
    world?: World,
    options?: {
      shareMaterials?: boolean;
      /** Callback for progress updates */
      onProgress?: (loaded: number, total: number, path: string) => void;
    },
  ): Promise<{
    loaded: number;
    failed: number;
    errors: Array<{ path: string; error: string }>;
  }> {
    // Deduplicate paths
    const uniquePaths = [...new Set(paths)];
    const total = uniquePaths.length;
    let loaded = 0;
    const errors: Array<{ path: string; error: string }> = [];

    // Load all models in parallel
    const results = await Promise.allSettled(
      uniquePaths.map(async (path) => {
        try {
          await this.loadModel(path, world, {
            shareMaterials: options?.shareMaterials,
          });
          loaded++;
          options?.onProgress?.(loaded, total, path);
          return { path, success: true };
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          errors.push({ path, error: errorMsg });
          loaded++;
          options?.onProgress?.(loaded, total, path);
          throw error;
        }
      }),
    );

    const failed = results.filter((r) => r.status === "rejected").length;

    return {
      loaded: total - failed,
      failed,
      errors,
    };
  }

  /**
   * Warm up the cache by preloading models that are likely to be used soon
   *
   * This is useful for vegetation systems, entity pools, etc. where we know
   * which models will be needed but don't need them immediately.
   *
   * @param pathsWithPriority - Array of { path, priority } where higher priority loads first
   * @param world - World instance
   */
  async warmupCache(
    pathsWithPriority: Array<{ path: string; priority: number }>,
    world?: World,
  ): Promise<void> {
    // Sort by priority (highest first)
    const sorted = [...pathsWithPriority].sort(
      (a, b) => b.priority - a.priority,
    );

    // Group by priority for wave-based loading
    const priorityGroups = new Map<number, string[]>();
    for (const item of sorted) {
      const paths = priorityGroups.get(item.priority) || [];
      paths.push(item.path);
      priorityGroups.set(item.priority, paths);
    }

    // Load each priority group in parallel, groups sequentially
    const priorities = [...priorityGroups.keys()].sort((a, b) => b - a);
    for (const priority of priorities) {
      const paths = priorityGroups.get(priority)!;
      await this.preloadModels(paths, world);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    total: number;
    paths: string[];
    totalClones: number;
    materialsSaved: number;
  } {
    const paths: string[] = [];
    let totalClones = 0;
    let materialsSaved = 0;

    for (const [path, model] of this.cache.entries()) {
      paths.push(path);
      totalClones += model.cloneCount;
      // Each clone after the first shares materials instead of creating new ones
      if (model.cloneCount > 1) {
        materialsSaved += (model.cloneCount - 1) * model.sharedMaterials.size;
      }
    }

    return {
      total: this.cache.size,
      paths,
      totalClones,
      materialsSaved, // Number of materials NOT created due to sharing
    };
  }

  /**
   * Dispose all geometries in a scene (but NOT materials - they're managed)
   * @private
   */
  private disposeSceneGeometries(scene: THREE.Object3D): void {
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.SkinnedMesh) {
        if (child.geometry) {
          child.geometry.dispose();
        }
      }
    });
  }

  /**
   * Clear the cache (useful for hot reload)
   * Should be called when code is rebuilt to prevent stale HyperForge Nodes
   * IMPORTANT: Disposes geometries to prevent GPU memory leaks
   */
  clear(): void {
    // Dispose all cached model geometries before clearing
    for (const [, model] of this.cache) {
      this.disposeSceneGeometries(model.scene);
      // Dispose LOD bundle geometries if present
      if (model.lodBundle) {
        model.lodBundle.lod0?.dispose();
        model.lodBundle.lod1?.dispose();
        model.lodBundle.lod2?.dispose();
      }
    }
    this.cache.clear();
    this.loading.clear();
  }

  /**
   * Clear cache and verify all entries are pure THREE.Object3D
   * Call this on world initialization to ensure clean state
   */
  resetAndVerify(): void {
    this.clear();
  }

  /**
   * Remove a specific model from cache
   * IMPORTANT: Disposes geometries to prevent GPU memory leaks
   */
  remove(path: string): boolean {
    const model = this.cache.get(path);
    if (model) {
      this.disposeSceneGeometries(model.scene);
      // Dispose LOD bundle geometries if present
      if (model.lodBundle) {
        model.lodBundle.lod0?.dispose();
        model.lodBundle.lod1?.dispose();
        model.lodBundle.lod2?.dispose();
      }
    }
    return this.cache.delete(path);
  }

  /**
   * Count meshes in a scene
   */
  private countMeshes(scene: THREE.Object3D): number {
    let count = 0;
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.SkinnedMesh) {
        count++;
      }
    });
    return count;
  }

  /**
   * Count skinned meshes in a scene
   */
  private countSkinnedMeshes(scene: THREE.Object3D): number {
    let count = 0;
    scene.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh) {
        count++;
      }
    });
    return count;
  }
}

// Export singleton instance
export const modelCache = ModelCache.getInstance();
