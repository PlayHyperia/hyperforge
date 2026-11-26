import { describe, expect, it } from "vitest";
import {
  classifyStreamResourceCategory,
  MAX_STREAM_LONG_FRAME_SAMPLES,
  normalizeStreamingPerformanceSnapshot,
  StreamPerformanceTelemetry,
  type StreamPerformanceFrameSample,
} from "../StreamPerformanceTelemetry";

function sample(
  overrides: Partial<StreamPerformanceFrameSample> = {},
): StreamPerformanceFrameSample {
  return {
    phase: "FIGHTING",
    frameIntervalMs: 16.4,
    frameWorkMs: 8,
    cpuMs: 6,
    renderSubmitMs: 2,
    drawCalls: 100,
    triangles: 10_000,
    textures: 20,
    geometries: 30,
    jsHeap: {
      usedBytes: 100_000,
      totalBytes: 200_000,
      limitBytes: 1_000_000,
    },
    viewport: {
      width: 1_280,
      height: 720,
      devicePixelRatio: 1,
    },
    ...overrides,
  };
}

describe("StreamPerformanceTelemetry", () => {
  it("retains complete bounded frame and phase percentiles", () => {
    const telemetry = new StreamPerformanceTelemetry(1_000);
    telemetry.record(sample({ frameIntervalMs: null }));
    telemetry.record(sample({ frameIntervalMs: 16.4, drawCalls: 100 }));
    telemetry.record(sample({ frameIntervalMs: 34, drawCalls: 110 }));
    telemetry.record(
      sample({
        phase: "RESOLUTION",
        frameIntervalMs: 51,
        drawCalls: 120,
      }),
    );
    telemetry.record(
      sample({
        phase: "RESOLUTION",
        frameIntervalMs: 101,
        drawCalls: 130,
        jsHeap: {
          usedBytes: 125_000,
          totalBytes: 225_000,
          limitBytes: 1_000_000,
        },
      }),
    );

    const snapshot = telemetry.snapshot(2_000);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      sessionStartedAt: 1_000,
      updatedAt: 2_000,
      uptimeMs: 1_000,
      currentPhase: "RESOLUTION",
      jsHeap: {
        usedBytes: 125_000,
        totalBytes: 225_000,
        limitBytes: 1_000_000,
      },
      viewport: { width: 1_280, height: 720, devicePixelRatio: 1 },
    });
    expect(snapshot.overall.frames).toBe(5);
    expect(snapshot.overall.frameIntervalMs).toEqual({
      samples: 4,
      average: 50.5,
      p50: 34,
      p95: 101,
      p99: 101,
      max: 101,
    });
    expect(snapshot.overall.frameBudget).toEqual({
      above16_67Ms: 3,
      above33_33Ms: 3,
      above50Ms: 2,
      above100Ms: 1,
    });
    expect(snapshot.overall.renderer.drawCalls).toEqual({
      samples: 5,
      average: 112,
      latest: 130,
      max: 130,
    });
    expect(snapshot.byPhase.FIGHTING.frames).toBe(3);
    expect(snapshot.byPhase.RESOLUTION.frames).toBe(2);
  });

  it("normalizes process-boundary snapshots and strips unknown fields", () => {
    const telemetry = new StreamPerformanceTelemetry(1_000);
    telemetry.record(sample());
    const snapshot = telemetry.snapshot(2_000);

    expect(
      normalizeStreamingPerformanceSnapshot({
        ...snapshot,
        arbitraryInjectedField: { secret: true },
      }),
    ).toEqual(snapshot);
  });

  it("retains only the latest bounded, allowlisted long-frame evidence", () => {
    const telemetry = new StreamPerformanceTelemetry(1_000);
    for (let index = 1; index <= MAX_STREAM_LONG_FRAME_SAMPLES + 2; index++) {
      telemetry.record(
        sample({
          phase: "RESOLUTION",
          observedAt: 1_000 + index,
          frameIntervalMs: 60 + index / 100,
          frameWorkMs: index === 2 ? 75 : 20,
          cpuMs: 5,
          renderSubmitMs: 15,
          systemTimings: [
            {
              name: "terrain",
              fixedUpdate: 1,
              update: 12.345,
              lateUpdate: 0.5,
              total: 13.845,
            },
            {
              name: "camera",
              fixedUpdate: 0,
              update: 0,
              lateUpdate: 4,
              total: 4,
            },
            {
              name: "../../private",
              fixedUpdate: 0,
              update: 100,
              lateUpdate: 0,
              total: 100,
            },
          ],
        }),
      );
    }

    const snapshot = telemetry.snapshot(2_000);
    expect(snapshot.longFrames).toHaveLength(MAX_STREAM_LONG_FRAME_SAMPLES);
    expect(snapshot.longFrames[0]).toMatchObject({
      frameSequence: 3,
      phase: "RESOLUTION",
      phaseFrame: 3,
      uptimeMs: 3,
      resourceEntries: 0,
      jsHeapUsedBytes: 100_000,
      topSystems: [
        {
          name: "terrain",
          fixedUpdateMs: 1,
          updateMs: 12.35,
          lateUpdateMs: 0.5,
          totalMs: 13.85,
        },
        {
          name: "camera",
          fixedUpdateMs: 0,
          updateMs: 0,
          lateUpdateMs: 4,
          totalMs: 4,
        },
      ],
    });
    expect(snapshot.longFrames[snapshot.longFrames.length - 1]).toMatchObject({
      frameSequence: MAX_STREAM_LONG_FRAME_SAMPLES + 2,
      phaseFrame: MAX_STREAM_LONG_FRAME_SAMPLES + 2,
    });

    expect(
      normalizeStreamingPerformanceSnapshot({
        ...snapshot,
        longFrames: snapshot.longFrames.map((entry) => ({
          ...entry,
          privateUrl: "https://example.invalid/?token=secret",
          topSystems: entry.topSystems.map((timing) => ({
            ...timing,
            privateUrl: "https://example.invalid/?token=secret",
          })),
        })),
      }),
    ).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain("privateUrl");
  });

  it("retains bounded aggregate resource timing without retaining URLs", () => {
    const telemetry = new StreamPerformanceTelemetry(1_000);
    telemetry.enableResourceTimingCollection();
    telemetry.recordResource({
      category: classifyStreamResourceCategory(
        "https://assets.example/private/duelist.glb?token=secret",
        "fetch",
      ),
      durationMs: 125.4,
      responseWaitMs: 40,
      transferBytes: 0,
      encodedBodyBytes: 1_000,
      decodedBodyBytes: 2_000,
      cacheHit: true,
    });
    telemetry.recordResource({
      category: classifyStreamResourceCategory(
        "https://api.example/stream/state",
        "fetch",
      ),
      durationMs: 50.6,
      responseWaitMs: 25.2,
      transferBytes: 700,
      encodedBodyBytes: 400,
      decodedBodyBytes: 800,
      cacheHit: false,
    });

    const snapshot = telemetry.snapshot(2_000);
    expect(snapshot.resources).toEqual({
      entries: 2,
      cacheHits: 1,
      transferBytes: 700,
      encodedBodyBytes: 1_400,
      decodedBodyBytes: 2_800,
      durationMs: {
        samples: 2,
        average: 88,
        p50: 51,
        p95: 125,
        p99: 125,
        max: 125,
      },
      responseWaitMs: {
        samples: 2,
        average: 32.5,
        p50: 25,
        p95: 40,
        p99: 40,
        max: 40,
      },
      byCategory: {
        api: {
          entries: 1,
          cacheHits: 0,
          transferBytes: 700,
          encodedBodyBytes: 400,
          decodedBodyBytes: 800,
          durationMs: {
            samples: 1,
            average: 51,
            p50: 51,
            p95: 51,
            p99: 51,
            max: 51,
          },
          responseWaitMs: {
            samples: 1,
            average: 25,
            p50: 25,
            p95: 25,
            p99: 25,
            max: 25,
          },
        },
        model: {
          entries: 1,
          cacheHits: 1,
          transferBytes: 0,
          encodedBodyBytes: 1_000,
          decodedBodyBytes: 2_000,
          durationMs: {
            samples: 1,
            average: 125,
            p50: 125,
            p95: 125,
            p99: 125,
            max: 125,
          },
          responseWaitMs: {
            samples: 1,
            average: 40,
            p50: 40,
            p95: 40,
            p99: 40,
            max: 40,
          },
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("token=secret");
    expect(normalizeStreamingPerformanceSnapshot(snapshot)).toEqual(snapshot);
  });

  it("classifies stream assets by extension before browser initiator", () => {
    expect(classifyStreamResourceCategory("/arena.glb?v=1", "fetch")).toBe(
      "model",
    );
    expect(classifyStreamResourceCategory("/impact.ogg", "fetch")).toBe(
      "audio",
    );
    expect(classifyStreamResourceCategory("/state", "xmlhttprequest")).toBe(
      "api",
    );
    expect(classifyStreamResourceCategory("not a url", "unknown")).toBe(
      "other",
    );
  });

  it("rejects inconsistent percentiles, counters, and timestamps", () => {
    const telemetry = new StreamPerformanceTelemetry(1_000);
    telemetry.record(sample());
    const snapshot = telemetry.snapshot(2_000);

    expect(
      normalizeStreamingPerformanceSnapshot({
        ...snapshot,
        uptimeMs: 999,
      }),
    ).toBeNull();
    expect(
      normalizeStreamingPerformanceSnapshot({
        ...snapshot,
        overall: {
          ...snapshot.overall,
          frameBudget: {
            ...snapshot.overall.frameBudget,
            above100Ms: 2,
          },
        },
      }),
    ).toBeNull();
    expect(
      normalizeStreamingPerformanceSnapshot({
        ...snapshot,
        overall: {
          ...snapshot.overall,
          frameIntervalMs: {
            ...snapshot.overall.frameIntervalMs,
            p50: 500,
          },
        },
      }),
    ).toBeNull();
    expect(
      normalizeStreamingPerformanceSnapshot({
        ...snapshot,
        resources: {
          entries: 1,
          cacheHits: 0,
          transferBytes: 0,
          encodedBodyBytes: 0,
          decodedBodyBytes: 0,
          durationMs: {
            samples: 0,
            average: 0,
            p50: 0,
            p95: 0,
            p99: 0,
            max: 0,
          },
          responseWaitMs: {
            samples: 1,
            average: 0,
            p50: 0,
            p95: 0,
            p99: 0,
            max: 0,
          },
          byCategory: {},
        },
      }),
    ).toBeNull();
    expect(
      normalizeStreamingPerformanceSnapshot({
        ...snapshot,
        longFrames: [
          {
            frameSequence: 2,
            phase: "FIGHTING",
            phaseFrame: 1,
            uptimeMs: 500,
            frameIntervalMs: 75,
            frameWorkMs: 60,
            cpuMs: 40,
            renderSubmitMs: 20,
            drawCalls: 1,
            triangles: 1,
            textures: 1,
            geometries: 1,
            jsHeapUsedBytes: null,
            resourceEntries: 0,
          },
        ],
      }),
    ).toBeNull();
  });
});
