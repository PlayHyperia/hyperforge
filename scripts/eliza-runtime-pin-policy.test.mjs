import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditElizaRuntimePins,
  EXPECTED_ELIZA_RUNTIME_VERSIONS,
  isExactVersion,
} from "./eliza-runtime-pin-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("accepts exact release and prerelease versions only", () => {
  for (const version of Object.values(EXPECTED_ELIZA_RUNTIME_VERSIONS)) {
    assert.equal(isExactVersion(version), true);
  }
  for (const value of [
    "alpha",
    "latest",
    "next",
    "*",
    "^2.0.0-alpha.537",
    "~2.0.0-alpha.537",
    ">=2.0.0-alpha.537",
    "workspace:*",
    "",
  ]) {
    assert.equal(isExactVersion(value), false, value);
  }
});

test("pins every launch ElizaOS package and lock resolution exactly", () => {
  const result = auditElizaRuntimePins(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.pinnedPackageCount, 6);
  assert.equal(result.providerPolicySourceCount, 11);
});
