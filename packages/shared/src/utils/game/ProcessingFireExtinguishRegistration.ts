import type { ProcessingFireExtinguishCommitRequest } from "../../types/network/database";

export type ProcessingFireExtinguishIdentity = Omit<
  ProcessingFireExtinguishCommitRequest,
  "requestFingerprint" | "source"
>;

/** One replacement-safe identity derived from the immutable committed fire. */
export function getProcessingFireExtinguishOperationId(fireId: string): string {
  return `processing-fire-extinguish:${fireId}`;
}

/**
 * The ash source identity is deliberately excluded. A replacement process may
 * prepare a new candidate after response loss; the first committed source wins.
 */
export function serializeProcessingFireExtinguishFingerprint(
  input: ProcessingFireExtinguishIdentity,
): string {
  return JSON.stringify({
    version: 1,
    operationId: input.operationId,
    fireId: input.fireId,
    playerId: input.playerId,
    position: {
      x: input.position.x,
      y: input.position.y,
      z: input.position.z,
    },
    expiresAt: input.expiresAt,
  });
}
