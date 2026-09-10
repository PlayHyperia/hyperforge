import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ITEMS } from "@hyperforge/shared";
import {
  buildDuelPreparationCommittedSnapshot,
  getDuelPreparationAttackSupplyTarget,
} from "../duelPreparationPlan.js";

const testItems = [
  { id: "plan_sword", type: "weapon", equipSlot: "weapon", stackable: false },
  { id: "plan_bow", type: "weapon", equipSlot: "2h", stackable: false },
  {
    id: "plan_arrow",
    type: "ammunition",
    equipSlot: "arrows",
    stackable: true,
  },
  { id: "plan_food", type: "consumable", stackable: false, healAmount: 10 },
  { id: "plan_junk", type: "material", stackable: false },
] as const;

describe("getDuelPreparationAttackSupplyTarget", () => {
  it("covers the opening launch and every configured fight-time boundary", () => {
    expect(getDuelPreparationAttackSupplyTarget(315_000, 5)).toBe(106);
    expect(getDuelPreparationAttackSupplyTarget(315_000, 3)).toBe(176);
    expect(getDuelPreparationAttackSupplyTarget(315_001, 5)).toBe(107);
  });

  it("fails closed for invalid duration or attack-speed inputs", () => {
    expect(getDuelPreparationAttackSupplyTarget(0, 5)).toBe(0);
    expect(getDuelPreparationAttackSupplyTarget(315_000, 0)).toBe(0);
    expect(getDuelPreparationAttackSupplyTarget(315_000.5, 5)).toBe(0);
    expect(getDuelPreparationAttackSupplyTarget(315_000, Number.NaN)).toBe(0);
  });
});

describe("buildDuelPreparationCommittedSnapshot", () => {
  beforeEach(() => {
    for (const item of testItems) {
      ITEMS.set(item.id, { name: item.id, ...item } as never);
    }
  });

  afterEach(() => {
    for (const item of testItems) ITEMS.delete(item.id);
  });

  it("builds one exact conserving snapshot and banks every displaced item", () => {
    const result = buildDuelPreparationCommittedSnapshot({
      bank: [
        { itemId: "plan_bow", quantity: 1, slot: 3, tabIndex: 0 },
        { itemId: "plan_arrow", quantity: 80, slot: 4, tabIndex: 0 },
        { itemId: "plan_food", quantity: 4, slot: 5, tabIndex: 0 },
      ],
      inventory: [{ slot: 7, itemId: "plan_junk", quantity: 1 }],
      equipment: {
        weapon: { itemId: "plan_sword", quantity: 1 },
      },
      targetInventoryQuantities: new Map([["plan_food", 4]]),
      targetEquipment: [
        { slotType: "weapon", itemId: "plan_bow", quantity: 1 },
        { slotType: "arrows", itemId: "plan_arrow", quantity: 50 },
      ],
      selectedSpell: null,
    });

    expect(result).toEqual({
      ok: true,
      committed: {
        bank: [
          { itemId: "plan_junk", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "plan_sword", quantity: 1, slot: 1, tabIndex: 0 },
          { itemId: "plan_arrow", quantity: 30, slot: 4, tabIndex: 0 },
        ],
        inventory: [
          { itemId: "plan_food", quantity: 1, slotIndex: 0, metadata: null },
          { itemId: "plan_food", quantity: 1, slotIndex: 1, metadata: null },
          { itemId: "plan_food", quantity: 1, slotIndex: 2, metadata: null },
          { itemId: "plan_food", quantity: 1, slotIndex: 3, metadata: null },
        ],
        equipment: [
          { slotType: "arrows", itemId: "plan_arrow", quantity: 50 },
          { slotType: "weapon", itemId: "plan_bow", quantity: 1 },
        ],
        selectedSpell: null,
      },
    });
  });

  it("rejects a plan that asks for custody the agent does not own", () => {
    expect(
      buildDuelPreparationCommittedSnapshot({
        bank: [],
        inventory: [],
        equipment: {},
        targetInventoryQuantities: new Map(),
        targetEquipment: [
          { slotType: "weapon", itemId: "plan_sword", quantity: 1 },
        ],
        selectedSpell: null,
      }),
    ).toEqual({ ok: false, reason: "custody_violation" });
  });

  it("rejects a final carried inventory larger than 28 slots", () => {
    expect(
      buildDuelPreparationCommittedSnapshot({
        bank: [{ itemId: "plan_food", quantity: 29, slot: 0, tabIndex: 0 }],
        inventory: [],
        equipment: {},
        targetInventoryQuantities: new Map([["plan_food", 29]]),
        targetEquipment: [],
        selectedSpell: null,
      }),
    ).toEqual({ ok: false, reason: "inventory_capacity_exceeded" });
  });
});
