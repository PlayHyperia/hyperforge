import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BOW_DUEL_LOCOMOTION_OUTPUTS,
  buildBowDuelLocomotionEmotes,
  REVIEWED_BOW_CARRY_CANDIDATE_ID,
} from "./build-bow-duel-locomotion-emotes.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("promotes only the deterministic reviewed bow carry", async () => {
  const first = await buildBowDuelLocomotionEmotes(workspaceRoot);
  const replay = await buildBowDuelLocomotionEmotes(workspaceRoot);

  assert.equal(first.activationStatus, "reviewed-production");
  assert.equal(first.approvedForRuntimeActivation, true);
  assert.equal(
    first.reviewedCandidateId,
    REVIEWED_BOW_CARRY_CANDIDATE_ID,
  );
  assert.deepEqual(
    first.outputs.map((output) => ({
      locomotionId: output.locomotionId,
      outputAsset: output.outputAsset,
    })),
    BOW_DUEL_LOCOMOTION_OUTPUTS,
  );
  assert.deepEqual(
    replay.outputs.map((output) => output.bytes),
    first.outputs.map((output) => output.bytes),
  );
  for (const output of first.outputs) {
    assert.equal(output.blendStrength, 1);
    assert.ok(!output.outputAsset.includes("/candidates/"));
    assert.match(output.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(output.validation.errors, 0);
    assert.equal(output.validation.warnings, 0);
  }
});
