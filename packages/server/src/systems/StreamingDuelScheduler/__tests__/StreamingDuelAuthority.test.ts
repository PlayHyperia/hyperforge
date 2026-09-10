import { afterEach, describe, expect, it, vi } from "vitest";
import { DataType, newDb } from "pg-mem";
import {
  PostgresStreamingDuelLeaseStore,
  StreamingDuelAuthorityController,
  initStreamingDuelAuthority,
  resolveStreamingDuelAuthorityConfig,
  validateStreamingDuelProcessTopology,
  type StreamingDuelAuthorityConfig,
  type StreamingDuelLease,
  type StreamingDuelLeaseStore,
} from "../authority.js";

class FakeLeaseStore implements StreamingDuelLeaseStore {
  now = 1_000;
  row: StreamingDuelLease | null = null;
  rejectRenewFor = new Set<string>();
  throwAcquire = false;

  async acquire(input: {
    leaseName: string;
    holderId: string;
    leaseDurationMs: number;
  }): Promise<StreamingDuelLease | null> {
    if (this.throwAcquire) throw new Error("database unavailable");
    const canClaim =
      this.row === null ||
      this.row.holderId === input.holderId ||
      this.row.expiresAt <= this.now;
    if (!canClaim) return null;

    const sameHolder = this.row?.holderId === input.holderId;
    const token = sameHolder
      ? this.row!.fencingToken
      : String(BigInt(this.row?.fencingToken ?? "0") + 1n);
    this.row = {
      leaseName: input.leaseName,
      holderId: input.holderId,
      fencingToken: token,
      acquiredAt: sameHolder ? this.row!.acquiredAt : this.now,
      renewedAt: this.now,
      expiresAt: this.now + input.leaseDurationMs,
      ttlMs: input.leaseDurationMs,
    };
    return { ...this.row };
  }

  async renew(input: {
    leaseName: string;
    holderId: string;
    fencingToken: string;
    leaseDurationMs: number;
  }): Promise<StreamingDuelLease | null> {
    if (this.rejectRenewFor.has(input.holderId)) return null;
    if (
      !this.row ||
      this.row.leaseName !== input.leaseName ||
      this.row.holderId !== input.holderId ||
      this.row.fencingToken !== input.fencingToken ||
      this.row.expiresAt <= this.now
    ) {
      return null;
    }
    this.row = {
      ...this.row,
      renewedAt: this.now,
      expiresAt: this.now + input.leaseDurationMs,
      ttlMs: input.leaseDurationMs,
    };
    return { ...this.row };
  }

  async release(input: {
    leaseName: string;
    holderId: string;
    fencingToken: string;
  }): Promise<boolean> {
    if (
      !this.row ||
      this.row.leaseName !== input.leaseName ||
      this.row.holderId !== input.holderId ||
      this.row.fencingToken !== input.fencingToken
    ) {
      return false;
    }
    this.row = {
      ...this.row,
      renewedAt: this.now,
      expiresAt: this.now,
      ttlMs: 0,
    };
    return true;
  }
}

function config(
  overrides: Partial<StreamingDuelAuthorityConfig> = {},
): StreamingDuelAuthorityConfig {
  return {
    role: "authority",
    leaseName: "streaming-duel-scheduler",
    leaseDurationMs: 15_000,
    renewIntervalMs: 5_000,
    acquireRetryMs: 1_000,
    ...overrides,
  };
}

function scheduler() {
  let running = false;
  const starts: number[] = [];
  const stops: string[] = [];
  return {
    lifecycle: {
      start: () => {
        running = true;
        starts.push(starts.length + 1);
      },
      stop: (reason: string) => {
        running = false;
        stops.push(reason);
      },
      isRunning: () => running,
    },
    starts,
    stops,
  };
}

function inertTimers() {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    setTimeoutFn: ((callback: () => void) => {
      callbacks.push(callback);
      return { unref: () => undefined };
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => undefined) as typeof clearTimeout,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streaming duel scheduler authority", () => {
  it("allows only one scheduler and hands off after teardown with a higher fence", async () => {
    const store = new FakeLeaseStore();
    const firstScheduler = scheduler();
    const secondScheduler = scheduler();
    const firstTimers = inertTimers();
    const secondTimers = inertTimers();
    const first = new StreamingDuelAuthorityController(
      config(),
      store,
      firstScheduler.lifecycle,
      {
        holderId: "authority-a",
        now: () => store.now,
        ...firstTimers,
      },
    );
    const second = new StreamingDuelAuthorityController(
      config(),
      store,
      secondScheduler.lifecycle,
      {
        holderId: "authority-b",
        now: () => store.now,
        ...secondTimers,
      },
    );

    await first.start();
    await second.start();
    expect(first.getSnapshot()).toMatchObject({
      verified: true,
      fencingToken: "1",
    });
    expect(second.getSnapshot().verified).toBe(false);
    expect(firstScheduler.starts).toHaveLength(1);
    expect(secondScheduler.starts).toHaveLength(0);

    await first.stop();
    expect(firstScheduler.stops).toEqual(["scheduler_shutdown"]);
    await second.reconcileNow();
    expect(second.getSnapshot()).toMatchObject({
      verified: true,
      fencingToken: "2",
    });
    expect(secondScheduler.starts).toHaveLength(1);
    await second.stop();
  });

  it("tears down immediately on renewal rejection and waits for expiry before standby takeover", async () => {
    const store = new FakeLeaseStore();
    const firstScheduler = scheduler();
    const secondScheduler = scheduler();
    const first = new StreamingDuelAuthorityController(
      config(),
      store,
      firstScheduler.lifecycle,
      {
        holderId: "authority-a",
        now: () => store.now,
        ...inertTimers(),
      },
    );
    const second = new StreamingDuelAuthorityController(
      config(),
      store,
      secondScheduler.lifecycle,
      {
        holderId: "authority-b",
        now: () => store.now,
        ...inertTimers(),
      },
    );

    await first.start();
    await second.start();
    store.rejectRenewFor.add("authority-a");
    await first.reconcileNow();
    expect(first.getSnapshot().verified).toBe(false);
    expect(firstScheduler.stops).toEqual(["lease_renewal_rejected"]);

    await second.reconcileNow();
    expect(second.getSnapshot().verified).toBe(false);
    store.now = 16_001;
    await second.reconcileNow();
    expect(second.getSnapshot()).toMatchObject({
      verified: true,
      fencingToken: "2",
    });
    await first.stop();
    await second.stop();
  });

  it("hard-fences the local scheduler when its conservative deadline elapses", async () => {
    const store = new FakeLeaseStore();
    const ownedScheduler = scheduler();
    const timers = inertTimers();
    const controller = new StreamingDuelAuthorityController(
      config(),
      store,
      ownedScheduler.lifecycle,
      {
        holderId: "authority-a",
        now: () => store.now,
        ...timers,
      },
    );

    await controller.start();
    expect(controller.getSnapshot().verified).toBe(true);
    // acceptLease installs the hard-expiry timer before start() installs the
    // maintenance timer.
    store.now = 16_000;
    timers.callbacks[0]?.();
    expect(controller.getSnapshot().verified).toBe(false);
    expect(ownedScheduler.stops).toEqual(["lease_local_deadline_elapsed"]);
    await controller.stop();
  });

  it("does not reacquire until asynchronous terminal cleanup finishes", async () => {
    const store = new FakeLeaseStore();
    const timers = inertTimers();
    const cleanupStarted = deferred();
    const allowCleanup = deferred();
    let running = false;
    const starts: string[] = [];
    const stops: string[] = [];
    const controller = new StreamingDuelAuthorityController(
      config(),
      store,
      {
        start: async (lease) => {
          running = true;
          starts.push(lease?.fencingToken ?? "missing");
        },
        stop: async (reason) => {
          running = false;
          stops.push(reason);
          cleanupStarted.resolve();
          await allowCleanup.promise;
        },
        isRunning: () => running,
      },
      {
        holderId: "authority-a",
        now: () => store.now,
        ...timers,
      },
    );

    await controller.start();
    expect(starts).toEqual(["1"]);

    store.now = 16_000;
    timers.callbacks[0]?.();
    await cleanupStarted.promise;
    expect(controller.getSnapshot()).toMatchObject({
      verified: false,
      schedulerRunning: false,
    });
    expect(stops).toEqual(["lease_local_deadline_elapsed"]);

    const reacquire = controller.reconcileNow();
    await Promise.resolve();
    expect(starts).toEqual(["1"]);

    allowCleanup.resolve();
    await reacquire;
    expect(starts).toEqual(["1", "2"]);
    expect(controller.getSnapshot()).toMatchObject({
      verified: true,
      fencingToken: "2",
    });
    await controller.stop();
  });

  it("does not let a stale renewal response revive an expired scheduler", async () => {
    const store = new FakeLeaseStore();
    const timers = inertTimers();
    const ownedScheduler = scheduler();
    const controller = new StreamingDuelAuthorityController(
      config(),
      store,
      ownedScheduler.lifecycle,
      {
        holderId: "authority-a",
        now: () => store.now,
        ...timers,
      },
    );

    await controller.start();
    const renewalStarted = deferred();
    const renewalResponse = deferred<StreamingDuelLease | null>();
    store.renew = async () => {
      renewalStarted.resolve();
      return renewalResponse.promise;
    };

    const renewal = controller.reconcileNow();
    await renewalStarted.promise;
    store.now = 16_000;
    timers.callbacks[0]?.();
    expect(controller.getSnapshot()).toMatchObject({
      verified: false,
      schedulerRunning: false,
    });
    expect(ownedScheduler.stops).toEqual(["lease_local_deadline_elapsed"]);

    renewalResponse.resolve({
      leaseName: "streaming-duel-scheduler",
      holderId: "authority-a",
      fencingToken: "1",
      acquiredAt: 1_000,
      renewedAt: 16_000,
      expiresAt: 31_000,
      ttlMs: 15_000,
    });
    await renewal;

    expect(controller.getSnapshot()).toMatchObject({
      verified: false,
      schedulerRunning: false,
      fencingToken: null,
    });
    expect(ownedScheduler.starts).toHaveLength(1);
    await controller.stop();
  });

  it("tears down a scheduler whose authority expires while startup is pending", async () => {
    const store = new FakeLeaseStore();
    const timers = inertTimers();
    const startupEntered = deferred();
    const allowStartup = deferred();
    let running = false;
    const stops: string[] = [];
    const controller = new StreamingDuelAuthorityController(
      config(),
      store,
      {
        start: async () => {
          startupEntered.resolve();
          await allowStartup.promise;
          running = true;
        },
        stop: async (reason) => {
          running = false;
          stops.push(reason);
        },
        isRunning: () => running,
      },
      {
        holderId: "authority-a",
        now: () => store.now,
        ...timers,
      },
    );

    const startup = controller.start();
    await startupEntered.promise;
    store.now = 16_000;
    timers.callbacks[0]?.();
    allowStartup.resolve();
    await startup;

    expect(controller.getSnapshot()).toMatchObject({
      verified: false,
      schedulerRunning: false,
      fencingToken: null,
    });
    expect(stops).toEqual(["lease_lost_during_scheduler_start"]);
    await controller.stop();
  });

  it("subtracts acquisition latency instead of extending authority past database expiry", async () => {
    const store = new FakeLeaseStore();
    const acquire = store.acquire.bind(store);
    store.acquire = async (input) => {
      const lease = await acquire(input);
      store.now += 15_000;
      return lease;
    };
    const ownedScheduler = scheduler();
    const controller = new StreamingDuelAuthorityController(
      config(),
      store,
      ownedScheduler.lifecycle,
      {
        holderId: "authority-a",
        now: () => store.now,
        ...inertTimers(),
      },
    );

    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      verified: false,
      schedulerRunning: false,
    });
    expect(ownedScheduler.starts).toHaveLength(0);
    await controller.stop();
  });

  it("fails closed when PostgreSQL cannot confirm acquisition", async () => {
    const store = new FakeLeaseStore();
    store.throwAcquire = true;
    const ownedScheduler = scheduler();
    const errors: string[] = [];
    const controller = new StreamingDuelAuthorityController(
      config(),
      store,
      ownedScheduler.lifecycle,
      {
        holderId: "authority-a",
        now: () => store.now,
        onError: (message) => errors.push(message),
        ...inertTimers(),
      },
    );

    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      verified: false,
      schedulerRunning: false,
      lastError: "acquire: database unavailable",
    });
    expect(ownedScheduler.starts).toHaveLength(0);
    expect(errors).toHaveLength(1);
    await controller.stop();
  });

  it("validates authority timing and process-role configuration", () => {
    expect(resolveStreamingDuelAuthorityConfig({})).toEqual({
      role: "authority",
      leaseName: "streaming-duel-scheduler",
      leaseDurationMs: 15_000,
      renewIntervalMs: 5_000,
      acquireRetryMs: 1_000,
    });
    expect(
      resolveStreamingDuelAuthorityConfig({
        STREAMING_DUEL_SCHEDULER_ROLE: "replica",
      }).role,
    ).toBe("replica");
    expect(() =>
      resolveStreamingDuelAuthorityConfig({ NODE_ENV: "production" }),
    ).toThrow(/required in production/);
    expect(() =>
      resolveStreamingDuelAuthorityConfig({
        NODE_ENV: "production",
        STREAMING_DUEL_SCHEDULER_ROLE: "authority",
      }),
    ).toThrow(/STREAMING_DUEL_PREPARATION_MS is required/);
    expect(
      resolveStreamingDuelAuthorityConfig({
        NODE_ENV: "production",
        STREAMING_DUEL_SCHEDULER_ROLE: "authority",
        STREAMING_DUEL_PREPARATION_MS: "60000",
      }).role,
    ).toBe("authority");
    expect(() =>
      resolveStreamingDuelAuthorityConfig({
        NODE_ENV: "production",
        STREAMING_DUEL_SCHEDULER_ROLE: "authority",
        STREAMING_DUEL_PREPARATION_MS: "60000ms",
      }),
    ).toThrow(/base-10 integer/);
    expect(
      resolveStreamingDuelAuthorityConfig({
        NODE_ENV: "production",
        STREAMING_DUEL_SCHEDULER_ROLE: "replica",
      }).role,
    ).toBe("replica");
    expect(() =>
      resolveStreamingDuelAuthorityConfig({
        STREAMING_DUEL_SCHEDULER_ROLE: "both",
      }),
    ).toThrow(/authority, replica, or disabled/);
    expect(() =>
      resolveStreamingDuelAuthorityConfig({
        STREAMING_DUEL_AUTHORITY_LEASE_MS: "5000",
        STREAMING_DUEL_AUTHORITY_RENEW_MS: "2500",
      }),
    ).toThrow(/less than half/);
  });

  it("fails contradictory production role and capture topology before startup", () => {
    const authority = config();
    expect(() =>
      validateStreamingDuelProcessTopology({
        nodeEnv: "production",
        streamingDuelEnabled: true,
        streamCaptureEnabled: true,
        authority,
      }),
    ).not.toThrow();
    expect(() =>
      validateStreamingDuelProcessTopology({
        nodeEnv: "production",
        streamingDuelEnabled: true,
        streamCaptureEnabled: true,
        authority: { ...authority, role: "replica" },
      }),
    ).toThrow(/capture.*authority/i);
    expect(() =>
      validateStreamingDuelProcessTopology({
        nodeEnv: "production",
        streamingDuelEnabled: true,
        streamCaptureEnabled: false,
        authority: { ...authority, role: "disabled" },
      }),
    ).toThrow(/cannot use.*disabled/i);
    expect(() =>
      validateStreamingDuelProcessTopology({
        nodeEnv: "development",
        streamingDuelEnabled: false,
        streamCaptureEnabled: true,
        authority: { ...authority, role: "disabled" },
      }),
    ).not.toThrow();
  });

  it("uses parameterized PostgreSQL claims, renewals, and releases", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            leaseName: "streaming-duel-scheduler",
            holderId: "authority-a",
            fencingToken: "7",
            acquiredAt: "1000",
            renewedAt: "1000",
            expiresAt: "16000",
            ttlMs: "15000",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            leaseName: "streaming-duel-scheduler",
            holderId: "authority-a",
            fencingToken: "7",
            acquiredAt: "1000",
            renewedAt: "6000",
            expiresAt: "21000",
            ttlMs: "15000",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const store = new PostgresStreamingDuelLeaseStore({ query } as never);

    const acquired = await store.acquire({
      leaseName: "streaming-duel-scheduler",
      holderId: "authority-a",
      leaseDurationMs: 15_000,
    });
    expect(acquired).toMatchObject({ fencingToken: "7", ttlMs: 15_000 });
    await store.renew({
      leaseName: "streaming-duel-scheduler",
      holderId: "authority-a",
      fencingToken: "7",
      leaseDurationMs: 15_000,
    });
    await expect(
      store.release({
        leaseName: "streaming-duel-scheduler",
        holderId: "authority-a",
        fencingToken: "7",
      }),
    ).resolves.toBe(true);

    expect(query.mock.calls[0]?.[1]).toEqual([
      "streaming-duel-scheduler",
      "authority-a",
      15_000,
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "streaming-duel-scheduler",
      "authority-a",
      "7",
      15_000,
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      "streaming-duel-scheduler",
      "authority-a",
      "7",
    ]);
    expect(query.mock.calls[0]?.[0]).toContain(
      "ON CONFLICT (lease_name) DO UPDATE",
    );
    expect(query.mock.calls[1]?.[0]).toContain(
      "current_lease.expires_at > clock.now_ms",
    );
  });

  it("executes the atomic claim against a PostgreSQL-compatible engine", async () => {
    const memoryDb = newDb();
    memoryDb.public.registerFunction({
      name: "clock_timestamp",
      returns: DataType.timestamptz,
      implementation: () => new Date(),
    });
    memoryDb.public.none(`
      CREATE TABLE streaming_scheduler_leases (
        lease_name text PRIMARY KEY NOT NULL,
        holder_id text NOT NULL,
        fencing_token bigint DEFAULT 1 NOT NULL,
        acquired_at bigint NOT NULL,
        renewed_at bigint NOT NULL,
        expires_at bigint NOT NULL
      )
    `);
    const { Pool } = memoryDb.adapters.createPg();
    const pool = new Pool();
    const store = new PostgresStreamingDuelLeaseStore(pool as never);

    const first = await store.acquire({
      leaseName: "streaming-duel-scheduler",
      holderId: "authority-a",
      leaseDurationMs: 15_000,
    });
    const blocked = await store.acquire({
      leaseName: "streaming-duel-scheduler",
      holderId: "authority-b",
      leaseDurationMs: 15_000,
    });

    expect(first).toMatchObject({
      holderId: "authority-a",
      fencingToken: "1",
    });
    expect(first?.ttlMs).toBeGreaterThan(14_000);
    expect(blocked).toBeNull();
    await pool.end();
  });

  it("keeps the startup entrypoint fail-closed on an initial lease-store error", async () => {
    const query = vi.fn().mockRejectedValue(new Error("lease table missing"));
    await expect(
      initStreamingDuelAuthority({} as never, { query } as never, config()),
    ).rejects.toThrow(
      /could not verify its initial database claim: acquire: lease table missing/,
    );
  });
});
