/**
 * GlowParticleManager - GPU-Instanced Glow / Billboard Particle System
 *
 * Centralises all glow-style particle rendering into 4 InstancedMesh pools
 * (pillar, wisp, spark, base) driven by TSL NodeMaterials.
 *
 * Consumers register a **preset** (e.g. `"altar"`) and the manager handles
 * all layer construction, per-particle randomisation, CPU-side age tracking,
 * respawn, and GPU-driven billboard rendering internally.
 *
 * Follows the same patterns as WaterParticleManager:
 *   - Free-slot allocation per pool
 *   - CPU age advancement + respawn each frame
 *   - TSL NodeMaterial with per-instance InstancedBufferAttributes
 *   - Billboard via camera right/up uniforms
 *
 * Per-instance attributes (per pool):
 *   emitterPos      (vec3)  – emitter world center
 *   ageLifetime     (vec2)  – current age (x), total lifetime (y)
 *   spawnOffset     (vec3)  – motion-specific spawn parameters
 *   dynamics        (vec4)  – motion-specific animation parameters
 *   colorSharpness  (vec4)  – rgb colour (xyz), glow sharpness exponent (w)
 *
 * @module GlowParticleManager
 */

import * as THREE from "../../../extras/three/three";
import type { Node, UniformNode } from "three/webgpu";
import {
  attribute,
  uniform,
  MeshBasicNodeMaterial,
  uv,
  float,
  vec2,
  vec3,
  mul,
  add,
  sub,
  div,
  sin,
  cos,
  pow,
  min,
  max,
  mix,
  fract,
  dot,
  smoothstep,
  floor as tslFloor,
  time,
  positionLocal,
} from "../../../extras/three/three";

// =============================================================================
// POOL SIZES
// =============================================================================

const MAX_PILLAR = 32;
const MAX_WISP = 192;
const MAX_SPARK = 256;
const MAX_BASE = 96;
const MAX_RISE_SPREAD = 896;

// =============================================================================
// HELPERS
// =============================================================================

function hexToRgb(hex: number): [number, number, number] {
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
}

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/** Available built-in presets. */
export type GlowPreset = "altar" | "fire";

/**
 * Configuration passed to `registerGlow`.
 *
 * Only `preset` and `position` are required; everything else has sensible
 * defaults derived from the preset definition.
 */
export interface GlowConfig {
  preset: GlowPreset;
  position: { x: number; y: number; z: number };
  /** Colour override – single hex or three-tone palette. */
  color?: number | { core: number; mid: number; outer: number };
  /** Mesh root for geometry-aware spark placement (altar preset). */
  meshRoot?: THREE.Object3D;
  /** Scale of the loaded model (default 1.0). */
  modelScale?: number;
  /** Vertical offset applied to the model (default 0). */
  modelYOffset?: number;
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

type MotionType = "pillar" | "wisp" | "spark" | "base" | "riseSpread";

interface MeshGeometry {
  surfacePoints: Float32Array;
  surfaceCount: number;
  radiusXZ: number;
  minY: number;
  maxY: number;
}

interface PoolLayer {
  mesh: THREE.InstancedMesh;
  maxCount: number;
  freeSlots: number[];
  emitterPosArr: Float32Array;
  ageLifetimeArr: Float32Array;
  spawnOffsetArr: Float32Array;
  dynamicsArr: Float32Array;
  colorSharpnessArr: Float32Array;
  emitterPosAttr: THREE.InstancedBufferAttribute;
  ageLifetimeAttr: THREE.InstancedBufferAttribute;
  spawnOffsetAttr: THREE.InstancedBufferAttribute;
  dynamicsAttr: THREE.InstancedBufferAttribute;
  colorSharpnessAttr: THREE.InstancedBufferAttribute;
}

interface EmitterRecord {
  preset: GlowPreset;
  position: { x: number; y: number; z: number };
  slots: Map<MotionType, number[]>;
  meshData?: MeshGeometry;
}

// =============================================================================
// GLOW PARTICLE MANAGER
// =============================================================================

export class GlowParticleManager {
  private scene: THREE.Scene;
  private pools = new Map<MotionType, PoolLayer>();
  private emitters = new Map<string, EmitterRecord>();

  private uCameraRight: UniformNode<"vec3", THREE.Vector3>;
  private uCameraUp: UniformNode<"vec3", THREE.Vector3>;
  private readonly _tmpRight = new THREE.Vector3();
  private readonly _tmpUp = new THREE.Vector3();
  private readonly _tmpFwd = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.uCameraRight = uniform(new THREE.Vector3(1, 0, 0));
    this.uCameraUp = uniform(new THREE.Vector3(0, 1, 0));

    this.pools.set("pillar", this.createPool("pillar", MAX_PILLAR));
    this.pools.set("wisp", this.createPool("wisp", MAX_WISP));
    this.pools.set("spark", this.createPool("spark", MAX_SPARK));
    this.pools.set("base", this.createPool("base", MAX_BASE));
    this.pools.set(
      "riseSpread",
      this.createPool("riseSpread", MAX_RISE_SPREAD),
    );

    console.log(
      "[GlowParticleManager] Initialized: 5 InstancedMesh pools (pillar/wisp/spark/base/riseSpread)",
    );
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Register a glow-particle emitter using a built-in preset.
   *
   * ```ts
   * pm.registerGlow("altar_42", {
   *   preset: "altar",
   *   position: { x: 10, y: 0, z: 20 },
   *   color: { core: 0xff6040, mid: 0xe02020, outer: 0xb01010 },
   *   meshRoot: scene,
   *   modelScale: 1.2,
   *   modelYOffset: -0.4,
   * });
   * ```
   */
  registerGlow(emitterId: string, config: GlowConfig): void {
    if (this.emitters.has(emitterId)) {
      this.unregisterGlow(emitterId);
    }

    switch (config.preset) {
      case "altar":
        this.registerAltar(emitterId, config);
        break;
      case "fire":
        this.registerFire(emitterId, config);
        break;
      default:
        console.warn(`[GlowParticleManager] Unknown preset: ${config.preset}`);
    }
  }

  /** Remove all particles belonging to an emitter and free slots. */
  unregisterGlow(emitterId: string): void {
    const record = this.emitters.get(emitterId);
    if (!record) return;

    for (const [motion, slotIndices] of record.slots) {
      const pool = this.pools.get(motion);
      if (!pool) continue;
      for (const s of slotIndices) {
        // Zero out dynamics.x (baseScale) so the slot renders invisible
        pool.dynamicsArr[s * 4] = 0;
        pool.dynamicsAttr.needsUpdate = true;
        pool.freeSlots.push(s);
      }
    }

    this.emitters.delete(emitterId);
  }

  /** Translate all particles of an emitter to a new position. */
  moveGlow(
    emitterId: string,
    newPos: { x: number; y: number; z: number },
  ): void {
    const record = this.emitters.get(emitterId);
    if (!record) return;

    for (const [motion, slotIndices] of record.slots) {
      const pool = this.pools.get(motion);
      if (!pool) continue;
      for (const s of slotIndices) {
        pool.emitterPosArr[s * 3] = newPos.x;
        pool.emitterPosArr[s * 3 + 1] = newPos.y;
        pool.emitterPosArr[s * 3 + 2] = newPos.z;
      }
      pool.emitterPosAttr.needsUpdate = true;
    }

    record.position = { ...newPos };
  }

  /** Advance ages, handle respawn, update camera. Call once per frame. */
  update(dt: number, camera: THREE.Camera): void {
    // Camera basis for billboard (reuse pre-allocated vectors)
    camera.matrixWorld.extractBasis(this._tmpRight, this._tmpUp, this._tmpFwd);
    this.uCameraRight.value.copy(this._tmpRight);
    this.uCameraUp.value.copy(this._tmpUp);

    // Advance ages and respawn
    for (const record of this.emitters.values()) {
      for (const [motion, slotIndices] of record.slots) {
        const pool = this.pools.get(motion)!;
        let alDirty = false;
        let soDirty = false;
        let dyDirty = false;

        for (const s of slotIndices) {
          pool.ageLifetimeArr[s * 2] += dt;

          if (pool.ageLifetimeArr[s * 2] >= pool.ageLifetimeArr[s * 2 + 1]) {
            pool.ageLifetimeArr[s * 2] -= pool.ageLifetimeArr[s * 2 + 1];

            if (motion === "spark") {
              this.respawnSpark(pool, s, record);
              soDirty = true;
              dyDirty = true;
            } else if (motion === "wisp") {
              this.respawnWisp(pool, s);
              soDirty = true;
              dyDirty = true;
            } else if (motion === "riseSpread") {
              this.respawnRiseSpread(pool, s, record);
              soDirty = true;
            }
          }

          alDirty = true;
        }

        if (alDirty) pool.ageLifetimeAttr.needsUpdate = true;
        if (soDirty) pool.spawnOffsetAttr.needsUpdate = true;
        if (dyDirty) pool.dynamicsAttr.needsUpdate = true;
      }
    }
  }

  /** Tear down all GPU resources. */
  dispose(): void {
    for (const pool of this.pools.values()) {
      this.scene.remove(pool.mesh);
      pool.mesh.geometry.dispose();
      (pool.mesh.material as THREE.Material).dispose();
    }
    this.pools.clear();
    this.emitters.clear();
    console.log("[GlowParticleManager] Disposed");
  }

  // ===========================================================================
  // ALTAR PRESET
  // ===========================================================================

  private registerAltar(emitterId: string, config: GlowConfig): void {
    const palette = this.resolvePalette(config.color, {
      core: 0xc4b5fd,
      mid: 0x8b5cf6,
      outer: 0x60a5fa,
    });

    const modelYOffset = config.modelYOffset ?? 0;
    const geo = config.meshRoot
      ? this.sampleMeshGeometry(
          config.meshRoot,
          config.modelScale ?? 1.0,
          modelYOffset,
          64,
        )
      : {
          surfacePoints: new Float32Array(0),
          surfaceCount: 0,
          radiusXZ: 0.5,
          minY: modelYOffset,
          maxY: modelYOffset + 1.0,
        };

    const meshR = geo.radiusXZ;
    const meshHeight = geo.maxY - geo.minY;
    const wx = config.position.x;
    const wy = config.position.y;
    const wz = config.position.z;

    const record: EmitterRecord = {
      preset: "altar",
      position: { ...config.position },
      slots: new Map(),
      meshData: geo,
    };

    // ---- PILLAR: 2 large soft glows above mesh peak ----
    {
      const pool = this.pools.get("pillar")!;
      const slots: number[] = [];
      const pillarCount = 2;
      for (let i = 0; i < pillarCount; i++) {
        if (pool.freeSlots.length === 0) break;
        const s = pool.freeSlots.pop()!;
        slots.push(s);

        const lifetime = 4.0 + Math.random() * 2.0;
        const height = geo.maxY + 0.05 + i * 0.35;
        const baseScale = meshR * 0.7 + Math.random() * meshR * 0.3;

        pool.emitterPosArr[s * 3] = wx;
        pool.emitterPosArr[s * 3 + 1] = wy;
        pool.emitterPosArr[s * 3 + 2] = wz;

        pool.ageLifetimeArr[s * 2] = Math.random() * lifetime;
        pool.ageLifetimeArr[s * 2 + 1] = lifetime;

        pool.spawnOffsetArr[s * 3] = 0;
        pool.spawnOffsetArr[s * 3 + 1] = height;
        pool.spawnOffsetArr[s * 3 + 2] = 0;

        // dynamics: (baseScale, meshRadiusXZ, phaseIdx, scaleYMult)
        pool.dynamicsArr[s * 4] = baseScale;
        pool.dynamicsArr[s * 4 + 1] = meshR;
        pool.dynamicsArr[s * 4 + 2] = i;
        pool.dynamicsArr[s * 4 + 3] = 1.4;

        const [cr, cg, cb] = palette.core;
        pool.colorSharpnessArr[s * 4] = cr;
        pool.colorSharpnessArr[s * 4 + 1] = cg;
        pool.colorSharpnessArr[s * 4 + 2] = cb;
        pool.colorSharpnessArr[s * 4 + 3] = 1.5;
      }
      record.slots.set("pillar", slots);
      this.markAllDirty(pool);
    }

    // ---- WISP: 10 orbiting particles just outside mesh silhouette ----
    {
      const pool = this.pools.get("wisp")!;
      const slots: number[] = [];
      const wispOrbitR = meshR + 0.1;
      const wispCount = 10;
      for (let i = 0; i < wispCount; i++) {
        if (pool.freeSlots.length === 0) break;
        const s = pool.freeSlots.pop()!;
        slots.push(s);

        const lifetime = 3.0 + Math.random() * 3.0;

        pool.emitterPosArr[s * 3] = wx;
        pool.emitterPosArr[s * 3 + 1] = wy;
        pool.emitterPosArr[s * 3 + 2] = wz;

        pool.ageLifetimeArr[s * 2] = Math.random() * lifetime;
        pool.ageLifetimeArr[s * 2 + 1] = lifetime;

        // spawnOffset: (initAngle, height, orbitRadius)
        pool.spawnOffsetArr[s * 3] = Math.random() * Math.PI * 2;
        pool.spawnOffsetArr[s * 3 + 1] = geo.minY + Math.random() * meshHeight;
        pool.spawnOffsetArr[s * 3 + 2] = wispOrbitR + Math.random() * 0.15;

        // dynamics: (baseScale, speed, direction, 0)
        pool.dynamicsArr[s * 4] = 0.25 + Math.random() * 0.2;
        pool.dynamicsArr[s * 4 + 1] = 0.5 + Math.random() * 0.6;
        pool.dynamicsArr[s * 4 + 2] = Math.random() > 0.5 ? 1 : -1;
        pool.dynamicsArr[s * 4 + 3] = 0;

        const [cr, cg, cb] = palette.mid;
        pool.colorSharpnessArr[s * 4] = cr;
        pool.colorSharpnessArr[s * 4 + 1] = cg;
        pool.colorSharpnessArr[s * 4 + 2] = cb;
        pool.colorSharpnessArr[s * 4 + 3] = 3.0;
      }
      record.slots.set("wisp", slots);
      this.markAllDirty(pool);
    }

    // ---- SPARK: 14 tiny particles rising from mesh surface ----
    {
      const pool = this.pools.get("spark")!;
      const slots: number[] = [];
      const sparkCount = 14;
      for (let i = 0; i < sparkCount; i++) {
        if (pool.freeSlots.length === 0) break;
        const s = pool.freeSlots.pop()!;
        slots.push(s);

        const lifetime = 1.2 + Math.random() * 1.5;
        const surf = this.pickSurfacePoint(
          geo,
          modelYOffset,
          meshR,
          meshHeight,
        );

        pool.emitterPosArr[s * 3] = wx;
        pool.emitterPosArr[s * 3 + 1] = wy;
        pool.emitterPosArr[s * 3 + 2] = wz;

        pool.ageLifetimeArr[s * 2] = Math.random() * lifetime;
        pool.ageLifetimeArr[s * 2 + 1] = lifetime;

        // spawnOffset: (surfaceX, surfaceY, surfaceZ)
        pool.spawnOffsetArr[s * 3] = surf[0];
        pool.spawnOffsetArr[s * 3 + 1] = surf[1];
        pool.spawnOffsetArr[s * 3 + 2] = surf[2];

        // dynamics: (baseScale, angle, driftRadius, direction)
        pool.dynamicsArr[s * 4] = 0.05 + Math.random() * 0.06;
        pool.dynamicsArr[s * 4 + 1] = Math.random() * Math.PI * 2;
        pool.dynamicsArr[s * 4 + 2] = 0.05 + Math.random() * 0.1;
        pool.dynamicsArr[s * 4 + 3] = Math.random() > 0.5 ? 1 : -1;

        const [cr, cg, cb] = palette.core;
        pool.colorSharpnessArr[s * 4] = cr;
        pool.colorSharpnessArr[s * 4 + 1] = cg;
        pool.colorSharpnessArr[s * 4 + 2] = cb;
        pool.colorSharpnessArr[s * 4 + 3] = 4.0;
      }
      record.slots.set("spark", slots);
      this.markAllDirty(pool);
    }

    // ---- BASE: 4 ambient glows slowly orbiting at mesh footprint ----
    {
      const pool = this.pools.get("base")!;
      const slots: number[] = [];
      const baseR = meshR + 0.05;
      const baseCount = 4;
      for (let i = 0; i < baseCount; i++) {
        if (pool.freeSlots.length === 0) break;
        const s = pool.freeSlots.pop()!;
        slots.push(s);

        const lifetime = 5.0 + Math.random() * 3.0;

        pool.emitterPosArr[s * 3] = wx;
        pool.emitterPosArr[s * 3 + 1] = wy;
        pool.emitterPosArr[s * 3 + 2] = wz;

        pool.ageLifetimeArr[s * 2] = Math.random() * lifetime;
        pool.ageLifetimeArr[s * 2 + 1] = lifetime;

        // spawnOffset: (initAngle, height, orbitRadius)
        pool.spawnOffsetArr[s * 3] = (i / baseCount) * Math.PI * 2;
        pool.spawnOffsetArr[s * 3 + 1] = geo.minY + Math.random() * 0.1;
        pool.spawnOffsetArr[s * 3 + 2] = baseR + Math.random() * 0.15;

        // dynamics: (baseScale, speed, phaseIdx, scaleYMult)
        pool.dynamicsArr[s * 4] = meshR * 0.5 + Math.random() * meshR * 0.3;
        pool.dynamicsArr[s * 4 + 1] = 0.08 + Math.random() * 0.06;
        pool.dynamicsArr[s * 4 + 2] = i;
        pool.dynamicsArr[s * 4 + 3] = 0.6;

        const [cr, cg, cb] = palette.outer;
        pool.colorSharpnessArr[s * 4] = cr;
        pool.colorSharpnessArr[s * 4 + 1] = cg;
        pool.colorSharpnessArr[s * 4 + 2] = cb;
        pool.colorSharpnessArr[s * 4 + 3] = 1.5;
      }
      record.slots.set("base", slots);
      this.markAllDirty(pool);
    }

    this.emitters.set(emitterId, record);
  }

  // ---------------------------------------------------------------------------
  // PRESET: fire
  // ---------------------------------------------------------------------------

  /**
   * Fire preset — 18 rising/spreading particles with warm colours.
   *
   * Uses the `riseSpread` pool.
   *
   * spawnOffset: (offsetX, spawnY, offsetZ)
   * dynamics:    (baseScale, speed, unused, scaleYMult)
   */
  private registerFire(emitterId: string, config: GlowConfig): void {
    const FIRE_COUNT = 28;
    const FIRE_SPAWN_Y = 0.0;
    const FIRE_COLORS = [0xff4400, 0xff6600, 0xff8800, 0xffaa00, 0xffcc00];

    const record: EmitterRecord = {
      preset: "fire",
      position: { ...config.position },
      slots: new Map(),
    };

    const pool = this.pools.get("riseSpread")!;
    const slots: number[] = [];

    for (let i = 0; i < FIRE_COUNT; i++) {
      if (pool.freeSlots.length === 0) {
        console.warn("[GlowParticleManager] riseSpread pool exhausted");
        break;
      }
      const s = pool.freeSlots.pop()!;
      slots.push(s);

      const lifetime = 0.35 + Math.random() * 0.45;

      pool.emitterPosArr[s * 3] = config.position.x;
      pool.emitterPosArr[s * 3 + 1] = config.position.y;
      pool.emitterPosArr[s * 3 + 2] = config.position.z;

      pool.ageLifetimeArr[s * 2] = Math.random() * lifetime;
      pool.ageLifetimeArr[s * 2 + 1] = lifetime;

      // spawnOffset: (offsetX, spawnY, offsetZ)
      pool.spawnOffsetArr[s * 3] = (Math.random() - 0.5) * 0.04;
      pool.spawnOffsetArr[s * 3 + 1] = FIRE_SPAWN_Y;
      pool.spawnOffsetArr[s * 3 + 2] = (Math.random() - 0.5) * 0.04;

      // dynamics: (baseScale, speed, phase, scaleYMult)
      pool.dynamicsArr[s * 4] = 0.12 + Math.random() * 0.08;
      pool.dynamicsArr[s * 4 + 1] = 0.25 + Math.random() * 0.35;
      pool.dynamicsArr[s * 4 + 2] = Math.random() * Math.PI * 2;
      pool.dynamicsArr[s * 4 + 3] = 1.8;

      const hex = FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)];
      const [r, g, b] = hexToRgb(hex);
      pool.colorSharpnessArr[s * 4] = r;
      pool.colorSharpnessArr[s * 4 + 1] = g;
      pool.colorSharpnessArr[s * 4 + 2] = b;
      pool.colorSharpnessArr[s * 4 + 3] = 2.0;

      pool.mesh.setMatrixAt(s, new THREE.Matrix4());
    }

    if (slots.length > 0) {
      record.slots.set("riseSpread", slots);
      this.markAllDirty(pool);
    }

    this.emitters.set(emitterId, record);
  }

  // ===========================================================================
  // RESPAWN HELPERS
  // ===========================================================================

  /** Spark respawn: pick new surface point, new angle, new drift radius. */
  private respawnSpark(
    pool: PoolLayer,
    s: number,
    record: EmitterRecord,
  ): void {
    const geo = record.meshData;
    if (geo && geo.surfaceCount > 0) {
      const si = Math.floor(Math.random() * geo.surfaceCount);
      pool.spawnOffsetArr[s * 3] = geo.surfacePoints[si * 3];
      pool.spawnOffsetArr[s * 3 + 1] = geo.surfacePoints[si * 3 + 1];
      pool.spawnOffsetArr[s * 3 + 2] = geo.surfacePoints[si * 3 + 2];
    }
    pool.dynamicsArr[s * 4 + 1] = Math.random() * Math.PI * 2;
    pool.dynamicsArr[s * 4 + 2] = 0.05 + Math.random() * 0.1;
  }

  /** Wisp respawn: new orbit angle, new speed. */
  private respawnWisp(pool: PoolLayer, s: number): void {
    pool.spawnOffsetArr[s * 3] = Math.random() * Math.PI * 2;
    pool.dynamicsArr[s * 4 + 1] = 0.5 + Math.random() * 0.6;
  }

  /** RiseSpread respawn: re-randomize x/z offset and phase for natural fire flicker. */
  private respawnRiseSpread(
    pool: PoolLayer,
    s: number,
    _record: EmitterRecord,
  ): void {
    pool.spawnOffsetArr[s * 3] = (Math.random() - 0.5) * 0.04;
    pool.spawnOffsetArr[s * 3 + 2] = (Math.random() - 0.5) * 0.04;
    pool.dynamicsArr[s * 4 + 2] = Math.random() * Math.PI * 2;
  }

  // ===========================================================================
  // COLOUR HELPERS
  // ===========================================================================

  private resolvePalette(
    input: number | { core: number; mid: number; outer: number } | undefined,
    defaults: { core: number; mid: number; outer: number },
  ): {
    core: [number, number, number];
    mid: [number, number, number];
    outer: [number, number, number];
  } {
    if (!input) {
      return {
        core: hexToRgb(defaults.core),
        mid: hexToRgb(defaults.mid),
        outer: hexToRgb(defaults.outer),
      };
    }
    if (typeof input === "number") {
      const c = hexToRgb(input);
      return { core: c, mid: c, outer: c };
    }
    return {
      core: hexToRgb(input.core),
      mid: hexToRgb(input.mid),
      outer: hexToRgb(input.outer),
    };
  }

  // ===========================================================================
  // MESH GEOMETRY SAMPLING
  // ===========================================================================

  private sampleMeshGeometry(
    meshRoot: THREE.Object3D,
    modelScale: number,
    modelYOffset: number,
    sampleCount: number,
  ): MeshGeometry {
    const allPositions: number[] = [];
    const bbox = new THREE.Box3();

    meshRoot.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
      const posAttr = child.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute | null;
      if (!posAttr) return;

      child.updateWorldMatrix(true, false);
      const matrix = child.matrixWorld.clone();
      meshRoot.updateWorldMatrix(true, false);
      const meshRootInverse = meshRoot.matrixWorld.clone().invert();
      const localMatrix = matrix.premultiply(meshRootInverse);

      const vertex = new THREE.Vector3();
      for (let v = 0; v < posAttr.count; v++) {
        vertex.set(posAttr.getX(v), posAttr.getY(v), posAttr.getZ(v));
        vertex.applyMatrix4(localMatrix);
        vertex.multiplyScalar(modelScale);
        vertex.y += modelYOffset;
        allPositions.push(vertex.x, vertex.y, vertex.z);
        bbox.expandByPoint(vertex);
      }
    });

    const vertCount = allPositions.length / 3;
    const actualSamples = Math.min(sampleCount, vertCount);
    const surfacePoints = new Float32Array(actualSamples * 3);

    if (vertCount > 0) {
      for (let i = 0; i < actualSamples; i++) {
        const vi = Math.floor(Math.random() * vertCount);
        surfacePoints[i * 3] = allPositions[vi * 3];
        surfacePoints[i * 3 + 1] = allPositions[vi * 3 + 1];
        surfacePoints[i * 3 + 2] = allPositions[vi * 3 + 2];
      }
    }

    const halfX = (bbox.max.x - bbox.min.x) / 2;
    const halfZ = (bbox.max.z - bbox.min.z) / 2;
    const radiusXZ = Math.sqrt(halfX * halfX + halfZ * halfZ);

    return {
      surfacePoints,
      surfaceCount: actualSamples,
      radiusXZ: radiusXZ || 0.5,
      minY: bbox.min.y || 0,
      maxY: bbox.max.y || 1,
    };
  }

  private pickSurfacePoint(
    geo: MeshGeometry,
    modelYOffset: number,
    meshR: number,
    meshHeight: number,
  ): [number, number, number] {
    if (geo.surfaceCount > 0) {
      const si = Math.floor(Math.random() * geo.surfaceCount);
      return [
        geo.surfacePoints[si * 3],
        geo.surfacePoints[si * 3 + 1],
        geo.surfacePoints[si * 3 + 2],
      ];
    }
    const a = Math.random() * Math.PI * 2;
    return [
      Math.cos(a) * meshR * 0.8,
      modelYOffset + Math.random() * meshHeight,
      Math.sin(a) * meshR * 0.8,
    ];
  }

  // ===========================================================================
  // POOL CREATION
  // ===========================================================================

  private createPool(motion: MotionType, maxCount: number): PoolLayer {
    const geometry = new THREE.PlaneGeometry(1, 1);

    const emitterPosArr = new Float32Array(maxCount * 3);
    const ageLifetimeArr = new Float32Array(maxCount * 2);
    const spawnOffsetArr = new Float32Array(maxCount * 3);
    const dynamicsArr = new Float32Array(maxCount * 4);
    const colorSharpnessArr = new Float32Array(maxCount * 4);

    // Default lifetime = 1 so t = age/lifetime doesn't produce NaN
    for (let i = 0; i < maxCount; i++) {
      ageLifetimeArr[i * 2 + 1] = 1.0;
    }

    const emitterPosAttr = new THREE.InstancedBufferAttribute(emitterPosArr, 3);
    const ageLifetimeAttr = new THREE.InstancedBufferAttribute(
      ageLifetimeArr,
      2,
    );
    const spawnOffsetAttr = new THREE.InstancedBufferAttribute(
      spawnOffsetArr,
      3,
    );
    const dynamicsAttr = new THREE.InstancedBufferAttribute(dynamicsArr, 4);
    const colorSharpnessAttr = new THREE.InstancedBufferAttribute(
      colorSharpnessArr,
      4,
    );

    emitterPosAttr.setUsage(THREE.DynamicDrawUsage);
    ageLifetimeAttr.setUsage(THREE.DynamicDrawUsage);
    spawnOffsetAttr.setUsage(THREE.DynamicDrawUsage);
    dynamicsAttr.setUsage(THREE.DynamicDrawUsage);
    colorSharpnessAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute("emitterPos", emitterPosAttr);
    geometry.setAttribute("ageLifetime", ageLifetimeAttr);
    geometry.setAttribute("spawnOffset", spawnOffsetAttr);
    geometry.setAttribute("dynamics", dynamicsAttr);
    geometry.setAttribute("colorSharpness", colorSharpnessAttr);

    const material = this.createMaterial(motion);

    const mesh = new THREE.InstancedMesh(geometry, material, maxCount);
    mesh.frustumCulled = false;
    mesh.count = maxCount;
    mesh.renderOrder = 10;
    mesh.layers.set(1);

    const identity = new THREE.Matrix4();
    for (let i = 0; i < maxCount; i++) {
      mesh.setMatrixAt(i, identity);
    }
    mesh.instanceMatrix.needsUpdate = true;

    this.scene.add(mesh);

    const freeSlots: number[] = [];
    for (let i = maxCount - 1; i >= 0; i--) freeSlots.push(i);

    return {
      mesh,
      maxCount,
      freeSlots,
      emitterPosArr,
      ageLifetimeArr,
      spawnOffsetArr,
      dynamicsArr,
      colorSharpnessArr,
      emitterPosAttr,
      ageLifetimeAttr,
      spawnOffsetAttr,
      dynamicsAttr,
      colorSharpnessAttr,
    };
  }

  // ===========================================================================
  // TSL MATERIALS
  // ===========================================================================

  /**
   * Create a TSL MeshBasicNodeMaterial for the given motion type.
   *
   * Each motion type has unique vertex animation but shares:
   *   - Billboard rendering via camera right / up uniforms
   *   - Procedural radial glow (pow(max(1-dist,0), sharpness))
   *   - Per-instance colour from colorSharpness attribute
   *   - Additive blending
   *
   * Animation logic matches the original CPU code in
   * RunecraftingAltarEntity.clientUpdate() line-for-line.
   */
  private createMaterial(
    motion: MotionType,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    // Per-instance attributes
    const aEmitterPos = attribute<"vec3">("emitterPos", "vec3");
    const aAgeLifetime = attribute<"vec2">("ageLifetime", "vec2");
    const age = aAgeLifetime.x;
    const lifetime = aAgeLifetime.y;
    const t = div(age, lifetime);

    const aSpawnOffset = attribute<"vec3">("spawnOffset", "vec3");
    const aDynamics = attribute<"vec4">("dynamics", "vec4");
    const aColorSharpness = attribute<"vec4">("colorSharpness", "vec4");

    const baseScale = aDynamics.x;

    const camRight = this.uCameraRight;
    const camUp = this.uCameraUp;

    // Global pulse: 0.85 + sin(time * 2.0) * 0.15
    // Original: 0.85 + Math.sin(Date.now() * 0.002) * 0.15
    const globalPulse = add(
      float(0.85),
      mul(sin(mul(time, float(2.0))), float(0.15)),
    );

    let particleCenter: Node<"vec3">;
    let scaleX: Node<"float">;
    let scaleY: Node<"float">;
    let opacity: Node<"float">;

    if (motion === "pillar") {
      // ---------------------------------------------------------------
      // PILLAR: slow vertical bob above mesh peak, gentle sway
      // Original: position uses Date.now() (time-driven, not lifecycle)
      // dynamics: (baseScale, meshRadiusXZ, phaseIdx, scaleYMult)
      // spawnOffset: (0, height, 0)
      // ---------------------------------------------------------------
      const meshRadiusXZ = aDynamics.y;
      const phase = aDynamics.z;
      const scaleYMult = aDynamics.w;

      // bob = sin(time + phase * 3.14) * 0.12
      const bob = mul(sin(add(time, mul(phase, float(3.14)))), float(0.12));
      // sway = sin(time * 0.8 + phase * 1.5) * meshRadiusXZ * 0.06
      const sway = mul(
        sin(add(mul(time, float(0.8)), mul(phase, float(1.5)))),
        mul(meshRadiusXZ, float(0.06)),
      );
      // zDrift = cos(time * 0.6 + phase) * meshRadiusXZ * 0.04
      const zDrift = mul(
        cos(add(mul(time, float(0.6)), phase)),
        mul(meshRadiusXZ, float(0.04)),
      );

      particleCenter = add(
        aEmitterPos,
        vec3(sway, add(aSpawnOffset.y, bob), zDrift),
      );

      // breathe = 1 + sin(time * 1.5 + phase * 2.0) * 0.15
      const breathe = add(
        float(1.0),
        mul(
          sin(add(mul(time, float(1.5)), mul(phase, float(2.0)))),
          float(0.15),
        ),
      );
      const s = mul(baseScale, breathe);
      scaleX = s;
      scaleY = mul(s, scaleYMult);

      // opacity = (0.3 + sin(time * 1.2 + phase) * 0.1) * globalPulse
      opacity = mul(
        add(
          float(0.3),
          mul(sin(add(mul(time, float(1.2)), phase)), float(0.1)),
        ),
        globalPulse,
      );
    } else if (motion === "wisp") {
      // ---------------------------------------------------------------
      // WISP: helical orbit just outside mesh silhouette
      // Original: position uses lifecycle t
      // spawnOffset: (initAngle, height, orbitRadius)
      // dynamics: (baseScale, speed, direction, 0)
      // ---------------------------------------------------------------
      const initAngle = aSpawnOffset.x;
      const height = aSpawnOffset.y;
      const orbitR = aSpawnOffset.z;
      const speed = aDynamics.y;
      const direction = aDynamics.z;

      // angle = initAngle + t * speed * direction * 5.0
      const angle = add(
        initAngle,
        mul(t, mul(speed, mul(direction, float(5.0)))),
      );
      // r = orbitR * (0.8 + sin(t * PI * 2) * 0.2)
      const r = mul(
        orbitR,
        add(float(0.8), mul(sin(mul(t, float(Math.PI * 2))), float(0.2))),
      );
      // h = height + sin(t * PI * 2.5) * 0.3
      const h = add(height, mul(sin(mul(t, float(Math.PI * 2.5))), float(0.3)));

      particleCenter = add(
        aEmitterPos,
        vec3(mul(cos(angle), r), h, mul(sin(angle), r)),
      );

      // pulse = 1 + sin(t * PI * 3) * 0.2
      const pulse = add(
        float(1.0),
        mul(sin(mul(t, float(Math.PI * 3))), float(0.2)),
      );
      const s = mul(baseScale, pulse);
      scaleX = s;
      scaleY = s;

      // fadeIn = min(t * 3, 1), fadeOut = min((1 - t) * 3, 1)
      const fadeIn = min(mul(t, float(3.0)), float(1.0));
      const fadeOut = min(mul(sub(float(1.0), t), float(3.0)), float(1.0));
      // opacity = 0.5 * fadeIn * fadeOut * globalPulse
      opacity = mul(float(0.5), mul(fadeIn, mul(fadeOut, globalPulse)));
    } else if (motion === "spark") {
      // ---------------------------------------------------------------
      // SPARK: rise from mesh surface vertex with slight drift
      // Original: position uses lifecycle t
      // spawnOffset: (surfaceX, surfaceY, surfaceZ)
      // dynamics: (baseScale, angle, driftRadius, direction)
      // ---------------------------------------------------------------
      const angle = aDynamics.y;
      const driftR = aDynamics.z;
      const direction = aDynamics.w;

      // drift = sin(angle + t * direction * 2.0) * driftR
      const drift = mul(
        sin(add(angle, mul(t, mul(direction, float(2.0))))),
        driftR,
      );
      // riseHeight = t * 1.8
      const riseHeight = mul(t, float(1.8));
      // driftZ = cos(angle + t * 1.5) * driftR
      const driftZ = mul(cos(add(angle, mul(t, float(1.5)))), driftR);

      particleCenter = add(
        aEmitterPos,
        vec3(
          add(aSpawnOffset.x, drift),
          add(aSpawnOffset.y, riseHeight),
          add(aSpawnOffset.z, driftZ),
        ),
      );

      // shrink = 1 - t * 0.5
      const shrink = sub(float(1.0), mul(t, float(0.5)));
      const s = mul(baseScale, shrink);
      scaleX = s;
      scaleY = s;

      // fadeIn = min(t * 8, 1), fadeOut = pow(1 - t, 1.5)
      const fadeIn = min(mul(t, float(8.0)), float(1.0));
      const fadeOut = pow(sub(float(1.0), t), float(1.5));
      // opacity = 0.85 * fadeIn * fadeOut * globalPulse
      opacity = mul(float(0.85), mul(fadeIn, mul(fadeOut, globalPulse)));
    } else if (motion === "riseSpread") {
      // ---------------------------------------------------------------
      // RISE-SPREAD: fire particles rising with turbulent jitter
      // spawnOffset: (offsetX, spawnY, offsetZ)
      // dynamics:    (baseScale, speed, phase, scaleYMult)
      // ---------------------------------------------------------------
      const speed = aDynamics.y;
      const phase = aDynamics.z;
      const scaleYMult = aDynamics.w;

      // Spread widens slightly as particles rise, then converge at top
      const spreadFactor = add(float(1.0), mul(t, float(0.4)));
      const spreadX = mul(aSpawnOffset.x, spreadFactor);
      const spreadZ = mul(aSpawnOffset.z, spreadFactor);
      const riseY = add(aSpawnOffset.y, mul(t, speed));

      // Flame-like turbulence — visible flicker that fades with height
      const turbAmp = mul(float(0.04), sub(float(1.0), mul(t, float(0.7))));
      const turbX = mul(sin(add(mul(time, float(7.0)), phase)), turbAmp);
      const turbZ = mul(
        cos(add(mul(time, float(5.5)), mul(phase, float(1.5)))),
        turbAmp,
      );

      particleCenter = add(
        aEmitterPos,
        vec3(add(spreadX, turbX), riseY, add(spreadZ, turbZ)),
      );

      // fade: instant in, gradual out
      const fadeIn = min(mul(t, float(8.0)), float(1.0));
      const fadeOut = pow(sub(float(1.0), t), float(1.2));
      const fade = mul(fadeIn, fadeOut);

      // Shrink moderately — tapering flame tip
      const shrinkScale = mul(
        baseScale,
        mul(fade, sub(float(1.0), mul(t, float(0.5)))),
      );
      scaleX = shrinkScale;
      scaleY = mul(shrinkScale, scaleYMult);

      opacity = mul(float(0.85), fade);
    } else {
      // ---------------------------------------------------------------
      // BASE: slow orbit at mesh footprint, gentle pulse
      // Original: position uses Date.now() (time-driven)
      // spawnOffset: (initAngle, height, orbitRadius)
      // dynamics: (baseScale, speed, phaseIdx, scaleYMult)
      // ---------------------------------------------------------------
      const initAngle = aSpawnOffset.x;
      const height = aSpawnOffset.y;
      const orbitR = aSpawnOffset.z;
      const speed = aDynamics.y;
      const phase = aDynamics.z;
      const scaleYMult = aDynamics.w;

      // angle = initAngle + time * speed * 3.0
      // Original: angles[i] + now * 0.0003 * speeds[i] * 10 = angles[i] + time * speed * 3.0
      const angle = add(initAngle, mul(time, mul(speed, float(3.0))));

      particleCenter = add(
        aEmitterPos,
        vec3(mul(cos(angle), orbitR), height, mul(sin(angle), orbitR)),
      );

      // pulse = 1 + sin(time + phase * 1.57) * 0.15
      const pulse = add(
        float(1.0),
        mul(sin(add(time, mul(phase, float(1.57)))), float(0.15)),
      );
      const s = mul(baseScale, pulse);
      scaleX = s;
      scaleY = mul(s, scaleYMult);

      // opacity = (0.15 + sin(time * 0.8 + phase * 2) * 0.06) * globalPulse
      opacity = mul(
        add(
          float(0.15),
          mul(
            sin(add(mul(time, float(0.8)), mul(phase, float(2.0)))),
            float(0.06),
          ),
        ),
        globalPulse,
      );
    }

    // -----------------------------------------------------------------
    // Billboard: offset plane vertices in camera space
    // Matches WaterParticleManager pattern exactly
    // -----------------------------------------------------------------
    const localXY = positionLocal.xy;
    const billboardOffset = camRight
      .mul(localXY.x)
      .mul(scaleX)
      .add(camUp.mul(localXY.y).mul(scaleY));
    material.positionNode = add(particleCenter, billboardOffset);

    // -----------------------------------------------------------------
    // Fragment
    // -----------------------------------------------------------------
    const uvNode = uv();
    const dx = sub(uvNode.x, float(0.5));
    const dy = sub(uvNode.y, float(0.5));

    const pColor = vec3(
      aColorSharpness.x,
      aColorSharpness.y,
      aColorSharpness.z,
    );

    if (motion === "riseSpread") {
      // ---- FIRE FRAGMENT: soft falloff + noise for additive blending merge ----

      // Smooth value noise via bilinear interpolation of hash lattice
      const hash2d = (p: Node<"vec2">) =>
        fract(mul(sin(dot(p, vec2(127.1, 311.7))), float(43758.5453)));

      const valueNoise = (p: Node<"vec2">) => {
        const i = vec2(tslFloor(p.x), tslFloor(p.y));
        const f = vec2(fract(p.x), fract(p.y));
        const u = mul(mul(f, f), sub(vec2(3.0, 3.0), mul(f, float(2.0))));
        const a = hash2d(i);
        const b = hash2d(add(i, vec2(1.0, 0.0)));
        const c = hash2d(add(i, vec2(0.0, 1.0)));
        const d = hash2d(add(i, vec2(1.0, 1.0)));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      };

      const fragPhase = aDynamics.z;

      // Soft radial falloff — no hard edges, blends with neighbors via additive
      const radialDist = mul(
        pow(add(mul(dx, dx), mul(dy, dy)), float(0.5)),
        float(2.0),
      );
      // Vertically biased: narrower at top, wider at bottom
      const yBias = mul(uvNode.y, float(0.3));
      const softFalloff = max(
        sub(float(1.0), add(radialDist, yBias)),
        float(0.0),
      );
      // Gentle power curve — keeps brightness high across most of the particle
      const baseMask = pow(softFalloff, float(0.8));

      // Scrolling noise gives organic edges and upward motion feel
      const scrollY = mul(time, float(-3.0));
      const nUV1 = vec2(
        mul(uvNode.x, float(4.0)),
        add(mul(uvNode.y, float(4.0)), scrollY),
      );
      const nUV2 = vec2(
        add(mul(uvNode.x, float(7.0)), mul(fragPhase, float(0.3))),
        add(mul(uvNode.y, float(7.0)), mul(scrollY, float(1.4))),
      );
      const noise = add(
        mul(valueNoise(nUV1), float(0.6)),
        mul(valueNoise(nUV2), float(0.4)),
      );

      // Noise modulates the mask — wispy edges but keeps 70%+ base intensity
      const noisyMask = mul(baseMask, add(float(0.7), mul(noise, float(0.3))));

      // Age-based fade: hold brightness then drop at end of life
      const ageFade = smoothstep(float(1.0), float(0.3), t);
      const glow = mul(noisyMask, ageFade);

      // Color: bright core fading to particle color at edges/top
      const coreColor = vec3(1.0, 0.9, 0.4);
      const coreness = pow(max(softFalloff, float(0.0)), float(2.0));
      const fireColor = mix(pColor, coreColor, coreness);

      material.colorNode = mul(fireColor, mul(glow, float(1.5)));
      material.opacityNode = mul(glow, opacity);
    } else {
      // ---- DEFAULT FRAGMENT: procedural radial glow (pillar/wisp/spark/base) ----
      const distSq = add(mul(dx, dx), mul(dy, dy));
      const dist = pow(distSq, float(0.5));
      const scaledDist = mul(dist, float(2.0));
      const falloff = max(sub(float(1.0), scaledDist), float(0.0));
      const sharpness = aColorSharpness.w;
      const glow = pow(falloff, sharpness);

      material.colorNode = mul(pColor, glow);
      material.opacityNode = mul(glow, opacity);
    }

    return material;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private markAllDirty(pool: PoolLayer): void {
    pool.emitterPosAttr.needsUpdate = true;
    pool.ageLifetimeAttr.needsUpdate = true;
    pool.spawnOffsetAttr.needsUpdate = true;
    pool.dynamicsAttr.needsUpdate = true;
    pool.colorSharpnessAttr.needsUpdate = true;
    pool.mesh.instanceMatrix.needsUpdate = true;
  }
}
