/**
 * PlayerInteractionHandler
 *
 * Handles interactions with other players (rules-accurate).
 *
 * Menu order (matches classic MMORPG):
 * 1. Attack PlayerName (Level: XX) - ONLY APPEARS in PvP zones (not shown elsewhere)
 * 2. Trade with PlayerName - disabled until trading implemented
 * 3. Follow PlayerName
 * 4. Report PlayerName
 * 5. Walk here
 * 6. Examine
 *
 * Note: Left-click on players does nothing by default (classic MMORPG behavior).
 * All player interactions require right-click context menu.
 *
 */

import { BaseInteractionHandler } from "./BaseInteractionHandler";
import type { RaycastTarget, ContextMenuAction } from "../types";
import { INTERACTION_RANGE, MESSAGE_TYPES } from "../constants";
import { getCombatLevelColor } from "../utils/combatLevelColor";
import { calculateCombatLevel } from "../../../../utils/game/CombatLevelCalculator";
import type { ZoneDetectionSystem } from "../../../shared/death/ZoneDetectionSystem";
import { isPositionInsideDuelArenaLobby } from "../../../../data/duel-manifest";

export class PlayerInteractionHandler extends BaseInteractionHandler {
  /**
   * Left-click: Attack in active duel only (classic MMORPG behavior)
   *
   * In normal gameplay, players require right-click to interact.
   * Exception: During active duel combat, left-click attacks your opponent.
   */
  onLeftClick(target: RaycastTarget): void {
    // Only allow left-click attack if in active duel with this specific player
    if (this.isInActiveDuelWith(target.entityId)) {
      this.attackPlayer(target);
      return;
    }
    // Otherwise no-op - players need right-click menu
  }

  /**
   * Right-click: Show player interaction options (classic MMORPG order)
   *
   * Combat levels are colored based on relative level difference:
   * - Green: Target is lower level
   * - Yellow: Target is same level
   * - Red: Target is higher level
   */
  getContextMenuActions(target: RaycastTarget): ContextMenuAction[] {
    const actions: ContextMenuAction[] = [];
    const targetLevel = this.getPlayerCombatLevel(target.entityId);
    const localPlayerLevel = this.getLocalPlayerCombatLevel();
    const levelColor = getCombatLevelColor(targetLevel, localPlayerLevel);
    const inPvPZone = this.isInPvPZone();
    const inActiveDuel = this.isInActiveDuelWith(target.entityId);

    // 1. Attack (rules-accurate: only APPEARS in PvP zones OR during active duel)
    if (inPvPZone || inActiveDuel) {
      actions.push({
        id: "attack",
        label: `Attack ${target.name} (Level: ${targetLevel})`,
        styledLabel: [
          { text: "Attack " },
          { text: target.name, color: "#ffffff" },
          { text: " (Level: " },
          { text: `${targetLevel}`, color: levelColor },
          { text: ")" },
        ],
        enabled: true,
        priority: 0,
        handler: () => this.attackPlayer(target),
      });
    }

    // 2. Challenge (Duel Arena only) - Priority 1
    const inDuelArena = this.isInDuelArenaLobby();
    if (inDuelArena) {
      actions.push({
        id: "challenge",
        label: `Challenge ${target.name} (Level: ${targetLevel})`,
        styledLabel: [
          { text: "Challenge " },
          { text: target.name, color: "#ffffff" },
          { text: " (Level: " },
          { text: `${targetLevel}`, color: levelColor },
          { text: ")" },
        ],
        enabled: true,
        priority: 1,
        handler: () => this.challengePlayer(target),
      });
    }

    // 3. Trade with - Priority 2 (includes level for consistency)
    actions.push({
      id: "trade",
      label: `Trade with ${target.name} (Level: ${targetLevel})`,
      styledLabel: [
        { text: "Trade with " },
        { text: target.name, color: "#ffffff" },
        { text: " (Level: " },
        { text: `${targetLevel}`, color: levelColor },
        { text: ")" },
      ],
      enabled: true,
      priority: 2,
      handler: () => this.tradeWithPlayer(target),
    });

    // 5. Follow - Priority 4 (includes level for consistency)
    actions.push({
      id: "follow",
      label: `Follow ${target.name} (Level: ${targetLevel})`,
      styledLabel: [
        { text: "Follow " },
        { text: target.name, color: "#ffffff" },
        { text: " (Level: " },
        { text: `${targetLevel}`, color: levelColor },
        { text: ")" },
      ],
      enabled: true,
      priority: 4,
      handler: () => this.followPlayer(target),
    });

    // 6. Report - Priority 5
    actions.push({
      id: "report",
      label: `Report ${target.name}`,
      enabled: true,
      priority: 5,
      handler: () => this.showExamineMessage("Report system coming soon."),
    });

    // 5. Walk here - Priority 99
    actions.push(this.createWalkHereAction(target));

    // 6. Examine - Priority 100
    actions.push(
      this.createExamineAction(target, `${target.name}, a fellow adventurer.`),
    );

    return actions.sort((a, b) => a.priority - b.priority);
  }

  getActionRange(_actionId: string): number {
    return INTERACTION_RANGE.ADJACENT;
  }

  // === Private Methods ===

  /**
   * Check if the LOCAL player is currently in a PvP-enabled zone.
   */
  private isInPvPZone(): boolean {
    const player = this.getPlayer();
    if (!player) return false;

    const position = player.position;
    if (!position) return false;

    // Use ZoneDetectionSystem
    const zoneSystem = this.world.getSystem("zone-detection");
    if (!zoneSystem) {
      // Fallback: no zone system = safe (conservative)
      return false;
    }

    return zoneSystem.isPvPEnabled({ x: position.x, z: position.z });
  }

  /**
   * Shared lobby eligibility, not the broader facility protection region.
   */
  private isInDuelArenaLobby(): boolean {
    const player = this.getPlayer();
    if (!player) return false;

    const position = player.position;
    if (!position) return false;

    return isPositionInsideDuelArenaLobby(position.x, position.z);
  }

  /**
   * Check if the LOCAL player is in an active duel with the specified target.
   * Active duel means the fight has started (FIGHTING state).
   */
  private isInActiveDuelWith(targetId: string): boolean {
    const activeDuel = (
      this.world as {
        activeDuel?: { duelId: string; arenaId: number; opponentId?: string };
      }
    ).activeDuel;

    if (!activeDuel) return false;

    // If we have opponent ID, verify it matches
    if (activeDuel.opponentId) {
      return activeDuel.opponentId === targetId;
    }

    // If no opponent ID stored, we're in a duel but can't verify opponent
    // Allow attack and let server validate
    return true;
  }

  /**
   * Send attack request to server.
   */
  private attackPlayer(target: RaycastTarget): void {
    // Allow attack if in PvP zone OR in active duel with target
    if (!this.isInPvPZone() && !this.isInActiveDuelWith(target.entityId)) {
      this.showExamineMessage("You can't attack players here.");
      return;
    }

    this.send(MESSAGE_TYPES.ATTACK_PLAYER, {
      targetPlayerId: target.entityId,
    });

    this.addChatMessage(`Attacking ${target.name}...`);
  }

  /**
   * Get target player's combat level.
   * Falls back to 3 (classic MMORPG minimum) if unknown.
   *
   * Checks multiple property paths to handle different player entity types:
   * - PlayerRemote: has `combatLevel` getter
   * - PlayerLocal: stores in `combat.combatLevel` or can be calculated from skills
   */
  private getPlayerCombatLevel(playerId: string): number {
    const playerEntity = this.world.entities?.players?.get(playerId);
    if (!playerEntity) return 3;

    const entity = playerEntity as unknown as Record<string, unknown>;

    // 1. Check direct getter (PlayerRemote - most common for other players)
    if (typeof entity.combatLevel === "number") {
      return entity.combatLevel;
    }

    // 2. Check data object (raw entity data from server sync)
    const data = entity.data as { combatLevel?: number } | undefined;
    if (typeof data?.combatLevel === "number" && data.combatLevel > 1) {
      return data.combatLevel;
    }

    // 3. Calculate from skills (if available)
    const skills = entity.skills as
      Record<string, { level: number }> | undefined;
    if (skills) {
      return calculateCombatLevel({
        attack: skills.attack?.level || 1,
        strength: skills.strength?.level || 1,
        defense: skills.defense?.level || 1,
        hitpoints: skills.constitution?.level || 10,
        ranged: skills.ranged?.level || 1,
        magic: skills.magic?.level || 1,
        prayer: skills.prayer?.level || 1,
      });
    }

    // 4. Check nested combat object (fallback)
    const combat = entity.combat as { combatLevel?: number } | undefined;
    if (typeof combat?.combatLevel === "number" && combat.combatLevel > 1) {
      return combat.combatLevel;
    }

    // Fallback: classic MMORPG minimum combat level
    return 3;
  }

  /**
   * Get local player's combat level.
   * Used for relative color calculation (green/yellow/red).
   * Falls back to 3 (classic MMORPG minimum) if unknown.
   *
   * Checks multiple property paths to handle different player entity types:
   * - PlayerRemote: has `combatLevel` getter
   * - PlayerLocal: stores in `combat.combatLevel` or can be calculated from skills
   */
  private getLocalPlayerCombatLevel(): number {
    const player = this.getPlayer();
    if (!player) return 3;

    const entity = player as unknown as Record<string, unknown>;

    // 1. Check direct getter (PlayerRemote)
    if (typeof entity.combatLevel === "number") {
      return entity.combatLevel;
    }

    // 2. Check data object (raw entity data from server sync)
    const data = entity.data as { combatLevel?: number } | undefined;
    if (typeof data?.combatLevel === "number" && data.combatLevel > 1) {
      return data.combatLevel;
    }

    // 3. Calculate from skills (PlayerLocal has synced skills via SKILLS_UPDATED)
    // This is the most reliable method for the local player
    const skills = entity.skills as
      Record<string, { level: number }> | undefined;
    if (skills) {
      return calculateCombatLevel({
        attack: skills.attack?.level || 1,
        strength: skills.strength?.level || 1,
        defense: skills.defense?.level || 1,
        hitpoints: skills.constitution?.level || 10,
        ranged: skills.ranged?.level || 1,
        magic: skills.magic?.level || 1,
        prayer: skills.prayer?.level || 1,
      });
    }

    // 4. Check nested combat object (PlayerLocal - fallback)
    const combat = entity.combat as { combatLevel?: number } | undefined;
    if (typeof combat?.combatLevel === "number" && combat.combatLevel > 1) {
      return combat.combatLevel;
    }

    // Fallback: classic MMORPG minimum combat level
    return 3;
  }

  private followPlayer(target: RaycastTarget): void {
    this.send(MESSAGE_TYPES.FOLLOW_PLAYER, {
      targetPlayerId: target.entityId,
    });

    this.addChatMessage(`Following ${target.name}.`);
  }

  /**
   * Send trade request to target player.
   */
  private tradeWithPlayer(target: RaycastTarget): void {
    this.send(MESSAGE_TYPES.TRADE_REQUEST, {
      targetPlayerId: target.entityId,
    });

    this.addChatMessage(`Sending trade request to ${target.name}...`);
  }

  /**
   * Send duel challenge to target player.
   * Only available in the Duel Arena zone.
   */
  private challengePlayer(target: RaycastTarget): void {
    if (!this.isInDuelArenaLobby()) {
      this.showExamineMessage(
        "You can only challenge players in the Duel Arena.",
      );
      return;
    }

    this.send(MESSAGE_TYPES.DUEL_CHALLENGE, {
      targetPlayerId: target.entityId,
    });

    this.addChatMessage(`Challenging ${target.name} to a duel...`);
  }
}
