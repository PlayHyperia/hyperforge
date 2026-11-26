import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildStevePreparationMotionCandidates,
  STEVE_PREPARATION_MOTIONS,
} from "./build-steve-preparation-motion-candidates.mjs";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("builds deterministic, exact-loop Steve preparation motions from locked CC0 authority", async () => {
  const first = await buildStevePreparationMotionCandidates(WORKSPACE_ROOT);
  const second = await buildStevePreparationMotionCandidates(WORKSPACE_ROOT);

  assert.equal(first.provenance.license, "CC0-1.0");
  assert.deepEqual(
    first.outputs.map(({ bytes: _bytes, ...output }) => output),
    second.outputs.map(({ bytes: _bytes, ...output }) => output),
  );
  assert.deepEqual(
    first.outputs.map((output) => output.id),
    STEVE_PREPARATION_MOTIONS.map((motion) => motion.id),
  );
  for (const [index, output] of first.outputs.entries()) {
    assert.ok(output.bytes.equals(second.outputs[index].bytes));
    assert.equal(output.loopSeamExact, true);
    assert.ok(output.durationSeconds > 0);
    assert.ok(output.channelCount > 0);
    assert.equal(output.validator.errors, 0);
    assert.equal(output.validator.warnings, 0);
    assert.equal(output.validator.hints, 0);
    assert.ok(
      output.validator.infoCodes.every((code) => code === "NODE_EMPTY"),
    );
  }
});
