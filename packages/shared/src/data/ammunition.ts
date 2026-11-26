/**
 * Ammunition Manifest
 * Defines bow tiers and arrow data for ranged combat.
 */

export interface ArrowData {
  id: string;
  name: string;
  rangedStrength: number;
  requiredRangedLevel: number;
  requiredBowTier: number;
}

/**
 * Bow tier requirements for arrows.
 * Maps bow ID to its tier level — arrows require a bow of equal or higher tier.
 */
export const BOW_TIERS: Readonly<Record<string, number>> = Object.freeze({
  // Shortbows
  shortbow: 1,
  oak_shortbow: 5,
  willow_shortbow: 20,
  maple_shortbow: 30,
  yew_shortbow: 40,
  magic_shortbow: 50,

  // Longbows (same tier as their shortbow counterpart)
  longbow: 1,
  oak_longbow: 5,
  willow_longbow: 20,
  maple_longbow: 30,
  yew_longbow: 40,
  magic_longbow: 50,
});

/**
 * Arrow strength bonuses and requirements.
 * F2P scope: standard arrows only (no bolts, no thrown weapons).
 */
export const ARROW_DATA: Readonly<Record<string, Readonly<ArrowData>>> =
  Object.freeze({
    bronze_arrow: Object.freeze({
      id: "bronze_arrow",
      name: "Bronze arrow",
      rangedStrength: 7,
      requiredRangedLevel: 1,
      requiredBowTier: 1,
    }),
    iron_arrow: Object.freeze({
      id: "iron_arrow",
      name: "Iron arrow",
      rangedStrength: 10,
      requiredRangedLevel: 1,
      requiredBowTier: 1,
    }),
    steel_arrow: Object.freeze({
      id: "steel_arrow",
      name: "Steel arrow",
      rangedStrength: 16,
      requiredRangedLevel: 5,
      requiredBowTier: 5,
    }),
    mithril_arrow: Object.freeze({
      id: "mithril_arrow",
      name: "Mithril arrow",
      rangedStrength: 22,
      requiredRangedLevel: 20,
      requiredBowTier: 20,
    }),
    adamant_arrow: Object.freeze({
      id: "adamant_arrow",
      name: "Adamant arrow",
      rangedStrength: 31,
      requiredRangedLevel: 30,
      requiredBowTier: 30,
    }),
    rune_arrow: Object.freeze({
      id: "rune_arrow",
      name: "Rune arrow",
      rangedStrength: 49,
      requiredRangedLevel: 40,
      requiredBowTier: 40,
    }),
  });
