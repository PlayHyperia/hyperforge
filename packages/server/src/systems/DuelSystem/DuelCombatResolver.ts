/**
 * DuelCombatResolver - Combat Resolution & Stake Transfers
 *
 * Single Responsibility: Resolving duel outcomes
 * - Death handling
 * - Forfeit processing
 * - Stake transfer to winner
 * - Health restoration
 * - Post-duel teleportation
 *
 * Does NOT handle:
 * - Session management (ServerDuelSessionManager)
 * - State transitions (DuelSystem)
 * - Arena management (ArenaPoolManager)
 */

import type { World, StakedItem } from "@hyperforge/shared";
import {
  EventType,
  PlayerEntity,
  getDuelArenaLobbyReturnPosition,
} from "@hyperforge/shared";
import type { ServerDuelSession } from "./DuelSessionManager";
import { AuditLogger, Logger } from "../ServerNetwork/services";
import crypto from "node:crypto";

// ============================================================================
// Types
// ============================================================================

/**
 * Reason for duel resolution
 */
export type DuelResolutionReason = "death" | "forfeit";

/**
 * Result of duel resolution
 */
export interface DuelResolutionResult {
  winnerId: string;
  winnerName: string;
  loserId: string;
  loserName: string;
  reason: DuelResolutionReason;
  winnerReceives: StakedItem[];
  winnerReceivesValue: number;
}

// ============================================================================
// DuelCombatResolver Class
// ============================================================================

export class DuelCombatResolver {
  private readonly resolutionBarriers = new Map<string, Promise<void>>();
  private isDestroyed = false;

  constructor(private world: World) {}

  hasPendingResolution(duelId: string): boolean {
    return this.resolutionBarriers.has(duelId);
  }

  waitForResolution(duelId: string): Promise<void> {
    return this.resolutionBarriers.get(duelId) ?? Promise.resolve();
  }

  destroy(): void {
    this.isDestroyed = true;
    this.resolutionBarriers.clear();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Resolve a duel with a determined winner and loser
   *
   * This method:
   * 1. Sets the session to FINISHED state
   * 2. Transfers stakes to winner
   * 3. Restores both players' health
   * 4. Teleports both players to lobby
   * 5. Emits completion event
   * 6. Logs to audit trail
   *
   * @returns Resolution result for cleanup
   */
  resolveDuel(
    session: ServerDuelSession,
    winnerId: string,
    loserId: string,
    reason: DuelResolutionReason,
  ): DuelResolutionResult {
    // Mark session as finished
    session.state = "FINISHED";
    session.winnerId = winnerId;
    session.finishedAt = Date.now();

    // Determine names and stakes
    const winnerIsChallenger = winnerId === session.challengerId;
    const winnerName = winnerIsChallenger
      ? session.challengerName
      : session.targetName;
    const loserName = winnerIsChallenger
      ? session.targetName
      : session.challengerName;

    const winnerStakes = winnerIsChallenger
      ? session.challengerStakes
      : session.targetStakes;
    const loserStakes = winnerIsChallenger
      ? session.targetStakes
      : session.challengerStakes;

    // Calculate winnings
    const winnerReceivesValue = loserStakes.reduce(
      (sum, s) => sum + s.value,
      0,
    );

    // Transfer stakes — wrapped so a failure doesn't prevent teleportation
    try {
      this.transferStakes(
        session,
        winnerId,
        loserId,
        winnerStakes,
        loserStakes,
      );
    } catch (err) {
      Logger.error(
        "DuelCombatResolver",
        "Stake transfer failed",
        err instanceof Error ? err : null,
        { duelId: session.duelId, winnerId, loserId },
      );
    }

    // Restore health — wrapped individually so one player failing
    // doesn't prevent the other from being restored (same pattern as teleports).
    // restorePlayerHealth emits PLAYER_RESPAWNED and PLAYER_SET_DEAD which clear
    // the client's death state and unfreeze physics — if skipped, the player
    // appears stuck in the arena with frozen physics and death animation.
    const prayerRestores: Array<{
      playerId: string;
      promise: Promise<void>;
    }> = [];
    try {
      const restore = this.restorePlayerHealth(
        winnerId,
        getDuelArenaLobbyReturnPosition(true),
        `ordinary-duel-resolution-prayer:${session.duelId}:${winnerId}`,
      );
      if (restore)
        prayerRestores.push({ playerId: winnerId, promise: restore });
    } catch (err) {
      Logger.error(
        "DuelCombatResolver",
        "Winner health restoration failed",
        err instanceof Error ? err : null,
        { duelId: session.duelId, winnerId },
      );
    }
    try {
      const restore = this.restorePlayerHealth(
        loserId,
        getDuelArenaLobbyReturnPosition(false),
        `ordinary-duel-resolution-prayer:${session.duelId}:${loserId}`,
      );
      if (restore) prayerRestores.push({ playerId: loserId, promise: restore });
    } catch (err) {
      Logger.error(
        "DuelCombatResolver",
        "Loser health restoration failed",
        err instanceof Error ? err : null,
        { duelId: session.duelId, loserId },
      );
    }

    // CRITICAL: Teleports must ALWAYS execute — this is the most visible
    // part of duel resolution. Wrapped individually so one player failing
    // doesn't prevent the other from being teleported.
    try {
      this.teleportToLobby(winnerId, true);
    } catch (err) {
      Logger.error(
        "DuelCombatResolver",
        "Winner teleport failed",
        err instanceof Error ? err : null,
        { duelId: session.duelId, winnerId },
      );
    }
    try {
      this.teleportToLobby(loserId, false);
    } catch (err) {
      Logger.error(
        "DuelCombatResolver",
        "Loser teleport failed",
        err instanceof Error ? err : null,
        { duelId: session.duelId, loserId },
      );
    }

    // Generate Oracle Data (seed, replayHash)
    // Removed larp crypto.randomBytes(8). Using deterministic derivation from the session IDs and fightStart.
    const duelSeedString = `${session.duelId}-${session.fightStartedAt || session.createdAt}`;
    const duelSeedHex = crypto
      .createHash("sha256")
      .update(duelSeedString)
      .digest("hex")
      .slice(0, 16);
    // Parse the first 8 bytes as a BigInt for the seed
    const duelSeed = BigInt(`0x${duelSeedHex}`).toString();

    // The replay hash should cryptographically bind the deterministic outcome.
    const hashData = JSON.stringify({
      duelId: session.duelId,
      winnerId,
      loserId,
      reason,
      fightStartedAt: session.fightStartedAt || session.createdAt,
      finishedAt: session.finishedAt,
      // Include stakes to prove economic outcome
      winnerReceivesValue,
    });
    const replayHashHex = crypto
      .createHash("sha256")
      .update(hashData)
      .digest("hex");

    const challengerStakeValue = session.challengerStakes.reduce(
      (s, i) => s + i.value,
      0,
    );
    const opponentStakeValue = session.targetStakes.reduce(
      (s, i) => s + i.value,
      0,
    );

    const publishCompletion = () => {
      if (this.isDestroyed) return;
      try {
        this.world.emit("duel:completed", {
          duelId: session.duelId,
          winnerId,
          winnerName,
          loserId,
          loserName,
          reason,
          seed: duelSeed,
          replayHash: replayHashHex,
          forfeit: reason === "forfeit",
          winnerReceives: loserStakes,
          winnerReceivesValue,
          challengerStakes: session.challengerStakes,
          targetStakes: session.targetStakes,
          challengerId: session.challengerId,
          opponentId: session.targetId,
          challengerStakeValue,
          opponentStakeValue,
          summary: {
            duration:
              session.finishedAt! -
              (session.fightStartedAt || session.createdAt),
            rules: session.rules,
            challengerStakeValue: winnerIsChallenger
              ? winnerStakes.reduce((s, i) => s + i.value, 0)
              : winnerReceivesValue,
            targetStakeValue: winnerIsChallenger
              ? winnerReceivesValue
              : winnerStakes.reduce((s, i) => s + i.value, 0),
          },
        });
      } catch (err) {
        Logger.error(
          "DuelCombatResolver",
          "Completion event failed",
          err instanceof Error ? err : null,
          { duelId: session.duelId },
        );
      }

      try {
        AuditLogger.getInstance().logDuelComplete(
          session.duelId,
          winnerId,
          loserId,
          loserStakes,
          winnerStakes,
          winnerReceivesValue,
          reason,
        );
      } catch (err) {
        Logger.error(
          "DuelCombatResolver",
          "Audit logging failed",
          err instanceof Error ? err : null,
          { duelId: session.duelId },
        );
      }
    };

    if (prayerRestores.length === 0) {
      publishCompletion();
    } else {
      let barrier!: Promise<void>;
      barrier = Promise.allSettled(prayerRestores.map(({ promise }) => promise))
        .then((results) => {
          for (const [index, result] of results.entries()) {
            if (result.status === "fulfilled") continue;
            Logger.error(
              "DuelCombatResolver",
              "Prayer restoration failed during duel resolution",
              result.reason instanceof Error ? result.reason : null,
              {
                duelId: session.duelId,
                playerId: prayerRestores[index].playerId,
              },
            );
          }
          publishCompletion();
        })
        .finally(() => {
          if (this.resolutionBarriers.get(session.duelId) === barrier) {
            this.resolutionBarriers.delete(session.duelId);
          }
        });
      this.resolutionBarriers.set(session.duelId, barrier);
      void barrier;
    }

    return {
      winnerId,
      winnerName,
      loserId,
      loserName,
      reason,
      winnerReceives: loserStakes,
      winnerReceivesValue,
    };
  }

  /**
   * Handle staked items on duel cancel/disconnect.
   *
   * CRASH-SAFE: Items were never removed from inventory during staking,
   * so there's nothing to "return". This method just logs for audit purposes.
   */
  returnStakedItems(session: ServerDuelSession): void {
    const challengerStakeCount = session.challengerStakes.length;
    const targetStakeCount = session.targetStakes.length;

    if (challengerStakeCount > 0 || targetStakeCount > 0) {
      Logger.debug(
        "DuelCombatResolver",
        "Duel cancelled - stakes remain in inventory",
        {
          duelId: session.duelId,
          challengerId: session.challengerId,
          challengerStakes: challengerStakeCount,
          targetId: session.targetId,
          targetStakes: targetStakeCount,
        },
      );
    }
    // No event emission needed - items never left player inventories
  }

  // ==========================================================================
  // Private Methods - Stake Transfer
  // ==========================================================================

  /**
   * Transfer stakes to the winner
   */
  private transferStakes(
    session: ServerDuelSession,
    winnerId: string,
    loserId: string,
    winnerStakes: StakedItem[],
    loserStakes: StakedItem[],
  ): void {
    Logger.debug("DuelCombatResolver", "Transferring stakes", {
      winnerId,
      loserId,
      winnerStakesCount: winnerStakes.length,
      loserStakesCount: loserStakes.length,
    });

    // Calculate total values
    const winnerOwnValue = winnerStakes.reduce((sum, s) => sum + s.value, 0);
    const winnerReceivesValue = loserStakes.reduce(
      (sum, s) => sum + s.value,
      0,
    );

    // Emit stake transfer event
    this.world.emit("duel:stakes:transfer", {
      winnerId,
      loserId,
      duelId: session.duelId,
      winnerReceives: loserStakes,
      winnerKeeps: winnerStakes,
      loserLoses: loserStakes,
      totalWinnings: winnerReceivesValue,
      winnerOwnStakeValue: winnerOwnValue,
    });

    // Pre-settlement verification (defense-in-depth):
    // Verify loser's staked items still exist in the in-memory inventory.
    // The DB-level check in executeDuelStakeTransfer is the authoritative guard,
    // but this catches obvious discrepancies early and logs them.
    const verifiedLoserStakes = this.verifyStakesInMemory(
      loserId,
      loserStakes,
      session.duelId,
    );

    // Combine winner's own stakes AND verified loser stakes
    const allWinnerItems = [...winnerStakes, ...verifiedLoserStakes];

    if (allWinnerItems.length > 0) {
      Logger.debug("DuelCombatResolver", "Settling stakes", {
        winnerId,
        ownStakesCount: winnerStakes.length,
        wonStakesCount: verifiedLoserStakes.length,
        skippedStakes: loserStakes.length - verifiedLoserStakes.length,
      });
      this.world.emit("duel:stakes:settle", {
        playerId: winnerId,
        ownStakes: winnerStakes,
        wonStakes: verifiedLoserStakes,
        fromPlayerId: loserId,
        duelId: session.duelId,
        reason: "duel_won",
      });
    }
  }

  /**
   * Verify staked items still exist in the in-memory inventory.
   * Returns only the stakes that pass verification.
   * This is a defense-in-depth check; the DB transaction is the authoritative guard.
   */
  private verifyStakesInMemory(
    playerId: string,
    stakes: StakedItem[],
    duelId: string,
  ): StakedItem[] {
    if (stakes.length === 0) return stakes;

    const inventorySystem = this.world.getSystem?.("inventory") as {
      getInventoryData?: (id: string) => {
        items: Array<{ slot: number; itemId: string; quantity: number }>;
      };
    } | null;

    if (!inventorySystem?.getInventoryData) {
      // Can't verify — pass all stakes through to DB-level check
      return stakes;
    }

    const inventoryData = inventorySystem.getInventoryData(playerId);
    const itemsBySlot = new Map(
      inventoryData.items.map((item) => [item.slot, item]),
    );

    const verified: StakedItem[] = [];

    for (const stake of stakes) {
      const slotItem = itemsBySlot.get(stake.inventorySlot);

      if (!slotItem) {
        Logger.error(
          "DuelCombatResolver",
          "SECURITY: Staked item missing from memory",
          null,
          { duelId, playerId, slot: stake.inventorySlot, itemId: stake.itemId },
        );
        continue;
      }

      if (slotItem.itemId !== stake.itemId) {
        Logger.error(
          "DuelCombatResolver",
          "SECURITY: Staked item ID mismatch in memory",
          null,
          {
            duelId,
            playerId,
            slot: stake.inventorySlot,
            expected: stake.itemId,
            found: slotItem.itemId,
          },
        );
        continue;
      }

      if (slotItem.quantity < stake.quantity) {
        Logger.warn(
          "DuelCombatResolver",
          "Staked quantity exceeds in-memory quantity",
          {
            duelId,
            playerId,
            slot: stake.inventorySlot,
            itemId: stake.itemId,
            staked: stake.quantity,
            actual: slotItem.quantity,
          },
        );
        // Still include — the DB-level check will use Math.min()
      }

      verified.push(stake);
    }

    if (verified.length < stakes.length) {
      Logger.error(
        "DuelCombatResolver",
        "SECURITY: Pre-settlement verification filtered stakes",
        null,
        {
          duelId,
          playerId,
          original: stakes.length,
          verified: verified.length,
          filtered: stakes.length - verified.length,
        },
      );
    }

    return verified;
  }

  // ==========================================================================
  // Private Methods - Player State
  // ==========================================================================

  /**
   * Restore player to full stats after duel
   * rules-accurate: Both winner and loser get full HP, prayer, stamina restored
   * @param spawnPosition - Must match the teleport destination to avoid lerpPosition conflicts
   */
  private restorePlayerHealth(
    playerId: string,
    spawnPosition: { x: number; y: number; z: number },
    operationId: string,
  ): Promise<void> | null {
    let prayerRestore: Promise<void> | null = null;
    // Clear death state using PlayerEntity helper method (Law of Demeter)
    const playerEntity = this.world.entities?.get?.(playerId);
    if (playerEntity instanceof PlayerEntity) {
      playerEntity.resetDeathState();

      // Restore health directly (more reliable than relying on event chain)
      playerEntity.setHealth(playerEntity.getMaxHealth());

      // Restore stamina to max (duels grant effectively infinite stamina)
      const INFINITE_STAMINA = 999_999;
      playerEntity.setStamina(INFINITE_STAMINA);

      // Restore prayer points to max
      const prayerSystem = this.world.getSystem?.("prayer") as {
        restorePrayerPoints?: (
          playerId: string,
          amount: number,
          operationId: string,
        ) => Promise<{ success: boolean; reason?: string }>;
        getMaxPrayerPoints?: (playerId: string) => number;
      } | null;

      if (prayerSystem?.restorePrayerPoints) {
        const maxPrayer = prayerSystem.getMaxPrayerPoints?.(playerId) ?? 99;
        prayerRestore = prayerSystem
          .restorePrayerPoints(playerId, maxPrayer, operationId)
          .then((receipt) => {
            if (!receipt.success) {
              throw new Error(
                `ordinary_duel_prayer_restore_rejected:${receipt.reason ?? "unknown"}`,
              );
            }
          });
      }

      playerEntity.markNetworkDirty();
    }

    // Emit PLAYER_RESPAWNED to trigger PlayerSystem state updates (alive flag, position)
    this.world.emit(EventType.PLAYER_RESPAWNED, {
      playerId,
      spawnPosition,
      townName: "Duel Arena",
    });

    // Also emit PLAYER_SET_DEAD to ensure death state is cleared on client
    this.world.emit(EventType.PLAYER_SET_DEAD, {
      playerId,
      isDead: false,
    });

    return prayerRestore;
  }

  /**
   * Teleport player to duel arena lobby
   * Uses different spawn positions so winner and loser don't overlap
   */
  private teleportToLobby(playerId: string, isWinner: boolean): void {
    const lobbySpawn = getDuelArenaLobbyReturnPosition(isWinner);

    this.world.emit("player:teleport", {
      playerId,
      position: lobbySpawn,
      rotation: 0,
    });
  }
}
