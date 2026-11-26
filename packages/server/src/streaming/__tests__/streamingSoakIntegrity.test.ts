import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildStreamingSoakChecks,
  StreamingSoakIntegrityTracker,
} from "../../../../../scripts/streaming-soak-integrity.mjs";
import {
  buildStreamingTelemetryChecks,
  classifySseSequence,
  deriveSseDeliveryOverheadMs,
  StreamingSoakTelemetryCollector,
} from "../../../../../scripts/streaming-soak-telemetry.mjs";

const agent = (id: string, hp = 50, damage = 0) => ({
  id,
  hp,
  maxHp: 50,
  damageDealtThisFight: damage,
  attacksLanded: damage > 0 ? 1 : 0,
});

function state(
  phase: "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION",
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "STREAMING_STATE_UPDATE",
    cycle: {
      cycleId: "cycle-1",
      phase,
      phaseVersion: [
        "ANNOUNCEMENT",
        "COUNTDOWN",
        "FIGHTING",
        "RESOLUTION",
      ].indexOf(phase),
      agent1: agent("a"),
      agent2: agent("b"),
      duelId: phase === "ANNOUNCEMENT" ? null : "streaming-cycle-1",
      duelKeyHex: phase === "ANNOUNCEMENT" ? null : "11".repeat(32),
      winnerId: null,
      outcome: null,
      winReason: null,
      duelEndTime: null,
      seed: null,
      replayHash: null,
      fightStartTime: phase === "ANNOUNCEMENT" ? null : 3_000,
      firstHitAt: null,
      cycleStartTime: 1_000,
      phaseStartTime:
        1_000 +
        ["ANNOUNCEMENT", "COUNTDOWN", "FIGHTING", "RESOLUTION"].indexOf(phase) *
          1_000,
      phaseEndTime:
        2_000 +
        ["ANNOUNCEMENT", "COUNTDOWN", "FIGHTING", "RESOLUTION"].indexOf(phase) *
          1_000,
      timeRemaining: 1_000,
      ...overrides,
    },
    terminalNotice: null,
  };
}

const durationSnapshot = {
  samples: 60,
  average: 2,
  p50: 1,
  p95: 4,
  p99: 8,
  max: 12,
};

const rendererMetric = {
  samples: 60,
  average: 10,
  latest: 11,
  max: 15,
};

const HTTP_LIFECYCLE_PROCESS_DEADLINE_MS = 30_000;
const HTTP_LIFECYCLE_TEST_TIMEOUT_MS = 35_000;

function rendererTelemetryPayload() {
  const frame = {
    frames: 60,
    frameIntervalMs: durationSnapshot,
    frameWorkMs: durationSnapshot,
    cpuMs: durationSnapshot,
    renderSubmitMs: durationSnapshot,
    frameBudget: {
      above16_67Ms: 2,
      above33_33Ms: 1,
      above50Ms: 0,
      above100Ms: 0,
    },
    renderer: {
      drawCalls: rendererMetric,
      triangles: rendererMetric,
      textures: rendererMetric,
      geometries: rendererMetric,
    },
  };
  return {
    rendererPerformance: {
      schemaVersion: 1,
      updatedAt: 9_000,
      uptimeMs: 8_000,
      currentPhase: "FIGHTING",
      overall: frame,
      byPhase: { FIGHTING: frame },
      jsHeap: { usedBytes: 100, totalBytes: 200, limitBytes: 300 },
      viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
      resources: {
        entries: 60,
        cacheHits: 20,
        transferBytes: 30_000,
        encodedBodyBytes: 25_000,
        decodedBodyBytes: 50_000,
        durationMs: durationSnapshot,
        responseWaitMs: durationSnapshot,
        byCategory: {
          model: {
            entries: 60,
            cacheHits: 20,
            transferBytes: 30_000,
            encodedBodyBytes: 25_000,
            decodedBodyBytes: 50_000,
            durationMs: durationSnapshot,
            responseWaitMs: durationSnapshot,
          },
        },
      },
      longFrames: [
        {
          frameSequence: 60,
          phase: "FIGHTING",
          phaseFrame: 60,
          uptimeMs: 8_000,
          frameIntervalMs: 75,
          frameWorkMs: 60,
          cpuMs: 40,
          renderSubmitMs: 20,
          drawCalls: 11,
          triangles: 11,
          textures: 11,
          geometries: 11,
          jsHeapUsedBytes: 100,
          resourceEntries: 60,
          topSystems: [
            {
              name: "terrain",
              fixedUpdateMs: 0,
              updateMs: 35,
              lateUpdateMs: 0,
              totalMs: 35,
            },
          ],
        },
      ],
    },
  };
}

function serverTelemetryPayload() {
  return {
    uptime: 9_000,
    trend: "stable",
    growthRateMBPerMin: "-1.25",
    currentMemory: {
      rssMB: "140.0",
      heapUsedMB: "80.0",
      heapTotalMB: "100.0",
      externalMB: "10.0",
    },
    diagnostics: {
      resourceEcology: {
        totalResources: 15,
        availableResources: 12,
        depletedResources: 3,
        manifestResources: 15,
        resourceVariants: 15,
        forestryTimers: 4,
        forestryActiveGatherers: 2,
        scheduledRespawns: 3,
        fishingMovementTimers: 0,
        pendingFishingAreas: 0,
        playerSkillSnapshots: 2,
        gatherRateLimits: 2,
        suspiciousPatternEntries: 0,
        custody: {
          activeSessions: 2,
          pendingRewards: 1,
          inFlightRewards: 1,
          retryWaitingRewards: 0,
          resourceReservations: 1,
          maxRetryCount: 0,
        },
      },
      world: {
        tickTimingPercentiles: Object.fromEntries(
          [
            "total",
            "fixedUpdate",
            "update",
            "lateUpdate",
            "commit",
            "unmeasured",
          ].map((phase) => [phase, durationSnapshot]),
        ),
        systemTimingPercentiles: [{ name: "combat", ...durationSnapshot }],
      },
    },
  };
}

describe("streaming soak integrity tracker", () => {
  it("proves a fully observed authoritative duel once despite repeated polls", () => {
    const tracker = new StreamingSoakIntegrityTracker();
    tracker.observe(state("ANNOUNCEMENT"), 1_000);
    tracker.observe(state("COUNTDOWN"), 2_000);
    tracker.observe(
      state("FIGHTING", {
        agent1: agent("a", 45, 4),
        agent2: agent("b", 46, 5),
        firstHitAt: 3_250,
      }),
      3_000,
    );
    const resolution = state("RESOLUTION", {
      agent1: agent("a", 45, 4),
      agent2: agent("b", 0, 50),
      winnerId: "a",
      outcome: "win",
      winReason: "death",
      duelEndTime: 4_000,
      seed: "seed-proof",
      replayHash: "replay-proof",
      firstHitAt: 3_250,
    });
    tracker.observe(resolution, 4_000);
    tracker.observe(resolution, 4_100);

    expect(tracker.summary()).toMatchObject({
      resolvedDuels: 1,
      phaseCoverageEligibleResolvedDuels: 1,
      fullyObservedResolvedDuels: 1,
      cancelledDuels: 0,
      wins: 1,
      draws: 0,
      cyclesWithTwoSidedDamage: 1,
      totalDamageDealt: 54,
      totalHitsLanded: 2,
      timeToFirstHitMs: {
        count: 1,
        average: 250,
        p50: 250,
        p95: 250,
        p99: 250,
        max: 250,
      },
      integrityViolationCount: 0,
    });
  });

  it("deduplicates valid cancellation notices and classifies their reason", () => {
    const tracker = new StreamingSoakIntegrityTracker();
    const payload = {
      cycle: { phase: "IDLE" },
      terminalNotice: {
        cycleId: "cancelled-cycle",
        outcome: "cancelled",
        reason: "both_agents_lost_during_prep",
        occurredAt: 5_000,
        expiresAt: 15_000,
      },
    };
    tracker.observe(payload, 5_100);
    tracker.observe(payload, 5_200);

    expect(tracker.summary()).toMatchObject({
      cancelledDuels: 1,
      cancellationReasons: { both_agents_lost_during_prep: 1 },
      integrityViolationCount: 0,
    });
  });

  it("fails hard contradictions while tolerating a monitor that starts mid-cycle", () => {
    const tracker = new StreamingSoakIntegrityTracker();
    tracker.observe(
      state("FIGHTING", {
        agent1: agent("a", 45, 5),
        agent2: agent("b", 48, 2),
        firstHitAt: 3_250,
      }),
    );
    tracker.observe(
      state("COUNTDOWN", {
        phaseVersion: 1,
        agent1: agent("changed", 45, 1),
        agent2: agent("b", 48, 2),
        firstHitAt: 3_250,
      }),
    );

    const summary = tracker.summary();
    expect(summary.fullyObservedResolvedDuels).toBe(0);
    expect(summary.integrityViolationSamples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "contestant_identity_changed" }),
        expect.objectContaining({ code: "phase_regressed" }),
        expect.objectContaining({ code: "phase_version_regressed" }),
        expect.objectContaining({ code: "damage_regressed" }),
      ]),
    );
  });

  it("excludes a partially observed opening announcement from phase coverage", () => {
    const tracker = new StreamingSoakIntegrityTracker();
    tracker.observe(
      state("ANNOUNCEMENT", {
        phaseStartTime: 1_000,
        phaseEndTime: 31_000,
        timeRemaining: 20_000,
      }),
      11_000,
    );
    tracker.observe(state("COUNTDOWN"), 31_000);
    tracker.observe(
      state("FIGHTING", {
        agent1: agent("a", 45, 5),
        agent2: agent("b", 46, 4),
        firstHitAt: 3_250,
      }),
      35_000,
    );
    tracker.observe(
      state("RESOLUTION", {
        agent1: agent("a", 45, 5),
        agent2: agent("b", 0, 50),
        winnerId: "a",
        outcome: "win",
        winReason: "death",
        duelEndTime: 4_000,
        seed: "seed-proof",
        replayHash: "replay-proof",
        firstHitAt: 3_250,
      }),
      40_000,
    );

    expect(tracker.summary()).toMatchObject({
      resolvedDuels: 1,
      phaseCoverageEligibleResolvedDuels: 0,
      fullyObservedResolvedDuels: 0,
      phaseCoverageExcludedResolvedDuels: 1,
      phaseCoverageIncompleteSamples: [],
    });
  });

  it("separates intentional public delay from SSE delivery overhead", () => {
    expect(deriveSseDeliveryOverheadMs(15_211, 15_000)).toBe(211);
    expect(deriveSseDeliveryOverheadMs(14_900, 15_000)).toBe(0);
    expect(deriveSseDeliveryOverheadMs(null, 15_000)).toBeNull();
  });

  it("uses the first SSE sequence as a baseline instead of a replay gap", () => {
    expect(classifySseSequence(0, 18)).toEqual({
      nextSeq: 18,
      gapEvents: 0,
      duplicateEvents: 0,
      outOfOrderEvents: 0,
    });
    expect(classifySseSequence(18, 21)).toEqual({
      nextSeq: 21,
      gapEvents: 2,
      duplicateEvents: 0,
      outOfOrderEvents: 0,
    });
    expect(classifySseSequence(21, 21).duplicateEvents).toBe(1);
    expect(classifySseSequence(21, 20).outOfOrderEvents).toBe(1);
  });

  it("rejects malformed or contradictory terminal truth", () => {
    const tracker = new StreamingSoakIntegrityTracker();
    tracker.observe(
      state("RESOLUTION", {
        agent1: agent("a", 50, 0),
        agent2: agent("b", 50, 0),
        winnerId: "outsider",
        outcome: "win",
        winReason: "death",
      }),
    );
    tracker.observe({
      cycle: { phase: "IDLE" },
      terminalNotice: {
        cycleId: "cycle-1",
        outcome: "cancelled",
        reason: "watchdog_fighting_timeout",
        occurredAt: 10_000,
        expiresAt: 20_000,
      },
    });

    expect(tracker.summary().integrityViolationSamples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "incomplete_resolution_proof" }),
        expect.objectContaining({ code: "invalid_resolution_winner" }),
        expect.objectContaining({ code: "resolution_without_combat_activity" }),
        expect.objectContaining({ code: "resolved_cycle_cancelled" }),
      ]),
    );
  });

  it("enforces explicit soak thresholds without vacuous phase-coverage passes", () => {
    const healthySummary = {
      integrityViolationCount: 0,
      resolvedDuels: 3,
      phaseCoverageEligibleResolvedDuels: 3,
      fullyObservedResolvedDuels: 3,
      cancelledDuels: 0,
    };
    expect(
      buildStreamingSoakChecks(healthySummary, {
        minResolvedDuels: 3,
        maxCancelledDuels: 0,
        requireFullPhaseCoverage: true,
      }).every((check) => check.pass),
    ).toBe(true);

    const emptyChecks = buildStreamingSoakChecks(
      {
        ...healthySummary,
        resolvedDuels: 0,
        phaseCoverageEligibleResolvedDuels: 0,
        fullyObservedResolvedDuels: 0,
      },
      { requireFullPhaseCoverage: true },
    );
    expect(emptyChecks[emptyChecks.length - 1]).toMatchObject({
      pass: false,
      actual: "0/0",
    });

    const failed = buildStreamingSoakChecks(
      {
        integrityViolationCount: 2,
        resolvedDuels: 1,
        phaseCoverageEligibleResolvedDuels: 1,
        fullyObservedResolvedDuels: 0,
        cancelledDuels: 1,
      },
      {
        minResolvedDuels: 2,
        maxCancelledDuels: 0,
        requireFullPhaseCoverage: true,
      },
    );
    expect(failed.every((check) => !check.pass)).toBe(true);
  });

  it("retains compact authenticated server and renderer time series", () => {
    const telemetry = new StreamingSoakTelemetryCollector({
      retentionIntervalMs: 1_000,
      maxSamples: 2,
    });
    telemetry.observeServer(serverTelemetryPayload(), 1_000);
    telemetry.observeRenderer(rendererTelemetryPayload(), 1_000);
    telemetry.observeServer(serverTelemetryPayload(), 1_500);
    telemetry.observeRenderer(rendererTelemetryPayload(), 2_000);
    telemetry.observeServer(serverTelemetryPayload(), 2_100);

    const summary = telemetry.summary({ serverConfigured: true });
    expect(summary.server).toMatchObject({
      configured: true,
      polls: 3,
      failures: 0,
      retainedSamples: 2,
    });
    expect(summary.server.latest).toMatchObject({
      growthRateMBPerMin: -1.25,
      memory: { heapUsedMB: 80 },
      tickTimingPercentiles: { total: durationSnapshot },
      resourceEcology: {
        totalResources: 15,
        availableResources: 12,
        depletedResources: 3,
        custody: { activeSessions: 2 },
      },
    });
    expect(summary.renderer).toMatchObject({
      polls: 2,
      failures: 0,
      retainedSamples: 2,
      latest: {
        currentPhase: "FIGHTING",
        overall: { frames: 60, frameIntervalMs: durationSnapshot },
        resources: {
          entries: 60,
          byCategory: { model: { entries: 60 } },
        },
        longFrames: [
          {
            frameSequence: 60,
            phase: "FIGHTING",
            phaseFrame: 60,
            topSystems: [{ name: "terrain", totalMs: 35 }],
          },
        ],
      },
    });
    expect(
      buildStreamingTelemetryChecks(summary, {
        requireServerTelemetry: true,
        requireRendererTelemetry: true,
        requireResourceTelemetry: true,
        requireResourceEcologyTelemetry: true,
      }).every((check) => check.pass),
    ).toBe(true);
  });

  it("fails required telemetry on missing configuration or malformed samples", () => {
    const telemetry = new StreamingSoakTelemetryCollector();
    telemetry.observeRenderer({ rendererPerformance: { schemaVersion: 1 } });
    const checks = buildStreamingTelemetryChecks(telemetry.summary(), {
      requireServerTelemetry: true,
      requireRendererTelemetry: true,
    });
    expect(checks.every((check) => !check.pass)).toBe(true);
  });

  it("rejects contradictory resource ecology telemetry", () => {
    const telemetry = new StreamingSoakTelemetryCollector();
    const payload = serverTelemetryPayload();
    payload.diagnostics.resourceEcology.availableResources = 13;
    telemetry.observeServer(payload);

    expect(telemetry.summary({ serverConfigured: true }).server).toMatchObject({
      polls: 1,
      failures: 1,
      retainedSamples: 0,
    });
  });

  it(
    "gates the real load-test process on a complete HTTP lifecycle",
    async () => {
      let firstStateRequestAt: number | null = null;
      const server = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/health") {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        if (request.url === "/api/streaming/state") {
          const now = Date.now();
          firstStateRequestAt ??= now;
          const elapsed = now - firstStateRequestAt;
          const payload =
            elapsed < 1_500
              ? state("ANNOUNCEMENT")
              : elapsed < 3_000
                ? state("COUNTDOWN")
                : elapsed < 4_500
                  ? state("FIGHTING", {
                      agent1: agent("a", 45, 5),
                      agent2: agent("b", 46, 4),
                      firstHitAt: 3_250,
                    })
                  : state("RESOLUTION", {
                      agent1: agent("a", 45, 5),
                      agent2: agent("b", 0, 50),
                      winnerId: "a",
                      outcome: "win",
                      winReason: "death",
                      duelEndTime: 4_000,
                      seed: "seed-proof",
                      replayHash: "replay-proof",
                      firstHitAt: 3_250,
                    });
          response.end(JSON.stringify(payload));
          return;
        }
        if (request.url === "/api/streaming/metrics") {
          response.end(JSON.stringify({ type: "STREAMING_METRICS" }));
          return;
        }
        if (request.url === "/api/streaming/health") {
          response.end(JSON.stringify(rendererTelemetryPayload()));
          return;
        }
        if (request.url === "/admin/memory/report") {
          if (request.headers["x-admin-code"] !== "soak-admin") {
            response.statusCode = 403;
            response.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }
          response.end(JSON.stringify(serverTelemetryPayload()));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
      const serverSockets = new Set<Socket>();
      server.on("connection", (socket) => {
        serverSockets.add(socket);
        socket.once("close", () => serverSockets.delete(socket));
      });

      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        throw new Error("test server did not bind a TCP port");
      }

      const workspaceRoot = fileURLToPath(
        new URL("../../../../../", import.meta.url),
      );
      const evidenceDirectory = await mkdtemp(
        path.join(tmpdir(), "hyperia-soak-evidence-"),
      );
      const evidencePath = path.join(evidenceDirectory, "result.json");
      const child = spawn(
        "bun",
        [
          "scripts/load-test-streaming.mjs",
          `--server-url=http://127.0.0.1:${address.port}`,
          "--duration-s=10",
          "--sse-clients=0",
          "--hls-clients=0",
          "--state-pollers=0",
          "--duel-context-pollers=0",
          "--integrity-poll-ms=250",
          "--metrics-poll-ms=1000",
          "--telemetry-snapshot-ms=1000",
          "--min-resolved-duels=1",
          "--max-cancelled-duels=0",
          "--require-full-phase-coverage",
          "--require-server-telemetry",
          "--require-renderer-telemetry",
          "--require-resource-telemetry",
          "--require-resource-ecology-telemetry",
          `--json-output=${evidencePath}`,
        ],
        {
          cwd: workspaceRoot,
          env: { ...process.env, STREAMING_LOAD_ADMIN_CODE: "soak-admin" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      try {
        let processDeadline: ReturnType<typeof setTimeout> | null = null;
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          processDeadline = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
              new Error(
                `streaming soak child exceeded its ${HTTP_LIFECYCLE_PROCESS_DEADLINE_MS}ms process deadline`,
              ),
            );
          }, HTTP_LIFECYCLE_PROCESS_DEADLINE_MS);
          processDeadline.unref();
          child.once("error", reject);
          child.once("close", resolve);
        }).finally(async () => {
          if (processDeadline) clearTimeout(processDeadline);
          for (const socket of serverSockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });

        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect(stdout).toContain('"ok": true');
        expect(stdout).toContain('"resolvedDuels": 1');
        expect(stdout).toContain('"fullyObservedResolvedDuels": 1');
        expect(stdout).toContain('"integrityViolationCount": 0');
        expect(stdout).toContain('"runtimeTelemetry"');
        expect(stdout).toMatch(/"retainedSamples": [1-9][0-9]*/);
        expect(stdout).toContain(
          "server tick/memory telemetry retained without poll failures",
        );
        expect(stdout).toContain(
          "renderer frame telemetry retained without poll failures",
        );
        expect(stdout).toContain(
          "server resource ecology telemetry retained and internally consistent",
        );

        const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
        expect(evidence).toMatchObject({
          ok: true,
          duelIntegrity: { resolvedDuels: 1, integrityViolationCount: 0 },
          runtimeTelemetry: {
            server: { configured: true, failures: 0 },
            renderer: { failures: 0 },
          },
        });
      } finally {
        await rm(evidenceDirectory, { recursive: true, force: true });
      }
    },
    HTTP_LIFECYCLE_TEST_TIMEOUT_MS,
  );
});
