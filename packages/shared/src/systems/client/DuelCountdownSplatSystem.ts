/**
 * DuelCountdownSplatSystem - Countdown Numbers Over Player Heads
 *
 * Displays the duel countdown (3, 2, 1, FIGHT!) as floating text
 * above both duelists' heads during the countdown phase.
 *
 * Features:
 * - Large, color-coded numbers (red 3, orange 2, yellow 1, green FIGHT!)
 * - Displays over BOTH players' heads simultaneously
 * - Animated pulse effect on each countdown tick
 * - Auto-removes after animation completes
 *
 * Architecture:
 * - Listens to DUEL_COUNTDOWN_TICK events from ClientNetwork
 * - Pre-renders 4 textures (one per count value) on first use — no per-event canvas creation
 * - Maintains a pool of sprite+material pairs reused across ticks
 * - Animates with scale punch and fade effects
 */

import * as THREE from "../../extras/three/three";
import { System } from "../shared/infrastructure/System";
import { EventType } from "../../types/events";
import type { World } from "../../core/World";
import type { WorldOptions } from "../../types/index";
import { isStreamingLikeViewport } from "../../runtime/clientViewportMode";

interface CountdownSplat {
  poolItem: SplatPoolItem;
  entityId: string;
  startTime: number;
  duration: number;
  baseScale: number;
}

/** Reusable sprite+material pair. Material.map is swapped per count value. */
interface SplatPoolItem {
  material: THREE.SpriteMaterial;
  sprite: THREE.Sprite;
  active: boolean;
}

// Color coding for countdown numbers (classic MMORPG-style)
const COUNT_COLORS: Record<number, string> = {
  3: "#ff4444", // Red
  2: "#ff8800", // Orange
  1: "#ffcc00", // Yellow
  0: "#44ff44", // Green (FIGHT!)
};

export class DuelCountdownSplatSystem extends System {
  name = "duel-countdown-splat";

  private activeSplats: CountdownSplat[] = [];
  private readonly SPLAT_DURATION = 900; // Slightly less than 1 second to clear before next tick
  private readonly SPLAT_SIZE = 1.2; // Larger than damage splats for visibility
  private readonly HEIGHT_OFFSET = 2.5; // Height above player
  private readonly POOL_SIZE = 6; // 2 active per tick + buffer

  // Pre-allocated array for removal indices
  private readonly _toRemove: number[] = [];

  // Bound handler reference for cleanup
  private boundCountdownHandler: ((data: unknown) => void) | null = null;

  // Pre-rendered textures: one per count value (0=FIGHT!, 1, 2, 3)
  // Created once on first use, reused for every countdown tick — no per-event canvas allocation
  private countTextures: Map<number, THREE.CanvasTexture> = new Map();

  // Pool of reusable sprite+material pairs
  private splatPool: SplatPoolItem[] = [];
  private poolInitialized = false;

  constructor(world: World) {
    super(world);
  }

  async init(options?: WorldOptions): Promise<void> {
    await super.init(options as WorldOptions);

    if (!this.world.isClient) return;

    // Prevent duplicate subscriptions
    if (this.boundCountdownHandler) return;

    this.boundCountdownHandler = this.onCountdownTick.bind(this);
    this.world.on(
      EventType.DUEL_COUNTDOWN_TICK,
      this.boundCountdownHandler,
      this,
    );
  }

  async start(): Promise<void> {
    super.start();
    if (this.world.isClient && isStreamingLikeViewport()) {
      await this.prewarmStreamingCountdownPool();
    }
  }

  /**
   * The stream uses only two simultaneous countdown sprites, but every first
   * cycle rotates them through four canvas textures. Compile those exact pool
   * objects and upload every texture before renderer readiness can be exposed.
   */
  private async prewarmStreamingCountdownPool(): Promise<void> {
    this.initPool();
    const precompileObject = this.world.graphics?.precompileObject;
    if (!precompileObject) return;

    const activePoolSize = Math.min(2, this.splatPool.length);
    for (let poolIndex = 0; poolIndex < activePoolSize; poolIndex++) {
      const item = this.splatPool[poolIndex];
      for (const count of [3, 2, 1, 0]) {
        const texture = this.countTextures.get(count);
        if (!texture) continue;
        item.material.map = texture;
        item.material.needsUpdate = true;
        await precompileObject.call(this.world.graphics, item.sprite);
      }
    }
  }

  private initPool(): void {
    if (this.poolInitialized) return;

    // Pre-render one texture per count value — happens once, not per event
    for (const count of [0, 1, 2, 3]) {
      const size = 512;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d")!;
      this.renderCountdownToCanvas(context, size, count);
      // NOTE: Do not call texture.dispose() during active gameplay.
      // Pool textures are reclaimed by GC when cleared in destroy().
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      this.countTextures.set(count, texture);
    }

    // Pre-allocate sprite+material pairs
    for (let i = 0; i < this.POOL_SIZE; i++) {
      const material = new THREE.SpriteMaterial({
        transparent: true,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(this.SPLAT_SIZE, this.SPLAT_SIZE, 1);
      sprite.visible = false;
      this.splatPool.push({ material, sprite, active: false });
    }

    this.poolInitialized = true;
  }

  private renderCountdownToCanvas(
    context: CanvasRenderingContext2D,
    size: number,
    count: number,
  ): void {
    const displayText = count === 0 ? "FIGHT!" : count.toString();
    const color = COUNT_COLORS[count] || "#ffffff";

    context.clearRect(0, 0, size, size);
    context.textAlign = "center";
    context.textBaseline = "middle";

    // Outer glow
    context.shadowColor = color;
    context.shadowBlur = 30;
    context.fillStyle = color;
    context.font = count === 0 ? "bold 100px Arial" : "bold 180px Arial";
    context.fillText(displayText, size / 2, size / 2);

    // Inner glow layer
    context.shadowBlur = 15;
    context.fillText(displayText, size / 2, size / 2);

    // Solid text on top
    context.shadowBlur = 0;
    context.strokeStyle = "#000000";
    context.lineWidth = 8;
    context.strokeText(displayText, size / 2, size / 2);
    context.fillText(displayText, size / 2, size / 2);
  }

  private acquirePoolItem(): SplatPoolItem | null {
    if (!this.poolInitialized) {
      this.initPool();
    }
    for (const item of this.splatPool) {
      if (!item.active) {
        item.active = true;
        return item;
      }
    }
    return null; // Pool exhausted
  }

  private releasePoolItem(item: SplatPoolItem): void {
    item.active = false;
    item.sprite.visible = false;
    item.material.opacity = 1;
    if (item.sprite.parent) {
      item.sprite.parent.remove(item.sprite);
    }
  }

  private onCountdownTick = (data: unknown): void => {
    const payload = data as {
      duelId: string;
      count: number;
      challengerId: string;
      targetId: string;
    };

    const { count, challengerId, targetId } = payload;

    // Clear any existing splats from previous ticks
    this.clearAllSplats();

    // Create countdown splat over both players
    this.createCountdownSplat(challengerId, count);
    this.createCountdownSplat(targetId, count);
  };

  private createCountdownSplat(entityId: string, count: number): void {
    if (!this.world.stage?.scene) return;

    const entity =
      this.world.entities.get(entityId) ||
      this.world.entities.players?.get(entityId);
    if (!entity?.position) return;

    const poolItem = this.acquirePoolItem();
    if (!poolItem) return; // Pool exhausted — skip

    // Swap the shared pre-rendered texture for this count value
    const tex = this.countTextures.get(count);
    if (tex) {
      poolItem.material.map = tex;
      poolItem.material.needsUpdate = true;
    }

    poolItem.material.opacity = 1;
    poolItem.sprite.scale.set(this.SPLAT_SIZE, this.SPLAT_SIZE, 1);
    poolItem.sprite.position.set(
      entity.position.x,
      entity.position.y + this.HEIGHT_OFFSET,
      entity.position.z,
    );
    poolItem.sprite.visible = true;

    this.world.stage.scene.add(poolItem.sprite);

    this.activeSplats.push({
      poolItem,
      entityId,
      startTime: performance.now(),
      duration: this.SPLAT_DURATION,
      baseScale: this.SPLAT_SIZE,
    });
  }

  private clearAllSplats(): void {
    for (const splat of this.activeSplats) {
      this.releasePoolItem(splat.poolItem);
    }
    this.activeSplats = [];
  }

  update(_dt: number): void {
    if (!this.world.isClient) return;

    const now = performance.now();
    this._toRemove.length = 0;

    for (let i = 0; i < this.activeSplats.length; i++) {
      const splat = this.activeSplats[i];
      const elapsed = now - splat.startTime;
      const progress = Math.min(elapsed / splat.duration, 1);

      // Track entity position
      const entity =
        this.world.entities.get(splat.entityId) ||
        this.world.entities.players?.get(splat.entityId);
      if (entity?.position) {
        splat.poolItem.sprite.position.x = entity.position.x;
        splat.poolItem.sprite.position.y =
          entity.position.y + this.HEIGHT_OFFSET;
        splat.poolItem.sprite.position.z = entity.position.z;
      }

      // Punch animation: scale up quickly, then settle
      let scale: number;
      if (progress < 0.15) {
        const punchProgress = progress / 0.15;
        scale = splat.baseScale * (1 + 0.4 * punchProgress);
      } else if (progress < 0.3) {
        const settleProgress = (progress - 0.15) / 0.15;
        scale = splat.baseScale * (1.4 - 0.4 * settleProgress);
      } else {
        scale = splat.baseScale;
      }
      splat.poolItem.sprite.scale.set(scale, scale, 1);

      // Fade out in the last 30% of duration
      if (progress > 0.7) {
        const fadeProgress = (progress - 0.7) / 0.3;
        splat.poolItem.material.opacity = 1 - fadeProgress;
      }

      if (progress >= 1) {
        this.releasePoolItem(splat.poolItem);
        this._toRemove.push(i);
      }
    }

    // Remove completed splats (reverse order to maintain indices)
    for (let i = this._toRemove.length - 1; i >= 0; i--) {
      this.activeSplats.splice(this._toRemove[i], 1);
    }
  }

  destroy(): void {
    if (this.boundCountdownHandler) {
      this.world.off(EventType.DUEL_COUNTDOWN_TICK, this.boundCountdownHandler);
      this.boundCountdownHandler = null;
    }

    // Return all active splats to pool (removes from scene)
    this.clearAllSplats();

    // Clear pool references — GC reclaims textures without dispose()
    // to avoid WebGPU texture cache corruption with dual-renderer setup
    this.countTextures.clear();
    this.splatPool = [];
    this.poolInitialized = false;

    super.destroy();
  }
}
