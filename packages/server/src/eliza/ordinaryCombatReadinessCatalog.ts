import {
  ammunitionService,
  COMBAT_SPELLS,
  ELEMENTAL_STAVES,
  getAllStores,
  ITEMS,
  SPELL_ORDER,
} from "@hyperforge/shared";

import { isStreamingDuelWeaponPresentationEligible } from "../streaming/duel-equipment-presentation.js";
import {
  ORDINARY_COMBAT_AMMUNITION_TARGET,
  ORDINARY_COMBAT_MAGIC_CAST_TARGET,
} from "./ordinaryCombatSpecialization.js";
import type { OrdinaryCombatReadinessCatalog } from "./ordinaryCombatReadinessSelection.js";

/**
 * Build the exact public launch-ready combat combinations once for both the
 * behavior worker snapshot and private bank validation.
 */
export function buildOrdinaryCombatReadinessCatalog(
  authoredStores: ReturnType<typeof getAllStores> = getAllStores(),
): OrdinaryCombatReadinessCatalog {
  const storeItemIds = new Set(
    authoredStores.flatMap((store) => store.items.map((item) => item.itemId)),
  );
  const authoredItems = [...ITEMS.entries()];
  const requiredSkillLevel = (
    item: (typeof authoredItems)[number][1],
    skill: string,
  ): number => {
    const requirements = (
      item as unknown as {
        requirements?: { skills?: Record<string, unknown> };
      }
    ).requirements?.skills;
    const raw = Number(requirements?.[skill] ?? 1);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 1;
  };
  const eligibleWeapons = (attackType: "melee" | "ranged" | "magic") =>
    authoredItems
      .filter(
        ([itemId, item]) =>
          storeItemIds.has(itemId) &&
          isStreamingDuelWeaponPresentationEligible(itemId) &&
          item.type === "weapon" &&
          String(item.attackType ?? "melee").toLowerCase() === attackType,
      )
      .sort(([left], [right]) => left.localeCompare(right));
  const meleeWeapons = eligibleWeapons("melee");
  const rangedWeapons = eligibleWeapons("ranged");
  const magicWeapons = eligibleWeapons("magic");
  const ammunition = authoredItems
    .filter(
      ([itemId, item]) =>
        storeItemIds.has(itemId) && item.type === "ammunition",
    )
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    ammunitionTarget: ORDINARY_COMBAT_AMMUNITION_TARGET,
    magicCastTarget: ORDINARY_COMBAT_MAGIC_CAST_TARGET,
    melee: meleeWeapons
      .map(([weaponId, weapon]) => ({
        weaponId,
        weaponScore:
          Number(weapon.bonuses?.attack ?? 0) +
          Number(weapon.bonuses?.strength ?? 0) +
          Number(weapon.bonuses?.meleeStrength ?? 0) +
          Number(weapon.bonuses?.attackStab ?? 0) +
          Number(weapon.bonuses?.attackSlash ?? 0) +
          Number(weapon.bonuses?.attackCrush ?? 0),
        requiredAttackLevel: requiredSkillLevel(weapon, "attack"),
      }))
      .sort(
        (left, right) =>
          left.requiredAttackLevel - right.requiredAttackLevel ||
          left.weaponId.localeCompare(right.weaponId),
      ),
    ranged: rangedWeapons
      .flatMap(([weaponId, weapon]) =>
        ammunition
          .filter(([ammunitionId]) =>
            ammunitionService.areArrowsCompatible(weaponId, ammunitionId),
          )
          .map(([ammunitionId, ammunitionItem]) => ({
            weaponId,
            ammunitionId,
            weaponScore: Number(weapon.bonuses?.attackRanged ?? 0),
            ammunitionScore: Number(
              ammunitionService.getArrowData(ammunitionId)?.rangedStrength ??
                ammunitionItem.bonuses?.rangedStrength ??
                0,
            ),
            requiredRangedLevel: Math.max(
              requiredSkillLevel(weapon, "ranged"),
              requiredSkillLevel(ammunitionItem, "ranged"),
              ammunitionService.getArrowData(ammunitionId)
                ?.requiredRangedLevel ?? 1,
            ),
          })),
      )
      .sort(
        (left, right) =>
          left.requiredRangedLevel - right.requiredRangedLevel ||
          left.weaponId.localeCompare(right.weaponId) ||
          left.ammunitionId.localeCompare(right.ammunitionId),
      ),
    magic: magicWeapons
      .flatMap(([weaponId, weapon]) => {
        const providedRuneIds = [...(ELEMENTAL_STAVES[weaponId] ?? [])].sort(
          (left, right) => left.localeCompare(right),
        );
        return SPELL_ORDER.flatMap((spellId, spellOrder) => {
          const spell = COMBAT_SPELLS[spellId];
          if (
            !spell ||
            spell.runes.some(
              (rune) =>
                !providedRuneIds.includes(rune.runeId) &&
                !storeItemIds.has(rune.runeId),
            )
          ) {
            return [];
          }
          return [
            {
              weaponId,
              spellId,
              weaponScore: Number(weapon.bonuses?.attackMagic ?? 0),
              spellOrder,
              requiredMagicLevel: Math.max(
                spell.level,
                requiredSkillLevel(weapon, "magic"),
              ),
              providedRuneIds,
              runes: spell.runes.map((rune) => ({
                itemId: rune.runeId,
                quantityPerCast: rune.quantity,
              })),
            },
          ];
        });
      })
      .sort(
        (left, right) =>
          left.requiredMagicLevel - right.requiredMagicLevel ||
          left.spellOrder - right.spellOrder ||
          left.weaponId.localeCompare(right.weaponId),
      ),
  };
}
