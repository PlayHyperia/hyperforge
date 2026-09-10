import THREE from "../../../extras/three/three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { ITEM_IDS } from "../../../constants/GameConstants";
import { Fire, ProcessingAction } from "../../../types/core/core";
import { processingDataProvider } from "../../../data/ProcessingDataProvider";
import { calculateDistance2D } from "../../../utils/game/EntityUtils";
import {
  EventType,
  getProcessingRequestOperationId,
} from "../../../types/events";
import { PROCESSING_CONSTANTS } from "../../../constants/ProcessingConstants";
import { CollisionMask } from "../movement/CollisionFlags";
import {
  tilesWithinMeleeRange,
  worldToTile,
  tileToWorld,
  TICK_DURATION_MS,
  type TileCoord,
} from "../../shared/movement/TileSystem";
import { Logger, uuid } from "../../../utils";
import {
  calculateFiremakingSuccess,
  getRandomFireDuration,
} from "../entities/processing/FiremakingCalculator";
import { canPlayerPerformPreparationAction } from "./ProcessingStationAuthority";
import {
  clearProcessingInteractionPresentation,
  publishProcessingInteractionPresentation,
} from "./ProcessingInteractionPresentation";
import type { PlayerProcessingQuiescenceSystem } from "./ProcessingQuiescence";

/**
 * Processing System
 * Implements firemaking and cooking per GDD specifications:
 *
 * FIREMAKING:
 * - Use tinderbox on logs in inventory
 * - Creates fire object in world at player position
 * - Grants firemaking XP
 * - Fire lasts for limited time
 *
 * COOKING:
 * - Use raw fish on fire object
 * - Converts raw fish to cooked fish
 * - Grants cooking XP
 * - Can burn food at low levels
 */
import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../types/index";
import { getTargetValidator } from "./TargetValidator";
import { modelCache } from "../../../utils/rendering/ModelCache";
import type { ParticleSystem } from "../presentation/ParticleSystem";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import type {
  AtomicProcessingActionReceipt,
  InventorySystem,
} from "../character/InventorySystem";
import type {
  ActiveProcessingFire,
  ProcessingFireExtinguishCommitReceipt,
  ProcessingFireExtinguishCommitRequest,
  ProcessingActionFireEffectRequest,
} from "../../../types/network/database";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import {
  getProcessingFireExtinguishOperationId,
  serializeProcessingFireExtinguishFingerprint,
} from "../../../utils/game/ProcessingFireExtinguishRegistration";

interface RuntimeProcessingAction extends ProcessingAction {
  sourceType?: "fire" | "range";
  requestId?: string;
}

interface FinitePosition {
  x: number;
  y: number;
  z: number;
}

interface PendingProcessingCommit {
  operationId: string;
  playerId: string;
  action: RuntimeProcessingAction;
  kind: "firemaking" | "cooking";
  inputItemId: string;
  outputItemId: string | null;
  xpAmount: number;
  sourceId: string | null;
  sourceType: "fire" | "range" | null;
  didBurn: boolean;
  fireId: string | null;
  firePosition: FinitePosition | null;
  fireTileKey: string | null;
  fireDurationMs: number | null;
  retryCount: number;
  retryAtTick: number;
  state: "in_flight" | "retry_wait" | "settled";
  receipt: AtomicProcessingActionReceipt | null;
  disconnected: boolean;
  presentationCancelled: boolean;
  requestId?: string;
}

interface PendingFireExpirySettlement {
  effect: ActiveProcessingFire;
  retryCount: number;
  retryAt: number;
  state: "in_flight" | "retry_wait" | "blocked";
  lastError: string;
}

interface CookingRangeLike {
  entityType?: unknown;
  position?: unknown;
  getPosition?: () => unknown;
  canInteract?: (playerId: string, position: FinitePosition) => boolean;
}

/**
 * Debug logging flag for processing system.
 * Set to true during development/testing for verbose output.
 * Should be false in production for performance.
 */
const DEBUG_PROCESSING = false;
const ASH_SOURCE_LIFETIME_MS = 120_000;
const FIRE_EXPIRY_RETRY_BASE_MS = 1_000;
const FIRE_EXPIRY_RETRY_MAX_MS = 60_000;

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

function isDefinitiveFireExtinguishError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "processing_fire_extinguish_request_invalid",
    "processing_fire_extinguish_fire_mismatch",
    "processing_fire_extinguish_operation_id_conflict",
    "processing_fire_extinguish_state_conflict",
    "processing_fire_extinguish_source_preexisting",
    "processing_fire_extinguish_source_receipt_invalid",
    "processing_fire_extinguish_receipt_invalid",
    "processing_fire_extinguish_source_authority_unavailable",
    "processing_fire_extinguish_database_authority_incomplete",
    "processing_fire_extinguish_source_plan_unavailable",
    "processing_fire_extinguish_diagnostic_source_rejected",
    "ground_item_source_request_invalid",
    "ground_item_source_contribution_id_conflict",
    "ground_item_source_quantity_overflow",
    "ground_item_source_lifetime_overflow",
  ].some((code) => message.includes(code));
}

export class ProcessingSystem
  extends SystemBase
  implements PlayerProcessingQuiescenceSystem
{
  // Fire visual constants
  private static readonly FIRE_MODEL_SCALE = 0.35;

  private static readonly FIRE_PARTICLE_SPAWN_Y = 0.1;
  private static readonly FIRE_PLACEHOLDER_Y_OFFSET = 0.4;

  private activeFires = new Map<string, Fire>();
  /** Host-clock deadline derived from the database-observed remaining duration. */
  private readonly fireLocalExpiryDeadlines = new Map<string, number>();
  private activeProcessing = new Map<string, RuntimeProcessingAction>();
  private readonly pendingCommits = new Map<string, PendingProcessingCommit>();
  /** Runtime expiry ambiguity remains owned until it commits or is operator-blocked. */
  private readonly pendingFireExpirySettlements = new Map<
    string,
    PendingFireExpirySettlement
  >();
  /** Fire tiles stay reserved from the first lighting frame through commit settlement. */
  private readonly reservedFireTiles = new Map<string, string>();
  private fireCleanupTimers = new Map<string, NodeJS.Timeout>();
  private pendingFireModels = new Map<string, THREE.Object3D>();
  private playerSkills = new Map<
    string,
    Record<string, { level: number; xp: number }>
  >();

  // Processing constants per GDD
  private readonly MAX_FIRES_PER_PLAYER =
    PROCESSING_CONSTANTS.FIRE.maxFiresPerPlayer;

  // NOTE: XP values and cooking parameters are now in the item manifest (items.json)
  // and accessed via ProcessingDataProvider at runtime.

  // classic MMORPG firemaking movement priority: West → East → South → North
  // After lighting a fire, player moves to an adjacent tile in this priority order
  private readonly FIREMAKING_MOVE_PRIORITY = [
    { dx: -1, dz: 0 }, // West (-X)
    { dx: 1, dz: 0 }, // East (+X)
    { dx: 0, dz: 1 }, // South (+Z in Three.js)
    { dx: 0, dz: -1 }, // North (-Z in Three.js)
  ];

  // ProcessingAction object pool (avoids allocation per action)
  private readonly actionPool: RuntimeProcessingAction[] = [];
  private readonly MAX_POOL_SIZE = 100;
  private destroyed = false;

  constructor(world: World) {
    super(world, {
      name: "processing",
      dependencies: {
        required: [],
        optional: ["inventory", "skills", "ui", "database"],
      },
      autoCleanup: true,
    });
  }

  /**
   * Count active fires for a player without allocating arrays.
   * Replaces Array.from().filter() in hot path.
   */
  private countPlayerFires(playerId: string): number {
    let count = 0;
    for (const fire of this.activeFires.values()) {
      if (fire.playerId === playerId && fire.isActive) {
        count++;
      }
    }
    return count;
  }

  /**
   * Acquire a ProcessingAction from the pool (or create new).
   */
  private acquireAction(): RuntimeProcessingAction {
    if (this.actionPool.length > 0) {
      return this.actionPool.pop()!;
    }
    return {
      playerId: "",
      actionType: "firemaking",
      primaryItem: { id: "", slot: 0 },
      startTime: 0,
      duration: 0,
      xpReward: 0,
      skillRequired: "",
    };
  }

  /**
   * Release a ProcessingAction back to the pool for reuse.
   */
  private releaseAction(action: RuntimeProcessingAction): void {
    if (this.actionPool.length < this.MAX_POOL_SIZE) {
      // Reset to defaults
      action.playerId = "";
      action.targetItem = undefined;
      action.targetFire = undefined;
      action.startPosition = undefined;
      action.sourceType = undefined;
      action.requestId = undefined;
      this.actionPool.push(action);
    }
  }

  /**
   * Set player emote during processing (squat for cooking/firemaking)
   */
  private setProcessingEmote(playerId: string): void {
    this.emitTypedEvent(EventType.PLAYER_SET_EMOTE, {
      playerId,
      emote: "squat",
    });
  }

  /**
   * Reset player emote to idle (after processing completes or cancels)
   */
  private resetPlayerEmote(playerId: string): void {
    this.emitTypedEvent(EventType.PLAYER_SET_EMOTE, {
      playerId,
      emote: "idle",
    });
  }

  async init(): Promise<void> {
    // Listen for processing events via event bus
    this.subscribe(
      EventType.PROCESSING_FIREMAKING_REQUEST,
      (data: {
        playerId: string;
        logsId: string;
        logsSlot: number;
        tinderboxSlot: number;
        requestId?: string;
      }) => {
        this.startFiremaking(data);
      },
    );
    this.subscribe(
      EventType.PROCESSING_COOKING_REQUEST,
      (data: {
        playerId: string;
        fishSlot: number;
        fireId?: string;
        rangeId?: string;
        sourceType?: "fire" | "range";
        requestId?: string;
      }) => {
        this.startCooking(data);
      },
    );
    this.subscribe(EventType.ITEM_USE_ON_ITEM, (_data) => {
      // Item-on-item handling deferred to specific processing methods
      return;
    });
    this.subscribe(EventType.ITEM_USE_ON_FIRE, (_data) => {
      // Item-on-fire handled elsewhere in UI tests; skip to avoid type mismatch
      return;
    });
    this.subscribe(
      EventType.PLAYER_UNREGISTERED,
      (data: { playerId: string }) => this.cleanupPlayer({ id: data.playerId }),
    );
    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      this.cancelPendingProcessingPresentation(data.playerId);
    });
    this.subscribe(
      EventType.COMBAT_STARTED,
      (data: { attackerId: string; targetId: string }) => {
        this.cancelPendingProcessingPresentation(data.attackerId);
        this.cancelPendingProcessingPresentation(data.targetId);
      },
    );
    // Listen for test event to extinguish fires early for testing
    this.subscribe(
      EventType.TEST_FIRE_EXTINGUISH,
      (data: { fireId: string }) => {
        void this.extinguishFire(data.fireId);
      },
    );

    // Listen to skills updates for reactive patterns
    this.subscribe(
      EventType.SKILLS_UPDATED,
      (data: {
        playerId: string;
        skills: Record<
          | "attack"
          | "strength"
          | "defense"
          | "ranged"
          | "woodcutting"
          | "fishing"
          | "firemaking"
          | "cooking",
          { level: number; xp: number }
        >;
      }) => {
        this.playerSkills.set(data.playerId, data.skills);
      },
    );

    // Register as FireRegistry so TargetValidator knows about active fires
    const validator = getTargetValidator();
    validator.setFireRegistry({
      getActiveFireIds: () => this.getActiveFireIds(),
    });

    // CLIENT ONLY: Listen for fire created events from server to create visuals
    if (this.world.isClient) {
      this.subscribe(
        EventType.FIRE_CREATED,
        (data: {
          fireId: string;
          playerId: string;
          position: { x: number; y: number; z: number };
          createdAt: number;
          expiresAt: number;
          serverObservedAt: number;
        }) => {
          if (DEBUG_PROCESSING) {
            console.log(
              "[ProcessingSystem] 🔥 FIRE_CREATED received on client:",
              data,
            );
          }
          const createdAt = Number(data.createdAt);
          const expiresAt = Number(data.expiresAt);
          const serverObservedAt = Number(data.serverObservedAt);
          if (
            !Number.isSafeInteger(createdAt) ||
            !Number.isSafeInteger(expiresAt) ||
            !Number.isSafeInteger(serverObservedAt) ||
            expiresAt <= createdAt ||
            expiresAt <= serverObservedAt
          ) {
            return;
          }
          const existing = this.activeFires.get(data.fireId);
          const remainingMs = expiresAt - serverObservedAt;
          this.fireLocalExpiryDeadlines.set(
            data.fireId,
            Date.now() + remainingMs,
          );
          if (existing?.isActive) {
            existing.createdAt = createdAt;
            existing.duration = expiresAt - createdAt;
            return;
          }
          const fire: Fire = {
            id: data.fireId,
            position: data.position,
            playerId: data.playerId,
            createdAt,
            duration: expiresAt - createdAt,
            isActive: true,
          };
          this.activeFires.set(data.fireId, fire);
          this.createFireVisual(fire);
        },
      );

      this.subscribe(
        EventType.FIRE_EXTINGUISHED,
        (data: { fireId: string }) => {
          if (DEBUG_PROCESSING) {
            console.log(
              "[ProcessingSystem] 💨 FIRE_EXTINGUISHED received on client:",
              data,
            );
          }
          void this.extinguishFire(data.fireId);
        },
      );

      // Load fire model when lighting starts (before fire is officially created)
      this.subscribe(
        EventType.FIRE_LIGHTING_STARTED,
        (data: {
          playerId: string;
          position: { x: number; y: number; z: number };
        }) => {
          this.loadFireModelForLighting(data.playerId, data.position);
        },
      );

      // Clean up preloaded fire model when lighting is cancelled (player moved)
      this.subscribe(
        EventType.FIRE_LIGHTING_CANCELLED,
        (data: { playerId: string }) => {
          const pendingModel = this.pendingFireModels.get(data.playerId);
          if (pendingModel) {
            this.world.stage.scene.remove(pendingModel);
            this.pendingFireModels.delete(data.playerId);
          }
        },
      );
    }
  }

  /**
   * Restore durable world effects only after every system has finished init().
   * Server systems without required dependency edges initialize concurrently,
   * so DatabaseSystem may exist but not yet hold its Drizzle connection during
   * this system's init wave. World.start() runs after all init waves and before
   * ServerNetwork accepts connections, which is the safe recovery boundary.
   */
  async start(): Promise<void> {
    if (this.world.isServer) {
      await this.restoreActiveFires();
    }
  }

  private getDatabaseSystem(): DatabaseSystem | undefined {
    return this.world.getSystem("database") as DatabaseSystem | undefined;
  }

  /** Rehydrate committed fires before the server accepts new processing work. */
  private async restoreActiveFires(): Promise<void> {
    const database = this.getDatabaseSystem();
    if (!database?.getActiveProcessingFiresAsync) return;
    const effects = await database.getActiveProcessingFiresAsync();
    let restored = 0;
    for (const effect of effects) {
      const observedAt =
        Number.isSafeInteger(effect.databaseObservedAt) &&
        effect.databaseObservedAt! >= 0
          ? effect.databaseObservedAt!
          : Date.now();
      if (effect.expiresAt <= observedAt) {
        await this.settleFireExpiry(effect, true);
      } else if (this.registerActiveFire(effect, observedAt)) {
        restored++;
      }
    }
    if (restored > 0) {
      Logger.system("ProcessingSystem", "active_fires_restored", { restored });
    }
  }

  /**
   * Register one authoritative fire idempotently and schedule only its remaining
   * lifetime. Server recovery does not replay XP, movement, inventory, or UI.
   */
  private registerActiveFire(
    effect: ActiveProcessingFire,
    observedAt = Date.now(),
  ): Fire | null {
    if (effect.expiresAt <= observedAt) return null;
    const existing = this.activeFires.get(effect.fireId);
    if (existing?.isActive) return existing;
    const fire: Fire = {
      id: effect.fireId,
      position: effect.position,
      playerId: effect.playerId,
      createdAt: effect.createdAt,
      duration: effect.expiresAt - effect.createdAt,
      isActive: true,
    };
    this.activeFires.set(fire.id, fire);
    const remainingMs = Math.max(1, effect.expiresAt - observedAt);
    this.fireLocalExpiryDeadlines.set(fire.id, Date.now() + remainingMs);
    this.createFireVisual(fire);
    const cleanupTimer = setTimeout(() => {
      void this.extinguishFire(fire.id);
    }, remainingMs);
    this.fireCleanupTimers.set(fire.id, cleanupTimer);
    return fire;
  }

  // Handle item-on-item interactions (tinderbox on logs)
  // Legacy method - kept for backwards compatibility with numeric item IDs
  private handleItemOnItem(data: {
    playerId: string;
    primaryItemId: number;
    primarySlot: number;
    targetItemId: number;
    targetSlot: number;
  }): void {
    const { playerId, primaryItemId, primarySlot, targetItemId, targetSlot } =
      data;

    // Check for tinderbox on logs
    if (
      primaryItemId === ITEM_IDS.TINDERBOX &&
      targetItemId === ITEM_IDS.LOGS
    ) {
      // Tinderbox on logs - use "logs" as default logsId for legacy path
      this.startFiremaking({
        playerId,
        logsId: "logs",
        logsSlot: targetSlot,
        tinderboxSlot: primarySlot,
      });
    }
    // Check for logs on tinderbox (reverse order)
    else if (
      primaryItemId === ITEM_IDS.LOGS &&
      targetItemId === ITEM_IDS.TINDERBOX
    ) {
      // Logs on tinderbox - use "logs" as default logsId for legacy path
      this.startFiremaking({
        playerId,
        logsId: "logs",
        logsSlot: primarySlot,
        tinderboxSlot: targetSlot,
      });
    }
  }

  // Handle item-on-fire interactions (raw fish on fire)
  private handleItemOnFire(data: {
    playerId: string;
    itemId: number;
    itemSlot: number;
    fireId: string;
  }): void {
    const { playerId, itemId, itemSlot, fireId } = data;

    // Check for raw fish on fire
    if (itemId === ITEM_IDS.RAW_FISH) {
      // Raw fish
      this.startCooking({
        playerId,
        fishSlot: itemSlot,
        fireId,
      });
    }
  }

  private getFinitePlayerPosition(playerId: string): FinitePosition | null {
    const player =
      this.world.getPlayer(playerId) ?? this.world.entities.get(playerId);
    if (!player || typeof player !== "object") return null;
    const candidate = player as {
      position?: unknown;
      node?: { position?: unknown };
      getPosition?: () => unknown;
    };
    let raw = candidate.position ?? candidate.node?.position;
    if (!raw && typeof candidate.getPosition === "function") {
      try {
        raw = candidate.getPosition();
      } catch {
        return null;
      }
    }
    if (!raw || typeof raw !== "object") return null;
    const position = raw as Partial<FinitePosition>;
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return null;
    }
    return {
      x: position.x as number,
      y: position.y as number,
      z: position.z as number,
    };
  }

  private getInventorySlot(
    playerId: string,
    slot: number,
  ): { itemId: string; quantity: number } | null {
    const inventory = this.world.getInventory?.(playerId);
    if (!Array.isArray(inventory)) return null;
    const item = (
      inventory as Array<Record<string, unknown> & { itemId?: unknown }>
    ).find((candidate) => candidate?.slot === slot) as
      { itemId?: unknown; quantity?: unknown } | undefined;
    if (!item || typeof item.itemId !== "string") return null;
    const quantity = item.quantity === undefined ? 1 : Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
    return { itemId: item.itemId, quantity };
  }

  private fireTileKey(position: FinitePosition): string {
    const tile = worldToTile(position.x, position.z);
    return `${tile.x}:${tile.z}`;
  }

  private isFireTileAvailable(
    playerId: string,
    position: FinitePosition,
  ): boolean {
    const tile = worldToTile(position.x, position.z);
    const key = `${tile.x}:${tile.z}`;
    const reservationOwner = this.reservedFireTiles.get(key);
    if (reservationOwner && reservationOwner !== playerId) return false;
    if (this.hasFireAtTile(tile)) return false;
    try {
      return !this.world.collision.hasFlags(
        tile.x,
        tile.z,
        CollisionMask.BLOCKS_WALK,
      );
    } catch {
      return false;
    }
  }

  private reserveFireTile(playerId: string, position: FinitePosition): boolean {
    if (!this.isFireTileAvailable(playerId, position)) return false;
    const key = this.fireTileKey(position);
    if (this.reservedFireTiles.has(key)) return false;
    this.reservedFireTiles.set(key, playerId);
    return true;
  }

  private releaseFireReservation(
    playerId: string,
    position?: FinitePosition,
  ): void {
    if (position) {
      const key = this.fireTileKey(position);
      if (this.reservedFireTiles.get(key) === playerId) {
        this.reservedFireTiles.delete(key);
      }
      return;
    }
    for (const [key, owner] of this.reservedFireTiles) {
      if (owner === playerId) this.reservedFireTiles.delete(key);
    }
  }

  private countPlayerReservedFires(playerId: string): number {
    let count = 0;
    for (const owner of this.reservedFireTiles.values()) {
      if (owner === playerId) count++;
    }
    return count;
  }

  private startFiremaking(data: {
    playerId: string;
    logsId: string;
    logsSlot: number;
    tinderboxSlot: number;
    requestId?: string;
  }): void {
    const { playerId, logsId, logsSlot, tinderboxSlot, requestId } = data;

    if (!this.world.isServer || this.destroyed) return;

    if (!canPlayerPerformPreparationAction(this.world, playerId)) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "not_authorized",
      );
      return;
    }

    if (DEBUG_PROCESSING) {
      console.log("[ProcessingSystem] 🔥 startFiremaking called:", {
        playerId,
        logsId,
        logsSlot,
        tinderboxSlot,
      });
    }

    // Check if player is already processing
    if (
      this.activeProcessing.has(playerId) ||
      this.pendingCommits.has(playerId)
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already doing something.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "busy",
        true,
      );
      return;
    }

    if (
      typeof logsId !== "string" ||
      logsId.length === 0 ||
      logsId.length > 256 ||
      !Number.isSafeInteger(logsSlot) ||
      logsSlot < 0 ||
      logsSlot > 27 ||
      !Number.isSafeInteger(tinderboxSlot) ||
      tinderboxSlot < 0 ||
      tinderboxSlot > 27 ||
      logsSlot === tinderboxSlot
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "That firemaking request is invalid.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "invalid_request",
      );
      return;
    }

    const logs = this.getInventorySlot(playerId, logsSlot);
    const tinderbox = this.getInventorySlot(playerId, tinderboxSlot);
    if (logs?.itemId !== logsId || tinderbox?.itemId !== "tinderbox") {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You need the selected logs and a tinderbox.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "resources_unavailable",
      );
      return;
    }

    if (
      this.countPlayerFires(playerId) +
        this.countPlayerReservedFires(playerId) >=
      this.MAX_FIRES_PER_PLAYER
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You already have too many active fires.",
        type: "warning",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "capacity_unavailable",
        true,
      );
      return;
    }

    const position = this.getFinitePlayerPosition(playerId);
    if (!position || !this.reserveFireTile(playerId, position)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You cannot light a fire on this tile.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "not_authorized",
        true,
      );
      return;
    }

    this.startFiremakingProcess(
      playerId,
      logsId,
      logsSlot,
      tinderboxSlot,
      position,
      requestId,
    );
  }

  private startFiremakingProcess(
    playerId: string,
    logsId: string,
    logsSlot: number,
    tinderboxSlot: number,
    startPosition: FinitePosition,
    requestId?: string,
  ): void {
    // Get firemaking data from manifest
    const firemakingData = processingDataProvider.getFiremakingData(logsId);
    if (!firemakingData) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You can't light that.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "invalid_request",
      );
      this.releaseFireReservation(playerId, startPosition);
      return;
    }

    // Check level requirement
    let firemakingLevel = 1;
    const cachedSkills = this.playerSkills.get(playerId);
    if (cachedSkills?.firemaking?.level) {
      firemakingLevel = cachedSkills.firemaking.level;
    } else {
      const player = this.world.getPlayer(playerId);
      const playerSkills = (
        player as { skills?: Record<string, { level: number }> }
      )?.skills;
      if (playerSkills?.firemaking?.level) {
        firemakingLevel = playerSkills.firemaking.level;
      }
    }

    if (firemakingLevel < firemakingData.levelRequired) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need level ${firemakingData.levelRequired} Firemaking to light those logs.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "firemaking",
        "requirements_not_met",
      );
      this.releaseFireReservation(playerId, startPosition);
      return;
    }

    // Start firemaking process using pooled action object to reduce GC pressure
    const processingAction = this.acquireAction();
    processingAction.playerId = playerId;
    processingAction.actionType = "firemaking";
    processingAction.primaryItem = { id: "tinderbox", slot: tinderboxSlot };
    processingAction.targetItem = { id: logsId, slot: logsSlot };
    processingAction.startTime = Date.now();
    processingAction.duration = firemakingData.ticks * TICK_DURATION_MS;
    processingAction.xpReward = firemakingData.xp;
    processingAction.skillRequired = "firemaking";
    processingAction.requestId = requestId;

    this.activeProcessing.set(playerId, processingAction);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "firemaking",
      targetPosition: startPosition,
    });
    this.reportProcessingRequestProgress(
      playerId,
      requestId,
      "firemaking",
      "accepted",
      true,
    );
    // Show processing message
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: "You attempt to light the logs...",
      type: "info",
    });

    // classic MMORPG: Player squats/crouches while lighting fire
    this.setProcessingEmote(playerId);

    processingAction.startPosition = startPosition;

    // Notify clients to show fire model during lighting animation
    this.emitTypedEvent(EventType.FIRE_LIGHTING_STARTED, {
      playerId,
      position: startPosition,
    });

    this.scheduleFiremakingAttempt(
      playerId,
      processingAction,
      startPosition,
      firemakingLevel,
    );
  }

  private scheduleFiremakingAttempt(
    playerId: string,
    processingAction: RuntimeProcessingAction,
    startPosition: FinitePosition,
    firemakingLevel: number,
  ): void {
    setTimeout(() => {
      if (
        this.destroyed ||
        this.activeProcessing.get(playerId) !== processingAction
      ) {
        if (DEBUG_PROCESSING) {
          console.log(
            `[ProcessingSystem] Firemaking was cancelled for ${playerId}`,
          );
        }
        return;
      }

      if (!canPlayerPerformPreparationAction(this.world, playerId)) {
        this.cancelFiremaking(playerId, processingAction, {
          message: "You can no longer light a fire here.",
          reason: "not_authorized",
          retryable: false,
        });
        return;
      }

      const currentPosition = this.getFinitePlayerPosition(playerId);
      if (
        !currentPosition ||
        this.positionMovedBeyondFiremakingThreshold(
          currentPosition,
          startPosition,
        )
      ) {
        this.cancelFiremaking(playerId, processingAction);
        return;
      }

      if (Math.random() >= calculateFiremakingSuccess(firemakingLevel)) {
        processingAction.startTime = Date.now();
        this.reportProcessingRequestProgress(
          playerId,
          processingAction.requestId,
          "firemaking",
          "working",
        );
        this.scheduleFiremakingAttempt(
          playerId,
          processingAction,
          startPosition,
          firemakingLevel,
        );
        return;
      }

      // Use cached start position - fire spawns where lighting began
      this.completeFiremaking(playerId, processingAction, startPosition);
    }, processingAction.duration);
  }

  /**
   * Cancel firemaking when the player moves during the lighting animation.
   * Cleans up the active action, resets emote, and notifies clients.
   */
  private cancelFiremaking(
    playerId: string,
    action: RuntimeProcessingAction,
    options: {
      message: string;
      reason: "interrupted" | "not_authorized";
      retryable: boolean;
    } = {
      message: "You move and stop trying to light the fire.",
      reason: "interrupted",
      retryable: true,
    },
  ): void {
    this.activeProcessing.delete(playerId);
    clearProcessingInteractionPresentation(this.world, playerId, "firemaking");
    this.releaseFireReservation(playerId, action.startPosition);
    this.releaseAction(action);
    this.resetPlayerEmote(playerId);

    this.emitTypedEvent(EventType.FIRE_LIGHTING_CANCELLED, { playerId });

    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: options.message,
      type: "info",
    });
    this.rejectProcessingRequest(
      playerId,
      action.requestId,
      "firemaking",
      options.reason,
      options.retryable,
    );
  }

  private completeFiremaking(
    playerId: string,
    action: RuntimeProcessingAction,
    position: FinitePosition,
  ): void {
    this.activeProcessing.delete(playerId);
    if (
      !action.targetItem ||
      !canPlayerPerformPreparationAction(this.world, playerId) ||
      this.reservedFireTiles.get(this.fireTileKey(position)) !== playerId ||
      !this.isFireTileAvailable(playerId, position)
    ) {
      this.releaseFireReservation(playerId, position);
      clearProcessingInteractionPresentation(
        this.world,
        playerId,
        "firemaking",
      );
      this.releaseAction(action);
      this.resetPlayerEmote(playerId);
      this.emitTypedEvent(EventType.FIRE_LIGHTING_CANCELLED, { playerId });
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "The fire could not be lit on that tile.",
        type: "warning",
      });
      this.rejectProcessingRequest(
        playerId,
        action.requestId,
        "firemaking",
        "interrupted",
        true,
      );
      return;
    }

    const pending: PendingProcessingCommit = {
      operationId:
        getProcessingRequestOperationId("firemaking", action.requestId) ??
        `firemaking-action:${uuid()}${uuid()}`,
      playerId,
      action,
      kind: "firemaking",
      inputItemId: action.targetItem.id,
      outputItemId: null,
      xpAmount: action.xpReward,
      sourceId: null,
      sourceType: null,
      didBurn: false,
      fireId: action.requestId
        ? `fire_${action.requestId}`
        : `fire_${uuid()}${uuid()}`,
      firePosition: position,
      fireTileKey: this.fireTileKey(position),
      fireDurationMs: getRandomFireDuration() * TICK_DURATION_MS,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      disconnected: false,
      presentationCancelled: false,
      requestId: action.requestId,
    };
    this.pendingCommits.set(playerId, pending);
    this.launchProcessingCommit(pending);
  }

  private createCommittedFire(
    pending: PendingProcessingCommit,
    receipt: Extract<AtomicProcessingActionReceipt, { ok: true }>,
  ): void {
    clearProcessingInteractionPresentation(
      this.world,
      pending.playerId,
      "firemaking",
    );
    const effect = receipt.worldEffect;
    if (
      !effect ||
      !pending.fireId ||
      !pending.firePosition ||
      effect.fireId !== pending.fireId
    ) {
      this.releaseFireReservation(
        pending.playerId,
        pending.firePosition ?? undefined,
      );
      this.finishProcessingRequest(pending.requestId);
      Logger.systemError(
        "ProcessingSystem",
        `Committed Firemaking receipt ${pending.operationId} has no matching durable fire effect`,
      );
      return;
    }
    const fire = this.registerActiveFire({
      ...effect,
      playerId: pending.playerId,
    });
    this.releaseFireReservation(pending.playerId, pending.firePosition);
    this.finishProcessingRequest(pending.requestId);
    if (!fire) {
      Logger.systemError(
        "ProcessingSystem",
        `Committed fire ${effect.fireId} expired before live registration`,
      );
      return;
    }
    this.emitTypedEvent(EventType.FIRE_CREATED, {
      fireId: fire.id,
      playerId: fire.playerId,
      position: fire.position,
      createdAt: fire.createdAt,
      expiresAt: fire.createdAt + fire.duration,
      serverObservedAt: Date.now(),
      ...(pending.requestId ? { requestId: pending.requestId } : {}),
    });

    Logger.system("ProcessingSystem", "firemaking_complete", {
      playerId: pending.playerId,
      operationId: pending.operationId,
      fireId: fire.id,
      replayed: receipt.replayed,
      logsId: pending.inputItemId,
      xpAwarded: receipt.awardedXp,
    });

    if (!pending.disconnected && !pending.presentationCancelled) {
      this.resetPlayerEmote(pending.playerId);
      const moveTarget = this.findFiremakingMoveTarget(pending.firePosition);
      if (moveTarget) {
        this.movePlayerAfterFiremaking(pending.playerId, moveTarget);
      }
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: pending.playerId,
        message: "The fire catches and the logs begin to burn.",
        type: "success",
      });
      if (!receipt.liveInventoryApplied) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            "The fire is safely recorded, but your live inventory needs to resynchronize.",
          type: "warning",
        });
      }
    }
  }

  private getFiniteEntityPosition(entity: unknown): FinitePosition | null {
    if (!entity || typeof entity !== "object") return null;
    const candidate = entity as {
      position?: unknown;
      getPosition?: () => unknown;
    };
    let raw = candidate.position;
    if (!raw && typeof candidate.getPosition === "function") {
      try {
        raw = candidate.getPosition();
      } catch {
        return null;
      }
    }
    if (!raw || typeof raw !== "object") return null;
    const position = raw as Partial<FinitePosition>;
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return null;
    }
    return {
      x: position.x as number,
      y: position.y as number,
      z: position.z as number,
    };
  }

  private isAuthorizedCookingSource(
    playerId: string,
    sourceId: string,
    sourceType: "fire" | "range",
  ): boolean {
    if (!canPlayerPerformPreparationAction(this.world, playerId)) return false;
    const playerPosition = this.getFinitePlayerPosition(playerId);
    if (!playerPosition) return false;

    if (sourceType === "fire") {
      const fire = this.activeFires.get(sourceId);
      if (!fire?.isActive) return false;
      const firePosition = this.getFiniteEntityPosition(fire);
      if (!firePosition) return false;
      return tilesWithinMeleeRange(
        worldToTile(playerPosition.x, playerPosition.z),
        worldToTile(firePosition.x, firePosition.z),
        PROCESSING_CONSTANTS.FIRE.interactionRange,
      );
    }

    const range = this.world.entities.get(sourceId) as
      CookingRangeLike | undefined;
    if (
      !range ||
      range.entityType !== "range" ||
      !this.getFiniteEntityPosition(range) ||
      typeof range.canInteract !== "function"
    ) {
      return false;
    }
    try {
      return range.canInteract(playerId, playerPosition) === true;
    } catch {
      return false;
    }
  }

  private getCookingSourcePosition(
    sourceId: string,
    sourceType: "fire" | "range",
  ): FinitePosition | null {
    return sourceType === "fire"
      ? this.getFiniteEntityPosition(this.activeFires.get(sourceId))
      : this.getFiniteEntityPosition(this.world.entities.get(sourceId));
  }

  private startCooking(data: {
    playerId: string;
    fishSlot: number;
    fireId?: string;
    rangeId?: string;
    sourceType?: "fire" | "range";
    requestId?: string;
  }): void {
    const { playerId, fireId, rangeId, sourceType, requestId } = data;
    let { fishSlot } = data;

    if (!this.world.isServer || this.destroyed) return;

    // Determine cooking source ID
    const cookingSourceId = rangeId || fireId;
    const isRange = sourceType === "range" || !!rangeId;

    if (!cookingSourceId) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "No cooking source specified.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "invalid_request",
      );
      return;
    }

    if (!Number.isSafeInteger(fishSlot) || fishSlot < -1 || fishSlot > 27) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "That cooking request is invalid.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "invalid_request",
      );
      return;
    }

    // Handle fishSlot=-1: find first cookable item slot automatically
    if (fishSlot === -1) {
      fishSlot = this.findCookableSlot(playerId);
      if (fishSlot === -1) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId,
          message: "You have nothing to cook.",
          type: "error",
        });
        this.rejectProcessingRequest(
          playerId,
          requestId,
          "cooking",
          "resources_unavailable",
        );
        return;
      }
    }

    if (DEBUG_PROCESSING) {
      console.log("[ProcessingSystem] 🍳 startCooking called:", {
        playerId,
        fishSlot,
        sourceId: cookingSourceId,
        isRange,
      });
    }

    // Check if player is already processing
    if (
      this.activeProcessing.has(playerId) ||
      this.pendingCommits.has(playerId)
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already doing something.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "busy",
        true,
      );
      return;
    }

    const resolvedSourceType = isRange ? "range" : "fire";
    if (
      !this.isAuthorizedCookingSource(
        playerId,
        cookingSourceId,
        resolvedSourceType,
      )
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You must be next to that cooking source.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "not_authorized",
        true,
      );
      return;
    }

    // Start the cooking process directly
    this.startCookingProcess(
      playerId,
      fishSlot,
      cookingSourceId,
      true,
      resolvedSourceType,
      requestId,
    );
  }

  /**
   * Start cooking a single item.
   * @param isFirstCook - If true, show "You begin cooking" message. If false, cooking silently continues.
   * @param sourceType - The exact authoritative source kind.
   */
  private startCookingProcess(
    playerId: string,
    fishSlot: number,
    sourceId: string,
    isFirstCook: boolean = false,
    sourceType: "fire" | "range" = "fire",
    requestId?: string,
  ): void {
    if (
      this.pendingCommits.has(playerId) ||
      !this.isAuthorizedCookingSource(playerId, sourceId, sourceType)
    ) {
      this.resetPlayerEmote(playerId);
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        this.pendingCommits.has(playerId) ? "busy" : "not_authorized",
        true,
      );
      return;
    }
    // Get the actual item ID from inventory
    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "resources_unavailable",
      );
      return;
    }

    const slotItem = inventory.find(
      (item: { slot?: number; itemId?: string }) => item?.slot === fishSlot,
    );

    if (!slotItem?.itemId) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "resources_unavailable",
      );
      return;
    }

    const rawItemId = String(slotItem.itemId);
    const cookingData = processingDataProvider.getCookingData(rawItemId);

    if (!cookingData) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You can't cook that.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "invalid_request",
      );
      return;
    }

    // Check level requirement
    let cookingLevel = 1;
    const cachedSkills = this.playerSkills.get(playerId);
    if (cachedSkills?.cooking?.level) {
      cookingLevel = cachedSkills.cooking.level;
    } else {
      const player = this.world.getPlayer(playerId);
      const playerSkills = (
        player as { skills?: Record<string, { level: number }> }
      )?.skills;
      if (playerSkills?.cooking?.level) {
        cookingLevel = playerSkills.cooking.level;
      }
    }

    if (cookingLevel < cookingData.levelRequired) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need level ${cookingData.levelRequired} Cooking to cook that.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "cooking",
        "requirements_not_met",
      );
      return;
    }

    // Start cooking process using pooled action object to reduce GC pressure
    const processingAction = this.acquireAction();
    processingAction.playerId = playerId;
    processingAction.actionType = "cooking";
    processingAction.primaryItem = { id: rawItemId, slot: fishSlot };
    processingAction.targetFire = sourceId;
    processingAction.startTime = Date.now();
    processingAction.duration = cookingData.ticks * TICK_DURATION_MS;
    processingAction.xpReward = cookingData.xp;
    processingAction.skillRequired = "cooking";
    processingAction.sourceType = sourceType;
    processingAction.requestId = requestId;

    this.activeProcessing.set(playerId, processingAction);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "cooking",
      targetPosition: this.getCookingSourcePosition(sourceId, sourceType),
    });
    this.reportProcessingRequestProgress(
      playerId,
      requestId,
      "cooking",
      "accepted",
      true,
    );
    // Show processing message only on first cook (classic MMORPG style)
    if (isFirstCook) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You begin cooking...",
        type: "info",
      });
    }

    // classic MMORPG: Player squats/crouches for each cook attempt
    this.setProcessingEmote(playerId);

    // Complete after duration
    setTimeout(() => {
      if (
        this.destroyed ||
        this.activeProcessing.get(playerId) !== processingAction
      ) {
        if (DEBUG_PROCESSING) {
          console.log(
            `[ProcessingSystem] Cooking was cancelled for ${playerId}`,
          );
        }
        return;
      }

      this.completeCooking(playerId, processingAction);
    }, processingAction.duration);
  }

  private completeCooking(
    playerId: string,
    action: RuntimeProcessingAction,
  ): void {
    this.activeProcessing.delete(playerId);
    const sourceId = action.targetFire;
    const sourceType = action.sourceType;
    const rawItemId = String(action.primaryItem.id);
    const cookingData = processingDataProvider.getCookingData(rawItemId);
    if (
      !sourceId ||
      !sourceType ||
      !cookingData ||
      !this.isAuthorizedCookingSource(playerId, sourceId, sourceType)
    ) {
      this.releaseAction(action);
      clearProcessingInteractionPresentation(this.world, playerId, "cooking");
      this.resetPlayerEmote(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are no longer close enough to that cooking source.",
        type: "warning",
      });
      this.rejectProcessingRequest(
        playerId,
        action.requestId,
        "cooking",
        "interrupted",
        true,
      );
      return;
    }

    const cookingLevel = this.getPlayerSkillLevel(playerId, "cooking");
    const stopBurnLevel = cookingData.stopBurnLevel[sourceType];
    const burnChance = this.getBurnChance(
      cookingLevel,
      cookingData.levelRequired,
      stopBurnLevel,
    );
    const didBurn = Math.random() < burnChance;
    const outputItemId = didBurn
      ? cookingData.burntItemId
      : cookingData.cookedItemId;
    const pending: PendingProcessingCommit = {
      operationId:
        getProcessingRequestOperationId("cooking", action.requestId) ??
        `cooking-action:${uuid()}${uuid()}`,
      playerId,
      action,
      kind: "cooking",
      inputItemId: rawItemId,
      outputItemId,
      xpAmount: didBurn ? 0 : cookingData.xp,
      sourceId,
      sourceType,
      didBurn,
      fireId: null,
      firePosition: null,
      fireTileKey: null,
      fireDurationMs: null,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      disconnected: false,
      presentationCancelled: false,
      requestId: action.requestId,
    };
    this.pendingCommits.set(playerId, pending);
    this.launchProcessingCommit(pending);
  }

  /**
   * Check if player has more cookable items and automatically continue cooking.
   * This implements classic MMORPG-style auto-cooking where you cook all items until done.
   * @param sourceType - Exact source kind retained across the batch.
   */
  private tryAutoCookNext(
    playerId: string,
    sourceId: string,
    sourceType: "fire" | "range" = "fire",
    requestId?: string,
  ): void {
    if (!this.isAuthorizedCookingSource(playerId, sourceId, sourceType)) {
      this.resetPlayerEmote(playerId);
      clearProcessingInteractionPresentation(this.world, playerId, "cooking");
      return;
    }

    // Check if player has more cookable items
    const nextSlot = this.findCookableSlot(playerId);
    if (nextSlot === -1) {
      // No more cookable items - cooking complete, reset emote
      this.resetPlayerEmote(playerId);
      clearProcessingInteractionPresentation(this.world, playerId, "cooking");
      return;
    }

    // Continue cooking the next one (not first cook, so no message)
    this.startCookingProcess(
      playerId,
      nextSlot,
      sourceId,
      false,
      sourceType,
      requestId,
    );
  }

  /**
   * Find the first slot containing any cookable item in player's inventory.
   * Uses ProcessingDataProvider (derived from items.json manifest) as source of truth.
   * Returns -1 if no cookable item found.
   */
  private findCookableSlot(playerId: string): number {
    // Use world.getInventory to get player inventory (returns array directly)
    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) {
      return -1;
    }

    // Find first slot with any cookable item (using manifest source of truth)
    for (let i = 0; i < inventory.length; i++) {
      const item = inventory[i] as { itemId?: string; slot?: number };
      if (
        item &&
        item.itemId &&
        processingDataProvider.isCookable(item.itemId)
      ) {
        return item.slot ?? i;
      }
    }

    return -1;
  }

  private getPlayerSkillLevel(playerId: string, skill: string): number {
    const cachedLevel = this.playerSkills.get(playerId)?.[skill]?.level;
    if (Number.isSafeInteger(cachedLevel) && cachedLevel! > 0) {
      return cachedLevel!;
    }
    const player = this.world.getPlayer(playerId) as
      { skills?: Record<string, { level?: unknown }> } | undefined;
    const level = Number(player?.skills?.[skill]?.level ?? 1);
    return Number.isSafeInteger(level) && level > 0 ? level : 1;
  }

  private launchProcessingCommit(pending: PendingProcessingCommit): void {
    const inventory = this.world.getSystem("inventory") as
      InventorySystem | undefined;
    if (!inventory?.commitProcessingActionAtomic) {
      this.scheduleProcessingRetry(pending);
      return;
    }

    let worldEffect: ProcessingActionFireEffectRequest | undefined;
    if (
      pending.kind === "firemaking" &&
      pending.fireId &&
      pending.firePosition &&
      pending.fireDurationMs
    ) {
      worldEffect = {
        kind: "fire",
        fireId: pending.fireId,
        position: pending.firePosition,
        tile: worldToTile(pending.firePosition.x, pending.firePosition.z),
        durationMs: pending.fireDurationMs,
      };
    }
    if (pending.kind === "firemaking" && !worldEffect) {
      this.finishFailedProcessingCommit(pending, "invalid_fire_effect");
      return;
    }

    pending.state = "in_flight";
    void inventory
      .commitProcessingActionAtomic(pending.playerId, pending.operationId, {
        skill: pending.kind,
        xpAmount: pending.xpAmount,
        inputs: [{ itemId: pending.inputItemId, quantity: 1 }],
        requiredItems:
          pending.kind === "firemaking"
            ? [{ itemId: "tinderbox", quantity: 1 }]
            : [],
        consumables: [],
        outputs: pending.outputItemId
          ? [{ itemId: pending.outputItemId, quantity: 1 }]
          : [],
        ...(worldEffect ? { worldEffect } : {}),
      })
      .then((receipt) => {
        if (
          this.destroyed ||
          this.pendingCommits.get(pending.playerId) !== pending
        ) {
          return;
        }
        pending.receipt = receipt;
        pending.state = "settled";
      })
      .catch(() => {
        if (
          this.destroyed ||
          this.pendingCommits.get(pending.playerId) !== pending
        ) {
          return;
        }
        this.scheduleProcessingRetry(pending);
      });
  }

  private scheduleProcessingRetry(pending: PendingProcessingCommit): void {
    pending.retryCount++;
    pending.retryAtTick =
      (this.world.currentTick ?? 0) +
      Math.min(2 ** Math.min(pending.retryCount, 6), 50);
    pending.receipt = null;
    pending.state = "retry_wait";
    this.reportProcessingRequestProgress(
      pending.playerId,
      pending.requestId,
      pending.kind,
      "reconciling",
      true,
    );
  }

  private processPendingCommits(currentTick: number): void {
    for (const pending of this.pendingCommits.values()) {
      this.reportProcessingRequestProgress(
        pending.playerId,
        pending.requestId,
        pending.kind,
        pending.state === "retry_wait" ? "reconciling" : "working",
      );
      if (
        pending.state === "retry_wait" &&
        currentTick >= pending.retryAtTick
      ) {
        this.launchProcessingCommit(pending);
        continue;
      }
      if (pending.state !== "settled" || !pending.receipt) continue;

      const receipt = pending.receipt;
      if (!receipt.ok) {
        if (receipt.retryable) {
          this.scheduleProcessingRetry(pending);
          continue;
        }
        this.finishFailedProcessingCommit(pending, receipt.reason);
        continue;
      }

      if (receipt.xpAmount > 0) {
        this.emitTypedEvent(EventType.SKILLS_PROGRESS_COMMITTED, {
          playerId: receipt.playerId,
          operationId: receipt.operationId,
          replayed: receipt.replayed,
          skill: receipt.skill,
          xpAmount: receipt.xpAmount,
          awardedXp: receipt.awardedXp,
          operationCommittedXp: receipt.operationCommittedXp,
          currentXp: receipt.currentXp,
          currentLevel: receipt.currentLevel,
        });
      }
      this.pendingCommits.delete(pending.playerId);
      if (pending.kind === "firemaking") {
        this.createCommittedFire(pending, receipt);
      } else {
        this.finishCommittedCooking(pending, receipt);
      }
      this.releaseAction(pending.action);
    }
  }

  private finishFailedProcessingCommit(
    pending: PendingProcessingCommit,
    reason: string,
  ): void {
    this.pendingCommits.delete(pending.playerId);
    clearProcessingInteractionPresentation(
      this.world,
      pending.playerId,
      pending.kind,
    );
    if (pending.kind === "firemaking") {
      this.releaseFireReservation(
        pending.playerId,
        pending.firePosition ?? undefined,
      );
      this.emitTypedEvent(EventType.FIRE_LIGHTING_CANCELLED, {
        playerId: pending.playerId,
      });
    }
    this.releaseAction(pending.action);

    Logger.system("ProcessingSystem", "processing_commit_rejected", {
      playerId: pending.playerId,
      operationId: pending.operationId,
      kind: pending.kind,
      reason,
    });
    this.finishProcessingRequest(pending.requestId);
    if (pending.disconnected || pending.presentationCancelled) return;
    this.resetPlayerEmote(pending.playerId);
    const message =
      reason === "inventory_full"
        ? "Your inventory is too full for that result."
        : reason === "fire_tile_occupied"
          ? "Another fire already occupies that tile."
          : reason === "fire_capacity_reached"
            ? "You already have too many active fires."
            : reason === "insufficient_items"
              ? pending.kind === "firemaking"
                ? "You no longer have the selected logs and tinderbox."
                : "You no longer have that raw food."
              : "That processing action could not be validated.";
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: pending.playerId,
      message,
      type: "warning",
    });
    this.rejectProcessingRequest(
      pending.playerId,
      pending.requestId,
      pending.kind,
      reason === "inventory_full"
        ? "capacity_unavailable"
        : reason === "fire_capacity_reached"
          ? "capacity_unavailable"
          : reason === "fire_tile_occupied"
            ? "not_authorized"
            : reason === "insufficient_items"
              ? "resources_unavailable"
              : "persistence_rejected",
    );
  }

  private finishCommittedCooking(
    pending: PendingProcessingCommit,
    receipt: Extract<AtomicProcessingActionReceipt, { ok: true }>,
  ): void {
    if (!pending.outputItemId) return;
    this.finishProcessingRequest(pending.requestId);
    this.emitTypedEvent(EventType.COOKING_COMPLETED, {
      playerId: pending.playerId,
      rawItemId: pending.inputItemId,
      resultItemId: pending.outputItemId,
      wasBurnt: pending.didBurn,
      result: pending.didBurn ? "burnt" : "cooked",
      itemCreated: pending.outputItemId,
      xpGained: receipt.awardedXp,
      ...(pending.requestId ? { requestId: pending.requestId } : {}),
    });
    Logger.system("ProcessingSystem", "cooking_complete", {
      playerId: pending.playerId,
      operationId: pending.operationId,
      replayed: receipt.replayed,
      inputItemId: pending.inputItemId,
      outputItemId: pending.outputItemId,
      didBurn: pending.didBurn,
      xpAwarded: receipt.awardedXp,
      sourceId: pending.sourceId,
      sourceType: pending.sourceType,
    });

    if (pending.disconnected) return;
    const foodName = pending.inputItemId.replace(/^raw_/, "");
    if (!pending.presentationCancelled) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: pending.playerId,
        message: pending.didBurn
          ? `You accidentally burn the ${foodName}.`
          : `You roast a ${foodName}.`,
        type: pending.didBurn ? "warning" : "success",
      });
    }
    if (!receipt.liveInventoryApplied) {
      if (!pending.presentationCancelled) {
        this.resetPlayerEmote(pending.playerId);
      }
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: pending.playerId,
        message:
          "The cooking result is safely recorded, but your live inventory needs to resynchronize.",
        type: "warning",
      });
      clearProcessingInteractionPresentation(
        this.world,
        pending.playerId,
        "cooking",
      );
      return;
    }
    if (pending.presentationCancelled) return;
    if (!pending.requestId && pending.sourceId && pending.sourceType) {
      this.tryAutoCookNext(
        pending.playerId,
        pending.sourceId,
        pending.sourceType,
        pending.requestId,
      );
    } else {
      this.resetPlayerEmote(pending.playerId);
      clearProcessingInteractionPresentation(
        this.world,
        pending.playerId,
        "cooking",
      );
    }
  }

  getProcessingCustodyStats(): {
    activeActions: number;
    pendingCommits: number;
    inFlight: number;
    retryWaiting: number;
    reservedFireTiles: number;
    maxRetryCount: number;
    pendingFireExpiries: number;
    fireExpiryInFlight: number;
    fireExpiryRetryWaiting: number;
    fireExpiryBlocked: number;
    maxFireExpiryRetryCount: number;
  } {
    let inFlight = 0;
    let retryWaiting = 0;
    let maxRetryCount = 0;
    for (const pending of this.pendingCommits.values()) {
      if (pending.state === "in_flight") inFlight++;
      if (pending.state === "retry_wait") retryWaiting++;
      maxRetryCount = Math.max(maxRetryCount, pending.retryCount);
    }
    let fireExpiryInFlight = 0;
    let fireExpiryRetryWaiting = 0;
    let fireExpiryBlocked = 0;
    let maxFireExpiryRetryCount = 0;
    for (const pending of this.pendingFireExpirySettlements.values()) {
      if (pending.state === "in_flight") fireExpiryInFlight++;
      if (pending.state === "retry_wait") fireExpiryRetryWaiting++;
      if (pending.state === "blocked") fireExpiryBlocked++;
      maxFireExpiryRetryCount = Math.max(
        maxFireExpiryRetryCount,
        pending.retryCount,
      );
    }
    return {
      activeActions: this.activeProcessing.size,
      pendingCommits: this.pendingCommits.size,
      inFlight,
      retryWaiting,
      reservedFireTiles: this.reservedFireTiles.size,
      maxRetryCount,
      pendingFireExpiries: this.pendingFireExpirySettlements.size,
      fireExpiryInFlight,
      fireExpiryRetryWaiting,
      fireExpiryBlocked,
      maxFireExpiryRetryCount,
    };
  }

  /**
   * Calculate burn chance based on cooking level and food-specific parameters.
   * Uses rules-accurate linear interpolation.
   *
   * @param cookingLevel - Player's cooking level
   * @param requiredLevel - Level required to cook this food
   * @param stopBurnLevel - Level at which burning stops for this food
   * @param maxBurnChance - Maximum burn chance at minimum level (default 0.5 = 50%)
   */
  private getBurnChance(
    cookingLevel: number,
    requiredLevel: number,
    stopBurnLevel: number,
    maxBurnChance: number = 0.5,
  ): number {
    // At or above stop level: never burn
    if (cookingLevel >= stopBurnLevel) {
      return 0;
    }

    // Below required level shouldn't happen, but treat as max burn chance
    if (cookingLevel < requiredLevel) {
      return maxBurnChance;
    }

    // Linear interpolation: burn chance decreases as level increases
    const levelRange = stopBurnLevel - requiredLevel;
    if (levelRange <= 0) {
      return 0; // Edge case: stop burn level <= required level
    }

    const levelsUntilStopBurn = stopBurnLevel - cookingLevel;
    const burnChance = (levelsUntilStopBurn / levelRange) * maxBurnChance;

    return Math.max(0, Math.min(maxBurnChance, burnChance));
  }

  private async createFireVisual(fire: Fire): Promise<void> {
    // Only create visuals on client
    if (!this.world.isClient) return;

    if (DEBUG_PROCESSING) {
      console.log("[ProcessingSystem] createFireVisual called for:", fire.id);
    }

    let model: THREE.Object3D | null = null;

    // Check if we already loaded the model during the lighting phase
    const pending = this.pendingFireModels.get(fire.playerId);
    if (pending) {
      model = pending;
      this.pendingFireModels.delete(fire.playerId);
    } else {
      // Load model fresh (late join / missed lighting event)
      try {
        const result = await modelCache.loadModel(
          "asset://models/misc/firemaking-fire/firemaking-fire.glb",
          this.world,
        );
        model = result.scene;
        const s = ProcessingSystem.FIRE_MODEL_SCALE;
        model.scale.set(s, s, s);
        // Bbox-snap: place model bottom on terrain
        const bbox = new THREE.Box3().setFromObject(model);
        model.position.set(
          fire.position.x,
          fire.position.y - bbox.min.y,
          fire.position.z,
        );
        this.world.stage.scene.add(model);
      } catch (err) {
        console.warn(
          "[ProcessingSystem] Failed to load fire model, using placeholder:",
          err,
        );
        this.createPlaceholderFireMesh(fire);
        return;
      }
    }

    // Guard: fire may have been extinguished during async model load
    if (!fire.isActive) {
      this.world.stage.scene.remove(model);
      return;
    }

    model.name = `Fire_${fire.id}`;
    model.userData = {
      type: "fire",
      entityId: fire.id,
      fireId: fire.id,
      playerId: fire.playerId,
      name: "Fire",
    };
    model.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        child.layers.set(1);
      }
    });

    fire.mesh = model;

    // Spawn particle fire effect rising from center of model
    this.createFireParticles(fire);
  }

  /**
   * Load fire GLB model during the 3s lighting animation (client-only).
   */
  private async loadFireModelForLighting(
    playerId: string,
    position: { x: number; y: number; z: number },
  ): Promise<void> {
    try {
      const result = await modelCache.loadModel(
        "asset://models/misc/firemaking-fire/firemaking-fire.glb",
        this.world,
      );

      const model = result.scene;
      model.name = `FireLighting_${playerId}`;
      const s = ProcessingSystem.FIRE_MODEL_SCALE;
      model.scale.set(s, s, s);
      // Bbox-snap: place model bottom on terrain
      const bbox = new THREE.Box3().setFromObject(model);
      model.position.set(position.x, position.y - bbox.min.y, position.z);
      model.userData = { type: "fireLighting", playerId };
      model.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          child.layers.set(1);
        }
      });

      this.world.stage.scene.add(model);
      this.pendingFireModels.set(playerId, model);
    } catch (err) {
      console.warn(
        "[ProcessingSystem] Failed to load fire model for lighting:",
        err,
      );
    }
  }

  /** Access the ParticleSystem registered as "particle". */
  private getParticleSystem(): ParticleSystem | undefined {
    return this.world.getSystem("particle") as ParticleSystem | undefined;
  }

  /**
   * Create fire particle effect via ParticleSystem (GPU-instanced).
   * Uses the "fire" preset which manages 18 rising/spreading warm-coloured particles.
   */
  private createFireParticles(fire: Fire): void {
    if (!this.world.isClient) return;

    const ps = this.getParticleSystem();
    if (!ps) return;

    const emitterId = `fire_${fire.id}`;

    ps.register(emitterId, {
      type: "glow",
      preset: "fire",
      position: fire.position,
    });

    // Store cleanup that unregisters from ParticleSystem
    const fireExt = fire as {
      fireParticleMeshes?: THREE.Mesh[];
      cancelFireParticles?: () => void;
    };
    fireExt.fireParticleMeshes = [];
    fireExt.cancelFireParticles = () => {
      const psRef = this.getParticleSystem();
      if (psRef) {
        psRef.unregister(emitterId);
      }
    };
  }

  /**
   * Fallback placeholder fire mesh (orange box) when GLB model fails to load.
   * Uses MeshBasicNodeMaterial for WebGPU compatibility.
   */
  private createPlaceholderFireMesh(fire: Fire): void {
    const fireGeometry = new THREE.BoxGeometry(0.5, 0.8, 0.5);
    const fireMaterial = new MeshBasicNodeMaterial();
    fireMaterial.color = new THREE.Color(0xff4500);
    fireMaterial.transparent = true;
    fireMaterial.opacity = 0.8;

    const fireMesh = new THREE.Mesh(fireGeometry, fireMaterial);
    fireMesh.name = `Fire_${fire.id}`;
    fireMesh.position.set(
      fire.position.x,
      fire.position.y + ProcessingSystem.FIRE_PLACEHOLDER_Y_OFFSET,
      fire.position.z,
    );
    fireMesh.userData = {
      type: "fire",
      entityId: fire.id,
      fireId: fire.id,
      playerId: fire.playerId,
      name: "Fire",
    };
    fireMesh.layers.set(1);

    let animationFrameId: number | null = null;
    if (typeof requestAnimationFrame !== "undefined") {
      const animate = () => {
        if (fire.isActive && fire.mesh) {
          fireMaterial.opacity = 0.6 + Math.sin(Date.now() * 0.01) * 0.2;
          animationFrameId = requestAnimationFrame(animate);
        } else {
          animationFrameId = null;
        }
      };
      animate();
    }

    (fire as { cancelAnimation?: () => void }).cancelAnimation = () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    fire.mesh = fireMesh as THREE.Object3D;
    this.world.stage.scene.add(fireMesh);
  }

  /** Remove one fire from this process without changing durable ownership. */
  private removeFireLocally(fireId: string): Fire | null {
    const fire = this.activeFires.get(fireId);
    if (!fire?.isActive) return null;

    fire.isActive = false;

    // Cancel animation before removing mesh to prevent requestAnimationFrame leak
    const fireWithAnimation = fire as { cancelAnimation?: () => void };
    fireWithAnimation.cancelAnimation?.();

    // Destroy fire particle meshes
    const fireWithParticles = fire as { cancelFireParticles?: () => void };
    if (fireWithParticles.cancelFireParticles) {
      fireWithParticles.cancelFireParticles();
      fireWithParticles.cancelFireParticles = undefined;
    }

    // Remove visual and dispose THREE.js resources (only exists on client)
    if (fire.mesh && this.world.isClient) {
      this.world.stage.scene.remove(fire.mesh);

      // Traverse and dispose all geometries and materials (GLB models have multiple children)
      fire.mesh.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) {
            const materials = Array.isArray(mesh.material)
              ? mesh.material
              : [mesh.material];
            for (const mat of materials) {
              if (!modelCache.isManagedMaterial(mat as THREE.Material)) {
                (mat as THREE.Material).dispose();
              }
            }
          }
        }
      });

      // Clear reference for GC
      fire.mesh = undefined;
    }

    this.activeFires.delete(fireId);
    this.fireLocalExpiryDeadlines.delete(fireId);

    // cleanup timer
    clearTimeout(this.fireCleanupTimers.get(fireId));
    this.fireCleanupTimers.delete(fireId);

    return fire;
  }

  private async extinguishFire(fireId: string): Promise<void> {
    const fire = this.removeFireLocally(fireId);
    if (!fire || this.world.isClient || this.destroyed) return;

    // Every hosting process tells its own clients to remove the visual.
    this.emitTypedEvent(EventType.FIRE_EXTINGUISHED, {
      fireId,
    });

    this.launchFireExpirySettlement({
      kind: "fire",
      fireId: fire.id,
      playerId: fire.playerId,
      position: { ...fire.position },
      tile: worldToTile(fire.position.x, fire.position.z),
      createdAt: fire.createdAt,
      expiresAt: fire.createdAt + fire.duration,
    });
  }

  /**
   * Own one runtime expiry until its exact database operation settles. The
   * visual fire is already gone; this queue protects the durable fire/ash
   * transition from disappearing after a bounded response-loss retry window.
   */
  private launchFireExpirySettlement(effect: ActiveProcessingFire): void {
    if (this.destroyed || this.world.isClient) return;
    const existing = this.pendingFireExpirySettlements.get(effect.fireId);
    if (existing?.state === "in_flight" || existing?.state === "blocked") {
      return;
    }
    this.pendingFireExpirySettlements.set(effect.fireId, {
      effect: {
        ...effect,
        position: { ...effect.position },
        tile: { ...effect.tile },
      },
      retryCount: existing?.retryCount ?? 0,
      retryAt: Date.now(),
      state: "in_flight",
      lastError: existing?.lastError ?? "",
    });
    void this.settleFireExpiry(effect, false);
  }

  private scheduleFireExpiryRetry(
    effect: ActiveProcessingFire,
    error: unknown,
  ): void {
    if (this.destroyed) return;
    const previous = this.pendingFireExpirySettlements.get(effect.fireId);
    const retryCount = (previous?.retryCount ?? 0) + 1;
    const delay = Math.min(
      FIRE_EXPIRY_RETRY_BASE_MS * 2 ** Math.min(retryCount - 1, 30),
      FIRE_EXPIRY_RETRY_MAX_MS,
    );
    this.pendingFireExpirySettlements.set(effect.fireId, {
      effect: previous?.effect ?? {
        ...effect,
        position: { ...effect.position },
        tile: { ...effect.tile },
      },
      retryCount,
      retryAt: Date.now() + delay,
      state: "retry_wait",
      lastError: error instanceof Error ? error.message : String(error),
    });
    Logger.system("ProcessingSystem", "fire_expiry_reconciliation_scheduled", {
      fireId: effect.fireId,
      operationId: getProcessingFireExtinguishOperationId(effect.fireId),
      retryCount,
      retryInMs: delay,
    });
  }

  private processPendingFireExpirySettlements(now: number): void {
    for (const pending of this.pendingFireExpirySettlements.values()) {
      if (pending.state !== "retry_wait" || pending.retryAt > now) continue;
      this.launchFireExpirySettlement(pending.effect);
    }
  }

  private async settleFireExpiry(
    effect: ActiveProcessingFire,
    failStartup: boolean,
  ): Promise<void> {
    const groundItems = this.world.getSystem<GroundItemSystem>("ground-items");
    const database = this.getDatabaseSystem();
    try {
      if (!groundItems) {
        throw new Error(
          "processing_fire_extinguish_source_authority_unavailable",
        );
      }
      if (!database) {
        const sourceId = await groundItems.spawnGroundItem(
          "ashes",
          1,
          effect.position,
          { despawnTime: ASH_SOURCE_LIFETIME_MS },
        );
        if (!sourceId) {
          throw new Error(
            "processing_fire_extinguish_diagnostic_source_rejected",
          );
        }
        return;
      }
      if (!database.commitProcessingFireExtinguishOperationAsync) {
        throw new Error(
          "processing_fire_extinguish_database_authority_incomplete",
        );
      }
      const source = await groundItems.prepareDurableSourceRegistration(
        "ashes",
        1,
        effect.position,
        { despawnTime: ASH_SOURCE_LIFETIME_MS },
      );
      if (!source) {
        throw new Error("processing_fire_extinguish_source_plan_unavailable");
      }
      const identity = {
        operationId: getProcessingFireExtinguishOperationId(effect.fireId),
        fireId: effect.fireId,
        playerId: effect.playerId,
        position: { ...effect.position },
        expiresAt: effect.expiresAt,
      };
      const request: ProcessingFireExtinguishCommitRequest = {
        ...identity,
        requestFingerprint: await sha256Hex(
          serializeProcessingFireExtinguishFingerprint(identity),
        ),
        source,
      };
      const receipt = await this.commitFireExpiryWithExactRetry(
        request.operationId,
        () => database.commitProcessingFireExtinguishOperationAsync!(request),
      );
      this.assertFireExtinguishReceipt(request, receipt);
      try {
        const exposed = await groundItems.exposeCommittedDurableSource(
          receipt.source,
        );
        if (!exposed) {
          Logger.systemError(
            "ProcessingSystem",
            `Ash source ${receipt.source.sourceId} committed with deferred presentation`,
          );
        }
      } catch (error) {
        Logger.systemError(
          "ProcessingSystem",
          `Ash source ${receipt.source.sourceId} committed but presentation failed: ${String(error)}`,
        );
      }
      if (!failStartup) {
        this.pendingFireExpirySettlements.delete(effect.fireId);
      }
    } catch (error) {
      Logger.systemError(
        "ProcessingSystem",
        `Failed to atomically extinguish fire ${effect.fireId}: ${String(error)}`,
      );
      if (failStartup) throw error;
      if (isDefinitiveFireExtinguishError(error)) {
        const previous = this.pendingFireExpirySettlements.get(effect.fireId);
        this.pendingFireExpirySettlements.set(effect.fireId, {
          effect: previous?.effect ?? {
            ...effect,
            position: { ...effect.position },
            tile: { ...effect.tile },
          },
          retryCount: previous?.retryCount ?? 0,
          retryAt: Number.POSITIVE_INFINITY,
          state: "blocked",
          lastError: error instanceof Error ? error.message : String(error),
        });
      } else {
        this.scheduleFireExpiryRetry(effect, error);
      }
    } finally {
      if (failStartup) {
        this.emitTypedEvent(EventType.FIRE_EXTINGUISHED, {
          fireId: effect.fireId,
        });
      }
    }
  }

  private assertFireExtinguishReceipt(
    request: ProcessingFireExtinguishCommitRequest,
    receipt: ProcessingFireExtinguishCommitReceipt,
  ): void {
    const source = receipt.sourceRequest;
    if (
      receipt.operationId !== request.operationId ||
      receipt.fireId !== request.fireId ||
      receipt.playerId !== request.playerId ||
      receipt.requestFingerprint !== request.requestFingerprint ||
      typeof receipt.replayed !== "boolean" ||
      JSON.stringify(receipt.position) !== JSON.stringify(request.position) ||
      receipt.expiresAt !== request.expiresAt ||
      !Number.isSafeInteger(receipt.extinguishedAt) ||
      receipt.extinguishedAt < receipt.expiresAt ||
      !source ||
      source.itemId !== "ashes" ||
      source.quantity !== 1 ||
      source.droppedBy !== null ||
      source.lootProtectionMs !== 0 ||
      source.lifetimeMs !== ASH_SOURCE_LIFETIME_MS ||
      !receipt.source ||
      receipt.source.contributionId !== source.contributionId ||
      receipt.source.requestFingerprint !== source.requestFingerprint
    ) {
      throw new Error("processing_fire_extinguish_receipt_invalid");
    }
  }

  private async commitFireExpiryWithExactRetry<T>(
    operationId: string,
    commit: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        return await commit();
      } catch (error) {
        if (isDefinitiveFireExtinguishError(error)) throw error;
        lastError = error;
        if (attempt < 8) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 5_000));
          });
        }
      }
    }
    throw new Error(
      `processing_fire_extinguish_commit_unknown:${operationId}`,
      {
        cause: lastError,
      },
    );
  }

  private cleanupPlayer(data: { id: string }): void {
    const playerId = data.id;
    clearProcessingInteractionPresentation(this.world, playerId);

    const action = this.activeProcessing.get(playerId);
    this.activeProcessing.delete(playerId);
    if (action) {
      this.finishProcessingRequest(action.requestId);
      if (action.actionType === "firemaking") {
        this.releaseFireReservation(playerId, action.startPosition);
        this.emitTypedEvent(EventType.FIRE_LIGHTING_CANCELLED, { playerId });
      }
      this.releaseAction(action);
    }
    const pending = this.pendingCommits.get(playerId);
    if (pending) pending.disconnected = true;
    this.playerSkills.delete(playerId);

    // Remove pending fire model (cancelled during lighting)
    const pendingModel = this.pendingFireModels.get(playerId);
    if (pendingModel && this.world.isClient) {
      this.world.stage.scene.remove(pendingModel);
      this.pendingFireModels.delete(playerId);
    }

    // Existing fires are world state and continue burning after their owner
    // disconnects. A committed in-flight fire is also reconciled exactly once.
  }

  private cancelPendingProcessingPresentation(playerId: string): void {
    const action = this.activeProcessing.get(playerId);
    if (action) {
      if (action.actionType === "firemaking") {
        this.cancelFiremaking(playerId, action);
      } else {
        this.activeProcessing.delete(playerId);
        clearProcessingInteractionPresentation(this.world, playerId, "cooking");
        this.resetPlayerEmote(playerId);
        this.rejectProcessingRequest(
          playerId,
          action.requestId,
          "cooking",
          "interrupted",
          true,
        );
        this.releaseAction(action);
      }
      return;
    }
    const pending = this.pendingCommits.get(playerId);
    if (!pending || pending.presentationCancelled) return;

    pending.presentationCancelled = true;
    clearProcessingInteractionPresentation(this.world, playerId, pending.kind);
    this.resetPlayerEmote(playerId);
    if (pending.kind === "firemaking") {
      this.emitTypedEvent(EventType.FIRE_LIGHTING_CANCELLED, { playerId });
    }
  }

  // Public API

  /**
   * Get IDs of all active fires (for TargetValidator FireRegistry)
   */
  getActiveFireIds(): string[] {
    return Array.from(this.activeFires.entries())
      .filter(([_, fire]) => fire.isActive)
      .map(([id]) => id);
  }

  getActiveFires(): Map<string, Fire> {
    return new Map(this.activeFires);
  }

  /** Exact authoritative fire payloads for players and stream viewers joining late. */
  getActiveFirePayloads(): Array<{
    fireId: string;
    playerId: string;
    position: FinitePosition;
    createdAt: number;
    expiresAt: number;
  }> {
    return [...this.activeFires.values()]
      .filter(
        (fire) =>
          fire.isActive &&
          (this.fireLocalExpiryDeadlines.get(fire.id) ?? 0) > Date.now(),
      )
      .map((fire) => ({
        fireId: fire.id,
        playerId: fire.playerId,
        position: fire.position,
        createdAt: fire.createdAt,
        expiresAt: fire.createdAt + fire.duration,
      }));
  }

  getFires(): Fire[] {
    return Array.from(this.activeFires.values());
  }

  getPlayerFires(playerId: string): Fire[] {
    return Array.from(this.activeFires.values()).filter(
      (fire) => fire.playerId === playerId && fire.isActive,
    );
  }

  canPlayerUseCookingSource(
    playerId: string,
    sourceId: string,
    sourceType: "fire" | "range",
  ): boolean {
    return (
      this.world.isServer &&
      !this.destroyed &&
      this.isAuthorizedCookingSource(playerId, sourceId, sourceType)
    );
  }

  canPlayerLightFireHere(playerId: string): boolean {
    if (
      !this.world.isServer ||
      this.destroyed ||
      !canPlayerPerformPreparationAction(this.world, playerId) ||
      this.isPlayerProcessing(playerId) ||
      this.countPlayerFires(playerId) +
        this.countPlayerReservedFires(playerId) >=
        this.MAX_FIRES_PER_PLAYER
    ) {
      return false;
    }
    const position = this.getFinitePlayerPosition(playerId);
    return !!position && this.isFireTileAvailable(playerId, position);
  }

  isPlayerProcessing(playerId: string): boolean {
    return (
      this.activeProcessing.has(playerId) || this.pendingCommits.has(playerId)
    );
  }

  /** Stop pre-commit work and suppress presentation/batching after settlement. */
  requestPlayerProcessingQuiescence(playerId: string): void {
    this.cancelPendingProcessingPresentation(playerId);
  }

  isPlayerProcessingQuiescent(playerId: string): boolean {
    return !this.isPlayerProcessing(playerId);
  }

  getFiresInRange(
    position: { x: number; y: number; z: number },
    range: number,
  ): Fire[] {
    return Array.from(this.activeFires.values()).filter((fire) => {
      if (!fire.isActive) return false;
      const distance = calculateDistance2D(fire.position, position);
      return distance <= range;
    });
  }

  /**
   * Check if there's an active fire at a given tile position
   */
  hasFireAtTile(tile: TileCoord): boolean {
    for (const [, fire] of this.activeFires) {
      if (!fire.isActive) continue;
      const fireTile = worldToTile(fire.position.x, fire.position.z);
      if (fireTile.x === tile.x && fireTile.z === tile.z) {
        return true;
      }
    }
    return false;
  }

  // === FIREMAKING MOVEMENT (rules-accurate) ===

  /**
   * Find the tile to move to after lighting a fire (rules-accurate)
   * Priority: West → East → South → North
   *
   */
  private findFiremakingMoveTarget(firePosition: {
    x: number;
    y: number;
    z: number;
  }): { x: number; y: number; z: number } | null {
    const fireTile = worldToTile(firePosition.x, firePosition.z);

    for (const offset of this.FIREMAKING_MOVE_PRIORITY) {
      const targetTile: TileCoord = {
        x: fireTile.x + offset.dx,
        z: fireTile.z + offset.dz,
      };

      // Check if tile is walkable (no fires, no terrain blockers)
      if (this.isTileWalkableForFiremaking(targetTile)) {
        const worldPos = tileToWorld(targetTile);
        return { x: worldPos.x, y: firePosition.y, z: worldPos.z };
      }
    }

    // All 4 directions blocked - stay in place
    return null;
  }

  /**
   * Check if a tile is walkable for firemaking movement
   */
  private isTileWalkableForFiremaking(tile: TileCoord): boolean {
    if (this.hasFireAtTile(tile)) {
      return false;
    }
    if (this.reservedFireTiles.has(`${tile.x}:${tile.z}`)) return false;
    try {
      return this.world.collision.isWalkable(tile.x, tile.z);
    } catch {
      return false;
    }
  }

  /**
   * Move player to target tile after lighting fire
   * Emits FIREMAKING_MOVE_REQUEST event for ServerNetwork to handle via playerTeleport packet
   */
  private movePlayerAfterFiremaking(
    playerId: string,
    target: { x: number; y: number; z: number },
  ): void {
    if (DEBUG_PROCESSING) {
      console.log(
        `[ProcessingSystem] 🔥 Moving player ${playerId} after firemaking to (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`,
      );
    }

    // Emit event for ServerNetwork to handle - it will send playerTeleport packet
    // which properly syncs position to client and resets tile movement state
    this.emitTypedEvent(EventType.FIREMAKING_MOVE_REQUEST, {
      playerId,
      position: { x: target.x, y: target.y, z: target.z },
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const playerId of new Set([
      ...this.activeProcessing.keys(),
      ...this.pendingCommits.keys(),
    ])) {
      clearProcessingInteractionPresentation(this.world, playerId);
    }
    // Process shutdown is not a world expiry: preserve durable fires for recovery.
    for (const fireId of [...this.activeFires.keys()]) {
      this.removeFireLocally(fireId);
    }

    // Clean up pending fire models
    if (this.world.isClient) {
      for (const model of this.pendingFireModels.values()) {
        this.world.stage.scene.remove(model);
      }
    }
    this.pendingFireModels.clear();

    // Clear timers
    this.fireCleanupTimers.forEach((timer) => clearTimeout(timer));

    this.activeProcessing.clear();
    this.pendingCommits.clear();
    this.pendingFireExpirySettlements.clear();
    this.reservedFireTiles.clear();
    this.fireLocalExpiryDeadlines.clear();
    this.playerSkills.clear();
    this.fireCleanupTimers.clear();
  }

  // Movement threshold squared (0.5 units) for cancelling firemaking
  private static readonly FIREMAKING_MOVE_THRESHOLD_SQ = 0.25;

  private positionMovedBeyondFiremakingThreshold(
    current: FinitePosition,
    start: FinitePosition,
  ): boolean {
    const dx = current.x - start.x;
    const dz = current.z - start.z;
    return dx * dx + dz * dz > ProcessingSystem.FIREMAKING_MOVE_THRESHOLD_SQ;
  }

  // Required System lifecycle methods
  update(_dt: number): void {
    if (!this.world.isServer || this.destroyed) return;
    this.processPendingCommits(this.world.currentTick ?? 0);
    this.processPendingFireExpirySettlements(Date.now());

    for (const [playerId, action] of this.activeProcessing.entries()) {
      this.reportProcessingRequestProgress(
        playerId,
        action.requestId,
        action.actionType,
        "working",
      );
      // Cancel firemaking if player moved from start position
      if (action.actionType === "firemaking" && action.startPosition) {
        const position = this.getFinitePlayerPosition(playerId);
        if (
          !position ||
          this.positionMovedBeyondFiremakingThreshold(
            position,
            action.startPosition,
          )
        ) {
          this.cancelFiremaking(playerId, action);
        }
      }
    }
  }

  // Empty lifecycle methods removed for cleaner code
}
