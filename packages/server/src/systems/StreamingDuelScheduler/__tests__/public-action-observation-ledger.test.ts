import {
  STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  parseStreamingDuelActionObservation,
  type StreamingDuelActionObservation,
} from "@hyperforge/shared";
import { describe, expect, it } from "vitest";
import {
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationStore,
} from "../public-action-observation-ledger.js";
import type {
  StreamingDuelActionObservationDraft,
  UnsequencedStreamingDuelActionObservation,
} from "../public-action-observation-buffer.js";

class InMemoryObservationStore implements StreamingDuelActionObservationStore {
  readonly rows: StreamingDuelActionObservation[] = [];
  readonly operationIds: string[] = [];
  private readonly byOperation = new Map<
    string,
    StreamingDuelActionObservation
  >();
  throwAfterNextCommit = false;
  alwaysFail = false;
  appendGate: Promise<void> | null = null;

  async append(
    operationId: string,
    observation: UnsequencedStreamingDuelActionObservation,
  ): Promise<StreamingDuelActionObservation> {
    this.operationIds.push(operationId);
    if (this.alwaysFail) throw new Error("database unavailable");
    if (this.appendGate) await this.appendGate;
    const existing = this.byOperation.get(operationId);
    if (existing) return existing;
    const sequence =
      this.rows.filter((row) => row.cycleId === observation.cycleId).length + 1;
    const persisted = parseStreamingDuelActionObservation({
      ...observation,
      schemaVersion: STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
      sequence,
    });
    if (!persisted) throw new Error("invalid test observation");
    this.rows.push(persisted);
    this.byOperation.set(operationId, persisted);
    if (this.throwAfterNextCommit) {
      this.throwAfterNextCommit = false;
      throw new Error("response lost after commit");
    }
    return persisted;
  }

  async loadTail(
    cycleId: string,
    limit = 32,
  ): Promise<readonly StreamingDuelActionObservation[]> {
    return this.rows.filter((row) => row.cycleId === cycleId).slice(-limit);
  }
}

function action(
  tick: number,
  overrides: Partial<StreamingDuelActionObservationDraft> = {},
): StreamingDuelActionObservationDraft {
  return {
    tick,
    cycleId: "cycle-ledger",
    duelId: "duel-ledger",
    actorId: "agent-a",
    opponentId: "agent-b",
    phase: "FIGHTING",
    combatRole: "ranged",
    tacticalMacro: "kite",
    action: "movement",
    outcome: "accepted",
    value: "reposition",
    amount: null,
    ...overrides,
  } as StreamingDuelActionObservationDraft;
}

describe("StreamingDuelActionObservationLedger", () => {
  it("replays a bounded immutable tail and continues the durable sequence", async () => {
    const store = new InMemoryObservationStore();
    let now = 10_000;
    let operation = 0;
    const options = {
      clock: () => ++now,
      operationId: () =>
        `00000000-0000-4000-8000-${String(++operation).padStart(12, "0")}`,
      retryDelay: async () => {},
    };
    const first = new StreamingDuelActionObservationLedger(store, options);
    first.activateCycle("cycle-ledger");
    for (let tick = 1; tick <= 35; tick += 1) {
      expect(first.record(action(tick))).toBe(true);
    }
    await first.waitForIdle();

    const firstTail = first.getSnapshot("cycle-ledger");
    expect(firstTail).toHaveLength(32);
    expect(firstTail[0]?.sequence).toBe(4);
    expect(firstTail.at(-1)?.sequence).toBe(35);
    expect(Object.isFrozen(firstTail)).toBe(true);
    expect(Object.isFrozen(firstTail[0])).toBe(true);

    const restarted = new StreamingDuelActionObservationLedger(store, options);
    restarted.activateCycle("cycle-ledger");
    await restarted.waitForIdle();
    expect(restarted.getSnapshot("cycle-ledger")).toEqual(firstTail);
    expect(restarted.getHealth().replayed).toBe(32);

    expect(restarted.record(action(36))).toBe(true);
    await restarted.waitForIdle();
    expect(restarted.getSnapshot("cycle-ledger").at(-1)?.sequence).toBe(36);
    expect(store.rows).toHaveLength(36);
  });

  it("retries an ambiguous post-commit response with one stable operation ID", async () => {
    const store = new InMemoryObservationStore();
    store.throwAfterNextCommit = true;
    const ledger = new StreamingDuelActionObservationLedger(store, {
      clock: () => 20_000,
      operationId: () => "00000000-0000-4000-8000-000000000001",
      retryDelay: async () => {},
    });
    ledger.activateCycle("cycle-ledger");
    expect(ledger.record(action(1))).toBe(true);
    await ledger.waitForIdle();

    expect(store.operationIds).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(store.rows).toHaveLength(1);
    expect(ledger.getSnapshot("cycle-ledger")).toHaveLength(1);
    expect(ledger.getHealth()).toMatchObject({
      persisted: 1,
      persistenceErrors: 0,
      pending: 0,
    });
  });

  it("rehydrates database order when an authority transaction appends ahead of the queue", async () => {
    const store = new InMemoryObservationStore();
    const foodOperationId = "00000000-0000-4000-8000-000000000101";
    const foodDraft = action(1, {
      action: "food",
      outcome: "committed",
      value: "consume",
      amount: 12,
    });
    const ledger = new StreamingDuelActionObservationLedger(store, {
      clock: () => 50_002,
      operationId: () => "00000000-0000-4000-8000-000000000102",
      retryDelay: async () => {},
    });
    ledger.activateCycle("cycle-ledger");
    await ledger.waitForIdle();

    await store.append(foodOperationId, {
      ...foodDraft,
      observedAt: 50_001,
    } as UnsequencedStreamingDuelActionObservation);
    expect(ledger.record(action(2))).toBe(true);
    await ledger.waitForIdle();
    expect(
      ledger
        .getSnapshot("cycle-ledger")
        .map(({ sequence, action: actionName }) => [sequence, actionName]),
    ).toEqual([
      [1, "food"],
      [2, "movement"],
    ]);

    // The controller callback reuses the identity already committed by the
    // authority transaction. It refreshes the tail but cannot append a duplicate.
    expect(
      ledger.record(foodDraft, {
        operationId: foodOperationId,
        observedAt: 50_001,
      }),
    ).toBe(true);
    await ledger.waitForIdle();
    expect(store.rows).toHaveLength(2);
    expect(ledger.getSnapshot("cycle-ledger")).toHaveLength(2);
    expect(ledger.getHealth()).toMatchObject({
      pending: 0,
      persisted: 2,
      persistenceErrors: 0,
      lastError: null,
    });
  });

  it("publishes only after persistence commits", async () => {
    const store = new InMemoryObservationStore();
    let releaseAppend!: () => void;
    store.appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const ledger = new StreamingDuelActionObservationLedger(store, {
      clock: () => 30_000,
      retryDelay: async () => {},
      maxPending: 1,
    });
    ledger.activateCycle("cycle-ledger");
    expect(ledger.record(action(1))).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ledger.getSnapshot("cycle-ledger")).toEqual([]);
    expect(ledger.getHealth().pending).toBe(1);
    expect(ledger.record(action(2))).toBe(false);

    releaseAppend();
    await ledger.waitForIdle();
    expect(ledger.getSnapshot("cycle-ledger")).toHaveLength(1);
    expect(ledger.getHealth()).toMatchObject({
      pending: 0,
      rejected: 1,
      persistenceErrors: 1,
      lastError: null,
    });
  });

  it("rejects private input before persistence and reports bounded failure", async () => {
    const store = new InMemoryObservationStore();
    let operation = 0;
    const ledger = new StreamingDuelActionObservationLedger(store, {
      clock: () => 40_000,
      operationId: () =>
        `00000000-0000-4000-8000-${String(++operation).padStart(12, "0")}`,
      retryDelay: async () => {},
      maxAttempts: 2,
    });
    ledger.activateCycle("cycle-ledger");
    expect(ledger.record({ ...action(1), reasoning: "private" } as never)).toBe(
      false,
    );
    expect(store.operationIds).toEqual([]);

    store.alwaysFail = true;
    expect(ledger.record(action(2))).toBe(true);
    await ledger.waitForIdle();
    expect(store.operationIds).toHaveLength(2);
    expect(ledger.getSnapshot("cycle-ledger")).toEqual([]);
    expect(ledger.getHealth()).toMatchObject({
      pending: 0,
      persisted: 0,
      rejected: 1,
      persistenceErrors: 1,
      lastError: "database unavailable",
    });
  });
});
