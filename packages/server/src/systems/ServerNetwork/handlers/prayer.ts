/**
 * Prayer Handler
 *
 * Handles prayer-related actions from clients.
 * Uses shared security infrastructure:
 * - SlidingWindowRateLimiter for rate limiting
 * - Type guards from prayer-types for validation
 * - Timestamp validation for replay attack prevention
 *
 * Security measures:
 * - Input validation (prayer ID format, length)
 * - Rate limiting (5 requests/sec - matches PRAYER_TOGGLE_RATE_LIMIT)
 * - Timestamp validation (prevents replay attacks)
 * - Server-side prayer existence verification via PrayerDataProvider
 */

import type { ServerSocket } from "../../../shared/types";
import { randomUUID } from "node:crypto";
import {
  EventType,
  World,
  isValidPrayerId,
  isValidPrayerTogglePayload,
} from "@hyperforge/shared";
import type {
  PrayerActionReceipt,
  PrayerCustodyView,
} from "@hyperforge/shared";
import { validateRequestTimestamp } from "../services/InputValidation";
import { getPrayerRateLimiter } from "../services/SlidingWindowRateLimiter";

/**
 * Send error feedback to client
 */
function sendPrayerError(socket: ServerSocket, reason: string): void {
  if (socket.send) {
    socket.send("showToast", {
      message: reason,
      type: "error",
    });
  }
}

interface PrayerSystemRequestBoundary {
  executePrayerToggleRequest(
    playerId: string,
    prayerId: string,
    operationId: string,
  ): Promise<PrayerActionReceipt>;
  getPrayerCustody(playerId: string): PrayerCustodyView;
}

function getPrayerSystem(world: World): PrayerSystemRequestBoundary | null {
  const system = world.getSystem(
    "prayer",
  ) as Partial<PrayerSystemRequestBoundary> | null;
  return system?.executePrayerToggleRequest && system.getPrayerCustody
    ? (system as PrayerSystemRequestBoundary)
    : null;
}

function buildPrayerFailure(
  playerId: string,
  operationId: string,
  reason: PrayerActionReceipt["reason"],
  message: string,
  custody?: PrayerCustodyView,
): PrayerActionReceipt {
  return {
    success: false,
    committed: false,
    playerId,
    operationId,
    replayed: false,
    pointUnits: custody?.pointUnits ?? 0,
    points: custody?.points ?? 0,
    maxPoints: custody?.maxPoints ?? 1,
    activePrayers: [...(custody?.activePrayers ?? [])],
    reason,
    message,
  };
}

function sendPrayerReceipt(
  socket: ServerSocket,
  requestId: string,
  receipt: PrayerActionReceipt,
): void {
  socket.send?.("prayerActionReceipt", { requestId, ...receipt });
}

/**
 * Handle prayer toggle request from client
 * Validates input before forwarding to PrayerSystem
 *
 * @param socket - Client socket with player entity
 * @param data - Toggle request payload { prayerId: string }
 * @param world - Game world instance
 */
export async function handlePrayerToggle(
  socket: ServerSocket,
  data: unknown,
  world: World,
): Promise<void> {
  const playerEntity = socket.player;
  if (!playerEntity) {
    return;
  }

  const playerId = playerEntity.id;
  const rawPayload =
    data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : undefined;
  const requestId =
    typeof rawPayload?.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawPayload.requestId,
    )
      ? rawPayload.requestId
      : randomUUID();
  const operationId = `network-prayer-toggle:${randomUUID()}`;
  const prayerSystem = getPrayerSystem(world);
  const custody = prayerSystem?.getPrayerCustody(playerId);

  // Rate limiting using shared infrastructure
  const rateLimiter = getPrayerRateLimiter();
  if (!rateLimiter.check(playerId)) {
    const message = "You are toggling prayers too quickly.";
    sendPrayerError(socket, message);
    sendPrayerReceipt(
      socket,
      requestId,
      buildPrayerFailure(
        playerId,
        operationId,
        "rate_limited",
        message,
        custody,
      ),
    );
    return;
  }

  // Validate request structure using type guard
  if (!isValidPrayerTogglePayload(data)) {
    console.warn(`[Prayer] Invalid toggle request format from ${playerId}`);
    sendPrayerReceipt(
      socket,
      requestId,
      buildPrayerFailure(
        playerId,
        operationId,
        "invalid_request",
        "Invalid prayer request",
        custody,
      ),
    );
    return;
  }

  const { prayerId } = data;

  // Validate timestamp to prevent replay attacks (if provided)
  // Cast through unknown since PrayerTogglePayload may have extra fields from network
  const validatedPayload = data as unknown as Record<string, unknown>;
  if (validatedPayload.timestamp !== undefined) {
    const timestampValidation = validateRequestTimestamp(
      validatedPayload.timestamp,
    );
    if (!timestampValidation.valid) {
      console.warn(
        `[Prayer] Replay attack blocked from ${playerId}: ${timestampValidation.reason}`,
      );
      sendPrayerReceipt(
        socket,
        requestId,
        buildPrayerFailure(
          playerId,
          operationId,
          "invalid_request",
          "Prayer request timestamp rejected",
          custody,
        ),
      );
      return;
    }
  }

  // Additional prayer ID format validation (defense in depth)
  if (!isValidPrayerId(prayerId)) {
    console.warn(
      `[Prayer] Invalid prayer ID format "${prayerId}" from ${playerId}`,
    );
    const message = "Invalid prayer";
    sendPrayerError(socket, message);
    sendPrayerReceipt(
      socket,
      requestId,
      buildPrayerFailure(
        playerId,
        operationId,
        "invalid_request",
        message,
        custody,
      ),
    );
    return;
  }

  // Block prayer activation if duel rules prohibit it
  const duelSystemPrayer = world.getSystem("duel") as
    | {
        canUsePrayer?: (id: string) => boolean;
        isPlayerInActiveDuel?: (id: string) => boolean;
      }
    | undefined;
  if (
    duelSystemPrayer?.isPlayerInActiveDuel?.(playerId) &&
    duelSystemPrayer.canUsePrayer &&
    !duelSystemPrayer.canUsePrayer(playerId)
  ) {
    const message = "Prayer is disabled in this duel.";
    sendPrayerError(socket, message);
    sendPrayerReceipt(
      socket,
      requestId,
      buildPrayerFailure(
        playerId,
        operationId,
        "invalid_request",
        message,
        custody,
      ),
    );
    return;
  }

  if (!prayerSystem) {
    const message = "Prayer system is unavailable.";
    sendPrayerError(socket, message);
    sendPrayerReceipt(
      socket,
      requestId,
      buildPrayerFailure(
        playerId,
        operationId,
        "atomic_persistence_unavailable",
        message,
      ),
    );
    return;
  }

  try {
    const receipt = await prayerSystem.executePrayerToggleRequest(
      playerId,
      prayerId,
      operationId,
    );
    if (!receipt.success) {
      sendPrayerError(socket, receipt.message ?? "Cannot toggle prayer");
    }
    sendPrayerReceipt(socket, requestId, receipt);
  } catch (error) {
    const message = "Prayer request could not be completed.";
    console.error(
      `[Prayer] Authoritative toggle failed for ${playerId}`,
      error,
    );
    sendPrayerError(socket, message);
    sendPrayerReceipt(
      socket,
      requestId,
      buildPrayerFailure(
        playerId,
        operationId,
        "persistence_failed",
        message,
        prayerSystem.getPrayerCustody(playerId),
      ),
    );
  }
}

/**
 * Handle altar pray request from client
 * Restores prayer points to maximum when praying at an altar
 *
 * @param socket - Client socket with player entity
 * @param data - Request payload { altarId: string }
 * @param world - Game world instance
 */
export function handleAltarPray(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    return;
  }

  const playerId = playerEntity.id;

  // Rate limiting
  const rateLimiter = getPrayerRateLimiter();
  if (!rateLimiter.check(playerId)) {
    sendPrayerError(socket, "You are using the altar too quickly.");
    return;
  }

  // Validate payload
  if (!data || typeof data !== "object") {
    console.warn(`[Prayer] Invalid altar pray request format from ${playerId}`);
    return;
  }

  const payload = data as { altarId?: string };
  if (!payload.altarId || typeof payload.altarId !== "string") {
    console.warn(`[Prayer] Missing altarId from ${playerId}`);
    return;
  }

  // Block altar usage during active duels
  const duelSystemAltar = world.getSystem("duel") as
    { isPlayerInActiveDuel?: (id: string) => boolean } | undefined;
  if (duelSystemAltar?.isPlayerInActiveDuel?.(playerId)) {
    sendPrayerError(socket, "You can't use an altar during a duel.");
    return;
  }

  // Verify altar exists
  const altar =
    world.entities.get(payload.altarId) ??
    Array.from(world.entities.values()).find((entity) => {
      if (entity?.type !== "altar") return false;
      return (
        (entity as { altarId?: string }).altarId === payload.altarId ||
        (entity as { userData?: { altarId?: string } }).userData?.altarId ===
          payload.altarId
      );
    });
  if (!altar || altar.type !== "altar") {
    sendPrayerError(socket, "Altar not found");
    return;
  }

  // Emit event for PrayerSystem to handle the actual recharge
  world.emit(EventType.ALTAR_PRAY, {
    playerId,
    altarId: payload.altarId,
  });
}

/**
 * Handle prayer deactivate all request from client
 * Turns off all active prayers at once (useful for "quick prayers off" button)
 *
 * @param socket - Client socket with player entity
 * @param data - Request payload (may contain timestamp)
 * @param world - Game world instance
 */
export function handlePrayerDeactivateAll(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  const playerEntity = socket.player;
  if (!playerEntity) {
    return;
  }

  const playerId = playerEntity.id;

  // Rate limiting
  const rateLimiter = getPrayerRateLimiter();
  if (!rateLimiter.check(playerId)) {
    sendPrayerError(socket, "You are changing prayers too quickly.");
    return;
  }

  // Validate timestamp if provided
  if (data && typeof data === "object") {
    const payload = data as Record<string, unknown>;
    if (payload.timestamp !== undefined) {
      const timestampValidation = validateRequestTimestamp(payload.timestamp);
      if (!timestampValidation.valid) {
        console.warn(
          `[Prayer] Replay attack blocked from ${playerId}: ${timestampValidation.reason}`,
        );
        return;
      }
    }
  }

  // Forward to PrayerSystem - it will deactivate all active prayers
  world.emit(EventType.PRAYER_DEACTIVATED, {
    playerId,
    prayerId: "*", // Special marker for "all prayers"
    reason: "manual",
  });
}
