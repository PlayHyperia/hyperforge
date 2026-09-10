#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { PublicKey } from "@solana/web3.js";

import { assertHyperiaNodeVersion } from "./node-runtime-policy.mjs";
import { resolvePinnedBunRuntime } from "./duel-bun-runtime-policy.mjs";
import { buildDuelSmokeHyperbetCliInvocation } from "./duel-smoke-hyperbet-cli-runtime.mjs";
import { runBoundedChildCommand } from "./bounded-child-command.mjs";
import { resolveMediaExecutable } from "../packages/server/src/streaming/media-runtime.mjs";
import { readLaunchAssetByteEvidence } from "./lib/launch-asset-byte-evidence.mjs";
import {
  bindDuelSmokeStreamCredential,
  buildDuelSmokeLauncherArgs,
  buildDuelSmokeMotionCombatArgs,
  classifyDuelSmokeForbiddenRuntimeDiagnostic,
  describeDuelSmokePortAvailabilityError,
  describeDuelSmokeLauncherShutdownFailure,
  resolveDuelSmokeFailure,
  getCompleteRetainedLiveMediaEvidence,
  isDuelSmokeOnlineLine,
  listManagedLocalSolanaPorts,
  resolveDuelSmokeMotionStreamUrl,
  resolveDuelSmokeMotionStartupTimeoutSeconds,
  resolveDuelSmokeReviewFrameTimestamps,
  resolveDuelSmokeCaptureBrowserEnvironment,
  resolveDuelSmokeMaterializedSourceAttestation,
  resolveDuelSmokeLocalSolanaLedgerShreds,
  selectExactResolvedTerminalEvidence,
  validateDuelSmokeCombatProfile,
  validateDuelSmokeLaunchDeadlines,
  validateDuelSmokeLiveEvidenceProfile,
  validateDuelSmokeReviewFrameEvidence,
  validateDuelSmokePorts,
} from "./duel-launch-smoke-policy.mjs";
import {
  buildDuelFullTopologyContinuityChecks,
  buildDuelFullTopologyDisputeEvidenceCheck,
  buildDuelFullTopologyExactTerminalCheck,
  buildDuelFullTopologyLoadArgs,
  buildDuelFullTopologyStrategyAnalyticsChecks,
  buildDuelFullTopologyStrategyAuditArgs,
  buildDuelFullTopologyTerminalChecks,
  DuelFullTopologyContinuityTracker,
  redactDuelFullTopologyDiagnostic,
  settleDuelFullTopologySoakTasks,
  validateDuelFullTopologySoakConfiguration,
} from "./duel-full-topology-soak-policy.mjs";
import {
  buildDuelFullTopologyViewerChecks,
  buildDuelFullTopologyViewerCoverageCheck,
  DuelFullTopologyViewerTracker,
  hasExactDuelFullTopologyViewerBaseline,
} from "./duel-full-topology-viewer-policy.mjs";
import {
  launchOwnedDuelViewer,
  runDuelViewerOperation,
} from "./duel-full-topology-viewer-runtime.mjs";
import { resolveFullTopologyBrowserPerformanceProfile } from "./duel-full-topology-browser-performance-policy.mjs";
import { resolveDuelStackShutdownPolicy } from "./duel-stack-shutdown.mjs";
import {
  resolveHyperbetSolanaDeployment,
  resolveHyperbetWorkspace,
} from "./duel-stack-topology.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const gameBunRuntime = resolvePinnedBunRuntime({
  label: "Hyperia",
  workspaceRoot: ROOT,
  configuredPath: process.env.DUEL_HYPERIA_BUN_PATH,
});
const gameBunPath = gameBunRuntime.path;
const options = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "skip-install": { type: "boolean" },
    "skip-build": { type: "boolean" },
    "with-hyperbet": { type: "boolean" },
    "with-keeper": { type: "boolean" },
    "with-local-solana": { type: "boolean" },
    "with-stream-recovery": { type: "boolean" },
    "with-authority-recovery": { type: "boolean" },
    "soak-duration-s": { type: "string", default: "0" },
    "soak-poll-ms": { type: "string", default: "2000" },
    "soak-sse-clients": { type: "string", default: "50" },
    "soak-hls-clients": { type: "string", default: "12" },
    "soak-state-pollers": { type: "string", default: "4" },
    "soak-duel-context-pollers": { type: "string", default: "2" },
    "live-evidence-dir": { type: "string", default: "" },
    "live-evidence-duration-s": { type: "string", default: "60" },
    "live-evidence-combat-profile": { type: "string", default: "multi" },
    "live-evidence-viewport": { type: "string", default: "1920x1080" },
    "live-evidence-network-latency-ms": { type: "string", default: "0" },
    "live-evidence-cpu-throttle-rate": { type: "string", default: "1" },
    "browser-performance-profile": { type: "string", default: "off" },
    "timeout-ms": { type: "string", default: "600000" },
    "overall-launch-timeout-ms": { type: "string", default: "1800000" },
  },
  strict: true,
}).values;

if (options.help) {
  console.log(`
Clean-checkout duel launch smoke.

Usage:
  node scripts/smoke-duel-launch.mjs [options]

Options:
  --skip-install       Reuse the current frozen install (local diagnostics only)
  --skip-build         Reuse current production builds throughout the nested stack (local diagnostics only)
  --with-hyperbet      Verify the read-only Hyperbet backend and betting UI
  --with-keeper        Also verify SOL transaction automation (requires deployed programs and roles)
  --with-local-solana  Own a disposable local validator for the keeper proof
  --with-stream-recovery
                       Inject and verify local renderer loss plus same-session UI recovery
  --with-authority-recovery
                       Hard-kill and cold-restart the owned world authority while preserving one SOL market
  --soak-duration-s <seconds>
                       Run the SOL-only full-topology qualification soak (minimum: 300; default: off)
  --soak-poll-ms <ms>  Hyperbet/Solana continuity poll interval (default: 2000)
  --soak-sse-clients <n>
                       Concurrent streaming SSE clients (default: 50)
  --soak-hls-clients <n>
                       Concurrent HLS watcher loops (default: 12)
  --soak-state-pollers <n>
                       Streaming state pollers (default: 4)
  --soak-duel-context-pollers <n>
                       Duel-context pollers (default: 2)
  --live-evidence-dir <path>
                       Retain a local HLS clip plus strict motion/renderer evidence
  --live-evidence-duration-s <seconds>
                       HLS and motion evidence duration, 15-300 (default: 60)
  --live-evidence-combat-profile <profile>
                       multi or an exact two-contestant role pair (default: multi)
  --live-evidence-viewport <WIDTHxHEIGHT>
                       Motion browser viewport (default: 1920x1080)
  --live-evidence-network-latency-ms <ms>
                       Motion browser transport latency, 0-2000 (default: 0)
  --live-evidence-cpu-throttle-rate <rate>
                       Motion browser CPU slowdown, 1-20 (default: 1)
  --browser-performance-profile <profile>
                       Compile Hyperbet and enforce co-load browser performance;
                       off or desktop_720p (default: off)
  --timeout-ms <ms>    Per-stage startup/verification deadline (default: 600000)
  --overall-launch-timeout-ms <ms>
                       Whole nested-stack launch deadline (default: 1800000)
`);
  process.exit(0);
}

assertHyperiaNodeVersion(process.version);

const timeoutMs = Number.parseInt(options["timeout-ms"], 10);
const overallLaunchTimeoutMs = Number.parseInt(
  options["overall-launch-timeout-ms"],
  10,
);
validateDuelSmokeLaunchDeadlines({
  stageTimeoutMs: timeoutMs,
  overallLaunchTimeoutMs,
});
const withHyperbet = options["with-hyperbet"] === true;
const withKeeper = options["with-keeper"] === true;
const withLocalSolana = options["with-local-solana"] === true;
const withStreamRecovery = options["with-stream-recovery"] === true;
const withAuthorityRecovery = options["with-authority-recovery"] === true;
const liveEvidenceDirectory = String(options["live-evidence-dir"] || "").trim()
  ? path.resolve(String(options["live-evidence-dir"]))
  : null;
const liveEvidenceDurationSeconds = Number.parseInt(
  options["live-evidence-duration-s"],
  10,
);
if (
  !Number.isSafeInteger(liveEvidenceDurationSeconds) ||
  liveEvidenceDurationSeconds < 15 ||
  liveEvidenceDurationSeconds > 300
) {
  throw new Error(
    "--live-evidence-duration-s must be an integer from 15 to 300",
  );
}
const liveEvidenceProfile = validateDuelSmokeLiveEvidenceProfile({
  viewport: options["live-evidence-viewport"],
  networkLatencyMs: options["live-evidence-network-latency-ms"],
  cpuThrottleRate: options["live-evidence-cpu-throttle-rate"],
});
const liveEvidenceCombatProfile = validateDuelSmokeCombatProfile(
  options["live-evidence-combat-profile"],
);
const browserPerformanceProfile = resolveFullTopologyBrowserPerformanceProfile(
  options["browser-performance-profile"],
);
const smokeCaptureBrowserEnvironment =
  resolveDuelSmokeCaptureBrowserEnvironment({
    platform: process.platform,
    environment: process.env,
  });
if (browserPerformanceProfile && !withHyperbet) {
  throw new Error("--browser-performance-profile requires --with-hyperbet");
}
if (withKeeper && !withHyperbet) {
  throw new Error("--with-keeper requires --with-hyperbet");
}
if (withLocalSolana && !withKeeper) {
  throw new Error("--with-local-solana requires --with-keeper");
}
if (withStreamRecovery && !withHyperbet) {
  throw new Error("--with-stream-recovery requires --with-hyperbet");
}
if (withAuthorityRecovery && !withLocalSolana) {
  throw new Error(
    "--with-authority-recovery requires --with-hyperbet --with-keeper --with-local-solana",
  );
}
const soakConfiguration = validateDuelFullTopologySoakConfiguration({
  durationSeconds: Number.parseInt(options["soak-duration-s"], 10),
  pollIntervalMs: Number.parseInt(options["soak-poll-ms"], 10),
  sseClients: Number.parseInt(options["soak-sse-clients"], 10),
  hlsClients: Number.parseInt(options["soak-hls-clients"], 10),
  statePollers: Number.parseInt(options["soak-state-pollers"], 10),
  duelContextPollers: Number.parseInt(options["soak-duel-context-pollers"], 10),
  withHyperbet,
  withKeeper,
  withLocalSolana,
});

const ports = validateDuelSmokePorts({
  server: Number(process.env.DUEL_SMOKE_SERVER_PORT || 35551),
  websocket: Number(process.env.DUEL_SMOKE_WS_PORT || 35552),
  client: Number(process.env.DUEL_SMOKE_CLIENT_PORT || 35553),
  capture: Number(process.env.DUEL_SMOKE_CAPTURE_PORT || 35554),
  captureBrowser: Number(process.env.DUEL_SMOKE_CAPTURE_BROWSER_PORT || 35559),
  spectator: Number(process.env.DUEL_SMOKE_SPECTATOR_PORT || 35556),
  postgres: Number(process.env.DUEL_SMOKE_POSTGRES_PORT || 35555),
  hyperbetApi: Number(process.env.DUEL_SMOKE_HYPERBET_API_PORT || 35557),
  hyperbetApp: Number(process.env.DUEL_SMOKE_HYPERBET_APP_PORT || 35558),
  solanaRpc: Number(process.env.DUEL_SMOKE_SOLANA_RPC_PORT || 35800),
});
const ownedPortEntries = [
  ...Object.entries(ports),
  ...(withLocalSolana
    ? listManagedLocalSolanaPorts(ports.solanaRpc)
        .filter((port) => port !== ports.solanaRpc)
        .map((port) => [`solana-${port}`, port])
    : []),
];
const runId = `${Date.now()}-${process.pid}`;
const containerName = `hyperia-duel-smoke-${runId}`;
const volumeName = `${containerName}-data`;
const liveDir = path.join(os.tmpdir(), `hyperia-duel-smoke-hls-${runId}`);
const hlsOutputPath = path.join(liveDir, "stream.m3u8");
const runtimeDir = path.join(ROOT, ".runtime-locks", `duel-smoke-${runId}`);
const rtmpStatusFile = path.join(runtimeDir, "rtmp-status.json");
const hyperbetKeeperHealthFile = path.join(
  runtimeDir,
  "hyperbet-keeper-health.json",
);
const hyperbetStreamStateFile = path.join(
  runtimeDir,
  "hyperbet-stream-state.json",
);
const hyperbetKeeperDbPath = path.join(runtimeDir, "hyperbet-keeper.sqlite");
const gameServerPidFile = path.join(runtimeDir, "owned-game-server.json");
const localTransactionEvidenceDir =
  process.env.DUEL_LOCAL_TRANSACTION_EVIDENCE_DIR?.trim() ||
  path.resolve(
    ROOT,
    "..",
    "progress-videos",
    `hyperbet-full-topology-localnet-${runId}`,
  );
const browserEvidenceDir = path.join(localTransactionEvidenceDir, "browser");
const authorityRecoveryEvidenceDir =
  process.env.DUEL_AUTHORITY_RECOVERY_EVIDENCE_DIR?.trim() ||
  path.join(localTransactionEvidenceDir, "authority-restart");
const authorityRecoveryEvidencePath = path.join(
  authorityRecoveryEvidenceDir,
  "authority-restart-evidence.json",
);
const fullTopologySoakLoadEvidencePath = path.join(
  localTransactionEvidenceDir,
  "full-topology-soak-stream-load.json",
);
const fullTopologySoakEvidencePath = path.join(
  localTransactionEvidenceDir,
  "full-topology-soak-evidence.json",
);
const fullTopologySoakStrategyAnalyticsPath = path.join(
  localTransactionEvidenceDir,
  "full-topology-soak-strategy-analytics.json",
);
const fullTopologySoakViewerEvidencePath = path.join(
  localTransactionEvidenceDir,
  "full-topology-soak-viewer-evidence.json",
);
const fullTopologySoakViewerStartScreenshotPath = path.join(
  localTransactionEvidenceDir,
  "full-topology-soak-viewer-start.png",
);
const fullTopologySoakViewerEndScreenshotPath = path.join(
  localTransactionEvidenceDir,
  "full-topology-soak-viewer-end.png",
);
const duelLockPath = path.join(ROOT, ".runtime-locks", "duel-stack.json");
const clientRuntimeEnvPath = path.join(ROOT, "packages/client/dist/env.js");
const originalClientRuntimeEnv = fs.existsSync(clientRuntimeEnvPath)
  ? await fsp.readFile(clientRuntimeEnvPath)
  : null;
const runtimePath = [
  path.dirname(gameBunPath),
  path.dirname(process.execPath),
  process.env.PATH,
]
  .filter(Boolean)
  .join(path.delimiter);
const soakAdminCode = soakConfiguration.enabled
  ? String(process.env.ADMIN_CODE || "").trim() ||
    randomBytes(32).toString("hex")
  : "";
const smokeStreamCredentialEnvironment = bindDuelSmokeStreamCredential(
  String(process.env.STREAMING_VIEWER_ACCESS_TOKEN || "").trim() ||
    randomBytes(24).toString("hex"),
);
let activeCommand = null;
let launcher = null;
let launcherShutdownFailure = null;
let cleanupPromise = null;
let interruptedSignal = null;
const forbiddenRuntimeDiagnostics = [];
const expectedAuthorityOutageDiagnostics = [];
let authorityRecoveryWindow = false;
const runtimeDiagnosticBuffers = { stdout: "", stderr: "" };

function log(message) {
  console.log(`[duel-smoke] ${message}`);
}

function captureRuntimeDiagnostics(stream, chunk) {
  const buffered = `${runtimeDiagnosticBuffers[stream]}${chunk}`;
  const lines = buffered.split(/\r?\n/);
  runtimeDiagnosticBuffers[stream] = lines.pop()?.slice(-4_096) || "";
  for (const line of lines) {
    const diagnostic = classifyDuelSmokeForbiddenRuntimeDiagnostic(line);
    if (!diagnostic) continue;
    if (
      authorityRecoveryWindow &&
      diagnostic.code === "betting-feed-poll-failed"
    ) {
      expectedAuthorityOutageDiagnostics.push({ ...diagnostic, stream });
      continue;
    }
    forbiddenRuntimeDiagnostics.push({ ...diagnostic, stream });
  }
}

function assertNoForbiddenRuntimeDiagnostics() {
  if (forbiddenRuntimeDiagnostics.length === 0) return;
  const first = forbiddenRuntimeDiagnostics[0];
  throw new Error(
    `Duel smoke observed forbidden ${first.code} diagnostic on ${first.stream}: ${first.line}`,
  );
}

function finalizeRuntimeDiagnostics() {
  for (const stream of Object.keys(runtimeDiagnosticBuffers)) {
    const tail = runtimeDiagnosticBuffers[stream];
    runtimeDiagnosticBuffers[stream] = "";
    if (!tail) continue;
    const diagnostic = classifyDuelSmokeForbiddenRuntimeDiagnostic(tail);
    if (diagnostic) {
      forbiddenRuntimeDiagnostics.push({ ...diagnostic, stream });
    }
  }
}

async function runCommand(
  label,
  command,
  args,
  environment = {},
  { signal } = {},
) {
  if (signal?.aborted) {
    throw new Error(`${label} aborted before start`);
  }
  log(`${label}...`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...environment, PATH: runtimePath },
      stdio: "inherit",
    });
    activeCommand = child;
    let abortRequested = false;
    let abortEscalation = null;
    const clearAbortState = () => {
      signal?.removeEventListener("abort", handleAbort);
      if (abortEscalation) clearTimeout(abortEscalation);
    };
    const handleAbort = () => {
      if (abortRequested) return;
      abortRequested = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        abortEscalation = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 10_000);
        abortEscalation.unref();
      }
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
    child.once("error", (error) => {
      clearAbortState();
      if (activeCommand === child) activeCommand = null;
      reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      clearAbortState();
      if (activeCommand === child) activeCommand = null;
      if (abortRequested) {
        reject(
          new Error(
            `${label} aborted after a concurrent soak failure (code=${code} signal=${exitSignal})`,
          ),
        );
      } else if (code === 0) resolve();
      else
        reject(
          new Error(`${label} failed (code=${code} signal=${exitSignal})`),
        );
    });
  });
}

async function assertPortAvailable(name, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) =>
      reject(
        new Error(
          describeDuelSmokePortAvailabilityError({ name, port, error }),
          { cause: error },
        ),
      ),
    );
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function dockerObjectExists(args) {
  try {
    const { stdout } = await execFileAsync("docker", args);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function fetchJson(url, timeoutMs = 5_000, init = undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} at ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHttpStatus(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function waitForDelay(ms, signal = undefined) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function waitForCondition(label, operation, deadlineMs, signal) {
  let lastError = null;
  while (Date.now() < deadlineMs) {
    assertNotInterrupted();
    if (signal?.aborted) {
      const reason = signal.reason;
      throw new Error(
        `${label} aborted${reason instanceof Error ? `: ${reason.message}` : ""}`,
      );
    }
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await waitForDelay(100, signal);
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
  );
}

function remainingEvidenceCommandTime(deadlineMs, maximumMs) {
  const remaining = Math.min(maximumMs, (deadlineMs ?? Infinity) - Date.now());
  if (remaining <= 0) {
    throw new Error("Terminal evidence command deadline expired");
  }
  return remaining;
}

async function readTerminalSuccess(workspace, { signal, deadlineMs } = {}) {
  const terminalOpsPath = path.join(
    workspace.solanaDir,
    "keeper",
    "src",
    "terminalOps.ts",
  );
  const invocation = buildDuelSmokeHyperbetCliInvocation({
    workspaceRoot: workspace.root,
    args: [
      terminalOpsPath,
      "list",
      "--status",
      "SUCCEEDED",
      "--limit",
      "100",
      "--db",
      hyperbetKeeperDbPath,
    ],
    environment: { ...process.env, PATH: runtimePath },
  });
  const { stdout } = await runBoundedChildCommand(
    invocation.command,
    invocation.args,
    {
      label: "Hyperbet terminal ledger read",
      signal,
      timeoutMs: remainingEvidenceCommandTime(deadlineMs, 30_000),
      cwd: workspace.root,
      env: invocation.env,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

async function readProgramAccount(rpcUrl, programId) {
  const payload = await fetchJson(rpcUrl, 5_000, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: programId,
      method: "getAccountInfo",
      params: [programId, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const account = payload?.result?.value;
  if (
    payload?.error ||
    account?.executable !== true ||
    typeof account?.owner !== "string"
  ) {
    throw new Error(`Managed local Solana program ${programId} is unavailable`);
  }
  return {
    programId,
    executable: true,
    owner: account.owner,
    lamports: account.lamports,
    space: account.space,
  };
}

async function readProgramOwnedAccount(rpcUrl, accountId, ownerProgramId) {
  const payload = await fetchJson(rpcUrl, 5_000, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: accountId,
      method: "getAccountInfo",
      params: [accountId, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const account = payload?.result?.value;
  if (
    payload?.error ||
    account?.executable !== false ||
    account?.owner !== ownerProgramId
  ) {
    throw new Error(
      `Managed local Solana account ${accountId} is not owned by ${ownerProgramId}`,
    );
  }
  return {
    accountId,
    executable: false,
    owner: account.owner,
    lamports: account.lamports,
    space: account.space,
  };
}

function deriveDuelMarketAccounts(deployment, operation, marketRef) {
  const duelKey = Buffer.from(operation.duelKey, "hex");
  const oracleProgramId = new PublicKey(deployment.fightOracleProgramId);
  const marketProgramId = new PublicKey(deployment.duelMarketProgramId);
  const duelState = PublicKey.findProgramAddressSync(
    [Buffer.from("duel"), duelKey],
    oracleProgramId,
  )[0];
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), duelState.toBuffer(), Uint8Array.of(1)],
    marketProgramId,
  )[0];
  if (market.toBase58() !== marketRef) {
    throw new Error(
      `Resolved market PDA ${marketRef} does not match terminal duel ${operation.duelId}`,
    );
  }
  return { duelState: duelState.toBase58(), market: market.toBase58() };
}

async function waitForLocalTransactionEvidence(verificationReport) {
  const workspace = resolveHyperbetWorkspace({
    workspaceRoot: ROOT,
    configuredRoot: process.env.DUEL_HYPERBET_ROOT || "",
  });
  if (!workspace) {
    throw new Error("Unable to resolve the Hyperbet workspace for evidence");
  }
  const deployment = resolveHyperbetSolanaDeployment({
    solanaDir: workspace.solanaDir,
    cluster: "localnet",
  });
  const apiUrl = `http://127.0.0.1:${ports.hyperbetApi}`;
  const rpcUrl = `http://127.0.0.1:${ports.solanaRpc}`;
  const browserOrder = verificationReport?.hyperbet?.browser?.transaction;
  if (
    !browserOrder ||
    typeof browserOrder.duelId !== "string" ||
    typeof browserOrder.duelKey !== "string" ||
    typeof browserOrder.marketRef !== "string" ||
    typeof browserOrder.signature !== "string"
  ) {
    throw new Error(
      "Local transaction topology omitted matched browser-wallet order evidence",
    );
  }
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "no synchronized status observed";

  while (Date.now() < deadline) {
    assertNotInterrupted();
    assertNoForbiddenRuntimeDiagnostics();
    try {
      const status = await fetchJson(`${apiUrl}/status`);
      lastObservation = JSON.stringify({
        ready: status?.readiness?.ready,
        reasons: status?.readiness?.reasons,
        phase: status?.stream?.phase,
        marketStatuses: status?.predictionMarkets?.chains?.map(
          (market) => market?.lifecycleStatus,
        ),
      });
      if (status?.readiness?.ready !== true) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }

      const terminal = await readTerminalSuccess(workspace, {
        deadlineMs: deadline,
      });
      const exactTerminal = selectExactResolvedTerminalEvidence(
        status,
        terminal,
        {
          duelId: browserOrder.duelId,
          duelKey: browserOrder.duelKey,
          marketRef: browserOrder.marketRef,
        },
      );
      if (!exactTerminal || Number(terminal?.summary?.SUCCEEDED || 0) < 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (
        Number(terminal?.summary?.MANUAL_REVIEW || 0) !== 0 ||
        Number(terminal?.summary?.DEAD_LETTER || 0) !== 0
      ) {
        throw new Error(
          "Local transaction proof found a manual-review or dead-letter terminal operation",
        );
      }

      const programs = await Promise.all([
        readProgramAccount(rpcUrl, deployment.fightOracleProgramId),
        readProgramAccount(rpcUrl, deployment.duelMarketProgramId),
      ]);
      const derivedAccounts = deriveDuelMarketAccounts(
        deployment,
        exactTerminal.operation,
        exactTerminal.market.marketRef,
      );
      const accounts = await Promise.all([
        readProgramOwnedAccount(
          rpcUrl,
          derivedAccounts.duelState,
          deployment.fightOracleProgramId,
        ),
        readProgramOwnedAccount(
          rpcUrl,
          derivedAccounts.market,
          deployment.duelMarketProgramId,
        ),
      ]);
      return {
        schemaVersion: 1,
        proof: "hyperia-hyperbet-full-topology-localnet",
        capturedAtMs: Date.now(),
        scope: {
          chain: "solana",
          cluster: "localnet",
          arena3d: true,
          streamCapture: true,
          hyperbetUi: true,
          transactionsEnabled: true,
          browserSignedOrder: true,
          keeperVerifiedOrderAccounting: true,
          diagnosticFundsOnly: true,
          externalValue: false,
        },
        diagnosticOracleDisputeWindowSecs: 60,
        diagnosticAnnouncementMs: 120_000,
        diagnosticInterCycleDelayMs: 65_000,
        programs,
        accounts,
        resolvedMarket: exactTerminal.market,
        terminalOperation: exactTerminal.operation,
        terminalSummary: terminal.summary,
        readiness: status.readiness,
        stream: status.stream,
        browserOrder,
        verifier: verificationReport,
      };
    } catch (error) {
      if (String(error?.code ?? "").startsWith("CHILD_")) throw error;
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Timed out waiting for one resolved local SOL market and durable terminal success: ${lastObservation}`,
  );
}

async function captureDuelDisputeEvidence(duelId, { signal, deadlineMs } = {}) {
  const deadline = Math.min(
    Date.now() + Math.min(timeoutMs, 120_000),
    deadlineMs ?? Infinity,
  );
  signal?.throwIfAborted();
  remainingEvidenceCommandTime(deadline, 120_000);
  const workspace = resolveHyperbetWorkspace({
    workspaceRoot: ROOT,
    configuredRoot: process.env.DUEL_HYPERBET_ROOT || "",
  });
  if (!workspace) {
    throw new Error(
      "Unable to resolve the Hyperbet workspace for dispute evidence",
    );
  }
  const deployment = resolveHyperbetSolanaDeployment({
    solanaDir: workspace.solanaDir,
    cluster: "localnet",
  });
  const fileKey = createHash("sha256")
    .update(duelId)
    .digest("hex")
    .slice(0, 16);
  const outputPath = path.join(
    localTransactionEvidenceDir,
    `duel-dispute-evidence-${fileKey}.json`,
  );
  const anchorRoot = path.join(workspace.solanaDir, "anchor");
  const collectorPath = path.join(
    workspace.solanaDir,
    "keeper",
    "src",
    "duelDisputeEvidenceCli.ts",
  );
  let materializedSourceAttestationArgs = [];
  if (!fs.existsSync(path.join(workspace.root, ".git"))) {
    const sourceRoot = String(
      process.env.DUEL_HYPERBET_SOURCE_ROOT || "",
    ).trim();
    if (!sourceRoot) {
      throw new Error(
        "Materialized Hyperbet runtime requires DUEL_HYPERBET_SOURCE_ROOT for source attestation",
      );
    }
    const { stdout: sourceRevision } = await runBoundedChildCommand(
      "git",
      ["-C", path.resolve(sourceRoot), "rev-parse", "HEAD"],
      {
        label: "Hyperbet dispute source revision",
        signal,
        timeoutMs: remainingEvidenceCommandTime(deadline, 15_000),
        maxBuffer: 1024 * 1024,
      },
    );
    materializedSourceAttestationArgs = [
      ...resolveDuelSmokeMaterializedSourceAttestation({
        runtimeHasGitMetadata: false,
        sourceRevision,
      }),
    ];
  }
  await fsp.mkdir(localTransactionEvidenceDir, {
    recursive: true,
    mode: 0o700,
  });
  const collectorArgs = [
    collectorPath,
    "--db-path",
    hyperbetKeeperDbPath,
    "--duel-id",
    duelId,
    "--output",
    outputPath,
    "--rpc-url",
    `http://127.0.0.1:${ports.solanaRpc}`,
    "--cluster",
    "localnet",
    "--fight-program-id",
    deployment.fightOracleProgramId,
    "--market-program-id",
    deployment.duelMarketProgramId,
    "--hyperia-root",
    ROOT,
    "--hyperbet-root",
    workspace.root,
    ...materializedSourceAttestationArgs,
    "--fight-program-binary",
    path.join(anchorRoot, "target/deploy/fight_oracle.so"),
    "--market-program-binary",
    path.join(anchorRoot, "target/deploy/duel_market.so"),
    "--fight-program-idl",
    path.join(anchorRoot, "target/idl/fight_oracle.json"),
    "--market-program-idl",
    path.join(anchorRoot, "target/idl/duel_market.json"),
  ];
  const collectorOptions = {
    cwd: workspace.root,
    env: {
      ...process.env,
      PATH: runtimePath,
      SOLANA_CLUSTER: "localnet",
      SOLANA_RPC_URL: `http://127.0.0.1:${ports.solanaRpc}`,
      FIGHT_ORACLE_PROGRAM_ID: deployment.fightOracleProgramId,
      DUEL_MARKET_PROGRAM_ID: deployment.duelMarketProgramId,
    },
    maxBuffer: 4 * 1024 * 1024,
  };
  const collectorInvocation = buildDuelSmokeHyperbetCliInvocation({
    workspaceRoot: workspace.root,
    args: collectorArgs,
    environment: collectorOptions.env,
  });
  let stdout = "";
  let lastError = "collector did not run";
  while (Date.now() < deadline) {
    assertNotInterrupted();
    assertNoForbiddenRuntimeDiagnostics();
    signal?.throwIfAborted();
    try {
      ({ stdout } = await runBoundedChildCommand(
        collectorInvocation.command,
        collectorInvocation.args,
        {
          ...collectorOptions,
          env: collectorInvocation.env,
          label: "Hyperbet duel dispute collector",
          signal,
          timeoutMs: remainingEvidenceCommandTime(deadline, 120_000),
        },
      ));
      break;
    } catch (error) {
      // A deadline, cancellation, or unproven cleanup is never a custody retry.
      if (
        error?.code !== "CHILD_EXIT_NONZERO" ||
        !error.cleanupComplete ||
        error.forcedCleanup
      ) {
        throw error;
      }
      signal?.throwIfAborted();
      const stderr = String(error?.stderr ?? "").trim();
      const processStdout = String(error?.stdout ?? "").trim();
      lastError = stderr || processStdout || String(error?.message ?? error);
      const transient = [
        "oracle is not terminal",
        "market is not terminal",
        "account is missing",
        "no chain transaction history",
        "finalized transaction drifted",
        "missing chain action",
      ].some((fragment) => lastError.includes(fragment));
      if (!transient) throw error;
      await waitForDelay(
        Math.min(1_000, Math.max(0, deadline - Date.now())),
        signal,
      );
    }
  }
  if (!stdout) {
    throw new Error(
      `Timed out waiting for finalized duel dispute custody: ${lastError}`,
    );
  }
  signal?.throwIfAborted();
  const resultLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const result = resultLine ? JSON.parse(resultLine) : null;
  if (
    result?.ok !== true ||
    result.duelId !== duelId ||
    path.resolve(result.outputPath ?? "") !== path.resolve(outputPath) ||
    (await sha256File(outputPath)) !== result.artifactSha256
  ) {
    throw new Error("Duel dispute evidence collector returned invalid custody");
  }
  signal?.throwIfAborted();
  log(
    `retained immutable duel dispute evidence: ${outputPath} sha256=${result.artifactSha256}`,
  );
  return result;
}

async function monitorFullTopologyContinuity(signal, viewerLifecycle) {
  const serverUrl = `http://127.0.0.1:${ports.server}`;
  const hyperbetApiUrl = `http://127.0.0.1:${ports.hyperbetApi}`;
  const hyperbetAppUrl = `http://127.0.0.1:${ports.hyperbetApp}`;
  const solanaRpcUrl = `http://127.0.0.1:${ports.solanaRpc}`;
  const expectedSourceUrl = `${serverUrl}/api/streaming/state`;
  const tracker = new DuelFullTopologyContinuityTracker({ expectedSourceUrl });
  const startedAtMs = Date.now();
  const minimumDeadline =
    startedAtMs + soakConfiguration.durationSeconds * 1_000;
  const deadline =
    startedAtMs +
    Math.max(
      timeoutMs,
      soakConfiguration.durationSeconds * 1_000 +
        2 * Math.min(timeoutMs, 120_000) +
        30_000,
    );
  let lastObservationStartedAt = null;

  while (Date.now() < deadline) {
    if (
      Date.now() >= minimumDeadline &&
      viewerLifecycle.finishedAtMs != null &&
      lastObservationStartedAt >= viewerLifecycle.finishedAtMs
    ) {
      break;
    }
    if (signal.aborted) {
      tracker.recordFailure("full_topology_monitor_aborted");
      break;
    }
    assertNotInterrupted();
    assertNoForbiddenRuntimeDiagnostics();
    const observedAt = Date.now();
    lastObservationStartedAt = observedAt;
    try {
      const [
        canonicalState,
        hyperbetStatus,
        hyperbetState,
        solanaHealth,
        bettingUi,
      ] = await Promise.all([
        fetchJson(expectedSourceUrl),
        fetchJson(`${hyperbetApiUrl}/status`),
        fetchJson(`${hyperbetApiUrl}/api/streaming/state`),
        fetchJson(solanaRpcUrl, 5_000, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "full-topology-soak-health",
            method: "getHealth",
          }),
        }),
        fetchHttpStatus(hyperbetAppUrl),
      ]);
      tracker.observe({
        canonicalState,
        hyperbetStatus,
        hyperbetState,
        solanaHealth,
        bettingUi,
        observedAt,
      });
    } catch (error) {
      tracker.recordFailure(
        "full_topology_poll_failed",
        error instanceof Error ? error.message : String(error),
        observedAt,
      );
    }

    if (tracker.issueOccurrences > 0) break;

    await waitForDelay(
      Math.min(
        soakConfiguration.pollIntervalMs,
        Math.max(0, deadline - Date.now()),
      ),
      signal,
    );
  }

  const summary = tracker.summary();
  const checks = [
    ...buildDuelFullTopologyContinuityChecks(summary),
    buildDuelFullTopologyViewerCoverageCheck(
      summary,
      viewerLifecycle.finishedAtMs,
    ),
  ];
  return { ok: checks.every((check) => check.pass), summary, checks };
}

async function readFullTopologyViewerState(page) {
  return page.evaluate(() => {
    const browserObservedAtMs = Date.now();
    const browserPerformanceNowMs = performance.now();
    const root = document.querySelector(".hm-root");
    const video = document.querySelector("video");
    const readinessJson = root?.getAttribute("data-stream-readiness");
    let readiness = null;
    if (readinessJson && readinessJson.length <= 8_192) {
      try {
        readiness = JSON.parse(readinessJson);
      } catch {
        // Missing/malformed diagnostics fail the viewer policy; never infer
        // readiness merely from decoded video or actionable controls.
      }
    }
    const recoveryElement = document.querySelector(".hm-stream-recovery");
    const recoveryRect = recoveryElement?.getBoundingClientRect();
    const recoveryStyle = recoveryElement
      ? getComputedStyle(recoveryElement)
      : null;
    const recoveryVisible = Boolean(
      recoveryRect &&
      recoveryRect.width > 0 &&
      recoveryRect.height > 0 &&
      recoveryRect.bottom > 0 &&
      recoveryRect.right > 0 &&
      recoveryRect.top < innerHeight &&
      recoveryRect.left < innerWidth &&
      recoveryStyle?.display !== "none" &&
      recoveryStyle?.visibility !== "hidden" &&
      Number(recoveryStyle?.opacity) !== 0,
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
    const submit = document.querySelector('[data-testid="prediction-submit"]');
    const submitEnabled = Boolean(
      submit &&
      submit.getAttribute("aria-disabled") !== "true" &&
      (!(submit instanceof HTMLButtonElement) || !submit.disabled),
    );
    return {
      browserObservedAtMs,
      browserPerformanceNowMs,
      marker: globalThis.__HYPERIA_FULL_TOPOLOGY_SOAK_VIEWER__ ?? null,
      timeOrigin: performance.timeOrigin,
      navigationEntries: performance.getEntriesByType("navigation").length,
      rootPresent: root !== null,
      wagerControlCount,
      submitEnabled,
      readiness,
      recovery: {
        visible: recoveryVisible,
        mode: !recoveryElement
          ? "hidden"
          : recoveryElement.classList.contains("hm-stream-recovery--blocking")
            ? "blocking"
            : recoveryElement.classList.contains("hm-stream-recovery--advisory")
              ? "advisory"
              : "unknown",
        heading:
          recoveryElement
            ?.querySelector("strong")
            ?.textContent?.slice(0, 160) ?? null,
      },
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
            paused: video.paused,
            readyState: video.readyState,
          }
        : null,
    };
  });
}

async function readFullTopologyViewerMetrics(cdp) {
  const response = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    (Array.isArray(response?.metrics) ? response.metrics : []).map((metric) => [
      metric.name,
      metric.value,
    ]),
  );
}

async function monitorFullTopologyViewer(signal, soakBoundary) {
  const bettingUrl = `http://127.0.0.1:${ports.hyperbetApp}`;
  const expectedStreamSource = `http://127.0.0.1:${ports.server}/live/stream.m3u8`;
  for (const evidencePath of [
    fullTopologySoakViewerEvidencePath,
    fullTopologySoakViewerStartScreenshotPath,
    fullTopologySoakViewerEndScreenshotPath,
  ]) {
    try {
      await fsp.access(evidencePath);
      throw new Error(
        `Refusing to overwrite soak viewer evidence: ${evidencePath}`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const { chromium } = await import("playwright");
  const marker = randomBytes(16).toString("hex");
  const startedAtMs = Date.now();
  let ownedViewer = null;
  let browserCleanup = null;
  let workflowFailure = null;
  let tracker = null;
  let page = null;
  let baselineWaitMs = null;
  let startScreenshotSha256 = null;
  let endScreenshotSha256 = null;
  const screenshotObservations = {};
  const pendingRuntimeIssues = [];
  let omittedPendingRuntimeIssues = 0;
  const operation = (label, callback, limitMs = 10_000) =>
    runDuelViewerOperation(callback, {
      signal,
      timeoutMs: Math.min(timeoutMs, limitMs),
      label: `full-topology viewer ${label}`,
    });
  try {
    ownedViewer = await launchOwnedDuelViewer({
      chromium,
      signal,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    page = await operation("page creation", () =>
      ownedViewer.browser.newPage({ viewport: { width: 1440, height: 900 } }),
    );
    const recordRuntimeIssue = (code, detail) => {
      const safeDetail = redactDuelFullTopologyDiagnostic(detail);
      if (tracker) tracker.recordIssue(code, safeDetail);
      else if (pendingRuntimeIssues.length < 100)
        pendingRuntimeIssues.push({ code, detail: safeDetail });
      else omittedPendingRuntimeIssues += 1;
    };
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        recordRuntimeIssue(
          "viewer_console_issue",
          `${message.type()}: ${message.text()}`,
        );
      }
    });
    page.on("pageerror", (error) =>
      recordRuntimeIssue("viewer_page_error", error.message),
    );
    page.on("response", (response) => {
      if (response.status() >= 400) {
        recordRuntimeIssue(
          "viewer_http_failure",
          `${response.status()} ${response.url()}`,
        );
      }
    });
    page.on("requestfailed", (request) => {
      const detail = request.failure()?.errorText || "request failed";
      if (!detail.includes("ERR_ABORTED")) {
        recordRuntimeIssue(
          "viewer_request_failure",
          `${detail} ${request.url()}`,
        );
      }
    });

    await operation(
      "navigation",
      () =>
        page.goto(bettingUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(timeoutMs, 120_000),
        }),
      120_000,
    );
    await operation("session marker", () =>
      page.evaluate((value) => {
        globalThis.__HYPERIA_FULL_TOPOLOGY_SOAK_VIEWER__ = value;
      }, marker),
    );
    const cdp = await operation("metrics session", () =>
      page.context().newCDPSession(page),
    );
    await operation("metrics enable", () => cdp.send("Performance.enable"));
    const baselineWaitStartedAtMs = Date.now();
    const baseline = await waitForCondition(
      "full-topology soak viewer exact fresh duel authority and decoded playback",
      async () => {
        const state = await operation("baseline observation", () =>
          readFullTopologyViewerState(page),
        );
        return state.marker === marker &&
          hasExactDuelFullTopologyViewerBaseline(state, {
            ...soakBoundary,
            expectedStreamSource,
          })
          ? state
          : null;
      },
      Date.now() + Math.min(timeoutMs, 120_000),
      signal,
    );
    baselineWaitMs = Date.now() - baselineWaitStartedAtMs;
    tracker = new DuelFullTopologyViewerTracker({
      marker,
      timeOrigin: baseline.timeOrigin,
      expectedStreamSource,
    });
    for (const issue of pendingRuntimeIssues) {
      tracker.recordIssue(issue.code, issue.detail);
    }
    if (omittedPendingRuntimeIssues > 0)
      tracker.recordIssue(
        "viewer_pending_runtime_issues_omitted",
        omittedPendingRuntimeIssues,
      );
    const observe = async (
      source,
      measurePlayback,
      retainedBaseline = null,
    ) => {
      const observedAt = Date.now();
      const [state, metrics] = await operation(
        "state and metrics observation",
        () =>
          Promise.all([
            retainedBaseline ?? readFullTopologyViewerState(page),
            readFullTopologyViewerMetrics(cdp),
          ]),
      );
      tracker.observe({
        state,
        metrics,
        observedAt,
        completedAt: Date.now(),
        source,
        measurePlayback,
      });
      return tracker.lastState;
    };
    const captureViewerScreenshot = async (label, screenshotPath) => {
      const before = await observe(`${label}-screenshot-before`, false);
      const requestedAtMs = Date.now();
      await operation(
        `${label} screenshot`,
        () =>
          page.screenshot({
            path: screenshotPath,
            fullPage: false,
            timeout: Math.min(timeoutMs, 30_000),
          }),
        30_000,
      );
      const completedAtMs = Date.now();
      const after = await observe(`${label}-screenshot-after`, false);
      await fsp.chmod(screenshotPath, 0o600);
      const sha256 = await sha256File(screenshotPath);
      screenshotObservations[label] = {
        requestedAtMs,
        completedAtMs,
        before,
        after,
        sha256,
      };
      return sha256;
    };
    await observe("baseline", true, baseline);
    startScreenshotSha256 = await captureViewerScreenshot(
      "start",
      fullTopologySoakViewerStartScreenshotPath,
    );

    const deadline = Date.now() + soakConfiguration.durationSeconds * 1_000;
    while (Date.now() < deadline && tracker.issueOccurrences === 0) {
      assertNotInterrupted();
      try {
        await observe("poll", true);
      } catch (error) {
        tracker.recordFailure(
          "viewer_observation_failed",
          error instanceof Error ? error.message : String(error),
          Date.now(),
        );
      }
      if (tracker.issueOccurrences > 0) break;
      await waitForDelay(
        Math.min(
          soakConfiguration.pollIntervalMs,
          Math.max(0, deadline - Date.now()),
        ),
        signal,
      );
      if (
        signal.aborted &&
        Date.now() + soakConfiguration.pollIntervalMs < deadline
      ) {
        tracker.recordFailure("viewer_monitor_aborted_before_deadline");
        break;
      }
    }
    endScreenshotSha256 = await captureViewerScreenshot(
      "end",
      fullTopologySoakViewerEndScreenshotPath,
    );
  } catch (error) {
    workflowFailure = redactDuelFullTopologyDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    tracker?.recordFailure("viewer_workflow_failed", workflowFailure);
    browserCleanup = error?.viewerDiagnostic ?? null;
  } finally {
    if (ownedViewer) browserCleanup = await ownedViewer.close();
  }

  const summary = tracker?.summary() ?? null;
  const checks = [
    ...buildDuelFullTopologyViewerChecks(summary),
    {
      label:
        "full-topology Hyperbet viewer workflow completed without cancellation or error",
      pass: workflowFailure === null,
      actual: workflowFailure,
    },
    {
      label: "full-topology Hyperbet soak browser closed in teardown",
      pass:
        browserCleanup?.closed === true &&
        browserCleanup.forcedCleanup === false &&
        browserCleanup.errors.length === 0,
      actual: browserCleanup,
    },
  ];
  const evidence = {
    schemaVersion: 1,
    proof: "hyperia-hyperbet-sol-full-topology-same-session-viewer",
    classification: {
      environment: "owned-local-production-builds",
      chain: "solana",
      externalValue: false,
      productionEquivalentInfrastructure: false,
      closesProductionDurationGate: false,
    },
    startedAtMs,
    finishedAtMs: Date.now(),
    requestedDurationSeconds: soakConfiguration.durationSeconds,
    exactBaseline: {
      cycleId: soakBoundary.cycleId,
      duelId: soakBoundary.duelId,
      duelKey: soakBoundary.duelKey,
      waitMs: baselineWaitMs,
    },
    browser: {
      markerSha256: createHash("sha256").update(marker).digest("hex"),
      timeOrigin: tracker?.timeOrigin ?? null,
      navigationEntries: tracker ? 1 : null,
      cleanup: browserCleanup,
    },
    workflowFailure,
    startupRuntimeIssues: {
      samples: pendingRuntimeIssues,
      omitted: omittedPendingRuntimeIssues,
    },
    screenshots: {
      start: {
        path: fullTopologySoakViewerStartScreenshotPath,
        sha256: startScreenshotSha256,
      },
      end: {
        path: fullTopologySoakViewerEndScreenshotPath,
        sha256: endScreenshotSha256,
      },
    },
    screenshotObservations,
    summary,
    checks,
    ok: checks.every((check) => check.pass),
  };
  await fsp.writeFile(
    fullTopologySoakViewerEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return {
    ...evidence,
    evidencePath: fullTopologySoakViewerEvidencePath,
    evidenceSha256: await sha256File(fullTopologySoakViewerEvidencePath),
  };
}

async function captureTerminalLedgerSnapshot() {
  const workspace = resolveHyperbetWorkspace({
    workspaceRoot: ROOT,
    configuredRoot: process.env.DUEL_HYPERBET_ROOT || "",
  });
  if (!workspace) {
    throw new Error("Unable to resolve the Hyperbet workspace for soak");
  }
  const terminal = await readTerminalSuccess(workspace);
  return {
    capturedAtMs: Date.now(),
    terminalSummary: terminal.summary,
    successfulOperations: Array.isArray(terminal.operations)
      ? terminal.operations.map((operation) => ({
          id: operation.id,
          duelId: operation.duelId,
          duelKey: operation.duelKey,
          completedAt: operation.completedAt,
        }))
      : [],
  };
}

async function capturePostSoakTerminalEvidence(
  expectedDuel = {},
  { signal, deadlineMs } = {},
) {
  signal?.throwIfAborted();
  const workspace = resolveHyperbetWorkspace({
    workspaceRoot: ROOT,
    configuredRoot: process.env.DUEL_HYPERBET_ROOT || "",
  });
  if (!workspace) {
    throw new Error("Unable to resolve the Hyperbet workspace after soak");
  }
  const status = await fetchJson(
    `http://127.0.0.1:${ports.hyperbetApi}/status`,
    remainingEvidenceCommandTime(deadlineMs, 5_000),
  );
  const terminal = await readTerminalSuccess(workspace, { signal, deadlineMs });
  signal?.throwIfAborted();
  const exactTerminal = selectExactResolvedTerminalEvidence(
    status,
    terminal,
    expectedDuel,
  );
  const marketChains = status?.predictionMarkets?.chains;
  if (
    status?.service !== "hyperbet-solana-backend" ||
    status?.readiness?.ready !== true ||
    !Array.isArray(marketChains) ||
    marketChains.length === 0 ||
    marketChains.some((market) => market?.chainKey !== "solana")
  ) {
    throw new Error("Post-soak Hyperbet status is not ready and SOL-only");
  }
  if (
    Number(terminal?.summary?.SUCCEEDED || 0) < 1 ||
    Number(terminal?.summary?.MANUAL_REVIEW || 0) !== 0 ||
    Number(terminal?.summary?.DEAD_LETTER || 0) !== 0
  ) {
    throw new Error(
      "Post-soak terminal ledger has no success or contains unsafe terminal operations",
    );
  }
  return {
    capturedAtMs: Date.now(),
    readiness: status.readiness,
    stream: status.stream,
    marketCount: marketChains.length,
    marketLifecycleStatuses: marketChains.map((market) => ({
      chainKey: market.chainKey,
      marketRef: market.marketRef,
      lifecycleStatus: market.lifecycleStatus,
    })),
    terminalSummary: terminal.summary,
    exactTerminal,
  };
}

async function waitForExactSoakBoundaryEvidence(expectedDuel, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "exact soak-boundary terminal is not available";

  while (Date.now() < deadline) {
    assertNotInterrupted();
    if (signal?.aborted) {
      const reason = signal.reason;
      throw new Error(
        `Exact soak-boundary evidence aborted${reason instanceof Error ? `: ${reason.message}` : ""}`,
      );
    }
    try {
      const terminal = await capturePostSoakTerminalEvidence(expectedDuel, {
        signal,
        deadlineMs: deadline,
      });
      if (terminal.exactTerminal?.operation?.duelId) {
        const disputeEvidence = await captureDuelDisputeEvidence(
          terminal.exactTerminal.operation.duelId,
          { signal, deadlineMs: deadline },
        );
        signal?.throwIfAborted();
        return { terminal, disputeEvidence };
      }
      lastObservation = JSON.stringify({
        terminalSummary: terminal.terminalSummary,
        marketLifecycleStatuses: terminal.marketLifecycleStatuses,
      });
    } catch (error) {
      if (signal?.aborted || String(error?.code ?? "").startsWith("CHILD_")) {
        throw error;
      }
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await waitForDelay(
      Math.min(2_000, Math.max(0, deadline - Date.now())),
      signal,
    );
  }

  throw new Error(
    `Timed out waiting for exact soak-boundary terminal and dispute evidence: ${lastObservation}`,
  );
}

async function waitForDrainedPostSoakTerminalEvidence() {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "post-soak terminal ledger is unavailable";

  while (Date.now() < deadline) {
    assertNotInterrupted();
    assertNoForbiddenRuntimeDiagnostics();
    try {
      const terminal = await capturePostSoakTerminalEvidence(
        {},
        { deadlineMs: deadline },
      );
      const summary = terminal.terminalSummary;
      const unfinishedCount =
        Number(summary?.PENDING || 0) + Number(summary?.PROCESSING || 0);
      if (unfinishedCount === 0) return terminal;
      lastObservation = JSON.stringify(summary);
    } catch (error) {
      if (String(error?.code ?? "").startsWith("CHILD_")) throw error;
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await waitForDelay(Math.min(2_000, Math.max(0, deadline - Date.now())));
  }

  throw new Error(
    `Timed out waiting for a drained post-soak terminal ledger: ${lastObservation}`,
  );
}

async function waitForFreshSoakAnnouncementBoundary() {
  const stateUrl = `http://127.0.0.1:${ports.server}/api/streaming/state`;
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "no streaming state observed";

  while (Date.now() < deadline) {
    assertNotInterrupted();
    assertNoForbiddenRuntimeDiagnostics();
    try {
      const state = await fetchJson(stateUrl);
      const cycle = state?.cycle;
      const phaseDurationMs =
        Number(cycle?.phaseEndTime) - Number(cycle?.phaseStartTime);
      const phaseElapsedMs = phaseDurationMs - Number(cycle?.timeRemaining);
      lastObservation = JSON.stringify({
        cycleId: cycle?.cycleId ?? null,
        phase: cycle?.phase ?? null,
        phaseElapsedMs,
      });
      if (
        cycle?.phase === "ANNOUNCEMENT" &&
        typeof cycle?.cycleId === "string" &&
        cycle.cycleId.length > 0 &&
        typeof cycle?.duelId === "string" &&
        cycle.duelId.length > 0 &&
        typeof cycle?.duelKeyHex === "string" &&
        /^[0-9a-f]{64}$/.test(cycle.duelKeyHex) &&
        Number.isFinite(phaseElapsedMs) &&
        phaseElapsedMs >= 0 &&
        phaseElapsedMs <= 1_000
      ) {
        log(
          `fresh soak cycle boundary ready: cycle=${cycle.cycleId} elapsed=${Math.round(phaseElapsedMs)}ms`,
        );
        return {
          cycleId: cycle.cycleId,
          duelId: cycle.duelId,
          duelKey: cycle.duelKeyHex,
          phaseElapsedMs,
        };
      }
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await waitForDelay(250);
  }
  throw new Error(
    `Timed out waiting for a fresh ANNOUNCEMENT boundary before soak: ${lastObservation}`,
  );
}

function buildOwnedSmokePostgresUrl() {
  const databaseUrl = new URL(
    `postgresql://127.0.0.1:${ports.postgres}/hyperia_smoke`,
  );
  databaseUrl.username = "hyperia_smoke";
  databaseUrl.password = `smoke-${runId}`;
  return databaseUrl.toString();
}

async function captureFullTopologyStrategyAnalytics() {
  const { stdout } = await execFileAsync(
    gameBunPath,
    buildDuelFullTopologyStrategyAuditArgs(),
    {
      cwd: ROOT,
      env: {
        ...process.env,
        COMPETITIVE_STRATEGY_AUDIT_DATABASE_URL: buildOwnedSmokePostgresUrl(),
        COMPETITIVE_STRATEGY_AUDIT_DIAGNOSTIC_BOUNDARY: "owned_local_no_value",
      },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  let analytics;
  try {
    analytics = JSON.parse(stdout);
  } catch {
    throw new Error("Competitive strategy audit emitted invalid JSON");
  }
  await fsp.writeFile(
    fullTopologySoakStrategyAnalyticsPath,
    `${JSON.stringify(analytics, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    analytics,
    artifactPath: fullTopologySoakStrategyAnalyticsPath,
    artifactSha256: await sha256File(fullTopologySoakStrategyAnalyticsPath),
  };
}

async function runFullTopologySoak(initialTransactionEvidence) {
  await fsp.mkdir(localTransactionEvidenceDir, { recursive: true });
  const soakBoundary = await waitForFreshSoakAnnouncementBoundary();
  const preSoakTerminal = await captureTerminalLedgerSnapshot();
  const serverUrl = `http://127.0.0.1:${ports.server}`;
  const bettingUrl = `http://127.0.0.1:${ports.hyperbetApp}`;
  const loadArgs = buildDuelFullTopologyLoadArgs({
    configuration: soakConfiguration,
    serverUrl,
    bettingUrl,
    evidencePath: fullTopologySoakLoadEvidencePath,
  });
  const monitorAbortController = new AbortController();
  const boundaryEvidenceResultPromise = waitForExactSoakBoundaryEvidence(
    {
      duelId: soakBoundary.duelId,
      duelKey: soakBoundary.duelKey,
    },
    monitorAbortController.signal,
  ).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => {
      if (!monitorAbortController.signal.aborted) {
        monitorAbortController.abort(reason);
      }
      return { status: "rejected", reason };
    },
  );
  const loadStartedAtMs = Date.now();
  const loadPromise = runCommand(
    "SOL full-topology streaming load and lifecycle qualification",
    "bun",
    loadArgs,
    { STREAMING_LOAD_ADMIN_CODE: soakAdminCode },
    { signal: monitorAbortController.signal },
  );
  const viewerLifecycle = { finishedAtMs: null };
  const viewerPromise = monitorFullTopologyViewer(
    monitorAbortController.signal,
    soakBoundary,
  ).finally(() => {
    viewerLifecycle.finishedAtMs = Date.now();
  });
  const continuityPromise = monitorFullTopologyContinuity(
    monitorAbortController.signal,
    viewerLifecycle,
  );
  const [soakTaskResults, boundaryEvidenceResult] = await Promise.all([
    settleDuelFullTopologySoakTasks({
      loadPromise,
      continuityPromise,
      viewerPromise,
      abortController: monitorAbortController,
    }),
    boundaryEvidenceResultPromise,
  ]);
  const [loadResult, continuityResult, viewerResult] = soakTaskResults;

  let streamLoadEvidence = null;
  try {
    streamLoadEvidence = JSON.parse(
      await fsp.readFile(fullTopologySoakLoadEvidencePath, "utf8"),
    );
  } catch {
    // A missing artifact is represented by an explicit failed check below.
  }

  let postSoakTerminal = null;
  let postSoakTerminalError = null;
  try {
    postSoakTerminal = await waitForDrainedPostSoakTerminalEvidence();
  } catch (error) {
    postSoakTerminalError =
      error instanceof Error ? error.message : String(error);
  }

  const soakBoundaryTerminal =
    boundaryEvidenceResult.status === "fulfilled"
      ? boundaryEvidenceResult.value.terminal
      : null;
  const postSoakDisputeEvidence =
    boundaryEvidenceResult.status === "fulfilled"
      ? boundaryEvidenceResult.value.disputeEvidence
      : null;
  const postSoakDisputeEvidenceError =
    boundaryEvidenceResult.status === "rejected"
      ? boundaryEvidenceResult.reason instanceof Error
        ? boundaryEvidenceResult.reason.message
        : String(boundaryEvidenceResult.reason)
      : null;

  let strategyAnalyticsCapture = null;
  let strategyAnalyticsError = null;
  try {
    strategyAnalyticsCapture = await captureFullTopologyStrategyAnalytics();
  } catch (error) {
    strategyAnalyticsError = redactDuelFullTopologyDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
  }

  const launcherRunning =
    launcher?.exitCode === null && launcher?.signalCode === null;
  const continuity =
    continuityResult.status === "fulfilled"
      ? continuityResult.value
      : {
          ok: false,
          summary: null,
          checks: [],
          error:
            continuityResult.reason instanceof Error
              ? continuityResult.reason.message
              : String(continuityResult.reason),
        };
  const viewer =
    viewerResult.status === "fulfilled"
      ? viewerResult.value
      : {
          ok: false,
          checks: [],
          error:
            viewerResult.reason instanceof Error
              ? viewerResult.reason.message
              : String(viewerResult.reason),
        };
  const checks = [
    {
      label: "streaming load process exited cleanly",
      pass: loadResult.status === "fulfilled",
      actual:
        loadResult.status === "fulfilled"
          ? "exit 0"
          : loadResult.reason instanceof Error
            ? loadResult.reason.message
            : String(loadResult.reason),
    },
    {
      label: "streaming load evidence passed every configured gate",
      pass: streamLoadEvidence?.ok === true,
      actual: streamLoadEvidence?.ok ?? null,
    },
    ...(continuity.checks ?? []),
    {
      label:
        "full-topology continuity monitor completed every configured check",
      pass: continuityResult.status === "fulfilled" && continuity.ok === true,
      actual:
        continuityResult.status === "fulfilled"
          ? continuity.ok
          : continuity.error,
    },
    {
      label: "same-session Hyperbet soak viewer completed",
      pass: viewerResult.status === "fulfilled",
      actual:
        viewerResult.status === "fulfilled"
          ? viewer.evidenceSha256
          : viewer.error,
    },
    ...(viewer.checks ?? []),
    ...buildDuelFullTopologyTerminalChecks(
      preSoakTerminal?.terminalSummary,
      postSoakTerminal?.terminalSummary,
    ),
    buildDuelFullTopologyExactTerminalCheck(
      soakBoundary,
      soakBoundaryTerminal?.exactTerminal,
    ),
    buildDuelFullTopologyDisputeEvidenceCheck(
      soakBoundary,
      postSoakDisputeEvidence,
    ),
    {
      label:
        "competitive strategy analytics artifact was captured from the owned smoke database",
      pass:
        strategyAnalyticsCapture != null &&
        /^[0-9a-f]{64}$/.test(strategyAnalyticsCapture?.artifactSha256 ?? ""),
      actual:
        strategyAnalyticsCapture?.artifactSha256 ?? strategyAnalyticsError,
    },
    ...buildDuelFullTopologyStrategyAnalyticsChecks(
      soakBoundary,
      strategyAnalyticsCapture?.analytics,
    ),
    {
      label: "post-soak Hyperbet terminal ledger remained safe and SOL-only",
      pass: postSoakTerminal != null,
      actual:
        postSoakTerminalError ?? postSoakTerminal?.terminalSummary ?? null,
    },
    {
      label: "owned duel launcher remained online through soak completion",
      pass: launcherRunning,
      actual: launcherRunning,
    },
  ];
  const evidence = {
    schemaVersion: 1,
    proof: "hyperia-hyperbet-sol-full-topology-local-qualification",
    classification: {
      environment: "owned-local-production-builds",
      chain: "solana",
      externalValue: false,
      productionEquivalentInfrastructure: false,
      closesProductionDurationGate: false,
    },
    startedAtMs: loadStartedAtMs,
    finishedAtMs: Date.now(),
    requestedDurationSeconds: soakConfiguration.durationSeconds,
    soakBoundary,
    soakBoundaryTerminal,
    preSoakTerminal,
    load: {
      configuration: soakConfiguration,
      processExitedCleanly: loadResult.status === "fulfilled",
      evidencePath: fullTopologySoakLoadEvidencePath,
      evidence: streamLoadEvidence,
    },
    continuity,
    viewer,
    initialTransactionEvidence,
    postSoakTerminal,
    postSoakDisputeEvidence,
    postSoakDisputeEvidenceError,
    strategyAnalytics:
      strategyAnalyticsCapture == null
        ? {
            artifactPath: fullTopologySoakStrategyAnalyticsPath,
            error: strategyAnalyticsError,
          }
        : {
            artifactPath: strategyAnalyticsCapture.artifactPath,
            artifactSha256: strategyAnalyticsCapture.artifactSha256,
            audit: strategyAnalyticsCapture.analytics.audit ?? null,
            generatedAt: strategyAnalyticsCapture.analytics.generatedAt ?? null,
            databaseAccess:
              strategyAnalyticsCapture.analytics.databaseAccess ?? null,
            descriptiveOnly:
              strategyAnalyticsCapture.analytics.descriptiveOnly ?? null,
            diagnosticScope:
              strategyAnalyticsCapture.analytics.diagnosticScope ?? null,
            truncated: strategyAnalyticsCapture.analytics.truncated ?? null,
            terminalRows:
              strategyAnalyticsCapture.analytics.terminalRows ?? null,
            actionObservationRows:
              strategyAnalyticsCapture.analytics.actionObservationRows ?? null,
            completedDuels:
              strategyAnalyticsCapture.analytics.report?.completedDuels ?? null,
            participantSamples:
              strategyAnalyticsCapture.analytics.report?.participantSamples ??
              null,
          },
    checks,
    ok: checks.every((check) => check.pass),
  };
  await fsp.writeFile(
    fullTopologySoakEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  log(
    `retained SOL full-topology soak evidence: ${fullTopologySoakEvidencePath} sha256=${await sha256File(fullTopologySoakEvidencePath)}`,
  );
  if (!evidence.ok) {
    throw new Error(
      `SOL full-topology soak failed; inspect ${fullTopologySoakEvidencePath}`,
    );
  }
  return evidence;
}

async function sha256File(filePath) {
  const bytes = await fsp.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForChildExit(child, waitMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for duel launcher shutdown")),
      waitMs,
    );
    const handleExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", handleExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener("exit", handleExit);
      handleExit();
    }
  });
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

async function removeOwnedDuelLock(launcherPid) {
  try {
    const lock = JSON.parse(await fsp.readFile(duelLockPath, "utf8"));
    if (Number(lock?.pid) === launcherPid) {
      await fsp.rm(duelLockPath, { force: true });
    }
  } catch {
    // Missing, invalid, or not owned by this smoke process.
  }
}

async function cleanup() {
  if (
    activeCommand &&
    activeCommand.exitCode === null &&
    activeCommand.signalCode === null
  ) {
    activeCommand.kill("SIGTERM");
    await waitForChildExit(activeCommand, 10_000).catch(() => {});
  }

  if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
    // The game can receive a longer per-child environment budget than the
    // smoke parent. Wait the supported maximum whole ordered drain + dispatch.
    const launcherShutdownPolicy = resolveDuelStackShutdownPolicy({
      DUEL_STACK_SHUTDOWN_GRACE_MS: "30000",
    });
    launcher.kill("SIGINT");
    try {
      await waitForChildExit(
        launcher,
        launcherShutdownPolicy.totalGraceMs + 3_000,
      );
    } catch {
      launcherShutdownFailure = describeDuelSmokeLauncherShutdownFailure({
        exitCode: launcher.exitCode,
        signalCode: launcher.signalCode,
        forcedKill: true,
      });
      signalProcessGroup(launcher, "SIGKILL");
      await waitForChildExit(launcher, 10_000).catch(() => {});
    }
  }
  if (launcher) {
    launcherShutdownFailure ??= describeDuelSmokeLauncherShutdownFailure({
      exitCode: launcher.exitCode,
      signalCode: launcher.signalCode,
    });
  }
  if (launcher) signalProcessGroup(launcher, "SIGTERM");

  await removeOwnedDuelLock(launcher?.pid);
  await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});
  await execFileAsync("docker", ["volume", "rm", volumeName]).catch(() => {});
  await fsp.rm(liveDir, { recursive: true, force: true });
  await fsp.rm(runtimeDir, { recursive: true, force: true });

  if (originalClientRuntimeEnv === null) {
    await fsp.rm(clientRuntimeEnvPath, { force: true });
  } else {
    await fsp.writeFile(clientRuntimeEnvPath, originalClientRuntimeEnv);
  }
}

function cleanupOnce() {
  cleanupPromise ||= cleanup();
  return cleanupPromise;
}

function handleInterruption(signal) {
  if (interruptedSignal) return;
  interruptedSignal = signal;
  log(`received ${signal}; stopping only smoke-owned resources`);
  void cleanupOnce();
}

function assertNotInterrupted() {
  if (interruptedSignal) {
    throw new Error(`Duel smoke interrupted by ${interruptedSignal}`);
  }
}

process.once("SIGINT", () => handleInterruption("SIGINT"));
process.once("SIGTERM", () => handleInterruption("SIGTERM"));

async function launchAndWait() {
  const args = buildDuelSmokeLauncherArgs({
    ports,
    timeoutMs,
    withHyperbet,
    withKeeper,
    withLocalSolana,
    withAuthorityRecovery,
    reuseGameBuilds: options["skip-build"] === true,
    localSolanaLedgerShreds: resolveDuelSmokeLocalSolanaLedgerShreds(
      soakConfiguration.durationSeconds,
    ),
    combatProfile: liveEvidenceCombatProfile.name,
  });
  const launcherEntrypointPath = path.resolve(ROOT, String(args[0] || ""));
  const expectedLauncherEntrypointPath = path.join(
    ROOT,
    "scripts/duel-stack.mjs",
  );
  if (launcherEntrypointPath !== expectedLauncherEntrypointPath) {
    throw new Error("Duel smoke nested launcher entrypoint drifted");
  }
  const launcherEntrypointEvidence = readLaunchAssetByteEvidence(
    launcherEntrypointPath,
    { timeoutMs: 60_000 },
  );
  if (
    !launcherEntrypointEvidence.ok ||
    launcherEntrypointEvidence.evidence.bytesRead < 10_000
  ) {
    throw new Error(
      `Duel smoke nested launcher is not byte-complete: ${launcherEntrypointEvidence.ok ? "entrypoint is unexpectedly small" : launcherEntrypointEvidence.error}`,
    );
  }
  const environment = {
    ...process.env,
    ...(soakConfiguration.enabled ? { ADMIN_CODE: soakAdminCode } : {}),
    PATH: runtimePath,
    POSTGRES_CONTAINER: containerName,
    POSTGRES_PORT: String(ports.postgres),
    POSTGRES_USER: "hyperia_smoke",
    POSTGRES_PASSWORD: `smoke-${runId}`,
    POSTGRES_DB: "hyperia_smoke",
    POSTGRES_IMAGE: "postgres:16-alpine",
    HLS_OUTPUT_PATH: hlsOutputPath,
    HLS_SEGMENT_PATTERN: path.join(liveDir, "stream-%09d.ts"),
    RTMP_STATUS_FILE: rtmpStatusFile,
    SPECTATOR_PORT: String(ports.spectator),
    ...smokeCaptureBrowserEnvironment,
    STREAMING_VIEWER_ACCESS_TOKEN:
      smokeStreamCredentialEnvironment.STREAMING_VIEWER_ACCESS_TOKEN,
    DUEL_WITH_HYPERBET: withHyperbet ? "true" : "false",
    DUEL_HYPERBET_READ_ONLY_MODE:
      withHyperbet && !withKeeper ? "true" : "false",
    DUEL_HYPERBET_APP_RUNTIME: browserPerformanceProfile
      ? "production_preview"
      : "development",
    DUEL_VERIFY_BROWSER_PERFORMANCE_PROFILE:
      browserPerformanceProfile?.name || "",
    DUEL_HYPERBET_KEEPER_HEALTH_FILE: hyperbetKeeperHealthFile,
    DUEL_HYPERBET_STREAM_STATE_FILE: hyperbetStreamStateFile,
    DUEL_HYPERBET_KEEPER_DB_PATH: hyperbetKeeperDbPath,
    DUEL_GAME_SERVER_PID_FILE: withAuthorityRecovery ? gameServerPidFile : "",
    DUEL_USE_PRODUCTION_CLIENT: "true",
    DUEL_NODE_ENV: "production",
    DUEL_LOG_LEVEL: "info",
    DUEL_LOCAL_SMOKE_MODE: "true",
    LOAD_TEST_MODE: "true",
    TERRAIN_SEED: "0",
    TOWN_COLLISION_DEEP_VALIDATION: "false",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GROQ_API_KEY: "",
    STREAMING_DUEL_PREPARATION_MS: "5000",
    STREAMING_ANNOUNCEMENT_MS: withLocalSolana ? "120000" : "5000",
    STREAMING_FIGHTING_MS: "30000",
    STREAMING_END_WARNING_MS: "5000",
    STREAMING_RESOLUTION_MS: "3000",
    STREAMING_INTER_CYCLE_DELAY_MS: withLocalSolana ? "65000" : "2000",
    DUEL_VERIFY_BROWSER_EVIDENCE_DIR:
      withLocalSolana || browserPerformanceProfile ? browserEvidenceDir : "",
  };
  // Keep binding inputs absent here on purpose: the explicit launcher URLs
  // must be sufficient to bind the same custom ports they advertise.
  // Mirroring them through PORT/UWS_PORT would hide topology drift.
  delete environment.PORT;
  delete environment.UWS_PORT;

  const child = spawn(gameBunPath, args, {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  launcher = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let verificationReport = null;
  const online = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `Duel smoke nested-stack launch timed out after ${overallLaunchTimeoutMs}ms`,
          ),
        ),
      overallLaunchTimeoutMs,
    );
    const consume = (chunk) => {
      process.stdout.write(chunk);
      captureRuntimeDiagnostics("stdout", chunk);
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("[duel-stack-verification-report] ")) continue;
        try {
          verificationReport = JSON.parse(
            line.slice("[duel-stack-verification-report] ".length),
          );
        } catch {
          reject(new Error("Duel launcher emitted an invalid verifier report"));
          return;
        }
      }
      if (lines.some(isDuelSmokeOnlineLine)) {
        if (!verificationReport) {
          clearTimeout(timeout);
          reject(
            new Error("Duel stack reached online without verifier evidence"),
          );
          return;
        }
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      captureRuntimeDiagnostics("stderr", chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Duel launcher exited before online (code=${code} signal=${signal})`,
        ),
      );
    });
  });

  await online;
  return verificationReport;
}

async function retainLiveDuelEvidence(verificationReport) {
  if (!liveEvidenceDirectory) return null;

  const manifestPath = path.join(liveEvidenceDirectory, "manifest.json");
  const videoPath = path.join(liveEvidenceDirectory, "live-hls.mp4");
  const reviewEvidencePath = path.join(
    liveEvidenceDirectory,
    "live-hls-review.json",
  );
  const reviewContactSheetPath = path.join(
    liveEvidenceDirectory,
    "live-hls-review-contact-sheet.png",
  );
  const reviewTimestamps = resolveDuelSmokeReviewFrameTimestamps(
    liveEvidenceDurationSeconds,
  );
  const reviewFramePaths = reviewTimestamps.map((_, index) =>
    path.join(
      liveEvidenceDirectory,
      `live-hls-review-frame-${String(index + 1).padStart(2, "0")}.png`,
    ),
  );
  const verifierPath = path.join(
    liveEvidenceDirectory,
    "duel-stack-verification-report.json",
  );
  const mediaProbePath = path.join(
    liveEvidenceDirectory,
    "live-hls-media-probe.json",
  );
  if (
    fs.existsSync(manifestPath) ||
    fs.existsSync(videoPath) ||
    fs.existsSync(reviewEvidencePath) ||
    fs.existsSync(reviewContactSheetPath) ||
    reviewFramePaths.some((reviewFramePath) =>
      fs.existsSync(reviewFramePath),
    ) ||
    fs.existsSync(verifierPath) ||
    fs.existsSync(mediaProbePath)
  ) {
    throw new Error(
      `refusing to overwrite existing live duel evidence: ${liveEvidenceDirectory}`,
    );
  }

  await fsp.mkdir(liveEvidenceDirectory, { recursive: true, mode: 0o700 });
  await fsp.chmod(liveEvidenceDirectory, 0o700);
  await fsp.writeFile(
    verifierPath,
    `${JSON.stringify(verificationReport, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );

  await runCommand("retained live HLS video capture", process.env.FFMPEG_PATH, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-live_start_index",
    "-2",
    "-i",
    hlsOutputPath,
    "-t",
    String(liveEvidenceDurationSeconds),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-n",
    videoPath,
  ]);
  await fsp.chmod(videoPath, 0o600);

  const { stdout: mediaProbe } = await execFileAsync(
    process.env.FFPROBE_PATH,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,avg_frame_rate,sample_rate,channels",
      "-of",
      "json",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  const parsedMediaProbe = JSON.parse(mediaProbe);
  const retainedMediaEvidence = getCompleteRetainedLiveMediaEvidence(
    parsedMediaProbe,
    liveEvidenceDurationSeconds,
  );
  if (!retainedMediaEvidence) {
    throw new Error(
      `retained HLS evidence is missing complete 720p stereo A/V: ${JSON.stringify(parsedMediaProbe)}`,
    );
  }
  await fsp.writeFile(
    mediaProbePath,
    `${JSON.stringify(parsedMediaProbe, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );

  const reviewFrames = [];
  for (let index = 0; index < reviewFramePaths.length; index += 1) {
    const reviewFramePath = reviewFramePaths[index];
    const timestampSeconds = reviewTimestamps[index];
    await runCommand(
      `encoded HLS visual-review frame ${index + 1}/${reviewFramePaths.length}`,
      process.env.FFMPEG_PATH,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        videoPath,
        "-ss",
        timestampSeconds.toFixed(3),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=1280:720:flags=lanczos,setsar=1",
        "-n",
        reviewFramePath,
      ],
    );
    await fsp.chmod(reviewFramePath, 0o600);
    reviewFrames.push({
      index: index + 1,
      timestampSeconds,
      file: path.basename(reviewFramePath),
      sha256: await sha256File(reviewFramePath),
    });
  }

  const contactSheetFilter = [
    ...reviewFramePaths.map(
      (_, index) =>
        `[${index}:v]scale=640:360:flags=lanczos,setsar=1[v${index}]`,
    ),
    `${reviewFramePaths.map((_, index) => `[v${index}]`).join("")}xstack=inputs=${reviewFramePaths.length}:layout=0_0|640_0|1280_0|0_360|640_360|1280_360:fill=black[review]`,
  ].join(";");
  await runCommand(
    "encoded HLS visual-review contact sheet",
    process.env.FFMPEG_PATH,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...reviewFramePaths.flatMap((reviewFramePath) => ["-i", reviewFramePath]),
      "-filter_complex",
      contactSheetFilter,
      "-map",
      "[review]",
      "-frames:v",
      "1",
      "-n",
      reviewContactSheetPath,
    ],
  );
  await fsp.chmod(reviewContactSheetPath, 0o600);
  const { stdout: contactSheetProbeOutput } = await execFileAsync(
    process.env.FFPROBE_PATH,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      reviewContactSheetPath,
    ],
    { encoding: "utf8" },
  );
  const contactSheetProbe = JSON.parse(contactSheetProbeOutput);
  const contactSheetStream = contactSheetProbe.streams?.[0];
  const reviewIntegrity = validateDuelSmokeReviewFrameEvidence({
    frameSha256Values: reviewFrames.map((frame) => frame.sha256),
    contactSheetWidth: contactSheetStream?.width,
    contactSheetHeight: contactSheetStream?.height,
  });
  const reviewEvidence = {
    schemaVersion: 1,
    proof: "hyperia-encoded-hls-multi-frame-visual-review",
    source: {
      file: path.basename(videoPath),
      sha256: await sha256File(videoPath),
      durationSeconds: retainedMediaEvidence.durationSeconds,
      width: retainedMediaEvidence.width,
      height: retainedMediaEvidence.height,
      averageFrameRate: retainedMediaEvidence.averageFrameRate,
    },
    sampling: {
      method: "six-evenly-spaced-frames-with-bounded-edge-margins",
      requestedDurationSeconds: liveEvidenceDurationSeconds,
      frames: reviewFrames,
    },
    integrity: reviewIntegrity,
    contactSheet: {
      file: path.basename(reviewContactSheetPath),
      sha256: await sha256File(reviewContactSheetPath),
      columns: 3,
      rows: 2,
      tileWidth: 640,
      tileHeight: 360,
    },
  };
  await fsp.writeFile(
    reviewEvidencePath,
    `${JSON.stringify(reviewEvidence, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );

  await runCommand(
    "strict live duel motion and renderer evidence",
    gameBunPath,
    [
      "scripts/capture-duel-motion-telemetry.mjs",
      "--stream-url",
      resolveDuelSmokeMotionStreamUrl(ports),
      "--state-url",
      `http://127.0.0.1:${ports.server}/api/streaming/state`,
      "--output-dir",
      liveEvidenceDirectory,
      ...buildDuelSmokeMotionCombatArgs(liveEvidenceCombatProfile.name),
      "--require-hit-reactions",
      "--viewport",
      liveEvidenceProfile.viewport,
      "--network-latency-ms",
      String(liveEvidenceProfile.networkLatencyMs),
      "--cpu-throttle-rate",
      String(liveEvidenceProfile.cpuThrottleRate),
      "--duration-s",
      String(liveEvidenceDurationSeconds),
      "--minimum-fighting-s",
      String(Math.max(15, Math.floor(liveEvidenceDurationSeconds / 2))),
      "--maximum-duration-s",
      String(Math.min(1_200, liveEvidenceDurationSeconds * 4)),
      "--startup-timeout-s",
      String(
        resolveDuelSmokeMotionStartupTimeoutSeconds({
          durationSeconds: liveEvidenceDurationSeconds,
          withLocalSolana,
        }),
      ),
    ],
    {
      ...smokeStreamCredentialEnvironment,
      ...smokeCaptureBrowserEnvironment,
    },
  );

  if (fs.existsSync(rtmpStatusFile)) {
    const retainedRtmpStatusPath = path.join(
      liveEvidenceDirectory,
      "rtmp-status.json",
    );
    await fsp.copyFile(
      rtmpStatusFile,
      retainedRtmpStatusPath,
      fs.constants.COPYFILE_EXCL,
    );
    await fsp.chmod(retainedRtmpStatusPath, 0o600);
  }
  return {
    directory: liveEvidenceDirectory,
    manifestPath,
    mediaProbePath,
    reviewContactSheetPath,
    reviewEvidencePath,
    reviewFramePaths,
    verifierPath,
    videoPath,
  };
}

async function runSmoke() {
  let passed = false;
  let runError = null;
  const cleanupErrors = [];
  let transactionEvidence = null;
  let soakEvidence = null;
  let liveEvidence = null;
  try {
    const encoder = resolveMediaExecutable({ tool: "ffmpeg" });
    process.env.FFMPEG_PATH = encoder.path;
    log(`verified stream encoder: ${encoder.version} (${encoder.path})`);
    if (liveEvidenceDirectory) {
      const probe = resolveMediaExecutable({ tool: "ffprobe" });
      process.env.FFPROBE_PATH = probe.path;
      log(`verified media probe: ${probe.version} (${probe.path})`);
    }
    await execFileAsync("docker", ["info"]);
    assertNotInterrupted();
    if (fs.existsSync(liveDir) || fs.existsSync(runtimeDir)) {
      throw new Error("Duel smoke runtime path already exists");
    }
    if (
      await dockerObjectExists([
        "ps",
        "-a",
        "--filter",
        `name=^/${containerName}$`,
        "--format",
        "{{.Names}}",
      ])
    ) {
      throw new Error(`Duel smoke container already exists: ${containerName}`);
    }
    if (
      await dockerObjectExists([
        "volume",
        "ls",
        "-q",
        "--filter",
        `name=^${volumeName}$`,
      ])
    ) {
      throw new Error(`Duel smoke volume already exists: ${volumeName}`);
    }
    for (const [name, port] of ownedPortEntries) {
      assertNotInterrupted();
      await assertPortAvailable(name, port);
    }

    assertNotInterrupted();
    await fsp.mkdir(liveDir, { recursive: true });
    await fsp.mkdir(runtimeDir, { recursive: true });

    if (!options["skip-install"]) {
      assertNotInterrupted();
      await runCommand(
        "frozen dependency and browser/assets install",
        gameBunPath,
        ["install", "--frozen-lockfile"],
        {
          HYPERIA_REQUIRE_FULL_ASSETS: "true",
          HYPERIA_REQUIRE_BROWSER_SYSTEM_DEPS: "true",
        },
      );
    }
    assertNotInterrupted();
    await runCommand(
      "active combat visual orientation and contact evidence gate",
      gameBunPath,
      ["run", "equipment:active-combat-orientation:check"],
    );
    assertNotInterrupted();
    await runCommand(
      "exact active duel equipment certification gate",
      gameBunPath,
      ["run", "equipment:fit:check"],
    );
    if (!options["skip-build"]) {
      assertNotInterrupted();
      await runCommand("production SOL duel build", gameBunPath, [
        "run",
        "build:duel:sol",
      ]);
    }

    assertNotInterrupted();
    const verificationReport = await launchAndWait();
    liveEvidence = await retainLiveDuelEvidence(verificationReport);
    if (withAuthorityRecovery) {
      assertNotInterrupted();
      const programId = String(
        verificationReport?.hyperbet?.browser?.transaction?.programId || "",
      ).trim();
      if (!programId) {
        throw new Error(
          "Authority recovery requires the verified local browser transaction program identity",
        );
      }
      authorityRecoveryWindow = true;
      try {
        await runCommand(
          "built-world authority hard-kill and SOL market continuity",
          process.execPath,
          [
            "scripts/verify-duel-authority-restart.mjs",
            "--hyperia-url",
            `http://127.0.0.1:${ports.server}`,
            "--hyperbet-api-url",
            `http://127.0.0.1:${ports.hyperbetApi}`,
            "--betting-url",
            `http://127.0.0.1:${ports.hyperbetApp}`,
            "--capture-browser-port",
            String(ports.captureBrowser),
            "--solana-rpc-url",
            `http://127.0.0.1:${ports.solanaRpc}`,
            "--duel-market-program-id",
            programId,
            "--pid-file",
            gameServerPidFile,
            "--expected-launcher-pid",
            String(launcher.pid),
            "--evidence-dir",
            authorityRecoveryEvidenceDir,
            "--timeout-ms",
            String(Math.min(timeoutMs, 240_000)),
          ],
        );
      } finally {
        authorityRecoveryWindow = false;
      }
      assertNoForbiddenRuntimeDiagnostics();
    }
    if (withLocalSolana) {
      assertNotInterrupted();
      transactionEvidence =
        await waitForLocalTransactionEvidence(verificationReport);
      transactionEvidence.disputeEvidence = await captureDuelDisputeEvidence(
        transactionEvidence.terminalOperation.duelId,
      );
      assertNoForbiddenRuntimeDiagnostics();
    }
    if (soakConfiguration.enabled) {
      assertNotInterrupted();
      soakEvidence = await runFullTopologySoak(transactionEvidence);
      assertNoForbiddenRuntimeDiagnostics();
    }
    if (withStreamRecovery) {
      assertNotInterrupted();
      const recoveryEvidenceDir =
        process.env.DUEL_STREAM_RECOVERY_EVIDENCE_DIR?.trim() ||
        path.join(runtimeDir, "stream-recovery-evidence");
      await runCommand(
        "same-session stream recovery fault injection",
        process.execPath,
        [
          "scripts/verify-duel-stream-recovery.mjs",
          "--betting-url",
          `http://127.0.0.1:${ports.hyperbetApp}`,
          "--hyperbet-api-url",
          `http://127.0.0.1:${ports.hyperbetApi}`,
          "--hyperia-url",
          `http://127.0.0.1:${ports.server}`,
          "--capture-port",
          String(ports.capture),
          "--capture-browser-port",
          String(ports.captureBrowser),
          "--status-file",
          rtmpStatusFile,
          "--evidence-dir",
          recoveryEvidenceDir,
          "--timeout-ms",
          String(Math.min(timeoutMs, 120_000)),
        ],
      );
    }
    passed = true;
  } catch (error) {
    runError = error;
  } finally {
    try {
      await cleanupOnce();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  finalizeRuntimeDiagnostics();

  for (const [name, port] of ownedPortEntries) {
    try {
      await assertPortAvailable(name, port);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    if (
      await dockerObjectExists([
        "ps",
        "-a",
        "--filter",
        `name=^/${containerName}$`,
        "--format",
        "{{.Names}}",
      ])
    ) {
      cleanupErrors.push(
        new Error(`Duel smoke leaked container ${containerName}`),
      );
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (
      await dockerObjectExists([
        "volume",
        "ls",
        "-q",
        "--filter",
        `name=^${volumeName}$`,
      ])
    ) {
      cleanupErrors.push(new Error(`Duel smoke leaked volume ${volumeName}`));
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  const failure = resolveDuelSmokeFailure({
    runError,
    launcherShutdownFailure,
    cleanupErrors,
    forbiddenRuntimeDiagnostics,
  });
  if (failure) throw failure;
  if (!passed) throw new Error("Duel smoke did not reach the online boundary");
  if (transactionEvidence) {
    await fsp.mkdir(localTransactionEvidenceDir, { recursive: true });
    const evidencePath = path.join(
      localTransactionEvidenceDir,
      "full-topology-evidence.json",
    );
    await fsp.writeFile(
      evidencePath,
      `${JSON.stringify(transactionEvidence, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    log(
      `retained full-topology evidence: ${evidencePath} sha256=${await sha256File(evidencePath)}`,
    );
  }
  if (withAuthorityRecovery) {
    log(
      `retained authority-restart evidence: ${authorityRecoveryEvidencePath} sha256=${await sha256File(authorityRecoveryEvidencePath)}`,
    );
  }

  const hyperbetProof = withHyperbet
    ? withKeeper
      ? withLocalSolana
        ? ", synchronized transaction-enabled Hyperbet UI/backend, an owned local validator, and a resolved SOL keeper terminal operation"
        : ", synchronized Hyperbet UI/backend, and a ready SOL keeper"
      : ", plus the synchronized read-only Hyperbet UI/backend"
    : "";
  const recoveryProof = withStreamRecovery
    ? ", including same-session renderer-loss recovery"
    : "";
  const authorityRecoveryProof = withAuthorityRecovery
    ? `, including built-world authority SIGKILL recovery with ${expectedAuthorityOutageDiagnostics.length} expected transient source diagnostic(s) and no duplicate SOL market`
    : "";
  const soakProof = soakEvidence
    ? `, plus a ${soakConfiguration.durationSeconds}s SOL-only local full-topology qualification soak`
    : "";
  const liveEvidenceProof = liveEvidence
    ? `, with retained HLS and motion evidence at ${liveEvidence.directory}`
    : "";
  log(
    `PASS: clean launch reached a rendered combat duel${hyperbetProof}${recoveryProof}${authorityRecoveryProof}${soakProof}${liveEvidenceProof} and removed every owned runtime resource`,
  );
}

try {
  await runSmoke();
} catch (error) {
  if (interruptedSignal) {
    log(`interrupted by ${interruptedSignal}`);
    process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
  } else {
    console.error(
      `[duel-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
