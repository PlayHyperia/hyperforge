/**
 * Handler Helper Functions
 *
 * Extracted from store.ts and bank.ts to eliminate duplication.
 * All functions are pure where possible for easy testing.
 *
 * These utilities handle common operations:
 * - Socket communication (getPlayerId, sendToSocket, sendErrorToast)
 * - World access (getDatabase, getSessionManager)
 * - Entity helpers (getEntityPosition)
 */

import type { ServerSocket } from "../../../../shared/types";
import type { World } from "@hyperforge/shared";
import type { DatabaseConnection } from "./types";
import type pg from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../../database/schema";

// ============================================================================
// SOCKET HELPERS
// ============================================================================

/**
 * Extract player ID from authenticated socket.
 * Returns null if socket has no authenticated player.
 */
export function getPlayerId(socket: ServerSocket): string | null {
  return socket.player?.id || null;
}

/**
 * Send packet to socket with null safety.
 * No-op if socket.send is not available.
 */
export function sendToSocket(
  socket: ServerSocket,
  packet: string,
  data: unknown,
): void {
  if (socket.send) {
    socket.send(packet, data);
  }
}

/**
 * Send error toast to player.
 * Convenience wrapper for common error pattern.
 */
export function sendErrorToast(socket: ServerSocket, message: string): void {
  sendToSocket(socket, "showToast", { message, type: "error" });
}

/**
 * Send success toast to player.
 * Convenience wrapper for common success pattern.
 */
export function sendSuccessToast(socket: ServerSocket, message: string): void {
  sendToSocket(socket, "showToast", { message, type: "success" });
}

// ============================================================================
// WORLD HELPERS
// ============================================================================

/**
 * Get database connection from world object.
 * Returns null if database is not available.
 */
export function getDatabase(world: World): DatabaseConnection | null {
  const serverWorld = world as {
    pgPool?: pg.Pool;
    drizzleDb?: NodePgDatabase<typeof schema>;
  };

  if (serverWorld.drizzleDb && serverWorld.pgPool) {
    return {
      drizzle: serverWorld.drizzleDb,
      pool: serverWorld.pgPool,
    };
  }
  return null;
}

/**
 * Session type returned by session manager
 */
export interface SessionInfo {
  targetEntityId: string;
  type?: string;
  targetStoreId?: string;
}

/**
 * Get session manager from world.
 * Returns undefined if session manager is not available.
 *
 * Session manager is single source of truth for UI sessions (store, bank, dialogue).
 */
export function getSessionManager(
  world: World,
): { getSession: (playerId: string) => SessionInfo | undefined } | undefined {
  return (
    world as {
      interactionSessionManager?: {
        getSession: (playerId: string) => SessionInfo | undefined;
      };
    }
  ).interactionSessionManager;
}

/**
 * Check if player has an active UI session (store, bank, dialogue)
 * Players with active sessions should not be able to initiate certain actions
 */
export function hasActiveInterfaceSession(
  world: World,
  playerId: string,
): boolean {
  const sessionManager = getSessionManager(world);
  if (!sessionManager) return false;
  return sessionManager.getSession(playerId) !== undefined;
}

// ============================================================================
// ENTITY HELPERS
// ============================================================================

/**
 * Position type for entity lookups.
 * Uses x/z for ground plane (classic MMORPG-style), y optional for elevation.
 */
export interface EntityPosition {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

/**
 * Get entity position from entity object.
 * Handles both .position and .base?.position patterns.
 * Returns null if no position found.
 */
export function getEntityPosition(entity: unknown): EntityPosition | null {
  if (!entity) return null;

  const typed = entity as {
    position?: EntityPosition;
    base?: { position?: EntityPosition };
  };

  return typed.position || typed.base?.position || null;
}
