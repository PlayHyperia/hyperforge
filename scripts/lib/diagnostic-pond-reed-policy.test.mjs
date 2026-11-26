import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAGNOSTIC_POND_BOULDER_FILE,
  DIAGNOSTIC_POND_BOULDER_SHA_ENV,
  DIAGNOSTIC_POND_REED_FILE,
  DIAGNOSTIC_POND_REED_SHA_ENV,
  resolveDiagnosticPondBoulderSha256,
  resolveDiagnosticPondReedSha256,
} from "./diagnostic-pond-reed-policy.mjs";

const digest = "a".repeat(64);
function admittedInput() {
  return {
    environment: {
      [DIAGNOSTIC_POND_REED_SHA_ENV]: digest,
      NODE_ENV: "production",
      DUEL_LOCAL_SMOKE_MODE: "true",
      LOAD_TEST_MODE: "true",
      STREAMING_DUEL_DIAGNOSTIC_ASSET_TESTS: "true",
      STREAMING_DUEL_MAINTENANCE_MODE: "true",
      STREAMING_DUEL_SCHEDULER_ROLE: "authority",
      DUEL_BETTING_ENABLED: "false",
      DUEL_WITH_HYPERBET: "false",
      PUBLIC_API_URL: "http://127.0.0.1:5555",
      PUBLIC_WS_URL: "ws://127.0.0.1:5556/ws",
      DUEL_LOCAL_BROWSER_ORIGIN: "http://localhost:3333",
      PUBLIC_CDN_URL: "http://127.0.0.1:5555/game-assets",
      ASSETS_DIR: "/diagnostic/overlay",
    },
    assetsRoot: "/diagnostic/overlay",
    canonicalAssetsRoot: "/workspace/assets",
    reedPath: "/diagnostic/approved/pond_reed_leaf_fan.glb",
    canonicalReedPath:
      "/workspace/assets/vegetation/compact-pond-v1/pond_reed_clump.glb",
  };
}

test("absent audition is the exact historical contract without path requirements", () => {
  assert.equal(resolveDiagnosticPondReedSha256({ environment: {} }), null);
});

test("one explicitly requested reed hash is admitted only in the full local boundary", () => {
  const input = admittedInput();
  const before = structuredClone(input);
  assert.equal(DIAGNOSTIC_POND_REED_FILE, "pond_reed_clump.glb");
  assert.equal(resolveDiagnosticPondReedSha256(input), digest);
  assert.deepEqual(input, before);
  for (const key of [
    "PUBLIC_API_URL",
    "DUEL_LOCAL_BROWSER_ORIGIN",
    "PUBLIC_CDN_URL",
  ])
    input.environment[key] = "http://[::1]:5555";
  input.environment.PUBLIC_WS_URL = "ws://[::1]:5556";
  assert.equal(resolveDiagnosticPondReedSha256(input), digest);
});

test("production-shaped NODE_ENV alone never authorizes an audition", () => {
  const input = admittedInput();
  input.environment = {
    NODE_ENV: "production",
    [DIAGNOSTIC_POND_REED_SHA_ENV]: digest,
  };
  assert.throws(
    () => resolveDiagnosticPondReedSha256(input),
    /DUEL_LOCAL_SMOKE_MODE/u,
  );
});

test("every missing or altered safety flag rejects instead of falling back", () => {
  for (const key of [
    "NODE_ENV",
    "DUEL_LOCAL_SMOKE_MODE",
    "LOAD_TEST_MODE",
    "STREAMING_DUEL_DIAGNOSTIC_ASSET_TESTS",
    "STREAMING_DUEL_MAINTENANCE_MODE",
    "STREAMING_DUEL_SCHEDULER_ROLE",
    "DUEL_BETTING_ENABLED",
    "DUEL_WITH_HYPERBET",
  ]) {
    for (const value of [
      undefined,
      "",
      "TRUE",
      "false",
      "true",
      "development",
    ]) {
      const input = admittedInput();
      if (value === input.environment[key]) continue;
      input.environment[key] = value;
      assert.throws(
        () => resolveDiagnosticPondReedSha256(input),
        /audition rejected/u,
        `${key}=${value}`,
      );
    }
  }
});

test("malformed or empty requested hashes never fall back to the default", () => {
  for (const value of [
    "",
    "A".repeat(64),
    "g".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    ` ${digest}`,
    null,
    1,
  ]) {
    const input = admittedInput();
    input.environment[DIAGNOSTIC_POND_REED_SHA_ENV] = value;
    assert.throws(() => resolveDiagnosticPondReedSha256(input), /SHA-256/u);
  }
});

test("all service URLs reject external, ambiguous or credential-bearing origins", () => {
  for (const key of [
    "PUBLIC_API_URL",
    "PUBLIC_WS_URL",
    "DUEL_LOCAL_BROWSER_ORIGIN",
    "PUBLIC_CDN_URL",
  ]) {
    const protocol = key === "PUBLIC_WS_URL" ? "ws" : "http";
    for (const value of [
      undefined,
      "",
      `${protocol}://example.com`,
      `${protocol}://0.0.0.0`,
      `${protocol}://127.1`,
      `${protocol}://2130706433`,
      `${protocol}://localhost.evil.test`,
      `${protocol}://localhost@evil.test`,
      `${protocol}://user:password@localhost`,
      `${protocol}://localhost?x=1`,
      `${protocol}://localhost#fragment`,
      `${protocol}://localhost/other`,
      ` ${protocol}://localhost`,
      "file:///localhost",
      "ftp://localhost",
    ]) {
      const input = admittedInput();
      input.environment[key] = value;
      assert.throws(
        () => resolveDiagnosticPondReedSha256(input),
        /loopback/u,
        `${key}=${value}`,
      );
    }
  }
});

test("isolated realpath witnesses exclude canonical roots and canonical reed targets", () => {
  for (const field of [
    "assetsRoot",
    "canonicalAssetsRoot",
    "reedPath",
    "canonicalReedPath",
  ]) {
    const input = admittedInput();
    input[field] = "relative";
    assert.throws(
      () => resolveDiagnosticPondReedSha256(input),
      /resolved absolute/u,
    );
  }
  for (const value of [undefined, "", "relative"]) {
    const input = admittedInput();
    input.environment.ASSETS_DIR = value;
    assert.throws(
      () => resolveDiagnosticPondReedSha256(input),
      /absolute ASSETS_DIR/u,
    );
  }
  for (const root of [
    "/workspace/assets",
    "/workspace/assets/diagnostic",
    "/workspace",
    "/",
  ]) {
    const input = admittedInput();
    input.assetsRoot = root;
    assert.throws(() => resolveDiagnosticPondReedSha256(input), /isolated/u);
  }
  for (const target of [
    "/workspace/assets/vegetation/compact-pond-v1/pond_reed_clump.glb",
    "/workspace/assets/other.glb",
  ]) {
    const input = admittedInput();
    input.reedPath = target;
    assert.throws(() => resolveDiagnosticPondReedSha256(input), /detached/u);
  }
});

const boulderDigest = "b".repeat(64);
function admittedBoulderInput() {
  const { environment, assetsRoot, canonicalAssetsRoot } = admittedInput();
  delete environment[DIAGNOSTIC_POND_REED_SHA_ENV];
  environment[DIAGNOSTIC_POND_BOULDER_SHA_ENV] = boulderDigest;
  return {
    environment,
    assetsRoot,
    canonicalAssetsRoot,
    boulderPath: "/diagnostic/approved/pond_boulder.glb",
    canonicalBoulderPath:
      "/workspace/assets/vegetation/compact-pond-v1/pond_boulder.glb",
  };
}

test("absent boulder audition preserves the no-path historical contract", () => {
  assert.equal(resolveDiagnosticPondBoulderSha256({ environment: {} }), null);
  assert.equal(
    resolveDiagnosticPondBoulderSha256({
      environment: { [DIAGNOSTIC_POND_REED_SHA_ENV]: digest },
    }),
    null,
  );
  assert.equal(
    resolveDiagnosticPondReedSha256({
      environment: { [DIAGNOSTIC_POND_BOULDER_SHA_ENV]: boulderDigest },
    }),
    null,
  );
});

test("one explicit boulder hash is admitted without mutating the full local boundary", () => {
  assert.equal(DIAGNOSTIC_POND_BOULDER_FILE, "pond_boulder.glb");
  assert.equal(
    DIAGNOSTIC_POND_BOULDER_SHA_ENV,
    "DUEL_DIAGNOSTIC_POND_BOULDER_SHA256",
  );
  const input = admittedBoulderInput();
  const before = structuredClone(input);
  assert.equal(resolveDiagnosticPondBoulderSha256(input), boulderDigest);
  assert.deepEqual(input, before);
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    for (const secure of [false, true]) {
      const http = secure ? "https" : "http";
      const ws = secure ? "wss" : "ws";
      input.environment.PUBLIC_API_URL = `${http}://${host}:5555/`;
      input.environment.PUBLIC_WS_URL = `${ws}://${host}:5556/ws`;
      input.environment.DUEL_LOCAL_BROWSER_ORIGIN = `${http}://${host}:3333`;
      input.environment.PUBLIC_CDN_URL = `${http}://${host}:5555/game-assets`;
      assert.equal(resolveDiagnosticPondBoulderSha256(input), boulderDigest);
    }
  }
});

test("reed and boulder requests resolve independently with exact file-specific hashes", () => {
  const reed = admittedInput();
  const boulder = admittedBoulderInput();
  const environment = {
    ...reed.environment,
    [DIAGNOSTIC_POND_BOULDER_SHA_ENV]: boulderDigest,
  };
  assert.equal(
    resolveDiagnosticPondReedSha256({ ...reed, environment }),
    digest,
  );
  assert.equal(
    resolveDiagnosticPondBoulderSha256({ ...boulder, environment }),
    boulderDigest,
  );
  environment[DIAGNOSTIC_POND_BOULDER_SHA_ENV] = "invalid";
  assert.equal(
    resolveDiagnosticPondReedSha256({ ...reed, environment }),
    digest,
  );
  assert.throws(
    () => resolveDiagnosticPondBoulderSha256({ ...boulder, environment }),
    /^Error: Diagnostic pond boulder audition rejected:.*SHA-256/u,
  );
  environment[DIAGNOSTIC_POND_BOULDER_SHA_ENV] = boulderDigest;
  environment[DIAGNOSTIC_POND_REED_SHA_ENV] = "invalid";
  assert.equal(
    resolveDiagnosticPondBoulderSha256({ ...boulder, environment }),
    boulderDigest,
  );
  assert.throws(
    () => resolveDiagnosticPondReedSha256({ ...reed, environment }),
    /^Error: Diagnostic pond reed audition rejected:.*SHA-256/u,
  );
});

test("production-shaped NODE_ENV alone never authorizes a boulder audition", () => {
  const input = admittedBoulderInput();
  input.environment = {
    NODE_ENV: "production",
    [DIAGNOSTIC_POND_BOULDER_SHA_ENV]: boulderDigest,
  };
  assert.throws(
    () => resolveDiagnosticPondBoulderSha256(input),
    /^Error: Diagnostic pond boulder audition rejected: DUEL_LOCAL_SMOKE_MODE/u,
  );
});

test("every missing or altered boulder safety flag rejects without fallback", () => {
  for (const key of [
    "NODE_ENV",
    "DUEL_LOCAL_SMOKE_MODE",
    "LOAD_TEST_MODE",
    "STREAMING_DUEL_DIAGNOSTIC_ASSET_TESTS",
    "STREAMING_DUEL_MAINTENANCE_MODE",
    "STREAMING_DUEL_SCHEDULER_ROLE",
    "DUEL_BETTING_ENABLED",
    "DUEL_WITH_HYPERBET",
  ]) {
    for (const value of [
      undefined,
      "",
      "TRUE",
      "false",
      "true",
      "development",
      true,
      false,
      null,
    ]) {
      const input = admittedBoulderInput();
      if (value === input.environment[key]) continue;
      input.environment[key] = value;
      assert.throws(
        () => resolveDiagnosticPondBoulderSha256(input),
        /^Error: Diagnostic pond boulder audition rejected:/u,
        `${key}=${value}`,
      );
    }
  }
});

test("malformed boulder hashes reject rather than adopting reed or default hashes", () => {
  for (const value of [
    "",
    "B".repeat(64),
    "g".repeat(64),
    "b".repeat(63),
    "b".repeat(65),
    ` ${boulderDigest}`,
    `${boulderDigest}\n`,
    null,
    1,
    false,
  ]) {
    const input = admittedBoulderInput();
    input.environment[DIAGNOSTIC_POND_BOULDER_SHA_ENV] = value;
    input.environment[DIAGNOSTIC_POND_REED_SHA_ENV] = digest;
    assert.throws(
      () => resolveDiagnosticPondBoulderSha256(input),
      /^Error: Diagnostic pond boulder audition rejected:.*SHA-256/u,
    );
  }
});

test("every boulder service URL rejects external, ambiguous or credential-bearing origins", () => {
  for (const key of [
    "PUBLIC_API_URL",
    "PUBLIC_WS_URL",
    "DUEL_LOCAL_BROWSER_ORIGIN",
    "PUBLIC_CDN_URL",
  ]) {
    const protocol = key === "PUBLIC_WS_URL" ? "ws" : "http";
    for (const value of [
      undefined,
      "",
      `${protocol}://example.com`,
      `${protocol}://0.0.0.0`,
      `${protocol}://127.1`,
      `${protocol}://2130706433`,
      `${protocol}://localhost.evil.test`,
      `${protocol}://localhost@evil.test`,
      `${protocol}://user:password@localhost`,
      `${protocol}://localhost?x=1`,
      `${protocol}://localhost#fragment`,
      `${protocol}://localhost/other`,
      ` ${protocol}://localhost`,
      "file:///localhost",
      "ftp://localhost",
      `${key === "PUBLIC_WS_URL" ? "http" : "ws"}://localhost`,
    ]) {
      const input = admittedBoulderInput();
      input.environment[key] = value;
      assert.throws(
        () => resolveDiagnosticPondBoulderSha256(input),
        /^Error: Diagnostic pond boulder audition rejected:.*loopback/u,
        `${key}=${value}`,
      );
    }
  }
});

test("boulder realpath witnesses require detached absolute assets and canonical targets", () => {
  for (const field of [
    "assetsRoot",
    "canonicalAssetsRoot",
    "boulderPath",
    "canonicalBoulderPath",
  ]) {
    for (const value of [undefined, "", "relative", null]) {
      const input = admittedBoulderInput();
      input[field] = value;
      assert.throws(
        () => resolveDiagnosticPondBoulderSha256(input),
        /^Error: Diagnostic pond boulder audition rejected:.*resolved absolute/u,
      );
    }
  }
  for (const value of [undefined, "", "relative", null]) {
    const input = admittedBoulderInput();
    input.environment.ASSETS_DIR = value;
    assert.throws(
      () => resolveDiagnosticPondBoulderSha256(input),
      /^Error: Diagnostic pond boulder audition rejected:.*absolute ASSETS_DIR/u,
    );
  }
  for (const root of [
    "/workspace/assets",
    "/workspace/assets/diagnostic",
    "/workspace",
    "/",
  ]) {
    const input = admittedBoulderInput();
    input.assetsRoot = root;
    assert.throws(
      () => resolveDiagnosticPondBoulderSha256(input),
      /^Error: Diagnostic pond boulder audition rejected:.*isolated/u,
    );
  }
  for (const target of [
    "/workspace/assets/vegetation/compact-pond-v1/pond_boulder.glb",
    "/workspace/assets/other.glb",
  ]) {
    const input = admittedBoulderInput();
    input.boulderPath = target;
    assert.throws(
      () => resolveDiagnosticPondBoulderSha256(input),
      /^Error: Diagnostic pond boulder audition rejected:.*detached/u,
    );
  }
  const alias = admittedBoulderInput();
  alias.canonicalBoulderPath = alias.boulderPath;
  assert.throws(
    () => resolveDiagnosticPondBoulderSha256(alias),
    /^Error: Diagnostic pond boulder audition rejected:.*detached/u,
  );
  const sibling = admittedBoulderInput();
  sibling.assetsRoot = "/workspace/assets-audition";
  sibling.boulderPath = "/workspace/assets-audition/pond_boulder.glb";
  assert.equal(resolveDiagnosticPondBoulderSha256(sibling), boulderDigest);
});
