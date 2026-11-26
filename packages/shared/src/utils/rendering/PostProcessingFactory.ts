/**
 * Post-Processing Factory - WebGPU TSL-based effects pipeline
 *
 * Provides WebGPU-compatible post-processing effects including:
 * - 3D LUT color grading for cinematic looks
 * - Depth-based camera blur (DoF) for classic fantasy MMORPG-style depth of field
 * - Tone mapping control
 * - Entity outline highlighting (modern MMORPG-style hover effect)
 *
 * Uses Three.js TSL (Three Shading Language) for GPU-accelerated effects.
 */

import THREE, {
  pass,
  uniform,
  renderOutput,
  texture3D,
  mix,
  smoothstep,
  max,
  sub,
  mul,
  step,
  vec4,
} from "../../extras/three/three";
import type Lut3DNode from "three/examples/jsm/tsl/display/Lut3DNode.js";
import type { Node } from "three/webgpu";
import type { LUTCubeLoader } from "three/examples/jsm/loaders/LUTCubeLoader.js";
import type { LUT3dlLoader } from "three/examples/jsm/loaders/LUT3dlLoader.js";
import type { LUTImageLoader } from "three/examples/jsm/loaders/LUTImageLoader.js";
import type { WebGPURenderer } from "./RendererFactory";

/** Default depth blur parameters (classic fantasy MMORPG-style DoF) */
export const DEPTH_BLUR_DEFAULTS = {
  /** Focus distance in world units - objects at this distance are sharpest */
  focusDistance: 100,
  /** Range over which blur transitions from 0 to max */
  blurRange: 100,
  /** Overall blur intensity 0-1 */
  intensity: 0.85,
  /** Hash blur amount - controls blur radius (0.01-0.1 typical) */
  blurAmount: 0.03,
  /** Hash blur iterations - higher = smoother but more expensive */
  blurRepeats: 30,
  /** Sky cutoff distance - objects beyond this are not blurred (preserves sky) */
  skyDistance: 500,
} as const;

/**
 * Available LUT presets for color grading
 * Maps preset key to display name and file name
 */
export const LUT_PRESETS = {
  none: { label: "None", file: null },
  cinematic: { label: "Cinematic", file: "Presetpro-Cinematic.3dl" },
  bourbon: { label: "Bourbon", file: "Bourbon 64.CUBE" },
  chemical: { label: "Chemical", file: "Chemical 168.CUBE" },
  clayton: { label: "Clayton", file: "Clayton 33.CUBE" },
  cubicle: { label: "Cubicle", file: "Cubicle 99.CUBE" },
  remy: { label: "Remy", file: "Remy 24.CUBE" },
  bw: { label: "B&W", file: "B&WLUT.png" },
  night: { label: "Night", file: "NightLUT.png" },
} as const;

export type LUTPresetName = keyof typeof LUT_PRESETS;

/** PostProcessing composer interface */
export type PostProcessingComposer = {
  render: () => void;
  renderAsync: () => Promise<void>;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
  // LUT
  setLUT: (lutName: LUTPresetName) => Promise<void>;
  setLUTIntensity: (intensity: number) => void;
  getCurrentLUT: () => LUTPresetName;
  isLUTEnabled: () => boolean;
  // Depth blur
  setDepthBlur: (enabled: boolean) => void;
  setDepthBlurIntensity: (intensity: number) => void;
  setDepthBlurFocusDistance: (distance: number) => void;
  setDepthBlurRange: (range: number) => void;
  isDepthBlurEnabled: () => boolean;
  // Outline highlighting
  setOutlineObjects: (objects: THREE.Object3D[]) => void;
  setOutlineColor: (visible: THREE.Color, hidden?: THREE.Color) => void;
  setOutlineStrength: (strength: number) => void;
};

export interface PostProcessingOptions {
  colorGrading?: {
    enabled?: boolean;
    lut?: LUTPresetName;
    intensity?: number;
  };
  depthBlur?: {
    enabled?: boolean;
    focusDistance?: number;
    blurRange?: number;
    intensity?: number;
    /** Hash blur amount - controls blur radius (0.01-0.1 typical) */
    blurAmount?: number;
    /** Hash blur iterations - higher = smoother (30-100 typical) */
    blurRepeats?: number;
  };
}

// Cached dynamic modules
let lut3DModule:
  typeof import("three/examples/jsm/tsl/display/Lut3DNode.js") | null = null;
let lutCubeLoaderModule:
  typeof import("three/examples/jsm/loaders/LUTCubeLoader.js") | null = null;
let lut3dlLoaderModule:
  typeof import("three/examples/jsm/loaders/LUT3dlLoader.js") | null = null;
let lutImageLoaderModule:
  typeof import("three/examples/jsm/loaders/LUTImageLoader.js") | null = null;
let hashBlurModule:
  typeof import("three/addons/tsl/display/hashBlur.js") | null = null;
let outlineModule:
  typeof import("three/examples/jsm/tsl/display/OutlineNode.js") | null = null;

/**
 * Load outline module dynamically
 */
async function loadOutlineModule(): Promise<void> {
  if (!outlineModule) {
    outlineModule =
      await import("three/examples/jsm/tsl/display/OutlineNode.js");
  }
}

/** Load all required dynamic modules */
async function loadModules(): Promise<void> {
  const imports = await Promise.all([
    lut3DModule ? null : import("three/examples/jsm/tsl/display/Lut3DNode.js"),
    lutCubeLoaderModule
      ? null
      : import("three/examples/jsm/loaders/LUTCubeLoader.js"),
    lut3dlLoaderModule
      ? null
      : import("three/examples/jsm/loaders/LUT3dlLoader.js"),
    lutImageLoaderModule
      ? null
      : import("three/examples/jsm/loaders/LUTImageLoader.js"),
    hashBlurModule ? null : import("three/addons/tsl/display/hashBlur.js"),
  ]);

  if (imports[0]) {
    lut3DModule = imports[0];
  }
  if (imports[1]) lutCubeLoaderModule = imports[1];
  if (imports[2]) lut3dlLoaderModule = imports[2];
  if (imports[3]) lutImageLoaderModule = imports[3];
  if (imports[4]) hashBlurModule = imports[4];
}

/** Load a LUT texture by preset name */
async function loadLUT(
  lutName: LUTPresetName,
  lutCache: Map<string, THREE.Data3DTexture>,
  lutLoads: Map<string, Promise<THREE.Data3DTexture>>,
): Promise<THREE.Data3DTexture | null> {
  if (lutName === "none") return null;

  const preset = LUT_PRESETS[lutName];
  if (!preset.file) return null;

  // Return cached texture
  const cached = lutCache.get(lutName);
  if (cached) return cached;
  const pending = lutLoads.get(lutName);
  if (pending) return pending;

  const fileName = preset.file;
  const lutPath = `/luts/${fileName}`;

  let loader: LUTCubeLoader | LUT3dlLoader | LUTImageLoader;
  if (fileName.endsWith(".CUBE")) {
    loader = new lutCubeLoaderModule!.LUTCubeLoader();
  } else if (fileName.endsWith(".3dl")) {
    loader = new lut3dlLoaderModule!.LUT3dlLoader();
  } else if (fileName.endsWith(".png")) {
    loader = new lutImageLoaderModule!.LUTImageLoader();
  } else {
    console.error(`[PostProcessing] Unknown LUT format: ${fileName}`);
    return null;
  }

  const loading = loader
    .loadAsync(lutPath)
    .then((result) => {
      lutCache.set(lutName, result.texture3D);
      return result.texture3D;
    })
    .finally(() => {
      if (lutLoads.get(lutName) === loading) lutLoads.delete(lutName);
    });
  lutLoads.set(lutName, loading);
  return loading;
}

/** Keep the public LUT size uniform in sync with its actual sampling texture. */
export function setPostProcessingLUTTexture(
  node: Lut3DNode,
  texture: THREE.Data3DTexture,
): void {
  const { width, height, depth } = texture.image;
  if (
    !Number.isInteger(width) ||
    width < 2 ||
    height !== width ||
    depth !== width
  ) {
    throw new Error("Post-processing LUT must be a cubic texture of size >= 2");
  }
  node.lutNode.value = texture;
  node.size.value = width;
}

/**
 * Maintained r186 declarations leave this addon's TempNode result unparameterized.
 * Official r186 Lut3DNode.js (148ef33ecb6d2502ff796d4554abd1549c95d519)
 * fixes its constructor output to super('vec4'); TSLCore installs node methods
 * and swizzles on Node.prototype. Keep this single exact boundary qualified.
 */
export function getPostProcessingLUTColor(
  node: Lut3DNode,
): Lut3DNode & Node<"vec4"> {
  if (node.nodeType !== "vec4") {
    throw new Error("Post-processing LUT must produce vec4 color");
  }
  return node as Lut3DNode & Node<"vec4">;
}

/** Create identity LUT (passthrough) */
function createIdentityLUT(): THREE.Data3DTexture {
  const size = 2;
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (z * size * size + y * size + x) * 4;
        data[i] = Math.round((x / (size - 1)) * 255);
        data[i + 1] = Math.round((y / (size - 1)) * 255);
        data[i + 2] = Math.round((z / (size - 1)) * 255);
        data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Create post-processing pipeline */
export async function createPostProcessing(
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: PostProcessingOptions = {},
): Promise<PostProcessingComposer> {
  await loadModules();
  await loadOutlineModule();

  // Textures belong to this composer, not to every renderer using the module.
  const lutCache = new Map<string, THREE.Data3DTexture>();
  const lutLoads = new Map<string, Promise<THREE.Data3DTexture>>();
  let disposed = false;
  let lutRequest = 0;

  // State
  let currentLUT: LUTPresetName =
    options.colorGrading?.enabled === false
      ? "none"
      : (options.colorGrading?.lut ?? "none");
  let lutEnabled = false;
  let depthBlurActive = options.depthBlur?.enabled ?? false;
  let outlineActive = false;
  // Track user's preferred intensity (mutable - updated when user changes slider)
  let userDepthBlurIntensity =
    options.depthBlur?.intensity ?? DEPTH_BLUR_DEFAULTS.intensity;

  // Uniforms
  const lutIntensityUniform = uniform(options.colorGrading?.intensity ?? 1.0);
  const depthBlurFocusUniform = uniform(
    options.depthBlur?.focusDistance ?? DEPTH_BLUR_DEFAULTS.focusDistance,
  );
  const depthBlurRangeUniform = uniform(
    options.depthBlur?.blurRange ?? DEPTH_BLUR_DEFAULTS.blurRange,
  );
  const depthBlurIntensityUniform = uniform(
    depthBlurActive ? userDepthBlurIntensity : 0,
  );
  const depthBlurAmountUniform = uniform(
    options.depthBlur?.blurAmount ?? DEPTH_BLUR_DEFAULTS.blurAmount,
  );
  const depthBlurRepeatsUniform = uniform(
    options.depthBlur?.blurRepeats ?? DEPTH_BLUR_DEFAULTS.blurRepeats,
  );

  // Outline uniforms
  const selectedObjects: THREE.Object3D[] = [];
  const edgeStrengthUniform = uniform(3.0);
  const edgeThicknessUniform = uniform(1.0);
  const edgeGlowUniform = uniform(0.0);
  const visibleEdgeColorUniform = uniform(new THREE.Color(0xffffff));
  const hiddenEdgeColorUniform = uniform(new THREE.Color(0x190a05));

  const postProcessing = new THREE.RenderPipeline(renderer);
  postProcessing.outputColorTransform = false;

  // Build TSL pipeline: scene -> depth blur -> tone map -> LUT -> outline
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();
  const sceneViewZ = scenePass.getViewZNode();

  // Depth blur: only blur objects BEYOND the focus distance (far blur only)
  // hashBlur uses randomized sampling for smooth, organic blur (no grid artifacts)
  const blurredColor = hashBlurModule!.hashBlur(
    sceneColor,
    depthBlurAmountUniform,
    { repeats: depthBlurRepeatsUniform },
  );

  // viewZ is negative in view space, so we negate it to get positive depth
  const depth = mul(sceneViewZ, -1);
  // Only blur objects further than focus distance (max clamps negative to 0 = no blur for near)
  const depthBeyondFocus = max(sub(depth, depthBlurFocusUniform), uniform(0));
  const blurFactor = smoothstep(
    uniform(0),
    depthBlurRangeUniform,
    depthBeyondFocus,
  );
  // Exclude sky from blur: step returns 1 when depth >= skyDistance, we subtract to get 0
  const skyMask = sub(
    uniform(1),
    step(uniform(DEPTH_BLUR_DEFAULTS.skyDistance), depth),
  );
  const finalBlurFactor = mul(
    mul(blurFactor, depthBlurIntensityUniform),
    skyMask,
  );
  const depthBlurOutput = mix(sceneColor, blurredColor, finalBlurFactor);

  // Tone mapping
  const toneMapped = renderOutput(depthBlurOutput);

  // LUT color grading
  const identityLUT = createIdentityLUT();
  const lutTextureNode = texture3D(identityLUT);
  const lutSize = identityLUT.image.width;
  const lutOutput = lut3DModule!.lut3D(
    toneMapped,
    lutTextureNode,
    lutSize,
    lutIntensityUniform,
  );

  // Outline highlighting
  const outlineFn = outlineModule!.outline;
  const outlineNode = outlineFn(scene, camera, {
    selectedObjects,
    edgeGlow: edgeGlowUniform,
    edgeThickness: edgeThicknessUniform,
  });

  const outlineColor = outlineNode.visibleEdge
    .mul(visibleEdgeColorUniform)
    .add(outlineNode.hiddenEdge.mul(hiddenEdgeColorUniform))
    .mul(edgeStrengthUniform);

  // Chain: scene → depth blur → tone mapping → LUT → + outline → final output
  // Outline contributes RGB light, not opacity. Preserve the scene/LUT alpha.
  const gradedColor = vec4(getPostProcessingLUTColor(lutOutput));
  postProcessing.outputNode = vec4(
    gradedColor.rgb.add(outlineColor),
    gradedColor.a,
  );

  // Load initial LUT if specified
  if (options.colorGrading?.enabled !== false && currentLUT !== "none") {
    try {
      const tex = await loadLUT(currentLUT, lutCache, lutLoads);
      if (tex) {
        setPostProcessingLUTTexture(lutOutput, tex);
        lutEnabled = true;
      }
    } catch (err) {
      console.error(
        `[PostProcessing] Failed to load initial LUT "${currentLUT}":`,
        err,
      );
      // Continue with identity LUT (no color grading)
      currentLUT = "none";
    }
  }

  const isAnyEffectActive = () =>
    lutEnabled || depthBlurActive || outlineActive;

  // Detect incompatible GLSL ShaderMaterials during rendering
  // All materials should now use TSL (NodeMaterial). If we see this warning,
  // it means there's a GLSL ShaderMaterial that wasn't converted - treat as error.
  const originalWarn = console.warn;
  const incompatibleMaterialPattern =
    /NodeMaterial: Material .* is not compatible/;

  const wrapWithMaterialCheck = <T>(fn: () => T): T => {
    console.warn = (...args: Parameters<typeof console.warn>) => {
      const message = args[0];
      if (
        typeof message === "string" &&
        incompatibleMaterialPattern.test(message)
      ) {
        // Log as error - this should not happen with proper TSL materials
        console.error(
          "[PostProcessing] GLSL ShaderMaterial detected! All materials must use TSL for WebGPU:",
          message,
        );
      }
      originalWarn.apply(console, args);
    };
    try {
      return fn();
    } finally {
      console.warn = originalWarn;
    }
  };

  const wrapWithMaterialCheckAsync = async <T>(
    fn: () => Promise<T>,
  ): Promise<T> => {
    console.warn = (...args: Parameters<typeof console.warn>) => {
      const message = args[0];
      if (
        typeof message === "string" &&
        incompatibleMaterialPattern.test(message)
      ) {
        // Log as error - this should not happen with proper TSL materials
        console.error(
          "[PostProcessing] GLSL ShaderMaterial detected! All materials must use TSL for WebGPU:",
          message,
        );
      }
      originalWarn.apply(console, args);
    };
    try {
      return await fn();
    } finally {
      console.warn = originalWarn;
    }
  };

  return {
    render: () => {
      if (disposed) return;
      // Check for incompatible materials during render
      wrapWithMaterialCheck(() => {
        if (isAnyEffectActive()) {
          postProcessing.render();
        } else {
          renderer.render(scene, camera);
        }
      });
    },

    renderAsync: async () => {
      if (disposed) return;
      // r186's RenderPipeline.renderAsync is deprecated; initialize once through
      // the renderer's public idempotent API and use the normal pipeline render.
      await renderer.init();
      if (disposed) return;
      // Check for incompatible materials during render
      await wrapWithMaterialCheckAsync(async () => {
        if (isAnyEffectActive()) {
          postProcessing.render();
        } else {
          renderer.render(scene, camera);
        }
      });
    },

    setSize: (_width: number, _height: number) => {
      // WebGPU PostProcessing reads renderer size each frame - no manual resize needed
      // This method exists for API compatibility with other composer patterns
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      lutRequest++;
      postProcessing.dispose();
      scenePass.dispose();
      outlineNode.dispose();
      identityLUT.dispose();
      lutCache.forEach((lut) => lut.dispose());
      lutCache.clear();
    },

    // LUT methods
    setLUT: async (lutName: LUTPresetName) => {
      if (disposed) return;
      const request = ++lutRequest;
      if (lutName === currentLUT) return;

      if (lutName === "none") {
        currentLUT = lutName;
        lutEnabled = false;
        lutIntensityUniform.value = 0;
        return;
      }

      // Load new LUT before updating state - if load fails, keep current LUT
      let tex: THREE.Data3DTexture | null = null;
      try {
        tex = await loadLUT(lutName, lutCache, lutLoads);
      } catch (err) {
        console.error(`[PostProcessing] Failed to load LUT "${lutName}":`, err);
        return; // Keep current LUT on failure
      }

      if (disposed) {
        // A load completing after teardown still owns its newly cached texture.
        if (tex && lutCache.get(lutName) === tex) {
          lutCache.delete(lutName);
          tex.dispose();
        }
        return;
      }
      if (request !== lutRequest) return;

      if (tex) {
        setPostProcessingLUTTexture(lutOutput, tex);
        currentLUT = lutName;
        lutIntensityUniform.value = options.colorGrading?.intensity ?? 1.0;
        lutEnabled = true;
      }
    },

    setLUTIntensity: (intensity: number) => {
      lutIntensityUniform.value = Math.max(0, Math.min(1, intensity));
    },

    getCurrentLUT: () => currentLUT,
    isLUTEnabled: () => lutEnabled,

    // Depth blur methods
    setDepthBlur: (enabled: boolean) => {
      depthBlurActive = enabled;
      depthBlurIntensityUniform.value = enabled ? userDepthBlurIntensity : 0;
    },

    setDepthBlurIntensity: (intensity: number) => {
      const clamped = Math.max(0, Math.min(1, intensity));
      // Store user's preferred intensity so toggle off/on restores it
      userDepthBlurIntensity = clamped;
      depthBlurIntensityUniform.value = clamped;
      depthBlurActive = clamped > 0;
    },

    setDepthBlurFocusDistance: (distance: number) => {
      depthBlurFocusUniform.value = Math.max(0, distance);
    },

    setDepthBlurRange: (range: number) => {
      depthBlurRangeUniform.value = Math.max(0.1, range);
    },

    isDepthBlurEnabled: () => depthBlurActive,

    // Outline highlighting methods
    setOutlineObjects: (objects: THREE.Object3D[]) => {
      selectedObjects.length = 0;
      if (objects.length > 0) {
        selectedObjects.push(...objects);
        outlineActive = true;
      } else {
        outlineActive = false;
      }
      outlineNode.selectedObjects = selectedObjects;
    },

    setOutlineColor: (visible: THREE.Color, hidden?: THREE.Color) => {
      visibleEdgeColorUniform.value.copy(visible);
      if (hidden) {
        hiddenEdgeColorUniform.value.copy(hidden);
      }
    },

    setOutlineStrength: (strength: number) => {
      edgeStrengthUniform.value = Math.max(0, Math.min(10, strength));
    },
  };
}
