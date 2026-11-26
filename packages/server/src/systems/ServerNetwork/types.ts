/**
 * ServerNetwork Payload Types
 *
 * Named payload interfaces for all client-to-server messages processed by
 * ServerNetwork.  Extracted from index.ts so the type definitions don't
 * bloat the main orchestration file.
 */

import type {
  DuelRules,
  DuelEquipmentSlot,
  AttackType,
} from "@hyperforge/shared";
import type { ServerSocket } from "../../shared/types";

// ============================================================================
// Core / Infrastructure
// ============================================================================

export type QueueItem = [ServerSocket, string, unknown];

/**
 * Network message handler function type
 */
export type NetworkHandler = (
  socket: ServerSocket,
  data: unknown,
) => void | Promise<void>;

/** PlayerDeathSystem type for tick processing (not exported from main index) */
export interface PlayerDeathSystemWithTick {
  processTick(currentTick: number): void;
}

/** Payload shape for spatial broadcast helpers (movement, face direction) */
export interface SpatialBroadcastPayload {
  id?: string;
}

// ============================================================================
// Combat / Attack Payloads
// ============================================================================

/** Payload for combat / attack-mob messages from client */
export interface AttackMobPayload {
  mobId?: string;
  targetId?: string;
}

/** Payload for attack-player messages from client */
export interface AttackPlayerPayload {
  targetPlayerId?: string;
}

// ============================================================================
// Resource / Processing Payloads
// ============================================================================

/** Payload for resource interaction from client */
export interface ResourceInteractPayload {
  resourceId?: string;
  runMode?: boolean;
}

/** Payload for cooking source interaction from client */
export interface CookingSourceInteractPayload {
  sourceId?: string;
  sourceType?: string;
  position?: [number, number, number];
  runMode?: boolean;
}

/** Payload for firemaking request from client */
export interface FiremakingRequestPayload {
  logsId?: string;
  logsSlot?: number;
  tinderboxSlot?: number;
  requestId?: unknown;
}

/** Payload for cooking request from client */
export interface CookingRequestPayload {
  rawFoodId?: string;
  rawFoodSlot?: number;
  fireId?: string;
  requestId?: unknown;
}

/** Payload for smelting source interaction from client */
export interface SmeltingSourceInteractPayload {
  furnaceId?: string;
  position?: [number, number, number];
}

/** Payload for smithing source interaction from client */
export interface SmithingSourceInteractPayload {
  anvilId?: string;
  position?: [number, number, number];
}

/** Payload for processing smelting from client */
export interface ProcessingSmeltingPayload {
  barItemId?: unknown;
  furnaceId?: unknown;
  quantity?: unknown;
  requestId?: unknown;
}

/** Payload for processing smithing from client */
export interface ProcessingSmithingPayload {
  recipeId?: unknown;
  anvilId?: unknown;
  quantity?: unknown;
  requestId?: unknown;
}

/** Payload for crafting source interaction from client */
export interface CraftingSourceInteractPayload {
  triggerType?: string;
  stationId?: string;
  inputItemId?: string;
}

/** Payload for processing crafting/fletching from client */
export interface ProcessingRecipePayload {
  recipeId?: unknown;
  quantity?: unknown;
  requestId?: unknown;
}

/** Payload for fletching source interaction from client */
export interface FletchingSourceInteractPayload {
  triggerType?: string;
  inputItemId?: string;
  secondaryItemId?: string;
}

/** Payload for processing tanning from client */
export interface ProcessingTanningPayload {
  inputItemId?: unknown;
  quantity?: unknown;
  requestId?: unknown;
}

/** Payload for runecrafting altar interaction from client */
export interface RunecraftingAltarPayload {
  altarId?: unknown;
  requestId?: unknown;
}

// ============================================================================
// Input / Movement Payloads
// ============================================================================

/** Payload for legacy input handler */
export interface LegacyInputPayload {
  type?: string;
  target?: number[];
  runMode?: boolean;
}

/** Payload for autocast spell selection */
export interface SetAutocastPayload {
  spellId?: string | null;
}

// ============================================================================
// Agent Payloads
// ============================================================================

/** Payload for agent goal sync */
export interface AgentGoalSyncPayload {
  characterId?: string;
  goal: unknown;
  availableGoals?: unknown[];
  personality?: {
    sociability: number;
    helpfulness: number;
    adventurousness: number;
    chattiness: number;
    aggression: number;
    patience: number;
  };
  desireScores?: Array<{
    goalType: string;
    score: number;
    breakdown: string;
  }>;
}

/** Payload for agent thought sync */
export interface AgentThoughtSyncPayload {
  characterId?: string;
  thought: {
    id: string;
    type: "situation" | "evaluation" | "thinking" | "decision" | "action";
    content: string;
    timestamp: number;
    health?: {
      current: number;
      max: number;
      percent: number;
      urgency: "critical" | "warning" | "safe";
    };
    decisionPath?:
      "short-circuit" | "llm" | "scripted" | "planner" | "curiosity";
    providers?: string[];
  };
}

// ============================================================================
// NPC / Entity Interaction Payloads
// ============================================================================

/** Payload for NPC interaction from client */
export interface NpcInteractPayload {
  npcId: string;
  npc: { id: string; name: string; type: string };
}

/** Payload for store open from client */
export interface StoreOpenPayload {
  npcId: string;
  storeId?: string;
  npcPosition?: { x: number; y: number; z: number };
}

/** Payload for entity interaction from client */
export interface EntityInteractPayload {
  entityId: string;
  interactionType?: string;
}

// ============================================================================
// Bank Payloads
// ============================================================================

/** Payload for bank open */
export interface BankOpenPayload {
  bankId: string;
}

/** Payload for bank deposit */
export interface BankDepositPayload {
  itemId: string;
  quantity: number;
  slot?: number;
}

/** Payload for bank withdraw */
export interface BankWithdrawPayload {
  itemId: string;
  quantity: number;
}

/** Payload for bank deposit all */
export interface BankDepositAllPayload {
  targetTabIndex?: number;
}

/** Payload for bank move from client */
export interface BankMovePayload {
  fromSlot: number;
  toSlot: number;
  mode: "swap" | "insert";
  tabIndex: number;
}

/** Payload for bank create tab */
export interface BankCreateTabPayload {
  fromSlot: number;
  fromTabIndex: number;
  newTabIndex: number;
}

/** Payload for bank delete tab */
export interface BankDeleteTabPayload {
  tabIndex: number;
}

/** Payload for bank move to tab */
export interface BankMoveToTabPayload {
  fromSlot: number;
  fromTabIndex: number;
  toTabIndex: number;
}

/** Payload for bank item operations */
export interface BankItemPayload {
  itemId: string;
}

/** Payload for bank slot operations */
export interface BankSlotPayload {
  tabIndex: number;
  slot: number;
}

/** Payload for bank withdraw to equipment */
export interface BankWithdrawToEquipmentPayload {
  itemId: string;
  tabIndex: number;
  slot: number;
}

/** Payload for bank deposit equipment */
export interface BankDepositEquipmentPayload {
  slot: string;
}

/** Payload for coin-related operations */
export interface CoinAmountPayload {
  amount: number;
}

// ============================================================================
// Dialogue / Quest Payloads
// ============================================================================

/** Payload for dialogue response */
export interface DialogueResponsePayload {
  npcId: string;
  responseIndex: number;
}

/** Payload for dialogue continue/close */
export interface DialogueNpcPayload {
  npcId: string;
}

/** Payload for quest operations */
export interface QuestIdPayload {
  questId: string;
}

// ============================================================================
// Store Payloads
// ============================================================================

/** Payload for store item operations */
export interface StoreItemPayload {
  storeId: string;
  itemId: string;
  quantity: number;
}

/** Payload for store close */
export interface StoreClosePayload {
  storeId: string;
}

// ============================================================================
// Trade Payloads
// ============================================================================

/** Payload for trade request */
export interface TradeRequestPayload {
  targetPlayerId: string;
}

/** Payload for trade respond */
export interface TradeRespondPayload {
  tradeId: string;
  accept: boolean;
}

/** Payload for trade add/remove item */
export interface TradeItemPayload {
  tradeId: string;
  inventorySlot: number;
  quantity?: number;
}

/** Payload for trade remove item from slot */
export interface TradeSlotPayload {
  tradeId: string;
  tradeSlot: number;
}

/** Payload for trade set quantity */
export interface TradeSetQuantityPayload {
  tradeId: string;
  tradeSlot: number;
  quantity: number;
}

/** Payload for trade accept/cancel */
export interface TradeIdPayload {
  tradeId: string;
}

// ============================================================================
// Duel Payloads
// ============================================================================

/** Payload for duel challenge */
export interface DuelChallengePayload {
  targetPlayerId: string;
}

/** Payload for duel challenge respond */
export interface DuelChallengeRespondPayload {
  challengeId: string;
  accept: boolean;
}

/** Payload for duel toggle rule */
export interface DuelToggleRulePayload {
  duelId: string;
  rule: keyof DuelRules;
}

/** Payload for duel toggle equipment */
export interface DuelToggleEquipmentPayload {
  duelId: string;
  slot: DuelEquipmentSlot;
}

/** Payload for duel ID-only operations */
export interface DuelIdPayload {
  duelId: string;
}

/** Payload for duel add stake */
export interface DuelAddStakePayload {
  duelId: string;
  inventorySlot: number;
  quantity: number;
}

/** Payload for duel remove stake */
export interface DuelRemoveStakePayload {
  duelId: string;
  stakeIndex: number;
}

// ============================================================================
// Friend / Social Payloads
// ============================================================================

/** Payload for friend request / ignore add */
export interface FriendTargetNamePayload {
  targetName: string;
}

/** Payload for friend accept/decline */
export interface FriendRequestIdPayload {
  requestId: string;
}

/** Payload for friend remove */
export interface FriendIdPayload {
  friendId: string;
}

/** Payload for ignore remove */
export interface IgnoreIdPayload {
  ignoredId: string;
}

/** Payload for private message */
export interface PrivateMessagePayload {
  targetName: string;
  content: string;
}

// ============================================================================
// World Event Payloads (not client packets — internal world events)
// ============================================================================

/** Payload for corpse loot all (gravestone) from client */
export interface CorpseLootAllPayload {
  corpseId?: string;
}

/** Payload for player teleport events (world event) */
export interface PlayerTeleportPayload {
  playerId: string;
  position: { x: number; y: number; z: number };
  rotation: number;
  suppressEffect?: boolean;
}

/** Payload for player:movement:cancel events */
export interface PlayerMovementCancelPayload {
  playerId: string;
}
