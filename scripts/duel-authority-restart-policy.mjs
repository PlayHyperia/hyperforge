export const MAX_AUTHORITY_RESTART_RECOVERY_MS = 45_000;
export const MAX_AUTHORITY_VIEWER_FAIL_CLOSED_MS = 5_000;
export const MAX_AUTHORITY_VIEWER_RECOVERY_MS = 60_000;

const SOLANA_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DUEL_KEY = /^[0-9a-f]{64}$/;

export function isExpectedAuthorityFaultConsoleIssue(type, text) {
  const normalizedType = String(type || "")
    .trim()
    .toLowerCase();
  const normalizedText = String(text || "").trim();
  if (
    normalizedType === "error" &&
    (/^Failed to load resource: the server responded with a status of 50[234] \(Service Unavailable\)$/.test(
      normalizedText,
    ) ||
      normalizedText === "Failed to load resource: net::ERR_CONNECTION_REFUSED")
  ) {
    return true;
  }
  return (
    normalizedType === "warning" &&
    normalizedText ===
      "[StreamPlayer] HLS error: networkError levelLoadError false"
  );
}

export function isExpectedAuthorityFaultRequestFailure(
  errorText,
  requestUrl,
  hyperiaBaseUrl,
) {
  if (String(errorText || "") !== "net::ERR_CONNECTION_REFUSED") return false;
  try {
    const request = new URL(requestUrl);
    const hyperia = new URL(hyperiaBaseUrl);
    return (
      request.origin === hyperia.origin && request.pathname.startsWith("/live/")
    );
  } catch {
    return false;
  }
}

function requireNonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function normalizeAuthorityIdentity(cycle, label = "duel cycle") {
  const cycleId = requireNonEmptyString(cycle?.cycleId, `${label} cycleId`);
  const duelId = requireNonEmptyString(cycle?.duelId, `${label} duelId`);
  const duelKey = requireNonEmptyString(
    cycle?.duelKeyHex ?? cycle?.duelKey,
    `${label} duelKey`,
  ).toLowerCase();
  if (!DUEL_KEY.test(duelKey)) {
    throw new Error(`${label} duelKey must be 32-byte lowercase hex`);
  }
  return Object.freeze({ cycleId, duelId, duelKey });
}

export function validateOwnedGameServerPidRecord(
  record,
  { expectedLauncherPid, previousGeneration = null } = {},
) {
  const pid = Number(record?.pid);
  const launcherPid = Number(record?.launcherPid);
  const generation = Number(record?.generation);
  const startedAtMs = Number(record?.startedAtMs);
  if (record?.schemaVersion !== 1 || record?.available !== true) {
    throw new Error(
      "game-server PID record is not an available schema-v1 owner",
    );
  }
  for (const [label, value] of [
    ["pid", pid],
    ["launcherPid", launcherPid],
    ["generation", generation],
    ["startedAtMs", startedAtMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`game-server PID record ${label} must be positive`);
    }
  }
  if (
    Number.isSafeInteger(expectedLauncherPid) &&
    launcherPid !== expectedLauncherPid
  ) {
    throw new Error("game-server PID record belongs to another launcher");
  }
  if (
    Number.isSafeInteger(previousGeneration) &&
    generation <= previousGeneration
  ) {
    throw new Error("replacement game-server generation did not advance");
  }
  return Object.freeze({ pid, launcherPid, generation, startedAtMs });
}

export function selectExactActiveSolanaMarket(payload, identity) {
  const expected = normalizeAuthorityIdentity(identity, "expected market");
  const markets = Array.isArray(payload?.markets) ? payload.markets : [];
  const matches = markets.filter(
    (market) =>
      market?.chainKey === "solana" &&
      market?.duelId === expected.duelId &&
      String(market?.duelKey || "").toLowerCase() === expected.duelKey,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one SOL market for ${expected.duelId}; found ${matches.length}`,
    );
  }
  const market = matches[0];
  const marketRef = requireNonEmptyString(market?.marketRef, "marketRef");
  if (!SOLANA_PUBLIC_KEY.test(marketRef)) {
    throw new Error("marketRef is not a canonical Solana public key");
  }
  return Object.freeze({
    duelId: expected.duelId,
    duelKey: expected.duelKey,
    marketRef,
    lifecycleStatus: requireNonEmptyString(
      market?.lifecycleStatus,
      "market lifecycleStatus",
    ),
  });
}

export function validateAuthorityRestartContinuity({
  beforeIdentity,
  afterIdentity,
  beforeMarket,
  afterMarket,
  beforeMarketAccounts,
  afterMarketAccounts,
  recoveryMs,
}) {
  const before = normalizeAuthorityIdentity(beforeIdentity, "before restart");
  const after = normalizeAuthorityIdentity(afterIdentity, "after restart");
  if (
    before.cycleId !== after.cycleId ||
    before.duelId !== after.duelId ||
    before.duelKey !== after.duelKey
  ) {
    throw new Error("authority restart changed the active duel identity");
  }
  if (
    beforeMarket?.duelId !== afterMarket?.duelId ||
    beforeMarket?.duelKey !== afterMarket?.duelKey ||
    beforeMarket?.marketRef !== afterMarket?.marketRef
  ) {
    throw new Error("authority restart changed the canonical SOL market");
  }
  const beforeAccounts = [...new Set(beforeMarketAccounts || [])].sort();
  const afterAccounts = [...new Set(afterMarketAccounts || [])].sort();
  if (
    beforeAccounts.length === 0 ||
    beforeAccounts.join(",") !== afterAccounts.join(",")
  ) {
    throw new Error(
      "authority restart changed the on-chain market account set",
    );
  }
  if (!beforeAccounts.includes(beforeMarket.marketRef)) {
    throw new Error(
      "canonical SOL market is absent from its on-chain account set",
    );
  }
  if (
    !Number.isFinite(recoveryMs) ||
    recoveryMs < 0 ||
    recoveryMs > MAX_AUTHORITY_RESTART_RECOVERY_MS
  ) {
    throw new Error(
      `authority restart recovery exceeded ${MAX_AUTHORITY_RESTART_RECOVERY_MS}ms`,
    );
  }
  return Object.freeze({
    identity: before,
    marketRef: beforeMarket.marketRef,
    marketAccountCount: beforeAccounts.length,
    recoveryMs,
  });
}

export function validateAuthorityViewerContinuity({
  expectedIdentity,
  before,
  unavailable,
  after,
  killedAtMs,
  unavailableAtMs,
  recoveredAtMs,
  maximumFailClosedMs = MAX_AUTHORITY_VIEWER_FAIL_CLOSED_MS,
  maximumRecoveryMs = MAX_AUTHORITY_VIEWER_RECOVERY_MS,
}) {
  const expected = normalizeAuthorityIdentity(
    expectedIdentity,
    "expected viewer authority",
  );
  const requireAuthority = (snapshot, label) => {
    if (!snapshot?.authority || typeof snapshot.authority !== "object") {
      throw new Error(`${label} browser authority is missing`);
    }
    return snapshot.authority;
  };
  const requirePageIdentity = (snapshot, label) => {
    const marker = requireNonEmptyString(snapshot?.marker, `${label} marker`);
    const timeOrigin = Number(snapshot?.timeOrigin);
    const navigationEntries = Number(snapshot?.navigationEntries);
    if (!Number.isFinite(timeOrigin) || timeOrigin <= 0) {
      throw new Error(`${label} browser time origin is invalid`);
    }
    if (!Number.isSafeInteger(navigationEntries) || navigationEntries < 1) {
      throw new Error(`${label} browser navigation count is invalid`);
    }
    return { marker, timeOrigin, navigationEntries };
  };
  const requireVideo = (snapshot, label) => {
    const declaredSource = requireNonEmptyString(
      snapshot?.video?.declaredSource,
      `${label} HLS source`,
    );
    const currentTime = Number(snapshot?.video?.currentTime);
    if (!Number.isFinite(currentTime) || currentTime < 0) {
      throw new Error(`${label} browser video time is invalid`);
    }
    return { declaredSource, currentTime };
  };
  const assertExactAuthority = (authority, label, streamRequired) => {
    if (
      authority.marketDuelId !== expected.duelId ||
      authority.marketDuelKey !== expected.duelKey ||
      (streamRequired &&
        (authority.streamDuelId !== expected.duelId ||
          authority.streamDuelKey !== expected.duelKey)) ||
      (!streamRequired &&
        (authority.streamDuelId !== null || authority.streamDuelKey !== null))
    ) {
      throw new Error(`${label} browser authority changed`);
    }
  };

  const beforeAuthority = requireAuthority(before, "pre-restart");
  const unavailableAuthority = requireAuthority(unavailable, "fail-closed");
  const afterAuthority = requireAuthority(after, "post-restart");
  assertExactAuthority(beforeAuthority, "pre-restart", true);
  assertExactAuthority(unavailableAuthority, "fail-closed", false);
  assertExactAuthority(afterAuthority, "post-restart", true);

  if (
    beforeAuthority.marketCanPlaceBet !== true ||
    unavailableAuthority.marketCanPlaceBet !== false ||
    afterAuthority.marketCanPlaceBet !== true ||
    unavailable?.marketPanelPresent !== true ||
    Number(unavailable?.wagerControlCount) !== 0 ||
    !["stream-disconnected", "stream-stale"].includes(
      unavailableAuthority.marketReason,
    )
  ) {
    throw new Error("authority restart browser did not fail closed safely");
  }

  const beforePage = requirePageIdentity(before, "pre-restart");
  const unavailablePage = requirePageIdentity(unavailable, "fail-closed");
  const afterPage = requirePageIdentity(after, "post-restart");
  for (const field of ["marker", "timeOrigin", "navigationEntries"]) {
    if (
      beforePage[field] !== unavailablePage[field] ||
      beforePage[field] !== afterPage[field]
    ) {
      throw new Error(`authority restart changed browser ${field}`);
    }
  }

  const beforeVideo = requireVideo(before, "pre-restart");
  const afterVideo = requireVideo(after, "post-restart");
  if (
    beforeVideo.declaredSource !== afterVideo.declaredSource ||
    afterVideo.currentTime < beforeVideo.currentTime + 1
  ) {
    throw new Error("authority restart did not retain advancing HLS playback");
  }

  const failClosedMs = Number(unavailableAtMs) - Number(killedAtMs);
  const recoveryMs = Number(recoveredAtMs) - Number(killedAtMs);
  if (
    !Number.isFinite(failClosedMs) ||
    failClosedMs < 0 ||
    failClosedMs > maximumFailClosedMs
  ) {
    throw new Error(
      `authority viewer did not fail closed within ${maximumFailClosedMs}ms`,
    );
  }
  if (
    !Number.isFinite(recoveryMs) ||
    recoveryMs < 0 ||
    recoveryMs > maximumRecoveryMs
  ) {
    throw new Error(
      `authority viewer did not recover within ${maximumRecoveryMs}ms`,
    );
  }

  return Object.freeze({
    identity: expected,
    failClosedMs,
    recoveryMs,
    marker: beforePage.marker,
    timeOrigin: beforePage.timeOrigin,
    navigationEntries: beforePage.navigationEntries,
    hlsSource: beforeVideo.declaredSource,
    videoAdvanceSeconds: Number(
      (afterVideo.currentTime - beforeVideo.currentTime).toFixed(3),
    ),
  });
}
