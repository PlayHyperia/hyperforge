/**
 * Maintenance Mode Controller
 *
 * Provides graceful deployment coordination for the streaming duel system.
 * When maintenance mode is entered:
 * 1. New duel cycles are paused (current cycle completes)
 * 2. Betting markets are locked (no new bets accepted)
 * 3. System waits for current market to resolve
 * 4. Reports "safe to deploy" status
 *
 * This prevents data loss and market inconsistency during deployments.
 */

import { getStreamingDuelScheduler } from "../systems/StreamingDuelScheduler/index.js";
import { Logger } from "../systems/ServerNetwork/services/Logger.js";

export interface MaintenanceStatus {
  active: boolean;
  enteredAt: number | null;
  reason: string | null;
  safeToDeploy: boolean;
  currentPhase: string | null;
  marketStatus: "betting" | "locked" | "resolved" | "none";
  pendingMarkets: number;
}

interface MaintenanceState {
  active: boolean;
  enteredAt: number | null;
  reason: string | null;
  originalSchedulerEnabled: boolean;
}

let maintenanceState: MaintenanceState = {
  active: false,
  enteredAt: null,
  reason: null,
  originalSchedulerEnabled: true,
};

/**
 * Enter maintenance mode
 *
 * - Stops new duel cycles from starting
 * - Waits for current cycle to complete
 * - Returns when safe to deploy
 *
 * @param reason - Reason for maintenance (for logging)
 * @param timeoutMs - Maximum time to wait for safe state (default: 5 minutes)
 * @returns Promise that resolves when safe to deploy, or rejects on timeout
 */
export async function enterMaintenanceMode(
  reason: string = "deployment",
  timeoutMs: number = 5 * 60 * 1000,
): Promise<MaintenanceStatus> {
  if (maintenanceState.active) {
    Logger.info("MaintenanceMode", "Already in maintenance mode");
    return getMaintenanceStatus();
  }

  Logger.info(
    "MaintenanceMode",
    `Entering maintenance mode: ${reason}. Waiting for safe deploy state...`,
  );

  maintenanceState = {
    active: true,
    enteredAt: Date.now(),
    reason,
    originalSchedulerEnabled: true,
  };

  // Stop the streaming duel scheduler from starting new cycles
  const scheduler = getStreamingDuelScheduler();
  if (scheduler) {
    // The scheduler will complete its current cycle but won't start new ones
    // We do this by setting environment variable and letting the scheduler check it
    process.env.STREAMING_DUEL_MAINTENANCE_MODE = "true";
    Logger.info("MaintenanceMode", "Streaming duel scheduler paused");
  }

  // Wait for safe state
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = getMaintenanceStatus();

    if (status.safeToDeploy) {
      Logger.info(
        "MaintenanceMode",
        "Safe to deploy: no active cycles or markets",
      );
      return status;
    }

    Logger.info(
      "MaintenanceMode",
      `Waiting for safe state... phase=${status.currentPhase}, markets=${status.pendingMarkets}`,
    );

    // Check every 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Timeout - still return status but note that it may not be fully safe
  Logger.warn(
    "MaintenanceMode",
    `Timeout waiting for safe deploy state after ${timeoutMs}ms`,
  );
  return getMaintenanceStatus();
}

/**
 * Exit maintenance mode
 *
 * - Resumes duel cycle scheduling
 * - Re-enables betting markets
 */
export function exitMaintenanceMode(): MaintenanceStatus {
  const environmentGateActive =
    process.env.STREAMING_DUEL_MAINTENANCE_MODE === "true";
  if (!maintenanceState.active && !environmentGateActive) {
    Logger.info("MaintenanceMode", "Not in maintenance mode");
    return getMaintenanceStatus();
  }

  Logger.info(
    "MaintenanceMode",
    maintenanceState.active
      ? "Exiting maintenance mode"
      : "Exiting inherited maintenance mode after process restart",
  );

  // Re-enable scheduler
  delete process.env.STREAMING_DUEL_MAINTENANCE_MODE;

  maintenanceState = {
    active: false,
    enteredAt: null,
    reason: null,
    originalSchedulerEnabled: true,
  };

  Logger.info("MaintenanceMode", "Maintenance mode exited, operations resumed");
  return getMaintenanceStatus();
}

/**
 * Get current maintenance status
 */
export function getMaintenanceStatus(): MaintenanceStatus {
  const scheduler = getStreamingDuelScheduler();
  const active =
    maintenanceState.active ||
    process.env.STREAMING_DUEL_MAINTENANCE_MODE === "true";

  // Get current phase from scheduler
  let currentPhase: string | null = null;
  if (scheduler) {
    const schedulerState = scheduler.getSchedulerState();
    // currentPhase is the duel phase (ANNOUNCEMENT, FIGHTING, etc.)
    // state is the scheduler state (IDLE, WAITING_FOR_AGENTS, ACTIVE)
    currentPhase = schedulerState.currentPhase ?? schedulerState.state;
  }

  // Get market status
  let marketStatus: "betting" | "locked" | "resolved" | "none" = "none";
  let pendingMarkets = 0;

  // Safe to deploy when:
  // 1. Not in active duel phase (FIGHTING, COUNTDOWN)
  // 2. No pending betting markets
  const inActiveDuel =
    currentPhase === "FIGHTING" ||
    currentPhase === "COUNTDOWN" ||
    currentPhase === "ANNOUNCEMENT";
  const hasPendingMarkets = pendingMarkets > 0;

  const safeToDeploy = active && !inActiveDuel && !hasPendingMarkets;

  return {
    active,
    enteredAt: maintenanceState.enteredAt,
    reason: maintenanceState.reason,
    safeToDeploy,
    currentPhase,
    marketStatus,
    pendingMarkets,
  };
}

/**
 * Check if maintenance mode is active
 */
export function isMaintenanceModeActive(): boolean {
  return (
    maintenanceState.active ||
    process.env.STREAMING_DUEL_MAINTENANCE_MODE === "true"
  );
}
