import assert from "node:assert/strict";

export const SERVER_CONTAINER_POSTGRES_IMAGE =
  "pgvector/pgvector@sha256:7d400e340efb42f4d8c9c12c6427adb253f726881a9985d2a471bf0eed824dff";

const KNOWN_OPEN_DIAGNOSTICS = [
  /Missing recommended production config: PRIVY_APP_ID, PRIVY_APP_SECRET/,
  /world-config\.json not found/,
  /buildings\.json missing or invalid/,
  /Only \d+\/25 procedural towns generated/,
  /\[EventLoop\].*Blocked for \d+ms at tick 0/,
  /Unknown resource ID in world-areas: tree_(?:normal|willow|teak|yew)/,
  /NPC duel_arena_(?:nurse|scoreboard|guide) not found/,
  /\[TickSystem\] Already running/,
  /ADMIN_CODE not set in production\. Admin panel disabled/,
];

const DIAGNOSTIC_MARKER =
  /(?:warning|warn|error|fatal|unknown|missing|invalid|blocked|❌|⚠️)/i;
const CRITICAL_DIAGNOSTIC = /(?:error|fatal|❌)/i;

export function parsePositiveInteger(value, name, fallback) {
  const resolved = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

export function assertDockerResourceName(value, name) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`${name} is not a safe Docker resource name`);
  }
  return value;
}

export function assertDockerImageReference(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/.test(value)
  ) {
    throw new Error(`${name} is not a safe Docker image reference`);
  }
  return value;
}

export function parseKeyValueProbe(source) {
  const result = {};
  for (const line of String(source).split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Malformed container probe line: ${line}`);
    }
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

export function validateRuntimeProbe(probe) {
  assert.equal(probe.node, "v22.23.2");
  assert.equal(probe.uid, "1000");
  assert.equal(probe.bun, "absent");
  assert.equal(probe.assets_git, "absent");
  assert.equal(probe.artifacts, "absent");
  assert.equal(probe.test_sources, "absent");
  assert.equal(probe.migration_readable, "true");
  assert.equal(probe.migration_writable, "false");
  return probe;
}

export function validateHttpProbe(input) {
  assert.equal(input.status.statusCode, 200);
  assert.equal(typeof input.status.body.uptime, "number");
  assert.equal(input.status.body.protected, false);
  assert.equal(typeof input.status.body.connectedUserCount, "number");
  assert.equal("connectedUsers" in input.status.body, false);

  assert.equal(input.health.statusCode, 200);
  assert.equal(input.health.body.status, "ok");
  assert.equal(input.health.body.database?.healthy, true);
  assert.equal(input.health.body.database?.status, "healthy");

  assert.equal(input.root.statusCode, 200);
  assert.match(input.root.body, /<title>Hyperia<\/title>/);
  assert.equal(input.stream.statusCode, 200);
  assert.match(input.stream.body, /Streaming/);

  assert.equal(input.publicEnvironment.statusCode, 200);
  assert.doesNotMatch(
    input.publicEnvironment.body,
    /(?:CLOUDFLARE_ORIGIN_SECRET|DATABASE_URL|DISTRIBUTED_RATE_LIMIT_KEY_SECRET|JWT_(?:SECRET|ACTIVE_KEY_ID|SIGNING_KEYS)|POSTGRES_PASSWORD|runtime-proof|container-smoke)/,
  );

  assert.equal(input.streamingHealth.statusCode, 503);
  assert.equal(input.streamingHealth.body.type, "STREAMING_RUNTIME_HEALTH");
  assert.equal(input.streamingHealth.body.ready, false);
  assert.equal(
    input.streamingHealth.body.checks?.schedulerAuthority?.reason,
    "scheduler_authority_unavailable",
  );
  assert.equal(
    input.streamingHealth.body.checks?.captureClient?.reason,
    "capture_client_disconnected",
  );

  assert.equal(input.csrfToken.statusCode, 200);
  assert.match(input.csrfToken.body.token, /^[a-f0-9]{64}$/);
  assert.match(
    input.csrfToken.headers?.["set-cookie"] || "",
    /^csrf-token=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure$/,
  );
  assert.equal(input.csrfToken.headers?.["cache-control"], "no-store");

  assert.equal(input.debugPublic.statusCode, 404);
  assert.deepEqual(input.debugPublic.body, { error: "Not found" });
  assert.equal(input.reservedApiMissing.statusCode, 404);
  assert.deepEqual(input.reservedApiMissing.body, { error: "Not found" });
  assert.doesNotMatch(
    JSON.stringify(input.reservedApiMissing.body),
    /container-smoke-sensitive-marker/,
  );

  assert.equal(input.proxyNonMainnet.statusCode, 400);
  assert.deepEqual(input.proxyNonMainnet.body, {
    error: "Unsupported Solana cluster",
  });

  for (const probe of [
    input.originLockMissing,
    input.originLockWrong,
    input.originLockDuplicate,
    input.originLockLookalike,
    input.originLockMutation,
    input.writeOriginWrong,
    input.proxyOriginMissing,
    input.proxyOriginWrong,
  ]) {
    assert.equal(probe.statusCode, 403);
    assert.deepEqual(probe.body, { error: "Forbidden" });
    assert.equal(probe.headers?.["cache-control"], "no-store");
  }
  return input;
}

export function validateDatabaseProbe(input) {
  assert.equal(input.migrationJournalEntries, input.expectedMigrationEntries);
  assert.ok(input.migrationJournalEntries > 0);
  assert.ok(input.publicTableCount > 0);
  for (const [table, present] of Object.entries(input.requiredTables)) {
    assert.equal(present, true, `${table} must exist after migrations`);
  }
  return input;
}

export function classifyServerDiagnostics(source) {
  const knownOpen = [];
  const unexpected = [];

  for (const line of String(source).split(/\r?\n/)) {
    if (KNOWN_OPEN_DIAGNOSTICS.some((pattern) => pattern.test(line))) {
      knownOpen.push(line);
      continue;
    }
    if (!DIAGNOSTIC_MARKER.test(line)) continue;
    if (CRITICAL_DIAGNOSTIC.test(line) || DIAGNOSTIC_MARKER.test(line)) {
      unexpected.push(line);
    }
  }

  return {
    knownOpen: [...new Set(knownOpen)],
    unexpected: [...new Set(unexpected)],
  };
}
