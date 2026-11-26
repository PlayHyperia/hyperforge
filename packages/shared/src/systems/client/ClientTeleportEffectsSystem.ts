import THREE, {
  MeshBasicNodeMaterial,
  uniform,
  uv,
  time,
  float,
  vec3,
  sin,
  mul,
  add,
  sub,
  pow,
  max,
  positionLocal,
  mix,
  length,
  vec2,
} from "../../extras/three/three";
import type { UniformNode } from "three/webgpu";
import { World } from "../../core/World";
import { HOME_TELEPORT_CONSTANTS } from "../../constants/GameConstants";
import { SystemBase } from "../shared/infrastructure/SystemBase";
import { EventType } from "../../types/events/event-types";
import { Curve } from "../../extras/animation/Curve";
import type { WorldOptions } from "../../types/index";

// ─── Constants ──────────────────────────────────────────────────────────────
const EFFECT_DURATION = 2.5;
const POOL_SIZE = 2; // Max concurrent effects (both duel agents)
const HELIX_COUNT = 8; // 2 strands of 4
const BURST_COUNT = 6;

// Phase boundaries (normalized 0-1)
const GATHER_END = 0.2;
const ERUPT_END = 0.34;
const SUSTAIN_END = 0.68;
const CHANNEL_EFFECT_TIMEOUT_BUFFER_MS = 1500;

// Pre-allocated colors (shared, never disposed)
const COLOR_CYAN = new THREE.Color(0x66ccff);
const COLOR_WHITE = new THREE.Color(0xffffff);
const COLOR_PORTAL_BRONZE = new THREE.Color(0x8e7a59);
const COLOR_PORTAL_UMBER = new THREE.Color(0x231f1a);
const COLOR_PORTAL_GOLD = new THREE.Color(0xbea57b);
const COLOR_PORTAL_PARCHMENT = new THREE.Color(0xd7c7ab);
const PORTAL_ENDGAME_START = 0.8;
const PORTAL_GROUND_CLEARANCE = 0.015;
const TELEPORT_GROUND_CONTACT_BONES = [
  "leftFoot",
  "rightFoot",
  "leftToes",
  "rightToes",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftUpperLeg",
  "rightUpperLeg",
  "hips",
  "spine",
  "chest",
  "upperChest",
] as const;

// ─── Pooled particle state ──────────────────────────────────────────────────
interface HelixParticle {
  mesh: THREE.Mesh;
  helixIndex: number;
  particleIndex: number;
  spawnDelay: number;
  baseScale: number;
  // Mutable runtime state (reset on spawn)
  angle: number;
}

interface BurstParticle {
  mesh: THREE.Mesh;
  baseScale: number;
  // Mutable runtime state (reset on spawn)
  velocity: THREE.Vector3;
}

type FloatUniform = UniformNode<"float", number>;

interface PooledEffect {
  group: THREE.Group;
  mode: "burst" | "channel";
  channelDurationMs: number;

  // Structural meshes (pre-allocated)
  runeCircle: THREE.Mesh;
  baseGlow: THREE.Mesh;
  innerBeam: THREE.Mesh;
  outerBeam: THREE.Mesh;
  coreFlash: THREE.Mesh;
  shockwave1: THREE.Mesh;
  shockwave2: THREE.Mesh;
  portalVeil: THREE.Mesh;
  portalBandLower: THREE.Mesh;
  portalBandUpper: THREE.Mesh;
  portalCrown: THREE.Mesh;

  // Per-effect materials with own uniforms
  perEffectMaterials: InstanceType<typeof MeshBasicNodeMaterial>[];
  uRuneOpacity: FloatUniform;
  uGlowOpacity: FloatUniform;
  uInnerBeamOpacity: FloatUniform;
  uOuterBeamOpacity: FloatUniform;
  uFlashOpacity: FloatUniform;
  uShock1Opacity: FloatUniform;
  uShock2Opacity: FloatUniform;
  uPortalVeilOpacity: FloatUniform;
  uPortalBandLowerOpacity: FloatUniform;
  uPortalBandUpperOpacity: FloatUniform;
  uPortalCrownOpacity: FloatUniform;

  // Particles (share materials across pool, fade via scale)
  helixParticles: HelixParticle[];
  burstParticles: BurstParticle[];

  // Runtime state
  active: boolean;
  life: number;
}

/**
 * ClientTeleportEffectsSystem
 *
 * Renders a spectacular multi-phase teleportation visual effect when a player
 * is teleported (e.g., into/out of the duel arena). Features a ground rune circle,
 * dual beams with elastic overshoot, shockwave rings, helix spiral particles,
 * burst particles with gravity, and dynamic point lighting.
 *
 * Performance: Uses object pooling — all materials are compiled once in init(),
 * zero allocations or pipeline compilations at spawn time.
 */
export class ClientTeleportEffectsSystem extends SystemBase {
  // ─── Object pool ────────────────────────────────────────────────────────
  private pool: PooledEffect[] = [];
  private poolInitialized = false;

  // ─── Shared geometries (allocated once) ─────────────────────────────────
  private particleGeo: THREE.PlaneGeometry | null = null;
  private beamInnerGeo: THREE.CylinderGeometry | null = null;
  private beamOuterGeo: THREE.CylinderGeometry | null = null;
  private discGeo: THREE.CircleGeometry | null = null;
  private runeCircleGeo: THREE.CircleGeometry | null = null;
  private shockwaveGeo: THREE.RingGeometry | null = null;
  private sphereGeo: THREE.SphereGeometry | null = null;
  private portalVeilGeo: THREE.CylinderGeometry | null = null;
  private portalRingGeo: THREE.TorusGeometry | null = null;

  // ─── Shared textures ────────────────────────────────────────────────────
  private runeTexture: THREE.CanvasTexture | null = null;

  // ─── Shared particle materials (2 total, used by all pool entries) ──────
  private particleCyanMat: InstanceType<typeof MeshBasicNodeMaterial> | null =
    null;
  private particleWhiteMat: InstanceType<typeof MeshBasicNodeMaterial> | null =
    null;

  // ─── Shared Hermite curves ──────────────────────────────────────────────
  private beamElasticCurve: Curve | null = null;
  private readonly localPlayerTeleportAnchor = new THREE.Vector3();
  private readonly teleportBoneWorldPosition = new THREE.Vector3();
  private homeTeleportCastEffect: PooledEffect | null = null;

  constructor(world: World) {
    super(world, {
      name: "teleportEffects",
      dependencies: { required: [], optional: [] },
      autoCleanup: true,
    });
  }

  async init(options?: WorldOptions): Promise<void> {
    await super.init(options as WorldOptions);

    this.world.on(
      EventType.HOME_TELEPORT_CAST_START,
      this.onHomeTeleportCastStart,
    );
    this.world.on(EventType.HOME_TELEPORT_FAILED, this.onHomeTeleportStopped);
    this.world.on(
      EventType.HOME_TELEPORT_CAST_CANCEL,
      this.onHomeTeleportStopped,
    );
    this.world.on(EventType.PLAYER_TELEPORTED, this.onPlayerTeleported);
  }

  private ensurePoolInitialized(): void {
    if (this.poolInitialized) {
      return;
    }

    // ─── Shared geometries (lower poly for performance) ─────────────────
    this.particleGeo = new THREE.PlaneGeometry(1, 1);

    // Inner beam: bottom pivot (translate geometry up by half height)
    this.beamInnerGeo = new THREE.CylinderGeometry(0.12, 0.25, 18, 12, 1, true);
    this.beamInnerGeo.translate(0, 9, 0);

    // Outer beam: bottom pivot
    this.beamOuterGeo = new THREE.CylinderGeometry(0.06, 0.5, 16, 10, 1, true);
    this.beamOuterGeo.translate(0, 8, 0);

    this.discGeo = new THREE.CircleGeometry(0.5, 16);
    this.runeCircleGeo = new THREE.CircleGeometry(1.5, 32);
    this.shockwaveGeo = new THREE.RingGeometry(0.15, 0.4, 24);
    this.sphereGeo = new THREE.SphereGeometry(0.4, 8, 6);
    this.portalVeilGeo = new THREE.CylinderGeometry(
      0.9,
      0.72,
      3.05,
      24,
      1,
      true,
    );
    this.portalVeilGeo.translate(0, 1.525, 0);
    this.portalRingGeo = new THREE.TorusGeometry(0.84, 0.04, 8, 32);

    // ─── Shared textures ────────────────────────────────────────────────
    this.runeTexture = this.createRuneTexture();

    // ─── Shared particle materials (no per-instance opacity — fade via scale) ─
    this.particleCyanMat = this.createParticleGlowMaterial(COLOR_CYAN);
    this.particleWhiteMat = this.createParticleGlowMaterial(COLOR_WHITE);

    // ─── Hermite curves ────────────────────────────────────────────────
    this.beamElasticCurve = new Curve();
    this.beamElasticCurve.add({
      time: 0,
      value: 0,
      inTangent: 0,
      outTangent: 5.0,
    });
    this.beamElasticCurve.add({
      time: 0.35,
      value: 1.3,
      inTangent: 1.0,
      outTangent: -2.0,
    });
    this.beamElasticCurve.add({
      time: 0.65,
      value: 0.95,
      inTangent: -0.3,
      outTangent: 0.5,
    });
    this.beamElasticCurve.add({
      time: 1.0,
      value: 1.0,
      inTangent: 0.2,
      outTangent: 0,
    });

    // ─── Pre-allocate effect pool ───────────────────────────────────────
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push(this.createPoolEntry());
    }

    this.poolInitialized = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POOL ENTRY CREATION (called only during init)
  // ═══════════════════════════════════════════════════════════════════════════
  private createPoolEntry(): PooledEffect {
    const group = new THREE.Group();
    group.visible = false; // Hidden until spawned
    const perEffectMaterials: InstanceType<typeof MeshBasicNodeMaterial>[] = [];

    // ─── 1. Ground Rune Circle ──────────────────────────────────────────
    const uRuneOpacity = uniform(0.0);
    const runeMat = this.createTexturedMaterial(
      this.runeTexture!,
      COLOR_CYAN,
      uRuneOpacity,
    );
    perEffectMaterials.push(runeMat);
    const runeCircle = new THREE.Mesh(this.runeCircleGeo!, runeMat);
    runeCircle.rotation.x = -Math.PI / 2;
    runeCircle.renderOrder = 1000;
    runeCircle.frustumCulled = false;
    group.add(runeCircle);

    // ─── 2. Base Glow Disc ──────────────────────────────────────────────
    const uGlowOpacity = uniform(0.0);
    const glowMat = this.createStructuralGlowMaterial(COLOR_CYAN, uGlowOpacity);
    perEffectMaterials.push(glowMat);
    const baseGlow = new THREE.Mesh(this.discGeo!, glowMat);
    baseGlow.rotation.x = -Math.PI / 2;
    baseGlow.renderOrder = 1001;
    baseGlow.frustumCulled = false;
    group.add(baseGlow);

    // ─── 3. Inner Beam ──────────────────────────────────────────────────
    const uInnerBeamOpacity = uniform(0.0);
    const innerBeamMat = this.createBeamMaterial(
      COLOR_WHITE,
      new THREE.Color(0x66ccff),
      uInnerBeamOpacity,
    );
    perEffectMaterials.push(innerBeamMat);
    const innerBeam = new THREE.Mesh(this.beamInnerGeo!, innerBeamMat);
    innerBeam.renderOrder = 999;
    innerBeam.frustumCulled = false;
    group.add(innerBeam);

    // ─── 4. Outer Beam ──────────────────────────────────────────────────
    const uOuterBeamOpacity = uniform(0.0);
    const outerBeamMat = this.createBeamMaterial(
      new THREE.Color(0xaaddff),
      new THREE.Color(0x4488cc),
      uOuterBeamOpacity,
    );
    perEffectMaterials.push(outerBeamMat);
    const outerBeam = new THREE.Mesh(this.beamOuterGeo!, outerBeamMat);
    outerBeam.renderOrder = 998;
    outerBeam.frustumCulled = false;
    group.add(outerBeam);

    // ─── 5. Core Flash ──────────────────────────────────────────────────
    const uFlashOpacity = uniform(0.0);
    const flashMat = this.createStructuralGlowMaterial(
      COLOR_WHITE,
      uFlashOpacity,
    );
    perEffectMaterials.push(flashMat);
    const coreFlash = new THREE.Mesh(this.sphereGeo!, flashMat);
    coreFlash.position.y = 0.5;
    coreFlash.renderOrder = 1010;
    coreFlash.frustumCulled = false;
    group.add(coreFlash);

    // ─── 6. Shockwave Ring 1 ────────────────────────────────────────────
    const uShock1Opacity = uniform(0.0);
    const shock1Mat = this.createBasicAdditiveMaterial(
      COLOR_WHITE,
      uShock1Opacity,
    );
    perEffectMaterials.push(shock1Mat);
    const shockwave1 = new THREE.Mesh(this.shockwaveGeo!, shock1Mat);
    shockwave1.rotation.x = -Math.PI / 2;
    shockwave1.renderOrder = 1005;
    shockwave1.frustumCulled = false;
    group.add(shockwave1);

    // ─── 7. Shockwave Ring 2 ────────────────────────────────────────────
    const uShock2Opacity = uniform(0.0);
    const shock2Mat = this.createBasicAdditiveMaterial(
      COLOR_CYAN,
      uShock2Opacity,
    );
    perEffectMaterials.push(shock2Mat);
    const shockwave2 = new THREE.Mesh(this.shockwaveGeo!, shock2Mat);
    shockwave2.rotation.x = -Math.PI / 2;
    shockwave2.renderOrder = 1004;
    shockwave2.frustumCulled = false;
    group.add(shockwave2);

    // ─── 8. Cast Portal Veil + Orbit Rings ───────────────────────────────
    const uPortalVeilOpacity = uniform(0.0);
    const portalVeilMat = this.createBeamMaterial(
      COLOR_PORTAL_UMBER,
      COLOR_PORTAL_GOLD,
      uPortalVeilOpacity,
    );
    perEffectMaterials.push(portalVeilMat);
    const portalVeil = new THREE.Mesh(this.portalVeilGeo!, portalVeilMat);
    portalVeil.renderOrder = 997;
    portalVeil.frustumCulled = false;
    group.add(portalVeil);

    const uPortalBandLowerOpacity = uniform(0.0);
    const portalBandLowerMat = this.createBasicAdditiveMaterial(
      COLOR_PORTAL_BRONZE,
      uPortalBandLowerOpacity,
    );
    perEffectMaterials.push(portalBandLowerMat);
    const portalBandLower = new THREE.Mesh(
      this.portalRingGeo!,
      portalBandLowerMat,
    );
    portalBandLower.rotation.x = Math.PI / 2;
    portalBandLower.renderOrder = 1006;
    portalBandLower.frustumCulled = false;
    group.add(portalBandLower);

    const uPortalBandUpperOpacity = uniform(0.0);
    const portalBandUpperMat = this.createBasicAdditiveMaterial(
      COLOR_PORTAL_GOLD,
      uPortalBandUpperOpacity,
    );
    perEffectMaterials.push(portalBandUpperMat);
    const portalBandUpper = new THREE.Mesh(
      this.portalRingGeo!,
      portalBandUpperMat,
    );
    portalBandUpper.rotation.x = Math.PI / 2;
    portalBandUpper.renderOrder = 1007;
    portalBandUpper.frustumCulled = false;
    group.add(portalBandUpper);

    const uPortalCrownOpacity = uniform(0.0);
    const portalCrownMat = this.createBasicAdditiveMaterial(
      COLOR_PORTAL_PARCHMENT,
      uPortalCrownOpacity,
    );
    perEffectMaterials.push(portalCrownMat);
    const portalCrown = new THREE.Mesh(this.portalRingGeo!, portalCrownMat);
    portalCrown.rotation.x = Math.PI / 2;
    portalCrown.renderOrder = 1008;
    portalCrown.frustumCulled = false;
    group.add(portalCrown);

    // ─── 9. Helix Spiral Particles (8: 2 strands of 4) ────────────────
    const helixParticles: HelixParticle[] = [];
    for (let i = 0; i < HELIX_COUNT; i++) {
      const helixIndex = i < 4 ? 0 : 1;
      const particleIndex = i % 4;
      const mesh = new THREE.Mesh(this.particleGeo!, this.particleCyanMat!);
      const baseScale = 0.35 + Math.random() * 0.2;
      mesh.renderOrder = 1002;
      mesh.frustumCulled = false;
      mesh.visible = false;
      group.add(mesh);

      helixParticles.push({
        mesh,
        helixIndex,
        particleIndex,
        spawnDelay: particleIndex * 0.05 + helixIndex * 0.025,
        baseScale,
        angle: helixIndex * Math.PI + (particleIndex / 4) * Math.PI * 2,
      });
    }

    // ─── 10. Burst Particles (6) ────────────────────────────────────────
    const burstParticles: BurstParticle[] = [];
    for (let i = 0; i < BURST_COUNT; i++) {
      const mat = i < 3 ? this.particleWhiteMat! : this.particleCyanMat!;

      const mesh = new THREE.Mesh(this.particleGeo!, mat);
      const baseScale = 0.25 + Math.random() * 0.25;
      mesh.renderOrder = 1003;
      mesh.frustumCulled = false;
      mesh.visible = false;
      group.add(mesh);

      burstParticles.push({
        mesh,
        baseScale,
        velocity: new THREE.Vector3(), // Reset on spawn
      });
    }

    return {
      group,
      mode: "burst",
      channelDurationMs: HOME_TELEPORT_CONSTANTS.CAST_TIME_MS,
      runeCircle,
      baseGlow,
      innerBeam,
      outerBeam,
      coreFlash,
      shockwave1,
      shockwave2,
      portalVeil,
      portalBandLower,
      portalBandUpper,
      portalCrown,
      perEffectMaterials,
      uRuneOpacity,
      uGlowOpacity,
      uInnerBeamOpacity,
      uOuterBeamOpacity,
      uFlashOpacity,
      uShock1Opacity,
      uShock2Opacity,
      uPortalVeilOpacity,
      uPortalBandLowerOpacity,
      uPortalBandUpperOpacity,
      uPortalCrownOpacity,
      helixParticles,
      burstParticles,
      active: false,
      life: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT HANDLER
  // ═══════════════════════════════════════════════════════════════════════════
  private onPlayerTeleported = (data: unknown): void => {
    const payload = data as {
      playerId: string;
      position: THREE.Vector3 | { x: number; y: number; z: number };
      suppressEffect?: boolean;
    };
    if (!payload?.position) return;
    if (payload.suppressEffect) return;

    const localPlayerId = this.getLocalPlayerId();
    if (localPlayerId && payload.playerId === localPlayerId) {
      this.stopHomeTeleportCastEffect();
    }

    const pos = payload.position;
    const vec =
      pos instanceof THREE.Vector3
        ? pos
        : new THREE.Vector3(pos.x, pos.y, pos.z);

    this.spawnTeleportEffect(vec);
  };

  private onHomeTeleportCastStart = (data: unknown): void => {
    const payload = data as { castTimeMs?: number } | undefined;
    const localPlayerAnchor = this.getLocalPlayerTeleportAnchor();
    if (!localPlayerAnchor) return;
    const channelDurationMs =
      payload?.castTimeMs ?? HOME_TELEPORT_CONSTANTS.CAST_TIME_MS;

    if (this.homeTeleportCastEffect) {
      this.homeTeleportCastEffect.life = 0;
      this.homeTeleportCastEffect.channelDurationMs = channelDurationMs;
      this.homeTeleportCastEffect.group.position.copy(localPlayerAnchor);
      this.resetChannelEffectState(this.homeTeleportCastEffect);
      return;
    }

    this.homeTeleportCastEffect = this.spawnChannelEffect(
      localPlayerAnchor,
      channelDurationMs,
    );
  };

  private onHomeTeleportStopped = (): void => {
    this.stopHomeTeleportCastEffect();
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SPAWN (grab from pool, reset state, zero allocations)
  // ═══════════════════════════════════════════════════════════════════════════
  private spawnTeleportEffect(position: THREE.Vector3): void {
    if (!this.world.stage?.scene) return;

    this.ensurePoolInitialized();

    // Find an inactive pool entry
    const fx = this.pool.find((e) => !e.active);
    if (!fx) return; // All slots in use, skip

    // Reset timeline
    fx.active = true;
    fx.life = 0;
    fx.mode = "burst";

    // Position the group
    fx.group.position.copy(position);
    fx.group.position.y += 0.05;
    fx.group.visible = true;

    // Reset structural mesh state + visibility (hidden until their phase)
    fx.runeCircle.scale.setScalar(0.5);
    fx.runeCircle.rotation.z = 0;
    fx.runeCircle.visible = true;
    fx.baseGlow.scale.setScalar(0.5);
    fx.baseGlow.visible = true;
    fx.innerBeam.scale.set(1, 0, 1);
    fx.innerBeam.visible = false; // Hidden until ERUPT
    fx.outerBeam.scale.set(1, 0, 1);
    fx.outerBeam.visible = false; // Hidden until ERUPT
    fx.coreFlash.position.y = 0.5;
    fx.coreFlash.scale.setScalar(0);
    fx.coreFlash.visible = false; // Hidden until ERUPT
    fx.shockwave1.position.y = 0;
    fx.shockwave1.scale.setScalar(1);
    fx.shockwave1.visible = false; // Hidden until ERUPT
    fx.shockwave2.position.y = 0;
    fx.shockwave2.scale.setScalar(1);
    fx.shockwave2.visible = false; // Hidden until ERUPT
    fx.portalVeil.scale.set(1, 0.01, 1);
    fx.portalVeil.visible = false;
    fx.portalBandLower.position.y = 0;
    fx.portalBandLower.scale.setScalar(0.5);
    fx.portalBandLower.rotation.z = 0;
    fx.portalBandLower.visible = false;
    fx.portalBandUpper.position.y = 0;
    fx.portalBandUpper.scale.setScalar(0.5);
    fx.portalBandUpper.rotation.z = 0;
    fx.portalBandUpper.visible = false;
    fx.portalCrown.position.y = 0;
    fx.portalCrown.scale.setScalar(0.5);
    fx.portalCrown.rotation.z = 0;
    fx.portalCrown.visible = false;

    // Reset uniforms
    fx.uRuneOpacity.value = 0;
    fx.uGlowOpacity.value = 0;
    fx.uInnerBeamOpacity.value = 0;
    fx.uOuterBeamOpacity.value = 0;
    fx.uFlashOpacity.value = 0;
    fx.uShock1Opacity.value = 0;
    fx.uShock2Opacity.value = 0;
    fx.uPortalVeilOpacity.value = 0;
    fx.uPortalBandLowerOpacity.value = 0;
    fx.uPortalBandUpperOpacity.value = 0;
    fx.uPortalCrownOpacity.value = 0;

    // Reset helix particles
    for (const p of fx.helixParticles) {
      p.mesh.visible = false;
      p.mesh.position.set(0, 0, 0);
      p.mesh.scale.setScalar(0);
      p.angle = p.helixIndex * Math.PI + (p.particleIndex / 4) * Math.PI * 2;
    }

    // Reset burst particles with fresh random velocities
    for (const p of fx.burstParticles) {
      p.mesh.visible = false;
      p.mesh.position.set(0, 0.5, 0);
      p.mesh.scale.setScalar(0);
      const angle = Math.random() * Math.PI * 2;
      const upSpeed = 4.0 + Math.random() * 5.0;
      const spread = 1.0 + Math.random() * 2.0;
      p.velocity.set(
        Math.cos(angle) * spread,
        upSpeed,
        Math.sin(angle) * spread,
      );
    }

    // Add to scene if not already parented
    if (!fx.group.parent) {
      this.world.stage.scene.add(fx.group);
    }
  }

  private spawnChannelEffect(
    position: THREE.Vector3,
    channelDurationMs: number,
  ): PooledEffect | null {
    if (!this.world.stage?.scene) return null;

    this.ensurePoolInitialized();

    const fx = this.pool.find((entry) => !entry.active);
    if (!fx) return null;

    fx.active = true;
    fx.life = 0;
    fx.mode = "channel";
    fx.channelDurationMs = channelDurationMs;
    fx.group.position.copy(position);
    fx.group.position.y += 0.05;
    fx.group.visible = true;

    this.resetChannelEffectState(fx);

    if (!fx.group.parent) {
      this.world.stage.scene.add(fx.group);
    }

    return fx;
  }

  private resetChannelEffectState(fx: PooledEffect): void {
    fx.life = 0;

    fx.runeCircle.scale.setScalar(0.92);
    fx.runeCircle.rotation.z = 0;
    fx.runeCircle.visible = true;
    fx.baseGlow.scale.setScalar(1.02);
    fx.baseGlow.visible = true;
    fx.innerBeam.scale.set(0.72, 0.22, 0.72);
    fx.innerBeam.visible = false;
    fx.outerBeam.scale.set(0.94, 0.18, 0.94);
    fx.outerBeam.visible = false;
    fx.coreFlash.position.y = 0.85;
    fx.coreFlash.scale.setScalar(0.55);
    fx.coreFlash.visible = false;
    fx.shockwave1.position.y = 0;
    fx.shockwave1.visible = false;
    fx.shockwave2.position.y = 0;
    fx.shockwave2.visible = false;
    fx.portalVeil.scale.set(0.72, 0.1, 0.72);
    fx.portalVeil.visible = true;
    fx.portalBandLower.position.y = 0.03;
    fx.portalBandLower.scale.setScalar(0.88);
    fx.portalBandLower.rotation.z = 0;
    fx.portalBandLower.visible = true;
    fx.portalBandUpper.position.y = 0.58;
    fx.portalBandUpper.scale.setScalar(0.56);
    fx.portalBandUpper.rotation.z = Math.PI * 0.12;
    fx.portalBandUpper.visible = true;
    fx.portalCrown.position.y = 1.08;
    fx.portalCrown.scale.setScalar(0.5);
    fx.portalCrown.rotation.z = Math.PI * 0.2;
    fx.portalCrown.visible = true;

    fx.uRuneOpacity.value = 0.12;
    fx.uGlowOpacity.value = 0.08;
    fx.uInnerBeamOpacity.value = 0;
    fx.uOuterBeamOpacity.value = 0;
    fx.uFlashOpacity.value = 0;
    fx.uShock1Opacity.value = 0;
    fx.uShock2Opacity.value = 0;
    fx.uPortalVeilOpacity.value = 0.06;
    fx.uPortalBandLowerOpacity.value = 0.15;
    fx.uPortalBandUpperOpacity.value = 0.09;
    fx.uPortalCrownOpacity.value = 0.06;

    for (const p of fx.helixParticles) {
      p.mesh.visible = false;
      p.mesh.position.set(0, 0, 0);
      p.mesh.scale.setScalar(p.baseScale * 0.55);
      p.angle = p.helixIndex * Math.PI + (p.particleIndex / 4) * Math.PI * 2;
    }

    for (const p of fx.burstParticles) {
      p.mesh.visible = false;
      p.mesh.position.set(0, 0.5, 0);
      p.mesh.scale.setScalar(0);
      p.velocity.set(0, 0, 0);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE LOOP
  // ═══════════════════════════════════════════════════════════════════════════
  update(dt: number): void {
    if (!this.world.isClient || !this.world.stage?.scene) return;

    const camQuat = this.world.camera?.quaternion;

    for (const fx of this.pool) {
      if (!fx.active) continue;

      fx.life += dt;
      if (fx.mode === "channel") {
        this.updateChannelEffect(fx, dt);
        continue;
      }

      const t = Math.min(fx.life / EFFECT_DURATION, 1.0);

      if (t >= 1) {
        this.deactivateEffect(fx);
        continue;
      }

      // Always-visible elements
      this.updateRuneCircle(fx, t, dt);
      this.updateBaseGlow(fx, t);

      // Phase-gated elements (skip draw calls when not active)
      if (t >= GATHER_END) {
        this.updateBeams(fx, t);
        this.updateCoreFlash(fx, t);
        this.updateShockwaves(fx, t);
        this.updateHelixParticles(fx, dt, camQuat);
        this.updateBurstParticles(fx, t, dt, camQuat);
      }
    }
  }

  private updateChannelEffect(fx: PooledEffect, dt: number): void {
    const localPlayerAnchor = this.getLocalPlayerTeleportAnchor();
    if (!localPlayerAnchor) {
      this.stopHomeTeleportCastEffect();
      return;
    }

    if (
      fx.life * 1000 >
      fx.channelDurationMs + CHANNEL_EFFECT_TIMEOUT_BUFFER_MS
    ) {
      this.deactivateEffect(fx);
      return;
    }

    fx.group.position.copy(localPlayerAnchor);

    const progress = Math.min(
      1,
      (fx.life * 1000) / Math.max(1, fx.channelDurationMs),
    );
    const portalRise = easeOutExpo(progress);
    const portalCinch = easeInQuad(progress);
    const endgameCharge =
      progress > PORTAL_ENDGAME_START
        ? (progress - PORTAL_ENDGAME_START) / (1 - PORTAL_ENDGAME_START)
        : 0;
    const finalTighten = easeInQuad(endgameCharge);
    const pulse = 0.5 + 0.5 * Math.sin(fx.life * 3.2);
    const secondaryPulse = 0.5 + 0.5 * Math.sin(fx.life * 1.8 + 1.2);
    fx.runeCircle.visible = true;
    fx.baseGlow.visible = true;
    fx.innerBeam.visible = false;
    fx.outerBeam.visible = false;
    fx.coreFlash.visible = false;
    fx.shockwave1.visible = false;
    fx.shockwave2.visible = false;
    fx.uRuneOpacity.value = 0.08 + portalRise * 0.08 + endgameCharge * 0.08;
    fx.uGlowOpacity.value = 0.05 + portalRise * 0.05 + pulse * 0.015;
    fx.uInnerBeamOpacity.value = 0;
    fx.uOuterBeamOpacity.value = 0;
    fx.uFlashOpacity.value = 0;
    fx.uShock1Opacity.value = 0;
    fx.uShock2Opacity.value = 0;

    fx.portalVeil.visible = true;
    fx.portalVeil.scale.set(
      0.68 + portalCinch * 0.08 - finalTighten * 0.025,
      0.06 + portalRise * 0.42 + endgameCharge * 0.08,
      0.68 + portalCinch * 0.08 - finalTighten * 0.025,
    );
    fx.uPortalVeilOpacity.value =
      0.035 + portalRise * 0.065 + endgameCharge * 0.08 + pulse * 0.012;

    fx.portalBandLower.visible = true;
    fx.portalBandLower.position.y = 0.02 + portalRise * 0.12;
    fx.portalBandLower.scale.setScalar(
      0.92 + portalCinch * 0.16 + pulse * 0.03 - finalTighten * 0.06,
    );
    fx.portalBandLower.rotation.z +=
      dt * (0.58 + portalRise * 1.2 + endgameCharge * 0.35);
    fx.uPortalBandLowerOpacity.value =
      0.11 + portalRise * 0.08 + endgameCharge * 0.08;

    fx.portalBandUpper.visible = progress > 0.1;
    fx.portalBandUpper.position.y = 0.4 + portalRise * 0.9;
    fx.portalBandUpper.scale.setScalar(
      0.52 + portalRise * 0.18 + secondaryPulse * 0.025 - finalTighten * 0.04,
    );
    fx.portalBandUpper.rotation.z -=
      dt * (0.52 + portalRise * 0.92 + endgameCharge * 0.3);
    fx.uPortalBandUpperOpacity.value = fx.portalBandUpper.visible
      ? 0.05 + portalRise * 0.06 + endgameCharge * 0.09
      : 0;

    fx.portalCrown.visible = progress > 0.28;
    fx.portalCrown.position.y = 0.76 + portalRise * 0.92;
    fx.portalCrown.scale.setScalar(
      0.44 + portalRise * 0.12 + endgameCharge * 0.08,
    );
    fx.portalCrown.rotation.z +=
      dt * (0.85 + portalRise * 1.25 + endgameCharge * 0.35);
    fx.uPortalCrownOpacity.value = fx.portalCrown.visible
      ? 0.045 + portalRise * 0.04 + endgameCharge * 0.08 + pulse * 0.01
      : 0;

    for (const particle of fx.burstParticles) {
      particle.mesh.visible = false;
    }

    for (const particle of fx.helixParticles) {
      particle.mesh.visible = false;
    }
  }

  // ─── Phase helpers ──────────────────────────────────────────────────────
  private gatherProgress(t: number): number {
    return t < GATHER_END ? t / GATHER_END : 1;
  }

  private eruptProgress(t: number): number {
    if (t < GATHER_END) return 0;
    if (t > ERUPT_END) return 1;
    return (t - GATHER_END) / (ERUPT_END - GATHER_END);
  }

  private fadeProgress(t: number): number {
    if (t < SUSTAIN_END) return 0;
    return (t - SUSTAIN_END) / (1.0 - SUSTAIN_END);
  }

  // ─── 1. Ground Rune Circle ────────────────────────────────────────────
  private updateRuneCircle(fx: PooledEffect, t: number, dt: number): void {
    const gp = this.gatherProgress(t);
    const fp = this.fadeProgress(t);

    let opacity = 1.0;
    if (t < GATHER_END) {
      opacity = easeOutQuad(gp);
    } else if (t > SUSTAIN_END) {
      opacity = 1.0 - easeInQuad(fp);
    }
    fx.uRuneOpacity.value = opacity;

    const scale = t < GATHER_END ? 0.5 + 0.9 * easeOutQuad(gp) : 1.4;
    fx.runeCircle.scale.setScalar(scale);

    let rotSpeed: number;
    if (t < GATHER_END) {
      rotSpeed = gp * 2.0;
    } else if (t < SUSTAIN_END) {
      rotSpeed = 2.0;
    } else {
      rotSpeed = 2.0 * (1.0 - fp);
    }
    fx.runeCircle.rotation.z += rotSpeed * dt;
  }

  // ─── 2. Base Glow Disc ────────────────────────────────────────────────
  private updateBaseGlow(fx: PooledEffect, t: number): void {
    const gp = this.gatherProgress(t);
    const fp = this.fadeProgress(t);

    let opacity = 0.8;
    if (t < GATHER_END) {
      opacity = easeOutQuad(gp) * 0.8;
    } else if (t > SUSTAIN_END) {
      opacity = 0.8 * (1.0 - easeInQuad(fp));
    }
    fx.uGlowOpacity.value = opacity;

    let scale = 1.5;
    if (t >= GATHER_END && t <= SUSTAIN_END) {
      scale = 1.5 + 0.2 * Math.sin(fx.life * 6);
    } else if (t < GATHER_END) {
      scale = 0.5 + gp * 1.0;
    }
    fx.baseGlow.scale.setScalar(scale);
  }

  // ─── 3 & 4. Beams ────────────────────────────────────────────────────
  private updateBeams(fx: PooledEffect, t: number): void {
    if (!this.beamElasticCurve) return;

    const ep = this.eruptProgress(t);
    const fp = this.fadeProgress(t);
    const beamT = t < ERUPT_END ? ep : 1.0;
    const scaleY = this.beamElasticCurve.evaluate(beamT);

    fx.innerBeam.visible = true;
    fx.outerBeam.visible = true;

    if (t > SUSTAIN_END) {
      const beamOpacity = 0.85 * (1.0 - easeInQuad(fp));
      const thinFactor = 1.0 - fp * 0.7;
      fx.innerBeam.scale.set(thinFactor, scaleY, thinFactor);
      fx.uInnerBeamOpacity.value = beamOpacity;
      // Hide when fully faded
      if (beamOpacity < 0.01) fx.innerBeam.visible = false;
    } else {
      fx.uInnerBeamOpacity.value = 0.85;
      fx.innerBeam.scale.set(1, scaleY, 1);
    }

    const outerDelay = 0.03;
    const outerT =
      Math.max(0, t - GATHER_END - outerDelay) / (ERUPT_END - GATHER_END);
    const outerScaleY = this.beamElasticCurve.evaluate(Math.min(outerT, 1.0));

    if (t > SUSTAIN_END) {
      const outerOpacity = 0.5 * (1.0 - easeInQuad(fp));
      const outerThin = 1.0 - fp * 0.6;
      fx.outerBeam.scale.set(outerThin, outerScaleY, outerThin);
      fx.uOuterBeamOpacity.value = outerOpacity;
      if (outerOpacity < 0.01) fx.outerBeam.visible = false;
    } else {
      fx.uOuterBeamOpacity.value = 0.5;
      fx.outerBeam.scale.set(1, outerScaleY, 1);
    }
  }

  // ─── 5. Core Flash ────────────────────────────────────────────────────
  private updateCoreFlash(fx: PooledEffect, t: number): void {
    const flashStart = GATHER_END;
    const flashPopEnd = flashStart + 0.02;
    const flashShrinkEnd = flashStart + 0.12;

    if (t >= flashStart && t <= flashShrinkEnd) {
      fx.coreFlash.visible = true;
      if (t <= flashPopEnd) {
        const popT = (t - flashStart) / (flashPopEnd - flashStart);
        fx.coreFlash.scale.setScalar(2.5 * easeOutQuad(popT));
        fx.uFlashOpacity.value = 1.0;
      } else {
        const shrinkT = (t - flashPopEnd) / (flashShrinkEnd - flashPopEnd);
        fx.coreFlash.scale.setScalar(2.5 * (1.0 - easeInQuad(shrinkT)));
        fx.uFlashOpacity.value = 1.0 - easeInQuad(shrinkT);
      }
    } else {
      fx.coreFlash.visible = false;
    }
  }

  // ─── 6 & 7. Shockwave Rings ──────────────────────────────────────────
  private updateShockwaves(fx: PooledEffect, t: number): void {
    this.updateSingleShockwave(
      fx.shockwave1,
      fx.uShock1Opacity,
      t,
      GATHER_END,
      0.2,
      12,
    );
    this.updateSingleShockwave(
      fx.shockwave2,
      fx.uShock2Opacity,
      t,
      GATHER_END + 0.024,
      0.22,
      10,
    );
  }

  private updateSingleShockwave(
    mesh: THREE.Mesh,
    uOpacity: ReturnType<typeof uniform>,
    t: number,
    startT: number,
    duration: number,
    maxScale: number,
  ): void {
    if (t >= startT && t <= startT + duration) {
      mesh.visible = true;
      const st = (t - startT) / duration;
      const eased = easeOutExpo(st);
      mesh.scale.setScalar(1 + (maxScale - 1) * eased);
      uOpacity.value = 0.8 * (1.0 - eased);
    } else {
      mesh.visible = false;
    }
  }

  // ─── 9. Helix Spiral Particles ────────────────────────────────────────
  private updateHelixParticles(
    fx: PooledEffect,
    dt: number,
    camQuat: THREE.Quaternion | undefined,
  ): void {
    for (const p of fx.helixParticles) {
      const localTime =
        fx.life -
        (GATHER_END * EFFECT_DURATION + p.spawnDelay * EFFECT_DURATION);
      if (localTime < 0) {
        p.mesh.visible = false;
        continue;
      }

      p.mesh.visible = true;

      // Spiral upward
      p.angle += dt * (3.0 + p.particleIndex * 0.4);
      const riseSpeed = 2.5 + p.particleIndex * 0.25;
      const radius = Math.max(0.1, 0.8 - localTime * 0.15);

      p.mesh.position.set(
        Math.cos(p.angle) * radius,
        localTime * riseSpeed,
        Math.sin(p.angle) * radius,
      );

      // Recycle if too high
      if (p.mesh.position.y > 16) {
        p.mesh.position.y = 0;
        p.angle = p.helixIndex * Math.PI + (p.particleIndex / 4) * Math.PI * 2;
      }

      // Fade via scale (glow shader handles soft edges)
      const heightFade = Math.max(0, 1.0 - p.mesh.position.y / 16);
      p.mesh.scale.setScalar(p.baseScale * heightFade);

      if (heightFade < 0.01) {
        p.mesh.visible = false;
        continue;
      }

      if (camQuat) {
        p.mesh.quaternion.copy(camQuat);
      }
    }
  }

  // ─── 10. Burst Particles ──────────────────────────────────────────────
  private updateBurstParticles(
    fx: PooledEffect,
    t: number,
    dt: number,
    camQuat: THREE.Quaternion | undefined,
  ): void {
    if (t < GATHER_END) return;

    const burstLocalTime = (t - GATHER_END) * EFFECT_DURATION;

    for (const p of fx.burstParticles) {
      if (burstLocalTime <= 0) {
        p.mesh.visible = false;
        continue;
      }

      p.mesh.visible = true;

      // Gravity simulation
      p.velocity.y -= 6.0 * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);

      // Fade via scale
      const burstFade = Math.max(0, 1.0 - burstLocalTime / 1.8);
      p.mesh.scale.setScalar(p.baseScale * burstFade);

      // Hide if below ground
      if (p.mesh.position.y < -0.5) {
        p.mesh.visible = false;
      }

      if (camQuat) {
        p.mesh.quaternion.copy(camQuat);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEACTIVATE (return to pool, zero disposal)
  // ═══════════════════════════════════════════════════════════════════════════
  private deactivateEffect(fx: PooledEffect): void {
    fx.active = false;
    fx.mode = "burst";
    fx.group.visible = false;
    if (this.homeTeleportCastEffect === fx) {
      this.homeTeleportCastEffect = null;
    }
  }

  private stopHomeTeleportCastEffect(): void {
    if (!this.homeTeleportCastEffect) return;
    this.deactivateEffect(this.homeTeleportCastEffect);
  }

  private getLocalPlayerId(): string | null {
    const player = this.world.entities.player as { id?: string } | null;
    return player?.id ?? null;
  }

  private getLocalPlayerTeleportAnchor(): THREE.Vector3 | null {
    const player = this.world.entities.player as {
      position?: THREE.Vector3;
      avatar?: {
        getBoneTransform?: (boneName: string) => THREE.Matrix4 | null;
      };
    } | null;
    if (!player?.position) {
      return null;
    }

    const anchor = this.localPlayerTeleportAnchor.copy(player.position);
    let lowestBoneY = Number.POSITIVE_INFINITY;

    const getBoneTransform = player.avatar?.getBoneTransform;
    if (getBoneTransform) {
      try {
        for (const boneName of TELEPORT_GROUND_CONTACT_BONES) {
          const boneMatrix = getBoneTransform(boneName);
          if (!boneMatrix) {
            continue;
          }

          const boneWorldPos =
            this.teleportBoneWorldPosition.setFromMatrixPosition(boneMatrix);
          lowestBoneY = Math.min(lowestBoneY, boneWorldPos.y);
        }
      } catch {
        lowestBoneY = Number.POSITIVE_INFINITY;
      }
    }

    const terrain = this.world.getSystem("terrain") as {
      getHeightAt?: (x: number, z: number) => number;
    } | null;
    const terrainHeight = terrain?.getHeightAt?.(anchor.x, anchor.z);
    const safeTerrainHeight: number | null =
      typeof terrainHeight === "number" && Number.isFinite(terrainHeight)
        ? terrainHeight
        : null;

    if (safeTerrainHeight !== null) {
      anchor.y = safeTerrainHeight + PORTAL_GROUND_CLEARANCE;
      if (
        Number.isFinite(lowestBoneY) &&
        Math.abs(lowestBoneY - safeTerrainHeight) <= 0.18
      ) {
        anchor.y = lowestBoneY + PORTAL_GROUND_CLEARANCE;
      }
    } else if (Number.isFinite(lowestBoneY)) {
      anchor.y = lowestBoneY + PORTAL_GROUND_CLEARANCE;
    } else {
      anchor.y += PORTAL_GROUND_CLEARANCE;
    }

    return anchor;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MATERIAL FACTORIES (called only during init)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Shared particle glow material — no per-instance opacity uniform.
   * Particles fade by scaling down; the glow pattern handles soft edges.
   */
  private createParticleGlowMaterial(
    color: THREE.Color,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const center = vec2(float(0.5), float(0.5));
    const dist = length(sub(uv(), center));
    const glow = pow(
      max(sub(float(1.0), mul(dist, float(2.0))), float(0.0)),
      float(3.0),
    );

    const colorVec = vec3(float(color.r), float(color.g), float(color.b));
    material.colorNode = colorVec.mul(glow);
    material.opacityNode = glow.mul(0.8);

    return material;
  }

  /** Textured material with additive blending (rune circle). */
  private createTexturedMaterial(
    tex: THREE.Texture,
    color: THREE.Color,
    uOpacity: FloatUniform,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const texNode = THREE.TSL.texture(tex, uv());
    const colorVec = vec3(float(color.r), float(color.g), float(color.b));
    material.colorNode = texNode.rgb.mul(colorVec);
    material.opacityNode = texNode.a.mul(uOpacity);

    return material;
  }

  /** Structural glow with per-effect opacity uniform (glow disc, flash). */
  private createStructuralGlowMaterial(
    color: THREE.Color,
    uOpacity: FloatUniform,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const center = vec2(float(0.5), float(0.5));
    const dist = length(sub(uv(), center));
    const glow = pow(
      max(sub(float(1.0), mul(dist, float(2.0))), float(0.0)),
      float(3.0),
    );

    const colorVec = vec3(float(color.r), float(color.g), float(color.b));
    material.colorNode = colorVec.mul(glow);
    material.opacityNode = glow.mul(uOpacity);

    return material;
  }

  /** Beam material with vertical gradient + scrolling energy pulse. */
  private createBeamMaterial(
    baseColor: THREE.Color,
    topColor: THREE.Color,
    uOpacity: FloatUniform,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    // Use UV space rather than local position so the gradient remains stable
    // across translated / differently sized cylinders (beams and portal veil).
    const yNorm = uv().y;
    const baseVec = vec3(
      float(baseColor.r),
      float(baseColor.g),
      float(baseColor.b),
    );
    const topVec = vec3(
      float(topColor.r),
      float(topColor.g),
      float(topColor.b),
    );
    const gradientColor = mix(baseVec, topVec, yNorm);

    const pulse = add(
      float(0.86),
      mul(sin(add(mul(yNorm, float(6.0)), mul(time, float(2.6)))), float(0.14)),
    );

    // Soft fade at beam base so it emerges from the rune circle, not through the floor
    const bottomFade = sub(
      float(1.0),
      max(sub(float(1.0), mul(yNorm, float(2.0))), float(0.0)),
    );

    material.colorNode = gradientColor.mul(pulse);
    material.opacityNode = sub(float(1.0), mul(yNorm, float(0.3)))
      .mul(bottomFade)
      .mul(uOpacity)
      .mul(pulse);

    return material;
  }

  /** Simple additive material with uniform opacity (shockwave rings). */
  private createBasicAdditiveMaterial(
    color: THREE.Color,
    uOpacity: FloatUniform,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const colorVec = vec3(float(color.r), float(color.g), float(color.b));
    material.colorNode = colorVec;
    material.opacityNode = uOpacity;

    return material;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEXTURE GENERATORS
  // ═══════════════════════════════════════════════════════════════════════════

  private createRuneTexture(): THREE.CanvasTexture {
    const size = 256;
    const half = size / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;

    ctx.clearRect(0, 0, size, size);

    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(150, 220, 255, 0.3)");
    gradient.addColorStop(0.4, "rgba(100, 180, 255, 0.1)");
    gradient.addColorStop(1, "rgba(50, 120, 255, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = "rgba(180, 230, 255, 0.9)";
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.arc(half, half, 118, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(half, half, 111, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(half, half, 72, 0, Math.PI * 2);
    ctx.stroke();

    for (let s = 0; s < 8; s++) {
      const angle = (s / 8) * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      ctx.beginPath();
      ctx.moveTo(half + cosA * 72, half + sinA * 72);
      ctx.lineTo(half + cosA * 118, half + sinA * 118);
      ctx.stroke();

      ctx.fillStyle = "rgba(220, 240, 255, 1.0)";
      for (const r of [72, 111, 118]) {
        ctx.beginPath();
        ctx.arc(half + cosA * r, half + sinA * r, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      const midAngle = ((s + 0.5) / 8) * Math.PI * 2;
      const rx = half + Math.cos(midAngle) * 92;
      const ry = half + Math.sin(midAngle) * 92;
      ctx.fillStyle = "rgba(180, 230, 255, 0.7)";
      ctx.beginPath();
      ctx.moveTo(rx, ry - 6);
      ctx.lineTo(rx - 4.2, ry + 3);
      ctx.lineTo(rx + 4.2, ry + 3);
      ctx.closePath();
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  destroy(): void {
    this.stopHomeTeleportCastEffect();
    this.world.off(
      EventType.HOME_TELEPORT_CAST_START,
      this.onHomeTeleportCastStart,
    );
    this.world.off(EventType.HOME_TELEPORT_FAILED, this.onHomeTeleportStopped);
    this.world.off(
      EventType.HOME_TELEPORT_CAST_CANCEL,
      this.onHomeTeleportStopped,
    );
    this.world.off(EventType.PLAYER_TELEPORTED, this.onPlayerTeleported);

    // Dispose all pool entries
    for (const fx of this.pool) {
      if (fx.group.parent) {
        fx.group.parent.remove(fx.group);
      }
      for (const mat of fx.perEffectMaterials) {
        mat.dispose();
      }
    }
    this.pool = [];

    // Dispose shared particle materials
    this.particleCyanMat?.dispose();
    this.particleWhiteMat?.dispose();
    this.particleCyanMat = null;
    this.particleWhiteMat = null;

    // Dispose shared geometries
    this.particleGeo?.dispose();
    this.beamInnerGeo?.dispose();
    this.beamOuterGeo?.dispose();
    this.discGeo?.dispose();
    this.runeCircleGeo?.dispose();
    this.shockwaveGeo?.dispose();
    this.sphereGeo?.dispose();
    this.portalVeilGeo?.dispose();
    this.portalRingGeo?.dispose();
    this.particleGeo = null;
    this.beamInnerGeo = null;
    this.beamOuterGeo = null;
    this.discGeo = null;
    this.runeCircleGeo = null;
    this.shockwaveGeo = null;
    this.sphereGeo = null;
    this.portalVeilGeo = null;
    this.portalRingGeo = null;

    // Dispose shared textures
    this.runeTexture?.dispose();
    this.runeTexture = null;

    this.beamElasticCurve = null;

    super.destroy();
  }
}

// ─── Easing functions ─────────────────────────────────────────────────────
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function easeInQuad(t: number): number {
  return t * t;
}

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}
