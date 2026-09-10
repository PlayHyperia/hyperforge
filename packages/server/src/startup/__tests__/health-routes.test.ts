import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../config.js";
import {
  checkDatabaseHealth,
  checkDuelDamageReconciliationHealth,
  checkGroundItemCustodyHealth,
  checkLootCustodyHealth,
  checkProjectileCostCustodyHealth,
  checkProcessingCustodyHealth,
  PROJECTILE_COST_CUSTODY_MAX_AGE_MS,
  registerHealthRoutes,
} from "../routes/health-routes.js";

const originalStrictDatabaseHealth = process.env.HEALTH_CHECK_STRICT_DB;
const originalLegacyDatabaseHealth = process.env.HEALTH_CHECK_DATABASE;

afterEach(() => {
  if (originalStrictDatabaseHealth === undefined) {
    delete process.env.HEALTH_CHECK_STRICT_DB;
  } else {
    process.env.HEALTH_CHECK_STRICT_DB = originalStrictDatabaseHealth;
  }
  if (originalLegacyDatabaseHealth === undefined) {
    delete process.env.HEALTH_CHECK_DATABASE;
  } else {
    process.env.HEALTH_CHECK_DATABASE = originalLegacyDatabaseHealth;
  }
});

const healthyProcessingCustody = {
  pendingFireExpiries: 0,
  fireExpiryInFlight: 0,
  fireExpiryRetryWaiting: 0,
  fireExpiryBlocked: 0,
  maxFireExpiryRetryCount: 0,
};

const healthyGroundItemCustody = {
  durableHydrationStatus: "complete" as const,
  hydrationAuthorityAvailable: true,
  expiryAuthorityAvailable: true,
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

const healthyDuelDamageReconciliation = {
  pendingOperations: 0,
  queuedOperations: 0,
  committingOperations: 0,
  reconcilingOperations: 0,
  maxReconciliationAttempts: 0,
  oldestPendingAgeMs: 0,
  oldestReconciliationAgeMs: 0,
};

const healthyLootCustody = {
  pendingMobLootCommits: 0,
  mobLootCommitsInFlight: 0,
  mobLootCommitsBlocked: 0,
  maxMobLootCommitAttempts: 0,
};

const healthyProjectileCostCustody = {
  pendingAmmunitionShots: 0,
  firedAmmunitionShots: 0,
  pendingRuneCosts: 0,
  firedRuneCosts: 0,
  invalidOperations: 0,
  futureTimestampOperations: 0,
  oldestUnresolvedAgeMs: 0,
};

function createWorld(
  checkHealthAsync?: () => Promise<unknown>,
  processingCustody:
    typeof healthyProcessingCustody | null = healthyProcessingCustody,
  groundItemCustody:
    typeof healthyGroundItemCustody | null = healthyGroundItemCustody,
  duelDamageReconciliation:
    | typeof healthyDuelDamageReconciliation
    | null = healthyDuelDamageReconciliation,
  lootCustody: typeof healthyLootCustody | null = healthyLootCustody,
  projectileCostCustody:
    typeof healthyProjectileCostCustody | null = healthyProjectileCostCustody,
) {
  return {
    getSystem: vi.fn((name: string) => {
      if (name === "database") {
        return checkHealthAsync
          ? {
              checkHealthAsync,
              ...(projectileCostCustody
                ? {
                    getProjectileCostCustodyStatsAsync: async () =>
                      projectileCostCustody,
                  }
                : {}),
            }
          : undefined;
      }
      if (name === "processing" && processingCustody) {
        return { getProcessingCustodyStats: () => processingCustody };
      }
      if (name === "ground-items" && groundItemCustody) {
        return { getGroundItemCustodyStats: () => groundItemCustody };
      }
      if (name === "loot" && lootCustody) {
        return { getLootCustodyStats: () => lootCustody };
      }
      if (name === "combat" && duelDamageReconciliation) {
        return {
          getDuelDamageReconciliationStats: () => duelDamageReconciliation,
        };
      }
      return undefined;
    }),
    network: { sockets: new Map() },
    time: 0,
  };
}

async function requestHealth(
  checkHealthAsync?: () => Promise<unknown>,
  processingCustody:
    typeof healthyProcessingCustody | null = healthyProcessingCustody,
  groundItemCustody:
    typeof healthyGroundItemCustody | null = healthyGroundItemCustody,
  duelDamageReconciliation:
    | typeof healthyDuelDamageReconciliation
    | null = healthyDuelDamageReconciliation,
  lootCustody: typeof healthyLootCustody | null = healthyLootCustody,
  projectileCostCustody:
    typeof healthyProjectileCostCustody | null = healthyProjectileCostCustody,
) {
  const fastify = Fastify();
  const world = createWorld(
    checkHealthAsync,
    processingCustody,
    groundItemCustody,
    duelDamageReconciliation,
    lootCustody,
    projectileCostCustody,
  );
  registerHealthRoutes(
    fastify,
    world as never,
    { commitHash: "health-test" } as ServerConfig,
  );
  try {
    const response = await fastify.inject({ method: "GET", url: "/health" });
    return { response, world };
  } finally {
    await fastify.close();
  }
}

describe("database health policy", () => {
  it("always executes the real database probe and reports measured state", async () => {
    process.env.HEALTH_CHECK_DATABASE = "false";
    const checkHealthAsync = vi.fn(async () => ({
      healthy: true,
      latencyMs: 7,
      poolInfo: { totalCount: 3, idleCount: 2, waitingCount: 0 },
    }));

    const { response } = await requestHealth(checkHealthAsync);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      database: {
        healthy: true,
        status: "healthy",
        latencyMs: 7,
        poolInfo: { totalCount: 3, idleCount: 2, waitingCount: 0 },
      },
      processingCustody: {
        healthy: true,
        status: "healthy",
        ...healthyProcessingCustody,
      },
      groundItemCustody: {
        healthy: true,
        status: "healthy",
        ...healthyGroundItemCustody,
      },
      lootCustody: {
        healthy: true,
        status: "healthy",
        ...healthyLootCustody,
      },
      projectileCostCustody: {
        healthy: true,
        status: "healthy",
        maxAgeMs: PROJECTILE_COST_CUSTODY_MAX_AGE_MS,
        ...healthyProjectileCostCustody,
      },
      duelDamageReconciliation: {
        healthy: true,
        status: "healthy",
        ...healthyDuelDamageReconciliation,
      },
    });
    expect(checkHealthAsync).toHaveBeenCalledOnce();
  });

  it("allows only bounded in-flight projectile custody and fails once it is stale", async () => {
    const inFlight = await requestHealth(
      async () => ({ healthy: true, latencyMs: 2 }),
      healthyProcessingCustody,
      healthyGroundItemCustody,
      healthyDuelDamageReconciliation,
      healthyLootCustody,
      {
        ...healthyProjectileCostCustody,
        firedAmmunitionShots: 1,
        oldestUnresolvedAgeMs: PROJECTILE_COST_CUSTODY_MAX_AGE_MS,
      },
    );
    expect(inFlight.response.statusCode).toBe(200);
    expect(inFlight.response.json()).toMatchObject({
      projectileCostCustody: {
        healthy: true,
        status: "processing",
        firedAmmunitionShots: 1,
        maxAgeMs: PROJECTILE_COST_CUSTODY_MAX_AGE_MS,
      },
    });

    const stale = await requestHealth(
      async () => ({ healthy: true, latencyMs: 2 }),
      healthyProcessingCustody,
      healthyGroundItemCustody,
      healthyDuelDamageReconciliation,
      healthyLootCustody,
      {
        ...healthyProjectileCostCustody,
        firedRuneCosts: 1,
        oldestUnresolvedAgeMs: PROJECTILE_COST_CUSTODY_MAX_AGE_MS + 1,
      },
    );
    expect(stale.response.statusCode).toBe(503);
    expect(stale.response.json()).toMatchObject({
      status: "degraded",
      projectileCostCustody: {
        healthy: false,
        status: "stalled",
        firedRuneCosts: 1,
      },
    });
    expect(stale.response.body).not.toContain("operationId");
    expect(stale.response.body).not.toContain("playerId");
  });

  it("fails projectile custody closed on malformed, future, unavailable, or stalled probes", async () => {
    await expect(
      checkProjectileCostCustodyHealth(undefined),
    ).resolves.toMatchObject({ healthy: false, status: "unavailable" });
    await expect(
      checkProjectileCostCustodyHealth({
        getProjectileCostCustodyStatsAsync: async () => ({
          ...healthyProjectileCostCustody,
          invalidOperations: 1,
          oldestUnresolvedAgeMs: 1,
        }),
      }),
    ).resolves.toMatchObject({ healthy: false, status: "invalid" });
    await expect(
      checkProjectileCostCustodyHealth({
        getProjectileCostCustodyStatsAsync: async () => ({
          ...healthyProjectileCostCustody,
          futureTimestampOperations: 1,
        }),
      }),
    ).resolves.toMatchObject({ healthy: false, status: "invalid" });
    await expect(
      checkProjectileCostCustodyHealth(
        {
          getProjectileCostCustodyStatsAsync: () => new Promise(() => {}),
        },
        PROJECTILE_COST_CUSTODY_MAX_AGE_MS,
        250,
      ),
    ).resolves.toMatchObject({ healthy: false, status: "timeout" });
  });

  it("fails closed by default when the checked database is unhealthy", async () => {
    const { response } = await requestHealth(async () => ({
      healthy: false,
      latencyMs: 11,
      error: "connection unavailable",
    }));

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      database: {
        healthy: false,
        status: "unhealthy",
        latencyMs: 11,
      },
    });
    expect(response.body).not.toContain("connection unavailable");
  });

  it("supports an explicit non-strict liveness response without hiding failure", async () => {
    process.env.HEALTH_CHECK_STRICT_DB = "false";
    const { response } = await requestHealth(async () => ({
      healthy: false,
      latencyMs: 4,
      error: "database offline",
    }));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "degraded",
      database: {
        healthy: false,
        status: "unhealthy",
        error: "Database health check failed",
      },
    });
  });

  it("distinguishes an unavailable database system from a skipped check", async () => {
    const { response } = await requestHealth();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      database: {
        healthy: false,
        status: "unavailable",
        error: "Database health check failed",
      },
    });
  });

  it("bounds a stalled probe and reports a timeout", async () => {
    const result = await checkDatabaseHealth(
      {
        checkHealthAsync: () => new Promise(() => {}),
      },
      5,
    );

    expect(result).toEqual({
      healthy: false,
      status: "timeout",
      latencyMs: 5,
      error: "Database health check timed out after 5ms",
    });
  });

  it("fails readiness closed while an exact fire expiry is reconciling", async () => {
    const { response } = await requestHealth(
      async () => ({ healthy: true, latencyMs: 2 }),
      {
        pendingFireExpiries: 1,
        fireExpiryInFlight: 0,
        fireExpiryRetryWaiting: 1,
        fireExpiryBlocked: 0,
        maxFireExpiryRetryCount: 9,
      },
    );

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      processingCustody: {
        healthy: false,
        status: "reconciling",
        pendingFireExpiries: 1,
        fireExpiryRetryWaiting: 1,
        maxFireExpiryRetryCount: 9,
      },
    });
  });

  it("reports blocked fire custody without exposing its identity or error", async () => {
    const { response } = await requestHealth(
      async () => ({ healthy: true, latencyMs: 2 }),
      {
        pendingFireExpiries: 1,
        fireExpiryInFlight: 0,
        fireExpiryRetryWaiting: 0,
        fireExpiryBlocked: 1,
        maxFireExpiryRetryCount: 3,
      },
    );

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      processingCustody: {
        healthy: false,
        status: "blocked",
        fireExpiryBlocked: 1,
      },
    });
    expect(response.body).not.toContain("fireId");
    expect(response.body).not.toContain("lastError");
  });

  it("treats unavailable or internally inconsistent custody metrics as unhealthy", () => {
    expect(checkProcessingCustodyHealth(undefined)).toMatchObject({
      healthy: false,
      status: "unavailable",
    });
    expect(
      checkProcessingCustodyHealth({
        getProcessingCustodyStats: () => ({
          pendingFireExpiries: 2,
          fireExpiryInFlight: 1,
          fireExpiryRetryWaiting: 0,
          fireExpiryBlocked: 0,
          maxFireExpiryRetryCount: 1,
        }),
      }),
    ).toMatchObject({ healthy: false, status: "invalid" });
  });

  it("fails readiness closed while durable ground presentation is reconciling", async () => {
    const { response } = await requestHealth(
      async () => ({ healthy: true, latencyMs: 2 }),
      healthyProcessingCustody,
      {
        ...healthyGroundItemCustody,
        trackedItems: 2,
        durableSources: 1,
        pendingCustodyReconciliations: 1,
        pendingPresentationHydrations: 1,
        maxPresentationHydrationAttempts: 8,
      },
    );

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      groundItemCustody: {
        healthy: false,
        status: "reconciling",
        pendingCustodyReconciliations: 1,
        pendingPresentationHydrations: 1,
        maxPresentationHydrationAttempts: 8,
      },
    });
    expect(response.body).not.toContain("sourceId");
    expect(response.body).not.toContain("lastError");
  });

  it("fails readiness closed while an exact mob-loot commit is reconciling", async () => {
    const { response } = await requestHealth(
      async () => ({ healthy: true, latencyMs: 2 }),
      healthyProcessingCustody,
      healthyGroundItemCustody,
      healthyDuelDamageReconciliation,
      {
        pendingMobLootCommits: 1,
        mobLootCommitsInFlight: 0,
        mobLootCommitsBlocked: 0,
        maxMobLootCommitAttempts: 8,
      },
    );

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      lootCustody: {
        healthy: false,
        status: "reconciling",
        pendingMobLootCommits: 1,
        maxMobLootCommitAttempts: 8,
      },
    });
    expect(response.body).not.toContain("operationId");
    expect(response.body).not.toContain("lastError");
    expect(
      checkLootCustodyHealth({
        getLootCustodyStats: () => ({
          pendingMobLootCommits: 1,
          mobLootCommitsInFlight: 0,
          mobLootCommitsBlocked: 1,
          maxMobLootCommitAttempts: 9,
        }),
      }),
    ).toMatchObject({ healthy: false, status: "blocked" });
    expect(
      checkLootCustodyHealth({
        getLootCustodyStats: () => ({
          pendingMobLootCommits: 1,
          mobLootCommitsInFlight: 1,
          mobLootCommitsBlocked: 1,
          maxMobLootCommitAttempts: 9,
        }),
      }),
    ).toMatchObject({ healthy: false, status: "invalid" });
  });

  it("fails closed until ground-source hydration and authorities are ready", () => {
    expect(checkGroundItemCustodyHealth(undefined)).toMatchObject({
      healthy: false,
      status: "unavailable",
    });
    expect(
      checkGroundItemCustodyHealth({
        getGroundItemCustodyStats: () => ({
          ...healthyGroundItemCustody,
          durableHydrationStatus: "in_progress",
        }),
      }),
    ).toMatchObject({ healthy: false, status: "initializing" });
    expect(
      checkGroundItemCustodyHealth({
        getGroundItemCustodyStats: () => ({
          ...healthyGroundItemCustody,
          durableHydrationStatus: "failed",
        }),
      }),
    ).toMatchObject({ healthy: false, status: "failed" });
    expect(
      checkGroundItemCustodyHealth({
        getGroundItemCustodyStats: () => ({
          ...healthyGroundItemCustody,
          expiryAuthorityAvailable: false,
        }),
      }),
    ).toMatchObject({ healthy: false, status: "unavailable" });
  });

  it("rejects internally inconsistent ground custody aggregates", () => {
    expect(
      checkGroundItemCustodyHealth({
        getGroundItemCustodyStats: () => ({
          ...healthyGroundItemCustody,
          pendingCustodyReconciliations: 1,
          pendingDurableExpiries: 1,
          durableExpiriesInFlight: 2,
        }),
      }),
    ).toMatchObject({ healthy: false, status: "invalid" });
  });

  it("fails readiness closed while an exact duel damage commit is reconciling", async () => {
    const { response } = await requestHealth(
      async () => ({ healthy: true, latencyMs: 2 }),
      healthyProcessingCustody,
      healthyGroundItemCustody,
      {
        pendingOperations: 2,
        queuedOperations: 1,
        committingOperations: 0,
        reconcilingOperations: 1,
        maxReconciliationAttempts: 3,
        oldestPendingAgeMs: 1_250,
        oldestReconciliationAgeMs: 1_250,
      },
    );

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      duelDamageReconciliation: {
        healthy: false,
        status: "reconciling",
        pendingOperations: 2,
        queuedOperations: 1,
        reconcilingOperations: 1,
        maxReconciliationAttempts: 3,
      },
    });
    expect(response.body).not.toContain("operationId");
    expect(response.body).not.toContain("playerId");
  });

  it("rejects unavailable or inconsistent duel damage aggregates", () => {
    expect(checkDuelDamageReconciliationHealth(undefined)).toMatchObject({
      healthy: false,
      status: "unavailable",
    });
    expect(
      checkDuelDamageReconciliationHealth({
        getDuelDamageReconciliationStats: () => ({
          ...healthyDuelDamageReconciliation,
          pendingOperations: 1,
          reconcilingOperations: 1,
        }),
      }),
    ).toMatchObject({ healthy: false, status: "invalid" });
  });

  it("fails readiness when a commit promise stalls before returning an error", () => {
    expect(
      checkDuelDamageReconciliationHealth(
        {
          getDuelDamageReconciliationStats: () => ({
            ...healthyDuelDamageReconciliation,
            pendingOperations: 1,
            committingOperations: 1,
            oldestPendingAgeMs: 5_001,
          }),
        },
        5_000,
      ),
    ).toMatchObject({
      healthy: false,
      status: "stalled",
      maxPendingAgeMs: 5_000,
      oldestPendingAgeMs: 5_001,
    });
  });

  it("publishes only an aggregate connection count on the public status route", async () => {
    const fastify = Fastify();
    const world = {
      getSystem: vi.fn(),
      network: {
        sockets: new Map([
          [
            "private-socket-id",
            {
              player: {
                data: { name: "private-name", userId: "private-user-id" },
                node: { position: { x: 1, y: 2, z: 3 } },
              },
            },
          ],
        ]),
      },
      time: 42,
    };
    registerHealthRoutes(
      fastify,
      world as never,
      { commitHash: "health-test" } as ServerConfig,
    );

    try {
      const response = await fastify.inject({ method: "GET", url: "/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        uptime: 42,
        protected: false,
        connectedUserCount: 1,
        commitHash: "health-test",
      });
      expect(response.body).not.toContain("private-");
      expect(response.json()).not.toHaveProperty("connectedUsers");
    } finally {
      await fastify.close();
    }
  });
});
