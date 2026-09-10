#!/usr/bin/env node
/**
 * Duel Stack Orchestrator
 *
 * Starts the full agent duel arena stack with one command:
 * - game server + client (streaming duel scheduler)
 * - duel bot matchmaker
 * - RTMP bridge + local HLS fanout
 * - optional sibling Hyperbet backend + app
 * - optional sibling Hyperbet SOL keeper automation
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";

import {
  assertAuthorityRestartDiagnosticBoundary,
  assertMultiStyleSparbotOptions,
  assertManagedLocalSolanaBoundary,
  assertStandaloneSparbotRuntimeBoundary,
  assertSupportedUwsNodeVersion,
  assertProcessTerminationAllowed,
  hasConfiguredDuelModelProvider,
  isBettingFeedBootstrap,
  isFreshHyperbetReadiness,
  isHyperbetStreamSynchronized,
  isLocalDatabaseUrl,
  isLoopbackHostname,
  isStandaloneSparbotBootstrap,
  omitEnvironmentKeys,
  resolveHyperbetRuntimeTopology,
  resolveHyperbetKeeperDatabaseTopology,
  resolveHyperbetSolanaDeployment,
  resolveHyperbetWorkspace,
  resolveDuelGameServiceTopology,
  resolveDuelDatabaseConfiguration,
  resolvePrivateBettingFeedToken,
  resolveJwtRuntimeSecret,
  resolvePrivateRuntimeSecret,
  resolveStandaloneSparbotProfileSeed,
  resolveStandaloneSparbotStyles,
  shouldReleaseRestartedAuthorityStartupGate,
} from "./duel-stack-topology.mjs";
import { buildCaptureSupervisorUnavailableStatus } from "./duel-capture-restart-policy.mjs";
import {
  bindPinnedBunToEnvironment,
  resolvePinnedBunRuntime,
} from "./duel-bun-runtime-policy.mjs";
import { writeEphemeralSolanaKeypairFile } from "./duel-solana-keypair-policy.mjs";
import { getHealthyBrowserAudioEvidence } from "./duel-launch-smoke-policy.mjs";
import {
  resolveFullTopologyBrowserPerformanceProfile,
  resolveHyperbetAppViteMode,
  resolveHyperbetAppRuntime,
} from "./duel-full-topology-browser-performance-policy.mjs";
import { waitForBoundedChildExit } from "./bounded-child-command.mjs";
import {
  observeGameServerShutdown,
  resolveDuelStackShutdownPolicy,
  shutdownDuelStackChildren,
} from "./duel-stack-shutdown.mjs";
import { resolveMediaExecutable } from "../packages/server/src/streaming/media-runtime.mjs";

const options = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    bots: { type: "string", short: "b", default: "10" },
    "bot-styles": {
      type: "string",
      default: process.env.DUEL_BOT_STYLES || "auto",
    },
    "sparbot-profile-seed": {
      type: "string",
      default: process.env.DUEL_SPARBOT_PROFILE_SEED || "",
    },
    "betting-port": { type: "string", default: "4179" },
    "hyperbet-api-url": {
      type: "string",
      default: process.env.DUEL_HYPERBET_API_URL || "http://localhost:8080",
    },
    "hyperbet-root": {
      type: "string",
      default: process.env.DUEL_HYPERBET_ROOT || "",
    },
    "rtmp-port": { type: "string", default: "8765" },
    "capture-browser-port": {
      type: "string",
      default: process.env.STREAM_CAPTURE_BROWSER_DEBUG_PORT || "9223",
    },
    "server-url": {
      type: "string",
      default:
        process.env.DUEL_SERVER_URL ||
        `http://localhost:${process.env.PORT || "5555"}`,
    },
    "ws-url": {
      type: "string",
      default:
        process.env.DUEL_WS_URL ||
        `ws://localhost:${process.env.UWS_PORT || "5556"}/ws`,
    },
    "client-url": { type: "string", default: "http://localhost:3333" },
    "remote-betting": { type: "boolean" },
    "skip-keeper": { type: "boolean" },
    "skip-stream": { type: "boolean" },
    "skip-betting": { type: "boolean" },
    "skip-bots": { type: "boolean" },
    "with-mm": { type: "boolean" },
    "mm-mode": {
      type: "string",
      default: process.env.DUEL_MM_MODE || "auto",
    },
    "mm-config": {
      type: "string",
      default: process.env.DUEL_MM_CONFIG || "",
    },
    "mm-stagger-ms": {
      type: "string",
      default: process.env.DUEL_MM_STAGGER_MS || "900",
    },
    "mm-start-delay-ms": {
      type: "string",
      default: process.env.DUEL_MM_START_DELAY_MS || "1000",
    },
    fresh: { type: "boolean" },
    isolated: { type: "boolean" },
    verify: { type: "boolean" },
    "check-runtimes": { type: "boolean" },
    "reuse-game-builds": { type: "boolean" },
    "verify-timeout-ms": { type: "string", default: "240000" },
    "startup-timeout-ms": {
      type: "string",
      default: process.env.DUEL_STARTUP_TIMEOUT_MS || "420000",
    },
    "local-smoke": { type: "boolean" },
    "local-solana": { type: "boolean" },
    "authority-recovery": { type: "boolean" },
    "local-solana-rebuild": { type: "boolean" },
    "local-solana-rpc-port": {
      type: "string",
      default: process.env.DUEL_LOCAL_SOLANA_RPC_PORT || "18899",
    },
    "local-solana-ledger-shreds": {
      type: "string",
      default: process.env.DUEL_LOCAL_SOLANA_LEDGER_SHREDS || "10000",
    },
    "multi-style-sparbots": { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
  },
  strict: true,
}).values;

if (options.help) {
  console.log(`
Full Duel Stack bootstrap

Usage:
  bun run duel [options]

Options:
  -h, --help              Show this help
  -b, --bots <n>          Duel bot count (default: 10)
  --bot-styles <csv>      auto (rotating roles), one style for all, or one per bot
  --sparbot-profile-seed <n> Repeatable uint32 profile seed (local smoke only)
  --betting-port <n>      Hyperbet app dev port (default: 4179)
  --hyperbet-api-url <url> Hyperbet backend URL (default: http://localhost:8080)
  --hyperbet-root <path>  Hyperbet monorepo root (auto-detected by default)
  --rtmp-port <n>         RTMP bridge websocket port (default: 8765)
  --capture-browser-port <n> Loopback CDP port for the supervised warm renderer (default: 9223)
  --server-url <url>      Game HTTP base URL (default: http://localhost:5555)
  --ws-url <url>          Game WS URL (default: ws://localhost:5556/ws)
  --client-url <url>      Game client URL (default: http://localhost:3333)
  --remote-betting        Do not start the sibling Hyperbet app (external platform mode)
  --skip-keeper           Skip keeper bot
  --skip-stream           Skip RTMP/HLS bridge process
  --skip-betting          Skip the sibling Hyperbet app
  --skip-bots             Skip duel matchmaker bots
  --with-mm               Start sibling Hyperbet market-maker bot(s) after duel stack is ready
  --mm-mode <mode>        MM startup mode: auto|single|multi (default: auto)
  --mm-config <path>      MM multi-wallet config path (defaults inside the detected Hyperbet repo)
  --mm-stagger-ms <n>     MM multi startup stagger in ms (default: 900)
  --mm-start-delay-ms <n> Delay before MM startup in ms (default: 1000)
  --fresh                 Force fresh restart of game server + client
  --isolated              Fail rather than terminate any pre-existing process
  --verify                Run startup verification checks after boot
  --check-runtimes        Verify exact Hyperia/Hyperbet Bun pins, then exit
  --reuse-game-builds     Require and reuse existing shared/server/client production artifacts
  --verify-timeout-ms <n> Verification timeout in ms (default: 240000)
  --startup-timeout-ms <n> Readiness timeout for game/client/Hyperbet startup (default: 420000)
  --local-smoke           Explicit loopback/no-money diagnostic mode for model-free sparbots
  --local-solana          Own a reset local validator for transaction-enabled Hyperbet tests
  --authority-recovery    Allow one owned game-server hard-kill/restart in the isolated localnet smoke
  --local-solana-rebuild  Rebuild the two SOL programs before starting the local validator
  --local-solana-rpc-port <n> Managed validator RPC port (default: 18899)
  --local-solana-ledger-shreds <n> Retained validator shreds (default: 10000)
  --multi-style-sparbots  Give local no-money sparbots all three frozen combat loadouts
  -v, --verbose           Verbose status logs
`);
  process.exit(0);
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function writeClientRuntimeEnv(distDir, values) {
  fs.mkdirSync(distDir, { recursive: true });
  const envPath = path.join(distDir, "env.js");
  const payload = {
    PUBLIC_API_URL: values.PUBLIC_API_URL,
    PUBLIC_WS_URL: values.PUBLIC_WS_URL,
    PUBLIC_CDN_URL: values.PUBLIC_CDN_URL,
  };
  const serialized = JSON.stringify(payload, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  fs.writeFileSync(
    envPath,
    `// Generated by scripts/duel-stack.mjs\nwindow.env = ${serialized};\n`,
    "utf8",
  );
}

function defaultSolanaRpcUrl(cluster) {
  switch (
    String(cluster || "")
      .trim()
      .toLowerCase()
  ) {
    case "localnet":
    case "local":
      return "http://127.0.0.1:8899";
    case "testnet":
      return "https://api.testnet.solana.com";
    case "devnet":
      return "https://api.devnet.solana.com";
    default:
      return "https://api.mainnet-beta.solana.com";
  }
}

function acquireSingletonLock(lockName) {
  const lockDir = path.join(process.cwd(), ".runtime-locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${lockName}.json`);

  const writeLock = () => {
    const fd = fs.openSync(lockPath, "wx");
    const payload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      command: process.argv.join(" "),
      cwd: process.cwd(),
    };
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.closeSync(fd);
  };

  try {
    writeLock();
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;

    const existing = readLockFile(lockPath);
    const existingPid = Number.parseInt(String(existing?.pid ?? ""), 10);

    if (isProcessAlive(existingPid) && existingPid !== process.pid) {
      console.error(
        `[duel] Another duel stack is already running (pid ${existingPid}). Stop it before launching a new one.`,
      );
      process.exit(1);
    }

    try {
      fs.rmSync(lockPath, { force: true });
      writeLock();
    } catch {
      console.error(
        "[duel] Failed to acquire run lock. Delete .runtime-locks/duel-stack.json and retry.",
      );
      process.exit(1);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readLockFile(lockPath);
    if (Number.parseInt(String(current?.pid ?? ""), 10) === process.pid) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // ignore lock cleanup failures
      }
    }
  };
}

const releaseRunLock = acquireSingletonLock("duel-stack");

const ROOT = process.cwd();
function resolveRuntimePath(configuredPath, fallbackPath) {
  const value = String(configuredPath || "").trim();
  if (!value) return fallbackPath;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

const bettingPort = Number.parseInt(options["betting-port"], 10);
const rtmpPort = Number.parseInt(options["rtmp-port"], 10);
const captureBrowserPort = Number.parseInt(options["capture-browser-port"], 10);
if (
  !Number.isSafeInteger(captureBrowserPort) ||
  captureBrowserPort < 1 ||
  captureBrowserPort > 65_535
) {
  throw new Error("Capture browser port must be an integer from 1 to 65535");
}
const captureBrowserHostEnabled = !/^(0|false|no|off)$/i.test(
  process.env.DUEL_CAPTURE_BROWSER_HOST || "true",
);
const captureBrowserEndpoint = `http://127.0.0.1:${captureBrowserPort}`;
const gameServiceTopology = resolveDuelGameServiceTopology({
  serverUrl: options["server-url"],
  websocketUrl: options["ws-url"],
});
const serverHttpUrl = gameServiceTopology.serverUrl;
const serverWsUrl = gameServiceTopology.websocketUrl;
const clientUrl = options["client-url"].replace(/\/$/, "");
const clientPort = getPortFromUrl(clientUrl);
if (!clientPort) {
  throw new Error("Duel client URL must include a valid HTTP(S) port");
}
const bots = Math.max(2, Number.parseInt(options.bots, 10) || 4);
const verifyEnabled = options.verify === true;
const remoteBettingMode = options["remote-betting"] === true;
const withMarketMaker =
  options["with-mm"] === true ||
  /^(1|true|yes|on)$/i.test(process.env.DUEL_WITH_MM || "");
const mmModeRaw = String(options["mm-mode"] || "auto")
  .trim()
  .toLowerCase();
const mmMode = ["auto", "single", "multi"].includes(mmModeRaw)
  ? mmModeRaw
  : "auto";
const mmStaggerMs = Math.max(
  0,
  Number.parseInt(options["mm-stagger-ms"], 10) || 900,
);
const mmStartDelayMs = Math.max(
  0,
  Number.parseInt(options["mm-start-delay-ms"], 10) || 1000,
);
const hyperbetWorkspace = resolveHyperbetWorkspace({
  workspaceRoot: ROOT,
  configuredRoot: options["hyperbet-root"],
});
const hyperbetRoot =
  hyperbetWorkspace?.root ||
  path.resolve(
    ROOT,
    "..",
    String(options["hyperbet-root"] || "hyperbet-solana-implementation"),
  );
const hyperbetSolanaDir =
  hyperbetWorkspace?.solanaDir ||
  path.join(hyperbetRoot, "packages", "hyperbet-solana");
const hyperbetAppDir =
  hyperbetWorkspace?.appDir || path.join(hyperbetSolanaDir, "app");
const hyperbetKeeperDir =
  hyperbetWorkspace?.keeperDir || path.join(hyperbetSolanaDir, "keeper");
const hyperbetMarketMakerDir =
  hyperbetWorkspace?.marketMakerDir ||
  path.join(hyperbetRoot, "packages", "market-maker-bot");
const hyperbetMarketMakerRelativeDir = path.relative(
  ROOT,
  hyperbetMarketMakerDir,
);
const mmConfigInput = String(options["mm-config"] || "").trim();
const mmConfigPath = mmConfigInput
  ? path.isAbsolute(mmConfigInput)
    ? mmConfigInput
    : path.resolve(ROOT, mmConfigInput)
  : path.join(hyperbetMarketMakerDir, "wallets.generated.json");
const mmConfigExists = fs.existsSync(mmConfigPath);
const hyperbetEnabled = /^(1|true|yes|on)$/i.test(
  process.env.DUEL_WITH_HYPERBET || "",
);
const hyperbetReadOnlyMode = /^(1|true|yes|on)$/i.test(
  process.env.DUEL_HYPERBET_READ_ONLY_MODE || "",
);
const hyperbetAvailable = Boolean(hyperbetWorkspace);
const hyperbetMarketMakerAvailable = fs.existsSync(hyperbetMarketMakerDir);
const skipBettingApp =
  options["skip-betting"] === true || remoteBettingMode || !hyperbetEnabled;
const hyperbetRuntimeEnabled = hyperbetEnabled && !remoteBettingMode;
const hyperbetAppRuntime = resolveHyperbetAppRuntime(
  process.env.DUEL_HYPERBET_APP_RUNTIME,
);
const hyperbetBrowserPerformanceProfile =
  resolveFullTopologyBrowserPerformanceProfile(
    process.env.DUEL_VERIFY_BROWSER_PERFORMANCE_PROFILE,
  );
if (hyperbetBrowserPerformanceProfile && !hyperbetRuntimeEnabled) {
  throw new Error(
    "Full-topology browser performance requires the owned Hyperbet runtime",
  );
}
if (
  hyperbetBrowserPerformanceProfile &&
  hyperbetAppRuntime !== "production_preview"
) {
  throw new Error(
    "Full-topology browser performance requires DUEL_HYPERBET_APP_RUNTIME=production_preview",
  );
}
const manageLocalSolana = options["local-solana"] === true;
const gameBunRuntime = resolvePinnedBunRuntime({
  label: "Hyperia",
  workspaceRoot: ROOT,
  configuredPath: process.env.DUEL_HYPERIA_BUN_PATH,
  processPath: process.execPath,
  pathCommand: "",
});
const hyperbetBunRequired =
  options["check-runtimes"] === true ||
  hyperbetRuntimeEnabled ||
  manageLocalSolana ||
  withMarketMaker;
const hyperbetBunRuntime =
  hyperbetAvailable && hyperbetBunRequired
    ? resolvePinnedBunRuntime({
        label: "Hyperbet",
        workspaceRoot: hyperbetRoot,
        configuredPath: process.env.DUEL_HYPERBET_BUN_PATH,
      })
    : null;
const gameBunPath = gameBunRuntime.path;

if (options["check-runtimes"] === true) {
  console.log(
    JSON.stringify({
      ok: true,
      hyperia: gameBunRuntime,
      hyperbet: hyperbetBunRuntime,
    }),
  );
  releaseRunLock();
  process.exit(0);
}

function requireHyperbetBunPath() {
  if (!hyperbetBunRuntime) {
    throw new Error(
      "Hyperbet Bun runtime is unavailable because its launch workspace was not resolved",
    );
  }
  return hyperbetBunRuntime.path;
}

const HYPERBET_BUN_RUNTIME_PREFIX_ARGS = Object.freeze([
  "--config=/dev/null",
  "--no-install",
]);

function withHyperbetBunRuntimeArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError("Hyperbet Bun runtime arguments must be an array");
  }
  return [...HYPERBET_BUN_RUNTIME_PREFIX_ARGS, ...args];
}
const localSolanaRpcPort = Number.parseInt(
  options["local-solana-rpc-port"],
  10,
);
const localSolanaLedgerShreds = Number.parseInt(
  options["local-solana-ledger-shreds"],
  10,
);
if (
  !Number.isSafeInteger(localSolanaRpcPort) ||
  localSolanaRpcPort < 1024 ||
  localSolanaRpcPort > 65_432
) {
  throw new Error(
    "Local Solana RPC port must be an integer from 1024 to 65532",
  );
}
if (
  !Number.isSafeInteger(localSolanaLedgerShreds) ||
  localSolanaLedgerShreds < 10_000 ||
  localSolanaLedgerShreds > 10_000_000
) {
  throw new Error(
    "Local Solana ledger shreds must be an integer from 10000 to 10000000",
  );
}
const localSolanaWsPort = localSolanaRpcPort + 1;
const localSolanaFaucetPort = localSolanaRpcPort + 2;
const localSolanaGossipPort = localSolanaRpcPort + 3;
const localSolanaDynamicPortStart = localSolanaRpcPort + 100;
const localSolanaDynamicPortEnd = localSolanaDynamicPortStart + 99;
if (localSolanaDynamicPortEnd > 65_535) {
  throw new Error("Local Solana RPC port leaves no valid dynamic port range");
}
const localSolanaRpcUrl = `http://127.0.0.1:${localSolanaRpcPort}`;
const localSolanaWsUrl = `ws://127.0.0.1:${localSolanaWsPort}`;
const authorityRecoveryEnabled = options["authority-recovery"] === true;
const ownedGameServerPidFile = authorityRecoveryEnabled
  ? resolveRuntimePath(process.env.DUEL_GAME_SERVER_PID_FILE, "")
  : null;
const hyperbetTopology = resolveHyperbetRuntimeTopology({
  gameServerUrl: serverHttpUrl,
  hyperbetApiUrl: options["hyperbet-api-url"],
  bettingPort,
});
const verifyTimeoutMs =
  Number.parseInt(options["verify-timeout-ms"], 10) || 240_000;
const startupTimeoutMs =
  Number.parseInt(options["startup-timeout-ms"], 10) || 420_000;
const streamingStateTimeoutMs =
  Number.parseInt(process.env.DUEL_STREAMING_STATE_TIMEOUT_MS || "", 10) ||
  30_000;
const enableMadviseEagainShim =
  process.platform === "linux" &&
  !/^(0|false|no|off)$/i.test(
    process.env.DUEL_ENABLE_MADVISE_EAGAIN_SHIM || "true",
  );
const madviseShimSource = path.join(
  ROOT,
  "scripts/native/madvise-dontdump-shim.c",
);
const madviseShimOutput = path.join(
  ROOT,
  ".runtime-locks",
  "libduel-madvise-shim.so",
);
const DUEL_SOLANA_CANONICAL_PROGRAM_ID =
  "9NdidShnVzy1fc1WHWJTvyuXmH47ynfNGA6QFdyfAuSU";
const KEEPER_AUTHORITY_ENV_NAMES = Object.freeze([
  "KEEPER_FEE_PAYER_KEYPAIR",
  "ORACLE_REPORTER_KEYPAIR",
  "ORACLE_FINALIZER_KEYPAIR",
  "CLOB_MARKET_OPERATOR_KEYPAIR",
  "MARKET_MAKER_KEYPAIR",
  "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
  "CLOB_CONFIG_AUTHORITY_KEYPAIR",
  "BOT_KEYPAIR",
  "ORACLE_AUTHORITY_KEYPAIR",
  "SOLANA_ARENA_AUTHORITY_SECRET",
  "SOLANA_ARENA_REPORTER_SECRET",
  "SOLANA_ARENA_KEEPER_SECRET",
  "DUEL_SOLANA_ARENA_AUTHORITY_SECRET",
  "DUEL_SOLANA_ARENA_REPORTER_SECRET",
  "DUEL_SOLANA_ARENA_KEEPER_SECRET",
]);
const NON_PUBLIC_APP_ENV_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PRIVATE(?:_|$)|KEYPAIR|MNEMONIC|API_KEY)/i;

function toPublicAppEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !NON_PUBLIC_APP_ENV_PATTERN.test(name),
    ),
  );
}

const bettingAppDir = hyperbetAppDir;
const bettingPublicDir = path.join(bettingAppDir, "public");
const serverPublicDir = path.join(ROOT, "packages/server/public");
// Live HLS segments are high-volume, short-lived runtime data. Keep them out
// of the source tree so desktop sync/indexing services cannot contend with the
// renderer and encoder or accidentally upload gigabytes of generated media.
const defaultHlsOutputPath = path.join(
  os.tmpdir(),
  `hyperia-duel-hls-${gameServiceTopology.serverPort}`,
  "stream.m3u8",
);
const configuredHlsOutputPath = process.env.HLS_OUTPUT_PATH?.trim();
const hlsOutputPath = configuredHlsOutputPath
  ? path.isAbsolute(configuredHlsOutputPath)
    ? configuredHlsOutputPath
    : path.resolve(ROOT, configuredHlsOutputPath)
  : defaultHlsOutputPath;
const configuredHlsSegmentPattern = process.env.HLS_SEGMENT_PATTERN?.trim();
const defaultHlsSegmentPattern = path.join(
  path.dirname(hlsOutputPath),
  `${path.basename(hlsOutputPath, path.extname(hlsOutputPath)) || "stream"}-%09d.ts`,
);
const hlsSegmentPattern = configuredHlsSegmentPattern
  ? path.isAbsolute(configuredHlsSegmentPattern)
    ? configuredHlsSegmentPattern
    : path.resolve(ROOT, configuredHlsSegmentPattern)
  : defaultHlsSegmentPattern;
const configuredRtmpStatusFile = process.env.RTMP_STATUS_FILE?.trim();
const defaultRtmpStatusFile = path.join(
  ROOT,
  ".runtime-locks",
  "rtmp-status.json",
);
const rtmpStatusFile = configuredRtmpStatusFile
  ? path.isAbsolute(configuredRtmpStatusFile)
    ? configuredRtmpStatusFile
    : path.resolve(ROOT, configuredRtmpStatusFile)
  : defaultRtmpStatusFile;
const captureBrowserStatusFile = resolveRuntimePath(
  process.env.STREAM_CAPTURE_BROWSER_STATUS_FILE,
  path.join(path.dirname(rtmpStatusFile), "capture-browser-status.json"),
);
const toPublicPath = (baseDir) => {
  const relative = path.relative(baseDir, hlsOutputPath).replace(/\\/g, "/");
  if (relative.startsWith("..")) return null;
  return `/${relative}`;
};
const serverHlsPublicPath = toPublicPath(serverPublicDir);
const bettingHlsPublicPath = toPublicPath(bettingPublicDir);
const hlsUrl = serverHlsPublicPath
  ? `${serverHttpUrl}${serverHlsPublicPath}`
  : bettingHlsPublicPath
    ? `http://localhost:${bettingPort}${bettingHlsPublicPath}`
    : `${serverHttpUrl}/live/stream.m3u8`;
const streamPageUrl = `${clientUrl}/stream.html`;
const defaultStreamCaptureMode = "cdp";
const requestedCaptureMode = (
  process.env.STREAM_CAPTURE_MODE || defaultStreamCaptureMode
)
  .trim()
  .toLowerCase();
function resolveEffectiveCaptureChannel(requestedChannel) {
  if (requestedChannel === "bundled") return "";
  if (process.platform === "linux" && requestedChannel === "chromium") {
    return "chrome-beta";
  }
  if (process.platform === "darwin" && requestedChannel === "chromium") {
    return "chrome";
  }
  return (
    requestedChannel ||
    (process.platform === "linux"
      ? "chrome-beta"
      : process.platform === "darwin"
        ? "chrome"
        : "chrome")
  );
}
const disableBridgeCapture =
  process.env.DUEL_DISABLE_BRIDGE_CAPTURE == null
    ? requestedCaptureMode === "cdp"
    : !/^(0|false|no|off)$/i.test(process.env.DUEL_DISABLE_BRIDGE_CAPTURE);
const bridgeCaptureUrl = `ws://127.0.0.1:${rtmpPort}`;
const streamCaptureUrl = withCaptureParams(streamPageUrl);
const duelNodeEnv = (process.env.DUEL_NODE_ENV || "production")
  .trim()
  .toLowerCase();
const duelRuntimeLogLevel = (
  process.env.DUEL_LOG_LEVEL ||
  process.env.LOG_LEVEL ||
  "warn"
)
  .trim()
  .toLowerCase();
const useExternalAgentPool = options["skip-bots"] !== true;
const defaultDuelServerAgentMode = useExternalAgentPool
  ? "external"
  : "embedded";
const DUEL_LOG_LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const normalizedDuelRuntimeLogLevel =
  duelRuntimeLogLevel === "debug" ||
  duelRuntimeLogLevel === "info" ||
  duelRuntimeLogLevel === "warn" ||
  duelRuntimeLogLevel === "error"
    ? duelRuntimeLogLevel
    : "warn";

const managed = [];
const ownedRuntimePaths = [];
let shuttingDown = false;
let shutdownExitCode = 0;
let managedLocalBrowserWallet = null;
let managedLocalSolanaRoles = null;
const CHILD_OUTPUT_ERROR_PATTERNS = [
  /(^|[^A-Za-z0-9_-])error(?::|\s|$)/i,
  /\b(?:failed|failure|exception|uncaught|unhandled|fatal)\b(?::|\s|$)/i,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|AggregateError|EvalError|URIError)\b(?::|\s|$)/,
  /\bERR_[A-Z0-9_]+\b/,
];
const CHILD_OUTPUT_WARN_PATTERN = /(^|[^A-Za-z0-9_-])warn(?:ing)?(?::|\s|$)/i;
const EXPECTED_BUN_SHUTDOWN_PATTERN =
  /^error: script "[^"]+" (?:was terminated by signal SIGTERM|exited with code 143)\b/i;
const STRUCTURED_SHUTDOWN_EVENT_PATTERN =
  /^\{"event":"shutdown-(?:complete|failed)"[,}]/u;
const duelStackShutdownPolicy = resolveDuelStackShutdownPolicy(process.env);
const childStdoutMode = (
  options.verbose === true
    ? "all"
    : process.env.DUEL_CHILD_STDOUT_MODE || "errors-only"
)
  .trim()
  .toLowerCase();
const childStderrMode = (
  options.verbose === true
    ? "all"
    : process.env.DUEL_CHILD_STDERR_MODE || "errors-only"
)
  .trim()
  .toLowerCase();

function log(message) {
  if (
    options.verbose !== true &&
    DUEL_LOG_LEVEL_PRIORITY.info <
      DUEL_LOG_LEVEL_PRIORITY[normalizedDuelRuntimeLogLevel]
  ) {
    return;
  }
  console.log(`[duel] ${message}`);
}

function warnLog(message) {
  if (
    DUEL_LOG_LEVEL_PRIORITY.warn <
    DUEL_LOG_LEVEL_PRIORITY[normalizedDuelRuntimeLogLevel]
  ) {
    return;
  }
  console.warn(`[duel] ${message}`);
}

function isErrorLikeChildLine(line) {
  for (const pattern of CHILD_OUTPUT_ERROR_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

function shouldForwardChildLine(channel, line) {
  if (STRUCTURED_SHUTDOWN_EVENT_PATTERN.test(line)) return true;
  if (shuttingDown && EXPECTED_BUN_SHUTDOWN_PATTERN.test(line)) {
    return false;
  }
  const mode = channel === "stderr" ? childStderrMode : childStdoutMode;
  if (mode === "off") return false;
  if (mode === "all") return true;
  const isErrorLine = isErrorLikeChildLine(line);
  if (mode === "errors-only") {
    return isErrorLine;
  }
  if (mode === "warn-and-error") {
    return isErrorLine || CHILD_OUTPUT_WARN_PATTERN.test(line);
  }
  return channel === "stderr";
}

function attachPrefixedOutput(stream, prefix, channel) {
  if (!stream) return;
  stream.setEncoding?.("utf8");
  let buffer = "";

  const flushLine = (line) => {
    const trimmedLine = line.replace(/\r$/, "");
    if (!trimmedLine) return;
    if (!shouldForwardChildLine(channel, trimmedLine)) return;
    if (STRUCTURED_SHUTDOWN_EVENT_PATTERN.test(trimmedLine)) {
      const destination =
        channel === "stderr" ? process.stderr : process.stdout;
      destination.write(`${trimmedLine}\n`);
      return;
    }
    if (channel === "stderr") {
      console.error(`${prefix} ${trimmedLine}`);
      return;
    }
    console.log(`${prefix} ${trimmedLine}`);
  };

  stream.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      flushLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  stream.on("end", () => {
    flushLine(buffer);
    buffer = "";
  });
}

function signalProcessTree(proc, signal) {
  if (!proc?.pid) return;

  // Prefer signaling the detached process group so subprocesses are cleaned up.
  try {
    process.kill(-proc.pid, signal);
    return;
  } catch {
    // Fall back to single PID when process groups are unavailable.
  }

  try {
    process.kill(proc.pid, signal);
  } catch {
    // ignore dead/unowned pid
  }
}

function withCacheBust(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set("_ts", String(Date.now()));
    return parsed.toString();
  } catch {
    const joiner = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${joiner}_ts=${Date.now()}`;
  }
}

function withCaptureParams(rawUrl) {
  const params = [];
  if (!disableBridgeCapture) {
    params.push(["bridgeUrl", bridgeCaptureUrl]);
    params.push(["internalCapture", "1"]);
  }
  if (disableBridgeCapture) {
    params.push(["disableBridgeCapture", "1"]);
  }
  if (params.length === 0) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    for (const [key, value] of params) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    const separator = rawUrl.includes("?") ? "&" : "?";
    const query = params
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&");
    return `${rawUrl}${separator}${query}`;
  }
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function uniqueNonEmpty(values) {
  return Array.from(
    new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)),
  );
}

function expandHome(filePath) {
  if (!filePath.startsWith("~/")) return filePath;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home ? path.join(home, filePath.slice(2)) : filePath;
}

function ixDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

let solanaToolDepsPromise = null;

async function getSolanaToolDeps() {
  if (!solanaToolDepsPromise) {
    solanaToolDepsPromise = Promise.all([
      import("@solana/web3.js"),
      import("bs58"),
    ]).then(([web3, bs58Module]) => ({
      ...web3,
      bs58: bs58Module.default ?? bs58Module,
    }));
  }
  return solanaToolDepsPromise;
}

function parseSolanaSecretRef(raw, Keypair, bs58) {
  if (!raw) return null;
  let trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    if (
      trimmed.endsWith(".json") ||
      trimmed.startsWith("~/") ||
      trimmed.startsWith("./") ||
      trimmed.startsWith("../")
    ) {
      const resolvedPath = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(expandHome(trimmed));
      if (fs.existsSync(resolvedPath)) {
        trimmed = fs.readFileSync(resolvedPath, "utf8").trim();
      } else {
        return null;
      }
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
    }

    if (trimmed.includes(",")) {
      return Keypair.fromSecretKey(
        Uint8Array.from(trimmed.split(",").map((part) => Number(part.trim()))),
      );
    }

    try {
      const decoded = bs58.decode(trimmed);
      if (decoded.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(decoded));
      }
    } catch {
      // fall through to base64
    }

    const b64Input = trimmed.startsWith("base64:") ? trimmed.slice(7) : trimmed;
    const decodedB64 = Buffer.from(b64Input.trim(), "base64");
    if (decodedB64.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(decodedB64));
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveUsableSolanaAuthority({ rpcUrl, candidateRefs }) {
  const { Connection, SystemProgram, bs58, Keypair } =
    await getSolanaToolDeps();
  const connection = new Connection(rpcUrl, "confirmed");

  for (const ref of uniqueNonEmpty(candidateRefs)) {
    const signer = parseSolanaSecretRef(ref, Keypair, bs58);
    if (!signer) continue;

    try {
      const accountInfo = await connection.getAccountInfo(signer.publicKey);
      if (!accountInfo) continue;
      if (!accountInfo.owner.equals(SystemProgram.programId)) continue;
      if ((accountInfo.data?.length ?? 0) !== 0) continue;
      if ((accountInfo.lamports ?? 0) < 500_000) continue;

      return {
        secretRef: ref,
        pubkey: signer.publicKey.toBase58(),
        lamports: accountInfo.lamports,
      };
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

async function resolvePredictionMarketProgramId({
  rpcUrl,
  authoritySecretRef,
  candidateProgramIds,
}) {
  if (!authoritySecretRef) return null;

  const {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    bs58,
  } = await getSolanaToolDeps();
  const signer = parseSolanaSecretRef(authoritySecretRef, Keypair, bs58);
  if (!signer) return null;

  const connection = new Connection(rpcUrl, "confirmed");
  const roundSeed = createHash("sha256")
    .update(`duel-stack-program-check:${Date.now()}:${Math.random()}`)
    .digest();

  for (const candidate of uniqueNonEmpty([
    ...candidateProgramIds,
    DUEL_SOLANA_CANONICAL_PROGRAM_ID,
  ])) {
    try {
      const programId = new PublicKey(candidate);
      const programInfo = await connection.getAccountInfo(programId);
      if (!programInfo?.executable) continue;

      const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config", "utf8")],
        programId,
      );
      const [oraclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("oracle", "utf8"), roundSeed],
        programId,
      );
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: signer.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPda, isSigner: false, isWritable: false },
          { pubkey: oraclePda, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.concat([ixDiscriminator("init_oracle_round"), roundSeed]),
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = signer.publicKey;

      const simulation = await connection.simulateTransaction(tx, [signer]);
      if (simulation.value.err) continue;

      return {
        programId: candidate,
        signerPubkey: signer.publicKey.toBase58(),
      };
    } catch {
      // Try the next candidate program id.
    }
  }

  return null;
}

async function resolveKeeperProgramReadiness({ rpcUrl, deployment }) {
  const { Connection, PublicKey } = await getSolanaToolDeps();
  const connection = new Connection(rpcUrl, "confirmed");
  const missing = [];

  const requiredPrograms = [
    {
      name: "fight oracle",
      programId: deployment.fightOracleProgramId,
    },
    {
      name: "duel market",
      programId: deployment.duelMarketProgramId,
    },
  ];
  for (const target of requiredPrograms) {
    try {
      const info = await connection.getAccountInfo(
        new PublicKey(target.programId),
      );
      if (!info?.executable) {
        missing.push(target.name);
      }
    } catch {
      missing.push(target.name);
    }
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

const PROCESS_QUERY_TIMEOUT_MS = 2_000;

function escapeProcessQueryPattern(pattern) {
  return pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function listProcessIdsMatchingPattern(pattern) {
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", escapeProcessQueryPattern(pattern)],
      {
        encoding: "utf8",
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 1
    ) {
      return [];
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not enumerate stale processes within ${PROCESS_QUERY_TIMEOUT_MS}ms: ${detail}`,
    );
  }
}

async function terminateProcessesByCommandPatterns(patterns, label) {
  const matchedPids = Array.from(
    new Set(
      patterns.flatMap((pattern) => listProcessIdsMatchingPattern(pattern)),
    ),
  ).filter((pid) => pid !== process.pid);

  if (matchedPids.length === 0) return;

  assertProcessTerminationAllowed({
    isolated: options.isolated,
    label,
    pids: matchedPids,
  });

  log(
    `found ${matchedPids.length} stale ${label} process(es): ${matchedPids.join(", ")} - terminating`,
  );

  for (const pid of matchedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore dead/unowned pid
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));

  for (const pid of matchedPids) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore dead/unowned pid
    }
  }
}

function prepareHlsOutput(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".m3u8") || file.endsWith(".ts")) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch {
        // ignore stale file cleanup errors
      }
    }
  }

  const hlsTargetDuration = Math.max(
    1,
    Number.parseInt(process.env.HLS_TIME_SECONDS || "1", 10) || 1,
  );
  const hlsStartNumber = Math.max(
    0,
    Number.parseInt(process.env.HLS_START_NUMBER || "0", 10) || 0,
  );
  const bootstrapManifest = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-ALLOW-CACHE:YES",
    `#EXT-X-TARGETDURATION:${hlsTargetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${hlsStartNumber}`,
    "#EXT-X-INDEPENDENT-SEGMENTS",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, bootstrapManifest, "utf8");
}

function ensureMadviseEagainShim() {
  if (!enableMadviseEagainShim) return null;
  if (!fs.existsSync(madviseShimSource)) {
    warnLog(
      `madvise shim source not found at ${madviseShimSource}; continuing without shim`,
    );
    return null;
  }

  fs.mkdirSync(path.dirname(madviseShimOutput), { recursive: true });

  let needsBuild = !fs.existsSync(madviseShimOutput);
  if (!needsBuild) {
    try {
      const srcStat = fs.statSync(madviseShimSource);
      const outStat = fs.statSync(madviseShimOutput);
      needsBuild = srcStat.mtimeMs > outStat.mtimeMs;
    } catch {
      needsBuild = true;
    }
  }

  if (needsBuild) {
    try {
      execFileSync(
        "cc",
        [
          "-shared",
          "-fPIC",
          "-O2",
          "-Wall",
          "-Wextra",
          "-o",
          madviseShimOutput,
          madviseShimSource,
          "-ldl",
        ],
        { stdio: "pipe" },
      );
      log(`compiled madvise EAGAIN shim at ${madviseShimOutput}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnLog(
        `failed to compile madvise shim (${reason}); continuing without shim`,
      );
      return null;
    }
  }

  return madviseShimOutput;
}

function spawnManaged(name, command, args, opts = {}) {
  const {
    critical = true,
    restart = false,
    restartDelayMs = 3000,
    maxRestarts = restart ? Number.POSITIVE_INFINITY : 0,
    cleanupProcessGroupOnExit = false,
    onLaunch = null,
    onUnexpectedExit = null,
    ...spawnOptions
  } = opts;

  const entry = {
    name,
    command,
    args,
    spawnOptions,
    critical,
    restart,
    restartDelayMs: Math.max(
      250,
      Number.isFinite(restartDelayMs) ? restartDelayMs : 3000,
    ),
    maxRestarts:
      Number.isFinite(maxRestarts) && maxRestarts >= 0
        ? Math.floor(maxRestarts)
        : Number.POSITIVE_INFINITY,
    cleanupProcessGroupOnExit,
    onLaunch,
    onUnexpectedExit,
    restarts: 0,
    restartTimer: null,
    proc: null,
    lastProc: null,
    shutdownMonitor: null,
  };

  const launch = () => {
    if (shuttingDown) return;

    const shutdownPolicy =
      name === "game-server"
        ? resolveDuelStackShutdownPolicy(entry.spawnOptions.env || process.env)
        : null;
    const runtimePath =
      command === process.execPath ? process.execPath : command;
    const proc = spawn(runtimePath, args, {
      cwd: ROOT,
      env: entry.env || process.env,
      stdio: [
        "ignore",
        childStdoutMode === "off" ? "ignore" : "pipe",
        childStderrMode === "off" ? "ignore" : "pipe",
      ],
      detached: true,
      ...entry.spawnOptions,
      // Shutdown is a protocol, not optional logging. Keep these pipes even
      // when either display mode is off, and observe before prefix/filtering.
      ...(name === "game-server" ? { stdio: ["ignore", "pipe", "pipe"] } : {}),
    });
    entry.proc = proc;
    entry.lastProc = proc;
    if (name === "game-server") {
      entry.shutdownMonitor = observeGameServerShutdown(proc, shutdownPolicy);
    }

    if (typeof entry.onLaunch === "function") {
      try {
        entry.onLaunch({ pid: proc.pid });
      } catch (error) {
        console.error(
          `[${name}] failed to publish its owned launch state: ${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        void shutdown(1);
        return;
      }
    }

    const prefix = `[${name}]`;
    attachPrefixedOutput(proc.stdout, prefix, "stdout");
    attachPrefixedOutput(proc.stderr, prefix, "stderr");
    proc.on("error", (error) => {
      console.error(`${prefix} process error: ${error.message}`);
      if (!shuttingDown && entry.critical) void shutdown(1);
      else if (shuttingDown) shutdownExitCode = 1;
    });
    proc.on("exit", (code, signal) => {
      entry.proc = null;
      if (shuttingDown) return;

      // A detached service can own browser, encoder, shell, or Xvfb children.
      // If its leader exits unexpectedly, terminate only that still-owned
      // process group before a replacement can race stale listeners or files.
      if (entry.cleanupProcessGroupOnExit && process.platform !== "win32") {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // No descendants remain in the owned process group.
        }
      }

      if (typeof entry.onUnexpectedExit === "function") {
        try {
          entry.onUnexpectedExit({ code, signal, pid: proc.pid });
        } catch (error) {
          console.error(
            `${prefix} failed to publish its unavailable state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const canRestart =
        entry.restart &&
        (entry.restarts < entry.maxRestarts ||
          entry.maxRestarts === Number.POSITIVE_INFINITY);

      if (canRestart) {
        entry.restarts += 1;
        console.warn(
          `${prefix} exited (code=${code ?? "null"} signal=${signal ?? "null"}) - restarting in ${entry.restartDelayMs}ms (attempt ${entry.restarts})`,
        );
        entry.restartTimer = setTimeout(() => {
          entry.restartTimer = null;
          launch();
        }, entry.restartDelayMs);
        return;
      }

      if (!entry.critical) {
        console.warn(
          `${prefix} exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
        );
        return;
      }
      console.error(
        `${prefix} exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"})`,
      );
      void shutdown(1);
    });
  };

  managed.push(entry);
  launch();
  return entry;
}

let ownedGameServerGeneration = 0;

function publishOwnedGameServerState(input) {
  if (!ownedGameServerPidFile) return;
  const payload = {
    schemaVersion: 1,
    launcherPid: process.pid,
    generation: ownedGameServerGeneration,
    pid: input.pid,
    available: input.available,
    startedAtMs: input.startedAtMs,
    exitedAtMs: input.exitedAtMs ?? null,
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
  };
  fs.mkdirSync(path.dirname(ownedGameServerPidFile), { recursive: true });
  const temporaryPath = `${ownedGameServerPidFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, ownedGameServerPidFile);
}

function isCurrentOwnedGameServerGeneration(pid, generation) {
  if (!ownedGameServerPidFile) return false;
  try {
    const state = JSON.parse(fs.readFileSync(ownedGameServerPidFile, "utf8"));
    return (
      state?.schemaVersion === 1 &&
      state?.launcherPid === process.pid &&
      state?.available === true &&
      state?.pid === pid &&
      state?.generation === generation
    );
  } catch {
    return false;
  }
}

function publishCaptureSupervisorUnavailableStatus() {
  const payload = buildCaptureSupervisorUnavailableStatus(Date.now());
  fs.mkdirSync(path.dirname(rtmpStatusFile), { recursive: true });
  const temporaryPath = `${rtmpStatusFile}.supervisor-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, rtmpStatusFile);
}

async function runCommand(name, command, args, opts = {}) {
  const {
    captureStdout = false,
    timeoutMs = null,
    terminationGraceMs = 5_000,
    ...spawnOptions
  } = opts;
  const proc = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: [
      "ignore",
      childStdoutMode === "off" ? "ignore" : "pipe",
      childStderrMode === "off" ? "ignore" : "pipe",
    ],
    ...spawnOptions,
  });

  const prefix = `[${name}]`;
  let capturedStdout = "";
  if (captureStdout && proc.stdout) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      capturedStdout += chunk;
    });
  }
  attachPrefixedOutput(proc.stdout, prefix, "stdout");
  attachPrefixedOutput(proc.stderr, prefix, "stderr");
  await waitForBoundedChildExit(proc, {
    label: name,
    timeoutMs,
    terminationGraceMs,
  });
  return captureStdout ? capturedStdout : undefined;
}

function resolveLocalSolanaTool(toolName) {
  const configuredBinDir = String(
    process.env.SOLANA_ACTIVE_RELEASE_BIN || "",
  ).trim();
  const candidates = uniqueNonEmpty([
    configuredBinDir ? path.join(configuredBinDir, toolName) : "",
    path.join(
      os.homedir(),
      ".local",
      "share",
      "solana",
      "install",
      "active_release",
      "bin",
      toolName,
    ),
  ]);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const resolved = execFileSync("which", [toolName], {
      encoding: "utf8",
    }).trim();
    if (resolved) return resolved;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error(
    `Managed local Solana requires ${toolName}; install the pinned Agave CLI or set SOLANA_ACTIVE_RELEASE_BIN`,
  );
}

function resolveLocalSolanaWalletPath() {
  const candidates = uniqueNonEmpty([
    process.env.DUEL_LOCAL_SOLANA_WALLET,
    process.env.ANCHOR_WALLET,
    "~/.config/solana/hyperia-keys/deployer.json",
    "~/.config/solana/id.json",
  ]);
  for (const candidate of candidates) {
    const expanded = expandHome(candidate);
    const resolved = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(ROOT, expanded);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error(
    `Managed local Solana requires a bootstrap keypair; checked ${candidates.join(", ")}`,
  );
}

function validateLocalSolanaArtifacts(deployment) {
  const anchorDir = path.join(hyperbetSolanaDir, "anchor");
  const programs = [
    {
      name: "fight oracle",
      id: deployment.fightOracleProgramId,
      artifact: "fight_oracle",
    },
    {
      name: "duel market",
      id: deployment.duelMarketProgramId,
      artifact: "duel_market",
    },
  ];
  return programs.map((program) => {
    const binaryPath = path.join(
      anchorDir,
      "target",
      "deploy",
      `${program.artifact}.so`,
    );
    const idlPath = path.join(
      anchorDir,
      "target",
      "idl",
      `${program.artifact}.json`,
    );
    if (!fs.existsSync(binaryPath) || !fs.existsSync(idlPath)) {
      throw new Error(
        `Managed local Solana is missing the ${program.name} build artifacts; pass --local-solana-rebuild`,
      );
    }
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    const idlAddress = String(
      idl.address || idl.metadata?.address || "",
    ).trim();
    if (idlAddress !== program.id) {
      throw new Error(
        `Managed local Solana ${program.name} IDL address ${idlAddress || "<missing>"} does not match registry ${program.id}`,
      );
    }
    return { ...program, binaryPath };
  });
}

async function waitForManagedLocalSolana(deployment, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const requiredProgramIds = [
    deployment.fightOracleProgramId,
    deployment.duelMarketProgramId,
  ];
  while (Date.now() < deadline) {
    try {
      const health = await fetchJsonWithTimeout(localSolanaRpcUrl, {
        requestTimeoutMs: 2_000,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getHealth",
        }),
      });
      if (!health.response.ok || health.payload?.result !== "ok") {
        throw new Error("validator not healthy");
      }

      let allExecutable = true;
      for (const programId of requiredProgramIds) {
        const account = await fetchJsonWithTimeout(localSolanaRpcUrl, {
          requestTimeoutMs: 2_000,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getAccountInfo",
            params: [programId, { encoding: "base64" }],
          }),
        });
        if (
          !account.response.ok ||
          account.payload?.result?.value?.executable !== true
        ) {
          allExecutable = false;
          break;
        }
      }
      if (allExecutable) return;
    } catch {
      // Retry while the validator initializes its ledger and programs.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Managed local Solana did not expose both executable programs at ${localSolanaRpcUrl} within ${timeoutMs}ms`,
  );
}

async function waitForManagedLocalSolanaProgramDispatch(input) {
  const deadline = Date.now() + Math.min(input.timeoutMs, 120_000);
  let attempt = 0;
  let lastError = null;
  const args = withHyperbetBunRuntimeArgs([
    input.scriptPath,
    "--cluster",
    "localnet",
    "--rpc-url",
    localSolanaRpcUrl,
    "--wallet",
    input.walletPath,
    "--oracle-dispute-window-secs",
    input.configuration.oracleDisputeWindowSeconds,
    "--trade-treasury-fee-bps",
    input.configuration.tradeTreasuryFeeBps,
    "--trade-market-maker-fee-bps",
    input.configuration.tradeMarketMakerFeeBps,
    "--winnings-market-maker-fee-bps",
    input.configuration.winningsMarketMakerFeeBps,
    "--reporter",
    input.roles.reporter,
    "--finalizer",
    input.roles.finalizer,
    "--challenger",
    input.roles.challenger,
    "--market-operator",
    input.roles.marketOperator,
    "--treasury",
    input.roles.treasury,
    "--market-maker",
    input.roles.marketMaker,
  ]);

  while (Date.now() < deadline) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    try {
      await runCommand(
        "solana-program-readiness",
        requireHyperbetBunPath(),
        args,
        { timeoutMs: Math.max(1_000, Math.min(15_000, remainingMs)) },
      );
      log(
        `managed local SOL programs accepted simulated instructions after ${attempt} attempt(s)`,
      );
      return;
    } catch (error) {
      lastError = error;
      const waitMs = Math.min(1_000, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  throw new Error(
    `Managed local SOL programs did not become dispatch-ready at ${localSolanaRpcUrl} after ${attempt} attempt(s)`,
    { cause: lastError },
  );
}

async function startManagedLocalSolana() {
  const deployment = resolveHyperbetSolanaDeployment({
    solanaDir: hyperbetSolanaDir,
    cluster: "localnet",
  });
  if (options["local-solana-rebuild"] === true) {
    log("rebuilding the two Hyperbet SOL programs for managed localnet...");
    await runCommand(
      "solana-build",
      requireHyperbetBunPath(),
      withHyperbetBunRuntimeArgs([
        "run",
        "--cwd",
        path.relative(ROOT, hyperbetSolanaDir),
        "anchor:build",
      ]),
      { cwd: ROOT },
    );
  }
  const programs = validateLocalSolanaArtifacts(deployment);
  const launchConfigScriptPath = path.join(
    hyperbetSolanaDir,
    "scripts/init-pm-config.ts",
  );
  const programReadinessScriptPath = path.join(
    hyperbetSolanaDir,
    "scripts/probe-program-readiness.ts",
  );
  await runCommand(
    "solana-launch-config-runtime-preflight",
    requireHyperbetBunPath(),
    withHyperbetBunRuntimeArgs([launchConfigScriptPath, "--help"]),
    { timeoutMs: Math.min(240_000, startupTimeoutMs) },
  );
  await runCommand(
    "solana-program-readiness-runtime-preflight",
    requireHyperbetBunPath(),
    withHyperbetBunRuntimeArgs([programReadinessScriptPath, "--help"]),
    { timeoutMs: Math.min(240_000, startupTimeoutMs) },
  );
  const validatorBinary = resolveLocalSolanaTool("solana-test-validator");
  const keygenBinary = resolveLocalSolanaTool("solana-keygen");
  const walletPath = resolveLocalSolanaWalletPath();
  const mintAuthority = execFileSync(keygenBinary, ["pubkey", walletPath], {
    encoding: "utf8",
  }).trim();
  if (!mintAuthority) {
    throw new Error("Managed local Solana could not resolve the wallet pubkey");
  }

  for (const port of [
    localSolanaRpcPort,
    localSolanaWsPort,
    localSolanaFaucetPort,
    localSolanaGossipPort,
  ]) {
    const listeners = getListeningPids(port);
    if (listeners.length > 0) {
      throw new Error(
        `Managed local Solana port ${port} is already occupied by pid(s) ${listeners.join(", ")}`,
      );
    }
  }

  const ledgerDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `hyperia-duel-solana-${localSolanaRpcPort}-`),
  );
  ownedRuntimePaths.push(ledgerDir);
  const programArgs = programs.flatMap((program) => [
    "--upgradeable-program",
    program.id,
    program.binaryPath,
    walletPath,
  ]);
  log(`starting managed SOL localnet at ${localSolanaRpcUrl}...`);
  spawnManaged(
    "solana-localnet",
    validatorBinary,
    [
      "--reset",
      "--quiet",
      "--rpc-port",
      String(localSolanaRpcPort),
      "--faucet-port",
      String(localSolanaFaucetPort),
      "--gossip-port",
      String(localSolanaGossipPort),
      "--dynamic-port-range",
      `${localSolanaDynamicPortStart}-${localSolanaDynamicPortEnd}`,
      "--mint",
      mintAuthority,
      "--ledger",
      ledgerDir,
      "--limit-ledger-size",
      String(localSolanaLedgerShreds),
      ...programArgs,
    ],
    { cleanupProcessGroupOnExit: true },
  );
  await waitForManagedLocalSolana(deployment, startupTimeoutMs);
  const { Connection, Keypair, LAMPORTS_PER_SOL } = await getSolanaToolDeps();
  const browserWallet = Keypair.generate();
  const managedRoleKeypairs = Object.fromEntries(
    [
      "feePayer",
      "reporter",
      "finalizer",
      "challenger",
      "marketOperator",
      "treasury",
      "marketMaker",
    ].map((role) => [role, Keypair.generate()]),
  );
  const localOracleDisputeWindowSeconds =
    process.env.DUEL_LOCAL_SOLANA_ORACLE_DISPUTE_WINDOW_SECS || "60";
  const localFeePolicy = {
    tradeTreasuryFeeBps:
      process.env.DUEL_LOCAL_SOLANA_TRADE_TREASURY_FEE_BPS || "100",
    tradeMarketMakerFeeBps:
      process.env.DUEL_LOCAL_SOLANA_TRADE_MARKET_MAKER_FEE_BPS || "100",
    winningsMarketMakerFeeBps:
      process.env.DUEL_LOCAL_SOLANA_WINNINGS_MARKET_MAKER_FEE_BPS || "200",
  };
  await waitForManagedLocalSolanaProgramDispatch({
    scriptPath: programReadinessScriptPath,
    walletPath,
    timeoutMs: startupTimeoutMs,
    configuration: {
      oracleDisputeWindowSeconds: localOracleDisputeWindowSeconds,
      ...localFeePolicy,
    },
    roles: {
      reporter: managedRoleKeypairs.reporter.publicKey.toBase58(),
      finalizer: managedRoleKeypairs.finalizer.publicKey.toBase58(),
      challenger: managedRoleKeypairs.challenger.publicKey.toBase58(),
      marketOperator: managedRoleKeypairs.marketOperator.publicKey.toBase58(),
      treasury: managedRoleKeypairs.treasury.publicKey.toBase58(),
      marketMaker: managedRoleKeypairs.marketMaker.publicKey.toBase58(),
    },
  });
  const connection = new Connection(localSolanaRpcUrl, "confirmed");
  const fundWallet = async (wallet, lamports, label) => {
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const signature = await connection.requestAirdrop(
      wallet.publicKey,
      lamports,
    );
    await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );
    const balance = await connection.getBalance(wallet.publicKey, "confirmed");
    if (balance < lamports) {
      throw new Error(
        `Managed local ${label} funding is incomplete: ${balance}/${lamports}`,
      );
    }
    return balance;
  };
  const airdropLamports = 2 * LAMPORTS_PER_SOL;
  const fundedLamports = await fundWallet(
    browserWallet,
    airdropLamports,
    "browser wallet",
  );
  const roleFundingLamports = 10 * LAMPORTS_PER_SOL;
  await Promise.all(
    Object.entries(managedRoleKeypairs).map(([role, keypair]) =>
      fundWallet(keypair, roleFundingLamports, `${role} role`),
    ),
  );
  managedLocalBrowserWallet = {
    publicKey: browserWallet.publicKey.toBase58(),
    secretKey: Array.from(browserWallet.secretKey).join(","),
    fundedLamports,
  };
  const managedRoleKeypairDirectory = path.join(
    ledgerDir,
    "launch-role-keypairs",
  );
  managedLocalSolanaRoles = Object.fromEntries(
    Object.entries(managedRoleKeypairs).map(([role, keypair]) => [
      role,
      {
        publicKey: keypair.publicKey.toBase58(),
        secretRef: writeEphemeralSolanaKeypairFile({
          directory: managedRoleKeypairDirectory,
          role,
          secretKey: keypair.secretKey,
        }),
      },
    ]),
  );

  const launchConfigEvidencePath = path.join(
    ledgerDir,
    "frozen-launch-config.json",
  );
  const launchConfigEnv = bindPinnedBunToEnvironment(
    {
      ...process.env,
      SOLANA_RPC_URL: localSolanaRpcUrl,
      SOLANA_STAGE_A_WALLET_PATH: walletPath,
      SOLANA_EXPECTED_UPGRADE_AUTHORITY: mintAuthority,
      SOLANA_LAUNCH_FEE_POLICY_APPROVED: "true",
      SOLANA_LAUNCH_CONFIG_FREEZE_APPROVED: "true",
      SOLANA_ORACLE_DISPUTE_WINDOW_SECS: localOracleDisputeWindowSeconds,
      TRADE_TREASURY_FEE_BPS: localFeePolicy.tradeTreasuryFeeBps,
      TRADE_MARKET_MAKER_FEE_BPS: localFeePolicy.tradeMarketMakerFeeBps,
      WINNINGS_MARKET_MAKER_FEE_BPS: localFeePolicy.winningsMarketMakerFeeBps,
      SOLANA_PM_REPORTER_PUBKEY: managedLocalSolanaRoles.reporter.publicKey,
      SOLANA_PM_FINALIZER_PUBKEY: managedLocalSolanaRoles.finalizer.publicKey,
      SOLANA_PM_CHALLENGER_PUBKEY: managedLocalSolanaRoles.challenger.publicKey,
      SOLANA_PM_MARKET_OPERATOR_PUBKEY:
        managedLocalSolanaRoles.marketOperator.publicKey,
      SOLANA_PM_TREASURY_PUBKEY: managedLocalSolanaRoles.treasury.publicKey,
      SOLANA_PM_MARKET_MAKER_PUBKEY:
        managedLocalSolanaRoles.marketMaker.publicKey,
    },
    requireHyperbetBunPath(),
  );
  const launchConfigArgs = [
    launchConfigScriptPath,
    "--cluster",
    "localnet",
    "--freeze",
    "--out",
    launchConfigEvidencePath,
  ];
  await runCommand(
    "solana-launch-config",
    requireHyperbetBunPath(),
    withHyperbetBunRuntimeArgs(launchConfigArgs),
    {
      env: launchConfigEnv,
      timeoutMs: Math.min(120_000, startupTimeoutMs),
    },
  );
  const frozenLaunchConfig = JSON.parse(
    fs.readFileSync(launchConfigEvidencePath, "utf8"),
  );
  if (
    frozenLaunchConfig?.programs?.fightOracle?.frozen !== true ||
    frozenLaunchConfig?.programs?.duelMarket?.frozen !== true
  ) {
    throw new Error(
      "Managed local Solana launch policy did not permanently freeze both program configurations",
    );
  }
  managedLocalSolanaRoles.feePolicy = localFeePolicy;
  log(
    `managed SOL localnet ready: oracle=${deployment.fightOracleProgramId} market=${deployment.duelMarketProgramId}`,
  );
  log("managed local SOL launch roles configured and permanently frozen");
  log(
    `managed local browser wallet ready: ${managedLocalBrowserWallet.publicKey} (${fundedLamports} diagnostic lamports)`,
  );
  return deployment;
}

async function waitForHttp(url, label, timeoutMs = 180_000) {
  const timeoutWindowMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000;
  const maxAttempts = Math.max(1, Math.ceil(timeoutWindowMs / 1_000));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        log(`${label} ready at ${url}`);
        return;
      }
    } catch {
      // retry
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function waitForStableHttp(
  url,
  label,
  timeoutMs = 180_000,
  requiredConsecutiveSuccesses = 3,
) {
  const timeoutWindowMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000;
  const deadlineMs = Date.now() + timeoutWindowMs;
  const required = Math.max(1, Math.floor(requiredConsecutiveSuccesses));
  let consecutiveSuccesses = 0;

  while (Date.now() < deadlineMs) {
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 2_000);
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      consecutiveSuccesses = response.ok ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= required) {
        log(`${label} stable at ${url}`);
        return;
      }
    } catch {
      consecutiveSuccesses = 0;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not remain ready at ${url}`);
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(250, options.requestTimeoutMs || 2_000),
  );
  try {
    const { requestTimeoutMs: _requestTimeoutMs, ...fetchOptions } = options;
    const response = await fetch(url, {
      cache: "no-store",
      ...fetchOptions,
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Callers decide whether a JSON payload is required.
    }
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

const STANDALONE_SPARBOT_NAMES = Object.freeze([
  "Riven Ash",
  "Astra Vale",
  "Nyra Swift",
  "Orin Vale",
  "Kael Ember",
  "Mira Thorn",
  "Tarin Frost",
  "Vera Dawn",
  "Dax Hollow",
  "Lyra Stone",
  "Corin Wren",
  "Sera Flint",
  "Bram Tide",
  "Iris Voss",
  "Nox Reed",
  "Eira Moon",
  "Finn Gale",
  "Zara Pike",
  "Arin Moss",
  "Luna Cross",
]);

async function seedStandaloneSparbots(
  serverUrl,
  adminCode,
  styles,
  timeoutMs,
  multiStyle = false,
  profileSeed = null,
) {
  const endpoint = `${serverUrl}/admin/sparbots`;
  const count = styles.length;
  const timeoutWindowMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000;
  const maxAttempts = Math.max(1, Math.ceil(timeoutWindowMs / 1_000));
  let lastStatus = null;
  let lastError = "server not ready";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let spawnedThisAttempt = 0;
    try {
      const spawned = [];
      const oneUniformStyle = styles.every((style) => style === styles[0]);
      const requests = oneUniformStyle
        ? [
            {
              style: styles[0],
              count,
              names: STANDALONE_SPARBOT_NAMES.slice(0, count),
            },
          ]
        : styles.map((style, index) => ({
            style,
            count: 1,
            names: [STANDALONE_SPARBOT_NAMES[index]],
          }));

      let retryable = false;
      for (const request of requests) {
        const { response, payload } = await fetchJsonWithTimeout(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-code": adminCode,
          },
          body: JSON.stringify({
            ...request,
            tier: "adept",
            multiStyle,
            ...(profileSeed == null ? {} : { profileSeed }),
          }),
          requestTimeoutMs: 10_000,
        });
        lastStatus = response.status;
        if (
          response.ok &&
          isStandaloneSparbotBootstrap(payload, request.count)
        ) {
          spawned.push(...payload.spawned);
          spawnedThisAttempt = spawned.length;
          continue;
        }
        lastError =
          typeof payload?.error === "string"
            ? payload.error
            : "invalid sparbot bootstrap response";
        retryable = response.status === 503 && spawned.length === 0;
        break;
      }

      const aggregate = { success: true, spawned };
      if (isStandaloneSparbotBootstrap(aggregate, count)) {
        log(
          `standalone scripted sparbots ready (${count}/${count}; ${styles.join(",")})`,
        );
        return aggregate;
      }
      if (!retryable) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (spawnedThisAttempt > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const statusSuffix = lastStatus == null ? "" : ` (last HTTP ${lastStatus})`;
  throw new Error(
    `standalone scripted sparbots did not become ready at ${endpoint}${statusSuffix}: ${lastError}`,
  );
}

async function waitForJson(
  url,
  label,
  predicate,
  { timeoutMs = 180_000, headers } = {},
) {
  const timeoutWindowMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000;
  const maxAttempts = Math.max(1, Math.ceil(timeoutWindowMs / 1_000));
  let lastStatus = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { response, payload } = await fetchJsonWithTimeout(url, {
        headers,
      });
      lastStatus = response.status;
      if (response.ok && predicate(payload)) {
        log(`${label} ready at ${url}`);
        return payload;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const statusSuffix = lastStatus == null ? "" : ` (last HTTP ${lastStatus})`;
  throw new Error(`${label} did not become ready at ${url}${statusSuffix}`);
}

async function waitForJsonFile(
  filePath,
  label,
  predicate,
  { timeoutMs = 180_000 } = {},
) {
  const timeoutWindowMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000;
  const maxAttempts = Math.max(1, Math.ceil(timeoutWindowMs / 500));
  let lastError = "status file not available";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (predicate(payload)) {
        log(`${label} ready`);
        return payload;
      }
      lastError = "latest status was not ready";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function setDuelMaintenanceMode(
  serverUrl,
  adminCode,
  enabled,
  timeoutMs = 180_000,
) {
  const action = enabled ? "enter" : "exit";
  const endpoint = `${serverUrl}/admin/maintenance/${action}`;
  const { response, payload } = await fetchJsonWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-code": adminCode,
    },
    // Fastify rejects an empty request body when application/json is declared.
    // Send an explicit object for both maintenance actions so the startup gate
    // release follows the same valid JSON contract as the engage request.
    body: JSON.stringify(
      enabled
        ? {
            reason: "duel-stack startup readiness gate",
            timeoutMs,
          }
        : {},
    ),
    requestTimeoutMs: enabled ? timeoutMs + 5_000 : 10_000,
  });
  if (
    !response.ok ||
    payload?.success !== true ||
    payload?.status?.active !== enabled
  ) {
    const detail =
      typeof payload?.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(
      `could not ${enabled ? "engage" : "release"} the duel startup maintenance gate: ${detail}`,
    );
  }
  log(
    enabled
      ? "duel scheduler held for startup readiness"
      : "duel scheduler released after startup readiness",
  );
  return payload.status;
}

async function releaseRestartedAuthorityStartupGate({
  pid,
  generation,
  healthUrl,
  streamingStateUrl,
  startupTimeoutMs,
  streamingStateTimeoutMs,
  serverUrl,
  adminCode,
}) {
  await waitForHttp(
    healthUrl,
    `replacement game server generation ${generation}`,
    startupTimeoutMs,
  );
  await waitForHttp(
    streamingStateUrl,
    `replacement streaming authority generation ${generation}`,
    streamingStateTimeoutMs,
  );
  if (!isCurrentOwnedGameServerGeneration(pid, generation)) return;
  await setDuelMaintenanceMode(serverUrl, adminCode, false, startupTimeoutMs);
  if (!isCurrentOwnedGameServerGeneration(pid, generation)) {
    throw new Error(
      `replacement game server generation ${generation} changed while releasing its startup gate`,
    );
  }
  log(`replacement game server generation ${generation} released`);
}

async function verifyAuthenticatedBettingFeed(topology, bearerToken) {
  const unauthenticated = await fetchJsonWithTimeout(
    topology.bettingFeedStateUrl,
  );
  if (unauthenticated.response.status !== 401) {
    throw new Error(
      `internal betting feed did not reject an unauthenticated bootstrap request (HTTP ${unauthenticated.response.status})`,
    );
  }

  await waitForJson(
    topology.bettingFeedStateUrl,
    "authenticated internal betting feed",
    isBettingFeedBootstrap,
    {
      timeoutMs: streamingStateTimeoutMs,
      headers: { authorization: `Bearer ${bearerToken}` },
    },
  );
}

async function waitForLiveHls(url, timeoutMs = 180_000) {
  const timeoutWindowMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000;
  const maxAttempts = Math.max(1, Math.ceil(timeoutWindowMs / 1_000));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(withCacheBust(url), {
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.ok) {
        const manifest = await res.text();
        const hasHeader = manifest.includes("#EXTM3U");
        const hasSegments =
          /#EXTINF:/m.test(manifest) && /\.(ts|m4s|mp4)(\?|$)/m.test(manifest);
        if (hasHeader && hasSegments) {
          log(`live HLS stream ready at ${url}`);
          return;
        }
      }
    } catch {
      // retry
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (attempt % 15 === 0) {
      log(`waiting for live HLS segments at ${url} (attempt ${attempt})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`live HLS stream did not become ready at ${url}`);
}

async function isHttpReady(url, timeoutMs = 2_000) {
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getPortFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port) {
      const parsedPort = Number.parseInt(parsed.port, 10);
      if (Number.isFinite(parsedPort) && parsedPort > 0) return parsedPort;
    }
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") return 443;
    if (parsed.protocol === "http:" || parsed.protocol === "ws:") return 80;
  } catch {
    // ignore invalid URL
  }
  return null;
}

function getListeningPids(port) {
  if (!Number.isFinite(port) || port <= 0) return [];
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    );
    return output
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  } catch {
    try {
      const output = execFileSync("ss", ["-ltnp", `sport = :${port}`], {
        encoding: "utf8",
      });
      const pids = Array.from(output.matchAll(/pid=(\d+)/g), (match) =>
        Number.parseInt(match[1], 10),
      ).filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
      return Array.from(new Set(pids));
    } catch {
      return [];
    }
  }
}

async function clearUnhealthyListener(label, rawUrl, force = false) {
  const port = getPortFromUrl(rawUrl);
  if (!port) return;

  const pids = getListeningPids(port);
  if (pids.length === 0) return;

  assertProcessTerminationAllowed({
    isolated: options.isolated,
    label: `${label} listener on port ${port}`,
    pids,
  });

  if (force) {
    log(
      `${label} fresh restart requested; terminating listener(s) on port ${port}: ${pids.join(", ")}`,
    );
  } else {
    log(
      `${label} is unhealthy but port ${port} is occupied by pid(s): ${pids.join(", ")}. terminating stale listener(s)...`,
    );
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore dead/unowned pid
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const stillListening = getListeningPids(port);
  if (stillListening.length > 0) {
    for (const pid of stillListening) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore dead/unowned pid
      }
    }
  }
}

async function shutdown(exitCode = 0) {
  if (exitCode !== 0) shutdownExitCode = 1;
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down duel stack...");

  for (const entry of managed) {
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
  }
  const gameServer =
    managed.find((entry) => entry.name === "game-server")?.shutdownMonitor ??
    null;
  const result = await shutdownDuelStackChildren({
    entries: managed.map((entry) => ({
      name: entry.name,
      proc: entry.proc || entry.lastProc,
    })),
    gameServer,
    requestedExitCode: shutdownExitCode,
    graceMs: gameServer?.policy.graceMs ?? duelStackShutdownPolicy.graceMs,
  });
  shutdownExitCode = Math.max(shutdownExitCode, result.exitCode);
  if (result.remainingGroups.length === 0) {
    for (const runtimePath of ownedRuntimePaths.splice(0)) {
      try {
        fs.rmSync(runtimePath, { recursive: true, force: true });
      } catch (error) {
        shutdownExitCode = 1;
        warnLog(
          `failed to remove owned runtime path ${runtimePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    releaseRunLock();
  } else {
    console.error(
      "[duel] retaining owned runtime paths and run lock because process groups remain",
    );
  }
  console.log(
    JSON.stringify({
      event:
        shutdownExitCode === 0
          ? "duel-stack-shutdown-complete"
          : "duel-stack-shutdown-failed",
      ...result,
      ok: shutdownExitCode === 0,
      exitCode: shutdownExitCode,
    }),
  );
  process.exit(shutdownExitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("SIGHUP", () => {
  void shutdown(0);
});
process.on("SIGQUIT", () => {
  void shutdown(0);
});
process.on("uncaughtException", (err) => {
  console.error("[duel] uncaught exception:", err);
  void shutdown(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[duel] unhandled rejection:", err);
  void shutdown(1);
});

async function main() {
  const nodeVersion = execFileSync("node", ["--version"], {
    encoding: "utf8",
  }).trim();
  assertSupportedUwsNodeVersion(nodeVersion);
  if (options.verbose) log(`using pinned duel server ${nodeVersion}`);

  if (!options["skip-stream"]) {
    const encoder = resolveMediaExecutable({ tool: "ffmpeg" });
    process.env.FFMPEG_PATH = encoder.path;
    log(`verified stream encoder: ${encoder.version} (${encoder.path})`);
  }

  assertManagedLocalSolanaBoundary({
    enabled: manageLocalSolana,
    hyperbetRuntimeEnabled,
    remoteBettingMode,
    hyperbetReadOnlyMode,
    rpcUrl: localSolanaRpcUrl,
  });
  assertAuthorityRestartDiagnosticBoundary({
    enabled: authorityRecoveryEnabled,
    fresh: options.fresh === true,
    isolated: options.isolated === true,
    verify: verifyEnabled,
    localSmoke: options["local-smoke"] === true,
    localSolana: manageLocalSolana,
    serverUrl: serverHttpUrl,
    rpcUrl: localSolanaRpcUrl,
    pidFile: ownedGameServerPidFile,
  });
  if (manageLocalSolana) {
    process.env.DUEL_LOCAL_SOLANA_MODE = "true";
    process.env.DUEL_SOLANA_CLUSTER = "localnet";
    process.env.DUEL_KEEPER_SOLANA_CLUSTER = "localnet";
    process.env.DUEL_SOLANA_RPC_URL = localSolanaRpcUrl;
    process.env.DUEL_KEEPER_SOLANA_RPC_URL = localSolanaRpcUrl;
    process.env.SOLANA_CLUSTER = "localnet";
    process.env.SOLANA_RPC_URL = localSolanaRpcUrl;
    process.env.SOLANA_WS_URL = localSolanaWsUrl;
  }

  if (
    hyperbetReadOnlyMode &&
    (!hyperbetRuntimeEnabled ||
      options["skip-keeper"] !== true ||
      withMarketMaker)
  ) {
    throw new Error(
      "Hyperbet read-only mode requires the local Hyperbet runtime, --skip-keeper, and no market maker",
    );
  }

  const standaloneSparbotStyles = resolveStandaloneSparbotStyles(
    options["bot-styles"],
    bots,
  );
  const multiStyleSparbots = options["multi-style-sparbots"] === true;
  assertMultiStyleSparbotOptions({
    enabled: multiStyleSparbots,
    localSmoke: options["local-smoke"] === true,
    styles: standaloneSparbotStyles,
  });

  const serverEnv = readEnvFile(path.join(ROOT, "packages/server/.env"));
  if (hyperbetRuntimeEnabled && !hyperbetAvailable) {
    const configuredHint = String(options["hyperbet-root"] || "").trim();
    throw new Error(
      configuredHint
        ? "The configured Hyperbet root is not a complete SOL workspace"
        : "Hyperbet is enabled but no sibling SOL workspace was found; set DUEL_HYPERBET_ROOT explicitly",
    );
  }
  const modelProviderConfigured = hasConfiguredDuelModelProvider({
    ...serverEnv,
    ...process.env,
  });
  const useStandaloneSparbotPool =
    useExternalAgentPool && !modelProviderConfigured;
  const localSmokeRequested = options["local-smoke"] === true;
  const localSmokeBrowserOrigin = localSmokeRequested
    ? new URL(clientUrl).origin
    : "";
  if (
    localSmokeBrowserOrigin &&
    !isLoopbackHostname(new URL(localSmokeBrowserOrigin).hostname)
  ) {
    throw new Error(
      "The local-smoke game client URL must use an exact loopback hostname",
    );
  }
  const standaloneSparbotProfileSeed = resolveStandaloneSparbotProfileSeed(
    options["sparbot-profile-seed"],
    {
      enabled: useStandaloneSparbotPool,
      localSmoke: localSmokeRequested,
    },
  );
  const effectiveDuelLocalSmokeMode = localSmokeRequested
    ? "true"
    : process.env.DUEL_LOCAL_SMOKE_MODE ||
      serverEnv.DUEL_LOCAL_SMOKE_MODE ||
      "";
  const effectiveLoadTestMode = localSmokeRequested
    ? "true"
    : process.env.LOAD_TEST_MODE || serverEnv.LOAD_TEST_MODE || "";
  const effectiveDuelPreparationMs =
    process.env.STREAMING_DUEL_PREPARATION_MS ||
    serverEnv.STREAMING_DUEL_PREPARATION_MS ||
    (localSmokeRequested ? "5000" : "");
  const effectiveSchedulerRole =
    process.env.STREAMING_DUEL_SCHEDULER_ROLE ||
    serverEnv.STREAMING_DUEL_SCHEDULER_ROLE ||
    "authority";
  const effectiveDuelWithHyperbet =
    hyperbetRuntimeEnabled || remoteBettingMode ? "true" : "false";
  assertStandaloneSparbotRuntimeBoundary({
    enabled: useStandaloneSparbotPool || localSmokeRequested,
    environment: {
      NODE_ENV: duelNodeEnv,
      DUEL_LOCAL_SMOKE_MODE: effectiveDuelLocalSmokeMode,
      LOAD_TEST_MODE: effectiveLoadTestMode,
      DUEL_BETTING_ENABLED: "false",
      DUEL_WITH_HYPERBET: effectiveDuelWithHyperbet,
      DUEL_HYPERBET_READ_ONLY_MODE: hyperbetReadOnlyMode ? "true" : "false",
      DUEL_LOCAL_SOLANA_MODE: manageLocalSolana ? "true" : "false",
      SOLANA_RPC_URL: manageLocalSolana ? localSolanaRpcUrl : "",
      STREAMING_DUEL_SCHEDULER_ROLE: effectiveSchedulerRole,
      PUBLIC_API_URL: process.env.DUEL_PUBLIC_API_URL || serverHttpUrl,
      PUBLIC_WS_URL: process.env.DUEL_PUBLIC_WS_URL || serverWsUrl,
    },
  });
  if (manageLocalSolana) {
    await startManagedLocalSolana();
  }
  prepareHlsOutput(hlsOutputPath);
  const bettingFeedCredential = resolvePrivateBettingFeedToken(
    [
      process.env.DUEL_BETTING_FEED_ACCESS_TOKEN,
      process.env.BETTING_FEED_ACCESS_TOKEN,
      serverEnv.BETTING_FEED_ACCESS_TOKEN,
    ],
    () => randomBytes(32).toString("hex"),
  );
  if (bettingFeedCredential.generated) {
    log(
      "generated an ephemeral high-entropy credential for the internal betting feed",
    );
  }
  const jwtCredential = resolveJwtRuntimeSecret(
    [process.env.JWT_SIGNING_KEYS, serverEnv.JWT_SIGNING_KEYS],
    [process.env.JWT_SECRET, serverEnv.JWT_SECRET],
    () => randomBytes(32).toString("hex"),
  );
  if (jwtCredential.generated) {
    log("generated an ephemeral JWT signing secret for the local duel server");
  } else if (jwtCredential.keyRingConfigured && !jwtCredential.token) {
    log("using the configured JWT key ring without a legacy no-kid bridge");
  }
  const distributedRateLimitCredential = resolvePrivateRuntimeSecret(
    [
      process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET,
      serverEnv.DISTRIBUTED_RATE_LIMIT_KEY_SECRET,
    ],
    () => randomBytes(32).toString("hex"),
    "The distributed authentication rate-limit key",
  );
  if (distributedRateLimitCredential.generated) {
    log(
      "generated an ephemeral distributed authentication rate-limit key for the local duel server",
    );
  }
  const killTokenCredential = resolvePrivateRuntimeSecret(
    [process.env.KILL_TOKEN_SECRET, serverEnv.KILL_TOKEN_SECRET],
    () => randomBytes(32).toString("hex"),
    "The mob-death kill-token authority",
  );
  if (killTokenCredential.generated) {
    log(
      "generated an ephemeral mob-death kill-token authority for the local duel server",
    );
  }
  const preserveOperatorMaintenance = /^(1|true|yes|on)$/i.test(
    process.env.STREAMING_DUEL_MAINTENANCE_MODE ||
      serverEnv.STREAMING_DUEL_MAINTENANCE_MODE ||
      "",
  );
  const launcherOwnsStartupGate = !preserveOperatorMaintenance;
  const adminCredential = resolvePrivateRuntimeSecret(
    [process.env.ADMIN_CODE, serverEnv.ADMIN_CODE],
    () => randomBytes(32).toString("hex"),
    "The local duel admin secret",
  );
  if (adminCredential?.generated) {
    log("generated an ephemeral admin secret for local startup coordination");
  }
  if (useStandaloneSparbotPool) {
    log(
      "no duel model-provider credential is configured; using standalone scripted sparbots",
    );
  }
  const streamingViewerAccessToken = (
    process.env.STREAMING_VIEWER_ACCESS_TOKEN ||
    serverEnv.STREAMING_VIEWER_ACCESS_TOKEN ||
    ""
  ).trim();
  const effectiveStreamingViewerAccessToken =
    streamingViewerAccessToken || randomBytes(24).toString("hex");
  if (!streamingViewerAccessToken) {
    process.env.STREAMING_VIEWER_ACCESS_TOKEN =
      effectiveStreamingViewerAccessToken;
    log(
      "generated runtime STREAMING_VIEWER_ACCESS_TOKEN for delayed stream viewer access",
    );
  }
  const duelSolanaRpcUrl = (
    process.env.DUEL_SOLANA_RPC_URL ||
    serverEnv.SOLANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    ""
  ).trim();
  const duelSolanaWsUrl = (
    process.env.DUEL_SOLANA_WS_URL ||
    serverEnv.SOLANA_WS_URL ||
    process.env.SOLANA_WS_URL ||
    ""
  ).trim();
  let resolvedSolanaAuthority = null;
  let resolvedSolanaProgram = null;

  if (duelSolanaRpcUrl) {
    resolvedSolanaAuthority = await resolveUsableSolanaAuthority({
      rpcUrl: duelSolanaRpcUrl,
      candidateRefs: [
        process.env.DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET,
        serverEnv.DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET,
        process.env.DUEL_ARENA_ORACLE_SOLANA_REPORTER_SECRET,
        serverEnv.DUEL_ARENA_ORACLE_SOLANA_REPORTER_SECRET,
        process.env.DUEL_SOLANA_ARENA_AUTHORITY_SECRET,
        process.env.SOLANA_ARENA_AUTHORITY_SECRET,
        serverEnv.SOLANA_ARENA_AUTHORITY_SECRET,
        process.env.DUEL_SOLANA_ARENA_REPORTER_SECRET,
        process.env.SOLANA_ARENA_REPORTER_SECRET,
        serverEnv.SOLANA_ARENA_REPORTER_SECRET,
        process.env.DUEL_SOLANA_ARENA_KEEPER_SECRET,
        process.env.SOLANA_ARENA_KEEPER_SECRET,
        serverEnv.SOLANA_ARENA_KEEPER_SECRET,
        process.env.SOLANA_MM_PRIVATE_KEY,
        process.env.SOLANA_MARKET_MAKER_PRIVATE_KEY,
        "~/.config/solana/hyperia/deployer-mainnet-20260211.json",
        "~/.config/solana/mainnet-deployer.json",
        "~/.config/solana/hyperia-keys/deployer.json",
        "~/.config/solana/id.json",
      ],
    });

    if (resolvedSolanaAuthority) {
      log(
        `using Solana duel authority ${resolvedSolanaAuthority.pubkey} (${resolvedSolanaAuthority.lamports} lamports)`,
      );
      resolvedSolanaProgram = await resolvePredictionMarketProgramId({
        rpcUrl: duelSolanaRpcUrl,
        authoritySecretRef: resolvedSolanaAuthority.secretRef,
        candidateProgramIds: [
          process.env.DUEL_SOLANA_ARENA_MARKET_PROGRAM_ID,
          process.env.SOLANA_ARENA_MARKET_PROGRAM_ID,
          serverEnv.SOLANA_ARENA_MARKET_PROGRAM_ID,
        ],
      });
      if (resolvedSolanaProgram) {
        log(
          `using Solana duel market program ${resolvedSolanaProgram.programId} (validated with ${resolvedSolanaProgram.signerPubkey})`,
        );
      } else {
        warnLog(
          "unable to validate a Solana prediction-market program; duel server will use configured env values",
        );
      }
    } else {
      warnLog(
        "unable to find a fee-payer-safe Solana authority for duel market writes; duel server will use configured env values",
      );
    }
  }

  const defaultPublicCdnUrl = `${serverHttpUrl}/game-assets`;
  const resolvedPublicCdnUrl = (
    process.env.PUBLIC_CDN_URL ||
    serverEnv.PUBLIC_CDN_URL ||
    defaultPublicCdnUrl
  )
    .trim()
    .replace(/\/$/, "");
  if (options.verbose) {
    const cdnSource =
      process.env.PUBLIC_CDN_URL || serverEnv.PUBLIC_CDN_URL
        ? "PUBLIC_CDN_URL"
        : "duel default (/game-assets)";
    log(`using PUBLIC_CDN_URL=${resolvedPublicCdnUrl} (${cdnSource})`);
  }
  if (options.fresh === true) {
    await terminateProcessesByCommandPatterns(
      [
        "bun --preload ./src/shared/polyfills.ts ./dist/index.js",
        "bun run --cwd packages/server start",
        "bun run dev:duel:skip-dev",
      ],
      "duel/server",
    );
    await terminateProcessesByCommandPatterns(
      [
        `bun run --cwd ${hyperbetMarketMakerRelativeDir} start`,
        `bun run --cwd ${hyperbetMarketMakerRelativeDir} start:multi`,
        `${hyperbetMarketMakerRelativeDir}/src/index.ts`,
        `${hyperbetMarketMakerRelativeDir}/src/run-multi.ts`,
      ],
      "duel/market-maker",
    );
  }
  const verifyRequiredDestinations = [];
  const databaseConfiguration = resolveDuelDatabaseConfiguration({
    runtimeEnvironment: process.env,
    serverEnvironment: serverEnv,
  });
  const duelDatabaseMode = databaseConfiguration.mode;
  const effectiveDatabaseUrl = databaseConfiguration.databaseUrl;
  const configuredLocalPostgresPassword = (
    process.env.POSTGRES_PASSWORD ||
    serverEnv.POSTGRES_PASSWORD ||
    ""
  ).trim();
  const localPostgresPassword =
    configuredLocalPostgresPassword || "hyperia_dev_password";
  if (
    databaseConfiguration.useManagedLocalPostgres &&
    !configuredLocalPostgresPassword
  ) {
    log("using the development-only local PostgreSQL credential default");
  }

  const gameEnv = {
    ...serverEnv,
    ...process.env,
    NODE_ENV: duelNodeEnv,
    // The launcher URL contract is authoritative for both binding and
    // discovery. Keeping these independent can start a healthy server on one
    // port while the client and readiness gates wait forever on another.
    PORT: String(gameServiceTopology.serverPort),
    UWS_PORT: String(gameServiceTopology.websocketPort),
    JWT_SECRET: jwtCredential.token,
    DISTRIBUTED_RATE_LIMIT_KEY_SECRET: distributedRateLimitCredential.token,
    KILL_TOKEN_SECRET: killTokenCredential.token,
    ADMIN_CODE: adminCredential.token,
    // ElizaOS requires SECRET_SALT in production mode; generate a random one
    // for local duel runs so agents don't crash on startup.
    SECRET_SALT: process.env.SECRET_SALT || randomBytes(32).toString("hex"),
    // HyperiaPlugin reads HYPERIA_SERVER_URL at import time for its
    // static config.  Point it at the uWS game WebSocket port, not Fastify.
    HYPERIA_SERVER_URL: process.env.HYPERIA_SERVER_URL || serverWsUrl,
    LOG_LEVEL: duelRuntimeLogLevel,
    DEFAULT_LOG_LEVEL:
      process.env.DUEL_DEFAULT_LOG_LEVEL ||
      process.env.DEFAULT_LOG_LEVEL ||
      duelRuntimeLogLevel,
    DUEL_LOG_LEVEL: process.env.DUEL_LOG_LEVEL || duelRuntimeLogLevel,
    DUEL_AGENT_LOG_LEVEL:
      process.env.DUEL_AGENT_LOG_LEVEL || duelRuntimeLogLevel,
    BETTING_FEED_ACCESS_TOKEN: bettingFeedCredential.token,
    STREAMING_DUEL_SCHEDULER_ROLE: effectiveSchedulerRole,
    SKIP_CDN_MANIFEST_FETCH: process.env.SKIP_CDN_MANIFEST_FETCH || "true",
    DATA_OPTIONAL_MANIFEST_WARNINGS:
      process.env.DATA_OPTIONAL_MANIFEST_WARNINGS || "false",
    MEMORY_MONITOR_STDIO: process.env.MEMORY_MONITOR_STDIO || "false",
    SERVER_RUNTIME_LAG_WARNINGS:
      process.env.SERVER_RUNTIME_LAG_WARNINGS || "false",
    SERVER_RUNTIME_TPS_LOGS: process.env.SERVER_RUNTIME_TPS_LOGS || "false",
    SOLANA_CLUSTER:
      process.env.DUEL_SOLANA_CLUSTER ||
      serverEnv.SOLANA_CLUSTER ||
      process.env.SOLANA_CLUSTER ||
      "",
    SOLANA_RPC_URL:
      process.env.DUEL_SOLANA_RPC_URL ||
      serverEnv.SOLANA_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      "",
    SOLANA_WS_URL:
      process.env.DUEL_SOLANA_WS_URL ||
      serverEnv.SOLANA_WS_URL ||
      process.env.SOLANA_WS_URL ||
      "",
    SOLANA_ARENA_MARKET_PROGRAM_ID:
      process.env.DUEL_SOLANA_ARENA_MARKET_PROGRAM_ID ||
      resolvedSolanaProgram?.programId ||
      process.env.SOLANA_ARENA_MARKET_PROGRAM_ID ||
      serverEnv.SOLANA_ARENA_MARKET_PROGRAM_ID ||
      DUEL_SOLANA_CANONICAL_PROGRAM_ID,
    SOLANA_ARENA_AUTHORITY_SECRET:
      process.env.DUEL_SOLANA_ARENA_AUTHORITY_SECRET ||
      resolvedSolanaAuthority?.secretRef ||
      process.env.SOLANA_ARENA_AUTHORITY_SECRET ||
      serverEnv.SOLANA_ARENA_AUTHORITY_SECRET ||
      "",
    SOLANA_ARENA_REPORTER_SECRET:
      process.env.DUEL_SOLANA_ARENA_REPORTER_SECRET ||
      resolvedSolanaAuthority?.secretRef ||
      process.env.SOLANA_ARENA_REPORTER_SECRET ||
      serverEnv.SOLANA_ARENA_REPORTER_SECRET ||
      "",
    SOLANA_ARENA_KEEPER_SECRET:
      process.env.DUEL_SOLANA_ARENA_KEEPER_SECRET ||
      resolvedSolanaAuthority?.secretRef ||
      process.env.SOLANA_ARENA_KEEPER_SECRET ||
      serverEnv.SOLANA_ARENA_KEEPER_SECRET ||
      "",
    // Duel stack should always target the local game server endpoints unless
    // explicitly overridden by duel-specific env vars.
    PUBLIC_API_URL: process.env.DUEL_PUBLIC_API_URL || serverHttpUrl,
    PUBLIC_WS_URL: process.env.DUEL_PUBLIC_WS_URL || serverWsUrl,
    PUBLIC_CDN_URL: resolvedPublicCdnUrl,
    // The integrated bettor always watches the exact owned HLS output below.
    // External RTMP destinations are optional fanout, never an implicit source.
    STREAMING_CANONICAL_PLATFORM: "hls",
    STREAMING_CANONICAL_SOURCE_URL: hlsUrl,
    HLS_PUBLIC_DIR: path.dirname(hlsOutputPath),
    STREAMING_VIEWER_ACCESS_TOKEN: effectiveStreamingViewerAccessToken,
    STREAMING_DUEL_ENABLED: process.env.STREAMING_DUEL_ENABLED || "true",
    STREAMING_DUEL_PREPARATION_MS: effectiveDuelPreparationMs,
    STREAMING_DUEL_MAINTENANCE_MODE: launcherOwnsStartupGate
      ? "true"
      : process.env.STREAMING_DUEL_MAINTENANCE_MODE ||
        serverEnv.STREAMING_DUEL_MAINTENANCE_MODE ||
        "true",
    DUEL_BETTING_ENABLED: "false",
    DUEL_WITH_HYPERBET: effectiveDuelWithHyperbet,
    DUEL_HYPERBET_READ_ONLY_MODE: hyperbetReadOnlyMode ? "true" : "false",
    DUEL_LOCAL_SMOKE_MODE: effectiveDuelLocalSmokeMode,
    LOAD_TEST_MODE: effectiveLoadTestMode,
    DUEL_LOCAL_BROWSER_ORIGIN: localSmokeBrowserOrigin,
    DISABLE_RATE_LIMIT: process.env.DISABLE_RATE_LIMIT || "true",
    ALLOW_DESTRUCTIVE_CHANGES: process.env.ALLOW_DESTRUCTIVE_CHANGES || "false",
    USE_LOCAL_POSTGRES: databaseConfiguration.useManagedLocalPostgres
      ? "true"
      : "false",
    ...(databaseConfiguration.useManagedLocalPostgres
      ? { POSTGRES_PASSWORD: localPostgresPassword }
      : {}),
    // Keep stream runtime alive through transient remote DB outages.
    DB_WRITE_ERRORS_NON_FATAL: process.env.DB_WRITE_ERRORS_NON_FATAL || "true",
    // Streaming duel instances don't need mutable world chunk persistence.
    DISABLE_WORLD_CHUNK_PERSISTENCE:
      process.env.DISABLE_WORLD_CHUNK_PERSISTENCE || "true",
    // Avoid blocking startup on crash-recovery DB queries in stream mode.
    SKIP_DEATH_RECOVERY_ON_STARTUP:
      process.env.SKIP_DEATH_RECOVERY_ON_STARTUP || "true",
    DEATH_RECOVERY_STARTUP_TIMEOUT_MS:
      process.env.DEATH_RECOVERY_STARTUP_TIMEOUT_MS || "5000",
    // When duel bots are running, keep the game server in external agent mode
    // to avoid double-populating the arena. When they are skipped, fall back
    // to embedded/model agents so streaming still has contestants.
    DUEL_SERVER_AGENT_MODE:
      process.env.DUEL_SERVER_AGENT_MODE || defaultDuelServerAgentMode,
    AUTO_START_AGENTS:
      process.env.AUTO_START_AGENTS ??
      (useExternalAgentPool ? "false" : serverEnv.AUTO_START_AGENTS || "true"),
    AUTO_START_AGENTS_MAX:
      process.env.AUTO_START_AGENTS_MAX ||
      (useExternalAgentPool ? "0" : serverEnv.AUTO_START_AGENTS_MAX || "10"),
    SPAWN_MODEL_AGENTS:
      process.env.SPAWN_MODEL_AGENTS ??
      (useExternalAgentPool ? "false" : serverEnv.SPAWN_MODEL_AGENTS || "true"),
    MAX_MODEL_AGENTS:
      process.env.MAX_MODEL_AGENTS ||
      (useExternalAgentPool ? "0" : serverEnv.MAX_MODEL_AGENTS || "4"),
    SPAWN_MODEL_AGENTS_WITH_EMBEDDED:
      process.env.SPAWN_MODEL_AGENTS_WITH_EMBEDDED ||
      (useExternalAgentPool
        ? "false"
        : serverEnv.SPAWN_MODEL_AGENTS_WITH_EMBEDDED || "false"),
    // Duel workflows commonly sit above 12GB RSS on Bun while remaining stable,
    // so give the local stack explicit headroom unless the caller overrides it.
    MEMORY_LIMIT_GB:
      process.env.DUEL_MEMORY_LIMIT_GB ||
      process.env.MEMORY_LIMIT_GB ||
      serverEnv.MEMORY_LIMIT_GB ||
      "16",
    // DuelCombatAI owns role-aware spacing, movement, healing, and tactical
    // execution from the immutable pre-market strategy. It never receives a
    // model runtime for a money-bearing fight.
    STREAMING_DUEL_COMBAT_AI_ENABLED:
      process.env.STREAMING_DUEL_COMBAT_AI_ENABLED || "true",
    STREAMING_AGENT_SKIP_DB_LOAD: authorityRecoveryEnabled
      ? "false"
      : process.env.STREAMING_AGENT_SKIP_DB_LOAD || "true",
    STREAMING_ANNOUNCEMENT_MS: process.env.STREAMING_ANNOUNCEMENT_MS || "30000",
    STREAMING_FIGHTING_MS: process.env.STREAMING_FIGHTING_MS || "150000",
    STREAMING_END_WARNING_MS: process.env.STREAMING_END_WARNING_MS || "10000",
    STREAMING_RESOLUTION_MS: process.env.STREAMING_RESOLUTION_MS || "5000",
    // Prevent duplicate RTMP publishers when duel-stack runs external
    // stream-to-rtmp capture.
    STREAMING_CAPTURE_ENABLED: process.env.STREAMING_CAPTURE_ENABLED || "false",
    RTMP_STATUS_FILE: options["skip-stream"] ? "" : rtmpStatusFile,
    // Keep the server DB pool conservative in local duel workflows to avoid
    // exceeding low local Postgres max_connections limits.
    POSTGRES_POOL_MAX: process.env.POSTGRES_POOL_MAX || "1",
    POSTGRES_POOL_MIN: process.env.POSTGRES_POOL_MIN || "0",
    // Bun on Linux can spend excessive CPU in allocator trim loops under
    // duel load; disabling aggressive trim keeps API latency stable.
    MALLOC_TRIM_THRESHOLD_: process.env.MALLOC_TRIM_THRESHOLD_ || "-1",
    // Bun/mimalloc can enter high-CPU madvise loops under sustained stream
    // load. Keep pages resident longer to avoid allocator thrash stalls.
    MIMALLOC_ALLOW_DECOMMIT: process.env.MIMALLOC_ALLOW_DECOMMIT || "0",
    MIMALLOC_ALLOW_RESET: process.env.MIMALLOC_ALLOW_RESET || "0",
    MIMALLOC_PAGE_RESET: process.env.MIMALLOC_PAGE_RESET || "0",
    MIMALLOC_PURGE_DELAY: process.env.MIMALLOC_PURGE_DELAY || "1000000",
  };

  if (effectiveDatabaseUrl) {
    gameEnv.DATABASE_URL = effectiveDatabaseUrl;
  } else {
    delete gameEnv.DATABASE_URL;
  }
  if (databaseConfiguration.useManagedLocalPostgres) {
    delete gameEnv.POSTGRES_URL;
  }
  if (options.verbose) {
    const databaseSource = effectiveDatabaseUrl
      ? isLocalDatabaseUrl(effectiveDatabaseUrl)
        ? "loopback DATABASE_URL"
        : "remote DATABASE_URL"
      : "USE_LOCAL_POSTGRES fallback";
    log(`using ${duelDatabaseMode} database mode (${databaseSource})`);
  }

  const configuredServerHealthPath = (
    process.env.DUEL_SERVER_HEALTH_PATH || "/health"
  ).trim();
  const normalizedServerHealthPath = configuredServerHealthPath.startsWith("/")
    ? configuredServerHealthPath
    : `/${configuredServerHealthPath}`;
  const gameServerHealthUrl = `${serverHttpUrl}${normalizedServerHealthPath}`;
  const gameStreamingStateUrl = `${serverHttpUrl}/api/streaming/state`;
  const serverHealthReady = await isHttpReady(gameServerHealthUrl);
  const serverStreamingReady = await isHttpReady(gameStreamingStateUrl);
  let serverWasReady = serverHealthReady && serverStreamingReady;
  let clientWasReady = await isHttpReady(clientUrl);
  let existingServerHasIntegratedBettingFeed = !hyperbetRuntimeEnabled;
  if (
    serverWasReady &&
    hyperbetRuntimeEnabled &&
    options.fresh !== true &&
    !verifyEnabled
  ) {
    try {
      const unauthenticated = await fetchJsonWithTimeout(
        hyperbetTopology.bettingFeedStateUrl,
      );
      const authenticated = await fetchJsonWithTimeout(
        hyperbetTopology.bettingFeedStateUrl,
        {
          headers: {
            authorization: `Bearer ${bettingFeedCredential.token}`,
          },
        },
      );
      existingServerHasIntegratedBettingFeed =
        unauthenticated.response.status === 401 &&
        authenticated.response.ok &&
        isBettingFeedBootstrap(authenticated.payload);
    } catch {
      existingServerHasIntegratedBettingFeed = false;
    }
  }
  const forceFreshGame =
    options.fresh === true ||
    verifyEnabled ||
    process.env.DUEL_FORCE_FRESH === "true" ||
    adminCredential.generated === true;

  if (forceFreshGame) {
    log("forcing fresh game server + client startup");
    await clearUnhealthyListener("game server", serverHttpUrl, true);
    await clearUnhealthyListener("game client", clientUrl, true);
    serverWasReady = false;
    clientWasReady = false;
  } else if (serverWasReady && !existingServerHasIntegratedBettingFeed) {
    log(
      "restarting the game server so the integrated betting credential is authoritative",
    );
    await clearUnhealthyListener("game server", serverHttpUrl, true);
    serverWasReady = false;
  }

  if (options.verbose) {
    log(
      `initial readiness: server health=${serverHealthReady}, streaming api=${serverStreamingReady}, client=${clientWasReady}`,
    );
  }

  log("validating byte-complete duel launch assets before startup...");
  await runCommand(
    "duel-launch-assets",
    process.execPath,
    ["scripts/validate-duel-launch-assets.mjs"],
    { cwd: ROOT, env: gameEnv },
  );

  if (serverWasReady && clientWasReady) {
    log("reusing existing game server + client");
  } else {
    if (!serverWasReady) {
      await clearUnhealthyListener("game server", serverHttpUrl);
    }
    if (!clientWasReady) {
      await clearUnhealthyListener("game client", clientUrl);
    }

    const missing = [];
    if (!serverWasReady) {
      missing.push("server");
    }
    if (!clientWasReady) {
      missing.push("client");
    }

    log(
      `starting missing game components (${missing.join(" + ")}) while preserving any running services`,
    );

    if (!serverWasReady) {
      if (options["reuse-game-builds"] === true) {
        const requiredBuilds = [
          "packages/shared/build/framework.js",
          // framework.js loads these server-only modules dynamically at
          // runtime, so a reusable build is incomplete without them.
          "packages/shared/build/PhysXManager.server.js",
          "packages/shared/build/storage.server.js",
          "packages/server/dist/index.js",
          "packages/server/dist/agentBehaviorWorker.js",
          "packages/server/dist/competitive-build.json",
          "packages/server/dist/competitiveServerBootstrap.js",
        ];
        const missingBuilds = requiredBuilds.filter(
          (artifact) => !fs.existsSync(path.join(ROOT, artifact)),
        );
        if (missingBuilds.length > 0) {
          throw new Error(
            `Cannot reuse missing game build artifact(s): ${missingBuilds.join(", ")}`,
          );
        }
        log("reusing required shared and server production artifacts");
      } else {
        log("building shared package for fresh server startup...");
        await runCommand(
          "shared-build",
          gameBunPath,
          ["run", "--cwd", "packages/shared", "build"],
          { env: gameEnv },
        );
        log("building server package for stable runtime startup...");
        await runCommand(
          "server-build",
          gameBunPath,
          ["run", "--cwd", "packages/server", "build"],
          { env: gameEnv },
        );
      }
      const gameServerEnv = { ...gameEnv };
      const madviseShimPath = ensureMadviseEagainShim();
      if (madviseShimPath) {
        const existingPreload = (gameServerEnv.LD_PRELOAD || "").trim();
        gameServerEnv.LD_PRELOAD = existingPreload
          ? `${madviseShimPath}:${existingPreload}`
          : madviseShimPath;
        log("enabled madvise EAGAIN stability shim for game server");
      }
      // Use Node.js runtime (not Bun) for the game server.
      // uWebSockets.js native bindings only support Node.js NAPI,
      // and V8's incremental GC avoids the 500-1200ms stop-the-world
      // pauses that Bun's JSC causes during game ticks.
      const gameServerCommand = {
        command: "node",
        args: [
          "--import",
          "./scripts/register-hooks.mjs",
          "../../scripts/start-hyperia-server.mjs",
        ],
        opts: {
          cwd: path.join(ROOT, "packages/server"),
          env: gameServerEnv,
        },
      };
      log("starting the native SOL duel server");
      spawnManaged(
        "game-server",
        gameServerCommand.command,
        gameServerCommand.args,
        {
          ...gameServerCommand.opts,
          restart: authorityRecoveryEnabled,
          restartDelayMs: 500,
          maxRestarts: authorityRecoveryEnabled ? 1 : 0,
          cleanupProcessGroupOnExit: authorityRecoveryEnabled,
          onLaunch: authorityRecoveryEnabled
            ? ({ pid }) => {
                ownedGameServerGeneration += 1;
                const generation = ownedGameServerGeneration;
                publishOwnedGameServerState({
                  pid,
                  available: true,
                  startedAtMs: Date.now(),
                });
                if (
                  shouldReleaseRestartedAuthorityStartupGate({
                    authorityRecoveryEnabled,
                    launcherOwnsStartupGate,
                    generation,
                  })
                ) {
                  void releaseRestartedAuthorityStartupGate({
                    pid,
                    generation,
                    healthUrl: gameServerHealthUrl,
                    streamingStateUrl: gameStreamingStateUrl,
                    startupTimeoutMs,
                    streamingStateTimeoutMs,
                    serverUrl: serverHttpUrl,
                    adminCode: adminCredential.token,
                  }).catch((error) => {
                    if (shuttingDown) return;
                    console.error(
                      `[game-server] replacement startup gate failed closed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    void shutdown(1);
                  });
                }
              }
            : null,
          onUnexpectedExit: authorityRecoveryEnabled
            ? ({ code, signal, pid }) =>
                publishOwnedGameServerState({
                  pid,
                  available: false,
                  startedAtMs: 0,
                  exitedAtMs: Date.now(),
                  exitCode: code,
                  signal,
                })
            : null,
        },
      );
    }

    if (!clientWasReady) {
      const duelClientMode = (process.env.DUEL_CLIENT_MODE || "")
        .trim()
        .toLowerCase();
      const forceDevClient =
        duelClientMode === "dev" || duelClientMode === "development";
      // Verified duel runs are long-lived and browser-heavy; prefer the built
      // preview server unless development mode is explicitly requested.
      const useProductionBuild =
        !forceDevClient &&
        (duelNodeEnv === "production" ||
          duelClientMode === "production" ||
          verifyEnabled ||
          /^(1|true|yes|on)$/i.test(
            process.env.DUEL_USE_PRODUCTION_CLIENT || "",
          ));
      const clientDistPath = path.join(ROOT, "packages/client/dist/index.html");
      const distExists = fs.existsSync(clientDistPath);

      if (useProductionBuild) {
        const clientDistDir = path.join(ROOT, "packages/client/dist");
        if (options["reuse-game-builds"] === true && !distExists) {
          throw new Error(
            "Cannot reuse missing game build artifact: packages/client/dist/index.html",
          );
        }
        if (
          options["reuse-game-builds"] !== true &&
          (options.fresh === true || !distExists)
        ) {
          log("building production game client for stable duel runtime...");
          await runCommand(
            "client-build",
            gameBunPath,
            ["run", "--cwd", "packages/client", "build:cf"],
            { env: gameEnv },
          );
        }
        writeClientRuntimeEnv(clientDistDir, {
          PUBLIC_API_URL: serverHttpUrl,
          PUBLIC_WS_URL: serverWsUrl,
          PUBLIC_CDN_URL: resolvedPublicCdnUrl,
        });
        log(
          `wrote client runtime env to ${path.relative(ROOT, path.join(clientDistDir, "env.js"))}`,
        );
        log("starting game client in production mode (vite preview)...");
        spawnManaged(
          "game-client",
          gameBunPath,
          [
            "run",
            "--cwd",
            "packages/client",
            "preview",
            "--",
            "--host",
            "--port",
            String(clientPort),
          ],
          { env: gameEnv },
        );
      } else {
        spawnManaged(
          "game-client",
          gameBunPath,
          [
            "run",
            "--cwd",
            "packages/client",
            "dev",
            "--",
            "--host",
            "--port",
            String(clientPort),
          ],
          {
            env: gameEnv,
          },
        );
      }
    }
  }

  await waitForHttp(gameServerHealthUrl, "game server", startupTimeoutMs);
  await waitForHttp(
    gameStreamingStateUrl,
    "streaming duel api",
    streamingStateTimeoutMs,
  );
  if (launcherOwnsStartupGate) {
    await setDuelMaintenanceMode(
      serverHttpUrl,
      adminCredential.token,
      true,
      startupTimeoutMs,
    );
  }
  if (hyperbetRuntimeEnabled) {
    await verifyAuthenticatedBettingFeed(
      hyperbetTopology,
      bettingFeedCredential.token,
    );
  }
  // Capture cannot be healthy without the client. Only an explicitly
  // stream-less operator run may continue without it.
  if (!options["skip-stream"] || !clientWasReady || options.fresh) {
    await waitForHttp(`${clientUrl}`, "game client", startupTimeoutMs);
  } else {
    const clientOk = await isHttpReady(clientUrl);
    if (clientOk) {
      log(`game client ready at ${clientUrl}`);
    } else {
      warnLog(
        `game client not reachable at ${clientUrl} - continuing without it`,
      );
    }
  }

  let contestantsStarted = false;
  async function startContestants() {
    if (contestantsStarted || options["skip-bots"]) return;
    contestantsStarted = true;
    if (useStandaloneSparbotPool) {
      await seedStandaloneSparbots(
        serverHttpUrl,
        adminCredential.token,
        standaloneSparbotStyles,
        startupTimeoutMs,
        multiStyleSparbots,
        standaloneSparbotProfileSeed,
      );
      return;
    }

    log("starting duel matchmaker bots...");
    spawnManaged(
      "duel-bots",
      gameBunPath,
      [
        "--preload",
        "packages/server/src/shared/polyfills.ts",
        "scripts/dev-duel.mjs",
        "--skip-dev",
        `--bots=${bots}`,
        `--url=${serverWsUrl}`,
        `--api-url=${serverHttpUrl}`,
        `--client-url=${clientUrl}`,
        "--connect-only",
      ],
      {
        env: gameEnv,
        critical: false,
        restart: true,
        restartDelayMs: 2500,
      },
    );
  }

  // Seed contestants behind maintenance before capture starts. The stream
  // page keeps its boot surface visible until both production avatars and the
  // critical arena world have remained stable, so their first GPU uploads can
  // never land in public HLS. Maintenance still prevents ANNOUNCEMENT/markets
  // until every downstream service below is healthy.
  await startContestants();

  if (!options["skip-stream"]) {
    await startCaptureBrowserHost();
    await startStreamBridge();
  }

  let keeperCluster = null;
  let keeperRpcUrl = "";
  let keeperDefaults = {};
  let keeperDeployment = null;
  let hyperbetBackendEnv = null;
  let hyperbetBackendStartedAtMs = null;
  const managedLocalHyperbetRuntimeDir = manageLocalSolana
    ? fs.mkdtempSync(
        path.join(os.tmpdir(), `hyperia-duel-hyperbet-${localSolanaRpcPort}-`),
      )
    : null;
  if (managedLocalHyperbetRuntimeDir) {
    ownedRuntimePaths.push(managedLocalHyperbetRuntimeDir);
  }
  const keeperHealthFile = resolveRuntimePath(
    process.env.DUEL_HYPERBET_KEEPER_HEALTH_FILE,
    managedLocalHyperbetRuntimeDir
      ? path.join(managedLocalHyperbetRuntimeDir, "keeper-health.json")
      : path.join(ROOT, ".runtime-locks", "hyperbet-keeper-health.json"),
  );
  const keeperStreamStateFile = resolveRuntimePath(
    process.env.DUEL_HYPERBET_STREAM_STATE_FILE,
    managedLocalHyperbetRuntimeDir
      ? path.join(managedLocalHyperbetRuntimeDir, "stream-state.json")
      : path.join(ROOT, ".runtime-locks", "hyperbet-stream-state.json"),
  );
  const keeperDbPath = resolveRuntimePath(
    process.env.DUEL_HYPERBET_KEEPER_DB_PATH || process.env.KEEPER_DB_PATH,
    managedLocalHyperbetRuntimeDir
      ? path.join(managedLocalHyperbetRuntimeDir, "keeper.sqlite")
      : path.join(ROOT, ".runtime-locks", "hyperbet-keeper.sqlite"),
  );
  const keeperDatabaseTopology = resolveHyperbetKeeperDatabaseTopology({
    managedLocalSolana: manageLocalSolana,
    terminalDbPath: keeperDbPath,
    configuredServiceDbPath: process.env.DUEL_HYPERBET_SERVICE_DB_PATH
      ? resolveRuntimePath(process.env.DUEL_HYPERBET_SERVICE_DB_PATH, "")
      : "",
  });
  const keeperServiceDbPath = keeperDatabaseTopology.serviceDbPath;

  if (hyperbetRuntimeEnabled) {
    if (
      !isLoopbackHostname(new URL(hyperbetTopology.hyperbetApiUrl).hostname)
    ) {
      throw new Error(
        "The local Hyperbet backend URL must use a loopback hostname; use --remote-betting for an externally managed backend",
      );
    }

    const keeperClusterHint = (
      process.env.DUEL_KEEPER_SOLANA_CLUSTER ||
      process.env.DUEL_SOLANA_CLUSTER ||
      serverEnv.SOLANA_CLUSTER ||
      process.env.SOLANA_CLUSTER ||
      "devnet"
    )
      .trim()
      .toLowerCase();
    const keeperDefaultsFile =
      keeperClusterHint === "mainnet" || keeperClusterHint === "mainnet-beta"
        ? ".env.mainnet"
        : `.env.${keeperClusterHint}`;
    keeperDefaults = {
      ...readEnvFile(path.join(hyperbetSolanaDir, ".env")),
      ...readEnvFile(path.join(hyperbetKeeperDir, ".env")),
      ...readEnvFile(path.join(hyperbetSolanaDir, keeperDefaultsFile)),
      ...readEnvFile(path.join(hyperbetKeeperDir, keeperDefaultsFile)),
    };
    keeperCluster = (
      process.env.DUEL_KEEPER_SOLANA_CLUSTER ||
      process.env.DUEL_SOLANA_CLUSTER ||
      serverEnv.SOLANA_CLUSTER ||
      process.env.SOLANA_CLUSTER ||
      keeperDefaults.SOLANA_CLUSTER ||
      "devnet"
    )
      .trim()
      .toLowerCase();
    keeperRpcUrl = (
      process.env.DUEL_KEEPER_SOLANA_RPC_URL ||
      process.env.DUEL_SOLANA_RPC_URL ||
      serverEnv.SOLANA_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      keeperDefaults.SOLANA_RPC_URL ||
      ""
    ).trim();
    keeperDeployment = resolveHyperbetSolanaDeployment({
      solanaDir: hyperbetSolanaDir,
      cluster: keeperCluster,
    });
    keeperCluster = keeperDeployment.cluster;

    const sourceProtocol = new URL(hyperbetTopology.streamStateSourceUrl)
      .protocol;
    const hyperbetNodeEnv = (
      process.env.DUEL_HYPERBET_NODE_ENV ||
      (sourceProtocol === "https:" && duelNodeEnv === "production"
        ? "production"
        : "development")
    )
      .trim()
      .toLowerCase();
    const backendBaseEnv = omitEnvironmentKeys(
      { ...keeperDefaults, ...process.env },
      [
        ...KEEPER_AUTHORITY_ENV_NAMES,
        "BETTING_FEED_ACCESS_TOKEN",
        "BETTING_FEED_ACCESS_TOKEN_PREVIOUS",
        "DUEL_BETTING_FEED_ACCESS_TOKEN",
        "STREAMING_VIEWER_ACCESS_TOKEN",
      ],
    );
    hyperbetBackendEnv = bindPinnedBunToEnvironment(
      {
        ...backendBaseEnv,
        NODE_ENV: hyperbetNodeEnv,
        PORT: String(getPortFromUrl(hyperbetTopology.hyperbetApiUrl)),
        SOLANA_CLUSTER: keeperCluster,
        SOLANA_RPC_URL: keeperRpcUrl,
        FIGHT_ORACLE_PROGRAM_ID: keeperDeployment.fightOracleProgramId,
        DUEL_MARKET_PROGRAM_ID: keeperDeployment.duelMarketProgramId,
        STREAM_STATE_SOURCE_URL: hyperbetTopology.streamStateSourceUrl,
        STREAM_STATE_SOURCE_BEARER_TOKEN: effectiveStreamingViewerAccessToken,
        KEEPER_BOT_HEALTH_FILE: keeperHealthFile,
        KEEPER_STREAM_STATE_FILE: keeperStreamStateFile,
        KEEPER_DB_PATH: keeperServiceDbPath,
        CORS_ORIGINS: uniqueNonEmpty([
          process.env.CORS_ORIGINS,
          hyperbetTopology.hyperbetAppUrl,
        ]).join(","),
      },
      requireHyperbetBunPath(),
    );

    await clearUnhealthyListener(
      "Hyperbet backend",
      hyperbetTopology.hyperbetApiUrl,
      true,
    );
    hyperbetBackendStartedAtMs = Date.now();
    log(
      `starting Hyperbet SOL backend at ${hyperbetTopology.hyperbetApiUrl}...`,
    );
    spawnManaged(
      "hyperbet-backend",
      requireHyperbetBunPath(),
      withHyperbetBunRuntimeArgs([
        "run",
        "--cwd",
        path.relative(ROOT, hyperbetSolanaDir),
        "keeper:service",
      ]),
      {
        env: hyperbetBackendEnv,
        restart: true,
        restartDelayMs: 2500,
      },
    );
    await waitForHttp(
      hyperbetTopology.hyperbetApiUrl,
      "Hyperbet backend process",
      startupTimeoutMs,
    );
    await waitForJson(
      `${hyperbetTopology.hyperbetApiUrl}/status`,
      "Hyperbet authoritative stream synchronization",
      (payload) =>
        isHyperbetStreamSynchronized(payload, {
          sourceUrl: hyperbetTopology.streamStateSourceUrl,
          startedAtMs: hyperbetBackendStartedAtMs,
        }),
      { timeoutMs: startupTimeoutMs },
    );
  }

  if (!skipBettingApp && hyperbetRuntimeEnabled && hyperbetAvailable) {
    const hyperbetViteMode = resolveHyperbetAppViteMode({
      cluster: keeperCluster,
      hasManagedLocalBrowserWallet: managedLocalBrowserWallet !== null,
    });
    const bettingEnv = bindPinnedBunToEnvironment(
      {
        ...readEnvFile(path.join(hyperbetSolanaDir, ".env.devnet")),
        ...readEnvFile(path.join(hyperbetAppDir, ".env.devnet")),
        ...toPublicAppEnvironment(process.env),
        NODE_ENV:
          hyperbetAppRuntime === "production_preview"
            ? "production"
            : process.env.DUEL_HYPERBET_APP_NODE_ENV || "development",
        LOG_LEVEL: duelRuntimeLogLevel,
        DEFAULT_LOG_LEVEL:
          process.env.DUEL_DEFAULT_LOG_LEVEL ||
          process.env.DEFAULT_LOG_LEVEL ||
          duelRuntimeLogLevel,
        // Point the player at the process that actually owns the rendered HLS
        // files. The Hyperbet Vite server does not serve Hyperia's public tree.
        VITE_STREAM_URL: hlsUrl,
        VITE_GAME_API_URL: hyperbetTopology.hyperbetApiUrl,
        VITE_GAME_WS_URL: hyperbetTopology.hyperbetApiUrl.replace(
          /^http/,
          "ws",
        ),
        // The owned HLS player intentionally buffers four two-second segments
        // for smooth playback. Hyperbet reads the privileged authoritative feed,
        // so its public telemetry must wait for that same playback horizon.
        VITE_UI_SYNC_DELAY_MS:
          process.env.DUEL_HYPERBET_UI_SYNC_DELAY_MS ||
          process.env.VITE_UI_SYNC_DELAY_MS ||
          "8000",
        VITE_SOLANA_CLUSTER: keeperCluster,
        VITE_SOLANA_RPC_URL: keeperRpcUrl || defaultSolanaRpcUrl(keeperCluster),
        VITE_SOLANA_WS_URL:
          process.env.DUEL_SOLANA_WS_URL ||
          process.env.SOLANA_WS_URL ||
          (keeperCluster === "localnet" ? localSolanaWsUrl : ""),
        VITE_FIGHT_ORACLE_PROGRAM_ID: keeperDeployment.fightOracleProgramId,
        VITE_DUEL_MARKET_PROGRAM_ID: keeperDeployment.duelMarketProgramId,
        VITE_TRANSACTIONS_ENABLED: hyperbetReadOnlyMode ? "false" : "true",
        ...(managedLocalBrowserWallet
          ? {
              VITE_HEADLESS_WALLET_SECRET_KEY:
                managedLocalBrowserWallet.secretKey,
              VITE_HEADLESS_WALLET_NAME: "Full Topology Test Wallet",
              VITE_HEADLESS_WALLET_AUTO_CONNECT: "true",
            }
          : {}),
      },
      requireHyperbetBunPath(),
    );

    await clearUnhealthyListener(
      "betting-app",
      hyperbetTopology.hyperbetAppUrl,
      true,
    );
    if (hyperbetAppRuntime === "production_preview") {
      log("building Hyperbet production app for compiled preview...");
      await runCommand(
        "hyperbet-app-build",
        requireHyperbetBunPath(),
        withHyperbetBunRuntimeArgs([
          "run",
          "--cwd",
          path.relative(ROOT, hyperbetAppDir),
          "build",
          "--mode",
          hyperbetViteMode,
        ]),
        { env: bettingEnv },
      );
    }
    log(`starting Hyperbet ${hyperbetAppRuntime} app on :${bettingPort}...`);
    spawnManaged(
      "betting-app",
      requireHyperbetBunPath(),
      withHyperbetBunRuntimeArgs([
        "run",
        "--cwd",
        path.relative(ROOT, hyperbetAppDir),
        hyperbetAppRuntime === "production_preview" ? "preview" : "dev",
        "--mode",
        hyperbetViteMode,
        "--host",
        "--port",
        String(bettingPort),
      ]),
      {
        env: bettingEnv,
        restart: true,
        restartDelayMs: 2500,
      },
    );
    await waitForHttp(
      hyperbetTopology.hyperbetAppUrl,
      "Hyperbet app",
      startupTimeoutMs,
    );
  }

  async function startCaptureBrowserHost() {
    if (!captureBrowserHostEnabled) return;

    const defaultCaptureHeadless = "false";
    const captureHeadless =
      (
        process.env.STREAM_CAPTURE_HEADLESS || defaultCaptureHeadless
      ).toLowerCase() === "true";
    const effectiveCaptureChannel = resolveEffectiveCaptureChannel(
      (process.env.STREAM_CAPTURE_CHANNEL || "").trim(),
    );
    const explicitStreamGameUrl = (
      process.env.DUEL_STREAM_GAME_URL ||
      process.env.STREAM_GAME_URL ||
      ""
    ).trim();
    const explicitStreamFallbackUrls = (
      process.env.DUEL_STREAM_FALLBACK_URLS ||
      process.env.STREAM_GAME_FALLBACK_URLS ||
      ""
    ).trim();
    const hostEnv = {
      ...serverEnv,
      ...process.env,
      GAME_URL: explicitStreamGameUrl || streamCaptureUrl,
      GAME_FALLBACK_URLS: explicitStreamFallbackUrls,
      STREAM_CAPTURE_BROWSER_DEBUG_PORT: String(captureBrowserPort),
      STREAM_CAPTURE_BROWSER_STATUS_FILE: captureBrowserStatusFile,
      STREAM_CAPTURE_CHANNEL: effectiveCaptureChannel,
      STREAM_CAPTURE_ANGLE:
        process.env.STREAM_CAPTURE_ANGLE ||
        (process.platform === "darwin" ? "metal" : "vulkan"),
      STREAM_CAPTURE_HEADLESS:
        process.env.STREAM_CAPTURE_HEADLESS || defaultCaptureHeadless,
    };

    const existingDisplay = process.env.DISPLAY;
    const hasExistingXvfb =
      Boolean(existingDisplay) && existingDisplay.startsWith(":");
    const useXvfbForCapture =
      process.platform === "linux" &&
      !captureHeadless &&
      !hasExistingXvfb &&
      (process.env.DUEL_CAPTURE_USE_XVFB || "true").toLowerCase() !== "false";
    if (hasExistingXvfb) {
      hostEnv.DISPLAY = existingDisplay;
      log(
        `starting capture browser host with existing DISPLAY=${existingDisplay}...`,
      );
    }

    await clearUnhealthyListener(
      "capture browser host",
      captureBrowserEndpoint,
      true,
    );
    try {
      fs.unlinkSync(captureBrowserStatusFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const command = useXvfbForCapture ? "xvfb-run" : gameBunPath;
    const args = useXvfbForCapture
      ? [
          "-a",
          "-s",
          `-screen 0 ${hostEnv.STREAM_CAPTURE_WIDTH || "1280"}x${hostEnv.STREAM_CAPTURE_HEIGHT || "720"}x24`,
          gameBunPath,
          "run",
          "--cwd",
          "packages/server",
          "scripts/capture-browser-host.ts",
        ]
      : ["run", "--cwd", "packages/server", "scripts/capture-browser-host.ts"];
    log(
      `starting supervised warm capture renderer on ${captureBrowserEndpoint}...`,
    );
    const hostStartedAtMs = Date.now();
    spawnManaged("capture-browser-host", command, args, {
      env: hostEnv,
      critical: false,
      restart: true,
      restartDelayMs: 500,
      cleanupProcessGroupOnExit: true,
    });
    await waitForHttp(
      `${captureBrowserEndpoint}/json/version`,
      "capture browser host",
      startupTimeoutMs,
    );
    await waitForJsonFile(
      captureBrowserStatusFile,
      "strict warm capture renderer",
      (payload) =>
        payload?.source === "capture-browser-host" &&
        Number.isFinite(payload?.startedAt) &&
        payload.startedAt >= hostStartedAtMs &&
        payload?.stage === "ready" &&
        payload?.rendererHealth?.ready === true &&
        payload?.rendererHealth?.degradedReason == null,
      { timeoutMs: startupTimeoutMs },
    );
  }

  async function startStreamBridge() {
    log("starting RTMP bridge + local HLS fanout...");
    await terminateProcessesByCommandPatterns(
      [
        "bun run --cwd packages/server stream:rtmp",
        "packages/server/scripts/stream-to-rtmp.ts",
        "bun scripts/stream-to-rtmp.ts",
      ],
      "duel/rtmp-bridge",
    );
    // Hyperia is WebGPU-only. Default to headed capture so Chromium keeps a
    // real GPU/WebGPU context instead of falling back to headless behavior that
    // can connect the bridge without ever producing frames.
    const defaultCaptureHeadless = "false";
    const captureHeadless =
      (
        process.env.STREAM_CAPTURE_HEADLESS || defaultCaptureHeadless
      ).toLowerCase() === "true";
    const explicitStreamGameUrl = (
      process.env.DUEL_STREAM_GAME_URL ||
      process.env.STREAM_GAME_URL ||
      ""
    ).trim();
    const explicitStreamFallbackUrls = (
      process.env.DUEL_STREAM_FALLBACK_URLS ||
      process.env.STREAM_GAME_FALLBACK_URLS ||
      ""
    ).trim();
    const requestedCaptureChannel = (
      process.env.STREAM_CAPTURE_CHANNEL || ""
    ).trim();
    const effectiveCaptureChannel = resolveEffectiveCaptureChannel(
      requestedCaptureChannel,
    );
    const streamEnv = {
      ...serverEnv,
      ...process.env,
      // Prefer duel-stack's capture-safe URLs over any unrelated inherited
      // GAME_URL from the broader shell environment. Generic GAME_URL values
      // often omit disableBridgeCapture=1, which causes the page to start its
      // own MediaRecorder/WebSocket capture loop on top of CDP capture.
      GAME_URL: explicitStreamGameUrl || streamCaptureUrl,
      GAME_FALLBACK_URLS: explicitStreamFallbackUrls,
      RTMP_BRIDGE_PORT: String(rtmpPort),
      HLS_OUTPUT_PATH: hlsOutputPath,
      HLS_SEGMENT_PATTERN: hlsSegmentPattern,
      HLS_TIME_SECONDS: process.env.HLS_TIME_SECONDS || "1",
      HLS_LIST_SIZE: process.env.HLS_LIST_SIZE || "30",
      HLS_DELETE_THRESHOLD: process.env.HLS_DELETE_THRESHOLD || "120",
      HLS_START_NUMBER:
        process.env.HLS_START_NUMBER || String(Math.floor(Date.now() / 1000)),
      HLS_TIMELINE_ORIGIN_MS:
        process.env.HLS_TIMELINE_ORIGIN_MS || String(Date.now()),
      HLS_FLAGS:
        process.env.HLS_FLAGS ||
        "delete_segments+append_list+independent_segments+program_date_time+omit_endlist+temp_file",
      // Vast has been more reliable with CDP capture than WebCodecs. Keep
      // browser-bridge capture as the default on headed Linux because Chromium
      // CDP screencast can stall indefinitely under Xvfb + WebGPU.
      STREAM_CAPTURE_MODE:
        process.env.STREAM_CAPTURE_MODE || defaultStreamCaptureMode,
      STREAM_CAPTURE_CHANNEL: effectiveCaptureChannel,
      STREAM_CAPTURE_ANGLE:
        process.env.STREAM_CAPTURE_ANGLE ||
        (process.platform === "darwin" ? "metal" : "vulkan"),
      STREAM_CAPTURE_HEADLESS:
        process.env.STREAM_CAPTURE_HEADLESS || defaultCaptureHeadless,
      STREAM_CAPTURE_BROWSER_ENDPOINT: captureBrowserHostEnabled
        ? captureBrowserEndpoint
        : "",
      STREAM_BROWSER_AUDIO_REQUIRED:
        process.env.STREAM_BROWSER_AUDIO_REQUIRED || "true",
      RTMP_STATUS_FILE: rtmpStatusFile,
    };
    log(`rtmp bridge game url: ${streamEnv.GAME_URL}`);
    log(`rtmp bridge fallback urls: ${streamEnv.GAME_FALLBACK_URLS}`);

    const hasTwitchDestination = Boolean(
      streamEnv.TWITCH_STREAM_KEY || streamEnv.TWITCH_RTMP_STREAM_KEY,
    );
    const hasYoutubeDestination = Boolean(
      streamEnv.YOUTUBE_STREAM_KEY || streamEnv.YOUTUBE_RTMP_STREAM_KEY,
    );
    const hasKickDestination = Boolean(streamEnv.KICK_STREAM_KEY);
    if (hasTwitchDestination) verifyRequiredDestinations.push("twitch");
    if (hasYoutubeDestination) verifyRequiredDestinations.push("youtube");
    if (hasKickDestination) verifyRequiredDestinations.push("kick");

    const captureHeadlessForLaunch =
      (streamEnv.STREAM_CAPTURE_HEADLESS || "true").toLowerCase() === "true";
    const spectatorPort = Number.parseInt(
      process.env.SPECTATOR_PORT || "4180",
      10,
    );

    // Check if we already have a properly configured DISPLAY (e.g., from deploy-vast.sh)
    // If DISPLAY is already set (e.g., :99), use it directly instead of spawning a new Xvfb
    const existingDisplay = process.env.DISPLAY;
    const hasExistingXvfb = existingDisplay && existingDisplay.startsWith(":");

    const useXvfbForCapture =
      process.platform === "linux" &&
      !captureBrowserHostEnabled &&
      !captureHeadlessForLaunch &&
      !hasExistingXvfb && // Don't spawn new Xvfb if we already have one
      (process.env.DUEL_CAPTURE_USE_XVFB || "true").toLowerCase() !== "false";

    // If using existing display, inherit it in streamEnv
    if (hasExistingXvfb) {
      log(`using existing display ${existingDisplay} (not spawning new Xvfb)`);
      streamEnv.DISPLAY = existingDisplay;
    }

    await clearUnhealthyListener(
      "rtmp bridge websocket",
      `http://127.0.0.1:${rtmpPort}`,
      true,
    );
    await clearUnhealthyListener(
      "rtmp spectator websocket",
      `http://127.0.0.1:${spectatorPort}`,
      true,
    );

    const rtmpCommand = useXvfbForCapture
      ? "xvfb-run"
      : captureBrowserHostEnabled
        ? "node"
        : gameBunPath;
    const rtmpArgs = useXvfbForCapture
      ? [
          "-a",
          "-s",
          `-screen 0 ${streamEnv.STREAM_CAPTURE_WIDTH || "1280"}x${streamEnv.STREAM_CAPTURE_HEIGHT || "720"}x24`,
          gameBunPath,
          "run",
          "--cwd",
          "packages/server",
          "stream:rtmp",
        ]
      : captureBrowserHostEnabled
        ? ["--import", "tsx", "packages/server/scripts/stream-to-rtmp.ts"]
        : ["run", "--cwd", "packages/server", "stream:rtmp"];
    if (useXvfbForCapture) {
      log("starting RTMP bridge + capture under Xvfb (virtual display)...");
    } else if (hasExistingXvfb) {
      log(
        `starting RTMP bridge + capture with existing DISPLAY=${existingDisplay}...`,
      );
    }

    const rtmpBridgeStartedAtMs = Date.now();
    spawnManaged("rtmp-bridge", rtmpCommand, rtmpArgs, {
      env: streamEnv,
      critical: false,
      restart: true,
      // Listener ownership is isolated to this detached worker. After SIGKILL
      // the kernel releases its sockets immediately, so a long generic service
      // delay only extends a visible broadcast outage.
      restartDelayMs: 500,
      cleanupProcessGroupOnExit: true,
      onUnexpectedExit: publishCaptureSupervisorUnavailableStatus,
    });

    const hlsReadyTimeoutMs =
      Number.parseInt(process.env.DUEL_STREAM_READY_TIMEOUT_MS || "", 10) ||
      180_000;
    await waitForLiveHls(hlsUrl, hlsReadyTimeoutMs);
    await waitForJsonFile(
      rtmpStatusFile,
      "capture renderer",
      (payload) =>
        payload?.source === "external-rtmp-bridge" &&
        Number.isFinite(payload?.updatedAt) &&
        payload.updatedAt >= rtmpBridgeStartedAtMs &&
        payload?.rendererHealth?.ready === true &&
        payload?.stats?.ffmpegRunning === true &&
        getHealthyBrowserAudioEvidence(payload) !== null,
      { timeoutMs: hlsReadyTimeoutMs },
    );
  }

  let mmRuntimeMode = "disabled";
  async function startMarketMakers() {
    if (!withMarketMaker) {
      return;
    }

    if (!hyperbetMarketMakerAvailable) {
      warnLog(
        `Hyperbet market-maker package not found at ${hyperbetMarketMakerDir}; skipping market-maker startup`,
      );
      return;
    }

    const marketMakerDir = hyperbetMarketMakerDir;
    const resolvedMode =
      mmMode === "auto" ? (mmConfigExists ? "multi" : "single") : mmMode;
    const mmEnv = {
      ...readEnvFile(path.join(marketMakerDir, ".env")),
      ...process.env,
      MM_DUEL_STATE_API_URL:
        process.env.MM_DUEL_STATE_API_URL || gameStreamingStateUrl,
      MM_ENABLE_DUEL_SIGNAL: process.env.MM_ENABLE_DUEL_SIGNAL || "true",
      MM_DUEL_SIGNAL_WEIGHT: process.env.MM_DUEL_SIGNAL_WEIGHT || "0.9",
      MM_DUEL_HP_EDGE_MULTIPLIER:
        process.env.MM_DUEL_HP_EDGE_MULTIPLIER || "0.49",
      MM_DUEL_SIGNAL_FETCH_TIMEOUT_MS:
        process.env.MM_DUEL_SIGNAL_FETCH_TIMEOUT_MS || "2500",
      MM_TAKER_INTERVAL_CYCLES: process.env.MM_TAKER_INTERVAL_CYCLES || "1",
      ORDER_SIZE_MIN: process.env.ORDER_SIZE_MIN || "40",
      ORDER_SIZE_MAX: process.env.ORDER_SIZE_MAX || "140",
      MM_TAKER_SIZE_MIN: process.env.MM_TAKER_SIZE_MIN || "20",
      MM_TAKER_SIZE_MAX: process.env.MM_TAKER_SIZE_MAX || "80",
      MAX_ORDERS_PER_SIDE: process.env.MAX_ORDERS_PER_SIDE || "6",
      CANCEL_STALE_AGE_MS: process.env.CANCEL_STALE_AGE_MS || "12000",
    };

    if (mmStartDelayMs > 0) {
      log(`waiting ${mmStartDelayMs}ms before market-maker startup...`);
      await new Promise((resolve) => setTimeout(resolve, mmStartDelayMs));
    }

    if (resolvedMode === "multi") {
      if (!mmConfigExists) {
        warnLog(
          `MM multi config not found at ${mmConfigPath}; falling back to single mode`,
        );
      } else {
        mmRuntimeMode = "multi";
        log(
          `starting Hyperbet market maker bots (multi) using ${mmConfigPath}...`,
        );
        spawnManaged(
          "market-maker",
          requireHyperbetBunPath(),
          withHyperbetBunRuntimeArgs([
            "run",
            "--cwd",
            hyperbetMarketMakerRelativeDir,
            "start:multi",
            "--",
            "--config",
            mmConfigPath,
            "--stagger-ms",
            String(mmStaggerMs),
          ]),
          {
            env: mmEnv,
            critical: false,
            restart: true,
            restartDelayMs: 3500,
          },
        );
        return;
      }
    }

    mmRuntimeMode = "single";
    log("starting Hyperbet market maker bot (single)...");
    spawnManaged(
      "market-maker",
      requireHyperbetBunPath(),
      withHyperbetBunRuntimeArgs([
        "run",
        "--cwd",
        hyperbetMarketMakerRelativeDir,
        "start",
      ]),
      {
        env: mmEnv,
        critical: false,
        restart: true,
        restartDelayMs: 3500,
      },
    );
  }

  let keeperRuntimeState = "skipped";
  if (!options["skip-keeper"] && hyperbetRuntimeEnabled && hyperbetAvailable) {
    const keeperGameUrl = hyperbetTopology.gameOrigin;
    const effectiveKeeperRpcUrl =
      keeperRpcUrl || defaultSolanaRpcUrl(keeperCluster);
    const forceKeeper =
      process.env.DUEL_KEEPER_FORCE === "true" ||
      process.env.DUEL_FORCE_KEEPER === "true";
    const readiness = await resolveKeeperProgramReadiness({
      rpcUrl: effectiveKeeperRpcUrl,
      deployment: keeperDeployment,
    });
    if (!forceKeeper && !readiness.ready) {
      throw new Error(
        `Hyperbet keeper cannot start because required SOL programs are unavailable on ${keeperCluster}: ${readiness.missing.join(", ")}`,
      );
    }

    const isMainnetKeeper =
      keeperCluster === "mainnet" || keeperCluster === "mainnet-beta";
    const sharedDevelopmentAuthority = isMainnetKeeper
      ? ""
      : resolvedSolanaAuthority?.secretRef || "";
    const sharedDevelopmentPubkey = isMainnetKeeper
      ? ""
      : resolvedSolanaAuthority?.pubkey || "";
    if (manageLocalSolana && !managedLocalSolanaRoles) {
      throw new Error("Managed local Solana keeper roles were not initialized");
    }
    const keeperEnv = bindPinnedBunToEnvironment(
      {
        ...keeperDefaults,
        ...process.env,
        SOLANA_CLUSTER: keeperCluster,
        SOLANA_RPC_URL: effectiveKeeperRpcUrl,
        FIGHT_ORACLE_PROGRAM_ID: keeperDeployment.fightOracleProgramId,
        DUEL_MARKET_PROGRAM_ID: keeperDeployment.duelMarketProgramId,
        KEEPER_FEE_PAYER_KEYPAIR:
          managedLocalSolanaRoles?.feePayer.secretRef ||
          process.env.DUEL_KEEPER_FEE_PAYER_KEYPAIR ||
          process.env.KEEPER_FEE_PAYER_KEYPAIR ||
          process.env.DUEL_KEEPER_BOT_KEYPAIR ||
          keeperDefaults.KEEPER_FEE_PAYER_KEYPAIR ||
          sharedDevelopmentAuthority,
        ORACLE_REPORTER_KEYPAIR:
          managedLocalSolanaRoles?.reporter.secretRef ||
          process.env.DUEL_KEEPER_ORACLE_REPORTER_KEYPAIR ||
          process.env.ORACLE_REPORTER_KEYPAIR ||
          process.env.DUEL_KEEPER_ORACLE_AUTHORITY_KEYPAIR ||
          keeperDefaults.ORACLE_REPORTER_KEYPAIR ||
          sharedDevelopmentAuthority,
        ORACLE_FINALIZER_KEYPAIR:
          managedLocalSolanaRoles?.finalizer.secretRef ||
          process.env.DUEL_KEEPER_ORACLE_FINALIZER_KEYPAIR ||
          process.env.ORACLE_FINALIZER_KEYPAIR ||
          keeperDefaults.ORACLE_FINALIZER_KEYPAIR ||
          sharedDevelopmentAuthority,
        CLOB_MARKET_OPERATOR_KEYPAIR:
          managedLocalSolanaRoles?.marketOperator.secretRef ||
          process.env.DUEL_KEEPER_CLOB_MARKET_OPERATOR_KEYPAIR ||
          process.env.CLOB_MARKET_OPERATOR_KEYPAIR ||
          keeperDefaults.CLOB_MARKET_OPERATOR_KEYPAIR ||
          sharedDevelopmentAuthority,
        MARKET_MAKER_KEYPAIR:
          managedLocalSolanaRoles?.marketMaker.secretRef ||
          process.env.DUEL_KEEPER_MARKET_MAKER_KEYPAIR ||
          process.env.MARKET_MAKER_KEYPAIR ||
          keeperDefaults.MARKET_MAKER_KEYPAIR ||
          sharedDevelopmentAuthority,
        ORACLE_CONFIG_AUTHORITY_KEYPAIR:
          process.env.DUEL_KEEPER_ORACLE_CONFIG_AUTHORITY_KEYPAIR ||
          process.env.ORACLE_CONFIG_AUTHORITY_KEYPAIR ||
          keeperDefaults.ORACLE_CONFIG_AUTHORITY_KEYPAIR ||
          sharedDevelopmentAuthority,
        CLOB_CONFIG_AUTHORITY_KEYPAIR:
          process.env.DUEL_KEEPER_CLOB_CONFIG_AUTHORITY_KEYPAIR ||
          process.env.CLOB_CONFIG_AUTHORITY_KEYPAIR ||
          keeperDefaults.CLOB_CONFIG_AUTHORITY_KEYPAIR ||
          sharedDevelopmentAuthority,
        ORACLE_CHALLENGER_WALLET:
          managedLocalSolanaRoles?.challenger.publicKey ||
          process.env.DUEL_KEEPER_ORACLE_CHALLENGER_WALLET ||
          process.env.ORACLE_CHALLENGER_WALLET ||
          keeperDefaults.ORACLE_CHALLENGER_WALLET ||
          sharedDevelopmentPubkey,
        TRADE_TREASURY_WALLET:
          managedLocalSolanaRoles?.treasury.publicKey ||
          process.env.TRADE_TREASURY_WALLET ||
          keeperDefaults.TRADE_TREASURY_WALLET ||
          sharedDevelopmentPubkey,
        TRADE_MARKET_MAKER_WALLET:
          managedLocalSolanaRoles?.marketMaker.publicKey ||
          process.env.TRADE_MARKET_MAKER_WALLET ||
          keeperDefaults.TRADE_MARKET_MAKER_WALLET ||
          sharedDevelopmentPubkey,
        TRADE_TREASURY_FEE_BPS:
          managedLocalSolanaRoles?.feePolicy.tradeTreasuryFeeBps ||
          process.env.TRADE_TREASURY_FEE_BPS ||
          keeperDefaults.TRADE_TREASURY_FEE_BPS ||
          "",
        TRADE_MARKET_MAKER_FEE_BPS:
          managedLocalSolanaRoles?.feePolicy.tradeMarketMakerFeeBps ||
          process.env.TRADE_MARKET_MAKER_FEE_BPS ||
          keeperDefaults.TRADE_MARKET_MAKER_FEE_BPS ||
          "",
        WINNINGS_MARKET_MAKER_FEE_BPS:
          managedLocalSolanaRoles?.feePolicy.winningsMarketMakerFeeBps ||
          process.env.WINNINGS_MARKET_MAKER_FEE_BPS ||
          keeperDefaults.WINNINGS_MARKET_MAKER_FEE_BPS ||
          "",
        GAME_URL: keeperGameUrl,
        BET_SYNC_SOURCE_BEARER_TOKEN: bettingFeedCredential.token,
        BOT_LOOP: process.env.DUEL_KEEPER_BOT_LOOP || "true",
        BOT_POLL_SECONDS: process.env.DUEL_KEEPER_POLL_SECONDS || "1",
        HYPERBET_LOCAL_DIAGNOSTIC_FEED: manageLocalSolana ? "true" : "false",
        SOLANA_ORACLE_DISPUTE_WINDOW_SECS: manageLocalSolana
          ? process.env.DUEL_LOCAL_SOLANA_ORACLE_DISPUTE_WINDOW_SECS || "60"
          : process.env.SOLANA_ORACLE_DISPUTE_WINDOW_SECS || "",
        KEEPER_BOT_HEALTH_FILE: keeperHealthFile,
        KEEPER_STREAM_STATE_FILE: keeperStreamStateFile,
        KEEPER_DB_PATH: keeperDbPath,
        GAME_STATE_POLL_TIMEOUT_MS:
          process.env.GAME_STATE_POLL_TIMEOUT_MS || "5000",
        GAME_STATE_POLL_INTERVAL_MS:
          process.env.GAME_STATE_POLL_INTERVAL_MS || "3000",
      },
      requireHyperbetBunPath(),
    );
    const requiredKeeperRoles = [
      "KEEPER_FEE_PAYER_KEYPAIR",
      "ORACLE_REPORTER_KEYPAIR",
      "ORACLE_FINALIZER_KEYPAIR",
      "CLOB_MARKET_OPERATOR_KEYPAIR",
      "MARKET_MAKER_KEYPAIR",
      "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
      "CLOB_CONFIG_AUTHORITY_KEYPAIR",
      "ORACLE_CHALLENGER_WALLET",
    ];
    const missingKeeperRoles = requiredKeeperRoles.filter(
      (name) => !String(keeperEnv[name] || "").trim(),
    );
    if (missingKeeperRoles.length > 0) {
      throw new Error(
        `Hyperbet keeper is missing required role configuration: ${missingKeeperRoles.join(", ")}`,
      );
    }
    const requiredKeeperLaunchPolicy = [
      "TRADE_TREASURY_WALLET",
      "TRADE_MARKET_MAKER_WALLET",
      "TRADE_TREASURY_FEE_BPS",
      "TRADE_MARKET_MAKER_FEE_BPS",
      "WINNINGS_MARKET_MAKER_FEE_BPS",
      "SOLANA_ORACLE_DISPUTE_WINDOW_SECS",
    ];
    if (isMainnetKeeper) {
      requiredKeeperLaunchPolicy.push("SOLANA_LAUNCH_FEE_POLICY_APPROVED");
    }
    const missingKeeperLaunchPolicy = requiredKeeperLaunchPolicy.filter(
      (name) => !String(keeperEnv[name] || "").trim(),
    );
    if (missingKeeperLaunchPolicy.length > 0) {
      throw new Error(
        `Hyperbet keeper is missing required explicit launch policy: ${missingKeeperLaunchPolicy.join(", ")}`,
      );
    }

    log("starting Hyperbet SOL keeper automation...");
    log(`keeper game api url: ${keeperGameUrl}`);
    log(`keeper solana cluster: ${keeperCluster}`);
    const keeperStartedAtMs = Date.now() - 1_000;
    spawnManaged(
      "keeper-bot",
      requireHyperbetBunPath(),
      withHyperbetBunRuntimeArgs([
        path.join(hyperbetKeeperDir, "src/duelBot.ts"),
      ]),
      {
        env: keeperEnv,
        restart: true,
        restartDelayMs: 5000,
      },
    );
    await waitForJson(
      `${hyperbetTopology.hyperbetApiUrl}/api/keeper/bot-health`,
      "fresh Hyperbet keeper readiness",
      (payload) => isFreshHyperbetReadiness(payload, keeperStartedAtMs),
      { timeoutMs: startupTimeoutMs },
    );
    keeperRuntimeState = "ready";
  } else if (!options["skip-keeper"] && !hyperbetEnabled) {
    log(
      "skipping Hyperbet keeper; set DUEL_WITH_HYPERBET=true to boot the sibling SOL repo automatically",
    );
  } else if (options["skip-keeper"] && hyperbetRuntimeEnabled) {
    keeperRuntimeState = "explicitly skipped";
  }

  await startMarketMakers();

  // startContestants() ran before capture while maintenance held the cycle.
  // Reaching this point proves capture and all configured market services are
  // ready; only now may the scheduler publish the first ANNOUNCEMENT.

  if (launcherOwnsStartupGate) {
    await setDuelMaintenanceMode(
      serverHttpUrl,
      adminCredential.token,
      false,
      startupTimeoutMs,
    );
  } else {
    log("preserving operator-requested duel maintenance mode");
  }

  if (hyperbetRuntimeEnabled) {
    if (hyperbetReadOnlyMode) {
      if (!Number.isSafeInteger(hyperbetBackendStartedAtMs)) {
        throw new Error("read-only Hyperbet backend start time is unavailable");
      }
      await waitForJson(
        `${hyperbetTopology.hyperbetApiUrl}/status`,
        "read-only Hyperbet authoritative stream readiness",
        (payload) =>
          isHyperbetStreamSynchronized(payload, {
            sourceUrl: hyperbetTopology.streamStateSourceUrl,
            startedAtMs: hyperbetBackendStartedAtMs,
          }),
        { timeoutMs: startupTimeoutMs },
      );
    } else {
      await waitForStableHttp(
        `${hyperbetTopology.hyperbetApiUrl}/ready`,
        "combined Hyperbet launch readiness",
        startupTimeoutMs,
      );
    }
  }

  if (verifyEnabled) {
    log("running startup verification checks...");
    const verifyArgs = [
      "scripts/verify-duel-stack.mjs",
      "--server-url",
      serverHttpUrl,
      "--client-url",
      clientUrl,
      "--hls-url",
      hlsUrl,
      "--timeout-ms",
      String(verifyTimeoutMs),
      "--fight-timeout-ms",
      String(Math.min(verifyTimeoutMs, 120_000)),
      "--rtmp-timeout-ms",
      String(Math.min(verifyTimeoutMs, 120_000)),
    ];
    if (!skipBettingApp) {
      verifyArgs.push("--betting-url", hyperbetTopology.hyperbetAppUrl);
    } else {
      verifyArgs.push("--skip-betting");
    }
    if (options["skip-stream"]) {
      verifyArgs.push("--skip-stream");
    }
    if (hyperbetRuntimeEnabled) {
      verifyArgs.push("--hyperbet-api-url", hyperbetTopology.hyperbetApiUrl);
      verifyArgs.push("--hyperbet-app-runtime", hyperbetAppRuntime);
      if (hyperbetBrowserPerformanceProfile) {
        verifyArgs.push(
          "--browser-performance-profile",
          hyperbetBrowserPerformanceProfile.name,
        );
      }
      if (hyperbetReadOnlyMode) verifyArgs.push("--hyperbet-read-only");
      if (manageLocalSolana) {
        if (!managedLocalBrowserWallet || !keeperDeployment) {
          throw new Error(
            "Managed local Solana verification is missing its browser wallet or deployment",
          );
        }
        verifyArgs.push(
          "--hyperbet-local-transactions",
          "--solana-rpc-url",
          localSolanaRpcUrl,
          "--duel-market-program-id",
          keeperDeployment.duelMarketProgramId,
          "--expected-local-wallet",
          managedLocalBrowserWallet.publicKey,
        );
      }
    }
    const browserEvidenceDir = (
      process.env.DUEL_VERIFY_BROWSER_EVIDENCE_DIR || ""
    ).trim();
    if (browserEvidenceDir) {
      verifyArgs.push("--browser-evidence-dir", browserEvidenceDir);
    }
    if (verifyRequiredDestinations.length > 0) {
      verifyArgs.push(
        "--require-destinations",
        verifyRequiredDestinations.join(","),
      );
    }
    const verifyOutput = await runCommand(
      "duel-verify",
      gameBunPath,
      verifyArgs,
      {
        captureStdout: true,
      },
    );
    const reportLine = String(verifyOutput || "")
      .split(/\r?\n/)
      .find((line) => line.startsWith("[duel-verify-report] "));
    if (!reportLine) {
      throw new Error("duel verifier passed without a structured report");
    }
    let verificationReport;
    try {
      verificationReport = JSON.parse(
        reportLine.slice("[duel-verify-report] ".length),
      );
    } catch {
      throw new Error("duel verifier returned an invalid structured report");
    }
    console.log(
      `[duel-stack-verification-report] ${JSON.stringify(verificationReport)}`,
    );
    if (!options["skip-stream"]) {
      const equipment = verificationReport?.equipmentVisualEvidence;
      const audio = verificationReport?.audioEvidence;
      if (
        typeof equipment?.cycleId !== "string" ||
        !Number.isSafeInteger(equipment?.requiredCount) ||
        !Number.isSafeInteger(equipment?.readyCount) ||
        !Number.isSafeInteger(equipment?.requiredPlayerCount)
      ) {
        throw new Error(
          "duel verifier report omitted fitted equipment evidence",
        );
      }
      if (
        audio?.source !== "browser" ||
        audio?.healthy !== true ||
        !Number.isSafeInteger(audio?.bridgeChunks) ||
        audio.bridgeChunks <= 0 ||
        !Number.isSafeInteger(audio?.captureChunks) ||
        audio.captureChunks <= 0
      ) {
        throw new Error(
          "duel verifier report omitted healthy browser master-mix audio evidence",
        );
      }
      log(
        `verification evidence: cycle=${equipment.cycleId} fitted=${equipment.readyCount}/${equipment.requiredCount} agents=${equipment.requiredPlayerCount}/${equipment.expectedAgentCount} audio=${audio.captureChunks} chunks rtmp=${verificationReport.rtmpEvidence?.bytesReceived ?? 0} bytes`,
      );
    }
    log("startup verification passed");
  }

  log("stack online");
  log(`stream page: ${streamPageUrl}`);
  log(`stream capture url: ${streamCaptureUrl}`);
  if (hyperbetRuntimeEnabled) {
    log(`Hyperbet backend: ${hyperbetTopology.hyperbetApiUrl}`);
    log(`Hyperbet keeper: ${keeperRuntimeState}`);
  }
  if (!skipBettingApp) {
    log(`Hyperbet app: ${hyperbetTopology.hyperbetAppUrl}`);
  } else if (hyperbetRuntimeEnabled) {
    log("Hyperbet app: explicitly skipped");
  } else {
    log("Hyperbet local runtime: skipped");
  }
  log(`hls stream url: ${hlsUrl}`);
  log(
    withMarketMaker
      ? `market maker: enabled (${mmRuntimeMode})`
      : "market maker: skipped (pass --with-mm)",
  );
  log("press Ctrl+C to stop");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[duel] failed to start duel stack:", err);
  void shutdown(1);
});
