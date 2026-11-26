import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateMemoryGrowthTrend,
  MemoryMonitor,
  type MemorySample,
} from "../memory-monitor";

const MB = 1024 * 1024;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function samplesFromMB(values: number[]): MemorySample[] {
  return values.map((value, index) => ({
    timestamp: index * 30_000,
    rss: value * MB,
    heapUsed: value * MB,
    heapTotal: (value + 20) * MB,
    external: 0,
  }));
}

describe("calculateMemoryGrowthTrend", () => {
  it("detects a linear sustained increase", () => {
    const samples = samplesFromMB([
      100, 106, 112, 118, 124, 130, 136, 142, 148, 154, 160,
    ]);

    const trend = calculateMemoryGrowthTrend(samples, "rss");
    expect(trend.durationMs).toBe(300_000);
    expect(trend.regressionMBPerMin).toBeCloseTo(12, 5);
    expect(trend.medianWindowMBPerMin).toBeCloseTo(12, 5);
  });

  it("rejects a GC sawtooth with one high endpoint", () => {
    const samples = samplesFromMB([
      100, 130, 96, 126, 92, 122, 98, 128, 94, 124, 220,
    ]);

    const trend = calculateMemoryGrowthTrend(samples, "rss");
    expect(trend.medianWindowMBPerMin).toBeLessThan(10);
  });
});

describe("MemoryMonitor sustained growth warnings", () => {
  it("does not warn before the configured sustained-growth duration is complete", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const monitor = new MemoryMonitor({
      sustainedGrowthThresholdMs: 300_000,
      leakWarningThresholdMBPerMin: 10,
    });
    const samples = samplesFromMB([
      100, 106, 112, 118, 124, 130, 136, 142, 148, 154,
    ]);
    (monitor as unknown as { samples: MemorySample[] }).samples = samples;
    vi.setSystemTime(samples[samples.length - 1].timestamp);

    (
      monitor as unknown as { analyzeMemoryTrends: () => void }
    ).analyzeMemoryTrends();

    expect(monitor.getStats().recentWarnings).toEqual([]);
  });

  it("warns only when regression and median windows both exceed the threshold", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const monitor = new MemoryMonitor({
      sustainedGrowthThresholdMs: 300_000,
      leakWarningThresholdMBPerMin: 10,
    });
    const samples = samplesFromMB([
      100, 106, 112, 118, 124, 130, 136, 142, 148, 154, 160,
    ]);
    (monitor as unknown as { samples: MemorySample[] }).samples = samples;
    vi.setSystemTime(samples[samples.length - 1].timestamp);

    (
      monitor as unknown as { analyzeMemoryTrends: () => void }
    ).analyzeMemoryTrends();

    expect(monitor.getStats().recentWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "rss" }),
        expect.objectContaining({ type: "heap" }),
      ]),
    );
  });

  it("does not warn on a volatile sawtooth plus one endpoint spike", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const monitor = new MemoryMonitor({
      sustainedGrowthThresholdMs: 300_000,
      leakWarningThresholdMBPerMin: 10,
    });
    const samples = samplesFromMB([
      100, 130, 96, 126, 92, 122, 98, 128, 94, 124, 220,
    ]);
    (monitor as unknown as { samples: MemorySample[] }).samples = samples;
    vi.setSystemTime(samples[samples.length - 1].timestamp);

    (
      monitor as unknown as { analyzeMemoryTrends: () => void }
    ).analyzeMemoryTrends();

    expect(monitor.getStats().recentWarnings).toEqual([]);
  });

  it("retains collection baselines and extrema without verbose logging", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let size = 4;
    const monitor = new MemoryMonitor({
      sampleIntervalMs: 1_000,
      trackCollections: true,
    });
    monitor.registerCollection({ name: "test.queue", getSize: () => size });
    monitor.start();

    vi.advanceTimersByTime(1_000);
    size = 9;
    vi.advanceTimersByTime(1_000);
    size = 2;
    vi.advanceTimersByTime(1_000);

    expect(monitor.getCollectionMetrics()).toContainEqual({
      name: "test.queue",
      size: 2,
      previousSize: 9,
      growthRate: -7,
      initialSize: 4,
      minSize: 2,
      maxSize: 9,
      samples: 3,
    });
    monitor.stop();
  });
});
