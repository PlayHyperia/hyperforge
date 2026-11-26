import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { STREAMING_DUEL_PUBLIC_STYLES } from "../packages/shared/src/types/game/streaming-duel-action-observation.ts";
import {
  buildDuelFullTopologyContinuityChecks,
  buildDuelFullTopologyDisputeEvidenceCheck,
  buildDuelFullTopologyExactTerminalCheck,
  buildDuelFullTopologyLoadArgs,
  buildDuelFullTopologyStrategyAnalyticsChecks,
  buildDuelFullTopologyStrategyAuditArgs,
  buildDuelFullTopologyTerminalChecks,
  DuelFullTopologyContinuityTracker,
  redactDuelFullTopologyDiagnostic,
  settleDuelFullTopologySoakTasks,
  validateDuelFullTopologySoakConfiguration,
} from "./duel-full-topology-soak-policy.mjs";

const smokeSource = readFileSync(
  new URL("./smoke-duel-launch.mjs", import.meta.url),
  "utf8",
);

function state(seq, phase = "ANNOUNCEMENT", cycleId = "cycle-1") {
  return { seq, cycle: { cycleId, phase, phaseVersion: 1 } };
}

function status(seq, observedAt, phase = "ANNOUNCEMENT") {
  return {
    service: "hyperbet-solana-backend",
    readiness: { ready: true, reasons: [] },
    stream: {
      seq,
      cycleId: "cycle-1",
      phase,
      sourceUrl: "http://127.0.0.1:35551/api/streaming/state",
      lastSourcePollAt: observedAt - 250,
      lastSourceError: null,
      sourceEventsConnected: true,
      sourceEventsLastError: null,
    },
    bot: { running: true },
    predictionMarkets: {
      marketCount: 1,
      chains: [{ chainKey: "solana", lifecycleStatus: "RESOLVED" }],
    },
  };
}

function executionSummary(observations = 0) {
  return {
    observations,
    movement: {
      attempts: observations,
      accepted: observations,
      rejected: 0,
      errors: 0,
    },
    engagement: {
      attempts: 0,
      accepted: 0,
      rejected: 0,
      errors: 0,
      initialAccepted: 0,
      keepAliveAccepted: 0,
    },
    food: {
      attempts: 0,
      committed: 0,
      deferred: 0,
      rejected: 0,
      errors: 0,
      totalHealing: 0,
    },
    prayer: {
      attempts: 0,
      committed: 0,
      rejected: 0,
      errors: 0,
      committedByPrayer: {
        superhuman_strength: 0,
        rock_skin: 0,
        hawk_eye: 0,
        mystic_lore: 0,
      },
    },
    style: {
      attempts: 0,
      accepted: 0,
      rejected: 0,
      errors: 0,
      acceptedByStyle: {
        accurate: 0,
        aggressive: 0,
        controlled: 0,
        defensive: 0,
        longrange: 0,
        rapid: 0,
      },
    },
    roleSwitch: {
      attempts: 0,
      committed: 0,
      deferred: 0,
      rejected: 0,
      errors: 0,
      committedByTargetRole: { melee: 0, ranged: 0, mage: 0 },
    },
    damage: { hits: 0, total: 0 },
    observedCombatRoles: {
      melee: observations,
      ranged: 0,
      mage: 0,
    },
    observedTacticalMacros: {
      pressure: observations,
      hold_range: 0,
      kite: 0,
      orbit: 0,
      defensive_reset: 0,
      finish: 0,
    },
  };
}

function strategyAnalyticsFixture() {
  const shared = {
    schemaVersion: 1,
    cycleId: "cycle-1",
    duelId: "streaming-cycle-1",
    finishedAt: 1_000_000,
    openingStyle: "melee",
    strategyHash:
      "5c20b8e12ee219a17f9ff1d047bdcec408836b53ae72df1f465d1eb9b3ddeef2",
    strategy: {
      schemaVersion: 1,
      approach: "balanced",
      tacticalMacro: "pressure",
      attackStyle: "aggressive",
      prayer: "superhuman_strength",
      preferredCombatRole: null,
      foodThreshold: 40,
      switchDefensiveAt: 30,
      source: "deterministic",
      policyVersion: "test-policy-v1",
    },
    winReason: "kill",
  };
  return {
    audit: "competitive_strategy_outcomes",
    generatedAt: "2026-08-25T12:00:00.000Z",
    databaseAccess: "repeatable_read_read_only",
    descriptiveOnly: true,
    diagnosticScope: {
      included: true,
      boundary: "owned_local_no_value",
      productionMetricsEligible: false,
    },
    queryLimit: 50_000,
    truncated: false,
    terminalRows: 1,
    actionObservationRows: 1,
    report: {
      schemaVersion: 1,
      completedDuels: 1,
      participantSamples: 2,
      firstFinishedAt: shared.finishedAt,
      lastFinishedAt: shared.finishedAt,
      samples: [
        {
          ...shared,
          agentId: "agent-1",
          opponentId: "agent-2",
          result: "win",
          damageDealt: 7,
          damageTaken: 0,
          execution: executionSummary(1),
        },
        {
          ...shared,
          agentId: "agent-2",
          opponentId: "agent-1",
          result: "loss",
          damageDealt: 0,
          damageTaken: 7,
          execution: executionSummary(),
        },
      ],
      aggregates: [],
    },
  };
}

describe("SOL full-topology soak policy", () => {
  it("keeps soak disabled by default and requires the complete SOL topology", () => {
    expect(
      validateDuelFullTopologySoakConfiguration({ durationSeconds: 0 }),
    ).toEqual({ enabled: false, durationSeconds: 0 });
    expect(() =>
      validateDuelFullTopologySoakConfiguration({ durationSeconds: 299 }),
    ).toThrow("at least 300");
    expect(() =>
      validateDuelFullTopologySoakConfiguration({
        durationSeconds: 300,
        withHyperbet: true,
        withKeeper: true,
      }),
    ).toThrow("managed local Solana");
  });

  it("builds a lifecycle, performance, resource, and load-qualified command", () => {
    const configuration = validateDuelFullTopologySoakConfiguration({
      durationSeconds: 600,
      withHyperbet: true,
      withKeeper: true,
      withLocalSolana: true,
    });
    const args = buildDuelFullTopologyLoadArgs({
      configuration,
      serverUrl: "http://127.0.0.1:35551",
      bettingUrl: "http://127.0.0.1:35558",
      evidencePath: "/tmp/soak.json",
    });
    expect(args).toContain("--duration-s=600");
    expect(args).toContain("--min-resolved-duels=1");
    expect(args).toContain("--max-hls-failure-rate=0");
    expect(args).toContain("--max-api-failure-rate=0");
    expect(args).toContain("--require-full-phase-coverage");
    expect(args).toContain("--require-renderer-telemetry");
    expect(args).toContain("--require-resource-ecology-telemetry");
    expect(args).toContain("--json-output=/tmp/soak.json");
  });

  it("builds a bounded maximum-population strategy audit command", () => {
    expect(buildDuelFullTopologyStrategyAuditArgs()).toEqual([
      "packages/server/scripts/audit-competitive-strategy-outcomes.ts",
      "--limit",
      "50000",
      "--include-diagnostics",
    ]);
    expect(() =>
      buildDuelFullTopologyStrategyAuditArgs({ queryLimit: 50_001 }),
    ).toThrow("must not exceed 50000");
  });

  it("retains the exact starting duel before health expiry and drains the final ledger", () => {
    expect(smokeSource).toContain(
      "waitForExactSoakBoundaryEvidence(expectedDuel, signal)",
    );
    expect(smokeSource).toContain(
      "boundaryEvidenceResultPromise = waitForExactSoakBoundaryEvidence(",
    );
    expect(smokeSource).toContain(
      "postSoakTerminal = await waitForDrainedPostSoakTerminalEvidence()",
    );
    expect(smokeSource).toMatch(
      /"--status",\s*"SUCCEEDED",\s*"--limit",\s*"100"/,
    );
    expect(smokeSource).toContain("soakBoundaryTerminal?.exactTerminal");
    expect(smokeSource).toContain("COMPETITIVE_STRATEGY_AUDIT_DATABASE_URL");
    expect(smokeSource).toContain("full-topology-soak-strategy-analytics.json");
    expect(smokeSource).toMatch(
      /redactDuelFullTopologyDiagnostic,[\s\S]*?from "\.\/duel-full-topology-soak-policy\.mjs"/,
    );
  });

  it("aborts every concurrent soak task when one monitor fails", async () => {
    const abortController = new AbortController();
    const waitForAbort = (label) =>
      new Promise((resolve, reject) => {
        abortController.signal.addEventListener(
          "abort",
          () => reject(new Error(`${label} observed abort`)),
          { once: true },
        );
      });

    const results = await settleDuelFullTopologySoakTasks({
      loadPromise: waitForAbort("load"),
      continuityPromise: waitForAbort("continuity"),
      viewerPromise: Promise.resolve({ ok: false, checks: [] }),
      abortController,
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason?.message).toContain(
      "viewer monitor failed",
    );
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "fulfilled",
    ]);
  });

  it("retains actionable parser diagnostics without retaining credentials", () => {
    expect(
      redactDuelFullTopologyDiagnostic(
        "postgresql://audit:database-secret@127.0.0.1/audit RPC https://rpc.test/?api-key=url-secret failed Authorization: Bearer header-secret credential=inline-secret",
      ),
    ).toBe(
      "postgresql://audit:***@127.0.0.1/audit RPC https://rpc.test/?api-key=*** failed Authorization: Bearer *** credential=***",
    );
  });

  it("qualifies an untruncated reciprocal report for the exact acting duel", () => {
    const checks = buildDuelFullTopologyStrategyAnalyticsChecks(
      { cycleId: "cycle-1", duelId: "streaming-cycle-1" },
      strategyAnalyticsFixture(),
    );
    expect(checks.every((check) => check.pass)).toBe(true);
    expect(checks.at(-1)).toMatchObject({ pass: true, actual: 1 });
  });

  it("requalifies the immutable pass5 analytics without rewriting its failed live result", () => {
    const artifactRoot = new URL(
      "../artifacts/sol-full-topology-runtime-v3-pass5-20260905/",
      import.meta.url,
    );
    const analyticsBytes = readFileSync(
      new URL("full-topology-soak-strategy-analytics.json", artifactRoot),
    );
    const soakBytes = readFileSync(
      new URL("full-topology-soak-evidence.json", artifactRoot),
    );
    expect(createHash("sha256").update(analyticsBytes).digest("hex")).toBe(
      "ae71c031937f34959b4087b80b6adc7245f44d38720d2dbb57510760ae7f89ab",
    );
    expect(createHash("sha256").update(soakBytes).digest("hex")).toBe(
      "10621cd2441393669132203f136644351969e6e4509471d459aacbddae03eca0",
    );
    const analytics = JSON.parse(analyticsBytes.toString("utf8"));
    const soak = JSON.parse(soakBytes.toString("utf8"));
    expect(soak.ok).toBe(false);
    expect(soak.checks.filter((check) => !check.pass)).toHaveLength(3);
    expect(analytics.report.samples).toHaveLength(8);
    expect(
      analytics.report.samples.every(
        (sample) => sample.execution.style.acceptedByStyle.longrange === 0,
      ),
    ).toBe(true);
    const checks = buildDuelFullTopologyStrategyAnalyticsChecks(
      soak.soakBoundary,
      analytics,
    );
    expect(checks.map((check) => check.pass)).toEqual([true, true, true, true]);
    expect(checks.at(-1)).toMatchObject({ pass: true, actual: 53 });
    expect(soak.ok).toBe(false);
  });

  it("keeps the exact analytics style schema aligned with the canonical producer enum", () => {
    expect(
      Object.keys(executionSummary().style.acceptedByStyle).sort(),
    ).toEqual([...STREAMING_DUEL_PUBLIC_STYLES].sort());
  });

  it("qualifies a conserved accepted receipt for every canonical combat style", () => {
    for (const style of STREAMING_DUEL_PUBLIC_STYLES) {
      const analytics = strategyAnalyticsFixture();
      const execution = analytics.report.samples[0].execution;
      execution.movement.attempts = 0;
      execution.movement.accepted = 0;
      execution.style.attempts = 1;
      execution.style.accepted = 1;
      execution.style.acceptedByStyle[style] = 1;
      expect(
        buildDuelFullTopologyStrategyAnalyticsChecks(
          { cycleId: "cycle-1", duelId: "streaming-cycle-1" },
          analytics,
        ).map((check) => check.pass),
      ).toEqual([true, true, true, true]);
    }
  });

  it("rejects unknown style keys even when their counts are zero", () => {
    for (const count of [0, 1]) {
      const analytics = strategyAnalyticsFixture();
      analytics.report.samples[0].execution.style.acceptedByStyle.unknown =
        count;
      expect(
        buildDuelFullTopologyStrategyAnalyticsChecks(
          { cycleId: "cycle-1", duelId: "streaming-cycle-1" },
          analytics,
        ).map((check) => check.pass),
      ).toEqual([true, false, false, false]);
    }
  });

  it("rejects missing and invalid counts for every canonical style including longrange", () => {
    const boundary = { cycleId: "cycle-1", duelId: "streaming-cycle-1" };
    for (const style of STREAMING_DUEL_PUBLIC_STYLES) {
      const missing = strategyAnalyticsFixture();
      delete missing.report.samples[0].execution.style.acceptedByStyle[style];
      expect(
        buildDuelFullTopologyStrategyAnalyticsChecks(boundary, missing).map(
          (check) => check.pass,
        ),
      ).toEqual([true, false, false, false]);
      for (const value of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        "0",
        null,
        undefined,
      ]) {
        const invalid = strategyAnalyticsFixture();
        invalid.report.samples[0].execution.style.acceptedByStyle[style] =
          value;
        expect(
          buildDuelFullTopologyStrategyAnalyticsChecks(boundary, invalid).map(
            (check) => check.pass,
          ),
        ).toEqual([true, false, false, false]);
      }
    }
  });

  it("rejects style total, admission, and observation counter drift", () => {
    const boundary = { cycleId: "cycle-1", duelId: "streaming-cycle-1" };
    for (const drift of ["style_total", "admission", "observations"]) {
      const analytics = strategyAnalyticsFixture();
      const execution = analytics.report.samples[0].execution;
      execution.style.acceptedByStyle.longrange = 1;
      if (drift !== "style_total") execution.style.accepted = 1;
      if (drift === "observations") execution.style.attempts = 1;
      expect(
        buildDuelFullTopologyStrategyAnalyticsChecks(boundary, analytics).map(
          (check) => check.pass,
        ),
      ).toEqual([true, false, false, false]);
    }
  });

  it("fails strategy analytics closed on truncation, count drift, missing boundary, or no agent receipts", () => {
    const boundary = {
      cycleId: "cycle-1",
      duelId: "streaming-cycle-1",
    };
    const truncated = strategyAnalyticsFixture();
    truncated.truncated = true;
    expect(
      buildDuelFullTopologyStrategyAnalyticsChecks(boundary, truncated).some(
        (check) => !check.pass,
      ),
    ).toBe(true);

    const countDrift = strategyAnalyticsFixture();
    countDrift.actionObservationRows = 2;
    expect(
      buildDuelFullTopologyStrategyAnalyticsChecks(boundary, countDrift)[1]
        .pass,
    ).toBe(false);

    expect(
      buildDuelFullTopologyStrategyAnalyticsChecks(
        { ...boundary, cycleId: "another-cycle" },
        strategyAnalyticsFixture(),
      )[2].pass,
    ).toBe(false);

    const noReceipts = strategyAnalyticsFixture();
    noReceipts.actionObservationRows = 0;
    noReceipts.report.samples[0].execution = executionSummary();
    const receiptCheck = buildDuelFullTopologyStrategyAnalyticsChecks(
      boundary,
      noReceipts,
    ).at(-1);
    expect(receiptCheck).toMatchObject({ pass: false, actual: 0 });
  });

  it("retains clean, advancing SOL-only continuity evidence", () => {
    const tracker = new DuelFullTopologyContinuityTracker({
      expectedSourceUrl: "http://127.0.0.1:35551/api/streaming/state",
    });
    const startedAt = 1_000_000;
    for (let index = 0; index < 2; index += 1) {
      const observedAt = startedAt + index * 2_000;
      const seq = 10 + index;
      tracker.observe({
        canonicalState: state(seq),
        hyperbetStatus: status(seq, observedAt),
        hyperbetState: state(seq),
        solanaHealth: { result: "ok" },
        bettingUi: { ok: true, status: 200 },
        observedAt,
      });
    }
    const summary = tracker.summary();
    expect(summary).toMatchObject({
      observations: 2,
      validObservations: 2,
      violationObservations: 0,
      issueOccurrences: 0,
      marketLifecycleCounts: { RESOLVED: 2 },
    });
    expect(
      buildDuelFullTopologyContinuityChecks(summary).every(
        (check) => check.pass,
      ),
    ).toBe(true);
  });

  it("requires terminal progress with no unfinished or unsafe operations", () => {
    expect(
      buildDuelFullTopologyTerminalChecks(
        { SUCCEEDED: 1 },
        {
          PENDING: 0,
          PROCESSING: 0,
          SUCCEEDED: 2,
          MANUAL_REVIEW: 0,
          DEAD_LETTER: 0,
        },
      ).every((check) => check.pass),
    ).toBe(true);
    expect(
      buildDuelFullTopologyTerminalChecks(
        { SUCCEEDED: 2 },
        {
          PENDING: 1,
          PROCESSING: 0,
          SUCCEEDED: 2,
          MANUAL_REVIEW: 0,
          DEAD_LETTER: 0,
        },
      ).every((check) => check.pass),
    ).toBe(false);
  });

  it("binds terminal qualification to the exact duel measured from the boundary", () => {
    const duelKey = "11".repeat(32);
    const exactTerminal = {
      operation: {
        id: 7,
        status: "SUCCEEDED",
        duelId: "streaming-cycle-1",
        duelKey,
      },
      market: {
        marketRef: "market-1",
        lifecycleStatus: "RESOLVED",
        duelId: "streaming-cycle-1",
        duelKey,
      },
    };
    expect(
      buildDuelFullTopologyExactTerminalCheck(
        { duelId: "streaming-cycle-1", duelKey },
        exactTerminal,
      ),
    ).toMatchObject({ pass: true });
    expect(
      buildDuelFullTopologyExactTerminalCheck(
        { duelId: "streaming-another-cycle", duelKey },
        exactTerminal,
      ),
    ).toMatchObject({ pass: false });
  });

  it("binds an explicitly local-only immutable dispute package to the soak duel", () => {
    const duelKey = "11".repeat(32);
    const result = {
      ok: true,
      duelId: "streaming-cycle-1",
      duelKey,
      classification: {
        chain: "solana",
        cluster: "localnet",
        externalValue: false,
        productionEquivalentInfrastructure: false,
        releaseEligible: false,
      },
      transactionCount: 6,
      packageDigest: "22".repeat(32),
      artifactSha256: "33".repeat(32),
    };
    expect(
      buildDuelFullTopologyDisputeEvidenceCheck(
        { duelId: result.duelId, duelKey },
        result,
      ),
    ).toMatchObject({ pass: true });
    expect(
      buildDuelFullTopologyDisputeEvidenceCheck(
        { duelId: "another-duel", duelKey },
        result,
      ),
    ).toMatchObject({ pass: false });
    expect(
      buildDuelFullTopologyDisputeEvidenceCheck(
        { duelId: result.duelId, duelKey },
        {
          ...result,
          classification: {
            ...result.classification,
            productionEquivalentInfrastructure: true,
          },
        },
      ),
    ).toMatchObject({ pass: false });
  });

  it("fails closed on readiness, source, chain, UI, RPC, and sequence drift", () => {
    const tracker = new DuelFullTopologyContinuityTracker({
      expectedSourceUrl: "http://127.0.0.1:35551/api/streaming/state",
    });
    const observedAt = 2_000_000;
    tracker.observe({
      canonicalState: state(20),
      hyperbetStatus: status(20, observedAt),
      hyperbetState: state(20),
      solanaHealth: { result: "ok" },
      bettingUi: { ok: true, status: 200 },
      observedAt,
    });
    const broken = status(19, observedAt + 20_000);
    broken.readiness = { ready: false, reasons: ["rpc_stale"] };
    broken.parsers = {
      solana: {
        enabled: true,
        lastSuccessAt: observedAt,
        lastError:
          "finalized lifecycle failed https://rpc.test/?api-key=top-secret",
      },
    };
    broken.stream.sourceUrl = "http://wrong.invalid/state";
    broken.stream.lastSourcePollAt = observedAt;
    broken.stream.sourceEventsConnected = false;
    broken.bot.running = false;
    broken.predictionMarkets.chains[0].chainKey = "legacy-chain";
    tracker.observe({
      canonicalState: state(19),
      hyperbetStatus: broken,
      hyperbetState: state(19),
      solanaHealth: { error: { code: -1 } },
      bettingUi: { ok: false, status: 503 },
      observedAt: observedAt + 20_000,
    });
    const summary = tracker.summary();
    expect(summary.violationObservations).toBe(1);
    expect(summary.issueSamples).toContainEqual(
      expect.objectContaining({
        code: "hyperbet_readiness_failed",
        detail: expect.objectContaining({
          solanaParser: {
            enabled: true,
            lastSuccessAt: observedAt,
            lastError:
              "finalized lifecycle failed https://rpc.test/?api-key=***",
          },
        }),
      }),
    );
    expect(JSON.stringify(summary)).not.toContain("top-secret");
    expect(summary.issueCounts).toMatchObject({
      hyperbetStatus_sequence_regressed: 1,
      hyperbetProxy_sequence_regressed: 1,
      hyperbet_readiness_failed: 1,
      hyperbet_keeper_not_running: 1,
      hyperbet_source_url_mismatch: 1,
      hyperbet_source_events_disconnected: 1,
      hyperbet_source_stale: 1,
      non_solana_market_observed: 1,
      solana_rpc_unhealthy: 1,
      hyperbet_ui_unhealthy: 1,
    });
    expect(
      buildDuelFullTopologyContinuityChecks(summary).find((check) =>
        check.label.includes("violations"),
      )?.pass,
    ).toBe(false);
  });
});
