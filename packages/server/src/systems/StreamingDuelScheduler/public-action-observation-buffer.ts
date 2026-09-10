import {
  STREAMING_DUEL_ACTION_OBSERVATION_LIMIT,
  STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  parseStreamingDuelActionObservation,
  type StreamingDuelActionObservation,
} from "@hyperforge/shared";

type ObservationOwnedField = "schemaVersion" | "sequence" | "observedAt";

export type StreamingDuelActionObservationDraft =
  StreamingDuelActionObservation extends infer Observation
    ? Observation extends StreamingDuelActionObservation
      ? Omit<Observation, ObservationOwnedField>
      : never
    : never;

export type UnsequencedStreamingDuelActionObservation =
  StreamingDuelActionObservation extends infer Observation
    ? Observation extends StreamingDuelActionObservation
      ? Omit<Observation, "schemaVersion" | "sequence">
      : never
    : never;

const EMPTY_OBSERVATIONS = Object.freeze(
  [] as StreamingDuelActionObservation[],
);

/**
 * One-cycle, immutable-snapshot tail for public duel observations.
 *
 * Invalid data cannot spend sequence, old snapshots never mutate underneath a
 * delayed frame, and callers must explicitly reset authority at fight start.
 */
export class StreamingDuelActionObservationBuffer {
  private cycleId: string | null = null;
  private nextSequence = 1;
  private snapshot: readonly StreamingDuelActionObservation[] =
    EMPTY_OBSERVATIONS;

  constructor(private readonly clock: () => number = Date.now) {}

  reset(cycleId: string): void {
    this.cycleId = cycleId;
    this.nextSequence = 1;
    this.snapshot = EMPTY_OBSERVATIONS;
  }

  hydrate(
    cycleId: string,
    observations: readonly StreamingDuelActionObservation[],
  ): boolean {
    const parsed: StreamingDuelActionObservation[] = [];
    let previousSequence = 0;
    for (const candidate of observations) {
      const observation = parseStreamingDuelActionObservation(candidate);
      if (
        !observation ||
        observation.cycleId !== cycleId ||
        observation.sequence <= previousSequence
      ) {
        return false;
      }
      parsed.push(observation);
      previousSequence = observation.sequence;
    }

    this.cycleId = cycleId;
    this.nextSequence = previousSequence + 1;
    this.snapshot = Object.freeze(
      parsed.slice(-STREAMING_DUEL_ACTION_OBSERVATION_LIMIT),
    );
    return true;
  }

  clear(): void {
    this.cycleId = null;
    this.nextSequence = 1;
    this.snapshot = EMPTY_OBSERVATIONS;
  }

  append(
    draft: StreamingDuelActionObservationDraft,
    observedAt: number = this.clock(),
  ): StreamingDuelActionObservation | null {
    if (!this.cycleId || draft.cycleId !== this.cycleId) return null;

    const parsed = parseStreamingDuelActionObservation({
      ...draft,
      schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
      sequence: this.nextSequence,
      observedAt,
    });
    if (!parsed) return null;

    this.nextSequence += 1;
    const retained = [...this.snapshot, parsed].slice(
      -STREAMING_DUEL_ACTION_OBSERVATION_LIMIT,
    );
    this.snapshot = Object.freeze(retained);
    return parsed;
  }

  appendPersisted(
    candidate: StreamingDuelActionObservation,
  ): StreamingDuelActionObservation | null {
    const parsed = parseStreamingDuelActionObservation(candidate);
    if (
      !parsed ||
      !this.cycleId ||
      parsed.cycleId !== this.cycleId ||
      parsed.sequence !== this.nextSequence
    ) {
      return null;
    }

    this.nextSequence += 1;
    this.snapshot = Object.freeze(
      [...this.snapshot, parsed].slice(
        -STREAMING_DUEL_ACTION_OBSERVATION_LIMIT,
      ),
    );
    return parsed;
  }

  createUnsequenced(
    draft: StreamingDuelActionObservationDraft,
    observedAt: number = this.clock(),
  ): UnsequencedStreamingDuelActionObservation | null {
    if (!this.cycleId || draft.cycleId !== this.cycleId) return null;
    const parsed = parseStreamingDuelActionObservation({
      ...draft,
      schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
      sequence: 1,
      observedAt,
    });
    if (!parsed) return null;
    const {
      schemaVersion: _schemaVersion,
      sequence: _sequence,
      ...result
    } = parsed;
    return Object.freeze(result);
  }

  getSnapshot(cycleId: string): readonly StreamingDuelActionObservation[] {
    return this.cycleId === cycleId ? this.snapshot : EMPTY_OBSERVATIONS;
  }

  getActiveCycleId(): string | null {
    return this.cycleId;
  }
}
