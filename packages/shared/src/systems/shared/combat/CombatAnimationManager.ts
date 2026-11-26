/**
 * CombatAnimationManager - Combat emotes and animations
 *
 * Single Responsibility: Manage combat animations and emote timing
 * Handles setting attack emotes and scheduling tick-aligned resets.
 */

import type { World } from "../../../core/World";
import { Emotes } from "../../../data/playerEmotes";
import { getNPCById } from "../../../data/npcs";
import { hasServerEmote, isEquipmentSystem } from "../../../utils/typeGuards";
import { Logger } from "../../../utils/Logger";
import { DeathState } from "../../../types/entities/entities";

const DEBUG_COMBAT_ANIMATION =
  typeof process !== "undefined" &&
  process.env?.DEBUG_COMBAT_ANIMATION === "true";

/**
 * Interface for player entity properties accessed for emote management
 */
interface AnimatablePlayerEntity {
  emote?: string;
  data?: {
    e?: string; // emote (abbreviated for network)
  };
  combat?: {
    combatTarget: string | null;
  };
  markNetworkDirty?: () => void;
}

/**
 * Data for scheduled emote reset
 */
interface EmoteResetData {
  tick: number;
  entityType: "player" | "mob";
}

/**
 * One-shot combat clips must return to a looping stance when their visible
 * motion ends, not clamp on the final strike pose until the next cooldown.
 * Standard melee/ranged clips are one second; spell casting is two seconds.
 */
export function getCombatEmoteResetDelayTicks(
  combatEmote: string | undefined,
  attackSpeedTicks: number,
): number {
  const clipTicks = combatEmote === "spell_cast" ? 3 : 2;
  const beforeNextAttack = Math.max(2, attackSpeedTicks - 1);
  return Math.min(clipTicks, beforeNextAttack);
}

export class CombatAnimationManager {
  private world: World;
  private emoteResetTicks = new Map<string, EmoteResetData>();

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Set combat emote for an entity and schedule reset
   * @param entityId - Entity to animate
   * @param entityType - Whether entity is player or mob
   * @param currentTick - Current game tick for scheduling reset
   * @param attackSpeedTicks - Attack speed in ticks (default 4 = 2.4s)
   */
  setCombatEmote(
    entityId: string,
    entityType: "player" | "mob",
    currentTick: number,
    attackSpeedTicks: number = 4,
    attackType?: "melee" | "ranged" | "magic",
  ): void {
    let combatEmote: string | undefined;
    if (entityType === "player") {
      combatEmote = this.setPlayerCombatEmote(entityId);
    } else {
      this.setMobCombatEmote(entityId, attackType);
    }

    const resetTick =
      currentTick +
      getCombatEmoteResetDelayTicks(combatEmote, attackSpeedTicks);
    this.emoteResetTicks.set(entityId, {
      tick: resetTick,
      entityType,
    });
  }

  /**
   * Process scheduled emote resets for this tick
   * Called by CombatSystem.processCombatTick()
   */
  processEmoteResets(currentTick: number): void {
    for (const [entityId, resetData] of this.emoteResetTicks.entries()) {
      if (currentTick >= resetData.tick) {
        this.resetEmote(entityId, resetData.entityType);
        this.emoteResetTicks.delete(entityId);
      }
    }
  }

  /**
   * Process emote reset for a specific entity
   *
   * RULES-ACCURATE: Called by GameTickProcessor during per-entity processing
   * This allows emote resets to be processed per-entity rather than globally.
   *
   * @param entityId - The entity to check for emote reset
   * @param currentTick - Current tick number
   */
  processEntityEmoteReset(entityId: string, currentTick: number): void {
    const resetData = this.emoteResetTicks.get(entityId);
    if (resetData && currentTick >= resetData.tick) {
      this.resetEmote(entityId, resetData.entityType);
      this.emoteResetTicks.delete(entityId);
    }
  }

  /**
   * Cancel any pending emote reset for an entity
   * Used when entity dies or disconnects
   */
  cancelEmoteReset(entityId: string): void {
    this.emoteResetTicks.delete(entityId);
  }

  /**
   * Get pending emote reset data (for migration from CombatSystem)
   */
  getEmoteResetTicks(): Map<string, EmoteResetData> {
    return this.emoteResetTicks;
  }

  /**
   * Set emote reset data (for migration from CombatSystem)
   */
  setEmoteResetData(entityId: string, data: EmoteResetData): void {
    this.emoteResetTicks.set(entityId, data);
  }

  /**
   * Set combat emote for a player entity
   */
  private setPlayerCombatEmote(entityId: string): string | undefined {
    const playerEntity = this.world.getPlayer?.(
      entityId,
    ) as AnimatablePlayerEntity | null;

    if (!playerEntity) return undefined;

    // Determine emote based on equipped weapon
    let combatEmote = "combat"; // Default to punching

    // Get equipment from EquipmentSystem (source of truth)
    const equipmentSystem = this.world.getSystem("equipment");

    if (isEquipmentSystem(equipmentSystem)) {
      const equipment = equipmentSystem.getPlayerEquipment(entityId);

      // Check if player has a spell selected (autocast or manual cast)
      const selectedSpell = (
        playerEntity as { data?: { selectedSpell?: string } }
      )?.data?.selectedSpell;

      if (equipment?.weapon?.item) {
        const weaponItem = equipment.weapon.item;
        // Normalize to lowercase for comparison (JSON may have uppercase values)
        const weaponType =
          weaponItem.weaponType?.toLowerCase?.() ?? weaponItem.weaponType;
        const attackType =
          weaponItem.attackType?.toLowerCase?.() ?? weaponItem.attackType;

        const isMagicWeapon =
          attackType === "magic" ||
          weaponType === "staff" ||
          weaponType === "wand";

        if (isMagicWeapon && selectedSpell) {
          // rules-accurate: Magic weapons with autocast use spell cast animation
          combatEmote = "spell_cast";
        } else if (isMagicWeapon) {
          // rules-accurate: Magic weapons WITHOUT autocast use melee bonk (crush)
          // Staffs default to punching/combat animation when no spell selected
          combatEmote = "combat";
        } else if (weaponType === "two_hand_sword") {
          combatEmote = "2h_slash";
        } else if (
          weaponType === "sword" ||
          weaponType === "dagger" ||
          weaponType === "longsword" ||
          weaponType === "scimitar" ||
          weaponType === "axe" ||
          weaponType === "mace" ||
          weaponType === "spear" ||
          weaponType === "halberd" ||
          attackType === "melee"
        ) {
          combatEmote = "sword_swing";
        } else if (
          weaponType === "bow" ||
          weaponType === "crossbow" ||
          attackType === "ranged"
        ) {
          combatEmote = "range";
        }
      } else {
        // No weapon equipped - check if player has a spell selected (unarmed casting)
        if (selectedSpell) {
          combatEmote = "spell_cast";
        }
      }
    }

    // Set emote string key
    if (playerEntity.emote !== undefined) {
      playerEntity.emote = combatEmote;
    }
    if (playerEntity.data) {
      playerEntity.data.e = combatEmote;
    }

    // Send immediate network update BEFORE damage is applied
    // This ensures emote update arrives at clients BEFORE any death events
    if (this.world.isServer && this.world.network?.send) {
      this.world.network.send("entityModified", {
        id: entityId,
        e: combatEmote,
        c: true, // Send inCombat state immediately
        ct: playerEntity.combat?.combatTarget || null,
      });
    }

    playerEntity.markNetworkDirty?.();
    return combatEmote;
  }

  /**
   * Set combat emote for a mob entity
   */
  private setMobCombatEmote(
    entityId: string,
    attackType?: "melee" | "ranged" | "magic",
  ): void {
    // For mobs, send one-shot combat animation via setServerEmote()
    // Client returns to AI-state-based animation after
    const mobEntity = this.world.entities.get(entityId);

    if (hasServerEmote(mobEntity)) {
      // Pick emote based on attack type
      let emote = Emotes.COMBAT;
      if (attackType === "magic") {
        emote = Emotes.SPELL_CAST;
      } else if (attackType === "ranged") {
        emote = Emotes.RANGE;
      } else {
        // Melee: check if mob has a held weapon → use sword swing instead of punch
        const entity = mobEntity as { getProperty?: (key: string) => unknown };
        const mobType = entity.getProperty?.("mobType") as string | undefined;
        if (mobType) {
          const npcData = getNPCById(mobType);
          if (npcData?.appearance.heldWeaponModel) {
            emote = Emotes.SWORD_SWING;
          }
        }
      }
      mobEntity.setServerEmote(emote);
    }
  }

  /**
   * Reset entity emote to idle
   * Called internally by processEmoteResets and externally by CombatSystem
   * when combat ends or entity dies
   */
  resetEmote(entityId: string, entityType: "player" | "mob"): void {
    if (entityType === "player") {
      const playerEntity = this.world.getPlayer?.(
        entityId,
      ) as AnimatablePlayerEntity | null;

      if (playerEntity) {
        // CRITICAL: Check if player is dead - don't reset death animation!
        const deathState = (
          playerEntity.data as { deathState?: DeathState } | undefined
        )?.deathState;
        if (deathState === DeathState.DYING || deathState === DeathState.DEAD) {
          if (DEBUG_COMBAT_ANIMATION) {
            Logger.system(
              "CombatAnimationManager",
              `Skipping resetEmote for dead player ${entityId} (deathState=${deathState})`,
            );
          }
          return;
        }

        if (DEBUG_COMBAT_ANIMATION) {
          Logger.system(
            "CombatAnimationManager",
            `resetEmote for player ${entityId}, current emote: ${playerEntity.data?.e}`,
          );
        }

        // Determine idle emote based on equipped weapon (2h weapons use 2h_idle)
        let idleEmote = "idle";
        const equipmentSystem = this.world.getSystem("equipment");
        if (isEquipmentSystem(equipmentSystem)) {
          const equipment = equipmentSystem.getPlayerEquipment(entityId);
          if (equipment?.weapon?.item) {
            const weaponType =
              equipment.weapon.item.weaponType?.toLowerCase?.() ??
              equipment.weapon.item.weaponType;
            if (weaponType === "two_hand_sword") {
              idleEmote = "2h_idle";
            }
          }
        }

        // Reset to idle string key
        if (playerEntity.emote !== undefined) {
          playerEntity.emote = idleEmote;
        }
        if (playerEntity.data) {
          playerEntity.data.e = idleEmote;
        }

        // Send immediate network update
        // NOTE: Don't send c: false - combat may still be active
        if (this.world.isServer && this.world.network?.send) {
          this.world.network.send("entityModified", {
            id: entityId,
            e: idleEmote,
          });
        }

        playerEntity.markNetworkDirty?.();
      }
    }
    // DON'T reset mob emotes - let client's AI-state-based animation handle it
  }

  /**
   * Clear all pending resets
   */
  destroy(): void {
    this.emoteResetTicks.clear();
  }
}
