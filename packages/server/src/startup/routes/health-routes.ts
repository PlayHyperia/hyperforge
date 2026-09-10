/**
 * Health Routes Module - Server health and status endpoints
 *
 * Provides endpoints for monitoring server health and retrieving current
 * server status including uptime and connected players.
 *
 * Endpoints:
 * - GET /health - Basic health check (uptime, timestamp)
 * - GET /status - Detailed status (world time, connected players, commit hash)
 *
 * ## Production Monitoring Setup
 *
 * These endpoints must be configured with external monitoring:
 * - **Railway**: Use Railway's built-in health checks pointing to /health
 * - **External**: Configure uptime monitoring (e.g., UptimeRobot, Pingdom) to poll /health
 * - **Alerting**: Set up alerts for non-200 responses or high response times
 *
 * **Important**: These endpoints only provide data - they do NOT send alerts.
 * You must configure external monitoring to poll these endpoints and trigger alerts.
 *
 * Usage:
 * ```typescript
 * import { registerHealthRoutes } from './routes/health-routes';
 * registerHealthRoutes(fastify, world, config);
 * ```
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  COMBAT_CONSTANTS,
  TICK_DURATION_MS,
  type World,
} from "@hyperforge/shared";
import type { ServerConfig } from "../config.js";
import type {
  DatabaseSystem,
  ProjectileCostCustodyStats,
} from "../../systems/DatabaseSystem/index.js";
import { isMaintenanceModeActive } from "../maintenance-mode.js";

export type DatabaseHealthResult = {
  healthy: boolean;
  status: "healthy" | "unhealthy" | "unavailable" | "timeout";
  latencyMs: number;
  poolInfo?: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
  error?: string;
};

type DatabaseHealthSource = Pick<DatabaseSystem, "checkHealthAsync">;

type ProjectileCostCustodySource = Pick<
  DatabaseSystem,
  "getProjectileCostCustodyStatsAsync"
>;

export const PROJECTILE_COST_CUSTODY_MAX_AGE_MS =
  (COMBAT_CONSTANTS.PROJECTILE_MAX_LIFETIME_TICKS + 1) * TICK_DURATION_MS +
  COMBAT_CONSTANTS.PROJECTILE_TERMINAL_DELIVERY_GRACE_MS;

export type ProjectileCostCustodyHealthResult = ProjectileCostCustodyStats & {
  healthy: boolean;
  status:
    | "healthy"
    | "processing"
    | "stalled"
    | "invalid"
    | "unavailable"
    | "timeout";
  maxAgeMs: number;
};

type ProcessingCustodyStats = {
  pendingFireExpiries: number;
  fireExpiryInFlight: number;
  fireExpiryRetryWaiting: number;
  fireExpiryBlocked: number;
  maxFireExpiryRetryCount: number;
};

type ProcessingCustodySource = {
  getProcessingCustodyStats(): ProcessingCustodyStats;
};

export type ProcessingCustodyHealthResult = ProcessingCustodyStats & {
  healthy: boolean;
  status: "healthy" | "reconciling" | "blocked" | "unavailable" | "invalid";
};

type GroundItemCustodyStats = {
  durableHydrationStatus: "not_started" | "in_progress" | "complete" | "failed";
  hydrationAuthorityAvailable: boolean;
  expiryAuthorityAvailable: boolean;
  trackedItems: number;
  durableSources: number;
  pendingCustodyReconciliations: number;
  pendingPresentationHydrations: number;
  presentationHydrationsInFlight: number;
  maxPresentationHydrationAttempts: number;
  pendingDurableExpiries: number;
  durableExpiriesInFlight: number;
  maxDurableExpiryAttempts: number;
  pendingPresentationCleanups: number;
  maxPresentationCleanupAttempts: number;
};

type GroundItemCustodySource = {
  getGroundItemCustodyStats(): GroundItemCustodyStats;
};

type LootCustodyStats = {
  pendingMobLootCommits: number;
  mobLootCommitsInFlight: number;
  mobLootCommitsBlocked: number;
  maxMobLootCommitAttempts: number;
};

type LootCustodySource = {
  getLootCustodyStats(): LootCustodyStats;
};

export type LootCustodyHealthResult = LootCustodyStats & {
  healthy: boolean;
  status: "healthy" | "reconciling" | "blocked" | "unavailable" | "invalid";
};

type DuelDamageReconciliationStats = {
  pendingOperations: number;
  queuedOperations: number;
  committingOperations: number;
  reconcilingOperations: number;
  maxReconciliationAttempts: number;
  oldestPendingAgeMs: number;
  oldestReconciliationAgeMs: number;
};

type DuelDamageReconciliationSource = {
  getDuelDamageReconciliationStats(): DuelDamageReconciliationStats;
};

export type DuelDamageReconciliationHealthResult =
  DuelDamageReconciliationStats & {
    healthy: boolean;
    status:
      | "healthy"
      | "processing"
      | "reconciling"
      | "stalled"
      | "unavailable"
      | "invalid";
    maxPendingAgeMs: number;
  };

export type GroundItemCustodyHealthResult = GroundItemCustodyStats & {
  healthy: boolean;
  status:
    | "healthy"
    | "initializing"
    | "reconciling"
    | "failed"
    | "unavailable"
    | "invalid";
};

const EMPTY_PROCESSING_CUSTODY_STATS: ProcessingCustodyStats = {
  pendingFireExpiries: 0,
  fireExpiryInFlight: 0,
  fireExpiryRetryWaiting: 0,
  fireExpiryBlocked: 0,
  maxFireExpiryRetryCount: 0,
};

const EMPTY_GROUND_ITEM_CUSTODY_STATS: GroundItemCustodyStats = {
  durableHydrationStatus: "not_started",
  hydrationAuthorityAvailable: false,
  expiryAuthorityAvailable: false,
  trackedItems: 0,
  durableSources: 0,
  pendingCustodyReconciliations: 0,
  pendingPresentationHydrations: 0,
  presentationHydrationsInFlight: 0,
  maxPresentationHydrationAttempts: 0,
  pendingDurableExpiries: 0,
  durableExpiriesInFlight: 0,
  maxDurableExpiryAttempts: 0,
  pendingPresentationCleanups: 0,
  maxPresentationCleanupAttempts: 0,
};

const EMPTY_LOOT_CUSTODY_STATS: LootCustodyStats = {
  pendingMobLootCommits: 0,
  mobLootCommitsInFlight: 0,
  mobLootCommitsBlocked: 0,
  maxMobLootCommitAttempts: 0,
};

const EMPTY_DUEL_DAMAGE_RECONCILIATION_STATS: DuelDamageReconciliationStats = {
  pendingOperations: 0,
  queuedOperations: 0,
  committingOperations: 0,
  reconcilingOperations: 0,
  maxReconciliationAttempts: 0,
  oldestPendingAgeMs: 0,
  oldestReconciliationAgeMs: 0,
};

const EMPTY_PROJECTILE_COST_CUSTODY_STATS: ProjectileCostCustodyStats = {
  pendingAmmunitionShots: 0,
  firedAmmunitionShots: 0,
  pendingRuneCosts: 0,
  firedRuneCosts: 0,
  invalidOperations: 0,
  futureTimestampOperations: 0,
  oldestUnresolvedAgeMs: 0,
};

const GROUND_ITEM_HYDRATION_STATUSES = new Set([
  "not_started",
  "in_progress",
  "complete",
  "failed",
]);

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Public aggregate only; exact fire identities and errors remain private logs. */
export function checkProcessingCustodyHealth(
  processingSystem: ProcessingCustodySource | undefined,
): ProcessingCustodyHealthResult {
  if (!processingSystem?.getProcessingCustodyStats) {
    return {
      healthy: false,
      status: "unavailable",
      ...EMPTY_PROCESSING_CUSTODY_STATS,
    };
  }
  let stats: ProcessingCustodyStats;
  try {
    stats = processingSystem.getProcessingCustodyStats();
  } catch {
    return {
      healthy: false,
      status: "unavailable",
      ...EMPTY_PROCESSING_CUSTODY_STATS,
    };
  }
  if (
    !stats ||
    !isSafeCount(stats.pendingFireExpiries) ||
    !isSafeCount(stats.fireExpiryInFlight) ||
    !isSafeCount(stats.fireExpiryRetryWaiting) ||
    !isSafeCount(stats.fireExpiryBlocked) ||
    !isSafeCount(stats.maxFireExpiryRetryCount) ||
    stats.fireExpiryInFlight +
      stats.fireExpiryRetryWaiting +
      stats.fireExpiryBlocked !==
      stats.pendingFireExpiries ||
    (stats.pendingFireExpiries === 0 && stats.maxFireExpiryRetryCount !== 0)
  ) {
    return {
      healthy: false,
      status: "invalid",
      ...EMPTY_PROCESSING_CUSTODY_STATS,
    };
  }
  return {
    healthy: stats.pendingFireExpiries === 0,
    status:
      stats.fireExpiryBlocked > 0
        ? "blocked"
        : stats.pendingFireExpiries > 0
          ? "reconciling"
          : "healthy",
    ...stats,
  };
}

/** Public aggregate only; exact ground-source identities remain private logs. */
export function checkGroundItemCustodyHealth(
  groundItemSystem: GroundItemCustodySource | undefined,
): GroundItemCustodyHealthResult {
  if (!groundItemSystem?.getGroundItemCustodyStats) {
    return {
      healthy: false,
      status: "unavailable",
      ...EMPTY_GROUND_ITEM_CUSTODY_STATS,
    };
  }
  let stats: GroundItemCustodyStats;
  try {
    stats = groundItemSystem.getGroundItemCustodyStats();
  } catch {
    return {
      healthy: false,
      status: "unavailable",
      ...EMPTY_GROUND_ITEM_CUSTODY_STATS,
    };
  }
  if (
    !stats ||
    !GROUND_ITEM_HYDRATION_STATUSES.has(stats.durableHydrationStatus) ||
    typeof stats.hydrationAuthorityAvailable !== "boolean" ||
    typeof stats.expiryAuthorityAvailable !== "boolean" ||
    !isSafeCount(stats.trackedItems) ||
    !isSafeCount(stats.durableSources) ||
    !isSafeCount(stats.pendingCustodyReconciliations) ||
    !isSafeCount(stats.pendingPresentationHydrations) ||
    !isSafeCount(stats.presentationHydrationsInFlight) ||
    !isSafeCount(stats.maxPresentationHydrationAttempts) ||
    !isSafeCount(stats.pendingDurableExpiries) ||
    !isSafeCount(stats.durableExpiriesInFlight) ||
    !isSafeCount(stats.maxDurableExpiryAttempts) ||
    !isSafeCount(stats.pendingPresentationCleanups) ||
    !isSafeCount(stats.maxPresentationCleanupAttempts) ||
    stats.durableSources > stats.trackedItems ||
    stats.presentationHydrationsInFlight >
      stats.pendingPresentationHydrations ||
    stats.durableExpiriesInFlight > stats.pendingDurableExpiries ||
    stats.pendingPresentationHydrations +
      stats.pendingDurableExpiries +
      stats.pendingPresentationCleanups !==
      stats.pendingCustodyReconciliations ||
    (stats.pendingPresentationHydrations === 0 &&
      (stats.presentationHydrationsInFlight !== 0 ||
        stats.maxPresentationHydrationAttempts !== 0)) ||
    (stats.pendingDurableExpiries === 0 &&
      (stats.durableExpiriesInFlight !== 0 ||
        stats.maxDurableExpiryAttempts !== 0)) ||
    (stats.pendingPresentationCleanups === 0 &&
      stats.maxPresentationCleanupAttempts !== 0)
  ) {
    return {
      healthy: false,
      status: "invalid",
      ...EMPTY_GROUND_ITEM_CUSTODY_STATS,
    };
  }

  const status: GroundItemCustodyHealthResult["status"] =
    !stats.hydrationAuthorityAvailable || !stats.expiryAuthorityAvailable
      ? "unavailable"
      : stats.durableHydrationStatus === "failed"
        ? "failed"
        : stats.durableHydrationStatus !== "complete"
          ? "initializing"
          : stats.pendingCustodyReconciliations > 0
            ? "reconciling"
            : "healthy";
  return {
    healthy: status === "healthy",
    status,
    ...stats,
  };
}

/** Public aggregate only; mob, player, and operation identities stay private. */
export function checkLootCustodyHealth(
  lootSystem: LootCustodySource | undefined,
): LootCustodyHealthResult {
  if (!lootSystem?.getLootCustodyStats) {
    return {
      healthy: false,
      status: "unavailable",
      ...EMPTY_LOOT_CUSTODY_STATS,
    };
  }
  let stats: LootCustodyStats;
  try {
    stats = lootSystem.getLootCustodyStats();
  } catch {
    return {
      healthy: false,
      status: "unavailable",
      ...EMPTY_LOOT_CUSTODY_STATS,
    };
  }
  if (
    !stats ||
    !isSafeCount(stats.pendingMobLootCommits) ||
    !isSafeCount(stats.mobLootCommitsInFlight) ||
    !isSafeCount(stats.mobLootCommitsBlocked) ||
    !isSafeCount(stats.maxMobLootCommitAttempts) ||
    stats.mobLootCommitsInFlight > stats.pendingMobLootCommits ||
    stats.mobLootCommitsBlocked > stats.pendingMobLootCommits ||
    stats.mobLootCommitsInFlight + stats.mobLootCommitsBlocked >
      stats.pendingMobLootCommits ||
    (stats.pendingMobLootCommits === 0 &&
      (stats.mobLootCommitsInFlight !== 0 ||
        stats.mobLootCommitsBlocked !== 0 ||
        stats.maxMobLootCommitAttempts !== 0)) ||
    (stats.pendingMobLootCommits > 0 && stats.maxMobLootCommitAttempts === 0)
  ) {
    return {
      healthy: false,
      status: "invalid",
      ...EMPTY_LOOT_CUSTODY_STATS,
    };
  }
  return {
    healthy: stats.pendingMobLootCommits === 0,
    status:
      stats.mobLootCommitsBlocked > 0
        ? "blocked"
        : stats.pendingMobLootCommits > 0
          ? "reconciling"
          : "healthy",
    ...stats,
  };
}

/** Public aggregate only; duel, player, and operation identities stay private. */
export function checkDuelDamageReconciliationHealth(
  combatSystem: DuelDamageReconciliationSource | undefined,
  maxPendingAgeMs = 5_000,
): DuelDamageReconciliationHealthResult {
  if (!combatSystem?.getDuelDamageReconciliationStats) {
    return {
      healthy: false,
      status: "unavailable",
      maxPendingAgeMs,
      ...EMPTY_DUEL_DAMAGE_RECONCILIATION_STATS,
    };
  }
  let stats: DuelDamageReconciliationStats;
  try {
    stats = combatSystem.getDuelDamageReconciliationStats();
  } catch {
    return {
      healthy: false,
      status: "unavailable",
      maxPendingAgeMs,
      ...EMPTY_DUEL_DAMAGE_RECONCILIATION_STATS,
    };
  }
  if (
    !stats ||
    !isSafeCount(stats.pendingOperations) ||
    !isSafeCount(stats.queuedOperations) ||
    !isSafeCount(stats.committingOperations) ||
    !isSafeCount(stats.reconcilingOperations) ||
    !isSafeCount(stats.maxReconciliationAttempts) ||
    !isSafeCount(stats.oldestPendingAgeMs) ||
    !isSafeCount(stats.oldestReconciliationAgeMs) ||
    !Number.isSafeInteger(maxPendingAgeMs) ||
    maxPendingAgeMs < 1_000 ||
    stats.queuedOperations +
      stats.committingOperations +
      stats.reconcilingOperations !==
      stats.pendingOperations ||
    (stats.reconcilingOperations === 0 &&
      (stats.maxReconciliationAttempts !== 0 ||
        stats.oldestReconciliationAgeMs !== 0)) ||
    (stats.pendingOperations === 0 && stats.oldestPendingAgeMs !== 0) ||
    (stats.reconcilingOperations > 0 && stats.maxReconciliationAttempts === 0)
  ) {
    return {
      healthy: false,
      status: "invalid",
      maxPendingAgeMs,
      ...EMPTY_DUEL_DAMAGE_RECONCILIATION_STATS,
    };
  }
  return {
    healthy:
      stats.reconcilingOperations === 0 &&
      stats.oldestPendingAgeMs <= maxPendingAgeMs,
    status:
      stats.reconcilingOperations > 0
        ? "reconciling"
        : stats.oldestPendingAgeMs > maxPendingAgeMs
          ? "stalled"
          : stats.pendingOperations > 0
            ? "processing"
            : "healthy",
    maxPendingAgeMs,
    ...stats,
  };
}

/** Public aggregate only; player and operation identities remain private. */
export async function checkProjectileCostCustodyHealth(
  databaseSystem: ProjectileCostCustodySource | undefined,
  maxAgeMs = PROJECTILE_COST_CUSTODY_MAX_AGE_MS,
  timeoutMs = 1_500,
): Promise<ProjectileCostCustodyHealthResult> {
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < PROJECTILE_COST_CUSTODY_MAX_AGE_MS ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 250
  ) {
    return {
      healthy: false,
      status: "invalid",
      maxAgeMs,
      ...EMPTY_PROJECTILE_COST_CUSTODY_STATS,
    };
  }
  if (!databaseSystem?.getProjectileCostCustodyStatsAsync) {
    return {
      healthy: false,
      status: "unavailable",
      maxAgeMs,
      ...EMPTY_PROJECTILE_COST_CUSTODY_STATS,
    };
  }

  const timeoutMarker = Symbol("projectile-cost-custody-timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const stats = await Promise.race([
      databaseSystem.getProjectileCostCustodyStatsAsync(),
      new Promise<typeof timeoutMarker>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutMarker), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (stats === timeoutMarker) {
      return {
        healthy: false,
        status: "timeout",
        maxAgeMs,
        ...EMPTY_PROJECTILE_COST_CUSTODY_STATS,
      };
    }
    const values = Object.values(stats);
    const unresolved =
      stats.pendingAmmunitionShots +
      stats.firedAmmunitionShots +
      stats.pendingRuneCosts +
      stats.firedRuneCosts +
      stats.invalidOperations;
    if (
      !values.every(isSafeCount) ||
      (unresolved === 0 && stats.oldestUnresolvedAgeMs !== 0) ||
      stats.invalidOperations > 0 ||
      stats.futureTimestampOperations > 0
    ) {
      return {
        healthy: false,
        status: "invalid",
        maxAgeMs,
        ...stats,
      };
    }
    if (stats.oldestUnresolvedAgeMs > maxAgeMs) {
      return {
        healthy: false,
        status: "stalled",
        maxAgeMs,
        ...stats,
      };
    }
    return {
      healthy: true,
      status: unresolved > 0 ? "processing" : "healthy",
      maxAgeMs,
      ...stats,
    };
  } catch {
    return {
      healthy: false,
      status: "unavailable",
      maxAgeMs,
      ...EMPTY_PROJECTILE_COST_CUSTODY_STATS,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function checkDatabaseHealth(
  databaseSystem: DatabaseHealthSource | undefined,
  timeoutMs: number,
): Promise<DatabaseHealthResult> {
  if (!databaseSystem) {
    return {
      healthy: false,
      status: "unavailable",
      latencyMs: 0,
      error: "Database system not available",
    };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<DatabaseHealthResult>((resolve) => {
    timeout = setTimeout(
      () =>
        resolve({
          healthy: false,
          status: "timeout",
          latencyMs: timeoutMs,
          error: `Database health check timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    timeout.unref?.();
  });

  try {
    return await Promise.race([
      databaseSystem.checkHealthAsync().then((result) => ({
        ...result,
        status: result.healthy ? ("healthy" as const) : ("unhealthy" as const),
      })),
      timeoutResult,
    ]);
  } catch (error) {
    return {
      healthy: false,
      status: "unhealthy",
      latencyMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Register health and status endpoints
 *
 * Sets up monitoring endpoints that return server health metrics
 * and current game state information.
 *
 * @param fastify - Fastify server instance
 * @param world - Game world instance
 * @param config - Server configuration
 */
export function registerHealthRoutes(
  fastify: FastifyInstance,
  world: World,
  config: ServerConfig,
): void {
  const strictDatabaseHealth = !/^(0|false|no|off)$/i.test(
    process.env.HEALTH_CHECK_STRICT_DB || "true",
  );
  const databaseHealthTimeoutMs = Math.max(
    250,
    Number.parseInt(process.env.HEALTH_CHECK_DB_TIMEOUT_MS || "1500", 10) ||
      1500,
  );
  const duelDamagePendingMaxAgeMs = Math.max(
    1_000,
    Number.parseInt(
      process.env.HEALTH_DUEL_DAMAGE_PENDING_MAX_AGE_MS || "5000",
      10,
    ) || 5_000,
  );

  // Basic health check
  fastify.get(
    "/health",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const maintenanceMode = isMaintenanceModeActive();
      const baseHealth = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        maintenanceMode,
      };

      const databaseSystem = world.getSystem("database") as
        DatabaseSystem | undefined;
      const [databaseHealth, projectileCostCustody] = await Promise.all([
        checkDatabaseHealth(databaseSystem, databaseHealthTimeoutMs),
        checkProjectileCostCustodyHealth(
          databaseSystem,
          PROJECTILE_COST_CUSTODY_MAX_AGE_MS,
          databaseHealthTimeoutMs,
        ),
      ]);
      const publicDatabaseHealth = {
        ...databaseHealth,
        ...(databaseHealth.error
          ? { error: "Database health check failed" }
          : {}),
      };
      const processingSystem = world.getSystem("processing") as
        ProcessingCustodySource | undefined;
      const processingCustody = checkProcessingCustodyHealth(processingSystem);
      const groundItemSystem = world.getSystem("ground-items") as
        GroundItemCustodySource | undefined;
      const groundItemCustody = checkGroundItemCustodyHealth(groundItemSystem);
      const lootSystem = world.getSystem("loot") as
        LootCustodySource | undefined;
      const lootCustody = checkLootCustodyHealth(lootSystem);
      const combatSystem = world.getSystem("combat") as
        DuelDamageReconciliationSource | undefined;
      const duelDamageReconciliation = checkDuelDamageReconciliationHealth(
        combatSystem,
        duelDamagePendingMaxAgeMs,
      );

      const health = {
        status:
          databaseHealth.healthy &&
          processingCustody.healthy &&
          groundItemCustody.healthy &&
          lootCustody.healthy &&
          projectileCostCustody.healthy &&
          duelDamageReconciliation.healthy
            ? "ok"
            : "degraded",
        ...baseHealth,
        database: publicDatabaseHealth,
        processingCustody,
        groundItemCustody,
        lootCustody,
        projectileCostCustody,
        duelDamageReconciliation,
      };

      const statusCode =
        (strictDatabaseHealth && !databaseHealth.healthy) ||
        !processingCustody.healthy ||
        !groundItemCustody.healthy ||
        !lootCustody.healthy ||
        !projectileCostCustody.healthy ||
        !duelDamageReconciliation.healthy
          ? 503
          : 200;
      return reply.code(statusCode).send(health);
    },
  );

  // Detailed status with connected players
  fastify.get(
    "/status",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const status = {
        uptime: Math.round(world.time),
        protected: config.adminCode !== undefined,
        connectedUserCount: 0,
        commitHash: config.commitHash,
      };

      // Import type from our local types
      const network =
        world.network as unknown as import("../../types.js").ServerNetworkWithSockets;

      status.connectedUserCount = network.sockets.size;

      return reply.code(200).send(status);
    },
  );
}
