#!/usr/bin/env node

/**
 * Duel stack verifier.
 *
 * Validates a running duel stack end-to-end:
 * - server/client/betting HTTP readiness
 * - active streaming duel with real combat progress (HP drop or damage)
 * - RTMP bridge ingest bytes
 * - duel telemetry APIs (inventory + monologues)
 */

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { PublicKey } from "@solana/web3.js";
import {
  installBrowserResourceTransferObserver,
  readBrowserResourceTransfers,
} from "./duel-browser-resource-transfers.mjs";

import {
  getHealthyBrowserAudioEvidence,
  getNonVacuousFightingEquipmentEvidence,
  validateHyperbetLiveFightObservation,
  validateLocalSolanaBrowserOrderEvidence,
} from "./duel-launch-smoke-policy.mjs";
import {
  evaluateFullTopologyBrowserPerformance,
  FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET,
  resolveFullTopologyBrowserPerformanceProfile,
  resolveHyperbetAppRuntime,
} from "./duel-full-topology-browser-performance-policy.mjs";

const values = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "server-url": { type: "string", default: "http://localhost:5555" },
    "client-url": { type: "string", default: "http://localhost:3333" },
    "betting-url": { type: "string", default: "http://localhost:4179" },
    "hyperbet-api-url": { type: "string", default: "" },
    "hyperbet-read-only": { type: "boolean" },
    "hyperbet-local-transactions": { type: "boolean" },
    "solana-rpc-url": { type: "string", default: "" },
    "duel-market-program-id": { type: "string", default: "" },
    "expected-local-wallet": { type: "string", default: "" },
    "browser-evidence-dir": {
      type: "string",
      default: process.env.DUEL_VERIFY_BROWSER_EVIDENCE_DIR || "",
    },
    "browser-performance-profile": { type: "string", default: "off" },
    "hyperbet-app-runtime": { type: "string", default: "development" },
    "hls-url": { type: "string", default: "" },
    "skip-stream": { type: "boolean" },
    "skip-betting": { type: "boolean" },
    "timeout-ms": { type: "string", default: "240000" },
    "fight-timeout-ms": { type: "string", default: "120000" },
    "rtmp-timeout-ms": { type: "string", default: "120000" },
    "require-destinations": { type: "string", default: "" },
    "poll-ms": { type: "string", default: "2000" },
    verbose: { type: "boolean", short: "v" },
  },
  strict: true,
}).values;

if (values.help) {
  console.log(`
Verify duel stack readiness and combat integrity.

Usage:
  bun run duel:verify [options]

Options:
  -h, --help                 Show help
  --server-url <url>         Game server URL (default: http://localhost:5555)
  --client-url <url>         Game client URL (default: http://localhost:3333)
  --betting-url <url>        Betting app URL (default: http://localhost:4179)
  --hyperbet-api-url <url>   Optional local Hyperbet backend to verify
  --hyperbet-read-only       Require spectator UI with no transaction controls
  --hyperbet-local-transactions
                             Require a matched, keeper-recorded local browser order
  --solana-rpc-url <url>     Owned local validator used for order evidence
  --duel-market-program-id <address>
                             Expected local duel-market program
  --expected-local-wallet <address>
                             Expected funded headless browser wallet
  --browser-evidence-dir <path>
                             Retain a verified Hyperbet browser screenshot
  --browser-performance-profile <profile>
                             off or desktop_720p (default: off)
  --hyperbet-app-runtime <runtime>
                             development or production_preview
  --hls-url <url>            Optional HLS playlist URL to verify
  --skip-stream              Skip HLS, RTMP, and stream-player checks
  --skip-betting             Skip betting app HTTP readiness check
  --timeout-ms <ms>          General timeout (default: 240000)
  --fight-timeout-ms <ms>    Combat proof timeout (default: 120000)
  --rtmp-timeout-ms <ms>     Optional RTMP status timeout (default: 120000)
  --require-destinations <list>
                             Comma list of required RTMP destinations
                             (example: twitch,youtube)
  --poll-ms <ms>             Poll interval (default: 2000)
  -v, --verbose              Verbose polling logs
`);
  process.exit(0);
}

const serverUrl = values["server-url"].replace(/\/$/, "");
const clientUrl = values["client-url"].replace(/\/$/, "");
const bettingUrl = values["betting-url"].replace(/\/$/, "");
const hyperbetApiUrl = String(values["hyperbet-api-url"] || "")
  .trim()
  .replace(/\/$/, "");
const hyperbetReadOnly = values["hyperbet-read-only"] === true;
const hyperbetLocalTransactions =
  values["hyperbet-local-transactions"] === true;
const solanaRpcUrl = String(values["solana-rpc-url"] || "")
  .trim()
  .replace(/\/$/, "");
const duelMarketProgramId = String(
  values["duel-market-program-id"] || "",
).trim();
const expectedLocalWallet = String(
  values["expected-local-wallet"] || "",
).trim();
const browserEvidenceDir = String(values["browser-evidence-dir"] || "").trim();
const browserPerformanceProfile = resolveFullTopologyBrowserPerformanceProfile(
  values["browser-performance-profile"],
);
const hyperbetAppRuntime = resolveHyperbetAppRuntime(
  values["hyperbet-app-runtime"],
);
const hlsUrl = String(values["hls-url"] || "").trim();
const skipStream = values["skip-stream"] === true;
const skipBetting = values["skip-betting"] === true;
if (browserPerformanceProfile && hyperbetAppRuntime !== "production_preview") {
  throw new Error(
    "Browser performance qualification requires a production_preview Hyperbet app",
  );
}
if (browserPerformanceProfile && skipStream) {
  throw new Error("Browser performance qualification requires the HLS stream");
}
if (browserPerformanceProfile) {
  if (skipBetting) {
    throw new Error(
      "Browser performance qualification requires betting verification",
    );
  }
  for (const [name, value] of [
    ["betting-url", bettingUrl],
    ["hyperbet-api-url", hyperbetApiUrl],
    ["hls-url", hlsUrl],
  ]) {
    let endpoint;
    try {
      endpoint = new URL(value);
    } catch {
      // Invalid or missing endpoints cannot silently omit requested evidence.
    }
    if (
      !endpoint ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error(
        `Browser performance qualification requires a valid ${name} using credential-free HTTP(S)`,
      );
    }
  }
}
if (hyperbetReadOnly && hyperbetLocalTransactions) {
  throw new Error(
    "Hyperbet verification cannot require read-only and local transactions together",
  );
}
if (
  (hyperbetReadOnly || hyperbetLocalTransactions) &&
  (skipBetting || !hyperbetApiUrl)
) {
  throw new Error(
    "Requested Hyperbet browser verification requires enabled betting and a Hyperbet API endpoint",
  );
}
if (
  hyperbetLocalTransactions &&
  (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(solanaRpcUrl) ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(duelMarketProgramId) ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedLocalWallet))
) {
  throw new Error(
    "Local transaction verification requires an owned loopback RPC, duel-market program, and expected wallet",
  );
}
const timeoutMs = Number.parseInt(values["timeout-ms"], 10) || 240_000;
const fightTimeoutMs =
  Number.parseInt(values["fight-timeout-ms"], 10) || 120_000;
const rtmpTimeoutMs = Number.parseInt(values["rtmp-timeout-ms"], 10) || 120_000;
const requiredDestinations = Array.from(
  new Set(
    (values["require-destinations"] || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
);
const pollMs = Number.parseInt(values["poll-ms"], 10) || 2_000;
const verbose = values.verbose === true;

function log(message) {
  console.log(`[duel-verify] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, ms = 4000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, ms = 4000) {
  const response = await fetchWithTimeout(url, ms);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} at ${url}`);
  }
  return response.json();
}

let solanaRpcRequestId = 0;

async function callSolanaRpc(method, params, timeout = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(solanaRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `duel-verify-${++solanaRpcRequestId}`,
        method,
        params,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Solana RPC ${method} returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload?.error) {
      throw new Error(
        `Solana RPC ${method} failed: ${JSON.stringify(payload.error)}`,
      );
    }
    return payload?.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFinalizedSolanaTransaction(signature, checkTimeoutMs) {
  return waitFor(
    "finalized browser-signed Solana transaction",
    async () =>
      callSolanaRpc("getTransaction", [
        signature,
        {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        },
      ]),
    checkTimeoutMs,
  );
}

async function readSolanaAccountOwners(addresses) {
  const result = await callSolanaRpc("getMultipleAccounts", [
    addresses,
    { commitment: "finalized", encoding: "base64" },
  ]);
  const values = Array.isArray(result?.value) ? result.value : [];
  return Object.fromEntries(
    addresses.map((address, index) => [
      address,
      typeof values[index]?.owner === "string" ? values[index].owner : null,
    ]),
  );
}

async function fetchJsonWithRetry(
  label,
  url,
  {
    fetchTimeoutMs = 10_000,
    waitTimeoutMs = 20_000,
    validate = () => true,
  } = {},
) {
  return waitFor(
    label,
    async () => {
      const payload = await fetchJson(url, fetchTimeoutMs);
      return validate(payload) ? payload : null;
    },
    waitTimeoutMs,
  );
}

async function waitFor(label, check, checkTimeoutMs) {
  const deadline = Date.now() + checkTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        log(`OK: ${label}`);
        return value;
      }
      lastError = null;
      if (verbose) {
        log(`waiting: ${label}`);
      }
    } catch (err) {
      lastError = err;
      if (verbose) {
        log(
          `waiting: ${label} (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    await sleep(pollMs);
  }

  const suffix = lastError
    ? ` last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

async function assertHttpOk(label, url, checkTimeoutMs) {
  await waitFor(
    label,
    async () => {
      const response = await fetchWithTimeout(url);
      return response.ok ? response.status : null;
    },
    checkTimeoutMs,
  );
}

async function assertServerAndDatabaseHealthy(url, checkTimeoutMs) {
  return waitFor(
    "server health with checked database",
    async () => {
      const payload = await fetchJson(url);
      const latencyMs = Number(payload?.database?.latencyMs);
      if (
        payload?.status !== "ok" ||
        payload?.database?.healthy !== true ||
        payload?.database?.status !== "healthy" ||
        !Number.isFinite(latencyMs) ||
        latencyMs < 0
      ) {
        return null;
      }
      return payload;
    },
    checkTimeoutMs,
  );
}

async function assertHlsReady(label, url, checkTimeoutMs) {
  await waitFor(
    label,
    async () => {
      const response = await fetchWithTimeout(url);
      if (!response.ok) return null;
      const body = await response.text();
      const hasPlaylist = body.includes("#EXTM3U");
      const hasMediaSegments =
        body.includes("#EXTINF:") ||
        body.includes("#EXT-X-PART:") ||
        /\.ts(?:$|\?)/.test(body) ||
        /\.m4s(?:$|\?)/.test(body);
      return hasPlaylist && hasMediaSegments ? body : null;
    },
    checkTimeoutMs,
  );
}

async function assertHyperbetBackendReady(checkTimeoutMs) {
  if (!hyperbetApiUrl) return null;
  const expectedSourceUrl = `${serverUrl}/api/streaming/state`;
  const status = await waitFor(
    "Hyperbet synchronized backend",
    async () => {
      const payload = await fetchJson(`${hyperbetApiUrl}/status`);
      const stream = payload?.stream;
      const sourceAgeMs = Date.now() - Number(stream?.lastSourcePollAt ?? 0);
      if (
        payload?.service !== "hyperbet-solana-backend" ||
        stream?.sourceUrl !== expectedSourceUrl ||
        stream?.lastSourceError !== null ||
        !Number.isSafeInteger(stream?.seq) ||
        stream.seq < 0 ||
        !Number.isFinite(sourceAgeMs) ||
        sourceAgeMs < 0 ||
        sourceAgeMs > 15_000
      ) {
        return null;
      }
      return payload;
    },
    checkTimeoutMs,
  );
  const matchup = await waitFor(
    "Hyperbet authoritative matchup",
    async () => {
      const proxied = await fetchJson(`${hyperbetApiUrl}/api/streaming/state`);
      const agent1Name = String(proxied?.cycle?.agent1?.name || "").trim();
      const agent2Name = String(proxied?.cycle?.agent2?.name || "").trim();
      if (!agent1Name || !agent2Name) return null;
      return { agentNames: [agent1Name, agent2Name] };
    },
    checkTimeoutMs,
  );
  return { ...status, agentNames: matchup.agentNames };
}

async function ensureLocalBrowserWalletConnected(page, checkTimeoutMs) {
  const prefix = expectedLocalWallet.slice(0, 4);
  const suffix = expectedLocalWallet.slice(-4);
  const isConnected = async () => {
    const walletChips = page.locator(
      ".hm-wallet-btn--linked, .hm-header-mob-wallet-btn--linked",
    );
    const count = await walletChips.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const text = (
        (await walletChips
          .nth(index)
          .textContent()
          .catch(() => "")) || ""
      ).trim();
      if (text.includes(prefix) && text.includes(suffix)) return true;
    }
    return false;
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await isConnected()) return;
    const walletOption = page
      .getByRole("button", { name: /Full Topology Test Wallet/i })
      .first();
    if (await walletOption.isVisible().catch(() => false)) {
      await walletOption.click({ force: true });
      await page.waitForTimeout(500);
      continue;
    }
    const connectButton = page
      .getByRole("button", {
        name: /connect wallet|select wallet|add sol wallet|connect sol/i,
      })
      .first();
    if (await connectButton.isVisible().catch(() => false)) {
      await connectButton.click({ force: true });
    }
    await page.waitForTimeout(500);
  }
  await waitFor(
    "expected local browser wallet connection",
    async () => ((await isConnected()) ? true : null),
    checkTimeoutMs,
  );
}

async function waitForExecutableLocalMarket(checkTimeoutMs) {
  return waitFor(
    "open local market with managed ask liquidity",
    async () => {
      const [status, active] = await Promise.all([
        fetchJson(`${hyperbetApiUrl}/status`),
        fetchJson(`${hyperbetApiUrl}/api/arena/prediction-markets/active`),
      ]);
      const healthMarkets = Array.isArray(status?.bot?.health?.markets)
        ? status.bot.health.markets
        : [];
      const publicMarkets = Array.isArray(active?.markets)
        ? active.markets
        : [];
      const publicMarket = publicMarkets.find(
        (market) =>
          market?.chainKey === "solana" && market?.lifecycleStatus === "OPEN",
      );
      const managedMarket = healthMarkets.find(
        (market) =>
          market?.duelId === active?.duel?.duelId &&
          market?.duelKey === active?.duel?.duelKey &&
          market?.marketRef === publicMarket?.marketRef &&
          market?.lifecycleStatus === "OPEN" &&
          Number.isSafeInteger(market?.askPrice) &&
          market.askPrice > 0 &&
          market.askPrice < 1_000 &&
          Number.isSafeInteger(market?.askUnits) &&
          market.askUnits >= 10_000_000 &&
          Number(market?.openOrderCount) >= 1,
      );
      if (!managedMarket) {
        throw new Error(
          `managed ask unavailable: ${JSON.stringify({
            activeDuel: active?.duel ?? null,
            publicMarkets: publicMarkets.map((market) => ({
              chainKey: market?.chainKey,
              lifecycleStatus: market?.lifecycleStatus,
              marketRef: market?.marketRef,
            })),
            healthMarkets: healthMarkets.map((market) => ({
              duelId: market?.duelId,
              duelKey: market?.duelKey,
              lifecycleStatus: market?.lifecycleStatus,
              marketRef: market?.marketRef,
              askPrice: market?.askPrice,
              askUnits: market?.askUnits,
              openOrderCount: market?.openOrderCount,
              circuitBreakerReason: market?.circuitBreakerReason,
              recovery: market?.recovery,
            })),
          })}`,
        );
      }
      return {
        duelId: managedMarket.duelId,
        duelKey: managedMarket.duelKey,
        marketRef: managedMarket.marketRef,
        askPrice: managedMarket.askPrice,
        askUnits: managedMarket.askUnits,
      };
    },
    checkTimeoutMs,
  );
}

async function captureLocalOrderReadinessFailure(page, market, error) {
  const authoritativeProxyState = hyperbetApiUrl
    ? await fetchJson(`${hyperbetApiUrl}/api/streaming/state`).catch(() => null)
    : null;
  const state = await page.evaluate((expectedMarket) => {
    const bodyText = document.body?.innerText?.trim() ?? "";
    const submit = document.querySelector('[data-testid="prediction-submit"]');
    const amount = document.querySelector(
      '[data-testid="prediction-amount-input"]',
    );
    const price = document.querySelector(
      '[data-testid="solana-clob-price-input"]',
    );
    const appRoot = document.querySelector(".hm-root");
    const walletChips = Array.from(
      document.querySelectorAll(".hm-wallet-btn--linked"),
    ).map((element) => element.textContent?.trim() ?? "");
    const transactionFeedback = Array.from(
      document.querySelectorAll(
        '[data-testid="solana-order-transaction-feedback"]',
      ),
    ).map((element) => ({
      state: element.getAttribute("data-state"),
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));
    return {
      expectedMarket,
      location: window.location.href,
      submit: {
        present: submit instanceof HTMLButtonElement,
        disabled: submit instanceof HTMLButtonElement ? submit.disabled : null,
        text: submit?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      },
      amount:
        amount instanceof HTMLInputElement
          ? { value: amount.value, disabled: amount.disabled }
          : null,
      price:
        price instanceof HTMLInputElement
          ? { value: price.value, disabled: price.disabled }
          : null,
      walletChips,
      localTest: Boolean(
        document.querySelector('[aria-label="Local Solana test environment"]'),
      ),
      liveState:
        document.querySelector(".hm-live-state")?.textContent?.trim() ?? null,
      streamStateEmittedAt: appRoot?.getAttribute(
        "data-stream-state-emitted-at",
      ),
      transactionFeedback,
      bodyPreview: bodyText.slice(0, 4_000),
    };
  }, market);
  let screenshotPath = null;
  let evidencePath = null;
  if (browserEvidenceDir) {
    await fsp.mkdir(browserEvidenceDir, { recursive: true });
    screenshotPath = path.join(
      browserEvidenceDir,
      "hyperbet-local-order-readiness-failure.png",
    );
    evidencePath = path.join(
      browserEvidenceDir,
      "hyperbet-local-order-readiness-failure.json",
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fsp.writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
          state,
          authoritativeProxyState,
          screenshotPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  throw new Error(
    `Local SOL order never became signable: ${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(state)}; evidence=${evidencePath ?? "not-requested"}; screenshot=${screenshotPath ?? "not-requested"}`,
  );
}

async function captureLocalOrderOutcomeFailure(
  page,
  market,
  error,
  trackingResponses,
) {
  const state = await page.evaluate((expectedMarket) => {
    const bodyText = document.body?.innerText?.trim() ?? "";
    const appRoot = document.querySelector(".hm-root");
    const dialog = document.querySelector('[role="dialog"]');
    const transactionFeedback = Array.from(
      document.querySelectorAll(
        '[data-testid="solana-order-transaction-feedback"]',
      ),
    ).map((element) => ({
      state: element.getAttribute("data-state"),
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
      signature:
        element
          .querySelector('[data-testid="solana-order-transaction-signature"]')
          ?.textContent?.trim() ?? null,
    }));
    const controls = Array.from(
      document.querySelectorAll(
        [
          '[data-testid="prediction-tab-buy"]',
          '[data-testid="prediction-select-yes"]',
          '[data-testid="prediction-select-no"]',
          '[data-testid="prediction-amount-input"]',
          '[data-testid="solana-clob-price-input"]',
          '[data-testid="prediction-submit"]',
        ].join(","),
      ),
    ).map((element) => ({
      testId: element.getAttribute("data-testid"),
      disabled:
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement
          ? element.disabled
          : null,
      value: element instanceof HTMLInputElement ? element.value : null,
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));
    return {
      expectedMarket,
      location: window.location.href,
      visibilityState: document.visibilityState,
      root: appRoot
        ? {
            streamCycleId: appRoot.getAttribute("data-stream-cycle-id"),
            streamDuelId: appRoot.getAttribute("data-stream-duel-id"),
            streamDuelKey: appRoot.getAttribute("data-stream-duel-key"),
            marketDuelId: appRoot.getAttribute("data-market-duel-id"),
            marketDuelKey: appRoot.getAttribute("data-market-duel-key"),
            marketMode: appRoot.getAttribute("data-market-mode"),
            marketReason: appRoot.getAttribute("data-market-reason"),
            marketCanPlaceBet: appRoot.getAttribute(
              "data-market-can-place-bet",
            ),
            streamStateEmittedAt: appRoot.getAttribute(
              "data-stream-state-emitted-at",
            ),
          }
        : null,
      dialog: dialog
        ? {
            label:
              dialog.getAttribute("aria-label") ??
              dialog.getAttribute("aria-labelledby"),
            text: dialog.textContent?.replace(/\s+/g, " ").trim() ?? "",
          }
        : null,
      transactionFeedback,
      controls,
      liveState:
        document.querySelector(".hm-live-state")?.textContent?.trim() ?? null,
      bodyPreview: bodyText.slice(0, 8_000),
    };
  }, market);
  const responseEvidence = await Promise.all(
    trackingResponses.map(async (response) => ({
      status: response.status(),
      url: response.url(),
      body: await response
        .text()
        .then((value) => value.slice(0, 2_000))
        .catch(() => null),
    })),
  );
  let screenshotPath = null;
  let evidencePath = null;
  if (browserEvidenceDir) {
    await fsp.mkdir(browserEvidenceDir, { recursive: true });
    screenshotPath = path.join(
      browserEvidenceDir,
      "hyperbet-local-order-outcome-failure.png",
    );
    evidencePath = path.join(
      browserEvidenceDir,
      "hyperbet-local-order-outcome-failure.json",
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fsp.writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
          state,
          trackingResponses: responseEvidence,
          screenshotPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  throw new Error(
    `Local browser order did not reach a terminal state: ${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(state)}; tracking=${JSON.stringify(responseEvidence)}; evidence=${evidencePath ?? "not-requested"}; screenshot=${screenshotPath ?? "not-requested"}`,
  );
}

async function submitAndVerifyLocalBrowserOrder(page, checkTimeoutMs) {
  await ensureLocalBrowserWalletConnected(page, checkTimeoutMs);
  const trackingResponses = [];
  const recordTrackingResponse = (response) => {
    if (!response.url().includes("/api/arena/bet/record-external")) return;
    trackingResponses.push(response);
    if (trackingResponses.length > 128) trackingResponses.shift();
  };
  page.on("response", recordTrackingResponse);

  try {
    for (let quoteAttempt = 0; quoteAttempt < 2; quoteAttempt += 1) {
      const market = await waitForExecutableLocalMarket(checkTimeoutMs);
      try {
        await page.getByTestId("prediction-select-yes").click({ force: true });
        await page.getByTestId("prediction-amount-input").fill("0.01");
        await page
          .getByTestId("solana-clob-price-input")
          .fill(String(market.askPrice));
      } catch (error) {
        await captureLocalOrderReadinessFailure(page, market, error);
      }
      await page
        .waitForFunction(
          () => {
            const button = document.querySelector(
              '[data-testid="prediction-submit"]',
            );
            return button instanceof HTMLButtonElement && !button.disabled;
          },
          undefined,
          { timeout: checkTimeoutMs },
        )
        .catch((error) =>
          captureLocalOrderReadinessFailure(page, market, error),
        );
      await page.getByTestId("prediction-submit").click({ force: true });
      const dialog = page.getByRole("dialog", {
        name: /confirm sol order/i,
      });
      await dialog.waitFor({ state: "visible", timeout: 15_000 });
      const confirmationText = (
        (await dialog.textContent().catch(() => "")) || ""
      ).replace(/\s+/g, " ");
      if (
        !confirmationText.includes("Maximum wallet funding required") ||
        !confirmationText.includes("not automatically resubmitted")
      ) {
        throw new Error(
          "Local SOL confirmation omitted required funding terms",
        );
      }
      const confirmButton = dialog.getByRole("button", {
        name: /confirm and sign/i,
      });
      await confirmButton.waitFor({ state: "visible", timeout: 10_000 });
      if (!(await confirmButton.isEnabled())) {
        throw new Error("Local SOL confirmation never became signable");
      }
      await confirmButton.click();
      await dialog.waitFor({ state: "detached", timeout: 45_000 });

      const feedback = page
        .getByTestId("solana-order-transaction-feedback")
        .first();
      const outcome = await waitFor(
        "browser order confirmation or deterministic rejection",
        async () => {
          const state = await feedback
            .getAttribute("data-state")
            .catch(() => null);
          const text = (
            (await feedback.textContent().catch(() => "")) || ""
          ).replace(/\s+/g, " ");
          if (state === "confirmed") return { state, text };
          if (state === "error" && text) return { state, text };
          return null;
        },
        45_000,
      ).catch((error) =>
        captureLocalOrderOutcomeFailure(page, market, error, trackingResponses),
      );
      if (outcome.state === "error") {
        if (
          quoteAttempt === 0 &&
          /order book or fee terms changed/i.test(outcome.text)
        ) {
          const reviewButton = feedback.getByRole("button", {
            name: /review latest quote/i,
          });
          await reviewButton.click();
          await feedback.waitFor({ state: "detached", timeout: 30_000 });
          continue;
        }
        throw new Error(`Local browser order failed: ${outcome.text}`);
      }

      const signature = (
        (await feedback
          .getByTestId("solana-order-transaction-signature")
          .textContent()) || ""
      ).trim();
      const terminalTrackingResponse = await waitFor(
        "keeper-verified external bet record",
        async () => {
          const response = trackingResponses.find(
            (candidate) =>
              candidate.status() !== 425 && candidate.status() !== 503,
          );
          return response || null;
        },
        75_000,
      );
      const tracking = await terminalTrackingResponse.json();
      if (terminalTrackingResponse.status() !== 200) {
        throw new Error(
          `Keeper rejected the browser order with HTTP ${terminalTrackingResponse.status()}`,
        );
      }

      const rpcTransaction = await waitForFinalizedSolanaTransaction(
        signature,
        checkTimeoutMs,
      );
      const message = rpcTransaction?.transaction?.message;
      const staticAccountKeys = Array.isArray(message?.accountKeys)
        ? message.accountKeys.map((entry) =>
            typeof entry === "string" ? entry : String(entry?.pubkey || ""),
          )
        : [];
      const loadedAddresses = [
        ...(rpcTransaction?.meta?.loadedAddresses?.writable || []),
        ...(rpcTransaction?.meta?.loadedAddresses?.readonly || []),
      ].map((entry) => String(entry));
      const accountKeys = [...staticAccountKeys, ...loadedAddresses];
      const transactionSignature = String(
        rpcTransaction?.transaction?.signatures?.[0] || "",
      );
      const accountOwners = await readSolanaAccountOwners(accountKeys);
      const marketState = new PublicKey(market.marketRef);
      const program = new PublicKey(duelMarketProgramId);
      const vault = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), marketState.toBuffer()],
        program,
      )[0].toBase58();
      const accountingEvidence = {
        signature,
        wallet: expectedLocalWallet,
        marketRef: market.marketRef,
        vault,
        programId: duelMarketProgramId,
        accountOwners,
        transaction: {
          signature: transactionSignature,
          slot: rpcTransaction?.slot,
          error: rpcTransaction?.meta?.err ?? null,
          feeLamports: rpcTransaction?.meta?.fee,
          accountKeys,
          preBalances: rpcTransaction?.meta?.preBalances,
          postBalances: rpcTransaction?.meta?.postBalances,
          instructions: message?.instructions,
          logMessages: rpcTransaction?.meta?.logMessages,
        },
        tracking,
      };
      let verified;
      try {
        verified = validateLocalSolanaBrowserOrderEvidence(accountingEvidence);
      } catch (error) {
        let evidencePath = null;
        if (browserEvidenceDir) {
          await fsp.mkdir(browserEvidenceDir, { recursive: true });
          evidencePath = path.join(
            browserEvidenceDir,
            "hyperbet-local-order-accounting-failure.json",
          );
          await fsp.writeFile(
            evidencePath,
            `${JSON.stringify(accountingEvidence, null, 2)}\n`,
            "utf8",
          );
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; accountingEvidence=${evidencePath ?? "not-requested"}`,
        );
      }
      log(
        `OK: matched browser SOL order ${verified.signature} market=${verified.marketRef} walletDebit=${verified.walletDebitLamports}`,
      );
      return {
        ...verified,
        duelId: market.duelId,
        duelKey: market.duelKey,
        limitPriceMillis: market.askPrice,
        requestedAmountLamports: "10000000",
        keeperPointsAwarded: Number(tracking?.pointsAwarded || 0),
      };
    }
    throw new Error("Refreshed local SOL quote did not remain stable");
  } finally {
    page.off("response", recordTrackingResponse);
  }
}

function cdpMetricValue(metrics, name) {
  return (
    (Array.isArray(metrics) ? metrics : []).find(
      (metric) => metric?.name === name,
    )?.value ?? Number.NaN
  );
}

async function installBrowserPerformanceObservers(page) {
  await page.addInitScript(installBrowserResourceTransferObserver, {
    windowDurationMs: browserPerformanceProfile.sampleDurationMs,
  });
  await page.addInitScript(() => {
    const state = {
      firstVideoFrameMs: 0,
      firstVideoFrameTransfers: null,
      lcpMs: 0,
      lcpObserverSupported: false,
      longTaskObserverSupported: false,
      longTasks: [],
    };
    Object.defineProperty(globalThis, "__hyperiaBrowserPerformance", {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.lcpMs = Math.max(state.lcpMs, entry.startTime);
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
      state.lcpObserverSupported = true;
    } catch {
      // The fail-closed policy rejects an unavailable LCP observer.
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push(entry.duration);
        }
      }).observe({ type: "longtask", buffered: true });
      state.longTaskObserverSupported = true;
    } catch {
      // The fail-closed policy rejects an unavailable long-task observer.
    }

    const observedVideos = new WeakSet();
    const watchVideo = (video) => {
      if (observedVideos.has(video)) return;
      observedVideos.add(video);
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => {
          if (state.firstVideoFrameMs <= 0) {
            state.firstVideoFrameMs = performance.now();
            state.firstVideoFrameTransfers =
              globalThis.__hyperiaResourceTransfers();
          }
        });
        return;
      }
      video.addEventListener(
        "loadeddata",
        () => {
          if (state.firstVideoFrameMs <= 0) {
            state.firstVideoFrameMs = performance.now();
            state.firstVideoFrameTransfers =
              globalThis.__hyperiaResourceTransfers();
          }
        },
        { once: true },
      );
    };
    const discoverVideos = () => {
      for (const video of document.querySelectorAll("video")) watchVideo(video);
    };
    const startDiscovery = () => {
      discoverVideos();
      if (document.documentElement) {
        new MutationObserver(discoverVideos).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }
    };
    if (document.documentElement) startDiscovery();
    else {
      globalThis.addEventListener("DOMContentLoaded", startDiscovery, {
        once: true,
      });
    }
  });
}

async function measureFullTopologyTabInteraction(page, name) {
  const startedAt = await page.evaluate(() => performance.now());
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await page.waitForFunction(
    (element) => element?.getAttribute("aria-selected") === "true",
    await tab.elementHandle(),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  );
  return (await page.evaluate(() => performance.now())) - startedAt;
}

async function captureFullTopologyBrowserPerformance({
  page,
  cdp,
  profile,
  expectedDocumentTimeOrigin,
}) {
  const readTransferredBytes = () =>
    page.evaluate(readBrowserResourceTransfers);
  const video = page.locator("video").first();
  const dimensions = await video.evaluate((element) => ({
    height: element.videoHeight,
    width: element.videoWidth,
  }));
  if (
    dimensions.width !== profile.expectedVideo.width ||
    dimensions.height !== profile.expectedVideo.height
  ) {
    throw new Error(
      `Full-topology video dimensions ${dimensions.width}x${dimensions.height} do not match ${profile.expectedVideo.width}x${profile.expectedVideo.height}`,
    );
  }

  const interactionDurations = [];
  for (const tabName of ["Agents", "Trades", "Match Log"]) {
    interactionDurations.push(
      await measureFullTopologyTabInteraction(page, tabName),
    );
  }

  const qualityBefore = await video.evaluate((element) => {
    const quality = element.getVideoPlaybackQuality();
    return {
      droppedVideoFrames: quality.droppedVideoFrames,
      totalVideoFrames: quality.totalVideoFrames,
    };
  });
  const transferredBytesBefore = await readTransferredBytes();
  const cdpBefore = await cdp.send("Performance.getMetrics");
  const frameSample = await video.evaluate(
    (element, durationMs) =>
      new Promise((resolve) => {
        const startedAt = performance.now();
        const startedMediaTime = element.currentTime;
        if (typeof element.requestVideoFrameCallback !== "function") {
          setTimeout(
            () =>
              resolve({
                elapsedMs: performance.now() - startedAt,
                frameCallbacksSupported: false,
                mediaAdvanceSeconds: element.currentTime - startedMediaTime,
                presentedFrames: 0,
              }),
            durationMs,
          );
          return;
        }
        let callbackHandle = 0;
        let presentedFrames = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (typeof element.cancelVideoFrameCallback === "function") {
            element.cancelVideoFrameCallback(callbackHandle);
          }
          resolve({
            elapsedMs: performance.now() - startedAt,
            frameCallbacksSupported: true,
            mediaAdvanceSeconds: element.currentTime - startedMediaTime,
            presentedFrames,
          });
        };
        const onFrame = () => {
          if (settled) return;
          presentedFrames += 1;
          callbackHandle = element.requestVideoFrameCallback(onFrame);
        };
        callbackHandle = element.requestVideoFrameCallback(onFrame);
        setTimeout(finish, durationMs);
      }),
    profile.sampleDurationMs,
  );
  const cdpAfter = await cdp.send("Performance.getMetrics");
  const qualityAfter = await video.evaluate((element) => {
    const quality = element.getVideoPlaybackQuality();
    return {
      droppedVideoFrames: quality.droppedVideoFrames,
      totalVideoFrames: quality.totalVideoFrames,
    };
  });
  const browserState = await page.evaluate(
    () => globalThis.__hyperiaBrowserPerformance,
  );
  const clientEnvironment = await page.evaluate(() => {
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    );
    return {
      devicePixelRatio,
      documentTimeOrigin: performance.timeOrigin,
      documentWidth,
      hardwareConcurrency: navigator.hardwareConcurrency,
      horizontalOverflowPx: Math.max(0, documentWidth - innerWidth),
      userAgent: navigator.userAgent,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
    };
  });
  const transferredBytesAfter = await readTransferredBytes();
  const sampleDurationSeconds = Math.max(1, frameSample.elapsedMs) / 1_000;
  const totalVideoFrames = Math.max(
    0,
    qualityAfter.totalVideoFrames - qualityBefore.totalVideoFrames,
  );
  const droppedFrames = Math.max(
    0,
    qualityAfter.droppedVideoFrames - qualityBefore.droppedVideoFrames,
  );
  const qualityPresentedFrames = Math.max(0, totalVideoFrames - droppedFrames);
  const delta = (name) =>
    Math.max(
      0,
      cdpMetricValue(cdpAfter.metrics, name) -
        cdpMetricValue(cdpBefore.metrics, name),
    );
  const metrics = {
    runtime: hyperbetAppRuntime,
    lcpObserverSupported: browserState.lcpObserverSupported,
    longTaskObserverSupported: browserState.longTaskObserverSupported,
    lcpMs: browserState.lcpMs,
    firstDecodedFrameMs: browserState.firstVideoFrameMs,
    maxInteractionMs: Math.max(...interactionDurations),
    presentedFps: frameSample.frameCallbacksSupported
      ? frameSample.presentedFrames / sampleDurationSeconds
      : Number.NaN,
    qualityPresentedFps: qualityPresentedFrames / sampleDurationSeconds,
    droppedFrameRatio:
      totalVideoFrames > 0 ? droppedFrames / totalVideoFrames : Number.NaN,
    jsHeapUsedBytes: cdpMetricValue(cdpAfter.metrics, "JSHeapUsedSize"),
    maxLongTaskMs: Math.max(0, ...browserState.longTasks),
    totalLongTaskMs: browserState.longTasks.reduce(
      (total, duration) => total + duration,
      0,
    ),
    taskUtilization: delta("TaskDuration") / sampleDurationSeconds,
    scriptUtilization: delta("ScriptDuration") / sampleDurationSeconds,
    layoutUtilization:
      (delta("LayoutDuration") + delta("RecalcStyleDuration")) /
      sampleDurationSeconds,
    horizontalOverflowPx: clientEnvironment.horizontalOverflowPx,
    resourceTimingObserverSupported: transferredBytesAfter.observerSupported,
    resourceTimingDroppedEntries: transferredBytesAfter.observerDroppedEntries,
    resourceTimingInvalidEntries: transferredBytesAfter.invalidResourceCount,
    resourceTimingWindowOverflowCount:
      transferredBytesAfter.windowOverflowCount,
    mediaTransferWindowDurationMs: transferredBytesAfter.windowDurationMs,
    resourceSampleDurationMs:
      transferredBytesAfter.snapshotAtMs - transferredBytesBefore.snapshotAtMs,
    documentContinuityVerified:
      Number.isFinite(expectedDocumentTimeOrigin) &&
      clientEnvironment.documentTimeOrigin === expectedDocumentTimeOrigin,
    maximumRollingMediaTransferredBytes:
      transferredBytesAfter.maximumMediaWindow.transferBytes,
    nonMediaTransferredBytes: transferredBytesAfter.nonMedia,
    mediaTransferredBytes: Math.max(
      0,
      transferredBytesAfter.media - transferredBytesBefore.media,
    ),
    startupMediaSegmentTransferredBytes:
      browserState.firstVideoFrameTransfers?.segments.transferBytes,
    startupMediaSegmentEncodedBodyBytes:
      browserState.firstVideoFrameTransfers?.segments.encodedBodyBytes,
    startupMediaSegmentResourceCount:
      browserState.firstVideoFrameTransfers?.segments.resourceCount,
    sampleMediaSegmentTransferredBytes:
      transferredBytesAfter.segments.transferBytes -
      transferredBytesBefore.segments.transferBytes,
    sampleMediaSegmentEncodedBodyBytes:
      transferredBytesAfter.segments.encodedBodyBytes -
      transferredBytesBefore.segments.encodedBodyBytes,
    sampleMediaSegmentResourceCount:
      transferredBytesAfter.segments.resourceCount -
      transferredBytesBefore.segments.resourceCount,
  };
  const violations = evaluateFullTopologyBrowserPerformance(metrics);
  return {
    schemaVersion: 3,
    profile: profile.name,
    browser: await cdp.send("Browser.getVersion"),
    budgets: FULL_TOPOLOGY_BROWSER_PERFORMANCE_BUDGET,
    clientEnvironment,
    emulation: {
      connectionType: profile.connectionType,
      cpuThrottlingRate: profile.cpuThrottlingRate,
      downloadBitsPerSecond: profile.downloadBitsPerSecond,
      latencyMs: profile.latencyMs,
      uploadBitsPerSecond: profile.uploadBitsPerSecond,
    },
    interactionDurations,
    transfers: {
      accounting:
        "completed-resource observer delivery in the current document, from initialization through sample end, including any exercised wallet workflow; navigation-document bytes are excluded",
      startup: {
        startMs: 0,
        endMs: browserState.firstVideoFrameMs,
        totals: browserState.firstVideoFrameTransfers,
      },
      sampleWindow: {
        startMs: transferredBytesBefore.snapshotAtMs,
        endMs: transferredBytesAfter.snapshotAtMs,
      },
      afterSample: transferredBytesAfter,
      beforeSample: transferredBytesBefore,
      mediaDuringSample: metrics.mediaTransferredBytes,
    },
    metrics,
    playback: {
      droppedFrames,
      mediaAdvanceSeconds: frameSample.mediaAdvanceSeconds,
      qualityPresentedFrames,
      requestVideoFrameCallbackFrames: frameSample.presentedFrames,
      requestVideoFrameCallbackSupported: frameSample.frameCallbacksSupported,
      sampleDurationMs: frameSample.elapsedMs,
      totalVideoFrames,
    },
    verdict: { passed: violations.length === 0, violations },
  };
}

async function observeHyperbetLiveFight(page, timeoutMs) {
  const handle = await page.waitForFunction(
    (expectedHlsUrl) => {
      const bodyText = document.body?.innerText ?? "";
      const appRoot = document.querySelector(".hm-root");
      const video = document.querySelector("video");
      const liveState =
        document.querySelector(".hm-live-state")?.textContent?.trim() ?? null;
      const currentSource = video?.currentSrc || video?.src || "";
      const declaredSource = video?.dataset.streamSource || "";
      if (
        liveState !== "LIVE" ||
        !appRoot ||
        !video ||
        video.paused ||
        video.readyState < 2 ||
        Number(video.currentTime) <= 0 ||
        !declaredSource.startsWith(expectedHlsUrl) ||
        !(
          currentSource.startsWith("blob:") ||
          currentSource.startsWith(expectedHlsUrl)
        ) ||
        /live match data temporarily unavailable|live arena view temporarily unavailable|waiting for stream/i.test(
          bodyText,
        )
      ) {
        return null;
      }
      return {
        liveState,
        cycleId: appRoot.getAttribute("data-stream-cycle-id"),
        duelId: appRoot.getAttribute("data-stream-duel-id"),
        duelKey: appRoot.getAttribute("data-stream-duel-key"),
        streamStateEmittedAt: Number(
          appRoot.getAttribute("data-stream-state-emitted-at"),
        ),
        observedAtMs: Date.now(),
        video: {
          currentSource,
          declaredSource,
          currentTime: Number(video.currentTime),
          readyState: video.readyState,
          paused: video.paused,
        },
      };
    },
    hlsUrl,
    { timeout: timeoutMs },
  );
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

async function assertHyperbetBrowserReady(
  checkTimeoutMs,
  expectedAgentNames = [],
) {
  if (skipBetting || !hyperbetApiUrl) return null;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const consoleIssues = [];
  const pageErrors = [];
  const networkFailures = [];
  const networkFailureDetails = [];
  try {
    const page = await browser.newPage({
      viewport: browserPerformanceProfile?.viewport || {
        width: 1280,
        height: 720,
      },
    });
    let performanceCdp = null;
    if (browserPerformanceProfile) {
      await installBrowserPerformanceObservers(page);
      performanceCdp = await page.context().newCDPSession(page);
      await performanceCdp.send("Network.enable");
      await performanceCdp.send("Network.setCacheDisabled", {
        cacheDisabled: true,
      });
      await performanceCdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: browserPerformanceProfile.latencyMs,
        downloadThroughput: browserPerformanceProfile.downloadBitsPerSecond / 8,
        uploadThroughput: browserPerformanceProfile.uploadBitsPerSecond / 8,
        connectionType: browserPerformanceProfile.connectionType,
      });
      await performanceCdp.send("Emulation.setCPUThrottlingRate", {
        rate: browserPerformanceProfile.cpuThrottlingRate,
      });
      await performanceCdp.send("Performance.enable");
    }
    page.on("console", (message) => {
      if (!["error", "warning"].includes(message.type())) return;
      const expectedTrackingRetryConsole =
        hyperbetLocalTransactions &&
        /Failed to load resource:.*status of (?:425|503)\b/i.test(
          message.text(),
        );
      // The response listener below identifies the exact retry endpoint and
      // still fails every unrelated 4xx/5xx. Chromium's generic console line
      // omits the URL, so suppress only these expected retry status messages.
      if (!expectedTrackingRetryConsole) {
        consoleIssues.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const expectedTrackingRetry =
        response.url().includes("/api/arena/bet/record-external") &&
        (response.status() === 425 || response.status() === 503);
      if (response.status() >= 400 && !expectedTrackingRetry) {
        const failure = `${response.status()} ${response.url()}`;
        networkFailures.push(failure);
        if (new URL(response.url()).pathname === "/ready") {
          networkFailureDetails.push(
            response
              .json()
              .then((payload) => {
                const readiness = payload?.readiness;
                return `${failure} reasons=${JSON.stringify(readiness?.reasons ?? null)} agesMs=${JSON.stringify(readiness?.agesMs ?? null)}`;
              })
              .catch(() => failure),
          );
        }
      }
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText || "request failed";
      if (!failure.includes("ERR_ABORTED")) {
        networkFailures.push(`${failure} ${request.url()}`);
      }
    });

    await page.goto(bettingUrl, {
      waitUntil: "domcontentloaded",
      timeout: checkTimeoutMs,
    });
    const initialDocumentTimeOrigin = await page.evaluate(
      () => performance.timeOrigin,
    );
    const liveFightObservationTask =
      hyperbetLocalTransactions && !skipStream
        ? observeHyperbetLiveFight(page, checkTimeoutMs)
            .then((observation) => ({ observation, error: null }))
            .catch((error) => ({
              observation: null,
              error: error instanceof Error ? error.message : String(error),
            }))
        : null;
    const browserTransaction = hyperbetLocalTransactions
      ? await submitAndVerifyLocalBrowserOrder(page, checkTimeoutMs)
      : null;
    let liveFightObservation = null;
    if (browserTransaction && liveFightObservationTask) {
      const observed = await liveFightObservationTask;
      if (!observed.observation) {
        throw new Error(
          `Hyperbet browser did not observe the signed order's live fight: ${observed.error ?? "unknown observation failure"}`,
        );
      }
      liveFightObservation = validateHyperbetLiveFightObservation({
        expectedHlsUrl: hlsUrl,
        observation: observed.observation,
        transaction: browserTransaction,
      });
    }
    await page
      .waitForFunction(
        ({
          apiUrl,
          expectedHlsUrl,
          expectedAgents,
          requireReadOnly,
          requireLocalTransactions,
          requireStream,
          priorLiveFightObserved,
        }) => {
          const bodyText = document.body?.innerText?.trim() ?? "";
          const normalizedBodyText = bodyText.toLowerCase();
          const video = document.querySelector("video");
          const source = video?.currentSrc || video?.src || "";
          const declaredSource = video?.dataset.streamSource || "";
          const appRoot = document.querySelector(".hm-root");
          const streamedStateEmittedAt = Number(
            appRoot?.getAttribute("data-stream-state-emitted-at"),
          );
          const overlay = document.querySelector(
            "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
          );
          const backendObserved = performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.startsWith(`${apiUrl}/api/streaming/`));
          const backendStateObserved =
            backendObserved ||
            (Number.isFinite(streamedStateEmittedAt) &&
              streamedStateEmittedAt > 0);
          const readOnlyLabel = document.querySelector(
            '[aria-label="Read-only spectator mode"]',
          );
          const localTestLabel = document.querySelector(
            '[aria-label="Local Solana test environment"]',
          );
          const transactionControl = document.querySelector(
            [
              '[data-testid="prediction-tab-buy"]',
              '[data-testid="prediction-amount-input"]',
              '[data-testid="prediction-submit"]',
              '[data-testid="solana-clob-price-input"]',
              '[data-testid="solana-clob-admin-toggle"]',
            ].join(","),
          );
          const agentNamesVisible = expectedAgents.every((name) =>
            normalizedBodyText.includes(name.toLowerCase()),
          );
          const walletCallToAction =
            /connect\s+(?:your\s+)?wallet|wallet\s+(?:to\s+)?connect/i.test(
              bodyText,
            );
          const liveAuthority =
            document.querySelector(".hm-live-state")?.textContent?.trim() ===
              "LIVE" &&
            !/live match data temporarily unavailable|live arena view temporarily unavailable|waiting for stream/i.test(
              bodyText,
            );
          return Boolean(
            bodyText.length > 100 &&
            !overlay &&
            backendStateObserved &&
            (!requireStream ||
              (video &&
                video.readyState >= 2 &&
                !video.paused &&
                declaredSource.startsWith(expectedHlsUrl) &&
                (source.startsWith("blob:") ||
                  source.startsWith(expectedHlsUrl)))) &&
            agentNamesVisible &&
            (!requireReadOnly ||
              (readOnlyLabel && !transactionControl && !walletCallToAction)) &&
            (!requireLocalTransactions ||
              (localTestLabel &&
                !readOnlyLabel &&
                (liveAuthority || priorLiveFightObserved))),
          );
        },
        {
          apiUrl: hyperbetApiUrl,
          expectedHlsUrl: hlsUrl,
          expectedAgents: expectedAgentNames,
          requireReadOnly: hyperbetReadOnly,
          requireLocalTransactions: hyperbetLocalTransactions,
          requireStream: !skipStream,
          priorLiveFightObserved: liveFightObservation !== null,
        },
        { timeout: checkTimeoutMs },
      )
      .catch(async (error) => {
        const detailedNetworkFailures = await Promise.all(
          networkFailureDetails,
        );
        const browserState = await page.evaluate(() => {
          const bodyText = document.body?.innerText?.trim() ?? "";
          const video = document.querySelector("video");
          const appRoot = document.querySelector(".hm-root");
          return {
            bodyPreview: bodyText.slice(0, 500),
            overlay: Boolean(
              document.querySelector(
                "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
              ),
            ),
            readOnly: Boolean(
              document.querySelector('[aria-label="Read-only spectator mode"]'),
            ),
            localTest: Boolean(
              document.querySelector(
                '[aria-label="Local Solana test environment"]',
              ),
            ),
            transactionControls: document.querySelectorAll(
              [
                '[data-testid="prediction-tab-buy"]',
                '[data-testid="prediction-amount-input"]',
                '[data-testid="prediction-submit"]',
                '[data-testid="solana-clob-price-input"]',
                '[data-testid="solana-clob-admin-toggle"]',
              ].join(","),
            ).length,
            liveState:
              document.querySelector(".hm-live-state")?.textContent?.trim() ??
              null,
            root: appRoot
              ? {
                  cycleId: appRoot.getAttribute("data-stream-cycle-id"),
                  duelId: appRoot.getAttribute("data-stream-duel-id"),
                  duelKey: appRoot.getAttribute("data-stream-duel-key"),
                  marketDuelId: appRoot.getAttribute("data-market-duel-id"),
                  marketDuelKey: appRoot.getAttribute("data-market-duel-key"),
                  marketMode: appRoot.getAttribute("data-market-mode"),
                  marketReason: appRoot.getAttribute("data-market-reason"),
                }
              : null,
            currentSrc: video?.currentSrc || video?.src || "",
            declaredSource: video?.dataset.streamSource || "",
            readyState: video?.readyState ?? null,
            paused: video?.paused ?? null,
            currentTime: video ? Number(video.currentTime) : null,
            streamStateEmittedAt: Number(
              appRoot?.getAttribute("data-stream-state-emitted-at"),
            ),
          };
        });
        throw new Error(
          `Hyperbet browser readiness failed: ${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(browserState)}; liveFight=${JSON.stringify(liveFightObservation)}; transaction=${JSON.stringify(browserTransaction)}; console=${JSON.stringify(consoleIssues)}; network=${JSON.stringify([...networkFailures, ...detailedNetworkFailures])}`,
        );
      });

    let videoEvidence = { checked: false };
    if (!skipStream) {
      const startTime = await page
        .locator("video")
        .evaluate((video) => Number(video.currentTime));
      await page.waitForFunction(
        (start) => {
          const video = document.querySelector("video");
          return Boolean(
            video &&
            !video.paused &&
            video.readyState >= 2 &&
            Number(video.currentTime) >= start + 1,
          );
        },
        startTime,
        { timeout: Math.min(checkTimeoutMs, 20_000) },
      );
      videoEvidence = await page.locator("video").evaluate((video) => ({
        checked: true,
        currentSrc: video.currentSrc || video.src,
        declaredSource: video.dataset.streamSource || "",
        currentTime: Number(video.currentTime),
        readyState: video.readyState,
        paused: video.paused,
      }));
    }
    const browserPerformance = browserPerformanceProfile
      ? await captureFullTopologyBrowserPerformance({
          page,
          cdp: performanceCdp,
          profile: browserPerformanceProfile,
          expectedDocumentTimeOrigin: initialDocumentTimeOrigin,
        })
      : null;
    let screenshotEvidence = null;
    if (browserEvidenceDir) {
      if (hyperbetLocalTransactions) {
        await page.waitForFunction(
          () => {
            const bodyText = document.body?.innerText ?? "";
            return Boolean(
              document.querySelector(".hm-live-state")?.textContent?.trim() ===
                "LIVE" &&
              !/live match data temporarily unavailable|live arena view temporarily unavailable|waiting for stream/i.test(
                bodyText,
              ),
            );
          },
          undefined,
          { timeout: Math.max(checkTimeoutMs, 240_000) },
        );
      }
      await fsp.mkdir(browserEvidenceDir, { recursive: true });
      const screenshotPath = path.join(
        browserEvidenceDir,
        "hyperbet-full-topology.png",
      );
      const screenshot = await page.screenshot({
        path: screenshotPath,
        fullPage: true,
      });
      await fsp.chmod(screenshotPath, 0o600);
      screenshotEvidence = {
        path: screenshotPath,
        sha256: createHash("sha256").update(screenshot).digest("hex"),
        width: 1280,
        viewportHeight: 720,
      };
      if (browserPerformance) {
        const performanceEvidencePath = path.join(
          browserEvidenceDir,
          "hyperbet-full-topology-browser-performance.json",
        );
        await fsp.writeFile(
          performanceEvidencePath,
          `${JSON.stringify(browserPerformance, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      }
    }
    const evidence = {
      ...videoEvidence,
      expectedAgentNames,
      readOnly: hyperbetReadOnly,
      localTransactions: hyperbetLocalTransactions,
      transaction: browserTransaction,
      liveFight: liveFightObservation,
      screenshot: screenshotEvidence,
      performance: browserPerformance,
    };
    const detailedNetworkFailures = await Promise.all(networkFailureDetails);
    if (
      pageErrors.length > 0 ||
      consoleIssues.length > 0 ||
      networkFailures.length > 0
    ) {
      throw new Error(
        `Hyperbet browser emitted runtime failures: ${[
          ...pageErrors,
          ...consoleIssues,
          ...networkFailures,
          ...detailedNetworkFailures,
        ].join(" | ")}`,
      );
    }
    if (browserPerformance && !browserPerformance.verdict.passed) {
      throw new Error(
        `Hyperbet full-topology browser performance failed: ${browserPerformance.verdict.violations.join(" | ")}`,
      );
    }
    log(
      skipStream
        ? "OK: Hyperbet browser backend and market controls (stream checks skipped)"
        : "OK: Hyperbet browser backend, market controls, and advancing HLS",
    );
    return evidence;
  } finally {
    await browser.close();
  }
}

function getAgentPair(context) {
  const agent1 = context?.cycle?.agent1 ?? null;
  const agent2 = context?.cycle?.agent2 ?? null;
  if (!agent1?.id || !agent2?.id) return null;
  return { agent1, agent2 };
}

function getDestinationNames(status) {
  if (!Array.isArray(status?.destinations)) return [];
  return status.destinations
    .map((dest) => String(dest?.name || "").trim())
    .filter(Boolean);
}

function hasRequiredDestinations(status, required) {
  if (required.length === 0) return true;
  const available = getDestinationNames(status).map((name) =>
    name.toLowerCase(),
  );
  return required.every((requiredName) =>
    available.some(
      (candidate) =>
        candidate === requiredName ||
        candidate.includes(requiredName) ||
        requiredName.includes(candidate),
    ),
  );
}

function resolveCanonicalPublicUrl(value, baseUrl) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("canonical stream source URL is missing");
  }
  try {
    return new URL(normalized, `${baseUrl.replace(/\/$/, "")}/`).toString();
  } catch {
    throw new Error(`canonical stream source URL is invalid: ${normalized}`);
  }
}

async function assertCanonicalStreamConfiguration(checkTimeoutMs) {
  const configuration = await fetchJsonWithRetry(
    "canonical stream configuration",
    `${serverUrl}/api/streaming/config`,
    {
      waitTimeoutMs: checkTimeoutMs,
      validate: (payload) =>
        typeof payload?.canonicalPlatform === "string" &&
        typeof payload?.canonicalSourceUrl === "string",
    },
  );
  const actualUrl = resolveCanonicalPublicUrl(
    configuration.canonicalSourceUrl,
    serverUrl,
  );
  const expectedUrl = hlsUrl
    ? resolveCanonicalPublicUrl(hlsUrl, serverUrl)
    : null;
  if (expectedUrl && configuration.canonicalPlatform !== "hls") {
    throw new Error(
      `canonical stream platform mismatch: expected hls, received ${configuration.canonicalPlatform}`,
    );
  }
  if (expectedUrl && actualUrl !== expectedUrl) {
    throw new Error(
      `canonical stream source mismatch: expected ${expectedUrl}, received ${actualUrl}`,
    );
  }
  return {
    platform: configuration.canonicalPlatform,
    sourceUrl: actualUrl,
    publicDelayMs: configuration.publicDelayMs,
  };
}

async function verify() {
  log("starting duel stack verification");

  if (skipStream && requiredDestinations.length > 0) {
    throw new Error(
      "--skip-stream cannot be combined with --require-destinations",
    );
  }

  const serverHealth = await assertServerAndDatabaseHealthy(
    `${serverUrl}/health`,
    timeoutMs,
  );
  await assertHttpOk(
    "streaming state",
    `${serverUrl}/api/streaming/state`,
    timeoutMs,
  );
  const canonicalStream = await assertCanonicalStreamConfiguration(timeoutMs);
  await assertHttpOk("client page", `${clientUrl}/`, timeoutMs);
  if (!skipBetting) {
    await assertHttpOk("betting app", `${bettingUrl}/`, timeoutMs);
  } else {
    log("skipping betting app readiness check (--skip-betting)");
  }
  const hyperbetBackend = await assertHyperbetBackendReady(timeoutMs);
  const browserReadinessTimeoutMs = hyperbetLocalTransactions
    ? Math.min(timeoutMs, 180_000)
    : Math.min(timeoutMs, 60_000);
  const hyperbetBrowser = await assertHyperbetBrowserReady(
    browserReadinessTimeoutMs,
    hyperbetBackend?.agentNames ?? [],
  );

  const duelContextUrl = `${serverUrl}/api/streaming/duel-context`;
  const contestants = await waitFor(
    "streaming duel contestants",
    async () => {
      const context = await fetchJson(duelContextUrl);
      const pair = getAgentPair(context);
      if (!pair) return null;
      return { context, pair };
    },
    timeoutMs,
  );

  const { pair } = contestants;
  const agent1Id = pair.agent1.id;
  const agent2Id = pair.agent2.id;

  const fighting = await waitFor(
    "fighting phase",
    async () => {
      const context = await fetchJson(duelContextUrl);
      const currentPair = getAgentPair(context);
      if (!currentPair) return null;
      if (context?.cycle?.phase !== "FIGHTING") return null;
      return { context, pair: currentPair };
    },
    timeoutMs,
  );

  const statusUrl = `${serverUrl}/api/streaming/rtmp/status`;
  const fightingCycleId = String(fighting.context?.cycle?.cycleId || "");
  const expectedFightingAgentCount = [
    fighting.pair.agent1,
    fighting.pair.agent2,
  ].filter(
    (agent) => typeof agent?.id === "string" && agent.id.length > 0,
  ).length;
  const equipmentVisualEvidence = skipStream
    ? {
        checked: false,
        note: "stream equipment verification explicitly skipped",
      }
    : await waitFor(
        "non-vacuous fitted equipment for every fighting contestant",
        async () => {
          const [status, context] = await Promise.all([
            fetchJson(statusUrl),
            fetchJson(duelContextUrl),
          ]);
          if (
            context?.cycle?.phase !== "FIGHTING" ||
            context?.cycle?.cycleId !== fightingCycleId
          ) {
            return null;
          }
          return getNonVacuousFightingEquipmentEvidence(status, {
            cycleId: fightingCycleId,
            expectedAgentCount: expectedFightingAgentCount,
          });
        },
        Math.min(timeoutMs, fightTimeoutMs),
      );

  const audioEvidence = skipStream
    ? {
        checked: false,
        note: "stream audio verification explicitly skipped",
      }
    : await waitFor(
        "healthy browser game-master audio",
        async () => getHealthyBrowserAudioEvidence(await fetchJson(statusUrl)),
        rtmpTimeoutMs,
      );

  const initialHpA = Number(fighting.pair.agent1.hp ?? 0);
  const initialHpB = Number(fighting.pair.agent2.hp ?? 0);

  const combatEvidence = await waitFor(
    "combat evidence (HP drop or damage)",
    async () => {
      const context = await fetchJson(duelContextUrl);
      const currentPair = getAgentPair(context);
      if (!currentPair) return null;

      const hpA = Number(currentPair.agent1.hp ?? 0);
      const hpB = Number(currentPair.agent2.hp ?? 0);
      const dmgA = Number(currentPair.agent1.damageDealtThisFight ?? 0);
      const dmgB = Number(currentPair.agent2.damageDealtThisFight ?? 0);

      const hpDropped = hpA < initialHpA || hpB < initialHpB;
      const damageRecorded = dmgA > 0 || dmgB > 0;
      if (!hpDropped && !damageRecorded) {
        return null;
      }

      return {
        hpDropped,
        damageRecorded,
        hpA,
        hpB,
        dmgA,
        dmgB,
      };
    },
    fightTimeoutMs,
  );

  let rtmpEvidence = skipStream
    ? {
        checked: false,
        bytesReceived: null,
        note: "stream verification explicitly skipped",
      }
    : {
        checked: false,
        bytesReceived: null,
        note: "status unavailable",
      };
  let requiredDestinationNames = [];
  if (!skipStream && requiredDestinations.length > 0) {
    const status = await waitFor(
      `required RTMP destinations (${requiredDestinations.join(", ")})`,
      async () => {
        const next = await fetchJson(statusUrl);
        return hasRequiredDestinations(next, requiredDestinations)
          ? next
          : null;
      },
      rtmpTimeoutMs,
    );
    requiredDestinationNames = getDestinationNames(status);
  }

  if (!skipStream) {
    try {
      rtmpEvidence.checked = true;
      const requireRtmpTraffic = requiredDestinations.length > 0;
      const initial = await fetchJson(statusUrl);
      const initialBytes = Number(initial?.stats?.bytesReceived ?? 0);
      const bridgeActive = Boolean(
        initial?.active || initial?.ffmpegRunning || initial?.clientConnected,
      );
      if (requireRtmpTraffic && !bridgeActive) {
        await waitFor(
          "rtmp bridge activity",
          async () => {
            const next = await fetchJson(statusUrl);
            return next?.active || next?.ffmpegRunning || next?.clientConnected
              ? next
              : null;
          },
          rtmpTimeoutMs,
        );
      }

      if (initialBytes > 0) {
        rtmpEvidence = {
          checked: true,
          bytesReceived: initialBytes,
          note: "bytes observed immediately",
        };
      } else if (requireRtmpTraffic || bridgeActive) {
        const bytes = await waitFor(
          requireRtmpTraffic
            ? "rtmp ingest bytes"
            : "rtmp ingest bytes (optional)",
          async () => {
            const next = await fetchJson(statusUrl);
            const value = Number(next?.stats?.bytesReceived ?? 0);
            return value > 0 ? value : null;
          },
          rtmpTimeoutMs,
        );
        rtmpEvidence = {
          checked: true,
          bytesReceived: Number(bytes),
          note: requireRtmpTraffic
            ? "bytes observed via required status endpoint"
            : "bytes observed via status endpoint",
        };
      } else {
        rtmpEvidence.note =
          "bridge status endpoint not attached to external RTMP process";
      }
    } catch (error) {
      rtmpEvidence = {
        checked: true,
        bytesReceived: null,
        note: `status check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (
    requiredDestinations.length > 0 &&
    !(
      typeof rtmpEvidence.bytesReceived === "number" &&
      rtmpEvidence.bytesReceived > 0
    )
  ) {
    throw new Error(
      `required RTMP destinations never received ingest bytes (${rtmpEvidence.note})`,
    );
  }

  if (!skipStream && hlsUrl) {
    await assertHlsReady("HLS playlist", hlsUrl, rtmpTimeoutMs);
  } else if (skipStream) {
    log("skipping HLS and RTMP verification (--skip-stream)");
  }

  const telemetryTimeoutMs = Math.min(30_000, Math.max(10_000, pollMs * 6));
  const [inventoryA, inventoryB, thoughtsA, thoughtsB] = await Promise.all([
    fetchJsonWithRetry(
      `inventory telemetry for ${agent1Id}`,
      `${serverUrl}/api/streaming/agent/${agent1Id}/inventory`,
      {
        waitTimeoutMs: telemetryTimeoutMs,
        validate: (payload) => Array.isArray(payload?.inventory),
      },
    ),
    fetchJsonWithRetry(
      `inventory telemetry for ${agent2Id}`,
      `${serverUrl}/api/streaming/agent/${agent2Id}/inventory`,
      {
        waitTimeoutMs: telemetryTimeoutMs,
        validate: (payload) => Array.isArray(payload?.inventory),
      },
    ),
    fetchJsonWithRetry(
      `monologue telemetry for ${agent1Id}`,
      `${serverUrl}/api/streaming/agent/${agent1Id}/monologues?limit=5`,
      {
        waitTimeoutMs: telemetryTimeoutMs,
        validate: (payload) => Array.isArray(payload?.thoughts),
      },
    ),
    fetchJsonWithRetry(
      `monologue telemetry for ${agent2Id}`,
      `${serverUrl}/api/streaming/agent/${agent2Id}/monologues?limit=5`,
      {
        waitTimeoutMs: telemetryTimeoutMs,
        validate: (payload) => Array.isArray(payload?.thoughts),
      },
    ),
  ]);

  const report = {
    ok: true,
    serverUrl,
    clientUrl,
    bettingUrl,
    hlsUrl,
    canonicalStream,
    skipStream,
    skipBetting,
    hyperbet: hyperbetBackend
      ? {
          apiUrl: hyperbetApiUrl,
          sourceUrl: hyperbetBackend.stream.sourceUrl,
          sourceSeq: hyperbetBackend.stream.seq,
          readOnly: hyperbetReadOnly,
          browser: hyperbetBrowser,
        }
      : null,
    databaseHealth: serverHealth.database,
    agent1Id,
    agent2Id,
    combatEvidence,
    equipmentVisualEvidence,
    audioEvidence,
    rtmpEvidence,
    requiredDestinations,
    requiredDestinationNames,
    telemetry: {
      inventoryA: inventoryA.inventory.length,
      inventoryB: inventoryB.inventory.length,
      thoughtsA: thoughtsA.thoughts.length,
      thoughtsB: thoughtsB.thoughts.length,
    },
  };
  if (browserEvidenceDir) {
    await fsp.mkdir(browserEvidenceDir, { recursive: true });
    const reportPath = path.join(
      browserEvidenceDir,
      "duel-stack-verification-report.json",
    );
    const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
    await fsp.writeFile(reportPath, serializedReport, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    log(
      `retained verifier report: ${reportPath} sha256=${createHash("sha256")
        .update(serializedReport)
        .digest("hex")}`,
    );
  }
  log("verification passed");
  console.log(JSON.stringify(report, null, 2));
  console.log(`[duel-verify-report] ${JSON.stringify(report)}`);
}

verify().catch((err) => {
  console.error(
    `[duel-verify] FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
