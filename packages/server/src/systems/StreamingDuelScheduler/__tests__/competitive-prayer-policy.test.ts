import { beforeAll, describe, expect, it } from "vitest";
import { prayerDataProvider } from "@hyperforge/shared";

import prayersManifest from "../../../../world/assets/manifests/prayers.json";
import {
  getAvailableCompetitiveTacticalPrayerIds,
  getAvailablePrayerIdsForLevel,
} from "../competitive-prayer-policy.js";

beforeAll(() => {
  prayerDataProvider.loadPrayers(prayersManifest);
  prayerDataProvider.rebuild();
});

describe("competitive Prayer manifest policy", () => {
  it("derives usable Prayer IDs only from authored definitions at or below the frozen level", () => {
    for (const level of [1, 12, 13, 26, 27, 99]) {
      const expected = prayersManifest.prayers
        .filter((prayer) => prayer.level <= level)
        .map((prayer) => prayer.id)
        .sort((left, right) => left.localeCompare(right));
      expect(getAvailablePrayerIdsForLevel(level)).toEqual(expected);
    }
  });

  it("fails closed for malformed levels and filters tactics through the live manifest", () => {
    expect(getAvailablePrayerIdsForLevel(0)).toEqual([]);
    expect(getAvailablePrayerIdsForLevel(1.5)).toEqual([]);
    expect(getAvailablePrayerIdsForLevel(Number.NaN)).toEqual([]);
    expect(getAvailableCompetitiveTacticalPrayerIds(12)).toEqual(["rock_skin"]);
    expect(getAvailableCompetitiveTacticalPrayerIds(13)).toEqual([
      "superhuman_strength",
      "rock_skin",
    ]);
    expect(getAvailableCompetitiveTacticalPrayerIds(26)).toEqual([
      "superhuman_strength",
      "rock_skin",
      "hawk_eye",
    ]);
  });
});
