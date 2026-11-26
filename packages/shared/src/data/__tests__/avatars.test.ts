import { describe, expect, it } from "vitest";

import {
  AVATAR_OPTIONS,
  CANONICAL_DUEL_AVATAR_ID,
  CANONICAL_DUEL_AVATAR_URL,
  DEFAULT_AVATAR_URL,
  DIAGNOSTIC_AVATAR_OPTIONS,
  getAvatarById,
  getAvatarByUrl,
  getDuelAvatarUrlForStyle,
} from "../avatars";

describe("duel avatar roster", () => {
  it.each([
    "authored-body15-test",
    "authored-body38-test",
    "authored-body38-light01-test",
  ])("identifies %s without adding it to the public roster", (id) => {
    const candidate = DIAGNOSTIC_AVATAR_OPTIONS.find(
      (avatar) => avatar.id === id,
    );
    if (!candidate) throw new Error(`Missing diagnostic avatar ${id}`);
    expect(getAvatarById(candidate.id)).toBeUndefined();
    expect(AVATAR_OPTIONS).not.toContain(candidate);
    expect(getAvatarByUrl(candidate.url)).toBe(candidate);
    expect(
      getAvatarByUrl(
        `http://localhost:5555/game-assets${candidate.previewPath}`,
      ),
    ).toBe(candidate);
    expect(candidate.lod1Url).toBeUndefined();
    expect(candidate.lod2Url).toBeUndefined();
    expect(candidate.url).not.toBe(DEFAULT_AVATAR_URL);
    expect(candidate.url).not.toBe(CANONICAL_DUEL_AVATAR_URL);
  });

  it("registers six distinct three-level optimized fighters", () => {
    expect(AVATAR_OPTIONS.map((avatar) => avatar.id)).toEqual([
      "bandit",
      "barbarian",
      "dark-ranger",
      "dark-wizard",
      "steve",
      "kaykit-knight",
    ]);
    expect(new Set(AVATAR_OPTIONS.map((avatar) => avatar.url)).size).toBe(6);
    for (const avatar of AVATAR_OPTIONS) {
      expect(avatar.url).toContain("/duel-candidates/");
      expect(avatar.lod1Url).toContain("_lod1.vrm");
      expect(avatar.lod2Url).toContain("_lod2.vrm");
      expect(avatar.previewPath).toBe(avatar.url.slice("asset:/".length));
    }
    expect(DEFAULT_AVATAR_URL).toBe(AVATAR_OPTIONS[0].url);
    expect(CANONICAL_DUEL_AVATAR_ID).toBe("steve");
    expect(CANONICAL_DUEL_AVATAR_URL).toContain("duel-steve.vrm");
  });

  it("maps scripted strategies to stable, visually meaningful identities", () => {
    expect(getDuelAvatarUrlForStyle("melee", 0)).toContain("barbarian");
    expect(getDuelAvatarUrlForStyle("melee", 1)).toContain("bandit");
    expect(getDuelAvatarUrlForStyle("ranged", 0)).toContain("dark-ranger");
    expect(getDuelAvatarUrlForStyle("mage", 0)).toContain("dark-wizard");
    expect(getDuelAvatarUrlForStyle("prayer", 1)).toContain("barbarian");
    expect(getDuelAvatarUrlForStyle("auto", -1)).toContain("dark-wizard");
  });
});
