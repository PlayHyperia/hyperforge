import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCaptureSupervisorUnavailableStatus,
  hasHlsManifestAdvanced,
  hasVerifiedBrowserMatchPresentation,
  parseListenerPids,
  parseProcessSnapshot,
  redactWarmRendererUrl,
  validateCaptureFailClosedLatency,
  validateCaptureRestartTarget,
  validateMarketAuthorityRetention,
  validateWarmRendererRetention,
} from "./duel-capture-restart-policy.mjs";

test("builds an immediate allowlisted fail-closed supervisor status", () => {
  const status = buildCaptureSupervisorUnavailableStatus(12_345);
  assert.deepEqual(status.rendererHealth, {
    ready: false,
    degradedReason: "capture_process_exited",
    updatedAt: 12_345,
    phase: null,
    diagnostics: null,
  });
  assert.equal(status.stats.ffmpegRunning, false);
  assert.equal(status.stats.clientConnected, false);
  assert.equal(status.updatedAt, 12_345);
  assert.throws(
    () => buildCaptureSupervisorUnavailableStatus(Number.NaN),
    /timestamp is invalid/,
  );
});

test("bounds fail-closed latency and retains one market authority", () => {
  assert.deepEqual(
    validateCaptureFailClosedLatency({
      killedAt: 10_000,
      apiObservedAt: 10_500,
      browserObservedAt: 11_000,
      maximumMs: 2_000,
    }),
    { maximumMs: 2_000, apiLatencyMs: 500, browserLatencyMs: 1_000 },
  );
  assert.throws(
    () =>
      validateCaptureFailClosedLatency({
        killedAt: 10_000,
        apiObservedAt: 10_500,
        browserObservedAt: 12_001,
        maximumMs: 2_000,
      }),
    /did not fail closed/,
  );

  const duelId = "duel-1";
  const duelKey = "ab".repeat(32);
  const healthy = {
    authority: {
      streamDuelId: duelId,
      streamDuelKey: duelKey,
      marketDuelId: duelId,
      marketDuelKey: duelKey,
      marketCanPlaceBet: true,
    },
  };
  const unavailable = {
    authority: {
      streamDuelId: null,
      streamDuelKey: null,
      marketDuelId: duelId,
      marketDuelKey: duelKey,
      marketCanPlaceBet: false,
    },
  };
  assert.deepEqual(
    validateMarketAuthorityRetention(healthy, unavailable, healthy),
    { duelId, duelKey, retained: true },
  );
  assert.throws(
    () =>
      validateMarketAuthorityRetention(healthy, unavailable, {
        authority: { ...healthy.authority, marketDuelId: "duel-2" },
      }),
    /authority changed/,
  );
});

const PROCESS_SNAPSHOT = `
100 100 node scripts/smoke-duel-launch.mjs
200 200 bun scripts/duel-stack.mjs
300 300 bun run --cwd packages/server stream:rtmp
301 300 bun packages/server/scripts/stream-to-rtmp.ts
302 300 ffmpeg -i pipe:0
400 400 node scripts/verify-duel-stream-recovery.mjs
`;

const DIRECT_PROCESS_SNAPSHOT = `
100 100 node scripts/smoke-duel-launch.mjs
200 200 bun scripts/duel-stack.mjs
300 300 /opt/hyperia/node --import tsx packages/server/scripts/stream-to-rtmp.ts
301 300 ffmpeg -i pipe:0
400 400 node scripts/verify-duel-stream-recovery.mjs
`;

test("parses unique listener and process-group identities", () => {
  assert.deepEqual(parseListenerPids("301\n301\n"), [301]);
  assert.deepEqual(parseProcessSnapshot(PROCESS_SNAPSHOT)[3], {
    pid: 301,
    groupId: 300,
    command: "bun packages/server/scripts/stream-to-rtmp.ts",
  });
});

test("accepts only the isolated capture worker group", () => {
  assert.deepEqual(
    validateCaptureRestartTarget({
      capturePort: 35554,
      listenerPids: [301],
      processSnapshot: parseProcessSnapshot(PROCESS_SNAPSHOT),
      verifierPid: 400,
    }),
    {
      capturePort: 35554,
      listenerPid: 301,
      groupId: 300,
      leaderPid: 300,
      memberPids: [300, 301, 302],
    },
  );
  assert.deepEqual(
    validateCaptureRestartTarget({
      capturePort: 35554,
      listenerPids: [],
      processSnapshot: parseProcessSnapshot(PROCESS_SNAPSHOT),
      verifierPid: 400,
    }),
    {
      capturePort: 35554,
      listenerPid: null,
      groupId: 300,
      leaderPid: 300,
      memberPids: [300, 301, 302],
    },
  );
});

test("accepts the supervised direct TypeScript capture worker", () => {
  assert.deepEqual(
    validateCaptureRestartTarget({
      capturePort: 35554,
      listenerPids: [300],
      processSnapshot: parseProcessSnapshot(DIRECT_PROCESS_SNAPSHOT),
      verifierPid: 400,
    }),
    {
      capturePort: 35554,
      listenerPid: 300,
      groupId: 300,
      leaderPid: 300,
      memberPids: [300, 301],
    },
  );
});

test("detects the first newly appended HLS segment before playlist rollover", () => {
  const before = {
    mediaSequence: 100,
    segmentCount: 19,
    lastSegment: "stream-118.ts",
    lastProgramDateTimeMs: 10_000,
  };
  assert.equal(
    hasHlsManifestAdvanced(before, {
      mediaSequence: 100,
      segmentCount: 20,
      lastSegment: "stream-119.ts",
      lastProgramDateTimeMs: 12_000,
    }),
    true,
  );
  assert.equal(
    hasHlsManifestAdvanced(before, {
      mediaSequence: 101,
      segmentCount: 19,
      lastSegment: "stream-119.ts",
      lastProgramDateTimeMs: 12_000,
    }),
    true,
  );
  assert.equal(hasHlsManifestAdvanced(before, { ...before }), false);
  assert.equal(
    hasHlsManifestAdvanced(before, {
      mediaSequence: 100,
      segmentCount: 20,
      lastSegment: "stream-119.ts",
      lastProgramDateTimeMs: 9_000,
    }),
    false,
  );
});

test("accepts only the exact retained warm page and navigation epoch", () => {
  const before = {
    targetId: "page-target-1",
    marker: "recovery-marker-1",
    pageUrlSha256: "a".repeat(64),
    pageUrlRedacted: "http://127.0.0.1:35553/stream.html?streamFps=30",
    timeOrigin: 123_456,
    navigationEntries: 1,
    hasCanvas: true,
    rendererReady: true,
  };
  assert.deepEqual(validateWarmRendererRetention(before, { ...before }), {
    before: {
      targetId: before.targetId,
      marker: before.marker,
      pageUrlSha256: before.pageUrlSha256,
      pageUrlRedacted: before.pageUrlRedacted,
      timeOrigin: before.timeOrigin,
      navigationEntries: before.navigationEntries,
    },
    after: {
      targetId: before.targetId,
      marker: before.marker,
      pageUrlSha256: before.pageUrlSha256,
      pageUrlRedacted: before.pageUrlRedacted,
      timeOrigin: before.timeOrigin,
      navigationEntries: before.navigationEntries,
    },
    retained: true,
  });
  assert.throws(
    () =>
      validateWarmRendererRetention(before, {
        ...before,
        timeOrigin: before.timeOrigin + 1,
      }),
    /timeOrigin changed/,
  );
  assert.throws(
    () =>
      validateWarmRendererRetention(before, {
        ...before,
        rendererReady: false,
      }),
    /not healthy/,
  );
});

test("retains a useful warm page URL without capture credentials", () => {
  assert.equal(
    redactWarmRendererUrl(
      "http://viewer:password@127.0.0.1:35553/stream.html?streamFps=30&accessToken=query-secret#streamToken=fragment-secret",
    ),
    "http://127.0.0.1:35553/stream.html?streamFps=30&accessToken=%5Bredacted%5D",
  );
});

test("accepts either two spectator fighters or one identity-bound market panel", () => {
  assert.equal(
    hasVerifiedBrowserMatchPresentation({ fighterCardCount: 2 }),
    true,
  );
  const marketState = {
    fighterCardCount: 0,
    marketPanelPresent: true,
    marketPanelText: "Astra Vale 0.010 SOL Riven Ash 0.010 SOL Betting locked",
    authority: {
      streamDuelId: "duel-1",
      streamDuelKey: "ab".repeat(32),
      marketDuelId: "duel-1",
      marketDuelKey: "ab".repeat(32),
    },
  };
  assert.equal(
    hasVerifiedBrowserMatchPresentation(marketState, [
      "Astra Vale",
      "Riven Ash",
    ]),
    true,
  );
  assert.equal(
    hasVerifiedBrowserMatchPresentation(
      {
        ...marketState,
        authority: { ...marketState.authority, marketDuelId: "duel-2" },
      },
      ["Astra Vale", "Riven Ash"],
    ),
    false,
  );
  assert.equal(
    hasVerifiedBrowserMatchPresentation(marketState, [
      "Astra Vale",
      "Different Agent",
    ]),
    false,
  );
});

test("rejects ambiguous listeners, shared groups, and launcher ownership", () => {
  const snapshot = parseProcessSnapshot(PROCESS_SNAPSHOT);
  assert.throws(
    () =>
      validateCaptureRestartTarget({
        capturePort: 35554,
        listenerPids: [301, 302],
        processSnapshot: snapshot,
        verifierPid: 400,
      }),
    /at most one listener/,
  );
  assert.throws(
    () =>
      validateCaptureRestartTarget({
        capturePort: 35554,
        listenerPids: [301],
        processSnapshot: snapshot.map((entry) =>
          entry.pid === 400 ? { ...entry, groupId: 300 } : entry,
        ),
        verifierPid: 400,
      }),
    /shares the verifier process group/,
  );
  assert.throws(
    () =>
      validateCaptureRestartTarget({
        capturePort: 35554,
        listenerPids: [301],
        processSnapshot: snapshot.map((entry) =>
          entry.pid === 300
            ? { ...entry, command: `${entry.command} scripts/duel-stack.mjs` }
            : entry,
        ),
        verifierPid: 400,
      }),
    /forbidden owner duel-stack\.mjs/,
  );
  assert.throws(
    () =>
      validateCaptureRestartTarget({
        capturePort: 35554,
        listenerPids: [],
        processSnapshot: [
          ...snapshot,
          {
            pid: 500,
            groupId: 500,
            command: "bun run --cwd packages/server stream:rtmp",
          },
        ],
        verifierPid: 400,
      }),
    /exactly one server stream worker process group; found 2/,
  );
});
