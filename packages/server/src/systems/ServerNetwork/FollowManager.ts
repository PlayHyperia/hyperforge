/**
 * FollowManager
 *
 * Server-authoritative system for tracking players following other players.
 * Implements rules-accurate following behavior.
 *
 * classic MMORPG-style behavior (from wiki):
 * 1. Player right-clicks another player and selects "Follow"
 * 2. Follower walks behind the leader (not on same tile)
 * 3. When leader moves, follower re-paths to stay behind them
 * 4. Following continues indefinitely until cancelled
 * 5. Cancelled by: clicking to walk, trading, equipping items, target disconnecting
 *
 * @see https://classic.wiki/w/Follow
 */

import type { World, TileCoord } from "@hyperforge/shared";
import {
  tilesEqual,
  tileToWorldInto,
  worldToTileInto,
} from "@hyperforge/shared";
import type { TileMovementManager } from "./tile-movement";

interface FollowState {
  followerId: string;
  targetId: string;
  /** Last tile we pathed toward (to detect when target moves) */
  lastTargetTile: { x: number; z: number } | null;
  /** Tick when following started - used to enforce 1-tick delay */
  startTick: number;
}

export class FollowManager {
  /** Map of followerId -> follow state */
  private following = new Map<string, FollowState>();

  /** Current tick number, updated by processTick - instance member for proper encapsulation */
  private currentTickNumber = 0;

  // Pre-allocated reusables for hot-path calculations (avoid GC pressure)
  private readonly _tempFollowerTile: TileCoord = { x: 0, z: 0 };
  private readonly _tempWorldPos: { x: number; y: number; z: number } = {
    x: 0,
    y: 0,
    z: 0,
  };

  constructor(
    private world: World,
    private tileMovementManager: TileMovementManager,
  ) {}

  /**
   * Start following another player
   * Called when player selects "Follow" from context menu
   *
   * RULES-ACCURATE: Does NOT immediately start moving.
   * Movement is deferred to processTick() which runs on the NEXT tick,
   * creating the characteristic 1-tick delay before follower reacts.
   *
   *      within one tick will start to take place by the beginning of the next tick"
   */
  startFollowing(followerId: string, targetId: string): void {
    // Can't follow yourself
    if (followerId === targetId) {
      console.debug(
        `[FollowManager] Player ${followerId} attempted self-follow`,
      );
      return;
    }

    // Cancel any existing follow
    this.stopFollowing(followerId);

    // Verify target exists
    const targetEntity = this.world.entities.get(targetId);
    if (!targetEntity) {
      console.warn(
        `[FollowManager] Target ${targetId} not found for follower ${followerId}`,
      );
      return;
    }

    const targetPos = targetEntity.position;
    if (!targetPos) {
      console.warn(
        `[FollowManager] Target ${targetId} has no position for follower ${followerId}`,
      );
      return;
    }

    // Set up follow state - DON'T immediately move
    // processTick() will handle path calculation on NEXT tick
    // This creates the rules-accurate 1-tick delay before following starts
    this.following.set(followerId, {
      followerId,
      targetId,
      lastTargetTile: null, // null triggers path calculation in processTick
      startTick: this.currentTickNumber,
    });

    console.debug(
      `[FollowManager] ${followerId} now following ${targetId} (tick ${this.currentTickNumber})`,
    );

    // NO immediate movePlayerToward() call here!
    // Movement starts on the next tick via processTick()
  }

  /**
   * Stop following
   * Called when player clicks elsewhere, trades, equips item, or target disconnects
   */
  stopFollowing(playerId: string): void {
    this.following.delete(playerId);
  }

  /**
   * Check if player is following someone
   */
  isFollowing(playerId: string): boolean {
    return this.following.has(playerId);
  }

  /**
   * Get the target being followed
   */
  getFollowTarget(playerId: string): string | null {
    return this.following.get(playerId)?.targetId ?? null;
  }

  /**
   * Process all following players - called every tick
   *
   * RULES-ACCURATE behavior:
   * - Uses PREVIOUS tile (last tile stepped off during movement)
   * - This is 1 tile behind current position, stays unchanged when stopped
   * - Creates proper trailing: follower stops 1 tile behind when target stops
   * - Two players following each other creates "dancing" pattern (correct behavior)
   *
   * Key insight from Rune-Server:
   * "Following is just walking to the target's previous tile. The previous tile
   * is either the last tile they stepped on; which is a single step even if
   * the target is running"
   *
   */
  processTick(tickNumber?: number): void {
    // Track current tick for startFollowing delay
    if (tickNumber !== undefined) {
      this.currentTickNumber = tickNumber;
    }

    for (const [followerId, state] of this.following) {
      // RULES-ACCURATE: Enforce 1-tick delay before following starts
      // If follow was registered THIS tick, skip processing until NEXT tick
      // This matches classic MMORPG: "Each action registered within one tick will start
      // to take place by the beginning of the next tick"
      if (state.startTick === this.currentTickNumber) {
        continue;
      }

      // Check if target still exists (connected)
      const targetEntity = this.world.entities.get(state.targetId);
      if (!targetEntity) {
        // Target disconnected - stop following
        this.following.delete(followerId);
        continue;
      }

      // Check if follower still exists
      const followerEntity = this.world.entities.get(followerId);
      if (!followerEntity) {
        this.following.delete(followerId);
        continue;
      }

      const targetPos = targetEntity.position;
      if (!targetPos) {
        this.following.delete(followerId);
        continue;
      }

      const followerPos = followerEntity.position;
      // Zero-allocation: write to pre-allocated tile object
      worldToTileInto(followerPos.x, followerPos.z, this._tempFollowerTile);

      // RULES-ACCURATE: Get target's PREVIOUS tile (last tile they stepped off)
      // This is always 1 tile behind their current position
      // When target stops, previousTile stays at the last stepped-off position
      const previousTile = this.tileMovementManager.getPreviousTile(
        state.targetId,
      );

      // If follower is already at target's previous tile, we're correctly trailing
      if (tilesEqual(this._tempFollowerTile, previousTile)) {
        continue;
      }

      // Check if target's previous tile changed (they moved)
      if (
        !state.lastTargetTile ||
        state.lastTargetTile.x !== previousTile.x ||
        state.lastTargetTile.z !== previousTile.z
      ) {
        // Target moved - re-path to their PREVIOUS tile (1 tile behind)
        // Zero-allocation: write to pre-allocated world position object
        tileToWorldInto(previousTile, this._tempWorldPos);
        this.tileMovementManager.movePlayerToward(
          followerId,
          { x: this._tempWorldPos.x, y: targetPos.y, z: this._tempWorldPos.z },
          true, // running
          0, // meleeRange=0 for non-combat
        );
        // MEMORY FIX: Update in-place to avoid per-tick allocations
        if (state.lastTargetTile) {
          state.lastTargetTile.x = previousTile.x;
          state.lastTargetTile.z = previousTile.z;
        } else {
          state.lastTargetTile = { x: previousTile.x, z: previousTile.z };
        }
      }
    }
  }

  /**
   * Clean up when a player disconnects
   * Removes them as follower AND cancels anyone following them
   */
  onPlayerDisconnect(playerId: string): void {
    // Stop this player from following anyone
    const wasFollowing = this.following.has(playerId);
    this.following.delete(playerId);

    // Stop anyone following this player
    let followersCleared = 0;
    for (const [followerId, state] of this.following) {
      if (state.targetId === playerId) {
        this.following.delete(followerId);
        followersCleared++;
      }
    }

    if (wasFollowing || followersCleared > 0) {
      console.debug(
        `[FollowManager] Player ${playerId} disconnected: ` +
          `wasFollowing=${wasFollowing}, followersCleared=${followersCleared}`,
      );
    }
  }

  /**
   * Get count of active follows (for debugging)
   */
  get size(): number {
    return this.following.size;
  }

  /**
   * Clear all follows (for shutdown)
   */
  destroy(): void {
    this.following.clear();
  }
}
