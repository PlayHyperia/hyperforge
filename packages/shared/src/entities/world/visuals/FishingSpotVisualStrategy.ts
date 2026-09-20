/**
 * FishingSpotVisualStrategy — glow indicator + particle registration + pulse animation.
 */

import THREE, { float, smoothstep, uv } from "../../../extras/three/three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { ParticleSystem } from "../../../systems/shared/presentation/ParticleSystem";
import type { TerrainSystem } from "../../../systems/shared/world/TerrainSystem";
import type {
  ResourceVisualContext,
  ResourceVisualStrategy,
} from "./ResourceVisualStrategy";

// Static texture cache shared across all fishing spot instances
const textureCache = new Map<string, THREE.DataTexture>();

function createColoredGlowTexture(
  colorHex: number,
  size: number,
  sharpness: number,
): THREE.DataTexture {
  const key = `glow:${colorHex}:${size}:${sharpness}`;
  const cached = textureCache.get(key);
  if (cached) return cached;

  const r = (colorHex >> 16) & 0xff;
  const g = (colorHex >> 8) & 0xff;
  const b = colorHex & 0xff;
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
      data[idx] = Math.round(r * strength);
      data[idx + 1] = Math.round(g * strength);
      data[idx + 2] = Math.round(b * strength);
      data[idx + 3] = Math.round(255 * strength);
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  textureCache.set(key, tex);
  return tex;
}

/** Dispose shared texture cache (call on world teardown). */
export function disposeFishingSpotTextures(): void {
  for (const tex of textureCache.values()) tex.dispose();
  textureCache.clear();
}

export class FishingSpotVisualStrategy implements ResourceVisualStrategy {
  private glowMesh?: THREE.Mesh<THREE.CircleGeometry, MeshBasicNodeMaterial>;
  private registeredWithPM = false;
  private subtleDisturbance = false;

  async createVisual(ctx: ResourceVisualContext): Promise<void> {
    this.createGlowIndicator(ctx);
    this.tryRegisterPM(ctx);
  }

  async onDepleted(ctx: ResourceVisualContext): Promise<boolean> {
    if (this.glowMesh) this.glowMesh.visible = false;

    if (this.registeredWithPM) {
      const pm = this.getPM(ctx);
      if (pm) pm.unregister(ctx.id);
      this.registeredWithPM = false;
    }
    return false;
  }

  async onRespawn(ctx: ResourceVisualContext): Promise<void> {
    if (this.glowMesh) {
      this.glowMesh.visible = true;
    } else {
      this.createGlowIndicator(ctx);
    }
    this.registeredWithPM = false;
    this.tryRegisterPM(ctx);
  }

  update(ctx: ResourceVisualContext): void {
    if (ctx.config.depleted) {
      if (this.registeredWithPM) {
        const pm = this.getPM(ctx);
        if (pm) pm.unregister(ctx.id);
        this.registeredWithPM = false;
      }
      return;
    }

    if (!this.registeredWithPM) {
      this.tryRegisterPM(ctx);
    }

    if (this.glowMesh) {
      const now = Date.now();
      const slow = Math.sin(now * 0.0015) * 0.04;
      const fast = Math.sin(now * 0.004 + 1.3) * 0.02;
      this.glowMesh.material.opacity = this.subtleDisturbance
        ? 0.07 + slow * 0.375 + fast * 0.25
        : 0.18 + slow + fast;
    }
  }

  destroy(ctx: ResourceVisualContext): void {
    if (this.registeredWithPM) {
      const pm = this.getPM(ctx);
      if (pm) pm.unregister(ctx.id);
      this.registeredWithPM = false;
    }

    if (this.glowMesh) {
      this.glowMesh.geometry.dispose();
      this.glowMesh.material.dispose();
      ctx.node.remove(this.glowMesh);
      this.glowMesh = undefined;
    }
  }

  // ---- helpers ----

  private createGlowIndicator(ctx: ResourceVisualContext): void {
    const profile = ctx.world
      .getSystem<TerrainSystem>("terrain")
      ?.getWorldTerrainProfile();
    this.subtleDisturbance =
      profile?.id === "compact-duel-island-v6" && !!profile.southernMeadow;
    const geometry = new THREE.CircleGeometry(0.6, 16);
    const material = new MeshBasicNodeMaterial();
    material.color = new THREE.Color(
      this.subtleDisturbance ? 0x92aaa7 : 0x4488ff,
    );
    material.transparent = true;
    material.opacity = this.subtleDisturbance ? 0.07 : 0.3;
    material.side = THREE.DoubleSide;
    if (this.subtleDisturbance) {
      // The real water-particle owner already supplies animated ripple rings.
      // Keep only a soft, faint disturbance here; its unchanged geometry still
      // provides the full interaction target even where visual alpha is zero.
      const radius = uv().sub(0.5).mul(2).length();
      material.opacityNode = float(1)
        .sub(smoothstep(float(0.12), float(1), radius))
        .pow(1.5)
        .mul(THREE.TSL.materialOpacity);
      material.depthWrite = false;
    }

    this.glowMesh = new THREE.Mesh(geometry, material);
    this.glowMesh.rotation.x = -Math.PI / 2;
    this.glowMesh.position.y = 0.05;
    this.glowMesh.name = "FishingSpotGlow";

    this.glowMesh.userData = {
      type: "resource",
      entityId: ctx.id,
      name: ctx.config.name,
      interactable: true,
      resourceType: ctx.config.resourceType,
      depleted: ctx.config.depleted,
    };

    ctx.node.add(this.glowMesh);
  }

  private tryRegisterPM(ctx: ResourceVisualContext): boolean {
    if (this.registeredWithPM) return true;
    const pm = this.getPM(ctx);
    if (!pm) return false;

    const pos = ctx.position;
    pm.register(ctx.id, {
      type: "water",
      position: { x: pos.x, y: pos.y, z: pos.z },
      resourceId: ctx.config.resourceId || "",
    });
    this.registeredWithPM = true;
    return true;
  }

  private getPM(ctx: ResourceVisualContext): ParticleSystem | undefined {
    return ctx.world.getSystem("particle") as ParticleSystem | undefined;
  }
}
