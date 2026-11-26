/**
 * Processing / Skill Handlers
 *
 * Handles all processing-skill-related packet handlers:
 * - Firemaking (lighting fires from logs)
 * - Cooking (raw food on fire/range)
 * - Smelting (bars at furnace)
 * - Smithing (items at anvil)
 * - Crafting (needle, chisel, furnace jewelry)
 * - Fletching (knife on logs, item-on-item)
 * - Tanning (hides at tanner)
 * - Runecrafting (essence at altar)
 *
 * Each handler validates input, applies rate limiting, and emits the
 * appropriate EventType for the corresponding server-side system.
 */

import type { ServerSocket } from "../../../shared/types";
import {
  CollisionMask,
  EventType,
  getProcessingRequestOperationId,
  normalizeProcessingRequestId,
  World,
  worldToTile,
} from "@hyperforge/shared";
import type {
  ProcessingRequestCommitStatus,
  ProcessingRequestEnvelope,
  ProcessingRejectionReason,
  ProcessingSkill,
  RecoverableProcessingRequest,
} from "@hyperforge/shared";
import type { TileMovementManager } from "../tile-movement";
import type { PendingCookManager } from "../PendingCookManager";
import type { PendingGatherManager } from "../PendingGatherManager";
import type { TickSystem } from "../../TickSystem";
import type {
  ResourceInteractPayload,
  CookingSourceInteractPayload,
  FiremakingRequestPayload,
  CookingRequestPayload,
  SmeltingSourceInteractPayload,
  SmithingSourceInteractPayload,
  ProcessingSmeltingPayload,
  ProcessingSmithingPayload,
  CraftingSourceInteractPayload,
  ProcessingRecipePayload,
  FletchingSourceInteractPayload,
  ProcessingTanningPayload,
  RunecraftingAltarPayload,
} from "../types";

/**
 * Context passed to processing handlers so they can access shared server state
 * without being coupled to the ServerNetwork class.
 */
export interface ProcessingHandlerContext {
  world: World;
  pendingGatherManager: PendingGatherManager;
  pendingCookManager: PendingCookManager;
  tileMovementManager: TileMovementManager;
  tickSystem: TickSystem;
  canProcessRequest: (playerId: string) => boolean;
}

/**
 * Preserve backwards compatibility for ordinary clients while requiring an
 * exact UUID whenever a caller asks for completion correlation.
 */
function parseProcessingRequestId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return normalizeProcessingRequestId(value);
}

function rejectProcessingRequest(
  ctx: ProcessingHandlerContext,
  playerId: string,
  requestId: string | undefined,
  skill: ProcessingSkill,
  reason: ProcessingRejectionReason,
  retryable = false,
): void {
  if (!requestId) return;
  ctx.world.emit(EventType.PROCESSING_REQUEST_REJECTED, {
    playerId,
    requestId,
    skill,
    reason,
    retryable,
  });
}

/** Persist exact caller acceptance before dispatching into an in-memory skill system. */
async function admitProcessingRequest(
  ctx: ProcessingHandlerContext,
  playerId: string,
  requestId: string | undefined,
  skill: ProcessingSkill,
  envelope: ProcessingRequestEnvelope,
): Promise<boolean> {
  if (!requestId) return true;
  const operationId = getProcessingRequestOperationId(skill, requestId);
  const database = ctx.world.getSystem("database") as
    | {
        beginProcessingRequestAsync?: (
          playerId: string,
          operationId: string,
          requestId: string,
          skill: ProcessingSkill,
          envelope: ProcessingRequestEnvelope,
        ) => Promise<
          "accepted" | "pending" | "committed" | "busy" | "rejected"
        >;
      }
    | undefined;
  if (!operationId || !database?.beginProcessingRequestAsync) {
    rejectProcessingRequest(
      ctx,
      playerId,
      requestId,
      skill,
      "persistence_rejected",
      true,
    );
    return false;
  }
  try {
    const result = await database.beginProcessingRequestAsync(
      playerId,
      operationId,
      requestId,
      skill,
      envelope,
    );
    if (result === "accepted") return true;
    if (result === "committed") {
      // Persistence may win the narrow race between an interrupted status
      // lookup and the caller's exact resubmission. Report the durable result
      // instead of dispatching gameplay a second time.
      ctx.world.emit(EventType.PROCESSING_REQUEST_PROGRESS, {
        playerId,
        requestId,
        skill,
        phase: "committed",
      });
      return false;
    }
    if (result === "pending") {
      // Exact duplicate already owned by this authority: suppress a second
      // dispatch without sending a false terminal rejection to its waiter.
      return false;
    }
    rejectProcessingRequest(
      ctx,
      playerId,
      requestId,
      skill,
      result === "busy" ? "busy" : "persistence_rejected",
      result === "busy",
    );
    return false;
  } catch {
    rejectProcessingRequest(
      ctx,
      playerId,
      requestId,
      skill,
      "persistence_rejected",
      true,
    );
    return false;
  }
}

const PROCESSING_SKILLS = new Set<ProcessingSkill>([
  "firemaking",
  "cooking",
  "smelting",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
  "tanning",
]);

/**
 * Resolve a deterministic custody receipt for the authenticated player only.
 * Missing, foreign, or wrong-type operation IDs are indistinguishable.
 */
export async function handleProcessingRequestStatus(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player || !data || typeof data !== "object") return;
  const payload = data as {
    requestId?: unknown;
    queryId?: unknown;
    skill?: unknown;
  };
  const requestId = normalizeProcessingRequestId(payload.requestId);
  const queryId = normalizeProcessingRequestId(payload.queryId);
  const skill = payload.skill as ProcessingSkill;
  if (!requestId || !queryId || !PROCESSING_SKILLS.has(skill)) return;
  const operationId = getProcessingRequestOperationId(skill, requestId);
  if (!operationId) return;

  let status: ProcessingRequestCommitStatus = "unavailable";
  try {
    const database = ctx.world.getSystem("database") as
      | {
          getProcessingActionCommitStatusAsync?: (
            playerId: string,
            operationId: string,
          ) => Promise<
            "committed" | "pending" | "interrupted" | "rejected" | "not_found"
          >;
        }
      | undefined;
    if (database?.getProcessingActionCommitStatusAsync) {
      status = await database.getProcessingActionCommitStatusAsync(
        player.id,
        operationId,
      );
    }
  } catch {
    status = "unavailable";
  }

  socket.send("processingRequestStatus", {
    requestId,
    queryId,
    skill,
    status,
  });
}

/** Reconstruct or acknowledge the authenticated player's single durable command. */
export async function handleProcessingRequestRecovery(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player || !data || typeof data !== "object") return;
  const payload = data as {
    action?: unknown;
    queryId?: unknown;
    requestId?: unknown;
  };
  const queryId = normalizeProcessingRequestId(payload.queryId);
  if (!queryId) return;
  const database = ctx.world.getSystem("database") as
    | {
        getRecoverableProcessingRequestAsync?: (
          playerId: string,
        ) => Promise<RecoverableProcessingRequest | null>;
        acknowledgeProcessingRequestAsync?: (
          playerId: string,
          requestId: string,
        ) => Promise<boolean>;
      }
    | undefined;

  if (payload.action === "query") {
    if (!database?.getRecoverableProcessingRequestAsync) {
      socket.send("processingRequestRecovery", {
        action: "state",
        queryId,
        available: false,
        request: null,
      });
      return;
    }
    try {
      const request = await database.getRecoverableProcessingRequestAsync(
        player.id,
      );
      socket.send("processingRequestRecovery", {
        action: "state",
        queryId,
        available: true,
        request,
      });
    } catch {
      socket.send("processingRequestRecovery", {
        action: "state",
        queryId,
        available: false,
        request: null,
      });
    }
    return;
  }

  if (payload.action !== "ack") return;
  const requestId = normalizeProcessingRequestId(payload.requestId);
  if (!requestId) return;
  let acknowledged = false;
  try {
    acknowledged =
      (await database?.acknowledgeProcessingRequestAsync?.(
        player.id,
        requestId,
      )) === true;
  } catch {
    acknowledged = false;
  }
  socket.send("processingRequestRecovery", {
    action: "acknowledged",
    queryId,
    requestId,
    acknowledged,
  });
}

function getAuthoritativeInventorySlot(
  world: World,
  playerId: string,
  slot: number,
): { itemId: string; quantity: number } | null {
  const inventory = world.getInventory?.(playerId);
  if (!Array.isArray(inventory)) return null;
  const item = (inventory as Array<Record<string, unknown>>).find(
    (candidate) => candidate.slot === slot,
  );
  if (!item || typeof item.itemId !== "string") return null;
  const quantity = item.quantity === undefined ? 1 : Number(item.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
  return { itemId: item.itemId, quantity };
}

function getFinitePlayerPosition(
  player: unknown,
): { x: number; y: number; z: number } | null {
  if (!player || typeof player !== "object") return null;
  const candidate = player as {
    position?: unknown;
    node?: { position?: unknown };
  };
  const raw = candidate.position ?? candidate.node?.position;
  if (!raw || typeof raw !== "object") return null;
  const position = raw as { x?: unknown; y?: unknown; z?: unknown };
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

// ============================================================================
// Resource Interaction (PendingGatherManager path)
// ============================================================================

/**
 * SERVER-AUTHORITATIVE: Resource interaction - uses PendingGatherManager.
 * Same approach as combat: movePlayerToward() with meleeRange=1.
 */
export function handleResourceInteract(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): void {
  const player = socket.player;
  if (!player) return;

  const payload = data as ResourceInteractPayload;
  if (!payload.resourceId) return;

  ctx.pendingGatherManager.queuePendingGather(
    player.id,
    payload.resourceId,
    ctx.tickSystem.getCurrentTick(),
    payload.runMode,
  );
}

// ============================================================================
// Cooking Source Interaction (PendingCookManager path)
// ============================================================================

/**
 * SERVER-AUTHORITATIVE: Cooking source interaction - uses PendingCookManager.
 * Same approach as resource gathering: movePlayerToward() with meleeRange=1.
 */
export function handleCookingSourceInteract(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): void {
  const player = socket.player;
  if (!player) return;

  const payload = data as CookingSourceInteractPayload;
  if (!payload.sourceId || !payload.position) return;

  ctx.pendingCookManager.queuePendingCook(
    player.id,
    payload.sourceId,
    {
      x: payload.position[0],
      y: payload.position[1],
      z: payload.position[2],
    },
    ctx.tickSystem.getCurrentTick(),
    payload.runMode,
  );
}

// ============================================================================
// Firemaking
// ============================================================================

/**
 * Firemaking - use tinderbox on logs to create fire.
 * Validates slot bounds and emits PROCESSING_FIREMAKING_REQUEST.
 */
export async function handleFiremakingRequest(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as FiremakingRequestPayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "firemaking",
      "busy",
      true,
    );
    return;
  }

  if (
    !payload.logsId ||
    payload.logsSlot === undefined ||
    payload.tinderboxSlot === undefined
  ) {
    console.log("[ServerNetwork] Invalid firemaking request:", payload);
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "firemaking",
      "invalid_request",
    );
    return;
  }

  const logs = getAuthoritativeInventorySlot(
    ctx.world,
    player.id,
    payload.logsSlot,
  );
  const tinderbox = getAuthoritativeInventorySlot(
    ctx.world,
    player.id,
    payload.tinderboxSlot,
  );
  const position = getFinitePlayerPosition(player);
  if (
    payload.logsSlot === payload.tinderboxSlot ||
    logs?.itemId !== payload.logsId ||
    tinderbox?.itemId !== "tinderbox"
  ) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "firemaking",
      "resources_unavailable",
    );
    return;
  }
  if (!position) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "firemaking",
      "not_authorized",
    );
    return;
  }
  const tile = worldToTile(position.x, position.z);
  try {
    if (
      ctx.world.collision.hasFlags(tile.x, tile.z, CollisionMask.BLOCKS_WALK)
    ) {
      rejectProcessingRequest(
        ctx,
        player.id,
        requestId,
        "firemaking",
        "not_authorized",
      );
      return;
    }
  } catch {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "firemaking",
      "not_authorized",
    );
    return;
  }

  // Validate inventory slot bounds (classic MMORPG inventory is 28 slots: 0-27)
  if (
    payload.logsSlot < 0 ||
    payload.logsSlot > 27 ||
    payload.tinderboxSlot < 0 ||
    payload.tinderboxSlot > 27
  ) {
    console.warn(
      `[ServerNetwork] Invalid slot bounds in firemaking request from ${player.id}`,
    );
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "firemaking",
      "invalid_request",
    );
    return;
  }

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "firemaking", {
      skill: "firemaking",
      logsId: payload.logsId,
      logsSlot: payload.logsSlot,
      tinderboxSlot: payload.tinderboxSlot,
    }))
  ) {
    return;
  }

  // Stop player movement before lighting fire (classic MMORPG: player stands still to light)
  ctx.tileMovementManager.stopPlayer(player.id);

  ctx.world.emit(EventType.PROCESSING_FIREMAKING_REQUEST, {
    playerId: player.id,
    logsId: payload.logsId,
    logsSlot: payload.logsSlot,
    tinderboxSlot: payload.tinderboxSlot,
    ...(requestId ? { requestId } : {}),
  });
}

// ============================================================================
// Cooking
// ============================================================================

/**
 * Cooking - use raw food on fire/range.
 * Routes through PendingCookManager for distance checking.
 */
export async function handleCookingRequest(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as CookingRequestPayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(ctx, player.id, requestId, "cooking", "busy", true);
    return;
  }

  if (
    !payload.rawFoodId ||
    payload.rawFoodSlot === undefined ||
    !payload.fireId
  ) {
    console.log("[ServerNetwork] Invalid cooking request:", payload);
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "cooking",
      "invalid_request",
    );
    return;
  }

  // Validate inventory slot bounds (-1 is allowed = "find first cookable item")
  if (payload.rawFoodSlot < -1 || payload.rawFoodSlot > 27) {
    console.warn(
      `[ServerNetwork] Invalid slot bounds in cooking request from ${player.id}`,
    );
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "cooking",
      "invalid_request",
    );
    return;
  }

  if (
    payload.rawFoodSlot >= 0 &&
    getAuthoritativeInventorySlot(ctx.world, player.id, payload.rawFoodSlot)
      ?.itemId !== payload.rawFoodId
  ) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "cooking",
      "resources_unavailable",
    );
    return;
  }

  console.log(
    "[ServerNetwork] Cooking request from",
    player.id,
    "- routing through PendingCookManager for distance check",
  );

  const cookingSource = ctx.world.entities?.get?.(payload.fireId) as
    { entityType?: unknown; type?: unknown } | undefined;

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "cooking", {
      skill: "cooking",
      rawFoodId: payload.rawFoodId,
      rawFoodSlot: payload.rawFoodSlot,
      sourceId: payload.fireId,
      sourceType:
        cookingSource?.entityType === "range" || cookingSource?.type === "range"
          ? "range"
          : "fire",
    }))
  ) {
    return;
  }

  const sourcePosition = { x: 0, y: 0, z: 0 }; // Server resolves the real source position.
  if (requestId) {
    ctx.pendingCookManager.queuePendingCook(
      player.id,
      payload.fireId,
      sourcePosition,
      ctx.tickSystem.getCurrentTick(),
      undefined,
      payload.rawFoodSlot,
      requestId,
    );
  } else {
    ctx.pendingCookManager.queuePendingCook(
      player.id,
      payload.fireId,
      sourcePosition,
      ctx.tickSystem.getCurrentTick(),
      undefined,
      payload.rawFoodSlot,
    );
  }
}

// ============================================================================
// Smelting
// ============================================================================

/**
 * Smelting - player clicked furnace.
 * Emits SMELTING_INTERACT event for SmeltingSystem.
 */
export function handleSmeltingSourceInteract(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): void {
  const player = socket.player;
  if (!player) return;

  const payload = data as SmeltingSourceInteractPayload;
  if (!payload.furnaceId || !payload.position) return;

  ctx.world.emit(EventType.SMELTING_INTERACT, {
    playerId: player.id,
    furnaceId: payload.furnaceId,
    position: {
      x: payload.position[0],
      y: payload.position[1],
      z: payload.position[2],
    },
  });
}

/**
 * Processing smelting - player selected bar to smelt from UI.
 * Validates input and emits PROCESSING_SMELTING_REQUEST.
 */
export async function handleProcessingSmelting(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as ProcessingSmeltingPayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smelting",
      "busy",
      true,
    );
    return;
  }

  if (
    typeof payload.barItemId !== "string" ||
    typeof payload.furnaceId !== "string"
  ) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smelting",
      "invalid_request",
    );
    return;
  }

  if (payload.barItemId.length > 64 || payload.furnaceId.length > 64) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smelting",
      "invalid_request",
    );
    return;
  }

  const quantity =
    typeof payload.quantity === "number" && Number.isFinite(payload.quantity)
      ? Math.floor(Math.max(1, Math.min(payload.quantity, 10000)))
      : 1;
  if (requestId && quantity !== 1) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smelting",
      "invalid_request",
    );
    return;
  }

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "smelting", {
      skill: "smelting",
      barItemId: payload.barItemId,
      furnaceId: payload.furnaceId,
      quantity: 1,
    }))
  ) {
    return;
  }

  ctx.world.emit(EventType.PROCESSING_SMELTING_REQUEST, {
    playerId: player.id,
    barItemId: payload.barItemId,
    furnaceId: payload.furnaceId,
    quantity,
    ...(requestId ? { requestId } : {}),
  });
}

// ============================================================================
// Smithing
// ============================================================================

/**
 * Smithing - player clicked anvil.
 * Emits SMITHING_INTERACT event for SmithingSystem.
 */
export function handleSmithingSourceInteract(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): void {
  const player = socket.player;
  if (!player) return;

  const payload = data as SmithingSourceInteractPayload;
  if (!payload.anvilId || !payload.position) return;

  ctx.world.emit(EventType.SMITHING_INTERACT, {
    playerId: player.id,
    anvilId: payload.anvilId,
    position: {
      x: payload.position[0],
      y: payload.position[1],
      z: payload.position[2],
    },
  });
}

/**
 * Processing smithing - player selected item to smith from UI.
 * Validates input and emits PROCESSING_SMITHING_REQUEST.
 */
export async function handleProcessingSmithing(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as ProcessingSmithingPayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smithing",
      "busy",
      true,
    );
    return;
  }

  if (
    typeof payload.recipeId !== "string" ||
    typeof payload.anvilId !== "string"
  ) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smithing",
      "invalid_request",
    );
    return;
  }

  if (payload.recipeId.length > 64 || payload.anvilId.length > 64) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smithing",
      "invalid_request",
    );
    return;
  }

  const quantity =
    typeof payload.quantity === "number" && Number.isFinite(payload.quantity)
      ? Math.floor(Math.max(1, Math.min(payload.quantity, 10000)))
      : 1;
  if (requestId && quantity !== 1) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "smithing",
      "invalid_request",
    );
    return;
  }

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "smithing", {
      skill: "smithing",
      recipeId: payload.recipeId,
      anvilId: payload.anvilId,
      quantity: 1,
    }))
  ) {
    return;
  }

  ctx.world.emit(EventType.PROCESSING_SMITHING_REQUEST, {
    playerId: player.id,
    recipeId: payload.recipeId,
    anvilId: payload.anvilId,
    quantity,
    ...(requestId ? { requestId } : {}),
  });
}

// ============================================================================
// Crafting
// ============================================================================

/**
 * Crafting - player initiated crafting (needle, chisel, or furnace jewelry).
 * Validates trigger type and emits CRAFTING_INTERACT.
 */
export function handleCraftingSourceInteract(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): void {
  const player = socket.player;
  if (!player) return;

  if (!ctx.canProcessRequest(player.id)) return;

  const payload = data as CraftingSourceInteractPayload;
  if (!payload.triggerType) return;

  const validTriggerTypes = ["needle", "chisel", "furnace"] as const;
  type CraftingTriggerType = (typeof validTriggerTypes)[number];
  if (!validTriggerTypes.includes(payload.triggerType as CraftingTriggerType)) {
    return;
  }
  const triggerType = payload.triggerType as CraftingTriggerType;

  if (
    payload.inputItemId !== undefined &&
    (typeof payload.inputItemId !== "string" || payload.inputItemId.length > 64)
  ) {
    return;
  }

  ctx.world.emit(EventType.CRAFTING_INTERACT, {
    playerId: player.id,
    triggerType,
    stationId: payload.stationId,
    inputItemId: payload.inputItemId,
  });
}

/**
 * Processing crafting - player selected item to craft from UI.
 * Validates input and emits PROCESSING_CRAFTING_REQUEST.
 */
export async function handleProcessingCrafting(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as ProcessingRecipePayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "crafting",
      "busy",
      true,
    );
    return;
  }

  if (typeof payload.recipeId !== "string") {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "crafting",
      "invalid_request",
    );
    return;
  }

  if (payload.recipeId.length > 64) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "crafting",
      "invalid_request",
    );
    return;
  }

  // Quantity validation (-1 = "All", server computes actual max)
  let quantity = 1;
  if (
    typeof payload.quantity === "number" &&
    Number.isFinite(payload.quantity)
  ) {
    quantity =
      payload.quantity === -1
        ? 10000
        : Math.floor(Math.max(1, Math.min(payload.quantity, 10000)));
  }
  if (requestId && quantity !== 1) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "crafting",
      "invalid_request",
    );
    return;
  }

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "crafting", {
      skill: "crafting",
      recipeId: payload.recipeId,
      quantity: 1,
    }))
  ) {
    return;
  }

  ctx.world.emit(EventType.PROCESSING_CRAFTING_REQUEST, {
    playerId: player.id,
    recipeId: payload.recipeId,
    quantity,
    ...(requestId ? { requestId } : {}),
  });
}

// ============================================================================
// Fletching
// ============================================================================

/**
 * Fletching source interaction - player used knife on logs or item-on-item.
 * Validates trigger type and emits FLETCHING_INTERACT.
 */
export function handleFletchingSourceInteract(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): void {
  const player = socket.player;
  if (!player) return;

  if (!ctx.canProcessRequest(player.id)) return;

  const payload = data as FletchingSourceInteractPayload;
  if (!payload.triggerType) return;

  const validFletchingTriggers = ["knife", "item_on_item"] as const;
  type FletchingTriggerType = (typeof validFletchingTriggers)[number];
  if (
    !validFletchingTriggers.includes(
      payload.triggerType as FletchingTriggerType,
    )
  ) {
    return;
  }
  const triggerType = payload.triggerType as FletchingTriggerType;

  if (
    typeof payload.inputItemId !== "string" ||
    payload.inputItemId.length > 64
  ) {
    return;
  }

  if (
    payload.secondaryItemId !== undefined &&
    (typeof payload.secondaryItemId !== "string" ||
      payload.secondaryItemId.length > 64)
  ) {
    return;
  }

  ctx.world.emit(EventType.FLETCHING_INTERACT, {
    playerId: player.id,
    triggerType,
    inputItemId: payload.inputItemId,
    secondaryItemId: payload.secondaryItemId,
  });
}

/**
 * Processing fletching - player selected recipe to fletch from UI.
 * Validates input and emits PROCESSING_FLETCHING_REQUEST.
 */
export async function handleProcessingFletching(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as ProcessingRecipePayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "fletching",
      "busy",
      true,
    );
    return;
  }

  if (typeof payload.recipeId !== "string") {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "fletching",
      "invalid_request",
    );
    return;
  }

  if (payload.recipeId.length > 64) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "fletching",
      "invalid_request",
    );
    return;
  }

  // Quantity validation (-1 = "All", server computes actual max)
  let quantity = 1;
  if (
    typeof payload.quantity === "number" &&
    Number.isFinite(payload.quantity)
  ) {
    quantity =
      payload.quantity === -1
        ? 10000
        : Math.floor(Math.max(1, Math.min(payload.quantity, 10000)));
  }
  if (requestId && quantity !== 1) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "fletching",
      "invalid_request",
    );
    return;
  }

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "fletching", {
      skill: "fletching",
      recipeId: payload.recipeId,
      quantity: 1,
    }))
  ) {
    return;
  }

  ctx.world.emit(EventType.PROCESSING_FLETCHING_REQUEST, {
    playerId: player.id,
    recipeId: payload.recipeId,
    quantity,
    ...(requestId ? { requestId } : {}),
  });
}

// ============================================================================
// Tanning
// ============================================================================

/**
 * Tanning - player selected hide to tan from UI.
 * Validates input and emits TANNING_REQUEST.
 */
export async function handleProcessingTanning(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as ProcessingTanningPayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(ctx, player.id, requestId, "tanning", "busy", true);
    return;
  }

  if (typeof payload.inputItemId !== "string") {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "tanning",
      "invalid_request",
    );
    return;
  }

  if (payload.inputItemId.length > 64) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "tanning",
      "invalid_request",
    );
    return;
  }

  const tanningSystem = ctx.world.getSystem("tanning") as
    | {
        canPlayerUseActiveTanner?: (playerId: string) => boolean;
        getActiveTannerSession?: (
          playerId: string,
        ) => { npcId: string; npcEntityId: string } | null;
      }
    | undefined;
  const tannerSession = tanningSystem?.getActiveTannerSession?.(player.id);
  if (
    tanningSystem?.canPlayerUseActiveTanner?.(player.id) !== true ||
    !tannerSession
  ) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "tanning",
      "not_authorized",
    );
    return;
  }

  // Quantity validation (-1 = "All", server computes actual max)
  let quantity = 1;
  if (
    typeof payload.quantity === "number" &&
    Number.isFinite(payload.quantity)
  ) {
    quantity =
      payload.quantity === -1
        ? 10000
        : Math.floor(Math.max(1, Math.min(payload.quantity, 10000)));
  }
  if (requestId && quantity !== 1) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "tanning",
      "invalid_request",
    );
    return;
  }

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "tanning", {
      skill: "tanning",
      inputItemId: payload.inputItemId,
      quantity: 1,
      tannerEntityId: tannerSession.npcEntityId,
      tannerNpcId: tannerSession.npcId,
    }))
  ) {
    return;
  }

  ctx.world.emit(EventType.TANNING_REQUEST, {
    playerId: player.id,
    inputItemId: payload.inputItemId,
    quantity,
    ...(requestId ? { requestId } : {}),
  });
}

// ============================================================================
// Runecrafting
// ============================================================================

/**
 * Runecrafting - player clicked runecrafting altar.
 * Validates altarId, looks up runeType, and emits RUNECRAFTING_INTERACT.
 */
export async function handleRunecraftingAltarInteract(
  socket: ServerSocket,
  data: unknown,
  ctx: ProcessingHandlerContext,
): Promise<void> {
  const player = socket.player;
  if (!player) return;

  const payload = data as RunecraftingAltarPayload;
  const requestId = parseProcessingRequestId(payload.requestId);
  if (requestId === null) return;
  if (!ctx.canProcessRequest(player.id)) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "runecrafting",
      "busy",
      true,
    );
    return;
  }

  if (typeof payload.altarId !== "string" || payload.altarId.length > 64) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "runecrafting",
      "invalid_request",
    );
    return;
  }

  // Look up the altar entity to get the authoritative runeType
  const altarEntity = ctx.world.entities.get(payload.altarId);
  if (!altarEntity) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "runecrafting",
      "not_authorized",
    );
    return;
  }

  const altar = altarEntity as unknown as {
    entityType?: unknown;
    runeType?: string;
    isPlayerInRange?: (position: {
      x: number;
      y: number;
      z: number;
    }) => boolean;
  };
  const runeType = altar.runeType;
  const position = (player as unknown as { position?: unknown }).position as
    { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (
    altar.entityType !== "runecrafting_altar" ||
    !runeType ||
    typeof altar.isPlayerInRange !== "function" ||
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "runecrafting",
      "not_authorized",
    );
    return;
  }

  try {
    if (
      !altar.isPlayerInRange({
        x: position.x as number,
        y: position.y as number,
        z: position.z as number,
      })
    ) {
      rejectProcessingRequest(
        ctx,
        player.id,
        requestId,
        "runecrafting",
        "not_authorized",
      );
      return;
    }
  } catch {
    rejectProcessingRequest(
      ctx,
      player.id,
      requestId,
      "runecrafting",
      "not_authorized",
    );
    return;
  }

  if (
    requestId &&
    !(await admitProcessingRequest(ctx, player.id, requestId, "runecrafting", {
      skill: "runecrafting",
      altarId: payload.altarId,
      runeType,
    }))
  ) {
    return;
  }

  ctx.world.emit(EventType.RUNECRAFTING_INTERACT, {
    playerId: player.id,
    altarId: payload.altarId,
    runeType,
    ...(requestId ? { requestId } : {}),
  });
}
