#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import bs58 from "bs58";

import {
  MAX_AUTHORITY_RESTART_RECOVERY_MS,
  isExpectedAuthorityFaultConsoleIssue,
  isExpectedAuthorityFaultRequestFailure,
  normalizeAuthorityIdentity,
  selectExactActiveSolanaMarket,
  validateAuthorityRestartContinuity,
  validateAuthorityViewerContinuity,
  validateOwnedGameServerPidRecord,
} from "./duel-authority-restart-policy.mjs";
import {
  hasHlsManifestAdvanced,
  redactWarmRendererUrl,
  validateWarmRendererRetention,
} from "./duel-capture-restart-policy.mjs";

const execFileAsync = promisify(execFile);
const options = parseArgs({
  options: {
    "hyperia-url": { type: "string" },
    "hyperbet-api-url": { type: "string" },
    "betting-url": { type: "string" },
    "capture-browser-port": { type: "string" },
    "solana-rpc-url": { type: "string" },
    "duel-market-program-id": { type: "string" },
    "pid-file": { type: "string" },
    "expected-launcher-pid": { type: "string" },
    "evidence-dir": { type: "string" },
    "timeout-ms": { type: "string", default: "180000" },
  },
  strict: true,
}).values;

function requiredOption(name) {
  const value = String(options[name] || "").trim();
  if (!value) throw new Error(`--${name} is required`);
  return value.replace(/\/$/, "");
}

const hyperiaUrl = requiredOption("hyperia-url");
const hyperbetApiUrl = requiredOption("hyperbet-api-url");
const bettingUrl = requiredOption("betting-url");
const solanaRpcUrl = requiredOption("solana-rpc-url");
const duelMarketProgramId = requiredOption("duel-market-program-id");
const pidFile = path.resolve(requiredOption("pid-file"));
const evidenceDir = path.resolve(requiredOption("evidence-dir"));
const expectedLauncherPid = Number.parseInt(
  requiredOption("expected-launcher-pid"),
  10,
);
const captureBrowserPort = Number.parseInt(
  requiredOption("capture-browser-port"),
  10,
);
const timeoutMs = Number.parseInt(options["timeout-ms"], 10);
if (!Number.isSafeInteger(expectedLauncherPid) || expectedLauncherPid <= 0) {
  throw new Error("--expected-launcher-pid must be a positive integer");
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) {
  throw new Error("--timeout-ms must be at least 60000");
}
if (
  !Number.isSafeInteger(captureBrowserPort) ||
  captureBrowserPort < 1 ||
  captureBrowserPort > 65_535
) {
  throw new Error("--capture-browser-port must be an integer from 1 to 65535");
}
for (const [label, rawUrl] of [
  ["Hyperia", hyperiaUrl],
  ["Hyperbet", hyperbetApiUrl],
  ["Hyperbet app", bettingUrl],
  ["Solana RPC", solanaRpcUrl],
]) {
  const parsed = new URL(rawUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    !["http:", "https:"].includes(parsed.protocol)
  ) {
    throw new Error(`${label} authority-restart target must be loopback HTTP`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, operation, deadlineMs) {
  let lastError = null;
  while (Date.now() < deadlineMs) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
  );
}

async function fetchJson(url, { allowFailure = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 1_000) };
    }
    if (!response.ok && !allowFailure) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/vnd.apple.mpegurl,text/plain" },
    });
    if (!response.ok)
      throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function summarizeHlsManifest(raw) {
  const manifest = String(raw);
  const sequence = manifest.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m);
  const lines = manifest.split(/\r?\n/);
  const segments = lines.filter((line) =>
    /\.(?:ts|m4s|mp4)(?:$|[?#])/i.test(line.trim()),
  );
  const programDates = lines
    .filter((line) => line.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))
    .map((line) => Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length)))
    .filter(Number.isFinite);
  const mediaSequence = sequence ? Number.parseInt(sequence[1], 10) : null;
  if (!Number.isSafeInteger(mediaSequence) || segments.length < 1) {
    throw new Error("HLS manifest has no valid media sequence or segments");
  }
  return {
    mediaSequence,
    segmentCount: segments.length,
    firstSegment: segments[0],
    lastSegment: segments.at(-1),
    lastProgramDateTimeMs: programDates.at(-1) ?? null,
    discontinuityCount: lines.filter((line) => line === "#EXT-X-DISCONTINUITY")
      .length,
  };
}

async function evaluateCdpTarget(webSocketUrl, expression) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const requestId = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("warm renderer CDP evaluation timed out"));
    }, 5_000);
    const finish = (operation) => {
      clearTimeout(timer);
      socket.close();
      operation();
    };
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true,
          },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.id !== requestId) return;
      if (message.error || message.result?.exceptionDetails) {
        finish(() =>
          reject(
            new Error(
              `warm renderer CDP evaluation failed: ${JSON.stringify(message.error ?? message.result.exceptionDetails)}`,
            ),
          ),
        );
        return;
      }
      finish(() => resolve(message.result?.result?.value));
    });
    socket.addEventListener("error", () => {
      finish(() => reject(new Error("warm renderer CDP connection failed")));
    });
  });
}

async function readWarmRendererIdentity(marker, initializeMarker) {
  const targets = (
    await fetchJson(`http://127.0.0.1:${captureBrowserPort}/json/list`)
  ).payload;
  const pages = Array.isArray(targets)
    ? targets.filter(
        (target) =>
          target?.type === "page" &&
          typeof target?.id === "string" &&
          typeof target?.url === "string" &&
          /^https?:\/\//.test(target.url) &&
          typeof target?.webSocketDebuggerUrl === "string",
      )
    : [];
  if (pages.length !== 1) {
    throw new Error(
      `warm renderer must expose exactly one HTTP page target; observed ${pages.length}`,
    );
  }
  const target = pages[0];
  const expression = `(() => {
    const marker = ${JSON.stringify(marker)};
    if (${initializeMarker ? "true" : "false"}) {
      globalThis.__HYPERIA_AUTHORITY_RECOVERY_MARKER__ = marker;
    }
    const health = globalThis.__HYPERIA_STREAM_RENDERER_HEALTH__;
    return {
      marker: globalThis.__HYPERIA_AUTHORITY_RECOVERY_MARKER__ ?? null,
      pageUrl: location.href,
      timeOrigin: performance.timeOrigin,
      navigationEntries: performance.getEntriesByType("navigation").length,
      hasCanvas: document.querySelector("canvas") !== null,
      rendererReady: health?.ready === true && health?.degradedReason == null,
    };
  })()`;
  const evaluated = await evaluateCdpTarget(
    target.webSocketDebuggerUrl,
    expression,
  );
  if (
    !evaluated ||
    typeof evaluated !== "object" ||
    evaluated.pageUrl !== target.url
  ) {
    throw new Error("warm renderer target URL disagrees with the page runtime");
  }
  return {
    targetId: target.id,
    marker: evaluated.marker,
    pageUrlSha256: createHash("sha256").update(evaluated.pageUrl).digest("hex"),
    pageUrlRedacted: redactWarmRendererUrl(evaluated.pageUrl),
    timeOrigin: evaluated.timeOrigin,
    navigationEntries: evaluated.navigationEntries,
    hasCanvas: evaluated.hasCanvas,
    rendererReady: evaluated.rendererReady,
  };
}

async function readBrowserState(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".hm-root");
    const video = document.querySelector("video");
    const marketPanel = document.querySelector(
      '[data-testid="solana-clob-panel"]',
    );
    const wagerControls = Array.from(
      document.querySelectorAll(
        [
          '[data-testid="prediction-select-yes"]',
          '[data-testid="prediction-select-no"]',
          '[data-testid="prediction-tab-buy"]',
          '[data-testid="prediction-tab-sell"]',
          '[data-testid="prediction-amount-input"]',
          '[data-testid="prediction-submit"]',
          '[data-testid="solana-clob-price-input"]',
          '[data-testid="solana-order-quote"]',
          '[data-testid="solana-order-confirmation"]',
        ].join(","),
      ),
    );
    const wagerControlCount = wagerControls.filter((control) => {
      if (control.getAttribute("aria-disabled") === "true") return false;
      if (
        control instanceof HTMLButtonElement ||
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLTextAreaElement
      ) {
        return !control.disabled;
      }
      return true;
    }).length;
    return {
      marker: globalThis.__HYPERIA_AUTHORITY_VIEWER_MARKER__ ?? null,
      timeOrigin: performance.timeOrigin,
      navigationEntries: performance.getEntriesByType("navigation").length,
      marketPanelPresent: marketPanel !== null,
      marketPanelText:
        marketPanel instanceof HTMLElement
          ? marketPanel.innerText.replace(/\s+/g, " ").trim()
          : "",
      wagerControlElementCount: wagerControls.length,
      wagerControlCount,
      matchupLabel:
        document.querySelector(".hm-matchup-label")?.textContent?.trim() ?? "",
      liveState:
        document.querySelector(".hm-live-state")?.textContent?.trim() ?? "",
      recoveryVisible: Boolean(
        document.querySelector(".hm-stream-recovery")?.getClientRects().length,
      ),
      authority: root
        ? {
            streamCycleId: root.getAttribute("data-stream-cycle-id"),
            streamDuelId: root.getAttribute("data-stream-duel-id"),
            streamDuelKey: root.getAttribute("data-stream-duel-key"),
            marketDuelId: root.getAttribute("data-market-duel-id"),
            marketDuelKey: root.getAttribute("data-market-duel-key"),
            marketMode: root.getAttribute("data-market-mode"),
            marketReason: root.getAttribute("data-market-reason"),
            marketCanPlaceBet:
              root.getAttribute("data-market-can-place-bet") === "true",
          }
        : null,
      video: video
        ? {
            currentTime: Number(video.currentTime),
            declaredSource: video.dataset.streamSource || "",
            currentSrc: video.currentSrc || video.src,
            paused: video.paused,
            readyState: video.readyState,
          }
        : null,
    };
  });
}

function browserHasExactAuthority(state, identity, tradeable) {
  return Boolean(
    state?.authority?.streamCycleId === identity.cycleId &&
    state.authority.streamDuelId === identity.duelId &&
    state.authority.streamDuelKey === identity.duelKey &&
    state.authority.marketDuelId === identity.duelId &&
    state.authority.marketDuelKey === identity.duelKey &&
    state.authority.marketCanPlaceBet === tradeable,
  );
}

async function waitForHealthyAuthorityBrowser(
  page,
  identity,
  marker,
  minimumVideoTime,
  deadlineMs,
) {
  return waitFor(
    "same-session Hyperbet viewer on exact authority",
    async () => {
      const state = await readBrowserState(page);
      return state.marker === marker &&
        browserHasExactAuthority(state, identity, true) &&
        state.marketPanelPresent === true &&
        state.wagerControlCount > 0 &&
        state.video?.readyState >= 2 &&
        state.video?.paused === false &&
        state.video.currentTime >= minimumVideoTime
        ? state
        : null;
    },
    deadlineMs,
  );
}

async function waitForFailClosedAuthorityBrowser(
  page,
  identity,
  marker,
  deadlineMs,
) {
  return waitFor(
    "same-session Hyperbet viewer fail-closed state",
    async () => {
      const state = await readBrowserState(page);
      const authority = state.authority;
      return state.marker === marker &&
        authority?.streamDuelId === null &&
        authority?.streamDuelKey === null &&
        authority?.marketDuelId === identity.duelId &&
        authority?.marketDuelKey === identity.duelKey &&
        authority?.marketCanPlaceBet === false &&
        ["stream-disconnected", "stream-stale"].includes(
          authority?.marketReason,
        ) &&
        state.marketPanelPresent === true &&
        state.wagerControlCount === 0
        ? state
        : null;
    },
    deadlineMs,
  );
}

function startFailClosedBrowserObservation(
  page,
  identity,
  marker,
  startedAtMs,
) {
  const observations = [];
  let recoveryAllowed = false;
  let stopped = false;
  let failure = null;
  let lastKey = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        const state = await readBrowserState(page);
        if (
          state.marker !== marker ||
          state.authority?.marketDuelId !== identity.duelId ||
          state.authority?.marketDuelKey !== identity.duelKey
        ) {
          throw new Error(
            `fail-closed observer lost browser/market identity: ${JSON.stringify(state)}`,
          );
        }
        const hasExactRecoveredAuthority = browserHasExactAuthority(
          state,
          identity,
          true,
        );
        if (
          !recoveryAllowed &&
          !hasExactRecoveredAuthority &&
          (state.authority?.marketCanPlaceBet === true ||
            state.wagerControlCount > 0)
        ) {
          throw new Error(
            `wager authority reopened before world recovery: ${JSON.stringify(state)}`,
          );
        }
        const observation = {
          elapsedMs: Date.now() - startedAtMs,
          streamDuelId: state.authority?.streamDuelId ?? null,
          marketMode: state.authority?.marketMode ?? null,
          marketReason: state.authority?.marketReason ?? null,
          marketCanPlaceBet: state.authority?.marketCanPlaceBet === true,
          wagerControlElementCount: state.wagerControlElementCount,
          wagerControlCount: state.wagerControlCount,
          videoTime: state.video?.currentTime ?? null,
          videoReadyState: state.video?.readyState ?? null,
          videoPaused: state.video?.paused ?? null,
        };
        const key = JSON.stringify({
          streamDuelId: observation.streamDuelId,
          marketMode: observation.marketMode,
          marketReason: observation.marketReason,
          marketCanPlaceBet: observation.marketCanPlaceBet,
          wagerControlElementCount: observation.wagerControlElementCount,
          wagerControlCount: observation.wagerControlCount,
          videoReadyState: observation.videoReadyState,
          videoPaused: observation.videoPaused,
        });
        if (key === lastKey && observations.length > 0) {
          observations[observations.length - 1] = observation;
        } else {
          observations.push(observation);
          lastKey = key;
        }
      } catch (error) {
        failure = error;
        stopped = true;
        break;
      }
      await delay(100);
    }
  })();
  return {
    allowRecovery() {
      recoveryAllowed = true;
    },
    async stop() {
      stopped = true;
      await loop;
      if (failure) throw failure;
      return observations;
    },
  };
}

let rpcId = 0;
async function solanaRpc(method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(solanaRpcUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        params,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.error) {
      throw new Error(
        `${method} failed: ${JSON.stringify(payload?.error ?? response.status)}`,
      );
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function loadMarketAccountSet(marketRef) {
  const accountResult = await solanaRpc("getAccountInfo", [
    marketRef,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const account = accountResult?.value;
  if (account?.owner !== duelMarketProgramId) {
    throw new Error("canonical market account is not owned by duel_market");
  }
  const encodedData = Array.isArray(account?.data) ? account.data[0] : null;
  const bytes = Buffer.from(String(encodedData || ""), "base64");
  if (bytes.length < 8) {
    throw new Error("canonical market account omits its discriminator");
  }
  const discriminator = bs58.encode(bytes.subarray(0, 8));
  const accounts = await solanaRpc("getProgramAccounts", [
    duelMarketProgramId,
    {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 8 },
      filters: [{ memcmp: { offset: 0, bytes: discriminator } }],
    },
  ]);
  const addresses = (Array.isArray(accounts) ? accounts : [])
    .map((entry) => String(entry?.pubkey || "").trim())
    .filter(Boolean)
    .sort();
  if (!addresses.includes(marketRef)) {
    throw new Error("canonical market is absent from the discriminator query");
  }
  return { discriminator, addresses };
}

async function readPidRecord() {
  return JSON.parse(await fs.readFile(pidFile, "utf8"));
}

async function assertOwnedProcess(owner) {
  const { stdout } = await execFileAsync("ps", [
    "-p",
    String(owner.pid),
    "-o",
    "ppid=",
    "-o",
    "command=",
  ]);
  const match = stdout.trim().match(/^(\d+)\s+(.+)$/s);
  if (
    !match ||
    Number(match[1]) !== owner.launcherPid ||
    !/start-hyperia-server\.mjs/.test(match[2])
  ) {
    throw new Error("PID file does not identify the launcher's game server");
  }
  return { ppid: Number(match[1]), command: match[2] };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function observeCanonicalBoundary() {
  const [stateResponse, configResponse, activeResponse, statusResponse] =
    await Promise.all([
      fetchJson(`${hyperiaUrl}/api/streaming/state`),
      fetchJson(`${hyperiaUrl}/api/streaming/config`),
      fetchJson(`${hyperbetApiUrl}/api/arena/prediction-markets/active`),
      fetchJson(`${hyperbetApiUrl}/status`),
    ]);
  const cycle = stateResponse.payload?.cycle;
  const identity = normalizeAuthorityIdentity(cycle);
  const activeMarket = selectExactActiveSolanaMarket(
    activeResponse.payload,
    identity,
  );
  const keeperMarket = selectExactActiveSolanaMarket(
    { markets: statusResponse.payload?.bot?.health?.markets },
    identity,
  );
  if (keeperMarket.marketRef !== activeMarket.marketRef) {
    throw new Error("keeper health and public market disagree on marketRef");
  }
  const marketAccounts = await loadMarketAccountSet(activeMarket.marketRef);
  return {
    identity,
    phase: cycle?.phase ?? null,
    timeRemaining: Number(cycle?.timeRemaining),
    authorityVerified:
      configResponse.payload?.localSchedulerAuthorityVerified === true,
    activeMarket,
    keeperMarket,
    marketAccounts,
    hyperbetSource: {
      cycleId: statusResponse.payload?.stream?.cycleId ?? null,
      phase: statusResponse.payload?.stream?.phase ?? null,
      lastSourceError: statusResponse.payload?.stream?.lastSourceError ?? null,
      sourceEventsConnected:
        statusResponse.payload?.stream?.sourceEventsConnected === true,
      sourceAvailable: statusResponse.payload?.stream?.sourceAvailable === true,
    },
  };
}

async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(
    evidenceDir,
    "authority-restart-evidence.json",
  );
  const screenshotPaths = {
    baseline: path.join(evidenceDir, "01-authority-healthy.png"),
    unavailable: path.join(evidenceDir, "02-authority-unavailable.png"),
    recovered: path.join(evidenceDir, "03-authority-recovered.png"),
  };
  for (const candidate of [evidencePath, ...Object.values(screenshotPaths)]) {
    try {
      await fs.access(candidate);
      throw new Error(`refusing to overwrite existing evidence: ${candidate}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  let page = null;
  let authorityFaultActive = false;
  const consoleIssues = [];
  const pageErrors = [];
  const networkFailures = [];
  const expectedFaultResponses = [];
  const expectedFaultRuntimeIssues = [];
  let failClosedObserver = null;
  let failClosedObservations = [];
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        const issue = `${message.type()}: ${message.text()}`;
        if (
          authorityFaultActive &&
          isExpectedAuthorityFaultConsoleIssue(message.type(), message.text())
        ) {
          expectedFaultRuntimeIssues.push(issue);
        } else {
          consoleIssues.push(issue);
        }
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const issue = `${response.status()} ${response.url()}`;
      if (
        authorityFaultActive &&
        [502, 503, 504].includes(response.status()) &&
        [bettingUrl, hyperbetApiUrl].some((base) =>
          response.url().startsWith(base),
        )
      ) {
        expectedFaultResponses.push(issue);
      } else {
        networkFailures.push(issue);
      }
    });
    page.on("requestfailed", (request) => {
      const detail = request.failure()?.errorText || "request failed";
      if (detail.includes("ERR_ABORTED")) return;
      const issue = `${detail} ${request.url()}`;
      if (
        authorityFaultActive &&
        isExpectedAuthorityFaultRequestFailure(
          detail,
          request.url(),
          hyperiaUrl,
        )
      ) {
        expectedFaultRuntimeIssues.push(issue);
      } else {
        networkFailures.push(issue);
      }
    });

    const ownerRecord = validateOwnedGameServerPidRecord(
      await readPidRecord(),
      {
        expectedLauncherPid,
      },
    );
    const ownerProcess = await assertOwnedProcess(ownerRecord);
    const baseline = await waitFor(
      "fresh authority-owned ANNOUNCEMENT with one canonical SOL market",
      async () => {
        const observation = await observeCanonicalBoundary();
        if (
          observation.phase !== "ANNOUNCEMENT" ||
          observation.authorityVerified !== true ||
          !Number.isFinite(observation.timeRemaining) ||
          observation.timeRemaining < 75_000 ||
          observation.activeMarket.lifecycleStatus !== "OPEN" ||
          observation.keeperMarket.lifecycleStatus !== "OPEN" ||
          observation.hyperbetSource.cycleId !== observation.identity.cycleId ||
          observation.hyperbetSource.lastSourceError !== null ||
          observation.hyperbetSource.sourceEventsConnected !== true ||
          observation.hyperbetSource.sourceAvailable !== true
        ) {
          return null;
        }
        return observation;
      },
      Date.now() + timeoutMs,
    );

    await page.goto(bettingUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeoutMs, 60_000),
    });
    const viewerMarker = `authority-viewer-${Date.now()}-${process.pid}`;
    await page.evaluate((marker) => {
      globalThis.__HYPERIA_AUTHORITY_VIEWER_MARKER__ = marker;
    }, viewerMarker);
    const baselineBrowser = await waitForHealthyAuthorityBrowser(
      page,
      baseline.identity,
      viewerMarker,
      1,
      Date.now() + 60_000,
    );
    const hlsUrl = baselineBrowser.video.declaredSource;
    const parsedHlsUrl = new URL(hlsUrl);
    if (
      parsedHlsUrl.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(parsedHlsUrl.hostname) ||
      !parsedHlsUrl.pathname.endsWith(".m3u8")
    ) {
      throw new Error("authority viewer HLS source is not a loopback playlist");
    }
    const manifestBefore = summarizeHlsManifest(await fetchText(hlsUrl));
    const warmRendererMarker = `authority-renderer-${Date.now()}-${process.pid}`;
    const warmRendererBefore = await readWarmRendererIdentity(
      warmRendererMarker,
      true,
    );
    await page.screenshot({ path: screenshotPaths.baseline, fullPage: true });
    await fs.chmod(screenshotPaths.baseline, 0o600);

    const killedAtMs = Date.now();
    authorityFaultActive = true;
    process.kill(ownerRecord.pid, "SIGKILL");
    const unavailableBrowserPromise = waitForFailClosedAuthorityBrowser(
      page,
      baseline.identity,
      viewerMarker,
      killedAtMs + 5_000,
    );
    await waitFor(
      "hard-killed world owner exit",
      () => (!isProcessAlive(ownerRecord.pid) ? true : null),
      killedAtMs + 5_000,
    );
    const unavailable = await waitFor(
      "launcher-observed world-owner outage",
      async () => {
        const record = await readPidRecord();
        if (
          record?.available !== false ||
          Number(record?.pid) !== ownerRecord.pid ||
          record?.signal !== "SIGKILL"
        ) {
          return null;
        }
        const source = await fetchJson(`${hyperbetApiUrl}/health`, {
          allowFailure: true,
        }).catch((error) => ({
          ok: false,
          status: null,
          payload: {
            error: error instanceof Error ? error.message : String(error),
          },
        }));
        return {
          observedAtMs: Date.now(),
          pidRecord: record,
          hyperbetReady: source.ok,
          hyperbetStatus: source.status,
          hyperbetReasons: source.payload?.reasons ?? null,
        };
      },
      killedAtMs + 5_000,
    );
    const unavailableBrowser = await unavailableBrowserPromise;
    const unavailableBrowserAtMs = Date.now();
    failClosedObserver = startFailClosedBrowserObservation(
      page,
      baseline.identity,
      viewerMarker,
      unavailableBrowserAtMs,
    );
    await page.screenshot({
      path: screenshotPaths.unavailable,
      fullPage: true,
    });
    await fs.chmod(screenshotPaths.unavailable, 0o600);

    const replacementRecord = await waitFor(
      "cold replacement game-server ownership",
      async () => {
        const record = validateOwnedGameServerPidRecord(await readPidRecord(), {
          expectedLauncherPid,
          previousGeneration: ownerRecord.generation,
        });
        if (record.pid === ownerRecord.pid) return null;
        return record;
      },
      killedAtMs + 15_000,
    );
    const replacementProcess = await assertOwnedProcess(replacementRecord);

    const recovered = await waitFor(
      "replacement world authority and exact market continuity",
      async () => {
        const observation = await observeCanonicalBoundary();
        if (
          observation.authorityVerified !== true ||
          observation.identity.cycleId !== baseline.identity.cycleId ||
          observation.identity.duelId !== baseline.identity.duelId ||
          observation.identity.duelKey !== baseline.identity.duelKey ||
          observation.activeMarket.marketRef !==
            baseline.activeMarket.marketRef ||
          observation.keeperMarket.marketRef !==
            baseline.keeperMarket.marketRef ||
          observation.hyperbetSource.cycleId !== baseline.identity.cycleId ||
          observation.hyperbetSource.lastSourceError !== null ||
          observation.hyperbetSource.sourceEventsConnected !== true ||
          observation.hyperbetSource.sourceAvailable !== true
        ) {
          return null;
        }
        return observation;
      },
      killedAtMs + MAX_AUTHORITY_RESTART_RECOVERY_MS,
    );
    const recoveredAtMs = Date.now();
    failClosedObserver.allowRecovery();
    failClosedObservations = await failClosedObserver.stop();
    failClosedObserver = null;
    const recoveredBrowser = await waitForHealthyAuthorityBrowser(
      page,
      baseline.identity,
      viewerMarker,
      baselineBrowser.video.currentTime + 1,
      killedAtMs + 60_000,
    );
    const recoveredBrowserAtMs = Date.now();
    authorityFaultActive = false;
    const manifestAfter = await waitFor(
      "advancing HLS across world-authority restart",
      async () => {
        const candidate = summarizeHlsManifest(await fetchText(hlsUrl));
        return hasHlsManifestAdvanced(manifestBefore, candidate)
          ? candidate
          : null;
      },
      killedAtMs + 60_000,
    );
    const warmRendererAfter = await readWarmRendererIdentity(
      warmRendererMarker,
      false,
    );
    const warmRenderer = validateWarmRendererRetention(
      warmRendererBefore,
      warmRendererAfter,
    );
    await page.screenshot({ path: screenshotPaths.recovered, fullPage: true });
    await fs.chmod(screenshotPaths.recovered, 0o600);

    // Leave enough time for a delayed duplicate-market callback or page reload
    // to become visible before accepting the continuity proof.
    await delay(2_000);
    const stable = await observeCanonicalBoundary();
    const stableBrowser = await readBrowserState(page);
    const continuity = validateAuthorityRestartContinuity({
      beforeIdentity: baseline.identity,
      afterIdentity: stable.identity,
      beforeMarket: baseline.activeMarket,
      afterMarket: stable.activeMarket,
      beforeMarketAccounts: baseline.marketAccounts.addresses,
      afterMarketAccounts: stable.marketAccounts.addresses,
      recoveryMs: recoveredAtMs - killedAtMs,
    });
    const viewerContinuity = validateAuthorityViewerContinuity({
      expectedIdentity: baseline.identity,
      before: baselineBrowser,
      unavailable: unavailableBrowser,
      after: stableBrowser,
      killedAtMs,
      unavailableAtMs: unavailableBrowserAtMs,
      recoveredAtMs: recoveredBrowserAtMs,
    });
    if (
      stable.keeperMarket.marketRef !== baseline.keeperMarket.marketRef ||
      stable.hyperbetSource.cycleId !== baseline.identity.cycleId ||
      stable.hyperbetSource.lastSourceError !== null ||
      stable.hyperbetSource.sourceEventsConnected !== true ||
      stable.hyperbetSource.sourceAvailable !== true
    ) {
      throw new Error(
        "keeper continuity drifted during the post-recovery hold",
      );
    }
    if (
      consoleIssues.length > 0 ||
      pageErrors.length > 0 ||
      networkFailures.length > 0 ||
      expectedFaultResponses.length > 20 ||
      expectedFaultRuntimeIssues.length > 30
    ) {
      throw new Error(
        `authority viewer emitted runtime failures: ${[
          ...consoleIssues,
          ...pageErrors,
          ...networkFailures,
        ].join(
          " | ",
        )}; expected fault responses=${expectedFaultResponses.length}; expected fault runtime issues=${expectedFaultRuntimeIssues.length}`,
      );
    }

    const screenshotEvidence = {};
    for (const [label, screenshotPath] of Object.entries(screenshotPaths)) {
      screenshotEvidence[label] = {
        path: screenshotPath,
        sha256: createHash("sha256")
          .update(await fs.readFile(screenshotPath))
          .digest("hex"),
      };
    }
    const evidence = {
      schemaVersion: 2,
      proof:
        "built-hyperia-world-owner-sigkill-sol-market-and-viewer-continuity",
      scope: {
        environment: "owned-local-production-builds",
        chain: "solana-localnet",
        externalValue: false,
        keeper: "actual-duel-keeper",
        fault: "game-server-world-owner-sigkill",
        sameSessionHyperbetViewer: true,
        sameSessionWarmRenderer: true,
      },
      baseline: { ...baseline, browser: baselineBrowser },
      fault: {
        killedAtMs,
        owner: { ...ownerRecord, process: ownerProcess },
        unavailable,
        browser: unavailableBrowser,
        browserObservations: failClosedObservations,
      },
      replacement: {
        ...replacementRecord,
        process: replacementProcess,
        recoveredAtMs,
        recoveryMs: recoveredAtMs - killedAtMs,
      },
      recovered: { ...recovered, browser: recoveredBrowser },
      stable: { ...stable, browser: stableBrowser },
      continuity,
      viewerContinuity,
      streamingContinuity: {
        manifestBefore,
        manifestAfter,
        warmRenderer,
      },
      diagnostics: {
        consoleIssues,
        pageErrors,
        networkFailures,
        expectedFaultResponses,
        expectedFaultRuntimeIssues,
      },
      screenshots: screenshotEvidence,
      checks: {
        realBuiltWorldOwnerKilled: true,
        coldReplacementPidObserved: true,
        authorityReacquired: true,
        exactCycleRetained: true,
        exactDuelRetained: true,
        exactDuelKeyRetained: true,
        exactKeeperMarketRetained: true,
        onChainMarketAccountSetUnchanged: true,
        overlappingDuelObserved: false,
        duplicateSolMarketObserved: false,
        boundedRecovery: true,
        browserFailedClosedWithinFiveSeconds: true,
        browserSessionRetained: true,
        marketPanelSessionRetained: true,
        browserHlsAdvanced: true,
        warmRendererNavigationRetained: true,
      },
      limitations: [
        "Owned loopback production builds and disposable Solana localnet only.",
        "This is not a public-cluster, multi-host, external-network, or production-infrastructure failover claim.",
      ],
      capturedAtMs: Date.now(),
    };
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    await fs.writeFile(evidencePath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const report = {
      ok: true,
      evidencePath,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      cycleId: continuity.identity.cycleId,
      duelId: continuity.identity.duelId,
      duelKey: continuity.identity.duelKey,
      marketRef: continuity.marketRef,
      marketAccountCount: continuity.marketAccountCount,
      recoveryMs: continuity.recoveryMs,
      viewerFailClosedMs: viewerContinuity.failClosedMs,
      viewerRecoveryMs: viewerContinuity.recoveryMs,
      ownerPid: ownerRecord.pid,
      replacementPid: replacementRecord.pid,
    };
    console.log(`[authority-restart-report] ${JSON.stringify(report)}`);
  } finally {
    authorityFaultActive = false;
    if (failClosedObserver) {
      await failClosedObserver.stop().catch(() => undefined);
    }
    await page?.close().catch(() => undefined);
    await browser.close();
  }
}

main().catch((error) => {
  console.error(
    `[authority-restart] failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exitCode = 1;
});
