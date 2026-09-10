import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readLaunchAssetByteEvidence,
  resolveLaunchAssetReadTimeoutMs,
} from "./launch-asset-byte-evidence.mjs";

test("reads complete launch asset bytes and returns exact evidence", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperia-asset-bytes-"));
  try {
    const filePath = path.join(directory, "asset.glb");
    const bytes = Buffer.from("complete launch asset");
    writeFileSync(filePath, bytes);

    const result = readLaunchAssetByteEvidence(filePath);
    assert.equal(result.ok, true);
    assert.deepEqual(result.evidence, {
      statSize: bytes.length,
      bytesRead: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects empty launch assets", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperia-asset-bytes-"));
  try {
    const filePath = path.join(directory, "empty.glb");
    writeFileSync(filePath, Buffer.alloc(0));

    const result = readLaunchAssetByteEvidence(filePath);
    assert.equal(result.ok, false);
    assert.match(result.error, /asset is empty/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports a bounded timeout without accepting partial evidence", () => {
  const timeoutError = Object.assign(new Error("timed out"), {
    code: "ETIMEDOUT",
  });
  const result = readLaunchAssetByteEvidence("/tmp/blocked.glb", {
    timeoutMs: 750,
    spawn: () => ({ error: timeoutError }),
  });

  assert.deepEqual(result, {
    ok: false,
    timeout: true,
    error: "asset bytes were not readable within 750ms",
  });
});

test("kills a genuinely blocked byte reader at the configured deadline", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperia-asset-bytes-"));
  try {
    const readerPath = path.join(directory, "blocked-reader.mjs");
    writeFileSync(readerPath, "for (;;) {}\n");
    const startedAt = Date.now();

    const result = readLaunchAssetByteEvidence("/tmp/blocked.glb", {
      timeoutMs: 100,
      readerPath,
    });

    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.ok, false);
    assert.equal(result.timeout, true);
    assert.match(result.error, /not readable within 100ms/u);
    assert.ok(elapsedMs >= 90, `reader exited too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs < 2_000, `reader exceeded deadline: ${elapsedMs}ms`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed child evidence", () => {
  const result = readLaunchAssetByteEvidence("/tmp/invalid.glb", {
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify({
        statSize: 10,
        bytesRead: 0,
        sha256: "0".repeat(64),
      }),
      stderr: "",
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid size or hash evidence/u);
});

test("validates the launch asset read timeout envelope", () => {
  assert.equal(resolveLaunchAssetReadTimeoutMs(undefined), 15_000);
  assert.equal(resolveLaunchAssetReadTimeoutMs("100"), 100);
  assert.equal(resolveLaunchAssetReadTimeoutMs("60000"), 60_000);
  assert.throws(
    () => resolveLaunchAssetReadTimeoutMs("99"),
    /integer from 100 to 60000/u,
  );
  assert.throws(
    () => resolveLaunchAssetReadTimeoutMs("not-a-number"),
    /integer from 100 to 60000/u,
  );
});
