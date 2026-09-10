#!/usr/bin/env bun

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveHyperbetWorkspace } from "./duel-stack-topology.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_DIR = path.join(ROOT, "packages", "server");
const BETTING_TOKEN = `bet-sync-restart-${randomUUID()}`;
const STRATEGY_KEYS = [
  "approach",
  "attackStyle",
  "foodThreshold",
  "policyVersion",
  "prayer",
  "preferredCombatRole",
  "schemaVersion",
  "source",
  "switchDefensiveAt",
  "tacticalMacro",
];
const PROHIBITED_PUBLIC_FIELDS = [
  "agentPolicyFingerprint",
  "bank",
  "competitiveSnapshot",
  "inventory",
  "modelProvider",
  "opponentHistory",
  "rawCycle",
  "rawError",
  "reasoning",
  "wallet",
];

function boundedOutput(current, chunk) {
  return `${current}${chunk}`.slice(-24_000);
}

async function docker(args) {
  const binary = process.env.DOCKER_BIN?.trim() || "docker";
  const result = await execFileAsync(binary, args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error("failed to reserve a loopback port");
  }
  return port;
}

function spawnManaged(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output = boundedOutput(output, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output = boundedOutput(output, chunk);
  });
  return { child, output: () => output };
}

async function stopManaged(managed, signal = "SIGTERM") {
  if (
    !managed ||
    managed.child.exitCode !== null ||
    managed.child.signalCode !== null
  ) {
    return;
  }
  try {
    process.kill(-managed.child.pid, signal);
  } catch {
    managed.child.kill(signal);
  }
  const exited = await waitForManagedExit(managed, 5_000);
  if (!exited) {
    try {
      process.kill(-managed.child.pid, "SIGKILL");
    } catch {
      managed.child.kill("SIGKILL");
    }
    if (!(await waitForManagedExit(managed, 5_000))) {
      throw new Error(`managed process ${managed.child.pid} did not exit`);
    }
  }
}

async function waitForManagedExit(managed, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return managed.child.exitCode !== null || managed.child.signalCode !== null;
}

async function waitFor(description, predicate, processes, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const managed of processes) {
      if (
        managed &&
        (managed.child.exitCode !== null || managed.child.signalCode !== null)
      ) {
        throw new Error(
          `${description}: process exited ${managed.child.exitCode ?? managed.child.signalCode}\n${managed.output()}`,
        );
      }
    }
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostics = processes
    .map((managed) => managed?.output() || "")
    .filter(Boolean)
    .join("\n--- process ---\n");
  throw new Error(
    `${description} timed out${lastError ? `: ${String(lastError)}` : ""}\n${diagnostics}`,
  );
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `${url} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function report(step) {
  process.stderr.write(`[bet-sync-restart] ${step}\n`);
}

function assertStrategySummary(summary, label) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error(`${label} strategy summary is missing`);
  }
  const keys = Object.keys(summary).sort();
  if (JSON.stringify(keys) !== JSON.stringify(STRATEGY_KEYS)) {
    throw new Error(`${label} strategy keys drifted: ${JSON.stringify(keys)}`);
  }
  return JSON.stringify(summary);
}

function assertCompetitiveCommitment(version, digest, label) {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`${label} has an invalid competitive snapshot version`);
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${label} has an invalid competitive snapshot digest`);
  }
  return { version, digest };
}

function assertPublicSurface(surface, expected, label, requireEpoch = true) {
  if (requireEpoch && surface.sourceEpoch !== expected.sourceEpoch) {
    throw new Error(
      `${label} source epoch drifted: ${surface.sourceEpoch} !== ${expected.sourceEpoch}`,
    );
  }
  if (surface.cycle?.duelId !== expected.duelId) {
    throw new Error(
      `${label} duel drifted: ${surface.cycle?.duelId} !== ${expected.duelId}`,
    );
  }
  const agent1 = assertStrategySummary(
    surface.cycle?.agent1?.strategySummary,
    `${label} agent1`,
  );
  const agent2 = assertStrategySummary(
    surface.cycle?.agent2?.strategySummary,
    `${label} agent2`,
  );
  if (
    agent1 !== expected.agent1Strategy ||
    agent2 !== expected.agent2Strategy
  ) {
    throw new Error(`${label} strategy value drifted`);
  }
  const commitment = assertCompetitiveCommitment(
    surface.cycle?.competitiveSnapshotVersion,
    surface.cycle?.competitiveSnapshotDigest,
    label,
  );
  if (
    commitment.version !== expected.competitiveSnapshotVersion ||
    commitment.digest !== expected.competitiveSnapshotDigest
  ) {
    throw new Error(`${label} competitive snapshot commitment drifted`);
  }
  const serialized = JSON.stringify(surface);
  for (const field of PROHIBITED_PUBLIC_FIELDS) {
    if (serialized.includes(`\"${field}\"`)) {
      throw new Error(`${label} exposed prohibited field ${field}`);
    }
  }
}

async function readInitialSseEvent(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`${url} did not return an SSE body`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (!buffered.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel("late-subscriber proof complete");
    const frame = buffered.split("\n\n")[0] || "";
    const event =
      frame
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim() || "message";
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) throw new Error(`${url} initial SSE frame had no data`);
    return { event, data: JSON.parse(data) };
  } finally {
    clearTimeout(timeout);
  }
}

function scrubbedEnvironment() {
  const environment = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "BIRDEYE_API_KEY",
    "BOT_KEYPAIR",
    "CLOB_MARKET_OPERATOR_KEYPAIR",
    "GROQ_API_KEY",
    "MARKET_MAKER_KEYPAIR",
    "OPENAI_API_KEY",
    "ORACLE_AUTHORITY_KEYPAIR",
    "ORACLE_REPORTER_KEYPAIR",
    "SOLANA_RPC_URL",
    "SOLANA_SENDER_URL",
    "STREAM_RENDERER_HEALTH_URL",
    "STREAM_STATE_SOURCE_URL",
  ]) {
    delete environment[key];
  }
  return environment;
}

function startSource({ databaseUrl, port }) {
  return spawnManaged(
    process.execPath,
    ["run", "--cwd", SOURCE_DIR, "service:agent-duel-bet-sync-e2e"],
    {
      cwd: ROOT,
      env: {
        ...scrubbedEnvironment(),
        NODE_ENV: "development",
        AGENT_DUEL_BET_SYNC_DATABASE_URL: databaseUrl,
        AGENT_DUEL_BET_SYNC_PORT: String(port),
        BETTING_FEED_ACCESS_TOKEN: BETTING_TOKEN,
        EMBEDDED_AGENT_DUEL_PREPARATION_LLM: "false",
        STREAMING_AGENT_SKIP_DB_LOAD: "false",
        STREAMING_ANNOUNCEMENT_MS: "600000",
        STREAMING_COUNTDOWN_TICKS: "3",
        STREAMING_DUEL_COMBAT_AI_ENABLED: "true",
        STREAMING_DUEL_ENABLED: "true",
        STREAMING_DUEL_PREPARATION_MS: "60000",
        STREAMING_FIGHTING_MS: "30000",
        STREAMING_PERSIST_STATS: "false",
      },
    },
  );
}

function startKeeper({ workspace, sourcePort, keeperPort, tempDir }) {
  return spawnManaged(
    process.execPath,
    ["run", "--cwd", workspace.solanaDir, "keeper:service"],
    {
      cwd: ROOT,
      env: {
        ...scrubbedEnvironment(),
        NODE_ENV: "development",
        PORT: String(keeperPort),
        BET_SYNC_CONNECT_TIMEOUT_MS: "3000",
        BET_SYNC_RECONNECT_MAX_MS: "1000",
        BET_SYNC_RECONNECT_MIN_MS: "500",
        BET_SYNC_SOURCE_BEARER_TOKEN: BETTING_TOKEN,
        BET_SYNC_SOURCE_EVENTS_URL: `http://127.0.0.1:${sourcePort}/api/internal/bet-sync/events`,
        BET_SYNC_SOURCE_STATE_URL: `http://127.0.0.1:${sourcePort}/api/internal/bet-sync/state`,
        BET_SYNC_STALE_EVENT_TOLERANCE_MS: "0",
        CONTRACT_POLL_MS: "60000",
        DISABLE_RATE_LIMIT: "true",
        ENABLE_KEEPER_BOT: "false",
        KEEPER_BOT_HEALTH_FILE: path.join(tempDir, "keeper-health.json"),
        KEEPER_DB_PATH: path.join(tempDir, "keeper.sqlite"),
        KEEPER_STREAM_STATE_FILE: path.join(tempDir, "stream-state.json"),
        SOLANA_CLUSTER: "localnet",
      },
    },
  );
}

async function fetchSourceFrame(sourcePort) {
  return fetchJson(
    `http://127.0.0.1:${sourcePort}/api/internal/bet-sync/state`,
    { headers: { authorization: `Bearer ${BETTING_TOKEN}` } },
  );
}

async function expectedFromSource(sourcePort, processes) {
  const frame = await waitFor(
    "source strategy-bearing announcement",
    async () => {
      const candidate = await fetchSourceFrame(sourcePort);
      return candidate.agent1?.strategySummary &&
        candidate.agent2?.strategySummary
        ? candidate
        : null;
    },
    processes,
  );
  const commitment = assertCompetitiveCommitment(
    frame.competitiveSnapshotVersion,
    frame.competitiveSnapshotDigest,
    "source",
  );
  return {
    sourceEpoch: frame.sourceEpoch,
    sourceSeq: frame.seq,
    duelId: frame.duelId,
    duelKey: frame.duelKey,
    competitiveSnapshotVersion: commitment.version,
    competitiveSnapshotDigest: commitment.digest,
    agent1Strategy: assertStrategySummary(
      frame.agent1.strategySummary,
      "source agent1",
    ),
    agent2Strategy: assertStrategySummary(
      frame.agent2.strategySummary,
      "source agent2",
    ),
  };
}

async function waitForKeeper(keeperPort, expected, processes) {
  const baseUrl = `http://127.0.0.1:${keeperPort}`;
  return waitFor(
    `keeper epoch ${expected.sourceEpoch} synchronization`,
    async () => {
      const status = await fetchJson(`${baseUrl}/status`);
      if (
        status.stream?.betSync?.sourceEpoch !== expected.sourceEpoch ||
        status.stream?.betSync?.lastAppliedSeq < 1 ||
        status.stream?.cycleId !== expected.duelId
      ) {
        return null;
      }
      const state = await fetchJson(`${baseUrl}/api/streaming/state`);
      assertPublicSurface(state, expected, "keeper state");
      return { status, state };
    },
    processes,
  );
}

async function provePublicSurfaces(keeperPort, expected) {
  const baseUrl = `http://127.0.0.1:${keeperPort}`;
  const [state, session, context, stateEvent, sessionEvent] = await Promise.all(
    [
      fetchJson(`${baseUrl}/api/streaming/state`),
      fetchJson(`${baseUrl}/api/streaming/session`),
      fetchJson(`${baseUrl}/api/streaming/duel-context`),
      readInitialSseEvent(`${baseUrl}/api/streaming/state/events`),
      readInitialSseEvent(`${baseUrl}/api/streaming/session/events`),
    ],
  );
  assertPublicSurface(state, expected, "state REST");
  assertPublicSurface(session, expected, "session REST");
  assertPublicSurface(context, expected, "duel-context REST", false);
  if (stateEvent.event !== "reset" || sessionEvent.event !== "reset") {
    throw new Error("late subscribers did not receive reset events");
  }
  assertPublicSurface(stateEvent.data, expected, "state SSE reset");
  assertPublicSurface(sessionEvent.data, expected, "session SSE reset");
  return {
    stateSeq: state.seq,
    sessionSeq: session.seq,
    stateSseReset: true,
    sessionSseReset: true,
  };
}

const configuredHyperbet = process.env.DUEL_HYPERBET_ROOT?.trim();
const localAuditWorkspace = path.resolve(ROOT, "..", "hyperbet-main-audit");
const workspace = resolveHyperbetWorkspace({
  workspaceRoot: ROOT,
  configuredRoot:
    configuredHyperbet ||
    (fs.existsSync(path.join(localAuditWorkspace, "package.json"))
      ? localAuditWorkspace
      : ""),
});
if (!workspace) {
  throw new Error(
    "A complete Hyperbet SOL workspace is required; set DUEL_HYPERBET_ROOT",
  );
}

const containerName = `hyperia-bet-sync-restart-${process.pid}`;
const databaseUser = "bet_sync_restart";
const databaseName = "bet_sync_restart";
const databasePassword = `bet-sync-${randomUUID()}`;
const postgresImage =
  process.env.AGENT_DUEL_BET_SYNC_POSTGRES_IMAGE?.trim() ||
  "postgres:16-alpine";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bet-sync-restart-"));
const sourcePort = await reservePort();
const keeperPort = await reservePort();
let containerStarted = false;
let source = null;
let keeper = null;
let cleanupPromise = null;

async function cleanup() {
  cleanupPromise ??= (async () => {
    await stopManaged(keeper).catch(() => undefined);
    await stopManaged(source).catch(() => undefined);
    if (containerStarted) {
      await docker(["stop", "--timeout", "1", containerName]).catch(
        () => undefined,
      );
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

function handleSignal(signal) {
  report(`received ${signal}; cleaning isolated processes`);
  void cleanup().finally(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

try {
  report("checking Docker");
  await docker(["info", "--format", "{{.ServerVersion}}"]);
  report("starting isolated PostgreSQL");
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-e",
    `POSTGRES_USER=${databaseUser}`,
    "-e",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "-e",
    `POSTGRES_DB=${databaseName}`,
    "-p",
    "127.0.0.1::5432",
    postgresImage,
  ]);
  containerStarted = true;
  const portOutput = await docker(["port", containerName, "5432/tcp"]);
  const postgresPort = Number(portOutput.split(":").pop());
  if (!Number.isSafeInteger(postgresPort) || postgresPort <= 0) {
    throw new Error("could not resolve temporary PostgreSQL port");
  }
  const databaseUrl = `postgresql://${databaseUser}:${encodeURIComponent(databasePassword)}@127.0.0.1:${postgresPort}/${databaseName}`;

  report("starting persisted Hyperia bet-sync source");
  source = startSource({ databaseUrl, port: sourcePort });
  await waitFor(
    "initial source readiness",
    () => fetchJson(`http://127.0.0.1:${sourcePort}/health`),
    [source],
  );
  report("waiting for frozen source strategies");
  const initialExpected = await expectedFromSource(sourcePort, [source]);

  report("starting SOL keeper");
  keeper = startKeeper({ workspace, sourcePort, keeperPort, tempDir });
  const initialKeeper = await waitForKeeper(keeperPort, initialExpected, [
    source,
    keeper,
  ]);
  const initialSurfaces = await provePublicSurfaces(
    keeperPort,
    initialExpected,
  );

  report("hard-restarting SOL keeper against its persisted checkpoint");
  await stopManaged(keeper, "SIGKILL");
  keeper = startKeeper({ workspace, sourcePort, keeperPort, tempDir });
  const restartedKeeper = await waitForKeeper(keeperPort, initialExpected, [
    source,
    keeper,
  ]);
  const keeperRestartSurfaces = await provePublicSurfaces(
    keeperPort,
    initialExpected,
  );
  if (
    restartedKeeper.status.stream.betSync.lastAppliedSeq <
    initialKeeper.status.stream.betSync.lastAppliedSeq
  ) {
    throw new Error("keeper restart regressed its persisted checkpoint");
  }

  report("hard-restarting Hyperia source against the persisted duel");
  await stopManaged(source, "SIGKILL");
  source = startSource({ databaseUrl, port: sourcePort });
  await waitFor(
    "replacement source readiness",
    () => fetchJson(`http://127.0.0.1:${sourcePort}/health`),
    [source, keeper],
  );
  const restartedExpected = await expectedFromSource(sourcePort, [
    source,
    keeper,
  ]);
  if (restartedExpected.sourceEpoch === initialExpected.sourceEpoch) {
    throw new Error("source restart did not advance the source epoch");
  }
  if (
    restartedExpected.duelId !== initialExpected.duelId ||
    restartedExpected.duelKey !== initialExpected.duelKey
  ) {
    throw new Error("source restart did not recover the same competitive duel");
  }
  if (
    restartedExpected.agent1Strategy !== initialExpected.agent1Strategy ||
    restartedExpected.agent2Strategy !== initialExpected.agent2Strategy
  ) {
    throw new Error("source restart changed frozen strategy truth");
  }
  if (
    restartedExpected.competitiveSnapshotVersion !==
      initialExpected.competitiveSnapshotVersion ||
    restartedExpected.competitiveSnapshotDigest !==
      initialExpected.competitiveSnapshotDigest
  ) {
    throw new Error("source restart changed competitive snapshot commitment");
  }
  if (
    restartedExpected.sourceSeq >=
    restartedKeeper.status.stream.betSync.lastAppliedSeq
  ) {
    throw new Error(
      "source restart did not regress below the persisted keeper checkpoint",
    );
  }
  const epochRestartKeeper = await waitForKeeper(
    keeperPort,
    restartedExpected,
    [source, keeper],
  );
  const epochRestartSurfaces = await provePublicSurfaces(
    keeperPort,
    restartedExpected,
  );

  report("hard-restarting SOL keeper after source epoch rollover");
  await stopManaged(keeper, "SIGKILL");
  keeper = startKeeper({ workspace, sourcePort, keeperPort, tempDir });
  const finalKeeper = await waitForKeeper(keeperPort, restartedExpected, [
    source,
    keeper,
  ]);
  const finalSurfaces = await provePublicSurfaces(
    keeperPort,
    restartedExpected,
  );

  const strategyHash = createHash("sha256")
    .update(
      [initialExpected.agent1Strategy, initialExpected.agent2Strategy].join(
        "\n",
      ),
    )
    .digest("hex");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      duelId: initialExpected.duelId,
      sourceEpochs: [
        initialExpected.sourceEpoch,
        restartedExpected.sourceEpoch,
      ],
      sourceSequenceRegressed:
        restartedExpected.sourceSeq <
        restartedKeeper.status.stream.betSync.lastAppliedSeq,
      keeperRestarts: 2,
      sourceRestarts: 1,
      initialAppliedSeq: initialKeeper.status.stream.betSync.lastAppliedSeq,
      resumedAppliedSeq: restartedKeeper.status.stream.betSync.lastAppliedSeq,
      epochAppliedSeq: epochRestartKeeper.status.stream.betSync.lastAppliedSeq,
      finalAppliedSeq: finalKeeper.status.stream.betSync.lastAppliedSeq,
      lateSubscriberProofs: [
        initialSurfaces,
        keeperRestartSurfaces,
        epochRestartSurfaces,
        finalSurfaces,
      ],
      strategyHash,
      competitiveSnapshotVersion: initialExpected.competitiveSnapshotVersion,
      competitiveSnapshotDigest: initialExpected.competitiveSnapshotDigest,
      exactStrategyFields: STRATEGY_KEYS.length,
      privateFieldsAbsent: true,
      browserOpened: false,
    })}\n`,
  );
} finally {
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  await cleanup();
}
