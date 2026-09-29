import type { GrassGroundingExecution } from "../../systems/shared/world/GrassBladeGrounding";

/** Startup transport budget only; it never renews a grounding context. */
export const GRASS_GROUNDING_CLOCK_STARTUP_MS = 10_000;
export const GRASS_GROUNDING_CLOCK_MAXIMUM_ATTEMPTS = 3;
/** At most 2.5% conservative shortening of a fresh 10-second context. */
export const GRASS_GROUNDING_CLOCK_MAXIMUM_ROUND_TRIP_MS = 250;

export type GrassGroundingWorkerClock = Readonly<{
  mainReceivedEpochMs: number;
  workerSampleEpochMs: number;
  roundTripMs: number;
}>;

function finiteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * The worker samples immediately before replying; main samples on receipt.
 * This defensively reconciles observed epoch discrepancies, although shared
 * monotonic timestamps should agree across communicating realms. Translating
 * under equal-rate monotonic clocks
 * from this pair expires earlier by the return transit, never later. We bound
 * the full round trip (and thus that penalty) rather than guessing an offset.
 */
export function captureGrassGroundingWorkerClock(
  mainSentEpochMs: number,
  mainReceivedEpochMs: number,
  workerSampleEpochMs: number,
): GrassGroundingWorkerClock {
  if (
    !finiteTimestamp(mainSentEpochMs) ||
    !finiteTimestamp(mainReceivedEpochMs) ||
    !finiteTimestamp(workerSampleEpochMs) ||
    mainReceivedEpochMs < mainSentEpochMs
  ) {
    throw new Error("Invalid grounding clock observations");
  }
  const roundTripMs = mainReceivedEpochMs - mainSentEpochMs;
  if (roundTripMs > GRASS_GROUNDING_CLOCK_MAXIMUM_ROUND_TRIP_MS) {
    throw new Error("Grounding clock round trip exceeded 250ms");
  }
  return Object.freeze({
    mainReceivedEpochMs,
    workerSampleEpochMs,
    roundTripMs,
  });
}

/**
 * Translate only the copied wire envelope. The caller's immutable execution,
 * local watchdog, and publication checks retain the original main deadline.
 * Reusing one bridge returns exactly the same deadline at every job stage.
 */
export function translateGrassGroundingWorkerExecution(
  execution: GrassGroundingExecution,
  clock: GrassGroundingWorkerClock,
): GrassGroundingExecution {
  const deadlineEpochMs =
    clock.workerSampleEpochMs +
    (execution.deadlineEpochMs - clock.mainReceivedEpochMs);
  if (!Number.isFinite(deadlineEpochMs)) {
    throw new Error("Invalid translated grounding deadline");
  }
  return Object.freeze({
    policy: execution.policy,
    // A negative translated deadline is already expired in the worker domain.
    deadlineEpochMs: Math.max(0, deadlineEpochMs),
  });
}
