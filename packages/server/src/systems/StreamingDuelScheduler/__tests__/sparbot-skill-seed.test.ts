import { afterAll, describe, expect, it } from "vitest";

import { World } from "../../../../../shared/src/core/World";
import { SkillsSystem } from "../../../../../shared/src/systems/shared/character/SkillsSystem";
import { sparbotSkillXpForLevel } from "../sparbot-skill-seed";

// Real game table, no mocked database/world or service initialization.
const world = new World();
const skills = new SkillsSystem(world);
afterAll(async () => {
  skills.destroy();
  await world.destroy();
});

describe("standalone diagnostic sparbot XP seed", () => {
  it("matches the actual game curve at every level, including level one", () => {
    for (let level = 1; level <= 99; level++) {
      const xp = sparbotSkillXpForLevel(level);
      expect(xp).toBe(skills.getXPForLevel(level));
      expect(skills.getLevelForXP(xp)).toBe(level);
      if (level > 1) expect(skills.getLevelForXP(xp - 1)).toBe(level - 1);
    }
    expect(sparbotSkillXpForLevel(1)).toBe(0);
  });

  it("repairs the previously inconsistent diagnostic combat profiles", () => {
    for (const level of [61, 66, 42, 59, 1, 1, 12]) {
      const corrected = sparbotSkillXpForLevel(level);
      expect(skills.getLevelForXP(corrected)).toBe(level);
      if (level > 1) expect(skills.getLevelForXP(0)).not.toBe(level);
    }
    expect(sparbotSkillXpForLevel(10)).toBe(1151);
    expect(sparbotSkillXpForLevel(99)).toBe(13034394);
  });

  it("rejects invalid generated levels instead of inventing or clamping XP", () => {
    for (const level of [0, -1, 100, 1.5, NaN, Infinity, -Infinity]) {
      expect(() => sparbotSkillXpForLevel(level)).toThrow(
        /integer from 1 to 99/,
      );
    }
  });
});
