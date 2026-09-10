/**
 * CombatSystem - Handles all combat mechanics
 */

import { EventType } from "../../../types/events";
import type { CombatProjectileCancelledPayload } from "../../../types/events/event-payloads";
import type { World } from "../../../core/World";
import {
  COMBAT_CONSTANTS,
  WEAPON_DEFAULT_ATTACK_STYLE,
  type MeleeAttackStyle,
} from "../../../constants/CombatConstants";
import { AttackType } from "../../../types/core/core";
import { EntityID } from "../../../types/core/identifiers";
import { MobEntity } from "../../../entities/npc/MobEntity";
import { Entity } from "../../../entities/Entity";
// NOTE: Import directly to avoid circular dependency through barrel file
import { PlayerSystem } from "../character/PlayerSystem";
import {
  isAttackOnCooldownTicks,
  calculateRetaliationDelay,
  CombatStyle,
  PrayerCombatBonuses,
} from "../../../utils/game/CombatCalculations";
import { PrayerSystem } from "../character/PrayerSystem";
import { createEntityID } from "../../../utils/IdentifierUtils";
// NOTE: Import directly to avoid circular dependency through barrel file
import { EntityManager } from "../entities/EntityManager";
import { MobNPCSystem } from "../entities/MobNPCSystem";
import { SystemBase } from "../infrastructure/SystemBase";
import {
  tilesWithinMeleeRange,
  tilesWithinRange,
  worldToTile,
} from "../movement/TileSystem";
import { tilePool, PooledTile } from "../../../utils/pools/TilePool";
import { CombatAnimationManager } from "./CombatAnimationManager";
import { CombatRotationManager } from "./CombatRotationManager";
import { CombatStateService, CombatData } from "./CombatStateService";
import {
  CombatAntiCheat,
  CombatViolationType,
  CombatViolationSeverity,
} from "./CombatAntiCheat";
import { getEntityPosition } from "../../../utils/game/EntityPositionUtils";
import { quaternionPool } from "../../../utils/pools/QuaternionPool";
import { EntityIdValidator } from "./EntityIdValidator";
import { CombatRateLimiter } from "./CombatRateLimiter";
import { CombatEntityResolver } from "./CombatEntityResolver";
import { DamageCalculator } from "./DamageCalculator";
import {
  EventStore,
  GameEventType,
  type GameStateInfo,
  type EntitySnapshot,
  type CombatSnapshot,
} from "../EventStore";
import {
  getGameRngState,
  type SeededRandomState,
} from "../../../utils/SeededRandom";
import {
  DamageHandler,
  PlayerDamageHandler,
  MobDamageHandler,
} from "./handlers";
import type { DamageApplicationResult } from "./handlers";
import type { StreamingDuelDamageObservationContext } from "../../../types/game/streaming-duel-action-observation";
import type {
  DuelDamageCompetitiveTerminal,
  DuelDamageProjectileCostAuthority,
} from "../../../types/network/database";
import {
  getStreamingDuelDamageAuthority,
  type StreamingDuelDamageAuthority,
  type StreamingDuelDamageCommitAuthority,
} from "./StreamingDuelDamageAuthority";
import { PidManager } from "./PidManager";
import { getGameRng } from "../../../utils/SeededRandom";
import {
  isEntityDead,
  getMobRetaliates,
  getPendingAttacker,
  clearPendingAttacker,
  isPlayerDamageHandler,
  isMobEntity,
} from "../../../utils/typeGuards";
import { ZoneDetectionSystem } from "../death/ZoneDetectionSystem";
import { tileChebyshevDistance } from "../movement/TileSystem";

// Ranged/Magic combat services (F2P Phase 1)
import {
  calculateRangedDamage,
  type RangedDamageParams,
} from "./RangedDamageCalculator";
import {
  calculateMagicDamage,
  type MagicDamageParams,
} from "./MagicDamageCalculator";
import {
  type RangedCombatStyle,
  type MagicCombatStyle,
  RANGED_STYLE_BONUSES,
} from "../../../types/game/combat-types";
import { ammunitionService } from "./AmmunitionService";
import { runeService } from "./RuneService";
import { spellService, type Spell } from "./SpellService";
import {
  ProjectileService,
  type CombatProjectile,
  type CreateProjectileParams,
  type ProjectileLifecycleDiagnostics,
} from "./ProjectileService";
import { getNPCById } from "../../../data/npcs";
import { isPositionInsideDuelArenaZone } from "../../../data/duel-manifest";
import type {
  AtomicAmmunitionShotReceipt,
  EquipmentSystem,
} from "../character/EquipmentSystem";
import type { InventorySystem } from "../character/InventorySystem";
import type { ProjectileRuneCostSettlementHandle } from "../../../types/network/database";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import type { GroundItemSourceRegistrationReceipt } from "../../../types/network/database";
import type { Item, EquipmentSlot } from "../../../types/game/item-types";
import { uuid } from "../../../utils/IdGenerator";

// Re-export CombatData from CombatStateService for backwards compatibility
export type { CombatData } from "./CombatStateService";

/**
 * Attack data structure for validation and execution
 */
interface MeleeAttackData {
  attackerId: string;
  targetId: string;
  attackerType: "player" | "mob";
  targetType: "player" | "mob";
}

/**
 * Result of attack validation
 * Contains validated entities if successful, or null if validation failed
 */
interface AttackValidationResult {
  valid: boolean;
  attacker: Entity | MobEntity | null;
  target: Entity | MobEntity | null;
  typedAttackerId: EntityID | null;
  typedTargetId: EntityID | null;
}

type DamageResolution = DamageApplicationResult & {
  publicActionObservation?: StreamingDuelDamageObservationContext;
  competitiveTerminal?: DuelDamageCompetitiveTerminal;
};

type PendingDuelDamageOperation = {
  status: "queued" | "committing" | "reconciling";
  startedAt: number;
  reconciliationAttempts: number;
  reconciliationStartedAt: number | null;
};

type DuelDamageRetryWait = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (continueRetrying: boolean) => void;
};

export type DuelDamageReconciliationStats = {
  pendingOperations: number;
  queuedOperations: number;
  committingOperations: number;
  reconcilingOperations: number;
  maxReconciliationAttempts: number;
  oldestPendingAgeMs: number;
  oldestReconciliationAgeMs: number;
};

const DUEL_DAMAGE_RECONCILIATION_RETRY_MS = 1_000;

export class CombatSystem extends SystemBase {
  private nextAttackTicks = new Map<EntityID, number>(); // Tick when entity can next attack
  /** Durable ammunition/rune custody can cross ticks; one source commits at a time. */
  private readonly pendingProjectileAttacks = new Set<EntityID>();
  /**
   * A frozen loadout switch must let already-paid projectiles resolve without
   * allowing either combatant to immediately launch another one. The
   * orchestrator releases this pair by ending and recreating combat only after
   * the projectile boundary is empty.
   */
  private readonly autoAttackQuiescedEntities = new Set<EntityID>();
  /**
   * Private duel preparation owns a longer-lived admission fence than a role
   * switch. It starts before ordinary combat teardown and remains until the
   * exact preparation freezes or terminates, preventing a delayed hit or
   * retaliation from spending custody after the bank plan was computed.
   */
  private readonly duelPreparationCombatFences = new Map<EntityID, string>();
  /**
   * Full projectile admission and terminal-custody operations still in flight.
   * A combat stop synchronously cancels local projectiles, but the matching
   * database receipt and optional recovered-ammunition presentation are async.
   * Teardown must await this set before inventory/equipment projections unload.
   */
  private readonly pendingProjectileCustodyOperations = new Set<
    Promise<unknown>
  >();
  /** Exact per-attacker tails preserve impact order without dropping later hits. */
  private readonly duelDamageTailByAttacker = new Map<string, Promise<void>>();
  /** Aggregate-only state keeps unknown database outcomes operator-visible. */
  private readonly pendingDuelDamageOperations = new Map<
    string,
    PendingDuelDamageOperation
  >();
  private readonly duelDamageRetryWaits = new Set<DuelDamageRetryWait>();
  private duelDamageReconciliationStopped = false;
  /** Reference counts keep commit epochs bounded to custody operations in flight. */
  private readonly attackCommitReferences = new Map<string, number>();
  /**
   * Fences an async projectile commit from a combat authority that has ended.
   * Custody can resolve after forceEndCombat(), so a successful debit alone is
   * never sufficient authority to recreate combat or launch delayed damage.
   */
  private readonly attackCommitEpochs = new Map<string, number>();
  private mobSystem?: MobNPCSystem;
  private entityManager?: EntityManager;
  private playerSystem?: PlayerSystem; // Cached for auto-retaliate checks (hot path optimization)

  // OPTIMIZATION: Cache frequently used systems to avoid getSystem() lookups in hot paths
  private prayerSystem?: PrayerSystem | null;
  private zoneDetectionSystem?: ZoneDetectionSystem | null;
  private _systemsCached = false;

  // Public for GameTickProcessor access during tick processing
  public readonly stateService: CombatStateService;
  private animationManager: CombatAnimationManager;
  private rotationManager: CombatRotationManager;

  public readonly antiCheat: CombatAntiCheat;
  private entityIdValidator: EntityIdValidator;
  private rateLimiter: CombatRateLimiter;
  public readonly eventStore: EventStore;
  private entityResolver: CombatEntityResolver;
  private damageCalculator: DamageCalculator;
  private eventRecordingEnabled: boolean = true;

  // Equipment stats cache per player for damage calculations
  private playerEquipmentStats = new Map<
    string,
    {
      attack: number;
      strength: number;
      defense: number;
      ranged: number;
      // Ranged/Magic bonuses (F2P)
      rangedAttack: number;
      rangedStrength: number;
      magicAttack: number;
      magicDefense: number;
      // Per-style melee defence bonuses (classic MMORPG combat triangle)
      defenseStab: number;
      defenseSlash: number;
      defenseCrush: number;
      defenseRanged: number;
      // Per-style melee attack bonuses
      attackStab: number;
      attackSlash: number;
      attackCrush: number;
    }
  >();

  // Ranged/Magic combat services (F2P)
  private readonly projectileService: ProjectileService;
  private equipmentSystem?: EquipmentSystem;
  private inventorySystem?: InventorySystem;
  private groundItemSystem?: GroundItemSystem;

  // Pre-allocated pooled tiles for hot path calculations (zero GC)
  private readonly _attackerTile: PooledTile = tilePool.acquire();
  private readonly _targetTile: PooledTile = tilePool.acquire();

  // rules-accurate: Track last known target tile per attacker for persistent combat follow.
  // In classic MMORPG, the player continuously follows the target while in combat — not just when
  // out of range. This map lets us detect when the target has moved and re-path accordingly.
  private lastCombatTargetTile = new Map<string, { x: number; z: number }>();

  // Auto-retaliate disabled after 20 minutes of no input (classic MMORPG behavior)
  private lastInputTick = new Map<string, number>();

  private damageHandlers: Map<"player" | "mob", DamageHandler>;

  // Lower PID = higher priority when attacks occur on same tick
  public readonly pidManager: PidManager;

  // ============================================================================
  // PRE-ALLOCATED EVENT PAYLOADS (zero-allocation hot path)
  // ============================================================================
  // These objects are reused for every event emission to avoid GC pressure.
  // Safe because EventEmitter3 is synchronous - listeners process before emit returns.

  private readonly _damageDealtPayload = {
    projectileId: undefined as string | undefined,
    attackerId: "",
    targetId: "",
    damage: 0,
    attackType: "melee" as string | undefined,
    targetType: "mob" as "player" | "mob" | undefined,
    position: { x: 0, y: 0, z: 0 } as
      { x: number; y: number; z: number } | undefined,
    isCritical: false as boolean | undefined,
    publicActionObservation: undefined as
      StreamingDuelDamageObservationContext | undefined,
    competitiveTerminal: undefined as DuelDamageCompetitiveTerminal | undefined,
  };

  // Separate position object for when there's no position (to avoid repeated undefined assignment)
  private readonly _damageDealtPositionBuffer = { x: 0, y: 0, z: 0 };

  private readonly _projectileLaunchedPayload = {
    projectileId: undefined as string | undefined,
    attackerId: "",
    targetId: "",
    projectileType: "",
    sourcePosition: { x: 0, y: 0, z: 0 },
    targetPosition: { x: 0, y: 0, z: 0 },
    spellId: undefined as string | undefined,
    arrowId: undefined as string | undefined,
    delayMs: undefined as number | undefined,
    travelDurationMs: undefined as number | undefined,
  };

  private readonly _faceTargetPayload = {
    playerId: "",
    targetId: "",
  };

  private readonly _clearFaceTargetPayload = {
    playerId: "",
  };

  private readonly _attackFailedPayload = {
    attackerId: "",
    targetId: "",
    reason: "",
  };

  private readonly _followTargetPayload = {
    playerId: "",
    targetId: "",
    targetPosition: { x: 0, y: 0, z: 0 },
    attackRange: 1 as number | undefined,
    attackType: "melee" as string | undefined,
  };

  private readonly _combatStartedPayload = {
    attackerId: "",
    targetId: "",
  };

  private readonly _combatEndedPayload = {
    attackerId: "",
    targetId: "",
  };

  private readonly _projectileHitPayload = {
    projectileId: undefined as string | undefined,
    attackerId: "",
    targetId: "",
    damage: 0,
    projectileType: "",
  };

  private readonly _projectileCancelledPayload = {
    projectileId: "",
    attackerId: "",
    targetId: "",
    projectileType: "arrow" as "arrow" | "spell",
    reason: "combat_ended" as CombatProjectileCancelledPayload["reason"],
  };

  constructor(world: World) {
    super(world, {
      name: "combat",
      dependencies: {
        required: ["entity-manager"], // Combat needs entity manager
        optional: ["mob-npc"], // Combat can work without mob NPCs but better with them
      },
      autoCleanup: true,
    });

    this.stateService = new CombatStateService(world);
    this.animationManager = new CombatAnimationManager(world);
    this.rotationManager = new CombatRotationManager(world);
    this.antiCheat = new CombatAntiCheat();
    this.entityIdValidator = new EntityIdValidator();
    this.rateLimiter = new CombatRateLimiter();
    this.entityResolver = new CombatEntityResolver(world);
    this.damageCalculator = new DamageCalculator(this.playerEquipmentStats);

    this.eventStore = new EventStore({
      snapshotInterval: 100,
      maxEvents: 100000,
      maxSnapshots: 10,
    });

    this.damageHandlers = new Map();
    this.damageHandlers.set("player", new PlayerDamageHandler(world));
    this.damageHandlers.set("mob", new MobDamageHandler(world));

    this.pidManager = new PidManager(getGameRng());

    // Ranged/Magic projectile service (F2P)
    this.projectileService = new ProjectileService();
  }

  // ============================================================================
  // ZERO-ALLOCATION EVENT EMISSION HELPERS
  // ============================================================================
  // These methods populate pre-allocated payloads and emit events.
  // Eliminates object allocation on every combat event (saves GC pressure).

  private emitDamageDealt(
    attackerId: string,
    targetId: string,
    damage: number,
    attackType?: string,
    targetType?: "player" | "mob",
    position?: { x: number; y: number; z: number } | null,
    isCritical?: boolean,
    projectileId?: string,
    publicActionObservation?: StreamingDuelDamageObservationContext,
    competitiveTerminal?: DuelDamageCompetitiveTerminal,
  ): void {
    this._damageDealtPayload.projectileId = projectileId;
    this._damageDealtPayload.attackerId = attackerId;
    this._damageDealtPayload.targetId = targetId;
    this._damageDealtPayload.damage = damage;
    this._damageDealtPayload.attackType = attackType;
    this._damageDealtPayload.targetType = targetType;
    this._damageDealtPayload.isCritical = isCritical;
    this._damageDealtPayload.publicActionObservation = publicActionObservation;
    this._damageDealtPayload.competitiveTerminal = competitiveTerminal;
    // Copy position values into pre-allocated buffer to avoid object creation
    if (position) {
      this._damageDealtPositionBuffer.x = position.x;
      this._damageDealtPositionBuffer.y = position.y;
      this._damageDealtPositionBuffer.z = position.z;
      this._damageDealtPayload.position = this._damageDealtPositionBuffer;
    } else {
      this._damageDealtPayload.position = undefined;
    }
    this.emitTypedEvent(
      EventType.COMBAT_DAMAGE_DEALT,
      this._damageDealtPayload,
    );
  }

  private emitProjectileLaunched(
    attackerId: string,
    targetId: string,
    projectileType: string,
    sourcePosition: { x: number; y: number; z: number },
    targetPosition: { x: number; y: number; z: number },
    spellId?: string,
    arrowId?: string,
    delayMs?: number,
    flightTimeMs?: number,
    projectileId?: string,
  ): void {
    this._projectileLaunchedPayload.projectileId = projectileId;
    this._projectileLaunchedPayload.attackerId = attackerId;
    this._projectileLaunchedPayload.targetId = targetId;
    this._projectileLaunchedPayload.projectileType = projectileType;
    this._projectileLaunchedPayload.sourcePosition.x = sourcePosition.x;
    this._projectileLaunchedPayload.sourcePosition.y = sourcePosition.y;
    this._projectileLaunchedPayload.sourcePosition.z = sourcePosition.z;
    this._projectileLaunchedPayload.targetPosition.x = targetPosition.x;
    this._projectileLaunchedPayload.targetPosition.y = targetPosition.y;
    this._projectileLaunchedPayload.targetPosition.z = targetPosition.z;
    this._projectileLaunchedPayload.spellId = spellId;
    this._projectileLaunchedPayload.arrowId = arrowId;
    this._projectileLaunchedPayload.delayMs = delayMs;
    this._projectileLaunchedPayload.travelDurationMs = flightTimeMs;
    this.emitTypedEvent(
      EventType.COMBAT_PROJECTILE_LAUNCHED,
      this._projectileLaunchedPayload,
    );
  }

  private emitFaceTarget(playerId: string, targetId: string): void {
    this._faceTargetPayload.playerId = playerId;
    this._faceTargetPayload.targetId = targetId;
    this.emitTypedEvent(EventType.COMBAT_FACE_TARGET, this._faceTargetPayload);
  }

  private emitClearFaceTarget(playerId: string): void {
    this._clearFaceTargetPayload.playerId = playerId;
    this.emitTypedEvent(
      EventType.COMBAT_CLEAR_FACE_TARGET,
      this._clearFaceTargetPayload,
    );
  }

  private emitAttackFailed(
    attackerId: string,
    targetId: string,
    reason: string,
  ): void {
    this._attackFailedPayload.attackerId = attackerId;
    this._attackFailedPayload.targetId = targetId;
    this._attackFailedPayload.reason = reason;
    this.emitTypedEvent(
      EventType.COMBAT_ATTACK_FAILED,
      this._attackFailedPayload,
    );
  }

  private emitFollowTarget(
    playerId: string,
    targetId: string,
    targetPosition: { x: number; y: number; z: number },
    attackRange?: number,
    attackType?: string,
  ): void {
    this._followTargetPayload.playerId = playerId;
    this._followTargetPayload.targetId = targetId;
    this._followTargetPayload.targetPosition.x = targetPosition.x;
    this._followTargetPayload.targetPosition.y = targetPosition.y;
    this._followTargetPayload.targetPosition.z = targetPosition.z;
    this._followTargetPayload.attackRange = attackRange;
    this._followTargetPayload.attackType = attackType;
    this.emitTypedEvent(
      EventType.COMBAT_FOLLOW_TARGET,
      this._followTargetPayload,
    );
  }

  private emitCombatStarted(attackerId: string, targetId: string): void {
    this._combatStartedPayload.attackerId = attackerId;
    this._combatStartedPayload.targetId = targetId;
    this.emitTypedEvent(EventType.COMBAT_STARTED, this._combatStartedPayload);
  }

  private emitCombatEnded(attackerId: string, targetId: string): void {
    this._combatEndedPayload.attackerId = attackerId;
    this._combatEndedPayload.targetId = targetId;
    this.emitTypedEvent(EventType.COMBAT_ENDED, this._combatEndedPayload);
  }

  private emitProjectileHit(
    attackerId: string,
    targetId: string,
    damage: number,
    projectileType: string,
    projectileId?: string,
  ): void {
    this._projectileHitPayload.projectileId = projectileId;
    this._projectileHitPayload.attackerId = attackerId;
    this._projectileHitPayload.targetId = targetId;
    this._projectileHitPayload.damage = damage;
    this._projectileHitPayload.projectileType = projectileType;
    this.emitTypedEvent(
      EventType.COMBAT_PROJECTILE_HIT,
      this._projectileHitPayload,
    );
  }

  private emitProjectileCancelled(
    projectile: Readonly<CombatProjectile>,
    reason: CombatProjectileCancelledPayload["reason"],
  ): void {
    this._projectileCancelledPayload.projectileId = projectile.id;
    this._projectileCancelledPayload.attackerId = projectile.attackerId;
    this._projectileCancelledPayload.targetId = projectile.targetId;
    this._projectileCancelledPayload.projectileType = projectile.spellId
      ? "spell"
      : "arrow";
    this._projectileCancelledPayload.reason = reason;
    this.emitTypedEvent(
      EventType.COMBAT_PROJECTILE_CANCELLED,
      this._projectileCancelledPayload,
    );
  }

  async init(): Promise<void> {
    // Get entity manager - required dependency
    this.entityManager = this.world.getSystem<EntityManager>("entity-manager");
    if (!this.entityManager) {
      throw new Error(
        "[CombatSystem] EntityManager not found - required dependency",
      );
    }

    // Get mob NPC system - optional but recommended
    this.mobSystem = this.world.getSystem<MobNPCSystem>("mob-npc");

    // Configure entity resolver with entity manager and logger
    this.entityResolver.setEntityManager(this.entityManager);
    this.entityResolver.setLogger(this.logger);

    // Cache PlayerSystem for auto-retaliate checks (hot path optimization)
    // Optional dependency - combat still works without it (defaults to retaliate)
    this.playerSystem = this.world.getSystem<PlayerSystem>("player");

    // OPTIMIZATION: Cache other systems used in hot paths (damage calc, PvP zone checks)
    this.prayerSystem = this.world.getSystem<PrayerSystem>("prayer") ?? null;
    this.zoneDetectionSystem =
      this.world.getSystem<ZoneDetectionSystem>("zone-detection") ?? null;
    this._systemsCached = true;

    // Cache PlayerSystem into PlayerDamageHandler for damage application
    const playerHandler = this.damageHandlers.get("player");
    if (isPlayerDamageHandler(playerHandler)) {
      playerHandler.cachePlayerSystem(this.playerSystem ?? null);
    }

    // Cache EquipmentSystem and InventorySystem for ranged/magic combat (F2P)
    this.equipmentSystem = this.world.getSystem<EquipmentSystem>("equipment");
    this.inventorySystem = this.world.getSystem<InventorySystem>("inventory");
    this.groundItemSystem =
      this.world.getSystem<GroundItemSystem>("ground-items");

    // Listen for auto-retaliate toggle to start combat if toggled ON while being attacked
    // SERVER-ONLY: Combat state changes must happen on server, client receives via network sync
    this.subscribe(
      EventType.UI_AUTO_RETALIATE_CHANGED,
      (data: { playerId: string; enabled: boolean }) => {
        if (!this.world.isServer) return; // Combat is server-authoritative
        if (data.enabled) {
          this.handleAutoRetaliateEnabled(data.playerId);
        }
      },
    );

    // rules-accurate: Player clicked to move = cancel their attacking combat
    // In classic MMORPG, clicking anywhere else cancels your current action including combat
    // SERVER-ONLY: Combat state changes must happen on server
    this.subscribe(
      EventType.COMBAT_PLAYER_DISENGAGE,
      (data: { playerId: string }) => {
        if (!this.world.isServer) return; // Combat is server-authoritative
        this.handlePlayerDisengage(data.playerId);
      },
    );

    // Set up event listeners - required for combat to function
    // SERVER-ONLY: Combat processing should only happen on server to avoid duplicate damage events
    this.subscribe(
      EventType.COMBAT_ATTACK_REQUEST,
      async (data: {
        attackerId: string;
        targetId: string;
        attackerType?: "player" | "mob";
        targetType?: "player" | "mob";
        attackType?: AttackType;
      }) => {
        if (!this.world.isServer) return; // Combat is server-authoritative
        await this.handleAttack({
          attackerId: data.attackerId,
          targetId: data.targetId,
          attackerType: data.attackerType || "player",
          targetType: data.targetType || "mob",
          attackType: data.attackType || AttackType.MELEE,
        });
      },
    );
    this.subscribe<{
      attackerId: string;
      targetId: string;
      attackerType: "player" | "mob";
      targetType: "player" | "mob";
    }>(EventType.COMBAT_MELEE_ATTACK, (data) => {
      if (!this.world.isServer) return; // Combat is server-authoritative
      void this.handleMeleeAttack(data).catch((error) => {
        this.logger.error(
          "Melee damage authority failed",
          error instanceof Error ? error : undefined,
          { attackerId: data.attackerId, targetId: data.targetId },
        );
      });
    });
    // MVP: Ranged combat subscription removed - melee only
    this.subscribe(
      EventType.COMBAT_MOB_NPC_ATTACK,
      (data: {
        mobId: string;
        targetId: string;
        attackType?: AttackType;
        spellId?: string;
        arrowId?: string;
      }) => {
        if (!this.world.isServer) return; // Combat is server-authoritative
        this.handleMobAttack(data);
      },
    );

    // Listen for death events to end combat
    this.subscribe(EventType.NPC_DIED, (data: { mobId: string }) => {
      this.handleEntityDied(data.mobId, "mob");
    });
    this.subscribe(
      EventType.ENTITY_DEATH,
      (data: { entityId: string; entityType: string }) => {
        this.handleEntityDied(data.entityId, data.entityType);
      },
    );

    // CRITICAL: Listen for player respawn to clear any lingering combat states
    // This catches edge cases where combat states survive the death cleanup
    this.subscribe(
      EventType.PLAYER_RESPAWNED,
      (data: {
        playerId: string;
        spawnPosition: { x: number; y: number; z: number };
      }) => {
        this.handlePlayerRespawned(data.playerId);
      },
    );

    this.subscribe(EventType.PLAYER_JOINED, (data: { playerId: string }) => {
      const tickNumber = this.world.currentTick ?? 0;
      this.pidManager.assignPid(data.playerId as EntityID, tickNumber);
    });

    this.subscribe(EventType.PLAYER_LEFT, (data: { playerId: string }) => {
      this.cleanupPlayerDisconnect(data.playerId);
      this.pidManager.removePid(data.playerId as EntityID);
    });

    // Listen for explicit combat stop requests (e.g., player clicking new target)
    this.subscribe(
      EventType.COMBAT_STOP_ATTACK,
      (data: { attackerId: string }) => {
        if (this.stateService.isInCombat(data.attackerId)) {
          this.logger.info("Stopping combat for target switch", {
            attackerId: data.attackerId,
          });
          this.forceEndCombat(data.attackerId);
        }
      },
    );

    // Listen for combat follow events to initiate player movement toward target
    this.subscribe(
      EventType.COMBAT_FOLLOW_TARGET,
      (data: {
        playerId: string;
        targetId: string;
        targetPosition: { x: number; y: number; z: number };
      }) => {
        this.handleCombatFollow(data);
      },
    );

    // Listen for equipment stats updates to use bonuses in damage calculation
    this.subscribe(
      EventType.PLAYER_STATS_EQUIPMENT_UPDATED,
      (data: {
        playerId: string;
        equipmentStats: {
          attack: number;
          strength: number;
          defense: number;
          ranged: number;
          // Optional ranged/magic bonuses (F2P)
          rangedAttack?: number;
          rangedStrength?: number;
          magicAttack?: number;
          magicDefense?: number;
          // Optional per-style bonuses (classic MMORPG combat triangle)
          defenseStab?: number;
          defenseSlash?: number;
          defenseCrush?: number;
          defenseRanged?: number;
          attackStab?: number;
          attackSlash?: number;
          attackCrush?: number;
        };
      }) => {
        this.playerEquipmentStats.set(data.playerId, {
          attack: data.equipmentStats.attack,
          strength: data.equipmentStats.strength,
          defense: data.equipmentStats.defense,
          ranged: data.equipmentStats.ranged,
          rangedAttack: data.equipmentStats.rangedAttack ?? 0,
          rangedStrength: data.equipmentStats.rangedStrength ?? 0,
          magicAttack: data.equipmentStats.magicAttack ?? 0,
          magicDefense: data.equipmentStats.magicDefense ?? 0,
          defenseStab: data.equipmentStats.defenseStab ?? 0,
          defenseSlash: data.equipmentStats.defenseSlash ?? 0,
          defenseCrush: data.equipmentStats.defenseCrush ?? 0,
          defenseRanged: data.equipmentStats.defenseRanged ?? 0,
          attackStab: data.equipmentStats.attackStab ?? 0,
          attackSlash: data.equipmentStats.attackSlash ?? 0,
          attackCrush: data.equipmentStats.attackCrush ?? 0,
        });
      },
    );
  }

  /**
   * Get attack type from equipped weapon or selected spell
   * Returns AttackType based on weapon's attackType property, or MAGIC if spell selected
   *
   * rules-accurate: You can cast spells without a staff - the staff just provides
   * magic attack bonus and elemental staves give infinite runes
   */
  private getAttackTypeFromWeapon(attackerId: string): AttackType {
    // Check if player has a spell selected - if so, use magic regardless of weapon
    const selectedSpell = this.getPlayerSelectedSpell(attackerId);
    if (selectedSpell) {
      return AttackType.MAGIC;
    }

    if (!this.equipmentSystem) return AttackType.MELEE;

    const equipment = this.equipmentSystem.getPlayerEquipment(attackerId);
    const weapon = equipment?.weapon?.item;

    if (!weapon) return AttackType.MELEE;

    // Normalize to lowercase for comparison (JSON may have uppercase values)
    const attackType = weapon.attackType?.toLowerCase();
    const weaponType = weapon.weaponType?.toLowerCase();

    // Check weapon's attackType property for ranged
    // Note: Magic only activates via autocast (checked above) - staffs melee by default
    if (attackType === "ranged") {
      return AttackType.RANGED;
    }

    // Fall back to weaponType for legacy compatibility (ranged only)
    if (weaponType === "bow" || weaponType === "crossbow") {
      return AttackType.RANGED;
    }

    // Default to melee (includes staffs/wands without autocast - rules-accurate)
    return AttackType.MELEE;
  }

  /**
   * Get equipped arrows slot for ranged combat
   */
  private getEquippedArrows(playerId: string): EquipmentSlot | null {
    if (!this.equipmentSystem) return null;
    const equipment = this.equipmentSystem.getPlayerEquipment(playerId);
    return equipment?.arrows ?? null;
  }

  /**
   * Get equipped weapon for combat
   */
  private getEquippedWeapon(playerId: string): Item | null {
    if (!this.equipmentSystem) return null;
    const equipment = this.equipmentSystem.getPlayerEquipment(playerId);
    return equipment?.weapon?.item ?? null;
  }

  private async handleAttack(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    attackType?: AttackType;
  }): Promise<void> {
    if (
      this.isDuelPreparationCombatFenced(data.attackerId) ||
      this.isDuelPreparationCombatFenced(data.targetId)
    ) {
      return;
    }
    const attacker = this.world.entities.get(data.attackerId);
    const target = this.world.entities.get(data.targetId);
    if (
      this.hasUnknownDuelDamageCommit() &&
      data.attackerType === "player" &&
      data.targetType === "player" &&
      attacker?.data.inStreamingDuel === true &&
      target?.data.inStreamingDuel === true
    ) {
      // Once persistence truth is ambiguous, stop authoring new attacks and
      // costs. Already-fired projectiles still enter the exact ordered queue.
      this.emitAttackFailed(
        data.attackerId,
        data.targetId,
        "damage_persistence_reconciling",
      );
      return;
    }

    // Route by attack type from equipped weapon (F2P ranged/magic support)
    const attackType =
      data.attackerType === "player"
        ? this.getAttackTypeFromWeapon(data.attackerId)
        : (data.attackType ?? AttackType.MELEE);

    switch (attackType) {
      case AttackType.RANGED:
        await this.handleRangedAttack(data);
        break;
      case AttackType.MAGIC:
        await this.handleMagicAttack(data);
        break;
      case AttackType.MELEE:
      default:
        await this.handleMeleeAttack(data);
        break;
    }
  }

  /**
   * Main melee attack handler - orchestrates validation and execution
   * Refactored for clarity: validation logic extracted to validateMeleeAttack(),
   * execution logic extracted to executeMeleeAttack()
   */
  private async handleMeleeAttack(data: MeleeAttackData): Promise<void> {
    const { attackerId, targetId, attackerType } = data;
    if (
      this.isDuelPreparationCombatFenced(attackerId) ||
      this.isDuelPreparationCombatFenced(targetId)
    ) {
      return;
    }
    const currentTick = this.world.currentTick ?? 0;

    if (!this.entityIdValidator.isValid(attackerId)) {
      const sanitized = this.entityIdValidator.sanitizeForLogging(attackerId);
      this.logger.warn("Invalid attacker ID rejected", {
        attackerId: sanitized,
        reason: "invalid_format",
      });
      this.antiCheat.recordInvalidEntityId(
        String(attackerId).slice(0, 64),
        String(attackerId),
      );
      return;
    }

    if (!this.entityIdValidator.isValid(targetId)) {
      const sanitized = this.entityIdValidator.sanitizeForLogging(targetId);
      this.logger.warn("Invalid target ID rejected", {
        attackerId,
        targetId: sanitized,
        reason: "invalid_format",
      });
      this.antiCheat.recordInvalidEntityId(attackerId, String(targetId));
      return;
    }

    if (attackerType === "player") {
      const rateResult = this.rateLimiter.checkLimit(attackerId, currentTick);
      if (!rateResult.allowed) {
        this.logger.warn("Attack rate limited", {
          attackerId,
          reason: rateResult.reason,
          cooldownUntil: rateResult.cooldownUntil,
        });
        return;
      }
      this.antiCheat.trackAttack(attackerId, currentTick);
    }

    // Validate the attack (entities exist, alive, in range, etc.)
    const validation = this.validateMeleeAttack(data, currentTick);
    if (!validation.valid) {
      return;
    }

    // Check cooldown before executing
    if (!this.checkAttackCooldown(validation.typedAttackerId!, currentTick)) {
      return;
    }

    // Execute the attack
    await this.executeMeleeAttack(data, validation, currentTick);
  }

  /**
   * Validate all preconditions for a melee attack
   * Returns validation result with entities if valid
   */
  private validateMeleeAttack(
    data: MeleeAttackData,
    currentTick: number,
  ): AttackValidationResult {
    const { attackerId, targetId, attackerType, targetType } = data;
    const invalidResult: AttackValidationResult = {
      valid: false,
      attacker: null,
      target: null,
      typedAttackerId: null,
      typedTargetId: null,
    };

    // Convert IDs to typed IDs
    const typedAttackerId = createEntityID(attackerId);
    const typedTargetId = createEntityID(targetId);

    // Get attacker and target entities
    const attacker = this.entityResolver.resolve(attackerId, attackerType);
    const target = this.entityResolver.resolve(targetId, targetType);

    // Check entities exist
    if (!attacker || !target) {
      if (attackerType === "player" && !target) {
        this.antiCheat.recordNonexistentTargetAttack(
          attackerId,
          targetId,
          currentTick,
        );
      }
      return invalidResult;
    }

    // Check attacker is alive
    if (!this.entityResolver.isAlive(attacker, attackerType)) {
      return invalidResult;
    }

    // Check target is alive
    if (!this.entityResolver.isAlive(target, targetType)) {
      if (attackerType === "player") {
        this.antiCheat.recordDeadTargetAttack(
          attackerId,
          targetId,
          currentTick,
        );
      }
      return invalidResult;
    }

    // Check target not in loading protection
    if (targetType === "player" && target.data?.isLoading) {
      if (attackerType === "player") {
        this.antiCheat.recordViolation(
          attackerId,
          CombatViolationType.ATTACK_DURING_PROTECTION,
          CombatViolationSeverity.MODERATE,
          `Attacked player ${targetId} during loading protection`,
          targetId,
          currentTick,
        );
      }
      return invalidResult;
    }

    // Check target is attackable (for mobs)
    if (targetType === "mob" && isMobEntity(target)) {
      if (typeof target.isAttackable === "function" && !target.isAttackable()) {
        this.emitAttackFailed(attackerId, targetId, "target_not_attackable");
        return invalidResult;
      }
    }

    // Check not self-attack
    if (attackerId === targetId) {
      if (attackerType === "player") {
        this.antiCheat.recordSelfAttack(attackerId, currentTick);
      }
      return invalidResult;
    }

    // Check range
    if (
      !this.isWithinCombatRange(
        attacker,
        target,
        attackerType,
        data,
        currentTick,
      )
    ) {
      return invalidResult;
    }

    return {
      valid: true,
      attacker,
      target,
      typedAttackerId,
      typedTargetId,
    };
  }

  /**
   * Check if attacker is within combat range of target
   *
   * classic MMORPG melee rules (from wiki):
   * - Range 1 (standard melee): Cardinal only (N/S/E/W) - NO diagonal attacks
   * - Range 2+ (halberd): Allows diagonal attacks
   *
   */
  private isWithinCombatRange(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    attackerType: "player" | "mob",
    data: MeleeAttackData,
    currentTick: number,
  ): boolean {
    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return false;

    // Use pre-allocated pooled tiles (zero GC)
    tilePool.setFromPosition(this._attackerTile, attackerPos);
    tilePool.setFromPosition(this._targetTile, targetPos);
    const combatRangeTiles = this.entityResolver.getCombatRange(
      attacker,
      attackerType,
    );

    // rules-accurate melee range check:
    // - Range 1: Cardinal only (N/S/E/W)
    // - Range 2+: Allows diagonal (Chebyshev distance)
    if (
      !tilesWithinMeleeRange(
        this._attackerTile,
        this._targetTile,
        combatRangeTiles,
      )
    ) {
      if (attackerType === "player") {
        const dx = Math.abs(this._attackerTile.x - this._targetTile.x);
        const dz = Math.abs(this._attackerTile.z - this._targetTile.z);
        const actualDistance = Math.max(dx, dz);
        this.antiCheat.recordOutOfRangeAttack(
          data.attackerId,
          data.targetId,
          actualDistance,
          combatRangeTiles,
          currentTick,
        );
      }

      this.emitAttackFailed(data.attackerId, data.targetId, "out_of_range");
      return false;
    }
    return true;
  }

  /**
   * Check if attack is on cooldown
   */
  private checkAttackCooldown(
    typedAttackerId: EntityID,
    currentTick: number,
  ): boolean {
    const nextAllowedTick = this.nextAttackTicks.get(typedAttackerId) ?? 0;
    return !isAttackOnCooldownTicks(currentTick, nextAllowedTick);
  }

  /**
   * Execute a validated melee attack
   * Handles rotation, animation, damage, and combat state
   */
  private executeMeleeAttack(
    data: MeleeAttackData,
    validation: AttackValidationResult,
    currentTick: number,
  ): Promise<void> | void {
    const { attackerId, targetId, attackerType, targetType } = data;
    const { attacker, target, typedAttackerId, typedTargetId } = validation;

    if (!attacker || !target || !typedAttackerId || !typedTargetId) return;

    // Get attack speed
    const entityType = attacker.type === "mob" ? "mob" : "player";
    const attackSpeedTicks = this.entityResolver.getAttackSpeed(
      typedAttackerId,
      entityType,
    );

    // Face target
    this.rotationManager.rotateTowardsTarget(
      attackerId,
      targetId,
      attackerType,
      targetType,
    );

    // Play attack animation with attack speed for proper animation duration
    this.animationManager.setCombatEmote(
      attackerId,
      attackerType,
      currentTick,
      attackSpeedTicks,
    );

    // Get player's combat style for rules-accurate damage bonuses
    let combatStyle: CombatStyle = "accurate";
    if (attackerType === "player") {
      const playerSystem = this.world.getSystem(
        "player",
      ) as PlayerSystem | null;
      const styleData = playerSystem?.getPlayerAttackStyle?.(attackerId);
      if (styleData?.id) {
        combatStyle = styleData.id as CombatStyle;
      }
    }

    // Calculate and apply damage
    const rawDamage = this.calculateMeleeDamage(attacker, target, combatStyle);
    const currentHealth = this.entityResolver.getHealth(target);
    const damage = Math.min(rawDamage, currentHealth);

    const damageResolution = this.applyDamage(
      targetId,
      targetType,
      damage,
      attackerId,
    );
    const finish = (damageResult: DamageResolution): void => {
      if (!damageResult.success) return;

      // Emit damage event using pre-allocated payload (zero allocation)
      const targetPosition = getEntityPosition(target);
      this.emitDamageDealt(
        attackerId,
        targetId,
        damageResult.actualDamage,
        undefined,
        targetType,
        targetPosition,
        undefined,
        undefined,
        damageResult.publicActionObservation,
        damageResult.competitiveTerminal,
      );

      if (!this.entityResolver.isAlive(target, targetType)) return;

      // Set cooldown and enter combat state
      this.nextAttackTicks.set(typedAttackerId, currentTick + attackSpeedTicks);
      this.enterCombat(typedAttackerId, typedTargetId, attackSpeedTicks);
    };
    if (damageResolution instanceof Promise) {
      return damageResolution.then(finish);
    }
    finish(damageResolution);
  }

  /**
   * Handle ranged attack - validate arrows, create projectile, queue damage
   */
  private handleRangedAttack(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    arrowId?: string;
  }): Promise<void> {
    return this.trackProjectileCustodyOperation(
      this.handleRangedAttackImpl(data),
    );
  }

  private async handleRangedAttackImpl(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    arrowId?: string;
  }): Promise<void> {
    const { attackerId, targetId, attackerType, targetType } = data;
    if (
      this.isDuelPreparationCombatFenced(attackerId) ||
      this.isDuelPreparationCombatFenced(targetId)
    ) {
      return;
    }
    const currentTick = this.world.currentTick ?? 0;

    // Mobs can launch ranged projectiles when configured with arrowId.
    if (attackerType === "mob") {
      const attacker = this.entityResolver.resolve(attackerId, attackerType);
      const target = this.entityResolver.resolve(targetId, targetType);
      if (!attacker || !target || !isMobEntity(attacker)) return;

      if (
        !this.entityResolver.isAlive(attacker, attackerType) ||
        !this.entityResolver.isAlive(target, targetType)
      ) {
        return;
      }

      const mobData = attacker.getMobData();
      const npcData = getNPCById(mobData.type);
      if (!npcData) return;

      const arrowId = data.arrowId ?? npcData.combat.arrowId;
      if (!arrowId) {
        console.warn(
          `[RangedAttackHandler] Mob ${attackerId} (${mobData.type}) has no arrowId configured, skipping attack`,
        );
        return;
      }

      const attackRange = Math.max(
        1,
        Math.floor(npcData.combat.combatRange ?? COMBAT_CONSTANTS.RANGED_RANGE),
      );
      const attackerPos = getEntityPosition(attacker);
      const targetPos = getEntityPosition(target);
      if (!attackerPos || !targetPos) return;

      tilePool.setFromPosition(this._attackerTile, attackerPos);
      tilePool.setFromPosition(this._targetTile, targetPos);
      const distance = tileChebyshevDistance(
        this._attackerTile,
        this._targetTile,
      );
      if (distance > attackRange || distance === 0) {
        this.emitAttackFailed(attackerId, targetId, "out_of_range");
        return;
      }

      const typedAttackerId = createEntityID(attackerId);
      if (!this.checkAttackCooldown(typedAttackerId, currentTick)) {
        return;
      }

      const attackSpeedTicks = Math.max(
        1,
        npcData.combat.attackSpeedTicks ??
          COMBAT_CONSTANTS.DEFAULTS.NPC.ATTACK_SPEED_TICKS,
      );

      this.rotationManager.rotateTowardsTarget(
        attackerId,
        targetId,
        attackerType,
        targetType,
      );
      this.animationManager.setCombatEmote(
        attackerId,
        attackerType,
        currentTick,
        attackSpeedTicks,
        "ranged",
      );

      const damage = this.calculateMobRangedDamageForAttack(
        target,
        targetType,
        npcData.stats.ranged ?? 1,
        arrowId,
      );

      const projectileParams: CreateProjectileParams = {
        sourceId: attackerId,
        targetId,
        attackType: AttackType.RANGED,
        damage,
        currentTick,
        sourcePosition: { x: attackerPos.x, z: attackerPos.z },
        targetPosition: { x: targetPos.x, z: targetPos.z },
        arrowId,
        xpReward: 0,
      };

      const projectile =
        this.projectileService.createProjectile(projectileParams);
      if (!projectile) return;

      const { HIT_DELAY, TICK_DURATION_MS } = COMBAT_CONSTANTS;
      const rangedHitDelayTicks = Math.min(
        HIT_DELAY.MAX_HIT_DELAY,
        HIT_DELAY.RANGED_BASE +
          Math.floor(
            (HIT_DELAY.RANGED_DISTANCE_OFFSET + distance) /
              HIT_DELAY.RANGED_DISTANCE_DIVISOR,
          ),
      );
      const arrowLaunchDelayMs = COMBAT_CONSTANTS.ARROW_LAUNCH_DELAY_MS;
      const travelDurationMs = Math.max(
        200,
        rangedHitDelayTicks * TICK_DURATION_MS - arrowLaunchDelayMs,
      );

      this.emitProjectileLaunched(
        attackerId,
        targetId,
        "arrow",
        attackerPos,
        targetPos,
        undefined,
        arrowId,
        arrowLaunchDelayMs,
        travelDurationMs,
        projectile.id,
      );

      const typedTargetId = createEntityID(targetId);
      this.nextAttackTicks.set(typedAttackerId, currentTick + attackSpeedTicks);
      this.enterCombat(
        typedAttackerId,
        typedTargetId,
        attackSpeedTicks,
        AttackType.RANGED,
      );
      return;
    }

    // Validate entity IDs
    if (
      !this.entityIdValidator.isValid(attackerId) ||
      !this.entityIdValidator.isValid(targetId)
    ) {
      return;
    }

    // Rate limiting
    const rateResult = this.rateLimiter.checkLimit(attackerId, currentTick);
    if (!rateResult.allowed) {
      return;
    }
    this.antiCheat.trackAttack(attackerId, currentTick);

    // Get entities
    const attacker = this.entityResolver.resolve(attackerId, attackerType);
    const target = this.entityResolver.resolve(targetId, targetType);
    if (!attacker || !target) return;

    // Check both are alive
    if (
      !this.entityResolver.isAlive(attacker, attackerType) ||
      !this.entityResolver.isAlive(target, targetType)
    ) {
      return;
    }

    // Validate arrows equipped
    const weapon = this.getEquippedWeapon(attackerId);
    const arrowSlot = this.getEquippedArrows(attackerId);
    const rangedLevel = this.getPlayerSkillLevel(attackerId, "ranged");

    const arrowValidation = ammunitionService.validateArrows(
      weapon,
      arrowSlot,
      rangedLevel,
    );
    if (!arrowValidation.valid) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: arrowValidation.error ?? "You need arrows to attack.",
        type: "error",
      });
      return;
    }

    // Check ranged attack range (bows have attackRange property)
    const attackRange = weapon?.attackRange ?? 7;
    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return;

    tilePool.setFromPosition(this._attackerTile, attackerPos);
    tilePool.setFromPosition(this._targetTile, targetPos);
    const distance = tileChebyshevDistance(
      this._attackerTile,
      this._targetTile,
    );

    if (distance > attackRange || distance === 0) {
      this.emitAttackFailed(attackerId, targetId, "out_of_range");
      return;
    }

    // Check cooldown
    const typedAttackerId = createEntityID(attackerId);
    if (!this.checkAttackCooldown(typedAttackerId, currentTick)) {
      return;
    }
    if (this.pendingProjectileAttacks.has(typedAttackerId)) {
      return;
    }
    // Entity positions are mutable live objects. Bind the capacity lease and
    // eventual projectile to one immutable attack-decision snapshot so normal
    // kiting during the database await cannot invalidate a paid launch.
    const projectileSourcePosition = {
      x: attackerPos.x,
      z: attackerPos.z,
    };
    const projectileTargetPosition = {
      x: targetPos.x,
      z: targetPos.z,
    };
    const projectileRecoveryPosition = {
      x: targetPos.x,
      y: targetPos.y,
      z: targetPos.z,
    };
    const projectileReservation = this.projectileService.reserveProjectile(
      attackerId,
      projectileSourcePosition,
      projectileTargetPosition,
    );
    if (!projectileReservation) {
      this.emitAttackFailed(attackerId, targetId, "projectile_capacity");
      return;
    }

    // Get player's ranged style for speed modifier
    let rangedStyle: RangedCombatStyle = "accurate";
    const playerSystem = this.world.getSystem("player") as PlayerSystem | null;
    const styleData = playerSystem?.getPlayerAttackStyle?.(attackerId);
    if (styleData?.id) {
      const id = styleData.id;
      if (id === "accurate" || id === "rapid" || id === "longrange") {
        rangedStyle = id;
      }
    }

    // Get attack speed from weapon with style modifier (rapid = -1 tick)
    const baseAttackSpeed = weapon?.attackSpeed ?? 4;
    const styleBonus = RANGED_STYLE_BONUSES[rangedStyle];
    const attackSpeedTicks = Math.max(
      1,
      baseAttackSpeed + styleBonus.speedModifier,
    );

    // Claim the cooldown before awaiting durable custody. The event handler and
    // tick auto-attack path can otherwise both debit and launch on one tick.
    const previousNextAttackTick = this.nextAttackTicks.get(typedAttackerId);
    const claimedNextAttackTick = currentTick + attackSpeedTicks;
    this.nextAttackTicks.set(typedAttackerId, claimedNextAttackTick);
    this.pendingProjectileAttacks.add(typedAttackerId);

    // Calculate damage
    const damage = this.calculateRangedDamageForAttack(
      attacker,
      target,
      attackerId,
      targetType,
    );
    const attackCommitEpoch = this.captureAttackCommitEpoch(
      attackerId,
      targetId,
    );

    const arrowId = arrowSlot?.itemId?.toString();
    const recoverySelected =
      !isPositionInsideDuelArenaZone(
        projectileTargetPosition.x,
        projectileTargetPosition.z,
      ) && getGameRng().random() >= 0.2;
    let arrowDebit: AtomicAmmunitionShotReceipt | null = null;
    try {
      arrowDebit =
        arrowId && this.equipmentSystem
          ? await this.equipmentSystem.consumeArrowForProjectileAtomic(
              attackerId,
              `ammunition-shot:${uuid()}${uuid()}`,
              arrowId,
              recoverySelected ? "recovered" : "destroyed",
              recoverySelected ? projectileRecoveryPosition : null,
            )
          : null;
    } catch (error) {
      this.logger.error(
        "Ranged projectile custody failed before launch",
        error instanceof Error ? error : undefined,
        { attackerId, targetId, arrowId },
      );
    } finally {
      this.pendingProjectileAttacks.delete(typedAttackerId);
    }
    const attackCommitCurrent = this.isAttackCommitEpochCurrent(
      attackerId,
      targetId,
      attackCommitEpoch,
    );
    this.releaseAttackCommitEpoch(attackerId, targetId);
    if (!attackCommitCurrent) {
      this.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      if (arrowDebit?.ok && this.equipmentSystem) {
        const cancelled =
          await this.equipmentSystem.cancelArrowProjectileAtomic({
            operationId: arrowDebit.operationId,
            playerId: arrowDebit.playerId,
            requestFingerprint: arrowDebit.requestFingerprint,
            itemId: arrowDebit.arrowId,
            recoveryDisposition: arrowDebit.recoveryDisposition,
          });
        if (!cancelled.ok || cancelled.status !== "cancelled") {
          this.logger.error(
            "Stale ranged admission refund deferred to recovery",
            undefined,
            { attackerId, targetId, operationId: arrowDebit.operationId },
          );
        }
      }
      this.restoreClaimedProjectileCooldown(
        typedAttackerId,
        claimedNextAttackTick,
        previousNextAttackTick,
      );
      return;
    }
    if (!arrowDebit?.ok) {
      this.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      this.restoreClaimedProjectileCooldown(
        typedAttackerId,
        claimedNextAttackTick,
        previousNextAttackTick,
      );
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message:
          arrowDebit?.reason === "insufficient_items"
            ? "You don't have enough ammunition."
            : "The ranged attack was cancelled before launch. Your equipment is being synchronized.",
        type: "error",
      });
      return;
    }

    const projectileCommitTick = this.world.currentTick ?? currentTick;
    if (this.nextAttackTicks.get(typedAttackerId) === claimedNextAttackTick) {
      this.nextAttackTicks.set(
        typedAttackerId,
        projectileCommitTick + attackSpeedTicks,
      );
    }

    // Create projectile with delayed hit
    const projectileParams: CreateProjectileParams = {
      sourceId: attackerId,
      targetId,
      attackType: AttackType.RANGED,
      damage,
      currentTick: projectileCommitTick,
      sourcePosition: projectileSourcePosition,
      targetPosition: projectileTargetPosition,
      arrowId,
      ammunitionCustody: {
        operationId: arrowDebit.operationId,
        playerId: arrowDebit.playerId,
        requestFingerprint: arrowDebit.requestFingerprint,
        itemId: arrowDebit.arrowId,
        recoveryDisposition: arrowDebit.recoveryDisposition,
      },
    };

    const projectile = this.projectileService.createReservedProjectile(
      projectileReservation,
      projectileParams,
    );
    if (!projectile) {
      this.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      this.logger.error(
        `Reserved projectile admission failed after committed arrow debit for ${attackerId}`,
        new Error("ranged_projectile_commit_invariant_failed"),
      );
      const cancelled = await this.equipmentSystem?.cancelArrowProjectileAtomic(
        projectileParams.ammunitionCustody!,
      );
      if (!cancelled?.ok || cancelled.status !== "cancelled") {
        this.logger.error(
          "Failed reserved ranged admission refund deferred to recovery",
          undefined,
          { attackerId, targetId, operationId: arrowDebit.operationId },
        );
      }
      return;
    }

    // Keep the locally admitted projectile non-hittable and invisible until
    // its staged debit reaches a durable fired terminal. Cancellation can race
    // this await; the database serializes the exact fired/cancelled winner.
    const scheduledHitTick = projectile.hitsAtTick;
    projectile.hitsAtTick = Number.POSITIVE_INFINITY;
    const launchSettlement =
      await this.equipmentSystem!.completeArrowProjectileAtomic(
        projectileParams.ammunitionCustody!,
      );
    if (!launchSettlement.ok || launchSettlement.status !== "fired") {
      this.projectileService.cancelProjectile(projectile.id, (cancelled) =>
        this.handleProjectileCancellation(cancelled, "combat_state_missing"),
      );
      this.restoreClaimedProjectileCooldown(
        typedAttackerId,
        claimedNextAttackTick,
        previousNextAttackTick,
      );
      return;
    }
    projectile.ammunitionRecovery =
      launchSettlement.recoverySource ?? undefined;
    if (this.projectileService.getProjectile(projectile.id) !== projectile) {
      if (launchSettlement.recoverySource) {
        await this.exposeAmmunitionRecovery(
          projectile.id,
          launchSettlement.recoverySource,
        );
      }
      return;
    }
    projectile.hitsAtTick = Math.max(
      scheduledHitTick,
      (this.world.currentTick ?? projectileCommitTick) + 1,
    );

    this.rotationManager.rotateTowardsTarget(
      attackerId,
      targetId,
      attackerType,
      targetType,
    );
    this.animationManager.setCombatEmote(
      attackerId,
      attackerType,
      projectileCommitTick,
      attackSpeedTicks,
    );

    // Keep the visual flight on the same tick-derived authority as the
    // projectile service. Player attacks previously omitted this duration,
    // which made clients guess from render speed and occasionally remove an
    // arrow before its real hit under load.
    const arrowLaunchDelayMs = COMBAT_CONSTANTS.ARROW_LAUNCH_DELAY_MS;
    const travelDurationMs = Math.max(
      200,
      projectile.delayTicks * COMBAT_CONSTANTS.TICK_DURATION_MS -
        arrowLaunchDelayMs,
    );

    // Emit projectile created event for client visuals
    this.emitProjectileLaunched(
      attackerId,
      targetId,
      "arrow",
      attackerPos,
      targetPos,
      undefined,
      arrowId,
      arrowLaunchDelayMs,
      travelDurationMs,
      projectile.id,
    );

    // Set cooldown and enter combat
    const typedTargetId = createEntityID(targetId);
    this.enterCombat(
      typedAttackerId,
      typedTargetId,
      attackSpeedTicks,
      AttackType.RANGED,
    );
  }

  private handleMagicAttack(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    spellId?: string;
  }): Promise<void> {
    return this.trackProjectileCustodyOperation(
      this.handleMagicAttackImpl(data),
    );
  }

  private async handleMagicAttackImpl(data: {
    attackerId: string;
    targetId: string;
    attackerType: "player" | "mob";
    targetType: "player" | "mob";
    spellId?: string;
  }): Promise<void> {
    const { attackerId, targetId, attackerType, targetType } = data;
    if (
      this.isDuelPreparationCombatFenced(attackerId) ||
      this.isDuelPreparationCombatFenced(targetId)
    ) {
      return;
    }
    const currentTick = this.world.currentTick ?? 0;

    // Mobs can launch magic projectiles when configured with spellId.
    if (attackerType === "mob") {
      const attacker = this.entityResolver.resolve(attackerId, attackerType);
      const target = this.entityResolver.resolve(targetId, targetType);
      if (!attacker || !target || !isMobEntity(attacker)) return;

      if (
        !this.entityResolver.isAlive(attacker, attackerType) ||
        !this.entityResolver.isAlive(target, targetType)
      ) {
        return;
      }

      const mobData = attacker.getMobData();
      const npcData = getNPCById(mobData.type);
      if (!npcData) return;

      const spellId = data.spellId ?? npcData.combat.spellId;
      if (!spellId) {
        console.warn(
          `[MagicAttackHandler] Mob ${attackerId} (${mobData.type}) has no spellId configured, skipping attack`,
        );
        return;
      }

      const spell = spellService.getSpell(spellId);
      if (!spell) return;

      const attackRange = Math.max(
        1,
        Math.floor(npcData.combat.combatRange ?? COMBAT_CONSTANTS.MAGIC_RANGE),
      );
      const attackerPos = getEntityPosition(attacker);
      const targetPos = getEntityPosition(target);
      if (!attackerPos || !targetPos) return;

      tilePool.setFromPosition(this._attackerTile, attackerPos);
      tilePool.setFromPosition(this._targetTile, targetPos);
      const distance = tileChebyshevDistance(
        this._attackerTile,
        this._targetTile,
      );
      if (distance > attackRange || distance === 0) {
        this.emitAttackFailed(attackerId, targetId, "out_of_range");
        return;
      }

      const typedAttackerId = createEntityID(attackerId);
      if (!this.checkAttackCooldown(typedAttackerId, currentTick)) {
        return;
      }

      const attackSpeedTicks = Math.max(
        1,
        npcData.combat.attackSpeedTicks ?? spell.attackSpeed,
      );

      this.rotationManager.rotateTowardsTarget(
        attackerId,
        targetId,
        attackerType,
        targetType,
      );
      this.animationManager.setCombatEmote(
        attackerId,
        attackerType,
        currentTick,
        attackSpeedTicks,
        "magic",
      );

      const damage = this.calculateMobMagicDamageForAttack(
        target,
        targetType,
        npcData.stats.magic ?? 1,
        spell,
      );

      const projectileParams: CreateProjectileParams = {
        sourceId: attackerId,
        targetId,
        attackType: AttackType.MAGIC,
        damage,
        currentTick,
        sourcePosition: { x: attackerPos.x, z: attackerPos.z },
        targetPosition: { x: targetPos.x, z: targetPos.z },
        spellId: spell.id,
        xpReward: 0,
      };

      const projectile =
        this.projectileService.createProjectile(projectileParams);
      if (!projectile) return;

      const { HIT_DELAY, TICK_DURATION_MS } = COMBAT_CONSTANTS;
      const magicHitDelayTicks = Math.min(
        HIT_DELAY.MAX_HIT_DELAY,
        HIT_DELAY.MAGIC_BASE +
          Math.floor(
            (HIT_DELAY.MAGIC_DISTANCE_OFFSET + distance) /
              HIT_DELAY.MAGIC_DISTANCE_DIVISOR,
          ),
      );
      const spellLaunchDelayMs = COMBAT_CONSTANTS.SPELL_LAUNCH_DELAY_MS;
      const travelDurationMs = Math.max(
        200,
        magicHitDelayTicks * TICK_DURATION_MS - spellLaunchDelayMs,
      );

      this.emitProjectileLaunched(
        attackerId,
        targetId,
        spell.element,
        attackerPos,
        targetPos,
        spell.id,
        undefined,
        spellLaunchDelayMs,
        travelDurationMs,
        projectile.id,
      );

      const typedTargetId = createEntityID(targetId);
      this.nextAttackTicks.set(typedAttackerId, currentTick + attackSpeedTicks);
      this.enterCombat(
        typedAttackerId,
        typedTargetId,
        attackSpeedTicks,
        AttackType.MAGIC,
      );
      return;
    }

    // Detect streaming duel agents for diagnostic logging
    const attackerEntity = this.world.entities.get(attackerId);
    const isStreamingDuel =
      (attackerEntity as { data?: { inStreamingDuel?: boolean } })?.data
        ?.inStreamingDuel === true;

    // Validate entity IDs
    if (
      !this.entityIdValidator.isValid(attackerId) ||
      !this.entityIdValidator.isValid(targetId)
    ) {
      if (isStreamingDuel) {
        console.warn(
          `[MagicAttack:Duel] Entity ID validation failed for ${attackerId} → ${targetId}`,
        );
      }
      return;
    }

    // Rate limiting
    const rateResult = this.rateLimiter.checkLimit(attackerId, currentTick);
    if (!rateResult.allowed) {
      if (isStreamingDuel) {
        console.warn(
          `[MagicAttack:Duel] Rate limited: ${attackerId} (reason=${rateResult.reason ?? "unknown"})`,
        );
      }
      return;
    }
    this.antiCheat.trackAttack(attackerId, currentTick);

    // Get entities
    const attacker = this.entityResolver.resolve(attackerId, attackerType);
    const target = this.entityResolver.resolve(targetId, targetType);
    if (!attacker || !target) {
      if (isStreamingDuel) {
        console.warn(
          `[MagicAttack:Duel] Entity resolve failed: attacker=${!!attacker} target=${!!target}`,
        );
      }
      return;
    }

    // Check both are alive
    if (
      !this.entityResolver.isAlive(attacker, attackerType) ||
      !this.entityResolver.isAlive(target, targetType)
    ) {
      if (isStreamingDuel) {
        console.warn(
          `[MagicAttack:Duel] Alive check failed: attacker=${this.entityResolver.isAlive(attacker, attackerType)} target=${this.entityResolver.isAlive(target, targetType)}`,
        );
      }
      return;
    }

    // Get selected spell from player data
    const selectedSpellId = this.getPlayerSelectedSpell(attackerId);
    const magicLevel = this.getPlayerSkillLevel(attackerId, "magic");

    if (isStreamingDuel && !selectedSpellId) {
      // Extra diagnostics: check entity.data directly
      const entityData = attackerEntity?.data as {
        selectedSpell?: string;
      } | null;
      const worldPlayer = this.world.getPlayer?.(attackerId);
      console.warn(
        `[MagicAttack:Duel] selectedSpell NULL for ${attackerId}! ` +
          `entity.data.selectedSpell=${entityData?.selectedSpell ?? "undefined"} ` +
          `worldPlayer.data.selectedSpell=${(worldPlayer?.data as { selectedSpell?: string } | null)?.selectedSpell ?? "undefined"} ` +
          `worldPlayer exists=${!!worldPlayer}`,
      );
    }

    // Validate spell can be cast
    const spellValidation = spellService.canCastSpell(
      selectedSpellId,
      magicLevel,
    );
    if (!spellValidation.valid) {
      if (isStreamingDuel) {
        console.warn(
          `[MagicAttack:Duel] Spell validation failed: spell=${selectedSpellId} level=${magicLevel} error=${spellValidation.error}`,
        );
      }
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: spellValidation.error ?? "You cannot cast this spell.",
        type: "error",
      });
      return;
    }

    const spell = spellService.getSpell(selectedSpellId!);
    if (!spell) {
      if (isStreamingDuel) {
        console.warn(
          `[MagicAttack:Duel] Spell lookup failed: ${selectedSpellId}`,
        );
      }
      return;
    }

    // Validate runes in inventory
    const weapon = this.getEquippedWeapon(attackerId);
    const inventory = this.getPlayerInventoryItems(attackerId);

    if (isStreamingDuel && inventory.length === 0) {
      console.warn(
        `[MagicAttack:Duel] Empty inventory for ${attackerId}! inventorySystem=${!!this.inventorySystem}`,
      );
    }

    const runeValidation = runeService.hasRequiredRunes(
      inventory,
      spell.runes,
      weapon,
    );
    if (!runeValidation.valid) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: runeValidation.error ?? "You don't have enough runes.",
        type: "error",
      });
      return;
    }

    // Check magic attack range (spells have fixed range, typically 10 tiles)
    const attackRange = 10;
    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return;

    tilePool.setFromPosition(this._attackerTile, attackerPos);
    tilePool.setFromPosition(this._targetTile, targetPos);
    const distance = tileChebyshevDistance(
      this._attackerTile,
      this._targetTile,
    );

    if (distance > attackRange || distance === 0) {
      if (isStreamingDuel) {
        console.warn(
          `[MagicAttack:Duel] Range check failed: attacker=${attackerId} target=${targetId} ` +
            `distance=${distance} range=${attackRange} sameEntity=${attacker === target} ` +
            `attackerPos=(${attackerPos.x},${attackerPos.y},${attackerPos.z}) ` +
            `targetPos=(${targetPos.x},${targetPos.y},${targetPos.z}) ` +
            `attackerTile=(${this._attackerTile.x},${this._attackerTile.z}) ` +
            `targetTile=(${this._targetTile.x},${this._targetTile.z})`,
        );
      }
      this.emitAttackFailed(attackerId, targetId, "out_of_range");
      return;
    }

    // Check cooldown
    const typedAttackerId = createEntityID(attackerId);
    if (!this.checkAttackCooldown(typedAttackerId, currentTick)) {
      return;
    }
    if (this.pendingProjectileAttacks.has(typedAttackerId)) {
      return;
    }
    // Keep the reservation and launch geometry byte-equivalent even when the
    // attacker or target moves while durable rune custody is committing.
    const projectileSourcePosition = {
      x: attackerPos.x,
      z: attackerPos.z,
    };
    const projectileTargetPosition = {
      x: targetPos.x,
      z: targetPos.z,
    };
    const projectileReservation = this.projectileService.reserveProjectile(
      attackerId,
      projectileSourcePosition,
      projectileTargetPosition,
    );
    if (!projectileReservation) {
      this.emitAttackFailed(attackerId, targetId, "projectile_capacity");
      return;
    }

    // Get attack speed from spell (clamp to minimum 1 tick)
    const attackSpeedTicks = Math.max(1, spell.attackSpeed);

    // Claim cooldown slot IMMEDIATELY to prevent async race condition.
    // consumeRunesForSpell is async, so two concurrent invocations (event
    // handler + tick auto-attack) can both pass checkAttackCooldown before
    // either sets the cooldown, resulting in duplicate projectiles.
    const previousNextAttackTick = this.nextAttackTicks.get(typedAttackerId);
    const claimedNextAttackTick = currentTick + attackSpeedTicks;
    this.nextAttackTicks.set(typedAttackerId, claimedNextAttackTick);
    this.pendingProjectileAttacks.add(typedAttackerId);

    // Calculate damage
    const damage = this.calculateMagicDamageForAttack(
      attacker,
      target,
      attackerId,
      targetType,
      spell,
    );
    const attackCommitEpoch = this.captureAttackCommitEpoch(
      attackerId,
      targetId,
    );

    // The complete spell cost is one durable custody operation for every
    // player, including selected duel contestants. No animation, combat state,
    // projectile, damage, or XP is created unless that receipt succeeds.
    let runeDebit:
      | { ok: true; custody: ProjectileRuneCostSettlementHandle | null }
      | { ok: false; reason: string } = {
      ok: false,
      reason: "persistence_failed",
    };
    try {
      runeDebit = await this.consumeRunesForSpell(
        attackerId,
        spell,
        weapon,
        `spell-runes:${uuid()}${uuid()}`,
      );
    } catch (error) {
      this.logger.error(
        "Magic projectile custody failed before launch",
        error instanceof Error ? error : undefined,
        { attackerId, targetId, spellId: spell.id },
      );
    } finally {
      this.pendingProjectileAttacks.delete(typedAttackerId);
    }
    const attackCommitCurrent = this.isAttackCommitEpochCurrent(
      attackerId,
      targetId,
      attackCommitEpoch,
    );
    this.releaseAttackCommitEpoch(attackerId, targetId);
    if (!attackCommitCurrent) {
      this.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      if (runeDebit.ok && runeDebit.custody && this.inventorySystem) {
        const cancelled =
          await this.inventorySystem.cancelProjectileRuneCostAtomic(
            runeDebit.custody,
          );
        if (!cancelled.ok || cancelled.status !== "cancelled") {
          this.logger.error(
            "Stale magic admission refund deferred to recovery",
            undefined,
            {
              attackerId,
              targetId,
              operationId: runeDebit.custody.operationId,
            },
          );
        }
      }
      this.restoreClaimedProjectileCooldown(
        typedAttackerId,
        claimedNextAttackTick,
        previousNextAttackTick,
      );
      return;
    }
    if (!runeDebit.ok) {
      this.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      this.restoreClaimedProjectileCooldown(
        typedAttackerId,
        claimedNextAttackTick,
        previousNextAttackTick,
      );
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message:
          runeDebit.reason === "insufficient_items"
            ? "You don't have enough runes."
            : "The spell was cancelled before launch. Your inventory is being synchronized.",
        type: "error",
      });
      return;
    }

    const projectileCommitTick = this.world.currentTick ?? currentTick;
    if (this.nextAttackTicks.get(typedAttackerId) === claimedNextAttackTick) {
      this.nextAttackTicks.set(
        typedAttackerId,
        projectileCommitTick + attackSpeedTicks,
      );
    }

    // Create projectile with delayed hit
    const projectileParams: CreateProjectileParams = {
      sourceId: attackerId,
      targetId,
      attackType: AttackType.MAGIC,
      damage,
      currentTick: projectileCommitTick,
      sourcePosition: projectileSourcePosition,
      targetPosition: projectileTargetPosition,
      spellId: spell.id,
      xpReward: spell.baseXp,
      runeCustody: runeDebit.custody ?? undefined,
    };

    const projectile = this.projectileService.createReservedProjectile(
      projectileReservation,
      projectileParams,
    );
    if (!projectile) {
      this.projectileService.releaseProjectileReservation(
        projectileReservation,
      );
      this.logger.error(
        `Reserved projectile admission failed after committed spell debit for ${attackerId}`,
        new Error("magic_projectile_commit_invariant_failed"),
      );
      if (runeDebit.custody && this.inventorySystem) {
        const cancelled =
          await this.inventorySystem.cancelProjectileRuneCostAtomic(
            runeDebit.custody,
          );
        if (!cancelled.ok || cancelled.status !== "cancelled") {
          this.logger.error(
            "Failed reserved magic admission refund deferred to recovery",
            undefined,
            {
              attackerId,
              targetId,
              operationId: runeDebit.custody.operationId,
            },
          );
        }
      }
      return;
    }

    if (runeDebit.custody && this.inventorySystem) {
      const scheduledHitTick = projectile.hitsAtTick;
      projectile.hitsAtTick = Number.POSITIVE_INFINITY;
      const launchSettlement =
        await this.inventorySystem.completeProjectileRuneCostAtomic(
          runeDebit.custody,
        );
      if (!launchSettlement.ok || launchSettlement.status !== "fired") {
        this.projectileService.cancelProjectile(projectile.id, (cancelled) =>
          this.handleProjectileCancellation(cancelled, "combat_state_missing"),
        );
        this.restoreClaimedProjectileCooldown(
          typedAttackerId,
          claimedNextAttackTick,
          previousNextAttackTick,
        );
        return;
      }
      if (this.projectileService.getProjectile(projectile.id) !== projectile) {
        return;
      }
      projectile.hitsAtTick = Math.max(
        scheduledHitTick,
        (this.world.currentTick ?? projectileCommitTick) + 1,
      );
    }

    const typedTargetId = createEntityID(targetId);
    this.enterCombat(
      typedAttackerId,
      typedTargetId,
      attackSpeedTicks,
      AttackType.MAGIC,
    );
    this.rotationManager.rotateTowardsTarget(
      attackerId,
      targetId,
      attackerType,
      targetType,
    );
    this.animationManager.setCombatEmote(
      attackerId,
      attackerType,
      projectileCommitTick,
      attackSpeedTicks,
    );

    // Use the projectile service's hit tick for the visual duration so player
    // and mob spells share one authoritative timing model.
    const spellLaunchDelayMs = COMBAT_CONSTANTS.SPELL_LAUNCH_DELAY_MS;
    const travelDurationMs = Math.max(
      200,
      projectile.delayTicks * COMBAT_CONSTANTS.TICK_DURATION_MS -
        spellLaunchDelayMs,
    );

    // Emit projectile created event for client visuals.
    this.emitProjectileLaunched(
      attackerId,
      targetId,
      spell.element,
      attackerPos,
      targetPos,
      spell.id,
      undefined,
      spellLaunchDelayMs,
      travelDurationMs,
      projectile.id,
    );
  }

  /**
   * Get player skill level
   */
  private getPlayerSkillLevel(
    playerId: string,
    skill: "ranged" | "magic" | "defense",
  ): number {
    // Use world.getPlayer() to ensure consistency with PlayerSystem
    const playerEntity = this.world.getPlayer?.(playerId);
    if (!playerEntity) return 1;

    const statsComponent = playerEntity.getComponent("stats");
    if (!statsComponent?.data) return 1;

    const stats = statsComponent.data as Record<
      string,
      { level: number } | number
    >;
    const skillData = stats[skill];

    if (typeof skillData === "object" && skillData !== null) {
      return skillData.level ?? 1;
    }
    if (typeof skillData === "number") {
      return skillData;
    }
    return 1;
  }

  /**
   * Get player's selected autocast spell
   */
  private getPlayerSelectedSpell(playerId: string): string | null {
    // Use world.getPlayer() to ensure we get the same player entity as PlayerSystem
    const playerEntity = this.world.getPlayer?.(playerId);
    if (!playerEntity?.data) return null;

    return (
      (playerEntity.data as { selectedSpell?: string }).selectedSpell ?? null
    );
  }

  /**
   * Get player inventory items for rune checking
   */
  private getPlayerInventoryItems(
    playerId: string,
  ): Array<{ itemId: string; quantity: number; slot: number }> {
    if (!this.inventorySystem) return [];

    const inventory = this.inventorySystem.getInventory(playerId);
    if (!inventory?.items) return [];

    return inventory.items
      .filter((item) => item.itemId)
      .map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity ?? 1,
        slot: item.slot,
      }));
  }

  /**
   * Consume runes for spell cast
   */
  private async consumeRunesForSpell(
    playerId: string,
    spell: Spell,
    weapon: Item | null,
    operationId: string,
  ): Promise<
    | { ok: true; custody: ProjectileRuneCostSettlementHandle | null }
    | { ok: false; reason: string }
  > {
    if (!this.inventorySystem) {
      return { ok: false, reason: "atomic_persistence_unavailable" };
    }

    const runesToConsume = runeService.getRunesToConsume(spell.runes, weapon);
    if (runesToConsume.length === 0) return { ok: true, custody: null };
    const receipt = await this.inventorySystem.stageProjectileRuneCostAtomic(
      playerId,
      operationId,
      runesToConsume.map((requirement) => ({
        itemId: requirement.runeId,
        quantity: requirement.quantity,
      })),
    );
    return receipt.ok
      ? {
          ok: true,
          custody: {
            operationId: receipt.operationId,
            playerId: receipt.playerId,
            requestFingerprint: receipt.requestFingerprint,
            requirements: receipt.requirements,
          },
        }
      : { ok: false, reason: receipt.reason };
  }

  /**
   * Calculate ranged damage for an attack
   */
  private calculateRangedDamageForAttack(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    attackerId: string,
    targetType: "player" | "mob",
  ): number {
    const rangedLevel = this.getPlayerSkillLevel(attackerId, "ranged");
    const equipmentStats = this.playerEquipmentStats.get(attackerId);
    const arrowSlot = this.getEquippedArrows(attackerId);

    // Get arrow strength bonus
    const arrowStrength = ammunitionService.getArrowStrengthBonus(arrowSlot);

    // Get target stats
    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.getPlayerSkillLevel(String(target.id), "defense");

    // Use per-style defenseRanged from equipment (classic MMORPG combat triangle).
    // Falls back to generic ranged bonus for backward compatibility.
    const targetEquipStats = this.playerEquipmentStats.get(String(target.id));
    const targetRangedDefense =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : (targetEquipStats?.defenseRanged ?? targetEquipStats?.ranged ?? 0);

    // Get prayer bonuses
    const prayerSystem = this.world.getSystem("prayer") as PrayerSystem | null;
    const attackerPrayer = prayerSystem?.getCombinedBonuses(attackerId);
    const defenderPrayer =
      targetType === "player"
        ? prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    // NOTE: equipmentStats.rangedStrength already includes arrow strength from EquipmentSystem
    // Do NOT add arrowStrength separately as that would double-count it
    const rangedStrengthBonus = equipmentStats?.rangedStrength ?? arrowStrength;

    // Get player's combat style for rules-accurate damage bonuses
    let rangedStyle: RangedCombatStyle = "accurate";
    const playerSystem = this.world.getSystem("player") as PlayerSystem | null;
    const styleData = playerSystem?.getPlayerAttackStyle?.(attackerId);
    if (styleData?.id) {
      const id = styleData.id;
      if (id === "accurate" || id === "rapid" || id === "longrange") {
        rangedStyle = id;
      }
    }

    const params: RangedDamageParams = {
      rangedLevel,
      rangedAttackBonus: equipmentStats?.rangedAttack ?? 0,
      rangedStrengthBonus,
      style: rangedStyle,
      targetDefenseLevel,
      targetRangedDefenseBonus: targetRangedDefense,
      prayerBonuses: attackerPrayer,
      targetPrayerBonuses: defenderPrayer,
    };

    const result = calculateRangedDamage(params, getGameRng());
    return result.damage;
  }

  /**
   * Calculate ranged damage for a mob attack.
   */
  private calculateMobRangedDamageForAttack(
    target: Entity | MobEntity,
    targetType: "player" | "mob",
    rangedLevel: number,
    arrowId: string,
  ): number {
    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.getPlayerSkillLevel(String(target.id), "defense");

    const targetRangedDefense =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : (this.playerEquipmentStats.get(String(target.id))?.defenseRanged ??
          0);

    const defenderPrayer =
      targetType === "player"
        ? this.prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    const params: RangedDamageParams = {
      rangedLevel,
      rangedAttackBonus: 0,
      rangedStrengthBonus:
        ammunitionService.getArrowData(arrowId)?.rangedStrength ?? 7,
      style: "accurate",
      targetDefenseLevel,
      targetRangedDefenseBonus: targetRangedDefense,
      prayerBonuses: undefined,
      targetPrayerBonuses: defenderPrayer,
    };

    const result = calculateRangedDamage(params, getGameRng());
    return result.damage;
  }

  /**
   * Calculate magic damage for an attack
   */
  private calculateMagicDamageForAttack(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    attackerId: string,
    targetType: "player" | "mob",
    spell: Spell,
  ): number {
    const magicLevel = this.getPlayerSkillLevel(attackerId, "magic");
    const equipmentStats = this.playerEquipmentStats.get(attackerId);

    // Get target stats
    const targetMagicLevel =
      targetType === "mob" && isMobEntity(target)
        ? 1 // Most F2P mobs have 1 magic
        : this.getPlayerSkillLevel(String(target.id), "magic");

    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.getPlayerSkillLevel(String(target.id), "defense");

    const targetMagicDefense =
      targetType === "mob" && isMobEntity(target)
        ? 0
        : (this.playerEquipmentStats.get(String(target.id))?.magicDefense ?? 0);

    // Get prayer bonuses
    const prayerSystem = this.world.getSystem("prayer") as PrayerSystem | null;
    const attackerPrayer = prayerSystem?.getCombinedBonuses(attackerId);
    const defenderPrayer =
      targetType === "player"
        ? prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    // Get player's combat style for rules-accurate damage bonuses
    let magicStyle: MagicCombatStyle = "accurate";
    const playerSystem = this.world.getSystem("player") as PlayerSystem | null;
    const styleData = playerSystem?.getPlayerAttackStyle?.(attackerId);
    if (styleData?.id) {
      const id = styleData.id;
      if (id === "accurate" || id === "longrange" || id === "autocast") {
        magicStyle = id;
      }
    }

    const params: MagicDamageParams = {
      magicLevel,
      magicAttackBonus: equipmentStats?.magicAttack ?? 0,
      style: magicStyle,
      spellBaseMaxHit: spell.baseMaxHit,
      // MagicDamageParams uses "npc" instead of "mob"
      targetType: targetType === "mob" ? "npc" : "player",
      targetMagicLevel,
      targetDefenseLevel,
      targetMagicDefenseBonus: targetMagicDefense,
      prayerBonuses: attackerPrayer,
      targetPrayerBonuses: defenderPrayer,
    };

    const result = calculateMagicDamage(params, getGameRng());
    return result.damage;
  }

  /**
   * Calculate magic damage for a mob attack.
   */
  private calculateMobMagicDamageForAttack(
    target: Entity | MobEntity,
    targetType: "player" | "mob",
    magicLevel: number,
    spell: Spell,
  ): number {
    const targetMagicLevel =
      targetType === "mob" && isMobEntity(target)
        ? 1
        : this.getPlayerSkillLevel(String(target.id), "magic");

    const targetDefenseLevel =
      targetType === "mob" && isMobEntity(target)
        ? target.getMobData().defense
        : this.getPlayerSkillLevel(String(target.id), "defense");

    const targetMagicDefense =
      targetType === "mob" && isMobEntity(target)
        ? 0
        : (this.playerEquipmentStats.get(String(target.id))?.magicDefense ?? 0);

    const defenderPrayer =
      targetType === "player"
        ? this.prayerSystem?.getCombinedBonuses(String(target.id))
        : undefined;

    const params: MagicDamageParams = {
      magicLevel,
      magicAttackBonus: 0,
      style: "accurate",
      spellBaseMaxHit: spell.baseMaxHit,
      targetType: targetType === "mob" ? "npc" : "player",
      targetMagicLevel,
      targetDefenseLevel,
      targetMagicDefenseBonus: targetMagicDefense,
      prayerBonuses: undefined,
      targetPrayerBonuses: defenderPrayer,
    };

    const result = calculateMagicDamage(params, getGameRng());
    return result.damage;
  }

  private handleMobAttack(data: {
    mobId: string;
    targetId: string;
    attackType?: AttackType;
    spellId?: string;
    arrowId?: string;
  }): void {
    if (data.attackType === AttackType.MAGIC) {
      void this.handleMagicAttack({
        attackerId: data.mobId,
        targetId: data.targetId,
        attackerType: "mob",
        targetType: "player",
        spellId: data.spellId,
      });
      return;
    }

    if (data.attackType === AttackType.RANGED) {
      void this.handleRangedAttack({
        attackerId: data.mobId,
        targetId: data.targetId,
        attackerType: "mob",
        targetType: "player",
        arrowId: data.arrowId,
      });
      return;
    }

    // Default mob attack path is melee.
    void this.handleMeleeAttack({
      attackerId: data.mobId,
      targetId: data.targetId,
      attackerType: "mob",
      targetType: "player",
    });
  }

  /**
   * Handle auto-retaliate being toggled ON while being attacked
   * classic MMORPG behavior: Player should start fighting back immediately
   *
   * Supports both PvE (mob attacker) and PvP (player attacker) scenarios.
   */
  private handleAutoRetaliateEnabled(playerId: string): void {
    const playerEntity = this.world.getPlayer?.(playerId);
    if (!playerEntity) return;

    // Use type guard to get pending attacker ID
    const pendingAttacker = getPendingAttacker(playerEntity);
    if (!pendingAttacker) return;

    // Detect attacker type dynamically - supports both PvP and PvE
    // This fixes the bug where PvP retaliation failed because we assumed "mob"
    const attackerType = this.entityResolver.resolveType(pendingAttacker);
    const attackerEntity = this.entityResolver.resolve(
      pendingAttacker,
      attackerType,
    );

    if (
      !attackerEntity ||
      !this.entityResolver.isAlive(attackerEntity, attackerType)
    ) {
      // Attacker gone - clear pending attacker state using type guard
      clearPendingAttacker(playerEntity);
      return;
    }

    // Start combat! Player now retaliates against the attacker
    const attackSpeedTicks = this.entityResolver.getAttackSpeed(
      createEntityID(playerId),
      "player",
    );

    // enterCombat() detects entity types internally
    this.enterCombat(
      createEntityID(playerId),
      createEntityID(pendingAttacker),
      attackSpeedTicks,
    );

    // Clear pending attacker since we're now actively fighting
    clearPendingAttacker(playerEntity);

    // Clear server face target since player now has a combat target
    // Note: enterCombat() already handles rotation via rotateTowardsTarget()
    this.emitClearFaceTarget(playerId);
  }

  /**
   * rules-accurate: Handle player clicking to move (disengage from combat)
   * In classic MMORPG, clicking anywhere else cancels YOUR current action including combat.
   *
   * CRITICAL: This only affects the DISENGAGING player's combat state.
   * The player who was attacking them (their target) keeps their combat state
   * and continues chasing. This is correct classic MMORPG behavior:
   * - "Deliberate movement out of the opponent's weapon range to force them to follow
   *    is called dragging."
   * - Pathfinding recalculates every tick when targeting a moving entity
   *
   */
  private handlePlayerDisengage(playerId: string): void {
    const combatState = this.stateService.getCombatData(playerId);
    if (!combatState || combatState.attackerType !== "player") {
      return; // Not in combat as an attacker, nothing to cancel
    }

    const targetId = String(combatState.targetId);
    const typedPlayerId = createEntityID(playerId);

    // RULES-ACCURATE: Only remove THIS player's combat state
    // DO NOT call forceEndCombat() as it removes BOTH players' states!
    // The target (who may be attacking this player) keeps their combat state
    // and continues chasing this player. This enables the "dragging" PvP technique.

    // Reset emote for disengaging player only
    this.animationManager.resetEmote(playerId, "player");

    // Clear combat UI state from this player's entity only
    this.stateService.clearCombatStateFromEntity(playerId, "player");

    // Remove ONLY this player's combat state - NOT the target's!
    this.stateService.removeCombatState(typedPlayerId);

    // Clean up combat follow tracking for disengaging player
    this.lastCombatTargetTile.delete(playerId);

    // Mark player as "in combat without target" - the attacker is still chasing them
    // This keeps the combat timer active but player won't auto-attack
    // If auto-retaliate is ON and attacker catches up and hits, player will start fighting again
    this.stateService.markInCombatWithoutTarget(playerId, targetId);

    // RULES-ACCURATE: Do NOT face the target when walking away
    // Player should face their walking direction (handled by tile movement)
    // Only face target when auto-retaliate triggers (handled by enterCombat)
  }

  /**
   * Handle combat follow - move player toward target when out of melee range.
   * This allows combat to continue when the target moves instead of timing out.
   *
   * NOTE: Actual movement is handled by ServerNetwork listening for COMBAT_FOLLOW_TARGET event.
   * This handler validates that combat is still active before the server initiates movement.
   */
  private handleCombatFollow(data: {
    playerId: string;
    targetId: string;
    targetPosition: { x: number; y: number; z: number };
  }): void {
    // Verify player is still in combat with this target
    const combatState = this.stateService
      .getCombatStatesMap()
      .get(data.playerId as EntityID);
    if (!combatState || combatState.targetId !== data.targetId) {
      return; // Combat ended or target changed, don't follow
    }
    // Movement is handled by ServerNetwork's COMBAT_FOLLOW_TARGET listener
    // which calls TileMovementManager.movePlayerToward()
  }

  private calculateMeleeDamage(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    style: CombatStyle = "accurate",
  ): number {
    // Get prayer bonuses for attacker and defender (players only)
    let attackerPrayerBonuses: PrayerCombatBonuses | undefined;
    let defenderPrayerBonuses: PrayerCombatBonuses | undefined;

    // OPTIMIZATION: Use cached prayerSystem instead of getSystem() per damage calc
    if (this.prayerSystem) {
      // Attacker prayer bonuses (if player)
      if (!(attacker instanceof MobEntity)) {
        const bonuses = this.prayerSystem.getCombinedBonuses(attacker.id);
        if (bonuses.attackMultiplier || bonuses.strengthMultiplier) {
          attackerPrayerBonuses = bonuses;
        }
      }

      // Defender prayer bonuses (if player)
      if (!(target instanceof MobEntity)) {
        const bonuses = this.prayerSystem.getCombinedBonuses(target.id);
        if (bonuses.defenseMultiplier) {
          defenderPrayerBonuses = bonuses;
        }
      }
    }

    // Determine melee attack style from weapon type (classic MMORPG combat triangle)
    let meleeAttackStyle: MeleeAttackStyle | undefined;
    if (!(attacker instanceof MobEntity)) {
      const weapon = this.getEquippedWeapon(attacker.id);
      const weaponType = weapon?.weaponType?.toLowerCase() ?? "none";
      meleeAttackStyle = WEAPON_DEFAULT_ATTACK_STYLE[weaponType] ?? "crush";
    }

    return this.damageCalculator.calculateMeleeDamage(
      attacker,
      target,
      style,
      attackerPrayerBonuses,
      defenderPrayerBonuses,
      meleeAttackStyle,
    );
  }

  // MVP: calculateRangedDamage removed - melee only

  private applyDamage(
    targetId: string,
    targetType: string,
    damage: number,
    attackerId: string,
    projectileCost?: DuelDamageProjectileCostAuthority,
  ): DamageResolution | Promise<DamageResolution> {
    const failed = (targetDied = false): DamageResolution => ({
      actualDamage: 0,
      targetDied,
      success: false,
    });
    // Validate target type
    if (targetType !== "player" && targetType !== "mob") {
      return failed();
    }

    // Get the appropriate handler for the target type
    const handler = this.damageHandlers.get(targetType);
    if (!handler) {
      this.logger.error("No damage handler for target type", undefined, {
        targetType,
      });
      return failed();
    }

    // Create typed EntityID for handler
    const typedTargetId = createEntityID(targetId);
    const typedAttackerId = createEntityID(attackerId);

    // Determine attacker type for handler
    const attackerType = this.entityResolver.resolveType(attackerId);

    const attacker = this.world.entities.get(attackerId);
    const target = this.world.entities.get(targetId);
    const isStreamingDuelDamage =
      damage > 0 &&
      targetType === "player" &&
      attackerType === "player" &&
      (attacker as { data?: { inStreamingDuel?: boolean } } | undefined)?.data
        ?.inStreamingDuel === true &&
      (target as { data?: { inStreamingDuel?: boolean } } | undefined)?.data
        ?.inStreamingDuel === true;
    if (isStreamingDuelDamage) {
      const authority = getStreamingDuelDamageAuthority(this.world);
      const commitAuthority = authority?.createDamageObservationContext(
        attackerId,
        targetId,
        damage,
      );
      if (!authority || !commitAuthority || !this.playerSystem) {
        authority?.handleDamageCommitFailure(
          attackerId,
          targetId,
          "damage_authority_unavailable",
          commitAuthority?.publicActionObservation,
        );
        return failed();
      }
      return this.enqueueStreamingDuelDamage({
        attackerId,
        targetId,
        damage,
        authority,
        commitAuthority,
        projectileCost,
      });
    }

    // Apply damage through polymorphic handler
    const result = handler.applyDamage(
      typedTargetId,
      damage,
      typedAttackerId,
      attackerType,
    );

    // Handle failed damage application
    if (!result.success) {
      if (result.targetDied) {
        // Target was already dead - end ALL combat with this entity
        this.handleEntityDied(targetId, targetType);
      } else {
        this.logger.error("Failed to apply damage", undefined, {
          targetId,
          targetType,
        });
      }
      return result;
    }

    // Prevent additional attacks if target died this tick
    if (result.targetDied) {
      this.handleEntityDied(targetId, targetType);
      return result;
    }

    // Emit UI message based on target type
    if (targetType === "player") {
      // Get attacker name for message
      const attackerHandler = this.damageHandlers.get(attackerType);
      const attackerName = attackerHandler
        ? attackerHandler.getDisplayName(typedAttackerId)
        : "enemy";

      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: targetId,
        message: `The ${attackerName} hits you for ${damage} damage!`,
        type: "damage",
      });
    }
    // Note: Mob death messages are emitted by MobEntity.die() to avoid duplication

    // Note: Damage splatter events are now emitted at the call sites
    // (handleMeleeAttack, processAutoAttack) to ensure they're emitted even for 0 damage hits
    return result;
  }

  /**
   * Serialize hits from one attacker while allowing the opposing contestant's
   * transaction to proceed. An ambiguous response retains the exact operation
   * and retries it until persistence returns committed truth or a deterministic
   * rejection; a new operation is never fabricated during reconciliation.
   */
  private enqueueStreamingDuelDamage(input: {
    attackerId: string;
    targetId: string;
    damage: number;
    authority: StreamingDuelDamageAuthority;
    commitAuthority: StreamingDuelDamageCommitAuthority;
    projectileCost?: DuelDamageProjectileCostAuthority;
  }): Promise<DamageResolution> {
    const {
      attackerId,
      targetId,
      damage,
      authority,
      commitAuthority,
      projectileCost,
    } = input;
    const observation = commitAuthority.publicActionObservation;
    const operationId = observation.operationId;
    const failed = (targetDied = false): DamageResolution => ({
      actualDamage: 0,
      targetDied,
      success: false,
    });
    if (
      this.duelDamageReconciliationStopped ||
      this.pendingDuelDamageOperations.has(operationId)
    ) {
      authority.handleDamageCommitFailure(
        attackerId,
        targetId,
        "damage_operation_duplicate",
        observation,
      );
      return Promise.resolve(failed());
    }

    const pending: PendingDuelDamageOperation = {
      status: "queued",
      startedAt: Date.now(),
      reconciliationAttempts: 0,
      reconciliationStartedAt: null,
    };
    this.pendingDuelDamageOperations.set(operationId, pending);
    authority.handleDamageCommitStarted(observation);

    const previousTail =
      this.duelDamageTailByAttacker.get(attackerId) ?? Promise.resolve();
    const result = previousTail.then(async (): Promise<DamageResolution> => {
      if (this.duelDamageReconciliationStopped) return failed();
      pending.status = "committing";

      for (;;) {
        let receipt;
        try {
          receipt = await this.playerSystem!.damagePlayerAtomic(
            targetId,
            damage,
            attackerId,
            observation,
            commitAuthority.competitiveAuthority,
            projectileCost,
          );
        } catch (error) {
          this.logger.error(
            "Streaming duel damage reconciliation threw",
            error instanceof Error ? error : undefined,
            { attackerId, targetId, operationId },
          );
          receipt = {
            ok: false as const,
            committed: false,
            operationId,
            replayed: false,
            appliedDamage: 0 as const,
            targetDied: false,
            competitiveTerminal: null,
            reason: "persistence_unknown" as const,
          };
        }

        if (receipt.ok) {
          return {
            actualDamage: receipt.appliedDamage,
            targetDied: receipt.targetDied,
            success: true,
            publicActionObservation: receipt.publicActionObservation,
            ...(receipt.competitiveTerminal
              ? { competitiveTerminal: receipt.competitiveTerminal }
              : {}),
          };
        }
        if (receipt.reason !== "persistence_unknown") {
          const currentAuthority =
            getStreamingDuelDamageAuthority(this.world) ?? authority;
          currentAuthority.handleDamageCommitFailure(
            attackerId,
            targetId,
            receipt.reason,
            observation,
          );
          return failed(receipt.targetDied);
        }

        pending.status = "reconciling";
        pending.reconciliationAttempts += 1;
        pending.reconciliationStartedAt ??= Date.now();
        if (
          pending.reconciliationAttempts === 1 ||
          pending.reconciliationAttempts % 30 === 0
        ) {
          this.logger.warn(
            "Streaming duel damage response remains unknown; retrying exact operation",
            {
              attackerId,
              targetId,
              operationId,
              attempts: pending.reconciliationAttempts,
            },
          );
        }
        if (!(await this.waitForDuelDamageReconciliationRetry())) {
          return failed();
        }
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.duelDamageTailByAttacker.set(attackerId, tail);
    void tail.finally(() => {
      this.pendingDuelDamageOperations.delete(operationId);
      authority.handleDamageCommitSettled(observation);
      if (this.duelDamageTailByAttacker.get(attackerId) === tail) {
        this.duelDamageTailByAttacker.delete(attackerId);
      }
    });
    return result;
  }

  private hasUnknownDuelDamageCommit(): boolean {
    for (const pending of this.pendingDuelDamageOperations.values()) {
      if (pending.status === "reconciling") return true;
    }
    return false;
  }

  private waitForDuelDamageReconciliationRetry(): Promise<boolean> {
    if (this.duelDamageReconciliationStopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wait = {} as DuelDamageRetryWait;
      wait.resolve = resolve;
      wait.timer = setTimeout(() => {
        this.duelDamageRetryWaits.delete(wait);
        resolve(!this.duelDamageReconciliationStopped);
      }, DUEL_DAMAGE_RECONCILIATION_RETRY_MS);
      this.duelDamageRetryWaits.add(wait);
    });
  }

  // Note: syncCombatStateToEntity, clearCombatStateFromEntity moved to CombatStateService
  // Note: setCombatEmote, resetEmote moved to CombatAnimationManager
  // Note: rotateTowardsTarget moved to CombatRotationManager

  private enterCombat(
    attackerId: EntityID,
    targetId: EntityID,
    attackerSpeedTicks?: number,
    attackerWeaponType: AttackType = AttackType.MELEE,
  ): void {
    if (
      this.isDuelPreparationCombatFenced(String(attackerId)) ||
      this.isDuelPreparationCombatFenced(String(targetId))
    ) {
      return;
    }
    const currentTick = this.world.currentTick ?? 0;

    // Detect entity types (don't assume attacker is always player!)
    const attackerEntity = this.world.entities.get(String(attackerId));
    const targetEntity = this.world.entities.get(String(targetId));

    // Don't enter combat if target is dead (using type guard)
    if (isEntityDead(targetEntity)) {
      return;
    }

    // Also check if target is a player marked as dead
    const playerSystem = this.world.getSystem<PlayerSystem>("player");
    if (playerSystem?.getPlayer) {
      const targetPlayer = playerSystem.getPlayer(String(targetId));
      if (targetPlayer && !targetPlayer.alive) {
        return;
      }
    }

    const attackerType =
      attackerEntity?.type === "mob" ? ("mob" as const) : ("player" as const);
    const targetType =
      targetEntity?.type === "mob" ? ("mob" as const) : ("player" as const);

    const attackerInStreamingDuel =
      (attackerEntity as { data?: { inStreamingDuel?: boolean } } | undefined)
        ?.data?.inStreamingDuel === true;
    const targetInStreamingDuel =
      (targetEntity as { data?: { inStreamingDuel?: boolean } } | undefined)
        ?.data?.inStreamingDuel === true;
    const bypassPvPZoneCheck = attackerInStreamingDuel || targetInStreamingDuel;

    // PvP ZONE VALIDATION: Prevent player vs player combat in safe zones
    // This is critical to prevent:
    // - Combat resuming after respawn in safe zone
    // - Players attacking each other in towns/banks
    // - Auto-retaliate triggering in non-PvP areas
    // OPTIMIZATION: Use cached zoneDetectionSystem
    if (
      attackerType === "player" &&
      targetType === "player" &&
      !bypassPvPZoneCheck
    ) {
      if (this.zoneDetectionSystem) {
        const attackerPos = getEntityPosition(attackerEntity);
        if (attackerPos) {
          const isPvPAllowed = this.zoneDetectionSystem.isPvPEnabled({
            x: attackerPos.x,
            z: attackerPos.z,
          });
          if (!isPvPAllowed) {
            return; // Cannot start PvP in safe zone
          }
        }
      }
    }

    // Get attack speeds in ticks (use provided or calculate)
    const attackerAttackSpeedTicks =
      attackerSpeedTicks ??
      this.entityResolver.getAttackSpeed(attackerId, attackerType);
    const targetAttackSpeedTicks = this.entityResolver.getAttackSpeed(
      targetId,
      targetType,
    );

    // Set combat state for attacker (just attacked, so next attack is after cooldown)
    this.stateService.createAttackerState(
      attackerId,
      targetId,
      attackerType,
      targetType,
      currentTick,
      attackerAttackSpeedTicks,
      attackerWeaponType,
    );

    // classic MMORPG Retaliation: Target retaliates after ceil(speed/2) + 1 ticks
    // Check if target can retaliate (mobs have retaliates flag, players check auto-retaliate setting)
    let canRetaliate = true;
    if (targetType === "mob" && targetEntity) {
      // Check mob's retaliates config using type guard - if false, mob won't fight back
      canRetaliate = getMobRetaliates(targetEntity);
    } else if (targetType === "player") {
      // Check player's auto-retaliate setting
      // Uses cached reference (no getSystem() call in hot path)
      // Defaults to true if PlayerSystem unavailable (fail-safe, classic MMORPG default)
      if (this.playerSystem) {
        canRetaliate = this.playerSystem.getPlayerAutoRetaliate(
          String(targetId),
        );
      }
      // Note: If playerSystem is null, canRetaliate stays true (default classic MMORPG behavior)

      // 20 min AFK disables auto-retaliate
      if (canRetaliate && this.isAFKTooLong(String(targetId), currentTick)) {
        canRetaliate = false;
      }
    }

    // Attacker always faces target
    this.rotationManager.rotateTowardsTarget(
      String(attackerId),
      String(targetId),
      attackerType,
      targetType,
    );

    // Emit COMBAT_FACE_TARGET for the attacker so the local player client
    // rotates toward the target. This is essential for magic/ranged attacks
    // where the player is stationary (no movement to naturally rotate them).
    if (attackerType === "player") {
      this.emitFaceTarget(String(attackerId), String(targetId));
    }

    // Auto-retaliate only triggers when player has no current target
    let targetHasValidTarget = false;
    if (canRetaliate) {
      const targetCombatState = this.stateService.getCombatData(targetId);
      targetHasValidTarget = !!(
        targetCombatState &&
        targetCombatState.inCombat &&
        this.entityResolver.isAlive(
          this.entityResolver.resolve(
            String(targetCombatState.targetId),
            targetCombatState.targetType,
          ),
          targetCombatState.targetType,
        )
      );

      if (!targetHasValidTarget) {
        // Target has no valid target - schedule retaliation (normal classic MMORPG auto-retaliate)
        const retaliationDelay = calculateRetaliationDelay(
          targetAttackSpeedTicks,
        );

        this.stateService.createRetaliatorState(
          targetId,
          attackerId,
          targetType,
          attackerType,
          currentTick,
          retaliationDelay,
          targetAttackSpeedTicks,
        );

        // RULES-ACCURATE: Auto-retaliate ALWAYS redirects player toward attacker
        // When hit with auto-retaliate ON, player stops any current movement and turns to fight
        // The COMBAT_FOLLOW_TARGET event replaces any existing movement destination
        // Wiki: "the player's character walks/runs towards the monster attacking and fights back"

        // ALWAYS rotate defender to face attacker immediately when retaliation starts
        // This fixes PvP rotation bug where defender wouldn't face attacker
        if (targetType === "player") {
          this.rotationManager.rotateTowardsTarget(
            String(targetId),
            String(attackerId),
            targetType,
            attackerType,
          );
        }

        // If not in attack range, also emit follow event to trigger movement
        // Movement will update rotation to face movement direction
        if (targetType === "player" && attackerEntity && targetEntity) {
          const attackerPos = getEntityPosition(attackerEntity);
          const targetPos = getEntityPosition(targetEntity);

          if (attackerPos && targetPos) {
            const attackerTile = worldToTile(attackerPos.x, attackerPos.z);
            const targetTile = worldToTile(targetPos.x, targetPos.z);

            // Get target player's attack type and range (they are retaliating)
            const targetAttackType = this.getAttackTypeFromWeapon(
              String(targetId),
            );
            const targetCombatRange = this.entityResolver.getCombatRange(
              targetEntity,
              "player",
            );

            // Use appropriate range check based on attack type
            const inRange =
              targetAttackType === AttackType.MELEE
                ? tilesWithinMeleeRange(
                    targetTile,
                    attackerTile,
                    targetCombatRange,
                  )
                : tilesWithinRange(targetTile, attackerTile, targetCombatRange);

            if (!inRange) {
              // Not in range - emit follow event to trigger movement
              this.emitFollowTarget(
                String(targetId),
                String(attackerId),
                attackerPos,
                targetCombatRange,
                targetAttackType,
              );
            }
          }
        }
      } else {
        // Target already has valid target - just extend their combat timer
        // They stay locked on their current target (rules-accurate)
        this.stateService.extendCombatTimer(targetId, currentTick);
      }
    }

    // Sync combat state to player entities for client-side combat awareness
    // Attacker always gets combat state with target
    this.stateService.syncCombatStateToEntity(
      String(attackerId),
      String(targetId),
      attackerType,
    );

    // Target only gets NEW combat target if:
    // 1. They will retaliate (auto-retaliate ON), AND
    // 2. They don't already have a valid target (rules-accurate)
    //
    // If target already has a valid target, we don't overwrite their target state.
    // They stay locked on their current enemy.
    // NOTE: We use the same targetHasValidTarget value calculated BEFORE state modifications
    if (canRetaliate && !targetHasValidTarget) {
      // Target has no valid target - sync them to attack this attacker
      this.stateService.syncCombatStateToEntity(
        String(targetId),
        String(attackerId),
        targetType,
      );
    } else if (!canRetaliate && targetType === "player") {
      // Mark player as in combat (for logout timer) but without a target
      // Store attackerId so combat can start if auto-retaliate is toggled ON
      this.stateService.markInCombatWithoutTarget(
        String(targetId),
        String(attackerId),
      );

      // Player visually faces attacker even with auto-retaliate off
      this.emitFaceTarget(String(targetId), String(attackerId));
    }

    // DON'T set combat emotes here - we set them when attacks happen instead
    // This prevents the animation from looping continuously

    // Emit combat started event
    this.emitCombatStarted(String(attackerId), String(targetId));

    this.recordCombatEvent(GameEventType.COMBAT_START, String(attackerId), {
      targetId: String(targetId),
      attackerType,
      targetType,
      attackerAttackSpeedTicks,
      targetAttackSpeedTicks,
    });

    // Show combat UI indicator for the local player (whoever that is)
    const localPlayer = this.world.getPlayer();
    if (
      localPlayer &&
      (String(attackerId) === localPlayer.id ||
        String(targetId) === localPlayer.id)
    ) {
      const opponent =
        String(attackerId) === localPlayer.id ? targetEntity : attackerEntity;
      const opponentName = opponent!.name;

      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: localPlayer.id,
        message: `Combat started with ${opponentName}!`,
        type: "combat",
        duration: 3000,
      });
    }
  }

  private endCombat(data: {
    entityId: string;
    skipAttackerEmoteReset?: boolean;
    skipTargetEmoteReset?: boolean;
  }): void {
    // Validate entity ID before processing
    if (!data.entityId) {
      return;
    }

    const typedEntityId = createEntityID(data.entityId);
    const combatState = this.stateService.getCombatData(data.entityId);
    this.autoAttackQuiescedEntities.delete(typedEntityId);
    this.invalidateAttackCommitEpoch(data.entityId);
    if (!combatState) {
      // An explicit stop can race with state teardown while its projectile is
      // still active. With no counterpart available, clear every projectile
      // involving this entity so it cannot damage a revived/teleported player.
      this.cancelProjectilesInvolvingEntity(
        data.entityId,
        "combat_state_missing",
      );
      return;
    }

    const targetId = String(combatState.targetId);
    this.autoAttackQuiescedEntities.delete(combatState.targetId);
    this.invalidateAttackCommitEpoch(targetId);

    // Projectile damage is delayed by one or more ticks. Combat state teardown
    // must invalidate that queued work before health restoration or a new fight
    // can reuse the same entities.
    this.projectileService.cancelProjectilesBetween(
      data.entityId,
      targetId,
      (projectile) =>
        this.handleProjectileCancellation(projectile, "combat_ended"),
    );

    // Reset emotes for both entities via AnimationManager
    // Skip attacker emote reset if requested (e.g., when target died during attack animation)
    if (!data.skipAttackerEmoteReset) {
      this.animationManager.resetEmote(data.entityId, combatState.attackerType);
    }
    // Skip target emote reset if requested (e.g., when dead entity ends combat, don't reset their attacker)
    if (!data.skipTargetEmoteReset) {
      this.animationManager.resetEmote(targetId, combatState.targetType);
    }

    // Clear combat state from player entities via StateService
    this.stateService.clearCombatStateFromEntity(
      data.entityId,
      combatState.attackerType,
    );
    this.stateService.clearCombatStateFromEntity(
      targetId,
      combatState.targetType,
    );

    // Remove combat states via StateService
    this.stateService.removeCombatState(typedEntityId);
    this.stateService.removeCombatState(combatState.targetId);

    // Clean up combat follow tracking
    this.lastCombatTargetTile.delete(data.entityId);
    this.lastCombatTargetTile.delete(targetId);

    // Emit combat ended event
    this.emitCombatEnded(data.entityId, targetId);

    this.recordCombatEvent(GameEventType.COMBAT_END, data.entityId, {
      targetId,
      attackerType: combatState.attackerType,
      targetType: combatState.targetType,
      reason: "timeout_or_manual",
    });

    if (combatState.attackerType === "player") {
      this.emitClearFaceTarget(data.entityId);
    }
    if (combatState.targetType === "player") {
      this.emitClearFaceTarget(targetId);
    }

    // Show combat end message for player
    if (combatState.attackerType === "player") {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: data.entityId,
        message: `Combat ended.`,
        type: "info",
      });
    }
  }

  /**
   * Handle entity death - immediately clear ALL combat states involving the dead entity
   *
   * CRITICAL FIX: Previously only cleared the dead entity's state, leaving attackers
   * with stale targetIds pointing to the dead (soon respawned) entity. This caused:
   * - Players chasing dead players to spawn point
   * - Mobs following dead players
   * - Combat resuming immediately after respawn
   *
   * Now we:
   * 1. Clear the dead entity's combat state
   * 2. Notify mob attackers via onTargetDied() so they can return to patrol
   * 3. Clear ALL attacker combat states targeting this entity
   * 4. Clean up attack cooldowns for all involved parties
   */
  private handleEntityDied(entityId: string, entityType: string): void {
    const typedEntityId = createEntityID(entityId);

    // A dead entity can have both inbound and outbound delayed hits queued.
    // Remove them before any duel-owned restoration can make the same entity
    // alive again.
    this.cancelProjectilesInvolvingEntity(entityId, "entity_died");

    // Record death event for analytics
    const deathEventType =
      entityType === "player"
        ? GameEventType.DEATH_PLAYER
        : GameEventType.DEATH_MOB;
    const combatState = this.stateService.getCombatData(entityId);
    this.recordCombatEvent(deathEventType, entityId, {
      entityType,
      killedBy: combatState ? String(combatState.targetId) : "unknown",
    });

    // 1. Remove the dead entity's own combat state from the internal map
    this.stateService.removeCombatState(typedEntityId);

    // 1b. CRITICAL: Sync the cleared state to the entity/client
    //     Without this, the client's combat.combatTarget persists and they keep facing the target!
    if (entityType === "player") {
      this.stateService.clearCombatStateFromEntity(entityId, "player");
    }

    // 2. Clear the dead entity's attack cooldown so they can attack immediately after respawn
    this.nextAttackTicks.delete(typedEntityId);

    // 3. Clear any scheduled emote resets for the dead entity
    this.animationManager.cancelEmoteReset(entityId);

    // 4. BEFORE clearing attacker states, notify mob attackers so they can return to patrol
    //    and clear attack cooldowns so attackers can target someone else immediately
    const combatStatesMap = this.stateService.getCombatStatesMap();
    for (const [attackerId, state] of combatStatesMap) {
      if (String(state.targetId) === entityId) {
        // Clear attacker's cooldown so they can engage new targets immediately
        this.nextAttackTicks.delete(attackerId);

        // Notify mob attackers so they can return to patrol/spawn
        if (state.attackerType === "mob") {
          const mobEntity = this.world.entities.get(String(attackerId));
          if (
            isMobEntity(mobEntity) &&
            typeof mobEntity.onTargetDied === "function"
          ) {
            mobEntity.onTargetDied(entityId);
          }
        }
      }
    }

    // 5. CRITICAL: Clear ALL attacker combat states targeting this dead entity
    //    This prevents attackers from continuing to chase/fight the respawned entity
    this.stateService.clearStatesTargeting(entityId);

    // 6. Clear face target for players who had this as pending attacker
    if (entityType === "mob") {
      for (const player of this.world.entities.players.values()) {
        const pendingAttacker = getPendingAttacker(player);
        if (pendingAttacker === entityId) {
          clearPendingAttacker(player);
          this.emitClearFaceTarget(player.id);
        }
      }
    }

    // 7. Reset dead entity's emote if they were mid-animation
    // SKIP for players - let the death animation play instead of resetting to idle
    // Mobs can reset since they have different animation handling
    if (entityType === "mob") {
      this.animationManager.resetEmote(entityId, entityType);
    }
    // Player death animation is handled by PlayerDeathSystem
  }

  /**
   * Handle player respawn - clear any lingering combat states
   *
   * This is a safety net that catches edge cases where combat states
   * might survive the death cleanup. When a player respawns:
   * 1. They should have NO combat state (fresh start)
   * 2. NO entities should be targeting them (they just spawned)
   * 3. Their attack cooldown should be clear (can attack immediately)
   *
   * This ensures players respawn in a completely clean combat state,
   * preventing bugs like:
   * - Being immediately attacked at spawn point
   * - Having stale combat UI indicators
   * - Auto-retaliate triggering against old attackers
   */
  private handlePlayerRespawned(playerId: string): void {
    const typedPlayerId = createEntityID(playerId);

    // Safety net for any projectile that survived an abnormal death path.
    this.cancelProjectilesInvolvingEntity(playerId, "player_respawned");

    // 1. Clear any lingering combat state the respawned player might have
    const playerCombatState = this.stateService.getCombatData(typedPlayerId);
    if (playerCombatState) {
      this.stateService.removeCombatState(typedPlayerId);
      this.stateService.clearCombatStateFromEntity(playerId, "player");
    }

    // 2. Clear the respawned player's attack cooldown
    this.nextAttackTicks.delete(typedPlayerId);

    // 3. Clear any attacker states that might still be targeting this player
    //    (Safety net - handleEntityDied should have already done this)
    this.stateService.clearStatesTargeting(playerId);

    // 4. Clear any pending attacker reference on the player
    const playerEntity = this.world.getPlayer?.(playerId);
    if (playerEntity) {
      clearPendingAttacker(playerEntity);
    }

    // 5. Clear face target so player doesn't auto-look at old attacker
    this.emitClearFaceTarget(playerId);
  }

  // Public API methods
  public startCombat(
    attackerId: string,
    targetId: string,
    options?: {
      attackerType?: "player" | "mob";
      targetType?: "player" | "mob";
      weaponType?: AttackType;
    },
  ): boolean {
    const opts = {
      attackerType: "player",
      targetType: "mob",
      weaponType: AttackType.MELEE,
      ...options,
    };
    if (
      this.isDuelPreparationCombatFenced(attackerId) ||
      this.isDuelPreparationCombatFenced(targetId)
    ) {
      return false;
    }

    const attacker = this.entityResolver.resolve(attackerId, opts.attackerType);
    const target = this.entityResolver.resolve(targetId, opts.targetType);

    if (!attacker || !target) {
      return false;
    }

    const attackerAlive = this.entityResolver.isAlive(
      attacker,
      opts.attackerType,
    );
    const targetAlive = this.entityResolver.isAlive(target, opts.targetType);

    if (!attackerAlive) {
      return false;
    }
    if (!targetAlive) {
      return false;
    }

    // MVP: Melee-only range check (tile-based)
    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return false; // Missing position

    // Use pre-allocated pooled tiles (zero GC)
    tilePool.setFromPosition(this._attackerTile, attackerPos);
    tilePool.setFromPosition(this._targetTile, targetPos);
    const combatRangeTiles = this.entityResolver.getCombatRange(
      attacker,
      opts.attackerType,
    );
    // rules-accurate melee range check (cardinal-only for range 1)
    if (
      !tilesWithinMeleeRange(
        this._attackerTile,
        this._targetTile,
        combatRangeTiles,
      )
    ) {
      return false;
    }

    // Start combat — pass weaponType so enterCombat uses correct attack speed
    this.enterCombat(
      createEntityID(attackerId),
      createEntityID(targetId),
      undefined,
      opts.weaponType as AttackType,
    );
    return true;
  }

  public isInCombat(entityId: string): boolean {
    return this.stateService.isInCombat(entityId);
  }

  public getCombatData(entityId: string): CombatData | null {
    return this.stateService.getCombatData(entityId);
  }

  /**
   * Check if player is on attack cooldown
   * Used by eating system to determine if eat should add attack delay
   *
   * classic MMORPG Rule: Foods only add to EXISTING attack delay.
   * If weapon is ready to attack (cooldown expired), eating does NOT add delay.
   *
   * @param playerId - Player to check
   * @param currentTick - Current game tick
   * @returns true if player has pending attack cooldown
   */
  public isPlayerOnAttackCooldown(
    playerId: string,
    currentTick: number,
  ): boolean {
    const typedPlayerId = createEntityID(playerId);
    const nextAllowedTick = this.nextAttackTicks.get(typedPlayerId) ?? 0;
    return currentTick < nextAllowedTick;
  }

  /**
   * Add delay ticks to player's next attack
   * Used by eating system (classic MMORPG: eating during combat adds 3 tick delay)
   *
   * Rules-Accurate: Only called when player is ALREADY on cooldown.
   * If weapon is ready, eating does not add delay.
   *
   * @param playerId - Player to modify
   * @param delayTicks - Ticks to add to attack cooldown
   */
  public addAttackDelay(playerId: string, delayTicks: number): void {
    const typedPlayerId = createEntityID(playerId);
    const currentNext = this.nextAttackTicks.get(typedPlayerId);

    if (currentNext !== undefined) {
      // Add delay to existing cooldown (mutate in place, no allocation)
      this.nextAttackTicks.set(typedPlayerId, currentNext + delayTicks);

      // Also update CombatData if active (keeps state consistent)
      const combatData = this.stateService.getCombatData(typedPlayerId);
      if (combatData) {
        combatData.nextAttackTick += delayTicks;
      }
    }
    // If no current cooldown, do nothing (rules-accurate: no delay if weapon ready)
  }

  public forceEndCombat(
    entityId: string,
    options?: {
      skipAttackerEmoteReset?: boolean;
      skipTargetEmoteReset?: boolean;
    },
  ): void {
    this.endCombat({
      entityId,
      skipAttackerEmoteReset: options?.skipAttackerEmoteReset,
      skipTargetEmoteReset: options?.skipTargetEmoteReset,
    });
  }

  /** Keep a frozen loadout switch from cancelling an attack already in flight. */
  public hasActiveProjectilesBetween(
    entityAId: string,
    entityBId: string,
  ): boolean {
    return this.projectileService.hasActiveProjectilesBetween(
      entityAId,
      entityBId,
    );
  }

  /**
   * Stop both exact opponents from launching another auto-attack while a
   * frozen loadout switch waits for already-paid projectiles to resolve.
   * Existing projectiles and their damage/cost custody are deliberately left
   * untouched. Combat teardown releases the quiescence for both entities.
   */
  public quiesceAutoAttacksBetween(
    entityAId: string,
    entityBId: string,
  ): boolean {
    if (!entityAId || !entityBId || entityAId === entityBId) return false;
    const entityA = createEntityID(entityAId);
    const entityB = createEntityID(entityBId);
    const stateA = this.stateService.getCombatData(entityA);
    const stateB = this.stateService.getCombatData(entityB);
    const exactPair =
      (stateA?.inCombat === true && String(stateA.targetId) === entityBId) ||
      (stateB?.inCombat === true && String(stateB.targetId) === entityAId);
    if (!exactPair) return false;
    this.autoAttackQuiescedEntities.add(entityA);
    this.autoAttackQuiescedEntities.add(entityB);
    return true;
  }

  /**
   * Fence all new combat admission involving one selected contestant before
   * ordinary combat is torn down for private duel preparation. Re-delivery of
   * the same preparation is idempotent; a different live preparation cannot
   * replace the owner silently.
   */
  public beginDuelPreparationCombatFence(
    entityId: string,
    preparationId: string,
  ): boolean {
    if (!entityId || !preparationId) return false;
    if (!this.entityIdValidator.isValid(entityId)) return false;
    const typedEntityId = createEntityID(entityId);
    const current = this.duelPreparationCombatFences.get(typedEntityId);
    if (current && current !== preparationId) return false;
    this.duelPreparationCombatFences.set(typedEntityId, preparationId);
    return true;
  }

  /** Release only the exact preparation that acquired this combat boundary. */
  public endDuelPreparationCombatFence(
    entityId: string,
    preparationId: string,
  ): boolean {
    if (!entityId || !preparationId) return false;
    if (!this.entityIdValidator.isValid(entityId)) return false;
    const typedEntityId = createEntityID(entityId);
    if (this.duelPreparationCombatFences.get(typedEntityId) !== preparationId) {
      return false;
    }
    this.duelPreparationCombatFences.delete(typedEntityId);
    return true;
  }

  private isDuelPreparationCombatFenced(entityId: string): boolean {
    if (!this.entityIdValidator.isValid(entityId)) return false;
    return this.duelPreparationCombatFences.has(createEntityID(entityId));
  }

  /** Protected operations telemetry reconciles every accepted launch terminal. */
  public getProjectileLifecycleDiagnostics(): ProjectileLifecycleDiagnostics {
    return this.projectileService.getLifecycleDiagnostics();
  }

  /**
   * Wait for every projectile admission/refund/spend receipt that was already
   * authorized. The loop is intentional: an admission fenced by forceEndCombat
   * can enqueue its compensating cancellation while the first snapshot waits.
   */
  public async waitForProjectileCustodySettlements(): Promise<void> {
    while (this.pendingProjectileCustodyOperations.size > 0) {
      await Promise.allSettled([...this.pendingProjectileCustodyOperations]);
    }
  }

  private trackProjectileCustodyOperation<T>(
    operation: Promise<T>,
  ): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => {
      this.pendingProjectileCustodyOperations.delete(tracked);
    });
    this.pendingProjectileCustodyOperations.add(tracked);
    return tracked;
  }

  /** Cancel all delayed damage either targeting or originating from an entity. */
  private cancelProjectilesInvolvingEntity(
    entityId: string,
    reason: CombatProjectileCancelledPayload["reason"],
  ): number {
    const onCancelled = (projectile: Readonly<CombatProjectile>) =>
      this.handleProjectileCancellation(projectile, reason);
    return (
      this.projectileService.cancelProjectilesForTarget(entityId, onCancelled) +
      this.projectileService.cancelProjectilesFromAttacker(
        entityId,
        onCancelled,
      )
    );
  }

  private handleProjectileCancellation(
    projectile: Readonly<CombatProjectile>,
    reason: CombatProjectileCancelledPayload["reason"],
  ): void {
    this.emitProjectileCancelled(projectile, reason);
    this.settleProjectileCostWithoutDamage(projectile, true);
  }

  /**
   * A pending cost is refunded; a cost whose launch already committed becomes
   * terminally resolved as spent. This preserves existing combat economics
   * while giving every same-process no-damage terminal durable closure.
   */
  private settleProjectileCostWithoutDamage(
    projectile: Readonly<CombatProjectile>,
    exposeRecovery: boolean,
  ): void {
    const custody = projectile.ammunitionCustody;
    if (custody && this.equipmentSystem) {
      const settlement = this.equipmentSystem
        .cancelArrowProjectileAtomic(custody)
        .then(async (receipt) => {
          if (!receipt.ok) {
            this.logger.error(
              "Projectile ammunition terminal deferred to recovery",
              undefined,
              { projectileId: projectile.id, reason: receipt.reason },
            );
            return;
          }
          if (
            exposeRecovery &&
            (receipt.status === "fired" || receipt.status === "resolved") &&
            receipt.recoverySource
          ) {
            await this.exposeAmmunitionRecovery(
              projectile.id,
              receipt.recoverySource,
            );
          }
        })
        .catch((error) => {
          this.logger.error(
            "Projectile ammunition terminal failed",
            error instanceof Error ? error : undefined,
            { projectileId: projectile.id },
          );
        });
      void this.trackProjectileCustodyOperation(settlement);
    }
    const runeCustody = projectile.runeCustody;
    if (runeCustody && this.inventorySystem) {
      const settlement = this.inventorySystem
        .cancelProjectileRuneCostAtomic(runeCustody)
        .then((receipt) => {
          if (!receipt.ok) {
            this.logger.error(
              "Projectile rune terminal deferred to recovery",
              undefined,
              { projectileId: projectile.id, reason: receipt.reason },
            );
          }
        })
        .catch((error) => {
          this.logger.error(
            "Projectile rune terminal failed",
            error instanceof Error ? error : undefined,
            { projectileId: projectile.id },
          );
        });
      void this.trackProjectileCustodyOperation(settlement);
    }
  }

  private async exposeAmmunitionRecovery(
    projectileId: string,
    recovery: GroundItemSourceRegistrationReceipt,
  ): Promise<void> {
    const groundItems = this.groundItemSystem;
    if (!groundItems) {
      this.logger.error(
        "Committed ammunition recovery lacks presentation authority",
        new Error("ammunition_recovery_presentation_unavailable"),
        { projectileId, sourceId: recovery.sourceId },
      );
      return;
    }
    try {
      const exposed = await groundItems.exposeCommittedDurableSource(recovery);
      if (!exposed) {
        this.logger.error(
          "Committed ammunition recovery presentation deferred",
          undefined,
          { projectileId, sourceId: recovery.sourceId },
        );
      }
    } catch (error) {
      this.logger.error(
        "Committed ammunition recovery presentation failed",
        error instanceof Error ? error : undefined,
        { projectileId, sourceId: recovery.sourceId },
      );
    }
  }

  private captureAttackCommitEpoch(
    attackerId: string,
    targetId: string,
  ): readonly [number, number] {
    for (const entityId of new Set([attackerId, targetId])) {
      this.attackCommitReferences.set(
        entityId,
        (this.attackCommitReferences.get(entityId) ?? 0) + 1,
      );
      if (!this.attackCommitEpochs.has(entityId)) {
        this.attackCommitEpochs.set(entityId, 0);
      }
    }
    return [
      this.attackCommitEpochs.get(attackerId) ?? 0,
      this.attackCommitEpochs.get(targetId) ?? 0,
    ];
  }

  private isAttackCommitEpochCurrent(
    attackerId: string,
    targetId: string,
    captured: readonly [number, number],
  ): boolean {
    const currentCombat = this.stateService.getCombatData(attackerId);
    return (
      (this.attackCommitEpochs.get(attackerId) ?? 0) === captured[0] &&
      (this.attackCommitEpochs.get(targetId) ?? 0) === captured[1] &&
      (!currentCombat || String(currentCombat.targetId) === targetId)
    );
  }

  private invalidateAttackCommitEpoch(entityId: string): void {
    if (!this.attackCommitReferences.has(entityId)) return;
    this.attackCommitEpochs.set(
      entityId,
      (this.attackCommitEpochs.get(entityId) ?? 0) + 1,
    );
  }

  private releaseAttackCommitEpoch(attackerId: string, targetId: string): void {
    for (const entityId of new Set([attackerId, targetId])) {
      const remaining = (this.attackCommitReferences.get(entityId) ?? 0) - 1;
      if (remaining > 0) {
        this.attackCommitReferences.set(entityId, remaining);
      } else {
        this.attackCommitReferences.delete(entityId);
        this.attackCommitEpochs.delete(entityId);
      }
    }
  }

  private restoreClaimedProjectileCooldown(
    attackerId: EntityID,
    claimedNextAttackTick: number,
    previousNextAttackTick: number | undefined,
  ): void {
    if (this.nextAttackTicks.get(attackerId) !== claimedNextAttackTick) return;
    if (previousNextAttackTick === undefined) {
      this.nextAttackTicks.delete(attackerId);
    } else {
      this.nextAttackTicks.set(attackerId, previousNextAttackTick);
    }
  }

  /**
   * Check if a player can logout based on combat state
   * rules-accurate: Cannot logout while actively in combat
   * Uses the combat timeout window to determine if player is in active combat
   *
   * @param playerId - The player's entity ID
   * @param currentTick - The current game tick
   * @returns Object with allowed boolean and optional reason string
   */
  public canLogout(
    playerId: string,
    currentTick: number,
  ): { allowed: boolean; reason?: string } {
    const combatData = this.stateService.getCombatData(playerId);

    // Player is in active combat if:
    // 1. They have combat data with inCombat flag
    // 2. Current tick is before their combat end tick
    if (combatData?.inCombat && currentTick < combatData.combatEndTick) {
      return {
        allowed: false,
        reason: "Cannot logout during combat",
      };
    }

    return { allowed: true };
  }

  /**
   * Update the last input tick for a player
   * Called by PlayerSystem when player performs any action
   * classic MMORPG: Auto-retaliate disabled after 20 minutes of no input
   *
   * @param playerId - The player's entity ID
   * @param currentTick - The current game tick
   */
  public updatePlayerInput(playerId: string, currentTick: number): void {
    this.lastInputTick.set(playerId, currentTick);
  }

  /**
   * Check if a player has been AFK too long (20 minutes)
   * rules-accurate: Auto-retaliate disabled after 2000 ticks of no input
   *
   * @param playerId - The player's entity ID
   * @param currentTick - The current game tick
   * @returns true if player has been AFK too long
   */
  public isAFKTooLong(playerId: string, currentTick: number): boolean {
    const lastInput = this.lastInputTick.get(playerId) ?? currentTick;
    return (
      currentTick - lastInput >= COMBAT_CONSTANTS.AFK_DISABLE_RETALIATE_TICKS
    );
  }

  /**
   * Clean up all combat state for a disconnecting player
   * Called when a player disconnects to prevent orphaned combat states
   * and allow mobs to immediately retarget other players
   */
  public cleanupPlayerDisconnect(playerId: string): void {
    const typedPlayerId = createEntityID(playerId);

    this.autoAttackQuiescedEntities.delete(typedPlayerId);
    this.duelPreparationCombatFences.delete(typedPlayerId);

    // Remove player's own combat state
    this.stateService.removeCombatState(typedPlayerId);

    // Clear player's attack cooldowns
    this.nextAttackTicks.delete(typedPlayerId);

    // Clear any scheduled emote resets
    this.animationManager.cancelEmoteReset(playerId);

    // Clear player's equipment stats cache
    this.playerEquipmentStats.delete(playerId);

    this.antiCheat.cleanup(playerId);
    this.rateLimiter.cleanup(playerId);
    this.lastInputTick.delete(playerId);

    // Clear combat follow tracking
    this.lastCombatTargetTile.delete(playerId);

    // Cancel any in-flight projectiles targeting or from this player
    this.cancelProjectilesInvolvingEntity(playerId, "player_disconnected");

    // Find all entities that were targeting this disconnected player
    const combatStatesMap = this.stateService.getCombatStatesMap();
    for (const [attackerId, state] of combatStatesMap) {
      if (String(state.targetId) === playerId) {
        this.autoAttackQuiescedEntities.delete(attackerId);
        // Clear the attacker's cooldown so they can immediately retarget
        this.nextAttackTicks.delete(attackerId);

        // If attacker is a mob, reset its internal combat state
        if (state.attackerType === "mob") {
          const mobEntity = this.world.entities.get(String(attackerId));
          if (
            isMobEntity(mobEntity) &&
            typeof mobEntity.onTargetDied === "function"
          ) {
            // Reuse the same method - disconnect is similar to death
            mobEntity.onTargetDied(playerId);
          }
        }

        // Remove the attacker's combat state (don't let them keep attacking empty air)
        this.stateService.removeCombatState(attackerId);

        // Clear combat state from entity if it's a player
        if (state.attackerType === "player") {
          this.stateService.clearCombatStateFromEntity(
            String(attackerId),
            "player",
          );
        }
      }
    }
  }

  // Combat update loop - DEPRECATED: Combat logic now handled by processCombatTick() via TickSystem
  // This method is kept for compatibility but does nothing - all combat runs through tick system
  update(_dt: number): void {
    // Combat logic moved to processCombatTick() for rules-accurate tick-based timing
    // This is called by TickSystem at TickPriority.COMBAT
  }

  // Track when PID order needs re-sorting (optimization)
  private _pidSortDirty = true;
  private _lastSortedCombatCount = 0;

  /**
   * Process combat on each server tick (rules-accurate)
   * Called by TickSystem at COMBAT priority (after movement, before AI)
   */
  public processCombatTick(tickNumber: number): void {
    // Update PIDs - returns true if shuffle happened
    const pidShuffled = this.pidManager.update(tickNumber);
    if (pidShuffled) {
      this._pidSortDirty = true;
    }

    // Process projectile hits (ranged/magic delayed damage)
    this.processProjectileHits(tickNumber);

    // Process scheduled emote resets (tick-aligned animation timing)
    // Delegated to AnimationManager for better separation of concerns
    this.animationManager.processEmoteResets(tickNumber);

    // Get all combat states via StateService (returns reusable buffer to avoid allocations)
    const combatStates = this.stateService.getAllCombatStates();
    const combatStatesMap = this.stateService.getCombatStatesMap();

    // OPTIMIZED: Only sort when needed
    // - Skip if <= 1 combatants (nothing to sort)
    // - Mark dirty when PIDs shuffle or combatant count changes
    const combatCount = combatStates.length;
    if (combatCount !== this._lastSortedCombatCount) {
      this._pidSortDirty = true;
      this._lastSortedCombatCount = combatCount;
    }

    if (combatCount > 1 && this._pidSortDirty) {
      // Lower PID attacks first when multiple attacks on same tick
      combatStates.sort((a, b) => this.pidManager.comparePriority(a[0], b[0]));
      this._pidSortDirty = false;
    }

    // PERFORMANCE: Process combat with frame budget awareness
    // Combat ticks are critical gameplay - always process, but track budget
    const frameBudget = this.world.frameBudget;
    let processed = 0;

    for (const [entityId, combatState] of combatStates) {
      // Check frame budget every 20 combatants (combat is time-critical, be lenient)
      if (processed > 0 && processed % 20 === 0) {
        if (frameBudget && !frameBudget.hasTimeRemaining(1)) {
          // Over budget - log warning but don't skip combat (would break gameplay)
          // This is a signal to optimize elsewhere
          console.warn(
            `[CombatSystem] Frame budget exhausted with ${combatStates.length - processed} combats remaining`,
          );
          // Continue processing - combat must complete for fairness
        }
      }

      if (!combatStatesMap.has(entityId)) {
        continue;
      }

      // Check for combat timeout (8 ticks after last hit)
      if (combatState.inCombat && tickNumber >= combatState.combatEndTick) {
        const entityIdStr = String(entityId);
        this.endCombat({ entityId: entityIdStr });
        processed++;
        continue;
      }

      if (!combatState.inCombat || !combatState.targetId) continue;

      // classic MMORPG-style: Check range EVERY tick and follow if needed (not just on attack ticks)
      // In classic MMORPG, you continuously pursue your target while in combat
      if (combatState.attackerType === "player") {
        this.checkRangeAndFollow(combatState, tickNumber);
      }

      if (
        tickNumber >= combatState.nextAttackTick &&
        !this.autoAttackQuiescedEntities.has(entityId)
      ) {
        void this.processAutoAttackOnTick(combatState, tickNumber).catch(
          (error) => {
            this.logger.error(
              "processAutoAttackOnTick failed",
              error instanceof Error ? error : undefined,
              { entityId: String(entityId), tickNumber },
            );
          },
        );
      }

      processed++;
    }
  }

  /**
   * Process combat for a specific NPC on this tick
   *
   * RULES-ACCURATE: Called by GameTickProcessor during NPC phase
   * NPCs process BEFORE players, creating the damage asymmetry:
   * - NPC → Player damage: Applied same tick
   * - Player → NPC damage: Applied next tick
   *
   * @param mobId - The NPC entity ID to process
   * @param tickNumber - Current tick number
   */
  public processNPCCombatTick(mobId: string, tickNumber: number): void {
    const combatState = this.stateService.getCombatData(mobId);

    if (!combatState) return;

    // Check for combat timeout (8 ticks after last hit)
    if (combatState.inCombat && tickNumber >= combatState.combatEndTick) {
      this.endCombat({ entityId: mobId });
      return;
    }

    if (!combatState.inCombat || !combatState.targetId) return;

    // Only process mob attackers (not mobs being attacked)
    if (combatState.attackerType !== "mob") return;

    // Process emote resets for this mob
    this.animationManager.processEntityEmoteReset(mobId, tickNumber);

    if (
      tickNumber >= combatState.nextAttackTick &&
      !this.autoAttackQuiescedEntities.has(createEntityID(mobId))
    ) {
      void this.processAutoAttackOnTick(combatState, tickNumber).catch(
        (error) => {
          this.logger.error(
            "NPC processAutoAttackOnTick failed",
            error instanceof Error ? error : undefined,
            { mobId, tickNumber },
          );
        },
      );
    }
  }

  /**
   * Process combat for a specific player on this tick
   *
   * RULES-ACCURATE: Called by GameTickProcessor during Player phase
   * Players process AFTER NPCs, creating the damage asymmetry:
   * - Player → NPC damage: Applied next tick (queued by GameTickProcessor)
   * - NPC → Player damage: Applied same tick
   *
   * @param playerId - The player entity ID to process
   * @param tickNumber - Current tick number
   */
  public processPlayerCombatTick(playerId: string, tickNumber: number): void {
    const combatState = this.stateService.getCombatData(playerId);

    if (!combatState) return;

    // Check for combat timeout (8 ticks after last hit)
    if (combatState.inCombat && tickNumber >= combatState.combatEndTick) {
      this.endCombat({ entityId: playerId });
      return;
    }

    if (!combatState.inCombat || !combatState.targetId) return;

    // Only process player attackers (not players being attacked)
    if (combatState.attackerType !== "player") return;

    // RULES-ACCURATE: No movement suppression needed
    // If player has combat state, they're either:
    // 1. Standing still fighting
    // 2. Combat following (chasing their target)
    // In both cases, attacks should happen when in range and cooldown ready
    // Wiki: "follow and attack while chasing it"
    // The disengage event handles the "escape" case by clearing combat state

    // Process emote resets for this player
    this.animationManager.processEntityEmoteReset(playerId, tickNumber);

    // classic MMORPG-style: Check range EVERY tick and follow if needed
    this.checkRangeAndFollow(combatState, tickNumber);

    if (
      tickNumber >= combatState.nextAttackTick &&
      !this.autoAttackQuiescedEntities.has(createEntityID(playerId))
    ) {
      void this.processAutoAttackOnTick(combatState, tickNumber).catch(
        (error) => {
          this.logger.error(
            "Player processAutoAttackOnTick failed",
            error instanceof Error ? error : undefined,
            { playerId, tickNumber },
          );
        },
      );
    }
  }

  /**
   * classic MMORPG-style: Check if player is in range of target, emit follow event if not
   * Called EVERY tick to ensure continuous pursuit of moving targets
   *
   * CRITICAL: This method must NOT extend combat timeout for invalid targets.
   * Invalid targets include: dead entities, entities that no longer exist,
   * or (for PvP) targets that are now in a safe zone.
   */
  private checkRangeAndFollow(
    combatState: CombatData,
    tickNumber: number,
  ): void {
    const attackerId = String(combatState.attackerId);
    const targetId = String(combatState.targetId);

    // RULES-ACCURATE: No movement suppression for following
    // If player has combat state, they should continuously pursue their target
    // Wiki: "follow and attack while chasing it"
    // Movement during combat follow is normal - player is chasing their target

    const attacker = this.entityResolver.resolve(
      attackerId,
      combatState.attackerType,
    );
    const target = this.entityResolver.resolve(
      targetId,
      combatState.targetType,
    );

    // Don't process if either entity is missing - let combat timeout naturally
    if (!attacker || !target) return;

    // Don't extend combat for dead attackers - their state should be cleaned up
    if (!this.entityResolver.isAlive(attacker, combatState.attackerType)) {
      return;
    }

    // Don't follow dead targets - let combat timeout naturally
    // This prevents player getting stuck after killing a mob
    if (!this.entityResolver.isAlive(target, combatState.targetType)) {
      return;
    }

    // PvP zone check: Don't extend combat if we're no longer in a PvP zone
    // This prevents combat from persisting after respawning in safe zone
    // Bypass for streaming duel agents (consistent with enterCombat)
    if (
      combatState.attackerType === "player" &&
      combatState.targetType === "player"
    ) {
      const attackerInStreamingDuel =
        (attacker as { data?: { inStreamingDuel?: boolean } })?.data
          ?.inStreamingDuel === true;
      const targetInStreamingDuel =
        (target as { data?: { inStreamingDuel?: boolean } })?.data
          ?.inStreamingDuel === true;

      if (!attackerInStreamingDuel && !targetInStreamingDuel) {
        // OPTIMIZATION: Use cached zoneDetectionSystem
        if (this.zoneDetectionSystem) {
          const attackerPos = getEntityPosition(attacker);
          if (
            attackerPos &&
            !this.zoneDetectionSystem.isPvPEnabled({
              x: attackerPos.x,
              z: attackerPos.z,
            })
          ) {
            // Attacker is in safe zone - end combat instead of extending
            return; // Don't extend timeout - let combat expire
          }
        }
      }
    }

    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return;

    // Use pre-allocated pooled tiles (zero GC)
    tilePool.setFromPosition(this._attackerTile, attackerPos);
    tilePool.setFromPosition(this._targetTile, targetPos);
    const combatRangeTiles = this.entityResolver.getCombatRange(
      attacker,
      combatState.attackerType,
    );

    // Get attack type for proper range checking (players may use ranged/magic)
    const attackType =
      combatState.attackerType === "player"
        ? this.getAttackTypeFromWeapon(attackerId)
        : AttackType.MELEE;

    // rules-accurate range check:
    // - MELEE: Cardinal-only for range 1 (using tilesWithinMeleeRange)
    // - RANGED/MAGIC: Chebyshev distance (can attack diagonally)
    const inRange =
      attackType === AttackType.MELEE
        ? tilesWithinMeleeRange(
            this._attackerTile,
            this._targetTile,
            combatRangeTiles,
          )
        : tilesWithinRange(
            this._attackerTile,
            this._targetTile,
            combatRangeTiles,
          );

    // rules-accurate: Continuously follow the target while in combat.
    // In classic MMORPG, the player follows the target every tick — not just when out of range.
    // movePlayerToward() already returns early if already in range, so this is safe.
    // This prevents the stutter pattern where the player stands still until the target
    // leaves range, then chases, then stops again.
    const lastKnown = this.lastCombatTargetTile.get(attackerId);
    const targetMoved =
      !lastKnown ||
      lastKnown.x !== this._targetTile.x ||
      lastKnown.z !== this._targetTile.z;

    if (targetMoved) {
      // Update last known target tile (reuse object to avoid allocation)
      if (lastKnown) {
        lastKnown.x = this._targetTile.x;
        lastKnown.z = this._targetTile.z;
      } else {
        this.lastCombatTargetTile.set(attackerId, {
          x: this._targetTile.x,
          z: this._targetTile.z,
        });
      }
    }

    if (!inRange) {
      // Out of range - follow the target and extend combat timeout while pursuing
      combatState.combatEndTick =
        tickNumber + COMBAT_CONSTANTS.COMBAT_TIMEOUT_TICKS;

      this.emitFollowTarget(
        attackerId,
        targetId,
        targetPos,
        combatRangeTiles,
        attackType,
      );
    } else if (targetMoved) {
      // In range but target moved — pre-compute the follow path now.
      // movePlayerToward() updates the player's path destination even when
      // currently in range, so if the target steps out of range next tick
      // the player is already pathing toward them with zero delay.
      this.emitFollowTarget(
        attackerId,
        targetId,
        targetPos,
        combatRangeTiles,
        attackType,
      );
    }
  }

  /**
   * Validate combat actors exist and are alive
   */
  private validateCombatActors(
    combatState: CombatData,
  ): { attacker: Entity | MobEntity; target: Entity | MobEntity } | null {
    const attackerId = String(combatState.attackerId);
    const targetId = String(combatState.targetId);

    const attacker = this.entityResolver.resolve(
      attackerId,
      combatState.attackerType,
    );
    const target = this.entityResolver.resolve(
      targetId,
      combatState.targetType,
    );

    // Let combat time out naturally if entities gone (health bars stay visible)
    if (!attacker || !target) {
      return null;
    }

    if (!this.entityResolver.isAlive(attacker, combatState.attackerType)) {
      return null;
    }

    if (!this.entityResolver.isAlive(target, combatState.targetType)) {
      return null;
    }

    return { attacker, target };
  }

  /**
   * Validate attacker is within melee range of target
   * Uses pooled tiles for zero GC overhead
   * @returns true if within range, false otherwise
   */
  private validateAttackRange(
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    attackerType: "player" | "mob",
  ): boolean {
    const attackerPos = getEntityPosition(attacker);
    const targetPos = getEntityPosition(target);
    if (!attackerPos || !targetPos) return false;

    // MELEE: Must be within attacker's combat range (configurable per mob, minimum 1 tile)
    // classic MMORPG-style: range 1 = cardinal only (N/S/E/W), range 2+ = diagonal allowed
    // Use pre-allocated pooled tiles (zero GC)
    tilePool.setFromPosition(this._attackerTile, attackerPos);
    tilePool.setFromPosition(this._targetTile, targetPos);
    const combatRangeTiles = this.entityResolver.getCombatRange(
      attacker,
      attackerType,
    );

    // rules-accurate melee range check (cardinal-only for range 1)
    return tilesWithinMeleeRange(
      this._attackerTile,
      this._targetTile,
      combatRangeTiles,
    );
  }

  /**
   * Execute the attack: rotation, animation, damage calculation, and application
   * @returns The damage dealt (capped at target's current health)
   */
  private executeAttackDamage(
    attackerId: string,
    targetId: string,
    attacker: Entity | MobEntity,
    target: Entity | MobEntity,
    combatState: CombatData,
    tickNumber: number,
  ): number | null | Promise<number | null> {
    // classic MMORPG-STYLE: Update entity facing to face target
    this.rotationManager.rotateTowardsTarget(
      attackerId,
      targetId,
      combatState.attackerType,
      combatState.targetType,
    );

    // Play attack animation with attack speed for proper animation duration
    this.animationManager.setCombatEmote(
      attackerId,
      combatState.attackerType,
      tickNumber,
      combatState.attackSpeedTicks,
    );

    // Get player's combat style for rules-accurate damage bonuses
    let combatStyle: CombatStyle = "accurate";
    if (combatState.attackerType === "player") {
      const playerSystem = this.world.getSystem(
        "player",
      ) as PlayerSystem | null;
      const styleData = playerSystem?.getPlayerAttackStyle?.(attackerId);
      if (styleData?.id) {
        combatStyle = styleData.id as CombatStyle;
      }
    }

    // MVP: Melee-only damage calculation
    const rawDamage = this.calculateMeleeDamage(attacker, target, combatStyle);

    // classic MMORPG-STYLE: Cap damage at target's current health (no overkill)
    const currentHealth = this.entityResolver.getHealth(target);
    const damage = Math.min(rawDamage, currentHealth);

    // Apply capped damage
    const damageResolution = this.applyDamage(
      targetId,
      combatState.targetType,
      damage,
      attackerId,
    );
    const finish = (damageResult: DamageResolution): number | null => {
      if (!damageResult.success) return null;
      const appliedDamage = damageResult.actualDamage;

      // Emit damage splatter event using pre-allocated payload (zero allocation)
      const targetPosition = getEntityPosition(target);
      this.emitDamageDealt(
        attackerId,
        targetId,
        appliedDamage,
        undefined,
        combatState.targetType,
        targetPosition,
        undefined,
        undefined,
        damageResult.publicActionObservation,
        damageResult.competitiveTerminal,
      );

      this.recordCombatEvent(GameEventType.COMBAT_ATTACK, attackerId, {
        targetId,
        attackerType: combatState.attackerType,
        targetType: combatState.targetType,
        attackSpeedTicks: combatState.attackSpeedTicks,
      });

      if (appliedDamage > 0) {
        this.recordCombatEvent(GameEventType.COMBAT_DAMAGE, attackerId, {
          targetId,
          damage: appliedDamage,
          rawDamage,
          targetHealth: currentHealth,
          targetPosition: targetPosition
            ? { x: targetPosition.x, y: targetPosition.y, z: targetPosition.z }
            : undefined,
        });
      } else {
        this.recordCombatEvent(GameEventType.COMBAT_MISS, attackerId, {
          targetId,
          rawDamage,
        });
      }

      return appliedDamage;
    };
    if (damageResolution instanceof Promise) {
      return damageResolution.then(finish);
    }
    return finish(damageResolution);
  }

  /**
   * Update combat state tick tracking after a successful attack
   */
  private updateCombatTickState(
    combatState: CombatData,
    typedAttackerId: EntityID,
    tickNumber: number,
  ): void {
    combatState.lastAttackTick = tickNumber;
    combatState.nextAttackTick = tickNumber + combatState.attackSpeedTicks;
    combatState.combatEndTick =
      tickNumber + COMBAT_CONSTANTS.COMBAT_TIMEOUT_TICKS;
    this.nextAttackTicks.set(typedAttackerId, combatState.nextAttackTick);
  }

  /**
   * Handle player auto-retaliation when attacked
   * Creates retaliation state if player needs to fight back
   */
  private handlePlayerRetaliation(
    targetId: string,
    attackerId: string,
    typedAttackerId: EntityID,
    attackerType: "player" | "mob",
    tickNumber: number,
  ): void {
    const targetPlayerState = this.stateService.getCombatData(targetId);
    let shouldRetaliate =
      this.playerSystem?.getPlayerAutoRetaliate(targetId) ?? true;

    if (shouldRetaliate && this.isAFKTooLong(targetId, tickNumber)) {
      shouldRetaliate = false;
    }

    // Player needs a new retaliation state if:
    // 1. They have auto-retaliate ON, AND
    // 2. They have no combat state, OR their current target is dead/invalid
    if (!shouldRetaliate) return;

    const needsNewTarget =
      !targetPlayerState ||
      !targetPlayerState.inCombat ||
      !this.entityResolver.isAlive(
        this.entityResolver.resolve(
          String(targetPlayerState.targetId),
          targetPlayerState.targetType,
        ),
        targetPlayerState.targetType,
      );

    if (!needsNewTarget) return;

    // Create retaliation state for player targeting this attacker
    const playerAttackSpeed = this.entityResolver.getAttackSpeed(
      createEntityID(targetId),
      "player",
    );
    const retaliationDelay = calculateRetaliationDelay(playerAttackSpeed);

    this.stateService.createRetaliatorState(
      createEntityID(targetId),
      typedAttackerId,
      "player",
      attackerType,
      tickNumber,
      retaliationDelay,
      playerAttackSpeed,
    );

    // Sync combat state to player entity
    this.stateService.syncCombatStateToEntity(targetId, attackerId, "player");

    // Face the attacker
    this.rotationManager.rotateTowardsTarget(
      targetId,
      attackerId,
      "player",
      attackerType,
    );

    // Clear any server face target since player now has combat target
    this.emitClearFaceTarget(targetId);
  }

  /**
   * Emit combat events for UI feedback
   * NOTE: COMBAT_MELEE_ATTACK is NOT emitted here to avoid duplicate processing.
   * Damage splats are handled by COMBAT_DAMAGE_DEALT which is already emitted
   * by executeAttackDamage() and bridged to clients via EventBridge.
   */
  private emitCombatEvents(
    attackerId: string,
    _targetId: string,
    target: Entity | MobEntity,
    damage: number,
    combatState: CombatData,
  ): void {
    // Emit UI message for player attacks (chat feedback)
    if (combatState.attackerType === "player") {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: attackerId,
        message: `You hit the ${this.entityResolver.getDisplayName(target)} for ${damage} damage!`,
        type: "combat",
      });
    }
  }

  /**
   * Process projectile hits for ranged/magic attacks
   * Applies delayed damage when projectiles reach their targets
   */
  private processProjectileHits(tickNumber: number): void {
    const result = this.projectileService.processTick(tickNumber);

    for (const projectile of result.expired) {
      // A launch must always resolve to a terminal network event. The service
      // hard-stop protects the simulation from an immortal projectile, while
      // this explicit cancellation lets every renderer retire the same ID.
      this.handleProjectileCancellation(projectile, "projectile_expired");
    }

    for (const projectile of result.hits) {
      // Get target entity
      const target =
        this.entityResolver.resolve(
          projectile.targetId,
          "mob", // Could be player or mob, resolver handles this
        ) ?? this.entityResolver.resolve(projectile.targetId, "player");

      if (!target) {
        this.handleProjectileCancellation(projectile, "combat_state_missing");
        continue;
      }

      // Determine target type
      const targetType = isMobEntity(target) ? "mob" : "player";

      // Check if target is still alive
      if (!this.entityResolver.isAlive(target, targetType)) {
        // processTick removes every projectile scheduled for this tick before
        // damage is applied. If an earlier same-tick hit kills the target, any
        // later hit in the batch still needs an exact terminal event so the
        // client can remove its matching visual instead of waiting for expiry.
        this.handleProjectileCancellation(projectile, "entity_died");
        continue;
      }

      // Cap damage at target's current health
      const currentHealth = this.entityResolver.getHealth(target);
      const damage = Math.min(projectile.damage, currentHealth);

      // Apply damage
      const damageResolution = this.applyDamage(
        projectile.targetId,
        targetType,
        damage,
        projectile.attackerId,
        projectile.ammunitionCustody
          ? {
              operationType: "ammunition_shot",
              operationId: projectile.ammunitionCustody.operationId,
              playerId: projectile.ammunitionCustody.playerId,
              requestFingerprint:
                projectile.ammunitionCustody.requestFingerprint,
            }
          : projectile.runeCustody
            ? {
                operationType: "projectile_rune_cost",
                operationId: projectile.runeCustody.operationId,
                playerId: projectile.runeCustody.playerId,
                requestFingerprint: projectile.runeCustody.requestFingerprint,
              }
            : undefined,
      );
      const finish = (damageResult: DamageResolution): void => {
        if (!damageResult.success) return;
        const appliedDamage = damageResult.actualDamage;
        if (appliedDamage === 0) {
          this.settleProjectileCostWithoutDamage(projectile, false);
        }

        // Emit damage and projectile hit events using pre-allocated payloads (zero allocation)
        const targetPosition = getEntityPosition(target);
        this.emitDamageDealt(
          projectile.attackerId,
          projectile.targetId,
          appliedDamage,
          projectile.spellId ? "magic" : "ranged",
          targetType,
          targetPosition,
          undefined,
          projectile.id,
          damageResult.publicActionObservation,
          damageResult.competitiveTerminal,
        );
        this.emitProjectileHit(
          projectile.attackerId,
          projectile.targetId,
          appliedDamage,
          projectile.spellId ? "spell" : "arrow",
          projectile.id,
        );

        if (projectile.ammunitionRecovery) {
          const recovery = projectile.ammunitionRecovery;
          const groundItems = this.groundItemSystem;
          if (!groundItems) {
            this.logger.error(
              "Committed ammunition recovery lacks presentation authority",
              new Error("ammunition_recovery_presentation_unavailable"),
              { projectileId: projectile.id, sourceId: recovery.sourceId },
            );
          } else {
            void groundItems
              .exposeCommittedDurableSource(recovery)
              .then((exposed) => {
                if (!exposed) {
                  this.logger.error(
                    "Committed ammunition recovery presentation deferred",
                    undefined,
                    {
                      projectileId: projectile.id,
                      sourceId: recovery.sourceId,
                    },
                  );
                }
              })
              .catch((error) => {
                this.logger.error(
                  "Committed ammunition recovery presentation failed",
                  error instanceof Error ? error : undefined,
                  { projectileId: projectile.id, sourceId: recovery.sourceId },
                );
              });
          }
        }

        // Record combat event
        this.recordCombatEvent(
          GameEventType.COMBAT_DAMAGE,
          projectile.attackerId,
          {
            targetId: projectile.targetId,
            damage: appliedDamage,
            rawDamage: projectile.damage,
            projectileHit: true,
            attackType: projectile.spellId ? "magic" : "ranged",
          },
        );

        // Handle XP rewards for magic (ranged XP handled elsewhere)
        if (projectile.xpReward && projectile.xpReward > 0) {
          this.emitTypedEvent(EventType.PLAYER_XP_GAINED, {
            playerId: projectile.attackerId,
            skill: "magic",
            xp: projectile.xpReward,
          });
        }
      };
      if (damageResolution instanceof Promise) {
        void damageResolution.then(finish).catch((error) => {
          this.logger.error(
            "Projectile damage resolution failed",
            error instanceof Error ? error : undefined,
            {
              attackerId: projectile.attackerId,
              targetId: projectile.targetId,
            },
          );
        });
      } else {
        finish(damageResolution);
      }
    }
  }

  /**
   * Process auto-attack for a combatant on a specific tick
   */
  private async processAutoAttackOnTick(
    combatState: CombatData,
    tickNumber: number,
  ): Promise<void> {
    const attackerId = String(combatState.attackerId);
    const targetId = String(combatState.targetId);
    const typedAttackerId = combatState.attackerId;

    // Step 1: Validate combat actors exist and are alive
    const actors = this.validateCombatActors(combatState);
    if (!actors) return;
    const { attacker, target } = actors;

    // Step 1.5: Route ranged/magic auto-attacks through projectile handlers.
    // Players derive attack type from equipment; mobs use persisted combat weapon type.
    const attackType =
      combatState.attackerType === "player"
        ? this.getAttackTypeFromWeapon(attackerId)
        : combatState.weaponType;
    if (attackType === AttackType.RANGED || attackType === AttackType.MAGIC) {
      // Handlers handle claiming the cooldown slot synchronously before any async work,
      // so we don't need to pre-claim it here (which would break their internal checks).
      await this.handleAttack({
        attackerId,
        targetId,
        attackerType: combatState.attackerType,
        targetType: combatState.targetType,
        attackType,
      });
      // A successful projectile admission calls enterCombat() and installs a
      // fresh state with the committed launch tick. A rejected attempt (for
      // example, exhausted runes or arrows) must not refresh liveness: doing so
      // makes nextAttackTick remain overdue and retries the failed action every
      // tick forever while preventing normal combat timeout.
      return;
    }

    // Step 2: Validate attack range (melee only from here)
    if (!this.validateAttackRange(attacker, target, combatState.attackerType)) {
      return;
    }

    // Step 3: Execute melee attack (rotation, animation, damage)
    const damageResolution = this.executeAttackDamage(
      attackerId,
      targetId,
      attacker,
      target,
      combatState,
      tickNumber,
    );
    const damage =
      damageResolution instanceof Promise
        ? await damageResolution
        : damageResolution;
    if (damage === null) return;

    // Step 4: Check if combat state still exists (target may have died)
    if (!this.stateService.getCombatStatesMap().has(typedAttackerId)) {
      return;
    }

    // Step 5: Update combat tick state
    this.updateCombatTickState(combatState, typedAttackerId, tickNumber);

    // Step 6: Handle player retaliation if target is a player
    if (combatState.targetType === "player") {
      this.handlePlayerRetaliation(
        targetId,
        attackerId,
        typedAttackerId,
        combatState.attackerType,
        tickNumber,
      );
    }

    // Step 7: Emit combat events
    this.emitCombatEvents(attackerId, targetId, target, damage, combatState);
  }

  /**
   * Build GameStateInfo for event recording
   */
  private buildGameStateInfo(): GameStateInfo {
    const combatStatesMap = this.stateService.getCombatStatesMap();
    return {
      currentTick: this.world.currentTick ?? 0,
      playerCount: this.world.entities.players.size,
      activeCombats: combatStatesMap.size,
    };
  }

  /**
   * Build a full snapshot of combat state for replay
   * Called periodically (every 100 ticks) for efficient replay start points
   */
  private buildCombatSnapshot(): {
    entities: Map<string, EntitySnapshot>;
    combatStates: Map<string, CombatSnapshot>;
    rngState: SeededRandomState;
  } {
    const entities = new Map<string, EntitySnapshot>();
    const combatStates = new Map<string, CombatSnapshot>();

    // Snapshot all active combat participants
    for (const [entityId, state] of this.stateService.getCombatStatesMap()) {
      const attackerEntity = this.entityResolver.resolve(
        String(entityId),
        state.attackerType,
      );
      const targetEntity = this.entityResolver.resolve(
        String(state.targetId),
        state.targetType,
      );

      // Snapshot attacker
      if (attackerEntity) {
        const pos = getEntityPosition(attackerEntity);
        entities.set(String(entityId), {
          id: String(entityId),
          type: state.attackerType,
          position: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
          health: this.entityResolver.getHealth(attackerEntity),
          maxHealth: attackerEntity.getMaxHealth?.() ?? 100,
        });
      }

      // Snapshot target
      if (targetEntity) {
        const pos = getEntityPosition(targetEntity);
        entities.set(String(state.targetId), {
          id: String(state.targetId),
          type: state.targetType,
          position: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
          health: this.entityResolver.getHealth(targetEntity),
          maxHealth: targetEntity.getMaxHealth?.() ?? 100,
        });
      }

      // Snapshot combat state
      combatStates.set(String(entityId), {
        attackerId: String(entityId),
        targetId: String(state.targetId),
        startTick: state.lastAttackTick, // Use lastAttackTick as approximate start
        lastAttackTick: state.lastAttackTick,
      });
    }

    // Get RNG state for deterministic replay
    const rngState = getGameRngState() ?? { state0: "0", state1: "0" };

    return { entities, combatStates, rngState };
  }

  /**
   * Record a combat event to the EventStore
   * Includes RNG state for deterministic replay
   */
  private recordCombatEvent(
    type: GameEventType,
    entityId: string,
    payload: unknown,
  ): void {
    if (!this.eventRecordingEnabled) return;

    const tick = this.world.currentTick ?? 0;
    const stateInfo = this.buildGameStateInfo();

    // Include snapshot data periodically (every 100 ticks)
    const snapshot = tick % 100 === 0 ? this.buildCombatSnapshot() : undefined;

    this.eventStore.record(
      {
        tick,
        type,
        entityId,
        payload: {
          ...((payload as object) ?? {}),
          rngState: getGameRngState(), // Include RNG state for replay
        },
      },
      stateInfo,
      snapshot,
    );
  }

  destroy(): void {
    this.duelDamageReconciliationStopped = true;
    for (const wait of this.duelDamageRetryWaits) {
      clearTimeout(wait.timer);
      wait.resolve(false);
    }
    this.duelDamageRetryWaits.clear();
    this.stateService.destroy();
    this.animationManager.destroy();
    this.antiCheat.destroy();
    this.rateLimiter.destroy();
    this.eventStore.destroy();
    this.projectileService.clear();
    tilePool.release(this._attackerTile);
    tilePool.release(this._targetTile);
    this.nextAttackTicks.clear();
    this.pendingProjectileAttacks.clear();
    this.autoAttackQuiescedEntities.clear();
    this.duelPreparationCombatFences.clear();
    this.duelDamageTailByAttacker.clear();
    this.pendingDuelDamageOperations.clear();
    this.attackCommitReferences.clear();
    this.attackCommitEpochs.clear();
    this.lastCombatTargetTile.clear();
    this.playerEquipmentStats.clear();
    this.lastInputTick.clear();
    super.destroy();
  }

  /**
   * Decay anti-cheat scores and clean stale XP history
   * Call periodically (e.g., every minute) to prevent memory leaks
   */
  public decayAntiCheatScores(): void {
    this.antiCheat.decayScores();
    // Also clean stale XP history to prevent memory leaks from disconnected players
    const currentTick = this.world.currentTick ?? 0;
    this.antiCheat.cleanupStaleXPHistory(currentTick);
  }

  /**
   * Get pool statistics for monitoring dashboard
   * Useful for detecting memory leaks or pool exhaustion
   *
   * @see COMBAT_SYSTEM_IMPROVEMENTS.md Section 3.2
   */
  public getPoolStats(): {
    quaternions: { total: number; available: number; inUse: number };
  } {
    return {
      quaternions: quaternionPool.getStats(),
    };
  }

  /** Privacy-safe aggregate for readiness and operator diagnostics. */
  public getDuelDamageReconciliationStats(): DuelDamageReconciliationStats {
    let queuedOperations = 0;
    let committingOperations = 0;
    let reconcilingOperations = 0;
    let maxReconciliationAttempts = 0;
    let oldestPendingAgeMs = 0;
    let oldestReconciliationAgeMs = 0;
    const now = Date.now();
    for (const pending of this.pendingDuelDamageOperations.values()) {
      if (pending.status === "queued") queuedOperations += 1;
      if (pending.status === "committing") committingOperations += 1;
      if (pending.status === "reconciling") reconcilingOperations += 1;
      maxReconciliationAttempts = Math.max(
        maxReconciliationAttempts,
        pending.reconciliationAttempts,
      );
      oldestPendingAgeMs = Math.max(
        oldestPendingAgeMs,
        Math.max(0, now - pending.startedAt),
      );
      if (pending.reconciliationStartedAt !== null) {
        oldestReconciliationAgeMs = Math.max(
          oldestReconciliationAgeMs,
          Math.max(0, now - pending.reconciliationStartedAt),
        );
      }
    }
    return {
      pendingOperations: this.pendingDuelDamageOperations.size,
      queuedOperations,
      committingOperations,
      reconcilingOperations,
      maxReconciliationAttempts,
      oldestPendingAgeMs,
      oldestReconciliationAgeMs,
    };
  }
}
