/**
 * WaterParticleManager - GPU-Instanced Water / Fishing Spot Effects
 *
 * Centralises all fishing-spot particle + ripple rendering into 4 InstancedMeshes
 * (splash, bubble, shimmer, ripple) driven by TSL NodeMaterials.
 *
 * Per-instance data is stored in named InstancedBufferAttributes:
 *   spotPos     (vec3)  – fishing spot world center
 *   ageLifetime (vec2)  – current age (x), total lifetime (y)
 *   angleRadius (vec2)  – polar angle (x), radial distance (y)
 *   dynamics    (vec4)  – peakHeight (x), size (y), speed (z), direction (w)
 *
 * Vertex buffer budget per particle layer = 7 of 8 max:
 *   position(1) + uv(1) + instanceMatrix(1) + spotPos(1) + ageLifetime(1) + angleRadius(1) + dynamics(1)
 *
 * Ripple layer = 5 of 8 max:
 *   position(1) + uv(1) + instanceMatrix(1) + spotPos(1) + rippleParams(1)
 *
 * @module WaterParticleManager
 */

import * as THREE from "../../../extras/three/three";
import type { Node, UniformNode } from "three/webgpu";
import {
  attribute,
  uniform,
  MeshBasicNodeMaterial,
  uv,
  texture,
  float,
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
  fract,
  step,
  mix,
  time,
  positionLocal,
} from "../../../extras/three/three";

// =============================================================================
// POOL SIZES
// =============================================================================

const MAX_SPLASH = 96;
const MAX_BUBBLE = 72;
const MAX_SHIMMER = 72;
const MAX_RIPPLE = 24;

// =============================================================================
// INTERFACES
// =============================================================================

export interface FishingSpotVariant {
  color: number;
  rippleSpeed: number;
  rippleCount: number;
  splashCount: number;
  bubbleCount: number;
  shimmerCount: number;
  splashColor: number;
  bubbleColor: number;
  shimmerColor: number;
  burstIntervalMin: number;
  burstIntervalMax: number;
  burstSplashCount: number;
}

interface ActiveSpot {
  entityId: string;
  position: { x: number; y: number; z: number };
  variant: FishingSpotVariant;
  splashSlots: number[];
  bubbleSlots: number[];
  shimmerSlots: number[];
  rippleSlots: number[];
  burstTimer: number;
}

interface ParticleLayer {
  mesh: THREE.InstancedMesh;
  maxInstances: number;
  freeSlots: number[];
  spotPosArr: Float32Array;
  ageLifetimeArr: Float32Array;
  angleRadiusArr: Float32Array;
  dynamicsArr: Float32Array;
  spotPosAttr: THREE.InstancedBufferAttribute;
  ageLifetimeAttr: THREE.InstancedBufferAttribute;
  angleRadiusAttr: THREE.InstancedBufferAttribute;
  dynamicsAttr: THREE.InstancedBufferAttribute;
}

interface RippleLayer {
  mesh: THREE.InstancedMesh;
  maxInstances: number;
  freeSlots: number[];
  spotPosArr: Float32Array;
  rippleParamsArr: Float32Array;
  spotPosAttr: THREE.InstancedBufferAttribute;
  rippleParamsAttr: THREE.InstancedBufferAttribute;
}

// =============================================================================
// HELPERS
// =============================================================================

function hexToVec3(hex: number): [number, number, number] {
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
}

export function getFishingSpotVariant(resourceId: string): FishingSpotVariant {
  if (resourceId.includes("net")) {
    return {
      color: 0x88ccff,
      rippleSpeed: 0.8,
      rippleCount: 2,
      splashCount: 4,
      bubbleCount: 3,
      shimmerCount: 3,
      splashColor: 0xddeeff,
      bubbleColor: 0x99ccee,
      shimmerColor: 0xeef4ff,
      burstIntervalMin: 5,
      burstIntervalMax: 10,
      burstSplashCount: 2,
    };
  } else if (resourceId.includes("fly")) {
    return {
      color: 0xaaddff,
      rippleSpeed: 1.5,
      rippleCount: 2,
      splashCount: 8,
      bubbleCount: 5,
      shimmerCount: 5,
      splashColor: 0xeef5ff,
      bubbleColor: 0xaaddee,
      shimmerColor: 0xf5faff,
      burstIntervalMin: 2,
      burstIntervalMax: 5,
      burstSplashCount: 4,
    };
  }
  return {
    color: 0x66bbff,
    rippleSpeed: 1.0,
    rippleCount: 2,
    splashCount: 5,
    bubbleCount: 4,
    shimmerCount: 4,
    splashColor: 0xddeeff,
    bubbleColor: 0x88ccee,
    shimmerColor: 0xeef4ff,
    burstIntervalMin: 3,
    burstIntervalMax: 7,
    burstSplashCount: 3,
  };
}

// =============================================================================
// MAIN CLASS
// =============================================================================

export class WaterParticleManager {
  private scene: THREE.Scene;
  private activeSpots = new Map<string, ActiveSpot>();

  private glowTexture: THREE.DataTexture;
  private ringTexture: THREE.DataTexture;

  private uCameraRight: UniformNode<"vec3", THREE.Vector3>;
  private uCameraUp: UniformNode<"vec3", THREE.Vector3>;

  private splashLayer!: ParticleLayer;
  private bubbleLayer!: ParticleLayer;
  private shimmerLayer!: ParticleLayer;
  private rippleLayer!: RippleLayer;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.glowTexture = this.createGlowTexture(64, 2.0);
    this.ringTexture = this.createRingTexture(64, 0.65, 0.22);

    this.uCameraRight = uniform(new THREE.Vector3(1, 0, 0));
    this.uCameraUp = uniform(new THREE.Vector3(0, 1, 0));

    this.splashLayer = this.createParticleLayer(MAX_SPLASH, 0xddeeff, "splash");
    this.bubbleLayer = this.createParticleLayer(MAX_BUBBLE, 0x88ccee, "bubble");
    this.shimmerLayer = this.createParticleLayer(
      MAX_SHIMMER,
      0xeef4ff,
      "shimmer",
    );
    this.rippleLayer = this.createRippleLayer(MAX_RIPPLE, 0x66bbff);

    console.log(
      `[WaterParticleManager] Initialized: 4 InstancedMeshes, TSL materials`,
    );
  }

  // ===========================================================================
  // TEXTURE GENERATION
  // ===========================================================================

  private createGlowTexture(
    size: number,
    sharpness: number,
  ): THREE.DataTexture {
    const data = new Uint8Array(size * size * 4);
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half;
        const dy = (y + 0.5 - half) / half;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const falloff = Math.max(0, 1 - dist);
        const strength = Math.pow(falloff, sharpness);
        const idx = (y * size + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = Math.round(255 * strength);
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  private createRingTexture(
    size: number,
    ringRadius: number,
    ringWidth: number,
  ): THREE.DataTexture {
    const data = new Uint8Array(size * size * 4);
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half;
        const dy = (y + 0.5 - half) / half;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ringDist = Math.abs(dist - ringRadius) / ringWidth;
        const strength = Math.exp(-ringDist * ringDist * 4);
        const edgeFade = Math.min(Math.max((1 - dist) * 5, 0), 1);
        const alpha = strength * edgeFade;
        const idx = (y * size + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = Math.round(255 * alpha);
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  // ===========================================================================
  // LAYER CREATION
  // ===========================================================================

  private createParticleLayer(
    maxInstances: number,
    colorHex: number,
    layerType: "splash" | "bubble" | "shimmer",
  ): ParticleLayer {
    const geometry = new THREE.PlaneGeometry(1, 1);

    const spotPosArr = new Float32Array(maxInstances * 3);
    const ageLifetimeArr = new Float32Array(maxInstances * 2);
    const angleRadiusArr = new Float32Array(maxInstances * 2);
    const dynamicsArr = new Float32Array(maxInstances * 4);

    for (let i = 0; i < maxInstances; i++) {
      ageLifetimeArr[i * 2 + 1] = 1.0;
    }

    const spotPosAttr = new THREE.InstancedBufferAttribute(spotPosArr, 3);
    const ageLifetimeAttr = new THREE.InstancedBufferAttribute(
      ageLifetimeArr,
      2,
    );
    const angleRadiusAttr = new THREE.InstancedBufferAttribute(
      angleRadiusArr,
      2,
    );
    const dynamicsAttr = new THREE.InstancedBufferAttribute(dynamicsArr, 4);

    spotPosAttr.setUsage(THREE.DynamicDrawUsage);
    ageLifetimeAttr.setUsage(THREE.DynamicDrawUsage);
    angleRadiusAttr.setUsage(THREE.DynamicDrawUsage);
    dynamicsAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute("spotPos", spotPosAttr);
    geometry.setAttribute("ageLifetime", ageLifetimeAttr);
    geometry.setAttribute("angleRadius", angleRadiusAttr);
    geometry.setAttribute("dynamics", dynamicsAttr);

    const material = this.createParticleMaterial(
      colorHex,
      layerType,
      this.glowTexture,
    );

    const mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
    mesh.frustumCulled = false;
    mesh.count = maxInstances;

    const identity = new THREE.Matrix4();
    for (let i = 0; i < maxInstances; i++) {
      mesh.setMatrixAt(i, identity);
    }
    mesh.instanceMatrix.needsUpdate = true;

    this.scene.add(mesh);

    const freeSlots: number[] = [];
    for (let i = maxInstances - 1; i >= 0; i--) freeSlots.push(i);

    return {
      mesh,
      maxInstances,
      freeSlots,
      spotPosArr,
      ageLifetimeArr,
      angleRadiusArr,
      dynamicsArr,
      spotPosAttr,
      ageLifetimeAttr,
      angleRadiusAttr,
      dynamicsAttr,
    };
  }

  private createRippleLayer(
    maxInstances: number,
    colorHex: number,
  ): RippleLayer {
    const geometry = new THREE.CircleGeometry(0.5, 24);

    const spotPosArr = new Float32Array(maxInstances * 3);
    const rippleParamsArr = new Float32Array(maxInstances * 2);

    const spotPosAttr = new THREE.InstancedBufferAttribute(spotPosArr, 3);
    const rippleParamsAttr = new THREE.InstancedBufferAttribute(
      rippleParamsArr,
      2,
    );
    spotPosAttr.setUsage(THREE.DynamicDrawUsage);
    rippleParamsAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute("spotPos", spotPosAttr);
    geometry.setAttribute("rippleParams", rippleParamsAttr);

    const material = this.createRippleMaterial(colorHex, this.ringTexture);

    const mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
    mesh.frustumCulled = false;
    mesh.count = maxInstances;

    const identity = new THREE.Matrix4();
    for (let i = 0; i < maxInstances; i++) {
      mesh.setMatrixAt(i, identity);
    }
    mesh.instanceMatrix.needsUpdate = true;

    this.scene.add(mesh);

    const freeSlots: number[] = [];
    for (let i = maxInstances - 1; i >= 0; i--) freeSlots.push(i);

    return {
      mesh,
      maxInstances,
      freeSlots,
      spotPosArr,
      rippleParamsArr,
      spotPosAttr,
      rippleParamsAttr,
    };
  }

  // ===========================================================================
  // TSL MATERIALS
  // ===========================================================================

  private createParticleMaterial(
    colorHex: number,
    layerType: "splash" | "bubble" | "shimmer",
    glowTex: THREE.DataTexture,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    const spotPos = attribute<"vec3">("spotPos", "vec3");
    const ageLifetime = attribute<"vec2">("ageLifetime", "vec2");
    const age = ageLifetime.x;
    const lifetime = ageLifetime.y;
    const t = div(age, lifetime);

    const angleRadius = attribute<"vec2">("angleRadius", "vec2");
    const angle = angleRadius.x;
    const radius = angleRadius.y;

    const dynamics = attribute<"vec4">("dynamics", "vec4");
    const peakHeight = dynamics.x;
    const size = dynamics.y;
    const speed = dynamics.z;
    const direction = dynamics.w;

    const camRight = this.uCameraRight;
    const camUp = this.uCameraUp;

    let particleCenter: Node<"vec3">;

    if (layerType === "splash") {
      const arcY = mul(peakHeight, mul(float(4), mul(t, sub(float(1), t))));
      const ox = mul(cos(angle), radius);
      const oz = mul(sin(angle), radius);
      particleCenter = add(spotPos, vec3(ox, add(float(0.08), arcY), oz));
    } else if (layerType === "bubble") {
      const riseY = mul(t, peakHeight);
      const wobbleFreq = mul(direction, float(4.0));
      const drift = mul(sin(add(angle, mul(t, wobbleFreq))), radius);
      const driftZ = mul(
        cos(add(angle, mul(t, float(2.5)))),
        mul(radius, float(0.6)),
      );
      particleCenter = add(
        spotPos,
        vec3(drift, add(float(0.03), riseY), driftZ),
      );
    } else {
      const freq = mul(speed, mul(direction, float(6)));
      const wanderX = mul(cos(add(angle, mul(t, freq))), radius);
      const wanderZ = mul(sin(add(angle, mul(t, freq))), radius);
      particleCenter = add(spotPos, vec3(wanderX, float(0.06), wanderZ));
    }

    const localXY = positionLocal.xy;
    const billboardOffset = camRight
      .mul(localXY.x)
      .mul(size)
      .add(camUp.mul(localXY.y).mul(size));
    material.positionNode = add(particleCenter, billboardOffset);

    const [r, g, b] = hexToVec3(colorHex);
    material.colorNode = vec3(float(r), float(g), float(b));

    const texAlpha = texture(glowTex, uv()).a;

    if (layerType === "splash") {
      const fadeIn = min(mul(t, float(12)), float(1));
      const fadeOut = pow(sub(float(1), t), float(1.2));
      material.opacityNode = mul(
        texAlpha,
        mul(float(0.9), mul(fadeIn, fadeOut)),
      );
    } else if (layerType === "bubble") {
      const fadeIn = min(mul(t, float(6)), float(1));
      const fadeOut = pow(sub(float(1), t), float(1.2));
      material.opacityNode = mul(
        texAlpha,
        mul(float(0.8), mul(fadeIn, fadeOut)),
      );
    } else {
      const twinkle = max(
        float(0),
        mul(
          sin(add(mul(time, float(8)), mul(angle, float(5)))),
          sin(add(mul(time, float(13)), mul(angle, float(3)))),
        ),
      );
      const envelope = mul(
        min(mul(t, float(4)), float(1)),
        min(mul(sub(float(1), t), float(4)), float(1)),
      );
      material.opacityNode = mul(
        texAlpha,
        mul(float(0.85), mul(twinkle, envelope)),
      );
    }

    return material;
  }

  private createRippleMaterial(
    colorHex: number,
    ringTex: THREE.DataTexture,
  ): InstanceType<typeof MeshBasicNodeMaterial> {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    const spotPos = attribute<"vec3">("spotPos", "vec3");
    const rippleParams = attribute<"vec2">("rippleParams", "vec2");
    const phaseOffset = rippleParams.x;
    const rippleSpeed = rippleParams.y;

    const phase = fract(
      add(mul(time, mul(rippleSpeed, float(0.5))), phaseOffset),
    );

    const scale = add(float(0.15), mul(phase, float(1.3)));

    const localXY = positionLocal.xy;
    const worldPos = add(
      vec3(spotPos.x, add(spotPos.y, float(0.1)), spotPos.z),
      vec3(mul(localXY.x, scale), float(0), mul(localXY.y, scale)),
    );
    material.positionNode = worldPos;

    const [r, g, b] = hexToVec3(colorHex);
    material.colorNode = vec3(float(r), float(g), float(b));

    const texAlpha = texture(ringTex, uv()).a;
    const earlyFade = mul(div(phase, float(0.15)), float(0.55));
    const lateFade = mul(
      float(0.55),
      pow(sub(float(1), div(sub(phase, float(0.15)), float(0.85))), float(1.5)),
    );
    const s = step(float(0.15), phase);
    const rippleOpacity = mix(earlyFade, lateFade, s);

    material.opacityNode = mul(texAlpha, rippleOpacity);

    return material;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  registerSpot(config: {
    entityId: string;
    position: { x: number; y: number; z: number };
    resourceId: string;
  }): void {
    if (this.activeSpots.has(config.entityId)) return;

    const variant = getFishingSpotVariant(config.resourceId);
    const pos = config.position;

    const splashSlots = this.allocSlots(this.splashLayer, variant.splashCount);
    for (const s of splashSlots) {
      this.writeParticle(this.splashLayer, s, pos, {
        age: Math.random() * 1.2,
        lifetime: 0.6 + Math.random() * 0.6,
        angle: Math.random() * Math.PI * 2,
        radius: 0.05 + Math.random() * 0.3,
        peakHeight: 0.12 + Math.random() * 0.2,
        size: 0.055,
        speed: 0.3 + Math.random() * 0.4,
        direction: Math.random() > 0.5 ? 1 : -1,
      });
    }

    const bubbleSlots = this.allocSlots(this.bubbleLayer, variant.bubbleCount);
    for (const s of bubbleSlots) {
      this.writeParticle(this.bubbleLayer, s, pos, {
        age: Math.random() * 2.5,
        lifetime: 1.2 + Math.random() * 1.3,
        angle: Math.random() * Math.PI * 2,
        radius: 0.04 + Math.random() * 0.2,
        peakHeight: 0.3 + Math.random() * 0.25,
        size: 0.09,
        speed: 0.15 + Math.random() * 0.2,
        direction: Math.random() > 0.5 ? 1 : -1,
      });
    }

    const shimmerSlots = this.allocSlots(
      this.shimmerLayer,
      variant.shimmerCount,
    );
    for (const s of shimmerSlots) {
      this.writeParticle(this.shimmerLayer, s, pos, {
        age: Math.random() * 3.0,
        lifetime: 1.5 + Math.random() * 1.5,
        angle: Math.random() * Math.PI * 2,
        radius: 0.15 + Math.random() * 0.45,
        peakHeight: 0,
        size: 0.055,
        speed: 0.1 + Math.random() * 0.15,
        direction: Math.random() > 0.5 ? 1 : -1,
      });
    }

    const rippleSlots: number[] = [];
    for (let i = 0; i < variant.rippleCount; i++) {
      if (this.rippleLayer.freeSlots.length === 0) break;
      const s = this.rippleLayer.freeSlots.pop()!;
      rippleSlots.push(s);
      const R = this.rippleLayer;
      R.spotPosArr[s * 3] = pos.x;
      R.spotPosArr[s * 3 + 1] = pos.y;
      R.spotPosArr[s * 3 + 2] = pos.z;
      R.rippleParamsArr[s * 2] = i / variant.rippleCount;
      R.rippleParamsArr[s * 2 + 1] = variant.rippleSpeed;
    }
    if (rippleSlots.length > 0) {
      this.rippleLayer.spotPosAttr.needsUpdate = true;
      this.rippleLayer.rippleParamsAttr.needsUpdate = true;
    }

    this.activeSpots.set(config.entityId, {
      entityId: config.entityId,
      position: { ...pos },
      variant,
      splashSlots,
      bubbleSlots,
      shimmerSlots,
      rippleSlots,
      burstTimer:
        variant.burstIntervalMin +
        Math.random() * (variant.burstIntervalMax - variant.burstIntervalMin),
    });

    console.log(
      `[WaterParticles] Registered ${config.entityId}: ` +
        `${splashSlots.length}S+${bubbleSlots.length}B+${shimmerSlots.length}Sh+${rippleSlots.length}R ` +
        `at (${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)})`,
    );
  }

  unregisterSpot(entityId: string): void {
    const spot = this.activeSpots.get(entityId);
    if (!spot) return;

    const clearParticle = (layer: ParticleLayer, slots: number[]) => {
      for (const s of slots) {
        layer.dynamicsArr[s * 4 + 1] = 0;
        layer.freeSlots.push(s);
      }
      if (slots.length > 0) layer.dynamicsAttr.needsUpdate = true;
    };
    clearParticle(this.splashLayer, spot.splashSlots);
    clearParticle(this.bubbleLayer, spot.bubbleSlots);
    clearParticle(this.shimmerLayer, spot.shimmerSlots);

    for (const s of spot.rippleSlots) {
      this.rippleLayer.rippleParamsArr[s * 2] = 0;
      this.rippleLayer.rippleParamsArr[s * 2 + 1] = 0;
      this.rippleLayer.freeSlots.push(s);
    }
    if (spot.rippleSlots.length > 0) {
      this.rippleLayer.rippleParamsAttr.needsUpdate = true;
    }

    this.activeSpots.delete(entityId);
  }

  moveSpot(
    entityId: string,
    newPos: { x: number; y: number; z: number },
  ): void {
    const spot = this.activeSpots.get(entityId);
    if (!spot) return;

    spot.position = { ...newPos };

    const updateLayer = (layer: ParticleLayer, slots: number[]) => {
      for (const s of slots) {
        layer.spotPosArr[s * 3] = newPos.x;
        layer.spotPosArr[s * 3 + 1] = newPos.y;
        layer.spotPosArr[s * 3 + 2] = newPos.z;
      }
      if (slots.length > 0) layer.spotPosAttr.needsUpdate = true;
    };
    updateLayer(this.splashLayer, spot.splashSlots);
    updateLayer(this.bubbleLayer, spot.bubbleSlots);
    updateLayer(this.shimmerLayer, spot.shimmerSlots);

    for (const s of spot.rippleSlots) {
      this.rippleLayer.spotPosArr[s * 3] = newPos.x;
      this.rippleLayer.spotPosArr[s * 3 + 1] = newPos.y;
      this.rippleLayer.spotPosArr[s * 3 + 2] = newPos.z;
    }
    if (spot.rippleSlots.length > 0) {
      this.rippleLayer.spotPosAttr.needsUpdate = true;
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    if (this.activeSpots.size === 0) return;

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    camera.matrixWorld.extractBasis(right, up, fwd);
    this.uCameraRight.value.copy(right);
    this.uCameraUp.value.copy(up);

    let splashALDirty = false;
    let splashARDirty = false;
    let splashDynDirty = false;
    let bubbleALDirty = false;
    let bubbleARDirty = false;
    let bubbleDynDirty = false;
    let shimmerALDirty = false;
    let shimmerARDirty = false;

    for (const spot of this.activeSpots.values()) {
      for (const s of spot.splashSlots) {
        const L = this.splashLayer;
        const al = L.ageLifetimeArr;
        al[s * 2] += dt;
        if (al[s * 2] >= al[s * 2 + 1]) {
          al[s * 2] -= al[s * 2 + 1];
          al[s * 2 + 1] = 0.6 + Math.random() * 0.6;
          L.angleRadiusArr[s * 2] = Math.random() * Math.PI * 2;
          L.angleRadiusArr[s * 2 + 1] = 0.05 + Math.random() * 0.3;
          L.dynamicsArr[s * 4] = 0.12 + Math.random() * 0.2;
          splashARDirty = true;
          splashDynDirty = true;
        }
        splashALDirty = true;
      }

      for (const s of spot.bubbleSlots) {
        const L = this.bubbleLayer;
        const al = L.ageLifetimeArr;
        al[s * 2] += dt;
        if (al[s * 2] >= al[s * 2 + 1]) {
          al[s * 2] -= al[s * 2 + 1];
          L.angleRadiusArr[s * 2] = Math.random() * Math.PI * 2;
          L.angleRadiusArr[s * 2 + 1] = 0.04 + Math.random() * 0.2;
          L.dynamicsArr[s * 4] = 0.3 + Math.random() * 0.25;
          bubbleARDirty = true;
          bubbleDynDirty = true;
        }
        bubbleALDirty = true;
      }

      for (const s of spot.shimmerSlots) {
        const L = this.shimmerLayer;
        const al = L.ageLifetimeArr;
        al[s * 2] += dt;
        if (al[s * 2] >= al[s * 2 + 1]) {
          al[s * 2] -= al[s * 2 + 1];
          L.angleRadiusArr[s * 2] = Math.random() * Math.PI * 2;
          shimmerARDirty = true;
        }
        shimmerALDirty = true;
      }

      spot.burstTimer -= dt;
      if (spot.burstTimer <= 0) {
        const v = spot.variant;
        spot.burstTimer =
          v.burstIntervalMin +
          Math.random() * (v.burstIntervalMax - v.burstIntervalMin);
        this.fireBurst(spot);
        splashALDirty = true;
        splashARDirty = true;
        splashDynDirty = true;
      }
    }

    if (splashALDirty) this.splashLayer.ageLifetimeAttr.needsUpdate = true;
    if (splashARDirty) this.splashLayer.angleRadiusAttr.needsUpdate = true;
    if (splashDynDirty) this.splashLayer.dynamicsAttr.needsUpdate = true;
    if (bubbleALDirty) this.bubbleLayer.ageLifetimeAttr.needsUpdate = true;
    if (bubbleARDirty) this.bubbleLayer.angleRadiusAttr.needsUpdate = true;
    if (bubbleDynDirty) this.bubbleLayer.dynamicsAttr.needsUpdate = true;
    if (shimmerALDirty) this.shimmerLayer.ageLifetimeAttr.needsUpdate = true;
    if (shimmerARDirty) this.shimmerLayer.angleRadiusAttr.needsUpdate = true;
  }

  dispose(): void {
    const disposeMesh = (mesh: THREE.InstancedMesh) => {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    };

    disposeMesh(this.splashLayer.mesh);
    disposeMesh(this.bubbleLayer.mesh);
    disposeMesh(this.shimmerLayer.mesh);
    disposeMesh(this.rippleLayer.mesh);

    this.glowTexture.dispose();
    this.ringTexture.dispose();
    this.activeSpots.clear();
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private allocSlots(layer: ParticleLayer, count: number): number[] {
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      if (layer.freeSlots.length === 0) break;
      slots.push(layer.freeSlots.pop()!);
    }
    return slots;
  }

  private writeParticle(
    layer: ParticleLayer,
    slot: number,
    pos: { x: number; y: number; z: number },
    p: {
      age: number;
      lifetime: number;
      angle: number;
      radius: number;
      peakHeight: number;
      size: number;
      speed: number;
      direction: number;
    },
  ): void {
    const s = slot;
    layer.spotPosArr[s * 3] = pos.x;
    layer.spotPosArr[s * 3 + 1] = pos.y;
    layer.spotPosArr[s * 3 + 2] = pos.z;
    layer.ageLifetimeArr[s * 2] = p.age;
    layer.ageLifetimeArr[s * 2 + 1] = p.lifetime;
    layer.angleRadiusArr[s * 2] = p.angle;
    layer.angleRadiusArr[s * 2 + 1] = p.radius;
    layer.dynamicsArr[s * 4] = p.peakHeight;
    layer.dynamicsArr[s * 4 + 1] = p.size;
    layer.dynamicsArr[s * 4 + 2] = p.speed;
    layer.dynamicsArr[s * 4 + 3] = p.direction;

    layer.spotPosAttr.needsUpdate = true;
    layer.ageLifetimeAttr.needsUpdate = true;
    layer.angleRadiusAttr.needsUpdate = true;
    layer.dynamicsAttr.needsUpdate = true;
  }

  private fireBurst(spot: ActiveSpot): void {
    const burstAngle = Math.random() * Math.PI * 2;
    const burstR = 0.05 + Math.random() * 0.15;
    const cx = Math.cos(burstAngle) * burstR;
    const cz = Math.sin(burstAngle) * burstR;
    let fired = 0;
    const L = this.splashLayer;

    for (const s of spot.splashSlots) {
      if (fired >= spot.variant.burstSplashCount) break;
      const t = L.ageLifetimeArr[s * 2] / L.ageLifetimeArr[s * 2 + 1];
      if (t > 0.6) {
        L.ageLifetimeArr[s * 2] = 0;
        const spread = 0.06;
        L.angleRadiusArr[s * 2] = Math.atan2(
          cz + (Math.random() - 0.5) * spread,
          cx + (Math.random() - 0.5) * spread,
        );
        L.angleRadiusArr[s * 2 + 1] =
          Math.sqrt(cx * cx + cz * cz) + (Math.random() - 0.5) * 0.08;
        L.dynamicsArr[s * 4] = 0.25 + Math.random() * 0.35;
        L.ageLifetimeArr[s * 2 + 1] = 0.5 + Math.random() * 0.4;
        fired++;
      }
    }
  }
}
