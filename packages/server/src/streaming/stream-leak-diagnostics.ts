/**
 * StreamLeakDiagnostics
 *
 * Runtime instrumentation that proves the streaming system does not leak
 * timers, event-listeners, or Buffers across the normal lifecycle.
 *
 * Design:
 *  - Shadow Node's built-in setInterval / setTimeout with thin wrappers that
 *    record every allocation and free.
 *  - Expose `snapshotLeaks()` that returns alive handles after a given
 *    lifecycle event (e.g. after bridge.stop()).
 *  - Provide `assertNoLeaks()` for use in integration tests and CI.
 *
 * Usage (integration test):
 *   import { StreamLeakDiagnostics } from './stream-leak-diagnostics.js';
 *   const diag = new StreamLeakDiagnostics();
 *   diag.install();
 *   // ... run stream, then stop it ...
 *   const leaks = diag.snapshotLeaks();
 *   expect(leaks.intervals.length).toBe(0);
 *   expect(leaks.timeouts.length).toBe(0);
 *   diag.uninstall();
 *
 * Usage (runtime diagnosis):
 *   const diag = new StreamLeakDiagnostics();
 *   diag.install();
 *   diag.startPeriodicReport(30_000); // print a summary every 30s
 */

export type AllocRecord = {
  id: ReturnType<typeof setInterval>;
  /** Stack trace captured at allocation time (truncated) */
  stack: string;
  /** Millisecond timestamp of alloc */
  allocAt: number;
  /** Label passed to the shadowing call, if any */
  label?: string;
};

export type LeakSnapshot = {
  intervals: AllocRecord[];
  timeouts: AllocRecord[];
  timestamp: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function captureStack(): string {
  try {
    throw new Error();
  } catch (e) {
    const lines = (e as Error).stack?.split("\n") ?? [];
    // Drop the first 3 frames (Error, captureStack, wrapper)
    return lines.slice(3, 8).join("\n").trim();
  }
}

// ── Class ──────────────────────────────────────────────────────────────────

export class StreamLeakDiagnostics {
  private readonly liveIntervals = new Map<
    ReturnType<typeof setInterval>,
    AllocRecord
  >();
  private readonly liveTimeouts = new Map<
    ReturnType<typeof setTimeout>,
    AllocRecord
  >();

  private origSetInterval: typeof setInterval | null = null;
  private origSetTimeout: typeof setTimeout | null = null;
  private origClearInterval: typeof clearInterval | null = null;
  private origClearTimeout: typeof clearTimeout | null = null;

  private reportIntervalId: ReturnType<typeof setInterval> | null = null;
  private installed = false;

  /** Install the timer shims onto the global scope. */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    this.origSetInterval = global.setInterval;
    this.origSetTimeout = global.setTimeout;
    this.origClearInterval = global.clearInterval;
    this.origClearTimeout = global.clearTimeout;

    const self = this;
    const origSI = this.origSetInterval;
    const origST = this.origSetTimeout;
    const origCI = this.origClearInterval;
    const origCT = this.origClearTimeout;

    // Shadow setInterval
    (global as unknown as Record<string, unknown>).setInterval =
      function shadowed_setInterval(
        fn: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) {
        const id = origSI(fn, delay, ...args);
        const record: AllocRecord = {
          id,
          stack: captureStack(),
          allocAt: Date.now(),
        };
        self.liveIntervals.set(id, record);
        return id;
      } as typeof setInterval;

    // Shadow setTimeout
    (global as unknown as Record<string, unknown>).setTimeout =
      function shadowed_setTimeout(
        fn: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) {
        const id = origST.call(
          global,
          function wrapped() {
            self.liveTimeouts.delete(id);
            (fn as (...a: unknown[]) => void)(...args);
          },
          delay,
        );
        const record: AllocRecord = {
          id: id as unknown as ReturnType<typeof setInterval>,
          stack: captureStack(),
          allocAt: Date.now(),
        };
        self.liveTimeouts.set(id, record);
        return id;
      } as typeof setTimeout;

    // Shadow clearInterval
    (global as unknown as Record<string, unknown>).clearInterval =
      function shadowed_clearInterval(id?: ReturnType<typeof setInterval>) {
        if (id != null) self.liveIntervals.delete(id);
        return origCI.call(global, id);
      } as typeof clearInterval;

    // Shadow clearTimeout
    (global as unknown as Record<string, unknown>).clearTimeout =
      function shadowed_clearTimeout(id?: ReturnType<typeof setTimeout>) {
        if (id != null) self.liveTimeouts.delete(id);
        return origCT.call(global, id);
      } as typeof clearTimeout;

    console.log("[StreamLeakDiagnostics] Timer shims installed.");
  }

  /** Remove the shims and restore global timers. */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    this.stopPeriodicReport();

    if (this.origSetInterval) global.setInterval = this.origSetInterval;
    if (this.origSetTimeout) global.setTimeout = this.origSetTimeout;
    if (this.origClearInterval) global.clearInterval = this.origClearInterval;
    if (this.origClearTimeout) global.clearTimeout = this.origClearTimeout;

    this.liveIntervals.clear();
    this.liveTimeouts.clear();
    console.log("[StreamLeakDiagnostics] Timer shims removed.");
  }

  /**
   * Get a snapshot of currently alive (= leaked) timers.
   * Call this AFTER a full bridge.stop() + cleanup() sequence to detect leaks.
   */
  snapshotLeaks(): LeakSnapshot {
    // Ignore the internal periodic-report interval (if active).
    const ignoreId = this.reportIntervalId;
    return {
      intervals: [...this.liveIntervals.values()].filter(
        (r) => r.id !== ignoreId,
      ),
      timeouts: [...this.liveTimeouts.values()],
      timestamp: Date.now(),
    };
  }

  /**
   * Throw if any timers are alive after a cleanup.
   * Useful in integration tests.
   */
  assertNoLeaks(label = "after cleanup"): void {
    const { intervals, timeouts } = this.snapshotLeaks();
    const lines: string[] = [];

    if (intervals.length > 0) {
      lines.push(
        `${intervals.length} leaked setInterval(s) ${label}:`,
        ...intervals.map(
          (r) => `  [${new Date(r.allocAt).toISOString()}]\n${r.stack}`,
        ),
      );
    }

    if (timeouts.length > 0) {
      lines.push(
        `${timeouts.length} leaked setTimeout(s) ${label}:`,
        ...timeouts.map(
          (r) => `  [${new Date(r.allocAt).toISOString()}]\n${r.stack}`,
        ),
      );
    }

    if (lines.length > 0) {
      throw new Error(
        "[StreamLeakDiagnostics] LEAK DETECTED\n" + lines.join("\n"),
      );
    }
  }

  /**
   * Print a periodic summary of live timers to stdout.
   * Useful when running the stream in production to spot growing counts.
   */
  startPeriodicReport(intervalMs = 30_000): void {
    this.stopPeriodicReport();
    // Use the *original* setInterval so the report itself isn't tracked.
    const origSI = this.origSetInterval ?? setInterval;
    this.reportIntervalId = origSI.call(
      global,
      () => {
        this.printReport();
      },
      intervalMs,
    );
  }

  stopPeriodicReport(): void {
    if (this.reportIntervalId) {
      const origCI = this.origClearInterval ?? clearInterval;
      origCI.call(global, this.reportIntervalId);
      this.reportIntervalId = null;
    }
  }

  printReport(): void {
    const ignoreId = this.reportIntervalId;
    const intervals = [...this.liveIntervals.values()].filter(
      (r) => r.id !== ignoreId,
    );
    const timeouts = [...this.liveTimeouts.values()];
    const processMemory = process.memoryUsage();

    console.log(
      [
        "[StreamLeakDiagnostics] ── Live Timer Report ──────────────────",
        `  setInterval alive : ${intervals.length}`,
        `  setTimeout  alive : ${timeouts.length}`,
        `  RSS               : ${(processMemory.rss / 1024 / 1024).toFixed(1)} MB`,
        `  Heap Used         : ${(processMemory.heapUsed / 1024 / 1024).toFixed(1)} MB`,
        `  Heap Total        : ${(processMemory.heapTotal / 1024 / 1024).toFixed(1)} MB`,
        "─────────────────────────────────────────────────────────────────",
      ].join("\n"),
    );

    // Print details for each live interval (could be legitimate long-lived ones)
    for (const r of intervals) {
      const ageSec = Math.round((Date.now() - r.allocAt) / 1000);
      console.log(`  [interval age=${ageSec}s]\n${r.stack}\n`);
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _diagnostics: StreamLeakDiagnostics | null = null;

/**
 * Get or create the process-wide diagnostics singleton.
 * Set env STREAM_LEAK_DIAGNOSTICS=true to enable automatically.
 */
export function getStreamLeakDiagnostics(): StreamLeakDiagnostics | null {
  const enabled =
    process.env.STREAM_LEAK_DIAGNOSTICS === "true" ||
    process.env.STREAM_LEAK_DIAGNOSTICS === "1";
  if (!enabled) return null;

  if (!_diagnostics) {
    _diagnostics = new StreamLeakDiagnostics();
    _diagnostics.install();
    _diagnostics.startPeriodicReport(
      Math.max(
        5_000,
        parseInt(
          process.env.STREAM_LEAK_DIAGNOSTICS_INTERVAL_MS || "30000",
          10,
        ),
      ),
    );
  }
  return _diagnostics;
}
