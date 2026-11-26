/**
 * InventorySystem - Manages player inventories
 */

import { getSystem } from "../../../utils/SystemUtils";
import type { World } from "../../../types";
import type { InventoryItemAddedPayload } from "../../../types/events";
import { EventType } from "../../../types/events";
import { getItem } from "../../../data/items";
import type { PlayerInventory } from "../../../types/core/core";
import type {
  InventoryCanAddEvent,
  InventoryCheckEvent,
  InventoryItemInfo,
  InventorySyncData,
} from "../../../types/events";
import { PlayerID } from "../../../types/core/identifiers";
import type { InventoryData } from "../../../types/systems/system-interfaces";
import {
  createItemID,
  createPlayerID,
  isValidItemID,
  isValidPlayerID,
  toPlayerID,
} from "../../../utils/IdentifierUtils";
import { EntityManager } from "..";
import { SystemBase } from "../infrastructure/SystemBase";
import { Logger } from "../../../utils/Logger";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import type {
  BoneBurialCommitRequest,
  QuestStartCommitReceipt,
  QuestStartCommitRequest,
  QuestCompletionCommitReceipt,
  QuestCompletionCommitRequest,
  QuestCompletionProgressReceipt,
  QuestCompletionRewardItem,
  QuestCompletionRewardXp,
  QuestRewardSkill,
  FoodConsumptionCommitReceipt,
  FoodConsumptionCommitRequest,
  GroundItemDropCommitReceipt,
  GroundItemDropCommitRequest,
  GroundItemPickupCommitReceipt,
  GroundItemPickupCommitRequest,
  GatheringRewardCommitRequest,
  GatheringRewardItem,
  GatheringRewardSkill,
  InventoryDebitRequirement,
  InventorySaveItem,
  ProcessingActionCommitRequest,
  ProcessingActionConsumable,
  ProcessingActionConsumableState,
  ProcessingActionFireEffect,
  ProcessingActionFireEffectRequest,
  ProcessingActionItem,
  ProcessingActionSkill,
  ProjectileRuneCostOperationStatus,
  ProjectileRuneCostSettlementHandle,
} from "../../../types/network/database";
import { PROCESSING_CONSTANTS } from "../../../constants/ProcessingConstants";
import { TICK_DURATION_MS, worldToTile } from "../movement/TileSystem";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import type { CoinPouchSystem } from "./CoinPouchSystem";
import { DeathState } from "../../../types/entities";
import {
  parseStreamingDuelFoodObservationContext,
  type StreamingDuelFoodObservationContext,
} from "../../../types/game/streaming-duel-action-observation";
import { generateGroundItemDropOperationId } from "../../../utils/game/GroundItemSourceIdentity";
import { serializeGroundItemDropCommitFingerprint } from "../../../utils/game/GroundItemDropRegistration";

export type AtomicInventoryDebitFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "insufficient_items"
  | "persistence_failed"
  | "committed_state_apply_failed";

export type AtomicInventoryDebitReceipt =
  | {
      ok: true;
      playerId: string;
      operationId: string;
      changed: true;
      replayed: boolean;
      requirements: InventoryDebitRequirement[];
    }
  | {
      ok: false;
      playerId: string;
      operationId: string;
      changed: false;
      replayed: false;
      requirements: InventoryDebitRequirement[];
      reason: AtomicInventoryDebitFailureReason;
    };

export type AtomicProjectileRuneCostReceipt =
  | {
      ok: true;
      playerId: string;
      operationId: string;
      changed: true;
      replayed: boolean;
      requestFingerprint: string;
      requirements: InventoryDebitRequirement[];
      status: ProjectileRuneCostOperationStatus;
    }
  | {
      ok: false;
      playerId: string;
      operationId: string;
      changed: false;
      replayed: false;
      requirements: InventoryDebitRequirement[];
      reason: AtomicInventoryDebitFailureReason;
    };

export type AtomicGroundItemDropFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "player_unavailable"
  | "duel_locked"
  | "death_locked"
  | "atomic_persistence_unavailable"
  | "source_unavailable"
  | "insufficient_items"
  | "persistence_ambiguous"
  | "committed_state_apply_failed";

export type AtomicGroundItemDropReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      liveCoinsApplied: boolean;
      presentationReady: boolean;
      receipt: GroundItemDropCommitReceipt;
    }
  | {
      ok: false;
      committed: false | "unknown";
      liveInventoryApplied: false;
      liveCoinsApplied: false;
      presentationReady: false;
      playerId: string;
      operationId: string;
      itemId: string;
      quantity: number;
      reason: AtomicGroundItemDropFailureReason;
    };

export type AtomicGroundItemPickupFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "source_unavailable"
  | "inventory_full"
  | "persistence_ambiguous";

export type AtomicGroundItemPickupReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      liveCoinsApplied: boolean;
      receipt: GroundItemPickupCommitReceipt;
    }
  | {
      ok: false;
      committed: false;
      liveInventoryApplied: false;
      liveCoinsApplied: false;
      playerId: string;
      operationId: string;
      sourceEntityId: string;
      itemId: string;
      quantity: number;
      reason: AtomicGroundItemPickupFailureReason;
    };

export type AtomicFoodConsumptionFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "insufficient_items"
  | "full_health"
  | "player_not_alive"
  | "persistence_failed";

export type AtomicFoodConsumptionReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      receipt: FoodConsumptionCommitReceipt;
    }
  | {
      ok: false;
      committed: false;
      liveInventoryApplied: false;
      playerId: string;
      operationId: string;
      itemId: string;
      healAmount: number;
      reason: AtomicFoodConsumptionFailureReason;
    };

export type AtomicGatheringRewardFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "resource_unavailable"
  | "inventory_full"
  | "secondary_missing"
  | "persistence_ambiguous";

export type AtomicGatheringRewardReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      playerId: string;
      operationId: string;
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
    }
  | {
      ok: false;
      committed: false;
      liveInventoryApplied: false;
      playerId: string;
      operationId: string;
      replayed: false;
      skill: GatheringRewardSkill | null;
      xpAmount: number;
      reward: GatheringRewardItem | null;
      secondaryItemId: string | null;
      retryable: boolean;
      reason: AtomicGatheringRewardFailureReason;
    };

export type AtomicBoneBurialFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "item_missing"
  | "level_required"
  | "xp_cap"
  | "persistence_ambiguous";

export type AtomicBoneBurialReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      playerId: string;
      operationId: string;
      replayed: boolean;
      itemId: string;
      xpAmount: number;
      levelRequired: number;
      awardedXp: number;
      operationCommittedXp: number;
      currentXp: number;
      currentLevel: number;
    }
  | {
      ok: false;
      committed: false;
      liveInventoryApplied: false;
      playerId: string;
      operationId: string;
      replayed: false;
      itemId: string;
      xpAmount: number;
      levelRequired: number;
      retryable: boolean;
      reason: AtomicBoneBurialFailureReason;
    };

export type AtomicQuestCompletionFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "inventory_full"
  | "quest_state_conflict"
  | "persistence_ambiguous";

export type AtomicQuestCompletionReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      receipt: QuestCompletionCommitReceipt;
    }
  | {
      ok: false;
      committed: false | "unknown";
      liveInventoryApplied: false;
      playerId: string;
      operationId: string;
      questId: string;
      retryable: boolean;
      reason: AtomicQuestCompletionFailureReason;
    };

export type AtomicQuestStartFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "inventory_full"
  | "quest_state_conflict"
  | "persistence_ambiguous";

export type AtomicQuestStartReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      receipt: QuestStartCommitReceipt;
    }
  | {
      ok: false;
      committed: false | "unknown";
      liveInventoryApplied: false;
      playerId: string;
      operationId: string;
      questId: string;
      retryable: boolean;
      reason: AtomicQuestStartFailureReason;
    };

export type AtomicProcessingActionFailureReason =
  | "invalid_request"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "insufficient_items"
  | "insufficient_coins"
  | "inventory_full"
  | "fire_tile_occupied"
  | "fire_capacity_reached"
  | "persistence_ambiguous";

export type AtomicProcessingActionReceipt =
  | {
      ok: true;
      committed: true;
      liveInventoryApplied: boolean;
      playerId: string;
      operationId: string;
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
    }
  | {
      ok: false;
      committed: false;
      liveInventoryApplied: false;
      playerId: string;
      operationId: string;
      replayed: false;
      skill: ProcessingActionSkill | null;
      xpAmount: number;
      inputs: InventoryDebitRequirement[];
      requiredItems: InventoryDebitRequirement[];
      consumables: ProcessingActionConsumable[];
      consumableStates: ProcessingActionConsumableState[];
      outputs: ProcessingActionItem[];
      coinCost?: number;
      worldEffect?: ProcessingActionFireEffectRequest;
      retryable: boolean;
      reason: AtomicProcessingActionFailureReason;
    };

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
const BONE_BURIAL_OPERATION_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|bone-burial:[A-Za-z0-9_-]{20})$/;
const MAX_SKILL_XP = 200_000_000;

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("web_crypto_unavailable");
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeDebitRequirements(
  value: InventoryDebitRequirement[],
  maxQuantity: number,
): InventoryDebitRequirement[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 28) {
    return null;
  }
  const totals = new Map<string, number>();
  for (const raw of value) {
    const itemId = String(raw?.itemId ?? "").trim();
    const quantity = Number(raw?.quantity);
    if (
      !isValidItemID(itemId) ||
      itemId.length > 256 ||
      !getItem(itemId) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > maxQuantity
    ) {
      return null;
    }
    const combined = (totals.get(itemId) ?? 0) + quantity;
    if (!Number.isSafeInteger(combined) || combined > maxQuantity) return null;
    totals.set(itemId, combined);
  }
  return [...totals.entries()]
    .map(([itemId, quantity]) => ({ itemId, quantity }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function normalizeOptionalDebitRequirements(
  value: InventoryDebitRequirement[],
  maxQuantity: number,
): InventoryDebitRequirement[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  return normalizeDebitRequirements(value, maxQuantity);
}

function normalizeProcessingConsumables(
  value: ProcessingActionConsumable[],
): ProcessingActionConsumable[] | null {
  if (!Array.isArray(value) || value.length > 28) return null;
  const itemIds = new Set<string>();
  const normalized: ProcessingActionConsumable[] = [];
  for (const raw of value) {
    const itemId = String(raw?.itemId ?? "").trim();
    const usesPerItem = Number(raw?.usesPerItem);
    if (
      !isValidItemID(itemId) ||
      itemId.length > 256 ||
      !getItem(itemId) ||
      itemIds.has(itemId) ||
      !Number.isSafeInteger(usesPerItem) ||
      usesPerItem <= 0 ||
      usesPerItem > 1_000_000
    ) {
      return null;
    }
    itemIds.add(itemId);
    normalized.push({ itemId, usesPerItem });
  }
  normalized.sort((left, right) => left.itemId.localeCompare(right.itemId));
  return normalized;
}

function normalizeProcessingConsumableStates(
  value: ProcessingActionConsumableState[],
  expected: ProcessingActionConsumable[],
): ProcessingActionConsumableState[] | null {
  if (!Array.isArray(value) || value.length !== expected.length) return null;
  const normalizedConsumables = normalizeProcessingConsumables(value);
  if (
    !normalizedConsumables ||
    JSON.stringify(normalizedConsumables) !== JSON.stringify(expected)
  ) {
    return null;
  }
  const rawByItem = new Map(
    value.map((entry) => [String(entry?.itemId ?? "").trim(), entry]),
  );
  const normalized: ProcessingActionConsumableState[] = [];
  for (const consumable of expected) {
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
      return null;
    }
    normalized.push({
      ...consumable,
      remainingUses,
      consumedQuantity: consumedQuantity as 0 | 1,
    });
  }
  return normalized;
}

function normalizeProcessingFireEffectRequest(
  value: ProcessingActionFireEffectRequest,
  skill: ProcessingActionSkill,
): ProcessingActionFireEffectRequest | null {
  if (!value || typeof value !== "object" || skill !== "firemaking") {
    return null;
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
    return null;
  }
  const expectedTile = worldToTile(position.x, position.z);
  if (expectedTile.x !== tile.x || expectedTile.z !== tile.z) return null;
  return {
    kind: "fire",
    fireId,
    position: { x: position.x, y: position.y, z: position.z },
    tile: { x: tile.x, z: tile.z },
    durationMs,
  };
}

function normalizeCommittedProcessingFireEffect(
  value: ProcessingActionFireEffect | undefined,
  expected: ProcessingActionFireEffectRequest | undefined,
): ProcessingActionFireEffect | null | undefined {
  if (!expected) return value === undefined ? undefined : null;
  if (!value || value.kind !== "fire") return null;
  const createdAt = Number(value.createdAt);
  const expiresAt = Number(value.expiresAt);
  if (
    value.fireId !== expected.fireId ||
    JSON.stringify(value.position) !== JSON.stringify(expected.position) ||
    JSON.stringify(value.tile) !== JSON.stringify(expected.tile) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt - createdAt !== expected.durationMs
  ) {
    return null;
  }
  return {
    kind: "fire",
    fireId: expected.fireId,
    position: expected.position,
    tile: expected.tile,
    createdAt,
    expiresAt,
  };
}

function normalizeQuestCompletionProgress(
  value: Record<string, number> | null | undefined,
): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  );
  if (keys.length > 64) return null;
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
      quantity > 2_147_483_647
    ) {
      return null;
    }
    normalized[key] = quantity;
  }
  return normalized;
}

function normalizeQuestCompletionItems(
  value: Array<{ itemId: string; quantity: number }> | null | undefined,
  maxQuantity: number,
): QuestCompletionRewardItem[] | null {
  if (!Array.isArray(value) || value.length > 28) return null;
  const totals = new Map<string, number>();
  for (const raw of value) {
    const itemId = String(raw?.itemId ?? "").trim();
    const quantity = Number(raw?.quantity);
    const item = getItem(itemId);
    if (
      !isValidItemID(itemId) ||
      itemId.length > 256 ||
      !item ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > maxQuantity
    ) {
      return null;
    }
    const combined = (totals.get(itemId) ?? 0) + quantity;
    if (!Number.isSafeInteger(combined) || combined > maxQuantity) return null;
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
  value: Record<string, number> | null | undefined,
): QuestCompletionRewardXp[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized: QuestCompletionRewardXp[] = [];
  for (const rawSkill of Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const skill = String(rawSkill ?? "").trim() as QuestRewardSkill;
    const xpAmount = Number(value[rawSkill]);
    if (
      skill !== rawSkill ||
      !QUEST_REWARD_SKILLS.has(skill) ||
      !Number.isSafeInteger(xpAmount) ||
      xpAmount <= 0 ||
      xpAmount > 1_000_000
    ) {
      return null;
    }
    normalized.push({ skill, xpAmount });
  }
  return normalized.length <= QUEST_REWARD_SKILLS.size ? normalized : null;
}

function questCompletionErrorReason(
  error: unknown,
): AtomicQuestCompletionFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("quest_completion_inventory_full")) {
    return "inventory_full";
  }
  if (
    message.includes("quest_completion_progress_state_conflict") ||
    message.includes("quest_completion_progress_missing")
  ) {
    return "quest_state_conflict";
  }
  if (
    message.includes("quest_completion_request_invalid") ||
    message.includes("quest_completion_operation_id_conflict") ||
    message.includes("quest_completion_player_missing") ||
    message.includes("quest_completion_skill_state_invalid") ||
    message.includes("quest_completion_prayer_state_invalid") ||
    message.includes("quest_completion_points_state_invalid") ||
    message.includes("quest_completion_progress_state_invalid") ||
    message.includes("quest_completion_points_overflow") ||
    message.includes("quest_completion_inventory_invalid") ||
    message.includes("quest_completion_inventory_metadata_invalid")
  ) {
    return "invalid_request";
  }
  return "persistence_ambiguous";
}

function shouldRetryQuestCompletion(error: unknown): boolean {
  return questCompletionErrorReason(error) === "persistence_ambiguous";
}

function questStartErrorReason(error: unknown): AtomicQuestStartFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("quest_start_inventory_full")) {
    return "inventory_full";
  }
  if (
    message.includes("quest_start_progress_state_conflict") ||
    message.includes("quest_start_progress_exists")
  ) {
    return "quest_state_conflict";
  }
  if (
    message.includes("quest_start_request_invalid") ||
    message.includes("quest_start_operation_id_conflict") ||
    message.includes("quest_start_player_missing") ||
    message.includes("quest_start_inventory_invalid") ||
    message.includes("quest_start_inventory_metadata_invalid") ||
    message.includes("quest_start_quantity_overflow")
  ) {
    return "invalid_request";
  }
  return "persistence_ambiguous";
}

function shouldRetryQuestStart(error: unknown): boolean {
  return questStartErrorReason(error) === "persistence_ambiguous";
}

function inventoryDebitErrorReason(
  error: unknown,
): AtomicInventoryDebitFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("inventory_debit_insufficient_items")) {
    return "insufficient_items";
  }
  if (
    message.includes("inventory_debit_request_invalid") ||
    message.includes("inventory_debit_requirements_invalid") ||
    message.includes("inventory_debit_operation_id_conflict") ||
    message.includes("inventory_debit_player_missing")
  ) {
    return "invalid_request";
  }
  return "persistence_failed";
}

function shouldRetryInventoryDebit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ![
    "inventory_debit_request_invalid",
    "inventory_debit_requirements_invalid",
    "inventory_debit_operation_id_conflict",
    "inventory_debit_player_missing",
    "inventory_debit_insufficient_items",
    "inventory_debit_inventory_invalid",
    "inventory_debit_inventory_metadata_invalid",
  ].some((code) => message.includes(code));
}

function groundItemDropErrorReason(
  error: unknown,
): AtomicGroundItemDropFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("ground_item_drop_insufficient_items") ||
    message.includes("ground_item_drop_insufficient_coins")
  ) {
    return "insufficient_items";
  }
  if (
    message.includes("ground_item_drop_request_invalid") ||
    message.includes("ground_item_drop_operation_id_conflict") ||
    message.includes("ground_item_drop_player_missing") ||
    message.includes("ground_item_drop_coin_state_invalid") ||
    message.includes("ground_item_drop_slot_mismatch") ||
    message.includes("ground_item_drop_source_preexisting") ||
    message.includes("ground_item_drop_source_receipt_invalid") ||
    message.includes("ground_item_source_request_invalid") ||
    message.includes("ground_item_source_contribution_id_conflict") ||
    message.includes("ground_item_source_quantity_overflow") ||
    message.includes("ground_item_source_lifetime_overflow") ||
    message.includes("ground_item_source_state_invalid")
  ) {
    return "invalid_request";
  }
  return "persistence_ambiguous";
}

function shouldRetryGroundItemDrop(error: unknown): boolean {
  return groundItemDropErrorReason(error) === "persistence_ambiguous";
}

function groundItemPickupErrorReason(
  error: unknown,
): AtomicGroundItemPickupFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("ground_item_pickup_source_claimed") ||
    message.includes("ground_item_pickup_source_missing")
  ) {
    return "source_unavailable";
  }
  if (message.includes("ground_item_pickup_inventory_full")) {
    return "inventory_full";
  }
  if (
    message.includes("ground_item_pickup_request_invalid") ||
    message.includes("ground_item_pickup_operation_id_conflict") ||
    message.includes("ground_item_pickup_player_missing") ||
    message.includes("ground_item_pickup_coin_state_invalid") ||
    message.includes("ground_item_pickup_quantity_overflow") ||
    message.includes("ground_item_pickup_source_mismatch")
  ) {
    return "invalid_request";
  }
  return "persistence_ambiguous";
}

function shouldRetryGroundItemPickup(error: unknown): boolean {
  return groundItemPickupErrorReason(error) === "persistence_ambiguous";
}

function foodConsumptionErrorReason(
  error: unknown,
): AtomicFoodConsumptionFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("inventory_debit_insufficient_items")) {
    return "insufficient_items";
  }
  if (message.includes("food_consumption_full_health")) return "full_health";
  if (message.includes("food_consumption_player_not_alive")) {
    return "player_not_alive";
  }
  if (
    message.includes("food_consumption_request_invalid") ||
    message.includes("food_consumption_operation_id_conflict") ||
    message.includes("food_consumption_player_missing")
  ) {
    return "invalid_request";
  }
  return "persistence_failed";
}

function shouldRetryFoodConsumption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ![
    "food_consumption_request_invalid",
    "food_consumption_operation_id_conflict",
    "food_consumption_player_missing",
    "food_consumption_player_not_alive",
    "food_consumption_full_health",
    "food_consumption_health_state_invalid",
    "inventory_debit_insufficient_items",
  ].some((code) => message.includes(code));
}

function gatheringRewardErrorReason(
  error: unknown,
): AtomicGatheringRewardFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("gathering_reward_inventory_full")) {
    return "inventory_full";
  }
  if (message.includes("gathering_reward_secondary_missing")) {
    return "secondary_missing";
  }
  if (message.includes("gathering_reward_resource_unavailable")) {
    return "resource_unavailable";
  }
  if (
    message.includes("gathering_reward_request_invalid") ||
    message.includes("gathering_reward_operation_id_conflict") ||
    message.includes("gathering_reward_player_missing") ||
    message.includes("gathering_reward_skill_state_invalid") ||
    message.includes("gathering_reward_quantity_overflow")
  ) {
    return "invalid_request";
  }
  return "persistence_ambiguous";
}

function shouldRetryGatheringReward(error: unknown): boolean {
  return gatheringRewardErrorReason(error) === "persistence_ambiguous";
}

function boneBurialErrorReason(error: unknown): AtomicBoneBurialFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("bone_burial_insufficient_items")) {
    return "item_missing";
  }
  if (message.includes("bone_burial_level_required")) {
    return "level_required";
  }
  if (message.includes("bone_burial_xp_cap")) return "xp_cap";
  if (
    message.includes("bone_burial_request_invalid") ||
    message.includes("bone_burial_operation_id_conflict") ||
    message.includes("bone_burial_player_missing") ||
    message.includes("bone_burial_skill_state_invalid") ||
    message.includes("bone_burial_prayer_state_invalid") ||
    message.includes("bone_burial_inventory_invalid") ||
    message.includes("bone_burial_inventory_metadata_invalid")
  ) {
    return "invalid_request";
  }
  return "persistence_ambiguous";
}

function shouldRetryBoneBurial(error: unknown): boolean {
  return boneBurialErrorReason(error) === "persistence_ambiguous";
}

function exactSkillLevelForXp(xp: number): number {
  let cumulative = 0;
  for (let level = 2; level <= 99; level++) {
    const increment =
      Math.floor(level - 1 + 300 * Math.pow(2, (level - 1) / 7)) / 4;
    cumulative = Math.floor(cumulative + increment);
    if (xp < cumulative) return level - 1;
  }
  return 99;
}

function processingActionErrorReason(
  error: unknown,
): AtomicProcessingActionFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("processing_action_insufficient_items")) {
    return "insufficient_items";
  }
  if (message.includes("processing_action_insufficient_coins")) {
    return "insufficient_coins";
  }
  if (message.includes("processing_action_inventory_full")) {
    return "inventory_full";
  }
  if (message.includes("processing_action_fire_tile_occupied")) {
    return "fire_tile_occupied";
  }
  if (message.includes("processing_action_fire_capacity_reached")) {
    return "fire_capacity_reached";
  }
  if (
    message.includes("processing_action_request_invalid") ||
    message.includes("processing_action_operation_id_conflict") ||
    message.includes("processing_action_player_missing") ||
    message.includes("processing_action_skill_state_invalid") ||
    message.includes("processing_action_coin_state_invalid") ||
    message.includes("processing_action_consumable_state_invalid") ||
    message.includes("processing_action_consumable_config_conflict") ||
    message.includes("processing_action_world_effect_state_invalid") ||
    message.includes("processing_action_quantity_overflow")
  ) {
    return "invalid_request";
  }
  return "persistence_ambiguous";
}

function shouldRetryProcessingAction(error: unknown): boolean {
  return processingActionErrorReason(error) === "persistence_ambiguous";
}

export class InventorySystem extends SystemBase {
  protected playerInventories = new Map<PlayerID, PlayerInventory>();
  private readonly MAX_INVENTORY_SLOTS = 28;
  /** Max stackable quantity — matches PostgreSQL integer max to prevent DB truncation */
  private readonly MAX_QUANTITY = 2_147_483_647;
  // Pickup locks to prevent race conditions when multiple players try to pickup same item
  private pickupLocks = new Set<string>();

  // Track players whose inventories are being loaded from DB (prevents race conditions)
  private loadingInventories = new Set<string>();
  // Track players whose inventories have been fully initialized from DB
  private initializedInventories = new Set<string>();

  /**
   * Transaction locks for critical operations (bank, store, trade).
   * While locked:
   * - addItem() rejects new items (pickups blocked)
   * - Only the lock holder can modify inventory
   *
   * This prevents race conditions between in-memory InventorySystem and
   * direct database operations in transaction handlers.
   */
  private transactionLocks = new Set<string>();

  /**
   * Async operation queue for serialized execution.
   * Each player has their own queue - operations execute in order.
   * This allows optimistic UI on client while server processes sequentially.
   */
  private operationQueues = new Map<
    string,
    Array<{
      execute: () => Promise<void>;
      resolve: (value: boolean) => void;
    }>
  >();
  private processingQueues = new Set<string>();
  private isDestroying = false;

  constructor(world: World) {
    super(world, {
      name: "inventory",
      dependencies: {
        required: [],
        optional: ["ui", "equipment", "player", "database"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Subscribe to inventory events
    // PLAYER_REGISTERED: Just initialize empty inventory structure
    // Actual data loading happens in PLAYER_JOINED with payload from character-selection
    this.subscribe(
      EventType.PLAYER_REGISTERED,
      (data: { playerId: string }) => {
        // Initialize empty inventory structure - data will be populated by PLAYER_JOINED
        this.initializeInventory({ id: data.playerId });
      },
    );

    // CRITICAL: Inventory is now passed via event payload from character-selection
    // This eliminates the race condition where two systems query DB independently
    this.subscribe(
      EventType.PLAYER_JOINED,
      async (data: { playerId: string; inventory?: InventorySyncData[] }) => {
        // Use inventory from payload (single source of truth from character-selection)
        if (data.inventory && data.inventory.length > 0) {
          await this.loadInventoryFromPayload(data.playerId, data.inventory);
        } else if (data.inventory) {
          // Empty array = new player or no items, inventory already initialized
          // Mark as initialized so requests work immediately
          this.initializedInventories.add(data.playerId);
        } else {
          // Backwards compatibility: no inventory in payload, fall back to DB query
          const loaded = await this.loadPersistedInventoryAsync(data.playerId);
          if (!loaded) {
            // Mark as initialized even if DB had nothing (new player)
            this.initializedInventories.add(data.playerId);
          }
        }
      },
    );

    this.subscribe(EventType.PLAYER_CLEANUP, (data) => {
      this.cleanupInventory({ id: data.playerId });
    });
    this.subscribe(EventType.INVENTORY_ITEM_REMOVED, async (data) => {
      await this.removeItem(data);
    });
    // Handle remove item requests (e.g., from store sell)
    this.subscribe<{ playerId: string; itemId: string; quantity: number }>(
      EventType.INVENTORY_REMOVE_ITEM,
      async (data) => {
        await this.removeItem(data);
      },
    );
    this.subscribe(EventType.ITEM_DROP, async (data) => {
      await this.dropItem(data);
    });
    this.subscribe(EventType.INVENTORY_USE, (data) => {
      this.useItem(data);
    });
    this.subscribe(EventType.ITEM_PICKUP, async (data) => {
      await this.pickupGroundItem({
        playerId: data.playerId,
        entityId: data.entityId,
        itemId: data.itemId,
      });
    });
    // NOTE: Coin events now handled by CoinPouchSystem
    this.subscribe(EventType.INVENTORY_MOVE, async (data) => {
      await this.moveItem(data);
    });
    this.subscribe(EventType.INVENTORY_DROP_ALL, async (data) => {
      await this.dropAllItems({
        playerId: data.playerId,
        position: data.position,
      });
    });

    // Subscribe to store system events
    this.subscribe(EventType.INVENTORY_CAN_ADD, (data) => {
      this.handleCanAdd(data);
    });
    // NOTE: INVENTORY_REMOVE_COINS and INVENTORY_ADD_COINS now handled by CoinPouchSystem
    this.subscribe(EventType.INVENTORY_ITEM_ADDED, async (data) => {
      await this.handleInventoryAdd(data);
    });

    // Subscribe to inventory check events
    this.subscribe(EventType.INVENTORY_CHECK, (data: InventoryCheckEvent) => {
      this.handleInventoryCheck(data);
    });

    // Subscribe to starter chest looted event
    this.subscribe(
      EventType.STARTER_CHEST_LOOTED,
      async (data: {
        playerId: string;
        items: Array<{ itemId: string; quantity: number }>;
      }) => {
        await this.handleStarterChestLooted(data);
      },
    );
  }

  /**
   * Handle starter chest looted event - add starter items to player inventory
   */
  private async handleStarterChestLooted(data: {
    playerId: string;
    items: Array<{ itemId: string; quantity: number }>;
  }): Promise<void> {
    console.log(
      `[InventorySystem] STARTER_CHEST_LOOTED event received: playerId=${data.playerId}, items=${data.items?.length}`,
    );

    const { playerId, items } = data;

    if (!playerId || !items || items.length === 0) {
      Logger.systemError(
        "InventorySystem",
        "handleStarterChestLooted: invalid data",
        new Error("handleStarterChestLooted: invalid data"),
      );
      return;
    }

    console.log(
      `[InventorySystem] Adding ${items.length} starter items to player ${playerId}`,
    );

    // Add each starter item to the player's inventory
    for (const item of items) {
      const itemData = getItem(item.itemId);
      if (!itemData) {
        console.warn(
          `[InventorySystem] Starter item not found: ${item.itemId}`,
        );
        continue;
      }

      await this.addItem({
        playerId,
        itemId: createItemID(item.itemId),
        quantity: item.quantity,
      });
    }

    console.log(
      `[InventorySystem] Starter items added successfully for player ${playerId}`,
    );
  }

  start(): void {
    // Write-through persistence: no auto-save needed, all mutations persist immediately
  }

  private initializeInventory(playerData: { id: string }): void {
    // Validate and create PlayerID
    if (!isValidPlayerID(playerData.id)) {
      Logger.systemError(
        "InventorySystem",
        `Invalid player ID: "${playerData.id}"`,
        new Error(`Invalid player ID: "${playerData.id}"`),
      );
      return;
    }

    const playerId = createPlayerID(playerData.id);

    // PLAYER_REGISTERED can legitimately be delivered more than once, and
    // embedded players also emit it after PLAYER_JOINED has already started
    // the asynchronous database fallback. Never replace an existing or
    // in-flight inventory with an empty one: doing so can make the live
    // snapshot disagree with PostgreSQL and a later graceful shutdown would
    // persist that empty projection over valid custody.
    if (
      this.playerInventories.has(playerId) ||
      this.loadingInventories.has(playerData.id)
    ) {
      return;
    }

    const inventory: PlayerInventory = {
      playerId: playerId,
      items: [],
      coins: 100, // Starting coins per GDD
    };

    this.playerInventories.set(playerId, inventory);

    // Starter equipment optional via env flag
    const enableStarter =
      typeof process !== "undefined" &&
      process.env &&
      process.env.PUBLIC_STARTER_ITEMS === "1";
    if (enableStarter) this.addStarterEquipment(playerId);

    // Mark as initialized before emitting event
    this.initializedInventories.add(playerData.id);

    const inventoryData = this.getInventoryData(playerData.id);
    this.emitTypedEvent(EventType.INVENTORY_INITIALIZED, {
      playerId: playerData.id, // Keep original for compatibility
      inventory: {
        items: inventoryData.items.map((item) => ({
          slot: item.slot,
          itemId: item.itemId,
          quantity: item.quantity,
          item: {
            id: item.item.id,
            name: item.item.name,
            type: item.item.type,
            stackable: item.item.stackable,
            weight: item.item.weight,
          },
        })),
        coins: inventoryData.coins,
        maxSlots: inventoryData.maxSlots,
      },
    });

    // Emit initial weight for stamina drain calculations
    const totalWeight = this.getTotalWeight(playerData.id);
    this.emitTypedEvent(EventType.PLAYER_WEIGHT_CHANGED, {
      playerId: playerData.id,
      weight: totalWeight,
    });
  }

  private async addStarterEquipment(playerId: PlayerID): Promise<void> {
    const starterItems = [
      { itemId: "bronze_shortsword", quantity: 1 },
      { itemId: "bronze_shield", quantity: 1 },
      { itemId: "bronze_helmet", quantity: 1 },
      { itemId: "bronze_body", quantity: 1 },
      { itemId: "bronze_legs", quantity: 1 },
      { itemId: "wood_bow", quantity: 1 },
      { itemId: "arrows", quantity: 100 },
      { itemId: "tinderbox", quantity: 1 },
      { itemId: "bronze_hatchet", quantity: 1 },
      { itemId: "fishing_rod", quantity: 1 },
    ];

    for (const { itemId, quantity } of starterItems) {
      await this.addItem({ playerId, itemId: createItemID(itemId), quantity });
    }
  }

  private cleanupInventory(data: { id: string }): void {
    const playerId = toPlayerID(data.id);
    if (!playerId) {
      Logger.systemError(
        "InventorySystem",
        `Cannot cleanup inventory: invalid player ID "${data.id}"`,
        new Error(`Cannot cleanup inventory: invalid player ID "${data.id}"`),
      );
      return;
    }
    // Flush this player's inventory to DB before cleanup if character exists
    if (this.world.isServer) {
      const db = this.getDatabase();
      if (db) {
        const inv = this.playerInventories.get(playerId);
        if (inv) {
          db.getPlayerAsync(playerId)
            .then((row) => {
              if (row) {
                const saveItems = inv.items.map((i) => ({
                  itemId: i.itemId,
                  quantity: i.quantity,
                  slotIndex: i.slot,
                  metadata: null as null,
                }));
                db.savePlayerInventory(playerId, saveItems);
                // NOTE: Coins are now persisted by CoinPouchSystem
              }
            })
            .catch(() => {});
        }
      }
    }
    this.playerInventories.delete(playerId);
    // Clean up tracking sets
    this.loadingInventories.delete(data.id);
    this.initializedInventories.delete(data.id);
  }

  protected async addItem(data: {
    playerId: string;
    itemId: string;
    quantity: number;
    slot?: number;
    silent?: boolean; // When true, skip emitInventoryUpdate and persistInventoryImmediate
  }): Promise<boolean> {
    if (!data.playerId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot add item: playerId is undefined",
        new Error("Cannot add item: playerId is undefined"),
      );
      return false;
    }

    // CRITICAL: Reject adds during transaction lock (prevents race conditions)
    // This blocks pickups while bank/store/trade operations are in progress
    if (this.transactionLocks.has(data.playerId)) {
      Logger.system(
        "InventorySystem",
        `Cannot add item during transaction lock: ${data.playerId}`,
      );
      // Emit toast so player understands why pickup failed
      this.emitTypedEvent(EventType.UI_TOAST, {
        playerId: data.playerId,
        message: "Close bank/store first to pick up items",
        type: "warning",
      });
      return false;
    }

    // Block item adds during death state (prevents race condition)
    // When a player dies, items picked up between inventory snapshot and clear
    // would persist after respawn. Block all adds while player is dying/dead.
    if (this.isPlayerInDeathState(data.playerId)) {
      Logger.system(
        "InventorySystem",
        `Cannot add item during death state: ${data.playerId}`,
      );
      return false;
    }

    if (!data.itemId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot add item: itemId is undefined",
        new Error("Cannot add item: itemId is undefined"),
      );
      return false;
    }

    // Validate IDs
    if (!isValidPlayerID(data.playerId) || !isValidItemID(data.itemId)) {
      Logger.systemError(
        "InventorySystem",
        "Cannot add item: invalid ID format",
        new Error("Cannot add item: invalid ID format"),
      );
      return false;
    }

    const playerId = data.playerId;
    const itemId = data.itemId;

    const inventory = this.getOrCreateInventory(playerId);

    const itemData = getItem(itemId);
    if (!itemData) {
      Logger.systemError(
        "InventorySystem",
        `Item not found: ${itemId}`,
        new Error(`Item not found: ${itemId}`),
      );
      return false;
    }

    // Special handling for coins - delegate to CoinPouchSystem
    if (itemId === "coins") {
      const coinPouchSystem = this.getCoinPouchSystem();
      if (coinPouchSystem) {
        await coinPouchSystem.addCoins(playerId, data.quantity, data.silent);
      } else {
        // Fallback: emit event for CoinPouchSystem to handle
        this.emitTypedEvent(EventType.INVENTORY_ADD_COINS, {
          playerId,
          amount: data.quantity,
        });
      }

      // Sync inventory to client (updates UI immediately)
      if (!data.silent) {
        const playerIdKey = toPlayerID(playerId);
        if (playerIdKey) {
          this.emitInventoryUpdate(playerIdKey);
        }
      }
      return true;
    }

    // Check if item is stackable
    if (itemData.stackable) {
      // Find existing stack
      const existingItem = inventory.items.find(
        (item) => item.itemId === itemId,
      );
      if (existingItem) {
        existingItem.quantity = Math.min(
          existingItem.quantity + data.quantity,
          this.MAX_QUANTITY,
        );
        // Skip updates in silent mode
        if (!data.silent) {
          const playerIdKey = toPlayerID(playerId);
          if (playerIdKey) {
            this.emitInventoryUpdate(playerIdKey);
            await this.persistInventoryImmediate(playerId);
          }
        }
        return true;
      }
    }

    // For non-stackable items with quantity > 1, create multiple separate items
    // Each non-stackable item occupies its own slot with quantity=1
    // (e.g., buying 5 logs creates 5 separate inventory slots)
    if (!itemData.stackable && data.quantity > 1) {
      let added = 0;
      for (let i = 0; i < data.quantity; i++) {
        const slot = this.findEmptySlot(inventory);
        if (slot === -1) {
          // Inventory full
          if (added === 0 && !data.silent) {
            this.emitTypedEvent(EventType.INVENTORY_FULL, {
              playerId: playerId,
            });
          }
          break;
        }

        inventory.items.push({
          slot: slot,
          itemId: itemId,
          quantity: 1, // Each non-stackable item has quantity 1
          item: itemData,
        });
        added++;
      }

      // Skip updates in silent mode
      if (added > 0 && !data.silent) {
        const playerIdKey = toPlayerID(playerId);
        if (playerIdKey) {
          this.emitInventoryUpdate(playerIdKey);
          await this.persistInventoryImmediate(playerId);
        }
      }

      return added > 0;
    }

    // Determine slot to use:
    // - If slot is provided AND it's free, use it (for bank sync)
    // - Otherwise find an empty slot
    let targetSlot: number;
    if (
      data.slot !== undefined &&
      data.slot >= 0 &&
      data.slot < this.MAX_INVENTORY_SLOTS
    ) {
      // Check if the provided slot is already occupied
      const slotOccupied = inventory.items.some(
        (item) => item.slot === data.slot,
      );
      if (!slotOccupied) {
        targetSlot = data.slot;
      } else {
        // Slot is occupied, find a free one
        targetSlot = this.findEmptySlot(inventory);
      }
    } else {
      // No slot provided, find empty one
      targetSlot = this.findEmptySlot(inventory);
    }

    if (targetSlot === -1) {
      if (!data.silent) {
        this.emitTypedEvent(EventType.INVENTORY_FULL, { playerId: playerId });
      }
      return false;
    }

    // Add new item to the target slot
    inventory.items.push({
      slot: targetSlot,
      itemId: itemId,
      quantity: data.quantity,
      item: itemData,
    });

    // Skip updates in silent mode
    if (!data.silent) {
      const playerIdKey = toPlayerID(playerId);
      if (playerIdKey) {
        this.emitInventoryUpdate(playerIdKey);
        await this.persistInventoryImmediate(playerId);
      }
    }
    return true;
  }

  /**
   * Check if an item can be added to inventory without modifying state
   * Used for pre-validation before pickup to prevent wasted operations
   *
   * @param playerId - Player to check
   * @param itemId - Item to check
   * @param quantity - Quantity to check
   * @returns true if item can be added
   */
  private canAddItem(
    playerId: string,
    itemId: string,
    quantity: number,
  ): boolean {
    const inventory = this.playerInventories.get(playerId as PlayerID);
    if (!inventory) return true; // New inventory will be created

    const itemData = getItem(itemId);
    if (!itemData) return false;

    // Coins always fit (no slot limit)
    if (itemId === "coins") return true;

    // Stackable: check if we have existing stack or empty slot
    if (itemData.stackable) {
      const existingStack = inventory.items.find((i) => i.itemId === itemId);
      if (existingStack) return true; // Can add to existing stack
    }

    // Need empty slots
    const slotsNeeded = itemData.stackable ? 1 : quantity;
    const emptySlots = this.MAX_INVENTORY_SLOTS - inventory.items.length;
    return emptySlots >= slotsNeeded;
  }

  private async removeItem(
    data: {
      playerId: string;
      itemId: string | number;
      quantity: number;
      slot?: number;
    },
    allowWhileTransactionLocked = false,
  ): Promise<boolean> {
    if (!data.playerId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot remove item: playerId is undefined",
        new Error("Cannot remove item: playerId is undefined"),
      );
      return false;
    }

    if (
      this.transactionLocks.has(data.playerId) &&
      !allowWhileTransactionLocked
    ) {
      Logger.system(
        "InventorySystem",
        `Cannot remove item during transaction lock: ${data.playerId}`,
      );
      return false;
    }

    if (!data.itemId && data.itemId !== 0) {
      Logger.systemError(
        "InventorySystem",
        "Cannot remove item: itemId is undefined",
        new Error("Cannot remove item: itemId is undefined"),
      );
      return false;
    }

    // Validate IDs
    if (
      !isValidPlayerID(data.playerId) ||
      !isValidItemID(String(data.itemId))
    ) {
      Logger.systemError(
        "InventorySystem",
        "Cannot remove item: invalid ID format",
        new Error("Cannot remove item: invalid ID format"),
      );
      return false;
    }

    const playerId = data.playerId;
    const itemId = String(data.itemId);

    const inventory = this.getOrCreateInventory(playerId);

    // Handle coins - delegate to CoinPouchSystem
    if (itemId === "coins") {
      const coinPouchSystem = this.getCoinPouchSystem();
      if (coinPouchSystem) {
        const newBalance = await coinPouchSystem.removeCoins(
          playerId,
          data.quantity,
        );
        return newBalance >= 0; // -1 means insufficient funds
      } else {
        // Fallback: emit event for CoinPouchSystem to handle
        this.emitTypedEvent(EventType.INVENTORY_REMOVE_COINS, {
          playerId,
          amount: data.quantity,
        });
        return true;
      }
    }

    // Loop through all matching items until quantity is fulfilled
    // This handles non-stackable items spread across multiple slots
    // (e.g., 5 bronze swords in 5 separate slots with qty=1 each)
    let remainingQuantity = data.quantity;
    let itemsRemoved = false;

    while (remainingQuantity > 0) {
      // Find next matching item
      const itemIndex =
        data.slot !== undefined
          ? inventory.items.findIndex((item) => item.slot === data.slot)
          : inventory.items.findIndex((item) => item.itemId === itemId);

      if (itemIndex === -1) {
        // No more matching items
        break;
      }

      const item = inventory.items[itemIndex];
      itemsRemoved = true;

      if (item.quantity > remainingQuantity) {
        // This stack has enough - subtract and we're done
        item.quantity -= remainingQuantity;
        remainingQuantity = 0;
      } else {
        // This stack doesn't have enough - remove entire slot, continue
        remainingQuantity -= item.quantity;
        inventory.items.splice(itemIndex, 1);
      }

      // If a specific slot was requested, only remove from that slot
      if (data.slot !== undefined) {
        break;
      }
    }

    // Emit update and persist (only if we removed something)
    if (itemsRemoved) {
      const playerIdKey = toPlayerID(playerId);
      if (playerIdKey) {
        this.emitInventoryUpdate(playerIdKey);
        await this.persistInventoryImmediate(data.playerId);
      }
    }

    return itemsRemoved;
  }

  private async dropItem(data: {
    playerId: string;
    itemId: string;
    quantity?: number;
    slot?: number;
    operationId?: string;
  }): Promise<void> {
    const operationId = data.operationId || generateGroundItemDropOperationId();
    const result = await this.dropOwnedItemAtomic(
      data.playerId,
      operationId,
      data.itemId,
      data.quantity ?? 1,
      data.slot,
    );
    if (!result.ok) {
      Logger.system(
        "InventorySystem",
        `Drop ${operationId} rejected for ${data.playerId}: ${result.reason}`,
      );
      // Replace any browser-side optimistic projection immediately with the
      // current server truth. The correlated result still tells agents why the
      // request failed; this snapshot prevents a five-second false removal.
      if (this.isInventoryReady(data.playerId)) {
        const playerId = toPlayerID(data.playerId);
        if (playerId) this.emitInventoryUpdate(playerId);
      }
      this.emitTypedEvent(EventType.ITEM_DROP_RESULT, {
        success: false,
        committed: result.committed,
        playerId: result.playerId,
        operationId: result.operationId,
        itemId: result.itemId,
        quantity: result.quantity,
        reason: result.reason,
      });
      return;
    }
    this.emitTypedEvent(EventType.ITEM_DROP_RESULT, {
      success: true,
      committed: true,
      playerId: result.receipt.playerId,
      operationId: result.receipt.operationId,
      itemId: result.receipt.itemId,
      quantity: result.receipt.quantity,
      sourceId: result.receipt.source.sourceId,
      position: result.receipt.source.position,
      replayed: result.receipt.replayed,
      liveInventoryApplied: result.liveInventoryApplied,
      liveCoinsApplied: result.liveCoinsApplied,
      presentationReady: result.presentationReady,
    });
    this.world.emit(EventType.ITEM_DROPPED, {
      playerId: result.receipt.playerId,
      itemId: result.receipt.itemId,
      quantity: result.receipt.quantity,
      position: result.receipt.source.position,
      operationId: result.receipt.operationId,
      sourceId: result.receipt.source.sourceId,
    });
  }

  /**
   * Debit one owned item (or coin quantity) and create its durable source in
   * one idempotent transaction. A database commit is authoritative even when
   * applying the returned snapshot or exposing the presentation needs retry.
   */
  async dropOwnedItemAtomic(
    playerId: string,
    operationId: string,
    itemId: string,
    quantity: number,
    slot?: number,
  ): Promise<AtomicGroundItemDropReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const normalizedItemId = String(itemId ?? "").trim();
    const normalizedQuantity = Number(quantity);
    const slotIndex = slot === undefined ? null : Number(slot);
    const failure = (
      reason: AtomicGroundItemDropFailureReason,
    ): AtomicGroundItemDropReceipt => ({
      ok: false,
      committed: reason === "persistence_ambiguous" ? "unknown" : false,
      liveInventoryApplied: false,
      liveCoinsApplied: false,
      presentationReady: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      itemId: normalizedItemId,
      quantity: Number.isFinite(normalizedQuantity) ? normalizedQuantity : 0,
      reason,
    });
    const item = getItem(normalizedItemId);
    if (
      !this.world.isServer ||
      !isValidPlayerID(normalizedPlayerId) ||
      !/^ground-item-drop:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        normalizedOperationId,
      ) ||
      !isValidItemID(normalizedItemId) ||
      !item ||
      !Number.isSafeInteger(normalizedQuantity) ||
      normalizedQuantity <= 0 ||
      normalizedQuantity > this.MAX_QUANTITY ||
      (slotIndex !== null &&
        (!Number.isSafeInteger(slotIndex) ||
          slotIndex < 0 ||
          slotIndex >= this.MAX_INVENTORY_SLOTS)) ||
      (normalizedItemId === "coins" && slotIndex !== null)
    ) {
      return failure("invalid_request");
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized");
    }
    const database = this.getDatabase();
    const groundItems = this.world.getSystem<GroundItemSystem>("ground-items");
    if (
      !database?.commitGroundItemDropOperationAsync ||
      !groundItems?.prepareDurableSourceRegistration ||
      !groundItems.exposeCommittedDurableSource
    ) {
      return failure("atomic_persistence_unavailable");
    }

    let result: AtomicGroundItemDropReceipt = failure("persistence_ambiguous");
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy");
        return false;
      }
      try {
        const duelSystem = this.world.getSystem("duel") as
          { isPlayerInDuel?: (id: string) => boolean } | undefined;
        if (duelSystem?.isPlayerInDuel?.(normalizedPlayerId)) {
          result = failure("duel_locked");
          return false;
        }
        if (this.isPlayerInDeathState(normalizedPlayerId)) {
          result = failure("death_locked");
          return false;
        }
        const player = this.world.getPlayer(normalizedPlayerId);
        const position = player?.node?.position;
        if (
          !position ||
          ![position.x, position.y, position.z].every(Number.isFinite)
        ) {
          result = failure("player_unavailable");
          return false;
        }
        const source = await groundItems.prepareDurableSourceRegistration(
          normalizedItemId,
          normalizedQuantity,
          { x: position.x, y: position.y, z: position.z },
          {
            despawnTime: 120_000,
            droppedBy: normalizedPlayerId,
            lootProtection: 0,
          },
        );
        if (!source) {
          result = failure("source_unavailable");
          return false;
        }

        const fingerprintInput: Omit<
          GroundItemDropCommitRequest,
          "requestFingerprint"
        > = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          itemId: normalizedItemId,
          quantity: normalizedQuantity,
          slotIndex,
          source,
        };
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            serializeGroundItemDropCommitFingerprint(fingerprintInput),
          );
        } catch {
          result = failure("atomic_persistence_unavailable");
          return false;
        }
        const request: GroundItemDropCommitRequest = {
          ...fingerprintInput,
          requestFingerprint,
        };
        let receipt: GroundItemDropCommitReceipt | null = null;
        let attempts = 0;
        while (!receipt && !this.isDestroying) {
          attempts++;
          try {
            receipt =
              await database.commitGroundItemDropOperationAsync(request);
          } catch (error) {
            if (!shouldRetryGroundItemDrop(error)) {
              result = failure(groundItemDropErrorReason(error));
              return false;
            }
            if (attempts === 1 || (attempts & (attempts - 1)) === 0) {
              Logger.systemError(
                "InventorySystem",
                `Ground-item drop ${normalizedOperationId} remains unresolved after ${attempts} attempt(s): ${String(error)}`,
              );
            }
            if (attempts > 1) {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, Math.min(250 * 2 ** (attempts - 2), 5_000));
              });
            }
          }
        }
        if (!receipt) {
          result = failure("persistence_ambiguous");
          return false;
        }
        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.itemId !== normalizedItemId ||
          receipt.quantity !== normalizedQuantity ||
          receipt.slotIndex !== slotIndex ||
          receipt.source.contributionId !== source.contributionId ||
          receipt.source.requestFingerprint !== source.requestFingerprint ||
          receipt.source.itemId !== normalizedItemId ||
          receipt.source.droppedBy !== normalizedPlayerId ||
          (normalizedItemId === "coins") !==
            (receipt.operationCommittedCoins !== null) ||
          !Number.isSafeInteger(receipt.currentCoins) ||
          receipt.currentCoins < 0 ||
          receipt.currentCoins > this.MAX_QUANTITY
        ) {
          Logger.systemError(
            "InventorySystem",
            `Ground-item drop ${normalizedOperationId} committed with an invalid receipt`,
          );
          result = failure("persistence_ambiguous");
          return false;
        }

        let liveInventoryApplied = false;
        try {
          liveInventoryApplied = this.applyCommittedInventorySnapshot(
            normalizedPlayerId,
            receipt.committed,
          );
        } catch (error) {
          Logger.systemError(
            "InventorySystem",
            `Ground-item drop committed but live inventory apply threw for ${normalizedPlayerId}: ${String(error)}`,
          );
        }
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Ground-item drop committed but inventory convergence failed for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }
        let liveCoinsApplied = normalizedItemId !== "coins";
        if (!liveCoinsApplied) {
          try {
            liveCoinsApplied =
              this.getCoinPouchSystem()?.applyCommittedBalance(
                normalizedPlayerId,
                receipt.currentCoins,
              ) === true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Ground-item drop committed but live coin apply threw for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }
        let presentationReady = false;
        try {
          presentationReady = await groundItems.exposeCommittedDurableSource(
            receipt.source,
          );
        } catch (error) {
          Logger.systemError(
            "InventorySystem",
            `Ground-item drop committed but presentation validation failed for ${normalizedOperationId}: ${String(error)}`,
          );
        }
        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          liveCoinsApplied,
          presentationReady,
          receipt,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  /**
   * Drop all items on death - ONLY clears inventory, does NOT spawn items
   * PlayerDeathSystem handles spawning headstone with items
   */
  private async dropAllItems(data: {
    playerId: string;
    position: { x: number; y: number; z: number };
  }): Promise<void> {
    if (!data.playerId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot drop all items: playerId is undefined",
        new Error("Cannot drop all items: playerId is undefined"),
      );
      return;
    }

    const playerID = createPlayerID(data.playerId);
    const inventory = this.getOrCreateInventory(playerID);

    // Get all items that will be dropped (for logging)
    const droppedItemCount = inventory.items.length;

    // Clear the inventory (classic fantasy MMORPG-style: all items go to gravestone)
    inventory.items = [];
    // NOTE: Coins are protected and remain in coin pouch (classic fantasy MMORPG-style)

    // CRITICAL: Update UI by emitting inventory update event
    this.emitInventoryUpdate(playerID);

    // CRITICAL: Must await to prevent duplication exploits on death
    await this.persistEmptyInventory(data.playerId);

    Logger.system(
      "InventorySystem",
      `Cleared inventory on death: ${droppedItemCount} items for player ${data.playerId}`,
    );
  }

  private useItem(data: {
    playerId: string;
    itemId: string;
    slot: number;
  }): void {
    // SERVER-SIDE ONLY: Prevent duplication by ensuring only server processes item use
    // Client sends the request via event, server validates and processes
    if (!this.world.isServer) {
      return;
    }

    // === SECURITY: Bounds validation (OWASP) ===
    if (data.slot < 0 || data.slot >= this.MAX_INVENTORY_SLOTS) {
      Logger.systemError(
        "InventorySystem",
        `Invalid slot ${data.slot} (must be 0-${this.MAX_INVENTORY_SLOTS - 1})`,
        new Error("Invalid slot index"),
      );
      return;
    }

    const playerID = data.playerId;
    const inventory = this.getOrCreateInventory(playerID);

    const item = inventory.items.find((i) => i.slot === data.slot);
    if (!item) {
      Logger.systemError(
        "InventorySystem",
        `No item found in slot ${data.slot}`,
        new Error(`No item found in slot ${data.slot}`),
      );
      return;
    }

    // === SECURITY: Validate claimed itemId matches actual item at slot (OWASP) ===
    // Prevents client from claiming a different item than what's in the slot
    if (item.item.id !== data.itemId) {
      Logger.systemError(
        "InventorySystem",
        `Item mismatch: claimed ${data.itemId} but slot ${data.slot} has ${item.item.id}`,
        new Error("Item ID mismatch - potential exploit attempt"),
      );
      return;
    }

    // Emit item used event for other systems to react to (different from INVENTORY_USE to avoid recursion)
    // NOTE: Consumable removal is handled by the consuming system (e.g., PlayerSystem for food)
    // after it validates the action can proceed (e.g., eat delay check).
    // This prevents items being consumed when the action is rejected.
    this.emitTypedEvent(EventType.ITEM_USED, {
      playerId: data.playerId,
      itemId: data.itemId,
      slot: data.slot,
      itemData: {
        id: item.item.id,
        name: item.item.name,
        type: item.item.type,
        stackable: item.item.stackable,
        weight: item.item.weight,
      },
    });
  }

  /**
   * Complete one spatially admitted server-side ground-item pickup through the
   * inventory lock, protection, capacity, world-removal, and persistence
   * boundary. The boolean is a completion receipt, not merely event dispatch.
   */
  async commitGroundItemPickupAtomic(
    playerId: string,
    operationId: string,
    sourceEntityId: string,
    itemId: string,
    quantity: number,
  ): Promise<AtomicGroundItemPickupReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const normalizedSourceEntityId = String(sourceEntityId ?? "").trim();
    const normalizedItemId = String(itemId ?? "").trim();
    const normalizedQuantity = Number(quantity);
    const failure = (
      reason: AtomicGroundItemPickupFailureReason,
    ): AtomicGroundItemPickupReceipt => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      liveCoinsApplied: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      sourceEntityId: normalizedSourceEntityId,
      itemId: normalizedItemId,
      quantity: Number.isFinite(normalizedQuantity) ? normalizedQuantity : 0,
      reason,
    });
    const item = getItem(normalizedItemId);
    if (
      !toPlayerID(normalizedPlayerId) ||
      !/^ground-item-pickup:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        normalizedOperationId,
      ) ||
      !normalizedSourceEntityId ||
      normalizedSourceEntityId.length > 256 ||
      !isValidItemID(normalizedItemId) ||
      !item ||
      !Number.isSafeInteger(normalizedQuantity) ||
      normalizedQuantity <= 0 ||
      normalizedQuantity > this.MAX_QUANTITY
    ) {
      return failure("invalid_request");
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized");
    }
    const db = this.getDatabase();
    if (!db?.commitGroundItemPickupOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }

    let result: AtomicGroundItemPickupReceipt = failure(
      "persistence_ambiguous",
    );
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy");
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 1,
              playerId: normalizedPlayerId,
              sourceEntityId: normalizedSourceEntityId,
              itemId: normalizedItemId,
              quantity: normalizedQuantity,
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable");
          return false;
        }
        const request: GroundItemPickupCommitRequest = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          sourceEntityId: normalizedSourceEntityId,
          itemId: normalizedItemId,
          quantity: normalizedQuantity,
        };
        let receipt: GroundItemPickupCommitReceipt;
        try {
          receipt = await db.commitGroundItemPickupOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryGroundItemPickup(firstError)) {
            result = failure(groundItemPickupErrorReason(firstError));
            return false;
          }
          try {
            receipt = await db.commitGroundItemPickupOperationAsync(request);
          } catch (retryError) {
            const reason = groundItemPickupErrorReason(retryError);
            Logger.systemError(
              "InventorySystem",
              `Atomic ground-item pickup is unresolved for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            result = failure(reason);
            return false;
          }
        }

        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.sourceEntityId !== normalizedSourceEntityId ||
          receipt.itemId !== normalizedItemId ||
          receipt.quantity !== normalizedQuantity ||
          receipt.stackable !== (item.stackable === true) ||
          (normalizedItemId === "coins") !==
            (receipt.operationCommittedCoins !== null) ||
          !Number.isSafeInteger(receipt.currentCoins) ||
          receipt.currentCoins < 0 ||
          receipt.currentCoins > this.MAX_QUANTITY
        ) {
          result = failure("persistence_ambiguous");
          return false;
        }

        let liveInventoryApplied = this.applyCommittedInventorySnapshot(
          normalizedPlayerId,
          receipt.committed,
        );
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Ground-item pickup committed but inventory convergence failed for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }
        const liveCoinsApplied =
          normalizedItemId !== "coins" ||
          this.getCoinPouchSystem()?.applyCommittedBalance(
            normalizedPlayerId,
            receipt.currentCoins,
          ) === true;
        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          liveCoinsApplied,
          receipt,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  async pickupGroundItem(data: {
    playerId: string;
    entityId: string;
    itemId?: string;
    operationId?: string;
  }): Promise<boolean> {
    // SERVER-SIDE ONLY: Prevent duplication by ensuring only server processes pickups
    if (!this.world.isServer) {
      // Client just sent the request, don't process locally
      return false;
    }

    // Validate input parameters
    if (!data.playerId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot pickup item: playerId is undefined",
        new Error("Cannot pickup item: playerId is undefined"),
      );
      return false;
    }

    if (!data.entityId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot pickup item: entityId is undefined",
        new Error("Cannot pickup item: entityId is undefined"),
      );
      return false;
    }

    // ATOMIC OPERATION: Acquire lock to prevent race conditions
    // Two players clicking same item simultaneously should only result in one pickup
    const lockKey = `pickup:${data.entityId}`;
    if (this.pickupLocks.has(lockKey)) {
      // Another pickup in progress for this item - silently ignore
      return false;
    }

    this.pickupLocks.add(lockKey);
    let groundPickupLock: GroundItemSystem | null = null;

    try {
      // Get item entity data from entity manager
      const entityManager = getSystem(
        this.world,
        "entity-manager",
      ) as EntityManager;
      if (!entityManager) {
        Logger.systemError(
          "InventorySystem",
          "EntityManager system not found",
          new Error("EntityManager system not found"),
        );
        return false;
      }

      // Re-check entity exists AFTER acquiring lock
      // Between validation and lock, the item may have been picked up
      const entity = entityManager.getEntity(data.entityId);
      if (!entity) {
        // Item may have already been picked up - this is expected during:
        // - Spam clicking item piles (player races themselves)
        // - Multiple players grabbing same item (race condition)
        // - Client sync delay (item removed server-side but client still shows it)
        // Silently ignore - not an error condition
        return false;
      }

      // Get itemId from event data or from entity properties
      const itemId = data.itemId || (entity.getProperty("itemId") as string);
      const quantity = (entity.getProperty("quantity") as number) || 1;
      const rawCustodySourceId = entity.getProperty("custodySourceId");
      const custodyPolicy = entity.getProperty("custodyPolicy");
      if (custodyPolicy !== "durable_ground") {
        Logger.systemError(
          "InventorySystem",
          `Cannot pickup item ${data.entityId} without durable ground custody`,
          new Error("Ground-item custody policy rejects pickup"),
        );
        return false;
      }
      const custodySourceId =
        typeof rawCustodySourceId === "string" && rawCustodySourceId.trim()
          ? rawCustodySourceId.trim()
          : data.entityId;

      if (!itemId) {
        Logger.systemError(
          "InventorySystem",
          `No itemId found for entity ${data.entityId}`,
          new Error(`No itemId found for entity ${data.entityId}`),
        );
        return false;
      }

      // Validate that the item exists in the item database
      const itemData = getItem(itemId);
      if (!itemData) {
        Logger.systemError(
          "InventorySystem",
          `Item not found in database: ${itemId}`,
          new Error(`Item not found in database: ${itemId}`),
        );
        return false;
      }

      // Ground custody must not disappear before its destination is durable.
      // Event-only/no-database runtimes cannot acknowledge a production
      // pickup because a process failure would otherwise lose the item.
      if (!this.getDatabase()) {
        Logger.systemError(
          "InventorySystem",
          `Cannot pickup ${data.entityId}: database persistence unavailable`,
          new Error("Ground-item pickup persistence unavailable"),
        );
        return false;
      }
      const coinSystem = itemId === "coins" ? this.getCoinPouchSystem() : null;
      if (itemId === "coins" && !coinSystem) {
        Logger.systemError(
          "InventorySystem",
          `Cannot pickup ${data.entityId}: coin persistence unavailable`,
          new Error("Ground-coin pickup persistence unavailable"),
        );
        return false;
      }

      // Check loot protection (classic MMORPG: killer has 1 minute exclusivity on mob loot)
      const groundItems = this.world.getSystem("ground-items");
      if (groundItems) {
        const currentTick = this.world.currentTick ?? 0;
        if (
          !groundItems.tryAcquirePickupLock(
            data.entityId,
            data.playerId,
            currentTick,
          )
        ) {
          this.emitTypedEvent(EventType.UI_TOAST, {
            playerId: data.playerId,
            message: "This item belongs to another player.",
            type: "warning",
          });
          return false;
        }
        groundPickupLock = groundItems;
      }

      if (data.operationId !== undefined) {
        const atomic = await this.commitGroundItemPickupAtomic(
          data.playerId,
          data.operationId,
          custodySourceId,
          itemData.id,
          quantity,
        );
        if (!atomic.ok) {
          // A different authority already committed this source. Remove the
          // stale local presentation so it cannot attract repeated actions.
          if (atomic.reason === "source_unavailable") {
            const groundItemsSystem =
              this.world.getSystem<GroundItemSystem>("ground-items");
            if (groundItemsSystem) {
              groundItemsSystem.removeGroundItem(data.entityId);
            } else {
              entityManager.destroyEntity(data.entityId);
            }
          }
          if (atomic.reason === "inventory_full") {
            this.emitTypedEvent(EventType.UI_TOAST, {
              playerId: data.playerId,
              message: "Your inventory is full.",
              type: "warning",
            });
          }
          return false;
        }

        // The database receipt already transferred logical source custody.
        // World removal is cleanup and must never roll that committed transfer
        // back or falsify its result after a lost response.
        const groundItemsSystem =
          this.world.getSystem<GroundItemSystem>("ground-items");
        const removed = groundItemsSystem
          ? groundItemsSystem.removeGroundItem(data.entityId)
          : entityManager.destroyEntity(data.entityId);
        if (!removed) {
          Logger.systemError(
            "InventorySystem",
            `Ground-item pickup ${data.operationId} committed but source presentation ${data.entityId} could not be removed`,
            new Error("Ground-item pickup source cleanup failed"),
          );
        }
        return true;
      }

      // PRE-CHECK: Verify inventory capacity BEFORE modifying a legacy/manual
      // pickup. Attempt-bound pickups let the database decide so an exact
      // receipt replay cannot be hidden by inventory changes after commit.
      if (!this.canAddItem(data.playerId, itemData.id, quantity)) {
        this.emitTypedEvent(EventType.UI_TOAST, {
          playerId: data.playerId,
          message: "Your inventory is full.",
          type: "warning",
        });
        return false;
      }

      // Stage the addition in memory without exposing it. The pickup lock stays
      // held until durable destination custody and source removal both finish.
      const added = await this.addItem({
        playerId: data.playerId,
        itemId: itemData.id,
        quantity,
        silent: true, // We'll emit update + persist ourselves after world removal
      });

      if (!added) {
        // Could not add (should not happen after canAddItem check, but handle defensively)
        Logger.system(
          "InventorySystem",
          `Failed to add item ${itemId} to inventory for player ${data.playerId}`,
        );
        return false;
      }

      try {
        if (itemId === "coins") {
          await coinSystem!.persistCoinsImmediateStrict(data.playerId);
        } else {
          await this.persistInventoryImmediate(data.playerId);
        }
      } catch (error) {
        // The source still exists. Restore live destination state before the
        // caller retries, and preserve the persistence failure as ambiguous.
        try {
          await this.removeItem({
            playerId: data.playerId,
            itemId: itemData.id,
            quantity,
          });
        } catch {
          // The original persistence error remains the useful authority signal.
        }
        throw error;
      }

      // Use GroundItemSystem if available - it handles entity destruction AND pile updates.
      const groundItemsSystem = this.world.getSystem("ground-items");
      const worldRemovalSuccess = groundItemsSystem
        ? groundItemsSystem.removeGroundItem(data.entityId)
        : entityManager.destroyEntity(data.entityId);

      // If source removal fails, restore and persist the old destination state
      // before allowing the ground item to be retried.
      if (!worldRemovalSuccess) {
        Logger.systemError(
          "InventorySystem",
          `Failed to remove item ${data.entityId} from world, rolling back inventory add`,
          new Error(`Pickup rollback for entity ${data.entityId}`),
        );
        await this.removeItem({
          playerId: data.playerId,
          itemId: itemData.id,
          quantity,
        });
        if (itemId === "coins") {
          await coinSystem!.persistCoinsImmediateStrict(data.playerId);
        }
        this.emitTypedEvent(EventType.UI_TOAST, {
          playerId: data.playerId,
          message: "Failed to pick up item. Please try again.",
          type: "warning",
        });
        return false;
      }

      const playerIdKey = toPlayerID(data.playerId);
      if (playerIdKey) this.emitInventoryUpdate(playerIdKey);
      return true;
    } finally {
      groundPickupLock?.releasePickupLock(data.entityId, data.playerId);
      // Always release lock
      this.pickupLocks.delete(lockKey);
    }
  }

  // NOTE: updateCoins() removed - now handled by CoinPouchSystem

  /**
   * Move/swap items between inventory slots (classic MMORPG-style)
   *
   * Implements classic MMORPG-style SWAP behavior:
   * - If both slots have items: swap them
   * - If only source has item: move to destination
   * - If source is empty: no-op
   *
   * Security:
   * - Validates slot indices are within bounds [0, MAX_INVENTORY_SLOTS)
   * - Validates playerId is present
   * - Logs errors for invalid operations
   *
   * @param data - Move request with playerId and slot indices
   */
  private async moveItem(data: {
    playerId: string;
    fromSlot?: number;
    toSlot?: number;
    sourceSlot?: number;
    targetSlot?: number;
  }): Promise<void> {
    if (!data.playerId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot move item: playerId is undefined",
        new Error("Cannot move item: playerId is undefined"),
      );
      return;
    }
    if (this.transactionLocks.has(data.playerId)) {
      Logger.system(
        "InventorySystem",
        `Cannot move item during transaction lock: ${data.playerId}`,
      );
      return;
    }

    // Handle parameter name variations
    const fromSlot = data.fromSlot ?? data.sourceSlot;
    const toSlot = data.toSlot ?? data.targetSlot;

    if (fromSlot === undefined || toSlot === undefined) {
      Logger.systemError(
        "InventorySystem",
        "Cannot move item: slot numbers are undefined",
        new Error("Cannot move item: slot numbers are undefined"),
        { data },
      );
      return;
    }

    // Validate slot indices are within bounds (defense in depth - handler also validates)
    if (
      !Number.isInteger(fromSlot) ||
      fromSlot < 0 ||
      fromSlot >= this.MAX_INVENTORY_SLOTS
    ) {
      Logger.systemError(
        "InventorySystem",
        `Cannot move item: fromSlot ${fromSlot} out of bounds [0, ${this.MAX_INVENTORY_SLOTS})`,
        new Error("Invalid fromSlot"),
        { data },
      );
      return;
    }

    if (
      !Number.isInteger(toSlot) ||
      toSlot < 0 ||
      toSlot >= this.MAX_INVENTORY_SLOTS
    ) {
      Logger.systemError(
        "InventorySystem",
        `Cannot move item: toSlot ${toSlot} out of bounds [0, ${this.MAX_INVENTORY_SLOTS})`,
        new Error("Invalid toSlot"),
        { data },
      );
      return;
    }

    // Same slot - no-op (shouldn't reach here, but handle gracefully)
    if (fromSlot === toSlot) {
      return;
    }

    const inventory = this.getOrCreateInventory(data.playerId);

    const fromItem = inventory.items.find((item) => item.slot === fromSlot);
    const toItem = inventory.items.find((item) => item.slot === toSlot);

    // Can't move from empty slot
    if (!fromItem) {
      Logger.system(
        "InventorySystem",
        `moveItem: source slot ${fromSlot} is empty for player ${data.playerId}`,
      );
      return;
    }

    // classic MMORPG-style swap
    if (toItem) {
      // Both slots occupied - swap
      fromItem.slot = toSlot;
      toItem.slot = fromSlot;
    } else {
      // Only source occupied - move to empty destination
      fromItem.slot = toSlot;
    }

    const playerIdKey = toPlayerID(data.playerId);
    if (playerIdKey) {
      this.emitInventoryUpdate(playerIdKey);
      await this.persistInventoryImmediate(data.playerId);
    }
  }

  private findEmptySlot(inventory: PlayerInventory): number {
    const usedSlots = new Set(inventory.items.map((item) => item.slot));

    for (let i = 0; i < this.MAX_INVENTORY_SLOTS; i++) {
      if (!usedSlots.has(i)) {
        return i;
      }
    }

    return -1;
  }

  private emitInventoryUpdate(playerId: PlayerID): void {
    const inventoryData = this.getInventoryData(playerId);
    const inventoryUpdateData = {
      playerId,
      items: inventoryData.items.map((item) => ({
        slot: item.slot,
        itemId: item.itemId,
        quantity: item.quantity,
        item: {
          id: item.item.id,
          name: item.item.name,
          type: item.item.type,
          stackable: item.item.stackable,
          weight: item.item.weight,
        },
      })),
      coins: inventoryData.coins,
      maxSlots: inventoryData.maxSlots,
    };

    // Emit local event for server-side systems
    this.emitTypedEvent(EventType.INVENTORY_UPDATED, inventoryUpdateData);

    // Calculate and emit weight change (for stamina drain calculations)
    const totalWeight = this.getTotalWeight(playerId);
    this.emitTypedEvent(EventType.PLAYER_WEIGHT_CHANGED, {
      playerId,
      weight: totalWeight,
    });

    // NOTE: Network broadcasting is handled by EventBridge which listens for
    // INVENTORY_UPDATED and PLAYER_WEIGHT_CHANGED events and routes them
    // to the specific player only (not broadcast to all clients).
  }

  // ========== Transaction Lock API ==========

  /**
   * Acquire a transaction lock for critical inventory operations.
   *
   * While locked:
   * - addItem() will reject new items (pickups blocked)
   * - Only the lock holder can modify inventory
   *
   * CRITICAL: Always release with unlockTransaction() in a finally block!
   *
   * @param playerId - Player to lock
   * @returns true if lock acquired, false if already locked
   */
  public lockForTransaction(playerId: string): boolean {
    if (this.transactionLocks.has(playerId)) {
      Logger.system(
        "InventorySystem",
        `Transaction lock already held for player: ${playerId}`,
      );
      return false;
    }

    this.transactionLocks.add(playerId);

    return true;
  }

  /**
   * Release a transaction lock.
   * Always call this in a finally block after lockForTransaction().
   *
   * @param playerId - Player to unlock
   */
  public unlockTransaction(playerId: string): void {
    this.transactionLocks.delete(playerId);
  }

  /**
   * Check if a player is locked for a transaction.
   *
   * @param playerId - Player to check
   * @returns true if locked
   */
  public isLockedForTransaction(playerId: string): boolean {
    return this.transactionLocks.has(playerId);
  }

  // ============================================================================
  // ASYNC OPERATION QUEUE
  // ============================================================================

  /**
   * Queue an operation for serialized execution.
   *
   * Unlike lockForTransaction() which REJECTS if busy, this method WAITS.
   * Operations are queued per-player and executed in order.
   *
   * This enables optimistic UI on client:
   * - Client sends all 5 clicks immediately (shows optimistic state)
   * - Server queues and processes all 5 in order
   * - No requests rejected, no data lost
   *
   * @param playerId - Player ID
   * @param operation - Async operation to execute (should acquire lock internally)
   * @returns Promise that resolves when operation completes (true=success, false=failed)
   */
  public async queueOperation(
    playerId: string,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      // Get or create queue for this player
      if (!this.operationQueues.has(playerId)) {
        this.operationQueues.set(playerId, []);
      }

      const queue = this.operationQueues.get(playerId)!;

      // Add operation to queue
      queue.push({
        execute: async () => {
          try {
            const success = await operation();
            resolve(success);
          } catch (error) {
            console.error(
              `[InventorySystem] Queued operation failed for ${playerId}:`,
              error,
            );
            resolve(false);
          }
        },
        resolve,
      });

      // Start processing if not already processing
      this.processQueue(playerId);
    });
  }

  /**
   * Process the operation queue for a player.
   * Executes operations one at a time in order.
   */
  private async processQueue(playerId: string): Promise<void> {
    // Already processing this player's queue
    if (this.processingQueues.has(playerId)) {
      return;
    }

    this.processingQueues.add(playerId);

    const queue = this.operationQueues.get(playerId);
    if (!queue) {
      this.processingQueues.delete(playerId);
      return;
    }

    // Process operations one at a time
    while (queue.length > 0) {
      const op = queue.shift()!;
      await op.execute();
    }

    // Cleanup
    this.processingQueues.delete(playerId);
    if (queue.length === 0) {
      this.operationQueues.delete(playerId);
    }
  }

  /**
   * Reload inventory from database, REPLACING in-memory state.
   *
   * CRITICAL: Only call while holding transaction lock!
   * This makes DB authoritative - in-memory becomes exact mirror.
   *
   * Used after bank/store/trade transactions to ensure in-memory
   * state matches what the transaction wrote to the database.
   *
   * @param playerId - Player whose inventory to reload
   */
  public async reloadFromDatabase(playerId: string): Promise<void> {
    const db = this.getDatabase();
    if (!db) {
      Logger.system(
        "InventorySystem",
        `Cannot reload inventory for ${playerId}: no database`,
      );
      return;
    }

    const rows = await db.getPlayerInventoryAsync(playerId);
    const playerIdKey = createPlayerID(playerId);

    // REPLACE entire in-memory inventory with DB state
    const inventory: PlayerInventory = {
      playerId: playerIdKey,
      items: [],
      coins: 0, // Coins managed by CoinPouchSystem, not stored here
    };

    for (const row of rows) {
      const itemData = getItem(row.itemId);
      if (itemData) {
        inventory.items.push({
          slot: row.slotIndex ?? 0,
          itemId: row.itemId,
          quantity: row.quantity ?? 1,
          item: itemData,
        });
      }
    }

    this.playerInventories.set(playerIdKey, inventory);
    this.initializedInventories.add(playerId);

    // Emit update to refresh client UI
    this.emitInventoryUpdate(playerIdKey);
  }

  // ========== Public API ==========

  /**
   * Get the full inventory state for a player.
   *
   * Returns the raw PlayerInventory object containing items and metadata.
   * Use {@link getInventoryData} for a cleaned data object suitable for UI.
   *
   * @param playerId - The player ID to look up
   * @returns PlayerInventory object, or undefined if not found
   *
   * @example
   * const inventory = inventorySystem.getInventory(playerId);
   * if (inventory) {
   *   console.log(`Player has ${inventory.items.length} items`);
   * }
   */
  getInventory(playerId: string): PlayerInventory | undefined {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) {
      Logger.systemError(
        "InventorySystem",
        `Invalid player ID in getInventory: "${playerId}"`,
        new Error(`Invalid player ID in getInventory: "${playerId}"`),
      );
      return undefined;
    }
    return this.playerInventories.get(playerIdKey);
  }

  /**
   * Debit one food item and durably stage its matching health effect. The live
   * inventory remains locked until it converges to the committed snapshot.
   */
  async commitFoodConsumptionAtomic(
    playerId: string,
    operationId: string,
    itemId: string,
    healAmount: number,
    publicActionObservation?: StreamingDuelFoodObservationContext,
  ): Promise<AtomicFoodConsumptionReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const normalizedItemId = String(itemId ?? "").trim();
    const normalizedHealAmount = Number(healAmount);
    const normalizedPublicActionObservation =
      publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelFoodObservationContext(publicActionObservation);
    const failure = (
      reason: AtomicFoodConsumptionFailureReason,
    ): AtomicFoodConsumptionReceipt => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      itemId: normalizedItemId,
      healAmount: Number.isFinite(normalizedHealAmount)
        ? normalizedHealAmount
        : 0,
      reason,
    });
    const item = getItem(normalizedItemId);
    if (
      !toPlayerID(normalizedPlayerId) ||
      !/^[A-Za-z0-9:_-]{1,256}$/.test(normalizedOperationId) ||
      !isValidItemID(normalizedItemId) ||
      !item ||
      (item.type !== "food" && item.type !== "consumable") ||
      !Number.isSafeInteger(normalizedHealAmount) ||
      normalizedHealAmount <= 0 ||
      (publicActionObservation !== undefined &&
        (!normalizedPublicActionObservation ||
          normalizedPublicActionObservation.actorId !== normalizedPlayerId))
    ) {
      return failure("invalid_request");
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized");
    }
    const db = this.getDatabase();
    if (!db?.commitFoodConsumptionOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }

    let result: AtomicFoodConsumptionReceipt = failure("persistence_failed");
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy");
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 1,
              playerId: normalizedPlayerId,
              itemId: normalizedItemId,
              healAmount: normalizedHealAmount,
              ...(normalizedPublicActionObservation
                ? {
                    publicActionObservation: normalizedPublicActionObservation,
                  }
                : {}),
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable");
          return false;
        }
        const request: FoodConsumptionCommitRequest = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          itemId: normalizedItemId,
          healAmount: normalizedHealAmount,
          ...(normalizedPublicActionObservation
            ? { publicActionObservation: normalizedPublicActionObservation }
            : {}),
        };
        let receipt: FoodConsumptionCommitReceipt;
        try {
          receipt = await db.commitFoodConsumptionOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryFoodConsumption(firstError)) {
            result = failure(foodConsumptionErrorReason(firstError));
            return false;
          }
          try {
            receipt = await db.commitFoodConsumptionOperationAsync(request);
          } catch (retryError) {
            Logger.systemError(
              "InventorySystem",
              `Atomic food commit failed for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            result = failure(foodConsumptionErrorReason(retryError));
            return false;
          }
        }
        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.itemId !== normalizedItemId ||
          receipt.healAmount !== normalizedHealAmount ||
          (receipt.status !== "pending" && receipt.status !== "completed")
        ) {
          result = failure("persistence_failed");
          return false;
        }

        let liveInventoryApplied = this.applyCommittedInventorySnapshot(
          normalizedPlayerId,
          receipt.committed,
        );
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Failed to converge inventory after committed food debit for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }
        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          receipt,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  /**
   * Consume every requested item quantity as one authoritative database
   * operation. No live slot is mutated until the durable transaction and its
   * idempotency receipt have committed. An ambiguous lost response is retried
   * once with the exact same operation identity.
   */
  async debitItemsAtomic(
    playerId: string,
    operationId: string,
    requestedRequirements: InventoryDebitRequirement[],
  ): Promise<AtomicInventoryDebitReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const requirements =
      normalizeDebitRequirements(requestedRequirements, this.MAX_QUANTITY) ??
      [];
    const failure = (
      reason: AtomicInventoryDebitFailureReason,
    ): AtomicInventoryDebitReceipt => ({
      ok: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      changed: false,
      replayed: false,
      requirements,
      reason,
    });

    if (
      !toPlayerID(normalizedPlayerId) ||
      !normalizedOperationId ||
      normalizedOperationId.length > 256 ||
      requirements.length === 0
    ) {
      return failure("invalid_request");
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized");
    }
    const db = this.getDatabase();
    if (!db?.commitInventoryDebitOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }

    let result: AtomicInventoryDebitReceipt = failure("persistence_failed");
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy");
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 1,
              playerId: normalizedPlayerId,
              requirements,
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable");
          return false;
        }

        const request = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          requirements,
        };
        let receipt;
        try {
          receipt = await db.commitInventoryDebitOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryInventoryDebit(firstError)) {
            result = failure(inventoryDebitErrorReason(firstError));
            return false;
          }
          try {
            receipt = await db.commitInventoryDebitOperationAsync(request);
          } catch (retryError) {
            Logger.systemError(
              "InventorySystem",
              `Atomic inventory debit failed for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            result = failure(inventoryDebitErrorReason(retryError));
            return false;
          }
        }

        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          JSON.stringify(receipt.requirements) !== JSON.stringify(requirements)
        ) {
          result = failure("persistence_failed");
          return false;
        }
        if (
          !this.applyCommittedInventorySnapshot(
            normalizedPlayerId,
            receipt.committed,
          )
        ) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Failed to converge inventory after committed debit for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
          result = failure("committed_state_apply_failed");
          return false;
        }

        result = {
          ok: true,
          playerId: normalizedPlayerId,
          operationId: normalizedOperationId,
          changed: true,
          replayed: receipt.replayed,
          requirements,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });

    return result;
  }

  /** Stage one exact spell-rune cost before projectile admission. */
  async stageProjectileRuneCostAtomic(
    playerId: string,
    operationId: string,
    requestedRequirements: InventoryDebitRequirement[],
  ): Promise<AtomicProjectileRuneCostReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const requirements =
      normalizeDebitRequirements(requestedRequirements, this.MAX_QUANTITY) ??
      [];
    const failure = (
      reason: AtomicInventoryDebitFailureReason,
    ): AtomicProjectileRuneCostReceipt => ({
      ok: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      changed: false,
      replayed: false,
      requirements,
      reason,
    });
    if (
      !toPlayerID(normalizedPlayerId) ||
      !/^spell-runes:[A-Za-z0-9]{20}$/.test(normalizedOperationId) ||
      requirements.length === 0
    ) {
      return failure("invalid_request");
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized");
    }
    const db = this.getDatabase();
    if (!db?.commitProjectileRuneCostOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }
    let result: AtomicProjectileRuneCostReceipt = failure("persistence_failed");
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy");
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 1,
              playerId: normalizedPlayerId,
              requirements,
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable");
          return false;
        }
        const request = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          requirements,
        };
        let receipt;
        try {
          receipt = await db.commitProjectileRuneCostOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryInventoryDebit(firstError)) {
            result = failure(inventoryDebitErrorReason(firstError));
            return false;
          }
          try {
            receipt = await db.commitProjectileRuneCostOperationAsync(request);
          } catch (retryError) {
            Logger.systemError(
              "InventorySystem",
              `Atomic projectile rune stage failed for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            result = failure(inventoryDebitErrorReason(retryError));
            return false;
          }
        }
        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.status !== "pending" ||
          receipt.refundDestination !== null ||
          JSON.stringify(receipt.requirements) !== JSON.stringify(requirements)
        ) {
          result = failure("persistence_failed");
          return false;
        }
        if (
          !this.applyCommittedInventorySnapshot(
            normalizedPlayerId,
            receipt.committed,
          )
        ) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Failed to converge staged projectile rune cost for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
          result = failure("committed_state_apply_failed");
          return false;
        }
        result = {
          ok: true,
          playerId: normalizedPlayerId,
          operationId: normalizedOperationId,
          changed: true,
          replayed: receipt.replayed,
          requestFingerprint,
          requirements,
          status: "pending",
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  async completeProjectileRuneCostAtomic(
    staged: ProjectileRuneCostSettlementHandle,
  ): Promise<AtomicProjectileRuneCostReceipt> {
    return this.settleProjectileRuneCostAtomic(staged, "fired");
  }

  /** Refund a pending debit, or terminally resolve an already-fired spell. */
  async cancelProjectileRuneCostAtomic(
    staged: ProjectileRuneCostSettlementHandle,
  ): Promise<AtomicProjectileRuneCostReceipt> {
    return this.settleProjectileRuneCostAtomic(staged, "cancelled");
  }

  private async settleProjectileRuneCostAtomic(
    staged: ProjectileRuneCostSettlementHandle,
    requestedStatus: "fired" | "cancelled",
  ): Promise<AtomicProjectileRuneCostReceipt> {
    const requirements =
      normalizeDebitRequirements(staged.requirements, this.MAX_QUANTITY) ?? [];
    const failure = (
      reason: AtomicInventoryDebitFailureReason,
    ): AtomicProjectileRuneCostReceipt => ({
      ok: false,
      playerId: staged.playerId,
      operationId: staged.operationId,
      changed: false,
      replayed: false,
      requirements,
      reason,
    });
    const db = this.getDatabase();
    const settle =
      requestedStatus === "fired"
        ? db?.completeProjectileRuneCostOperationAsync
        : db?.cancelProjectileRuneCostOperationAsync;
    if (!settle || requirements.length === 0) {
      return failure("atomic_persistence_unavailable");
    }
    let result: AtomicProjectileRuneCostReceipt = failure("persistence_failed");
    await this.queueOperation(staged.playerId, async () => {
      if (!this.lockForTransaction(staged.playerId)) {
        result = failure("inventory_busy");
        return false;
      }
      try {
        let receipt;
        const settlementRequest = {
          operationId: staged.operationId,
          playerId: staged.playerId,
          requestFingerprint: staged.requestFingerprint,
        };
        try {
          receipt = await settle.call(db, settlementRequest);
        } catch (firstError) {
          if (!shouldRetryInventoryDebit(firstError)) {
            result = failure(inventoryDebitErrorReason(firstError));
            return false;
          }
          try {
            receipt = await settle.call(db, settlementRequest);
          } catch (retryError) {
            Logger.systemError(
              "InventorySystem",
              `Atomic projectile rune settlement failed for ${staged.playerId}: ${String(retryError)}`,
            );
            result = failure(inventoryDebitErrorReason(retryError));
            return false;
          }
        }
        if (
          receipt.operationId !== staged.operationId ||
          receipt.playerId !== staged.playerId ||
          receipt.requestFingerprint !== staged.requestFingerprint ||
          (receipt.status !== "fired" &&
            receipt.status !== "resolved" &&
            receipt.status !== "cancelled") ||
          (receipt.status === "cancelled") !==
            (receipt.refundDestination !== null) ||
          JSON.stringify(receipt.requirements) !== JSON.stringify(requirements)
        ) {
          result = failure("persistence_failed");
          return false;
        }
        if (
          !this.applyCommittedInventorySnapshot(
            staged.playerId,
            receipt.committed,
          )
        ) {
          try {
            await this.reloadFromDatabase(staged.playerId);
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Failed to converge projectile rune settlement for ${staged.playerId}: ${String(error)}`,
            );
          }
          result = failure("committed_state_apply_failed");
          return false;
        }
        result = {
          ok: true,
          playerId: staged.playerId,
          operationId: staged.operationId,
          changed: true,
          replayed: receipt.replayed,
          requestFingerprint: staged.requestFingerprint,
          requirements,
          status: receipt.status,
        };
        return true;
      } finally {
        this.unlockTransaction(staged.playerId);
      }
    });
    return result;
  }

  /**
   * Commit one bone debit and its exact Prayer progression through the
   * database-owned custody boundary. A successful result may temporarily have
   * liveInventoryApplied=false, but it is still durable and must only be
   * retried with the same operation ID.
   */
  async commitBoneBurialAtomic(
    playerId: string,
    operationId: string,
    itemId: string,
    xpAmount: number,
    levelRequired: number,
  ): Promise<AtomicBoneBurialReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const normalizedItemId = String(itemId ?? "").trim();
    const normalizedXpAmount = Number(xpAmount);
    const normalizedLevelRequired = Number(levelRequired);
    const itemData = getItem(normalizedItemId);
    const failure = (
      reason: AtomicBoneBurialFailureReason,
      retryable: boolean,
    ): AtomicBoneBurialReceipt => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      replayed: false,
      itemId: normalizedItemId,
      xpAmount: Number.isFinite(normalizedXpAmount) ? normalizedXpAmount : 0,
      levelRequired: Number.isFinite(normalizedLevelRequired)
        ? normalizedLevelRequired
        : 0,
      retryable,
      reason,
    });

    if (
      !toPlayerID(normalizedPlayerId) ||
      !BONE_BURIAL_OPERATION_ID_PATTERN.test(normalizedOperationId) ||
      !isValidItemID(normalizedItemId) ||
      !itemData ||
      !Number.isSafeInteger(normalizedXpAmount) ||
      normalizedXpAmount <= 0 ||
      normalizedXpAmount > 1_000_000 ||
      itemData.prayerXp !== normalizedXpAmount ||
      !Number.isSafeInteger(normalizedLevelRequired) ||
      normalizedLevelRequired < 1 ||
      normalizedLevelRequired > 99 ||
      (itemData.buryLevelRequired ?? 1) !== normalizedLevelRequired
    ) {
      return failure("invalid_request", false);
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized", true);
    }
    const db = this.getDatabase();
    if (!db?.commitBoneBurialOperationAsync) {
      return failure("atomic_persistence_unavailable", true);
    }

    let result: AtomicBoneBurialReceipt = failure(
      "persistence_ambiguous",
      true,
    );
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy", true);
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 1,
              playerId: normalizedPlayerId,
              itemId: normalizedItemId,
              xpAmount: normalizedXpAmount,
              levelRequired: normalizedLevelRequired,
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable", true);
          return false;
        }
        const request: BoneBurialCommitRequest = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          itemId: normalizedItemId,
          xpAmount: normalizedXpAmount,
          levelRequired: normalizedLevelRequired,
        };

        let receipt;
        try {
          receipt = await db.commitBoneBurialOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryBoneBurial(firstError)) {
            const reason = boneBurialErrorReason(firstError);
            result = failure(reason, false);
            return false;
          }
          try {
            receipt = await db.commitBoneBurialOperationAsync(request);
          } catch (retryError) {
            const reason = boneBurialErrorReason(retryError);
            Logger.systemError(
              "InventorySystem",
              `Atomic bone burial is unresolved for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            result = failure(reason, reason === "persistence_ambiguous");
            return false;
          }
        }

        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.itemId !== normalizedItemId ||
          receipt.xpAmount !== normalizedXpAmount ||
          receipt.levelRequired !== normalizedLevelRequired ||
          !Number.isSafeInteger(receipt.awardedXp) ||
          receipt.awardedXp < 0 ||
          receipt.awardedXp > normalizedXpAmount ||
          !Number.isSafeInteger(receipt.operationCommittedXp) ||
          receipt.operationCommittedXp < 0 ||
          receipt.operationCommittedXp > MAX_SKILL_XP ||
          !Number.isSafeInteger(receipt.currentXp) ||
          receipt.currentXp < receipt.operationCommittedXp ||
          receipt.currentXp > MAX_SKILL_XP ||
          !Number.isSafeInteger(receipt.currentLevel) ||
          receipt.currentLevel !== exactSkillLevelForXp(receipt.currentXp)
        ) {
          result = failure("persistence_ambiguous", true);
          return false;
        }

        let liveInventoryApplied = this.applyCommittedInventorySnapshot(
          normalizedPlayerId,
          receipt.committed,
        );
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Bone burial committed but live inventory convergence failed for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }

        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          playerId: normalizedPlayerId,
          operationId: normalizedOperationId,
          replayed: receipt.replayed,
          itemId: normalizedItemId,
          xpAmount: normalizedXpAmount,
          levelRequired: normalizedLevelRequired,
          awardedXp: receipt.awardedXp,
          operationCommittedXp: receipt.operationCommittedXp,
          currentXp: receipt.currentXp,
          currentLevel: receipt.currentLevel,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  /**
   * Start one quest through the database-owned custody boundary. The progress
   * row, every starter item, audit record, and replay receipt become visible as
   * one transition. An ambiguous response is retried with byte-identical input.
   */
  async commitQuestStartAtomic(
    playerId: string,
    questId: string,
    input: {
      questStartedAt: number;
      initialStage: string;
      items: Array<{ itemId: string; quantity: number }>;
    },
  ): Promise<AtomicQuestStartReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedQuestId = String(questId ?? "").trim();
    const questStartedAt = Number(input?.questStartedAt);
    const initialStage = String(input?.initialStage ?? "").trim();
    const items = normalizeQuestCompletionItems(
      input?.items,
      this.MAX_QUANTITY,
    );
    let operationId = "";
    const failure = (
      reason: AtomicQuestStartFailureReason,
      retryable: boolean,
      committed: false | "unknown" = false,
    ): AtomicQuestStartReceipt => ({
      ok: false,
      committed,
      liveInventoryApplied: false,
      playerId: normalizedPlayerId,
      operationId,
      questId: normalizedQuestId,
      retryable,
      reason,
    });
    if (
      !toPlayerID(normalizedPlayerId) ||
      !normalizedQuestId ||
      normalizedQuestId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(normalizedQuestId) ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt <= 0 ||
      !initialStage ||
      initialStage.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(initialStage) ||
      !items
    ) {
      return failure("invalid_request", false);
    }
    try {
      const identityHash = await sha256Hex(
        JSON.stringify({
          version: 1,
          playerId: normalizedPlayerId,
          questId: normalizedQuestId,
          questStartedAt,
        }),
      );
      operationId = `quest-start:${identityHash}`;
    } catch {
      return failure("atomic_persistence_unavailable", true);
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized", true);
    }
    const db = this.getDatabase();
    if (!db?.commitQuestStartOperationAsync) {
      return failure("atomic_persistence_unavailable", true);
    }

    let result: AtomicQuestStartReceipt = failure(
      "persistence_ambiguous",
      true,
      "unknown",
    );
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy", true);
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 1,
              playerId: normalizedPlayerId,
              questId: normalizedQuestId,
              questStartedAt,
              initialStage,
              items,
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable", true);
          return false;
        }
        const request: QuestStartCommitRequest = {
          operationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          questId: normalizedQuestId,
          questStartedAt,
          initialStage,
          items,
        };
        let receipt: QuestStartCommitReceipt;
        try {
          receipt = await db.commitQuestStartOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryQuestStart(firstError)) {
            result = failure(questStartErrorReason(firstError), false);
            return false;
          }
          try {
            receipt = await db.commitQuestStartOperationAsync(request);
          } catch (retryError) {
            const reason = questStartErrorReason(retryError);
            Logger.systemError(
              "InventorySystem",
              `Atomic quest start is unresolved for ${normalizedPlayerId}/${normalizedQuestId}: ${String(retryError)}`,
            );
            result = failure(
              reason,
              reason === "persistence_ambiguous",
              "unknown",
            );
            return false;
          }
        }

        if (
          receipt.operationId !== operationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.questId !== normalizedQuestId ||
          receipt.questStartedAt !== questStartedAt ||
          receipt.initialStage !== initialStage ||
          typeof receipt.replayed !== "boolean" ||
          JSON.stringify(receipt.items) !== JSON.stringify(items)
        ) {
          result = failure("persistence_ambiguous", true, "unknown");
          return false;
        }

        let liveInventoryApplied = this.applyCommittedInventorySnapshot(
          normalizedPlayerId,
          receipt.committed,
        );
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Quest start committed but live inventory convergence failed for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }
        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          receipt,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  /**
   * Complete one quest through the database-owned custody boundary. The
   * deterministic operation identity is derived from the exact quest
   * incarnation, so an ambiguous response can only replay the same rewards.
   */
  async commitQuestCompletionAtomic(
    playerId: string,
    questId: string,
    input: {
      questStartedAt: number;
      expectedStage: string;
      expectedProgress: Record<string, number>;
      questPoints: number;
      items: Array<{ itemId: string; quantity: number }>;
      xp: Record<string, number>;
    },
  ): Promise<AtomicQuestCompletionReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedQuestId = String(questId ?? "").trim();
    const questStartedAt = Number(input?.questStartedAt);
    const expectedStage = String(input?.expectedStage ?? "").trim();
    const questPoints = Number(input?.questPoints);
    const expectedProgress = normalizeQuestCompletionProgress(
      input?.expectedProgress,
    );
    const items = normalizeQuestCompletionItems(
      input?.items,
      this.MAX_QUANTITY,
    );
    const xp = normalizeQuestCompletionXp(input?.xp);
    let operationId = "";
    const failure = (
      reason: AtomicQuestCompletionFailureReason,
      retryable: boolean,
      committed: false | "unknown" = false,
    ): AtomicQuestCompletionReceipt => ({
      ok: false,
      committed,
      liveInventoryApplied: false,
      playerId: normalizedPlayerId,
      operationId,
      questId: normalizedQuestId,
      retryable,
      reason,
    });
    if (
      !toPlayerID(normalizedPlayerId) ||
      !normalizedQuestId ||
      normalizedQuestId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(normalizedQuestId) ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt <= 0 ||
      !expectedStage ||
      expectedStage.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(expectedStage) ||
      !expectedProgress ||
      !Number.isSafeInteger(questPoints) ||
      questPoints < 0 ||
      questPoints > 1_000_000 ||
      !items ||
      !xp
    ) {
      return failure("invalid_request", false);
    }
    try {
      const identityHash = await sha256Hex(
        JSON.stringify({
          version: 1,
          playerId: normalizedPlayerId,
          questId: normalizedQuestId,
          questStartedAt,
        }),
      );
      operationId = `quest-completion:${identityHash}`;
    } catch {
      return failure("atomic_persistence_unavailable", true);
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized", true);
    }
    const db = this.getDatabase();
    if (!db?.commitQuestCompletionOperationAsync) {
      return failure("atomic_persistence_unavailable", true);
    }

    let result: AtomicQuestCompletionReceipt = failure(
      "persistence_ambiguous",
      true,
      "unknown",
    );
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy", true);
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 1,
              playerId: normalizedPlayerId,
              questId: normalizedQuestId,
              questStartedAt,
              expectedStage,
              expectedProgress,
              questPoints,
              items,
              xp,
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable", true);
          return false;
        }
        const request: QuestCompletionCommitRequest = {
          operationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          questId: normalizedQuestId,
          questStartedAt,
          expectedStage,
          expectedProgress,
          questPoints,
          items,
          xp,
        };
        let receipt: QuestCompletionCommitReceipt;
        try {
          receipt = await db.commitQuestCompletionOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryQuestCompletion(firstError)) {
            const reason = questCompletionErrorReason(firstError);
            result = failure(reason, false);
            return false;
          }
          try {
            receipt = await db.commitQuestCompletionOperationAsync(request);
          } catch (retryError) {
            const reason = questCompletionErrorReason(retryError);
            Logger.systemError(
              "InventorySystem",
              `Atomic quest completion is unresolved for ${normalizedPlayerId}/${normalizedQuestId}: ${String(retryError)}`,
            );
            result = failure(
              reason,
              reason === "persistence_ambiguous",
              "unknown",
            );
            return false;
          }
        }

        const progress = Array.isArray(receipt.progress)
          ? receipt.progress
          : [];
        const progressValid =
          progress.length === xp.length &&
          progress.every((entry, index) => {
            const expected = xp[index];
            return (
              entry.skill === expected.skill &&
              entry.xpAmount === expected.xpAmount &&
              Number.isFinite(entry.awardedXp) &&
              entry.awardedXp >= 0 &&
              entry.awardedXp <= entry.xpAmount &&
              Number.isFinite(entry.operationCommittedXp) &&
              entry.operationCommittedXp >= entry.awardedXp &&
              entry.operationCommittedXp <= MAX_SKILL_XP &&
              Number.isFinite(entry.currentXp) &&
              entry.currentXp >= entry.operationCommittedXp &&
              entry.currentXp <= MAX_SKILL_XP &&
              Number.isSafeInteger(entry.currentLevel) &&
              entry.currentLevel === exactSkillLevelForXp(entry.currentXp)
            );
          });
        const prayerProgress = progress.find(
          (entry) => entry.skill === "prayer",
        );
        const prayer = receipt.prayer;
        const prayerValid = prayerProgress
          ? Boolean(
              prayer &&
              Number.isSafeInteger(prayer.pointUnits) &&
              prayer.pointUnits >= 0 &&
              Number.isSafeInteger(prayer.maxPoints) &&
              prayer.maxPoints === prayerProgress.currentLevel &&
              prayer.pointUnits <= prayer.maxPoints * 1_000_000 &&
              Array.isArray(prayer.activePrayers) &&
              prayer.activePrayers.length <= 32 &&
              new Set(prayer.activePrayers).size ===
                prayer.activePrayers.length &&
              (prayer.pointUnits > 0 || prayer.activePrayers.length === 0),
            )
          : prayer === null;
        if (
          receipt.operationId !== operationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.questId !== normalizedQuestId ||
          receipt.questStartedAt !== questStartedAt ||
          receipt.expectedStage !== expectedStage ||
          JSON.stringify(receipt.expectedProgress) !==
            JSON.stringify(expectedProgress) ||
          receipt.questPoints !== questPoints ||
          JSON.stringify(receipt.items) !== JSON.stringify(items) ||
          JSON.stringify(receipt.xp) !== JSON.stringify(xp) ||
          !Number.isSafeInteger(receipt.completedAt) ||
          receipt.completedAt <= 0 ||
          !Number.isSafeInteger(receipt.operationCommittedQuestPoints) ||
          receipt.operationCommittedQuestPoints < questPoints ||
          !Number.isSafeInteger(receipt.currentQuestPoints) ||
          receipt.currentQuestPoints < receipt.operationCommittedQuestPoints ||
          !progressValid ||
          !prayerValid
        ) {
          result = failure("persistence_ambiguous", true, "unknown");
          return false;
        }

        let liveInventoryApplied = this.applyCommittedInventorySnapshot(
          normalizedPlayerId,
          receipt.committed,
        );
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Quest completion committed but live inventory convergence failed for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }
        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          receipt: {
            ...receipt,
            progress: progress as QuestCompletionProgressReceipt[],
          },
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  /**
   * Commit a successful gathering roll without exposing a partial result. The
   * database owns slot allocation and commits any secondary-item debit, reward
   * credit, skill XP/level, and idempotency receipt together.
   */
  async commitGatheringRewardAtomic(
    playerId: string,
    operationId: string,
    input: {
      resourceId: string;
      depleteAfterCommit: boolean;
      respawnTicks: number;
      skill: GatheringRewardSkill;
      xpAmount: number;
      rewardItemId: string;
      rewardQuantity: number;
      secondaryItemId?: string | null;
    },
  ): Promise<AtomicGatheringRewardReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const resourceId = String(input?.resourceId ?? "").trim();
    const depleteAfterCommit = input?.depleteAfterCommit === true;
    const respawnTicks = Number(input?.respawnTicks);
    const skill = String(input?.skill ?? "").trim() as GatheringRewardSkill;
    const xpAmount = Number(input?.xpAmount);
    const rewardItemId = String(input?.rewardItemId ?? "").trim();
    const rewardQuantity = Number(input?.rewardQuantity);
    const secondaryItemId = input?.secondaryItemId
      ? String(input.secondaryItemId).trim()
      : null;
    const rewardData = getItem(rewardItemId);
    const reward = rewardData
      ? {
          itemId: rewardItemId,
          quantity: rewardQuantity,
          stackable: rewardData.stackable === true,
        }
      : null;
    const failure = (
      reason: AtomicGatheringRewardFailureReason,
      retryable: boolean,
    ): AtomicGatheringRewardReceipt => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      replayed: false,
      skill: GATHERING_REWARD_SKILLS.has(skill) ? skill : null,
      xpAmount: Number.isFinite(xpAmount) ? xpAmount : 0,
      reward,
      secondaryItemId,
      retryable,
      reason,
    });

    if (
      !toPlayerID(normalizedPlayerId) ||
      !normalizedOperationId ||
      normalizedOperationId.length > 256 ||
      !resourceId ||
      resourceId.length > 256 ||
      !Number.isSafeInteger(respawnTicks) ||
      respawnTicks < 0 ||
      respawnTicks > 10_000_000 ||
      (depleteAfterCommit && respawnTicks <= 0) ||
      !GATHERING_REWARD_SKILLS.has(skill) ||
      !Number.isFinite(xpAmount) ||
      xpAmount <= 0 ||
      xpAmount > 1_000_000 ||
      !reward ||
      rewardItemId === "coins" ||
      !Number.isSafeInteger(rewardQuantity) ||
      rewardQuantity <= 0 ||
      rewardQuantity > this.MAX_QUANTITY ||
      (secondaryItemId !== null &&
        (!isValidItemID(secondaryItemId) ||
          !getItem(secondaryItemId) ||
          secondaryItemId === "coins"))
    ) {
      return failure("invalid_request", false);
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized", true);
    }
    const db = this.getDatabase();
    if (!db?.commitGatheringRewardOperationAsync) {
      return failure("atomic_persistence_unavailable", true);
    }

    let result: AtomicGatheringRewardReceipt = failure(
      "persistence_ambiguous",
      true,
    );
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy", true);
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          requestFingerprint = await sha256Hex(
            JSON.stringify({
              version: 2,
              playerId: normalizedPlayerId,
              resourceId,
              depleteAfterCommit,
              respawnTicks,
              skill,
              xpAmount,
              reward,
              secondaryItemId,
            }),
          );
        } catch {
          result = failure("atomic_persistence_unavailable", true);
          return false;
        }

        const request: GatheringRewardCommitRequest = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          resourceId,
          depleteAfterCommit,
          respawnTicks,
          skill,
          xpAmount,
          reward,
          secondaryItemId,
        };
        let receipt;
        try {
          receipt = await db.commitGatheringRewardOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryGatheringReward(firstError)) {
            const reason = gatheringRewardErrorReason(firstError);
            result = failure(reason, false);
            return false;
          }
          try {
            receipt = await db.commitGatheringRewardOperationAsync(request);
          } catch (retryError) {
            const reason = gatheringRewardErrorReason(retryError);
            Logger.systemError(
              "InventorySystem",
              `Atomic gathering reward is unresolved for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            result = failure(reason, reason === "persistence_ambiguous");
            return false;
          }
        }

        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.resourceId !== resourceId ||
          receipt.depleteAfterCommit !== depleteAfterCommit ||
          receipt.respawnTicks !== respawnTicks ||
          (receipt.depletedUntil !== null &&
            (!Number.isSafeInteger(receipt.depletedUntil) ||
              receipt.depletedUntil <= 0)) ||
          depleteAfterCommit !== (receipt.depletedUntil !== null) ||
          receipt.skill !== skill ||
          receipt.xpAmount !== xpAmount ||
          JSON.stringify(receipt.reward) !== JSON.stringify(reward) ||
          receipt.secondaryItemId !== secondaryItemId ||
          !Number.isFinite(receipt.operationCommittedXp) ||
          receipt.operationCommittedXp < receipt.awardedXp ||
          receipt.operationCommittedXp > MAX_SKILL_XP ||
          !Number.isFinite(receipt.awardedXp) ||
          receipt.awardedXp < 0 ||
          receipt.awardedXp > xpAmount ||
          !Number.isFinite(receipt.currentXp) ||
          receipt.currentXp < receipt.operationCommittedXp ||
          receipt.currentXp > MAX_SKILL_XP ||
          !Number.isSafeInteger(receipt.currentLevel) ||
          receipt.currentLevel !== exactSkillLevelForXp(receipt.currentXp)
        ) {
          result = failure("persistence_ambiguous", true);
          return false;
        }

        let liveInventoryApplied = this.applyCommittedInventorySnapshot(
          normalizedPlayerId,
          receipt.committed,
        );
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Gathering reward committed but live inventory convergence failed for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }

        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          playerId: normalizedPlayerId,
          operationId: normalizedOperationId,
          replayed: receipt.replayed,
          resourceId,
          depleteAfterCommit,
          respawnTicks,
          depletedUntil: receipt.depletedUntil,
          skill,
          xpAmount,
          reward,
          secondaryItemId,
          awardedXp: receipt.awardedXp,
          operationCommittedXp: receipt.operationCommittedXp,
          currentXp: receipt.currentXp,
          currentLevel: receipt.currentLevel,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  /**
   * Commit one recipe action without exposing a partial material debit,
   * product credit, or skill reward. A recipe may intentionally commit no
   * output and no XP (for example, a failed smelting roll), but it must still
   * consume at least one input. Item definitions loaded by DataManager remain
   * authoritative for output stackability and slot allocation.
   */
  async commitProcessingActionAtomic(
    playerId: string,
    operationId: string,
    input: {
      skill: ProcessingActionSkill;
      xpAmount: number;
      inputs: InventoryDebitRequirement[];
      requiredItems?: InventoryDebitRequirement[];
      consumables?: ProcessingActionConsumable[];
      outputs: Array<{ itemId: string; quantity: number }>;
      coinCost?: number;
      worldEffect?: ProcessingActionFireEffectRequest;
    },
  ): Promise<AtomicProcessingActionReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const skill = String(input?.skill ?? "").trim() as ProcessingActionSkill;
    const xpAmount = Number(input?.xpAmount);
    const coinCost = Number(input?.coinCost ?? 0);
    const rawWorldEffect = input?.worldEffect;
    const normalizedWorldEffect =
      rawWorldEffect === undefined
        ? undefined
        : normalizeProcessingFireEffectRequest(rawWorldEffect, skill);
    const worldEffectValid =
      rawWorldEffect === undefined || normalizedWorldEffect !== null;
    const worldEffect = normalizedWorldEffect ?? undefined;
    const inputs =
      normalizeDebitRequirements(input?.inputs ?? [], this.MAX_QUANTITY) ?? [];
    const requiredItems = normalizeOptionalDebitRequirements(
      input?.requiredItems ?? [],
      this.MAX_QUANTITY,
    );
    const consumables = normalizeProcessingConsumables(
      input?.consumables ?? [],
    );
    const outputTotals = new Map<string, number>();
    let outputsValid =
      Array.isArray(input?.outputs) && input.outputs.length <= 28;
    for (const raw of input?.outputs ?? []) {
      const itemId = String(raw?.itemId ?? "").trim();
      const quantity = Number(raw?.quantity);
      const item = getItem(itemId);
      if (
        !isValidItemID(itemId) ||
        itemId.length > 256 ||
        itemId === "coins" ||
        !item ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        quantity > this.MAX_QUANTITY
      ) {
        outputsValid = false;
        continue;
      }
      const combined = (outputTotals.get(itemId) ?? 0) + quantity;
      if (!Number.isSafeInteger(combined) || combined > this.MAX_QUANTITY) {
        outputsValid = false;
        continue;
      }
      outputTotals.set(itemId, combined);
    }
    const outputs: ProcessingActionItem[] = [...outputTotals.entries()]
      .map(([itemId, quantity]) => ({
        itemId,
        quantity,
        stackable: getItem(itemId)?.stackable === true,
      }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId));
    const failure = (
      reason: AtomicProcessingActionFailureReason,
      retryable: boolean,
    ): AtomicProcessingActionReceipt => ({
      ok: false,
      committed: false,
      liveInventoryApplied: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      replayed: false,
      skill: PROCESSING_ACTION_SKILLS.has(skill) ? skill : null,
      xpAmount: Number.isFinite(xpAmount) ? xpAmount : 0,
      inputs,
      requiredItems: requiredItems ?? [],
      consumables: consumables ?? [],
      consumableStates: [],
      outputs,
      ...(Number.isSafeInteger(coinCost) && coinCost > 0 ? { coinCost } : {}),
      ...(worldEffect ? { worldEffect } : {}),
      retryable,
      reason,
    });

    if (
      !toPlayerID(normalizedPlayerId) ||
      !normalizedOperationId ||
      normalizedOperationId.length > 256 ||
      !PROCESSING_ACTION_SKILLS.has(skill) ||
      !Number.isFinite(xpAmount) ||
      xpAmount < 0 ||
      xpAmount > 1_000_000 ||
      !Number.isSafeInteger(coinCost) ||
      coinCost < 0 ||
      coinCost > this.MAX_QUANTITY ||
      !worldEffectValid ||
      inputs.length === 0 ||
      !requiredItems ||
      !consumables ||
      !outputsValid ||
      outputs.length > 28
    ) {
      return failure("invalid_request", false);
    }
    if (!this.isInventoryReady(normalizedPlayerId)) {
      return failure("inventory_not_initialized", true);
    }
    const db = this.getDatabase();
    if (!db?.commitProcessingActionOperationAsync) {
      return failure("atomic_persistence_unavailable", true);
    }

    let result: AtomicProcessingActionReceipt = failure(
      "persistence_ambiguous",
      true,
    );
    await this.queueOperation(normalizedPlayerId, async () => {
      if (!this.lockForTransaction(normalizedPlayerId)) {
        result = failure("inventory_busy", true);
        return false;
      }
      try {
        let requestFingerprint: string;
        try {
          const fingerprintPayload: Record<string, unknown> = {
            version: 1,
            playerId: normalizedPlayerId,
            skill,
            xpAmount,
            inputs,
            outputs,
          };
          if (requiredItems.length > 0) {
            fingerprintPayload.requiredItems = requiredItems;
          }
          if (consumables.length > 0) {
            fingerprintPayload.consumables = consumables;
          }
          if (coinCost > 0) {
            fingerprintPayload.coinCost = coinCost;
          }
          if (worldEffect) {
            fingerprintPayload.worldEffect = worldEffect;
          }
          requestFingerprint = await sha256Hex(
            JSON.stringify(fingerprintPayload),
          );
        } catch {
          result = failure("atomic_persistence_unavailable", true);
          return false;
        }

        const request: ProcessingActionCommitRequest = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          requestFingerprint,
          skill,
          xpAmount,
          inputs,
          requiredItems,
          consumables,
          outputs,
          ...(coinCost > 0 ? { coinCost } : {}),
          ...(worldEffect ? { worldEffect } : {}),
        };
        let receipt;
        try {
          receipt = await db.commitProcessingActionOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryProcessingAction(firstError)) {
            result = failure(processingActionErrorReason(firstError), false);
            return false;
          }
          try {
            receipt = await db.commitProcessingActionOperationAsync(request);
          } catch (retryError) {
            const reason = processingActionErrorReason(retryError);
            Logger.systemError(
              "InventorySystem",
              `Atomic processing action is unresolved for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            result = failure(reason, reason === "persistence_ambiguous");
            return false;
          }
        }

        const consumableStates = normalizeProcessingConsumableStates(
          receipt.consumableStates,
          consumables,
        );
        const committedWorldEffect = normalizeCommittedProcessingFireEffect(
          receipt.worldEffect,
          worldEffect,
        );
        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receipt.skill !== skill ||
          receipt.xpAmount !== xpAmount ||
          JSON.stringify(receipt.inputs) !== JSON.stringify(inputs) ||
          JSON.stringify(receipt.requiredItems) !==
            JSON.stringify(requiredItems) ||
          JSON.stringify(receipt.consumables) !== JSON.stringify(consumables) ||
          !consumableStates ||
          committedWorldEffect === null ||
          JSON.stringify(receipt.outputs) !== JSON.stringify(outputs) ||
          Number(receipt.coinCost ?? 0) !== coinCost ||
          (coinCost > 0 &&
            (!Number.isSafeInteger(receipt.currentCoins) ||
              Number(receipt.currentCoins) < 0 ||
              Number(receipt.currentCoins) > this.MAX_QUANTITY)) ||
          !Number.isFinite(receipt.operationCommittedXp) ||
          receipt.operationCommittedXp < 0 ||
          receipt.operationCommittedXp > MAX_SKILL_XP ||
          !Number.isFinite(receipt.awardedXp) ||
          receipt.awardedXp < 0 ||
          receipt.awardedXp > xpAmount ||
          !Number.isFinite(receipt.currentXp) ||
          receipt.currentXp < receipt.operationCommittedXp ||
          receipt.currentXp > MAX_SKILL_XP ||
          !Number.isSafeInteger(receipt.currentLevel) ||
          receipt.currentLevel < 1 ||
          receipt.currentLevel > 99 ||
          receipt.currentLevel !== exactSkillLevelForXp(receipt.currentXp)
        ) {
          result = failure("persistence_ambiguous", true);
          return false;
        }

        let liveInventoryApplied = this.applyCommittedInventorySnapshot(
          normalizedPlayerId,
          receipt.committed,
        );
        if (!liveInventoryApplied) {
          try {
            await this.reloadFromDatabase(normalizedPlayerId);
            liveInventoryApplied = true;
          } catch (error) {
            Logger.systemError(
              "InventorySystem",
              `Processing action committed but live inventory convergence failed for ${normalizedPlayerId}: ${String(error)}`,
            );
          }
        }
        if (coinCost > 0) {
          const coinPouch = this.getCoinPouchSystem();
          const liveCoinsApplied =
            coinPouch?.applyCommittedBalance(
              normalizedPlayerId,
              Number(receipt.currentCoins),
            ) === true;
          liveInventoryApplied = liveInventoryApplied && liveCoinsApplied;
        }

        result = {
          ok: true,
          committed: true,
          liveInventoryApplied,
          playerId: normalizedPlayerId,
          operationId: normalizedOperationId,
          replayed: receipt.replayed,
          skill,
          xpAmount,
          inputs,
          requiredItems,
          consumables,
          consumableStates,
          outputs,
          ...(coinCost > 0
            ? {
                coinCost,
                currentCoins: Number(receipt.currentCoins),
              }
            : {}),
          ...(committedWorldEffect
            ? { worldEffect: committedWorldEffect }
            : {}),
          awardedXp: receipt.awardedXp,
          operationCommittedXp: receipt.operationCommittedXp,
          currentXp: receipt.currentXp,
          currentLevel: receipt.currentLevel,
        };
        return true;
      } finally {
        this.unlockTransaction(normalizedPlayerId);
      }
    });
    return result;
  }

  /**
   * Apply inventory rows that were already committed by the database's atomic
   * combat-loadout transaction. This never persists independently: doing so
   * would split inventory from equipment/autocast again. The caller must hold
   * this player's transaction lock for the complete commit-and-apply window.
   */
  applyCommittedCombatLoadoutInventory(
    playerId: string,
    rows: InventorySaveItem[],
  ): boolean {
    return this.applyCommittedInventorySnapshot(playerId, rows);
  }

  /** Apply an already committed inventory snapshot while its lock is held. */
  applyCommittedInventorySnapshot(
    playerId: string,
    rows: InventorySaveItem[],
  ): boolean {
    if (!this.isLockedForTransaction(playerId)) return false;
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return false;

    const seenSlots = new Set<number>();
    const items: PlayerInventory["items"] = [];
    for (const row of rows) {
      const slot = Number(row.slotIndex);
      const quantity = Number(row.quantity);
      const itemId = String(row.itemId ?? "").trim();
      const item = getItem(itemId);
      if (
        !Number.isSafeInteger(slot) ||
        slot < 0 ||
        slot >= this.MAX_INVENTORY_SLOTS ||
        seenSlots.has(slot) ||
        !itemId ||
        !item ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        quantity > this.MAX_QUANTITY
      ) {
        return false;
      }
      seenSlots.add(slot);
      items.push({ slot, itemId, quantity, item });
    }
    items.sort((a, b) => a.slot - b.slot);

    const inventory = this.getOrCreateInventory(playerIdKey);
    inventory.items = items;
    this.initializedInventories.add(playerId);
    this.emitInventoryUpdate(playerIdKey);
    return true;
  }

  /**
   * Check if a player's inventory is fully initialized and ready to use.
   * Returns false if the inventory is currently being loaded from the database.
   * Use this before responding to INVENTORY_REQUEST to avoid race conditions.
   */
  isInventoryReady(playerId: string): boolean {
    // If currently loading, not ready
    if (this.loadingInventories.has(playerId)) {
      return false;
    }
    // If explicitly initialized, it's ready
    if (this.initializedInventories.has(playerId)) {
      return true;
    }
    // If inventory exists in memory (auto-created or loaded), consider it ready
    const playerIdKey = toPlayerID(playerId);
    if (playerIdKey && this.playerInventories.has(playerIdKey)) {
      return true;
    }
    // Not loaded and not loading - needs initialization
    return false;
  }

  /**
   * Get CoinPouchSystem reference (lazy loaded)
   */
  private getCoinPouchSystem(): CoinPouchSystem | null {
    return this.world.getSystem<CoinPouchSystem>("coin-pouch") || null;
  }

  /**
   * Get inventory data formatted for UI display and network sync.
   *
   * Returns a cleaned InventoryData object with:
   * - Mapped item data (slot, itemId, quantity, item details)
   * - Current coin balance (from CoinPouchSystem)
   * - Maximum slot count
   *
   * @param playerId - The player ID to look up
   * @returns InventoryData object suitable for UI rendering
   *
   * @example
   * const data = inventorySystem.getInventoryData(playerId);
   * renderInventoryUI(data.items, data.coins, data.maxSlots);
   */
  getInventoryData(playerId: string): InventoryData {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) {
      Logger.systemError(
        "InventorySystem",
        `Invalid player ID in getInventoryData: "${playerId}"`,
        new Error(`Invalid player ID in getInventoryData: "${playerId}"`),
      );
      return { items: [], coins: 0, maxSlots: this.MAX_INVENTORY_SLOTS };
    }

    const inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) {
      return { items: [], coins: 0, maxSlots: this.MAX_INVENTORY_SLOTS };
    }

    // Get coins from CoinPouchSystem (source of truth)
    // If CoinPouchSystem hasn't initialized this player yet, fall back to inventory.coins
    const coinPouchSystem = this.getCoinPouchSystem();
    let coins: number;
    if (coinPouchSystem?.isPlayerInitialized(playerId)) {
      coins = coinPouchSystem.getCoins(playerId);
    } else {
      // Fallback: CoinPouchSystem not ready, use local inventory coins
      coins = inventory.coins ?? 0;
    }

    return {
      items: inventory.items.map((item) => ({
        slot: item.slot,
        itemId: item.itemId,
        quantity: item.quantity,
        item: {
          id: item.item.id,
          name: item.item.name,
          type: item.item.type,
          stackable: item.item.stackable ?? false,
          weight: item.item.weight ?? 0.1,
        },
      })),
      coins,
      maxSlots: this.MAX_INVENTORY_SLOTS,
    };
  }

  /**
   * Check if a player has at least a certain quantity of an item.
   *
   * For stackable items, checks the total quantity across all slots.
   * For non-stackable items, counts individual instances.
   * For coins, delegates to CoinPouchSystem.
   *
   * @param playerId - The player ID to check
   * @param itemId - The item ID to search for
   * @param quantity - Minimum quantity required (default: 1)
   * @returns true if player has at least the specified quantity
   *
   * @example
   * if (inventorySystem.hasItem(playerId, "logs", 5)) {
   *   // Player can craft a fire
   * }
   */
  hasItem(playerId: string, itemId: string, quantity: number = 1): boolean {
    // Validate IDs
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey || !isValidItemID(itemId)) {
      return false;
    }

    const inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) return false;

    // Delegate coin checks to CoinPouchSystem
    if (itemId === "coins") {
      const coinPouchSystem = this.getCoinPouchSystem();
      return coinPouchSystem?.hasCoins(playerId, quantity) ?? false;
    }

    const totalQuantity = inventory.items
      .filter((item) => item.itemId === itemId)
      .reduce((sum, item) => sum + item.quantity, 0);

    return totalQuantity >= quantity;
  }

  /**
   * Get the total quantity of a specific item in a player's inventory.
   *
   * Sums quantities across all slots for stackable items.
   * For non-stackable items, counts individual instances.
   * For coins, delegates to CoinPouchSystem.
   *
   * @param playerId - The player ID to check
   * @param itemId - The item ID to count
   * @returns Total quantity of the item (0 if none found)
   *
   * @example
   * const logCount = inventorySystem.getItemQuantity(playerId, "logs");
   * showMessage(`You have ${logCount} logs.`);
   */
  getItemQuantity(playerId: string, itemId: string): number {
    // Validate IDs
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey || !isValidItemID(itemId)) {
      return 0;
    }

    const inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) return 0;

    // Delegate coin queries to CoinPouchSystem
    if (itemId === "coins") {
      return this.getCoins(playerId);
    }

    return inventory.items
      .filter((item) => item.itemId === itemId)
      .reduce((sum, item) => sum + item.quantity, 0);
  }

  /**
   * Get player's coin balance.
   *
   * Delegates to CoinPouchSystem which is the source of truth
   * for all coin-related operations.
   *
   * @param playerId - The player ID to check
   * @returns Current coin balance (0 if not found)
   *
   * @see {@link CoinPouchSystem.getCoins}
   */
  getCoins(playerId: string): number {
    const coinPouchSystem = this.getCoinPouchSystem();
    if (coinPouchSystem?.isPlayerInitialized(playerId)) {
      return coinPouchSystem.getCoins(playerId);
    }
    // Fallback: check local inventory if CoinPouchSystem not ready
    const playerIdKey = toPlayerID(playerId);
    if (playerIdKey) {
      const inventory = this.playerInventories.get(playerIdKey);
      return inventory?.coins ?? 0;
    }
    return 0;
  }

  /**
   * Calculate the total weight of all items in a player's inventory.
   *
   * Multiplies each item's base weight by its quantity.
   * Used for encumbrance mechanics and carry capacity limits.
   *
   * @param playerId - The player ID to check
   * @returns Total weight in arbitrary units (0 if no inventory)
   *
   * @example
   * const weight = inventorySystem.getTotalWeight(playerId);
   * if (weight > MAX_CARRY_WEIGHT) {
   *   showMessage("You are overburdened!");
   * }
   */
  getTotalWeight(playerId: string): number {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return 0;
    const inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) return 0;

    return inventory.items.reduce((total, item) => {
      const itemData = getItem(item.itemId);
      return total + (itemData?.weight || 0) * item.quantity;
    }, 0);
  }

  /**
   * Check if a player's inventory has no empty slots.
   *
   * Note: This only checks slot count. Stackable items may still
   * be added to existing stacks even when inventory is "full".
   * Use {@link canAddItem} for complete space validation.
   *
   * @param playerId - The player ID to check
   * @returns true if all 28 inventory slots are occupied
   *
   * @example
   * if (inventorySystem.isFull(playerId)) {
   *   showMessage("Your inventory is full!");
   * }
   */
  isFull(playerId: string): boolean {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return false;
    const inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) return false;

    return inventory.items.length >= this.MAX_INVENTORY_SLOTS;
  }

  /**
   * Check if inventory has space for a given number of slots.
   * Used by EquipmentSystem to verify space before unequipping.
   *
   * @param playerId - The player ID to check
   * @param slotsNeeded - Number of slots needed (default 1)
   * @returns true if inventory has enough empty slots
   */
  hasSpace(playerId: string, slotsNeeded: number = 1): boolean {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return false;
    const inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) return true; // New inventory has space

    const usedSlots = inventory.items.length;
    const emptySlots = this.MAX_INVENTORY_SLOTS - usedSlots;
    return emptySlots >= slotsNeeded;
  }

  /**
   * Check if a specific item exists at a specific inventory slot.
   * Used by EquipmentSystem to verify item before equipping.
   *
   * @param playerId - The player ID
   * @param itemId - The item ID to check for
   * @param slot - The inventory slot to check
   * @returns true if the item exists at the specified slot
   */
  hasItemAtSlot(playerId: string, itemId: string, slot: number): boolean {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey || !isValidItemID(itemId)) return false;

    const inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) return false;

    const item = inventory.items.find((i) => i.slot === slot);
    return item !== undefined && item.itemId === itemId;
  }

  /**
   * Directly remove an item from inventory (synchronous, returns success).
   * Used by EquipmentSystem to ensure atomic equip operations.
   *
   * @param playerId - The player ID
   * @param params - Removal parameters (itemId, quantity, optional slot)
   * @returns true if removal succeeded, false otherwise
   */
  async removeItemDirect(
    playerId: string,
    params: { itemId: string; quantity: number; slot?: number },
    allowWhileTransactionLocked = false,
  ): Promise<boolean> {
    return this.removeItem(
      {
        playerId,
        itemId: params.itemId,
        quantity: params.quantity,
        slot: params.slot,
      },
      allowWhileTransactionLocked,
    );
  }

  /**
   * Directly add an item to inventory (synchronous, returns success).
   * Used by EquipmentSystem to ensure atomic unequip operations.
   *
   * @param playerId - The player ID
   * @param params - Add parameters (itemId, quantity)
   * @returns true if add succeeded, false otherwise
   */
  async addItemDirect(
    playerId: string,
    params: { itemId: string; quantity: number },
    allowWhileTransactionLocked = false,
  ): Promise<boolean> {
    if (this.transactionLocks.has(playerId) && !allowWhileTransactionLocked) {
      return false;
    }
    // Check if we can add
    if (!this.canAddItem(playerId, params.itemId, params.quantity)) {
      return false;
    }

    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey || !isValidItemID(params.itemId)) {
      return false;
    }

    const inventory = this.getOrCreateInventory(playerId);
    const itemData = getItem(params.itemId);
    if (!itemData) {
      return false;
    }

    // Find existing stack or empty slot
    if (itemData.stackable) {
      const existing = inventory.items.find((i) => i.itemId === params.itemId);
      if (existing) {
        existing.quantity = Math.min(
          existing.quantity + params.quantity,
          this.MAX_QUANTITY,
        );
        this.emitInventoryUpdate(playerIdKey);
        await this.persistInventoryImmediate(playerId);
        return true;
      }
    }

    // Find empty slot
    const usedSlots = new Set(inventory.items.map((i) => i.slot));
    let emptySlot = -1;
    for (let i = 0; i < this.MAX_INVENTORY_SLOTS; i++) {
      if (!usedSlots.has(i)) {
        emptySlot = i;
        break;
      }
    }

    if (emptySlot === -1) {
      return false; // No space
    }

    // Add item - use same format as other inventory add operations
    inventory.items.push({
      slot: emptySlot,
      itemId: params.itemId,
      quantity: params.quantity,
      item: itemData,
    });

    this.emitInventoryUpdate(playerIdKey);
    await this.persistInventoryImmediate(playerId);
    return true;
  }

  /**
   * Check if player is in death state (DYING or DEAD).
   *
   * Used to block item additions during death processing, which prevents
   * a race condition where items picked up between inventory snapshot
   * and inventory clear would persist after respawn.
   *
   * @param playerId - The player ID to check
   * @returns true if player is currently dying or dead
   */
  private isPlayerInDeathState(playerId: string): boolean {
    // Check player entity's death state (single source of truth)
    const playerEntity = this.world.entities?.get?.(playerId);
    if (playerEntity && "data" in playerEntity) {
      const data = playerEntity.data as { deathState?: DeathState };
      if (data?.deathState) {
        return (
          data.deathState === DeathState.DYING ||
          data.deathState === DeathState.DEAD
        );
      }
    }
    return false;
  }

  // Store system event handlers
  protected getOrCreateInventory(playerId: string): PlayerInventory {
    if (!playerId) {
      Logger.systemError(
        "InventorySystem",
        "Cannot create inventory for undefined playerId",
        new Error("Cannot create inventory for undefined playerId"),
      );
      return {
        playerId: "",
        items: [],
        coins: 0,
      };
    }

    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) {
      Logger.systemError(
        "InventorySystem",
        `Invalid player ID: ${playerId}`,
        new Error(`Invalid player ID: ${playerId}`),
      );
      return {
        playerId: "",
        items: [],
        coins: 0,
      };
    }

    let inventory = this.playerInventories.get(playerIdKey);
    if (!inventory) {
      // CRITICAL: Don't auto-create if inventory is currently being loaded from DB
      // This prevents race conditions where an empty inventory is created during async load
      if (this.loadingInventories.has(playerId)) {
        // Return empty placeholder - the real inventory is being loaded
        // Systems should not modify inventory during this brief window
        return {
          playerId,
          items: [],
          coins: 0,
        };
      }

      Logger.system(
        "InventorySystem",
        `Auto-initializing inventory for player ${playerId}`,
      );
      // Auto-initialize inventory if it doesn't exist
      inventory = {
        playerId,
        items: [],
        coins: 100, // Starting coins per GDD
      };
      this.playerInventories.set(playerIdKey, inventory);
      this.initializedInventories.add(playerId);

      // Add starter equipment for auto-initialized players if enabled
      const enableStarter =
        typeof process !== "undefined" &&
        process.env &&
        process.env.PUBLIC_STARTER_ITEMS === "1";
      if (enableStarter) this.addStarterEquipment(playerIdKey);
    }
    return inventory;
  }

  // === Persistence helpers ===
  private getDatabase(): DatabaseSystem | null {
    return this.world.getSystem<DatabaseSystem>("database") || null;
  }

  /**
   * Load inventory from event payload data (single source of truth pattern)
   *
   * Called when PLAYER_JOINED event includes inventory data from character-selection.
   * This eliminates the race condition where InventorySystem and character-selection
   * both query the database independently, potentially causing stale data.
   *
   * @param playerId - The player ID
   * @param inventoryData - Inventory data from event payload
   */
  private async loadInventoryFromPayload(
    playerId: string,
    inventoryData: InventorySyncData[],
  ): Promise<void> {
    // Mark as loading to prevent race conditions
    this.loadingInventories.add(playerId);

    try {
      const pid = createPlayerID(playerId);
      let inv = this.playerInventories.get(pid);

      if (!inv) {
        inv = {
          playerId: pid,
          items: [],
          coins: 0,
        };
        this.playerInventories.set(pid, inv);
      } else {
        // Clear existing items before loading from payload
        inv.items = [];
      }

      // Use silent mode to batch load without emitting updates for each item
      for (const row of inventoryData) {
        await this.addItem({
          playerId,
          itemId: createItemID(String(row.itemId)),
          quantity: row.quantity || 1,
          slot: row.slotIndex,
          silent: true, // Don't emit updates during batch load
        });
      }

      // Mark as fully initialized before emitting event
      this.initializedInventories.add(playerId);
      this.loadingInventories.delete(playerId);

      const data = this.getInventoryData(playerId);
      this.emitTypedEvent(EventType.INVENTORY_INITIALIZED, {
        playerId,
        inventory: {
          items: data.items.map((item) => ({
            slot: item.slot,
            itemId: item.itemId,
            quantity: item.quantity,
            item: {
              id: item.item.id,
              name: item.item.name,
              type: item.item.type,
              stackable: item.item.stackable,
              weight: item.item.weight,
            },
          })),
          coins: data.coins,
          maxSlots: data.maxSlots,
        },
      });

      // Emit initial weight for stamina drain calculations
      const totalWeight = this.getTotalWeight(playerId);
      this.emitTypedEvent(EventType.PLAYER_WEIGHT_CHANGED, {
        playerId,
        weight: totalWeight,
      });
    } catch (error) {
      this.loadingInventories.delete(playerId);
      throw error;
    }
  }

  private async loadPersistedInventoryAsync(
    playerId: string,
  ): Promise<boolean> {
    // Mark inventory as loading to prevent race conditions with INVENTORY_REQUEST
    this.loadingInventories.add(playerId);

    try {
      const db = this.getDatabase();
      if (!db) {
        this.loadingInventories.delete(playerId);
        return false;
      }

      const rows = await db.getPlayerInventoryAsync(playerId);
      const playerRow = await db.getPlayerAsync(playerId);

      const hasState = (rows && rows.length > 0) || !!playerRow;
      if (!hasState) {
        this.loadingInventories.delete(playerId);
        return false;
      }

      const pid = createPlayerID(playerId);
      const inv: PlayerInventory = {
        playerId: pid,
        items: [],
        coins: playerRow?.coins ?? 0,
      };
      this.playerInventories.set(pid, inv);

      // Use silent mode to batch load without emitting updates for each item
      // A single INVENTORY_INITIALIZED event is emitted at the end
      for (const row of rows) {
        // Strong type assumption - row.slotIndex is number from database schema
        const slot = row.slotIndex ?? undefined;
        await this.addItem({
          playerId,
          itemId: createItemID(String(row.itemId)),
          quantity: row.quantity || 1,
          slot,
          silent: true, // Don't emit updates during batch load
        });
      }

      // Mark as fully initialized before emitting event
      this.initializedInventories.add(playerId);
      this.loadingInventories.delete(playerId);

      const data = this.getInventoryData(playerId);
      this.emitTypedEvent(EventType.INVENTORY_INITIALIZED, {
        playerId,
        inventory: {
          items: data.items.map((item) => ({
            slot: item.slot,
            itemId: item.itemId,
            quantity: item.quantity,
            item: {
              id: item.item.id,
              name: item.item.name,
              type: item.item.type,
              stackable: item.item.stackable,
              weight: item.item.weight,
            },
          })),
          coins: data.coins,
          maxSlots: data.maxSlots,
        },
      });

      // Emit initial weight for stamina drain calculations
      const totalWeight = this.getTotalWeight(playerId);
      this.emitTypedEvent(EventType.PLAYER_WEIGHT_CHANGED, {
        playerId,
        weight: totalWeight,
      });

      return true;
    } catch (error) {
      this.loadingInventories.delete(playerId);
      throw error;
    }
  }

  private loadPersistedInventory(_playerId: string): boolean {
    // This is now a sync wrapper that always returns false to trigger async load
    // The actual loading happens in the async init flow
    return false;
  }

  /**
   * Persist inventory immediately without debounce.
   * Concurrent calls for the same player are serialized by DatabaseSystem's
   * per-player write lock, preventing PostgreSQL deadlocks.
   */
  async persistInventoryImmediate(playerId: string): Promise<void> {
    const db = this.getDatabase();
    if (!db) {
      console.warn(
        `[InventorySystem] Cannot persist inventory for ${playerId}: no database`,
      );
      return;
    }

    const inv = this.getOrCreateInventory(playerId);
    const saveItems = inv.items.map((i) => ({
      itemId: i.itemId,
      quantity: i.quantity,
      slotIndex: i.slot,
      metadata: null as null,
    }));

    // Await ensures DB is updated before callers proceed (e.g., bank transactions).
    // Per-player write lock in DatabaseSystem prevents concurrent transaction deadlocks.
    // No player-exists check needed — the repository upsert is harmless for missing players.
    await db.savePlayerInventoryAsync(playerId, saveItems);
    // NOTE: Coins are now persisted by CoinPouchSystem
  }

  /**
   * Persist an empty inventory directly to the database, bypassing
   * persistInventoryImmediate. Used by death handlers where we must
   * await the DB write to prevent item duplication exploits — the
   * inventory is already cleared in memory so we send an empty array
   * rather than re-reading the (now empty) in-memory state.
   */
  private async persistEmptyInventory(playerId: string): Promise<void> {
    const db = this.getDatabase();
    if (!db) return;

    // No player-exists check needed — deleting inventory for a missing player is a no-op.
    await db.savePlayerInventoryAsync(playerId, []);
  }

  /**
   * Clear inventory immediately with instant DB persist
   * CRITICAL for death system to prevent duplication
   */
  async clearInventoryImmediate(
    playerId: string,
    skipPersist?: boolean,
  ): Promise<number> {
    const playerID = createPlayerID(playerId);
    const inventory = this.getOrCreateInventory(playerID);

    const droppedItemCount = inventory.items.length;

    // Clear the inventory (classic fantasy MMORPG-style: all items go to gravestone)
    inventory.items = [];
    // NOTE: Coins are protected and remain in coin pouch (classic fantasy MMORPG-style)

    // CRITICAL: Update UI by emitting inventory update event
    this.emitInventoryUpdate(playerID);

    // When called inside a DB transaction, skip independent persist to maintain
    // atomicity — caller is responsible for persisting after transaction commits
    if (!skipPersist) {
      // CRITICAL: Must await to prevent duplication exploits on death
      await this.persistEmptyInventory(playerId);
    }

    return droppedItemCount;
  }

  private handleCanAdd(data: InventoryCanAddEvent): void {
    Logger.system(
      "InventorySystem",
      `Checking if player ${data.playerId} can add item`,
      { item: data.item },
    );
    const inventory = this.getOrCreateInventory(data.playerId);

    // Check if inventory has space
    const hasSpace = inventory.items.length < this.MAX_INVENTORY_SLOTS;

    // If stackable, check if we can stack with existing item
    if (data.item.stackable) {
      const existingItem = inventory.items.find(
        (item) => item.itemId === data.item.id,
      );
      if (existingItem) {
        Logger.system(
          "InventorySystem",
          "Can stack with existing item, space available: true",
        );
        data.callback(true);
        return;
      }
    }

    Logger.system(
      "InventorySystem",
      `Has space: ${hasSpace}, slots used: ${inventory.items.length}/${this.MAX_INVENTORY_SLOTS}`,
    );
    data.callback(hasSpace);
  }

  // NOTE: handleRemoveCoins() removed - now handled by CoinPouchSystem

  private handleInventoryCheck(data: InventoryCheckEvent): void {
    Logger.system(
      "InventorySystem",
      `Checking inventory for player ${data.playerId}, item ${data.itemId}, quantity ${data.quantity}`,
    );

    const itemId = String(data.itemId);
    const item = getItem(itemId);

    if (!item) {
      Logger.system(
        "InventorySystem",
        `Item ${itemId} not found in item database`,
      );
      data.callback(false, null);
      return;
    }

    const hasItem = this.hasItem(data.playerId, itemId, data.quantity);
    Logger.system("InventorySystem", `Player has item: ${hasItem}`);

    if (!hasItem) {
      data.callback(false, null);
      return;
    }

    // Find the inventory item
    const inventory = this.getOrCreateInventory(data.playerId);
    const inventoryItem = inventory.items.find((i) => i.itemId === itemId);

    const inventorySlot: InventoryItemInfo | null = inventoryItem
      ? {
          id: inventoryItem.itemId,
          quantity: inventoryItem.quantity,
          name: item.name,
          stackable: item.stackable ?? false,
          slot: inventoryItem.slot.toString(),
        }
      : null;

    data.callback(hasItem, inventorySlot);
  }

  private async handleInventoryAdd(
    data: InventoryItemAddedPayload,
  ): Promise<void> {
    // Validate the event data exists
    if (!data) {
      Logger.systemError(
        "InventorySystem",
        "handleInventoryAdd: data is undefined",
        new Error("handleInventoryAdd: data is undefined"),
      );
      return;
    }

    if (!data.item) {
      Logger.systemError(
        "InventorySystem",
        "handleInventoryAdd: data.item is undefined",
        new Error("handleInventoryAdd: data.item is undefined"),
      );
      return;
    }

    const playerId = data.playerId;
    const itemId = data.item.itemId;
    const quantity = data.item.quantity;
    // Extract slot if provided (used by bank sync to maintain slot consistency)
    const slot =
      typeof data.item.slot === "number" ? data.item.slot : undefined;

    // Validate the event data before processing
    if (!playerId) {
      Logger.systemError(
        "InventorySystem",
        "handleInventoryAdd: playerId is missing",
        new Error("handleInventoryAdd: playerId is missing"),
      );
      return;
    }

    if (!itemId) {
      Logger.systemError(
        "InventorySystem",
        "handleInventoryAdd: itemId is missing",
        new Error("handleInventoryAdd: itemId is missing"),
      );
      return;
    }

    // Strong type assumption - quantity is number from typed event payload
    if (!quantity || quantity <= 0) {
      Logger.systemError(
        "InventorySystem",
        "handleInventoryAdd: invalid quantity",
        new Error("handleInventoryAdd: invalid quantity"),
      );
      return;
    }

    // Pass slot to addItem for proper sync (e.g., from bank withdrawal)
    await this.addItem({ playerId, itemId, quantity, slot });
  }

  /**
   * Get skill data for a specific skill
   * Returns null if the skill doesn't exist or player has no data
   */
  getSkillData(
    _playerId: string,
    _skillName: string,
  ): { xp: number; level: number } | null {
    // For now, return default skill data
    // This would normally be stored with player data
    const defaultSkillData = {
      xp: 0,
      level: 1,
    };
    return defaultSkillData;
  }

  /**
   * Spawn an item in the world (for tests)
   * This is a test helper method
   */
  async spawnItem(
    itemId: string,
    position: { x: number; y: number; z: number },
    quantity: number,
  ): Promise<void> {
    // Emit event to spawn the item in the world
    this.emitTypedEvent(EventType.ITEM_SPAWN, {
      itemId,
      position,
      quantity,
    });
  }

  /**
   * Async destroy - properly awaits all database saves before cleanup.
   * Call this for graceful shutdown to prevent data loss.
   */
  async destroyAsync(): Promise<void> {
    this.isDestroying = true;
    // Final save pass for all connected players before shutdown
    if (this.world.isServer) {
      const db = this.getDatabase();
      if (db) {
        const savePromises: Promise<void>[] = [];

        for (const playerId of this.playerInventories.keys()) {
          // Create save promise for each player
          const savePromise = (async () => {
            const row = await db.getPlayerAsync(playerId);
            if (!row) return;

            const inv = this.getOrCreateInventory(playerId);
            const saveItems = inv.items.map((i) => ({
              itemId: i.itemId,
              quantity: i.quantity,
              slotIndex: i.slot,
              metadata: null as null,
            }));
            await db.savePlayerInventoryAsync(playerId, saveItems);
            // NOTE: Coins are now persisted by CoinPouchSystem
          })();

          savePromises.push(savePromise);
        }

        // Wait for all saves to complete (with error handling)
        const results = await Promise.allSettled(savePromises);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          Logger.systemError(
            "InventorySystem",
            `${failures.length} inventory saves failed during shutdown`,
            new Error("Partial save failure on shutdown"),
          );
        }
      }
    }

    // Clear all player inventories on system shutdown
    this.playerInventories.clear();
    // Call parent cleanup (handles event listeners, timers, etc.)
    super.destroy();
  }

  destroy(): void {
    // Fire-and-forget async cleanup (best effort for non-async callers)
    this.destroyAsync().catch((err) => {
      Logger.systemError(
        "InventorySystem",
        "Error during async destroy",
        err instanceof Error ? err : new Error(String(err)),
      );
    });
  }
}
