export const FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET = Object.freeze({
  lcpMs: 4_000,
  firstDecodedFrameMs: 8_000,
  maxInteractionMs: 350,
  minimumPresentedFps: 24,
  maximumDroppedFrameRatio: 0.01,
  jsHeapUsedBytes: 192 * 1024 * 1024,
  maxLongTaskMs: 250,
  totalLongTaskMs: 1_500,
  taskUtilization: 0.8,
  scriptUtilization: 0.5,
  layoutUtilization: 0.25,
  horizontalOverflowPx: 0,
  nonMediaTransferredBytes: 2 * 1024 * 1024,
  mediaTransferredBytes: 10 * 1024 * 1024,
  mediaSegmentTransferredBytesPerWindow: 64 * 1024 * 1024,
  mediaSegmentEncodedBodyBytesPerWindow: 64 * 1024 * 1024,
  mediaTransferWindowDurationMs: 10_000,
  minimumMediaSegmentResourceCount: 1,
});

export const FULL_TOPOLOGY_BROWSER_PERFORMANCE_PROFILES = Object.freeze({
  desktop_720p: Object.freeze({
    name: "desktop_720p",
    viewport: Object.freeze({ width: 1_280, height: 720 }),
    expectedVideo: Object.freeze({ width: 1_280, height: 720 }),
    cpuThrottlingRate: 2,
    latencyMs: 100,
    downloadBitsPerSecond: 10_000_000,
    uploadBitsPerSecond: 1_000_000,
    connectionType: "wifi",
    sampleDurationMs: 10_000,
  }),
});

export function resolveFullTopologyBrowserPerformanceProfile(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "off") return null;
  const profile = FULL_TOPOLOGY_BROWSER_PERFORMANCE_PROFILES[normalized];
  if (!profile) {
    throw new Error(
      `Unsupported full-topology browser performance profile: ${normalized}`,
    );
  }
  return profile;
}

export function resolveHyperbetAppRuntime(value) {
  const normalized = String(value ?? "development").trim() || "development";
  if (!new Set(["development", "production_preview"]).has(normalized)) {
    throw new Error(
      `Unsupported Hyperbet app runtime: ${normalized}; expected development or production_preview`,
    );
  }
  return normalized;
}

export function resolveHyperbetAppViteMode({
  cluster,
  hasManagedLocalBrowserWallet,
}) {
  const normalizedCluster = String(cluster ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedCluster) {
    throw new Error("Hyperbet Vite mode requires an explicit Solana cluster");
  }
  if (!hasManagedLocalBrowserWallet) return normalizedCluster;
  if (normalizedCluster !== "localnet") {
    throw new Error(
      "Managed browser wallets are restricted to the owned localnet E2E runtime",
    );
  }
  return "e2e";
}

function boundedMetric(failures, name, value, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    failures.push(`${name}=${value} must be within ${minimum}..${maximum}`);
  }
}

export function evaluateFullTopologyBrowserPerformance(metrics) {
  const failures = [];
  if (metrics?.runtime !== "production_preview") {
    failures.push(
      `runtime=${metrics?.runtime ?? "missing"} is not production_preview`,
    );
  }
  if (metrics?.lcpObserverSupported !== true) {
    failures.push("largest-contentful-paint observer is unavailable");
  }
  if (metrics?.longTaskObserverSupported !== true) {
    failures.push("longtask observer is unavailable");
  }
  if (metrics?.resourceTimingObserverSupported !== true) {
    failures.push("resource-transfer observer is unavailable");
  }
  for (const name of [
    "resourceTimingDroppedEntries",
    "resourceTimingInvalidEntries",
    "resourceTimingWindowOverflowCount",
  ]) {
    if (metrics?.[name] !== 0) {
      failures.push(`${name}=${metrics?.[name]} must be zero`);
    }
  }
  if (
    metrics?.mediaTransferWindowDurationMs !==
    FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferWindowDurationMs
  ) {
    failures.push(
      "media transfer observation window does not match the fixed 10-second profile",
    );
  }
  if (metrics?.documentContinuityVerified !== true) {
    failures.push("browser document changed during the verified workflow");
  }
  boundedMetric(
    failures,
    "resourceSampleDurationMs",
    metrics?.resourceSampleDurationMs,
    FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferWindowDurationMs,
    Number.MAX_SAFE_INTEGER,
  );
  boundedMetric(
    failures,
    "lcpMs",
    metrics?.lcpMs,
    Number.EPSILON,
    FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.lcpMs,
  );
  boundedMetric(
    failures,
    "firstDecodedFrameMs",
    metrics?.firstDecodedFrameMs,
    Number.EPSILON,
    FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.firstDecodedFrameMs,
  );
  boundedMetric(
    failures,
    "maxInteractionMs",
    metrics?.maxInteractionMs,
    Number.EPSILON,
    FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.maxInteractionMs,
  );
  for (const name of ["presentedFps", "qualityPresentedFps"]) {
    const value = metrics?.[name];
    if (
      !Number.isFinite(value) ||
      value < FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps
    ) {
      failures.push(
        `${name}=${value} is below ${FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumPresentedFps}`,
      );
    }
  }
  for (const [name, minimum, maximum] of [
    [
      "droppedFrameRatio",
      0,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.maximumDroppedFrameRatio,
    ],
    [
      "jsHeapUsedBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.jsHeapUsedBytes,
    ],
    [
      "maxLongTaskMs",
      0,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.maxLongTaskMs,
    ],
    [
      "totalLongTaskMs",
      0,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.totalLongTaskMs,
    ],
    [
      "taskUtilization",
      0,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.taskUtilization,
    ],
    [
      "scriptUtilization",
      0,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.scriptUtilization,
    ],
    [
      "layoutUtilization",
      0,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.layoutUtilization,
    ],
    [
      "horizontalOverflowPx",
      0,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.horizontalOverflowPx,
    ],
    [
      "nonMediaTransferredBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.nonMediaTransferredBytes,
    ],
    [
      "mediaTransferredBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes,
    ],
    [
      "maximumRollingMediaTransferredBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaTransferredBytes,
    ],
    [
      "startupMediaSegmentTransferredBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentTransferredBytesPerWindow,
    ],
    [
      "startupMediaSegmentEncodedBodyBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentEncodedBodyBytesPerWindow,
    ],
    [
      "sampleMediaSegmentTransferredBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentTransferredBytesPerWindow,
    ],
    [
      "sampleMediaSegmentEncodedBodyBytes",
      Number.EPSILON,
      FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.mediaSegmentEncodedBodyBytesPerWindow,
    ],
  ]) {
    boundedMetric(failures, name, metrics?.[name], minimum, maximum);
  }
  for (const name of [
    "startupMediaSegmentResourceCount",
    "sampleMediaSegmentResourceCount",
  ]) {
    if (
      !Number.isSafeInteger(metrics?.[name]) ||
      metrics[name] <
        FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumMediaSegmentResourceCount
    ) {
      failures.push(
        `${name}=${metrics?.[name]} is below ${FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET.minimumMediaSegmentResourceCount}`,
      );
    }
  }
  return failures;
}
