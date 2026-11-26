import { describe, expect, it } from "vitest";

import { orderOrdinarySupplyAlternatives } from "../ordinarySupplyAlternativeSelection";

describe("ordinary supply alternative selection", () => {
  it("prefers complete owned custody, then covered fraction, without mutating manifest order", () => {
    const alternatives = [
      [{ itemId: "default_input", quantity: 10 }],
      [{ itemId: "partial_input", quantity: 2 }],
      [{ itemId: "owned_input", quantity: 3 }],
    ] as const;
    const owned = new Map([
      ["default_input", 4],
      ["partial_input", 1],
      ["owned_input", 3],
    ]);

    expect(
      orderOrdinarySupplyAlternatives(
        alternatives,
        (itemId) => owned.get(itemId) ?? 0,
      ),
    ).toEqual([
      [{ itemId: "owned_input", quantity: 3 }],
      [{ itemId: "partial_input", quantity: 2 }],
      [{ itemId: "default_input", quantity: 10 }],
    ]);
    expect(alternatives[0][0].itemId).toBe("default_input");
  });

  it("preserves authored order when custody coverage is tied", () => {
    const alternatives = [
      [{ itemId: "first", quantity: 1 }],
      [{ itemId: "second", quantity: 1 }],
    ] as const;

    expect(orderOrdinarySupplyAlternatives(alternatives, () => 0)).toEqual(
      alternatives,
    );
  });
});
