import { describe, expect, it } from "vitest";
import { getPrayerIds, getPrayersAtLevel } from "../utils/world-data.js";

describe("world-data Prayer manifests", () => {
  it("resolves the live server manifest when tests run from the plugin package", () => {
    expect(getPrayerIds()).toEqual([
      "thick_skin",
      "burst_of_strength",
      "clarity_of_thought",
      "rock_skin",
      "superhuman_strength",
      "sharp_eye",
      "hawk_eye",
      "mystic_will",
      "mystic_lore",
    ]);
  });

  it("fails closed for malformed levels and exposes only satisfied entries", () => {
    expect(getPrayersAtLevel(Number.NaN)).toEqual([]);
    expect(getPrayersAtLevel(0)).toEqual([]);
    expect(getPrayersAtLevel(1).map((prayer) => prayer.id)).toEqual([
      "thick_skin",
    ]);
    expect(getPrayersAtLevel(9).map((prayer) => prayer.id)).toEqual([
      "thick_skin",
      "burst_of_strength",
      "clarity_of_thought",
      "sharp_eye",
      "mystic_will",
    ]);
  });
});
