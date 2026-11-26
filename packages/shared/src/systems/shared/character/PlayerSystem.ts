/**
 * PlayerSystem.ts - Player Management and Lifecycle System
 *
 * Central system for managing all player-related functionality including:
 * - Player spawning and initialization
 * - Health, stamina, and death/respawn
 * - Combat level calculation
 * - Attack style management
 * - Player state persistence to database
 * - Starter equipment provisioning
 *
 * **Player Lifecycle:**
 * 1. PLAYER_ENTER event → Load/create player data
 * 2. PLAYER_SPAWN_REQUEST → Position player in world
 * 3. Provide starter equipment
 * 4. Auto-save player data periodically (30s)
 * 5. PLAYER_LEAVE → Save final state to database
 *
 * **Attack Styles:**
 * Manages classic fantasy MMORPG-style attack modes:
 * - attack: +3 Attack XP per damage
 * - strength: +3 Strength XP per damage
 * - defense: +3 Defense XP per damage
 * - controlled: +1 to each combat stat XP
 * - ranged: Ranged combat style
 *
 * **Combat Level:**
 * Calculated from combat skills using classic fantasy MMORPG formula:
 * Base = 0.25 * (Defense + Constitution + floor(Ranged/2))
 * Melee = 0.325 * (Attack + Strength)
 * Ranged = 0.325 * (Ranged * 1.5)
 * Combat Level = Base + max(Melee, Ranged)
 *
 * **Referenced by:** All gameplay systems, database, network
 */

import { getItem } from "../../../data/items";
import type { PlayerLocal } from "../../../entities/player/PlayerLocal";
import type { PlayerEntity } from "../../../entities/player/PlayerEntity";
import { Position3D } from "../../../types";
import {
  AttackStyle,
  Player,
  PlayerAttackStyleState,
  PlayerMigration,
  PlayerSpawnData,
  Skills,
} from "../../../types/core/core";
import { WeaponType } from "../../../types/game/item-types";
import {
  parseStreamingDuelDamageObservationContext,
  parseStreamingDuelStyleObservationContext,
  type StreamingDuelDamageObservationContext,
  type StreamingDuelFoodObservationContext,
  type StreamingDuelStyleObservationContext,
} from "../../../types/game/streaming-duel-action-observation";
import { DeathState } from "../../../types/entities";
import type { PlayerEntityLike } from "../combat/DeathTypes";
import {
  isStyleValidForWeapon,
  getAvailableStyles,
  getDefaultStyleForWeapon,
} from "../../../constants/WeaponStyleConfig";
// CombatStyle type available from: "../../../utils/game/CombatCalculations"
import type { CombatStyleExtended } from "../../../types/game/combat-types";
import type {
  HealthUpdateEvent,
  PlayerEnterEvent,
  PlayerLeaveEvent,
  PlayerLevelUpEvent,
} from "../../../types/events";
import { EventType } from "../../../types/events";
import type { World } from "../../../types/index";
import { Logger } from "../../../utils/Logger";
import { EntityManager } from "..";
import { SystemBase } from "../infrastructure/SystemBase";
import type { TerrainSystem } from "..";
import { PlayerIdMapper } from "../../../utils/PlayerIdMapper";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import type {
  DuelDamageCompetitiveAuthority,
  DuelDamageCompetitiveTerminal,
  DuelDamageProjectileCostAuthority,
  DuelDamageCommitReceipt,
  DuelDamageCommitRequest,
  DuelCombatProgressReceipt,
  AttackStyleCommitReceipt,
  AttackStyleCommitRequest,
} from "../../../types/network/database";
import * as THREE from "three";
import { EatDelayManager } from "./EatDelayManager";
import { BuryDelayManager } from "./BuryDelayManager";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import { calculateCombatLevel as calculateRulesCombatLevel } from "../../../utils/game/CombatLevelCalculator";
import type { SkillsSystem } from "./SkillsSystem";
import type { CombatSystem } from "../combat/CombatSystem";
import type {
  AtomicBoneBurialFailureReason,
  InventorySystem,
} from "./InventorySystem";
import type { PrayerSystem } from "./PrayerSystem";
import { uuid } from "../../../utils/IdGenerator";

export type FoodConsumptionFailureReason =
  | "invalid_request"
  | "player_missing"
  | "player_not_alive"
  | "item_not_owned"
  | "not_food"
  | "full_health"
  | "eat_delay"
  | "action_in_progress"
  | "inventory_not_initialized"
  | "inventory_busy"
  | "atomic_persistence_unavailable"
  | "insufficient_items"
  | "persistence_failed"
  | "committed_state_apply_failed"
  | "effect_completion_pending";

export interface FoodConsumptionReceipt {
  ok: boolean;
  committed: boolean;
  consumed: boolean;
  playerId: string;
  itemId: string;
  operationId: string;
  replayed: boolean;
  healedAmount: number;
  newHealth: number | null;
  reason?: FoodConsumptionFailureReason;
}

type PendingFoodCustodyAttempt = {
  playerId: string;
  itemId: string;
  slot: number;
  operationId: string;
  publicActionObservation?: StreamingDuelFoodObservationContext;
  retryAt: number;
};

type PendingFoodLiveEffect = {
  playerId: string;
  itemId: string;
  appliedAmount: number;
  requestFingerprint: string;
  healAmount: number;
  retryAt: number;
};

function sameFoodObservationContext(
  left: StreamingDuelFoodObservationContext | undefined,
  right: StreamingDuelFoodObservationContext | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.operationId === right.operationId &&
    left.tick === right.tick &&
    left.observedAt === right.observedAt &&
    left.cycleId === right.cycleId &&
    left.duelId === right.duelId &&
    left.actorId === right.actorId &&
    left.opponentId === right.opponentId &&
    left.phase === right.phase &&
    left.combatRole === right.combatRole &&
    left.tacticalMacro === right.tacticalMacro
  );
}

export type BoneBurialFailureReason =
  | AtomicBoneBurialFailureReason
  | "player_missing"
  | "player_not_alive"
  | "bury_delay"
  | "action_in_progress"
  | "live_state_apply_failed";

export interface BoneBurialReceipt {
  ok: boolean;
  committed: boolean;
  liveStateApplied: boolean;
  playerId: string;
  itemId: string;
  operationId: string;
  replayed: boolean;
  awardedXp: number;
  currentXp: number | null;
  currentLevel: number | null;
  retryable: boolean;
  reason?: BoneBurialFailureReason;
}

export type DuelDamageApplicationReceipt =
  | {
      ok: true;
      committed: true;
      operationId: string;
      replayed: boolean;
      appliedDamage: number;
      targetDied: boolean;
      publicActionObservation: StreamingDuelDamageObservationContext;
      combatProgress: DuelCombatProgressReceipt[];
      competitiveTerminal: DuelDamageCompetitiveTerminal | null;
    }
  | {
      ok: false;
      committed: boolean;
      operationId: string;
      replayed: boolean;
      appliedDamage: 0;
      targetDied: boolean;
      competitiveTerminal: DuelDamageCompetitiveTerminal | null;
      reason:
        | "invalid_request"
        | "player_missing"
        | "player_not_alive"
        | "atomic_persistence_unavailable"
        | "persistence_failed"
        | "persistence_unknown"
        | "committed_state_apply_failed";
    };

export type AttackStyleChangeReceipt =
  | {
      ok: true;
      committed: true;
      liveStateApplied: true;
      operationId: string;
      playerId: string;
      requestedStyle: string;
      currentStyle: string;
      replayed: boolean;
      publicActionObservation: StreamingDuelStyleObservationContext | null;
    }
  | {
      ok: false;
      committed: boolean;
      liveStateApplied: false;
      operationId: string;
      playerId: string;
      requestedStyle: string;
      currentStyle: string | null;
      replayed: boolean;
      publicActionObservation: StreamingDuelStyleObservationContext | null;
      reason:
        | "invalid_request"
        | "player_missing"
        | "style_not_available"
        | "atomic_persistence_unavailable"
        | "persistence_failed"
        | "committed_state_apply_failed"
        | "operation_superseded";
    };

async function playerSha256Hex(value: string): Promise<string> {
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

function isDeterministicDuelDamageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "duel_damage_request_invalid",
    "duel_damage_operation_id_conflict",
    "duel_damage_player_missing",
    "duel_damage_health_state_invalid",
    "duel_damage_projectile_cost_invalid",
    "duel_damage_projectile_cost_lost",
    "duel_damage_competitive_authority_invalid",
    "duel_damage_competitive_authority_required",
    "duel_damage_competitive_authority_mismatch",
    "duel_damage_competitive_lifecycle_invalid",
    "duel_damage_competitive_snapshot_ambiguous",
    "duel_damage_competitive_snapshot_invalid",
    "duel_damage_competitive_observation_history_invalid",
    "duel_damage_competitive_terminal_event_conflict",
    "duel_damage_competitive_terminal_event_missing",
    "duel_damage_competitive_terminal_lost",
    "duel_damage_competitive_terminal_missing",
    "duel_damage_combat_progress_invalid",
  ].some((code) => message.includes(code));
}

function duelCombatXpAmounts(
  attackStyle: string,
  damageAuthority: number,
): Array<{ skill: DuelCombatProgressReceipt["skill"]; xpAmount: number }> {
  const combatXp = Math.floor(
    damageAuthority * COMBAT_CONSTANTS.XP.COMBAT_XP_PER_DAMAGE,
  );
  const constitutionXp = Math.floor(
    damageAuthority * COMBAT_CONSTANTS.XP.HITPOINTS_XP_PER_DAMAGE,
  );
  if (attackStyle === "controlled") {
    const controlledXp = Math.floor(
      damageAuthority * COMBAT_CONSTANTS.XP.CONTROLLED_XP_PER_DAMAGE,
    );
    return ["attack", "strength", "defense", "constitution"].map((skill) => ({
      skill: skill as DuelCombatProgressReceipt["skill"],
      xpAmount: controlledXp,
    }));
  }
  const primarySkill: DuelCombatProgressReceipt["skill"] =
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

function duelSkillLevelForXp(xp: number): number {
  let cumulative = 0;
  for (let level = 2; level <= 99; level++) {
    const increment =
      Math.floor(level - 1 + 300 * Math.pow(2, (level - 1) / 7)) / 4;
    cumulative = Math.floor(cumulative + increment);
    if (xp < cumulative) return level - 1;
  }
  return 99;
}

function classifyDeterministicAttackStyleError(
  error: unknown,
): "style_not_available" | "persistence_failed" | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("attack_style_weapon_rejected")) {
    return "style_not_available";
  }
  if (
    [
      "attack_style_request_invalid",
      "attack_style_operation_id_conflict",
      "attack_style_player_missing",
      "attack_style_state_invalid",
      "attack_style_equipment_state_invalid",
    ].some((code) => message.includes(code))
  ) {
    return "persistence_failed";
  }
  return null;
}

/**
 * PlayerSystem - Central Player Management
 *
 * Handles all player-related operations: spawning, stats, health, attack styles, and persistence.
 */
export class PlayerSystem extends SystemBase {
  declare world: World;

  private players = new Map<string, Player>();
  /**
   * Player rows become observable in `players` before every authoritative
   * projection has been synchronized. Competitive consumers must use this
   * completed-hydration boundary rather than treating map presence as ready.
   */
  private readyPlayers = new Set<string>();
  /** Invalidates a slow join when the same identity leaves or rejoins. */
  private playerHydrationGeneration = new Map<string, number>();
  private entityManager?: EntityManager;
  private databaseSystem?: DatabaseSystem;
  private playerLocalRefs = new Map<string, PlayerLocal>(); // Store PlayerLocal references for integration
  private readonly AUTO_SAVE_INTERVAL = 30000; // 30 seconds auto-save
  private saveInterval?: NodeJS.Timeout;
  private _tempVec3 = new THREE.Vector3();

  // Eat delay tracking (rules-accurate 3-tick cooldown)
  private eatDelayManager = new EatDelayManager();
  /** One food custody/effect transition may be in flight per player. */
  private foodActionsInFlight = new Set<string>();
  /** Bounded presentation receipts avoid replaying cooldown/message effects. */
  private appliedFoodOperations = new Map<string, FoodConsumptionReceipt>();
  /** Live optimistic deltas for durable operations awaiting DB completion. */
  private pendingFoodLiveEffects = new Map<string, PendingFoodLiveEffect>();
  private pendingFoodOperationByPlayer = new Map<string, string>();
  /**
   * A generic health write observed while a food delta is optimistic must run
   * only after the additive food transaction settles. Otherwise an autosave,
   * damage, regeneration, or respawn snapshot could persist the optimistic
   * delta ahead of its custody receipt and make completion double-count it.
   */
  private deferredHealthPersistenceAfterFood = new Set<string>();
  /**
   * Exact requests whose custody commit returned an ambiguous persistence
   * outcome. The live world retries only this identity until PostgreSQL proves
   * whether it committed; a later click or agent tick cannot create a second
   * debit while the first outcome is unknown.
   */
  private pendingFoodCustodyAttempts = new Map<
    string,
    PendingFoodCustodyAttempt
  >();
  /** Recovery is asynchronous so a database outage never blocks world ticks. */
  private foodRecoveryPlayersInFlight = new Set<string>();
  private readonly MAX_APPLIED_FOOD_RECEIPTS = 512;
  private readonly FOOD_RECOVERY_RETRY_MS = 1_000;
  /** Prevent a receipt replay from applying its historical live delta twice. */
  private appliedDuelDamageOperations = new Set<string>();
  private readonly MAX_APPLIED_DUEL_DAMAGE_OPERATIONS = 1_024;

  // Bury delay tracking (rules-accurate 2-tick cooldown)
  private buryDelayManager = new BuryDelayManager();
  /** One prayer-resource custody transition may be in flight per player. */
  private boneActionsInFlight = new Set<string>();
  /** Bound one-time presentation/cooldown effects independently of DB replay. */
  private appliedBoneOperationEffects = new Set<string>();
  private readonly MAX_APPLIED_BONE_EFFECTS = 512;

  // Player spawn tracking (merged from PlayerSpawnSystem)
  private spawnedPlayers = new Map<string, PlayerSpawnData>();
  private _tempVec3_1 = new THREE.Vector3();
  private _tempVec3_2 = new THREE.Vector3();
  private _tempVec3_3 = new THREE.Vector3();

  // OPTIMIZATION: Pre-allocated payload object for emitPlayerUpdate
  // Reused to avoid allocation per update (called very frequently)
  private _playerUpdatePayload = {
    id: "",
    playerId: "",
    name: "",
    level: 0,
    combatLevel: 0,
    health: { current: 0, max: 0 },
    alive: true,
    position: { x: 0, y: 0, z: 0 },
    skills: null as unknown,
    stamina: 100,
    maxStamina: 100,
    coins: 0,
    combatStyle: "attack" as string,
  };
  private _playerUpdatedEvent = {
    playerId: "",
    component: "player" as const,
    data: null as unknown,
  };
  private _uiUpdateEvent = {
    component: "player" as const,
    data: null as unknown,
  };

  /** Starter equipment for new players */
  private readonly STARTER_EQUIPMENT: Array<{
    itemId: string;
    slot: string;
    autoEquip: boolean;
  }> = [{ itemId: "bronze_shortsword", slot: "weapon", autoEquip: true }];

  // Attack style tracking (merged from AttackStyleSystem)
  private playerAttackStyles = new Map<string, PlayerAttackStyleState>();
  private skillSaveTimers = new Map<string, NodeJS.Timeout>();

  // Auto-retaliate tracking (classic MMORPG-style combat preference)
  /** Player auto-retaliate settings (Map lookup = O(1), no allocations) */
  private playerAutoRetaliate = new Map<string, boolean>();
  private pendingSkillUpdates = new Map<
    string,
    { skills: Skills; persistence?: "already_committed" }
  >();
  /** Rate limiting for toggle spam prevention (OWASP) */
  private autoRetaliateLastToggle = new Map<string, number>();
  private readonly AUTO_RETALIATE_COOLDOWN_MS = 500; // Max 2 toggles/second

  // Attack styles - rules-accurate stat bonuses applied via CombatCalculations.getStyleBonus()
  private readonly ATTACK_STYLES: Record<string, AttackStyle> = {
    accurate: {
      id: "accurate",
      name: "Accurate",
      description: "Train Attack. +3 invisible Attack levels.",
      xpDistribution: {
        attack: 100,
        strength: 0,
        defense: 0,
        constitution: 0,
      },
      icon: "🎯",
    },

    aggressive: {
      id: "aggressive",
      name: "Aggressive",
      description: "Train Strength. +3 invisible Strength levels.",
      xpDistribution: {
        attack: 0,
        strength: 100,
        defense: 0,
        constitution: 0,
      },
      icon: "⚔️",
    },

    defensive: {
      id: "defensive",
      name: "Defensive",
      description: "Train Defense. +3 invisible Defense levels.",
      xpDistribution: {
        attack: 0,
        strength: 0,
        defense: 100,
        constitution: 0,
      },
      icon: "🛡️",
    },

    controlled: {
      id: "controlled",
      name: "Controlled",
      description: "Train all combat skills. +1 to Attack, Strength, Defense.",
      xpDistribution: {
        attack: 33,
        strength: 33,
        defense: 34,
        constitution: 0,
      },
      icon: "⚖️",
    },

    // Ranged combat styles (rules-accurate)
    rapid: {
      id: "rapid",
      name: "Rapid",
      description: "Faster attacks. Train Ranged.",
      xpDistribution: {
        attack: 0,
        strength: 0,
        defense: 0,
        constitution: 0,
      },
      icon: "⚡",
    },

    longrange: {
      id: "longrange",
      name: "Longrange",
      description: "Increased range. Train Ranged and Defense.",
      xpDistribution: {
        attack: 0,
        strength: 0,
        defense: 50,
        constitution: 0,
      },
      icon: "🔭",
    },

    // Magic combat styles (rules-accurate)
    autocast: {
      id: "autocast",
      name: "Autocast",
      description: "Automatically cast selected spell. Train Magic.",
      xpDistribution: {
        attack: 0,
        strength: 0,
        defense: 0,
        constitution: 0,
      },
      icon: "✨",
    },
  };

  constructor(world: World) {
    super(world, {
      name: "player",
      dependencies: {
        optional: ["entity-manager", "database", "ui"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Subscribe to player events using strongly typed event system
    this.subscribe(EventType.PLAYER_JOINED, (data) => {
      void this.onPlayerEnter(data as PlayerEnterEvent).catch((err) => {
        console.error(
          `[PlayerSystem] CRITICAL: onPlayerEnter failed for ${(data as PlayerEnterEvent)?.playerId}`,
          err,
        );
      });
    });
    this.subscribe(EventType.PLAYER_SPAWN_REQUEST, (data) =>
      this.onPlayerSpawnRequest(
        data as { playerId: string; position: Position3D },
      ),
    );
    this.subscribe(EventType.PLAYER_LEFT, (data) => {
      void this.onPlayerLeave(data as PlayerLeaveEvent).catch((err) => {
        console.error(
          `[PlayerSystem] CRITICAL: onPlayerLeave failed for ${(data as PlayerLeaveEvent)?.playerId}`,
          err,
        );
      });
    });
    this.subscribe(EventType.PLAYER_REGISTERED, (data) => {
      this.onPlayerRegister(data as { playerId: string }).catch((err) => {
        console.error(
          `[PlayerSystem] CRITICAL: onPlayerRegister failed for ${(data as { playerId: string })?.playerId}`,
          err,
        );
      });
    });
    this.subscribe(EventType.COMBAT_LEVEL_CHANGED, (data) => {
      const combatData = data as {
        entityId: string;
        oldLevel: number;
        newLevel: number;
      };
      this.onCombatLevelChanged(combatData);
    });
    this.subscribe(EventType.PLAYER_DAMAGE, (data) => {
      const damageData = data as {
        playerId: string;
        damage: number;
        source?: string;
      };
      this.damagePlayer(
        damageData.playerId,
        damageData.damage,
        damageData.source,
      );
    });
    this.subscribe(EventType.PLAYER_DAMAGE_TAKEN, (data) => {
      this.takeDamage(data as { playerId: string; damage: number });
    });
    // Subscribe to PLAYER_RESPAWNED from DeathSystem to update our player data
    this.subscribe(EventType.PLAYER_RESPAWNED, (data) => {
      this.handlePlayerRespawn(
        data as {
          playerId: string;
          spawnPosition: { x: number; y: number; z: number };
          townName?: string;
        },
      );
    });
    this.subscribe<PlayerLevelUpEvent>(EventType.PLAYER_LEVEL_UP, (data) => {
      this.updateCombatLevel(data);
    });

    // Handle consumable item usage
    this.subscribe(EventType.ITEM_USED, async (data) => {
      await this.handleItemUsed(
        data as {
          playerId: string;
          itemId: string;
          slot: number;
          itemData: { id: string; name: string; type: string };
        },
      );
    });

    // Handle spawn completion (merged from PlayerSpawnSystem)
    this.subscribe(EventType.PLAYER_SPAWN_COMPLETE, (data) =>
      this.handleSpawnComplete(data as { playerId: string }),
    );

    // Attack style events (merged from AttackStyleSystem)
    this.subscribe(EventType.ATTACK_STYLE_CHANGED, (data) => {
      void this.handleStyleChange(
        data as { playerId: string; newStyle: string },
      ).catch((error) => {
        this.logger.error(
          `Attack style authority failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    // Note: COMBAT_XP_CALCULATE, COMBAT_DAMAGE_CALCULATE, COMBAT_ACCURACY_CALCULATE
    // events removed - actual combat bonuses applied via CombatCalculations.getStyleBonus()
    this.subscribe(EventType.UI_ATTACK_STYLE_GET, (data) =>
      this.handleGetStyleInfo(
        data as {
          playerId: string;
          callback?: (info: Record<string, unknown> | null) => void;
        },
      ),
    );
    // CLIENT-SIDE: Sync internal state when receiving authoritative style from server
    // This fixes the bug where client initializes with "accurate" but server has saved style
    this.subscribe(EventType.UI_ATTACK_STYLE_CHANGED, (data) =>
      this.handleStyleSyncFromServer(
        data as {
          playerId: string;
          currentStyle: { id: string };
        },
      ),
    );

    // rules-accurate: auto-switch style when weapon changes and current style is invalid
    // Only subscribe on server — style changes are server-authoritative
    if (this.world.isServer) {
      this.subscribe(EventType.PLAYER_EQUIPMENT_CHANGED, (data) => {
        const eqData = data as {
          playerId: string;
          slot: string;
          itemId: string | null;
        };
        if (eqData.slot === "weapon") {
          void this.handleWeaponChange(eqData.playerId);
        }
      });
    }

    // Auto-retaliate events
    this.subscribe(EventType.UI_AUTO_RETALIATE_GET, (data) =>
      this.handleGetAutoRetaliate(
        data as { playerId: string; callback?: (enabled: boolean) => void },
      ),
    );
    this.subscribe(EventType.UI_AUTO_RETALIATE_UPDATE, (data) =>
      this.handleAutoRetaliateToggle(
        data as { playerId: string; enabled: boolean },
      ),
    );

    // Autocast spell selection (F2P magic combat)
    this.subscribe(EventType.PLAYER_SET_AUTOCAST, (data) =>
      this.handleSetAutocast(
        data as { playerId: string; spellId: string | null },
      ),
    );

    // Listen to skills updates to trigger player UI updates
    this.subscribe<{
      playerId: string;
      skills: Skills;
      persistence?: "already_committed";
    }>(EventType.SKILLS_UPDATED, (data) => {
      this.handleSkillsUpdate(data);
    });

    // Get system references using the type-safe getSystem method
    this.entityManager = this.world.getSystem<EntityManager>("entity-manager");
    // Get database system if available (server only)
    this.databaseSystem = this.world.getSystem<DatabaseSystem>("database");

    // Start auto-save
    this.startAutoSave();
  }

  private async onPlayerSpawnRequest(data: {
    playerId: string;
    position: Position3D;
  }): Promise<void> {
    const player = this.players.get(data.playerId);
    if (!player) {
      Logger.error(
        "PlayerSystem",
        new Error(`Player ${data.playerId} not found for spawn request.`),
      );
      return;
    }

    // Wait for terrain physics
    const terrainSystem = this.world.getSystem<TerrainSystem>("terrain");
    const finalPosition = this._tempVec3.set(
      data.position.x,
      data.position.y,
      data.position.z,
    );

    if (!terrainSystem) {
      console.error("[PlayerSystem] CRITICAL: TerrainSystem not found!");
      throw new Error("TerrainSystem not available during player spawn");
    }

    let attempts = 0;
    const maxAttempts = 100;
    while (attempts < maxAttempts) {
      if (terrainSystem.isPhysicsReadyAt(data.position.x, data.position.z)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempts++;
    }
    if (attempts >= maxAttempts) {
      this.logger.error(
        `Timed out waiting for terrain physics for player ${data.playerId}.`,
      );
    }

    const height = terrainSystem.getHeightAt(data.position.x, data.position.z);

    if (isFinite(height)) {
      finalPosition.y = height;
    } else {
      console.error(
        `[PlayerSystem] Invalid terrain height: ${height} - using safe default Y=50`,
      );
      finalPosition.y = 50;
    }

    const terrainHeight = terrainSystem.getHeightAt(
      finalPosition.x,
      finalPosition.z,
    );
    const groundedY = Number.isFinite(terrainHeight)
      ? terrainHeight
      : finalPosition.y;

    finalPosition.y = groundedY;
    player.position = { x: finalPosition.x, y: groundedY, z: finalPosition.z };

    // Update entity node position
    const entity = this.world.entities.get(data.playerId);
    if (entity) {
      entity.node.position.set(finalPosition.x, groundedY, finalPosition.z);

      if (entity.data && Array.isArray(entity.data.position)) {
        entity.data.position[0] = finalPosition.x;
        entity.data.position[1] = groundedY;
        entity.data.position[2] = finalPosition.z;
      }
    } else {
      console.error(
        `[PlayerSystem] CRITICAL: Entity ${data.playerId} not found in entities system!`,
      );
    }

    // Create spawn data tracking (merged from PlayerSpawnSystem)
    if (!this.spawnedPlayers.has(data.playerId)) {
      const spawnData: PlayerSpawnData = {
        playerId: data.playerId,
        position: new THREE.Vector3(
          finalPosition.x,
          groundedY,
          finalPosition.z,
        ),
        hasStarterEquipment: false,
        aggroTriggered: false,
        spawnTime: Date.now(),
      };
      this.spawnedPlayers.set(data.playerId, spawnData);
    }

    // Teleport the player to the final, grounded position
    this.emitTypedEvent(EventType.PLAYER_TELEPORT_REQUEST, {
      playerId: data.playerId,
      position: player.position,
    });

    // Emit spawn complete event
    this.emitTypedEvent(EventType.PLAYER_SPAWN_COMPLETE, {
      playerId: data.playerId,
    });
  }

  private async onPlayerRegister(data: { playerId: string }): Promise<void> {
    if (!data?.playerId) {
      this.logger.error("playerId is undefined in registration data");
      return;
    }

    // Load saved combat preferences from database if available
    let savedAttackStyle: string | undefined;
    let savedAutoRetaliate = true; // Default ON (classic MMORPG behavior)
    if (this.databaseSystem) {
      try {
        const databaseId = PlayerIdMapper.getDatabaseId(data.playerId);
        const dbData = await this.databaseSystem.getPlayerAsync(databaseId);
        savedAttackStyle = (dbData as { attackStyle?: string })?.attackStyle;
        savedAutoRetaliate =
          ((dbData as { autoRetaliate?: number })?.autoRetaliate ?? 1) === 1;
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to load combat preferences for ${data.playerId}, using defaults`,
          err instanceof Error ? { error: err.message } : undefined,
        );
      }
    }
    // Only initialize if no state exists yet. If the player already has state
    // (from auto-init + an active style/toggle change before registration),
    // their in-session choice takes precedence over the DB-saved value.
    // The updated value will be persisted on the next periodic save.
    if (!this.playerAttackStyles.has(data.playerId)) {
      this.initializePlayerAttackStyle(data.playerId, savedAttackStyle);
    }
    if (!this.playerAutoRetaliate.has(data.playerId)) {
      this.initializePlayerAutoRetaliate(data.playerId, savedAutoRetaliate);
    }

    // CRITICAL: Send health data to client NOW (after client is connected and ready)
    // This matches the inventory initialization pattern - send data in PLAYER_REGISTERED
    const player = this.players.get(data.playerId);
    if (player) {
      // Emit PLAYER_UPDATED so EventBridge forwards to client
      this.emitTypedEvent(EventType.PLAYER_UPDATED, {
        playerId: data.playerId,
        playerData: {
          id: player.id,
          name: player.name,
          level: player.combat.combatLevel,
          health: player.health.current,
          maxHealth: player.health.max,
          alive: player.alive,
        },
      });
    }
  }

  private onCombatLevelChanged(data: {
    entityId: string;
    oldLevel: number;
    newLevel: number;
  }): void {
    // Only process on server
    if (!this.world.isServer) return;

    const player = this.players.get(data.entityId);
    if (!player) return;

    // Update combat level in player data (SkillsSystem already updated StatsComponent)
    player.combat.combatLevel = data.newLevel;

    // Sync to entity and broadcast to all clients
    this.syncCombatLevelToEntity(data.entityId, data.newLevel);

    // Save to database immediately (only if database system available)
    if (this.databaseSystem) {
      const databaseId = PlayerIdMapper.getDatabaseId(data.entityId);
      this.databaseSystem.savePlayer(databaseId, {
        combatLevel: data.newLevel,
      });
    }
  }

  async onPlayerEnter(data: PlayerEnterEvent): Promise<void> {
    // Check if player already exists in our system
    if (this.players.has(data.playerId)) {
      return;
    }
    const hydrationGeneration =
      (this.playerHydrationGeneration.get(data.playerId) ?? 0) + 1;
    this.playerHydrationGeneration.set(data.playerId, hydrationGeneration);
    this.readyPlayers.delete(data.playerId);

    // Check if entity already exists (character-select mode spawns entity before PLAYER_JOINED)
    const existingEntity = this.world.entities.get(data.playerId);
    if (existingEntity && existingEntity.position) {
      // Create spawn data tracking
      const spawnData: PlayerSpawnData = {
        playerId: data.playerId,
        position: new THREE.Vector3(
          existingEntity.position.x,
          existingEntity.position.y,
          existingEntity.position.z,
        ),
        hasStarterEquipment: false,
        aggroTriggered: false,
        spawnTime: Date.now(),
      };
      this.spawnedPlayers.set(data.playerId, spawnData);
    }

    // Determine which ID to use for database lookups
    // Use userId (persistent account ID) if available, otherwise use playerId (session ID)
    const databaseId = data.userId || data.playerId;

    // Load player data from database
    let playerData: Player | undefined;
    if (this.databaseSystem) {
      const runeRecovery =
        this.databaseSystem.recoverPendingProjectileRuneCostOperationsAsync;
      if (typeof runeRecovery === "function") {
        await runeRecovery.call(this.databaseSystem, databaseId);
      }
      // A replacement process cannot recover an in-memory projectile lease.
      // Refund its staged ammunition before equipment/inventory hydration.
      const ammunitionRecovery =
        this.databaseSystem.recoverPendingAmmunitionShotOperationsAsync;
      if (typeof ammunitionRecovery === "function") {
        await ammunitionRecovery.call(this.databaseSystem, databaseId);
      }
      // A replacement process must settle any food debit that committed before
      // its matching health effect. Recovery runs before health hydration, so
      // the Player and entity are born from the completed database state.
      const recovery =
        this.databaseSystem.recoverPendingFoodConsumptionOperationsAsync;
      if (typeof recovery === "function") {
        await recovery.call(this.databaseSystem, databaseId);
      }
      const dbData = await this.databaseSystem.getPlayerAsync(databaseId);
      if (dbData) {
        playerData = PlayerMigration.fromPlayerRow(dbData, data.playerId);
      }
    }

    // A disconnect or newer join superseded this database read. Never publish
    // the obsolete row into the replacement lifecycle.
    if (
      this.playerHydrationGeneration.get(data.playerId) !== hydrationGeneration
    ) {
      return;
    }

    // Create new player if not found in database
    if (!playerData) {
      const playerLocal = this.playerLocalRefs.get(data.playerId);
      // CRITICAL: Use the playerLocal.name from the entity spawn, which comes from the character DB record
      // Never auto-generate names - they must come from the character creation system
      const playerName = playerLocal?.name || "Adventurer";

      playerData = PlayerMigration.createNewPlayer(
        data.playerId,
        data.playerId,
        playerName,
      );

      // Ground initial spawn to terrain height on server
      const terrain = this.world.getSystem<TerrainSystem>("terrain");
      if (terrain) {
        const px = playerData.position.x;
        const pz = playerData.position.z;
        const h = terrain.getHeightAt(px, pz);
        if (Number.isFinite(h)) {
          playerData.position.y = h;
        }
      }

      // Save new player to database using persistent userId
      // NOTE: Don't save name here - it was already set by createCharacter()
      if (this.databaseSystem) {
        this.databaseSystem.savePlayer(databaseId, {
          // Explicitly omit name to avoid overwriting the character's name
          combatLevel: playerData.combat.combatLevel,
          attackLevel: playerData.skills.attack.level,
          strengthLevel: playerData.skills.strength.level,
          defenseLevel: playerData.skills.defense.level,
          constitutionLevel: playerData.skills.constitution.level,
          rangedLevel: playerData.skills.ranged.level,
          health: playerData.health.current,
          maxHealth: playerData.health.max,
          positionX: playerData.position.x,
          positionY: playerData.position.y,
          positionZ: playerData.position.z,
        });
      }
    }

    // Register userId mapping for database persistence (critical!)
    if (data.userId) {
      PlayerIdMapper.register(data.playerId, data.userId);
      (playerData as Player & { userId?: string }).userId = data.userId;
    }

    // Ensure health equals constitution level (per user requirement)
    const constitutionLevel =
      Number.isFinite(playerData.skills.constitution.level) &&
      playerData.skills.constitution.level > 0
        ? playerData.skills.constitution.level
        : 10;

    // Always set maxHealth to constitution level
    playerData.health.max = constitutionLevel;

    // Validate and fix health values
    if (
      !Number.isFinite(playerData.health.current) ||
      playerData.health.current <= 0 // FIX: Changed < to <= (0 health means dead!)
    ) {
      // Player is dead or has invalid health - restore to full
      playerData.health.current = playerData.health.max;
      playerData.alive = true; // Ensure player is alive
    } else {
      // Clamp current health to maxHealth
      playerData.health.current = Math.min(
        playerData.health.current,
        playerData.health.max,
      );
    }

    // Add to our system using entity ID for runtime lookups
    this.players.set(data.playerId, playerData);

    // The character entity may have been created before PlayerSystem finished
    // loading the authoritative database row. Apply that exact persisted pool
    // after hydration so reconnect/restart cannot manufacture a full heal.
    const hydratedEntity = (this.world.getPlayer?.(data.playerId) ??
      this.world.entities.get(data.playerId)) as PlayerEntity | undefined;
    if (hydratedEntity) {
      if (hydratedEntity.setHealthAndMaxHealth) {
        hydratedEntity.setHealthAndMaxHealth(
          playerData.health.current,
          playerData.health.max,
        );
      } else {
        hydratedEntity.setHealth(playerData.health.current);
      }
    }

    // Autocast is persisted beside the character row, but the runtime combat
    // and equipment systems read it from entity data. Restore it before the
    // player-ready boundary so a restart cannot present a stale null spell to
    // a database-first duel preparation transaction. Update both registries
    // because some runtimes expose distinct player/entity projections.
    const hydratedSelectedSpell = playerData.selectedSpell ?? null;
    const runtimeProjections = [
      this.world.getPlayer?.(data.playerId),
      this.world.entities.get(data.playerId),
    ];
    for (const projection of runtimeProjections) {
      if (projection?.data) {
        (projection.data as { selectedSpell?: string | null }).selectedSpell =
          hydratedSelectedSpell;
      }
    }
    this.emitTypedEvent(EventType.COMBAT_AUTOCAST_SET, {
      playerId: data.playerId,
      spellId: hydratedSelectedSpell,
    });

    const pendingSkills = this.pendingSkillUpdates.get(data.playerId);
    if (pendingSkills) {
      this.pendingSkillUpdates.delete(data.playerId);
      this.handleSkillsUpdate({
        playerId: data.playerId,
        skills: pendingSkills.skills,
        persistence: pendingSkills.persistence,
      });
    }

    // All authoritative state used by combat admission is now reflected in
    // both PlayerSystem and the live entity projection.
    if (
      this.playerHydrationGeneration.get(data.playerId) === hydrationGeneration
    ) {
      this.readyPlayers.add(data.playerId);
    }

    // Emit player ready event
    this.emitTypedEvent(EventType.PLAYER_UPDATED, {
      playerId: data.playerId,
      playerData: {
        id: playerData.id,
        name: playerData.name,
        level: playerData.combat.combatLevel,
        health: playerData.health.current,
        maxHealth: playerData.health.max,
        alive: playerData.alive,
      },
    });

    // Update UI
    this.emitPlayerUpdate(data.playerId);

    // CRITICAL: Sync combat level to entity data for remote clients
    // The entity was created with combatLevel=3 (default), but we now have the correct level
    // from database. Sync it to entity.data so serialize() sends correct level to new clients,
    // and broadcast via entityModified so existing clients see the correct combat level.
    this.syncCombatLevelToEntity(data.playerId, playerData.combat.combatLevel);

    // If entity doesn't exist yet, wait for spawn request to create spawn data
    // This happens during initial join before character select
  }

  async onPlayerLeave(data: PlayerLeaveEvent): Promise<void> {
    // Close admission immediately; the final persistence write may await I/O.
    this.playerHydrationGeneration.set(
      data.playerId,
      (this.playerHydrationGeneration.get(data.playerId) ?? 0) + 1,
    );
    this.readyPlayers.delete(data.playerId);

    // Save player data before removal
    if (this.databaseSystem && this.players.has(data.playerId)) {
      await this.savePlayerToDatabase(data.playerId);
    }

    // Clean up
    this.players.delete(data.playerId);
    this.playerLocalRefs.delete(data.playerId);
    this.pendingSkillUpdates.delete(data.playerId);

    // Clean up spawn data (merged from PlayerSpawnSystem)
    this.spawnedPlayers.delete(data.playerId);
    this.cleanupPlayerMobs(data.playerId);

    // Clean up attack style (merged from AttackStyleSystem)
    this.playerAttackStyles.delete(data.playerId);

    // Clean up auto-retaliate
    this.playerAutoRetaliate.delete(data.playerId);
    this.autoRetaliateLastToggle.delete(data.playerId);

    // Clean up eat cooldown (memory hygiene)
    this.eatDelayManager.clearPlayer(data.playerId);
    this.pendingFoodCustodyAttempts.delete(data.playerId);
    for (const [operationId, effect] of this.pendingFoodLiveEffects) {
      if (effect.playerId === data.playerId) {
        this.clearPendingFoodLiveEffect(operationId);
      }
    }
    this.deferredHealthPersistenceAfterFood.delete(data.playerId);

    // Unregister userId mapping
    PlayerIdMapper.unregister(data.playerId);

    // Note: respawn timers are owned by PlayerDeathSystem
  }

  async updateHealth(data: HealthUpdateEvent): Promise<void> {
    const player = this.players.get(data.entityId);
    if (!player) {
      return;
    }

    // Validate health values to prevent NaN
    const validMaxHealth =
      Number.isFinite(data.maxHealth) && data.maxHealth > 0
        ? data.maxHealth
        : player.health.max;
    const validCurrentHealth = Number.isFinite(data.currentHealth)
      ? data.currentHealth
      : player.health.current;

    // Additional safety checks to prevent NaN values - validate before assignment
    if (!Number.isFinite(validMaxHealth) || validMaxHealth <= 0) {
      Logger.systemError(
        "PlayerSystem",
        `Invalid maxHealth value: ${validMaxHealth}, using default 100`,
        new Error(`Invalid maxHealth: ${validMaxHealth}`),
      );
      player.health.max = 100;
    } else {
      player.health.max = validMaxHealth;
    }

    if (!Number.isFinite(validCurrentHealth)) {
      Logger.systemError(
        "PlayerSystem",
        `Invalid currentHealth value: ${validCurrentHealth}, using maxHealth`,
        new Error(`Invalid currentHealth: ${validCurrentHealth}`),
      );
      player.health.current = player.health.max;
    } else {
      // Floor to ensure health is always an integer (classic fantasy MMORPG-style)
      player.health.current = Math.floor(
        Math.max(0, Math.min(validCurrentHealth, player.health.max)),
      );
    }

    // Check for death
    if (player.health.current <= 0 && player.alive) {
      this.handleDeath({
        playerId: data.entityId,
        cause: "health_depletion",
      });
    }

    this.persistPlayerHealth(data.entityId, player);
    this.emitPlayerUpdate(data.entityId);
  }

  private handleDeath(data: {
    playerId: string;
    cause?: string;
    combatProgressCommitted?: boolean;
  }): void {
    const player = this.players.get(data.playerId);
    if (!player) {
      return; // Player not found, ignore
    }

    // Prevent infinite recursion: if player is already dead, don't process again
    if (!player.alive) {
      return; // Already dead, ignore duplicate death events
    }

    // Mark player as dead in PlayerSystem data
    player.alive = false;
    player.death.deathLocation = { ...player.position };

    // Clear eat cooldown on death (memory hygiene)
    this.eatDelayManager.clearPlayer(data.playerId);

    // DEATH FLOW: PlayerSystem sets entity state + emits PLAYER_SET_DEAD (immediate client feedback).
    // Then ENTITY_DEATH fires → PlayerDeathSystem handles items, transaction, gravestone, respawnTick.
    // See PlayerDeathSystem.postDeathCleanup for the respawn/death-screen half of the flow.
    //
    // Set entity death state IMMEDIATELY so client sees death animation
    // even if PlayerDeathSystem's async processing fails
    const deathEntity = this.world.entities?.get?.(data.playerId);
    if (deathEntity) {
      const typedEntity = deathEntity as PlayerEntityLike;
      if (typedEntity.emote !== undefined) {
        typedEntity.emote = "death";
      }
      if (typedEntity.data) {
        typedEntity.data.e = "death";
        typedEntity.data.deathState = DeathState.DYING;
        typedEntity.data.deathPosition = [
          player.position.x,
          player.position.y,
          player.position.z,
        ];
      }
      if (typedEntity.markNetworkDirty) {
        typedEntity.markNetworkDirty();
      }
    }

    // Emit PLAYER_SET_DEAD immediately so client blocks input.
    // Wrapped in try-catch: if a subscriber throws, ENTITY_DEATH must still fire
    // so PlayerDeathSystem processes the death (items, gravestone, respawn).
    try {
      this.emitTypedEvent(EventType.PLAYER_SET_DEAD, {
        playerId: data.playerId,
        isDead: true,
        deathPosition: player.position,
      });
    } catch (err) {
      console.error(
        `[PlayerSystem] PLAYER_SET_DEAD subscriber threw — continuing to ENTITY_DEATH`,
        err,
      );
    }

    // Emit ENTITY_DEATH for DeathSystem to handle (headstones, loot, respawn)
    // DeathSystem will handle the full death flow including respawn
    // Include deathPosition so PlayerDeathSystem can use the exact death location
    // without falling back to potentially stale position caches
    this.emitTypedEvent(EventType.ENTITY_DEATH, {
      entityId: data.playerId,
      killedBy: data.cause || "unknown",
      entityType: "player" as const,
      deathPosition: { ...player.position },
      ...(data.combatProgressCommitted
        ? { combatProgressCommitted: true }
        : {}),
    });

    this.emitPlayerUpdate(data.playerId);
  }

  /**
   * Apply damage to a player and update health
   */
  private takeDamage(data: { playerId: string; damage: number }): void {
    const player = this.players.get(data.playerId);
    if (!player) {
      return;
    }

    // Apply damage - floor to ensure health is always an integer (classic fantasy MMORPG-style)
    const newHealth = Math.floor(
      Math.max(0, player.health.current - data.damage),
    );
    player.health.current = newHealth;

    // Update player entity if it exists
    const playerEntity = this.world.entities.get(
      data.playerId,
    ) as PlayerEntity | null;
    if (playerEntity && "setHealth" in playerEntity) {
      playerEntity.setHealth(newHealth);

      // Set lastDamageTick for health regen cooldown (17 ticks = 10.2s after damage)
      (playerEntity as unknown as { lastDamageTick: number }).lastDamageTick =
        this.world.currentTick ?? 0;
    }

    // Check for death
    if (newHealth <= 0) {
      this.handleDeath({
        playerId: data.playerId,
        cause: "combat",
      });
    }

    // Emit health update
    this.emitTypedEvent(EventType.ENTITY_HEALTH_CHANGED, {
      entityId: data.playerId,
      health: newHealth,
      maxHealth: player.health.max,
    });

    this.persistPlayerHealth(data.playerId, player);
    this.emitPlayerUpdate(data.playerId);
  }

  /**
   * Handle player respawn (called by DeathSystem via PLAYER_RESPAWNED event)
   * DeathSystem handles the full respawn logic, we just update PlayerSystem data
   */
  private handlePlayerRespawn(data: {
    playerId: string;
    spawnPosition: { x: number; y: number; z: number };
    townName?: string;
  }): void {
    const player = this.players.get(data.playerId);
    if (!player) {
      return;
    }

    // SECURITY: Only respawn players who are actually dead.
    // Without this check, any system emitting PLAYER_RESPAWNED would
    // unconditionally heal a player to full health mid-combat.
    if (player.alive && player.health.current > 0) {
      return;
    }

    // Reset player state to alive
    player.alive = true;
    player.health.current = player.health.max;
    player.position = data.spawnPosition;
    player.death.respawnTime = 0;
    player.death.deathLocation = null;

    // Update PlayerEntity health if it exists
    const playerEntity = this.world.getPlayer?.(
      data.playerId,
    ) as PlayerEntity | null;
    if (playerEntity) {
      playerEntity.setHealth(player.health.max);
    }

    // Update PlayerLocal position if available
    const playerLocal = this.playerLocalRefs.get(data.playerId);
    if (playerLocal) {
      playerLocal.position.set(
        data.spawnPosition.x,
        data.spawnPosition.y,
        data.spawnPosition.z,
      );
    }

    this.persistPlayerHealth(data.playerId, player);
    this.emitPlayerUpdate(data.playerId);
  }

  private updateCombatLevel(data: PlayerLevelUpEvent): void {
    const player = this.players.get(data.playerId);
    if (!player) return;

    // Recalculate combat level based on current stats
    player.combat.combatLevel = this.calculateCombatLevel(player.skills);
    this.emitPlayerUpdate(data.playerId);
  }

  private emitPlayerUpdate(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // OPTIMIZATION: Reuse pre-allocated payload object instead of creating new one
    const playerData = this._playerUpdatePayload;
    playerData.id = player.id;
    playerData.playerId = playerId;
    playerData.name = player.name;
    playerData.level = player.combat.combatLevel;
    playerData.combatLevel = player.combat.combatLevel;
    playerData.health.current = player.health.current;
    playerData.health.max = player.health.max;
    playerData.alive = player.alive;
    playerData.position.x = player.position.x;
    playerData.position.y = player.position.y;
    playerData.position.z = player.position.z;
    playerData.skills = player.skills;
    playerData.stamina = player.stamina?.current || 100;
    playerData.maxStamina = player.stamina?.max || 100;
    playerData.coins = player.coins || 0;
    playerData.combatStyle = player.combat.combatStyle || "attack";

    // OPTIMIZATION: Reuse pre-allocated event objects
    // Emit PLAYER_UPDATED for systems
    this._playerUpdatedEvent.playerId = playerId;
    this._playerUpdatedEvent.data = playerData;
    this.emitTypedEvent(EventType.PLAYER_UPDATED, this._playerUpdatedEvent);

    // Emit STATS_UPDATE for systems that depend on it
    this.emitTypedEvent(EventType.STATS_UPDATE, playerData);

    // Emit UI_UPDATE for client UI
    this._uiUpdateEvent.data = playerData;
    this.emitTypedEvent(EventType.UI_UPDATE, this._uiUpdateEvent);
  }

  // Public API methods
  getPlayer(playerId: string): Player | undefined {
    return this.players.get(playerId);
  }

  /** Whether the complete authoritative join projection is safe to consume. */
  isPlayerReady(playerId: string): boolean {
    return this.readyPlayers.has(playerId) && this.players.has(playerId);
  }

  getAllPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  isPlayerAlive(playerId: string): boolean {
    const player = this.players.get(playerId);
    return !!player?.alive;
  }

  getPlayerHealth(
    playerId: string,
  ): { current: number; max: number } | undefined {
    const player = this.players.get(playerId);
    return player
      ? { current: player.health.current, max: player.health.max }
      : undefined;
  }

  healPlayer(playerId: string, amount: number): boolean {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return false;

    const oldHealth = player.health.current;
    // Floor to ensure health is always an integer (classic fantasy MMORPG-style)
    player.health.current = Math.floor(
      Math.min(player.health.max, player.health.current + amount),
    );

    if (player.health.current !== oldHealth) {
      const playerEntity = (this.world.getPlayer?.(playerId) ??
        this.world.entities.get(playerId)) as PlayerEntity | null;
      if (playerEntity) {
        // Keep the combat entity authoritative. Updating only PlayerSystem's
        // cached Player object makes food appear to heal in UI while the
        // CombatSystem continues damaging the old entity health pool.
        playerEntity.setHealth(player.health.current);

        const statsComponent = playerEntity.getComponent("stats");
        if (
          statsComponent?.data &&
          typeof statsComponent.data.health === "object" &&
          statsComponent.data.health !== null
        ) {
          const healthData = statsComponent.data.health as {
            current?: number;
            max?: number;
          };
          healthData.current = player.health.current;
          healthData.max = player.health.max;
        }
      }

      const actualHeal = player.health.current - oldHealth;
      this.emitTypedEvent(EventType.PLAYER_HEALTH_UPDATED, {
        playerId,
        health: player.health.current,
        maxHealth: player.health.max,
      });
      this.emitTypedEvent(EventType.ENTITY_HEALED, {
        entityId: playerId,
        healAmount: actualHeal,
        newHealth: player.health.current,
      });
      this.persistPlayerHealth(playerId, player);
      this.emitPlayerUpdate(playerId);
      return true;
    }

    return false;
  }

  /**
   * Handle food consumption with rules-accurate timing
   *
   * Implements:
   * - 3-tick (1.8s) eat delay between foods
   * - Attack delay when eating during combat
   * - OWASP input validation
   * - classic MMORPG-style chat message format
   */
  private async handleItemUsed(data: {
    playerId: string;
    itemId: string;
    slot: number;
    itemData: { id: string; name: string; type: string };
  }): Promise<void> {
    // SERVER-SIDE ONLY: Food consumption is validated and processed on server
    if (!this.world.isServer) {
      return;
    }

    // === SECURITY: Input Validation (OWASP) ===
    if (!data.playerId || typeof data.playerId !== "string") {
      Logger.systemError("PlayerSystem", "Invalid playerId in handleItemUsed");
      return;
    }

    // Get the full item data first
    const itemData = getItem(data.itemId);
    if (!itemData) {
      return;
    }

    // === BONE BURYING (Prayer XP) ===
    // Check for bones before consumables - bones have prayerXp property
    if (itemData.prayerXp && itemData.prayerXp > 0) {
      await this.buryBoneAtomic(
        data.playerId,
        itemData.id,
        `bone-burial:${uuid()}${uuid()}`,
      );
      return;
    }

    await this.consumeFoodAtomic(
      data.playerId,
      data.itemId,
      data.slot,
      `food-debit:${uuid()}${uuid()}`,
    );
  }

  /**
   * Consume one owned food item through the strict inventory-debit boundary,
   * then apply its heal. No health, cooldown, message, or attack-delay effect
   * is exposed unless the durable custody receipt succeeds.
   */
  async consumeFoodAtomic(
    playerId: string,
    itemId: string,
    slot: number,
    operationId: string,
    publicActionObservation?: StreamingDuelFoodObservationContext,
  ): Promise<FoodConsumptionReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedItemId = String(itemId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const player = this.players.get(normalizedPlayerId);
    const failure = (
      reason: FoodConsumptionFailureReason,
      overrides: Partial<FoodConsumptionReceipt> = {},
    ): FoodConsumptionReceipt => ({
      ok: false,
      committed: false,
      consumed: false,
      playerId: normalizedPlayerId,
      itemId: normalizedItemId,
      operationId: normalizedOperationId,
      replayed: false,
      healedAmount: 0,
      newHealth: player?.health.current ?? null,
      reason,
      ...overrides,
    });

    if (
      !normalizedPlayerId ||
      !normalizedItemId ||
      !normalizedOperationId ||
      normalizedOperationId.length > 256 ||
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      slot >= 28
    ) {
      return failure("invalid_request");
    }
    const applied = this.appliedFoodOperations.get(normalizedOperationId);
    if (applied) {
      if (
        applied.playerId !== normalizedPlayerId ||
        applied.itemId !== normalizedItemId
      ) {
        return failure("invalid_request");
      }
      return { ...applied, replayed: true };
    }
    const pendingLiveEffect = this.pendingFoodLiveEffects.get(
      normalizedOperationId,
    );
    if (
      pendingLiveEffect &&
      (pendingLiveEffect.playerId !== normalizedPlayerId ||
        pendingLiveEffect.itemId !== normalizedItemId)
    ) {
      return failure("invalid_request");
    }
    const pendingPlayerOperation =
      this.pendingFoodOperationByPlayer.get(normalizedPlayerId);
    if (
      pendingPlayerOperation &&
      pendingPlayerOperation !== normalizedOperationId
    ) {
      return failure("action_in_progress");
    }
    const pendingCustodyAttempt =
      this.pendingFoodCustodyAttempts.get(normalizedPlayerId);
    const recoveringPendingCustody =
      pendingCustodyAttempt?.operationId === normalizedOperationId &&
      pendingCustodyAttempt.itemId === normalizedItemId &&
      pendingCustodyAttempt.slot === slot &&
      sameFoodObservationContext(
        pendingCustodyAttempt.publicActionObservation,
        publicActionObservation,
      );
    if (pendingCustodyAttempt && !recoveringPendingCustody) {
      return failure("action_in_progress");
    }
    if (!this.world.isServer) return failure("invalid_request");
    if (!player) return failure("player_missing");
    if (
      !pendingLiveEffect &&
      !recoveringPendingCustody &&
      (!player.alive || player.health.current <= 0)
    ) {
      return failure("player_not_alive");
    }

    const itemData = getItem(normalizedItemId);
    if (!itemData) return failure("invalid_request");
    if (
      (itemData.type !== "consumable" && itemData.type !== "food") ||
      !itemData.healAmount ||
      itemData.healAmount <= 0
    ) {
      return failure("not_food");
    }
    if (
      !pendingLiveEffect &&
      !recoveringPendingCustody &&
      player.health.current >= player.health.max
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: normalizedPlayerId,
        message: "You're already at full health.",
        type: "warning" as const,
      });
      return failure("full_health");
    }

    const currentTick = this.world.currentTick ?? 0;
    if (
      !pendingLiveEffect &&
      !recoveringPendingCustody &&
      !this.eatDelayManager.canEat(normalizedPlayerId, currentTick)
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: normalizedPlayerId,
        message: "You are already eating.",
        type: "warning" as const,
      });
      return failure("eat_delay");
    }
    if (this.foodActionsInFlight.has(normalizedPlayerId)) {
      return failure("action_in_progress");
    }

    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    const inventory = inventorySystem?.getInventory(normalizedPlayerId);
    if (!inventorySystem || !inventory) {
      if (recoveringPendingCustody && pendingCustodyAttempt) {
        pendingCustodyAttempt.retryAt =
          Date.now() + this.FOOD_RECOVERY_RETRY_MS;
      }
      return failure("inventory_not_initialized");
    }
    const ownedItem = inventory.items.find((item) => item.slot === slot);
    if (
      !pendingLiveEffect &&
      !recoveringPendingCustody &&
      (!ownedItem ||
        ownedItem.itemId !== normalizedItemId ||
        (ownedItem.quantity ?? 0) <= 0)
    ) {
      return failure("item_not_owned");
    }

    this.foodActionsInFlight.add(normalizedPlayerId);
    try {
      const healAmount = Math.min(
        Math.max(0, Math.floor(itemData.healAmount)),
        COMBAT_CONSTANTS.MAX_HEAL_AMOUNT,
      );
      const staged = publicActionObservation
        ? await inventorySystem.commitFoodConsumptionAtomic(
            normalizedPlayerId,
            normalizedOperationId,
            normalizedItemId,
            healAmount,
            publicActionObservation,
          )
        : await inventorySystem.commitFoodConsumptionAtomic(
            normalizedPlayerId,
            normalizedOperationId,
            normalizedItemId,
            healAmount,
          );
      if (!staged.ok) {
        const reason: FoodConsumptionFailureReason = staged.reason;
        if (
          reason === "persistence_failed" ||
          (recoveringPendingCustody &&
            (reason === "inventory_busy" ||
              reason === "atomic_persistence_unavailable" ||
              reason === "inventory_not_initialized"))
        ) {
          const previous =
            this.pendingFoodCustodyAttempts.get(normalizedPlayerId);
          this.pendingFoodCustodyAttempts.set(normalizedPlayerId, {
            playerId: normalizedPlayerId,
            itemId: normalizedItemId,
            slot,
            operationId: normalizedOperationId,
            ...(publicActionObservation
              ? { publicActionObservation: { ...publicActionObservation } }
              : {}),
            retryAt:
              previous?.operationId === normalizedOperationId
                ? Date.now() + this.FOOD_RECOVERY_RETRY_MS
                : Date.now(),
          });
        } else if (
          pendingCustodyAttempt?.operationId === normalizedOperationId
        ) {
          this.pendingFoodCustodyAttempts.delete(normalizedPlayerId);
        }
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: normalizedPlayerId,
          message:
            reason === "insufficient_items"
              ? "You no longer have that food."
              : reason === "full_health"
                ? "You're already at full health."
                : "The food action was cancelled before healing. Your inventory is being synchronized.",
          type: "error" as const,
        });
        return failure(reason);
      }

      if (pendingCustodyAttempt?.operationId === normalizedOperationId) {
        this.pendingFoodCustodyAttempts.delete(normalizedPlayerId);
      }

      const stagedReceipt = staged.receipt;
      if (stagedReceipt.status === "completed") {
        // A replacement process hydrates this durable result before the live
        // player exists and must not apply its historical delta again. The
        // current process is different: if it retained an ambiguous custody
        // attempt, it has never exposed that operation's heal, so add exactly
        // the committed delta to its still-alive pool while preserving any
        // newer damage, full-health transition, or death.
        const recoveredCommittedCustody =
          recoveringPendingCustody && !pendingLiveEffect;
        const livePlayerBeforeRecovery = this.players.get(normalizedPlayerId);
        if (
          recoveredCommittedCustody &&
          livePlayerBeforeRecovery?.alive &&
          livePlayerBeforeRecovery.health.current > 0 &&
          stagedReceipt.healedAmount !== 0
        ) {
          this.applyFoodHealthDeltaLive(
            normalizedPlayerId,
            stagedReceipt.healedAmount,
            false,
          );
        }
        if (pendingLiveEffect) {
          const correction =
            stagedReceipt.healedAmount - pendingLiveEffect.appliedAmount;
          if (correction !== 0) {
            this.applyFoodHealthDeltaLive(normalizedPlayerId, correction, true);
          }
          this.clearPendingFoodLiveEffect(normalizedOperationId);
        }
        const replayPlayer = this.players.get(normalizedPlayerId);
        const terminal = stagedReceipt.completionReason === "player_not_alive";
        const presentRecoveredAction =
          Boolean(pendingLiveEffect || recoveredCommittedCustody) &&
          !terminal &&
          Boolean(replayPlayer?.alive && replayPlayer.health.current > 0);
        if (presentRecoveredAction) {
          this.eatDelayManager.recordEat(normalizedPlayerId, currentTick);
        }
        const replayReceipt: FoodConsumptionReceipt = {
          ok: !terminal,
          committed: true,
          consumed: true,
          playerId: normalizedPlayerId,
          itemId: normalizedItemId,
          operationId: normalizedOperationId,
          replayed: true,
          healedAmount: stagedReceipt.healedAmount,
          newHealth: replayPlayer?.health.current ?? stagedReceipt.healthAfter,
          ...(terminal ? { reason: "player_not_alive" as const } : {}),
        };
        this.rememberAppliedFoodOperation(replayReceipt);
        if (presentRecoveredAction) {
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: normalizedPlayerId,
            message: `You eat the ${itemData.name.toLowerCase()}.`,
            type: "success" as const,
          });
          this.applyEatAttackDelay(normalizedPlayerId, currentTick);
        }
        return replayReceipt;
      }

      // Re-read health after the async custody boundary. Damage that landed
      // while persistence was pending is preserved. Apply the staged heal to
      // live combat immediately, but do not emit a generic DB snapshot: the
      // completion transaction adds the same delta after all older health saves.
      const currentPlayer = this.players.get(normalizedPlayerId);
      const optimisticHeal = pendingLiveEffect
        ? pendingLiveEffect.appliedAmount
        : currentPlayer?.alive && currentPlayer.health.current > 0
          ? this.applyFoodHealthDeltaLive(normalizedPlayerId, healAmount, false)
          : 0;
      if (!pendingLiveEffect) {
        this.rememberPendingFoodLiveEffect(
          normalizedOperationId,
          normalizedPlayerId,
          normalizedItemId,
          optimisticHeal,
          stagedReceipt.requestFingerprint,
          healAmount,
        );
      }

      let completed;
      const completionRequest = {
        operationId: normalizedOperationId,
        playerId: normalizedPlayerId,
        requestFingerprint: stagedReceipt.requestFingerprint,
      };
      try {
        completed =
          await this.databaseSystem?.completeFoodConsumptionOperationAsync(
            completionRequest,
          );
      } catch (firstError) {
        try {
          completed =
            await this.databaseSystem?.completeFoodConsumptionOperationAsync(
              completionRequest,
            );
        } catch (retryError) {
          Logger.systemError(
            "PlayerSystem",
            `Food health effect remains pending for ${normalizedPlayerId}: ${String(retryError)} (first failure: ${String(firstError)})`,
          );
        }
      }
      if (!completed || completed.status !== "completed") {
        return failure("effect_completion_pending", {
          committed: true,
          consumed: true,
          replayed: stagedReceipt.replayed,
          healedAmount: optimisticHeal,
          newHealth:
            this.players.get(normalizedPlayerId)?.health.current ?? null,
        });
      }
      if (
        completed.operationId !== normalizedOperationId ||
        completed.playerId !== normalizedPlayerId ||
        completed.requestFingerprint !== stagedReceipt.requestFingerprint ||
        completed.itemId !== normalizedItemId ||
        completed.healAmount !== healAmount
      ) {
        return failure("persistence_failed", {
          committed: true,
          consumed: true,
          replayed: completed.replayed,
          healedAmount: optimisticHeal,
          newHealth:
            this.players.get(normalizedPlayerId)?.health.current ?? null,
        });
      }

      // Normally the optimistic and durable deltas are identical. A concurrent
      // terminal transition or cap can reduce the durable delta; applying only
      // the difference preserves any newer damage that landed while awaiting.
      const correction = completed.healedAmount - optimisticHeal;
      if (correction !== 0) {
        this.applyFoodHealthDeltaLive(normalizedPlayerId, correction, true);
      }
      this.clearPendingFoodLiveEffect(normalizedOperationId);
      const completedPlayer = this.players.get(normalizedPlayerId);
      const terminal = completed.completionReason === "player_not_alive";
      this.eatDelayManager.recordEat(normalizedPlayerId, currentTick);
      const receipt: FoodConsumptionReceipt = {
        ok: !terminal,
        committed: true,
        consumed: true,
        playerId: normalizedPlayerId,
        itemId: normalizedItemId,
        operationId: normalizedOperationId,
        replayed: stagedReceipt.replayed || completed.replayed,
        healedAmount: completed.healedAmount,
        newHealth: completedPlayer?.health.current ?? completed.healthAfter,
        ...(terminal ? { reason: "player_not_alive" as const } : {}),
      };
      this.rememberAppliedFoodOperation(receipt);

      if (!terminal) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: normalizedPlayerId,
          message: `You eat the ${itemData.name.toLowerCase()}.`,
          type: "success" as const,
        });
        this.applyEatAttackDelay(normalizedPlayerId, currentTick);
      }
      return receipt;
    } finally {
      this.foodActionsInFlight.delete(normalizedPlayerId);
    }
  }

  private rememberAppliedFoodOperation(receipt: FoodConsumptionReceipt): void {
    this.appliedFoodOperations.set(receipt.operationId, receipt);
    while (this.appliedFoodOperations.size > this.MAX_APPLIED_FOOD_RECEIPTS) {
      const oldest = this.appliedFoodOperations.keys().next().value as
        string | undefined;
      if (!oldest) break;
      this.appliedFoodOperations.delete(oldest);
    }
  }

  private rememberPendingFoodLiveEffect(
    operationId: string,
    playerId: string,
    itemId: string,
    appliedAmount: number,
    requestFingerprint: string,
    healAmount: number,
  ): void {
    this.pendingFoodLiveEffects.set(operationId, {
      playerId,
      itemId,
      appliedAmount,
      requestFingerprint,
      healAmount,
      retryAt: Date.now(),
    });
    this.pendingFoodOperationByPlayer.set(playerId, operationId);
  }

  /**
   * Complete a custody debit whose matching health transaction was interrupted.
   * This runs inside the existing world rather than requiring a process restart.
   */
  private async reconcilePendingFoodLiveEffect(
    operationId: string,
  ): Promise<void> {
    const effect = this.pendingFoodLiveEffects.get(operationId);
    const complete = this.databaseSystem?.completeFoodConsumptionOperationAsync;
    if (!effect || typeof complete !== "function") return;

    let completed;
    try {
      completed = await complete.call(this.databaseSystem, {
        operationId,
        playerId: effect.playerId,
        requestFingerprint: effect.requestFingerprint,
      });
    } catch (error) {
      const current = this.pendingFoodLiveEffects.get(operationId);
      if (current === effect) {
        current.retryAt = Date.now() + this.FOOD_RECOVERY_RETRY_MS;
      }
      Logger.systemError(
        "PlayerSystem",
        `Pending food health recovery failed for ${effect.playerId}: ${String(error)}`,
      );
      return;
    }

    if (this.pendingFoodLiveEffects.get(operationId) !== effect) return;
    if (
      !completed ||
      completed.operationId !== operationId ||
      completed.playerId !== effect.playerId ||
      completed.requestFingerprint !== effect.requestFingerprint ||
      completed.itemId !== effect.itemId ||
      completed.healAmount !== effect.healAmount ||
      completed.status !== "completed"
    ) {
      effect.retryAt = Date.now() + this.FOOD_RECOVERY_RETRY_MS;
      Logger.systemError(
        "PlayerSystem",
        `Pending food health recovery returned an invalid receipt for ${effect.playerId}`,
      );
      return;
    }

    const correction = completed.healedAmount - effect.appliedAmount;
    if (correction !== 0) {
      this.applyFoodHealthDeltaLive(effect.playerId, correction, true);
    }
    this.clearPendingFoodLiveEffect(operationId);

    const player = this.players.get(effect.playerId);
    const terminal = completed.completionReason === "player_not_alive";
    const currentTick = this.world.currentTick ?? 0;
    this.eatDelayManager.recordEat(effect.playerId, currentTick);
    const receipt: FoodConsumptionReceipt = {
      ok: !terminal,
      committed: true,
      consumed: true,
      playerId: effect.playerId,
      itemId: effect.itemId,
      operationId,
      replayed: completed.replayed,
      healedAmount: completed.healedAmount,
      newHealth: player?.health.current ?? completed.healthAfter,
      ...(terminal ? { reason: "player_not_alive" as const } : {}),
    };
    this.rememberAppliedFoodOperation(receipt);

    if (!terminal) {
      const item = getItem(effect.itemId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: effect.playerId,
        message: `You eat the ${(item?.name ?? effect.itemId).toLowerCase()}.`,
        type: "success" as const,
      });
      this.applyEatAttackDelay(effect.playerId, currentTick);
    }
  }

  /** Advance exact ambiguous custody and pending-effect recovery off-tick. */
  private advancePendingFoodRecovery(): void {
    const now = Date.now();
    for (const attempt of this.pendingFoodCustodyAttempts.values()) {
      if (
        attempt.retryAt > now ||
        this.foodRecoveryPlayersInFlight.has(attempt.playerId) ||
        this.foodActionsInFlight.has(attempt.playerId)
      ) {
        continue;
      }
      this.foodRecoveryPlayersInFlight.add(attempt.playerId);
      void this.consumeFoodAtomic(
        attempt.playerId,
        attempt.itemId,
        attempt.slot,
        attempt.operationId,
        attempt.publicActionObservation,
      )
        .catch((error) => {
          Logger.systemError(
            "PlayerSystem",
            `Ambiguous food custody recovery failed for ${attempt.playerId}: ${String(error)}`,
          );
        })
        .finally(() => {
          this.foodRecoveryPlayersInFlight.delete(attempt.playerId);
        });
    }

    for (const [operationId, effect] of this.pendingFoodLiveEffects) {
      if (
        effect.retryAt > now ||
        this.foodRecoveryPlayersInFlight.has(effect.playerId) ||
        this.foodActionsInFlight.has(effect.playerId)
      ) {
        continue;
      }
      this.foodRecoveryPlayersInFlight.add(effect.playerId);
      void this.reconcilePendingFoodLiveEffect(operationId).finally(() => {
        this.foodRecoveryPlayersInFlight.delete(effect.playerId);
      });
    }
  }

  private clearPendingFoodLiveEffect(operationId: string): void {
    const effect = this.pendingFoodLiveEffects.get(operationId);
    this.pendingFoodLiveEffects.delete(operationId);
    if (
      effect &&
      this.pendingFoodOperationByPlayer.get(effect.playerId) === operationId
    ) {
      this.pendingFoodOperationByPlayer.delete(effect.playerId);
    }
    if (
      effect &&
      !this.pendingFoodOperationByPlayer.has(effect.playerId) &&
      this.deferredHealthPersistenceAfterFood.delete(effect.playerId)
    ) {
      const player = this.players.get(effect.playerId);
      if (player) this.persistPlayerHealth(effect.playerId, player);
    }
  }

  /**
   * Reconcile the live Player/entity health pool without manufacturing an
   * independent persistence transition. Positive food deltas are persisted by
   * the matching database operation; a rare correction is explicitly saved.
   */
  private applyFoodHealthDeltaLive(
    playerId: string,
    delta: number,
    persist: boolean,
  ): number {
    const player = this.players.get(playerId);
    if (!player || !Number.isFinite(delta) || delta === 0) return 0;
    const oldHealth = player.health.current;
    const nextHealth = Math.floor(
      Math.min(player.health.max, Math.max(0, oldHealth + delta)),
    );
    if (nextHealth === oldHealth) return 0;
    player.health.current = nextHealth;

    const entity = (this.world.getPlayer?.(playerId) ??
      this.world.entities.get(playerId)) as PlayerEntity | null;
    if (entity) {
      entity.setHealth(nextHealth);
      const healthComponent = entity.getComponent("health");
      if (healthComponent?.data) {
        const health = healthComponent.data as {
          current?: number;
          max?: number;
          isDead?: boolean;
        };
        health.current = nextHealth;
        health.max = player.health.max;
        health.isDead = nextHealth <= 0;
      }
      const statsComponent = entity.getComponent("stats");
      if (statsComponent?.data) {
        const stats = statsComponent.data as {
          health?: { current?: number; max?: number };
        };
        if (stats.health) {
          stats.health.current = nextHealth;
          stats.health.max = player.health.max;
        }
      }
    }

    const actualDelta = nextHealth - oldHealth;
    this.emitTypedEvent(EventType.PLAYER_HEALTH_UPDATED, {
      playerId,
      health: nextHealth,
      maxHealth: player.health.max,
    });
    if (actualDelta > 0) {
      this.emitTypedEvent(EventType.ENTITY_HEALED, {
        entityId: playerId,
        healAmount: actualDelta,
        newHealth: nextHealth,
      });
    } else {
      this.emitTypedEvent(EventType.ENTITY_HEALTH_CHANGED, {
        entityId: playerId,
        health: nextHealth,
        maxHealth: player.health.max,
      });
    }
    if (persist) this.persistPlayerHealth(playerId, player);
    this.emitPlayerUpdate(playerId);
    return actualDelta;
  }

  /**
   * Apply attack delay when eating during combat (rules-accurate)
   *
   * classic MMORPG Rule: Foods only add to EXISTING attack delay.
   * If weapon is ready to attack, eating does NOT add delay.
   */
  private applyEatAttackDelay(playerId: string, currentTick: number): void {
    const combatSystem = this.world.getSystem("combat") as CombatSystem | null;
    if (!combatSystem) return;

    // Check if player is on attack cooldown
    const isOnCooldown = combatSystem.isPlayerOnAttackCooldown?.(
      playerId,
      currentTick,
    );

    if (isOnCooldown) {
      // Add eat delay to attack cooldown
      combatSystem.addAttackDelay?.(
        playerId,
        COMBAT_CONSTANTS.EAT_ATTACK_DELAY_TICKS,
      );
    }
    // If not on cooldown, do nothing (rules-accurate behavior)
  }

  /**
   * Consume one prayer-resource item and converge all live views on the
   * database-owned receipt. Custody, XP, level, and point-cap progression are
   * never exposed as separate mutations.
   */
  async buryBoneAtomic(
    playerId: string,
    itemId: string,
    operationId: string,
  ): Promise<BoneBurialReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedItemId = String(itemId ?? "").trim();
    const normalizedOperationId = String(operationId ?? "").trim();
    const itemData = getItem(normalizedItemId);
    const failure = (
      reason: BoneBurialFailureReason,
      retryable: boolean,
      overrides: Partial<BoneBurialReceipt> = {},
    ): BoneBurialReceipt => ({
      ok: false,
      committed: false,
      liveStateApplied: false,
      playerId: normalizedPlayerId,
      itemId: normalizedItemId,
      operationId: normalizedOperationId,
      replayed: false,
      awardedXp: 0,
      currentXp: null,
      currentLevel: null,
      retryable,
      reason,
      ...overrides,
    });

    if (
      !normalizedPlayerId ||
      !normalizedItemId ||
      !normalizedOperationId ||
      !itemData ||
      !Number.isSafeInteger(itemData.prayerXp) ||
      (itemData.prayerXp ?? 0) <= 0 ||
      !Number.isSafeInteger(itemData.buryLevelRequired ?? 1) ||
      (itemData.buryLevelRequired ?? 1) < 1 ||
      (itemData.buryLevelRequired ?? 1) > 99
    ) {
      return failure("invalid_request", false);
    }
    if (!this.world.isServer) return failure("invalid_request", false);
    const player = this.players.get(normalizedPlayerId);
    if (!player) return failure("player_missing", false);
    if (!player.alive || player.health.current <= 0) {
      return failure("player_not_alive", false);
    }

    const currentTick = this.world.currentTick ?? 0;
    if (
      !this.appliedBoneOperationEffects.has(normalizedOperationId) &&
      !this.buryDelayManager.canBury(normalizedPlayerId, currentTick)
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: normalizedPlayerId,
        message: "You are already burying bones.",
        type: "warning" as const,
      });
      return failure("bury_delay", true);
    }
    if (this.boneActionsInFlight.has(normalizedPlayerId)) {
      return failure("action_in_progress", true);
    }

    const inventorySystem = this.world.getSystem(
      "inventory",
    ) as InventorySystem | null;
    const skillsSystem = this.world.getSystem("skills") as SkillsSystem | null;
    const prayerSystem = this.world.getSystem("prayer") as PrayerSystem | null;
    if (!inventorySystem || !skillsSystem || !prayerSystem) {
      return failure("atomic_persistence_unavailable", true);
    }

    this.boneActionsInFlight.add(normalizedPlayerId);
    try {
      const committed = await inventorySystem.commitBoneBurialAtomic(
        normalizedPlayerId,
        normalizedOperationId,
        normalizedItemId,
        itemData.prayerXp!,
        itemData.buryLevelRequired ?? 1,
      );
      if (!committed.ok) {
        if (!committed.retryable) {
          const message =
            committed.reason === "item_missing"
              ? "You no longer have those bones."
              : committed.reason === "level_required"
                ? `You need level ${itemData.buryLevelRequired ?? 1} Prayer to bury these bones.`
                : committed.reason === "xp_cap"
                  ? "Your Prayer experience is already at its maximum."
                  : "The burial was cancelled before anything changed.";
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: normalizedPlayerId,
            message,
            type: "warning" as const,
          });
        }
        return failure(committed.reason, committed.retryable);
      }

      const committedResult = {
        committed: true,
        replayed: committed.replayed,
        awardedXp: committed.awardedXp,
        currentXp: committed.currentXp,
        currentLevel: committed.currentLevel,
      };
      if (!committed.liveInventoryApplied) {
        return failure("live_state_apply_failed", true, committedResult);
      }
      const skillsApplied = skillsSystem.reconcileCommittedPrayerProgression(
        normalizedPlayerId,
        committed.currentXp,
        committed.currentLevel,
        committed.awardedXp,
        committed.replayed,
      );
      if (!skillsApplied) {
        return failure("live_state_apply_failed", true, committedResult);
      }

      let prayerCustody;
      try {
        prayerCustody =
          await prayerSystem.reloadPrayerState(normalizedPlayerId);
      } catch (error) {
        Logger.systemError(
          "PlayerSystem",
          `Bone burial committed but Prayer state reload failed for ${normalizedPlayerId}`,
          error instanceof Error ? error : new Error(String(error)),
        );
        return failure("live_state_apply_failed", true, committedResult);
      }
      if (
        !prayerCustody.ready ||
        !prayerCustody.persistenceHealthy ||
        prayerCustody.maxPoints !== committed.currentLevel
      ) {
        return failure("live_state_apply_failed", true, committedResult);
      }

      if (!this.appliedBoneOperationEffects.has(normalizedOperationId)) {
        this.buryDelayManager.recordBury(normalizedPlayerId, currentTick);
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: normalizedPlayerId,
          message: "You bury the bones.",
          type: "success" as const,
        });
        this.appliedBoneOperationEffects.add(normalizedOperationId);
        while (
          this.appliedBoneOperationEffects.size > this.MAX_APPLIED_BONE_EFFECTS
        ) {
          const oldest = this.appliedBoneOperationEffects.values().next()
            .value as string | undefined;
          if (!oldest) break;
          this.appliedBoneOperationEffects.delete(oldest);
        }
      }

      return {
        ok: true,
        committed: true,
        liveStateApplied: true,
        playerId: normalizedPlayerId,
        itemId: normalizedItemId,
        operationId: normalizedOperationId,
        replayed: committed.replayed,
        awardedXp: committed.awardedXp,
        currentXp: committed.currentXp,
        currentLevel: committed.currentLevel,
        retryable: false,
      };
    } finally {
      this.boneActionsInFlight.delete(normalizedPlayerId);
    }
  }

  async updatePlayerPosition(
    playerId: string,
    position: Position3D,
  ): Promise<void> {
    const player = this.players.get(playerId);
    if (!player) {
      // In test scenarios, players might not be registered through normal flow
      // Only warn if this seems like a real player ID (not a test ID)
      if (!playerId.startsWith("test-")) {
        // Real player not found - already logged above
      }
      return;
    }

    player.position = { ...position };

    // Emit position update event for reactive systems
    this.emitTypedEvent(EventType.PLAYER_POSITION_UPDATED, {
      playerId,
      position,
    });

    // Position updates are frequent, don't save immediately
  }

  async updatePlayerStats(
    playerId: string,
    stats: Partial<Player["skills"]>,
  ): Promise<void> {
    const player = this.players.get(playerId);
    if (!player) return;

    // Update stats
    for (const [skillName, skillValue] of Object.entries(stats)) {
      if (!skillValue) continue;
      const key = skillName as keyof Player["skills"];
      if (!player.skills[key]) continue;
      player.skills[key] = {
        ...player.skills[key],
        ...skillValue,
      };
    }

    // Recalculate combat level
    player.combat.combatLevel = this.calculateCombatLevel(player.skills);

    // Sync to entity and broadcast to all clients
    this.syncCombatLevelToEntity(playerId, player.combat.combatLevel);

    // Save to database
    if (this.databaseSystem) {
      this.databaseSystem.savePlayer(playerId, {
        attackLevel: player.skills.attack.level,
        strengthLevel: player.skills.strength.level,
        defenseLevel: player.skills.defense.level,
        constitutionLevel: player.skills.constitution.level,
        rangedLevel: player.skills.ranged.level,
        combatLevel: player.combat.combatLevel,
      });
    }

    this.emitPlayerUpdate(playerId);
  }

  async updatePlayerEquipment(
    playerId: string,
    equipment: Partial<Player["equipment"]>,
  ): Promise<void> {
    const player = this.players.get(playerId);
    if (!player) return;

    // Update equipment
    player.equipment = {
      ...player.equipment,
      ...equipment,
    };

    this.emitTypedEvent(EventType.PLAYER_EQUIPMENT_UPDATED, {
      playerId,
      equipment: {
        helmet: player.equipment.helmet ? player.equipment.helmet.id : null,
        body: player.equipment.body ? player.equipment.body.id : null,
        legs: player.equipment.legs ? player.equipment.legs.id : null,
        weapon: player.equipment.weapon ? player.equipment.weapon.id : null,
        shield: player.equipment.shield ? player.equipment.shield.id : null,
      },
    });

    this.emitPlayerUpdate(playerId);
  }

  getPlayerStats(playerId: string): Skills | undefined {
    const player = this.players.get(playerId);
    return player?.skills;
  }

  getPlayerEquipment(playerId: string): Player["equipment"] | undefined {
    const player = this.players.get(playerId);
    return player?.equipment;
  }

  hasWeaponEquipped(playerId: string): boolean {
    const equipment = this.getPlayerEquipment(playerId);
    return !!equipment?.weapon;
  }

  canPlayerUseRanged(_playerId: string): boolean {
    // MVP: Melee-only combat - ranged weapons not supported
    return false;
  }

  damagePlayer(playerId: string, amount: number, _source?: string): boolean {
    return this.applyPlayerDamageLive(playerId, amount, _source, true) > 0;
  }

  /**
   * Commit one streaming-duel hit before mutating the live combat pool. A
   * retry reuses the scheduler-authored UUID and fingerprint, making a lost
   * commit response safe while keeping ordinary non-duel damage unchanged.
   */
  async damagePlayerAtomic(
    playerId: string,
    amount: number,
    source: string,
    observation: StreamingDuelDamageObservationContext,
    competitiveAuthority?: DuelDamageCompetitiveAuthority,
    projectileCost?: DuelDamageProjectileCostAuthority,
  ): Promise<DuelDamageApplicationReceipt> {
    const targetPlayerId = String(playerId ?? "").trim();
    const attackerId = String(source ?? "").trim();
    const requestedDamage = Number(amount);
    const parsedObservation =
      parseStreamingDuelDamageObservationContext(observation);
    const operationId = parsedObservation?.operationId ?? "";
    const failure = (
      reason: Extract<DuelDamageApplicationReceipt, { ok: false }>["reason"],
      committed = false,
      replayed = false,
      targetDied = false,
    ): DuelDamageApplicationReceipt => ({
      ok: false,
      committed,
      operationId,
      replayed,
      appliedDamage: 0,
      targetDied,
      competitiveTerminal: null,
      reason,
    });

    if (
      !parsedObservation ||
      parsedObservation.actorId !== attackerId ||
      parsedObservation.opponentId !== targetPlayerId ||
      parsedObservation.requestedDamage !== requestedDamage ||
      !Number.isSafeInteger(requestedDamage) ||
      requestedDamage <= 0 ||
      (projectileCost !== undefined &&
        (projectileCost.playerId !== attackerId ||
          (projectileCost.operationType !== "ammunition_shot" &&
            projectileCost.operationType !== "projectile_rune_cost") ||
          (projectileCost.operationType === "ammunition_shot"
            ? !/^ammunition-shot:[A-Za-z0-9]{20}$/.test(
                projectileCost.operationId,
              )
            : !/^spell-runes:[A-Za-z0-9]{20}$/.test(
                projectileCost.operationId,
              )) ||
          !/^[a-f0-9]{64}$/.test(projectileCost.requestFingerprint)))
    ) {
      return failure("invalid_request");
    }
    const player = this.players.get(targetPlayerId);
    if (!player) return failure("player_missing");
    const db = this.databaseSystem;
    if (!this.world.isServer || !db?.commitDuelDamageOperationAsync) {
      return failure("atomic_persistence_unavailable");
    }

    const attackStyle =
      parsedObservation.combatRole === "ranged"
        ? "ranged"
        : parsedObservation.combatRole === "mage"
          ? "magic"
          : this.getPlayerAttackStyle(attackerId)?.id;
    if (
      !attackStyle ||
      (parsedObservation.combatRole === "melee" &&
        !["accurate", "aggressive", "defensive", "controlled"].includes(
          attackStyle,
        ))
    ) {
      return failure("invalid_request");
    }

    let requestFingerprint: string;
    try {
      requestFingerprint = await playerSha256Hex(
        JSON.stringify({
          version: 2,
          attackerId,
          targetPlayerId,
          requestedDamage,
          attackStyle,
          publicActionObservation: parsedObservation,
          ...(competitiveAuthority ? { competitiveAuthority } : {}),
          ...(projectileCost ? { projectileCost } : {}),
        }),
      );
    } catch {
      return failure("atomic_persistence_unavailable");
    }
    const request: DuelDamageCommitRequest = {
      operationId,
      attackerId,
      targetPlayerId,
      requestFingerprint,
      requestedDamage,
      attackStyle,
      publicActionObservation: parsedObservation,
      ...(competitiveAuthority ? { competitiveAuthority } : {}),
      ...(projectileCost ? { projectileCost } : {}),
    };

    let receipt: DuelDamageCommitReceipt;
    try {
      receipt = await db.commitDuelDamageOperationAsync(request);
    } catch (firstError) {
      if (isDeterministicDuelDamageError(firstError)) {
        return failure("persistence_failed");
      }
      try {
        receipt = await db.commitDuelDamageOperationAsync(request);
      } catch {
        return failure("persistence_unknown");
      }
    }

    const competitiveTerminal = receipt.competitiveTerminal ?? null;
    const combatProgress = Array.isArray(receipt.combatProgress)
      ? receipt.combatProgress
      : [];
    const expectedCombatProgress =
      competitiveTerminal &&
      Number.isSafeInteger(receipt.xpDamageAuthority) &&
      receipt.xpDamageAuthority! > 0
        ? duelCombatXpAmounts(attackStyle, receipt.xpDamageAuthority!)
        : [];
    const combatProgressValid =
      combatProgress.length === expectedCombatProgress.length &&
      new Set(combatProgress.map((progress) => progress.skill)).size ===
        combatProgress.length &&
      combatProgress.every((progress, index) => {
        const expected = expectedCombatProgress[index];
        return (
          expected?.skill === progress.skill &&
          expected.xpAmount === progress.xpAmount &&
          Number.isSafeInteger(progress.awardedXp) &&
          progress.awardedXp >= 0 &&
          progress.awardedXp <= progress.xpAmount &&
          Number.isSafeInteger(progress.operationCommittedXp) &&
          progress.operationCommittedXp >= progress.awardedXp &&
          progress.operationCommittedXp <= 200_000_000 &&
          Number.isSafeInteger(progress.currentXp) &&
          progress.currentXp >= progress.operationCommittedXp &&
          progress.currentXp <= 200_000_000 &&
          Number.isSafeInteger(progress.currentLevel) &&
          progress.currentLevel >= 1 &&
          progress.currentLevel <= 99 &&
          duelSkillLevelForXp(progress.currentXp) === progress.currentLevel
        );
      });
    if (
      receipt.operationId !== operationId ||
      receipt.attackerId !== attackerId ||
      receipt.targetPlayerId !== targetPlayerId ||
      receipt.requestFingerprint !== requestFingerprint ||
      receipt.requestedDamage !== requestedDamage ||
      typeof receipt.replayed !== "boolean" ||
      !Number.isSafeInteger(receipt.appliedDamage) ||
      receipt.appliedDamage < 0 ||
      receipt.appliedDamage > requestedDamage ||
      !Number.isSafeInteger(receipt.healthBefore) ||
      !Number.isSafeInteger(receipt.healthAfter) ||
      receipt.healthBefore - receipt.healthAfter !== receipt.appliedDamage ||
      receipt.targetDied !==
        (receipt.appliedDamage > 0 && receipt.healthAfter === 0) ||
      (competitiveTerminal === null
        ? receipt.xpDamageAuthority !== null || combatProgress.length !== 0
        : !combatProgressValid ||
          !Number.isSafeInteger(receipt.xpDamageAuthority) ||
          receipt.xpDamageAuthority! <= 0) ||
      (competitiveTerminal !== null &&
        (competitiveTerminal.outcome !== "win" ||
          competitiveTerminal.winnerId !== attackerId ||
          competitiveTerminal.loserId !== targetPlayerId ||
          competitiveTerminal.winReason !== "kill" ||
          !receipt.targetDied))
    ) {
      return failure("persistence_failed", true, receipt.replayed);
    }
    if (receipt.appliedDamage === 0) {
      if (projectileCost) {
        return {
          ok: true,
          committed: true,
          operationId,
          replayed: receipt.replayed,
          appliedDamage: 0,
          targetDied: receipt.healthAfter === 0,
          publicActionObservation: parsedObservation,
          combatProgress,
          competitiveTerminal,
        };
      }
      return failure(
        "player_not_alive",
        true,
        receipt.replayed,
        receipt.healthAfter === 0,
      );
    }

    if (!this.appliedDuelDamageOperations.has(operationId)) {
      const appliedLive = this.applyPlayerDamageLive(
        targetPlayerId,
        receipt.appliedDamage,
        attackerId,
        false,
        combatProgress.length > 0,
      );
      if (appliedLive !== receipt.appliedDamage) {
        return failure(
          "committed_state_apply_failed",
          true,
          receipt.replayed,
          receipt.targetDied,
        );
      }
      this.appliedDuelDamageOperations.add(operationId);
      if (
        this.appliedDuelDamageOperations.size >
        this.MAX_APPLIED_DUEL_DAMAGE_OPERATIONS
      ) {
        const oldest = this.appliedDuelDamageOperations.values().next().value;
        if (oldest) this.appliedDuelDamageOperations.delete(oldest);
      }
    }

    if (combatProgress.length > 0) {
      this.emitTypedEvent(EventType.DUEL_COMBAT_PROGRESS_COMMITTED, {
        playerId: attackerId,
        damageOperationId: operationId,
        replayed: receipt.replayed,
        combatProgress,
      });
    }

    return {
      ok: true,
      committed: true,
      operationId,
      replayed: receipt.replayed,
      appliedDamage: receipt.appliedDamage,
      targetDied: receipt.targetDied,
      publicActionObservation: parsedObservation,
      combatProgress,
      competitiveTerminal,
    };
  }

  private applyPlayerDamageLive(
    playerId: string,
    amount: number,
    source: string | undefined,
    persist: boolean,
    combatProgressCommitted = false,
  ): number {
    const player = this.players.get(playerId);
    if (!player || !player.alive) {
      return 0;
    }

    // Validate amount to prevent NaN
    const validAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
    if (validAmount <= 0) return 0;

    // Validate current health before applying damage
    const currentHealth =
      Number.isFinite(player.health.current) && player.health.current > 0
        ? player.health.current
        : player.health.max;

    // Floor to ensure health is always an integer (classic fantasy MMORPG-style)
    const nextHealth = Math.floor(Math.max(0, currentHealth - validAmount));
    const appliedDamage = currentHealth - nextHealth;
    if (appliedDamage <= 0) return 0;
    player.health.current = nextHealth;

    // Sync damage to PlayerEntity if it exists
    const playerEntity = this.world.getPlayer?.(
      playerId,
    ) as PlayerEntity | null;
    if (playerEntity) {
      // Update Entity's health using setHealth method (which updates health bar)
      playerEntity.setHealth(player.health.current);

      // Update health component
      const healthComponent = playerEntity.getComponent("health");
      if (healthComponent && healthComponent.data) {
        (
          healthComponent.data as { current?: number; isDead?: boolean }
        ).current = player.health.current;
        (healthComponent.data as { isDead?: boolean }).isDead =
          player.health.current <= 0;
      }

      // Update stats component health
      const statsComponent = playerEntity.getComponent("stats");
      if (statsComponent && statsComponent.data && statsComponent.data.health) {
        const healthData = statsComponent.data.health as {
          current: number;
          max: number;
        };
        healthData.current = player.health.current;
      }

      // COMBAT_DAMAGE_DEALT is emitted by CombatSystem - no need to emit here
      // to avoid duplicate damage splats

      // Set lastDamageTick for health regen cooldown (17 ticks = 10.2s after damage)
      (playerEntity as unknown as { lastDamageTick: number }).lastDamageTick =
        this.world.currentTick ?? 0;
    }

    this.emitTypedEvent(EventType.PLAYER_HEALTH_UPDATED, {
      playerId,
      health: player.health.current,
      maxHealth: player.health.max,
    });

    if (player.health.current <= 0) {
      this.handleDeath({
        playerId,
        cause: source || "damage",
        combatProgressCommitted,
      });
    }

    if (persist) this.persistPlayerHealth(playerId, player);
    this.emitPlayerUpdate(playerId);
    return appliedDamage;
  }

  /**
   * Restore every authoritative health representation without moving a player.
   *
   * Duel cleanup cannot use the normal PLAYER_RESPAWNED path for a surviving
   * winner: that handler deliberately ignores already-alive players as an
   * anti-cheat boundary. Without this explicit server-system API, the visible
   * entity is healed while PlayerSystem retains the winner's depleted health,
   * causing the next fight to resolve against a hidden stale pool.
   */
  restorePlayerHealth(playerId: string, maxHealth: number): boolean {
    const player = this.players.get(playerId);
    if (!player || !Number.isFinite(maxHealth) || maxHealth <= 0) {
      return false;
    }

    const restoredHealth = Math.max(1, Math.floor(maxHealth));
    player.health.current = restoredHealth;
    player.health.max = restoredHealth;
    player.alive = true;
    player.death.respawnTime = 0;
    player.death.deathLocation = null;

    const entity =
      this.world.getPlayer?.(playerId) ?? this.world.entities.get(playerId);
    if (entity) {
      const restorableEntity = entity as PlayerEntity & {
        setHealthAndMaxHealth?: (current: number, max: number) => void;
        resetDeathState?: () => void;
      };
      restorableEntity.resetDeathState?.();
      if (restorableEntity.setHealthAndMaxHealth) {
        restorableEntity.setHealthAndMaxHealth(restoredHealth, restoredHealth);
      } else {
        restorableEntity.setHealth(restoredHealth);
      }

      const healthComponent = restorableEntity.getComponent("health");
      if (healthComponent?.data) {
        const healthData = healthComponent.data as {
          current?: number;
          max?: number;
          isDead?: boolean;
        };
        healthData.current = restoredHealth;
        healthData.max = restoredHealth;
        healthData.isDead = false;
      }

      const statsComponent = restorableEntity.getComponent("stats");
      if (statsComponent?.data) {
        const stats = statsComponent.data as {
          health?: { current?: number; max?: number };
          hitpoints?: { current?: number; max?: number };
        };
        if (stats.health) {
          stats.health.current = restoredHealth;
          stats.health.max = restoredHealth;
        }
        if (stats.hitpoints) {
          stats.hitpoints.current = restoredHealth;
          stats.hitpoints.max = restoredHealth;
        }
      }
    }

    this.persistPlayerHealth(playerId, player);
    this.emitPlayerUpdate(playerId);
    return true;
  }

  /**
   * Persist one authoritative health snapshot through DatabaseSystem's
   * same-tick coalescing boundary. Damage, healing, regeneration, respawn,
   * and duel restoration all pass through this helper.
   */
  private persistPlayerHealth(playerId: string, player: Player): void {
    if (!this.world.isServer || !this.databaseSystem) return;
    if (this.pendingFoodOperationByPlayer.has(playerId)) {
      this.deferredHealthPersistenceAfterFood.add(playerId);
      return;
    }
    const databaseId = PlayerIdMapper.getDatabaseId(playerId);
    this.databaseSystem.savePlayer(databaseId, {
      health: player.health.current,
      maxHealth: player.health.max,
    });
  }

  destroy(): void {
    // Clear auto-save
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }

    // Clean up all spawned player mobs (merged from PlayerSpawnSystem)
    for (const playerId of this.spawnedPlayers.keys()) {
      this.cleanupPlayerMobs(playerId);
    }
    this.spawnedPlayers.clear();

    // Clear attack style state (merged from AttackStyleSystem)
    this.playerAttackStyles.clear();

    // Clear references
    this.players.clear();
    this.readyPlayers.clear();
    this.playerHydrationGeneration.clear();
    this.playerLocalRefs.clear();
    this.pendingFoodLiveEffects.clear();
    this.pendingFoodOperationByPlayer.clear();
    this.deferredHealthPersistenceAfterFood.clear();
    this.pendingFoodCustodyAttempts.clear();
    this.foodRecoveryPlayersInFlight.clear();
    this.appliedFoodOperations.clear();
    this.appliedDuelDamageOperations.clear();
  }

  // === SPAWN SYSTEM METHODS (merged from PlayerSpawnSystem) ===

  /**
   * Handle spawn completion - equip starter gear and trigger combat
   */
  private async handleSpawnComplete(event: {
    playerId: string;
  }): Promise<void> {
    // Guard: don't re-equip starter gear if already equipped (prevents overwriting player's chosen equipment)
    const spawnData = this.spawnedPlayers.get(event.playerId);
    if (!spawnData || spawnData.hasStarterEquipment) {
      return;
    }

    const completeWithoutStarterEquipment = (): void => {
      spawnData.hasStarterEquipment = true;
      spawnData.aggroTriggered = true;
      this.emitTypedEvent(EventType.PLAYER_SPAWNED, {
        playerId: event.playerId,
        equipment: [],
        position: spawnData.position,
      });
    };

    const entity = this.world.entities.get(event.playerId);
    const entityData = entity?.data as
      | {
          isAgent?: boolean;
          isEmbeddedAgent?: boolean;
          inStreamingDuel?: boolean;
          preventRespawn?: boolean;
        }
      | undefined;
    if (
      entityData?.isAgent === true ||
      entityData?.isEmbeddedAgent === true ||
      entityData?.inStreamingDuel === true ||
      entityData?.preventRespawn === true
    ) {
      // System-controlled and competitive players already own an
      // authoritative loadout. A delayed onboarding timer must never replace
      // that equipment, especially after a public market has frozen it.
      completeWithoutStarterEquipment();
      return;
    }

    // Send welcome message
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: event.playerId,
      message: "Welcome to the world! You are equipped and ready for battle.",
      type: "info",
    });

    // Wait for avatar to load
    await new Promise<void>((resolve) => {
      const onLoad = (e: { playerId: string; success: boolean }) => {
        if (e.playerId === event.playerId && e.success) {
          this.world.off(EventType.AVATAR_LOAD_COMPLETE, onLoad);
          resolve();
        }
      };
      this.world.on(EventType.AVATAR_LOAD_COMPLETE, onLoad);
      setTimeout(resolve, 5000); // Timeout after 5s
    });

    const equipmentSystem = this.world.getSystem("equipment") as
      | {
          isEquipmentReady?: (playerId: string) => boolean;
          getPlayerEquipment?: (playerId: string) => {
            weapon?: { itemId?: string | number | null } | null;
          };
        }
      | undefined;
    if (
      equipmentSystem?.isEquipmentReady &&
      !equipmentSystem.isEquipmentReady(event.playerId)
    ) {
      this.logger.warn(
        `Starter equipment withheld while authoritative equipment is unresolved for ${event.playerId}`,
      );
      completeWithoutStarterEquipment();
      return;
    }
    const currentWeaponId = equipmentSystem
      ?.getPlayerEquipment?.(event.playerId)
      ?.weapon?.itemId?.toString()
      .trim();
    if (currentWeaponId) {
      // Returning players retain their exact persisted weapon. The legacy
      // onboarding completion may arrive seconds after join and is never an
      // authority to displace an existing loadout.
      completeWithoutStarterEquipment();
      return;
    }

    // Equip each starter item
    for (const item of this.STARTER_EQUIPMENT) {
      if (!this.spawnedPlayers.has(event.playerId)) {
        this.logger.warn(
          `Player ${event.playerId} disconnected during equipment process`,
        );
        return;
      }

      this.emitTypedEvent(EventType.EQUIPMENT_EQUIP, {
        playerId: event.playerId,
        itemId: item.itemId,
        slot: item.slot,
      });

      await this.delay(50);
    }

    const finalSpawnData = this.spawnedPlayers.get(event.playerId);
    if (finalSpawnData) {
      finalSpawnData.hasStarterEquipment = true;
    }

    // Trigger aggro after equipment
    if (this.spawnedPlayers.has(event.playerId)) {
      this.triggerGoblinAggro(event.playerId);
    }

    this.emitTypedEvent(EventType.PLAYER_SPAWNED, {
      playerId: event.playerId,
      equipment: this.STARTER_EQUIPMENT,
      position: this.spawnedPlayers.get(event.playerId)?.position,
    });
  }

  /**
   * Trigger goblin aggro near player spawn
   */
  private triggerGoblinAggro(playerId: string): void {
    const spawnData = this.spawnedPlayers.get(playerId);
    if (!spawnData || spawnData.aggroTriggered) return;

    const player = this.world.getPlayer(playerId);
    if (!player) {
      this.logger.warn(`Player ${playerId} not found when triggering aggro`);
      return;
    }

    const playerPos = player.node.position;

    const goblinSpawnPositions = [
      this._tempVec3_1.set(playerPos.x + 3, playerPos.y, playerPos.z + 2),
      this._tempVec3_2.set(playerPos.x - 2, playerPos.y, playerPos.z + 4),
      this._tempVec3_3.set(playerPos.x + 1, playerPos.y, playerPos.z - 3),
    ];

    goblinSpawnPositions.forEach((position, index) => {
      setTimeout(() => {
        this.spawnAggroGoblin(playerId, position, index);
      }, index * 500);
    });

    spawnData.aggroTriggered = true;
  }

  /**
   * Spawn an aggressive goblin
   */
  private spawnAggroGoblin(
    playerId: string,
    position: { x: number; y: number; z: number },
    index: number,
  ): void {
    const goblinId = `starter_goblin_${playerId}_${index}`;

    this.emitTypedEvent(EventType.MOB_NPC_SPAWN_REQUEST, {
      mobType: "goblin",
      position: position,
      level: 1,
      mobId: goblinId,
    });

    this.emitTypedEvent(EventType.UI_MESSAGE, {
      mobId: goblinId,
      targetId: playerId,
      aggroAmount: 100,
      reason: "starter_spawn",
    });
  }

  /**
   * Clean up mobs spawned for a specific player
   */
  private cleanupPlayerMobs(playerId: string): void {
    for (let i = 0; i < 3; i++) {
      const goblinId = `starter_goblin_${playerId}_${i}`;
      this.emitTypedEvent(EventType.MOB_NPC_DESPAWN, { mobId: goblinId });
    }
  }

  /**
   * Check if player has completed spawn process
   */
  public hasPlayerCompletedSpawn(playerId: string): boolean {
    const spawnData = this.spawnedPlayers.get(playerId);
    return !!(spawnData?.hasStarterEquipment && spawnData?.aggroTriggered);
  }

  /**
   * Get spawn data for player
   */
  public getPlayerSpawnData(playerId: string): PlayerSpawnData | undefined {
    return this.spawnedPlayers.get(playerId);
  }

  /**
   * Manually trigger goblin aggro (for testing)
   */
  public forceTriggerAggro(playerId: string): void {
    const spawnData = this.spawnedPlayers.get(playerId);
    if (!spawnData) return;

    spawnData.aggroTriggered = false;
    this.triggerGoblinAggro(playerId);
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private startAutoSave(): void {
    this.saveInterval = this.createInterval(() => {
      this.performAutoSave();
    }, this.AUTO_SAVE_INTERVAL)!;
  }

  update(_dt: number): void {
    // Sync player positions from entities each frame (server only)
    if (!this.world.network?.isServer) return;

    this.advancePendingFoodRecovery();

    for (const [playerId, player] of this.players) {
      const entity = this.world.entities.get(playerId);
      if (entity && entity.position) {
        // Update player object position from entity
        player.position.x = entity.position.x;
        player.position.y = entity.position.y;
        player.position.z = entity.position.z;
      }
    }
  }

  private async performAutoSave(): Promise<void> {
    await this.saveAllPlayersToDatabase();
  }

  /**
   * Await a direct persistence snapshot for every live player.
   * Graceful shutdown calls this before DatabaseSystem rejects new writes.
   */
  async saveAllPlayersToDatabase(): Promise<void> {
    if (!this.databaseSystem) return;
    await Promise.all(
      Array.from(this.players.keys(), (playerId) =>
        this.savePlayerToDatabase(playerId),
      ),
    );
  }

  private async savePlayerToDatabase(playerId: string): Promise<void> {
    const player = this.players.get(playerId);
    if (!player || !this.databaseSystem) return;

    // Use userId for database persistence if available
    const databaseId = PlayerIdMapper.getDatabaseId(playerId);

    // Database save happens here

    // NEVER save invalid Y positions to database
    let safeY = player.position.y;
    if (safeY < -5 || safeY > 200 || !Number.isFinite(safeY)) {
      console.error(
        `[PlayerSystem] WARNING: Refusing to save invalid Y position to DB: ${safeY}, saving Y=10 instead`,
      );
      safeY = 10; // Safe default
    }

    // NEVER save invalid health values to database
    let safeHealth = player.health.current;
    let safeMaxHealth = player.health.max;
    if (!Number.isFinite(safeMaxHealth) || safeMaxHealth <= 0) {
      console.error(
        `[PlayerSystem] WARNING: Invalid maxHealth detected: ${safeMaxHealth}, using 100 instead. Player health object:`,
        player.health,
      );
      safeMaxHealth = 100;
    }
    if (!Number.isFinite(safeHealth) || safeHealth < 0) {
      console.error(
        `[PlayerSystem] WARNING: Invalid health detected: ${safeHealth}, using maxHealth instead. Player health object:`,
        player.health,
      );
      safeHealth = safeMaxHealth;
    }
    safeHealth = Math.min(safeHealth, safeMaxHealth); // Ensure current <= max
    const foodHealthEffectPending =
      this.pendingFoodOperationByPlayer.has(playerId);
    if (foodHealthEffectPending) {
      this.deferredHealthPersistenceAfterFood.add(playerId);
    }

    await this.databaseSystem.savePlayerAsync(databaseId, {
      name: player.name,
      combatLevel: player.combat.combatLevel,
      attackLevel: player.skills.attack.level,
      strengthLevel: player.skills.strength.level,
      defenseLevel: player.skills.defense.level,
      constitutionLevel: player.skills.constitution.level,
      rangedLevel: player.skills.ranged.level,
      // The durable food completion is additive and owns this temporary live
      // delta. Continue saving every unrelated character field, but withhold
      // health until that operation settles so autosave cannot get ahead of
      // custody or turn an optimistic heal into an independent snapshot.
      ...(foodHealthEffectPending
        ? {}
        : { health: safeHealth, maxHealth: safeMaxHealth }),
      positionX: player.position.x,
      positionY: safeY,
      positionZ: player.position.z,
    });
  }

  private calculateCombatLevel(skills: Skills): number {
    return calculateRulesCombatLevel({
      attack: skills.attack.level,
      strength: skills.strength.level,
      defense: skills.defense.level,
      hitpoints: skills.constitution.level,
      ranged: skills.ranged.level,
      magic: skills.magic.level,
      prayer: skills.prayer.level,
    });
  }

  /**
   * Sync combat level to entity data and broadcast to all clients
   * Call this after recalculating combat level to ensure remote players see updates
   */
  private syncCombatLevelToEntity(playerId: string, combatLevel: number): void {
    if (!this.world.isServer) return;

    const entity = this.world.entities.get(playerId);
    if (entity) {
      // Update entity data so serialize() includes correct combat level
      (entity.data as { combatLevel?: number }).combatLevel = combatLevel;

      // Broadcast to all clients via entityModified
      if (this.world.network?.send) {
        this.world.network.send("entityModified", {
          id: playerId,
          combatLevel: combatLevel,
        });
      }
    }
  }

  // === ATTACK STYLE METHODS (merged from AttackStyleSystem) ===

  /**
   * Initialize attack style for a new player
   * @param playerId - The player's ID
   * @param savedStyle - The saved attack style from database (if any)
   */
  private initializePlayerAttackStyle(
    playerId: string,
    savedStyle?: string,
  ): void {
    // Idempotency is the caller's responsibility:
    // - Auto-init call sites guard with `if (!playerState)` before calling
    // - onPlayerRegister guards with `if (!this.playerAttackStyles.has(playerId))`
    // This method itself has no guard so that it can be called unconditionally
    // by any future caller that intentionally needs to reset state.

    // Use saved style from database, or default to "accurate"
    const initialStyle =
      savedStyle && this.ATTACK_STYLES[savedStyle] ? savedStyle : "accurate";

    const playerState: PlayerAttackStyleState = {
      playerId,
      selectedStyle: initialStyle,
    };

    this.playerAttackStyles.set(playerId, playerState);

    // Notify UI of initial attack style
    this.emitTypedEvent(EventType.UI_ATTACK_STYLE_CHANGED, {
      playerId,
      currentStyle: this.ATTACK_STYLES[initialStyle],
      availableStyles: Object.values(this.ATTACK_STYLES),
      canChange: true,
    });
  }

  /**
   * Validate, persist, and apply one attack-style change. In a streaming duel,
   * the accepted public observation shares this exact database transaction.
   */
  async changeAttackStyleAtomic(
    playerId: string,
    newStyle: string,
    publicActionObservation?: StreamingDuelStyleObservationContext,
  ): Promise<AttackStyleChangeReceipt> {
    const normalizedPlayerId = String(playerId ?? "").trim();
    const normalizedStyle = String(newStyle ?? "").trim();
    const parsedPublicActionObservation =
      publicActionObservation === undefined
        ? null
        : parseStreamingDuelStyleObservationContext(publicActionObservation);
    const operationId =
      parsedPublicActionObservation?.operationId ??
      globalThis.crypto?.randomUUID?.() ??
      "";
    const failure = (
      reason: Extract<AttackStyleChangeReceipt, { ok: false }>["reason"],
      committed = false,
      replayed = false,
      currentStyle: string | null = null,
    ): AttackStyleChangeReceipt => ({
      ok: false,
      committed,
      liveStateApplied: false,
      operationId,
      playerId: normalizedPlayerId,
      requestedStyle: normalizedStyle,
      currentStyle,
      replayed,
      publicActionObservation: parsedPublicActionObservation,
      reason,
    });

    if (
      !normalizedPlayerId ||
      !operationId ||
      !this.ATTACK_STYLES[normalizedStyle] ||
      (publicActionObservation !== undefined &&
        (!parsedPublicActionObservation ||
          parsedPublicActionObservation.actorId !== normalizedPlayerId ||
          parsedPublicActionObservation.style !== normalizedStyle))
    ) {
      return failure("invalid_request");
    }

    let playerState = this.playerAttackStyles.get(normalizedPlayerId);
    if (!playerState && this.isKnownPlayer(normalizedPlayerId)) {
      const defaultStyle = getDefaultStyleForWeapon(
        this.getPlayerWeaponType(normalizedPlayerId),
      );
      this.logger.debug(
        `Auto-initializing attack style for ${normalizedPlayerId} (event ordering race), default: ${defaultStyle}`,
      );
      this.initializePlayerAttackStyle(normalizedPlayerId, defaultStyle);
      playerState = this.playerAttackStyles.get(normalizedPlayerId);
    }
    if (!playerState) return failure("player_missing");

    const weaponType = this.getPlayerWeaponType(normalizedPlayerId);
    if (
      !isStyleValidForWeapon(weaponType, normalizedStyle as CombatStyleExtended)
    ) {
      return failure(
        "style_not_available",
        false,
        false,
        playerState.selectedStyle,
      );
    }
    const databaseId = PlayerIdMapper.getDatabaseId(normalizedPlayerId);
    const db = this.databaseSystem;
    if (!this.world.isServer || !db?.commitAttackStyleOperationAsync) {
      return failure(
        "atomic_persistence_unavailable",
        false,
        false,
        playerState.selectedStyle,
      );
    }

    let requestFingerprint: string;
    try {
      requestFingerprint = await playerSha256Hex(
        JSON.stringify({
          version: 1,
          playerId: databaseId,
          requestedStyle: normalizedStyle,
          ...(parsedPublicActionObservation
            ? { publicActionObservation: parsedPublicActionObservation }
            : {}),
        }),
      );
    } catch {
      return failure(
        "atomic_persistence_unavailable",
        false,
        false,
        playerState.selectedStyle,
      );
    }
    const request: AttackStyleCommitRequest = {
      operationId,
      playerId: databaseId,
      requestFingerprint,
      requestedStyle: normalizedStyle,
      ...(parsedPublicActionObservation
        ? { publicActionObservation: parsedPublicActionObservation }
        : {}),
    };

    let receipt: AttackStyleCommitReceipt;
    try {
      receipt = await db.commitAttackStyleOperationAsync(request);
    } catch (firstError) {
      const deterministic = classifyDeterministicAttackStyleError(firstError);
      if (deterministic) {
        return failure(deterministic, false, false, playerState.selectedStyle);
      }
      try {
        receipt = await db.commitAttackStyleOperationAsync(request);
      } catch (retryError) {
        Logger.systemError(
          "PlayerSystem",
          `Atomic attack style commit failed for ${normalizedPlayerId}: ${String(retryError)} (first failure: ${String(firstError)})`,
        );
        return failure(
          "persistence_failed",
          false,
          false,
          playerState.selectedStyle,
        );
      }
    }

    if (
      receipt.operationId !== operationId ||
      receipt.playerId !== databaseId ||
      receipt.requestFingerprint !== requestFingerprint ||
      receipt.requestedStyle !== normalizedStyle ||
      receipt.operationCommittedStyle !== normalizedStyle ||
      !this.ATTACK_STYLES[receipt.currentStyle]
    ) {
      return failure(
        "persistence_failed",
        true,
        receipt.replayed,
        playerState.selectedStyle,
      );
    }
    if (receipt.currentStyle !== normalizedStyle) {
      return failure(
        "operation_superseded",
        true,
        receipt.replayed,
        receipt.currentStyle,
      );
    }
    if (
      !isStyleValidForWeapon(
        this.getPlayerWeaponType(normalizedPlayerId),
        receipt.currentStyle as CombatStyleExtended,
      )
    ) {
      return failure(
        "committed_state_apply_failed",
        true,
        receipt.replayed,
        receipt.currentStyle,
      );
    }

    const oldStyle = playerState.selectedStyle;
    playerState.selectedStyle = receipt.currentStyle;
    const style = this.ATTACK_STYLES[receipt.currentStyle];
    this.emitTypedEvent(EventType.UI_ATTACK_STYLE_CHANGED, {
      playerId: normalizedPlayerId,
      currentStyle: style,
      availableStyles: Object.values(this.ATTACK_STYLES),
      canChange: true,
      cooldownRemaining: 0,
    });
    if (oldStyle !== receipt.currentStyle) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: normalizedPlayerId,
        message: `Attack style changed from ${this.ATTACK_STYLES[oldStyle].name} to ${style.name}. ${style.description}`,
        type: "info",
      });
    }

    return {
      ok: true,
      committed: true,
      liveStateApplied: true,
      operationId,
      playerId: normalizedPlayerId,
      requestedStyle: normalizedStyle,
      currentStyle: receipt.currentStyle,
      replayed: receipt.replayed,
      publicActionObservation: parsedPublicActionObservation,
    };
  }

  private async handleStyleChange(data: {
    playerId: string;
    newStyle: string;
  }): Promise<void> {
    const receipt = await this.changeAttackStyleAtomic(
      data.playerId,
      data.newStyle,
    );
    if (receipt.ok) return;
    if (receipt.reason === "player_missing") {
      this.logger.warn(
        `Attack style change rejected: no state for player ${data.playerId}`,
      );
      return;
    }
    const style = this.ATTACK_STYLES[data.newStyle];
    if (receipt.reason === "style_not_available" && style) {
      const availableStyles = getAvailableStyles(
        this.getPlayerWeaponType(data.playerId),
      );
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: data.playerId,
        message: `${style.name} style is not available for this weapon. Available: ${availableStyles.join(", ")}`,
        type: "warning",
      });
      return;
    }
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: data.playerId,
      message: style
        ? "Attack style change could not be confirmed. Please try again."
        : `Invalid attack style: ${data.newStyle}`,
      type: "error",
    });
  }

  /**
   * rules-accurate: When weapon changes, validate current style is still available.
   * If not, auto-switch to the first valid style for the new weapon type.
   * Example: switching from staff (autocast) to sword → auto-select "accurate"
   */
  private async handleWeaponChange(playerId: string): Promise<void> {
    const playerState = this.playerAttackStyles.get(playerId);
    if (!playerState) return;

    const weaponType = this.getPlayerWeaponType(playerId);
    const currentStyle = playerState.selectedStyle as CombatStyleExtended;

    if (!isStyleValidForWeapon(weaponType, currentStyle)) {
      const newStyle = getDefaultStyleForWeapon(weaponType);
      await this.handleStyleChange({ playerId, newStyle });
    }
  }

  /**
   * CLIENT-SIDE: Sync internal state when receiving authoritative style from server.
   *
   * This fixes a bug where the client initializes playerAttackStyles with "accurate"
   * (because there's no database on client), but the server has the correct saved style.
   * When the server sends the correct style via attackStyleChanged packet, we need to
   * update the client's internal Map so that getAttackStyleInfo() returns the correct value.
   */
  private handleStyleSyncFromServer(data: {
    playerId: string;
    currentStyle: { id: string };
  }): void {
    // Only sync on client - server is authoritative and doesn't need this
    if (this.world.isServer) return;

    const { playerId, currentStyle } = data;
    if (!currentStyle?.id) return;

    const playerState = this.playerAttackStyles.get(playerId);
    if (!playerState) {
      // Player not yet initialized, create state with server's value
      this.playerAttackStyles.set(playerId, {
        playerId,
        selectedStyle: currentStyle.id,
      });
      return;
    }

    // Update existing state with server's authoritative value
    if (playerState.selectedStyle !== currentStyle.id) {
      playerState.selectedStyle = currentStyle.id;
    }
  }

  /** Check if an ID corresponds to a known player (registered or entity with type "player"). */
  private isKnownPlayer(playerId: string): boolean {
    if (this.players.has(playerId)) return true;
    const entity = this.world.entities?.get(playerId);
    return !!entity && (entity as { type?: string }).type === "player";
  }

  private static readonly VALID_WEAPON_TYPES = new Set<string>(
    Object.values(WeaponType),
  );

  /** Validated weapon type lookup — returns WeaponType.NONE for unknown types */
  private getPlayerWeaponType(playerId: string): WeaponType {
    const equipmentSystem = this.world.getSystem("equipment") as {
      getPlayerEquipment?: (id: string) => {
        weapon?: { item?: { weaponType?: string } };
      } | null;
    } | null;

    if (!equipmentSystem?.getPlayerEquipment) return WeaponType.NONE;

    const equipment = equipmentSystem.getPlayerEquipment(playerId);
    const raw = equipment?.weapon?.item?.weaponType?.toLowerCase();
    if (!raw || !PlayerSystem.VALID_WEAPON_TYPES.has(raw)) {
      return WeaponType.NONE;
    }
    return raw as WeaponType;
  }

  /**
   * Handle request for style info
   */
  private handleGetStyleInfo(data: {
    playerId: string;
    callback?: (info: Record<string, unknown> | null) => void;
  }): void {
    const { playerId, callback } = data;

    if (!callback) {
      this.emitStyleUpdateEvent(playerId);
      return;
    }

    const playerState = this.playerAttackStyles.get(playerId);
    if (!playerState) {
      callback(null);
      return;
    }

    const currentStyle = this.ATTACK_STYLES[playerState.selectedStyle];

    const styleInfo = {
      style: playerState.selectedStyle,
      currentStyle,
      availableStyles: Object.values(this.ATTACK_STYLES),
      canChange: true,
    };

    callback(styleInfo);
  }

  private emitStyleUpdateEvent(playerId: string): void {
    const playerState = this.playerAttackStyles.get(playerId);
    if (playerState) {
      const currentStyle = this.ATTACK_STYLES[playerState.selectedStyle];

      this.emitTypedEvent(EventType.UI_ATTACK_STYLE_UPDATE, {
        playerId,
        currentStyle,
        availableStyles: Object.values(this.ATTACK_STYLES),
        canChange: true,
      });
    }
  }

  // Public API methods for attack styles
  getPlayerAttackStyle(playerId: string): AttackStyle | null {
    const playerState = this.playerAttackStyles.get(playerId);
    if (!playerState) return null;

    return this.ATTACK_STYLES[playerState.selectedStyle] || null;
  }

  getAllAttackStyles(): AttackStyle[] {
    return Object.values(this.ATTACK_STYLES);
  }

  async forceChangeAttackStyle(
    playerId: string,
    styleId: string,
  ): Promise<boolean> {
    const style = this.ATTACK_STYLES[styleId];
    if (!style) return false;

    const playerState = this.playerAttackStyles.get(playerId);
    if (!playerState) return false;

    return (await this.changeAttackStyleAtomic(playerId, styleId)).ok;
  }

  getAttackStyleSystemInfo(): Record<string, unknown> {
    const activeStyles: { [key: string]: number } = {};
    let totalPlayers = 0;

    for (const playerState of this.playerAttackStyles.values()) {
      totalPlayers++;
      const style = playerState.selectedStyle;
      activeStyles[style] = (activeStyles[style] || 0) + 1;
    }

    return {
      totalPlayers,
      activeStyles,
      availableStyles: Object.keys(this.ATTACK_STYLES),
    };
  }

  // ============================================================================
  // AUTO-RETALIATE METHODS
  // ============================================================================

  /**
   * Initialize auto-retaliate for a new player
   */
  private initializePlayerAutoRetaliate(
    playerId: string,
    enabled: boolean,
  ): void {
    // No idempotency guard — onPlayerRegister carries DB-loaded values that must
    // overwrite any auto-initialized defaults. Auto-init call sites already guard
    // with `if (!this.playerAutoRetaliate.has(playerId))` before setting.
    this.playerAutoRetaliate.set(playerId, enabled);

    // Notify UI of initial state
    this.emitTypedEvent(EventType.UI_AUTO_RETALIATE_CHANGED, {
      playerId,
      enabled,
    });
  }

  /**
   * Handle toggle request with validation and rate limiting
   *
   * Security: Server validates before applying (server authority)
   * OWASP: Input validation + rate limiting
   */
  private handleAutoRetaliateToggle(data: {
    playerId: string;
    enabled: boolean;
  }): void {
    const { playerId, enabled } = data;

    // === INPUT VALIDATION (OWASP) ===
    // 1. Validate playerId exists in our system — auto-initialize if missing
    // (onPlayerRegister may not have fired yet due to event ordering)
    if (!this.playerAutoRetaliate.has(playerId)) {
      // Only auto-initialize for player entities (not mobs or other entity types)
      if (this.isKnownPlayer(playerId)) {
        this.logger.debug(
          `Auto-initializing auto-retaliate for ${playerId} (event ordering race)`,
        );
        this.playerAutoRetaliate.set(playerId, true); // default ON
      } else {
        this.logger.warn(
          `Auto-retaliate toggle rejected: unknown player ${playerId}`,
        );
        return;
      }
    }

    // 2. Validate enabled is actually a boolean (prevent type coercion attacks)
    if (typeof enabled !== "boolean") {
      this.logger.warn(
        `Auto-retaliate toggle rejected: invalid enabled type for ${playerId}`,
      );
      return;
    }

    // === RATE LIMITING (Anti-Spam) ===
    const now = Date.now();
    const lastToggle = this.autoRetaliateLastToggle.get(playerId) ?? 0;
    if (now - lastToggle < this.AUTO_RETALIATE_COOLDOWN_MS) {
      // Silent ignore - don't spam logs for rate limited requests
      return;
    }
    this.autoRetaliateLastToggle.set(playerId, now);

    // === APPLY CHANGE (Server Authority) ===
    const oldValue = this.playerAutoRetaliate.get(playerId);
    if (oldValue === enabled) {
      // No change needed - avoid unnecessary DB writes
      return;
    }

    this.playerAutoRetaliate.set(playerId, enabled);

    // Persist to database (server-side only)
    if (this.world.isServer && this.databaseSystem) {
      const databaseId = PlayerIdMapper.getDatabaseId(playerId);
      this.databaseSystem.savePlayer(databaseId, {
        autoRetaliate: enabled ? 1 : 0,
      });
    }

    // Notify UI (broadcasts to client)
    this.emitTypedEvent(EventType.UI_AUTO_RETALIATE_CHANGED, {
      playerId,
      enabled,
    });

    // Chat message feedback
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: `Auto retaliate: ${enabled ? "ON" : "OFF"}`,
      type: "info",
    });
  }

  /**
   * Handle autocast spell selection
   * Sets the player's selected spell for magic combat
   */
  private handleSetAutocast(data: {
    playerId: string;
    spellId: string | null;
  }): void {
    const { playerId, spellId } = data;

    // Validate player exists in PlayerSystem's internal map
    const player = this.players.get(playerId);
    if (!player) {
      this.logger.warn(`Set autocast rejected: unknown player ${playerId}`);
      return;
    }

    // Update player entity data on PlayerSystem's internal player
    if (player.data) {
      (player.data as { selectedSpell?: string | null }).selectedSpell =
        spellId;
    }
    player.selectedSpell = spellId;

    // ALSO update on Entities.players (used by CombatSystem via world.getPlayer())
    const entitiesPlayer = this.world.getPlayer?.(playerId);
    if (entitiesPlayer?.data) {
      (entitiesPlayer.data as { selectedSpell?: string | null }).selectedSpell =
        spellId;
    }

    // Persist to database (server-side only)
    if (this.world.isServer && this.databaseSystem) {
      const databaseId = PlayerIdMapper.getDatabaseId(playerId);
      this.databaseSystem.savePlayer(databaseId, {
        selectedSpell: spellId,
      });
    }

    // Notify client of autocast change
    this.emitTypedEvent(EventType.COMBAT_AUTOCAST_SET, {
      playerId,
      spellId,
    });

    // Chat message feedback
    if (spellId) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `Autocast set to ${spellId.replace(/_/g, " ")}`,
        type: "info",
      });
    } else {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Autocast disabled",
        type: "info",
      });
    }
  }

  /**
   * Handle get request for auto-retaliate state
   */
  private handleGetAutoRetaliate(data: {
    playerId: string;
    callback?: (enabled: boolean) => void;
  }): void {
    // First try server-side Map (populated during enterWorld on server)
    let enabled = this.playerAutoRetaliate.get(data.playerId);

    // Client-side fallback: read from PlayerLocal.combat.autoRetaliate
    // The client's Map is not populated, but PlayerLocal has the correct value from entity data
    if (enabled === undefined && !this.world.isServer) {
      const localPlayer = this.world.entities?.player;
      if (localPlayer && localPlayer.id === data.playerId) {
        // Access combat.autoRetaliate from PlayerLocal
        const combat = (localPlayer as { combat?: { autoRetaliate?: boolean } })
          .combat;
        enabled = combat?.autoRetaliate ?? true;
      }
    }

    // Final fallback: default to true (classic MMORPG behavior)
    enabled = enabled ?? true;

    if (data.callback) {
      data.callback(enabled);
    } else {
      this.emitTypedEvent(EventType.UI_AUTO_RETALIATE_CHANGED, {
        playerId: data.playerId,
        enabled,
      });
    }
  }

  /**
   * Public API for CombatSystem to check auto-retaliate
   *
   * Performance: O(1) Map lookup, no allocations
   * Called in combat hot path - must be fast
   */
  getPlayerAutoRetaliate(playerId: string): boolean {
    return this.playerAutoRetaliate.get(playerId) ?? true;
  }

  private handleSkillsUpdate(data: {
    playerId: string;
    skills: Skills;
    persistence?: "already_committed";
  }): void {
    const player = this.players.get(data.playerId);
    if (!player) {
      this.pendingSkillUpdates.set(data.playerId, {
        skills: data.skills,
        persistence: data.persistence,
      });
      return;
    }

    // Update player skills
    player.skills = data.skills;

    // Recalculate combat level
    player.combat.combatLevel = this.calculateCombatLevel(data.skills);

    // Sync to entity and broadcast to all clients
    this.syncCombatLevelToEntity(data.playerId, player.combat.combatLevel);

    // Update stats component with new skill data for SkillsSystem and combat calculations
    const playerEntity = this.world.entities.get(data.playerId);
    if (playerEntity) {
      const statsComponent = playerEntity.getComponent("stats");
      if (statsComponent) {
        // Update skill data (full SkillData objects with level + xp) in stats component
        statsComponent.data.attack = data.skills.attack;
        statsComponent.data.strength = data.skills.strength;
        statsComponent.data.defense = data.skills.defense;
        statsComponent.data.constitution = data.skills.constitution;
        statsComponent.data.ranged = data.skills.ranged;
        statsComponent.data.magic = data.skills.magic;
        statsComponent.data.prayer = data.skills.prayer;
        statsComponent.data.woodcutting = data.skills.woodcutting;
        statsComponent.data.mining = data.skills.mining;
        statsComponent.data.fishing = data.skills.fishing;
        statsComponent.data.firemaking = data.skills.firemaking;
        statsComponent.data.cooking = data.skills.cooking;
        statsComponent.data.smithing = data.skills.smithing;
        statsComponent.data.agility = data.skills.agility;
        statsComponent.data.crafting = data.skills.crafting;
        statsComponent.data.fletching = data.skills.fletching;
        statsComponent.data.runecrafting = data.skills.runecrafting;
      }
    }

    // Trigger UI update to reflect skill changes
    this.emitPlayerUpdate(data.playerId);

    // Persist skill XP/levels to database (debounced)
    if (data.persistence !== "already_committed") {
      this.scheduleSaveSkills(data.playerId);
    }
  }

  private scheduleSaveSkills(playerId: string): void {
    // Save immediately for first update, then debounce subsequent updates
    const existing = this.skillSaveTimers.get(playerId);
    if (!existing) {
      // First skill update - save immediately
      this.saveSkillsToDatabase(playerId);
    }

    // Also schedule debounced save for continuous updates
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.skillSaveTimers.delete(playerId);
      this.saveSkillsToDatabase(playerId);
    }, 500);
    this.skillSaveTimers.set(playerId, timer);
  }

  private saveSkillsToDatabase(playerId: string): void {
    if (!this.databaseSystem) return;
    const player = this.players.get(playerId);
    if (!player) return;

    const s = player.skills;
    // Map runtime skills -> DB columns
    const update: Record<string, number> = {
      combatLevel: player.combat.combatLevel,
      attackLevel: s.attack.level,
      strengthLevel: s.strength.level,
      defenseLevel: s.defense.level,
      constitutionLevel: s.constitution.level,
      rangedLevel: s.ranged.level,
      magicLevel: s.magic.level,
      woodcuttingLevel: s.woodcutting.level,
      miningLevel: s.mining.level,
      fishingLevel: s.fishing.level,
      firemakingLevel: s.firemaking.level,
      cookingLevel: s.cooking.level,
      smithingLevel: s.smithing.level,
      agilityLevel: s.agility.level,
      craftingLevel: s.crafting.level,
      fletchingLevel: s.fletching.level,
      runecraftingLevel: s.runecrafting.level,
      // XP
      attackXp: Math.floor(s.attack.xp),
      strengthXp: Math.floor(s.strength.xp),
      defenseXp: Math.floor(s.defense.xp),
      constitutionXp: Math.floor(s.constitution.xp),
      rangedXp: Math.floor(s.ranged.xp),
      magicXp: Math.floor(s.magic.xp),
      woodcuttingXp: s.woodcutting.xp,
      miningXp: s.mining.xp,
      fishingXp: s.fishing.xp,
      firemakingXp: s.firemaking.xp,
      cookingXp: s.cooking.xp,
      smithingXp: s.smithing.xp,
      agilityXp: Math.floor(s.agility.xp),
      craftingXp: s.crafting.xp,
      fletchingXp: s.fletching.xp,
      runecraftingXp: s.runecrafting.xp,
    };
    try {
      this.databaseSystem.savePlayer(playerId, update);
    } catch (err) {
      console.error("[PlayerSystem] Failed to save skills to DB:", err);
    }
  }
}
