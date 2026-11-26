/**
 * DamageSplatSystem - classic fantasy MMORPG-style Damage Splats
 *
 * Creates visual damage numbers (hit splats) that appear above entities when they take damage.
 * Mimics classic fantasy MMORPG's iconic damage feedback system.
 *
 * Features:
 * - Red splats for successful hits (damage > 0)
 * - Blue splats for misses (damage = 0)
 * - Floating animation (rises up and fades out)
 * - Positioned above the damaged entity
 *
 * Architecture:
 * - Listens to COMBAT_DAMAGE_DEALT events
 * - Creates THREE.Sprite for each damage number
 * - Animates with fadeout and upward movement
 * - Auto-removes after animation completes
 *
 */

import * as THREE from "../../extras/three/three";
import { System } from "../shared/infrastructure/System";
import { EventType } from "../../types/events";
import type { CombatDamageDealtPayload } from "../../types/events/event-payloads";
import type { World } from "../../core/World";
import type { WorldOptions } from "../../types/index";
import {
  getPlayerHitReactionIntensity,
  getPlayerHitReactionSide,
} from "../../utils/rendering/HitReaction";

interface DamageSplat {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  targetId: string | null;
  startTime: number;
  duration: number;
  startY: number;
  riseDistance: number;
  active: boolean;
}

type StreamingDamagePhase =
  "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";

interface StreamingDamageStateUpdate {
  cycle?: {
    phase?: StreamingDamagePhase;
    agent1?: { id?: string | null } | null;
    agent2?: { id?: string | null } | null;
  } | null;
}

/**
 * Pool size for damage splats.
 * Combat-heavy scenarios may have 20-30 simultaneous splats.
 */
const SPLAT_POOL_SIZE = 50;

interface HitReactionTarget {
  isPlayer?: boolean;
  avatar?: {
    triggerHitReaction?: (intensity?: number, side?: -1 | 1) => void;
    instance?: {
      getHitReactionDiagnostics?: () => { triggerCount?: unknown } | null;
    };
  };
}

export interface StreamingDamagePresentationEvent {
  sequence: number;
  projectileId: string | null;
  attackerId: string;
  targetId: string;
  attackType: string | null;
  targetType: "player" | "mob" | null;
  damage: number;
  isCritical: boolean;
  performanceTimeMs: number;
  hitReactionTriggered: boolean;
  hitReactionTriggerCount: number | null;
  damageSplatCreated: boolean;
}

export interface StreamingDamagePresentationDiagnostics {
  schemaVersion: 1;
  updatedAt: number;
  latestSequence: number;
  activeSplatCount: number;
  recentEvents: StreamingDamagePresentationEvent[];
}

export function triggerPlayerDamageReaction(
  target: HitReactionTarget | null | undefined,
  payload: CombatDamageDealtPayload,
): boolean {
  if (
    !target ||
    payload.damage <= 0 ||
    (payload.targetType !== undefined
      ? payload.targetType !== "player"
      : target.isPlayer !== true)
  ) {
    return false;
  }
  const avatar = target.avatar;
  if (!avatar?.triggerHitReaction) return false;
  const intensity = getPlayerHitReactionIntensity(
    payload.damage,
    payload.isCritical,
  );
  if (intensity <= 0) return false;
  avatar.triggerHitReaction(
    intensity,
    getPlayerHitReactionSide(payload.attackerId, payload.targetId),
  );
  return true;
}

export class DamageSplatSystem extends System {
  name = "damage-splat";

  // Object pool for damage splats - avoids GC pressure during combat
  private splatPool: DamageSplat[] = [];
  private activeSplats: DamageSplat[] = [];
  private poolInitialized = false;
  private damagePresentationSequence = 0;
  private streamingPhase: StreamingDamagePhase | null = null;
  private streamingAgent1Id: string | null = null;
  private streamingAgent2Id: string | null = null;
  private hasObservedStreamingState = false;
  private readonly recentDamagePresentationEvents: StreamingDamagePresentationEvent[] =
    [];
  private static readonly MAX_RECENT_DAMAGE_PRESENTATION_EVENTS = 128;

  private readonly SPLAT_DURATION = 1500; // 1.5 seconds
  private readonly RISE_DISTANCE = 1.5; // Units to float upward
  private readonly SPLAT_SIZE = 0.6; // Size of the splat sprite
  private readonly CANVAS_SIZE = 256;

  // Pre-allocated array for removal indices to avoid per-frame allocation
  private readonly _toRemove: number[] = [];

  // Bound handler reference for proper cleanup
  private boundDamageHandler: ((data: unknown) => void) | null = null;
  private boundStreamingStateHandler: ((data: unknown) => void) | null = null;

  constructor(world: World) {
    super(world);
  }

  getStreamingDamagePresentationDiagnostics(): StreamingDamagePresentationDiagnostics {
    return {
      schemaVersion: 1,
      updatedAt: Date.now(),
      latestSequence: this.damagePresentationSequence,
      activeSplatCount: this.activeSplats.length,
      recentEvents: this.recentDamagePresentationEvents.map((event) => ({
        ...event,
      })),
    };
  }

  /**
   * Initialize the splat pool lazily (only when first damage occurs).
   * This avoids upfront cost if no combat happens.
   */
  private initPool(): void {
    if (this.poolInitialized) return;

    for (let i = 0; i < SPLAT_POOL_SIZE; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = this.CANVAS_SIZE;
      canvas.height = this.CANVAS_SIZE;
      const context = canvas.getContext("2d")!;

      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(this.SPLAT_SIZE, this.SPLAT_SIZE, 1);
      sprite.visible = false;

      this.splatPool.push({
        sprite,
        material,
        texture,
        canvas,
        context,
        targetId: null,
        startTime: 0,
        duration: this.SPLAT_DURATION,
        startY: 0,
        riseDistance: this.RISE_DISTANCE,
        active: false,
      });
    }

    this.poolInitialized = true;
  }

  /**
   * Get a splat from the pool, or null if pool is exhausted.
   */
  private acquireSplat(): DamageSplat | null {
    this.initPool();

    // Find an inactive splat in the pool
    for (const splat of this.splatPool) {
      if (!splat.active) {
        splat.active = true;
        return splat;
      }
    }

    // Pool exhausted - this is fine, just skip the splat
    return null;
  }

  /**
   * Return a splat to the pool for reuse.
   */
  private releaseSplat(splat: DamageSplat): void {
    splat.active = false;
    splat.targetId = null;
    splat.sprite.visible = false;
    if (splat.sprite.parent) {
      splat.sprite.parent.remove(splat.sprite);
    }
  }

  async init(options?: WorldOptions): Promise<void> {
    // CRITICAL: Call super.init() to set initialized flag and prevent duplicate init calls
    await super.init(options as WorldOptions);

    // Only run on client
    if (!this.world.isClient) {
      return;
    }

    // Prevent duplicate subscriptions if init is called multiple times
    if (this.boundDamageHandler) {
      return;
    }

    // Create bound handler for proper cleanup in destroy()
    this.boundDamageHandler = this.onDamageDealt.bind(this);
    this.boundStreamingStateHandler = this.onStreamingStateUpdate.bind(this);

    // Listen for combat damage events
    this.world.on(EventType.COMBAT_DAMAGE_DEALT, this.boundDamageHandler, this);
    this.world.on(
      "streaming:state:update",
      this.boundStreamingStateHandler,
      this,
    );
  }

  private isStreamingContestantId(id: string | null | undefined): boolean {
    return Boolean(
      id && (id === this.streamingAgent1Id || id === this.streamingAgent2Id),
    );
  }

  private clearStreamingContestantSplats(
    nextAgent1Id: string | null,
    nextAgent2Id: string | null,
  ): void {
    for (let i = this.activeSplats.length - 1; i >= 0; i--) {
      const splat = this.activeSplats[i];
      const targetId = splat.targetId;
      if (
        !targetId ||
        (targetId !== this.streamingAgent1Id &&
          targetId !== this.streamingAgent2Id &&
          targetId !== nextAgent1Id &&
          targetId !== nextAgent2Id)
      ) {
        continue;
      }
      this.releaseSplat(splat);
      this.activeSplats.splice(i, 1);
    }
  }

  private onStreamingStateUpdate(data: unknown): void {
    const state = data as StreamingDamageStateUpdate;
    const nextPhase = state?.cycle?.phase;
    if (
      nextPhase !== "IDLE" &&
      nextPhase !== "ANNOUNCEMENT" &&
      nextPhase !== "COUNTDOWN" &&
      nextPhase !== "FIGHTING" &&
      nextPhase !== "RESOLUTION"
    ) {
      return;
    }

    const nextAgent1Id =
      typeof state.cycle?.agent1?.id === "string" && state.cycle.agent1.id
        ? state.cycle.agent1.id
        : null;
    const nextAgent2Id =
      typeof state.cycle?.agent2?.id === "string" && state.cycle.agent2.id
        ? state.cycle.agent2.id
        : null;

    if (
      (this.streamingPhase === "FIGHTING" && nextPhase !== "FIGHTING") ||
      nextPhase === "RESOLUTION"
    ) {
      this.clearStreamingContestantSplats(nextAgent1Id, nextAgent2Id);
    }

    this.streamingPhase = nextPhase;
    this.streamingAgent1Id = nextAgent1Id;
    this.streamingAgent2Id = nextAgent2Id;
    this.hasObservedStreamingState = true;
  }

  private shouldPresentDamage(payload: CombatDamageDealtPayload): boolean {
    if (!this.hasObservedStreamingState || this.streamingPhase === "FIGHTING") {
      return true;
    }
    return !(
      this.isStreamingContestantId(payload.attackerId) ||
      this.isStreamingContestantId(payload.targetId)
    );
  }

  private onDamageDealt = (data: unknown): void => {
    const payload = data as CombatDamageDealtPayload;

    const { damage, targetId, position } = payload;

    // Get target entity for position
    const target = this.world.entities.get(targetId) as
      | (HitReactionTarget & {
          position?: { x: number; y: number; z: number };
        })
      | undefined;
    const shouldPresentDamage = this.shouldPresentDamage(payload);
    const hitReactionTriggered = shouldPresentDamage
      ? triggerPlayerDamageReaction(
          target as HitReactionTarget | undefined,
          payload,
        )
      : false;
    const reactionDiagnostics =
      target?.avatar?.instance?.getHitReactionDiagnostics?.() ?? null;
    const reactionTriggerCount = reactionDiagnostics?.triggerCount;

    // Prefer the entity's visual position (updated by TileInterpolator) over
    // the server tile center so the splat stays attached to moving fighters.
    const targetPos = target?.position || position;
    const damageSplatCreated =
      shouldPresentDamage && targetPos
        ? this.createDamageSplat(damage, targetPos, targetId)
        : false;

    if (
      typeof payload.attackerId === "string" &&
      payload.attackerId.length > 0 &&
      typeof targetId === "string" &&
      targetId.length > 0 &&
      Number.isFinite(damage)
    ) {
      this.recentDamagePresentationEvents.push({
        sequence: ++this.damagePresentationSequence,
        projectileId:
          typeof payload.projectileId === "string" && payload.projectileId
            ? payload.projectileId
            : null,
        attackerId: payload.attackerId,
        targetId,
        attackType:
          typeof payload.attackType === "string" ? payload.attackType : null,
        targetType:
          payload.targetType === "player" || payload.targetType === "mob"
            ? payload.targetType
            : null,
        damage,
        isCritical: payload.isCritical === true,
        performanceTimeMs: performance.now(),
        hitReactionTriggered,
        hitReactionTriggerCount:
          Number.isSafeInteger(reactionTriggerCount) &&
          Number(reactionTriggerCount) >= 0
            ? Number(reactionTriggerCount)
            : null,
        damageSplatCreated,
      });
      if (
        this.recentDamagePresentationEvents.length >
        DamageSplatSystem.MAX_RECENT_DAMAGE_PRESENTATION_EVENTS
      ) {
        this.recentDamagePresentationEvents.shift();
      }
    }
  };

  private createDamageSplat(
    damage: number,
    position: { x: number; y: number; z: number },
    targetId: string,
  ): boolean {
    // Check if scene is available
    if (!this.world.stage?.scene) {
      return false;
    }

    // Acquire splat from pool (returns null if pool exhausted)
    const splat = this.acquireSplat();
    if (!splat) {
      return false; // Pool exhausted, skip this splat
    }

    const { context, texture, sprite, material } = splat;
    const size = this.CANVAS_SIZE;

    // Clear canvas and redraw
    context.clearRect(0, 0, size, size);

    // Draw classic MMORPG-style hit splat
    const isHit = damage > 0;
    const bgColor = isHit ? "#8B0000" : "#000080"; // Dark red or dark blue
    const textColor = "#FFFFFF";

    // Draw rounded rectangle background
    context.fillStyle = bgColor;
    this.roundRect(context, 20, 80, 216, 96, 15);
    context.fill();

    // Add border
    context.strokeStyle = "#000000";
    context.lineWidth = 4;
    this.roundRect(context, 20, 80, 216, 96, 15);
    context.stroke();

    // Draw damage number
    context.fillStyle = textColor;
    context.font = "bold 80px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(damage.toString(), size / 2, size / 2);

    // Update texture
    texture.needsUpdate = true;

    // Reset material opacity
    material.opacity = 1;

    // Position above the entity (add random offset to prevent overlapping)
    const offsetX = (Math.random() - 0.5) * 0.3;
    const offsetZ = (Math.random() - 0.5) * 0.3;
    sprite.position.set(
      position.x + offsetX,
      position.y + 1.5,
      position.z + offsetZ,
    );
    sprite.visible = true;

    // Add to scene
    this.world.stage.scene.add(sprite);

    // Configure splat animation state
    splat.targetId = targetId;
    splat.startTime = performance.now();
    splat.startY = sprite.position.y;

    // Track splat for animation
    this.activeSplats.push(splat);
    return true;
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  update(_dt: number): void {
    if (!this.world.isClient) return;

    const now = performance.now();
    // Reuse pre-allocated array to avoid per-frame allocation
    this._toRemove.length = 0;
    const toRemove = this._toRemove;

    // Animate all active splats
    for (let i = 0; i < this.activeSplats.length; i++) {
      const splat = this.activeSplats[i];
      const elapsed = now - splat.startTime;
      const progress = Math.min(elapsed / splat.duration, 1);

      // Float upward
      splat.sprite.position.y = splat.startY + progress * splat.riseDistance;

      // Fade out (material is guaranteed to be SpriteMaterial from pool)
      splat.material.opacity = 1 - progress;

      // Mark for removal when done
      if (progress >= 1) {
        // Return to pool instead of disposing
        this.releaseSplat(splat);
        toRemove.push(i);
      }
    }

    // Remove completed splats (reverse order to maintain indices)
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.activeSplats.splice(toRemove[i], 1);
    }
  }

  destroy(): void {
    // Remove event listener to prevent duplicate subscriptions on re-init
    if (this.boundDamageHandler) {
      this.world.off(EventType.COMBAT_DAMAGE_DEALT, this.boundDamageHandler);
      this.boundDamageHandler = null;
    }
    if (this.boundStreamingStateHandler) {
      this.world.off("streaming:state:update", this.boundStreamingStateHandler);
      this.boundStreamingStateHandler = null;
    }

    // Release all active splats back to pool
    for (const splat of this.activeSplats) {
      this.releaseSplat(splat);
    }
    this.activeSplats = [];

    // Dispose pool resources on destroy
    for (const splat of this.splatPool) {
      if (splat.sprite.parent) {
        splat.sprite.parent.remove(splat.sprite);
      }
      splat.texture.dispose();
      splat.material.dispose();
    }
    this.splatPool = [];
    this.poolInitialized = false;
    this.streamingPhase = null;
    this.streamingAgent1Id = null;
    this.streamingAgent2Id = null;
    this.hasObservedStreamingState = false;

    // Call parent destroy to reset initialized flag
    super.destroy();
  }
}
