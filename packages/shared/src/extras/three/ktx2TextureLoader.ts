/**
 * KTX2 Texture Loader Utility
 *
 * Provides smart texture loading that:
 * 1. Tries to load KTX2 version first (GPU-compressed, smaller)
 * 2. Falls back to original format (PNG/JPG) if KTX2 not available
 *
 * KTX2 textures are GPU-compressed (ETC1S/UASTC via Basis Universal)
 * and typically 5-10x smaller than PNG while loading directly to GPU.
 */

import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import * as THREE from "./three";
import { isWebGPURenderer } from "../../utils/rendering/RendererFactory";

// Renderer-owned, app-lifetime loader: ClientGraphics intentionally reuses its
// module-level renderer across world destruction/re-entry. Terrain disposes only
// its textures, never these shared workers. A real renderer replacement must
// explicitly retire this owner with disposeKTX2Loader before initialization.
let ktx2Loader: KTX2Loader | null = null;
let ktx2Renderer: THREE.WebGPURenderer | null = null;
let ktx2LoaderPromise: Promise<KTX2Loader> | null = null;
let ktx2Generation = 0;
let ktx2TranscoderPath: string | null = null;
let retireKTX2Loader: (() => void) | null = null;

export const KTX2_TRANSCODER_PATH =
  "/terrain/textures/compact-pbr/decoders/three-r186/basis/";

/** Capability-only choice. No worker, fetch or renderer initialization here. */
export function getKTX2TerrainFormat(
  renderer: THREE.WebGPURenderer,
): typeof THREE.RGBA_ASTC_4x4_Format | typeof THREE.RGBA_BPTC_Format | null {
  if (!renderer.hasInitialized() || !isWebGPURenderer(renderer))
    throw new Error("KTX2 terrain requires the initialized WebGPU renderer");
  if (renderer.hasFeature("texture-compression-astc"))
    return THREE.RGBA_ASTC_4x4_Format;
  if (renderer.hasFeature("texture-compression-bc"))
    return THREE.RGBA_BPTC_Format;
  return null;
}

// PERFORMANCE: Singleton TextureLoader (avoid creating new loader per texture)
const cachedTextureLoader = new THREE.TextureLoader();

// Track which files we know don't have KTX2 versions (to avoid repeated 404s)
const noKtx2Cache = new Set<string>();

function shouldTraceKTX2(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("traceKTX2") === "1";
  } catch {
    return false;
  }
}

/**
 * Initialize the KTX2 loader with basis transcoder
 * Must be called once with a renderer before using loadTextureWithKTX2Fallback
 */
export function initKTX2Loader(
  renderer: THREE.WebGPURenderer,
  transcoderPath = KTX2_TRANSCODER_PATH,
): Promise<KTX2Loader> {
  if (!renderer.hasInitialized() || !isWebGPURenderer(renderer))
    return Promise.reject(
      new Error("KTX2 loader requires the initialized WebGPU renderer"),
    );
  if (
    ktx2Renderer &&
    (ktx2Renderer !== renderer || ktx2TranscoderPath !== transcoderPath)
  )
    return Promise.reject(
      new Error("KTX2 loader belongs to another renderer or decoder path"),
    );
  if (ktx2LoaderPromise) return ktx2LoaderPromise;
  try {
    const loader = new KTX2Loader();
    loader.setTranscoderPath(transcoderPath);
    loader.setWorkerLimit(2);
    loader.detectSupport(renderer);
    const generation = ktx2Generation;
    let initialized = false;
    let retired = false;
    let disposed = false;
    const disposeOnce = () => {
      if (disposed) return;
      disposed = true;
      loader.dispose();
    };
    retireKTX2Loader = () => {
      retired = true;
      // Three has not created its worker-source URL until init settles. Its
      // dispose is not idempotent; reclaim it once, after that await if needed.
      if (initialized) disposeOnce();
    };
    ktx2Renderer = renderer;
    ktx2TranscoderPath = transcoderPath;
    // Three initializes the WASM and worker source asynchronously. A shutdown
    // can retire this owner during that await; never publish it afterwards.
    ktx2LoaderPromise = loader
      .init()
      .then(() => {
        initialized = true;
        if (retired || generation !== ktx2Generation) {
          disposeOnce();
          throw new Error("KTX2 loader retired during initialization");
        }
        ktx2Loader = loader;
        if (shouldTraceKTX2())
          console.debug("[KTX2Loader] Initialized with basis transcoder");
        return loader;
      })
      .catch((error: unknown) => {
        disposeOnce();
        if (generation === ktx2Generation) {
          ktx2Loader = null;
          ktx2LoaderPromise = null;
          ktx2Renderer = null;
          ktx2TranscoderPath = null;
          retireKTX2Loader = null;
        }
        throw error;
      });
    return ktx2LoaderPromise;
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Get the initialized KTX2 loader
 * Returns null if not initialized
 */
export function getKTX2Loader(): KTX2Loader | null {
  return ktx2Loader;
}

/**
 * Convert a texture path to its KTX2 equivalent
 * e.g., "/textures/grass_d.png" -> "/textures/grass_d.ktx2"
 */
function toKTX2Path(path: string): string {
  return path.replace(/\.(png|jpg|jpeg|webp)$/i, ".ktx2");
}

/**
 * Check if a URL points to a KTX2 file
 */
function isKTX2Path(path: string): boolean {
  return path.toLowerCase().endsWith(".ktx2");
}

/**
 * Load a texture, trying KTX2 first then falling back to original format
 *
 * @param path - Path to the texture (can be .png, .jpg, etc.)
 * @param options - Loading options
 * @returns Promise<THREE.Texture>
 */
export async function loadTextureWithKTX2Fallback(
  path: string,
  options: {
    wrapS?: THREE.Wrapping;
    wrapT?: THREE.Wrapping;
    colorSpace?: THREE.ColorSpace;
    flipY?: boolean;
  } = {},
): Promise<THREE.Texture> {
  const {
    wrapS = THREE.RepeatWrapping,
    wrapT = THREE.RepeatWrapping,
    colorSpace = THREE.SRGBColorSpace,
    flipY = true,
  } = options;

  const ktx2Path = toKTX2Path(path);

  // If KTX2 loader is available and we haven't cached this as missing
  if (ktx2Loader && !noKtx2Cache.has(ktx2Path) && !isKTX2Path(path)) {
    try {
      // Try to load KTX2 version
      const texture = await ktx2Loader.loadAsync(ktx2Path);
      texture.wrapS = wrapS;
      texture.wrapT = wrapT;
      texture.colorSpace = colorSpace;
      texture.flipY = flipY;
      texture.needsUpdate = true;
      if (shouldTraceKTX2()) {
        console.debug(`[KTX2] Loaded: ${ktx2Path}`);
      }
      return texture;
    } catch {
      // KTX2 not available, cache this and fall back
      noKtx2Cache.add(ktx2Path);
      if (shouldTraceKTX2()) {
        console.debug(`[KTX2] Not found, falling back: ${path}`);
      }
    }
  }

  // Fall back to regular texture loader (using cached loader)
  return new Promise((resolve, reject) => {
    cachedTextureLoader.load(
      path,
      (texture) => {
        texture.wrapS = wrapS;
        texture.wrapT = wrapT;
        texture.colorSpace = colorSpace;
        texture.flipY = flipY;
        texture.needsUpdate = true;
        resolve(texture);
      },
      undefined,
      (error) => {
        reject(new Error(`Failed to load texture: ${path} - ${error}`));
      },
    );
  });
}

/**
 * Load a texture directly (either KTX2 or regular format based on extension)
 * Use this when you know the exact path and format
 */
export async function loadTexture(
  path: string,
  options: {
    wrapS?: THREE.Wrapping;
    wrapT?: THREE.Wrapping;
    colorSpace?: THREE.ColorSpace;
    flipY?: boolean;
  } = {},
): Promise<THREE.Texture> {
  const {
    wrapS = THREE.RepeatWrapping,
    wrapT = THREE.RepeatWrapping,
    colorSpace = THREE.SRGBColorSpace,
    flipY = true,
  } = options;

  // If it's a KTX2 file and we have the loader, use it
  if (isKTX2Path(path) && ktx2Loader) {
    const texture = await ktx2Loader.loadAsync(path);
    texture.wrapS = wrapS;
    texture.wrapT = wrapT;
    texture.colorSpace = colorSpace;
    texture.flipY = flipY;
    texture.needsUpdate = true;
    return texture;
  }

  // Otherwise use regular texture loader (using cached loader)
  return new Promise((resolve, reject) => {
    cachedTextureLoader.load(
      path,
      (texture) => {
        texture.wrapS = wrapS;
        texture.wrapT = wrapT;
        texture.colorSpace = colorSpace;
        texture.flipY = flipY;
        texture.needsUpdate = true;
        resolve(texture);
      },
      undefined,
      (error) => {
        reject(new Error(`Failed to load texture: ${path} - ${error}`));
      },
    );
  });
}

/**
 * Preload multiple textures with KTX2 fallback
 * Returns a map of path -> texture
 */
export async function loadTexturesWithKTX2Fallback(
  paths: string[],
  options: {
    wrapS?: THREE.Wrapping;
    wrapT?: THREE.Wrapping;
    colorSpace?: THREE.ColorSpace;
    flipY?: boolean;
  } = {},
): Promise<Map<string, THREE.Texture>> {
  const results = new Map<string, THREE.Texture>();

  const loadPromises = paths.map(async (path) => {
    const texture = await loadTextureWithKTX2Fallback(path, options);
    results.set(path, texture);
  });

  await Promise.all(loadPromises);
  return results;
}

/**
 * Clear the cache of known missing KTX2 files
 * Useful if files have been added/updated
 */
export function clearKTX2Cache(): void {
  noKtx2Cache.clear();
}

/**
 * Dispose of the KTX2 loader
 * Call only when retiring the owning renderer/application, not a terrain/world.
 */
export function disposeKTX2Loader(): void {
  ktx2Generation++;
  retireKTX2Loader?.();
  retireKTX2Loader = null;
  ktx2Loader = null;
  ktx2Renderer = null;
  ktx2LoaderPromise = null;
  ktx2TranscoderPath = null;
  noKtx2Cache.clear();
}
