/**
 * Types for embedded Eliza agents in Hyperia server
 */

import type {
  BankSaveItem,
  DuelPreparationPlanPersistenceSnapshot,
  DuelPreparationPlanRecoveryEvidence,
  BoneBurialReceipt,
  FoodConsumptionReceipt,
  StreamingDuelFoodObservationContext,
  StreamingDuelPrayerObservationContext,
  OwnedDuelPreparationPlanReceipt,
  PrayerActionReceipt,
  World,
} from "@hyperforge/shared";
import type {
  AgentBankActionReceipt,
  AgentBankRetainedItem,
  AgentBankTransferItem,
} from "./AuthoritativeAgentBanking.js";

/**
 * Configuration for an embedded agent
 */
export interface EmbeddedAgentConfig {
  /** Character ID in Hyperia database */
  characterId: string;
  /** Account ID that owns the agent */
  accountId: string;
  /** Agent name for display */
  name: string;
  /** Scripted role for non-LLM bots */
  scriptedRole?: "combat" | "woodcutting" | "fishing" | "mining" | "balanced";
  /** Stable ordinary-world combat preparation identity. */
  combatSpecialization?: "melee" | "ranged" | "mage";
  /**
   * Explicitly enable or disable model-backed planning, chat, and vision.
   * Scripted agents default to disabled; non-scripted agents default to enabled.
   */
  enableLlm?: boolean;
  /** Path to ElizaOS character JSON file (optional) */
  characterJsonPath?: string;
  /** Inline character configuration (alternative to JSON file) */
  characterConfig?: AgentCharacterConfig;
  /** Whether to auto-start the agent on creation */
  autoStart?: boolean;
  /** Supported AI model provider. */
  modelProvider?: "openai" | "anthropic" | "groq";
  /** Specific model to use */
  model?: string;
}

/**
 * Agent character configuration for ElizaOS
 */
export interface AgentCharacterConfig {
  name: string;
  username?: string;
  system?: string;
  bio?: string[];
  /** Persistent character backstory used by ElizaOS prompt construction. */
  lore?: string[];
  topics?: string[];
  adjectives?: string[];
  plugins?: string[];
  /** AI model provider */
  modelProvider?: "openai" | "anthropic" | "groq";
  settings?: {
    secrets?: Record<string, string>;
    avatar?: string;
    /** Specific model to use */
    model?: string;
    [key: string]: unknown;
  };
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
}

/**
 * State of an embedded agent
 */
export type AgentState =
  "initializing" | "running" | "paused" | "stopped" | "error";

/**
 * Information about a running embedded agent
 */
export interface EmbeddedAgentInfo {
  agentId: string;
  characterId: string;
  accountId: string;
  name: string;
  scriptedRole?: "combat" | "woodcutting" | "fishing" | "mining" | "balanced";
  llmEnabled: boolean;
  state: AgentState;
  entityId: string | null;
  position: [number, number, number] | null;
  health: number | null;
  maxHealth: number | null;
  startedAt: number;
  lastActivity: number;
  error?: string;
  goal?: {
    type: string;
    description: string;
    questId?: string;
    questName?: string;
  } | null;
}

/**
 * Game state for an embedded agent (provided to ElizaOS)
 */
export interface EmbeddedGameState {
  playerId: string;
  position: [number, number, number] | null;
  health: number;
  maxHealth: number;
  alive: boolean;
  skills: Record<string, { level: number; xp: number }>;
  inventory: Array<{ slot: number; itemId: string; quantity: number }>;
  equipment: Record<string, { itemId: string; quantity?: number }>;
  nearbyEntities: NearbyEntityData[];
  inCombat: boolean;
  currentTarget: string | null;
  /** Authoritative persisted combat spell selection. */
  selectedSpell?: string | null;
  activePrayers: string[];
  prayerPointUnits?: number;
  prayerPoints?: number;
  prayerMaxPoints?: number;
}

export interface EquipmentActionReceipt {
  ok: boolean;
  playerId: string;
  itemId: string;
  slot: string | null;
  changed: boolean;
  reason?:
    | "player_missing"
    | "equipment_not_initialized"
    | "item_not_found"
    | "not_equippable"
    | "requirements_not_met"
    | "item_not_owned"
    | "equip_rejected"
    | "unequip_rejected"
    | "equipment_system_unavailable";
}

export interface DuelPreparationPlanExecutionRequest {
  operationId: string;
  preparationId: string;
  expectedBank: BankSaveItem[];
  committed: DuelPreparationPlanPersistenceSnapshot;
  recoveryEvidence: DuelPreparationPlanRecoveryEvidence;
}

/**
 * Data about a nearby entity
 */
export interface NearbyEntityData {
  id: string;
  name: string;
  type: "player" | "mob" | "npc" | "item" | "resource" | "object";
  position: [number, number, number];
  distance: number;
  health?: number;
  maxHealth?: number;
  level?: number;
  mobType?: string;
  itemId?: string;
  /** Manifest/resource-system variant identifier when distinct from entity ID. */
  resourceId?: string;
  resourceType?: string;
  /** Server-authoritative skill level required to gather this resource. */
  requiredLevel?: number;
  equippedWeapon?: string;
}

/**
 * Command types that agents can execute
 */
export type AgentCommandType =
  | "move"
  | "attack"
  | "gather"
  | "pickup"
  | "drop"
  | "equip"
  | "unequip"
  | "use"
  | "chat"
  | "stop"
  | "bank_deposit"
  | "bank_withdraw";

/**
 * Base command interface
 */
export interface AgentCommand {
  type: AgentCommandType;
  timestamp: number;
}

/**
 * Move command
 */
export interface MoveCommand extends AgentCommand {
  type: "move";
  target: [number, number, number];
  runMode?: boolean;
}

/**
 * Attack command
 */
export interface AttackCommand extends AgentCommand {
  type: "attack";
  targetId: string;
}

/**
 * Gather resource command
 */
export interface GatherCommand extends AgentCommand {
  type: "gather";
  resourceId: string;
}

/**
 * Pickup item command
 */
export interface PickupCommand extends AgentCommand {
  type: "pickup";
  itemId: string;
}

/**
 * Active quest progress data returned to agent actions
 */
export interface AgentQuestProgress {
  questId: string;
  name: string;
  status: string;
  currentStage: string;
  stageDescription: string;
  stageProgress: Record<string, number>;
  stageType: "dialogue" | "kill" | "gather" | "interact" | "travel" | "unknown";
  stageTarget?: string;
  stageCount?: number;
  startNpc: string;
}

/**
 * Quest definition info returned to agent actions for quest discovery
 */
export interface AgentQuestInfo {
  questId: string;
  name: string;
  description: string;
  difficulty: string;
  status: string;
  /** Authoritative snapshot eligibility; consumers must treat absence/false as locked. */
  canStart: boolean;
  /** Public authored requirements only; no private inventory counts are exposed. */
  requirements: {
    quests: string[];
    skills: Record<string, number>;
    items: string[];
  };
  startNpc: string;
  onStartItems: Array<{ itemId: string; quantity: number }>;
  rewardItems: Array<{ itemId: string; quantity: number }>;
  stages: Array<{
    id: string;
    type: string;
    description: string;
    target?: string;
    count?: number;
  }>;
}

/** Fail-closed predicate shared by every agent quest-selection surface. */
export function isStartableAgentQuest(quest: AgentQuestInfo): boolean {
  return quest.status === "not_started" && quest.canStart === true;
}

/**
 * Interface for the embedded Hyperia service
 * Provides direct world access instead of WebSocket
 */
export interface IEmbeddedHyperiaService {
  /** Get the world instance */
  getWorld(): World;

  /** Update the live agent display name. Persistence remains manager-owned. */
  setDisplayName(displayName: string): void;

  /** Get current game state for the agent */
  getGameState(): EmbeddedGameState | null;

  /** Short world-map summary for LLM prompts (towns, POIs, resources near the agent). */
  formatMapAwarenessForLlm(): string;

  /** Horizontal facing (radians), for operator intent targeting; null if unknown */
  getPlayerYaw(): number | null;

  /** Get nearby entities */
  getNearbyEntities(): NearbyEntityData[];

  /** Drop cached nearby scan so the next read reflects the current world (e.g. dashboard orders). */
  invalidateNearbyEntityCache(): void;

  /** Execute a move command */
  executeMove(
    target: [number, number, number],
    runMode?: boolean,
  ): Promise<boolean>;

  /** Execute an attack command */
  executeAttack(targetId: string): Promise<boolean>;

  /** Execute a gather resource command */
  executeGather(
    resourceId: string,
    autonomyAttemptId?: string,
  ): Promise<boolean>;

  /** Execute a pickup item command */
  executePickup(itemId: string, autonomyAttemptId?: string): Promise<boolean>;

  /** Loot owned gravestone custody and wait for the exact authoritative result. */
  executeLootGravestone(
    gravestoneId: string,
    autonomyAttemptId: string,
  ): Promise<boolean>;

  /** Execute a drop item command */
  executeDrop(itemId: string, quantity?: number): Promise<boolean>;

  /** Execute an owned-item equip command and return its authoritative postcondition. */
  executeEquip(itemId: string): Promise<EquipmentActionReceipt>;

  /** Unequip a worn item and return its authoritative conserved postcondition. */
  executeUnequipOwned(slot: string): Promise<EquipmentActionReceipt>;

  /** Commit the complete selected-contestant preparation custody transition. */
  executeDuelPreparationPlan(
    request: DuelPreparationPlanExecutionRequest,
  ): Promise<OwnedDuelPreparationPlanReceipt>;

  /** Recover an exact committed plan receipt without invoking a planner. */
  executeDuelPreparationPlanRecovery(
    operationId: string,
    preparationId: string,
  ): Promise<OwnedDuelPreparationPlanReceipt | null>;

  /** Replace stale live custody mirrors from persistence during private preparation. */
  executeDuelPreparationCustodyRefresh(preparationId: string): Promise<boolean>;

  /** Open a nearby authoritative bank and return its committed snapshot. */
  executeBankOpen(bankId: string): Promise<AgentBankActionReceipt>;

  /** Open this agent's bank through its durable private on-deck capability. */
  executeDuelPreparationBankOpen(
    preparationId: string,
  ): Promise<AgentBankActionReceipt>;

  /** Atomically move an exact owned inventory quantity into the open bank. */
  executeBankDeposit(
    itemId: string,
    quantity?: number,
    operationId?: string,
  ): Promise<AgentBankActionReceipt>;

  /** Atomically move an exact owned bank quantity into inventory. */
  executeBankWithdraw(
    itemId: string,
    quantity?: number,
    operationId?: string,
  ): Promise<AgentBankActionReceipt>;

  /** Atomically stage every exact component or leave all custody unchanged. */
  executeBankWithdrawPlan(
    items: AgentBankTransferItem[],
    operationId?: string,
  ): Promise<AgentBankActionReceipt>;

  /** Main-process-only live gameplay coin balance; never sent to the worker. */
  getPrivateCoinBalance(): number | null;

  /** Atomically bank every carried item except the exact private retained set. */
  executeBankDepositAll(
    operationId?: string,
    retainedItems?: AgentBankRetainedItem[],
    bankId?: string,
  ): Promise<AgentBankActionReceipt>;

  /** Execute a food action and return its authoritative custody/effect receipt. */
  executeUse(
    itemId: string,
    publicActionObservation?: StreamingDuelFoodObservationContext,
  ): Promise<FoodConsumptionReceipt>;

  /** Atomically consume one prayer resource and converge its committed XP. */
  executeBury(itemId: string, operationId?: string): Promise<BoneBurialReceipt>;

  /** Execute a prayer toggle and return its authoritative persisted state. */
  executePrayer(prayerId: string): Promise<PrayerActionReceipt>;

  /** Explicit prayer toggle alias used by the duel tactical controller. */
  executePrayerToggle(
    prayerId: string,
    publicActionObservation?: StreamingDuelPrayerObservationContext,
  ): Promise<PrayerActionReceipt>;

  /** Deactivate every prayer and return the authoritative persisted state. */
  executePrayerDeactivateAll(): Promise<PrayerActionReceipt>;

  /** Select a validated combat spell and confirm the authoritative post-state. */
  executeSetAutocast(spellId: string | null): Promise<boolean>;

  /** Execute a chat message command. Returns false if the chat system was unavailable. */
  executeChat(message: string): Promise<boolean>;

  /** Stop current action */
  executeStop(): Promise<boolean>;

  /** Fence new combat admission for one exact private duel preparation. */
  beginDuelPreparationCombatFence(preparationId: string): boolean;

  /** Release only the exact private duel preparation's combat fence. */
  endDuelPreparationCombatFence(preparationId: string): boolean;

  /** Check if the agent's player entity is spawned */
  isSpawned(): boolean;

  /** Get the agent's player entity ID */
  getPlayerId(): string | null;

  /** Register event handler */
  onGameEvent(event: string, handler: (data: unknown) => void): void;

  /** Unregister event handler */
  offGameEvent(event: string, handler: (data: unknown) => void): void;

  /** Get active quest state with progress details */
  getQuestState(): AgentQuestProgress[];

  /** Get all quest definitions with status for quest discovery */
  getAvailableQuests(): AgentQuestInfo[];

  /** Get all NPC positions in the world (for quest navigation) */
  getAllNPCPositions(): Array<{
    id: string;
    name: string;
    npcId: string;
    position: [number, number, number];
  }>;

  /** Accept a quest by ID */
  executeQuestAccept(questId: string): Promise<boolean>;

  /** Complete a quest by ID (must be ready_to_complete) */
  executeQuestComplete(questId: string): Promise<boolean>;

  /**
   * Constrain all movement to the given XZ rectangle.
   * Any executeMove call whose target falls outside the bounds is clamped to
   * the nearest legal point before being dispatched — preventing out-of-bounds
   * movement at the source rather than correcting it reactively.
   */
  setArenaBounds(bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }): void;

  /** Remove the arena movement constraint set by setArenaBounds(). */
  clearArenaBounds(): void;
}
