import THREE, { CSMShadowNode } from "../../../extras/three/three";
import { MeshBasicNodeMaterial } from "three/webgpu";

import { Node as NodeClass } from "../../../nodes/Node";
import { System } from "../infrastructure/System";

// NOTE: Import directly to avoid circular dependency through barrel file
import { SkySystem } from "./SkySystem";
import { OutdoorEnvironment } from "./OutdoorEnvironment";
import { DataManager } from "../../../data/DataManager";
import { isCompactSculptProfile } from "./WorldTerrainProfile";
import { setLamppostNightMix } from "./LamppostLightMask";
import { FOG_NEAR, FOG_FAR } from "./FogConfig";
import {
  DAY_CYCLE,
  SUN_LIGHT,
  HEMISPHERE_LIGHT,
  AMBIENT_LIGHT,
  EXPOSURE,
  FOG_COLORS,
} from "./LightingConfig";
import type {
  BaseEnvironment,
  EnvironmentModel,
  LoadedModel,
  LoaderResult,
  SkyHandle,
  SkyInfo,
  SkyNode,
  World,
  WorldOptions,
} from "../../../types/index";

const _sunDirection = new THREE.Vector3(0, -1, 0);

// CSM Shadow configuration per quality level
//
// RESOLUTION MATH:
// Each cascade covers (maxFar / cascades) meters with shadowMapSize pixels
// Example: maxFar=100, cascades=2, size=2048 → first cascade covers ~30m with 2048px = ~15px/meter
// A 0.5m character needs ~7-8 pixels to cast a visible shadow
//
// SHADOW STABILITY NOTES:
// - lightMargin: Higher values (100-200) prevent shadow "swimming" artifacts
// - shadowBias: Small positive value prevents self-shadowing (0.0001-0.001)
// - shadowNormalBias: Offsets along normal for curved surfaces (0.005-0.02)
// - More cascades = better near/far resolution but more draw calls
// - CSMShadowNode handles texel snapping internally - don't add extra snapping
//
// Set ENABLE_CSM=true to use cascaded shadow maps (heavy GPU cost).
// Default: false — uses one 4096 map, island-anchored for compact terrain.
export function isCsmEnabled(): boolean {
  try {
    if (
      typeof import.meta !== "undefined" &&
      (import.meta as any).env?.ENABLE_CSM
    )
      return (import.meta as any).env.ENABLE_CSM === "true";
    if (typeof process !== "undefined" && process.env?.ENABLE_CSM)
      return process.env.ENABLE_CSM === "true";
  } catch {
    /* ignore */
  }
  return false;
}

const SINGLE_SHADOW_MAP_SIZE = 4096;
const SINGLE_SHADOW_FRUSTUM = 200;

// IMPORTANT: Vegetation fade distances should be <= maxFar so trees don't appear unshadowed
export const csmLevels = {
  none: {
    enabled: false,
    shadowMapSize: 0,
    cascades: 1,
    maxFar: 50,
    shadowBias: 0.0003,
    shadowNormalBias: 0.01,
    lightMargin: 100,
  },
  low: {
    enabled: true,
    shadowMapSize: 2048,
    cascades: 2, // 2 cascades: near (~15m high-res) + far (~135m)
    maxFar: 150, // Reduced for better near-cascade resolution
    shadowBias: 0.0002, // Lower bias so small object shadows appear
    shadowNormalBias: 0.01,
    lightMargin: 150, // Higher margin prevents shadow swimming
  },
  med: {
    enabled: true,
    shadowMapSize: 2048,
    cascades: 3, // 3 cascades for better distribution
    maxFar: 300, // Reduced from 350 for better resolution, custom split helps near cascade
    shadowBias: 0.00015,
    shadowNormalBias: 0.008,
    lightMargin: 150, // Higher margin prevents shadow swimming
  },
  high: {
    enabled: true,
    shadowMapSize: 4096, // Higher resolution for sharp shadows
    cascades: 4, // 4 cascades for excellent near/far balance
    maxFar: 500, // Good distance with 4 cascades
    shadowBias: 0.0001,
    shadowNormalBias: 0.005,
    lightMargin: 200, // Higher margin for stability
  },
};

/**
 * Environment System
 *
 * Handles environment setup for all runtime contexts with conditional branching
 * based on runtime capabilities. Works in both browser and server contexts.
 *
 * Runtime Modes:
 *
 * **Client (Browser)** - Full 3D Rendering
 * - Loads and renders 3D environment models (.glb)
 * - Manages sky sphere with equirectangular texture mapping
 * - Controls HDR environment lighting
 * - Handles directional sun/moon lighting with configurable shadow quality
 * - Manages dynamic fog (near/far distances, color)
 * - Responds to graphics settings changes (shadows, model swaps)
 * - Updates sky position to follow camera rig (infinite distance illusion)
 *
 * **Server** - Configuration Only
 * - Skips all 3D asset loading (no rendering needed)
 * - Tracks environment settings for client synchronization
 * - Minimal memory footprint (no textures, meshes, or lights)
 * - Listens to settings changes to propagate to clients
 *
 * **Node Client (Bots)** - Headless
 * - No rendering capabilities (headless automation)
 * - Compatible interface so World doesn't require environment checks
 * - Used by ServerBot instances for automated testing
 *
 * Implementation:
 * All methods check `this.isClientWithGraphics` (computed during init):
 * - `true`: Browser with `window` object → full rendering pipeline
 * - `false`: Server or Node → early return, skip 3D operations
 */
export class Environment extends System {
  base!: BaseEnvironment;
  model: EnvironmentModel | null = null;
  skys: SkyHandle[] = [];
  sky: THREE.Mesh | null = null;
  skyN: number = 0;
  bgUrl?: string;
  hdrUrl?: string;
  skyInfo!: SkyInfo;
  private skySystem?: SkySystem;
  private outdoorEnvironment?: OutdoorEnvironment;

  /** Diagnostic receipt only; material inheritance is owned by the scene. */
  getOutdoorLightingStatus() {
    return this.outdoorEnvironment?.getStatus() ?? null;
  }

  /** Sky fog texture from SkySystem — used by terrain, water, vegetation for sky-color fog */
  get skyFogTexture(): THREE.Texture | null {
    return this.skySystem?.skyFogTexture ?? null;
  }

  // Main directional light (sun/moon) with CSM shadow support
  public sunLight: THREE.DirectionalLight | null = null;
  public lightDirection: THREE.Vector3 = new THREE.Vector3(0, -1, 0);

  // Shadow stabilization - prevents flickering/swimming
  private targetLightDirection: THREE.Vector3 = new THREE.Vector3(0, -1, 0);
  private lastLightAnchor: THREE.Vector3 = new THREE.Vector3();
  private readonly compactLightAnchor = new THREE.Vector3();
  private useCompactLightAnchor = false;
  private readonly LIGHT_DISTANCE = 400; // Distance from target to light

  private currentExposure: number = EXPOSURE.DAY;

  // CSMShadowNode for WebGPU cascaded shadows
  private csmShadowNode: InstanceType<typeof CSMShadowNode> | null = null;

  // CSM frustum update optimization - only recalculate when needed
  // Set to true on: viewport resize, camera near/far change, CSM config change
  private needsFrustumUpdate: boolean = true;
  private csmFrustumWarningShown: boolean = false; // Prevent log spam while camera initializes
  private csmNeedsAttach: boolean = false; // True until CSM shadowNode is attached to light
  private csmDeferredLogged: boolean = false; // Only log deferred message once

  // Ambient lighting for day/night cycle (non-shadow casting)
  public hemisphereLight: THREE.HemisphereLight | null = null;
  private ambientLight: THREE.AmbientLight | null = null;

  private isClientWithGraphics: boolean = false;

  constructor(world: World) {
    super(world);
  }

  override init(
    options: WorldOptions & { baseEnvironment?: BaseEnvironment },
  ): Promise<void> {
    this.base = options.baseEnvironment || {};

    // Determine if this is a client with graphics capabilities
    this.isClientWithGraphics =
      !!this.world.isClient && typeof window !== "undefined";

    return Promise.resolve();
  }

  override async start() {
    if (!this.isClientWithGraphics) {
      // Server or Node client - skip 3D rendering setup

      // Still watch for settings changes (for server to track what clients should use)
      this.world.settings?.on("change", this.onSettingsChange);
      return;
    }

    // Client with graphics - full environment setup
    // Create sun light immediately - stage should be ready by start()
    this.buildSunLight();

    // Initialize CSM frustums immediately if camera is ready
    // This ensures shadows work from the first frame
    this.initializeCSMFrustums();

    // Create ambient lighting for day/night visibility
    this.createAmbientLighting();

    this.updateSky();

    // Load initial model (non-blocking - don't let model errors break sky)
    try {
      await this.updateModel();
    } catch (err) {
      console.warn(
        "[Environment] Failed to load model (continuing without):",
        err,
      );
    }

    // Enhanced dynamic sky (client-only) - must run even if model fails
    this.skySystem = new SkySystem(this.world);
    await this.skySystem.init({} as unknown as WorldOptions);
    this.skySystem.start();

    // Initialize exposure based on current time of day to avoid jarring transitions
    // when joining at night (otherwise exposure would lerp from 0.85 day → 1.7 night)
    this.initializeExposure();

    // Ensure legacy sky sphere never occludes dynamic sky
    if (this.sky) {
      const mat = this.sky.material as THREE.MeshBasicMaterial;
      mat.depthWrite = false;
      this.sky.visible = false;
    }
    // Re-evaluate sky state now that SkySystem exists
    await this.updateSky();

    // Prepare one shared sky IBL before world startup completes. Standard PBR
    // actors, equipment and terrain inherit it; planar water remains separate.
    if (this.world.stage?.scene && this.world.graphics) {
      this.outdoorEnvironment = new OutdoorEnvironment(this.world.stage.scene);
      await this.outdoorEnvironment.initialize(
        this.world.graphics,
        this.skySystem.createLightingCapture(),
        this.skySystem.dayPhase,
      );
      this.updateAmbientLighting(this.skySystem.dayIntensity);
    }

    this.world.settings?.on("change", this.onSettingsChange);
    this.world.prefs?.on("change", this.onPrefsChange);

    if (this.world.graphics) {
      this.world.graphics.on("resize", this.onViewportResize);
    }
  }

  async updateModel() {
    if (!this.isClientWithGraphics) {
      // Server/Node - skip model loading (no rendering)
      return;
    }

    const modelSetting = this.world.settings?.model;
    const modelSettingObject =
      typeof modelSetting === "object" && modelSetting !== null
        ? (modelSetting as { url?: string })
        : null;
    const url =
      (typeof modelSetting === "string"
        ? modelSetting
        : modelSettingObject?.url) || this.base.model;
    if (!url) return;

    let glb = this.world.loader?.get("model", url);
    if (!glb)
      glb = (await this.world.loader?.load("model", url)) as
        LoaderResult | undefined;
    if (!glb) return;

    if (this.model) this.model.deactivate();

    if (glb && "toNodes" in glb) {
      const nodesResult = (glb as LoadedModel).toNodes();
      const nodes = nodesResult as Map<string, NodeClass> | EnvironmentModel;
      const environmentModel = nodes as EnvironmentModel;

      if (
        nodes &&
        "activate" in environmentModel &&
        "deactivate" in environmentModel
      ) {
        this.model = environmentModel;
        this.model.activate({ world: this.world, label: "base" });
      } else if (nodes && nodes instanceof Map) {
        const nodeMap = nodes as Map<string, NodeClass>;
        this.model = {
          deactivate: () => {
            for (const node of nodeMap.values()) {
              if (node && node.deactivate) {
                node.deactivate();
              }
            }
          },
          activate: (options: { world: World; label: string }) => {
            for (const node of nodeMap.values()) {
              if (node && node.activate) {
                node.activate(options.world);
              } else if (node && options.world.stage) {
                options.world.stage.add(node);
              }
            }
          },
        };
        this.model.activate({ world: this.world, label: "base" });
      } else {
        this.model = null;
      }
    } else {
      this.model = null;
    }
  }

  addSky(node: SkyNode) {
    if (!this.isClientWithGraphics) return { destroy: () => {} };

    const handle: SkyHandle = {
      node,
      destroy: () => {
        const idx = this.skys.indexOf(handle);
        if (idx === -1) return;
        this.skys.splice(idx, 1);
        this.updateSky();
      },
    };
    this.skys.push(handle);
    this.updateSky();
    return handle;
  }

  getSky() {}

  async updateSky() {
    if (!this.isClientWithGraphics) return;

    // Check if stage is available
    if (!this.world.stage || !this.world.stage.scene) {
      console.warn(
        "[Environment] Stage not available for updateSky, deferring...",
      );
      setTimeout(() => this.updateSky(), 100);
      return;
    }

    if (!this.sky) {
      const geometry = new THREE.SphereGeometry(1000, 60, 40);
      // Use MeshBasicNodeMaterial for WebGPU compatibility
      const material = new MeshBasicNodeMaterial();
      material.side = THREE.BackSide;
      this.sky = new THREE.Mesh(geometry, material);
      this.sky.geometry.computeBoundsTree();
      const skyMaterial = this.sky.material as {
        fog?: boolean;
        toneMapped?: boolean;
        needsUpdate?: boolean;
      };
      skyMaterial.fog = false;
      skyMaterial.toneMapped = false;
      skyMaterial.needsUpdate = true;
      this.sky.matrixAutoUpdate = false;
      this.sky.matrixWorldAutoUpdate = false;
      this.sky.visible = false;
      // PERFORMANCE: Set legacy sky to layer 1 (main camera only, not minimap)
      this.sky.layers.set(1);
      this.world.stage.scene.add(this.sky);
    }

    const base = this.base;
    const node = this.skys[this.skys.length - 1]?.node;
    const bgUrl = node?._bg || base.bg;
    const hdrUrl = node?._hdr || base.hdr;
    const sunDirection = node?._sunDirection || base.sunDirection;

    const sunIntensity = node?._sunIntensity ?? base.sunIntensity;
    const sunColor = node?._sunColor ?? base.sunColor;
    const fogNear = node?._fogNear ?? base.fogNear ?? FOG_NEAR;
    const fogFar = node?._fogFar ?? base.fogFar ?? FOG_FAR;
    const fogColor = node?._fogColor ?? base.fogColor ?? "#d4c8b8";

    const n = ++this.skyN;
    // Load textures (kept for potential future use, currently SkySystem is active)
    let _bgTexture;
    if (bgUrl) _bgTexture = await this.world.loader?.load("texture", bgUrl);
    let _hdrTexture;
    if (hdrUrl) _hdrTexture = await this.world.loader?.load("hdr", hdrUrl);
    if (n !== this.skyN) return;

    // When using SkySystem, completely remove the legacy sky sphere from scene
    // Just hiding it isn't enough - it can still interfere with planar reflections
    this.sky.visible = false;
    if (this.sky.parent) {
      this.sky.parent.remove(this.sky);
    }
    // The procedural sky owns the visible background; IBL is independent and
    // must survive shadow preference/legacy sky refreshes.
    this.world.stage.scene.background = null;

    // Set initial light direction and apply to sun light
    this.lightDirection.copy(sunDirection || _sunDirection);
    if (this.sunLight) {
      this.sunLight.intensity = sunIntensity || 1;
      this.sunLight.color.set(sunColor || "#ffffff");
    }

    // Always apply fog with defaults
    const color = new THREE.Color(fogColor);
    this.world.stage.scene.fog = new THREE.Fog(
      color,
      fogNear as number,
      fogFar as number,
    );

    this.skyInfo = {
      bgUrl,
      hdrUrl,
      sunDirection: sunDirection || _sunDirection,
      sunIntensity: sunIntensity || 1,
      sunColor: sunColor || "#ffffff",
      fogNear,
      fogFar,
      fogColor,
    };
  }

  override destroy(): void {
    this.outdoorEnvironment?.dispose();
    this.outdoorEnvironment = undefined;
    if (this.skySystem) {
      this.skySystem.destroy();
      this.skySystem = undefined;
    }
    this.world.settings?.off("change", this.onSettingsChange);
    this.world.prefs?.off("change", this.onPrefsChange);

    if (!this.isClientWithGraphics) return;

    if (this.world.graphics) {
      this.world.graphics.off("resize", this.onViewportResize);
    }

    // Dispose sky mesh and textures
    if (this.sky) {
      const material = this.sky.material as THREE.Material & {
        map?: THREE.Texture | null;
      };
      if (material && "map" in material && material.map) {
        material.map.dispose();
        // NOTE: Don't set material.map = null - let Three.js/GC handle it
        // Setting it to null causes WebGPU texture cache corruption
        // with dual-renderer setup (main + minimap share scene)
      }
      if (Array.isArray(this.sky.material)) {
        this.sky.material.forEach((m) => m.dispose());
      } else {
        (this.sky.material as THREE.Material).dispose();
      }
      this.sky.geometry.dispose();
      if (this.sky.parent) this.sky.parent.remove(this.sky);
      this.sky = null;
    }

    // Dispose sun light and CSM
    if (this.csmShadowNode) {
      this.csmShadowNode.dispose();
      this.csmShadowNode = null;
    }
    if (this.sunLight) {
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
      }
      if (this.sunLight.parent) {
        this.sunLight.parent.remove(this.sunLight.target);
        this.sunLight.parent.remove(this.sunLight);
      }
      this.sunLight.dispose();
      this.sunLight = null;
    }

    // Dispose ambient lights
    if (this.hemisphereLight) {
      if (this.hemisphereLight.parent) {
        this.hemisphereLight.parent.remove(this.hemisphereLight);
      }
      this.hemisphereLight.dispose();
      this.hemisphereLight = null;
    }

    if (this.ambientLight) {
      if (this.ambientLight.parent) {
        this.ambientLight.parent.remove(this.ambientLight);
      }
      this.ambientLight.dispose();
      this.ambientLight = null;
    }

    this.skys = [];
    this.model = null;
  }

  override update(_delta: number) {
    if (!this.isClientWithGraphics) return;

    // Update sky system first to get current sun position
    if (this.skySystem) {
      this.skySystem.update(_delta);
      this.outdoorEnvironment?.update(this.skySystem.dayPhase);

      // Sync directional light (sun/moon) with sky position
      if (this.sunLight) {
        const dayIntensity = this.skySystem.dayIntensity;
        const isDay = this.skySystem.isDay;
        const dayPhase = this.skySystem.dayPhase;

        // ===================
        // TRANSITION FADE - fade light out during sun/moon swap
        // ===================
        let transitionFade = 1.0;
        if (dayPhase >= DAY_CYCLE.DAWN_START && dayPhase < DAY_CYCLE.DAWN_MID) {
          transitionFade =
            1.0 -
            (dayPhase - DAY_CYCLE.DAWN_START) /
              (DAY_CYCLE.DAWN_MID - DAY_CYCLE.DAWN_START);
        } else if (
          dayPhase >= DAY_CYCLE.DAWN_MID &&
          dayPhase < DAY_CYCLE.DAWN_END
        ) {
          transitionFade =
            (dayPhase - DAY_CYCLE.DAWN_MID) /
            (DAY_CYCLE.DAWN_END - DAY_CYCLE.DAWN_MID);
        } else if (
          dayPhase >= DAY_CYCLE.DUSK_START &&
          dayPhase < DAY_CYCLE.DUSK_MID
        ) {
          transitionFade =
            1.0 -
            (dayPhase - DAY_CYCLE.DUSK_START) /
              (DAY_CYCLE.DUSK_MID - DAY_CYCLE.DUSK_START);
        } else if (
          dayPhase >= DAY_CYCLE.DUSK_MID &&
          dayPhase < DAY_CYCLE.DUSK_END
        ) {
          transitionFade =
            (dayPhase - DAY_CYCLE.DUSK_MID) /
            (DAY_CYCLE.DUSK_END - DAY_CYCLE.DUSK_MID);
        }
        transitionFade =
          transitionFade * transitionFade * (3 - 2 * transitionFade); // smoothstep

        // ===================
        // LIGHT DIRECTION - Track sun during day, moon during night
        // Use target direction + interpolation to prevent sudden jumps
        // ===================
        if (isDay) {
          this.targetLightDirection.copy(this.skySystem.sunDirection).negate();
        } else {
          this.targetLightDirection.copy(this.skySystem.sunDirection);
        }

        this.lightDirection.lerp(
          this.targetLightDirection,
          SUN_LIGHT.DIRECTION_LERP,
        );

        // ===================
        // LIGHT INTENSITY & COLOR - Single light, simple and correct
        // ===================
        if (isDay) {
          const sunIntensity =
            dayIntensity * SUN_LIGHT.DAY_INTENSITY_MULTIPLIER * transitionFade;
          this.sunLight.intensity = sunIntensity;

          const nearHorizon = SUN_LIGHT.GOLDEN_HOUR_RANGES.some(
            ([start, end]) => dayPhase >= start && dayPhase < end,
          );
          if (nearHorizon) {
            this.sunLight.color.setRGB(...SUN_LIGHT.GOLDEN_HOUR_COLOR);
          } else {
            this.sunLight.color.setRGB(...SUN_LIGHT.DAY_COLOR);
          }
        } else {
          const nightIntensity = 1 - dayIntensity;
          const moonIntensity =
            nightIntensity *
            SUN_LIGHT.MOON_INTENSITY_MULTIPLIER *
            transitionFade;
          this.sunLight.intensity = moonIntensity;
          this.sunLight.color.setRGB(...SUN_LIGHT.MOON_COLOR);
        }

        // ===================
        // UPDATE LIGHT POSITION - Use the active world/shadow anchor
        // ===================
        this.updateSunLightPosition();
      }

      // Update ambient lighting based on day/night
      this.updateAmbientLighting(this.skySystem.dayIntensity);

      // Update auto exposure based on day/night cycle
      // Higher exposure at night mimics eye adaptation - keeps things visible while still darker
      this.updateAutoExposure(this.skySystem.dayIntensity);

      // Update fog color based on day/night cycle
      this.updateFogColor(this.skySystem.dayIntensity);

      // Update grass lighting based on day/night
      this.updateGrassLighting(this.skySystem.dayIntensity);

      // Update lamppost night mix (for baked lighting masks)
      this.updateLamppostNightMix(this.skySystem.dayIntensity);
    }

    // Ensure sky sphere never writes depth (prevents cutting moon)
    if (this.sky) {
      const m = this.sky.material as THREE.MeshBasicMaterial;
      if (m.depthWrite !== false) m.depthWrite = false;
    }
  }

  override commit(): void {
    if (!this.isClientWithGraphics) return;
    this.updateCSMFrustumsIfNeeded();
  }

  /**
   * Get day intensity (0 = night, 1 = full day)
   * Used by other systems for night-only effects.
   */
  getDayIntensity(): number {
    return this.skySystem?.dayIntensity ?? 1;
  }

  /**
   * Compact single-map shadows stay anchored to the island, not the altitude of
   * an overview camera. Camera cuts therefore cannot translate the shadow volume
   * above the ground. This is not an all-world depth/texel-quality certificate.
   * CSM retains its camera anchor and internal per-cascade fitting/snapping.
   * The existing interpolated light ray is deliberately not normalized here.
   */
  private updateSunLightPosition(): void {
    if (!this.sunLight) return;

    this.lastLightAnchor.copy(
      this.useCompactLightAnchor
        ? this.compactLightAnchor
        : this.world.camera.position,
    );

    // Position light OPPOSITE to light direction (light comes FROM this position)
    this.sunLight.position.set(
      this.lastLightAnchor.x - this.lightDirection.x * this.LIGHT_DISTANCE,
      this.lastLightAnchor.y -
        this.lightDirection.y * this.LIGHT_DISTANCE +
        100,
      this.lastLightAnchor.z - this.lightDirection.z * this.LIGHT_DISTANCE,
    );

    // Target and light translate together, preserving direction and radiometry.
    this.sunLight.target.position.copy(this.lastLightAnchor);
    this.sunLight.target.updateMatrixWorld();

    // CSM frustum updates are handled after render in commit().
  }

  /**
   * Update CSM frustums only when needed (expensive operation).
   * Runs after render to ensure the CSM shadow node has initialized.
   */
  private updateCSMFrustumsIfNeeded(): void {
    if (!this.csmShadowNode || !this.needsFrustumUpdate) {
      return;
    }

    const graphics = this.world.graphics;
    if (!graphics || graphics.hasRendered !== true) {
      return;
    }

    // Pre-flight checks: ensure camera has valid projection before CSM update
    const camera = this.csmShadowNode.camera as THREE.PerspectiveCamera | null;
    if (!camera) {
      // CSMShadowNode initializes its camera during renderer setup.
      return;
    }
    const hasValidAspect = camera.aspect > 0;
    const hasValidFov = camera.fov > 0;
    const hasValidNearFar = camera.near > 0 && camera.far > camera.near;

    if (!hasValidAspect || !hasValidFov || !hasValidNearFar) {
      // Camera not fully configured yet - skip this frame
      // This is normal during startup, will succeed on next frame
      return;
    }

    // Ensure camera matrices are fully up to date before frustum calculation
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    try {
      this.csmShadowNode.updateFrustums();
      this.needsFrustumUpdate = false;
      this.csmFrustumWarningShown = false;
      this.csmDeferredLogged = false; // Reset so future issues can be logged

      // After successful frustum init, attach shadowNode to light
      // We defer this because CSM shader will crash if frustums aren't initialized
      if (this.csmNeedsAttach && this.sunLight) {
        (
          this.sunLight.shadow as THREE.DirectionalLightShadow & {
            shadowNode?: InstanceType<typeof CSMShadowNode>;
          }
        ).shadowNode = this.csmShadowNode;
        this.csmNeedsAttach = false;
        console.log("[Environment] CSM shadowNode attached to light");
      }
    } catch {
      // CSMShadowNode.updateFrustums() can fail if camera projection isn't ready yet
      // Will retry on next update() - this is expected during startup
      if (!this.csmDeferredLogged) {
        console.debug(
          "[Environment] CSM frustum update deferred - camera not ready (this message will only appear once)",
        );
        this.csmDeferredLogged = true;
      }
    }
  }

  /**
   * Update ambient lighting based on day/night cycle
   * @param dayIntensity 0-1 (0 = night, 1 = day)
   */
  private updateAmbientLighting(dayIntensity: number): void {
    // The calibrated environment replaces this fill budget, not adds to it.
    // Keep analytic lights available during preparation and on server-free
    // legacy test worlds, but never double-count them in the ready scene.
    if (this.outdoorEnvironment?.ready) {
      if (this.hemisphereLight) this.hemisphereLight.intensity = 0;
      if (this.ambientLight) this.ambientLight.intensity = 0;
      return;
    }
    const nightIntensity = 1 - dayIntensity;

    if (this.hemisphereLight) {
      this.hemisphereLight.intensity =
        HEMISPHERE_LIGHT.INTENSITY_BASE +
        dayIntensity * HEMISPHERE_LIGHT.INTENSITY_DAY_ADD;

      const [dR, dG, dB] = HEMISPHERE_LIGHT.DAY_SKY_COLOR;
      const [nR, nG, nB] = HEMISPHERE_LIGHT.NIGHT_SKY_COLOR;
      this.hemisphereLight.color.setRGB(
        dR * dayIntensity + nR * nightIntensity,
        dG * dayIntensity + nG * nightIntensity,
        dB * dayIntensity + nB * nightIntensity,
      );

      const [dgR, dgG, dgB] = HEMISPHERE_LIGHT.DAY_GROUND_COLOR;
      const [ngR, ngG, ngB] = HEMISPHERE_LIGHT.NIGHT_GROUND_COLOR;
      this.hemisphereLight.groundColor.setRGB(
        dgR * dayIntensity + ngR * nightIntensity,
        dgG * dayIntensity + ngG * nightIntensity,
        dgB * dayIntensity + ngB * nightIntensity,
      );
    }

    if (this.ambientLight) {
      this.ambientLight.intensity =
        AMBIENT_LIGHT.INTENSITY_BASE +
        dayIntensity * AMBIENT_LIGHT.INTENSITY_DAY_ADD;

      const [adR, adG, adB] = AMBIENT_LIGHT.DAY_COLOR;
      const [anR, anG, anB] = AMBIENT_LIGHT.NIGHT_COLOR;
      this.ambientLight.color.setRGB(
        anR + dayIntensity * (adR - anR),
        anG + dayIntensity * (adG - anG),
        anB + dayIntensity * (adB - anB),
      );
    }
  }

  /**
   * Initialize exposure to match current time of day.
   * Called once during start() after skySystem is ready to prevent jarring
   * transitions when players join at night (would otherwise lerp from day to night).
   */
  private initializeExposure(): void {
    if (!this.skySystem) return;

    // Calculate target exposure based on current dayIntensity using same formula as update
    const dayIntensity = this.skySystem.dayIntensity;
    const t = dayIntensity * dayIntensity * (3 - 2 * dayIntensity); // smoothstep
    this.currentExposure = EXPOSURE.NIGHT + (EXPOSURE.DAY - EXPOSURE.NIGHT) * t;

    // Apply immediately to renderer
    const graphics = this.world.graphics as
      { renderer?: { toneMappingExposure?: number } } | undefined;
    if (graphics?.renderer) {
      graphics.renderer.toneMappingExposure = this.currentExposure;
    }
  }

  /**
   * Update auto exposure based on day/night cycle
   * Mimics eye adaptation - higher exposure at night compensates for lower light
   * @param dayIntensity 0-1 (0 = night, 1 = day)
   */
  private updateAutoExposure(dayIntensity: number): void {
    const graphics = this.world.graphics as
      { renderer?: { toneMappingExposure?: number } } | undefined;
    if (!graphics?.renderer) return;
    // Using smoothstep for natural-feeling transitions
    const t = dayIntensity * dayIntensity * (3 - 2 * dayIntensity); // smoothstep
    const targetExposure = EXPOSURE.NIGHT + (EXPOSURE.DAY - EXPOSURE.NIGHT) * t;

    this.currentExposure +=
      (targetExposure - this.currentExposure) * EXPOSURE.LERP_SPEED;

    // Apply to renderer
    graphics.renderer.toneMappingExposure = this.currentExposure;
  }

  private readonly dayFogColor = new THREE.Color(FOG_COLORS.DAY);
  private readonly nightFogColor = new THREE.Color(FOG_COLORS.NIGHT);
  private readonly blendedFogColor = new THREE.Color();

  /**
   * Update fog color based on day/night cycle
   * Day: warm beige fog
   * Night: dark blue fog that blends with the night sky/horizon
   * @param dayIntensity 0-1 (0 = night, 1 = day)
   */
  private updateFogColor(dayIntensity: number): void {
    if (!this.world.stage?.scene) return;

    // Lerp between night fog (dark blue) and day fog (warm beige)
    this.blendedFogColor.lerpColors(
      this.nightFogColor,
      this.dayFogColor,
      dayIntensity,
    );

    // Update scene fog color
    const sceneFog = this.world.stage.scene.fog as THREE.Fog | null;
    if (sceneFog) {
      sceneFog.color.copy(this.blendedFogColor);
    }

    // Update skyInfo so terrain shader can sync the fog color
    if (this.skyInfo) {
      this.skyInfo.fogColor = `#${this.blendedFogColor.getHexString()}`;
    }
  }

  /**
   * Update grass lighting based on day/night cycle
   * @param dayIntensity 0-1 (0 = night, 1 = day)
   */
  private updateGrassLighting(dayIntensity: number): void {
    // Get the grass system - registered as "grass" in createClientWorld.ts
    const grassSystem = this.world.getSystem("grass") as {
      setDayNightMix?: (mix: number) => void;
      setSunDirection?: (x: number, y: number, z: number) => void;
      setTerrainLighting?: (ambient: number, diffuse: number) => void;
    } | null;

    if (!grassSystem) return;

    // Pass the day/night mix value
    if (grassSystem.setDayNightMix) {
      grassSystem.setDayNightMix(dayIntensity);
    }

    // Pass the sun direction (negated light direction = direction TO sun)
    if (grassSystem.setSunDirection) {
      // lightDirection points FROM the light, we need direction TO the light
      const sunDir = this.lightDirection.clone().negate();
      grassSystem.setSunDirection(sunDir.x, sunDir.y, sunDir.z);
    }

    // Adjust terrain lighting based on time of day
    if (grassSystem.setTerrainLighting) {
      // More ambient at night, more diffuse during day
      const ambient = 0.3 + (1 - dayIntensity) * 0.3; // 0.3 day, 0.6 night
      const diffuse = dayIntensity * 0.7; // 0.7 day, 0 night
      grassSystem.setTerrainLighting(ambient, diffuse);
    }
  }

  /**
   * Update lamppost night mix for baked lighting masks.
   */
  private updateLamppostNightMix(dayIntensity: number): void {
    const night = 1 - dayIntensity;
    const t = Math.max(0, Math.min(1, (night - 0.4) / 0.3));
    const nightMix = t * t * (3 - 2 * t);
    setLamppostNightMix(nightMix);
  }

  override lateUpdate(_delta: number) {
    if (!this.isClientWithGraphics) return;
    if (this.skySystem) {
      this.skySystem.lateUpdate(_delta);
    }
    if (!this.sky) return;

    this.sky.position.x = this.world.rig.position.x;
    this.sky.position.z = this.world.rig.position.z;
    this.sky.matrixWorld.setPosition(this.sky.position);
  }

  /**
   * Create ambient lighting for proper day/night visibility
   * - HemisphereLight: Sky/ground ambient (always on, provides base visibility)
   * - AmbientLight: Flat ambient fill (stronger at night)
   */
  private createAmbientLighting(): void {
    if (!this.isClientWithGraphics || !this.world.stage?.scene) return;

    const scene = this.world.stage.scene;

    this.hemisphereLight = new THREE.HemisphereLight(
      HEMISPHERE_LIGHT.INITIAL_SKY_COLOR,
      HEMISPHERE_LIGHT.INITIAL_GROUND_COLOR,
      HEMISPHERE_LIGHT.INITIAL_INTENSITY,
    );
    this.hemisphereLight.name = "EnvironmentHemisphereLight";
    scene.add(this.hemisphereLight);

    this.ambientLight = new THREE.AmbientLight(
      AMBIENT_LIGHT.INITIAL_COLOR,
      AMBIENT_LIGHT.INITIAL_INTENSITY,
    );
    this.ambientLight.name = "EnvironmentAmbientLight";
    scene.add(this.ambientLight);
  }

  /**
   * Build directional light (sun/moon) with optional CSMShadowNode.
   * Shadow quality "none" retains directional illumination without shadow maps.
   * When ENABLE_CSM=true: uses cascaded shadow maps (multiple passes, heavy).
   * When ENABLE_CSM=false: one map, fixed to admitted compact terrain when present.
   */
  buildSunLight(): void {
    if (!this.isClientWithGraphics) return;

    const useWebGPU = this.world.graphics?.isWebGPU !== false;
    const shadowsLevel = this.world.prefs?.shadows || "med";
    const csmConfig =
      csmLevels[shadowsLevel as keyof typeof csmLevels] || csmLevels.med;
    const useCSM = isCsmEnabled() && csmConfig.enabled;

    if (!this.world.stage?.scene) {
      console.warn(
        "[Environment] Stage not available yet, deferring sun light creation",
      );
      return;
    }

    const scene = this.world.stage.scene;

    // Startup/quality-change only: no per-frame terrain sampling, scene traversal
    // or allocation. DataManager already admitted and froze this world profile.
    this.useCompactLightAnchor = false;
    if (!useCSM && csmConfig.enabled && DataManager.getWorldConfig()) {
      const profile = DataManager.getWorldTerrainProfile();
      if (isCompactSculptProfile(profile)) {
        this.compactLightAnchor.set(
          profile.island.centerX,
          profile.height.baseOffset,
          profile.island.centerZ,
        );
        this.useCompactLightAnchor = true;
      }
    }

    // Dispose existing light and CSM
    if (this.csmShadowNode) {
      this.csmShadowNode.dispose();
      this.csmShadowNode = null;
    }
    if (this.sunLight) {
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
      }
      if (this.sunLight.parent) {
        this.sunLight.parent.remove(this.sunLight.target);
        this.sunLight.parent.remove(this.sunLight);
      }
      this.sunLight.dispose();
      this.sunLight = null;
    }

    // Create directional light
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.8);
    this.sunLight.castShadow = csmConfig.enabled;

    if (!csmConfig.enabled) {
      // Shadow quality controls occlusion, not sun/moon illumination.
      this.sunLight.name = "SunLight_NoShadows";
      this.sunLight.position.set(100, 200, 100);
      this.sunLight.target.position.set(0, 0, 0);
    } else if (useCSM) {
      // ---- CSM PATH ----
      this.sunLight.name = useWebGPU ? "SunLight_CSM" : "SunLight_WebGL";
      this.sunLight.shadow.mapSize.width = csmConfig.shadowMapSize;
      this.sunLight.shadow.mapSize.height = csmConfig.shadowMapSize;
      this.sunLight.shadow.bias = csmConfig.shadowBias;
      this.sunLight.shadow.normalBias = csmConfig.shadowNormalBias;

      const shadowCam = this.sunLight.shadow.camera;
      shadowCam.near = 0.5;
      shadowCam.far = this.LIGHT_DISTANCE + 200;
      const baseFrustumSize = 100;
      shadowCam.left = -baseFrustumSize;
      shadowCam.right = baseFrustumSize;
      shadowCam.top = baseFrustumSize;
      shadowCam.bottom = -baseFrustumSize;
      shadowCam.updateProjectionMatrix();

      this.sunLight.position.set(100, 200, 100);
      this.sunLight.target.position.set(0, 0, 0);

      const customSplitCallback = (
        cascades: number,
        near: number,
        far: number,
        breaks: number[],
      ) => {
        const lambda = 0.8;
        for (let i = 1; i < cascades; i++) {
          const log = (near * Math.pow(far / near, i / cascades)) / far;
          const uniform = (near + ((far - near) * i) / cascades) / far;
          breaks.push(lambda * log + (1 - lambda) * uniform);
        }
        breaks.push(1);
      };

      this.csmShadowNode = new CSMShadowNode(this.sunLight, {
        cascades: csmConfig.cascades,
        maxFar: csmConfig.maxFar,
        mode: "custom",
        customSplitsCallback: customSplitCallback,
        lightMargin: csmConfig.lightMargin,
      });
      this.csmShadowNode.fade = true;

      const shadow = this.sunLight.shadow as THREE.DirectionalLightShadow & {
        shadowNode?: InstanceType<typeof CSMShadowNode>;
      };
      shadow.shadowNode = this.csmShadowNode;
      this.needsFrustumUpdate = true;

      console.log(
        `[Environment] CSM shadows enabled (${csmConfig.cascades} cascades, ${csmConfig.shadowMapSize}px)`,
      );
    } else {
      // ---- SINGLE SHADOW MAP PATH (default) ----
      this.sunLight.name = "SunLight_Single";
      this.sunLight.shadow.mapSize.width = SINGLE_SHADOW_MAP_SIZE;
      this.sunLight.shadow.mapSize.height = SINGLE_SHADOW_MAP_SIZE;
      this.sunLight.shadow.bias = 0.0002;
      this.sunLight.shadow.normalBias = 0.01;

      const shadowCam = this.sunLight.shadow.camera;
      shadowCam.near = 0.5;
      shadowCam.far = this.LIGHT_DISTANCE + 200;
      shadowCam.left = -SINGLE_SHADOW_FRUSTUM;
      shadowCam.right = SINGLE_SHADOW_FRUSTUM;
      shadowCam.top = SINGLE_SHADOW_FRUSTUM;
      shadowCam.bottom = -SINGLE_SHADOW_FRUSTUM;
      shadowCam.updateProjectionMatrix();

      this.sunLight.position.set(100, 200, 100);
      this.sunLight.target.position.set(0, 0, 0);
      this.csmShadowNode = null;

      console.log(
        `[Environment] Single shadow map (${SINGLE_SHADOW_MAP_SIZE}px, ${SINGLE_SHADOW_FRUSTUM}m frustum)`,
      );
    }

    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
    if (this.useCompactLightAnchor) this.updateSunLightPosition();
  }

  /**
   * Initialize CSM frustums after the renderer has rendered at least once.
   * If initialization fails, it will be retried during update().
   */
  private initializeCSMFrustums(): void {
    if (!this.csmShadowNode || !this.needsFrustumUpdate) return;

    const camera = this.csmShadowNode.camera as THREE.PerspectiveCamera | null;
    if (!camera) {
      return;
    }

    // Validate camera is properly configured
    if (camera.aspect <= 0 || camera.fov <= 0 || camera.near <= 0) {
      return;
    }

    // Update camera matrices before frustum calculation
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const graphics = this.world.graphics;
    if (!graphics || graphics.hasRendered !== true) {
      return;
    }

    try {
      this.csmShadowNode.updateFrustums();
      this.needsFrustumUpdate = false;
      this.csmFrustumWarningShown = false;
    } catch (_error) {
      // Will be retried during update() - this is expected during startup
      if (!this.csmFrustumWarningShown) {
        this.csmFrustumWarningShown = true;
      }
    }
  }

  onSettingsChange = (changes: { model?: string | { url?: string } }) => {
    if (changes.model) {
      this.updateModel();
    }
  };

  onPrefsChange = (changes: { shadows?: string }) => {
    if (changes.shadows) {
      this.buildSunLight();
      this.updateSky();
    }
  };

  onViewportResize = () => {
    // CSM frustums need recalculation when viewport/camera changes
    this.needsFrustumUpdate = true;
  };
}
