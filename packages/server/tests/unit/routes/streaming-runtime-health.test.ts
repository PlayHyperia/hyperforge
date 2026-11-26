import { describe, expect, it, vi } from "vitest";
import {
  evaluateStreamingRuntimeHealth,
  loadKeeperRuntimeObservation,
  resolveStreamingLiveAudioRequired,
} from "../../../src/routes/streaming-runtime-health.js";

function healthyInput() {
  return {
    nowMs: 10_000,
    schedulerRunning: true,
    schedulerAuthorityVerified: true,
    schedulerAuthorityObservedAt: 9_500,
    feedObservedAt: 9_500,
    feedMaxAgeMs: 2_000,
    renderer: {
      ready: true,
      degradedReason: null,
      updatedAt: 9_500,
    },
    captureClientConnected: true,
    encoderRunning: true,
    encoderHealthy: true,
    audioRequired: true,
    audioSource: "pulse" as const,
    audioHealthy: true,
    deliveryConfigured: true,
    deliveryHealthy: true,
    deliveryObservedAt: 9_500,
    keeper: {
      configured: true,
      ready: true,
      observedAt: 9_500,
      error: null,
      reasons: [],
      correlationIds: [],
    },
    keeperMaxAgeMs: 2_000,
    projectileCostCustody: {
      healthy: true,
      status: "healthy" as const,
    },
  };
}

describe("streaming runtime health", () => {
  it("is ready only when every measured launch dependency is healthy", () => {
    const health = evaluateStreamingRuntimeHealth(healthyInput());
    expect(health.ready).toBe(true);
    expect(Object.values(health.checks).every((entry) => entry.ready)).toBe(
      true,
    );
  });

  it("fails closed for each missing, stale, or unhealthy dependency", () => {
    const mutations = [
      { schedulerRunning: false },
      { schedulerAuthorityVerified: false },
      { feedObservedAt: null },
      { feedObservedAt: 1_000 },
      {
        renderer: {
          ready: false,
          degradedReason: "gpu_lost",
          updatedAt: 9_500,
        },
      },
      { captureClientConnected: false },
      { encoderRunning: false },
      { encoderHealthy: false },
      { audioSource: "silent" as const },
      { audioSource: "uninitialized" as const },
      { audioHealthy: false },
      { deliveryConfigured: false },
      { deliveryHealthy: false },
      {
        keeper: {
          configured: false,
          ready: false,
          observedAt: null,
          error: null,
          reasons: [],
          correlationIds: [],
        },
      },
      {
        keeper: {
          configured: true,
          ready: false,
          observedAt: 9_500,
          error: null,
          reasons: ["market-recovery-active"],
          correlationIds: [],
        },
      },
      {
        keeper: {
          configured: true,
          ready: true,
          observedAt: 1_000,
          error: null,
          reasons: [],
          correlationIds: [],
        },
      },
      {
        projectileCostCustody: {
          healthy: false,
          status: "stalled" as const,
        },
      },
    ];

    for (const mutation of mutations) {
      expect(
        evaluateStreamingRuntimeHealth({
          ...healthyInput(),
          ...mutation,
        }).ready,
      ).toBe(false);
    }
  });

  it("reports the exact aggregate projectile-custody failure reason", () => {
    expect(
      evaluateStreamingRuntimeHealth({
        ...healthyInput(),
        projectileCostCustody: {
          healthy: false,
          status: "invalid",
        },
      }).checks.projectileCostCustody,
    ).toEqual({
      ready: false,
      reason: "projectile_cost_custody_invalid",
      observedAt: 10_000,
    });
  });

  it("accepts a fresh browser master-mix source and rejects a stale one", () => {
    expect(
      evaluateStreamingRuntimeHealth({
        ...healthyInput(),
        audioSource: "browser",
        audioHealthy: true,
      }).checks.audio,
    ).toMatchObject({ ready: true, reason: null });

    expect(
      evaluateStreamingRuntimeHealth({
        ...healthyInput(),
        audioSource: "browser",
        audioHealthy: false,
      }).checks.audio,
    ).toMatchObject({
      ready: false,
      reason: "stream_audio_source_stale",
    });
  });

  it("requires live audio in production and strictly parses local overrides", () => {
    expect(resolveStreamingLiveAudioRequired(undefined, "production")).toBe(
      true,
    );
    expect(resolveStreamingLiveAudioRequired("false", "production")).toBe(true);
    expect(resolveStreamingLiveAudioRequired(undefined, "development")).toBe(
      false,
    );
    expect(resolveStreamingLiveAudioRequired("true", "development")).toBe(true);
    expect(resolveStreamingLiveAudioRequired("off", "test")).toBe(false);
    expect(() =>
      resolveStreamingLiveAudioRequired("sometimes", "development"),
    ).toThrow(/must be true or false/);
  });

  it("loads and validates keeper readiness without trusting HTTP 200 alone", async () => {
    const ready = await loadKeeperRuntimeObservation({
      url: "https://keeper.example/ready",
      timeoutMs: 1_000,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              now: 9_500,
              correlationIds: ["b".repeat(64), "a".repeat(64), "b".repeat(64)],
              readiness: { ready: true, reasons: [] },
            }),
            { status: 200 },
          ),
      ),
    });
    expect(ready).toEqual({
      configured: true,
      ready: true,
      observedAt: 9_500,
      error: null,
      reasons: [],
      correlationIds: ["a".repeat(64), "b".repeat(64)],
    });

    const degraded = await loadKeeperRuntimeObservation({
      url: "https://keeper.example/ready",
      timeoutMs: 1_000,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              now: 9_600,
              correlationIds: ["NOT-CANONICAL", "c".repeat(64)],
              readiness: {
                ready: false,
                reasons: ["market-recovery-active", "market-recovery-active"],
              },
            }),
            { status: 200 },
          ),
      ),
    });
    expect(degraded.ready).toBe(false);
    expect(degraded.reasons).toEqual(["market-recovery-active"]);
    expect(degraded.correlationIds).toEqual(["c".repeat(64)]);
  });

  it("reports missing, HTTP-failed, and timed-out keeper sources", async () => {
    await expect(
      loadKeeperRuntimeObservation({ url: null, timeoutMs: 10 }),
    ).resolves.toMatchObject({ configured: false, ready: false });

    await expect(
      loadKeeperRuntimeObservation({
        url: "https://keeper.example/ready",
        timeoutMs: 10,
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                now: 9_700,
                readiness: {
                  ready: false,
                  reasons: ["bot-recovery:orphan-order"],
                },
              }),
              { status: 503 },
            ),
        ),
      }),
    ).resolves.toMatchObject({
      configured: true,
      ready: false,
      error: "HTTP 503",
      reasons: ["bot-recovery:orphan-order"],
    });

    await expect(
      loadKeeperRuntimeObservation({
        url: "https://keeper.example/ready",
        timeoutMs: 5,
        fetchImpl: vi.fn(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        ),
      }),
    ).resolves.toMatchObject({
      configured: true,
      ready: false,
      error: "timeout after 5ms",
    });
  });
});
