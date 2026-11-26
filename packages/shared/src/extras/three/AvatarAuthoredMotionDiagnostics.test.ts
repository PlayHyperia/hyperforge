import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  AVATAR_AUTHORED_MOTION_ACTION_LIMIT,
  collectAvatarAuthoredMotionDiagnostics,
  sanitizeAvatarAuthoredMotionUrl,
} from "./AvatarAuthoredMotionDiagnostics";

function createAction(name: string) {
  const root = new THREE.Object3D();
  const mixer = new THREE.AnimationMixer(root);
  const clip = new THREE.AnimationClip(name, 1, [
    new THREE.NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
  ]);
  return { action: mixer.clipAction(clip), mixer };
}

describe("authored animation mixer diagnostics", () => {
  it("reports only a real scheduled action and strips its query and fragment", () => {
    const { action, mixer } = createAction("attack");
    action.play();
    mixer.update(0.05);

    expect(
      collectAvatarAuthoredMotionDiagnostics([
        {
          url: "asset://emotes/attack.glb?speed=2#private",
          loading: false,
          action,
        },
      ]),
    ).toEqual({
      schemaVersion: 1,
      overflow: false,
      invalidActionCount: 0,
      actions: [
        {
          url: "asset://emotes/attack.glb",
          running: true,
          paused: false,
          effectiveWeight: 1,
        },
      ],
    });
  });

  it("retains both positive contributors during a real crossfade", () => {
    const root = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(root);
    const attack = mixer.clipAction(
      new THREE.AnimationClip("attack", 1, [
        new THREE.NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
      ]),
    );
    const idle = mixer.clipAction(
      new THREE.AnimationClip("idle", 1, [
        new THREE.NumberKeyframeTrack(".position[y]", [0, 1], [0, 1]),
      ]),
    );
    attack.play();
    mixer.update(0.05);
    attack.fadeOut(0.2);
    idle.reset().fadeIn(0.2).play();
    mixer.update(0.05);

    const result = collectAvatarAuthoredMotionDiagnostics([
      { url: "asset://emotes/attack.glb", loading: false, action: attack },
      { url: "asset://emotes/idle.glb", loading: false, action: idle },
    ]);

    expect(result.actions).toHaveLength(2);
    expect(result.actions.every((entry) => entry.running)).toBe(true);
    expect(
      result.actions.every(
        (entry) => entry.effectiveWeight > 0 && entry.effectiveWeight < 1,
      ),
    ).toBe(true);
  });

  it("marks malformed scheduled weights invalid beside a real contributor", () => {
    const valid = createAction("valid");
    const negative = createAction("negative");
    const nonFinite = createAction("non-finite");
    valid.action.play();
    negative.action.play().setEffectiveWeight(-1);
    nonFinite.action.play().setEffectiveWeight(Number.NEGATIVE_INFINITY);
    valid.mixer.update(0.05);
    negative.mixer.update(0.05);
    nonFinite.mixer.update(0.05);

    const result = collectAvatarAuthoredMotionDiagnostics([
      {
        url: "asset://emotes/valid.glb",
        loading: false,
        action: valid.action,
      },
      {
        url: "asset://emotes/negative.glb",
        loading: false,
        action: negative.action,
      },
      {
        url: "asset://emotes/non-finite.glb",
        loading: false,
        action: nonFinite.action,
      },
    ]);

    expect(result.invalidActionCount).toBe(2);
    expect(result.actions.map((entry) => entry.url)).toEqual([
      "asset://emotes/valid.glb",
    ]);
  });

  it("rejects URL userinfo while retaining credential-free asset paths", () => {
    expect(
      sanitizeAvatarAuthoredMotionUrl(
        "https://viewer:secret@example.test/attack.glb?token=hidden",
      ),
    ).toBeNull();
    expect(
      sanitizeAvatarAuthoredMotionUrl(
        "//viewer:secret@example.test/attack.glb#private",
      ),
    ).toBeNull();
    expect(
      sanitizeAvatarAuthoredMotionUrl(
        "/asset/emotes/attack.glb?token=hidden#private",
      ),
    ).toBe("/asset/emotes/attack.glb");
  });

  it("reports paused state but not zero-weight, loading, or stopped actions", () => {
    const { action, mixer } = createAction("attack");
    action.play();
    mixer.update(0.05);

    action.paused = true;
    expect(
      collectAvatarAuthoredMotionDiagnostics([
        { url: "asset://emotes/paused.glb", loading: false, action },
      ]).actions,
    ).toEqual([
      {
        url: "asset://emotes/paused.glb",
        running: false,
        paused: true,
        effectiveWeight: 1,
      },
    ]);

    action.paused = false;
    action.setEffectiveWeight(0);
    expect(
      collectAvatarAuthoredMotionDiagnostics([
        { url: "asset://emotes/zero.glb", loading: false, action },
      ]).actions,
    ).toEqual([]);

    action.stop();

    expect(
      collectAvatarAuthoredMotionDiagnostics([
        { url: "asset://emotes/loading.glb", loading: true, action: null },
        { url: "asset://emotes/stopped.glb", loading: false, action },
      ]).actions,
    ).toEqual([]);
  });

  it("bounds output and marks overflow from real contributing actions", () => {
    const root = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(root);
    const entries = Array.from(
      { length: AVATAR_AUTHORED_MOTION_ACTION_LIMIT + 1 },
      (_, index) => {
        const action = mixer.clipAction(
          new THREE.AnimationClip(`clip-${index}`, 1, [
            new THREE.NumberKeyframeTrack(
              `.userData[value${index}]`,
              [0, 1],
              [0, 1],
            ),
          ]),
        );
        action.play();
        return {
          url: `asset://emotes/clip-${index}.glb`,
          loading: false,
          action,
        };
      },
    );
    mixer.update(0.05);

    const result = collectAvatarAuthoredMotionDiagnostics(entries);
    expect(result.actions).toHaveLength(AVATAR_AUTHORED_MOTION_ACTION_LIMIT);
    expect(result.overflow).toBe(true);
    expect(result.invalidActionCount).toBe(0);
  });
});
