import { describe, expect, it } from "vitest";

import { getDuelPreparationFoodTargetQuantity } from "../AgentManager";

describe("getDuelPreparationFoodTargetQuantity", () => {
  it("derives one full health reserve from authoritative health and healing", () => {
    expect(getDuelPreparationFoodTargetQuantity(40, 3)).toBe(14);
    expect(getDuelPreparationFoodTargetQuantity(20, 12)).toBe(2);
    expect(getDuelPreparationFoodTargetQuantity(10, 10)).toBe(1);
  });

  it.each([
    [0, 3],
    [-1, 3],
    [40, 0],
    [40, -1],
    [Number.NaN, 3],
    [40, Number.POSITIVE_INFINITY],
  ])(
    "rejects an invalid health or healing boundary (%s, %s)",
    (health, heal) => {
      expect(getDuelPreparationFoodTargetQuantity(health, heal)).toBe(0);
    },
  );
});
