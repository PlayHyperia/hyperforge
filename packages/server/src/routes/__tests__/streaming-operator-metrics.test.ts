import { describe, expect, it } from "vitest";

import {
  buildStreamingOperatorMetrics,
  parseStreamingOperatorMetrics,
} from "../streaming-operator-metrics.js";
import type { StreamingRuntimeHealth } from "../streaming-runtime-health.js";

function runtimeHealth(): StreamingRuntimeHealth {
  const observedAt = 9_000;
  return {
    ready: true,
    emittedAt: 10_000,
    checks: {
      schedulerAuthority: { ready: true, reason: null, observedAt: 9_100 },
      bettingFeed: { ready: true, reason: null, observedAt: 9_200 },
      renderer: { ready: true, reason: null, observedAt: 9_300 },
      captureClient: { ready: true, reason: null, observedAt },
      encoder: { ready: true, reason: null, observedAt },
      audio: { ready: true, reason: null, observedAt },
      rtmpDelivery: { ready: true, reason: null, observedAt },
      keeper: { ready: true, reason: null, observedAt: 9_400 },
      projectileCostCustody: {
        ready: true,
        reason: null,
        observedAt: 9_500,
      },
    },
  };
}

describe("streaming operator metrics", () => {
  it("projects bounded numeric dependency ages and frame cadence", () => {
    const metrics = buildStreamingOperatorMetrics({
      nowMs: 10_000,
      health: runtimeHealth(),
      rendererPerformance: {
        overall: {
          frames: 600,
          frameIntervalMs: { average: 16.667, p95: 18 },
          frameWorkMs: { p95: 7 },
        },
        longFrames: [{}, {}],
      },
      captureHealth: { targetFps: 30, measuredFps: 29.97 },
      encoderFps: 29.9,
      droppedFrames: 2,
    });

    expect(metrics).toEqual({
      schemaVersion: 1,
      observedAtMs: 10_000,
      ready: true,
      agesMs: {
        schedulerAuthority: 900,
        bettingFeed: 800,
        renderer: 700,
        captureClient: 1_000,
        encoder: 1_000,
        audio: 1_000,
        rtmpDelivery: 1_000,
        keeper: 600,
        projectileCostCustody: 500,
      },
      frames: {
        rendererSamples: 600,
        rendererEstimatedFps: 59.999,
        rendererFrameIntervalP95Ms: 18,
        rendererFrameWorkP95Ms: 7,
        rendererLongFrameCount: 2,
        captureTargetFps: 30,
        captureMeasuredFps: 29.97,
        encoderReportedFps: 29.9,
        droppedFrames: 2,
      },
    });
    expect(parseStreamingOperatorMetrics(metrics)).toEqual(metrics);
  });

  it("uses explicit nulls instead of inventing unavailable FPS", () => {
    const health = runtimeHealth();
    health.ready = false;
    health.checks.renderer = {
      ready: false,
      reason: "renderer_not_ready",
      observedAt: null,
    };
    const metrics = buildStreamingOperatorMetrics({
      nowMs: 10_000,
      health,
      rendererPerformance: null,
      captureHealth: null,
      encoderFps: undefined,
      droppedFrames: Number.NaN,
    });

    expect(metrics.ready).toBe(false);
    expect(metrics.agesMs.renderer).toBeNull();
    expect(metrics.frames).toEqual({
      rendererSamples: 0,
      rendererEstimatedFps: null,
      rendererFrameIntervalP95Ms: null,
      rendererFrameWorkP95Ms: null,
      rendererLongFrameCount: 0,
      captureTargetFps: null,
      captureMeasuredFps: null,
      encoderReportedFps: null,
      droppedFrames: 0,
    });
  });

  it("rejects contradictory serialized frame projections", () => {
    const metrics = buildStreamingOperatorMetrics({
      nowMs: 10_000,
      health: runtimeHealth(),
      rendererPerformance: null,
      captureHealth: null,
      encoderFps: null,
      droppedFrames: 0,
    });
    expect(
      parseStreamingOperatorMetrics({
        ...metrics,
        agesMs: {
          ...metrics.agesMs,
          projectileCostCustody: undefined,
        },
      }),
    ).toBeNull();
    expect(
      parseStreamingOperatorMetrics({
        ...metrics,
        frames: { ...metrics.frames, rendererEstimatedFps: 60 },
      }),
    ).toBeNull();
    expect(
      parseStreamingOperatorMetrics({
        ...metrics,
        frames: {
          ...metrics.frames,
          rendererSamples: 1,
          rendererEstimatedFps: 60,
          rendererLongFrameCount: 2,
        },
      }),
    ).toBeNull();
  });
});
