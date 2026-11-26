import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyPrebuiltFiles,
  inspectMaterializedFile,
  isMaterializedStats,
} from "./copy-prebuilt-policy.mjs";

test("rejects a non-empty APFS placeholder with zero local blocks", () => {
  assert.equal(
    isMaterializedStats({ isFile: () => true, size: 1024, blocks: 0 }, 1024),
    false,
  );
});

test("accepts an empty file and a non-empty file with local blocks", () => {
  assert.equal(
    isMaterializedStats({ isFile: () => true, size: 0, blocks: 0 }, 0),
    true,
  );
  assert.equal(
    isMaterializedStats({ isFile: () => true, size: 1024, blocks: 8 }, 1024),
    true,
  );
});

test("reports missing and size-mismatched destinations without reading them", () => {
  const root = mkdtempSync(join(tmpdir(), "physx-copy-policy-"));
  const filePath = join(root, "artifact.js");

  assert.deepEqual(inspectMaterializedFile(filePath, 3), {
    ready: false,
    reason: "missing",
  });

  writeFileSync(filePath, "bad");
  assert.deepEqual(inspectMaterializedFile(filePath, 4), {
    ready: false,
    reason: "size-mismatch",
    size: 3,
  });
});

test("atomically replaces stale destinations and skips current artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "physx-copy-policy-"));
  const sourceDir = join(root, "source");
  const destinationDir = join(root, "dist");
  const src = join(sourceDir, "artifact.js");
  const dest = join(destinationDir, "artifact.js");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(destinationDir, { recursive: true });
  writeFileSync(src, "materialized-source");
  writeFileSync(dest, "stale");

  const messages = [];
  const first = copyPrebuiltFiles([{ src, dest }], {
    log: { log: (message) => messages.push(message) },
  });
  assert.deepEqual(first, { copied: 1, skipped: 0 });
  assert.equal(readFileSync(dest, "utf8"), "materialized-source");
  assert.equal(statSync(dest).size, statSync(src).size);

  const second = copyPrebuiltFiles([{ src, dest }], {
    log: { log: (message) => messages.push(message) },
  });
  assert.deepEqual(second, { copied: 0, skipped: 1 });
  assert.equal(
    messages.some((message) => message.includes("skipping copy")),
    true,
  );
});
