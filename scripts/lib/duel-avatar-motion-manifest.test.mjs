import assert from "node:assert/strict";
import test from "node:test";

import { validateDuelAvatarMotionDefinition } from "./duel-avatar-motion-manifest.mjs";

const valid = {
  id: "bow-hit-peak-left",
  name: "Bow hit peak left",
  asset: "emotes/emote-bow-duel-idle-steve.glb",
  sampleRatio: 0.35,
  cameraYawDegrees: -90,
  cameraPitchDegrees: 8,
  cameraTarget: "primary-grip",
  heldEquipmentEmote: "idle",
  equipmentClearance: {
    minimumFloorClearanceMetres: 0.05,
    minimumBodySurfaceDistanceMetres: 0.015,
    maximumProjectedBodyOverlapRatio: 0.08,
  },
  avatarGrounding: {
    minimumBoundsYMetres: -0.02,
    maximumBoundsYMetres: 0.18,
  },
  hitReaction: {
    intensity: 1,
    side: -1,
    elapsedSeconds: 0.0504,
  },
};

test("accepts a finite bounded multi-angle hit-reaction sample", () => {
  assert.equal(validateDuelAvatarMotionDefinition(valid), true);
});

test("rejects non-finite, out-of-envelope, and invalid-side reactions", () => {
  for (const hitReaction of [
    { intensity: Number.NaN, side: -1, elapsedSeconds: 0.0504 },
    { intensity: 1.26, side: -1, elapsedSeconds: 0.0504 },
    { intensity: 1, side: 0, elapsedSeconds: 0.0504 },
    { intensity: 1, side: 1, elapsedSeconds: 0 },
    { intensity: 1, side: 1, elapsedSeconds: 0.28 },
  ]) {
    assert.equal(
      validateDuelAvatarMotionDefinition({ ...valid, hitReaction }),
      false,
    );
  }
});

test("rejects unsafe identifiers, cameras, and sample ratios", () => {
  assert.equal(
    validateDuelAvatarMotionDefinition({ ...valid, id: "../escape" }),
    false,
  );
  assert.equal(
    validateDuelAvatarMotionDefinition({ ...valid, cameraYawDegrees: 181 }),
    false,
  );
  assert.equal(
    validateDuelAvatarMotionDefinition({ ...valid, sampleRatio: 1.01 }),
    false,
  );
  assert.equal(
    validateDuelAvatarMotionDefinition({
      ...valid,
      cameraTarget: "unbounded-scene",
    }),
    false,
  );
});

test("rejects empty, unknown, non-finite, and out-of-envelope clearance rules", () => {
  for (const equipmentClearance of [
    {},
    { unexpected: 0.1 },
    { minimumFloorClearanceMetres: Number.NaN },
    { minimumFloorClearanceMetres: -0.001 },
    { minimumFloorClearanceMetres: 1.001 },
    { minimumBodySurfaceDistanceMetres: -0.001 },
    { minimumBodySurfaceDistanceMetres: 0.501 },
    { maximumProjectedBodyOverlapRatio: -0.001 },
    { maximumProjectedBodyOverlapRatio: 1.001 },
  ]) {
    assert.equal(
      validateDuelAvatarMotionDefinition({ ...valid, equipmentClearance }),
      false,
    );
  }
});

test("rejects incomplete, inverted, non-finite, and out-of-envelope grounding rules", () => {
  for (const avatarGrounding of [
    {},
    { minimumBoundsYMetres: -0.02 },
    { minimumBoundsYMetres: -0.02, maximumBoundsYMetres: 0.18, extra: 0 },
    { minimumBoundsYMetres: Number.NaN, maximumBoundsYMetres: 0.18 },
    { minimumBoundsYMetres: -1.01, maximumBoundsYMetres: 0.18 },
    { minimumBoundsYMetres: -0.02, maximumBoundsYMetres: 1.01 },
    { minimumBoundsYMetres: 0.2, maximumBoundsYMetres: 0.18 },
  ]) {
    assert.equal(
      validateDuelAvatarMotionDefinition({ ...valid, avatarGrounding }),
      false,
    );
  }
});
