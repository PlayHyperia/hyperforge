/**
 * Database row types for the persistence layer
 * These types represent the structure of data as stored in the database
 */

import { EquipmentSlotName } from "../core/core";
import type {
  StreamingDuelDamageObservationContext,
  StreamingDuelExecutorObservationContext,
  StreamingDuelFoodObservationContext,
  StreamingDuelPrayerObservationContext,
  StreamingDuelRoleSwitchObservationContext,
  StreamingDuelStyleObservationContext,
} from "../game/streaming-duel-action-observation";

// Boolean representation in database (0 or 1 for compatibility)
type SQLiteBoolean = 0 | 1;

// Types for database method parameters
export interface InventorySaveItem {
  itemId: string;
  quantity: number;
  slotIndex: number;
  metadata: Record<string, string | number | boolean> | null;
}

export interface EquipmentSaveItem {
  slotType: string;
  itemId: string;
  quantity: number;
}

/** Complete custody state committed by one authoritative combat-loadout change. */
export interface CombatLoadoutPersistenceSnapshot {
  inventory: InventorySaveItem[];
  equipment: EquipmentSaveItem[];
  selectedSpell: string | null;
}

/**
 * Idempotent database request for changing a combat loadout. The expected
 * snapshot fences the write against stale in-memory state, while the operation
 * receipt makes a lost commit response safe to replay after process recovery.
 */
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

/** One exact bank row included in a selected-contestant preparation commit. */
export interface BankSaveItem {
  itemId: string;
  quantity: number;
  slot: number;
  tabIndex: number;
}

/** Complete bank, carried inventory, equipment, and autocast custody state. */
export interface DuelPreparationPlanPersistenceSnapshot extends CombatLoadoutPersistenceSnapshot {
  bank: BankSaveItem[];
}

/**
 * Immutable public planning evidence stored beside the private custody receipt.
 * The server owns the concrete schema and validates it again before readiness;
 * the shared custody layer only requires a plain JSON object.
 */
export type DuelPreparationPlanRecoveryEvidence = Record<string, unknown>;

/**
 * One idempotent whole-plan selected-contestant preparation transition. The
 * expected snapshot fences stale planners; the database verifies custody
 * conservation before committing every bank/equipment/autocast row together.
 */
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

/** One item quantity included in an authoritative inventory debit. */
export interface InventoryDebitRequirement {
  itemId: string;
  quantity: number;
}

/**
 * Idempotent request for consuming several inventory items as one custody
 * transition. The database derives the committed inventory from its locked,
 * authoritative state; callers never perform a sequence of partial removals.
 */
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
  committed: InventorySaveItem[];
}

export type ProjectileRuneCostOperationStatus =
  "pending" | "fired" | "resolved" | "cancelled";
export type ProjectileRuneCostRefundDestination =
  "inventory" | "bank" | "mixed";

/** Exact multi-rune debit staged before a spell projectile is admitted. */
export interface ProjectileRuneCostCommitRequest extends InventoryDebitCommitRequest {}

export interface ProjectileRuneCostSettlementRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
}

export interface ProjectileRuneCostSettlementHandle extends ProjectileRuneCostSettlementRequest {
  requirements: InventoryDebitRequirement[];
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

/** Durable lifecycle state for one exact ground-source occurrence. */
export type GroundItemSourceStatus = "active" | "claimed" | "expired";

/** Authoritative source state reconstructed by a replacement world authority. */
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

/**
 * One idempotent contribution to a durable ground source. PostgreSQL may merge
 * compatible stackable contributions while preserving each contribution ID.
 */
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

/** Exact registration replay plus the source's current terminal or active state. */
export interface GroundItemSourceRegistrationReceipt extends GroundItemSourceState {
  contributionId: string;
  requestFingerprint: string;
  replayed: boolean;
}

/** One manual drop whose debit and durable source are committed together. */
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

/** One public-zone death whose owned custody and every resulting source co-commit. */
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

/** One authoritative mob-death occurrence and its frozen loot-source roll. */
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

/**
 * One exact ground source credited to a player's durable destination custody.
 * The source identity is serialized independently from the player so two world
 * authorities cannot both credit the same drop.
 */
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
  /** Exact balance written by this operation for a coin source, otherwise null. */
  operationCommittedCoins: number | null;
  /** Current locked balance at response time; safe to apply after an old replay. */
  currentCoins: number;
  /** Current locked inventory at response time; safe to apply after an old replay. */
  committed: InventorySaveItem[];
}

/** Durable lifecycle of one food item debit and its matching health effect. */
export type FoodConsumptionOperationStatus = "pending" | "completed";

/** Why a completed food operation produced no health increase. */
export type FoodConsumptionCompletionReason =
  "player_not_alive" | "full_health";

/**
 * Starts one idempotent food operation. The database validates the registered
 * item, debits exactly one unit, and records a recoverable pending health
 * effect while holding the character custody lock.
 */
export interface FoodConsumptionCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  itemId: string;
  healAmount: number;
  /** Present only for an authoritative in-progress streaming duel action. */
  publicActionObservation?: StreamingDuelFoodObservationContext;
}

/** Completes (or replays) the health half of a durable food operation. */
export interface FoodConsumptionCompleteRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
}

/** Durable result shared by begin, completion, replay, and startup recovery. */
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
  committed: InventorySaveItem[];
}

/** One idempotent streaming-duel hit committed with target health and public evidence. */
export interface DuelDamageCompetitiveAuthority {
  preparationId: string;
  fencingToken: string;
  snapshotDigest: string;
}

/** Exact competitive win co-committed by a lethal persisted-duel hit. */
export interface DuelDamageCompetitiveTerminal {
  outcome: "win";
  winnerId: string;
  loserId: string;
  winReason: "kill";
  terminalAt: number;
  seed: string;
  replayHash: string;
}

/** Exact fired projectile cost that must settle with one durable duel hit. */
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

/** One idempotent bone burial that consumes custody and awards Prayer XP. */
export interface BoneBurialCommitRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  itemId: string;
  xpAmount: number;
  levelRequired: number;
}

/** Durable result of an atomic bone debit, Prayer progression, and point sync. */
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
  committed: InventorySaveItem[];
}

/** Skills that a quest definition may reward directly on completion. */
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

/** One manifest-authored item credited by a quest completion. */
export interface QuestCompletionRewardItem {
  itemId: string;
  quantity: number;
  stackable: boolean;
}

/** One manifest-authored starter item credited with durable quest acceptance. */
export interface QuestStartRewardItem {
  itemId: string;
  quantity: number;
  stackable: boolean;
}

/**
 * Starts one exact quest incarnation. The progress row, starter inventory,
 * audit record, and replay receipt commit together.
 */
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
  committed: InventorySaveItem[];
}

/** One manifest-authored skill reward committed with the quest result. */
export interface QuestCompletionRewardXp {
  skill: QuestRewardSkill;
  xpAmount: number;
}

/** Durable progression result for one quest reward skill. */
export interface QuestCompletionProgressReceipt extends QuestCompletionRewardXp {
  awardedXp: number;
  operationCommittedXp: number;
  currentXp: number;
  currentLevel: number;
}

/**
 * Completes one exact quest incarnation. Quest state, points, reward items,
 * direct XP, Prayer state, and the replay receipt commit together.
 */
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
  /** Current locked Prayer state when a Prayer reward exists, otherwise null. */
  prayer: PrayerPersistenceSnapshot | null;
  /** Current locked inventory at response time, safe for delayed replay apply. */
  committed: InventorySaveItem[];
}

/** Gathering skills whose reward XP is persisted with the harvested item. */
export type GatheringRewardSkill = "woodcutting" | "mining" | "fishing";

/** The item credited by one successful, authoritative gathering roll. */
export interface GatheringRewardItem {
  itemId: string;
  quantity: number;
  stackable: boolean;
}

/**
 * One durable gathering result. The optional secondary item debit, reward
 * credit, skill XP/level update, and idempotency receipt commit together.
 */
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
  /** Canonical wall-clock deadline for a depleted node, or null when it remains available. */
  depletedUntil: number | null;
  skill: GatheringRewardSkill;
  xpAmount: number;
  reward: GatheringRewardItem;
  secondaryItemId: string | null;
  awardedXp: number;
  operationCommittedXp: number;
  currentXp: number;
  currentLevel: number;
  committed: InventorySaveItem[];
}

/** Persisted active depletion for one stable world resource identity. */
export interface GatheringResourceState {
  resourceId: string;
  operationId: string;
  depletedAt: number;
  respawnAt: number;
}

/** Processing skills whose recipe XP is persisted with their item transform. */
export type ProcessingActionSkill =
  | "firemaking"
  | "cooking"
  | "smithing"
  | "crafting"
  | "fletching"
  | "runecrafting";

/** One output credited by an authoritative processing action. */
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

/**
 * Server-authored fire requested as part of a Firemaking custody transition.
 * The database assigns the authoritative lifetime timestamps when it commits
 * the matching inventory debit and skill reward.
 */
export interface ProcessingActionFireEffectRequest {
  kind: "fire";
  fireId: string;
  position: { x: number; y: number; z: number };
  tile: { x: number; z: number };
  durationMs: number;
}

/** A committed fire world effect that can be reconstructed after a restart. */
export interface ProcessingActionFireEffect {
  kind: "fire";
  fireId: string;
  position: { x: number; y: number; z: number };
  tile: { x: number; z: number };
  createdAt: number;
  expiresAt: number;
}

/** A committed active fire with the owning player required for world recovery. */
export interface ActiveProcessingFire extends ProcessingActionFireEffect {
  playerId: string;
  /** Database clock sampled with the recovery query; absent only for live commits. */
  databaseObservedAt?: number;
}

/** One fire-expiry transition whose ash source is committed in the same write. */
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

/**
 * One durable recipe action. Every input debit, output credit, skill XP/level
 * update, and idempotency receipt commits as one custody transition.
 */
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
  committed: InventorySaveItem[];
}

/** Idempotent debit of one stack held in an exact equipment slot. */
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
  committed: EquipmentSaveItem[];
}

export type AmmunitionRecoveryDisposition = "recovered" | "destroyed";
export type AmmunitionShotOperationStatus =
  "pending" | "fired" | "resolved" | "cancelled";
export type AmmunitionShotRefundDestination =
  "equipment" | "inventory" | "bank";

/** One fired arrow whose debit and optional recovery source commit together. */
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
  committed: EquipmentSaveItem[];
  committedInventory: InventorySaveItem[];
  refundDestination: AmmunitionShotRefundDestination | null;
  sourceRequest: GroundItemSourceRegistrationRequest | null;
  source: GroundItemSourceRegistrationReceipt | null;
}

/** Immutable identity used to settle one previously staged shot. */
export interface AmmunitionShotSettlementRequest {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
}

/** Private in-process handle carried by the reserved projectile. */
export interface AmmunitionShotSettlementHandle extends AmmunitionShotSettlementRequest {
  itemId: string;
  recoveryDisposition: AmmunitionRecoveryDisposition;
}

/**
 * Idempotent attack-style authority. A duel context causes the accepted public
 * acknowledgement to commit in the same transaction as the character style.
 */
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
  /** Style written by this immutable operation. */
  operationCommittedStyle: string;
  /** Current locked character style at receipt/replay time. */
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

/** Immutable write-ahead command staged before an in-memory executor call. */
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

/** Fixed-point prayer state persisted at one million units per point. */
export interface PrayerPersistenceSnapshot {
  pointUnits: number;
  maxPoints: number;
  activePrayers: string[];
}

export type PrayerStateTransitionKind =
  "toggle" | "drain" | "deactivate_all" | "restore" | "set_max" | "repair";

/**
 * Idempotent, compare-and-swap prayer transition. The database locks the same
 * character row used by combat inventory/equipment custody so prayer state
 * cannot race another authoritative writer for that contestant.
 */
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

export interface WorldChunkData {
  chunkX: number;
  chunkZ: number;
  data: string; // JSON-serialized chunk data
  lastActive: number;
  playerCount: number;
  version: number;
}

// Player data row
export interface PlayerRow {
  id: number;
  playerId: string;
  name: string;
  combatLevel: number;
  attackLevel: number;
  strengthLevel: number;
  defenseLevel: number;
  constitutionLevel: number;
  rangedLevel: number;
  attackXp: number;
  strengthXp: number;
  defenseXp: number;
  constitutionXp: number;
  rangedXp: number;
  prayerLevel: number;
  prayerXp: number;
  prayerPoints: number;
  prayerPointUnits?: number;
  prayerMaxPoints: number;
  activePrayers: string[] | string; // JSONB array of prayer IDs (legacy string supported)
  health: number;
  maxHealth: number;
  coins: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  attackStyle?: string; // Combat style preference (accurate, aggressive, defensive)
  autoRetaliate?: number; // Auto-retaliate setting: 1=ON (default), 0=OFF
  selectedSpell?: string | null; // Autocast spell ID (null = no autocast)
  magicLevel?: number; // Magic skill level (F2P)
  magicXp?: number; // Magic skill XP (F2P)
  lastLogin: number;
  createdAt: number;
  woodcuttingLevel: number;
  woodcuttingXp: number;
  miningLevel: number;
  miningXp: number;
  fishingLevel: number;
  fishingXp: number;
  firemakingLevel: number;
  firemakingXp: number;
  cookingLevel: number;
  cookingXp: number;
  smithingLevel: number;
  smithingXp: number;
  agilityLevel: number;
  agilityXp: number;
  craftingLevel: number;
  craftingXp: number;
  fletchingLevel: number;
  fletchingXp: number;
  runecraftingLevel: number;
  runecraftingXp: number;
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

// Item definition row
export interface ItemRow {
  id: number;
  name: string;
  type: string;
  description: string;
  value: number;
  weight: number;
  stackable: SQLiteBoolean;
  tradeable: SQLiteBoolean;
  attackLevel: number | null;
  strengthLevel: number | null;
  defenseLevel: number | null;
  rangedLevel: number | null;
  attackBonus: number;
  strengthBonus: number;
  defenseBonus: number;
  rangedBonus: number;
  heals: number | null;
  maxStackSize: number;
  equipSlot: string | null;
}

// Player inventory row
export interface InventoryRow {
  id: number;
  playerId: string;
  itemId: string;
  quantity: number;
  slotIndex: number;
  metadata: string | null; // JSON string for additional item data
}

// Player equipment row
export interface EquipmentRow {
  id: number;
  playerId: string;
  slotType: EquipmentSlotName;
  itemId: string | null;
  quantity: number;
}

// Bank storage row
export interface BankRow {
  id: number;
  playerId: string;
  bankId: string;
  itemId: string;
  quantity: number;
  slotIndex: number;
  metadata: string | null;
}

// Store inventory row
export interface StoreRow {
  id: number;
  storeId: string;
  itemId: string;
  price: number;
  stock: number;
  maxStock: number;
  restockTime: number;
  lastRestock: number;
}

// Player session row
export interface SessionRow {
  id: number;
  sessionId: string;
  playerId: string;
  startTime: number;
  endTime: number | null;
  isActive: SQLiteBoolean;
  lastActivity: number;
  ipAddress: string | null;
  userAgent: string | null;
}

// Combat log row
export interface CombatLogRow {
  id: number;
  attackerId: string;
  attackerType: "player" | "mob";
  targetId: string;
  targetType: "player" | "mob";
  damage: number;
  weaponType: string; // Stored as string in DB; maps to AttackType enum at runtime
  combatStyle: string; // Stored as string in DB; maps to CombatStyle type at runtime
  timestamp: number;
  sessionId: string;
}

// Death log row
export interface DeathLogRow {
  id: number;
  playerId: string;
  killedBy: string;
  killerType: "player" | "mob" | "environment";
  deathLocation: string; // JSON string with x, y, z
  itemsLost: string | null; // JSON array of item IDs
  timestamp: number;
  sessionId: string;
}

// Resource respawn row
export interface ResourceRespawnRow {
  id: number;
  resourceId: string;
  resourceType: "tree" | "rock" | "fishing_spot";
  position: string; // JSON string with x, y, z
  respawnTime: number;
  lastHarvested: number;
  harvestedBy: string;
}

// NPC state row
export interface NPCStateRow {
  id: number;
  npcId: string;
  npcType: string;
  position: string; // JSON string with x, y, z
  health: number;
  maxHealth: number;
  state: "idle" | "combat" | "fleeing" | "dead";
  lastUpdate: number;
}

// Quest progress row
export interface QuestProgressRow {
  id: number;
  playerId: string;
  questId: string;
  status: "not_started" | "in_progress" | "completed" | "failed";
  progress: string; // JSON string with quest-specific progress data
  startTime: number | null;
  completionTime: number | null;
}

// NPC kills row
export interface NPCKillsRow {
  id: number;
  playerId: string;
  npcId: string;
  killCount: number;
}

// Trade log row
export interface TradeLogRow {
  id: number;
  player1Id: string;
  player2Id: string;
  player1Items: string; // JSON array of items traded
  player2Items: string; // JSON array of items traded
  timestamp: number;
  sessionId: string;
}

// Helper type for JSON columns with type safety
export type JSONString<T> = string & { __json: T };

// Helper functions for JSON serialization
export function toJSONString<T>(data: T): JSONString<T> {
  return JSON.stringify(data) as JSONString<T>;
}

export function fromJSONString<T>(
  json: JSONString<T> | string | null,
): T | null {
  if (!json) return null;
  return JSON.parse(json) as T;
}

// Database System types
export interface WorldChunkRow extends WorldChunkData {
  needsReset: SQLiteBoolean;
}

export interface PlayerSessionRow {
  id: string;
  sessionId: string; // Alias for id to maintain compatibility
  playerId: string;
  sessionStart: number;
  sessionEnd: number | null;
  playtimeMinutes: number;
  reason: string | null;
  lastActivity: number;
}

// Client token/session types for client identity
export interface ClientPlayerToken {
  playerId: string;
  tokenSecret: string;
  playerName: string;
  createdAt: Date;
  lastSeen: Date;
  sessionId: string;
  machineId: string;
  clientVersion: string;
  hyperiaUserId: string;
  hyperiaLinked: boolean;
  persistenceVersion: number;
}

export interface PlayerSession {
  sessionId: string;
  playerId: string;
  startTime: Date;
  lastActivity: Date;
  isActive: boolean;
}

// Database migration interfaces
export interface PluginMigration {
  name: string;
  up: (knex: unknown) => Promise<void>; // Using unknown to avoid Knex dependency in types
  down?: (knex: unknown) => Promise<void>;
}

// SystemDatabase query builder interface
// Models Knex-like query builder with chainable methods
interface QueryBuilder {
  // Chainable where methods
  where(key: string, value: unknown): QueryBuilder;
  where(key: string, operator: string, value: unknown): QueryBuilder;
  where(callback: (builder: QueryBuilder) => void): QueryBuilder;
  whereNull(key: string): QueryBuilder;
  whereIn(key: string, values: unknown[]): QueryBuilder;
  whereRaw(sql: string, bindings?: unknown[]): QueryBuilder;
  orWhere(key: string, operator: string, value: unknown): QueryBuilder;

  // Terminal methods
  first(): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<number>;
  delete(): Promise<number>;

  // Select with chaining
  select(columns?: string | string[]): QueryBuilder;

  // Promise interface
  then<T>(onfulfilled: (value: unknown[]) => T): Promise<T>;
  catch<T>(onrejected: (reason: unknown) => T): Promise<T>;
}

// SystemDatabase type definition
export type SystemDatabase = (table: string) => QueryBuilder & {
  insert(
    data: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<void>;
};

// TypedKnexDatabase - alias for SystemDatabase with type safety
export type TypedKnexDatabase = SystemDatabase;

// Core database row types
export interface ConfigRow {
  key: string;
  value: string;
}

export interface UserRow {
  id: string;
  name: string;
  roles: string;
  createdAt: string;
  avatar: string | null;
  privyUserId: string | null;
  farcasterFid: string | null;
}

export interface EntityRow {
  id: string;
  data: string;
  createdAt: string;
  updatedAt: string;
}

// Generic DatabaseRow type for any row
export type DatabaseRow = Record<string, unknown>;

// Database helper functions
export const dbHelpers = {
  async setConfig(
    db: SystemDatabase,
    key: string,
    value: string,
  ): Promise<void> {
    const existing = await db("config").where("key", key).first();
    if (existing) {
      await db("config").where("key", key).update({ value });
      return;
    }
    await db("config").insert({ key, value });
  },
};

// Type guard for checking if an object is a SystemDatabase instance
export function isDatabaseInstance(db: unknown): db is SystemDatabase {
  return typeof db === "function";
}
