/**
 * System Type Definitions
 *
 * Type definitions for game systems:
 * - System interfaces (what methods systems expose)
 * - Runtime data structures (internal system state)
 * - System-specific types (combat, loot, spawning)
 * - Type guards and helpers
 */

import { Entity } from "../../entities/Entity";
import * as THREE from "../../extras/three/three";
import type { CombatData } from "../../systems/shared";
import type { System } from "../../systems/shared";
import type { World } from "../../core/World";
import type {
  BankItem,
  InventorySlotItem,
  StoreItem,
  Item,
  MobStats,
  Position3D,
  Player,
} from "../core";
import type { PxScene } from "./physics";
import type {
  PlayerRow,
  PlayerPersistenceUpdate,
  InventoryRow,
  EquipmentRow,
  WorldChunkRow,
  PlayerSessionRow,
  InventorySaveItem,
  EquipmentSaveItem,
  CombatLoadoutCommitRequest,
  CombatLoadoutCommitReceipt,
  DuelPreparationPlanCommitRequest,
  DuelPreparationPlanCommitReceipt,
  DuelPreparationPlanRecoveryRequest,
  InventoryDebitCommitRequest,
  InventoryDebitCommitReceipt,
  ProjectileRuneCostCommitRequest,
  ProjectileRuneCostCommitReceipt,
  ProjectileRuneCostSettlementRequest,
  GroundItemSourceRegistrationRequest,
  GroundItemSourceRegistrationReceipt,
  GroundItemDropCommitRequest,
  GroundItemDropCommitReceipt,
  GroundItemDeathCommitRequest,
  GroundItemDeathCommitReceipt,
  GroundItemMobLootCommitRequest,
  GroundItemMobLootCommitReceipt,
  GroundItemSourceState,
  GroundItemPickupCommitRequest,
  GroundItemPickupCommitReceipt,
  FoodConsumptionCommitRequest,
  FoodConsumptionCompleteRequest,
  FoodConsumptionCommitReceipt,
  DuelDamageCommitRequest,
  DuelDamageCommitReceipt,
  BoneBurialCommitRequest,
  BoneBurialCommitReceipt,
  QuestStartCommitRequest,
  QuestStartCommitReceipt,
  QuestCompletionCommitRequest,
  QuestCompletionCommitReceipt,
  GatheringRewardCommitRequest,
  GatheringRewardCommitReceipt,
  GatheringResourceState,
  ProcessingActionCommitRequest,
  ProcessingActionCommitReceipt,
  ProcessingActionSkill,
  ProcessingActionFireEffect,
  ActiveProcessingFire,
  ProcessingFireExtinguishCommitRequest,
  ProcessingFireExtinguishCommitReceipt,
  EquipmentStackDebitCommitRequest,
  EquipmentStackDebitCommitReceipt,
  AmmunitionShotCommitRequest,
  AmmunitionShotCommitReceipt,
  AmmunitionShotSettlementRequest,
  PrayerStateCommitRequest,
  PrayerStateCommitReceipt,
  AttackStyleCommitRequest,
  AttackStyleCommitReceipt,
  StreamingDuelExecutorCommandRequest,
  StreamingDuelExecutorCommandCompletionRequest,
  StreamingDuelExecutorCommandReceipt,
  ItemRow,
} from "../network/database";
import type { FlatZone } from "../world/terrain";
import type {
  ProcessingSkill,
  ProcessingRequestEnvelope,
  RecoverableProcessingRequest,
} from "../events";
import type {
  DuelRules,
  DuelState,
  EquipmentSlotRestriction,
  StakedItem,
} from "../game/duel-types";

// ============================================================================
// CORE SYSTEM INTERFACES
// ============================================================================

export interface PhysicsSystem extends System {
  scene: PxScene;
  createLayerMask(...layers: string[]): number;
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance?: number,
    layerMask?: number,
  ): unknown;
  addActor(actor: unknown, handle: unknown): unknown;
  clean(): void;
}

export interface StageSystem extends System {
  scene: THREE.Scene;
  THREE: typeof THREE;
  clean(): void;
}

export interface ChatSystem extends System {
  add(message: { from: string; body: string }, broadcast?: boolean): void;
  subscribe(callback: (messages: unknown[]) => void): () => void;
  send(text: string): unknown;
}

export interface ClientInputSystem extends System {
  setEnabled(enabled: boolean): void;
  keyX?: {
    pressed: boolean;
    released: boolean;
    onPress?: () => void;
    onRelease?: () => void;
  };
  setKey(key: string, value: boolean): void;
}

export interface ClientInterfaceSystem extends System {
  registerCameraSystem(cameraSystem: unknown): void;
  unregisterCameraSystem(cameraSystem: unknown): void;
  toggleVisible(): void;
}

export interface NetworkSystem extends System {
  isClient: boolean;
  isServer: boolean;
  send(event: string, data: unknown): void;
  disconnect(): Promise<void>;
}

export interface EntitiesSystem extends System {
  player: Player;
  get(id: string): unknown;
  modify(id: string, data: unknown): void;
}

export interface TerrainSystem extends System {
  getHeightAt(x: number, z: number): number;
  getHeightAtPosition(x: number, z: number): number;
  isPositionWalkable(
    x: number,
    z: number,
  ): { walkable: boolean; reason?: string };
  getBiomeAt(x: number, z: number): string;
  findWaterAreas(tile: unknown): unknown[];

  // Flat zone methods for terrain flattening under stations
  /**
   * Register a flat zone for terrain flattening.
   * Used for dynamic flat zone registration (e.g., player-placed structures).
   */
  registerFlatZone(zone: FlatZone): void;

  /**
   * Remove a flat zone by ID.
   * Used when dynamic structures are removed.
   */
  unregisterFlatZone(id: string): void;

  /**
   * Check if a position is within a flat zone.
   * Returns the zone if found, null otherwise.
   */
  getFlatZoneAt(worldX: number, worldZ: number): FlatZone | null;
}

export interface LoaderSystem extends System {
  load(type: string, url: string): Promise<unknown>;
  preload(type: string, url: string): void;
  execPreload(): Promise<void>;
  /** Promise that resolves when preload is complete. Can be awaited to ensure all assets are loaded. */
  preloader?: Promise<void> | null;
  insert?(type: string, url: string, data: File): void;
  get?(type: string, url: string): unknown;

  loadModel?(url: string): Promise<THREE.Object3D>;
  loadTexture?(url: string): Promise<THREE.Texture>;
  loadHDR?(url: string): Promise<THREE.DataTexture>;
  loadAvatar?(url: string): Promise<unknown>;
  loadEmote?(url: string): Promise<unknown>;
  loadVideo?(url: string): Promise<unknown>;
}

export interface ActionsSystem extends System {
  btnDown: boolean;
  execute(actionName: string, params?: unknown): Promise<unknown>;
  getAvailable(): string[];
  register(action: unknown): void;
  unregister(name: string): void;
}

// ============================================================================
// DATABASE SYSTEM INTERFACE
// ============================================================================

export interface DatabaseSystem extends System {
  // Player data methods (sync for backward compatibility, async for PostgreSQL)
  getPlayer(playerId: string): PlayerRow | null;
  getPlayerAsync(playerId: string): Promise<PlayerRow | null>;
  savePlayer(playerId: string, data: PlayerPersistenceUpdate): void;
  savePlayerAsync(
    playerId: string,
    data: PlayerPersistenceUpdate,
  ): Promise<void>;

  // Character methods (for character selection)
  getCharacters(accountId: string): Array<{ id: string; name: string }>;
  getCharactersAsync(
    accountId: string,
  ): Promise<Array<{ id: string; name: string }>>;
  createCharacter(
    accountId: string,
    id: string,
    name: string,
  ): Promise<boolean>;

  // Inventory methods
  getPlayerInventory(playerId: string): InventoryRow[];
  getPlayerInventoryAsync(playerId: string): Promise<InventoryRow[]>;
  savePlayerInventory(playerId: string, inventory: InventorySaveItem[]): void;
  savePlayerInventoryAsync(
    playerId: string,
    inventory: InventorySaveItem[],
  ): Promise<void>;

  // Equipment methods
  getPlayerEquipmentAsync(playerId: string): Promise<EquipmentRow[]>;
  savePlayerEquipmentAsync(
    playerId: string,
    equipment: EquipmentSaveItem[],
  ): Promise<void>;

  /** Atomically persist one weapon-valid attack style and optional public receipt. */
  commitAttackStyleOperationAsync(
    request: AttackStyleCommitRequest,
  ): Promise<AttackStyleCommitReceipt>;

  /** Stage one exact movement/engagement command before executor admission. */
  stageStreamingDuelExecutorCommandAsync(
    request: StreamingDuelExecutorCommandRequest,
  ): Promise<StreamingDuelExecutorCommandReceipt>;

  /** Co-commit the executor outcome and its public observation. */
  completeStreamingDuelExecutorCommandAsync(
    request: StreamingDuelExecutorCommandCompletionRequest,
  ): Promise<StreamingDuelExecutorCommandReceipt>;

  /** Recover pending commands for an active cycle after process replacement. */
  listPendingStreamingDuelExecutorCommandsAsync(
    cycleId: string,
  ): Promise<StreamingDuelExecutorCommandReceipt[]>;

  /** Atomically persist inventory, equipment, autocast, and an idempotency receipt. */
  commitCombatLoadoutOperationAsync(
    request: CombatLoadoutCommitRequest,
  ): Promise<CombatLoadoutCommitReceipt>;

  /** Atomically persist a selected contestant's bank, loadout, and autocast. */
  commitDuelPreparationPlanOperationAsync(
    request: DuelPreparationPlanCommitRequest,
  ): Promise<DuelPreparationPlanCommitReceipt>;

  /** Recover one exact committed selected-contestant plan without replanning. */
  getDuelPreparationPlanOperationAsync(
    request: DuelPreparationPlanRecoveryRequest,
  ): Promise<DuelPreparationPlanCommitReceipt | null>;

  /** Atomically debit every requested inventory item and persist one receipt. */
  commitInventoryDebitOperationAsync(
    request: InventoryDebitCommitRequest,
  ): Promise<InventoryDebitCommitReceipt>;

  /** Stage the exact rune cost before a spell projectile is admitted. */
  commitProjectileRuneCostOperationAsync(
    request: ProjectileRuneCostCommitRequest,
  ): Promise<ProjectileRuneCostCommitReceipt>;

  /** Finalize a staged rune cost after local projectile admission. */
  completeProjectileRuneCostOperationAsync(
    request: ProjectileRuneCostSettlementRequest,
  ): Promise<ProjectileRuneCostCommitReceipt>;

  /** Refund a staged rune cost whose projectile was never admitted. */
  cancelProjectileRuneCostOperationAsync(
    request: ProjectileRuneCostSettlementRequest,
  ): Promise<ProjectileRuneCostCommitReceipt>;

  /** Refund interrupted pre-launch rune costs before inventory hydration. */
  recoverPendingProjectileRuneCostOperationsAsync(
    playerId: string,
  ): Promise<ProjectileRuneCostCommitReceipt[]>;

  /** Commit or replay one source contribution before world presentation. */
  registerGroundItemSourceAsync(
    request: GroundItemSourceRegistrationRequest,
  ): Promise<GroundItemSourceRegistrationReceipt>;

  /** Commit a multi-item drop as one all-or-nothing source transaction. */
  registerGroundItemSourcesAsync(
    requests: GroundItemSourceRegistrationRequest[],
  ): Promise<GroundItemSourceRegistrationReceipt[]>;

  /** Atomically debit one owned item/coin quantity and create its source. */
  commitGroundItemDropOperationAsync(
    request: GroundItemDropCommitRequest,
  ): Promise<GroundItemDropCommitReceipt>;

  /** Atomically clear death custody and create every public ground source. */
  commitGroundItemDeathOperationAsync(
    request: GroundItemDeathCommitRequest,
  ): Promise<GroundItemDeathCommitReceipt>;

  /** Atomically record one mob death/loot roll and create every source. */
  commitGroundItemMobLootOperationAsync(
    request: GroundItemMobLootCommitRequest,
  ): Promise<GroundItemMobLootCommitReceipt>;

  /** Reconstruct only active, unclaimed, unexpired sources on replacement. */
  listActiveGroundItemSourcesAsync(): Promise<GroundItemSourceState[]>;

  /** Mark a source expired only after its database-owned deadline. */
  expireGroundItemSourceAsync(sourceId: string): Promise<boolean>;

  /** Atomically claim one ground source and credit its destination custody. */
  commitGroundItemPickupOperationAsync(
    request: GroundItemPickupCommitRequest,
  ): Promise<GroundItemPickupCommitReceipt>;

  /** Debit one food item and durably stage its exactly-once health effect. */
  commitFoodConsumptionOperationAsync(
    request: FoodConsumptionCommitRequest,
  ): Promise<FoodConsumptionCommitReceipt>;

  /** Complete or replay the health effect staged by a food operation. */
  completeFoodConsumptionOperationAsync(
    request: FoodConsumptionCompleteRequest,
  ): Promise<FoodConsumptionCommitReceipt>;

  /** Complete interrupted food effects before the player's health is loaded. */
  recoverPendingFoodConsumptionOperationsAsync(
    playerId: string,
  ): Promise<FoodConsumptionCommitReceipt[]>;

  /** Atomically commit duel target health and its exact public hit observation. */
  commitDuelDamageOperationAsync(
    request: DuelDamageCommitRequest,
  ): Promise<DuelDamageCommitReceipt>;

  /** Atomically consume one bone, persist Prayer XP/level, and store a receipt. */
  commitBoneBurialOperationAsync(
    request: BoneBurialCommitRequest,
  ): Promise<BoneBurialCommitReceipt>;

  /** Atomically create a quest incarnation and credit its starter items. */
  commitQuestStartOperationAsync(
    request: QuestStartCommitRequest,
  ): Promise<QuestStartCommitReceipt>;

  /** Atomically complete a quest and commit every authored reward. */
  commitQuestCompletionOperationAsync(
    request: QuestCompletionCommitRequest,
  ): Promise<QuestCompletionCommitReceipt>;

  /** Atomically debit an input, credit a harvest, and persist its skill XP. */
  commitGatheringRewardOperationAsync(
    request: GatheringRewardCommitRequest,
  ): Promise<GatheringRewardCommitReceipt>;

  /** Load active depletion deadlines for a batch of stable world resource IDs. */
  getGatheringResourceStatesAsync(
    resourceIds: string[],
  ): Promise<GatheringResourceState[]>;

  /** Atomically transform recipe inputs into outputs and persist matching XP. */
  commitProcessingActionOperationAsync(
    request: ProcessingActionCommitRequest,
  ): Promise<ProcessingActionCommitReceipt>;

  /** Persist caller-visible acceptance before a timed processing action starts. */
  beginProcessingRequestAsync(
    playerId: string,
    operationId: string,
    requestId: string,
    skill: ProcessingSkill,
    envelope: ProcessingRequestEnvelope,
  ): Promise<"accepted" | "pending" | "committed" | "busy" | "rejected">;

  /** Refresh ownership while the exact accepted request is still executing. */
  heartbeatProcessingRequestAsync(
    playerId: string,
    operationId: string,
    requestId: string,
    skill: ProcessingSkill,
  ): Promise<boolean>;

  /** Persist a definitive safe rejection for an accepted request. */
  rejectProcessingRequestAsync(
    playerId: string,
    operationId: string,
    requestId: string,
    skill: ProcessingSkill,
    reason: string,
    retryable: boolean,
  ): Promise<boolean>;

  /** Resolve one deterministic processing receipt without exposing its contents. */
  getProcessingActionCommitStatusAsync(
    playerId: string,
    operationId: string,
  ): Promise<
    "committed" | "pending" | "interrupted" | "rejected" | "not_found"
  >;

  /** Load the player's one durable unacknowledged processing command. */
  getRecoverableProcessingRequestAsync(
    playerId: string,
  ): Promise<RecoverableProcessingRequest | null>;

  /** Acknowledge a terminal command so later work may begin. */
  acknowledgeProcessingRequestAsync(
    playerId: string,
    requestId: string,
  ): Promise<boolean>;

  /** Reconstruct every committed fire whose expiry is not yet settled. */
  getActiveProcessingFiresAsync(): Promise<ActiveProcessingFire[]>;

  /** Atomically settle one expired fire and its exact ash source. */
  commitProcessingFireExtinguishOperationAsync(
    request: ProcessingFireExtinguishCommitRequest,
  ): Promise<ProcessingFireExtinguishCommitReceipt>;

  /** Atomically debit one exact equipped stack and persist one receipt. */
  commitEquipmentStackDebitOperationAsync(
    request: EquipmentStackDebitCommitRequest,
  ): Promise<EquipmentStackDebitCommitReceipt>;

  /** Atomically debit one fired arrow and freeze its recovery outcome/source. */
  commitAmmunitionShotOperationAsync(
    request: AmmunitionShotCommitRequest,
  ): Promise<AmmunitionShotCommitReceipt>;

  /** Finalize one staged ammunition debit only when its launch is admitted. */
  completeAmmunitionShotOperationAsync(
    request: AmmunitionShotSettlementRequest,
  ): Promise<AmmunitionShotCommitReceipt>;

  /** Refund one staged debit whose projectile was never admitted. */
  cancelAmmunitionShotOperationAsync(
    request: AmmunitionShotSettlementRequest,
  ): Promise<AmmunitionShotCommitReceipt>;

  /** Refund interrupted pre-launch debits before player custody hydration. */
  recoverPendingAmmunitionShotOperationsAsync(
    playerId: string,
  ): Promise<AmmunitionShotCommitReceipt[]>;

  /** Atomically compare-and-swap fixed-point prayer state and persist a receipt. */
  commitPrayerStateOperationAsync(
    request: PrayerStateCommitRequest,
  ): Promise<PrayerStateCommitReceipt>;

  // World chunk methods
  saveWorldChunk(chunkData: {
    chunkX: number;
    chunkZ: number;
    biome?: string;
    heightData?: number[];
    chunkSeed?: number;
    lastActiveTime?: number | Date;
    playerCount?: number;
    data?: string;
  }): void;
  saveWorldChunkAsync(chunkData: {
    chunkX: number;
    chunkZ: number;
    biome?: string;
    heightData?: number[];
    chunkSeed?: number;
    lastActiveTime?: number | Date;
    playerCount?: number;
    data?: string;
  }): Promise<void>;
  getWorldChunk(x: number, z: number): WorldChunkRow | null;
  getWorldChunkAsync(x: number, z: number): Promise<WorldChunkRow | null>;
  getInactiveChunks(minutes: number): WorldChunkRow[];
  getInactiveChunksAsync(minutes: number): Promise<WorldChunkRow[]>;
  updateChunkPlayerCount(
    chunkX: number,
    chunkZ: number,
    playerCount: number,
  ): void;
  updateChunkPlayerCountAsync(
    chunkX: number,
    chunkZ: number,
    playerCount: number,
  ): Promise<void>;
  markChunkForReset(chunkX: number, chunkZ: number): void;
  markChunkForResetAsync(chunkX: number, chunkZ: number): Promise<void>;
  resetChunk(chunkX: number, chunkZ: number): void;
  resetChunkAsync(chunkX: number, chunkZ: number): Promise<void>;

  // Session tracking methods
  createPlayerSession(
    sessionData: Omit<PlayerSessionRow, "id" | "sessionId">,
  ): string;
  createPlayerSessionAsync(
    sessionData: Omit<PlayerSessionRow, "id" | "sessionId">,
    sessionId?: string,
  ): Promise<string>;
  updatePlayerSession(
    sessionId: string,
    updates: Partial<PlayerSessionRow>,
  ): void;
  updatePlayerSessionAsync(
    sessionId: string,
    updates: Partial<PlayerSessionRow>,
  ): Promise<void>;
  getActivePlayerSessions(): PlayerSessionRow[];
  getActivePlayerSessionsAsync(): Promise<PlayerSessionRow[]>;
  endPlayerSession(sessionId: string, reason?: string): void;
  endPlayerSessionAsync(sessionId: string, reason?: string): Promise<void>;
  batchUpdateSessionLastActivityAsync(
    sessionIds: string[],
    timestamp: number,
  ): Promise<void>;

  // Maintenance methods
  cleanupOldSessions(daysOld: number): number;
  cleanupOldSessionsAsync(daysOld: number): Promise<number>;
  cleanupOldChunkActivity(daysOld: number): number;
  cleanupOldChunkActivityAsync(daysOld: number): Promise<number>;
  getDatabaseStats(): {
    playerCount: number;
    activeSessionCount: number;
    chunkCount: number;
    activeChunkCount: number;
    totalActivityRecords: number;
  };
  getDatabaseStatsAsync(): Promise<{
    playerCount: number;
    activeSessionCount: number;
    chunkCount: number;
    activeChunkCount: number;
    totalActivityRecords: number;
  }>;

  // Item methods
  getItem(itemId: number): ItemRow | null;
  getItemAsync(itemId: number): Promise<ItemRow | null>;
  getAllItems(): ItemRow[];
  getAllItemsAsync(): Promise<ItemRow[]>;

  // Cleanup
  close(): void;
}

// ============================================================================
// GAME SYSTEM INTERFACES
// ============================================================================

export interface PlayerSystem extends System {
  initializePlayer(playerId: string): void;
  savePlayerToDatabase(playerId: string): void;
  onPlayerEnter(event: { playerId: string }): void;
  getPlayer(playerId: string): Player | null;
  restorePlayerHealth(playerId: string, maxHealth: number): boolean;
}

export interface MobNPCSystem extends System {
  getMob(mobId: string): Entity | null;
  spawnMob(config: unknown): Promise<unknown>;
  getMobCount(): number;
  getActiveMobs(): Entity[];
  getSpawnedMobs(): Map<string, unknown>;
}

export interface CombatSystem extends System {
  startCombat(attackerId: string, targetId: string, options?: unknown): boolean;
  isInCombat(entityId: string): boolean;
  getCombatData(entityId: string): CombatData | null;
  forceEndCombat(entityId: string): void;
  getActiveCombats(): Map<string, CombatData>;
}

export interface InventorySystem extends System {
  addItem(playerId: string, itemId: string, quantity: number): boolean;
  removeItem(playerId: string, itemId: string, quantity: number): boolean;
  getPlayerInventory(playerId: string): unknown[];
  initializeTestPlayerInventory(playerId: string): void;
  playerInventories: Map<string, unknown>;
}

export interface EquipmentSystem extends System {
  equipItem(data: {
    playerId: string;
    itemId: string | number;
    slot: string;
    inventorySlot?: number;
  }): void;
  unequipItem(data: { playerId: string; slot: string }): void;
  consumeArrow(playerId: string): Promise<boolean>;
  playerEquipment: Map<string, unknown>;

  // Direct equipment methods (used by bank equipment handlers)
  getEquipmentSlotForItem(itemId: string | number): string | null;
  canPlayerEquipItem(playerId: string, itemId: string | number): boolean;
  equipItemDirect(
    playerId: string,
    itemId: string | number,
    quantity?: number,
  ): Promise<{
    success: boolean;
    error?: string;
    equippedSlot?: string;
    displacedItems: Array<{ itemId: string; slot: string; quantity: number }>;
  }>;
  unequipItemDirect(
    playerId: string,
    slot: string,
  ): Promise<{
    success: boolean;
    error?: string;
    itemId?: string;
    quantity: number;
  }>;
  getAllEquippedItems(
    playerId: string,
  ): Array<{ slot: string; itemId: string; quantity: number }>;
}

export interface StoreSystem extends System {
  purchaseItem(
    playerId: string,
    itemId: string,
    quantity: number,
    expectedPrice: number,
  ): Promise<boolean>;
  sellItem(
    playerId: string,
    itemId: string,
    quantity: number,
    expectedPrice: number,
  ): Promise<boolean>;
  stores: Map<string, unknown>;
}

export interface BankingSystem extends System {
  playerBanks: Map<string, unknown>;
}

/**
 * Trading system result type
 */
export interface TradeOperationResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * TradingSystem - Server-authoritative player-to-player trading
 *
 * Manages trade sessions between players with full validation,
 * atomic item swaps, and proper cleanup on disconnection.
 *
 * Trade Flow:
 * 1. Player A requests trade with Player B
 * 2. Player B receives request notification
 * 3. Player B accepts/declines
 * 4. If accepted, trade window opens for both
 * 5. Players add/remove items from their offers
 * 6. Both players must accept the final offer
 * 7. Server atomically swaps items between inventories
 */
export interface TradingSystem extends System {
  // Trade Lifecycle
  createTradeRequest(
    initiatorId: string,
    initiatorName: string,
    initiatorSocketId: string,
    recipientId: string,
  ): TradeOperationResult & { tradeId?: string };

  respondToTradeRequest(
    tradeId: string,
    recipientId: string,
    recipientName: string,
    recipientSocketId: string,
    accept: boolean,
  ): TradeOperationResult;

  // Trade Operations
  addItemToTrade(
    tradeId: string,
    playerId: string,
    inventorySlot: number,
    itemId: string,
    quantity: number,
  ): TradeOperationResult;

  removeItemFromTrade(
    tradeId: string,
    playerId: string,
    tradeSlot: number,
  ): TradeOperationResult;

  setAcceptance(
    tradeId: string,
    playerId: string,
    accepted: boolean,
  ): TradeOperationResult & {
    bothAccepted?: boolean;
    moveToConfirming?: boolean;
  };

  moveToConfirmation(tradeId: string): TradeOperationResult;
  returnToOfferScreen(tradeId: string): TradeOperationResult;

  completeTrade(tradeId: string): TradeOperationResult & {
    initiatorReceives?: unknown[];
    recipientReceives?: unknown[];
    initiatorId?: string;
    recipientId?: string;
  };

  cancelTrade(
    tradeId: string,
    reason: string,
    cancelledBy?: string,
  ): TradeOperationResult;

  // Queries
  getTradeSession(tradeId: string): unknown | undefined;
  getPlayerTrade(playerId: string): unknown | undefined;
  getPlayerTradeId(playerId: string): string | undefined;
  isPlayerInTrade(playerId: string): boolean;
  getTradePartner(playerId: string): unknown | undefined;
  isPlayerOnline(playerId: string): boolean;
}

/**
 * Duel system operation result type
 */
export interface DuelOperationResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Server-side duel session info returned by DuelSystem query methods.
 * Provides the common fields that callers need without exposing
 * internal implementation details.
 */
export interface DuelSessionInfo {
  duelId: string;
  state: DuelState;
  challengerId: string;
  challengerName: string;
  targetId: string;
  targetName: string;
  rules: DuelRules;
  challengerStakes: StakedItem[];
  targetStakes: StakedItem[];
  challengerAccepted: boolean;
  targetAccepted: boolean;
  arenaId: number | null;
  createdAt: number;
  countdownStartedAt?: number;
  fightStartedAt?: number;
  finishedAt?: number;
  winnerId?: string;
}

/**
 * DuelSystem - Server-authoritative player-to-player dueling (rules-accurate)
 *
 * Manages duel sessions with rules negotiation, stakes, and combat enforcement.
 *
 * Duel Flow:
 * 1. Player A challenges Player B (in Duel Arena zone)
 * 2. Player B accepts/declines challenge
 * 3. Rules screen: Both players toggle rules and accept
 * 4. Stakes screen: Both players stake items/gold and accept
 * 5. Confirmation screen: Read-only review, both accept
 * 6. Teleport to arena with countdown
 * 7. Combat with rule enforcement
 * 8. Winner receives stakes, loser respawns at lobby
 */
export interface DuelSystem extends System {
  // Tick processing (called by GameTickProcessor)
  processTick(): void;

  // Challenge Flow
  createChallenge(
    challengerId: string,
    challengerName: string,
    targetId: string,
    targetName: string,
  ): DuelOperationResult & { challengeId?: string };

  respondToChallenge(
    challengeId: string,
    responderId: string,
    accept: boolean,
  ): DuelOperationResult & { duelId?: string };

  // Session Management
  getDuelSession(duelId: string): DuelSessionInfo | undefined;
  getPlayerDuel(playerId: string): DuelSessionInfo | undefined;
  getPlayerDuelId(playerId: string): string | undefined;
  isPlayerInDuel(playerId: string): boolean;
  cancelDuel(
    duelId: string,
    reason: string,
    cancelledBy?: string,
  ): DuelOperationResult;

  // Rules
  toggleRule(
    duelId: string,
    playerId: string,
    rule: keyof DuelRules,
  ): DuelOperationResult;
  toggleEquipmentRestriction(
    duelId: string,
    playerId: string,
    slot: EquipmentSlotRestriction,
  ): DuelOperationResult;
  acceptRules(duelId: string, playerId: string): DuelOperationResult;

  // Stakes
  addStake(
    duelId: string,
    playerId: string,
    inventorySlot: number,
    itemId: string,
    quantity: number,
    value: number,
  ): DuelOperationResult;
  removeStake(
    duelId: string,
    playerId: string,
    stakeIndex: number,
  ): DuelOperationResult;
  acceptStakes(duelId: string, playerId: string): DuelOperationResult;

  // Confirmation & Combat
  acceptFinal(
    duelId: string,
    playerId: string,
  ): DuelOperationResult & { arenaId?: number };
  forfeitDuel(playerId: string): DuelOperationResult;

  // Rule Queries (for CombatSystem integration)
  isPlayerInActiveDuel(playerId: string): boolean;
  getPlayerDuelRules(playerId: string): DuelRules | null;
  canMove(playerId: string): boolean;
  canForfeit(playerId: string): boolean;
  canUseRanged(playerId: string): boolean;
  canUseMelee(playerId: string): boolean;
  canUseMagic(playerId: string): boolean;
  canUseSpecialAttack(playerId: string): boolean;
  canUsePrayer(playerId: string): boolean;
  canUsePotions(playerId: string): boolean;
  canEatFood(playerId: string): boolean;
  getDuelOpponentId(playerId: string): string | null;

  // Arena Management
  reserveArena(duelId: string): number | null;
  releaseArena(arenaId: number): void;
  getArenaSpawnPoints(
    arenaId: number,
  ):
    | [{ x: number; y: number; z: number }, { x: number; y: number; z: number }]
    | undefined;
  getArenaBounds(arenaId: number):
    | {
        min: { x: number; z: number };
        max: { x: number; z: number };
      }
    | undefined;

  // Disconnect Handling
  onPlayerDisconnect(playerId: string): void;
  onPlayerReconnect(playerId: string): void;
}

export interface XPSystem extends System {
  getSkillLevel(playerId: string, skill: string): number;
  getSkillData(playerId: string, skill: string): unknown;
  getCombatLevel(playerId: string): number;
}

export interface MovementSystem extends System {
  startPlayerMovement(playerId: string, target: unknown): void;
  teleportPlayer(playerId: string, position: unknown): void;
  movePlayer(playerId: string, destination: unknown, options?: unknown): void;
}

export interface EntityManager extends System {
  getEntity(entityId: string): Entity | undefined;
  getEntityCounts(): Record<string, number>;
}

export interface ItemRegistrySystem extends System {
  get(itemId: string): Item | null;
}

// ============================================================================
// RUNTIME DATA STRUCTURES (Internal System State)
// ============================================================================

/**
 * Internal banking system interface (runtime data structure)
 * Note: Distinct from BankingSystem which extends System
 */
export interface InternalBankingSystem {
  playerBanks: Map<string, Map<string, { items: BankItem[] }>>;
}

/**
 * Internal inventory system interface (runtime data structure)
 * Note: Distinct from InventorySystem which extends System
 */
export interface InternalInventorySystem {
  playerInventories: Map<string, { items: InventorySlotItem[]; coins: number }>;
}

/**
 * Internal store system interface (runtime data structure)
 * Note: Distinct from StoreSystem which extends System
 */
export interface InternalStoreSystem {
  stores: Map<string, { items: StoreItem[] }>;
}

/**
 * Internal equipment system interface (runtime data structure)
 * Note: Distinct from EquipmentSystem which extends System
 */
export interface InternalEquipmentSystem {
  playerEquipment: Map<
    string,
    Record<string, { item: Item | null; itemId: number | null }>
  >;
}

// ============================================================================
// SYSTEM-SPECIFIC TYPES
// ============================================================================

/**
 * Combat system interfaces
 */
export interface CombatEntity {
  id: string;
  position: Position3D;
  stats: { attack: number; defense: number; ranged: number };
  config: { attackPower: number; defensePower: number; defense: number };
  getPosition(): Position3D;
  takeDamage(damage: number, attackerId: string): void;
}

export interface XPDrop {
  entityId: string;
  skill:
    | "attack"
    | "strength"
    | "defense"
    | "constitution"
    | "ranged"
    | "magic"
    | "prayer"
    | "woodcutting"
    | "mining"
    | "fishing"
    | "firemaking"
    | "cooking"
    | "smithing"
    | "agility"
    | "crafting"
    | "fletching"
    | "runecrafting";
  amount: number;
  timestamp: number;
  playerId: string;
  position: Position3D;
}

export interface SkillMilestone {
  level: number;
  name: string;
  message: string;
  reward: string | null;
}

/**
 * Loot system interfaces
 */
export interface DroppedItem {
  id: string;
  itemId: string;
  quantity: number;
  position: Position3D;
  despawnTime: number;
  droppedBy: string;
  entityId: string;
  droppedAt: number;
  mesh: THREE.Object3D | null;
}

export interface LootItem extends Item {
  quantity: number;
}

/**
 * Mob spawning interfaces
 */
export interface EntitySpawnedEvent {
  entityId?: string;
  entityType?: "player" | "mob" | "item" | "npc" | "resource";
  position?: Position3D;
  entityData?: Record<string, unknown>;
  type?: string;
  config?: unknown;
}

export interface MobSpawnRequest {
  mobType: string;
  position: Position3D;
  level: number;
  config: Partial<MobStats> | null;
  respawnTime: number;
  customId: string | null;
}

/**
 * Entity manager interfaces
 */
export interface MoveRequestEvent {
  entityId: string;
  targetPosition: Position3D;
  speed: number;
}

export interface MobAttackEvent {
  attackerId: string;
  targetId: string;
  damage: number;
}

/**
 * Skills system data
 */
export interface SkillsData {
  attack: { level: number; xp: number };
  strength: { level: number; xp: number };
  defense: { level: number; xp: number };
  constitution: { level: number; xp: number };
  ranged: { level: number; xp: number };
  prayer: { level: number; xp: number };
  woodcutting: { level: number; xp: number };
  mining: { level: number; xp: number };
  fishing: { level: number; xp: number };
  firemaking: { level: number; xp: number };
  cooking: { level: number; xp: number };
  agility: { level: number; xp: number };
}

export interface InventoryData {
  items: Array<{
    slot: number;
    itemId: string;
    quantity: number;
    item: {
      id: string;
      name: string;
      type: string;
      stackable: boolean;
      weight: number;
    };
  }>;
  coins: number;
  maxSlots: number;
}

export interface EquipmentData {
  weapon: {
    itemId: string;
    name: string;
    stats: {
      attack: number;
      defense: number;
      strength: number;
    };
  } | null;
  shield: {
    itemId: string;
    name: string;
    stats: {
      attack: number;
      defense: number;
      strength: number;
    };
  } | null;
  helmet: {
    itemId: string;
    name: string;
    stats: {
      attack: number;
      defense: number;
      strength: number;
    };
  } | null;
  body: {
    itemId: string;
    name: string;
    stats: {
      attack: number;
      defense: number;
      strength: number;
    };
  } | null;
  legs: {
    itemId: string;
    name: string;
    stats: {
      attack: number;
      defense: number;
      strength: number;
    };
  } | null;
  arrows: {
    itemId: string;
    name: string;
    stats: {
      attack: number;
      defense: number;
      strength: number;
    };
  } | null;
}

export interface UIRequestData {
  playerId: string;
  requestType: "open" | "close" | "update" | "refresh";
  data: Record<string, string | number | boolean>;
  uiType: "inventory" | "skills" | "equipment" | "stats" | "bank" | "store";
}

/**
 * Action registry interfaces (system-specific execution params)
 */
export interface SystemActionParams {
  playerId: string;
  targetId: string | null;
  position: Position3D | null;
  itemId: string | null;
  quantity: number | null;
  slot: number | null;
  skillName: string | null;
}

/**
 * Store system interfaces
 */
export interface StoreSystemInterface {
  openStore(
    playerId: string,
    storeType: "general" | "equipment" | "food" | "runes",
  ): void;
  closeStore(playerId: string): void;
  buyItem(playerId: string, itemId: string, quantity: number): Promise<boolean>;
  sellItem(
    playerId: string,
    itemId: string,
    quantity: number,
  ): Promise<boolean>;
  getStoreInventory(
    storeType: "general" | "equipment" | "food" | "runes",
  ): Array<{ item: Item; price: number }>;
}

/**
 * System loader interfaces - specific system registry
 */
export interface Systems {
  combat: System;
  inventory: System;
  skills: System;
  itemPickup: System;
  persistence: System;
  spawning: System;
  banking: System;
  store: System;
  ui: System;
}

/**
 * System-specific debug info interfaces
 */
export interface NPCSystemInfo {
  bankAccounts: number;
  totalTransactions: number;
  storeItems: number;
  recentTransactions: Array<{
    timestamp: number;
    type: "buy" | "sell" | "bank_deposit" | "bank_withdraw";
    playerId: string;
    itemId: string | null;
    quantity: number;
    amount: number;
  }>;
}

// ============================================================================
// TYPE GUARDS & HELPERS
// ============================================================================

/**
 * Type guard helpers
 */
export function isPhysicsSystem(system: System): system is PhysicsSystem {
  return "scene" in system && "createLayerMask" in system;
}

export function isMobNPCSystem(system: System): system is MobNPCSystem {
  return "getMob" in system && "spawnMob" in system;
}

/**
 * Helper to get typed systems with non-null assertion
 */
export function getRequiredSystem<T extends System>(
  world: World,
  systemKey: string,
): T {
  const system = world.getSystem<T>(systemKey);
  if (!system) {
    throw new Error(`Required system '${systemKey}' not found`);
  }
  return system;
}
