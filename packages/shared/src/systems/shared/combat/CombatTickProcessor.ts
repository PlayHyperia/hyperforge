/**
 * CombatTickProcessor - Extracts per-tick combat processing from CombatSystem.
 *
 * Handles:
 * - Auto-attack execution on eligible ticks
 * - Range checking and combat follow
 * - Projectile hit resolution
 * - Player retaliation scheduling
 *
 * Uses the CombatTickContext interface to access CombatSystem state without
 * direct coupling, following the proven CombatAttackContext pattern.
 */

import { EventType } from "../../../types/events";
import { AttackType } from "../../../types/core/core";
import type { EntityID } from "../../../types/core/identifiers";
import type { Entity } from "../../../entities/Entity";
import type { MobEntity } from "../../../entities/npc/MobEntity";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import type { CombatStyle } from "../../../utils/game/CombatCalculations";
import { calculateRetaliationDelay } from "../../../utils/game/CombatCalculations";
import { createEntityID } from "../../../utils/IdentifierUtils";
import { getEntityPosition } from "../../../utils/game/EntityPositionUtils";
import { tilePool } from "../../../utils/pools/TilePool";
import {
  tilesWithinMeleeRange,
  tilesWithinRange,
  worldToTile,
} from "../movement/TileSystem";
import { isMobEntity } from "../../../utils/typeGuards";
import { GameEventType } from "../EventStore";
import type { CombatData } from "./CombatStateService";
import type { CombatAttackContext } from "./handlers/AttackContext";
import type { CombatAnimationManager } from "./CombatAnimationManager";
import type { CombatRotationManager } from "./CombatRotationManager";
import type { CombatStateService } from "./CombatStateService";
import type { CombatEntityResolver } from "./CombatEntityResolver";
import type { PidManager } from "./PidManager";
import type { ProjectileService } from "./ProjectileService";
import type { PlayerSystem } from "..";
import type { PooledTile } from "../../../utils/pools/TilePool";
import type { SystemLogger } from "../../../utils/Logger";
import type { World } from "../../../core/World";
import type { GroundItemSystem } from "../economy/GroundItemSystem";

/**
 * The subset of CombatSystem that tick processing needs.
 * Extends CombatAttackContext (already proven with attack handlers).
 */
export interface CombatTickContext extends CombatAttackContext {
  // Additional services not in CombatAttackContext
  readonly stateService: CombatStateService;
  readonly pidManager: PidManager;

  // Mutable state accessed during tick processing
  lastCombatTargetTile: Map<string, { x: number; z: number }>;

  // Pre-allocated promise buffer
  readonly _attackPromises: Promise<void>[];

  // Methods delegated back to CombatSystem
  endCombat(data: {
    entityId: string;
    skipAttackerEmoteReset?: boolean;
    skipTargetEmoteReset?: boolean;
  }): void;
  getAttackTypeFromWeapon(attackerId: string): AttackType;
  handleAttack(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    attackType: AttackType;
  }): Promise<void>;
  getPlayerAttackStyle(playerId: string): { id: string } | null;
  isAFKTooLong(playerId: string, currentTick: number): boolean;
  recordCombatEvent(
    type: GameEventType,
    entityId: string,
    payload: Record<string, unknown>,
  ): void;

  // Systems
  groundItemSystem: GroundItemSystem | null;
}

export class CombatTickProcessor {
  // Pre-allocated event payloads (zero allocation in hot path)
  private readonly _followTargetPayload = {
    playerId: "",
    targetId: "",
    targetPosition: { x: 0, y: 0, z: 0 },
    attackRange: 1 as number | undefined,
    attackType: "melee" as string | undefined,
  };

  private readonly _damageDealtPayload = {
    projectileId: undefined as string | undefined,
    attackerId: "",
    targetId: "",
    damage: 0,
    attackType: AttackType.MELEE as AttackType | undefined,
    targetType: "mob" as "player" | "mob" | undefined,
    position: { x: 0, y: 0, z: 0 } as
      { x: number; y: number; z: number } | undefined,
  };
  private readonly _damageDealtPositionBuffer = { x: 0, y: 0, z: 0 };

  private readonly _projectileHitPayload = {
    projectileId: "",
    attackerId: "",
    targetId: "",
    damage: 0,
    projectileType: "",
    position: null as { x: number; y: number; z: number } | null,
  };

  private readonly _projectileCancelledPayload = {
    projectileId: "",
    attackerId: "",
    targetId: "",
    projectileType: "arrow" as "arrow" | "spell",
    reason: "combat_state_missing" as
      "combat_state_missing" | "entity_died" | "projectile_expired",
  };

  private readonly _clearFaceTargetPayload = {
    playerId: "",
  };

  constructor(private readonly ctx: CombatTickContext) {}

  /**
   * Main tick entry point — called once per server tick for all combatants.
   */
  processCombatTick(tickNumber: number): void {
    this.ctx.pidManager.update(tickNumber);

    // Process projectile hits (ranged/magic delayed damage)
    this.processProjectileHits(tickNumber);

    // Process scheduled emote resets (tick-aligned animation timing)
    this.ctx.animationManager.processEmoteResets(tickNumber);

    // Get all combat states via StateService (returns reusable buffer)
    const combatStates = this.ctx.stateService.getAllCombatStates();
    const combatStatesMap = this.ctx.stateService.getCombatStatesMap();

    // Lower PID attacks first when multiple attacks on same tick
    combatStates.sort((a, b) =>
      this.ctx.pidManager.comparePriority(a[0], b[0]),
    );

    this.ctx._attackPromises.length = 0;

    for (const [entityId, combatState] of combatStates) {
      if (!combatStatesMap.has(entityId)) continue;

      // Check for combat timeout (8 ticks after last hit)
      if (combatState.inCombat && tickNumber >= combatState.combatEndTick) {
        this.ctx.endCombat({ entityId: String(entityId) });
        continue;
      }

      if (!combatState.inCombat || !combatState.targetId) continue;

      // classic MMORPG-style: Check range EVERY tick and follow if needed
      if (combatState.attackerType === "player") {
        this.checkRangeAndFollow(combatState, tickNumber);
      }

      // Check if this entity can attack on this tick
      if (tickNumber >= combatState.nextAttackTick) {
        this.ctx._attackPromises.push(
          this.processAutoAttackOnTick(combatState, tickNumber).catch((err) => {
            this.ctx.logger.error(
              "processAutoAttackOnTick failed",
              err instanceof Error ? err : undefined,
              { entityId: String(entityId), tick: tickNumber },
            );
          }),
        );
      }
    }

    if (this.ctx._attackPromises.length > 0) {
      Promise.allSettled(this.ctx._attackPromises).catch(() => {});
    }
  }

  /**
   * Process combat for a specific NPC on this tick.
   */
  processNPCCombatTick(mobId: string, tickNumber: number): void {
    const combatState = this.ctx.stateService.getCombatData(mobId);
    if (!combatState) return;

    if (combatState.inCombat && tickNumber >= combatState.combatEndTick) {
      this.ctx.endCombat({ entityId: mobId });
      return;
    }

    if (!combatState.inCombat || !combatState.targetId) return;
    if (combatState.attackerType !== "mob") return;

    this.ctx.animationManager.processEntityEmoteReset(mobId, tickNumber);

    if (tickNumber >= combatState.nextAttackTick) {
      this.processAutoAttackOnTick(combatState, tickNumber).catch((err) => {
        this.ctx.logger.error(
          "NPC processAutoAttackOnTick failed",
          err instanceof Error ? err : undefined,
          { mobId, tick: tickNumber },
        );
      });
    }
  }

  /**
   * Process combat for a specific player on this tick.
   */
  processPlayerCombatTick(playerId: string, tickNumber: number): void {
    const combatState = this.ctx.stateService.getCombatData(playerId);
    if (!combatState) return;

    if (combatState.inCombat && tickNumber >= combatState.combatEndTick) {
      this.ctx.endCombat({ entityId: playerId });
      return;
    }

    if (!combatState.inCombat || !combatState.targetId) return;
    if (combatState.attackerType !== "player") return;

    this.ctx.animationManager.processEntityEmoteReset(playerId, tickNumber);

    this.checkRangeAndFollow(combatState, tickNumber);

    if (tickNumber >= combatState.nextAttackTick) {
      this.processAutoAttackOnTick(combatState, tickNumber).catch((err) => {
        this.ctx.logger.error(
          "Player processAutoAttackOnTick failed",
          err instanceof Error ? err : undefined,
          { playerId, tick: tickNumber },
        );
      });
    }
  }

  private checkRangeAndFollow(
    combatState: CombatData,
    tickNumber: number,
  ): void {
    const attackerId = String(combatState.attackerId);
    const targetId = String(combatState.targetId);

    const attacker = this.ctx.entityResolver.resolve(
      attackerId,
      combatState.attackerType,
    );
    const target = this.ctx.entityResolver.resolve(
      targetId,
      combatState.targetType,
    );

    if (!attacker || !target) return;
    if (!this.ctx.entityResolver.isAlive(attacker, combatState.attackerType))
      return;
    if (!this.ctx.entityResolver.isAlive(target, combatState.targetType))
      return;

    // PvP zone check — bypass for streaming duels (matches enterCombat behavior)
    if (
      combatState.attackerType === "player" &&
      combatState.targetType === "player"
    ) {
      const attackerInStreamingDuel =
        (attacker as { data?: { inStreamingDuel?: boolean } })?.data
          ?.inStreamingDuel === true;
      const targetInStreamingDuel =
        (target as { data?: { inStreamingDuel?: boolean } })?.data
          ?.inStreamingDuel === true;

      if (!attackerInStreamingDuel && !targetInStreamingDuel) {
        const zoneSystem = this.ctx.world.getSystem("zone-detection");
        if (zoneSystem) {
          const attackerPos = getEntityPosition(attacker);
          if (
            attackerPos &&
            !zoneSystem.isPvPEnabled({ x: attackerPos.x, z: attackerPos.z })
          ) {
            return;
          }
        }
      }
    }

    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return;

    tilePool.setFromPosition(this.ctx._attackerTile, attackerPos);
    tilePool.setFromPosition(this.ctx._targetTile, targetPos);
    const combatRangeTiles = this.ctx.entityResolver.getCombatRange(
      attacker,
      combatState.attackerType,
    );

    const attackType =
      combatState.attackerType === "player"
        ? this.ctx.getAttackTypeFromWeapon(attackerId)
        : AttackType.MELEE;

    const inRange =
      attackType === AttackType.MELEE
        ? tilesWithinMeleeRange(
            this.ctx._attackerTile,
            this.ctx._targetTile,
            combatRangeTiles,
          )
        : tilesWithinRange(
            this.ctx._attackerTile,
            this.ctx._targetTile,
            combatRangeTiles,
          );

    const lastKnown = this.ctx.lastCombatTargetTile.get(attackerId);
    const targetMoved =
      !lastKnown ||
      lastKnown.x !== this.ctx._targetTile.x ||
      lastKnown.z !== this.ctx._targetTile.z;

    if (targetMoved) {
      if (lastKnown) {
        lastKnown.x = this.ctx._targetTile.x;
        lastKnown.z = this.ctx._targetTile.z;
      } else {
        this.ctx.lastCombatTargetTile.set(attackerId, {
          x: this.ctx._targetTile.x,
          z: this.ctx._targetTile.z,
        });
      }
    }

    if (!inRange) {
      combatState.combatEndTick =
        tickNumber + COMBAT_CONSTANTS.COMBAT_TIMEOUT_TICKS;
    }

    if (!inRange || targetMoved) {
      this._followTargetPayload.playerId = attackerId;
      this._followTargetPayload.targetId = targetId;
      this._followTargetPayload.targetPosition.x = targetPos.x;
      this._followTargetPayload.targetPosition.y = targetPos.y;
      this._followTargetPayload.targetPosition.z = targetPos.z;
      this._followTargetPayload.attackRange = combatRangeTiles;
      this._followTargetPayload.attackType = attackType;
      this.ctx.emitTypedEvent(
        EventType.COMBAT_FOLLOW_TARGET,
        this._followTargetPayload,
      );
    }
  }

  private processProjectileHits(tickNumber: number): void {
    const result = this.ctx.projectileService.processTick(tickNumber);

    for (const projectile of result.expired) {
      this.emitProjectileCancelled(projectile, "projectile_expired");
    }

    for (const projectile of result.hits) {
      const target =
        this.ctx.entityResolver.resolve(projectile.targetId, "mob") ??
        this.ctx.entityResolver.resolve(projectile.targetId, "player");

      if (!target) {
        this.emitProjectileCancelled(projectile, "combat_state_missing");
        continue;
      }

      const targetType = isMobEntity(target) ? "mob" : "player";
      if (!this.ctx.entityResolver.isAlive(target, targetType)) {
        this.emitProjectileCancelled(projectile, "entity_died");
        continue;
      }

      const currentHealth = this.ctx.entityResolver.getHealth(target);
      const damage = Math.min(projectile.damage, currentHealth);

      this.ctx.applyDamage(
        projectile.targetId,
        targetType,
        damage,
        projectile.attackerId,
      );

      // Emit damage event using pre-allocated payload (zero allocation)
      const targetPosition = getEntityPosition(target);
      this._damageDealtPayload.projectileId = projectile.id;
      this._damageDealtPayload.attackerId = projectile.attackerId;
      this._damageDealtPayload.targetId = projectile.targetId;
      this._damageDealtPayload.damage = damage;
      this._damageDealtPayload.attackType = projectile.spellId
        ? AttackType.MAGIC
        : AttackType.RANGED;
      this._damageDealtPayload.targetType = targetType;
      if (targetPosition) {
        this._damageDealtPositionBuffer.x = targetPosition.x;
        this._damageDealtPositionBuffer.y = targetPosition.y;
        this._damageDealtPositionBuffer.z = targetPosition.z;
        this._damageDealtPayload.position = this._damageDealtPositionBuffer;
      } else {
        this._damageDealtPayload.position = undefined;
      }
      this.ctx.emitTypedEvent(
        EventType.COMBAT_DAMAGE_DEALT,
        this._damageDealtPayload,
      );

      // Emit projectile hit using pre-allocated payload
      this._projectileHitPayload.projectileId = projectile.id;
      this._projectileHitPayload.attackerId = projectile.attackerId;
      this._projectileHitPayload.targetId = projectile.targetId;
      this._projectileHitPayload.damage = damage;
      this._projectileHitPayload.projectileType = projectile.spellId
        ? "spell"
        : "arrow";
      this._projectileHitPayload.position = targetPosition;
      this.ctx.emitTypedEvent(
        EventType.COMBAT_PROJECTILE_HIT,
        this._projectileHitPayload,
      );

      if (projectile.ammunitionRecovery && this.ctx.groundItemSystem) {
        void this.ctx.groundItemSystem
          .exposeCommittedDurableSource(projectile.ammunitionRecovery)
          .then((exposed) => {
            if (!exposed) {
              console.error(
                `[CombatTickProcessor] Recovered-arrow custody rejected for ${projectile.id}`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `[CombatTickProcessor] Recovered-arrow custody failed for ${projectile.id}: ${String(error)}`,
            );
          });
      }

      this.ctx.recordCombatEvent(
        GameEventType.COMBAT_DAMAGE,
        projectile.attackerId,
        {
          targetId: projectile.targetId,
          damage,
          rawDamage: projectile.damage,
          projectileHit: true,
          attackType: projectile.spellId ? "magic" : "ranged",
        },
      );

      if (projectile.xpReward && projectile.xpReward > 0) {
        this.ctx.emitTypedEvent(EventType.PLAYER_XP_GAINED, {
          playerId: projectile.attackerId,
          skill: "magic",
          xp: projectile.xpReward,
        });
      }
    }
  }

  private emitProjectileCancelled(
    projectile: {
      id: string;
      attackerId: string;
      targetId: string;
      spellId?: string;
    },
    reason: "combat_state_missing" | "entity_died" | "projectile_expired",
  ): void {
    this._projectileCancelledPayload.projectileId = projectile.id;
    this._projectileCancelledPayload.attackerId = projectile.attackerId;
    this._projectileCancelledPayload.targetId = projectile.targetId;
    this._projectileCancelledPayload.projectileType = projectile.spellId
      ? "spell"
      : "arrow";
    this._projectileCancelledPayload.reason = reason;
    this.ctx.emitTypedEvent(
      EventType.COMBAT_PROJECTILE_CANCELLED,
      this._projectileCancelledPayload,
    );
  }

  private async processAutoAttackOnTick(
    combatState: CombatData,
    tickNumber: number,
  ): Promise<void> {
    const attackerId = String(combatState.attackerId);
    const targetId = String(combatState.targetId);
    const typedAttackerId = combatState.attackerId;

    // Step 1: Validate combat actors
    const actors = this.validateCombatActors(combatState);
    if (!actors) return;
    const { attacker, target } = actors;

    // Step 1.5: Route ranged/magic to their handlers
    // Players: resolve attack type from equipped weapon
    // Mobs: use weaponType stored in combat state (set by enterCombat)
    const attackType =
      combatState.attackerType === "player"
        ? this.ctx.getAttackTypeFromWeapon(attackerId)
        : (combatState.weaponType ?? AttackType.MELEE);

    if (attackType === AttackType.RANGED || attackType === AttackType.MAGIC) {
      // Handlers handle claiming the cooldown slot synchronously before any async work,
      // so we don't need to pre-claim it here (which would break their internal checks).

      // Note: spellId/arrowId are not passed here; handlers resolve them
      // from entity state on the auto-attack path.
      await this.ctx.handleAttack({
        attackerId,
        targetId,
        attackerType: combatState.attackerType,
        targetType: combatState.targetType,
        attackType,
      });

      // Refresh combat timeout after ranged/magic attack to prevent combat
      // from timing out after COMBAT_TIMEOUT_TICKS. The handler may have
      // replaced the state via enterCombat → createAttackerState, so fetch
      // the fresh state from the Map (old reference may be stale).
      const freshState = this.ctx.stateService
        .getCombatStatesMap()
        .get(typedAttackerId);
      if (freshState) {
        freshState.combatEndTick =
          tickNumber + COMBAT_CONSTANTS.COMBAT_TIMEOUT_TICKS;
        freshState.lastAttackTick = tickNumber;
      }
      return;
    }

    // Step 2: Validate melee range
    if (!this.validateAttackRange(attacker, target, combatState.attackerType))
      return;

    // Step 3: Execute melee attack
    const damage = this.executeAttackDamage(
      attackerId,
      targetId,
      attacker,
      target,
      combatState,
      tickNumber,
    );

    // Step 4: Check if state still exists (target may have died)
    if (!this.ctx.stateService.getCombatStatesMap().has(typedAttackerId))
      return;

    // Step 5: Update tick state
    this.updateCombatTickState(combatState, typedAttackerId, tickNumber);

    // Step 6: Player retaliation
    if (combatState.targetType === "player") {
      this.handlePlayerRetaliation(
        targetId,
        attackerId,
        typedAttackerId,
        combatState.attackerType,
        tickNumber,
      );
    }

    // Step 7: Combat events
    this.emitCombatEvents(attackerId, targetId, target, damage, combatState);
  }

  private validateCombatActors(
    combatState: CombatData,
  ): { attacker: Entity | MobEntity; target: Entity | MobEntity } | null {
    const attackerId = String(combatState.attackerId);
    const targetId = String(combatState.targetId);

    const attacker = this.ctx.entityResolver.resolve(
      attackerId,
      combatState.attackerType,
    );
    const target = this.ctx.entityResolver.resolve(
      targetId,
      combatState.targetType,
    );

    if (!attacker || !target) return null;
    if (!this.ctx.entityResolver.isAlive(attacker, combatState.attackerType))
      return null;
    if (!this.ctx.entityResolver.isAlive(target, combatState.targetType))
      return null;

    return { attacker, target };
  }

  private validateAttackRange(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    attackerType: "player" | "mob",
  ): boolean {
    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return false;

    tilePool.setFromPosition(this.ctx._attackerTile, attackerPos);
    tilePool.setFromPosition(this.ctx._targetTile, targetPos);
    const combatRangeTiles = this.ctx.entityResolver.getCombatRange(
      attacker,
      attackerType,
    );

    return tilesWithinMeleeRange(
      this.ctx._attackerTile,
      this.ctx._targetTile,
      combatRangeTiles,
    );
  }

  private executeAttackDamage(
    attackerId: string,
    targetId: string,
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    combatState: CombatData,
    tickNumber: number,
  ): number {
    this.ctx.rotationManager.rotateTowardsTarget(
      attackerId,
      targetId,
      combatState.attackerType,
      combatState.targetType,
    );

    this.ctx.animationManager.setCombatEmote(
      attackerId,
      combatState.attackerType,
      tickNumber,
      combatState.attackSpeedTicks,
    );

    let combatStyle: CombatStyle = "accurate";
    if (combatState.attackerType === "player") {
      const styleData = this.ctx.getPlayerAttackStyle(attackerId);
      if (styleData?.id) {
        combatStyle = styleData.id as CombatStyle;
      }
    }

    const rawDamage = this.ctx.calculateMeleeDamage(
      attacker,
      target,
      combatStyle,
    );
    const currentHealth = this.ctx.entityResolver.getHealth(target);
    const damage = Math.min(rawDamage, currentHealth);

    this.ctx.applyDamage(targetId, combatState.targetType, damage, attackerId);

    // Emit damage event using pre-allocated payload (zero allocation)
    const targetPosition = getEntityPosition(target);
    this._damageDealtPayload.projectileId = undefined;
    this._damageDealtPayload.attackerId = attackerId;
    this._damageDealtPayload.targetId = targetId;
    this._damageDealtPayload.damage = damage;
    this._damageDealtPayload.attackType = AttackType.MELEE;
    this._damageDealtPayload.targetType = combatState.targetType;
    if (targetPosition) {
      this._damageDealtPositionBuffer.x = targetPosition.x;
      this._damageDealtPositionBuffer.y = targetPosition.y;
      this._damageDealtPositionBuffer.z = targetPosition.z;
      this._damageDealtPayload.position = this._damageDealtPositionBuffer;
    } else {
      this._damageDealtPayload.position = undefined;
    }
    this.ctx.emitTypedEvent(
      EventType.COMBAT_DAMAGE_DEALT,
      this._damageDealtPayload,
    );

    this.ctx.recordCombatEvent(GameEventType.COMBAT_ATTACK, attackerId, {
      targetId,
      attackerType: combatState.attackerType,
      targetType: combatState.targetType,
      attackSpeedTicks: combatState.attackSpeedTicks,
    });

    if (damage > 0) {
      this.ctx.recordCombatEvent(GameEventType.COMBAT_DAMAGE, attackerId, {
        targetId,
        damage,
        rawDamage,
        targetHealth: currentHealth,
        targetPosition: targetPosition
          ? { x: targetPosition.x, y: targetPosition.y, z: targetPosition.z }
          : undefined,
      });
    } else {
      this.ctx.recordCombatEvent(GameEventType.COMBAT_MISS, attackerId, {
        targetId,
        rawDamage,
      });
    }

    return damage;
  }

  private updateCombatTickState(
    combatState: CombatData,
    typedAttackerId: EntityID,
    tickNumber: number,
  ): void {
    combatState.lastAttackTick = tickNumber;
    combatState.nextAttackTick = tickNumber + combatState.attackSpeedTicks;
    combatState.combatEndTick =
      tickNumber + COMBAT_CONSTANTS.COMBAT_TIMEOUT_TICKS;
    this.ctx.nextAttackTicks.set(typedAttackerId, combatState.nextAttackTick);
  }

  private handlePlayerRetaliation(
    targetId: string,
    attackerId: string,
    typedAttackerId: EntityID,
    attackerType: "player" | "mob",
    tickNumber: number,
  ): void {
    const targetPlayerState = this.ctx.stateService.getCombatData(targetId);
    let shouldRetaliate =
      this.ctx.playerSystem?.getPlayerAutoRetaliate(targetId) ?? true;

    if (shouldRetaliate && this.ctx.isAFKTooLong(targetId, tickNumber)) {
      shouldRetaliate = false;
    }

    if (!shouldRetaliate) return;

    const needsNewTarget =
      !targetPlayerState ||
      !targetPlayerState.inCombat ||
      !this.ctx.entityResolver.isAlive(
        this.ctx.entityResolver.resolve(
          String(targetPlayerState.targetId),
          targetPlayerState.targetType,
        ),
        targetPlayerState.targetType,
      );

    if (!needsNewTarget) return;

    const playerAttackSpeed = this.ctx.entityResolver.getAttackSpeed(
      createEntityID(targetId),
      "player",
    );
    const retaliationDelay = calculateRetaliationDelay(playerAttackSpeed);

    this.ctx.stateService.createRetaliatorState(
      createEntityID(targetId),
      typedAttackerId,
      "player",
      attackerType,
      tickNumber,
      retaliationDelay,
      playerAttackSpeed,
    );

    this.ctx.stateService.syncCombatStateToEntity(
      targetId,
      attackerId,
      "player",
    );

    this.ctx.rotationManager.rotateTowardsTarget(
      targetId,
      attackerId,
      "player",
      attackerType,
    );

    this._clearFaceTargetPayload.playerId = targetId;
    this.ctx.emitTypedEvent(
      EventType.COMBAT_CLEAR_FACE_TARGET,
      this._clearFaceTargetPayload,
    );
  }

  private emitCombatEvents(
    attackerId: string,
    _targetId: string,
    target: Entity | MobEntity,
    damage: number,
    combatState: CombatData,
  ): void {
    if (combatState.attackerType === "player") {
      this.ctx.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: `You hit the ${this.ctx.entityResolver.getDisplayName(target)} for ${damage} damage!`,
        type: "combat",
      });
    }
  }
}
