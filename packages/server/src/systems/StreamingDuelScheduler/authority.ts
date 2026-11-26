import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { World } from "@hyperforge/shared";
import {
  destroyStreamingDuelScheduler,
  getStreamingDuelScheduler,
  initStreamingDuelScheduler,
} from "./index.js";
import { resolveStreamingPreparationDuration } from "./types.js";

export type StreamingDuelSchedulerRole = "authority" | "replica" | "disabled";

export type StreamingDuelAuthorityConfig = {
  role: StreamingDuelSchedulerRole;
  leaseName: string;
  leaseDurationMs: number;
  renewIntervalMs: number;
  acquireRetryMs: number;
};

export type StreamingDuelLease = {
  leaseName: string;
  holderId: string;
  fencingToken: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  ttlMs: number;
};

export interface StreamingDuelLeaseStore {
  acquire(input: {
    leaseName: string;
    holderId: string;
    leaseDurationMs: number;
  }): Promise<StreamingDuelLease | null>;
  renew(input: {
    leaseName: string;
    holderId: string;
    fencingToken: string;
    leaseDurationMs: number;
  }): Promise<StreamingDuelLease | null>;
  release(input: {
    leaseName: string;
    holderId: string;
    fencingToken: string;
  }): Promise<boolean>;
}

export type StreamingDuelAuthoritySnapshot = {
  configured: boolean;
  role: StreamingDuelSchedulerRole;
  verified: boolean;
  schedulerRunning: boolean;
  fencingToken: string | null;
  acquiredAt: number | null;
  renewedAt: number | null;
  expiresAt: number | null;
  lastError: string | null;
};

type SchedulerLifecycle = {
  start: (lease?: StreamingDuelLease) => void | Promise<void>;
  stop: (reason: string) => void | Promise<void>;
  isRunning: () => boolean;
};

type AuthorityControllerOptions = {
  holderId?: string;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onError?: (message: string) => void;
};

const DEFAULT_LEASE_DURATION_MS = 15_000;
const DEFAULT_RENEW_INTERVAL_MS = 5_000;
const DEFAULT_ACQUIRE_RETRY_MS = 1_000;

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function resolveStreamingDuelAuthorityConfig(
  env: NodeJS.ProcessEnv = process.env,
): StreamingDuelAuthorityConfig {
  const configuredRole = env.STREAMING_DUEL_SCHEDULER_ROLE?.trim();
  if (env.NODE_ENV === "production" && !configuredRole) {
    throw new Error("STREAMING_DUEL_SCHEDULER_ROLE is required in production");
  }
  const rawRole = (configuredRole || "authority").trim().toLowerCase();
  if (
    !(["authority", "replica", "disabled"] as const).includes(
      rawRole as StreamingDuelSchedulerRole,
    )
  ) {
    throw new Error(
      "STREAMING_DUEL_SCHEDULER_ROLE must be authority, replica, or disabled",
    );
  }
  if (
    env.NODE_ENV === "production" &&
    rawRole === "authority" &&
    env.STREAMING_DUEL_ENABLED !== "false"
  ) {
    const preparationMs = resolveStreamingPreparationDuration(env);
    if (preparationMs === null) {
      throw new Error(
        "STREAMING_DUEL_PREPARATION_MS is required in production and must be at least 1000",
      );
    }
  }

  const leaseDurationMs = parsePositiveInteger(
    env.STREAMING_DUEL_AUTHORITY_LEASE_MS,
    DEFAULT_LEASE_DURATION_MS,
    "STREAMING_DUEL_AUTHORITY_LEASE_MS",
  );
  const renewIntervalMs = parsePositiveInteger(
    env.STREAMING_DUEL_AUTHORITY_RENEW_MS,
    DEFAULT_RENEW_INTERVAL_MS,
    "STREAMING_DUEL_AUTHORITY_RENEW_MS",
  );
  const acquireRetryMs = parsePositiveInteger(
    env.STREAMING_DUEL_AUTHORITY_RETRY_MS,
    DEFAULT_ACQUIRE_RETRY_MS,
    "STREAMING_DUEL_AUTHORITY_RETRY_MS",
  );

  if (leaseDurationMs < 5_000) {
    throw new Error("STREAMING_DUEL_AUTHORITY_LEASE_MS must be at least 5000");
  }
  if (renewIntervalMs * 2 >= leaseDurationMs) {
    throw new Error(
      "STREAMING_DUEL_AUTHORITY_RENEW_MS must be less than half of the lease duration",
    );
  }

  return {
    role: rawRole as StreamingDuelSchedulerRole,
    leaseName:
      env.STREAMING_DUEL_AUTHORITY_LEASE_NAME?.trim() ||
      "streaming-duel-scheduler",
    leaseDurationMs,
    renewIntervalMs,
    acquireRetryMs,
  };
}

export function validateStreamingDuelProcessTopology(input: {
  nodeEnv: string;
  streamingDuelEnabled: boolean;
  streamCaptureEnabled: boolean;
  authority: StreamingDuelAuthorityConfig;
}): void {
  if (input.nodeEnv !== "production") return;
  if (input.streamingDuelEnabled && input.authority.role === "disabled") {
    throw new Error(
      "STREAMING_DUEL_ENABLED=true cannot use STREAMING_DUEL_SCHEDULER_ROLE=disabled in production",
    );
  }
  if (
    input.streamCaptureEnabled &&
    (!input.streamingDuelEnabled || input.authority.role !== "authority")
  ) {
    throw new Error(
      "STREAMING_CAPTURE_ENABLED=true requires the production scheduler role to be authority",
    );
  }
}

type LeaseRow = {
  leaseName: string;
  holderId: string;
  fencingToken: string;
  acquiredAt: string | number;
  renewedAt: string | number;
  expiresAt: string | number;
  ttlMs: string | number;
};

function mapLeaseRow(row: LeaseRow | undefined): StreamingDuelLease | null {
  if (!row) return null;
  return {
    leaseName: row.leaseName,
    holderId: row.holderId,
    fencingToken: String(row.fencingToken),
    acquiredAt: Number(row.acquiredAt),
    renewedAt: Number(row.renewedAt),
    expiresAt: Number(row.expiresAt),
    ttlMs: Number(row.ttlMs),
  };
}

/** PostgreSQL-backed atomic lease using database time and a durable fencing token. */
export class PostgresStreamingDuelLeaseStore implements StreamingDuelLeaseStore {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async acquire(input: {
    leaseName: string;
    holderId: string;
    leaseDurationMs: number;
  }): Promise<StreamingDuelLease | null> {
    const result = await this.pool.query<LeaseRow>(
      `
        WITH clock AS (
          SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
        ), claimed AS (
          INSERT INTO streaming_scheduler_leases AS current_lease (
            lease_name,
            holder_id,
            fencing_token,
            acquired_at,
            renewed_at,
            expires_at
          )
          SELECT $1, $2, 1, now_ms, now_ms, now_ms + $3::bigint
          FROM clock
          ON CONFLICT (lease_name) DO UPDATE SET
            holder_id = EXCLUDED.holder_id,
            fencing_token = CASE
              WHEN current_lease.holder_id = EXCLUDED.holder_id
                THEN current_lease.fencing_token
              ELSE current_lease.fencing_token + 1
            END,
            acquired_at = CASE
              WHEN current_lease.holder_id = EXCLUDED.holder_id
                THEN current_lease.acquired_at
              ELSE EXCLUDED.acquired_at
            END,
            renewed_at = EXCLUDED.renewed_at,
            expires_at = EXCLUDED.expires_at
          WHERE
            current_lease.holder_id = EXCLUDED.holder_id
            OR current_lease.expires_at <= EXCLUDED.renewed_at
          RETURNING
            lease_name AS "leaseName",
            holder_id AS "holderId",
            fencing_token AS "fencingToken",
            acquired_at AS "acquiredAt",
            renewed_at AS "renewedAt",
            expires_at AS "expiresAt"
        )
        SELECT
          claimed.*,
          GREATEST(claimed."expiresAt" - clock.now_ms, 0)::bigint AS "ttlMs"
        FROM claimed
        JOIN clock ON TRUE
      `,
      [input.leaseName, input.holderId, input.leaseDurationMs],
    );
    const lease = mapLeaseRow(result.rows[0]);
    return lease?.leaseName === input.leaseName &&
      lease.holderId === input.holderId
      ? lease
      : null;
  }

  async renew(input: {
    leaseName: string;
    holderId: string;
    fencingToken: string;
    leaseDurationMs: number;
  }): Promise<StreamingDuelLease | null> {
    const result = await this.pool.query<LeaseRow>(
      `
        WITH clock AS (
          SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
        ), renewed AS (
          UPDATE streaming_scheduler_leases AS current_lease
          SET
            renewed_at = clock.now_ms,
            expires_at = clock.now_ms + $4::bigint
          FROM clock
          WHERE
            current_lease.lease_name = $1
            AND current_lease.holder_id = $2
            AND current_lease.fencing_token = $3::bigint
            AND current_lease.expires_at > clock.now_ms
          RETURNING
            lease_name AS "leaseName",
            holder_id AS "holderId",
            fencing_token AS "fencingToken",
            acquired_at AS "acquiredAt",
            renewed_at AS "renewedAt",
            expires_at AS "expiresAt"
        )
        SELECT
          renewed.*,
          GREATEST(renewed."expiresAt" - clock.now_ms, 0)::bigint AS "ttlMs"
        FROM renewed
        JOIN clock ON TRUE
      `,
      [
        input.leaseName,
        input.holderId,
        input.fencingToken,
        input.leaseDurationMs,
      ],
    );
    const lease = mapLeaseRow(result.rows[0]);
    return lease?.leaseName === input.leaseName &&
      lease.holderId === input.holderId &&
      lease.fencingToken === input.fencingToken
      ? lease
      : null;
  }

  async release(input: {
    leaseName: string;
    holderId: string;
    fencingToken: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
        WITH clock AS (
          SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
        )
        UPDATE streaming_scheduler_leases AS current_lease
        SET
          renewed_at = clock.now_ms,
          expires_at = clock.now_ms
        FROM clock
        WHERE
          current_lease.lease_name = $1
          AND current_lease.holder_id = $2
          AND current_lease.fencing_token = $3::bigint
      `,
      [input.leaseName, input.holderId, input.fencingToken],
    );
    return (result.rowCount ?? 0) === 1;
  }
}

export class StreamingDuelAuthorityController {
  private holderId: string;
  private readonly holderIdPrefix: string;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly onError: (message: string) => void;
  private active = false;
  private lease: StreamingDuelLease | null = null;
  private localDeadline = 0;
  private maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private lastError: string | null = null;

  constructor(
    private readonly config: StreamingDuelAuthorityConfig,
    private readonly store: StreamingDuelLeaseStore,
    private readonly scheduler: SchedulerLifecycle,
    options: AuthorityControllerOptions = {},
  ) {
    this.holderIdPrefix = options.holderId ?? String(process.pid);
    this.holderId =
      options.holderId ?? `${this.holderIdPrefix}-${randomUUID()}`;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.onError = options.onError ?? ((message) => console.error(message));
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    if (this.config.role !== "authority") return;

    await this.enqueueReconcile();
    this.scheduleMaintenance();
  }

  async stop(): Promise<void> {
    if (!this.active && !this.lease) return;
    this.active = false;
    if (this.maintenanceTimer) {
      this.clearTimeoutFn(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    this.clearExpiryTimer();
    await this.operation;

    const lease = this.lease;
    if (this.scheduler.isRunning()) {
      await this.scheduler.stop("scheduler_shutdown");
    }
    this.lease = null;
    this.localDeadline = 0;

    if (lease) {
      try {
        await this.store.release({
          leaseName: lease.leaseName,
          holderId: lease.holderId,
          fencingToken: lease.fencingToken,
        });
      } catch (error) {
        this.recordError("release", error);
      }
    }
  }

  /** Deterministic hook used by tests and operator-triggered diagnostics. */
  async reconcileNow(): Promise<void> {
    await this.enqueueReconcile();
  }

  getSnapshot(): StreamingDuelAuthoritySnapshot {
    const verified =
      this.config.role === "authority" &&
      this.lease !== null &&
      this.scheduler.isRunning() &&
      this.now() < this.localDeadline;
    return {
      configured: this.config.role !== "disabled",
      role: this.config.role,
      verified,
      schedulerRunning: this.scheduler.isRunning(),
      fencingToken: verified ? (this.lease?.fencingToken ?? null) : null,
      acquiredAt: this.lease?.acquiredAt ?? null,
      renewedAt: this.lease?.renewedAt ?? null,
      expiresAt: this.lease?.expiresAt ?? null,
      lastError: this.lastError,
    };
  }

  private enqueueReconcile(): Promise<void> {
    this.operation = this.operation
      .then(() => this.reconcile())
      .catch((error) => {
        this.recordError("reconcile", error);
      });
    return this.operation;
  }

  private async reconcile(): Promise<void> {
    if (!this.active || this.config.role !== "authority") return;

    if (this.lease) {
      const renewingLease = this.lease;
      try {
        const requestStartedAt = this.now();
        const renewed = await this.store.renew({
          leaseName: renewingLease.leaseName,
          holderId: renewingLease.holderId,
          fencingToken: renewingLease.fencingToken,
          leaseDurationMs: this.config.leaseDurationMs,
        });
        // The conservative local deadline can fire while PostgreSQL renewal is
        // in flight. Never let that stale response revive a scheduler that was
        // already hard-fenced and entered terminal cleanup.
        if (this.lease !== renewingLease) return;
        if (!renewed) {
          await this.loseAuthority("lease_renewal_rejected");
          return;
        }
        await this.acceptLease(renewed, requestStartedAt);
        return;
      } catch (error) {
        if (this.lease !== renewingLease) return;
        this.recordError("renew", error);
        await this.loseAuthority("lease_renewal_failed");
        return;
      }
    }

    try {
      const requestStartedAt = this.now();
      const acquired = await this.store.acquire({
        leaseName: this.config.leaseName,
        holderId: this.holderId,
        leaseDurationMs: this.config.leaseDurationMs,
      });
      if (!acquired) return;
      if (!this.active) {
        await this.store.release({
          leaseName: acquired.leaseName,
          holderId: acquired.holderId,
          fencingToken: acquired.fencingToken,
        });
        return;
      }
      if (!(await this.acceptLease(acquired, requestStartedAt))) {
        await this.store.release({
          leaseName: acquired.leaseName,
          holderId: acquired.holderId,
          fencingToken: acquired.fencingToken,
        });
        return;
      }
      try {
        await this.scheduler.start(acquired);
      } catch (error) {
        this.recordError("scheduler_start", error);
        await this.scheduler.stop("scheduler_start_failed");
        this.clearExpiryTimer();
        this.lease = null;
        this.localDeadline = 0;
        this.rotateHolderId();
        await this.store.release({
          leaseName: acquired.leaseName,
          holderId: acquired.holderId,
          fencingToken: acquired.fencingToken,
        });
        return;
      }
      if (this.lease !== acquired) {
        await this.scheduler.stop("lease_lost_during_scheduler_start");
        return;
      }
      if (this.now() >= this.localDeadline) {
        await this.loseAuthority("lease_expired_during_scheduler_start");
        return;
      }
    } catch (error) {
      this.recordError("acquire", error);
    }
  }

  private async acceptLease(
    lease: StreamingDuelLease,
    requestStartedAt: number,
  ): Promise<boolean> {
    // The TTL is measured by PostgreSQL when it commits the claim. Anchoring
    // it at request start (not response receipt) conservatively subtracts all
    // network/query latency and prevents a local overrun past DB expiry.
    const localDeadline = requestStartedAt + lease.ttlMs;
    const remainingMs = localDeadline - this.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      await this.loseAuthority("lease_expired_on_receipt");
      return false;
    }
    this.lease = lease;
    this.localDeadline = localDeadline;
    this.lastError = null;
    this.clearExpiryTimer();
    this.expiryTimer = this.setTimeoutFn(
      () => this.enqueueAuthorityLoss("lease_local_deadline_elapsed"),
      remainingMs,
    );
    this.expiryTimer.unref?.();
    return true;
  }

  private scheduleMaintenance(): void {
    if (!this.active || this.config.role !== "authority") return;
    const delayMs = this.lease
      ? this.config.renewIntervalMs
      : this.config.acquireRetryMs;
    this.maintenanceTimer = this.setTimeoutFn(() => {
      this.maintenanceTimer = null;
      void this.enqueueReconcile().finally(() => this.scheduleMaintenance());
    }, delayMs);
    this.maintenanceTimer.unref?.();
  }

  private enqueueAuthorityLoss(reason: string): void {
    // loseAuthority performs the hard fence synchronously through its first
    // await, while the operation chain prevents a later reacquire/start from
    // overtaking the asynchronous terminal-persistence and custody cleanup.
    const loss = this.loseAuthority(reason);
    this.operation = this.operation
      .then(() => loss)
      .catch((error) => {
        this.recordError("scheduler_stop", error);
      });
  }

  private async loseAuthority(reason: string): Promise<void> {
    this.clearExpiryTimer();
    const shouldStop = this.scheduler.isRunning();
    const hadLease = this.lease !== null;
    this.lease = null;
    this.localDeadline = 0;
    if (!this.lastError) this.lastError = reason;
    // A holder ID is an acquisition-epoch identity. Preserve it across an
    // ambiguous acquire retry, but rotate it after a confirmed owned lease is
    // lost so PostgreSQL increments the durable fencing token before restart.
    if (hadLease) this.rotateHolderId();
    if (shouldStop) await this.scheduler.stop(reason);
  }

  private rotateHolderId(): void {
    this.holderId = `${this.holderIdPrefix}-${randomUUID()}`;
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer) {
      this.clearTimeoutFn(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private recordError(operation: string, error: unknown): void {
    const message = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    this.lastError = message;
    this.onError(`[StreamingDuelAuthority] ${message}`);
  }
}

let authorityController: StreamingDuelAuthorityController | null = null;

export async function initStreamingDuelAuthority(
  world: World,
  pool: pg.Pool,
  config = resolveStreamingDuelAuthorityConfig(),
): Promise<StreamingDuelAuthorityController> {
  if (authorityController) await authorityController.stop();
  const scheduler: SchedulerLifecycle = {
    start: async (lease) => {
      await initStreamingDuelScheduler(world, {
        fencingToken: lease?.fencingToken,
      });
    },
    stop: (reason) => {
      return destroyStreamingDuelScheduler(reason);
    },
    isRunning: () => getStreamingDuelScheduler() !== null,
  };
  authorityController = new StreamingDuelAuthorityController(
    config,
    new PostgresStreamingDuelLeaseStore(pool),
    scheduler,
  );
  await authorityController.start();
  const initialSnapshot = authorityController.getSnapshot();
  if (config.role === "authority" && initialSnapshot.lastError) {
    const startupError = initialSnapshot.lastError;
    await authorityController.stop();
    authorityController = null;
    throw new Error(
      `streaming duel authority could not verify its initial database claim: ${startupError}`,
    );
  }
  return authorityController;
}

export function getStreamingDuelAuthoritySnapshot(): StreamingDuelAuthoritySnapshot {
  return (
    authorityController?.getSnapshot() ?? {
      configured: false,
      role: "disabled",
      verified: false,
      schedulerRunning: getStreamingDuelScheduler() !== null,
      fencingToken: null,
      acquiredAt: null,
      renewedAt: null,
      expiresAt: null,
      lastError: "authority_controller_uninitialized",
    }
  );
}

export async function destroyStreamingDuelAuthority(): Promise<void> {
  const controller = authorityController;
  authorityController = null;
  if (controller) {
    await controller.stop();
  } else {
    await destroyStreamingDuelScheduler("scheduler_shutdown");
  }
}
