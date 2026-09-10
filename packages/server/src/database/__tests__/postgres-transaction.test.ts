import { describe, expect, it, vi } from "vitest";
import { runInPostgresTransaction } from "../postgres-transaction";

function createPool(options?: {
  beginFails?: boolean;
  rollbackFails?: boolean;
}) {
  const errorListeners = new Set<(error: Error) => void>();
  const query = vi.fn(async (statement: string) => {
    if (statement.startsWith("BEGIN") && options?.beginFails) {
      throw new Error("connection_lost_during_begin");
    }
    if (statement === "ROLLBACK" && options?.rollbackFails) {
      throw new Error("connection_lost_during_rollback");
    }
    return {};
  });
  const release = vi.fn();
  const on = vi.fn((event: string, listener: (error: Error) => void) => {
    if (event === "error") errorListeners.add(listener);
  });
  const removeListener = vi.fn(
    (event: string, listener: (error: Error) => void) => {
      if (event === "error") errorListeners.delete(listener);
    },
  );
  const connect = vi.fn(async () => ({ query, release, on, removeListener }));
  const emitClientError = (error: Error) => {
    for (const listener of errorListeners) listener(error);
  };
  return {
    pool: { connect },
    connect,
    query,
    release,
    on,
    removeListener,
    emitClientError,
  };
}

describe("runInPostgresTransaction", () => {
  it("commits on one acquired client and releases it", async () => {
    const fixture = createPool();
    const operation = vi.fn(async () => "committed");

    await expect(
      runInPostgresTransaction(fixture.pool, operation, {
        isolationLevel: "serializable",
      }),
    ).resolves.toBe("committed");

    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "COMMIT",
    ]);
    expect(operation).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(false);
  });

  it("rolls back the same client and preserves the operation error", async () => {
    const fixture = createPool();
    const operationError = new Error("forced_mid_transaction_failure");

    await expect(
      runInPostgresTransaction(fixture.pool, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);

    expect(fixture.query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "ROLLBACK",
    ]);
    expect(fixture.release).toHaveBeenCalledWith(false);
  });

  it("discards a client that cannot confirm rollback", async () => {
    const fixture = createPool({ rollbackFails: true });
    const operationError = new Error("ambiguous_connection_failure");

    await expect(
      runInPostgresTransaction(fixture.pool, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);

    expect(fixture.query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "ROLLBACK",
    ]);
    expect(fixture.release).toHaveBeenCalledWith(true);
  });

  it("discards a client when BEGIN fails", async () => {
    const fixture = createPool({ beginFails: true });

    await expect(
      runInPostgresTransaction(fixture.pool, async () => "unreachable"),
    ).rejects.toThrow("connection_lost_during_begin");

    expect(fixture.query).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(true);
  });

  it("contains checked-out client errors and discards the connection", async () => {
    const fixture = createPool();
    const operationError = new Error("connection_lost_mid_transaction");

    await expect(
      runInPostgresTransaction(fixture.pool, async () => {
        fixture.emitClientError(
          new Error("Connection terminated unexpectedly"),
        );
        throw operationError;
      }),
    ).rejects.toBe(operationError);

    expect(fixture.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(fixture.removeListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });

  it("retries a completely rolled-back serializable conflict on a fresh checkout", async () => {
    const fixture = createPool();
    const serializationFailure = Object.assign(
      new Error("could not serialize access due to concurrent update"),
      { code: "40001" },
    );
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(serializationFailure)
      .mockResolvedValueOnce("committed-after-retry");

    await expect(
      runInPostgresTransaction(fixture.pool, operation, {
        isolationLevel: "serializable",
        maxConflictRetries: 2,
        conflictRetryBaseDelayMs: 0,
      }),
    ).resolves.toBe("committed-after-retry");

    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(fixture.query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "ROLLBACK",
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "COMMIT",
    ]);
    expect(fixture.release).toHaveBeenNthCalledWith(1, false);
    expect(fixture.release).toHaveBeenNthCalledWith(2, false);
  });

  it("recognizes a Drizzle-wrapped deadlock but never retries other failures", async () => {
    const retryFixture = createPool();
    const wrappedDeadlock = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });
    const retryOperation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(wrappedDeadlock)
      .mockResolvedValueOnce("recovered");

    await expect(
      runInPostgresTransaction(retryFixture.pool, retryOperation, {
        maxConflictRetries: 1,
        conflictRetryBaseDelayMs: 0,
      }),
    ).resolves.toBe("recovered");

    const failureFixture = createPool();
    const businessFailure = new Error("custody_violation");
    const failureOperation = vi.fn(async () => {
      throw businessFailure;
    });
    await expect(
      runInPostgresTransaction(failureFixture.pool, failureOperation, {
        maxConflictRetries: 4,
        conflictRetryBaseDelayMs: 0,
      }),
    ).rejects.toBe(businessFailure);
    expect(failureFixture.connect).toHaveBeenCalledOnce();
    expect(failureOperation).toHaveBeenCalledOnce();
  });

  it("rejects unsafe retry configuration before acquiring a connection", async () => {
    const fixture = createPool();
    await expect(
      runInPostgresTransaction(fixture.pool, async () => "unreachable", {
        maxConflictRetries: 11,
      }),
    ).rejects.toThrow("maxConflictRetries must be an integer between 0 and 10");
    expect(fixture.connect).not.toHaveBeenCalled();
  });
});
