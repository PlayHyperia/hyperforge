import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  buildDuelFullTopologyViewerChecks,
  buildDuelFullTopologyViewerCoverageCheck,
  DuelFullTopologyViewerTracker,
  hasExactDuelFullTopologyViewerBaseline,
  retainDuelFullTopologyViewerReadiness,
} from "./duel-full-topology-viewer-policy.mjs";

const marker = "viewer-marker";
const timeOrigin = 1_000_000;
const streamSource = "http://127.0.0.1:35551/live/stream.m3u8";
const smokeSource = readFileSync(
  new URL("./smoke-duel-launch.mjs", import.meta.url),
  "utf8",
);

function state(currentTime, overrides = {}) {
  return {
    marker,
    timeOrigin,
    navigationEntries: 1,
    rootPresent: true,
    wagerControlCount: 1,
    submitEnabled: true,
    browserObservedAtMs: timeOrigin + (currentTime - 10) * 1_000,
    browserPerformanceNowMs: 0,
    readiness: {
      schemaVersion: 1,
      evaluatedNowMs: timeOrigin,
      recoveryMode: "hidden",
      hookRendererReady: true,
      currentPresentationRendererReady: true,
      currentConnected: true,
      presentationConnected: true,
      playbackReady: true,
      playbackDateMs: timeOrigin - 4_000,
      maxAgeMs: 10_000,
      uiSyncDelayMs: 4_000,
      current: {
        seq: 10,
        emittedAt: timeOrigin,
        cycleId: "cycle-1",
        duelId: "streaming-cycle-1",
        duelKeyHex: "11".repeat(32),
        phase: "ANNOUNCEMENT",
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: timeOrigin,
        },
      },
      presentation: null,
    },
    recovery: { visible: false, mode: "hidden", heading: null },
    authority: {
      streamCycleId: "cycle-1",
      streamDuelId: "streaming-cycle-1",
      streamDuelKey: "11".repeat(32),
      marketDuelId: "streaming-cycle-1",
      marketDuelKey: "11".repeat(32),
      marketMode: "open",
      marketReason: "ready",
      marketCanPlaceBet: true,
    },
    video: {
      currentTime,
      declaredSource: streamSource,
      paused: false,
      readyState: 4,
    },
    ...overrides,
  };
}

function metrics(heap = 40_000_000, nodes = 2_000, documents = 2) {
  return { JSHeapUsedSize: heap, Nodes: nodes, Documents: documents };
}

describe("full-topology Hyperbet viewer policy", () => {
  it("runs one isolated browser for the soak and always closes it", () => {
    expect(smokeSource).toContain("monitorFullTopologyViewer(");
    expect(smokeSource).toContain(
      "ownedViewer = await launchOwnedDuelViewer({",
    );
    expect(smokeSource).toMatch(
      /async function monitorFullTopologyViewer[\s\S]*?try \{[\s\S]*?\} finally \{\s*if \(ownedViewer\) browserCleanup = await ownedViewer\.close\(\)/,
    );
    expect(smokeSource).toContain(
      'label: "full-topology Hyperbet soak browser closed in teardown"',
    );
    expect(smokeSource).toContain("settleDuelFullTopologySoakTasks({");
    expect(smokeSource).toContain("{ signal: monitorAbortController.signal }");
    expect(smokeSource).toContain("if (tracker.issueOccurrences > 0) break;");
    expect(smokeSource).toContain("runDuelViewerOperation(callback, {");
    expect(smokeSource).toContain("browserCleanup.forcedCleanup === false");
    expect(smokeSource).toContain("workflowFailure === null");
    expect(smokeSource).not.toContain("await browser.close().catch");
    expect(smokeSource).not.toMatch(/Google Chrome|Brave Browser/);
  });

  it("starts evidence only on the exact fresh duel and tradeable market", () => {
    const baseline = state(10);
    expect(
      hasExactDuelFullTopologyViewerBaseline(baseline, {
        cycleId: "cycle-1",
        duelId: "streaming-cycle-1",
        duelKey: "11".repeat(32),
        expectedStreamSource: streamSource,
      }),
    ).toBe(true);
    expect(
      hasExactDuelFullTopologyViewerBaseline(
        {
          ...baseline,
          authority: {
            ...baseline.authority,
            streamCycleId: null,
            marketCanPlaceBet: false,
          },
          wagerControlCount: 0,
          submitEnabled: false,
        },
        {
          cycleId: "cycle-1",
          duelId: "streaming-cycle-1",
          duelKey: "11".repeat(32),
          expectedStreamSource: streamSource,
        },
      ),
    ).toBe(false);
  });

  it("retains one navigation epoch, advancing playback, and bounded resources", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    tracker.observe({
      state: state(10),
      metrics: metrics(),
      observedAt: 1_000_000,
    });
    tracker.observe({
      state: state(12),
      metrics: metrics(42_000_000, 2_100, 2),
      observedAt: 1_002_000,
    });
    const summary = tracker.summary();
    expect(summary).toMatchObject({
      observations: 2,
      validObservations: 2,
      issueOccurrences: 0,
      videoAdvanceSeconds: 2,
      playbackRatio: 1,
      cycleIds: ["cycle-1"],
    });
    expect(
      buildDuelFullTopologyViewerChecks(summary).every((check) => check.pass),
    ).toBe(true);
  });

  it("accepts a non-tradeable intermission only with zero actionable controls", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    const intermission = state(10, {
      wagerControlCount: 0,
      submitEnabled: false,
      authority: {
        streamCycleId: null,
        streamDuelId: null,
        streamDuelKey: null,
        marketDuelId: "streaming-cycle-0",
        marketDuelKey: "22".repeat(32),
        marketMode: "unavailable",
        marketReason: "no-current-matchup",
        marketCanPlaceBet: false,
      },
    });
    tracker.observe({
      state: intermission,
      metrics: metrics(),
      observedAt: 1_000_000,
    });
    expect(tracker.summary().issueOccurrences).toBe(0);
  });

  it("fails on navigation drift, unsafe controls, playback regression, and resource ceilings", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
      maxHeapBytes: 100,
      maxHeapGrowthBytes: 10,
      maxDomNodes: 10,
      maxDocuments: 2,
    });
    tracker.observe({
      state: state(10),
      metrics: metrics(50, 5, 1),
      observedAt: 1_000_000,
    });
    tracker.observe({
      state: state(9, {
        marker: "replacement",
        timeOrigin: timeOrigin + 1,
        navigationEntries: 2,
        wagerControlCount: 2,
        authority: {
          streamCycleId: null,
          streamDuelId: null,
          streamDuelKey: null,
          marketDuelId: null,
          marketDuelKey: null,
          marketMode: "unavailable",
          marketReason: "stream-stale",
          marketCanPlaceBet: false,
        },
      }),
      metrics: metrics(101, 11, 3),
      observedAt: 1_002_000,
    });
    const summary = tracker.summary();
    expect(summary.issueCounts).toMatchObject({
      viewer_marker_changed: 1,
      viewer_time_origin_changed: 1,
      viewer_navigation_count_changed: 1,
      viewer_video_time_regressed: 1,
      viewer_disabled_state_has_actionable_controls: 1,
      viewer_heap_ceiling_exceeded: 1,
      viewer_dom_nodes_ceiling_exceeded: 1,
      viewer_documents_ceiling_exceeded: 1,
    });
    expect(
      buildDuelFullTopologyViewerChecks(summary).every((check) => check.pass),
    ).toBe(false);
  });

  it("fails once decoded playback exceeds the bounded stall allowance", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
      maxConsecutiveStalls: 2,
    });
    for (let index = 0; index < 4; index += 1) {
      tracker.observe({
        state: state(10),
        metrics: metrics(),
        observedAt: 1_000_000 + index * 2_000,
      });
    }
    expect(tracker.summary().issueCounts).toMatchObject({
      viewer_video_stalled: 1,
    });
  });

  it("rejects a recovery overlay even when decoded video advances and betting fails closed", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    const healthy = state(10);
    tracker.observe({
      state: healthy,
      metrics: metrics(),
      observedAt: timeOrigin,
    });
    const outage = state(12, {
      wagerControlCount: 0,
      submitEnabled: false,
      authority: {
        ...healthy.authority,
        marketMode: "unavailable",
        marketReason: "stream-disconnected",
        marketCanPlaceBet: false,
      },
      readiness: {
        ...healthy.readiness,
        recoveryMode: "blocking",
        currentPresentationRendererReady: false,
      },
      recovery: {
        visible: true,
        mode: "blocking",
        heading: "Live arena view temporarily unavailable",
      },
    });
    tracker.observe({
      state: outage,
      metrics: metrics(),
      observedAt: timeOrigin + 2_000,
    });
    const summary = tracker.summary();
    expect(summary.playbackRatio).toBe(1);
    expect(summary.wagerSafetyIssueOccurrences).toBe(0);
    expect(summary.experienceIssueOccurrences).toBe(2);
    expect(summary.issueCounts).toMatchObject({
      viewer_recovery_visible: 1,
      viewer_renderer_unready: 1,
    });
    const checks = buildDuelFullTopologyViewerChecks(summary);
    expect(
      checks.find((check) => check.label.endsWith("experience continuity held"))
        ?.pass,
    ).toBe(false);
    expect(
      checks.find((check) =>
        check.label.endsWith("wagering authority violations == 0"),
      )?.pass,
    ).toBe(true);
    expect(summary.stateTransitions).toHaveLength(2);
    expect(summary.lastState.recovery.heading).toBe(outage.recovery.heading);
  });

  it("rejects an otherwise exact baseline and actionable bets under a recovery overlay", () => {
    const candidate = state(10);
    candidate.recovery = {
      visible: true,
      mode: "blocking",
      heading: "Unavailable",
    };
    candidate.readiness.recoveryMode = "blocking";
    expect(
      hasExactDuelFullTopologyViewerBaseline(candidate, {
        cycleId: "cycle-1",
        duelId: "streaming-cycle-1",
        duelKey: "11".repeat(32),
        expectedStreamSource: streamSource,
      }),
    ).toBe(false);
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    tracker.observe({ state: candidate, metrics: metrics() });
    expect(tracker.summary().issueCounts.viewer_tradeable_during_recovery).toBe(
      1,
    );
  });

  it("retains a capture-time authority change and does not count screenshot brackets as extra playback polls", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
      maxConsecutiveStalls: 1,
    });
    tracker.observe({
      state: state(10),
      metrics: metrics(),
      observedAt: timeOrigin,
      source: "baseline",
    });
    tracker.observe({
      state: state(12),
      metrics: metrics(),
      observedAt: timeOrigin + 2_000,
    });
    for (let index = 0; index < 4; index += 1) {
      tracker.observe({
        state: state(12),
        metrics: metrics(),
        observedAt: timeOrigin + 2_010 + index,
        source: "end-screenshot-before",
        measurePlayback: false,
      });
    }
    const after = state(12, {
      wagerControlCount: 0,
      submitEnabled: false,
      authority: {
        ...state(12).authority,
        marketCanPlaceBet: false,
        marketReason: "stream-disconnected",
      },
      recovery: {
        visible: true,
        mode: "blocking",
        heading: "Live arena view temporarily unavailable",
      },
      readiness: {
        ...state(12).readiness,
        recoveryMode: "blocking",
        hookRendererReady: false,
      },
    });
    tracker.observe({
      state: after,
      metrics: metrics(),
      observedAt: timeOrigin + 2_200,
      completedAt: timeOrigin + 2_205,
      source: "end-screenshot-after",
      measurePlayback: false,
    });
    const summary = tracker.summary();
    expect(summary.playbackMeasurements).toBe(2);
    expect(summary.maxObservedConsecutiveStalls).toBe(0);
    expect(summary.issueCounts.viewer_video_stalled).toBeUndefined();
    expect(summary.lastState.source).toBe("end-screenshot-after");
    expect(summary.lastState.marketCanPlaceBet).toBe(false);
    expect(summary.lastState.completedAt).toBe(timeOrigin + 2_205);
    expect(summary.experienceIssueOccurrences).toBeGreaterThan(0);
  });

  it("requires present, typed readiness diagnostics and keeps retained public fields bounded", () => {
    for (const readiness of [
      null,
      {},
      { ...state(10).readiness, hookRendererReady: "true" },
    ]) {
      const tracker = new DuelFullTopologyViewerTracker({
        marker,
        timeOrigin,
        expectedStreamSource: streamSource,
      });
      tracker.observe({ state: state(10, { readiness }), metrics: metrics() });
      expect(
        tracker.summary().issueCounts.viewer_readiness_diagnostics_invalid,
      ).toBe(1);
    }
    const retained = retainDuelFullTopologyViewerReadiness({
      ...state(10).readiness,
      privateExtra: "must not survive",
      current: {
        ...state(10).readiness.current,
        cycleId: "x".repeat(1_000),
        privateExtra: "must not survive",
        rendererHealth: {
          ready: true,
          updatedAt: Number.POSITIVE_INFINITY,
          degradedReason: "y".repeat(1_000),
          privateExtra: "must not survive",
        },
      },
    });
    expect(JSON.stringify(retained)).not.toContain("must not survive");
    expect(retained.current.cycleId.length).toBe(160);
    expect(retained.current.rendererHealth.degradedReason.length).toBe(160);
    expect(retained.current.rendererHealth.updatedAt).toBeNull();
  });

  it("retains exact phase derivation inputs without turning them into authority", () => {
    const candidate = state(10);
    const derivation = {
      schemaVersion: 1,
      evaluatedAtMs: timeOrigin,
      canonicalCycleId: "cycle-1",
      canonicalPhase: "COUNTDOWN",
      externalSnapshotPresent: true,
      externalSnapshotUpdatedAt: timeOrigin - 500,
      rendererPresent: true,
      rendererReady: true,
      rendererPhase: "ANNOUNCEMENT",
      rendererDegradedReason: null,
      rendererUpdatedAt: timeOrigin - 1000,
      scenePresent: true,
      sceneReady: true,
      sceneCycleId: "cycle-1",
      scenePhase: "ANNOUNCEMENT",
      captureClientConnected: true,
      captureFfmpegRunning: true,
    };
    candidate.readiness.current.rendererHealth = {
      ready: false,
      degradedReason: "renderer_phase_mismatch",
      updatedAt: timeOrigin,
      derivation,
    };
    const retained = retainDuelFullTopologyViewerReadiness(candidate.readiness);
    expect(retained.current.rendererHealth.derivation).toEqual(derivation);
    derivation.canonicalPhase = "mutated";
    expect(retained.current.rendererHealth.derivation.canonicalPhase).toBe(
      "COUNTDOWN",
    );
    candidate.readiness = retained;
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    tracker.observe({ state: candidate, metrics: metrics() });
    expect(
      tracker.summary().issueCounts.viewer_current_authority_renderer_unready,
    ).toBe(1);
  });

  it("bounds optional derivation fields and retains future times only as diagnostic evidence", () => {
    const candidate = state(10);
    candidate.readiness.current.rendererHealth.derivation = {
      schemaVersion: 1,
      evaluatedAtMs: timeOrigin + 10_000,
      externalSnapshotUpdatedAt: Infinity,
      rendererUpdatedAt: 1.5,
      canonicalCycleId: "x".repeat(129),
      canonicalPhase: "x".repeat(33),
      rendererPhase: "FIGHTING",
      rendererDegradedReason: "https://example.invalid/private",
      sceneCycleId: "cycle-1",
      scenePhase: "ANNOUNCEMENT",
      externalSnapshotPresent: true,
      rendererPresent: true,
      rendererReady: "true",
      scenePresent: true,
      sceneReady: false,
      captureClientConnected: null,
      captureFfmpegRunning: true,
      privateExtra: "must not survive",
    };
    const retained = retainDuelFullTopologyViewerReadiness(candidate.readiness)
      .current.rendererHealth.derivation;
    expect(retained.evaluatedAtMs).toBe(timeOrigin + 10_000);
    expect(retained.externalSnapshotUpdatedAt).toBeNull();
    expect(retained.rendererUpdatedAt).toBeNull();
    expect(retained.canonicalCycleId).toBeNull();
    expect(retained.canonicalPhase).toBeNull();
    expect(retained.rendererDegradedReason).toBeNull();
    expect(retained.rendererReady).toBeNull();
    expect(retained.sceneReady).toBe(false);
    expect(JSON.stringify(retained)).not.toContain("must not survive");
    expect(JSON.stringify(retained).length).toBeLessThan(2048);
    for (const invalid of [null, [], {}, { schemaVersion: 2 }]) {
      candidate.readiness.current.rendererHealth.derivation = invalid;
      expect(
        retainDuelFullTopologyViewerReadiness(candidate.readiness).current
          .rendererHealth.derivation,
      ).toBeNull();
    }
    delete candidate.readiness.current.rendererHealth.derivation;
    expect(
      retainDuelFullTopologyViewerReadiness(candidate.readiness).current
        .rendererHealth,
    ).not.toHaveProperty("derivation");
  });

  it("retains renderer phase transitions but not derivation heartbeat timestamps", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
      maxStateTransitions: 2,
    });
    for (let index = 0; index < 4; index += 1) {
      const next = state(10 + index * 2);
      const now = timeOrigin + index * 2000;
      next.readiness.evaluatedNowMs = now;
      next.readiness.current.emittedAt = now;
      next.readiness.current.rendererHealth.updatedAt = now;
      next.readiness.current.rendererHealth.derivation = {
        schemaVersion: 1,
        evaluatedAtMs: now,
        externalSnapshotUpdatedAt: now,
        rendererUpdatedAt: now,
        canonicalCycleId: "cycle-1",
        canonicalPhase: "ANNOUNCEMENT",
        externalSnapshotPresent: true,
        rendererPresent: true,
        rendererReady: true,
        rendererPhase: index < 3 ? "ANNOUNCEMENT" : "COUNTDOWN",
        rendererDegradedReason: null,
        scenePresent: true,
        sceneReady: true,
        sceneCycleId: "cycle-1",
        scenePhase: index < 3 ? "ANNOUNCEMENT" : "COUNTDOWN",
        captureClientConnected: true,
        captureFfmpegRunning: true,
      };
      tracker.observe({ state: next, metrics: metrics(), observedAt: now });
    }
    const summary = tracker.summary();
    expect(summary.stateTransitionCount).toBe(2);
    expect(summary.stateTransitionsOmitted).toBe(0);
    expect(
      summary.stateTransitions[0].readiness.current.rendererHealth.derivation
        .rendererUpdatedAt,
    ).toBe(timeOrigin);
    expect(
      summary.stateTransitions[1].readiness.current.rendererHealth.derivation
        .rendererPhase,
    ).toBe("COUNTDOWN");
  });

  it("retains bounded semantic transitions rather than every heartbeat clock update", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
      maxStateTransitions: 2,
    });
    for (let index = 0; index < 8; index += 1) {
      const next = state(10 + index * 2);
      next.readiness.evaluatedNowMs += index * 2_000;
      next.readiness.current.seq += index;
      next.readiness.current.rendererHealth.updatedAt += index * 2_000;
      if (index > 3) next.authority.marketReason = `reason-${index}`;
      tracker.observe({
        state: next,
        metrics: metrics(),
        observedAt: timeOrigin + index * 2_000,
      });
    }
    const summary = tracker.summary();
    expect(summary.stateTransitionCount).toBe(5);
    expect(summary.stateTransitions).toHaveLength(2);
    expect(summary.stateTransitionsOmitted).toBe(3);
    expect(summary.lastState.marketReason).toBe("reason-7");
  });

  it("requires backend observation through the viewer's actual completion, not its earlier poll deadline", () => {
    const finish = 1_500_000;
    expect(
      buildDuelFullTopologyViewerCoverageCheck(
        { lastObservedAt: finish - 1 },
        finish,
      ).pass,
    ).toBe(false);
    expect(
      buildDuelFullTopologyViewerCoverageCheck(
        { lastObservedAt: finish },
        finish,
      ).pass,
    ).toBe(true);
    expect(
      buildDuelFullTopologyViewerCoverageCheck(
        { lastObservedAt: finish + 1 },
        finish,
      ).pass,
    ).toBe(true);
    expect(
      buildDuelFullTopologyViewerCoverageCheck({ lastObservedAt: finish }, null)
        .pass,
    ).toBe(false);
    expect(smokeSource).toContain('await observe("baseline", true, baseline)');
    expect(smokeSource).toContain(
      "await observe(`${label}-screenshot-before`, false)",
    );
    expect(smokeSource).toContain(
      "await observe(`${label}-screenshot-after`, false)",
    );
    expect(smokeSource).toContain("viewerLifecycle.finishedAtMs = Date.now()");
    expect(smokeSource).toContain("screenshotObservations,");
  });

  it("does not trust frozen ready flags while the real browser clock and video advance", () => {
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    tracker.observe({
      state: state(10),
      metrics: metrics(),
      observedAt: timeOrigin,
    });
    tracker.observe({
      state: state(70),
      metrics: metrics(),
      observedAt: timeOrigin + 60_000,
    });
    const summary = tracker.summary();
    expect(summary.playbackRatio).toBe(1);
    expect(summary.issueCounts.viewer_evaluation_clock_invalid_or_stale).toBe(
      1,
    );
    expect(
      summary.issueCounts.viewer_current_authority_clock_invalid_or_stale,
    ).toBe(1);
    expect(summary.issueCounts.viewer_tradeable_during_recovery).toBe(1);
    expect(
      buildDuelFullTopologyViewerChecks(summary).every((check) => check.pass),
    ).toBe(false);
  });

  it("keeps the captured fresh phase mismatch failed without misreporting a clock failure", () => {
    // Exact public times/reason from pass7's first failing viewer observation;
    // the immutable report remains failed and is not reclassified by this test.
    const candidate = state(10);
    candidate.browserObservedAtMs = 1788594406502;
    candidate.readiness.evaluatedNowMs = 1788594406266;
    candidate.readiness.current.emittedAt = 1788594406169;
    candidate.readiness.current.phase = "COUNTDOWN";
    candidate.readiness.current.rendererHealth = {
      ready: false,
      degradedReason: "renderer_phase_mismatch",
      updatedAt: 1788594406169,
    };
    candidate.readiness.hookRendererReady = false;
    candidate.readiness.currentPresentationRendererReady = false;
    candidate.readiness.recoveryMode = "blocking";
    candidate.recovery = {
      visible: true,
      mode: "blocking",
      heading: "Live arena view temporarily unavailable",
    };
    candidate.authority.marketCanPlaceBet = false;
    candidate.authority.marketMode = "unavailable";
    candidate.authority.marketReason = "stream-disconnected";
    candidate.wagerControlCount = 0;
    candidate.submitEnabled = false;
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    tracker.observe({
      state: candidate,
      metrics: metrics(),
      observedAt: candidate.browserObservedAtMs,
    });
    const summary = tracker.summary();
    expect(summary.experienceIssueOccurrences).toBe(3);
    expect(summary.wagerSafetyIssueOccurrences).toBe(0);
    expect(summary.issueCounts).toEqual({
      viewer_recovery_visible: 1,
      viewer_renderer_unready: 1,
      viewer_current_authority_renderer_unready: 1,
    });
    expect(
      buildDuelFullTopologyViewerChecks(summary).find((check) =>
        check.label.endsWith("experience continuity held"),
      )?.pass,
    ).toBe(false);
  });

  it.each([
    { ready: false, degradedReason: null },
    { ready: true, degradedReason: "renderer_phase_mismatch" },
    { ready: false, degradedReason: "capture_pipeline_inactive" },
  ])(
    "independently rejects current renderer health %j with otherwise fresh clocks",
    (health) => {
      const candidate = state(10);
      Object.assign(candidate.readiness.current.rendererHealth, health);
      const tracker = new DuelFullTopologyViewerTracker({
        marker,
        timeOrigin,
        expectedStreamSource: streamSource,
      });
      tracker.observe({ state: candidate, metrics: metrics() });
      const summary = tracker.summary();
      expect(
        summary.issueCounts.viewer_current_authority_renderer_unready,
      ).toBe(1);
      expect(
        summary.issueCounts.viewer_current_authority_clock_invalid_or_stale,
      ).toBeUndefined();
      expect(summary.issueCounts.viewer_tradeable_during_recovery).toBe(1);
      expect(
        hasExactDuelFullTopologyViewerBaseline(candidate, {
          cycleId: "cycle-1",
          duelId: "streaming-cycle-1",
          duelKey: "11".repeat(32),
          expectedStreamSource: streamSource,
        }),
      ).toBe(false);
    },
  );

  it("reports both stale time and negative health instead of letting either hide the other", () => {
    const candidate = state(70);
    candidate.readiness.evaluatedNowMs = candidate.browserObservedAtMs;
    candidate.readiness.current.rendererHealth.ready = false;
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    tracker.observe({ state: candidate, metrics: metrics() });
    const summary = tracker.summary();
    expect(summary.issueCounts.viewer_current_authority_renderer_unready).toBe(
      1,
    );
    expect(
      summary.issueCounts.viewer_current_authority_clock_invalid_or_stale,
    ).toBe(1);
  });

  it("rejects future observation clocks and stale authority even if the UI keeps rerendering", () => {
    const candidate = state(10);
    candidate.readiness.evaluatedNowMs += 1;
    const tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    tracker.observe({ state: candidate, metrics: metrics() });
    expect(
      tracker.summary().issueCounts.viewer_evaluation_clock_invalid_or_stale,
    ).toBe(1);
    const oldAuthority = state(70);
    oldAuthority.readiness.evaluatedNowMs = oldAuthority.browserObservedAtMs;
    const refreshed = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin,
      expectedStreamSource: streamSource,
    });
    refreshed.observe({ state: oldAuthority, metrics: metrics() });
    expect(
      refreshed.summary().issueCounts.viewer_evaluation_clock_invalid_or_stale,
    ).toBeUndefined();
    expect(
      refreshed.summary().issueCounts
        .viewer_current_authority_clock_invalid_or_stale,
    ).toBe(1);
  });
});
