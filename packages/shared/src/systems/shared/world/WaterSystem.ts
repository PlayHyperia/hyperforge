/**
 * WaterSystem - Lake Water Shader (WebGPU TSL)
 *
 * Features: Gerstner waves (5-wave), Phong specular, cosine-gradient depth
 * colour, flow-mapped 4-scroll detail normals (two-phase crossfade via
 * FlowUVW from cloud-sea technique), Schlick fresnel, Worley foam,
 * planar reflections (lake), day/night + fog integration.
 */

import THREE, {
  MeshStandardNodeMaterial,
  texture,
  positionWorld,
  positionLocal,
  reflector,
  screenUV,
  cameraPosition,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  pow,
  add,
  sub,
  mul,
  div,
  mix,
  dot,
  normalize,
  max,
  smoothstep,
  clamp,
  saturate,
  fract,
  abs,
  Fn,
  output,
  attribute,
  length,
  viewportDepthTexture,
  linearDepth,
  cameraNear,
  cameraFar,
} from "../../../extras/three/three";
import type { Node, NodeBuilder, NodeFrame, UniformNode } from "three/webgpu";
import { NodeUpdateType, select, positionView, exp2, fwidth } from "three/tsl";
import {
  alignCroppedReflectionRect,
  cropReflectionProjection,
  croppedReflectionScreen,
} from "../../../extras/three/CroppedReflectionScreen";
import { isOwnedUniformDirectionalShadowNode } from "../../../extras/three/UniformDirectionalShadow";
import type { World } from "../../../types";
import type { TerrainTile } from "../../../types/world/terrain";
import type { Wind } from "./Wind";
import { FOG_NEAR_SQ, FOG_FAR_SQ, fogRenderTarget } from "./FogConfig";
import { SUN_SHADE, NIGHT, applySunShade } from "./LightingConfig";
import { WorldIlluminationUniforms } from "./WorldIlluminationUniforms";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import type { CanonicalGroundLease } from "./CoastalBathymetry";
import { CoastalBathymetryOwner } from "./CoastalBathymetryOwner";
import { createCoastalWaterOpticalDistanceNode } from "./CoastalWaterOptics";

// ============================================================================
// CONFIGURATION
// ============================================================================

const GRAVITY = 9.81;
const PI = Math.PI;
const TWO_PI = PI * 2;

// ---- Water visual tuning ----
const WATER = {
  REFLECTION_INTENSITY: 0.4,
  WAVE_DAMP_DISTANCE: 6,
  MAX_DEPTH: 30,

  // Fresnel (Schlick approximation, rf0 = 0.3)
  RF0: 0.3,

  // Phong sun lighting
  SPECULAR_SHININESS: 100,
  SPECULAR_STRENGTH: 5.0,
  DIFFUSE_STRENGTH: 0.5,

  // Depth-based opacity: op = 1 - pow(sat(1 - depth/scale), falloff)
  OP_DEPTH_SCALE: 15,
  OP_DEPTH_FALLOFF: 3,

  // Depth-based colour gradient
  COLOR_DEPTH_SCALE: 50,
  COLOR_DEPTH_FALLOFF: 3,
  COLOR_DIST_FADE: 200,

  // Cosine gradient colour parameters — more green, less grey-blue
  // shallow(t=1) sRGB display: (0.276, 0.541, 0.595)  deep(t=0) sRGB display: (0.196, 0.384, 0.422)
  COS_PHASES: [0.5, 0.5, 0.5] as const,
  COS_AMPLITUDES: [0.0311, 0.1374, 0.1692] as const,
  COS_FREQUENCIES: [0.5, 0.5, 0.5] as const,
  COS_OFFSETS: [-0.4569, -0.3095, -0.2654] as const,

  // Normal noise strength (xz multiplier for surface normal)
  NORMAL_STRENGTH: 1.5,

  // Sheltered freshwater detail, selected per draw by the existing pond owner.
  // Retain the same normal samples, geometry and wave bounds.
  QUIET_NORMAL_STRENGTH: 0.65,
  QUIET_SURFACE_SPEED: 0.55,
  QUIET_REFLECTION_DISTORTION: 0.006,
  REFLECTION_DISTORTION: 0.015,

  // Homogeneous neutral attenuation along the unrefracted viewing ray. These
  // are art controls, not spectral absorption or a full scattering solution.
  QUIET_HALF_TRANSMITTANCE_METRES: 3,
  QUIET_DEEP_TINT: [0.02, 0.085, 0.095] as const,
  QUIET_REFRACTIVE_INDEX: 1.333,

  // Foam
  FOAM_SHORE_DISTANCE: 2.5,
  FOAM_CREST_MIN: 0.15,
  FOAM_CREST_MAX: 0.4,
  FOAM_CREST_MULTIPLIER: 0.6,
  FOAM_COLOR: { r: 0.85, g: 0.92, b: 0.96 },
  FOAM_MAX_OPACITY: 0.85,
  FOAM_SCROLL_X: 0.02,
  FOAM_SCROLL_Y: 0.015,
  FOAM_SCALE: 0.1,

  // Flow mapping (two-phase crossfade, ported from cloud-sea FlowUVW)
  FLOW_SPEED: 0.05,
  FLOW_STRENGTH: 1.0,
  FLOW_OFFSET: -0.1,
  FLOW_JUMP: [0.5, -0.25] as const,
  FLOW_UV_SCALE: 0.001,
};

// LOD configuration for water mesh resolution
const WATER_LOD = {
  HIGH_RESOLUTION: 64, // Close tiles (< 100m)
  MEDIUM_RESOLUTION: 32, // Medium distance (100-200m)
  LOW_RESOLUTION: 16, // Far tiles (> 200m)
  HIGH_DISTANCE: 100, // Distance threshold for high->medium LOD
  MEDIUM_DISTANCE: 200, // Distance threshold for medium->low LOD
};

type WaveParams = {
  w: number;
  phi: number;
  QADx: number;
  QADz: number;
  wADx: number;
  wADz: number;
  Dx: number;
  Dz: number;
  A: number;
};

// 5 Gerstner waves for realistic water motion (performance optimized)
const WAVES: WaveParams[] = [
  { A: 0.07, wavelength: 20, Q: 0.3, Dx: 0.7, Dz: 0.71 },
  { A: 0.05, wavelength: 14, Q: 0.25, Dx: -0.5, Dz: 0.87 },
  { A: 0.035, wavelength: 8, Q: 0.22, Dx: 0.9, Dz: -0.44 },
  { A: 0.025, wavelength: 5, Q: 0.2, Dx: 0.26, Dz: 0.97 },
  { A: 0.015, wavelength: 2.5, Q: 0.15, Dx: -0.8, Dz: 0.6 },
].map(({ A, wavelength, Q, Dx, Dz }) => {
  const w = TWO_PI / wavelength;
  const phi = Math.sqrt(GRAVITY * w);
  return {
    w,
    phi,
    QADx: Q * A * Dx,
    QADz: Q * A * Dz,
    wADx: w * A * Dx,
    wADz: w * A * Dz,
    Dx,
    Dz,
    A,
  };
});

// ============================================================================
// TYPES
// ============================================================================

// Component-wise bounds of the unchanged ocean positionNode. X/Z do not
// depend on wind; Y uses the actual ocean uniform rather than a default cap.
const OCEAN_WAVE_EXTENT = Object.freeze(
  WAVES.reduce(
    (extent, wave) => {
      extent.x += Math.abs(wave.QADx * 1.3);
      extent.y += Math.abs(wave.A * 1.3);
      extent.z += Math.abs(wave.QADz * 1.3);
      return extent;
    },
    { x: 0, y: 0, z: 0 },
  ),
);

const LAKE_WAVE_EXTENT = Object.freeze(
  WAVES.reduce(
    (extent, wave) => {
      extent.x += Math.abs(wave.QADx);
      extent.y += Math.abs(wave.A);
      extent.z += Math.abs(wave.QADz);
      return extent;
    },
    { x: 0, y: 0, z: 0 },
  ),
);

interface OceanDisplacementBounds {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  base: THREE.Box3;
  box: THREE.Box3;
  sphere: THREE.Sphere;
  wind: number;
}

type LakePlaneSource = {
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  version: number;
  localHeight: number;
  bounds: THREE.Box3;
};

type LakeReflectionOwner = {
  frameId: number;
  renderId: number;
  camera: THREE.Camera;
  scene: THREE.Scene | null;
  mesh: THREE.Mesh;
  plane: THREE.Plane;
  captured: boolean;
};

type LakeGrassFootprint = {
  renderer: NonNullable<NodeFrame["renderer"]>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  target: THREE.RenderTarget;
  width: number;
  height: number;
  projection: THREE.Matrix4;
  view: THREE.Matrix4;
  full: THREE.Frustum;
  crop: THREE.Frustum;
  before: THREE.Scene["onBeforeRender"];
  after: THREE.Scene["onAfterRender"];
};

type UniformFloat = UniformNode<"float", number>;
type UniformVec3 = UniformNode<"vec3", THREE.Vector3>;
type UniformColor = UniformNode<"color", THREE.Color>;

export type WaterUniforms = {
  illumination: WorldIlluminationUniforms;
  time: UniformFloat;
  sunDirection: UniformVec3;
  windStrength: UniformFloat;
  reflectionIntensity: UniformFloat;
  dayIntensity: UniformFloat;
  sunIntensity: UniformFloat;
  shadeColor: UniformColor;
};

/**
 * Water body type - determines shader and visual characteristics
 * - lake: Inland water bodies with planar reflections (when enabled)
 * - ocean: Large boundary water bodies without reflections, deeper colors
 */
export type WaterBodyType = "lake" | "ocean";

/** Per-draw state: an elevated quiet pond must not recolour another lake mesh. */
export function createQuietPondUniform() {
  return uniform(0).onObjectUpdate(({ object }) =>
    object?.userData.compactQuietPond === true ? 1 : 0,
  );
}

// ============================================================================
// WATER SYSTEM
// ============================================================================

export class WaterSystem {
  private world: World;
  private waterTime = 0;
  private lakeMaterial?: MeshStandardNodeMaterial;
  private quietPondUniform: ReturnType<typeof createQuietPondUniform> | null =
    null;
  private oceanMaterial?: MeshStandardNodeMaterial;
  private uniforms: WaterUniforms | null = null;
  private oceanUniforms: WaterUniforms | null = null;
  private normalTex?: THREE.Texture;
  private foamTex?: THREE.Texture;
  private flowTex?: THREE.Texture;
  private coastalBathymetry: CoastalBathymetryOwner | null = null;

  // TSL planar reflection (Three.js ReflectorNode handles camera, RT, clipping)
  private reflection?: ReturnType<typeof reflector>;
  private waterLevel: number = TERRAIN_CONSTANTS.WATER_THRESHOLD;
  private waterMeshes: THREE.Mesh[] = [];
  private lakePlaneSources = new Map<THREE.Mesh, LakePlaneSource>();
  private lakeReflectionOwners = new WeakMap<
    NodeFrame,
    WeakMap<THREE.Camera, LakeReflectionOwner>
  >();
  private lastLakeReflectionOwner: LakeReflectionOwner | null = null;
  private lakeReflectionPlaneUniform: UniformFloat | null = null;
  private readonly reflectionPlane = new THREE.Plane();
  private readonly reflectionNormalMatrix = new THREE.Matrix3();
  private readonly reflectionPoint = new THREE.Vector3();
  private readonly reflectionRotation = new THREE.Quaternion();
  private readonly reflectionAxis = new THREE.Vector3(0, 0, 1);
  private readonly reflectionScale = new THREE.Vector3(1, 1, 1);
  private reflectionFootprintEnabled = false;
  private reflectionCropEnabled = croppedReflectionScreen.enabled;
  private readonly reflectionCropUv = uniform(new THREE.Vector4(1, 1, 0, 0));
  private reflectionGrassFootprintEnabled = false;
  private reflectionGrassFootprint: LakeGrassFootprint | null = null;
  private lakeWavePositionNode: Node | null = null;
  private lakeReflectionUvNode: Node | null = null;
  private readonly reflectionViewProjection = new THREE.Matrix4();
  private readonly reflectionLocalProjection = new THREE.Matrix4();
  private readonly reflectionCorner = new THREE.Vector4();
  private readonly reflectionFootprintPlane = new THREE.Plane();
  // Optional bound records do not own or dispose geometry/materials.
  private oceanDisplacementBounds: OceanDisplacementBounds[] = [];

  private reflectionActive = false;

  // User preference for reflections (can be toggled)
  private _reflectionsEnabled = true;

  // Wind system reference for coordinated wind effects
  private windSystem: Wind | null = null;

  private static _textureLoader = new THREE.TextureLoader();

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Get whether realtime water reflections are enabled
   */
  get reflectionsEnabled(): boolean {
    return this._reflectionsEnabled;
  }

  /** Opt-in until native moving-view pixel and cost qualification is complete. */
  setReflectionFootprintEnabled(enabled: boolean): void {
    this.reflectionFootprintEnabled = enabled;
  }

  /** Runtime comparison is allowed only with the opt-in shader graph loaded. */
  setReflectionCropEnabled(enabled: boolean): void {
    if (enabled && !croppedReflectionScreen.enabled)
      throw new Error("Cropped reflection requires the opt-in shader graph");
    this.reflectionCropEnabled = enabled;
  }

  /** Submission-only experiment. Never enables the separate raster scissor. */
  setReflectionGrassFootprintEnabled(enabled: boolean): void {
    this.reflectionGrassFootprintEnabled = enabled;
    if (!enabled) this.reflectionGrassFootprint = null;
  }

  /** Called only for grass with an admitted, wind-swept world-space bound.
   * The renderer shares its Frustum across passes: identity alone is unsafe. */
  readonly intersectsReflectionGrassBounds = (
    frustum: THREE.Frustum,
    bounds: THREE.Box3,
  ): boolean => {
    const scope = this.reflectionGrassFootprint;
    if (
      !this.reflectionGrassFootprintEnabled ||
      !scope ||
      scope.renderer.getRenderTarget() !== scope.target ||
      scope.target.width !== scope.width ||
      scope.target.height !== scope.height ||
      scope.scene.onBeforeRender !== scope.before ||
      scope.scene.onAfterRender !== scope.after ||
      !scope.camera.projectionMatrix.equals(scope.projection) ||
      !scope.camera.matrixWorldInverse.equals(scope.view) ||
      !frustum.planes.every((plane, index) =>
        plane.equals(scope.full.planes[index]),
      ) ||
      ![
        bounds.min.x,
        bounds.min.y,
        bounds.min.z,
        bounds.max.x,
        bounds.max.y,
        bounds.max.z,
      ].every(Number.isFinite)
    )
      return true;
    return scope.crop.intersectsBox(bounds);
  };

  /** Own only the mirror capture; never virtualize native framebuffer samplers.
   * This opt-in pilot admits ordinary meshes, not transmission/custom shadow
   * filters. Issued-shader and moving-view pixel qualification remains required. */
  private beginLakeCroppedCapture(
    renderer: NonNullable<NodeFrame["renderer"]>,
    scene: THREE.Scene,
    camera: THREE.Camera,
    target: THREE.RenderTarget,
    fullWidth: number,
    fullHeight: number,
    pixels: THREE.Vector4,
  ): (() => void) | null {
    if (
      !this.reflectionCropEnabled ||
      this.reflectionGrassFootprintEnabled ||
      scene.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ||
      scene.onAfterRender !== THREE.Object3D.prototype.onAfterRender ||
      renderer.getScissorTest() ||
      target.scissorTest ||
      target.samples !== 0 ||
      camera instanceof THREE.ArrayCamera ||
      renderer.shadowMap.type !== THREE.PCFShadowMap ||
      ![fullWidth, fullHeight, ...pixels.toArray()].every(
        Number.isSafeInteger,
      ) ||
      fullWidth <= 0 ||
      fullHeight <= 0 ||
      pixels.x < 0 ||
      pixels.y < 0 ||
      pixels.z <= 0 ||
      pixels.w <= 0 ||
      pixels.x % 8 !== 0 ||
      pixels.y % 8 !== 0 ||
      pixels.x + pixels.z > fullWidth ||
      pixels.y + pixels.w > fullHeight
    )
      return null;
    let supported = true;
    scene.traverseVisible((object) => {
      if (!supported) return;
      if (object instanceof THREE.Light && object.castShadow) {
        supported =
          object instanceof THREE.DirectionalLight &&
          isOwnedUniformDirectionalShadowNode(
            object.shadow.shadowNode,
            object,
          ) &&
          Reflect.get(object.shadow, "filterNode") == null;
      }
      if (
        object instanceof THREE.Points ||
        object instanceof THREE.Sprite ||
        object instanceof THREE.Line
      )
        supported = false;
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        // Built-in transmission samples a local framebuffer/mip domain. It is
        // deliberately not claimed equivalent by the original-screen aliases.
        const transmission: unknown = Reflect.get(material, "transmission");
        if (
          material instanceof THREE.ShaderMaterial ||
          (transmission !== undefined && transmission !== 0) ||
          Reflect.get(material, "transmissionNode") != null
        )
          supported = false;
      }
    });
    if (!supported) return null;
    const beforeDescriptor = Object.getOwnPropertyDescriptor(
      scene,
      "onBeforeRender",
    );
    const afterDescriptor = Object.getOwnPropertyDescriptor(
      scene,
      "onAfterRender",
    );
    if (
      !Object.isExtensible(scene) ||
      [beforeDescriptor, afterDescriptor].some(
        (descriptor) =>
          descriptor && (!descriptor.configurable || !("value" in descriptor)),
      )
    )
      return null;
    const x = pixels.x,
      y = pixels.y,
      width = pixels.z,
      height = pixels.w;
    const crop = cropReflectionProjection(
      new THREE.Matrix4(),
      pixels,
      fullWidth,
      fullHeight,
    );
    const projection = new THREE.Matrix4();
    const inverse = new THREE.Matrix4();
    let active = false;
    let released = false;
    let endCoordinates: (() => void) | null = null;
    // Admission/lease validation must finish BEFORE ReflectorNode starts its
    // nested render: r186 has no exception cleanup around that native call.
    if (target.width !== width || target.height !== height)
      target.setSize(width, height);
    target.viewport.set(0, 0, width, height);
    target.scissor.set(0, 0, width, height);
    try {
      endCoordinates = croppedReflectionScreen.begin({
        renderer,
        target,
        camera,
        fullWidth,
        fullHeight,
        x,
        y,
        width,
        height,
      });
    } catch {
      return null;
    }
    const restore = () => {
      try {
        endCoordinates?.();
      } finally {
        endCoordinates = null;
        if (active) {
          camera.projectionMatrix.copy(projection);
          camera.projectionMatrixInverse.copy(inverse);
          active = false;
        }
      }
    };
    const owns = (args: unknown[]) =>
      args[0] === renderer &&
      args[1] === scene &&
      args[2] === camera &&
      args[3] === target;
    const before: THREE.Scene["onBeforeRender"] = (...args: unknown[]) => {
      if (!owns(args)) return;
      // Native ReflectorNode has finished its oblique Z-row at this point.
      projection.copy(camera.projectionMatrix);
      inverse.copy(camera.projectionMatrixInverse);
      active = true;
      camera.projectionMatrix.premultiply(crop);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    };
    const after: THREE.Scene["onAfterRender"] = (...args: unknown[]) => {
      if (owns(args)) restore();
    };
    Object.defineProperty(scene, "onBeforeRender", {
      configurable: true,
      writable: true,
      value: before,
    });
    Object.defineProperty(scene, "onAfterRender", {
      configurable: true,
      writable: true,
      value: after,
    });
    return () => {
      if (released) return;
      released = true;
      try {
        restore();
      } finally {
        if (scene.onBeforeRender === before) {
          if (beforeDescriptor)
            Object.defineProperty(scene, "onBeforeRender", beforeDescriptor);
          else delete (scene as Partial<THREE.Scene>).onBeforeRender;
        }
        if (scene.onAfterRender === after) {
          if (afterDescriptor)
            Object.defineProperty(scene, "onAfterRender", afterDescriptor);
          else delete (scene as Partial<THREE.Scene>).onAfterRender;
        }
      }
    };
  }

  /** Lease only the synchronous reflection traversal. The mirror camera is
   * still stale at _updateResolution; the scene callback observes its final
   * oblique projection, immediately before r186 builds the render list. */
  private beginLakeGrassFootprint(
    renderer: NonNullable<NodeFrame["renderer"]>,
    scene: THREE.Scene,
    camera: THREE.Camera,
    target: THREE.RenderTarget,
    pixels: THREE.Vector4,
  ): (() => void) | null {
    if (
      !this.reflectionGrassFootprintEnabled ||
      !this._reflectionsEnabled ||
      // Unknown scene callbacks can change the sampled lake footprint after
      // admission. Do not compose this experiment with those side effects.
      scene.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ||
      scene.onAfterRender !== THREE.Object3D.prototype.onAfterRender ||
      renderer.coordinateSystem !== THREE.WebGPUCoordinateSystem ||
      renderer.xr?.isPresenting ||
      camera instanceof THREE.ArrayCamera ||
      !this.hasBilinearLakeReflectionSampler(target.texture) ||
      ![
        target.width,
        target.height,
        pixels.x,
        pixels.y,
        pixels.z,
        pixels.w,
      ].every(Number.isSafeInteger) ||
      target.width <= 0 ||
      target.height <= 0 ||
      pixels.x < 0 ||
      pixels.y < 0 ||
      pixels.z <= 0 ||
      pixels.w <= 0 ||
      pixels.x + pixels.z > target.width ||
      pixels.y + pixels.w > target.height
    )
      return null;
    const beforeDescriptor = Object.getOwnPropertyDescriptor(
      scene,
      "onBeforeRender",
    );
    const afterDescriptor = Object.getOwnPropertyDescriptor(
      scene,
      "onAfterRender",
    );
    if (
      !Object.isExtensible(scene) ||
      [beforeDescriptor, afterDescriptor].some(
        (descriptor) =>
          descriptor && (!descriptor.configurable || !("value" in descriptor)),
      )
    )
      return null;
    const originalBefore = scene.onBeforeRender;
    const originalAfter = scene.onAfterRender;
    const previous = this.reflectionGrassFootprint;
    const stack: Array<LakeGrassFootprint | null> = [];
    const water = this;
    const width = target.width;
    const height = target.height;
    const cropMatrix = new THREE.Matrix4().set(
      width / pixels.z,
      0,
      0,
      (width - 2 * pixels.x - pixels.z) / pixels.z,
      0,
      height / pixels.w,
      0,
      (2 * pixels.y + pixels.w - height) / pixels.w,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    );
    let released = false;
    const before: THREE.Scene["onBeforeRender"] = function (
      this: THREE.Scene,
      ...args: unknown[]
    ) {
      stack.push(water.reflectionGrassFootprint);
      water.reflectionGrassFootprint = null;
      const result = Reflect.apply(originalBefore, this, args);
      if (
        released ||
        !water.reflectionGrassFootprintEnabled ||
        this !== scene ||
        args[0] !== renderer ||
        args[1] !== scene ||
        args[2] !== camera ||
        args[3] !== target ||
        renderer.getRenderTarget() !== target ||
        scene.onBeforeRender !== before ||
        scene.onAfterRender !== after ||
        target.width !== width ||
        target.height !== height ||
        camera.coordinateSystem !== THREE.WebGPUCoordinateSystem ||
        camera instanceof THREE.ArrayCamera ||
        ![
          ...camera.projectionMatrix.elements,
          ...camera.matrixWorldInverse.elements,
          ...cropMatrix.elements,
        ].every(Number.isFinite)
      )
        return result;
      const projection = camera.projectionMatrix.clone();
      const view = camera.matrixWorldInverse.clone();
      const vp = new THREE.Matrix4().multiplyMatrices(projection, view);
      const full = new THREE.Frustum().setFromProjectionMatrix(
        vp,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      const crop = new THREE.Frustum().setFromProjectionMatrix(
        vp.premultiply(cropMatrix),
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      if (
        ![...full.planes, ...crop.planes].every(
          (plane) =>
            [
              plane.normal.x,
              plane.normal.y,
              plane.normal.z,
              plane.constant,
            ].every(Number.isFinite) &&
            Math.abs(plane.normal.lengthSq() - 1) < 1e-6,
        )
      )
        return result;
      water.reflectionGrassFootprint = {
        renderer,
        scene,
        camera,
        target,
        width,
        height,
        projection,
        view,
        full,
        crop,
        before,
        after,
      };
      return result;
    };
    const after: THREE.Scene["onAfterRender"] = function (
      this: THREE.Scene,
      ...args: unknown[]
    ) {
      try {
        return Reflect.apply(originalAfter, this, args);
      } finally {
        water.reflectionGrassFootprint = stack.pop() ?? null;
      }
    };
    Object.defineProperty(scene, "onBeforeRender", {
      configurable: true,
      writable: true,
      value: before,
    });
    Object.defineProperty(scene, "onAfterRender", {
      configurable: true,
      writable: true,
      value: after,
    });
    return () => {
      if (released) return;
      released = true;
      water.reflectionGrassFootprint = previous;
      stack.length = 0;
      // A foreign replacement owns its new callback; never overwrite it.
      try {
        if (scene.onBeforeRender === before) {
          if (beforeDescriptor)
            Object.defineProperty(scene, "onBeforeRender", beforeDescriptor);
          else delete (scene as Partial<THREE.Scene>).onBeforeRender;
        }
      } finally {
        if (scene.onAfterRender === after) {
          if (afterDescriptor)
            Object.defineProperty(scene, "onAfterRender", afterDescriptor);
          else delete (scene as Partial<THREE.Scene>).onAfterRender;
        }
      }
    };
  }

  /**
   * Enable or disable realtime water reflections for lake/pond water
   * Ocean water never has reflections regardless of this setting
   */
  setReflectionsEnabled(enabled: boolean): void {
    if (enabled !== this._reflectionsEnabled) {
      this.lakeReflectionOwners = new WeakMap();
      this.lastLakeReflectionOwner = null;
    }
    this._reflectionsEnabled = enabled;

    // Keep the visual blend and the reflector's runtime update gate in sync.
    // Zero intensity alone still submits a complete reflected scene in Three.
    if (this.uniforms) {
      this.uniforms.reflectionIntensity.value = enabled
        ? WATER.REFLECTION_INTENSITY
        : 0.0;
    }

    if (!enabled) {
      this.reflectionActive = false;
    }

    // Reflection state toggled
  }

  get waterUniforms(): WaterUniforms | null {
    return this.uniforms;
  }

  /**
   * Snapshot of both live uniform records, including materials with no meshes.
   * Record references are read-only; the existing uniform values remain live.
   * Read again after initialization or destruction to discover current records.
   */
  get waterUniformsByType(): Readonly<
    Record<WaterBodyType, Readonly<WaterUniforms> | null>
  > {
    return Object.freeze({
      lake: this.uniforms,
      ocean: this.oceanUniforms,
    });
  }

  /**
   * Get the material for a specific water body type
   */
  getMaterial(type: WaterBodyType): MeshStandardNodeMaterial | undefined {
    return type === "ocean" ? this.oceanMaterial : this.lakeMaterial;
  }

  getQuietPondUniform() {
    return this.quietPondUniform;
  }

  /**
   * Returns true if the reflection camera is currently rendering
   * (i.e., at least one water mesh is visible in the frustum)
   */
  get isReflectionActive(): boolean {
    return this.reflectionActive;
  }

  /**
   * Returns the count of active reflection cameras (0 or 1)
   */
  get activeReflectionCameraCount(): number {
    return this.reflectionActive ? 1 : 0;
  }

  /**
   * Set the Y level used for the reflection mirror plane.
   */
  setWaterLevel(y: number): void {
    if (!Number.isFinite(y)) throw new Error("Water level must be finite");
    if (
      this.coastalBathymetry?.getReadiness().required &&
      y !== this.waterLevel
    )
      throw new Error(
        "Configured coastal water level must match its immutable terrain profile",
      );
    this.waterLevel = y;
    if (this.reflection?.target) {
      this.reflection.target.position.y = y;
    }
  }

  /** Initial compact field is requested only after authored grades are loaded. */
  configureCoastalBathymetry(
    sourceFactory: () => CanonicalGroundLease,
  ): Promise<boolean> {
    if (!this.coastalBathymetry)
      return Promise.reject(
        new Error("Coastal material must initialize before its field"),
      );
    return this.coastalBathymetry.configure(() => {
      const source = sourceFactory();
      if (source.profile.water.threshold !== this.waterLevel)
        throw new Error(
          "Coastal source sea level differs from its water owner",
        );
      return source;
    });
  }

  invalidateCoastalBathymetry(): void {
    this.coastalBathymetry?.invalidate();
  }

  getCoastalBathymetryReadiness() {
    return (
      this.coastalBathymetry?.getReadiness() ?? {
        required: false,
        ready: true,
        status: "inactive",
        sourceRevision: null,
        pendingRevision: null,
        progressSamples: 0,
        domain: null,
        statistics: null,
        textureId: null,
        error: null,
        scope: "No compact coastal field configured",
      }
    );
  }

  /** Borrowed texture for bounded native binding/filtering verification. */
  getCoastalBathymetryTexture(): THREE.DataTexture | null {
    return this.coastalBathymetry?.getTexture() ?? null;
  }

  /**
   * Register an externally-created water mesh for reflection visibility tracking.
   */
  registerWaterMesh(mesh: THREE.Mesh, trackOceanDisplacement = false): void {
    if (trackOceanDisplacement) {
      if (mesh.material !== this.oceanMaterial || !this.oceanUniforms)
        throw new Error(
          "Ocean displacement bounds require the live ocean material",
        );
      if (this.oceanDisplacementBounds.some((entry) => entry.mesh === mesh))
        return;
      const geometry = mesh.geometry;
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      if (
        box.isEmpty() ||
        ![
          box.min.x,
          box.min.y,
          box.min.z,
          box.max.x,
          box.max.y,
          box.max.z,
        ].every(Number.isFinite)
      )
        throw new Error("Ocean displacement bounds require finite geometry");
      const sphere = geometry.boundingSphere ?? new THREE.Sphere();
      const entry: OceanDisplacementBounds = {
        mesh,
        geometry,
        base: box.clone(),
        box,
        sphere,
        wind: NaN,
      };
      geometry.boundingSphere = sphere;
      this.refreshOceanDisplacementBounds(
        entry,
        this.oceanUniforms.windStrength.value,
      );
      this.oceanDisplacementBounds.push(entry);
    }
    this.registerLakePlaneSource(mesh);
    this.waterMeshes.push(mesh);
  }

  /** Admit the actual undeformed local water plane once, not by body metadata. */
  private registerLakePlaneSource(mesh: THREE.Mesh): void {
    if (this.lakePlaneSources.has(mesh)) {
      this.lakeReflectionOwners = new WeakMap();
      this.lastLakeReflectionOwner = null;
    }
    this.lakePlaneSources.delete(mesh);
    if (mesh.material !== this.lakeMaterial) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position || position.count < 3) return;
    let low = Infinity;
    let high = -Infinity;
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index);
      const y = position.getY(index);
      const z = position.getZ(index);
      if (![x, y, z].every(Number.isFinite)) return;
      bounds.expandByPoint(point.set(x, y, z));
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    // Circle/PlaneGeometry rotateX leaves sub-picometre Y roundoff. Curved
    // geometry is not an admitted planar reflector and must not borrow one.
    if (high - low > 1e-6) return;
    this.lakePlaneSources.set(mesh, {
      geometry: mesh.geometry,
      position,
      version:
        position instanceof THREE.InterleavedBufferAttribute
          ? position.data.version
          : position.version,
      localHeight: low / 2 + high / 2,
      bounds,
    });
  }

  /**
   * Conservative sampled region, not a cropped camera or smaller texture.
   * All coplanar consumers share one capture. Near-eye/unknown deformation
   * keeps the full capture; no visibility or first-plane arbitration changes.
   */
  private hasBilinearLakeReflectionSampler(texture: THREE.Texture): boolean {
    // r186 maps non-mip LinearFilter to native mipmapFilter="nearest", so
    // maxAnisotropy remains 1 even when the game's texture default is 16.
    // Check the effective sampling mode without changing the texture settings.
    return (
      !texture.generateMipmaps &&
      texture.mipmaps.length === 0 &&
      texture.minFilter === THREE.LinearFilter &&
      texture.magFilter === THREE.LinearFilter &&
      texture.wrapS === THREE.ClampToEdgeWrapping &&
      texture.wrapT === THREE.ClampToEdgeWrapping
    );
  }

  private computeLakeReflectionScissor(
    camera: THREE.Camera,
    ownerPlane: THREE.Plane,
    width: number,
    height: number,
    target: THREE.Vector4,
  ): boolean {
    const wind = this.uniforms?.windStrength.value;
    if (
      wind === undefined ||
      !Number.isFinite(wind) ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      camera instanceof THREE.ArrayCamera ||
      ![
        ownerPlane.normal.x,
        ownerPlane.normal.y,
        ownerPlane.normal.z,
        ownerPlane.constant,
      ].every(Number.isFinite) ||
      Math.abs(ownerPlane.normal.lengthSq() - 1) > 1e-6 ||
      this.lakeMaterial?.vertexNode ||
      this.lakeMaterial?.positionNode !== this.lakeWavePositionNode ||
      !this.lakeWavePositionNode
    )
      return false;
    this.reflectionViewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    if (!this.reflectionViewProjection.elements.every(Number.isFinite))
      return false;
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const [mesh, source] of this.lakePlaneSources) {
      // A stale source cannot establish its plane or its displaced footprint.
      if (!this.readLakeReflectionPlane(mesh, this.reflectionFootprintPlane))
        return false;
      const alignment = ownerPlane.normal.dot(
        this.reflectionFootprintPlane.normal,
      );
      if (
        Math.abs(alignment) < 1 - 1e-10 ||
        Math.abs(
          this.reflectionFootprintPlane.constant -
            (alignment < 0 ? -ownerPlane.constant : ownerPlane.constant),
        ) > 1e-5
      )
        continue;
      if (
        mesh instanceof THREE.InstancedMesh ||
        mesh instanceof THREE.SkinnedMesh ||
        mesh instanceof THREE.BatchedMesh ||
        mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ||
        mesh.geometry.morphAttributes.position?.length
      )
        return false;
      this.reflectionLocalProjection.multiplyMatrices(
        this.reflectionViewProjection,
        mesh.matrixWorld,
      );
      const { min, max } = source.bounds;
      const dy = LAKE_WAVE_EXTENT.y * Math.abs(wind);
      for (let corner = 0; corner < 8; corner++) {
        this.reflectionCorner
          .set(
            corner & 1
              ? max.x + LAKE_WAVE_EXTENT.x
              : min.x - LAKE_WAVE_EXTENT.x,
            corner & 2 ? max.y + dy : min.y - dy,
            corner & 4
              ? max.z + LAKE_WAVE_EXTENT.z
              : min.z - LAKE_WAVE_EXTENT.z,
            1,
          )
          .applyMatrix4(this.reflectionLocalProjection);
        const { x, y, w } = this.reflectionCorner;
        if (![x, y, w].every(Number.isFinite) || w <= 1e-6) return false;
        // WGSL screenUV uses top-left coordinates; ReflectorNode flips X only.
        const u = (1 - x / w) * 0.5;
        const v = (1 - y / w) * 0.5;
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
    if (![minU, minV, maxU, maxV].every(Number.isFinite)) return false;
    // Keep clamp-to-edge samples and a two-texel bilinear/raster guard. No
    // mipmapped or anisotropic reflection sampling is admitted by the caller.
    const distortion = Math.max(
      WATER.REFLECTION_DISTORTION,
      WATER.QUIET_REFLECTION_DISTORTION,
    );
    const left = Math.max(0, Math.floor((minU - distortion) * width - 2));
    const top = Math.max(0, Math.floor((minV - distortion) * height - 2));
    const right = Math.min(width, Math.ceil((maxU + distortion) * width + 2));
    const bottom = Math.min(
      height,
      Math.ceil((maxV + distortion) * height + 2),
    );
    if (
      right <= left ||
      bottom <= top ||
      (left === 0 && top === 0 && right === width && bottom === height)
    )
      return false;
    target.set(left, top, right - left, bottom - top);
    return true;
  }

  private readLakeReflectionPlane(
    mesh: THREE.Mesh,
    plane: THREE.Plane,
  ): boolean {
    const source = this.lakePlaneSources.get(mesh);
    if (
      !source ||
      mesh.material !== this.lakeMaterial ||
      mesh.geometry !== source.geometry ||
      mesh.geometry.getAttribute("position") !== source.position ||
      (source.position instanceof THREE.InterleavedBufferAttribute
        ? source.position.data.version
        : source.position.version) !== source.version ||
      !mesh.matrixWorld.elements.every(Number.isFinite) ||
      mesh.matrixWorld.determinant() === 0
    )
      return false;
    this.reflectionNormalMatrix.getNormalMatrix(mesh.matrixWorld);
    plane.setComponents(0, 1, 0, -source.localHeight);
    plane.applyMatrix4(mesh.matrixWorld, this.reflectionNormalMatrix);
    return (
      [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant].every(
        Number.isFinite,
      ) && plane.normal.lengthSq() > 0.999999
    );
  }

  /**
   * One capture per native render, not one per water mesh. The first admitted
   * lake in Three's actual draw order owns that capture. Other coplanar lakes
   * share it; different planes use the existing reflection-disabled blend.
   * Full simultaneous multi-height reflections would require extra captures.
   */
  private bindLakeReflectionPlane(
    frame: NodeFrame,
    target: THREE.Object3D,
  ): LakeReflectionOwner | null {
    const { object, camera } = frame;
    if (
      !this._reflectionsEnabled ||
      !(object instanceof THREE.Mesh) ||
      !camera ||
      !this.readLakeReflectionPlane(object, this.reflectionPlane)
    )
      return null;
    let owners = this.lakeReflectionOwners.get(frame);
    if (!owners) {
      owners = new WeakMap();
      this.lakeReflectionOwners.set(frame, owners);
    }
    const previous = owners.get(camera);
    if (
      previous?.renderId === frame.renderId &&
      previous.frameId === frame.frameId &&
      previous.scene === frame.scene
    )
      return null;
    const owner: LakeReflectionOwner = previous ?? {
      frameId: frame.frameId,
      renderId: frame.renderId,
      camera,
      scene: frame.scene,
      mesh: object,
      plane: new THREE.Plane(),
      captured: false,
    };
    owner.frameId = frame.frameId;
    owner.renderId = frame.renderId;
    owner.scene = frame.scene;
    owner.mesh = object;
    owner.plane.copy(this.reflectionPlane);
    owner.captured = false;
    owners.set(camera, owner);
    this.lastLakeReflectionOwner = owner;

    // ReflectorNode reads matrixWorld directly before its nested render. Build
    // an orthonormal frame from the inverse-transpose plane normal, including
    // transformed parents/nonuniform scale, rather than copying a sheared frame.
    owner.plane.coplanarPoint(this.reflectionPoint);
    this.reflectionRotation.setFromUnitVectors(
      this.reflectionAxis,
      owner.plane.normal,
    );
    target.matrixWorld.compose(
      this.reflectionPoint,
      this.reflectionRotation,
      this.reflectionScale,
    );
    return owner;
  }

  private matchesLakeReflectionPlane(frame: NodeFrame): boolean {
    const { object, camera } = frame;
    if (!this._reflectionsEnabled || !(object instanceof THREE.Mesh) || !camera)
      return false;
    const owner = this.lakeReflectionOwners.get(frame)?.get(camera);
    if (
      !owner ||
      owner.frameId !== frame.frameId ||
      owner.renderId !== frame.renderId ||
      owner.scene !== frame.scene ||
      !this.lakePlaneSources.has(owner.mesh) ||
      !this.readLakeReflectionPlane(object, this.reflectionPlane)
    )
      return false;
    const alignment = owner.plane.normal.dot(this.reflectionPlane.normal);
    return (
      Math.abs(alignment) >= 1 - 1e-10 &&
      Math.abs(
        this.reflectionPlane.constant -
          (alignment < 0 ? -owner.plane.constant : owner.plane.constant),
      ) <= 1e-5
    );
  }

  /**
   * Unregister an externally-created water mesh from reflection tracking.
   */
  unregisterWaterMesh(mesh: THREE.Mesh): void {
    if (this.lakePlaneSources.delete(mesh)) {
      // Do not revive an old render's capture if this mesh is registered again.
      this.lakeReflectionOwners = new WeakMap();
      this.lastLakeReflectionOwner = null;
    }
    const idx = this.waterMeshes.indexOf(mesh);
    if (idx !== -1) this.waterMeshes.splice(idx, 1);
    const boundsIndex = this.oceanDisplacementBounds.findIndex(
      (entry) => entry.mesh === mesh,
    );
    if (boundsIndex !== -1) this.oceanDisplacementBounds.splice(boundsIndex, 1);
  }

  /** Refresh the same native bound objects without allocating per-frame data. */
  private refreshOceanDisplacementBounds(
    entry: OceanDisplacementBounds,
    wind: number,
  ): void {
    if (
      entry.mesh.material !== this.oceanMaterial ||
      entry.mesh.geometry !== entry.geometry ||
      entry.geometry.boundingBox !== entry.box ||
      entry.geometry.boundingSphere !== entry.sphere
    )
      throw new Error("Tracked ocean geometry bounds changed ownership");
    if (!Number.isFinite(wind) || !Number.isFinite(Math.fround(wind)))
      throw new Error(
        "Cannot bound a non-finite or non-Float32 ocean wind uniform",
      );
    if (entry.wind === wind) return;
    // Absolute and relative allowance for Float32 shader arithmetic, in
    // addition to the analytic sum of all five wave component amplitudes.
    const dx = OCEAN_WAVE_EXTENT.x * 1.00001 + 0.001;
    const dy = OCEAN_WAVE_EXTENT.y * Math.abs(wind) * 1.00001 + 0.001;
    const dz = OCEAN_WAVE_EXTENT.z * 1.00001 + 0.001;
    const base = entry.base;
    const radius = Math.hypot(
      (base.max.x - base.min.x) / 2 + dx,
      (base.max.y - base.min.y) / 2 + dy,
      (base.max.z - base.min.z) / 2 + dz,
    );
    if (
      !Number.isFinite(radius) ||
      !Number.isFinite(base.min.x - dx) ||
      !Number.isFinite(base.min.y - dy) ||
      !Number.isFinite(base.min.z - dz) ||
      !Number.isFinite(base.max.x + dx) ||
      !Number.isFinite(base.max.y + dy) ||
      !Number.isFinite(base.max.z + dz)
    )
      throw new Error("Ocean displacement bounds overflow");
    entry.box.min.set(base.min.x - dx, base.min.y - dy, base.min.z - dz);
    entry.box.max.set(base.max.x + dx, base.max.y + dy, base.max.z + dz);
    entry.sphere.center.set(
      base.min.x / 2 + base.max.x / 2,
      base.min.y / 2 + base.max.y / 2,
      base.min.z / 2 + base.max.z / 2,
    );
    entry.sphere.radius = radius;
    entry.wind = wind;
  }

  /**
   * Returns the total number of water meshes being tracked
   */
  get waterMeshCount(): number {
    return this.waterMeshes.length;
  }

  /**
   * Returns the number of currently visible water meshes
   */
  get visibleWaterMeshCount(): number {
    let count = 0;
    for (const mesh of this.waterMeshes) {
      if (mesh.parent && mesh.visible) {
        count++;
      }
    }
    return count;
  }

  async init(): Promise<void> {
    if (this.world.isServer) return;

    const cachedLoader = WaterSystem._textureLoader;

    const loadTex = (url: string): Promise<THREE.Texture> =>
      new Promise((resolve, reject) => {
        cachedLoader.load(
          url,
          (t) => {
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.magFilter = THREE.LinearFilter;
            t.minFilter = THREE.LinearMipmapLinearFilter;
            t.generateMipmaps = true;
            resolve(t);
          },
          undefined,
          (e) => reject(e),
        );
      });

    const [normalResult, flowResult] = await Promise.allSettled([
      loadTex("/textures/waterNormal.png"),
      loadTex("/textures/noise28.png"),
    ]);

    this.normalTex =
      normalResult.status === "fulfilled"
        ? normalResult.value
        : await this.createNormalMap(512, 1.0, 42);
    this.flowTex =
      flowResult.status === "fulfilled"
        ? flowResult.value
        : this.createFlowFallback(256);
    this.foamTex = await this.createFoamTexture(128);

    this.reflection = this.createReflection();
    this.lakeMaterial = this.createLakeMaterial();
    this.oceanMaterial = this.createOceanMaterial();
  }

  private createReflection(): ReturnType<typeof reflector> {
    // TSL reflector: handles render target, camera mirroring, oblique clipping.
    const node = reflector({ resolutionScale: 0.5 });
    // Retain updateBeforeType so Three registers this node even when the initial
    // preference is disabled. NodeFrame queries this method each render, allowing
    // live re-enabling without rebuilding the shader or replacing the reflector.
    const reflection = node.reflector;
    // r186 resets the target's scissor on every _updateResolution call. Apply
    // only after that owned resize, keeping the full viewport and all samples.
    // The upstream declaration omits this internal method; guard its presence.
    const nativeResize: unknown = Reflect.get(reflection, "_updateResolution");
    type CaptureScope = {
      renderer: NonNullable<NodeFrame["renderer"]>;
      owner: LakeReflectionOwner;
      target: THREE.RenderTarget | null;
      scissored: boolean;
      endGrassFootprint: (() => void) | null;
      endCroppedCapture: (() => void) | null;
      previousTargetScissorTest: boolean;
      previousRendererScissorTest: boolean;
    };
    let captureScope: CaptureScope | null = null;
    const scissor = new THREE.Vector4();
    const viewport = new THREE.Vector4();
    const size = new THREE.Vector2();
    if (typeof nativeResize === "function") {
      const sizedReflection = reflection as typeof reflection & {
        _updateResolution(
          target: THREE.RenderTarget,
          renderer: NonNullable<NodeFrame["renderer"]>,
        ): void;
      };
      sizedReflection._updateResolution = (target, renderer) => {
        const cropEnabled = this.reflectionCropEnabled;
        const resizeFull = () => {
          Reflect.apply(nativeResize, reflection, [target, renderer]);
          this.reflectionCropUv.value.set(1, 1, 0, 0);
        };
        // Choose the attachment size BEFORE resizing. Full -> cropped resizing
        // here would dispose/reallocate twice on every reflection capture.
        if (!cropEnabled) resizeFull();
        const scope = captureScope;
        if (!scope || scope.renderer !== renderer || scope.target) {
          if (cropEnabled) resizeFull();
          return;
        }
        const virtualCamera = reflection.virtualCameras.get(scope.owner.camera);
        if (
          !virtualCamera ||
          reflection.renderTargets.get(virtualCamera) !== target
        ) {
          if (cropEnabled) resizeFull();
          return;
        }
        const source = renderer.getRenderTarget();
        if (source) {
          size.set(source.width, source.height);
          viewport.copy(source.viewport);
        } else {
          renderer.getDrawingBufferSize(size);
          renderer
            .getViewport(viewport)
            .multiplyScalar(renderer.getPixelRatio());
        }
        // Native r186 derives reflection dimensions from the drawing buffer,
        // even when the primary pass is rendering into an offscreen target.
        const drawingSize = renderer.getDrawingBufferSize(new THREE.Vector2());
        const fullWidth = Math.round(
          drawingSize.x * reflection.resolutionScale,
        );
        const fullHeight = Math.round(
          drawingSize.y * reflection.resolutionScale,
        );
        const texture = target.texture;
        if (
          renderer.coordinateSystem !== THREE.WebGPUCoordinateSystem ||
          renderer.xr?.isPresenting ||
          viewport.x !== 0 ||
          viewport.y !== 0 ||
          viewport.z !== size.x ||
          viewport.w !== size.y ||
          !this.hasBilinearLakeReflectionSampler(texture) ||
          node.uvNode !== this.lakeReflectionUvNode ||
          node.updateMatrix ||
          !node.sampler ||
          node.levelNode ||
          node.biasNode ||
          node.gradNode ||
          Reflect.get(node, "offsetNode") ||
          this.normalTex?.type !== THREE.UnsignedByteType ||
          !this.computeLakeReflectionScissor(
            scope.owner.camera,
            scope.owner.plane,
            fullWidth,
            fullHeight,
            scissor,
          )
        ) {
          if (cropEnabled) resizeFull();
          return;
        }
        if (cropEnabled) {
          // Eight-pixel origin alignment also preserves legacy ordered fades.
          // Expand outward only: never discard any admitted bilinear footprint.
          const aligned = alignCroppedReflectionRect(
            scissor,
            fullWidth,
            fullHeight,
          );
          if (!aligned) {
            resizeFull();
            return;
          }
          scissor.copy(aligned);
          const scene = scope.owner.scene;
          const direction = scope.owner.camera.getWorldDirection(
            new THREE.Vector3(),
          );
          const eye = new THREE.Vector3().setFromMatrixPosition(
            scope.owner.camera.matrixWorld,
          );
          scope.endCroppedCapture =
            scene &&
            Math.abs(direction.dot(scope.owner.plane.normal)) > 1e-4 &&
            scope.owner.plane.distanceToPoint(eye) > 1e-5
              ? this.beginLakeCroppedCapture(
                  renderer,
                  scene,
                  virtualCamera,
                  target,
                  fullWidth,
                  fullHeight,
                  scissor,
                )
              : null;
          if (!scope.endCroppedCapture) {
            resizeFull();
            return;
          }
          scope.target = target;
          this.reflectionCropUv.value.set(
            fullWidth / scissor.z,
            fullHeight / scissor.w,
            -scissor.x / scissor.z,
            -scissor.y / scissor.w,
          );
          return;
        }
        scope.target = target;
        if (this.reflectionGrassFootprintEnabled && scope.owner.scene) {
          const direction = scope.owner.camera.getWorldDirection(
            new THREE.Vector3(),
          );
          const eye = new THREE.Vector3().setFromMatrixPosition(
            scope.owner.camera.matrixWorld,
          );
          // No tight crop at an unsupported/grazing mirror view.
          if (
            Math.abs(direction.dot(scope.owner.plane.normal)) > 1e-4 &&
            scope.owner.plane.distanceToPoint(eye) > 1e-5
          )
            scope.endGrassFootprint = this.beginLakeGrassFootprint(
              renderer,
              scope.owner.scene,
              virtualCamera,
              target,
              scissor,
            );
        }
        if (!this.reflectionFootprintEnabled) return;
        scope.scissored = true;
        scope.previousTargetScissorTest = target.scissorTest;
        target.scissor.copy(scissor);
        target.scissorTest = true;
        // r186's renderer uses its canvas flag even for an offscreen target.
        // Nested shadows retain their own full-size target rectangles.
        renderer.setScissorTest(true);
      };
    }
    reflection.getUpdateBeforeType = () =>
      this._reflectionsEnabled
        ? reflection.updateBeforeType
        : NodeUpdateType.NONE;
    const nativeUpdate = reflection.updateBefore;
    reflection.updateBefore = (frame) => {
      const owner = this.bindLakeReflectionPlane(frame, node.target);
      // Returning false leaves native NodeFrame admission open for a later
      // valid lake, without issuing a capture for an unsupported surface.
      if (!owner) return false;
      const previousWorldAutoUpdate = node.target.matrixWorldAutoUpdate;
      const previousScope = captureScope;
      const scope: CaptureScope | null =
        (this.reflectionFootprintEnabled ||
          this.reflectionGrassFootprintEnabled ||
          this.reflectionCropEnabled) &&
        frame.renderer &&
        !previousScope
          ? {
              renderer: frame.renderer,
              owner,
              target: null,
              scissored: false,
              endGrassFootprint: null,
              endCroppedCapture: null,
              previousTargetScissorTest: false,
              previousRendererScissorTest: frame.renderer.getScissorTest(),
            }
          : null;
      captureScope = scope;
      node.target.matrixWorldAutoUpdate = false;
      try {
        const result = nativeUpdate.call(reflection, frame);
        owner.captured = result !== false && reflection.hasOutput;
        return result;
      } finally {
        try {
          try {
            scope?.endCroppedCapture?.();
          } finally {
            scope?.endGrassFootprint?.();
          }
        } finally {
          try {
            if (scope?.scissored && scope.target) {
              // The native resize just set this exact full-sized rectangle, even
              // after a resize. Do not restore stale pre-resize pixel dimensions.
              scope.target.scissor.set(
                0,
                0,
                scope.target.width,
                scope.target.height,
              );
              scope.target.scissorTest = scope.previousTargetScissorTest;
              scope.renderer.setScissorTest(scope.previousRendererScissorTest);
            }
          } finally {
            captureScope = previousScope;
            // The nested render must not rebuild this world-owned plane from the
            // legacy ocean-level target transform. Restore its exact owner flag.
            node.target.matrixWorldAutoUpdate = previousWorldAutoUpdate;
          }
        }
      }
    };
    node.target.rotateX(-Math.PI / 2);
    node.target.position.y = this.waterLevel;
    return node;
  }

  /**
   * Add water system to scene — adds the reflector target so the mirror plane is active.
   */
  addToScene(scene: THREE.Scene): void {
    if (this.reflection?.target) {
      scene.add(this.reflection.target);

      const reflectorObj = this.reflection.target as THREE.Object3D & {
        camera?: THREE.Camera;
      };
      if (reflectorObj.camera) {
        reflectorObj.camera.layers.set(0);
        reflectorObj.camera.layers.enable(2);
      }

      const world = this.world;
      this.reflection.target.onBeforeRender = () => {
        world.isRenderingReflection = true;
      };
      this.reflection.target.onAfterRender = () => {
        world.isRenderingReflection = false;
      };
    }
  }

  // ==========================================================================
  // PROCEDURAL TEXTURE FALLBACKS
  // ==========================================================================

  private createFlowFallback(size: number): THREE.Texture {
    const data = new Uint8Array(size * size * 4);
    let s = 77777;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size,
          ny = y / size;
        const r = Math.floor(
          (Math.sin(nx * 6.28 * 2 + ny * 3.7) * 0.5 + 0.5) * 255,
        );
        const g = Math.floor(
          (Math.cos(ny * 6.28 * 3 + nx * 2.3) * 0.5 + 0.5) * 255,
        );
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const a = (s >>> 8) & 0xff;
        const idx = (y * size + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = 128;
        data[idx + 3] = a;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Generate a seamless water normal map using FBM value noise + finite
   * differences. Produces organic ripple patterns matching a tangent-space
   * normal map (510x511).
   *
   * Target channel statistics:
   *   R: mean ~128, range ~48–206  (X derivative)
   *   G: mean ~128, range ~52–193  (Y derivative)
   *   B: mean ~250, range ~226–254 (up component)
   */
  private async createNormalMap(
    size: number,
    _freq: number,
    seed: number,
  ): Promise<THREE.Texture> {
    const TAU = Math.PI * 2;
    const ROW_BATCH = 32;

    // ---- Integer hash (Murmur-ish, deterministic) ----
    const hash = (x: number, y: number, s: number) => {
      let h = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
      h = Math.imul(h ^ (h >>> 13), 1103515245);
      h = Math.imul(h ^ (h >>> 16), 2654435769);
      return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
    };

    // ---- Smooth value noise (quintic interp for C2 continuity) ----
    const vnoise = (px: number, py: number, s: number) => {
      const ix = Math.floor(px),
        iy = Math.floor(py);
      const fx = px - ix,
        fy = py - iy;
      const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      const a = hash(ix, iy, s);
      const b = hash(ix + 1, iy, s);
      const c = hash(ix, iy + 1, s);
      const d = hash(ix + 1, iy + 1, s);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };

    // ---- FBM on torus (seamless tiling via 4D embedding) ----
    const fbm = (nx: number, ny: number) => {
      const cx = Math.cos(nx * TAU),
        sx = Math.sin(nx * TAU);
      const cy = Math.cos(ny * TAU),
        sy = Math.sin(ny * TAU);
      let val = 0,
        amp = 1,
        freq = 2;
      for (let o = 0; o < 6; o++) {
        const px = cx * freq + sy * freq * 0.618;
        const py = sx * freq + cy * freq * 0.618;
        val += vnoise(px, py, seed + o * 137) * amp;
        amp *= 0.5;
        freq *= 2.0;
      }
      return val;
    };

    // ---- Build seamless height field ----
    const heights = new Float32Array(size * size);
    for (let yBatch = 0; yBatch < size; yBatch += ROW_BATCH) {
      const yEnd = Math.min(yBatch + ROW_BATCH, size);
      for (let y = yBatch; y < yEnd; y++) {
        for (let x = 0; x < size; x++) {
          heights[y * size + x] = fbm(x / size, y / size);
        }
      }
      if (yEnd < size) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    // ---- Normal map via central finite differences ----
    const data = new Uint8Array(size * size * 4);
    const strength = 6.0;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xp = (x + 1) % size,
          xm = (x - 1 + size) % size;
        const yp = (y + 1) % size,
          ym = (y - 1 + size) % size;
        const dx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
        const dy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
        const len = Math.sqrt(dx * dx + dy * dy + 1);

        const idx = (y * size + x) * 4;
        data[idx] = Math.max(
          0,
          Math.min(255, ((-dx / len) * 127.5 + 127.5) | 0),
        );
        data[idx + 1] = Math.max(
          0,
          Math.min(255, ((-dy / len) * 127.5 + 127.5) | 0),
        );
        data[idx + 2] = Math.max(0, Math.min(255, ((1 / len) * 255) | 0));
        data[idx + 3] = 255;
      }
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  private async createFoamTexture(size: number): Promise<THREE.Texture> {
    const data = new Uint8Array(size * size * 4);
    const ROW_BATCH_SIZE = 16;

    const cells: { x: number; y: number }[] = [];
    let s = 12345;
    for (let i = 0; i < 32; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const cx = (s % 1000) / 1000;
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      cells.push({ x: cx, y: (s % 1000) / 1000 });
    }

    for (let yBatch = 0; yBatch < size; yBatch += ROW_BATCH_SIZE) {
      const yEnd = Math.min(yBatch + ROW_BATCH_SIZE, size);

      for (let y = yBatch; y < yEnd; y++) {
        for (let x = 0; x < size; x++) {
          const px = x / size,
            py = y / size;
          let d1 = 999,
            d2 = 999;

          for (const c of cells) {
            let dx = Math.abs(px - c.x),
              dy = Math.abs(py - c.y);
            if (dx > 0.5) dx = 1 - dx;
            if (dy > 0.5) dy = 1 - dy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < d1) {
              d2 = d1;
              d1 = d;
            } else if (d < d2) d2 = d;
          }

          const edge = d2 - d1;
          const foam = Math.pow(Math.max(0, 1 - edge * 8), 2);
          const noise =
            0.7 +
            (Math.sin(px * 47 + py * 31) * 0.5 +
              Math.sin(px * 97 + py * 67) * 0.25 +
              Math.sin(px * 157 + py * 113) * 0.25) *
              0.3;
          const v = Math.floor(Math.max(0, Math.min(255, foam * noise * 255)));

          const idx = (y * size + x) * 4;
          data[idx] = data[idx + 1] = data[idx + 2] = data[idx + 3] = v;
        }
      }

      if (yEnd < size) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  // ==========================================================================
  // SHADER MATERIALS
  // ==========================================================================

  /**
   * Create lake water material — follows the EXACT same pattern as the tree shader:
   * MeshStandardNodeMaterial + outputNode override + applySunShade + nightDim.
   */
  private createLakeMaterial(): MeshStandardNodeMaterial {
    const quietPond = createQuietPondUniform();
    this.quietPondUniform = quietPond;
    const illumination = new WorldIlluminationUniforms();
    const uTime = uniform(0);
    const uSunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.4));
    const uWind = uniform(1.0);
    const uDayIntensity = uniform(1.0);
    const uSunIntensity = uniform(1.0);
    const uShadeColor = uniform(new THREE.Color(...SUN_SHADE.TINT_COLOR));
    const fogTexNode = texture(fogRenderTarget.texture, screenUV);
    const uReflectionIntensity = uniform(
      this._reflectionsEnabled ? WATER.REFLECTION_INTENSITY : 0.0,
    );
    const reflectionPlaneWeight = uniform(0).onObjectUpdate((frame) => {
      if (!this.matchesLakeReflectionPlane(frame) || !frame.camera) return 0;
      return this.lakeReflectionOwners.get(frame)?.get(frame.camera)?.captured
        ? 1
        : 0;
    });
    this.lakeReflectionPlaneUniform = reflectionPlaneWeight;
    const reflectionIntensity = uReflectionIntensity.mul(reflectionPlaneWeight);

    this.uniforms = {
      illumination,
      time: uTime,
      sunDirection: uSunDir,
      windStrength: uWind,
      reflectionIntensity: uReflectionIntensity,
      dayIntensity: uDayIntensity,
      sunIntensity: uSunIntensity,
      shadeColor: uShadeColor,
    };

    const material = new MeshStandardNodeMaterial();
    material.transparent = true;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.roughness = 0.8;
    material.metalness = 0.0;
    material.fog = false;

    const nTex = this.normalTex!;
    const fTex = this.flowTex!;
    const foamTex = this.foamTex!;

    const surfaceTime = uTime
      .mul(mix(float(1), float(WATER.QUIET_SURFACE_SPEED), quietPond))
      .toVar("lakeSurfaceDetailTime");
    const normalStrength = mix(
      float(WATER.NORMAL_STRENGTH),
      float(WATER.QUIET_NORMAL_STRENGTH),
      quietPond,
    ).toVar("lakeSurfaceNormalStrength");
    const reflectionDistortion = mix(
      float(WATER.REFLECTION_DISTORTION),
      float(WATER.QUIET_REFLECTION_DISTORTION),
      quietPond,
    ).toVar("lakeSurfaceReflectionDistortion");

    const reflNode = this.reflection!;
    const worldUV0 = vec2(positionWorld.x, positionWorld.z);
    const normalOffset = texture(nTex, mul(worldUV0, float(0.02))).xy;
    const normalDistortion = sub(mul(normalOffset, float(2)), float(1));
    reflNode.uvNode = reflNode.uvNode!.add(
      mul(normalDistortion, reflectionDistortion),
    );
    if (croppedReflectionScreen.enabled) {
      // The native reflected UV has already flipped X and applied distortion.
      // Convert that full-frame coordinate to the owned cropped attachment.
      reflNode.uvNode = reflNode.uvNode
        .mul(this.reflectionCropUv.xy)
        .add(this.reflectionCropUv.zw);
    }
    this.lakeReflectionUvNode = reflNode.uvNode;
    const reflectionNode = reflNode;

    // Wind affects amplitude only — phase speed is purely from dispersion relation
    const wavePhase = (
      wp: Node<"vec3">,
      t: Node<"float">,
      _w: Node<"float">,
      wave: WaveParams,
    ) => {
      const dotDP = add(mul(wp.x, float(wave.Dx)), mul(wp.z, float(wave.Dz)));
      return add(mul(float(wave.w), dotDP), mul(float(wave.phi), t));
    };

    // VERTEX: Gerstner Displacement
    const lakePositionNode = Fn(() => {
      const pos = positionLocal.xyz;
      const wp = positionWorld;
      const shoreMask = smoothstep(
        float(0),
        float(WATER.WAVE_DAMP_DISTANCE),
        attribute<"float">("shoreDistance", "float"),
      );

      let dx: Node<"float"> = float(0),
        dy: Node<"float"> = float(0),
        dz: Node<"float"> = float(0);
      for (const wave of WAVES) {
        const phase = wavePhase(wp, uTime, uWind, wave);
        const c = cos(phase),
          s = sin(phase);
        dx = add(dx, mul(float(wave.QADx), c));
        dy = add(dy, mul(mul(float(wave.A), uWind), s));
        dz = add(dz, mul(float(wave.QADz), c));
      }

      return vec3(
        add(pos.x, mul(dx, shoreMask)),
        add(pos.y, mul(dy, shoreMask)),
        add(pos.z, mul(dz, shoreMask)),
      );
    })();
    material.positionNode = lakePositionNode;
    this.lakeWavePositionNode = lakePositionNode;

    // Linear depth is camera-axis separation, not vertical water depth. Share
    // the existing sample; ordinary water/foam keep their original clamp.
    const axisDepthGap = Fn(() => {
      const sceneDepth = linearDepth(viewportDepthTexture());
      const waterDepth = linearDepth();
      const depthDiff = sub(sceneDepth, waterDepth);
      return mul(depthDiff, sub(cameraFar, cameraNear));
    })().toVar("lakeAxisDepthGap");
    const gpuShoreDist = clamp(axisDepthGap, float(0), float(WATER.MAX_DEPTH));
    const pondRayLength = Fn((_: readonly [], builder: NodeBuilder) => {
      // Perspective depth belongs to a screen ray. Do not divide by N.V:
      // surface tilt changes neither the pixel's ray nor its depth encoding.
      // NodeBuilder owns the active camera at runtime; the installed upstream
      // declarations omit it, so narrow the runtime field without an any cast.
      const camera: unknown = Reflect.get(builder, "camera");
      const rayScale =
        camera instanceof THREE.PerspectiveCamera
          ? length(positionView).div(positionView.z.negate().max(0.0001))
          : float(1);
      return axisDepthGap.max(0).mul(rayScale).clamp(0, WATER.MAX_DEPTH);
    })().toVar("compactPondRayLength");
    const pondTransmittance = exp2(
      pondRayLength.div(-WATER.QUIET_HALF_TRANSMITTANCE_METRES),
    ).toVar("compactPondTransmittance");

    const distToCam = length(sub(cameraPosition, positionWorld));
    const waterOpColorLerp = clamp(
      sub(float(1), div(distToCam, float(WATER.COLOR_DIST_FADE))),
      float(0.01),
      float(1.0),
    );

    // OPACITY (feeds into PBR → output.a, same as tree pattern)
    material.opacityNode = Fn(() => {
      const shoreDist = gpuShoreDist;
      const opDepth = pow(
        saturate(sub(float(1), div(shoreDist, float(WATER.OP_DEPTH_SCALE)))),
        float(WATER.OP_DEPTH_FALLOFF),
      );
      return select(
        quietPond.greaterThan(0),
        float(1).sub(pondTransmittance),
        sub(float(1), opDepth),
      );
    })();

    // OUTPUT: Ordinary lakes retain PBR alpha; the quiet pond composes surface
    // radiance and transmitted background with its own straight-alpha coverage.
    material.outputNode = Fn(() => {
      const pbrOut = output;
      const wp = positionWorld;
      const shoreDist = gpuShoreDist;
      const wUV = vec2(wp.x, wp.z);
      // Append this derivative to the unconditional fragment stack, before any
      // pond selection. Reuse the existing depth sample; nonpositive gaps have
      // no coverage, with a one-pixel feather at opaque shore/foreground edges.
      const pondDepthPixelWidth = fwidth(axisDepthGap).toVar(
        "compactPondDepthPixelWidth",
      );
      const pondCoverage = smoothstep(
        float(0),
        max(pondDepthPixelWidth, float(0.001)),
        axisDepthGap,
      ).toVar("compactPondCoverage");

      // --- Cosine gradient water colour ---
      const colorDepth = pow(
        saturate(sub(float(1), div(shoreDist, float(WATER.COLOR_DEPTH_SCALE)))),
        float(WATER.COLOR_DEPTH_FALLOFF),
      );
      const colorLerp = mul(colorDepth, waterOpColorLerp);

      const TAU = Math.PI * 2;
      const [pR, pG, pB] = WATER.COS_PHASES;
      const [aR, aG, aB] = WATER.COS_AMPLITUDES;
      const [fR, fG, fB] = WATER.COS_FREQUENCIES;
      const [oR, oG, oB] = WATER.COS_OFFSETS;
      const cosR = clamp(
        add(
          float(oR),
          add(
            mul(
              float(aR * 0.5),
              cos(add(mul(colorLerp, float(TAU * fR)), float(TAU * pR))),
            ),
            float(0.5),
          ),
        ),
        float(0),
        float(1),
      );
      const cosG = clamp(
        add(
          float(oG),
          add(
            mul(
              float(aG * 0.5),
              cos(add(mul(colorLerp, float(TAU * fG)), float(TAU * pG))),
            ),
            float(0.5),
          ),
        ),
        float(0),
        float(1),
      );
      const cosB = clamp(
        add(
          float(oB),
          add(
            mul(
              float(aB * 0.5),
              cos(add(mul(colorLerp, float(TAU * fB)), float(TAU * pB))),
            ),
            float(0.5),
          ),
        ),
        float(0),
        float(1),
      );
      // A constant source tint lets the real bottom, through transmittance,
      // supply shallow colour. Only the compact pond bypasses the historical
      // camera-distance/cosine tint. Framebuffer transmission is neutral,
      // not wavelength-dependent absorption or screen-space refraction.
      const pondBodyColor = vec3(...WATER.QUIET_DEEP_TINT).toVar(
        "compactPondBodyColor",
      );
      const waterColor = select(
        quietPond.greaterThan(0),
        pondBodyColor,
        vec3(cosR, cosG, cosB),
      );

      // --- Flow-mapped 4-scroll normal noise (FlowUVW two-phase crossfade) ---
      const flowSampleUV = mul(wUV, float(WATER.FLOW_UV_SCALE));
      const flowSample = texture(fTex, flowSampleUV);
      const flowVec = mul(
        sub(mul(flowSample.rg, float(2)), float(1)),
        float(WATER.FLOW_STRENGTH),
      );
      const flowTime = add(
        mul(surfaceTime, float(WATER.FLOW_SPEED)),
        flowSample.a,
      );

      const progressA = fract(flowTime);
      const progressB = fract(add(flowTime, float(0.5)));
      const weightA = sub(
        float(1),
        abs(sub(mul(progressA, float(2)), float(1))),
      );
      const weightB = sub(
        float(1),
        abs(sub(mul(progressB, float(2)), float(1))),
      );

      const jumpVec = vec2(
        float(WATER.FLOW_JUMP[0]),
        float(WATER.FLOW_JUMP[1]),
      );

      // Phase A: flow-distorted base UV
      const baseA = add(
        mul(
          sub(wUV, mul(flowVec, add(progressA, float(WATER.FLOW_OFFSET)))),
          float(5),
        ),
        mul(sub(flowTime, progressA), jumpVec),
      );
      // Phase B: offset by 0.5 to avoid sampling same location
      const baseB = add(
        add(
          mul(
            sub(wUV, mul(flowVec, add(progressB, float(WATER.FLOW_OFFSET)))),
            float(5),
          ),
          float(0.5),
        ),
        mul(sub(flowTime, progressB), jumpVec),
      );

      // Phase A: scroll layers 0 + 2 (large + ultra-fine scale)
      const nUV0 = add(
        div(baseA, float(103)),
        vec2(div(surfaceTime, float(17)), div(surfaceTime, float(29))),
      );
      const nUV2 = add(
        vec2(div(baseA.x, float(8907)), div(baseA.y, float(9803))),
        vec2(div(surfaceTime, float(101)), div(surfaceTime, float(97))),
      );
      // Phase B: scroll layers 1 + 3 (large + medium-fine scale)
      const nUV1 = add(
        div(baseB, float(107)),
        vec2(
          div(surfaceTime, float(19)),
          mul(div(surfaceTime, float(31)), float(-1)),
        ),
      );
      const nUV3 = add(
        vec2(div(baseB.x, float(1091)), div(baseB.y, float(1027))),
        vec2(
          mul(div(surfaceTime, float(109)), float(-1)),
          div(surfaceTime, float(113)),
        ),
      );

      const noiseSum = mul(
        add(
          mul(add(texture(nTex, nUV0), texture(nTex, nUV2)), weightA),
          mul(add(texture(nTex, nUV1), texture(nTex, nUV3)), weightB),
        ),
        float(2),
      );
      const noise = sub(mul(noiseSum, float(0.5)), float(1));
      const surfaceNormal = normalize(
        vec3(
          mul(noise.x, normalStrength),
          noise.z,
          mul(noise.y, normalStrength),
        ),
      );

      // --- Gerstner wave normals (for foam crest detection) ---
      const shoreMask = smoothstep(
        float(0),
        float(WATER.WAVE_DAMP_DISTANCE),
        shoreDist,
      );
      let nx: Node<"float"> = float(0),
        nz: Node<"float"> = float(0);
      for (const wave of WAVES) {
        const c = cos(wavePhase(wp, uTime, uWind, wave));
        nx = add(nx, mul(float(wave.wADx), c));
        nz = add(nz, mul(float(wave.wADz), c));
      }
      nx = mul(nx, shoreMask);
      nz = mul(nz, shoreMask);

      // --- Phong sun lighting ---
      const V = normalize(sub(cameraPosition, wp));
      const L = normalize(uSunDir);
      const lightColor = vec3(1, 1, 1);
      const negL = mul(L, float(-1));
      const NdotL = dot(surfaceNormal, L);
      const reflectDir = normalize(
        add(negL, mul(surfaceNormal, mul(float(2), NdotL))),
      );
      const specDir = max(dot(V, reflectDir), float(0));
      const specularLight = mul(
        lightColor,
        mul(
          pow(specDir, float(WATER.SPECULAR_SHININESS)),
          float(WATER.SPECULAR_STRENGTH),
        ),
      );
      const diffuseLight = mul(
        lightColor,
        mul(max(NdotL, float(0)), float(WATER.DIFFUSE_STRENGTH)),
      );

      // --- Reflection + Fresnel ---
      const reflectionSample = reflectionNode.xyz;
      const theta = max(dot(V, surfaceNormal), float(0));
      const reflectance = add(
        float(WATER.RF0),
        mul(float(1 - WATER.RF0), pow(sub(float(1), theta), float(5))),
      );

      // --- Scatter ---
      const scatter = mul(waterColor, max(dot(surfaceNormal, V), float(0)));

      // --- Foam ---
      const shoreFoam = smoothstep(
        float(WATER.FOAM_SHORE_DISTANCE),
        float(0),
        shoreDist,
      );
      const crestFoam = smoothstep(
        float(WATER.FOAM_CREST_MIN),
        float(WATER.FOAM_CREST_MAX),
        mul(length(vec2(nx, nz)), shoreMask),
      );
      const foamUV = mul(
        vec2(
          add(wUV.x, mul(uTime, float(WATER.FOAM_SCROLL_X))),
          add(wUV.y, mul(uTime, float(WATER.FOAM_SCROLL_Y))),
        ),
        float(WATER.FOAM_SCALE),
      );
      const foamPattern = texture(foamTex, foamUV).r;
      const foamIntensity = mul(
        max(shoreFoam, mul(crestFoam, float(WATER.FOAM_CREST_MULTIPLIER))),
        foamPattern,
      );
      // Sheltered freshwater ponds have no surf. Keep existing lake/ocean foam
      // unchanged and remove the broad screen-depth white halo only for the
      // explicitly tagged compact elevated mesh. One scalar, no new textures.
      const foamOpacity = clamp(
        foamIntensity,
        float(0),
        float(WATER.FOAM_MAX_OPACITY),
      ).mul(float(1).sub(quietPond));

      // --- Composite ---
      const diffusePart = add(mul(diffuseLight, float(0.3)), scatter);
      const reflectPart = add(
        add(vec3(0.1, 0.1, 0.1), mul(reflectionSample, float(0.9))),
        mul(reflectionSample, specularLight),
      );
      const albedo = mix(
        diffusePart,
        mul(reflectPart, reflectionIntensity),
        reflectance,
      );
      let color: Node<"vec3"> = mix(albedo, waterColor, float(0.8));

      // Compact pond only: a direct highlight must not disappear with the
      // planar capture, or be multiplied by its sampled RGB. Keep the legacy
      // Fresnel/body mix for this isolated Phong-shaped correction, not a PBR
      // claim. The cosine makes the horizon limit continuous. Environment uses
      // the same light for the moon, so intensity/nightDim alone is not a sun
      // gate. Do not apply this daylight gate to the existing lake expression.
      const pondNdotV = dot(surfaceNormal, V).toVar("compactPondNdotV");
      const pondFront = select(pondNdotV.greaterThan(0), float(1), float(0));
      const pondDay = clamp(uDayIntensity, float(0), float(1)).toVar(
        "compactPondDaylight",
      );
      const pondDirect = specularLight
        .mul(clamp(NdotL, float(0), float(1)))
        .mul(pondDay)
        .mul(div(clamp(uSunIntensity, float(0), float(2)), float(2)))
        .mul(pondFront)
        .toVar("compactPondLegacyDirectLight");
      const pondReflectionSample = reflectionSample.toVar(
        "compactPondReflectionSample",
      );
      // Air/water dielectric Fresnel, independent of optical thickness and of
      // whether this draw owns a valid planar capture. Retain ordinary water's
      // historical art Fresnel above; this split belongs only to the quiet pond.
      const pondF0 =
        ((WATER.QUIET_REFRACTIVE_INDEX - 1) /
          (WATER.QUIET_REFRACTIVE_INDEX + 1)) **
        2;
      const pondFresnel = float(pondF0)
        .add(float(1 - pondF0).mul(float(1).sub(pondNdotV.clamp(0, 1)).pow(5)))
        .toVar("compactPondFresnel");
      const pondOpacity = float(1)
        .sub(float(1).sub(pondFresnel).mul(pondTransmittance))
        .toVar("compactPondCompositeOpacity");
      const pondReflectionWeight = reflectionIntensity
        .clamp(0, 1)
        .toVar("compactPondCaptureWeight");
      const composePond = (
        body: Node<"vec3">,
        ambient: Node<"vec3">,
        direct: Node<"vec3">,
      ): Node<"vec3"> => {
        // Missing/disabled captures use the existing ambient approximation, not
        // stale planar radiance or black. This is not a new environment map.
        const reflected = mix(
          ambient,
          pondReflectionSample,
          pondReflectionWeight,
        );
        const premultiplied = body
          .mul(float(1).sub(pondFresnel))
          .mul(float(1).sub(pondTransmittance))
          .add(reflected.add(direct).mul(pondFresnel));
        // NormalBlending is straight alpha. Dividing here makes the framebuffer
        // receive P + (1-A)*destination, rather than attenuating reflection by T.
        return premultiplied.div(pondOpacity.max(0.000001));
      };

      // Foam
      color = mix(
        color,
        vec3(WATER.FOAM_COLOR.r, WATER.FOAM_COLOR.g, WATER.FOAM_COLOR.b),
        foamOpacity,
      );

      // --- applySunShade (same as tree shader) ---
      color = applySunShade(color, uDayIntensity, uShadeColor.rgb);

      // --- nightDim (same as tree shader: mix(NIGHT.BRIGHTNESS, 1.0, dayFactor)) ---
      const dayFactor = div(clamp(uSunIntensity, float(0), float(2)), float(2));
      const nightDim = mix(float(NIGHT.BRIGHTNESS), float(1.0), dayFactor);
      color = mul(color, nightDim);
      const pondLegacyBody = applySunShade(
        mix(diffusePart, waterColor, float(0.8)),
        uDayIntensity,
        uShadeColor.rgb,
      ).mul(nightDim);
      const pondLegacyAmbient = applySunShade(
        vec3(0.1, 0.1, 0.1),
        uDayIntensity,
        uShadeColor.rgb,
      ).mul(nightDim);
      const pondLegacySource = composePond(
        pondLegacyBody,
        pondLegacyAmbient,
        applySunShade(pondDirect, uDayIntensity, uShadeColor.rgb).mul(nightDim),
      ).toVar("compactPondLegacySource");
      color = select(quietPond.greaterThan(0), pondLegacySource, color).toVar(
        "lakeSelectedLegacyLighting",
      );

      // Opt-in custom radiometry: light the dominant depth/scatter contribution,
      // not merely the old small white Phong term. Reuse existing normal samples.
      // Planar reflection is already radiance and is NOT multiplied by diffuse
      // fill. Keep its existing Fresnel/strength/mix; no new reflection capture.
      const worldDiffuse = illumination.diffuse(waterColor, surfaceNormal);
      const worldScatter = mul(
        worldDiffuse,
        max(dot(surfaceNormal, V), float(0)),
      );
      const worldKey = normalize(illumination.keyDirection);
      const worldNdotL = dot(surfaceNormal, worldKey);
      const worldReflectDir = normalize(
        add(
          mul(worldKey, float(-1)),
          mul(surfaceNormal, mul(float(2), worldNdotL)),
        ),
      );
      // Retained Phong-shaped approximation, not an energy-conserving BRDF:
      // actual key direction/color and no below-surface direct highlight.
      const worldSpecular = mul(
        illumination.keyColor.rgb,
        mul(
          pow(
            max(dot(V, worldReflectDir), float(0)),
            float(WATER.SPECULAR_SHININESS),
          ),
          mul(float(WATER.SPECULAR_STRENGTH), max(worldNdotL, float(0))),
        ),
      );
      const worldReflect = add(
        add(
          mul(illumination.fillRadiance(), float(0.1)),
          mul(reflectionSample, float(0.9)),
        ),
        mul(reflectionSample, worldSpecular),
      );
      let worldColor = mix(
        mix(
          add(
            mul(worldDiffuse, float(0.3 * WATER.DIFFUSE_STRENGTH)),
            worldScatter,
          ),
          mul(worldReflect, reflectionIntensity),
          reflectance,
        ),
        worldDiffuse,
        float(0.8),
      );
      // worldSpecular already contains the actual key irradiance and N.L.
      // Apply neither again: only the shared daylight/front-side gates remain.
      const pondWorldDirect = worldSpecular
        .mul(pondDay)
        .mul(pondFront)
        .toVar("compactPondWorldDirectLight");
      const pondWorldSource = composePond(
        mix(
          add(
            mul(worldDiffuse, float(0.3 * WATER.DIFFUSE_STRENGTH)),
            worldScatter,
          ),
          worldDiffuse,
          float(0.8),
        ),
        illumination.fillRadiance(),
        pondWorldDirect,
      ).toVar("compactPondWorldSource");
      worldColor = mix(
        worldColor,
        illumination.diffuse(
          vec3(WATER.FOAM_COLOR.r, WATER.FOAM_COLOR.g, WATER.FOAM_COLOR.b),
          surfaceNormal,
        ),
        foamOpacity,
      );
      worldColor = select(
        quietPond.greaterThan(0),
        pondWorldSource,
        worldColor,
      ).toVar("lakeSelectedWorldLighting");
      color = illumination.select(color, worldColor);

      // --- Fog ---
      const toCam = sub(cameraPosition, wp);
      const fogDistSq = dot(toCam, toCam);
      const fogFactor = smoothstep(
        float(FOG_NEAR_SQ),
        float(FOG_FAR_SQ),
        fogDistSq,
      );
      const foggedColor = mix(color, fogTexNode.rgb, fogFactor);
      // The opaque destination is already fogged. Fogging straight source RGB
      // with the same factor composes correctly; increasing its alpha to one
      // would apply fog twice to the transmitted background.
      const foggedAlpha = select(
        quietPond.greaterThan(0),
        pondCoverage.mul(pondOpacity),
        mix(pbrOut.a, float(1.0), fogFactor),
      );

      return vec4(foggedColor, foggedAlpha);
    })();

    return material;
  }

  /**
   * Create ocean water material — no planar reflections,
   * deeper blue tint, and larger wave amplitude for world boundary water.
   * Uses MeshBasicNodeMaterial with ALL computation in outputNode (no PBR).
   */
  private createOceanMaterial(): MeshStandardNodeMaterial {
    const illumination = new WorldIlluminationUniforms();
    const uTime = uniform(0);
    const uSunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.4));
    const uWind = uniform(1.2);
    const uDayIntensity = uniform(1.0);
    const uSunIntensity = uniform(1.0);
    const uShadeColor = uniform(new THREE.Color(...SUN_SHADE.TINT_COLOR));
    const uReflectionIntensity = uniform(0);
    const fogTexNode = texture(fogRenderTarget.texture, screenUV);

    this.oceanUniforms = {
      illumination,
      time: uTime,
      sunDirection: uSunDir,
      windStrength: uWind,
      reflectionIntensity: uReflectionIntensity,
      dayIntensity: uDayIntensity,
      sunIntensity: uSunIntensity,
      shadeColor: uShadeColor,
    };

    const material = new MeshStandardNodeMaterial();
    material.transparent = true;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.roughness = 0.8;
    material.metalness = 0.0;
    material.fog = false;

    const nTex = this.normalTex!;
    const fTex = this.flowTex!;
    const foamTex = this.foamTex!;
    const coast = (this.coastalBathymetry ??= new CoastalBathymetryOwner());
    // Reuse one fragment sample and one optical parameter across both branches.
    // Vertex displacement and crest normals retain their original attribute.
    const opticalShoreDistance = createCoastalWaterOpticalDistanceNode(
      attribute<"float">("shoreDistance", "float"),
      coast.signedDepth,
      positionWorld.y.sub(coast.seaLevel),
      coast.enabled,
    );

    const wavePhase = (
      wp: Node<"vec3">,
      t: Node<"float">,
      _w: Node<"float">,
      wave: WaveParams,
    ) => {
      const dotDP = add(mul(wp.x, float(wave.Dx)), mul(wp.z, float(wave.Dz)));
      return add(mul(float(wave.w), dotDP), mul(float(wave.phi), t));
    };

    // VERTEX: Gerstner Displacement (1.3x larger for ocean)
    material.positionNode = Fn(() => {
      const pos = positionLocal.xyz;
      const wp = positionWorld;
      const shoreMask = smoothstep(
        float(0),
        float(6),
        attribute<"float">("shoreDistance", "float"),
      );

      let dx: Node<"float"> = float(0),
        dy: Node<"float"> = float(0),
        dz: Node<"float"> = float(0);
      for (const wave of WAVES) {
        const phase = wavePhase(wp, uTime, uWind, wave);
        const c = cos(phase),
          s = sin(phase);
        dx = add(dx, mul(float(wave.QADx * 1.3), c));
        dy = add(dy, mul(mul(float(wave.A * 1.3), uWind), s));
        dz = add(dz, mul(float(wave.QADz * 1.3), c));
      }

      return vec3(
        add(pos.x, mul(dx, shoreMask)),
        add(pos.y, mul(dy, shoreMask)),
        add(pos.z, mul(dz, shoreMask)),
      );
    })();

    // OPACITY (feeds into PBR → output.a)
    material.opacityNode = Fn(() => {
      const shoreDist = opticalShoreDistance;
      const edgeFade = smoothstep(float(0), float(0.4), shoreDist);
      const depthFade = smoothstep(float(0.4), float(8.0), shoreDist);
      const depthOpacity = mix(float(0.3), float(0.85), depthFade);
      const V0 = normalize(sub(cameraPosition, positionWorld));
      const NdotV0 = max(dot(vec3(0, 1, 0), V0), float(0));
      const fresnelOpacity = mix(
        float(0.9),
        float(1.0),
        pow(sub(float(1), NdotV0), float(3)),
      );
      const shallowOpacity = mul(mul(edgeFade, depthOpacity), fresnelOpacity);
      // Offshore water must not expose the finite terrain seabed/sky boundary.
      // Retain the existing shallow expression, then fade to exact opacity 1
      // at optical parameter >= 8 for every view angle. The shared field blends
      // back to the exact legacy parameter offshore, independently of wave Y.
      return mix(shallowOpacity, float(1), depthFade);
    })();

    // OUTPUT: Same pattern as tree shader — pbrOut = output, replace RGB, keep pbrOut.a
    material.outputNode = Fn(() => {
      const pbrOut = output;
      const wp = positionWorld;
      const shoreDist = attribute<"float">("shoreDistance", "float");
      const shoreMask = smoothstep(float(0), float(6), shoreDist);
      const wUV = vec2(wp.x, wp.z);

      // Keep the established ocean tint. Local depth controls transmission;
      // feeding its nearshore band into this much deeper color curve paints
      // a bright strip along steep banks instead of revealing the substrate.
      const colorDepth = pow(
        saturate(sub(float(1), div(shoreDist, float(80)))),
        float(4),
      );
      const TAU = Math.PI * 2;
      const [pR, pG, pB] = WATER.COS_PHASES;
      const [aR, aG, aB] = WATER.COS_AMPLITUDES;
      const [fR, fG, fB] = WATER.COS_FREQUENCIES;
      const [oR, oG, oB] = WATER.COS_OFFSETS;
      const cosR = clamp(
        add(
          float(oR),
          add(
            mul(
              float(aR * 0.5),
              cos(add(mul(colorDepth, float(TAU * fR)), float(TAU * pR))),
            ),
            float(0.5),
          ),
        ),
        float(0),
        float(1),
      );
      const cosG = clamp(
        add(
          float(oG),
          add(
            mul(
              float(aG * 0.5),
              cos(add(mul(colorDepth, float(TAU * fG)), float(TAU * pG))),
            ),
            float(0.5),
          ),
        ),
        float(0),
        float(1),
      );
      const cosB = clamp(
        add(
          float(oB),
          add(
            mul(
              float(aB * 0.5),
              cos(add(mul(colorDepth, float(TAU * fB)), float(TAU * pB))),
            ),
            float(0.5),
          ),
        ),
        float(0),
        float(1),
      );
      const waterColor = vec3(cosR, cosG, cosB);

      // --- Flow-mapped 4-scroll normal noise (FlowUVW two-phase crossfade) ---
      const flowSampleUV = mul(wUV, float(WATER.FLOW_UV_SCALE));
      const flowSample = texture(fTex, flowSampleUV);
      const flowVec = mul(
        sub(mul(flowSample.rg, float(2)), float(1)),
        float(WATER.FLOW_STRENGTH),
      );
      const flowTime = add(mul(uTime, float(WATER.FLOW_SPEED)), flowSample.a);

      const progressA = fract(flowTime);
      const progressB = fract(add(flowTime, float(0.5)));
      const weightA = sub(
        float(1),
        abs(sub(mul(progressA, float(2)), float(1))),
      );
      const weightB = sub(
        float(1),
        abs(sub(mul(progressB, float(2)), float(1))),
      );

      const jumpVec = vec2(
        float(WATER.FLOW_JUMP[0]),
        float(WATER.FLOW_JUMP[1]),
      );

      const baseA = add(
        mul(
          sub(wUV, mul(flowVec, add(progressA, float(WATER.FLOW_OFFSET)))),
          float(5),
        ),
        mul(sub(flowTime, progressA), jumpVec),
      );
      const baseB = add(
        add(
          mul(
            sub(wUV, mul(flowVec, add(progressB, float(WATER.FLOW_OFFSET)))),
            float(5),
          ),
          float(0.5),
        ),
        mul(sub(flowTime, progressB), jumpVec),
      );

      const nUV0 = add(
        div(baseA, float(103)),
        vec2(div(uTime, float(17)), div(uTime, float(29))),
      );
      const nUV2 = add(
        vec2(div(baseA.x, float(8907)), div(baseA.y, float(9803))),
        vec2(div(uTime, float(101)), div(uTime, float(97))),
      );
      const nUV1 = add(
        div(baseB, float(107)),
        vec2(div(uTime, float(19)), mul(div(uTime, float(31)), float(-1))),
      );
      const nUV3 = add(
        vec2(div(baseB.x, float(1091)), div(baseB.y, float(1027))),
        vec2(mul(div(uTime, float(109)), float(-1)), div(uTime, float(113))),
      );

      const noiseSum = mul(
        add(
          mul(add(texture(nTex, nUV0), texture(nTex, nUV2)), weightA),
          mul(add(texture(nTex, nUV1), texture(nTex, nUV3)), weightB),
        ),
        float(2),
      );
      const noise = sub(mul(noiseSum, float(0.5)), float(1));
      const surfaceNormal = normalize(
        vec3(
          mul(noise.x, float(WATER.NORMAL_STRENGTH)),
          noise.z,
          mul(noise.y, float(WATER.NORMAL_STRENGTH)),
        ),
      );

      // --- Gerstner wave normals for foam ---
      let nx: Node<"float"> = float(0),
        nz: Node<"float"> = float(0);
      for (const wave of WAVES) {
        const c = cos(wavePhase(wp, uTime, uWind, wave));
        nx = add(nx, mul(float(wave.wADx), c));
        nz = add(nz, mul(float(wave.wADz), c));
      }
      nx = mul(nx, shoreMask);
      nz = mul(nz, shoreMask);

      // --- Phong lighting ---
      const V = normalize(sub(cameraPosition, wp));
      const L = normalize(uSunDir);
      const negL = mul(L, float(-1));
      const NdotL = dot(surfaceNormal, L);
      const reflectDir = normalize(
        add(negL, mul(surfaceNormal, mul(float(2), NdotL))),
      );
      const specDir = max(dot(V, reflectDir), float(0));
      const specularLight = mul(
        pow(specDir, float(WATER.SPECULAR_SHININESS)),
        float(WATER.SPECULAR_STRENGTH),
      );
      const diffuseLight = mul(
        max(NdotL, float(0)),
        float(WATER.DIFFUSE_STRENGTH),
      );

      // --- Scatter ---
      const scatter = mul(waterColor, max(dot(surfaceNormal, V), float(0)));

      // --- Composite (no reflection for ocean) ---
      const albedo = add(
        mul(vec3(1, 1, 1), mul(diffuseLight, float(0.3))),
        scatter,
      );
      let color: Node<"vec3"> = mix(albedo, waterColor, float(0.8));

      // Fresnel sky approximation
      const NdotV = max(dot(surfaceNormal, V), float(0));
      const fresnelSky = pow(sub(float(1), NdotV), float(4));
      color = add(
        color,
        mul(vec3(0.38, 0.42, 0.68), mul(fresnelSky, float(0.2))),
      );

      // --- Foam (more whitecaps on ocean) ---
      const crestFoam = smoothstep(
        float(0.12),
        float(0.35),
        mul(length(vec2(nx, nz)), shoreMask),
      );
      const foamUV = mul(
        vec2(
          add(wUV.x, mul(uTime, float(0.025))),
          add(wUV.y, mul(uTime, float(0.02))),
        ),
        float(0.08),
      );
      const foamPattern = texture(foamTex, foamUV).r;
      const foamIntensity = mul(crestFoam, foamPattern);
      color = mix(
        color,
        vec3(0.9, 0.91, 0.96),
        clamp(foamIntensity, float(0), float(0.75)),
      );

      // --- applySunShade (same as tree shader) ---
      color = applySunShade(color, uDayIntensity, uShadeColor.rgb);

      // --- nightDim (same as tree shader) ---
      const dayFactor = div(clamp(uSunIntensity, float(0), float(2)), float(2));
      const nightDim = mix(float(NIGHT.BRIGHTNESS), float(1.0), dayFactor);
      color = mul(color, nightDim);

      // Same diffuse convention as lake/trees, including depth color and foam.
      // Ocean has no environment/reflection sampler: replace its fixed blue
      // Fresnel surrogate with isotropic fill radiance, not a PBR/IBL claim.
      const worldDiffuse = illumination.diffuse(waterColor, surfaceNormal);
      const worldScatter = mul(
        worldDiffuse,
        max(dot(surfaceNormal, V), float(0)),
      );
      let worldColor = mix(
        add(
          mul(worldDiffuse, float(0.3 * WATER.DIFFUSE_STRENGTH)),
          worldScatter,
        ),
        worldDiffuse,
        float(0.8),
      );
      worldColor = add(
        worldColor,
        mul(illumination.fillRadiance(), mul(fresnelSky, float(0.2))),
      );
      worldColor = mix(
        worldColor,
        illumination.diffuse(vec3(0.9, 0.91, 0.96), surfaceNormal),
        clamp(foamIntensity, float(0), float(0.75)),
      );
      color = illumination.select(color, worldColor);

      // --- Fog ---
      const toCam = sub(cameraPosition, wp);
      const fogDistSq = dot(toCam, toCam);
      const fogFactor = smoothstep(
        float(FOG_NEAR_SQ),
        float(FOG_FAR_SQ),
        fogDistSq,
      );
      const foggedColor = mix(color, fogTexNode.rgb, fogFactor);
      const foggedAlpha = mix(pbrOut.a, float(1.0), fogFactor);

      return vec4(foggedColor, foggedAlpha);
    })();

    return material;
  }

  // ==========================================================================
  // MESH GENERATION
  // ==========================================================================

  /**
   * Generate a water mesh for a terrain tile
   * @param tile The terrain tile
   * @param waterThreshold Water level threshold
   * @param tileSize Size of the tile
   * @param getHeightAt Optional height function for accurate shoreline detection
   * @param waterType Type of water body - "lake" for reflective water, "ocean" for non-reflective
   */
  generateWaterMesh(
    tile: TerrainTile,
    waterThreshold: number,
    tileSize: number,
    getHeightAt?: (worldX: number, worldZ: number) => number,
    waterType: WaterBodyType = "lake",
  ): THREE.Mesh | null {
    this.waterLevel = waterThreshold;

    if (!getHeightAt) {
      const mesh = this.createFallbackMesh(
        tile,
        waterThreshold,
        tileSize,
        waterType,
      );
      this.registerWaterMesh(mesh);
      return mesh;
    }

    // Calculate LOD based on tile distance from camera
    const originX = tile.x * tileSize;
    const originZ = tile.z * tileSize;
    const tileCenterX = originX;
    const tileCenterZ = originZ;

    // Get camera position for LOD calculation
    let resolution = WATER_LOD.HIGH_RESOLUTION;
    const camera = this.world.camera;
    if (camera) {
      const cameraPos = camera.position;
      const dx = tileCenterX - cameraPos.x;
      const dz = tileCenterZ - cameraPos.z;
      const distToCamera = Math.sqrt(dx * dx + dz * dz);

      if (distToCamera > WATER_LOD.MEDIUM_DISTANCE) {
        resolution = WATER_LOD.LOW_RESOLUTION;
      } else if (distToCamera > WATER_LOD.HIGH_DISTANCE) {
        resolution = WATER_LOD.MEDIUM_RESOLUTION;
      }
    }

    const heights: number[][] = [];
    const underwater: boolean[][] = [];
    for (let i = 0; i <= resolution; i++) {
      heights[i] = [];
      underwater[i] = [];
      for (let j = 0; j <= resolution; j++) {
        const wx = originX + (i / resolution - 0.5) * tileSize;
        const wz = originZ + (j / resolution - 0.5) * tileSize;
        heights[i][j] = getHeightAt(wx, wz);
        underwater[i][j] = heights[i][j] < waterThreshold;
      }
    }

    // Approximate shore distance per vertex via Chamfer distance transform.
    // Used for vertex wave damping to prevent terrain clipping at shorelines.
    const shoreDist: number[][] = [];
    const cellSize = tileSize / resolution;
    const DIAG = cellSize * 1.414;

    for (let i = 0; i <= resolution; i++) {
      shoreDist[i] = [];
      for (let j = 0; j <= resolution; j++) {
        shoreDist[i][j] = underwater[i][j] ? WATER.MAX_DEPTH : 0;
      }
    }

    // Forward pass (top-left → bottom-right)
    for (let i = 0; i <= resolution; i++) {
      for (let j = 0; j <= resolution; j++) {
        const d = shoreDist[i];
        if (i > 0) d[j] = Math.min(d[j], shoreDist[i - 1][j] + cellSize);
        if (j > 0) d[j] = Math.min(d[j], d[j - 1] + cellSize);
        if (i > 0 && j > 0)
          d[j] = Math.min(d[j], shoreDist[i - 1][j - 1] + DIAG);
        if (i > 0 && j < resolution)
          d[j] = Math.min(d[j], shoreDist[i - 1][j + 1] + DIAG);
      }
    }

    // Backward pass (bottom-right → top-left)
    for (let i = resolution; i >= 0; i--) {
      for (let j = resolution; j >= 0; j--) {
        const d = shoreDist[i];
        if (i < resolution)
          d[j] = Math.min(d[j], shoreDist[i + 1][j] + cellSize);
        if (j < resolution) d[j] = Math.min(d[j], d[j + 1] + cellSize);
        if (i < resolution && j < resolution)
          d[j] = Math.min(d[j], shoreDist[i + 1][j + 1] + DIAG);
        if (i < resolution && j > 0)
          d[j] = Math.min(d[j], shoreDist[i + 1][j - 1] + DIAG);
      }
    }

    const verts: number[] = [];
    const uvs: number[] = [];
    const shores: number[] = [];
    const indices: number[] = [];
    const stride = resolution + 1;
    const vertMap = new Map<number, number>();
    let idx = 0;

    for (let i = 0; i < resolution; i++) {
      for (let j = 0; j < resolution; j++) {
        const h = [
          heights[i][j],
          heights[i + 1][j],
          heights[i][j + 1],
          heights[i + 1][j + 1],
        ];
        if (!h.some((v) => v < waterThreshold)) continue;

        const corners = [
          [i, j],
          [i + 1, j],
          [i, j + 1],
          [i + 1, j + 1],
        ];
        const quad: number[] = [];

        for (const [ci, cj] of corners) {
          const key = ci * stride + cj;
          if (!vertMap.has(key)) {
            verts.push(
              (ci / resolution - 0.5) * tileSize,
              0,
              (cj / resolution - 0.5) * tileSize,
            );
            uvs.push(ci / resolution, cj / resolution);
            shores.push(shoreDist[ci][cj]);
            vertMap.set(key, idx++);
          }
          quad.push(vertMap.get(key)!);
        }
        indices.push(quad[0], quad[2], quad[1], quad[1], quad[2], quad[3]);
      }
    }

    if (verts.length === 0) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setAttribute(
      "shoreDistance",
      new THREE.Float32BufferAttribute(shores, 1),
    );
    geom.setIndex(indices);

    const normals = new Float32Array(verts.length);
    for (let i = 0; i < normals.length; i += 3) {
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
    geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));

    const mesh = this.createMesh(geom, tile, waterThreshold, waterType);
    this.registerWaterMesh(mesh);
    return mesh;
  }

  private createFallbackMesh(
    tile: TerrainTile,
    waterThreshold: number,
    tileSize: number,
    waterType: WaterBodyType = "lake",
  ): THREE.Mesh {
    // Calculate LOD resolution based on tile distance from camera
    let resolution = 32;
    const camera = this.world.camera;
    if (camera) {
      const tileCenterX = tile.x * tileSize;
      const tileCenterZ = tile.z * tileSize;
      const dx = tileCenterX - camera.position.x;
      const dz = tileCenterZ - camera.position.z;
      const distToCamera = Math.sqrt(dx * dx + dz * dz);

      if (distToCamera > WATER_LOD.MEDIUM_DISTANCE) {
        resolution = 8; // Very low poly at distance
      } else if (distToCamera > WATER_LOD.HIGH_DISTANCE) {
        resolution = 16;
      }
    }

    const geom = new THREE.PlaneGeometry(
      tileSize,
      tileSize,
      resolution,
      resolution,
    );
    geom.rotateX(-Math.PI / 2);

    const count = geom.attributes.position.count;
    const shores = new Float32Array(count).fill(50);
    geom.setAttribute("shoreDistance", new THREE.BufferAttribute(shores, 1));

    const normals = new Float32Array(count * 3);
    for (let i = 0; i < normals.length; i += 3) {
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
    geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

    return this.createMesh(geom, tile, waterThreshold, waterType);
  }

  private createMesh(
    geom: THREE.BufferGeometry,
    tile: TerrainTile,
    waterThreshold: number,
    waterType: WaterBodyType = "lake",
  ): THREE.Mesh {
    // Select material based on water type
    const material =
      waterType === "ocean" ? this.oceanMaterial : this.lakeMaterial;
    if (!material) {
      throw new Error(
        `[WaterSystem] createMesh called before init() completed (${waterType} material missing)`,
      );
    }

    const mesh = new THREE.Mesh(geom, material);
    mesh.position.y = waterThreshold;
    mesh.name = `Water_${waterType}_${tile.key}`;
    mesh.renderOrder = 100;
    mesh.userData = {
      type: "water",
      waterType: waterType,
      walkable: false,
      clickable: false,
    };

    // PERFORMANCE: Put water on layer 1 (main camera only, not minimap)
    // This prevents expensive water shader from rendering in minimap
    mesh.layers.set(1);

    return mesh;
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  update(deltaTime: number): void {
    this.coastalBathymetry?.update();
    const dt =
      typeof deltaTime === "number" && isFinite(deltaTime) ? deltaTime : 1 / 60;
    this.waterTime += dt;

    if (!this.windSystem) {
      this.windSystem =
        (this.world.getSystem("wind") as Wind | undefined) ?? null;
    }

    // Get lighting data from Environment system (same as trees)
    const env = this.world.getSystem("environment") as {
      getDayIntensity?: () => number;
      sunLight?: { intensity: number };
      lightDirection?: THREE.Vector3;
    } | null;

    const baseWindStrength =
      this.windSystem?.uniforms.windStrength.value ?? 1.0;
    const waveOscillation = Math.sin(this.waterTime * 0.03) * 0.08;
    const windStrength = baseWindStrength * (0.95 + waveOscillation);

    const dayIntensity = env?.getDayIntensity?.() ?? 1;
    const sunIntensity = env?.sunLight
      ? Math.min(env.sunLight.intensity, 2.0)
      : 1.0;

    const updateUniforms = (u: WaterUniforms, windMul: number) => {
      u.time.value = this.waterTime;
      u.windStrength.value = windStrength * windMul;
      u.dayIntensity.value = dayIntensity;
      u.sunIntensity.value = sunIntensity;

      // Sun direction: negate lightDirection (points FROM sun → TO sun)
      if (env?.lightDirection) {
        u.sunDirection.value.copy(env.lightDirection).negate().normalize();
      }
    };

    if (this.uniforms) updateUniforms(this.uniforms, 1.0);
    if (this.oceanUniforms) updateUniforms(this.oceanUniforms, 1.2);

    if (this.oceanUniforms) {
      const wind = this.oceanUniforms.windStrength.value;
      for (let i = 0; i < this.oceanDisplacementBounds.length; i++) {
        this.refreshOceanDisplacementBounds(
          this.oceanDisplacementBounds[i],
          wind,
        );
      }
    }

    this.updateReflectionVisibility();
  }

  /**
   * Check if reflections should be active this frame.
   */
  private updateReflectionVisibility(): void {
    if (!this._reflectionsEnabled || !this.reflection) {
      this.reflectionActive = false;
      return;
    }
    this.reflectionActive = this.waterMeshes.length > 0;
  }

  destroy(): void {
    // Dispose all water meshes (geometry + remove from scene)
    for (const mesh of this.waterMeshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this.waterMeshes = [];
    this.lakePlaneSources.clear();
    this.lakeReflectionOwners = new WeakMap();
    this.lastLakeReflectionOwner = null;
    this.lakeReflectionPlaneUniform = null;
    this.lakeWavePositionNode = null;
    this.lakeReflectionUvNode = null;
    this.reflectionGrassFootprint = null;
    this.oceanDisplacementBounds.length = 0;

    // Dispose materials
    this.lakeMaterial?.dispose();
    this.lakeMaterial = undefined;
    this.quietPondUniform = null;
    this.oceanMaterial?.dispose();
    this.oceanMaterial = undefined;
    this.coastalBathymetry?.destroy();
    this.coastalBathymetry = null;

    // Dispose textures
    this.normalTex?.dispose();
    this.normalTex = undefined;
    this.flowTex?.dispose();
    this.flowTex = undefined;
    this.foamTex?.dispose();
    this.foamTex = undefined;

    // Dispose reflector render target + remove from scene
    if (this.reflection) {
      if (this.reflection.target) {
        this.reflection.target.removeFromParent();
      }
      // r186 ReflectorNode owns a per-camera target map through its base node.
      // Its public disposal path retires those targets, not the global fog RTT.
      this.reflection.dispose();
    }
    this.reflection = undefined;

    this.uniforms = null;
    this.oceanUniforms = null;
  }
}
