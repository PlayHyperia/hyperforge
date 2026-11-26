/**
 * Tick System
 *
 * Implements classic fantasy MMORPG-style server tick system.
 * All game logic runs on 600ms ticks, ensuring:
 * - Consistent timing for all players
 * - Predictable movement (1-2 tiles per tick)
 * - Fair combat calculations
 * - Synchronized world state
 *
 * The tick system processes events in a specific order:
 * 1. Player inputs (queued since last tick)
 * 2. Movement (advance entities along paths)
 * 3. Combat (attack calculations)
 * 4. Other game logic (resources, NPCs)
 * 5. State broadcast to clients
 */

import {
  DurationHistogram,
  type DurationPercentiles,
  TICK_DURATION_MS,
  updateCachedTimestamp,
} from "@hyperforge/shared";

/**
 * Tick callback priority levels
 * Lower numbers run first
 */
export enum TickPriority {
  INPUT = 0, // Process player inputs first
  MOVEMENT = 1, // Then movement
  COMBAT = 2, // Then combat
  AI = 3, // Then NPC AI
  RESOURCES = 4, // Then resource respawns
  BROADCAST = 10, // Broadcast state last
}

/**
 * Registered tick listener
 */
interface TickListener {
  callback: (tickNumber: number, deltaMs: number) => void;
  priority: TickPriority;
  name: string;
}

export type { DurationPercentiles } from "@hyperforge/shared";

/**
 * Server tick system for classic fantasy MMORPG-style game loop
 *
 * Uses self-correcting setTimeout instead of setInterval to prevent drift.
 * setInterval can accumulate timing errors over time, especially under load.
 * This implementation tracks the ideal next tick time and adjusts delays
 * to maintain accurate long-term tick timing.
 */
export class TickSystem {
  private tickNumber = 0;
  private lastTickTime = 0;
  private nextTickTime = 0; // Ideal time for next tick (drift correction)
  private tickTimeout: ReturnType<typeof setTimeout> | null = null;
  private listeners: TickListener[] = [];
  private isRunning = false;
  /**
   * When true, skip missed ticks and reset schedule when falling behind (>1 tick).
   * This is the correct classic fantasy MMORPG behavior: ticks stretch under load, they don't
   * replay in a burst. Actions stay responsive on the next clean tick.
   * Set TICK_ALLOW_SKIP=false to disable (useful for diagnosing desync).
   */
  private readonly allowTickSkipping =
    String(process.env.TICK_ALLOW_SKIP ?? "true").toLowerCase() !== "false";

  // ============================================================================
  // PRE-ALLOCATED BUFFERS (Zero-allocation hot path support)
  // ============================================================================

  /** Cached sorted listeners array - only rebuilt when listeners change */
  private sortedListeners: TickListener[] = [];
  /** Flag indicating listeners have changed and need re-sorting */
  private listenersDirty = true;

  /** Warning threshold for slow handlers (ms) */
  private static readonly SLOW_HANDLER_THRESHOLD_MS = 100;
  /** Cooldown between repeated warning logs (ms) */
  private static readonly WARNING_LOG_COOLDOWN_MS = 5000;

  /** Handler timing stats for debugging */
  private handlerTimings: Map<number, number[]> = new Map();

  /** Track total tick processing time */
  private lastTickDuration = 0;

  /** Full-window tick latency distributions for launch/soak verification. */
  private readonly tickDurationHistogram = new DurationHistogram();
  private readonly tickLatenessHistogram = new DurationHistogram();
  private readonly handlerDurationHistograms = new Map<
    string,
    DurationHistogram
  >();

  // ============================================================================
  // MISSED TICK TRACKING
  // ============================================================================

  /** Total number of ticks that were skipped due to falling behind */
  private missedTickCount = 0;

  /** Total number of late ticks (>50% of tick duration) */
  private lateTickCount = 0;

  /** Maximum lateness observed (ms) */
  private maxTickLateness = 0;

  /** Tick number of last schedule reset */
  private lastScheduleReset = 0;
  /** Cooldown windows to avoid warning log storms under load */
  private nextScheduleResetLogAt = 0;
  private nextSlowHandlerLogAt = 0;
  private nextOverBudgetLogAt = 0;
  /** Suppressed warning counters (emitted on next allowed log) */
  private suppressedScheduleResetWarnings = 0;
  private suppressedSlowHandlerWarnings = 0;
  private suppressedOverBudgetWarnings = 0;

  /**
   * Start the tick loop
   */
  start(): void {
    if (this.isRunning) {
      console.warn("[TickSystem] Already running");
      return;
    }

    this.isRunning = true;
    const now = Date.now();
    this.lastTickTime = now;
    this.nextTickTime = now + TICK_DURATION_MS;

    console.log(
      `[TickSystem] Starting tick loop (${TICK_DURATION_MS}ms per tick, drift-corrected, skip=${this.allowTickSkipping ? "on" : "off"})`,
    );

    // Schedule first tick
    this.scheduleNextTick();
  }

  /**
   * Schedule the next tick with drift correction
   *
   * Instead of fixed intervals, we calculate delay based on when the tick
   * SHOULD fire vs current time. This compensates for:
   * - setTimeout/setInterval inaccuracy
   * - Long-running tick handlers
   * - System load causing delays
   */
  private scheduleNextTick(): void {
    if (!this.isRunning) return;

    const now = Date.now();
    // Calculate delay to hit the ideal next tick time
    // If we're behind, this will be small (or even negative → immediate)
    // If we're somehow ahead, this ensures we don't fire too early
    const delay = Math.max(1, this.nextTickTime - now);

    this.tickTimeout = setTimeout(() => {
      this.processTick();
      this.scheduleNextTick();
    }, delay);
  }

  /**
   * Stop the tick loop
   */
  stop(): void {
    if (this.tickTimeout) {
      clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }
    this.isRunning = false;
    console.log("[TickSystem] Stopped");
  }

  /**
   * Process a single tick
   */
  private processTick(): void {
    // Update cached timestamp once per tick for use throughout tick processing
    // This avoids Date.now() calls in hot paths
    updateCachedTimestamp();

    const now = Date.now();
    const deltaMs = now - this.lastTickTime;
    this.lastTickTime = now;
    this.tickNumber++;

    // Advance ideal next tick time (maintains long-term accuracy)
    // Even if this tick was late, the next tick target stays on schedule
    this.nextTickTime += TICK_DURATION_MS;

    // Track lateness
    const lateness = now - (this.nextTickTime - TICK_DURATION_MS);
    if (lateness > this.maxTickLateness) {
      this.maxTickLateness = lateness;
    }
    this.tickLatenessHistogram.record(lateness);

    // Count late ticks (>50% of tick duration)
    if (lateness > TICK_DURATION_MS * 0.5) {
      this.lateTickCount++;
    }

    // If we've fallen very far behind (>2 ticks), reset to prevent catch-up storm
    if (this.allowTickSkipping && now > this.nextTickTime + TICK_DURATION_MS) {
      // Calculate how many ticks we're skipping
      const ticksBehind = Math.floor(
        (now - this.nextTickTime) / TICK_DURATION_MS,
      );
      this.missedTickCount += ticksBehind;
      this.lastScheduleReset = this.tickNumber;
      if (now >= this.nextScheduleResetLogAt) {
        const suppressed = this.suppressedScheduleResetWarnings;
        this.suppressedScheduleResetWarnings = 0;
        this.nextScheduleResetLogAt = now + TickSystem.WARNING_LOG_COOLDOWN_MS;
        const suffix =
          suppressed > 0 ? ` (suppressed ${suppressed} similar warnings)` : "";
        console.warn(
          `[TickSystem] Tick ${this.tickNumber} was ${lateness}ms late, skipping ${ticksBehind} tick(s), resetting schedule (total missed: ${this.missedTickCount})${suffix}`,
        );
      } else {
        this.suppressedScheduleResetWarnings++;
      }
      this.nextTickTime = now + TICK_DURATION_MS;
    }

    // Only re-sort listeners if they've changed (zero-allocation in steady state)
    if (this.listenersDirty) {
      // Clear and repopulate the cached array (avoids allocation)
      this.sortedListeners.length = 0;
      for (let i = 0; i < this.listeners.length; i++) {
        this.sortedListeners.push(this.listeners[i]);
      }
      // Sort by priority (stable sort preserves registration order within same priority)
      this.sortedListeners.sort((a, b) => a.priority - b.priority);
      this.listenersDirty = false;
    }

    // Call all listeners in priority order (zero allocation)
    const tickStart = Date.now();

    for (let i = 0; i < this.sortedListeners.length; i++) {
      const listener = this.sortedListeners[i];
      const handlerStart = Date.now();

      try {
        listener.callback(this.tickNumber, deltaMs);
      } catch (error) {
        console.error(
          `[TickSystem] Error in tick listener (priority ${listener.priority}):`,
          error,
        );
      }

      // Track handler timing
      const handlerDuration = Date.now() - handlerStart;
      let handlerHistogram = this.handlerDurationHistograms.get(listener.name);
      if (!handlerHistogram) {
        handlerHistogram = new DurationHistogram();
        this.handlerDurationHistograms.set(listener.name, handlerHistogram);
      }
      handlerHistogram.record(handlerDuration);

      // Warn about slow handlers (but don't skip - could break game logic)
      if (handlerDuration > TickSystem.SLOW_HANDLER_THRESHOLD_MS) {
        if (now >= this.nextSlowHandlerLogAt) {
          const suppressed = this.suppressedSlowHandlerWarnings;
          this.suppressedSlowHandlerWarnings = 0;
          this.nextSlowHandlerLogAt = now + TickSystem.WARNING_LOG_COOLDOWN_MS;
          const suffix =
            suppressed > 0
              ? ` (suppressed ${suppressed} similar warnings)`
              : "";
          console.warn(
            `[TickSystem] Slow handler "${listener.name}" (priority ${listener.priority}): ${handlerDuration}ms${suffix}`,
          );
        } else {
          this.suppressedSlowHandlerWarnings++;
        }
      }

      // Track timing stats for debugging (sample every 10th tick to reduce overhead)
      if (this.tickNumber % 10 === 0) {
        const timings = this.handlerTimings.get(listener.priority) || [];
        timings.push(handlerDuration);
        // Keep only last 100 samples
        if (timings.length > 100) timings.shift();
        this.handlerTimings.set(listener.priority, timings);
      }
    }

    // Track total tick duration
    this.lastTickDuration = Date.now() - tickStart;
    this.tickDurationHistogram.record(this.lastTickDuration);

    // Warn if total tick exceeds budget
    if (this.lastTickDuration > TICK_DURATION_MS * 0.8) {
      if (now >= this.nextOverBudgetLogAt) {
        const suppressed = this.suppressedOverBudgetWarnings;
        this.suppressedOverBudgetWarnings = 0;
        this.nextOverBudgetLogAt = now + TickSystem.WARNING_LOG_COOLDOWN_MS;
        const suffix =
          suppressed > 0 ? ` (suppressed ${suppressed} similar warnings)` : "";
        console.warn(
          `[TickSystem] Tick ${this.tickNumber} took ${this.lastTickDuration}ms (>${TICK_DURATION_MS * 0.8}ms budget)${suffix}`,
        );
      } else {
        this.suppressedOverBudgetWarnings++;
      }
    }
  }

  /**
   * Register a tick listener with priority
   * @param callback Function to call each tick
   * @param priority When to run relative to other listeners
   * @returns Unsubscribe function
   */
  onTick(
    callback: (tickNumber: number, deltaMs: number) => void,
    priority: TickPriority = TickPriority.MOVEMENT,
    name = "anonymous",
  ): () => void {
    const listener: TickListener = { callback, priority, name };
    this.listeners.push(listener);
    this.listenersDirty = true; // Mark for re-sort

    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
        this.listenersDirty = true; // Mark for re-sort
      }
    };
  }

  /**
   * Get current tick number
   */
  getCurrentTick(): number {
    return this.tickNumber;
  }

  /**
   * Get time until next tick (in ms)
   */
  getTimeUntilNextTick(): number {
    if (!this.isRunning) return TICK_DURATION_MS;
    const elapsed = Date.now() - this.lastTickTime;
    return Math.max(0, TICK_DURATION_MS - elapsed);
  }

  /**
   * Check if tick system is running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get number of registered listeners
   */
  getListenerCount(): number {
    return this.listeners.length;
  }

  /**
   * Get last tick processing duration (ms)
   */
  getLastTickDuration(): number {
    return this.lastTickDuration;
  }

  /**
   * Get handler timing statistics for debugging
   * @returns Map of priority -> { avg, max, samples }
   */
  getHandlerTimingStats(): Map<
    number,
    { avg: number; max: number; samples: number }
  > {
    const stats = new Map<
      number,
      { avg: number; max: number; samples: number }
    >();

    for (const [priority, timings] of this.handlerTimings) {
      if (timings.length === 0) continue;

      const sum = timings.reduce((a, b) => a + b, 0);
      const max = Math.max(...timings);
      stats.set(priority, {
        avg: Math.round(sum / timings.length),
        max,
        samples: timings.length,
      });
    }

    return stats;
  }

  /** Full-window per-listener percentiles, keyed by stable listener name. */
  getHandlerTimingPercentiles(): Record<string, DurationPercentiles> {
    const stats: Record<string, DurationPercentiles> = {};
    for (const [name, histogram] of this.handlerDurationHistograms) {
      stats[name] = histogram.snapshot();
    }
    return stats;
  }

  /**
   * Get tick health statistics for monitoring
   * @returns Tick health metrics
   */
  getTickHealthStats(): {
    currentTick: number;
    missedTicks: number;
    lateTicks: number;
    maxLateness: number;
    lastResetTick: number;
    lastTickDuration: number;
    tickDurations: DurationPercentiles;
    tickLateness: DurationPercentiles;
    isHealthy: boolean;
  } {
    // Healthy if missed <1% of ticks and max lateness < 2 tick durations
    const isHealthy =
      this.tickNumber === 0 ||
      (this.missedTickCount / this.tickNumber < 0.01 &&
        this.maxTickLateness < TICK_DURATION_MS * 2);

    return {
      currentTick: this.tickNumber,
      missedTicks: this.missedTickCount,
      lateTicks: this.lateTickCount,
      maxLateness: this.maxTickLateness,
      lastResetTick: this.lastScheduleReset,
      lastTickDuration: this.lastTickDuration,
      tickDurations: this.tickDurationHistogram.snapshot(),
      tickLateness: this.tickLatenessHistogram.snapshot(),
      isHealthy,
    };
  }

  /**
   * Reset tick health statistics (for testing or after recovery)
   */
  resetTickHealthStats(): void {
    this.missedTickCount = 0;
    this.lateTickCount = 0;
    this.maxTickLateness = 0;
    this.lastScheduleReset = 0;
    this.tickDurationHistogram.reset();
    this.tickLatenessHistogram.reset();
    for (const histogram of this.handlerDurationHistograms.values()) {
      histogram.reset();
    }
  }
}
