/**
 * Worker Thread Types — shared between main thread and agent behavior worker.
 *
 * All types here must be serializable via structured clone (no functions,
 * no class instances, no Maps/Sets — only plain objects, arrays, primitives).
 */

import type {
  EmbeddedGameState,
  AgentQuestProgress,
  AgentQuestInfo,
} from "../types.js";

import type {
  AgentGoal,
  PendingChatReaction,
  EmbeddedBehaviorAction,
} from "../managers/AgentBehaviorTicker.js";
import type { OrdinaryProcessingRetrySuppression } from "../ordinaryProcessingRetry.js";

// ─── Item data (sent once at init) ──────────────────────────────────────────

/** Serializable item data for worker-side getItem() */
export interface WorkerItemData {
  id: string;
  name: string;
  type: string;
  stackable?: boolean;
  equipSlot?: string;
  attackType?: string;
  bonuses?: Record<string, number>;
  healAmount?: number;
  prayerXp?: number;
  buryLevelRequired?: number;
  requirements?: Record<string, unknown>;
  tool?: {
    skill: string;
    priority: number;
  };
  /** Public authored recipe metadata; private inventory/bank state is never sent here. */
  cooking?: {
    cookedItemId: string;
    levelRequired: number;
  };
  smelting?: {
    inputs: Array<{ itemId: string; quantity: number }>;
    levelRequired: number;
  };
  smithing?: {
    barItemId: string;
    barsRequired: number;
    levelRequired: number;
    outputQuantity: number;
  };
}

/** Public authored processing recipes sent once at worker initialization. */
export interface WorkerProcessingRecipeSnapshot {
  stores: Array<{
    storeId: string;
    items: Array<{
      itemId: string;
      price: number;
      category: string;
    }>;
  }>;
  gathering: Array<{
    resourceId: string;
    harvestSkill: string;
    toolRequired: string | null;
    levelRequired: number;
    outputItemIds: string[];
  }>;
  /** Only authored drops whose manifest probability is exactly one. */
  guaranteedMobDrops?: Array<{
    mobType: string;
    itemIds: string[];
  }>;
  firemaking: Array<{
    logItemId: string;
    levelRequired: number;
  }>;
  crafting: Array<{
    outputItemId: string;
    category: string;
    inputs: Array<{ itemId: string; quantity: number }>;
    tools: string[];
    consumables: Array<{ itemId: string; uses: number }>;
    levelRequired: number;
    station: string;
  }>;
  tanning: Array<{
    inputItemId: string;
    outputItemId: string;
    coinCost: number;
  }>;
  fletching: Array<{
    recipeId: string;
    outputItemId: string;
    outputQuantity: number;
    category: string;
    inputs: Array<{ itemId: string; quantity: number }>;
    tools: string[];
    levelRequired: number;
  }>;
  runecrafting: Array<{
    runeType: string;
    runeItemId: string;
    essenceItemIds: string[];
    levelRequired: number;
  }>;
  /** Public authored combat combinations used for ordinary-world readiness. */
  combatReadiness?: {
    ammunitionTarget: number;
    magicCastTarget: number;
    melee: Array<{
      weaponId: string;
      weaponScore: number;
      requiredAttackLevel: number;
    }>;
    ranged: Array<{
      weaponId: string;
      ammunitionId: string;
      weaponScore: number;
      ammunitionScore: number;
      requiredRangedLevel: number;
    }>;
    magic: Array<{
      weaponId: string;
      spellId: string;
      weaponScore: number;
      spellOrder: number;
      requiredMagicLevel: number;
      providedRuneIds: string[];
      runes: Array<{ itemId: string; quantityPerCast: number }>;
    }>;
  };
}

/** Exact server-loaded workstation data used by the pure behavior worker. */
export interface WorkerStationData {
  entityId: string;
  position: [number, number, number];
  name: string;
  stationType: string;
  /** Authoritative interaction range read from the live entity configuration. */
  interactionRange: number;
  /**
   * Exact centered runtime footprint used by server interaction authority.
   * Optional only for rolling compatibility with an older paired worker;
   * the production bridge always publishes both dimensions.
   */
  footprintWidth?: number;
  footprintDepth?: number;
}

// ─── Shared world data (sent once per tick batch, not per agent) ─────────────

/** Data that is identical for all agents in a tick batch */
export interface SharedTickData {
  npcPositions: Array<{
    id: string;
    name: string;
    npcId: string;
    position: [number, number, number];
  }>;
  spawnAnchors: Array<{
    position: [number, number, number];
    name: string;
  }>;
  worldResources: Array<{
    entityId: string;
    position: [number, number, number];
    name: string;
    /** Exact gathering-manifest variant identifier. */
    resourceId: string;
    resourceType: string;
    depleted: boolean;
  }>;
  worldMobs: Array<{
    position: [number, number, number];
    mobType: string;
  }>;
  stationPositions: WorkerStationData[];
  storePositions: Array<{
    entityId: string;
    storeId: string;
    name: string;
    position: [number, number, number];
  }>;
  otherAgentTargets: Array<{ agentId: string; targetId: string | null }>;
  resourceSystemAvailable: boolean;
}

// ─── Per-agent tick input ───────────────────────────────────────────────────

/** Snapshot of agent state sent to worker for decision-making */
export interface AgentTickInput {
  characterId: string;
  combatSpecialization: "melee" | "ranged" | "mage";
  /** Monotonic fence captured with this decision snapshot. */
  behaviorEpoch: number;
  playerId: string | null;
  name: string;
  gameState: EmbeddedGameState;
  inventoryItems: Array<{ slot: number; itemId: string; quantity: number }>;
  equippedItems: Record<string, string | null>;
  questState: AgentQuestProgress[];
  availableQuests: AgentQuestInfo[];
  /** Main-thread backoff after a rejected secure store transaction. */
  storeRetryAfter: number;
  /**
   * Main-thread boolean fence after an exact insufficient-coin rejection.
   * No balance, deficit, purchase, inventory, or custody detail crosses.
   */
  coinRecoveryAuthorized?: boolean;
  /** Process-local timestamp fencing a new target after attack dispatch. */
  attackObservationRetryAfter: number;
  /** Main-thread backoff after no eligible private bank batch was found. */
  bankStageRetryAfter: number;
  /**
   * Public control fence: the main process checked the private bank for this
   * quest and found no stageable training path. No bank item or count crosses.
   */
  questEntryAcquisitionQuestId: string | null;
  /**
   * Main-thread authorization after an exact general processing-bank miss.
   * The worker derives the public recipe and source path independently.
   */
  ordinaryProcessingAcquisitionAuthorized?: boolean;
  /** Exact main-thread authorization after a private survival-food bank miss. */
  survivalFoodAcquisitionAuthorized: boolean;
  /** Active exact-recipe suppressions; contains no bank, coin, or custody state. */
  ordinaryProcessingRetrySuppressions: OrdinaryProcessingRetrySuppression[];
  agentState: {
    goal: AgentGoal | null;
    questsAccepted: string[];
    currentTargetId: string | null;
    lastAteAt: number;
    dropCooldownUntil: number;
    lastGatherTargetId: string | null;
    lastGatherQueuedAt: number;
    pendingChatReaction: PendingChatReaction | null;
    lastCombatChatAt: number;
  };

  /** When true, skip autonomous action picking (operator sent a dashboard command).
   *  Survival tasks (eating, equipment, shopping) still run. */
  operatorGrace?: boolean;

  // ── Legacy fields kept for backward compat with AgentBehaviorEngine ──
  // These are populated from SharedTickData by the worker before processing
  npcPositions: Array<{
    id: string;
    name: string;
    npcId: string;
    position: [number, number, number];
  }>;
  otherAgentTargets: Array<{ agentId: string; targetId: string | null }>;
  resourceSystemAvailable: boolean;
  spawnAnchors: Array<{
    position: [number, number, number];
    name: string;
  }>;
  worldResources: Array<{
    entityId: string;
    position: [number, number, number];
    name: string;
    /** Exact gathering-manifest variant identifier. */
    resourceId: string;
    resourceType: string;
    depleted: boolean;
  }>;
  /** Exact live mob identities for deterministic distant source navigation. */
  worldMobs: Array<{
    position: [number, number, number];
    mobType: string;
  }>;
  stationPositions: WorkerStationData[];
  storePositions: Array<{
    entityId: string;
    storeId: string;
    name: string;
    position: [number, number, number];
  }>;
}

// ─── Per-agent tick output ──────────────────────────────────────────────────

/** Result of worker decision-making for one agent */
export interface AgentTickOutput {
  characterId: string;
  /** Echoed snapshot fence; stale results must never be applied. */
  behaviorEpoch: number;
  /** Exactly one typed action; the worker cannot bundle hidden mutations. */
  action: EmbeddedBehaviorAction;
  updatedState: {
    goal: AgentGoal | null;
    questsAccepted: string[];
    currentTargetId: string | null;
    lastGatherTargetId: string | null;
    lastGatherQueuedAt: number;
    lastCombatChatAt: number;
  };
  chatMessage?: string;
}

// ─── Message protocol ───────────────────────────────────────────────────────

export type MainToWorkerMessage =
  | {
      type: "init";
      itemsData: Array<[string, WorkerItemData]>;
      processingRecipes: WorkerProcessingRecipeSnapshot;
    }
  | { type: "tick"; agents: AgentTickInput[]; shared: SharedTickData }
  | { type: "shutdown" };

export type WorkerToMainMessage =
  | { type: "ready" }
  | { type: "tickResults"; results: AgentTickOutput[] }
  | { type: "error"; characterId?: string; error: string };
