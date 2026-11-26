import { describe, expect, it, vi } from "vitest";

import {
  avatarEmoteBlendSecondsFor,
  AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
  AVATAR_EMOTE_BLEND_SECONDS,
  fadeInAvatarEmote,
  fadeOutAvatarEmote,
} from "./AvatarEmoteTransition";

function createAction() {
  const action = {
    fadeOut: vi.fn(() => action),
    reset: vi.fn(() => action),
    fadeIn: vi.fn(() => action),
    play: vi.fn(() => action),
  };
  return action;
}

describe("avatar emote transition policy", () => {
  it("uses the production 150ms blend for both sides of a transition", () => {
    const outgoing = createAction();
    const incoming = createAction();

    fadeOutAvatarEmote(outgoing);
    expect(fadeInAvatarEmote(incoming)).toBe(incoming);

    expect(outgoing.fadeOut).toHaveBeenCalledWith(AVATAR_EMOTE_BLEND_SECONDS);
    expect(incoming.reset).toHaveBeenCalledOnce();
    expect(incoming.fadeIn).toHaveBeenCalledWith(AVATAR_EMOTE_BLEND_SECONDS);
    expect(incoming.play).toHaveBeenCalledOnce();
    expect(AVATAR_EMOTE_BLEND_SECONDS).toBe(0.15);
  });

  it("allows an absent outgoing action during first load", () => {
    expect(() => fadeOutAvatarEmote(null)).not.toThrow();
  });

  it("uses a longer blend only within controlled two-hand guard locomotion", () => {
    const idle =
      "asset://emotes/candidates/emote-2h-idle-steve-controlled-guard-candidate.glb";
    const run =
      "asset://emotes/candidates/emote-2h-run-steve-controlled-guard-candidate.glb?l=1";
    const attack =
      "asset://emotes/candidates/emote-2h-planted-cut-steve-controlled-20-candidate.glb?l=0";

    expect(avatarEmoteBlendSecondsFor(idle, run)).toBe(
      AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
    );
    expect(avatarEmoteBlendSecondsFor(run, idle)).toBe(
      AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
    );
    expect(
      avatarEmoteBlendSecondsFor(
        "asset://emotes/emote-2h-duel-run-steve.glb?s=1.4",
        "asset://emotes/emote-2h-duel-idle-steve.glb",
      ),
    ).toBe(AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS);
    expect(avatarEmoteBlendSecondsFor(idle, attack)).toBe(
      AVATAR_EMOTE_BLEND_SECONDS,
    );
    expect(avatarEmoteBlendSecondsFor(attack, idle)).toBe(
      AVATAR_EMOTE_BLEND_SECONDS,
    );
    expect(avatarEmoteBlendSecondsFor(null, idle)).toBe(
      AVATAR_EMOTE_BLEND_SECONDS,
    );
  });

  it("passes an explicit contextual duration to both fade actions", () => {
    const outgoing = createAction();
    const incoming = createAction();
    fadeOutAvatarEmote(
      outgoing,
      AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
    );
    fadeInAvatarEmote(
      incoming,
      AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
    );
    expect(outgoing.fadeOut).toHaveBeenCalledWith(
      AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
    );
    expect(incoming.fadeIn).toHaveBeenCalledWith(
      AVATAR_CONTROLLED_GUARD_LOCOMOTION_BLEND_SECONDS,
    );
  });
});
