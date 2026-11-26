/**
 * BaseRepository - Foundation for all database repositories
 *
 * Provides shared database access and common functionality for all repositories.
 * Each repository extends this class to access the Drizzle database instance
 * and PostgreSQL pool.
 *
 * Architecture:
 * - Repositories are instantiated with database connections
 * - They provide domain-specific database operations
 * - DatabaseSystem acts as a facade, delegating to repositories
 * - Includes retry logic for transient connection failures
 *
 * Usage:
 * ```typescript
 * class PlayerRepository extends BaseRepository {
 *   async getPlayer(id: string) {
 *     return this.withRetry(() => this.db.select()...);
 *   }
 * }
 * ```
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type * as schema from "../schema";
import { runInPostgresTransaction } from "../postgres-transaction";

/**
 * Error codes that indicate a transient/recoverable connection issue
 * These errors should trigger a retry rather than immediate failure
 */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET", // Connection reset by peer
  "ECONNREFUSED", // Connection refused
  "ETIMEDOUT", // Connection timed out
  "EPIPE", // Broken pipe
  "57P01", // PostgreSQL: admin shutdown
  "57P02", // PostgreSQL: crash shutdown
  "57P03", // PostgreSQL: cannot connect now
  "08000", // PostgreSQL: connection exception
  "08003", // PostgreSQL: connection does not exist
  "08006", // PostgreSQL: connection failure
  "08001", // PostgreSQL: unable to establish connection
  "08004", // PostgreSQL: rejected connection
]);

/**
 * Check if an error is a transient connection error that should be retried
 */
function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  // Check for "Connection terminated unexpectedly" message
  if (
    "message" in error &&
    typeof (error as { message: string }).message === "string"
  ) {
    const message = (error as { message: string }).message.toLowerCase();
    if (
      message.includes("connection terminated") ||
      message.includes("connection reset") ||
      message.includes("connection refused") ||
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("network")
    ) {
      return true;
    }
  }

  // Check error code
  if ("code" in error && typeof (error as { code: string }).code === "string") {
    if (TRANSIENT_ERROR_CODES.has((error as { code: string }).code)) {
      return true;
    }
  }

  // Check nested cause (Drizzle wraps errors)
  if ("cause" in error && error.cause && typeof error.cause === "object") {
    return isTransientError(error.cause);
  }

  return false;
}

/**
 * BaseRepository class
 *
 * All repositories extend this class to access database connections.
 * Provides protected access to Drizzle ORM and PostgreSQL pool.
 */
export abstract class BaseRepository {
  /**
   * Drizzle database instance for type-safe queries
   * @protected
   */
  protected readonly db: NodePgDatabase<typeof schema>;

  /**
   * PostgreSQL connection pool for low-level operations
   * @protected
   */
  protected readonly pool: pg.Pool;

  /**
   * Flag to indicate shutdown is in progress
   * Repositories should skip operations during shutdown to avoid errors
   * @protected
   */
  protected isDestroying: boolean = false;

  /**
   * Default retry configuration
   * @protected
   */
  protected readonly retryConfig = {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 2000,
  };

  /**
   * Constructor
   *
   * @param db - Drizzle database instance
   * @param pool - PostgreSQL connection pool
   */
  constructor(db: NodePgDatabase<typeof schema>, pool: pg.Pool) {
    this.db = db;
    this.pool = pool;
  }

  /**
   * Mark repository as shutting down
   * Called during graceful shutdown to prevent new operations
   */
  markDestroying(): void {
    this.isDestroying = true;
  }

  /**
   * Check if database is available
   * @protected
   */
  protected ensureDatabase(): void {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
  }

  /**
   * Execute a database operation within a transaction
   *
   * Wraps the operation in a database transaction that will automatically
   * rollback on error. Use this for operations that modify multiple tables
   * and must be atomic.
   *
   * @param operation - Async function to execute with transaction client
   * @param operationName - Name for logging purposes (optional)
   * @returns The result of the operation
   * @throws Error if transaction fails (after rollback)
   * @protected
   */
  protected async withTransaction<T>(
    operation: (tx: NodePgDatabase<typeof schema>) => Promise<T>,
    operationName?: string,
  ): Promise<T> {
    if (this.isDestroying) {
      console.warn(
        `[${this.constructor.name}] Skipping transaction during shutdown${operationName ? `: ${operationName}` : ""}`,
      );
      return undefined as T;
    }

    this.ensureDatabase();

    try {
      return await runInPostgresTransaction(this.pool, operation);
    } catch (error) {
      console.error(
        `[${this.constructor.name}] Transaction failed${operationName ? ` (${operationName})` : ""}:`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  /**
   * Execute a database operation with automatic retry for transient failures
   *
   * Implements exponential backoff with jitter for retry delays.
   * Only retries on transient connection errors, not on query/data errors.
   *
   * @param operation - Async function to execute
   * @param operationName - Name for logging purposes (optional)
   * @returns The result of the operation
   * @throws The last error if all retries fail
   * @protected
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    operationName?: string,
  ): Promise<T> {
    if (this.isDestroying) {
      // Return undefined/null during shutdown - don't throw
      return undefined as T;
    }

    let lastError: unknown;
    const { maxRetries, baseDelayMs, maxDelayMs } = this.retryConfig;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Only retry on transient connection errors
        if (!isTransientError(error)) {
          throw error;
        }

        // Don't retry if we're shutting down
        if (this.isDestroying) {
          return undefined as T;
        }

        // Log retry attempt
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `[${this.constructor.name}]${operationName ? ` ${operationName}` : ""} retry ${attempt}/${maxRetries}: ${errorMessage}`,
        );

        // Wait before retrying with exponential backoff + jitter
        if (attempt < maxRetries) {
          const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
            maxDelayMs,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted
    console.error(
      `[${this.constructor.name}]${operationName ? ` ${operationName}` : ""} failed after ${maxRetries} attempts`,
    );
    throw lastError;
  }
}
