import { afterEach, describe, expect, it, vi } from "vitest";
import type { World } from "../../../core/World";
import type { WorldOptions } from "../../../types";
import { DevStats } from "../DevStats";
import type { StreamingPerformanceSnapshot } from "../StreamPerformanceTelemetry";

type TestWindow = Window & {
  __HYPERIA_STREAM_RENDERER_HEALTH__?: { phase?: string | null } | null;
  __HYPERIA_STREAM_PERFORMANCE__?: StreamingPerformanceSnapshot | null;
};

describe("DevStats stream telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("tracks a production stream viewport without creating the developer UI", async () => {
    const render = { calls: 42, triangles: 12_345 };
    const reset = vi.fn(() => {
      render.calls = 0;
      render.triangles = 0;
    });
    const observe = vi.fn();
    const disconnect = vi.fn();
    let resourceCallback: PerformanceObserverCallback | null = null;
    class TestPerformanceObserver {
      static readonly supportedEntryTypes = ["resource"];

      constructor(callback: PerformanceObserverCallback) {
        resourceCallback = callback;
      }

      observe(options?: PerformanceObserverInit): void {
        observe(options);
      }

      disconnect(): void {
        disconnect();
      }

      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    vi.stubGlobal("PerformanceObserver", TestPerformanceObserver);
    const fakeWindow = {
      location: {
        hostname: "stream.hyperia.example",
        pathname: "/stream.html",
        search: "",
      },
      innerWidth: 1_280,
      innerHeight: 720,
      devicePixelRatio: 2,
      __HYPERIA_STREAM_RENDERER_HEALTH__: { phase: "FIGHTING" },
    } as unknown as TestWindow;
    vi.stubGlobal("window", fakeWindow);

    const world = {
      graphics: {
        width: 1_280,
        height: 720,
        renderer: {
          getPixelRatio: () => 1.5,
          info: {
            render,
            memory: { textures: 18, geometries: 27 },
            reset,
          },
        },
      },
    } as unknown as World;

    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stats = new DevStats(world);
    await stats.init({} as WorldOptions);

    expect(observe).toHaveBeenCalledWith({
      type: "resource",
      buffered: true,
    });
    resourceCallback?.(
      {
        getEntries: () => [
          {
            entryType: "resource",
            name: "https://assets.example/private/duelist.glb?token=secret",
            initiatorType: "fetch",
            duration: 125.4,
            requestStart: 10,
            responseStart: 50,
            transferSize: 0,
            encodedBodySize: 1_000,
            decodedBodySize: 2_000,
          } as PerformanceResourceTiming,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver,
    );

    now = 100;
    stats.preTick();
    now = 106;
    stats.postLateUpdate(0);
    now = 108;
    stats.postTick();

    expect(reset).toHaveBeenCalledOnce();
    expect(fakeWindow.__HYPERIA_STREAM_PERFORMANCE__).toMatchObject({
      schemaVersion: 1,
      currentPhase: "FIGHTING",
      overall: {
        frames: 1,
        frameIntervalMs: { samples: 0 },
        frameWorkMs: { samples: 1, p50: 8, max: 8 },
        cpuMs: { samples: 1, p50: 6, max: 6 },
        renderSubmitMs: { samples: 1, p50: 2, max: 2 },
        renderer: {
          drawCalls: { latest: 42, max: 42 },
          triangles: { latest: 12_345, max: 12_345 },
          textures: { latest: 18, max: 18 },
          geometries: { latest: 27, max: 27 },
        },
      },
      viewport: { width: 1_280, height: 720, devicePixelRatio: 1.5 },
      resources: {
        entries: 1,
        cacheHits: 1,
        transferBytes: 0,
        encodedBodyBytes: 1_000,
        decodedBodyBytes: 2_000,
        durationMs: { samples: 1, p50: 125, max: 125 },
        responseWaitMs: { samples: 1, p50: 40, max: 40 },
        byCategory: { model: { entries: 1 } },
      },
    });
    expect(
      JSON.stringify(fakeWindow.__HYPERIA_STREAM_PERFORMANCE__),
    ).not.toContain("token=secret");

    fakeWindow.__HYPERIA_STREAM_RENDERER_HEALTH__ = {
      phase: "RESOLUTION",
    };
    now = 124;
    stats.preTick();
    now = 130;
    stats.postLateUpdate(0);
    now = 133;
    stats.postTick();

    expect(stats.getStreamingPerformanceSnapshot()).toMatchObject({
      currentPhase: "RESOLUTION",
      overall: {
        frames: 2,
        frameIntervalMs: { samples: 1, p50: 25, max: 25 },
      },
      byPhase: {
        FIGHTING: { frames: 1 },
        RESOLUTION: { frames: 1 },
      },
    });

    stats.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(fakeWindow.__HYPERIA_STREAM_PERFORMANCE__).toBeNull();
  });

  it.each([false, true])(
    "converts WebGPU's cumulative draw-call counter to per-frame values (no-op reset=%s)",
    async (hasNoOpReset) => {
      const fakeWindow = {
        location: {
          hostname: "stream.hyperia.example",
          pathname: "/stream.html",
          search: "",
        },
        innerWidth: 1_280,
        innerHeight: 720,
        devicePixelRatio: 1,
        __HYPERIA_STREAM_RENDERER_HEALTH__: { phase: "FIGHTING" },
      } as unknown as TestWindow;
      vi.stubGlobal("window", fakeWindow);

      const render = { calls: 120, triangles: 4_000_000 };
      const world = {
        graphics: {
          width: 1_280,
          height: 720,
          renderer: {
            getPixelRatio: () => 1,
            info: {
              render,
              memory: { textures: 18, geometries: 27 },
              ...(hasNoOpReset ? { reset: vi.fn() } : {}),
            },
          },
        },
      } as unknown as World;

      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const stats = new DevStats(world);
      await stats.init({} as WorldOptions);

      now = 100;
      stats.preTick();
      now = 108;
      stats.postTick();
      expect(
        stats.getStreamingPerformanceSnapshot()?.overall.renderer.drawCalls,
      ).toMatchObject({ latest: 0, max: 0 });

      render.calls = 145;
      now = 116;
      stats.preTick();
      now = 124;
      stats.postTick();
      expect(
        stats.getStreamingPerformanceSnapshot()?.overall.renderer.drawCalls,
      ).toMatchObject({ latest: 25, max: 25 });
      expect(
        stats.getStreamingPerformanceSnapshot()?.overall.renderer.triangles,
      ).toMatchObject({ latest: 4_000_000, max: 4_000_000 });

      stats.destroy();
    },
  );

  it("collects sanitized per-system evidence only for opt-in stream profiling", async () => {
    const fakeWindow = {
      location: {
        hostname: "stream.hyperia.example",
        pathname: "/stream.html",
        search: "?streamProfile=systems",
      },
      innerWidth: 1_280,
      innerHeight: 720,
      devicePixelRatio: 1,
      __HYPERIA_STREAM_RENDERER_HEALTH__: { phase: "RESOLUTION" },
    } as unknown as TestWindow;
    vi.stubGlobal("window", fakeWindow);

    const enableSystemTiming = vi.fn();
    const disableSystemTiming = vi.fn();
    const getSystemTimings = vi.fn(() => [
      {
        name: "terrain",
        fixedUpdate: 1,
        update: 40,
        lateUpdate: 4,
        total: 45,
        avg: 10,
      },
    ]);
    const world = {
      enableSystemTiming,
      disableSystemTiming,
      getSystemTimings,
      graphics: {
        width: 1_280,
        height: 720,
        renderer: {
          getPixelRatio: () => 1,
          info: {
            render: { calls: 10, triangles: 1_000 },
            memory: { textures: 5, geometries: 6 },
          },
        },
      },
    } as unknown as World;

    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stats = new DevStats(world);
    await stats.init({} as WorldOptions);
    expect(enableSystemTiming).toHaveBeenCalledOnce();

    now = 100;
    stats.preTick();
    now = 155;
    stats.postLateUpdate(0);
    now = 160;
    stats.postTick();

    expect(getSystemTimings).toHaveBeenCalledOnce();
    expect(stats.getStreamingPerformanceSnapshot()?.longFrames).toEqual([
      expect.objectContaining({
        phase: "RESOLUTION",
        frameWorkMs: 60,
        topSystems: [
          {
            name: "terrain",
            fixedUpdateMs: 1,
            updateMs: 40,
            lateUpdateMs: 4,
            totalMs: 45,
          },
        ],
      }),
    ]);

    stats.destroy();
    expect(disableSystemTiming).toHaveBeenCalledOnce();
  });
});
