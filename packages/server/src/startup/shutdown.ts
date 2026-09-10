/**
 * Shutdown Module - Graceful server cleanup
 *
 * Handles graceful shutdown of all server resources in the correct order
 * to prevent data loss and ensure clean termination.
 *
 * Shutdown sequence:
 * 1. Close HTTP server (stop accepting new connections)
 * 2. Shutdown embedded agents
 * 3. Force-save all player data (health, position, inventory, equipment, coins)
 * 4. Wait for pending database operations
 * 5. Destroy world and all systems
 * 6. Close database connections
 * 7. Stop Docker containers (if started)
 * 8. Clear startup flag (for hot reload)
 * 9. Exit process (unless hot reload)
 *
 * Handles signals:
 * - SIGINT (Ctrl+C) - User termination
 * - SIGTERM (Docker stop, systemd) - Graceful shutdown
 * - SIGUSR2 (Hot reload) - Dev mode restart
 * - uncaughtException - Crash handling
 * - unhandledRejection - Promise error handling
 *
 * Usage:
 * ```typescript
 * registerShutdownHandlers(fastify, world, dbContext);
 * ```
 */

import type { FastifyInstance } from "fastify";
import type { World } from "@hyperforge/shared";
import { DatabaseSystem } from "../systems/DatabaseSystem/index.js";
import type { DatabaseContext } from "./database.js";
import { closeDatabase } from "./database.js";
import { getAgentManager } from "../eliza/index.js";
import { stopAllModelAgents } from "../eliza/ModelAgentSpawner.js";
import { getStreamCapture } from "../streaming/stream-capture.js";
import { errMsg } from "../shared/errMsg.js";
import { destroyStreamingDuelAuthority } from "../systems/StreamingDuelScheduler/authority.js";
import { destroyAllRateLimiters } from "../systems/ServerNetwork/services/SlidingWindowRateLimiter.js";
import { destroyIdempotencyService } from "../systems/ServerNetwork/services/IdempotencyService.js";
import { stopMemoryMonitor } from "../infrastructure/memory-monitor.js";
import { getDuelArenaOraclePublisher } from "../oracle/DuelArenaOraclePublisher.js";
import { getStreamingDuelScheduler } from "../systems/StreamingDuelScheduler/index.js";
import type { StreamingRoutesRuntime } from "../routes/streaming.js";
import {
  resolveStreamingDuelShutdownAckConfig,
  waitForStreamingDuelShutdownAcknowledgement,
} from "./streaming-shutdown-contract.js";

/**
 * Web3 context for chain writer shutdown
 */
interface Web3Context {
  shutdown: () => Promise<void>;
}

/**
 * Shutdown context for cleanup
 */
interface ShutdownContext {
  fastify: FastifyInstance;
  world: World;
  dbContext: DatabaseContext;
  web3Context: Web3Context | null;
}

const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
const alertTimeoutMs = 2000;
let alertSent = false;
let lastFatalDetails: Record<string, string> | null = null;

async function sendAlert(
  message: string,
  details: Record<string, string>,
): Promise<void> {
  if (!alertWebhookUrl || alertSent) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), alertTimeoutMs);
  try {
    await fetch(alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: message,
        details,
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error("[Shutdown] Failed to send alert webhook:", errMsg(err));
  } finally {
    clearTimeout(timeout);
    alertSent = true;
  }
}

/**
 * Register all shutdown handlers
 *
 * Sets up signal handlers for SIGINT, SIGTERM, SIGUSR2 and error handlers
 * for uncaughtException and unhandledRejection.
 *
 * @param fastify - Fastify server instance
 * @param world - Game world instance
 * @param dbContext - Database context with connections and Docker manager
 * @param web3Context - Optional Web3 context for chain writer shutdown
 */
export function registerShutdownHandlers(
  fastify: FastifyInstance,
  world: World,
  dbContext: DatabaseContext,
  web3Context: Web3Context | null = null,
  streamingRoutes: StreamingRoutesRuntime | null = null,
): void {
  const dbWriteErrorsNonFatal = /^(1|true|yes|on)$/i.test(
    process.env.DB_WRITE_ERRORS_NON_FATAL || "",
  );

  /**
   * Unhandled rejections are often recoverable (one bad request / plugin / race).
   * In production, default is to log + alert and keep serving so a stray Promise
   * does not take down 24/7 uptime. Set SERVER_EXIT_ON_UNHANDLED_REJECTION=true
   * to restore process exit (e.g. strict staging). In development, default remains
   * exit unless SERVER_SURVIVE_UNHANDLED_REJECTION=1 for local testing.
   */
  const forceExitOnUnhandledRejection =
    process.env.SERVER_EXIT_ON_UNHANDLED_REJECTION === "true";
  const surviveUnhandledRejection =
    !forceExitOnUnhandledRejection &&
    (process.env.NODE_ENV === "production" ||
      /^(1|true|yes|on)$/i.test(
        process.env.SERVER_SURVIVE_UNHANDLED_REJECTION || "",
      ));

  if (surviveUnhandledRejection) {
    console.log(
      "[Shutdown] Policy: unhandled promise rejections are logged; process stays up. " +
        "Set SERVER_EXIT_ON_UNHANDLED_REJECTION=true to exit on rejection.",
    );
  }

  const context: ShutdownContext = { fastify, world, dbContext, web3Context };
  // Resolve at startup so an unsafe or malformed acknowledgement target can
  // never remain latent until the process is already trying to terminate.
  const streamingShutdownAckConfig = resolveStreamingDuelShutdownAckConfig(
    process.env,
  );

  // Track if we're shutting down (prevent duplicate shutdowns)
  let isShuttingDown = false;

  /**
   * Graceful shutdown handler
   *
   * Performs cleanup in the correct order to prevent data loss.
   * Handles hot reload (SIGUSR2) differently from termination signals.
   *
   * @param signal - Signal that triggered shutdown
   */
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    if (signal !== "SIGUSR2") {
      const details: Record<string, string> = {
        signal,
        nodeEnv: process.env.NODE_ENV || "development",
      };
      if (lastFatalDetails) {
        for (const [key, value] of Object.entries(lastFatalDetails)) {
          details[key] = value;
        }
      }
      await sendAlert("Hyperia server shutting down", details);
    }

    // Step 1: Close game WebSocket ingress. Keep Fastify and its authenticated
    // betting feed alive until the exact terminal cancellation is delivered.
    try {
      const { closeUwsServer } = await import("./uws-server.js");
      closeUwsServer();
    } catch {
      // uWS may not have been started (UWS_ENABLED=false)
    }

    // Step 2: Stop the scheduler while the world, database, HTTP server, and
    // authenticated betting SSE clients are still alive. A nonterminal cycle
    // must persist and publish its exact cancellation before any feed teardown.
    const cycleAtShutdown =
      getStreamingDuelScheduler()?.getCurrentCycle() ?? null;
    const expectsCancellation = Boolean(
      cycleAtShutdown && cycleAtShutdown.phase !== "RESOLUTION",
    );
    let streamingShutdownExitCode = 0;
    try {
      await destroyStreamingDuelAuthority();
      let terminalFrame: Awaited<
        ReturnType<StreamingRoutesRuntime["waitForBettingTerminalFrame"]>
      > | null = null;
      let downstreamAcknowledged = false;
      if (expectsCancellation && cycleAtShutdown?.duelId) {
        if (!streamingRoutes) {
          throw new Error(
            "streaming route runtime is unavailable during active-duel shutdown",
          );
        }
        terminalFrame = await streamingRoutes.waitForBettingTerminalFrame({
          duelId: cycleAtShutdown.duelId,
          cancellationReason: "scheduler_shutdown",
          timeoutMs: 5_000,
        });
        downstreamAcknowledged =
          await waitForStreamingDuelShutdownAcknowledgement({
            config: streamingShutdownAckConfig,
            duelId: terminalFrame.duelId,
          });
      }
      process.stdout.write(
        `${JSON.stringify({
          event: "shutdown-complete",
          sourceEpoch: terminalFrame?.sourceEpoch ?? null,
          terminalFrameSeq: terminalFrame?.terminalFrameSeq ?? null,
          duelId: terminalFrame?.duelId ?? null,
          duelKeyHex: terminalFrame?.duelKeyHex ?? null,
          competitiveSnapshotDigest:
            terminalFrame?.competitiveSnapshotDigest ?? null,
          outcome: terminalFrame?.outcome ?? null,
          cancellationReason: terminalFrame?.cancellationReason ?? null,
          downstreamAcknowledged,
        })}\n`,
      );
    } catch (err) {
      streamingShutdownExitCode = 1;
      console.error(
        `${JSON.stringify({
          event: "shutdown-failed",
          signal,
          reason: errMsg(err),
        })}`,
      );
    }

    // Step 3: Stop stream capture only after the terminal market frame has been
    // acknowledged. This preserves visual/feed continuity through cancellation.
    try {
      const capture = getStreamCapture();
      if (capture.isRunning()) {
        await capture.stop();
      }
    } catch {
      // Stream capture may not have been initialized
    }

    // Step 4: Close HTTP only after the terminal betting barrier is complete.
    await closeHttpServer(context);

    // Step 5: Shutdown embedded agents after duel cleanup has settled.
    await shutdownAgents();

    // Step 5a: Flush agent thoughts to database
    try {
      const { flushAgentThoughtsToDb } =
        await import("../eliza/dashboardInterop.js");
      await flushAgentThoughtsToDb();
    } catch {
      // Thoughts module may not have been loaded
    }

    // Step 5b: Shutdown Web3 chain writer (flush pending writes)
    await shutdownWeb3(context);

    // Step 5c: Shutdown DuelArenaOraclePublisher
    try {
      const oraclePublisher = getDuelArenaOraclePublisher(context.world);
      if (oraclePublisher) {
        oraclePublisher.destroy();
      }
    } catch (err) {
      console.error(
        "[Shutdown] Failed to destroy DuelArenaOraclePublisher:",
        err,
      );
    }

    // Step 5: Force-save all remaining player data (health, position,
    // inventory, equipment, coins)
    // Must happen BEFORE waitForDatabaseOperations() which sets isDestroying=true,
    // and BEFORE world.destroy() which calls system.destroy() fire-and-forget.
    await forcePlayerDataSave(context);

    // Step 6: Wait for pending database operations
    await waitForDatabaseOperations(context);

    // Step 6.5: Cleanup global singletons with timers (prevents memory leaks)
    await cleanupGlobalServices();

    // Step 7: Destroy world and systems
    await destroyWorld(context);

    // Step 8: Close database connections
    await closeDatabaseConnections(context);

    // Step 9: Stop Docker containers
    await stopDocker(context);

    // Step 10: Stop memory monitor
    try {
      stopMemoryMonitor();
    } catch {
      // Memory monitor may not have been started
    }

    // Step 11: Clear startup flag
    clearStartupFlag();

    // For hot reload (SIGUSR2), don't exit process
    if (signal === "SIGUSR2") {
      isShuttingDown = false; // Reset so next reload can proceed
      return;
    }

    // For termination signals, exit after short delay
    setTimeout(() => {
      process.exit(streamingShutdownExitCode);
    }, 100);
  };

  // Register signal handlers
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGUSR2", () => gracefulShutdown("SIGUSR2")); // Hot reload signal

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    const errorStack = error instanceof Error ? (error.stack ?? "") : "";
    const isNonFatalDbTransportError =
      dbWriteErrorsNonFatal &&
      (errorMessage.includes("Connection terminated unexpectedly") ||
        errorMessage.includes("Connection terminated") ||
        errorMessage.includes("ECONNRESET") ||
        errorMessage.includes("socket hang up"));
    const isNonFatalNodeNetTimeoutBug =
      dbWriteErrorsNonFatal &&
      (errorMessage.includes("null is not an object (evaluating 'context')") ||
        errorMessage.includes("Cannot read properties of null")) &&
      (errorStack.includes("internalConnectMultipleTimeout") ||
        errorStack.includes("node:net"));
    if (isNonFatalDbTransportError || isNonFatalNodeNetTimeoutBug) {
      console.warn(
        "[Shutdown] Non-fatal transport exception suppressed:",
        isNonFatalNodeNetTimeoutBug
          ? `${errorMessage} (internalConnectMultipleTimeout)`
          : errorMessage,
      );
      return;
    }
    console.error("[Shutdown] Uncaught exception:", error);
    lastFatalDetails = {
      error: errorMessage,
    };
    void gracefulShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason, promise) => {
    const reasonStr = reason instanceof Error ? reason.message : String(reason);

    // Non-fatal agent/plugin errors that should not crash the server
    const isNonFatalAgentError =
      reasonStr.includes("registration timed out") ||
      reasonStr.includes("initialization aborted") ||
      reasonStr.includes("shutdown in progress") ||
      reasonStr.includes("failed to register") ||
      reasonStr.includes("runtime initialization") ||
      reasonStr.includes("Database is shutting down");

    if (isShuttingDown) {
      if (isNonFatalAgentError) {
        return;
      }
      console.error(
        "[Shutdown] Already shutting down, ignoring unhandledRejection",
      );
      return;
    }

    if (isNonFatalAgentError) {
      console.warn(
        "[Shutdown] Non-fatal agent/plugin error (server continues):",
        reasonStr.substring(0, 200),
      );
      return;
    }

    const reasonStack =
      reason instanceof Error ? (reason.stack ?? reasonStr) : reasonStr;
    console.error(
      "[Shutdown] Unhandled rejection at:",
      promise,
      "reason:",
      reason,
    );

    if (surviveUnhandledRejection) {
      lastFatalDetails = {
        reason: reasonStr,
        stack: reasonStack.slice(0, 4000),
      };
      // Do not call sendAlert here: it shares alertSent with shutdown and would
      // block the real "server shutting down" webhook. Use log aggregation instead.
      return;
    }

    lastFatalDetails = {
      reason: reasonStr,
    };
    void gracefulShutdown("unhandledRejection");
  });
}

/**
 * Shutdown embedded agents
 *
 * Gracefully stops all embedded agents and removes their player entities.
 *
 * @private
 */
async function shutdownAgents(): Promise<void> {
  try {
    const agentManager = getAgentManager();
    if (agentManager) {
      await agentManager.shutdown();
    }
  } catch (err) {
    console.error("[Shutdown] Error shutting down agents:", err);
  }

  // Stop model agents (ElizaOS LLM agents managed by ModelAgentSpawner).
  // This clears behaviorIntervals, agentPlans, and stops all runtimes.
  try {
    await stopAllModelAgents();
  } catch (err) {
    console.error("[Shutdown] Error stopping model agents:", err);
  }
}

/**
 * Shutdown Web3 chain writer
 *
 * Flushes any pending on-chain writes before shutdown.
 *
 * @param context - Shutdown context
 * @private
 */
async function shutdownWeb3(context: ShutdownContext): Promise<void> {
  if (!context.web3Context) {
    return;
  }

  try {
    await context.web3Context.shutdown();
  } catch (err) {
    console.error("[Shutdown] Error shutting down Web3:", err);
  }
}

/**
 * Force-save all player data before shutdown
 *
 * Directly awaits the player snapshot plus destroyAsync() on inventory,
 * equipment, and coin pouch systems. This ensures all player data is persisted
 * BEFORE the database system marks itself as destroying (which rejects new
 * operations).
 *
 * After this runs, the systems' data maps are cleared, so when world.destroy()
 * later calls their destroy() → destroyAsync() again, the saves are no-ops.
 *
 * @param context - Shutdown context
 * @private
 */
export async function forcePlayerDataSave(
  context: Pick<ShutdownContext, "world">,
): Promise<void> {
  try {
    const savePromises: Promise<void>[] = [];

    // Get each critical system and call destroyAsync() directly
    const playerSystem = context.world.getSystem("player") as
      { saveAllPlayersToDatabase(): Promise<void> } | undefined;
    if (playerSystem?.saveAllPlayersToDatabase) {
      savePromises.push(
        playerSystem.saveAllPlayersToDatabase().catch((err) => {
          console.error("[Shutdown] Player state save error:", err);
        }),
      );
    }

    const inventorySystem = context.world.getSystem("inventory") as
      { destroyAsync(): Promise<void> } | undefined;
    if (inventorySystem?.destroyAsync) {
      savePromises.push(
        inventorySystem.destroyAsync().catch((err) => {
          console.error("[Shutdown] Inventory save error:", err);
        }),
      );
    }

    const equipmentSystem = context.world.getSystem("equipment") as
      { destroyAsync(): Promise<void> } | undefined;
    if (equipmentSystem?.destroyAsync) {
      savePromises.push(
        equipmentSystem.destroyAsync().catch((err) => {
          console.error("[Shutdown] Equipment save error:", err);
        }),
      );
    }

    const coinPouchSystem = context.world.getSystem("coin-pouch") as
      { destroyAsync(): Promise<void> } | undefined;
    if (coinPouchSystem?.destroyAsync) {
      savePromises.push(
        coinPouchSystem.destroyAsync().catch((err) => {
          console.error("[Shutdown] Coin pouch save error:", err);
        }),
      );
    }

    await Promise.all(savePromises);
  } catch (err) {
    console.error("[Shutdown] Error force-saving player data:", err);
  }
}

/**
 * Close HTTP server
 *
 * Stops accepting new connections and waits for existing requests to complete.
 *
 * @param context - Shutdown context
 * @private
 */
async function closeHttpServer(context: ShutdownContext): Promise<void> {
  try {
    await context.fastify.close();
  } catch (err) {
    console.error("[Shutdown] Error closing HTTP server:", err);
  }
}

/**
 * Wait for pending database operations
 *
 * Ensures all fire-and-forget database operations complete before shutdown.
 * Critical for preventing data loss.
 *
 * @param context - Shutdown context
 * @private
 */
async function waitForDatabaseOperations(
  context: ShutdownContext,
): Promise<void> {
  try {
    const databaseSystem = context.world.getSystem("database") as
      DatabaseSystem | undefined;

    if (databaseSystem) {
      await databaseSystem.waitForPendingOperations();
    }
  } catch (err) {
    console.error(
      "[Shutdown] Error waiting for pending database operations:",
      err,
    );
  }
}

/**
 * Cleanup global singleton services with cleanup timers
 *
 * Destroys rate limiters and idempotency service to prevent memory leaks.
 * These services use setInterval for cleanup, which must be stopped.
 *
 * @private
 */
async function cleanupGlobalServices(): Promise<void> {
  try {
    // Destroy all rate limiters (clears cleanup intervals and player entries)
    destroyAllRateLimiters();

    // Destroy idempotency service (clears cleanup interval and request hashes)
    destroyIdempotencyService();
  } catch (err) {
    console.error("[Shutdown] Error cleaning up global services:", err);
  }
}

/**
 * Destroy world and all systems
 *
 * Cleanly shuts down the ECS world and all registered systems.
 *
 * @param context - Shutdown context
 * @private
 */
async function destroyWorld(context: ShutdownContext): Promise<void> {
  try {
    context.world.destroy();
  } catch (err) {
    console.error("[Shutdown] Error destroying world:", err);
  }
}

/**
 * Close database connections
 *
 * Closes PostgreSQL connection pool and clears singleton instances.
 *
 * @param context - Shutdown context
 * @private
 */
async function closeDatabaseConnections(
  _context: ShutdownContext,
): Promise<void> {
  try {
    await closeDatabase();
  } catch (err) {
    console.error("[Shutdown] Error closing database:", err);
  }
}

/**
 * Stop Docker containers
 *
 * Stops PostgreSQL container if it was started by this server instance.
 *
 * @param context - Shutdown context
 * @private
 */
async function stopDocker(context: ShutdownContext): Promise<void> {
  try {
    if (context.dbContext.dockerManager) {
      await context.dbContext.dockerManager.stopPostgres();
    }
  } catch (err) {
    console.error("[Shutdown] Error stopping Docker:", err);
  }
}

/**
 * Clear startup flag
 *
 * Clears the global startup flag to allow hot reload to proceed.
 *
 * @private
 */
function clearStartupFlag(): void {
  const globalWithFlag = globalThis as typeof globalThis & {
    __HYPERIA_SERVER_STARTING__?: boolean;
  };
  globalWithFlag.__HYPERIA_SERVER_STARTING__ = false;
}
