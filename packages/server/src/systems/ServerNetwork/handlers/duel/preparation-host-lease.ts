import type { World } from "@hyperforge/shared";

import type { ServerSocket } from "../../../../shared/types";
import { PostgresDuelPreparationStore } from "../../../StreamingDuelScheduler/preparation.js";
import { isExternalAgentBuildAllowed } from "../../../StreamingDuelScheduler/external-agent-build-policy.js";
import { resolveDuelPreparationHostLeaseConfig } from "../../../StreamingDuelScheduler/preparation-host-lease.js";
import { getDatabase, getPlayerId, sendToSocket } from "../common/index.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type HostLeaseAction = "claim" | "heartbeat";
type HostLeaseStatus = "active" | "rejected" | "unavailable";

const sendResult = (
  socket: ServerSocket,
  input: {
    requestId: string;
    preparationId: string;
    action: HostLeaseAction;
    status: HostLeaseStatus;
    heartbeatAfterMs: number;
  },
): void => {
  sendToSocket(socket, "duelPreparationHostLease", input);
};

/**
 * Claim or refresh the authenticated contestant's immutable preparation-host
 * identity. The socket owns player identity; caller payload can never choose
 * an agent, lease duration, or database clock.
 */
export async function handleDuelPreparationHostLease(
  socket: ServerSocket,
  data: unknown,
  world: World,
): Promise<void> {
  const payload = data as {
    requestId?: unknown;
    preparationId?: unknown;
    ownerId?: unknown;
    executableBuildId?: unknown;
    action?: unknown;
  };
  const requestId =
    typeof payload?.requestId === "string" &&
    UUID_PATTERN.test(payload.requestId)
      ? payload.requestId
      : null;
  if (!requestId) return;

  const preparationId =
    typeof payload.preparationId === "string" &&
    UUID_PATTERN.test(payload.preparationId)
      ? payload.preparationId
      : null;
  const ownerId =
    typeof payload.ownerId === "string" && UUID_PATTERN.test(payload.ownerId)
      ? payload.ownerId
      : null;
  const executableBuildId =
    typeof payload.executableBuildId === "string" &&
    /^[0-9a-f]{64}$/u.test(payload.executableBuildId)
      ? payload.executableBuildId
      : null;
  const action =
    payload.action === "claim" || payload.action === "heartbeat"
      ? payload.action
      : null;
  const playerId = getPlayerId(socket);

  let config;
  try {
    config = resolveDuelPreparationHostLeaseConfig();
  } catch {
    // Startup independently rejects invalid launch configuration. Do not
    // fabricate a timing acknowledgement from an invalid envelope.
    return;
  }

  let executableBuildAllowed = false;
  try {
    executableBuildAllowed =
      executableBuildId !== null &&
      isExternalAgentBuildAllowed({ buildId: executableBuildId });
  } catch {
    sendResult(socket, {
      requestId,
      preparationId: preparationId ?? "",
      action: action ?? "claim",
      status: "unavailable",
      heartbeatAfterMs: config.heartbeatMs,
    });
    return;
  }

  if (
    !preparationId ||
    !ownerId ||
    !executableBuildId ||
    !executableBuildAllowed ||
    !action ||
    !playerId
  ) {
    sendResult(socket, {
      requestId,
      preparationId: preparationId ?? "",
      action: action ?? "claim",
      status: "rejected",
      heartbeatAfterMs: config.heartbeatMs,
    });
    return;
  }

  const database = getDatabase(world);
  if (!database) {
    sendResult(socket, {
      requestId,
      preparationId,
      action,
      status: "unavailable",
      heartbeatAfterMs: config.heartbeatMs,
    });
    return;
  }

  const leaseInput = {
    preparationId,
    agentId: playerId,
    ownerId,
    executableBuildId,
    leaseDurationMs: config.leaseMs,
  };

  try {
    const store = new PostgresDuelPreparationStore(database.pool);
    const lease =
      action === "claim"
        ? await store.claimContestantHostLease(leaseInput)
        : await store.heartbeatContestantHostLease(leaseInput);
    const activeLease =
      action === "claim" && lease
        ? await store.heartbeatContestantHostLease(leaseInput)
        : lease;
    sendResult(socket, {
      requestId,
      preparationId,
      action,
      status: activeLease ? "active" : "rejected",
      heartbeatAfterMs: config.heartbeatMs,
    });
    if (action === "claim" && activeLease) {
      world.emit("duel:preparation:external_host_active", {
        preparationId,
        agentId: playerId,
        ownerId,
        executableBuildId,
      });
    }
  } catch {
    // A transient database failure is not a deterministic lease rejection.
    // The caller may retry the same immutable identity while the DB-clock
    // lease is still live; the scheduler remains the terminal authority.
    sendResult(socket, {
      requestId,
      preparationId,
      action,
      status: "unavailable",
      heartbeatAfterMs: config.heartbeatMs,
    });
  }
}
