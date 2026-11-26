import type { World } from "@hyperforge/shared";

import {
  acknowledgeExternalAgentBankOperation,
  createExternalAgentBankUnavailableReceipt,
  executeExternalAgentBankOperation,
  normalizeExternalAgentBankEnvelope,
  recoverExternalAgentBankOperation,
} from "../../../../eliza/externalAgentBanking.js";
import type { ServerSocket } from "../../../../shared/types";
import { getPlayerId, sendToSocket } from "../common";
import { handleRequestBankState } from "./core.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function correlationId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/**
 * Execute one ordinary external-agent bank mutation through the same immutable
 * receipt ledger as embedded autonomy. The correlation UUID never owns
 * custody identity; the server-created waiter operation does.
 */
export async function handleExternalAgentBankTransfer(
  socket: ServerSocket,
  data: unknown,
  world: World,
): Promise<void> {
  const payload = data as { requestId?: unknown; envelope?: unknown };
  const requestId = correlationId(payload?.requestId);
  if (!requestId) return;
  const playerId = getPlayerId(socket);
  const envelope = normalizeExternalAgentBankEnvelope(payload?.envelope);
  if (!playerId || !envelope) {
    sendToSocket(socket, "externalAgentBankTransfer", {
      requestId,
      receipt: createExternalAgentBankUnavailableReceipt(
        envelope,
        playerId,
        playerId ? "invalid_item" : "player_unavailable",
      ),
    });
    return;
  }
  try {
    const receipt = await executeExternalAgentBankOperation(
      world,
      playerId,
      envelope,
    );
    if (receipt.commitState === "committed") {
      await handleRequestBankState(socket, {}, world);
    }
    sendToSocket(socket, "externalAgentBankTransfer", {
      requestId,
      receipt,
    });
  } catch {
    sendToSocket(socket, "externalAgentBankTransfer", {
      requestId,
      receipt: createExternalAgentBankUnavailableReceipt(
        envelope,
        playerId,
        "database_unavailable",
      ),
    });
  }
}

/** Query or acknowledge the authenticated player's one durable bank command. */
export async function handleExternalAgentBankRecovery(
  socket: ServerSocket,
  data: unknown,
  world: World,
): Promise<void> {
  const payload = data as {
    action?: unknown;
    queryId?: unknown;
    operationId?: unknown;
  };
  const queryId = correlationId(payload?.queryId);
  if (!queryId) return;
  const playerId = getPlayerId(socket);
  if (!playerId) {
    sendToSocket(socket, "externalAgentBankRecovery", {
      action: "state",
      queryId,
      available: false,
      operation: null,
    });
    return;
  }

  if (payload.action === "query") {
    try {
      const waiter = await recoverExternalAgentBankOperation(world, playerId);
      if (waiter?.receipt?.commitState === "committed") {
        await handleRequestBankState(socket, {}, world);
      }
      sendToSocket(socket, "externalAgentBankRecovery", {
        action: "state",
        queryId,
        available: true,
        operation: waiter
          ? {
              operationId: waiter.operationId,
              status: waiter.status,
              receipt: waiter.receipt,
            }
          : null,
      });
    } catch {
      sendToSocket(socket, "externalAgentBankRecovery", {
        action: "state",
        queryId,
        available: false,
        operation: null,
      });
    }
    return;
  }

  if (payload.action !== "ack") return;
  const operationId = correlationId(payload.operationId);
  let acknowledged = false;
  if (operationId) {
    try {
      acknowledged = await acknowledgeExternalAgentBankOperation(
        world,
        playerId,
        operationId,
      );
    } catch {
      acknowledged = false;
    }
  }
  sendToSocket(socket, "externalAgentBankRecovery", {
    action: "acknowledged",
    queryId,
    operationId,
    acknowledged,
  });
}
