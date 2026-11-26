#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assertHyperiaNodeVersion } from "./node-runtime-policy.mjs";
import {
  assertDockerImageReference,
  assertDockerResourceName,
  classifyServerDiagnostics,
  parseKeyValueProbe,
  parsePositiveInteger,
  SERVER_CONTAINER_POSTGRES_IMAGE,
  validateDatabaseProbe,
  validateHttpProbe,
  validateRuntimeProbe,
} from "./server-container-smoke-policy.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "skip-build": { type: "boolean" },
    "keep-image": { type: "boolean" },
    "image-tag": { type: "string" },
    "build-timeout-ms": { type: "string", default: "1200000" },
    "startup-timeout-ms": { type: "string", default: "180000" },
  },
  strict: true,
}).values;

if (options.help) {
  console.log(`
Canonical Hyperia production-container smoke.

Usage:
  node scripts/smoke-server-container.mjs [options]

Options:
  --skip-build                 Qualify an already-present --image-tag
  --keep-image                 Retain an image built by this invocation
  --image-tag <name:tag>       Override the unique local smoke tag
  --build-timeout-ms <ms>      Docker build deadline (default: 1200000)
  --startup-timeout-ms <ms>    PostgreSQL/server/health deadline (default: 180000)

The command builds Dockerfile.server, starts a uniquely named isolated
PostgreSQL/server topology with streaming and external value disabled, proves
the exact non-root Node runtime, all migrations, strict database health, built
client/stream routes, public-env secrecy, and graceful SIGTERM, then removes
only the resources it created. It also enables the edge-to-origin lock and
proves authorized delivery plus missing, wrong, duplicate, lookalike-path, and
state-changing-probe rejection.
`);
  process.exit(0);
}

assertHyperiaNodeVersion(process.version);

const buildTimeoutMs = parsePositiveInteger(
  options["build-timeout-ms"],
  "--build-timeout-ms",
  1_200_000,
);
const startupTimeoutMs = parsePositiveInteger(
  options["startup-timeout-ms"],
  "--startup-timeout-ms",
  180_000,
);
const skipBuild = options["skip-build"] === true;
const keepImage = options["keep-image"] === true;
const runId = `${Date.now()}-${process.pid}`;
const prefix = assertDockerResourceName(
  `hyperia-server-container-smoke-${runId}`,
  "smoke resource prefix",
);
const imageTag = assertDockerImageReference(
  options["image-tag"] || `hyperia-server-container-smoke:${runId}`,
  "--image-tag",
);
const networkName = `${prefix}-net`;
const databaseContainer = `${prefix}-db`;
const serverContainer = `${prefix}-server`;
const ownsImage = !skipBuild;

let networkCreated = false;
let databaseCreated = false;
let serverCreated = false;
let cleanupStarted = false;
let interruptedSignal = null;

function log(message) {
  console.log(`[server-container-smoke] ${message}`);
}

async function docker(args, options = {}) {
  try {
    return await execFileAsync("docker", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
      timeout: options.timeout,
    });
  } catch (error) {
    if (options.allowFailure) return error;
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    const detail = [stderr, stdout].filter(Boolean).join("\n").slice(-8_000);
    throw new Error(
      `docker ${args[0] || "command"} failed${detail ? `:\n${detail}` : ""}`,
      { cause: error },
    );
  }
}

async function runStreaming(command, args, label, timeoutMs) {
  log(label);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${label} failed with ${signal ? `signal ${signal}` : `exit ${code}`}`,
          ),
        );
      }
    });
  });
}

async function dockerObjectExists(kind, name) {
  const result = await docker([kind, "inspect", name], { allowFailure: true });
  return result?.code == null;
}

async function assertResourceAbsent(kind, name) {
  if (await dockerObjectExists(kind, name)) {
    throw new Error(`Refusing to reuse existing Docker ${kind} ${name}`);
  }
}

async function inspectContainer(name) {
  const { stdout } = await docker(["container", "inspect", name]);
  return JSON.parse(stdout)[0];
}

async function inspectImage(name) {
  const { stdout } = await docker(["image", "inspect", name]);
  return JSON.parse(stdout)[0];
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, callback) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw new Error(
    `${label} did not become ready within ${startupTimeoutMs}ms${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}

async function assertContainerRunning(name) {
  const inspection = await inspectContainer(name);
  if (!inspection.State.Running) {
    const logs = await docker(["logs", name], { allowFailure: true });
    throw new Error(
      `${name} exited with ${inspection.State.ExitCode}:\n${String(
        logs?.stdout || logs?.stderr || "",
      ).slice(-8_000)}`,
    );
  }
  return inspection;
}

async function httpProbe(
  pathname,
  { parseJson = false, headers = [], method = "GET" } = {},
) {
  const marker = "__HYPERIA_HTTP_STATUS__:";
  const args = [
    "exec",
    serverContainer,
    "curl",
    "-sS",
    "--max-time",
    "10",
    "-D",
    "-",
    "-X",
    method,
  ];
  for (const header of headers) {
    args.push("-H", header);
  }
  args.push(
    "-w",
    `\n${marker}%{http_code}`,
    `http://127.0.0.1:5555${pathname}`,
  );
  const { stdout } = await docker(args);
  const markerIndex = stdout.lastIndexOf(`\n${marker}`);
  if (markerIndex < 0) {
    throw new Error(`HTTP probe for ${pathname} omitted its status marker`);
  }
  const responseText = stdout.slice(0, markerIndex);
  const separator = responseText.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const separatorIndex = responseText.indexOf(separator);
  if (separatorIndex < 0) {
    throw new Error(`HTTP probe for ${pathname} omitted response headers`);
  }
  const headerText = responseText.slice(0, separatorIndex);
  const bodyText = responseText.slice(separatorIndex + separator.length);
  const responseHeaders = {};
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    responseHeaders[line.slice(0, colonIndex).toLowerCase()] = line
      .slice(colonIndex + 1)
      .trim();
  }
  const statusCode = Number(stdout.slice(markerIndex + marker.length + 1));
  if (!Number.isSafeInteger(statusCode)) {
    throw new Error(`HTTP probe for ${pathname} returned an invalid status`);
  }
  return {
    statusCode,
    body: parseJson ? JSON.parse(bodyText) : bodyText,
    headers: responseHeaders,
  };
}

async function runtimeProbe() {
  const probeScript = `
set -eu
printf 'node='; node --version
printf 'uid='; id -u
printf 'bun='; if command -v bun >/dev/null 2>&1; then echo present; else echo absent; fi
printf 'assets_git='; if [ -e /app/packages/server/world/assets/.git ]; then echo present; else echo absent; fi
printf 'artifacts='; if [ -e /app/artifacts ]; then echo present; else echo absent; fi
printf 'test_sources='; if find /app/packages -type f \\( -name '*.test.*' -o -name '*.spec.*' -o -name '*.e2e.*' -o -path '*/scripts/test-*' \\) -print -quit | grep -q .; then echo present; else echo absent; fi
printf 'migration_readable='; if [ -r /app/packages/server/src/database/migrations/0000_numerous_korvac.sql ]; then echo true; else echo false; fi
printf 'migration_writable='; if [ -w /app/packages/server/src/database/migrations/0000_numerous_korvac.sql ]; then echo true; else echo false; fi
`;
  const { stdout } = await docker([
    "run",
    "--rm",
    "--entrypoint",
    "/bin/sh",
    imageTag,
    "-c",
    probeScript,
  ]);
  return validateRuntimeProbe(parseKeyValueProbe(stdout.trim()));
}

async function databaseProbe() {
  const migrationJournal = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        "packages/server/src/database/migrations/meta/_journal.json",
      ),
      "utf8",
    ),
  );
  const expectedMigrationEntries = migrationJournal.entries.length;
  const sql = [
    "select count(*) from drizzle.__drizzle_migrations",
    "select count(*) from information_schema.tables where table_schema='public'",
    "select to_regclass('public.streaming_duel_history') is not null",
    "select to_regclass('public.agent_bank_operations') is not null",
    "select to_regclass('public.agent_autonomy_checkpoints') is not null",
    "select to_regclass('public.streaming_duel_action_observation_heads') is not null",
    "select to_regclass('public.streaming_duel_action_observations') is not null",
    "select to_regclass('public.streaming_duel_preparation_agent_host_leases') is not null",
  ].join("; ");
  const { stdout } = await docker([
    "exec",
    databaseContainer,
    "psql",
    "-U",
    "postgres",
    "-d",
    "hyperia",
    "-Atc",
    sql,
  ]);
  const values = stdout.trim().split(/\r?\n/);
  if (values.length !== 8) {
    throw new Error(
      `Database probe returned ${values.length} values, expected 8`,
    );
  }
  return validateDatabaseProbe({
    migrationJournalEntries: Number(values[0]),
    expectedMigrationEntries,
    publicTableCount: Number(values[1]),
    requiredTables: {
      streaming_duel_history: values[2] === "t",
      agent_bank_operations: values[3] === "t",
      agent_autonomy_checkpoints: values[4] === "t",
      streaming_duel_action_observation_heads: values[5] === "t",
      streaming_duel_action_observations: values[6] === "t",
      streaming_duel_preparation_agent_host_leases: values[7] === "t",
    },
  });
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  log("Cleaning owned Docker resources");

  if (
    serverCreated ||
    (await dockerObjectExists("container", serverContainer))
  ) {
    const inspection = await inspectContainer(serverContainer).catch(
      () => null,
    );
    if (inspection?.State.Running) {
      await docker(["stop", "--timeout", "15", serverContainer], {
        allowFailure: true,
      });
    }
    await docker(["rm", "--force", serverContainer], { allowFailure: true });
    serverCreated = false;
  }

  if (
    databaseCreated ||
    (await dockerObjectExists("container", databaseContainer))
  ) {
    const inspection = await inspectContainer(databaseContainer).catch(
      () => null,
    );
    if (inspection?.State.Running) {
      await docker(["stop", "--timeout", "15", databaseContainer], {
        allowFailure: true,
      });
    }
    await docker(["rm", "--force", databaseContainer], {
      allowFailure: true,
    });
    databaseCreated = false;
  }

  if (networkCreated || (await dockerObjectExists("network", networkName))) {
    await docker(["network", "rm", networkName], { allowFailure: true });
    networkCreated = false;
  }

  if (
    ownsImage &&
    !keepImage &&
    (await dockerObjectExists("image", imageTag))
  ) {
    await docker(["image", "rm", imageTag], { allowFailure: true });
  }

  for (const [kind, name] of [
    ["container", serverContainer],
    ["container", databaseContainer],
    ["network", networkName],
  ]) {
    if (await dockerObjectExists(kind, name)) {
      throw new Error(`Owned Docker ${kind} leaked after cleanup: ${name}`);
    }
  }
  if (
    ownsImage &&
    !keepImage &&
    (await dockerObjectExists("image", imageTag))
  ) {
    throw new Error(`Owned Docker image leaked after cleanup: ${imageTag}`);
  }
}

async function qualify() {
  const dockerVersion = await docker([
    "version",
    "--format",
    "{{.Server.Version}}",
  ]).then(({ stdout }) => stdout.trim());
  await assertResourceAbsent("container", serverContainer);
  await assertResourceAbsent("container", databaseContainer);
  await assertResourceAbsent("network", networkName);

  const imageAlreadyExists = await dockerObjectExists("image", imageTag);
  if (skipBuild && !imageAlreadyExists) {
    throw new Error(`--skip-build requires an existing image: ${imageTag}`);
  }
  if (!skipBuild && imageAlreadyExists) {
    throw new Error(`Refusing to overwrite existing image: ${imageTag}`);
  }

  if (!skipBuild) {
    await runStreaming(
      "docker",
      [
        "build",
        "--progress=plain",
        "-f",
        "Dockerfile.server",
        "-t",
        imageTag,
        ".",
      ],
      "Building the canonical production image",
      buildTimeoutMs,
    );
  }

  const image = await inspectImage(imageTag);
  const runtime = await runtimeProbe();

  await docker(["network", "create", networkName]);
  networkCreated = true;

  const databasePassword = randomBytes(24).toString("hex");
  await docker([
    "run",
    "-d",
    "--name",
    databaseContainer,
    "--network",
    networkName,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "-e",
    "POSTGRES_DB=hyperia",
    SERVER_CONTAINER_POSTGRES_IMAGE,
  ]);
  databaseCreated = true;

  await waitFor("PostgreSQL", async () => {
    await assertContainerRunning(databaseContainer);
    const result = await docker(
      [
        "exec",
        databaseContainer,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "hyperia",
      ],
      { allowFailure: true },
    );
    return result?.code == null;
  });

  const jwtSigningSecret = randomBytes(48).toString("hex");
  const jwtSigningKeyId = "container-smoke-active";
  const jwtSigningFingerprint = createHash("sha256")
    .update(jwtSigningSecret, "utf8")
    .digest("hex")
    .slice(0, 16);
  const distributedRateLimitSecret = randomBytes(48).toString("hex");
  const distributedRateLimitFingerprint = createHash("sha256")
    .update("hyperia-distributed-rate-limit-key-v1\0", "utf8")
    .update(distributedRateLimitSecret, "utf8")
    .digest("hex")
    .slice(0, 16);
  const cloudflareOriginSecret = randomBytes(48).toString("hex");
  const cloudflareOriginFingerprint = createHash("sha256")
    .update("hyperia/cloudflare-origin-lock/v1\0", "utf8")
    .update(cloudflareOriginSecret, "utf8")
    .digest("hex")
    .slice(0, 16);
  await docker([
    "run",
    "-d",
    "--name",
    serverContainer,
    "--network",
    networkName,
    "-e",
    `DATABASE_URL=postgresql://postgres:${databasePassword}@${databaseContainer}:5432/hyperia`,
    "-e",
    "USE_LOCAL_POSTGRES=false",
    "-e",
    `JWT_ACTIVE_KEY_ID=${jwtSigningKeyId}`,
    "-e",
    `JWT_SIGNING_KEYS=${JSON.stringify({
      [jwtSigningKeyId]: jwtSigningSecret,
    })}`,
    "-e",
    `DISTRIBUTED_RATE_LIMIT_KEY_SECRET=${distributedRateLimitSecret}`,
    "-e",
    `CLOUDFLARE_ORIGIN_SECRET=${cloudflareOriginSecret}`,
    "-e",
    "STREAMING_DUEL_ENABLED=false",
    "-e",
    "STREAMING_CAPTURE_ENABLED=false",
    "-e",
    "STREAMING_DUEL_SCHEDULER_ROLE=disabled",
    "-e",
    "HYPERIA_EXTERNAL_VALUE_ENABLED=false",
    "-e",
    "PUBLIC_CDN_URL=https://assets.hyperia.club",
    imageTag,
  ]);
  serverCreated = true;

  const status = await waitFor("server /status", async () => {
    await assertContainerRunning(serverContainer);
    const probe = await httpProbe("/status", { parseJson: true });
    return probe.statusCode === 200 ? probe : null;
  });
  const health = await httpProbe("/health", { parseJson: true });
  const authorizedHeaders = [
    `x-hyperia-origin-secret: ${cloudflareOriginSecret}`,
  ];
  const root = await httpProbe("/", { headers: authorizedHeaders });
  const stream = await httpProbe("/stream.html", {
    headers: authorizedHeaders,
  });
  const publicEnvironment = await httpProbe("/env.js", {
    headers: authorizedHeaders,
  });
  const streamingHealth = await httpProbe("/api/streaming/health", {
    parseJson: true,
    headers: authorizedHeaders,
  });
  const csrfToken = await httpProbe("/api/csrf-token", {
    parseJson: true,
    headers: authorizedHeaders,
  });
  const csrfValue = csrfToken.body?.token;
  if (typeof csrfValue !== "string") {
    throw new Error("CSRF token probe did not return a token");
  }
  const csrfHeaders = [
    `Cookie: csrf-token=${csrfValue}`,
    `X-CSRF-Token: ${csrfValue}`,
  ];
  const debugPublic = await httpProbe("/debug/public", {
    parseJson: true,
    headers: authorizedHeaders,
  });
  const reservedApiMissing = await httpProbe(
    "/api/not-real?container-smoke-sensitive-marker=1",
    {
      parseJson: true,
      headers: authorizedHeaders,
    },
  );
  const proxyNonMainnet = await httpProbe(
    "/api/proxy/solana/rpc?cluster=devnet",
    {
      parseJson: true,
      method: "POST",
      headers: [...authorizedHeaders, "Origin: https://hyperbet.win"],
    },
  );
  const originLockMissing = await httpProbe("/", { parseJson: true });
  const originLockWrong = await httpProbe("/", {
    parseJson: true,
    headers: ["x-hyperia-origin-secret: definitely-not-the-secret"],
  });
  const originLockDuplicate = await httpProbe("/", {
    parseJson: true,
    headers: [...authorizedHeaders, ...authorizedHeaders],
  });
  const originLockLookalike = await httpProbe("/healthz", {
    parseJson: true,
  });
  const originLockMutation = await httpProbe("/health", {
    parseJson: true,
    method: "POST",
  });
  const writeOriginWrong = await httpProbe("/api/errors/frontend", {
    parseJson: true,
    method: "POST",
    headers: [...authorizedHeaders, "Origin: https://attacker.example"],
  });
  const proxyOriginMissing = await httpProbe("/api/proxy/solana/rpc", {
    parseJson: true,
    method: "POST",
    headers: [...authorizedHeaders, ...csrfHeaders],
  });
  const proxyOriginWrong = await httpProbe("/api/proxy/solana/rpc", {
    parseJson: true,
    method: "POST",
    headers: [...authorizedHeaders, "Origin: https://hyperia.gg.attacker.test"],
  });
  validateHttpProbe({
    status,
    health,
    root,
    stream,
    publicEnvironment,
    streamingHealth,
    csrfToken,
    debugPublic,
    reservedApiMissing,
    proxyNonMainnet,
    originLockMissing,
    originLockWrong,
    originLockDuplicate,
    originLockLookalike,
    originLockMutation,
    writeOriginWrong,
    proxyOriginMissing,
    proxyOriginWrong,
  });

  const database = await databaseProbe();
  const healthyContainer = await waitFor("Docker healthcheck", async () => {
    const inspection = await assertContainerRunning(serverContainer);
    if (inspection.State.Health?.Status === "unhealthy") {
      throw new Error("Docker healthcheck became unhealthy");
    }
    return inspection.State.Health?.Status === "healthy" ? inspection : null;
  });
  if (healthyContainer.RestartCount !== 0 || healthyContainer.State.OOMKilled) {
    throw new Error("Server restarted or was OOM-killed during qualification");
  }

  await docker(["stop", "--timeout", "30", serverContainer]);
  const stoppedContainer = await inspectContainer(serverContainer);
  if (
    stoppedContainer.State.ExitCode !== 0 ||
    stoppedContainer.RestartCount !== 0 ||
    stoppedContainer.State.OOMKilled
  ) {
    throw new Error(
      `Graceful shutdown failed: exit=${stoppedContainer.State.ExitCode} restart=${stoppedContainer.RestartCount} oom=${stoppedContainer.State.OOMKilled}`,
    );
  }

  const { stdout: serverLogs, stderr: serverLogStderr } = await docker([
    "logs",
    serverContainer,
  ]);
  const diagnostics = classifyServerDiagnostics(
    `${serverLogs}\n${serverLogStderr}`,
  );
  if (diagnostics.unexpected.length > 0) {
    throw new Error(
      `Unexpected server diagnostics:\n${diagnostics.unexpected.join("\n")}`,
    );
  }
  if (`${serverLogs}\n${serverLogStderr}`.includes(databasePassword)) {
    throw new Error("Server logs exposed the disposable database credential");
  }
  if (`${serverLogs}\n${serverLogStderr}`.includes(jwtSigningSecret)) {
    throw new Error("Server logs exposed the disposable JWT credential");
  }
  if (
    `${serverLogs}\n${serverLogStderr}`.includes(distributedRateLimitSecret)
  ) {
    throw new Error(
      "Server logs exposed the disposable distributed rate-limit credential",
    );
  }
  if (`${serverLogs}\n${serverLogStderr}`.includes(cloudflareOriginSecret)) {
    throw new Error("Server logs exposed the disposable origin credential");
  }
  if (
    !`${serverLogs}\n${serverLogStderr}`.includes(
      `JWT authority ready mode=key-ring active=${jwtSigningKeyId} verify=${jwtSigningKeyId}:${jwtSigningFingerprint}`,
    )
  ) {
    throw new Error("Server did not report the expected JWT key-ring evidence");
  }
  if (
    !`${serverLogs}\n${serverLogStderr}`.includes(
      `Distributed authentication rate-limit authority ready key=${distributedRateLimitFingerprint}`,
    )
  ) {
    throw new Error(
      "Server did not report the expected shared rate-limit evidence",
    );
  }
  if (
    !`${serverLogs}\n${serverLogStderr}`.includes(
      `Cloudflare origin-lock authority ready key=${cloudflareOriginFingerprint}`,
    )
  ) {
    const observedOriginEvidence = `${serverLogs}\n${serverLogStderr}`
      .split(/\r?\n/)
      .filter((line) => /Cloudflare origin/i.test(line))
      .join("\n");
    throw new Error(
      `Server did not report the expected Cloudflare origin-lock evidence fingerprint=${cloudflareOriginFingerprint}` +
        `${observedOriginEvidence ? `; observed:\n${observedOriginEvidence}` : "; observed no origin-lock lines"}`,
    );
  }

  return {
    ok: true,
    classification: "owned_local_no_value",
    dockerVersion,
    image: {
      digest: image.Id,
      sizeBytes: image.Size,
      user: image.Config.User,
      node: runtime.node,
      bunPresent: false,
      assetGitMetadataPresent: false,
      retainedArtifactsPresent: false,
      testSourcesPresent: false,
    },
    database,
    endpoints: {
      status: status.statusCode,
      health: health.statusCode,
      root: root.statusCode,
      stream: stream.statusCode,
      publicEnvironment: publicEnvironment.statusCode,
      streamingHealth: streamingHealth.statusCode,
      csrfToken: csrfToken.statusCode,
      debugPublic: debugPublic.statusCode,
      reservedApiMissing: reservedApiMissing.statusCode,
      proxyNonMainnet: proxyNonMainnet.statusCode,
      originLockMissing: originLockMissing.statusCode,
      originLockWrong: originLockWrong.statusCode,
      originLockDuplicate: originLockDuplicate.statusCode,
      originLockLookalike: originLockLookalike.statusCode,
      originLockMutation: originLockMutation.statusCode,
      writeOriginWrong: writeOriginWrong.statusCode,
      proxyOriginMissing: proxyOriginMissing.statusCode,
      proxyOriginWrong: proxyOriginWrong.statusCode,
    },
    lifecycle: {
      dockerHealth: healthyContainer.State.Health.Status,
      restartCount: stoppedContainer.RestartCount,
      oomKilled: stoppedContainer.State.OOMKilled,
      gracefulExitCode: stoppedContainer.State.ExitCode,
    },
    knownOpenDiagnostics: diagnostics.knownOpen,
    externalValueEnabled: false,
  };
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
    void cleanup()
      .catch((error) => console.error(error))
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

let result;
let failure;
try {
  result = await qualify();
} catch (error) {
  failure = error;
}

try {
  await cleanup();
} catch (error) {
  failure = failure
    ? new AggregateError([failure, error], "Qualification and cleanup failed")
    : error;
}

if (failure) throw failure;
if (interruptedSignal) process.exit(interruptedSignal === "SIGINT" ? 130 : 143);

console.log(JSON.stringify(result, null, 2));
