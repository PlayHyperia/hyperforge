/**
 * Renderer Factory
 *
 * Creates WebGPU renderers for Hyperia.
 *
 * IMPORTANT: WebGPU is REQUIRED. WebGL WILL NOT WORK.
 *
 * All visuals use TSL (Three Shading Language) which only works with WebGPU.
 * There is no WebGL fallback - the game will not render without WebGPU.
 *
 * Supported browsers:
 * - Chrome 113+ (recommended)
 * - Edge 113+
 * - Safari 17+
 * - Firefox (behind flag, not recommended)
 */

import * as THREE from "../../extras/three/three";
import { Logger } from "../Logger";

/**
 * Renderer backend type - WebGPU only
 */
export type RendererBackend = "webgpu" | "webgl";

/**
 * Renderer type used across the app.
 *
 * Only WebGPU is supported. All materials use TSL (Three Shading Language)
 * which requires the WebGPU node material pipeline.
 */
export type WebGPURenderer = InstanceType<typeof THREE.WebGPURenderer>;

export interface RendererOptions {
  antialias?: boolean;
  alpha?: boolean;
  powerPreference?: "high-performance" | "low-power" | "default";
  preserveDrawingBuffer?: boolean;
  canvas?: HTMLCanvasElement;
}

export interface RenderingCapabilities {
  supportsWebGPU: boolean;
  backend: RendererBackend;
}

type RendererBackendFlags = {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
};

type RendererWithBackendState = {
  backend?: RendererBackendFlags;
  _getFallback?: (() => unknown) | null;
};

/**
 * Helper to add timeout to a promise.
 * Returns the result or rejects if timeout exceeded.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/** Default timeout for WebGPU adapter request (30 seconds) */
const WEBGPU_ADAPTER_TIMEOUT_MS = 30000;

/**
 * Check if WebGPU is available in the current browser.
 * WebGPU is REQUIRED for Hyperia - there is no fallback.
 *
 * Note: This includes a timeout to prevent indefinite hangs when
 * WebGPU initialization gets stuck (common on misconfigured GPU servers).
 */
export async function isWebGPUAvailable(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;

  type GPUAdapterLike = object;
  type NavigatorGpuApi = {
    requestAdapter: () => Promise<GPUAdapterLike | null>;
  };
  type NavigatorWithGpu = typeof navigator & { gpu?: NavigatorGpuApi };

  // Access gpu property safely (not all WebViews expose it)
  const gpuApi = (navigator as NavigatorWithGpu).gpu;
  if (!gpuApi) return false;

  try {
    // Add timeout to prevent indefinite hangs.
    // Request high-performance adapter to prefer discrete GPU on dual-GPU systems.
    const adapter = await withTimeout(
      gpuApi.requestAdapter({ powerPreference: "high-performance" }),
      WEBGPU_ADAPTER_TIMEOUT_MS,
      "WebGPU requestAdapter",
    );
    return adapter !== null;
  } catch (err) {
    // Log timeout vs other errors for debugging
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timed out")) {
      Logger.error(
        `[RendererFactory] WebGPU adapter request timed out after ${WEBGPU_ADAPTER_TIMEOUT_MS}ms. ` +
          "This often indicates GPU driver or display configuration issues.",
      );
    }
    return false;
  }
}

/**
 * Detect rendering capabilities.
 *
 * @throws Error if WebGPU is unavailable (WebGPU is REQUIRED)
 */
export async function detectRenderingCapabilities(): Promise<RenderingCapabilities> {
  const supportsWebGPU = await isWebGPUAvailable();

  if (!supportsWebGPU) {
    const isLinux =
      typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent);
    const linuxHint = isLinux
      ? "\n\nOn Linux with dual GPUs (Intel + NVIDIA), launch Chrome with:\n" +
        "  __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia google-chrome\n" +
        "Or check chrome://gpu to verify WebGPU status."
      : "";
    throw new Error(
      "WebGPU is REQUIRED but not available in this browser.\n\n" +
        "Hyperia requires WebGPU for rendering. Please use a supported browser:\n" +
        "  - Chrome 113+ (recommended)\n" +
        "  - Edge 113+\n" +
        "  - Safari 17+\n\n" +
        "If you're using a supported browser, ensure:\n" +
        "  - Hardware acceleration is enabled in browser settings\n" +
        "  - Your GPU drivers are up to date\n" +
        "  - You're not running in a WebView that blocks WebGPU" +
        linuxHint,
    );
  }

  return {
    supportsWebGPU,
    backend: "webgpu",
  };
}

/**
 * Create a WebGPU renderer.
 *
 * WebGPU is REQUIRED - there is no WebGL fallback.
 * All materials use TSL (Three Shading Language) which only works with WebGPU.
 *
 * @throws Error if WebGPU is unavailable or initialization fails
 */
export async function createRenderer(
  options: RendererOptions = {},
): Promise<WebGPURenderer> {
  const {
    antialias = true,
    alpha = false,
    powerPreference = "high-performance",
    canvas,
  } = options;

  // WebGPU powerPreference does not support "default"
  const webgpuPowerPreference =
    powerPreference === "default" ? undefined : powerPreference;

  // Check WebGPU availability - this is REQUIRED
  const supportsWebGPU = await isWebGPUAvailable();

  if (!supportsWebGPU) {
    const errorMessage = [
      "WebGPU is REQUIRED but not available in this browser.",
      "",
      "Hyperia requires WebGPU for rendering. Please use a supported browser:",
      "  - Chrome 113+ (recommended)",
      "  - Edge 113+",
      "  - Safari 17+",
      "",
      "If you're using a supported browser, ensure:",
      "  - Hardware acceleration is enabled in browser settings",
      "  - Your GPU drivers are up to date",
      "  - You're not running in a WebView that blocks WebGPU",
    ].join("\n");

    Logger.error("[RendererFactory] " + errorMessage);
    throw new Error(errorMessage);
  }

  // Create WebGPU renderer with extended limits for large texture arrays.
  // The animated impostor system needs >256 texture array layers for mob atlases.
  // Some GPUs cannot provide 2048 layers, so we attempt with the higher limit first
  // and retry with default limits if the device request fails.
  const baseRendererOpts = {
    canvas,
    antialias,
    alpha,
    powerPreference: webgpuPowerPreference,
  };

  /** Timeout for renderer.init() to prevent indefinite hangs */
  const RENDERER_INIT_TIMEOUT_MS = 60000;

  let renderer: InstanceType<typeof THREE.WebGPURenderer> | null = null;

  const disableRendererFallback = (
    candidate: InstanceType<typeof THREE.WebGPURenderer>,
  ): void => {
    // Hyperia is WebGPU-only. Allowing Three's implicit WebGL fallback lets
    // the app continue in a broken state where TSL shaders and compute systems
    // quietly fail later.
    (candidate as unknown as RendererWithBackendState)._getFallback = null;
  };

  // First attempt: request extended texture array layers
  try {
    renderer = new THREE.WebGPURenderer({
      ...baseRendererOpts,
      requiredLimits: {
        maxTextureArrayLayers: 2048,
      },
    });
    disableRendererFallback(renderer);
    await withTimeout(
      renderer.init(),
      RENDERER_INIT_TIMEOUT_MS,
      "WebGPU renderer.init() with extended limits",
    );
  } catch (limitsError) {
    const msg =
      limitsError instanceof Error ? limitsError.message : String(limitsError);
    Logger.warn(
      `[RendererFactory] WebGPU init with extended limits failed (${msg}), retrying with default limits...`,
    );
    // Dispose the failed renderer to release the canvas WebGPU context
    // so the retry can acquire a fresh context on the same canvas.
    if (renderer) {
      try {
        await renderer.dispose();
      } catch {
        // Ignore dispose errors on a partially-initialized renderer
      }
    }
    renderer = null;
  }

  // Second attempt: default limits (no requiredLimits)
  if (!renderer) {
    try {
      renderer = new THREE.WebGPURenderer(baseRendererOpts);
      disableRendererFallback(renderer);
      await withTimeout(
        renderer.init(),
        RENDERER_INIT_TIMEOUT_MS,
        "WebGPU renderer.init()",
      );
    } catch (error) {
      const initError =
        error instanceof Error ? error.message : "Unknown initialization error";
      const errorMessage = [
        "Renderer initialization FAILED.",
        "",
        `Error: ${initError}`,
        "",
        "This usually indicates:",
        "  • GPU drivers need updating",
        "  • Browser GPU backend limitations",
        "  • Hardware/backend doesn't fully support required features",
        "",
        "Please try:",
        "  1. Update your browser to the latest version",
        "  2. Update your GPU drivers",
        "  3. Try a different browser (Chrome recommended)",
      ].join("\n");

      Logger.error("[RendererFactory] " + errorMessage);
      throw new Error(errorMessage);
    }
  }

  // Verify we actually got WebGPU backend
  const backend = getRendererBackend(renderer);
  if (backend !== "webgpu") {
    throw new Error(
      `Expected WebGPU backend but got ${backend}. ` +
        "This indicates a browser/driver issue with WebGPU support.",
    );
  }

  Logger.info(
    `[RendererFactory] ${backend.toUpperCase()} renderer initialized successfully`,
  );
  return renderer;
}

/**
 * Check if the renderer is a WebGPU renderer.
 * Since WebGPU is required, this should always return true.
 */
export function isWebGPURenderer(
  renderer: WebGPURenderer,
): renderer is WebGPURenderer {
  return getRendererBackend(renderer) === "webgpu";
}

/**
 * Get renderer backend type.
 * Always returns "webgpu" since that's the only supported backend.
 */
export function getRendererBackend(renderer: WebGPURenderer): RendererBackend {
  const backend = (renderer as unknown as RendererWithBackendState).backend;

  if (backend?.isWebGPUBackend === true) {
    return "webgpu";
  }

  if (backend?.isWebGLBackend === true) {
    Logger.error(
      "[RendererFactory] Renderer initialized with WebGL backend instead of WebGPU",
    );
    return "webgl";
  }

  Logger.error(
    "[RendererFactory] Renderer backend flags are unavailable; treating backend as non-WebGPU",
  );
  return "webgl";
}

/**
 * Configure renderer with common settings
 */
export function configureRenderer(
  renderer: WebGPURenderer,
  options: {
    clearColor?: number;
    clearAlpha?: number;
    pixelRatio?: number;
    width?: number;
    height?: number;
    toneMapping?: THREE.ToneMapping;
    toneMappingExposure?: number;
    outputColorSpace?: THREE.ColorSpace;
  },
): void {
  const {
    pixelRatio = 1,
    width,
    height,
    toneMapping = THREE.ACESFilmicToneMapping,
    toneMappingExposure = 1,
    outputColorSpace = THREE.SRGBColorSpace,
  } = options;

  // Pixel ratio
  renderer.setPixelRatio(pixelRatio);

  // Size
  if (width && height) {
    renderer.setSize(width, height);
  }

  // Tone mapping
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = toneMappingExposure;

  // Output color space
  renderer.outputColorSpace = outputColorSpace;
}

/**
 * Configure shadow maps
 */
export function configureShadowMaps(
  renderer: WebGPURenderer,
  options: {
    enabled?: boolean;
    type?: THREE.ShadowMapType;
  } = {},
): void {
  const { enabled = true, type = THREE.PCFShadowMap } = options;

  renderer.shadowMap.enabled = enabled;
  renderer.shadowMap.type = type;
}

/**
 * Get max anisotropy from WebGPU renderer
 */
export function getMaxAnisotropy(renderer: WebGPURenderer): number {
  type BackendWithMaxAnisotropy = { getMaxAnisotropy?: () => number };
  const backend = (renderer as { backend?: BackendWithMaxAnisotropy }).backend;
  if (typeof backend?.getMaxAnisotropy === "function") {
    try {
      return backend.getMaxAnisotropy();
    } catch {
      return 16;
    }
  }
  return 16;
}

/**
 * Get WebGPU capabilities for logging and debugging
 */
export function getWebGPUCapabilities(renderer: WebGPURenderer): {
  backend: RendererBackend;
  features: string[];
} {
  type FeatureSetLike = { forEach: (cb: (feature: string) => void) => void };
  type BackendWithDeviceFeatures = {
    isWebGPUBackend?: true;
    device?: { features?: FeatureSetLike };
  };

  const backend = (renderer as { backend?: BackendWithDeviceFeatures }).backend;
  const features: string[] = [];

  if (backend?.isWebGPUBackend && backend.device?.features) {
    backend.device.features.forEach((feature: string) => {
      features.push(feature);
    });
  }

  return {
    backend: getRendererBackend(renderer),
    features,
  };
}

/**
 * Log WebGPU info for debugging
 */
export function logWebGPUInfo(renderer: WebGPURenderer): void {
  const caps = getWebGPUCapabilities(renderer);

  Logger.info("[RendererFactory] WebGPU initialized", {
    features: caps.features.length,
  });
}

/**
 * Optimize materials for WebGPU rendering
 */
export function optimizeMaterialForWebGPU(material: THREE.Material): void {
  if (!material) return;

  type MaterialWithTextureProps = THREE.Material &
    Partial<
      Record<
        "map" | "normalMap" | "roughnessMap" | "metalnessMap" | "emissiveMap",
        THREE.Texture | undefined
      >
    >;

  // Enable anisotropic filtering on textures
  const textureProps: Array<keyof MaterialWithTextureProps> = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "emissiveMap",
  ];
  for (const prop of textureProps) {
    const tex = (material as MaterialWithTextureProps)[prop];
    if (tex instanceof THREE.Texture) {
      tex.anisotropy = 16;
    }
  }
}

/**
 * Create optimized instanced mesh
 */
export function createOptimizedInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = true;
  return mesh;
}

/**
 * Merge multiple meshes with the same material into a single mesh
 * Reduces draw calls for static geometry
 *
 * This implements geometry merging manually since BufferGeometryUtils
 * is not available in the three/webgpu namespace.
 *
 * @param meshes Array of meshes to merge (must share same material)
 * @returns Single merged mesh, or null if merging failed
 */
export function mergeStaticMeshes(meshes: THREE.Mesh[]): THREE.Mesh | null {
  if (meshes.length === 0) return null;
  if (meshes.length === 1) return meshes[0];

  // Collect all geometry data
  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allUvs: number[] = [];
  const allIndices: number[] = [];
  let indexOffset = 0;

  // Pre-allocate temporaries outside loop
  const tempVec = new THREE.Vector3();
  const tempNormal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    mesh.updateWorldMatrix(true, false);

    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const uvs = geometry.getAttribute("uv");
    const indices = geometry.getIndex();

    if (!positions) continue;

    // Get normal matrix for this mesh
    normalMatrix.getNormalMatrix(mesh.matrixWorld);

    for (let i = 0; i < positions.count; i++) {
      // Transform position
      tempVec.fromBufferAttribute(positions, i);
      tempVec.applyMatrix4(mesh.matrixWorld);
      allPositions.push(tempVec.x, tempVec.y, tempVec.z);

      // Transform normal
      if (normals) {
        tempNormal.fromBufferAttribute(normals, i);
        tempNormal.applyMatrix3(normalMatrix).normalize();
        allNormals.push(tempNormal.x, tempNormal.y, tempNormal.z);
      }

      // Copy UVs
      if (uvs) {
        allUvs.push(uvs.getX(i), uvs.getY(i));
      }
    }

    // Copy indices with offset
    if (indices) {
      for (let i = 0; i < indices.count; i++) {
        allIndices.push(indices.getX(i) + indexOffset);
      }
    } else {
      // Generate indices for non-indexed geometry
      for (let i = 0; i < positions.count; i++) {
        allIndices.push(i + indexOffset);
      }
    }

    indexOffset += positions.count;
  }

  // Create merged geometry
  const mergedGeometry = new THREE.BufferGeometry();
  mergedGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(allPositions, 3),
  );

  if (allNormals.length > 0) {
    mergedGeometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(allNormals, 3),
    );
  }

  if (allUvs.length > 0) {
    mergedGeometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(allUvs, 2),
    );
  }

  mergedGeometry.setIndex(allIndices);
  mergedGeometry.computeBoundingSphere();

  // Create the merged mesh using the first mesh's material
  const material = meshes[0].material;
  const mergedMesh = new THREE.Mesh(mergedGeometry, material);

  mergedMesh.frustumCulled = true;
  mergedMesh.receiveShadow = meshes[0].receiveShadow;
  mergedMesh.castShadow = meshes[0].castShadow;
  mergedMesh.name = "MergedStaticMesh";

  // Store original mesh data for interaction (click detection, etc.)
  mergedMesh.userData.mergedMeshes = meshes.map((m) => ({
    name: m.name,
    position: m.position.clone(),
    userData: { ...m.userData },
  }));

  return mergedMesh;
}

/**
 * Group meshes by material for efficient merging
 * Returns a map of material UUID to array of meshes using that material
 */
export function groupMeshesByMaterial(
  meshes: THREE.Mesh[],
): Map<string, THREE.Mesh[]> {
  const groups = new Map<string, THREE.Mesh[]>();

  for (const mesh of meshes) {
    const materialUuid = Array.isArray(mesh.material)
      ? mesh.material[0]?.uuid || "default"
      : mesh.material?.uuid || "default";

    if (!groups.has(materialUuid)) {
      groups.set(materialUuid, []);
    }
    groups.get(materialUuid)!.push(mesh);
  }

  return groups;
}

/**
 * Merge all static meshes in a scene/group by material
 * Replaces original meshes with merged versions
 *
 * @param parent The parent object containing meshes to merge
 * @param minMeshesToMerge Minimum meshes with same material before merging (default: 3)
 */
export function mergeStaticMeshesInGroup(
  parent: THREE.Object3D,
  minMeshesToMerge = 3,
): void {
  // Collect all meshes
  const meshes: THREE.Mesh[] = [];
  parent.traverse((child) => {
    if (
      child instanceof THREE.Mesh &&
      child.userData.static !== false && // Skip if explicitly marked non-static
      !(child instanceof THREE.InstancedMesh) // Skip instanced meshes
    ) {
      meshes.push(child);
    }
  });

  // Group by material
  const groups = groupMeshesByMaterial(meshes);

  // Merge groups with enough meshes
  for (const [, groupMeshes] of groups) {
    if (groupMeshes.length >= minMeshesToMerge) {
      const mergedMesh = mergeStaticMeshes(groupMeshes);

      if (mergedMesh) {
        // Add merged mesh to parent
        parent.add(mergedMesh);

        // Remove original meshes
        for (const mesh of groupMeshes) {
          mesh.removeFromParent();
          mesh.geometry.dispose();
        }

        console.log(
          `[RendererFactory] Merged ${groupMeshes.length} meshes into 1`,
        );
      }
    }
  }
}
