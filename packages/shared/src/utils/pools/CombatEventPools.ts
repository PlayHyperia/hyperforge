/**
 * CombatEventPools - Pre-configured pools for high-frequency combat events
 *
 * Combat events fire constantly during gameplay (every 600ms tick per combatant).
 * Pooling these payloads eliminates GC pressure from object allocation.
 *
 * IMPORTANT: Event listeners MUST call release() after processing the event.
 * Failure to release causes pool exhaustion and memory leaks.
 *
 * Usage:
 *   // In emitter (CombatSystem, etc.)
 *   const payload = CombatEventPools.damageDealt.acquire();
 *   payload.attackerId = attacker.id;
 *   payload.targetId = target.id;
 *   payload.damage = 15;
 *   this.emitTypedEvent(EventType.COMBAT_DAMAGE_DEALT, payload);
 *
 *   // In listener
 *   world.on(EventType.COMBAT_DAMAGE_DEALT, (payload) => {
 *     // Process damage...
 *     CombatEventPools.damageDealt.release(payload);
 *   });
 */

import {
  createEventPayloadPool,
  eventPayloadPoolRegistry,
  type EventPayloadPool,
  type PooledPayload,
} from "./EventPayloadPool";

// ============================================================================
// POOLED PAYLOAD TYPES
// ============================================================================

export interface PooledCombatDamageDealtPayload extends PooledPayload {
  attackerId: string;
  targetId: string;
  damage: number;
  attackType: string;
  targetType: string;
  positionX: number;
  positionY: number;
  positionZ: number;
  hasPosition: boolean;
  isCritical: boolean;
}

export interface PooledCombatProjectileLaunchedPayload extends PooledPayload {
  projectileId: string;
  attackerId: string;
  targetId: string;
  projectileType: string;
  sourceX: number;
  sourceY: number;
  sourceZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  spellId: string;
  arrowId: string;
  delayMs: number;
  flightTimeMs: number;
}

export interface PooledCombatFaceTargetPayload extends PooledPayload {
  playerId: string;
  targetId: string;
}

export interface PooledCombatClearFaceTargetPayload extends PooledPayload {
  playerId: string;
}

export interface PooledCombatAttackFailedPayload extends PooledPayload {
  attackerId: string;
  targetId: string;
  reason: string;
}

export interface PooledCombatFollowTargetPayload extends PooledPayload {
  playerId: string;
  targetId: string;
  targetX: number;
  targetY: number;
  targetZ: number;
  attackRange: number;
  attackType: string;
}

export interface PooledCombatStartedPayload extends PooledPayload {
  attackerId: string;
  targetId: string;
}

export interface PooledCombatEndedPayload extends PooledPayload {
  attackerId: string;
  targetId: string;
}

export interface PooledCombatProjectileHitPayload extends PooledPayload {
  projectileId: string;
  attackerId: string;
  targetId: string;
  damage: number;
  projectileType: string;
}

export interface PooledCombatKillPayload extends PooledPayload {
  attackerId: string;
  targetId: string;
  damageDealt: number;
  attackStyle: string;
}

// ============================================================================
// POOL INSTANCES
// ============================================================================

/**
 * Pool for COMBAT_DAMAGE_DEALT events
 * Fires every successful attack (every tick during active combat)
 */
const damageDealtPool: EventPayloadPool<PooledCombatDamageDealtPayload> =
  createEventPayloadPool({
    name: "CombatDamageDealt",
    factory: () => ({
      attackerId: "",
      targetId: "",
      damage: 0,
      attackType: "melee",
      targetType: "mob",
      positionX: 0,
      positionY: 0,
      positionZ: 0,
      hasPosition: false,
      isCritical: false,
    }),
    reset: (p) => {
      p.attackerId = "";
      p.targetId = "";
      p.damage = 0;
      p.attackType = "melee";
      p.targetType = "mob";
      p.positionX = 0;
      p.positionY = 0;
      p.positionZ = 0;
      p.hasPosition = false;
      p.isCritical = false;
    },
    initialSize: 64,
    growthSize: 32,
  });

/**
 * Pool for COMBAT_PROJECTILE_LAUNCHED events
 * Fires for ranged/magic attacks
 */
const projectileLaunchedPool: EventPayloadPool<PooledCombatProjectileLaunchedPayload> =
  createEventPayloadPool({
    name: "CombatProjectileLaunched",
    factory: () => ({
      projectileId: "",
      attackerId: "",
      targetId: "",
      projectileType: "",
      sourceX: 0,
      sourceY: 0,
      sourceZ: 0,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      spellId: "",
      arrowId: "",
      delayMs: 0,
      flightTimeMs: 0,
    }),
    reset: (p) => {
      p.projectileId = "";
      p.attackerId = "";
      p.targetId = "";
      p.projectileType = "";
      p.sourceX = 0;
      p.sourceY = 0;
      p.sourceZ = 0;
      p.targetX = 0;
      p.targetY = 0;
      p.targetZ = 0;
      p.spellId = "";
      p.arrowId = "";
      p.delayMs = 0;
      p.flightTimeMs = 0;
    },
    initialSize: 32,
    growthSize: 16,
  });

/**
 * Pool for COMBAT_FACE_TARGET events
 * Fires when entity faces a target during combat
 */
const faceTargetPool: EventPayloadPool<PooledCombatFaceTargetPayload> =
  createEventPayloadPool({
    name: "CombatFaceTarget",
    factory: () => ({
      playerId: "",
      targetId: "",
    }),
    reset: (p) => {
      p.playerId = "";
      p.targetId = "";
    },
    initialSize: 64,
    growthSize: 32,
  });

/**
 * Pool for COMBAT_CLEAR_FACE_TARGET events
 * Fires when entity stops facing target
 */
const clearFaceTargetPool: EventPayloadPool<PooledCombatClearFaceTargetPayload> =
  createEventPayloadPool({
    name: "CombatClearFaceTarget",
    factory: () => ({
      playerId: "",
    }),
    reset: (p) => {
      p.playerId = "";
    },
    initialSize: 64,
    growthSize: 32,
  });

/**
 * Pool for COMBAT_ATTACK_FAILED events
 * Fires when attack is blocked or fails
 */
const attackFailedPool: EventPayloadPool<PooledCombatAttackFailedPayload> =
  createEventPayloadPool({
    name: "CombatAttackFailed",
    factory: () => ({
      attackerId: "",
      targetId: "",
      reason: "",
    }),
    reset: (p) => {
      p.attackerId = "";
      p.targetId = "";
      p.reason = "";
    },
    initialSize: 32,
    growthSize: 16,
  });

/**
 * Pool for COMBAT_FOLLOW_TARGET events
 * Fires when entity needs to move toward target
 */
const followTargetPool: EventPayloadPool<PooledCombatFollowTargetPayload> =
  createEventPayloadPool({
    name: "CombatFollowTarget",
    factory: () => ({
      playerId: "",
      targetId: "",
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      attackRange: 1,
      attackType: "melee",
    }),
    reset: (p) => {
      p.playerId = "";
      p.targetId = "";
      p.targetX = 0;
      p.targetY = 0;
      p.targetZ = 0;
      p.attackRange = 1;
      p.attackType = "melee";
    },
    initialSize: 32,
    growthSize: 16,
  });

/**
 * Pool for COMBAT_STARTED events
 * Fires when combat session begins
 */
const combatStartedPool: EventPayloadPool<PooledCombatStartedPayload> =
  createEventPayloadPool({
    name: "CombatStarted",
    factory: () => ({
      attackerId: "",
      targetId: "",
    }),
    reset: (p) => {
      p.attackerId = "";
      p.targetId = "";
    },
    initialSize: 32,
    growthSize: 16,
  });

/**
 * Pool for COMBAT_ENDED events
 * Fires when combat session ends
 */
const combatEndedPool: EventPayloadPool<PooledCombatEndedPayload> =
  createEventPayloadPool({
    name: "CombatEnded",
    factory: () => ({
      attackerId: "",
      targetId: "",
    }),
    reset: (p) => {
      p.attackerId = "";
      p.targetId = "";
    },
    initialSize: 32,
    growthSize: 16,
  });

/**
 * Pool for COMBAT_PROJECTILE_HIT events
 * Fires when projectile hits target
 */
const projectileHitPool: EventPayloadPool<PooledCombatProjectileHitPayload> =
  createEventPayloadPool({
    name: "CombatProjectileHit",
    factory: () => ({
      projectileId: "",
      attackerId: "",
      targetId: "",
      damage: 0,
      projectileType: "",
    }),
    reset: (p) => {
      p.projectileId = "";
      p.attackerId = "";
      p.targetId = "";
      p.damage = 0;
      p.projectileType = "";
    },
    initialSize: 32,
    growthSize: 16,
  });

/**
 * Pool for COMBAT_KILL events
 * Fires when entity dies in combat
 */
const combatKillPool: EventPayloadPool<PooledCombatKillPayload> =
  createEventPayloadPool({
    name: "CombatKill",
    factory: () => ({
      attackerId: "",
      targetId: "",
      damageDealt: 0,
      attackStyle: "",
    }),
    reset: (p) => {
      p.attackerId = "";
      p.targetId = "";
      p.damageDealt = 0;
      p.attackStyle = "";
    },
    initialSize: 16,
    growthSize: 8,
  });

// Register all pools for monitoring
eventPayloadPoolRegistry.register(damageDealtPool);
eventPayloadPoolRegistry.register(projectileLaunchedPool);
eventPayloadPoolRegistry.register(faceTargetPool);
eventPayloadPoolRegistry.register(clearFaceTargetPool);
eventPayloadPoolRegistry.register(attackFailedPool);
eventPayloadPoolRegistry.register(followTargetPool);
eventPayloadPoolRegistry.register(combatStartedPool);
eventPayloadPoolRegistry.register(combatEndedPool);
eventPayloadPoolRegistry.register(projectileHitPool);
eventPayloadPoolRegistry.register(combatKillPool);

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Combat Event Pools - Use these for zero-allocation event emission
 *
 * Remember: Listeners MUST call release() after processing!
 */
export const CombatEventPools = {
  damageDealt: damageDealtPool,
  projectileLaunched: projectileLaunchedPool,
  faceTarget: faceTargetPool,
  clearFaceTarget: clearFaceTargetPool,
  attackFailed: attackFailedPool,
  followTarget: followTargetPool,
  combatStarted: combatStartedPool,
  combatEnded: combatEndedPool,
  projectileHit: projectileHitPool,
  combatKill: combatKillPool,

  /**
   * Get all pool statistics
   */
  getAllStats() {
    return {
      damageDealt: damageDealtPool.getStats(),
      projectileLaunched: projectileLaunchedPool.getStats(),
      faceTarget: faceTargetPool.getStats(),
      clearFaceTarget: clearFaceTargetPool.getStats(),
      attackFailed: attackFailedPool.getStats(),
      followTarget: followTargetPool.getStats(),
      combatStarted: combatStartedPool.getStats(),
      combatEnded: combatEndedPool.getStats(),
      projectileHit: projectileHitPool.getStats(),
      combatKill: combatKillPool.getStats(),
    };
  },

  /**
   * Check all pools for unreleased payloads (call at end of tick)
   */
  checkAllLeaks(): number {
    let totalLeaks = 0;
    totalLeaks += damageDealtPool.checkLeaks();
    totalLeaks += projectileLaunchedPool.checkLeaks();
    totalLeaks += faceTargetPool.checkLeaks();
    totalLeaks += clearFaceTargetPool.checkLeaks();
    totalLeaks += attackFailedPool.checkLeaks();
    totalLeaks += followTargetPool.checkLeaks();
    totalLeaks += combatStartedPool.checkLeaks();
    totalLeaks += combatEndedPool.checkLeaks();
    totalLeaks += projectileHitPool.checkLeaks();
    totalLeaks += combatKillPool.checkLeaks();
    return totalLeaks;
  },

  /**
   * Reset all pools to initial state
   */
  resetAll(): void {
    damageDealtPool.reset();
    projectileLaunchedPool.reset();
    faceTargetPool.reset();
    clearFaceTargetPool.reset();
    attackFailedPool.reset();
    followTargetPool.reset();
    combatStartedPool.reset();
    combatEndedPool.reset();
    projectileHitPool.reset();
    combatKillPool.reset();
  },
};
