/**
 * FriendRepository - Social/Friend system database operations
 *
 * Handles all friend-related database operations including:
 * - Friend list management (add, remove, list)
 * - Friend requests (create, accept, decline, list)
 * - Ignore list management (add, remove, list, check)
 *
 * Design notes:
 * - Friendships are bidirectional: accepting a request creates 2 rows
 * - Requests are deleted after accept/decline (not status-flagged)
 * - Ignore list is unidirectional
 * - All operations cascade delete when character is deleted
 *
 * @see packages/shared/src/types/game/social-types.ts for type definitions
 * @see packages/server/src/database/schema.ts for table definitions
 */

import { eq, and, or, sql, desc, lt, ne } from "drizzle-orm";
import { BaseRepository } from "./BaseRepository";
import * as schema from "../schema";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Types
// ============================================================================

/** Friend row from database with character info */
export type FriendRow = {
  id: number;
  playerId: string;
  friendId: string;
  friendName: string;
  friendLevel: number;
  lastLogin: number;
  createdAt: number;
  note: string | null;
};

/** Friend request row from database */
export type FriendRequestRow = {
  id: string;
  fromPlayerId: string;
  fromPlayerName: string;
  toPlayerId: string;
  toPlayerName: string;
  createdAt: number;
};

/** Ignore list row from database */
export type IgnoreRow = {
  id: number;
  playerId: string;
  ignoredPlayerId: string;
  ignoredPlayerName: string;
  createdAt: number;
};

// ============================================================================
// FriendRepository
// ============================================================================

/**
 * FriendRepository class
 *
 * Provides all social/friend system database operations.
 */
export class FriendRepository extends BaseRepository {
  // ==========================================================================
  // FRIEND OPERATIONS
  // ==========================================================================

  /**
   * Get all friends for a player
   *
   * Returns friends with their character info (name, level, last login).
   * Results are sorted alphabetically by friend name.
   *
   * @param playerId - The player's character ID
   * @returns Array of friend rows with character info
   */
  async getFriendsAsync(playerId: string): Promise<FriendRow[]> {
    this.ensureDatabase();

    const results = await this.db
      .select({
        id: schema.friendships.id,
        playerId: schema.friendships.playerId,
        friendId: schema.friendships.friendId,
        friendName: schema.characters.name,
        friendLevel: schema.characters.combatLevel,
        lastLogin: schema.characters.lastLogin,
        createdAt: schema.friendships.createdAt,
        note: schema.friendships.note,
      })
      .from(schema.friendships)
      .innerJoin(
        schema.characters,
        eq(schema.friendships.friendId, schema.characters.id),
      )
      .where(eq(schema.friendships.playerId, playerId))
      .orderBy(schema.characters.name);

    return results.map((r) => ({
      id: r.id,
      playerId: r.playerId,
      friendId: r.friendId,
      friendName: r.friendName,
      friendLevel: r.friendLevel ?? 3,
      lastLogin: r.lastLogin ?? 0,
      createdAt: r.createdAt,
      note: r.note,
    }));
  }

  /**
   * Add a friend (bidirectional)
   *
   * Creates two friendship rows: (player, friend) and (friend, player).
   * Should be called when a friend request is accepted.
   *
   * @param playerId - The player's character ID
   * @param friendId - The friend's character ID
   */
  async addFriendAsync(playerId: string, friendId: string): Promise<void> {
    this.ensureDatabase();

    const now = Date.now();

    // Insert both directions in a transaction
    await this.withTransaction(async (tx) => {
      // Player -> Friend
      await tx
        .insert(schema.friendships)
        .values({
          playerId,
          friendId,
          createdAt: now,
        })
        .onConflictDoNothing();

      // Friend -> Player
      await tx
        .insert(schema.friendships)
        .values({
          playerId: friendId,
          friendId: playerId,
          createdAt: now,
        })
        .onConflictDoNothing();
    });
  }

  /**
   * Remove a friend (bidirectional)
   *
   * Removes both directions of the friendship.
   *
   * @param playerId - The player's character ID
   * @param friendId - The friend's character ID
   */
  async removeFriendAsync(playerId: string, friendId: string): Promise<void> {
    this.ensureDatabase();

    // Delete both directions
    await this.db
      .delete(schema.friendships)
      .where(
        or(
          and(
            eq(schema.friendships.playerId, playerId),
            eq(schema.friendships.friendId, friendId),
          ),
          and(
            eq(schema.friendships.playerId, friendId),
            eq(schema.friendships.friendId, playerId),
          ),
        ),
      );
  }

  /**
   * Get friend count for a player
   *
   * @param playerId - The player's character ID
   * @returns Number of friends
   */
  async getFriendCountAsync(playerId: string): Promise<number> {
    this.ensureDatabase();

    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.friendships)
      .where(eq(schema.friendships.playerId, playerId));

    return result[0]?.count ?? 0;
  }

  /**
   * Check if two players are friends
   *
   * @param player1 - First player's character ID
   * @param player2 - Second player's character ID
   * @returns True if they are friends
   */
  async areFriendsAsync(player1: string, player2: string): Promise<boolean> {
    this.ensureDatabase();

    const result = await this.db
      .select({ id: schema.friendships.id })
      .from(schema.friendships)
      .where(
        and(
          eq(schema.friendships.playerId, player1),
          eq(schema.friendships.friendId, player2),
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  // ==========================================================================
  // FRIEND REQUEST OPERATIONS
  // ==========================================================================

  /**
   * Get pending friend requests for a player (incoming)
   *
   * Returns requests where this player is the recipient.
   * Sorted by most recent first.
   *
   * @param playerId - The player's character ID
   * @returns Array of pending friend requests
   */
  async getPendingRequestsAsync(playerId: string): Promise<FriendRequestRow[]> {
    this.ensureDatabase();

    const results = await this.db
      .select({
        id: schema.friendRequests.id,
        fromPlayerId: schema.friendRequests.fromPlayerId,
        fromPlayerName: schema.characters.name,
        toPlayerId: schema.friendRequests.toPlayerId,
        createdAt: schema.friendRequests.createdAt,
      })
      .from(schema.friendRequests)
      .innerJoin(
        schema.characters,
        eq(schema.friendRequests.fromPlayerId, schema.characters.id),
      )
      .where(eq(schema.friendRequests.toPlayerId, playerId))
      .orderBy(desc(schema.friendRequests.createdAt));

    // Get recipient names
    const toPlayerIds = results.map((r) => r.toPlayerId);
    const toPlayerNames = await this.getPlayerNamesAsync(toPlayerIds);

    return results.map((r) => ({
      id: r.id,
      fromPlayerId: r.fromPlayerId,
      fromPlayerName: r.fromPlayerName,
      toPlayerId: r.toPlayerId,
      toPlayerName: toPlayerNames.get(r.toPlayerId) ?? "Unknown",
      createdAt: r.createdAt,
    }));
  }

  /**
   * Get outgoing friend requests from a player
   *
   * Returns requests where this player is the sender.
   *
   * @param playerId - The player's character ID
   * @returns Array of outgoing friend requests
   */
  async getOutgoingRequestsAsync(
    playerId: string,
  ): Promise<FriendRequestRow[]> {
    this.ensureDatabase();

    const results = await this.db
      .select({
        id: schema.friendRequests.id,
        fromPlayerId: schema.friendRequests.fromPlayerId,
        toPlayerId: schema.friendRequests.toPlayerId,
        toPlayerName: schema.characters.name,
        createdAt: schema.friendRequests.createdAt,
      })
      .from(schema.friendRequests)
      .innerJoin(
        schema.characters,
        eq(schema.friendRequests.toPlayerId, schema.characters.id),
      )
      .where(eq(schema.friendRequests.fromPlayerId, playerId))
      .orderBy(desc(schema.friendRequests.createdAt));

    // Get sender names
    const fromPlayerIds = results.map((r) => r.fromPlayerId);
    const fromPlayerNames = await this.getPlayerNamesAsync(fromPlayerIds);

    return results.map((r) => ({
      id: r.id,
      fromPlayerId: r.fromPlayerId,
      fromPlayerName: fromPlayerNames.get(r.fromPlayerId) ?? "Unknown",
      toPlayerId: r.toPlayerId,
      toPlayerName: r.toPlayerName,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Create a friend request
   *
   * @param fromId - Sender's character ID
   * @param toId - Recipient's character ID
   * @returns The request UUID
   */
  async createRequestAsync(fromId: string, toId: string): Promise<string> {
    this.ensureDatabase();

    const id = uuidv4();
    const now = Date.now();

    await this.db.insert(schema.friendRequests).values({
      id,
      fromPlayerId: fromId,
      toPlayerId: toId,
      createdAt: now,
    });

    return id;
  }

  /**
   * Get a friend request by ID
   *
   * @param requestId - The request UUID
   * @returns The request row or null
   */
  async getRequestAsync(requestId: string): Promise<FriendRequestRow | null> {
    this.ensureDatabase();

    const results = await this.db
      .select({
        id: schema.friendRequests.id,
        fromPlayerId: schema.friendRequests.fromPlayerId,
        toPlayerId: schema.friendRequests.toPlayerId,
        createdAt: schema.friendRequests.createdAt,
      })
      .from(schema.friendRequests)
      .where(eq(schema.friendRequests.id, requestId))
      .limit(1);

    if (results.length === 0) return null;

    const r = results[0];
    const names = await this.getPlayerNamesAsync([
      r.fromPlayerId,
      r.toPlayerId,
    ]);

    return {
      id: r.id,
      fromPlayerId: r.fromPlayerId,
      fromPlayerName: names.get(r.fromPlayerId) ?? "Unknown",
      toPlayerId: r.toPlayerId,
      toPlayerName: names.get(r.toPlayerId) ?? "Unknown",
      createdAt: r.createdAt,
    };
  }

  /**
   * Accept a friend request
   *
   * Validates the request belongs to the player, creates the friendship,
   * and deletes the request.
   *
   * @param requestId - The request UUID
   * @param playerId - The player accepting (must be the recipient)
   * @returns True if successful, false if request not found or not authorized
   */
  async acceptRequestAsync(
    requestId: string,
    playerId: string,
  ): Promise<boolean> {
    this.ensureDatabase();

    // Get the request
    const results = await this.db
      .select()
      .from(schema.friendRequests)
      .where(eq(schema.friendRequests.id, requestId))
      .limit(1);

    if (results.length === 0) return false;

    const request = results[0];

    // Verify the player is the recipient
    if (request.toPlayerId !== playerId) return false;

    // Create friendship and delete request in transaction
    await this.withTransaction(async (tx) => {
      const now = Date.now();

      // Create bidirectional friendship
      await tx
        .insert(schema.friendships)
        .values({
          playerId: request.toPlayerId,
          friendId: request.fromPlayerId,
          createdAt: now,
        })
        .onConflictDoNothing();

      await tx
        .insert(schema.friendships)
        .values({
          playerId: request.fromPlayerId,
          friendId: request.toPlayerId,
          createdAt: now,
        })
        .onConflictDoNothing();

      // Delete the request
      await tx
        .delete(schema.friendRequests)
        .where(eq(schema.friendRequests.id, requestId));
    });

    return true;
  }

  /**
   * Decline a friend request
   *
   * Validates the request belongs to the player and deletes it.
   *
   * @param requestId - The request UUID
   * @param playerId - The player declining (must be the recipient)
   * @returns True if successful, false if request not found or not authorized
   */
  async declineRequestAsync(
    requestId: string,
    playerId: string,
  ): Promise<boolean> {
    this.ensureDatabase();

    const result = await this.db
      .delete(schema.friendRequests)
      .where(
        and(
          eq(schema.friendRequests.id, requestId),
          eq(schema.friendRequests.toPlayerId, playerId),
        ),
      )
      .returning({ id: schema.friendRequests.id });

    return result.length > 0;
  }

  /**
   * Check if a friend request exists between two players
   *
   * @param fromId - Sender's character ID
   * @param toId - Recipient's character ID
   * @returns True if a request exists
   */
  async hasRequestAsync(fromId: string, toId: string): Promise<boolean> {
    this.ensureDatabase();

    const result = await this.db
      .select({ id: schema.friendRequests.id })
      .from(schema.friendRequests)
      .where(
        and(
          eq(schema.friendRequests.fromPlayerId, fromId),
          eq(schema.friendRequests.toPlayerId, toId),
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  /**
   * Cleanup expired friend requests
   *
   * Deletes requests older than the specified cutoff time.
   *
   * @param cutoffMs - Requests older than this are deleted (default: 7 days)
   * @returns Number of deleted requests
   */
  async cleanupExpiredRequestsAsync(
    cutoffMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    this.ensureDatabase();

    const cutoffTime = Date.now() - cutoffMs;

    const result = await this.db
      .delete(schema.friendRequests)
      .where(lt(schema.friendRequests.createdAt, cutoffTime))
      .returning({ id: schema.friendRequests.id });

    return result.length;
  }

  // ==========================================================================
  // IGNORE LIST OPERATIONS
  // ==========================================================================

  /**
   * Get ignore list for a player
   *
   * @param playerId - The player's character ID
   * @returns Array of ignored player entries
   */
  async getIgnoreListAsync(playerId: string): Promise<IgnoreRow[]> {
    this.ensureDatabase();

    const results = await this.db
      .select({
        id: schema.ignoreList.id,
        playerId: schema.ignoreList.playerId,
        ignoredPlayerId: schema.ignoreList.ignoredPlayerId,
        ignoredPlayerName: schema.characters.name,
        createdAt: schema.ignoreList.createdAt,
      })
      .from(schema.ignoreList)
      .innerJoin(
        schema.characters,
        eq(schema.ignoreList.ignoredPlayerId, schema.characters.id),
      )
      .where(eq(schema.ignoreList.playerId, playerId))
      .orderBy(schema.characters.name);

    return results.map((r) => ({
      id: r.id,
      playerId: r.playerId,
      ignoredPlayerId: r.ignoredPlayerId,
      ignoredPlayerName: r.ignoredPlayerName,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Add a player to ignore list
   *
   * Also removes any existing friendship between the players.
   *
   * @param playerId - The player's character ID
   * @param targetId - The player to ignore
   */
  async addToIgnoreAsync(playerId: string, targetId: string): Promise<void> {
    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      // Add to ignore list
      await tx
        .insert(schema.ignoreList)
        .values({
          playerId,
          ignoredPlayerId: targetId,
          createdAt: Date.now(),
        })
        .onConflictDoNothing();

      // Remove friendship (both directions)
      await tx
        .delete(schema.friendships)
        .where(
          or(
            and(
              eq(schema.friendships.playerId, playerId),
              eq(schema.friendships.friendId, targetId),
            ),
            and(
              eq(schema.friendships.playerId, targetId),
              eq(schema.friendships.friendId, playerId),
            ),
          ),
        );

      // Delete any pending friend requests between them
      await tx
        .delete(schema.friendRequests)
        .where(
          or(
            and(
              eq(schema.friendRequests.fromPlayerId, playerId),
              eq(schema.friendRequests.toPlayerId, targetId),
            ),
            and(
              eq(schema.friendRequests.fromPlayerId, targetId),
              eq(schema.friendRequests.toPlayerId, playerId),
            ),
          ),
        );
    });
  }

  /**
   * Remove a player from ignore list
   *
   * @param playerId - The player's character ID
   * @param targetId - The player to unignore
   */
  async removeFromIgnoreAsync(
    playerId: string,
    targetId: string,
  ): Promise<void> {
    this.ensureDatabase();

    await this.db
      .delete(schema.ignoreList)
      .where(
        and(
          eq(schema.ignoreList.playerId, playerId),
          eq(schema.ignoreList.ignoredPlayerId, targetId),
        ),
      );
  }

  /**
   * Check if a player is ignored by another
   *
   * @param senderId - The potential sender
   * @param receiverId - The potential receiver
   * @returns True if receiverId has senderId on their ignore list
   */
  async isIgnoredByAsync(
    senderId: string,
    receiverId: string,
  ): Promise<boolean> {
    this.ensureDatabase();

    const result = await this.db
      .select({ id: schema.ignoreList.id })
      .from(schema.ignoreList)
      .where(
        and(
          eq(schema.ignoreList.playerId, receiverId),
          eq(schema.ignoreList.ignoredPlayerId, senderId),
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  /**
   * Get ignore count for a player
   *
   * @param playerId - The player's character ID
   * @returns Number of ignored players
   */
  async getIgnoreCountAsync(playerId: string): Promise<number> {
    this.ensureDatabase();

    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.ignoreList)
      .where(eq(schema.ignoreList.playerId, playerId));

    return result[0]?.count ?? 0;
  }

  // ==========================================================================
  // HELPER OPERATIONS
  // ==========================================================================

  /**
   * Find a player by name (case-insensitive)
   *
   * @param name - Player name to search
   * @returns Player info or null
   */
  async findPlayerByNameAsync(
    name: string,
  ): Promise<{ id: string; name: string } | null> {
    this.ensureDatabase();

    const results = await this.db
      .select({
        id: schema.characters.id,
        name: schema.characters.name,
      })
      .from(schema.characters)
      .where(sql`LOWER(${schema.characters.name}) = LOWER(${name})`)
      .limit(1);

    if (results.length === 0) return null;

    return {
      id: results[0].id,
      name: results[0].name,
    };
  }

  /**
   * Get player names by IDs
   *
   * @param playerIds - Array of player IDs
   * @returns Map of player ID to name
   */
  private async getPlayerNamesAsync(
    playerIds: string[],
  ): Promise<Map<string, string>> {
    if (playerIds.length === 0) return new Map();

    const results = await this.db
      .select({
        id: schema.characters.id,
        name: schema.characters.name,
      })
      .from(schema.characters)
      .where(
        sql`${schema.characters.id} IN (${sql.join(
          playerIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const map = new Map<string, string>();
    for (const r of results) {
      map.set(r.id, r.name);
    }
    return map;
  }

  /**
   * Get friend IDs for a player
   *
   * Lightweight method that returns just the IDs, not full info.
   *
   * @param playerId - The player's character ID
   * @returns Array of friend IDs
   */
  async getFriendIdsAsync(playerId: string): Promise<string[]> {
    this.ensureDatabase();

    const results = await this.db
      .select({ friendId: schema.friendships.friendId })
      .from(schema.friendships)
      .where(eq(schema.friendships.playerId, playerId));

    return results.map((r) => r.friendId);
  }

  /**
   * Find another character (not the excluded one) for testing purposes
   *
   * Used by /testfriend command to find a valid character to use as the
   * friend request sender, since FK constraints require valid character IDs.
   *
   * @param excludeId - Character ID to exclude from results (typically current player)
   * @returns Character with id and name, or null if no other characters exist
   */
  async findOtherCharacterAsync(
    excludeId: string,
  ): Promise<{ id: string; name: string } | null> {
    this.ensureDatabase();

    const results = await this.db
      .select({
        id: schema.characters.id,
        name: schema.characters.name,
      })
      .from(schema.characters)
      .where(ne(schema.characters.id, excludeId))
      .limit(1);

    if (results.length === 0) return null;

    return {
      id: results[0].id,
      name: results[0].name,
    };
  }
}
