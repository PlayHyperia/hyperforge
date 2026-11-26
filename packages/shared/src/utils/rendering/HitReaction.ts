export const PLAYER_HIT_REACTION_DURATION_SECONDS = 0.28;

export type HitReactionSide = -1 | 1;

/** Fast recoil followed by a smooth return to the underlying authored motion. */
export function getPlayerHitReactionEnvelope(
  elapsedSeconds: number,
  durationSeconds = PLAYER_HIT_REACTION_DURATION_SECONDS,
): number {
  if (
    !Number.isFinite(elapsedSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    elapsedSeconds < 0 ||
    elapsedSeconds >= durationSeconds
  ) {
    return 0;
  }
  const progress = elapsedSeconds / durationSeconds;
  const attackFraction = 0.18;
  if (progress < attackFraction) {
    const attack = progress / attackFraction;
    return 1 - (1 - attack) ** 3;
  }
  const release = (progress - attackFraction) / (1 - attackFraction);
  return 1 - release * release * (3 - 2 * release);
}

export function getPlayerHitReactionIntensity(
  damage: number,
  isCritical = false,
): number {
  if (!Number.isFinite(damage) || damage <= 0) return 0;
  const damageContribution = Math.min(damage, 25) / 25;
  return Math.min(
    1.15,
    0.55 + damageContribution * 0.4 + (isCritical ? 0.2 : 0),
  );
}

/** Stable lateral variation; replaying the same event yields the same pose. */
export function getPlayerHitReactionSide(
  attackerId: string,
  targetId: string,
): HitReactionSide {
  const identity = `${attackerId}\0${targetId}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? -1 : 1;
}
