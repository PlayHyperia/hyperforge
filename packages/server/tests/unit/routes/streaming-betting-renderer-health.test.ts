import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamPerformanceTelemetry } from "@hyperforge/shared";
import {
  deriveBettingRendererHealth,
  loadExternalRtmpStatusSnapshot,
} from "../../../src/routes/streaming-betting-routes.js";
import type { StreamingDuelCycle } from "../../../src/systems/StreamingDuelScheduler/types.js";

function createCycle(
  overrides: Partial<StreamingDuelCycle> = {},
): StreamingDuelCycle {
  return {
    cycleId: "cycle-1",
    phase: "FIGHTING",
    cycleStartTime: 1_000,
    phaseStartTime: 1_000,
    phaseVersion: 2,
    agent1: {
      characterId: "agent-a",
      name: "Agent A",
      provider: "provider-a",
      model: "model-a",
      combatLevel: 10,
      wins: 7,
      losses: 2,
      currentHp: 25,
      maxHp: 30,
      originalPosition: [1, 2, 3],
      damageDealtThisFight: 4,
      equipment: {},
      inventory: [],
      rank: 1,
      headToHeadWins: 3,
      headToHeadLosses: 1,
    },
    agent2: {
      characterId: "agent-b",
      name: "Agent B",
      provider: "provider-b",
      model: "model-b",
      combatLevel: 11,
      wins: 5,
      losses: 4,
      currentHp: 20,
      maxHp: 30,
      originalPosition: [4, 5, 6],
      damageDealtThisFight: 2,
      equipment: {},
      inventory: [],
      rank: 2,
      headToHeadWins: 1,
      headToHeadLosses: 3,
    },
    duelId: "duel-1",
    duelKeyHex: "0xabcdef",
    arenaId: null,
    betOpenTime: 1_000,
    betCloseTime: 2_000,
    countdownValue: null,
    fightStartTime: null,
    duelEndTime: null,
    arenaPositions: {
      agent1: [10, 11, 12],
      agent2: [20, 21, 22],
    },
    winnerId: null,
    loserId: null,
    winReason: null,
    seed: null,
    replayHash: null,
    ...overrides,
  };
}

describe("deriveBettingRendererHealth", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("loads external RTMP snapshots asynchronously for cache refresh", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "betting-renderer-health-"));
    const statusFile = join(tempDir, "status.json");
    const telemetry = new StreamPerformanceTelemetry(1_000);
    telemetry.record({
      phase: "FIGHTING",
      frameIntervalMs: 16.7,
      frameWorkMs: 8,
      cpuMs: 6,
      renderSubmitMs: 2,
      drawCalls: 100,
      triangles: 10_000,
      textures: 20,
      geometries: 30,
      viewport: { width: 1_280, height: 720, devicePixelRatio: 1 },
    });
    const rendererPerformance = telemetry.snapshot(2_000);
    writeFileSync(
      statusFile,
      JSON.stringify({
        destinations: [],
        stats: {},
        updatedAt: Date.now() - 1_000,
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: Date.now() - 1_000,
          injected: "strip-me",
        },
        captureHealth: {
          mode: "cdp",
          targetFps: 30,
          measuredFps: 29,
          receivedFrames: 900,
          droppedFrames: 0,
          acknowledgementPacing: true,
          injected: "strip-me",
        },
        rendererPerformance: {
          ...rendererPerformance,
          injected: "strip-me",
        },
        injected: "strip-me",
      }),
    );

    const snapshot = await loadExternalRtmpStatusSnapshot(statusFile, 15_000);
    expect(snapshot).toMatchObject({
      rendererHealth: {
        ready: true,
      },
      captureHealth: {
        mode: "cdp",
        targetFps: 30,
        measuredFps: 29,
        receivedFrames: 900,
        droppedFrames: 0,
        acknowledgementPacing: true,
      },
      rendererPerformance,
    });
    expect(snapshot).not.toHaveProperty("injected");
    expect(snapshot?.rendererHealth).not.toHaveProperty("injected");
    expect(snapshot?.captureHealth).not.toHaveProperty("injected");
    expect(snapshot?.rendererPerformance).not.toHaveProperty("injected");
  });

  it("treats an absent external status file as a quiet startup state", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "betting-renderer-health-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const snapshot = await loadExternalRtmpStatusSnapshot(
      join(tempDir, "not-created-yet.json"),
      15_000,
    );

    expect(snapshot).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects malformed external capture telemetry", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "betting-renderer-health-"));
    const statusFile = join(tempDir, "status.json");
    writeFileSync(
      statusFile,
      JSON.stringify({
        destinations: [],
        stats: {},
        updatedAt: Date.now(),
        captureHealth: {
          mode: "cdp",
          targetFps: 1_000,
          measuredFps: 999,
        },
      }),
    );

    const snapshot = await loadExternalRtmpStatusSnapshot(statusFile, 15_000);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.captureHealth).toBeUndefined();
  });

  it("drops malformed renderer performance from an otherwise valid status", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "betting-renderer-health-"));
    const statusFile = join(tempDir, "status.json");
    writeFileSync(
      statusFile,
      JSON.stringify({
        destinations: [],
        stats: {},
        updatedAt: Date.now(),
        rendererPerformance: {
          schemaVersion: 1,
          sessionStartedAt: 1_000,
          updatedAt: 2_000,
          uptimeMs: 999,
        },
      }),
    );

    const snapshot = await loadExternalRtmpStatusSnapshot(statusFile, 15_000);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.rendererPerformance).toBeUndefined();
  });

  it("returns guardrail failures for invalid live duel agent state", () => {
    const health = deriveBettingRendererHealth(
      createCycle({
        agent1: {
          ...createCycle().agent1,
          currentHp: 35,
          maxHp: 30,
        },
      }),
      {
        captureStats: {
          clientConnected: true,
          ffmpegRunning: true,
        },
      },
    );

    expect(health.ready).toBe(false);
    expect(health.degradedReason).toBe("invalid_agent_hp");
  });

  it("uses a fresh external RTMP renderer snapshot when available", () => {
    const health = deriveBettingRendererHealth(createCycle(), {
      externalStatusSnapshot: {
        destinations: [],
        stats: {},
        updatedAt: Date.now() - 1_000,
        rendererHealth: {
          ready: false,
          degradedReason: "loading_overlay_active",
          updatedAt: Date.now() - 1_000,
        },
      },
      externalStatusMaxAgeMs: 15_000,
      captureStats: {
        clientConnected: false,
        ffmpegRunning: false,
      },
    });

    expect(health).toMatchObject({
      ready: false,
      degradedReason: "loading_overlay_active",
    });
  });

  it("does not let ready renderer telemetry mask an inactive external capture pipeline", () => {
    const health = deriveBettingRendererHealth(createCycle(), {
      externalStatusSnapshot: {
        destinations: [],
        stats: {
          clientConnected: true,
          ffmpegRunning: false,
        },
        updatedAt: Date.now() - 100,
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: Date.now() - 100,
        },
      },
      externalStatusMaxAgeMs: 15_000,
    });

    expect(health).toMatchObject({
      ready: false,
      degradedReason: "capture_pipeline_inactive",
    });
  });

  it("degrades stale external RTMP renderer snapshots", () => {
    const health = deriveBettingRendererHealth(createCycle(), {
      externalStatusSnapshot: {
        destinations: [],
        stats: {},
        updatedAt: Date.now() - 20_000,
        rendererHealth: {
          ready: true,
          degradedReason: null,
          updatedAt: Date.now() - 20_000,
        },
      },
      externalStatusMaxAgeMs: 15_000,
      captureStats: {
        clientConnected: true,
        ffmpegRunning: true,
      },
    });

    expect(health).toMatchObject({
      ready: false,
      degradedReason: "renderer_health_stale",
    });
  });

  it("reports disconnected capture clients during active duel phases", () => {
    const health = deriveBettingRendererHealth(createCycle(), {
      captureStats: {
        clientConnected: false,
        ffmpegRunning: true,
      },
    });

    expect(health).toMatchObject({
      ready: false,
      degradedReason: "capture_client_disconnected",
    });
  });

  it("reports inactive capture pipelines during active duel phases", () => {
    const health = deriveBettingRendererHealth(createCycle(), {
      captureStats: {
        clientConnected: true,
        ffmpegRunning: false,
      },
    });

    expect(health).toMatchObject({
      ready: false,
      degradedReason: "capture_pipeline_inactive",
    });
  });

  it("returns healthy for idle phases when no degraded source exists", () => {
    const health = deriveBettingRendererHealth(
      createCycle({
        phase: "IDLE",
        agent1: null,
        agent2: null,
        arenaPositions: null,
      }),
      {
        captureStats: {
          clientConnected: false,
          ffmpegRunning: false,
        },
      },
    );

    expect(health).toMatchObject({
      ready: true,
      degradedReason: null,
    });
  });
});
