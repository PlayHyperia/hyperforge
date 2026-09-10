export const DEFAULT_DUEL_PREPARATION_HOST_LEASE_MS = 15_000;
export const DEFAULT_DUEL_PREPARATION_HOST_HEARTBEAT_MS = 3_000;
export const DEFAULT_DUEL_PREPARATION_HOST_CLAIM_GRACE_MS = 10_000;

export const MIN_DUEL_PREPARATION_HOST_LEASE_MS = 5_000;
export const MAX_DUEL_PREPARATION_HOST_LEASE_MS = 60_000;
export const MIN_DUEL_PREPARATION_HOST_HEARTBEAT_MS = 1_000;
export const MIN_DUEL_PREPARATION_HOST_CLAIM_GRACE_MS = 1_000;

export type DuelPreparationHostLeaseConfig = {
  leaseMs: number;
  heartbeatMs: number;
  claimGraceMs: number;
};

const resolveInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
};

/**
 * Resolve the technical failure-detection envelope for private preparation.
 * These values bound process-loss detection only; they are not combat,
 * betting, progression, or economic policy.
 */
export const resolveDuelPreparationHostLeaseConfig = (
  env: NodeJS.ProcessEnv = process.env,
): DuelPreparationHostLeaseConfig => {
  const leaseMs = resolveInteger(
    env,
    "DUEL_PREPARATION_AGENT_HOST_LEASE_MS",
    DEFAULT_DUEL_PREPARATION_HOST_LEASE_MS,
  );
  if (
    leaseMs < MIN_DUEL_PREPARATION_HOST_LEASE_MS ||
    leaseMs > MAX_DUEL_PREPARATION_HOST_LEASE_MS
  ) {
    throw new Error(
      `DUEL_PREPARATION_AGENT_HOST_LEASE_MS must be between ${MIN_DUEL_PREPARATION_HOST_LEASE_MS} and ${MAX_DUEL_PREPARATION_HOST_LEASE_MS}`,
    );
  }

  const heartbeatMs = resolveInteger(
    env,
    "DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS",
    DEFAULT_DUEL_PREPARATION_HOST_HEARTBEAT_MS,
  );
  if (
    heartbeatMs < MIN_DUEL_PREPARATION_HOST_HEARTBEAT_MS ||
    heartbeatMs * 3 > leaseMs
  ) {
    throw new Error(
      "DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS must be at least 1000 and no more than one third of the host lease",
    );
  }

  const claimGraceMs = resolveInteger(
    env,
    "DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS",
    DEFAULT_DUEL_PREPARATION_HOST_CLAIM_GRACE_MS,
  );
  if (
    claimGraceMs < MIN_DUEL_PREPARATION_HOST_CLAIM_GRACE_MS ||
    claimGraceMs > leaseMs
  ) {
    throw new Error(
      "DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS must be at least 1000 and no greater than the host lease",
    );
  }

  return { leaseMs, heartbeatMs, claimGraceMs };
};
