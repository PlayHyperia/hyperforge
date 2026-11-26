import { describe, expect, it } from "vitest";
import { AttackType } from "@hyperforge/shared";

import { resolveWeaponAttackType } from "../index";

describe("ServerNetwork weapon profile normalization", () => {
  it.each(["RANGED", "ranged", " Ranged "])(
    "normalizes manifest attack type %s for ranged pathfinding",
    (attackType) => {
      expect(resolveWeaponAttackType(attackType, "BOW")).toBe(
        AttackType.RANGED,
      );
    },
  );

  it("recognizes legacy bow metadata without an explicit attack type", () => {
    expect(resolveWeaponAttackType(undefined, "CROSSBOW")).toBe(
      AttackType.RANGED,
    );
  });

  it("keeps magic weapons in melee mode until a spell is selected", () => {
    expect(resolveWeaponAttackType("MAGIC", "STAFF")).toBe(AttackType.MELEE);
  });
});
