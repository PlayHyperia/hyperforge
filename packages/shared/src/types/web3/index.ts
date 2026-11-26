/**
 * Web3 Type Definitions
 *
 * Shared types used by both the server (ChainWriter) and client (wallet UI)
 * for on-chain interactions.
 */

/**
 * The mode the game server is running in.
 * - "web2": Standard mode, PostgreSQL persistence only (default)
 * - "web3": On-chain mode, game state mirrored to MUD World contract
 */
export type GameMode = "web2" | "web3";

/**
 * Supported chain identifiers for Web3 mode.
 */
export type ChainId = "anvil" | "base-sepolia" | "base-mainnet";

/**
 * Status of an optimistic chain write.
 */
export type ChainWriteStatus = "queued" | "pending" | "confirmed" | "failed";

/**
 * A queued chain write operation for tracking/monitoring.
 */
export interface ChainWriteRecord {
  /** Unique write ID */
  id: string;
  /** Type of operation (e.g. "inventory_update", "skill_update") */
  operationType: string;
  /** Human-readable description */
  description: string;
  /** Current status */
  status: ChainWriteStatus;
  /** When the write was queued */
  queuedAt: number;
  /** When the write was sent to chain (null if still queued) */
  sentAt: number | null;
  /** When the write was confirmed (null if not yet confirmed) */
  confirmedAt: number | null;
  /** Transaction hash (null if not yet sent) */
  txHash: string | null;
  /** Error message if failed */
  error: string | null;
}

/**
 * Statistics from the ChainWriter/BatchWriter.
 */
export interface ChainWriterStats {
  /** Total calls flushed to chain */
  totalCallsFlushed: number;
  /** Total batch transactions sent */
  totalFlushes: number;
  /** Failed batch transactions */
  failedFlushes: number;
  /** Currently pending calls in batch */
  pending: number;
}

/**
 * Chain configuration passed to the client for display.
 */
export interface Web3ClientConfig {
  /** Whether the server is in Web3 mode */
  enabled: boolean;
  /** Chain name for display */
  chainName: string;
  /** Chain ID */
  chainId: number;
  /** World contract address */
  worldAddress: string;
  /** Block explorer URL */
  blockExplorerUrl: string;
}

/**
 * Trade escrow state visible to the client.
 */
export interface OnChainTradeState {
  /** Trade ID (bytes32 hex) */
  tradeId: string;
  /** On-chain status */
  status: "Active" | "Confirming" | "Completed" | "Cancelled";
  /** Whether the initiator has accepted */
  initiatorAccepted: boolean;
  /** Whether the recipient has accepted */
  recipientAccepted: boolean;
  /** Transaction hash of the creation */
  creationTxHash: string | null;
  /** Transaction hash of the completion */
  completionTxHash: string | null;
}

/**
 * Duel record visible to the client.
 */
export interface OnChainDuelRecord {
  /** Duel ID (bytes32 hex) */
  duelId: string;
  /** Challenger address */
  challenger: string;
  /** Opponent address */
  opponent: string;
  /** Winner address */
  winner: string;
  /** Challenger's total stake value */
  challengerStakeValue: number;
  /** Opponent's total stake value */
  opponentStakeValue: number;
  /** Whether the loser forfeited */
  forfeit: boolean;
  /** Block timestamp */
  timestamp: number;
  /** Transaction hash */
  txHash: string;
}

/**
 * Player's on-chain identity info.
 */
export interface OnChainPlayerInfo {
  /** Wallet address */
  walletAddress: string;
  /** Character ID (bytes32 hex) */
  characterId: string;
  /** Registered name */
  name: string;
  /** Registration timestamp */
  registeredAt: number;
  /** Whether the account is active */
  isActive: boolean;
  /** Number of ERC-1155 item types owned */
  uniqueItemsOwned: number;
}
