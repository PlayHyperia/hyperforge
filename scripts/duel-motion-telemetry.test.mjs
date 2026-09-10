import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cloneDuelScreenshotPerformanceSnapshot,
  evaluateDuelScreenshotPerformanceSnapshot,
  evaluateDuelStyleSwitchTelemetry,
  isDuelMotionSamplingRace,
  parseDuelMotionRoles,
  parseDuelMotionSafeCrop,
  summarizeDuelStyleSwitchTelemetry,
  summarizeDuelHitReactionTelemetry,
  summarizeDuelHitReactionResolutionTelemetry,
  summarizeDuelMotionTelemetry,
} from "./duel-motion-telemetry.mjs";

test("live motion capture uses platform-specific production GPU feature flags", () => {
  const source = readFileSync(
    new URL("./capture-duel-motion-telemetry.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /featureFlags: resolveDefaultCaptureFeatureFlags\(process\.platform\)/u,
  );
  assert.doesNotMatch(source, /featureFlags:\s*"--enable-features=Vulkan/u);
});

function quaternionForYaw(yawRadians) {
  return [0, Math.sin(yawRadians / 2), 0, Math.cos(yawRadians / 2)];
}

function authoredMotion(
  url = "asset://emotes/emote_sword_swing.glb",
  overrides = {},
) {
  return {
    schemaVersion: 1,
    overflow: false,
    invalidActionCount: 0,
    actions: [
      {
        url,
        running: true,
        paused: false,
        effectiveWeight: 0.8,
      },
    ],
    ...overrides,
  };
}

function createAlignedHitReactionSamples() {
  const hpBySample = [
    [40, 40],
    [40, 34],
    [35, 34],
    [35, 29],
    [31, 29],
  ];
  const triggerBySample = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
    [2, 2],
  ];
  return hpBySample.map((health, index) => ({
    observedAt: index * 100,
    cycleId: "cycle-hit",
    agents: ["agent-a", "agent-b"].map((id, agentIndex) => ({
      id,
      hp: health[agentIndex],
      avatarEmote: "asset://emotes/emote_sword_swing.glb",
      authoredMotion: authoredMotion(),
      hitReaction: {
        availableBoneCount: 5,
        triggerCount: triggerBySample[index][agentIndex],
        active: index > 0,
        elapsedSeconds: index > 0 ? 0.08 : null,
        currentWeight: index > 0 ? 0.7 : 0,
        lastIntensity: index > 0 ? 0.8 : 0,
        lastSide: 1,
      },
    })),
  }));
}

function createPassingPerformance() {
  return {
    schemaVersion: 1,
    sessionStartedAt: 1_000,
    updatedAt: 10_000,
    uptimeMs: 9_000,
    overall: { frames: 720 },
    viewport: { width: 1_440, height: 810, devicePixelRatio: 0.75 },
    byPhase: {
      FIGHTING: {
        frames: 720,
        frameIntervalMs: { p50: 16.7, p95: 18, p99: 22 },
        frameWorkMs: { p95: 4, p99: 7 },
        cpuMs: { p50: 2, p95: 3, p99: 4 },
        renderSubmitMs: { p50: 2, p95: 3, p99: 4 },
        frameBudget: { above33_33Ms: 2 },
        renderer: {
          drawCalls: { samples: 720, average: 4, latest: 4, max: 5 },
          triangles: {
            samples: 720,
            average: 450_000,
            latest: 445_000,
            max: 500_000,
          },
          textures: { samples: 720, average: 180, latest: 180, max: 181 },
          geometries: { samples: 720, average: 210, latest: 210, max: 212 },
        },
      },
    },
  };
}

function screenshotPerformance(updatedAt = 10_200, frames = 721) {
  return {
    ...createPassingPerformance(),
    updatedAt,
    uptimeMs: updatedAt - 1_000,
    overall: { frames },
  };
}

test("screenshot evidence requires strictly newer same-session telemetry covering the capture end", () => {
  const input = {
    before: createPassingPerformance(),
    after: screenshotPerformance(),
    captureEndedAt: 10_200,
    afterObservedAt: 10_300,
  };
  assert.deepEqual(evaluateDuelScreenshotPerformanceSnapshot(input), {
    status: "ready",
    reason: null,
  });
  for (const after of [
    screenshotPerformance(10_000, 720),
    screenshotPerformance(10_199, 721),
    screenshotPerformance(10_200, 720),
  ]) {
    assert.equal(
      evaluateDuelScreenshotPerformanceSnapshot({ ...input, after }).status,
      "pending",
    );
  }
  assert.equal(
    evaluateDuelScreenshotPerformanceSnapshot({
      ...input,
      after: screenshotPerformance(10_200, 721),
      afterObservedAt: 10_200,
    }).status,
    "ready",
  );
});

test("screenshot evidence fails closed on reset, regression, malformed telemetry, and impossible clock bounds", () => {
  const input = {
    before: createPassingPerformance(),
    after: screenshotPerformance(),
    captureEndedAt: 10_200,
    afterObservedAt: 10_300,
  };
  for (const after of [
    null,
    {},
    { ...screenshotPerformance(), sessionStartedAt: 1_001, uptimeMs: 9_199 },
    screenshotPerformance(9_999, 721),
    screenshotPerformance(10_200, 719),
    { ...screenshotPerformance(), uptimeMs: 1 },
    { ...screenshotPerformance(), overall: { frames: NaN } },
    screenshotPerformance(10_301, 721),
  ]) {
    assert.equal(
      evaluateDuelScreenshotPerformanceSnapshot({ ...input, after }).status,
      "invalid",
    );
  }
  for (const bounds of [
    { captureEndedAt: 9_999 },
    { captureEndedAt: NaN },
    { captureEndedAt: 10_200.5 },
    { afterObservedAt: 10_199 },
  ]) {
    assert.equal(
      evaluateDuelScreenshotPerformanceSnapshot({ ...input, ...bounds }).status,
      "invalid",
    );
  }
});

test("retained screenshot snapshots are independent and bounded at the exact character limit", () => {
  const original = createPassingPerformance();
  const retained = cloneDuelScreenshotPerformanceSnapshot(original);
  original.overall.frames += 1;
  assert.equal(retained.overall.frames, 720);
  const maximum = { ...retained, diagnosticPadding: "" };
  maximum.diagnosticPadding = "x".repeat(
    262_144 - JSON.stringify(maximum).length,
  );
  assert.equal(JSON.stringify(maximum).length, 262_144);
  assert.deepEqual(cloneDuelScreenshotPerformanceSnapshot(maximum), maximum);
  maximum.diagnosticPadding += "x";
  assert.throws(
    () => cloneDuelScreenshotPerformanceSnapshot(maximum),
    /exceeds retention limit/,
  );
  assert.throws(() => cloneDuelScreenshotPerformanceSnapshot(null), /invalid/);
});

test("long-frame evidence preserves the telemetry epoch and explicitly estimated interval relation", () => {
  const performance = createPassingPerformance();
  performance.longFrames = [
    {
      phase: "FIGHTING",
      frameSequence: 720,
      phaseFrame: 10,
      uptimeMs: 8_900,
      frameIntervalMs: 161.4,
      frameWorkMs: 1.7,
    },
  ];
  const result = summarizeDuelMotionTelemetry({
    samples: createPassingSamples(),
    performance,
    expectedRoles: ["ranged", "mage"],
  });
  assert.equal(result.metrics.performance.sessionStartedAt, 1_000);
  assert.equal(result.metrics.performance.overallFrames, 720);
  assert.equal(result.metrics.performance.longFrames[0].observedAt, 9_900);
  assert.equal(
    result.metrics.performance.longFrames[0].estimatedIntervalStartedAt,
    9_738.6,
  );
  performance.longFrames[0].uptimeMs = 9_001;
  const impossible = summarizeDuelMotionTelemetry({
    samples: createPassingSamples(),
    performance,
    expectedRoles: ["ranged", "mage"],
  });
  assert.equal(impossible.metrics.performance.longFrames[0].observedAt, null);
  assert.equal(
    impossible.metrics.performance.longFrames[0].estimatedIntervalStartedAt,
    null,
  );
});

test("capture keeps immediate scene admission before its bounded telemetry-only wait and retains failed attempts", () => {
  const source = readFileSync(
    new URL("./capture-duel-motion-telemetry.mjs", import.meta.url),
    "utf8",
  );
  const capture = source.indexOf(
    "await page.screenshot({ path: screenshotPath })",
  );
  const immediateProbe = source.indexOf("readBrowserProbe(page)", capture);
  const sceneAdmission = source.indexOf(
    'afterState?.phase !== "FIGHTING"',
    capture,
  );
  const capturedAt = source.indexOf("capturedAt: Date.now()", capture);
  const freshWait = source.indexOf(
    "await waitForScreenshotPerformance(",
    capture,
  );
  assert.ok(capture > 0 && immediateProbe > capture);
  assert.ok(sceneAdmission > immediateProbe && capturedAt > sceneAdmission);
  assert.ok(freshWait > capturedAt);
  assert.match(
    source,
    /latestPerformance = await waitForScreenshotPerformance\(/u,
  );
  const finalSummary = source.indexOf("const motionSummary =", freshWait);
  assert.ok(finalSummary > freshWait);
  assert.match(source.slice(finalSummary), /performance: latestPerformance/u);
  assert.match(
    source.slice(finalSummary),
    /finalScreenshotAttempt\?\.status === "complete"/u,
  );
  assert.match(
    source.slice(finalSummary),
    /finalScreenshotAttempt\.snapshotFreshness\?\.status === "ready"/u,
  );
  assert.match(source.slice(finalSummary), /navigationError === null/u);
  assert.match(source, /SCREENSHOT_PERFORMANCE_TIMEOUT_MS = 3_000/u);
  assert.match(source, /MAX_RETAINED_SCREENSHOT_ATTEMPTS = 4/u);
  assert.match(source, /screenshotAttempts\.shift\(\)/u);
  assert.match(source, /attempt\.status = "scene_rejected"/u);
  assert.match(source, /attempt\.status = "failed";[\s\S]*?throw error;/u);
  assert.match(
    source,
    /captureEndedAt: attempt\.immediateAfterClock\.wallTimeMs/u,
  );
  assert.match(
    source,
    /probe = await readScreenshotPerformanceProbe\(page, probeTimeoutMs\)/u,
  );
  assert.match(source, /causality: "unattributed"/u);
  const waitSource = source.slice(
    source.indexOf("async function waitForScreenshotPerformance"),
    source.indexOf("const options ="),
  );
  assert.doesNotMatch(
    waitSource,
    /RESET_STREAM_PERFORMANCE|readBrowserProbe|fetchState/u,
  );
});

function createPassingSamples() {
  return Array.from({ length: 36 }, (_, index) => {
    const direction = Math.floor(index / 9) % 4;
    const progress = index % 9;
    const offsets = [
      [progress * 0.04, progress * 0.03],
      [0.32 - progress * 0.04, 0.24 + progress * 0.03],
      [-progress * 0.04, 0.48 - progress * 0.03],
      [-0.32 + progress * 0.04, 0.24 - progress * 0.03],
    ];
    const [dx, dz] = offsets[direction];
    const left = [350 + dx, 0.42, 405 + dz];
    const right = [352 - dx, 0.42, 407 - dz];
    return {
      observedAt: index * 250,
      cycleId: "cycle-a",
      renderedSeparationXZ: Math.hypot(left[0] - right[0], left[2] - right[2]),
      agents: [
        {
          id: "ranged-agent",
          role: "ranged",
          renderPosition: left,
          simulationPosition: [...left],
          avatarPosition: [...left],
          renderQuaternion: quaternionForYaw(index * 0.01),
          ndcPosition: [-0.35 + dx * 0.1, -0.1 + dz * 0.1, 0.5],
          ndcHeadPosition: [-0.34 + dx * 0.1, 0.42 + dz * 0.1, 0.49],
          facingTargetErrorDegrees: 2,
          insideCombatArena: true,
          insideAssignedCombatArena: true,
          cameraLineOfSight: { head: true, torso: true, lowerBody: true },
          visible: true,
          active: true,
          avatarReady: true,
        },
        {
          id: "mage-agent",
          role: "mage",
          renderPosition: right,
          simulationPosition: [...right],
          avatarPosition: [...right],
          renderQuaternion: quaternionForYaw(Math.PI + index * 0.01),
          ndcPosition: [0.35 - dx * 0.1, -0.1 - dz * 0.1, 0.5],
          ndcHeadPosition: [0.34 - dx * 0.1, 0.42 - dz * 0.1, 0.49],
          facingTargetErrorDegrees: 3,
          insideCombatArena: true,
          insideAssignedCombatArena: true,
          cameraLineOfSight: { head: true, torso: true, lowerBody: true },
          visible: true,
          active: true,
          avatarReady: true,
        },
      ],
    };
  });
}

test("accepts a bounded smooth multi-direction ranged/mage time series", () => {
  const result = summarizeDuelMotionTelemetry({
    samples: createPassingSamples(),
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.metrics.sampleCount, 36);
  assert.deepEqual(result.metrics.observedRoles, ["mage", "ranged"]);
  assert.ok(result.metrics.combinedDiagonalSegments >= 2);
  assert.ok(result.metrics.combinedDirectionCoverage.length >= 3);
  assert.equal(result.metrics.performance.viewport.devicePixelRatio, 0.75);
  assert.equal(result.metrics.performance.renderer.triangles.max, 500_000);
  assert.equal(result.metrics.performance.cpuMs.p95, 3);
  assert.equal(result.metrics.performance.renderSubmitMs.p95, 3);
  assert.equal(result.checks.filter((entry) => !entry.pass).length, 0);
});

test("does not let one contestant mask cardinal-only movement by the other", () => {
  const samples = createPassingSamples().map((sample, index) => {
    const cardinalPosition = [350 + index * 0.04, 0.42, 405];
    return {
      ...sample,
      agents: [
        {
          ...sample.agents[0],
          renderPosition: cardinalPosition,
          simulationPosition: [...cardinalPosition],
          avatarPosition: [...cardinalPosition],
        },
        sample.agents[1],
      ],
    };
  });
  const result = summarizeDuelMotionTelemetry({
    samples,
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
  });

  assert.equal(
    result.checks.find((entry) => entry.label === "diagonal movement observed")
      .pass,
    true,
  );
  assert.equal(
    result.checks.find(
      (entry) =>
        entry.label === "every contestant demonstrates diagonal movement",
    ).pass,
    false,
  );
  assert.equal(result.ok, false);
});

test("accepts and verifies an explicit same-style pair", () => {
  assert.deepEqual(parseDuelMotionRoles(" melee,melee "), ["melee", "melee"]);
  assert.throws(
    () => parseDuelMotionRoles("melee,melee", true),
    /exactly once/,
  );

  const samples = createPassingSamples().map((sample) => ({
    ...sample,
    agents: sample.agents.map((agent) => ({ ...agent, role: "melee" })),
  }));
  const result = summarizeDuelMotionTelemetry({
    samples,
    performance: createPassingPerformance(),
    expectedRoles: ["melee", "melee"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.metrics.observedRoles, ["melee"]);
});

test("requires both declared crop axes and rejects projected fighters outside either bound", () => {
  assert.equal(parseDuelMotionSafeCrop(undefined, undefined), null);
  assert.throws(
    () => parseDuelMotionSafeCrop("0.9", undefined),
    /requires both/,
  );
  assert.throws(() => parseDuelMotionSafeCrop("1.01", "0.9"), /at most 1/);

  const safeCrop = parseDuelMotionSafeCrop("0.9", "0.82");
  const passing = summarizeDuelMotionTelemetry({
    samples: createPassingSamples(),
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
    safeCrop,
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.metrics.safeCropNdc.violations, 0);
  assert.equal(
    passing.checks.find(
      (entry) =>
        entry.label === "contestants stay inside the declared stream-safe crop",
    ).pass,
    true,
  );

  const failingSamples = createPassingSamples();
  failingSamples[12].agents[1].ndcPosition = [0.91, -0.83, 0.5];
  const failing = summarizeDuelMotionTelemetry({
    samples: failingSamples,
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
    safeCrop,
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.metrics.safeCropNdc.violations, 1);
  assert.equal(
    failing.checks.find(
      (entry) =>
        entry.label === "contestants stay inside the declared stream-safe crop",
    ).pass,
    false,
  );
});

test("rejects tiny, HUD-obscured, or discontinuous fighting compositions", () => {
  const tiny = createPassingSamples();
  for (const sample of tiny) {
    for (const agent of sample.agents) {
      agent.ndcHeadPosition[1] = agent.ndcPosition[1] + 0.12;
    }
  }
  const tinyResult = summarizeDuelMotionTelemetry({
    samples: tiny,
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
  });
  assert.equal(tinyResult.ok, false);
  assert.equal(
    tinyResult.checks.find(
      (entry) =>
        entry.label === "contestants remain readable at broadcast scale",
    ).pass,
    false,
  );

  const obscured = createPassingSamples();
  obscured[12].agents[1].ndcPosition = [0.81, -0.1, 0.5];
  obscured[12].agents[1].ndcHeadPosition = [0.8, 0.42, 0.49];
  const obscuredResult = summarizeDuelMotionTelemetry({
    samples: obscured,
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
  });
  assert.equal(obscuredResult.ok, false);
  assert.equal(
    obscuredResult.checks.find(
      (entry) =>
        entry.label === "contestants remain inside HUD-safe body framing",
    ).pass,
    false,
  );

  const discontinuous = createPassingSamples();
  for (let index = 1; index < discontinuous.length; index += 2) {
    for (const agent of discontinuous[index].agents) {
      agent.ndcPosition[1] += 0.24;
      agent.ndcHeadPosition[1] += 0.24;
    }
  }
  const discontinuousResult = summarizeDuelMotionTelemetry({
    samples: discontinuous,
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
  });
  assert.equal(discontinuousResult.ok, false);
  assert.equal(
    discontinuousResult.checks.find(
      (entry) =>
        entry.label === "camera composition transitions remain continuous",
    ).pass,
    false,
  );
});

test("rejects wrong-ring movement and real full-body occlusion", () => {
  const wrongRing = createPassingSamples();
  wrongRing[9].agents[0].insideCombatArena = true;
  wrongRing[9].agents[0].insideAssignedCombatArena = false;
  const wrongRingResult = summarizeDuelMotionTelemetry({
    samples: wrongRing,
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
  });
  assert.equal(wrongRingResult.ok, false);
  assert.equal(
    wrongRingResult.checks.find(
      (entry) =>
        entry.label ===
        "contestants remain inside their exact assigned combat ring",
    ).pass,
    false,
  );

  const occluded = createPassingSamples();
  occluded[11].agents[1].cameraLineOfSight.lowerBody = false;
  const occludedResult = summarizeDuelMotionTelemetry({
    samples: occluded,
    performance: createPassingPerformance(),
    expectedRoles: ["ranged", "mage"],
  });
  assert.equal(occludedResult.ok, false);
  assert.equal(
    occludedResult.checks.find(
      (entry) =>
        entry.label ===
        "contestants remain visually unobstructed from head through lower body",
    ).pass,
    false,
  );
});

test("rejects motionless, out-of-bounds, poorly paced evidence", () => {
  const samples = createPassingSamples().map((sample) => ({
    ...sample,
    renderedSeparationXZ: 0.1,
    agents: sample.agents.map((agent, index) => ({
      ...agent,
      renderPosition: [350 + index * 0.1, 0.42, 405],
      simulationPosition: [350 + index * 0.1, 0.42, 405],
      avatarPosition: [350 + index * 0.1, 0.42, 405],
      insideCombatArena: false,
      facingTargetErrorDegrees: 120,
    })),
  }));
  const performance = createPassingPerformance();
  performance.byPhase.FIGHTING.frameIntervalMs = {
    p50: 33,
    p95: 45,
    p99: 60,
  };

  const result = summarizeDuelMotionTelemetry({
    samples,
    performance,
    expectedRoles: ["ranged", "mage"],
  });

  assert.equal(result.ok, false);
  const failedLabels = result.checks
    .filter((entry) => !entry.pass)
    .map((entry) => entry.label);
  assert.ok(
    failedLabels.includes("every contestant demonstrates tactical travel"),
  );
  assert.ok(
    failedLabels.includes(
      "avatars stay visible, active, loaded, and inside the arena",
    ),
  );
  assert.ok(failedLabels.includes("contestants remain visibly separated"));
  assert.ok(failedLabels.includes("60 FPS cadence meets percentile budget"));
});

test("distinguishes asynchronous sampling races from integrity failures", () => {
  assert.equal(
    isDuelMotionSamplingRace("browser_server_state_disagreement"),
    true,
  );
  assert.equal(isDuelMotionSamplingRace("scene:phase_mismatch"), true);
  assert.equal(isDuelMotionSamplingRace("renderer_or_layout_not_ready"), false);
  assert.equal(isDuelMotionSamplingRace("scene:agent_hidden"), false);
});

test("requires real within-cycle switches from both contestants and visible UI evidence", () => {
  const roles = [
    ["melee", "ranged"],
    ["melee", "ranged"],
    ["ranged", "mage"],
    ["mage", "melee"],
  ];
  const samples = roles.map((pair, index) => ({
    observedAt: index * 250,
    cycleId: "cycle-a",
    agents: [
      { id: "agent-a", role: pair[0] },
      { id: "agent-b", role: pair[1] },
    ],
  }));
  const metrics = summarizeDuelStyleSwitchTelemetry(samples, 2);
  const checks = evaluateDuelStyleSwitchTelemetry(metrics, [
    "melee",
    "ranged",
    "mage",
  ]);

  assert.equal(metrics.totalSwitches, 4);
  assert.deepEqual(
    metrics.agents.map((agent) => agent.switches),
    [2, 2],
  );
  assert.equal(
    checks.every((entry) => entry.pass),
    true,
  );
});

test("does not count a new cycle opening role as a live switch", () => {
  const metrics = summarizeDuelStyleSwitchTelemetry(
    [
      {
        observedAt: 0,
        cycleId: "cycle-a",
        agents: [
          { id: "agent-a", role: "melee" },
          { id: "agent-b", role: "ranged" },
        ],
      },
      {
        observedAt: 250,
        cycleId: "cycle-b",
        agents: [
          { id: "agent-a", role: "ranged" },
          { id: "agent-b", role: "mage" },
        ],
      },
    ],
    0,
  );
  const checks = evaluateDuelStyleSwitchTelemetry(metrics, [
    "melee",
    "ranged",
    "mage",
  ]);

  assert.equal(metrics.totalSwitches, 0);
  assert.equal(checks[0].pass, false);
  assert.equal(checks[2].pass, false);
});

test("aligns repeated health loss with exact avatar reaction sequences", () => {
  const samples = createAlignedHitReactionSamples();

  const result = summarizeDuelHitReactionTelemetry(samples);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.healthDropEvents, 4);
  assert.equal(result.metrics.triggerIncrements, 4);
  assert.equal(result.metrics.unmatchedHealthDrops, 0);
  assert.equal(result.metrics.unmatchedTriggerIncrements, 0);
});

test("accepts reaction overlap with a real non-idle crossfade contributor", () => {
  const samples = createAlignedHitReactionSamples();
  for (const sample of samples) {
    for (const agent of sample.agents) {
      agent.avatarEmote = "asset://emotes/emote-idle.glb";
      agent.authoredMotion = authoredMotion(undefined, {
        actions: [
          {
            url: "asset://emotes/emote-idle.glb",
            running: true,
            paused: false,
            effectiveWeight: 0.55,
          },
          {
            url: "asset://emotes/emote_sword_swing.glb",
            running: true,
            paused: false,
            effectiveWeight: 0.45,
          },
        ],
      });
    }
  }

  const result = summarizeDuelHitReactionTelemetry(samples);
  assert.equal(result.ok, true);
  assert.ok(result.metrics.activeAuthoredMotionSamples > 0);
});

test("rejects stale requested emotes and incomplete authored mixer evidence", () => {
  const cases = [
    null,
    authoredMotion(undefined, { actions: [] }),
    authoredMotion("asset://emotes/emote-idle.glb"),
    authoredMotion(undefined, {
      actions: [
        {
          url: "asset://emotes/emote_sword_swing.glb",
          running: false,
          paused: true,
          effectiveWeight: 0.8,
        },
      ],
    }),
    authoredMotion(undefined, { overflow: true }),
  ];

  for (const evidence of cases) {
    const samples = createAlignedHitReactionSamples();
    for (const sample of samples) {
      for (const agent of sample.agents) {
        agent.avatarEmote = "asset://emotes/emote_sword_swing.glb";
        agent.authoredMotion = evidence;
      }
    }
    const result = summarizeDuelHitReactionTelemetry(samples);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find(
        (entry) =>
          entry.label === "reaction overlays an active authored motion",
      )?.pass,
      false,
    );
  }
});

test("accepts an approved compact rig only at its exact declared recoil-bone count", () => {
  const samples = [
    [40, 40, 0, 0],
    [35, 40, 1, 0],
    [35, 34, 1, 1],
    [30, 34, 2, 1],
    [30, 29, 2, 2],
  ].map(([hpA, hpB, triggerA, triggerB], index) => ({
    observedAt: index * 100,
    cycleId: "cycle-compact-rig",
    agents: [
      { id: "agent-a", hp: hpA, triggerCount: triggerA },
      { id: "agent-b", hp: hpB, triggerCount: triggerB },
    ].map(({ id, hp, triggerCount }) => ({
      id,
      hp,
      maxHp: 40,
      attacksLanded: index,
      avatarEmote: "asset://emotes/emote_sword_swing.glb",
      authoredMotion: authoredMotion(),
      hitReaction: {
        availableBoneCount: 3,
        requiredBoneCount: 3,
        triggerCount,
        active: index > 0,
        elapsedSeconds: index > 0 ? 0.08 : null,
        currentWeight: index > 0 ? 0.7 : 0,
        lastIntensity: index > 0 ? 0.8 : 0,
        lastSide: 1,
      },
    })),
  }));

  const passing = summarizeDuelHitReactionTelemetry(samples);
  assert.equal(passing.ok, true);
  assert.deepEqual(passing.metrics.agents[0].requiredBoneCounts, [3]);

  samples[2].agents[0].hitReaction.availableBoneCount = 2;
  assert.equal(summarizeDuelHitReactionTelemetry(samples).ok, false);
});

test("excludes a fight first observed after damage from exact reaction alignment", () => {
  const reaction = (triggerCount, active = false) => ({
    availableBoneCount: 5,
    triggerCount,
    active,
    elapsedSeconds: active ? 0.08 : null,
    currentWeight: active ? 0.7 : 0,
    lastIntensity: active ? 0.8 : 0,
    lastSide: 1,
  });
  const partial = [
    {
      observedAt: 0,
      cycleId: "cycle-partial",
      agents: [
        {
          id: "agent-a",
          hp: 35,
          maxHp: 40,
          attacksLanded: 0,
          hitReaction: reaction(1),
        },
        {
          id: "agent-b",
          hp: 40,
          maxHp: 40,
          attacksLanded: 1,
          hitReaction: reaction(0),
        },
      ],
    },
    {
      observedAt: 100,
      cycleId: "cycle-partial",
      agents: [
        {
          id: "agent-a",
          hp: 34,
          maxHp: 40,
          attacksLanded: 0,
          hitReaction: reaction(1),
        },
        {
          id: "agent-b",
          hp: 40,
          maxHp: 40,
          attacksLanded: 2,
          hitReaction: reaction(0),
        },
      ],
    },
  ];
  const hpBySample = [
    [40, 40],
    [40, 34],
    [35, 34],
    [35, 29],
    [31, 29],
  ];
  const triggerBySample = [
    [1, 0],
    [1, 1],
    [2, 1],
    [2, 2],
    [3, 2],
  ];
  const complete = hpBySample.map((health, index) => ({
    observedAt: 1_000 + index * 100,
    cycleId: "cycle-complete",
    agents: ["agent-a", "agent-b"].map((id, agentIndex) => ({
      id,
      hp: health[agentIndex],
      maxHp: 40,
      attacksLanded: index === 0 ? 0 : index,
      avatarEmote: "asset://emotes/emote_sword_swing.glb",
      authoredMotion: authoredMotion(),
      hitReaction: reaction(triggerBySample[index][agentIndex], index > 0),
    })),
  }));

  const result = summarizeDuelHitReactionTelemetry([...partial, ...complete]);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.sampleCount, 7);
  assert.equal(result.metrics.evaluatedSampleCount, 5);
  assert.equal(result.metrics.completeCycleCount, 1);
  assert.equal(result.metrics.incompleteCycleCount, 1);
  assert.equal(result.metrics.healthDropEvents, 4);
  assert.equal(result.metrics.triggerIncrements, 4);
  assert.equal(result.metrics.unmatchedHealthDrops, 0);
});

test("aligns adjacent projection windows but rejects a sustained reaction delay", () => {
  const sample = (observedAt, hp, triggerCount) => ({
    observedAt,
    cycleId: "cycle-windowed-alignment",
    agents: [
      {
        id: "agent-a",
        hp,
        maxHp: 40,
        attacksLanded: hp < 40 ? 1 : 0,
        avatarEmote: "asset://emotes/emote_sword_swing.glb",
        authoredMotion: authoredMotion(),
        hitReaction: {
          availableBoneCount: 5,
          triggerCount,
          active: triggerCount > 0,
          elapsedSeconds: triggerCount > 0 ? 0.08 : null,
          currentWeight: triggerCount > 0 ? 0.7 : 0,
          lastIntensity: triggerCount > 0 ? 0.8 : 0,
          lastSide: 1,
        },
      },
      {
        id: "agent-b",
        hp,
        maxHp: 40,
        attacksLanded: hp < 40 ? 1 : 0,
        avatarEmote: "asset://emotes/emote_sword_swing.glb",
        authoredMotion: authoredMotion(),
        hitReaction: {
          availableBoneCount: 5,
          triggerCount,
          active: triggerCount > 0,
          elapsedSeconds: triggerCount > 0 ? 0.08 : null,
          currentWeight: triggerCount > 0 ? 0.7 : 0,
          lastIntensity: triggerCount > 0 ? 0.8 : 0,
          lastSide: 1,
        },
      },
    ],
  });
  const repeated = (startAt) => [
    sample(startAt, 40, 0),
    sample(startAt + 100, 35, 0),
    sample(startAt + 800, 35, 1),
    sample(startAt + 900, 30, 1),
    sample(startAt + 1_000, 30, 2),
    sample(startAt + 1_100, 25, 2),
    sample(startAt + 1_200, 25, 3),
    sample(startAt + 1_300, 20, 3),
    sample(startAt + 1_400, 20, 4),
  ];

  const adjacent = summarizeDuelHitReactionTelemetry(repeated(0));
  assert.equal(adjacent.ok, true);
  assert.equal(adjacent.metrics.maximumAlignmentGapMs, 0);
  assert.equal(adjacent.metrics.maximumObservedPointSkewMs, 700);

  const delayed = repeated(10_000);
  delayed.splice(2, 0, sample(10_700, 35, 0));
  const rejected = summarizeDuelHitReactionTelemetry(delayed);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.metrics.maximumAlignmentGapMs, 600);
  assert.equal(rejected.metrics.unmatchedHealthDrops, 2);
  assert.equal(rejected.metrics.unmatchedTriggerIncrements, 2);
});

test("rejects missing, reset, or health-desynchronized reaction telemetry", () => {
  const samples = [
    {
      observedAt: 0,
      cycleId: "cycle-hit",
      agents: [
        { id: "agent-a", hp: 40, hitReaction: null },
        { id: "agent-b", hp: 40, hitReaction: null },
      ],
    },
    {
      observedAt: 100,
      cycleId: "cycle-hit",
      agents: [
        {
          id: "agent-a",
          hp: 30,
          avatarEmote: "asset://emotes/emote-idle.glb",
          hitReaction: {
            availableBoneCount: 4,
            triggerCount: 0,
            active: false,
            elapsedSeconds: null,
            currentWeight: 0,
            lastIntensity: 0,
            lastSide: 1,
          },
        },
        { id: "agent-b", hp: 40, hitReaction: null },
      ],
    },
  ];

  const result = summarizeDuelHitReactionTelemetry(samples);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].pass, true);
  assert.ok(result.checks.slice(1).every((entry) => entry.pass === false));
});

test("requires a reacted cycle to settle cleanly through resolution", () => {
  const reaction = (triggerCount, overrides = {}) => ({
    availableBoneCount: 5,
    triggerCount,
    active: false,
    elapsedSeconds: null,
    currentWeight: 0,
    lastIntensity: 0,
    lastSide: 1,
    ...overrides,
  });
  const fightingSamples = [
    {
      observedAt: 100,
      cycleId: "cycle-terminal",
      agents: [
        { id: "agent-a", hitReaction: reaction(2) },
        { id: "agent-b", hitReaction: reaction(1) },
      ],
    },
  ];
  const lifecycleSamples = [
    {
      observedAt: 200,
      cycleId: "cycle-terminal",
      phase: "RESOLUTION",
      agents: [
        {
          id: "agent-a",
          hitReaction: reaction(2, {
            active: true,
            elapsedSeconds: 0.2,
            currentWeight: 0.1,
            lastIntensity: 0.7,
          }),
        },
        { id: "agent-b", hitReaction: reaction(1) },
      ],
    },
    {
      observedAt: 600,
      cycleId: "cycle-terminal",
      phase: "RESOLUTION",
      agents: [
        { id: "agent-a", hitReaction: reaction(2) },
        { id: "agent-b", hitReaction: reaction(1) },
      ],
    },
    {
      observedAt: 850,
      cycleId: "cycle-terminal",
      phase: "RESOLUTION",
      agents: [
        { id: "agent-a", hitReaction: reaction(2) },
        { id: "agent-b", hitReaction: reaction(1) },
      ],
    },
  ];

  const passing = summarizeDuelHitReactionResolutionTelemetry(
    fightingSamples,
    lifecycleSamples,
  );
  assert.equal(passing.ok, true);
  assert.equal(passing.metrics.cleanCycleCount, 1);

  lifecycleSamples[2].agents[0].hitReaction = reaction(1, {
    active: true,
    elapsedSeconds: 0.1,
    currentWeight: 0.3,
    lastIntensity: 0.6,
  });
  const failing = summarizeDuelHitReactionResolutionTelemetry(
    fightingSamples,
    lifecycleSamples,
  );
  assert.equal(failing.ok, false);
  assert.equal(failing.metrics.cycles[0].dirtySamples, 1);
  assert.equal(failing.metrics.cycles[0].sequenceRegressions, 1);
});
