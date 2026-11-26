import type { World } from "@hyperforge/shared";

import type { ServerSocket } from "../../../../shared/types";
import { getPlayerId } from "../common/index.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Admit one bounded response from the authenticated external contestant. The
 * manager owns exact request correlation and strategy allowlists; this socket
 * boundary derives contestant identity and rejects oversized/extra envelopes.
 */
export function handleDuelPreparationStrategy(
  socket: ServerSocket,
  data: unknown,
  world: World,
): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const payload = data as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const expected = ["decision", "preparationId", "requestId", "status"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    typeof payload.requestId !== "string" ||
    !UUID_PATTERN.test(payload.requestId) ||
    typeof payload.preparationId !== "string" ||
    !UUID_PATTERN.test(payload.preparationId) ||
    (payload.status !== "selected" && payload.status !== "fallback") ||
    (payload.status === "selected" &&
      (!payload.decision ||
        typeof payload.decision !== "object" ||
        Array.isArray(payload.decision))) ||
    (payload.status === "fallback" && payload.decision !== null)
  ) {
    return;
  }
  let serializedDecision: string;
  try {
    serializedDecision = JSON.stringify(payload.decision);
  } catch {
    return;
  }
  if (serializedDecision.length > 4_096) return;
  const agentId = getPlayerId(socket);
  if (!agentId) return;
  world.emit("duel:preparation:external_strategy_response", {
    agentId,
    requestId: payload.requestId,
    preparationId: payload.preparationId,
    status: payload.status,
    decision: payload.decision,
  });
}
