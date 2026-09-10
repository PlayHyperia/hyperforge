/**
 * Equipment System
 * Handles equipment management, stat bonuses, level requirements, and persistence per GDD specifications
 * - Equipment slots (weapon, shield, helmet, body, legs, boots, gloves, cape, amulet, ring, arrows)
 * - Level requirements for equipment tiers
 * - Stat bonuses from equipped items
 * - Right-click equip/unequip functionality
 * - Write-through database persistence
 */

import { EventType, type EquipmentSyncData } from "../../../types/events";
import { dataManager } from "../../../data/DataManager";
import { COMBAT_SPELLS } from "../../../data/combat-spells";
import { ammunitionService } from "../combat/AmmunitionService";
import { runeService } from "../combat/RuneService";
import type { InventorySystem } from "./InventorySystem";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import { EQUIPMENT_SLOT_NAMES } from "../../../constants/EquipmentConstants";
import { BANKING_CONSTANTS } from "../../../constants/BankingConstants";

/**
 * Helper functions for equipment requirements
 * Uses manifest-driven data from DataManager.
 */
const equipmentRequirements = {
  /**
   * Get skill requirements for an item from the manifest.
   * Returns object like { attack: 10 } or { woodcutting: 1, attack: 1 }
   */
  getLevelRequirements: (itemId: string): Record<string, number> | null => {
    const item = dataManager.getItem(itemId);
    return item?.requirements?.skills || null;
  },

  /**
   * Format requirements as human-readable text.
   * e.g., "Attack 10" or "Woodcutting 1, Attack 1"
   */
  getRequirementText: (itemId: string): string => {
    const reqs = equipmentRequirements.getLevelRequirements(itemId);
    if (!reqs) return "";
    return Object.entries(reqs)
      .filter(([, level]) => level > 0)
      .map(
        ([skill, level]) =>
          `${skill.charAt(0).toUpperCase() + skill.slice(1)} ${level}`,
      )
      .join(", ");
  },
};

/** Manifest armor data uses `defence`; live skill state uses `defense`. */
function normalizeEquipmentRequirementSkill(skill: string): string {
  return skill === "defence" ? "defense" : skill;
}
import { SystemBase } from "../infrastructure/SystemBase";
import type { WorldOptions } from "../../../types";
import { Logger } from "../../../utils/Logger";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import type { TransactionContext } from "../../../types/death";
import type {
  BankSaveItem,
  CombatLoadoutPersistenceSnapshot,
  DuelPreparationPlanPersistenceSnapshot,
  DuelPreparationPlanRecoveryEvidence,
  EquipmentSaveItem,
  AmmunitionRecoveryDisposition,
  AmmunitionShotOperationStatus,
  AmmunitionShotCommitRequest,
  AmmunitionShotSettlementHandle,
  GroundItemSourceRegistrationReceipt,
  InventorySaveItem,
} from "../../../types/network/database";
import {
  ammunitionShotIdentityFromRequest,
  serializeAmmunitionShotFingerprint,
} from "../../../utils/game/AmmunitionShotRegistration";
import { serializeGroundItemSourceRegistrationFingerprint } from "../../../utils/game/GroundItemSourceRegistration";
import {
  parseStreamingDuelRoleSwitchObservationContext,
  type StreamingDuelRoleSwitchObservationContext,
} from "../../../types/game/streaming-duel-action-observation";
import { uuid } from "../../../utils/IdGenerator";

import { World } from "../../../core/World";
import {
  ItemType,
  EquipmentSlot,
  EquipmentSlotName,
  PlayerEquipment as PlayerEquipment,
  Item,
} from "../../../types/core/core";

// Re-export for backward compatibility
export type { EquipmentSlot, PlayerEquipment };

export type EquipmentActionFailureReason =
  | "player_missing"
  | "equipment_not_initialized"
  | "item_not_found"
  | "not_equippable"
  | "requirements_not_met"
  | "item_not_owned"
  | "equip_rejected"
  | "unequip_rejected";

/**
 * Authoritative acknowledgement for an owned-item equipment request.
 * Agent planners must consume this receipt instead of assuming that emitting an
 * asynchronous equipment event changed the loadout.
 */
export interface EquipmentActionReceipt {
  ok: boolean;
  playerId: string;
  itemId: string;
  slot: string | null;
  changed: boolean;
  reason?: EquipmentActionFailureReason;
}

export interface OwnedDuelPreparationPlanRequest {
  operationId: string;
  preparationId: string;
  /** Exact bank snapshot returned by the durable private preparation open. */
  expectedBank: BankSaveItem[];
  /** Exact final custody state selected by the deterministic/model planner. */
  committed: DuelPreparationPlanPersistenceSnapshot;
  /** Public strategy evidence needed to resume readiness after process loss. */
  recoveryEvidence: DuelPreparationPlanRecoveryEvidence;
}

export interface OwnedDuelPreparationPlanRecoveryRequest {
  operationId: string;
  preparationId: string;
}

export type OwnedDuelPreparationPlanFailureReason =
  | "player_missing"
  | "equipment_not_initialized"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "equipment_system_unavailable"
  | "atomic_persistence_unavailable"
  | "preparation_capability_unavailable"
  | "plan_invalid"
  | "custody_violation"
  | "persistence_failed"
  | "committed_state_apply_failed";

export type OwnedDuelPreparationPlanReceipt =
  | {
      ok: true;
      playerId: string;
      operationId: string;
      preparationId: string;
      requestFingerprint: string;
      changed: boolean;
      replayed: boolean;
      committed: DuelPreparationPlanPersistenceSnapshot;
      recoveryEvidence: DuelPreparationPlanRecoveryEvidence;
    }
  | {
      ok: false;
      playerId: string;
      operationId: string;
      preparationId: string;
      changed: false;
      replayed: false;
      reason: OwnedDuelPreparationPlanFailureReason;
    };

export type SwitchableCombatRole = "melee" | "ranged" | "mage";

export const FROZEN_COMBAT_ARMOR_SLOTS = [
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
  "amulet",
  "ring",
] as const;
export type FrozenCombatArmorSlot = (typeof FROZEN_COMBAT_ARMOR_SLOTS)[number];
export type FrozenCombatArmorIds = Record<FrozenCombatArmorSlot, string | null>;

/** Exact bettor-visible item allowlist for one combat role. */
export interface FrozenCombatLoadoutDefinition {
  role: SwitchableCombatRole;
  weaponId: string;
  arrowsId: string | null;
  shieldId: string | null;
  spellId: string | null;
  /** Present on schema-v3 snapshots; omitted only for legacy frozen cycles. */
  armorIds?: FrozenCombatArmorIds;
}

export interface FrozenCombatLoadoutSwitchRequest {
  operationId: string;
  requestFingerprint: string;
  targetRole: SwitchableCombatRole;
  allowedLoadouts: Partial<
    Record<SwitchableCombatRole, FrozenCombatLoadoutDefinition>
  >;
  publicActionObservation?: StreamingDuelRoleSwitchObservationContext;
}

export type FrozenCombatLoadoutSwitchFailureReason =
  | "player_missing"
  | "equipment_not_initialized"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "target_not_frozen"
  | "target_loadout_invalid"
  | "target_item_not_owned"
  | "inventory_capacity_exceeded"
  | "persistence_failed"
  | "committed_state_apply_failed";

export interface FrozenCombatLoadoutSwitchReceipt {
  ok: boolean;
  playerId: string;
  operationId: string;
  targetRole: SwitchableCombatRole;
  changed: boolean;
  replayed: boolean;
  reason?: FrozenCombatLoadoutSwitchFailureReason;
}

export type AtomicArrowDebitFailureReason =
  | "invalid_request"
  | "equipment_not_initialized"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "insufficient_items"
  | "persistence_failed"
  | "committed_state_apply_failed";

export type AtomicArrowDebitReceipt =
  | {
      ok: true;
      playerId: string;
      operationId: string;
      arrowId: string;
      changed: true;
      replayed: boolean;
    }
  | {
      ok: false;
      playerId: string;
      operationId: string;
      arrowId: string;
      changed: false;
      replayed: false;
      reason: AtomicArrowDebitFailureReason;
    };

export type AtomicAmmunitionShotReceipt =
  | {
      ok: true;
      playerId: string;
      operationId: string;
      arrowId: string;
      changed: true;
      replayed: boolean;
      requestFingerprint: string;
      status: AmmunitionShotOperationStatus;
      recoveryDisposition: AmmunitionRecoveryDisposition;
      recoverySource: GroundItemSourceRegistrationReceipt | null;
    }
  | {
      ok: false;
      playerId: string;
      operationId: string;
      arrowId: string;
      changed: false;
      replayed: false;
      reason: AtomicArrowDebitFailureReason;
    };

async function equipmentDebitSha256Hex(value: string): Promise<string> {
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

function equipmentStackDebitFailureReason(
  error: unknown,
): AtomicArrowDebitFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("equipment_stack_debit_insufficient_items") ||
    message.includes("ammunition_shot_insufficient_items")
  ) {
    return "insufficient_items";
  }
  if (
    message.includes("equipment_stack_debit_request_invalid") ||
    message.includes("equipment_stack_debit_operation_id_conflict") ||
    message.includes("equipment_stack_debit_player_missing") ||
    message.includes("ammunition_shot_request_invalid") ||
    message.includes("ammunition_shot_operation_id_conflict") ||
    message.includes("ammunition_shot_player_missing")
  ) {
    return "invalid_request";
  }
  return "persistence_failed";
}

function shouldRetryEquipmentStackDebit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ![
    "equipment_stack_debit_request_invalid",
    "equipment_stack_debit_operation_id_conflict",
    "equipment_stack_debit_player_missing",
    "equipment_stack_debit_insufficient_items",
    "equipment_stack_debit_equipment_invalid",
  ].some((code) => message.includes(code));
}

function shouldRetryAmmunitionShotCommit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ![
    "ammunition_shot_request_invalid",
    "ammunition_shot_operation_id_conflict",
    "ammunition_shot_player_missing",
    "ammunition_shot_insufficient_items",
    "ammunition_shot_equipment_invalid",
    "ammunition_shot_source_preexisting",
    "ammunition_shot_source_receipt_invalid",
  ].some((code) => message.includes(code));
}

function shouldRetryDuelPreparationPlanCommit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ![
    "duel_preparation_plan_database_unavailable",
    "duel_preparation_plan_request_invalid",
    "duel_preparation_plan_snapshot_invalid",
    "duel_preparation_plan_bank_invalid",
    "duel_preparation_plan_custody_violation",
    "duel_preparation_plan_player_missing",
    "duel_preparation_plan_operation_id_conflict",
    "duel_preparation_plan_preparation_not_found",
    "duel_preparation_plan_database_clock_invalid",
    "duel_preparation_plan_preparation_expired",
    "duel_preparation_plan_preparation_not_active",
    "duel_preparation_plan_agent_mismatch",
    "duel_preparation_plan_agent_ready",
    "duel_preparation_plan_action_not_allowed",
    "duel_preparation_plan_metadata_invalid",
    "duel_preparation_plan_state_conflict",
    "combat_loadout_",
  ].some((code) => message.includes(code));
}

/**
 * A contestant's sibling preparation can fail while this agent is committing
 * its own plan. Cancellation then wins the database lock and the in-flight
 * commit observes an inactive/expired preparation. That is an expected
 * capability-revocation race, not a persistence outage and not retryable.
 */
function isDuelPreparationCapabilityRevoked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "duel_preparation_plan_preparation_expired",
    "duel_preparation_plan_preparation_not_active",
    "duel_preparation_plan_agent_ready",
  ].some((code) => message.includes(code));
}

function canonicalDuelPreparationRecoveryEvidence(
  value: unknown,
): string | null {
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const canonical = canonicalize(value, 0);
  return canonical && canonical.length <= 32_768 ? canonical : null;
}

type CombatCustodyItem = {
  itemId: string;
  quantity: number;
  preferredInventorySlot: number | null;
};

/** Create a zeroed-out equipment stats object (all 16 fields = 0) */
function createEmptyTotalStats(): PlayerEquipment["totalStats"] {
  return {
    attack: 0,
    strength: 0,
    defense: 0,
    ranged: 0,
    constitution: 0,
    rangedAttack: 0,
    rangedStrength: 0,
    magicAttack: 0,
    magicDefense: 0,
    defenseStab: 0,
    defenseSlash: 0,
    defenseCrush: 0,
    defenseRanged: 0,
    attackStab: 0,
    attackSlash: 0,
    attackCrush: 0,
  };
}

/**
 * Equipment System - GDD Compliant
 * Manages player equipment per GDD specifications:
 * - 11 equipment slots (weapon, shield, helmet, body, legs, boots, gloves, cape, amulet, ring, arrows)
 * - Level requirements (bronze=1, steel=10, mithril=20)
 * - Automatic stat calculation from equipped items
 * - Arrow consumption integration with combat
 * - Equipment persistence via inventory system
 */
export class EquipmentSystem extends SystemBase {
  private playerEquipment = new Map<string, PlayerEquipment>();
  private playerSkills = new Map<
    string,
    Record<string, { level: number; xp: number }>
  >();
  /** Prevent duplicate save/cleanup when unregister and leave fire back-to-back. */
  private equipmentCleanupInFlight = new Set<string>();
  /**
   * An allocated slot map is not proof that persisted equipment has finished
   * hydrating. PLAYER_REGISTERED deliberately allocates an empty map while the
   * earlier PLAYER_JOINED database read may still be in flight, so competitive
   * custody must use this explicit readiness boundary instead of map presence.
   */
  private readyPlayerEquipment = new Set<string>();
  private equipmentHydrationGeneration = new Map<string, number>();
  /**
   * Order every equipment-table writer for one player, including whole-plan
   * commits and recovery. A normal equip save captured before a competitive
   * plan must finish before that plan becomes the final durable projection.
   */
  private equipmentPersistenceTails = new Map<string, Promise<void>>();
  /**
   * A durable combat receipt may finish after the player has begun unloading.
   * Keep a tombstone until the next join so that receipt convergence never
   * recreates a ghost equipment/inventory projection during that boundary.
   */
  private unloadedPlayerEquipment = new Set<string>();
  private isDestroying = false;
  private databaseSystem?: DatabaseSystem;

  // GDD-compliant level requirements
  // Level requirements are now stored in item data directly

  constructor(world: World) {
    super(world, {
      name: "equipment",
      dependencies: {
        required: [
          "inventory", // Equipment needs inventory for item management
        ],
        optional: [
          "player", // Better with player system for player data
          "ui", // Better with UI for notifications
          "database", // For persistence
        ],
      },
      autoCleanup: true,
    });
  }

  async init(_options?: WorldOptions): Promise<void> {
    // Get DatabaseSystem for persistence
    this.databaseSystem = this.world.getSystem("database") as
      DatabaseSystem | undefined;

    if (!this.databaseSystem && this.world.isServer) {
      Logger.systemWarn(
        "EquipmentSystem",
        "DatabaseSystem not found - equipment will not persist!",
      );
    }

    // Set up type-safe event subscriptions with proper type casting
    this.subscribe(EventType.PLAYER_REGISTERED, (data) => {
      const typedData = data as { playerId: string };
      this.unloadedPlayerEquipment.delete(typedData.playerId);
      this.initializePlayerEquipment({ id: typedData.playerId });
    });
    // CRITICAL: Equipment is now passed via event payload from character-selection
    // This eliminates the race condition where two systems query DB independently
    this.subscribe(EventType.PLAYER_JOINED, async (data) => {
      const typedData = data as {
        playerId: string;
        equipment?: EquipmentSyncData[];
        isReconnect?: boolean;
      };
      this.unloadedPlayerEquipment.delete(typedData.playerId);
      // PLAYER_JOINED can precede PLAYER_REGISTERED for embedded agents. Own
      // the slot allocation here so a synchronous payload load cannot race the
      // later registration event or silently discard authoritative equipment.
      this.initializePlayerEquipment({ id: typedData.playerId });
      const hydrationGeneration = this.beginEquipmentHydration(
        typedData.playerId,
      );
      let hydrationSucceeded = false;

      try {
        // On reconnection, equipment is already in memory — just re-send to client
        // This prevents stale DB data from overwriting current in-memory equipment
        if (
          typedData.isReconnect &&
          this.playerEquipment.has(typedData.playerId)
        ) {
          this.sendEquipmentUpdated(typedData.playerId);
          this.emitEquipmentChangedForAllSlots(typedData.playerId);
          hydrationSucceeded = true;
          return;
        }

        // Use equipment from payload (single source of truth from character-selection)
        if (typedData.equipment) {
          hydrationSucceeded = await this.loadEquipmentFromPayload(
            typedData.playerId,
            typedData.equipment,
            hydrationGeneration,
          );
        } else {
          // Backwards compatibility: no equipment in payload, fall back to DB query
          hydrationSucceeded = await this.loadEquipmentFromDatabase(
            typedData.playerId,
            false,
            hydrationGeneration,
          );
        }
      } finally {
        this.completeEquipmentHydration(
          typedData.playerId,
          hydrationGeneration,
          hydrationSucceeded,
        );
      }
    });
    this.subscribe(EventType.PLAYER_RESPAWNED, async (data) => {
      const typedData = data as { playerId: string };
      // Reload equipment from database after respawn (equipment cleared on death)
      await this.reloadFromDatabase(typedData.playerId);
    });
    this.subscribe(EventType.PLAYER_UNREGISTERED, async (data) => {
      const typedData = data as { playerId: string };
      const { playerId } = typedData;
      if (this.equipmentCleanupInFlight.has(playerId)) return;
      this.unloadedPlayerEquipment.add(playerId);
      this.equipmentCleanupInFlight.add(playerId);
      try {
        if (this.playerEquipment.has(playerId)) {
          await this.saveEquipmentToDatabase(playerId);
        }
      } finally {
        this.cleanupPlayerEquipment(playerId);
        this.equipmentCleanupInFlight.delete(playerId);
      }
    });
    this.subscribe(EventType.PLAYER_LEFT, async (data) => {
      const typedData = data as { playerId: string };
      if (
        this.equipmentCleanupInFlight.has(typedData.playerId) ||
        !this.playerEquipment.has(typedData.playerId)
      ) {
        return;
      }
      await this.saveEquipmentToDatabase(typedData.playerId);
    });

    // Listen to skills updates for reactive patterns
    this.subscribe(EventType.SKILLS_UPDATED, (data) => {
      const typedData = data as {
        playerId: string;
        skills: Record<string, { level: number; xp: number }>;
      };
      this.playerSkills.set(typedData.playerId, typedData.skills);
    });
    this.subscribe(EventType.EQUIPMENT_EQUIP, async (data) => {
      const typedData = data as {
        playerId: string;
        itemId: string;
      };
      await this.tryEquipItem({
        playerId: typedData.playerId,
        itemId: typedData.itemId,
        inventorySlot: undefined,
      });
    });
    this.subscribe(EventType.EQUIPMENT_UNEQUIP, async (data) => {
      const typedData = data as { playerId: string; slot: string };
      await this.unequipItem({
        playerId: typedData.playerId,
        slot: typedData.slot,
      });
    });
    this.subscribe(EventType.EQUIPMENT_TRY_EQUIP, async (data) => {
      const typedData = data as { playerId: string; itemId: string };
      await this.tryEquipItem({
        playerId: typedData.playerId,
        itemId: typedData.itemId,
        inventorySlot: undefined,
      });
    });
    this.subscribe(EventType.EQUIPMENT_FORCE_EQUIP, (data) => {
      const typedData = data as {
        playerId: string;
        itemId: string;
        slot: string;
      };
      const itemData = this.getItemData(typedData.itemId);
      if (!itemData) {
        Logger.systemError(
          "EquipmentSystem",
          `FORCE_EQUIP: unknown item "${typedData.itemId}" for player ${typedData.playerId}`,
        );
        return;
      }
      this.handleForceEquip({
        playerId: typedData.playerId,
        item: itemData,
        slot: typedData.slot,
      });
    });
    this.subscribe(EventType.INVENTORY_ITEM_RIGHT_CLICK, async (data) => {
      const typedData = data as {
        playerId: string;
        itemId: string;
        slot: number;
      };
      await this.handleItemRightClick({
        playerId: typedData.playerId,
        itemId: typedData.itemId,
        slot: typedData.slot,
      });
    });
    this.subscribe(EventType.EQUIPMENT_CONSUME_ARROW, async (data) => {
      const typedData = data as { playerId: string };
      await this.consumeArrow(typedData.playerId);
    });
  }

  private initializePlayerEquipment(playerData: { id: string }): void {
    // Idempotent: don't overwrite existing equipment (prevents reconnection/re-registration wiping gear)
    if (this.playerEquipment.has(playerData.id)) {
      this.logger.debug(
        `Equipment already initialized for ${playerData.id}, skipping`,
      );
      return;
    }

    const equipment: PlayerEquipment = {
      playerId: playerData.id,
      weapon: {
        id: `${playerData.id}_weapon`,
        name: "Weapon Slot",
        slot: EquipmentSlotName.WEAPON,
        itemId: null,
        item: null,
      },
      shield: {
        id: `${playerData.id}_shield`,
        name: "Shield Slot",
        slot: EquipmentSlotName.SHIELD,
        itemId: null,
        item: null,
      },
      helmet: {
        id: `${playerData.id}_helmet`,
        name: "Helmet Slot",
        slot: EquipmentSlotName.HELMET,
        itemId: null,
        item: null,
      },
      body: {
        id: `${playerData.id}_body`,
        name: "Body Slot",
        slot: EquipmentSlotName.BODY,
        itemId: null,
        item: null,
      },
      legs: {
        id: `${playerData.id}_legs`,
        name: "Legs Slot",
        slot: EquipmentSlotName.LEGS,
        itemId: null,
        item: null,
      },
      boots: {
        id: `${playerData.id}_boots`,
        name: "Boots Slot",
        slot: EquipmentSlotName.BOOTS,
        itemId: null,
        item: null,
      },
      gloves: {
        id: `${playerData.id}_gloves`,
        name: "Gloves Slot",
        slot: EquipmentSlotName.GLOVES,
        itemId: null,
        item: null,
      },
      cape: {
        id: `${playerData.id}_cape`,
        name: "Cape Slot",
        slot: EquipmentSlotName.CAPE,
        itemId: null,
        item: null,
      },
      amulet: {
        id: `${playerData.id}_amulet`,
        name: "Amulet Slot",
        slot: EquipmentSlotName.AMULET,
        itemId: null,
        item: null,
      },
      ring: {
        id: `${playerData.id}_ring`,
        name: "Ring Slot",
        slot: EquipmentSlotName.RING,
        itemId: null,
        item: null,
      },
      arrows: {
        id: `${playerData.id}_arrows`,
        name: "Arrow Slot",
        slot: EquipmentSlotName.ARROWS,
        itemId: null,
        item: null,
      },
      totalStats: createEmptyTotalStats(),
    };

    this.playerEquipment.set(playerData.id, equipment);

    // NOTE: Starting items are equipped in loadEquipmentFromDatabase()
    // only if no equipment is found in the database
  }

  private beginEquipmentHydration(playerId: string): number {
    const generation =
      (this.equipmentHydrationGeneration.get(playerId) ?? 0) + 1;
    this.equipmentHydrationGeneration.set(playerId, generation);
    this.readyPlayerEquipment.delete(playerId);
    return generation;
  }

  private completeEquipmentHydration(
    playerId: string,
    generation: number,
    succeeded: boolean,
  ): void {
    if (this.equipmentHydrationGeneration.get(playerId) !== generation) return;
    if (
      succeeded &&
      !this.unloadedPlayerEquipment.has(playerId) &&
      this.playerEquipment.has(playerId)
    ) {
      this.readyPlayerEquipment.add(playerId);
      return;
    }
    this.readyPlayerEquipment.delete(playerId);
  }

  private async loadEquipmentFromDatabase(
    playerId: string,
    strict = false,
    hydrationGeneration?: number,
  ): Promise<boolean> {
    if (!this.databaseSystem) {
      return false;
    }

    const allowNonFatalDbErrors =
      process.env.DB_WRITE_ERRORS_NON_FATAL === "true" ||
      process.env.DB_READ_ERRORS_NON_FATAL === "true" ||
      process.env.STREAMING_DUEL_ENABLED === "true";
    let dbEquipment;

    try {
      // Use playerId directly - database layer handles character ID mapping
      dbEquipment = await this.databaseSystem.getPlayerEquipmentAsync(playerId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (strict || !allowNonFatalDbErrors) {
        throw error;
      }

      Logger.systemWarn(
        "EquipmentSystem",
        `Non-fatal DB read failure loading equipment for ${playerId}: ${reason}`,
      );
      this.sendEquipmentUpdated(playerId);
      this.emitEquipmentChangedForAllSlots(playerId);
      return false;
    }

    if (
      hydrationGeneration !== undefined &&
      this.equipmentHydrationGeneration.get(playerId) !== hydrationGeneration
    ) {
      return false;
    }

    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return false;
    }

    // A database load is a complete authoritative replacement, not a sparse
    // patch. Clear every live slot first so an empty or reduced persisted set
    // cannot leave stale equipment usable after death/restart.
    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment[slotName] as EquipmentSlot | undefined;
      if (!slot) continue;
      slot.itemId = null;
      slot.item = null;
      slot.quantity = undefined;
    }
    equipment.totalStats = createEmptyTotalStats();

    if (dbEquipment && dbEquipment.length > 0) {
      // Load equipped items from database
      for (const dbItem of dbEquipment) {
        if (!dbItem.itemId) continue; // Skip null items

        const itemData = this.getItemData(dbItem.itemId);
        if (itemData && dbItem.slotType) {
          const slot = equipment[dbItem.slotType as keyof PlayerEquipment];
          // Strong type assumption - slot is EquipmentSlot if it exists
          if (
            slot &&
            slot !== equipment.playerId &&
            slot !== equipment.totalStats
          ) {
            const equipSlot = slot as EquipmentSlot;
            // Keep itemId as STRING (matches database format)
            equipSlot.itemId = dbItem.itemId;
            equipSlot.item = itemData;
            // Load quantity for stackable items (like arrows)
            equipSlot.quantity = dbItem.quantity ?? 1;
          }
        }
      }
    }

    // Recalculate and publish the complete replacement, including the empty
    // state. Starting items remain inventory-owned and are never auto-equipped.
    this.recalculateStats(playerId);
    this.sendEquipmentUpdated(playerId);
    this.emitEquipmentChangedForAllSlots(playerId);
    return true;
  }

  /**
   * Strictly replace live equipment with the current persisted snapshot.
   * Death custody uses this before revival; database errors must propagate even
   * in runtime modes where ordinary hydration reads may be non-fatal.
   */
  async reloadFromDatabase(playerId: string): Promise<void> {
    const hydrationGeneration = this.beginEquipmentHydration(playerId);
    let hydrationSucceeded = false;
    try {
      hydrationSucceeded = await this.loadEquipmentFromDatabase(
        playerId,
        true,
        hydrationGeneration,
      );
    } finally {
      this.completeEquipmentHydration(
        playerId,
        hydrationGeneration,
        hydrationSucceeded,
      );
    }
  }

  /**
   * Load equipment from event payload data (single source of truth pattern)
   *
   * Called when PLAYER_JOINED event includes equipment data from character-selection.
   * This eliminates the race condition where EquipmentSystem and character-selection
   * both query the database independently, potentially causing stale data.
   *
   * @param playerId - The player ID
   * @param equipmentData - Equipment data from event payload
   */
  private async loadEquipmentFromPayload(
    playerId: string,
    equipmentData: EquipmentSyncData[],
    hydrationGeneration?: number,
  ): Promise<boolean> {
    if (
      hydrationGeneration !== undefined &&
      this.equipmentHydrationGeneration.get(playerId) !== hydrationGeneration
    ) {
      return false;
    }
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return false;
    }

    // Payload hydration is a complete authoritative replacement. This matters
    // for an explicit empty payload and prevents a prior in-memory projection
    // from surviving a fresh join.
    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment[slotName] as EquipmentSlot | undefined;
      if (!slot) continue;
      slot.itemId = null;
      slot.item = null;
      slot.quantity = undefined;
    }
    equipment.totalStats = createEmptyTotalStats();

    // Load equipped items from payload data
    for (const dbItem of equipmentData) {
      if (!dbItem.itemId) continue; // Skip null items

      const itemData = this.getItemData(dbItem.itemId);
      if (itemData && dbItem.slotType) {
        const slot = equipment[dbItem.slotType as keyof PlayerEquipment];
        // Strong type assumption - slot is EquipmentSlot if it exists
        if (
          slot &&
          slot !== equipment.playerId &&
          slot !== equipment.totalStats
        ) {
          const equipSlot = slot as EquipmentSlot;
          // Keep itemId as STRING (matches database format)
          equipSlot.itemId = dbItem.itemId;
          equipSlot.item = itemData;
          // Load quantity for stackable items (like arrows)
          equipSlot.quantity = dbItem.quantity ?? 1;
        }
      }
    }

    // Recalculate stats after loading equipment
    this.recalculateStats(playerId);

    // Do NOT call sendEquipmentUpdated() here — it would broadcast via sendToAll
    // BEFORE entityAdded packets are sent from character-selection.ts, causing
    // remote clients to receive equipment for entities that don't exist yet.
    // character-selection.ts handles the equipment broadcast at the correct time
    // (after entityAdded packets have been sent to all clients).

    // Emit PLAYER_EQUIPMENT_CHANGED for each slot to update server-side systems
    // (visual attachment, combat calculations, etc.)
    this.emitEquipmentChangedForAllSlots(playerId);
    return true;
  }

  /** Send full equipment state to client via network */
  private sendEquipmentUpdated(playerId: string): void {
    if (this.world.isServer && this.world.network?.send) {
      const equipment = this.getPlayerEquipment(playerId);
      this.world.network.send("equipmentUpdated", {
        playerId,
        equipment,
      });
    }
  }

  /** Emit PLAYER_EQUIPMENT_CHANGED for every slot (uses current equipment state) */
  private emitEquipmentChangedForAllSlots(playerId: string): void {
    const equipment = this.playerEquipment.get(playerId);
    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment?.[slotName] as EquipmentSlot | null | undefined;
      const itemId = slot?.itemId ? slot.itemId.toString() : null;
      this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
        playerId,
        slot: slotName as EquipmentSlotName,
        itemId,
      });
    }
  }

  /** Emit UI_EQUIPMENT_UPDATE with all slots set to null (for clearing) */
  private emitAllSlotsNullUIUpdate(playerId: string): void {
    const nullSlots: Record<string, null> = {};
    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      nullSlots[slotName] = null;
    }
    this.emitTypedEvent(EventType.UI_EQUIPMENT_UPDATE, {
      playerId,
      equipment: nullSlots,
    });
  }

  /**
   * Emit empty equipment events for a player with no equipment
   *
   * Called when PLAYER_JOINED payload contains an empty equipment array,
   * indicating a new player or a player whose equipment was cleared.
   *
   * @param playerId - The player ID
   */
  private emitEmptyEquipmentEvents(playerId: string): void {
    this.emitEquipmentChangedForAllSlots(playerId);
  }

  /**
   * Save equipment to database with optional transaction context
   *
   * @param playerId - The player ID
   * @param _tx - Optional transaction context for atomic operations (reserved for future use)
   */
  private async saveEquipmentToDatabase(
    playerId: string,
    _tx?: TransactionContext,
  ): Promise<void> {
    if (!this.databaseSystem) {
      Logger.systemWarn(
        "EquipmentSystem",
        `Cannot save - no database system for: ${playerId}`,
      );
      return;
    }

    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      Logger.systemWarn(
        "EquipmentSystem",
        `Cannot save - no equipment data for: ${playerId}`,
      );
      return;
    }

    // Convert to database format
    const dbEquipment: Array<{
      slotType: string;
      itemId: string;
      quantity: number;
    }> = [];

    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment[slotName] as EquipmentSlot | undefined;
      if (slot?.itemId) {
        dbEquipment.push({
          slotType: slotName,
          itemId: String(slot.itemId),
          quantity: slot.quantity ?? 1,
        });
      }
    }

    // Use playerId directly - database layer handles character ID mapping
    // CRITICAL: Use async method to ensure save completes before returning
    // Note: Transaction context not passed here; equipment save is independent
    await this.queueEquipmentPersistence(playerId, () =>
      this.databaseSystem!.savePlayerEquipmentAsync(playerId, dbEquipment),
    );
  }

  private queueEquipmentPersistence<T>(
    playerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.equipmentPersistenceTails.get(playerId);
    let current: Promise<T>;
    if (previous) {
      current = previous.catch(() => undefined).then(operation);
    } else {
      try {
        current = operation();
      } catch (error) {
        current = Promise.reject(error);
      }
    }
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.equipmentPersistenceTails.set(playerId, tail);
    void tail.then(() => {
      if (this.equipmentPersistenceTails.get(playerId) === tail) {
        this.equipmentPersistenceTails.delete(playerId);
      }
    });
    return current;
  }

  /**
   * Clear all equipped items immediately (for death system)
   * CRITICAL for death system to prevent item duplication
   */
  async clearEquipmentImmediate(playerId: string): Promise<number> {
    const clearedItems = await this.clearEquipmentAndReturn(playerId);
    return clearedItems.length;
  }

  /**
   * Atomically clear all equipment and return the items
   *
   * CRITICAL FOR DEATH SYSTEM SECURITY:
   * This method atomically reads AND clears equipment in one operation,
   * preventing the race condition where equipment is read, server crashes,
   * and on restart items get duplicated because equipment wasn't cleared.
   *
   * The returned items should be used for gravestone/ground item spawning.
   * Database save happens inside the same transaction as inventory clear.
   *
   * @param playerId - The player ID
   * @param tx - Optional transaction context for atomic operations
   * @returns Array of cleared equipment items with itemId and slot info
   */
  async clearEquipmentAndReturn(
    playerId: string,
    tx?: TransactionContext,
  ): Promise<
    Array<{
      itemId: string;
      slot: string;
      quantity: number;
    }>
  > {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return [];
    }

    const clearedItems: Array<{
      itemId: string;
      slot: string;
      quantity: number;
    }> = [];

    // Atomically collect AND clear all equipped items
    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment[slotName] as EquipmentSlot | null;
      if (slot && slot.itemId) {
        // Collect item info BEFORE clearing (use actual quantity for stackable items like arrows)
        clearedItems.push({
          itemId: String(slot.itemId),
          slot: slotName,
          quantity: slot.quantity ?? 1,
        });

        // Clear the slot atomically (including quantity for stackable items)
        slot.itemId = null;
        slot.item = null;
        slot.quantity = undefined;

        // Emit PLAYER_EQUIPMENT_CHANGED for visual system
        this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
          playerId: playerId,
          slot: slotName as EquipmentSlotName,
          itemId: null,
        });
      }
    }

    // Reset total stats
    equipment.totalStats = createEmptyTotalStats();

    // Emit UI update event with all slots null
    this.emitAllSlotsNullUIUpdate(playerId);

    // When called within a death transaction (tx provided), skip the independent
    // DB save — it opens a nested transaction that deadlocks on SQLite.
    // The caller's transaction handles persistence; in-memory state is already cleared.
    if (!tx) {
      await this.saveEquipmentToDatabase(playerId);
    }

    return clearedItems;
  }

  private cleanupPlayerEquipment(playerId: string): void {
    this.equipmentHydrationGeneration.set(
      playerId,
      (this.equipmentHydrationGeneration.get(playerId) ?? 0) + 1,
    );
    this.readyPlayerEquipment.delete(playerId);
    this.playerEquipment.delete(playerId);
    this.playerSkills.delete(playerId);
  }

  private async handleItemRightClick(data: {
    playerId: string;
    itemId: string | number;
    slot: number;
  }): Promise<void> {
    const itemData = this.getItemData(data.itemId);

    if (!itemData) {
      return;
    }

    // Determine if this is equippable
    const equipSlot = this.getEquipmentSlot(itemData);

    if (equipSlot) {
      await this.tryEquipItem({
        playerId: data.playerId,
        itemId: data.itemId,
        inventorySlot: data.slot,
      });
    }
    // Non-equippable items (food, potions) are handled by InventoryInteractionSystem
  }

  private async tryEquipItem(data: {
    playerId: string;
    itemId: string | number;
    inventorySlot?: number;
  }): Promise<void> {
    const player = this.world.getPlayer(data.playerId);
    const equipment = this.playerEquipment.get(data.playerId);

    if (!player || !equipment) {
      return;
    }

    const itemData = this.getItemData(data.itemId);
    if (!itemData) {
      return;
    }

    const equipSlot = this.getEquipmentSlot(itemData);
    if (!equipSlot) {
      this.sendMessage(
        data.playerId,
        `${itemData.name} cannot be equipped.`,
        "warning",
      );
      return;
    }

    const meetsRequirements = this.meetsLevelRequirements(
      data.playerId,
      itemData,
    );
    if (!meetsRequirements) {
      const requirements =
        equipmentRequirements.getLevelRequirements(itemData.id as string) || {};
      const reqList = Object.entries(requirements as Record<string, number>)
        .map(
          ([skill, level]) =>
            `level ${level} ${skill.charAt(0).toUpperCase() + skill.slice(1)}`,
        )
        .join(" and ");

      this.sendMessage(
        data.playerId,
        `You need at least ${reqList} to equip ${itemData.name}.`,
        "warning",
      );
      return;
    }

    if (
      data.inventorySlot === undefined &&
      !this.playerHasItem(data.playerId, data.itemId)
    ) {
      return;
    }

    // Perform the equipment - MUST await to ensure DB save completes
    await this.equipItem({
      playerId: data.playerId,
      itemId: data.itemId,
      slot: equipSlot,
      inventorySlot: data.inventorySlot,
    });
  }

  private async equipItem(data: {
    playerId: string;
    itemId: string | number;
    slot: string;
    inventorySlot?: number;
  }): Promise<void> {
    const equipment = this.playerEquipment.get(data.playerId);
    if (!equipment) {
      return;
    }

    // Check for valid itemId before calling getItemData
    if (data.itemId === null || data.itemId === undefined) {
      return;
    }

    const itemData = this.getItemData(data.itemId);
    if (!itemData) {
      return;
    }

    const slot = data.slot;
    if (!this.isValidEquipmentSlot(slot)) return;

    const equipmentSlot = equipment[slot];
    if (!equipmentSlot) {
      Logger.systemError(
        "EquipmentSystem",
        `Equipment slot ${slot} is null for player ${data.playerId}`,
      );
      return;
    }

    // Check for 2-handed weapon logic
    const is2hWeapon = this.is2hWeapon(itemData);
    const currentWeapon = equipment.weapon?.item;
    const currentWeaponIs2h = currentWeapon
      ? this.is2hWeapon(currentWeapon)
      : false;

    // If equipping a 2h weapon, unequip shield first
    if (is2hWeapon && slot === "weapon" && equipment.shield?.itemId) {
      // Pre-check inventory space before attempting shield auto-unequip
      const invSystemForShield = this.world.getSystem("inventory");
      if (
        invSystemForShield &&
        !invSystemForShield.hasSpace(data.playerId, 1)
      ) {
        this.sendMessage(
          data.playerId,
          "Your inventory is too full to unequip the shield for a 2-handed weapon.",
          "warning",
        );
        return;
      }

      await this.unequipItem({
        playerId: data.playerId,
        slot: "shield",
      });
      this.sendMessage(
        data.playerId,
        "Shield unequipped (2-handed weapon equipped).",
        "info",
      );
    }

    // If equipping a shield, check if 2h weapon is equipped
    if (slot === "shield" && currentWeaponIs2h) {
      this.sendMessage(
        data.playerId,
        "Cannot equip shield while wielding a 2-handed weapon.",
        "warning",
      );
      return;
    }

    // Same-type stackable merge: if equipping the same stackable item that's
    // already in the slot (e.g. adding arrows to an existing arrow stack),
    // just merge the quantity directly. Avoids the unequip→inventory flash→re-equip cycle.
    const isSameStackableMerge =
      itemData.stackable &&
      equipmentSlot.itemId !== null &&
      String(equipmentSlot.itemId) === String(data.itemId);

    if (!isSameStackableMerge) {
      // Different item or empty slot — unequip current item first if any
      if (equipmentSlot.itemId) {
        await this.unequipItem({
          playerId: data.playerId,
          slot: data.slot,
        });
      }
    }

    // DUPLICATION FIX: Acquire transaction lock to prevent race conditions
    const inventorySystem = this.world.getSystem("inventory");
    if (inventorySystem && !inventorySystem.lockForTransaction(data.playerId)) {
      // Another transaction in progress, abort to prevent duplication
      this.sendMessage(
        data.playerId,
        "Please wait, another action is in progress.",
        "warning",
      );
      return;
    }

    try {
      // DUPLICATION FIX: Verify item exists at inventory slot before equipping
      if (
        inventorySystem &&
        data.inventorySlot !== undefined &&
        !inventorySystem.hasItemAtSlot(
          data.playerId,
          String(data.itemId),
          data.inventorySlot,
        )
      ) {
        Logger.systemError(
          "EquipmentSystem",
          `Cannot equip: item ${data.itemId} not found at slot ${data.inventorySlot}`,
        );
        return;
      }

      // Get the full quantity from inventory for stackable items (like arrows)
      let quantityToEquip = 1;
      if (
        itemData.stackable &&
        inventorySystem &&
        data.inventorySlot !== undefined
      ) {
        const inventory = inventorySystem.getInventory(data.playerId);
        const invItem = inventory?.items.find(
          (item) =>
            item.slot === data.inventorySlot &&
            item.itemId === String(data.itemId),
        );
        if (invItem) {
          quantityToEquip = invItem.quantity;
        }
      }

      // DUPLICATION FIX: Remove from inventory FIRST, then equip
      // This ensures if removal fails, item is not duplicated
      // For stackable items like arrows, remove the ENTIRE stack
      const removed = await inventorySystem?.removeItemDirect(
        data.playerId,
        {
          itemId: String(data.itemId),
          quantity: quantityToEquip,
          slot: data.inventorySlot,
        },
        true,
      );

      if (!removed) {
        Logger.systemError(
          "EquipmentSystem",
          `Cannot equip: failed to remove item ${data.itemId} from inventory`,
        );
        this.sendMessage(
          data.playerId,
          "Failed to equip item - item not in inventory.",
          "warning",
        );
        return;
      }

      if (isSameStackableMerge) {
        // Merge quantity into already-equipped stack
        equipmentSlot.quantity =
          (equipmentSlot.quantity ?? 0) + quantityToEquip;
      } else {
        // Now safe to equip - item has been removed from inventory
        equipmentSlot.itemId = data.itemId;
        equipmentSlot.item = itemData;
        equipmentSlot.quantity = quantityToEquip;
      }
    } finally {
      // Always release the lock
      inventorySystem?.unlockTransaction(data.playerId);
    }

    // Update stats
    this.recalculateStats(data.playerId);

    // Update combat system with new equipment (emit per-slot change for type consistency)
    const itemIdForEvent =
      equipmentSlot.itemId !== null
        ? typeof equipmentSlot.itemId === "string"
          ? equipmentSlot.itemId
          : equipmentSlot.itemId.toString()
        : null;

    this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
      playerId: data.playerId,
      slot: slot as EquipmentSlotName,
      itemId: itemIdForEvent,
    });

    // Send equipment state to client
    this.sendEquipmentUpdated(data.playerId);

    this.sendMessage(data.playerId, `Equipped ${itemData.name}.`, "info");

    // Save to database after equipping - MUST await to prevent data loss on logout
    try {
      await this.saveEquipmentToDatabase(data.playerId);
    } catch (err) {
      Logger.systemError(
        "EquipmentSystem",
        `Failed to save equipment after equip for ${data.playerId}: ${err}`,
      );
    }
  }

  private async unequipItem(data: {
    playerId: string;
    slot: string;
  }): Promise<boolean> {
    const equipment = this.playerEquipment.get(data.playerId);
    if (!equipment) return false;

    const slot = data.slot;
    if (!this.isValidEquipmentSlot(slot)) return false;

    const equipmentSlot = equipment[slot];
    if (!equipmentSlot || !equipmentSlot.itemId) return false;

    // Additional check for item data
    if (!equipmentSlot.item) {
      Logger.systemError(
        "EquipmentSystem",
        `Cannot unequip item: item data is null for slot ${slot} on player ${data.playerId}`,
      );
      return false;
    }

    // Store item info before clearing the slot
    const itemName = equipmentSlot.item.name;
    const itemIdToAdd = equipmentSlot.itemId?.toString() || "";
    const itemData = equipmentSlot.item;
    const quantityToReturn = equipmentSlot.quantity ?? 1;

    // DUPLICATION FIX: Check inventory has space FIRST
    const inventorySystem = this.world.getSystem("inventory");
    if (inventorySystem && !inventorySystem.hasSpace(data.playerId, 1)) {
      this.sendMessage(
        data.playerId,
        "Cannot unequip - inventory is full.",
        "warning",
      );
      return false;
    }

    // DUPLICATION FIX: Acquire transaction lock to prevent race conditions
    if (inventorySystem && !inventorySystem.lockForTransaction(data.playerId)) {
      this.sendMessage(
        data.playerId,
        "Please wait, another action is in progress.",
        "warning",
      );
      return false;
    }

    try {
      // DUPLICATION FIX: Clear equipment slot FIRST, then add to inventory
      // This ensures if add fails, item is already removed from equipment
      // The item is "lost" temporarily but not duplicated

      // Clear equipment slot FIRST (including quantity)
      equipmentSlot.itemId = null;
      equipmentSlot.item = null;
      equipmentSlot.quantity = undefined;

      // Now add back to inventory - use direct method for better error handling
      // For stackable items like arrows, return the FULL quantity
      const added = await inventorySystem?.addItemDirect(
        data.playerId,
        {
          itemId: itemIdToAdd,
          quantity: quantityToReturn,
        },
        true,
      );

      if (!added) {
        // This should rarely happen since we checked hasSpace above
        // But if it does, we need to restore the equipment slot
        Logger.systemError(
          "EquipmentSystem",
          `Failed to add unequipped item ${itemIdToAdd} to inventory, restoring equipment`,
        );
        equipmentSlot.itemId = itemIdToAdd;
        equipmentSlot.item = itemData;
        equipmentSlot.quantity = quantityToReturn;
        this.sendMessage(
          data.playerId,
          "Failed to unequip - inventory error.",
          "warning",
        );
        return false;
      }
    } finally {
      // Always release the lock
      inventorySystem?.unlockTransaction(data.playerId);
    }

    // Update stats
    this.recalculateStats(data.playerId);

    // Update combat system (emit per-slot change for type consistency)
    this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
      playerId: data.playerId,
      slot: slot as EquipmentSlotName,
      itemId: null,
    });

    // Send equipment state to client
    this.sendEquipmentUpdated(data.playerId);

    this.sendMessage(data.playerId, `Unequipped ${itemName}.`, "info");

    // Save to database after unequipping - MUST await to prevent data loss on logout
    try {
      await this.saveEquipmentToDatabase(data.playerId);
    } catch (err) {
      Logger.systemError(
        "EquipmentSystem",
        `Failed to save equipment after unequip for ${data.playerId}: ${err}`,
      );
    }
    return true;
  }

  private handleForceEquip(data: {
    playerId: string;
    item: Item;
    slot: string;
  }): void {
    this.forceEquipItem(data.playerId, data.item, data.slot);
  }

  private forceEquipItem(playerId: string, itemData: Item, slot: string): void {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      this.initializePlayerEquipment({ id: playerId });
      return;
    }

    const equipSlot = slot as keyof PlayerEquipment;
    if (equipSlot === "playerId" || equipSlot === "totalStats") return;

    const equipmentSlot = equipment[equipSlot] as EquipmentSlot;
    if (!equipmentSlot) {
      Logger.systemError(
        "EquipmentSystem",
        `Equipment slot ${equipSlot} is null for player ${playerId}`,
      );
      return;
    }

    // Keep itemId as STRING (e.g., "bronze_sword", "steel_sword")
    equipmentSlot.itemId = itemData.id as string | number;
    equipmentSlot.item = itemData;

    this.recalculateStats(playerId);

    // Update combat system (emit per-slot change for type consistency)
    this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
      playerId: playerId,
      slot: equipSlot as EquipmentSlotName,
      itemId:
        equipmentSlot.itemId !== null ? equipmentSlot.itemId.toString() : null,
    });
  }

  private recalculateStats(playerId: string): void {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) return;

    // Reset stats (including ranged/magic bonuses for F2P combat)
    equipment.totalStats = createEmptyTotalStats();

    // Add bonuses from each equipped item
    const slots = EQUIPMENT_SLOT_NAMES.map(
      (name) => equipment[name] as EquipmentSlot | null,
    ).filter((slot): slot is EquipmentSlot => slot !== null);

    slots.forEach((slot) => {
      if (slot.item) {
        const bonuses = slot.item.bonuses as Record<string, number> | undefined;
        if (!bonuses) return;

        // Map simple bonuses (attack, strength, defense, ranged)
        if (bonuses.attack) equipment.totalStats.attack += bonuses.attack;
        if (bonuses.strength) equipment.totalStats.strength += bonuses.strength;
        // Current manifests express melee damage bonuses as `meleeStrength`.
        if (bonuses.meleeStrength)
          equipment.totalStats.strength += bonuses.meleeStrength;
        if (bonuses.defense) equipment.totalStats.defense += bonuses.defense;
        if (bonuses.ranged) equipment.totalStats.ranged += bonuses.ranged;

        // Map detailed ranged bonuses (attackRanged -> rangedAttack, rangedStrength)
        if (bonuses.attackRanged)
          equipment.totalStats.rangedAttack += bonuses.attackRanged;
        if (bonuses.rangedStrength)
          equipment.totalStats.rangedStrength += bonuses.rangedStrength;

        // Map detailed magic bonuses (attackMagic -> magicAttack, defenseMagic -> magicDefense)
        if (bonuses.attackMagic)
          equipment.totalStats.magicAttack += bonuses.attackMagic;
        if (bonuses.defenseMagic)
          equipment.totalStats.magicDefense += bonuses.defenseMagic;

        // Map per-style defence bonuses (classic MMORPG combat triangle)
        if (bonuses.defenseStab)
          equipment.totalStats.defenseStab += bonuses.defenseStab;
        if (bonuses.defenseSlash)
          equipment.totalStats.defenseSlash += bonuses.defenseSlash;
        if (bonuses.defenseCrush)
          equipment.totalStats.defenseCrush += bonuses.defenseCrush;
        if (bonuses.defenseRanged)
          equipment.totalStats.defenseRanged += bonuses.defenseRanged;

        // Map per-style attack bonuses
        if (bonuses.attackStab)
          equipment.totalStats.attackStab += bonuses.attackStab;
        if (bonuses.attackSlash)
          equipment.totalStats.attackSlash += bonuses.attackSlash;
        if (bonuses.attackCrush)
          equipment.totalStats.attackCrush += bonuses.attackCrush;
      }
    });

    // Emit stats update
    this.emitTypedEvent(EventType.PLAYER_STATS_EQUIPMENT_UPDATED, {
      playerId: playerId,
      equipmentStats: equipment.totalStats,
    });
  }

  /**
   * Check if item is a 2-handed weapon
   * Uses equipSlot: '2h' or explicit is2h flag
   */
  private is2hWeapon(item: Item): boolean {
    return item.equipSlot === "2h" || item.is2h === true;
  }

  private getEquipmentSlot(itemData: Item): string | null {
    // BANK NOTE SYSTEM: Explicitly non-equipable items cannot be equipped
    // This catches noted items (e.g., "bronze_sword_noted") which inherit
    // type from base but are marked equipable: false
    if (itemData.equipable === false) {
      return null;
    }

    // Handle 2-handed weapons (they go in weapon slot)
    if (this.is2hWeapon(itemData)) {
      return "weapon";
    }

    // rules-accurate: Check explicit equipSlot first (handles tools like hatchets/pickaxes)
    // Tools have type: "tool" but equipSlot: "weapon" - they should be equipable
    if (itemData.equipSlot && itemData.equipSlot !== "2h") {
      return itemData.equipSlot;
    }

    // Fall back to type-based detection for items without explicit equipSlot
    switch (itemData.type) {
      case ItemType.WEAPON:
        return "weapon";
      case ItemType.ARMOR:
        return itemData.equipSlot || null;
      case ItemType.AMMUNITION:
        return "arrows";
      default:
        return null;
    }
  }

  private meetsLevelRequirements(playerId: string, itemData: Item): boolean {
    const requirements = equipmentRequirements.getLevelRequirements(
      itemData.id as string,
    );
    if (!requirements) return true; // No requirements

    // Get player skills (simplified for MVP)
    const playerSkills = this.getPlayerSkills(playerId);

    // Check each required skill from manifest
    // New format only includes skills that are required (no zeros)
    for (const [skill, required] of Object.entries(requirements)) {
      const playerLevel =
        playerSkills[normalizeEquipmentRequirementSkill(skill)] ?? 1;
      if (playerLevel < required) {
        return false;
      }
    }

    return true;
  }

  private getPlayerSkills(playerId: string): Record<string, number> {
    // Use cached skills data (reactive pattern)
    const cachedSkills = this.playerSkills.get(playerId);

    if (cachedSkills) {
      return Object.fromEntries(
        Object.entries(cachedSkills).map(([skill, value]) => [
          normalizeEquipmentRequirementSkill(skill),
          Number.isFinite(value?.level) ? Math.max(1, value.level) : 1,
        ]),
      );
    }

    return {
      attack: 1,
      strength: 1,
      defense: 1,
      ranged: 1,
      magic: 1,
      prayer: 1,
      constitution: 10,
      woodcutting: 1,
      mining: 1,
      fishing: 1,
      firemaking: 1,
      cooking: 1,
      smithing: 1,
      agility: 1,
      crafting: 1,
      fletching: 1,
      runecrafting: 1,
    };
  }

  private playerHasItem(playerId: string, itemId: number | string): boolean {
    const itemIdStr = itemId.toString();

    // Check with InventorySystem directly (not via events - events require subscriber)
    const inventorySystem = this.world.getSystem("inventory");
    if (inventorySystem && inventorySystem.hasItem(playerId, itemIdStr, 1)) {
      return true;
    }

    // Also check if item is already equipped
    const equipment = this.playerEquipment.get(playerId);
    if (equipment) {
      const isEquipped = EQUIPMENT_SLOT_NAMES.some((name) => {
        const slot = equipment[name] as EquipmentSlot | null;
        return slot?.itemId === itemIdStr;
      });
      if (isEquipped) {
        return true;
      }
    }

    return false;
  }

  private getItemData(itemId: string | number): Item | null {
    // Check for null/undefined itemId first
    if (itemId === null || itemId === undefined) {
      return null;
    }

    // Get item data through centralized DataManager (manifest-driven)
    const itemIdStr = itemId.toString();
    return dataManager.getItem(itemIdStr);
  }

  private sendMessage(
    playerId: string,
    message: string,
    type: "info" | "warning" | "error",
  ): void {
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: playerId,
      message: message,
      type: type,
    });
  }

  // ========== Public API ==========

  /**
   * Get the full equipment state for a player.
   *
   * Returns all equipped items and calculated stat bonuses.
   * Used by combat system and UI to determine player capabilities.
   *
   * @param playerId - The player ID to look up
   * @returns PlayerEquipment object with all slots and stats, or undefined if not found
   *
   * @example
   * const equipment = equipmentSystem.getPlayerEquipment(playerId);
   * if (equipment?.weapon?.item) {
   *   console.log(`Wielding: ${equipment.weapon.item.name}`);
   * }
   */
  getPlayerEquipment(playerId: string): PlayerEquipment | undefined {
    return this.playerEquipment.get(playerId);
  }

  /**
   * Whether the live slot projection is the completed authoritative join or
   * reload result. Map allocation alone is intentionally insufficient.
   */
  isEquipmentReady(playerId: string): boolean {
    return (
      this.readyPlayerEquipment.has(playerId) &&
      !this.unloadedPlayerEquipment.has(playerId) &&
      this.playerEquipment.has(playerId)
    );
  }

  /**
   * Equip an item already owned in inventory and return the authoritative
   * postcondition. This is the server-agent action boundary; it deliberately
   * awaits inventory removal, equipment persistence, and the final slot state.
   */
  async equipOwnedItem(
    playerId: string,
    itemId: string,
  ): Promise<EquipmentActionReceipt> {
    if (!this.world.getPlayer(playerId)) {
      return {
        ok: false,
        playerId,
        itemId,
        slot: null,
        changed: false,
        reason: "player_missing",
      };
    }

    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return {
        ok: false,
        playerId,
        itemId,
        slot: null,
        changed: false,
        reason: "equipment_not_initialized",
      };
    }

    const itemData = this.getItemData(itemId);
    if (!itemData) {
      return {
        ok: false,
        playerId,
        itemId,
        slot: null,
        changed: false,
        reason: "item_not_found",
      };
    }

    const slot = this.getEquipmentSlot(itemData);
    if (!slot || !this.isValidEquipmentSlot(slot)) {
      return {
        ok: false,
        playerId,
        itemId,
        slot: null,
        changed: false,
        reason: "not_equippable",
      };
    }

    if (!this.meetsLevelRequirements(playerId, itemData)) {
      return {
        ok: false,
        playerId,
        itemId,
        slot,
        changed: false,
        reason: "requirements_not_met",
      };
    }

    const inventorySystem = this.world.getSystem("inventory");
    const equipmentSlot = equipment[slot];
    const alreadyEquipped = equipmentSlot?.itemId?.toString() === itemId;
    const equippedQuantityBefore = equipmentSlot?.quantity ?? 0;
    if (alreadyEquipped && !itemData.stackable) {
      return { ok: true, playerId, itemId, slot, changed: false };
    }
    if (!inventorySystem?.hasItem(playerId, itemId, 1)) {
      if (alreadyEquipped) {
        return { ok: true, playerId, itemId, slot, changed: false };
      }
      return {
        ok: false,
        playerId,
        itemId,
        slot,
        changed: false,
        reason: "item_not_owned",
      };
    }

    const inventorySlot = inventorySystem
      .getInventory(playerId)
      ?.items.filter((item) => item.itemId === itemId && item.quantity > 0)
      .sort((left, right) => left.slot - right.slot)[0]?.slot;
    await this.tryEquipItem({ playerId, itemId, inventorySlot });

    const finalEquipment = this.playerEquipment.get(playerId);
    const finalSlot = finalEquipment?.[slot];
    if (finalSlot?.itemId?.toString() !== itemId) {
      return {
        ok: false,
        playerId,
        itemId,
        slot,
        changed: false,
        reason: "equip_rejected",
      };
    }

    const quantityChanged =
      alreadyEquipped && (finalSlot?.quantity ?? 0) !== equippedQuantityBefore;
    if (alreadyEquipped && !quantityChanged) {
      return {
        ok: false,
        playerId,
        itemId,
        slot,
        changed: false,
        reason: "equip_rejected",
      };
    }
    return {
      ok: true,
      playerId,
      itemId,
      slot,
      changed: !alreadyEquipped || quantityChanged,
    };
  }

  /**
   * Unequip one currently worn item and acknowledge only the authoritative
   * postcondition. The displaced item must be conserved in inventory.
   */
  async unequipOwnedItem(
    playerId: string,
    slot: string,
  ): Promise<EquipmentActionReceipt> {
    if (!this.world.getPlayer(playerId)) {
      return {
        ok: false,
        playerId,
        itemId: "",
        slot: null,
        changed: false,
        reason: "player_missing",
      };
    }
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return {
        ok: false,
        playerId,
        itemId: "",
        slot: null,
        changed: false,
        reason: "equipment_not_initialized",
      };
    }
    if (!this.isValidEquipmentSlot(slot)) {
      return {
        ok: false,
        playerId,
        itemId: "",
        slot: null,
        changed: false,
        reason: "not_equippable",
      };
    }
    const itemId = equipment[slot]?.itemId?.toString() ?? "";
    if (!itemId) {
      return {
        ok: false,
        playerId,
        itemId: "",
        slot,
        changed: false,
        reason: "item_not_owned",
      };
    }

    const unequipped = await this.unequipItem({ playerId, slot });
    const finalItemId =
      this.playerEquipment.get(playerId)?.[slot]?.itemId?.toString() ?? null;
    if (!unequipped || finalItemId !== null) {
      return {
        ok: false,
        playerId,
        itemId,
        slot,
        changed: false,
        reason: "unequip_rejected",
      };
    }
    return { ok: true, playerId, itemId, slot, changed: true };
  }

  /**
   * Commit the selected contestant's complete bank, inventory, equipment, and
   * autocast plan once. The stable operation receipt is retried after an
   * ambiguous response, while the database fences stale planners and verifies
   * the private preparation capability under the same transaction lock.
   */
  async commitOwnedDuelPreparationPlan(
    playerId: string,
    request: OwnedDuelPreparationPlanRequest,
  ): Promise<OwnedDuelPreparationPlanReceipt> {
    const operationId = String(request.operationId ?? "").trim();
    const preparationId = String(request.preparationId ?? "").trim();
    const failure = (
      reason: OwnedDuelPreparationPlanFailureReason,
    ): OwnedDuelPreparationPlanReceipt => ({
      ok: false,
      playerId,
      operationId,
      preparationId,
      changed: false,
      replayed: false,
      reason,
    });

    if (!this.world.getPlayer(playerId)) return failure("player_missing");
    if (!this.playerEquipment.has(playerId)) {
      return failure("equipment_not_initialized");
    }
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    if (!inventorySystem?.getInventory(playerId)) {
      return failure("inventory_not_initialized");
    }
    if (!this.databaseSystem?.commitDuelPreparationPlanOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }
    if (!operationId || !preparationId) return failure("plan_invalid");

    const committed = this.canonicalDuelPreparationPlanSnapshot(
      request.committed,
    );
    const canonicalRecoveryEvidence = canonicalDuelPreparationRecoveryEvidence(
      request.recoveryEvidence,
    );
    if (!this.isValidOwnedDuelPreparationCommittedPlan(playerId, committed)) {
      return failure("plan_invalid");
    }
    if (!canonicalRecoveryEvidence) return failure("plan_invalid");
    const recoveryEvidence = JSON.parse(
      canonicalRecoveryEvidence,
    ) as DuelPreparationPlanRecoveryEvidence;

    let result: OwnedDuelPreparationPlanReceipt = failure("inventory_busy");
    await inventorySystem.queueOperation(playerId, async () => {
      if (!inventorySystem.lockForTransaction(playerId)) {
        result = failure("inventory_busy");
        return false;
      }
      try {
        const expected = this.canonicalDuelPreparationPlanSnapshot({
          ...this.snapshotCombatLoadoutPersistence(playerId),
          bank: request.expectedBank,
        });
        if (!this.duelPreparationPlanCustodyIsConserved(expected, committed)) {
          result = failure("custody_violation");
          return false;
        }

        let requestFingerprint: string;
        try {
          requestFingerprint = await equipmentDebitSha256Hex(
            JSON.stringify({
              version: 1,
              preparationId,
              playerId,
              committed,
              recoveryEvidence,
            }),
          );
        } catch {
          result = failure("plan_invalid");
          return false;
        }

        let receipt;
        try {
          receipt = await this.queueEquipmentPersistence(playerId, () =>
            this.databaseSystem!.commitDuelPreparationPlanOperationAsync({
              operationId,
              preparationId,
              playerId,
              requestFingerprint,
              expected,
              committed,
              recoveryEvidence,
            }),
          );
        } catch (firstError) {
          if (!shouldRetryDuelPreparationPlanCommit(firstError)) {
            if (isDuelPreparationCapabilityRevoked(firstError)) {
              result = failure("preparation_capability_unavailable");
            } else {
              Logger.systemError(
                "EquipmentSystem",
                `Duel preparation plan rejected for ${playerId}: ${String(firstError)}`,
              );
              result = failure("persistence_failed");
            }
            return false;
          }
          try {
            receipt = await this.queueEquipmentPersistence(playerId, () =>
              this.databaseSystem!.commitDuelPreparationPlanOperationAsync({
                operationId,
                preparationId,
                playerId,
                requestFingerprint,
                expected,
                committed,
                recoveryEvidence,
              }),
            );
          } catch (retryError) {
            Logger.systemError(
              "EquipmentSystem",
              `Duel preparation plan commit/replay failed for ${playerId}: ${String(retryError)}`,
            );
            result = failure("persistence_failed");
            return false;
          }
        }

        const receiptCommitted = this.canonicalDuelPreparationPlanSnapshot(
          receipt.committed,
        );
        if (
          receipt.operationId !== operationId ||
          receipt.preparationId !== preparationId ||
          receipt.playerId !== playerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          !this.duelPreparationPlanSnapshotsEqual(
            receiptCommitted,
            committed,
          ) ||
          canonicalDuelPreparationRecoveryEvidence(receipt.recoveryEvidence) !==
            canonicalRecoveryEvidence ||
          !this.isValidOwnedDuelPreparationCommittedPlan(
            playerId,
            receiptCommitted,
          )
        ) {
          result = failure("committed_state_apply_failed");
          return false;
        }
        if (
          !(await this.reconcileCommittedDuelPreparationPlan(
            playerId,
            receiptCommitted,
            inventorySystem,
          ))
        ) {
          result = failure("committed_state_apply_failed");
          return false;
        }
        result = {
          ok: true,
          playerId,
          operationId,
          preparationId,
          requestFingerprint,
          changed: !this.duelPreparationPlanSnapshotsEqual(
            expected,
            receiptCommitted,
          ),
          replayed: receipt.replayed,
          committed: receiptCommitted,
          recoveryEvidence,
        };
        return true;
      } finally {
        inventorySystem.unlockTransaction(playerId);
      }
    });
    return result;
  }

  /**
   * Replace both live custody projections from persistence while holding the
   * same per-player queue and transaction lock used by whole-plan commits.
   * Private preparation may call this once after a custody mismatch caused by
   * asynchronous player hydration or another already-admitted projection
   * update. It never changes persisted custody.
   */
  async refreshOwnedDuelPreparationCustodyFromPersistence(
    playerId: string,
  ): Promise<boolean> {
    if (
      !this.world.getPlayer(playerId) ||
      !this.playerEquipment.has(playerId) ||
      !this.databaseSystem
    ) {
      return false;
    }
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    if (!inventorySystem?.getInventory(playerId)) return false;

    let refreshed = false;
    await inventorySystem.queueOperation(playerId, async () => {
      if (!inventorySystem.lockForTransaction(playerId)) return false;
      try {
        await inventorySystem.reloadFromDatabase(playerId);
        await this.reloadFromDatabase(playerId);
        refreshed = true;
        return true;
      } catch (error) {
        Logger.systemError(
          "EquipmentSystem",
          `Duel preparation custody refresh failed for ${playerId}: ${String(error)}`,
        );
        return false;
      } finally {
        inventorySystem.unlockTransaction(playerId);
      }
    });
    return refreshed;
  }

  /**
   * Recover a committed whole-plan receipt after process loss. No planner input
   * is accepted here: the deterministic operation ID resolves the immutable
   * custody snapshot and its public readiness evidence, then live state is
   * reconciled to that receipt before it is returned.
   */
  async recoverOwnedDuelPreparationPlan(
    playerId: string,
    request: OwnedDuelPreparationPlanRecoveryRequest,
  ): Promise<OwnedDuelPreparationPlanReceipt | null> {
    const operationId = String(request.operationId ?? "").trim();
    const preparationId = String(request.preparationId ?? "").trim();
    const failure = (
      reason: OwnedDuelPreparationPlanFailureReason,
    ): OwnedDuelPreparationPlanReceipt => ({
      ok: false,
      playerId,
      operationId,
      preparationId,
      changed: false,
      replayed: false,
      reason,
    });
    if (!operationId || !preparationId) return null;
    if (!this.world.getPlayer(playerId)) return failure("player_missing");
    if (!this.playerEquipment.has(playerId)) {
      return failure("equipment_not_initialized");
    }
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    if (!inventorySystem?.getInventory(playerId)) {
      return failure("inventory_not_initialized");
    }
    if (!this.databaseSystem?.getDuelPreparationPlanOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }

    let result: OwnedDuelPreparationPlanReceipt | null = null;
    await inventorySystem.queueOperation(playerId, async () => {
      if (!inventorySystem.lockForTransaction(playerId)) return false;
      try {
        const receipt = await this.queueEquipmentPersistence(playerId, () =>
          this.databaseSystem!.getDuelPreparationPlanOperationAsync!({
            operationId,
            preparationId,
            playerId,
          }),
        );
        if (!receipt) return false;
        const committed = this.canonicalDuelPreparationPlanSnapshot(
          receipt.committed,
        );
        const canonicalRecoveryEvidence =
          canonicalDuelPreparationRecoveryEvidence(receipt.recoveryEvidence);
        if (
          receipt.operationId !== operationId ||
          receipt.preparationId !== preparationId ||
          receipt.playerId !== playerId ||
          !receipt.requestFingerprint ||
          !canonicalRecoveryEvidence ||
          !this.isValidOwnedDuelPreparationCommittedPlan(playerId, committed) ||
          !(await this.reconcileCommittedDuelPreparationPlan(
            playerId,
            committed,
            inventorySystem,
          ))
        ) {
          result = failure("committed_state_apply_failed");
          return false;
        }
        result = {
          ok: true,
          playerId,
          operationId,
          preparationId,
          requestFingerprint: receipt.requestFingerprint,
          changed: false,
          replayed: true,
          committed,
          recoveryEvidence: JSON.parse(
            canonicalRecoveryEvidence,
          ) as DuelPreparationPlanRecoveryEvidence,
        };
        return true;
      } catch (error) {
        Logger.systemError(
          "EquipmentSystem",
          `Duel preparation recovery failed for ${playerId}: ${String(error)}`,
        );
        result = failure("persistence_failed");
        return false;
      } finally {
        inventorySystem.unlockTransaction(playerId);
      }
    });
    return result;
  }

  private async reconcileCommittedDuelPreparationPlan(
    playerId: string,
    committed: DuelPreparationPlanPersistenceSnapshot,
    inventorySystem: InventorySystem,
  ): Promise<boolean> {
    const liveMatches = (): boolean =>
      this.duelPreparationPlanSnapshotsEqual(
        this.canonicalDuelPreparationPlanSnapshot({
          ...this.snapshotCombatLoadoutPersistence(playerId),
          bank: committed.bank,
        }),
        committed,
      );
    try {
      if (
        inventorySystem.applyCommittedCombatLoadoutInventory(
          playerId,
          committed.inventory,
        )
      ) {
        this.applyCommittedCombatEquipment(playerId, committed.equipment);
        this.applyCommittedSelectedSpell(playerId, committed.selectedSpell);
        if (liveMatches()) return true;
      }
    } catch (error) {
      Logger.systemError(
        "EquipmentSystem",
        `Direct duel preparation apply failed for ${playerId}: ${String(error)}`,
      );
    }

    // The database receipt is already authoritative. If the projection apply
    // fails, replace both live custody mirrors from persistence before allowing
    // readiness rather than cancelling with stale process memory.
    try {
      await inventorySystem.reloadFromDatabase(playerId);
      await this.reloadFromDatabase(playerId);
      this.applyCommittedSelectedSpell(playerId, committed.selectedSpell);
      return liveMatches();
    } catch (error) {
      Logger.systemError(
        "EquipmentSystem",
        `Duel preparation strict reconciliation failed for ${playerId}: ${String(error)}`,
      );
      return false;
    }
  }

  private canonicalDuelPreparationPlanSnapshot(
    snapshot: DuelPreparationPlanPersistenceSnapshot,
  ): DuelPreparationPlanPersistenceSnapshot {
    return {
      bank: [...(snapshot?.bank ?? [])]
        .map((row) => ({ ...row }))
        .sort(
          (left, right) =>
            left.tabIndex - right.tabIndex ||
            left.slot - right.slot ||
            left.itemId.localeCompare(right.itemId),
        ),
      inventory: [...(snapshot?.inventory ?? [])]
        .map((row) => ({
          ...row,
          metadata: row.metadata ? { ...row.metadata } : null,
        }))
        .sort((left, right) => left.slotIndex - right.slotIndex),
      equipment: [...(snapshot?.equipment ?? [])]
        .map((row) => ({ ...row }))
        .sort((left, right) => left.slotType.localeCompare(right.slotType)),
      selectedSpell: snapshot?.selectedSpell ?? null,
    };
  }

  private duelPreparationPlanSnapshotsEqual(
    before: DuelPreparationPlanPersistenceSnapshot,
    after: DuelPreparationPlanPersistenceSnapshot,
  ): boolean {
    return JSON.stringify(before) === JSON.stringify(after);
  }

  private duelPreparationPlanCustodyIsConserved(
    before: DuelPreparationPlanPersistenceSnapshot,
    after: DuelPreparationPlanPersistenceSnapshot,
  ): boolean {
    const totals = (snapshot: DuelPreparationPlanPersistenceSnapshot) => {
      const result = new Map<string, number>();
      for (const item of [
        ...snapshot.bank,
        ...snapshot.inventory,
        ...snapshot.equipment,
      ]) {
        result.set(item.itemId, (result.get(item.itemId) ?? 0) + item.quantity);
      }
      return [...result.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
    };
    return JSON.stringify(totals(before)) === JSON.stringify(totals(after));
  }

  private isValidOwnedDuelPreparationCommittedPlan(
    playerId: string,
    snapshot: DuelPreparationPlanPersistenceSnapshot,
  ): boolean {
    if (
      snapshot.inventory.length > 28 ||
      snapshot.bank.length > BANKING_CONSTANTS.MAX_BANK_SLOTS
    ) {
      return false;
    }
    const inventorySlots = new Set<number>();
    for (const row of snapshot.inventory) {
      const item = this.getItemData(row.itemId);
      if (
        !item ||
        !Number.isSafeInteger(row.slotIndex) ||
        row.slotIndex < 0 ||
        row.slotIndex >= 28 ||
        inventorySlots.has(row.slotIndex) ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity <= 0 ||
        (!item.stackable && row.quantity !== 1)
      ) {
        return false;
      }
      inventorySlots.add(row.slotIndex);
    }

    const bankPositions = new Set<string>();
    for (const row of snapshot.bank) {
      const position = `${row.tabIndex}:${row.slot}`;
      if (
        !row.itemId ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity <= 0 ||
        row.quantity > BANKING_CONSTANTS.MAX_ITEM_STACK ||
        !Number.isSafeInteger(row.slot) ||
        row.slot < 0 ||
        row.slot >= BANKING_CONSTANTS.MAX_BANK_SLOTS ||
        !Number.isSafeInteger(row.tabIndex) ||
        row.tabIndex < 0 ||
        row.tabIndex >= BANKING_CONSTANTS.MAX_TABS ||
        bankPositions.has(position)
      ) {
        return false;
      }
      bankPositions.add(position);
    }

    const equipmentSlots = new Set<string>();
    let weapon: Item | null = null;
    let arrows: EquipmentSaveItem | null = null;
    let shieldPresent = false;
    for (const row of snapshot.equipment) {
      const item = this.getItemData(row.itemId);
      if (
        !item ||
        !this.isValidEquipmentSlot(row.slotType) ||
        equipmentSlots.has(row.slotType) ||
        this.getEquipmentSlot(item) !== row.slotType ||
        !this.meetsLevelRequirements(playerId, item) ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity <= 0 ||
        (row.slotType !== "arrows" && row.quantity !== 1) ||
        (row.slotType === "arrows" && !item.stackable)
      ) {
        return false;
      }
      equipmentSlots.add(row.slotType);
      if (row.slotType === "weapon") weapon = item;
      if (row.slotType === "arrows") arrows = row;
      if (row.slotType === "shield") shieldPresent = true;
    }
    if (weapon && this.is2hWeapon(weapon) && shieldPresent) return false;
    if (
      weapon?.attackType?.toLowerCase() === "ranged" &&
      (!arrows ||
        !ammunitionService.areArrowsCompatible(weapon.id, arrows.itemId))
    ) {
      return false;
    }

    if (snapshot.selectedSpell !== null) {
      const spell = COMBAT_SPELLS[snapshot.selectedSpell];
      if (!spell || (this.getPlayerSkills(playerId).magic ?? 1) < spell.level) {
        return false;
      }
      const runes = snapshot.inventory.map((row) => ({
        slot: row.slotIndex,
        itemId: row.itemId,
        quantity: row.quantity,
      }));
      if (!runeService.hasRequiredRunes(runes, spell.runes, weapon).valid) {
        return false;
      }
    }
    return true;
  }

  /**
   * Switch among an exact set of pre-market combat loadouts without ever
   * splitting inventory, equipment, and autocast persistence. The database
   * commit is fenced by the complete pre-state and carries a durable operation
   * receipt, so retrying after an ambiguous response cannot move items twice.
   */
  async switchOwnedCombatLoadout(
    playerId: string,
    request: FrozenCombatLoadoutSwitchRequest,
  ): Promise<FrozenCombatLoadoutSwitchReceipt> {
    const operationId = String(request.operationId ?? "").trim();
    const failure = (
      reason: FrozenCombatLoadoutSwitchFailureReason,
    ): FrozenCombatLoadoutSwitchReceipt => ({
      ok: false,
      playerId,
      operationId,
      targetRole: request.targetRole,
      changed: false,
      replayed: false,
      reason,
    });

    if (!this.world.getPlayer(playerId)) return failure("player_missing");
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) return failure("equipment_not_initialized");
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    const inventory = inventorySystem?.getInventory(playerId);
    if (!inventorySystem || !inventory) {
      return failure("inventory_not_initialized");
    }
    if (!this.databaseSystem?.commitCombatLoadoutOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }

    const target = request.allowedLoadouts[request.targetRole];
    if (!target || target.role !== request.targetRole) {
      return failure("target_not_frozen");
    }
    if (!this.isValidFrozenCombatLoadout(playerId, target)) {
      return failure("target_loadout_invalid");
    }
    if (!operationId || !String(request.requestFingerprint ?? "").trim()) {
      return failure("target_loadout_invalid");
    }
    const publicActionObservation =
      request.publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelRoleSwitchObservationContext(
            request.publicActionObservation,
          );
    if (
      request.publicActionObservation !== undefined &&
      (!publicActionObservation ||
        publicActionObservation.actorId !== playerId ||
        publicActionObservation.targetRole !== request.targetRole)
    ) {
      return failure("target_loadout_invalid");
    }
    let result: FrozenCombatLoadoutSwitchReceipt = failure("inventory_busy");
    await inventorySystem.queueOperation(playerId, async () => {
      if (!inventorySystem.lockForTransaction(playerId)) {
        result = failure("inventory_busy");
        return false;
      }

      try {
        const expected = this.snapshotCombatLoadoutPersistence(playerId);
        const built = this.buildCommittedCombatLoadoutSnapshot(
          playerId,
          target,
          expected,
        );
        if (!built.snapshot) {
          result = failure(built.reason!);
          return false;
        }
        const committed = built.snapshot;

        let receipt;
        try {
          receipt = await this.queueEquipmentPersistence(playerId, () =>
            this.databaseSystem!.commitCombatLoadoutOperationAsync({
              operationId,
              playerId,
              requestFingerprint: request.requestFingerprint,
              expected,
              committed,
              ...(publicActionObservation ? { publicActionObservation } : {}),
            }),
          );
        } catch (error) {
          Logger.systemError(
            "EquipmentSystem",
            `Atomic combat loadout commit failed for ${playerId}: ${String(error)}`,
          );
          result = failure("persistence_failed");
          return false;
        }

        if (
          !this.canApplyCommittedCombatEquipment(receipt.committed.equipment)
        ) {
          result = failure("committed_state_apply_failed");
          return false;
        }
        if (
          !inventorySystem.applyCommittedCombatLoadoutInventory(
            playerId,
            receipt.committed.inventory,
          )
        ) {
          result = failure("committed_state_apply_failed");
          return false;
        }
        this.applyCommittedCombatEquipment(
          playerId,
          receipt.committed.equipment,
        );
        this.applyCommittedSelectedSpell(
          playerId,
          receipt.committed.selectedSpell,
        );

        result = {
          ok: true,
          playerId,
          operationId,
          targetRole: request.targetRole,
          changed: !this.combatLoadoutSnapshotsEqual(
            expected,
            receipt.committed,
          ),
          replayed: receipt.replayed,
        };
        return true;
      } finally {
        inventorySystem.unlockTransaction(playerId);
      }
    });
    return result;
  }

  private isValidFrozenCombatLoadout(
    playerId: string,
    loadout: FrozenCombatLoadoutDefinition,
  ): boolean {
    const weapon = this.getItemData(loadout.weaponId);
    if (
      !weapon ||
      weapon.type !== ItemType.WEAPON ||
      this.getEquipmentSlot(weapon) !== "weapon" ||
      !this.meetsLevelRequirements(playerId, weapon)
    ) {
      return false;
    }
    const attackType = String(weapon.attackType ?? "").toLowerCase();
    if (
      (loadout.role === "melee" && attackType !== "melee") ||
      (loadout.role === "ranged" && attackType !== "ranged") ||
      (loadout.role === "mage" && attackType !== "magic")
    ) {
      return false;
    }

    if (loadout.shieldId) {
      const shield = this.getItemData(loadout.shieldId);
      if (
        !shield ||
        this.getEquipmentSlot(shield) !== "shield" ||
        !this.meetsLevelRequirements(playerId, shield) ||
        this.is2hWeapon(weapon)
      ) {
        return false;
      }
    }

    if (loadout.armorIds !== undefined) {
      if (
        !loadout.armorIds ||
        typeof loadout.armorIds !== "object" ||
        Array.isArray(loadout.armorIds) ||
        Object.keys(loadout.armorIds).length !==
          FROZEN_COMBAT_ARMOR_SLOTS.length ||
        FROZEN_COMBAT_ARMOR_SLOTS.some(
          (slot) =>
            !Object.prototype.hasOwnProperty.call(loadout.armorIds, slot),
        )
      ) {
        return false;
      }
      for (const slot of FROZEN_COMBAT_ARMOR_SLOTS) {
        const itemId = loadout.armorIds[slot];
        if (itemId === null) continue;
        if (typeof itemId !== "string" || itemId.length === 0) return false;
        const armor = this.getItemData(itemId);
        if (
          !armor ||
          armor.type !== ItemType.ARMOR ||
          this.getEquipmentSlot(armor) !== slot ||
          !this.meetsLevelRequirements(playerId, armor)
        ) {
          return false;
        }
      }
    }

    if (loadout.role === "ranged") {
      if (!loadout.arrowsId || loadout.spellId !== null) return false;
      const arrows = this.getItemData(loadout.arrowsId);
      if (
        !arrows ||
        this.getEquipmentSlot(arrows) !== "arrows" ||
        !this.meetsLevelRequirements(playerId, arrows) ||
        !ammunitionService.areArrowsCompatible(
          loadout.weaponId,
          loadout.arrowsId,
        )
      ) {
        return false;
      }
    } else if (loadout.arrowsId !== null) {
      return false;
    }

    if (loadout.role === "mage") {
      if (!loadout.spellId || !COMBAT_SPELLS[loadout.spellId]) return false;
    } else if (loadout.spellId !== null) {
      return false;
    }
    return true;
  }

  private snapshotCombatLoadoutPersistence(
    playerId: string,
  ): CombatLoadoutPersistenceSnapshot {
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem;
    const inventory = inventorySystem.getInventory(playerId);
    const equipment = this.playerEquipment.get(playerId);
    const inventoryRows: InventorySaveItem[] = (inventory?.items ?? [])
      .map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity,
        slotIndex: item.slot,
        metadata: null,
      }))
      .sort((a, b) => a.slotIndex - b.slotIndex);
    const equipmentRows: EquipmentSaveItem[] = [];
    if (equipment) {
      for (const slotName of EQUIPMENT_SLOT_NAMES) {
        const slot = equipment[slotName] as EquipmentSlot | null | undefined;
        if (!slot?.itemId) continue;
        equipmentRows.push({
          slotType: slotName,
          itemId: String(slot.itemId),
          quantity: slot.quantity ?? 1,
        });
      }
    }
    equipmentRows.sort((a, b) => a.slotType.localeCompare(b.slotType));
    const entitySpell = (
      this.world.entities.get(playerId)?.data as {
        selectedSpell?: string | null;
      }
    )?.selectedSpell;
    const playerSpell = (
      this.world.getPlayer(playerId)?.data as {
        selectedSpell?: string | null;
      }
    )?.selectedSpell;
    return {
      inventory: inventoryRows,
      equipment: equipmentRows,
      selectedSpell: playerSpell ?? entitySpell ?? null,
    };
  }

  private buildCommittedCombatLoadoutSnapshot(
    playerId: string,
    target: FrozenCombatLoadoutDefinition,
    expected: CombatLoadoutPersistenceSnapshot,
  ): {
    snapshot?: CombatLoadoutPersistenceSnapshot;
    reason?: FrozenCombatLoadoutSwitchFailureReason;
  } {
    const mutablePool: CombatCustodyItem[] = [];
    const mutableEquipmentSlots = new Set(["weapon", "arrows", "shield"]);
    if (target.armorIds !== undefined) {
      for (const slot of FROZEN_COMBAT_ARMOR_SLOTS) {
        mutableEquipmentSlots.add(slot);
      }
    }
    for (const slotName of mutableEquipmentSlots) {
      const row = expected.equipment.find((item) => item.slotType === slotName);
      if (row) {
        mutablePool.push({
          itemId: row.itemId,
          quantity: row.quantity,
          preferredInventorySlot: null,
        });
      }
    }
    for (const row of expected.inventory) {
      mutablePool.push({
        itemId: row.itemId,
        quantity: row.quantity,
        preferredInventorySlot: row.slotIndex,
      });
    }

    const consume = (itemId: string, quantity: number): boolean => {
      let remaining = quantity;
      for (const entry of mutablePool) {
        if (entry.itemId !== itemId || entry.quantity <= 0) continue;
        const taken = Math.min(entry.quantity, remaining);
        entry.quantity -= taken;
        remaining -= taken;
        if (remaining === 0) return true;
      }
      return false;
    };
    const totalQuantity = (itemId: string): number =>
      mutablePool
        .filter((item) => item.itemId === itemId)
        .reduce((total, item) => total + item.quantity, 0);

    if (!consume(target.weaponId, 1)) {
      return { reason: "target_item_not_owned" };
    }
    if (target.shieldId && !consume(target.shieldId, 1)) {
      return { reason: "target_item_not_owned" };
    }
    if (target.armorIds !== undefined) {
      for (const slot of FROZEN_COMBAT_ARMOR_SLOTS) {
        const itemId = target.armorIds[slot];
        if (itemId && !consume(itemId, 1)) {
          return { reason: "target_item_not_owned" };
        }
      }
    }
    let arrowsQuantity = 0;
    if (target.arrowsId) {
      arrowsQuantity = totalQuantity(target.arrowsId);
      if (arrowsQuantity <= 0 || !consume(target.arrowsId, arrowsQuantity)) {
        return { reason: "target_item_not_owned" };
      }
    }

    if (target.role === "mage") {
      const spell = target.spellId ? COMBAT_SPELLS[target.spellId] : null;
      const weapon = this.getItemData(target.weaponId);
      const remainingInventory = mutablePool
        .filter((item) => item.quantity > 0)
        .map((item, slot) => ({
          slot,
          itemId: item.itemId,
          quantity: item.quantity,
        }));
      if (
        !spell ||
        !runeService.hasRequiredRunes(remainingInventory, spell.runes, weapon)
          .valid
      ) {
        return { reason: "target_item_not_owned" };
      }
    }

    const packed: CombatCustodyItem[] = [];
    const candidates = mutablePool
      .filter((item) => item.quantity > 0)
      .sort((a, b) => {
        if (a.preferredInventorySlot === null) return 1;
        if (b.preferredInventorySlot === null) return -1;
        return a.preferredInventorySlot - b.preferredInventorySlot;
      });
    for (const candidate of candidates) {
      const item = this.getItemData(candidate.itemId);
      if (!item) return { reason: "target_loadout_invalid" };
      if (item.stackable) {
        const existing = packed.find(
          (entry) => entry.itemId === candidate.itemId,
        );
        if (existing) {
          existing.quantity += candidate.quantity;
          if (existing.quantity > 2_147_483_647) {
            return { reason: "target_loadout_invalid" };
          }
          continue;
        }
      }
      packed.push({ ...candidate });
    }
    if (packed.length > 28) {
      return { reason: "inventory_capacity_exceeded" };
    }

    const usedSlots = new Set<number>();
    for (const item of packed) {
      if (
        item.preferredInventorySlot !== null &&
        !usedSlots.has(item.preferredInventorySlot)
      ) {
        usedSlots.add(item.preferredInventorySlot);
      } else {
        item.preferredInventorySlot = null;
      }
    }
    for (const item of packed) {
      if (item.preferredInventorySlot !== null) continue;
      let slot = 0;
      while (usedSlots.has(slot) && slot < 28) slot++;
      if (slot >= 28) return { reason: "inventory_capacity_exceeded" };
      item.preferredInventorySlot = slot;
      usedSlots.add(slot);
    }

    const inventory = packed
      .map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity,
        slotIndex: item.preferredInventorySlot!,
        metadata: null,
      }))
      .sort((a, b) => a.slotIndex - b.slotIndex);
    const equipment = expected.equipment.filter(
      (item) => !mutableEquipmentSlots.has(item.slotType),
    );
    equipment.push({
      slotType: "weapon",
      itemId: target.weaponId,
      quantity: 1,
    });
    if (target.shieldId) {
      equipment.push({
        slotType: "shield",
        itemId: target.shieldId,
        quantity: 1,
      });
    }
    if (target.armorIds !== undefined) {
      for (const slotType of FROZEN_COMBAT_ARMOR_SLOTS) {
        const itemId = target.armorIds[slotType];
        if (!itemId) continue;
        equipment.push({
          slotType,
          itemId,
          quantity: 1,
        });
      }
    }
    if (target.arrowsId) {
      equipment.push({
        slotType: "arrows",
        itemId: target.arrowsId,
        quantity: arrowsQuantity,
      });
    }
    equipment.sort((a, b) => a.slotType.localeCompare(b.slotType));
    const snapshot: CombatLoadoutPersistenceSnapshot = {
      inventory,
      equipment,
      selectedSpell: target.spellId,
    };
    if (!this.combatLoadoutCustodyIsConserved(expected, snapshot)) {
      Logger.systemError(
        "EquipmentSystem",
        `Rejected non-conserving combat loadout transition for ${playerId}`,
      );
      return { reason: "target_loadout_invalid" };
    }
    return { snapshot };
  }

  private combatLoadoutCustodyIsConserved(
    before: CombatLoadoutPersistenceSnapshot,
    after: CombatLoadoutPersistenceSnapshot,
  ): boolean {
    const totals = (snapshot: CombatLoadoutPersistenceSnapshot) => {
      const result = new Map<string, number>();
      for (const item of [...snapshot.inventory, ...snapshot.equipment]) {
        result.set(item.itemId, (result.get(item.itemId) ?? 0) + item.quantity);
      }
      return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
    };
    return JSON.stringify(totals(before)) === JSON.stringify(totals(after));
  }

  private combatLoadoutSnapshotsEqual(
    before: CombatLoadoutPersistenceSnapshot,
    after: CombatLoadoutPersistenceSnapshot,
  ): boolean {
    return JSON.stringify(before) === JSON.stringify(after);
  }

  private canApplyCommittedCombatEquipment(rows: EquipmentSaveItem[]): boolean {
    const seen = new Set<string>();
    for (const row of rows) {
      if (
        !this.isValidEquipmentSlot(row.slotType) ||
        seen.has(row.slotType) ||
        !this.getItemData(row.itemId) ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity <= 0
      ) {
        return false;
      }
      seen.add(row.slotType);
    }
    return true;
  }

  /**
   * Serialize cross-system inventory/equipment custody instead of rejecting a
   * projectile merely because food, banking, or another receipt currently
   * owns the player's transaction lock.
   */
  private async queueInventoryTransaction<T>(
    inventorySystem: InventorySystem,
    playerId: string,
    busyResult: T,
    operation: () => Promise<T>,
  ): Promise<T> {
    let result = busyResult;
    await inventorySystem.queueOperation(playerId, async () => {
      if (!inventorySystem.lockForTransaction(playerId)) return false;
      try {
        result = await operation();
        return true;
      } finally {
        inventorySystem.unlockTransaction(playerId);
      }
    });
    return result;
  }

  private applyCommittedCombatEquipment(
    playerId: string,
    rows: EquipmentSaveItem[],
  ): void {
    const equipment = this.playerEquipment.get(playerId)!;
    const bySlot = new Map(rows.map((row) => [row.slotType, row]));
    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment[slotName] as EquipmentSlot | null | undefined;
      if (!slot) continue;
      const row = bySlot.get(slotName);
      slot.itemId = row?.itemId ?? null;
      slot.item = row ? this.getItemData(row.itemId) : null;
      slot.quantity = row?.quantity;
    }
    this.recalculateStats(playerId);
    this.sendEquipmentUpdated(playerId);
    this.emitEquipmentChangedForAllSlots(playerId);
  }

  private applyCommittedSelectedSpell(
    playerId: string,
    spellId: string | null,
  ): void {
    const entity = this.world.entities.get(playerId);
    if (entity?.data) {
      (entity.data as { selectedSpell?: string | null }).selectedSpell =
        spellId;
    }
    const player = this.world.getPlayer(playerId);
    if (player?.data) {
      (player.data as { selectedSpell?: string | null }).selectedSpell =
        spellId;
    }
    this.emitTypedEvent(EventType.PLAYER_SET_AUTOCAST, { playerId, spellId });
  }

  /**
   * Get equipped items as a simplified data object.
   *
   * Returns only the Item data for each slot (no slot metadata).
   * Useful for serialization or when only item info is needed.
   *
   * @param playerId - The player ID to look up
   * @returns Record with slot names as keys and Item data (or null) as values
   *
   * @example
   * const data = equipmentSystem.getEquipmentData(playerId);
   * // { weapon: { id: "bronze_sword", ... }, shield: null, ... }
   */
  getEquipmentData(playerId: string): Record<string, unknown> {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) return {};

    const data: Record<string, unknown> = {};
    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment[slotName] as EquipmentSlot | null | undefined;
      data[slotName] = slot?.item || null;
    }
    return data;
  }

  /**
   * Get total stat bonuses from all equipped items.
   *
   * Aggregates attack, strength, defense, ranged, and constitution
   * bonuses from all equipped gear. Used by combat calculations.
   *
   * @param playerId - The player ID to look up
   * @returns Record with stat names and their total bonus values
   *
   * @example
   * const stats = equipmentSystem.getEquipmentStats(playerId);
   * const totalAttack = baseAttack + stats.attack;
   */
  getEquipmentStats(playerId: string): Record<string, number> {
    const equipment = this.playerEquipment.get(playerId);
    return (
      equipment?.totalStats || {
        attack: 0,
        strength: 0,
        defense: 0,
        ranged: 0,
        constitution: 0,
      }
    );
  }

  /**
   * Check if a specific item is currently equipped by a player.
   *
   * Searches all equipment slots for the given item ID.
   *
   * @param playerId - The player ID to check
   * @param itemId - The item ID to search for
   * @returns true if item is equipped in any slot
   *
   * @example
   * if (equipmentSystem.isItemEquipped(playerId, bronzeSwordId)) {
   *   console.log("Player has bronze sword equipped");
   * }
   */
  isItemEquipped(playerId: string, itemId: number | string): boolean {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) return false;

    const itemIdStr = itemId.toString();
    return EQUIPMENT_SLOT_NAMES.some((name) => {
      const slot = equipment[name] as EquipmentSlot | null;
      return slot?.itemId === itemIdStr;
    });
  }

  /**
   * Check if a player can equip a specific item.
   *
   * Validates:
   * - Item exists in manifest
   * - Item is equippable (has equipment slot)
   * - Player meets all skill level requirements
   *
   * Does NOT check inventory space for unequipping current item.
   *
   * @param playerId - The player ID to check
   * @param itemId - The item ID to validate
   * @returns true if player meets all requirements to equip the item
   *
   * @example
   * if (!equipmentSystem.canEquipItem(playerId, mithrilSwordId)) {
   *   showMessage("You don't meet the level requirements for this item.");
   * }
   */
  canEquipItem(playerId: string, itemId: number): boolean {
    const itemData = this.getItemData(itemId);
    if (!itemData) return false;

    const equipSlot = this.getEquipmentSlot(itemData);
    if (!equipSlot) return false;

    return this.meetsLevelRequirements(playerId, itemData);
  }

  // ========== Bank Equipment Tab API ==========
  // These methods support direct equip/unequip from bank without using inventory

  /**
   * Get the equipment slot name for an item.
   *
   * Used by bank equipment tab to determine if item can be withdrawn to equipment
   * and which slot it would go to.
   *
   * @param itemId - The item ID to check
   * @returns Slot name (weapon, shield, etc.) or null if not equipable
   *
   * @example
   * const slot = equipmentSystem.getEquipmentSlotForItem("bronze_sword");
   * // Returns: "weapon"
   */
  getEquipmentSlotForItem(itemId: string | number): string | null {
    const itemData = this.getItemData(itemId);
    if (!itemData) return null;
    return this.getEquipmentSlot(itemData);
  }

  /**
   * Check if a player meets level requirements to equip an item.
   *
   * Used by bank equipment tab to validate before attempting equip.
   *
   * @param playerId - The player ID
   * @param itemId - The item ID to check
   * @returns true if player meets requirements
   */
  canPlayerEquipItem(playerId: string, itemId: string | number): boolean {
    const itemData = this.getItemData(itemId);
    if (!itemData) return false;

    const equipSlot = this.getEquipmentSlot(itemData);
    if (!equipSlot) return false;

    return this.meetsLevelRequirements(playerId, itemData);
  }

  /**
   * Equip item directly (bypassing inventory).
   *
   * Used by bank equipment tab to equip items directly from bank.
   * Does NOT remove from inventory - caller is responsible for bank item removal.
   * Handles 2h weapon/shield conflicts and returns displaced items.
   *
   * @param playerId - The player ID
   * @param itemId - The item ID to equip
   * @param quantity - Exact stack quantity to persist (stackable items only)
   * @returns Result with success status and any displaced items
   *
   * @example
   * const result = await equipmentSystem.equipItemDirect(playerId, "bronze_sword");
   * if (result.success) {
   *   // Item equipped, handle result.displacedItems if any
   * }
   */
  async equipItemDirect(
    playerId: string,
    itemId: string | number,
    quantity: number = 1,
  ): Promise<{
    success: boolean;
    error?: string;
    equippedSlot?: string;
    displacedItems: Array<{ itemId: string; slot: string; quantity: number }>;
  }> {
    const displacedItems: Array<{
      itemId: string;
      slot: string;
      quantity: number;
    }> = [];

    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return {
        success: false,
        error: "Equipment not initialized",
        displacedItems,
      };
    }

    const itemData = this.getItemData(itemId);
    if (!itemData) {
      return { success: false, error: "Item not found", displacedItems };
    }

    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      (!itemData.stackable && quantity !== 1)
    ) {
      return {
        success: false,
        error: "Invalid equipment quantity",
        displacedItems,
      };
    }

    const slotName = this.getEquipmentSlot(itemData);
    if (!slotName) {
      return { success: false, error: "Item is not equipable", displacedItems };
    }

    if (!this.meetsLevelRequirements(playerId, itemData)) {
      return {
        success: false,
        error: "Level requirements not met",
        displacedItems,
      };
    }

    // Handle 2h weapon logic
    const is2hWeapon = this.is2hWeapon(itemData);
    const currentWeapon = equipment.weapon?.item;
    const currentWeaponIs2h = currentWeapon
      ? this.is2hWeapon(currentWeapon)
      : false;

    // If equipping a 2h weapon, collect shield for displacement
    if (is2hWeapon && slotName === "weapon" && equipment.shield?.itemId) {
      const shieldItemId = equipment.shield.itemId?.toString() || "";
      displacedItems.push({
        itemId: shieldItemId,
        slot: "shield",
        quantity: 1,
      });

      // Clear shield slot
      equipment.shield.itemId = null;
      equipment.shield.item = null;

      // Emit change event for shield
      this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
        playerId,
        slot: "shield" as EquipmentSlotName,
        itemId: null,
      });
    }

    // If equipping a shield and 2h weapon equipped, reject
    if (slotName === "shield" && currentWeaponIs2h) {
      return {
        success: false,
        error: "Cannot equip shield with 2h weapon",
        displacedItems,
      };
    }

    // Collect current item in target slot for displacement
    if (!this.isValidEquipmentSlot(slotName)) {
      return {
        success: false,
        error: "Invalid equipment slot",
        displacedItems,
      };
    }

    const targetSlot = equipment[slotName] as EquipmentSlot | undefined;
    if (targetSlot?.itemId) {
      const currentItemId = targetSlot.itemId?.toString() || "";
      displacedItems.push({
        itemId: currentItemId,
        slot: slotName,
        quantity: targetSlot.quantity ?? 1,
      });

      // Clear the slot
      targetSlot.itemId = null;
      targetSlot.item = null;
      targetSlot.quantity = undefined;
    }

    // Equip the new item
    if (targetSlot) {
      targetSlot.itemId = itemId;
      targetSlot.item = itemData;
      targetSlot.quantity = itemData.stackable ? quantity : 1;
    }

    // Update stats
    this.recalculateStats(playerId);

    // Emit change event
    this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
      playerId,
      slot: slotName as EquipmentSlotName,
      itemId: itemId?.toString() || null,
    });

    // Send equipment state to client
    this.sendEquipmentUpdated(playerId);

    // Save to database
    await this.saveEquipmentToDatabase(playerId);

    return { success: true, equippedSlot: slotName, displacedItems };
  }

  /**
   * Unequip item directly (bypassing inventory).
   *
   * Used by bank equipment tab to deposit worn equipment directly to bank.
   * Does NOT add to inventory - caller is responsible for bank item addition.
   *
   * @param playerId - The player ID
   * @param slotName - The slot to unequip (weapon, shield, etc.)
   * @returns Result with success status and the unequipped item
   *
   * @example
   * const result = await equipmentSystem.unequipItemDirect(playerId, "weapon");
   * if (result.success && result.itemId) {
   *   // Add result.itemId to bank
   * }
   */
  async unequipItemDirect(
    playerId: string,
    slotName: string,
  ): Promise<{
    success: boolean;
    error?: string;
    itemId?: string;
    quantity: number;
  }> {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return {
        success: false,
        error: "Equipment not initialized",
        quantity: 0,
      };
    }

    if (!this.isValidEquipmentSlot(slotName)) {
      return { success: false, error: "Invalid slot", quantity: 0 };
    }

    const slot = equipment[slotName] as EquipmentSlot | undefined;
    if (!slot || !slot.itemId) {
      return { success: false, error: "Slot is empty", quantity: 0 };
    }

    const itemId = slot.itemId?.toString() || "";
    const quantity = slot.quantity ?? 1;

    // Clear slot (including quantity)
    slot.itemId = null;
    slot.item = null;
    slot.quantity = undefined;

    // Update stats
    this.recalculateStats(playerId);

    // Emit change event
    this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_CHANGED, {
      playerId,
      slot: slotName as EquipmentSlotName,
      itemId: null,
    });

    // Send equipment state to client
    this.sendEquipmentUpdated(playerId);

    // Save to database
    await this.saveEquipmentToDatabase(playerId);

    return { success: true, itemId, quantity };
  }

  /**
   * Get all equipped items for deposit-all operation.
   *
   * Used by bank equipment tab "Deposit Worn Items" button.
   *
   * @param playerId - The player ID
   * @returns Array of all equipped item info
   */
  getAllEquippedItems(
    playerId: string,
  ): Array<{ slot: string; itemId: string; quantity: number }> {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) return [];

    const result: Array<{ slot: string; itemId: string; quantity: number }> =
      [];

    for (const slotName of EQUIPMENT_SLOT_NAMES) {
      const slot = equipment[slotName] as EquipmentSlot | undefined;
      if (slot?.itemId) {
        result.push({
          slot: slotName,
          itemId: slot.itemId.toString(),
          quantity: slot.quantity ?? 1,
        });
      }
    }

    return result;
  }

  /**
   * Get the quantity of arrows currently equipped.
   *
   * Queries the inventory system for the arrow stack quantity.
   * Used by ranged combat to determine available ammunition.
   *
   * @param playerId - The player ID to check
   * @returns Number of arrows equipped (0 if none)
   *
   * @example
   * const arrows = equipmentSystem.getArrowCount(playerId);
   * if (arrows === 0) {
   *   showMessage("You're out of arrows!");
   * }
   */
  getArrowCount(playerId: string): number {
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment || !equipment.arrows?.item || !equipment.arrows.itemId) {
      return 0;
    }

    // Arrows are stored directly in the equipment slot with quantity
    return equipment.arrows.quantity ?? 0;
  }

  /**
   * Freeze one projectile's ammunition debit and recovery result before the
   * projectile becomes visible. A recovered source remains unpresented until
   * the authoritative hit path exposes its committed receipt.
   */
  public async consumeArrowForProjectileAtomic(
    playerId: string,
    operationId: string,
    expectedArrowId: string,
    recoveryDisposition: AmmunitionRecoveryDisposition,
    recoveryPosition: { x: number; y: number; z: number } | null,
  ): Promise<AtomicAmmunitionShotReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const arrowId = String(expectedArrowId ?? "").trim();
    const failure = (
      reason: AtomicArrowDebitFailureReason,
    ): AtomicAmmunitionShotReceipt => ({
      ok: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      arrowId,
      changed: false,
      replayed: false,
      reason,
    });
    if (
      !normalizedPlayerId ||
      !/^ammunition-shot:[A-Za-z0-9]{20}$/.test(normalizedOperationId) ||
      !arrowId ||
      arrowId.length > 256 ||
      !this.getItemData(arrowId) ||
      (recoveryDisposition !== "recovered" &&
        recoveryDisposition !== "destroyed") ||
      (recoveryDisposition === "recovered"
        ? !recoveryPosition ||
          !Object.values(recoveryPosition).every(Number.isFinite)
        : recoveryPosition !== null)
    ) {
      return failure("invalid_request");
    }
    const equipment = this.playerEquipment.get(normalizedPlayerId);
    if (!equipment) return failure("equipment_not_initialized");
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    if (!inventorySystem) return failure("inventory_not_initialized");
    const groundItems = this.world.getSystem<GroundItemSystem>("ground-items");
    const db = this.databaseSystem;
    if (!db?.commitAmmunitionShotOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }
    return this.queueInventoryTransaction(
      inventorySystem,
      normalizedPlayerId,
      failure("inventory_busy"),
      async () => {
        const currentArrow = equipment.arrows;
        if (
          !currentArrow?.item ||
          currentArrow.itemId?.toString() !== arrowId ||
          !Number.isSafeInteger(currentArrow.quantity ?? 0) ||
          (currentArrow.quantity ?? 0) <= 0
        ) {
          return failure("insufficient_items");
        }
        const preparedSource =
          recoveryDisposition === "recovered" && recoveryPosition && groundItems
            ? await groundItems.prepareDurableSourceRegistration(
                arrowId,
                1,
                recoveryPosition,
                {
                  despawnTime: 120_000,
                  droppedBy: normalizedPlayerId,
                  lootProtection: 0,
                },
              )
            : null;
        if (recoveryDisposition === "recovered" && !preparedSource) {
          return failure("atomic_persistence_unavailable");
        }
        let source = preparedSource;
        if (source?.allowMerge) {
          const sourceInput = {
            contributionId: source.contributionId,
            preferredSourceId: source.preferredSourceId,
            itemId: source.itemId,
            quantity: source.quantity,
            stackable: source.stackable,
            position: { ...source.position },
            tile: { ...source.tile },
            droppedBy: source.droppedBy,
            lifetimeMs: source.lifetimeMs,
            lootProtectionMs: source.lootProtectionMs,
            allowMerge: false,
          };
          source = {
            ...sourceInput,
            requestFingerprint: await equipmentDebitSha256Hex(
              serializeGroundItemSourceRegistrationFingerprint(sourceInput),
            ),
          };
        }
        const requestWithoutFingerprint: Omit<
          AmmunitionShotCommitRequest,
          "requestFingerprint"
        > = {
          operationId: normalizedOperationId,
          playerId: normalizedPlayerId,
          itemId: arrowId,
          quantity: 1,
          recoveryDisposition,
          source,
        };
        let requestFingerprint: string;
        try {
          requestFingerprint = await equipmentDebitSha256Hex(
            serializeAmmunitionShotFingerprint(
              ammunitionShotIdentityFromRequest(requestWithoutFingerprint),
            ),
          );
        } catch {
          return failure("atomic_persistence_unavailable");
        }
        const request: AmmunitionShotCommitRequest = {
          ...requestWithoutFingerprint,
          requestFingerprint,
        };
        let receipt;
        try {
          receipt = await db.commitAmmunitionShotOperationAsync(request);
        } catch (firstError) {
          if (!shouldRetryAmmunitionShotCommit(firstError)) {
            return failure(equipmentStackDebitFailureReason(firstError));
          }
          try {
            receipt = await db.commitAmmunitionShotOperationAsync(request);
          } catch (retryError) {
            Logger.systemError(
              "EquipmentSystem",
              `Atomic ammunition shot failed for ${normalizedPlayerId}: ${String(retryError)}`,
            );
            return failure(equipmentStackDebitFailureReason(retryError));
          }
        }
        const receiptIdentity = ammunitionShotIdentityFromRequest({
          operationId: receipt.operationId,
          playerId: receipt.playerId,
          itemId: receipt.itemId,
          quantity: receipt.quantity,
          recoveryDisposition: receipt.recoveryDisposition,
          source: receipt.sourceRequest,
        });
        const receiptFingerprint = await equipmentDebitSha256Hex(
          serializeAmmunitionShotFingerprint(receiptIdentity),
        );
        const recoveryReceiptValid =
          recoveryDisposition === "recovered"
            ? receipt.sourceRequest !== null && receipt.source === null
            : receipt.sourceRequest === null && receipt.source === null;
        if (
          receipt.operationId !== normalizedOperationId ||
          receipt.playerId !== normalizedPlayerId ||
          receipt.requestFingerprint !== requestFingerprint ||
          receiptFingerprint !== requestFingerprint ||
          typeof receipt.replayed !== "boolean" ||
          receipt.itemId !== arrowId ||
          receipt.quantity !== 1 ||
          receipt.recoveryDisposition !== recoveryDisposition ||
          receipt.status !== "pending" ||
          receipt.refundDestination !== null ||
          !recoveryReceiptValid
        ) {
          return failure("persistence_failed");
        }
        if (!this.canApplyCommittedCombatEquipment(receipt.committed)) {
          await this.convergeEquipmentFromDatabase(normalizedPlayerId);
          return failure("committed_state_apply_failed");
        }
        this.applyCommittedCombatEquipment(
          normalizedPlayerId,
          receipt.committed,
        );
        return {
          ok: true,
          playerId: normalizedPlayerId,
          operationId: normalizedOperationId,
          arrowId,
          changed: true,
          replayed: receipt.replayed,
          requestFingerprint,
          status: receipt.status,
          recoveryDisposition,
          recoverySource: receipt.source,
        };
      },
    );
  }

  /** Finalize a staged debit after its reserved projectile is locally active. */
  public async completeArrowProjectileAtomic(
    staged: AmmunitionShotSettlementHandle,
  ): Promise<AtomicAmmunitionShotReceipt> {
    return this.settleArrowProjectileAtomic(staged, "fired");
  }

  /** Refund a pending debit, or terminally resolve an already-fired shot. */
  public async cancelArrowProjectileAtomic(
    staged: AmmunitionShotSettlementHandle,
  ): Promise<AtomicAmmunitionShotReceipt> {
    return this.settleArrowProjectileAtomic(staged, "cancelled");
  }

  private async settleArrowProjectileAtomic(
    staged: AmmunitionShotSettlementHandle,
    requestedStatus: "fired" | "cancelled",
  ): Promise<AtomicAmmunitionShotReceipt> {
    const failure = (
      reason: AtomicArrowDebitFailureReason,
    ): AtomicAmmunitionShotReceipt => ({
      ok: false,
      playerId: staged.playerId,
      operationId: staged.operationId,
      arrowId: staged.itemId,
      changed: false,
      replayed: false,
      reason,
    });
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    const db = this.databaseSystem;
    const settle =
      requestedStatus === "fired"
        ? db?.completeAmmunitionShotOperationAsync
        : db?.cancelAmmunitionShotOperationAsync;
    if (!inventorySystem || !settle) {
      return failure("atomic_persistence_unavailable");
    }
    return this.queueInventoryTransaction(
      inventorySystem,
      staged.playerId,
      failure("inventory_busy"),
      async () => {
        let receipt;
        const settlementRequest = {
          operationId: staged.operationId,
          playerId: staged.playerId,
          requestFingerprint: staged.requestFingerprint,
        };
        try {
          receipt = await settle.call(db, settlementRequest);
        } catch (firstError) {
          if (!shouldRetryAmmunitionShotCommit(firstError)) {
            return failure(equipmentStackDebitFailureReason(firstError));
          }
          try {
            receipt = await settle.call(db, settlementRequest);
          } catch (retryError) {
            Logger.systemError(
              "EquipmentSystem",
              `Atomic ammunition settlement failed for ${staged.playerId}: ${String(retryError)}`,
            );
            return failure(equipmentStackDebitFailureReason(retryError));
          }
        }
        const receiptIdentity = ammunitionShotIdentityFromRequest({
          operationId: receipt.operationId,
          playerId: receipt.playerId,
          itemId: receipt.itemId,
          quantity: receipt.quantity,
          recoveryDisposition: receipt.recoveryDisposition,
          source: receipt.sourceRequest,
        });
        const receiptFingerprint = await equipmentDebitSha256Hex(
          serializeAmmunitionShotFingerprint(receiptIdentity),
        );
        const launchedStatus =
          receipt.status === "fired" || receipt.status === "resolved";
        const recoveryReceiptValid =
          receipt.recoveryDisposition === "recovered"
            ? receipt.sourceRequest !== null &&
              (!launchedStatus ||
                (receipt.source !== null &&
                  receipt.source.contributionId ===
                    receipt.sourceRequest.contributionId &&
                  receipt.source.requestFingerprint ===
                    receipt.sourceRequest.requestFingerprint)) &&
              (launchedStatus || receipt.source === null)
            : receipt.sourceRequest === null && receipt.source === null;
        if (
          receipt.operationId !== staged.operationId ||
          receipt.playerId !== staged.playerId ||
          receipt.requestFingerprint !== staged.requestFingerprint ||
          receiptFingerprint !== staged.requestFingerprint ||
          typeof receipt.replayed !== "boolean" ||
          receipt.itemId !== staged.itemId ||
          receipt.quantity !== 1 ||
          receipt.recoveryDisposition !== staged.recoveryDisposition ||
          (receipt.status !== "fired" &&
            receipt.status !== "resolved" &&
            receipt.status !== "cancelled") ||
          (receipt.status === "cancelled") !==
            (receipt.refundDestination !== null) ||
          !recoveryReceiptValid
        ) {
          return failure("persistence_failed");
        }
        const projectionLoaded =
          !this.isDestroying &&
          !this.unloadedPlayerEquipment.has(staged.playerId) &&
          this.playerEquipment.has(staged.playerId);
        if (!this.canApplyCommittedCombatEquipment(receipt.committed)) {
          if (projectionLoaded) {
            await this.convergeEquipmentFromDatabase(staged.playerId);
          }
          return failure("committed_state_apply_failed");
        }
        // The database receipt remains authoritative after an unload. Do not
        // recreate either half of the live projection; the next join hydrates
        // both from the committed rows.
        if (!projectionLoaded) {
          return {
            ok: true,
            playerId: staged.playerId,
            operationId: staged.operationId,
            arrowId: staged.itemId,
            changed: true,
            replayed: receipt.replayed,
            requestFingerprint: staged.requestFingerprint,
            status: receipt.status,
            recoveryDisposition: staged.recoveryDisposition,
            recoverySource: receipt.source,
          };
        }
        if (
          !inventorySystem.isInventoryReady(staged.playerId) ||
          !inventorySystem.applyCommittedInventorySnapshot(
            staged.playerId,
            receipt.committedInventory,
          )
        ) {
          await Promise.all([
            this.convergeEquipmentFromDatabase(staged.playerId),
            inventorySystem.reloadFromDatabase(staged.playerId),
          ]);
          return failure("committed_state_apply_failed");
        }
        this.applyCommittedCombatEquipment(staged.playerId, receipt.committed);
        return {
          ok: true,
          playerId: staged.playerId,
          operationId: staged.operationId,
          arrowId: staged.itemId,
          changed: true,
          replayed: receipt.replayed,
          requestFingerprint: staged.requestFingerprint,
          status: receipt.status,
          recoveryDisposition: staged.recoveryDisposition,
          recoverySource: receipt.source,
        };
      },
    );
  }

  /**
   * Debit one exact equipped arrow without exposing a projectile to combat
   * before the database transaction and idempotency receipt have committed.
   * The caller supplies a stable operation identity so a lost response can be
   * retried without charging twice.
   */
  public async consumeArrowAtomic(
    playerId: string,
    operationId: string,
    expectedArrowId: string,
  ): Promise<AtomicArrowDebitReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const arrowId = String(expectedArrowId ?? "").trim();
    const failure = (
      reason: AtomicArrowDebitFailureReason,
    ): AtomicArrowDebitReceipt => ({
      ok: false,
      playerId: normalizedPlayerId,
      operationId: normalizedOperationId,
      arrowId,
      changed: false,
      replayed: false,
      reason,
    });

    if (
      !normalizedPlayerId ||
      !normalizedOperationId ||
      normalizedOperationId.length > 256 ||
      !arrowId ||
      arrowId.length > 256 ||
      !this.getItemData(arrowId)
    ) {
      return failure("invalid_request");
    }
    const equipment = this.playerEquipment.get(normalizedPlayerId);
    if (!equipment) return failure("equipment_not_initialized");
    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    if (!inventorySystem) return failure("inventory_not_initialized");
    const db = this.databaseSystem;
    if (!db?.commitEquipmentStackDebitOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }
    if (!inventorySystem.lockForTransaction(normalizedPlayerId)) {
      return failure("inventory_busy");
    }

    try {
      const currentArrow = equipment.arrows;
      if (
        !currentArrow?.item ||
        currentArrow.itemId?.toString() !== arrowId ||
        !Number.isSafeInteger(currentArrow.quantity ?? 0) ||
        (currentArrow.quantity ?? 0) <= 0
      ) {
        return failure("insufficient_items");
      }

      let requestFingerprint: string;
      try {
        requestFingerprint = await equipmentDebitSha256Hex(
          JSON.stringify({
            version: 1,
            playerId: normalizedPlayerId,
            slotType: "arrows",
            itemId: arrowId,
            quantity: 1,
          }),
        );
      } catch {
        return failure("atomic_persistence_unavailable");
      }

      const request = {
        operationId: normalizedOperationId,
        playerId: normalizedPlayerId,
        requestFingerprint,
        slotType: "arrows",
        itemId: arrowId,
        quantity: 1,
      };
      let receipt;
      try {
        receipt = await db.commitEquipmentStackDebitOperationAsync(request);
      } catch (firstError) {
        if (!shouldRetryEquipmentStackDebit(firstError)) {
          return failure(equipmentStackDebitFailureReason(firstError));
        }
        try {
          receipt = await db.commitEquipmentStackDebitOperationAsync(request);
        } catch (retryError) {
          Logger.systemError(
            "EquipmentSystem",
            `Atomic arrow debit failed for ${normalizedPlayerId}: ${String(retryError)}`,
          );
          return failure(equipmentStackDebitFailureReason(retryError));
        }
      }

      if (
        receipt.operationId !== normalizedOperationId ||
        receipt.playerId !== normalizedPlayerId ||
        receipt.requestFingerprint !== requestFingerprint ||
        receipt.slotType !== "arrows" ||
        receipt.itemId !== arrowId ||
        receipt.quantity !== 1
      ) {
        return failure("persistence_failed");
      }
      if (!this.canApplyCommittedCombatEquipment(receipt.committed)) {
        await this.convergeEquipmentFromDatabase(normalizedPlayerId);
        return failure("committed_state_apply_failed");
      }
      this.applyCommittedCombatEquipment(normalizedPlayerId, receipt.committed);
      return {
        ok: true,
        playerId: normalizedPlayerId,
        operationId: normalizedOperationId,
        arrowId,
        changed: true,
        replayed: receipt.replayed,
      };
    } finally {
      inventorySystem.unlockTransaction(normalizedPlayerId);
    }
  }

  /** Compatibility entry point for non-combat callers. */
  public async consumeArrow(playerId: string): Promise<boolean> {
    const arrowId = this.playerEquipment
      .get(playerId)
      ?.arrows?.itemId?.toString();
    if (!arrowId) return false;
    const receipt = await this.consumeArrowAtomic(
      playerId,
      `arrow-debit:${uuid()}${uuid()}`,
      arrowId,
    );
    return receipt.ok;
  }

  private async convergeEquipmentFromDatabase(playerId: string): Promise<void> {
    if (!this.databaseSystem) return;
    try {
      const rows = (await this.databaseSystem.getPlayerEquipmentAsync(playerId))
        .filter((row) => Boolean(row.itemId))
        .map((row) => ({
          slotType: row.slotType,
          itemId: row.itemId!,
          quantity: row.quantity ?? 1,
        }));
      if (this.canApplyCommittedCombatEquipment(rows)) {
        this.applyCommittedCombatEquipment(playerId, rows);
      }
    } catch (error) {
      Logger.systemError(
        "EquipmentSystem",
        `Failed to converge equipment after committed arrow debit for ${playerId}: ${String(error)}`,
      );
    }
  }

  /**
   * Main update loop
   */
  update(_dt: number): void {
    // No-op: visual equipment attachment will be implemented
    // when proper 3D models are available for equipment items
  }

  private isValidEquipmentSlot(
    slot: string,
  ): slot is keyof Omit<PlayerEquipment, "playerId" | "totalStats"> {
    return Object.values(EquipmentSlotName).includes(slot as EquipmentSlotName);
  }

  /**
   * Cleanup when system is destroyed
   */
  start(): void {
    // Write-through persistence: no auto-save needed, all mutations persist immediately
  }

  /**
   * Async destroy - properly awaits all database saves before cleanup.
   * Call this for graceful shutdown to prevent data loss.
   */
  async destroyAsync(): Promise<void> {
    this.isDestroying = true;
    for (const playerId of this.playerEquipment.keys()) {
      this.unloadedPlayerEquipment.add(playerId);
    }
    // Final save pass for all connected players before shutdown
    if (this.world.isServer && this.databaseSystem) {
      const savePromises: Promise<void>[] = [];
      for (const playerId of this.playerEquipment.keys()) {
        savePromises.push(this.saveEquipmentToDatabase(playerId));
      }
      // Wait for all saves to complete (with error handling)
      const results = await Promise.allSettled(savePromises);
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        Logger.systemError(
          "EquipmentSystem",
          `${failures.length} equipment saves failed during shutdown`,
          new Error("Partial save failure on shutdown"),
        );
      }
    }

    // Clear all player equipment data
    this.playerEquipment.clear();
    this.equipmentCleanupInFlight.clear();
    this.readyPlayerEquipment.clear();
    this.equipmentHydrationGeneration.clear();
    this.equipmentPersistenceTails.clear();

    // Call parent cleanup
    super.destroy();
  }

  destroy(): void {
    // Fire-and-forget async cleanup (best effort for non-async callers)
    this.destroyAsync().catch((err) => {
      Logger.systemError(
        "EquipmentSystem",
        "Error during async destroy",
        err instanceof Error ? err : new Error(String(err)),
      );
    });
  }
}
