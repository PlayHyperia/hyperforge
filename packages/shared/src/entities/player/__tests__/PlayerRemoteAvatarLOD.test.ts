import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import {
  AvatarLOD,
  AVATAR_OPTIONS,
  getAvatarUrlForLOD,
} from "../../../data/avatars";
import { Emotes } from "../../../data/playerEmotes";
import { EventType } from "../../../types/events";
import { DeathState } from "../../../types/entities/entities";
import { PlayerRemote } from "../PlayerRemote";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createAtomicSwapHarness() {
  const avatar = AVATAR_OPTIONS[0];
  const mount = deferred();
  const previousDestroy = vi.fn();
  const previousDeactivate = vi.fn();
  const candidateDestroy = vi.fn();
  const candidateDeactivate = vi.fn();
  const candidateScene = new THREE.Group();
  const candidateInstance = {
    raw: { scene: candidateScene },
    destroy: candidateDestroy,
    move: vi.fn(),
    update: vi.fn(),
    disableRateCheck: vi.fn(),
    preloadEmote: vi.fn(),
    setEmoteAndWait: vi.fn().mockResolvedValue(undefined),
  };
  const candidateAvatar = {
    position: new THREE.Vector3(),
    activate: vi.fn(),
    mount: vi.fn(() => mount.promise),
    deactivate: candidateDeactivate,
    getHeadToHeight: vi.fn(() => 1.7),
    instance: candidateInstance,
  };
  const previousAvatar = {
    deactivate: previousDeactivate,
    instance: { destroy: previousDestroy },
  };
  const emit = vi.fn();
  const initHLOD = vi.fn().mockResolvedValue(undefined);
  const basePosition = new THREE.Vector3();
  const baseQuaternion = new THREE.Quaternion();
  const baseMatrix = new THREE.Matrix4();
  const base = {
    position: basePosition,
    quaternion: baseQuaternion,
    matrixWorld: baseMatrix,
    updateTransform: vi.fn(() => {
      baseMatrix.compose(
        basePosition,
        baseQuaternion,
        new THREE.Vector3(1, 1, 1),
      );
    }),
  };
  const remote = Object.create(PlayerRemote.prototype) as PlayerRemote;
  Object.assign(remote, {
    data: { avatar: avatar.url, e: "sword_swing" },
    node: {
      position: new THREE.Vector3(30, 0, 0),
      quaternion: new THREE.Quaternion(),
    },
    world: {
      camera: { position: new THREE.Vector3(0, 0, 0) },
      loader: {
        load: vi.fn().mockResolvedValue({
          toNodes: vi.fn(
            () =>
              new Map([
                ["root", candidateAvatar],
                ["avatar", candidateAvatar],
              ]),
          ),
        }),
      },
      stage: { scene: new THREE.Scene(), octree: null },
      emit,
    },
    base,
    bubble: { position: new THREE.Vector3() },
    avatar: previousAvatar,
    avatarUrl: avatar.url,
    avatarLOD: AvatarLOD.LOD0,
    isLoadingAvatar: false,
    destroyed: false,
    _fallbackAvatarRoot: null,
    _nextAvatarRetryAt: 0,
    _hasAppliedIdlePose: true,
    hlodState: null,
  });
  Object.defineProperty(remote, "initHLOD", { value: initHLOD });

  return {
    avatar,
    candidateAvatar,
    candidateDeactivate,
    candidateDestroy,
    candidateScene,
    emit,
    initHLOD,
    mount,
    previousAvatar,
    previousDeactivate,
    previousDestroy,
    remote,
  };
}

describe("PlayerRemote avatar LOD replacement", () => {
  it("keeps the previous avatar until the selected LOD is posed and ready", async () => {
    const harness = createAtomicSwapHarness();

    const swap = harness.remote.applyAvatar();
    await vi.waitFor(() => {
      expect(harness.candidateAvatar.mount).toHaveBeenCalledOnce();
    });

    expect(harness.remote.avatar).toBe(harness.previousAvatar);
    expect(harness.previousDestroy).not.toHaveBeenCalled();

    harness.mount.resolve();
    await swap;

    expect(harness.remote.avatar).toBe(harness.candidateAvatar);
    expect(harness.remote.avatarUrl).toBe(
      getAvatarUrlForLOD(harness.avatar, AvatarLOD.LOD1),
    );
    expect(harness.candidateScene.visible).toBe(true);
    expect(harness.previousDeactivate).toHaveBeenCalledOnce();
    expect(harness.previousDestroy).toHaveBeenCalledOnce();
    expect(harness.candidateDestroy).not.toHaveBeenCalled();
    expect(
      harness.candidateAvatar.instance.setEmoteAndWait,
    ).toHaveBeenCalledWith(Emotes.SWORD_SWING, 3000);
    expect(harness.initHLOD).toHaveBeenCalledOnce();
    expect(harness.emit).toHaveBeenCalledWith(EventType.AVATAR_LOAD_COMPLETE, {
      playerId: harness.remote.id,
      success: true,
    });
  });

  it("discards a loaded LOD when the camera returns before commit", async () => {
    const harness = createAtomicSwapHarness();

    const swap = harness.remote.applyAvatar();
    await vi.waitFor(() => {
      expect(harness.candidateAvatar.mount).toHaveBeenCalledOnce();
    });

    harness.remote.node.position.set(0, 0, 0);
    harness.mount.resolve();
    await swap;

    expect(harness.remote.avatar).toBe(harness.previousAvatar);
    expect(harness.remote.avatarUrl).toBe(harness.avatar.url);
    expect(harness.previousDestroy).not.toHaveBeenCalled();
    expect(harness.candidateDeactivate).toHaveBeenCalledOnce();
    expect(harness.candidateDestroy).toHaveBeenCalledOnce();
    expect(harness.initHLOD).not.toHaveBeenCalled();
    expect(harness.emit).toHaveBeenCalledWith(EventType.AVATAR_LOAD_COMPLETE, {
      playerId: harness.remote.id,
      success: false,
    });
  });

  it("hydrates a reviewed processing body motion from late-join entity state", async () => {
    const harness = createAtomicSwapHarness();
    harness.remote.data.e = "idle";
    harness.remote.data.processingInteractionPresentation = {
      revision: 1,
      skill: "cooking",
      phase: "working",
      phaseStartedAtServerTimeMs: 1000,
      targetPosition: { x: 1, y: 0, z: 0 },
    };

    const swap = harness.remote.applyAvatar();
    await vi.waitFor(() => {
      expect(harness.candidateAvatar.mount).toHaveBeenCalledOnce();
    });
    harness.mount.resolve();
    await swap;

    expect(
      harness.candidateAvatar.instance.setEmoteAndWait,
    ).toHaveBeenCalledWith(Emotes.SQUAT, 3000);
  });
});

describe("PlayerRemote avatar authority updates", () => {
  it("does not bypass retry backoff for duplicate avatar projections", () => {
    const applyAvatar = vi.fn();
    const remote = Object.create(PlayerRemote.prototype) as PlayerRemote;
    const retryAt = Date.now() + 15_000;
    Object.assign(remote, {
      data: {
        avatar: "asset://avatars/base.vrm",
        sessionAvatar: "asset://avatars/session.vrm",
      },
      applyAvatar,
      _nextAvatarRetryAt: retryAt,
    });

    remote.modify({
      avatar: "asset://avatars/base.vrm",
      sessionAvatar: "asset://avatars/session.vrm",
    });

    expect(applyAvatar).not.toHaveBeenCalled();
    expect(
      (remote as unknown as { _nextAvatarRetryAt: number })._nextAvatarRetryAt,
    ).toBe(retryAt);
  });

  it("loads a genuinely changed effective avatar without an old retry fence", () => {
    const applyAvatar = vi.fn();
    const remote = Object.create(PlayerRemote.prototype) as PlayerRemote;
    Object.assign(remote, {
      data: {
        avatar: "asset://avatars/base.vrm",
        sessionAvatar: "asset://avatars/session.vrm",
      },
      applyAvatar,
      _nextAvatarRetryAt: Date.now() + 15_000,
    });

    remote.modify({ sessionAvatar: "asset://avatars/replacement.vrm" });

    expect(applyAvatar).toHaveBeenCalledOnce();
    expect(
      (remote as unknown as { _nextAvatarRetryAt: number })._nextAvatarRetryAt,
    ).toBe(0);
  });
});

describe("PlayerRemote emote authority updates", () => {
  it("atomically clears the compact death alias on an authoritative respawn emote", () => {
    const remote = Object.create(PlayerRemote.prototype) as PlayerRemote;
    Object.assign(remote, {
      data: {
        emote: "death",
        e: "death",
        deathState: DeathState.ALIVE,
      },
      applyAvatar: vi.fn(),
      _nextAvatarRetryAt: 0,
    });

    remote.modify({ e: "idle" });

    expect(remote.data.emote).toBe("idle");
    expect(remote.data.e).toBe("idle");
  });

  it("keeps both emote aliases frozen while death is authoritative", () => {
    const remote = Object.create(PlayerRemote.prototype) as PlayerRemote;
    Object.assign(remote, {
      data: {
        emote: "death",
        e: "death",
        deathState: DeathState.DYING,
      },
      applyAvatar: vi.fn(),
      _nextAvatarRetryAt: 0,
    });

    remote.modify({ e: "idle" });

    expect(remote.data.emote).toBe("death");
    expect(remote.data.e).toBe("death");
  });
});
