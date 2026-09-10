import { describe, expect, it, vi } from "vitest";
import { StreamingRuntimeAlertDispatcher } from "../../../src/routes/streaming-runtime-alerts.js";
import type { StreamingRuntimeHealth } from "../../../src/routes/streaming-runtime-health.js";

function health(ready = true): StreamingRuntimeHealth {
  const check = {
    ready,
    reason: ready ? null : "keeper_not_ready",
    observedAt: 9_500,
  };
  return {
    ready,
    emittedAt: 10_000,
    checks: {
      schedulerAuthority: { ...check, ready: true, reason: null },
      bettingFeed: { ...check, ready: true, reason: null },
      renderer: { ...check, ready: true, reason: null },
      captureClient: { ...check, ready: true, reason: null },
      encoder: { ...check, ready: true, reason: null },
      audio: { ...check, ready: true, reason: null },
      rtmpDelivery: { ...check, ready: true, reason: null },
      keeper: check,
      projectileCostCustody: { ...check, ready: true, reason: null },
    },
  };
}

function healthyProjectileCostCustody() {
  return {
    healthy: true,
    status: "healthy" as const,
    maxAgeMs: 14_100,
    pendingAmmunitionShots: 0,
    firedAmmunitionShots: 0,
    pendingRuneCosts: 0,
    firedRuneCosts: 0,
    invalidOperations: 0,
    futureTimestampOperations: 0,
    oldestUnresolvedAgeMs: 0,
  };
}

function observation(runtimeHealth = health()) {
  return {
    health: runtimeHealth,
    projectileCostCustody: healthyProjectileCostCustody(),
    keeperReasons: [] as string[],
    keeperCorrelationIds: [] as string[],
    droppedFrames: 0,
    stalePhase: null,
  };
}

describe("streaming runtime alerts", () => {
  it("does not send an initial all-healthy notification", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 10_000,
    });
    await expect(dispatcher.observe(observation())).resolves.toMatchObject({
      attempted: false,
      sent: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves keeper recovery/orphan reasons in one firing alert", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 10_000,
    });
    const result = await dispatcher.observe({
      ...observation(health(false)),
      keeperCorrelationIds: ["b".repeat(64), "a".repeat(64), "b".repeat(64)],
      keeperReasons: [
        "market-recovery-active",
        "bot-recovery:orphan-order",
        "market-recovery-active",
      ],
    });
    expect(result).toMatchObject({ attempted: true, sent: true });
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body.status).toBe("firing");
    expect(body.routeId).toBe("test.primary");
    expect(body.keeperReasons).toEqual([
      "bot-recovery:orphan-order",
      "market-recovery-active",
    ]);
    expect(body.correlationIds).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "keeper:market-recovery-active" }),
        expect.objectContaining({ key: "keeper:bot-recovery:orphan-order" }),
      ]),
    );
  });

  it("routes privacy-safe stalled projectile custody through the production alert", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 10_000,
    });
    const runtimeHealth = health();
    runtimeHealth.ready = false;
    runtimeHealth.checks.projectileCostCustody = {
      ready: false,
      reason: "projectile_cost_custody_stalled",
      observedAt: 10_000,
    };
    const projectileCostCustody = {
      ...healthyProjectileCostCustody(),
      healthy: false,
      status: "stalled" as const,
      pendingAmmunitionShots: 2,
      firedAmmunitionShots: 1,
      pendingRuneCosts: 3,
      firedRuneCosts: 1,
      oldestUnresolvedAgeMs: 14_101,
      playerId: "private-character-do-not-deliver",
      operationId: "private-operation-do-not-deliver",
    };

    const result = await dispatcher.observe({
      ...observation(runtimeHealth),
      projectileCostCustody,
    });

    expect(result).toMatchObject({
      attempted: true,
      sent: true,
      issues: ["health:projectileCostCustody:projectile_cost_custody_stalled"],
    });
    const payload = String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body);
    expect(payload).not.toContain("private-character-do-not-deliver");
    expect(payload).not.toContain("private-operation-do-not-deliver");
    const parsedPayload = JSON.parse(payload);
    expect(parsedPayload.ready).toBe(false);
    expect(parsedPayload.projectileCostCustody).toEqual({
      healthy: false,
      status: "stalled",
      maxAgeMs: 14_100,
      pendingAmmunitionShots: 2,
      firedAmmunitionShots: 1,
      pendingRuneCosts: 3,
      firedRuneCosts: 1,
      invalidOperations: 0,
      futureTimestampOperations: 0,
      oldestUnresolvedAgeMs: 14_101,
    });
  });

  it("sends a new alert when the affected duel changes under the same issue", async () => {
    let nowMs = 10_000;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => nowMs,
    });
    const first = {
      ...observation(health(false)),
      keeperCorrelationIds: ["1".repeat(64)],
    };
    expect((await dispatcher.observe(first)).sent).toBe(true);
    nowMs += 1_001;
    expect((await dispatcher.observe(first)).attempted).toBe(false);
    expect(
      (
        await dispatcher.observe({
          ...first,
          keeperCorrelationIds: ["2".repeat(64)],
        })
      ).sent,
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("suppresses duplicate alerts, reminds after cooldown, and sends recovery", async () => {
    let nowMs = 10_000;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => nowMs,
    });
    const unhealthy = observation(health(false));
    expect((await dispatcher.observe(unhealthy)).sent).toBe(true);
    nowMs += 5_000;
    expect((await dispatcher.observe(unhealthy)).attempted).toBe(false);
    nowMs += 60_000;
    expect((await dispatcher.observe(unhealthy)).sent).toBe(true);
    nowMs += 5_000;
    expect((await dispatcher.observe(observation())).sent).toBe(true);
    const recoveryBody = JSON.parse(
      String((fetchImpl.mock.calls[2]?.[1] as RequestInit).body),
    );
    expect(recoveryBody.status).toBe("recovered");
    expect(recoveryBody.projectileCostCustody).toEqual(
      healthyProjectileCostCustody(),
    );
  });

  it("alerts on stale phases and increasing dropped-frame counters", async () => {
    let nowMs = 10_000;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => nowMs,
    });
    const result = await dispatcher.observe({
      ...observation(),
      droppedFrames: 3,
      stalePhase: { phase: "FIGHTING", phaseStartedAt: 1_000 },
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "encoder:dropped_frames_increased",
        "scheduler:stale_phase:fighting",
      ]),
    );
    nowMs += 2_000;
    const noIncrease = await dispatcher.observe({
      ...observation(),
      droppedFrames: 3,
      stalePhase: null,
    });
    expect(noIncrease.issues).not.toContain("encoder:dropped_frames_increased");
  });

  it("does not attach keeper correlations to an unrelated stream issue", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 10_000,
    });
    await dispatcher.observe({
      ...observation(),
      keeperCorrelationIds: ["3".repeat(64)],
      droppedFrames: 1,
    });
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body.correlationIds).toEqual([]);
  });

  it("retries a failed delivery without marking it delivered", async () => {
    let nowMs = 10_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => nowMs,
    });
    expect((await dispatcher.observe(observation(health(false)))).sent).toBe(
      false,
    );
    nowMs += 500;
    expect(
      (await dispatcher.observe(observation(health(false)))).attempted,
    ).toBe(false);
    nowMs += 500;
    expect((await dispatcher.observe(observation(health(false)))).sent).toBe(
      true,
    );
  });

  it("retries a failed dropped-frame alert without losing the increment", async () => {
    let nowMs = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => nowMs,
    });
    const droppedFrameObservation = {
      ...observation(),
      droppedFrames: 1,
    };

    expect((await dispatcher.observe(droppedFrameObservation)).sent).toBe(
      false,
    );
    nowMs = 1_000;
    expect((await dispatcher.observe(droppedFrameObservation)).sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not place arbitrary runtime text or credentials in alert payloads", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = new StreamingRuntimeAlertDispatcher({
      webhookUrl: "https://alerts.example/streaming",
      routeId: "test.primary",
      reminderMs: 60_000,
      retryMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 10_000,
    });
    const unsafeHealth = health(false);
    unsafeHealth.checks.keeper.reason =
      "https://rpc.example/?token=do-not-deliver";

    await dispatcher.observe({
      ...observation(unsafeHealth),
      keeperReasons: ["", "api-key=do-not-deliver"],
      keeperCorrelationIds: [
        "A".repeat(64),
        "token=do-not-deliver",
        "f".repeat(64),
      ],
    });

    const payload = String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body);
    expect(payload).not.toContain("do-not-deliver");
    expect(payload).not.toContain("rpc.example");
    expect(JSON.parse(payload)).toMatchObject({
      correlationIds: ["f".repeat(64)],
      keeperReasons: ["unclassified_keeper_reason"],
      issues: expect.arrayContaining([
        expect.objectContaining({
          key: "health:keeper:unclassified_not_ready",
        }),
        expect.objectContaining({
          key: "keeper:unclassified_keeper_reason",
        }),
      ]),
    });
  });
});
