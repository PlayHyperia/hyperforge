export const DEFAULT_MAXIMUM_FIGHTING_SAMPLE_GAP_MS = 2_000;

function validPrevious(previous) {
  return Boolean(
    previous &&
    typeof previous.cycleId === "string" &&
    previous.cycleId.length > 0 &&
    Number.isFinite(previous.observedAt),
  );
}

/**
 * Accumulate only adjacent, accepted FIGHTING sample time. Phase gaps, cycle
 * transitions, and long sampling outages do not count toward evidence.
 */
export function accumulateFightingObservation(
  tracker,
  sample,
  maximumGapMs = DEFAULT_MAXIMUM_FIGHTING_SAMPLE_GAP_MS,
) {
  if (
    !tracker ||
    !Number.isFinite(tracker.totalMs) ||
    tracker.totalMs < 0 ||
    !sample ||
    typeof sample.cycleId !== "string" ||
    sample.cycleId.length === 0 ||
    !Number.isFinite(sample.observedAt) ||
    !Number.isFinite(maximumGapMs) ||
    maximumGapMs <= 0
  ) {
    throw new TypeError("FIGHTING observation inputs must be finite and valid");
  }

  const previous = validPrevious(tracker.previous) ? tracker.previous : null;
  const deltaMs = previous ? sample.observedAt - previous.observedAt : 0;
  const acceptedIntervalMs =
    previous?.cycleId === sample.cycleId &&
    deltaMs > 0 &&
    deltaMs <= maximumGapMs
      ? deltaMs
      : 0;

  return {
    totalMs: tracker.totalMs + acceptedIntervalMs,
    acceptedIntervalMs,
    previous: {
      cycleId: sample.cycleId,
      observedAt: sample.observedAt,
    },
  };
}
