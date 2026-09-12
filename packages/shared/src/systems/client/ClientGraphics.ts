/**
 * ClientGraphics.ts - 3D Graphics Rendering System
 *
 * Manages WebGPU rendering for the 3D game world.
 * Handles viewport, shadows, post-processing, and frame rendering.
 *
 * Key Features:
 * - **WebGPU Rendering**: Native WebGPU with TSL post-processing
 * - **Shadow Mapping**: Cascaded shadow maps (CSM) for dynamic shadows
 * - **Post-Processing**: TSL-based bloom, tone mapping, and effects
 * - **Adaptive Quality**: Auto-adjusts shadow quality based on performance
 * - **Anisotropic Filtering**: Texture filtering for better quality
 * - **HDR Rendering**: High dynamic range for realistic lighting
 *
 * Rendering Pipeline:
 * 1. Pre-render: Update matrices, frustum culling
 * 2. Shadow Pass: Render shadow maps for each light
 * 3. Main Pass: Render scene to screen
 * 4. Post-Processing: Apply bloom, tone mapping, etc.
 * 5. UI Overlay: Render 2D UI on top
 *
 * Shadow Configuration:
 * - Cascaded Shadow Maps (CSM) for large view distances
 * - 3 cascades: near (high res), medium, far (low res)
 * - PCF soft shadows for smooth edges
 * - Shadow bias to prevent acne artifacts
 *
 * Post-Processing Effects:
 * - **Bloom**: Glowing bright areas for magical effects (TSL-based)
 * - **Tone Mapping**: HDR to LDR conversion
 * - **Color Grading**: Adjust colors for atmosphere
 *
 * Performance Optimization:
 * - Frustum culling: Don't render off-screen objects
 * - LOD system: Lower detail for distant objects
 * - Instanced rendering: Batch identical objects
 * - Occlusion culling: Skip objects behind walls
 * - Adaptive shadow quality: Reduce resolution under load
 *
 * Usage:
 * ```typescript
 * // Graphics system auto-initializes
 * const graphics = world.getSystem('graphics');
 *
 * // Toggle post-processing
 * graphics.setPostProcessing(true);
 *
 * // Adjust shadow quality
 * graphics.setShadowQuality('high');
 *
 * // Get current FPS
 * const fps = graphics.getFPS();
 * ```
 *
 * Related Systems:
 * - ClientCameraSystem: Provides camera for rendering
 * - Environment: Lighting and skybox
 * - LODs: Level-of-detail mesh swapping
 * - Stage: three.js scene graph
 *
 * Dependencies:
 * - three.js WebGPU: 3D rendering library
 * - TSL: Three Shading Language for post-processing
 * - Stage system: Scene graph
 * - Camera system: View/projection matrices
 *
 * @see RendererFactory.ts for WebGPU creation
 * @see PostProcessingFactory.ts for TSL-based effects setup
 */

import * as THREE from "../../extras/three/three";
import type { World } from "../../core/World";
import type { WorldOptions } from "../../types";
import { EventType } from "../../types/events";
import { System } from "../shared/infrastructure/System";
import {
  createRenderer,
  configureRenderer,
  configureShadowMaps,
  getMaxAnisotropy,
  isWebGPURenderer,
  type WebGPURenderer,
  logWebGPUInfo,
  getWebGPUCapabilities,
} from "../../utils/rendering/RendererFactory";
import {
  createPostProcessing,
  type PostProcessingComposer,
  DEPTH_BLUR_DEFAULTS,
} from "../../utils/rendering/PostProcessingFactory";
import {
  setupGPUCompute,
  updateGPUCompute,
  cleanupGPUCompute,
  type GPUComputeManager,
} from "../../utils/compute";
import { RendererPreparationQueue } from "../../utils/rendering/RendererPreparationQueue";
import type { Environment } from "../shared/world/Environment";

let renderer: WebGPURenderer | undefined;

async function getRenderer(): Promise<WebGPURenderer> {
  if (!renderer) {
    renderer = await createRenderer({
      powerPreference: "high-performance",
      antialias: true,
    });
  }
  return renderer;
}

/**
 * Get the shared WebGPU renderer instance
 * @returns The renderer or undefined if not initialized
 */
export function getSharedRenderer(): WebGPURenderer | undefined {
  return renderer;
}

/**
 * Client Graphics System
 *
 * Manages 3D rendering for the game world using WebGPU.
 * Runs only on client (browser).
 */
export class ClientGraphics extends System {
  // Properties
  renderer!: WebGPURenderer;
  viewport!: HTMLElement;
  maxAnisotropy!: number;
  usePostprocessing!: boolean;
  composer!: PostProcessingComposer | null;
  resizer!: ResizeObserver;
  width: number = 0;
  height: number = 0;
  aspect: number = 0;
  worldToScreenFactor: number = 0;
  isWebGPU: boolean = true;
  hasRendered: boolean = false;
  gpuCompute: GPUComputeManager | null = null;
  private readonly rendererPreparationQueue = new RendererPreparationQueue();
  private static readonly PRECOMPILE_TIMEOUT_MS = 15_000;
  private static readonly RENDERER_READY_TIMEOUT_MS = 15_000;

  constructor(world: World) {
    super(world);
  }

  override async init(
    options: WorldOptions & { viewport?: HTMLElement },
  ): Promise<void> {
    if (!options.viewport) {
      throw new Error("ClientGraphics requires viewport in options");
    }
    const { viewport } = options;
    this.viewport = viewport;
    this.width = this.viewport.offsetWidth;
    this.height = this.viewport.offsetHeight;
    this.aspect = this.width / this.height;

    // Update camera aspect ratio immediately to match viewport
    // THREE.PerspectiveCamera has aspect and updateProjectionMatrix properties
    this.world.camera.aspect = this.aspect;
    this.world.camera.updateProjectionMatrix();

    // Create WebGPU renderer (WebGPU is REQUIRED - shaders use TSL which only works with WebGPU)
    this.renderer = await getRenderer();
    const isWebGPUBackend = isWebGPURenderer(this.renderer);
    this.isWebGPU = isWebGPUBackend;

    // WebGPU is mandatory - all shaders use TSL (Three Shading Language) which requires WebGPU
    if (!isWebGPUBackend) {
      throw new Error(
        "WebGPU is REQUIRED but the renderer backend is not WebGPU. " +
          "All Hyperia shaders use TSL which only works with WebGPU. " +
          "Please use Chrome 113+, Edge 113+, or Safari 17+.",
      );
    }

    // Log WebGPU capabilities
    logWebGPUInfo(this.renderer);
    const caps = getWebGPUCapabilities(this.renderer);
    console.log(
      "[ClientGraphics] WebGPU initialized with",
      caps.features.length,
      "features",
    );

    // Configure renderer
    configureRenderer(this.renderer, {
      clearColor: 0x000000, // Black - sky mesh should cover everything
      clearAlpha: 1,
      pixelRatio: this.world.prefs?.dpr || 1,
      width: this.width,
      height: this.height,
      toneMapping: THREE.ACESFilmicToneMapping,
      toneMappingExposure: 0.85,
      outputColorSpace: THREE.SRGBColorSpace,
    });

    // Configure shadows
    configureShadowMaps(this.renderer, {
      enabled: true,
      type: THREE.PCFShadowMap,
    });

    // Get max anisotropy
    this.maxAnisotropy = getMaxAnisotropy(this.renderer);
    THREE.Texture.DEFAULT_ANISOTROPY = this.maxAnisotropy;

    // Initialize GPU compute infrastructure (always available since WebGPU is required)
    // Cast is safe because we verified isWebGPU above and would have thrown otherwise
    this.gpuCompute = setupGPUCompute(
      this.renderer as unknown as THREE.Renderer,
      this.world,
    );
    if (this.gpuCompute) {
      console.log("[ClientGraphics] GPU compute initialized:", {
        grass: !!this.gpuCompute.grass?.isReady(),
        particles: !!this.gpuCompute.particles?.isReady(),
        terrain: !!this.gpuCompute.terrain?.isReady(),
      });
    }

    // Setup post-processing with TSL (always available with WebGPU)
    this.usePostprocessing = this.world.prefs?.postprocessing ?? false;

    if (this.usePostprocessing && isWebGPURenderer(this.renderer)) {
      // Get color grading settings from preferences
      const colorGradingLut = this.world.prefs?.colorGrading ?? "none";
      const colorGradingIntensity =
        this.world.prefs?.colorGradingIntensity ?? 1.0;

      // Get depth blur settings from preferences
      const depthBlurEnabled = this.world.prefs?.depthBlur ?? true;
      const depthBlurIntensity =
        this.world.prefs?.depthBlurIntensity ?? DEPTH_BLUR_DEFAULTS.intensity;
      const depthBlurDistance =
        this.world.prefs?.depthBlurDistance ??
        DEPTH_BLUR_DEFAULTS.focusDistance;

      this.composer = await createPostProcessing(
        this.renderer,
        this.world.stage.scene,
        this.world.camera,
        {
          //   colorGrading: {
          //     enabled: true,
          //     lut: colorGradingLut as
          //       | "none"
          //       | "cinematic"
          //       | "bourbon"
          //       | "chemical"
          //       | "clayton"
          //       | "cubicle"
          //       | "remy"
          //       | "bw"
          //       | "night",
          //     intensity: colorGradingIntensity,
          //   },
          // depthBlur: {
          //   enabled: depthBlurEnabled,
          //   intensity: depthBlurIntensity,
          //   focusDistance: depthBlurDistance,
          //   blurRange: DEPTH_BLUR_DEFAULTS.blurRange,
          //   blurAmount: DEPTH_BLUR_DEFAULTS.blurAmount,
          //   blurRepeats: DEPTH_BLUR_DEFAULTS.blurRepeats,
          // },
        },
      );
    } else {
      this.composer = null;
    }

    this.world.prefs?.on("change", this.onPrefsChange);

    // Debounced resize with strict size change detection
    let resizePending = false;
    this.resizer = new ResizeObserver((entries) => {
      if (resizePending) return;

      const entry = entries[0];
      if (!entry) return;

      const newWidth = Math.floor(entry.contentRect.width);
      const newHeight = Math.floor(entry.contentRect.height);

      // Only resize if dimensions actually changed by at least 1 pixel
      if (newWidth !== this.width || newHeight !== this.height) {
        resizePending = true;
        requestAnimationFrame(() => {
          resizePending = false;
          this.resize(newWidth, newHeight);
        });
      }
    });

    // Set ID for Cypress tests
    this.renderer.domElement.id = "hyperia-world-canvas";

    // Style canvas to fill container and scale properly
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.display = "block";

    // Avoid appending twice
    if (this.renderer.domElement.parentElement !== this.viewport) {
      // Detach from any previous parent to avoid duplicate canvases
      if (this.renderer.domElement.parentElement) {
        this.renderer.domElement.parentElement.removeChild(
          this.renderer.domElement,
        );
      }
      this.viewport.appendChild(this.renderer.domElement);
    }
  }

  resize(width: number, height: number) {
    // Guard: ensure graphics system is fully initialized
    if (!this.renderer) {
      return;
    }

    // Ensure valid dimensions
    if (width <= 0 || height <= 0) {
      console.warn(
        `[ClientGraphics] Invalid resize dimensions: ${width}x${height}`,
      );
      return;
    }

    // Prevent unnecessary resize operations
    if (width === this.width && height === this.height) {
      return;
    }

    this.width = width;
    this.height = height;
    this.aspect = this.width / this.height;

    // Update camera aspect ratio
    // THREE.PerspectiveCamera has aspect and updateProjectionMatrix properties
    this.world.camera.aspect = this.aspect;
    this.world.camera.updateProjectionMatrix();

    // Update renderer size with current pixel ratio
    const dpr = this.world.prefs?.dpr || 1;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);

    // Update post-processing composer
    if (this.composer) {
      this.composer.setSize(this.width, this.height);
    }

    this.emit(EventType.GRAPHICS_RESIZE, {
      width: this.width,
      height: this.height,
      aspect: this.aspect,
    });
    this.render();
  }

  render() {
    // Camera owners (including diagnostic leases) select their pose before this
    // method. Screen-space fog must use that same pose, not the earlier update.
    this.world
      .getSystem<Environment>("environment")
      ?.prepareForRender(this.renderer, this.world.camera);
    if (!this.usePostprocessing || !this.composer) {
      this.renderer.render(this.world.stage.scene, this.world.camera);
    } else {
      this.composer.render();
    }
    this.hasRendered = true;
  }

  /**
   * Compile a newly loaded object's WebGPU pipelines before it becomes visible.
   * Calls are serialized because Three's compiler temporarily swaps renderer
   * traversal state. Visibility and frustum flags are restored synchronously
   * before the compiler waits on backend pipeline promises.
   */
  precompileObject(object: THREE.Object3D): Promise<void> {
    return this.rendererPreparationQueue.run(
      (startCallerDeadline) =>
        this.precompileObjectNow(object, startCallerDeadline),
      ClientGraphics.PRECOMPILE_TIMEOUT_MS,
      `WebGPU object precompile timed out after ${ClientGraphics.PRECOMPILE_TIMEOUT_MS}ms`,
    );
  }

  /**
   * Awaited startup preparation shares the object compiler's serialization.
   * Timeout rejects this caller after 15s of execution, but DOES NOT cancel the
   * operation: the queue stays busy until it settles. The operation owner must
   * guard late publication/disposal after timeout or world teardown. Do not
   * await another prepareRenderer/precompileObject call inside this callback.
   */
  prepareRenderer<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.rendererPreparationQueue.run(
      (startCallerDeadline) => {
        startCallerDeadline();
        return operation();
      },
      ClientGraphics.PRECOMPILE_TIMEOUT_MS,
      `WebGPU renderer preparation timed out after ${ClientGraphics.PRECOMPILE_TIMEOUT_MS}ms`,
    );
  }

  isPrecompileIdle(): boolean {
    return this.rendererPreparationQueue.pendingCount === 0;
  }

  private async precompileObjectNow(
    object: THREE.Object3D,
    startCallerDeadline: () => void,
  ): Promise<void> {
    // Streaming equipment contracts can arrive while ClientGraphics.init() is
    // still awaiting WebGPU adapter creation. Queue the compile until that
    // exact renderer is ready instead of turning a healthy startup race into a
    // failed asset pre-warm and a redundant reload.
    const rendererReadyDeadline =
      Date.now() + ClientGraphics.RENDERER_READY_TIMEOUT_MS;
    while (!this.renderer) {
      if (Date.now() >= rendererReadyDeadline) {
        throw new Error(
          `WebGPU renderer was not ready after ${ClientGraphics.RENDERER_READY_TIMEOUT_MS}ms`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }

    const previousVisible = object.visible;
    const frustumStates: Array<{
      object: THREE.Object3D & { frustumCulled: boolean };
      value: boolean;
    }> = [];
    object.traverse((child) => {
      if (
        "frustumCulled" in child &&
        typeof child.frustumCulled === "boolean"
      ) {
        frustumStates.push({
          object: child as THREE.Object3D & { frustumCulled: boolean },
          value: child.frustumCulled,
        });
        child.frustumCulled = false;
      }
    });

    let compilation: Promise<void>;
    try {
      object.visible = true;
      object.updateMatrixWorld(true);
      compilation = this.renderer.compileAsync(
        object,
        this.world.camera,
        this.world.stage.scene,
      );
    } finally {
      object.visible = previousVisible;
      for (const state of frustumStates) {
        state.object.frustumCulled = state.value;
      }
    }

    startCallerDeadline();
    await compilation;
  }

  override commit() {
    this.render();
  }

  override preTick() {
    const fov = this.world.camera.fov;
    const fovRadians = THREE.MathUtils.degToRad(fov);
    this.worldToScreenFactor = (Math.tan(fovRadians / 2) * 2) / this.height;

    // Update GPU compute state for this frame (frustum updates, shared uniforms, etc.)
    // Pass player position for occlusion dissolve
    const localPlayer = this.world.entities?.getLocalPlayer?.();
    const playerPos = localPlayer?.position ?? this.world.camera.position;
    updateGPUCompute(this.world.camera, 0, playerPos);
  }

  onPrefsChange = (changes: {
    dpr?: { value: number };
    postprocessing?: { value: boolean };
    bloom?: { value: boolean };
    colorGrading?: { value: string };
    colorGradingIntensity?: { value: number };
    depthBlur?: { value: boolean };
    depthBlurIntensity?: { value: number };
    depthBlurDistance?: { value: number };
  }) => {
    // dpr
    if (changes.dpr) {
      this.renderer.setPixelRatio(changes.dpr.value);
      this.resize(this.width, this.height);
    }
    // postprocessing (TSL-based, requires WebGPU which is mandatory)
    if (changes.postprocessing) {
      this.usePostprocessing = changes.postprocessing.value;
    }
    // color grading LUT
    if (changes.colorGrading && this.composer) {
      this.composer.setLUT(
        changes.colorGrading.value as
          | "none"
          | "cinematic"
          | "bourbon"
          | "chemical"
          | "clayton"
          | "cubicle"
          | "remy"
          | "bw"
          | "night",
      );
    }
    // color grading intensity
    if (changes.colorGradingIntensity && this.composer) {
      this.composer.setLUTIntensity(changes.colorGradingIntensity.value);
    }
    // depth blur enabled/disabled
    if (changes.depthBlur && this.composer) {
      this.composer.setDepthBlur(changes.depthBlur.value);
    }
    // depth blur intensity
    if (changes.depthBlurIntensity && this.composer) {
      this.composer.setDepthBlurIntensity(changes.depthBlurIntensity.value);
    }
    // depth blur distance
    if (changes.depthBlurDistance && this.composer) {
      this.composer.setDepthBlurFocusDistance(changes.depthBlurDistance.value);
    }
  };

  override destroy() {
    // Guard against destruction before initialization
    if (this.resizer) {
      this.resizer.disconnect();
    }
    // Unsubscribe from prefs changes
    this.world.prefs?.off("change", this.onPrefsChange);
    // Ensure animation loop is stopped
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
    }
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    // Clean up GPU compute resources
    if (this.gpuCompute) {
      cleanupGPUCompute();
      this.gpuCompute = null;
    }
    // Remove renderer from DOM if it was added
    if (this.renderer?.domElement && this.viewport) {
      const parent = this.renderer.domElement.parentElement;
      if (parent === this.viewport) {
        this.viewport.removeChild(this.renderer.domElement);
      }
    }
  }
}
