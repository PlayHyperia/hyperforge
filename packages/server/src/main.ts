/**
 * Hyperia Server - Startup orchestrator
 *
 * This module contains the actual server initialization logic.
 * It is loaded dynamically from `src/index.ts` after polyfills are installed.
 */

// Import startup modules
import { loadConfig } from "./startup/config.js";
import { initializeDatabase } from "./startup/database.js";
import { initializeWorld } from "./startup/world.js";
import { createHttpServer } from "./startup/http-server.js";
import { registerApiRoutes } from "./startup/api-routes.js";
import { registerWebSocket } from "./startup/websocket.js";
import { registerShutdownHandlers } from "./startup/shutdown.js";
import { errMsg } from "./shared/errMsg.js";
import { assertJwtSigningKeyAuthority } from "./infrastructure/auth/jwt-signing-key-authority.js";
import { readDistributedRateLimitConfig } from "./infrastructure/rate-limit/distributed-rate-limit.js";
import { resolveTrustedProxy } from "./infrastructure/rate-limit/trusted-proxy.js";
import {
  getCloudflareOriginSecretFingerprint,
  resolveCloudflareOriginSecret,
} from "./infrastructure/cloudflare/origin-lock.js";

// Import embedded agent system
import { initializeAgents } from "./eliza/index.js";

// Import streaming duel scheduler authority
import {
  initStreamingDuelAuthority,
  resolveStreamingDuelAuthorityConfig,
  validateStreamingDuelProcessTopology,
} from "./systems/StreamingDuelScheduler/authority.js";
import { DuelArenaOraclePublisher } from "./oracle/DuelArenaOraclePublisher.js";
import { getDuelArenaOracleConfig } from "./oracle/config.js";

// Import stream capture pipeline
import { initStreamCapture } from "./streaming/stream-capture.js";

// Import memory monitoring infrastructure
import {
  startMemoryMonitor as startMemoryMonitorInfra,
  type MemoryMonitorConfig,
} from "./infrastructure/memory-monitor.js";
import type { World } from "@hyperforge/shared";

function resolveBooleanEnvFlag(name: string, defaultEnabled: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultEnabled;
  const normalized = raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
  if (!normalized) return defaultEnabled;
  return !["0", "false", "no", "off"].includes(normalized);
}

/**
 * Starts the Hyperia server
 *
 * This is the main entry point for server initialization. It orchestrates
 * all startup modules in the correct sequence to bring the server online.
 *
 * The server supports hot reload in development via SIGUSR2 signal.
 */
async function startServer() {
  // Prevent duplicate server initialization
  const globalWithFlag = globalThis as typeof globalThis & {
    __HYPERIA_SERVER_STARTING__?: boolean;
  };

  if (globalWithFlag.__HYPERIA_SERVER_STARTING__) {
    console.warn(
      "[Server] Server already starting, skipping duplicate initialization",
    );
    return;
  }

  globalWithFlag.__HYPERIA_SERVER_STARTING__ = true;

  // Step 1: Load configuration
  const config = await loadConfig();

  // Resolve the complete issuer/verifier authority before opening databases,
  // HTTP listeners, WebSockets, or agent runtimes. This makes a partial rollout
  // with a missing active key fail closed instead of splitting replicas.
  const jwtAuthority = assertJwtSigningKeyAuthority(process.env);
  const jwtKeyEvidence = Object.entries(jwtAuthority.keyFingerprints)
    .map(([keyId, keyFingerprint]) => `${keyId}:${keyFingerprint}`)
    .join(",");
  if (jwtAuthority.mode === "development-fallback") {
    console.warn(
      "[Security] Using the local development JWT fallback; configure a private signing authority before production",
    );
  } else {
    process.stdout.write(
      `[Security] JWT authority ready mode=${jwtAuthority.mode} active=${jwtAuthority.activeKeyId ?? "legacy-no-kid"} verify=${jwtKeyEvidence}\n`,
    );
  }

  const distributedRateLimitAuthority = readDistributedRateLimitConfig(
    process.env,
  );
  const trustedProxyAuthority = resolveTrustedProxy(process.env);
  const cloudflareOriginSecret = resolveCloudflareOriginSecret(process.env);
  if (distributedRateLimitAuthority.enabled) {
    process.stdout.write(
      `[Security] Distributed authentication rate-limit authority ready key=${distributedRateLimitAuthority.keyFingerprint}\n`,
    );
  }
  process.stdout.write(
    `[Security] Trusted proxy authority ready entries=${trustedProxyAuthority === false ? 0 : trustedProxyAuthority === true ? "all-local-only" : trustedProxyAuthority.length}\n`,
  );
  if (cloudflareOriginSecret) {
    process.stdout.write(
      `[Security] Cloudflare origin-lock authority ready key=${getCloudflareOriginSecretFingerprint(cloudflareOriginSecret)}\n`,
    );
  }

  const isDevelopment = config.nodeEnv !== "production";

  // Validate critical secrets in production
  if (!isDevelopment) {
    const missing: string[] = [];
    const useLocalPostgres =
      process.env.USE_LOCAL_POSTGRES === "true" ||
      process.env.USE_LOCAL_POSTGRES === "1";
    if (!process.env.DATABASE_URL && !useLocalPostgres) {
      missing.push("DATABASE_URL or USE_LOCAL_POSTGRES=true");
    }
    if (
      new TextEncoder().encode(process.env.KILL_TOKEN_SECRET?.trim() ?? "")
        .byteLength < 32
    ) {
      missing.push("KILL_TOKEN_SECRET (32+ bytes)");
    }
    if (missing.length > 0) {
      console.error(
        `[Server] FATAL: Missing required production config: ${missing.join(", ")}`,
      );
      process.exit(1);
    }
    const warnings: string[] = [];
    if (!process.env.PRIVY_APP_ID && !process.env.PUBLIC_PRIVY_APP_ID)
      warnings.push("PRIVY_APP_ID");
    if (!process.env.PRIVY_APP_SECRET) warnings.push("PRIVY_APP_SECRET");
    if (warnings.length > 0) {
      console.warn(
        `[Server] WARNING: Missing recommended production config: ${warnings.join(", ")}`,
      );
    }
  }
  const streamingDuelEnabled = resolveBooleanEnvFlag(
    "STREAMING_DUEL_ENABLED",
    !isDevelopment,
  );
  const streamCaptureEnabled = resolveBooleanEnvFlag(
    "STREAMING_CAPTURE_ENABLED",
    !isDevelopment,
  );
  process.env.STREAMING_DUEL_ENABLED = streamingDuelEnabled ? "true" : "false";
  process.env.STREAMING_CAPTURE_ENABLED = streamCaptureEnabled
    ? "true"
    : "false";
  const streamingAuthorityConfig = resolveStreamingDuelAuthorityConfig();
  validateStreamingDuelProcessTopology({
    nodeEnv: config.nodeEnv,
    streamingDuelEnabled,
    streamCaptureEnabled,
    authority: streamingAuthorityConfig,
  });

  // Step 2: Initialize database
  const dbContext = await initializeDatabase(config);

  // Step 3: Initialize world
  const world = await initializeWorld(config, dbContext);

  if (process.env.DUEL_ARENA_ORACLE_ENABLED === "true") {
    const oraclePublisher = new DuelArenaOraclePublisher(
      world,
      getDuelArenaOracleConfig(),
    );
    await oraclePublisher.init();
  }

  // Step 3b: Initialize Web3 (EVM chain writer) if enabled
  let web3Context: { shutdown: () => Promise<void> } | null = null;
  if (process.env.WEB3_ENABLED === "true") {
    try {
      const { initializeWeb3 } = await import("./startup/web3.js");
      web3Context = await initializeWeb3(world);
    } catch (err) {
      console.warn(
        "[Server] ⚠️ Web3 initialization failed, continuing without chain writer:",
        errMsg(err),
      );
      web3Context = null;
    }
  }

  // Step 4: Create HTTP server
  const fastify = await createHttpServer(config);

  // Step 5: Register API routes
  const streamingRoutes = registerApiRoutes(fastify, world, config);

  // Step 6: Register WebSocket
  registerWebSocket(fastify, world);

  // Step 7: Start listening
  await fastify.listen({ port: config.port, host: "0.0.0.0" });

  // Step 7b: Start uWS game WebSocket server (unless disabled)
  if (process.env.UWS_ENABLED !== "false") {
    try {
      const { createUwsServer, getUwsApp } =
        await import("./startup/uws-server.js");
      const listenSocket = await createUwsServer(world, config.uwsPort);
      if (!listenSocket) {
        throw new Error(`uWS failed to bind to port ${config.uwsPort}`);
      }
      // Wire uWS pub/sub to BroadcastManager for native C++ fan-out
      const uwsApp = getUwsApp();
      const net = world.network as unknown as {
        enablePubSub?: (app: unknown) => void;
      };
      if (uwsApp && net?.enablePubSub) {
        net.enablePubSub(uwsApp);
      }
    } catch (err) {
      console.warn(
        `[Server] ⚠️ uWebSockets.js failed to load, falling back to Fastify /ws transport:`,
        errMsg(err),
      );
      // Re-register the Fastify /ws route as fallback
      const { registerWebSocket: registerFallbackWs } =
        await import("./startup/websocket.js");
      process.env.UWS_ENABLED = "false";
      registerFallbackWs(fastify, world);
    }
  }

  // Step 8: Initialize streaming duel scheduler (BEFORE agents so it can track their spawns)
  if (streamingDuelEnabled) {
    try {
      await initStreamingDuelAuthority(
        world,
        dbContext.pgPool,
        streamingAuthorityConfig,
      );
    } catch (err) {
      throw new Error(
        `Streaming duel scheduler authority failed to initialize: ${errMsg(err)}`,
      );
    }
  }

  // Step 8.5: Wire up thought persistence to DB (before agent init so hydration works)
  try {
    const { setThoughtDb } = await import("./eliza/dashboardInterop.js");
    setThoughtDb(dbContext.drizzleDb);
  } catch {
    // Non-critical — thoughts will stay in-memory only
  }

  // Step 9: Initialize embedded agents
  try {
    const duelServerAgentMode = (process.env.DUEL_SERVER_AGENT_MODE || "")
      .trim()
      .toLowerCase();
    const externalAgentsOnly =
      duelServerAgentMode === "external" ||
      duelServerAgentMode === "external-only";
    const agentInitConfig: NonNullable<Parameters<typeof initializeAgents>[1]> =
      {
        autoStartAgents:
          !externalAgentsOnly &&
          resolveBooleanEnvFlag("AUTO_START_AGENTS", true),
      };
    if (externalAgentsOnly) {
      agentInitConfig.spawnModelAgents = false;
      agentInitConfig.maxModelAgents = 0;
    }
    await initializeAgents(world, agentInitConfig);
  } catch (err) {
    if (streamingDuelEnabled) {
      throw new Error(
        `Streaming duel agent initialization failed: ${errMsg(err)}`,
      );
    }
    console.error(
      "[Server] ⚠️ Agent initialization failed, continuing without agents:",
      errMsg(err),
    );
  }

  // Step 10: Initialize stream capture pipeline (RTMPBridge → HLS)
  if (streamCaptureEnabled) {
    try {
      const captureStarted = await initStreamCapture();
      if (!captureStarted) {
        throw new Error("streaming_capture_start_rejected");
      }
    } catch (err) {
      throw new Error(
        `Streaming capture initialization failed: ${errMsg(err)}`,
      );
    }
  }

  // Register shutdown handlers
  registerShutdownHandlers(
    fastify,
    world,
    dbContext,
    web3Context,
    streamingRoutes,
  );

  // Start periodic memory monitoring to catch leaks early
  startMemoryMonitor(world);
}

type CollectionMetric = {
  path: string;
  kind: "array" | "map" | "set" | "object" | "bytes";
  size: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function getCollectionMetric(
  value: unknown,
): Omit<CollectionMetric, "path"> | null {
  if (Array.isArray(value)) {
    return { kind: "array", size: value.length };
  }
  if (value instanceof Map) {
    return { kind: "map", size: value.size };
  }
  if (value instanceof Set) {
    return { kind: "set", size: value.size };
  }
  if (value instanceof ArrayBuffer) {
    return { kind: "bytes", size: value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    return { kind: "bytes", size: value.byteLength };
  }
  if (isPlainObject(value)) {
    return { kind: "object", size: Object.keys(value).length };
  }
  return null;
}

function collectCollectionMetrics(
  prefix: string,
  value: unknown,
  out: CollectionMetric[],
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, fieldValue] of Object.entries(record)) {
    const fieldPath = `${prefix}.${key}`;
    const metric = getCollectionMetric(fieldValue);
    if (metric) {
      out.push({ path: fieldPath, ...metric });
      if (!isPlainObject(fieldValue)) {
        continue;
      }
    }
    if (!isPlainObject(fieldValue)) continue;
    for (const [nestedKey, nestedValue] of Object.entries(fieldValue)) {
      const nestedPath = `${fieldPath}.${nestedKey}`;
      const nestedMetric = getCollectionMetric(nestedValue);
      if (nestedMetric) {
        out.push({ path: nestedPath, ...nestedMetric });
      }
    }
  }
}

function getCollectionSize(value: unknown): number | null {
  if (value instanceof Map || value instanceof Set) {
    return value.size;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length;
  }
  return null;
}

function buildNetworkDebugSummary(world: unknown): string {
  const worldRecord = world as {
    systemsByName?: Map<string, unknown>;
    entities?: {
      items?: Map<string, unknown>;
      players?: Map<string, unknown>;
    };
  };

  const networkSystem =
    worldRecord.systemsByName instanceof Map
      ? worldRecord.systemsByName.get("network")
      : undefined;
  if (!networkSystem || typeof networkSystem !== "object") {
    return "";
  }

  const metrics: string[] = [];
  const pushMetric = (label: string, value: unknown): void => {
    const size = getCollectionSize(value);
    if (size !== null) {
      metrics.push(`${label}=${size}`);
    }
  };

  const networkRecord = networkSystem as {
    sockets?: unknown;
    processingRateLimiter?: unknown;
    socketManager?: {
      socketFirstSeenAt?: unknown;
      socketMissedPongs?: unknown;
      pingTimestamps?: unknown;
      socketRTT?: unknown;
      reconnectTimers?: unknown;
      disconnectedPlayers?: unknown;
      combatLogoutTimers?: unknown;
    };
  };

  pushMetric("network.sockets", networkRecord.sockets);
  pushMetric(
    "network.processingRateLimiter",
    networkRecord.processingRateLimiter,
  );

  const sockets = networkRecord.sockets;
  if (sockets instanceof Map) {
    let totalBufferedBytes = 0;
    let maxBufferedBytes = 0;

    for (const socket of sockets.values()) {
      const bufferedAmount = Number(
        (
          socket as {
            ws?: { bufferedAmount?: unknown };
          }
        ).ws?.bufferedAmount ?? 0,
      );
      if (!Number.isFinite(bufferedAmount) || bufferedAmount <= 0) {
        continue;
      }
      totalBufferedBytes += bufferedAmount;
      if (bufferedAmount > maxBufferedBytes) {
        maxBufferedBytes = bufferedAmount;
      }
    }

    const MB = 1024 * 1024;
    metrics.push(`socket.bufferedMB=${(totalBufferedBytes / MB).toFixed(1)}`);
    metrics.push(`socket.maxBufferedMB=${(maxBufferedBytes / MB).toFixed(1)}`);
  }

  const socketManager = networkRecord.socketManager;
  if (socketManager && typeof socketManager === "object") {
    pushMetric("socket.firstSeen", socketManager.socketFirstSeenAt);
    pushMetric("socket.missedPongs", socketManager.socketMissedPongs);
    pushMetric("socket.pingTimestamps", socketManager.pingTimestamps);
    pushMetric("socket.rtt", socketManager.socketRTT);
    pushMetric("socket.reconnectTimers", socketManager.reconnectTimers);
    pushMetric("socket.disconnectedPlayers", socketManager.disconnectedPlayers);
    pushMetric("socket.combatLogoutTimers", socketManager.combatLogoutTimers);
  }

  pushMetric("world.entities.items", worldRecord.entities?.items);
  pushMetric("world.entities.players", worldRecord.entities?.players);

  return metrics.join(" | ");
}

function buildCollectionSummary(world: unknown, limit = 12): string {
  const metrics: CollectionMetric[] = [];

  collectCollectionMetrics("world", world, metrics);
  const worldRecord = world as {
    __busListenerMap?: Map<string, Map<unknown, unknown>>;
    systemsByName?: Map<string, unknown>;
    pgPool?: { totalCount?: number; idleCount?: number; waitingCount?: number };
  };
  const busListenerMap = worldRecord.__busListenerMap;
  if (busListenerMap instanceof Map) {
    let totalBusListeners = 0;
    for (const listenersForEvent of busListenerMap.values()) {
      if (listenersForEvent instanceof Map) {
        totalBusListeners += listenersForEvent.size;
      }
    }
    metrics.push({
      path: "world.__busListenerMap.totalListeners",
      kind: "map",
      size: totalBusListeners,
    });
  }
  const systemsByName = worldRecord.systemsByName;
  if (systemsByName instanceof Map) {
    for (const [systemName, systemValue] of systemsByName) {
      collectCollectionMetrics(
        `system:${String(systemName)}`,
        systemValue,
        metrics,
      );
    }
  }
  const pgPool = worldRecord.pgPool;
  if (pgPool && typeof pgPool === "object") {
    const totalCount =
      typeof pgPool.totalCount === "number" ? pgPool.totalCount : 0;
    const idleCount =
      typeof pgPool.idleCount === "number" ? pgPool.idleCount : 0;
    const waitingCount =
      typeof pgPool.waitingCount === "number" ? pgPool.waitingCount : 0;
    metrics.push({
      path: "world.pgPool.totalCount",
      kind: "object",
      size: totalCount,
    });
    metrics.push({
      path: "world.pgPool.idleCount",
      kind: "object",
      size: idleCount,
    });
    metrics.push({
      path: "world.pgPool.waitingCount",
      kind: "object",
      size: waitingCount,
    });
  }

  const filtered = metrics
    .filter((item) => item.size > 0)
    .sort((left, right) => right.size - left.size)
    .slice(0, limit);
  if (filtered.length === 0) return "";
  return filtered
    .map((item) => `${item.path}(${item.kind})=${item.size}`)
    .join(" | ");
}

function startMemoryMonitor(world: unknown): void {
  const isPlaywrightTest = process.env.PLAYWRIGHT_TEST === "true";
  const INTERVAL_MS = isPlaywrightTest ? 5_000 : 30_000;
  const MB = 1024 * 1024;
  const forceGcInPlaywright =
    isPlaywrightTest &&
    (process.env.PLAYWRIGHT_FORCE_GC || "true").toLowerCase() !== "false";
  const collectionDebugEnabled = process.env.MEMORY_COLLECTION_DEBUG === "true";
  const collectionLimit = Math.max(
    8,
    parseInt(process.env.MEMORY_COLLECTION_LIMIT || "12", 10) || 12,
  );
  const memLimitGB = Number(process.env.MEMORY_LIMIT_GB) || 12;
  const memoryStdioEnabled =
    process.env.MEMORY_MONITOR_STDIO === "true" ||
    (isPlaywrightTest && process.env.MEMORY_MONITOR_STDIO !== "false") ||
    collectionDebugEnabled;

  // Start the memory monitoring infrastructure (provides trend analysis, leak detection, API)
  const monitorConfig: MemoryMonitorConfig = {
    sampleIntervalMs: INTERVAL_MS,
    memoryLimitGB: memLimitGB,
    verbose: collectionDebugEnabled,
    // Collection cardinality is sampled only once per monitor interval and is
    // required for production soak evidence even when verbose logging is off.
    trackCollections: true,
  };
  startMemoryMonitorInfra(world as World, monitorConfig);

  // Production GC hint: periodically nudge the runtime to collect garbage.
  // Runs every 60s regardless of the memory monitor interval.
  const GC_HINT_INTERVAL_MS = 60_000;
  let lastGcHintAt = 0;
  // Track whether we already warned at the soft threshold to avoid log spam
  let softWarningLogged = false;

  const bunGcHint = (): void => {
    // Disabled: Even Bun.gc(false) can block the event loop for 1-2 seconds
    // on heaps >2GB, causing missed game ticks. Let the runtime GC naturally.
  };

  const timer = setInterval(() => {
    const now = Date.now();

    // GC hint: in Playwright tests, every interval; in production, every 60s
    if (forceGcInPlaywright) {
      bunGcHint();
    } else if (now - lastGcHintAt >= GC_HINT_INTERVAL_MS) {
      bunGcHint();
      lastGcHintAt = now;
    }

    const mem = process.memoryUsage();
    const rssMB = (mem.rss / MB).toFixed(1);
    const heapUsedMB = (mem.heapUsed / MB).toFixed(1);
    const heapTotalMB = (mem.heapTotal / MB).toFixed(1);
    const externalMB = (mem.external / MB).toFixed(1);
    if (memoryStdioEnabled) {
      // Use stderr so output is visible even when stdout is piped through duel-stack
      process.stderr.write(
        `[Memory] RSS=${rssMB}MB  HeapUsed=${heapUsedMB}MB  HeapTotal=${heapTotalMB}MB  External=${externalMB}MB\n`,
      );
      if (collectionDebugEnabled) {
        const summary = buildCollectionSummary(world, collectionLimit);
        if (summary) {
          process.stderr.write(`[MemoryCollections] ${summary}\n`);
        }
        const networkSummary = buildNetworkDebugSummary(world);
        if (networkSummary) {
          process.stderr.write(`[MemoryNetwork] ${networkSummary}\n`);
        }
      }
    }

    // Soft warning at 80% of limit — trigger GC and log a warning
    const softLimitBytes = memLimitGB * 1024 * MB * 0.8;
    if (!isPlaywrightTest && mem.rss > softLimitBytes) {
      if (!softWarningLogged) {
        process.stderr.write(
          `[Memory] ⚠️ RSS ${rssMB}MB > 80% of ${memLimitGB}GB limit, triggering GC\n`,
        );
        softWarningLogged = true;
      }
      bunGcHint();
    } else {
      softWarningLogged = false;
    }

    // Hard limit: restart process
    if (!isPlaywrightTest && mem.rss > memLimitGB * 1024 * MB) {
      process.stderr.write(
        `[Memory] RSS ${rssMB}MB > ${memLimitGB}GB, restarting\n`,
      );
      process.exit(1);
    }
  }, INTERVAL_MS);

  timer.unref?.();
}

// Start the server with error handling
startServer().catch((err) => {
  console.error("=".repeat(60));
  console.error("❌ FATAL ERROR DURING STARTUP");
  console.error("=".repeat(60));
  console.error(err);
  console.error("=".repeat(60));

  // Clear the flag so hot reload can retry
  const globalWithFlag = globalThis as typeof globalThis & {
    __HYPERIA_SERVER_STARTING__?: boolean;
  };
  globalWithFlag.__HYPERIA_SERVER_STARTING__ = false;

  process.exit(1);
});
