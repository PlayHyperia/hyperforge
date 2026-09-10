import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_AUTHORITY_RESTART_RECOVERY_MS,
  MAX_AUTHORITY_VIEWER_FAIL_CLOSED_MS,
  isExpectedAuthorityFaultConsoleIssue,
  isExpectedAuthorityFaultRequestFailure,
  normalizeAuthorityIdentity,
  selectExactActiveSolanaMarket,
  validateAuthorityRestartContinuity,
  validateAuthorityViewerContinuity,
  validateOwnedGameServerPidRecord,
} from "./duel-authority-restart-policy.mjs";

const identity = {
  cycleId: "cycle-a",
  duelId: "streaming-cycle-a",
  duelKeyHex: "ab".repeat(32),
};
const marketRef = "11111111111111111111111111111111";

test("allowlists only bounded fault-window browser transport noise", () => {
  assert.equal(
    isExpectedAuthorityFaultConsoleIssue(
      "error",
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    ),
    true,
  );
  assert.equal(
    isExpectedAuthorityFaultConsoleIssue(
      "warning",
      "[StreamPlayer] HLS error: networkError levelLoadError false",
    ),
    true,
  );
  assert.equal(
    isExpectedAuthorityFaultConsoleIssue("error", "Uncaught TypeError"),
    false,
  );
  assert.equal(
    isExpectedAuthorityFaultRequestFailure(
      "net::ERR_CONNECTION_REFUSED",
      "http://127.0.0.1:35551/live/stream.m3u8?t=1",
      "http://127.0.0.1:35551",
    ),
    true,
  );
  assert.equal(
    isExpectedAuthorityFaultRequestFailure(
      "net::ERR_CONNECTION_REFUSED",
      "http://127.0.0.1:35557/api/wallets",
      "http://127.0.0.1:35551",
    ),
    false,
  );
});

test("normalizes the exact persisted duel identity", () => {
  assert.deepEqual(normalizeAuthorityIdentity(identity), {
    cycleId: "cycle-a",
    duelId: "streaming-cycle-a",
    duelKey: "ab".repeat(32),
  });
  assert.throws(
    () => normalizeAuthorityIdentity({ ...identity, duelKeyHex: "wrong" }),
    /32-byte lowercase hex/,
  );
});

test("accepts only an owned, advancing game-server PID generation", () => {
  assert.deepEqual(
    validateOwnedGameServerPidRecord(
      {
        schemaVersion: 1,
        available: true,
        pid: 22,
        launcherPid: 11,
        generation: 2,
        startedAtMs: 1_000,
      },
      { expectedLauncherPid: 11, previousGeneration: 1 },
    ),
    { pid: 22, launcherPid: 11, generation: 2, startedAtMs: 1_000 },
  );
  assert.throws(
    () =>
      validateOwnedGameServerPidRecord(
        {
          schemaVersion: 1,
          available: true,
          pid: 22,
          launcherPid: 12,
          generation: 2,
          startedAtMs: 1_000,
        },
        { expectedLauncherPid: 11 },
      ),
    /another launcher/,
  );
  assert.throws(
    () =>
      validateOwnedGameServerPidRecord(
        {
          schemaVersion: 1,
          available: true,
          pid: 22,
          launcherPid: 11,
          generation: 1,
          startedAtMs: 1_000,
        },
        { expectedLauncherPid: 11, previousGeneration: 1 },
      ),
    /did not advance/,
  );
});

test("selects exactly one SOL market for the active duel", () => {
  const selected = selectExactActiveSolanaMarket(
    {
      markets: [
        {
          chainKey: "solana",
          duelId: identity.duelId,
          duelKey: identity.duelKeyHex,
          marketRef,
          lifecycleStatus: "OPEN",
        },
      ],
    },
    identity,
  );
  assert.equal(selected.marketRef, marketRef);
  assert.throws(
    () =>
      selectExactActiveSolanaMarket(
        {
          markets: [
            {
              chainKey: "solana",
              duelId: identity.duelId,
              duelKey: identity.duelKeyHex,
              marketRef,
              lifecycleStatus: "OPEN",
            },
            {
              chainKey: "solana",
              duelId: identity.duelId,
              duelKey: identity.duelKeyHex,
              marketRef,
              lifecycleStatus: "OPEN",
            },
          ],
        },
        identity,
      ),
    /exactly one SOL market/,
  );
});

test("proves identity, market, and account-set continuity within the bound", () => {
  const market = {
    duelId: identity.duelId,
    duelKey: identity.duelKeyHex,
    marketRef,
  };
  assert.deepEqual(
    validateAuthorityRestartContinuity({
      beforeIdentity: identity,
      afterIdentity: { ...identity, duelKey: identity.duelKeyHex },
      beforeMarket: market,
      afterMarket: market,
      beforeMarketAccounts: [
        marketRef,
        "SysvarRent111111111111111111111111111111111",
      ],
      afterMarketAccounts: [
        "SysvarRent111111111111111111111111111111111",
        marketRef,
      ],
      recoveryMs: 15_000,
    }),
    {
      identity: {
        cycleId: identity.cycleId,
        duelId: identity.duelId,
        duelKey: identity.duelKeyHex,
      },
      marketRef,
      marketAccountCount: 2,
      recoveryMs: 15_000,
    },
  );
  assert.throws(
    () =>
      validateAuthorityRestartContinuity({
        beforeIdentity: identity,
        afterIdentity: { ...identity, cycleId: "cycle-b" },
        beforeMarket: market,
        afterMarket: market,
        beforeMarketAccounts: [marketRef],
        afterMarketAccounts: [marketRef],
        recoveryMs: 15_000,
      }),
    /changed the active duel identity/,
  );
  assert.throws(
    () =>
      validateAuthorityRestartContinuity({
        beforeIdentity: identity,
        afterIdentity: identity,
        beforeMarket: market,
        afterMarket: market,
        beforeMarketAccounts: [marketRef],
        afterMarketAccounts: [
          marketRef,
          "SysvarRent111111111111111111111111111111111",
        ],
        recoveryMs: 15_000,
      }),
    /changed the on-chain market account set/,
  );
  assert.throws(
    () =>
      validateAuthorityRestartContinuity({
        beforeIdentity: identity,
        afterIdentity: identity,
        beforeMarket: market,
        afterMarket: market,
        beforeMarketAccounts: [marketRef],
        afterMarketAccounts: [marketRef],
        recoveryMs: MAX_AUTHORITY_RESTART_RECOVERY_MS + 1,
      }),
    /recovery exceeded/,
  );
});

test("requires one retained viewer to fail closed and recover on the exact duel", () => {
  const browser = {
    marker: "viewer-1",
    timeOrigin: 10_000,
    navigationEntries: 1,
    marketPanelPresent: true,
    wagerControlCount: 4,
    video: {
      declaredSource: "http://127.0.0.1:35551/live/stream.m3u8",
      currentTime: 20,
    },
    authority: {
      streamDuelId: identity.duelId,
      streamDuelKey: identity.duelKeyHex,
      marketDuelId: identity.duelId,
      marketDuelKey: identity.duelKeyHex,
      marketCanPlaceBet: true,
      marketReason: "market-open",
    },
  };
  const unavailable = {
    ...browser,
    wagerControlCount: 0,
    authority: {
      ...browser.authority,
      streamDuelId: null,
      streamDuelKey: null,
      marketCanPlaceBet: false,
      marketReason: "stream-disconnected",
    },
  };
  const recovered = {
    ...browser,
    video: { ...browser.video, currentTime: 23.25 },
  };

  assert.deepEqual(
    validateAuthorityViewerContinuity({
      expectedIdentity: identity,
      before: browser,
      unavailable,
      after: recovered,
      killedAtMs: 20_000,
      unavailableAtMs: 20_750,
      recoveredAtMs: 48_000,
    }),
    {
      identity: {
        cycleId: identity.cycleId,
        duelId: identity.duelId,
        duelKey: identity.duelKeyHex,
      },
      failClosedMs: 750,
      recoveryMs: 28_000,
      marker: "viewer-1",
      timeOrigin: 10_000,
      navigationEntries: 1,
      hlsSource: "http://127.0.0.1:35551/live/stream.m3u8",
      videoAdvanceSeconds: 3.25,
    },
  );
  assert.throws(
    () =>
      validateAuthorityViewerContinuity({
        expectedIdentity: identity,
        before: browser,
        unavailable: {
          ...unavailable,
          wagerControlCount: 1,
        },
        after: recovered,
        killedAtMs: 20_000,
        unavailableAtMs: 20_750,
        recoveredAtMs: 48_000,
      }),
    /did not fail closed safely/,
  );
  assert.throws(
    () =>
      validateAuthorityViewerContinuity({
        expectedIdentity: identity,
        before: browser,
        unavailable,
        after: { ...recovered, timeOrigin: 10_001 },
        killedAtMs: 20_000,
        unavailableAtMs: 20_000 + MAX_AUTHORITY_VIEWER_FAIL_CLOSED_MS + 1,
        recoveredAtMs: 48_000,
      }),
    /changed browser timeOrigin/,
  );
});
