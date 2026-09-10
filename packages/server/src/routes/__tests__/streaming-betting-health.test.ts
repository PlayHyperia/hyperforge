import { describe, expect, it } from "vitest";

import type { StreamingDuelCycle } from "../../systems/StreamingDuelScheduler/types.js";
import type { ExternalRtmpStatusSnapshot } from "../streaming-external-status.js";
import { deriveBettingRendererHealth } from "../streaming-betting-health.js";

function announcementCycle(
  arenaPositions: StreamingDuelCycle["arenaPositions"],
): StreamingDuelCycle {
  return {
    cycleId: "cycle-a",
    phase: "ANNOUNCEMENT",
    agent1: {
      characterId: "agent-a",
      name: "Agent A",
      currentHp: 50,
      maxHp: 50,
    },
    agent2: {
      characterId: "agent-b",
      name: "Agent B",
      currentHp: 50,
      maxHp: 50,
    },
    arenaPositions,
  } as StreamingDuelCycle;
}

function externalRendererSnapshot(
  overrides: {
    cycleId?: string | null;
    phase?: string | null;
    sceneReady?: boolean;
    diagnostics?: boolean;
  } = {},
): ExternalRtmpStatusSnapshot {
  const phase =
    overrides.phase === undefined ? "ANNOUNCEMENT" : overrides.phase;
  const diagnostics =
    overrides.diagnostics === false
      ? undefined
      : {
          sceneReadiness: {
            ready: overrides.sceneReady ?? true,
            cycleId:
              overrides.cycleId === undefined ? "cycle-a" : overrides.cycleId,
            phase,
            equipmentVisualsReady: true,
            equipmentConfigured: true,
            equipmentCycleId: "cycle-a",
            equipmentRequiredCount: 2,
            equipmentRequiredPlayerCount: 2,
            equipmentReadyCount: 2,
            equipmentExpectedPlayerCount: 2,
            equipmentActiveVisualCount: 2,
            equipmentActiveVisibleCount: 2,
            equipmentActivePlayerCount: 2,
            equipmentActiveVisiblePlayerCount: 2,
            equipmentUnresolvedCount: 0,
            equipmentAttachmentMismatchCount: 0,
            expectedAgentCount: 2,
          },
        };
  return {
    destinations: [],
    stats: {
      clientConnected: true,
      ffmpegRunning: true,
    },
    updatedAt: 10_000,
    rendererHealth: {
      ready: true,
      degradedReason: null,
      updatedAt: 10_000,
      phase,
      ...(diagnostics ? { diagnostics } : {}),
    },
  };
}

describe("streaming betting renderer health", () => {
  it("retains the exact previous-phase derivation and matching next-phase acknowledgement", () => {
    const cycle = announcementCycle({
      agent1: [350, 0.42, 405.35],
      agent2: [350, 0.42, 406.65],
    });
    cycle.phase = "COUNTDOWN";
    const previous = externalRendererSnapshot();
    previous.updatedAt = 10_001;
    const negative = deriveBettingRendererHealth(cycle, {
      externalStatusSnapshot: previous,
      nowMs: 10_002,
    });
    expect(negative).toMatchObject({
      ready: false,
      degradedReason: "renderer_phase_mismatch",
      updatedAt: 10_002,
      derivation: {
        schemaVersion: 1,
        evaluatedAtMs: 10_002,
        canonicalCycleId: "cycle-a",
        canonicalPhase: "COUNTDOWN",
        externalSnapshotPresent: true,
        externalSnapshotUpdatedAt: 10_001,
        rendererPresent: true,
        rendererReady: true,
        rendererPhase: "ANNOUNCEMENT",
        rendererDegradedReason: null,
        rendererUpdatedAt: 10_000,
        scenePresent: true,
        sceneReady: true,
        sceneCycleId: "cycle-a",
        scenePhase: "ANNOUNCEMENT",
        captureClientConnected: true,
        captureFfmpegRunning: true,
      },
    });
    const next = externalRendererSnapshot({ phase: "COUNTDOWN" });
    next.rendererHealth!.updatedAt = 10_003;
    next.updatedAt = 10_004;
    expect(
      deriveBettingRendererHealth(cycle, {
        externalStatusSnapshot: next,
        nowMs: 10_005,
      }),
    ).toMatchObject({
      ready: true,
      degradedReason: null,
      updatedAt: 10_003,
      derivation: {
        evaluatedAtMs: 10_005,
        externalSnapshotUpdatedAt: 10_004,
        rendererUpdatedAt: 10_003,
        rendererPhase: "COUNTDOWN",
        scenePhase: "COUNTDOWN",
      },
    });
    // Later mutations of source snapshots cannot rewrite retained causality.
    previous.rendererHealth!.phase = "FIGHTING";
    cycle.phase = "FIGHTING";
    expect(negative).toMatchObject({
      derivation: {
        canonicalPhase: "COUNTDOWN",
        rendererPhase: "ANNOUNCEMENT",
      },
    });
  });

  it("distinguishes missing, stale, future, wrong-cycle and actual negative inputs without changing health semantics", () => {
    const cycle = announcementCycle({
      agent1: [350, 0.42, 405.35],
      agent2: [350, 0.42, 406.65],
    });
    const cases: Array<{
      snapshot: ExternalRtmpStatusSnapshot | null;
      ready: boolean;
      reason: string | null;
      diagnostic: Record<string, unknown>;
    }> = [
      {
        snapshot: null,
        ready: true,
        reason: null,
        diagnostic: {
          externalSnapshotPresent: false,
          rendererPresent: false,
          scenePresent: false,
        },
      },
      {
        snapshot: externalRendererSnapshot({ diagnostics: false }),
        ready: false,
        reason: "renderer_scene_evidence_missing",
        diagnostic: {
          rendererReady: true,
          scenePresent: false,
          sceneReady: null,
        },
      },
      {
        snapshot: externalRendererSnapshot({ cycleId: "cycle-b" }),
        ready: false,
        reason: "renderer_cycle_mismatch",
        diagnostic: { canonicalCycleId: "cycle-a", sceneCycleId: "cycle-b" },
      },
    ];
    const stale = externalRendererSnapshot();
    stale.rendererHealth!.updatedAt = 1;
    cases.push({
      snapshot: stale,
      ready: false,
      reason: "renderer_health_stale",
      diagnostic: { rendererUpdatedAt: 1 },
    });
    const future = externalRendererSnapshot();
    future.rendererHealth!.updatedAt = 50_000;
    cases.push({
      snapshot: future,
      ready: true,
      reason: null,
      diagnostic: { rendererUpdatedAt: 50_000 },
    });
    const unready = externalRendererSnapshot();
    unready.rendererHealth!.ready = false;
    unready.rendererHealth!.degradedReason = "capture_process_exited";
    cases.push({
      snapshot: unready,
      ready: false,
      reason: "capture_process_exited",
      diagnostic: {
        rendererReady: false,
        rendererDegradedReason: "capture_process_exited",
      },
    });
    for (const entry of cases) {
      expect(
        deriveBettingRendererHealth(cycle, {
          externalStatusSnapshot: entry.snapshot,
          externalStatusMaxAgeMs: 15_000,
          captureStats: { clientConnected: true, ffmpegRunning: true },
          nowMs: 20_000,
        }),
      ).toMatchObject({
        ready: entry.ready,
        degradedReason: entry.reason,
        derivation: { evaluatedAtMs: 20_000, ...entry.diagnostic },
      });
    }
  });

  it("bounds diagnostics to public scalar tokens and preserves malformed timestamps as null", () => {
    const cycle = announcementCycle(null);
    const snapshot = externalRendererSnapshot();
    cycle.cycleId = "x".repeat(129);
    snapshot.rendererHealth!.phase = "https://not-a-phase.invalid";
    snapshot.rendererHealth!.degradedReason = "PRIVATE ERROR BODY WITH SPACES";
    snapshot.rendererHealth!.updatedAt = Number.NaN;
    const health = deriveBettingRendererHealth(cycle, {
      externalStatusSnapshot: snapshot,
      nowMs: 20_000,
    });
    expect(health.derivation).toMatchObject({
      canonicalCycleId: null,
      rendererPhase: null,
      rendererDegradedReason: null,
      rendererUpdatedAt: null,
    });
    expect(Object.keys(health.derivation ?? {})).toHaveLength(17);
    expect(JSON.stringify(health.derivation).length).toBeLessThan(1_500);
  });

  it("fails announcement readiness closed until arena staging is authoritative", () => {
    const captureStats = { clientConnected: true, ffmpegRunning: true };

    expect(
      deriveBettingRendererHealth(announcementCycle(null), {
        captureStats,
        nowMs: 10_000,
      }),
    ).toMatchObject({
      ready: false,
      degradedReason: "arena_positions_invalid",
      updatedAt: 10_000,
    });
    expect(
      deriveBettingRendererHealth(
        announcementCycle({
          agent1: [350, 0.42, 405.35],
          agent2: [350.1, 50, 405.45],
        }),
        { captureStats, nowMs: 10_001 },
      ),
    ).toMatchObject({
      ready: false,
      degradedReason: "arena_positions_invalid",
      updatedAt: 10_001,
    });
    expect(
      deriveBettingRendererHealth(
        announcementCycle({
          agent1: [350, 0.42, 405.35],
          agent2: [350, 0.42, 406.65],
        }),
        { captureStats, nowMs: 10_002 },
      ),
    ).toMatchObject({ ready: true, degradedReason: null, updatedAt: 10_002 });
  });

  it("binds a ready external renderer to the exact active cycle and phase", () => {
    const cycle = announcementCycle({
      agent1: [350, 0.42, 405.35],
      agent2: [350, 0.42, 406.65],
    });
    const derive = (snapshot: ExternalRtmpStatusSnapshot) =>
      deriveBettingRendererHealth(cycle, {
        externalStatusSnapshot: snapshot,
        externalStatusMaxAgeMs: 15_000,
        nowMs: 10_002,
      });

    expect(derive(externalRendererSnapshot())).toMatchObject({
      ready: true,
      degradedReason: null,
      updatedAt: 10_000,
    });
    expect(
      derive(externalRendererSnapshot({ diagnostics: false })),
    ).toMatchObject({
      ready: false,
      degradedReason: "renderer_scene_evidence_missing",
      updatedAt: 10_002,
    });
    expect(
      derive(externalRendererSnapshot({ sceneReady: false })),
    ).toMatchObject({
      ready: false,
      degradedReason: "renderer_scene_not_ready",
      updatedAt: 10_002,
    });
    expect(
      derive(externalRendererSnapshot({ cycleId: "cycle-b" })),
    ).toMatchObject({
      ready: false,
      degradedReason: "renderer_cycle_mismatch",
      updatedAt: 10_002,
    });
    expect(
      derive(externalRendererSnapshot({ phase: "COUNTDOWN" })),
    ).toMatchObject({
      ready: false,
      degradedReason: "renderer_phase_mismatch",
      updatedAt: 10_002,
    });
  });
});
