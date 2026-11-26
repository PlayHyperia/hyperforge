/**
 * DeathTypes.ts — Shared type definitions for the player death pipeline.
 *
 * Extracted from PlayerDeathSystem to reduce file size and allow reuse
 * across death-related modules (PlayerDeathSystem, SafeAreaDeathHandler, etc.).
 */

import type { DeathState } from "../../../types/entities";
import type { DeathLocationData } from "../../../types/core/core";
import type { TransactionContext } from "../../../types/death";
import type {
  GroundItemDeathCommitReceipt,
  GroundItemDeathCommitRequest,
} from "../../../types/network/database";

export interface PlayerSystemLike {
  players?: Map<string, { position?: { x: number; y: number; z: number } }>;
}

export interface DatabaseSystemLike {
  executeInTransaction: (
    fn: (tx: TransactionContext) => Promise<void>,
  ) => Promise<void>;
  commitSafeAreaDeathOperationAsync?: (request: {
    operationId: string;
    playerId: string;
    deathTimestamp: number;
    position: { x: number; y: number; z: number };
    killedBy: string;
  }) => Promise<{
    operationId: string;
    replayed: boolean;
    dropped: Array<{ itemId: string; quantity: number }>;
    kept: Array<{ itemId: string; quantity: number }>;
  }>;
  commitSafeAreaDeathKeptReturnAsync?: (request: {
    playerId: string;
    deathOperationId: string;
  }) => Promise<{
    operationId: string;
    replayed: boolean;
    returned: Array<{ itemId: string; quantity: number }>;
  }>;
  commitGroundItemDeathOperationAsync?: (
    request: GroundItemDeathCommitRequest,
  ) => Promise<GroundItemDeathCommitReceipt>;
}

export interface EquipmentSystemLike {
  getPlayerEquipment: (playerId: string) => EquipmentData | null;
  clearEquipmentImmediate?: (playerId: string) => Promise<void>;
  /** Strictly replace live slots with the persisted equipment snapshot. */
  reloadFromDatabase?: (playerId: string) => Promise<void>;
  /** Atomic clear-and-return for death system */
  clearEquipmentAndReturn?: (
    playerId: string,
    tx?: TransactionContext,
  ) => Promise<Array<{ itemId: string; slot: string; quantity: number }>>;
}

export interface EquipmentData {
  weapon?: { item?: { id: string; quantity?: number } };
  shield?: { item?: { id: string; quantity?: number } };
  helmet?: { item?: { id: string; quantity?: number } };
  body?: { item?: { id: string; quantity?: number } };
  legs?: { item?: { id: string; quantity?: number } };
  arrows?: { item?: { id: string; quantity?: number } };
  [key: string]: { item?: { id: string; quantity?: number } } | undefined;
}

export interface TerrainSystemLike {
  isReady: () => boolean;
  getHeightAt: (x: number, z: number) => number;
}

export interface NetworkLike {
  sendTo: (
    playerId: string,
    eventName: string,
    data: Record<string, unknown>,
  ) => void;
}

export interface TickSystemLike {
  getCurrentTick: () => number;
  onTick: (
    callback: (tickNumber: number, deltaMs: number) => void,
    priority?: number,
  ) => () => void;
}

export interface PlayerEntityLike {
  emote?: string;
  data?: {
    e?: string;
    visible?: boolean;
    name?: string;
    position?: number[];
    /** Death state fields (single source of truth) */
    deathState?: DeathState;
    deathPosition?: [number, number, number];
    respawnTick?: number;
  };
  node?: {
    position: { set: (x: number, y: number, z: number) => void };
  };
  position?: { x: number; y: number; z: number };
  setHealth?: (health: number) => void;
  getMaxHealth?: () => number;
  markNetworkDirty?: () => void;
}

/** Extended death location data with headstone tracking */
export interface DeathLocationDataWithHeadstone extends DeathLocationData {
  headstoneId?: string;
}
