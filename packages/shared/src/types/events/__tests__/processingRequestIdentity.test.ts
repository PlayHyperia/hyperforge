import { describe, expect, it } from "vitest";
import {
  getProcessingRequestOperationId,
  normalizeProcessingRequestEnvelope,
  normalizeProcessingRequestId,
} from "../event-payloads";

describe("processing request identity", () => {
  it("normalizes a UUID and binds it to one exact processing family", () => {
    const requestId = "D8C72678-BCEE-435A-BC04-E6DE3FA739B6";

    expect(normalizeProcessingRequestId(requestId)).toBe(
      requestId.toLowerCase(),
    );
    expect(getProcessingRequestOperationId("smelting", requestId)).toBe(
      `processing-request:smelting:${requestId.toLowerCase()}`,
    );
    expect(getProcessingRequestOperationId("smithing", requestId)).toBe(
      `processing-request:smithing:${requestId.toLowerCase()}`,
    );
  });

  it.each([undefined, null, "", "not-a-uuid", 42])(
    "rejects malformed identity %p without deriving an operation ID",
    (requestId) => {
      expect(normalizeProcessingRequestId(requestId)).toBeNull();
      expect(getProcessingRequestOperationId("crafting", requestId)).toBeNull();
    },
  );

  it.each([
    [
      "firemaking",
      { skill: "firemaking", logsId: "logs", logsSlot: 2, tinderboxSlot: 4 },
    ],
    [
      "cooking",
      {
        skill: "cooking",
        rawFoodId: "raw_shrimp",
        rawFoodSlot: 6,
        sourceId: "range:lumbridge",
        sourceType: "range",
      },
    ],
    [
      "smelting",
      {
        skill: "smelting",
        barItemId: "bronze_bar",
        furnaceId: "furnace:town",
        quantity: 1,
      },
    ],
    [
      "smithing",
      {
        skill: "smithing",
        recipeId: "bronze_dagger",
        anvilId: "anvil:town",
        quantity: 1,
      },
    ],
    [
      "crafting",
      {
        skill: "crafting",
        recipeId: "gold_ring",
        quantity: 1,
        stationId: "furnace:town",
      },
    ],
    [
      "fletching",
      { skill: "fletching", recipeId: "arrow_shaft:logs", quantity: 1 },
    ],
    [
      "runecrafting",
      { skill: "runecrafting", altarId: "air:altar", runeType: "air" },
    ],
    [
      "tanning",
      {
        skill: "tanning",
        inputItemId: "cowhide",
        quantity: 1,
        tannerEntityId: "tanner:town",
        tannerNpcId: "tanner",
      },
    ],
  ] as const)("normalizes the %s recovery envelope", (skill, envelope) => {
    expect(normalizeProcessingRequestEnvelope(skill, envelope)).toEqual(
      envelope,
    );
  });

  it.each([
    [
      "firemaking",
      { skill: "firemaking", logsId: "logs", logsSlot: 2, tinderboxSlot: 2 },
    ],
    [
      "cooking",
      {
        skill: "cooking",
        rawFoodId: "raw shrimp",
        rawFoodSlot: 6,
        sourceId: "range",
        sourceType: "range",
      },
    ],
    [
      "smelting",
      {
        skill: "smelting",
        barItemId: "bronze_bar",
        furnaceId: "furnace",
        quantity: 2,
      },
    ],
    [
      "smithing",
      {
        skill: "crafting",
        recipeId: "bronze_dagger",
        anvilId: "anvil",
        quantity: 1,
      },
    ],
    [
      "crafting",
      { skill: "crafting", recipeId: "gold_ring", quantity: 1, stationId: "" },
    ],
    ["fletching", { skill: "fletching", recipeId: "Arrow Shaft", quantity: 1 }],
    [
      "runecrafting",
      { skill: "runecrafting", altarId: "altar", runeType: "air rune" },
    ],
    ["tanning", { skill: "tanning", inputItemId: "cowhide", quantity: 1 }],
  ] as const)("rejects an unsafe %s recovery envelope", (skill, envelope) => {
    expect(normalizeProcessingRequestEnvelope(skill, envelope)).toBeNull();
  });
});
