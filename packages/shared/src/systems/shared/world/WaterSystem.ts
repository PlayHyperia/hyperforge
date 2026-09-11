/**
 * WaterSystem - AAA Lake Water Shader (WebGPU TSL)
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
import type { Node, UniformNode } from "three/webgpu";
import type { World } from "../../../types";
import type { TerrainTile } from "../../../types/world/terrain";
import type { Wind } from "./Wind";
import { FOG_NEAR_SQ, FOG_FAR_SQ, fogRenderTarget } from "./FogConfig";
import { SUN_SHADE, NIGHT, applySunShade } from "./LightingConfig";
import { WorldIlluminationUniforms } from "./WorldIlluminationUniforms";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";

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

  // TSL planar reflection (Three.js ReflectorNode handles camera, RT, clipping)
  private reflection?: ReturnType<typeof reflector>;
  private waterLevel: number = TERRAIN_CONSTANTS.WATER_THRESHOLD;
  private waterMeshes: THREE.Mesh[] = [];

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

  /**
   * Enable or disable realtime water reflections for lake/pond water
   * Ocean water never has reflections regardless of this setting
   */
  setReflectionsEnabled(enabled: boolean): void {
    this._reflectionsEnabled = enabled;

    // Update reflection intensity uniform - this actually disables reflections in the shader
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
    this.waterLevel = y;
    if (this.reflection?.target) {
      this.reflection.target.position.y = y;
    }
  }

  /**
   * Register an externally-created water mesh for reflection visibility tracking.
   */
  registerWaterMesh(mesh: THREE.Mesh): void {
    this.waterMeshes.push(mesh);
  }

  /**
   * Unregister an externally-created water mesh from reflection tracking.
   */
  unregisterWaterMesh(mesh: THREE.Mesh): void {
    const idx = this.waterMeshes.indexOf(mesh);
    if (idx !== -1) this.waterMeshes.splice(idx, 1);
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

    // TSL reflector: handles render target, camera mirroring, oblique clipping
    this.reflection = reflector({ resolutionScale: 0.5 });
    this.reflection.target.rotateX(-Math.PI / 2);
    this.reflection.target.position.y = this.waterLevel;

    this.lakeMaterial = this.createLakeMaterial();
    this.oceanMaterial = this.createOceanMaterial();
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

    const reflNode = this.reflection!;
    const worldUV0 = vec2(positionWorld.x, positionWorld.z);
    const normalOffset = texture(nTex, mul(worldUV0, float(0.02))).xy;
    const normalDistortion = sub(mul(normalOffset, float(2)), float(1));
    reflNode.uvNode = reflNode.uvNode!.add(mul(normalDistortion, float(0.015)));
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
    material.positionNode = Fn(() => {
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

    // Screen-space water depth
    const gpuShoreDist = Fn(() => {
      const sceneDepth = linearDepth(viewportDepthTexture());
      const waterDepth = linearDepth();
      const depthDiff = sub(sceneDepth, waterDepth);
      const worldDist = mul(depthDiff, sub(cameraFar, cameraNear));
      return clamp(worldDist, float(0), float(WATER.MAX_DEPTH));
    })();

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
      return sub(float(1), opDepth);
    })();

    // OUTPUT: Same pattern as tree shader — pbrOut = output, replace RGB, keep pbrOut.a
    material.outputNode = Fn(() => {
      const pbrOut = output;
      const wp = positionWorld;
      const shoreDist = gpuShoreDist;
      const wUV = vec2(wp.x, wp.z);

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
        vec2(div(uTime, float(17)), div(uTime, float(29))),
      );
      const nUV2 = add(
        vec2(div(baseA.x, float(8907)), div(baseA.y, float(9803))),
        vec2(div(uTime, float(101)), div(uTime, float(97))),
      );
      // Phase B: scroll layers 1 + 3 (large + medium-fine scale)
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
        mul(reflectPart, uReflectionIntensity),
        reflectance,
      );
      let color: Node<"vec3"> = mix(albedo, waterColor, float(0.8));

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
          mul(worldReflect, uReflectionIntensity),
          reflectance,
        ),
        worldDiffuse,
        float(0.8),
      );
      worldColor = mix(
        worldColor,
        illumination.diffuse(
          vec3(WATER.FOAM_COLOR.r, WATER.FOAM_COLOR.g, WATER.FOAM_COLOR.b),
          surfaceNormal,
        ),
        foamOpacity,
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
      const shoreDist = attribute<"float">("shoreDistance", "float");
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
      return mul(mul(edgeFade, depthOpacity), fresnelOpacity);
    })();

    // OUTPUT: Same pattern as tree shader — pbrOut = output, replace RGB, keep pbrOut.a
    material.outputNode = Fn(() => {
      const pbrOut = output;
      const wp = positionWorld;
      const shoreDist = attribute<"float">("shoreDistance", "float");
      const shoreMask = smoothstep(float(0), float(6), shoreDist);
      const wUV = vec2(wp.x, wp.z);

      // --- Cosine gradient — deeper bias for ocean ---
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
      this.waterMeshes.push(mesh);
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
    this.waterMeshes.push(mesh);
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

    // Dispose materials
    this.lakeMaterial?.dispose();
    this.lakeMaterial = undefined;
    this.quietPondUniform = null;
    this.oceanMaterial?.dispose();
    this.oceanMaterial = undefined;

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
      // Dispose the reflector's internal WebGPU render target (GPU framebuffer)
      const reflectorNode = this.reflection as unknown as {
        renderTarget?: { dispose(): void };
      };
      reflectorNode.renderTarget?.dispose();
    }
    this.reflection = undefined;

    this.uniforms = null;
    this.oceanUniforms = null;
  }
}
