/**
 * Database Types - Database row types and persistence interfaces
 *
 * Contains TypeScript types for database operations, row structures,
 * and persistence-related data models. These types match the Drizzle
 * schema structure defined in database/schema.ts.
 *
 * **Type Categories**:
 * - Database row types (PlayerRow, ItemRow, etc.)
 * - Save operation types (InventorySaveItem, EquipmentSaveItem)
 * - Database system interfaces
 *
 * **Referenced by**: DatabaseSystem, repositories, save managers
 */

import type {
  StreamingDuelDamageObservationContext,
  StreamingDuelExecutorObservationContext,
  StreamingDuelFoodObservationContext,
  StreamingDuelPrayerObservationContext,
  StreamingDuelRoleSwitchObservationContext,
  StreamingDuelStyleObservationContext,
} from "@hyperforge/shared";

// Re-export database utilities from shared
export { dbHelpers, isDatabaseInstance } from "@hyperforge/shared";
export type { SystemDatabase } from "@hyperforge/shared";

// ============================================================================
// DATABASE ROW TYPES
// ============================================================================
// These types match the structure of rows returned from Drizzle queries.
// They correspond to the tables defined in database/schema.ts.

/**
 * Player data row from the characters table
 *
 * Contains all persistent character data including stats, position, and progress.
 * Used by DatabaseSystem for loading/saving player state.
 */
export interface PlayerRow {
  playerId: string;
  id: string;
  accountId: string;
  name: string;
  combatLevel: number;
  attackLevel: number;
  strengthLevel: number;
  defenseLevel: number;
  constitutionLevel: number;
  rangedLevel: number;
  magicLevel: number;
  woodcuttingLevel: number;
  miningLevel: number;
  fishingLevel: number;
  firemakingLevel: number;
  cookingLevel: number;
  smithingLevel: number;
  agilityLevel: number;
  craftingLevel: number;
  fletchingLevel: number;
  runecraftingLevel: number;
  attackXp: number;
  strengthXp: number;
  defenseXp: number;
  constitutionXp: number;
  rangedXp: number;
  magicXp: number;
  woodcuttingXp: number;
  miningXp: number;
  fishingXp: number;
  firemakingXp: number;
  cookingXp: number;
  smithingXp: number;
  agilityXp: number;
  craftingXp: number;
  fletchingXp: number;
  runecraftingXp: number;
  health: number;
  maxHealth: number;
  coins: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  attackStyle?: string; // Combat style preference (accurate, aggressive, defensive)
  autoRetaliate?: number; // Auto-retaliate preference (1=ON, 0=OFF)
  selectedSpell?: string | null; // Autocast spell ID (null = no autocast)
  // Prayer system fields
  prayerLevel?: number; // Prayer skill level
  prayerXp?: number; // Prayer skill XP
  prayerPoints?: number; // Current prayer points
  prayerPointUnits?: number; // Fixed-point current prayer points (1e6 units/point)
  prayerMaxPoints?: number; // Maximum prayer points
  activePrayers?: string[]; // Array of active prayer IDs (stored as JSONB)
  createdAt: number;
  lastLogin: number;
}

/** Generic saves cannot mutate atomic Prayer progression or resource custody. */
export type PlayerPersistenceUpdate = Omit<
  Partial<PlayerRow>,
  | "attackStyle"
  | "prayerLevel"
  | "prayerXp"
  | "prayerPoints"
  | "prayerPointUnits"
  | "prayerMaxPoints"
  | "activePrayers"
>;

/** World item row (dropped items, resource nodes) */
export interface ItemRow {
  id: string;
  chunkX: number;
  chunkZ: number;
  itemId: string;
  quantity: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  createdAt: number;
}

/** Inventory item row - items in player's 28-slot inventory */
export interface InventoryRow {
  playerId: string;
  itemId: string;
  quantity: number;
  slotIndex: number;
  metadata: string | null;
}

/** Equipment item row - items equipped in player's equipment slots */
export interface EquipmentRow {
  playerId: string;
  slotType: string;
  itemId: string | null;
  quantity: number;
}

/** Player session tracking row */
export interface PlayerSessionRow {
  id: string;
  sessionId: string;
  playerId: string;
  sessionStart: number;
  sessionEnd: number | null;
  playtimeMinutes: number;
  lastActivity: number;
  reason: string | null;
}

/** World chunk persistence row */
export interface WorldChunkRow {
  chunkX: number;
  chunkZ: number;
  data: string;
  lastActive: number;
  playerCount: number;
  needsReset: number;
}

/** Activity log row - tracks player actions for admin panel */
export interface ActivityLogRow {
  id: number;
  playerId: string;
  eventType: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  position: { x: number; y: number; z: number } | null;
  timestamp: number;
}

/** Activity log entry for insertion (without id) */
export interface ActivityLogEntry {
  playerId: string;
  eventType: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  position?: { x: number; y: number; z: number };
  timestamp: number;
}

/** Trade item in a trade record */
export interface TradeItem {
  itemId: string;
  quantity: number;
  itemName?: string;
}

/** Trade record row - tracks player trades */
export interface TradeRow {
  id: number;
  initiatorId: string | null;
  receiverId: string | null;
  status: "completed" | "cancelled" | "declined";
  initiatorItems: TradeItem[];
  receiverItems: TradeItem[];
  initiatorCoins: number;
  receiverCoins: number;
  timestamp: number;
}

/** Trade entry for insertion (without id) */
export interface TradeEntry {
  initiatorId: string;
  receiverId: string;
  status: "completed" | "cancelled" | "declined";
  initiatorItems: TradeItem[];
  receiverItems: TradeItem[];
  initiatorCoins: number;
  receiverCoins: number;
  timestamp: number;
}

/** Activity log query options */
export interface ActivityLogQueryOptions {
  playerId?: string;
  eventType?: string;
  eventTypes?: string[];
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  offset?: number;
}

/** Trade query options */
export interface TradeQueryOptions {
  playerId?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  status?: "completed" | "cancelled" | "declined";
  limit?: number;
  offset?: number;
}

// ============================================================================
// SAVE OPERATION TYPES
// ============================================================================

/** Inventory save data - for savePlayerInventoryAsync() */
export interface InventorySaveItem {
  itemId: string;
  quantity: number;
  slotIndex: number | null;
  metadata: Record<string, unknown> | null;
}

/** Equipment save data - for savePlayerEquipmentAsync() */
export interface EquipmentSaveItem {
  slotType: string;
  itemId: string | null;
  quantity: number;
}

export interface CombatLoadoutPersistenceSnapshot {
  inventory: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
  equipment: Array<{
    slotType: string;
    itemId: string;
    quantity: number;
  }>;
  selectedSpell: string | null;
}

export interface CombatLoadoutCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  expected: CombatLoadoutPersistenceSnapshot;
  committed: CombatLoadoutPersistenceSnapshot;
  publicActionObservation?: StreamingDuelRoleSwitchObservationContext;
}

export interface CombatLoadoutCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  committed: CombatLoadoutPersistenceSnapshot;
}

export interface BankSaveItem {
  itemId: string;
  quantity: number;
  slot: number;
  tabIndex: number;
}

export interface DuelPreparationPlanPersistenceSnapshot extends CombatLoadoutPersistenceSnapshot {
  bank: BankSaveItem[];
}

/** Immutable server-validated planning evidence bound to the custody receipt. */
export type DuelPreparationPlanRecoveryEvidence = Record<string, unknown>;

export interface DuelPreparationPlanCommitRequest {
  operationId: string;
  preparationId: string;
  playerId: string;
  requestFingerprint: string;
  expected: DuelPreparationPlanPersistenceSnapshot;
  committed: DuelPreparationPlanPersistenceSnapshot;
  recoveryEvidence: DuelPreparationPlanRecoveryEvidence;
}

export interface DuelPreparationPlanRecoveryRequest {
  operationId: string;
  preparationId: string;
  playerId: string;
}

export interface DuelPreparationPlanCommitReceipt {
  operationId: string;
  preparationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  committed: DuelPreparationPlanPersistenceSnapshot;
  recoveryEvidence: DuelPreparationPlanRecoveryEvidence;
}

export interface InventoryDebitRequirement {
  itemId: string;
  quantity: number;
}

export interface InventoryDebitCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  requirements: InventoryDebitRequirement[];
}

export interface InventoryDebitCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  requirements: InventoryDebitRequirement[];
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export type ProjectileRuneCostOperationStatus =
  "pending" | "fired" | "resolved" | "cancelled";
export type ProjectileRuneCostRefundDestination =
  "inventory" | "bank" | "mixed";
export interface ProjectileRuneCostCommitRequest extends InventoryDebitCommitRequest {}
export interface ProjectileRuneCostSettlementRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
}
export interface ProjectileRuneCostCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  requirements: InventoryDebitRequirement[];
  status: ProjectileRuneCostOperationStatus;
  committed: InventorySaveItem[];
  refundDestination: ProjectileRuneCostRefundDestination | null;
}

export type GroundItemSourceStatus = "active" | "claimed" | "expired";

export interface GroundItemSourceState {
  sourceId: string;
  status: GroundItemSourceStatus;
  itemId: string;
  quantity: number;
  stackable: boolean;
  position: { x: number; y: number; z: number };
  tile: { x: number; z: number };
  droppedBy: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lootProtectionExpiresAt: number | null;
  version: number;
}

export interface GroundItemSourceRegistrationRequest {
  contributionId: string;
  preferredSourceId: string;
  requestFingerprint: string;
  itemId: string;
  quantity: number;
  stackable: boolean;
  position: { x: number; y: number; z: number };
  tile: { x: number; z: number };
  droppedBy: string | null;
  lifetimeMs: number;
  lootProtectionMs: number;
  allowMerge: boolean;
}

export interface GroundItemSourceRegistrationReceipt extends GroundItemSourceState {
  contributionId: string;
  requestFingerprint: string;
  replayed: boolean;
}

export interface GroundItemDropCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  itemId: string;
  quantity: number;
  slotIndex: number | null;
  source: GroundItemSourceRegistrationRequest;
}

export interface GroundItemDropCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  itemId: string;
  quantity: number;
  slotIndex: number | null;
  operationCommittedCoins: number | null;
  currentCoins: number;
  committed: InventorySaveItem[];
  source: GroundItemSourceRegistrationReceipt;
}

export interface GroundItemDeathCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killedBy: string;
  zoneType: "wilderness" | "pvp_zone";
  sources: GroundItemSourceRegistrationRequest[];
}

export interface GroundItemDeathCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killedBy: string;
  zoneType: "wilderness" | "pvp_zone";
  dropped: Array<{ itemId: string; quantity: number }>;
  sources: GroundItemSourceRegistrationReceipt[];
}

export interface GroundItemMobLootCommitRequest {
  operationId: string;
  killedBy: string;
  requestFingerprint: string;
  mobId: string;
  mobType: string;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killToken: string;
  /** Exact combat style used by the lethal authoritative hit. */
  attackStyle: string;
  /** Existing kill-XP authority: the defeated mob's full health value. */
  damageDealt: number;
  sources: GroundItemSourceRegistrationRequest[];
}

export type MobCombatProgressSkill =
  "attack" | "strength" | "defense" | "constitution" | "ranged" | "magic";

/** Durable result for one combat-skill component of a mob death. */
export interface MobCombatProgressReceipt {
  skill: MobCombatProgressSkill;
  xpAmount: number;
  awardedXp: number;
  operationCommittedXp: number;
  currentXp: number;
  currentLevel: number;
}

/** Durable combat progression returned by a lethal competitive duel hit. */
export type DuelCombatProgressReceipt = MobCombatProgressReceipt;

export interface GroundItemMobLootCommitReceipt {
  operationId: string;
  killedBy: string;
  requestFingerprint: string;
  replayed: boolean;
  mobId: string;
  mobType: string;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killToken: string;
  attackStyle: string;
  damageDealt: number;
  combatProgress: MobCombatProgressReceipt[];
  dropped: Array<{ itemId: string; quantity: number }>;
  sources: GroundItemSourceRegistrationReceipt[];
}

export interface GroundItemPickupCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  sourceEntityId: string;
  itemId: string;
  quantity: number;
}

export interface GroundItemPickupCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  sourceEntityId: string;
  itemId: string;
  quantity: number;
  stackable: boolean;
  operationCommittedCoins: number | null;
  currentCoins: number;
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export type FoodConsumptionOperationStatus = "pending" | "completed";

export type FoodConsumptionCompletionReason =
  "player_not_alive" | "full_health";

export interface FoodConsumptionCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  itemId: string;
  healAmount: number;
  publicActionObservation?: StreamingDuelFoodObservationContext;
}

export interface FoodConsumptionCompleteRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
}

export interface FoodConsumptionCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  itemId: string;
  healAmount: number;
  status: FoodConsumptionOperationStatus;
  healedAmount: number;
  healthAfter: number | null;
  completionReason?: FoodConsumptionCompletionReason;
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export interface DuelDamageCompetitiveAuthority {
  preparationId: string;
  fencingToken: string;
  snapshotDigest: string;
}

export interface DuelDamageCompetitiveTerminal {
  outcome: "win";
  winnerId: string;
  loserId: string;
  winReason: "kill";
  terminalAt: number;
  seed: string;
  replayHash: string;
}

export interface DuelDamageProjectileCostAuthority {
  operationType: "ammunition_shot" | "projectile_rune_cost";
  operationId: string;
  playerId: string;
  requestFingerprint: string;
}

export interface DuelDamageCommitRequest {
  operationId: string;
  attackerId: string;
  targetPlayerId: string;
  requestFingerprint: string;
  requestedDamage: number;
  /** Exact existing PvP kill-XP style frozen at the lethal hit boundary. */
  attackStyle: string;
  publicActionObservation: StreamingDuelDamageObservationContext;
  competitiveAuthority?: DuelDamageCompetitiveAuthority;
  projectileCost?: DuelDamageProjectileCostAuthority;
}

export interface DuelDamageCommitReceipt {
  operationId: string;
  attackerId: string;
  targetPlayerId: string;
  requestFingerprint: string;
  requestedDamage: number;
  replayed: boolean;
  appliedDamage: number;
  healthBefore: number;
  healthAfter: number;
  targetDied: boolean;
  xpDamageAuthority: number | null;
  combatProgress: DuelCombatProgressReceipt[];
  competitiveTerminal: DuelDamageCompetitiveTerminal | null;
}

export interface BoneBurialCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  itemId: string;
  xpAmount: number;
  levelRequired: number;
}

export interface BoneBurialCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  itemId: string;
  xpAmount: number;
  levelRequired: number;
  awardedXp: number;
  operationCommittedXp: number;
  currentXp: number;
  currentLevel: number;
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export type QuestRewardSkill =
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

export interface QuestCompletionRewardItem {
  itemId: string;
  quantity: number;
  stackable: boolean;
}

export interface QuestStartRewardItem {
  itemId: string;
  quantity: number;
  stackable: boolean;
}

export interface QuestStartCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  questId: string;
  questStartedAt: number;
  initialStage: string;
  items: QuestStartRewardItem[];
}

export interface QuestStartCommitReceipt extends QuestStartCommitRequest {
  replayed: boolean;
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export interface QuestCompletionRewardXp {
  skill: QuestRewardSkill;
  xpAmount: number;
}

export interface QuestCompletionProgressReceipt extends QuestCompletionRewardXp {
  awardedXp: number;
  operationCommittedXp: number;
  currentXp: number;
  currentLevel: number;
}

export interface QuestCompletionCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  questId: string;
  questStartedAt: number;
  expectedStage: string;
  expectedProgress: Record<string, number>;
  questPoints: number;
  items: QuestCompletionRewardItem[];
  xp: QuestCompletionRewardXp[];
}

export interface QuestCompletionCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  questId: string;
  questStartedAt: number;
  expectedStage: string;
  expectedProgress: Record<string, number>;
  completedAt: number;
  questPoints: number;
  operationCommittedQuestPoints: number;
  currentQuestPoints: number;
  items: QuestCompletionRewardItem[];
  xp: QuestCompletionRewardXp[];
  progress: QuestCompletionProgressReceipt[];
  prayer: PrayerPersistenceSnapshot | null;
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export type GatheringRewardSkill = "woodcutting" | "mining" | "fishing";

export interface GatheringRewardItem {
  itemId: string;
  quantity: number;
  stackable: boolean;
}

export interface GatheringRewardCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  resourceId: string;
  depleteAfterCommit: boolean;
  respawnTicks: number;
  skill: GatheringRewardSkill;
  xpAmount: number;
  reward: GatheringRewardItem;
  secondaryItemId: string | null;
}

export interface GatheringRewardCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  resourceId: string;
  depleteAfterCommit: boolean;
  respawnTicks: number;
  depletedUntil: number | null;
  skill: GatheringRewardSkill;
  xpAmount: number;
  reward: GatheringRewardItem;
  secondaryItemId: string | null;
  awardedXp: number;
  operationCommittedXp: number;
  currentXp: number;
  currentLevel: number;
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export interface GatheringResourceState {
  resourceId: string;
  operationId: string;
  depletedAt: number;
  respawnAt: number;
}

export type ProcessingActionSkill =
  | "firemaking"
  | "cooking"
  | "smithing"
  | "crafting"
  | "fletching"
  | "runecrafting";

export interface ProcessingActionItem {
  itemId: string;
  quantity: number;
  stackable: boolean;
}

export interface ProcessingActionConsumable {
  itemId: string;
  usesPerItem: number;
}

export interface ProcessingActionConsumableState extends ProcessingActionConsumable {
  remainingUses: number;
  consumedQuantity: 0 | 1;
}

export interface ProcessingActionFireEffectRequest {
  kind: "fire";
  fireId: string;
  position: { x: number; y: number; z: number };
  tile: { x: number; z: number };
  durationMs: number;
}

export interface ProcessingActionFireEffect {
  kind: "fire";
  fireId: string;
  position: { x: number; y: number; z: number };
  tile: { x: number; z: number };
  createdAt: number;
  expiresAt: number;
}

export interface ActiveProcessingFire extends ProcessingActionFireEffect {
  playerId: string;
  databaseObservedAt?: number;
}

export interface ProcessingFireExtinguishCommitRequest {
  operationId: string;
  fireId: string;
  playerId: string;
  requestFingerprint: string;
  position: { x: number; y: number; z: number };
  expiresAt: number;
  source: GroundItemSourceRegistrationRequest;
}

export interface ProcessingFireExtinguishCommitReceipt {
  operationId: string;
  fireId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  position: { x: number; y: number; z: number };
  expiresAt: number;
  extinguishedAt: number;
  sourceRequest: GroundItemSourceRegistrationRequest;
  source: GroundItemSourceRegistrationReceipt;
}

export interface ProcessingActionCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  skill: ProcessingActionSkill;
  xpAmount: number;
  inputs: InventoryDebitRequirement[];
  requiredItems: InventoryDebitRequirement[];
  consumables: ProcessingActionConsumable[];
  outputs: ProcessingActionItem[];
  /** Optional protected money-pouch debit committed with the item transform. */
  coinCost?: number;
  /** Optional world effect committed atomically with this action. */
  worldEffect?: ProcessingActionFireEffectRequest;
}

export interface ProcessingActionCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  skill: ProcessingActionSkill;
  xpAmount: number;
  inputs: InventoryDebitRequirement[];
  requiredItems: InventoryDebitRequirement[];
  consumables: ProcessingActionConsumable[];
  consumableStates: ProcessingActionConsumableState[];
  outputs: ProcessingActionItem[];
  coinCost?: number;
  currentCoins?: number;
  worldEffect?: ProcessingActionFireEffect;
  awardedXp: number;
  operationCommittedXp: number;
  currentXp: number;
  currentLevel: number;
  committed: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
}

export interface EquipmentStackDebitCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  slotType: string;
  itemId: string;
  quantity: number;
}

export interface EquipmentStackDebitCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  slotType: string;
  itemId: string;
  quantity: number;
  committed: Array<{
    slotType: string;
    itemId: string;
    quantity: number;
  }>;
}

export type AmmunitionRecoveryDisposition = "recovered" | "destroyed";
export type AmmunitionShotOperationStatus =
  "pending" | "fired" | "resolved" | "cancelled";
export type AmmunitionShotRefundDestination =
  "equipment" | "inventory" | "bank";

export interface AmmunitionShotCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  itemId: string;
  quantity: 1;
  recoveryDisposition: AmmunitionRecoveryDisposition;
  source: GroundItemSourceRegistrationRequest | null;
}

export interface AmmunitionShotCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  itemId: string;
  quantity: 1;
  recoveryDisposition: AmmunitionRecoveryDisposition;
  status: AmmunitionShotOperationStatus;
  committed: Array<{
    slotType: string;
    itemId: string;
    quantity: number;
  }>;
  committedInventory: Array<{
    itemId: string;
    quantity: number;
    slotIndex: number;
    metadata: Record<string, string | number | boolean> | null;
  }>;
  refundDestination: AmmunitionShotRefundDestination | null;
  sourceRequest: GroundItemSourceRegistrationRequest | null;
  source: GroundItemSourceRegistrationReceipt | null;
}

export interface AmmunitionShotSettlementRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
}

export interface AttackStyleCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  requestedStyle: string;
  publicActionObservation?: StreamingDuelStyleObservationContext;
}

export interface AttackStyleCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  requestedStyle: string;
  replayed: boolean;
  operationCommittedStyle: string;
  currentStyle: string;
}

export type StreamingDuelExecutorCommand =
  | Readonly<{
      kind: "movement";
      mode: "ground";
      target: readonly [number, number, number];
      runMode: boolean;
    }>
  | Readonly<{
      kind: "movement";
      mode: "combat_approach";
      targetId: string;
      targetType: "player";
    }>
  | Readonly<{
      kind: "engagement";
      targetId: string;
      targetType: "player";
    }>;

export type StreamingDuelExecutorCommandOutcome =
  "accepted" | "rejected" | "error";

export interface StreamingDuelExecutorCommandRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  publicActionObservation: StreamingDuelExecutorObservationContext;
  command: StreamingDuelExecutorCommand;
}

export interface StreamingDuelExecutorCommandCompletionRequest extends StreamingDuelExecutorCommandRequest {
  outcome: StreamingDuelExecutorCommandOutcome;
}

export interface StreamingDuelExecutorCommandReceipt extends StreamingDuelExecutorCommandRequest {
  replayed: boolean;
  completed: boolean;
  outcome: StreamingDuelExecutorCommandOutcome | null;
}

export interface PrayerPersistenceSnapshot {
  pointUnits: number;
  maxPoints: number;
  activePrayers: string[];
}

export type PrayerStateTransitionKind =
  "toggle" | "drain" | "deactivate_all" | "restore" | "set_max" | "repair";

export interface PrayerStateCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  transition: PrayerStateTransitionKind;
  expected: PrayerPersistenceSnapshot;
  committed: PrayerPersistenceSnapshot;
  publicActionObservation?: StreamingDuelPrayerObservationContext;
}

export interface PrayerStateCommitReceipt {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  transition: PrayerStateTransitionKind;
  replayed: boolean;
  committed: PrayerPersistenceSnapshot;
}

// ============================================================================
// DATABASE SYSTEM INTERFACES
// ============================================================================

/**
 * Database system operation signatures
 *
 * Defines the async methods available on DatabaseSystem for
 * querying and persisting game data.
 */
export interface DatabaseSystemOperations {
  getPlayerInventoryAsync?: (playerId: string) => Promise<
    Array<{
      itemId: string | number;
      quantity: number;
      slotIndex: number | null;
    }>
  >;
  getPlayerEquipmentAsync?: (playerId: string) => Promise<EquipmentRow[]>;
  commitAttackStyleOperationAsync?: (
    request: AttackStyleCommitRequest,
  ) => Promise<AttackStyleCommitReceipt>;
  stageStreamingDuelExecutorCommandAsync?: (
    request: StreamingDuelExecutorCommandRequest,
  ) => Promise<StreamingDuelExecutorCommandReceipt>;
  completeStreamingDuelExecutorCommandAsync?: (
    request: StreamingDuelExecutorCommandCompletionRequest,
  ) => Promise<StreamingDuelExecutorCommandReceipt>;
  listPendingStreamingDuelExecutorCommandsAsync?: (
    cycleId: string,
  ) => Promise<StreamingDuelExecutorCommandReceipt[]>;
  commitCombatLoadoutOperationAsync?: (
    request: CombatLoadoutCommitRequest,
  ) => Promise<CombatLoadoutCommitReceipt>;
  commitDuelPreparationPlanOperationAsync?: (
    request: DuelPreparationPlanCommitRequest,
  ) => Promise<DuelPreparationPlanCommitReceipt>;
  getDuelPreparationPlanOperationAsync?: (
    request: DuelPreparationPlanRecoveryRequest,
  ) => Promise<DuelPreparationPlanCommitReceipt | null>;
  commitInventoryDebitOperationAsync?: (
    request: InventoryDebitCommitRequest,
  ) => Promise<InventoryDebitCommitReceipt>;
  commitProjectileRuneCostOperationAsync?: (
    request: ProjectileRuneCostCommitRequest,
  ) => Promise<ProjectileRuneCostCommitReceipt>;
  completeProjectileRuneCostOperationAsync?: (
    request: ProjectileRuneCostSettlementRequest,
  ) => Promise<ProjectileRuneCostCommitReceipt>;
  cancelProjectileRuneCostOperationAsync?: (
    request: ProjectileRuneCostSettlementRequest,
  ) => Promise<ProjectileRuneCostCommitReceipt>;
  recoverPendingProjectileRuneCostOperationsAsync?: (
    playerId: string,
  ) => Promise<ProjectileRuneCostCommitReceipt[]>;
  registerGroundItemSourceAsync?: (
    request: GroundItemSourceRegistrationRequest,
  ) => Promise<GroundItemSourceRegistrationReceipt>;
  registerGroundItemSourcesAsync?: (
    requests: GroundItemSourceRegistrationRequest[],
  ) => Promise<GroundItemSourceRegistrationReceipt[]>;
  commitGroundItemDropOperationAsync?: (
    request: GroundItemDropCommitRequest,
  ) => Promise<GroundItemDropCommitReceipt>;
  commitGroundItemDeathOperationAsync?: (
    request: GroundItemDeathCommitRequest,
  ) => Promise<GroundItemDeathCommitReceipt>;
  commitGroundItemMobLootOperationAsync?: (
    request: GroundItemMobLootCommitRequest,
  ) => Promise<GroundItemMobLootCommitReceipt>;
  listActiveGroundItemSourcesAsync?: () => Promise<GroundItemSourceState[]>;
  expireGroundItemSourceAsync?: (sourceId: string) => Promise<boolean>;
  commitGroundItemPickupOperationAsync?: (
    request: GroundItemPickupCommitRequest,
  ) => Promise<GroundItemPickupCommitReceipt>;
  commitFoodConsumptionOperationAsync?: (
    request: FoodConsumptionCommitRequest,
  ) => Promise<FoodConsumptionCommitReceipt>;
  completeFoodConsumptionOperationAsync?: (
    request: FoodConsumptionCompleteRequest,
  ) => Promise<FoodConsumptionCommitReceipt>;
  recoverPendingFoodConsumptionOperationsAsync?: (
    playerId: string,
  ) => Promise<FoodConsumptionCommitReceipt[]>;
  commitDuelDamageOperationAsync?: (
    request: DuelDamageCommitRequest,
  ) => Promise<DuelDamageCommitReceipt>;
  commitBoneBurialOperationAsync?: (
    request: BoneBurialCommitRequest,
  ) => Promise<BoneBurialCommitReceipt>;
  commitQuestStartOperationAsync?: (
    request: QuestStartCommitRequest,
  ) => Promise<QuestStartCommitReceipt>;
  commitQuestCompletionOperationAsync?: (
    request: QuestCompletionCommitRequest,
  ) => Promise<QuestCompletionCommitReceipt>;
  commitGatheringRewardOperationAsync?: (
    request: GatheringRewardCommitRequest,
  ) => Promise<GatheringRewardCommitReceipt>;
  getGatheringResourceStatesAsync?: (
    resourceIds: string[],
  ) => Promise<GatheringResourceState[]>;
  commitProcessingActionOperationAsync?: (
    request: ProcessingActionCommitRequest,
  ) => Promise<ProcessingActionCommitReceipt>;
  getProcessingActionCommitStatusAsync?: (
    playerId: string,
    operationId: string,
  ) => Promise<"committed" | "not_found">;
  getActiveProcessingFiresAsync?: () => Promise<ActiveProcessingFire[]>;
  commitProcessingFireExtinguishOperationAsync?: (
    request: ProcessingFireExtinguishCommitRequest,
  ) => Promise<ProcessingFireExtinguishCommitReceipt>;
  commitEquipmentStackDebitOperationAsync?: (
    request: EquipmentStackDebitCommitRequest,
  ) => Promise<EquipmentStackDebitCommitReceipt>;
  commitAmmunitionShotOperationAsync?: (
    request: AmmunitionShotCommitRequest,
  ) => Promise<AmmunitionShotCommitReceipt>;
  completeAmmunitionShotOperationAsync?: (
    request: AmmunitionShotSettlementRequest,
  ) => Promise<AmmunitionShotCommitReceipt>;
  cancelAmmunitionShotOperationAsync?: (
    request: AmmunitionShotSettlementRequest,
  ) => Promise<AmmunitionShotCommitReceipt>;
  recoverPendingAmmunitionShotOperationsAsync?: (
    playerId: string,
  ) => Promise<AmmunitionShotCommitReceipt[]>;
  commitPrayerStateOperationAsync?: (
    request: PrayerStateCommitRequest,
  ) => Promise<PrayerStateCommitReceipt>;
  getPlayerAsync?: (playerId: string) => Promise<{ coins?: number } | null>;
}
