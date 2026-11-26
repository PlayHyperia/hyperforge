import type { WorkerProcessingRecipeSnapshot } from "./worker/workerTypes.js";
import type { OrdinaryCombatSpecialization } from "./ordinaryCombatSpecialization.js";

export type OrdinaryCombatReadinessCatalog = NonNullable<
  WorkerProcessingRecipeSnapshot["combatReadiness"]
>;
export type OrdinaryMeleeReadinessLoadout =
  OrdinaryCombatReadinessCatalog["melee"][number];
export type OrdinaryRangedReadinessLoadout =
  OrdinaryCombatReadinessCatalog["ranged"][number];
export type OrdinaryMagicReadinessLoadout =
  OrdinaryCombatReadinessCatalog["magic"][number];
export type OrdinaryCombatReadinessSelection =
  | { role: "melee"; loadout: OrdinaryMeleeReadinessLoadout }
  | { role: "ranged"; loadout: OrdinaryRangedReadinessLoadout }
  | { role: "mage"; loadout: OrdinaryMagicReadinessLoadout };

export type OrdinaryCombatSupplyNeed = {
  itemId: string;
  /** Exact total owned quantity required, not merely the current deficit. */
  targetQuantity: number;
  purpose: string;
};

/**
 * Select one stable, level-legal setup from the public launch catalog. The
 * callback keeps this pure across the main process and behavior worker.
 */
export function selectOrdinaryCombatReadiness(
  catalog: OrdinaryCombatReadinessCatalog,
  specialization: OrdinaryCombatSpecialization,
  getSkillLevel: (skill: "attack" | "ranged" | "magic") => number,
): OrdinaryCombatReadinessSelection | null {
  if (specialization === "melee") {
    const level = getSkillLevel("attack");
    const loadout = catalog.melee
      .filter((candidate) => candidate.requiredAttackLevel <= level)
      .sort(
        (left, right) =>
          right.weaponScore - left.weaponScore ||
          right.requiredAttackLevel - left.requiredAttackLevel ||
          left.weaponId.localeCompare(right.weaponId),
      )[0];
    return loadout ? { role: "melee", loadout } : null;
  }

  if (specialization === "ranged") {
    const level = getSkillLevel("ranged");
    const loadout = catalog.ranged
      .filter((candidate) => candidate.requiredRangedLevel <= level)
      .sort(
        (left, right) =>
          right.weaponScore - left.weaponScore ||
          right.ammunitionScore - left.ammunitionScore ||
          right.requiredRangedLevel - left.requiredRangedLevel ||
          left.weaponId.localeCompare(right.weaponId) ||
          left.ammunitionId.localeCompare(right.ammunitionId),
      )[0];
    return loadout ? { role: "ranged", loadout } : null;
  }

  const level = getSkillLevel("magic");
  const loadout = catalog.magic
    .filter((candidate) => candidate.requiredMagicLevel <= level)
    .sort((left, right) => {
      const rightProvided = right.runes
        .filter((rune) => right.providedRuneIds.includes(rune.itemId))
        .reduce((total, rune) => total + rune.quantityPerCast, 0);
      const leftProvided = left.runes
        .filter((rune) => left.providedRuneIds.includes(rune.itemId))
        .reduce((total, rune) => total + rune.quantityPerCast, 0);
      return (
        right.spellOrder - left.spellOrder ||
        rightProvided - leftProvided ||
        right.weaponScore - left.weaponScore ||
        right.requiredMagicLevel - left.requiredMagicLevel ||
        left.weaponId.localeCompare(right.weaponId)
      );
    })[0];
  return loadout ? { role: "mage", loadout } : null;
}

/** Return the first exact missing item in the selected setup. */
export function getOrdinaryCombatSupplyNeed(
  catalog: OrdinaryCombatReadinessCatalog,
  readiness: OrdinaryCombatReadinessSelection,
  ownedQuantity: (itemId: string) => number,
): OrdinaryCombatSupplyNeed | null {
  if (ownedQuantity(readiness.loadout.weaponId) < 1) {
    return {
      itemId: readiness.loadout.weaponId,
      targetQuantity: 1,
      purpose: `authoritative ${readiness.role} weapon readiness`,
    };
  }
  if (readiness.role === "melee") return null;

  if (readiness.role === "ranged") {
    return ownedQuantity(readiness.loadout.ammunitionId) <
      catalog.ammunitionTarget
      ? {
          itemId: readiness.loadout.ammunitionId,
          targetQuantity: catalog.ammunitionTarget,
          purpose: "authoritative ranged ammunition readiness",
        }
      : null;
  }

  return (
    readiness.loadout.runes
      .filter(
        (rune) => !readiness.loadout.providedRuneIds.includes(rune.itemId),
      )
      .map((rune) => ({
        itemId: rune.itemId,
        targetQuantity: rune.quantityPerCast * catalog.magicCastTarget,
        purpose: "authoritative magic-rune readiness",
      }))
      .filter((rune) => ownedQuantity(rune.itemId) < rune.targetQuantity)
      .sort((left, right) => left.itemId.localeCompare(right.itemId))[0] ?? null
  );
}
