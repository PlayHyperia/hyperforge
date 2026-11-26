import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildOneHandDuelLocomotionEmotes,
  ONE_HAND_DUEL_LOCOMOTION_OUTPUTS,
  ONE_HAND_GUARD_BLEND_STRENGTH,
  ONE_HAND_GUARD_SAMPLE_RATIO,
  ONE_HAND_WEAPON_ARM_BONES,
} from "./build-one-hand-duel-locomotion-emotes.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("builds deterministic reviewed one-hand duel locomotion clips", async () => {
  const first = await buildOneHandDuelLocomotionEmotes(workspaceRoot);
  const replay = await buildOneHandDuelLocomotionEmotes(workspaceRoot);

  assert.equal(first.activationStatus, "reviewed-production");
  assert.equal(first.approvedForRuntimeActivation, true);
  assert.equal(first.reference.sampleRatio, ONE_HAND_GUARD_SAMPLE_RATIO);
  assert.equal(first.blendStrength, ONE_HAND_GUARD_BLEND_STRENGTH);
  assert.deepEqual(first.weaponArmBones, [...ONE_HAND_WEAPON_ARM_BONES]);
  assert.deepEqual(
    first.outputs.map((output) => output.outputAsset),
    ONE_HAND_DUEL_LOCOMOTION_OUTPUTS.map((output) => output.outputAsset),
  );
  assert.deepEqual(
    replay.outputs.map((output) => output.bytes),
    first.outputs.map((output) => output.bytes),
  );
  assert.deepEqual(
    replay.outputs.map(({ bytes: _bytes, ...output }) => output),
    first.outputs.map(({ bytes: _bytes, ...output }) => output),
  );
  for (const output of first.outputs) {
    assert.ok(output.byteLength > 0);
    assert.match(output.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(output.validation.errors, 0);
    assert.equal(output.validation.warnings, 0);
    assert.equal(output.overrides.length, ONE_HAND_WEAPON_ARM_BONES.length);
    assert.ok(output.overrides.every((override) => override.keyframeCount > 0));
  }
});
