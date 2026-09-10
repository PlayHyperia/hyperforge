export type OrdinarySupplyRequirement = {
  itemId: string;
  quantity: number;
};

/**
 * Prefer an authored equivalent input route that is already owned. This is a
 * custody-preservation rule, not a value or progression preference: complete
 * ownership wins, then the greatest covered fraction, then manifest order.
 */
export function orderOrdinarySupplyAlternatives<
  T extends readonly OrdinarySupplyRequirement[],
>(alternatives: readonly T[], ownedQuantity: (itemId: string) => number): T[] {
  return alternatives
    .map((alternative, index) => {
      let required = 0;
      let covered = 0;
      for (const requirement of alternative) {
        const quantity = Number(requirement.quantity);
        if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
        const owned = Number(ownedQuantity(requirement.itemId));
        const safeOwned = Number.isSafeInteger(owned) && owned > 0 ? owned : 0;
        required += quantity;
        covered += Math.min(quantity, safeOwned);
      }
      return {
        alternative,
        index,
        complete: required > 0 && covered === required,
        coverage: required > 0 ? covered / required : 0,
      };
    })
    .sort(
      (left, right) =>
        Number(right.complete) - Number(left.complete) ||
        right.coverage - left.coverage ||
        left.index - right.index,
    )
    .map(({ alternative }) => alternative);
}
