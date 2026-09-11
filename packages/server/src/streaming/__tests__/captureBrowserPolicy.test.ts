import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { STREAMING_RENDER_PROFILES } from "../../../../shared/src/runtime/clientViewportMode";
import {
  applyCaptureFrameRateToUrl,
  assertCaptureRenderProfileContract,
  buildDefaultCaptureLaunchArgs,
  CANONICAL_CAPTURE_RENDER_PROFILE,
  CAPTURE_RENDER_PROFILE_CONTRACTS,
  DEFAULT_CAPTURE_GAME_URL,
  FALLBACK_CAPTURE_RENDER_PROFILE,
  SHADOWS_CAPTURE_RENDER_PROFILE,
  matchesExpectedCaptureRenderProfile,
  normalizeCaptureRenderProfileSnapshot,
  resolveAllowedCaptureOrigins,
  resolveCaptureBrowserEndpoint,
  resolveCaptureRenderProfileForUrls,
  resolveCaptureRenderProfileId,
  resolveDefaultCaptureFeatureFlags,
  resolveCaptureUrlCandidates,
  resolveUnexpectedCaptureOrigin,
  shouldAcceptCaptureReadiness,
} from "../captureBrowserPolicy";

// Pure wire-contract fixture, not a renderer or GPU qualification substitute.
function shadowApplicationSnapshot() {
  const preferences = {
    dpr: 1,
    shadows: "med",
    postprocessing: false,
    bloom: false,
    colorGrading: "none",
    depthBlur: false,
    waterReflections: false,
    entityHighlighting: false,
  };
  return {
    ...CAPTURE_RENDER_PROFILE_CONTRACTS[SHADOWS_CAPTURE_RENDER_PROFILE],
    explicit: true,
    application: {
      schemaVersion: 1 as const,
      ready: true,
      mismatchReason: null,
      requested: { ...preferences },
      applied: {
        preferences: { ...preferences },
        renderer: {
          isWebGPU: true,
          hasRendered: true,
          dpr: 1,
          width: 1280,
          height: 720,
          samples: 4,
          shadowsEnabled: true,
          shadowType: 1,
          postprocessing: false,
          composerPresent: false,
        },
        sunlight: {
          name: "SunLight_Single",
          castShadow: true,
          cascaded: false,
          mapSize: [4096, 4096] as const,
          allocatedMapSize: [4096, 4096] as const,
          frustum: [-200, 200, 200, -200, 0.5, 600] as const,
          bias: 0.0002,
          normalBias: 0.01,
        },
        water: { reflectionsEnabled: false, activeReflectionCount: 0 },
      },
    },
  };
}

describe("captureBrowserPolicy", () => {
  it("keeps server contracts equal to the actual shared profiles without changing defaults", () => {
    expect(CAPTURE_RENDER_PROFILE_CONTRACTS).toEqual(STREAMING_RENDER_PROFILES);
    expect(resolveCaptureRenderProfileId(60)).toBe(
      CANONICAL_CAPTURE_RENDER_PROFILE,
    );
    expect(resolveCaptureRenderProfileId(30)).toBe(
      FALLBACK_CAPTURE_RENDER_PROFILE,
    );
    expect(resolveCaptureRenderProfileId(45)).toBeNull();
  });

  it("preserves the explicit shadow candidate and requires consistent navigation fallbacks", () => {
    const candidate =
      "https://game.example/stream.html?streamRenderProfile=shadows-720p60-v1&streamFps=60#access";
    expect(applyCaptureFrameRateToUrl(candidate, 60)).toBe(candidate);
    expect(
      resolveCaptureRenderProfileForUrls(
        [candidate, candidate.replace("game.example", "fallback.example")],
        60,
      ),
    ).toBe(SHADOWS_CAPTURE_RENDER_PROFILE);
    expect(
      resolveCaptureRenderProfileForUrls([DEFAULT_CAPTURE_GAME_URL], 60),
    ).toBe(CANONICAL_CAPTURE_RENDER_PROFILE);
    expect(() =>
      resolveCaptureRenderProfileForUrls(
        [candidate, DEFAULT_CAPTURE_GAME_URL],
        60,
      ),
    ).toThrow("same render profile");
    expect(() => resolveCaptureRenderProfileForUrls([], 60)).toThrow(
      "at least one",
    );
    expect(() =>
      resolveCaptureRenderProfileForUrls(["invalid-url"], 60),
    ).toThrow("valid game URL");
    expect(() => applyCaptureFrameRateToUrl(candidate, 30)).toThrow(
      "contradicts streamFps=30",
    );
    expect(() =>
      assertCaptureRenderProfileContract({
        profileId: SHADOWS_CAPTURE_RENDER_PROFILE,
        sourceFps: 60,
        outputFps: 60,
        viewportWidth: 1280,
        viewportHeight: 720,
        outputWidth: 1280,
        outputHeight: 720,
      }),
    ).not.toThrow();
  });

  it.each([
    "streamRenderProfile=shadows-720p60-v1&streamRenderProfile=shadows-720p60-v1",
    "streamRenderProfile=canonical-720p60-v1&streamRenderProfile=shadows-720p60-v1",
    "streamRenderProfile=unknown",
    "streamRenderProfile=toString",
    "streamRenderProfile=",
    "streamFps=60&streamFps=60",
    "streamFps=60&streamFps=30",
    "streamFps=30",
    "streamFps=NaN",
    "streamFps=60.0",
    "streamFps=",
  ])("rejects ambiguous/contradictory capture selection: %s", (query) => {
    expect(() =>
      applyCaptureFrameRateToUrl(
        "https://game.example/stream.html?" + query,
        60,
      ),
    ).toThrow();
  });

  it("requires and retains an independently checked applied-state receipt for shadow admission", () => {
    const snapshot = shadowApplicationSnapshot();
    expect(normalizeCaptureRenderProfileSnapshot(snapshot)).toEqual(snapshot);
    expect(
      matchesExpectedCaptureRenderProfile(
        snapshot,
        SHADOWS_CAPTURE_RENDER_PROFILE,
      ),
    ).toBe(true);
    expect(
      normalizeCaptureRenderProfileSnapshot({
        ...snapshot,
        application: undefined,
      }),
    ).toBeNull();
    expect(
      normalizeCaptureRenderProfileSnapshot({ ...snapshot, application: null }),
    ).toBeNull();
    expect(
      normalizeCaptureRenderProfileSnapshot({ id: "toString", explicit: true }),
    ).toBeNull();
    expect(
      shouldAcceptCaptureReadiness({
        snapshot: {
          ready: true,
          degradedReason: null,
          diagnostics: null,
          renderProfile: { ...snapshot, application: undefined },
        },
        expectedRenderProfileId: SHADOWS_CAPTURE_RENDER_PROFILE,
        startedAt: 0,
        nowMs: 1_000_000,
      }),
    ).toBe(false);
  });

  it.each([
    ["schemaVersion", 2],
    ["ready", false],
    ["mismatchReason", "not_ready"],
    ["requested", null],
    ["requested.shadows", "none"],
    ["applied", null],
    ["applied.preferences.bloom", true],
    ["applied.renderer.isWebGPU", false],
    ["applied.renderer.isWebGPU", "true"],
    ["applied.renderer.hasRendered", false],
    ["applied.renderer.samples", 1],
    ["applied.renderer.dpr", 2],
    ["applied.renderer.width", 1920],
    ["applied.renderer.shadowsEnabled", false],
    ["applied.renderer.shadowType", 2],
    ["applied.renderer.composerPresent", true],
    ["applied.sunlight", null],
    ["applied.sunlight.castShadow", false],
    ["applied.sunlight.cascaded", true],
    ["applied.sunlight.mapSize", [2048, 2048]],
    ["applied.sunlight.allocatedMapSize", null],
    ["applied.sunlight.frustum", [-200, 200, 200, -200, 0.5, 500]],
    ["applied.sunlight.frustum", Array(6)],
    ["applied.sunlight.bias", NaN],
    ["applied.sunlight.normalBias", 0.02],
    ["applied.water", null],
    ["applied.water.reflectionsEnabled", true],
    ["applied.water.activeReflectionCount", 1],
  ])(
    "does not trust ready:true with invalid application.%s",
    (field, value) => {
      const snapshot = shadowApplicationSnapshot();
      const keys = String(field).split(".");
      let target: Record<string, unknown> = snapshot.application;
      for (const key of keys.slice(0, -1))
        target = target[key] as Record<string, unknown>;
      target[keys[keys.length - 1]] = value;
      expect(normalizeCaptureRenderProfileSnapshot(snapshot)).toBeNull();
    },
  );

  it("makes both capture entry points derive their expected contract from the validated URL set", () => {
    for (const name of ["capture-browser-host.ts", "stream-to-rtmp.ts"]) {
      const source = readFileSync(
        new URL("../../../scripts/" + name, import.meta.url),
        "utf8",
      );
      expect(source).toContain("resolveCaptureRenderProfileForUrls(");
      expect(source).not.toContain("resolveCaptureRenderProfileId(");
      expect(source).toContain("applyCaptureFrameRateToUrl(");
    }
  });
  it("uses only the canonical stream page when no fallback is explicit", () => {
    expect(resolveCaptureUrlCandidates({})).toEqual([DEFAULT_CAPTURE_GAME_URL]);
    expect(DEFAULT_CAPTURE_GAME_URL.endsWith("/stream.html")).toBe(true);
  });

  it("passes a bounded render rate to the capture page", () => {
    expect(
      applyCaptureFrameRateToUrl(
        "https://game.example/stream.html?existing=1#access",
        60,
      ),
    ).toBe(
      "https://game.example/stream.html?existing=1&streamFps=60&streamRenderProfile=canonical-720p60-v1#access",
    );
    expect(
      applyCaptureFrameRateToUrl("https://game.example/stream.html", 240),
    ).toBe(
      "https://game.example/stream.html?streamFps=60&streamRenderProfile=canonical-720p60-v1",
    );
    expect(
      applyCaptureFrameRateToUrl("https://game.example/stream.html", 30),
    ).toBe(
      "https://game.example/stream.html?streamFps=30&streamRenderProfile=fallback-720p30-v1",
    );
    expect(CANONICAL_CAPTURE_RENDER_PROFILE).toBe("canonical-720p60-v1");
    expect(FALLBACK_CAPTURE_RENDER_PROFILE).toBe("fallback-720p30-v1");
  });

  it("rejects a contradictory explicit capture render profile", () => {
    expect(() =>
      applyCaptureFrameRateToUrl(
        "https://game.example/stream.html?streamRenderProfile=fallback-720p30-v1",
        60,
      ),
    ).toThrow("contradicts streamFps=60");
  });

  it("rejects unversioned capture frame rates", () => {
    expect(() =>
      applyCaptureFrameRateToUrl("https://game.example/stream.html", 45),
    ).toThrow("support only 30 or 60 FPS");
  });

  it("binds viewport, source, and encoded output to the selected profile", () => {
    expect(() =>
      assertCaptureRenderProfileContract({
        profileId: FALLBACK_CAPTURE_RENDER_PROFILE,
        sourceFps: 30,
        outputFps: 30,
        viewportWidth: 1280,
        viewportHeight: 720,
        outputWidth: 1280,
        outputHeight: 720,
      }),
    ).not.toThrow();
    expect(() =>
      assertCaptureRenderProfileContract({
        profileId: FALLBACK_CAPTURE_RENDER_PROFILE,
        sourceFps: 60,
        outputFps: 30,
        viewportWidth: 1280,
        viewportHeight: 720,
        outputWidth: 1280,
        outputHeight: 720,
      }),
    ).toThrow("requires sourceFps=30");
    expect(() =>
      assertCaptureRenderProfileContract({
        profileId: FALLBACK_CAPTURE_RENDER_PROFILE,
        sourceFps: 30,
        outputFps: 30,
        viewportWidth: 1920,
        viewportHeight: 1080,
        outputWidth: 1280,
        outputHeight: 720,
      }),
    ).toThrow("requires viewportWidth=1280");

    const fallbackSnapshot = {
      ...CAPTURE_RENDER_PROFILE_CONTRACTS[FALLBACK_CAPTURE_RENDER_PROFILE],
      explicit: true,
    };
    expect(normalizeCaptureRenderProfileSnapshot(fallbackSnapshot)).toEqual(
      fallbackSnapshot,
    );
    expect(
      normalizeCaptureRenderProfileSnapshot({
        ...fallbackSnapshot,
        antialiasing: false,
      }),
    ).toBeNull();
  });

  it("accepts only explicitly configured capture fallbacks and deduplicates them", () => {
    expect(
      resolveCaptureUrlCandidates({
        primaryUrl: "https://game.example/stream.html",
        fallbackUrls:
          "https://game.example/spectator, https://game.example/stream.html",
      }),
    ).toEqual([
      "https://game.example/stream.html",
      "https://game.example/spectator",
    ]);
  });

  it("accepts only an explicit loopback CDP browser origin", () => {
    expect(resolveCaptureBrowserEndpoint(undefined)).toBeNull();
    expect(resolveCaptureBrowserEndpoint(" http://127.0.0.1:9223 ")).toBe(
      "http://127.0.0.1:9223",
    );
    expect(resolveCaptureBrowserEndpoint("http://localhost:9223")).toBe(
      "http://localhost:9223",
    );
    expect(() =>
      resolveCaptureBrowserEndpoint("https://127.0.0.1:9223"),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      resolveCaptureBrowserEndpoint("http://capture.example:9223"),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      resolveCaptureBrowserEndpoint("http://127.0.0.1:9223/json/version"),
    ).toThrow("loopback HTTP origin");
  });

  it("does not include disable-web-security in the default launch args", () => {
    const args = buildDefaultCaptureLaunchArgs({
      angleBackend: "metal",
      featureFlags: "--enable-features=Vulkan,UseSkiaRenderer,WebGPU",
    });

    expect(args).not.toContain("--disable-web-security");
    expect(args).not.toContain("--no-sandbox");
  });

  it("selects capture features without mixing Vulkan into ANGLE/Metal", () => {
    expect(resolveDefaultCaptureFeatureFlags("darwin")).toBe(
      "--enable-features=UseSkiaRenderer,WebGPU",
    );
    expect(resolveDefaultCaptureFeatureFlags("linux")).toBe(
      "--enable-features=Vulkan,UseSkiaRenderer,WebGPU",
    );
    expect(resolveDefaultCaptureFeatureFlags("win32")).toBe(
      "--enable-features=UseSkiaRenderer,WebGPU",
    );

    const macArgs = buildDefaultCaptureLaunchArgs({
      angleBackend: "metal",
      featureFlags: resolveDefaultCaptureFeatureFlags("darwin"),
    });
    expect(macArgs).toContain("--use-angle=metal");
    expect(macArgs).toContain("--enable-features=UseSkiaRenderer,WebGPU");
    expect(macArgs.join(" ")).not.toContain("Vulkan");
  });

  it("retains the host display clock used for representative frame pacing", () => {
    const args = buildDefaultCaptureLaunchArgs({
      angleBackend: "metal",
      featureFlags: "--enable-features=Vulkan,UseSkiaRenderer,WebGPU",
    });

    expect(args).not.toContain("--disable-frame-rate-limit");
    expect(args).not.toContain("--disable-gpu-vsync");
  });

  it("only includes no-sandbox when capture sandboxing is explicitly disabled", () => {
    const args = buildDefaultCaptureLaunchArgs({
      angleBackend: "metal",
      featureFlags: "--enable-features=Vulkan,UseSkiaRenderer,WebGPU",
      disableSandbox: true,
    });

    expect(args).toContain("--no-sandbox");
  });

  it("derives one allowed origin per configured game URL", () => {
    expect(
      resolveAllowedCaptureOrigins([
        "https://game.example.com/stream",
        "https://game.example.com/alt",
        "http://fallback.example.com/",
      ]),
    ).toEqual(["https://game.example.com", "http://fallback.example.com"]);
  });

  it("rejects navigation outside the configured origin set", () => {
    const allowedOrigins = ["https://game.example.com"];

    expect(
      resolveUnexpectedCaptureOrigin(
        "https://game.example.com/stream",
        allowedOrigins,
      ),
    ).toBeNull();
    expect(
      resolveUnexpectedCaptureOrigin(
        "https://evil.example.com/stream",
        allowedOrigins,
      ),
    ).toBe("https://evil.example.com");
  });

  it("accepts renderer readiness decisions through one shared helper", () => {
    expect(
      shouldAcceptCaptureReadiness({
        snapshot: {
          ready: true,
          degradedReason: null,
          diagnostics: null,
        },
        startedAt: 0,
        nowMs: 1_000,
      }),
    ).toBe(true);

    expect(
      shouldAcceptCaptureReadiness({
        snapshot: {
          ready: false,
          degradedReason: "loading_overlay_active",
          diagnostics: {
            hasCanvas: true,
            hasStreamingBootUi: true,
            hasCriticalErrorUi: false,
            readyFlag: false,
          },
        },
        startedAt: 0,
        nowMs: 30_000,
      }),
    ).toBe(false);

    expect(
      shouldAcceptCaptureReadiness({
        snapshot: {
          ready: false,
          degradedReason: "loading_overlay_active",
          diagnostics: {
            hasCanvas: true,
            hasStreamingBootUi: true,
            hasCriticalErrorUi: false,
            readyFlag: false,
          },
        },
        startedAt: 0,
        nowMs: 180_000,
      }),
    ).toBe(true);

    expect(
      shouldAcceptCaptureReadiness({
        snapshot: {
          ready: false,
          degradedReason: "initialization_failed",
          diagnostics: {
            hasCanvas: false,
            hasStreamingBootUi: false,
            hasCriticalErrorUi: true,
            readyFlag: false,
          },
        },
        startedAt: 0,
        nowMs: 180_000,
      }),
    ).toBe(false);
  });

  it("withholds readiness until the page proves the exact explicit render profile", () => {
    const readySnapshot = {
      ready: true,
      degradedReason: null,
      diagnostics: null,
    };
    expect(
      shouldAcceptCaptureReadiness({
        snapshot: readySnapshot,
        startedAt: 0,
        nowMs: 1_000,
        expectedRenderProfileId: CANONICAL_CAPTURE_RENDER_PROFILE,
      }),
    ).toBe(false);
    expect(
      shouldAcceptCaptureReadiness({
        snapshot: {
          ...readySnapshot,
          renderProfile: {
            ...CAPTURE_RENDER_PROFILE_CONTRACTS[
              FALLBACK_CAPTURE_RENDER_PROFILE
            ],
            explicit: true,
          },
        },
        startedAt: 0,
        nowMs: 1_000,
        expectedRenderProfileId: CANONICAL_CAPTURE_RENDER_PROFILE,
      }),
    ).toBe(false);
    expect(
      shouldAcceptCaptureReadiness({
        snapshot: {
          ...readySnapshot,
          renderProfile: {
            ...CAPTURE_RENDER_PROFILE_CONTRACTS[
              CANONICAL_CAPTURE_RENDER_PROFILE
            ],
            explicit: true,
          },
        },
        startedAt: 0,
        nowMs: 1_000,
        expectedRenderProfileId: CANONICAL_CAPTURE_RENDER_PROFILE,
      }),
    ).toBe(true);
    expect(
      matchesExpectedCaptureRenderProfile(
        {
          ...CAPTURE_RENDER_PROFILE_CONTRACTS[CANONICAL_CAPTURE_RENDER_PROFILE],
          targetFps: 30,
          explicit: true,
        },
        CANONICAL_CAPTURE_RENDER_PROFILE,
      ),
    ).toBe(false);
  });
});
