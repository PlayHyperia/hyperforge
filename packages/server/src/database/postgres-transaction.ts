import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type PostgresIsolationLevel =
  "read committed" | "repeatable read" | "serializable";

export type PostgresTransactionDatabase = NodePgDatabase<typeof schema>;

export type PostgresTransactionClient = {
  query(statement: string): Promise<unknown>;
  release(discard?: Error | boolean): void;
  on?(event: "error", listener: (error: Error) => void): void;
  removeListener?(event: "error", listener: (error: Error) => void): void;
};

export type PostgresTransactionPool = {
  connect(): Promise<PostgresTransactionClient>;
};

export type PostgresTransactionOptions = {
  isolationLevel?: PostgresIsolationLevel;
  /** Number of fresh whole-transaction retries after PostgreSQL rolls back a conflict. */
  maxConflictRetries?: number;
  /** Base delay for exponential conflict backoff. Zero is useful in deterministic tests. */
  conflictRetryBaseDelayMs?: number;
};

const BEGIN_STATEMENTS: Readonly<Record<PostgresIsolationLevel, string>> = {
  "read committed": "BEGIN ISOLATION LEVEL READ COMMITTED",
  "repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
};

export function createPostgresClientDatabase(
  client: PostgresTransactionClient,
): PostgresTransactionDatabase {
  const createDatabase = drizzle as unknown as (
    client: PostgresTransactionClient,
    config: { schema: typeof schema; prepare: boolean },
  ) => PostgresTransactionDatabase;
  return createDatabase(client, { schema, prepare: false });
}

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      typeof (current as { code?: unknown }).code === "string"
    ) {
      return (current as { code: string }).code;
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export function isRetryablePostgresTransactionConflict(
  error: unknown,
): boolean {
  const code = postgresErrorCode(error);
  if (code === "40001" || code === "40P01") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not serialize access") ||
    message.toLowerCase().includes("deadlock detected")
  );
}

function validateRetryOption(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return resolved;
}

async function runPostgresTransactionOnce<T>(
  pool: PostgresTransactionPool,
  operation: (tx: PostgresTransactionDatabase) => Promise<T>,
  isolationLevel: PostgresIsolationLevel,
): Promise<T> {
  const client = await pool.connect();
  const tx = createPostgresClientDatabase(client);
  let transactionOpen = false;
  let discardClient = false;
  const handleCheckedOutClientError = () => {
    // `pg` removes its idle-client handler while a PoolClient is checked out.
    // Keep connection loss inside the awaited transaction failure path instead
    // of allowing EventEmitter's unhandled `error` semantics to kill the host.
    discardClient = true;
  };
  client.on?.("error", handleCheckedOutClientError);

  try {
    await client.query(BEGIN_STATEMENTS[isolationLevel]);
    transactionOpen = true;

    const result = await operation(tx);
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (!transactionOpen) {
      // BEGIN itself failed, so the connection cannot be assumed healthy.
      discardClient = true;
    }
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        // A connection that cannot confirm rollback must never return to the
        // pool. Preserve the original error so callers retain ambiguity and
        // idempotent-replay behavior.
        discardClient = true;
      }
    }
    throw error;
  } finally {
    try {
      client.release(discardClient);
    } finally {
      client.removeListener?.("error", handleCheckedOutClientError);
    }
  }
}

/**
 * Execute every statement through one physical PostgreSQL client.
 *
 * The workspace can contain more than one runtime copy of `pg`. In that
 * layout, Drizzle's pool identity check may treat a Pool as an ordinary
 * client, allowing BEGIN and later statements to use different connections.
 * Acquiring the PoolClient here makes the transaction boundary independent of
 * package identity and guarantees that rollback covers every callback write.
 */
export async function runInPostgresTransaction<T>(
  pool: PostgresTransactionPool,
  operation: (tx: PostgresTransactionDatabase) => Promise<T>,
  options?: PostgresTransactionOptions,
): Promise<T> {
  const isolationLevel = options?.isolationLevel ?? "read committed";
  const maxConflictRetries = validateRetryOption(
    options?.maxConflictRetries,
    0,
    "maxConflictRetries",
    10,
  );
  const conflictRetryBaseDelayMs = validateRetryOption(
    options?.conflictRetryBaseDelayMs,
    10,
    "conflictRetryBaseDelayMs",
    1_000,
  );

  for (let attempt = 0; ; attempt++) {
    try {
      return await runPostgresTransactionOnce(pool, operation, isolationLevel);
    } catch (error) {
      if (
        attempt >= maxConflictRetries ||
        !isRetryablePostgresTransactionConflict(error)
      ) {
        throw error;
      }
      const delayMs = Math.min(conflictRetryBaseDelayMs * 2 ** attempt, 1_000);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
