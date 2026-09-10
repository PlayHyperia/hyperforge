import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateFullTopologyBrowserPerformance,
  FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET,
  resolveFullTopologyBrowserPerformanceProfile,
  resolveHyperbetAppViteMode,
  resolveHyperbetAppRuntime,
} from "./duel-full-topology-browser-performance-policy.mjs";

for (const scenario of [
  {
    name: "skipped betting",
    args: [
      "--skip-betting",
      "--hyperbet-api-url",
      "http://127.0.0.1:1",
      "--hls-url",
      "http://127.0.0.1:1/live/stream.m3u8",
    ],
    message: /Browser performance qualification requires betting verification/u,
  },
  {
    name: "missing Hyperbet API",
    args: ["--hls-url", "http://127.0.0.1:1/live/stream.m3u8"],
    message:
      /Browser performance qualification requires a valid hyperbet-api-url/u,
  },
  {
    name: "missing HLS URL",
    args: ["--hyperbet-api-url", "http://127.0.0.1:1"],
    message: /Browser performance qualification requires a valid hls-url/u,
  },
  {
    name: "blank HLS URL",
    args: ["--hyperbet-api-url", "http://127.0.0.1:1", "--hls-url", "  "],
    message: /Browser performance qualification requires a valid hls-url/u,
  },
  {
    name: "malformed betting URL",
    args: [
      "--betting-url",
      "not-a-url",
      "--hyperbet-api-url",
      "http://127.0.0.1:1",
      "--hls-url",
      "http://127.0.0.1:1/live/stream.m3u8",
    ],
    message: /Browser performance qualification requires a valid betting-url/u,
  },
  {
    name: "non-HTTP HLS URL",
    args: [
      "--hyperbet-api-url",
      "http://127.0.0.1:1",
      "--hls-url",
      "file:///invalid/stream.m3u8",
    ],
    message: /Browser performance qualification requires a valid hls-url/u,
  },
  {
    name: "skipped streaming",
    args: ["--skip-stream"],
    message: /Browser performance qualification requires the HLS stream/u,
  },
  {
    name: "development runtime",
    args: ["--hyperbet-app-runtime", "development"],
    message:
      /Browser performance qualification requires a production_preview Hyperbet app/u,
  },
  {
    name: "requested read-only browser proof without an API",
    args: ["--browser-performance-profile", "off", "--hyperbet-read-only"],
    message:
      /Requested Hyperbet browser verification requires enabled betting and a Hyperbet API endpoint/u,
  },
  {
    name: "requested local transaction proof with betting skipped",
    args: [
      "--browser-performance-profile",
      "off",
      "--hyperbet-local-transactions",
      "--skip-betting",
      "--hyperbet-api-url",
      "http://127.0.0.1:1",
      "--solana-rpc-url",
      "http://127.0.0.1:1",
      "--duel-market-program-id",
      "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
      "--expected-local-wallet",
      "7zqeyet8qNvAPLXwaHziGXqh1dGVJMSKvAD3RHTdYQyg",
    ],
    message:
      /Requested Hyperbet browser verification requires enabled betting and a Hyperbet API endpoint/u,
  },
]) {
  test(`actual verifier rejects ${scenario.name} before attempting readiness`, () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./verify-duel-stack.mjs", import.meta.url)),
        "--browser-performance-profile",
        "desktop_720p",
        "--hyperbet-app-runtime",
        "production_preview",
        "--server-url",
        "http://127.0.0.1:1",
        "--client-url",
        "http://127.0.0.1:1",
        "--betting-url",
        "http://127.0.0.1:1",
        ...scenario.args,
      ],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(
      result.error,
      undefined,
      "invalid qualification options must exit without waiting for readiness",
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, scenario.message);
    assert.equal(
      result.stdout,
      "",
      "preflight must reject before readiness logging or polling",
    );
  });
}

function passingMetrics() {
  return {
    runtime: "production_preview",
    lcpObserverSupported: true,
    longTaskObserverSupported: true,
    resourceTimingObserverSupported: true,
    resourceTimingDroppedEntries: 0,
    resourceTimingInvalidEntries: 0,
    resourceTimingWindowOverflowCount: 0,
    documentContinuityVerified: true,
    resourceSampleDurationMs: 10_000,
    mediaTransferWindowDurationMs:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferWindowDurationMs,
    lcpMs: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.lcpMs,
    firstDecodedFrameMs:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.firstDecodedFrameMs,
    maxInteractionMs: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.maxInteractionMs,
    presentedFps: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps,
    qualityPresentedFps:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps,
    droppedFrameRatio:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.maximumDroppedFrameRatio,
    jsHeapUsedBytes: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.jsHeapUsedBytes,
    maxLongTaskMs: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.maxLongTaskMs,
    totalLongTaskMs: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.totalLongTaskMs,
    taskUtilization: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.taskUtilization,
    scriptUtilization:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.scriptUtilization,
    layoutUtilization:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.layoutUtilization,
    horizontalOverflowPx:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.horizontalOverflowPx,
    nonMediaTransferredBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.nonMediaTransferredBytes,
    mediaTransferredBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes,
    maximumRollingMediaTransferredBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes,
    startupMediaSegmentTransferredBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentTransferredBytesPerWindow,
    startupMediaSegmentEncodedBodyBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentEncodedBodyBytesPerWindow,
    startupMediaSegmentResourceCount:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumMediaSegmentResourceCount,
    sampleMediaSegmentTransferredBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentTransferredBytesPerWindow,
    sampleMediaSegmentEncodedBodyBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentEncodedBodyBytesPerWindow,
    sampleMediaSegmentResourceCount:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumMediaSegmentResourceCount,
  };
}

test("resolves only the explicit production performance profile", () => {
  assert.equal(resolveFullTopologyBrowserPerformanceProfile("off"), null);
  assert.equal(
    resolveFullTopologyBrowserPerformanceProfile("desktop_720p").name,
    "desktop_720p",
  );
  assert.throws(
    () => resolveFullTopologyBrowserPerformanceProfile("mobile_guess"),
    /Unsupported full-topology browser performance profile/u,
  );
});

test("accepts only development and compiled-preview Hyperbet runtimes", () => {
  assert.equal(resolveHyperbetAppRuntime(""), "development");
  assert.equal(
    resolveHyperbetAppRuntime("production_preview"),
    "production_preview",
  );
  assert.throws(() => resolveHyperbetAppRuntime("production"), /Unsupported/u);
});

test("uses the wallet-enabled E2E mode only for an owned localnet browser wallet", () => {
  assert.equal(
    resolveHyperbetAppViteMode({
      cluster: "localnet",
      hasManagedLocalBrowserWallet: true,
    }),
    "e2e",
  );
  assert.equal(
    resolveHyperbetAppViteMode({
      cluster: "localnet",
      hasManagedLocalBrowserWallet: false,
    }),
    "localnet",
  );
  assert.equal(
    resolveHyperbetAppViteMode({
      cluster: "devnet",
      hasManagedLocalBrowserWallet: false,
    }),
    "devnet",
  );
  assert.throws(
    () =>
      resolveHyperbetAppViteMode({
        cluster: "devnet",
        hasManagedLocalBrowserWallet: true,
      }),
    /restricted to the owned localnet E2E runtime/u,
  );
  assert.throws(
    () =>
      resolveHyperbetAppViteMode({
        cluster: "",
        hasManagedLocalBrowserWallet: false,
      }),
    /explicit Solana cluster/u,
  );
});

test("accepts every co-load budget at its exact boundary", () => {
  assert.deepEqual(
    evaluateFullTopologyBrowserPerformance(passingMetrics()),
    [],
  );
});

test("reports every malformed or over-budget co-load measurement", () => {
  const metrics = passingMetrics();
  const failures = evaluateFullTopologyBrowserPerformance({
    ...metrics,
    runtime: "development",
    lcpObserverSupported: false,
    longTaskObserverSupported: false,
    resourceTimingObserverSupported: false,
    resourceTimingDroppedEntries: 1,
    resourceTimingInvalidEntries: 1,
    resourceTimingWindowOverflowCount: 1,
    documentContinuityVerified: false,
    resourceSampleDurationMs: 9_999,
    mediaTransferWindowDurationMs: 9_999,
    lcpMs: 0,
    firstDecodedFrameMs: Number.NaN,
    maxInteractionMs: metrics.maxInteractionMs + 1,
    presentedFps: metrics.presentedFps - 0.01,
    qualityPresentedFps: metrics.qualityPresentedFps - 0.01,
    droppedFrameRatio: metrics.droppedFrameRatio + 0.001,
    jsHeapUsedBytes: metrics.jsHeapUsedBytes + 1,
    maxLongTaskMs: metrics.maxLongTaskMs + 1,
    totalLongTaskMs: metrics.totalLongTaskMs + 1,
    taskUtilization: metrics.taskUtilization + 0.01,
    scriptUtilization: metrics.scriptUtilization + 0.01,
    layoutUtilization: metrics.layoutUtilization + 0.01,
    horizontalOverflowPx: 1,
    nonMediaTransferredBytes: metrics.nonMediaTransferredBytes + 1,
    mediaTransferredBytes: metrics.mediaTransferredBytes + 1,
    maximumRollingMediaTransferredBytes:
      metrics.maximumRollingMediaTransferredBytes + 1,
    startupMediaSegmentTransferredBytes:
      metrics.startupMediaSegmentTransferredBytes + 1,
    startupMediaSegmentEncodedBodyBytes:
      metrics.startupMediaSegmentEncodedBodyBytes + 1,
    startupMediaSegmentResourceCount: 0,
    sampleMediaSegmentTransferredBytes:
      metrics.sampleMediaSegmentTransferredBytes + 1,
    sampleMediaSegmentEncodedBodyBytes:
      metrics.sampleMediaSegmentEncodedBodyBytes + 1,
    sampleMediaSegmentResourceCount: 0,
  });

  assert.equal(failures.length, 32);
  assert.match(failures.join("\n"), /runtime=development/u);
  assert.match(failures.join("\n"), /presentedFps/u);
  assert.match(failures.join("\n"), /horizontalOverflowPx/u);
});

test("missing, lost, or zero transfer evidence cannot pass as smooth buffered playback", () => {
  for (const patch of [
    { resourceTimingObserverSupported: undefined },
    { resourceTimingDroppedEntries: undefined },
    { resourceTimingInvalidEntries: undefined },
    { mediaTransferredBytes: 0 },
    { resourceTimingWindowOverflowCount: undefined },
    { documentContinuityVerified: undefined },
    { resourceSampleDurationMs: undefined },
    { maximumRollingMediaTransferredBytes: undefined },
    { mediaTransferWindowDurationMs: undefined },
    { startupMediaSegmentTransferredBytes: 0 },
    { startupMediaSegmentEncodedBodyBytes: 0 },
    { startupMediaSegmentResourceCount: 0 },
    { sampleMediaSegmentTransferredBytes: 0 },
    { sampleMediaSegmentEncodedBodyBytes: 0 },
    { sampleMediaSegmentResourceCount: 0 },
  ]) {
    assert.ok(
      evaluateFullTopologyBrowserPerformance({ ...passingMetrics(), ...patch })
        .length > 0,
    );
  }
});

test("an earlier rolling-window burst fails even when the final ten-second sample is under budget", () => {
  const failures = evaluateFullTopologyBrowserPerformance({
    ...passingMetrics(),
    mediaTransferredBytes: 1,
    maximumRollingMediaTransferredBytes:
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes + 1,
  });
  assert.deepEqual(failures, [
    `maximumRollingMediaTransferredBytes=${FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes + 1} must be within ${Number.EPSILON}..${FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes}`,
  ]);
});
