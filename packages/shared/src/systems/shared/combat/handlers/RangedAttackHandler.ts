/**
 * RangedAttackHandler - Handles ranged attack validation, projectile creation, and damage.
 *
 * Extracted from CombatSystem to reduce class size.
 * Pre-allocates RangedDamageParams to eliminate per-attack heap allocations.
 */

import {
  type CombatAttackContext,
  checkProjectileRange,
  prepareMobAttack,
} from "./AttackContext";
import { EntityID } from "../../../../types/core/identifiers";
import { AttackType } from "../../../../types/core/core";
import { EventType } from "../../../../types/events";
import { COMBAT_CONSTANTS } from "../../../../constants/CombatConstants";
import { createEntityID } from "../../../../utils/IdentifierUtils";
import {
  CombatViolationType,
  CombatViolationSeverity,
} from "../CombatAntiCheat";
import { getEntityPosition } from "../../../../utils/game/EntityPositionUtils";
import { isMobEntity } from "../../../../utils/typeGuards";
import {
  calculateRangedDamage,
  type RangedDamageParams,
} from "../RangedDamageCalculator";
import {
  type RangedCombatStyle,
  RANGED_STYLE_BONUSES,
} from "../../../../types/game/combat-types";
import { ammunitionService } from "../AmmunitionService";
import type { CreateProjectileParams } from "../ProjectileService";
import { getGameRng } from "../../../../utils/SeededRandom";
import type { Entity } from "../../../../entities/Entity";
import type { MobEntity } from "../../../../entities/npc/MobEntity";
import { getNPCById } from "../../../../data/npcs";
import { isPositionInsideDuelArenaZone } from "../../../../data/duel-manifest";
import { uuid } from "../../../../utils/IdGenerator";

export class RangedAttackHandler {
  /**
   * Pre-allocated params object — mutated in-place to avoid per-attack allocations.
   * Safe because the tick loop is single-threaded; do NOT introduce await before
   * damage calculation or player/mob paths could interleave and corrupt shared state.
   */
  private readonly _rangedParams: RangedDamageParams = {
    rangedLevel: 0,
    rangedAttackBonus: 0,
    rangedStrengthBonus: 0,
    style: "accurate",
    targetDefenseLevel: 0,
    targetRangedDefenseBonus: 0,
    prayerBonuses: undefined,
    targetPrayerBonuses: undefined,
  };

  constructor(private readonly ctx: CombatAttackContext) {}

  /**
   * Handle ranged attack - validate arrows, create projectile, queue damage
   */
  async handle(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    arrowId?: string;
  }): Promise<void> {
    const { attackerType } = data;

    if (attackerType === "mob") {
      this.handleMobRangedAttack({ ...data, attackerType });
      return;
    }

    await this.handlePlayerRangedAttack(data);
  }

  /**
   * Handle mob ranged attack — resolve arrow from NPCData, skip arrow consumption
   */
  private handleMobRangedAttack(data: {
    attackerId: string;
    targetId: string;
    attackerType: "mob";
    targetType: "player" | "mob";
    arrowId?: string;
  }): void {
    // Resolve arrow before preparation — bail if no arrow configured (data error)
    const mobEntity = this.ctx.entityResolver.resolve(
      data.attackerId,
      data.attackerType,
    ) as MobEntity | null;
    if (!mobEntity) return;
    const mobData = mobEntity.getMobData();
    const npcData = getNPCById(mobData.type);
    if (!npcData) return;
    const arrowId = data.arrowId ?? npcData.combat.arrowId;
    if (!arrowId) {
      console.warn(
        `[RangedAttackHandler] Mob ${data.attackerId} (${mobData.type}) has no arrowId configured, skipping attack`,
      );
      return;
    }

    // Shared mob attack preparation (entity resolution, range, cooldown, animation)
    // Pass pre-resolved mob + NPC data to avoid redundant entity lookups
    const mobCtx = prepareMobAttack(
      this.ctx,
      data,
      COMBAT_CONSTANTS.RANGED_RANGE, // Fallback if NPC manifest omits combatRange
      "ranged",
      COMBAT_CONSTANTS.DEFAULTS.NPC.ATTACK_SPEED_TICKS, // Fallback attack speed
      { attacker: mobEntity, npcData },
    );
    if (!mobCtx) return;

    const {
      target,
      attackerId,
      targetId,
      targetType,
      typedAttackerId,
      attackerPos,
      targetPos,
      distance,
      currentTick,
      attackSpeedTicks,
    } = mobCtx;

    // Calculate damage using mob's ranged stat
    const rangedLevel = mobCtx.npcData.stats.ranged ?? 1;
    const damage = this.calculateMobRangedDamage(
      target,
      targetType,
      rangedLevel,
      arrowId,
    );

    // Create projectile
    const projectileParams: CreateProjectileParams = {
      sourceId: attackerId,
      targetId,
      attackType: AttackType.RANGED,
      damage,
      currentTick,
      sourcePosition: { x: attackerPos.x, z: attackerPos.z },
      targetPosition: { x: targetPos.x, z: targetPos.z },
      arrowId,
      xpReward: 0, // Mobs don't earn XP
    };

    const projectile =
      this.ctx.projectileService.createProjectile(projectileParams);
    if (!projectile) return;

    this.emitRangedProjectile(
      attackerId,
      targetId,
      arrowId,
      attackerPos,
      targetPos,
      distance,
      projectile.id,
    );

    // Enter combat
    const typedTargetId = createEntityID(targetId);
    this.ctx.enterCombat(
      typedAttackerId,
      typedTargetId,
      attackSpeedTicks,
      AttackType.RANGED,
    );
  }

  /**
   * Emit COMBAT_PROJECTILE_LAUNCHED for a ranged attack.
   * Shared between mob and player paths — computes hit delay from distance
   * so the visual arrow arrival coincides with the server-side damage splat.
   */
  private emitRangedProjectile(
    attackerId: string,
    targetId: string,
    arrowId: string | undefined,
    attackerPos: { x: number; y: number; z: number },
    targetPos: { x: number; y: number; z: number },
    distance: number,
    projectileId: string,
  ): void {
    const { HIT_DELAY, TICK_DURATION_MS } = COMBAT_CONSTANTS;
    const rangedHitDelayTicks = Math.min(
      HIT_DELAY.MAX_HIT_DELAY,
      HIT_DELAY.RANGED_BASE +
        Math.floor(
          (HIT_DELAY.RANGED_DISTANCE_OFFSET + distance) /
            HIT_DELAY.RANGED_DISTANCE_DIVISOR,
        ),
    );
    const arrowLaunchDelayMs = COMBAT_CONSTANTS.ARROW_LAUNCH_DELAY_MS;
    const travelDurationMs = Math.max(
      200,
      rangedHitDelayTicks * TICK_DURATION_MS - arrowLaunchDelayMs,
    );

    this.ctx.emitTypedEvent(EventType.COMBAT_PROJECTILE_LAUNCHED, {
      projectileId,
      attackerId,
      targetId,
      projectileType: "arrow",
      sourcePosition: attackerPos,
      targetPosition: targetPos,
      delayMs: arrowLaunchDelayMs,
      arrowId,
      travelDurationMs,
    });
  }

  /**
   * Calculate ranged damage for a mob attacker.
   * Shares the pre-allocated _rangedParams with calculateRangedDamageForAttack —
   * both use the same formula via calculateRangedDamage() but mob path skips
   * equipment bonuses and prayer.
   */
  private calculateMobRangedDamage(
    target: Entity | MobEntity,
    targetType: "player" | "mob",
    rangedLevel: number,
    arrowId: string,
  ): number {
    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.ctx.getPlayerSkillLevel(String(target.id), "defense");

    const targetRangedDefense =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : (this.ctx.playerEquipmentStats.get(String(target.id))
            ?.defenseRanged ?? 0);

    // Get target prayer bonuses (only for player targets)
    const defenderPrayer =
      targetType === "player"
        ? this.ctx.prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    // Mutate pre-allocated params in-place (zero GC).
    // SAFETY: This object is shared between mob and player paths. Do NOT add
    // await between here and calculateRangedDamage() — async interleaving would
    // corrupt the shared state.
    const p = this._rangedParams;
    p.rangedLevel = rangedLevel;
    p.rangedAttackBonus = 0; // Mobs don't have equipment bonuses
    p.rangedStrengthBonus =
      ammunitionService.getArrowData(arrowId)?.rangedStrength ?? 7;
    p.style = "accurate";
    p.targetDefenseLevel = targetDefenseLevel;
    p.targetRangedDefenseBonus = targetRangedDefense;
    p.prayerBonuses = undefined; // Mobs don't use prayer
    p.targetPrayerBonuses = defenderPrayer;

    const result = calculateRangedDamage(p, getGameRng());
    return result.damage;
  }

  /**
   * Handle player ranged attack — full validation, arrows, equipment
   */
  private async handlePlayerRangedAttack(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
  }): Promise<void> {
    const { attackerId, targetId, attackerType, targetType } = data;
    const currentTick = this.ctx.world.currentTick ?? 0;

    // Validate entity IDs
    if (
      !this.ctx.entityIdValidator.isValid(attackerId) ||
      !this.ctx.entityIdValidator.isValid(targetId)
    ) {
      return;
    }

    // Rate limiting
    const rateResult = this.ctx.rateLimiter.checkLimit(attackerId, currentTick);
    if (!rateResult.allowed) {
      this.ctx.antiCheat.recordViolation(
        attackerId,
        CombatViolationType.ATTACK_RATE_EXCEEDED,
        CombatViolationSeverity.MINOR,
        `Ranged rate limited: ${rateResult.reason}`,
        undefined,
        currentTick,
      );
      return;
    }
    this.ctx.antiCheat.trackAttack(attackerId, currentTick);

    // Validate attacker is on a walkable tile (anti-cheat)
    if (
      !this.ctx.validateAttackerPosition(
        attackerId,
        targetId,
        "Ranged",
        currentTick,
      )
    )
      return;

    // Get entities
    const attacker = this.ctx.entityResolver.resolve(attackerId, attackerType);
    const target = this.ctx.entityResolver.resolve(targetId, targetType);
    if (!attacker || !target) return;

    // Check both are alive
    if (
      !this.ctx.entityResolver.isAlive(attacker, attackerType) ||
      !this.ctx.entityResolver.isAlive(target, targetType)
    ) {
      return;
    }

    // Validate arrows equipped
    const weapon = this.ctx.getEquippedWeapon(attackerId);
    const arrowSlot = this.ctx.getEquippedArrows(attackerId);
    const rangedLevel = this.ctx.getPlayerSkillLevel(attackerId, "ranged");

    const arrowValidation = ammunitionService.validateArrows(
      weapon,
      arrowSlot,
      rangedLevel,
    );
    if (!arrowValidation.valid) {
      this.ctx.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: arrowValidation.error ?? "You need arrows to attack.",
        type: "error",
      });
      return;
    }

    // Resolve ranged style before range check so longrange +2 applies (rules-accurate)
    let rangedStyle: RangedCombatStyle = "accurate";
    const styleData = this.ctx.playerSystem?.getPlayerAttackStyle?.(attackerId);
    if (styleData?.id) {
      const id = styleData.id;
      if (id === "accurate" || id === "rapid" || id === "longrange") {
        rangedStyle = id;
      }
    }
    const styleBonus = RANGED_STYLE_BONUSES[rangedStyle];

    // Check ranged attack range — longrange style adds +2 tiles (rules-accurate)
    const attackRange = (weapon?.attackRange ?? 7) + styleBonus.rangeModifier;
    const distance = checkProjectileRange(
      this.ctx,
      attackerId,
      targetId,
      attacker,
      target,
      attackRange,
    );
    if (distance < 0) return;

    // Get positions for projectile creation (range check already validated non-null)
    const attackerPos = getEntityPosition(attacker)!;
    const targetPos = getEntityPosition(target)!;

    // Check cooldown
    const typedAttackerId = createEntityID(attackerId);
    if (!this.ctx.checkAttackCooldown(typedAttackerId, currentTick)) {
      return;
    }
    const projectileSourcePosition = {
      x: attackerPos.x,
      z: attackerPos.z,
    };
    const projectileTargetPosition = {
      x: targetPos.x,
      z: targetPos.z,
    };
    const projectileRecoveryPosition = {
      x: targetPos.x,
      y: targetPos.y,
      z: targetPos.z,
    };
    const projectileReservation = this.ctx.projectileService.reserveProjectile(
      attackerId,
      projectileSourcePosition,
      projectileTargetPosition,
    );
    if (!projectileReservation) {
      this.ctx.emitTypedEvent(EventType.COMBAT_ATTACK_FAILED, {
        attackerId,
        targetId,
        reason: "projectile_capacity",
      });
      return;
    }

    // Get attack speed from weapon with style modifier (rapid = -1 tick)
    const baseAttackSpeed = weapon?.attackSpeed ?? 4;
    const attackSpeedTicks = Math.max(
      1,
      baseAttackSpeed + styleBonus.speedModifier,
    );

    // Claim cooldown slot immediately to prevent dual-path race condition
    // (event handler + tick auto-attack can both pass checkAttackCooldown on same tick)
    const previousNextAttackTick =
      this.ctx.nextAttackTicks.get(typedAttackerId);
    const claimedNextAttackTick = currentTick + attackSpeedTicks;
    this.ctx.nextAttackTicks.set(typedAttackerId, claimedNextAttackTick);

    // Calculate damage
    const damage = this.calculateRangedDamageForAttack(
      attacker,
      target,
      attackerId,
      targetType,
    );

    const arrowId = arrowSlot?.itemId?.toString();
    const recoverySelected =
      !isPositionInsideDuelArenaZone(
        projectileTargetPosition.x,
        projectileTargetPosition.z,
      ) && getGameRng().random() >= 0.2;
    const arrowDebit =
      arrowId && this.ctx.equipmentSystem
        ? await this.ctx.equipmentSystem.consumeArrowForProjectileAtomic(
            attackerId,
            `ammunition-shot:${uuid()}${uuid()}`,
            arrowId,
            recoverySelected ? "recovered" : "destroyed",
            recoverySelected ? projectileRecoveryPosition : null,
          )
        : null;
    if (!arrowDebit?.ok) {
      this.ctx.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      if (
        this.ctx.nextAttackTicks.get(typedAttackerId) === claimedNextAttackTick
      ) {
        if (previousNextAttackTick === undefined) {
          this.ctx.nextAttackTicks.delete(typedAttackerId);
        } else {
          this.ctx.nextAttackTicks.set(typedAttackerId, previousNextAttackTick);
        }
      }
      this.ctx.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message:
          arrowDebit?.reason === "insufficient_items"
            ? "You don't have enough ammunition."
            : "The ranged attack was cancelled before launch. Your equipment is being synchronized.",
        type: "error",
      });
      return;
    }

    // Create projectile with delayed hit
    const projectileParams: CreateProjectileParams = {
      sourceId: attackerId,
      targetId,
      attackType: AttackType.RANGED,
      damage,
      currentTick,
      sourcePosition: projectileSourcePosition,
      targetPosition: projectileTargetPosition,
      arrowId,
      ammunitionCustody: {
        operationId: arrowDebit.operationId,
        playerId: arrowDebit.playerId,
        requestFingerprint: arrowDebit.requestFingerprint,
        itemId: arrowDebit.arrowId,
        recoveryDisposition: arrowDebit.recoveryDisposition,
      },
    };

    const projectile = this.ctx.projectileService.createReservedProjectile(
      projectileReservation,
      projectileParams,
    );
    if (!projectile) {
      this.ctx.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      await this.ctx.equipmentSystem?.cancelArrowProjectileAtomic(
        projectileParams.ammunitionCustody!,
      );
      this.ctx.logger.error(
        `Reserved projectile admission failed after staged arrow debit for ${attackerId}`,
        new Error("ranged_projectile_commit_invariant_failed"),
      );
      return;
    }
    const scheduledHitTick = projectile.hitsAtTick;
    projectile.hitsAtTick = Number.POSITIVE_INFINITY;
    const launchSettlement =
      await this.ctx.equipmentSystem!.completeArrowProjectileAtomic(
        projectileParams.ammunitionCustody!,
      );
    if (!launchSettlement.ok || launchSettlement.status !== "fired") {
      this.ctx.projectileService.cancelProjectile(projectile.id);
      return;
    }
    projectile.ammunitionRecovery =
      launchSettlement.recoverySource ?? undefined;
    projectile.hitsAtTick = Math.max(scheduledHitTick, currentTick + 1);

    this.ctx.rotationManager.rotateTowardsTarget(
      attackerId,
      targetId,
      attackerType,
      targetType,
    );
    this.ctx.animationManager.setCombatEmote(
      attackerId,
      attackerType,
      currentTick,
      attackSpeedTicks,
    );

    this.emitRangedProjectile(
      attackerId,
      targetId,
      arrowId,
      attackerPos,
      targetPos,
      distance,
      projectile.id,
    );

    // Enter combat (cooldown already claimed above before projectile creation)
    const typedTargetId = createEntityID(targetId);
    this.ctx.enterCombat(
      typedAttackerId,
      typedTargetId,
      attackSpeedTicks,
      AttackType.RANGED,
    );
  }

  /**
   * Calculate ranged damage for a player attack.
   * Shares the pre-allocated _rangedParams with calculateMobRangedDamage —
   * both use the same formula via calculateRangedDamage() but this path
   * includes equipment bonuses, combat style, and prayer.
   */
  private calculateRangedDamageForAttack(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    attackerId: string,
    targetType: "player" | "mob",
  ): number {
    const rangedLevel = this.ctx.getPlayerSkillLevel(attackerId, "ranged");
    const equipmentStats = this.ctx.playerEquipmentStats.get(attackerId);
    const arrowSlot = this.ctx.getEquippedArrows(attackerId);

    // Get arrow strength bonus
    const arrowStrength = ammunitionService.getArrowStrengthBonus(arrowSlot);

    // Get target stats
    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.ctx.getPlayerSkillLevel(String(target.id), "defense");

    // Use per-style defenseRanged from equipment (classic MMORPG combat triangle).
    // Falls back to generic ranged bonus for backward compatibility.
    const targetEquipStats = this.ctx.playerEquipmentStats.get(
      String(target.id),
    );
    const targetRangedDefense =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : (targetEquipStats?.defenseRanged ?? targetEquipStats?.ranged ?? 0);

    // Get prayer bonuses
    const prayerSystem = this.ctx.prayerSystem;
    const attackerPrayer = prayerSystem?.getCombinedBonuses(attackerId);
    const defenderPrayer =
      targetType === "player"
        ? prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    // NOTE: equipmentStats.rangedStrength already includes arrow strength from EquipmentSystem
    // Do NOT add arrowStrength separately as that would double-count it
    const rangedStrengthBonus = equipmentStats?.rangedStrength ?? arrowStrength;

    // Get player's combat style for rules-accurate damage bonuses
    let rangedStyle: RangedCombatStyle = "accurate";
    const styleData = this.ctx.playerSystem?.getPlayerAttackStyle?.(attackerId);
    if (styleData?.id) {
      const id = styleData.id;
      if (id === "accurate" || id === "rapid" || id === "longrange") {
        rangedStyle = id;
      }
    }

    // Mutate pre-allocated params in-place (zero GC).
    // SAFETY: This object is shared between mob and player paths. Do NOT add
    // await between here and calculateRangedDamage() — async interleaving would
    // corrupt the shared state.
    const p = this._rangedParams;
    p.rangedLevel = rangedLevel;
    p.rangedAttackBonus = equipmentStats?.rangedAttack ?? 0;
    p.rangedStrengthBonus = rangedStrengthBonus;
    p.style = rangedStyle;
    p.targetDefenseLevel = targetDefenseLevel;
    p.targetRangedDefenseBonus = targetRangedDefense;
    p.prayerBonuses = attackerPrayer;
    p.targetPrayerBonuses = defenderPrayer;

    const result = calculateRangedDamage(p, getGameRng());
    return result.damage;
  }
}
