/**
 * PlayerDamageHandler
 *
 * Handles player-specific damage application, health checks,
 * and auto-retaliate logic.
 *
 * Extracted from CombatSystem to eliminate player/mob conditionals.
 */

import type { World } from "../../../../core/World";
import { Logger } from "../../../../utils/Logger";
import type { DamageHandler, DamageApplicationResult } from "./DamageHandler";
import type { EntityID } from "../../../../types/core/identifiers";
import type { Entity } from "../../../../entities/Entity";

/**
 * PlayerSystem interface for type safety
 */
interface PlayerSystem {
  damagePlayer(playerId: string, amount: number, source?: string): boolean;
  getPlayerAutoRetaliate(playerId: string): boolean;
}

/**
 * Player entity interface for combat operations
 * Uses intersection to merge player-specific properties with Entity
 * (intersection merges data, interface extends would override it)
 */
type PlayerEntity = Entity & {
  health?: number;
  name?: string;
  alive?: boolean;
  getHealth?: () => number;
  isAlive?: () => boolean;
  data?: Entity["data"] & {
    isLoading?: boolean;
    health?: number;
  };
};

/**
 * PlayerDamageHandler - Implements DamageHandler for player entities
 *
 * Uses PlayerSystem for damage application and auto-retaliate checks.
 * Must call cachePlayerSystem() during init before use.
 */
export class PlayerDamageHandler implements DamageHandler {
  readonly entityType = "player" as const;

  private world: World;
  private playerSystem: PlayerSystem | null = null;

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Cache PlayerSystem reference
   * Must be called during CombatSystem.init() after PlayerSystem is available
   */
  cachePlayerSystem(playerSystem: PlayerSystem | null): void {
    this.playerSystem = playerSystem;
  }

  applyDamage(
    targetId: EntityID,
    damage: number,
    attackerId: EntityID,
    _attackerType: "player" | "mob",
  ): DamageApplicationResult {
    if (!this.playerSystem) {
      Logger.systemError("PlayerDamageHandler", "PlayerSystem not cached");
      return { actualDamage: 0, targetDied: false, success: false };
    }

    const targetIdStr = String(targetId);

    // Validate attacker exists before applying damage
    // This prevents spoofed damage from non-existent attackers
    const attacker = this.world.entities.get(String(attackerId));
    if (!attacker) {
      Logger.systemWarn(
        "PlayerDamageHandler",
        `Rejecting damage - attacker ${attackerId} does not exist`,
      );
      return { actualDamage: 0, targetDied: false, success: false };
    }

    // Check if player exists and is alive before damage
    const player = this.getEntity(targetId);
    if (!player) {
      return { actualDamage: 0, targetDied: false, success: false };
    }

    // Handle 0 damage as a valid combat outcome (classic MMORPG miss/block)
    // PlayerSystem.damagePlayer() returns false for amount <= 0, which would
    // trigger a false positive "Failed to apply damage" error in CombatSystem
    if (damage <= 0) {
      const targetDied = !this.isAlive(targetId);
      if (targetDied) {
        // Target was already dead - signal for combat cleanup
        return { actualDamage: 0, targetDied: true, success: false };
      }
      // Valid 0-hit (miss) on living target - not a failure
      return { actualDamage: 0, targetDied: false, success: true };
    }

    const healthBefore = this.getHealth(targetId);

    // Apply damage through PlayerSystem
    const success = this.playerSystem.damagePlayer(
      targetIdStr,
      damage,
      String(attackerId),
    );

    if (!success) {
      // Damage failed - check if player is dead
      const isDead = !this.isAlive(targetId);
      return { actualDamage: 0, targetDied: isDead, success: false };
    }

    // Check if player died from this damage
    const healthAfter = this.getHealth(targetId);
    const actualDamage = healthBefore - healthAfter;
    const targetDied = !this.isAlive(targetId);

    return { actualDamage, targetDied, success: true };
  }

  getHealth(entityId: EntityID): number {
    const player = this.getEntity(entityId);
    if (!player) return 0;
    const methodHealth = player.getHealth?.();
    if (Number.isFinite(methodHealth)) return Number(methodHealth);
    if (Number.isFinite(player.health)) return Number(player.health);
    const dataHealth = player.data?.health;
    return Number.isFinite(dataHealth) ? Number(dataHealth) : 0;
  }

  isAlive(entityId: EntityID): boolean {
    const player = this.getEntity(entityId);
    if (!player) return false;

    // Prefer the entity's canonical lifecycle method. Lightweight server
    // runtimes and tests may expose health through getHealth()/data rather than
    // duplicating PlayerEntity's top-level field, so field-only checks can turn
    // a valid zero-hit into a false death and tear down both combat states.
    const methodAlive = player.isAlive?.();
    const health = this.getHealth(entityId);
    const alive =
      typeof methodAlive === "boolean" ? methodAlive : player.alive !== false;

    return health > 0 && alive;
  }

  canRetaliate(entityId: EntityID, _currentTick: number): boolean {
    if (!this.playerSystem) {
      // Default to classic MMORPG behavior (auto-retaliate on)
      return true;
    }

    return this.playerSystem.getPlayerAutoRetaliate(String(entityId));
  }

  isProtected(entityId: EntityID): boolean {
    const player = this.getEntity(entityId);
    return player?.data?.isLoading ?? false;
  }

  isAttackable(entityId: EntityID): boolean {
    if (!this.isAlive(entityId)) return false;
    if (this.isProtected(entityId)) return false;
    return true;
  }

  /**
   * Get player entity by ID
   * Returns PlayerEntity since we're specifically fetching from getPlayer
   */
  getEntity(entityId: EntityID): PlayerEntity | null {
    return (this.world.getPlayer?.(String(entityId)) as PlayerEntity) ?? null;
  }

  getDisplayName(entityId: EntityID): string {
    const player = this.getEntity(entityId);
    return player?.name ?? "player";
  }
}
