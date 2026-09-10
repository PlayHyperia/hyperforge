/**
 * Inventory Handler
 *
 * Handles inventory operations from clients:
 * - Item pickup from ground
 * - Item drop to ground
 * - Item equip/unequip
 * - Inventory slot swapping (classic MMORPG-style)
 *
 * All inputs are validated before processing.
 * Includes rate limiting to prevent spam attacks.
 *
 * Security measures:
 * - Input validation (type, range, format)
 * - Rate limiting per operation type
 * - Server-side distance validation
 * - Control character filtering
 * - Audit logging for sensitive operations
 */

import type { ServerSocket } from "../../../shared/types";
import {
  EventType,
  World,
  COMBAT_CONSTANTS,
  INPUT_LIMITS,
  DeathState,
  generateGroundItemDropOperationId,
} from "@hyperforge/shared";
import { getTradingSystem } from "./trade/helpers";
import {
  isValidItemId,
  isValidInventorySlot,
  validateRequestTimestamp,
  isValidQuantity,
  wouldOverflow,
} from "../services/InputValidation";
import { sql } from "drizzle-orm";
import * as schema from "../../../database/schema";
import { runInPostgresTransaction } from "../../../database/postgres-transaction";
import { getDatabase } from "./common/helpers";
import {
  getPickupRateLimiter,
  getMoveRateLimiter,
  getDropRateLimiter,
  getEquipRateLimiter,
  getConsumeRateLimiter,
  getCoinPouchRateLimiter,
} from "../services/SlidingWindowRateLimiter";
import { getIdempotencyService } from "../services/IdempotencyService";

// Regex to detect control characters (security)
const CONTROL_CHAR_REGEX = /[\x00-\x1f]/;

/**
 * Validate entity ID for ground items
 * Similar to itemId validation but allows longer IDs for world entities
 *
 * @param value - Value to validate
 * @returns Type guard indicating if value is valid entity ID
 */
function isValidEntityId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !CONTROL_CHAR_REGEX.test(value)
  );
}

/**
 * Valid equipment slot names for unequip operations
 * Matches classic MMORPG equipment slots
 */
const VALID_EQUIPMENT_SLOTS = new Set([
  "weapon",
  "shield",
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
  "amulet",
  "ring",
  "arrows",
]);

/**
 * Send error feedback to client
 * Used when operations fail due to validation or rate limiting
 *
 * @param socket - Client socket
 * @param operation - Operation that failed
 * @param reason - Human-readable reason
 */
function sendInventoryError(
  socket: ServerSocket,
  _operation: string,
  reason: string,
): void {
  if (socket.send) {
    socket.send("showToast", {
      message: reason,
      type: "error",
    });
  }
}

/**
 * Log inventory operation for security audit
 *
 * @param operation - Operation name
 * @param playerId - Player who performed operation
 * @param details - Operation-specific details
 * @param success - Whether operation succeeded
 */
function auditLog(
  operation: string,
  playerId: string,
  details: Record<string, unknown>,
  success: boolean,
): void {
  // In production, this would write to a secure audit log
  // For now, log to console in a structured format
  if (process.env.AUDIT_LOG === "1") {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "INVENTORY_AUDIT",
        operation,
        playerId,
        success,
        ...details,
      }),
    );
  }
}

/**
 * Handle item pickup from ground
 *
 * Security:
 * - Rate limited to 5/sec
 * - Timestamp validation (prevents replay attacks)
 * - Distance validation (must be within pickup range)
 * - Entity ID validation
 *
 * @param socket - Client socket with player entity
 * @param data - Pickup request data
 * @param world - Game world instance
 */
export function handlePickupItem(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handlePickupItem: no player entity for socket");
    return;
  }

  // Rate limit check - prevent spam attacks
  if (!getPickupRateLimiter().check(playerEntity.id)) {
    // Silently ignore rate limited requests (don't log to prevent log spam)
    return;
  }

  // Validate payload structure
  if (!data || typeof data !== "object") {
    console.warn("[Inventory] handlePickupItem: invalid payload");
    return;
  }

  const payload = data as Record<string, unknown>;

  // Idempotency check - prevent duplicate pickup requests
  const idempotencyKey = getIdempotencyService().generateKey(
    playerEntity.id,
    "pickup",
    { entityId: payload.itemId },
  );
  if (!getIdempotencyService().checkAndMark(idempotencyKey)) {
    // Duplicate request within 5 second window - silently ignore
    return;
  }

  // Timestamp validation - prevents replay attacks
  // Client should send { itemId, timestamp: Date.now() }
  const timestampResult = validateRequestTimestamp(payload.timestamp);
  if (!timestampResult.valid) {
    console.warn(
      `[Inventory] handlePickupItem: ${timestampResult.reason} for player ${playerEntity.id}`,
    );
    auditLog(
      "PICKUP_REPLAY_ATTEMPT",
      playerEntity.id,
      { timestamp: payload.timestamp, reason: timestampResult.reason },
      false,
    );
    return;
  }

  // The client sends the entity ID as 'itemId' in the payload
  const entityId = payload.itemId;

  // Validate entityId
  if (!isValidEntityId(entityId)) {
    console.warn("[Inventory] handlePickupItem: invalid entityId");
    return;
  }

  // Block item pickup during active duels (COUNTDOWN/FIGHTING/FINISHED)
  const duelSystemPickup = world.getSystem("duel") as
    { isPlayerInActiveDuel?: (id: string) => boolean } | undefined;
  if (duelSystemPickup?.isPlayerInActiveDuel?.(playerEntity.id)) {
    return; // Silently ignore - player shouldn't be near ground items in arena
  }

  // Server-side distance validation
  const itemEntity = world.entities.get(entityId);
  if (itemEntity) {
    const distance = Math.sqrt(
      Math.pow(playerEntity.position.x - itemEntity.position.x, 2) +
        Math.pow(playerEntity.position.z - itemEntity.position.z, 2),
    );

    // Use constant for pickup range (slightly larger than client to account for movement)
    const pickupRange = COMBAT_CONSTANTS.PICKUP_RANGE ?? 2.5;
    if (distance > pickupRange) {
      console.warn(
        `[Inventory] Player ${playerEntity.id} tried to pickup item ${entityId} from too far away (${distance.toFixed(2)}m > ${pickupRange}m)`,
      );
      auditLog(
        "PICKUP_DISTANCE_VIOLATION",
        playerEntity.id,
        { entityId, distance, maxRange: pickupRange },
        false,
      );
      return;
    }
  }

  // Forward to InventorySystem with entityId (required) and itemId (optional)
  world.emit(EventType.ITEM_PICKUP, {
    playerId: playerEntity.id,
    entityId,
    itemId: undefined, // Will be extracted from entity properties
  });

  auditLog("PICKUP", playerEntity.id, { entityId }, true);
}

/**
 * Handle item drop to ground
 *
 * Security:
 * - Rate limited to 5/sec
 * - Item ID validation
 * - Quantity validation and clamping
 *
 * @param socket - Client socket with player entity
 * @param data - Drop request data
 * @param world - Game world instance
 */
export function handleDropItem(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handleDropItem: no player entity for socket");
    return;
  }

  // Rate limit check
  if (!getDropRateLimiter().check(playerEntity.id)) {
    return;
  }

  // Validate payload structure
  if (!data || typeof data !== "object") {
    console.warn("[Inventory] handleDropItem: invalid payload");
    return;
  }

  const payload = data as Record<string, unknown>;

  // Validate itemId
  if (!isValidItemId(payload.itemId)) {
    console.warn("[Inventory] handleDropItem: invalid itemId");
    return;
  }

  // Reject malformed quantities. Silent clamping can turn a zero/overflowing
  // request into a different destructive action than the caller authorized.
  let quantity = 1;
  if (payload.quantity !== undefined) {
    if (
      typeof payload.quantity !== "number" ||
      !Number.isSafeInteger(payload.quantity) ||
      payload.quantity <= 0 ||
      payload.quantity > INPUT_LIMITS.MAX_QUANTITY
    ) {
      console.warn("[Inventory] handleDropItem: invalid quantity");
      return;
    }
    quantity = payload.quantity;
  }

  // A malformed supplied slot must not degrade into an aggregate debit.
  let slot: number | undefined;
  if (payload.slot !== undefined) {
    if (
      typeof payload.slot !== "number" ||
      !Number.isSafeInteger(payload.slot) ||
      payload.slot < 0 ||
      payload.slot >= INPUT_LIMITS.MAX_INVENTORY_SLOTS
    ) {
      console.warn("[Inventory] handleDropItem: invalid slot");
      return;
    }
    slot = payload.slot;
  }

  const suppliedOperationId =
    payload.operationId === undefined
      ? undefined
      : typeof payload.operationId === "string"
        ? payload.operationId.trim()
        : "";
  if (
    suppliedOperationId !== undefined &&
    !/^ground-item-drop:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      suppliedOperationId,
    )
  ) {
    console.warn("[Inventory] handleDropItem: invalid operationId");
    return;
  }
  let operationId: string;
  try {
    operationId = suppliedOperationId ?? generateGroundItemDropOperationId();
  } catch {
    console.warn("[Inventory] handleDropItem: secure identity unavailable");
    return;
  }

  // Mark only a fully validated request. Modern clients bind retries to one
  // durable operation; the legacy key retains the prior short dedup window.
  if (!suppliedOperationId) {
    const idempotencyKey = getIdempotencyService().generateKey(
      playerEntity.id,
      "drop",
      { itemId: payload.itemId, quantity, slot },
    );
    if (!getIdempotencyService().checkAndMark(idempotencyKey)) {
      return;
    }
  }

  // Block ALL drops during duel (can't drop any items while in duel)
  const duelSystem = world.getSystem("duel") as
    { isPlayerInDuel?: (id: string) => boolean } | undefined;
  if (duelSystem?.isPlayerInDuel?.(playerEntity.id)) {
    console.warn("[Inventory] handleDropItem: player is in duel");
    return;
  }

  world.emit(EventType.ITEM_DROP, {
    playerId: playerEntity.id,
    itemId: payload.itemId,
    quantity,
    slot,
    operationId,
  });

  auditLog(
    "DROP",
    playerEntity.id,
    { itemId: payload.itemId, quantity, slot, operationId },
    true,
  );
}

/**
 * Handle item equip request
 *
 * Security:
 * - Rate limited to 5/sec
 * - Idempotency check (5s dedup window)
 * - Item ID validation
 * - Inventory slot validation
 *
 * @param socket - Client socket with player entity
 * @param data - Equip request data
 * @param world - Game world instance
 */
export function handleEquipItem(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handleEquipItem: no player entity for socket");
    return;
  }

  // Rate limit check
  if (!getEquipRateLimiter().check(playerEntity.id)) {
    return;
  }

  // Validate payload structure
  if (!data || typeof data !== "object") {
    console.warn("[Inventory] handleEquipItem: invalid payload");
    return;
  }

  const payload = data as Record<string, unknown>;

  // Idempotency check - prevent duplicate equip requests
  const equipIdempotencyKey = getIdempotencyService().generateKey(
    playerEntity.id,
    "equip",
    { itemId: payload.itemId },
  );
  if (!getIdempotencyService().checkAndMark(equipIdempotencyKey)) {
    return;
  }

  // itemId can be string or number (some systems use numeric IDs)
  const itemId = payload.itemId;

  if (
    (typeof itemId !== "string" && typeof itemId !== "number") ||
    (typeof itemId === "string" && !isValidItemId(itemId))
  ) {
    console.warn("[Inventory] handleEquipItem: invalid itemId");
    return;
  }

  // Validate inventorySlot if provided
  const inventorySlot = isValidInventorySlot(payload.inventorySlot)
    ? payload.inventorySlot
    : undefined;

  // Block all equip/unequip during active duels (classic MMORPG: can't change gear mid-duel)
  const duelSystemEquip = world.getSystem("duel") as
    | {
        getStakedSlots?: (id: string) => Set<number>;
        isPlayerInActiveDuel?: (id: string) => boolean;
      }
    | undefined;
  if (duelSystemEquip?.isPlayerInActiveDuel?.(playerEntity.id)) {
    sendInventoryError(
      socket,
      "equip",
      "You can't change equipment during a duel.",
    );
    return;
  }
  // Also block equipping staked items in pre-fight duel states
  if (inventorySlot !== undefined) {
    const stakedSlotsEquip = duelSystemEquip?.getStakedSlots?.(playerEntity.id);
    if (stakedSlotsEquip?.has(inventorySlot)) {
      sendInventoryError(socket, "equip", "That item is staked in a duel.");
      return;
    }
  }

  // Block equip during active trades (classic MMORPG: can't change gear mid-trade)
  const tradingSystemEquip = getTradingSystem(world);
  if (tradingSystemEquip?.isPlayerInTrade(playerEntity.id)) {
    sendInventoryError(
      socket,
      "equip",
      "You can't change equipment during a trade.",
    );
    return;
  }

  // Block equip while dead (classic MMORPG: can't change gear while dead)
  const entityDataEquip = playerEntity.data as
    { deathState?: DeathState } | undefined;
  if (
    entityDataEquip?.deathState === DeathState.DYING ||
    entityDataEquip?.deathState === DeathState.DEAD
  ) {
    sendInventoryError(
      socket,
      "equip",
      "You can't change equipment while dead.",
    );
    return;
  }

  // Emit event for EquipmentSystem to handle
  world.emit(EventType.INVENTORY_ITEM_RIGHT_CLICK, {
    playerId: playerEntity.id,
    itemId,
    slot: inventorySlot,
  });

  auditLog("EQUIP", playerEntity.id, { itemId, inventorySlot }, true);
}

/**
 * Handle item use request (eating food, drinking potions)
 *
 * Security:
 * - Rate limited (shared with equip limiter)
 * - Slot and itemId validation
 * - Server-authoritative (actual consumption handled by InventorySystem)
 *
 * classic MMORPG Flow:
 * Client sends useItem → Server emits INVENTORY_USE → InventorySystem.useItem()
 * → ITEM_USED → PlayerSystem.handleItemUsed() → healing + eat delay
 *
 * @param socket - Client socket with player entity
 * @param data - Use item request data { itemId, slot }
 * @param world - Game world instance
 */
export function handleUseItem(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handleUseItem: no player entity for socket");
    return;
  }

  // Rate limit check (separate from equip to allow classic MMORPG-style PvP gear+eat combos)
  if (!getConsumeRateLimiter().check(playerEntity.id)) {
    return;
  }

  // Validate payload structure
  if (!data || typeof data !== "object") {
    console.warn("[Inventory] handleUseItem: invalid payload");
    return;
  }

  const payload = data as Record<string, unknown>;

  // Validate itemId
  if (!isValidItemId(payload.itemId)) {
    console.warn("[Inventory] handleUseItem: invalid itemId");
    return;
  }

  // Validate slot
  if (!isValidInventorySlot(payload.slot)) {
    console.warn("[Inventory] handleUseItem: invalid slot");
    return;
  }

  // Duel system checks: staked items + food/potion rules
  const duelSystemUse = world.getSystem("duel") as
    | {
        getStakedSlots?: (id: string) => Set<number>;
        canEatFood?: (id: string) => boolean;
        canUsePotions?: (id: string) => boolean;
        isPlayerInActiveDuel?: (id: string) => boolean;
      }
    | undefined;
  if (duelSystemUse) {
    // Check if the slot is staked
    const stakedSlots = duelSystemUse.getStakedSlots?.(playerEntity.id);
    if (stakedSlots?.has(payload.slot as number)) {
      sendInventoryError(socket, "use", "That item is staked in a duel.");
      return;
    }

    // Check if player is in an active duel and food/potion rules apply
    if (duelSystemUse.isPlayerInActiveDuel?.(playerEntity.id)) {
      if (
        duelSystemUse.canEatFood &&
        !duelSystemUse.canEatFood(playerEntity.id)
      ) {
        sendInventoryError(socket, "use", "Food is disabled in this duel.");
        return;
      }
      if (
        duelSystemUse.canUsePotions &&
        !duelSystemUse.canUsePotions(playerEntity.id)
      ) {
        sendInventoryError(socket, "use", "Potions are disabled in this duel.");
        return;
      }
    }
  }

  // Emit INVENTORY_USE for InventorySystem to handle
  // InventorySystem will validate item exists at slot, consume it, and emit ITEM_USED
  world.emit(EventType.INVENTORY_USE, {
    playerId: playerEntity.id,
    itemId: payload.itemId,
    slot: payload.slot,
  });

  auditLog(
    "USE_ITEM",
    playerEntity.id,
    { itemId: payload.itemId, slot: payload.slot },
    true,
  );
}

/**
 * Handle item unequip request
 *
 * Security:
 * - Rate limited to 5/sec (shared with equip)
 * - Idempotency check (5s dedup window)
 * - Equipment slot validation (must be valid slot name)
 *
 * @param socket - Client socket with player entity
 * @param data - Unequip request data
 * @param world - Game world instance
 */
export function handleUnequipItem(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handleUnequipItem: no player entity for socket");
    return;
  }

  // Rate limit check (shared with equip)
  if (!getEquipRateLimiter().check(playerEntity.id)) {
    return;
  }

  // Validate payload structure
  if (!data || typeof data !== "object") {
    console.warn("[Inventory] handleUnequipItem: invalid payload");
    return;
  }

  const payload = data as Record<string, unknown>;

  // Idempotency check - prevent duplicate unequip requests
  const unequipIdempotencyKey = getIdempotencyService().generateKey(
    playerEntity.id,
    "unequip",
    { slot: payload.slot },
  );
  if (!getIdempotencyService().checkAndMark(unequipIdempotencyKey)) {
    return;
  }

  // Validate slot - must be a valid equipment slot name
  const slot = payload.slot;
  if (typeof slot !== "string" || !VALID_EQUIPMENT_SLOTS.has(slot)) {
    console.warn("[Inventory] handleUnequipItem: invalid slot");
    return;
  }

  // Block unequip during active duels (classic MMORPG: can't change gear mid-duel)
  const duelSystemUnequip = world.getSystem("duel") as
    { isPlayerInActiveDuel?: (id: string) => boolean } | undefined;
  if (duelSystemUnequip?.isPlayerInActiveDuel?.(playerEntity.id)) {
    sendInventoryError(
      socket,
      "unequip",
      "You can't change equipment during a duel.",
    );
    return;
  }

  // Block unequip during active trades (classic MMORPG: can't change gear mid-trade)
  const tradingSystemUnequip = getTradingSystem(world);
  if (tradingSystemUnequip?.isPlayerInTrade(playerEntity.id)) {
    sendInventoryError(
      socket,
      "unequip",
      "You can't change equipment during a trade.",
    );
    return;
  }

  // Block unequip while dead (classic MMORPG: can't change gear while dead)
  const entityDataUnequip = playerEntity.data as
    { deathState?: DeathState } | undefined;
  if (
    entityDataUnequip?.deathState === DeathState.DYING ||
    entityDataUnequip?.deathState === DeathState.DEAD
  ) {
    sendInventoryError(
      socket,
      "unequip",
      "You can't change equipment while dead.",
    );
    return;
  }

  // Emit event for EquipmentSystem to handle
  world.emit(EventType.EQUIPMENT_UNEQUIP, {
    playerId: playerEntity.id,
    slot,
  });

  auditLog("UNEQUIP", playerEntity.id, { slot }, true);
}

/**
 * Handle inventory slot move/swap request (classic MMORPG-style)
 *
 * Implements classic MMORPG-style SWAP behavior:
 * - Dragging item A to slot B swaps them
 * - Does NOT shift/insert like typical drag-drop
 *
 * Security:
 * - Rate limited to 10/sec
 * - Slot index validation (0-27)
 * - Same-slot rejection (no-op)
 *
 * @param socket - Client socket with player entity
 * @param data - Move request data { fromSlot, toSlot }
 * @param world - Game world instance
 */
export function handleMoveItem(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handleMoveItem: no player entity for socket");
    return;
  }

  // Rate limit check
  if (!getMoveRateLimiter().check(playerEntity.id)) {
    // Send feedback to client so they know why action didn't work
    sendInventoryError(socket, "move", "Too many actions, please slow down.");
    return;
  }

  // Validate payload structure
  if (!data || typeof data !== "object") {
    console.warn("[Inventory] handleMoveItem: invalid payload");
    sendInventoryError(socket, "move", "Invalid request.");
    return;
  }

  const payload = data as Record<string, unknown>;

  // Validate fromSlot
  if (!isValidInventorySlot(payload.fromSlot)) {
    console.warn("[Inventory] handleMoveItem: invalid fromSlot");
    sendInventoryError(socket, "move", "Invalid slot.");
    return;
  }

  // Validate toSlot
  if (!isValidInventorySlot(payload.toSlot)) {
    console.warn("[Inventory] handleMoveItem: invalid toSlot");
    sendInventoryError(socket, "move", "Invalid slot.");
    return;
  }

  // Can't move to same slot (no-op)
  if (payload.fromSlot === payload.toSlot) {
    return;
  }

  // Check if either slot contains a staked item (can't move staked items)
  const duelSystem = world.getSystem("duel") as
    { getStakedSlots?: (id: string) => Set<number> } | undefined;
  const stakedSlots = duelSystem?.getStakedSlots?.(playerEntity.id);
  if (stakedSlots?.has(payload.fromSlot as number)) {
    sendInventoryError(socket, "move", "That item is staked in a duel.");
    return;
  }
  if (stakedSlots?.has(payload.toSlot as number)) {
    sendInventoryError(socket, "move", "That slot contains a staked item.");
    return;
  }

  // Emit event for InventorySystem to handle
  world.emit(EventType.INVENTORY_MOVE, {
    playerId: playerEntity.id,
    fromSlot: payload.fromSlot,
    toSlot: payload.toSlot,
  });

  auditLog(
    "MOVE",
    playerEntity.id,
    { fromSlot: payload.fromSlot, toSlot: payload.toSlot },
    true,
  );
}

// ============================================================================
// COIN POUCH WITHDRAWAL
// ============================================================================

/**
 * Payload structure for coin pouch withdrawal requests
 */
interface CoinPouchWithdrawPayload {
  amount: number;
  timestamp: number;
}

/**
 * Type guard for coin pouch withdrawal payload
 * Validates structure before processing (defense in depth)
 */
function isCoinPouchWithdrawPayload(
  data: unknown,
): data is CoinPouchWithdrawPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    "amount" in data &&
    "timestamp" in data
  );
}

/**
 * Handle coin pouch withdrawal to inventory
 *
 * Moves coins from the protected money pouch (characters.coins)
 * to physical "coins" item in inventory. This makes coins
 * droppable/tradeable but uses an inventory slot.
 *
 * Security:
 * - Rate limited to 10/sec (SlidingWindowRateLimiter with auto-cleanup)
 * - Timestamp validation (prevents replay attacks)
 * - Input validation (positive integer, max 2.1B)
 * - Atomic database transaction with row locking
 * - Overflow protection
 *
 * @param socket - Client socket with player entity
 * @param data - Withdrawal request with amount and timestamp
 * @param world - Game world instance
 */
export async function handleCoinPouchWithdraw(
  socket: ServerSocket,
  data: unknown,
  world: World,
): Promise<void> {
  // Step 1: Player validation
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handleCoinPouchWithdraw: no player entity");
    return;
  }

  const playerId = playerEntity.id;

  // Step 2: Rate limit (uses SlidingWindowRateLimiter with automatic cleanup)
  if (!getCoinPouchRateLimiter().check(playerId)) {
    return;
  }

  // Block coin pouch withdrawal during duels
  const duelSystemCoins = world.getSystem("duel") as
    { isPlayerInDuel?: (id: string) => boolean } | undefined;
  if (duelSystemCoins?.isPlayerInDuel?.(playerId)) {
    sendInventoryError(
      socket,
      "coinPouchWithdraw",
      "You can't do that during a duel.",
    );
    return;
  }

  // Step 3: Payload structure validation (type guard)
  if (!isCoinPouchWithdrawPayload(data)) {
    console.warn(
      "[Inventory] handleCoinPouchWithdraw: invalid payload structure",
    );
    return;
  }

  // Step 3a: Timestamp validation (prevents replay attacks)
  const timestampResult = validateRequestTimestamp(data.timestamp);
  if (!timestampResult.valid) {
    console.warn(
      `[Inventory] handleCoinPouchWithdraw: ${timestampResult.reason} for player ${playerId}`,
    );
    auditLog(
      "COIN_POUCH_REPLAY_ATTEMPT",
      playerId,
      { timestamp: data.timestamp, reason: timestampResult.reason },
      false,
    );
    return;
  }

  // Step 3b: Amount validation (semantic validation after structure check)
  if (!isValidQuantity(data.amount)) {
    sendInventoryError(socket, "coinPouchWithdraw", "Invalid amount");
    return;
  }

  const amount = data.amount;

  // Step 4: Database transaction
  const db = getDatabase(world);
  if (!db) {
    console.error("[Inventory] handleCoinPouchWithdraw: database unavailable");
    return;
  }

  try {
    await runInPostgresTransaction(db.pool, async (tx) => {
      // Lock character row first (consistent lock order)
      const charResult = await tx.execute(
        sql`SELECT coins FROM characters WHERE id = ${playerId} FOR UPDATE`,
      );
      const charRow = charResult.rows[0] as { coins: number } | undefined;
      if (!charRow) {
        throw new Error("PLAYER_NOT_FOUND");
      }

      const currentPouch = charRow.coins ?? 0;
      if (currentPouch < amount) {
        throw new Error("INSUFFICIENT_COINS");
      }

      // Check inventory for existing coins stack
      const invResult = await tx.execute(
        sql`SELECT "slotIndex", quantity FROM inventory
            WHERE "playerId" = ${playerId} AND "itemId" = 'coins'
            FOR UPDATE`,
      );
      const existingStack = invResult.rows[0] as
        { slotIndex: number; quantity: number } | undefined;

      if (existingStack) {
        // Add to existing stack (check overflow)
        if (wouldOverflow(existingStack.quantity, amount)) {
          throw new Error("STACK_OVERFLOW");
        }
        await tx.execute(
          sql`UPDATE inventory
              SET quantity = quantity + ${amount}
              WHERE "playerId" = ${playerId} AND "itemId" = 'coins'`,
        );
      } else {
        // Find empty slot
        const slotsResult = await tx.execute(
          sql`SELECT "slotIndex" FROM inventory
              WHERE "playerId" = ${playerId} AND "slotIndex" >= 0`,
        );
        const usedSlots = new Set(
          (slotsResult.rows as { slotIndex: number }[]).map((r) => r.slotIndex),
        );

        let emptySlot = -1;
        for (let i = 0; i < INPUT_LIMITS.MAX_INVENTORY_SLOTS; i++) {
          if (!usedSlots.has(i)) {
            emptySlot = i;
            break;
          }
        }

        if (emptySlot === -1) {
          throw new Error("INVENTORY_FULL");
        }

        // Insert new coins stack
        await tx.insert(schema.inventory).values({
          playerId,
          itemId: "coins",
          quantity: amount,
          slotIndex: emptySlot,
        });
      }

      // Deduct from pouch
      await tx.execute(
        sql`UPDATE characters SET coins = coins - ${amount} WHERE id = ${playerId}`,
      );
    });

    // Step 5: Sync in-memory systems
    // Get updated coin balance
    const updatedCoins = await db.drizzle.execute(
      sql`SELECT coins FROM characters WHERE id = ${playerId}`,
    );
    const newCoinBalance =
      (updatedCoins.rows[0] as { coins: number } | undefined)?.coins ?? 0;

    // Update CoinPouchSystem
    world.emit(EventType.INVENTORY_UPDATE_COINS, {
      playerId,
      coins: newCoinBalance,
    });

    // Reload and sync inventory (wrapped in try-catch for safety)
    // Transaction already committed - if sync fails, player can relog to resync
    try {
      const inventorySystem = world.getSystem("inventory") as unknown as {
        reloadFromDatabase?: (playerId: string) => Promise<void>;
        emitInventoryUpdate?: (playerId: string) => void;
      } | null;
      if (
        inventorySystem?.reloadFromDatabase &&
        inventorySystem?.emitInventoryUpdate
      ) {
        await inventorySystem.reloadFromDatabase(playerId);
        inventorySystem.emitInventoryUpdate(playerId);
      }
    } catch (syncError) {
      // Log but don't fail - transaction succeeded, player can relog to resync
      console.error(
        `[Inventory] handleCoinPouchWithdraw: sync failed for player ${playerId}:`,
        syncError,
      );
    }

    // Step 6: Success feedback
    socket.send("showToast", {
      message: `Withdrew ${amount.toLocaleString()} coins to inventory`,
      type: "success",
    });

    // Audit log for large withdrawals
    if (amount >= 1000000) {
      auditLog("COIN_POUCH_WITHDRAW", playerId, { amount }, true);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    const userMessages: Record<string, string> = {
      INSUFFICIENT_COINS: "Not enough coins in pouch",
      INVENTORY_FULL: "Your inventory is full",
      STACK_OVERFLOW: "Cannot stack that many coins",
      PLAYER_NOT_FOUND: "Character not found",
    };

    sendInventoryError(
      socket,
      "coinPouchWithdraw",
      userMessages[errorMessage] || "Failed to withdraw coins",
    );

    // Log unexpected errors
    if (!userMessages[errorMessage]) {
      console.error("[Inventory] handleCoinPouchWithdraw error:", error);
    }
  }
}

// ============================================================================
// XP LAMP USAGE
// ============================================================================

/**
 * Valid skill IDs that can receive XP from lamps
 */
const VALID_SKILL_IDS = new Set([
  "attack",
  "strength",
  "defense",
  "constitution",
  "ranged",
  "prayer",
  "mining",
  "smithing",
  "fishing",
  "cooking",
  "firemaking",
  "woodcutting",
  "agility",
]);

/**
 * Handle XP lamp usage - player selected a skill to receive XP
 *
 * Security:
 * - Rate limited (shared with consume limiter)
 * - Validates item exists at specified slot
 * - Validates item is an XP lamp with correct xpAmount
 * - Validates skill ID is valid
 * - Consumes item and grants XP atomically
 *
 * @param socket - Client socket with player entity
 * @param data - Use request { itemId, slot, skillId, xpAmount }
 * @param world - Game world instance
 */
export async function handleXpLampUse(
  socket: ServerSocket,
  data: unknown,
  world: World,
): Promise<void> {
  const playerEntity = socket.player;
  if (!playerEntity) {
    console.warn("[Inventory] handleXpLampUse: no player entity for socket");
    return;
  }

  // Rate limit check
  if (!getConsumeRateLimiter().check(playerEntity.id)) {
    return;
  }

  // Validate payload structure
  if (!data || typeof data !== "object") {
    console.warn("[Inventory] handleXpLampUse: invalid payload");
    return;
  }

  const payload = data as Record<string, unknown>;

  // Validate itemId
  if (!isValidItemId(payload.itemId)) {
    console.warn("[Inventory] handleXpLampUse: invalid itemId");
    return;
  }

  // Validate slot
  if (!isValidInventorySlot(payload.slot)) {
    console.warn("[Inventory] handleXpLampUse: invalid slot");
    return;
  }

  // Block XP lamp usage during duels
  const duelSystemLamp = world.getSystem("duel") as
    { isPlayerInDuel?: (id: string) => boolean } | undefined;
  if (duelSystemLamp?.isPlayerInDuel?.(playerEntity.id)) {
    sendInventoryError(socket, "xpLampUse", "You can't do that during a duel.");
    return;
  }

  // Validate skillId
  const skillId = payload.skillId;
  if (typeof skillId !== "string" || !VALID_SKILL_IDS.has(skillId)) {
    console.warn("[Inventory] handleXpLampUse: invalid skillId");
    sendInventoryError(socket, "xpLampUse", "Invalid skill selected");
    return;
  }

  // Validate xpAmount
  const xpAmount = payload.xpAmount;
  if (
    typeof xpAmount !== "number" ||
    !Number.isInteger(xpAmount) ||
    xpAmount <= 0 ||
    xpAmount > 100000
  ) {
    console.warn("[Inventory] handleXpLampUse: invalid xpAmount");
    return;
  }

  const playerId = playerEntity.id;
  const itemId = payload.itemId as string;
  const slot = payload.slot as number;

  // Get inventory system to validate item exists
  const inventorySystem = world.getSystem("inventory") as {
    getInventory?: (playerId: string) =>
      | {
          items: Array<{ slot: number; itemId: string; quantity: number }>;
        }
      | undefined;
  } | null;

  if (!inventorySystem?.getInventory) {
    console.error("[Inventory] handleXpLampUse: inventory system unavailable");
    return;
  }

  // Get player's inventory and find item at slot
  const inventory = inventorySystem.getInventory(playerId);
  if (!inventory) {
    sendInventoryError(socket, "xpLampUse", "Inventory not found");
    return;
  }

  // Find item at the specified slot
  const itemAtSlot = inventory.items.find((item) => item.slot === slot);
  if (!itemAtSlot || itemAtSlot.itemId !== itemId) {
    sendInventoryError(socket, "xpLampUse", "Item not found");
    return;
  }

  // Remove the lamp from inventory via event
  world.emit(EventType.INVENTORY_ITEM_REMOVED, {
    playerId,
    itemId,
    quantity: 1,
    slot,
  });

  // Grant XP via SkillsSystem (uses SKILLS_XP_GAINED which SkillsSystem listens to)
  world.emit(EventType.SKILLS_XP_GAINED, {
    playerId,
    skill: skillId,
    amount: xpAmount,
  });

  // Emit XP lamp applied event for UI feedback
  world.emit(EventType.XP_LAMP_APPLIED, {
    playerId,
    skillId,
    xpAmount,
  });

  // Send success toast
  socket.send("showToast", {
    message: `Granted ${xpAmount.toLocaleString()} ${skillId} XP!`,
    type: "success",
  });

  auditLog("XP_LAMP_USE", playerId, { itemId, slot, skillId, xpAmount }, true);
}
