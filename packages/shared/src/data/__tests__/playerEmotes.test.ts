import { describe, expect, it } from "vitest";
import { Emotes, essentialEmotes } from "../playerEmotes";

describe("essential player emote warm-up", () => {
  it("preloads every animation used by a duel combat lifecycle", () => {
    expect(essentialEmotes).toEqual(
      expect.arrayContaining([
        Emotes.IDLE,
        Emotes.WALK,
        Emotes.RUN,
        Emotes.COMBAT,
        Emotes.SWORD_SWING,
        Emotes.TWO_HAND_IDLE,
        Emotes.TWO_HAND_SLASH,
        Emotes.TWO_HAND_DUEL_IDLE,
        Emotes.TWO_HAND_DUEL_WALK,
        Emotes.TWO_HAND_DUEL_RUN,
        Emotes.TWO_HAND_DUEL_SLASH,
        Emotes.RANGE,
        Emotes.SPELL_CAST,
        Emotes.DEATH,
        Emotes.VICTORY,
      ]),
    );
  });

  it("does not schedule duplicate animation fetches", () => {
    expect(new Set(essentialEmotes).size).toBe(essentialEmotes.length);
  });
});
