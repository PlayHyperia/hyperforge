import { describe, expect, it } from "vitest";

import {
  ProcessingDataProvider,
  type CookingManifest,
  type FiremakingManifest,
} from "../ProcessingDataProvider";

function createIsolatedProvider(): ProcessingDataProvider {
  return Reflect.construct(
    ProcessingDataProvider as unknown as new () => ProcessingDataProvider,
    [],
  );
}

describe("ProcessingDataProvider authored action timing", () => {
  it("retains exact cooking and firemaking ticks in runtime recipe data", () => {
    const provider = createIsolatedProvider();
    provider.loadCookingRecipes({
      recipes: [
        {
          raw: "raw_test_fish",
          cooked: "test_fish",
          burnt: "burnt_test_fish",
          level: 1,
          xp: 1,
          ticks: 7,
          stopBurnLevel: { fire: 10, range: 9 },
        },
      ],
    });
    provider.loadFiremakingRecipes({
      recipes: [{ log: "test_logs", level: 1, xp: 1, ticks: 5 }],
    });

    provider.rebuild();

    expect(provider.getCookingData("raw_test_fish")?.ticks).toBe(7);
    expect(provider.getFiremakingData("test_logs")?.ticks).toBe(5);
  });

  it.each([
    { label: "zero", ticks: 0 },
    { label: "negative", ticks: -1 },
    { label: "fractional", ticks: 1.5 },
    { label: "non-finite", ticks: Number.NaN },
  ])("rejects $label cooking ticks", ({ ticks }) => {
    const provider = createIsolatedProvider();
    provider.loadCookingRecipes({
      recipes: [
        {
          raw: "raw_test_fish",
          cooked: "test_fish",
          burnt: "burnt_test_fish",
          level: 1,
          xp: 1,
          ticks,
          stopBurnLevel: { fire: 10, range: 9 },
        },
      ],
    } satisfies CookingManifest);

    expect(() => provider.rebuild()).toThrow("Invalid cooking manifest");
  });

  it.each([
    { label: "zero", ticks: 0 },
    { label: "negative", ticks: -1 },
    { label: "fractional", ticks: 1.5 },
    { label: "non-finite", ticks: Number.POSITIVE_INFINITY },
  ])("rejects $label firemaking ticks", ({ ticks }) => {
    const provider = createIsolatedProvider();
    provider.loadFiremakingRecipes({
      recipes: [{ log: "test_logs", level: 1, xp: 1, ticks }],
    } satisfies FiremakingManifest);

    expect(() => provider.rebuild()).toThrow("Invalid firemaking manifest");
  });
});
