/**
 * ProjectileService - Manages projectile creation and hit timing
 *
 * Builds on HitDelayCalculator to provide a service layer for
 * tracking active projectiles and processing hits on the correct tick.
 *
 * Responsibilities:
 * - Create projectiles with pre-calculated hit timing
 * - Track active projectiles per target
 * - Process projectile hits on correct game tick
 * - Cancel projectiles when target dies/escapes
 */

import { AttackType } from "../../../types/game/item-types";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import {
  createProjectile as createProjectileData,
  calculateTileDistance,
  type ProjectileData,
  type HitDelayAttackType,
} from "../../../utils/game/HitDelayCalculator";
import { uuid } from "../../../utils/IdGenerator";
import type {
  AmmunitionShotSettlementHandle,
  GroundItemSourceRegistrationReceipt,
  ProjectileRuneCostSettlementHandle,
} from "../../../types/network/database";

/**
 * Extended projectile data with additional combat context
 */
export interface CombatProjectile extends ProjectileData {
  /** Spell ID for magic attacks */
  spellId?: string;
  /** Arrow ID for ranged attacks */
  arrowId?: string;
  /** XP to award on hit */
  xpReward?: number;
  /** Whether this projectile has been cancelled */
  cancelled: boolean;
  /** Durable recovered-arrow source committed with the player ammunition debit. */
  ammunitionRecovery?: GroundItemSourceRegistrationReceipt;
  /** Durable staged debit settled by launch admission or pre-launch cancel. */
  ammunitionCustody?: AmmunitionShotSettlementHandle;
  /** Durable staged rune debit settled by launch admission or cancellation. */
  runeCustody?: ProjectileRuneCostSettlementHandle;
}

/**
 * Parameters for creating a projectile
 */
export interface CreateProjectileParams {
  sourceId: string;
  targetId: string;
  attackType: AttackType;
  damage: number;
  currentTick: number;
  sourcePosition: { x: number; z: number };
  targetPosition: { x: number; z: number };
  spellId?: string;
  arrowId?: string;
  ammunitionRecovery?: GroundItemSourceRegistrationReceipt;
  ammunitionCustody?: AmmunitionShotSettlementHandle;
  runeCustody?: ProjectileRuneCostSettlementHandle;
  xpReward?: number;
}

/**
 * Opaque synchronous capacity lease. Cost-bearing attacks acquire one before
 * awaiting persistence, then consume the exact lease when the projectile is
 * admitted. This closes the capacity race without exposing mutable internals.
 */
export interface ProjectileReservation {
  readonly id: string;
}

interface StoredProjectileReservation {
  sourceId: string;
  sourcePosition: { x: number; z: number };
  targetPosition: { x: number; z: number };
}

/**
 * Projectiles that hit on a given tick
 */
export interface ProcessTickResult {
  /** Projectiles that hit this tick */
  hits: CombatProjectile[];
  /** Projectiles purged after exceeding the authoritative lifetime. */
  expired: CombatProjectile[];
  /** Remaining active projectiles */
  remaining: number;
}

export type ProjectileCancellationObserver = (
  projectile: Readonly<CombatProjectile>,
) => void;

export type ProjectileLifecycleKind =
  "launched" | "hit" | "cancelled" | "expired";

export interface ProjectileLifecycleDiagnosticEvent {
  sequence: number;
  kind: ProjectileLifecycleKind;
  projectileId: string;
  attackerId: string;
  targetId: string;
  firedAtTick: number;
  hitsAtTick: number;
  observedAtTick: number | null;
}

export interface ProjectileLifecycleDiagnostics {
  active: number;
  launched: number;
  hit: number;
  cancelled: number;
  expired: number;
  latestSequence: number;
  recent: ProjectileLifecycleDiagnosticEvent[];
}

/** Maximum active projectiles per attacker to prevent abuse */
const MAX_ACTIVE_PROJECTILES_PER_PLAYER = 10;
const MAX_RECENT_PROJECTILE_LIFECYCLE_EVENTS = 256;

/**
 * ProjectileService class for managing combat projectiles
 */
export class ProjectileService {
  /** Active projectiles by projectile ID */
  private activeProjectiles: Map<string, CombatProjectile> = new Map();

  /** Projectiles by target ID for quick cancellation */
  private projectilesByTarget: Map<string, Set<string>> = new Map();

  /** Capacity held by cost-bearing attacks while their debit is in flight. */
  private projectileReservations = new Map<
    string,
    StoredProjectileReservation
  >();

  /** Pre-allocated arrays for processTick (zero-allocation hot path) */
  private readonly _tickHits: CombatProjectile[] = [];
  private readonly _tickExpired: CombatProjectile[] = [];
  private readonly _tickToRemove: string[] = [];

  /** Bounded source-of-truth telemetry for launch/terminal reconciliation. */
  private readonly recentLifecycleEvents: ProjectileLifecycleDiagnosticEvent[] =
    [];
  private recentLifecycleCursor = 0;
  private lifecycleSequence = 0;
  private launchedCount = 0;
  private hitCount = 0;
  private cancelledCount = 0;
  private expiredCount = 0;

  /**
   * Validate the synchronous capacity/position conditions used by
   * createProjectile. Callers that must durably consume ammunition first can
   * fail closed before committing that cost.
   */
  canCreateProjectile(
    sourceId: string,
    sourcePosition: { x: number; z: number },
    targetPosition: { x: number; z: number },
  ): boolean {
    return (
      Number.isFinite(sourcePosition.x) &&
      Number.isFinite(sourcePosition.z) &&
      Number.isFinite(targetPosition.x) &&
      Number.isFinite(targetPosition.z) &&
      this.getCommittedCapacityForAttacker(sourceId) <
        MAX_ACTIVE_PROJECTILES_PER_PLAYER
    );
  }

  /**
   * Hold one exact projectile slot before an asynchronous custody transition.
   * The returned identity is single-use and bound to the validated geometry.
   */
  reserveProjectile(
    sourceId: string,
    sourcePosition: { x: number; z: number },
    targetPosition: { x: number; z: number },
  ): ProjectileReservation | null {
    if (!this.canCreateProjectile(sourceId, sourcePosition, targetPosition)) {
      return null;
    }
    const id = `projectile-reservation:${uuid()}${uuid()}`;
    this.projectileReservations.set(id, {
      sourceId,
      sourcePosition: { ...sourcePosition },
      targetPosition: { ...targetPosition },
    });
    return Object.freeze({ id });
  }

  /** Release an unused lease. Replays are harmless and return false. */
  releaseProjectileReservation(reservation: ProjectileReservation): boolean {
    return this.projectileReservations.delete(reservation.id);
  }

  /**
   * Consume a matching lease and create its projectile without a second
   * capacity check. No unrelated launch can steal the already-held slot.
   */
  createReservedProjectile(
    reservation: ProjectileReservation,
    params: CreateProjectileParams,
  ): CombatProjectile | null {
    const stored = this.projectileReservations.get(reservation.id);
    if (
      !stored ||
      stored.sourceId !== params.sourceId ||
      stored.sourcePosition.x !== params.sourcePosition.x ||
      stored.sourcePosition.z !== params.sourcePosition.z ||
      stored.targetPosition.x !== params.targetPosition.x ||
      stored.targetPosition.z !== params.targetPosition.z
    ) {
      return null;
    }
    this.projectileReservations.delete(reservation.id);
    return this.createProjectileUnchecked(params);
  }

  /**
   * Create a new projectile
   *
   * @param params - Projectile creation parameters
   * @returns The created projectile, or null if attacker exceeds active projectile limit
   */
  createProjectile(params: CreateProjectileParams): CombatProjectile | null {
    if (
      !this.canCreateProjectile(
        params.sourceId,
        params.sourcePosition,
        params.targetPosition,
      )
    ) {
      return null;
    }
    return this.createProjectileUnchecked(params);
  }

  private createProjectileUnchecked(
    params: CreateProjectileParams,
  ): CombatProjectile {
    const {
      sourceId,
      targetId,
      attackType,
      damage,
      currentTick,
      sourcePosition,
      targetPosition,
      spellId,
      arrowId,
      ammunitionRecovery,
      ammunitionCustody,
      runeCustody,
      xpReward,
    } = params;

    // Calculate distance
    const distance = calculateTileDistance(sourcePosition, targetPosition);

    // Convert AttackType to HitDelayAttackType
    const hitDelayType = this.attackTypeToHitDelayType(attackType);

    // Create base projectile data using HitDelayCalculator
    const baseProjectile = createProjectileData(
      sourceId,
      targetId,
      hitDelayType,
      distance,
      damage,
      currentTick,
    );

    // Tick-derived identities can collide when two independently triggered
    // attack paths commit on the same tick. A collision overwrites one queued
    // hit while both launch packets may already be visible to clients. Keep
    // timing in explicit fields and use a compact collision-resistant identity
    // exclusively for lifecycle correlation.
    baseProjectile.id = `projectile:${uuid()}${uuid()}`;

    // Extend with combat context
    const projectile: CombatProjectile = {
      ...baseProjectile,
      spellId,
      arrowId,
      ammunitionRecovery,
      ammunitionCustody,
      runeCustody,
      xpReward,
      cancelled: false,
    };

    // Store in active projectiles
    this.activeProjectiles.set(projectile.id, projectile);

    // Track by target
    let targetProjectiles = this.projectilesByTarget.get(targetId);
    if (!targetProjectiles) {
      targetProjectiles = new Set();
      this.projectilesByTarget.set(targetId, targetProjectiles);
    }
    targetProjectiles.add(projectile.id);

    this.launchedCount++;
    this.recordLifecycle("launched", projectile, currentTick);

    return projectile;
  }

  /**
   * Process a game tick and return projectiles that should hit
   *
   * @param currentTick - Current game tick
   * @returns Projectiles that hit this tick
   */
  processTick(currentTick: number): ProcessTickResult {
    // Reuse pre-allocated arrays (zero GC per tick)
    this._tickHits.length = 0;
    this._tickExpired.length = 0;
    this._tickToRemove.length = 0;

    for (const [id, projectile] of this.activeProjectiles) {
      // Skip cancelled projectiles
      if (projectile.cancelled) {
        this._tickToRemove.push(id);
        continue;
      }

      // Purge stale projectiles that exceeded their max lifetime
      if (
        currentTick - projectile.firedAtTick >
        COMBAT_CONSTANTS.PROJECTILE_MAX_LIFETIME_TICKS
      ) {
        projectile.cancelled = true;
        this.expiredCount++;
        this.recordLifecycle("expired", projectile, currentTick);
        this._tickExpired.push(projectile);
        this._tickToRemove.push(id);
        continue;
      }

      // Check if projectile should hit this tick
      if (currentTick >= projectile.hitsAtTick && !projectile.processed) {
        projectile.processed = true;
        this.hitCount++;
        this.recordLifecycle("hit", projectile, currentTick);
        this._tickHits.push(projectile);
        this._tickToRemove.push(id);
      }
    }

    for (const id of this._tickToRemove) {
      this.removeProjectile(id);
    }

    return {
      hits: this._tickHits,
      expired: this._tickExpired,
      remaining: this.activeProjectiles.size,
    };
  }

  /**
   * Cancel all projectiles targeting a specific entity
   * Used when target dies or escapes combat
   *
   * @param targetId - Target entity ID
   * @returns Number of projectiles cancelled
   */
  cancelProjectilesForTarget(
    targetId: string,
    onCancelled?: ProjectileCancellationObserver,
  ): number {
    const targetProjectiles = this.projectilesByTarget.get(targetId);
    if (!targetProjectiles) {
      return 0;
    }

    let cancelled = 0;
    for (const projectileId of targetProjectiles) {
      const projectile = this.activeProjectiles.get(projectileId);
      if (projectile && !projectile.processed) {
        projectile.cancelled = true;
        this.cancelledCount++;
        this.recordLifecycle("cancelled", projectile, null);
        onCancelled?.(projectile);
        // Remove from activeProjectiles immediately
        this.activeProjectiles.delete(projectileId);
        cancelled++;
      }
    }

    // Remove the target's Set
    this.projectilesByTarget.delete(targetId);

    return cancelled;
  }

  /** Cancel one exact projectile, preserving the same observer ordering. */
  cancelProjectile(
    projectileId: string,
    onCancelled?: ProjectileCancellationObserver,
  ): boolean {
    const projectile = this.activeProjectiles.get(projectileId);
    if (!projectile || projectile.processed || projectile.cancelled) {
      return false;
    }
    projectile.cancelled = true;
    this.cancelledCount++;
    this.recordLifecycle("cancelled", projectile, null);
    onCancelled?.(projectile);
    this.removeProjectile(projectileId);
    return true;
  }

  /**
   * Cancel all projectiles from a specific attacker
   * Used when attacker dies or is stunned
   *
   * @param attackerId - Attacker entity ID
   * @returns Number of projectiles cancelled
   */
  cancelProjectilesFromAttacker(
    attackerId: string,
    onCancelled?: ProjectileCancellationObserver,
  ): number {
    // Collect IDs first to avoid modifying Map during iteration
    const toRemove: string[] = [];

    for (const projectile of this.activeProjectiles.values()) {
      if (projectile.attackerId === attackerId && !projectile.processed) {
        projectile.cancelled = true;
        this.cancelledCount++;
        this.recordLifecycle("cancelled", projectile, null);
        onCancelled?.(projectile);
        toRemove.push(projectile.id);
      }
    }

    // Remove immediately instead of waiting for next processTick
    for (const id of toRemove) {
      this.removeProjectile(id);
    }

    return toRemove.length;
  }

  /**
   * Cancel every in-flight projectile exchanged by one combat pair.
   *
   * Pair-scoped cancellation is intentionally narrower than cancelling every
   * projectile involving either entity: ending one fight must not discard a
   * third party's valid projectile in multi-combat areas.
   */
  cancelProjectilesBetween(
    entityAId: string,
    entityBId: string,
    onCancelled?: ProjectileCancellationObserver,
  ): number {
    const toRemove: string[] = [];

    for (const projectile of this.activeProjectiles.values()) {
      const belongsToPair =
        (projectile.attackerId === entityAId &&
          projectile.targetId === entityBId) ||
        (projectile.attackerId === entityBId &&
          projectile.targetId === entityAId);
      if (belongsToPair && !projectile.processed) {
        projectile.cancelled = true;
        this.cancelledCount++;
        this.recordLifecycle("cancelled", projectile, null);
        onCancelled?.(projectile);
        toRemove.push(projectile.id);
      }
    }

    for (const id of toRemove) {
      this.removeProjectile(id);
    }

    return toRemove.length;
  }

  /**
   * Get all active projectiles for a target
   */
  getProjectilesForTarget(targetId: string): CombatProjectile[] {
    const targetProjectiles = this.projectilesByTarget.get(targetId);
    if (!targetProjectiles) {
      return [];
    }

    const projectiles: CombatProjectile[] = [];
    for (const id of targetProjectiles) {
      const projectile = this.activeProjectiles.get(id);
      if (projectile && !projectile.cancelled && !projectile.processed) {
        projectiles.push(projectile);
      }
    }

    return projectiles;
  }

  /**
   * Get a specific projectile by ID
   */
  getProjectile(projectileId: string): CombatProjectile | undefined {
    return this.activeProjectiles.get(projectileId);
  }

  /**
   * Get total active projectile count
   */
  getActiveCount(): number {
    return this.activeProjectiles.size;
  }

  /**
   * Get active projectile count for a specific attacker
   */
  getActiveCountForAttacker(attackerId: string): number {
    let count = 0;
    for (const projectile of this.activeProjectiles.values()) {
      if (projectile.attackerId === attackerId && !projectile.cancelled) {
        count++;
      }
    }
    return count;
  }

  private getCommittedCapacityForAttacker(attackerId: string): number {
    let count = this.getActiveCountForAttacker(attackerId);
    for (const reservation of this.projectileReservations.values()) {
      if (reservation.sourceId === attackerId) count++;
    }
    return count;
  }

  /** Return a copy so diagnostics cannot mutate the authoritative ring. */
  getLifecycleDiagnostics(): ProjectileLifecycleDiagnostics {
    const recent =
      this.recentLifecycleEvents.length < MAX_RECENT_PROJECTILE_LIFECYCLE_EVENTS
        ? this.recentLifecycleEvents.slice()
        : this.recentLifecycleEvents
            .slice(this.recentLifecycleCursor)
            .concat(
              this.recentLifecycleEvents.slice(0, this.recentLifecycleCursor),
            );
    return {
      active: this.activeProjectiles.size,
      launched: this.launchedCount,
      hit: this.hitCount,
      cancelled: this.cancelledCount,
      expired: this.expiredCount,
      latestSequence: this.lifecycleSequence,
      recent: recent.map((event) => ({ ...event })),
    };
  }

  /**
   * Whether one unresolved projectile is travelling in either direction for
   * the exact combat pair. A frozen duel loadout switch uses this boundary to
   * finish the already-committed attack before it tears down and recreates
   * combat with a different weapon profile.
   */
  hasActiveProjectilesBetween(entityAId: string, entityBId: string): boolean {
    if (!entityAId || !entityBId || entityAId === entityBId) return false;
    for (const projectile of this.activeProjectiles.values()) {
      if (projectile.cancelled || projectile.processed) continue;
      if (
        (projectile.attackerId === entityAId &&
          projectile.targetId === entityBId) ||
        (projectile.attackerId === entityBId &&
          projectile.targetId === entityAId)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clear all projectiles (for cleanup)
   */
  clear(): void {
    this.activeProjectiles.clear();
    this.projectilesByTarget.clear();
    this.projectileReservations.clear();
  }

  /**
   * Remove a projectile from tracking
   */
  private removeProjectile(projectileId: string): void {
    const projectile = this.activeProjectiles.get(projectileId);
    if (projectile) {
      // Remove from target tracking
      const targetProjectiles = this.projectilesByTarget.get(
        projectile.targetId,
      );
      if (targetProjectiles) {
        targetProjectiles.delete(projectileId);
        if (targetProjectiles.size === 0) {
          this.projectilesByTarget.delete(projectile.targetId);
        }
      }

      // Remove from active
      this.activeProjectiles.delete(projectileId);
    }
  }

  private recordLifecycle(
    kind: ProjectileLifecycleKind,
    projectile: Readonly<CombatProjectile>,
    observedAtTick: number | null,
  ): void {
    const event: ProjectileLifecycleDiagnosticEvent = {
      sequence: ++this.lifecycleSequence,
      kind,
      projectileId: projectile.id,
      attackerId: projectile.attackerId,
      targetId: projectile.targetId,
      firedAtTick: projectile.firedAtTick,
      hitsAtTick: projectile.hitsAtTick,
      observedAtTick,
    };
    if (
      this.recentLifecycleEvents.length < MAX_RECENT_PROJECTILE_LIFECYCLE_EVENTS
    ) {
      this.recentLifecycleEvents.push(event);
      return;
    }
    this.recentLifecycleEvents[this.recentLifecycleCursor] = event;
    this.recentLifecycleCursor =
      (this.recentLifecycleCursor + 1) % MAX_RECENT_PROJECTILE_LIFECYCLE_EVENTS;
  }

  /**
   * Convert AttackType enum to HitDelayAttackType
   */
  private attackTypeToHitDelayType(attackType: AttackType): HitDelayAttackType {
    switch (attackType) {
      case AttackType.RANGED:
        return "ranged";
      case AttackType.MAGIC:
        return "magic";
      case AttackType.MELEE:
      default:
        return "melee";
    }
  }
}

// Export singleton instance
export const projectileService = new ProjectileService();
