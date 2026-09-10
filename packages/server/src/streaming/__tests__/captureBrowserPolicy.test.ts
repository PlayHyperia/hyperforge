import { describe, expect, it } from "vitest";
import {
  applyCaptureFrameRateToUrl,
  assertCaptureRenderProfileContract,
  buildDefaultCaptureLaunchArgs,
  CANONICAL_CAPTURE_RENDER_PROFILE,
  CAPTURE_RENDER_PROFILE_CONTRACTS,
  DEFAULT_CAPTURE_GAME_URL,
  FALLBACK_CAPTURE_RENDER_PROFILE,
  matchesExpectedCaptureRenderProfile,
  normalizeCaptureRenderProfileSnapshot,
  resolveAllowedCaptureOrigins,
  resolveCaptureBrowserEndpoint,
  resolveDefaultCaptureFeatureFlags,
  resolveCaptureUrlCandidates,
  resolveUnexpectedCaptureOrigin,
  shouldAcceptCaptureReadiness,
} from "../captureBrowserPolicy";

describe("captureBrowserPolicy", () => {
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
