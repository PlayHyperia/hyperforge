/**
 * PrayerSystem - Manages player prayer state and mechanics
 *
 * Server-authoritative system that handles all prayer operations:
 * - Activating/deactivating prayers
 * - Prayer point drain mechanics (rules-accurate formula)
 * - Conflict resolution (auto-deactivate conflicting prayers)
 * - Level requirement validation
 * - Combat bonus calculations
 * - Database persistence
 *
 * classic MMORPG Prayer Drain Formula:
 * drain_resistance = 2 * prayer_bonus + 60
 * drain_per_tick = drain_effect / drain_resistance (per 0.6s game tick)
 *
 * @see {@link PrayerDataProvider} for prayer definitions
 * @see {@link SkillsSystem} for prayer XP and leveling
 */

import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../core/World";
import { EventType } from "../../../types/events";
import { Logger } from "../../../utils/Logger";
import {
  createPlayerID,
  isValidPlayerID,
  toPlayerID,
} from "../../../utils/IdentifierUtils";
import type { PlayerID } from "../../../types/core/identifiers";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import type {
  PrayerPersistenceSnapshot,
  PrayerStateCommitRequest,
  PrayerStateCommitReceipt,
  PrayerStateTransitionKind,
} from "../../../types/network/database";
import {
  parseStreamingDuelPrayerObservationContext,
  type StreamingDuelPrayerObservationContext,
} from "../../../types/game/streaming-duel-action-observation";
import { uuid } from "../../../utils/IdGenerator";
import { prayerDataProvider } from "../../../data/PrayerDataProvider";
import type {
  PlayerJoinedPayload,
  QuestCompletionCommittedPayload,
} from "../../../types/events";
import {
  type PrayerState,
  isValidPrayerId,
  MAX_ACTIVE_PRAYERS,
  PRAYER_TOGGLE_COOLDOWN_MS,
  PRAYER_TOGGLE_RATE_LIMIT,
  getPlayerPrayerBonus,
  type PlayerWithPrayerStats,
  type PrayerBonuses,
  // Type guards for validation
  isPlayerRegisteredPayload,
  isPlayerCleanupPayload,
  isPrayerToggleEventPayload,
  isAltarPrayPayload,
  // Bounds checking
  clampPrayerLevel,
  clampPrayerPoints,
  isValidRestoreAmount,
} from "../../../types/game/prayer-types";

/**
 * Mutable prayer bonuses buffer for hot-path calculations
 * (PrayerBonuses from types has readonly properties)
 */
type MutablePrayerBonuses = {
  -readonly [Key in keyof PrayerBonuses]: PrayerBonuses[Key];
};

const PRAYER_BONUS_KEYS = Object.freeze([
  "attackMultiplier",
  "strengthMultiplier",
  "defenseMultiplier",
  "rangedAttackMultiplier",
  "rangedStrengthMultiplier",
  "magicAttackMultiplier",
  "magicDefenseMultiplier",
] as const satisfies readonly (keyof PrayerBonuses)[]);

// ============================================================================
// CONSTANTS
// ============================================================================

/** Game tick duration in ms (classic MMORPG uses 600ms ticks) */
const GAME_TICK_MS = 600;

/** How often to process prayer drain (in ms) */
const DRAIN_INTERVAL_MS = GAME_TICK_MS;

/** Bound database recovery pressure while a player's prayer custody is unhealthy. */
const MAX_PRAYER_RECONCILIATION_DELAY_MS = 30_000;

/** Default starting prayer points */
const DEFAULT_PRAYER_POINTS = 1;

/** Exact persistence scale: one displayed prayer point equals one million units. */
export const PRAYER_POINT_UNITS_PER_POINT = 1_000_000;

// MAX_PRAYER_POINTS imported from prayer-types.ts

/** Base drain resistance constant (classic combat formula) */
const BASE_DRAIN_RESISTANCE = 60;

/** Prayer bonus multiplier for drain resistance (classic combat formula) */
const PRAYER_BONUS_MULTIPLIER = 2;

/**
 * Get display-friendly prayer points (uses ceil so fractional points show as next higher number)
 * This prevents the UI from showing 0 when there's still 0.98 points remaining.
 * Only shows 0 when truly depleted.
 */
function pointsToUnits(points: number, maxPoints: number): number {
  const bounded = clampPrayerPoints(points, maxPoints);
  return Math.min(
    maxPoints * PRAYER_POINT_UNITS_PER_POINT,
    Math.max(0, Math.round(bounded * PRAYER_POINT_UNITS_PER_POINT)),
  );
}

function getDisplayPointsFromUnits(pointUnits: number): number {
  return pointUnits <= 0
    ? 0
    : Math.ceil(pointUnits / PRAYER_POINT_UNITS_PER_POINT);
}

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

function prayerPersistenceFailureReason(
  error: unknown,
): PrayerActionFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("prayer_state_conflict")) return "state_conflict";
  if (
    message.includes("prayer_state_request_invalid") ||
    message.includes("prayer_state_transition_invalid") ||
    message.includes("prayer_state_operation_id_conflict") ||
    message.includes("prayer_state_player_missing")
  ) {
    return "invalid_request";
  }
  if (
    message.includes("prayer_state_database_unavailable") ||
    message.includes("web_crypto_unavailable")
  ) {
    return "atomic_persistence_unavailable";
  }
  return "persistence_failed";
}

function shouldRetryPrayerPersistence(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ![
    "prayer_state_request_invalid",
    "prayer_state_transition_invalid",
    "prayer_state_operation_id_conflict",
    "prayer_state_player_missing",
    "prayer_state_conflict",
  ].some((code) => message.includes(code));
}

interface ParsedActivePrayersResult {
  activePrayers: string[];
  shouldRepair: boolean;
}

export function parsePersistedActivePrayers(
  rawActivePrayers: unknown,
  playerId: string,
): ParsedActivePrayersResult {
  if (rawActivePrayers === null || rawActivePrayers === undefined) {
    return { activePrayers: [], shouldRepair: false };
  }

  let parsed: unknown = rawActivePrayers;
  let shouldRepair = false;

  if (typeof rawActivePrayers === "string") {
    const trimmed = rawActivePrayers.trim();
    if (trimmed.length === 0) {
      return { activePrayers: [], shouldRepair: true };
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch (parseError) {
      Logger.systemError(
        "PrayerSystem",
        `Corrupted activePrayers JSON for ${playerId}`,
        parseError instanceof Error
          ? parseError
          : new Error(String(parseError)),
      );
      return { activePrayers: [], shouldRepair: true };
    }
  }

  if (!Array.isArray(parsed)) {
    Logger.systemWarn(
      "PrayerSystem",
      `Invalid activePrayers data for ${playerId}; expected array`,
    );
    return { activePrayers: [], shouldRepair: true };
  }

  const filtered = parsed.filter(
    (id): id is string => typeof id === "string" && isValidPrayerId(id),
  );

  if (filtered.length !== parsed.length) {
    shouldRepair = true;
  }

  const deduped = Array.from(new Set(filtered));
  if (deduped.length !== filtered.length) {
    shouldRepair = true;
  }

  return { activePrayers: deduped, shouldRepair };
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Per-player prayer state (in-memory)
 */
interface PlayerPrayerState {
  /** Current prayer points in exact fixed-point units. */
  pointUnits: number;
  /** Maximum prayer points (based on prayer level) */
  maxPoints: number;
  /** Currently active prayer IDs */
  active: Set<string>;
  /** Last toggle timestamp for rate limiting */
  lastToggleTime: number;
  /** Toggle count in current rate limit window */
  toggleCount: number;
  /** Rate limit window start time */
  rateLimitWindowStart: number;
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

export interface PrayerCustodyView {
  ready: boolean;
  persistenceHealthy: boolean;
  pointUnits: number;
  points: number;
  maxPoints: number;
  activePrayers: string[];
}

// ============================================================================
// PRAYER SYSTEM
// ============================================================================

/**
 * PrayerSystem - Manages prayer state and mechanics
 *
 * Single Responsibility: Only handles prayer state and operations.
 * Does NOT handle prayer XP/leveling (that's SkillsSystem).
 */
export class PrayerSystem extends SystemBase {
  /** Prayer state per player */
  private playerStates = new Map<PlayerID, PlayerPrayerState>();

  /** Players currently loading from database */
  private loadingPlayers = new Set<string>();

  /** In-flight initialization promises keyed by player id */
  private initializationPromises = new Map<string, Promise<void>>();

  /** Players whose prayer state has been initialized */
  private initializedPlayers = new Set<string>();

  /** Strict prayer transitions execute in order for each player. */
  private transitionTails = new Map<string, Promise<void>>();

  /** Players being removed; they cannot acquire new drain work. */
  private closingPlayers = new Set<string>();

  /** Drain intervals accumulated while one durable transition is pending. */
  private pendingDrainTicks = new Map<string, number>();
  private drainWorkers = new Map<string, Promise<void>>();
  private prayerPersistenceFailures = new Set<string>();
  private prayerReconciliationWorkers = new Map<string, Promise<void>>();
  private prayerReconciliationAttempts = new Map<string, number>();
  private prayerReconciliationNextAt = new Map<string, number>();

  /** Drain processing interval handle */
  private drainInterval?: NodeJS.Timeout;

  // ============================================================================
  // EVENT HANDLERS (stored for cleanup)
  // ============================================================================

  /**
   * Handler for PLAYER_REGISTERED events
   * Validates payload before processing to prevent type-related bugs.
   */
  private readonly onPlayerRegistered = async (
    event: unknown,
  ): Promise<void> => {
    if (!isPlayerRegisteredPayload(event)) {
      Logger.systemError(
        "PrayerSystem",
        "Invalid PLAYER_REGISTERED payload",
        new Error(`Invalid payload: ${JSON.stringify(event)}`),
      );
      return;
    }
    await this.initializePlayerPrayer(event.playerId);
  };

  /**
   * Handler for PLAYER_CLEANUP events
   * Validates payload before processing.
   */
  private readonly onPlayerCleanup = async (event: unknown): Promise<void> => {
    if (!isPlayerCleanupPayload(event)) {
      Logger.systemError(
        "PrayerSystem",
        "Invalid PLAYER_CLEANUP payload",
        new Error(`Invalid payload: ${JSON.stringify(event)}`),
      );
      return;
    }
    await this.cleanupPlayerPrayer(event.playerId);
  };

  /**
   * Handler for PLAYER_LEFT events (disconnect).
   * Persists prayer state and cleans up — PLAYER_CLEANUP is never emitted
   * during disconnect, so this ensures prayer data is saved.
   */
  private readonly onPlayerLeft = async (event: unknown): Promise<void> => {
    const data = event as { playerId?: string };
    if (!data?.playerId) return;
    await this.cleanupPlayerPrayer(data.playerId);
  };

  /**
   * Handler for PLAYER_JOINED events.
   * Re-emits the authoritative prayer snapshot for the new session after join.
   */
  private readonly onPlayerJoined = async (event: unknown): Promise<void> => {
    if (!this.world.isServer) {
      return;
    }

    const payload = event as Partial<PlayerJoinedPayload>;
    if (!payload.playerId || typeof payload.playerId !== "string") {
      Logger.systemError(
        "PrayerSystem",
        "Invalid PLAYER_JOINED payload",
        new Error(`Invalid payload: ${JSON.stringify(event)}`),
      );
      return;
    }

    const state = await this.ensurePlayerPrayerInitialized(payload.playerId);
    if (!state) {
      return;
    }

    this.emitPrayerStateSync(payload.playerId, state);
  };

  /**
   * Handler for PRAYER_TOGGLE events
   * Validates payload including prayer ID format before processing.
   */
  private readonly onPrayerToggle = async (event: unknown): Promise<void> => {
    if (!isPrayerToggleEventPayload(event)) {
      Logger.systemError(
        "PrayerSystem",
        "Invalid PRAYER_TOGGLE payload",
        new Error(`Invalid payload: ${JSON.stringify(event)}`),
      );
      return;
    }
    await this.handlePrayerToggle(event.playerId, event.prayerId);
  };

  /**
   * Handler for ALTAR_PRAY events
   * Validates payload including altar ID before processing.
   */
  private readonly onAltarPray = async (event: unknown): Promise<void> => {
    if (!isAltarPrayPayload(event)) {
      Logger.systemError(
        "PrayerSystem",
        "Invalid ALTAR_PRAY payload",
        new Error(`Invalid payload: ${JSON.stringify(event)}`),
      );
      return;
    }
    await this.ensurePlayerPrayerInitialized(event.playerId);
    await this.handleAltarPray(event.playerId, event.altarId);
  };

  /**
   * Handler for PRAYER_DEACTIVATED events from handlers (deactivate all request)
   * Handles the special "*" prayerId marker for deactivating all prayers.
   */
  private readonly onPrayerDeactivated = async (
    event: unknown,
  ): Promise<void> => {
    if (!event || typeof event !== "object") return;

    const payload = event as {
      playerId?: string;
      prayerId?: string;
      reason?: string;
    };

    // Only handle deactivate-all requests (prayerId === "*")
    // Regular deactivations are handled internally, not via this event
    if (payload.prayerId !== "*") return;

    if (
      !payload.playerId ||
      typeof payload.playerId !== "string" ||
      payload.playerId.length === 0
    ) {
      Logger.systemError(
        "PrayerSystem",
        "Invalid PRAYER_DEACTIVATED payload for deactivate-all",
        new Error(`Invalid payload: ${JSON.stringify(event)}`),
      );
      return;
    }

    await this.ensurePlayerPrayerInitialized(payload.playerId);
    await this.deactivateAllPrayers(
      payload.playerId,
      `prayer-deactivate-all:${uuid()}${uuid()}`,
    );
  };

  /**
   * Reusable object for combined bonuses calculation.
   * WARNING: Do not store references to this buffer - contents change between calls.
   */
  private readonly combinedBonusesBuffer: MutablePrayerBonuses = {
    attackMultiplier: undefined,
    strengthMultiplier: undefined,
    defenseMultiplier: undefined,
    rangedAttackMultiplier: undefined,
    rangedStrengthMultiplier: undefined,
    magicAttackMultiplier: undefined,
    magicDefenseMultiplier: undefined,
  };

  constructor(world: World) {
    super(world, {
      name: "prayer",
      dependencies: {
        required: [],
        optional: ["database", "skills"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Ensure prayer data is loaded
    if (!prayerDataProvider.isReady()) {
      prayerDataProvider.initialize();
    }

    // Subscribe via world.on() for events from handlers/other systems
    // (handlers use world.emit which is EventEmitter3, not $eventBus)
    this.world.on(EventType.PLAYER_REGISTERED, this.onPlayerRegistered);
    this.world.on(EventType.PLAYER_CLEANUP, this.onPlayerCleanup);
    this.world.on(EventType.PLAYER_LEFT, this.onPlayerLeft);
    this.world.on(EventType.PLAYER_JOINED, this.onPlayerJoined);
    this.world.on(EventType.PRAYER_TOGGLE, this.onPrayerToggle);
    this.world.on(EventType.ALTAR_PRAY, this.onAltarPray);
    // Listen for deactivate-all requests (prayerId === "*")
    this.world.on(EventType.PRAYER_DEACTIVATED, this.onPrayerDeactivated);
    this.subscribe<QuestCompletionCommittedPayload>(
      EventType.QUEST_COMPLETION_COMMITTED,
      (data) => {
        void this.reconcileCommittedQuestPrayer(data);
      },
    );

    Logger.system("PrayerSystem", "Initialized");
  }

  /**
   * Re-read the current locked Prayer projection after a quest commits Prayer
   * XP. Reading current database state inside the ordinary Prayer serializer
   * prevents a delayed quest event from overwriting a newer drain or toggle.
   */
  private async reconcileCommittedQuestPrayer(
    data: QuestCompletionCommittedPayload,
  ): Promise<void> {
    const playerId = String(data.playerId ?? "").trim();
    const prayerProgress = Array.isArray(data.progress)
      ? data.progress.find((entry) => entry.skill === "prayer")
      : undefined;
    if (!prayerProgress) return;
    if (
      !playerId ||
      !/^quest-completion:[a-f0-9]{64}$/.test(
        String(data.operationId ?? "").trim(),
      ) ||
      !data.prayer ||
      data.prayer.maxPoints !== prayerProgress.currentLevel
    ) {
      Logger.systemError(
        "PrayerSystem",
        "Refused malformed committed quest Prayer receipt",
      );
      return;
    }
    await this.ensurePlayerPrayerInitialized(playerId);
    const reconciled = await this.runSerializedTransition(playerId, () =>
      this.reconcilePrayerStateFromDatabase(playerId),
    );
    if (reconciled) {
      this.clearPrayerReconciliation(playerId);
      return;
    }
    this.prayerPersistenceFailures.add(playerId);
    this.schedulePrayerReconciliation(playerId);
  }

  /**
   * Start the prayer system - begins durable drain processing on server
   */
  start(): void {
    // Start drain processing on server only
    if (this.world.isServer) {
      this.startDrainProcessing();
      this.backfillExistingPlayers();
      Logger.system("PrayerSystem", "Started durable drain processing");
    }
  }

  // ==========================================================================
  // PLAYER INITIALIZATION
  // ==========================================================================

  /** Initialize the exact persisted prayer snapshot. Server failures are
   * fail-closed: no active prayer is exposed and competitive readiness stays
   * false until a later explicit reload succeeds. */
  private async initializePlayerPrayer(playerId: string): Promise<void> {
    if (!isValidPlayerID(playerId)) {
      Logger.systemError(
        "PrayerSystem",
        `Invalid player ID: "${playerId}"`,
        new Error(`Invalid player ID: "${playerId}"`),
      );
      return;
    }

    // Prevent race conditions during load
    const existingInit = this.initializationPromises.get(playerId);
    if (existingInit) {
      await existingInit;
      return;
    }

    const initPromise = (async () => {
      this.loadingPlayers.add(playerId);
      this.closingPlayers.delete(playerId);

      try {
        const db = this.getDatabase();
        let pointUnits = DEFAULT_PRAYER_POINTS * PRAYER_POINT_UNITS_PER_POINT;
        let maxPoints = DEFAULT_PRAYER_POINTS;
        let activePrayers: string[] = [];
        let persistenceHealthy = !this.world.isServer;
        let repairActivePrayers: string[] | null = null;

        if (this.world.isServer && !db?.commitPrayerStateOperationAsync) {
          pointUnits = 0;
          persistenceHealthy = false;
          Logger.systemError(
            "PrayerSystem",
            `Atomic prayer persistence unavailable for ${playerId}`,
            new Error("Atomic prayer persistence unavailable"),
          );
        } else if (db) {
          try {
            const playerRow = await db.getPlayerAsync(playerId);
            if (playerRow) {
              // The strict DB transition compares prayerMaxPoints, so loading
              // prayerLevel here would create a false in-memory snapshot.
              const rawMaxPoints = (
                playerRow as {
                  prayerMaxPoints?: number;
                  prayerLevel?: number;
                }
              ).prayerMaxPoints;
              const fallbackLevel = (playerRow as { prayerLevel?: number })
                .prayerLevel;
              maxPoints = clampPrayerLevel(rawMaxPoints ?? fallbackLevel ?? 1);

              const rawPointUnits = (playerRow as { prayerPointUnits?: number })
                .prayerPointUnits;
              const rawPoints = (playerRow as { prayerPoints?: number })
                .prayerPoints;
              const loadedPointUnits = Number.isSafeInteger(rawPointUnits)
                ? rawPointUnits!
                : pointsToUnits(rawPoints ?? maxPoints, maxPoints);
              if (
                loadedPointUnits < 0 ||
                loadedPointUnits > maxPoints * PRAYER_POINT_UNITS_PER_POINT
              ) {
                throw new Error("invalid persisted prayer point units");
              }
              pointUnits = loadedPointUnits;

              const rawActivePrayers = (
                playerRow as {
                  activePrayers?: unknown;
                }
              ).activePrayers;
              const parsedActivePrayers = parsePersistedActivePrayers(
                rawActivePrayers,
                playerId,
              );
              if (
                parsedActivePrayers.shouldRepair ||
                parsedActivePrayers.activePrayers.length > MAX_ACTIVE_PRAYERS ||
                (pointUnits === 0 &&
                  parsedActivePrayers.activePrayers.length > 0)
              ) {
                throw new Error("invalid persisted active prayer state");
              }
              activePrayers = [...parsedActivePrayers.activePrayers].sort(
                (left, right) => left.localeCompare(right),
              );
              const knownActivePrayers = prayerDataProvider.hasPrayerManifest()
                ? activePrayers.filter((prayerId) =>
                    Boolean(prayerDataProvider.getPrayer(prayerId)),
                  )
                : activePrayers;
              if (knownActivePrayers.length !== activePrayers.length) {
                repairActivePrayers = knownActivePrayers;
              }
              persistenceHealthy = true;
            } else if (this.world.isServer) {
              pointUnits = 0;
              persistenceHealthy = false;
            }
          } catch (dbError) {
            pointUnits = 0;
            activePrayers = [];
            persistenceHealthy = false;
            Logger.systemError(
              "PrayerSystem",
              `Database error loading prayer state for ${playerId}`,
              dbError instanceof Error ? dbError : new Error(String(dbError)),
            );
          }
        }

        const playerIdKey = createPlayerID(playerId);
        const state: PlayerPrayerState = {
          pointUnits,
          maxPoints,
          active: new Set(activePrayers),
          lastToggleTime: 0,
          toggleCount: 0,
          rateLimitWindowStart: 0,
        };

        this.playerStates.set(playerIdKey, state);
        this.initializedPlayers.add(playerId);
        if (persistenceHealthy) {
          this.prayerPersistenceFailures.delete(playerId);
          this.clearPrayerReconciliation(playerId);
        } else {
          this.prayerPersistenceFailures.add(playerId);
          state.active.clear();
          this.clearPrayerReconciliation(playerId);
          this.schedulePrayerReconciliation(playerId);
        }

        if (persistenceHealthy && repairActivePrayers) {
          const expected = this.snapshotPrayerState(state);
          const committed: PrayerPersistenceSnapshot = {
            ...expected,
            activePrayers: repairActivePrayers,
          };
          const repair = await this.commitPrayerTransition(
            playerId,
            `prayer-repair:${uuid()}${uuid()}`,
            "repair",
            expected,
            committed,
          );
          if (!repair.ok) {
            this.prayerPersistenceFailures.add(playerId);
            state.active.clear();
          }
        }

        // Emit state sync event
        this.emitPrayerStateSync(playerId, state);

        Logger.system(
          "PrayerSystem",
          `Initialized prayer for ${playerId}: ${getDisplayPointsFromUnits(state.pointUnits)}/${state.maxPoints} points, ${state.active.size} active`,
        );
      } finally {
        this.loadingPlayers.delete(playerId);
        this.initializationPromises.delete(playerId);
      }
    })();

    this.initializationPromises.set(playerId, initPromise);
    await initPromise;
  }

  private async ensurePlayerPrayerInitialized(
    playerId: string,
  ): Promise<PlayerPrayerState | undefined> {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) {
      Logger.systemError(
        "PrayerSystem",
        `Cannot initialize prayer for invalid player id: ${playerId}`,
        new Error("Invalid player id"),
      );
      return undefined;
    }

    const existingState = this.playerStates.get(playerIdKey);
    if (existingState) {
      return existingState;
    }

    await this.initializePlayerPrayer(playerId);
    return this.playerStates.get(playerIdKey);
  }

  private backfillExistingPlayers(): void {
    for (const player of this.world.getPlayers()) {
      if (!player?.id) continue;
      if (
        this.initializedPlayers.has(player.id) ||
        this.loadingPlayers.has(player.id)
      ) {
        continue;
      }
      void this.initializePlayerPrayer(player.id);
    }
  }

  /**
   * Cleanup prayer state when player disconnects
   */
  private async cleanupPlayerPrayer(playerId: string): Promise<void> {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return;

    this.closingPlayers.add(playerId);
    this.pendingDrainTicks.delete(playerId);
    const initializing = this.initializationPromises.get(playerId);
    if (initializing) await initializing.catch(() => undefined);
    const worker = this.drainWorkers.get(playerId);
    if (worker) await worker.catch(() => undefined);
    const reconciliation = this.prayerReconciliationWorkers.get(playerId);
    if (reconciliation) await reconciliation.catch(() => undefined);
    const tail = this.transitionTails.get(playerId);
    if (tail) await tail.catch(() => undefined);

    this.playerStates.delete(playerIdKey);
    this.loadingPlayers.delete(playerId);
    this.initializedPlayers.delete(playerId);
    this.initializationPromises.delete(playerId);
    this.transitionTails.delete(playerId);
    this.prayerPersistenceFailures.delete(playerId);
    this.prayerReconciliationAttempts.delete(playerId);
    this.prayerReconciliationNextAt.delete(playerId);
    this.closingPlayers.delete(playerId);
  }

  // ==========================================================================
  // PRAYER TOGGLING
  // ==========================================================================

  /**
   * Handle altar pray request - recharge prayer points to full
   */
  private async handleAltarPray(
    playerId: string,
    _altarId: string,
  ): Promise<void> {
    if (!isValidPlayerID(playerId)) {
      return;
    }

    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return;

    const state = this.playerStates.get(playerIdKey);
    if (!state) {
      Logger.systemError(
        "PrayerSystem",
        `Cannot pray at altar - prayer not initialized for ${playerId}`,
        new Error("Prayer not initialized"),
      );
      return;
    }

    const oldPoints = getDisplayPointsFromUnits(state.pointUnits);
    const maxPoints = state.maxPoints;

    // Check if already at max
    if (oldPoints >= maxPoints) {
      // Use world.emit for EventBridge to route to client
      this.world.emit(EventType.UI_TOAST, {
        playerId,
        message: "Your prayer is already fully recharged.",
        type: "info",
      });
      return;
    }

    const remainingUnits =
      maxPoints * PRAYER_POINT_UNITS_PER_POINT - state.pointUnits;
    const result = await this.restorePrayerPoints(
      playerId,
      remainingUnits / PRAYER_POINT_UNITS_PER_POINT,
      `prayer-altar-restore:${uuid()}${uuid()}`,
    );
    if (!result.success) {
      this.world.emit(EventType.UI_TOAST, {
        playerId,
        message: "Your prayer points could not be recharged.",
        type: "error",
      });
      return;
    }

    // Show success message (use world.emit for EventBridge routing)
    this.world.emit(EventType.UI_TOAST, {
      playerId,
      message: "You recharge your prayer points.",
      type: "success",
    });

    Logger.system(
      "PrayerSystem",
      `${playerId} recharged prayer at altar: ${oldPoints} -> ${maxPoints}`,
    );
  }

  /**
   * Handle prayer toggle request
   */
  private async handlePrayerToggle(
    playerId: string,
    prayerId: string,
  ): Promise<void> {
    const result = await this.executePrayerToggleRequest(
      playerId,
      prayerId,
      `prayer-toggle:${uuid()}${uuid()}`,
    );

    if (!result.success) {
      const errorMessage = result.message || "Cannot toggle prayer";

      // Emit to chat (system message)
      this.world.emit(EventType.UI_MESSAGE, {
        playerId,
        message: errorMessage,
        type: "system",
      });

      // Also emit toast for visual feedback
      this.world.emit(EventType.UI_TOAST, {
        playerId,
        message: errorMessage,
        type: "error",
      });
    }
  }

  /**
   * Execute a validated external Prayer request against initialized custody.
   * Callers receive the exact authoritative receipt and must not infer success
   * from packet submission alone.
   */
  async executePrayerToggleRequest(
    playerId: string,
    prayerId: string,
    operationId = `prayer-toggle:${uuid()}${uuid()}`,
  ): Promise<PrayerActionReceipt> {
    if (!isValidPlayerID(playerId) || !isValidPrayerId(prayerId)) {
      return this.prayerFailure(
        playerId,
        operationId,
        "invalid_request",
        "Invalid prayer request",
      );
    }
    await this.ensurePlayerPrayerInitialized(playerId);
    return this.togglePrayer(playerId, prayerId, operationId);
  }

  /**
   * Toggle a prayer on or off
   *
   * @param playerId - Player toggling the prayer
   * @param prayerId - Prayer to toggle
   * @returns Result with success flag and any deactivated prayers
   */
  async togglePrayer(
    playerId: string,
    prayerId: string,
    operationId = `prayer-toggle:${uuid()}${uuid()}`,
    publicActionObservation?: StreamingDuelPrayerObservationContext,
  ): Promise<PrayerActionReceipt> {
    if (!isValidPrayerId(prayerId)) {
      return this.prayerFailure(
        playerId,
        operationId,
        "invalid_request",
        "Invalid prayer",
      );
    }
    const parsedPublicActionObservation =
      publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelPrayerObservationContext(publicActionObservation);
    if (
      publicActionObservation !== undefined &&
      (!parsedPublicActionObservation ||
        parsedPublicActionObservation.actorId !== playerId ||
        parsedPublicActionObservation.prayer !== prayerId)
    ) {
      return this.prayerFailure(
        playerId,
        operationId,
        "invalid_request",
        "Invalid duel prayer observation",
      );
    }

    return this.runSerializedTransition(playerId, async () => {
      const playerIdKey = toPlayerID(playerId);
      const state = playerIdKey
        ? this.playerStates.get(playerIdKey)
        : undefined;
      if (!state) {
        return this.prayerFailure(
          playerId,
          operationId,
          "player_not_initialized",
          "Prayer not initialized",
        );
      }
      if (!this.isPrayerPersistenceHealthy(playerId)) {
        return this.prayerFailure(
          playerId,
          operationId,
          "persistence_failed",
          "Prayer persistence is not ready",
        );
      }

      const now = Date.now();
      if (!this.canTogglePrayer(state, now)) {
        return this.prayerFailure(
          playerId,
          operationId,
          "rate_limited",
          "Too many prayer toggles",
        );
      }

      const prayer = prayerDataProvider.getPrayer(prayerId);
      if (!prayer) {
        return this.prayerFailure(
          playerId,
          operationId,
          "unknown_prayer",
          "Unknown prayer",
        );
      }

      const expected = this.snapshotPrayerState(state);
      const nextActive = new Set(expected.activePrayers);
      const wasActive = nextActive.has(prayerId);
      if (wasActive) {
        nextActive.delete(prayerId);
      } else {
        // PrayerSystem's persisted max-points custody is the authoritative
        // prayer level. Database progression commits keep prayerMaxPoints and
        // prayerLevel equal atomically; entity projections may be absent or
        // stale during streamed duel role switches.
        const prayerLevel = state.maxPoints;
        if (prayerLevel < prayer.level) {
          return this.prayerFailure(
            playerId,
            operationId,
            "level_requirement",
            `Requires prayer level ${prayer.level}`,
          );
        }
        if (state.pointUnits <= 0) {
          return this.prayerFailure(
            playerId,
            operationId,
            "no_prayer_points",
            "No prayer points remaining",
          );
        }
        const conflicts = prayerDataProvider.getConflictsWithActive(prayer.id, [
          ...nextActive,
        ]);
        for (const conflictId of conflicts) nextActive.delete(conflictId);
        if (nextActive.size >= MAX_ACTIVE_PRAYERS) {
          return this.prayerFailure(
            playerId,
            operationId,
            "too_many_active",
            `Cannot have more than ${MAX_ACTIVE_PRAYERS} prayers active`,
          );
        }
        nextActive.add(prayer.id);
      }

      const committed: PrayerPersistenceSnapshot = {
        ...expected,
        activePrayers: [...nextActive].sort((left, right) =>
          left.localeCompare(right),
        ),
      };
      const transition = await this.commitPrayerTransition(
        playerId,
        operationId,
        "toggle",
        expected,
        committed,
        parsedPublicActionObservation ?? undefined,
      );
      if (!transition.ok) {
        return this.prayerFailure(
          playerId,
          operationId,
          transition.reason,
          "Prayer change could not be committed",
        );
      }
      this.recordPrayerToggle(state, now);

      const current = state;
      const activeNow = new Set(current.active);
      for (const previousId of expected.activePrayers) {
        if (activeNow.has(previousId)) continue;
        this.world.emit(EventType.PRAYER_DEACTIVATED, {
          playerId,
          prayerId: previousId,
          reason: previousId === prayerId ? "toggle" : "conflict",
        });
        this.world.emit(EventType.PRAYER_TOGGLED, {
          playerId,
          prayerId: previousId,
          active: false,
          points: getDisplayPointsFromUnits(current.pointUnits),
        });
      }
      for (const activeId of current.active) {
        if (expected.activePrayers.includes(activeId)) continue;
        this.world.emit(EventType.PRAYER_TOGGLED, {
          playerId,
          prayerId: activeId,
          active: true,
          points: getDisplayPointsFromUnits(current.pointUnits),
        });
      }
      this.emitPrayerStateSync(playerId, current);
      return this.prayerSuccess(
        playerId,
        operationId,
        transition.receipt.replayed,
      );
    });
  }

  private prayerFailure(
    playerId: string,
    operationId: string,
    reason: PrayerActionFailureReason,
    message: string,
  ): PrayerActionReceipt {
    const state = this.playerStates.get(toPlayerID(playerId) as PlayerID);
    return {
      success: false,
      committed: false,
      playerId: String(playerId ?? "").trim(),
      operationId: String(operationId ?? "").trim(),
      replayed: false,
      pointUnits: state?.pointUnits ?? 0,
      points: getDisplayPointsFromUnits(state?.pointUnits ?? 0),
      maxPoints: state?.maxPoints ?? 1,
      activePrayers: state ? [...state.active] : [],
      reason,
      message,
    };
  }

  private prayerSuccess(
    playerId: string,
    operationId: string,
    replayed: boolean,
  ): PrayerActionReceipt {
    const playerIdKey = toPlayerID(playerId);
    const state = playerIdKey ? this.playerStates.get(playerIdKey) : undefined;
    return {
      success: true,
      committed: true,
      playerId,
      operationId,
      replayed,
      pointUnits: state?.pointUnits ?? 0,
      points: getDisplayPointsFromUnits(state?.pointUnits ?? 0),
      maxPoints: state?.maxPoints ?? 1,
      activePrayers: state ? [...state.active] : [],
    };
  }

  private snapshotPrayerState(
    state: PlayerPrayerState,
  ): PrayerPersistenceSnapshot {
    return {
      pointUnits: state.pointUnits,
      maxPoints: state.maxPoints,
      activePrayers: [...state.active].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  }

  private applyPrayerSnapshot(
    state: PlayerPrayerState,
    snapshot: PrayerPersistenceSnapshot,
  ): boolean {
    if (
      !Number.isSafeInteger(snapshot.pointUnits) ||
      snapshot.pointUnits < 0 ||
      !Number.isSafeInteger(snapshot.maxPoints) ||
      snapshot.maxPoints < 1 ||
      snapshot.maxPoints > 99 ||
      snapshot.pointUnits > snapshot.maxPoints * PRAYER_POINT_UNITS_PER_POINT ||
      !Array.isArray(snapshot.activePrayers) ||
      snapshot.activePrayers.length > MAX_ACTIVE_PRAYERS ||
      snapshot.activePrayers.some((id) => !isValidPrayerId(id)) ||
      new Set(snapshot.activePrayers).size !== snapshot.activePrayers.length ||
      (snapshot.pointUnits === 0 && snapshot.activePrayers.length > 0)
    ) {
      return false;
    }
    state.pointUnits = snapshot.pointUnits;
    state.maxPoints = snapshot.maxPoints;
    state.active = new Set(snapshot.activePrayers);
    return true;
  }

  private async commitPrayerTransition(
    playerId: string,
    operationId: string,
    transition: PrayerStateTransitionKind,
    expected: PrayerPersistenceSnapshot,
    committed: PrayerPersistenceSnapshot,
    publicActionObservation?: StreamingDuelPrayerObservationContext,
  ): Promise<
    | { ok: true; receipt: PrayerStateCommitReceipt }
    | { ok: false; reason: PrayerActionFailureReason }
  > {
    const fail = (
      reason: PrayerActionFailureReason,
    ): { ok: false; reason: PrayerActionFailureReason } => {
      this.prayerPersistenceFailures.add(playerId);
      return { ok: false, reason };
    };
    const db = this.getDatabase();
    if (!db?.commitPrayerStateOperationAsync) {
      return fail("atomic_persistence_unavailable");
    }

    let requestFingerprint: string;
    try {
      requestFingerprint = await sha256Hex(
        JSON.stringify({
          version: 1,
          playerId,
          transition,
          expected,
          committed,
          ...(publicActionObservation ? { publicActionObservation } : {}),
        }),
      );
    } catch (error) {
      return fail(prayerPersistenceFailureReason(error));
    }

    const request = {
      operationId,
      playerId,
      requestFingerprint,
      transition,
      expected,
      committed,
      ...(publicActionObservation ? { publicActionObservation } : {}),
    } satisfies PrayerStateCommitRequest;
    let receipt: PrayerStateCommitReceipt;
    try {
      receipt = await db.commitPrayerStateOperationAsync(request);
    } catch (firstError) {
      if (!shouldRetryPrayerPersistence(firstError)) {
        return fail(prayerPersistenceFailureReason(firstError));
      }
      try {
        receipt = await db.commitPrayerStateOperationAsync(request);
      } catch (retryError) {
        Logger.systemError(
          "PrayerSystem",
          `Atomic prayer transition failed for ${playerId}: ${String(retryError)}`,
        );
        return fail(prayerPersistenceFailureReason(retryError));
      }
    }

    if (
      receipt.operationId !== operationId ||
      receipt.playerId !== playerId ||
      receipt.requestFingerprint !== requestFingerprint ||
      receipt.transition !== transition
    ) {
      return fail("persistence_failed");
    }
    const playerIdKey = toPlayerID(playerId);
    const state = playerIdKey ? this.playerStates.get(playerIdKey) : undefined;
    if (!state || !this.applyPrayerSnapshot(state, receipt.committed)) {
      return fail("persistence_failed");
    }
    this.prayerPersistenceFailures.delete(playerId);
    this.clearPrayerReconciliation(playerId);
    return { ok: true, receipt };
  }

  private async runSerializedTransition<T>(
    playerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queueKey = String(playerId ?? "").trim();
    const previous = this.transitionTails.get(queueKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const completion = run.then(
      () => undefined,
      () => undefined,
    );
    this.transitionTails.set(queueKey, completion);
    void completion.then(() => {
      if (this.transitionTails.get(queueKey) === completion) {
        this.transitionTails.delete(queueKey);
      }
    });
    return run;
  }

  /**
   * Deactivate all prayers for a player
   */
  async deactivateAllPrayers(
    playerId: string,
    operationId = `prayer-deactivate-all:${uuid()}${uuid()}`,
  ): Promise<PrayerActionReceipt> {
    return this.runSerializedTransition(playerId, async () => {
      const playerIdKey = toPlayerID(playerId);
      const state = playerIdKey
        ? this.playerStates.get(playerIdKey)
        : undefined;
      if (!state) {
        return this.prayerFailure(
          playerId,
          operationId,
          "player_not_initialized",
          "Prayer not initialized",
        );
      }
      if (!this.isPrayerPersistenceHealthy(playerId)) {
        return this.prayerFailure(
          playerId,
          operationId,
          "persistence_failed",
          "Prayer persistence is not ready",
        );
      }
      if (state.active.size === 0) {
        return {
          ...this.prayerSuccess(playerId, operationId, false),
          committed: false,
        };
      }

      const expected = this.snapshotPrayerState(state);
      const committed: PrayerPersistenceSnapshot = {
        ...expected,
        activePrayers: [],
      };
      const transition = await this.commitPrayerTransition(
        playerId,
        operationId,
        "deactivate_all",
        expected,
        committed,
      );
      if (!transition.ok) {
        return this.prayerFailure(
          playerId,
          operationId,
          transition.reason,
          "Prayer deactivation could not be committed",
        );
      }

      for (const activePrayerId of expected.activePrayers) {
        this.world.emit(EventType.PRAYER_DEACTIVATED, {
          playerId,
          prayerId: activePrayerId,
          reason: "deactivate_all",
        });
        this.world.emit(EventType.PRAYER_TOGGLED, {
          playerId,
          prayerId: activePrayerId,
          active: false,
          points: getDisplayPointsFromUnits(state.pointUnits),
        });
      }
      this.emitPrayerStateSync(playerId, state);
      return this.prayerSuccess(
        playerId,
        operationId,
        transition.receipt.replayed,
      );
    });
  }

  // ==========================================================================
  // RATE LIMITING
  // ==========================================================================

  /**
   * Check if toggle is within rate limits
   */
  private canTogglePrayer(state: PlayerPrayerState, now: number): boolean {
    if (now - state.lastToggleTime < PRAYER_TOGGLE_COOLDOWN_MS) {
      return false;
    }
    const count =
      now - state.rateLimitWindowStart > 1000 ? 0 : state.toggleCount;
    return count < PRAYER_TOGGLE_RATE_LIMIT;
  }

  private recordPrayerToggle(state: PlayerPrayerState, now: number): void {
    if (now - state.rateLimitWindowStart > 1000) {
      state.rateLimitWindowStart = now;
      state.toggleCount = 0;
    }
    state.lastToggleTime = now;
    state.toggleCount++;
  }

  // ==========================================================================
  // PRAYER DRAIN
  // ==========================================================================

  /**
   * Start the drain processing interval
   */
  private startDrainProcessing(): void {
    if (this.drainInterval) {
      clearInterval(this.drainInterval);
    }

    this.drainInterval = setInterval(() => {
      this.processDrainTick();
    }, DRAIN_INTERVAL_MS);
  }

  /**
   * Process prayer drain for all players with active prayers
   */
  private processDrainTick(): void {
    for (const [playerIdKey, state] of this.playerStates) {
      const playerId = playerIdKey as string;
      if (this.closingPlayers.has(playerId)) {
        continue;
      }
      if (!this.isPrayerPersistenceHealthy(playerId)) {
        this.startPrayerReconciliationWorker(playerId, Date.now());
        continue;
      }
      if (state.active.size === 0 || state.pointUnits <= 0) continue;
      this.pendingDrainTicks.set(
        playerId,
        (this.pendingDrainTicks.get(playerId) ?? 0) + 1,
      );
      this.startPlayerDrainWorker(playerId);
    }
  }

  private startPlayerDrainWorker(playerId: string): void {
    if (this.drainWorkers.has(playerId) || this.closingPlayers.has(playerId)) {
      return;
    }
    let worker!: Promise<void>;
    worker = (async () => {
      try {
        while (
          !this.closingPlayers.has(playerId) &&
          (this.pendingDrainTicks.get(playerId) ?? 0) > 0
        ) {
          const tickCount = this.pendingDrainTicks.get(playerId) ?? 0;
          this.pendingDrainTicks.set(playerId, 0);
          const ok = await this.runSerializedTransition(playerId, () =>
            this.commitPlayerDrainTicks(playerId, tickCount),
          );
          if (!ok) {
            this.pendingDrainTicks.set(playerId, 0);
            break;
          }
        }
      } finally {
        if (this.drainWorkers.get(playerId) === worker) {
          this.drainWorkers.delete(playerId);
        }
        if (
          !this.closingPlayers.has(playerId) &&
          (this.pendingDrainTicks.get(playerId) ?? 0) > 0
        ) {
          this.startPlayerDrainWorker(playerId);
        }
      }
    })();
    this.drainWorkers.set(playerId, worker);
    void worker;
  }

  private clearPrayerReconciliation(playerId: string): void {
    this.prayerReconciliationAttempts.delete(playerId);
    this.prayerReconciliationNextAt.delete(playerId);
  }

  private schedulePrayerReconciliation(playerId: string): void {
    const attempts = this.prayerReconciliationAttempts.get(playerId) ?? 0;
    const delayMs = Math.min(
      DRAIN_INTERVAL_MS * 2 ** Math.min(attempts, 16),
      MAX_PRAYER_RECONCILIATION_DELAY_MS,
    );
    this.prayerReconciliationNextAt.set(playerId, Date.now() + delayMs);
  }

  private startPrayerReconciliationWorker(playerId: string, now: number): void {
    if (
      this.closingPlayers.has(playerId) ||
      this.prayerReconciliationWorkers.has(playerId)
    ) {
      return;
    }
    const nextAt = this.prayerReconciliationNextAt.get(playerId);
    if (nextAt === undefined) {
      this.schedulePrayerReconciliation(playerId);
      return;
    }
    if (now < nextAt) return;

    let worker!: Promise<void>;
    worker = this.runSerializedTransition(playerId, async () => {
      const reconciled = await this.reconcilePrayerStateFromDatabase(playerId);
      if (reconciled) {
        this.clearPrayerReconciliation(playerId);
        return;
      }
      if (!this.closingPlayers.has(playerId)) {
        this.prayerReconciliationAttempts.set(
          playerId,
          (this.prayerReconciliationAttempts.get(playerId) ?? 0) + 1,
        );
        this.schedulePrayerReconciliation(playerId);
      }
    }).finally(() => {
      if (this.prayerReconciliationWorkers.get(playerId) === worker) {
        this.prayerReconciliationWorkers.delete(playerId);
      }
    });
    this.prayerReconciliationWorkers.set(playerId, worker);
    void worker;
  }

  private async reconcilePrayerStateFromDatabase(
    playerId: string,
  ): Promise<boolean> {
    if (this.closingPlayers.has(playerId)) return false;
    const playerIdKey = toPlayerID(playerId);
    const state = playerIdKey ? this.playerStates.get(playerIdKey) : undefined;
    const db = this.getDatabase();
    if (!state || !db?.commitPrayerStateOperationAsync) return false;

    try {
      const playerRow = await db.getPlayerAsync(playerId);
      if (!playerRow || this.closingPlayers.has(playerId)) return false;
      const rawMaxPoints = (
        playerRow as { prayerMaxPoints?: number; prayerLevel?: number }
      ).prayerMaxPoints;
      const fallbackLevel = (playerRow as { prayerLevel?: number }).prayerLevel;
      const maxPoints = clampPrayerLevel(
        rawMaxPoints ?? fallbackLevel ?? DEFAULT_PRAYER_POINTS,
      );
      const rawPointUnits = (playerRow as { prayerPointUnits?: number })
        .prayerPointUnits;
      const rawPoints = (playerRow as { prayerPoints?: number }).prayerPoints;
      const pointUnits = Number.isSafeInteger(rawPointUnits)
        ? rawPointUnits!
        : pointsToUnits(rawPoints ?? maxPoints, maxPoints);
      const parsed = parsePersistedActivePrayers(
        (playerRow as { activePrayers?: unknown }).activePrayers,
        playerId,
      );
      if (
        pointUnits < 0 ||
        pointUnits > maxPoints * PRAYER_POINT_UNITS_PER_POINT ||
        parsed.shouldRepair ||
        parsed.activePrayers.length > MAX_ACTIVE_PRAYERS ||
        (pointUnits === 0 && parsed.activePrayers.length > 0) ||
        (prayerDataProvider.hasPrayerManifest() &&
          parsed.activePrayers.some(
            (prayerId) => !prayerDataProvider.getPrayer(prayerId),
          ))
      ) {
        return false;
      }

      const previousActive = new Set(state.active);
      const previousDisplayPoints = getDisplayPointsFromUnits(state.pointUnits);
      const snapshot: PrayerPersistenceSnapshot = {
        pointUnits,
        maxPoints,
        activePrayers: [...parsed.activePrayers].sort((left, right) =>
          left.localeCompare(right),
        ),
      };
      if (!this.applyPrayerSnapshot(state, snapshot)) return false;
      this.prayerPersistenceFailures.delete(playerId);

      if (
        previousDisplayPoints !== getDisplayPointsFromUnits(state.pointUnits)
      ) {
        this.world.emit(EventType.PRAYER_POINTS_CHANGED, {
          playerId,
          points: getDisplayPointsFromUnits(state.pointUnits),
          maxPoints: state.maxPoints,
        });
      }
      for (const prayerId of state.active) {
        if (previousActive.has(prayerId)) continue;
        this.world.emit(EventType.PRAYER_TOGGLED, {
          playerId,
          prayerId,
          active: true,
          points: getDisplayPointsFromUnits(state.pointUnits),
        });
      }
      this.emitPrayerStateSync(playerId, state);
      return true;
    } catch (error) {
      Logger.systemWarn(
        "PrayerSystem",
        `Prayer persistence reconciliation failed for ${playerId}: ${String(error)}`,
      );
      return false;
    }
  }

  private async commitPlayerDrainTicks(
    playerId: string,
    tickCount: number,
  ): Promise<boolean> {
    const playerIdKey = toPlayerID(playerId);
    const state = playerIdKey ? this.playerStates.get(playerIdKey) : undefined;
    if (!state || state.active.size === 0 || state.pointUnits <= 0) return true;

    const player = this.getPlayerEntity(playerId);
    const prayerBonus = getPlayerPrayerBonus(player as PlayerWithPrayerStats);
    let totalDrain = 0;
    for (const prayerId of state.active) {
      totalDrain += prayerDataProvider.getPrayerDrainRate(prayerId);
    }
    if (totalDrain <= 0) return true;

    const drainResistance =
      PRAYER_BONUS_MULTIPLIER * prayerBonus + BASE_DRAIN_RESISTANCE;
    const unitsPerTick = Math.ceil(
      (totalDrain / drainResistance) * PRAYER_POINT_UNITS_PER_POINT,
    );
    const expected = this.snapshotPrayerState(state);
    const boundedTickCount = Math.min(
      Math.max(1, tickCount),
      Math.ceil(expected.pointUnits / unitsPerTick),
    );
    const nextUnits = Math.max(
      0,
      expected.pointUnits - unitsPerTick * boundedTickCount,
    );
    const committed: PrayerPersistenceSnapshot = {
      pointUnits: nextUnits,
      maxPoints: expected.maxPoints,
      activePrayers: nextUnits === 0 ? [] : expected.activePrayers,
    };
    const operationId = `prayer-drain:${uuid()}${uuid()}`;
    const transition = await this.commitPrayerTransition(
      playerId,
      operationId,
      "drain",
      expected,
      committed,
    );
    if (!transition.ok) {
      this.prayerPersistenceFailures.add(playerId);
      // Fail closed in live combat. The persisted state is intentionally not
      // guessed; readiness remains unhealthy until an exact transition later
      // succeeds or the player is reinitialized from the database.
      const activeBeforeFailure = [...state.active];
      state.active.clear();
      for (const prayerId of activeBeforeFailure) {
        this.world.emit(EventType.PRAYER_DEACTIVATED, {
          playerId,
          prayerId,
          reason: "persistence_failure",
        });
      }
      this.emitPrayerStateSync(playerId, state);
      this.clearPrayerReconciliation(playerId);
      this.schedulePrayerReconciliation(playerId);
      Logger.systemError(
        "PrayerSystem",
        `Prayer drain failed closed for ${playerId}: ${transition.reason}`,
        new Error(transition.reason),
      );
      return false;
    }

    this.prayerPersistenceFailures.delete(playerId);
    const oldDisplayPoints = getDisplayPointsFromUnits(expected.pointUnits);
    const newDisplayPoints = getDisplayPointsFromUnits(state.pointUnits);
    if (oldDisplayPoints !== newDisplayPoints) {
      this.world.emit(EventType.PRAYER_POINTS_CHANGED, {
        playerId,
        points: newDisplayPoints,
        maxPoints: state.maxPoints,
      });
    }
    if (state.pointUnits === 0 && expected.pointUnits > 0) {
      for (const prayerId of expected.activePrayers) {
        this.world.emit(EventType.PRAYER_DEACTIVATED, {
          playerId,
          prayerId,
          reason: "depleted",
        });
      }
      const depletedMessage = "You have run out of prayer points.";
      this.world.emit(EventType.UI_MESSAGE, {
        playerId,
        message: depletedMessage,
        type: "system",
      });
      this.world.emit(EventType.UI_TOAST, {
        playerId,
        message: depletedMessage,
        type: "warning",
      });
    }
    this.emitPrayerStateSync(playerId, state);
    return true;
  }

  // ==========================================================================
  // PRAYER POINTS
  // ==========================================================================

  /**
   * Get current prayer points for a player
   */
  getPrayerPoints(playerId: string): number {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return 0;

    const state = this.playerStates.get(playerIdKey);
    return state ? getDisplayPointsFromUnits(state.pointUnits) : 0;
  }

  /** Exact prayer custody used by market fingerprints and reconciliation. */
  getPrayerPointUnits(playerId: string): number {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return 0;
    return this.playerStates.get(playerIdKey)?.pointUnits ?? 0;
  }

  /**
   * Get max prayer points for a player
   */
  getMaxPrayerPoints(playerId: string): number {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return 1;

    const state = this.playerStates.get(playerIdKey);
    return state?.maxPoints ?? 1;
  }

  /**
   * Restore prayer points (e.g., from altar, potion)
   *
   * @param playerId - Player to restore points for
   * @param amount - Amount to restore (must be positive finite number)
   */
  async restorePrayerPoints(
    playerId: string,
    amount: number,
    operationId = `prayer-restore:${uuid()}${uuid()}`,
  ): Promise<PrayerActionReceipt> {
    if (!isValidRestoreAmount(amount)) {
      Logger.systemError(
        "PrayerSystem",
        `Invalid restore amount: ${amount} for ${playerId}`,
        new Error(`Invalid restore amount: ${amount}`),
      );
      return this.prayerFailure(
        playerId,
        operationId,
        "invalid_request",
        "Invalid prayer restore amount",
      );
    }

    return this.runSerializedTransition(playerId, async () => {
      const playerIdKey = toPlayerID(playerId);
      const state = playerIdKey
        ? this.playerStates.get(playerIdKey)
        : undefined;
      if (!state) {
        return this.prayerFailure(
          playerId,
          operationId,
          "player_not_initialized",
          "Prayer not initialized",
        );
      }
      if (!this.isPrayerPersistenceHealthy(playerId)) {
        return this.prayerFailure(
          playerId,
          operationId,
          "persistence_failed",
          "Prayer persistence is not ready",
        );
      }

      const expected = this.snapshotPrayerState(state);
      const restoreUnits = pointsToUnits(amount, state.maxPoints);
      const nextUnits = Math.min(
        state.maxPoints * PRAYER_POINT_UNITS_PER_POINT,
        expected.pointUnits + restoreUnits,
      );
      if (nextUnits === expected.pointUnits) {
        return {
          ...this.prayerSuccess(playerId, operationId, false),
          committed: false,
        };
      }

      const committed: PrayerPersistenceSnapshot = {
        ...expected,
        pointUnits: nextUnits,
      };
      const transition = await this.commitPrayerTransition(
        playerId,
        operationId,
        "restore",
        expected,
        committed,
      );
      if (!transition.ok) {
        return this.prayerFailure(
          playerId,
          operationId,
          transition.reason,
          "Prayer restoration could not be committed",
        );
      }

      if (
        getDisplayPointsFromUnits(expected.pointUnits) !==
        getDisplayPointsFromUnits(state.pointUnits)
      ) {
        this.world.emit(EventType.PRAYER_POINTS_CHANGED, {
          playerId,
          points: getDisplayPointsFromUnits(state.pointUnits),
          maxPoints: state.maxPoints,
        });
      }
      this.emitPrayerStateSync(playerId, state);
      return this.prayerSuccess(
        playerId,
        operationId,
        transition.receipt.replayed,
      );
    });
  }

  /**
   * Set max prayer points (called when prayer level changes)
   *
   * @param playerId - Player to set max points for
   * @param maxPoints - New maximum (clamped to [1, 99])
   */
  async setMaxPrayerPoints(
    playerId: string,
    maxPoints: number,
    operationId = `prayer-set-max:${uuid()}${uuid()}`,
  ): Promise<PrayerActionReceipt> {
    return this.runSerializedTransition(playerId, async () => {
      const playerIdKey = toPlayerID(playerId);
      const state = playerIdKey
        ? this.playerStates.get(playerIdKey)
        : undefined;
      if (!state) {
        return this.prayerFailure(
          playerId,
          operationId,
          "player_not_initialized",
          "Prayer not initialized",
        );
      }
      if (!this.isPrayerPersistenceHealthy(playerId)) {
        return this.prayerFailure(
          playerId,
          operationId,
          "persistence_failed",
          "Prayer persistence is not ready",
        );
      }

      const newMaxPoints = clampPrayerLevel(maxPoints);
      const expected = this.snapshotPrayerState(state);
      if (newMaxPoints === expected.maxPoints) {
        return {
          ...this.prayerSuccess(playerId, operationId, false),
          committed: false,
        };
      }
      const committed: PrayerPersistenceSnapshot = {
        pointUnits: Math.min(
          expected.pointUnits,
          newMaxPoints * PRAYER_POINT_UNITS_PER_POINT,
        ),
        maxPoints: newMaxPoints,
        activePrayers: expected.activePrayers,
      };
      const transition = await this.commitPrayerTransition(
        playerId,
        operationId,
        "set_max",
        expected,
        committed,
      );
      if (!transition.ok) {
        return this.prayerFailure(
          playerId,
          operationId,
          transition.reason,
          "Prayer maximum could not be committed",
        );
      }
      this.emitPrayerStateSync(playerId, state);
      return this.prayerSuccess(
        playerId,
        operationId,
        transition.receipt.replayed,
      );
    });
  }

  // ==========================================================================
  // ACTIVE PRAYERS
  // ==========================================================================

  /**
   * Get active prayer IDs for a player
   */
  getActivePrayers(playerId: string): readonly string[] {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return [];

    const state = this.playerStates.get(playerIdKey);
    return state ? Array.from(state.active) : [];
  }

  isPrayerPersistenceHealthy(playerId: string): boolean {
    const playerIdKey = toPlayerID(playerId);
    if (
      !playerIdKey ||
      !this.initializedPlayers.has(playerId) ||
      this.loadingPlayers.has(playerId) ||
      this.closingPlayers.has(playerId) ||
      this.prayerPersistenceFailures.has(playerId)
    ) {
      return false;
    }
    return (
      !this.world.isServer ||
      Boolean(this.getDatabase()?.commitPrayerStateOperationAsync)
    );
  }

  isPrayerReady(playerId: string): boolean {
    return this.isPrayerPersistenceHealthy(playerId);
  }

  getPrayerCustody(playerId: string): PrayerCustodyView {
    const playerIdKey = toPlayerID(playerId);
    const state = playerIdKey ? this.playerStates.get(playerIdKey) : undefined;
    const persistenceHealthy = this.isPrayerPersistenceHealthy(playerId);
    return {
      ready: Boolean(state) && persistenceHealthy,
      persistenceHealthy,
      pointUnits: state?.pointUnits ?? 0,
      points: getDisplayPointsFromUnits(state?.pointUnits ?? 0),
      maxPoints: state?.maxPoints ?? 1,
      activePrayers: state ? [...state.active].sort() : [],
    };
  }

  async reloadPrayerState(playerId: string): Promise<PrayerCustodyView> {
    await this.cleanupPlayerPrayer(playerId);
    await this.initializePlayerPrayer(playerId);
    return this.getPrayerCustody(playerId);
  }

  /** Wait until initialization, queued transitions, and coalesced drain work
   * visible at call time have settled. Useful for lifecycle fences and tests. */
  async waitForPrayerIdle(playerId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const pending = [
        this.initializationPromises.get(playerId),
        this.transitionTails.get(playerId),
        this.drainWorkers.get(playerId),
        this.prayerReconciliationWorkers.get(playerId),
      ].filter((value): value is Promise<void> => Boolean(value));
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      await Promise.resolve();
    }
    if (
      this.initializationPromises.has(playerId) ||
      this.transitionTails.has(playerId) ||
      this.drainWorkers.has(playerId) ||
      this.prayerReconciliationWorkers.has(playerId)
    ) {
      throw new Error("prayer_transition_did_not_settle");
    }
  }

  /**
   * Check if a specific prayer is active
   */
  isPrayerActive(playerId: string, prayerId: string): boolean {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return false;

    const state = this.playerStates.get(playerIdKey);
    return state?.active.has(prayerId) ?? false;
  }

  // ==========================================================================
  // COMBAT BONUSES
  // ==========================================================================

  /**
   * Get combined bonuses from all active prayers
   * Uses pre-allocated buffer to avoid allocations in combat hot paths.
   *
   * @returns Reference to internal buffer - do not store long-term
   */
  getCombinedBonuses(playerId: string): MutablePrayerBonuses {
    // Reset buffer
    for (const key of PRAYER_BONUS_KEYS) {
      this.combinedBonusesBuffer[key] = undefined;
    }

    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return this.combinedBonusesBuffer;

    const state = this.playerStates.get(playerIdKey);
    if (
      !state ||
      state.active.size === 0 ||
      !this.isPrayerPersistenceHealthy(playerId)
    ) {
      return this.combinedBonusesBuffer;
    }

    // Combine bonuses from all active prayers
    for (const prayerId of state.active) {
      const bonuses = prayerDataProvider.getPrayerBonuses(prayerId);
      if (!bonuses) continue;

      // Take the highest multiplier for each stat (prayers don't stack additively).
      for (const key of PRAYER_BONUS_KEYS) {
        const multiplier = bonuses[key];
        if (multiplier !== undefined) {
          this.combinedBonusesBuffer[key] = Math.max(
            this.combinedBonusesBuffer[key] ?? 1,
            multiplier,
          );
        }
      }
    }

    return this.combinedBonusesBuffer;
  }

  /**
   * Get effective attack level with prayer bonuses
   */
  getEffectiveAttackLevel(playerId: string, baseLevel: number): number {
    const bonuses = this.getCombinedBonuses(playerId);
    const multiplier = bonuses.attackMultiplier ?? 1;
    return Math.floor(baseLevel * multiplier);
  }

  /**
   * Get effective strength level with prayer bonuses
   */
  getEffectiveStrengthLevel(playerId: string, baseLevel: number): number {
    const bonuses = this.getCombinedBonuses(playerId);
    const multiplier = bonuses.strengthMultiplier ?? 1;
    return Math.floor(baseLevel * multiplier);
  }

  /**
   * Get effective defense level with prayer bonuses
   */
  getEffectiveDefenseLevel(playerId: string, baseLevel: number): number {
    const bonuses = this.getCombinedBonuses(playerId);
    const multiplier = bonuses.defenseMultiplier ?? 1;
    return Math.floor(baseLevel * multiplier);
  }

  // ==========================================================================
  // STATE SYNC
  // ==========================================================================

  /**
   * Emit prayer state sync event
   */
  private emitPrayerStateSync(
    playerId: string,
    state: PlayerPrayerState,
  ): void {
    const syncEntity = (entity: unknown): void => {
      if (!entity || typeof entity !== "object") return;
      const mutable = entity as {
        data?: Record<string, unknown>;
        markNetworkDirty?: () => void;
      };
      if (!mutable.data) return;
      mutable.data.activePrayers = [...state.active];
      mutable.data.prayerPoints = getDisplayPointsFromUnits(state.pointUnits);
      mutable.data.prayerPointUnits = state.pointUnits;
      mutable.data.prayerMaxPoints = state.maxPoints;
      mutable.markNetworkDirty?.();
    };
    const entity = this.world.entities.get(playerId);
    syncEntity(entity);
    const player = (
      this.world as unknown as {
        getPlayer?: (id: string) => unknown;
      }
    ).getPlayer?.(playerId);
    if (player !== entity) syncEntity(player);

    // Use world.emit for EventBridge to route to client
    this.world.emit(EventType.PRAYER_STATE_SYNC, {
      playerId,
      level: state.maxPoints, // Prayer level = max points
      xp: 0, // XP managed by SkillsSystem
      points: getDisplayPointsFromUnits(state.pointUnits),
      maxPoints: state.maxPoints,
      active: Array.from(state.active),
    });
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  /**
   * Get player entity for bonus lookups
   * Returns typed player entity or undefined if not found.
   */
  private getPlayerEntity(playerId: string): PlayerWithPrayerStats | undefined {
    const entity = this.world.entities.get(playerId);
    if (!entity) return undefined;
    const candidate = entity as unknown as {
      id?: unknown;
      stats?: PlayerWithPrayerStats["stats"];
      skills?: PlayerWithPrayerStats["skills"];
      data?: {
        stats?: PlayerWithPrayerStats["stats"];
        skills?: PlayerWithPrayerStats["skills"];
      };
      getPlayerData?: () => {
        skills?: PlayerWithPrayerStats["skills"];
      };
      getComponent?: (name: string) =>
        | {
            data?: {
              prayer?: NonNullable<PlayerWithPrayerStats["stats"]>["prayer"];
              combatBonuses?: NonNullable<
                PlayerWithPrayerStats["stats"]
              >["combatBonuses"];
            };
          }
        | undefined;
    };

    let playerDataSkills: PlayerWithPrayerStats["skills"] | undefined;
    try {
      playerDataSkills = candidate.getPlayerData?.().skills;
    } catch {
      // A partially constructed or teardown-phase entity can reject reads.
    }
    const skills =
      candidate.skills ?? candidate.data?.skills ?? playerDataSkills;
    const componentStats = candidate.getComponent?.("stats")?.data;
    const stats =
      candidate.stats ??
      candidate.data?.stats ??
      (componentStats
        ? {
            // Live skill custody wins whenever it is available. The stats
            // component remains a compatibility fallback and bonus source.
            prayer: skills?.prayer ? undefined : componentStats.prayer,
            combatBonuses: componentStats.combatBonuses,
          }
        : undefined);

    return {
      id: typeof candidate.id === "string" ? candidate.id : playerId,
      stats,
      skills,
    };
  }

  /**
   * Get database system
   */
  private getDatabase(): DatabaseSystem | undefined {
    return this.world.getSystem("database") as DatabaseSystem | undefined;
  }

  /**
   * Get prayer state for debugging
   */
  getPrayerState(playerId: string): PrayerState | null {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return null;

    const state = this.playerStates.get(playerIdKey);
    if (!state) return null;

    return {
      level: state.maxPoints,
      xp: 0,
      points: getDisplayPointsFromUnits(state.pointUnits),
      maxPoints: state.maxPoints,
      active: Array.from(state.active),
    };
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  override destroy(): void {
    // Unsubscribe from world events
    this.world.off(EventType.PLAYER_REGISTERED, this.onPlayerRegistered);
    this.world.off(EventType.PLAYER_CLEANUP, this.onPlayerCleanup);
    this.world.off(EventType.PLAYER_LEFT, this.onPlayerLeft);
    this.world.off(EventType.PLAYER_JOINED, this.onPlayerJoined);
    this.world.off(EventType.PRAYER_TOGGLE, this.onPrayerToggle);
    this.world.off(EventType.ALTAR_PRAY, this.onAltarPray);
    this.world.off(EventType.PRAYER_DEACTIVATED, this.onPrayerDeactivated);

    // Clear intervals
    if (this.drainInterval) {
      clearInterval(this.drainInterval);
      this.drainInterval = undefined;
    }

    for (const playerIdKey of this.playerStates.keys()) {
      this.closingPlayers.add(playerIdKey as string);
    }
    this.pendingDrainTicks.clear();

    // Completed transitions are already durable. Keep states referenced by an
    // in-flight transition until it settles so teardown cannot turn a committed
    // database receipt into an invalid live apply.
    const inFlight = [
      ...new Set([
        ...this.transitionTails.values(),
        ...this.drainWorkers.values(),
        ...this.prayerReconciliationWorkers.values(),
      ]),
    ];
    const clearState = (): void => {
      this.playerStates.clear();
      this.loadingPlayers.clear();
      this.initializedPlayers.clear();
      this.initializationPromises.clear();
      this.transitionTails.clear();
      this.drainWorkers.clear();
      this.prayerPersistenceFailures.clear();
      this.prayerReconciliationWorkers.clear();
      this.prayerReconciliationAttempts.clear();
      this.prayerReconciliationNextAt.clear();
      this.closingPlayers.clear();
    };
    if (inFlight.length === 0) clearState();
    else void Promise.allSettled(inFlight).then(clearState);

    super.destroy();
  }
}
