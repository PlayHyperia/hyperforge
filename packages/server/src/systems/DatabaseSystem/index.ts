/**
 * DatabaseSystem - Server-side database operations for persistent game state
 *
 * This system provides a comprehensive interface for all database operations in Hyperia.
 * It uses PostgreSQL with Drizzle ORM for type-safe queries and migrations.
 *
 * Architecture (Refactored):
 * - DatabaseSystem acts as a facade/coordinator
 * - Domain-specific operations delegated to repositories
 * - Each repository handles one area (players, inventory, equipment, etc.)
 * - Maintains backward compatibility with all existing methods
 *
 * Key responsibilities:
 * - Character management (create, load, save character data)
 * - Player persistence (stats, position, levels, XP)
 * - Inventory and equipment storage
 * - Session tracking (login/logout times, playtime)
 * - World chunk persistence (terrain modifications, entities)
 *
 * Usage:
 * ```typescript
 * const dbSystem = world.getSystem('database') as DatabaseSystem;
 * const player = await dbSystem.getPlayerAsync(playerId);
 * await dbSystem.savePlayerAsync(playerId, { health: 100 });
 * ```
 */

import {
  BANKING_CONSTANTS,
  calculateCombatLevel,
  COMBAT_CONSTANTS,
  getItem,
  isStyleValidForWeapon,
  MAX_MOB_COMBAT_DAMAGE,
  getProcessingRequestOperationId,
  isPositionInsideDuelArenaZone,
  normalizeProcessingRequestEnvelope,
  normalizeProcessingRequestId,
  parseStreamingDuelActionObservation,
  parseStreamingDuelDamageObservationContext,
  parseStreamingDuelExecutorObservationContext,
  parseStreamingDuelFoodObservationContext,
  parseStreamingDuelPrayerObservationContext,
  parseStreamingDuelRoleSwitchObservationContext,
  parseStreamingDuelStyleObservationContext,
  PROCESSING_CONSTANTS,
  serializeGroundItemDeathCommitFingerprint,
  serializeGroundItemDropCommitFingerprint,
  serializeGroundItemMobLootCommitFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
  getProcessingFireExtinguishOperationId,
  serializeProcessingFireExtinguishFingerprint,
  ammunitionShotIdentityFromRequest,
  serializeAmmunitionShotFingerprint,
  STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  SystemBase,
  TICK_DURATION_MS,
  validateKillTokenSignature,
  worldToTile,
  WeaponType,
} from "@hyperforge/shared";
import type {
  ProcessingRequestEnvelope,
  ProcessingSkill,
  RecoverableProcessingRequest,
  StreamingDuelActionObservation,
  StreamingDuelDamageObservationContext,
  StreamingDuelExecutorObservationContext,
  StreamingDuelFoodObservationContext,
  StreamingDuelPrayerObservationContext,
  StreamingDuelRoleSwitchObservationContext,
  StreamingDuelStyleObservationContext,
  World,
} from "@hyperforge/shared";
import { createHash, randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type pg from "pg";
import * as schema from "../../database/schema";
import {
  runInPostgresTransaction,
  type PostgresIsolationLevel,
} from "../../database/postgres-transaction";
import {
  assertCompactedPrayerStateReceiptMatches,
  normalizePrayerSnapshot,
  prayerPublicObservationMatchesTransition,
  prayerSnapshotsEqual,
  prayerStateFingerprint,
  PRAYER_POINT_UNITS_PER_POINT,
  PRAYER_TRANSITIONS,
  type StoredPrayerStateOperation,
  validatePrayerTransition,
} from "../../database/prayer-operation-receipt";
import type {
  EquipmentRow,
  EquipmentSaveItem,
  EquipmentStackDebitCommitReceipt,
  EquipmentStackDebitCommitRequest,
  AmmunitionShotCommitReceipt,
  AmmunitionShotCommitRequest,
  AmmunitionShotRefundDestination,
  AmmunitionShotSettlementRequest,
  CombatLoadoutCommitReceipt,
  CombatLoadoutCommitRequest,
  CombatLoadoutPersistenceSnapshot,
  DuelPreparationPlanCommitReceipt,
  DuelPreparationPlanCommitRequest,
  DuelPreparationPlanPersistenceSnapshot,
  DuelPreparationPlanRecoveryEvidence,
  DuelPreparationPlanRecoveryRequest,
  InventoryDebitCommitReceipt,
  InventoryDebitCommitRequest,
  InventoryDebitRequirement,
  ProjectileRuneCostCommitReceipt,
  ProjectileRuneCostCommitRequest,
  ProjectileRuneCostRefundDestination,
  ProjectileRuneCostSettlementRequest,
  GroundItemSourceRegistrationReceipt,
  GroundItemSourceRegistrationRequest,
  GroundItemDropCommitReceipt,
  GroundItemDropCommitRequest,
  GroundItemDeathCommitReceipt,
  GroundItemDeathCommitRequest,
  GroundItemMobLootCommitReceipt,
  GroundItemMobLootCommitRequest,
  MobCombatProgressReceipt,
  MobCombatProgressSkill,
  GroundItemSourceState,
  GroundItemSourceStatus,
  GroundItemPickupCommitReceipt,
  GroundItemPickupCommitRequest,
  FoodConsumptionCommitReceipt,
  FoodConsumptionCommitRequest,
  FoodConsumptionCompleteRequest,
  FoodConsumptionCompletionReason,
  DuelDamageCompetitiveAuthority,
  DuelDamageCompetitiveTerminal,
  DuelDamageProjectileCostAuthority,
  DuelDamageCommitReceipt,
  DuelDamageCommitRequest,
  BoneBurialCommitReceipt,
  BoneBurialCommitRequest,
  QuestStartCommitReceipt,
  QuestStartCommitRequest,
  QuestStartRewardItem,
  QuestCompletionCommitReceipt,
  QuestCompletionCommitRequest,
  QuestCompletionProgressReceipt,
  QuestCompletionRewardItem,
  QuestCompletionRewardXp,
  QuestRewardSkill,
  GatheringRewardCommitReceipt,
  GatheringRewardCommitRequest,
  GatheringRewardItem,
  GatheringResourceState,
  GatheringRewardSkill,
  ProcessingActionCommitReceipt,
  ProcessingActionCommitRequest,
  ProcessingActionConsumable,
  ProcessingActionConsumableState,
  ProcessingActionFireEffect,
  ProcessingActionFireEffectRequest,
  ActiveProcessingFire,
  ProcessingFireExtinguishCommitReceipt,
  ProcessingFireExtinguishCommitRequest,
  ProcessingActionItem,
  ProcessingActionSkill,
  InventoryRow,
  InventorySaveItem,
  PrayerPersistenceSnapshot,
  PrayerStateCommitReceipt,
  PrayerStateCommitRequest,
  PrayerStateTransitionKind,
  AttackStyleCommitReceipt,
  AttackStyleCommitRequest,
  StreamingDuelExecutorCommand,
  StreamingDuelExecutorCommandCompletionRequest,
  StreamingDuelExecutorCommandOutcome,
  StreamingDuelExecutorCommandReceipt,
  StreamingDuelExecutorCommandRequest,
  ItemRow,
  PlayerPersistenceUpdate,
  PlayerRow,
  PlayerSessionRow,
  WorldChunkRow,
  ActivityLogEntry,
  ActivityLogRow,
  ActivityLogQueryOptions,
  TradeEntry,
  TradeRow,
  TradeQueryOptions,
} from "../../shared/types";
import {
  CharacterRepository,
  PlayerRepository,
  InventoryRepository,
  EquipmentRepository,
  SessionRepository,
  WorldChunkRepository,
  NPCKillRepository,
  DeathRepository,
  TemplateRepository,
  QuestRepository,
  ActivityLogRepository,
  BankRepository,
} from "../../database/repositories";
import type { DeathLockData } from "../../database/repositories/DeathRepository";
import {
  assertGenericPlayerUpdateExcludesAttackStyleAuthority,
  assertGenericPlayerUpdateExcludesPrayerAuthority,
} from "../../database/prayer-custody-policy";
import {
  buildGenericCharacterUpdate,
  type GenericCharacterUpdate,
} from "../../database/generic-player-update";
import { buildCompetitiveTerminalProof } from "../StreamingDuelScheduler/competitive-terminal-proof.js";
import { buildCompetitiveTerminalStatUpdates } from "../StreamingDuelScheduler/competitive-terminal-stats.js";
import type { CompetitiveSnapshot } from "../StreamingDuelScheduler/competitive-snapshot.js";
import {
  normalizeDuelPreparationDecisionReceiptEvidence,
  type DuelPreparationDecisionReceiptEvidence,
} from "../StreamingDuelScheduler/preparation-decision-receipt.js";

const IS_PLAYWRIGHT_TEST = process.env.PLAYWRIGHT_TEST === "true";
const isTruthyEnv = (value: string | undefined): boolean =>
  value != null && /^(1|true|yes|on)$/i.test(value.trim());
const DISABLE_WORLD_CHUNK_PERSISTENCE =
  IS_PLAYWRIGHT_TEST ||
  isTruthyEnv(process.env.DISABLE_WORLD_CHUNK_PERSISTENCE);
const DB_WRITE_ERRORS_NON_FATAL =
  IS_PLAYWRIGHT_TEST ||
  isTruthyEnv(process.env.DB_WRITE_ERRORS_NON_FATAL) ||
  isTruthyEnv(process.env.DUEL_DB_WRITE_BEST_EFFORT);

function isTransientDbConnectivityError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);

  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "Connection terminated",
    "connection timeout",
    "failed to connect",
    "Connection terminated unexpectedly",
  ].some((pattern) => message.includes(pattern));
}

function hasPostgresConstraint(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (typeof current !== "object") return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

type StoredCombatLoadoutOperation = {
  version: 1;
  requestFingerprint: string;
  committed: CombatLoadoutPersistenceSnapshot;
  publicActionObservation?: StreamingDuelRoleSwitchObservationContext;
};

type StoredDuelPreparationPlanOperation =
  | {
      version: 2;
      preparationId: string;
      requestFingerprint: string;
      committed: DuelPreparationPlanPersistenceSnapshot;
      recoveryEvidence: DuelPreparationPlanRecoveryEvidence;
    }
  | {
      version: 3;
      preparationId: string;
      requestFingerprint: string;
      committed: DuelPreparationPlanPersistenceSnapshot;
      recoveryEvidence: DuelPreparationDecisionReceiptEvidence;
    };

type StoredInventoryDebitOperation = {
  version: 1;
  requestFingerprint: string;
  requirements: InventoryDebitRequirement[];
  committed: CommittedInventoryItem[];
};

type StoredProjectileRuneCostOperation = {
  version: 1;
  requestFingerprint: string;
  requirements: InventoryDebitRequirement[];
  committed: CommittedInventoryItem[];
  status: "pending" | "fired" | "resolved" | "cancelled";
  damageOperationId?: string | null;
  refundDestination: ProjectileRuneCostRefundDestination | null;
};

export type ProjectileCostCustodyStats = {
  pendingAmmunitionShots: number;
  firedAmmunitionShots: number;
  pendingRuneCosts: number;
  firedRuneCosts: number;
  invalidOperations: number;
  futureTimestampOperations: number;
  oldestUnresolvedAgeMs: number;
};

type StoredGroundItemDropOperation = {
  version: 1;
  requestFingerprint: string;
  itemId: string;
  quantity: number;
  slotIndex: number | null;
  sourceContributionId: string;
  sourceRequestFingerprint: string;
  sourceId: string;
  operationCommittedCoins: number | null;
};

type StoredGroundItemDeathOperation = {
  version: 1;
  requestFingerprint: string;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killedBy: string;
  zoneType: "wilderness" | "pvp_zone";
  dropped: DeathCustodyItem[];
  sourceContributionIds: string[];
  sourceRequestFingerprints: string[];
  sourceIds: string[];
};

type StoredGroundItemMobLootOperation = {
  version: 2;
  requestFingerprint: string;
  mobId: string;
  mobType: string;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killToken: string;
  attackStyle: string;
  damageDealt: number;
  combatProgress: Array<
    Pick<
      MobCombatProgressReceipt,
      "skill" | "xpAmount" | "awardedXp" | "operationCommittedXp"
    >
  >;
  dropped: DeathCustodyItem[];
  sources: GroundItemSourceRegistrationRequest[];
  sourceIds: string[];
};

type StoredProcessingFireExtinguishOperation = {
  version: 1;
  requestFingerprint: string;
  fireId: string;
  position: { x: number; y: number; z: number };
  expiresAt: number;
  extinguishedAt: number;
  source: GroundItemSourceRegistrationRequest;
  sourceId: string;
};

type StoredGroundItemPickupOperation = {
  version: 1;
  requestFingerprint: string;
  sourceEntityId: string;
  itemId: string;
  quantity: number;
  stackable: boolean;
  operationCommittedCoins: number | null;
};

type GroundItemSourceDatabaseRow = {
  source_id: string;
  status: string;
  item_id: string;
  quantity: number | string;
  stackable: boolean;
  position_x: number | string;
  position_y: number | string;
  position_z: number | string;
  tile_x: number | string;
  tile_z: number | string;
  dropped_by: string | null;
  created_at: number | string;
  updated_at: number | string;
  expires_at: number | string;
  loot_protection_expires_at: number | string | null;
  claimed_by_operation_id: string | null;
  claimed_by_player_id: string | null;
  claimed_at: number | string | null;
  version: number | string;
};

type StoredFoodConsumptionOperation = {
  version: 1;
  requestFingerprint: string;
  itemId: string;
  healAmount: number;
  healedAmount: number;
  healthAfter: number | null;
  completionReason?: FoodConsumptionCompletionReason;
  publicActionObservation?: StreamingDuelFoodObservationContext;
};

type StoredDuelDamageOperation = {
  version: 2;
  requestFingerprint: string;
  attackerId: string;
  attackStyle: string;
  requestedDamage: number;
  appliedDamage: number;
  healthBefore: number;
  healthAfter: number;
  publicActionObservation: StreamingDuelDamageObservationContext;
  competitiveAuthority?: DuelDamageCompetitiveAuthority;
  projectileCost?: DuelDamageProjectileCostAuthority;
  competitiveTerminal: DuelDamageCompetitiveTerminal | null;
  xpDamageAuthority: number | null;
  combatProgress: Array<
    Pick<
      MobCombatProgressReceipt,
      "skill" | "xpAmount" | "awardedXp" | "operationCommittedXp"
    >
  >;
};

type StoredQuestCompletionOperation = {
  version: 1;
  requestFingerprint: string;
  questId: string;
  questStartedAt: number;
  expectedStage: string;
  expectedProgress: Record<string, number>;
  completedAt: number;
  questPoints: number;
  operationCommittedQuestPoints: number;
  items: QuestCompletionRewardItem[];
  xp: QuestCompletionRewardXp[];
  progress: Array<
    Pick<
      QuestCompletionProgressReceipt,
      "skill" | "xpAmount" | "awardedXp" | "operationCommittedXp"
    >
  >;
};

type StoredQuestStartOperation = {
  version: 1;
  requestFingerprint: string;
  questId: string;
  questStartedAt: number;
  initialStage: string;
  items: QuestStartRewardItem[];
};

type StoredGatheringRewardOperation = {
  version: 2;
  requestFingerprint: string;
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
};

type StoredProcessingActionOperation = {
  version: 1;
  requestFingerprint: string;
  skill: ProcessingActionSkill;
  xpAmount: number;
  inputs: InventoryDebitRequirement[];
  requiredItems?: InventoryDebitRequirement[];
  consumables?: ProcessingActionConsumable[];
  consumableStates?: ProcessingActionConsumableState[];
  outputs: ProcessingActionItem[];
  coinCost?: number;
  worldEffect?: ProcessingActionFireEffect;
  awardedXp: number;
  operationCommittedXp: number;
};

type StoredPendingProcessingRequest = {
  version: 1;
  requestId: string;
  skill: ProcessingSkill;
  ownerId: string;
  acceptedAt: number;
  heartbeatAt: number;
  envelope?: ProcessingRequestEnvelope;
};

type StoredRejectedProcessingRequest = StoredPendingProcessingRequest & {
  reason: string;
  retryable: boolean;
  rejectedAt: number;
};

type StoredProcessingWaiter = {
  version: 1;
  requestId: string;
  skill: ProcessingSkill;
  envelope: ProcessingRequestEnvelope;
  ownerId: string;
  acceptedAt: number;
  heartbeatAt: number;
  status: "pending" | "committed" | "rejected";
  terminalAt: number | null;
  acknowledgedAt: number | null;
};

type StoredProcessingConsumableUses = Record<
  string,
  { usesPerItem: number; remainingUses: number }
>;

type StoredEquipmentStackDebitOperation = {
  version: 1;
  requestFingerprint: string;
  slotType: string;
  itemId: string;
  quantity: number;
  committed: CommittedEquipmentItem[];
};

type StoredAmmunitionShotOperation = {
  version: 2;
  requestFingerprint: string;
  itemId: string;
  quantity: 1;
  recoveryDisposition: "recovered" | "destroyed";
  committed: CommittedEquipmentItem[];
  committedInventory: CommittedInventoryItem[];
  source: GroundItemSourceRegistrationRequest | null;
  sourceId: string | null;
  status: "pending" | "fired" | "resolved" | "cancelled";
  damageOperationId?: string | null;
  refundDestination: AmmunitionShotRefundDestination | null;
};

type LegacyStoredAmmunitionShotOperation = {
  version: 1;
  requestFingerprint: string;
  itemId: string;
  quantity: 1;
  recoveryDisposition: "recovered" | "destroyed";
  committed: CommittedEquipmentItem[];
  source: GroundItemSourceRegistrationRequest | null;
  sourceId: string | null;
};

type StoredAttackStyleOperation = {
  version: 1;
  requestFingerprint: string;
  requestedStyle: string;
  publicActionObservation?: StreamingDuelStyleObservationContext;
};

type StoredStreamingDuelExecutorCommand = {
  version: 1;
  requestFingerprint: string;
  publicActionObservation: StreamingDuelExecutorObservationContext;
  command: StreamingDuelExecutorCommand;
  outcome: StreamingDuelExecutorCommandOutcome | null;
};

type DeathCustodyItem = {
  itemId: string;
  quantity: number;
};

type StoredSafeDeathCaptureOperation = {
  version: 1;
  requestFingerprint: string;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killedBy: string;
  dropped: DeathCustodyItem[];
  kept: DeathCustodyItem[];
};

type StoredSafeDeathKeptReturnOperation = {
  version: 1;
  deathOperationId: string;
  returned: DeathCustodyItem[];
};

type StoredSafeDeathGravestoneLootOperation = {
  version: 1;
  deathOperationId: string;
  gravestoneId: string;
  requested: DeathCustodyItem[] | null;
  transferred: DeathCustodyItem[];
  remaining: DeathCustodyItem[];
};

export type SafeDeathCaptureCommitRequest = {
  operationId: string;
  playerId: string;
  deathTimestamp: number;
  position: { x: number; y: number; z: number };
  killedBy: string;
};

export type SafeDeathCaptureCommitReceipt = {
  operationId: string;
  playerId: string;
  requestFingerprint: string;
  replayed: boolean;
  deathTimestamp: number;
  dropped: DeathCustodyItem[];
  kept: DeathCustodyItem[];
};

export type SafeDeathKeptReturnReceipt = {
  operationId: string;
  playerId: string;
  deathOperationId: string;
  replayed: boolean;
  returned: DeathCustodyItem[];
  committed: CommittedInventoryItem[];
};

export type SafeDeathGravestoneLootCommitRequest = {
  operationId: string;
  playerId: string;
  deathOperationId: string;
  gravestoneId: string;
  items?: DeathCustodyItem[];
};

export type SafeDeathGravestoneLootCommitReceipt = {
  operationId: string;
  playerId: string;
  deathOperationId: string;
  gravestoneId: string;
  replayed: boolean;
  transferred: DeathCustodyItem[];
  remaining: DeathCustodyItem[];
  committed: CommittedInventoryItem[];
};

type CommittedEquipmentItem = {
  slotType: string;
  itemId: string;
  quantity: number;
};

type CommittedInventoryItem = {
  itemId: string;
  quantity: number;
  slotIndex: number;
  metadata: Record<string, string | number | boolean> | null;
};

type InventorySnapshotInput = Array<{
  itemId: string;
  quantity: number;
  slotIndex: number | null;
  metadata: Record<string, unknown> | null;
}>;

const MAX_PERSISTED_ITEM_QUANTITY = 2_147_483_647;
const MAX_SKILL_XP = 200_000_000;
const MAX_QUEST_REWARD_XP = 1_000_000;
const MAX_QUEST_POINTS = 1_000_000;
const MAX_GATHERING_REWARD_XP = 1_000_000;
const MAX_PROCESSING_ACTION_XP = 1_000_000;
const MOB_COMBAT_KILL_STYLES = new Set([
  "accurate",
  "aggressive",
  "defensive",
  "controlled",
  "ranged",
  "rapid",
  "longrange",
  "magic",
  "autocast",
]);
const MAX_PROCESSING_CONSUMABLE_USES = 1_000_000;
const MAX_ACTIVE_PROCESSING_FIRES_PER_PLAYER =
  PROCESSING_CONSTANTS.FIRE.maxFiresPerPlayer;
const MAX_INVENTORY_SLOTS = 28;
const BONE_BURIAL_OPERATION_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|bone-burial:[A-Za-z0-9_-]{20})$/;
const FOOD_CONSUMPTION_OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;
const GROUND_ITEM_SOURCE_ID_PATTERN =
  /^ground_item_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GROUND_ITEM_SOURCE_CONTRIBUTION_ID_PATTERN =
  /^ground-item-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GROUND_ITEM_SOURCE_STATUSES = new Set<GroundItemSourceStatus>([
  "active",
  "claimed",
  "expired",
]);
const GATHERING_REWARD_SKILLS = new Set<GatheringRewardSkill>([
  "woodcutting",
  "mining",
  "fishing",
]);
const QUEST_REWARD_SKILLS = new Set<QuestRewardSkill>([
  "attack",
  "strength",
  "defense",
  "constitution",
  "ranged",
  "magic",
  "prayer",
  "woodcutting",
  "mining",
  "fishing",
  "firemaking",
  "cooking",
  "smithing",
  "agility",
  "crafting",
  "fletching",
  "runecrafting",
]);
const PROCESSING_ACTION_SKILLS = new Set<ProcessingActionSkill>([
  "firemaking",
  "cooking",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
]);
const PROCESSING_REQUEST_SKILLS = new Set<ProcessingSkill>([
  "firemaking",
  "cooking",
  "smelting",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
  "tanning",
]);

function normalizeDeathOperationId(value: unknown): string {
  const operationId = String(value ?? "").trim();
  if (!operationId || operationId.length > 256) {
    throw new Error("safe_death_operation_id_invalid");
  }
  return operationId;
}

function normalizeDeathPlayerId(value: unknown): string {
  const playerId = String(value ?? "").trim();
  if (!playerId || playerId.length > 256) {
    throw new Error("safe_death_player_id_invalid");
  }
  return playerId;
}

function normalizeDeathCustodyItems(
  value: unknown,
  errorPrefix = "safe_death",
): DeathCustodyItem[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${errorPrefix}_items_invalid`);
  }
  const totals = new Map<string, number>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`${errorPrefix}_items_invalid`);
    }
    const itemId = String((raw as { itemId?: unknown }).itemId ?? "").trim();
    const quantity = Number((raw as { quantity?: unknown }).quantity);
    if (
      !itemId ||
      itemId.length > 256 ||
      !getItem(itemId) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error(`${errorPrefix}_items_invalid`);
    }
    const combined = (totals.get(itemId) ?? 0) + quantity;
    if (
      !Number.isSafeInteger(combined) ||
      combined > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error(`${errorPrefix}_items_invalid`);
    }
    totals.set(itemId, combined);
  }
  return [...totals.entries()]
    .map(([itemId, quantity]) => ({ itemId, quantity }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function splitSafeDeathCustody(
  value: DeathCustodyItem[],
  keepCount: number,
): { dropped: DeathCustodyItem[]; kept: DeathCustodyItem[] } {
  const ranked = value
    .map((item, index) => ({
      item,
      index,
      value: Number(getItem(item.itemId)?.value ?? 0),
    }))
    .sort(
      (left, right) => right.value - left.value || left.index - right.index,
    );
  const keptByItem = new Map<string, number>();
  let remaining = keepCount;
  for (const entry of ranked) {
    if (remaining <= 0) break;
    const quantity = Math.min(entry.item.quantity, remaining);
    keptByItem.set(entry.item.itemId, quantity);
    remaining -= quantity;
  }
  const kept: DeathCustodyItem[] = [];
  const dropped: DeathCustodyItem[] = [];
  for (const item of value) {
    const keptQuantity = keptByItem.get(item.itemId) ?? 0;
    if (keptQuantity > 0) {
      kept.push({ itemId: item.itemId, quantity: keptQuantity });
    }
    if (item.quantity > keptQuantity) {
      dropped.push({
        itemId: item.itemId,
        quantity: item.quantity - keptQuantity,
      });
    }
  }
  return {
    dropped: normalizeDeathCustodyItems(dropped),
    kept: normalizeDeathCustodyItems(kept),
  };
}

function safeDeathCaptureFingerprint(
  playerId: string,
  deathTimestamp: number,
  position: { x: number; y: number; z: number },
  killedBy: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        deathTimestamp,
        position,
        killedBy,
      }),
      "utf8",
    )
    .digest("hex");
}

function deathKeptReturnOperationId(deathOperationId: string): string {
  return `death-kept:${createHash("sha256").update(deathOperationId).digest("hex")}`;
}

function creditDeathCustodyItem(
  inventory: CommittedInventoryItem[],
  item: DeathCustodyItem,
): CommittedInventoryItem[] {
  const definition = getItem(item.itemId);
  if (!definition) throw new Error("safe_death_item_unknown");
  return creditGatheringReward(
    inventory,
    {
      itemId: item.itemId,
      quantity: item.quantity,
      stackable: definition.stackable === true,
    },
    "safe_death",
  );
}

function processingWaiterOperationId(playerId: string): string {
  return `processing-waiter:${playerId}`;
}

function normalizeStoredProcessingWaiter(
  value: unknown,
): StoredProcessingWaiter | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<StoredProcessingWaiter>;
  const requestId = normalizeProcessingRequestId(state.requestId);
  const skill = state.skill as ProcessingSkill;
  const envelope = PROCESSING_REQUEST_SKILLS.has(skill)
    ? normalizeProcessingRequestEnvelope(skill, state.envelope)
    : null;
  const acceptedAt = Number(state.acceptedAt);
  const heartbeatAt = Number(state.heartbeatAt);
  const terminalAt =
    state.terminalAt === null ? null : Number(state.terminalAt);
  const acknowledgedAt =
    state.acknowledgedAt === null ? null : Number(state.acknowledgedAt);
  if (
    state.version !== 1 ||
    !requestId ||
    !envelope ||
    typeof state.ownerId !== "string" ||
    !state.ownerId ||
    !Number.isSafeInteger(acceptedAt) ||
    acceptedAt <= 0 ||
    !Number.isSafeInteger(heartbeatAt) ||
    heartbeatAt < acceptedAt ||
    (state.status !== "pending" &&
      state.status !== "committed" &&
      state.status !== "rejected") ||
    (state.status === "pending" && terminalAt !== null) ||
    (state.status !== "pending" &&
      (terminalAt === null ||
        !Number.isSafeInteger(terminalAt) ||
        terminalAt < acceptedAt)) ||
    (acknowledgedAt !== null &&
      (!Number.isSafeInteger(acknowledgedAt) ||
        terminalAt === null ||
        acknowledgedAt < terminalAt))
  ) {
    return null;
  }
  return {
    version: 1,
    requestId,
    skill,
    envelope,
    ownerId: state.ownerId,
    acceptedAt,
    heartbeatAt,
    status: state.status,
    terminalAt,
    acknowledgedAt,
  };
}
const ATTACK_STYLE_IDS = new Set([
  "accurate",
  "aggressive",
  "defensive",
  "controlled",
  "rapid",
  "longrange",
  "autocast",
]);
const WEAPON_TYPE_IDS = new Set<string>(Object.values(WeaponType));

function normalizeAttackStyle(value: unknown): string {
  const style = String(value ?? "").trim();
  if (!ATTACK_STYLE_IDS.has(style)) {
    throw new Error("attack_style_state_invalid");
  }
  return style;
}

function attackStyleFingerprint(
  playerId: string,
  requestedStyle: string,
  publicActionObservation?: StreamingDuelStyleObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        requestedStyle,
        ...(publicActionObservation ? { publicActionObservation } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

function resolvePersistedWeaponType(itemId: string | null): WeaponType {
  if (!itemId) return WeaponType.NONE;
  const raw = String(getItem(itemId)?.weaponType ?? "").toLowerCase();
  return WEAPON_TYPE_IDS.has(raw) ? (raw as WeaponType) : WeaponType.NONE;
}

function normalizeStreamingDuelExecutorCommand(
  context: StreamingDuelExecutorObservationContext,
  input: unknown,
): StreamingDuelExecutorCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("streaming_duel_executor_command_invalid");
  }
  const value = input as Record<string, unknown>;
  if (context.action === "movement") {
    const keys = Object.keys(value).sort();
    if (value.mode === "combat_approach") {
      if (
        keys.length !== 4 ||
        keys[0] !== "kind" ||
        keys[1] !== "mode" ||
        keys[2] !== "targetId" ||
        keys[3] !== "targetType" ||
        value.kind !== "movement" ||
        value.targetType !== "player" ||
        value.targetId !== context.opponentId
      ) {
        throw new Error("streaming_duel_executor_command_invalid");
      }
      return Object.freeze({
        kind: "movement",
        mode: "combat_approach",
        targetId: context.opponentId,
        targetType: "player",
      });
    }
    const target = value.target;
    if (
      keys.length !== 4 ||
      keys[0] !== "kind" ||
      keys[1] !== "mode" ||
      keys[2] !== "runMode" ||
      keys[3] !== "target" ||
      value.kind !== "movement" ||
      value.mode !== "ground" ||
      typeof value.runMode !== "boolean" ||
      !Array.isArray(target) ||
      target.length !== 3 ||
      !target.every(
        (coordinate) =>
          typeof coordinate === "number" &&
          Number.isFinite(coordinate) &&
          Math.abs(coordinate) <= 1_000_000,
      )
    ) {
      throw new Error("streaming_duel_executor_command_invalid");
    }
    return Object.freeze({
      kind: "movement",
      mode: "ground",
      target: Object.freeze([target[0], target[1], target[2]]) as readonly [
        number,
        number,
        number,
      ],
      runMode: value.runMode,
    });
  }

  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "kind" ||
    keys[1] !== "targetId" ||
    keys[2] !== "targetType" ||
    value.kind !== "engagement" ||
    value.targetType !== "player" ||
    value.targetId !== context.opponentId
  ) {
    throw new Error("streaming_duel_executor_command_invalid");
  }
  return Object.freeze({
    kind: "engagement",
    targetId: context.opponentId,
    targetType: "player",
  });
}

function streamingDuelExecutorCommandFingerprint(
  playerId: string,
  publicActionObservation: StreamingDuelExecutorObservationContext,
  command: StreamingDuelExecutorCommand,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        publicActionObservation,
        command,
      }),
      "utf8",
    )
    .digest("hex");
}

function isStreamingDuelExecutorCommandOutcome(
  value: unknown,
): value is StreamingDuelExecutorCommandOutcome {
  return value === "accepted" || value === "rejected" || value === "error";
}

function normalizeStreamingDuelExecutorCommandRequest(
  request: StreamingDuelExecutorCommandRequest,
): StreamingDuelExecutorCommandRequest {
  const operationId = String(request.operationId ?? "").trim();
  const playerId = String(request.playerId ?? "").trim();
  const requestFingerprint = String(request.requestFingerprint ?? "").trim();
  const publicActionObservation = parseStreamingDuelExecutorObservationContext(
    request.publicActionObservation,
  );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      operationId,
    ) ||
    !playerId ||
    playerId.length > 128 ||
    !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
    !publicActionObservation ||
    publicActionObservation.operationId !== operationId ||
    publicActionObservation.actorId !== playerId
  ) {
    throw new Error("streaming_duel_executor_command_invalid");
  }
  const command = normalizeStreamingDuelExecutorCommand(
    publicActionObservation,
    request.command,
  );
  if (
    requestFingerprint !==
    streamingDuelExecutorCommandFingerprint(
      playerId,
      publicActionObservation,
      command,
    )
  ) {
    throw new Error("streaming_duel_executor_command_invalid");
  }
  return {
    operationId,
    playerId,
    requestFingerprint,
    publicActionObservation,
    command,
  };
}

function normalizeEquipmentSnapshot(
  value: Array<{
    slotType: string;
    itemId: string;
    quantity: number;
  }>,
  errorPrefix: string,
): CommittedEquipmentItem[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${errorPrefix}_equipment_invalid`);
  }

  const equipmentSlots = new Set<string>();
  const equipment = value.map((raw) => {
    const slotType = String(raw?.slotType ?? "").trim();
    const itemId = String(raw?.itemId ?? "").trim();
    const quantity = Number(raw?.quantity);
    if (
      !slotType ||
      slotType.length > 64 ||
      equipmentSlots.has(slotType) ||
      !itemId ||
      itemId.length > 256 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error(`${errorPrefix}_equipment_invalid`);
    }
    equipmentSlots.add(slotType);
    return { slotType, itemId, quantity };
  });
  equipment.sort((left, right) => left.slotType.localeCompare(right.slotType));
  return equipment;
}

function equipmentStackDebitFingerprint(
  playerId: string,
  slotType: string,
  itemId: string,
  quantity: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ version: 1, playerId, slotType, itemId, quantity }),
      "utf8",
    )
    .digest("hex");
}

function ammunitionShotFingerprint(
  request: Omit<AmmunitionShotCommitRequest, "requestFingerprint">,
): string {
  return createHash("sha256")
    .update(
      serializeAmmunitionShotFingerprint(
        ammunitionShotIdentityFromRequest(request),
      ),
      "utf8",
    )
    .digest("hex");
}

function debitEquipmentStackSnapshot(
  equipment: CommittedEquipmentItem[],
  slotType: string,
  itemId: string,
  quantity: number,
): CommittedEquipmentItem[] {
  const equipped = equipment.find((item) => item.slotType === slotType);
  if (!equipped || equipped.itemId !== itemId || equipped.quantity < quantity) {
    throw new Error("equipment_stack_debit_insufficient_items");
  }

  return equipment.flatMap((item) => {
    if (item.slotType !== slotType) return [item];
    const remaining = item.quantity - quantity;
    return remaining > 0 ? [{ ...item, quantity: remaining }] : [];
  });
}

function normalizeInventorySnapshot(
  value: InventorySnapshotInput,
  errorPrefix: string,
): CommittedInventoryItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`${errorPrefix}_inventory_invalid`);
  }

  const inventorySlots = new Set<number>();
  const inventory = value.map((raw) => {
    const slotIndex = Number(raw?.slotIndex);
    const quantity = Number(raw?.quantity);
    const itemId = String(raw?.itemId ?? "").trim();
    if (
      !Number.isSafeInteger(slotIndex) ||
      slotIndex < 0 ||
      slotIndex >= 28 ||
      inventorySlots.has(slotIndex) ||
      !itemId ||
      itemId.length > 256 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error(`${errorPrefix}_inventory_invalid`);
    }
    inventorySlots.add(slotIndex);

    let metadata: Record<string, string | number | boolean> | null = null;
    if (raw.metadata != null) {
      if (typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
        throw new Error(`${errorPrefix}_inventory_metadata_invalid`);
      }
      metadata = {};
      for (const key of Object.keys(raw.metadata).sort()) {
        const metadataValue = raw.metadata[key];
        if (
          typeof metadataValue !== "string" &&
          typeof metadataValue !== "boolean" &&
          (typeof metadataValue !== "number" || !Number.isFinite(metadataValue))
        ) {
          throw new Error(`${errorPrefix}_inventory_metadata_invalid`);
        }
        metadata[key] = metadataValue;
      }
    }

    return { itemId, quantity, slotIndex, metadata };
  });
  inventory.sort((a, b) => a.slotIndex - b.slotIndex);
  return inventory;
}

function normalizePersistedInventoryRows(
  rows: Array<{
    itemId: string;
    quantity: number | null;
    slotIndex: number | null;
    metadata: string | null;
  }>,
  errorPrefix: string,
): CommittedInventoryItem[] {
  return normalizeInventorySnapshot(
    rows.map((row) => {
      let metadata: Record<string, string | number | boolean> | null = null;
      if (row.metadata) {
        try {
          const parsed = JSON.parse(row.metadata) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("metadata is not an object");
          }
          metadata = parsed as Record<string, string | number | boolean>;
        } catch {
          throw new Error(`${errorPrefix}_inventory_metadata_invalid`);
        }
      }
      return {
        itemId: row.itemId,
        quantity: row.quantity ?? 1,
        slotIndex: row.slotIndex ?? -1,
        metadata,
      };
    }),
    errorPrefix,
  );
}

function normalizeInventoryDebitRequirements(
  value: InventoryDebitRequirement[],
): InventoryDebitRequirement[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 28) {
    throw new Error("inventory_debit_requirements_invalid");
  }

  const totals = new Map<string, number>();
  for (const raw of value) {
    const itemId = String(raw?.itemId ?? "").trim();
    const quantity = Number(raw?.quantity);
    if (
      !itemId ||
      itemId.length > 256 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("inventory_debit_requirements_invalid");
    }
    const combined = (totals.get(itemId) ?? 0) + quantity;
    if (
      !Number.isSafeInteger(combined) ||
      combined > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("inventory_debit_requirements_invalid");
    }
    totals.set(itemId, combined);
  }

  return [...totals.entries()]
    .map(([itemId, quantity]) => ({ itemId, quantity }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function inventoryDebitFingerprint(
  playerId: string,
  requirements: InventoryDebitRequirement[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, playerId, requirements }), "utf8")
    .digest("hex");
}

function groundItemSourceRegistrationFingerprint(
  request: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint">,
): string {
  return createHash("sha256")
    .update(serializeGroundItemSourceRegistrationFingerprint(request), "utf8")
    .digest("hex");
}

function groundItemDropFingerprint(
  request: Omit<GroundItemDropCommitRequest, "requestFingerprint">,
): string {
  return createHash("sha256")
    .update(serializeGroundItemDropCommitFingerprint(request), "utf8")
    .digest("hex");
}

function groundItemDeathFingerprint(
  request: Omit<GroundItemDeathCommitRequest, "requestFingerprint">,
): string {
  return createHash("sha256")
    .update(serializeGroundItemDeathCommitFingerprint(request), "utf8")
    .digest("hex");
}

function groundItemMobLootFingerprint(
  request: Omit<
    GroundItemMobLootCommitRequest,
    "requestFingerprint" | "sources"
  >,
): string {
  return createHash("sha256")
    .update(serializeGroundItemMobLootCommitFingerprint(request), "utf8")
    .digest("hex");
}

function processingFireExtinguishFingerprint(
  request: Omit<
    ProcessingFireExtinguishCommitRequest,
    "requestFingerprint" | "source"
  >,
): string {
  return createHash("sha256")
    .update(serializeProcessingFireExtinguishFingerprint(request), "utf8")
    .digest("hex");
}

function databaseQueryRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function parseGroundItemSourceDatabaseRow(
  row: GroundItemSourceDatabaseRow | undefined,
): GroundItemSourceState {
  const status = String(row?.status ?? "") as GroundItemSourceStatus;
  const sourceId = String(row?.source_id ?? "");
  const itemId = String(row?.item_id ?? "");
  const quantity = Number(row?.quantity);
  const position = {
    x: Number(row?.position_x),
    y: Number(row?.position_y),
    z: Number(row?.position_z),
  };
  const tile = { x: Number(row?.tile_x), z: Number(row?.tile_z) };
  const createdAt = Number(row?.created_at);
  const updatedAt = Number(row?.updated_at);
  const expiresAt = Number(row?.expires_at);
  const lootProtectionExpiresAt =
    row?.loot_protection_expires_at === null ||
    row?.loot_protection_expires_at === undefined
      ? null
      : Number(row.loot_protection_expires_at);
  const version = Number(row?.version);
  const expectedTile =
    Number.isFinite(position.x) && Number.isFinite(position.z)
      ? worldToTile(position.x, position.z)
      : null;
  if (
    !GROUND_ITEM_SOURCE_ID_PATTERN.test(sourceId) ||
    !GROUND_ITEM_SOURCE_STATUSES.has(status) ||
    !getItem(itemId) ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_PERSISTED_ITEM_QUANTITY ||
    typeof row?.stackable !== "boolean" ||
    row.stackable !== (getItem(itemId)?.stackable === true) ||
    !Object.values(position).every(Number.isFinite) ||
    !Number.isSafeInteger(tile.x) ||
    !Number.isSafeInteger(tile.z) ||
    expectedTile?.x !== tile.x ||
    expectedTile?.z !== tile.z ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < createdAt ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= createdAt ||
    (lootProtectionExpiresAt !== null &&
      (!Number.isSafeInteger(lootProtectionExpiresAt) ||
        lootProtectionExpiresAt < createdAt ||
        lootProtectionExpiresAt > expiresAt)) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    (row.dropped_by !== null &&
      (typeof row.dropped_by !== "string" ||
        row.dropped_by.length < 1 ||
        row.dropped_by.length > 128))
  ) {
    throw new Error("ground_item_source_state_invalid");
  }
  return {
    sourceId,
    status,
    itemId,
    quantity,
    stackable: row.stackable,
    position,
    tile,
    droppedBy: row.dropped_by,
    createdAt,
    updatedAt,
    expiresAt,
    lootProtectionExpiresAt,
    version,
  };
}

function groundItemPickupFingerprint(
  playerId: string,
  sourceEntityId: string,
  itemId: string,
  quantity: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        sourceEntityId,
        itemId,
        quantity,
      }),
      "utf8",
    )
    .digest("hex");
}

function foodConsumptionFingerprint(
  playerId: string,
  itemId: string,
  healAmount: number,
  publicActionObservation?: StreamingDuelFoodObservationContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        itemId,
        healAmount,
        ...(publicActionObservation ? { publicActionObservation } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

function duelDamageFingerprint(
  attackerId: string,
  targetPlayerId: string,
  requestedDamage: number,
  attackStyle: string,
  publicActionObservation: StreamingDuelDamageObservationContext,
  competitiveAuthority?: DuelDamageCompetitiveAuthority,
  projectileCost?: DuelDamageProjectileCostAuthority,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        attackerId,
        targetPlayerId,
        requestedDamage,
        attackStyle,
        publicActionObservation,
        ...(competitiveAuthority ? { competitiveAuthority } : {}),
        ...(projectileCost ? { projectileCost } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

function isDuelCombatRoleAttackStyle(
  combatRole: StreamingDuelDamageObservationContext["combatRole"],
  attackStyle: string,
): boolean {
  if (combatRole === "melee") {
    return ["accurate", "aggressive", "defensive", "controlled"].includes(
      attackStyle,
    );
  }
  if (combatRole === "ranged") {
    return ["ranged", "rapid", "longrange"].includes(attackStyle);
  }
  return combatRole === "mage" && ["magic", "autocast"].includes(attackStyle);
}

function normalizeDuelDamageCompetitiveAuthority(
  input: DuelDamageCompetitiveAuthority | undefined,
): DuelDamageCompetitiveAuthority | undefined {
  if (input === undefined) return undefined;
  const preparationId = String(input.preparationId ?? "").trim();
  const fencingToken = String(input.fencingToken ?? "").trim();
  const snapshotDigest = String(input.snapshotDigest ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      preparationId,
    ) ||
    !/^[1-9][0-9]*$/.test(fencingToken) ||
    !/^[0-9a-f]{64}$/.test(snapshotDigest)
  ) {
    throw new Error("duel_damage_competitive_authority_invalid");
  }
  try {
    if (BigInt(fencingToken) > 9_223_372_036_854_775_807n) {
      throw new Error("duel_damage_competitive_authority_invalid");
    }
  } catch {
    throw new Error("duel_damage_competitive_authority_invalid");
  }
  return { preparationId, fencingToken, snapshotDigest };
}

function isExactDuelDamageProjectileCostAuthority(
  stored: unknown,
  expected: DuelDamageProjectileCostAuthority | undefined,
): boolean {
  if (expected === undefined) return stored === undefined;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return false;
  }
  const record = stored as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record.operationType === expected.operationType &&
    record.operationId === expected.operationId &&
    record.playerId === expected.playerId &&
    record.requestFingerprint === expected.requestFingerprint
  );
}

function isExactDuelDamageCompetitiveTerminal(
  input: unknown,
  attackerId: string,
  targetPlayerId: string,
  observedAt: number,
): input is DuelDamageCompetitiveTerminal {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const terminal = input as Record<string, unknown>;
  if (
    terminal.outcome !== "win" ||
    terminal.winnerId !== attackerId ||
    terminal.loserId !== targetPlayerId ||
    terminal.winReason !== "kill" ||
    terminal.terminalAt !== observedAt ||
    typeof terminal.seed !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(terminal.seed) ||
    typeof terminal.replayHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(terminal.replayHash)
  ) {
    return false;
  }
  try {
    return BigInt(terminal.seed) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function streamingDuelActionObservationFingerprint(
  observation: StreamingDuelActionObservation,
): string {
  return JSON.stringify([
    observation.tick,
    observation.observedAt,
    observation.cycleId,
    observation.duelId,
    observation.actorId,
    observation.opponentId,
    observation.phase,
    observation.combatRole,
    observation.tacticalMacro,
    observation.action,
    observation.outcome,
    observation.value,
    observation.amount,
  ]);
}

type UnsequencedStreamingDuelActionObservation =
  StreamingDuelActionObservation extends infer Observation
    ? Observation extends StreamingDuelActionObservation
      ? Omit<Observation, "schemaVersion" | "sequence">
      : never
    : never;

async function commitStreamingDuelActionObservation(
  tx: NodePgDatabase<typeof schema>,
  operationId: string,
  observationDraft: UnsequencedStreamingDuelActionObservation,
  requireExisting: boolean,
): Promise<StreamingDuelActionObservation> {
  const existingRows = await tx
    .select({ observation: schema.streamingDuelActionObservations.observation })
    .from(schema.streamingDuelActionObservations)
    .where(eq(schema.streamingDuelActionObservations.operationId, operationId));
  const existing = existingRows[0]?.observation
    ? parseStreamingDuelActionObservation(existingRows[0].observation)
    : null;
  if (existing) {
    const expected = parseStreamingDuelActionObservation({
      ...observationDraft,
      schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
      sequence: existing.sequence,
    });
    if (
      !expected ||
      streamingDuelActionObservationFingerprint(existing) !==
        streamingDuelActionObservationFingerprint(expected)
    ) {
      throw new Error("streaming_duel_public_observation_conflict");
    }
    return existing;
  }
  if (existingRows.length > 0 || requireExisting) {
    throw new Error("streaming_duel_public_observation_conflict");
  }

  // A row update, unlike an advisory-lock SELECT, participates in MVCC. Two
  // contestants appending concurrently therefore either receive distinct
  // sequences or one SERIALIZABLE transaction is retried from a fresh
  // snapshot. The counter and immutable observation share the same commit.
  const sequenceRows = await tx
    .insert(schema.streamingDuelActionObservationHeads)
    .values({ cycleId: observationDraft.cycleId, lastSequence: 1 })
    .onConflictDoUpdate({
      target: schema.streamingDuelActionObservationHeads.cycleId,
      set: {
        lastSequence: sql`${schema.streamingDuelActionObservationHeads.lastSequence} + 1`,
      },
    })
    .returning({
      nextSequence: schema.streamingDuelActionObservationHeads.lastSequence,
    });
  const sequence = Number(sequenceRows[0]?.nextSequence);
  const observation = parseStreamingDuelActionObservation({
    ...observationDraft,
    schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
    sequence,
  });
  if (!observation) {
    throw new Error("streaming_duel_public_observation_invalid");
  }

  await tx.insert(schema.streamingDuelActionObservations).values({
    operationId,
    cycleId: observation.cycleId,
    duelId: observation.duelId,
    sequence: observation.sequence,
    observedAt: observation.observedAt,
    actorId: observation.actorId,
    opponentId: observation.opponentId,
    action: observation.action,
    observation,
  });
  return observation;
}

async function commitFoodPublicActionObservation(
  tx: NodePgDatabase<typeof schema>,
  context: StreamingDuelFoodObservationContext,
  healedAmount: number,
  requireExisting: boolean,
): Promise<StreamingDuelActionObservation> {
  const { operationId, ...publicContext } = context;
  return commitStreamingDuelActionObservation(
    tx,
    operationId,
    {
      ...publicContext,
      action: "food",
      outcome: "committed",
      value: "consume",
      amount: healedAmount,
    },
    requireExisting,
  );
}

async function commitDamagePublicActionObservation(
  tx: NodePgDatabase<typeof schema>,
  context: StreamingDuelDamageObservationContext,
  appliedDamage: number,
  requireExisting: boolean,
): Promise<StreamingDuelActionObservation> {
  const {
    operationId,
    requestedDamage: _requestedDamage,
    ...publicContext
  } = context;
  return commitStreamingDuelActionObservation(
    tx,
    operationId,
    {
      ...publicContext,
      action: "damage",
      outcome: "committed",
      value: "hit",
      amount: appliedDamage,
    },
    requireExisting,
  );
}

async function commitPrayerPublicActionObservation(
  tx: NodePgDatabase<typeof schema>,
  context: StreamingDuelPrayerObservationContext,
  requireExisting: boolean,
): Promise<StreamingDuelActionObservation> {
  const { operationId, prayer, ...publicContext } = context;
  return commitStreamingDuelActionObservation(
    tx,
    operationId,
    {
      ...publicContext,
      action: "prayer",
      outcome: "committed",
      value: prayer,
      amount: null,
    },
    requireExisting,
  );
}

async function commitRoleSwitchPublicActionObservation(
  tx: NodePgDatabase<typeof schema>,
  context: StreamingDuelRoleSwitchObservationContext,
  requireExisting: boolean,
): Promise<StreamingDuelActionObservation> {
  const { operationId, targetRole, ...publicContext } = context;
  return commitStreamingDuelActionObservation(
    tx,
    operationId,
    {
      ...publicContext,
      action: "role_switch",
      outcome: "committed",
      value: targetRole,
      amount: null,
    },
    requireExisting,
  );
}

async function commitStylePublicActionObservation(
  tx: NodePgDatabase<typeof schema>,
  context: StreamingDuelStyleObservationContext,
  requireExisting: boolean,
): Promise<StreamingDuelActionObservation> {
  const { operationId, style, ...publicContext } = context;
  return commitStreamingDuelActionObservation(
    tx,
    operationId,
    {
      ...publicContext,
      action: "style",
      outcome: "accepted",
      value: style,
      amount: null,
    },
    requireExisting,
  );
}

async function commitExecutorPublicActionObservation(
  tx: NodePgDatabase<typeof schema>,
  context: StreamingDuelExecutorObservationContext,
  outcome: StreamingDuelExecutorCommandOutcome,
  requireExisting: boolean,
): Promise<StreamingDuelActionObservation> {
  const { operationId, ...publicContext } = context;
  return commitStreamingDuelActionObservation(
    tx,
    operationId,
    {
      ...publicContext,
      outcome,
      amount: null,
    } as UnsequencedStreamingDuelActionObservation,
    requireExisting,
  );
}

function isFoodConsumptionCompletionReason(
  value: unknown,
): value is FoodConsumptionCompletionReason {
  return value === "player_not_alive" || value === "full_health";
}

function boneBurialFingerprint(
  playerId: string,
  itemId: string,
  xpAmount: number,
  levelRequired: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        itemId,
        xpAmount,
        levelRequired,
      }),
      "utf8",
    )
    .digest("hex");
}

function normalizeQuestCompletionProgress(
  value: Record<string, number>,
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("quest_completion_progress_invalid");
  }
  const keys = Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  );
  if (keys.length > 64) {
    throw new Error("quest_completion_progress_invalid");
  }
  const normalized: Record<string, number> = {};
  for (const rawKey of keys) {
    const key = String(rawKey ?? "").trim();
    const quantity = Number(value[rawKey]);
    if (
      !key ||
      key !== rawKey ||
      key.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(key) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("quest_completion_progress_invalid");
    }
    normalized[key] = quantity;
  }
  return normalized;
}

function normalizeQuestStartItems(
  value: QuestStartRewardItem[],
): QuestStartRewardItem[] {
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_SLOTS) {
    throw new Error("quest_start_items_invalid");
  }
  const totals = new Map<string, number>();
  for (const raw of value) {
    const itemId = String(raw?.itemId ?? "").trim();
    const quantity = Number(raw?.quantity);
    const item = getItem(itemId);
    const stackable = item?.stackable === true;
    if (
      !itemId ||
      itemId.length > 256 ||
      !item ||
      raw?.stackable !== stackable ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("quest_start_items_invalid");
    }
    const combined = (totals.get(itemId) ?? 0) + quantity;
    if (
      !Number.isSafeInteger(combined) ||
      combined > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("quest_start_items_invalid");
    }
    totals.set(itemId, combined);
  }
  return [...totals.entries()]
    .map(([itemId, quantity]) => ({
      itemId,
      quantity,
      stackable: getItem(itemId)?.stackable === true,
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function questStartOperationId(
  playerId: string,
  questId: string,
  questStartedAt: number,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({ version: 1, playerId, questId, questStartedAt }),
      "utf8",
    )
    .digest("hex");
  return `quest-start:${digest}`;
}

function questStartFingerprint(
  playerId: string,
  questId: string,
  questStartedAt: number,
  initialStage: string,
  items: QuestStartRewardItem[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        questId,
        questStartedAt,
        initialStage,
        items,
      }),
      "utf8",
    )
    .digest("hex");
}

function normalizeQuestCompletionItems(
  value: QuestCompletionRewardItem[],
): QuestCompletionRewardItem[] {
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_SLOTS) {
    throw new Error("quest_completion_items_invalid");
  }
  const totals = new Map<string, number>();
  for (const raw of value) {
    const itemId = String(raw?.itemId ?? "").trim();
    const quantity = Number(raw?.quantity);
    const item = getItem(itemId);
    const stackable = item?.stackable === true;
    if (
      !itemId ||
      itemId.length > 256 ||
      !item ||
      raw?.stackable !== stackable ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("quest_completion_items_invalid");
    }
    const combined = (totals.get(itemId) ?? 0) + quantity;
    if (
      !Number.isSafeInteger(combined) ||
      combined > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("quest_completion_items_invalid");
    }
    totals.set(itemId, combined);
  }
  return [...totals.entries()]
    .map(([itemId, quantity]) => ({
      itemId,
      quantity,
      stackable: getItem(itemId)?.stackable === true,
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function normalizeQuestCompletionXp(
  value: QuestCompletionRewardXp[],
): QuestCompletionRewardXp[] {
  if (!Array.isArray(value) || value.length > QUEST_REWARD_SKILLS.size) {
    throw new Error("quest_completion_xp_invalid");
  }
  const skills = new Set<QuestRewardSkill>();
  const normalized: QuestCompletionRewardXp[] = [];
  for (const raw of value) {
    const skill = String(raw?.skill ?? "").trim() as QuestRewardSkill;
    const xpAmount = Number(raw?.xpAmount);
    if (
      !QUEST_REWARD_SKILLS.has(skill) ||
      skills.has(skill) ||
      !Number.isSafeInteger(xpAmount) ||
      xpAmount <= 0 ||
      xpAmount > MAX_QUEST_REWARD_XP
    ) {
      throw new Error("quest_completion_xp_invalid");
    }
    skills.add(skill);
    normalized.push({ skill, xpAmount });
  }
  normalized.sort((left, right) => left.skill.localeCompare(right.skill));
  return normalized;
}

function questCompletionOperationId(
  playerId: string,
  questId: string,
  questStartedAt: number,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({ version: 1, playerId, questId, questStartedAt }),
      "utf8",
    )
    .digest("hex");
  return `quest-completion:${digest}`;
}

function questCompletionFingerprint(
  playerId: string,
  questId: string,
  questStartedAt: number,
  expectedStage: string,
  expectedProgress: Record<string, number>,
  questPoints: number,
  items: QuestCompletionRewardItem[],
  xp: QuestCompletionRewardXp[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        questId,
        questStartedAt,
        expectedStage,
        expectedProgress,
        questPoints,
        items,
        xp,
      }),
      "utf8",
    )
    .digest("hex");
}

function debitInventorySnapshot(
  inventory: CommittedInventoryItem[],
  requirements: InventoryDebitRequirement[],
): CommittedInventoryItem[] {
  const available = new Map<string, number>();
  for (const item of inventory) {
    available.set(
      item.itemId,
      (available.get(item.itemId) ?? 0) + item.quantity,
    );
  }
  for (const requirement of requirements) {
    if ((available.get(requirement.itemId) ?? 0) < requirement.quantity) {
      throw new Error("inventory_debit_insufficient_items");
    }
  }

  const remaining = new Map(
    requirements.map((requirement) => [
      requirement.itemId,
      requirement.quantity,
    ]),
  );
  const committed: CommittedInventoryItem[] = [];
  for (const item of inventory) {
    const quantityToDebit = remaining.get(item.itemId) ?? 0;
    if (quantityToDebit <= 0) {
      committed.push(item);
      continue;
    }
    const removed = Math.min(item.quantity, quantityToDebit);
    const quantity = item.quantity - removed;
    remaining.set(item.itemId, quantityToDebit - removed);
    if (quantity > 0) committed.push({ ...item, quantity });
  }
  return committed;
}

function debitGroundItemDropSnapshot(
  inventory: CommittedInventoryItem[],
  itemId: string,
  quantity: number,
  slotIndex: number | null,
): CommittedInventoryItem[] {
  if (slotIndex === null) {
    try {
      return debitInventorySnapshot(inventory, [{ itemId, quantity }]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "inventory_debit_insufficient_items"
      ) {
        throw new Error("ground_item_drop_insufficient_items");
      }
      throw error;
    }
  }
  const slotItem = inventory.find((item) => item.slotIndex === slotIndex);
  if (!slotItem || slotItem.itemId !== itemId) {
    throw new Error("ground_item_drop_slot_mismatch");
  }
  if (slotItem.quantity < quantity) {
    throw new Error("ground_item_drop_insufficient_items");
  }
  return inventory.flatMap((item) => {
    if (item.slotIndex !== slotIndex) return [item];
    const remaining = item.quantity - quantity;
    return remaining > 0 ? [{ ...item, quantity: remaining }] : [];
  });
}

function normalizeGatheringReward(
  input: GatheringRewardItem,
): GatheringRewardItem {
  const itemId = String(input?.itemId ?? "").trim();
  const quantity = Number(input?.quantity);
  if (
    !itemId ||
    itemId.length > 256 ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_PERSISTED_ITEM_QUANTITY ||
    typeof input?.stackable !== "boolean"
  ) {
    throw new Error("gathering_reward_request_invalid");
  }
  return { itemId, quantity, stackable: input.stackable };
}

function normalizeGatheringSecondaryItemId(
  value: string | null,
): string | null {
  if (value === null) return null;
  const itemId = String(value ?? "").trim();
  if (!itemId || itemId.length > 256) {
    throw new Error("gathering_reward_request_invalid");
  }
  return itemId;
}

function gatheringRewardFingerprint(
  playerId: string,
  resourceId: string,
  depleteAfterCommit: boolean,
  respawnTicks: number,
  skill: GatheringRewardSkill,
  xpAmount: number,
  reward: GatheringRewardItem,
  secondaryItemId: string | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        playerId,
        resourceId,
        depleteAfterCommit,
        respawnTicks,
        skill,
        xpAmount,
        reward,
        secondaryItemId,
      }),
      "utf8",
    )
    .digest("hex");
}

function creditGatheringReward(
  inventory: CommittedInventoryItem[],
  reward: GatheringRewardItem,
  errorPrefix = "gathering_reward",
): CommittedInventoryItem[] {
  const committed = inventory.map((item) => ({ ...item }));
  if (reward.stackable) {
    const existing = committed.find((item) => item.itemId === reward.itemId);
    if (existing) {
      const quantity = existing.quantity + reward.quantity;
      if (
        !Number.isSafeInteger(quantity) ||
        quantity > MAX_PERSISTED_ITEM_QUANTITY
      ) {
        throw new Error(`${errorPrefix}_quantity_overflow`);
      }
      existing.quantity = quantity;
      return committed;
    }
  }

  const occupied = new Set(committed.map((item) => item.slotIndex));
  const slotsNeeded = reward.stackable ? 1 : reward.quantity;
  const freeSlots: number[] = [];
  for (let slot = 0; slot < MAX_INVENTORY_SLOTS; slot++) {
    if (!occupied.has(slot)) freeSlots.push(slot);
  }
  if (freeSlots.length < slotsNeeded) {
    throw new Error(`${errorPrefix}_inventory_full`);
  }

  if (reward.stackable) {
    committed.push({
      itemId: reward.itemId,
      quantity: reward.quantity,
      slotIndex: freeSlots[0],
      metadata: null,
    });
  } else {
    for (let index = 0; index < reward.quantity; index++) {
      committed.push({
        itemId: reward.itemId,
        quantity: 1,
        slotIndex: freeSlots[index],
        metadata: null,
      });
    }
  }
  committed.sort((left, right) => left.slotIndex - right.slotIndex);
  return committed;
}

function skillLevelForXp(xp: number): number {
  let cumulative = 0;
  for (let level = 2; level <= 99; level++) {
    const increment =
      Math.floor(level - 1 + 300 * Math.pow(2, (level - 1) / 7)) / 4;
    cumulative = Math.floor(cumulative + increment);
    if (xp < cumulative) return level - 1;
  }
  return 99;
}

function mobCombatXpAmounts(
  attackStyle: string,
  damageDealt: number,
): Array<{ skill: MobCombatProgressSkill; xpAmount: number }> {
  const combatXp = Math.floor(
    damageDealt * COMBAT_CONSTANTS.XP.COMBAT_XP_PER_DAMAGE,
  );
  const constitutionXp = Math.floor(
    damageDealt * COMBAT_CONSTANTS.XP.HITPOINTS_XP_PER_DAMAGE,
  );
  if (attackStyle === "controlled") {
    const controlledXp = Math.floor(
      damageDealt * COMBAT_CONSTANTS.XP.CONTROLLED_XP_PER_DAMAGE,
    );
    return [
      { skill: "attack", xpAmount: controlledXp },
      { skill: "strength", xpAmount: controlledXp },
      { skill: "defense", xpAmount: controlledXp },
      { skill: "constitution", xpAmount: controlledXp },
    ];
  }
  const primarySkill: MobCombatProgressSkill =
    attackStyle === "accurate"
      ? "attack"
      : attackStyle === "defensive"
        ? "defense"
        : attackStyle === "ranged" ||
            attackStyle === "rapid" ||
            attackStyle === "longrange"
          ? "ranged"
          : attackStyle === "magic" || attackStyle === "autocast"
            ? "magic"
            : "strength";
  return [
    { skill: primarySkill, xpAmount: combatXp },
    { skill: "constitution", xpAmount: constitutionXp },
  ];
}

function normalizeProcessingInputs(
  value: InventoryDebitRequirement[],
): InventoryDebitRequirement[] {
  try {
    return normalizeInventoryDebitRequirements(value);
  } catch {
    throw new Error("processing_action_request_invalid");
  }
}

function normalizeProcessingRequiredItems(
  value: InventoryDebitRequirement[],
): InventoryDebitRequirement[] {
  if (!Array.isArray(value)) {
    throw new Error("processing_action_request_invalid");
  }
  if (value.length === 0) return [];
  return normalizeProcessingInputs(value);
}

function normalizeProcessingConsumables(
  value: ProcessingActionConsumable[],
): ProcessingActionConsumable[] {
  if (!Array.isArray(value) || value.length > 28) {
    throw new Error("processing_action_request_invalid");
  }
  const itemIds = new Set<string>();
  const consumables = value.map((raw) => {
    const itemId = String(raw?.itemId ?? "").trim();
    const usesPerItem = Number(raw?.usesPerItem);
    if (
      !itemId ||
      itemId.length > 256 ||
      itemIds.has(itemId) ||
      !Number.isSafeInteger(usesPerItem) ||
      usesPerItem <= 0 ||
      usesPerItem > MAX_PROCESSING_CONSUMABLE_USES
    ) {
      throw new Error("processing_action_request_invalid");
    }
    itemIds.add(itemId);
    return { itemId, usesPerItem };
  });
  consumables.sort((left, right) => left.itemId.localeCompare(right.itemId));
  return consumables;
}

function normalizeProcessingConsumableStates(
  value: ProcessingActionConsumableState[],
): ProcessingActionConsumableState[] {
  const consumables = normalizeProcessingConsumables(value);
  const rawByItem = new Map(
    value.map((entry) => [String(entry?.itemId ?? "").trim(), entry]),
  );
  return consumables.map((consumable) => {
    const raw = rawByItem.get(consumable.itemId);
    const remainingUses = Number(raw?.remainingUses);
    const consumedQuantity = Number(raw?.consumedQuantity);
    if (
      !Number.isSafeInteger(remainingUses) ||
      remainingUses < 0 ||
      remainingUses >= consumable.usesPerItem ||
      (consumedQuantity !== 0 && consumedQuantity !== 1) ||
      (consumedQuantity === 1 && remainingUses !== 0) ||
      (consumedQuantity === 0 && remainingUses === 0)
    ) {
      throw new Error("processing_action_operation_id_conflict");
    }
    return {
      ...consumable,
      remainingUses,
      consumedQuantity: consumedQuantity as 0 | 1,
    };
  });
}

function normalizeProcessingFireEffectRequest(
  value: ProcessingActionFireEffectRequest | undefined,
  skill: ProcessingActionSkill,
): ProcessingActionFireEffectRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || skill !== "firemaking") {
    throw new Error("processing_action_request_invalid");
  }
  const fireId = String(value.fireId ?? "").trim();
  const position = value.position;
  const tile = value.tile;
  const durationMs = Number(value.durationMs);
  if (
    value.kind !== "fire" ||
    fireId !== value.fireId ||
    !/^fire_[A-Za-z0-9_-]+$/.test(fireId) ||
    fireId.length > 256 ||
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z) ||
    !tile ||
    !Number.isSafeInteger(tile.x) ||
    !Number.isSafeInteger(tile.z) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <
      PROCESSING_CONSTANTS.FIRE.minDurationTicks * TICK_DURATION_MS ||
    durationMs > PROCESSING_CONSTANTS.FIRE.maxDurationTicks * TICK_DURATION_MS
  ) {
    throw new Error("processing_action_request_invalid");
  }
  const expectedTile = worldToTile(position.x, position.z);
  if (expectedTile.x !== tile.x || expectedTile.z !== tile.z) {
    throw new Error("processing_action_request_invalid");
  }
  return {
    kind: "fire",
    fireId,
    position: { x: position.x, y: position.y, z: position.z },
    tile: { x: tile.x, z: tile.z },
    durationMs,
  };
}

function normalizeStoredProcessingFireEffect(
  value: ProcessingActionFireEffect | undefined,
  expected?: ProcessingActionFireEffectRequest,
): ProcessingActionFireEffect | undefined {
  if (value === undefined && expected === undefined) return undefined;
  if (!value || value.kind !== "fire") {
    throw new Error("processing_action_world_effect_state_invalid");
  }
  const createdAt = Number(value.createdAt);
  const expiresAt = Number(value.expiresAt);
  const request = normalizeProcessingFireEffectRequest(
    {
      kind: "fire",
      fireId: value.fireId,
      position: value.position,
      tile: value.tile,
      durationMs: expiresAt - createdAt,
    },
    "firemaking",
  );
  if (
    !request ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= createdAt ||
    (expected && JSON.stringify(request) !== JSON.stringify(expected))
  ) {
    throw new Error("processing_action_world_effect_state_invalid");
  }
  return {
    kind: "fire",
    fireId: request.fireId,
    position: request.position,
    tile: request.tile,
    createdAt,
    expiresAt,
  };
}

function normalizeStoredProcessingConsumableUses(
  value: unknown,
): StoredProcessingConsumableUses {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("processing_action_consumable_state_invalid");
  }
  const normalized: StoredProcessingConsumableUses = {};
  for (const itemId of Object.keys(value as Record<string, unknown>).sort()) {
    const raw = (value as Record<string, unknown>)[itemId];
    if (!itemId || itemId.length > 256 || !raw || typeof raw !== "object") {
      throw new Error("processing_action_consumable_state_invalid");
    }
    const usesPerItem = Number((raw as { usesPerItem?: unknown }).usesPerItem);
    const remainingUses = Number(
      (raw as { remainingUses?: unknown }).remainingUses,
    );
    if (
      !Number.isSafeInteger(usesPerItem) ||
      usesPerItem <= 0 ||
      usesPerItem > MAX_PROCESSING_CONSUMABLE_USES ||
      !Number.isSafeInteger(remainingUses) ||
      remainingUses <= 0 ||
      remainingUses >= usesPerItem
    ) {
      throw new Error("processing_action_consumable_state_invalid");
    }
    normalized[itemId] = { usesPerItem, remainingUses };
  }
  return normalized;
}

function normalizeProcessingOutputs(
  value: ProcessingActionItem[],
): ProcessingActionItem[] {
  if (!Array.isArray(value) || value.length > 28) {
    throw new Error("processing_action_request_invalid");
  }
  const outputs = new Map<string, ProcessingActionItem>();
  for (const raw of value) {
    const itemId = String(raw?.itemId ?? "").trim();
    const quantity = Number(raw?.quantity);
    if (
      !itemId ||
      itemId.length > 256 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY ||
      typeof raw?.stackable !== "boolean"
    ) {
      throw new Error("processing_action_request_invalid");
    }
    const existing = outputs.get(itemId);
    if (existing && existing.stackable !== raw.stackable) {
      throw new Error("processing_action_request_invalid");
    }
    const combined = (existing?.quantity ?? 0) + quantity;
    if (
      !Number.isSafeInteger(combined) ||
      combined > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("processing_action_request_invalid");
    }
    outputs.set(itemId, {
      itemId,
      quantity: combined,
      stackable: raw.stackable,
    });
  }
  return [...outputs.values()].sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
}

function processingActionFingerprint(
  playerId: string,
  skill: ProcessingActionSkill,
  xpAmount: number,
  inputs: InventoryDebitRequirement[],
  requiredItems: InventoryDebitRequirement[],
  consumables: ProcessingActionConsumable[],
  outputs: ProcessingActionItem[],
  coinCost: number,
  worldEffect?: ProcessingActionFireEffectRequest,
): string {
  const payload: Record<string, unknown> = {
    version: 1,
    playerId,
    skill,
    xpAmount,
    inputs,
    outputs,
  };
  // Preserve fingerprints for already committed non-consumable actions.
  if (requiredItems.length > 0) payload.requiredItems = requiredItems;
  if (consumables.length > 0) payload.consumables = consumables;
  if (coinCost > 0) payload.coinCost = coinCost;
  if (worldEffect) payload.worldEffect = worldEffect;
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function normalizeCombatLoadoutSnapshot(
  value: CombatLoadoutPersistenceSnapshot,
): CombatLoadoutPersistenceSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("combat_loadout_snapshot_invalid");
  }

  const inventory = normalizeInventorySnapshot(
    value.inventory,
    "combat_loadout",
  );

  const equipmentSlots = new Set<string>();
  const equipment = value.equipment.map((raw) => {
    const slotType = String(raw.slotType ?? "").trim();
    const itemId = String(raw.itemId ?? "").trim();
    const quantity = Number(raw.quantity);
    if (
      !slotType ||
      equipmentSlots.has(slotType) ||
      !itemId ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      throw new Error("combat_loadout_equipment_invalid");
    }
    equipmentSlots.add(slotType);
    return { slotType, itemId, quantity };
  });
  equipment.sort((a, b) => a.slotType.localeCompare(b.slotType));

  const selectedSpell = value.selectedSpell;
  if (
    selectedSpell !== null &&
    (typeof selectedSpell !== "string" || !selectedSpell.trim())
  ) {
    throw new Error("combat_loadout_selected_spell_invalid");
  }

  return {
    inventory,
    equipment,
    selectedSpell: selectedSpell?.trim() ?? null,
  };
}

function combatLoadoutSnapshotsEqual(
  left: CombatLoadoutPersistenceSnapshot,
  right: CombatLoadoutPersistenceSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeDuelPreparationPlanSnapshot(
  value: DuelPreparationPlanPersistenceSnapshot,
): DuelPreparationPlanPersistenceSnapshot {
  if (!value || typeof value !== "object" || !Array.isArray(value.bank)) {
    throw new Error("duel_preparation_plan_snapshot_invalid");
  }
  const combat = normalizeCombatLoadoutSnapshot(value);
  const occupied = new Set<string>();
  const bank = value.bank.map((raw) => {
    const itemId = String(raw.itemId ?? "").trim();
    const quantity = Number(raw.quantity);
    const slot = Number(raw.slot);
    const tabIndex = Number(raw.tabIndex);
    const position = `${tabIndex}:${slot}`;
    if (
      !itemId ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > BANKING_CONSTANTS.MAX_ITEM_STACK ||
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      slot >= BANKING_CONSTANTS.MAX_BANK_SLOTS ||
      !Number.isSafeInteger(tabIndex) ||
      tabIndex < 0 ||
      tabIndex >= BANKING_CONSTANTS.MAX_TABS ||
      occupied.has(position)
    ) {
      throw new Error("duel_preparation_plan_bank_invalid");
    }
    occupied.add(position);
    return { itemId, quantity, slot, tabIndex };
  });
  if (bank.length > BANKING_CONSTANTS.MAX_BANK_SLOTS) {
    throw new Error("duel_preparation_plan_bank_invalid");
  }
  bank.sort(
    (a, b) =>
      a.tabIndex - b.tabIndex ||
      a.slot - b.slot ||
      a.itemId.localeCompare(b.itemId),
  );
  return { ...combat, bank };
}

function duelPreparationPlanSnapshotsEqual(
  left: DuelPreparationPlanPersistenceSnapshot,
  right: DuelPreparationPlanPersistenceSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function duelPreparationPlanSnapshotMismatchKinds(
  persisted: DuelPreparationPlanPersistenceSnapshot,
  expected: DuelPreparationPlanPersistenceSnapshot,
): string[] {
  const mismatches: string[] = [];
  if (
    JSON.stringify(persisted.inventory) !== JSON.stringify(expected.inventory)
  ) {
    mismatches.push("inventory");
  }
  if (
    JSON.stringify(persisted.equipment) !== JSON.stringify(expected.equipment)
  ) {
    mismatches.push("equipment");
  }
  if (persisted.selectedSpell !== expected.selectedSpell) {
    mismatches.push("selected_spell");
  }
  if (JSON.stringify(persisted.bank) !== JSON.stringify(expected.bank)) {
    mismatches.push("bank");
  }
  return mismatches;
}

function duelPreparationPlanCustodyTotals(
  snapshot: DuelPreparationPlanPersistenceSnapshot,
): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const item of [
    ...snapshot.bank,
    ...snapshot.inventory,
    ...snapshot.equipment,
  ]) {
    totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.quantity);
  }
  return [...totals.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function duelPreparationPlanCustodyIsConserved(
  before: DuelPreparationPlanPersistenceSnapshot,
  after: DuelPreparationPlanPersistenceSnapshot,
): boolean {
  return (
    JSON.stringify(duelPreparationPlanCustodyTotals(before)) ===
    JSON.stringify(duelPreparationPlanCustodyTotals(after))
  );
}

function normalizeDuelPreparationPlanRecoveryEvidence(
  value: unknown,
): DuelPreparationPlanRecoveryEvidence {
  const seen = new Set<object>();
  const canonicalize = (entry: unknown, depth: number): string | null => {
    if (depth > 12) return null;
    if (entry === null || typeof entry === "boolean") {
      return JSON.stringify(entry);
    }
    if (typeof entry === "string") {
      return entry.length <= 4_096 ? JSON.stringify(entry) : null;
    }
    if (typeof entry === "number") {
      return Number.isFinite(entry) ? JSON.stringify(entry) : null;
    }
    if (typeof entry !== "object" || seen.has(entry)) return null;
    seen.add(entry);
    let result: string | null;
    if (Array.isArray(entry)) {
      if (entry.length > 128) result = null;
      else {
        const values = entry.map((item) => canonicalize(item, depth + 1));
        result = values.some((item) => item === null)
          ? null
          : `[${values.join(",")}]`;
      }
    } else {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) result = null;
      else {
        const record = entry as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        if (keys.length > 128) result = null;
        else {
          const fields: string[] = [];
          result = "";
          for (const key of keys) {
            const child = canonicalize(record[key], depth + 1);
            if (child === null) {
              result = null;
              break;
            }
            fields.push(`${JSON.stringify(key)}:${child}`);
          }
          if (result !== null) result = `{${fields.join(",")}}`;
        }
      }
    }
    seen.delete(entry);
    return result;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("duel_preparation_plan_recovery_evidence_invalid");
  }
  const canonical = canonicalize(value, 0);
  if (!canonical || canonical.length > 32_768) {
    throw new Error("duel_preparation_plan_recovery_evidence_invalid");
  }
  return JSON.parse(canonical) as DuelPreparationPlanRecoveryEvidence;
}

/**
 * Transaction isolation levels for database operations
 *
 * - 'read committed' (default): Prevents dirty reads
 * - 'repeatable read': Prevents dirty reads and non-repeatable reads
 * - 'serializable': Prevents all concurrency anomalies (strictest)
 *
 * Use 'serializable' for critical financial/inventory operations where
 * race conditions could cause item duplication or loss.
 */
export type IsolationLevel = PostgresIsolationLevel;

/**
 * DatabaseSystem class
 *
 * Extends SystemBase to integrate with HyperForge's ECS architecture.
 * Acts as a facade that delegates to domain-specific repositories.
 */
export class DatabaseSystem extends SystemBase {
  /** Drizzle database instance for type-safe queries */
  private db: NodePgDatabase<typeof schema> | null = null;

  /** Unique authority epoch; a new process can identify abandoned requests. */
  private readonly processingRequestOwnerId = randomUUID();

  /** PostgreSQL connection pool for low-level operations if needed */
  private pool: pg.Pool | null = null;

  /**
   * Tracks all pending database operations to ensure graceful shutdown.
   * Operations are added when sync methods fire-and-forget async work.
   */
  private pendingOperations: Set<Promise<unknown>> = new Set();

  /** Flag to indicate the system is being destroyed - prevents new operations */
  private isDestroying: boolean = false;

  // Repository instances
  private characterRepository!: CharacterRepository;
  private playerRepository!: PlayerRepository;
  private inventoryRepository!: InventoryRepository;
  private equipmentRepository!: EquipmentRepository;
  private sessionRepository!: SessionRepository;
  private worldChunkRepository!: WorldChunkRepository;
  private npcKillRepository!: NPCKillRepository;
  private deathRepository!: DeathRepository;
  private templateRepository!: TemplateRepository;
  private questRepository!: QuestRepository;
  private activityLogRepository!: ActivityLogRepository;
  private bankRepository!: BankRepository;

  /**
   * Constructor
   *
   * Sets up the database system with no dependencies since it provides
   * foundational services to other systems.
   *
   * @param world - The game world instance this system belongs to
   */
  constructor(world: World) {
    super(world, {
      name: "database",
      dependencies: {
        required: [], // No dependencies - this is a foundational system
        optional: [],
      },
      autoCleanup: true, // Automatically clean up resources on destroy
    });
  }

  /**
   * Initialize the database system
   *
   * Retrieves the Drizzle database instance and PostgreSQL pool from the World object.
   * Instantiates all repositories with the database connections.
   *
   * @throws Error if database instances are not available on the world object
   */
  async init(): Promise<void> {
    // Cast world to access server-specific properties
    const serverWorld = this.world as {
      pgPool?: pg.Pool;
      drizzleDb?: NodePgDatabase<typeof schema>;
    };

    if (serverWorld.drizzleDb && serverWorld.pgPool) {
      this.db = serverWorld.drizzleDb;
      this.pool = serverWorld.pgPool;

      // Initialize all repositories
      this.characterRepository = new CharacterRepository(this.db, this.pool);
      this.playerRepository = new PlayerRepository(this.db, this.pool);
      this.inventoryRepository = new InventoryRepository(this.db, this.pool);
      this.equipmentRepository = new EquipmentRepository(this.db, this.pool);
      this.sessionRepository = new SessionRepository(this.db, this.pool);
      this.worldChunkRepository = new WorldChunkRepository(this.db, this.pool);
      this.npcKillRepository = new NPCKillRepository(this.db, this.pool);
      this.deathRepository = new DeathRepository(this.db, this.pool);
      this.templateRepository = new TemplateRepository(this.db, this.pool);
      this.questRepository = new QuestRepository(this.db, this.pool);
      this.activityLogRepository = new ActivityLogRepository(
        this.db,
        this.pool,
      );
      this.bankRepository = new BankRepository(this.db, this.pool);
    } else {
      throw new Error(
        "[DatabaseSystem] Drizzle database not provided on world object",
      );
    }
  }

  /**
   * Start the database system
   *
   * Currently a no-op since all initialization is done in init().
   * The database is ready to use immediately after initialization.
   */
  start(): void {}

  /**
   * Wait for all pending database operations to complete
   *
   * This is critical for graceful shutdown to ensure no data loss.
   * Sync methods (like savePlayer) fire-and-forget async operations which
   * are tracked here. Before shutting down, we wait for all of them to complete.
   *
   * Called by server shutdown handler in index.ts.
   */
  async waitForPendingOperations(): Promise<void> {
    // A zero-delay generic save may still be buffered and therefore absent
    // from pendingOperations. Flush and drain the ordered player-write tail
    // before repositories begin rejecting new shutdown-time work.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.flushSaveBuffer();
      await this.playerSaveWriteTail.catch(() => undefined);
      // Allow the batch acknowledgement/finalizer microtasks to retire fields
      // or retain them for the next bounded shutdown attempt.
      await Promise.resolve();
      if (
        this.pendingSaveBuffer.size === 0 &&
        !this.playerSaveFlushInFlight &&
        this.directPlayerSaveInFlight === 0
      ) {
        break;
      }
    }
    if (this.pendingSaveBuffer.size > 0) {
      console.error(
        `[DatabaseSystem] ${this.pendingSaveBuffer.size} latest player snapshot(s) remain uncommitted at the shutdown boundary`,
      );
    }

    // Set flag to prevent new operations during shutdown
    this.isDestroying = true;

    // Mark all repositories as destroying
    this.characterRepository.markDestroying();
    this.playerRepository.markDestroying();
    this.inventoryRepository.markDestroying();
    this.equipmentRepository.markDestroying();
    this.sessionRepository.markDestroying();
    this.worldChunkRepository.markDestroying();
    this.npcKillRepository.markDestroying();
    this.deathRepository.markDestroying();
    this.templateRepository.markDestroying();
    this.questRepository.markDestroying();
    this.activityLogRepository.markDestroying();
    this.bankRepository.markDestroying();

    if (this.pendingOperations.size === 0) {
      return;
    }

    // Create a copy of the pending operations to avoid issues with modifications during iteration
    const operations = Array.from(this.pendingOperations);

    // Wait for all operations to complete
    await Promise.allSettled(operations);
  }

  /**
   * Helper method to track fire-and-forget async operations
   *
   * Used by sync wrapper methods to ensure operations complete before shutdown.
   * Prevents new operations during shutdown and handles errors gracefully.
   *
   * @param operation - The async operation to track
   * @private
   */
  /** Threshold for warning about pending operation buildup */
  private readonly PENDING_OPS_WARN_THRESHOLD = 50000;
  private lastPendingWarnTime = 0;

  /**
   * Debounce buffer for savePlayer calls.
   * Coalesces multiple field updates per player into a single DB write.
   * Flushed after a short delay (one microtask batch) so rapid XP drops,
   * skill updates, and position saves merge into one UPDATE per player.
   */
  private pendingSaveBuffer = new Map<string, PlayerPersistenceUpdate>();
  /** Per-field generations let a failed older batch retain only still-current data. */
  private pendingSaveFieldRevisions = new Map<
    string,
    Map<keyof PlayerPersistenceUpdate, number>
  >();
  private playerSaveRevision = 0;
  private saveFlushScheduled = false;
  private saveFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private playerSaveFlushInFlight = false;
  private directPlayerSaveInFlight = 0;
  private readonly PLAYER_SAVE_RETRY_MS = 1_000;
  private lastPlayerSaveRetryLogTime = 0;

  /**
   * Serialize generic and awaited player-row writes. Concurrent UPDATE
   * transactions can otherwise commit out of invocation order and let an older
   * health/position snapshot overwrite a newer shutdown or reconnect snapshot.
   */
  private playerSaveWriteTail: Promise<void> = Promise.resolve();

  /**
   * Debounce buffer for savePlayerInventory calls.
   * Keeps only the latest snapshot per player — later calls overwrite earlier ones.
   * Prevents concurrent UPSERTs on the same inventory rows (PostgreSQL deadlock).
   */
  private pendingInventoryBuffer = new Map<string, InventorySaveItem[]>();
  private inventoryFlushScheduled = false;

  /**
   * Write coalescing for inventory persistence.
   * When multiple savePlayerInventoryAsync calls arrive for the same player,
   * only the LATEST snapshot is written. At most 2 DB transactions run per
   * player: one active + one queued batch with the newest data.
   * Prevents both PostgreSQL deadlocks and connection pool starvation.
   */
  private inventoryWriteActive = new Map<string, Promise<void>>();
  private inventoryWriteQueued = new Map<
    string,
    {
      items: InventorySaveItem[];
      waiters: Array<{
        resolve: () => void;
        reject: (err: unknown) => void;
      }>;
    }
  >();

  private trackAsyncOperation<T>(operation: Promise<T>): void {
    if (this.isDestroying) return; // Skip during shutdown

    // Warn (but don't drop) if pending operations are accumulating
    if (this.pendingOperations.size >= this.PENDING_OPS_WARN_THRESHOLD) {
      const now = Date.now();
      if (now - this.lastPendingWarnTime > 5000) {
        console.warn(
          `[DatabaseSystem] ${this.pendingOperations.size} pending operations — possible DB slowdown`,
        );
        this.lastPendingWarnTime = now;
      }
    }

    const tracked = operation
      .catch((err) => {
        console.error("[DatabaseSystem] Error in tracked operation:", err);
      })
      .finally(() => {
        this.pendingOperations.delete(tracked);
      });

    this.pendingOperations.add(tracked);
  }

  /** Track an awaited custody operation so graceful shutdown waits for it too. */
  private trackAwaitedOperation<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      this.pendingOperations.delete(tracked);
    });
    this.pendingOperations.add(tracked);
    return tracked;
  }

  // ============================================================================
  // TRANSACTION SUPPORT
  // ============================================================================

  /**
   * Execute a callback within a database transaction
   *
   * Provides all-or-nothing execution semantics:
   * - If callback completes successfully → automatic COMMIT
   * - If callback throws error → automatic ROLLBACK
   *
   * CRITICAL FOR SECURITY: Prevents partial database states that can lead to
   * item duplication or item loss (e.g., inventory cleared but gravestone not spawned).
   *
   * Added isolationLevel option for stricter transaction guarantees.
   * Use 'serializable' for death processing to prevent race conditions.
   *
   * @param callback - Async function that receives transaction context
   * @param options - Optional transaction configuration
   * @param options.isolationLevel - Transaction isolation level (default: 'read committed')
   * @returns The result of the callback
   *
   * @example
   * ```typescript
   * // Standard transaction
   * await dbSystem.executeInTransaction(async (tx) => {
   *   await tx.insert(table1).values({...});
   *   await tx.insert(table2).values({...});
   *   // If either fails, both are rolled back
   * });
   *
   * // Serializable transaction for critical operations
   * await dbSystem.executeInTransaction(async (tx) => {
   *   // Fully serialized - prevents all race conditions
   *   await tx.insert(inventory).values({...});
   * }, { isolationLevel: 'serializable' });
   * ```
   */
  async executeInTransaction<T>(
    callback: (tx: NodePgDatabase<typeof schema>) => Promise<T>,
    options?: {
      isolationLevel?: IsolationLevel;
      maxConflictRetries?: number;
      conflictRetryBaseDelayMs?: number;
    },
  ): Promise<T> {
    if (!this.db || !this.pool) {
      throw new Error(
        "[DatabaseSystem] Database not initialized - cannot start transaction",
      );
    }

    return runInPostgresTransaction(this.pool, callback, {
      isolationLevel: options?.isolationLevel ?? "read committed",
      maxConflictRetries: options?.maxConflictRetries,
      conflictRetryBaseDelayMs: options?.conflictRetryBaseDelayMs,
    });
  }

  // ============================================================================
  // CHARACTER MANAGEMENT
  // ============================================================================

  /**
   * Get all characters for an account
   * Delegates to CharacterRepository
   */
  async getCharactersAsync(accountId: string): Promise<
    Array<{
      id: string;
      name: string;
      avatar?: string | null;
      wallet?: string | null;
      isAgent?: boolean;
    }>
  > {
    return this.characterRepository.getCharactersAsync(accountId);
  }

  /**
   * Create a new character
   * Delegates to CharacterRepository
   */
  async createCharacter(
    accountId: string,
    id: string,
    name: string,
    avatar?: string,
    wallet?: string,
    isAgent?: boolean,
  ): Promise<boolean> {
    return this.characterRepository.createCharacter(
      accountId,
      id,
      name,
      avatar,
      wallet,
      isAgent,
    );
  }

  /**
   * Delete a character by ID
   * Delegates to CharacterRepository
   *
   * Used when users cancel agent creation or explicitly delete unwanted characters.
   *
   * @param characterId - The character ID to delete
   * @returns true if character was deleted, false if not found
   */
  async deleteCharacter(characterId: string): Promise<boolean> {
    return this.characterRepository.deleteCharacter(characterId);
  }

  /**
   * Update character's isAgent flag
   * Delegates to CharacterRepository
   *
   * Converts a character between agent and human types. Used when users
   * decide to convert an abandoned agent character to play themselves.
   *
   * @param characterId - The character ID to update
   * @param isAgent - New value for isAgent flag
   * @returns true if character was updated, false if not found
   */
  async updateCharacterIsAgent(
    characterId: string,
    isAgent: boolean,
  ): Promise<boolean> {
    return this.characterRepository.updateCharacterIsAgent(
      characterId,
      isAgent,
    );
  }

  /**
   * Get character skills
   * Delegates to CharacterRepository
   *
   * Retrieves skill levels and XP for a character. Used by the dashboard
   * to display agent skill progress in real-time.
   *
   * @param characterId - The character ID to fetch skills for
   * @returns Skills object with level and xp for each skill, or null if not found
   */
  async getCharacterSkills(characterId: string): Promise<{
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
    smithing: { level: number; xp: number };
    agility: { level: number; xp: number };
    crafting: { level: number; xp: number };
  } | null> {
    return this.characterRepository.getCharacterSkills(characterId);
  }

  // ============================================================================
  // TEMPLATE MANAGEMENT
  // ============================================================================

  /**
   * Get all character templates
   * Delegates to TemplateRepository
   *
   * Retrieves all available character templates (archetypes) that players
   * can choose from when creating new characters.
   *
   * @returns Array of all character templates
   */
  async getTemplatesAsync(): Promise<
    Array<{
      id: number;
      name: string;
      description: string;
      emoji: string;
      templateUrl: string;
      templateConfig: string | null;
      createdAt: number;
    }>
  > {
    return this.templateRepository.getAllTemplates();
  }

  /**
   * Get template by ID
   * Delegates to TemplateRepository
   *
   * Retrieves a specific character template by its database ID.
   *
   * @param templateId - The template ID to fetch
   * @returns Template data or null if not found
   */
  async getTemplateByIdAsync(templateId: number): Promise<{
    id: number;
    name: string;
    description: string;
    emoji: string;
    templateUrl: string;
    templateConfig: string | null;
    createdAt: number;
  } | null> {
    return this.templateRepository.getTemplateById(templateId);
  }

  /**
   * Get template by name
   * Delegates to TemplateRepository
   *
   * Retrieves a character template by its name (e.g., "The Skiller").
   * Used for legacy filename-based lookups.
   *
   * @param templateName - The template name to search for
   * @returns Template data or null if not found
   */
  async getTemplateByNameAsync(templateName: string): Promise<{
    id: number;
    name: string;
    description: string;
    emoji: string;
    templateUrl: string;
    templateConfig: string | null;
    createdAt: number;
  } | null> {
    return this.templateRepository.getTemplateByName(templateName);
  }

  // ============================================================================
  // USER MANAGEMENT
  // ============================================================================

  /**
   * Update a user's wallet address
   * This assigns the user's main Privy embedded wallet (HD index 0) to their user record
   *
   * @param accountId - The user's Privy account ID
   * @param wallet - The wallet address to assign
   */
  async updateUserWallet(accountId: string, wallet: string): Promise<void> {
    if (!this.db) {
      throw new Error(
        "[DatabaseSystem] Database not initialized - cannot update user wallet",
      );
    }

    await this.db
      .update(schema.users)
      .set({ wallet })
      .where(eq(schema.users.id, accountId));
  }

  /**
   * Get the raw Drizzle database instance
   * This allows other systems to perform custom queries
   *
   * @returns The Drizzle database instance or null if not initialized
   */
  getDb(): NodePgDatabase<typeof schema> | null {
    return this.db;
  }

  // ============================================================================
  // PLAYER DATA PERSISTENCE
  // ============================================================================

  /**
   * Load player data from database
   * Delegates to PlayerRepository
   */
  async getPlayerAsync(playerId: string): Promise<PlayerRow | null> {
    return this.playerRepository.getPlayerAsync(playerId);
  }

  /**
   * Save player data to database
   * Delegates to PlayerRepository
   */
  async savePlayerAsync(
    playerId: string,
    data: PlayerPersistenceUpdate,
  ): Promise<void> {
    // Preserve invocation order with any same-tick generic snapshots. In
    // particular, graceful shutdown's direct snapshot must not be followed by
    // an older zero-delay buffer that commits later.
    const directRevision = ++this.playerSaveRevision;
    this.flushSaveBuffer();
    this.directPlayerSaveInFlight += 1;
    try {
      await this.enqueuePlayerSave(() =>
        this.playerRepository.savePlayerAsync(playerId, data),
      );
      this.acknowledgeDirectPlayerSave(playerId, data, directRevision);
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          `[DatabaseSystem] savePlayerAsync(${playerId}) failed due to database connectivity; continuing in best-effort mode`,
          error,
        );
        return;
      }
      throw error;
    } finally {
      this.directPlayerSaveInFlight -= 1;
      this.scheduleSaveBufferFlush(0);
    }
  }

  private acknowledgeDirectPlayerSave(
    playerId: string,
    data: PlayerPersistenceUpdate,
    directRevision: number,
  ): void {
    const current = this.pendingSaveBuffer.get(playerId);
    const revisions = this.pendingSaveFieldRevisions.get(playerId);
    if (!current || !revisions) return;
    for (const field of Object.keys(data) as Array<
      keyof PlayerPersistenceUpdate
    >) {
      const revision = revisions.get(field);
      if (revision === undefined || revision > directRevision) continue;
      delete current[field];
      revisions.delete(field);
    }
    if (Object.keys(current).length === 0) {
      this.pendingSaveBuffer.delete(playerId);
      this.pendingSaveFieldRevisions.delete(playerId);
    }
  }

  /**
   * Save complete player state atomically (stats + inventory + equipment)
   *
   * Use this for critical save points where all data must be consistent:
   * - Player logout/disconnect
   * - Trading completion
   * - Death processing
   *
   * Wraps all operations in a single transaction with ROLLBACK on any failure.
   * Prevents partial saves that could lead to item loss or duplication.
   *
   * @param playerId - Player ID to save
   * @param data - Character stats to save (partial update)
   * @param inventory - Complete inventory state
   * @param equipment - Complete equipment state
   * @param options - Transaction options
   */
  async savePlayerCompleteAsync(
    playerId: string,
    data: PlayerPersistenceUpdate,
    inventory?: InventorySaveItem[],
    equipment?: EquipmentSaveItem[],
    options?: { isolationLevel?: IsolationLevel },
  ): Promise<void> {
    assertGenericPlayerUpdateExcludesPrayerAuthority(
      data,
      "DatabaseSystem.savePlayerCompleteAsync",
    );
    assertGenericPlayerUpdateExcludesAttackStyleAuthority(
      data,
      "DatabaseSystem.savePlayerCompleteAsync",
    );
    if (!this.db) {
      throw new Error("[DatabaseSystem] Database not initialized");
    }

    return this.executeInTransaction(
      async (tx) => {
        // Save character stats
        if (Object.keys(data).length > 0) {
          const updateData = buildGenericCharacterUpdate(data);
          if (Object.keys(updateData).length > 0) {
            await tx
              .update(schema.characters)
              .set(updateData)
              .where(eq(schema.characters.id, playerId));
          }
        }

        // Save inventory if provided
        if (inventory) {
          const validItems = inventory.filter(
            (item) => (item.slotIndex ?? -1) >= 0,
          );
          const occupiedSlots = validItems.map((item) => item.slotIndex!);

          // Delete items not in occupied slots
          if (occupiedSlots.length > 0) {
            await tx.execute(
              sql`DELETE FROM inventory
                  WHERE "playerId" = ${playerId}
                  AND "slotIndex" >= 0
                  AND "slotIndex" NOT IN (${sql.join(
                    occupiedSlots.map((s) => sql`${s}`),
                    sql`, `,
                  )})`,
            );
          } else {
            await tx
              .delete(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId));
          }

          // Persist current items with per-slot replacement.
          // Some local/dev databases can miss the partial unique index used by
          // ON CONFLICT, which would raise 42P10 and abort startup.
          for (const item of validItems) {
            const slotIndex = item.slotIndex!;
            const metadata = item.metadata
              ? JSON.stringify(item.metadata)
              : null;

            await tx.execute(
              sql`DELETE FROM inventory
                  WHERE "playerId" = ${playerId}
                  AND "slotIndex" = ${slotIndex}`,
            );
            await tx.execute(
              sql`INSERT INTO inventory ("playerId", "itemId", "quantity", "slotIndex", "metadata")
                  VALUES (${playerId}, ${item.itemId}, ${item.quantity}, ${slotIndex}, ${metadata})`,
            );
          }
        }

        // Save equipment if provided
        if (equipment) {
          const validEquipment = equipment.filter(
            (item) => item.slotType !== undefined,
          );
          const occupiedSlots = validEquipment.map((item) => item.slotType);

          // Delete equipment not in occupied slots
          if (occupiedSlots.length > 0) {
            await tx.execute(
              sql`DELETE FROM equipment
                  WHERE "playerId" = ${playerId}
                  AND "slot" NOT IN (${sql.join(
                    occupiedSlots.map((s) => sql`${s}`),
                    sql`, `,
                  )})`,
            );
          } else {
            await tx
              .delete(schema.equipment)
              .where(eq(schema.equipment.playerId, playerId));
          }

          // Upsert current equipment
          for (const item of validEquipment) {
            const slot = item.slotType;
            await tx.execute(
              sql`INSERT INTO equipment ("playerId", "slot", "itemId")
                  VALUES (${playerId}, ${slot}, ${item.itemId})
                  ON CONFLICT ("playerId", "slot")
                  DO UPDATE SET "itemId" = EXCLUDED."itemId"`,
            );
          }
        }
      },
      { isolationLevel: options?.isolationLevel ?? "read committed" },
    );
  }

  // ============================================================================
  // INVENTORY MANAGEMENT
  // ============================================================================

  /**
   * Load player inventory from database
   * Delegates to InventoryRepository
   */
  async getPlayerInventoryAsync(playerId: string): Promise<InventoryRow[]> {
    return this.inventoryRepository.getPlayerInventoryAsync(playerId);
  }

  /**
   * Save player inventory to database with write coalescing.
   * If a write is already active for this player, the latest items snapshot
   * is queued and all waiting callers resolve when that batch completes.
   * This collapses N concurrent calls into at most 2 DB transactions.
   */
  async savePlayerInventoryAsync(
    playerId: string,
    items: InventorySaveItem[],
  ): Promise<void> {
    // If a write is already running for this player, coalesce into the queued batch
    if (this.inventoryWriteActive.has(playerId)) {
      return new Promise<void>((resolve, reject) => {
        const queued = this.inventoryWriteQueued.get(playerId);
        if (queued) {
          // Replace items with the latest snapshot — only the newest matters
          queued.items = items;
          queued.waiters.push({ resolve, reject });
        } else {
          this.inventoryWriteQueued.set(playerId, {
            items,
            waiters: [{ resolve, reject }],
          });
        }
      });
    }

    // No active write — execute immediately
    await this.executeInventoryWrite(playerId, items);
  }

  /**
   * Execute a single inventory write and drain any queued batch afterward.
   */
  private async executeInventoryWrite(
    playerId: string,
    items: InventorySaveItem[],
  ): Promise<void> {
    const writePromise = this.inventoryRepository.savePlayerInventoryAsync(
      playerId,
      items,
    );
    this.inventoryWriteActive.set(playerId, writePromise);

    try {
      await writePromise;
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          `[DatabaseSystem] savePlayerInventoryAsync(${playerId}) failed due to database connectivity; continuing in best-effort mode`,
          error,
        );
      } else {
        throw error;
      }
    } finally {
      this.inventoryWriteActive.delete(playerId);

      // Drain the queued batch if any calls arrived while we were writing
      const queued = this.inventoryWriteQueued.get(playerId);
      if (queued) {
        this.inventoryWriteQueued.delete(playerId);
        try {
          await this.executeInventoryWrite(playerId, queued.items);
          for (const w of queued.waiters) w.resolve();
        } catch (err) {
          for (const w of queued.waiters) w.reject(err);
        }
      }
    }
  }

  // ============================================================================
  // EQUIPMENT MANAGEMENT
  // ============================================================================

  /**
   * Load player equipment from database
   * Delegates to EquipmentRepository
   */
  async getPlayerEquipmentAsync(playerId: string): Promise<EquipmentRow[]> {
    return this.equipmentRepository.getPlayerEquipmentAsync(playerId);
  }

  /**
   * Save player equipment to database
   * Delegates to EquipmentRepository
   */
  async savePlayerEquipmentAsync(
    playerId: string,
    items: EquipmentSaveItem[],
  ): Promise<void> {
    try {
      return await this.equipmentRepository.savePlayerEquipmentAsync(
        playerId,
        items,
      );
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          `[DatabaseSystem] savePlayerEquipmentAsync(${playerId}) failed due to database connectivity; continuing in best-effort mode`,
          error,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Commit one complete combat-loadout transition and its durable receipt in a
   * single transaction. A character-row lock serializes all switch writers for
   * that player across scheduler processes. The expected snapshot prevents a
   * stale process from overwriting more recent custody state.
   */
  async commitCombatLoadoutOperationAsync(
    request: CombatLoadoutCommitRequest,
  ): Promise<CombatLoadoutCommitReceipt> {
    if (!this.db) {
      throw new Error("combat_loadout_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      !requestFingerprint ||
      requestFingerprint.length > 512
    ) {
      throw new Error("combat_loadout_request_invalid");
    }
    const expected = normalizeCombatLoadoutSnapshot(request.expected);
    const committed = normalizeCombatLoadoutSnapshot(request.committed);
    const requestedPublicActionObservation =
      request.publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelRoleSwitchObservationContext(
            request.publicActionObservation,
          );
    if (
      request.publicActionObservation !== undefined &&
      (!requestedPublicActionObservation ||
        requestedPublicActionObservation.actorId !== playerId ||
        !/^[a-f0-9]{64}$/.test(requestFingerprint))
    ) {
      throw new Error("combat_loadout_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        // This lock is the cluster-wide per-character serialization boundary.
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            selectedSpell: schema.characters.selectedSpell,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) {
          throw new Error("combat_loadout_player_missing");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredCombatLoadoutOperation | undefined;
          const statePublicActionObservation =
            state?.publicActionObservation === undefined
              ? undefined
              : parseStreamingDuelRoleSwitchObservationContext(
                  state.publicActionObservation,
                );
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "combat_loadout_switch" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            (state?.publicActionObservation !== undefined &&
              !statePublicActionObservation) ||
            JSON.stringify(statePublicActionObservation) !==
              JSON.stringify(requestedPublicActionObservation)
          ) {
            throw new Error("combat_loadout_operation_id_conflict");
          }
          const replayedCommitted = normalizeCombatLoadoutSnapshot(
            state.committed,
          );
          if (!combatLoadoutSnapshotsEqual(replayedCommitted, committed)) {
            throw new Error("combat_loadout_operation_id_conflict");
          }
          if (statePublicActionObservation) {
            await commitRoleSwitchPublicActionObservation(
              tx,
              statePublicActionObservation,
              true,
            );
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            committed: replayedCommitted,
          };
        }

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        const equipmentRows = await tx
          .select({
            slotType: schema.equipment.slotType,
            itemId: schema.equipment.itemId,
            quantity: schema.equipment.quantity,
          })
          .from(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        const persisted = normalizeCombatLoadoutSnapshot({
          inventory: inventoryRows.map((row) => {
            let metadata: Record<string, string | number | boolean> | null =
              null;
            if (row.metadata) {
              try {
                const parsed = JSON.parse(row.metadata) as unknown;
                if (parsed && typeof parsed === "object") {
                  metadata = parsed as Record<
                    string,
                    string | number | boolean
                  >;
                }
              } catch {
                throw new Error("combat_loadout_inventory_metadata_invalid");
              }
            }
            return {
              itemId: row.itemId,
              quantity: row.quantity ?? 1,
              slotIndex: row.slotIndex ?? -1,
              metadata,
            };
          }),
          equipment: equipmentRows
            .filter((row) => Boolean(row.itemId))
            .map((row) => ({
              slotType: row.slotType,
              itemId: row.itemId!,
              quantity: row.quantity ?? 1,
            })),
          selectedSpell: character.selectedSpell ?? null,
        });
        if (!combatLoadoutSnapshotsEqual(persisted, expected)) {
          throw new Error("combat_loadout_state_conflict");
        }

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.inventory.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.inventory.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }

        await tx
          .delete(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        if (committed.equipment.length > 0) {
          await tx.insert(schema.equipment).values(
            committed.equipment.map((item) => ({
              playerId,
              slotType: item.slotType,
              itemId: item.itemId,
              quantity: item.quantity,
            })),
          );
        }

        await tx
          .update(schema.characters)
          .set({ selectedSpell: committed.selectedSpell })
          .where(eq(schema.characters.id, playerId));

        if (requestedPublicActionObservation) {
          await commitRoleSwitchPublicActionObservation(
            tx,
            requestedPublicActionObservation,
            false,
          );
        }

        const operationState: StoredCombatLoadoutOperation = {
          version: 1,
          requestFingerprint,
          committed,
          ...(requestedPublicActionObservation
            ? { publicActionObservation: requestedPublicActionObservation }
            : {}),
        };
        const now = Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "combat_loadout_switch",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          committed,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /**
   * Commit one selected contestant's complete bank, inventory, equipment, and
   * autocast preparation as a single durable transition. Exact replays remain
   * readable after readiness, while every new mutation requires the active
   * database-clock preparation capability and conserves all item custody.
   */
  async commitDuelPreparationPlanOperationAsync(
    request: DuelPreparationPlanCommitRequest,
  ): Promise<DuelPreparationPlanCommitReceipt> {
    if (!this.db || !this.pool) {
      throw new Error("duel_preparation_plan_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const preparationId = String(request.preparationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    if (
      !operationId ||
      operationId.length > 256 ||
      !preparationId ||
      preparationId.length > 256 ||
      !playerId ||
      !requestFingerprint ||
      requestFingerprint.length > 512
    ) {
      throw new Error("duel_preparation_plan_request_invalid");
    }
    const expected = normalizeDuelPreparationPlanSnapshot(request.expected);
    const committed = normalizeDuelPreparationPlanSnapshot(request.committed);
    const recoveryEvidence = normalizeDuelPreparationDecisionReceiptEvidence(
      request.recoveryEvidence,
    );
    if (!duelPreparationPlanCustodyIsConserved(expected, committed)) {
      throw new Error("duel_preparation_plan_custody_violation");
    }

    return runInPostgresTransaction(
      this.pool,
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            selectedSpell: schema.characters.selectedSpell,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) {
          throw new Error("duel_preparation_plan_player_missing");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredDuelPreparationPlanOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "duel_preparation_plan" ||
            existing.completed !== true ||
            state?.version !== 3 ||
            state.preparationId !== preparationId ||
            state.requestFingerprint !== requestFingerprint ||
            JSON.stringify(
              normalizeDuelPreparationDecisionReceiptEvidence(
                state.recoveryEvidence,
              ),
            ) !== JSON.stringify(recoveryEvidence)
          ) {
            throw new Error("duel_preparation_plan_operation_id_conflict");
          }
          const replayedCommitted = normalizeDuelPreparationPlanSnapshot(
            state.committed,
          );
          if (
            !duelPreparationPlanSnapshotsEqual(replayedCommitted, committed)
          ) {
            throw new Error("duel_preparation_plan_operation_id_conflict");
          }
          return {
            operationId,
            preparationId,
            playerId,
            requestFingerprint,
            replayed: true,
            committed: replayedCommitted,
            recoveryEvidence,
          };
        }

        await tx.execute(
          sql`SELECT "preparationId" FROM "streaming_duel_preparations" WHERE "preparationId" = ${preparationId} FOR UPDATE`,
        );
        const preparationRows = await tx
          .select({
            agent1Id: schema.streamingDuelPreparations.agent1Id,
            agent2Id: schema.streamingDuelPreparations.agent2Id,
            allowedBankActions:
              schema.streamingDuelPreparations.allowedBankActions,
            status: schema.streamingDuelPreparations.status,
            expiresAt: schema.streamingDuelPreparations.expiresAt,
            agent1ReadyAt: schema.streamingDuelPreparations.agent1ReadyAt,
            agent2ReadyAt: schema.streamingDuelPreparations.agent2ReadyAt,
          })
          .from(schema.streamingDuelPreparations)
          .where(
            eq(schema.streamingDuelPreparations.preparationId, preparationId),
          );
        const preparation = preparationRows[0];
        if (!preparation) {
          throw new Error("duel_preparation_plan_preparation_not_found");
        }
        const unavailabilityRows = await tx
          .select({
            agentId:
              schema.streamingDuelPreparationUnavailabilityReports.agentId,
          })
          .from(schema.streamingDuelPreparationUnavailabilityReports)
          .where(
            eq(
              schema.streamingDuelPreparationUnavailabilityReports
                .preparationId,
              preparationId,
            ),
          )
          .limit(1);
        if (unavailabilityRows.length > 0) {
          throw new Error("duel_preparation_plan_agent_unavailable");
        }
        const clockResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const databaseNow = Number(
          (
            clockResult as unknown as {
              rows?: Array<{ databaseNow?: number | string }>;
            }
          ).rows?.[0]?.databaseNow,
        );
        if (!Number.isFinite(databaseNow)) {
          throw new Error("duel_preparation_plan_database_clock_invalid");
        }
        if (Number(preparation.expiresAt) <= databaseNow) {
          throw new Error("duel_preparation_plan_preparation_expired");
        }
        if (preparation.status !== "preparing") {
          throw new Error("duel_preparation_plan_preparation_not_active");
        }
        const isAgent1 = preparation.agent1Id === playerId;
        const isAgent2 = preparation.agent2Id === playerId;
        if (!isAgent1 && !isAgent2) {
          throw new Error("duel_preparation_plan_agent_mismatch");
        }
        if (
          (isAgent1 && preparation.agent1ReadyAt !== null) ||
          (isAgent2 && preparation.agent2ReadyAt !== null)
        ) {
          throw new Error("duel_preparation_plan_agent_ready");
        }

        const expectedBankByItem = new Map<string, number>();
        const committedBankByItem = new Map<string, number>();
        for (const row of expected.bank) {
          expectedBankByItem.set(
            row.itemId,
            (expectedBankByItem.get(row.itemId) ?? 0) + row.quantity,
          );
        }
        for (const row of committed.bank) {
          committedBankByItem.set(
            row.itemId,
            (committedBankByItem.get(row.itemId) ?? 0) + row.quantity,
          );
        }
        let requiresDeposit = false;
        let requiresWithdraw = false;
        for (const itemId of new Set([
          ...expectedBankByItem.keys(),
          ...committedBankByItem.keys(),
        ])) {
          const before = expectedBankByItem.get(itemId) ?? 0;
          const after = committedBankByItem.get(itemId) ?? 0;
          if (after > before) requiresDeposit = true;
          if (after < before) requiresWithdraw = true;
        }
        const allowedActions = new Set(preparation.allowedBankActions);
        if (
          (requiresDeposit && !allowedActions.has("deposit")) ||
          (requiresWithdraw && !allowedActions.has("withdraw"))
        ) {
          throw new Error("duel_preparation_plan_action_not_allowed");
        }

        // A pg PoolClient permits only one active query. Keep every read on the
        // same explicit transaction client and await them in order.
        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        const equipmentRows = await tx
          .select({
            slotType: schema.equipment.slotType,
            itemId: schema.equipment.itemId,
            quantity: schema.equipment.quantity,
          })
          .from(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        const bankRows = await tx
          .select({
            itemId: schema.bankStorage.itemId,
            quantity: schema.bankStorage.quantity,
            slot: schema.bankStorage.slot,
            tabIndex: schema.bankStorage.tabIndex,
          })
          .from(schema.bankStorage)
          .where(eq(schema.bankStorage.playerId, playerId));
        const persisted = normalizeDuelPreparationPlanSnapshot({
          inventory: inventoryRows.map((row) => {
            let metadata: Record<string, string | number | boolean> | null =
              null;
            if (row.metadata) {
              try {
                const parsed = JSON.parse(row.metadata) as unknown;
                if (parsed && typeof parsed === "object") {
                  metadata = parsed as Record<
                    string,
                    string | number | boolean
                  >;
                }
              } catch {
                throw new Error("duel_preparation_plan_metadata_invalid");
              }
            }
            return {
              itemId: row.itemId,
              quantity: row.quantity ?? 1,
              slotIndex: row.slotIndex ?? -1,
              metadata,
            };
          }),
          equipment: equipmentRows
            .filter((row) => Boolean(row.itemId))
            .map((row) => ({
              slotType: row.slotType,
              itemId: row.itemId!,
              quantity: row.quantity ?? 1,
            })),
          selectedSpell: character.selectedSpell ?? null,
          bank: bankRows,
        });
        if (!duelPreparationPlanSnapshotsEqual(persisted, expected)) {
          const mismatchKinds = duelPreparationPlanSnapshotMismatchKinds(
            persisted,
            expected,
          );
          throw new Error(
            `duel_preparation_plan_state_conflict:${mismatchKinds.join(",") || "unknown"}`,
          );
        }

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.inventory.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.inventory.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        await tx
          .delete(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        if (committed.equipment.length > 0) {
          await tx.insert(schema.equipment).values(
            committed.equipment.map((item) => ({
              playerId,
              slotType: item.slotType,
              itemId: item.itemId,
              quantity: item.quantity,
            })),
          );
        }
        await tx
          .delete(schema.bankStorage)
          .where(eq(schema.bankStorage.playerId, playerId));
        if (committed.bank.length > 0) {
          await tx.insert(schema.bankStorage).values(
            committed.bank.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slot: item.slot,
              tabIndex: item.tabIndex,
            })),
          );
        }
        await tx
          .update(schema.characters)
          .set({ selectedSpell: committed.selectedSpell })
          .where(eq(schema.characters.id, playerId));

        const operationState: StoredDuelPreparationPlanOperation = {
          version: 3,
          preparationId,
          requestFingerprint,
          committed,
          recoveryEvidence,
        };
        const now = databaseNow;
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "duel_preparation_plan",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });

        return {
          operationId,
          preparationId,
          playerId,
          requestFingerprint,
          replayed: false,
          committed,
          recoveryEvidence,
        };
      },
      {
        isolationLevel: "serializable",
        // Both contestants prepare concurrently and serialize on their shared
        // preparation row. PostgreSQL intentionally aborts one SSI snapshot;
        // retry the complete rolled-back transaction on a fresh connection.
        maxConflictRetries: 4,
      },
    );
  }

  /**
   * Resolve an immutable selected-contestant plan after process loss. The
   * active preparation row is checked under the same transaction so a stale or
   * terminal session cannot reopen private custody or readiness evidence. If
   * all item custody is still conserved, the receipt also repairs mutable
   * inventory/equipment slot drift before returning; missing or extra custody
   * fails the transaction instead of recreating value.
   */
  async getDuelPreparationPlanOperationAsync(
    request: DuelPreparationPlanRecoveryRequest,
  ): Promise<DuelPreparationPlanCommitReceipt | null> {
    if (!this.db || !this.pool) {
      throw new Error("duel_preparation_plan_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const preparationId = String(request.preparationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    if (
      !operationId ||
      operationId.length > 256 ||
      !preparationId ||
      preparationId.length > 256 ||
      !playerId
    ) {
      throw new Error("duel_preparation_plan_request_invalid");
    }

    return runInPostgresTransaction(
      this.pool,
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            selectedSpell: schema.characters.selectedSpell,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) return null;
        await tx.execute(
          sql`SELECT "preparationId" FROM "streaming_duel_preparations" WHERE "preparationId" = ${preparationId} FOR UPDATE`,
        );
        const preparationRows = await tx
          .select({
            agent1Id: schema.streamingDuelPreparations.agent1Id,
            agent2Id: schema.streamingDuelPreparations.agent2Id,
            status: schema.streamingDuelPreparations.status,
            expiresAt: schema.streamingDuelPreparations.expiresAt,
          })
          .from(schema.streamingDuelPreparations)
          .where(
            eq(schema.streamingDuelPreparations.preparationId, preparationId),
          );
        const preparation = preparationRows[0];
        if (
          !preparation ||
          (preparation.agent1Id !== playerId &&
            preparation.agent2Id !== playerId) ||
          !["preparing", "ready", "frozen"].includes(preparation.status)
        ) {
          return null;
        }
        const unavailabilityRows = await tx
          .select({
            agentId:
              schema.streamingDuelPreparationUnavailabilityReports.agentId,
          })
          .from(schema.streamingDuelPreparationUnavailabilityReports)
          .where(
            eq(
              schema.streamingDuelPreparationUnavailabilityReports
                .preparationId,
              preparationId,
            ),
          )
          .limit(1);
        if (unavailabilityRows.length > 0) return null;
        const clockResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const databaseNow = Number(
          (
            clockResult as unknown as {
              rows?: Array<{ databaseNow?: number | string }>;
            }
          ).rows?.[0]?.databaseNow,
        );
        if (!Number.isFinite(databaseNow)) {
          return null;
        }
        if (preparation.status === "frozen") {
          const competitiveRows = await tx
            .select({
              lifecycleStatus:
                schema.streamingDuelCompetitiveSnapshots.lifecycleStatus,
              snapshot: schema.streamingDuelCompetitiveSnapshots.snapshot,
            })
            .from(schema.streamingDuelCompetitiveSnapshots)
            .where(
              eq(
                schema.streamingDuelCompetitiveSnapshots.preparationId,
                preparationId,
              ),
            );
          const competitive = competitiveRows[0];
          const snapshot = competitive?.snapshot as
            { preparationId?: unknown; betCloseTime?: unknown } | undefined;
          if (
            competitive?.lifecycleStatus !== "frozen" ||
            snapshot?.preparationId !== preparationId ||
            !Number.isSafeInteger(snapshot.betCloseTime) ||
            Number(snapshot.betCloseTime) <= databaseNow
          ) {
            return null;
          }
        } else if (Number(preparation.expiresAt) <= databaseNow) {
          return null;
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (!existing) return null;
        const state = existing.operationState as
          StoredDuelPreparationPlanOperation | undefined;
        if (
          existing.playerId !== playerId ||
          existing.operationType !== "duel_preparation_plan" ||
          existing.completed !== true ||
          (state?.version !== 2 && state?.version !== 3) ||
          state.preparationId !== preparationId ||
          !state.requestFingerprint
        ) {
          throw new Error("duel_preparation_plan_operation_id_conflict");
        }
        const committed = normalizeDuelPreparationPlanSnapshot(state.committed);
        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        const equipmentRows = await tx
          .select({
            slotType: schema.equipment.slotType,
            itemId: schema.equipment.itemId,
            quantity: schema.equipment.quantity,
          })
          .from(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        const bankRows = await tx
          .select({
            itemId: schema.bankStorage.itemId,
            quantity: schema.bankStorage.quantity,
            slot: schema.bankStorage.slot,
            tabIndex: schema.bankStorage.tabIndex,
          })
          .from(schema.bankStorage)
          .where(eq(schema.bankStorage.playerId, playerId));
        const persisted = normalizeDuelPreparationPlanSnapshot({
          inventory: inventoryRows.map((row) => {
            let metadata: Record<string, string | number | boolean> | null =
              null;
            if (row.metadata) {
              try {
                const parsed = JSON.parse(row.metadata) as unknown;
                if (parsed && typeof parsed === "object") {
                  metadata = parsed as Record<
                    string,
                    string | number | boolean
                  >;
                }
              } catch {
                throw new Error("duel_preparation_plan_metadata_invalid");
              }
            }
            return {
              itemId: row.itemId,
              quantity: row.quantity ?? 1,
              slotIndex: row.slotIndex ?? -1,
              metadata,
            };
          }),
          equipment: equipmentRows
            .filter((row) => Boolean(row.itemId))
            .map((row) => ({
              slotType: row.slotType,
              itemId: row.itemId!,
              quantity: row.quantity ?? 1,
            })),
          selectedSpell: character.selectedSpell ?? null,
          bank: bankRows,
        });

        if (!duelPreparationPlanSnapshotsEqual(persisted, committed)) {
          // The immutable whole-plan receipt owns the pre-market custody
          // projection. Repair only location/slot drift when every item is
          // still conserved; missing or extra custody remains a hard failure.
          if (!duelPreparationPlanCustodyIsConserved(persisted, committed)) {
            throw new Error("duel_preparation_plan_recovery_custody_violation");
          }
          await tx
            .delete(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          if (committed.inventory.length > 0) {
            await tx.insert(schema.inventory).values(
              committed.inventory.map((item) => ({
                playerId,
                itemId: item.itemId,
                quantity: item.quantity,
                slotIndex: item.slotIndex,
                metadata: item.metadata ? JSON.stringify(item.metadata) : null,
              })),
            );
          }
          await tx
            .delete(schema.equipment)
            .where(eq(schema.equipment.playerId, playerId));
          if (committed.equipment.length > 0) {
            await tx.insert(schema.equipment).values(
              committed.equipment.map((item) => ({
                playerId,
                slotType: item.slotType,
                itemId: item.itemId,
                quantity: item.quantity,
              })),
            );
          }
          await tx
            .delete(schema.bankStorage)
            .where(eq(schema.bankStorage.playerId, playerId));
          if (committed.bank.length > 0) {
            await tx.insert(schema.bankStorage).values(
              committed.bank.map((item) => ({
                playerId,
                itemId: item.itemId,
                quantity: item.quantity,
                slot: item.slot,
                tabIndex: item.tabIndex,
              })),
            );
          }
          await tx
            .update(schema.characters)
            .set({ selectedSpell: committed.selectedSpell })
            .where(eq(schema.characters.id, playerId));
        }

        return {
          operationId,
          preparationId,
          playerId,
          requestFingerprint: state.requestFingerprint,
          replayed: true,
          committed,
          recoveryEvidence:
            state.version === 3
              ? normalizeDuelPreparationDecisionReceiptEvidence(
                  state.recoveryEvidence,
                )
              : normalizeDuelPreparationPlanRecoveryEvidence(
                  state.recoveryEvidence,
                ),
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /**
   * Debit several inventory item types as one durable operation. The database
   * computes the new snapshot while holding the same character-row lock used by
   * combat-loadout switches, so a spell can never consume only some of its
   * required runes or race a frozen loadout transition.
   */
  async commitInventoryDebitOperationAsync(
    request: InventoryDebitCommitRequest,
  ): Promise<InventoryDebitCommitReceipt> {
    if (!this.db) {
      throw new Error("inventory_debit_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint)
    ) {
      throw new Error("inventory_debit_request_invalid");
    }
    const requirements = normalizeInventoryDebitRequirements(
      request.requirements,
    );
    if (
      requestFingerprint !== inventoryDebitFingerprint(playerId, requirements)
    ) {
      throw new Error("inventory_debit_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        // Serialize ordinary replay with operator compaction. The compacted
        // identity remains permanent, but a replay must observe exactly one
        // stable authority (full WAL row or compact receipt) in this txn.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended('prayer-state-operation:' || ${operationId}, 0)
          )`,
        );
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!characterRows[0]) {
          throw new Error("inventory_debit_player_missing");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredInventoryDebitOperation | undefined;
          const replayedRequirements = state?.requirements
            ? normalizeInventoryDebitRequirements(state.requirements)
            : null;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "inventory_debit" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            !replayedRequirements ||
            JSON.stringify(replayedRequirements) !==
              JSON.stringify(requirements)
          ) {
            throw new Error("inventory_debit_operation_id_conflict");
          }
          // Return the current locked database snapshot, not the historical
          // post-state. Replaying an older operation after newer debits must
          // never roll live memory backward.
          const currentRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          const replayedCommitted = normalizePersistedInventoryRows(
            currentRows,
            "inventory_debit",
          );
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            requirements: replayedRequirements,
            committed: replayedCommitted,
          };
        }

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        const persisted = normalizePersistedInventoryRows(
          inventoryRows,
          "inventory_debit",
        );
        const committed = debitInventorySnapshot(persisted, requirements);

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }

        const operationState: StoredInventoryDebitOperation = {
          version: 1,
          requestFingerprint,
          requirements,
          committed,
        };
        const now = Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "inventory_debit",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          requirements,
          committed,
        };
      },
      { isolationLevel: "serializable" },
    );
  }

  /** Stage one exact spell-rune debit before projectile admission. */
  async commitProjectileRuneCostOperationAsync(
    request: ProjectileRuneCostCommitRequest,
  ): Promise<ProjectileRuneCostCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("projectile_rune_cost_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const requirements = normalizeInventoryDebitRequirements(
      request.requirements,
    );
    if (
      !/^spell-runes:[A-Za-z0-9]{20}$/.test(operationId) ||
      operationId !== request.operationId ||
      !playerId ||
      playerId !== request.playerId ||
      playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      requirements.length === 0 ||
      requirements.some((entry) => {
        const item = getItem(entry.itemId);
        return (
          !entry.itemId.endsWith("_rune") || !item || item.stackable !== true
        );
      }) ||
      requestFingerprint !== inventoryDebitFingerprint(playerId, requirements)
    ) {
      throw new Error("projectile_rune_cost_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!characterRows[0]) {
          throw new Error("projectile_rune_cost_player_missing");
        }
        const loadInventory = async () =>
          normalizePersistedInventoryRows(
            await tx
              .select({
                itemId: schema.inventory.itemId,
                quantity: schema.inventory.quantity,
                slotIndex: schema.inventory.slotIndex,
                metadata: schema.inventory.metadata,
              })
              .from(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId)),
            "projectile_rune_cost",
          );
        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredProjectileRuneCostOperation | undefined;
          const replayedRequirements = state?.requirements
            ? normalizeInventoryDebitRequirements(state.requirements)
            : null;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "projectile_rune_cost" ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            !replayedRequirements ||
            JSON.stringify(replayedRequirements) !==
              JSON.stringify(requirements) ||
            (state.status === "pending") !== (existing.completed === false) ||
            (state.status !== "pending") !== (existing.completed === true)
          ) {
            throw new Error("projectile_rune_cost_operation_id_conflict");
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            requirements: replayedRequirements,
            status: state.status,
            committed: await loadInventory(),
            refundDestination: state.refundDestination,
          };
        }

        const persisted = await loadInventory();
        const committed = debitInventorySnapshot(persisted, requirements);
        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        const operationState: StoredProjectileRuneCostOperation = {
          version: 1,
          requestFingerprint,
          requirements,
          committed,
          status: "pending",
          damageOperationId: null,
          refundDestination: null,
        };
        const nowResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const now = Number(
          databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
            ?.databaseNow,
        );
        if (!Number.isSafeInteger(now) || now < 0) {
          throw new Error("projectile_rune_cost_database_clock_invalid");
        }
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "projectile_rune_cost",
          operationState,
          completed: false,
          timestamp: now,
          completedAt: null,
        });
        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          requirements,
          status: "pending",
          committed,
          refundDestination: null,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  async completeProjectileRuneCostOperationAsync(
    request: ProjectileRuneCostSettlementRequest,
  ): Promise<ProjectileRuneCostCommitReceipt> {
    return this.settleProjectileRuneCostOperationAsync(request, "fired");
  }

  async cancelProjectileRuneCostOperationAsync(
    request: ProjectileRuneCostSettlementRequest,
  ): Promise<ProjectileRuneCostCommitReceipt> {
    return this.settleProjectileRuneCostOperationAsync(request, "cancelled");
  }

  async recoverPendingProjectileRuneCostOperationsAsync(
    playerId: string,
  ): Promise<ProjectileRuneCostCommitReceipt[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("projectile_rune_cost_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    if (!normalizedPlayerId || normalizedPlayerId.length > 128) {
      throw new Error("projectile_rune_cost_request_invalid");
    }
    const rows = await this.db
      .select({
        operationId: schema.operationsLog.id,
        operationState: schema.operationsLog.operationState,
        completed: schema.operationsLog.completed,
      })
      .from(schema.operationsLog)
      .where(
        and(
          eq(schema.operationsLog.playerId, normalizedPlayerId),
          eq(schema.operationsLog.operationType, "projectile_rune_cost"),
          or(
            eq(schema.operationsLog.completed, false),
            sql`${schema.operationsLog.operationState}->>'status' = 'fired'`,
          ),
        ),
      )
      .orderBy(schema.operationsLog.timestamp, schema.operationsLog.id);
    const pending: Array<{
      operationId: string;
      requestFingerprint: string;
    }> = [];
    for (const row of rows) {
      const state = row.operationState as
        StoredProjectileRuneCostOperation | undefined;
      if (
        state?.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(state.requestFingerprint)
      ) {
        throw new Error("projectile_rune_cost_recovery_state_invalid");
      }
      if (state.status === "fired" && row.completed === true) {
        // The cost and projectile admission are durable, but the replacement
        // cannot infer whether a missing impact should consume or restore the
        // runes. Stop before hydration until that product policy is explicit.
        throw new Error("projectile_rune_cost_fired_reconciliation_required");
      }
      if (state.status !== "pending" || row.completed !== false) {
        throw new Error("projectile_rune_cost_recovery_state_invalid");
      }
      pending.push({
        operationId: row.operationId,
        requestFingerprint: state.requestFingerprint,
      });
    }

    // Validate the complete set before refunding any staged cost. A later
    // fired receipt must not leave replacement startup partially mutated.
    const recovered: ProjectileRuneCostCommitReceipt[] = [];
    for (const operation of pending) {
      recovered.push(
        await this.cancelProjectileRuneCostOperationAsync({
          operationId: operation.operationId,
          playerId: normalizedPlayerId,
          requestFingerprint: operation.requestFingerprint,
        }),
      );
    }
    return recovered;
  }

  private async settleProjectileRuneCostOperationAsync(
    request: ProjectileRuneCostSettlementRequest,
    requestedStatus: "fired" | "cancelled",
  ): Promise<ProjectileRuneCostCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("projectile_rune_cost_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    if (
      !/^spell-runes:[A-Za-z0-9]{20}$/.test(operationId) ||
      operationId !== request.operationId ||
      !playerId ||
      playerId !== request.playerId ||
      playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint)
    ) {
      throw new Error("projectile_rune_cost_request_invalid");
    }
    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!characterRows[0]) {
          throw new Error("projectile_rune_cost_player_missing");
        }
        const operationRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = operationRows[0];
        const state = existing?.operationState as
          StoredProjectileRuneCostOperation | undefined;
        if (
          !existing ||
          existing.playerId !== playerId ||
          existing.operationType !== "projectile_rune_cost" ||
          state?.version !== 1 ||
          state.requestFingerprint !== requestFingerprint ||
          (state.status === "pending") !== (existing.completed === false) ||
          (state.status !== "pending") !== (existing.completed === true)
        ) {
          throw new Error("projectile_rune_cost_operation_id_conflict");
        }
        const loadInventory = async () =>
          normalizePersistedInventoryRows(
            await tx
              .select({
                itemId: schema.inventory.itemId,
                quantity: schema.inventory.quantity,
                slotIndex: schema.inventory.slotIndex,
                metadata: schema.inventory.metadata,
              })
              .from(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId)),
            "projectile_rune_cost",
          );
        if (
          state.status !== "pending" &&
          !(requestedStatus === "cancelled" && state.status === "fired")
        ) {
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            requirements: state.requirements,
            status: state.status,
            committed: await loadInventory(),
            refundDestination: state.refundDestination,
          };
        }

        let committed = await loadInventory();
        let inventoryRefunds = 0;
        let bankRefunds = 0;
        if (requestedStatus === "cancelled" && state.status === "pending") {
          type BankRow = {
            id: number;
            itemId: string;
            quantity: number;
            slot: number;
            tabIndex: number;
          };
          let bankRows: BankRow[] | null = null;
          for (const requirement of state.requirements) {
            try {
              committed = creditGatheringReward(
                committed,
                { ...requirement, stackable: true },
                "projectile_rune_cost_refund",
              );
              inventoryRefunds++;
              continue;
            } catch (error) {
              if (
                !(error instanceof Error) ||
                error.message !== "projectile_rune_cost_refund_inventory_full"
              ) {
                throw error;
              }
            }
            bankRows ??= await tx
              .select({
                id: schema.bankStorage.id,
                itemId: schema.bankStorage.itemId,
                quantity: schema.bankStorage.quantity,
                slot: schema.bankStorage.slot,
                tabIndex: schema.bankStorage.tabIndex,
              })
              .from(schema.bankStorage)
              .where(eq(schema.bankStorage.playerId, playerId));
            const existingStack = bankRows.find(
              (entry) => entry.itemId === requirement.itemId,
            );
            if (existingStack) {
              const next = existingStack.quantity + requirement.quantity;
              if (
                !Number.isSafeInteger(next) ||
                next > BANKING_CONSTANTS.MAX_ITEM_STACK
              ) {
                throw new Error("projectile_rune_cost_quantity_overflow");
              }
              existingStack.quantity = next;
              await tx
                .update(schema.bankStorage)
                .set({ quantity: next })
                .where(eq(schema.bankStorage.id, existingStack.id));
            } else {
              const occupied = new Set(
                bankRows.map((entry) => `${entry.tabIndex}:${entry.slot}`),
              );
              let free: { tabIndex: number; slot: number } | null = null;
              for (
                let tabIndex = 0;
                tabIndex < BANKING_CONSTANTS.MAX_TABS && !free;
                tabIndex++
              ) {
                for (
                  let slot = 0;
                  slot < BANKING_CONSTANTS.SLOTS_PER_TAB;
                  slot++
                ) {
                  if (!occupied.has(`${tabIndex}:${slot}`)) {
                    free = { tabIndex, slot };
                    break;
                  }
                }
              }
              if (!free) throw new Error("projectile_rune_cost_bank_full");
              const inserted: BankRow = {
                id: -1 - bankRows.length,
                itemId: requirement.itemId,
                quantity: requirement.quantity,
                ...free,
              };
              bankRows.push(inserted);
              await tx.insert(schema.bankStorage).values({
                playerId,
                itemId: inserted.itemId,
                quantity: inserted.quantity,
                slot: inserted.slot,
                tabIndex: inserted.tabIndex,
              });
            }
            bankRefunds++;
          }
          if (inventoryRefunds > 0) {
            await tx
              .delete(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId));
            if (committed.length > 0) {
              await tx.insert(schema.inventory).values(
                committed.map((item) => ({
                  playerId,
                  itemId: item.itemId,
                  quantity: item.quantity,
                  slotIndex: item.slotIndex,
                  metadata: item.metadata
                    ? JSON.stringify(item.metadata)
                    : null,
                })),
              );
            }
          }
        }
        const refundDestination: ProjectileRuneCostRefundDestination | null =
          state.status === "fired" || requestedStatus === "fired"
            ? null
            : inventoryRefunds > 0 && bankRefunds > 0
              ? "mixed"
              : bankRefunds > 0
                ? "bank"
                : "inventory";
        const settledState: StoredProjectileRuneCostOperation = {
          ...state,
          committed,
          status: state.status === "fired" ? "resolved" : requestedStatus,
          refundDestination,
        };
        const now = Date.now();
        await tx
          .update(schema.operationsLog)
          .set({
            operationState: settledState,
            completed: true,
            completedAt: now,
          })
          .where(eq(schema.operationsLog.id, operationId));
        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          requirements: state.requirements,
          status: state.status === "fired" ? "resolved" : requestedStatus,
          committed,
          refundDestination,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /**
   * Commit one idempotent source contribution before any world entity becomes
   * interactable. Compatible stackable contributions merge under a tile lock;
   * their individual identities remain immutable for response-loss replay.
   */
  async registerGroundItemSourceAsync(
    request: GroundItemSourceRegistrationRequest,
    existingTransaction?: NodePgDatabase<typeof schema>,
  ): Promise<GroundItemSourceRegistrationReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_source_database_unavailable");
    }
    const normalized: Omit<
      GroundItemSourceRegistrationRequest,
      "requestFingerprint"
    > = {
      contributionId: String(request.contributionId ?? "").trim(),
      preferredSourceId: String(request.preferredSourceId ?? "").trim(),
      itemId: String(request.itemId ?? "").trim(),
      quantity: Number(request.quantity),
      stackable: request.stackable,
      position: {
        x: Number(request.position?.x),
        y: Number(request.position?.y),
        z: Number(request.position?.z),
      },
      tile: {
        x: Number(request.tile?.x),
        z: Number(request.tile?.z),
      },
      droppedBy:
        request.droppedBy === null
          ? null
          : String(request.droppedBy ?? "").trim(),
      lifetimeMs: Number(request.lifetimeMs),
      lootProtectionMs: Number(request.lootProtectionMs),
      allowMerge: request.allowMerge,
    };
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const item = getItem(normalized.itemId);
    const expectedTile = worldToTile(
      normalized.position.x,
      normalized.position.z,
    );
    if (
      !GROUND_ITEM_SOURCE_CONTRIBUTION_ID_PATTERN.test(
        normalized.contributionId,
      ) ||
      !GROUND_ITEM_SOURCE_ID_PATTERN.test(normalized.preferredSourceId) ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !item ||
      !Number.isSafeInteger(normalized.quantity) ||
      normalized.quantity <= 0 ||
      normalized.quantity > MAX_PERSISTED_ITEM_QUANTITY ||
      typeof normalized.stackable !== "boolean" ||
      normalized.stackable !== (item.stackable === true) ||
      !Object.values(normalized.position).every(Number.isFinite) ||
      !Number.isSafeInteger(normalized.tile.x) ||
      !Number.isSafeInteger(normalized.tile.z) ||
      expectedTile.x !== normalized.tile.x ||
      expectedTile.z !== normalized.tile.z ||
      (normalized.droppedBy !== null &&
        (normalized.droppedBy.length < 1 ||
          normalized.droppedBy.length > 128)) ||
      !Number.isSafeInteger(normalized.lifetimeMs) ||
      normalized.lifetimeMs <= 0 ||
      !Number.isSafeInteger(normalized.lootProtectionMs) ||
      normalized.lootProtectionMs < 0 ||
      normalized.lootProtectionMs > normalized.lifetimeMs ||
      typeof normalized.allowMerge !== "boolean" ||
      requestFingerprint !== groundItemSourceRegistrationFingerprint(normalized)
    ) {
      throw new Error("ground_item_source_request_invalid");
    }

    const registerInTransaction = async (
      tx: NodePgDatabase<typeof schema>,
    ): Promise<GroundItemSourceRegistrationReceipt> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
            hashtextextended(
              'ground-item-source-merge:' || ${normalized.tile.x} || ':' ||
              ${normalized.tile.z} || ':' || ${normalized.itemId} || ':' ||
              COALESCE(${normalized.droppedBy}, '') || ':' ||
              ${normalized.lootProtectionMs > 0},
              0
            )
          )`,
      );
      const nowResult = await tx.execute(
        sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
      );
      const databaseNow = Number(
        databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
          ?.databaseNow,
      );
      if (!Number.isSafeInteger(databaseNow) || databaseNow < 0) {
        throw new Error("ground_item_source_database_clock_invalid");
      }

      const replayResult = await tx.execute(sql`
          SELECT
            contribution."request_fingerprint",
            contribution."item_id" AS "contribution_item_id",
            contribution.quantity AS "contribution_quantity",
            source.*
          FROM "ground_item_source_contributions" AS contribution
          JOIN "ground_item_sources" AS source
            ON source."source_id" = contribution."source_id"
          WHERE contribution."contribution_id" = ${normalized.contributionId}
          FOR UPDATE OF source
        `);
      const replayRows = databaseQueryRows<
        GroundItemSourceDatabaseRow & {
          request_fingerprint: string;
          contribution_item_id: string;
          contribution_quantity: number | string;
        }
      >(replayResult);
      const replay = replayRows[0];
      if (replay) {
        if (
          replay.request_fingerprint !== requestFingerprint ||
          replay.contribution_item_id !== normalized.itemId ||
          Number(replay.contribution_quantity) !== normalized.quantity
        ) {
          throw new Error("ground_item_source_contribution_id_conflict");
        }
        return {
          ...parseGroundItemSourceDatabaseRow(replay),
          contributionId: normalized.contributionId,
          requestFingerprint,
          replayed: true,
        };
      }

      let source: GroundItemSourceState | null = null;
      if (normalized.allowMerge && normalized.stackable) {
        const mergeResult = await tx.execute(sql`
            SELECT *
            FROM "ground_item_sources"
            WHERE status = 'active'
              AND "expires_at" > ${databaseNow}
              AND "tile_x" = ${normalized.tile.x}
              AND "tile_z" = ${normalized.tile.z}
              AND "item_id" = ${normalized.itemId}
              AND stackable = true
              AND "dropped_by" IS NOT DISTINCT FROM ${normalized.droppedBy}
              AND (
                (${normalized.lootProtectionMs} = 0 AND (
                  "loot_protection_expires_at" IS NULL OR
                  "loot_protection_expires_at" <= ${databaseNow}
                )) OR
                (${normalized.lootProtectionMs} > 0 AND
                  "loot_protection_expires_at" IS NOT NULL)
              )
            ORDER BY "source_id"
            LIMIT 1
            FOR UPDATE
          `);
        const mergeRow =
          databaseQueryRows<GroundItemSourceDatabaseRow>(mergeResult)[0];
        if (mergeRow) source = parseGroundItemSourceDatabaseRow(mergeRow);
      }

      const requestedExpiresAt = databaseNow + normalized.lifetimeMs;
      const requestedProtectionExpiresAt =
        normalized.lootProtectionMs > 0
          ? databaseNow + normalized.lootProtectionMs
          : null;
      if (
        !Number.isSafeInteger(requestedExpiresAt) ||
        (requestedProtectionExpiresAt !== null &&
          !Number.isSafeInteger(requestedProtectionExpiresAt))
      ) {
        throw new Error("ground_item_source_lifetime_overflow");
      }

      if (source) {
        const quantity = source.quantity + normalized.quantity;
        if (
          !Number.isSafeInteger(quantity) ||
          quantity > MAX_PERSISTED_ITEM_QUANTITY
        ) {
          throw new Error("ground_item_source_quantity_overflow");
        }
        const lootProtectionExpiresAt =
          requestedProtectionExpiresAt === null
            ? source.lootProtectionExpiresAt
            : Math.max(
                source.lootProtectionExpiresAt ?? 0,
                requestedProtectionExpiresAt,
              );
        const expiresAt = Math.max(source.expiresAt, requestedExpiresAt);
        await tx
          .update(schema.groundItemSources)
          .set({
            quantity,
            updatedAt: databaseNow,
            expiresAt,
            lootProtectionExpiresAt,
            version: source.version + 1,
          })
          .where(
            and(
              eq(schema.groundItemSources.sourceId, source.sourceId),
              eq(schema.groundItemSources.status, "active"),
            ),
          );
        source = {
          ...source,
          quantity,
          updatedAt: databaseNow,
          expiresAt,
          lootProtectionExpiresAt,
          version: source.version + 1,
        };
      } else {
        source = {
          sourceId: normalized.preferredSourceId,
          status: "active",
          itemId: normalized.itemId,
          quantity: normalized.quantity,
          stackable: normalized.stackable,
          position: normalized.position,
          tile: normalized.tile,
          droppedBy: normalized.droppedBy,
          createdAt: databaseNow,
          updatedAt: databaseNow,
          expiresAt: requestedExpiresAt,
          lootProtectionExpiresAt: requestedProtectionExpiresAt,
          version: 1,
        };
        await tx.insert(schema.groundItemSources).values({
          sourceId: source.sourceId,
          status: source.status,
          itemId: source.itemId,
          quantity: source.quantity,
          stackable: source.stackable,
          positionX: source.position.x,
          positionY: source.position.y,
          positionZ: source.position.z,
          tileX: source.tile.x,
          tileZ: source.tile.z,
          droppedBy: source.droppedBy,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          expiresAt: source.expiresAt,
          lootProtectionExpiresAt: source.lootProtectionExpiresAt,
          version: source.version,
        });
      }

      await tx.insert(schema.groundItemSourceContributions).values({
        contributionId: normalized.contributionId,
        sourceId: source.sourceId,
        requestFingerprint,
        itemId: normalized.itemId,
        quantity: normalized.quantity,
        contributedAt: databaseNow,
      });
      return {
        ...source,
        contributionId: normalized.contributionId,
        requestFingerprint,
        replayed: false,
      };
    };
    if (existingTransaction) {
      return registerInTransaction(existingTransaction);
    }
    return this.executeInTransaction(registerInTransaction, {
      isolationLevel: "serializable",
    });
  }

  /** Commit a multi-item drop as one all-or-nothing registry transaction. */
  async registerGroundItemSourcesAsync(
    requests: GroundItemSourceRegistrationRequest[],
  ): Promise<GroundItemSourceRegistrationReceipt[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_source_database_unavailable");
    }
    if (
      !Array.isArray(requests) ||
      requests.length < 1 ||
      requests.length > 128
    ) {
      throw new Error("ground_item_source_batch_invalid");
    }
    const contributionIds = new Set<string>();
    for (const request of requests) {
      const contributionId = String(request?.contributionId ?? "").trim();
      if (contributionIds.has(contributionId)) {
        throw new Error("ground_item_source_batch_duplicate_contribution");
      }
      contributionIds.add(contributionId);
    }
    const ordered = requests
      .map((request, index) => ({ request, index }))
      .sort((left, right) => {
        const leftKey = JSON.stringify([
          left.request.tile?.x,
          left.request.tile?.z,
          left.request.itemId,
          left.request.droppedBy,
          Number(left.request.lootProtectionMs) > 0,
        ]);
        const rightKey = JSON.stringify([
          right.request.tile?.x,
          right.request.tile?.z,
          right.request.itemId,
          right.request.droppedBy,
          Number(right.request.lootProtectionMs) > 0,
        ]);
        return leftKey.localeCompare(rightKey) || left.index - right.index;
      });
    return this.executeInTransaction(
      async (tx) => {
        const receipts = new Array<GroundItemSourceRegistrationReceipt>(
          requests.length,
        );
        for (const entry of ordered) {
          receipts[entry.index] = await this.registerGroundItemSourceAsync(
            entry.request,
            tx,
          );
        }
        return receipts;
      },
      { isolationLevel: "serializable" },
    );
  }

  /** Co-commit one owned inventory/coin debit and its durable ground source. */
  async commitGroundItemDropOperationAsync(
    request: GroundItemDropCommitRequest,
  ): Promise<GroundItemDropCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_drop_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const itemId = String(request.itemId ?? "").trim();
    const quantity = Number(request.quantity);
    const slotIndex =
      request.slotIndex === null ? null : Number(request.slotIndex);
    const item = getItem(itemId);
    const normalized: Omit<GroundItemDropCommitRequest, "requestFingerprint"> =
      {
        operationId,
        playerId,
        itemId,
        quantity,
        slotIndex,
        source: request.source,
      };
    if (
      !/^ground-item-drop:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operationId,
      ) ||
      !playerId ||
      playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !item ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY ||
      (slotIndex !== null &&
        (!Number.isSafeInteger(slotIndex) ||
          slotIndex < 0 ||
          slotIndex >= 28)) ||
      (itemId === "coins" && slotIndex !== null) ||
      !request.source ||
      request.source.itemId !== itemId ||
      request.source.quantity !== quantity ||
      request.source.stackable !== (item.stackable === true) ||
      request.source.droppedBy !== playerId ||
      request.source.lootProtectionMs !== 0 ||
      requestFingerprint !== groundItemDropFingerprint(normalized)
    ) {
      throw new Error("ground_item_drop_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended('ground-item-drop-operation:' || ${operationId}, 0)
          )`,
        );
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id, coins: schema.characters.coins })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        const currentCoins = Number(character?.coins);
        if (
          !character ||
          !Number.isSafeInteger(currentCoins) ||
          currentCoins < 0 ||
          currentCoins > MAX_PERSISTED_ITEM_QUANTITY
        ) {
          throw new Error(
            character
              ? "ground_item_drop_coin_state_invalid"
              : "ground_item_drop_player_missing",
          );
        }

        const currentInventory = async (): Promise<CommittedInventoryItem[]> =>
          normalizePersistedInventoryRows(
            await tx
              .select({
                itemId: schema.inventory.itemId,
                quantity: schema.inventory.quantity,
                slotIndex: schema.inventory.slotIndex,
                metadata: schema.inventory.metadata,
              })
              .from(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId)),
            "ground_item_drop",
          );

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredGroundItemDropOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "ground_item_drop" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.itemId !== itemId ||
            state.quantity !== quantity ||
            state.slotIndex !== slotIndex ||
            state.sourceContributionId !== request.source.contributionId ||
            state.sourceRequestFingerprint !==
              request.source.requestFingerprint ||
            (state.operationCommittedCoins !== null &&
              (!Number.isSafeInteger(state.operationCommittedCoins) ||
                state.operationCommittedCoins < 0 ||
                state.operationCommittedCoins > MAX_PERSISTED_ITEM_QUANTITY)) ||
            (itemId === "coins") !== (state.operationCommittedCoins !== null)
          ) {
            throw new Error("ground_item_drop_operation_id_conflict");
          }
          const source = await this.registerGroundItemSourceAsync(
            request.source,
            tx,
          );
          if (source.sourceId !== state.sourceId || !source.replayed) {
            throw new Error("ground_item_drop_source_receipt_invalid");
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            itemId,
            quantity,
            slotIndex,
            operationCommittedCoins: state.operationCommittedCoins,
            currentCoins,
            committed: await currentInventory(),
            source,
          };
        }

        let committed = await currentInventory();
        let operationCommittedCoins: number | null = null;
        let coinsAfter = currentCoins;
        if (itemId === "coins") {
          if (currentCoins < quantity) {
            throw new Error("ground_item_drop_insufficient_coins");
          }
          coinsAfter = currentCoins - quantity;
          operationCommittedCoins = coinsAfter;
        } else {
          committed = debitGroundItemDropSnapshot(
            committed,
            itemId,
            quantity,
            slotIndex,
          );
        }

        const source = await this.registerGroundItemSourceAsync(
          request.source,
          tx,
        );
        if (source.replayed) {
          throw new Error("ground_item_drop_source_preexisting");
        }

        if (itemId === "coins") {
          await tx
            .update(schema.characters)
            .set({ coins: coinsAfter })
            .where(eq(schema.characters.id, playerId));
        } else {
          await tx
            .delete(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          if (committed.length > 0) {
            await tx.insert(schema.inventory).values(
              committed.map((entry) => ({
                playerId,
                itemId: entry.itemId,
                quantity: entry.quantity,
                slotIndex: entry.slotIndex,
                metadata: entry.metadata
                  ? JSON.stringify(entry.metadata)
                  : null,
              })),
            );
          }
        }

        const operationState: StoredGroundItemDropOperation = {
          version: 1,
          requestFingerprint,
          itemId,
          quantity,
          slotIndex,
          sourceContributionId: request.source.contributionId,
          sourceRequestFingerprint: request.source.requestFingerprint,
          sourceId: source.sourceId,
          operationCommittedCoins,
        };
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "ground_item_drop",
          operationState,
          completed: true,
          timestamp: source.updatedAt,
          completedAt: source.updatedAt,
        });
        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          itemId,
          quantity,
          slotIndex,
          operationCommittedCoins,
          currentCoins: coinsAfter,
          committed,
          source,
        };
      },
      { isolationLevel: "serializable" },
    );
  }

  /** Co-commit a public-zone death clear, lock, receipt, and every source. */
  async commitGroundItemDeathOperationAsync(
    request: GroundItemDeathCommitRequest,
  ): Promise<GroundItemDeathCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_death_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const deathTimestamp = Number(request.deathTimestamp);
    const position = {
      x: Number(request.position?.x),
      y: Number(request.position?.y),
      z: Number(request.position?.z),
    };
    const killedBy = String(request.killedBy ?? "").trim();
    const zoneType = request.zoneType;
    const sources = Array.isArray(request.sources) ? request.sources : [];
    const normalized: Omit<GroundItemDeathCommitRequest, "requestFingerprint"> =
      {
        operationId,
        playerId,
        deathTimestamp,
        position,
        killedBy,
        zoneType,
        sources,
      };
    const contributionIds = new Set<string>();
    if (
      !/^ground-item-death:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operationId,
      ) ||
      !playerId ||
      playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !Number.isSafeInteger(deathTimestamp) ||
      deathTimestamp <= 0 ||
      !Object.values(position).every(Number.isFinite) ||
      Math.abs(position.x) > 10_000 ||
      Math.abs(position.z) > 10_000 ||
      position.y < -500 ||
      position.y > 500 ||
      isPositionInsideDuelArenaZone(position.x, position.z) ||
      !killedBy ||
      killedBy.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(killedBy) ||
      (zoneType !== "wilderness" && zoneType !== "pvp_zone") ||
      sources.length > 128 ||
      requestFingerprint !== groundItemDeathFingerprint(normalized)
    ) {
      throw new Error("ground_item_death_request_invalid");
    }
    for (const source of sources) {
      const contributionId = String(source?.contributionId ?? "").trim();
      if (
        contributionIds.has(contributionId) ||
        source?.droppedBy !== playerId ||
        !Number.isSafeInteger(source?.lootProtectionMs) ||
        source.lootProtectionMs <= 0 ||
        !source.position ||
        !Object.values(source.position).every(Number.isFinite) ||
        isPositionInsideDuelArenaZone(source.position.x, source.position.z)
      ) {
        throw new Error("ground_item_death_source_invalid");
      }
      contributionIds.add(contributionId);
    }

    const ordered = sources
      .map((source, index) => ({ source, index }))
      .sort((left, right) => {
        const leftKey = JSON.stringify([
          left.source.tile?.x,
          left.source.tile?.z,
          left.source.itemId,
          left.source.droppedBy,
          Number(left.source.lootProtectionMs) > 0,
        ]);
        const rightKey = JSON.stringify([
          right.source.tile?.x,
          right.source.tile?.z,
          right.source.itemId,
          right.source.droppedBy,
          Number(right.source.lootProtectionMs) > 0,
        ]);
        return leftKey.localeCompare(rightKey) || left.index - right.index;
      });

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended('ground-item-death-operation:' || ${operationId}, 0)
          )`,
        );
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!characterRows[0]) {
          throw new Error("ground_item_death_player_missing");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredGroundItemDeathOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "ground_item_death" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.deathTimestamp !== deathTimestamp ||
            JSON.stringify(state.position) !== JSON.stringify(position) ||
            state.killedBy !== killedBy ||
            state.zoneType !== zoneType ||
            JSON.stringify(state.sourceContributionIds) !==
              JSON.stringify(sources.map((source) => source.contributionId)) ||
            JSON.stringify(state.sourceRequestFingerprints) !==
              JSON.stringify(
                sources.map((source) => source.requestFingerprint),
              ) ||
            state.sourceIds.length !== sources.length
          ) {
            throw new Error("ground_item_death_operation_id_conflict");
          }
          const receipts = new Array<GroundItemSourceRegistrationReceipt>(
            sources.length,
          );
          for (const entry of ordered) {
            receipts[entry.index] = await this.registerGroundItemSourceAsync(
              entry.source,
              tx,
            );
          }
          if (
            receipts.some(
              (receipt, index) =>
                !receipt.replayed ||
                receipt.sourceId !== state.sourceIds[index],
            )
          ) {
            throw new Error("ground_item_death_source_receipt_invalid");
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            deathTimestamp,
            position,
            killedBy,
            zoneType,
            dropped: normalizeDeathCustodyItems(
              state.dropped,
              "ground_item_death",
            ),
            sources: receipts,
          };
        }

        const activeDeath = await tx
          .select({ playerId: schema.playerDeaths.playerId })
          .from(schema.playerDeaths)
          .where(eq(schema.playerDeaths.playerId, playerId));
        if (activeDeath[0]) {
          throw new Error("ground_item_death_active_lock_exists");
        }
        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        const equipmentRows = await tx
          .select({
            itemId: schema.equipment.itemId,
            quantity: schema.equipment.quantity,
          })
          .from(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        const persistedInventory = normalizePersistedInventoryRows(
          inventoryRows,
          "ground_item_death",
        );
        const dropped = normalizeDeathCustodyItems(
          [
            ...persistedInventory.map((item) => ({
              itemId: item.itemId,
              quantity: item.quantity,
            })),
            ...equipmentRows
              .filter((item) => Boolean(item.itemId))
              .map((item) => ({
                itemId: item.itemId!,
                quantity: item.quantity ?? 1,
              })),
          ],
          "ground_item_death",
        );
        const requestedDrops = normalizeDeathCustodyItems(
          sources.map((source) => ({
            itemId: source.itemId,
            quantity: source.quantity,
          })),
          "ground_item_death",
        );
        if (JSON.stringify(dropped) !== JSON.stringify(requestedDrops)) {
          throw new Error("ground_item_death_custody_mismatch");
        }

        const receipts = new Array<GroundItemSourceRegistrationReceipt>(
          sources.length,
        );
        for (const entry of ordered) {
          receipts[entry.index] = await this.registerGroundItemSourceAsync(
            entry.source,
            tx,
          );
        }
        if (receipts.some((receipt) => receipt.replayed)) {
          throw new Error("ground_item_death_source_preexisting");
        }

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        await tx
          .delete(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));

        const sourceIds = receipts.map((receipt) => receipt.sourceId);
        const operationState: StoredGroundItemDeathOperation = {
          version: 1,
          requestFingerprint,
          deathTimestamp,
          position,
          killedBy,
          zoneType,
          dropped,
          sourceContributionIds: sources.map((source) => source.contributionId),
          sourceRequestFingerprints: sources.map(
            (source) => source.requestFingerprint,
          ),
          sourceIds,
        };
        const now =
          receipts.length > 0
            ? receipts.reduce(
                (latest, receipt) => Math.max(latest, receipt.updatedAt),
                0,
              )
            : Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "ground_item_death",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });
        if (dropped.length > 0) {
          await tx.insert(schema.playerDeaths).values({
            playerId,
            gravestoneId: null,
            groundItemIds: JSON.stringify([...new Set(sourceIds)]),
            position: JSON.stringify(position),
            timestamp: deathTimestamp,
            zoneType,
            itemCount: dropped.length,
            items: dropped,
            keptItems: [],
            deathOperationId: operationId,
            killedBy,
            recovered: false,
            createdAt: now,
            updatedAt: now,
          });
        }
        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          deathTimestamp,
          position,
          killedBy,
          zoneType,
          dropped,
          sources: receipts,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /** Co-commit one authenticated mob-death loot roll and every source. */
  async commitGroundItemMobLootOperationAsync(
    request: GroundItemMobLootCommitRequest,
  ): Promise<GroundItemMobLootCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_mob_loot_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const killedBy = String(request.killedBy ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const mobId = String(request.mobId ?? "").trim();
    const mobType = String(request.mobType ?? "").trim();
    const deathTimestamp = Number(request.deathTimestamp);
    const position = {
      x: Number(request.position?.x),
      y: Number(request.position?.y),
      z: Number(request.position?.z),
    };
    const killToken = String(request.killToken ?? "").trim();
    const attackStyle = String(request.attackStyle ?? "").trim();
    const damageDealt = Number(request.damageDealt);
    const sources = Array.isArray(request.sources) ? request.sources : [];
    const identity: Omit<
      GroundItemMobLootCommitRequest,
      "requestFingerprint" | "sources"
    > = {
      operationId,
      killedBy,
      mobId,
      mobType,
      deathTimestamp,
      position,
      killToken,
      attackStyle,
      damageDealt,
    };
    if (
      !/^ground-item-mob-loot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operationId,
      ) ||
      !killedBy ||
      killedBy.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(killedBy) ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !mobId ||
      mobId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(mobId) ||
      !mobType ||
      mobType.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(mobType) ||
      !Number.isSafeInteger(deathTimestamp) ||
      deathTimestamp <= 0 ||
      !Object.values(position).every(Number.isFinite) ||
      Math.abs(position.x) > 10_000 ||
      Math.abs(position.z) > 10_000 ||
      position.y < -500 ||
      position.y > 500 ||
      isPositionInsideDuelArenaZone(position.x, position.z) ||
      !/^[a-f0-9]{64}$/.test(killToken) ||
      !MOB_COMBAT_KILL_STYLES.has(attackStyle) ||
      !Number.isSafeInteger(damageDealt) ||
      damageDealt <= 0 ||
      damageDealt > MAX_MOB_COMBAT_DAMAGE ||
      sources.length > 64 ||
      requestFingerprint !== groundItemMobLootFingerprint(identity)
    ) {
      throw new Error("ground_item_mob_loot_request_invalid");
    }
    if (
      !(await validateKillTokenSignature(
        mobId,
        killedBy,
        deathTimestamp,
        killToken,
        operationId,
        attackStyle,
        damageDealt,
      ))
    ) {
      throw new Error("ground_item_mob_loot_kill_authority_invalid");
    }

    const contributionIds = new Set<string>();
    for (const source of sources) {
      const contributionId = String(source?.contributionId ?? "").trim();
      if (
        !contributionId ||
        contributionIds.has(contributionId) ||
        source?.droppedBy !== killedBy ||
        !Number.isSafeInteger(source?.lootProtectionMs) ||
        source.lootProtectionMs <= 0 ||
        !source.position ||
        !Object.values(source.position).every(Number.isFinite) ||
        isPositionInsideDuelArenaZone(source.position.x, source.position.z)
      ) {
        throw new Error("ground_item_mob_loot_source_invalid");
      }
      contributionIds.add(contributionId);
    }
    const combatXpAwards = mobCombatXpAmounts(attackStyle, damageDealt);
    if (
      combatXpAwards.length === 0 ||
      combatXpAwards.length > 4 ||
      combatXpAwards.some(
        ({ xpAmount }) =>
          !Number.isSafeInteger(xpAmount) ||
          xpAmount <= 0 ||
          xpAmount > 1_000_000,
      )
    ) {
      throw new Error("ground_item_mob_loot_combat_xp_invalid");
    }

    const orderSources = (values: GroundItemSourceRegistrationRequest[]) =>
      values
        .map((source, index) => ({ source, index }))
        .sort((left, right) => {
          const leftKey = JSON.stringify([
            left.source.tile?.x,
            left.source.tile?.z,
            left.source.itemId,
            left.source.droppedBy,
            Number(left.source.lootProtectionMs) > 0,
          ]);
          const rightKey = JSON.stringify([
            right.source.tile?.x,
            right.source.tile?.z,
            right.source.itemId,
            right.source.droppedBy,
            Number(right.source.lootProtectionMs) > 0,
          ]);
          return leftKey.localeCompare(rightKey) || left.index - right.index;
        });

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended('ground-item-mob-loot-operation:' || ${operationId}, 0)
          )`,
        );
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${killedBy} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            attackXp: schema.characters.attackXp,
            attackLevel: schema.characters.attackLevel,
            strengthXp: schema.characters.strengthXp,
            strengthLevel: schema.characters.strengthLevel,
            defenseXp: schema.characters.defenseXp,
            defenseLevel: schema.characters.defenseLevel,
            constitutionXp: schema.characters.constitutionXp,
            constitutionLevel: schema.characters.constitutionLevel,
            rangedXp: schema.characters.rangedXp,
            rangedLevel: schema.characters.rangedLevel,
            magicXp: schema.characters.magicXp,
            magicLevel: schema.characters.magicLevel,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, killedBy));
        const character = characterRows[0];
        if (!character) {
          throw new Error("ground_item_mob_loot_killer_missing");
        }
        const persistedCombatProgress: Record<
          MobCombatProgressSkill,
          { xp: number; level: number }
        > = {
          attack: {
            xp: Number(character.attackXp),
            level: Number(character.attackLevel),
          },
          strength: {
            xp: Number(character.strengthXp),
            level: Number(character.strengthLevel),
          },
          defense: {
            xp: Number(character.defenseXp),
            level: Number(character.defenseLevel),
          },
          constitution: {
            xp: Number(character.constitutionXp),
            level: Number(character.constitutionLevel),
          },
          ranged: {
            xp: Number(character.rangedXp),
            level: Number(character.rangedLevel),
          },
          magic: {
            xp: Number(character.magicXp),
            level: Number(character.magicLevel),
          },
        };
        if (
          combatXpAwards.some(({ skill }) => {
            const progress = persistedCombatProgress[skill];
            return (
              !Number.isSafeInteger(progress.xp) ||
              progress.xp < 0 ||
              progress.xp > MAX_SKILL_XP ||
              !Number.isSafeInteger(progress.level) ||
              progress.level < 1 ||
              progress.level > 99 ||
              skillLevelForXp(progress.xp) !== progress.level
            );
          })
        ) {
          throw new Error("ground_item_mob_loot_combat_state_invalid");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredGroundItemMobLootOperation | undefined;
          if (
            existing.playerId !== killedBy ||
            existing.operationType !== "ground_item_mob_loot" ||
            existing.completed !== true ||
            state?.version !== 2 ||
            state.requestFingerprint !== requestFingerprint ||
            state.mobId !== mobId ||
            state.mobType !== mobType ||
            state.deathTimestamp !== deathTimestamp ||
            JSON.stringify(state.position) !== JSON.stringify(position) ||
            state.killToken !== killToken ||
            state.attackStyle !== attackStyle ||
            state.damageDealt !== damageDealt ||
            !Array.isArray(state.combatProgress) ||
            state.combatProgress.length !== combatXpAwards.length ||
            state.combatProgress.some((progress, index) => {
              const expected = combatXpAwards[index];
              return (
                !expected ||
                progress.skill !== expected.skill ||
                progress.xpAmount !== expected.xpAmount ||
                !Number.isSafeInteger(progress.awardedXp) ||
                progress.awardedXp < 0 ||
                progress.awardedXp > progress.xpAmount ||
                !Number.isSafeInteger(progress.operationCommittedXp) ||
                progress.operationCommittedXp < progress.awardedXp ||
                progress.operationCommittedXp > MAX_SKILL_XP ||
                persistedCombatProgress[progress.skill].xp <
                  progress.operationCommittedXp
              );
            }) ||
            !Array.isArray(state.sources) ||
            !Array.isArray(state.sourceIds) ||
            state.sources.length !== state.sourceIds.length
          ) {
            throw new Error("ground_item_mob_loot_operation_id_conflict");
          }
          const storedDropped = normalizeDeathCustodyItems(
            state.sources.map((source) => ({
              itemId: source.itemId,
              quantity: source.quantity,
            })),
            "ground_item_mob_loot",
          );
          if (
            new Set(state.sources.map((source) => source.contributionId))
              .size !== state.sources.length ||
            JSON.stringify(storedDropped) !==
              JSON.stringify(
                normalizeDeathCustodyItems(
                  state.dropped,
                  "ground_item_mob_loot",
                ),
              )
          ) {
            throw new Error("ground_item_mob_loot_operation_id_conflict");
          }
          const receipts = new Array<GroundItemSourceRegistrationReceipt>(
            state.sources.length,
          );
          for (const entry of orderSources(state.sources)) {
            receipts[entry.index] = await this.registerGroundItemSourceAsync(
              entry.source,
              tx,
            );
          }
          if (
            receipts.some(
              (receipt, index) =>
                !receipt.replayed ||
                receipt.sourceId !== state.sourceIds[index],
            )
          ) {
            throw new Error("ground_item_mob_loot_source_receipt_invalid");
          }
          const combatProgress = state.combatProgress.map((progress) => {
            const current = persistedCombatProgress[progress.skill];
            return {
              ...progress,
              currentXp: current.xp,
              currentLevel: current.level,
            };
          });
          return {
            operationId,
            killedBy,
            requestFingerprint,
            replayed: true,
            mobId,
            mobType,
            deathTimestamp,
            position,
            killToken,
            attackStyle,
            damageDealt,
            combatProgress,
            dropped: storedDropped,
            sources: receipts,
          };
        }

        const receipts = new Array<GroundItemSourceRegistrationReceipt>(
          sources.length,
        );
        for (const entry of orderSources(sources)) {
          receipts[entry.index] = await this.registerGroundItemSourceAsync(
            entry.source,
            tx,
          );
        }
        if (receipts.some((receipt) => receipt.replayed)) {
          throw new Error("ground_item_mob_loot_source_preexisting");
        }

        const dropped = normalizeDeathCustodyItems(
          sources.map((source) => ({
            itemId: source.itemId,
            quantity: source.quantity,
          })),
          "ground_item_mob_loot",
        );
        const storedSources = sources.map((source) => ({
          ...source,
          position: { ...source.position },
          tile: { ...source.tile },
        }));
        const sourceIds = receipts.map((receipt) => receipt.sourceId);
        const combatProgress = combatXpAwards.map(({ skill, xpAmount }) => {
          const before = persistedCombatProgress[skill];
          const operationCommittedXp = Math.min(
            before.xp + xpAmount,
            MAX_SKILL_XP,
          );
          return {
            skill,
            xpAmount,
            awardedXp: operationCommittedXp - before.xp,
            operationCommittedXp,
            currentXp: operationCommittedXp,
            currentLevel: skillLevelForXp(operationCommittedXp),
          } satisfies MobCombatProgressReceipt;
        });
        type CharacterCombatUpdate = Partial<
          Omit<typeof schema.characters.$inferInsert, "id" | "accountId">
        >;
        const combatUpdate: CharacterCombatUpdate = {};
        for (const progress of combatProgress) {
          switch (progress.skill) {
            case "attack":
              combatUpdate.attackXp = progress.currentXp;
              combatUpdate.attackLevel = progress.currentLevel;
              break;
            case "strength":
              combatUpdate.strengthXp = progress.currentXp;
              combatUpdate.strengthLevel = progress.currentLevel;
              break;
            case "defense":
              combatUpdate.defenseXp = progress.currentXp;
              combatUpdate.defenseLevel = progress.currentLevel;
              break;
            case "constitution":
              combatUpdate.constitutionXp = progress.currentXp;
              combatUpdate.constitutionLevel = progress.currentLevel;
              break;
            case "ranged":
              combatUpdate.rangedXp = progress.currentXp;
              combatUpdate.rangedLevel = progress.currentLevel;
              break;
            case "magic":
              combatUpdate.magicXp = progress.currentXp;
              combatUpdate.magicLevel = progress.currentLevel;
              break;
          }
        }
        await tx
          .update(schema.characters)
          .set(combatUpdate)
          .where(eq(schema.characters.id, killedBy));
        const operationState: StoredGroundItemMobLootOperation = {
          version: 2,
          requestFingerprint,
          mobId,
          mobType,
          deathTimestamp,
          position,
          killToken,
          attackStyle,
          damageDealt,
          combatProgress: combatProgress.map(
            ({ skill, xpAmount, awardedXp, operationCommittedXp }) => ({
              skill,
              xpAmount,
              awardedXp,
              operationCommittedXp,
            }),
          ),
          dropped,
          sources: storedSources,
          sourceIds,
        };
        let now = receipts.reduce(
          (latest, receipt) => Math.max(latest, receipt.updatedAt),
          0,
        );
        if (receipts.length === 0) {
          const nowResult = await tx.execute(
            sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
          );
          now = Number(
            databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
              ?.databaseNow,
          );
          if (!Number.isSafeInteger(now) || now < 0) {
            throw new Error("ground_item_mob_loot_database_clock_invalid");
          }
        }
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId: killedBy,
          operationType: "ground_item_mob_loot",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });
        const activeQuestRows = await tx
          .select({
            questId: schema.questProgress.questId,
            currentStage: schema.questProgress.currentStage,
            startedAt: schema.questProgress.startedAt,
          })
          .from(schema.questProgress)
          .where(
            and(
              eq(schema.questProgress.playerId, killedBy),
              eq(schema.questProgress.status, "in_progress"),
            ),
          );
        const questContexts = activeQuestRows.map((row) => ({
          questId: String(row.questId ?? "").trim(),
          currentStage: String(row.currentStage ?? "").trim(),
          startedAt: Number(row.startedAt),
        }));
        if (
          questContexts.some(
            (context) =>
              !context.questId ||
              context.questId.length > 256 ||
              !context.currentStage ||
              context.currentStage.length > 256 ||
              !Number.isSafeInteger(context.startedAt) ||
              context.startedAt < 0,
          )
        ) {
          throw new Error("ground_item_mob_loot_quest_state_invalid");
        }
        if (questContexts.length > 0) {
          await tx.insert(schema.questKillProgressReceipts).values(
            questContexts.map((context) => ({
              operationId,
              playerId: killedBy,
              questId: context.questId,
              questStartedAt: context.startedAt,
              capturedStage: context.currentStage,
              mobId,
              mobType,
              quantity: 1,
              createdAt: now,
            })),
          );
        }
        return {
          operationId,
          killedBy,
          requestFingerprint,
          replayed: false,
          mobId,
          mobType,
          deathTimestamp,
          position,
          killToken,
          attackStyle,
          damageDealt,
          combatProgress,
          dropped,
          sources: receipts,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /** Reconstruct only sources whose database-owned lifetime remains active. */
  async listActiveGroundItemSourcesAsync(): Promise<GroundItemSourceState[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_source_database_unavailable");
    }
    return this.executeInTransaction(
      async (tx) => {
        const nowResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const databaseNow = Number(
          databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
            ?.databaseNow,
        );
        if (!Number.isSafeInteger(databaseNow) || databaseNow < 0) {
          throw new Error("ground_item_source_database_clock_invalid");
        }
        await tx
          .update(schema.groundItemSources)
          .set({
            status: "expired",
            updatedAt: databaseNow,
            version: sql`${schema.groundItemSources.version} + 1`,
          })
          .where(
            and(
              eq(schema.groundItemSources.status, "active"),
              lte(schema.groundItemSources.expiresAt, databaseNow),
            ),
          );
        const result = await tx.execute(sql`
          SELECT * FROM "ground_item_sources"
          WHERE status = 'active' AND "expires_at" > ${databaseNow}
          ORDER BY "created_at", "source_id"
        `);
        return databaseQueryRows<GroundItemSourceDatabaseRow>(result).map(
          parseGroundItemSourceDatabaseRow,
        );
      },
      { isolationLevel: "serializable" },
    );
  }

  /** Expire one source only when its database-owned deadline has elapsed. */
  async expireGroundItemSourceAsync(sourceId: string): Promise<boolean> {
    const normalizedSourceId = String(sourceId ?? "").trim();
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_source_database_unavailable");
    }
    if (!GROUND_ITEM_SOURCE_ID_PATTERN.test(normalizedSourceId)) {
      throw new Error("ground_item_source_request_invalid");
    }
    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended('ground-item-pickup-source:' || ${normalizedSourceId}, 0)
          )`,
        );
        const nowResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const databaseNow = Number(
          databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
            ?.databaseNow,
        );
        if (!Number.isSafeInteger(databaseNow) || databaseNow < 0) {
          throw new Error("ground_item_source_database_clock_invalid");
        }
        const sourceResult = await tx.execute(sql`
          SELECT * FROM "ground_item_sources"
          WHERE "source_id" = ${normalizedSourceId}
          FOR UPDATE
        `);
        const row =
          databaseQueryRows<GroundItemSourceDatabaseRow>(sourceResult)[0];
        if (!row) return false;
        const source = parseGroundItemSourceDatabaseRow(row);
        if (source.status !== "active") return true;
        if (source.expiresAt > databaseNow) return false;
        await tx
          .update(schema.groundItemSources)
          .set({
            status: "expired",
            updatedAt: databaseNow,
            version: source.version + 1,
          })
          .where(
            and(
              eq(schema.groundItemSources.sourceId, normalizedSourceId),
              eq(schema.groundItemSources.status, "active"),
            ),
          );
        return true;
      },
      { isolationLevel: "serializable" },
    );
  }

  /**
   * Claim one exact ground source and credit the matching item or coin custody
   * in the same serializable transaction. The source advisory lock is
   * cluster-wide, while the immutable receipt keeps a lost response safe to
   * replay without crediting the source twice.
   */
  async commitGroundItemPickupOperationAsync(
    request: GroundItemPickupCommitRequest,
  ): Promise<GroundItemPickupCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("ground_item_pickup_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const sourceEntityId = String(request.sourceEntityId ?? "").trim();
    const itemId = String(request.itemId ?? "").trim();
    const quantity = Number(request.quantity);
    const item = getItem(itemId);
    if (
      !/^ground-item-pickup:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operationId,
      ) ||
      !playerId ||
      playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !sourceEntityId ||
      sourceEntityId.length > 256 ||
      !item ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY ||
      requestFingerprint !==
        groundItemPickupFingerprint(playerId, sourceEntityId, itemId, quantity)
    ) {
      throw new Error("ground_item_pickup_request_invalid");
    }
    const stackable = item.stackable === true;

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended('ground-item-pickup-source:' || ${sourceEntityId}, 0)
          )`,
        );
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            coins: schema.characters.coins,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        const currentCoins = Number(character?.coins);
        if (
          !character ||
          !Number.isSafeInteger(currentCoins) ||
          currentCoins < 0 ||
          currentCoins > MAX_PERSISTED_ITEM_QUANTITY
        ) {
          throw new Error(
            character
              ? "ground_item_pickup_coin_state_invalid"
              : "ground_item_pickup_player_missing",
          );
        }

        const currentInventory = async (): Promise<CommittedInventoryItem[]> =>
          normalizePersistedInventoryRows(
            await tx
              .select({
                itemId: schema.inventory.itemId,
                quantity: schema.inventory.quantity,
                slotIndex: schema.inventory.slotIndex,
                metadata: schema.inventory.metadata,
              })
              .from(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId)),
            "ground_item_pickup",
          );

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredGroundItemPickupOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "ground_item_pickup" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.sourceEntityId !== sourceEntityId ||
            state.itemId !== itemId ||
            state.quantity !== quantity ||
            state.stackable !== stackable ||
            (state.operationCommittedCoins !== null &&
              (!Number.isSafeInteger(state.operationCommittedCoins) ||
                state.operationCommittedCoins < 0 ||
                state.operationCommittedCoins > MAX_PERSISTED_ITEM_QUANTITY)) ||
            (itemId === "coins") !== (state.operationCommittedCoins !== null)
          ) {
            throw new Error("ground_item_pickup_operation_id_conflict");
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            sourceEntityId,
            itemId,
            quantity,
            stackable,
            operationCommittedCoins: state.operationCommittedCoins,
            currentCoins,
            committed: await currentInventory(),
          };
        }

        const sourceNowResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const sourceDatabaseNow = Number(
          databaseQueryRows<{ databaseNow?: number | string }>(
            sourceNowResult,
          )[0]?.databaseNow,
        );
        if (!Number.isSafeInteger(sourceDatabaseNow) || sourceDatabaseNow < 0) {
          throw new Error("ground_item_source_database_clock_invalid");
        }
        const sourceResult = await tx.execute(sql`
          SELECT * FROM "ground_item_sources"
          WHERE "source_id" = ${sourceEntityId}
          FOR UPDATE
        `);
        const sourceRow =
          databaseQueryRows<GroundItemSourceDatabaseRow>(sourceResult)[0];
        if (!sourceRow) {
          throw new Error("ground_item_pickup_source_missing");
        }
        const source = parseGroundItemSourceDatabaseRow(sourceRow);
        if (
          source.status !== "active" ||
          source.expiresAt <= sourceDatabaseNow
        ) {
          throw new Error("ground_item_pickup_source_claimed");
        }
        if (
          source.itemId !== itemId ||
          source.quantity !== quantity ||
          source.stackable !== stackable
        ) {
          throw new Error("ground_item_pickup_source_mismatch");
        }

        const sourceClaimRows = await tx
          .select({ id: schema.operationsLog.id })
          .from(schema.operationsLog)
          .where(
            and(
              eq(schema.operationsLog.operationType, "ground_item_pickup"),
              eq(schema.operationsLog.completed, true),
              sql<boolean>`${schema.operationsLog.operationState}->>'sourceEntityId' = ${sourceEntityId}`,
            ),
          )
          .limit(1);
        if (sourceClaimRows.length > 0) {
          throw new Error("ground_item_pickup_source_claimed");
        }

        let committed = await currentInventory();
        let operationCommittedCoins: number | null = null;
        let coinsAfter = currentCoins;
        if (itemId === "coins") {
          coinsAfter = Math.min(
            currentCoins + quantity,
            MAX_PERSISTED_ITEM_QUANTITY,
          );
          if (!Number.isSafeInteger(coinsAfter)) {
            throw new Error("ground_item_pickup_quantity_overflow");
          }
          operationCommittedCoins = coinsAfter;
          await tx
            .update(schema.characters)
            .set({ coins: coinsAfter })
            .where(eq(schema.characters.id, playerId));
        } else {
          committed = creditGatheringReward(
            committed,
            { itemId, quantity, stackable },
            "ground_item_pickup",
          );
          await tx
            .delete(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          if (committed.length > 0) {
            await tx.insert(schema.inventory).values(
              committed.map((entry) => ({
                playerId,
                itemId: entry.itemId,
                quantity: entry.quantity,
                slotIndex: entry.slotIndex,
                metadata: entry.metadata
                  ? JSON.stringify(entry.metadata)
                  : null,
              })),
            );
          }
        }

        const operationState: StoredGroundItemPickupOperation = {
          version: 1,
          requestFingerprint,
          sourceEntityId,
          itemId,
          quantity,
          stackable,
          operationCommittedCoins,
        };
        const now = sourceDatabaseNow;
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "ground_item_pickup",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });
        await tx
          .update(schema.groundItemSources)
          .set({
            status: "claimed",
            claimedByOperationId: operationId,
            claimedByPlayerId: playerId,
            claimedAt: now,
            updatedAt: now,
            version: source.version + 1,
          })
          .where(
            and(
              eq(schema.groundItemSources.sourceId, sourceEntityId),
              eq(schema.groundItemSources.status, "active"),
            ),
          );

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          sourceEntityId,
          itemId,
          quantity,
          stackable,
          operationCommittedCoins,
          currentCoins: coinsAfter,
          committed,
        };
      },
      {
        isolationLevel: "serializable",
        maxConflictRetries: 5,
        conflictRetryBaseDelayMs: 5,
      },
    );
  }

  /**
   * Debit one registered food item and stage its health effect as a recoverable
   * operation. Generic health snapshots are flushed ahead of this transaction,
   * so admission is decided against the latest in-process authoritative pool.
   */
  async commitFoodConsumptionOperationAsync(
    request: FoodConsumptionCommitRequest,
  ): Promise<FoodConsumptionCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("food_consumption_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const itemId = String(request.itemId ?? "").trim();
    const healAmount = Number(request.healAmount);
    const requestedPublicActionObservation =
      request.publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelFoodObservationContext(
            request.publicActionObservation,
          );
    const item = getItem(itemId);
    const registeredHeal = Math.min(
      Math.max(0, Math.floor(Number(item?.healAmount ?? 0))),
      COMBAT_CONSTANTS.MAX_HEAL_AMOUNT,
    );
    if (
      !FOOD_CONSUMPTION_OPERATION_ID_PATTERN.test(operationId) ||
      !playerId ||
      playerId.length > 128 ||
      !itemId ||
      itemId.length > 256 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !item ||
      (item.type !== "food" && item.type !== "consumable") ||
      !Number.isSafeInteger(healAmount) ||
      healAmount <= 0 ||
      healAmount !== registeredHeal ||
      (request.publicActionObservation !== undefined &&
        (!requestedPublicActionObservation ||
          requestedPublicActionObservation.actorId !== playerId)) ||
      requestFingerprint !==
        foodConsumptionFingerprint(
          playerId,
          itemId,
          healAmount,
          requestedPublicActionObservation ?? undefined,
        )
    ) {
      throw new Error("food_consumption_request_invalid");
    }

    // Preserve invocation order with damage, regeneration, and respawn writes.
    this.flushSaveBuffer();
    return this.enqueuePlayerSave(() =>
      this.executeInTransaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
          );
          const characterRows = await tx
            .select({
              id: schema.characters.id,
              health: schema.characters.health,
              maxHealth: schema.characters.maxHealth,
            })
            .from(schema.characters)
            .where(eq(schema.characters.id, playerId));
          const character = characterRows[0];
          if (!character) throw new Error("food_consumption_player_missing");

          const existingRows = await tx
            .select({
              playerId: schema.operationsLog.playerId,
              operationType: schema.operationsLog.operationType,
              operationState: schema.operationsLog.operationState,
              completed: schema.operationsLog.completed,
            })
            .from(schema.operationsLog)
            .where(eq(schema.operationsLog.id, operationId));
          const existing = existingRows[0];

          const currentInventoryRows = async () =>
            normalizePersistedInventoryRows(
              await tx
                .select({
                  itemId: schema.inventory.itemId,
                  quantity: schema.inventory.quantity,
                  slotIndex: schema.inventory.slotIndex,
                  metadata: schema.inventory.metadata,
                })
                .from(schema.inventory)
                .where(eq(schema.inventory.playerId, playerId)),
              "food_consumption",
            );

          if (existing) {
            const state = existing.operationState as
              StoredFoodConsumptionOperation | undefined;
            const statePublicActionObservation =
              state?.publicActionObservation === undefined
                ? undefined
                : parseStreamingDuelFoodObservationContext(
                    state.publicActionObservation,
                  );
            if (
              existing.playerId !== playerId ||
              existing.operationType !== "food_consumption" ||
              (existing.completed !== false && existing.completed !== true) ||
              state?.version !== 1 ||
              state.requestFingerprint !== requestFingerprint ||
              state.itemId !== itemId ||
              state.healAmount !== healAmount ||
              (state?.publicActionObservation !== undefined &&
                !statePublicActionObservation) ||
              JSON.stringify(statePublicActionObservation) !==
                JSON.stringify(requestedPublicActionObservation) ||
              !Number.isSafeInteger(state.healedAmount) ||
              state.healedAmount < 0 ||
              state.healedAmount > healAmount ||
              (state.completionReason !== undefined &&
                !isFoodConsumptionCompletionReason(state.completionReason)) ||
              (existing.completed === false &&
                (state.healedAmount !== 0 ||
                  state.healthAfter !== null ||
                  state.completionReason !== undefined)) ||
              (existing.completed === true &&
                (!Number.isSafeInteger(state.healthAfter) ||
                  Number(state.healthAfter) < 0))
            ) {
              throw new Error("food_consumption_operation_id_conflict");
            }
            if (existing.completed && statePublicActionObservation) {
              await commitFoodPublicActionObservation(
                tx,
                statePublicActionObservation,
                state.healedAmount,
                true,
              );
            }
            return {
              operationId,
              playerId,
              requestFingerprint,
              replayed: true,
              itemId,
              healAmount,
              status: existing.completed ? "completed" : "pending",
              healedAmount: state.healedAmount,
              healthAfter: state.healthAfter,
              ...(state.completionReason
                ? { completionReason: state.completionReason }
                : {}),
              committed: await currentInventoryRows(),
            } satisfies FoodConsumptionCommitReceipt;
          }

          const currentHealth = Number(character.health);
          const maxHealth = Number(character.maxHealth);
          if (
            !Number.isSafeInteger(currentHealth) ||
            !Number.isSafeInteger(maxHealth) ||
            currentHealth < 0 ||
            maxHealth <= 0 ||
            currentHealth > maxHealth
          ) {
            throw new Error("food_consumption_health_state_invalid");
          }
          if (currentHealth <= 0) {
            throw new Error("food_consumption_player_not_alive");
          }
          if (currentHealth >= maxHealth) {
            throw new Error("food_consumption_full_health");
          }

          const persisted = await currentInventoryRows();
          const committed = debitInventorySnapshot(persisted, [
            { itemId, quantity: 1 },
          ]);
          await tx
            .delete(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          if (committed.length > 0) {
            await tx.insert(schema.inventory).values(
              committed.map((inventoryItem) => ({
                playerId,
                itemId: inventoryItem.itemId,
                quantity: inventoryItem.quantity,
                slotIndex: inventoryItem.slotIndex,
                metadata: inventoryItem.metadata
                  ? JSON.stringify(inventoryItem.metadata)
                  : null,
              })),
            );
          }

          const operationState: StoredFoodConsumptionOperation = {
            version: 1,
            requestFingerprint,
            itemId,
            healAmount,
            healedAmount: 0,
            healthAfter: null,
            ...(requestedPublicActionObservation
              ? { publicActionObservation: requestedPublicActionObservation }
              : {}),
          };
          await tx.insert(schema.operationsLog).values({
            id: operationId,
            playerId,
            operationType: "food_consumption",
            operationState,
            completed: false,
            timestamp: Date.now(),
            completedAt: null,
          });
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: false,
            itemId,
            healAmount,
            status: "pending",
            healedAmount: 0,
            healthAfter: null,
            committed,
          } satisfies FoodConsumptionCommitReceipt;
        },
        { isolationLevel: "serializable", maxConflictRetries: 4 },
      ),
    );
  }

  /** Complete one pending food health effect exactly once. */
  async completeFoodConsumptionOperationAsync(
    request: FoodConsumptionCompleteRequest,
  ): Promise<FoodConsumptionCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("food_consumption_database_unavailable");
    }
    const normalized = this.normalizeFoodConsumptionCompleteRequest(request);
    this.flushSaveBuffer();
    return this.enqueuePlayerSave(() =>
      this.completeFoodConsumptionOperationUnqueued(normalized),
    );
  }

  /**
   * Finish every interrupted food effect before PlayerSystem hydrates health.
   * This is the crash-recovery boundary for a replacement process.
   */
  async recoverPendingFoodConsumptionOperationsAsync(
    playerId: string,
  ): Promise<FoodConsumptionCommitReceipt[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("food_consumption_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    if (!normalizedPlayerId || normalizedPlayerId.length > 128) {
      throw new Error("food_consumption_request_invalid");
    }
    this.flushSaveBuffer();
    return this.enqueuePlayerSave(async () => {
      const rows = await this.db!.select({
        operationId: schema.operationsLog.id,
        operationState: schema.operationsLog.operationState,
      })
        .from(schema.operationsLog)
        .where(
          and(
            eq(schema.operationsLog.playerId, normalizedPlayerId),
            eq(schema.operationsLog.operationType, "food_consumption"),
            eq(schema.operationsLog.completed, false),
          ),
        );
      const recovered: FoodConsumptionCommitReceipt[] = [];
      for (const row of rows) {
        const state = row.operationState as
          StoredFoodConsumptionOperation | undefined;
        if (
          state?.version !== 1 ||
          !/^[a-f0-9]{64}$/.test(state.requestFingerprint)
        ) {
          throw new Error("food_consumption_recovery_state_invalid");
        }
        recovered.push(
          await this.completeFoodConsumptionOperationUnqueued({
            operationId: row.operationId,
            playerId: normalizedPlayerId,
            requestFingerprint: state.requestFingerprint,
          }),
        );
      }
      return recovered;
    });
  }

  private normalizeFoodConsumptionCompleteRequest(
    request: FoodConsumptionCompleteRequest,
  ): FoodConsumptionCompleteRequest {
    const normalized = {
      operationId: String(request.operationId ?? "").trim(),
      playerId: String(request.playerId ?? "").trim(),
      requestFingerprint: String(request.requestFingerprint ?? "").trim(),
    };
    if (
      !FOOD_CONSUMPTION_OPERATION_ID_PATTERN.test(normalized.operationId) ||
      !normalized.playerId ||
      normalized.playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(normalized.requestFingerprint)
    ) {
      throw new Error("food_consumption_request_invalid");
    }
    return normalized;
  }

  private async completeFoodConsumptionOperationUnqueued(
    request: FoodConsumptionCompleteRequest,
  ): Promise<FoodConsumptionCommitReceipt> {
    if (!this.db) throw new Error("food_consumption_database_unavailable");
    const { operationId, playerId, requestFingerprint } = request;
    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            health: schema.characters.health,
            maxHealth: schema.characters.maxHealth,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) throw new Error("food_consumption_player_missing");

        const operationRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const operation = operationRows[0];
        const state = operation?.operationState as
          StoredFoodConsumptionOperation | undefined;
        const statePublicActionObservation =
          state?.publicActionObservation === undefined
            ? undefined
            : parseStreamingDuelFoodObservationContext(
                state.publicActionObservation,
              );
        const registeredItem = state?.itemId ? getItem(state.itemId) : null;
        const registeredHeal = Math.min(
          Math.max(0, Math.floor(Number(registeredItem?.healAmount ?? 0))),
          COMBAT_CONSTANTS.MAX_HEAL_AMOUNT,
        );
        if (
          !operation ||
          operation.playerId !== playerId ||
          operation.operationType !== "food_consumption" ||
          (operation.completed !== false && operation.completed !== true) ||
          state?.version !== 1 ||
          state.requestFingerprint !== requestFingerprint ||
          !state.itemId ||
          !Number.isSafeInteger(state.healAmount) ||
          state.healAmount <= 0 ||
          !Number.isSafeInteger(state.healedAmount) ||
          state.healedAmount < 0 ||
          state.healedAmount > state.healAmount ||
          !registeredItem ||
          (registeredItem.type !== "food" &&
            registeredItem.type !== "consumable") ||
          registeredHeal !== state.healAmount ||
          (state.publicActionObservation !== undefined &&
            (!statePublicActionObservation ||
              statePublicActionObservation.actorId !== playerId)) ||
          state.requestFingerprint !==
            foodConsumptionFingerprint(
              playerId,
              state.itemId,
              state.healAmount,
              statePublicActionObservation ?? undefined,
            ) ||
          (state.completionReason !== undefined &&
            !isFoodConsumptionCompletionReason(state.completionReason))
        ) {
          throw new Error("food_consumption_operation_id_conflict");
        }

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        const committed = normalizePersistedInventoryRows(
          inventoryRows,
          "food_consumption",
        );
        if (operation.completed) {
          if (
            !Number.isSafeInteger(state.healthAfter) ||
            Number(state.healthAfter) < 0
          ) {
            throw new Error("food_consumption_operation_id_conflict");
          }
          if (statePublicActionObservation) {
            await commitFoodPublicActionObservation(
              tx,
              statePublicActionObservation,
              state.healedAmount,
              true,
            );
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            itemId: state.itemId,
            healAmount: state.healAmount,
            status: "completed",
            healedAmount: state.healedAmount,
            healthAfter: state.healthAfter,
            ...(state.completionReason
              ? { completionReason: state.completionReason }
              : {}),
            committed,
          } satisfies FoodConsumptionCommitReceipt;
        }
        if (
          state.healedAmount !== 0 ||
          state.healthAfter !== null ||
          state.completionReason !== undefined
        ) {
          throw new Error("food_consumption_operation_id_conflict");
        }

        const currentHealth = Number(character.health);
        const maxHealth = Number(character.maxHealth);
        if (
          !Number.isSafeInteger(currentHealth) ||
          !Number.isSafeInteger(maxHealth) ||
          currentHealth < 0 ||
          maxHealth <= 0 ||
          currentHealth > maxHealth
        ) {
          throw new Error("food_consumption_health_state_invalid");
        }
        let completionReason: FoodConsumptionCompletionReason | undefined;
        let healedAmount = 0;
        if (currentHealth <= 0) completionReason = "player_not_alive";
        else if (currentHealth >= maxHealth) completionReason = "full_health";
        else
          healedAmount = Math.min(state.healAmount, maxHealth - currentHealth);
        const healthAfter = currentHealth + healedAmount;
        if (healedAmount > 0) {
          await tx
            .update(schema.characters)
            .set({ health: healthAfter })
            .where(eq(schema.characters.id, playerId));
        }
        if (statePublicActionObservation) {
          await commitFoodPublicActionObservation(
            tx,
            statePublicActionObservation,
            healedAmount,
            false,
          );
        }
        const completedState: StoredFoodConsumptionOperation = {
          ...state,
          healedAmount,
          healthAfter,
          ...(completionReason ? { completionReason } : {}),
        };
        const now = Date.now();
        await tx
          .update(schema.operationsLog)
          .set({
            operationState: completedState,
            completed: true,
            completedAt: now,
          })
          .where(eq(schema.operationsLog.id, operationId));
        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          itemId: state.itemId,
          healAmount: state.healAmount,
          status: "completed",
          healedAmount,
          healthAfter,
          ...(completionReason ? { completionReason } : {}),
          committed,
        } satisfies FoodConsumptionCommitReceipt;
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /**
   * Commit one streaming-duel hit, the health transition it caused, and the
   * exact public observation under the same serializable transaction. Both
   * contestants are locked in stable ID order so simultaneous lethal hits
   * cannot create a postmortem counter-hit or a database deadlock.
   */
  async commitDuelDamageOperationAsync(
    request: DuelDamageCommitRequest,
  ): Promise<DuelDamageCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("duel_damage_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const attackerId = String(request.attackerId ?? "").trim();
    const targetPlayerId = String(request.targetPlayerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const requestedDamage = Number(request.requestedDamage);
    const attackStyle = String(request.attackStyle ?? "").trim();
    const publicActionObservation = parseStreamingDuelDamageObservationContext(
      request.publicActionObservation,
    );
    const projectileCost = request.projectileCost;
    let competitiveAuthority: DuelDamageCompetitiveAuthority | undefined;
    try {
      competitiveAuthority = normalizeDuelDamageCompetitiveAuthority(
        request.competitiveAuthority,
      );
    } catch {
      throw new Error("duel_damage_request_invalid");
    }
    if (
      !publicActionObservation ||
      publicActionObservation.operationId !== operationId ||
      publicActionObservation.actorId !== attackerId ||
      publicActionObservation.opponentId !== targetPlayerId ||
      publicActionObservation.requestedDamage !== requestedDamage ||
      !attackerId ||
      attackerId.length > 128 ||
      !targetPlayerId ||
      targetPlayerId.length > 128 ||
      attackerId === targetPlayerId ||
      !Number.isSafeInteger(requestedDamage) ||
      requestedDamage <= 0 ||
      !MOB_COMBAT_KILL_STYLES.has(attackStyle) ||
      !isDuelCombatRoleAttackStyle(
        publicActionObservation.combatRole,
        attackStyle,
      ) ||
      (projectileCost !== undefined &&
        (projectileCost.playerId !== attackerId ||
          !/^[a-f0-9]{64}$/.test(projectileCost.requestFingerprint) ||
          (projectileCost.operationType === "ammunition_shot"
            ? !/^ammunition-shot:[A-Za-z0-9]{20}$/.test(
                projectileCost.operationId,
              )
            : projectileCost.operationType === "projectile_rune_cost"
              ? !/^spell-runes:[A-Za-z0-9]{20}$/.test(
                  projectileCost.operationId,
                )
              : true))) ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      requestFingerprint !==
        duelDamageFingerprint(
          attackerId,
          targetPlayerId,
          requestedDamage,
          attackStyle,
          publicActionObservation,
          competitiveAuthority,
          projectileCost,
        )
    ) {
      throw new Error("duel_damage_request_invalid");
    }

    // Preserve invocation order with prior buffered health snapshots and every
    // other character-custody operation.
    this.flushSaveBuffer();
    return this.enqueuePlayerSave(() =>
      this.executeInTransaction(
        async (tx) => {
          for (const contestantId of [attackerId, targetPlayerId].sort()) {
            await tx.execute(
              sql`SELECT "id" FROM "characters" WHERE "id" = ${contestantId} FOR UPDATE`,
            );
          }

          const characterRows = await tx
            .select({
              id: schema.characters.id,
              health: schema.characters.health,
              maxHealth: schema.characters.maxHealth,
              attackXp: schema.characters.attackXp,
              attackLevel: schema.characters.attackLevel,
              strengthXp: schema.characters.strengthXp,
              strengthLevel: schema.characters.strengthLevel,
              defenseXp: schema.characters.defenseXp,
              defenseLevel: schema.characters.defenseLevel,
              constitutionXp: schema.characters.constitutionXp,
              constitutionLevel: schema.characters.constitutionLevel,
              rangedXp: schema.characters.rangedXp,
              rangedLevel: schema.characters.rangedLevel,
              magicXp: schema.characters.magicXp,
              magicLevel: schema.characters.magicLevel,
              prayerLevel: schema.characters.prayerLevel,
            })
            .from(schema.characters)
            .where(inArray(schema.characters.id, [attackerId, targetPlayerId]));
          const attacker = characterRows.find((row) => row.id === attackerId);
          const target = characterRows.find((row) => row.id === targetPlayerId);
          if (!attacker || !target)
            throw new Error("duel_damage_player_missing");
          const persistedCombatProgress: Record<
            MobCombatProgressSkill,
            { xp: number; level: number }
          > = {
            attack: {
              xp: Number(attacker.attackXp),
              level: Number(attacker.attackLevel),
            },
            strength: {
              xp: Number(attacker.strengthXp),
              level: Number(attacker.strengthLevel),
            },
            defense: {
              xp: Number(attacker.defenseXp),
              level: Number(attacker.defenseLevel),
            },
            constitution: {
              xp: Number(attacker.constitutionXp),
              level: Number(attacker.constitutionLevel),
            },
            ranged: {
              xp: Number(attacker.rangedXp),
              level: Number(attacker.rangedLevel),
            },
            magic: {
              xp: Number(attacker.magicXp),
              level: Number(attacker.magicLevel),
            },
          };

          let projectileCostState:
            | StoredAmmunitionShotOperation
            | StoredProjectileRuneCostOperation
            | null = null;
          if (projectileCost) {
            await tx.execute(sql`
              SELECT "id"
              FROM "operations_log"
              WHERE "id" = ${projectileCost.operationId}
              FOR UPDATE
            `);
            const costRows = await tx
              .select({
                playerId: schema.operationsLog.playerId,
                operationType: schema.operationsLog.operationType,
                operationState: schema.operationsLog.operationState,
                completed: schema.operationsLog.completed,
              })
              .from(schema.operationsLog)
              .where(eq(schema.operationsLog.id, projectileCost.operationId));
            const costRow = costRows[0];
            const costState = costRow?.operationState as
              | StoredAmmunitionShotOperation
              | StoredProjectileRuneCostOperation
              | undefined;
            const expectedVersion =
              projectileCost.operationType === "ammunition_shot" ? 2 : 1;
            if (
              !costRow ||
              costRow.playerId !== attackerId ||
              costRow.operationType !== projectileCost.operationType ||
              costRow.completed !== true ||
              costState?.version !== expectedVersion ||
              costState.requestFingerprint !==
                projectileCost.requestFingerprint ||
              (costState.status !== "fired" &&
                costState.status !== "resolved") ||
              (costState.status === "fired" &&
                costState.damageOperationId != null) ||
              (costState.status === "resolved" &&
                costState.damageOperationId !== operationId)
            ) {
              throw new Error("duel_damage_projectile_cost_invalid");
            }
            projectileCostState = costState;
          }

          await tx.execute(sql`
            SELECT snapshot."preparationId"
            FROM "streaming_duel_competitive_snapshots" AS snapshot
            JOIN "streaming_duel_preparations" AS preparation
              ON preparation."preparationId" = snapshot."preparationId"
            WHERE snapshot."cycleId" = ${publicActionObservation.cycleId}
            FOR UPDATE OF snapshot, preparation
          `);
          const competitiveRows = await tx
            .select({
              preparationId:
                schema.streamingDuelCompetitiveSnapshots.preparationId,
              cycleId: schema.streamingDuelCompetitiveSnapshots.cycleId,
              duelId: schema.streamingDuelCompetitiveSnapshots.duelId,
              snapshotDigest:
                schema.streamingDuelCompetitiveSnapshots.snapshotDigest,
              snapshot: schema.streamingDuelCompetitiveSnapshots.snapshot,
              duelStartedAt:
                schema.streamingDuelCompetitiveSnapshots.duelStartedAt,
              lifecycleStatus:
                schema.streamingDuelCompetitiveSnapshots.lifecycleStatus,
              terminalOutcome:
                schema.streamingDuelCompetitiveSnapshots.terminalOutcome,
              terminalWinnerId:
                schema.streamingDuelCompetitiveSnapshots.terminalWinnerId,
              terminalWinReason:
                schema.streamingDuelCompetitiveSnapshots.terminalWinReason,
              terminalCancellationReason:
                schema.streamingDuelCompetitiveSnapshots
                  .terminalCancellationReason,
              terminalSeed:
                schema.streamingDuelCompetitiveSnapshots.terminalSeed,
              terminalReplayHash:
                schema.streamingDuelCompetitiveSnapshots.terminalReplayHash,
              terminalAt: schema.streamingDuelCompetitiveSnapshots.terminalAt,
              fencingToken: schema.streamingDuelPreparations.fencingToken,
              preparationVersion: schema.streamingDuelPreparations.version,
              agent1Id: schema.streamingDuelPreparations.agent1Id,
              agent2Id: schema.streamingDuelPreparations.agent2Id,
            })
            .from(schema.streamingDuelCompetitiveSnapshots)
            .innerJoin(
              schema.streamingDuelPreparations,
              eq(
                schema.streamingDuelPreparations.preparationId,
                schema.streamingDuelCompetitiveSnapshots.preparationId,
              ),
            )
            .where(
              eq(
                schema.streamingDuelCompetitiveSnapshots.cycleId,
                publicActionObservation.cycleId,
              ),
            );
          const competitive = competitiveRows[0];
          if (competitiveRows.length > 1) {
            throw new Error("duel_damage_competitive_snapshot_ambiguous");
          }
          if (Boolean(competitive) !== Boolean(competitiveAuthority)) {
            throw new Error("duel_damage_competitive_authority_required");
          }
          if (
            competitive &&
            competitiveAuthority &&
            (competitive.preparationId !== competitiveAuthority.preparationId ||
              competitive.snapshotDigest !==
                competitiveAuthority.snapshotDigest ||
              competitive.duelId !== publicActionObservation.duelId ||
              competitive.cycleId !== publicActionObservation.cycleId ||
              competitive.agent1Id === competitive.agent2Id ||
              ![competitive.agent1Id, competitive.agent2Id].includes(
                attackerId,
              ) ||
              ![competitive.agent1Id, competitive.agent2Id].includes(
                targetPlayerId,
              ) ||
              !Number.isSafeInteger(competitive.duelStartedAt) ||
              competitive.duelStartedAt === null ||
              publicActionObservation.observedAt < competitive.duelStartedAt)
          ) {
            throw new Error("duel_damage_competitive_authority_mismatch");
          }

          const existingRows = await tx
            .select({
              playerId: schema.operationsLog.playerId,
              operationType: schema.operationsLog.operationType,
              operationState: schema.operationsLog.operationState,
              completed: schema.operationsLog.completed,
            })
            .from(schema.operationsLog)
            .where(eq(schema.operationsLog.id, operationId));
          const existing = existingRows[0];
          if (existing) {
            if (
              projectileCostState &&
              (projectileCostState.status !== "resolved" ||
                projectileCostState.damageOperationId !== operationId)
            ) {
              throw new Error("duel_damage_projectile_cost_invalid");
            }
            const state = existing.operationState as
              StoredDuelDamageOperation | undefined;
            const storedObservation =
              parseStreamingDuelDamageObservationContext(
                state?.publicActionObservation,
              );
            const storedTerminal = state?.competitiveTerminal;
            let storedCompetitiveAuthority:
              DuelDamageCompetitiveAuthority | undefined;
            let storedCompetitiveAuthorityValid = true;
            try {
              storedCompetitiveAuthority =
                normalizeDuelDamageCompetitiveAuthority(
                  state?.competitiveAuthority,
                );
            } catch {
              storedCompetitiveAuthorityValid = false;
            }
            const terminalValid =
              storedTerminal === null ||
              isExactDuelDamageCompetitiveTerminal(
                storedTerminal,
                attackerId,
                targetPlayerId,
                publicActionObservation.observedAt,
              );
            if (
              existing.playerId !== targetPlayerId ||
              existing.operationType !== "duel_damage" ||
              existing.completed !== true ||
              state?.version !== 2 ||
              state.requestFingerprint !== requestFingerprint ||
              state.attackerId !== attackerId ||
              state.attackStyle !== attackStyle ||
              state.requestedDamage !== requestedDamage ||
              !storedObservation ||
              JSON.stringify(storedObservation) !==
                JSON.stringify(publicActionObservation) ||
              !storedCompetitiveAuthorityValid ||
              JSON.stringify(storedCompetitiveAuthority) !==
                JSON.stringify(competitiveAuthority) ||
              !isExactDuelDamageProjectileCostAuthority(
                state.projectileCost,
                projectileCost,
              ) ||
              !terminalValid ||
              !Number.isSafeInteger(state.appliedDamage) ||
              state.appliedDamage < 0 ||
              state.appliedDamage > requestedDamage ||
              !Number.isSafeInteger(state.healthBefore) ||
              !Number.isSafeInteger(state.healthAfter) ||
              state.healthBefore < 0 ||
              state.healthAfter < 0 ||
              state.healthAfter > state.healthBefore ||
              state.healthBefore - state.healthAfter !== state.appliedDamage ||
              !Array.isArray(state.combatProgress) ||
              (storedTerminal === null
                ? state.xpDamageAuthority !== null
                : state.xpDamageAuthority === null ||
                  !Number.isSafeInteger(state.xpDamageAuthority) ||
                  state.xpDamageAuthority <= 0)
            ) {
              throw new Error("duel_damage_operation_id_conflict");
            }
            const competitiveTerminal =
              storedTerminal as DuelDamageCompetitiveTerminal | null;
            const expectedCombatXp = competitiveTerminal
              ? mobCombatXpAmounts(attackStyle, state.xpDamageAuthority!)
              : [];
            if (
              state.combatProgress.length !== expectedCombatXp.length ||
              state.combatProgress.some((progress, index) => {
                const expected = expectedCombatXp[index];
                const current = persistedCombatProgress[progress.skill];
                return (
                  !expected ||
                  progress.skill !== expected.skill ||
                  progress.xpAmount !== expected.xpAmount ||
                  !Number.isSafeInteger(progress.awardedXp) ||
                  progress.awardedXp < 0 ||
                  progress.awardedXp > progress.xpAmount ||
                  !Number.isSafeInteger(progress.operationCommittedXp) ||
                  progress.operationCommittedXp < progress.awardedXp ||
                  progress.operationCommittedXp > MAX_SKILL_XP ||
                  !current ||
                  !Number.isSafeInteger(current.xp) ||
                  current.xp < progress.operationCommittedXp ||
                  current.xp > MAX_SKILL_XP ||
                  !Number.isSafeInteger(current.level) ||
                  current.level < 1 ||
                  current.level > 99 ||
                  skillLevelForXp(current.xp) !== current.level
                );
              })
            ) {
              throw new Error("duel_damage_operation_id_conflict");
            }
            const combatProgress = state.combatProgress.map((progress) => ({
              ...progress,
              currentXp: persistedCombatProgress[progress.skill].xp,
              currentLevel: persistedCombatProgress[progress.skill].level,
            }));
            if (
              competitiveTerminal &&
              (!competitive ||
                competitive.lifecycleStatus !== "terminal" ||
                competitive.terminalOutcome !== competitiveTerminal.outcome ||
                competitive.terminalWinnerId !== competitiveTerminal.winnerId ||
                competitive.terminalWinReason !==
                  competitiveTerminal.winReason ||
                competitive.terminalCancellationReason !== null ||
                competitive.terminalSeed !== competitiveTerminal.seed ||
                competitive.terminalReplayHash !==
                  competitiveTerminal.replayHash ||
                competitive.terminalAt !== competitiveTerminal.terminalAt)
            ) {
              throw new Error("duel_damage_competitive_terminal_missing");
            }
            if (competitiveTerminal) {
              const transitionRows = await tx
                .select({
                  eventSource: schema.streamingDuelTransitionEvents.eventSource,
                  eventType: schema.streamingDuelTransitionEvents.eventType,
                  preparationId:
                    schema.streamingDuelTransitionEvents.preparationId,
                  occurredAt: schema.streamingDuelTransitionEvents.occurredAt,
                  fencingToken:
                    schema.streamingDuelTransitionEvents.fencingToken,
                  agent1Id: schema.streamingDuelTransitionEvents.agent1Id,
                  agent2Id: schema.streamingDuelTransitionEvents.agent2Id,
                  actorAgentId:
                    schema.streamingDuelTransitionEvents.actorAgentId,
                  cycleId: schema.streamingDuelTransitionEvents.cycleId,
                  duelId: schema.streamingDuelTransitionEvents.duelId,
                  snapshotDigest:
                    schema.streamingDuelTransitionEvents.snapshotDigest,
                  terminalOutcome:
                    schema.streamingDuelTransitionEvents.terminalOutcome,
                  winnerId: schema.streamingDuelTransitionEvents.winnerId,
                  winReason: schema.streamingDuelTransitionEvents.winReason,
                  reason: schema.streamingDuelTransitionEvents.reason,
                  terminalSeed:
                    schema.streamingDuelTransitionEvents.terminalSeed,
                  replayHash: schema.streamingDuelTransitionEvents.replayHash,
                })
                .from(schema.streamingDuelTransitionEvents)
                .where(
                  eq(
                    schema.streamingDuelTransitionEvents.eventKey,
                    `${competitive!.preparationId}:terminal_committed`,
                  ),
                );
              const transition = transitionRows[0];
              if (
                !transition ||
                transition.eventSource !== "runtime" ||
                transition.eventType !== "terminal_committed" ||
                transition.preparationId !== competitive!.preparationId ||
                transition.occurredAt !== competitiveTerminal.terminalAt ||
                transition.fencingToken?.toString() !==
                  storedCompetitiveAuthority?.fencingToken ||
                transition.agent1Id !== competitive!.agent1Id ||
                transition.agent2Id !== competitive!.agent2Id ||
                transition.actorAgentId !== null ||
                transition.cycleId !== competitive!.cycleId ||
                transition.duelId !== competitive!.duelId ||
                transition.snapshotDigest !== competitive!.snapshotDigest ||
                transition.terminalOutcome !== competitiveTerminal.outcome ||
                transition.winnerId !== competitiveTerminal.winnerId ||
                transition.winReason !== competitiveTerminal.winReason ||
                transition.reason !== null ||
                transition.terminalSeed !== competitiveTerminal.seed ||
                transition.replayHash !== competitiveTerminal.replayHash
              ) {
                throw new Error(
                  "duel_damage_competitive_terminal_event_missing",
                );
              }
            }
            if (
              competitive &&
              state.appliedDamage > 0 &&
              state.healthAfter === 0 &&
              !competitiveTerminal
            ) {
              throw new Error("duel_damage_competitive_terminal_missing");
            }
            if (state.appliedDamage > 0) {
              await commitDamagePublicActionObservation(
                tx,
                storedObservation,
                state.appliedDamage,
                true,
              );
            }
            return {
              operationId,
              attackerId,
              targetPlayerId,
              requestFingerprint,
              requestedDamage,
              replayed: true,
              appliedDamage: state.appliedDamage,
              healthBefore: state.healthBefore,
              healthAfter: state.healthAfter,
              targetDied: state.appliedDamage > 0 && state.healthAfter === 0,
              xpDamageAuthority: state.xpDamageAuthority,
              combatProgress,
              competitiveTerminal,
            } satisfies DuelDamageCommitReceipt;
          }

          if (
            projectileCostState &&
            (projectileCostState.status !== "fired" ||
              projectileCostState.damageOperationId != null)
          ) {
            throw new Error("duel_damage_projectile_cost_invalid");
          }

          if (
            competitive &&
            competitiveAuthority &&
            competitive.fencingToken.toString() !==
              competitiveAuthority.fencingToken
          ) {
            throw new Error("duel_damage_competitive_authority_mismatch");
          }

          const attackerHealth = Number(attacker.health);
          const attackerMaxHealth = Number(attacker.maxHealth);
          const healthBefore = Number(target.health);
          const targetMaxHealth = Number(target.maxHealth);
          if (
            !Number.isSafeInteger(attackerHealth) ||
            !Number.isSafeInteger(attackerMaxHealth) ||
            attackerHealth < 0 ||
            attackerMaxHealth <= 0 ||
            attackerHealth > attackerMaxHealth ||
            !Number.isSafeInteger(healthBefore) ||
            !Number.isSafeInteger(targetMaxHealth) ||
            healthBefore < 0 ||
            targetMaxHealth <= 0 ||
            healthBefore > targetMaxHealth
          ) {
            throw new Error("duel_damage_health_state_invalid");
          }

          if (
            competitive &&
            competitive.lifecycleStatus !== "frozen" &&
            competitive.lifecycleStatus !== "terminal"
          ) {
            throw new Error("duel_damage_competitive_lifecycle_invalid");
          }
          const appliedDamage =
            attackerHealth > 0 &&
            (!competitive || competitive.lifecycleStatus === "frozen")
              ? Math.min(requestedDamage, healthBefore)
              : 0;
          const healthAfter = healthBefore - appliedDamage;
          let competitiveTerminal: DuelDamageCompetitiveTerminal | null = null;
          let xpDamageAuthority: number | null = null;
          let combatProgress: MobCombatProgressReceipt[] = [];
          if (appliedDamage > 0) {
            await tx
              .update(schema.characters)
              .set({ health: healthAfter })
              .where(eq(schema.characters.id, targetPlayerId));
            await commitDamagePublicActionObservation(
              tx,
              publicActionObservation,
              appliedDamage,
              false,
            );

            if (healthAfter === 0 && competitive && competitiveAuthority) {
              const snapshot = competitive.snapshot as CompetitiveSnapshot;
              const snapshotAgentIds = snapshot.contestants?.map(
                (contestant) => contestant.agentId,
              );
              const attackerSnapshot = snapshot.contestants?.find(
                (contestant) => contestant.agentId === attackerId,
              );
              const targetSnapshot = snapshot.contestants?.find(
                (contestant) => contestant.agentId === targetPlayerId,
              );
              if (
                snapshotAgentIds?.length !== 2 ||
                snapshotAgentIds[0] !== competitive.agent1Id ||
                snapshotAgentIds[1] !== competitive.agent2Id ||
                !attackerSnapshot ||
                !targetSnapshot ||
                !attackerSnapshot.availableCombatStyles.includes(
                  publicActionObservation.combatRole,
                ) ||
                !Number.isSafeInteger(targetSnapshot.maxHp) ||
                targetSnapshot.maxHp <= 0 ||
                targetSnapshot.maxHp !== targetMaxHealth ||
                !Number.isSafeInteger(competitive.preparationVersion) ||
                competitive.preparationVersion < 1 ||
                competitive.duelStartedAt === null
              ) {
                throw new Error("duel_damage_competitive_snapshot_invalid");
              }

              const damageRows = await tx
                .select({
                  observation:
                    schema.streamingDuelActionObservations.observation,
                })
                .from(schema.streamingDuelActionObservations)
                .where(
                  and(
                    eq(
                      schema.streamingDuelActionObservations.cycleId,
                      publicActionObservation.cycleId,
                    ),
                    eq(schema.streamingDuelActionObservations.action, "damage"),
                  ),
                );
              const damageByAgent = new Map<string, number>([
                [competitive.agent1Id, 0],
                [competitive.agent2Id, 0],
              ]);
              for (const row of damageRows) {
                const observation = parseStreamingDuelActionObservation(
                  row.observation,
                );
                if (
                  !observation ||
                  observation.action !== "damage" ||
                  observation.cycleId !== publicActionObservation.cycleId ||
                  observation.duelId !== publicActionObservation.duelId ||
                  !damageByAgent.has(observation.actorId) ||
                  observation.opponentId !==
                    (observation.actorId === competitive.agent1Id
                      ? competitive.agent2Id
                      : competitive.agent1Id) ||
                  !Number.isSafeInteger(observation.amount) ||
                  observation.amount <= 0
                ) {
                  throw new Error(
                    "duel_damage_competitive_observation_history_invalid",
                  );
                }
                const total =
                  (damageByAgent.get(observation.actorId) ?? 0) +
                  observation.amount;
                if (!Number.isSafeInteger(total)) {
                  throw new Error(
                    "duel_damage_competitive_observation_history_invalid",
                  );
                }
                damageByAgent.set(observation.actorId, total);
              }

              const terminalAt = publicActionObservation.observedAt;
              const proof = buildCompetitiveTerminalProof({
                duelId: competitive.duelId,
                cycleId: competitive.cycleId,
                winnerId: attackerId,
                loserId: targetPlayerId,
                winReason: "kill",
                fightStartedAt: competitive.duelStartedAt,
                finishedAt: terminalAt,
                agent1Id: competitive.agent1Id,
                agent2Id: competitive.agent2Id,
                damageAgent1: damageByAgent.get(competitive.agent1Id) ?? 0,
                damageAgent2: damageByAgent.get(competitive.agent2Id) ?? 0,
              });
              competitiveTerminal = {
                outcome: "win",
                winnerId: attackerId,
                loserId: targetPlayerId,
                winReason: "kill",
                terminalAt,
                seed: proof.seed,
                replayHash: proof.replayHash,
              };

              const terminalRows = await tx
                .update(schema.streamingDuelCompetitiveSnapshots)
                .set({
                  lifecycleStatus: "terminal",
                  terminalOutcome: competitiveTerminal.outcome,
                  terminalWinnerId: competitiveTerminal.winnerId,
                  terminalWinReason: competitiveTerminal.winReason,
                  terminalCancellationReason: null,
                  terminalSeed: competitiveTerminal.seed,
                  terminalReplayHash: competitiveTerminal.replayHash,
                  terminalAt: competitiveTerminal.terminalAt,
                })
                .where(
                  and(
                    eq(
                      schema.streamingDuelCompetitiveSnapshots.preparationId,
                      competitive.preparationId,
                    ),
                    eq(
                      schema.streamingDuelCompetitiveSnapshots.snapshotDigest,
                      competitive.snapshotDigest,
                    ),
                    eq(
                      schema.streamingDuelCompetitiveSnapshots.lifecycleStatus,
                      "frozen",
                    ),
                  ),
                )
                .returning({
                  preparationId:
                    schema.streamingDuelCompetitiveSnapshots.preparationId,
                });
              if (terminalRows.length !== 1) {
                throw new Error("duel_damage_competitive_terminal_lost");
              }

              xpDamageAuthority = targetSnapshot.maxHp;
              const combatXpAwards = mobCombatXpAmounts(
                attackStyle,
                xpDamageAuthority,
              );
              const prayerLevel = Number(attacker.prayerLevel);
              if (
                combatXpAwards.length === 0 ||
                combatXpAwards.length > 4 ||
                !Number.isSafeInteger(prayerLevel) ||
                prayerLevel < 1 ||
                prayerLevel > 99 ||
                Object.values(persistedCombatProgress).some(
                  (progress) =>
                    !Number.isSafeInteger(progress.xp) ||
                    progress.xp < 0 ||
                    progress.xp > MAX_SKILL_XP ||
                    !Number.isSafeInteger(progress.level) ||
                    progress.level < 1 ||
                    progress.level > 99 ||
                    skillLevelForXp(progress.xp) !== progress.level,
                ) ||
                combatXpAwards.some(
                  ({ xpAmount }) =>
                    !Number.isSafeInteger(xpAmount) ||
                    xpAmount <= 0 ||
                    xpAmount > 1_000_000,
                )
              ) {
                throw new Error("duel_damage_combat_progress_invalid");
              }
              combatProgress = combatXpAwards.map(({ skill, xpAmount }) => {
                const before = persistedCombatProgress[skill];
                const operationCommittedXp = Math.min(
                  before.xp + xpAmount,
                  MAX_SKILL_XP,
                );
                return {
                  skill,
                  xpAmount,
                  awardedXp: operationCommittedXp - before.xp,
                  operationCommittedXp,
                  currentXp: operationCommittedXp,
                  currentLevel: skillLevelForXp(operationCommittedXp),
                } satisfies MobCombatProgressReceipt;
              });
              type CharacterCombatUpdate = Partial<
                Omit<typeof schema.characters.$inferInsert, "id" | "accountId">
              >;
              const combatUpdate: CharacterCombatUpdate = {};
              for (const progress of combatProgress) {
                switch (progress.skill) {
                  case "attack":
                    combatUpdate.attackXp = progress.currentXp;
                    combatUpdate.attackLevel = progress.currentLevel;
                    break;
                  case "strength":
                    combatUpdate.strengthXp = progress.currentXp;
                    combatUpdate.strengthLevel = progress.currentLevel;
                    break;
                  case "defense":
                    combatUpdate.defenseXp = progress.currentXp;
                    combatUpdate.defenseLevel = progress.currentLevel;
                    break;
                  case "constitution":
                    combatUpdate.constitutionXp = progress.currentXp;
                    combatUpdate.constitutionLevel = progress.currentLevel;
                    break;
                  case "ranged":
                    combatUpdate.rangedXp = progress.currentXp;
                    combatUpdate.rangedLevel = progress.currentLevel;
                    break;
                  case "magic":
                    combatUpdate.magicXp = progress.currentXp;
                    combatUpdate.magicLevel = progress.currentLevel;
                    break;
                }
              }
              const committedLevels = {
                attack: persistedCombatProgress.attack.level,
                strength: persistedCombatProgress.strength.level,
                defense: persistedCombatProgress.defense.level,
                constitution: persistedCombatProgress.constitution.level,
                ranged: persistedCombatProgress.ranged.level,
                magic: persistedCombatProgress.magic.level,
              };
              for (const progress of combatProgress) {
                committedLevels[progress.skill] = progress.currentLevel;
              }
              combatUpdate.combatLevel = calculateCombatLevel({
                attack: committedLevels.attack,
                strength: committedLevels.strength,
                defense: committedLevels.defense,
                hitpoints: committedLevels.constitution,
                ranged: committedLevels.ranged,
                magic: committedLevels.magic,
                prayer: prayerLevel,
              });
              await tx
                .update(schema.characters)
                .set(combatUpdate)
                .where(eq(schema.characters.id, attackerId));

              const statUpdates = buildCompetitiveTerminalStatUpdates(
                snapshot,
                competitiveTerminal,
                damageByAgent,
              );
              for (const update of statUpdates) {
                await tx
                  .insert(schema.playerCombatStats)
                  .values({
                    playerId: update.agentId,
                    totalDuelWins: update.anchoredWins,
                    totalDuelLosses: update.anchoredLosses,
                    updatedAt: update.terminalAt,
                  })
                  .onConflictDoUpdate({
                    target: schema.playerCombatStats.playerId,
                    set: {
                      totalDuelWins: sql`GREATEST(${schema.playerCombatStats.totalDuelWins} + ${update.winDelta}, ${update.anchoredWins})`,
                      totalDuelLosses: sql`GREATEST(${schema.playerCombatStats.totalDuelLosses} + ${update.lossDelta}, ${update.anchoredLosses})`,
                      updatedAt: sql`GREATEST(${schema.playerCombatStats.updatedAt}, ${update.terminalAt})`,
                    },
                  });

                const streakUpdates =
                  update.result === "win"
                    ? {
                        killStreak: sql`GREATEST(${schema.agentDuelStats.killStreak}, ${schema.agentDuelStats.currentStreak} + 1)`,
                        currentStreak: sql`${schema.agentDuelStats.currentStreak} + 1`,
                      }
                    : update.result === "loss"
                      ? { currentStreak: 0 }
                      : {};
                await tx
                  .insert(schema.agentDuelStats)
                  .values({
                    characterId: update.agentId,
                    agentName: update.name,
                    provider: update.provider,
                    model: update.model,
                    wins: update.anchoredWins,
                    losses: update.anchoredLosses,
                    draws: update.drawDelta,
                    totalDamageDealt: update.damageDealt,
                    totalDamageTaken: update.damageTaken,
                    killStreak: update.result === "win" ? 1 : 0,
                    currentStreak: update.result === "win" ? 1 : 0,
                    lastDuelAt: update.terminalAt,
                    updatedAt: update.terminalAt,
                  })
                  .onConflictDoUpdate({
                    target: schema.agentDuelStats.characterId,
                    set: {
                      agentName: update.name,
                      provider: update.provider,
                      model: update.model,
                      wins: sql`GREATEST(${schema.agentDuelStats.wins} + ${update.winDelta}, ${update.anchoredWins})`,
                      losses: sql`GREATEST(${schema.agentDuelStats.losses} + ${update.lossDelta}, ${update.anchoredLosses})`,
                      draws: sql`${schema.agentDuelStats.draws} + ${update.drawDelta}`,
                      totalDamageDealt: sql`${schema.agentDuelStats.totalDamageDealt} + ${update.damageDealt}`,
                      totalDamageTaken: sql`${schema.agentDuelStats.totalDamageTaken} + ${update.damageTaken}`,
                      ...streakUpdates,
                      lastDuelAt: sql`GREATEST(COALESCE(${schema.agentDuelStats.lastDuelAt}, 0), ${update.terminalAt})`,
                      updatedAt: sql`GREATEST(${schema.agentDuelStats.updatedAt}, ${update.terminalAt})`,
                    },
                  });
              }

              const eventKey = `${competitive.preparationId}:terminal_committed`;
              const expectedTransition = {
                eventKey,
                eventSource: "runtime",
                eventType: "terminal_committed",
                preparationId: competitive.preparationId,
                occurredAt: competitiveTerminal.terminalAt,
                fencingToken: BigInt(competitiveAuthority.fencingToken),
                preparationVersion: competitive.preparationVersion,
                agent1Id: competitive.agent1Id,
                agent2Id: competitive.agent2Id,
                actorAgentId: null,
                cycleId: competitive.cycleId,
                duelId: competitive.duelId,
                snapshotDigest: competitive.snapshotDigest,
                terminalOutcome: competitiveTerminal.outcome,
                winnerId: competitiveTerminal.winnerId,
                winReason: competitiveTerminal.winReason,
                reason: null,
                terminalSeed: competitiveTerminal.seed,
                replayHash: competitiveTerminal.replayHash,
              } as const;
              const insertedTransitions = await tx
                .insert(schema.streamingDuelTransitionEvents)
                .values(expectedTransition)
                .onConflictDoNothing({
                  target: schema.streamingDuelTransitionEvents.eventKey,
                })
                .returning({
                  eventKey: schema.streamingDuelTransitionEvents.eventKey,
                });
              if (insertedTransitions.length !== 1) {
                const existingTransitions = await tx
                  .select({
                    eventKey: schema.streamingDuelTransitionEvents.eventKey,
                    eventSource:
                      schema.streamingDuelTransitionEvents.eventSource,
                    eventType: schema.streamingDuelTransitionEvents.eventType,
                    preparationId:
                      schema.streamingDuelTransitionEvents.preparationId,
                    occurredAt: schema.streamingDuelTransitionEvents.occurredAt,
                    fencingToken:
                      schema.streamingDuelTransitionEvents.fencingToken,
                    preparationVersion:
                      schema.streamingDuelTransitionEvents.preparationVersion,
                    agent1Id: schema.streamingDuelTransitionEvents.agent1Id,
                    agent2Id: schema.streamingDuelTransitionEvents.agent2Id,
                    actorAgentId:
                      schema.streamingDuelTransitionEvents.actorAgentId,
                    cycleId: schema.streamingDuelTransitionEvents.cycleId,
                    duelId: schema.streamingDuelTransitionEvents.duelId,
                    snapshotDigest:
                      schema.streamingDuelTransitionEvents.snapshotDigest,
                    terminalOutcome:
                      schema.streamingDuelTransitionEvents.terminalOutcome,
                    winnerId: schema.streamingDuelTransitionEvents.winnerId,
                    winReason: schema.streamingDuelTransitionEvents.winReason,
                    reason: schema.streamingDuelTransitionEvents.reason,
                    terminalSeed:
                      schema.streamingDuelTransitionEvents.terminalSeed,
                    replayHash: schema.streamingDuelTransitionEvents.replayHash,
                  })
                  .from(schema.streamingDuelTransitionEvents)
                  .where(
                    eq(schema.streamingDuelTransitionEvents.eventKey, eventKey),
                  );
                const existingTransition = existingTransitions[0];
                if (
                  !existingTransition ||
                  JSON.stringify(existingTransition, (_key, value) =>
                    typeof value === "bigint" ? value.toString() : value,
                  ) !==
                    JSON.stringify(expectedTransition, (_key, value) =>
                      typeof value === "bigint" ? value.toString() : value,
                    )
                ) {
                  throw new Error(
                    "duel_damage_competitive_terminal_event_conflict",
                  );
                }
              }
            }
          }

          if (projectileCost && projectileCostState) {
            const resolvedCostState = {
              ...projectileCostState,
              status: "resolved" as const,
              damageOperationId: operationId,
            };
            const resolvedRows = await tx
              .update(schema.operationsLog)
              .set({ operationState: resolvedCostState })
              .where(eq(schema.operationsLog.id, projectileCost.operationId))
              .returning({ id: schema.operationsLog.id });
            if (resolvedRows.length !== 1) {
              throw new Error("duel_damage_projectile_cost_lost");
            }
          }

          const operationState: StoredDuelDamageOperation = {
            version: 2,
            requestFingerprint,
            attackerId,
            attackStyle,
            requestedDamage,
            appliedDamage,
            healthBefore,
            healthAfter,
            publicActionObservation,
            ...(competitiveAuthority ? { competitiveAuthority } : {}),
            ...(projectileCost ? { projectileCost } : {}),
            competitiveTerminal,
            xpDamageAuthority,
            combatProgress: combatProgress.map(
              ({ skill, xpAmount, awardedXp, operationCommittedXp }) => ({
                skill,
                xpAmount,
                awardedXp,
                operationCommittedXp,
              }),
            ),
          };
          const completedAt = Date.now();
          await tx.insert(schema.operationsLog).values({
            id: operationId,
            playerId: targetPlayerId,
            operationType: "duel_damage",
            operationState,
            completed: true,
            timestamp: completedAt,
            completedAt,
          });

          return {
            operationId,
            attackerId,
            targetPlayerId,
            requestFingerprint,
            requestedDamage,
            replayed: false,
            appliedDamage,
            healthBefore,
            healthAfter,
            targetDied: appliedDamage > 0 && healthAfter === 0,
            xpDamageAuthority,
            combatProgress,
            competitiveTerminal,
          } satisfies DuelDamageCommitReceipt;
        },
        {
          isolationLevel: "serializable",
          maxConflictRetries: 5,
          conflictRetryBaseDelayMs: 5,
        },
      ),
    );
  }

  /**
   * Consume one exact bone and award its Prayer progression as one immutable,
   * idempotent custody transition. The same character-row lock also serializes
   * prayer drains/toggles, inventory actions, and loadout transitions.
   */
  async commitBoneBurialOperationAsync(
    request: BoneBurialCommitRequest,
  ): Promise<BoneBurialCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("bone_burial_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const itemId = String(request.itemId ?? "").trim();
    const xpAmount = Number(request.xpAmount);
    const levelRequired = Number(request.levelRequired);
    if (
      !BONE_BURIAL_OPERATION_ID_PATTERN.test(operationId) ||
      !playerId ||
      playerId.length > 128 ||
      !itemId ||
      itemId.length > 256 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !Number.isSafeInteger(xpAmount) ||
      xpAmount <= 0 ||
      xpAmount > 1_000_000 ||
      !Number.isSafeInteger(levelRequired) ||
      levelRequired < 1 ||
      levelRequired > 99 ||
      requestFingerprint !==
        boneBurialFingerprint(playerId, itemId, xpAmount, levelRequired)
    ) {
      throw new Error("bone_burial_request_invalid");
    }

    const operation = this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            prayerXp: schema.characters.prayerXp,
            prayerLevel: schema.characters.prayerLevel,
            prayerPoints: schema.characters.prayerPoints,
            prayerPointUnits: schema.characters.prayerPointUnits,
            prayerMaxPoints: schema.characters.prayerMaxPoints,
            activePrayers: schema.characters.activePrayers,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) throw new Error("bone_burial_player_missing");

        const persistedXp = Number(character.prayerXp ?? 0);
        const persistedLevel = Number(character.prayerLevel ?? 1);
        if (
          !Number.isSafeInteger(persistedXp) ||
          persistedXp < 0 ||
          persistedXp > MAX_SKILL_XP ||
          !Number.isSafeInteger(persistedLevel) ||
          persistedLevel < 1 ||
          persistedLevel > 99 ||
          skillLevelForXp(persistedXp) !== persistedLevel
        ) {
          throw new Error("bone_burial_skill_state_invalid");
        }
        const persistedPrayer = normalizePrayerSnapshot(
          {
            pointUnits:
              character.prayerPointUnits ??
              (character.prayerPoints ?? persistedLevel) *
                PRAYER_POINT_UNITS_PER_POINT,
            maxPoints: character.prayerMaxPoints ?? persistedLevel,
            activePrayers: character.activePrayers ?? [],
          },
          "bone_burial",
        );
        if (persistedPrayer.maxPoints !== persistedLevel) {
          throw new Error("bone_burial_prayer_state_invalid");
        }

        const existingRows = await tx
          .select({
            playerId: schema.boneBurialOperations.playerId,
            itemId: schema.boneBurialOperations.itemId,
            xpAmount: schema.boneBurialOperations.xpAmount,
            levelRequired: schema.boneBurialOperations.levelRequired,
            awardedXp: schema.boneBurialOperations.awardedXp,
            operationCommittedXp:
              schema.boneBurialOperations.operationCommittedXp,
            committedLevel: schema.boneBurialOperations.committedLevel,
            requestFingerprint: schema.boneBurialOperations.requestFingerprint,
          })
          .from(schema.boneBurialOperations)
          .where(eq(schema.boneBurialOperations.operationId, operationId));
        const existing = existingRows[0];
        if (existing) {
          if (
            existing.playerId !== playerId ||
            existing.itemId !== itemId ||
            existing.xpAmount !== xpAmount ||
            existing.levelRequired !== levelRequired ||
            existing.requestFingerprint !== requestFingerprint ||
            !Number.isSafeInteger(existing.awardedXp) ||
            existing.awardedXp < 0 ||
            existing.awardedXp > xpAmount ||
            !Number.isSafeInteger(existing.operationCommittedXp) ||
            existing.operationCommittedXp < 0 ||
            existing.operationCommittedXp > MAX_SKILL_XP ||
            existing.committedLevel !==
              skillLevelForXp(existing.operationCommittedXp)
          ) {
            throw new Error("bone_burial_operation_id_conflict");
          }
          const currentRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            itemId,
            xpAmount,
            levelRequired,
            awardedXp: existing.awardedXp,
            operationCommittedXp: existing.operationCommittedXp,
            currentXp: persistedXp,
            currentLevel: persistedLevel,
            committed: normalizePersistedInventoryRows(
              currentRows,
              "bone_burial",
            ),
          };
        }

        if (persistedLevel < levelRequired) {
          throw new Error("bone_burial_level_required");
        }
        if (persistedXp >= MAX_SKILL_XP) {
          throw new Error("bone_burial_xp_cap");
        }

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        let committed: CommittedInventoryItem[];
        try {
          committed = debitInventorySnapshot(
            normalizePersistedInventoryRows(inventoryRows, "bone_burial"),
            [{ itemId, quantity: 1 }],
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("inventory_debit_insufficient_items")
          ) {
            throw new Error("bone_burial_insufficient_items");
          }
          throw error;
        }

        const operationCommittedXp = Math.min(
          persistedXp + xpAmount,
          MAX_SKILL_XP,
        );
        const awardedXp = operationCommittedXp - persistedXp;
        const currentLevel = skillLevelForXp(operationCommittedXp);
        const levelIncreased = currentLevel > persistedLevel;
        const committedPrayer = {
          pointUnits: levelIncreased
            ? currentLevel * PRAYER_POINT_UNITS_PER_POINT
            : persistedPrayer.pointUnits,
          maxPoints: levelIncreased ? currentLevel : persistedPrayer.maxPoints,
          activePrayers: persistedPrayer.activePrayers,
        };

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        await tx
          .update(schema.characters)
          .set({
            prayerXp: operationCommittedXp,
            prayerLevel: currentLevel,
            prayerPointUnits: committedPrayer.pointUnits,
            prayerPoints:
              committedPrayer.pointUnits <= 0
                ? 0
                : Math.ceil(
                    committedPrayer.pointUnits / PRAYER_POINT_UNITS_PER_POINT,
                  ),
            prayerMaxPoints: committedPrayer.maxPoints,
          })
          .where(eq(schema.characters.id, playerId));
        await tx.insert(schema.boneBurialOperations).values({
          operationId,
          playerId,
          itemId,
          xpAmount,
          levelRequired,
          awardedXp,
          operationCommittedXp,
          committedLevel: currentLevel,
          requestFingerprint,
        });

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          itemId,
          xpAmount,
          levelRequired,
          awardedXp,
          operationCommittedXp,
          currentXp: operationCommittedXp,
          currentLevel,
          committed,
        };
      },
      { isolationLevel: "serializable" },
    );
    return this.trackAwaitedOperation(operation);
  }

  /**
   * Create one quest incarnation and credit every authored starter item in the
   * same serializable transaction. Replays verify the immutable progress and
   * audit identities, then return the current locked inventory projection.
   */
  async commitQuestStartOperationAsync(
    request: QuestStartCommitRequest,
  ): Promise<QuestStartCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("quest_start_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const questId = String(request.questId ?? "").trim();
    const questStartedAt = Number(request.questStartedAt);
    const initialStage = String(request.initialStage ?? "").trim();
    let items: QuestStartRewardItem[];
    try {
      items = normalizeQuestStartItems(request.items);
    } catch {
      throw new Error("quest_start_request_invalid");
    }
    if (
      !playerId ||
      playerId.length > 256 ||
      !questId ||
      questId.length > 256 ||
      !initialStage ||
      initialStage.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(playerId) ||
      /[\u0000-\u001f\u007f]/u.test(questId) ||
      /[\u0000-\u001f\u007f]/u.test(initialStage) ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt <= 0 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      operationId !==
        questStartOperationId(playerId, questId, questStartedAt) ||
      requestFingerprint !==
        questStartFingerprint(
          playerId,
          questId,
          questStartedAt,
          initialStage,
          items,
        )
    ) {
      throw new Error("quest_start_request_invalid");
    }

    const operation = this.executeInTransaction(
      async (tx) => {
        // A row-version write is the serializable per-character fence. It
        // forces simultaneous authorities to restart from current quest and
        // inventory state instead of continuing with a stale snapshot.
        await tx.execute(
          sql`UPDATE "characters" SET "createdAt" = "createdAt" WHERE "id" = ${playerId}`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (characterRows.length !== 1) {
          throw new Error("quest_start_player_missing");
        }
        await tx.execute(
          sql`SELECT "id" FROM "quest_progress" WHERE "playerId" = ${playerId} AND "questId" = ${questId} FOR UPDATE`,
        );
        const questRows = await tx
          .select({
            status: schema.questProgress.status,
            currentStage: schema.questProgress.currentStage,
            stageProgress: schema.questProgress.stageProgress,
            startedAt: schema.questProgress.startedAt,
            completedAt: schema.questProgress.completedAt,
          })
          .from(schema.questProgress)
          .where(
            and(
              eq(schema.questProgress.playerId, playerId),
              eq(schema.questProgress.questId, questId),
            ),
          );

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredQuestStartOperation | undefined;
          let storedItems: QuestStartRewardItem[];
          try {
            storedItems = normalizeQuestStartItems(state?.items ?? []);
          } catch {
            throw new Error("quest_start_operation_id_conflict");
          }
          const quest = questRows[0];
          if (
            existingRows.length !== 1 ||
            existing.playerId !== playerId ||
            existing.operationType !== "quest_start" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.questId !== questId ||
            state.questStartedAt !== questStartedAt ||
            state.initialStage !== initialStage ||
            JSON.stringify(storedItems) !== JSON.stringify(items) ||
            questRows.length !== 1 ||
            !quest ||
            (quest.status !== "in_progress" && quest.status !== "completed") ||
            Number(quest.startedAt) !== questStartedAt ||
            (quest.status === "completed"
              ? !Number.isSafeInteger(Number(quest.completedAt)) ||
                Number(quest.completedAt) <= 0
              : quest.completedAt != null)
          ) {
            throw new Error("quest_start_operation_id_conflict");
          }
          const auditRows = await tx
            .select({
              stageId: schema.questAuditLog.stageId,
              stageProgress: schema.questAuditLog.stageProgress,
              timestamp: schema.questAuditLog.timestamp,
              metadata: schema.questAuditLog.metadata,
            })
            .from(schema.questAuditLog)
            .where(
              and(
                eq(schema.questAuditLog.playerId, playerId),
                eq(schema.questAuditLog.questId, questId),
                eq(schema.questAuditLog.action, "started"),
                sql<boolean>`${schema.questAuditLog.metadata}->>'operationId' = ${operationId}`,
              ),
            );
          const audit = auditRows[0];
          if (
            auditRows.length !== 1 ||
            !audit ||
            audit.stageId !== initialStage ||
            JSON.stringify(audit.stageProgress ?? {}) !== "{}" ||
            Number(audit.timestamp) !== questStartedAt ||
            !audit.metadata ||
            typeof audit.metadata !== "object" ||
            Array.isArray(audit.metadata) ||
            (audit.metadata as Record<string, unknown>).requestFingerprint !==
              requestFingerprint
          ) {
            throw new Error("quest_start_operation_id_conflict");
          }
          const inventoryRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            questId,
            questStartedAt,
            initialStage,
            items,
            committed: normalizePersistedInventoryRows(
              inventoryRows,
              "quest_start",
            ),
          } satisfies QuestStartCommitReceipt;
        }

        if (questRows.length !== 0) {
          throw new Error("quest_start_progress_state_conflict");
        }
        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        let committed = normalizePersistedInventoryRows(
          inventoryRows,
          "quest_start",
        );
        for (const item of items) {
          committed = creditGatheringReward(committed, item, "quest_start");
        }

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        await tx.insert(schema.questProgress).values({
          playerId,
          questId,
          status: "in_progress",
          currentStage: initialStage,
          stageProgress: {},
          startedAt: questStartedAt,
        });
        await tx.insert(schema.questAuditLog).values({
          playerId,
          questId,
          action: "started",
          stageId: initialStage,
          stageProgress: {},
          timestamp: questStartedAt,
          metadata: { operationId, requestFingerprint },
        });
        const operationState: StoredQuestStartOperation = {
          version: 1,
          requestFingerprint,
          questId,
          questStartedAt,
          initialStage,
          items,
        };
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "quest_start",
          operationState,
          completed: true,
          timestamp: questStartedAt,
          completedAt: questStartedAt,
        });
        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          questId,
          questStartedAt,
          initialStage,
          items,
          committed,
        } satisfies QuestStartCommitReceipt;
      },
      {
        isolationLevel: "serializable",
        maxConflictRetries: 3,
        conflictRetryBaseDelayMs: 5,
      },
    );
    return this.trackAwaitedOperation(operation);
  }

  /**
   * Commit one exact quest incarnation and every authored completion reward as
   * a single serializable transition. A response retry reads current locked
   * state while retaining the original operation deltas, so delayed replay
   * cannot duplicate or regress later quest, inventory, or skill progress.
   */
  async commitQuestCompletionOperationAsync(
    request: QuestCompletionCommitRequest,
  ): Promise<QuestCompletionCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("quest_completion_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const questId = String(request.questId ?? "").trim();
    const questStartedAt = Number(request.questStartedAt);
    const expectedStage = String(request.expectedStage ?? "").trim();
    const questPoints = Number(request.questPoints);
    let expectedProgress: Record<string, number>;
    let items: QuestCompletionRewardItem[];
    let xp: QuestCompletionRewardXp[];
    try {
      expectedProgress = normalizeQuestCompletionProgress(
        request.expectedProgress,
      );
      items = normalizeQuestCompletionItems(request.items);
      xp = normalizeQuestCompletionXp(request.xp);
    } catch {
      throw new Error("quest_completion_request_invalid");
    }
    if (
      !playerId ||
      playerId.length > 256 ||
      !questId ||
      questId.length > 256 ||
      !expectedStage ||
      expectedStage.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(playerId) ||
      /[\u0000-\u001f\u007f]/u.test(questId) ||
      /[\u0000-\u001f\u007f]/u.test(expectedStage) ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt <= 0 ||
      !Number.isSafeInteger(questPoints) ||
      questPoints < 0 ||
      questPoints > MAX_QUEST_POINTS ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      operationId !==
        questCompletionOperationId(playerId, questId, questStartedAt) ||
      requestFingerprint !==
        questCompletionFingerprint(
          playerId,
          questId,
          questStartedAt,
          expectedStage,
          expectedProgress,
          questPoints,
          items,
          xp,
        )
    ) {
      throw new Error("quest_completion_request_invalid");
    }

    const operation = this.executeInTransaction(
      async (tx) => {
        // Make the per-character fence an MVCC write so PostgreSQL can reject
        // and retry a simultaneous serializable completion from a fresh state.
        await tx.execute(
          sql`UPDATE "characters" SET "createdAt" = "createdAt" WHERE "id" = ${playerId}`,
        );
        await tx.execute(
          sql`SELECT "id" FROM "quest_progress" WHERE "playerId" = ${playerId} AND "questId" = ${questId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            questPoints: schema.characters.questPoints,
            attackXp: schema.characters.attackXp,
            attackLevel: schema.characters.attackLevel,
            strengthXp: schema.characters.strengthXp,
            strengthLevel: schema.characters.strengthLevel,
            defenseXp: schema.characters.defenseXp,
            defenseLevel: schema.characters.defenseLevel,
            constitutionXp: schema.characters.constitutionXp,
            constitutionLevel: schema.characters.constitutionLevel,
            rangedXp: schema.characters.rangedXp,
            rangedLevel: schema.characters.rangedLevel,
            magicXp: schema.characters.magicXp,
            magicLevel: schema.characters.magicLevel,
            prayerXp: schema.characters.prayerXp,
            prayerLevel: schema.characters.prayerLevel,
            prayerPoints: schema.characters.prayerPoints,
            prayerPointUnits: schema.characters.prayerPointUnits,
            prayerMaxPoints: schema.characters.prayerMaxPoints,
            activePrayers: schema.characters.activePrayers,
            woodcuttingXp: schema.characters.woodcuttingXp,
            woodcuttingLevel: schema.characters.woodcuttingLevel,
            miningXp: schema.characters.miningXp,
            miningLevel: schema.characters.miningLevel,
            fishingXp: schema.characters.fishingXp,
            fishingLevel: schema.characters.fishingLevel,
            firemakingXp: schema.characters.firemakingXp,
            firemakingLevel: schema.characters.firemakingLevel,
            cookingXp: schema.characters.cookingXp,
            cookingLevel: schema.characters.cookingLevel,
            smithingXp: schema.characters.smithingXp,
            smithingLevel: schema.characters.smithingLevel,
            agilityXp: schema.characters.agilityXp,
            agilityLevel: schema.characters.agilityLevel,
            craftingXp: schema.characters.craftingXp,
            craftingLevel: schema.characters.craftingLevel,
            fletchingXp: schema.characters.fletchingXp,
            fletchingLevel: schema.characters.fletchingLevel,
            runecraftingXp: schema.characters.runecraftingXp,
            runecraftingLevel: schema.characters.runecraftingLevel,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) throw new Error("quest_completion_player_missing");

        const skillState: Record<
          QuestRewardSkill,
          { xp: number; level: number }
        > = {
          attack: {
            xp: Number(character.attackXp ?? 0),
            level: Number(character.attackLevel ?? 1),
          },
          strength: {
            xp: Number(character.strengthXp ?? 0),
            level: Number(character.strengthLevel ?? 1),
          },
          defense: {
            xp: Number(character.defenseXp ?? 0),
            level: Number(character.defenseLevel ?? 1),
          },
          constitution: {
            xp: Number(character.constitutionXp ?? 0),
            level: Number(character.constitutionLevel ?? 1),
          },
          ranged: {
            xp: Number(character.rangedXp ?? 0),
            level: Number(character.rangedLevel ?? 1),
          },
          magic: {
            xp: Number(character.magicXp ?? 0),
            level: Number(character.magicLevel ?? 1),
          },
          prayer: {
            xp: Number(character.prayerXp ?? 0),
            level: Number(character.prayerLevel ?? 1),
          },
          woodcutting: {
            xp: Number(character.woodcuttingXp),
            level: Number(character.woodcuttingLevel ?? 1),
          },
          mining: {
            xp: Number(character.miningXp),
            level: Number(character.miningLevel ?? 1),
          },
          fishing: {
            xp: Number(character.fishingXp),
            level: Number(character.fishingLevel ?? 1),
          },
          firemaking: {
            xp: Number(character.firemakingXp),
            level: Number(character.firemakingLevel ?? 1),
          },
          cooking: {
            xp: Number(character.cookingXp),
            level: Number(character.cookingLevel ?? 1),
          },
          smithing: {
            xp: Number(character.smithingXp),
            level: Number(character.smithingLevel ?? 1),
          },
          agility: {
            xp: Number(character.agilityXp ?? 0),
            level: Number(character.agilityLevel ?? 1),
          },
          crafting: {
            xp: Number(character.craftingXp),
            level: Number(character.craftingLevel ?? 1),
          },
          fletching: {
            xp: Number(character.fletchingXp),
            level: Number(character.fletchingLevel ?? 1),
          },
          runecrafting: {
            xp: Number(character.runecraftingXp),
            level: Number(character.runecraftingLevel ?? 1),
          },
        };
        for (const value of Object.values(skillState)) {
          if (
            !Number.isFinite(value.xp) ||
            value.xp < 0 ||
            value.xp > MAX_SKILL_XP ||
            !Number.isSafeInteger(value.level) ||
            value.level < 1 ||
            value.level > 99 ||
            skillLevelForXp(value.xp) !== value.level
          ) {
            throw new Error("quest_completion_skill_state_invalid");
          }
        }
        const persistedPrayer = normalizePrayerSnapshot(
          {
            pointUnits:
              character.prayerPointUnits ??
              (character.prayerPoints ?? skillState.prayer.level) *
                PRAYER_POINT_UNITS_PER_POINT,
            maxPoints: character.prayerMaxPoints ?? skillState.prayer.level,
            activePrayers: character.activePrayers ?? [],
          },
          "quest_completion",
        );
        if (persistedPrayer.maxPoints !== skillState.prayer.level) {
          throw new Error("quest_completion_prayer_state_invalid");
        }
        const currentQuestPoints = Number(character.questPoints ?? 0);
        if (
          !Number.isSafeInteger(currentQuestPoints) ||
          currentQuestPoints < 0 ||
          currentQuestPoints > MAX_PERSISTED_ITEM_QUANTITY
        ) {
          throw new Error("quest_completion_points_state_invalid");
        }

        const questRows = await tx
          .select({
            status: schema.questProgress.status,
            currentStage: schema.questProgress.currentStage,
            stageProgress: schema.questProgress.stageProgress,
            startedAt: schema.questProgress.startedAt,
            completedAt: schema.questProgress.completedAt,
          })
          .from(schema.questProgress)
          .where(
            and(
              eq(schema.questProgress.playerId, playerId),
              eq(schema.questProgress.questId, questId),
            ),
          );
        const quest = questRows[0];
        if (!quest || questRows.length !== 1) {
          throw new Error("quest_completion_progress_missing");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredQuestCompletionOperation | undefined;
          let storedProgress: Record<string, number>;
          let storedItems: QuestCompletionRewardItem[];
          let storedXp: QuestCompletionRewardXp[];
          try {
            storedProgress = normalizeQuestCompletionProgress(
              state?.expectedProgress ?? {},
            );
            storedItems = normalizeQuestCompletionItems(state?.items ?? []);
            storedXp = normalizeQuestCompletionXp(state?.xp ?? []);
          } catch {
            throw new Error("quest_completion_operation_id_conflict");
          }
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "quest_completion" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.questId !== questId ||
            state.questStartedAt !== questStartedAt ||
            state.expectedStage !== expectedStage ||
            JSON.stringify(storedProgress) !==
              JSON.stringify(expectedProgress) ||
            state.questPoints !== questPoints ||
            JSON.stringify(storedItems) !== JSON.stringify(items) ||
            JSON.stringify(storedXp) !== JSON.stringify(xp) ||
            !Number.isSafeInteger(state.completedAt) ||
            state.completedAt <= 0 ||
            !Number.isSafeInteger(state.operationCommittedQuestPoints) ||
            state.operationCommittedQuestPoints < questPoints ||
            state.operationCommittedQuestPoints > MAX_PERSISTED_ITEM_QUANTITY ||
            !Array.isArray(state.progress) ||
            state.progress.length !== xp.length ||
            quest.status !== "completed" ||
            Number(quest.startedAt) !== questStartedAt ||
            Number(quest.completedAt) !== state.completedAt ||
            String(quest.currentStage ?? "") !== expectedStage ||
            JSON.stringify(
              normalizeQuestCompletionProgress(
                (quest.stageProgress ?? {}) as Record<string, number>,
              ),
            ) !== JSON.stringify(expectedProgress) ||
            currentQuestPoints < state.operationCommittedQuestPoints
          ) {
            throw new Error("quest_completion_operation_id_conflict");
          }

          const progress: QuestCompletionProgressReceipt[] = [];
          for (let index = 0; index < state.progress.length; index++) {
            const stored = state.progress[index];
            const expected = xp[index];
            const current = skillState[expected.skill];
            if (
              stored.skill !== expected.skill ||
              stored.xpAmount !== expected.xpAmount ||
              !Number.isFinite(stored.awardedXp) ||
              stored.awardedXp < 0 ||
              stored.awardedXp > expected.xpAmount ||
              !Number.isFinite(stored.operationCommittedXp) ||
              stored.operationCommittedXp < stored.awardedXp ||
              stored.operationCommittedXp > MAX_SKILL_XP ||
              current.xp < stored.operationCommittedXp
            ) {
              throw new Error("quest_completion_operation_id_conflict");
            }
            progress.push({
              ...stored,
              currentXp: current.xp,
              currentLevel: current.level,
            });
          }

          const inventoryRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          const auditRows = await tx
            .select({
              questPointsAwarded: schema.questAuditLog.questPointsAwarded,
              stageId: schema.questAuditLog.stageId,
              stageProgress: schema.questAuditLog.stageProgress,
              timestamp: schema.questAuditLog.timestamp,
              metadata: schema.questAuditLog.metadata,
            })
            .from(schema.questAuditLog)
            .where(
              and(
                eq(schema.questAuditLog.playerId, playerId),
                eq(schema.questAuditLog.questId, questId),
                eq(schema.questAuditLog.action, "completed"),
                sql<boolean>`${schema.questAuditLog.metadata}->>'operationId' = ${operationId}`,
              ),
            );
          const audit = auditRows[0];
          if (
            auditRows.length !== 1 ||
            !audit ||
            Number(audit.questPointsAwarded) !== questPoints ||
            audit.stageId !== expectedStage ||
            Number(audit.timestamp) !== state.completedAt ||
            JSON.stringify(
              normalizeQuestCompletionProgress(
                (audit.stageProgress ?? {}) as Record<string, number>,
              ),
            ) !== JSON.stringify(expectedProgress) ||
            !audit.metadata ||
            typeof audit.metadata !== "object" ||
            Array.isArray(audit.metadata) ||
            (audit.metadata as Record<string, unknown>).requestFingerprint !==
              requestFingerprint
          ) {
            throw new Error("quest_completion_operation_id_conflict");
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            questId,
            questStartedAt,
            expectedStage,
            expectedProgress,
            completedAt: state.completedAt,
            questPoints,
            operationCommittedQuestPoints: state.operationCommittedQuestPoints,
            currentQuestPoints,
            items,
            xp,
            progress,
            prayer: xp.some((entry) => entry.skill === "prayer")
              ? persistedPrayer
              : null,
            committed: normalizePersistedInventoryRows(
              inventoryRows,
              "quest_completion",
            ),
          } satisfies QuestCompletionCommitReceipt;
        }

        let persistedStageProgress: Record<string, number>;
        try {
          persistedStageProgress = normalizeQuestCompletionProgress(
            (quest.stageProgress ?? {}) as Record<string, number>,
          );
        } catch {
          throw new Error("quest_completion_progress_state_invalid");
        }
        if (
          quest.status !== "in_progress" ||
          Number(quest.startedAt) !== questStartedAt ||
          String(quest.currentStage ?? "") !== expectedStage ||
          JSON.stringify(persistedStageProgress) !==
            JSON.stringify(expectedProgress) ||
          quest.completedAt != null
        ) {
          throw new Error("quest_completion_progress_state_conflict");
        }

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        let committed = normalizePersistedInventoryRows(
          inventoryRows,
          "quest_completion",
        );
        for (const item of items) {
          committed = creditGatheringReward(
            committed,
            item,
            "quest_completion",
          );
        }

        const characterUpdate: GenericCharacterUpdate = {};
        const nextSkillState: Record<
          QuestRewardSkill,
          { xp: number; level: number }
        > = Object.fromEntries(
          Object.entries(skillState).map(([skill, value]) => [
            skill,
            { ...value },
          ]),
        ) as Record<QuestRewardSkill, { xp: number; level: number }>;
        const progress: QuestCompletionProgressReceipt[] = [];
        let committedPrayer = persistedPrayer;
        for (const reward of xp) {
          const persisted = skillState[reward.skill];
          const operationCommittedXp = Math.min(
            persisted.xp + reward.xpAmount,
            MAX_SKILL_XP,
          );
          const awardedXp = operationCommittedXp - persisted.xp;
          const currentLevel = skillLevelForXp(operationCommittedXp);
          nextSkillState[reward.skill] = {
            xp: operationCommittedXp,
            level: currentLevel,
          };
          progress.push({
            ...reward,
            awardedXp,
            operationCommittedXp,
            currentXp: operationCommittedXp,
            currentLevel,
          });
          switch (reward.skill) {
            case "attack":
              characterUpdate.attackXp = operationCommittedXp;
              characterUpdate.attackLevel = currentLevel;
              break;
            case "strength":
              characterUpdate.strengthXp = operationCommittedXp;
              characterUpdate.strengthLevel = currentLevel;
              break;
            case "defense":
              characterUpdate.defenseXp = operationCommittedXp;
              characterUpdate.defenseLevel = currentLevel;
              break;
            case "constitution":
              characterUpdate.constitutionXp = operationCommittedXp;
              characterUpdate.constitutionLevel = currentLevel;
              break;
            case "ranged":
              characterUpdate.rangedXp = operationCommittedXp;
              characterUpdate.rangedLevel = currentLevel;
              break;
            case "magic":
              characterUpdate.magicXp = operationCommittedXp;
              characterUpdate.magicLevel = currentLevel;
              break;
            case "prayer": {
              characterUpdate.prayerXp = operationCommittedXp;
              characterUpdate.prayerLevel = currentLevel;
              const levelIncreased = currentLevel > persisted.level;
              committedPrayer = {
                pointUnits: levelIncreased
                  ? currentLevel * PRAYER_POINT_UNITS_PER_POINT
                  : persistedPrayer.pointUnits,
                maxPoints: levelIncreased
                  ? currentLevel
                  : persistedPrayer.maxPoints,
                activePrayers: persistedPrayer.activePrayers,
              };
              characterUpdate.prayerPointUnits = committedPrayer.pointUnits;
              characterUpdate.prayerPoints =
                committedPrayer.pointUnits <= 0
                  ? 0
                  : Math.ceil(
                      committedPrayer.pointUnits / PRAYER_POINT_UNITS_PER_POINT,
                    );
              characterUpdate.prayerMaxPoints = committedPrayer.maxPoints;
              break;
            }
            case "woodcutting":
              characterUpdate.woodcuttingXp = operationCommittedXp;
              characterUpdate.woodcuttingLevel = currentLevel;
              break;
            case "mining":
              characterUpdate.miningXp = operationCommittedXp;
              characterUpdate.miningLevel = currentLevel;
              break;
            case "fishing":
              characterUpdate.fishingXp = operationCommittedXp;
              characterUpdate.fishingLevel = currentLevel;
              break;
            case "firemaking":
              characterUpdate.firemakingXp = operationCommittedXp;
              characterUpdate.firemakingLevel = currentLevel;
              break;
            case "cooking":
              characterUpdate.cookingXp = operationCommittedXp;
              characterUpdate.cookingLevel = currentLevel;
              break;
            case "smithing":
              characterUpdate.smithingXp = operationCommittedXp;
              characterUpdate.smithingLevel = currentLevel;
              break;
            case "agility":
              characterUpdate.agilityXp = operationCommittedXp;
              characterUpdate.agilityLevel = currentLevel;
              break;
            case "crafting":
              characterUpdate.craftingXp = operationCommittedXp;
              characterUpdate.craftingLevel = currentLevel;
              break;
            case "fletching":
              characterUpdate.fletchingXp = operationCommittedXp;
              characterUpdate.fletchingLevel = currentLevel;
              break;
            case "runecrafting":
              characterUpdate.runecraftingXp = operationCommittedXp;
              characterUpdate.runecraftingLevel = currentLevel;
              break;
          }
        }

        const operationCommittedQuestPoints = currentQuestPoints + questPoints;
        if (
          !Number.isSafeInteger(operationCommittedQuestPoints) ||
          operationCommittedQuestPoints > MAX_PERSISTED_ITEM_QUANTITY
        ) {
          throw new Error("quest_completion_points_overflow");
        }
        characterUpdate.questPoints = operationCommittedQuestPoints;
        if (
          xp.some((entry) =>
            [
              "attack",
              "strength",
              "defense",
              "constitution",
              "ranged",
              "magic",
              "prayer",
            ].includes(entry.skill),
          )
        ) {
          characterUpdate.combatLevel = calculateCombatLevel({
            attack: nextSkillState.attack.level,
            strength: nextSkillState.strength.level,
            defense: nextSkillState.defense.level,
            hitpoints: nextSkillState.constitution.level,
            ranged: nextSkillState.ranged.level,
            magic: nextSkillState.magic.level,
            prayer: nextSkillState.prayer.level,
          });
        }

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        await tx
          .update(schema.characters)
          .set(characterUpdate)
          .where(eq(schema.characters.id, playerId));

        const completedAt = Date.now();
        const completedRows = await tx
          .update(schema.questProgress)
          .set({ status: "completed", completedAt })
          .where(
            and(
              eq(schema.questProgress.playerId, playerId),
              eq(schema.questProgress.questId, questId),
              eq(schema.questProgress.status, "in_progress"),
              eq(schema.questProgress.startedAt, questStartedAt),
              eq(schema.questProgress.currentStage, expectedStage),
            ),
          )
          .returning({ id: schema.questProgress.id });
        if (completedRows.length !== 1) {
          throw new Error("quest_completion_progress_state_conflict");
        }
        await tx.insert(schema.questAuditLog).values({
          playerId,
          questId,
          action: "completed",
          questPointsAwarded: questPoints,
          stageId: expectedStage,
          stageProgress: expectedProgress,
          timestamp: completedAt,
          metadata: { operationId, requestFingerprint },
        });
        const operationState: StoredQuestCompletionOperation = {
          version: 1,
          requestFingerprint,
          questId,
          questStartedAt,
          expectedStage,
          expectedProgress,
          completedAt,
          questPoints,
          operationCommittedQuestPoints,
          items,
          xp,
          progress: progress.map(
            ({ skill, xpAmount, awardedXp, operationCommittedXp }) => ({
              skill,
              xpAmount,
              awardedXp,
              operationCommittedXp,
            }),
          ),
        };
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "quest_completion",
          operationState,
          completed: true,
          timestamp: completedAt,
          completedAt,
        });

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          questId,
          questStartedAt,
          expectedStage,
          expectedProgress,
          completedAt,
          questPoints,
          operationCommittedQuestPoints,
          currentQuestPoints: operationCommittedQuestPoints,
          items,
          xp,
          progress,
          prayer: xp.some((entry) => entry.skill === "prayer")
            ? committedPrayer
            : null,
          committed,
        } satisfies QuestCompletionCommitReceipt;
      },
      {
        isolationLevel: "serializable",
        maxConflictRetries: 3,
        conflictRetryBaseDelayMs: 5,
      },
    );
    return this.trackAwaitedOperation(operation);
  }

  /**
   * Commit one successful gathering roll as a single custody transition. A
   * secondary input, the harvested item, the matching XP/level, and the
   * operation receipt either all commit or all roll back.
   */
  async commitGatheringRewardOperationAsync(
    request: GatheringRewardCommitRequest,
  ): Promise<GatheringRewardCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("gathering_reward_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const resourceId = String(request.resourceId ?? "").trim();
    const depleteAfterCommit = request.depleteAfterCommit === true;
    const respawnTicks = Number(request.respawnTicks);
    const skill = String(request.skill ?? "").trim() as GatheringRewardSkill;
    const xpAmount = Number(request.xpAmount);
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      !resourceId ||
      resourceId.length > 256 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      typeof request.depleteAfterCommit !== "boolean" ||
      !Number.isSafeInteger(respawnTicks) ||
      respawnTicks < 0 ||
      respawnTicks > 10_000_000 ||
      (depleteAfterCommit && respawnTicks <= 0) ||
      !GATHERING_REWARD_SKILLS.has(skill) ||
      !Number.isFinite(xpAmount) ||
      xpAmount <= 0 ||
      xpAmount > MAX_GATHERING_REWARD_XP
    ) {
      throw new Error("gathering_reward_request_invalid");
    }
    const reward = normalizeGatheringReward(request.reward);
    const secondaryItemId = normalizeGatheringSecondaryItemId(
      request.secondaryItemId,
    );
    if (
      requestFingerprint !==
      gatheringRewardFingerprint(
        playerId,
        resourceId,
        depleteAfterCommit,
        respawnTicks,
        skill,
        xpAmount,
        reward,
        secondaryItemId,
      )
    ) {
      throw new Error("gathering_reward_request_invalid");
    }

    const operation = this.executeInTransaction(
      async (tx) => {
        // Stable resource identity serializes independent player authorities
        // before either inventory custody or node availability is inspected.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${resourceId}, 0))`,
        );
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            woodcuttingXp: schema.characters.woodcuttingXp,
            miningXp: schema.characters.miningXp,
            fishingXp: schema.characters.fishingXp,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) throw new Error("gathering_reward_player_missing");

        const persistedXp = Number(
          skill === "woodcutting"
            ? character.woodcuttingXp
            : skill === "mining"
              ? character.miningXp
              : character.fishingXp,
        );
        if (
          !Number.isFinite(persistedXp) ||
          persistedXp < 0 ||
          persistedXp > MAX_SKILL_XP
        ) {
          throw new Error("gathering_reward_skill_state_invalid");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredGatheringRewardOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "gathering_reward" ||
            existing.completed !== true ||
            state?.version !== 2 ||
            state.requestFingerprint !== requestFingerprint ||
            state.resourceId !== resourceId ||
            state.depleteAfterCommit !== depleteAfterCommit ||
            state.respawnTicks !== respawnTicks ||
            (state.depletedUntil !== null &&
              (!Number.isSafeInteger(state.depletedUntil) ||
                state.depletedUntil <= 0)) ||
            depleteAfterCommit !== (state.depletedUntil !== null) ||
            state.skill !== skill ||
            state.xpAmount !== xpAmount ||
            JSON.stringify(state.reward) !== JSON.stringify(reward) ||
            state.secondaryItemId !== secondaryItemId ||
            !Number.isFinite(state.awardedXp) ||
            state.awardedXp < 0 ||
            state.awardedXp > xpAmount ||
            !Number.isFinite(state.operationCommittedXp)
          ) {
            throw new Error("gathering_reward_operation_id_conflict");
          }
          const currentRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            resourceId,
            depleteAfterCommit,
            respawnTicks,
            depletedUntil: state.depletedUntil,
            skill,
            xpAmount,
            reward,
            secondaryItemId,
            awardedXp: state.awardedXp,
            operationCommittedXp: state.operationCommittedXp,
            currentXp: persistedXp,
            currentLevel: skillLevelForXp(persistedXp),
            committed: normalizePersistedInventoryRows(
              currentRows,
              "gathering_reward",
            ),
          };
        }

        const activeResourceRows = await tx
          .select({ respawnAt: schema.gatheringResourceStates.respawnAt })
          .from(schema.gatheringResourceStates)
          .where(eq(schema.gatheringResourceStates.resourceId, resourceId));
        const activeRespawnAt = Number(activeResourceRows[0]?.respawnAt ?? 0);
        if (Number.isFinite(activeRespawnAt) && activeRespawnAt > Date.now()) {
          throw new Error("gathering_reward_resource_unavailable");
        }

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        let committed = normalizePersistedInventoryRows(
          inventoryRows,
          "gathering_reward",
        );
        if (secondaryItemId) {
          try {
            committed = debitInventorySnapshot(committed, [
              { itemId: secondaryItemId, quantity: 1 },
            ]);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes("inventory_debit_insufficient_items")
            ) {
              throw new Error("gathering_reward_secondary_missing");
            }
            throw error;
          }
        }
        committed = creditGatheringReward(committed, reward);

        const operationCommittedXp = Math.min(
          persistedXp + xpAmount,
          MAX_SKILL_XP,
        );
        const awardedXp = operationCommittedXp - persistedXp;
        const currentLevel = skillLevelForXp(operationCommittedXp);
        const skillUpdate =
          skill === "woodcutting"
            ? {
                woodcuttingXp: operationCommittedXp,
                woodcuttingLevel: currentLevel,
              }
            : skill === "mining"
              ? {
                  miningXp: operationCommittedXp,
                  miningLevel: currentLevel,
                }
              : {
                  fishingXp: operationCommittedXp,
                  fishingLevel: currentLevel,
                };

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        await tx
          .update(schema.characters)
          .set(skillUpdate)
          .where(eq(schema.characters.id, playerId));

        const now = Date.now();
        const depletedUntil = depleteAfterCommit
          ? now + respawnTicks * TICK_DURATION_MS
          : null;
        if (
          depletedUntil !== null &&
          (!Number.isSafeInteger(depletedUntil) || depletedUntil <= now)
        ) {
          throw new Error("gathering_reward_request_invalid");
        }
        const operationState: StoredGatheringRewardOperation = {
          version: 2,
          requestFingerprint,
          resourceId,
          depleteAfterCommit,
          respawnTicks,
          depletedUntil,
          skill,
          xpAmount,
          reward,
          secondaryItemId,
          awardedXp,
          operationCommittedXp,
        };
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "gathering_reward",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });

        const activeQuestRows = await tx
          .select({
            questId: schema.questProgress.questId,
            currentStage: schema.questProgress.currentStage,
            startedAt: schema.questProgress.startedAt,
          })
          .from(schema.questProgress)
          .where(
            and(
              eq(schema.questProgress.playerId, playerId),
              eq(schema.questProgress.status, "in_progress"),
            ),
          );
        const questContexts = activeQuestRows.map((row) => ({
          questId: String(row.questId ?? "").trim(),
          currentStage: String(row.currentStage ?? "").trim(),
          startedAt: Number(row.startedAt),
        }));
        if (
          questContexts.some(
            (context) =>
              !context.questId ||
              context.questId.length > 256 ||
              !context.currentStage ||
              context.currentStage.length > 256 ||
              !Number.isSafeInteger(context.startedAt) ||
              context.startedAt < 0,
          )
        ) {
          throw new Error("gathering_reward_quest_state_invalid");
        }
        if (questContexts.length > 0) {
          await tx.insert(schema.questGatheringProgressReceipts).values(
            questContexts.map((context) => ({
              operationId,
              playerId,
              questId: context.questId,
              questStartedAt: context.startedAt,
              capturedStage: context.currentStage,
              rewardItemId: reward.itemId,
              rewardQuantity: reward.quantity,
              createdAt: now,
            })),
          );
        }
        if (depletedUntil !== null) {
          await tx
            .insert(schema.gatheringResourceStates)
            .values({
              resourceId,
              operationId,
              depletedAt: now,
              respawnAt: depletedUntil,
            })
            .onConflictDoUpdate({
              target: schema.gatheringResourceStates.resourceId,
              set: {
                operationId,
                depletedAt: now,
                respawnAt: depletedUntil,
              },
            });
        }

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          resourceId,
          depleteAfterCommit,
          respawnTicks,
          depletedUntil,
          skill,
          xpAmount,
          reward,
          secondaryItemId,
          awardedXp,
          operationCommittedXp,
          currentXp: operationCommittedXp,
          currentLevel,
          committed,
        };
      },
      // The advisory resource lock and character row lock explicitly serialize
      // every state this transition reads. READ COMMITTED lets advisory-lock
      // waiters observe the winner's newly committed depletion row.
      { isolationLevel: "read committed" },
    );
    return this.trackAwaitedOperation(operation);
  }

  /** Load active depletion state in one query for a terrain spawn batch. */
  async getGatheringResourceStatesAsync(
    resourceIds: string[],
  ): Promise<GatheringResourceState[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("gathering_reward_database_unavailable");
    }
    const normalized = [
      ...new Set(
        resourceIds.map((resourceId) => String(resourceId ?? "").trim()),
      ),
    ];
    if (
      normalized.length > 10_000 ||
      normalized.some((resourceId) => !resourceId || resourceId.length > 256)
    ) {
      throw new Error("gathering_reward_request_invalid");
    }
    if (normalized.length === 0) return [];

    const rows = await this.db
      .select({
        resourceId: schema.gatheringResourceStates.resourceId,
        operationId: schema.gatheringResourceStates.operationId,
        depletedAt: schema.gatheringResourceStates.depletedAt,
        respawnAt: schema.gatheringResourceStates.respawnAt,
      })
      .from(schema.gatheringResourceStates)
      .where(
        and(
          inArray(schema.gatheringResourceStates.resourceId, normalized),
          gt(schema.gatheringResourceStates.respawnAt, Date.now()),
        ),
      );
    return rows.map((row) => ({
      resourceId: row.resourceId,
      operationId: row.operationId,
      depletedAt: Number(row.depletedAt),
      respawnAt: Number(row.respawnAt),
    }));
  }

  /**
   * Persist one correlated processing request before its timed action starts.
   * The character-row lock makes this the cross-process single-action boundary
   * for every processing family. A new server authority may take over the same
   * exact request, but a second request for that player remains busy.
   */
  async beginProcessingRequestAsync(
    playerId: string,
    operationId: string,
    requestId: string,
    skill: ProcessingSkill,
    envelope: ProcessingRequestEnvelope,
  ): Promise<"accepted" | "pending" | "committed" | "busy" | "rejected"> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedRequestId = normalizeProcessingRequestId(requestId);
    const normalizedOperationId = String(operationId ?? "").trim();
    const normalizedEnvelope = normalizeProcessingRequestEnvelope(
      skill,
      envelope,
    );
    if (
      !normalizedPlayerId ||
      !normalizedRequestId ||
      !normalizedEnvelope ||
      !PROCESSING_REQUEST_SKILLS.has(skill) ||
      normalizedOperationId !==
        getProcessingRequestOperationId(skill, normalizedRequestId)
    ) {
      throw new Error("processing_action_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${normalizedPlayerId} FOR UPDATE`,
        );
        const waiterId = processingWaiterOperationId(normalizedPlayerId);
        const waiterRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, waiterId));
        const waiterRow = waiterRows[0];
        const waiterState = waiterRow
          ? normalizeStoredProcessingWaiter(waiterRow.operationState)
          : null;
        if (
          waiterRow &&
          (waiterRow.playerId !== normalizedPlayerId ||
            waiterRow.operationType !== "processing_waiter" ||
            !waiterState ||
            (waiterRow.completed === false &&
              waiterState.acknowledgedAt !== null) ||
            (waiterRow.completed === true &&
              waiterState.acknowledgedAt === null))
        ) {
          throw new Error("processing_action_waiter_state_invalid");
        }
        const activeWaiter =
          waiterRow?.completed === false ? waiterState : null;
        if (activeWaiter) {
          if (activeWaiter.requestId !== normalizedRequestId) {
            return "busy" as const;
          }
          if (
            activeWaiter.skill !== skill ||
            JSON.stringify(activeWaiter.envelope) !==
              JSON.stringify(normalizedEnvelope)
          ) {
            throw new Error("processing_action_operation_id_conflict");
          }
        }

        const writePendingWaiter = async (
          pending: StoredPendingProcessingRequest,
        ): Promise<void> => {
          const nextWaiter: StoredProcessingWaiter = {
            version: 1,
            requestId: pending.requestId,
            skill: pending.skill,
            envelope: normalizedEnvelope,
            ownerId: pending.ownerId,
            acceptedAt: pending.acceptedAt,
            heartbeatAt: pending.heartbeatAt,
            status: "pending",
            terminalAt: null,
            acknowledgedAt: null,
          };
          if (waiterRow) {
            await tx
              .update(schema.operationsLog)
              .set({
                playerId: normalizedPlayerId,
                operationType: "processing_waiter",
                operationState: nextWaiter,
                completed: false,
                timestamp: pending.heartbeatAt,
                completedAt: null,
              })
              .where(eq(schema.operationsLog.id, waiterId));
          } else {
            await tx.insert(schema.operationsLog).values({
              id: waiterId,
              playerId: normalizedPlayerId,
              operationType: "processing_waiter",
              operationState: nextWaiter,
              completed: false,
              timestamp: pending.heartbeatAt,
              completedAt: null,
            });
          }
        };

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, normalizedOperationId));
        const existing = existingRows[0];
        if (existing) {
          if (
            existing.playerId === normalizedPlayerId &&
            existing.operationType === "processing_action" &&
            existing.completed === true
          ) {
            if (activeWaiter && activeWaiter.status !== "committed") {
              throw new Error("processing_action_waiter_state_invalid");
            }
            return "committed" as const;
          }
          if (
            existing.playerId === normalizedPlayerId &&
            existing.operationType === "processing_request_rejected" &&
            existing.completed === true
          ) {
            if (activeWaiter && activeWaiter.status !== "rejected") {
              throw new Error("processing_action_waiter_state_invalid");
            }
            return "rejected" as const;
          }
          const state = existing.operationState as
            StoredPendingProcessingRequest | undefined;
          const storedEnvelope =
            state?.envelope === undefined
              ? undefined
              : normalizeProcessingRequestEnvelope(skill, state.envelope);
          if (
            existing.playerId !== normalizedPlayerId ||
            existing.operationType !== "processing_request" ||
            existing.completed !== false ||
            state?.version !== 1 ||
            state.requestId !== normalizedRequestId ||
            state.skill !== skill ||
            (state.envelope !== undefined &&
              (!storedEnvelope ||
                JSON.stringify(storedEnvelope) !==
                  JSON.stringify(normalizedEnvelope))) ||
            typeof state.ownerId !== "string" ||
            !state.ownerId
          ) {
            throw new Error("processing_action_operation_id_conflict");
          }
          if (state.ownerId === this.processingRequestOwnerId) {
            // An at-least-once transport may repeat the exact packet. Report
            // idempotent ownership without starting a second in-memory action
            // or falsely rejecting the caller's still-running first action.
            if (!activeWaiter) await writePendingWaiter(state);
            return "pending" as const;
          }
          const now = Date.now();
          const acceptedAt =
            Number.isSafeInteger(state.acceptedAt) && state.acceptedAt > 0
              ? state.acceptedAt
              : now;
          const resumed: StoredPendingProcessingRequest = {
            version: 1,
            requestId: normalizedRequestId,
            skill,
            ownerId: this.processingRequestOwnerId,
            acceptedAt,
            heartbeatAt: now,
            envelope: normalizedEnvelope,
          };
          await tx
            .update(schema.operationsLog)
            .set({ operationState: resumed, timestamp: now })
            .where(eq(schema.operationsLog.id, normalizedOperationId));
          await writePendingWaiter(resumed);
          return "accepted" as const;
        }

        if (activeWaiter) {
          throw new Error("processing_action_waiter_state_invalid");
        }

        const competingRows = await tx
          .select({ id: schema.operationsLog.id })
          .from(schema.operationsLog)
          .where(
            and(
              eq(schema.operationsLog.playerId, normalizedPlayerId),
              eq(schema.operationsLog.operationType, "processing_request"),
              eq(schema.operationsLog.completed, false),
            ),
          );
        if (competingRows.length > 0) return "busy" as const;

        const now = Date.now();
        const state: StoredPendingProcessingRequest = {
          version: 1,
          requestId: normalizedRequestId,
          skill,
          ownerId: this.processingRequestOwnerId,
          acceptedAt: now,
          heartbeatAt: now,
          envelope: normalizedEnvelope,
        };
        await tx.insert(schema.operationsLog).values({
          id: normalizedOperationId,
          playerId: normalizedPlayerId,
          operationType: "processing_request",
          operationState: state,
          completed: false,
          timestamp: now,
          completedAt: null,
        });
        await writePendingWaiter(state);
        return "accepted" as const;
      },
      { isolationLevel: "read committed" },
    );
  }

  /** Keep one accepted request bound to this exact server authority epoch. */
  async heartbeatProcessingRequestAsync(
    playerId: string,
    operationId: string,
    requestId: string,
    skill: ProcessingSkill,
  ): Promise<boolean> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedRequestId = normalizeProcessingRequestId(requestId);
    const normalizedOperationId = String(operationId ?? "").trim();
    if (
      !normalizedPlayerId ||
      !normalizedRequestId ||
      !PROCESSING_REQUEST_SKILLS.has(skill) ||
      normalizedOperationId !==
        getProcessingRequestOperationId(skill, normalizedRequestId)
    ) {
      throw new Error("processing_action_request_invalid");
    }
    return this.executeInTransaction(async (tx) => {
      // Use the same lock order as admission and commit. If another authority
      // has already taken over, the re-read below observes its owner and this
      // stale heartbeat becomes a no-op instead of stealing ownership back.
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${normalizedPlayerId} FOR UPDATE`,
      );
      const rows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          operationState: schema.operationsLog.operationState,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, normalizedOperationId));
      const row = rows[0];
      const state = row?.operationState as
        StoredPendingProcessingRequest | undefined;
      if (
        row?.playerId !== normalizedPlayerId ||
        row.operationType !== "processing_request" ||
        row.completed !== false ||
        state?.version !== 1 ||
        state.requestId !== normalizedRequestId ||
        state.skill !== skill ||
        state.ownerId !== this.processingRequestOwnerId
      ) {
        return false;
      }
      const envelope =
        state.envelope === undefined
          ? null
          : normalizeProcessingRequestEnvelope(skill, state.envelope);
      if (state.envelope !== undefined && !envelope) return false;
      const waiterId = processingWaiterOperationId(normalizedPlayerId);
      const waiterRows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          operationState: schema.operationsLog.operationState,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, waiterId));
      const waiterRow = waiterRows[0];
      const waiterState = waiterRow
        ? normalizeStoredProcessingWaiter(waiterRow.operationState)
        : null;
      if (
        waiterRow &&
        (waiterRow.playerId !== normalizedPlayerId ||
          waiterRow.operationType !== "processing_waiter" ||
          waiterRow.completed !== false ||
          !waiterState ||
          waiterState.requestId !== normalizedRequestId ||
          waiterState.skill !== skill ||
          waiterState.status !== "pending" ||
          waiterState.ownerId !== this.processingRequestOwnerId ||
          (envelope &&
            JSON.stringify(waiterState.envelope) !== JSON.stringify(envelope)))
      ) {
        return false;
      }
      const now = Date.now();
      await tx
        .update(schema.operationsLog)
        .set({
          operationState: { ...state, heartbeatAt: now },
          timestamp: now,
        })
        .where(eq(schema.operationsLog.id, normalizedOperationId));
      if (envelope) {
        const nextWaiter: StoredProcessingWaiter = waiterState
          ? { ...waiterState, heartbeatAt: now }
          : {
              version: 1,
              requestId: normalizedRequestId,
              skill,
              envelope,
              ownerId: this.processingRequestOwnerId,
              acceptedAt: state.acceptedAt,
              heartbeatAt: now,
              status: "pending",
              terminalAt: null,
              acknowledgedAt: null,
            };
        if (waiterRow) {
          await tx
            .update(schema.operationsLog)
            .set({ operationState: nextWaiter, timestamp: now })
            .where(eq(schema.operationsLog.id, waiterId));
        } else {
          await tx.insert(schema.operationsLog).values({
            id: waiterId,
            playerId: normalizedPlayerId,
            operationType: "processing_waiter",
            operationState: nextWaiter,
            completed: false,
            timestamp: now,
            completedAt: null,
          });
        }
      }
      return true;
    });
  }

  /** Record a definitive safe rejection without overwriting committed truth. */
  async rejectProcessingRequestAsync(
    playerId: string,
    operationId: string,
    requestId: string,
    skill: ProcessingSkill,
    reason: string,
    retryable: boolean,
  ): Promise<boolean> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedRequestId = normalizeProcessingRequestId(requestId);
    const normalizedOperationId = String(operationId ?? "").trim();
    const normalizedReason = String(reason ?? "").trim();
    if (
      !normalizedPlayerId ||
      !normalizedRequestId ||
      !normalizedReason ||
      normalizedReason.length > 64 ||
      !PROCESSING_REQUEST_SKILLS.has(skill) ||
      normalizedOperationId !==
        getProcessingRequestOperationId(skill, normalizedRequestId)
    ) {
      return false;
    }
    return this.executeInTransaction(async (tx) => {
      // Serialize against admission/takeover before deciding whether this
      // authority still owns the request. A stale process must never reject a
      // request that a replacement process has resumed.
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${normalizedPlayerId} FOR UPDATE`,
      );
      const rows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          operationState: schema.operationsLog.operationState,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, normalizedOperationId));
      const row = rows[0];
      const state = row?.operationState as
        StoredPendingProcessingRequest | undefined;
      if (
        row?.playerId !== normalizedPlayerId ||
        row.operationType !== "processing_request" ||
        row.completed !== false ||
        state?.version !== 1 ||
        state.requestId !== normalizedRequestId ||
        state.skill !== skill ||
        state.ownerId !== this.processingRequestOwnerId
      ) {
        return false;
      }
      const envelope =
        state.envelope === undefined
          ? null
          : normalizeProcessingRequestEnvelope(skill, state.envelope);
      if (state.envelope !== undefined && !envelope) return false;
      const waiterId = processingWaiterOperationId(normalizedPlayerId);
      const waiterRows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          operationState: schema.operationsLog.operationState,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, waiterId));
      const waiterRow = waiterRows[0];
      const waiterState = waiterRow
        ? normalizeStoredProcessingWaiter(waiterRow.operationState)
        : null;
      if (
        waiterRow &&
        (waiterRow.playerId !== normalizedPlayerId ||
          waiterRow.operationType !== "processing_waiter" ||
          waiterRow.completed !== false ||
          !waiterState ||
          waiterState.requestId !== normalizedRequestId ||
          waiterState.skill !== skill ||
          waiterState.status !== "pending" ||
          waiterState.ownerId !== this.processingRequestOwnerId ||
          (envelope &&
            JSON.stringify(waiterState.envelope) !== JSON.stringify(envelope)))
      ) {
        return false;
      }
      const now = Date.now();
      const rejected: StoredRejectedProcessingRequest = {
        ...state,
        reason: normalizedReason,
        retryable,
        rejectedAt: now,
      };
      await tx
        .update(schema.operationsLog)
        .set({
          operationType: "processing_request_rejected",
          operationState: rejected,
          completed: true,
          completedAt: now,
        })
        .where(eq(schema.operationsLog.id, normalizedOperationId));
      if (envelope) {
        const terminalWaiter: StoredProcessingWaiter = {
          version: 1,
          requestId: normalizedRequestId,
          skill,
          envelope,
          ownerId: this.processingRequestOwnerId,
          acceptedAt: waiterState?.acceptedAt ?? state.acceptedAt,
          heartbeatAt: now,
          status: "rejected",
          terminalAt: now,
          acknowledgedAt: null,
        };
        if (waiterRow) {
          await tx
            .update(schema.operationsLog)
            .set({ operationState: terminalWaiter, timestamp: now })
            .where(eq(schema.operationsLog.id, waiterId));
        } else {
          await tx.insert(schema.operationsLog).values({
            id: waiterId,
            playerId: normalizedPlayerId,
            operationType: "processing_waiter",
            operationState: terminalWaiter,
            completed: false,
            timestamp: now,
            completedAt: null,
          });
        }
      }
      return true;
    });
  }

  /**
   * Commit one recipe action as a single custody transition. All material
   * debits, optional product credits, matching optional XP/level, and the
   * semantic receipt are protected by the same serialized character-row lock.
   * Input-only zero-XP outcomes are valid for deterministic failed recipe
   * rolls and still receive exactly-once custody.
   */
  async commitProcessingActionOperationAsync(
    request: ProcessingActionCommitRequest,
  ): Promise<ProcessingActionCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const skill = String(request.skill ?? "").trim() as ProcessingActionSkill;
    const xpAmount = Number(request.xpAmount);
    const coinCost = Number(request.coinCost ?? 0);
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !PROCESSING_ACTION_SKILLS.has(skill) ||
      !Number.isFinite(xpAmount) ||
      xpAmount < 0 ||
      xpAmount > MAX_PROCESSING_ACTION_XP ||
      !Number.isSafeInteger(coinCost) ||
      coinCost < 0 ||
      coinCost > MAX_PERSISTED_ITEM_QUANTITY
    ) {
      throw new Error("processing_action_request_invalid");
    }
    const inputs = normalizeProcessingInputs(request.inputs);
    const requiredItems = normalizeProcessingRequiredItems(
      request.requiredItems,
    );
    const consumables = normalizeProcessingConsumables(request.consumables);
    const outputs = normalizeProcessingOutputs(request.outputs);
    const worldEffect = normalizeProcessingFireEffectRequest(
      request.worldEffect,
      skill,
    );
    if (
      requestFingerprint !==
      processingActionFingerprint(
        playerId,
        skill,
        xpAmount,
        inputs,
        requiredItems,
        consumables,
        outputs,
        coinCost,
        worldEffect,
      )
    ) {
      throw new Error("processing_action_request_invalid");
    }

    const operation = this.executeInTransaction(
      async (tx) => {
        // Acquire the cross-process tile lock before reading active effects.
        if (worldEffect) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`processing-fire:${worldEffect.tile.x}:${worldEffect.tile.z}`}, 0))`,
          );
        }
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            coins: schema.characters.coins,
            firemakingXp: schema.characters.firemakingXp,
            cookingXp: schema.characters.cookingXp,
            smithingXp: schema.characters.smithingXp,
            craftingXp: schema.characters.craftingXp,
            fletchingXp: schema.characters.fletchingXp,
            runecraftingXp: schema.characters.runecraftingXp,
            processingConsumableUses:
              schema.characters.processingConsumableUses,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) throw new Error("processing_action_player_missing");

        const persistedCoins = Number(character.coins);
        if (
          !Number.isSafeInteger(persistedCoins) ||
          persistedCoins < 0 ||
          persistedCoins > MAX_PERSISTED_ITEM_QUANTITY
        ) {
          throw new Error("processing_action_coin_state_invalid");
        }

        const persistedXp = Number(
          skill === "firemaking"
            ? character.firemakingXp
            : skill === "cooking"
              ? character.cookingXp
              : skill === "smithing"
                ? character.smithingXp
                : skill === "crafting"
                  ? character.craftingXp
                  : skill === "fletching"
                    ? character.fletchingXp
                    : character.runecraftingXp,
        );
        if (
          !Number.isFinite(persistedXp) ||
          persistedXp < 0 ||
          persistedXp > MAX_SKILL_XP
        ) {
          throw new Error("processing_action_skill_state_invalid");
        }
        const persistedConsumableUses = normalizeStoredProcessingConsumableUses(
          character.processingConsumableUses,
        );

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        let acceptedRequest: StoredPendingProcessingRequest | null = null;
        if (
          existing?.operationType === "processing_request" &&
          existing.completed === false
        ) {
          const state = existing.operationState as
            StoredPendingProcessingRequest | undefined;
          const expectedRequestId = operationId.slice(
            operationId.lastIndexOf(":") + 1,
          );
          const expectedRequestSkill = operationId.split(":")[1] as
            ProcessingSkill | undefined;
          const expectedCustodySkill =
            expectedRequestSkill === "smelting"
              ? "smithing"
              : expectedRequestSkill === "tanning"
                ? "crafting"
                : expectedRequestSkill;
          if (
            existing.playerId !== playerId ||
            state?.version !== 1 ||
            !expectedRequestSkill ||
            !PROCESSING_REQUEST_SKILLS.has(expectedRequestSkill) ||
            expectedCustodySkill !== skill ||
            state.skill !== expectedRequestSkill ||
            state.requestId !== expectedRequestId ||
            state.ownerId !== this.processingRequestOwnerId ||
            getProcessingRequestOperationId(
              expectedRequestSkill,
              state.requestId,
            ) !== operationId
          ) {
            throw new Error("processing_action_operation_id_conflict");
          }
          acceptedRequest = state;
        } else if (existing) {
          const state = existing.operationState as
            StoredProcessingActionOperation | undefined;
          const replayedInputs = state?.inputs
            ? normalizeProcessingInputs(state.inputs)
            : null;
          const replayedRequiredItems = normalizeProcessingRequiredItems(
            state?.requiredItems ?? [],
          );
          const replayedConsumables = normalizeProcessingConsumables(
            state?.consumables ?? [],
          );
          const replayedConsumableStates = normalizeProcessingConsumableStates(
            state?.consumableStates ?? [],
          );
          const replayedOutputs = state?.outputs
            ? normalizeProcessingOutputs(state.outputs)
            : null;
          const replayedCoinCost = Number(state?.coinCost ?? 0);
          let replayedWorldEffect: ProcessingActionFireEffect | undefined;
          try {
            if (Boolean(state?.worldEffect) !== Boolean(worldEffect)) {
              throw new Error("processing_action_world_effect_state_invalid");
            }
            replayedWorldEffect = normalizeStoredProcessingFireEffect(
              state?.worldEffect,
              worldEffect,
            );
          } catch {
            throw new Error("processing_action_operation_id_conflict");
          }
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "processing_action" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.skill !== skill ||
            state.xpAmount !== xpAmount ||
            !replayedInputs ||
            !replayedOutputs ||
            JSON.stringify(replayedInputs) !== JSON.stringify(inputs) ||
            JSON.stringify(replayedRequiredItems) !==
              JSON.stringify(requiredItems) ||
            JSON.stringify(replayedConsumables) !==
              JSON.stringify(consumables) ||
            replayedConsumableStates.length !== replayedConsumables.length ||
            JSON.stringify(replayedOutputs) !== JSON.stringify(outputs) ||
            !Number.isSafeInteger(replayedCoinCost) ||
            replayedCoinCost !== coinCost ||
            !Number.isFinite(state.awardedXp) ||
            state.awardedXp < 0 ||
            state.awardedXp > xpAmount ||
            !Number.isFinite(state.operationCommittedXp)
          ) {
            throw new Error("processing_action_operation_id_conflict");
          }
          if (replayedWorldEffect) {
            const fireRows = await tx
              .select({
                fireId: schema.processingActiveFires.fireId,
                playerId: schema.processingActiveFires.playerId,
                positionX: schema.processingActiveFires.positionX,
                positionY: schema.processingActiveFires.positionY,
                positionZ: schema.processingActiveFires.positionZ,
                tileX: schema.processingActiveFires.tileX,
                tileZ: schema.processingActiveFires.tileZ,
                createdAt: schema.processingActiveFires.createdAt,
                expiresAt: schema.processingActiveFires.expiresAt,
              })
              .from(schema.processingActiveFires)
              .where(eq(schema.processingActiveFires.operationId, operationId));
            const row = fireRows[0];
            if (
              fireRows.length !== 1 ||
              !row ||
              row.playerId !== playerId ||
              JSON.stringify({
                kind: "fire",
                fireId: row.fireId,
                position: {
                  x: Number(row.positionX),
                  y: Number(row.positionY),
                  z: Number(row.positionZ),
                },
                tile: { x: Number(row.tileX), z: Number(row.tileZ) },
                createdAt: Number(row.createdAt),
                expiresAt: Number(row.expiresAt),
              }) !== JSON.stringify(replayedWorldEffect)
            ) {
              throw new Error("processing_action_operation_id_conflict");
            }
          }
          const currentRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            skill,
            xpAmount,
            inputs: replayedInputs,
            requiredItems: replayedRequiredItems,
            consumables: replayedConsumables,
            consumableStates: replayedConsumableStates,
            outputs: replayedOutputs,
            ...(coinCost > 0 ? { coinCost, currentCoins: persistedCoins } : {}),
            ...(replayedWorldEffect
              ? { worldEffect: replayedWorldEffect }
              : {}),
            awardedXp: state.awardedXp,
            operationCommittedXp: state.operationCommittedXp,
            currentXp: persistedXp,
            currentLevel: skillLevelForXp(persistedXp),
            committed: normalizePersistedInventoryRows(
              currentRows,
              "processing_action",
            ),
          };
        }

        if (worldEffect) {
          const arbitrationNow = Date.now();
          await tx
            .update(schema.processingActiveFires)
            .set({ extinguishedAt: arbitrationNow })
            .where(
              and(
                eq(schema.processingActiveFires.tileX, worldEffect.tile.x),
                eq(schema.processingActiveFires.tileZ, worldEffect.tile.z),
                isNull(schema.processingActiveFires.extinguishedAt),
                lte(schema.processingActiveFires.expiresAt, arbitrationNow),
              ),
            );
          const activeAtTile = await tx
            .select({ fireId: schema.processingActiveFires.fireId })
            .from(schema.processingActiveFires)
            .where(
              and(
                eq(schema.processingActiveFires.tileX, worldEffect.tile.x),
                eq(schema.processingActiveFires.tileZ, worldEffect.tile.z),
                isNull(schema.processingActiveFires.extinguishedAt),
                gt(schema.processingActiveFires.expiresAt, Date.now()),
              ),
            );
          if (activeAtTile.length > 0) {
            throw new Error("processing_action_fire_tile_occupied");
          }
          const activeForPlayer = await tx
            .select({ fireId: schema.processingActiveFires.fireId })
            .from(schema.processingActiveFires)
            .where(
              and(
                eq(schema.processingActiveFires.playerId, playerId),
                isNull(schema.processingActiveFires.extinguishedAt),
                gt(schema.processingActiveFires.expiresAt, Date.now()),
              ),
            );
          if (
            activeForPlayer.length >= MAX_ACTIVE_PROCESSING_FIRES_PER_PLAYER
          ) {
            throw new Error("processing_action_fire_capacity_reached");
          }
        }

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        let committed = normalizePersistedInventoryRows(
          inventoryRows,
          "processing_action",
        );
        if (persistedCoins < coinCost) {
          throw new Error("processing_action_insufficient_coins");
        }
        const nextCoins = persistedCoins - coinCost;
        const availabilityByItem = new Map(
          requiredItems.map((entry) => [entry.itemId, entry.quantity]),
        );
        for (const consumable of consumables) {
          availabilityByItem.set(
            consumable.itemId,
            Math.max(availabilityByItem.get(consumable.itemId) ?? 0, 1),
          );
        }
        const availabilityRequirements = normalizeProcessingRequiredItems(
          [...availabilityByItem.entries()].map(([itemId, quantity]) => ({
            itemId,
            quantity,
          })),
        );
        if (availabilityRequirements.length > 0) {
          try {
            debitInventorySnapshot(committed, availabilityRequirements);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes("inventory_debit_insufficient_items")
            ) {
              throw new Error("processing_action_insufficient_items");
            }
            throw error;
          }
        }

        const nextConsumableUses: StoredProcessingConsumableUses =
          Object.fromEntries(
            Object.entries(persistedConsumableUses).map(([itemId, state]) => [
              itemId,
              { ...state },
            ]),
          );
        const consumableStates: ProcessingActionConsumableState[] = [];
        const consumableDebits: InventoryDebitRequirement[] = [];
        for (const consumable of consumables) {
          const current = nextConsumableUses[consumable.itemId];
          if (current && current.usesPerItem !== consumable.usesPerItem) {
            throw new Error("processing_action_consumable_config_conflict");
          }
          const remainingUses =
            (current?.remainingUses ?? consumable.usesPerItem) - 1;
          if (remainingUses === 0) {
            delete nextConsumableUses[consumable.itemId];
            consumableDebits.push({
              itemId: consumable.itemId,
              quantity: 1,
            });
            consumableStates.push({
              ...consumable,
              remainingUses: 0,
              consumedQuantity: 1,
            });
          } else {
            nextConsumableUses[consumable.itemId] = {
              usesPerItem: consumable.usesPerItem,
              remainingUses,
            };
            consumableStates.push({
              ...consumable,
              remainingUses,
              consumedQuantity: 0,
            });
          }
        }
        const committedInputs =
          consumableDebits.length > 0
            ? normalizeProcessingInputs([...inputs, ...consumableDebits])
            : inputs;
        try {
          committed = debitInventorySnapshot(committed, committedInputs);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("inventory_debit_insufficient_items")
          ) {
            throw new Error("processing_action_insufficient_items");
          }
          throw error;
        }
        for (const output of outputs) {
          committed = creditGatheringReward(
            committed,
            output,
            "processing_action",
          );
        }

        const operationCommittedXp = Math.min(
          persistedXp + xpAmount,
          MAX_SKILL_XP,
        );
        const awardedXp = operationCommittedXp - persistedXp;
        const currentLevel = skillLevelForXp(operationCommittedXp);
        const skillUpdate =
          skill === "firemaking"
            ? {
                firemakingXp: operationCommittedXp,
                firemakingLevel: currentLevel,
              }
            : skill === "cooking"
              ? {
                  cookingXp: operationCommittedXp,
                  cookingLevel: currentLevel,
                }
              : skill === "smithing"
                ? {
                    smithingXp: operationCommittedXp,
                    smithingLevel: currentLevel,
                  }
                : skill === "crafting"
                  ? {
                      craftingXp: operationCommittedXp,
                      craftingLevel: currentLevel,
                    }
                  : skill === "fletching"
                    ? {
                        fletchingXp: operationCommittedXp,
                        fletchingLevel: currentLevel,
                      }
                    : {
                        runecraftingXp: operationCommittedXp,
                        runecraftingLevel: currentLevel,
                      };

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        await tx
          .update(schema.characters)
          .set({
            ...skillUpdate,
            coins: nextCoins,
            processingConsumableUses: nextConsumableUses,
          })
          .where(eq(schema.characters.id, playerId));

        const now = Date.now();
        const operationState: StoredProcessingActionOperation = {
          version: 1,
          requestFingerprint,
          skill,
          xpAmount,
          inputs,
          requiredItems,
          consumables,
          consumableStates,
          outputs,
          ...(coinCost > 0 ? { coinCost } : {}),
          ...(worldEffect
            ? {
                worldEffect: {
                  kind: "fire",
                  fireId: worldEffect.fireId,
                  position: worldEffect.position,
                  tile: worldEffect.tile,
                  createdAt: now,
                  expiresAt: now + worldEffect.durationMs,
                },
              }
            : {}),
          awardedXp,
          operationCommittedXp,
        };
        if (acceptedRequest) {
          await tx
            .update(schema.operationsLog)
            .set({
              operationType: "processing_action",
              operationState,
              completed: true,
              completedAt: now,
            })
            .where(eq(schema.operationsLog.id, operationId));
          const envelope =
            acceptedRequest.envelope === undefined
              ? null
              : normalizeProcessingRequestEnvelope(
                  acceptedRequest.skill,
                  acceptedRequest.envelope,
                );
          if (acceptedRequest.envelope !== undefined && !envelope) {
            throw new Error("processing_action_waiter_state_invalid");
          }
          if (envelope) {
            const waiterId = processingWaiterOperationId(playerId);
            const waiterRows = await tx
              .select({
                playerId: schema.operationsLog.playerId,
                operationType: schema.operationsLog.operationType,
                operationState: schema.operationsLog.operationState,
                completed: schema.operationsLog.completed,
              })
              .from(schema.operationsLog)
              .where(eq(schema.operationsLog.id, waiterId));
            const waiterRow = waiterRows[0];
            const waiterState = waiterRow
              ? normalizeStoredProcessingWaiter(waiterRow.operationState)
              : null;
            if (
              waiterRow &&
              (waiterRow.playerId !== playerId ||
                waiterRow.operationType !== "processing_waiter" ||
                waiterRow.completed !== false ||
                !waiterState ||
                waiterState.requestId !== acceptedRequest.requestId ||
                waiterState.skill !== acceptedRequest.skill ||
                waiterState.status !== "pending" ||
                waiterState.ownerId !== this.processingRequestOwnerId ||
                JSON.stringify(waiterState.envelope) !==
                  JSON.stringify(envelope))
            ) {
              throw new Error("processing_action_waiter_state_invalid");
            }
            const terminalWaiter: StoredProcessingWaiter = {
              version: 1,
              requestId: acceptedRequest.requestId,
              skill: acceptedRequest.skill,
              envelope,
              ownerId: this.processingRequestOwnerId,
              acceptedAt: waiterState?.acceptedAt ?? acceptedRequest.acceptedAt,
              heartbeatAt: now,
              status: "committed",
              terminalAt: now,
              acknowledgedAt: null,
            };
            if (waiterRow) {
              await tx
                .update(schema.operationsLog)
                .set({ operationState: terminalWaiter, timestamp: now })
                .where(eq(schema.operationsLog.id, waiterId));
            } else {
              await tx.insert(schema.operationsLog).values({
                id: waiterId,
                playerId,
                operationType: "processing_waiter",
                operationState: terminalWaiter,
                completed: false,
                timestamp: now,
                completedAt: null,
              });
            }
          }
        } else {
          await tx.insert(schema.operationsLog).values({
            id: operationId,
            playerId,
            operationType: "processing_action",
            operationState,
            completed: true,
            timestamp: now,
            completedAt: now,
          });
        }

        const activeQuestRows = await tx
          .select({
            questId: schema.questProgress.questId,
            currentStage: schema.questProgress.currentStage,
            startedAt: schema.questProgress.startedAt,
          })
          .from(schema.questProgress)
          .where(
            and(
              eq(schema.questProgress.playerId, playerId),
              eq(schema.questProgress.status, "in_progress"),
            ),
          );
        const questContexts = activeQuestRows.map((row) => ({
          questId: String(row.questId ?? "").trim(),
          currentStage: String(row.currentStage ?? "").trim(),
          startedAt: Number(row.startedAt),
        }));
        if (
          questContexts.some(
            (context) =>
              !context.questId ||
              context.questId.length > 256 ||
              !context.currentStage ||
              context.currentStage.length > 256 ||
              !Number.isSafeInteger(context.startedAt) ||
              context.startedAt < 0,
          )
        ) {
          throw new Error("processing_action_quest_state_invalid");
        }
        const targetQuantities = new Map<string, number>();
        for (const output of outputs) {
          targetQuantities.set(
            output.itemId,
            (targetQuantities.get(output.itemId) ?? 0) + output.quantity,
          );
        }
        if (worldEffect) {
          targetQuantities.set("fire", (targetQuantities.get("fire") ?? 0) + 1);
        }
        const questTargets = [...targetQuantities].map(
          ([targetId, quantity]) => ({ targetId, quantity }),
        );
        if (
          questTargets.some(
            (target) =>
              !target.targetId ||
              target.targetId.length > 256 ||
              !Number.isSafeInteger(target.quantity) ||
              target.quantity <= 0 ||
              target.quantity > MAX_PERSISTED_ITEM_QUANTITY,
          )
        ) {
          throw new Error("processing_action_quest_target_invalid");
        }
        if (questContexts.length > 0 && questTargets.length > 0) {
          await tx.insert(schema.questProcessingProgressReceipts).values(
            questContexts.flatMap((context) =>
              questTargets.map((target) => ({
                operationId,
                playerId,
                questId: context.questId,
                questStartedAt: context.startedAt,
                capturedStage: context.currentStage,
                targetId: target.targetId,
                quantity: target.quantity,
                createdAt: now,
              })),
            ),
          );
        }
        if (operationState.worldEffect) {
          await tx.insert(schema.processingActiveFires).values({
            fireId: operationState.worldEffect.fireId,
            operationId,
            playerId,
            positionX: operationState.worldEffect.position.x,
            positionY: operationState.worldEffect.position.y,
            positionZ: operationState.worldEffect.position.z,
            tileX: operationState.worldEffect.tile.x,
            tileZ: operationState.worldEffect.tile.z,
            createdAt: operationState.worldEffect.createdAt,
            expiresAt: operationState.worldEffect.expiresAt,
            extinguishedAt: null,
          });
        }

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          skill,
          xpAmount,
          inputs,
          requiredItems,
          consumables,
          consumableStates,
          outputs,
          ...(coinCost > 0 ? { coinCost, currentCoins: nextCoins } : {}),
          ...(operationState.worldEffect
            ? { worldEffect: operationState.worldEffect }
            : {}),
          awardedXp,
          operationCommittedXp,
          currentXp: operationCommittedXp,
          currentLevel,
          committed,
        };
      },
      // Explicit character-row and fire-tile locks define the complete write
      // set. READ COMMITTED lets a tile-lock waiter observe the prior commit;
      // SERIALIZABLE would retain the pre-wait snapshot and abort at COMMIT.
      { isolationLevel: "read committed" },
    );
    try {
      return await this.trackAwaitedOperation(operation);
    } catch (error) {
      if (
        worldEffect &&
        hasPostgresConstraint(
          error,
          "processing_active_fires_active_tile_unique",
        )
      ) {
        throw new Error("processing_action_fire_tile_occupied");
      }
      throw error;
    }
  }

  /**
   * Resolve one player-owned deterministic processing receipt. This deliberately
   * returns no custody details and treats ownership/type mismatches as absent.
   */
  async getProcessingActionCommitStatusAsync(
    playerId: string,
    operationId: string,
  ): Promise<
    "committed" | "pending" | "interrupted" | "rejected" | "not_found"
  > {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    if (
      !normalizedPlayerId ||
      !normalizedOperationId ||
      normalizedOperationId.length > 256
    ) {
      throw new Error("processing_action_request_invalid");
    }

    const rows = await this.db
      .select({
        playerId: schema.operationsLog.playerId,
        operationType: schema.operationsLog.operationType,
        operationState: schema.operationsLog.operationState,
        completed: schema.operationsLog.completed,
      })
      .from(schema.operationsLog)
      .where(eq(schema.operationsLog.id, normalizedOperationId));
    const receipt = rows[0];
    if (receipt?.playerId !== normalizedPlayerId) return "not_found";
    if (
      receipt.operationType === "processing_action" &&
      receipt.completed === true
    ) {
      return "committed";
    }
    if (
      receipt.operationType === "processing_request_rejected" &&
      receipt.completed === true
    ) {
      return "rejected";
    }
    if (
      receipt.operationType === "processing_request" &&
      receipt.completed === false
    ) {
      const state = receipt.operationState as
        StoredPendingProcessingRequest | undefined;
      if (
        state?.version !== 1 ||
        getProcessingRequestOperationId(state.skill, state.requestId) !==
          normalizedOperationId ||
        !state.ownerId
      ) {
        return "not_found";
      }
      return state.ownerId === this.processingRequestOwnerId
        ? "pending"
        : "interrupted";
    }
    return "not_found";
  }

  /** Return the authenticated player's one durable, unacknowledged command. */
  async getRecoverableProcessingRequestAsync(
    playerId: string,
  ): Promise<RecoverableProcessingRequest | null> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    if (!normalizedPlayerId) {
      throw new Error("processing_action_request_invalid");
    }
    return this.executeInTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${normalizedPlayerId} FOR UPDATE`,
      );
      const waiterId = processingWaiterOperationId(normalizedPlayerId);
      const waiterRows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          operationState: schema.operationsLog.operationState,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, waiterId));
      const waiterRow = waiterRows[0];
      if (!waiterRow) return null;
      const waiter = normalizeStoredProcessingWaiter(waiterRow.operationState);
      if (
        waiterRow.playerId !== normalizedPlayerId ||
        waiterRow.operationType !== "processing_waiter" ||
        !waiter
      ) {
        throw new Error("processing_action_waiter_state_invalid");
      }
      if (waiterRow.completed === true) {
        if (waiter.acknowledgedAt === null) {
          throw new Error("processing_action_waiter_state_invalid");
        }
        return null;
      }
      if (waiterRow.completed !== false || waiter.acknowledgedAt !== null) {
        throw new Error("processing_action_waiter_state_invalid");
      }

      const operationId = getProcessingRequestOperationId(
        waiter.skill,
        waiter.requestId,
      );
      if (!operationId) {
        throw new Error("processing_action_waiter_state_invalid");
      }
      const receiptRows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          operationState: schema.operationsLog.operationState,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, operationId));
      const receipt = receiptRows[0];
      if (receipt?.playerId !== normalizedPlayerId) {
        throw new Error("processing_action_waiter_state_invalid");
      }

      let status: RecoverableProcessingRequest["status"];
      if (
        receipt.operationType === "processing_action" &&
        receipt.completed === true
      ) {
        status = "committed";
      } else if (
        receipt.operationType === "processing_request_rejected" &&
        receipt.completed === true
      ) {
        status = "rejected";
      } else if (
        receipt.operationType === "processing_request" &&
        receipt.completed === false
      ) {
        const pending = receipt.operationState as
          StoredPendingProcessingRequest | undefined;
        const pendingEnvelope = normalizeProcessingRequestEnvelope(
          waiter.skill,
          pending?.envelope,
        );
        if (
          pending?.version !== 1 ||
          pending.requestId !== waiter.requestId ||
          pending.skill !== waiter.skill ||
          !pending.ownerId ||
          !pendingEnvelope ||
          JSON.stringify(pendingEnvelope) !== JSON.stringify(waiter.envelope)
        ) {
          throw new Error("processing_action_waiter_state_invalid");
        }
        status =
          pending.ownerId === this.processingRequestOwnerId
            ? "pending"
            : "interrupted";
      } else {
        throw new Error("processing_action_waiter_state_invalid");
      }

      if (
        (status === "committed" && waiter.status !== "committed") ||
        (status === "rejected" && waiter.status !== "rejected") ||
        ((status === "pending" || status === "interrupted") &&
          waiter.status !== "pending")
      ) {
        throw new Error("processing_action_waiter_state_invalid");
      }
      return {
        requestId: waiter.requestId,
        skill: waiter.skill,
        status,
        envelope: waiter.envelope,
        acceptedAt: waiter.acceptedAt,
        heartbeatAt: waiter.heartbeatAt,
        terminalAt: waiter.terminalAt,
      };
    });
  }

  /** Mark one exact terminal command consumed; duplicate acknowledgements succeed. */
  async acknowledgeProcessingRequestAsync(
    playerId: string,
    requestId: string,
  ): Promise<boolean> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedRequestId = normalizeProcessingRequestId(requestId);
    if (!normalizedPlayerId || !normalizedRequestId) return false;
    return this.executeInTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${normalizedPlayerId} FOR UPDATE`,
      );
      const waiterId = processingWaiterOperationId(normalizedPlayerId);
      const waiterRows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          operationState: schema.operationsLog.operationState,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, waiterId));
      const waiterRow = waiterRows[0];
      const waiter = waiterRow
        ? normalizeStoredProcessingWaiter(waiterRow.operationState)
        : null;
      if (
        waiterRow?.playerId !== normalizedPlayerId ||
        waiterRow.operationType !== "processing_waiter" ||
        !waiter ||
        waiter.requestId !== normalizedRequestId ||
        waiter.status === "pending"
      ) {
        return false;
      }
      if (waiterRow.completed === true) {
        return waiter.acknowledgedAt !== null;
      }
      if (waiterRow.completed !== false || waiter.acknowledgedAt !== null) {
        return false;
      }

      const operationId = getProcessingRequestOperationId(
        waiter.skill,
        waiter.requestId,
      );
      if (!operationId) return false;
      const receiptRows = await tx
        .select({
          playerId: schema.operationsLog.playerId,
          operationType: schema.operationsLog.operationType,
          completed: schema.operationsLog.completed,
        })
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, operationId));
      const receipt = receiptRows[0];
      const terminalMatches =
        receipt?.playerId === normalizedPlayerId &&
        receipt.completed === true &&
        ((waiter.status === "committed" &&
          receipt.operationType === "processing_action") ||
          (waiter.status === "rejected" &&
            receipt.operationType === "processing_request_rejected"));
      if (!terminalMatches) return false;

      const now = Date.now();
      await tx
        .update(schema.operationsLog)
        .set({
          operationState: { ...waiter, acknowledgedAt: now },
          completed: true,
          timestamp: now,
          completedAt: now,
        })
        .where(eq(schema.operationsLog.id, waiterId));
      return true;
    });
  }

  /** Load every committed Firemaking effect whose expiry is not yet settled. */
  async getActiveProcessingFiresAsync(): Promise<ActiveProcessingFire[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_action_database_unavailable");
    }
    const rows = await this.db
      .select({
        fireId: schema.processingActiveFires.fireId,
        playerId: schema.processingActiveFires.playerId,
        positionX: schema.processingActiveFires.positionX,
        positionY: schema.processingActiveFires.positionY,
        positionZ: schema.processingActiveFires.positionZ,
        tileX: schema.processingActiveFires.tileX,
        tileZ: schema.processingActiveFires.tileZ,
        createdAt: schema.processingActiveFires.createdAt,
        expiresAt: schema.processingActiveFires.expiresAt,
        databaseObservedAt: sql<number>`(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint`,
      })
      .from(schema.processingActiveFires)
      .where(isNull(schema.processingActiveFires.extinguishedAt));
    return rows
      .map((row) => {
        const effect = normalizeStoredProcessingFireEffect({
          kind: "fire",
          fireId: row.fireId,
          position: {
            x: Number(row.positionX),
            y: Number(row.positionY),
            z: Number(row.positionZ),
          },
          tile: { x: Number(row.tileX), z: Number(row.tileZ) },
          createdAt: Number(row.createdAt),
          expiresAt: Number(row.expiresAt),
        });
        if (!effect) {
          throw new Error("processing_action_world_effect_state_invalid");
        }
        const databaseObservedAt = Number(row.databaseObservedAt);
        if (
          !Number.isSafeInteger(databaseObservedAt) ||
          databaseObservedAt < 0
        ) {
          throw new Error("processing_action_database_clock_invalid");
        }
        return { ...effect, playerId: row.playerId, databaseObservedAt };
      })
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.fireId.localeCompare(right.fireId),
      );
  }

  /** Atomically close one expired fire and register its exact ash source. */
  async commitProcessingFireExtinguishOperationAsync(
    request: ProcessingFireExtinguishCommitRequest,
  ): Promise<ProcessingFireExtinguishCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("processing_fire_extinguish_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const fireId = String(request.fireId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const position = {
      x: Number(request.position?.x),
      y: Number(request.position?.y),
      z: Number(request.position?.z),
    };
    const expiresAt = Number(request.expiresAt);
    const source = request.source;
    const identity: Omit<
      ProcessingFireExtinguishCommitRequest,
      "requestFingerprint" | "source"
    > = {
      operationId,
      fireId,
      playerId,
      position,
      expiresAt,
    };
    const fireTile = worldToTile(position.x, position.z);
    if (
      operationId !== getProcessingFireExtinguishOperationId(fireId) ||
      operationId !== request.operationId ||
      operationId.length > 320 ||
      !/^fire_[A-Za-z0-9_-]+$/.test(fireId) ||
      fireId !== request.fireId ||
      fireId.length > 256 ||
      !playerId ||
      playerId !== request.playerId ||
      playerId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(playerId) ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !Object.values(position).every(Number.isFinite) ||
      Math.abs(position.x) > 10_000 ||
      Math.abs(position.z) > 10_000 ||
      position.y < -500 ||
      position.y > 500 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0 ||
      !source ||
      source.itemId !== "ashes" ||
      source.quantity !== 1 ||
      source.stackable !== true ||
      source.droppedBy !== null ||
      source.lifetimeMs !== 120_000 ||
      source.lootProtectionMs !== 0 ||
      source.tile?.x !== fireTile.x ||
      source.tile?.z !== fireTile.z ||
      requestFingerprint !== processingFireExtinguishFingerprint(identity)
    ) {
      throw new Error("processing_fire_extinguish_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtextextended('processing-fire-extinguish:' || ${fireId}, 0)
          )`,
        );
        const fireResult = await tx.execute(sql`
          SELECT
            "fire_id" AS "fireId",
            "player_id" AS "playerId",
            "position_x" AS "positionX",
            "position_y" AS "positionY",
            "position_z" AS "positionZ",
            "expires_at" AS "expiresAt",
            "extinguished_at" AS "extinguishedAt"
          FROM "processing_active_fires"
          WHERE "fire_id" = ${fireId}
          FOR UPDATE
        `);
        const fire = databaseQueryRows<{
          fireId: string;
          playerId: string;
          positionX: number | string;
          positionY: number | string;
          positionZ: number | string;
          expiresAt: number | string;
          extinguishedAt: number | string | null;
        }>(fireResult)[0];
        if (
          !fire ||
          fire.fireId !== fireId ||
          fire.playerId !== playerId ||
          Number(fire.positionX) !== position.x ||
          Number(fire.positionY) !== position.y ||
          Number(fire.positionZ) !== position.z ||
          Number(fire.expiresAt) !== expiresAt
        ) {
          throw new Error("processing_fire_extinguish_fire_mismatch");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredProcessingFireExtinguishOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "processing_fire_extinguish" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.fireId !== fireId ||
            JSON.stringify(state.position) !== JSON.stringify(position) ||
            state.expiresAt !== expiresAt ||
            !Number.isSafeInteger(state.extinguishedAt) ||
            state.extinguishedAt < expiresAt ||
            fire.extinguishedAt === null ||
            Number(fire.extinguishedAt) !== state.extinguishedAt ||
            !state.source ||
            !state.sourceId
          ) {
            throw new Error("processing_fire_extinguish_operation_id_conflict");
          }
          const sourceReceipt = await this.registerGroundItemSourceAsync(
            state.source,
            tx,
          );
          if (
            !sourceReceipt.replayed ||
            sourceReceipt.sourceId !== state.sourceId
          ) {
            throw new Error(
              "processing_fire_extinguish_source_receipt_invalid",
            );
          }
          return {
            operationId,
            fireId,
            playerId,
            requestFingerprint,
            replayed: true,
            position,
            expiresAt,
            extinguishedAt: state.extinguishedAt,
            sourceRequest: state.source,
            source: sourceReceipt,
          };
        }

        if (fire.extinguishedAt !== null) {
          throw new Error("processing_fire_extinguish_state_conflict");
        }
        const nowResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const databaseNow = Number(
          databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
            ?.databaseNow,
        );
        if (!Number.isSafeInteger(databaseNow) || databaseNow < expiresAt) {
          throw new Error("processing_fire_extinguish_not_due");
        }

        const sourceReceipt = await this.registerGroundItemSourceAsync(
          source,
          tx,
        );
        if (sourceReceipt.replayed) {
          throw new Error("processing_fire_extinguish_source_preexisting");
        }
        const updated = await tx
          .update(schema.processingActiveFires)
          .set({ extinguishedAt: databaseNow })
          .where(
            and(
              eq(schema.processingActiveFires.fireId, fireId),
              isNull(schema.processingActiveFires.extinguishedAt),
              lte(schema.processingActiveFires.expiresAt, databaseNow),
            ),
          )
          .returning({ fireId: schema.processingActiveFires.fireId });
        if (updated.length !== 1) {
          throw new Error("processing_fire_extinguish_state_conflict");
        }

        const storedSource = {
          ...source,
          position: { ...source.position },
          tile: { ...source.tile },
        };
        const operationState: StoredProcessingFireExtinguishOperation = {
          version: 1,
          requestFingerprint,
          fireId,
          position,
          expiresAt,
          extinguishedAt: databaseNow,
          source: storedSource,
          sourceId: sourceReceipt.sourceId,
        };
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "processing_fire_extinguish",
          operationState,
          completed: true,
          timestamp: databaseNow,
          completedAt: databaseNow,
        });
        return {
          operationId,
          fireId,
          playerId,
          requestFingerprint,
          replayed: false,
          position,
          expiresAt,
          extinguishedAt: databaseNow,
          sourceRequest: storedSource,
          source: sourceReceipt,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /**
   * Debit one exact equipped stack and its durable receipt in the same
   * serializable transaction. The shared character-row lock prevents this
   * custody transition from racing loadout switches or inventory debits.
   */
  async commitEquipmentStackDebitOperationAsync(
    request: EquipmentStackDebitCommitRequest,
  ): Promise<EquipmentStackDebitCommitReceipt> {
    if (!this.db) {
      throw new Error("equipment_stack_debit_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const slotType = String(request.slotType ?? "").trim();
    const itemId = String(request.itemId ?? "").trim();
    const quantity = Number(request.quantity);
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !slotType ||
      slotType.length > 64 ||
      !itemId ||
      itemId.length > 256 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_ITEM_QUANTITY ||
      requestFingerprint !==
        equipmentStackDebitFingerprint(playerId, slotType, itemId, quantity)
    ) {
      throw new Error("equipment_stack_debit_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!characterRows[0]) {
          throw new Error("equipment_stack_debit_player_missing");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredEquipmentStackDebitOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "equipment_stack_debit" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.slotType !== slotType ||
            state.itemId !== itemId ||
            state.quantity !== quantity
          ) {
            throw new Error("equipment_stack_debit_operation_id_conflict");
          }

          const currentRows = await tx
            .select({
              slotType: schema.equipment.slotType,
              itemId: schema.equipment.itemId,
              quantity: schema.equipment.quantity,
            })
            .from(schema.equipment)
            .where(eq(schema.equipment.playerId, playerId));
          const committed = normalizeEquipmentSnapshot(
            currentRows
              .filter((row) => Boolean(row.itemId))
              .map((row) => ({
                slotType: row.slotType,
                itemId: row.itemId!,
                quantity: row.quantity ?? 1,
              })),
            "equipment_stack_debit",
          );
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            slotType,
            itemId,
            quantity,
            committed,
          };
        }

        const equipmentRows = await tx
          .select({
            slotType: schema.equipment.slotType,
            itemId: schema.equipment.itemId,
            quantity: schema.equipment.quantity,
          })
          .from(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        const persisted = normalizeEquipmentSnapshot(
          equipmentRows
            .filter((row) => Boolean(row.itemId))
            .map((row) => ({
              slotType: row.slotType,
              itemId: row.itemId!,
              quantity: row.quantity ?? 1,
            })),
          "equipment_stack_debit",
        );
        const committed = debitEquipmentStackSnapshot(
          persisted,
          slotType,
          itemId,
          quantity,
        );

        await tx
          .delete(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.equipment).values(
            committed.map((item) => ({
              playerId,
              slotType: item.slotType,
              itemId: item.itemId,
              quantity: item.quantity,
            })),
          );
        }

        const operationState: StoredEquipmentStackDebitOperation = {
          version: 1,
          requestFingerprint,
          slotType,
          itemId,
          quantity,
          committed,
        };
        const now = Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "equipment_stack_debit",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          slotType,
          itemId,
          quantity,
          committed,
        };
      },
      { isolationLevel: "serializable" },
    );
  }

  /**
   * Debit one arrow and durably stage its immutable recovery decision before
   * a projectile can become active. Launch finalization or cancellation owns
   * the only legal terminal transition.
   */
  async commitAmmunitionShotOperationAsync(
    request: AmmunitionShotCommitRequest,
  ): Promise<AmmunitionShotCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("ammunition_shot_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const itemId = String(request.itemId ?? "").trim();
    const quantity = Number(request.quantity);
    const recoveryDisposition = request.recoveryDisposition;
    const source = request.source;
    const item = getItem(itemId);
    const sourceTile = source
      ? worldToTile(Number(source.position?.x), Number(source.position?.z))
      : null;
    const normalizedRequest = {
      operationId,
      playerId,
      itemId,
      quantity: 1 as const,
      recoveryDisposition,
      source,
    };
    const recoveredSourceValid =
      recoveryDisposition === "recovered" &&
      source !== null &&
      source.itemId === itemId &&
      source.quantity === 1 &&
      source.stackable === true &&
      source.droppedBy === playerId &&
      source.lifetimeMs === 120_000 &&
      source.lootProtectionMs === 0 &&
      source.allowMerge === false &&
      sourceTile !== null &&
      source.tile?.x === sourceTile.x &&
      source.tile?.z === sourceTile.z &&
      !isPositionInsideDuelArenaZone(source.position.x, source.position.z);
    if (
      !/^ammunition-shot:[A-Za-z0-9]{20}$/.test(operationId) ||
      operationId !== request.operationId ||
      !playerId ||
      playerId !== request.playerId ||
      playerId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(playerId) ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !item ||
      item.type !== "ammunition" ||
      item.equipSlot !== "arrows" ||
      item.stackable !== true ||
      itemId !== request.itemId ||
      itemId.length > 256 ||
      quantity !== 1 ||
      (recoveryDisposition !== "recovered" &&
        recoveryDisposition !== "destroyed") ||
      (recoveryDisposition === "recovered"
        ? !recoveredSourceValid
        : source !== null) ||
      requestFingerprint !== ammunitionShotFingerprint(normalizedRequest)
    ) {
      throw new Error("ammunition_shot_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!characterRows[0]) {
          throw new Error("ammunition_shot_player_missing");
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        const currentEquipment = async () =>
          normalizeEquipmentSnapshot(
            (
              await tx
                .select({
                  slotType: schema.equipment.slotType,
                  itemId: schema.equipment.itemId,
                  quantity: schema.equipment.quantity,
                })
                .from(schema.equipment)
                .where(eq(schema.equipment.playerId, playerId))
            )
              .filter((row) => Boolean(row.itemId))
              .map((row) => ({
                slotType: row.slotType,
                itemId: row.itemId!,
                quantity: row.quantity ?? 1,
              })),
            "ammunition_shot",
          );
        const currentInventory = async () =>
          normalizePersistedInventoryRows(
            await tx
              .select({
                itemId: schema.inventory.itemId,
                quantity: schema.inventory.quantity,
                slotIndex: schema.inventory.slotIndex,
                metadata: schema.inventory.metadata,
              })
              .from(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId)),
            "ammunition_shot",
          );

        if (existing) {
          const state = existing.operationState as
            | StoredAmmunitionShotOperation
            | LegacyStoredAmmunitionShotOperation
            | undefined;
          const legacy = state?.version === 1 ? state : null;
          const current = state?.version === 2 ? state : null;
          if (
            !state ||
            existing.playerId !== playerId ||
            existing.operationType !== "ammunition_shot" ||
            state.requestFingerprint !== requestFingerprint ||
            state.itemId !== itemId ||
            state.quantity !== 1 ||
            state.recoveryDisposition !== recoveryDisposition ||
            (recoveryDisposition === "recovered"
              ? !state.source
              : state.source !== null) ||
            (!legacy && !current) ||
            (legacy &&
              (existing.completed !== true ||
                (recoveryDisposition === "recovered"
                  ? !legacy.sourceId
                  : legacy.sourceId !== null))) ||
            (current &&
              ((current.status === "pending") !==
                (existing.completed === false) ||
                (current.status !== "pending") !==
                  (existing.completed === true) ||
                ((current.status === "fired" ||
                  current.status === "resolved") &&
                  recoveryDisposition === "recovered" &&
                  !current.sourceId) ||
                (current.status !== "fired" &&
                  current.status !== "resolved" &&
                  current.sourceId !== null)))
          ) {
            throw new Error("ammunition_shot_operation_id_conflict");
          }
          let sourceReceipt: GroundItemSourceRegistrationReceipt | null = null;
          if (
            state.source &&
            (legacy !== null ||
              current?.status === "fired" ||
              current?.status === "resolved")
          ) {
            sourceReceipt = await this.registerGroundItemSourceAsync(
              state.source,
              tx,
            );
            if (
              !sourceReceipt.replayed ||
              sourceReceipt.sourceId !== state.sourceId
            ) {
              throw new Error("ammunition_shot_source_receipt_invalid");
            }
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            itemId,
            quantity: 1,
            recoveryDisposition,
            status: legacy ? "fired" : current!.status,
            committed: await currentEquipment(),
            committedInventory: await currentInventory(),
            refundDestination: current?.refundDestination ?? null,
            sourceRequest: state.source,
            source: sourceReceipt,
          };
        }

        const persisted = await currentEquipment();
        const committed = debitEquipmentStackSnapshot(
          persisted,
          "arrows",
          itemId,
          1,
        );

        await tx
          .delete(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.equipment).values(
            committed.map((entry) => ({
              playerId,
              slotType: entry.slotType,
              itemId: entry.itemId,
              quantity: entry.quantity,
            })),
          );
        }

        const storedSource = source
          ? {
              ...source,
              position: { ...source.position },
              tile: { ...source.tile },
            }
          : null;
        const operationState: StoredAmmunitionShotOperation = {
          version: 2,
          requestFingerprint,
          itemId,
          quantity: 1,
          recoveryDisposition,
          committed,
          committedInventory: await currentInventory(),
          source: storedSource,
          sourceId: null,
          status: "pending",
          damageOperationId: null,
          refundDestination: null,
        };
        const nowResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const databaseNow = Number(
          databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
            ?.databaseNow,
        );
        if (!Number.isSafeInteger(databaseNow) || databaseNow < 0) {
          throw new Error("ammunition_shot_database_clock_invalid");
        }
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "ammunition_shot",
          operationState,
          completed: false,
          timestamp: databaseNow,
          completedAt: null,
        });

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          itemId,
          quantity: 1,
          recoveryDisposition,
          status: "pending",
          committed,
          committedInventory: operationState.committedInventory,
          refundDestination: null,
          sourceRequest: storedSource,
          source: null,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /** Commit the optional recovery source only after local launch admission. */
  async completeAmmunitionShotOperationAsync(
    request: AmmunitionShotSettlementRequest,
  ): Promise<AmmunitionShotCommitReceipt> {
    return this.settleAmmunitionShotOperationAsync(request, "fired");
  }

  /** Refund an exact staged debit when no projectile was admitted. */
  async cancelAmmunitionShotOperationAsync(
    request: AmmunitionShotSettlementRequest,
  ): Promise<AmmunitionShotCommitReceipt> {
    return this.settleAmmunitionShotOperationAsync(request, "cancelled");
  }

  /**
   * Recover interrupted pre-launch debits before equipment/inventory hydration.
   * A replacement process cannot recover the corresponding in-memory lease,
   * so an unresolved post-launch receipt must stop hydration for explicit
   * reconciliation instead of silently choosing a custody disposition.
   */
  async recoverPendingAmmunitionShotOperationsAsync(
    playerId: string,
  ): Promise<AmmunitionShotCommitReceipt[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("ammunition_shot_database_unavailable");
    }
    const normalizedPlayerId = String(playerId ?? "").trim();
    if (!normalizedPlayerId || normalizedPlayerId.length > 128) {
      throw new Error("ammunition_shot_request_invalid");
    }
    const rows = await this.db
      .select({
        operationId: schema.operationsLog.id,
        operationState: schema.operationsLog.operationState,
        completed: schema.operationsLog.completed,
      })
      .from(schema.operationsLog)
      .where(
        and(
          eq(schema.operationsLog.playerId, normalizedPlayerId),
          eq(schema.operationsLog.operationType, "ammunition_shot"),
          or(
            eq(schema.operationsLog.completed, false),
            sql`${schema.operationsLog.operationState}->>'status' = 'fired'`,
          ),
        ),
      )
      .orderBy(schema.operationsLog.timestamp, schema.operationsLog.id);
    const pending: Array<{
      operationId: string;
      requestFingerprint: string;
    }> = [];
    for (const row of rows) {
      const state = row.operationState as
        StoredAmmunitionShotOperation | undefined;
      if (
        state?.version !== 2 ||
        !/^[a-f0-9]{64}$/.test(state.requestFingerprint)
      ) {
        throw new Error("ammunition_shot_recovery_state_invalid");
      }
      if (state.status === "fired" && row.completed === true) {
        // The launch was durable, but neither damage nor a terminal
        // cancellation committed before process loss. The in-memory
        // projectile cannot be reconstructed from this receipt alone. Do not
        // silently consume, refund, or expose it: each outcome is a product
        // and economy policy that must be approved explicitly.
        throw new Error("ammunition_shot_fired_reconciliation_required");
      }
      if (state.status !== "pending" || row.completed !== false) {
        throw new Error("ammunition_shot_recovery_state_invalid");
      }
      pending.push({
        operationId: row.operationId,
        requestFingerprint: state.requestFingerprint,
      });
    }

    // Validate the complete recovery set before mutating any row. A fired
    // receipt discovered after a pending receipt must fail replacement
    // startup without partially refunding the player's staged operations.
    const recovered: AmmunitionShotCommitReceipt[] = [];
    for (const operation of pending) {
      recovered.push(
        await this.cancelAmmunitionShotOperationAsync({
          operationId: operation.operationId,
          playerId: normalizedPlayerId,
          requestFingerprint: operation.requestFingerprint,
        }),
      );
    }
    return recovered;
  }

  private async settleAmmunitionShotOperationAsync(
    request: AmmunitionShotSettlementRequest,
    requestedStatus: "fired" | "cancelled",
  ): Promise<AmmunitionShotCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("ammunition_shot_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    if (
      !/^ammunition-shot:[A-Za-z0-9]{20}$/.test(operationId) ||
      operationId !== request.operationId ||
      !playerId ||
      playerId !== request.playerId ||
      playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint)
    ) {
      throw new Error("ammunition_shot_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!characterRows[0]) {
          throw new Error("ammunition_shot_player_missing");
        }
        const operationRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = operationRows[0];
        const state = existing?.operationState as
          | StoredAmmunitionShotOperation
          | LegacyStoredAmmunitionShotOperation
          | undefined;
        if (
          !existing ||
          existing.playerId !== playerId ||
          existing.operationType !== "ammunition_shot" ||
          state?.requestFingerprint !== requestFingerprint ||
          (state.version !== 1 && state.version !== 2)
        ) {
          throw new Error("ammunition_shot_operation_id_conflict");
        }

        const loadEquipment = async () =>
          normalizeEquipmentSnapshot(
            (
              await tx
                .select({
                  slotType: schema.equipment.slotType,
                  itemId: schema.equipment.itemId,
                  quantity: schema.equipment.quantity,
                })
                .from(schema.equipment)
                .where(eq(schema.equipment.playerId, playerId))
            )
              .filter((row) => Boolean(row.itemId))
              .map((row) => ({
                slotType: row.slotType,
                itemId: row.itemId!,
                quantity: row.quantity ?? 1,
              })),
            "ammunition_shot",
          );
        const loadInventory = async () =>
          normalizePersistedInventoryRows(
            await tx
              .select({
                itemId: schema.inventory.itemId,
                quantity: schema.inventory.quantity,
                slotIndex: schema.inventory.slotIndex,
                metadata: schema.inventory.metadata,
              })
              .from(schema.inventory)
              .where(eq(schema.inventory.playerId, playerId)),
            "ammunition_shot",
          );

        if (state.version === 1) {
          if (existing.completed !== true) {
            throw new Error("ammunition_shot_operation_id_conflict");
          }
          const sourceReceipt = state.source
            ? await this.registerGroundItemSourceAsync(state.source, tx)
            : null;
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            itemId: state.itemId,
            quantity: 1,
            recoveryDisposition: state.recoveryDisposition,
            status: "fired",
            committed: await loadEquipment(),
            committedInventory: await loadInventory(),
            refundDestination: null,
            sourceRequest: state.source,
            source: sourceReceipt,
          };
        }

        if (
          (state.status === "pending") !== (existing.completed === false) ||
          (state.status !== "pending") !== (existing.completed === true)
        ) {
          throw new Error("ammunition_shot_operation_id_conflict");
        }
        if (
          state.status !== "pending" &&
          !(requestedStatus === "cancelled" && state.status === "fired")
        ) {
          const sourceReceipt =
            (state.status === "fired" || state.status === "resolved") &&
            state.source
              ? await this.registerGroundItemSourceAsync(state.source, tx)
              : null;
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            itemId: state.itemId,
            quantity: 1,
            recoveryDisposition: state.recoveryDisposition,
            status: state.status,
            committed: await loadEquipment(),
            committedInventory: await loadInventory(),
            refundDestination: state.refundDestination,
            sourceRequest: state.source,
            source: sourceReceipt,
          };
        }

        let committed = await loadEquipment();
        let committedInventory = await loadInventory();
        let refundDestination: AmmunitionShotRefundDestination | null = null;
        let sourceReceipt: GroundItemSourceRegistrationReceipt | null = null;

        if (state.status === "fired") {
          sourceReceipt = state.source
            ? await this.registerGroundItemSourceAsync(state.source, tx)
            : null;
          if (
            sourceReceipt &&
            (!sourceReceipt.replayed ||
              sourceReceipt.sourceId !== state.sourceId)
          ) {
            throw new Error("ammunition_shot_source_receipt_invalid");
          }
        } else if (requestedStatus === "fired") {
          sourceReceipt = state.source
            ? await this.registerGroundItemSourceAsync(state.source, tx)
            : null;
          if (sourceReceipt?.replayed) {
            throw new Error("ammunition_shot_source_preexisting");
          }
        } else {
          const arrowSlot = committed.find(
            (entry) => entry.slotType === "arrows",
          );
          if (!arrowSlot || arrowSlot.itemId === state.itemId) {
            if (arrowSlot) {
              const restoredQuantity = arrowSlot.quantity + 1;
              if (
                !Number.isSafeInteger(restoredQuantity) ||
                restoredQuantity > MAX_PERSISTED_ITEM_QUANTITY
              ) {
                throw new Error("ammunition_shot_quantity_overflow");
              }
              arrowSlot.quantity = restoredQuantity;
            } else {
              committed.push({
                slotType: "arrows",
                itemId: state.itemId,
                quantity: 1,
              });
              committed.sort((left, right) =>
                left.slotType.localeCompare(right.slotType),
              );
            }
            refundDestination = "equipment";
            await tx
              .delete(schema.equipment)
              .where(eq(schema.equipment.playerId, playerId));
            if (committed.length > 0) {
              await tx.insert(schema.equipment).values(
                committed.map((entry) => ({
                  playerId,
                  slotType: entry.slotType,
                  itemId: entry.itemId,
                  quantity: entry.quantity,
                })),
              );
            }
          } else {
            try {
              committedInventory = creditGatheringReward(
                committedInventory,
                { itemId: state.itemId, quantity: 1, stackable: true },
                "ammunition_shot_refund",
              );
              refundDestination = "inventory";
              await tx
                .delete(schema.inventory)
                .where(eq(schema.inventory.playerId, playerId));
              if (committedInventory.length > 0) {
                await tx.insert(schema.inventory).values(
                  committedInventory.map((entry) => ({
                    playerId,
                    itemId: entry.itemId,
                    quantity: entry.quantity,
                    slotIndex: entry.slotIndex,
                    metadata: entry.metadata
                      ? JSON.stringify(entry.metadata)
                      : null,
                  })),
                );
              }
            } catch (error) {
              if (
                !(error instanceof Error) ||
                error.message !== "ammunition_shot_refund_inventory_full"
              ) {
                throw error;
              }
              const bankRows = await tx
                .select({
                  id: schema.bankStorage.id,
                  itemId: schema.bankStorage.itemId,
                  quantity: schema.bankStorage.quantity,
                  slot: schema.bankStorage.slot,
                  tabIndex: schema.bankStorage.tabIndex,
                })
                .from(schema.bankStorage)
                .where(eq(schema.bankStorage.playerId, playerId));
              const existingBankStack = bankRows.find(
                (entry) => entry.itemId === state.itemId,
              );
              if (existingBankStack) {
                const restoredQuantity = existingBankStack.quantity + 1;
                if (
                  !Number.isSafeInteger(restoredQuantity) ||
                  restoredQuantity > BANKING_CONSTANTS.MAX_ITEM_STACK
                ) {
                  throw new Error("ammunition_shot_quantity_overflow");
                }
                await tx
                  .update(schema.bankStorage)
                  .set({ quantity: restoredQuantity })
                  .where(eq(schema.bankStorage.id, existingBankStack.id));
              } else {
                const occupied = new Set(
                  bankRows.map((entry) => `${entry.tabIndex}:${entry.slot}`),
                );
                let free: { tabIndex: number; slot: number } | null = null;
                for (
                  let tabIndex = 0;
                  tabIndex < BANKING_CONSTANTS.MAX_TABS && !free;
                  tabIndex++
                ) {
                  for (
                    let slot = 0;
                    slot < BANKING_CONSTANTS.SLOTS_PER_TAB;
                    slot++
                  ) {
                    if (!occupied.has(`${tabIndex}:${slot}`)) {
                      free = { tabIndex, slot };
                      break;
                    }
                  }
                }
                if (!free) throw new Error("ammunition_shot_bank_full");
                await tx.insert(schema.bankStorage).values({
                  playerId,
                  itemId: state.itemId,
                  quantity: 1,
                  slot: free.slot,
                  tabIndex: free.tabIndex,
                });
              }
              refundDestination = "bank";
            }
          }
        }

        const nowResult = await tx.execute(
          sql`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow"`,
        );
        const databaseNow = Number(
          databaseQueryRows<{ databaseNow?: number | string }>(nowResult)[0]
            ?.databaseNow,
        );
        if (!Number.isSafeInteger(databaseNow) || databaseNow < 0) {
          throw new Error("ammunition_shot_database_clock_invalid");
        }
        const settledState: StoredAmmunitionShotOperation = {
          ...state,
          committed,
          committedInventory,
          sourceId: sourceReceipt?.sourceId ?? null,
          status: state.status === "fired" ? "resolved" : requestedStatus,
          refundDestination,
        };
        await tx
          .update(schema.operationsLog)
          .set({
            operationState: settledState,
            completed: true,
            completedAt: databaseNow,
          })
          .where(eq(schema.operationsLog.id, operationId));
        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          itemId: state.itemId,
          quantity: 1,
          recoveryDisposition: state.recoveryDisposition,
          status: state.status === "fired" ? "resolved" : requestedStatus,
          committed,
          committedInventory,
          refundDestination,
          sourceRequest: state.source,
          source: sourceReceipt,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  /**
   * Commit one weapon-valid attack style and its optional public acknowledgement
   * as one serializable player-state receipt.
   */
  async commitAttackStyleOperationAsync(
    request: AttackStyleCommitRequest,
  ): Promise<AttackStyleCommitReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("attack_style_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const requestedStyle = normalizeAttackStyle(request.requestedStyle);
    const requestedPublicActionObservation =
      request.publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelStyleObservationContext(
            request.publicActionObservation,
          );
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operationId,
      ) ||
      !playerId ||
      playerId.length > 128 ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      (request.publicActionObservation !== undefined &&
        (!requestedPublicActionObservation ||
          requestedPublicActionObservation.operationId !== operationId ||
          requestedPublicActionObservation.actorId !== playerId ||
          requestedPublicActionObservation.style !== requestedStyle)) ||
      requestFingerprint !==
        attackStyleFingerprint(
          playerId,
          requestedStyle,
          requestedPublicActionObservation ?? undefined,
        )
    ) {
      throw new Error("attack_style_request_invalid");
    }

    this.flushSaveBuffer();
    return this.enqueuePlayerSave(() =>
      this.executeInTransaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
          );
          const characterRows = await tx
            .select({
              id: schema.characters.id,
              attackStyle: schema.characters.attackStyle,
            })
            .from(schema.characters)
            .where(eq(schema.characters.id, playerId));
          const character = characterRows[0];
          if (!character) throw new Error("attack_style_player_missing");
          const currentStyle = normalizeAttackStyle(
            character.attackStyle ?? "accurate",
          );

          const existingRows = await tx
            .select({
              playerId: schema.operationsLog.playerId,
              operationType: schema.operationsLog.operationType,
              operationState: schema.operationsLog.operationState,
              completed: schema.operationsLog.completed,
            })
            .from(schema.operationsLog)
            .where(eq(schema.operationsLog.id, operationId));
          const existing = existingRows[0];
          if (existing) {
            const state = existing.operationState as
              StoredAttackStyleOperation | undefined;
            const statePublicActionObservation =
              state?.publicActionObservation === undefined
                ? undefined
                : parseStreamingDuelStyleObservationContext(
                    state.publicActionObservation,
                  );
            if (
              existing.playerId !== playerId ||
              existing.operationType !== "attack_style_change" ||
              existing.completed !== true ||
              state?.version !== 1 ||
              state.requestFingerprint !== requestFingerprint ||
              normalizeAttackStyle(state.requestedStyle) !== requestedStyle ||
              (state.publicActionObservation !== undefined &&
                !statePublicActionObservation) ||
              JSON.stringify(statePublicActionObservation) !==
                JSON.stringify(requestedPublicActionObservation)
            ) {
              throw new Error("attack_style_operation_id_conflict");
            }
            if (statePublicActionObservation) {
              await commitStylePublicActionObservation(
                tx,
                statePublicActionObservation,
                true,
              );
            }
            return {
              operationId,
              playerId,
              requestFingerprint,
              requestedStyle,
              replayed: true,
              operationCommittedStyle: requestedStyle,
              currentStyle,
            };
          }

          const weaponRows = await tx
            .select({ itemId: schema.equipment.itemId })
            .from(schema.equipment)
            .where(
              and(
                eq(schema.equipment.playerId, playerId),
                eq(schema.equipment.slotType, "weapon"),
              ),
            );
          if (weaponRows.length > 1) {
            throw new Error("attack_style_equipment_state_invalid");
          }
          const weaponType = resolvePersistedWeaponType(
            weaponRows[0]?.itemId ?? null,
          );
          if (
            !isStyleValidForWeapon(
              weaponType,
              requestedStyle as Parameters<typeof isStyleValidForWeapon>[1],
            )
          ) {
            throw new Error("attack_style_weapon_rejected");
          }

          await tx
            .update(schema.characters)
            .set({ attackStyle: requestedStyle })
            .where(eq(schema.characters.id, playerId));
          if (requestedPublicActionObservation) {
            await commitStylePublicActionObservation(
              tx,
              requestedPublicActionObservation,
              false,
            );
          }
          const operationState: StoredAttackStyleOperation = {
            version: 1,
            requestFingerprint,
            requestedStyle,
            ...(requestedPublicActionObservation
              ? { publicActionObservation: requestedPublicActionObservation }
              : {}),
          };
          const now = Date.now();
          await tx.insert(schema.operationsLog).values({
            id: operationId,
            playerId,
            operationType: "attack_style_change",
            operationState,
            completed: true,
            timestamp: now,
            completedAt: now,
          });
          return {
            operationId,
            playerId,
            requestFingerprint,
            requestedStyle,
            replayed: false,
            operationCommittedStyle: requestedStyle,
            currentStyle: requestedStyle,
          };
        },
        { isolationLevel: "serializable", maxConflictRetries: 4 },
      ),
    );
  }

  /** Stage one exact duel movement/engagement command before execution. */
  async stageStreamingDuelExecutorCommandAsync(
    request: StreamingDuelExecutorCommandRequest,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("streaming_duel_executor_database_unavailable");
    }
    const normalized = normalizeStreamingDuelExecutorCommandRequest(request);
    const {
      operationId,
      playerId,
      requestFingerprint,
      publicActionObservation,
      command,
    } = normalized;

    this.flushSaveBuffer();
    return this.enqueuePlayerSave(() =>
      this.executeInTransaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
          );
          const characterRows = await tx
            .select({ id: schema.characters.id })
            .from(schema.characters)
            .where(eq(schema.characters.id, playerId));
          if (!characterRows[0]) {
            throw new Error("streaming_duel_executor_player_missing");
          }

          const existingRows = await tx
            .select({
              playerId: schema.operationsLog.playerId,
              operationType: schema.operationsLog.operationType,
              operationState: schema.operationsLog.operationState,
              completed: schema.operationsLog.completed,
            })
            .from(schema.operationsLog)
            .where(eq(schema.operationsLog.id, operationId));
          const existing = existingRows[0];
          if (existing) {
            const state = existing.operationState as
              StoredStreamingDuelExecutorCommand | undefined;
            const storedContext = parseStreamingDuelExecutorObservationContext(
              state?.publicActionObservation,
            );
            let storedCommand: StreamingDuelExecutorCommand | null = null;
            if (storedContext) {
              try {
                storedCommand = normalizeStreamingDuelExecutorCommand(
                  storedContext,
                  state?.command,
                );
              } catch {
                storedCommand = null;
              }
            }
            if (
              existing.playerId !== playerId ||
              existing.operationType !== "streaming_duel_executor_command" ||
              state?.version !== 1 ||
              state.requestFingerprint !== requestFingerprint ||
              !storedContext ||
              !storedCommand ||
              JSON.stringify(storedContext) !==
                JSON.stringify(publicActionObservation) ||
              JSON.stringify(storedCommand) !== JSON.stringify(command) ||
              (existing.completed === true) !== (state.outcome !== null) ||
              (state.outcome !== null &&
                !isStreamingDuelExecutorCommandOutcome(state.outcome))
            ) {
              throw new Error("streaming_duel_executor_operation_conflict");
            }
            if (state.outcome) {
              await commitExecutorPublicActionObservation(
                tx,
                storedContext,
                state.outcome,
                true,
              );
            }
            return {
              ...normalized,
              replayed: true,
              completed: existing.completed === true,
              outcome: state.outcome,
            };
          }

          const operationState: StoredStreamingDuelExecutorCommand = {
            version: 1,
            requestFingerprint,
            publicActionObservation,
            command,
            outcome: null,
          };
          const now = Date.now();
          await tx.insert(schema.operationsLog).values({
            id: operationId,
            playerId,
            operationType: "streaming_duel_executor_command",
            operationState,
            completed: false,
            timestamp: now,
            completedAt: null,
          });
          return {
            ...normalized,
            replayed: false,
            completed: false,
            outcome: null,
          };
        },
        { isolationLevel: "serializable", maxConflictRetries: 4 },
      ),
    );
  }

  /** Co-commit an executor outcome and its exact public observation. */
  async completeStreamingDuelExecutorCommandAsync(
    request: StreamingDuelExecutorCommandCompletionRequest,
  ): Promise<StreamingDuelExecutorCommandReceipt> {
    if (!this.db || this.isDestroying) {
      throw new Error("streaming_duel_executor_database_unavailable");
    }
    const normalized = normalizeStreamingDuelExecutorCommandRequest(request);
    const outcome = request.outcome;
    if (!isStreamingDuelExecutorCommandOutcome(outcome)) {
      throw new Error("streaming_duel_executor_outcome_invalid");
    }
    const { operationId, playerId } = normalized;

    this.flushSaveBuffer();
    return this.enqueuePlayerSave(() =>
      this.executeInTransaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
          );
          const existingRows = await tx
            .select({
              playerId: schema.operationsLog.playerId,
              operationType: schema.operationsLog.operationType,
              operationState: schema.operationsLog.operationState,
              completed: schema.operationsLog.completed,
            })
            .from(schema.operationsLog)
            .where(eq(schema.operationsLog.id, operationId));
          const existing = existingRows[0];
          const state = existing?.operationState as
            StoredStreamingDuelExecutorCommand | undefined;
          const storedContext = parseStreamingDuelExecutorObservationContext(
            state?.publicActionObservation,
          );
          let storedCommand: StreamingDuelExecutorCommand | null = null;
          if (storedContext) {
            try {
              storedCommand = normalizeStreamingDuelExecutorCommand(
                storedContext,
                state?.command,
              );
            } catch {
              storedCommand = null;
            }
          }
          if (
            !existing ||
            existing.playerId !== playerId ||
            existing.operationType !== "streaming_duel_executor_command" ||
            state?.version !== 1 ||
            state.requestFingerprint !== normalized.requestFingerprint ||
            !storedContext ||
            !storedCommand ||
            JSON.stringify(storedContext) !==
              JSON.stringify(normalized.publicActionObservation) ||
            JSON.stringify(storedCommand) !==
              JSON.stringify(normalized.command) ||
            (existing.completed === true) !== (state.outcome !== null) ||
            (state.outcome !== null && state.outcome !== outcome)
          ) {
            throw new Error("streaming_duel_executor_operation_conflict");
          }

          if (existing.completed === true && state.outcome) {
            await commitExecutorPublicActionObservation(
              tx,
              storedContext,
              state.outcome,
              true,
            );
            return {
              ...normalized,
              replayed: true,
              completed: true,
              outcome: state.outcome,
            };
          }

          await commitExecutorPublicActionObservation(
            tx,
            storedContext,
            outcome,
            false,
          );
          const completedState: StoredStreamingDuelExecutorCommand = {
            ...state,
            outcome,
          };
          await tx
            .update(schema.operationsLog)
            .set({
              operationState: completedState,
              completed: true,
              completedAt: Date.now(),
            })
            .where(eq(schema.operationsLog.id, operationId));
          return {
            ...normalized,
            replayed: false,
            completed: true,
            outcome,
          };
        },
        { isolationLevel: "serializable", maxConflictRetries: 4 },
      ),
    );
  }

  /** Load incomplete commands for deterministic active-cycle reconciliation. */
  async listPendingStreamingDuelExecutorCommandsAsync(
    cycleId: string,
  ): Promise<StreamingDuelExecutorCommandReceipt[]> {
    if (!this.db || this.isDestroying) {
      throw new Error("streaming_duel_executor_database_unavailable");
    }
    const normalizedCycleId = String(cycleId ?? "").trim();
    if (!normalizedCycleId || normalizedCycleId.length > 256) {
      throw new Error("streaming_duel_executor_cycle_invalid");
    }
    const rows = await this.db
      .select({
        id: schema.operationsLog.id,
        playerId: schema.operationsLog.playerId,
        operationState: schema.operationsLog.operationState,
      })
      .from(schema.operationsLog)
      .where(
        and(
          eq(
            schema.operationsLog.operationType,
            "streaming_duel_executor_command",
          ),
          eq(schema.operationsLog.completed, false),
          sql`${schema.operationsLog.operationState}->'publicActionObservation'->>'cycleId' = ${normalizedCycleId}`,
        ),
      )
      .orderBy(schema.operationsLog.timestamp, schema.operationsLog.id);

    return rows.map((row) => {
      const state = row.operationState as
        StoredStreamingDuelExecutorCommand | undefined;
      const request = normalizeStreamingDuelExecutorCommandRequest({
        operationId: row.id,
        playerId: row.playerId,
        requestFingerprint: state?.requestFingerprint ?? "",
        publicActionObservation:
          state?.publicActionObservation as StreamingDuelExecutorObservationContext,
        command: state?.command as StreamingDuelExecutorCommand,
      });
      if (state?.version !== 1 || state.outcome !== null) {
        throw new Error("streaming_duel_executor_operation_conflict");
      }
      return {
        ...request,
        replayed: true,
        completed: false,
        outcome: null,
      };
    });
  }

  /**
   * Commit one exact fixed-point prayer transition and its replay receipt.
   * Every transition shares the per-character row lock used by combat custody.
   */
  async commitPrayerStateOperationAsync(
    request: PrayerStateCommitRequest,
  ): Promise<PrayerStateCommitReceipt> {
    if (!this.db) throw new Error("prayer_state_database_unavailable");

    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const requestFingerprint = String(request.requestFingerprint ?? "").trim();
    const transition = request.transition;
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      !PRAYER_TRANSITIONS.has(transition) ||
      !/^[a-f0-9]{64}$/.test(requestFingerprint)
    ) {
      throw new Error("prayer_state_request_invalid");
    }
    const expected = normalizePrayerSnapshot(request.expected, "prayer_state");
    const committed = normalizePrayerSnapshot(
      request.committed,
      "prayer_state",
    );
    validatePrayerTransition(transition, expected, committed);
    const requestedPublicActionObservation =
      request.publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelPrayerObservationContext(
            request.publicActionObservation,
          );
    if (
      (request.publicActionObservation !== undefined &&
        (!requestedPublicActionObservation ||
          requestedPublicActionObservation.actorId !== playerId ||
          !prayerPublicObservationMatchesTransition(
            requestedPublicActionObservation,
            transition,
            expected,
            committed,
          ))) ||
      requestFingerprint !==
        prayerStateFingerprint(
          playerId,
          transition,
          expected,
          committed,
          requestedPublicActionObservation ?? undefined,
        )
    ) {
      throw new Error("prayer_state_request_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const characterRows = await tx
          .select({
            id: schema.characters.id,
            prayerPoints: schema.characters.prayerPoints,
            prayerPointUnits: schema.characters.prayerPointUnits,
            prayerMaxPoints: schema.characters.prayerMaxPoints,
            activePrayers: schema.characters.activePrayers,
          })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        const character = characterRows[0];
        if (!character) throw new Error("prayer_state_player_missing");

        const persisted = normalizePrayerSnapshot(
          {
            pointUnits:
              character.prayerPointUnits ??
              (character.prayerPoints ?? 1) * PRAYER_POINT_UNITS_PER_POINT,
            maxPoints: character.prayerMaxPoints ?? 1,
            activePrayers: character.activePrayers ?? [],
          },
          "prayer_state",
        );

        const compactedRows = await tx
          .select({
            playerId: schema.compactedPrayerStateReceipts.playerId,
            requestFingerprint:
              schema.compactedPrayerStateReceipts.requestFingerprint,
            transition: schema.compactedPrayerStateReceipts.transition,
            publicObservationOperationId:
              schema.compactedPrayerStateReceipts.publicObservationOperationId,
          })
          .from(schema.compactedPrayerStateReceipts)
          .where(
            eq(schema.compactedPrayerStateReceipts.operationId, operationId),
          );
        const compacted = compactedRows[0];
        if (compacted) {
          assertCompactedPrayerStateReceiptMatches(compacted, {
            playerId,
            requestFingerprint,
            transition,
            publicObservationOperationId:
              requestedPublicActionObservation?.operationId ?? null,
          });
          if (requestedPublicActionObservation) {
            await commitPrayerPublicActionObservation(
              tx,
              requestedPublicActionObservation,
              true,
            );
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            transition,
            replayed: true,
            committed: persisted,
          };
        }

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredPrayerStateOperation | undefined;
          const statePublicActionObservation =
            state?.publicActionObservation === undefined
              ? undefined
              : parseStreamingDuelPrayerObservationContext(
                  state.publicActionObservation,
                );
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "prayer_state_transition" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.transition !== transition ||
            !prayerSnapshotsEqual(
              normalizePrayerSnapshot(state.expected, "prayer_state"),
              expected,
            ) ||
            !prayerSnapshotsEqual(
              normalizePrayerSnapshot(state.committed, "prayer_state"),
              committed,
            ) ||
            (state?.publicActionObservation !== undefined &&
              !statePublicActionObservation) ||
            JSON.stringify(statePublicActionObservation) !==
              JSON.stringify(requestedPublicActionObservation)
          ) {
            throw new Error("prayer_state_operation_id_conflict");
          }
          if (statePublicActionObservation) {
            await commitPrayerPublicActionObservation(
              tx,
              statePublicActionObservation,
              true,
            );
          }
          // Converge on current locked custody. An old replay after a newer
          // drain/toggle must never restore its historical post-state.
          return {
            operationId,
            playerId,
            requestFingerprint,
            transition,
            replayed: true,
            committed: persisted,
          };
        }

        if (!prayerSnapshotsEqual(persisted, expected)) {
          throw new Error("prayer_state_conflict");
        }

        await tx
          .update(schema.characters)
          .set({
            prayerPointUnits: committed.pointUnits,
            prayerPoints:
              committed.pointUnits <= 0
                ? 0
                : Math.ceil(
                    committed.pointUnits / PRAYER_POINT_UNITS_PER_POINT,
                  ),
            prayerMaxPoints: committed.maxPoints,
            activePrayers: committed.activePrayers,
          })
          .where(eq(schema.characters.id, playerId));

        if (requestedPublicActionObservation) {
          await commitPrayerPublicActionObservation(
            tx,
            requestedPublicActionObservation,
            false,
          );
        }

        const operationState: StoredPrayerStateOperation = {
          version: 1,
          requestFingerprint,
          transition,
          expected,
          committed,
          ...(requestedPublicActionObservation
            ? { publicActionObservation: requestedPublicActionObservation }
            : {}),
        };
        const now = Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "prayer_state_transition",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });

        return {
          operationId,
          playerId,
          requestFingerprint,
          transition,
          replayed: false,
          committed,
        };
      },
      {
        isolationLevel: "serializable",
        // Every fighter drains concurrently and each transaction appends an
        // idempotency receipt to the shared operations log. PostgreSQL SSI can
        // abort a valid snapshot even though the character rows are distinct;
        // retry the complete rolled-back transition on a fresh connection.
        maxConflictRetries: 4,
      },
    );
  }

  // ============================================================================
  // SESSION TRACKING
  // ============================================================================

  /**
   * Create a new player session
   * Delegates to SessionRepository
   */
  async createPlayerSessionAsync(
    sessionData: Omit<PlayerSessionRow, "id" | "sessionId">,
    sessionId?: string,
  ): Promise<string> {
    try {
      return await this.sessionRepository.createPlayerSessionAsync(
        sessionData,
        sessionId,
      );
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          `[DatabaseSystem] createPlayerSessionAsync(${sessionData.playerId}) failed due to database connectivity; continuing in best-effort mode`,
          error,
        );
        return (
          sessionId ||
          `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        );
      }
      throw error;
    }
  }

  /**
   * Update an existing player session
   * Delegates to SessionRepository
   */
  async updatePlayerSessionAsync(
    sessionId: string,
    updates: Partial<PlayerSessionRow>,
  ): Promise<void> {
    try {
      return await this.sessionRepository.updatePlayerSessionAsync(
        sessionId,
        updates,
      );
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          `[DatabaseSystem] updatePlayerSessionAsync(${sessionId}) failed due to database connectivity; continuing in best-effort mode`,
          error,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Batch update lastActivity for multiple sessions in a single query
   *
   * Delegates to SessionRepository.batchUpdateLastActivityAsync
   * Uses a single SQL query instead of N separate queries.
   */
  async batchUpdateSessionLastActivityAsync(
    sessionIds: string[],
    timestamp: number,
  ): Promise<void> {
    try {
      return await this.sessionRepository.batchUpdateLastActivityAsync(
        sessionIds,
        timestamp,
      );
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          `[DatabaseSystem] batchUpdateSessionLastActivityAsync(${sessionIds.length}) failed due to database connectivity; continuing in best-effort mode`,
          error,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Get all active player sessions
   * Delegates to SessionRepository
   */
  async getActivePlayerSessionsAsync(): Promise<PlayerSessionRow[]> {
    try {
      return await this.sessionRepository.getActivePlayerSessionsAsync();
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          "[DatabaseSystem] getActivePlayerSessionsAsync failed due to database connectivity; continuing in best-effort mode",
          error,
        );
        return [];
      }
      throw error;
    }
  }

  /**
   * End a player session
   * Delegates to SessionRepository
   */
  async endPlayerSessionAsync(
    sessionId: string,
    reason?: string,
  ): Promise<void> {
    try {
      return await this.sessionRepository.endPlayerSessionAsync(
        sessionId,
        reason,
      );
    } catch (error) {
      if (DB_WRITE_ERRORS_NON_FATAL && isTransientDbConnectivityError(error)) {
        console.warn(
          `[DatabaseSystem] endPlayerSessionAsync(${sessionId}) failed due to database connectivity; continuing in best-effort mode`,
          error,
        );
        return;
      }
      throw error;
    }
  }

  // ============================================================================
  // WORLD CHUNK PERSISTENCE
  // ============================================================================

  /**
   * Load world chunk data from database
   * Delegates to WorldChunkRepository
   */
  async getWorldChunkAsync(
    chunkX: number,
    chunkZ: number,
  ): Promise<WorldChunkRow | null> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return null;
    return this.worldChunkRepository.getWorldChunkAsync(chunkX, chunkZ);
  }

  /**
   * Save world chunk data to database
   * Delegates to WorldChunkRepository
   */
  async saveWorldChunkAsync(chunkData: {
    chunkX: number;
    chunkZ: number;
    data: string;
  }): Promise<void> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return;
    return this.worldChunkRepository.saveWorldChunkAsync(chunkData);
  }

  /**
   * Get world items for a chunk
   * Delegates to WorldChunkRepository
   */
  async getWorldItemsAsync(
    _chunkX: number,
    _chunkZ: number,
  ): Promise<ItemRow[]> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return [];
    return this.worldChunkRepository.getWorldItemsAsync(_chunkX, _chunkZ);
  }

  /**
   * Save world items for a chunk
   * Delegates to WorldChunkRepository
   */
  async saveWorldItemsAsync(
    _chunkX: number,
    _chunkZ: number,
    _items: ItemRow[],
  ): Promise<void> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return;
    return this.worldChunkRepository.saveWorldItemsAsync(
      _chunkX,
      _chunkZ,
      _items,
    );
  }

  /**
   * Get inactive chunks
   * Delegates to WorldChunkRepository
   */
  async getInactiveChunksAsync(minutes: number): Promise<WorldChunkRow[]> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return [];
    return this.worldChunkRepository.getInactiveChunksAsync(minutes);
  }

  /**
   * Update chunk player count
   * Delegates to WorldChunkRepository
   */
  async updateChunkPlayerCountAsync(
    chunkX: number,
    chunkZ: number,
    playerCount: number,
  ): Promise<void> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return;
    return this.worldChunkRepository.updateChunkPlayerCountAsync(
      chunkX,
      chunkZ,
      playerCount,
    );
  }

  /**
   * Mark chunk for reset
   * Delegates to WorldChunkRepository
   */
  async markChunkForResetAsync(chunkX: number, chunkZ: number): Promise<void> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return;
    return this.worldChunkRepository.markChunkForResetAsync(chunkX, chunkZ);
  }

  /**
   * Reset chunk
   * Delegates to WorldChunkRepository
   */
  async resetChunkAsync(chunkX: number, chunkZ: number): Promise<void> {
    if (DISABLE_WORLD_CHUNK_PERSISTENCE) return;
    return this.worldChunkRepository.resetChunkAsync(chunkX, chunkZ);
  }

  // ============================================================================
  // NPC KILL TRACKING
  // ============================================================================

  /**
   * Increment NPC kill count for a player
   * Delegates to NPCKillRepository
   */
  async incrementNPCKillAsync(playerId: string, npcId: string): Promise<void> {
    return this.npcKillRepository.incrementNPCKillAsync(playerId, npcId);
  }

  /**
   * Get all NPC kill statistics for a player
   * Delegates to NPCKillRepository
   */
  async getPlayerNPCKillsAsync(
    playerId: string,
  ): Promise<Array<{ npcId: string; killCount: number }>> {
    return this.npcKillRepository.getPlayerNPCKillsAsync(playerId);
  }

  /**
   * Get kill count for a specific NPC type
   * Delegates to NPCKillRepository
   */
  async getNPCKillCountAsync(playerId: string, npcId: string): Promise<number> {
    return this.npcKillRepository.getNPCKillCountAsync(playerId, npcId);
  }

  // ============================================================================
  // QUEST MANAGEMENT
  // ============================================================================

  /**
   * Get the quest repository for quest persistence operations
   *
   * Used by QuestSystem to persist quest progress, completion status,
   * and quest points to the database.
   *
   * @returns The QuestRepository instance
   */
  getQuestRepository(): QuestRepository {
    return this.questRepository;
  }

  // ============================================================================
  // ACTIVITY LOG MANAGEMENT (Admin Panel)
  // ============================================================================

  /**
   * Insert a single activity log entry
   * Delegates to ActivityLogRepository
   */
  async insertActivityAsync(entry: ActivityLogEntry): Promise<number> {
    return this.activityLogRepository.insertActivityAsync(entry);
  }

  /**
   * Insert multiple activity log entries in a batch
   * Delegates to ActivityLogRepository
   */
  async insertActivitiesBatchAsync(
    entries: ActivityLogEntry[],
  ): Promise<number> {
    return this.activityLogRepository.insertActivitiesBatchAsync(entries);
  }

  /**
   * Query activity logs with filtering
   * Delegates to ActivityLogRepository
   */
  async queryActivitiesAsync(
    options: ActivityLogQueryOptions,
  ): Promise<ActivityLogRow[]> {
    return this.activityLogRepository.queryActivitiesAsync(options);
  }

  /**
   * Get count of activity logs matching criteria
   * Delegates to ActivityLogRepository
   */
  async countActivitiesAsync(
    options: ActivityLogQueryOptions,
  ): Promise<number> {
    return this.activityLogRepository.countActivitiesAsync(options);
  }

  /**
   * Get distinct event types in the activity log
   * Delegates to ActivityLogRepository
   */
  async getActivityEventTypesAsync(): Promise<string[]> {
    return this.activityLogRepository.getEventTypesAsync();
  }

  /**
   * Insert a trade record
   * Delegates to ActivityLogRepository
   */
  async insertTradeAsync(entry: TradeEntry): Promise<number> {
    return this.activityLogRepository.insertTradeAsync(entry);
  }

  /**
   * Query trade history with filtering
   * Delegates to ActivityLogRepository
   */
  async queryTradesAsync(options: TradeQueryOptions): Promise<TradeRow[]> {
    return this.activityLogRepository.queryTradesAsync(options);
  }

  /**
   * Get count of trades matching criteria
   * Delegates to ActivityLogRepository
   */
  async countTradesAsync(options: TradeQueryOptions): Promise<number> {
    return this.activityLogRepository.countTradesAsync(options);
  }

  /**
   * Cleanup old activity logs (retention policy)
   * Delegates to ActivityLogRepository
   */
  async cleanupOldActivitiesAsync(daysOld: number = 90): Promise<number> {
    return this.activityLogRepository.cleanupOldActivitiesAsync(daysOld);
  }

  /**
   * Cleanup old trade records (retention policy)
   * Delegates to ActivityLogRepository
   */
  async cleanupOldTradesAsync(daysOld: number = 90): Promise<number> {
    return this.activityLogRepository.cleanupOldTradesAsync(daysOld);
  }

  /**
   * Get activity summary for a player
   * Delegates to ActivityLogRepository
   */
  async getPlayerActivitySummaryAsync(
    playerId: string,
  ): Promise<Record<string, number>> {
    return this.activityLogRepository.getPlayerActivitySummaryAsync(playerId);
  }

  /**
   * Get the ActivityLogRepository for direct access
   * Used by ActivityLoggerSystem for batch operations
   */
  getActivityLogRepository(): ActivityLogRepository {
    return this.activityLogRepository;
  }

  /**
   * Get the BankRepository for direct access
   * Used by admin routes for bank queries
   */
  getBankRepository(): BankRepository {
    return this.bankRepository;
  }

  // ============================================================================
  // DEATH LOCK MANAGEMENT
  // ============================================================================

  /**
   * Save or update a death lock for a player
   * Delegates to DeathRepository
   *
   * CRITICAL FOR SECURITY: Prevents item duplication on server restart!
   *
   * Now includes items array for crash recovery.
   *
   * @param data - Death lock data including items for recovery
   * @param tx - Optional transaction context for atomic operations
   */
  async commitSafeAreaDeathOperationAsync(
    request: SafeDeathCaptureCommitRequest,
  ): Promise<SafeDeathCaptureCommitReceipt> {
    if (!this.db) throw new Error("safe_death_database_unavailable");
    const operationId = normalizeDeathOperationId(request.operationId);
    const playerId = normalizeDeathPlayerId(request.playerId);
    const deathTimestamp = Number(request.deathTimestamp);
    const position = {
      x: Number(request.position?.x),
      y: Number(request.position?.y),
      z: Number(request.position?.z),
    };
    const killedBy = String(request.killedBy ?? "").trim();
    if (
      !Number.isSafeInteger(deathTimestamp) ||
      deathTimestamp <= 0 ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z) ||
      Math.abs(position.x) > 10_000 ||
      Math.abs(position.z) > 10_000 ||
      position.y < -500 ||
      position.y > 500 ||
      !killedBy ||
      killedBy.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(killedBy)
    ) {
      throw new Error("safe_death_request_invalid");
    }
    const requestFingerprint = safeDeathCaptureFingerprint(
      playerId,
      deathTimestamp,
      position,
      killedBy,
    );

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const character = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!character[0]) throw new Error("safe_death_player_missing");

        const operationRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existingOperation = operationRows[0];
        if (existingOperation) {
          const state = existingOperation.operationState as
            StoredSafeDeathCaptureOperation | undefined;
          if (
            existingOperation.playerId !== playerId ||
            existingOperation.operationType !== "safe_death_capture" ||
            existingOperation.completed !== true ||
            state?.version !== 1 ||
            state.requestFingerprint !== requestFingerprint ||
            state.deathTimestamp !== deathTimestamp ||
            JSON.stringify(state.position) !== JSON.stringify(position) ||
            state.killedBy !== killedBy
          ) {
            throw new Error("safe_death_operation_id_conflict");
          }
          return {
            operationId,
            playerId,
            requestFingerprint,
            replayed: true,
            deathTimestamp,
            dropped: normalizeDeathCustodyItems(state.dropped),
            kept: normalizeDeathCustodyItems(state.kept),
          };
        }

        const activeDeath = await tx
          .select({ playerId: schema.playerDeaths.playerId })
          .from(schema.playerDeaths)
          .where(eq(schema.playerDeaths.playerId, playerId));
        if (activeDeath[0]) throw new Error("safe_death_active_lock_exists");

        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        const equipmentRows = await tx
          .select({
            itemId: schema.equipment.itemId,
            quantity: schema.equipment.quantity,
          })
          .from(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));
        const persistedInventory = normalizePersistedInventoryRows(
          inventoryRows,
          "safe_death",
        );
        const allItems = normalizeDeathCustodyItems([
          ...persistedInventory.map((item) => ({
            itemId: item.itemId,
            quantity: item.quantity,
          })),
          ...equipmentRows
            .filter((item) => Boolean(item.itemId))
            .map((item) => ({
              itemId: item.itemId!,
              quantity: item.quantity ?? 1,
            })),
        ]);
        const { dropped, kept } = splitSafeDeathCustody(allItems, 3);

        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        await tx
          .delete(schema.equipment)
          .where(eq(schema.equipment.playerId, playerId));

        const operationState: StoredSafeDeathCaptureOperation = {
          version: 1,
          requestFingerprint,
          deathTimestamp,
          position,
          killedBy,
          dropped,
          kept,
        };
        const now = Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "safe_death_capture",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });
        if (dropped.length > 0 || kept.length > 0) {
          await tx.insert(schema.playerDeaths).values({
            playerId,
            gravestoneId: null,
            groundItemIds: "[]",
            position: JSON.stringify(position),
            timestamp: deathTimestamp,
            zoneType: "safe_area",
            itemCount: dropped.length,
            items: dropped,
            keptItems: kept,
            deathOperationId: operationId,
            killedBy,
            recovered: false,
            createdAt: now,
            updatedAt: now,
          });
        }

        return {
          operationId,
          playerId,
          requestFingerprint,
          replayed: false,
          deathTimestamp,
          dropped,
          kept,
        };
      },
      {
        isolationLevel: "serializable",
        // Concurrent deaths/claims intentionally contend on one character.
        // Retry a PostgreSQL-aborted SSI snapshot as one whole transaction so
        // the loser observes the committed semantic receipt/death lock.
        maxConflictRetries: 4,
      },
    );
  }

  async commitSafeAreaDeathKeptReturnAsync(input: {
    playerId: string;
    deathOperationId: string;
  }): Promise<SafeDeathKeptReturnReceipt> {
    if (!this.db) throw new Error("safe_death_database_unavailable");
    const playerId = normalizeDeathPlayerId(input.playerId);
    const deathOperationId = normalizeDeathOperationId(input.deathOperationId);
    const operationId = deathKeptReturnOperationId(deathOperationId);

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const character = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!character[0]) throw new Error("safe_death_player_missing");

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredSafeDeathKeptReturnOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "safe_death_kept_return" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.deathOperationId !== deathOperationId
          ) {
            throw new Error("safe_death_operation_id_conflict");
          }
          const currentRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          return {
            operationId,
            playerId,
            deathOperationId,
            replayed: true,
            returned: normalizeDeathCustodyItems(state.returned),
            committed: normalizePersistedInventoryRows(
              currentRows,
              "safe_death",
            ),
          };
        }

        const deathRows = await tx
          .select({
            deathOperationId: schema.playerDeaths.deathOperationId,
            items: schema.playerDeaths.items,
            keptItems: schema.playerDeaths.keptItems,
          })
          .from(schema.playerDeaths)
          .where(eq(schema.playerDeaths.playerId, playerId));
        const death = deathRows[0];
        if (!death || death.deathOperationId !== deathOperationId) {
          throw new Error("safe_death_lock_mismatch");
        }
        const returned = normalizeDeathCustodyItems(death.keptItems);
        const remaining = normalizeDeathCustodyItems(death.items);
        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        let committed = normalizePersistedInventoryRows(
          inventoryRows,
          "safe_death",
        );
        for (const item of returned) {
          committed = creditDeathCustodyItem(committed, item);
        }
        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        if (committed.length > 0) {
          await tx.insert(schema.inventory).values(
            committed.map((item) => ({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slotIndex: item.slotIndex,
              metadata: item.metadata ? JSON.stringify(item.metadata) : null,
            })),
          );
        }
        if (remaining.length === 0) {
          await tx
            .delete(schema.playerDeaths)
            .where(eq(schema.playerDeaths.playerId, playerId));
        } else {
          await tx
            .update(schema.playerDeaths)
            .set({ keptItems: [], updatedAt: Date.now() })
            .where(eq(schema.playerDeaths.playerId, playerId));
        }
        const operationState: StoredSafeDeathKeptReturnOperation = {
          version: 1,
          deathOperationId,
          returned,
        };
        const now = Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "safe_death_kept_return",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });
        return {
          operationId,
          playerId,
          deathOperationId,
          replayed: false,
          returned,
          committed,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  async commitSafeAreaDeathGravestoneLootAsync(
    request: SafeDeathGravestoneLootCommitRequest,
  ): Promise<SafeDeathGravestoneLootCommitReceipt> {
    if (!this.db) throw new Error("safe_death_database_unavailable");
    const operationId = normalizeDeathOperationId(request.operationId);
    const playerId = normalizeDeathPlayerId(request.playerId);
    const deathOperationId = normalizeDeathOperationId(
      request.deathOperationId,
    );
    const gravestoneId = String(request.gravestoneId ?? "").trim();
    if (!gravestoneId || gravestoneId.length > 256) {
      throw new Error("safe_death_gravestone_id_invalid");
    }
    const requested = request.items
      ? normalizeDeathCustodyItems(request.items, "safe_death_gravestone")
      : null;
    if (requested && requested.length === 0) {
      throw new Error("safe_death_gravestone_items_invalid");
    }

    return this.executeInTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
        );
        const character = await tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.id, playerId));
        if (!character[0]) throw new Error("safe_death_player_missing");

        const existingRows = await tx
          .select({
            playerId: schema.operationsLog.playerId,
            operationType: schema.operationsLog.operationType,
            operationState: schema.operationsLog.operationState,
            completed: schema.operationsLog.completed,
          })
          .from(schema.operationsLog)
          .where(eq(schema.operationsLog.id, operationId));
        const existing = existingRows[0];
        if (existing) {
          const state = existing.operationState as
            StoredSafeDeathGravestoneLootOperation | undefined;
          if (
            existing.playerId !== playerId ||
            existing.operationType !== "safe_death_gravestone_loot" ||
            existing.completed !== true ||
            state?.version !== 1 ||
            state.deathOperationId !== deathOperationId ||
            state.gravestoneId !== gravestoneId ||
            JSON.stringify(state.requested) !== JSON.stringify(requested)
          ) {
            throw new Error("safe_death_operation_id_conflict");
          }
          const currentRows = await tx
            .select({
              itemId: schema.inventory.itemId,
              quantity: schema.inventory.quantity,
              slotIndex: schema.inventory.slotIndex,
              metadata: schema.inventory.metadata,
            })
            .from(schema.inventory)
            .where(eq(schema.inventory.playerId, playerId));
          return {
            operationId,
            playerId,
            deathOperationId,
            gravestoneId,
            replayed: true,
            transferred: normalizeDeathCustodyItems(state.transferred),
            remaining: normalizeDeathCustodyItems(state.remaining),
            committed: normalizePersistedInventoryRows(
              currentRows,
              "safe_death",
            ),
          };
        }

        const deathRows = await tx
          .select({
            deathOperationId: schema.playerDeaths.deathOperationId,
            gravestoneId: schema.playerDeaths.gravestoneId,
            items: schema.playerDeaths.items,
            keptItems: schema.playerDeaths.keptItems,
          })
          .from(schema.playerDeaths)
          .where(eq(schema.playerDeaths.playerId, playerId));
        const death = deathRows[0];
        if (
          !death ||
          death.deathOperationId !== deathOperationId ||
          death.gravestoneId !== gravestoneId
        ) {
          throw new Error("safe_death_lock_mismatch");
        }
        const persistedItems = normalizeDeathCustodyItems(death.items);
        const keptItems = normalizeDeathCustodyItems(death.keptItems);
        const availableByItem = new Map(
          persistedItems.map((item) => [item.itemId, item.quantity]),
        );
        const candidates = requested ?? persistedItems;
        for (const item of candidates) {
          if ((availableByItem.get(item.itemId) ?? 0) < item.quantity) {
            throw new Error("safe_death_gravestone_item_mismatch");
          }
        }
        const inventoryRows = await tx
          .select({
            itemId: schema.inventory.itemId,
            quantity: schema.inventory.quantity,
            slotIndex: schema.inventory.slotIndex,
            metadata: schema.inventory.metadata,
          })
          .from(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        let committed = normalizePersistedInventoryRows(
          inventoryRows,
          "safe_death",
        );
        const transferred: DeathCustodyItem[] = [];
        const remainingByItem = new Map(availableByItem);
        for (const item of candidates) {
          const definition = getItem(item.itemId);
          if (!definition) throw new Error("safe_death_item_unknown");
          if (definition.stackable === true) {
            try {
              committed = creditDeathCustodyItem(committed, item);
              transferred.push(item);
              remainingByItem.set(
                item.itemId,
                (remainingByItem.get(item.itemId) ?? 0) - item.quantity,
              );
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === "safe_death_inventory_full"
              ) {
                continue;
              }
              throw error;
            }
            continue;
          }
          const availableSlots = Math.max(
            0,
            MAX_INVENTORY_SLOTS - committed.length,
          );
          const quantity = Math.min(item.quantity, availableSlots);
          if (quantity > 0) {
            committed = creditDeathCustodyItem(committed, {
              itemId: item.itemId,
              quantity,
            });
            transferred.push({ itemId: item.itemId, quantity });
            remainingByItem.set(
              item.itemId,
              (remainingByItem.get(item.itemId) ?? 0) - quantity,
            );
          }
        }
        if (transferred.length === 0) {
          throw new Error("safe_death_inventory_full");
        }
        const normalizedTransferred = normalizeDeathCustodyItems(transferred);
        const normalizedRemaining = normalizeDeathCustodyItems(
          [...remainingByItem.entries()]
            .filter(([, quantity]) => quantity > 0)
            .map(([itemId, quantity]) => ({ itemId, quantity })),
        );
        await tx
          .delete(schema.inventory)
          .where(eq(schema.inventory.playerId, playerId));
        await tx.insert(schema.inventory).values(
          committed.map((item) => ({
            playerId,
            itemId: item.itemId,
            quantity: item.quantity,
            slotIndex: item.slotIndex,
            metadata: item.metadata ? JSON.stringify(item.metadata) : null,
          })),
        );
        if (normalizedRemaining.length === 0 && keptItems.length === 0) {
          await tx
            .delete(schema.playerDeaths)
            .where(eq(schema.playerDeaths.playerId, playerId));
        } else {
          await tx
            .update(schema.playerDeaths)
            .set({
              items: normalizedRemaining,
              itemCount: normalizedRemaining.length,
              updatedAt: Date.now(),
            })
            .where(eq(schema.playerDeaths.playerId, playerId));
        }
        const operationState: StoredSafeDeathGravestoneLootOperation = {
          version: 1,
          deathOperationId,
          gravestoneId,
          requested,
          transferred: normalizedTransferred,
          remaining: normalizedRemaining,
        };
        const now = Date.now();
        await tx.insert(schema.operationsLog).values({
          id: operationId,
          playerId,
          operationType: "safe_death_gravestone_loot",
          operationState,
          completed: true,
          timestamp: now,
          completedAt: now,
        });
        return {
          operationId,
          playerId,
          deathOperationId,
          gravestoneId,
          replayed: false,
          transferred: normalizedTransferred,
          remaining: normalizedRemaining,
          committed,
        };
      },
      { isolationLevel: "serializable", maxConflictRetries: 4 },
    );
  }

  async saveDeathLockAsync(
    data: DeathLockData,
    tx?: NodePgDatabase<typeof schema>,
  ): Promise<void> {
    if (!this.deathRepository) {
      console.error("[DatabaseSystem] deathRepository not initialized");
      return;
    }
    return this.deathRepository.saveDeathLockAsync(data, tx);
  }

  /**
   * Get active death lock for a player
   * Delegates to DeathRepository
   *
   * Returns null if no active death lock exists (player is alive).
   * Now includes items, killedBy, recovered fields.
   */
  async getDeathLockAsync(playerId: string): Promise<DeathLockData | null> {
    if (!this.deathRepository) {
      console.error("[DatabaseSystem] deathRepository not initialized");
      return null;
    }
    return this.deathRepository.getDeathLockAsync(playerId);
  }

  /**
   * Delete a death lock for a player
   * Delegates to DeathRepository
   *
   * Called when player respawns or death is fully resolved.
   */
  async deleteDeathLockAsync(playerId: string): Promise<void> {
    if (!this.deathRepository) {
      console.error("[DatabaseSystem] deathRepository not initialized");
      return;
    }
    return this.deathRepository.deleteDeathLockAsync(playerId);
  }

  /**
   * Get all active death locks
   * Delegates to DeathRepository
   *
   * Used for server restart recovery to restore gravestones/ground items.
   * Now includes items, killedBy, recovered fields.
   */
  async getAllActiveDeathsAsync(): Promise<DeathLockData[]> {
    if (!this.deathRepository) {
      console.error("[DatabaseSystem] deathRepository not initialized");
      return [];
    }
    return this.deathRepository.getAllActiveDeathsAsync();
  }

  /**
   * Update ground item IDs when gravestone expires
   * Delegates to DeathRepository
   *
   * Called when gravestone transitions to ground items.
   */
  async updateGroundItemsAsync(
    playerId: string,
    groundItemIds: string[],
  ): Promise<void> {
    if (!this.deathRepository) {
      console.error("[DatabaseSystem] deathRepository not initialized");
      return;
    }
    return this.deathRepository.updateGroundItemsAsync(playerId, groundItemIds);
  }

  /**
   * Get all unrecovered deaths for crash recovery
   * Delegates to DeathRepository
   *
   * Called during server startup to find deaths that need their
   * gravestones/ground items recreated.
   *
   * @returns Array of death locks that need recovery
   */
  async getUnrecoveredDeathsAsync(): Promise<DeathLockData[]> {
    if (!this.deathRepository) {
      console.error(
        "[DatabaseSystem] deathRepository not initialized - ensure DatabaseSystem.init() was called",
      );
      return [];
    }
    return this.deathRepository.getUnrecoveredDeathsAsync();
  }

  /**
   * Mark a death as recovered after crash recovery processing
   * Delegates to DeathRepository
   *
   * Called after successfully recreating gravestones/ground items.
   *
   * @param playerId - The player ID whose death was recovered
   */
  async markDeathRecoveredAsync(playerId: string): Promise<void> {
    if (!this.deathRepository) {
      console.error("[DatabaseSystem] deathRepository not initialized");
      return;
    }
    return this.deathRepository.markDeathRecoveredAsync(playerId);
  }

  /**
   * Atomically acquire a death lock (check-and-create)
   * Delegates to DeathRepository
   *
   * Prevents race conditions where a player could die multiple times.
   * Uses INSERT ... ON CONFLICT DO NOTHING for atomic semantics.
   *
   * @param data - Death lock data to create
   * @param tx - Optional transaction context
   * @returns true if death lock was created, false if player already has one
   */
  async acquireDeathLockAsync(
    data: DeathLockData,
    tx?: NodePgDatabase<typeof schema>,
  ): Promise<boolean> {
    if (!this.deathRepository) {
      console.error("[DatabaseSystem] deathRepository not initialized");
      return false;
    }
    return this.deathRepository.acquireDeathLockAsync(data, tx);
  }

  // ============================================================================
  // SYNCHRONOUS WRAPPER METHODS (LEGACY)
  // ============================================================================
  // These methods provide synchronous interfaces for backward compatibility.
  // They fire-and-forget async operations and track them for graceful shutdown.
  //
  // WARNING: These will eventually be removed. Use async methods instead.
  // The sync methods log warnings and don't return results from the database.

  /**
   * @deprecated Use getCharactersAsync instead
   * @returns Empty array (use async method to get real data)
   */
  getCharacters(_accountId: string): Array<{ id: string; name: string }> {
    console.warn(
      "[DatabaseSystem] getCharacters called synchronously - use getCharactersAsync instead",
    );
    return [];
  }

  /**
   * @deprecated Use getPlayerAsync instead
   * @returns null (use async method to get real data)
   */
  getPlayer(_playerId: string): PlayerRow | null {
    console.warn(
      "[DatabaseSystem] getPlayer called synchronously - use getPlayerAsync instead",
    );
    return null;
  }

  /**
   * Save player data (debounced fire-and-forget)
   *
   * Buffers field updates per player and flushes after a short delay.
   * Rapid calls (e.g., multiple XP drops in the same tick) merge into
   * a single DB write per player instead of N separate UPDATEs.
   */
  savePlayer(playerId: string, data: PlayerPersistenceUpdate): void {
    if (this.isDestroying) return;
    assertGenericPlayerUpdateExcludesPrayerAuthority(
      data,
      "DatabaseSystem.savePlayer",
    );
    assertGenericPlayerUpdateExcludesAttackStyleAuthority(
      data,
      "DatabaseSystem.savePlayer",
    );
    const existing = this.pendingSaveBuffer.get(playerId);
    if (existing) {
      Object.assign(existing, data);
    } else {
      this.pendingSaveBuffer.set(playerId, { ...data });
    }
    const revision = ++this.playerSaveRevision;
    let fieldRevisions = this.pendingSaveFieldRevisions.get(playerId);
    if (!fieldRevisions) {
      fieldRevisions = new Map();
      this.pendingSaveFieldRevisions.set(playerId, fieldRevisions);
    }
    for (const field of Object.keys(data) as Array<
      keyof PlayerPersistenceUpdate
    >) {
      fieldRevisions.set(field, revision);
    }

    this.scheduleSaveBufferFlush(0);
  }

  private scheduleSaveBufferFlush(delayMs: number): void {
    if (
      this.isDestroying ||
      this.saveFlushScheduled ||
      this.pendingSaveBuffer.size === 0
    ) {
      return;
    }
    this.saveFlushScheduled = true;
    this.saveFlushTimer = setTimeout(() => {
      this.saveFlushTimer = undefined;
      this.flushSaveBuffer();
    }, delayMs);
  }

  /**
   * Flush the debounce buffer — one batched DB transaction for all players.
   */
  private flushSaveBuffer(): void {
    if (this.saveFlushTimer) {
      clearTimeout(this.saveFlushTimer);
      this.saveFlushTimer = undefined;
    }
    this.saveFlushScheduled = false;
    if (this.isDestroying) return;
    if (
      this.pendingSaveBuffer.size === 0 ||
      this.playerSaveFlushInFlight ||
      this.directPlayerSaveInFlight > 0
    ) {
      return;
    }

    const buffer = new Map(
      Array.from(this.pendingSaveBuffer, ([playerId, update]) => [
        playerId,
        { ...update },
      ]),
    );
    const fieldRevisions = new Map(
      Array.from(buffer.keys(), (playerId) => [
        playerId,
        new Map(this.pendingSaveFieldRevisions.get(playerId) ?? []),
      ]),
    );
    this.playerSaveFlushInFlight = true;
    let retryDelayMs = 0;

    // Retain the buffer until the transaction acknowledges it. A failed
    // database write therefore remains recoverable, while per-field revisions
    // prevent an older retry from overwriting data accepted after it started.
    const operation = this.enqueuePlayerSave(() =>
      this.playerRepository.batchSavePlayersAsync(buffer),
    )
      .then(() => {
        for (const [playerId, snapshotRevisions] of fieldRevisions) {
          const current = this.pendingSaveBuffer.get(playerId);
          const currentRevisions = this.pendingSaveFieldRevisions.get(playerId);
          if (!current || !currentRevisions) continue;
          for (const [field, snapshotRevision] of snapshotRevisions) {
            if (currentRevisions.get(field) !== snapshotRevision) continue;
            delete current[field];
            currentRevisions.delete(field);
          }
          if (Object.keys(current).length === 0) {
            this.pendingSaveBuffer.delete(playerId);
            this.pendingSaveFieldRevisions.delete(playerId);
          }
        }
      })
      .catch(() => {
        retryDelayMs = this.PLAYER_SAVE_RETRY_MS;
        const now = Date.now();
        if (now - this.lastPlayerSaveRetryLogTime >= 5_000) {
          console.error(
            "[DatabaseSystem] Generic player save failed; retaining the latest coalesced snapshot for bounded retry",
          );
          this.lastPlayerSaveRetryLogTime = now;
        }
      })
      .finally(() => {
        this.playerSaveFlushInFlight = false;
        this.scheduleSaveBufferFlush(retryDelayMs);
      });
    this.trackAsyncOperation(operation);
  }

  private enqueuePlayerSave<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.playerSaveWriteTail.then(operation, operation);
    // Keep the queue usable after a failed caller-visible write while leaving
    // the original promise rejected for the caller/tracker to observe.
    this.playerSaveWriteTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /**
   * Batch save multiple players in a single transaction
   * Delegates to PlayerRepository.batchSavePlayersAsync
   */
  async batchSavePlayersAsync(
    players: Map<string, PlayerPersistenceUpdate>,
  ): Promise<void> {
    return this.enqueuePlayerSave(() =>
      this.playerRepository.batchSavePlayersAsync(players),
    );
  }

  /**
   * @deprecated Use getPlayerInventoryAsync instead
   * @returns Empty array (use async method to get real data)
   */
  getPlayerInventory(_playerId: string): InventoryRow[] {
    console.warn(
      "[DatabaseSystem] getPlayerInventory called synchronously - use getPlayerInventoryAsync instead",
    );
    return [];
  }

  /**
   * Save player inventory (debounced fire-and-forget)
   *
   * Keeps only the latest inventory snapshot per player. Rapid saves
   * (mine ore → smelt → smith) merge into one DB write, preventing
   * concurrent UPSERTs that deadlock on the same rows.
   */
  savePlayerInventory(playerId: string, items: InventorySaveItem[]): void {
    this.pendingInventoryBuffer.set(playerId, items);

    if (!this.inventoryFlushScheduled) {
      this.inventoryFlushScheduled = true;
      setTimeout(() => this.flushInventoryBuffer(), 0);
    }
  }

  /**
   * Flush the inventory debounce buffer — one DB write per player.
   */
  private flushInventoryBuffer(): void {
    this.inventoryFlushScheduled = false;
    const buffer = this.pendingInventoryBuffer;
    this.pendingInventoryBuffer = new Map();

    for (const [playerId, items] of buffer) {
      this.trackAsyncOperation(this.savePlayerInventoryAsync(playerId, items));
    }
  }

  /**
   * Create player session (fire-and-forget)
   * Returns a session ID synchronously, tracks the operation for graceful shutdown
   */
  createPlayerSession(
    sessionData: Omit<PlayerSessionRow, "id" | "sessionId">,
  ): string {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.trackAsyncOperation(
      this.createPlayerSessionAsync(sessionData, sessionId),
    );
    return sessionId;
  }

  /**
   * Update player session (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  updatePlayerSession(
    sessionId: string,
    updates: Partial<PlayerSessionRow>,
  ): void {
    this.trackAsyncOperation(this.updatePlayerSessionAsync(sessionId, updates));
  }

  /**
   * @deprecated Use getActivePlayerSessionsAsync instead
   * @returns Empty array (use async method to get real data)
   */
  getActivePlayerSessions(): PlayerSessionRow[] {
    console.warn(
      "[DatabaseSystem] getActivePlayerSessions called synchronously - use getActivePlayerSessionsAsync instead",
    );
    return [];
  }

  /**
   * End player session (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  endPlayerSession(sessionId: string, reason?: string): void {
    this.trackAsyncOperation(this.endPlayerSessionAsync(sessionId, reason));
  }

  /**
   * Save world chunk (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  saveWorldChunk(chunkData: {
    chunkX: number;
    chunkZ: number;
    data: string;
  }): void {
    if (IS_PLAYWRIGHT_TEST) return;
    this.trackAsyncOperation(this.saveWorldChunkAsync(chunkData));
  }

  /**
   * @deprecated Use getWorldItemsAsync instead
   * @returns Empty array (use async method to get real data)
   */
  getWorldItems(_chunkX: number, _chunkZ: number): ItemRow[] {
    console.warn(
      "[DatabaseSystem] getWorldItems called synchronously - use getWorldItemsAsync instead",
    );
    return [];
  }

  /**
   * Save world items (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  saveWorldItems(chunkX: number, chunkZ: number, items: ItemRow[]): void {
    if (IS_PLAYWRIGHT_TEST) return;
    this.trackAsyncOperation(this.saveWorldItemsAsync(chunkX, chunkZ, items));
  }

  /**
   * @deprecated Use getInactiveChunksAsync instead
   * @returns Empty array (use async method to get real data)
   */
  getInactiveChunks(_minutes: number): WorldChunkRow[] {
    return [];
  }

  /**
   * Update chunk player count (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  updateChunkPlayerCount(
    chunkX: number,
    chunkZ: number,
    playerCount: number,
  ): void {
    if (IS_PLAYWRIGHT_TEST) return;
    this.trackAsyncOperation(
      this.updateChunkPlayerCountAsync(chunkX, chunkZ, playerCount),
    );
  }

  /**
   * Mark chunk for reset (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  markChunkForReset(chunkX: number, chunkZ: number): void {
    if (IS_PLAYWRIGHT_TEST) return;
    this.trackAsyncOperation(this.markChunkForResetAsync(chunkX, chunkZ));
  }

  /**
   * Reset chunk (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  resetChunk(chunkX: number, chunkZ: number): void {
    if (IS_PLAYWRIGHT_TEST) return;
    this.trackAsyncOperation(this.resetChunkAsync(chunkX, chunkZ));
  }

  /**
   * @deprecated Use getWorldChunkAsync instead
   * @returns null (use async method to get real data)
   */
  getWorldChunk(_x: number, _z: number): WorldChunkRow | null {
    console.warn(
      "[DatabaseSystem] getWorldChunk called synchronously - use getWorldChunkAsync instead",
    );
    return null;
  }

  /**
   * Increment NPC kill (fire-and-forget)
   * Tracks the operation for graceful shutdown
   */
  incrementNPCKill(playerId: string, npcId: string): void {
    this.trackAsyncOperation(this.incrementNPCKillAsync(playerId, npcId));
  }

  // ============================================================================
  // MAINTENANCE METHODS
  // ============================================================================

  /**
   * Clean up old sessions asynchronously
   *
   * Deletes sessions older than the specified number of days.
   * Used for maintenance to keep the database clean.
   *
   * @param daysOld - Delete sessions older than this many days
   * @returns Number of sessions deleted
   */
  async cleanupOldSessionsAsync(daysOld: number): Promise<number> {
    return this.sessionRepository.cleanupOldSessionsAsync(daysOld);
  }

  /**
   * Clean up old sessions (synchronous wrapper)
   *
   * @param daysOld - Delete sessions older than this many days
   * @returns 0 (actual count available via async method)
   */
  cleanupOldSessions(daysOld: number): number {
    this.trackAsyncOperation(this.cleanupOldSessionsAsync(daysOld));
    return 0; // Sync version can't return actual count
  }

  /**
   * Clean up old chunk activity records asynchronously
   *
   * Deletes chunk activity records older than the specified number of days.
   * Used for maintenance to keep the database clean.
   *
   * @param daysOld - Delete records older than this many days
   * @returns Number of records deleted
   */
  async cleanupOldChunkActivityAsync(daysOld: number): Promise<number> {
    return this.worldChunkRepository.cleanupOldChunkActivityAsync(daysOld);
  }

  /**
   * Clean up old chunk activity records (synchronous wrapper)
   *
   * @param daysOld - Delete records older than this many days
   * @returns 0 (actual count available via async method)
   */
  cleanupOldChunkActivity(daysOld: number): number {
    this.trackAsyncOperation(this.cleanupOldChunkActivityAsync(daysOld));
    return 0; // Sync version can't return actual count
  }

  /**
   * Get database statistics asynchronously
   *
   * Returns counts of various database entities for monitoring.
   *
   * @returns Database statistics
   */
  async getDatabaseStatsAsync(): Promise<{
    playerCount: number;
    activeSessionCount: number;
    chunkCount: number;
    activeChunkCount: number;
    totalActivityRecords: number;
  }> {
    try {
      const [
        playerCount,
        activeSessionCount,
        chunkCount,
        activeChunkCount,
        totalActivityRecords,
      ] = await Promise.all([
        this.playerRepository.getPlayerCountAsync(),
        this.sessionRepository.getActiveSessionCountAsync(),
        this.worldChunkRepository.getChunkCountAsync(),
        this.worldChunkRepository.getActiveChunkCountAsync(),
        this.worldChunkRepository.getTotalActivityRecordsAsync(),
      ]);

      return {
        playerCount,
        activeSessionCount,
        chunkCount,
        activeChunkCount,
        totalActivityRecords,
      };
    } catch (err) {
      this.logger.error(
        "Failed to fetch database stats",
        err instanceof Error ? err : new Error(String(err)),
      );
      throw err;
    }
  }

  /**
   * Get database statistics (synchronous wrapper)
   *
   * @returns Default statistics (use async method for real data)
   */
  getDatabaseStats(): {
    playerCount: number;
    activeSessionCount: number;
    chunkCount: number;
    activeChunkCount: number;
    totalActivityRecords: number;
  } {
    // Sync version can't return actual data, return defaults
    return {
      playerCount: 0,
      activeSessionCount: 0,
      chunkCount: 0,
      activeChunkCount: 0,
      totalActivityRecords: 0,
    };
  }

  /**
   * Return privacy-safe aggregate custody for projectile costs that have not
   * reached a durable terminal impact/cancellation receipt.
   */
  async getProjectileCostCustodyStatsAsync(): Promise<ProjectileCostCustodyStats> {
    if (!this.pool || this.isDestroying) {
      throw new Error("projectile_cost_custody_database_unavailable");
    }
    const result = await this.pool.query<{
      pendingAmmunitionShots: number | string;
      firedAmmunitionShots: number | string;
      pendingRuneCosts: number | string;
      firedRuneCosts: number | string;
      invalidOperations: number | string;
      futureTimestampOperations: number | string;
      oldestUnresolvedAgeMs: number | string;
    }>(
      `WITH clock AS (
         SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS database_now
       ), unresolved AS (
         SELECT
           "operationType" AS operation_type,
           completed,
           "operationState"->>'version' AS version,
           "operationState"->>'status' AS status,
           timestamp
         FROM operations_log
         WHERE "operationType" IN ('ammunition_shot', 'projectile_rune_cost')
           AND (
             completed = false
             OR "operationState"->>'status' IN ('pending', 'fired')
           )
       )
       SELECT
         count(*) FILTER (
           WHERE unresolved.operation_type = 'ammunition_shot'
             AND unresolved.version = '2'
             AND unresolved.completed = false
             AND unresolved.status = 'pending'
         )::int AS "pendingAmmunitionShots",
         count(*) FILTER (
           WHERE unresolved.operation_type = 'ammunition_shot'
             AND unresolved.version = '2'
             AND unresolved.completed = true
             AND unresolved.status = 'fired'
         )::int AS "firedAmmunitionShots",
         count(*) FILTER (
           WHERE unresolved.operation_type = 'projectile_rune_cost'
             AND unresolved.version = '1'
             AND unresolved.completed = false
             AND unresolved.status = 'pending'
         )::int AS "pendingRuneCosts",
         count(*) FILTER (
           WHERE unresolved.operation_type = 'projectile_rune_cost'
             AND unresolved.version = '1'
             AND unresolved.completed = true
             AND unresolved.status = 'fired'
         )::int AS "firedRuneCosts",
         count(*) FILTER (
           WHERE unresolved.operation_type IS NOT NULL
             AND NOT (
               (
                 unresolved.operation_type = 'ammunition_shot'
                 AND unresolved.version = '2'
                 AND (
                   (unresolved.completed = false AND unresolved.status = 'pending')
                   OR (unresolved.completed = true AND unresolved.status = 'fired')
                 )
               )
               OR (
                 unresolved.operation_type = 'projectile_rune_cost'
                 AND unresolved.version = '1'
                 AND (
                   (unresolved.completed = false AND unresolved.status = 'pending')
                   OR (unresolved.completed = true AND unresolved.status = 'fired')
                 )
               )
             )
         )::int AS "invalidOperations",
         count(*) FILTER (
           WHERE unresolved.timestamp >
             clock.database_now + $1::bigint
         )::int AS "futureTimestampOperations",
         COALESCE(
           GREATEST(0, clock.database_now - min(unresolved.timestamp)),
           0
         )::bigint AS "oldestUnresolvedAgeMs"
       FROM clock
       LEFT JOIN unresolved ON true
       GROUP BY clock.database_now`,
      [TICK_DURATION_MS],
    );
    const row = result.rows[0];
    const stats: ProjectileCostCustodyStats = {
      pendingAmmunitionShots: Number(row?.pendingAmmunitionShots),
      firedAmmunitionShots: Number(row?.firedAmmunitionShots),
      pendingRuneCosts: Number(row?.pendingRuneCosts),
      firedRuneCosts: Number(row?.firedRuneCosts),
      invalidOperations: Number(row?.invalidOperations),
      futureTimestampOperations: Number(row?.futureTimestampOperations),
      oldestUnresolvedAgeMs: Number(row?.oldestUnresolvedAgeMs),
    };
    if (
      !Object.values(stats).every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      throw new Error("projectile_cost_custody_stats_invalid");
    }
    return stats;
  }

  /**
   * Check database connection health
   *
   * Performs a lightweight health check by executing a simple query.
   * Returns connection status information useful for monitoring.
   *
   * @returns Health check result with status and pool info
   */
  async checkHealthAsync(): Promise<{
    healthy: boolean;
    latencyMs: number;
    poolInfo?: {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
    };
    error?: string;
  }> {
    if (!this.db || !this.pool) {
      return {
        healthy: false,
        latencyMs: 0,
        error: "Database not initialized",
      };
    }

    const startTime = performance.now();

    try {
      // Simple query to verify connection (SELECT 1)
      await this.pool.query("SELECT 1");

      const latencyMs = Math.round(performance.now() - startTime);

      return {
        healthy: true,
        latencyMs,
        poolInfo: {
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount,
        },
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      console.error("[DatabaseSystem] Health check failed:", errorMessage);

      return {
        healthy: false,
        latencyMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Get the PostgreSQL connection pool
   *
   * Provides access to the underlying pool for monitoring or direct operations.
   *
   * @returns The pg.Pool instance or null if not initialized
   */
  getPool(): pg.Pool | null {
    return this.pool;
  }

  /**
   * Clean up database system resources
   *
   * Nullifies references to database instances but does NOT close the connection pool.
   * The pool is managed externally by the server and closed during graceful shutdown.
   * Called automatically when the world is destroyed.
   */
  destroy(): void {
    if (this.saveFlushTimer) {
      clearTimeout(this.saveFlushTimer);
      this.saveFlushTimer = undefined;
    }
    this.saveFlushScheduled = false;
    this.pendingSaveBuffer.clear();
    this.pendingSaveFieldRevisions.clear();
    this.inventoryWriteActive.clear();
    // Reject any orphaned waiters so their promises don't hang forever
    for (const [, queued] of this.inventoryWriteQueued) {
      for (const w of queued.waiters) {
        w.reject(new Error("DatabaseSystem destroyed"));
      }
    }
    this.inventoryWriteQueued.clear();
    // Pool is managed externally in index.ts, don't close it here
    this.db = null;
    this.pool = null;
  }
}
