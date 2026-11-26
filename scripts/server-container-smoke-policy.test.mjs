import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDockerImageReference,
  assertDockerResourceName,
  classifyServerDiagnostics,
  parseKeyValueProbe,
  parsePositiveInteger,
  validateDatabaseProbe,
  validateHttpProbe,
  validateRuntimeProbe,
} from "./server-container-smoke-policy.mjs";

test("accepts only bounded container-smoke configuration", () => {
  assert.equal(parsePositiveInteger(undefined, "timeout", 10), 10);
  assert.equal(parsePositiveInteger("25", "timeout", 10), 25);
  assert.throws(() => parsePositiveInteger("0", "timeout", 10));
  assert.throws(() => parsePositiveInteger("1.5", "timeout", 10));
  assert.equal(
    assertDockerResourceName("hyperia-smoke-123", "name"),
    "hyperia-smoke-123",
  );
  assert.throws(() => assertDockerResourceName("../unsafe", "name"));
  assert.equal(
    assertDockerImageReference("hyperia/server:smoke-1", "image"),
    "hyperia/server:smoke-1",
  );
  assert.throws(() => assertDockerImageReference("image;shutdown", "image"));
});

test("validates the exact non-root Node runtime probe", () => {
  const probe = parseKeyValueProbe(
    [
      "node=v22.23.2",
      "uid=1000",
      "bun=absent",
      "assets_git=absent",
      "artifacts=absent",
      "test_sources=absent",
      "migration_readable=true",
      "migration_writable=false",
    ].join("\n"),
  );
  assert.equal(validateRuntimeProbe(probe), probe);
  assert.throws(() => validateRuntimeProbe({ ...probe, uid: "0" }));
  assert.throws(() => validateRuntimeProbe({ ...probe, bun: "present" }));
});

test("requires healthy infrastructure while streaming stays deliberately disabled", () => {
  const input = {
    status: {
      statusCode: 200,
      body: { uptime: 4, protected: false, connectedUserCount: 2 },
    },
    health: {
      statusCode: 200,
      body: { status: "ok", database: { healthy: true, status: "healthy" } },
    },
    root: { statusCode: 200, body: "<title>Hyperia</title>" },
    stream: { statusCode: 200, body: "Streaming" },
    publicEnvironment: { statusCode: 200, body: "window.env = {};" },
    streamingHealth: {
      statusCode: 503,
      body: {
        type: "STREAMING_RUNTIME_HEALTH",
        ready: false,
        checks: {
          schedulerAuthority: { reason: "scheduler_authority_unavailable" },
          captureClient: { reason: "capture_client_disconnected" },
        },
      },
    },
    csrfToken: {
      statusCode: 200,
      body: {
        token:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      headers: {
        "cache-control": "no-store",
        "set-cookie":
          "csrf-token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure",
      },
    },
    debugPublic: {
      statusCode: 404,
      body: { error: "Not found" },
    },
    reservedApiMissing: {
      statusCode: 404,
      body: { error: "Not found" },
    },
    proxyNonMainnet: {
      statusCode: 400,
      body: { error: "Unsupported Solana cluster" },
    },
    originLockMissing: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
    originLockWrong: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
    originLockDuplicate: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
    originLockLookalike: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
    originLockMutation: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
    writeOriginWrong: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
    proxyOriginMissing: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
    proxyOriginWrong: {
      statusCode: 403,
      body: { error: "Forbidden" },
      headers: { "cache-control": "no-store" },
    },
  };
  assert.equal(validateHttpProbe(input), input);
  assert.throws(() =>
    validateHttpProbe({
      ...input,
      publicEnvironment: { statusCode: 200, body: "JWT_SECRET=leaked" },
    }),
  );
  assert.throws(() =>
    validateHttpProbe({
      ...input,
      publicEnvironment: { statusCode: 200, body: "JWT_SIGNING_KEYS=leaked" },
    }),
  );
  assert.throws(() =>
    validateHttpProbe({
      ...input,
      publicEnvironment: {
        statusCode: 200,
        body: "CLOUDFLARE_ORIGIN_SECRET=leaked",
      },
    }),
  );
  assert.throws(() =>
    validateHttpProbe({
      ...input,
      health: { statusCode: 200, body: { status: "ok" } },
    }),
  );
  assert.throws(() =>
    validateHttpProbe({
      ...input,
      status: {
        ...input.status,
        body: {
          ...input.status.body,
          connectedUsers: [{ id: "private-player" }],
        },
      },
    }),
  );
  assert.throws(() =>
    validateHttpProbe({
      ...input,
      reservedApiMissing: {
        statusCode: 404,
        body: {
          error: "Not found",
          path: "/api/not-real?container-smoke-sensitive-marker=1",
        },
      },
    }),
  );
  assert.throws(() =>
    validateHttpProbe({
      ...input,
      originLockDuplicate: {
        statusCode: 200,
        body: "<title>Hyperia</title>",
        headers: {},
      },
    }),
  );
});

test("requires every migration and launch-critical table", () => {
  const input = {
    migrationJournalEntries: 88,
    expectedMigrationEntries: 88,
    publicTableCount: 60,
    requiredTables: {
      streaming_duel_history: true,
      agent_bank_operations: true,
      agent_autonomy_checkpoints: true,
      streaming_duel_action_observation_heads: true,
      streaming_duel_action_observations: true,
      streaming_duel_preparation_agent_host_leases: true,
    },
  };
  assert.equal(validateDatabaseProbe(input), input);
  assert.throws(() =>
    validateDatabaseProbe({ ...input, migrationJournalEntries: 87 }),
  );
  assert.throws(() =>
    validateDatabaseProbe({
      ...input,
      requiredTables: { ...input.requiredTables, agent_bank_operations: false },
    }),
  );
  assert.throws(() =>
    validateDatabaseProbe({
      ...input,
      requiredTables: {
        ...input.requiredTables,
        streaming_duel_preparation_agent_host_leases: false,
      },
    }),
  );
});

test("separates documented published-asset gaps from new diagnostics", () => {
  const result = classifyServerDiagnostics(`
[Server] WARNING: Missing recommended production config: PRIVY_APP_ID, PRIVY_APP_SECRET
[DataManager] world-config.json not found, using default world generation parameters
[ResourceSystem] Unknown resource ID in world-areas: tree_yew
[MobNPCSpawnerSystem] ⚠️ NPC duel_arena_guide not found in npcs.json manifest!
[Unexpected] WARNING: a new launch problem
`);
  assert.equal(result.knownOpen.length, 4);
  assert.deepEqual(result.unexpected, [
    "[Unexpected] WARNING: a new launch problem",
  ]);

  const fatal = classifyServerDiagnostics("FATAL: startup failed");
  assert.deepEqual(fatal.unexpected, ["FATAL: startup failed"]);
});
