import {
  STREAMING_DUEL_ACTION_OBSERVATION_LIMIT,
  STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  parseStreamingDuelActionObservation,
  type StreamingDuelActionObservation,
} from "@hyperforge/shared";
import { randomUUID } from "node:crypto";
import {
  StreamingDuelActionObservationBuffer,
  type StreamingDuelActionObservationDraft,
  type UnsequencedStreamingDuelActionObservation,
} from "./public-action-observation-buffer.js";

interface QueryResult<Row> {
  rows: Row[];
}

interface QueryableClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(discard?: boolean): void;
}

export interface StreamingDuelActionObservationPool {
  connect(): Promise<QueryableClient>;
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface StreamingDuelActionObservationStore {
  append(
    operationId: string,
    observation: UnsequencedStreamingDuelActionObservation,
  ): Promise<StreamingDuelActionObservation>;
  loadTail(
    cycleId: string,
    limit?: number,
  ): Promise<readonly StreamingDuelActionObservation[]>;
}

type ObservationRow = {
  observation: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseStoredObservation(
  input: unknown,
): StreamingDuelActionObservation {
  const parsed = parseStreamingDuelActionObservation(input);
  if (!parsed) throw new Error("invalid persisted duel action observation");
  return parsed;
}

function unsequencedFingerprint(
  observation:
    StreamingDuelActionObservation | UnsequencedStreamingDuelActionObservation,
): string {
  return JSON.stringify([
    observation.tick,
    observation.observedAt,
    observation.cycleId,
    observation.duelId,
    observation.actorId,
    observation.opponentId,
    observation.phase,
    observation.combatRole,
    observation.tacticalMacro,
    observation.action,
    observation.outcome,
    observation.value,
    observation.amount,
  ]);
}

/**
 * Append-only PostgreSQL boundary for privacy-safe public duel observations.
 *
 * The shared per-cycle head row gives every presentation append and atomic
 * gameplay transaction one MVCC-visible sequence allocator. The advisory lock
 * still keeps presentation-only callers ordered, while the head-row update is
 * the serialization point shared with food, prayer, damage, style, loadout,
 * and executor custody transactions.
 */
export class PostgresStreamingDuelActionObservationStore implements StreamingDuelActionObservationStore {
  constructor(private readonly pool: StreamingDuelActionObservationPool) {}

  async append(
    operationId: string,
    observation: UnsequencedStreamingDuelActionObservation,
  ): Promise<StreamingDuelActionObservation> {
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error("duel action observation operationId must be a UUID");
    }

    const client = await this.pool.connect();
    let discardClient = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('streaming-duel-action:' || $1, 0)
         )`,
        [observation.cycleId],
      );

      const existing = await client.query<ObservationRow>(
        `SELECT observation
         FROM streaming_duel_action_observations
         WHERE "operationId" = $1`,
        [operationId],
      );
      if (existing.rows[0]) {
        const persisted = parseStoredObservation(existing.rows[0].observation);
        if (
          unsequencedFingerprint(persisted) !==
          unsequencedFingerprint(observation)
        ) {
          throw new Error("duel action observation operation collision");
        }
        await client.query("COMMIT");
        return persisted;
      }

      const sequenceResult = await client.query<{ nextSequence: number }>(
        `INSERT INTO streaming_duel_action_observation_heads (
           "cycleId", "lastSequence"
         ) VALUES ($1, 1)
         ON CONFLICT ("cycleId") DO UPDATE
           SET "lastSequence" =
             streaming_duel_action_observation_heads."lastSequence" + 1
         RETURNING "lastSequence" AS "nextSequence"`,
        [observation.cycleId],
      );
      const sequence = sequenceResult.rows[0]?.nextSequence;
      const persisted = parseStreamingDuelActionObservation({
        ...observation,
        schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
        sequence,
      });
      if (!persisted) {
        throw new Error("invalid duel action observation append");
      }

      await client.query(
        `INSERT INTO streaming_duel_action_observations (
           "operationId", "cycleId", "duelId", sequence, "observedAt",
           "actorId", "opponentId", action, observation
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          operationId,
          persisted.cycleId,
          persisted.duelId,
          persisted.sequence,
          persisted.observedAt,
          persisted.actorId,
          persisted.opponentId,
          persisted.action,
          JSON.stringify(persisted),
        ],
      );
      await client.query("COMMIT");
      return persisted;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  async loadTail(
    cycleId: string,
    limit = STREAMING_DUEL_ACTION_OBSERVATION_LIMIT,
  ): Promise<readonly StreamingDuelActionObservation[]> {
    if (!cycleId || cycleId.length > 256) {
      throw new Error("invalid duel action observation cycleId");
    }
    const boundedLimit = Math.max(
      1,
      Math.min(STREAMING_DUEL_ACTION_OBSERVATION_LIMIT, Math.floor(limit)),
    );
    const result = await this.pool.query<ObservationRow>(
      `SELECT observation
       FROM (
         SELECT sequence, observation
         FROM streaming_duel_action_observations
         WHERE "cycleId" = $1
         ORDER BY sequence DESC
         LIMIT $2
       ) AS retained
       ORDER BY sequence ASC`,
      [cycleId, boundedLimit],
    );
    return Object.freeze(
      result.rows.map(({ observation }) => parseStoredObservation(observation)),
    );
  }
}

export type StreamingDuelActionObservationLedgerHealth = {
  configured: boolean;
  activeCycleId: string | null;
  pending: number;
  persisted: number;
  replayed: number;
  rejected: number;
  persistenceErrors: number;
  lastError: string | null;
};

/** Stable identity already used by an atomic authority transaction. */
export type StreamingDuelActionObservationPersistence = Readonly<{
  operationId: string;
  observedAt: number;
}>;

type LedgerOptions = {
  clock?: () => number;
  operationId?: () => string;
  retryDelay?: (attempt: number) => Promise<void>;
  maxAttempts?: number;
  maxPending?: number;
  onError?: (message: string) => void;
};

const defaultRetryDelay = async (attempt: number): Promise<void> => {
  const delays = [50, 200, 500, 1_000];
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delays[Math.min(attempt - 1, delays.length - 1)]);
  });
};

/**
 * Serializes durable publication without putting presentation I/O on combat's
 * authority path. Only committed rows reach the public in-memory tail.
 */
export class StreamingDuelActionObservationLedger {
  private readonly buffer: StreamingDuelActionObservationBuffer;
  private readonly operationId: () => string;
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly maxPending: number;
  private readonly onError: (message: string) => void;
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private pending = 0;
  private persisted = 0;
  private replayed = 0;
  private rejected = 0;
  private persistenceErrors = 0;
  private lastError: string | null = null;

  constructor(
    private readonly store: StreamingDuelActionObservationStore | null,
    options: LedgerOptions = {},
  ) {
    this.buffer = new StreamingDuelActionObservationBuffer(options.clock);
    this.operationId = options.operationId ?? randomUUID;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    this.maxAttempts = Math.max(1, Math.min(10, options.maxAttempts ?? 5));
    this.maxPending = Math.max(1, Math.min(4_096, options.maxPending ?? 256));
    this.onError = options.onError ?? (() => {});
  }

  activateCycle(cycleId: string): void {
    this.generation += 1;
    const generation = this.generation;
    this.buffer.reset(cycleId);
    if (!this.store) return;

    this.enqueue(async () => {
      const observations = await this.store!.loadTail(cycleId);
      if (generation !== this.generation) return;
      if (!this.buffer.hydrate(cycleId, observations)) {
        throw new Error("invalid persisted duel action observation sequence");
      }
      this.replayed += observations.length;
      this.lastError = null;
    });
  }

  clear(): void {
    this.generation += 1;
    this.buffer.clear();
  }

  record(
    draft: StreamingDuelActionObservationDraft,
    persistence?: StreamingDuelActionObservationPersistence,
  ): boolean {
    if (
      persistence &&
      (!UUID_PATTERN.test(persistence.operationId) ||
        !Number.isSafeInteger(persistence.observedAt) ||
        persistence.observedAt <= 0)
    ) {
      this.rejected += 1;
      return false;
    }
    if (!this.store) {
      const appended = this.buffer.append(draft, persistence?.observedAt);
      if (!appended) this.rejected += 1;
      return appended !== null;
    }

    const observation = this.buffer.createUnsequenced(
      draft,
      persistence?.observedAt,
    );
    if (!observation) {
      this.rejected += 1;
      return false;
    }
    // A persistence identity means authority already committed this row. It is
    // internal, rate-limited by combat custody, and must not be dropped merely
    // because ordinary presentation events filled their bounded queue.
    if (this.pending >= this.maxPending && !persistence) {
      this.rejected += 1;
      this.persistenceErrors += 1;
      this.lastError = "duel action observation persistence queue is full";
      this.onError(this.lastError);
      return false;
    }

    const operationId = persistence?.operationId ?? this.operationId();
    this.pending += 1;
    this.enqueue(async () => {
      try {
        const persisted = await this.appendWithRetry(operationId, observation);
        this.persisted += 1;
        this.lastError = null;
        if (persisted.cycleId === this.buffer.getActiveCycleId()) {
          const appended = this.buffer.appendPersisted(persisted);
          if (!appended) {
            await this.rehydrateAfterExternalAppend(persisted);
          }
        }
      } finally {
        this.pending -= 1;
      }
    });
    return true;
  }

  getSnapshot(cycleId: string): readonly StreamingDuelActionObservation[] {
    return this.buffer.getSnapshot(cycleId);
  }

  getHealth(): StreamingDuelActionObservationLedgerHealth {
    const activeSnapshot = this.buffer.getActiveCycleId();
    return {
      configured: this.store !== null,
      activeCycleId: activeSnapshot,
      pending: this.pending,
      persisted: this.persisted,
      replayed: this.replayed,
      rejected: this.rejected,
      persistenceErrors: this.persistenceErrors,
      lastError: this.lastError,
    };
  }

  waitForIdle(): Promise<void> {
    return this.chain;
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error) => {
      this.persistenceErrors += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onError(this.lastError);
    });
  }

  private async appendWithRetry(
    operationId: string,
    observation: UnsequencedStreamingDuelActionObservation,
  ): Promise<StreamingDuelActionObservation> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.store!.append(operationId, observation);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) await this.retryDelay(attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "duel action persistence failed"));
  }

  /**
   * An authority transaction may have inserted an observation before an older
   * queued presentation append acquires the per-cycle advisory lock. Refreshing
   * from the durable tail preserves database order and prevents a harmless
   * external append from becoming a false sequence-health failure.
   */
  private async rehydrateAfterExternalAppend(
    persisted: StreamingDuelActionObservation,
  ): Promise<void> {
    const cycleId = this.buffer.getActiveCycleId();
    if (!cycleId || persisted.cycleId !== cycleId) return;
    const observations = await this.store!.loadTail(cycleId);
    if (this.buffer.getActiveCycleId() !== cycleId) return;
    if (!this.buffer.hydrate(cycleId, observations)) {
      throw new Error("invalid persisted duel action observation sequence");
    }

    const snapshot = this.buffer.getSnapshot(cycleId);
    const matching = snapshot.find(
      (candidate) => candidate.sequence === persisted.sequence,
    );
    if (matching) {
      if (JSON.stringify(matching) !== JSON.stringify(persisted)) {
        throw new Error("persisted duel action observation changed on reload");
      }
      return;
    }
    const firstSequence = snapshot[0]?.sequence;
    if (firstSequence !== undefined && persisted.sequence < firstSequence) {
      return;
    }
    throw new Error("persisted duel action observation missing after reload");
  }
}
