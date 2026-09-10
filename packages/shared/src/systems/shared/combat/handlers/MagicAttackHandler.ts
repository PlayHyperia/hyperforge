/**
 * MagicAttackHandler - Handles magic attack validation, projectile creation, and damage.
 *
 * Extracted from CombatSystem to reduce class size.
 * Pre-allocates MagicDamageParams to eliminate per-attack heap allocations.
 *
 * Supports both player and mob attackers:
 * - Players: spell from selectedSpell, rune validation/consumption, equipment bonuses
 * - Mobs: spell from NPCData spellId, no rune cost, magic stat from manifest
 */

import {
  type CombatAttackContext,
  checkProjectileRange,
  prepareMobAttack,
} from "./AttackContext";
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
  calculateMagicDamage,
  type MagicDamageParams,
} from "../MagicDamageCalculator";
import {
  type MagicCombatStyle,
  MAGIC_STYLE_BONUSES,
} from "../../../../types/game/combat-types";
import { runeService } from "../RuneService";
import { spellService, type Spell } from "../SpellService";
import type { CreateProjectileParams } from "../ProjectileService";
import { getGameRng } from "../../../../utils/SeededRandom";
import type { Entity } from "../../../../entities/Entity";
import type { MobEntity } from "../../../../entities/npc/MobEntity";
import type { Item } from "../../../../types/game/item-types";
import { getNPCById } from "../../../../data/npcs";
import { uuid } from "../../../../utils/IdGenerator";
import type { ProjectileRuneCostSettlementHandle } from "../../../../types/network/database";

export class MagicAttackHandler {
  /**
   * Pre-allocated params object — mutated in-place to avoid per-attack allocations.
   * Safe because the tick loop is single-threaded; do NOT introduce await before
   * damage calculation or player/mob paths could interleave and corrupt shared state.
   */
  private readonly _magicParams: MagicDamageParams = {
    magicLevel: 0,
    magicAttackBonus: 0,
    style: "accurate",
    spellBaseMaxHit: 0,
    targetType: "npc",
    targetMagicLevel: 0,
    targetDefenseLevel: 0,
    targetMagicDefenseBonus: 0,
    prayerBonuses: undefined,
    targetPrayerBonuses: undefined,
  };

  constructor(private readonly ctx: CombatAttackContext) {}

  /**
   * Handle magic attack - validate runes, create projectile, queue damage
   */
  async handle(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    spellId?: string;
  }): Promise<void> {
    const { attackerId, targetId, attackerType, targetType } = data;

    if (attackerType === "mob") {
      this.handleMobMagicAttack({ ...data, attackerType });
      return;
    }

    await this.handlePlayerMagicAttack(data);
  }

  /**
   * Handle mob magic attack — resolve spell from NPCData, skip rune checks
   */
  private handleMobMagicAttack(data: {
    attackerId: string;
    targetId: string;
    attackerType: "mob";
    targetType: "player" | "mob";
    spellId?: string;
  }): void {
    // Resolve spell before preparation (needed for fallback attack speed)
    const mobEntity = this.ctx.entityResolver.resolve(
      data.attackerId,
      data.attackerType,
    ) as MobEntity | null;
    if (!mobEntity) return;
    const mobData = mobEntity.getMobData();
    const npcData = getNPCById(mobData.type);
    if (!npcData) return;
    const spellId = data.spellId ?? npcData.combat.spellId;
    if (!spellId) {
      console.warn(
        `[MagicAttackHandler] Mob ${data.attackerId} (${mobData.type}) has no spellId configured, skipping attack`,
      );
      return;
    }

    const spell = spellService.getSpell(spellId);
    if (!spell) return;

    // Shared mob attack preparation (entity resolution, range, cooldown, animation)
    // Pass pre-resolved mob + NPC data to avoid redundant entity lookups
    const mobCtx = prepareMobAttack(
      this.ctx,
      data,
      COMBAT_CONSTANTS.MAGIC_RANGE, // Fallback if NPC manifest omits combatRange
      "magic",
      spell.attackSpeed, // Fallback attack speed from spell data
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

    // Calculate damage using mob's magic stat
    const magicLevel = mobCtx.npcData.stats.magic ?? 1;
    const damage = this.calculateMobMagicDamage(
      target,
      targetType,
      magicLevel,
      spell,
    );

    // Create projectile
    const projectileParams: CreateProjectileParams = {
      sourceId: attackerId,
      targetId,
      attackType: AttackType.MAGIC,
      damage,
      currentTick,
      sourcePosition: { x: attackerPos.x, z: attackerPos.z },
      targetPosition: { x: targetPos.x, z: targetPos.z },
      spellId: spell.id,
      xpReward: 0, // Mobs don't earn XP
    };

    const projectile =
      this.ctx.projectileService.createProjectile(projectileParams);
    if (!projectile) return;

    this.emitMagicProjectile(
      attackerId,
      targetId,
      spell,
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
      AttackType.MAGIC,
    );
  }

  /**
   * Emit COMBAT_PROJECTILE_LAUNCHED for a magic attack.
   * Shared between mob and player paths — computes hit delay from distance
   * so the visual projectile arrival coincides with the server-side damage splat.
   */
  private emitMagicProjectile(
    attackerId: string,
    targetId: string,
    spell: Spell,
    attackerPos: { x: number; y: number; z: number },
    targetPos: { x: number; y: number; z: number },
    distance: number,
    projectileId: string,
  ): void {
    const { HIT_DELAY, TICK_DURATION_MS } = COMBAT_CONSTANTS;
    const magicHitDelayTicks = Math.min(
      HIT_DELAY.MAX_HIT_DELAY,
      HIT_DELAY.MAGIC_BASE +
        Math.floor(
          (HIT_DELAY.MAGIC_DISTANCE_OFFSET + distance) /
            HIT_DELAY.MAGIC_DISTANCE_DIVISOR,
        ),
    );
    const spellLaunchDelayMs = COMBAT_CONSTANTS.SPELL_LAUNCH_DELAY_MS;
    const travelDurationMs = Math.max(
      200,
      magicHitDelayTicks * TICK_DURATION_MS - spellLaunchDelayMs,
    );

    this.ctx.emitTypedEvent(EventType.COMBAT_PROJECTILE_LAUNCHED, {
      projectileId,
      attackerId,
      targetId,
      projectileType: spell.element,
      sourcePosition: attackerPos,
      targetPosition: targetPos,
      spellId: spell.id,
      delayMs: spellLaunchDelayMs,
      travelDurationMs,
    });
  }

  /**
   * Calculate magic damage for a mob attacker.
   * Shares the pre-allocated _magicParams with calculatePlayerMagicDamage —
   * both use the same formula via calculateMagicDamage() but mob path skips
   * equipment bonuses and prayer.
   */
  private calculateMobMagicDamage(
    target: Entity | MobEntity,
    targetType: "player" | "mob",
    magicLevel: number,
    spell: Spell,
  ): number {
    // Get target stats
    const targetMagicLevel =
      targetType === "mob" && isMobEntity(target)
        ? 1
        : this.ctx.getPlayerSkillLevel(String(target.id), "magic");

    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.ctx.getPlayerSkillLevel(String(target.id), "defense");

    const targetMagicDefense =
      targetType === "mob" && isMobEntity(target)
        ? 0
        : (this.ctx.playerEquipmentStats.get(String(target.id))?.magicDefense ??
          0);

    // Get target prayer bonuses (only for player targets)
    const defenderPrayer =
      targetType === "player"
        ? this.ctx.prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    // Mutate pre-allocated params in-place (zero GC).
    // SAFETY: This object is shared between mob and player paths. Do NOT add
    // await between here and calculateMagicDamage() — async interleaving would
    // corrupt the shared state.
    const p = this._magicParams;
    p.magicLevel = magicLevel;
    p.magicAttackBonus = 0; // Mobs don't have equipment bonuses
    p.style = "accurate";
    p.spellBaseMaxHit = spell.baseMaxHit;
    p.targetType = targetType === "mob" ? "npc" : "player";
    p.targetMagicLevel = targetMagicLevel;
    p.targetDefenseLevel = targetDefenseLevel;
    p.targetMagicDefenseBonus = targetMagicDefense;
    p.prayerBonuses = undefined; // Mobs don't use prayer
    p.targetPrayerBonuses = defenderPrayer;

    const result = calculateMagicDamage(p, getGameRng());
    return result.damage;
  }

  /**
   * Handle player magic attack — full validation, runes, equipment
   */
  private async handlePlayerMagicAttack(data: {
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
        `Magic rate limited: ${rateResult.reason}`,
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
        "Magic",
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

    // Get selected spell from player data
    const selectedSpellId = this.getPlayerSelectedSpell(attackerId);
    const magicLevel = this.ctx.getPlayerSkillLevel(attackerId, "magic");

    // Validate spell can be cast
    const spellValidation = spellService.canCastSpell(
      selectedSpellId,
      magicLevel,
    );
    if (!spellValidation.valid) {
      this.ctx.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: spellValidation.error ?? "You cannot cast this spell.",
        type: "error",
      });
      return;
    }

    const spell = spellService.getSpell(selectedSpellId!);
    if (!spell) return;

    // Validate runes in inventory
    const weapon = this.ctx.getEquippedWeapon(attackerId);
    const inventory = this.getPlayerInventoryItems(attackerId);
    const runeValidation = runeService.hasRequiredRunes(
      inventory,
      spell.runes,
      weapon,
    );
    if (!runeValidation.valid) {
      this.ctx.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: runeValidation.error ?? "You don't have enough runes.",
        type: "error",
      });
      return;
    }

    // Resolve magic style before range check so longrange +2 applies (rules-accurate)
    let magicStyle: MagicCombatStyle = "accurate";
    const magicStyleData =
      this.ctx.playerSystem?.getPlayerAttackStyle?.(attackerId);
    if (magicStyleData?.id) {
      const id = magicStyleData.id;
      if (id === "accurate" || id === "longrange" || id === "autocast") {
        magicStyle = id;
      }
    }

    // Check magic attack range — longrange style adds +2 tiles (rules-accurate)
    const attackRange = 10 + MAGIC_STYLE_BONUSES[magicStyle].rangeModifier;
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
    const projectileReservation = this.ctx.projectileService.reserveProjectile(
      attackerId,
      projectileSourcePosition,
      projectileTargetPosition,
    );
    if (!projectileReservation) {
      this.ctx.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: "You cannot launch another projectile yet.",
        type: "error",
      });
      return;
    }

    // Get attack speed from spell (clamp to minimum 1 tick to prevent zero-speed exploit)
    const attackSpeedTicks = Math.max(1, spell.attackSpeed);

    // Claim cooldown slot IMMEDIATELY to prevent async race condition.
    // handleMagicAttack is async (awaits consumeRunesForSpell), so two concurrent
    // invocations (event handler + tick auto-attack) can both pass checkAttackCooldown
    // before either sets the cooldown, resulting in duplicate projectiles.
    const previousNextAttackTick =
      this.ctx.nextAttackTicks.get(typedAttackerId);
    const claimedNextAttackTick = currentTick + attackSpeedTicks;
    this.ctx.nextAttackTicks.set(typedAttackerId, claimedNextAttackTick);

    // Calculate damage
    const damage = this.calculatePlayerMagicDamage(
      attacker,
      target,
      attackerId,
      targetType,
      spell,
    );

    const runeDebit = await this.consumeRunesForSpell(
      attackerId,
      spell,
      weapon,
      `spell-runes:${uuid()}${uuid()}`,
    );
    if (!runeDebit.ok) {
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
          runeDebit.reason === "insufficient_items"
            ? "You don't have enough runes."
            : "The spell was cancelled before launch. Your inventory is being synchronized.",
        type: "error",
      });
      return;
    }

    const projectileParams: CreateProjectileParams = {
      sourceId: attackerId,
      targetId,
      attackType: AttackType.MAGIC,
      damage,
      currentTick,
      sourcePosition: projectileSourcePosition,
      targetPosition: projectileTargetPosition,
      spellId: spell.id,
      xpReward: spell.baseXp,
      runeCustody: runeDebit.custody ?? undefined,
    };

    const projectile = this.ctx.projectileService.createReservedProjectile(
      projectileReservation,
      projectileParams,
    );
    if (!projectile) {
      this.ctx.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      if (runeDebit.custody) {
        await this.ctx.inventorySystem?.cancelProjectileRuneCostAtomic(
          runeDebit.custody,
        );
      }
      console.error(
        `[MagicAttackHandler] Reserved projectile admission failed after staged spell debit for ${attackerId}`,
      );
      return;
    }
    if (runeDebit.custody && this.ctx.inventorySystem) {
      const scheduledHitTick = projectile.hitsAtTick;
      projectile.hitsAtTick = Number.POSITIVE_INFINITY;
      const settlement =
        await this.ctx.inventorySystem.completeProjectileRuneCostAtomic(
          runeDebit.custody,
        );
      if (!settlement.ok || settlement.status !== "fired") {
        this.ctx.projectileService.cancelProjectile(projectile.id);
        return;
      }
      projectile.hitsAtTick = Math.max(scheduledHitTick, currentTick + 1);
    }

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

    this.emitMagicProjectile(
      attackerId,
      targetId,
      spell,
      attackerPos,
      targetPos,
      distance,
      projectile.id,
    );

    // Enter combat (cooldown already claimed above before async work)
    const typedTargetId = createEntityID(targetId);
    this.ctx.enterCombat(
      typedAttackerId,
      typedTargetId,
      attackSpeedTicks,
      AttackType.MAGIC,
    );
  }

  /**
   * Get player's selected autocast spell
   */
  private getPlayerSelectedSpell(playerId: string): string | null {
    // Use world.getPlayer() to ensure we get the same player entity as PlayerSystem
    const playerEntity = this.ctx.world.getPlayer?.(playerId);
    if (!playerEntity?.data) return null;

    return (
      (playerEntity.data as { selectedSpell?: string }).selectedSpell ?? null
    );
  }

  /**
   * Get player inventory items for rune checking
   */
  private getPlayerInventoryItems(
    playerId: string,
  ): Array<{ itemId: string; quantity: number; slot: number }> {
    if (!this.ctx.inventorySystem) return [];

    const inventory = this.ctx.inventorySystem.getInventory(playerId);
    if (!inventory?.items) return [];

    return inventory.items
      .filter((item) => item.itemId)
      .map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity ?? 1,
        slot: item.slot,
      }));
  }

  /**
   * Consume runes for spell cast
   */
  private async consumeRunesForSpell(
    playerId: string,
    spell: Spell,
    weapon: Item | null,
    operationId: string,
  ): Promise<
    | { ok: true; custody: ProjectileRuneCostSettlementHandle | null }
    | { ok: false; reason: string }
  > {
    if (!this.ctx.inventorySystem) {
      return { ok: false, reason: "atomic_persistence_unavailable" };
    }

    const runesToConsume = runeService.getRunesToConsume(spell.runes, weapon);
    if (runesToConsume.length === 0) return { ok: true, custody: null };
    const receipt =
      await this.ctx.inventorySystem.stageProjectileRuneCostAtomic(
        playerId,
        operationId,
        runesToConsume.map((requirement) => ({
          itemId: requirement.runeId,
          quantity: requirement.quantity,
        })),
      );
    return receipt.ok
      ? {
          ok: true,
          custody: {
            operationId: receipt.operationId,
            playerId: receipt.playerId,
            requestFingerprint: receipt.requestFingerprint,
            requirements: receipt.requirements,
          },
        }
      : { ok: false, reason: receipt.reason };
  }

  /**
   * Calculate magic damage for a player attack.
   * Shares the pre-allocated _magicParams with calculateMobMagicDamage —
   * both use the same formula via calculateMagicDamage() but this path
   * includes equipment bonuses, combat style, and prayer.
   */
  private calculatePlayerMagicDamage(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    attackerId: string,
    targetType: "player" | "mob",
    spell: Spell,
  ): number {
    const magicLevel = this.ctx.getPlayerSkillLevel(attackerId, "magic");
    const equipmentStats = this.ctx.playerEquipmentStats.get(attackerId);

    // Get target stats
    const targetMagicLevel =
      targetType === "mob" && isMobEntity(target)
        ? 1 // Most F2P mobs have 1 magic
        : this.ctx.getPlayerSkillLevel(String(target.id), "magic");

    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.ctx.getPlayerSkillLevel(String(target.id), "defense");

    const targetMagicDefense =
      targetType === "mob" && isMobEntity(target)
        ? 0
        : (this.ctx.playerEquipmentStats.get(String(target.id))?.magicDefense ??
          0);

    // Get prayer bonuses
    const prayerSystem = this.ctx.prayerSystem;
    const attackerPrayer = prayerSystem?.getCombinedBonuses(attackerId);
    const defenderPrayer =
      targetType === "player"
        ? prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    // Get player's combat style for rules-accurate damage bonuses
    let magicStyle: MagicCombatStyle = "accurate";
    const styleData = this.ctx.playerSystem?.getPlayerAttackStyle?.(attackerId);
    if (styleData?.id) {
      const id = styleData.id;
      if (id === "accurate" || id === "longrange" || id === "autocast") {
        magicStyle = id;
      }
    }

    // Mutate pre-allocated params in-place (zero GC).
    // SAFETY: This object is shared between mob and player paths. Do NOT add
    // await between here and calculateMagicDamage() — async interleaving would
    // corrupt the shared state.
    const p = this._magicParams;
    p.magicLevel = magicLevel;
    p.magicAttackBonus = equipmentStats?.magicAttack ?? 0;
    p.style = magicStyle;
    p.spellBaseMaxHit = spell.baseMaxHit;
    // MagicDamageParams uses "npc" instead of "mob"
    p.targetType = targetType === "mob" ? "npc" : "player";
    p.targetMagicLevel = targetMagicLevel;
    p.targetDefenseLevel = targetDefenseLevel;
    p.targetMagicDefenseBonus = targetMagicDefense;
    p.prayerBonuses = attackerPrayer;
    p.targetPrayerBonuses = defenderPrayer;

    const result = calculateMagicDamage(p, getGameRng());
    return result.damage;
  }
}
