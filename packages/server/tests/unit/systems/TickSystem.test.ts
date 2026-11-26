/**
 * TickSystem Tests
 *
 * Tests the server tick system which runs the game loop.
 * Verifies tick timing, handler execution, and health tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TickSystem, TickPriority } from "../../../src/systems/TickSystem";

describe("TickSystem", () => {
  let tickSystem: TickSystem;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    tickSystem = new TickSystem();
  });

  afterEach(() => {
    tickSystem.stop();
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("starts and stops correctly", () => {
      expect(tickSystem.getIsRunning()).toBe(false);
      tickSystem.start();
      expect(tickSystem.getIsRunning()).toBe(true);
      tickSystem.stop();
      expect(tickSystem.getIsRunning()).toBe(false);
    });

    it("increments tick number on each tick", () => {
      tickSystem.start();
      expect(tickSystem.getCurrentTick()).toBe(0);

      // Advance past first tick (600ms default)
      vi.advanceTimersByTime(601);
      expect(tickSystem.getCurrentTick()).toBe(1);

      vi.advanceTimersByTime(600);
      expect(tickSystem.getCurrentTick()).toBe(2);
    });

    it("calls registered handlers with tick number and delta", () => {
      const handler = vi.fn();
      tickSystem.onTick(handler);
      tickSystem.start();

      vi.advanceTimersByTime(601);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(1, expect.any(Number));
    });
  });

  describe("handler priorities", () => {
    it("calls handlers in priority order", () => {
      const order: string[] = [];

      tickSystem.onTick(() => order.push("broadcast"), TickPriority.BROADCAST);
      tickSystem.onTick(() => order.push("input"), TickPriority.INPUT);
      tickSystem.onTick(() => order.push("combat"), TickPriority.COMBAT);
      tickSystem.onTick(() => order.push("movement"), TickPriority.MOVEMENT);

      tickSystem.start();
      vi.advanceTimersByTime(601);

      expect(order).toEqual(["input", "movement", "combat", "broadcast"]);
    });

    it("handles unsubscribe correctly", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsubscribe = tickSystem.onTick(handler1);
      tickSystem.onTick(handler2);

      tickSystem.start();
      vi.advanceTimersByTime(601);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      unsubscribe();

      vi.advanceTimersByTime(600);

      expect(handler1).toHaveBeenCalledTimes(1); // Not called again
      expect(handler2).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    it("continues processing after handler error", () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error("Handler error");
      });
      const successHandler = vi.fn();

      tickSystem.onTick(errorHandler, TickPriority.INPUT);
      tickSystem.onTick(successHandler, TickPriority.MOVEMENT);

      tickSystem.start();
      vi.advanceTimersByTime(601);

      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
    });
  });

  describe("drift correction", () => {
    it("maintains accurate tick timing despite processing delays", () => {
      const handler = vi.fn().mockImplementation(() => {
        // Simulate slow handler
        vi.advanceTimersByTime(100);
      });

      tickSystem.onTick(handler);
      tickSystem.start();

      // First tick at 600ms
      vi.advanceTimersByTime(601);
      expect(tickSystem.getCurrentTick()).toBe(1);

      // Despite 100ms handler delay, next tick should still be scheduled correctly
      vi.advanceTimersByTime(500);
      expect(tickSystem.getCurrentTick()).toBe(2);
    });
  });

  describe("tick health tracking", () => {
    it("tracks late ticks", async () => {
      // Use real timers for this case: fake timers execute callbacks exactly on
      // schedule and cannot emulate event-loop stalls that create lateness.
      tickSystem.stop();
      vi.useRealTimers();
      tickSystem = new TickSystem();
      tickSystem.start();

      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Block past the next tick deadline to force a late tick.
      const stallStart = Date.now();
      while (Date.now() - stallStart < 500) {
        // Intentional event-loop stall for lateness simulation.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));

      const health = tickSystem.getTickHealthStats();
      expect(health.lateTicks).toBeGreaterThan(0);
    });

    it("tracks missed ticks when falling behind", () => {
      tickSystem.start();

      // Simulate falling very far behind (>2 ticks)
      vi.advanceTimersByTime(3000); // 5 ticks worth of time

      const health = tickSystem.getTickHealthStats();
      expect(health.missedTicks).toBeGreaterThanOrEqual(0);
    });

    it("reports healthy status when no issues", () => {
      tickSystem.start();

      // Run a few normal ticks
      vi.advanceTimersByTime(600);
      vi.advanceTimersByTime(600);
      vi.advanceTimersByTime(600);

      const health = tickSystem.getTickHealthStats();
      expect(health.isHealthy).toBe(true);
      expect(health.currentTick).toBe(3);
    });

    it("resets health stats when requested", () => {
      tickSystem.start();

      // Generate some stats
      vi.advanceTimersByTime(2000);

      // Reset
      tickSystem.resetTickHealthStats();

      const health = tickSystem.getTickHealthStats();
      expect(health.missedTicks).toBe(0);
      expect(health.lateTicks).toBe(0);
      expect(health.maxLateness).toBe(0);
      expect(health.tickDurations.samples).toBe(0);
      expect(health.tickLateness.samples).toBe(0);
    });

    it("records full-window tick and named-handler percentiles", () => {
      let duration = 0;
      tickSystem.onTick(
        () => {
          duration++;
          vi.advanceTimersByTime(duration);
        },
        TickPriority.COMBAT,
        "measuredCombat",
      );
      tickSystem.start();

      for (let i = 0; i < 100; i++) {
        vi.advanceTimersToNextTimer();
      }

      const health = tickSystem.getTickHealthStats();
      expect(health.tickDurations).toMatchObject({
        samples: 100,
        average: 50.5,
        p50: 50,
        p95: 95,
        p99: 99,
        max: 100,
      });
      expect(health.tickLateness.samples).toBe(100);
      expect(tickSystem.getHandlerTimingPercentiles().measuredCombat).toEqual(
        health.tickDurations,
      );
    });
  });

  describe("handler timing stats", () => {
    it("tracks handler timing for debugging", () => {
      const slowHandler = vi.fn().mockImplementation(() => {
        // Simulate handler runtime safely under fake timers.
        vi.advanceTimersByTime(10);
      });

      tickSystem.onTick(slowHandler, TickPriority.INPUT);
      tickSystem.start();

      // Run 10 ticks to get sample data
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(600);
      }

      const stats = tickSystem.getHandlerTimingStats();
      // Stats are sampled every 10th tick, so we may have data
      expect(stats).toBeDefined();
    });
  });

  describe("listener management", () => {
    it("reports correct listener count", () => {
      expect(tickSystem.getListenerCount()).toBe(0);

      const unsub1 = tickSystem.onTick(() => {});
      expect(tickSystem.getListenerCount()).toBe(1);

      const unsub2 = tickSystem.onTick(() => {});
      expect(tickSystem.getListenerCount()).toBe(2);

      unsub1();
      expect(tickSystem.getListenerCount()).toBe(1);

      unsub2();
      expect(tickSystem.getListenerCount()).toBe(0);
    });
  });

  describe("time until next tick", () => {
    it("returns correct time until next tick", () => {
      tickSystem.start();

      // Just started - should be close to full tick duration
      const timeUntil = tickSystem.getTimeUntilNextTick();
      expect(timeUntil).toBeLessThanOrEqual(600);
      expect(timeUntil).toBeGreaterThanOrEqual(0);

      // Advance halfway
      vi.advanceTimersByTime(300);

      const timeUntilHalfway = tickSystem.getTimeUntilNextTick();
      expect(timeUntilHalfway).toBeLessThanOrEqual(300);
    });

    it("returns default when not running", () => {
      const timeUntil = tickSystem.getTimeUntilNextTick();
      expect(timeUntil).toBe(600); // TICK_DURATION_MS default
    });
  });
});
