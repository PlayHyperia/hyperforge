#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  findFightOracleConfigPda,
  findFightOracleDuelStatePda,
} from "../packages/duel-oracle-solana/src/index.ts";

const values = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "timeout-ms": { type: "string", default: "420000" },
    "duel-timeout-ms": { type: "string", default: "240000" },
    "oracle-timeout-ms": { type: "string", default: "240000" },
    "keep-running": { type: "boolean" },
  },
  strict: true,
}).values;

if (values.help) {
  console.log(`
Verify local streaming duel + duel-oracle publishing against Solana localnet.

Usage:
  bun scripts/verify-duel-oracle-local.mjs [options]

Options:
  -h, --help                 Show help
  --timeout-ms <ms>          Stack startup timeout (default: 420000)
  --duel-timeout-ms <ms>     Duel/stream verification timeout (default: 240000)
  --oracle-timeout-ms <ms>   Oracle resolution timeout (default: 240000)
  --keep-running             Leave managed processes running on success
`);
  process.exit(0);
}

const timeoutMs = Number.parseInt(values["timeout-ms"], 10) || 420_000;
const duelTimeoutMs = Number.parseInt(values["duel-timeout-ms"], 10) || 240_000;
const oracleTimeoutMs =
  Number.parseInt(values["oracle-timeout-ms"], 10) || 240_000;
const keepRunning = values["keep-running"] === true;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const runtimeDir = path.join(rootDir, ".runtime-locks", "duel-oracle-local");
const duelOracleStorePath = path.join(
  runtimeDir,
  "duel-arena-oracle-records.json",
);
const solanaLedgerPath = path.join(runtimeDir, "solana-ledger");
const solanaAuthorityPath = path.join(runtimeDir, "solana-authority.json");
const solanaValidatorLogPath = path.join(runtimeDir, "solana-validator.log");
const duelStackLogPath = path.join(runtimeDir, "duel-stack.log");
const runId = crypto.randomBytes(6).toString("hex");
const postgresContainer = `hyperia-duel-oracle-${runId}`;
const postgresVolume = `${postgresContainer}-data`;
const postgresPort =
  Number.parseInt(process.env.DUEL_ORACLE_LOCAL_POSTGRES_PORT || "35559", 10) ||
  35559;
const solanaRpcUrl =
  process.env.DUEL_ARENA_ORACLE_SOLANA_LOCALNET_RPC_URL?.trim() ||
  "http://127.0.0.1:8899";
const solanaWsUrl =
  process.env.DUEL_ARENA_ORACLE_SOLANA_LOCALNET_WS_URL?.trim() ||
  "ws://127.0.0.1:8900";
const serverPort =
  Number.parseInt(process.env.DUEL_LOCAL_SERVER_PORT || "5565", 10) || 5565;
const serverWsPort =
  Number.parseInt(process.env.DUEL_LOCAL_WS_PORT || "5566", 10) || 5566;
const clientPort =
  Number.parseInt(process.env.DUEL_LOCAL_CLIENT_PORT || "3333", 10) || 3333;
const rtmpPort =
  Number.parseInt(process.env.DUEL_LOCAL_RTMP_PORT || "8766", 10) || 8766;
const serverUrl = `http://127.0.0.1:${serverPort}`;
const serverWsUrl = `ws://127.0.0.1:${serverWsPort}/ws`;
const clientUrl = `http://127.0.0.1:${clientPort}`;
const enabledStreamDestinations = resolveEnabledStreamDestinations(
  process.env.STREAM_ENABLED_DESTINATIONS ||
    process.env.DUEL_STREAM_DESTINATIONS,
);
const requiredStreamDestinations = resolveRequiredStreamDestinations();

const managedChildren = [];

function log(message) {
  console.log(`[duel-oracle-local] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveEnabledStreamDestinations(rawValue) {
  if (!rawValue) return null;
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "*") {
    return null;
  }

  const enabled = new Set();
  for (const token of normalized.split(",")) {
    const compact = token.replace(/[^a-z]/g, "");
    if (token.trim() === "twitch" || compact === "twitch") {
      enabled.add("twitch");
      continue;
    }
    if (token.trim() === "youtube" || compact === "youtube") {
      enabled.add("youtube");
      continue;
    }
    if (token.trim() === "kick" || compact === "kick") {
      enabled.add("kick");
    }
  }
  return enabled;
}

function isStreamDestinationEnabled(destination) {
  return (
    enabledStreamDestinations === null ||
    enabledStreamDestinations.has(destination)
  );
}

function hasConfiguredEnvValue(...keys) {
  return keys.some((key) => {
    const value = process.env[key]?.trim();
    return Boolean(value);
  });
}

function resolveRequiredStreamDestinations() {
  if (process.env.DUEL_VERIFY_REQUIRE_DESTINATIONS !== "true") {
    return [];
  }

  const required = [];
  if (
    isStreamDestinationEnabled("twitch") &&
    hasConfiguredEnvValue("TWITCH_STREAM_KEY", "TWITCH_RTMP_STREAM_KEY")
  ) {
    required.push("twitch");
  }
  if (
    isStreamDestinationEnabled("youtube") &&
    hasConfiguredEnvValue("YOUTUBE_STREAM_KEY", "YOUTUBE_RTMP_STREAM_KEY")
  ) {
    required.push("youtube");
  }

  const kickUrl = process.env.KICK_RTMP_URL?.trim() || "";
  const kickUrlHasEmbeddedKey = /\/(?:live|app)\/[^/]+/.test(kickUrl);
  if (
    isStreamDestinationEnabled("kick") &&
    (hasConfiguredEnvValue("KICK_STREAM_KEY") || kickUrlHasEmbeddedKey)
  ) {
    required.push("kick");
  }

  return required;
}

async function ensureDir(directory) {
  await fsp.mkdir(directory, { recursive: true });
}

async function clearOwnedRunLogs() {
  const entries = await fsp.readdir(runtimeDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) =>
        fsp.rm(path.join(runtimeDir, entry.name), { force: true }),
      ),
  );
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

async function waitFor(label, check, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        log(`OK: ${label}`);
        return value;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(2_000);
  }

  const suffix = lastError
    ? ` last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : "";
  fail(`Timed out waiting for ${label}.${suffix}`);
}

async function fetchJson(url, ms = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} at ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function openLogFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return fs.openSync(filePath, "a");
}

function spawnDetached(label, command, args, { cwd = rootDir, env, logPath }) {
  const logFd = openLogFile(logPath);
  const proc = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  fs.closeSync(logFd);

  managedChildren.push({
    label,
    pid: proc.pid,
    logPath,
    managed: true,
  });

  proc.unref();
  return proc;
}

function killProcessGroup(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
}

function removeOwnedDockerResource(kind, name) {
  const args =
    kind === "container" ? ["rm", "-f", name] : ["volume", "rm", name];
  const result = spawnSync("docker", args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.status === 0) return;

  const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (/no such (container|volume)/i.test(detail)) return;
  fail(`Failed to remove owned PostgreSQL ${kind} ${name}: ${detail}`);
}

function listListeningPids(port) {
  const result = spawnSync(
    "lsof",
    ["-tiTCP:" + String(port), "-sTCP:LISTEN", "-n", "-P"],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }
  return Array.from(
    new Set(
      result.stdout
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
}

function readCommandForPid(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    cwd: rootDir,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function clearPortListeners(port, label) {
  const pids = listListeningPids(port);
  if (pids.length === 0) return;

  for (const pid of pids) {
    if (pid === process.pid) continue;
    const command = readCommandForPid(pid);
    const isKnownHyperiaProcess =
      command.includes("hyperia") ||
      command.includes("./dist/index.js") ||
      command.includes("vite preview --host --port 3333");
    if (!isKnownHyperiaProcess) {
      fail(
        `Port ${port} (${label}) is already in use by a non-Hyperia process: pid=${pid} command=${command}`,
      );
    }
  }

  log(
    `clearing existing ${label} listener(s) on :${port} (${pids.join(", ")})`,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore dead pids
    }
  }
  await sleep(2_000);
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await sleep(1_000);
}

async function cleanupManagedChildren() {
  for (const child of managedChildren.reverse()) {
    killProcessGroup(child.pid);
  }
  await sleep(1_500);
  for (const child of managedChildren.reverse()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // ignore dead groups
    }
  }
}

let cleanupPromise = null;
function cleanupOwnedResources() {
  cleanupPromise ||= (async () => {
    await cleanupManagedChildren();
    removeOwnedDockerResource("container", postgresContainer);
    removeOwnedDockerResource("volume", postgresVolume);
  })();
  return cleanupPromise;
}

async function handleSignal(signal, exitCode) {
  log(`received ${signal}; stopping only verifier-owned resources`);
  try {
    await cleanupOwnedResources();
  } finally {
    process.exit(exitCode);
  }
}

process.once("SIGINT", () => void handleSignal("SIGINT", 130));
process.once("SIGTERM", () => void handleSignal("SIGTERM", 143));

function runCommand(label, command, args, options = {}) {
  const logPath =
    options.logPath ||
    path.join(runtimeDir, `${label.replace(/[^a-z0-9_-]/gi, "-")}.log`);

  return new Promise((resolve, reject) => {
    const logFd = openLogFile(logPath);
    let closed = false;
    const closeLog = () => {
      if (closed) return;
      closed = true;
      fs.closeSync(logFd);
    };
    const proc = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", logFd, logFd],
    });

    proc.on("error", (error) => {
      closeLog();
      reject(error);
    });

    proc.on("exit", (code, signal) => {
      closeLog();
      if (code === 0) {
        resolve({ logPath });
        return;
      }
      reject(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`} (log: ${logPath})`,
        ),
      );
    });
  });
}

async function isSolanaReady() {
  try {
    const connection = new Connection(solanaRpcUrl, "confirmed");
    await connection.getVersion();
    return true;
  } catch {
    return false;
  }
}

async function ensureSolanaKeypair(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const secret = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secret);
  } catch {
    const keypair = Keypair.generate();
    await ensureDir(path.dirname(filePath));
    await fsp.writeFile(
      filePath,
      JSON.stringify(Array.from(keypair.secretKey), null, 2) + "\n",
      { mode: 0o600 },
    );
    return keypair;
  }
}

async function ensureSolanaValidator({
  programId,
  binaryPath,
  upgradeAuthority,
}) {
  if (await isSolanaReady()) {
    fail(
      `Solana RPC ${solanaRpcUrl} is already active; refusing to reuse an unowned validator`,
    );
  }

  await ensureDir(runtimeDir);
  await ensureDir(solanaLedgerPath);
  spawnDetached(
    "solana-test-validator",
    "solana-test-validator",
    [
      "--reset",
      "--ledger",
      solanaLedgerPath,
      "--rpc-port",
      "8899",
      "--faucet-port",
      "9900",
      "--bind-address",
      "127.0.0.1",
      "--upgradeable-program",
      programId,
      binaryPath,
      upgradeAuthority,
      "--quiet",
    ],
    {
      logPath: solanaValidatorLogPath,
    },
  );

  await waitFor("solana local validator", isSolanaReady, 45_000);
  const connection = new Connection(solanaRpcUrl, "confirmed");
  const programAccount = await connection.getAccountInfo(
    new PublicKey(programId),
    "confirmed",
  );
  assert(
    programAccount?.executable === true,
    `Preloaded Solana program ${programId} is not executable`,
  );
}

async function airdropSol(authorityPath, sol) {
  const lamportsTarget = sol * LAMPORTS_PER_SOL;
  const connection = new Connection(solanaRpcUrl, "confirmed");
  const authority = await ensureSolanaKeypair(authorityPath);
  const balance = await connection.getBalance(authority.publicKey, "confirmed");
  if (balance >= lamportsTarget) {
    log(`solana authority already funded with ${balance} lamports`);
    return authority;
  }

  await runCommand("solana-airdrop", "solana", [
    "airdrop",
    String(sol),
    authority.publicKey.toBase58(),
    "--url",
    solanaRpcUrl,
    "--keypair",
    authorityPath,
  ]);
  return authority;
}

async function buildSolanaOracle() {
  log("building canonical Solana duel oracle artifacts");
  await runCommand("build-solana-oracle", "bun", [
    "run",
    "--cwd",
    "packages/duel-oracle-solana",
    "anchor:build",
  ]);
  const idlPath = path.join(
    rootDir,
    "packages/duel-oracle-solana/anchor/target/idl/fight_oracle.json",
  );
  const binaryPath = path.join(
    rootDir,
    "packages/duel-oracle-solana/anchor/target/deploy/fight_oracle.so",
  );
  const idl = JSON.parse(await fsp.readFile(idlPath, "utf8"));
  const programId = String(idl?.address || "").trim();
  assert(
    programId,
    "Canonical fight_oracle IDL is missing its program address",
  );
  assert(
    fs.existsSync(binaryPath),
    `Canonical fight_oracle SBF binary is missing: ${binaryPath}`,
  );
  new PublicKey(programId);
  return {
    programId,
    binaryPath,
  };
}

async function verifyPreloadedSolanaOracle(programId) {
  log(`verifying preloaded Solana duel oracle ${programId}`);
  await runCommand("verify-solana-oracle", "solana", [
    "program",
    "show",
    "--url",
    solanaRpcUrl,
    programId,
  ]);
}

async function waitForHttpOk(url, label, deadlineMs) {
  await waitFor(
    label,
    async () => {
      const response = await fetch(url);
      return response.ok ? response.status : null;
    },
    deadlineMs,
  );
}

function decodeAnchorString(buffer, offset) {
  const length = buffer.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  return {
    value: buffer.subarray(start, end).toString("utf8"),
    nextOffset: end,
  };
}

function anchorDiscriminator(name) {
  return crypto
    .createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

function decodeOracleConfigAccount(data) {
  const expected = anchorDiscriminator("OracleConfig");
  assert(
    data.subarray(0, 8).equals(expected),
    "invalid OracleConfig discriminator",
  );
  return {
    authority: new PublicKey(data.subarray(8, 40)).toBase58(),
    reporter: new PublicKey(data.subarray(40, 72)).toBase58(),
    bump: data.readUInt8(72),
  };
}

function decodeDuelStateAccount(data) {
  const expected = anchorDiscriminator("DuelState");
  assert(
    data.subarray(0, 8).equals(expected),
    "invalid DuelState discriminator",
  );

  let offset = 8;
  const duelKey = data.subarray(offset, offset + 32);
  offset += 32;
  const participantAHash = data.subarray(offset, offset + 32);
  offset += 32;
  const participantBHash = data.subarray(offset, offset + 32);
  offset += 32;
  const status = data.readUInt8(offset);
  offset += 1;
  const winner = data.readUInt8(offset);
  offset += 1;
  const betOpenTs = data.readBigInt64LE(offset);
  offset += 8;
  const betCloseTs = data.readBigInt64LE(offset);
  offset += 8;
  const duelStartTs = data.readBigInt64LE(offset);
  offset += 8;
  const duelEndTs = data.readBigInt64LE(offset);
  offset += 8;
  const seed = data.readBigUInt64LE(offset);
  offset += 8;
  const resultHash = data.subarray(offset, offset + 32);
  offset += 32;
  const replayHash = data.subarray(offset, offset + 32);
  offset += 32;
  const metadataUri = decodeAnchorString(data, offset);
  offset = metadataUri.nextOffset;
  const bump = data.readUInt8(offset);

  return {
    duelKeyHex: duelKey.toString("hex"),
    participantAHashHex: participantAHash.toString("hex"),
    participantBHashHex: participantBHash.toString("hex"),
    status,
    winner,
    betOpenTs,
    betCloseTs,
    duelStartTs,
    duelEndTs,
    seed,
    resultHashHex: resultHash.toString("hex"),
    replayHashHex: replayHash.toString("hex"),
    metadataUri: metadataUri.value,
    bump,
  };
}

async function startDuelStack({ solanaProgramId, solanaAuthoritySecret }) {
  log("starting local duel stack");
  await ensureDir(runtimeDir);
  await fsp.rm(duelOracleStorePath, { force: true });
  await clearPortListeners(serverPort, "game server");
  await clearPortListeners(serverWsPort, "game websocket");
  await clearPortListeners(clientPort, "game client");
  await clearPortListeners(rtmpPort, "rtmp bridge");
  const postgresListeners = listListeningPids(postgresPort);
  assert(
    postgresListeners.length === 0,
    `Port ${postgresPort} (owned PostgreSQL) is already in use by pid(s): ${postgresListeners.join(", ")}`,
  );

  spawnDetached(
    "duel-stack",
    "bun",
    [
      "scripts/duel-stack.mjs",
      "--fresh",
      "--isolated",
      "--skip-betting",
      "--skip-keeper",
      "--server-url",
      serverUrl,
      "--ws-url",
      serverWsUrl,
      "--client-url",
      clientUrl,
      "--rtmp-port",
      String(rtmpPort),
    ],
    {
      logPath: duelStackLogPath,
      env: {
        PORT: String(serverPort),
        UWS_PORT: String(serverWsPort),
        DUEL_ARENA_ORACLE_ENABLED: "true",
        DUEL_ARENA_ORACLE_PROFILE: "local",
        DUEL_ARENA_ORACLE_STORE_PATH: duelOracleStorePath,
        DUEL_ARENA_ORACLE_METADATA_BASE_URL: `${serverUrl}/api/duel-arena/oracle`,
        DUEL_ARENA_ORACLE_SOLANA_LOCALNET_RPC_URL: solanaRpcUrl,
        DUEL_ARENA_ORACLE_SOLANA_LOCALNET_WS_URL: solanaWsUrl,
        DUEL_ARENA_ORACLE_SOLANA_LOCALNET_PROGRAM_ID: solanaProgramId,
        DUEL_ARENA_ORACLE_SOLANA_LOCALNET_AUTHORITY_SECRET:
          solanaAuthoritySecret,
        DUEL_ARENA_ORACLE_SOLANA_LOCALNET_REPORTER_SECRET:
          solanaAuthoritySecret,
        DUEL_DATABASE_MODE: "local",
        DUEL_DATABASE_URL: "",
        DATABASE_URL: "",
        USE_LOCAL_POSTGRES: "true",
        POSTGRES_CONTAINER: postgresContainer,
        POSTGRES_PORT: String(postgresPort),
        POSTGRES_USER: "hyperia_duel_oracle",
        POSTGRES_PASSWORD: `oracle-${runId}`,
        POSTGRES_DB: "hyperia_duel_oracle",
        POSTGRES_IMAGE: "postgres:16-alpine",
        // This harness validates transport/oracle integration with synthetic
        // local contestants. It must never enable a money-bearing market.
        DUEL_WITH_HYPERBET: "false",
        DUEL_LOCAL_SMOKE_MODE: "true",
        LOAD_TEST_MODE: "true",
        DUEL_LOG_LEVEL: "info",
        // This is a local verification fixture, not a production timing
        // default. Production intentionally requires an approved value.
        STREAMING_DUEL_PREPARATION_MS:
          process.env.STREAMING_DUEL_PREPARATION_MS || "5000",
        STREAMING_ANNOUNCEMENT_MS:
          process.env.STREAMING_ANNOUNCEMENT_MS || "12000",
        STREAMING_FIGHTING_MS: process.env.STREAMING_FIGHTING_MS || "45000",
        STREAMING_END_WARNING_MS:
          process.env.STREAMING_END_WARNING_MS || "5000",
        STREAMING_RESOLUTION_MS: process.env.STREAMING_RESOLUTION_MS || "5000",
      },
    },
  );

  await waitForHttpOk(`${serverUrl}/health`, "game server health", timeoutMs);
  await waitForHttpOk(
    `${serverUrl}/api/streaming/state`,
    "streaming state",
    timeoutMs,
  );
  await waitForHttpOk(`${clientUrl}/`, "game client", timeoutMs);
}

async function verifyDuelAndStreaming() {
  log("verifying duel and streaming readiness");
  const args = [
    "scripts/verify-duel-stack.mjs",
    "--server-url",
    serverUrl,
    "--client-url",
    clientUrl,
    "--hls-url",
    `${serverUrl}/live/stream.m3u8`,
    "--skip-betting",
    "--timeout-ms",
    String(duelTimeoutMs),
    "--fight-timeout-ms",
    String(Math.min(duelTimeoutMs, 180_000)),
    "--rtmp-timeout-ms",
    String(Math.min(duelTimeoutMs, 120_000)),
  ];
  if (requiredStreamDestinations.length > 0) {
    log(
      `requiring RTMP destinations: ${requiredStreamDestinations.join(", ")}`,
    );
    args.push("--require-destinations", requiredStreamDestinations.join(","));
  }
  await runCommand("verify-duel-stack", "bun", args);
}

async function waitForResolvedOracleRecord() {
  return waitFor(
    "resolved oracle record on Solana localnet",
    async () => {
      const payload = await fetchJson(
        `${serverUrl}/api/duel-arena/oracle/recent`,
      );
      const records = Array.isArray(payload?.records) ? payload.records : [];
      for (const record of records) {
        const solanaState = record?.chainState?.solanaLocalnet;
        if (
          record?.status === "RESOLVED" &&
          solanaState?.lastAction === "RESOLVE" &&
          !solanaState?.lastError &&
          typeof record?.duelKeyHex === "string"
        ) {
          return record;
        }
      }
      return null;
    },
    oracleTimeoutMs,
  );
}

async function verifySolanaState(record, programId, authorityPubkey) {
  const connection = new Connection(solanaRpcUrl, "confirmed");
  const programKey = new PublicKey(programId);
  const [configPda] = findFightOracleConfigPda(programKey);
  const [duelPda] = findFightOracleDuelStatePda(record.duelKeyHex, programKey);
  const configAccount = await connection.getAccountInfo(configPda, "confirmed");
  assert(
    configAccount,
    `missing Solana oracle config account ${configPda.toBase58()}`,
  );
  const config = decodeOracleConfigAccount(Buffer.from(configAccount.data));
  assert(
    config.authority === authorityPubkey,
    "Solana oracle authority mismatch",
  );
  assert(
    config.reporter === authorityPubkey,
    "Solana oracle reporter mismatch",
  );

  const duelAccount = await connection.getAccountInfo(duelPda, "confirmed");
  assert(duelAccount, `missing Solana duel account ${duelPda.toBase58()}`);
  const duel = decodeDuelStateAccount(Buffer.from(duelAccount.data));
  assert(
    duel.status === 3,
    `expected Solana duel status RESOLVED, got ${duel.status}`,
  );
  assert(
    duel.winner === (record.winnerSide === "A" ? 1 : 2),
    `unexpected Solana duel winner ${duel.winner}`,
  );
  assert(
    duel.metadataUri === record.metadataUri,
    "Solana metadata URI mismatch",
  );
  assert(
    duel.resultHashHex === record.resultHashHex,
    "Solana result hash mismatch",
  );
  assert(
    duel.replayHashHex === record.replayHashHex,
    "Solana replay hash mismatch",
  );
  assert(String(duel.seed) === String(record.seed), "Solana seed mismatch");

  const chainState = record.chainState.solanaLocalnet;
  assert(
    typeof chainState?.lastTxHash === "string" &&
      chainState.lastTxHash.length > 20,
    "missing Solana oracle signature",
  );
  const signature = await connection.getSignatureStatus(chainState.lastTxHash, {
    searchTransactionHistory: true,
  });
  assert(
    signature.value?.confirmationStatus,
    "Solana oracle signature not found",
  );

  return {
    signature: chainState.lastTxHash,
    duelPda: duelPda.toBase58(),
    configPda: configPda.toBase58(),
    duel,
    config,
  };
}

async function main() {
  await ensureDir(runtimeDir);
  await clearOwnedRunLogs();

  let completed = false;
  try {
    const solana = await buildSolanaOracle();
    const authority = await ensureSolanaKeypair(solanaAuthorityPath);
    await ensureSolanaValidator({
      ...solana,
      upgradeAuthority: authority.publicKey.toBase58(),
    });
    await airdropSol(solanaAuthorityPath, 200);
    await verifyPreloadedSolanaOracle(solana.programId);

    await startDuelStack({
      solanaProgramId: solana.programId,
      solanaAuthoritySecret: solanaAuthorityPath,
    });

    await verifyDuelAndStreaming();
    const record = await waitForResolvedOracleRecord();
    const solanaState = await verifySolanaState(
      record,
      solana.programId,
      authority.publicKey.toBase58(),
    );

    completed = true;
    console.log(
      JSON.stringify(
        {
          ok: true,
          serverUrl,
          clientUrl,
          solanaRpcUrl,
          duelId: record.duelId,
          duelKeyHex: record.duelKeyHex,
          winnerId: record.winnerId,
          winnerSide: record.winnerSide,
          solana: {
            programId: solana.programId,
            signature: solanaState.signature,
            configPda: solanaState.configPda,
            duelPda: solanaState.duelPda,
            status: solanaState.duel.status,
            winner: solanaState.duel.winner,
            seed: String(solanaState.duel.seed),
          },
          logs: {
            solanaValidator: solanaValidatorLogPath,
            duelStack: duelStackLogPath,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    if (!keepRunning) await cleanupOwnedResources();
  }
}

main().catch(async (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[duel-oracle-local] FAILED: ${detail}`);
  console.error(`[duel-oracle-local] logs:`);
  console.error(`  solana-validator: ${solanaValidatorLogPath}`);
  console.error(`  duel-stack: ${duelStackLogPath}`);
  await cleanupOwnedResources();
  process.exit(1);
});
