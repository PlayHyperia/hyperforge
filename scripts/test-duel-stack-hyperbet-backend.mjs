#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  isHyperbetStreamSynchronized,
  omitEnvironmentKeys,
  resolveHyperbetWorkspace,
} from "./duel-stack-topology.mjs";

const ROOT = process.cwd();
const AUTHORITY_KEYS = [
  "KEEPER_FEE_PAYER_KEYPAIR",
  "ORACLE_REPORTER_KEYPAIR",
  "ORACLE_FINALIZER_KEYPAIR",
  "CLOB_MARKET_OPERATOR_KEYPAIR",
  "MARKET_MAKER_KEYPAIR",
  "ORACLE_CONFIG_AUTHORITY_KEYPAIR",
  "CLOB_CONFIG_AUTHORITY_KEYPAIR",
  "SOLANA_ARENA_AUTHORITY_SECRET",
  "SOLANA_ARENA_REPORTER_SECRET",
  "SOLANA_ARENA_KEEPER_SECRET",
  "BETTING_FEED_ACCESS_TOKEN",
  "BETTING_FEED_ACCESS_TOKEN_PREVIOUS",
];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function boundedOutput(current, chunk) {
  return `${current}${chunk}`.slice(-16_000);
}

async function waitForSynchronizedStatus(url, expected, child, getOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Hyperbet backend exited early with code ${child.exitCode}\n${getOutput()}`,
      );
    }
    try {
      const response = await fetch(`${url}/status`, { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && isHyperbetStreamSynchronized(payload, expected)) {
        return payload;
      }
    } catch {
      // Retry until the bounded deadline.
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `Hyperbet backend did not synchronize before timeout\n${getOutput()}`,
  );
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    Bun.sleep(3_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const workspace = resolveHyperbetWorkspace({
  workspaceRoot: ROOT,
  configuredRoot: process.env.DUEL_HYPERBET_ROOT,
});
if (!workspace) {
  throw new Error(
    "A complete sibling Hyperbet SOL workspace is required for this smoke test",
  );
}

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "hyperia-hyperbet-smoke-"),
);
let backend = null;
let output = "";
let sourceSeq = 0;
const cycleId = `smoke-cycle-${Date.now()}`;
const sourceServer = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/streaming/state") {
    sourceSeq += 1;
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        type: "STREAMING_STATE_UPDATE",
        cycle: { cycleId, phase: "ANNOUNCEMENT" },
        leaderboard: [],
        cameraTarget: null,
        seq: sourceSeq,
        emittedAt: Date.now(),
      }),
    );
    return;
  }

  if (request.method === "POST" && request.url === "/rpc") {
    let body = "";
    request.on("data", (chunk) => {
      body = boundedOutput(body, chunk);
    });
    request.on("end", () => {
      let id = 1;
      try {
        id = JSON.parse(body).id ?? 1;
      } catch {
        // Return a valid empty JSON-RPC result even for malformed probes.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { context: { slot: 1 }, value: null },
        }),
      );
    });
    return;
  }

  response.writeHead(404);
  response.end();
});

try {
  const sourcePort = await listen(sourceServer);
  const probeServer = http.createServer();
  const backendPort = await listen(probeServer);
  await close(probeServer);
  const sourceUrl = `http://127.0.0.1:${sourcePort}/api/streaming/state`;
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const startedAtMs = Date.now();
  const backendEnv = {
    ...omitEnvironmentKeys(process.env, AUTHORITY_KEYS),
    NODE_ENV: "development",
    PORT: String(backendPort),
    SOLANA_CLUSTER: "localnet",
    SOLANA_RPC_URL: `http://127.0.0.1:${sourcePort}/rpc`,
    STREAM_STATE_SOURCE_URL: sourceUrl,
    STREAM_STATE_POLL_MS: "250",
    STREAM_STATE_SOURCE_TIMEOUT_MS: "1000",
    KEEPER_DB_PATH: path.join(tempDir, "keeper.sqlite"),
    KEEPER_BOT_HEALTH_FILE: path.join(tempDir, "keeper-health.json"),
    KEEPER_STREAM_STATE_FILE: path.join(tempDir, "stream-state.json"),
  };

  backend = spawn(
    process.execPath,
    [
      "run",
      "--cwd",
      path.relative(ROOT, workspace.solanaDir),
      "keeper:service",
    ],
    {
      cwd: ROOT,
      env: backendEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  backend.stdout.on("data", (chunk) => {
    output = boundedOutput(output, chunk);
  });
  backend.stderr.on("data", (chunk) => {
    output = boundedOutput(output, chunk);
  });

  const status = await waitForSynchronizedStatus(
    backendUrl,
    { sourceUrl, startedAtMs },
    backend,
    () => output,
  );
  const proxiedResponse = await fetch(`${backendUrl}/api/streaming/state`, {
    cache: "no-store",
  });
  const proxiedState = await proxiedResponse.json();
  if (!proxiedResponse.ok || proxiedState?.cycle?.cycleId !== cycleId) {
    throw new Error("Hyperbet backend did not serve the synchronized cycle");
  }

  console.log(
    JSON.stringify({
      ok: true,
      service: status.service,
      cycleId: status.stream.cycleId,
      sourcePollObserved: status.stream.lastSourcePollAt >= startedAtMs,
      proxiedCycleVerified: true,
      authoritySecretsInjected: false,
    }),
  );
} finally {
  await stopChild(backend);
  await close(sourceServer);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
