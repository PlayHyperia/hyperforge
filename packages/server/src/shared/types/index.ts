/**
 * Shared Types - Central export for all server types
 *
 * This barrel file re-exports all types from domain-specific type files,
 * providing a single convenient import location for server code.
 *
 * **Usage**:
 * ```typescript
 * import type { PlayerRow, ServerSocket, SpawnData } from '../shared/types';
 * ```
 *
 * **Domain modules**:
 * - database.types - Database rows and persistence
 * - network.types - WebSocket and connections
 * - game.types - Game systems and entities
 * - auth.types - User accounts and authentication
 */

// Database types
export type {
  PlayerRow,
  ItemRow,
  InventoryRow,
  EquipmentRow,
  PlayerSessionRow,
  WorldChunkRow,
  InventorySaveItem,
  EquipmentSaveItem,
  CombatLoadoutPersistenceSnapshot,
  CombatLoadoutCommitRequest,
  CombatLoadoutCommitReceipt,
  BankSaveItem,
  DuelPreparationPlanPersistenceSnapshot,
  DuelPreparationPlanRecoveryEvidence,
  DuelPreparationPlanCommitRequest,
  DuelPreparationPlanRecoveryRequest,
  DuelPreparationPlanCommitReceipt,
  InventoryDebitRequirement,
  InventoryDebitCommitRequest,
  InventoryDebitCommitReceipt,
  ProjectileRuneCostOperationStatus,
  ProjectileRuneCostRefundDestination,
  ProjectileRuneCostCommitRequest,
  ProjectileRuneCostSettlementRequest,
  ProjectileRuneCostCommitReceipt,
  GroundItemSourceStatus,
  GroundItemSourceState,
  GroundItemSourceRegistrationRequest,
  GroundItemSourceRegistrationReceipt,
  GroundItemDropCommitRequest,
  GroundItemDropCommitReceipt,
  GroundItemDeathCommitRequest,
  GroundItemDeathCommitReceipt,
  GroundItemMobLootCommitRequest,
  GroundItemMobLootCommitReceipt,
  MobCombatProgressReceipt,
  MobCombatProgressSkill,
  GroundItemPickupCommitRequest,
  GroundItemPickupCommitReceipt,
  FoodConsumptionOperationStatus,
  FoodConsumptionCompletionReason,
  FoodConsumptionCommitRequest,
  FoodConsumptionCompleteRequest,
  FoodConsumptionCommitReceipt,
  DuelDamageCompetitiveAuthority,
  DuelDamageCompetitiveTerminal,
  DuelDamageProjectileCostAuthority,
  DuelDamageCommitRequest,
  DuelDamageCommitReceipt,
  BoneBurialCommitRequest,
  BoneBurialCommitReceipt,
  QuestRewardSkill,
  QuestCompletionRewardItem,
  QuestStartRewardItem,
  QuestStartCommitRequest,
  QuestStartCommitReceipt,
  QuestCompletionRewardXp,
  QuestCompletionProgressReceipt,
  QuestCompletionCommitRequest,
  QuestCompletionCommitReceipt,
  GatheringRewardSkill,
  GatheringRewardItem,
  GatheringRewardCommitRequest,
  GatheringRewardCommitReceipt,
  GatheringResourceState,
  ProcessingActionSkill,
  ProcessingActionItem,
  ProcessingActionConsumable,
  ProcessingActionConsumableState,
  ProcessingActionFireEffectRequest,
  ProcessingActionFireEffect,
  ActiveProcessingFire,
  ProcessingFireExtinguishCommitRequest,
  ProcessingFireExtinguishCommitReceipt,
  ProcessingActionCommitRequest,
  ProcessingActionCommitReceipt,
  EquipmentStackDebitCommitRequest,
  EquipmentStackDebitCommitReceipt,
  AmmunitionRecoveryDisposition,
  AmmunitionShotCommitRequest,
  AmmunitionShotCommitReceipt,
  AmmunitionShotRefundDestination,
  AmmunitionShotSettlementRequest,
  AttackStyleCommitRequest,
  AttackStyleCommitReceipt,
  StreamingDuelExecutorCommand,
  StreamingDuelExecutorCommandOutcome,
  StreamingDuelExecutorCommandRequest,
  StreamingDuelExecutorCommandCompletionRequest,
  StreamingDuelExecutorCommandReceipt,
  PrayerPersistenceSnapshot,
  PrayerStateTransitionKind,
  PrayerStateCommitRequest,
  PrayerStateCommitReceipt,
  PlayerPersistenceUpdate,
  DatabaseSystemOperations,
  SystemDatabase,
  ActivityLogRow,
  ActivityLogEntry,
  ActivityLogQueryOptions,
  TradeRow,
  TradeEntry,
  TradeItem,
  TradeQueryOptions,
} from "./database.types.js";
export { dbHelpers, isDatabaseInstance } from "./database.types.js";

// Network types
export type {
  Socket,
  NodeWebSocket,
  ServerSocket,
  ConnectionParams,
  NetworkWithSocket,
  ServerNetworkWithSockets,
} from "./network.types.js";

// Game types
export type {
  WorldOptions,
  SpawnData,
  TerrainSystem,
  ResourceEntity,
  ResourceSystem,
  InventorySystemData,
  PlayerEntity,
  ServerStats,
  ChatMessage,
} from "./game.types.js";

// Auth types
export type { User } from "./auth.types.js";
