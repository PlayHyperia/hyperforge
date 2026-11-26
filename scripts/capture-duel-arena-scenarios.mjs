#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  applyCaptureFrameRateToUrl,
  buildDefaultCaptureLaunchArgs,
} from "../packages/server/src/streaming/captureBrowserPolicy.ts";
import {
  advanceDuelTerminalHandoff,
  attachStreamingViewerToken,
  captureScenarioIdentity,
  classifyDuelCaptureScenarios,
  createDuelTerminalHandoff,
  duelCaptureStatesAgree,
  evaluateDuelPresentationCapture,
  evaluateDuelSafeCrop,
  evaluateDuelSceneCapture,
  normalizeDuelCaptureState,
  parseDuelSafeCrop,
  REQUIRED_DUEL_CAPTURE_SCENARIOS,
} from "./duel-capture-scenarios.mjs";

const parsed = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "stream-url": {
      type: "string",
      default: "http://localhost:3333/stream.html",
    },
    "state-url": {
      type: "string",
      default: "http://localhost:5555/api/streaming/state",
    },
    "output-dir": {
      type: "string",
      default: "artifacts/duel-arena-capture",
    },
    "duration-s": { type: "string", default: "900" },
    "poll-ms": { type: "string", default: "250" },
    "settle-ms": { type: "string", default: "750" },
    "network-latency-ms": { type: "string", default: "0" },
    "cpu-throttle-rate": { type: "string", default: "1" },
    viewport: { type: "string", default: "1920x1080" },
    "safe-ndc-x": { type: "string" },
    "safe-ndc-y": { type: "string" },
    scenarios: {
      type: "string",
      default: REQUIRED_DUEL_CAPTURE_SCENARIOS.join(","),
    },
    headed: { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
  },
  strict: true,
}).values;

if (parsed.help) {
  console.log(`
Authoritative duel-arena visual capture gate.

Usage:
  bun scripts/capture-duel-arena-scenarios.mjs [options]

Options:
  --stream-url <url>   Canonical stream page (default: http://localhost:3333/stream.html)
  --state-url <url>    Canonical public state API (default: http://localhost:5555/api/streaming/state)
  --output-dir <path>  Screenshot/manifest directory (default: artifacts/duel-arena-capture)
  --duration-s <n>     Maximum capture window (default: 900)
  --poll-ms <n>        State sampling interval (default: 250)
  --settle-ms <n>      Required unchanged state before capture (default: 750)
  --network-latency-ms <n> Browser transport latency in milliseconds (0-2000)
  --cpu-throttle-rate <n> Browser CPU slowdown multiplier (1-20)
  --viewport <WxH>     Capture viewport (default: 1920x1080)
  --safe-ndc-x <n>     Optional maximum absolute fighter projection X (0,1]
  --safe-ndc-y <n>     Optional maximum absolute fighter projection Y (0,1]
  --scenarios <list>   Comma-separated required scenario IDs
  --headed             Show Chromium while capturing
  --verbose, -v        Print bounded renderer/scene progress every 5 seconds

Required scenario IDs:
  ${REQUIRED_DUEL_CAPTURE_SCENARIOS.join(", ")}

The gate is read-only. It requires browser/server state agreement, renderer
readiness, visible and separated in-ring avatars, synchronized simulation and
render transforms, settled opponent-facing combat rotation, in-frame projection
and any explicitly declared stream-safe crop,
the expected camera target and aspect,
stable state before and after each screenshot, zero console errors, zero failed
browser requests or HTTP error responses, a fresh service-worker-free 60 FPS
production artifact under the exact requested browser conditions,
phase-correct DOM presentation, and
for every captured terminal scenario a clean handoff through the next announced
cycle's live fight. It writes a hashed mode-0600
JSON evidence manifest. STREAMING_CAPTURE_VIEWER_TOKEN may provide the gated
viewer token and STREAMING_CAPTURE_STATE_TOKEN may provide a Bearer token to
the state endpoint; neither value is written to evidence. On macOS the gate
defaults to the installed Chrome channel with Metal/WebGPU; override with
STREAMING_CAPTURE_BROWSER_CHANNEL or STREAMING_CAPTURE_ANGLE when needed.
`);
  process.exit(0);
}

function parseBoundedInteger(value, fallback, minimum, maximum, label) {
  const parsedValue = Number.parseInt(String(value ?? ""), 10);
  const normalized = Number.isSafeInteger(parsedValue) ? parsedValue : fallback;
  if (normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function parseViewport(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(String(value ?? "").trim());
  if (!match) throw new TypeError("viewport must use WIDTHxHEIGHT format");
  return {
    width: parseBoundedInteger(match[1], 0, 320, 7680, "viewport width"),
    height: parseBoundedInteger(match[2], 0, 320, 4320, "viewport height"),
  };
}

function parseBoundedNumber(value, fallback, minimum, maximum, label) {
  const parsedValue = Number(value);
  const normalized = Number.isFinite(parsedValue) ? parsedValue : fallback;
  if (normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function parseHttpUrl(value, label) {
  const url = new URL(String(value ?? ""));
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new TypeError(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password || url.hash) {
    throw new TypeError(`${label} cannot contain credentials or a fragment`);
  }
  return url;
}

function publicUrl(url) {
  const copy = new URL(url);
  copy.search = "";
  copy.hash = "";
  return copy.toString();
}

function assertByteCompleteLaunchAssets() {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const validatorPath = path.join(
    workspaceRoot,
    "scripts/validate-duel-launch-assets.mjs",
  );
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: workspaceRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(
      "duel launch asset preflight exceeded its 120000ms process deadline",
    );
  }
  if (result.error) {
    throw new Error(
      `duel launch asset preflight failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `duel launch asset preflight rejected capture${detail ? `: ${detail}` : ""}`,
    );
  }
  const summary = String(result.stdout || "").trim();
  if (summary) console.log(`[duel-capture] ${summary}`);
}

function requestedScenarios(value) {
  const requested = [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length === 0)
    throw new TypeError("at least one scenario required");
  for (const scenario of requested) {
    if (!REQUIRED_DUEL_CAPTURE_SCENARIOS.includes(scenario)) {
      throw new TypeError(`unknown capture scenario: ${scenario}`);
    }
  }
  return requested;
}

function boundedMessage(value, maxLength = 500) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized
    .replace(/(?:https?|wss?):\/\/[^\s)'"<>]+/gi, (match) => {
      try {
        return publicUrl(new URL(match));
      } catch {
        return "redacted-url";
      }
    })
    .slice(0, maxLength);
}

function redactRequestUrl(value) {
  try {
    return publicUrl(new URL(value));
  } catch {
    return "invalid-url";
  }
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function fetchState(stateUrl, bearerToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(stateUrl, {
      cache: "no-store",
      headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`state HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function readBrowserProbe(page) {
  return page.evaluate(() => {
    const runtimeWindow = window;
    const documentElement = document.documentElement;
    const body = document.body;
    return {
      state: runtimeWindow.__HYPERIA_STREAM_STATE__ ?? null,
      rendererHealth: runtimeWindow.__HYPERIA_STREAM_RENDERER_HEALTH__ ?? null,
      performance: runtimeWindow.__HYPERIA_STREAM_PERFORMANCE__ ?? null,
      sceneDiagnostics:
        runtimeWindow.__HYPERIA_STREAM_SCENE_DIAGNOSTICS__ ?? null,
      presentationDiagnostics: {
        schemaVersion: 1,
        rootCount: document.querySelectorAll(".streaming-overlay-root").length,
        bodyTextLength: body?.innerText?.trim().length ?? 0,
        errorOverlayCount: document.querySelectorAll(
          "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
        ).length,
        victoryOverlayCount: document.querySelectorAll(
          ".streaming-victory-overlay",
        ).length,
        postFightCardCount: document.querySelectorAll(
          ".streaming-post-fight-position",
        ).length,
        countdownOverlayCount:
          document.querySelectorAll(".countdown-pulse").length,
        combatLogCount: document.querySelectorAll(".streaming-combat-log")
          .length,
        leaderboardCount: document.querySelectorAll(
          ".streaming-leaderboard-mount",
        ).length,
        betweenStripCount: document.querySelectorAll(".streaming-between-strip")
          .length,
        activeHudCount: document.querySelectorAll(".streaming-duel-info")
          .length,
        agentStatsCount: document.querySelectorAll(".streaming-agent-stats")
          .length,
        cancellationStatusCount: document.querySelectorAll(
          '.streaming-interstitial[role="status"]',
        ).length,
        healPopupCount: document.querySelectorAll('[style*="heal-float-up"]')
          .length,
      },
      layout: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: Math.max(
          documentElement.scrollWidth,
          body?.scrollWidth ?? 0,
        ),
        scrollHeight: Math.max(
          documentElement.scrollHeight,
          body?.scrollHeight ?? 0,
        ),
        canvasCount: document.querySelectorAll("canvas").length,
      },
    };
  });
}

function stableIdentityKey(state, scenario) {
  const identity = captureScenarioIdentity(state, scenario);
  return identity ? JSON.stringify(identity) : null;
}

function summarizeCaptureState(state) {
  const normalized = normalizeDuelCaptureState(state);
  if (!normalized) return null;
  return {
    cycleId: normalized.cycleId,
    phase: normalized.phase,
    phaseVersion: normalized.phaseVersion,
    agent1: normalized.agent1
      ? { id: normalized.agent1.id, hp: normalized.agent1.hp }
      : null,
    agent2: normalized.agent2
      ? { id: normalized.agent2.id, hp: normalized.agent2.hp }
      : null,
    arenaPositions: normalized.arenaPositions,
    cameraTarget: normalized.cameraTarget,
    outcome: normalized.outcome,
    winnerId: normalized.winnerId,
    terminalNotice: normalized.terminalNotice,
  };
}

const streamUrl = parseHttpUrl(
  applyCaptureFrameRateToUrl(parsed["stream-url"], 60),
  "stream-url",
);
const viewerToken = String(
  process.env.STREAMING_CAPTURE_VIEWER_TOKEN ?? "",
).trim();
const streamNavigationUrl = attachStreamingViewerToken(streamUrl, viewerToken);
const stateUrl = parseHttpUrl(parsed["state-url"], "state-url");
const viewport = parseViewport(parsed.viewport);
const safeCrop = parseDuelSafeCrop(parsed["safe-ndc-x"], parsed["safe-ndc-y"]);
const durationMs =
  parseBoundedInteger(parsed["duration-s"], 900, 10, 86_400, "duration-s") *
  1_000;
const pollMs = parseBoundedInteger(
  parsed["poll-ms"],
  250,
  100,
  5_000,
  "poll-ms",
);
const settleMs = parseBoundedInteger(
  parsed["settle-ms"],
  750,
  250,
  10_000,
  "settle-ms",
);
const networkLatencyMs = parseBoundedInteger(
  parsed["network-latency-ms"],
  0,
  0,
  2_000,
  "network-latency-ms",
);
const cpuThrottleRate = parseBoundedNumber(
  parsed["cpu-throttle-rate"],
  1,
  1,
  20,
  "cpu-throttle-rate",
);
const scenarios = requestedScenarios(parsed.scenarios);
const outputDirectory = path.resolve(String(parsed["output-dir"]));
const distinctStateBearerToken = String(
  process.env.STREAMING_CAPTURE_STATE_TOKEN ?? "",
).trim();
const stateBearerToken = distinctStateBearerToken || viewerToken;
const stateAuthorizationMode = distinctStateBearerToken
  ? "distinct"
  : viewerToken
    ? "shared-viewer"
    : "none";
const captureHeadless = parsed.headed !== true;
const captureAngleBackend =
  String(process.env.STREAMING_CAPTURE_ANGLE ?? "").trim() ||
  (process.platform === "darwin" ? "metal" : "vulkan");
const captureBrowserChannel =
  String(process.env.STREAMING_CAPTURE_BROWSER_CHANNEL ?? "").trim() ||
  (process.platform === "darwin" ? "chrome" : undefined);
const captureLaunchArgs = buildDefaultCaptureLaunchArgs({
  angleBackend: captureAngleBackend,
  featureFlags: "--enable-features=Vulkan,UseSkiaRenderer,WebGPU",
});

const manifestPath = path.join(outputDirectory, "manifest.json");
await access(manifestPath)
  .then(() => {
    throw new Error(`refusing to overwrite existing evidence: ${manifestPath}`);
  })
  .catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });

assertByteCompleteLaunchAssets();

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);

const browser = await chromium.launch({
  headless: captureHeadless,
  args: captureLaunchArgs,
  ...(captureBrowserChannel ? { channel: captureBrowserChannel } : {}),
});
const context = await browser.newContext({
  viewport,
  serviceWorkers: "block",
});
const page = await context.newPage();
const cdpSession = await context.newCDPSession(page);
let browserConditionError = null;
try {
  await cdpSession.send("Network.enable");
  await cdpSession.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (networkLatencyMs > 0) {
    await cdpSession.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: networkLatencyMs,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });
  }
  if (cpuThrottleRate > 1) {
    await cdpSession.send("Emulation.setCPUThrottlingRate", {
      rate: cpuThrottleRate,
    });
  }
} catch (error) {
  browserConditionError = boundedMessage(
    error instanceof Error ? error.message : String(error),
  );
}
const consoleErrors = [];
const requestFailures = [];
const responseFailures = [];
const stateErrors = [];
const captures = [];
const capturedScenarios = new Set();
const candidates = new Map();
const sceneIssueCounts = new Map();
const presentationIssueCounts = new Map();
let latestSceneIssues = [];
let latestPresentationIssues = [];
const terminalScenarios = scenarios.filter((scenario) =>
  ["resolution-win", "resolution-draw", "cancelled"].includes(scenario),
);
const terminalHandoffs = new Map();
const terminalHandoffsComplete = () =>
  terminalScenarios.every(
    (scenario) => terminalHandoffs.get(scenario)?.complete === true,
  );
let lastProgressLogAt = 0;
const startedAt = Date.now();

page.on("console", (message) => {
  if (message.type() !== "error" || consoleErrors.length >= 100) return;
  consoleErrors.push({
    at: Date.now(),
    message: boundedMessage(message.text()),
  });
});
page.on("pageerror", (error) => {
  if (consoleErrors.length >= 100) return;
  consoleErrors.push({
    at: Date.now(),
    message: boundedMessage(error.message),
  });
});
page.on("requestfailed", (request) => {
  if (requestFailures.length >= 100) return;
  requestFailures.push({
    at: Date.now(),
    method: request.method(),
    url: redactRequestUrl(request.url()),
    reason: boundedMessage(
      request.failure()?.errorText ?? "request failed",
      200,
    ),
  });
});
page.on("response", (response) => {
  if (response.status() < 400 || responseFailures.length >= 100) return;
  responseFailures.push({
    at: Date.now(),
    method: response.request().method(),
    status: response.status(),
    url: redactRequestUrl(response.url()),
  });
});

let navigationError = null;
try {
  await page.goto(streamNavigationUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.waitForSelector("canvas", {
    state: "attached",
    timeout: 120_000,
  });

  while (
    Date.now() - startedAt < durationMs &&
    (capturedScenarios.size < scenarios.length || !terminalHandoffsComplete())
  ) {
    const observedAt = Date.now();
    let serverState;
    let browserProbe;
    try {
      [serverState, browserProbe] = await Promise.all([
        fetchState(stateUrl, stateBearerToken),
        readBrowserProbe(page),
      ]);
    } catch (error) {
      if (stateErrors.length < 100) {
        stateErrors.push({
          at: observedAt,
          message: boundedMessage(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const normalizedBrowserState = normalizeDuelCaptureState(
      browserProbe.state,
    );
    const rendererReady = browserProbe.rendererHealth?.ready === true;
    const layoutReady =
      browserProbe.layout.canvasCount === 1 &&
      browserProbe.layout.scrollWidth <= browserProbe.layout.innerWidth &&
      browserProbe.layout.scrollHeight <= browserProbe.layout.innerHeight;
    const sceneEvaluation = evaluateDuelSceneCapture(
      browserProbe.sceneDiagnostics,
      browserProbe.state,
      observedAt,
    );
    const safeCropEvaluation = evaluateDuelSafeCrop(
      sceneEvaluation.diagnostics,
      safeCrop,
    );
    const expectedAspect =
      browserProbe.layout.innerWidth / browserProbe.layout.innerHeight;
    const sceneIssues = [
      ...sceneEvaluation.issues,
      ...safeCropEvaluation.issues,
    ];
    if (
      sceneEvaluation.diagnostics &&
      Math.abs(sceneEvaluation.diagnostics.camera.aspect - expectedAspect) >
        0.03
    ) {
      sceneIssues.push("camera_aspect_mismatch");
    }
    latestSceneIssues = [...new Set(sceneIssues)];
    for (const issue of latestSceneIssues) {
      sceneIssueCounts.set(issue, (sceneIssueCounts.get(issue) ?? 0) + 1);
    }
    const presentationEvaluation = evaluateDuelPresentationCapture(
      browserProbe.presentationDiagnostics,
      browserProbe.state,
      observedAt,
    );
    latestPresentationIssues = presentationEvaluation.issues;
    for (const issue of latestPresentationIssues) {
      presentationIssueCounts.set(
        issue,
        (presentationIssueCounts.get(issue) ?? 0) + 1,
      );
    }
    const statesAgree = duelCaptureStatesAgree(browserProbe.state, serverState);
    if (parsed.verbose && observedAt - lastProgressLogAt >= 5_000) {
      lastProgressLogAt = observedAt;
      console.log(
        JSON.stringify({
          phase: normalizedBrowserState?.phase ?? null,
          rendererReady,
          degradedReason: browserProbe.rendererHealth?.degradedReason ?? null,
          layoutReady,
          statesAgree,
          ...(statesAgree
            ? {}
            : {
                browserState: summarizeCaptureState(browserProbe.state),
                serverState: summarizeCaptureState(serverState),
              }),
          sceneIssues: latestSceneIssues,
          presentationIssues: latestPresentationIssues,
          ...(latestSceneIssues.length > 0 && sceneEvaluation.diagnostics
            ? {
                scene: {
                  arenaVisualsReady:
                    sceneEvaluation.diagnostics.arenaVisualsReady,
                  camera: sceneEvaluation.diagnostics.camera,
                  agents: sceneEvaluation.diagnostics.agents.map((agent) =>
                    agent
                      ? {
                          id: agent.id,
                          avatarReady: agent.avatarReady,
                          renderPosition: agent.renderPosition,
                          facingTargetErrorDegrees:
                            agent.facingTargetErrorDegrees,
                          ndcPosition: agent.ndcPosition,
                        }
                      : null,
                  ),
                },
              }
            : {}),
          performance: browserProbe.performance
            ? {
                frameTimeP95Ms:
                  browserProbe.performance.overall?.frameIntervalMs?.p95 ??
                  null,
                frameTimeP99Ms:
                  browserProbe.performance.overall?.frameIntervalMs?.p99 ??
                  null,
                longFrames:
                  browserProbe.performance.overall?.frameBudget?.above50Ms ??
                  null,
                averageFps:
                  browserProbe.performance.overall?.frameIntervalMs?.average > 0
                    ? Number(
                        (
                          1_000 /
                          browserProbe.performance.overall.frameIntervalMs
                            .average
                        ).toFixed(1),
                      )
                    : null,
              }
            : null,
        }),
      );
    }
    if (
      !normalizedBrowserState ||
      !rendererReady ||
      !layoutReady ||
      latestSceneIssues.length > 0 ||
      latestPresentationIssues.length > 0 ||
      !statesAgree
    ) {
      candidates.clear();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    for (const [scenario, handoff] of terminalHandoffs) {
      terminalHandoffs.set(
        scenario,
        advanceDuelTerminalHandoff(
          handoff,
          browserProbe.state,
          browserProbe.presentationDiagnostics,
          observedAt,
        ),
      );
    }

    const matchedScenarios = classifyDuelCaptureScenarios(
      browserProbe.state,
      observedAt,
    ).filter(
      (scenario) =>
        scenarios.includes(scenario) && !capturedScenarios.has(scenario),
    );
    for (const scenario of matchedScenarios) {
      const identityKey = stableIdentityKey(browserProbe.state, scenario);
      if (!identityKey) continue;
      const previous = candidates.get(scenario);
      if (!previous || previous.identityKey !== identityKey) {
        candidates.set(scenario, { identityKey, since: observedAt });
        continue;
      }
      if (observedAt - previous.since < settleMs) continue;

      const screenshotPath = path.join(outputDirectory, `${scenario}.png`);
      await page.screenshot({ path: screenshotPath });
      await chmod(screenshotPath, 0o600);
      const [afterServerState, afterBrowserProbe] = await Promise.all([
        fetchState(stateUrl, stateBearerToken),
        readBrowserProbe(page),
      ]);
      const afterObservedAt = Date.now();
      const afterIdentityKey = stableIdentityKey(
        afterBrowserProbe.state,
        scenario,
      );
      const afterSceneEvaluation = evaluateDuelSceneCapture(
        afterBrowserProbe.sceneDiagnostics,
        afterBrowserProbe.state,
        afterObservedAt,
      );
      const afterSafeCropEvaluation = evaluateDuelSafeCrop(
        afterSceneEvaluation.diagnostics,
        safeCrop,
      );
      const afterExpectedAspect =
        afterBrowserProbe.layout.innerWidth /
        afterBrowserProbe.layout.innerHeight;
      const afterSceneReady = Boolean(
        afterSceneEvaluation.ok &&
        afterSafeCropEvaluation.ok &&
        afterSceneEvaluation.diagnostics &&
        Math.abs(
          afterSceneEvaluation.diagnostics.camera.aspect - afterExpectedAspect,
        ) <= 0.03,
      );
      const afterPresentationEvaluation = evaluateDuelPresentationCapture(
        afterBrowserProbe.presentationDiagnostics,
        afterBrowserProbe.state,
        afterObservedAt,
      );
      if (
        afterIdentityKey !== identityKey ||
        !duelCaptureStatesAgree(afterBrowserProbe.state, afterServerState) ||
        afterBrowserProbe.rendererHealth?.ready !== true ||
        !afterSceneReady ||
        !afterPresentationEvaluation.ok
      ) {
        candidates.delete(scenario);
        await unlink(screenshotPath).catch(() => {});
        continue;
      }

      captures.push({
        ...captureScenarioIdentity(afterBrowserProbe.state, scenario),
        capturedAt: afterObservedAt,
        screenshot: path.basename(screenshotPath),
        screenshotSha256: await sha256(screenshotPath),
        viewport,
        rendererHealth: afterBrowserProbe.rendererHealth,
        performance: afterBrowserProbe.performance,
        layout: afterBrowserProbe.layout,
        sceneDiagnostics: afterSceneEvaluation.diagnostics,
        safeCropNdc: afterSafeCropEvaluation.metrics,
        presentationDiagnostics: afterPresentationEvaluation.presentation,
      });
      capturedScenarios.add(scenario);
      if (terminalScenarios.includes(scenario)) {
        terminalHandoffs.set(
          scenario,
          advanceDuelTerminalHandoff(
            createDuelTerminalHandoff(scenario),
            afterBrowserProbe.state,
            afterBrowserProbe.presentationDiagnostics,
            afterObservedAt,
          ),
        );
      }
      candidates.delete(scenario);
      console.log(
        `Captured ${scenario} (${capturedScenarios.size}/${scenarios.length})`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
} catch (error) {
  navigationError = boundedMessage(
    error instanceof Error ? error.message : String(error),
  );
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

const missingScenarios = scenarios.filter(
  (scenario) => !capturedScenarios.has(scenario),
);
const missingTerminalHandoffs = terminalScenarios.filter(
  (scenario) => terminalHandoffs.get(scenario)?.complete !== true,
);
const finishedAt = Date.now();
const ok =
  navigationError === null &&
  browserConditionError === null &&
  missingScenarios.length === 0 &&
  missingTerminalHandoffs.length === 0 &&
  consoleErrors.length === 0 &&
  requestFailures.length === 0 &&
  responseFailures.length === 0 &&
  stateErrors.length === 0;
const manifest = {
  schemaVersion: 2,
  ok,
  startedAt,
  finishedAt,
  elapsedMs: finishedAt - startedAt,
  streamUrl: publicUrl(streamUrl),
  stateUrl: publicUrl(stateUrl),
  stateAuthorizationMode,
  requestedFrameRate: 60,
  captureBrowser: {
    headless: captureHeadless,
    channel: captureBrowserChannel ?? "bundled",
    angleBackend: captureAngleBackend,
    networkLatencyMs,
    cpuThrottleRate,
    conditionError: browserConditionError,
  },
  viewport,
  safeCropNdc: safeCrop,
  requiredScenarios: scenarios,
  missingScenarios,
  missingTerminalHandoffs,
  captures,
  terminalHandoffs: Object.fromEntries(terminalHandoffs),
  navigationError,
  browserConditionError,
  consoleErrors,
  requestFailures,
  responseFailures,
  stateErrors,
  sceneDiagnostics: {
    latestIssues: latestSceneIssues,
    issueCounts: Object.fromEntries(
      [...sceneIssueCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  },
  presentationDiagnostics: {
    latestIssues: latestPresentationIssues,
    issueCounts: Object.fromEntries(
      [...presentationIssueCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  },
};
const temporaryManifestPath = `${manifestPath}.tmp-${process.pid}`;
try {
  await writeFile(
    temporaryManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await rename(temporaryManifestPath, manifestPath);
} catch (error) {
  await unlink(temporaryManifestPath).catch(() => {});
  throw error;
}

console.log(
  JSON.stringify({
    ok,
    captures: captures.length,
    missingScenarios,
    missingTerminalHandoffs,
    consoleErrors: consoleErrors.length,
    requestFailures: requestFailures.length,
    responseFailures: responseFailures.length,
    stateErrors: stateErrors.length,
    browserConditionError,
    latestSceneIssues,
    latestPresentationIssues,
    manifestPath,
  }),
);
if (!ok) process.exitCode = 1;
