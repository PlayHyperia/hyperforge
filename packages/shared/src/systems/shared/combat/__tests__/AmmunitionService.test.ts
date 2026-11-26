/**
 * AmmunitionService Unit Tests
 *
 * Tests arrow validation and consumption:
 * - Validates arrows are equipped
 * - Validates arrow-bow compatibility
 * - Validates ranged level requirements
 * - Gets arrow strength bonuses
 */

import { describe, it, expect } from "vitest";
import { AmmunitionService } from "../AmmunitionService";
import {
  WeaponType,
  type Item,
  type EquipmentSlot,
} from "../../../../types/game/item-types";

describe("AmmunitionService", () => {
  const service = new AmmunitionService();

  // Mock items for testing
  const shortbow: Item = {
    id: "shortbow",
    name: "Shortbow",
    type: "weapon",
    description: "A basic shortbow",
    value: 50,
    weight: 0.9,
    stackable: false,
    tradeable: true,
    weaponType: WeaponType.BOW,
  };

  const mapleShortbow: Item = {
    id: "maple_shortbow",
    name: "Maple shortbow",
    type: "weapon",
    description: "A maple shortbow",
    value: 400,
    weight: 0.9,
    stackable: false,
    tradeable: true,
    weaponType: WeaponType.BOW,
  };

  const sword: Item = {
    id: "bronze_shortsword",
    name: "Bronze sword",
    type: "weapon",
    description: "A bronze sword",
    value: 20,
    weight: 1.8,
    stackable: false,
    tradeable: true,
    weaponType: WeaponType.SWORD,
  };

  const bronzeArrowSlot: EquipmentSlot = {
    itemId: "bronze_arrow",
    quantity: 100,
  };

  const ironArrowSlot: EquipmentSlot = {
    itemId: "iron_arrow",
    quantity: 50,
  };

  const steelArrowSlot: EquipmentSlot = {
    itemId: "steel_arrow",
    quantity: 25,
  };

  const adamantArrowSlot: EquipmentSlot = {
    itemId: "adamant_arrow",
    quantity: 10,
  };

  const emptySlot: EquipmentSlot = {
    itemId: null,
    quantity: 0,
  };

  describe("validateArrows", () => {
    it("rejects when no bow equipped", () => {
      const result = service.validateArrows(null, bronzeArrowSlot, 40);

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("NO_ARROWS");
      expect(result.error).toBe("No bow equipped");
    });

    it("rejects when non-bow weapon equipped", () => {
      const result = service.validateArrows(sword, bronzeArrowSlot, 40);

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("NO_ARROWS");
    });

    it("rejects when no arrows equipped", () => {
      const result = service.validateArrows(shortbow, null, 40);

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("NO_ARROWS");
      expect(result.error).toBe("You need arrows to use a bow");
    });

    it("rejects when arrow slot is empty", () => {
      const result = service.validateArrows(shortbow, emptySlot, 40);

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("NO_ARROWS");
    });

    it("rejects invalid arrow type", () => {
      const invalidArrowSlot: EquipmentSlot = {
        itemId: "invalid_arrow",
        quantity: 10,
      };

      const result = service.validateArrows(shortbow, invalidArrowSlot, 40);

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("INCOMPATIBLE_ARROWS");
    });

    it("rejects when ranged level too low for arrows", () => {
      // Steel arrows require level 5
      const result = service.validateArrows(shortbow, steelArrowSlot, 1);

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("LEVEL_TOO_LOW");
      expect(result.error).toContain("level 5 Ranged");
    });

    it("rejects when bow tier too low for arrows", () => {
      // Adamant arrows require bow tier 30, shortbow is tier 1
      const result = service.validateArrows(shortbow, adamantArrowSlot, 40);

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("INCOMPATIBLE_ARROWS");
      expect(result.error).toContain("cannot fire");
    });

    it("accepts valid bow and arrow combination", () => {
      const result = service.validateArrows(shortbow, bronzeArrowSlot, 40);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
    });

    it("accepts maple bow with adamant arrows at high level", () => {
      const result = service.validateArrows(
        mapleShortbow,
        adamantArrowSlot,
        40,
      );

      expect(result.valid).toBe(true);
    });

    it("accepts any arrow with appropriate level and bow tier", () => {
      // Iron arrows work with shortbow at level 1 (tier 1 bow, tier 1 arrows)
      const ironResult = service.validateArrows(shortbow, ironArrowSlot, 1);
      expect(ironResult.valid).toBe(true);

      // Steel arrows require tier 5 bow, shortbow is tier 1 - should fail
      const steelWithShortbow = service.validateArrows(
        shortbow,
        steelArrowSlot,
        10,
      );
      expect(steelWithShortbow.valid).toBe(false);
    });
  });

  describe("getArrowStrengthBonus", () => {
    it("returns 0 when no arrows equipped", () => {
      expect(service.getArrowStrengthBonus(null)).toBe(0);
      expect(service.getArrowStrengthBonus(emptySlot)).toBe(0);
    });

    it("returns correct strength for bronze arrows", () => {
      expect(service.getArrowStrengthBonus(bronzeArrowSlot)).toBe(7);
    });

    it("returns correct strength for iron arrows", () => {
      expect(service.getArrowStrengthBonus(ironArrowSlot)).toBe(10);
    });

    it("returns correct strength for steel arrows", () => {
      expect(service.getArrowStrengthBonus(steelArrowSlot)).toBe(16);
    });

    it("returns correct strength for adamant arrows", () => {
      expect(service.getArrowStrengthBonus(adamantArrowSlot)).toBe(31);
    });

    it("returns 0 for unknown arrow type", () => {
      const unknownSlot: EquipmentSlot = {
        itemId: "unknown_arrow",
        quantity: 10,
      };
      expect(service.getArrowStrengthBonus(unknownSlot)).toBe(0);
    });
  });

  describe("hasArrows", () => {
    it("returns false when no arrow slot", () => {
      expect(service.hasArrows(null)).toBe(false);
    });

    it("returns false when empty arrow slot", () => {
      expect(service.hasArrows(emptySlot)).toBe(false);
    });

    it("returns false for unknown arrow type", () => {
      const unknownSlot: EquipmentSlot = {
        itemId: "unknown_arrow",
        quantity: 10,
      };
      expect(service.hasArrows(unknownSlot)).toBe(false);
    });

    it("returns true for valid arrow types", () => {
      expect(service.hasArrows(bronzeArrowSlot)).toBe(true);
      expect(service.hasArrows(ironArrowSlot)).toBe(true);
      expect(service.hasArrows(steelArrowSlot)).toBe(true);
      expect(service.hasArrows(adamantArrowSlot)).toBe(true);
    });
  });

  describe("getArrowData", () => {
    it("returns undefined for unknown arrow", () => {
      expect(service.getArrowData("unknown_arrow")).toBeUndefined();
    });

    it("returns correct data for bronze arrow", () => {
      const data = service.getArrowData("bronze_arrow");
      expect(data).toBeDefined();
      expect(data?.rangedStrength).toBe(7);
      expect(data?.requiredRangedLevel).toBe(1);
      expect(data?.requiredBowTier).toBe(1);
    });

    it("returns correct data for adamant arrow", () => {
      const data = service.getArrowData("adamant_arrow");
      expect(data).toBeDefined();
      expect(data?.rangedStrength).toBe(31);
      expect(data?.requiredRangedLevel).toBe(30);
      expect(data?.requiredBowTier).toBe(30);
    });

    it("matches the rune arrow values in the item manifest", () => {
      const data = service.getArrowData("rune_arrow");
      expect(data).toEqual({
        id: "rune_arrow",
        name: "Rune arrow",
        rangedStrength: 49,
        requiredRangedLevel: 40,
        requiredBowTier: 40,
      });
    });
  });

  describe("getBowTier", () => {
    it("returns 1 for basic shortbow", () => {
      expect(service.getBowTier("shortbow")).toBe(1);
    });

    it("returns 5 for oak shortbow", () => {
      expect(service.getBowTier("oak_shortbow")).toBe(5);
    });

    it("returns 20 for willow shortbow", () => {
      expect(service.getBowTier("willow_shortbow")).toBe(20);
    });

    it("returns 30 for maple shortbow", () => {
      expect(service.getBowTier("maple_shortbow")).toBe(30);
    });

    it("covers the high-tier shortbow and longbow manifests", () => {
      expect(service.getBowTier("yew_shortbow")).toBe(40);
      expect(service.getBowTier("magic_shortbow")).toBe(50);
      expect(service.getBowTier("yew_longbow")).toBe(40);
      expect(service.getBowTier("magic_longbow")).toBe(50);
    });

    it("returns 1 for unknown bow", () => {
      expect(service.getBowTier("unknown_bow")).toBe(1);
    });
  });

  describe("areArrowsCompatible", () => {
    it("returns true for bronze arrows with shortbow", () => {
      expect(service.areArrowsCompatible("shortbow", "bronze_arrow")).toBe(
        true,
      );
    });

    it("returns true for iron arrows with shortbow", () => {
      expect(service.areArrowsCompatible("shortbow", "iron_arrow")).toBe(true);
    });

    it("returns false for adamant arrows with shortbow", () => {
      // Adamant requires tier 30, shortbow is tier 1
      expect(service.areArrowsCompatible("shortbow", "adamant_arrow")).toBe(
        false,
      );
    });

    it("returns true for adamant arrows with maple shortbow", () => {
      // Maple shortbow is tier 30
      expect(
        service.areArrowsCompatible("maple_shortbow", "adamant_arrow"),
      ).toBe(true);
    });

    it("accepts rune arrows only with a compatible high-tier bow", () => {
      expect(service.areArrowsCompatible("yew_shortbow", "rune_arrow")).toBe(
        true,
      );
      expect(service.areArrowsCompatible("magic_longbow", "rune_arrow")).toBe(
        true,
      );
      expect(service.areArrowsCompatible("maple_shortbow", "rune_arrow")).toBe(
        false,
      );
    });

    it("returns false for unknown arrow type", () => {
      expect(service.areArrowsCompatible("shortbow", "unknown_arrow")).toBe(
        false,
      );
    });
  });
});
