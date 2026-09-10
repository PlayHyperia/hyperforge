import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  bindDuelSmokeStreamCredential,
  buildDuelSmokeLauncherArgs,
  buildDuelSmokeMotionCombatArgs,
  describeDuelSmokePortAvailabilityError,
  describeDuelSmokeLauncherShutdownFailure,
  resolveDuelSmokeFailure,
  getCompleteRetainedLiveMediaEvidence,
  getHealthyBrowserAudioEvidence,
  resolveDuelSmokeMotionStreamUrl,
  resolveDuelSmokeMotionStartupTimeoutSeconds,
  resolveDuelSmokeReviewFrameTimestamps,
  resolveDuelSmokeCaptureBrowserEnvironment,
  resolveDuelSmokeMaterializedSourceAttestation,
  validateDuelSmokeLaunchDeadlines,
  validateDuelSmokeCombatProfile,
  validateHyperbetLiveFightObservation,
  validateDuelSmokeLiveEvidenceProfile,
  validateDuelSmokeReviewFrameEvidence,
} from "./duel-launch-smoke-policy.mjs";

const ports = Object.freeze({
  server: 35551,
  websocket: 35552,
  client: 35553,
  capture: 35554,
  postgres: 35555,
  spectator: 35556,
  hyperbetApi: 35557,
  hyperbetApp: 35558,
  captureBrowser: 35559,
  solanaRpc: 35800,
});

test("requires a clean nested-launcher shutdown, not just eventual process absence", () => {
  assert.equal(
    describeDuelSmokeLauncherShutdownFailure({ exitCode: 0, signalCode: null }),
    null,
  );
  for (const result of [
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: "SIGTERM" },
    { exitCode: null, signalCode: null },
    { exitCode: 0, signalCode: null, forcedKill: true },
  ]) {
    assert.equal(
      typeof describeDuelSmokeLauncherShutdownFailure(result),
      "string",
    );
  }
  const source = readFileSync(
    new URL("./smoke-duel-launch.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /launcherShutdownPolicy\.totalGraceMs \+ 3_000/u);
  assert.match(
    source,
    /resolveDuelSmokeFailure\(\{\s*runError,\s*launcherShutdownFailure,\s*cleanupErrors,\s*forbiddenRuntimeDiagnostics,/u,
  );
});

test("preserves primary, launcher, every cleanup and every runtime failure in order", () => {
  const primary = new Error("primary soak failed");
  const cleanup = new Error("owned port remains");
  const error = resolveDuelSmokeFailure({
    runError: primary,
    launcherShutdownFailure: "launcher barrier failed",
    cleanupErrors: [cleanup, "owned volume remains"],
    forbiddenRuntimeDiagnostics: [
      {
        code: "betting-feed-poll-failed",
        stream: "stderr",
        line: "keeper feed unavailable",
      },
      { code: "capture-failed", stream: "stdout", line: "capture diagnostic" },
    ],
  });
  assert(error instanceof AggregateError);
  assert.equal(error.errors.length, 6);
  assert.equal(error.errors[0], primary);
  assert.equal(error.errors[2], cleanup);
  assert.deepEqual(
    error.errors.map((failure) => failure.message),
    [
      "primary soak failed",
      "launcher barrier failed",
      "owned port remains",
      "owned volume remains",
      "Duel smoke observed forbidden betting-feed-poll-failed diagnostic on stderr: keeper feed unavailable",
      "Duel smoke observed forbidden capture-failed diagnostic on stdout: capture diagnostic",
    ],
  );
  assert.match(
    error.message,
    /^Duel smoke failed:\n- \[run\] primary soak failed\n- \[launcher-shutdown\]/u,
  );
  assert.match(error.message, /\[runtime\].*capture diagnostic$/u);
});

test("does not invent a failure when all run and cleanup evidence is clean", () => {
  assert.equal(resolveDuelSmokeFailure(), null);
  assert.equal(
    resolveDuelSmokeFailure({
      runError: null,
      launcherShutdownFailure: null,
      cleanupErrors: [],
      forbiddenRuntimeDiagnostics: [],
    }),
    null,
  );
});

test("retains each individual failure category, including non-Error thrown values", () => {
  for (const [input, expected] of [
    [{ runError: new Error("original run") }, "[run] original run"],
    [{ runError: "non-Error rejection" }, "[run] non-Error rejection"],
    [
      { launcherShutdownFailure: "unclean launcher" },
      "[launcher-shutdown] unclean launcher",
    ],
    [
      { cleanupErrors: [new Error("cleanup failure")] },
      "[cleanup] cleanup failure",
    ],
    [
      {
        forbiddenRuntimeDiagnostics: [
          { code: "feed", stream: "stderr", line: "bad state" },
        ],
      },
      "[runtime] Duel smoke observed forbidden feed diagnostic on stderr: bad state",
    ],
  ]) {
    const error = resolveDuelSmokeFailure(input);
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.message, `Duel smoke failed:\n- ${expected}`);
  }
});

test("final smoke cleanup collects failures before aggregated reporting without masking the primary", () => {
  const source = readFileSync(
    new URL("./smoke-duel-launch.mjs", import.meta.url),
    "utf8",
  );
  const final = source.slice(
    source.indexOf("    runError = error;"),
    source.indexOf(
      '  if (!passed) throw new Error("Duel smoke did not reach the online boundary")',
    ),
  );
  assert.match(
    final,
    /finally \{\s*try \{\s*await cleanupOnce\(\);\s*\} catch \(error\) \{\s*cleanupErrors\.push\(error\)/u,
  );
  assert.match(
    final,
    /for \(const \[name, port\] of ownedPortEntries\) \{\s*try \{\s*await assertPortAvailable\(name, port\);\s*\} catch \(error\) \{\s*cleanupErrors\.push\(error\)/u,
  );
  assert.match(final, /Duel smoke leaked container/u);
  assert.match(final, /Duel smoke leaked volume/u);
  assert.match(final, /if \(failure\) throw failure/u);
  assert.doesNotMatch(final, /assertNoForbiddenRuntimeDiagnostics\(\)/u);
  assert.match(source, /assertNoForbiddenRuntimeDiagnostics\(\);\s*\}/u);
});

test("binds one strong mob-death HMAC authority before production startup", () => {
  const stackSource = readFileSync(
    new URL("./duel-stack.mjs", import.meta.url),
    "utf8",
  );
  const serverSource = readFileSync(
    new URL("../packages/server/src/main.ts", import.meta.url),
    "utf8",
  );
  const environmentExample = readFileSync(
    new URL("../packages/server/.env.example", import.meta.url),
    "utf8",
  );

  assert.match(
    stackSource,
    /const killTokenCredential = resolvePrivateRuntimeSecret\([\s\S]*?process\.env\.KILL_TOKEN_SECRET[\s\S]*?serverEnv\.KILL_TOKEN_SECRET[\s\S]*?randomBytes\(32\)/u,
  );
  assert.match(stackSource, /KILL_TOKEN_SECRET: killTokenCredential\.token/u);
  assert.match(
    serverSource,
    /process\.env\.KILL_TOKEN_SECRET[\s\S]*?byteLength < 32[\s\S]*?missing\.push\("KILL_TOKEN_SECRET \(32\+ bytes\)"\)/u,
  );
  assert.match(
    environmentExample,
    /KILL_TOKEN_SECRET=replace-with-32-or-more-random-bytes/u,
  );
});

test("runs the exact launch-equipment gate before any production build or launch", () => {
  const smokeSource = readFileSync(
    new URL("./smoke-duel-launch.mjs", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const ciSource = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.equal(
    packageJson.scripts["equipment:active-combat-orientation:check"],
    "node scripts/promote-duel-rigid-equipment-certification-candidates.mjs --check",
  );
  assert.equal(
    packageJson.scripts["equipment:fit:check"],
    "node scripts/audit-duel-equipment-fit.mjs --require-launch-minimum",
  );
  const visualEvidenceGate = smokeSource.indexOf(
    '"active combat visual orientation and contact evidence gate"',
  );
  const equipmentGate = smokeSource.indexOf(
    '"exact active duel equipment certification gate"',
  );
  const productionBuild = smokeSource.indexOf('"production SOL duel build"');
  const launch = smokeSource.indexOf(
    "const verificationReport = await launchAndWait()",
  );
  assert.ok(visualEvidenceGate >= 0);
  assert.ok(equipmentGate > visualEvidenceGate);
  assert.ok(productionBuild > equipmentGate);
  assert.ok(launch > equipmentGate);

  const ciOrientationTest = "bun run equipment:active-combat-orientation:test";
  const ciOrientationCheck =
    "bun run equipment:active-combat-orientation:check";
  const ciFitTest = "bun run equipment:fit:test";
  assert.equal(ciSource.split(ciOrientationTest).length - 1, 1);
  assert.equal(ciSource.split(ciOrientationCheck).length - 1, 1);
  assert.equal(ciSource.split(ciFitTest).length - 1, 1);
  assert.ok(ciSource.indexOf(ciOrientationTest) >= 0);
  assert.ok(
    ciSource.indexOf(ciOrientationCheck) > ciSource.indexOf(ciOrientationTest),
  );
  assert.ok(ciSource.indexOf(ciFitTest) > ciSource.indexOf(ciOrientationCheck));
});

test("distinguishes occupied ports from restricted network environments", () => {
  assert.equal(
    describeDuelSmokePortAvailabilityError({
      name: "server",
      port: 35551,
      error: { code: "EADDRINUSE" },
    }),
    "Duel smoke server port 35551 is already in use",
  );
  assert.equal(
    describeDuelSmokePortAvailabilityError({
      name: "server",
      port: 35551,
      error: { code: "EPERM" },
    }),
    "Duel smoke cannot validate server port 35551: local network binding is not permitted in this environment (EPERM)",
  );
  assert.equal(
    describeDuelSmokePortAvailabilityError({
      name: "server",
      port: 35551,
      error: new Error("unexpected"),
    }),
    "Duel smoke cannot validate server port 35551: socket bind failed (UNKNOWN)",
  );
});

test("keeps the overall cold-launch deadline separate from each stage deadline", () => {
  assert.deepEqual(
    validateDuelSmokeLaunchDeadlines({
      stageTimeoutMs: 600_000,
      overallLaunchTimeoutMs: 1_800_000,
    }),
    {
      stageTimeoutMs: 600_000,
      overallLaunchTimeoutMs: 1_800_000,
    },
  );
  assert.throws(
    () =>
      validateDuelSmokeLaunchDeadlines({
        stageTimeoutMs: 600_000,
        overallLaunchTimeoutMs: 599_999,
      }),
    /cannot be shorter/,
  );
  assert.throws(
    () =>
      validateDuelSmokeLaunchDeadlines({
        stageTimeoutMs: 600_000,
        overallLaunchTimeoutMs: 7_200_001,
      }),
    /from 60000ms to 7200000ms/,
  );
});

test("routes motion evidence to the HTTP game client, never the spectator websocket", () => {
  assert.equal(
    resolveDuelSmokeMotionStreamUrl(ports),
    "http://127.0.0.1:35553/stream.html",
  );
  assert.notEqual(
    resolveDuelSmokeMotionStreamUrl(ports),
    `http://127.0.0.1:${ports.spectator}/stream.html`,
  );
});

test("keeps motion startup open across the full local SOL duel cadence", () => {
  assert.equal(
    resolveDuelSmokeMotionStartupTimeoutSeconds({
      durationSeconds: 60,
      withLocalSolana: true,
    }),
    240,
  );
  assert.equal(
    resolveDuelSmokeMotionStartupTimeoutSeconds({
      durationSeconds: 60,
      withLocalSolana: false,
    }),
    120,
  );
  assert.throws(
    () =>
      resolveDuelSmokeMotionStartupTimeoutSeconds({
        durationSeconds: 60,
        withLocalSolana: "true",
      }),
    /timing policy must be boolean/,
  );
});

test("samples six visual-review frames across the encoded clip", () => {
  assert.deepEqual(
    resolveDuelSmokeReviewFrameTimestamps(15),
    [1.5, 3.9, 6.3, 8.7, 11.1, 13.5],
  );
  assert.deepEqual(
    resolveDuelSmokeReviewFrameTimestamps(60),
    [2, 13.2, 24.4, 35.6, 46.8, 58],
  );
  assert.throws(
    () => resolveDuelSmokeReviewFrameTimestamps(14.999),
    /review duration/,
  );
  assert.throws(
    () => resolveDuelSmokeReviewFrameTimestamps(Number.NaN),
    /review duration/,
  );
});

test("requires six distinct locked frames and an exact review-sheet raster", () => {
  const hashes = Array.from({ length: 6 }, (_, index) =>
    String(index).repeat(64),
  );
  assert.deepEqual(
    validateDuelSmokeReviewFrameEvidence({
      frameSha256Values: hashes,
      contactSheetWidth: 1_920,
      contactSheetHeight: 720,
    }),
    {
      frameCount: 6,
      uniqueFrameCount: 6,
      contactSheetWidth: 1_920,
      contactSheetHeight: 720,
    },
  );
  assert.throws(
    () =>
      validateDuelSmokeReviewFrameEvidence({
        frameSha256Values: hashes.slice(0, 5),
        contactSheetWidth: 1_920,
        contactSheetHeight: 720,
      }),
    /exactly six/,
  );
  assert.throws(
    () =>
      validateDuelSmokeReviewFrameEvidence({
        frameSha256Values: hashes.map(() => "a".repeat(64)),
        contactSheetWidth: 1_920,
        contactSheetHeight: 720,
      }),
    /byte-distinct/,
  );
  assert.throws(
    () =>
      validateDuelSmokeReviewFrameEvidence({
        frameSha256Values: hashes,
        contactSheetWidth: 1_280,
        contactSheetHeight: 720,
      }),
    /1920x720/,
  );
});

test("validates an explicit live-evidence browser profile before launch", () => {
  assert.deepEqual(
    validateDuelSmokeLiveEvidenceProfile({
      viewport: " 1024X768 ",
      networkLatencyMs: "100",
      cpuThrottleRate: "2",
    }),
    {
      viewport: "1024x768",
      networkLatencyMs: 100,
      cpuThrottleRate: 2,
    },
  );
  assert.throws(
    () =>
      validateDuelSmokeLiveEvidenceProfile({
        viewport: "1024:768",
        networkLatencyMs: 0,
        cpuThrottleRate: 1,
      }),
    /WIDTHxHEIGHT/,
  );
  assert.throws(
    () =>
      validateDuelSmokeLiveEvidenceProfile({
        viewport: "319x768",
        networkLatencyMs: 0,
        cpuThrottleRate: 1,
      }),
    /width/,
  );
  assert.throws(
    () =>
      validateDuelSmokeLiveEvidenceProfile({
        viewport: "1024x768",
        networkLatencyMs: 2_001,
        cpuThrottleRate: 1,
      }),
    /network latency/,
  );
  assert.throws(
    () =>
      validateDuelSmokeLiveEvidenceProfile({
        viewport: "1024x768",
        networkLatencyMs: 100,
        cpuThrottleRate: 0.5,
      }),
    /CPU throttle/,
  );
});

test("validates dynamic and exact-pair combat profiles before launch", () => {
  assert.deepEqual(validateDuelSmokeCombatProfile(" multi "), {
    name: "multi",
    roles: ["melee", "ranged", "mage"],
    botStyles: "melee,ranged",
    multiStyle: true,
  });
  assert.deepEqual(validateDuelSmokeCombatProfile(" MAGE, mage "), {
    name: "mage,mage",
    roles: ["mage", "mage"],
    botStyles: "mage,mage",
    multiStyle: false,
  });
  assert.deepEqual(validateDuelSmokeCombatProfile("ranged,melee"), {
    name: "ranged,melee",
    roles: ["ranged", "melee"],
    botStyles: "ranged,melee",
    multiStyle: false,
  });
  assert.throws(() => validateDuelSmokeCombatProfile("mage"), /exactly two/);
  assert.throws(
    () => validateDuelSmokeCombatProfile("mage,prayer"),
    /melee\/ranged\/mage/,
  );
  assert.throws(
    () => validateDuelSmokeCombatProfile("melee,ranged,mage"),
    /exactly two/,
  );
});

test("binds one private credential to the server and motion cross-check", () => {
  assert.deepEqual(bindDuelSmokeStreamCredential("  private-token  "), {
    STREAMING_VIEWER_ACCESS_TOKEN: "private-token",
    STREAMING_CAPTURE_VIEWER_TOKEN: "private-token",
  });
  assert.throws(
    () => bindDuelSmokeStreamCredential("  "),
    /credential must be non-empty/,
  );
});

test("labels a materialized Hyperbet runtime dirty against an explicit revision", () => {
  assert.deepEqual(
    resolveDuelSmokeMaterializedSourceAttestation({
      runtimeHasGitMetadata: false,
      sourceRevision: "A".repeat(40),
    }),
    [
      "--hyperbet-source-revision",
      "a".repeat(40),
      "--hyperbet-working-tree-dirty",
    ],
  );
  assert.deepEqual(
    resolveDuelSmokeMaterializedSourceAttestation({
      runtimeHasGitMetadata: true,
      sourceRevision: "",
    }),
    [],
  );
  assert.throws(
    () =>
      resolveDuelSmokeMaterializedSourceAttestation({
        runtimeHasGitMetadata: false,
        sourceRevision: "missing",
      }),
    /requires a valid source revision/,
  );
});

test("propagates explicit reuse of prequalified game builds", () => {
  const reused = buildDuelSmokeLauncherArgs({
    ports,
    timeoutMs: 600_000,
    reuseGameBuilds: true,
  });
  const rebuilt = buildDuelSmokeLauncherArgs({
    ports,
    timeoutMs: 600_000,
  });

  assert.equal(reused.includes("--reuse-game-builds"), true);
  assert.equal(rebuilt.includes("--reuse-game-builds"), false);
});

test("propagates the exact smoke combat profile into the launcher", () => {
  const dynamic = buildDuelSmokeLauncherArgs({
    ports,
    timeoutMs: 600_000,
  });
  const fixed = buildDuelSmokeLauncherArgs({
    ports,
    timeoutMs: 600_000,
    combatProfile: "mage,mage",
  });

  assert.deepEqual(
    dynamic.slice(
      dynamic.indexOf("--bot-styles"),
      dynamic.indexOf("--bot-styles") + 2,
    ),
    ["--bot-styles", "melee,ranged"],
  );
  assert.equal(dynamic.includes("--multi-style-sparbots"), true);
  assert.deepEqual(
    fixed.slice(
      fixed.indexOf("--bot-styles"),
      fixed.indexOf("--bot-styles") + 2,
    ),
    ["--bot-styles", "mage,mage"],
  );
  assert.equal(fixed.includes("--multi-style-sparbots"), false);
  assert.deepEqual(buildDuelSmokeMotionCombatArgs("multi"), [
    "--roles",
    "melee,ranged,mage",
    "--multi-style",
    "--headed",
  ]);
  assert.deepEqual(buildDuelSmokeMotionCombatArgs("mage,mage"), [
    "--roles",
    "mage,mage",
    "--headed",
  ]);
});

test("locks macOS 3D smoke capture to headful installed Chrome on ANGLE Metal", () => {
  assert.deepEqual(
    resolveDuelSmokeCaptureBrowserEnvironment({
      platform: "darwin",
      environment: {},
    }),
    {
      STREAM_CAPTURE_CHANNEL: "chrome",
      STREAM_CAPTURE_ANGLE: "metal",
      STREAM_CAPTURE_HEADLESS: "false",
      STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome",
      STREAMING_CAPTURE_ANGLE: "metal",
    },
  );
  assert.deepEqual(
    resolveDuelSmokeCaptureBrowserEnvironment({
      platform: "darwin",
      environment: {
        STREAM_CAPTURE_CHANNEL: "chromium",
        STREAM_CAPTURE_ANGLE: "METAL",
        STREAM_CAPTURE_HEADLESS: "off",
        STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome",
        STREAMING_CAPTURE_ANGLE: "metal",
      },
    }),
    {
      STREAM_CAPTURE_CHANNEL: "chrome",
      STREAM_CAPTURE_ANGLE: "metal",
      STREAM_CAPTURE_HEADLESS: "false",
      STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome",
      STREAMING_CAPTURE_ANGLE: "metal",
    },
  );

  for (const environment of [
    { STREAM_CAPTURE_CHANNEL: "bundled" },
    { STREAM_CAPTURE_ANGLE: "vulkan" },
    { STREAM_CAPTURE_HEADLESS: "true" },
    { STREAM_CAPTURE_HEADLESS: "sometimes" },
    { STREAMING_CAPTURE_BROWSER_CHANNEL: "bundled" },
    { STREAMING_CAPTURE_ANGLE: "vulkan" },
  ]) {
    assert.throws(
      () =>
        resolveDuelSmokeCaptureBrowserEnvironment({
          platform: "darwin",
          environment,
        }),
      /macOS duel smoke capture requires|must be headful/,
    );
  }
});

test("retains the installed headful ANGLE browser contract on Linux", () => {
  assert.deepEqual(
    resolveDuelSmokeCaptureBrowserEnvironment({
      platform: "linux",
      environment: {},
    }),
    {
      STREAM_CAPTURE_CHANNEL: "chrome-canary",
      STREAM_CAPTURE_ANGLE: "vulkan",
      STREAM_CAPTURE_HEADLESS: "false",
      STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome-canary",
      STREAMING_CAPTURE_ANGLE: "vulkan",
    },
  );
  assert.deepEqual(
    resolveDuelSmokeCaptureBrowserEnvironment({
      platform: "linux",
      environment: {
        STREAM_CAPTURE_CHANNEL: "bundled",
        STREAMING_CAPTURE_BROWSER_CHANNEL: "chromium",
      },
    }),
    {
      STREAM_CAPTURE_CHANNEL: "chrome-canary",
      STREAM_CAPTURE_ANGLE: "vulkan",
      STREAM_CAPTURE_HEADLESS: "false",
      STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome-canary",
      STREAMING_CAPTURE_ANGLE: "vulkan",
    },
  );
  assert.throws(
    () =>
      resolveDuelSmokeCaptureBrowserEnvironment({
        platform: "linux",
        environment: { STREAM_CAPTURE_CHANNEL: "chrome-beta" },
      }),
    /installed Chrome Canary/,
  );
  assert.throws(
    () =>
      resolveDuelSmokeCaptureBrowserEnvironment({
        platform: "linux",
        environment: { STREAM_CAPTURE_HEADLESS: "true" },
      }),
    /must be headful/,
  );
  assert.throws(
    () =>
      resolveDuelSmokeCaptureBrowserEnvironment({
        platform: "linux",
        environment: { STREAMING_CAPTURE_ANGLE: "metal" },
      }),
    /ANGLE Vulkan/,
  );
});

test("keeps the HLS-only viewer headless while the 3D motion observer is headed", () => {
  const smokeSource = readFileSync(
    new URL("./smoke-duel-launch.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    smokeSource,
    /const smokeCaptureBrowserEnvironment\s*=\s*resolveDuelSmokeCaptureBrowserEnvironment\(\{[\s\S]*?platform: process\.platform,[\s\S]*?environment: process\.env,[\s\S]*?\}\)/u,
  );
  assert.match(
    smokeSource,
    /const environment = \{[\s\S]*?\.\.\.smokeCaptureBrowserEnvironment/u,
  );
  assert.doesNotMatch(smokeSource, /STREAM_CAPTURE_CHANNEL:\s*"bundled"/u);
  assert.match(
    smokeSource,
    /async function monitorFullTopologyViewer[\s\S]*?ownedViewer = await launchOwnedDuelViewer\(\{\s*chromium,\s*signal,/u,
  );
  const viewerRuntimeSource = readFileSync(
    new URL("./duel-full-topology-viewer-runtime.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    viewerRuntimeSource,
    /\.launchServer\(\{\s*headless: true,\s*host: "127\.0\.0\.1",/u,
  );
  assert.match(
    smokeSource,
    /scripts\/capture-duel-motion-telemetry\.mjs[\s\S]*?\.\.\.buildDuelSmokeMotionCombatArgs/u,
  );
  assert.match(
    smokeSource,
    /scripts\/capture-duel-motion-telemetry\.mjs[\s\S]*?\.\.\.smokeStreamCredentialEnvironment,[\s\S]*?\.\.\.smokeCaptureBrowserEnvironment/u,
  );
  assert.equal(
    buildDuelSmokeMotionCombatArgs("melee,ranged").includes("--headed"),
    true,
  );
});

test("rejects a non-boolean reuse-game-builds policy", () => {
  assert.throws(
    () =>
      buildDuelSmokeLauncherArgs({
        ports,
        timeoutMs: 600_000,
        reuseGameBuilds: "true",
      }),
    /reuse-game-builds policy must be boolean/,
  );
});

function createHyperbetLiveFightProof() {
  return {
    expectedHlsUrl: "http://127.0.0.1:35551/live/stream.m3u8",
    transaction: {
      duelId: "duel-1",
      duelKey: "ab".repeat(32),
    },
    observation: {
      liveState: "LIVE",
      cycleId: "cycle-1",
      duelId: "duel-1",
      duelKey: "ab".repeat(32),
      observedAtMs: 1_700_000_010_000,
      streamStateEmittedAt: 1_700_000_006_000,
      video: {
        currentSource: "blob:http://localhost:35558/player",
        declaredSource: "http://127.0.0.1:35551/live/stream.m3u8",
        currentTime: 42.25,
        readyState: 4,
        paused: false,
      },
    },
  };
}

test("binds a concurrently observed Hyperbet live fight to the signed SOL order", () => {
  assert.deepEqual(
    validateHyperbetLiveFightObservation(createHyperbetLiveFightProof()),
    {
      cycleId: "cycle-1",
      duelId: "duel-1",
      duelKey: "ab".repeat(32),
      observedAtMs: 1_700_000_010_000,
      streamStateEmittedAt: 1_700_000_006_000,
      stateAgeMs: 4_000,
      video: {
        currentSource: "blob:http://localhost:35558/player",
        declaredSource: "http://127.0.0.1:35551/live/stream.m3u8",
        currentTime: 42.25,
        readyState: 4,
        paused: false,
      },
    },
  );
});

test("rejects stale, mismatched, non-live, or non-playing Hyperbet fight proof", () => {
  const mismatched = createHyperbetLiveFightProof();
  mismatched.transaction.duelId = "duel-2";
  assert.throws(
    () => validateHyperbetLiveFightObservation(mismatched),
    /does not match/,
  );

  const connected = createHyperbetLiveFightProof();
  connected.observation.liveState = "CONNECTED";
  assert.throws(
    () => validateHyperbetLiveFightObservation(connected),
    /never observed/,
  );

  const stale = createHyperbetLiveFightProof();
  stale.observation.streamStateEmittedAt = 1_699_999_900_000;
  assert.throws(
    () => validateHyperbetLiveFightObservation(stale),
    /stale or invalid/,
  );

  const paused = createHyperbetLiveFightProof();
  paused.observation.video.paused = true;
  assert.throws(
    () => validateHyperbetLiveFightObservation(paused),
    /no advancing HLS player/,
  );

  const wrongSource = createHyperbetLiveFightProof();
  wrongSource.observation.video.declaredSource =
    "http://127.0.0.1:9999/live/stream.m3u8";
  assert.throws(
    () => validateHyperbetLiveFightObservation(wrongSource),
    /no advancing HLS player/,
  );
});

function createHealthyAudioStatus() {
  return {
    updatedAt: 1_010,
    stats: {
      audioSource: "browser",
      audioHealthy: true,
      audioLastChunkAt: 1_000,
      audioChunks: 12,
      audioDroppedChunks: 0,
      audioTrimmedChunks: 1,
    },
    browserAudioCaptureHealth: {
      contextState: "running",
      sourceContextState: "running",
      trackState: "live",
      sampleRate: 48_000,
      channels: 2,
      chunks: 14,
      bytes: 114_688,
      contentChunks: 9,
      contentThreshold: 0.0001,
      maxSamplePeak: 0.25,
      lastContentChunkAt: 1_005,
      lastChunkAt: 1_001,
    },
  };
}

test("accepts only a healthy browser game-master audio path", () => {
  assert.deepEqual(getHealthyBrowserAudioEvidence(createHealthyAudioStatus()), {
    source: "browser",
    healthy: true,
    bridgeChunks: 12,
    bridgeLastChunkAt: 1_000,
    captureChunks: 14,
    captureBytes: 114_688,
    contentChunks: 9,
    contentThreshold: 0.0001,
    maxSamplePeak: 0.25,
    lastContentChunkAt: 1_005,
    captureLastChunkAt: 1_001,
    sampleRate: 48_000,
    channels: 2,
    droppedChunks: 0,
    trimmedChunks: 1,
  });
});

test("rejects silent, system, stale, or incomplete audio evidence", () => {
  const silent = createHealthyAudioStatus();
  silent.stats.audioSource = "silent";
  assert.equal(getHealthyBrowserAudioEvidence(silent), null);

  const system = createHealthyAudioStatus();
  system.stats.audioSource = "pulse";
  assert.equal(getHealthyBrowserAudioEvidence(system), null);

  const stale = createHealthyAudioStatus();
  stale.stats.audioHealthy = false;
  assert.equal(getHealthyBrowserAudioEvidence(stale), null);

  const incomplete = createHealthyAudioStatus();
  incomplete.browserAudioCaptureHealth.bytes = 0;
  assert.equal(getHealthyBrowserAudioEvidence(incomplete), null);

  const continuityPilotOnly = createHealthyAudioStatus();
  continuityPilotOnly.browserAudioCaptureHealth.contentChunks = 0;
  continuityPilotOnly.browserAudioCaptureHealth.maxSamplePeak = 1e-8;
  assert.equal(getHealthyBrowserAudioEvidence(continuityPilotOnly), null);

  const oldContent = createHealthyAudioStatus();
  oldContent.updatedAt =
    oldContent.browserAudioCaptureHealth.lastContentChunkAt + 15_001;
  assert.equal(getHealthyBrowserAudioEvidence(oldContent), null);
});

test("requires a complete retained 720p stereo A/V stream", () => {
  const probe = {
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1280,
        height: 720,
        avg_frame_rate: "30/1",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
      },
    ],
    format: { duration: "60.04" },
  };

  assert.deepEqual(getCompleteRetainedLiveMediaEvidence(probe, 60), {
    durationSeconds: 60.04,
    videoCodec: "h264",
    width: 1280,
    height: 720,
    averageFrameRate: "30/1",
    audioCodec: "aac",
    sampleRate: 48_000,
    channels: 2,
  });

  assert.equal(
    getCompleteRetainedLiveMediaEvidence(
      { ...probe, streams: probe.streams.slice(0, 1) },
      60,
    ),
    null,
  );
  assert.equal(
    getCompleteRetainedLiveMediaEvidence(
      { ...probe, format: { duration: "40" } },
      60,
    ),
    null,
  );
});
