/**
 * Type definitions for @hyperforge/plugin-hyperia
 *
 * This file defines the TypeScript interfaces and types used throughout the plugin
 * to connect ElizaOS AI agents to Hyperia game worlds.
 *
 * NOTE: This plugin is standalone and defines all types it needs based on the
 * Hyperia server's WebSocket protocol. It does NOT import from @hyperforge/shared.
 */

import type { IAgentRuntime } from "@elizaos/core";

/**
 * Basic types matching Hyperia server protocol
 */

// Event types that the Hyperia server sends
export type EventType =
  | "PLAYER_JOINED"
  | "PLAYER_LEFT"
  | "PLAYER_SPAWNED"
  | "PLAYER_DIED" // @deprecated — use PLAYER_SET_DEAD for client death UI, or ENTITY_DEATH for server-side death processing
  | "ENTITY_DEATH"
  | "ENTITY_JOINED"
  | "ENTITY_LEFT"
  | "ENTITY_UPDATED"
  | "COMBAT_STARTED"
  | "COMBAT_ENDED"
  | "COMBAT_KILL"
  | "COMBAT_ATTACK"
  | "COMBAT_DAMAGE_DEALT"
  | "RESOURCE_GATHERED"
  | "RESOURCE_DEPLETED"
  | "RESOURCE_RESPAWNED"
  | "SKILLS_LEVEL_UP"
  | "SKILLS_XP_GAINED"
  | "SKILLS_UPDATED"
  | "INVENTORY_UPDATED"
  | "ITEM_PICKED_UP"
  | "ITEM_DROPPED"
  | "ITEM_DROP_RESULT"
  | "PLAYER_EQUIPMENT_CHANGED"
  | "CHAT_MESSAGE"
  | "CRAFTING_COMPLETE"
  | "CRAFTING_PROGRESS"
  | "CRAFTING_REJECTED"
  | "CRAFTING_STATUS"
  | "DUEL_FIGHT_START"
  | "DUEL_SESSION_STARTED"
  | "DUEL_COMPLETED"
  | "DUEL_CANCELLED"
  | "DUEL_ON_DECK"
  | "DUEL_PREPARATION_REVOKED"
  | "DUEL_PREPARATION_STATUS"
  | "DUEL_COUNTDOWN_START"
  | "DUEL_COUNTDOWN_TICK"
  | "DUEL_OPPONENT_DISCONNECTED"
  | "DUEL_OPPONENT_RECONNECTED";

// Goal types used by the autonomous behavior system
export type AvailableGoalType =
  | "combat_training"
  | "woodcutting"
  | "fishing"
  | "mining"
  | "smithing"
  | "firemaking"
  | "cooking"
  | "exploration"
  | "idle"
  | "questing"
  | "banking";

// CurrentGoal can include internal user-command goals
export type GoalType = AvailableGoalType | "user_command";

// Network message from server
export interface NetworkEvent {
  type: EventType;
  data: unknown;
  timestamp?: number;
}

export type GroundItemDropResult =
  | {
      success: true;
      committed: true;
      playerId: string;
      operationId: string;
      itemId: string;
      quantity: number;
      sourceId: string;
      position: { x: number; y: number; z: number };
      replayed: boolean;
      liveInventoryApplied: boolean;
      liveCoinsApplied: boolean;
      presentationReady: boolean;
    }
  | {
      success: false;
      committed: false | "unknown";
      playerId: string;
      operationId: string;
      itemId: string;
      quantity: number;
      reason: string;
    };

// Combat styles
export type CombatStyle = "attack" | "strength" | "defense" | "ranged";

// Inventory item structure
// Items have 'name' (display name) and optionally 'itemId' (item type identifier)
export interface InventoryItem {
  id: string;
  name: string;
  itemId?: string;
  quantity: number;
  slot?: number;
  item?: { name?: string };
}

// Skills structure
export interface Skills {
  attack: { level: number; xp: number };
  strength: { level: number; xp: number };
  defense: { level: number; xp: number };
  constitution: { level: number; xp: number };
  ranged: { level: number; xp: number };
  woodcutting: { level: number; xp: number };
  mining: { level: number; xp: number };
  fishing: { level: number; xp: number };
  firemaking: { level: number; xp: number };
  cooking: { level: number; xp: number };
  [key: string]: { level: number; xp: number };
}

// Equipment structure
export interface Equipment {
  weapon: string | null;
  shield: string | null;
  helmet: string | null;
  body: string | null;
  legs: string | null;
  boots: string | null;
  gloves: string | null;
  cape: string | null;
  amulet: string | null;
  ring: string | null;
  arrows: string | null;
}

// Base entity structure
// Nearby entities from the server can be players, mobs, resources, NPCs, or items.
// All share these fields; optional fields cover the polymorphic server data.
export interface Entity {
  id: string;
  name: string;
  position: [number, number, number];
  rotation?: [number, number, number, number];
  type?: string;
  entityType?: string;
  alive?: boolean;
  dead?: boolean;
  level?: number;
  mobType?: string;
  resourceType?: string;
  resourceId?: string;
  requiredLevel?: number;
  harvestSkill?:
    "woodcutting" | "fishing" | "mining" | "firemaking" | "cooking";
  depleted?: boolean;
  itemId?: string;
  playerId?: string;
  playerName?: string;
  health?: { current: number; max: number };
  npcType?: string;
  runeType?: string;
}

// Player entity structure (what we receive from server)
export interface PlayerEntity extends Entity {
  playerId: string;
  playerName: string;
  hyperiaPlayerId: string;

  // Health & Status
  health: { current: number; max: number };
  stamina: { current: number; max: number };
  alive: boolean;

  // Skills
  skills: Skills;

  // Inventory
  items: InventoryItem[];
  coins: number;

  // Equipment
  equipment: Equipment;

  // Combat
  combatStyle: CombatStyle;
  inCombat: boolean;
  combatTarget: string | null;

  // Server-authoritative Prayer custody state
  activePrayers?: string[];
  prayerPointUnits?: number;
  prayerPoints?: number;
  prayerMaxPoints?: number;
}

export type PrayerActionFailureReason =
  | "invalid_request"
  | "player_not_initialized"
  | "unknown_prayer"
  | "level_requirement"
  | "no_prayer_points"
  | "too_many_active"
  | "rate_limited"
  | "atomic_persistence_unavailable"
  | "state_conflict"
  | "persistence_failed";

/** Exact server receipt returned for one correlated Prayer request. */
export interface PrayerActionReceipt {
  success: boolean;
  committed: boolean;
  playerId: string;
  operationId: string;
  replayed: boolean;
  pointUnits: number;
  points: number;
  maxPoints: number;
  activePrayers: string[];
  reason?: PrayerActionFailureReason;
  message?: string;
}

export interface ExternalAgentBankRetainedItem {
  itemId: string;
  quantity: number;
}

export type ExternalAgentBankAction = "deposit" | "withdraw" | "deposit_all";

export interface ExternalAgentBankEnvelope {
  action: ExternalAgentBankAction;
  bankId: string;
  itemId: string | null;
  quantity: number;
  retainedItems: ExternalAgentBankRetainedItem[];
}

/** Exact server-owned receipt for one ordinary external-agent bank command. */
export interface ExternalAgentBankActionReceipt {
  success: boolean;
  operationId: string;
  commitState: "not_committed" | "committed" | "unknown";
  replayed: boolean;
  action: ExternalAgentBankAction;
  playerId: string | null;
  bankId: string | null;
  itemId: string | null;
  requestedQuantity: number;
  committedQuantity: number;
  inventoryQuantityAfter: number | null;
  bankQuantityAfter: number | null;
  failureReason?: string;
}

// Mob/NPC entity (for type checking)
export interface MobEntity extends Entity {
  mobType: string;
  level?: number;
}

// Resource entity (for type checking)
export interface ResourceEntity extends Entity {
  resourceType: string;
  requiredLevel?: number;
  harvestSkill?:
    "woodcutting" | "fishing" | "mining" | "firemaking" | "cooking";
  depleted?: boolean;
}

/**
 * Quest data from the server
 */
export interface QuestData {
  name?: string;
  questId?: string;
  status?: string;
  description?: string;
  currentStage?: string;
  stageProgress?: Record<string, number>;
  startNpc?: string;
  stageType?: string;
  stageTarget?: string;
  stageCount?: number;
}

/**
 * Plugin configuration from environment variables
 */
export interface HyperiaPluginConfig {
  HYPERIA_SERVER_URL?: string;
  HYPERIA_SERVER_PORT?: string;
  HYPERIA_AUTO_RECONNECT?: string;
}

/**
 * Cached game state maintained by HyperiaService
 */
/**
 * World map data received from server snapshot
 * Contains town and POI locations for agent navigation
 */
export interface WorldMapTown {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
  size: string;
  biome: string;
  buildings: Array<{ type: string }>;
}

export interface WorldMapPOI {
  id: string;
  name: string;
  category: string;
  position: { x: number; y: number; z: number };
  biome: string;
}

export interface WorldMapResource {
  type: string;
  resourceId: string;
  position: { x: number; y: number; z: number };
  areaId: string;
}

export interface WorldMapStation {
  id: string;
  type: string;
  position: { x: number; y: number; z: number };
  areaId: string;
}

export interface WorldMapNPC {
  id: string;
  type: string;
  name?: string;
  position: { x: number; y: number; z: number };
  areaId: string;
}

export interface WorldMapData {
  towns: WorldMapTown[];
  pois: WorldMapPOI[];
  resources?: WorldMapResource[];
  stations?: WorldMapStation[];
  npcs?: WorldMapNPC[];
}

/** A single item stored in the bank */
export interface BankItem {
  itemId: string;
  name?: string;
  quantity: number;
  slot?: number;
  tabIndex?: number;
}

export interface GameStateCache {
  playerEntity: PlayerEntity | null;
  nearbyEntities: Map<string, Entity>;
  currentRoomId: string | null;
  worldId: string | null;
  lastUpdate: number;
  /** World map data (towns, POIs, resources, stations, NPCs) from server snapshot */
  worldMap?: WorldMapData;
  /** Active quests */
  quests: QuestData[];
  /** Cached bank contents (populated when bank is opened or on spawn) */
  bankItems: BankItem[];
  /** Timestamp when bank items were last updated from server */
  bankItemsUpdatedAt?: number;
  /** Timestamp when quest list was last updated from server */
  questsUpdatedAt?: number;
  /** Timestamp when inventory was last updated from server */
  inventoryUpdatedAt?: number;
}

/**
 * WebSocket connection state
 */
export interface ConnectionState {
  connected: boolean;
  connecting: boolean;
  lastConnectAttempt: number;
  reconnectAttempts: number;
}

/**
 * Command payloads for game actions
 */
export interface MoveToCommand {
  target: [number, number, number]; // [x, y, z]
  runMode?: boolean;
  cancel?: boolean; // If true, cancels current movement path
}

export interface AttackEntityCommand {
  targetEntityId: string;
  combatStyle?: CombatStyle;
}

export interface UseItemCommand {
  itemId: string;
  slot?: number;
}

export interface EquipItemCommand {
  itemId: string;
  equipSlot: keyof Equipment;
}

export interface ChatMessageCommand {
  message: string;
  roomId?: string;
}

export interface GatherResourceCommand {
  resourceEntityId: string;
  skill: "woodcutting" | "mining" | "fishing" | "firemaking" | "cooking";
}

export interface BankCommand {
  action: "deposit" | "withdraw";
  itemId?: string;
  amount?: number;
}

/**
 * Duel system command payloads
 */
export interface DuelChallengeCommand {
  targetPlayerId: string;
}

export interface DuelChallengeResponseCommand {
  challengeId: string;
  accept: boolean;
}

/**
 * Pending duel challenge from another player
 */
export interface PendingDuelChallenge {
  challengeId: string;
  challengerId: string;
  challengerName: string;
  challengerCombatLevel: number;
  expiresAt: number;
}

/**
 * Action validation context
 */
export interface ActionContext {
  playerEntity: PlayerEntity;
  nearbyEntities: Entity[];
  availableItems: InventoryItem[];
}

/**
 * Provider result data structures
 */
export interface GameStateData {
  health: { current: number; max: number };
  stamina: { current: number; max: number };
  position: [number, number, number];
  inCombat: boolean;
  combatTarget: string | null;
  alive: boolean;
}

export interface InventoryData {
  items: InventoryItem[];
  coins: number;
  freeSlots: number;
}

export interface NearbyEntitiesData {
  players: Array<{
    name: string;
    entityId: string;
    position: [number, number, number];
  }>;
  npcs: Array<{
    name: string;
    entityId: string;
    position: [number, number, number];
  }>;
  resources: Array<{
    name: string;
    entityId: string;
    position: [number, number, number];
    type: string;
  }>;
}

export interface SkillsData {
  skills: Skills;
  totalLevel: number;
  combatLevel: number;
}

export interface EquipmentData {
  weapon: string | null;
  shield: string | null;
  armor: {
    helmet: string | null;
    body: string | null;
    legs: string | null;
    boots: string | null;
    gloves: string | null;
    cape: string | null;
  };
  accessories: {
    amulet: string | null;
    ring: string | null;
    arrows: string | null;
  };
}

/**
 * Memory storage types for game events
 */
export interface GameEventMemory {
  eventType: EventType;
  timestamp: number;
  description: string;
  tags: string[];
  data: Record<string, unknown>;
}

export interface CombatMemory extends GameEventMemory {
  opponent: string;
  outcome: "victory" | "defeat" | "ongoing";
  damageDealt: number;
  damageTaken: number;
}

export interface ResourceMemory extends GameEventMemory {
  resourceType: string;
  location: [number, number, number];
  skillUsed: string;
  xpGained: number;
}

/**
 * Service interface extensions
 */
export interface HyperiaServiceInterface {
  // Connection management
  connect(serverUrl: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // State access
  getPlayerEntity(): PlayerEntity | null;
  getNearbyEntities(): Entity[];
  getGameState(): GameStateCache;
  getWorldMapSignature(): string | null;

  // Command execution
  executeMove(command: MoveToCommand): Promise<void>;
  executeAttack(command: AttackEntityCommand): Promise<void>;
  executeUseItem(command: UseItemCommand): Promise<void>;
  executeEquipItem(command: EquipItemCommand): Promise<void>;
  executeDropItem(
    itemId: string,
    quantity?: number,
    slot?: number,
    operationId?: string,
  ): Promise<GroundItemDropResult>;
  executeChatMessage(command: ChatMessageCommand): Promise<void>;
  executeGatherResource(command: GatherResourceCommand): Promise<void>;
  executeTanning(
    tannerEntityId: string,
    inputItemId: "cowhide" | "green_dragonhide",
    quantity: number,
  ): Promise<boolean>;
  executeSmelting(
    furnaceEntityId: string,
    barItemId: string,
    quantity: number,
  ): Promise<boolean>;
  executeSmithing(
    anvilEntityId: string,
    recipeId: string,
    quantity: number,
  ): Promise<boolean>;
  executeRunecrafting(
    altarEntityId: string,
    runeType: string,
  ): Promise<boolean>;
  executeFletching(recipeId: string, quantity: number): Promise<boolean>;
  executeCooking(): Promise<boolean>;
  executeFiremaking(): Promise<boolean>;
  openBank(bankId: string): Promise<boolean>;
  bankDeposit(itemId: string, quantity: number): Promise<boolean>;
  bankDepositAll(
    retainedItems?: ExternalAgentBankRetainedItem[],
  ): Promise<boolean>;
  bankWithdraw(itemId: string, quantity: number): Promise<boolean>;
  closeBank(): Promise<void>;
  executeTogglePrayer(prayerId: string): Promise<PrayerActionReceipt>;
  executeChangeAttackStyle(newStyle: string): Promise<void>;

  // Event registration
  onGameEvent(
    eventType: EventType,
    handler: (data: unknown) => void | Promise<void>,
  ): void;
  offGameEvent(
    eventType: EventType,
    handler: (data: unknown) => void | Promise<void>,
  ): void;

  // Duel commands
  executeDuelChallenge(command: DuelChallengeCommand): Promise<void>;
  executeDuelChallengeResponse(
    command: DuelChallengeResponseCommand,
  ): Promise<void>;
  getPendingDuelChallenge(): PendingDuelChallenge | null;

  // Quest system
  getQuestState(): QuestData[];
  requestQuestList(): void;
  sendQuestAccept(questId: string): void;
  sendQuestComplete(questId: string): void;
}

/**
 * Runtime extensions
 */
export interface HyperiaAgentRuntime extends IAgentRuntime {
  getService<T>(serviceType: string): T;
}
