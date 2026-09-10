import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSteveFishingInteractionMotions,
  STEVE_FISHING_INTERACTION_MOTIONS,
} from "./build-steve-fishing-interaction-motions.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("builds exact CC0 one-shot fishing interaction motions", async () => {
  const report = await buildSteveFishingInteractionMotions(workspaceRoot);
  assert.equal(report.provenance.license, "CC0-1.0");
  assert.equal(report.activationStatus, "not-activated");
  assert.equal(report.outputs.length, STEVE_FISHING_INTERACTION_MOTIONS.length);
  assert.deepEqual(
    report.outputs.map((output) => output.id),
    ["small_fishing_net_release", "fishing_retrieve", "lobster_pot_deploy"],
  );
  for (const output of report.outputs) {
    assert.equal(output.sha256, sha256(output.bytes));
    assert.equal(output.durationSeconds, 1.2);
    assert.equal(output.channelCount >= 56, true);
    assert.deepEqual(output.validator.infoCodes, ["NODE_EMPTY"]);
    assert.equal(output.validator.errors, 0);
    assert.equal(output.validator.warnings, 0);
    assert.equal(output.validator.hints, 0);
  }
  assert.equal(
    report.outputs.find((output) => output.id === "lobster_pot_deploy")
      ?.reversed,
    true,
  );
  assert.deepEqual(
    report.outputs.map((output) => output.presentationTiming),
    [
      { durationSeconds: 1.2, releaseSeconds: 0.78 },
      { durationSeconds: 1.2, pickupSeconds: 0.42 },
      { durationSeconds: 1.2, releaseSeconds: 1.08 },
    ],
  );
});

test("motion build is byte-deterministic", async () => {
  const first = await buildSteveFishingInteractionMotions(workspaceRoot);
  const second = await buildSteveFishingInteractionMotions(workspaceRoot);
  assert.deepEqual(
    first.outputs.map((output) => output.sha256),
    second.outputs.map((output) => output.sha256),
  );
});
