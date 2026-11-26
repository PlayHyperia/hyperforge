/**
 * Memory Monitoring Infrastructure
 *
 * Provides comprehensive memory monitoring, leak detection, and profiling tools
 * for the Hyperia server. Features include:
 *
 * - Real-time memory tracking with trend analysis
 * - Collection size monitoring (Maps, Sets, Arrays)
 * - Memory leak detection based on sustained growth
 * - Periodic heap snapshots for profiling
 * - Memory pressure alerts
 */

import type { World } from "@hyperforge/shared";
import { createRequire } from "node:module";
import v8 from "v8";
import fs from "fs";
import path from "path";

/** Memory sample for trend analysis */
export interface MemorySample {
  timestamp: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface MemoryGrowthTrend {
  durationMs: number;
  regressionMBPerMin: number;
  medianWindowMBPerMin: number;
  medianWindowGrowthMB: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

/**
 * Estimate a memory trend without letting one GC trough or endpoint spike
 * masquerade as sustained growth.
 */
export function calculateMemoryGrowthTrend(
  samples: MemorySample[],
  metric: "rss" | "heapUsed",
): MemoryGrowthTrend {
  if (samples.length < 2) {
    return {
      durationMs: 0,
      regressionMBPerMin: 0,
      medianWindowMBPerMin: 0,
      medianWindowGrowthMB: 0,
    };
  }

  const MB = 1024 * 1024;
  const firstTimestamp = samples[0].timestamp;
  const lastTimestamp = samples[samples.length - 1].timestamp;
  const durationMs = Math.max(0, lastTimestamp - firstTimestamp);
  if (durationMs === 0) {
    return {
      durationMs,
      regressionMBPerMin: 0,
      medianWindowMBPerMin: 0,
      medianWindowGrowthMB: 0,
    };
  }

  const xValues = samples.map(
    (sample) => (sample.timestamp - firstTimestamp) / 60_000,
  );
  const yValues = samples.map((sample) => sample[metric] / MB);
  const meanX = xValues.reduce((sum, value) => sum + value, 0) / samples.length;
  const meanY = yValues.reduce((sum, value) => sum + value, 0) / samples.length;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < samples.length; index++) {
    const centeredX = xValues[index] - meanX;
    covariance += centeredX * (yValues[index] - meanY);
    variance += centeredX * centeredX;
  }
  const regressionMBPerMin = variance > 0 ? covariance / variance : 0;

  const windowSize = Math.min(
    samples.length,
    Math.max(3, Math.ceil(samples.length / 4)),
  );
  const earlySamples = samples.slice(0, windowSize);
  const lateSamples = samples.slice(-windowSize);
  const earlyMedianMB = median(
    earlySamples.map((sample) => sample[metric] / MB),
  );
  const lateMedianMB = median(lateSamples.map((sample) => sample[metric] / MB));
  const earlyMedianTime = median(
    earlySamples.map((sample) => sample.timestamp),
  );
  const lateMedianTime = median(lateSamples.map((sample) => sample.timestamp));
  const medianDurationMin = (lateMedianTime - earlyMedianTime) / 60_000;
  const medianWindowGrowthMB = lateMedianMB - earlyMedianMB;
  const medianWindowMBPerMin =
    medianDurationMin > 0 ? medianWindowGrowthMB / medianDurationMin : 0;

  return {
    durationMs,
    regressionMBPerMin,
    medianWindowMBPerMin,
    medianWindowGrowthMB,
  };
}

type BunJSCHeapStats = {
  heapSize: number;
  heapCapacity: number;
  extraMemorySize: number;
  objectCount: number;
  protectedObjectCount: number;
  globalObjectCount: number;
  protectedGlobalObjectCount: number;
  objectTypeCounts: Record<string, number>;
  protectedObjectTypeCounts: Record<string, number>;
};

type BunJSCModule = {
  heapStats: () => BunJSCHeapStats;
  fullGC?: () => number;
  gcAndSweep?: () => number;
};

export interface JSCObjectTypeMetric {
  name: string;
  count: number;
  previousCount: number;
  growth: number;
}

export interface JSCHeapSummary {
  heapSize: number;
  heapCapacity: number;
  extraMemorySize: number;
  objectCount: number;
  protectedObjectCount: number;
  globalObjectCount: number;
  protectedGlobalObjectCount: number;
  topObjectTypes: JSCObjectTypeMetric[];
  growingObjectTypes: JSCObjectTypeMetric[];
  topProtectedObjectTypes: JSCObjectTypeMetric[];
}

/** Collection metric for tracking internal data structures */
interface CollectionMetric {
  name: string;
  size: number;
  previousSize: number;
  growthRate: number;
  initialSize: number;
  minSize: number;
  maxSize: number;
  samples: number;
}

/** Memory leak warning */
interface LeakWarning {
  timestamp: number;
  type: "rss" | "heap" | "collection";
  message: string;
  growthMB: number;
  durationMs: number;
}

/** Configuration for the memory monitor */
export interface MemoryMonitorConfig {
  /** Sampling interval in milliseconds (default: 30000) */
  sampleIntervalMs?: number;
  /** Number of samples to keep for trend analysis (default: 60) */
  sampleHistorySize?: number;
  /** Memory growth rate (MB/min) that triggers a warning (default: 10) */
  leakWarningThresholdMBPerMin?: number;
  /** Sustained growth duration (ms) before warning (default: 300000 = 5 min) */
  sustainedGrowthThresholdMs?: number;
  /** Memory limit in GB for soft warnings (default: 12) */
  memoryLimitGB?: number;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
  /** Enable collection tracking (default: true) */
  trackCollections?: boolean;
}

/** Accessor interface for tracked collections */
export interface CollectionAccessor {
  name: string;
  getSize: () => number;
}

/**
 * Memory Monitor
 *
 * Central service for monitoring server memory usage and detecting leaks.
 */
export class MemoryMonitor {
  private static bunJSCModule: BunJSCModule | null | undefined = undefined;

  private config: Required<MemoryMonitorConfig>;
  private samples: MemorySample[] = [];
  private collectionMetrics: Map<string, CollectionMetric> = new Map();
  private leakWarnings: LeakWarning[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private world: World | null = null;
  private customCollections: CollectionAccessor[] = [];
  private startTime: number = Date.now();
  private isRunning = false;
  private readonly jscHeapStatsEnabled =
    (process.env.MEMORY_MONITOR_JSC_HEAP_STATS || "false").toLowerCase() ===
    "true";
  private readonly bunJSC = this.jscHeapStatsEnabled
    ? MemoryMonitor.loadBunJSCModule()
    : null;
  private jscHeapSummary: JSCHeapSummary | null = null;
  private lastJSCObjectTypeCounts: Record<string, number> | null = null;
  private lastProtectedJSCObjectTypeCounts: Record<string, number> | null =
    null;

  /** Maximum leak warnings to retain */
  private static readonly MAX_LEAK_WARNINGS = 100;
  private static readonly JSC_OBJECT_TYPE_LIMIT = 12;

  constructor(config: MemoryMonitorConfig = {}) {
    this.config = {
      sampleIntervalMs: config.sampleIntervalMs ?? 30_000,
      sampleHistorySize: config.sampleHistorySize ?? 60,
      leakWarningThresholdMBPerMin: config.leakWarningThresholdMBPerMin ?? 10,
      sustainedGrowthThresholdMs:
        config.sustainedGrowthThresholdMs ?? 5 * 60 * 1000,
      memoryLimitGB: config.memoryLimitGB ?? 12,
      verbose: config.verbose ?? false,
      trackCollections: config.trackCollections ?? true,
    };
  }

  private static loadBunJSCModule(): BunJSCModule | null {
    if (MemoryMonitor.bunJSCModule !== undefined) {
      return MemoryMonitor.bunJSCModule;
    }

    if (typeof globalThis.Bun === "undefined") {
      MemoryMonitor.bunJSCModule = null;
      return null;
    }

    try {
      const require = createRequire(import.meta.url);
      MemoryMonitor.bunJSCModule = require("bun:jsc") as BunJSCModule;
    } catch {
      MemoryMonitor.bunJSCModule = null;
    }

    return MemoryMonitor.bunJSCModule;
  }

  /**
   * Start the memory monitor
   */
  start(world?: World): void {
    if (this.isRunning) {
      console.warn("[MemoryMonitor] Already running");
      return;
    }

    this.world = world ?? null;
    this.startTime = Date.now();
    this.isRunning = true;

    // Take initial sample
    this.takeSample();

    // Start periodic sampling
    this.timer = setInterval(() => {
      this.takeSample();
      this.analyzeMemoryTrends();
      if (this.config.trackCollections) {
        this.updateCollectionMetrics();
      }
    }, this.config.sampleIntervalMs);

    // Don't keep process alive just for monitoring
    this.timer.unref?.();

    console.log(
      `[MemoryMonitor] Started (interval: ${this.config.sampleIntervalMs}ms, history: ${this.config.sampleHistorySize} samples, jscHeapStats: ${this.jscHeapStatsEnabled ? "enabled" : "disabled"})`,
    );
  }

  /**
   * Stop the memory monitor
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log("[MemoryMonitor] Stopped");
  }

  /**
   * Register a custom collection to track
   */
  registerCollection(accessor: CollectionAccessor): void {
    this.customCollections.push(accessor);
  }

  /**
   * Unregister a custom collection
   */
  unregisterCollection(name: string): void {
    this.customCollections = this.customCollections.filter(
      (c) => c.name !== name,
    );
    this.collectionMetrics.delete(name);
  }

  /**
   * Take a memory sample
   */
  private takeSample(): void {
    const mem = process.memoryUsage();
    const sample: MemorySample = {
      timestamp: Date.now(),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    };

    this.updateJSCHeapSummary();
    this.samples.push(sample);

    // Keep only the configured history size
    while (this.samples.length > this.config.sampleHistorySize) {
      this.samples.shift();
    }

    if (this.config.verbose) {
      const MB = 1024 * 1024;
      console.log(
        `[MemoryMonitor] Sample: RSS=${(sample.rss / MB).toFixed(1)}MB ` +
          `HeapUsed=${(sample.heapUsed / MB).toFixed(1)}MB`,
      );
      const growingTypes = this.jscHeapSummary?.growingObjectTypes
        .slice(0, 3)
        .filter((metric) => metric.growth > 0);
      if (growingTypes && growingTypes.length > 0) {
        console.log(
          `[MemoryMonitor] JSC growth: ${growingTypes
            .map((metric) => `${metric.name}=+${metric.growth}`)
            .join(", ")}`,
        );
      }
    }
  }

  private updateJSCHeapSummary(): void {
    if (!this.jscHeapStatsEnabled || !this.bunJSC?.heapStats) return;

    try {
      this.applyJSCHeapStats(this.bunJSC.heapStats());
    } catch {
      this.jscHeapSummary = null;
    }
  }

  captureJSCHeapSummary(): JSCHeapSummary | null {
    const bunJSC = this.bunJSC ?? MemoryMonitor.loadBunJSCModule();
    if (!bunJSC?.heapStats) {
      this.jscHeapSummary = null;
      return null;
    }

    try {
      this.applyJSCHeapStats(bunJSC.heapStats());
      return this.jscHeapSummary;
    } catch {
      this.jscHeapSummary = null;
      return null;
    }
  }

  private applyJSCHeapStats(stats: BunJSCHeapStats): void {
    const previousObjectTypeCounts = this.lastJSCObjectTypeCounts ?? {};
    const previousProtectedTypeCounts =
      this.lastProtectedJSCObjectTypeCounts ?? {};

    const objectTypeMetrics = this.buildJSCObjectTypeMetrics(
      stats.objectTypeCounts,
      previousObjectTypeCounts,
    );
    const protectedObjectTypeMetrics = this.buildJSCObjectTypeMetrics(
      stats.protectedObjectTypeCounts,
      previousProtectedTypeCounts,
    );

    this.jscHeapSummary = {
      heapSize: stats.heapSize,
      heapCapacity: stats.heapCapacity,
      extraMemorySize: stats.extraMemorySize,
      objectCount: stats.objectCount,
      protectedObjectCount: stats.protectedObjectCount,
      globalObjectCount: stats.globalObjectCount,
      protectedGlobalObjectCount: stats.protectedGlobalObjectCount,
      topObjectTypes: objectTypeMetrics
        .slice()
        .sort((left, right) => {
          if (right.count !== left.count) return right.count - left.count;
          return right.growth - left.growth;
        })
        .slice(0, MemoryMonitor.JSC_OBJECT_TYPE_LIMIT),
      growingObjectTypes: objectTypeMetrics
        .filter((metric) => metric.growth > 0)
        .sort((left, right) => {
          if (right.growth !== left.growth) return right.growth - left.growth;
          return right.count - left.count;
        })
        .slice(0, MemoryMonitor.JSC_OBJECT_TYPE_LIMIT),
      topProtectedObjectTypes: protectedObjectTypeMetrics
        .slice()
        .sort((left, right) => {
          if (right.count !== left.count) return right.count - left.count;
          return right.growth - left.growth;
        })
        .slice(0, MemoryMonitor.JSC_OBJECT_TYPE_LIMIT),
    };

    this.lastJSCObjectTypeCounts = { ...stats.objectTypeCounts };
    this.lastProtectedJSCObjectTypeCounts = {
      ...stats.protectedObjectTypeCounts,
    };
  }

  private buildJSCObjectTypeMetrics(
    currentCounts: Record<string, number>,
    previousCounts: Record<string, number>,
  ): JSCObjectTypeMetric[] {
    return Object.entries(currentCounts).map(([name, count]) => {
      const previousCount = previousCounts[name] ?? count;
      return {
        name,
        count,
        previousCount,
        growth: count - previousCount,
      };
    });
  }

  /**
   * Analyze memory trends and detect potential leaks
   */
  private analyzeMemoryTrends(): void {
    if (this.samples.length < 2) return;

    const now = Date.now();
    const MB = 1024 * 1024;

    // Find samples within the sustained growth window
    const windowStart = now - this.config.sustainedGrowthThresholdMs;
    const windowSamples = this.samples.filter(
      (s) => s.timestamp >= windowStart,
    );

    if (windowSamples.length < 8) return;

    const lastSample = windowSamples[windowSamples.length - 1];
    const durationMs = lastSample.timestamp - windowSamples[0].timestamp;
    const durationMin = durationMs / 60_000;

    // "Sustained" means the complete configured window. Sampling begins with
    // an immediate baseline, so accepting a 90% window turns the default
    // five-minute policy into a four-and-a-half-minute warning and can report
    // allocator warm-up immediately before its next release.
    if (durationMs < this.config.sustainedGrowthThresholdMs) return;

    const rssTrend = calculateMemoryGrowthTrend(windowSamples, "rss");
    const heapTrend = calculateMemoryGrowthTrend(windowSamples, "heapUsed");
    const threshold = this.config.leakWarningThresholdMBPerMin;

    // Check for sustained growth
    if (
      rssTrend.regressionMBPerMin > threshold &&
      rssTrend.medianWindowMBPerMin > threshold
    ) {
      this.recordLeakWarning({
        timestamp: now,
        type: "rss",
        message: `Sustained RSS growth: regression ${rssTrend.regressionMBPerMin.toFixed(2)} MB/min, median windows ${rssTrend.medianWindowMBPerMin.toFixed(2)} MB/min over ${durationMin.toFixed(1)} min`,
        growthMB: rssTrend.medianWindowGrowthMB,
        durationMs,
      });
    }

    if (
      heapTrend.regressionMBPerMin > threshold &&
      heapTrend.medianWindowMBPerMin > threshold
    ) {
      this.recordLeakWarning({
        timestamp: now,
        type: "heap",
        message: `Sustained heap growth: regression ${heapTrend.regressionMBPerMin.toFixed(2)} MB/min, median windows ${heapTrend.medianWindowMBPerMin.toFixed(2)} MB/min over ${durationMin.toFixed(1)} min`,
        growthMB: heapTrend.medianWindowGrowthMB,
        durationMs,
      });
    }

    // Check absolute memory limits
    const softLimit = this.config.memoryLimitGB * 1024 * MB * 0.8;
    if (lastSample.rss > softLimit) {
      console.warn(
        `[MemoryMonitor] ⚠️ RSS ${(lastSample.rss / MB).toFixed(1)}MB > 80% of ${this.config.memoryLimitGB}GB limit`,
      );
    }
  }

  /**
   * Record a leak warning
   */
  private recordLeakWarning(warning: LeakWarning): void {
    // Avoid duplicate warnings within the same minute
    const recentSame = this.leakWarnings.find(
      (w) =>
        w.type === warning.type && warning.timestamp - w.timestamp < 60_000,
    );

    if (!recentSame) {
      this.leakWarnings.push(warning);
      console.warn(`[MemoryMonitor] ⚠️ LEAK WARNING: ${warning.message}`);

      // Trim old warnings
      while (this.leakWarnings.length > MemoryMonitor.MAX_LEAK_WARNINGS) {
        this.leakWarnings.shift();
      }
    }
  }

  /**
   * Update collection size metrics
   */
  private updateCollectionMetrics(): void {
    // Track custom registered collections
    for (const accessor of this.customCollections) {
      try {
        const size = accessor.getSize();
        const existing = this.collectionMetrics.get(accessor.name);
        const previousSize = existing?.size ?? size;
        const growthRate = size - previousSize;

        this.collectionMetrics.set(accessor.name, {
          name: accessor.name,
          size,
          previousSize,
          growthRate,
          initialSize: existing?.initialSize ?? size,
          minSize: Math.min(existing?.minSize ?? size, size),
          maxSize: Math.max(existing?.maxSize ?? size, size),
          samples: (existing?.samples ?? 0) + 1,
        });

        // Warn on significant collection growth
        if (growthRate > 1000) {
          console.warn(
            `[MemoryMonitor] Collection "${accessor.name}" grew by ${growthRate} entries`,
          );
        }
      } catch {
        // Collection accessor failed - remove it
        this.unregisterCollection(accessor.name);
      }
    }

    // Track world collections if available
    if (this.world) {
      this.trackWorldCollections();
    }
  }

  /**
   * Track collections on the World object
   */
  private trackWorldCollections(): void {
    if (!this.world) return;

    const worldRecord = this.world as {
      entities?: {
        items?: { length?: number; size?: number };
        players?: { length?: number; size?: number };
      };
      systemsByName?: Map<string, unknown>;
      getSystem?: (name: string) => unknown;
      getEventBus?: () => {
        getPendingHandlerCount?: () => number;
      };
    };

    // Track entity counts
    if (worldRecord.entities) {
      this.trackCollectionSize(
        "world.entities.items",
        worldRecord.entities.items,
      );
      this.trackCollectionSize(
        "world.entities.players",
        worldRecord.entities.players,
      );
    }

    const eventBus = worldRecord.getEventBus?.();
    if (eventBus?.getPendingHandlerCount) {
      this.trackCollectionSize("World.eventBus.pendingAsyncHandlers", {
        size: eventBus.getPendingHandlerCount(),
      });
    }

    const getSystem =
      typeof worldRecord.getSystem === "function"
        ? worldRecord.getSystem.bind(worldRecord)
        : null;

    const combatSystem = getSystem?.("combat") as
      | {
          stateService?: {
            getCombatStatesMap?: () => Map<unknown, unknown>;
          };
          nextAttackTicks?: Map<unknown, unknown>;
          playerEquipmentStats?: Map<unknown, unknown>;
          eventStore?: {
            getEventCount?: () => number;
            getSnapshotCount?: () => number;
          };
        }
      | undefined;
    if (combatSystem) {
      this.trackCollectionSize("Combat.stateService.combatStates", {
        size: combatSystem.stateService?.getCombatStatesMap?.().size ?? 0,
      });
      this.trackCollectionSize(
        "Combat.nextAttackTicks",
        combatSystem.nextAttackTicks,
      );
      this.trackCollectionSize(
        "Combat.playerEquipmentStats",
        combatSystem.playerEquipmentStats,
      );
      this.trackCollectionSize("Combat.eventStore.events", {
        size: combatSystem.eventStore?.getEventCount?.() ?? 0,
      });
      this.trackCollectionSize("Combat.eventStore.snapshots", {
        size: combatSystem.eventStore?.getSnapshotCount?.() ?? 0,
      });
    }

    const playerDeathSystem = getSystem?.("player-death") as
      | {
          respawnTimers?: Map<unknown, unknown>;
          deathLocations?: Map<unknown, unknown>;
          playerPositions?: Map<unknown, unknown>;
          playerInventories?: Map<unknown, unknown>;
          pendingGravestones?: Map<unknown, unknown>;
          lastDeathTime?: Map<unknown, unknown>;
        }
      | undefined;
    if (playerDeathSystem) {
      this.trackCollectionSize(
        "PlayerDeath.respawnTimers",
        playerDeathSystem.respawnTimers,
      );
      this.trackCollectionSize(
        "PlayerDeath.deathLocations",
        playerDeathSystem.deathLocations,
      );
      this.trackCollectionSize(
        "PlayerDeath.playerPositions",
        playerDeathSystem.playerPositions,
      );
      this.trackCollectionSize(
        "PlayerDeath.playerInventories",
        playerDeathSystem.playerInventories,
      );
      this.trackCollectionSize(
        "PlayerDeath.pendingGravestones",
        playerDeathSystem.pendingGravestones,
      );
      this.trackCollectionSize(
        "PlayerDeath.lastDeathTime",
        playerDeathSystem.lastDeathTime,
      );
    }

    const databaseSystem = getSystem?.("database") as
      | {
          pendingOperations?: Set<unknown>;
          pendingSaveBuffer?: Map<unknown, unknown>;
          pendingInventoryBuffer?: Map<unknown, unknown>;
          inventoryWriteActive?: Map<unknown, unknown>;
          inventoryWriteQueued?: Map<unknown, unknown>;
        }
      | undefined;
    if (databaseSystem) {
      this.trackCollectionSize(
        "Database.pendingOperations",
        databaseSystem.pendingOperations,
      );
      this.trackCollectionSize(
        "Database.pendingSaveBuffer",
        databaseSystem.pendingSaveBuffer,
      );
      this.trackCollectionSize(
        "Database.pendingInventoryBuffer",
        databaseSystem.pendingInventoryBuffer,
      );
      this.trackCollectionSize(
        "Database.inventoryWriteActive",
        databaseSystem.inventoryWriteActive,
      );
      this.trackCollectionSize(
        "Database.inventoryWriteQueued",
        databaseSystem.inventoryWriteQueued,
      );
    }

    const terrainSystem = getSystem?.("terrain") as
      | {
          terrainTiles?: Map<unknown, unknown>;
          pendingTileKeys?: unknown[];
          pendingTileSet?: Set<unknown>;
          pendingCollisionKeys?: unknown[];
          pendingCollisionSet?: Set<unknown>;
          pendingWorkerTiles?: unknown[];
          pendingWorkerResults?: Map<unknown, unknown>;
          pendingResourceInstances?: unknown[];
        }
      | undefined;
    if (terrainSystem) {
      this.trackCollectionSize(
        "Terrain.terrainTiles",
        terrainSystem.terrainTiles,
      );
      this.trackCollectionSize(
        "Terrain.pendingTileKeys",
        terrainSystem.pendingTileKeys,
      );
      this.trackCollectionSize(
        "Terrain.pendingTileSet",
        terrainSystem.pendingTileSet,
      );
      this.trackCollectionSize(
        "Terrain.pendingCollisionKeys",
        terrainSystem.pendingCollisionKeys,
      );
      this.trackCollectionSize(
        "Terrain.pendingCollisionSet",
        terrainSystem.pendingCollisionSet,
      );
      this.trackCollectionSize(
        "Terrain.pendingWorkerTiles",
        terrainSystem.pendingWorkerTiles,
      );
      this.trackCollectionSize(
        "Terrain.pendingWorkerResults",
        terrainSystem.pendingWorkerResults,
      );
      this.trackCollectionSize(
        "Terrain.pendingResourceInstances",
        terrainSystem.pendingResourceInstances,
      );
    }

    // Track ServerNetwork static collections via systemsByName
    const networkSystem = worldRecord.systemsByName?.get("network") as
      | {
          queue?: unknown[];
          constructor?: {
            characterSockets?: Map<string, unknown>;
            agentGoals?: Map<string, unknown>;
            agentThoughts?: Map<string, unknown>;
          };
        }
      | undefined;

    if (networkSystem?.constructor) {
      this.trackCollectionSize("ServerNetwork.queue", networkSystem.queue);
      const ctor = networkSystem.constructor as {
        characterSockets?: Map<string, unknown>;
        agentGoals?: Map<string, unknown>;
        agentThoughts?: Map<string, unknown>;
      };
      this.trackCollectionSize(
        "ServerNetwork.characterSockets",
        ctor.characterSockets,
      );
      this.trackCollectionSize("ServerNetwork.agentGoals", ctor.agentGoals);
      this.trackCollectionSize(
        "ServerNetwork.agentThoughts",
        ctor.agentThoughts,
      );
    }
  }

  /**
   * Helper to track collection size
   */
  private trackCollectionSize(name: string, collection: unknown): void {
    const size = this.getSize(collection);
    if (size === null) return;

    const existing = this.collectionMetrics.get(name);
    const previousSize = existing?.size ?? size;
    const growthRate = size - previousSize;

    this.collectionMetrics.set(name, {
      name,
      size,
      previousSize,
      growthRate,
      initialSize: existing?.initialSize ?? size,
      minSize: Math.min(existing?.minSize ?? size, size),
      maxSize: Math.max(existing?.maxSize ?? size, size),
      samples: (existing?.samples ?? 0) + 1,
    });
  }

  /**
   * Get size of a collection
   */
  private getSize(collection: unknown): number | null {
    if (collection === null || collection === undefined) return null;

    if (collection instanceof Map || collection instanceof Set) {
      return collection.size;
    }

    if (Array.isArray(collection)) {
      return collection.length;
    }

    if (
      typeof collection === "object" &&
      "size" in collection &&
      typeof collection.size === "number"
    ) {
      return collection.size;
    }

    if (
      typeof collection === "object" &&
      "length" in collection &&
      typeof collection.length === "number"
    ) {
      return collection.length;
    }

    return null;
  }

  /**
   * Get current memory statistics
   */
  getStats(): {
    uptime: number;
    currentMemory: MemorySample | null;
    memoryTrend: "stable" | "growing" | "shrinking";
    growthRateMBPerMin: number;
    collectionCount: number;
    leakWarningCount: number;
    recentWarnings: LeakWarning[];
    jscHeapStatsEnabled: boolean;
    currentJSCHeap: JSCHeapSummary | null;
  } {
    const currentMemory = this.samples[this.samples.length - 1] ?? null;
    let memoryTrend: "stable" | "growing" | "shrinking" = "stable";
    let growthRateMBPerMin = 0;

    if (this.samples.length >= 2) {
      growthRateMBPerMin = calculateMemoryGrowthTrend(
        this.samples,
        "heapUsed",
      ).regressionMBPerMin;

      if (growthRateMBPerMin > 1) {
        memoryTrend = "growing";
      } else if (growthRateMBPerMin < -1) {
        memoryTrend = "shrinking";
      }
    }

    // Get recent warnings (last hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentWarnings = this.leakWarnings.filter(
      (w) => w.timestamp > oneHourAgo,
    );

    return {
      uptime: Date.now() - this.startTime,
      currentMemory,
      memoryTrend,
      growthRateMBPerMin,
      collectionCount: this.collectionMetrics.size,
      leakWarningCount: this.leakWarnings.length,
      recentWarnings,
      jscHeapStatsEnabled: this.jscHeapStatsEnabled,
      currentJSCHeap: this.jscHeapSummary,
    };
  }

  /**
   * Get collection metrics
   */
  getCollectionMetrics(): CollectionMetric[] {
    return Array.from(this.collectionMetrics.values()).sort(
      (a, b) => b.size - a.size,
    );
  }

  /**
   * Get memory samples for graphing/analysis
   */
  getSamples(): MemorySample[] {
    return [...this.samples];
  }

  getJSCHeapSummary(): JSCHeapSummary | null {
    return this.jscHeapSummary;
  }

  /**
   * Trigger a manual garbage collection (if available)
   */
  forceGC(): boolean {
    try {
      if (this.bunJSC?.fullGC) {
        this.bunJSC.fullGC();
        this.bunJSC.gcAndSweep?.();
        return true;
      }

      const globalWithBun = globalThis as typeof globalThis & {
        Bun?: { gc?: (force?: boolean) => void };
      };

      if (globalWithBun.Bun?.gc) {
        globalWithBun.Bun.gc(true);
        return true;
      }

      // Try V8's gc() if exposed via --expose-gc
      const globalWithGC = globalThis as typeof globalThis & {
        gc?: () => void;
      };

      if (globalWithGC.gc) {
        globalWithGC.gc();
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Write a V8 heap snapshot to disk for memory profiling
   * Returns the path to the generated snapshot file
   */
  writeHeapSnapshot(directory?: string): string | null {
    try {
      const snapshotDir =
        directory ?? path.join(process.cwd(), "heap-snapshots");

      // Create directory if it doesn't exist
      if (!fs.existsSync(snapshotDir)) {
        fs.mkdirSync(snapshotDir, { recursive: true });
      }

      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `heap-${timestamp}.heapsnapshot`;
      const filepath = path.join(snapshotDir, filename);

      // Write the heap snapshot
      console.log(`[MemoryMonitor] Writing heap snapshot to ${filepath}...`);
      const startTime = Date.now();

      let actualPath = filepath;
      const globalWithBun = globalThis as typeof globalThis & {
        Bun?: {
          generateHeapSnapshot?: (
            format: "v8",
            encoding: "arraybuffer",
          ) => ArrayBuffer;
        };
      };

      if (globalWithBun.Bun?.generateHeapSnapshot) {
        const snapshot = globalWithBun.Bun.generateHeapSnapshot(
          "v8",
          "arraybuffer",
        );
        fs.writeFileSync(filepath, Buffer.from(snapshot));
      } else {
        // v8.writeHeapSnapshot returns the filename
        actualPath = v8.writeHeapSnapshot(filepath);
      }

      const duration = Date.now() - startTime;
      const stats = fs.statSync(actualPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);

      console.log(
        `[MemoryMonitor] Heap snapshot written: ${actualPath} (${sizeMB}MB, took ${duration}ms)`,
      );

      return actualPath;
    } catch (err) {
      console.error("[MemoryMonitor] Failed to write heap snapshot:", err);
      return null;
    }
  }

  /**
   * Get V8 heap statistics for detailed memory analysis
   */
  getHeapStatistics(): v8.HeapInfo {
    return v8.getHeapStatistics();
  }

  /**
   * Get V8 heap space statistics for per-space analysis
   */
  getHeapSpaceStatistics(): v8.HeapSpaceInfo[] {
    return v8.getHeapSpaceStatistics();
  }

  /**
   * Print detailed V8 heap statistics to console
   */
  printHeapStats(): void {
    const heap = this.getHeapStatistics();
    const spaces = this.getHeapSpaceStatistics();
    const MB = 1024 * 1024;

    console.log("\n" + "=".repeat(60));
    console.log("V8 HEAP STATISTICS");
    console.log("=".repeat(60));
    console.log(
      `Total heap size: ${(heap.total_heap_size / MB).toFixed(1)} MB`,
    );
    console.log(
      `Heap size limit: ${(heap.heap_size_limit / MB).toFixed(1)} MB`,
    );
    console.log(`Used heap size: ${(heap.used_heap_size / MB).toFixed(1)} MB`);
    console.log(
      `External memory: ${(heap.external_memory / MB).toFixed(1)} MB`,
    );
    console.log(
      `Malloced memory: ${(heap.malloced_memory / MB).toFixed(1)} MB`,
    );
    console.log(
      `Peak malloced memory: ${(heap.peak_malloced_memory / MB).toFixed(1)} MB`,
    );
    console.log(`Number of native contexts: ${heap.number_of_native_contexts}`);
    console.log(
      `Number of detached contexts: ${heap.number_of_detached_contexts}`,
    );

    console.log("\nHeap Spaces:");
    for (const space of spaces) {
      const used = (space.space_used_size / MB).toFixed(1);
      const size = (space.space_size / MB).toFixed(1);
      const pct = ((space.space_used_size / space.space_size) * 100).toFixed(0);
      console.log(`  ${space.space_name}: ${used}MB / ${size}MB (${pct}%)`);
    }
    console.log("=".repeat(60) + "\n");
  }

  /**
   * Generate a memory report
   */
  generateReport(): string {
    const stats = this.getStats();
    const MB = 1024 * 1024;
    const lines: string[] = [];

    lines.push("=".repeat(60));
    lines.push("MEMORY MONITOR REPORT");
    lines.push("=".repeat(60));
    lines.push(`Uptime: ${(stats.uptime / 1000 / 60).toFixed(1)} minutes`);
    lines.push(`Memory Trend: ${stats.memoryTrend}`);
    lines.push(`Growth Rate: ${stats.growthRateMBPerMin.toFixed(2)} MB/min`);

    if (stats.currentMemory) {
      lines.push("");
      lines.push("Current Memory:");
      lines.push(`  RSS: ${(stats.currentMemory.rss / MB).toFixed(1)} MB`);
      lines.push(
        `  Heap Used: ${(stats.currentMemory.heapUsed / MB).toFixed(1)} MB`,
      );
      lines.push(
        `  Heap Total: ${(stats.currentMemory.heapTotal / MB).toFixed(1)} MB`,
      );
      lines.push(
        `  External: ${(stats.currentMemory.external / MB).toFixed(1)} MB`,
      );
    }

    if (stats.currentJSCHeap) {
      lines.push("");
      lines.push("JSC Heap:");
      lines.push(
        `  Heap Size: ${(stats.currentJSCHeap.heapSize / MB).toFixed(1)} MB`,
      );
      lines.push(
        `  Heap Capacity: ${(stats.currentJSCHeap.heapCapacity / MB).toFixed(1)} MB`,
      );
      lines.push(
        `  Extra Memory: ${(stats.currentJSCHeap.extraMemorySize / MB).toFixed(1)} MB`,
      );
      lines.push(`  Objects: ${stats.currentJSCHeap.objectCount}`);
      lines.push(
        `  Protected Objects: ${stats.currentJSCHeap.protectedObjectCount}`,
      );
      if (stats.currentJSCHeap.growingObjectTypes.length > 0) {
        lines.push("  Fastest Growing Types:");
        for (const metric of stats.currentJSCHeap.growingObjectTypes.slice(
          0,
          8,
        )) {
          lines.push(`    ${metric.name}: ${metric.count} (+${metric.growth})`);
        }
      }
    } else if (!stats.jscHeapStatsEnabled) {
      lines.push("");
      lines.push("JSC Heap: disabled");
    }

    const collections = this.getCollectionMetrics();
    if (collections.length > 0) {
      lines.push("");
      lines.push("Top Collections:");
      for (const metric of collections.slice(0, 10)) {
        const growth =
          metric.growthRate > 0
            ? ` (+${metric.growthRate})`
            : metric.growthRate < 0
              ? ` (${metric.growthRate})`
              : "";
        lines.push(`  ${metric.name}: ${metric.size}${growth}`);
      }
    }

    if (stats.recentWarnings.length > 0) {
      lines.push("");
      lines.push("Recent Leak Warnings:");
      for (const warning of stats.recentWarnings.slice(-5)) {
        lines.push(
          `  [${new Date(warning.timestamp).toISOString()}] ${warning.message}`,
        );
      }
    }

    lines.push("=".repeat(60));

    return lines.join("\n");
  }
}

// Singleton instance for easy access
let globalMonitor: MemoryMonitor | null = null;

/**
 * Get the global memory monitor instance
 */
export function getMemoryMonitor(): MemoryMonitor {
  if (!globalMonitor) {
    globalMonitor = new MemoryMonitor();
  }
  return globalMonitor;
}

/**
 * Initialize and start the global memory monitor
 */
export function startMemoryMonitor(
  world?: World,
  config?: MemoryMonitorConfig,
): MemoryMonitor {
  if (globalMonitor) {
    globalMonitor.stop();
  }

  globalMonitor = new MemoryMonitor(config);
  globalMonitor.start(world);
  return globalMonitor;
}

/**
 * Stop the global memory monitor
 */
export function stopMemoryMonitor(): void {
  if (globalMonitor) {
    globalMonitor.stop();
    globalMonitor = null;
  }
}
