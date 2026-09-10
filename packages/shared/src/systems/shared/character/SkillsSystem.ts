/**
 * SkillsSystem.ts - Skills, XP, and Leveling System
 *
 * Implements classic fantasy MMORPG-style skill progression system with experience points and levels.
 *
 * **Skills Managed:**
 * - Combat: attack, strength, defense, constitution, ranged
 * - Gathering: woodcutting, fishing
 * - Artisan: firemaking, cooking
 *
 * **XP Calculation:**
 * Uses classic fantasy MMORPG XP table formula:
 * - Level 1-99 (max level)
 * - XP for level N = floor(N + 300 * 2^(N/7)) / 4
 * - Example: Level 50 requires 101,333 XP
 *
 * **Combat Level:**
 * Calculated from combat skills:
 * - Base = 0.25 * (Defense + Constitution + Ranged/2)
 * - Melee = 0.325 * (Attack + Strength)
 * - Ranged = 0.325 * (Ranged * 1.5)
 * - Combat Level = floor(Base + max(Melee, Ranged))
 *
 * **Features:**
 * - Automatic level-up detection
 * - XP multipliers for special conditions
 * - Skill milestones (level 50, 99, etc.)
 * - XP drop tracking for visual feedback
 * - Total level calculation (sum of all skill levels)
 *
 * **Referenced by:** CombatSystem, ResourceSystem, ProcessingSystem, all skill-based interactions
 */

import { Entity } from "../../../entities/Entity";
import { SkillData, Skills } from "../../../types/core/core";
import { StatsComponent } from "../../../components/StatsComponent";
import { EventType } from "../../../types/events";
import type {
  DuelCombatProgressCommittedPayload,
  QuestCompletionCommittedPayload,
  SkillsProgressCommittedPayload,
} from "../../../types/events";
import type { World } from "../../../types/index";
import { SystemBase } from "../infrastructure/SystemBase";
import {
  getStatsComponent,
  requireStatsComponent,
} from "../../../utils/game/ComponentUtils";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import { Logger } from "../../../utils/Logger";
import type {
  MobCombatProgressReceipt,
  MobCombatProgressSkill,
} from "../../../types/network/database";

/** Skill name constants for type-safe skill references */
export const Skill = {
  ATTACK: "attack" as keyof Skills,
  STRENGTH: "strength" as keyof Skills,
  DEFENSE: "defense" as keyof Skills,
  RANGE: "ranged" as keyof Skills,
  MAGIC: "magic" as keyof Skills,
  CONSTITUTION: "constitution" as keyof Skills,
  PRAYER: "prayer" as keyof Skills,
  WOODCUTTING: "woodcutting" as keyof Skills,
  MINING: "mining" as keyof Skills,
  FISHING: "fishing" as keyof Skills,
  FIREMAKING: "firemaking" as keyof Skills,
  COOKING: "cooking" as keyof Skills,
  SMITHING: "smithing" as keyof Skills,
  AGILITY: "agility" as keyof Skills,
  CRAFTING: "crafting" as keyof Skills,
  FLETCHING: "fletching" as keyof Skills,
  RUNECRAFTING: "runecrafting" as keyof Skills,
};
const COMMITTED_CUSTODY_SKILLS = new Set<keyof Skills>([
  Skill.ATTACK,
  Skill.STRENGTH,
  Skill.DEFENSE,
  Skill.CONSTITUTION,
  Skill.RANGE,
  Skill.MAGIC,
  Skill.WOODCUTTING,
  Skill.MINING,
  Skill.FISHING,
  Skill.FIREMAKING,
  Skill.COOKING,
  Skill.SMITHING,
  Skill.AGILITY,
  Skill.CRAFTING,
  Skill.FLETCHING,
  Skill.RUNECRAFTING,
]);

import type {
  SkillMilestone,
  XPDrop,
} from "../../../types/systems/system-interfaces";

/**
 * SkillsSystem - Experience and Level Management
 *
 * Manages skill progression, XP grants, level-ups, and combat level calculation.
 */
export class SkillsSystem extends SystemBase {
  private static readonly MAX_LEVEL = 99;
  private static readonly MAX_XP = 200_000_000; // 200M XP cap
  private static readonly COMBAT_SKILLS: (keyof Skills)[] = [
    Skill.ATTACK,
    Skill.STRENGTH,
    Skill.DEFENSE,
    Skill.RANGE,
  ];

  private xpTable: number[] = [];
  private xpDrops: XPDrop[] = [];
  private skillMilestones: Map<keyof Skills, SkillMilestone[]> = new Map();
  private readonly presentedMobCombatOperations = new Set<string>();
  private readonly presentedCommittedProgressOperations = new Set<string>();

  constructor(world: World) {
    super(world, {
      name: "skills",
      dependencies: {
        optional: ["combat", "ui", "quest"],
      },
      autoCleanup: true,
    });
    this.generateXPTable();
    this.setupSkillMilestones();
  }

  async init(): Promise<void> {
    // Subscribe to skill events using type-safe event system
    this.subscribe<{
      attackerId: string;
      targetId: string;
      damageDealt: number;
      attackStyle: string;
    }>(EventType.COMBAT_KILL, (data) => this.handleCombatKill(data));
    this.subscribe<{
      playerId: string;
      lootOperationId: string;
      replayed: boolean;
      combatProgress: MobCombatProgressReceipt[];
    }>(EventType.MOB_LOOT_COMMITTED, (data) => {
      this.reconcileCommittedMobCombatProgress(data);
    });
    this.subscribe<DuelCombatProgressCommittedPayload>(
      EventType.DUEL_COMBAT_PROGRESS_COMMITTED,
      (data) => this.reconcileCommittedDuelCombatProgress(data),
    );
    this.subscribe<{ entityId: string; skill: keyof Skills; xp: number }>(
      EventType.SKILLS_ACTION,
      (data) => this.handleSkillAction(data),
    );
    this.subscribe<{ playerId: string; skill: keyof Skills; amount: number }>(
      EventType.SKILLS_XP_GAINED,
      (data) => {
        this.handleExternalXPGain(data);
      },
    );
    this.subscribe<SkillsProgressCommittedPayload>(
      EventType.SKILLS_PROGRESS_COMMITTED,
      (data) => this.reconcileCommittedSkillProgression(data),
    );
    this.subscribe<QuestCompletionCommittedPayload>(
      EventType.QUEST_COMPLETION_COMMITTED,
      (data) => this.reconcileCommittedQuestProgression(data),
    );
    this.subscribe(
      EventType.QUEST_COMPLETED,
      (data: {
        playerId: string;
        questId: string;
        rewards: { xp?: Record<keyof Skills, number> };
        progressionCommitted?: boolean;
      }) => {
        this.handleQuestComplete(data);
      },
    );

    // Load skills from database on player registration (mirror InventorySystem pattern)
    this.subscribe(
      EventType.PLAYER_REGISTERED,
      async (data: { playerId: string }) => {
        await this.loadPlayerSkillsFromDatabase(data.playerId);
      },
    );
  }

  private async loadPlayerSkillsFromDatabase(playerId: string): Promise<void> {
    // Only load on server
    if (!this.world.isServer) return;

    const entity = this.world.entities.get(playerId) as Entity;
    if (!entity) return;

    // Get entity's skills from data (already loaded by ServerNetwork)
    const entityData = entity.data as {
      skills?: Record<string, { level: number; xp: number }>;
    };
    if (entityData.skills) {
      // Emit SKILLS_UPDATED so all systems and UI get initial skills
      this.emitTypedEvent(EventType.SKILLS_UPDATED, {
        playerId,
        skills: entityData.skills as unknown as Skills,
        persistence: "already_committed",
      });
    }
  }

  update(_deltaTime: number): void {
    // OPTIMIZATION: Clean up old XP drops in-place to avoid array allocation every frame
    // Uses a write index to shift elements, then truncates the array
    const currentTime = Date.now();
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < this.xpDrops.length; readIndex++) {
      const drop = this.xpDrops[readIndex];
      if (currentTime - drop.timestamp < 3000) {
        // Keep this drop - shift it to writeIndex position
        if (writeIndex !== readIndex) {
          this.xpDrops[writeIndex] = drop;
        }
        writeIndex++;
      }
    }
    // Truncate array to remove expired drops (no allocation)
    this.xpDrops.length = writeIndex;
  }

  /**
   * Add XP internally without emitting events (used by external XP handlers)
   */
  private addXPInternal(
    entityId: string,
    skill: keyof Skills,
    amount: number,
  ): void {
    if (this.rejectNonAtomicPrayerProgression(entityId, skill)) return;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return;
    }
    const entity = this.world.entities.get(entityId) as Entity;
    if (!entity) return;

    const stats = getStatsComponent(entity);
    if (!stats) return;

    const skillData = stats[skill] as SkillData;
    if (!skillData) {
      console.warn(
        `[SkillsSystem] Entity ${entityId} has no skill data for ${skill}`,
      );
      return;
    }

    // Apply XP modifiers (e.g., from equipment, prayers, etc.)
    const modifiedAmount = this.calculateModifiedXP(entity, skill, amount);

    // Check XP cap - ensure oldXP is a valid number (handles undefined/NaN)
    const oldXP = Number.isFinite(skillData.xp) ? skillData.xp : 0;
    const newXP = Math.min(oldXP + modifiedAmount, SkillsSystem.MAX_XP);
    const actualGain = newXP - oldXP;

    // Initialize skill xp if it was invalid
    if (!Number.isFinite(skillData.xp)) {
      skillData.xp = 0;
    }

    if (actualGain <= 0) return;

    // Update XP
    skillData.xp = newXP;

    // Check for level up
    const oldLevel = skillData.level;
    const newLevel = this.getLevelForXP(newXP);

    if (newLevel > oldLevel) {
      this.handleLevelUp(entity, skill, oldLevel, newLevel);
    }

    // Update combat level if it's a combat skill
    if (SkillsSystem.COMBAT_SKILLS.includes(skill as keyof Skills)) {
      this.updateCombatLevel(entity, stats);
    }

    // Update total level
    this.updateTotalLevel(entity, stats);

    // Add XP drop for UI
    this.xpDrops.push({
      entityId,
      playerId: entityId,
      skill,
      amount: actualGain,
      timestamp: Date.now(),
      position: { x: 0, y: 0, z: 0 }, // Position not used for non-visual drops
    });

    // Emit skills updated event for UI (but not XP_GAINED to avoid loops)
    this.emitTypedEvent(EventType.SKILLS_UPDATED, {
      playerId: entityId,
      skills: this.getSkills(entityId) || {},
    });

    // Emit XP drop broadcast for server to send to client (with updated level data)
    const position = entity.position || { x: 0, y: 0, z: 0 };
    this.emitTypedEvent(EventType.XP_DROP_BROADCAST, {
      playerId: entityId,
      skill,
      amount: actualGain,
      newXp: newXP,
      newLevel: skillData.level, // Use updated level after handleLevelUp
      position: { x: position.x, y: position.y, z: position.z },
    });
  }

  /**
   * Grant XP to a specific skill (public API)
   * Routes through event system to maintain consistency
   */
  public grantXP(entityId: string, skill: keyof Skills, amount: number): void {
    if (this.rejectNonAtomicPrayerProgression(entityId, skill)) return;
    // Use event system for consistency with other XP sources
    this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
      playerId: entityId,
      skill,
      amount,
    });
  }

  /**
   * Converge live Prayer skill state on an already committed database result.
   * This deliberately bypasses the ordinary XP path: custody, XP, level, and
   * prayer points were committed together, so emitting another XP mutation or
   * asynchronous point transition would duplicate durable work.
   */
  public reconcileCommittedPrayerProgression(
    entityId: string,
    currentXp: number,
    currentLevel: number,
    awardedXp: number,
    replayed: boolean,
  ): boolean {
    if (
      !entityId ||
      !Number.isSafeInteger(currentXp) ||
      currentXp < 0 ||
      currentXp > SkillsSystem.MAX_XP ||
      !Number.isSafeInteger(currentLevel) ||
      currentLevel < 1 ||
      currentLevel > SkillsSystem.MAX_LEVEL ||
      this.getLevelForXP(currentXp) !== currentLevel ||
      !Number.isSafeInteger(awardedXp) ||
      awardedXp < 0 ||
      awardedXp > 1_000_000
    ) {
      return false;
    }
    const entity = this.world.entities.get(entityId) as Entity | undefined;
    if (!entity) return false;
    const stats = getStatsComponent(entity);
    const prayer = stats?.prayer as SkillData | undefined;
    if (!stats || !prayer) return false;

    const oldLevel = Number.isSafeInteger(prayer.level) ? prayer.level : 1;
    prayer.xp = currentXp;
    prayer.level = currentLevel;
    this.updateCombatLevel(entity, stats);
    this.updateTotalLevel(entity, stats);

    if (!replayed && currentLevel > oldLevel) {
      const milestones = this.skillMilestones.get(Skill.PRAYER) ?? [];
      for (const milestone of milestones) {
        if (milestone.level > oldLevel && milestone.level <= currentLevel) {
          this.emitTypedEvent(EventType.SKILLS_MILESTONE, {
            entityId,
            skill: Skill.PRAYER,
            milestone,
          });
        }
      }
      this.emitTypedEvent(EventType.SKILLS_LEVEL_UP, {
        entityId,
        skill: Skill.PRAYER,
        oldLevel,
        newLevel: currentLevel,
        totalLevel: stats.totalLevel,
      });
    }

    if (!replayed && awardedXp > 0) {
      this.xpDrops.push({
        entityId,
        playerId: entityId,
        skill: Skill.PRAYER,
        amount: awardedXp,
        timestamp: Date.now(),
        position: { x: 0, y: 0, z: 0 },
      });
      const position = entity.position || { x: 0, y: 0, z: 0 };
      this.emitTypedEvent(EventType.XP_DROP_BROADCAST, {
        playerId: entityId,
        skill: Skill.PRAYER,
        amount: awardedXp,
        newXp: currentXp,
        newLevel: currentLevel,
        position: { x: position.x, y: position.y, z: position.z },
      });
    }

    this.emitTypedEvent(EventType.SKILLS_UPDATED, {
      playerId: entityId,
      skills: this.getSkills(entityId) || {},
      persistence: "already_committed",
    });
    return true;
  }

  /**
   * Get the level for a given amount of XP
   */
  public getLevelForXP(xp: number): number {
    for (let level = SkillsSystem.MAX_LEVEL; level >= 1; level--) {
      if (xp >= this.xpTable[level]) {
        return level;
      }
    }
    return 1;
  }

  /**
   * Get the XP required for a specific level
   */
  public getXPForLevel(level: number): number {
    if (level < 1) return 0;
    if (level > SkillsSystem.MAX_LEVEL)
      return this.xpTable[SkillsSystem.MAX_LEVEL];
    return this.xpTable[level];
  }

  /**
   * Get XP remaining to next level
   */
  public getXPToNextLevel(skill: SkillData): number {
    if (skill.level >= SkillsSystem.MAX_LEVEL) return 0;

    const nextLevelXP = this.getXPForLevel(skill.level + 1);
    return nextLevelXP - skill.xp;
  }

  /**
   * Get XP progress percentage to next level
   */
  public getXPProgress(skill: SkillData): number {
    if (skill.level >= SkillsSystem.MAX_LEVEL) return 100;

    const currentLevelXP = this.getXPForLevel(skill.level);
    const nextLevelXP = this.getXPForLevel(skill.level + 1);
    const progressXP = skill.xp - currentLevelXP;
    const requiredXP = nextLevelXP - currentLevelXP;

    return (progressXP / requiredXP) * 100;
  }

  /**
   * Check if entity meets skill requirements
   */
  public meetsRequirements(
    entity: Entity,
    requirements: Partial<Record<keyof Skills, number>>,
  ): boolean {
    const stats = getStatsComponent(entity);
    if (!stats) return false;

    for (const [skill, requiredLevel] of Object.entries(requirements)) {
      const skillData = stats[skill as keyof Skills] as SkillData;
      if (!skillData) return false;
      if (skillData.level < (requiredLevel ?? 0)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get combat level for an entity
   */
  public getCombatLevel(stats: StatsComponent): number {
    // classic fantasy MMORPG combat level formula
    // Extract levels from stats
    const defenseLevel = stats.defense?.level ?? 1;
    const hitpointsLevel = stats.constitution?.level ?? 10;
    const prayerLevel = stats.prayer?.level ?? 1;
    const attackLevel = stats.attack?.level ?? 1;
    const strengthLevel = stats.strength?.level ?? 1;
    const rangedLevel = stats.ranged?.level ?? 1;
    const magicLevel = stats.magic?.level ?? 1;

    const base =
      0.25 * (defenseLevel + hitpointsLevel + Math.floor(prayerLevel / 2));

    const melee = 0.325 * (attackLevel + strengthLevel);
    const rangedCalc = 0.325 * Math.floor(rangedLevel * 1.5);
    const magicCalc = 0.325 * Math.floor(magicLevel * 1.5);

    return Math.floor(base + Math.max(melee, rangedCalc, magicCalc));
  }

  /**
   * Get total level (sum of all skill levels)
   */
  public getTotalLevel(stats: StatsComponent): number {
    let total = 0;

    // Sum all skill levels
    const skills: (keyof Skills)[] = [
      Skill.ATTACK,
      Skill.STRENGTH,
      Skill.DEFENSE,
      Skill.RANGE,
      Skill.MAGIC,
      Skill.CONSTITUTION,
      Skill.PRAYER,
      Skill.WOODCUTTING,
      Skill.MINING,
      Skill.FISHING,
      Skill.FIREMAKING,
      Skill.COOKING,
      Skill.SMITHING,
      Skill.AGILITY,
      Skill.CRAFTING,
      Skill.FLETCHING,
      Skill.RUNECRAFTING,
    ];

    for (const skill of skills) {
      const skillData = stats[skill] as SkillData;
      total += skillData.level;
    }

    return total;
  }

  /**
   * Get total XP across all skills
   */
  public getTotalXP(stats: StatsComponent): number {
    let total = 0;

    const skills: (keyof Skills)[] = [
      Skill.ATTACK,
      Skill.STRENGTH,
      Skill.DEFENSE,
      Skill.RANGE,
      Skill.MAGIC,
      Skill.CONSTITUTION,
      Skill.PRAYER,
      Skill.WOODCUTTING,
      Skill.MINING,
      Skill.FISHING,
      Skill.FIREMAKING,
      Skill.COOKING,
      Skill.SMITHING,
      Skill.AGILITY,
      Skill.CRAFTING,
      Skill.FLETCHING,
      Skill.RUNECRAFTING,
    ];

    for (const skill of skills) {
      const skillData = stats[skill] as SkillData;
      total += skillData.xp;
    }

    return total;
  }

  /**
   * Reset a skill to level 1
   */
  public resetSkill(entityId: string, skill: keyof Skills): void {
    if (this.rejectNonAtomicPrayerProgression(entityId, skill)) return;
    const entity = this.world.entities.get(entityId) as Entity;
    if (!entity) return;

    const stats = getStatsComponent(entity);
    if (!stats) {
      console.warn(
        `[SkillsSystem] Entity ${entityId} has no stats component. Available components:`,
        Array.from(entity.components.keys()),
      );
      return;
    }

    const skillData = stats[skill] as SkillData;
    if (!skillData) {
      console.warn(
        `[SkillsSystem] Entity ${entityId} has no skill data for ${skill}. Stats component:`,
        stats,
      );
      return;
    }

    skillData.level = 1;
    skillData.xp = 0;

    // Update combat level if needed
    if (SkillsSystem.COMBAT_SKILLS.includes(skill as keyof Skills)) {
      this.updateCombatLevel(entity, stats);
    }

    this.updateTotalLevel(entity, stats);

    this.emitTypedEvent(EventType.SKILLS_RESET, {
      entityId,
      skill,
    });
  }

  /**
   * Set skill level directly (for admin commands)
   */
  public setSkillLevel(
    entityId: string,
    skill: keyof Skills,
    level: number,
  ): void {
    if (this.rejectNonAtomicPrayerProgression(entityId, skill)) return;
    if (level < 1 || level > SkillsSystem.MAX_LEVEL) {
      console.warn(`Invalid level ${level} for skill ${skill}`);
      return;
    }

    const entity = this.world.entities.get(entityId) as Entity;
    if (!entity) return;

    const stats = getStatsComponent(entity);
    if (!stats) {
      console.warn(
        `[SkillsSystem] Entity ${entityId} has no stats component. Available components:`,
        Array.from(entity.components.keys()),
      );
      return;
    }

    const skillData = stats[skill] as SkillData;
    if (!skillData) {
      console.warn(
        `[SkillsSystem] Entity ${entityId} has no skill data for ${skill}. Stats component:`,
        stats,
      );
      return;
    }

    const oldLevel = skillData.level;
    skillData.level = level;
    skillData.xp = this.getXPForLevel(level);

    if (level > oldLevel) {
      this.handleLevelUp(entity, skill, oldLevel, level);
    }

    // Update combat level if needed
    if (SkillsSystem.COMBAT_SKILLS.includes(skill as keyof Skills)) {
      this.updateCombatLevel(entity, stats);
    }

    this.updateTotalLevel(entity, stats);
  }

  private generateXPTable(): void {
    this.xpTable = [0, 0]; // Levels 0 and 1

    for (let level = 2; level <= SkillsSystem.MAX_LEVEL; level++) {
      const xp = Math.floor(level - 1 + 300 * Math.pow(2, (level - 1) / 7)) / 4;
      this.xpTable.push(Math.floor(this.xpTable[level - 1] + xp));
    }
  }

  private setupSkillMilestones(): void {
    // Define special milestones for each skill
    const commonMilestones: SkillMilestone[] = [
      {
        level: 50,
        name: "Halfway",
        message: "Halfway to mastery!",
        reward: null,
      },
      {
        level: 92,
        name: "Half XP",
        message: "Halfway to 99 in XP!",
        reward: null,
      },
      { level: 99, name: "Mastery", message: "Skill mastered!", reward: null },
    ];

    // Apply common milestones to all skills
    const skills: (keyof Skills)[] = [
      Skill.ATTACK,
      Skill.STRENGTH,
      Skill.DEFENSE,
      Skill.RANGE,
      Skill.MAGIC,
      Skill.CONSTITUTION,
      Skill.PRAYER,
      Skill.WOODCUTTING,
      Skill.MINING,
      Skill.FISHING,
      Skill.FIREMAKING,
      Skill.COOKING,
      Skill.SMITHING,
      Skill.AGILITY,
      Skill.CRAFTING,
      Skill.FLETCHING,
      Skill.RUNECRAFTING,
    ];

    for (const skill of skills) {
      this.skillMilestones.set(skill, [...commonMilestones]);
    }

    // Add skill-specific milestones
    const combatMilestones = this.skillMilestones.get(Skill.ATTACK)!;
    combatMilestones.push(
      {
        level: 40,
        name: "Rune Weapons",
        message: "You can now wield rune weapons!",
        reward: null,
      },
      {
        level: 60,
        name: "Dragon Weapons",
        message: "You can now wield dragon weapons!",
        reward: null,
      },
    );
  }

  private rejectNonAtomicPrayerProgression(
    entityId: string,
    skill: keyof Skills,
  ): boolean {
    if (skill !== Skill.PRAYER) return false;
    Logger.systemWarn(
      "SkillsSystem",
      `Rejected non-atomic Prayer progression for ${entityId}`,
      { entityId },
    );
    return true;
  }

  private handleLevelUp(
    entity: Entity,
    skill: keyof Skills,
    oldLevel: number,
    newLevel: number,
  ): void {
    // This method is only called after verifying stats exists in grantXP and setSkillLevel
    const stats = requireStatsComponent(entity, "SkillsSystem.handleLevelUp");

    const skillData = stats[skill] as SkillData;
    if (!skillData) {
      console.warn(
        `[SkillsSystem] Entity ${entity.id} has no skill data for ${skill} in handleLevelUp. Stats component:`,
        stats,
      );
      return;
    }

    skillData.level = newLevel;

    // Check for milestones
    const milestones = this.skillMilestones.get(skill) ?? [];
    for (const milestone of milestones) {
      if (milestone.level > oldLevel && milestone.level <= newLevel) {
        this.emitTypedEvent(EventType.SKILLS_MILESTONE, {
          entityId: entity.id,
          skill,
          milestone,
        });
      }
    }

    // Special handling for HP level up
    if (skill === Skill.CONSTITUTION) {
      // Update hitpoints max
      const newMax = this.calculateMaxHitpoints(newLevel);
      stats.health.max = newMax;
      // If current HP is higher than new max, cap it (floor for integer health)
      stats.health.current = Math.floor(Math.min(stats.health.current, newMax));
    }

    this.emitTypedEvent(EventType.SKILLS_LEVEL_UP, {
      entityId: entity.id,
      skill,
      oldLevel,
      newLevel,
      totalLevel: stats.totalLevel,
    });
  }

  private calculateMaxHitpoints(level: number): number {
    // classic fantasy MMORPG formula: 10 + level
    return 10 + level;
  }

  private updateCombatLevel(entity: Entity, stats: StatsComponent): void {
    const oldCombatLevel = stats.combatLevel;
    const newCombatLevel = this.getCombatLevel(stats);

    if (newCombatLevel !== oldCombatLevel) {
      stats.combatLevel = newCombatLevel;

      this.emitTypedEvent(EventType.COMBAT_LEVEL_CHANGED, {
        entityId: entity.id,
        oldLevel: oldCombatLevel,
        newLevel: newCombatLevel,
      });
    }
  }

  private updateTotalLevel(entity: Entity, stats: StatsComponent): void {
    const oldTotalLevel = stats.totalLevel;
    const newTotalLevel = this.getTotalLevel(stats);

    if (newTotalLevel !== oldTotalLevel) {
      stats.totalLevel = newTotalLevel;

      this.emitTypedEvent(EventType.TOTAL_LEVEL_CHANGED, {
        entityId: entity.id,
        oldLevel: oldTotalLevel,
        newLevel: newTotalLevel,
      });
    }
  }

  private calculateModifiedXP(
    entity: Entity,
    skill: keyof Skills,
    baseXP: number,
  ): number {
    const modifier = 1.0;

    // Note: inventory component access reserved for future XP bonus calculations

    const modified = baseXP * modifier;
    return Number.isFinite(modified) && modified > 0 ? modified : 0;
  }

  // Event handlers
  private handleCombatKill(data: {
    attackerId: string;
    targetId: string;
    damageDealt: number;
    attackStyle: string;
  }): void {
    const { attackerId, targetId, damageDealt, attackStyle } = data;

    const target = this.world.entities.get(targetId) as Entity;
    if (!target) return;

    const targetStats = getStatsComponent(target);
    if (!targetStats) return;

    // classic MMORPG Formula: 4 XP per damage for combat skills, 1.33 XP per damage for Hitpoints
    // Use damageDealt (total damage by this player) or fallback to mob's max HP
    const totalDamage =
      damageDealt > 0 ? damageDealt : (targetStats.health?.max ?? 10);
    const combatSkillXP =
      totalDamage * COMBAT_CONSTANTS.XP.COMBAT_XP_PER_DAMAGE;
    const hitpointsXP =
      totalDamage * COMBAT_CONSTANTS.XP.HITPOINTS_XP_PER_DAMAGE;

    // Grant combat skill XP based on attack style
    // Each style trains ONE skill exclusively (except controlled)
    switch (attackStyle) {
      case "accurate":
        // Train Attack only
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.ATTACK,
          amount: combatSkillXP,
        });
        break;

      case "aggressive":
        // Train Strength only
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.STRENGTH,
          amount: combatSkillXP,
        });
        break;

      case "defensive":
        // Train Defense only
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.DEFENSE,
          amount: combatSkillXP,
        });
        break;

      case "controlled": {
        // classic MMORPG: Controlled gives 1.33 XP per damage to each of 4 skills
        // Total: 5.32 XP per damage (vs 5.33 for focused styles)
        const controlledXP =
          totalDamage * COMBAT_CONSTANTS.XP.CONTROLLED_XP_PER_DAMAGE;
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.ATTACK,
          amount: controlledXP,
        });
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.STRENGTH,
          amount: controlledXP,
        });
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.DEFENSE,
          amount: controlledXP,
        });
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.CONSTITUTION,
          amount: controlledXP,
        });
        // Return early - HP already included above, skip separate HP addition
        return;
      }

      case "ranged":
      case "rapid":
      case "longrange":
        // Train Ranged only (all ranged styles)
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.RANGE,
          amount: combatSkillXP,
        });
        break;

      case "magic":
      case "autocast":
        // Train Magic only
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.MAGIC,
          amount: combatSkillXP,
        });
        break;

      default:
        // Unknown style - default to Strength
        console.warn(
          `[SkillsSystem] Unknown attack style: ${attackStyle}, defaulting to Strength`,
        );
        this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
          playerId: attackerId,
          skill: Skill.STRENGTH,
          amount: combatSkillXP,
        });
        break;
    }

    // ALWAYS grant Hitpoints XP (Constitution) for combat - classic MMORPG standard
    this.emitTypedEvent(EventType.SKILLS_XP_GAINED, {
      playerId: attackerId,
      skill: Skill.CONSTITUTION,
      amount: hitpointsXP,
    });
  }

  /**
   * Converge live combat skills on an already committed mob-death receipt.
   * Loot, quest progress, and every returned skill value are durable before
   * this runs, so this path must not emit another XP mutation or database save.
   */
  private reconcileCommittedMobCombatProgress(data: {
    playerId: string;
    lootOperationId: string;
    replayed: boolean;
    combatProgress: MobCombatProgressReceipt[];
  }): void {
    this.reconcileCommittedCombatProgress({
      playerId: data.playerId,
      operationId: data.lootOperationId,
      replayed: data.replayed,
      combatProgress: data.combatProgress,
      receiptKind: "mob",
    });
  }

  private reconcileCommittedDuelCombatProgress(
    data: DuelCombatProgressCommittedPayload,
  ): void {
    this.reconcileCommittedCombatProgress({
      playerId: data.playerId,
      operationId: data.damageOperationId,
      replayed: data.replayed,
      combatProgress: data.combatProgress,
      receiptKind: "duel",
    });
  }

  private reconcileCommittedCombatProgress(data: {
    playerId: string;
    operationId: string;
    replayed: boolean;
    combatProgress: MobCombatProgressReceipt[];
    receiptKind: "mob" | "duel";
  }): void {
    const operationId = String(data.operationId ?? "").trim();
    const playerId = String(data.playerId ?? "").trim();
    const progress = Array.isArray(data.combatProgress)
      ? data.combatProgress
      : [];
    const allowed = new Set<MobCombatProgressSkill>([
      "attack",
      "strength",
      "defense",
      "constitution",
      "ranged",
      "magic",
    ]);
    if (
      !playerId ||
      (data.receiptKind === "mob"
        ? !/^ground-item-mob-loot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            operationId,
          )
        : !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            operationId,
          )) ||
      typeof data.replayed !== "boolean" ||
      progress.length === 0 ||
      progress.length > 4 ||
      new Set(progress.map((entry) => entry.skill)).size !== progress.length ||
      progress.some(
        (entry) =>
          !allowed.has(entry.skill) ||
          !Number.isSafeInteger(entry.xpAmount) ||
          entry.xpAmount <= 0 ||
          entry.xpAmount > 1_000_000 ||
          !Number.isSafeInteger(entry.awardedXp) ||
          entry.awardedXp < 0 ||
          entry.awardedXp > entry.xpAmount ||
          !Number.isSafeInteger(entry.operationCommittedXp) ||
          entry.operationCommittedXp < entry.awardedXp ||
          entry.operationCommittedXp > SkillsSystem.MAX_XP ||
          !Number.isSafeInteger(entry.currentXp) ||
          entry.currentXp < entry.operationCommittedXp ||
          entry.currentXp > SkillsSystem.MAX_XP ||
          !Number.isSafeInteger(entry.currentLevel) ||
          entry.currentLevel < 1 ||
          entry.currentLevel > SkillsSystem.MAX_LEVEL ||
          this.getLevelForXP(entry.currentXp) !== entry.currentLevel,
      )
    ) {
      console.error(
        `[SkillsSystem] Refused invalid committed ${data.receiptKind}-combat receipt ${operationId || "unknown"}`,
      );
      return;
    }

    const entity = this.world.entities.get(playerId) as Entity | undefined;
    const stats = entity ? getStatsComponent(entity) : undefined;
    if (!entity || !stats) return;
    const presentVisual =
      !data.replayed && !this.presentedMobCombatOperations.has(operationId);
    if (!data.replayed) {
      this.presentedMobCombatOperations.add(operationId);
      if (this.presentedMobCombatOperations.size > 4_096) {
        const oldest = this.presentedMobCombatOperations.values().next().value;
        if (oldest) this.presentedMobCombatOperations.delete(oldest);
      }
    }

    const accepted: MobCombatProgressReceipt[] = [];
    for (const entry of progress) {
      const skill = entry.skill as keyof Skills;
      const current = stats[skill] as SkillData | undefined;
      // A delayed older response must never regress a newer live receipt.
      if (!current || entry.currentXp < current.xp) continue;
      const oldLevel = current.level;
      current.xp = entry.currentXp;
      if (presentVisual && entry.currentLevel > oldLevel) {
        this.handleLevelUp(entity, skill, oldLevel, entry.currentLevel);
      } else {
        current.level = entry.currentLevel;
      }
      accepted.push(entry);
    }
    if (accepted.length === 0) return;

    this.updateCombatLevel(entity, stats);
    this.updateTotalLevel(entity, stats);
    for (const entry of accepted) {
      if (!presentVisual || entry.awardedXp <= 0) continue;
      this.xpDrops.push({
        entityId: playerId,
        playerId,
        skill: entry.skill,
        amount: entry.awardedXp,
        timestamp: Date.now(),
        position: { x: 0, y: 0, z: 0 },
      });
      const position = entity.position || { x: 0, y: 0, z: 0 };
      this.emitTypedEvent(EventType.XP_DROP_BROADCAST, {
        playerId,
        skill: entry.skill,
        amount: entry.awardedXp,
        newXp: entry.currentXp,
        newLevel: entry.currentLevel,
        position: { x: position.x, y: position.y, z: position.z },
      });
    }
    this.emitTypedEvent(EventType.SKILLS_UPDATED, {
      playerId,
      skills: this.getSkills(playerId) || {},
      persistence: "already_committed",
    });
  }

  /**
   * Converge one live skill on an exact custody-transaction receipt. Processing
   * and gathering XP may be fractional, so this authority intentionally keeps
   * finite decimal values instead of applying the integer-only combat rules.
   */
  private reconcileCommittedSkillProgression(
    data: Omit<SkillsProgressCommittedPayload, "skill"> & {
      skill: keyof Skills;
    },
  ): void {
    const operationId = String(data.operationId ?? "").trim();
    const playerId = String(data.playerId ?? "").trim();
    const skill = String(data.skill ?? "") as keyof Skills;
    if (
      !playerId ||
      !operationId ||
      operationId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(operationId) ||
      typeof data.replayed !== "boolean" ||
      !COMMITTED_CUSTODY_SKILLS.has(skill) ||
      !Number.isFinite(data.xpAmount) ||
      data.xpAmount <= 0 ||
      data.xpAmount > 1_000_000 ||
      !Number.isFinite(data.awardedXp) ||
      data.awardedXp < 0 ||
      data.awardedXp > data.xpAmount ||
      !Number.isFinite(data.operationCommittedXp) ||
      data.operationCommittedXp < data.awardedXp ||
      data.operationCommittedXp > SkillsSystem.MAX_XP ||
      !Number.isFinite(data.currentXp) ||
      data.currentXp < data.operationCommittedXp ||
      data.currentXp > SkillsSystem.MAX_XP ||
      !Number.isSafeInteger(data.currentLevel) ||
      data.currentLevel < 1 ||
      data.currentLevel > SkillsSystem.MAX_LEVEL ||
      this.getLevelForXP(data.currentXp) !== data.currentLevel
    ) {
      console.error(
        `[SkillsSystem] Refused invalid committed skill receipt ${operationId || "unknown"}`,
      );
      return;
    }

    const entity = this.world.entities.get(playerId) as Entity | undefined;
    const stats = entity ? getStatsComponent(entity) : undefined;
    const current = stats?.[skill] as SkillData | undefined;
    if (!entity || !stats || !current) return;
    if (Number.isFinite(current.xp) && data.currentXp < current.xp) return;

    const presentationKey = `${skill}:${operationId}`;
    const presentVisual =
      !data.replayed &&
      !this.presentedCommittedProgressOperations.has(presentationKey);
    if (!data.replayed) {
      this.presentedCommittedProgressOperations.add(presentationKey);
      if (this.presentedCommittedProgressOperations.size > 4_096) {
        const oldest = this.presentedCommittedProgressOperations
          .values()
          .next().value;
        if (oldest) this.presentedCommittedProgressOperations.delete(oldest);
      }
    }

    const oldLevel = Number.isSafeInteger(current.level) ? current.level : 1;
    current.xp = data.currentXp;
    if (presentVisual && data.currentLevel > oldLevel) {
      this.handleLevelUp(entity, skill, oldLevel, data.currentLevel);
    } else {
      current.level = data.currentLevel;
    }
    if (SkillsSystem.COMBAT_SKILLS.includes(skill)) {
      this.updateCombatLevel(entity, stats);
    }
    this.updateTotalLevel(entity, stats);

    if (presentVisual && data.awardedXp > 0) {
      this.xpDrops.push({
        entityId: playerId,
        playerId,
        skill,
        amount: data.awardedXp,
        timestamp: Date.now(),
        position: { x: 0, y: 0, z: 0 },
      });
      const position = entity.position || { x: 0, y: 0, z: 0 };
      this.emitTypedEvent(EventType.XP_DROP_BROADCAST, {
        playerId,
        skill,
        amount: data.awardedXp,
        newXp: data.currentXp,
        newLevel: data.currentLevel,
        position: { x: position.x, y: position.y, z: position.z },
      });
    }
    this.emitTypedEvent(EventType.SKILLS_UPDATED, {
      playerId,
      skills: this.getSkills(playerId) || {},
      persistence: "already_committed",
    });
  }

  /** Converge every direct skill reward from one committed quest receipt. */
  private reconcileCommittedQuestProgression(
    data: QuestCompletionCommittedPayload,
  ): void {
    const operationId = String(data.operationId ?? "").trim();
    const playerId = String(data.playerId ?? "").trim();
    if (
      !/^quest-completion:[a-f0-9]{64}$/.test(operationId) ||
      !playerId ||
      typeof data.replayed !== "boolean" ||
      !Array.isArray(data.progress) ||
      data.progress.length > 17 ||
      new Set(data.progress.map((entry) => entry.skill)).size !==
        data.progress.length
    ) {
      console.error(
        `[SkillsSystem] Refused invalid committed quest receipt ${operationId || "unknown"}`,
      );
      return;
    }
    for (const entry of data.progress) {
      if (entry.skill === Skill.PRAYER) {
        this.reconcileCommittedPrayerProgression(
          playerId,
          entry.currentXp,
          entry.currentLevel,
          entry.awardedXp,
          data.replayed,
        );
        continue;
      }
      this.reconcileCommittedSkillProgression({
        playerId,
        operationId,
        replayed: data.replayed,
        ...entry,
      });
    }
  }

  private handleSkillAction(data: {
    entityId: string;
    skill: keyof Skills;
    xp: number;
  }): void {
    this.grantXP(data.entityId, data.skill, data.xp);
  }

  private handleExternalXPGain(data: {
    playerId: string;
    skill: keyof Skills;
    amount: number;
  }): void {
    // Handle XP gained from other systems (ResourceSystem, ProcessingSystem, etc.)
    // Use private method to avoid event loop
    this.addXPInternal(data.playerId, data.skill, data.amount);
  }

  private handleQuestComplete(data: {
    playerId: string;
    questId: string;
    progressionCommitted?: boolean;
    rewards: {
      xp?: Record<keyof Skills, number>;
    };
  }): void {
    if (data.progressionCommitted) return;
    if (!data.rewards.xp) return;

    for (const [skill, xp] of Object.entries(data.rewards.xp)) {
      this.grantXP(data.playerId, skill as keyof Skills, xp);
    }
  }

  // Public getters
  public getXPDrops(): XPDrop[] {
    return [...this.xpDrops];
  }

  public getSkillData(
    entityId: string,
    skill: keyof Skills,
  ): SkillData | undefined {
    const entity = this.world.entities.get(entityId) as Entity;
    if (!entity) return undefined;

    const stats = getStatsComponent(entity);
    if (!stats) return undefined;

    return stats[skill] as SkillData;
  }

  public getSkills(entityId: string): Skills | undefined {
    const entity = this.world.entities.get(entityId) as Entity;
    if (!entity) return undefined;

    const stats = getStatsComponent(entity);
    if (!stats) return undefined;

    // Extract only the skill data from stats component
    const skills: Skills = {
      attack: stats.attack ?? { level: 1, xp: 0 },
      strength: stats.strength ?? { level: 1, xp: 0 },
      defense: stats.defense ?? { level: 1, xp: 0 },
      constitution: stats.constitution ?? { level: 1, xp: 0 },
      ranged: stats.ranged ?? { level: 1, xp: 0 },
      magic: stats.magic ?? { level: 1, xp: 0 },
      prayer: stats.prayer ?? { level: 1, xp: 0 },
      woodcutting: stats.woodcutting ?? { level: 1, xp: 0 },
      mining: stats.mining ?? { level: 1, xp: 0 },
      fishing: stats.fishing ?? { level: 1, xp: 0 },
      firemaking: stats.firemaking ?? { level: 1, xp: 0 },
      cooking: stats.cooking ?? { level: 1, xp: 0 },
      smithing: stats.smithing ?? { level: 1, xp: 0 },
      agility: stats.agility ?? { level: 1, xp: 0 },
      crafting: stats.crafting ?? { level: 1, xp: 0 },
      fletching: stats.fletching ?? { level: 1, xp: 0 },
      runecrafting: stats.runecrafting ?? { level: 1, xp: 0 },
    };

    return skills;
  }

  destroy(): void {
    // Clear XP drops for UI
    this.xpDrops.length = 0;

    // Clear skill milestones
    this.skillMilestones.clear();
    this.presentedMobCombatOperations.clear();
    this.presentedCommittedProgressOperations.clear();

    // Clear XP table
    this.xpTable.length = 0;

    // Event cleanup is handled by parent SystemBase destroy method

    // Call parent cleanup
    super.destroy();
  }
}
