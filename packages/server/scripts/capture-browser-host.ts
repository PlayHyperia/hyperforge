#!/usr/bin/env bun
/**
 * Long-lived browser host for the duel broadcast renderer.
 *
 * The RTMP/encoder worker connects over loopback CDP. Keeping Chromium in a
 * separately supervised process lets an encoder or bridge crash reuse the
 * already-warm WebGPU scene instead of repeating avatar, terrain, shader, and
 * GPU-stability startup work. If this host itself fails, its supervisor still
 * provides the existing cold-start fallback.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

import {
  applyCaptureFrameRateToUrl,
  assertCaptureRenderProfileContract,
  buildDefaultCaptureLaunchArgs,
  matchesExpectedCaptureRenderProfile,
  normalizeCaptureRenderProfileSnapshot,
  resolveAllowedCaptureOrigins,
  resolveCaptureRenderProfileForUrls,
  resolveCaptureUrlCandidates,
  resolveDefaultCaptureFeatureFlags,
  resolveUnexpectedCaptureOrigin,
  type CaptureRenderProfileSnapshot,
} from "../src/streaming/captureBrowserPolicy.js";
import {
  parseCaptureFrameRate,
  resolveCaptureSourceFrameRate,
} from "../src/streaming/capture-frame-pacer.js";
import {
  CAPTURE_BROWSER_FRAME_REQUEST_SCHEMA_VERSION,
  isCaptureBrowserFrameReadinessQualified,
  parseCaptureBrowserFrameRequest,
  resolveCaptureBrowserFrameIpcConfig,
  type CaptureBrowserFrameRequest,
} from "../src/streaming/capture-browser-frame-request.js";
import {
  normalizeCaptureSceneReadinessDiagnostics,
  type CaptureSceneReadinessDiagnostics,
} from "../src/streaming/capture-scene-readiness.js";
import { errMsg } from "../src/shared/errMsg.ts";
import { redactStreamingSecretsFromUrl } from "../src/streaming/redactStreamingUrl.js";

function requiredPort(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      "STREAM_CAPTURE_BROWSER_DEBUG_PORT must be an integer from 1 to 65535",
    );
  }
  return parsed;
}

function evenDimension(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  const value = Number.isFinite(parsed) ? Math.max(2, parsed) : fallback;
  return value % 2 === 0 ? value : value - 1;
}

const debugPort = requiredPort(process.env.STREAM_CAPTURE_BROWSER_DEBUG_PORT);
const endpoint = `http://127.0.0.1:${debugPort}`;
const statusFile = (
  process.env.STREAM_CAPTURE_BROWSER_STATUS_FILE || ""
).trim();
const viewport = {
  width: evenDimension(process.env.STREAM_CAPTURE_WIDTH, 1280),
  height: evenDimension(process.env.STREAM_CAPTURE_HEIGHT, 720),
};
const headless = process.env.STREAM_CAPTURE_HEADLESS === "true";
const angleBackend =
  process.env.STREAM_CAPTURE_ANGLE?.trim() ||
  (process.platform === "darwin" ? "metal" : "vulkan");
const requestedChannel = process.env.STREAM_CAPTURE_CHANNEL?.trim() || "";
const channel = requestedChannel === "bundled" ? "" : requestedChannel;
const disableSandbox = /^(1|true|yes|on)$/i.test(
  process.env.CAPTURE_DISABLE_SANDBOX || "",
);
const featureFlags =
  process.env.STREAM_CAPTURE_FEATURE_FLAGS?.trim() ||
  resolveDefaultCaptureFeatureFlags(process.platform);
const outputFps = parseCaptureFrameRate(process.env.STREAM_FPS);
const sourceTargetFps = resolveCaptureSourceFrameRate(
  outputFps,
  process.env.STREAM_CAPTURE_SOURCE_FPS,
);
const configuredCaptureUrls = resolveCaptureUrlCandidates({
  primaryUrl: process.env.GAME_URL,
  fallbackUrls: process.env.GAME_FALLBACK_URLS,
});
const expectedRenderProfileId = resolveCaptureRenderProfileForUrls(
  configuredCaptureUrls,
  sourceTargetFps,
);
const outputViewport = {
  width: evenDimension(process.env.STREAM_OUTPUT_WIDTH, viewport.width),
  height: evenDimension(process.env.STREAM_OUTPUT_HEIGHT, viewport.height),
};
assertCaptureRenderProfileContract({
  profileId: expectedRenderProfileId,
  sourceFps: sourceTargetFps,
  outputFps,
  viewportWidth: viewport.width,
  viewportHeight: viewport.height,
  outputWidth: outputViewport.width,
  outputHeight: outputViewport.height,
});
const viewerAccessToken = (
  process.env.STREAMING_VIEWER_ACCESS_TOKEN || ""
).trim();
const frameCaptureIpc = resolveCaptureBrowserFrameIpcConfig(process.env);
if (frameCaptureIpc) {
  const outputDirectoryStats = fs.statSync(frameCaptureIpc.outputDirectory);
  if (!outputDirectoryStats.isDirectory()) {
    throw new Error(
      "STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY must be an existing directory",
    );
  }
}

function withViewerAccessToken(rawUrl: string): string {
  if (!viewerAccessToken) return rawUrl;
  const url = new URL(rawUrl);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  hashParams.set("streamToken", viewerAccessToken);
  url.hash = hashParams.toString();
  return url.toString();
}

const captureUrls = configuredCaptureUrls.map((url) =>
  withViewerAccessToken(applyCaptureFrameRateToUrl(url, sourceTargetFps)),
);
const allowedOrigins = resolveAllowedCaptureOrigins(captureUrls);
const startedAt = Date.now();

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let shuttingDown = false;
let healthMonitor: ReturnType<typeof setInterval> | null = null;
let healthMonitorInFlight = false;
let frameCaptureMonitor: ReturnType<typeof setInterval> | null = null;
let frameCaptureInFlight = false;
let lastFrameCaptureRequest = "";

function writeStatus(
  stage: string,
  rendererHealth: Record<string, unknown> | null = null,
): void {
  if (!statusFile) return;
  const payload = JSON.stringify({
    source: "capture-browser-host",
    processId: process.pid,
    startedAt,
    stage,
    rendererHealth,
    updatedAt: Date.now(),
  });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, statusFile);
  } catch (error) {
    console.warn("[CaptureBrowserHost] Status write failed:", errMsg(error));
  }
}

function writeFrameCaptureStatus(payload: Record<string, unknown>): void {
  if (!frameCaptureIpc) return;
  const statusPayload = JSON.stringify({
    source: "capture-browser-host",
    schemaVersion: CAPTURE_BROWSER_FRAME_REQUEST_SCHEMA_VERSION,
    ...payload,
  });
  const temporary = `${frameCaptureIpc.statusFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(frameCaptureIpc.statusFile), { recursive: true });
    fs.writeFileSync(temporary, statusPayload, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, frameCaptureIpc.statusFile);
    fs.chmodSync(frameCaptureIpc.statusFile, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary status file may not have been created.
    }
    console.warn(
      "[CaptureBrowserHost] Frame status write failed:",
      errMsg(error),
    );
  }
}

async function readFrameCaptureReadiness(
  pageRef: Page,
): Promise<CaptureSceneReadinessDiagnostics | null> {
  const rawReadiness = await pageRef.evaluate(() => {
    const readiness = (
      window as unknown as {
        __HYPERIA_STREAM_SCENE_READINESS__?: unknown;
      }
    ).__HYPERIA_STREAM_SCENE_READINESS__;
    return readiness && typeof readiness === "object" ? readiness : null;
  });
  return normalizeCaptureSceneReadinessDiagnostics(rawReadiness);
}

async function waitForStableFrameCaptureReadiness(
  pageRef: Page,
  request: CaptureBrowserFrameRequest,
): Promise<CaptureSceneReadinessDiagnostics> {
  const deadline = Date.now() + 2_000;
  let consecutiveQualifiedSamples = 0;
  let lastReadiness: CaptureSceneReadinessDiagnostics | null = null;
  while (Date.now() < deadline) {
    lastReadiness = await readFrameCaptureReadiness(pageRef);
    if (
      isCaptureBrowserFrameReadinessQualified(
        lastReadiness,
        request.expectedCameraTargetSlot,
        request.expectedPairShot,
      )
    ) {
      consecutiveQualifiedSamples++;
      if (consecutiveQualifiedSamples >= 3) return lastReadiness;
    } else {
      consecutiveQualifiedSamples = 0;
    }
    await pageRef.waitForTimeout(75);
  }
  throw new Error(
    `Capture-browser frame composition did not remain qualified (${JSON.stringify(lastReadiness)})`,
  );
}

async function serviceFrameCaptureRequest(): Promise<void> {
  if (
    !frameCaptureIpc ||
    frameCaptureInFlight ||
    shuttingDown ||
    !page ||
    page.isClosed()
  ) {
    return;
  }

  let rawRequest: string;
  try {
    rawRequest = fs.readFileSync(frameCaptureIpc.requestFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(
      "[CaptureBrowserHost] Frame request read failed:",
      errMsg(error),
    );
    return;
  }
  if (rawRequest === lastFrameCaptureRequest) return;
  lastFrameCaptureRequest = rawRequest;
  frameCaptureInFlight = true;

  let requestId: string | null = null;
  let outputPath: string | null = null;
  let outputCreated = false;
  try {
    const request = parseCaptureBrowserFrameRequest(rawRequest, {
      nowMs: Date.now(),
      outputDirectory: frameCaptureIpc.outputDirectory,
    });
    requestId = request.requestId;
    outputPath = request.outputPath;
    const unexpectedOrigin = resolveUnexpectedCaptureOrigin(
      page.url(),
      allowedOrigins,
    );
    if (unexpectedOrigin) {
      throw new Error(
        `Capture-browser frame request observed unexpected origin ${unexpectedOrigin}`,
      );
    }
    const viewportSize = page.viewportSize();
    if (
      !viewportSize ||
      !Number.isSafeInteger(viewportSize.width) ||
      viewportSize.width < 1 ||
      !Number.isSafeInteger(viewportSize.height) ||
      viewportSize.height < 1
    ) {
      throw new Error("Capture-browser frame page has no valid viewport");
    }
    await waitForStableFrameCaptureReadiness(page, request);
    const screenshot = await page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
    const postCaptureReadiness = await readFrameCaptureReadiness(page);
    if (
      !isCaptureBrowserFrameReadinessQualified(
        postCaptureReadiness,
        request.expectedCameraTargetSlot,
        request.expectedPairShot,
      )
    ) {
      throw new Error(
        "Capture-browser frame composition changed while pixels were captured",
      );
    }
    fs.writeFileSync(outputPath, screenshot, { flag: "wx", mode: 0o600 });
    outputCreated = true;
    fs.chmodSync(outputPath, 0o600);
    const sha256 = createHash("sha256").update(screenshot).digest("hex");
    writeFrameCaptureStatus({
      requestId,
      state: "completed",
      requestedAtMs: request.requestedAtMs,
      outputFilename: request.outputFilename,
      width: viewportSize.width,
      height: viewportSize.height,
      cameraTargetSlot: request.expectedCameraTargetSlot,
      preparationPairShotActive: request.expectedPairShot,
      sha256,
      capturedAtMs: Date.now(),
    });
  } catch (error) {
    if (outputCreated && outputPath) {
      try {
        fs.unlinkSync(outputPath);
      } catch (cleanupError) {
        console.warn(
          "[CaptureBrowserHost] Failed-frame cleanup failed:",
          errMsg(cleanupError),
        );
      }
    }
    const reason = errMsg(error).slice(0, 500);
    writeFrameCaptureStatus({
      requestId,
      state: "failed",
      reason,
      failedAtMs: Date.now(),
    });
    console.warn(`[CaptureBrowserHost] Frame request failed: ${reason}`);
  } finally {
    frameCaptureInFlight = false;
  }
}

function installRepaintTicker(): void {
  const win = window as unknown as {
    __HYPERIA_REPAINT_TICKER__?: boolean;
  };
  if (win.__HYPERIA_REPAINT_TICKER__) return;
  win.__HYPERIA_REPAINT_TICKER__ = true;
  const ticker = document.createElement("div");
  ticker.id = "__hyperia-repaint-ticker";
  Object.assign(ticker.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "2px",
    height: "2px",
    opacity: "0.015",
    backgroundColor: "#000000",
    mixBlendMode: "difference",
    zIndex: "2147483647",
    pointerEvents: "none",
    willChange: "transform,opacity,background-color",
  });
  const attach = () => {
    const root = document.body || document.documentElement;
    if (root && !root.contains(ticker)) root.appendChild(ticker);
  };
  attach();
  let phase = 0;
  const tick = () => {
    phase = (phase + 1) & 3;
    ticker.style.transform =
      phase & 1 ? "translate3d(0.5px,0.5px,0)" : "translate3d(0,0,0)";
    ticker.style.backgroundColor = phase >= 2 ? "#010101" : "#000000";
    ticker.style.opacity = phase & 1 ? "0.02" : "0.015";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.addEventListener("DOMContentLoaded", attach, { once: true });
}

type HostRendererHealth = {
  ready: boolean;
  degradedReason: string | null;
  updatedAt: number;
  phase: string | null;
  bootStatus: string | null;
  renderProfile: CaptureRenderProfileSnapshot | null;
};

async function readRendererHealth(pageRef: Page): Promise<HostRendererHealth> {
  const snapshot = await pageRef.evaluate(() => {
    const win = window as unknown as {
      __HYPERIA_STREAM_RENDERER_HEALTH__?: {
        ready?: boolean;
        degradedReason?: string | null;
        updatedAt?: number;
        phase?: string | null;
      } | null;
      __HYPERIA_STREAM_BOOT_STATUS__?: string | null;
      __HYPERIA_STREAM_RENDER_PROFILE__?: unknown;
    };
    const health = win.__HYPERIA_STREAM_RENDERER_HEALTH__;
    return {
      ready: health?.ready === true,
      degradedReason:
        typeof health?.degradedReason === "string"
          ? health.degradedReason
          : null,
      updatedAt:
        typeof health?.updatedAt === "number" &&
        Number.isFinite(health.updatedAt)
          ? health.updatedAt
          : Date.now(),
      phase: typeof health?.phase === "string" ? health.phase : null,
      bootStatus:
        typeof win.__HYPERIA_STREAM_BOOT_STATUS__ === "string"
          ? win.__HYPERIA_STREAM_BOOT_STATUS__
          : null,
      renderProfile: win.__HYPERIA_STREAM_RENDER_PROFILE__ ?? null,
    };
  });
  return {
    ...snapshot,
    renderProfile: normalizeCaptureRenderProfileSnapshot(
      snapshot.renderProfile,
    ),
  };
}

async function waitForRendererReady(
  pageRef: Page,
  timeoutMs = 120_000,
): Promise<HostRendererHealth> {
  const deadline = Date.now() + timeoutMs;
  let lastHealth: HostRendererHealth | null = null;
  let lastStatusKey = "";
  while (Date.now() < deadline) {
    lastHealth = await readRendererHealth(pageRef);
    const statusKey = JSON.stringify(lastHealth);
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey;
      writeStatus("renderer_waiting", lastHealth);
    }
    const renderProfileReady = matchesExpectedCaptureRenderProfile(
      lastHealth.renderProfile,
      expectedRenderProfileId,
    );
    if (
      lastHealth.ready &&
      lastHealth.degradedReason === null &&
      renderProfileReady
    ) {
      return lastHealth;
    }
    if (lastHealth.bootStatus?.startsWith("error:")) {
      throw new Error(
        `Capture renderer reported a critical boot error (${lastHealth.bootStatus})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Capture renderer was not ready within ${timeoutMs}ms (last=${JSON.stringify(lastHealth)})`,
  );
}

async function navigateRenderer(pageRef: Page): Promise<HostRendererHealth> {
  for (const candidateUrl of captureUrls) {
    writeStatus("page_loading");
    const redactedUrl = redactStreamingSecretsFromUrl(candidateUrl);
    console.log(`[CaptureBrowserHost] Navigating to ${redactedUrl}...`);
    try {
      await pageRef.goto(candidateUrl, {
        timeout: 120_000,
        waitUntil: "domcontentloaded",
      });
      const unexpectedOrigin = resolveUnexpectedCaptureOrigin(
        pageRef.url(),
        allowedOrigins,
      );
      if (unexpectedOrigin) {
        throw new Error(`unexpected origin ${unexpectedOrigin}`);
      }
      return await waitForRendererReady(pageRef);
    } catch (error) {
      if (shuttingDown || pageRef.isClosed()) {
        throw error;
      }
      console.warn(
        `[CaptureBrowserHost] Candidate failed ${redactedUrl}:`,
        errMsg(error),
      );
    }
  }
  throw new Error(
    "No configured capture page reached strict renderer readiness",
  );
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (healthMonitor) {
    clearInterval(healthMonitor);
    healthMonitor = null;
  }
  if (frameCaptureMonitor) {
    clearInterval(frameCaptureMonitor);
    frameCaptureMonitor = null;
  }
  try {
    await browser?.close();
  } catch (error) {
    console.warn("[CaptureBrowserHost] Browser close failed:", errMsg(error));
  } finally {
    context = null;
    browser = null;
    process.exit(exitCode);
  }
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGHUP", () => void shutdown(0));

async function main(): Promise<void> {
  writeStatus("process_starting");
  if (disableSandbox) {
    console.warn(
      "[CaptureBrowserHost] CAPTURE_DISABLE_SANDBOX=true: Chromium sandboxing is disabled.",
    );
  }
  browser = await chromium.launch({
    headless,
    ...(channel ? { channel } : {}),
    args: [
      ...buildDefaultCaptureLaunchArgs({
        angleBackend,
        featureFlags,
        disableSandbox,
      }),
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
    ],
  });
  browser.on("disconnected", () => {
    if (shuttingDown) return;
    writeStatus("browser_disconnected");
    console.error("[CaptureBrowserHost] Chromium disconnected unexpectedly");
    void shutdown(1);
  });
  context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  page = await context.newPage();
  await page.addInitScript(installRepaintTicker);
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error("[CaptureBrowserHost:Page]", message.text());
    } else if (message.text().includes("[StreamingMode]")) {
      console.log("[CaptureBrowserHost:Page]", message.text());
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page?.mainFrame()) return;
    const navigatedUrl = frame.url();
    if (!navigatedUrl || navigatedUrl === "about:blank") return;
    const unexpectedOrigin = resolveUnexpectedCaptureOrigin(
      navigatedUrl,
      allowedOrigins,
    );
    if (!unexpectedOrigin) return;
    console.error(
      `[CaptureBrowserHost] Refusing unexpected navigation origin ${unexpectedOrigin}`,
    );
    void shutdown(1);
  });
  page.on("crash", () => {
    if (shuttingDown) return;
    writeStatus("page_crashed");
    console.error("[CaptureBrowserHost] Capture page crashed");
    void shutdown(1);
  });
  page.on("close", () => {
    if (shuttingDown) return;
    writeStatus("page_closed");
    console.error("[CaptureBrowserHost] Capture page closed unexpectedly");
    void shutdown(1);
  });

  console.log(
    `[CaptureBrowserHost] ready at ${endpoint} (pid=${process.pid}, viewport=${viewport.width}x${viewport.height})`,
  );
  const rendererHealth = await navigateRenderer(page);
  writeStatus("ready", rendererHealth);
  console.log(
    `[CaptureBrowserHost] strict renderer readiness reached at ${redactStreamingSecretsFromUrl(page.url())}`,
  );
  if (frameCaptureIpc) {
    frameCaptureMonitor = setInterval(() => {
      void serviceFrameCaptureRequest();
    }, 100);
  }
  healthMonitor = setInterval(() => {
    if (shuttingDown || healthMonitorInFlight || !page || page.isClosed()) {
      return;
    }
    healthMonitorInFlight = true;
    void readRendererHealth(page)
      .then((currentHealth) => {
        const renderProfileHealthy = matchesExpectedCaptureRenderProfile(
          currentHealth.renderProfile,
          expectedRenderProfileId,
        );
        writeStatus(
          currentHealth.ready &&
            currentHealth.degradedReason === null &&
            renderProfileHealthy
            ? "ready"
            : "renderer_degraded",
          currentHealth,
        );
      })
      .catch((error) => {
        if (!shuttingDown) {
          writeStatus("renderer_unavailable");
          console.warn(
            "[CaptureBrowserHost] Renderer health probe failed:",
            errMsg(error),
          );
        }
      })
      .finally(() => {
        healthMonitorInFlight = false;
      });
  }, 2_000);
  await new Promise(() => {});
}

main().catch((error) => {
  if (shuttingDown) return;
  console.error("[CaptureBrowserHost] Fatal error:", errMsg(error));
  void shutdown(1);
});
