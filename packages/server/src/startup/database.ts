/**
 * Database Module - PostgreSQL initialization and connection management
 *
 * Handles database setup including Docker PostgreSQL management, Drizzle ORM
 * initialization, connection pooling, and migration execution.
 *
 * Responsibilities:
 * - Start/check Docker PostgreSQL container (if configured)
 * - Initialize Drizzle database client
 * - Run database migrations
 * - Create database adapters for legacy systems
 * - Export connection pool for cleanup
 *
 * Usage:
 * ```typescript
 * const dbContext = await initializeDatabase(config);
 * world.pgPool = dbContext.pgPool;
 * world.drizzleDb = dbContext.drizzleDb;
 * ```
 */

import type pg from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createDefaultDockerManager,
  type DockerManager,
} from "../infrastructure/docker/docker-manager.js";
import type { ServerConfig } from "./config.js";
import type * as schema from "../database/schema.js";

export type ServerDrizzleDatabase = NodePgDatabase<typeof schema> & {
  $client: pg.Pool;
};

/**
 * Database context returned by initialization
 * Contains all database-related instances needed by the server
 */
export interface DatabaseContext {
  /** PostgreSQL connection pool */
  pgPool: pg.Pool;

  /** Drizzle database client (typed with schema) */
  drizzleDb: ServerDrizzleDatabase;

  /** Legacy database adapter for old systems */
  db: unknown; // DrizzleAdapter type from drizzle-adapter.ts

  /** Docker manager instance (if Docker is used) */
  dockerManager?: DockerManager;
}

export interface DatabaseConnectionTarget {
  connectionString: string;
  dockerManager?: DockerManager;
}

export type DockerManagerFactory = () => DockerManager;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Resolve and prepare exactly one configured database target.
 *
 * Managed-local startup is intentionally fail closed: an unavailable or
 * mismatched Docker target is never replaced with another service listening on
 * a familiar port.
 */
export async function prepareDatabaseConnectionTarget(
  config: Pick<ServerConfig, "useLocalPostgres" | "databaseUrl">,
  createDockerManager: DockerManagerFactory = createDefaultDockerManager,
): Promise<DatabaseConnectionTarget> {
  if (config.useLocalPostgres && !config.databaseUrl) {
    try {
      const dockerManager = createDockerManager();
      await dockerManager.checkDockerRunning();
      await dockerManager.startPostgres();
      return {
        connectionString: await dockerManager.getConnectionString(),
        dockerManager,
      };
    } catch (dockerError) {
      throw new Error(
        `[Database] Managed local PostgreSQL failed closed: ${getErrorMessage(dockerError)} ` +
          `Fix the configured Docker container/port or set DATABASE_URL with USE_LOCAL_POSTGRES=false. No unrelated local PostgreSQL service will be used automatically.`,
      );
    }
  }

  if (config.databaseUrl) {
    return { connectionString: config.databaseUrl };
  }

  throw new Error(
    "[Database] No database configuration: set DATABASE_URL or USE_LOCAL_POSTGRES=true",
  );
}

/**
 * Initialize database with Docker and Drizzle
 *
 * This function handles the complete database initialization sequence:
 * 1. Check if Docker PostgreSQL should be used
 * 2. Start Docker PostgreSQL if needed (and not already running)
 * 3. Get connection string (from Docker or env)
 * 4. Initialize Drizzle client and connection pool
 * 5. Run migrations
 * 6. Create legacy adapter for compatibility
 *
 * @param config - Server configuration from config module
 * @returns Promise resolving to DatabaseContext with all DB instances
 * @throws Error if Docker fails to start or database connection fails
 */
export async function initializeDatabase(
  config: ServerConfig,
): Promise<DatabaseContext> {
  const { connectionString, dockerManager } =
    await prepareDatabaseConnectionTarget(config);

  // Initialize Drizzle database
  const { initializeDatabase: initDrizzle } =
    await import("../database/client.js");
  const { db: drizzleDb, pool: pgPool } = await initDrizzle(connectionString);

  // Create adapter for systems that need the old database interface
  const { createDrizzleAdapter } = await import("../database/adapter.js");
  const db = createDrizzleAdapter(drizzleDb as NodePgDatabase<typeof schema>);

  return {
    pgPool,
    drizzleDb: drizzleDb as ServerDrizzleDatabase,
    db,
    dockerManager,
  };
}

/**
 * Close database connections and cleanup
 *
 * Closes the PostgreSQL connection pool and clears singleton instances.
 * Should be called during graceful shutdown.
 *
 * @returns Promise that resolves when cleanup is complete
 */
export async function closeDatabase(): Promise<void> {
  const { closeDatabase: closeDatabaseUtil } =
    await import("../database/client.js");
  await closeDatabaseUtil();
}
