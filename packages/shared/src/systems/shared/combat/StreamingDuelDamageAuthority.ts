import type { StreamingDuelDamageObservationContext } from "../../../types/game/streaming-duel-action-observation";
import type { DuelDamageCompetitiveAuthority } from "../../../types/network/database";

export type StreamingDuelDamageCommitAuthority = Readonly<{
  publicActionObservation: StreamingDuelDamageObservationContext;
  competitiveAuthority?: DuelDamageCompetitiveAuthority;
}>;

/** Narrow server bridge from combat authority to the active duel scheduler. */
export interface StreamingDuelDamageAuthority {
  createDamageObservationContext(
    attackerId: string,
    targetId: string,
    requestedDamage: number,
  ): StreamingDuelDamageCommitAuthority | null;
  handleDamageCommitStarted(
    context: StreamingDuelDamageObservationContext,
  ): void;
  handleDamageCommitSettled(
    context: StreamingDuelDamageObservationContext,
  ): void;
  handleDamageCommitFailure(
    attackerId: string,
    targetId: string,
    reason: string,
    context?: StreamingDuelDamageObservationContext,
  ): void;
}

const authorities = new WeakMap<object, StreamingDuelDamageAuthority>();

/**
 * Install one active scheduler authority without adding a server-only system to
 * the shared World lifecycle. The returned disposer cannot remove a newer
 * replacement scheduler's authority.
 */
export function registerStreamingDuelDamageAuthority(
  world: object,
  authority: StreamingDuelDamageAuthority,
): () => void {
  authorities.set(world, authority);
  return () => {
    if (authorities.get(world) === authority) authorities.delete(world);
  };
}

export function getStreamingDuelDamageAuthority(
  world: object,
): StreamingDuelDamageAuthority | null {
  return authorities.get(world) ?? null;
}
