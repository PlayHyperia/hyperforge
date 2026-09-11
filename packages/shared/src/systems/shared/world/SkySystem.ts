/**
 * SkySystem.ts - Advanced Dynamic Sky, Sun/Moon and Clouds
 *
 * Creates a dynamic skydome with day/night cycle, sun/moon visuals,
 * and layered billboard clouds using InstancedMesh.
 *
 * Fully WebGPU-compatible using TSL (Three Shading Language) Node Materials.
 * All materials use MeshBasicNodeMaterial with TSL color nodes.
 * No WebGL-specific extensions or shaders are used.
 */

import { System } from "../infrastructure/System";
import * as THREE from "../../../extras/three/three";
import {
  abs,
  add,
  clamp,
  cos,
  distance,
  div,
  dot,
  float,
  Fn,
  length,
  max,
  min,
  MeshBasicNodeMaterial,
  mix,
  mul,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  screenUV,
  sin,
  smoothstep,
  sub,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "../../../extras/three/three";
import type { Node, UniformNode } from "three/webgpu";
import type { World, WorldOptions } from "../../../types";
import { isStreamingLikeViewport } from "../../../runtime/clientViewportMode";
import { applyCloudFog, fogRenderTarget } from "./FogConfig";
import { DAY_CYCLE, SUN_LIGHT } from "./LightingConfig";

const SKY_DOME_RADIUS = 5000;

/**
 * Decorative sky billboards are intentionally omitted from broadcast views.
 * Their large transparent TSL planes are expensive and can render as opaque
 * rectangles on WebGPU capture paths. The procedural sky dome and celestial
 * lighting stay enabled, so this does not affect illumination or time-of-day.
 */
export function shouldRenderDecorativeSkyBillboards(win?: Window): boolean {
  return !isStreamingLikeViewport(win);
}

const SKY_RENDER_ORDER = {
  SKY_DOME: -1000,
  CELESTIAL_GLOW_OUTER: -999,
  CELESTIAL_GLOW_INNER: -998,
  CELESTIAL_DISC: -997,
  CLOUDS: -995,
} as const;

// -----------------------------
// Utility: Procedural noise textures (avoids external deps)
// -----------------------------
function createNoiseTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.floor(Math.random() * 255);
    const o = i * 4;
    data[o] = v;
    data[o + 1] = Math.floor(Math.random() * 255);
    data[o + 2] = Math.floor(Math.random() * 255);
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// -----------------------------
// Cloud configuration — 28 clouds on a sky-dome ring, 2x4 sprite atlas per texture.
// Each entry specifies (az, el) spherical coordinates on SKY_DOME_RADIUS.
// -----------------------------
type CloudDef = {
  az: number;
  el: number;
  tex: number; // 1-4 (cloud1.png through cloud4.png)
  sprite: number; // 0-7 within 2x4 atlas
  w: number; // width in world units
  h: number; // height in world units
  dSpeed: number; // distortion speed
  dRange: number; // distortion range
};

const CLOUD_DEFS: CloudDef[] = [
  // --- Texture 3 (cloud3) — 12 low-altitude horizon clouds ---
  {
    az: 14.4,
    el: 4.1,
    tex: 3,
    sprite: 0,
    w: 300,
    h: 200,
    dSpeed: 0.12,
    dRange: 0.1,
  },
  {
    az: 0,
    el: 4.1,
    tex: 3,
    sprite: 6,
    w: 300,
    h: 200,
    dSpeed: 0.11,
    dRange: 0.05,
  },
  {
    az: 50.4,
    el: 4.1,
    tex: 3,
    sprite: 1,
    w: 300,
    h: 180,
    dSpeed: 0.12,
    dRange: 0.1,
  },
  {
    az: 28.8,
    el: 4.1,
    tex: 3,
    sprite: 6,
    w: 300,
    h: 180,
    dSpeed: 0.1,
    dRange: 0.0,
  },
  {
    az: 100.8,
    el: 4.1,
    tex: 3,
    sprite: 2,
    w: 400,
    h: 200,
    dSpeed: 0.12,
    dRange: 0.1,
  },
  {
    az: 108,
    el: 4.1,
    tex: 3,
    sprite: 6,
    w: 400,
    h: 200,
    dSpeed: 0.12,
    dRange: 0.05,
  },
  {
    az: 162,
    el: 4.1,
    tex: 3,
    sprite: 3,
    w: 400,
    h: 200,
    dSpeed: 0.12,
    dRange: 0.1,
  },
  {
    az: 180,
    el: 4.1,
    tex: 3,
    sprite: 7,
    w: 400,
    h: 200,
    dSpeed: 0.1,
    dRange: 0.1,
  },
  {
    az: 248.4,
    el: 4.1,
    tex: 3,
    sprite: 4,
    w: 350,
    h: 175,
    dSpeed: 0.12,
    dRange: 0.1,
  },
  {
    az: 270,
    el: 4.1,
    tex: 3,
    sprite: 6,
    w: 350,
    h: 175,
    dSpeed: 0.12,
    dRange: 0.0,
  },
  {
    az: 288,
    el: 4.1,
    tex: 3,
    sprite: 5,
    w: 350,
    h: 175,
    dSpeed: 0.12,
    dRange: 0.1,
  },
  {
    az: 306,
    el: 4.1,
    tex: 3,
    sprite: 7,
    w: 500,
    h: 200,
    dSpeed: 0.1,
    dRange: 0.05,
  },
  // --- Texture 1 (cloud1) — 8 mid/high altitude clouds ---
  {
    az: 0,
    el: 20.2,
    tex: 1,
    sprite: 0,
    w: 230,
    h: 115,
    dSpeed: 0.1,
    dRange: 0.5,
  },
  {
    az: 54,
    el: 29.9,
    tex: 1,
    sprite: 1,
    w: 180,
    h: 90,
    dSpeed: 0.12,
    dRange: 0.4,
  },
  {
    az: 82.8,
    el: 37.9,
    tex: 1,
    sprite: 2,
    w: 210,
    h: 105,
    dSpeed: 0.13,
    dRange: 0.35,
  },
  {
    az: 122.4,
    el: 7.9,
    tex: 1,
    sprite: 3,
    w: 250,
    h: 125,
    dSpeed: 0.15,
    dRange: 0.4,
  },
  {
    az: 165.6,
    el: 20.7,
    tex: 1,
    sprite: 4,
    w: 230,
    h: 115,
    dSpeed: 0.16,
    dRange: 0.35,
  },
  {
    az: 208.8,
    el: 30.3,
    tex: 1,
    sprite: 5,
    w: 290,
    h: 145,
    dSpeed: 0.12,
    dRange: 0.4,
  },
  {
    az: 270,
    el: 21.2,
    tex: 1,
    sprite: 6,
    w: 150,
    h: 75,
    dSpeed: 0.2,
    dRange: 0.45,
  },
  {
    az: 324,
    el: 20.5,
    tex: 1,
    sprite: 7,
    w: 240,
    h: 120,
    dSpeed: 0.17,
    dRange: 0.5,
  },
  // --- Texture 4 (cloud4) — 8 mid/high altitude clouds ---
  {
    az: 216,
    el: 5.8,
    tex: 4,
    sprite: 7,
    w: 300,
    h: 150,
    dSpeed: 0.1,
    dRange: 0.5,
  },
  {
    az: 72,
    el: 5.8,
    tex: 4,
    sprite: 6,
    w: 200,
    h: 100,
    dSpeed: 0.12,
    dRange: 0.4,
  },
  {
    az: 129.6,
    el: 30.4,
    tex: 4,
    sprite: 5,
    w: 250,
    h: 120,
    dSpeed: 0.13,
    dRange: 0.35,
  },
  {
    az: 180,
    el: 36.6,
    tex: 4,
    sprite: 4,
    w: 280,
    h: 170,
    dSpeed: 0.15,
    dRange: 0.4,
  },
  {
    az: 248.4,
    el: 30.3,
    tex: 4,
    sprite: 3,
    w: 350,
    h: 200,
    dSpeed: 0.16,
    dRange: 0.35,
  },
  {
    az: 284.4,
    el: 40.8,
    tex: 4,
    sprite: 2,
    w: 390,
    h: 200,
    dSpeed: 0.12,
    dRange: 0.4,
  },
  {
    az: 306,
    el: 29.3,
    tex: 4,
    sprite: 1,
    w: 380,
    h: 190,
    dSpeed: 0.2,
    dRange: 0.45,
  },
  {
    az: 342,
    el: 38.9,
    tex: 4,
    sprite: 0,
    w: 150,
    h: 100,
    dSpeed: 0.17,
    dRange: 0.5,
  },
];

// -----------------------------
// Sky System Uniforms Type
// -----------------------------
export type SkyUniforms = {
  time: { value: number };
  sunPosition: { value: THREE.Vector3 };
  dayCycleProgress: { value: number };
};

// TSL uniform reference type (for runtime updates)
type TSLUniformFloat = { value: number };
type TSLUniformVec3 = { value: THREE.Vector3 };

type PaletteColorUniform = UniformNode<"color", THREE.Color>;

/** Linear colors shared by this world's visible sky and starless fog graphs. */
export type SkyPaletteUniforms = {
  readonly dayZenith: PaletteColorUniform;
  readonly dayHorizon: PaletteColorUniform;
  readonly nightZenith: PaletteColorUniform;
  readonly nightHorizon: PaletteColorUniform;
  readonly sunrise: PaletteColorUniform;
  readonly sunsetPink: PaletteColorUniform;
  readonly moonGlow: PaletteColorUniform;
  readonly haze: PaletteColorUniform;
};

/** Linear colors shared by all decorative clouds in this world. */
export type CloudPaletteUniforms = {
  readonly nightBright: PaletteColorUniform;
  readonly dayBright: PaletteColorUniform;
  readonly nightDark: PaletteColorUniform;
  readonly dayDark: PaletteColorUniform;
};

// Material uniform storage types
type SkyMaterialUniforms = {
  uTime: TSLUniformFloat;
  uSunPosition: TSLUniformVec3;
  uDayCycleProgress: TSLUniformFloat;
  uDayIntensity: TSLUniformFloat; // Pre-calculated sharp transition value
};

type CloudMaterialUniforms = {
  uTime: TSLUniformFloat;
  uSunPosition: TSLUniformVec3;
  uCloudRadius: TSLUniformFloat;
};

type SunMaterialUniforms = {
  uOpacity: TSLUniformFloat;
};

type MoonMaterialUniforms = {
  uOpacity: TSLUniformFloat;
};

// -----------------------------
// SkySystem
// -----------------------------
export class SkySystem extends System {
  // PERFORMANCE: Static shared TextureLoader (avoids creating new loader per texture)
  private static _textureLoader = new THREE.TextureLoader();

  // Records/nodes stay stable; callers may reversibly edit each uniform's Color value.
  // Per-instance allocation keeps palette ownership separate between worlds.
  public readonly skyPaletteUniforms: SkyPaletteUniforms = Object.freeze({
    dayZenith: uniform(new THREE.Color(0.25, 0.55, 0.95)),
    dayHorizon: uniform(new THREE.Color(0.7, 0.85, 1.0)),
    nightZenith: uniform(new THREE.Color(0.005, 0.008, 0.025)),
    nightHorizon: uniform(new THREE.Color(0.02, 0.03, 0.06)),
    sunrise: uniform(new THREE.Color(1.0, 0.5, 0.2)),
    sunsetPink: uniform(new THREE.Color(1.0, 0.4, 0.5)),
    moonGlow: uniform(new THREE.Color(0.5, 0.6, 0.8)),
    haze: uniform(new THREE.Color(0.83, 0.78, 0.72)),
  });

  public readonly cloudPaletteUniforms: CloudPaletteUniforms = Object.freeze({
    nightBright: uniform(new THREE.Color(0.141, 0.607, 0.94)),
    dayBright: uniform(new THREE.Color(1.0, 1.0, 1.0)),
    nightDark: uniform(new THREE.Color(0.024, 0.32, 0.59)),
    dayDark: uniform(new THREE.Color(0.22, 0.5, 0.85)),
  });

  private scene: THREE.Scene | null = null;
  private group: THREE.Group | null = null;
  private skyMesh: THREE.Mesh | null = null;
  private clouds: THREE.InstancedMesh | null = null;
  private moon: THREE.Mesh | null = null;
  private moonGlow: THREE.Mesh | null = null;
  private sun: THREE.Mesh | null = null;
  private sunGlow: THREE.Mesh | null = null;

  private galaxyTex: THREE.Texture | null = null;
  private cloud1: THREE.Texture | null = null;
  private cloud2: THREE.Texture | null = null;
  private cloud3: THREE.Texture | null = null;
  private cloud4: THREE.Texture | null = null;
  private moonTex: THREE.Texture | null = null;
  private starTex: THREE.Texture | null = null;
  private noiseA!: THREE.Texture;
  private noiseB!: THREE.Texture;

  // Fog sky scene — rendered to the shared fogRenderTarget from FogConfig
  private fogScene: THREE.Scene | null = null;
  private fogCamera: THREE.PerspectiveCamera | null = null;
  private fogSkyMesh: THREE.Mesh | null = null;
  private fogSkyUniforms: SkyMaterialUniforms | null = null;

  // Legacy uniforms (for compatibility)
  private skyUniforms: SkyUniforms;

  // TSL material uniforms for runtime updates - stored at class level like WaterSystem
  private sunMaterialUniforms: SunMaterialUniforms | null = null;
  private moonMaterialUniforms: MoonMaterialUniforms | null = null;
  private skyTSLUniforms: SkyMaterialUniforms | null = null;
  private cloudMaterialUniforms: CloudMaterialUniforms | null = null;

  // Texture uniform for stars - must be stored at class level for proper updates
  private galaxyTextureUniform: { value: THREE.Texture | null } | null = null;

  private elapsed = 0;
  private dayDurationSec = DAY_CYCLE.DURATION_SEC;
  // Pre-allocated vector for sun direction to avoid per-frame allocation
  private _sunDir = new THREE.Vector3();
  private _dayPhase = 0;
  private _dayIntensity = 1;
  private renderDecorativeSkyBillboards = true;

  constructor(world: World) {
    super(world);
    this.skyUniforms = {
      time: { value: 0 },
      sunPosition: { value: new THREE.Vector3(0, 1, 0) },
      dayCycleProgress: { value: 0 },
    };
  }

  // =====================
  // Public getters for lighting synchronization
  // =====================

  /** Current sun direction vector (normalized) */
  get sunDirection(): THREE.Vector3 {
    return this._sunDir;
  }

  /** Day phase 0-1 (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset) */
  get dayPhase(): number {
    return this._dayPhase;
  }

  /** Day intensity 0-1 (0 = full night, 1 = full day) - smooth cosine curve */
  get dayIntensity(): number {
    return this._dayIntensity;
  }

  /** Whether it's currently daytime (sun above horizon) */
  get isDay(): boolean {
    // Sun is above horizon from dayPhase 0.25 (sunrise) to 0.75 (sunset)
    return this._dayPhase >= 0.25 && this._dayPhase < 0.75;
  }

  /** Moon direction vector (opposite of sun) */
  get moonDirection(): THREE.Vector3 {
    return this._sunDir.clone().negate();
  }

  /** Sky fog texture — low-res sky render (no stars) for per-pixel fog color sampling */
  get skyFogTexture(): THREE.Texture | null {
    return fogRenderTarget?.texture ?? null;
  }

  override getDependencies() {
    return { required: ["stage"] };
  }

  async init(_options?: WorldOptions): Promise<void> {
    // Client-only texture loading
    if (!this.world.isClient || typeof window === "undefined") {
      return;
    }

    this.noiseA = createNoiseTexture(128);
    this.noiseB = createNoiseTexture(128);
    this.renderDecorativeSkyBillboards =
      shouldRenderDecorativeSkyBillboards(window);

    // PERFORMANCE: Reuse a single TextureLoader instance
    const cachedLoader = SkySystem._textureLoader;

    const loadTex = (url: string): Promise<THREE.Texture> => {
      return new Promise((resolve, reject) => {
        cachedLoader.load(
          url,
          (t) => {
            const shouldRepeat = /noise|star|galaxy/.test(url);
            t.wrapS = shouldRepeat
              ? THREE.RepeatWrapping
              : THREE.ClampToEdgeWrapping;
            t.wrapT = shouldRepeat
              ? THREE.RepeatWrapping
              : THREE.ClampToEdgeWrapping;
            t.colorSpace = THREE.SRGBColorSpace;
            resolve(t);
          },
          undefined,
          (e) => reject(e),
        );
      });
    };

    const omittedCloudTexture = (): Promise<THREE.Texture | null> =>
      Promise.resolve(null);
    const results = await Promise.allSettled([
      this.renderDecorativeSkyBillboards
        ? loadTex("/textures/cloud1.png")
        : omittedCloudTexture(),
      this.renderDecorativeSkyBillboards
        ? loadTex("/textures/cloud2.png")
        : omittedCloudTexture(),
      this.renderDecorativeSkyBillboards
        ? loadTex("/textures/cloud3.png")
        : omittedCloudTexture(),
      this.renderDecorativeSkyBillboards
        ? loadTex("/textures/cloud4.png")
        : omittedCloudTexture(),
      loadTex("/textures/galaxy.png"),
      this.renderDecorativeSkyBillboards
        ? loadTex("/textures/moon2.png")
        : omittedCloudTexture(),
      loadTex("/textures/star3.png"),
      loadTex("/textures/noise.png"),
      loadTex("/textures/noise2.png"),
    ]);

    // Extract successful loads
    const getResult = (index: number): THREE.Texture | null => {
      const result = results[index];
      return result?.status === "fulfilled" ? result.value : null;
    };

    this.cloud1 = getResult(0);
    this.cloud2 = getResult(1);
    this.cloud3 = getResult(2);
    this.cloud4 = getResult(3);
    this.galaxyTex = getResult(4);
    this.moonTex = getResult(5);
    this.starTex = getResult(6);
    const n1 = getResult(7);
    const n2 = getResult(8);
    if (n1) this.noiseA = n1;
    if (n2) this.noiseB = n2;
  }

  start(): void {
    if (!this.world.isClient || typeof window === "undefined") return;
    if (!this.world.stage?.scene) return;
    this.scene = this.world.stage.scene as THREE.Scene;

    // Root group
    this.group = new THREE.Group();
    this.group.name = "SkySystemGroup";

    // PERFORMANCE: Set sky group to layer 1 (main camera only, not minimap)
    // Minimap only renders terrain - sky dome, sun, moon, clouds are excluded
    this.group.layers.set(1);

    this.scene.add(this.group);

    // Create sky dome with TSL Node Material
    this.createSkyDome();

    // Create fog sky render target (sky dome without stars for fog color sampling)
    this.createFogSky();

    // Large transparent sky billboards are excluded from stream/spectator
    // capture. The sky dome already supplies sun/moon atmospheric color while
    // the lighting systems continue to use the same celestial directions.
    if (this.renderDecorativeSkyBillboards) {
      this.createSun();
      this.createMoon();
      this.createClouds();
    }
  }

  /**
   * Create sun mesh with TSL Node Material (WebGPU-compatible)
   * HDR-style intense sun with multi-layer glow for bloom-like effect
   */
  private createSun(): void {
    if (!this.group) return;

    const sunGeom = new THREE.CircleGeometry(SKY_DOME_RADIUS * 0.03, 32);

    // TSL uniform for opacity control
    const uOpacity = uniform(float(1.0));

    // TSL sun color node - HDR bright sun (values > 1 for bloom effect)
    const sunColorNode = Fn(() => {
      const uvCoord = uv();
      // Distance from center for gradient
      const center = vec3(0.5, 0.5, 0.0);
      const uvPos = vec3(uvCoord.x, uvCoord.y, float(0.0));
      const dist = length(sub(uvPos, center));
      const normalizedDist = mul(dist, float(2.0));

      // Bright core with soft edge
      const coreFalloff = clamp(
        sub(float(1.0), normalizedDist),
        float(0.0),
        float(1.0),
      );
      const coreStrength = pow(coreFalloff, float(0.3)); // Very soft falloff

      // HDR sun color - values > 1 for bloom
      const sunColor = vec3(3.0, 2.4, 1.8); // HDR bright warm white
      return vec4(mul(sunColor, coreStrength), mul(coreStrength, uOpacity));
    })();

    // Create Node Material for sun
    const sunMat = new MeshBasicNodeMaterial();
    sunMat.colorNode = sunColorNode;
    sunMat.blending = THREE.AdditiveBlending;
    sunMat.depthWrite = false;
    sunMat.depthTest = true; // Terrain occludes sun (renders behind terrain)
    sunMat.transparent = true;
    sunMat.fog = false;

    // Store uniform for runtime updates
    this.sunMaterialUniforms = { uOpacity };

    this.sun = new THREE.Mesh(sunGeom, sunMat);
    this.sun.name = "SkySun";
    this.sun.frustumCulled = false;
    this.sun.renderOrder = SKY_RENDER_ORDER.CELESTIAL_DISC;
    this.sun.layers.set(1); // Main camera only, not minimap
    this.group.add(this.sun);

    const innerGlowGeom = new THREE.CircleGeometry(SKY_DOME_RADIUS * 0.1, 32);
    const innerGlowColorNode = Fn(() => {
      const uvCoord = uv();
      const center = vec3(0.5, 0.5, 0.0);
      const uvPos = vec3(uvCoord.x, uvCoord.y, float(0.0));
      const dist = length(sub(uvPos, center));
      const normalizedDist = mul(dist, float(2.0));
      const falloff = clamp(
        sub(float(1.0), normalizedDist),
        float(0.0),
        float(1.0),
      );
      const glowStrength = pow(falloff, float(2.5)); // Tighter falloff
      // HDR warm glow
      const glowColor = vec3(2.0, 1.5, 0.8);
      return vec4(mul(glowColor, glowStrength), mul(glowStrength, uOpacity));
    })();

    const innerGlowMat = new MeshBasicNodeMaterial();
    innerGlowMat.colorNode = innerGlowColorNode;
    innerGlowMat.blending = THREE.AdditiveBlending;
    innerGlowMat.depthWrite = false;
    innerGlowMat.depthTest = true; // Terrain occludes glow
    innerGlowMat.transparent = true;
    innerGlowMat.side = THREE.DoubleSide;
    innerGlowMat.fog = false;

    const innerGlow = new THREE.Mesh(innerGlowGeom, innerGlowMat);
    innerGlow.name = "SkySunInnerGlow";
    innerGlow.frustumCulled = false;
    innerGlow.renderOrder = SKY_RENDER_ORDER.CELESTIAL_GLOW_INNER;
    innerGlow.layers.set(1); // Main camera only, not minimap
    this.group.add(innerGlow);
    // Store for position updates
    (this.group as THREE.Group & { sunInnerGlow?: THREE.Mesh }).sunInnerGlow =
      innerGlow;

    const outerGlowGeom = new THREE.CircleGeometry(SKY_DOME_RADIUS * 0.2, 32);
    const outerGlowColorNode = Fn(() => {
      const uvCoord = uv();
      const center = vec3(0.5, 0.5, 0.0);
      const uvPos = vec3(uvCoord.x, uvCoord.y, float(0.0));
      const dist = length(sub(uvPos, center));
      const normalizedDist = mul(dist, float(2.0));
      const falloff = clamp(
        sub(float(1.0), normalizedDist),
        float(0.0),
        float(1.0),
      );
      // Very soft outer glow
      const glowStrength = pow(falloff, float(1.2));
      // Warm orange tint for atmospheric scattering
      const glowColor = vec3(1.0, 0.7, 0.4);
      return vec4(
        mul(glowColor, glowStrength),
        mul(mul(glowStrength, uOpacity), float(0.6)),
      );
    })();

    const outerGlowMat = new MeshBasicNodeMaterial();
    outerGlowMat.colorNode = outerGlowColorNode;
    outerGlowMat.blending = THREE.AdditiveBlending;
    outerGlowMat.depthWrite = false;
    outerGlowMat.depthTest = true; // Terrain occludes glow
    outerGlowMat.transparent = true;
    outerGlowMat.side = THREE.DoubleSide;
    outerGlowMat.fog = false;

    this.sunGlow = new THREE.Mesh(outerGlowGeom, outerGlowMat);
    this.sunGlow.name = "SkySunGlow";
    this.sunGlow.frustumCulled = false;
    this.sunGlow.renderOrder = SKY_RENDER_ORDER.CELESTIAL_GLOW_OUTER;
    this.sunGlow.layers.set(1); // Main camera only, not minimap
    this.group.add(this.sunGlow);
  }

  /**
   * Create moon mesh with TSL Node Material (WebGPU-compatible)
   */
  private createMoon(): void {
    if (!this.group) return;

    const moonGeom = new THREE.PlaneGeometry(
      SKY_DOME_RADIUS * 0.07,
      SKY_DOME_RADIUS * 0.07,
    );

    // TSL uniform for opacity control
    const uOpacity = uniform(float(1.0));

    // TSL moon color node
    const moonColorNode = Fn(() => {
      const uvCoord = uv();
      // Sample moon texture if available
      const texColor = this.moonTex
        ? texture(this.moonTex, uvCoord)
        : vec4(0.9, 0.9, 0.95, 1.0);
      return vec4(texColor.rgb, mul(texColor.a, uOpacity));
    })();

    const moonMat = new MeshBasicNodeMaterial();
    moonMat.colorNode = moonColorNode;
    moonMat.blending = THREE.AdditiveBlending;
    moonMat.depthWrite = false;
    moonMat.depthTest = true; // Terrain occludes moon
    moonMat.transparent = true;
    moonMat.side = THREE.DoubleSide;
    moonMat.fog = false;

    // Store uniform for runtime updates
    this.moonMaterialUniforms = { uOpacity };

    this.moon = new THREE.Mesh(moonGeom, moonMat);
    this.moon.name = "SkyMoon";
    this.moon.frustumCulled = false;
    this.moon.renderOrder = SKY_RENDER_ORDER.CELESTIAL_DISC;
    this.moon.layers.set(1); // Main camera only, not minimap
    this.group.add(this.moon);

    const moonGlowGeom = new THREE.CircleGeometry(SKY_DOME_RADIUS * 0.1, 32);

    const moonGlowColorNode = Fn(() => {
      const uvCoord = uv();
      const center = vec3(0.5, 0.5, 0.0);
      const uvPos = vec3(uvCoord.x, uvCoord.y, float(0.0));
      const dist = length(sub(uvPos, center));
      const normalizedDist = mul(dist, float(2.0));
      const falloff = clamp(
        sub(float(1.0), normalizedDist),
        float(0.0),
        float(1.0),
      );
      // Soft glow falloff
      const glowStrength = pow(falloff, float(1.5));
      // Cool blue-white glow for moon
      const glowColor = vec3(0.7, 0.8, 1.0);
      return vec4(mul(glowColor, glowStrength), mul(glowStrength, uOpacity));
    })();

    const moonGlowMat = new MeshBasicNodeMaterial();
    moonGlowMat.colorNode = moonGlowColorNode;
    moonGlowMat.blending = THREE.AdditiveBlending;
    moonGlowMat.depthWrite = false;
    moonGlowMat.depthTest = true; // Terrain occludes glow
    moonGlowMat.transparent = true;
    moonGlowMat.side = THREE.DoubleSide;
    moonGlowMat.fog = false;

    this.moonGlow = new THREE.Mesh(moonGlowGeom, moonGlowMat);
    this.moonGlow.name = "SkyMoonGlow";
    this.moonGlow.frustumCulled = false;
    this.moonGlow.renderOrder = SKY_RENDER_ORDER.CELESTIAL_GLOW_INNER;
    this.moonGlow.layers.set(1); // Main camera only, not minimap
    this.group.add(this.moonGlow);
  }

  /**
   * Create sky dome with TSL Node Material
   * Production-grade day/night cycle with smooth transitions, stars, and proper atmosphere
   */
  private createSkyDome(): void {
    if (!this.group) return;

    const skyGeom = new THREE.SphereGeometry(SKY_DOME_RADIUS, 128, 64);

    // Create TSL uniforms
    const uTime = uniform(float(0));
    const uSunPosition = uniform(vec3(0, 1, 0));
    const uDayCycleProgress = uniform(float(0));
    const uDayIntensity = uniform(float(0)); // Sharp transition day intensity from update()

    // Create texture uniform for galaxy/stars - this allows runtime texture updates
    // Must be a uniform so it can be updated after async texture load
    this.galaxyTextureUniform = { value: this.galaxyTex };
    const uGalaxyTex = this.galaxyTex ? texture(this.galaxyTex) : null;

    // Create the sky color node - comprehensive day/night with stars
    const skyColorNode = Fn(() => {
      const localPos = normalize(positionLocal);

      // Elevation: 0 at horizon, 1 at zenith
      // Use abs() to make sky symmetric - lower hemisphere mirrors upper
      // This is essential for correct planar water reflections
      const elevation = abs(localPos.y);

      // =====================
      // DAY/NIGHT CYCLE - Uses pre-calculated sharp transition
      // =====================
      // dayIntensity comes from uniform - sharp transitions at sunrise/sunset
      // Night stays dark until sunrise, then rapid transition
      const dayIntensity = uDayIntensity;

      // Night intensity is inverse of day
      const nightIntensity = sub(float(1.0), dayIntensity);

      // =====================
      // SKY COLORS - Darker night sky
      // =====================
      // Day sky gradient: deep blue at zenith, lighter at horizon
      const dayZenith = this.skyPaletteUniforms.dayZenith.rgb; // Rich blue
      const dayHorizon = this.skyPaletteUniforms.dayHorizon.rgb; // Light blue/white
      const dayGradient = pow(sub(float(1.0), elevation), float(1.5));
      const daySkyColor = mix(dayZenith, dayHorizon, dayGradient);

      // Night sky gradient: MUCH darker for proper night feel
      const nightZenith = this.skyPaletteUniforms.nightZenith.rgb; // Almost black with blue tint
      const nightHorizon = this.skyPaletteUniforms.nightHorizon.rgb; // Very dark blue-gray
      const nightGradient = pow(sub(float(1.0), elevation), float(2.0));
      const nightSkyColor = mix(nightZenith, nightHorizon, nightGradient);

      // Blend day/night sky
      let skyColor: Node<"vec3"> = mix(
        nightSkyColor,
        daySkyColor,
        dayIntensity,
      );

      // =====================
      // SUNRISE/SUNSET GLOW
      // =====================
      // Detect when sun is near horizon (sunrise/sunset)
      const sunY = uSunPosition.y;
      // Dawn/dusk factor: peaks when sun is at horizon (-0.1 to 0.3)
      const dawnDuskFactor = smoothstep(float(-0.2), float(0.0), sunY);
      const dawnDuskFade = smoothstep(float(0.4), float(0.15), sunY);
      const sunriseSunsetIntensity = mul(dawnDuskFactor, dawnDuskFade);

      // Direction to sun for glow positioning
      const sunDir = normalize(uSunPosition);
      const angleToSun = dot(localPos, sunDir);

      // Sunrise/sunset colors near sun
      const sunriseColor = this.skyPaletteUniforms.sunrise.rgb; // Orange
      const sunsetPinkColor = this.skyPaletteUniforms.sunsetPink.rgb; // Pink/red

      // Glow strongest near sun, with gradual falloff across radius
      // Use power function for smooth natural falloff instead of smoothstep
      const sunGlowRaw = clamp(angleToSun, float(0.0), float(1.0));
      const sunGlowAngle = pow(sunGlowRaw, float(4.0)); // Higher power = tighter, more gradual falloff
      // Also affect horizon area more
      const horizonGlow = pow(
        clamp(
          sub(float(1.0), mul(elevation, float(2.0))),
          float(0.0),
          float(1.0),
        ),
        float(2.0),
      );

      const glowIntensity = mul(
        mul(sunGlowAngle, horizonGlow),
        mul(sunriseSunsetIntensity, float(0.6)),
      );

      // Blend sunrise color with slight pink variation based on time
      const dawnOrDusk = smoothstep(float(0.2), float(0.3), uDayCycleProgress);
      const glowColor = mix(sunriseColor, sunsetPinkColor, dawnOrDusk);
      skyColor = add(skyColor, mul(glowColor, glowIntensity));

      // =====================
      // STARS (Night only) - Procedural starfield with stable noise
      // =====================
      // Stars visible at night - stronger visibility curve for more stars
      const starVisibility = mul(
        pow(nightIntensity, float(0.5)), // Square root for earlier star visibility
        smoothstep(float(0.05), float(0.3), elevation),
      );

      // Use UV coordinates from the sphere geometry - these are stable
      // and don't change with camera rotation (sphere doesn't rotate)
      const sphereUV = uv();

      // Scale UVs for star density - lower frequencies = more stable
      const starScale1 = float(120.0); // Reduced from 150
      const starScale2 = float(160.0); // Reduced from 300
      const starScale3 = float(200.0); // Reduced from 600

      // Use UV-based coordinates for stability
      const starCoord1 = mul(sphereUV, starScale1);
      const starCoord2 = mul(sphereUV, starScale2);
      const starCoord3 = mul(sphereUV, starScale3);

      // Stable pseudo-random using UV coordinates
      // Lower frequency coefficients for less precision sensitivity
      const starNoise1 = mul(
        mul(
          add(float(1.0), cos(mul(starCoord1.x, float(6.28)))),
          add(float(1.0), cos(mul(starCoord1.y, float(7.35)))),
        ),
        add(float(1.0), cos(mul(add(starCoord1.x, starCoord1.y), float(4.12)))),
      );
      const starNoise2 = mul(
        mul(
          add(float(1.0), cos(mul(starCoord2.x, float(5.89)))),
          add(float(1.0), cos(mul(starCoord2.y, float(8.12)))),
        ),
        add(float(1.0), cos(mul(add(starCoord2.x, starCoord2.y), float(3.78)))),
      );
      const starNoise3 = mul(
        mul(
          add(float(1.0), cos(mul(starCoord3.x, float(7.23)))),
          add(float(1.0), cos(mul(starCoord3.y, float(6.54)))),
        ),
        add(float(1.0), cos(mul(add(starCoord3.x, starCoord3.y), float(5.01)))),
      );

      // Threshold noise to create sparse bright stars
      const starThreshold1 = pow(
        smoothstep(float(7.8), float(8.0), starNoise1),
        float(2.0),
      );
      const starThreshold2 = mul(
        pow(smoothstep(float(7.9), float(8.0), starNoise2), float(2.0)),
        float(0.7),
      );
      const starThreshold3 = mul(
        pow(smoothstep(float(7.95), float(8.0), starNoise3), float(2.0)),
        float(0.4),
      );

      // Combine star layers
      const proceduralStars = clamp(
        add(add(starThreshold1, starThreshold2), starThreshold3),
        float(0.0),
        float(1.0),
      );

      // Galaxy texture for additional nebula glow
      const galaxyUV = mul(sphereUV, float(2.0));
      const galaxySample = uGalaxyTex
        ? texture(this.galaxyTex!, galaxyUV)
        : vec4(0.0, 0.0, 0.0, 0.0);

      // Combine procedural stars with galaxy nebula glow
      const starIntensity = add(
        mul(proceduralStars, float(1.5)), // Bright procedural stars
        mul(galaxySample.r, float(0.12)), // Subtle galaxy glow
      );

      // Star colors vary slightly - warmer for some, cooler for others
      const starColorVar = mix(
        vec3(1.0, 0.95, 0.85), // Warm white
        vec3(0.85, 0.92, 1.0), // Cool blue-white
        proceduralStars,
      );
      const finalStarColor = mul(
        starColorVar,
        mul(starIntensity, starVisibility),
      );
      skyColor = add(skyColor, finalStarColor);

      // =====================
      // MOON GLOW (Night atmospheric glow)
      // =====================
      const moonPos = mul(sunDir, float(-1.0));
      const angleToMoon = dot(localPos, moonPos);
      // Use power function for gradual falloff instead of smoothstep
      const moonGlowRaw = clamp(angleToMoon, float(0.0), float(1.0));
      const moonGlowAngle = pow(moonGlowRaw, float(6.0)); // Softer glow
      const moonGlowColor = this.skyPaletteUniforms.moonGlow.rgb; // Cool blue glow
      const moonGlowIntensity = mul(
        mul(moonGlowAngle, nightIntensity),
        float(0.4), // Stronger moon glow
      );
      skyColor = add(skyColor, mul(moonGlowColor, moonGlowIntensity));

      // =====================
      // HORIZON HAZE (subtle atmosphere)
      // =====================
      const hazeColor = this.skyPaletteUniforms.haze.rgb; // Warm beige
      // Haze strongest near horizon (low elevation), fades as you go higher
      // Use elevation (which is now abs(localPos.y)) for symmetric reflections
      const hazeStrength = smoothstep(float(0.15), float(0.0), elevation);
      // Haze stronger during day, minimal at night
      const hazeAmount = mul(
        hazeStrength,
        mul(float(0.3), mul(dayIntensity, float(0.9))), // Much less haze at night
      );
      skyColor = mix(skyColor, hazeColor, hazeAmount);

      return vec4(skyColor, float(1.0));
    })();

    // Create the Node Material
    const skyMat = new MeshBasicNodeMaterial();
    skyMat.colorNode = skyColorNode;
    skyMat.side = THREE.BackSide;
    skyMat.depthWrite = false;
    skyMat.depthTest = false; // Ignore camera far plane - sky always renders
    skyMat.transparent = false;
    skyMat.toneMapped = true;
    skyMat.fog = false; // Sky should never be affected by scene fog

    // Store TSL uniforms at class level for reliable updates (like WaterSystem)
    // Store directly without casting - the uniform() function returns objects with .value
    this.skyTSLUniforms = {
      uTime: uTime,
      uSunPosition: uSunPosition as unknown as TSLUniformVec3,
      uDayCycleProgress: uDayCycleProgress,
      uDayIntensity: uDayIntensity,
    } as SkyMaterialUniforms;

    this.skyMesh = new THREE.Mesh(skyGeom, skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = SKY_RENDER_ORDER.SKY_DOME;
    this.skyMesh.name = "AdvancedSkydome";
    this.skyMesh.layers.set(1); // Main camera only, not minimap
    this.group.add(this.skyMesh);
  }

  /**
   * Create a low-res offscreen render of the sky dome WITHOUT stars/galaxy.
   * This texture is sampled per-pixel by object shaders for fog color,
   * ensuring fog matches the visible sky at every angle and time of day.
   */
  private createFogSky(): void {
    if (!this.skyTSLUniforms) return;

    this.fogScene = new THREE.Scene();
    this.fogCamera = this.world.camera.clone() as THREE.PerspectiveCamera;

    const fogSkyGeom = new THREE.SphereGeometry(SKY_DOME_RADIUS, 64, 32);

    const uSunPosition = uniform(vec3(0, 1, 0));
    const uDayCycleProgress = uniform(float(0));
    const uDayIntensity = uniform(float(0));

    this.fogSkyUniforms = {
      uTime: uniform(float(0)),
      uSunPosition: uSunPosition as unknown as TSLUniformVec3,
      uDayCycleProgress: uDayCycleProgress,
      uDayIntensity: uDayIntensity,
    } as SkyMaterialUniforms;

    // Same as main sky dome but WITHOUT stars and galaxy (they'd bleed bright spots into fog)
    const fogSkyColorNode = Fn(() => {
      const localPos = normalize(positionLocal);
      const elevation = abs(localPos.y);

      const dayIntensity = uDayIntensity;
      const nightIntensity = sub(float(1.0), dayIntensity);

      const dayZenith = this.skyPaletteUniforms.dayZenith.rgb;
      const dayHorizon = this.skyPaletteUniforms.dayHorizon.rgb;
      const dayGradient = pow(sub(float(1.0), elevation), float(1.5));
      const daySkyColor = mix(dayZenith, dayHorizon, dayGradient);

      const nightZenith = this.skyPaletteUniforms.nightZenith.rgb;
      const nightHorizon = this.skyPaletteUniforms.nightHorizon.rgb;
      const nightGradient = pow(sub(float(1.0), elevation), float(2.0));
      const nightSkyColor = mix(nightZenith, nightHorizon, nightGradient);

      let skyColor: Node<"vec3"> = mix(
        nightSkyColor,
        daySkyColor,
        dayIntensity,
      );

      // Sunrise/sunset glow
      const sunY = uSunPosition.y;
      const dawnDuskFactor = smoothstep(float(-0.2), float(0.0), sunY);
      const dawnDuskFade = smoothstep(float(0.4), float(0.15), sunY);
      const sunriseSunsetIntensity = mul(dawnDuskFactor, dawnDuskFade);

      const sunDir = normalize(uSunPosition);
      const angleToSun = dot(localPos, sunDir);

      const sunriseColor = this.skyPaletteUniforms.sunrise.rgb;
      const sunsetPinkColor = this.skyPaletteUniforms.sunsetPink.rgb;
      const sunGlowRaw = clamp(angleToSun, float(0.0), float(1.0));
      const sunGlowAngle = pow(sunGlowRaw, float(4.0));
      const horizonGlow = pow(
        clamp(
          sub(float(1.0), mul(elevation, float(2.0))),
          float(0.0),
          float(1.0),
        ),
        float(2.0),
      );
      const glowIntensity = mul(
        mul(sunGlowAngle, horizonGlow),
        mul(sunriseSunsetIntensity, float(0.6)),
      );
      const dawnOrDusk = smoothstep(float(0.2), float(0.3), uDayCycleProgress);
      const glowColor = mix(sunriseColor, sunsetPinkColor, dawnOrDusk);
      skyColor = add(skyColor, mul(glowColor, glowIntensity));

      // Moon glow
      const moonPos = mul(sunDir, float(-1.0));
      const angleToMoon = dot(localPos, moonPos);
      const moonGlowRaw = clamp(angleToMoon, float(0.0), float(1.0));
      const moonGlowAngle = pow(moonGlowRaw, float(6.0));
      const moonGlowColor = this.skyPaletteUniforms.moonGlow.rgb;
      const moonGlowIntensity = mul(
        mul(moonGlowAngle, nightIntensity),
        float(0.4),
      );
      skyColor = add(skyColor, mul(moonGlowColor, moonGlowIntensity));

      // Horizon haze
      const hazeColor = this.skyPaletteUniforms.haze.rgb;
      const hazeStrength = smoothstep(float(0.15), float(0.0), elevation);
      const hazeAmount = mul(
        hazeStrength,
        mul(float(0.3), mul(dayIntensity, float(0.9))),
      );
      skyColor = mix(skyColor, hazeColor, hazeAmount);

      return vec4(skyColor, float(1.0));
    })();

    const fogSkyMat = new MeshBasicNodeMaterial();
    fogSkyMat.colorNode = fogSkyColorNode;
    fogSkyMat.side = THREE.BackSide;
    fogSkyMat.depthWrite = false;
    fogSkyMat.depthTest = false;
    fogSkyMat.fog = false;

    this.fogSkyMesh = new THREE.Mesh(fogSkyGeom, fogSkyMat);
    this.fogSkyMesh.frustumCulled = false;
    this.fogScene.add(this.fogSkyMesh);

    console.log(
      `[SkySystem] Fog sky scene created, rendering to shared fogRenderTarget (${fogRenderTarget.width}x${fogRenderTarget.height})`,
    );
  }

  // Store cloud group for rotation animation
  private cloudGroup: THREE.Group | null = null;

  /**
   * Create cloud billboards with custom shader:
   * - noise UV distortion for organic movement
   * - B-channel alpha with sin-based oscillation
   * - Day/night coloring from sun height
   * - Sun proximity brightness boost + G-channel additive glow
   * - R-channel dark/bright color interpolation
   */
  private createClouds(): void {
    if (!this.group) return;

    const R = SKY_DOME_RADIUS;

    this.cloudGroup = new THREE.Group();
    this.cloudGroup.name = "CloudGroup";
    this.cloudGroup.layers.set(1);

    const textures = [this.cloud1, this.cloud2, this.cloud3, this.cloud4];
    const noiseTex = this.noiseB; // noise2.png for UV distortion

    // Shared uniforms
    const uTime = uniform(float(0));
    const uSunPos = uniform(vec3(0, R, 0));
    const uCloudRadius = uniform(float(R));

    this.cloudMaterialUniforms = {
      uTime,
      uSunPosition: uSunPos,
      uCloudRadius,
    } as CloudMaterialUniforms;

    for (let i = 0; i < CLOUD_DEFS.length; i++) {
      const def = CLOUD_DEFS[i];
      const tex = textures[def.tex - 1];
      if (!tex) continue;

      // Sprite atlas UV offset (2 cols x 4 rows)
      const col = def.sprite % 2;
      const row = Math.floor(def.sprite / 2);
      const uOff = col * 0.5;
      const vOff = 0.75 - row * 0.25;

      const geom = new THREE.PlaneGeometry(1, 1);
      const uvAttr = geom.attributes.uv;
      for (let j = 0; j < uvAttr.count; j++) {
        uvAttr.setXY(
          j,
          uvAttr.getX(j) * 0.5 + uOff,
          uvAttr.getY(j) * 0.25 + vOff,
        );
      }
      uvAttr.needsUpdate = true;

      // Compute cloud world position on the sky sphere (group-local)
      const azRad = (def.az * Math.PI) / 180;
      const elRad = (def.el * Math.PI) / 180;
      const cx = R * Math.cos(elRad) * Math.sin(azRad);
      const cy = R * Math.sin(elRad);
      const cz = R * Math.cos(elRad) * Math.cos(azRad);

      // Per-cloud uniforms
      const uDistSpeed = float(def.dSpeed);
      const uDistRange = float((1 - def.dRange) * 2);
      const uCloudPos = vec3(cx, cy, cz);

      // ---- Cloud shader (TSL) ----
      const cloudOutputNode = Fn(() => {
        const uvCoord = uv();

        // Noise UV distortion for organic cloud morphing
        const noiseUV = vec2(
          add(uvCoord.x, mul(uTime, mul(uDistSpeed, float(0.1)))),
          add(uvCoord.y, mul(uTime, mul(uDistSpeed, float(0.2)))),
        );
        const noiseSample = noiseTex
          ? texture(noiseTex, noiseUV)
          : vec4(0.5, 0.5, 0.5, 1.0);
        const distortedUV = add(
          uvCoord,
          mul(vec2(noiseSample.r, noiseSample.b), float(0.01)),
        );

        const cloud = texture(tex, distortedUV);

        // B-channel alpha dissolve — sin-based oscillation morphs the cloud shape over time
        const alphaLerp = mix(
          add(
            mul(sin(mul(uTime, uDistSpeed)), float(0.78)),
            mul(float(0.78), uDistRange),
          ),
          float(1.0),
          float(0.1),
        );
        const cloudStep = sub(float(1.0), alphaLerp);
        const cloudLerp = smoothstep(float(0.95), float(1.0), alphaLerp);
        const alphaBase = smoothstep(
          clamp(sub(cloudStep, float(0.1)), float(0.0), float(1.0)),
          cloudStep,
          cloud.b,
        );
        const cloudAlpha = clamp(
          mix(alphaBase, cloud.a, cloudLerp),
          float(0.0),
          cloud.a,
        );

        // Day/night color from sun height
        const sunNightStep = smoothstep(
          float(-0.3),
          float(0.25),
          div(uSunPos.y, uCloudRadius),
        );
        const brightColor = mix(
          this.cloudPaletteUniforms.nightBright.rgb,
          this.cloudPaletteUniforms.dayBright.rgb,
          sunNightStep,
        );
        const darkColor = mix(
          this.cloudPaletteUniforms.nightDark.rgb,
          this.cloudPaletteUniforms.dayDark.rgb,
          sunNightStep,
        );

        // Sun proximity brightness
        const sunDist = distance(uCloudPos, uSunPos);
        const brightLerp = smoothstep(float(0.0), uCloudRadius, sunDist);
        const bright = mix(float(2.0), float(1.0), brightLerp);

        // R-channel color interpolation + G-channel additive sun glow
        const cloudColor = add(
          mul(mix(darkColor, brightColor, cloud.r), bright),
          mul(cloud.g, sub(float(1.0), brightLerp)),
        );

        // Per-fragment horizon fog: sample sky fog texture, blend by world Y
        const fogTex = texture(fogRenderTarget.texture, screenUV);
        const worldElev = clamp(
          div(positionWorld.y, float(5000.0)),
          float(0.0),
          float(1.0),
        );
        const fogStr = smoothstep(float(0.6), float(0.0), worldElev);
        const finalColor = mix(cloudColor, fogTex.rgb, fogStr);

        return vec4(finalColor, cloudAlpha);
      })();

      const mat = new MeshBasicNodeMaterial();
      mat.colorNode = cloudOutputNode;
      mat.side = THREE.DoubleSide;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthTest = true;
      mat.toneMapped = false;
      mat.fog = false;

      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = SKY_RENDER_ORDER.CLOUDS;
      mesh.position.set(cx, cy, cz);
      mesh.rotation.y = azRad + Math.PI;
      mesh.scale.set(def.w * 10, def.h * 10, 1);
      mesh.layers.set(1);

      this.cloudGroup.add(mesh);
    }

    this.clouds = this.cloudGroup.children[0] as THREE.InstancedMesh;
    this.group.add(this.cloudGroup);
  }

  override update(delta: number): void {
    if (!this.group || !this.skyMesh) return;
    this.elapsed += delta;

    // Time-of-day (0..1) - use synced world time from server for multiplayer sync
    // On client: use network.getSyncedWorldTime() if available, otherwise local time
    // On server: use local world time (server is authoritative)
    const network = this.world.network as
      { getSyncedWorldTime?: () => number } | undefined;
    const worldTime = network?.getSyncedWorldTime
      ? network.getSyncedWorldTime()
      : this.world.getTime();
    const dayPhase = (worldTime % this.dayDurationSec) / this.dayDurationSec;

    // Store for public getters
    this._dayPhase = dayPhase;

    // Sun is above horizon from dayPhase 0.25 (sunrise) to 0.75 (sunset)
    const isDay = this.isDay;

    // Calculate day intensity with SHARP transitions at sunrise/sunset
    // Night stays truly dark until sunrise, then rapid transition
    // This creates the feeling of "darkest before dawn" then sudden light
    const smoothstep = (edge0: number, edge1: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };

    let dayIntensity: number;
    if (dayPhase < DAY_CYCLE.DAWN_START || dayPhase >= DAY_CYCLE.DUSK_END) {
      dayIntensity = 0;
    } else if (dayPhase < DAY_CYCLE.DAWN_END) {
      dayIntensity = smoothstep(
        DAY_CYCLE.DAWN_START,
        DAY_CYCLE.DAWN_END,
        dayPhase,
      );
    } else if (dayPhase < DAY_CYCLE.DUSK_START) {
      const noonFactor = 1 - Math.abs(dayPhase - 0.5) * 2;
      dayIntensity =
        DAY_CYCLE.NOON_MIN_INTENSITY +
        noonFactor * (1 - DAY_CYCLE.NOON_MIN_INTENSITY);
    } else {
      dayIntensity =
        1 - smoothstep(DAY_CYCLE.DUSK_START, DAY_CYCLE.DUSK_END, dayPhase);
    }

    this._dayIntensity = dayIntensity;

    // Sun direction - traces arc across sky from east to west
    // dayPhase: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset, 1 = midnight
    //
    // The sun arc angle: -π/2 at midnight, 0 at sunrise, π/2 at noon, π at sunset
    const sunArcAngle = (dayPhase - 0.25) * Math.PI * 2;

    // Sun position in sky:
    // - X: East-West position (positive = east, negative = west)
    // - Y: Height above horizon (positive = above, negative = below)
    // - Z: North-South offset (slight tilt for more natural path)
    const sunElevation = Math.sin(sunArcAngle); // -1 to 1, peaks at noon
    const sunAzimuth = Math.cos(sunArcAngle); // 1 at sunrise, -1 at sunset

    const sunTilt = SUN_LIGHT.TILT;

    this._sunDir
      .set(
        sunAzimuth * Math.max(0.1, 1 - Math.abs(sunElevation)), // X: E-W, compressed when high
        sunElevation, // Y: height
        sunTilt * sunAzimuth, // Z: slight tilt
      )
      .normalize();

    // Update uniforms
    this.skyUniforms.time.value = this.elapsed;
    this.skyUniforms.sunPosition.value.copy(this._sunDir);
    this.skyUniforms.dayCycleProgress.value = dayPhase;

    const radius = SKY_DOME_RADIUS * 0.9;
    if (this.sun) {
      this.sun.position.set(
        this._sunDir.x * radius,
        this._sunDir.y * radius,
        this._sunDir.z * radius,
      );
      this.sun.visible = isDay;
      this.sun.quaternion.copy(this.world.camera.quaternion);

      // Update sun opacity via TSL uniform
      if (this.sunMaterialUniforms) {
        this.sunMaterialUniforms.uOpacity.value = isDay ? 0.9 : 0.0;
      }
    }

    // Position sun glow layers (WebGPU-compatible lensflare replacement)
    if (this.sunGlow) {
      this.sunGlow.position.set(
        this._sunDir.x * radius,
        this._sunDir.y * radius,
        this._sunDir.z * radius,
      );
      this.sunGlow.visible = isDay;
      this.sunGlow.quaternion.copy(this.world.camera.quaternion);
    }

    // Position inner sun glow
    const groupWithGlow = this.group as THREE.Group & {
      sunInnerGlow?: THREE.Mesh;
    };
    if (groupWithGlow.sunInnerGlow) {
      groupWithGlow.sunInnerGlow.position.set(
        this._sunDir.x * radius,
        this._sunDir.y * radius,
        this._sunDir.z * radius,
      );
      groupWithGlow.sunInnerGlow.visible = isDay;
      groupWithGlow.sunInnerGlow.quaternion.copy(this.world.camera.quaternion);
    }

    if (this.moon) {
      this.moon.position.set(
        -this._sunDir.x * radius,
        -this._sunDir.y * radius,
        -this._sunDir.z * radius,
      );
      this.moon.quaternion.copy(this.world.camera.quaternion);
      this.moon.visible = true;

      // Update moon opacity via TSL uniform
      if (this.moonMaterialUniforms) {
        this.moonMaterialUniforms.uOpacity.value = isDay ? 0.0 : 1.0;
      }
    }

    // Position moon glow (halo behind moon)
    if (this.moonGlow) {
      this.moonGlow.position.set(
        -this._sunDir.x * radius,
        -this._sunDir.y * radius,
        -this._sunDir.z * radius,
      );
      this.moonGlow.visible = !isDay;
      this.moonGlow.quaternion.copy(this.world.camera.quaternion);
    }

    // Update sky TSL uniforms (stored at class level for reliable updates)
    if (this.skyTSLUniforms) {
      this.skyTSLUniforms.uTime.value = this.elapsed;
      this.skyTSLUniforms.uSunPosition.value.copy(this._sunDir);
      this.skyTSLUniforms.uDayCycleProgress.value = dayPhase;
      this.skyTSLUniforms.uDayIntensity.value = this._dayIntensity; // Sharp transition value
    }

    // Update cloud material uniforms — sun position as world-space point on sky sphere
    if (this.cloudMaterialUniforms) {
      this.cloudMaterialUniforms.uTime.value = this.elapsed;
      this.cloudMaterialUniforms.uSunPosition.value.set(
        this._sunDir.x * SKY_DOME_RADIUS,
        this._sunDir.y * SKY_DOME_RADIUS,
        this._sunDir.z * SKY_DOME_RADIUS,
      );
    }

    // Clouds are static on the ring — movement comes from the shader's
    // noise UV distortion and alpha oscillation.
  }

  override lateUpdate(_delta: number): void {
    if (!this.group) return;

    // Keep sky centered on camera for infinite effect - follow all 3 axes
    // This ensures sky never clips against draw distance regardless of camera position
    // Use camera position directly (most reliable) with rig fallback
    if (this.world.camera) {
      this.group.position.copy(this.world.camera.position);
    } else if (this.world.rig) {
      this.group.position.copy(this.world.rig.position);
    }

    // Render fog sky to offscreen render target
    this.renderFogSky();
  }

  /** Render the fog sky dome (no stars) to the shared offscreen render target. */
  private renderFogSky(): void {
    if (!this.fogScene || !this.fogCamera) return;
    const renderer = (
      this.world.graphics as { renderer?: THREE.WebGPURenderer } | undefined
    )?.renderer;
    if (!renderer) return;

    // Sync fog camera orientation with main camera (direction only)
    const cam = this.world.camera;
    if (cam) {
      this.fogCamera.position.set(0, 0, 0);
      this.fogCamera.quaternion.copy(cam.quaternion);
      this.fogCamera.projectionMatrix.copy(cam.projectionMatrix);
      this.fogCamera.projectionMatrixInverse.copy(cam.projectionMatrixInverse);

      // Resize fog render target when aspect ratio changes
      const desiredW = Math.max(
        1,
        Math.round(cam.aspect * fogRenderTarget.height),
      );
      if (fogRenderTarget.width !== desiredW) {
        fogRenderTarget.setSize(desiredW, fogRenderTarget.height);
      }
    }

    // Sync fog sky uniforms with main sky values
    if (this.fogSkyUniforms && this.skyTSLUniforms) {
      (this.fogSkyUniforms.uSunPosition as { value: THREE.Vector3 }).value.copy(
        (this.skyTSLUniforms.uSunPosition as { value: THREE.Vector3 }).value,
      );
      (this.fogSkyUniforms.uDayCycleProgress as { value: number }).value = (
        this.skyTSLUniforms.uDayCycleProgress as { value: number }
      ).value;
      (this.fogSkyUniforms.uDayIntensity as { value: number }).value = (
        this.skyTSLUniforms.uDayIntensity as { value: number }
      ).value;
    }

    // Disable tone mapping so the fog texture stores linear values.
    // Object shaders apply tone mapping once on final output — prevents double mapping.
    const savedToneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;

    const currentTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(fogRenderTarget);
    renderer.render(this.fogScene, this.fogCamera);
    renderer.setRenderTarget(currentTarget);

    renderer.toneMapping = savedToneMapping;
  }

  override destroy(): void {
    if (this.group && this.group.parent) {
      this.group.parent.remove(this.group);
    }
    if (this.skyMesh) {
      this.skyMesh.geometry.dispose();
      (this.skyMesh.material as THREE.Material).dispose();
      this.skyMesh = null;
    }
    if (this.clouds) {
      this.clouds.geometry.dispose();
      (this.clouds.material as THREE.Material).dispose();
      this.clouds = null;
    }
    if (this.sun) {
      this.sun.geometry.dispose();
      (this.sun.material as THREE.Material).dispose();
      this.sun = null;
    }
    if (this.sunGlow) {
      this.sunGlow.geometry.dispose();
      (this.sunGlow.material as THREE.Material).dispose();
      this.sunGlow = null;
    }
    // Clean up inner sun glow
    const groupWithGlow = this.group as
      (THREE.Group & { sunInnerGlow?: THREE.Mesh }) | null;
    if (groupWithGlow?.sunInnerGlow) {
      groupWithGlow.sunInnerGlow.geometry.dispose();
      (groupWithGlow.sunInnerGlow.material as THREE.Material).dispose();
      groupWithGlow.sunInnerGlow = undefined;
    }
    if (this.moon) {
      this.moon.geometry.dispose();
      (this.moon.material as THREE.Material).dispose();
      this.moon = null;
    }
    if (this.moonGlow) {
      this.moonGlow.geometry.dispose();
      (this.moonGlow.material as THREE.Material).dispose();
      this.moonGlow = null;
    }
    this.sunMaterialUniforms = null;
    this.moonMaterialUniforms = null;
    this.cloudMaterialUniforms = null;
    this.galaxyTextureUniform = null;
    this.group = null;

    // Clean up fog sky resources (render target is shared via FogConfig, not disposed here)
    if (this.fogSkyMesh) {
      this.fogSkyMesh.geometry.dispose();
      (this.fogSkyMesh.material as THREE.Material).dispose();
      this.fogSkyMesh = null;
    }
    this.fogScene = null;
    this.fogCamera = null;
    this.fogSkyUniforms = null;
  }
}

export default SkySystem;
