/**
 * Network Types - WebSocket and connection handling types
 *
 * Contains TypeScript types for server networking, WebSocket connections,
 * and real-time multiplayer communication.
 *
 * **Type Categories**:
 * - WebSocket types (NodeWebSocket, ServerSocket)
 * - Connection handling (ConnectionParams, NetworkWithSocket)
 * - Server network interfaces
 *
 * **Referenced by**: ServerNetwork, connection handlers, socket managers
 */

// Re-export Socket base class from shared
export type { Socket } from "@hyperforge/shared";
import { Socket } from "@hyperforge/shared";
import type { PlayerEntity } from "./game.types.js";

// ============================================================================
// WEBSOCKET TYPES
// ============================================================================

/**
 * Node.js WebSocket type with server-specific methods
 *
 * Extends the standard WebSocket interface with Node.js ws library methods
 * like ping(), terminate(), and event handlers.
 */
export type NodeWebSocket = WebSocket & {
  on: (event: string, listener: Function) => void;
  removeListener?: (event: string, listener: Function) => void;
  removeAllListeners?: () => void;
  listenerCount?: (event: string) => number;
  ping: () => void;
  terminate: () => void;
  __wsId?: string;
  __remoteAddress?: string;
};

/**
 * Server-side socket with player and authentication data
 *
 * Extends the base Socket class with server-specific properties
 * for tracking player state, account ID, and character selection.
 *
 * NOTE: Interaction tracking (activeStoreNpcEntityId, activeBankEntityId)
 * has been moved to InteractionSessionManager as the single source of truth.
 * Handlers now query the session manager for targetEntityId instead of socket properties.
 */
export interface ServerSocket extends Socket {
  // Override player type to use server's PlayerEntity (undefined when not connected)
  player?: PlayerEntity;
  // Base Socket properties from Socket class
  ws: NodeWebSocket;
  network: NetworkWithSocket;

  // Server-specific extensions
  accountId?: string;
  /** Database-backed agent credential session bound during JWT verification. */
  agentCredentialSessionId?: string;
  /** Exact character authorized by the database-backed agent credential. */
  agentCredentialCharacterId?: string;
  agentCredentialExpiryTimeoutId?: NodeJS.Timeout;
  selectedCharacterId?: string;
  characterId?: string; // Track active character immediately for duplicate detection
  pendingClientReady?: boolean; // Buffer clientReady packets that arrive before player attach
  createdAt?: number; // Timestamp when socket was created (for reconnection grace period)
  isLoadTestBot?: boolean; // Server-approved local test bypass; never trusted from packets
  clientReadyTimeoutId?: NodeJS.Timeout; // Force-ready timeout for spawned players
  isSpectator?: boolean;
  /** Canonical arena stream viewer; unlike a pinned spectator, follows matchup changes. */
  isStreamingViewer?: boolean;
  spectatingCharacterId?: string;
  spectatingDuelParticipantIds?: string[];
}

// ============================================================================
// CONNECTION TYPES
// ============================================================================

/**
 * WebSocket connection parameters from client
 *
 * Contains authentication and identification data sent by the client
 * during the initial WebSocket handshake.
 */
export interface ConnectionParams {
  authToken?: string;
  name?: string;
  avatar?: string;
  privyUserId?: string;
  mode?: string; // "spectator" for read-only connections
  followEntity?: string; // Entity ID to follow (for spectator mode)
  characterId?: string; // Character ID hint
  streamToken?: string; // Optional token for gated public streaming/spectator viewers
}

/**
 * Network system interface with socket management
 *
 * Defines the contract for server-side network systems that handle
 * WebSocket connections and message routing.
 *
 * Note: enqueue and onDisconnect accept Socket (the base class).
 * Since ServerSocket extends Socket, ServerSocket instances are
 * automatically assignable to the Socket parameter type.
 */
export interface NetworkWithSocket {
  onConnection: (ws: NodeWebSocket, params: ConnectionParams) => Promise<void>;
  sockets: Map<string, ServerSocket>;
  enqueue: (socket: Socket, method: string, data: unknown) => void;
  onDisconnect: (socket: Socket, code?: number | string) => void;
}

/**
 * Server network with socket tracking
 *
 * Extended network interface that includes player entity data
 * on each socket. Used by player management endpoints.
 *
 * Note: PlayerEntity type is defined in game.types.ts.
 * Import via the barrel export: import type { PlayerEntity } from '../types'
 */
export interface ServerNetworkWithSockets {
  sockets: Map<
    string,
    ServerSocket & {
      player: PlayerEntity | null;
    }
  >;
}
