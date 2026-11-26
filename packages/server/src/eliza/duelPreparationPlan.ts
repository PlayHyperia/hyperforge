import {
  BANKING_CONSTANTS,
  COMBAT_CONSTANTS,
  INPUT_LIMITS,
  getItem,
  type BankSaveItem,
  type DuelPreparationPlanPersistenceSnapshot,
  type EquipmentSaveItem,
  type InventorySaveItem,
} from "@hyperforge/shared";
import { v5 as uuidv5 } from "uuid";

export const DUEL_PREPARATION_OPERATION_NAMESPACE =
  "85f33ed8-a0d0-465e-8782-b9bd4c917188";

/**
 * Resolve the one immutable whole-plan receipt identity shared by the planner,
 * scheduler recovery, and replacement processes.
 */
export function getDuelPreparationPlanOperationId(
  preparationId: string,
  playerId: string,
): string {
  return uuidv5(
    `${preparationId}:${playerId}:whole-plan:v1`,
    DUEL_PREPARATION_OPERATION_NAMESPACE,
  );
}

/**
 * Reserve enough owned projectile supplies for an immediate opening attack and
 * every later cooldown boundary through the configured maximum fight. The
 * extra boundary unit also covers scheduler/combat-tick ordering at the exact
 * wall-clock deadline; unused supplies remain conserved in the private bank.
 */
export function getDuelPreparationAttackSupplyTarget(
  maxFightDurationMs: number,
  attackSpeedTicks: number,
): number {
  if (
    !Number.isSafeInteger(maxFightDurationMs) ||
    maxFightDurationMs <= 0 ||
    !Number.isSafeInteger(attackSpeedTicks) ||
    attackSpeedTicks <= 0
  ) {
    return 0;
  }
  const attackIntervalMs = attackSpeedTicks * COMBAT_CONSTANTS.TICK_DURATION_MS;
  if (!Number.isSafeInteger(attackIntervalMs) || attackIntervalMs <= 0) {
    return 0;
  }
  const target = Math.ceil(maxFightDurationMs / attackIntervalMs) + 1;
  return Number.isSafeInteger(target) && target > 0 ? target : 0;
}

type CurrentInventoryItem = {
  slot: number;
  itemId: string;
  quantity: number;
};

type CurrentEquipmentItem = {
  itemId: string;
  quantity?: number;
};

export type DuelPreparationPlanBuildFailureReason =
  | "plan_invalid"
  | "inventory_capacity_exceeded"
  | "bank_full"
  | "quantity_overflow"
  | "custody_violation";

export type DuelPreparationPlanBuildResult =
  | {
      ok: true;
      committed: DuelPreparationPlanPersistenceSnapshot;
    }
  | {
      ok: false;
      reason: DuelPreparationPlanBuildFailureReason;
    };

export function buildDuelPreparationCommittedSnapshot(input: {
  bank: BankSaveItem[];
  inventory: CurrentInventoryItem[];
  equipment: Record<string, CurrentEquipmentItem>;
  targetInventoryQuantities: ReadonlyMap<string, number>;
  targetEquipment: EquipmentSaveItem[];
  selectedSpell: string | null;
}): DuelPreparationPlanBuildResult {
  const custody = new Map<string, number>();
  const addCustody = (itemId: string, quantity: number): boolean => {
    if (
      !itemId ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > BANKING_CONSTANTS.MAX_ITEM_STACK
    ) {
      return false;
    }
    const total = (custody.get(itemId) ?? 0) + quantity;
    if (
      !Number.isSafeInteger(total) ||
      total > BANKING_CONSTANTS.MAX_ITEM_STACK
    ) {
      return false;
    }
    custody.set(itemId, total);
    return true;
  };
  for (const row of input.bank) {
    if (!addCustody(row.itemId, row.quantity)) {
      return { ok: false, reason: "quantity_overflow" };
    }
  }
  for (const row of input.inventory) {
    if (!addCustody(row.itemId, row.quantity)) {
      return { ok: false, reason: "quantity_overflow" };
    }
  }
  for (const row of Object.values(input.equipment)) {
    if (!addCustody(row.itemId, row.quantity ?? 1)) {
      return { ok: false, reason: "quantity_overflow" };
    }
  }

  const remaining = new Map(custody);
  const consume = (itemId: string, quantity: number): boolean => {
    if (!itemId || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return false;
    }
    const available = remaining.get(itemId) ?? 0;
    if (available < quantity) return false;
    const next = available - quantity;
    if (next > 0) remaining.set(itemId, next);
    else remaining.delete(itemId);
    return true;
  };

  const equipmentSlots = new Set<string>();
  const equipment = input.targetEquipment
    .map((row) => ({ ...row }))
    .sort((left, right) => left.slotType.localeCompare(right.slotType));
  for (const row of equipment) {
    if (
      !row.slotType ||
      equipmentSlots.has(row.slotType) ||
      !consume(row.itemId, row.quantity)
    ) {
      return { ok: false, reason: "custody_violation" };
    }
    equipmentSlots.add(row.slotType);
  }

  type InventoryCandidate = {
    itemId: string;
    quantity: number;
    preferredSlot: number | null;
  };
  const candidates: InventoryCandidate[] = [];
  for (const [itemId, quantity] of [
    ...input.targetInventoryQuantities.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    const item = getItem(itemId);
    if (
      !item ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0 ||
      quantity > BANKING_CONSTANTS.MAX_ITEM_STACK
    ) {
      return { ok: false, reason: "plan_invalid" };
    }
    if (quantity === 0) continue;
    if (!consume(itemId, quantity)) {
      return { ok: false, reason: "custody_violation" };
    }
    const preferredSlots = input.inventory
      .filter((row) => row.itemId === itemId)
      .map((row) => row.slot)
      .filter(
        (slot) =>
          Number.isSafeInteger(slot) &&
          slot >= 0 &&
          slot < INPUT_LIMITS.MAX_INVENTORY_SLOTS,
      )
      .sort((left, right) => left - right);
    if (item.stackable) {
      candidates.push({
        itemId,
        quantity,
        preferredSlot: preferredSlots[0] ?? null,
      });
    } else {
      if (quantity > INPUT_LIMITS.MAX_INVENTORY_SLOTS) {
        return { ok: false, reason: "inventory_capacity_exceeded" };
      }
      for (let index = 0; index < quantity; index += 1) {
        candidates.push({
          itemId,
          quantity: 1,
          preferredSlot: preferredSlots[index] ?? null,
        });
      }
    }
  }
  if (candidates.length > INPUT_LIMITS.MAX_INVENTORY_SLOTS) {
    return { ok: false, reason: "inventory_capacity_exceeded" };
  }

  const usedInventorySlots = new Set<number>();
  for (const candidate of candidates) {
    if (
      candidate.preferredSlot !== null &&
      !usedInventorySlots.has(candidate.preferredSlot)
    ) {
      usedInventorySlots.add(candidate.preferredSlot);
    } else {
      candidate.preferredSlot = null;
    }
  }
  for (const candidate of candidates) {
    if (candidate.preferredSlot !== null) continue;
    let slot = 0;
    while (
      slot < INPUT_LIMITS.MAX_INVENTORY_SLOTS &&
      usedInventorySlots.has(slot)
    ) {
      slot += 1;
    }
    if (slot >= INPUT_LIMITS.MAX_INVENTORY_SLOTS) {
      return { ok: false, reason: "inventory_capacity_exceeded" };
    }
    candidate.preferredSlot = slot;
    usedInventorySlots.add(slot);
  }
  const inventory: InventorySaveItem[] = candidates
    .map((candidate) => ({
      itemId: candidate.itemId,
      quantity: candidate.quantity,
      slotIndex: candidate.preferredSlot!,
      metadata: null,
    }))
    .sort((left, right) => left.slotIndex - right.slotIndex);

  const preferredBankPosition = new Map<
    string,
    { slot: number; tabIndex: number }
  >();
  for (const row of [...input.bank].sort(
    (left, right) => left.tabIndex - right.tabIndex || left.slot - right.slot,
  )) {
    if (!preferredBankPosition.has(row.itemId)) {
      preferredBankPosition.set(row.itemId, {
        slot: row.slot,
        tabIndex: row.tabIndex,
      });
    }
  }
  if (remaining.size > BANKING_CONSTANTS.MAX_BANK_SLOTS) {
    return { ok: false, reason: "bank_full" };
  }
  const usedBankPositions = new Set<string>();
  const bank: BankSaveItem[] = [];
  const pendingBankItems: Array<{ itemId: string; quantity: number }> = [];
  for (const [itemId, quantity] of [...remaining.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (quantity > BANKING_CONSTANTS.MAX_ITEM_STACK) {
      return { ok: false, reason: "quantity_overflow" };
    }
    const preferred = preferredBankPosition.get(itemId);
    const position = preferred
      ? `${preferred.tabIndex}:${preferred.slot}`
      : null;
    if (preferred && position && !usedBankPositions.has(position)) {
      usedBankPositions.add(position);
      bank.push({ itemId, quantity, ...preferred });
    } else {
      pendingBankItems.push({ itemId, quantity });
    }
  }
  for (const item of pendingBankItems) {
    let selected: { slot: number; tabIndex: number } | null = null;
    for (
      let tabIndex = 0;
      tabIndex < BANKING_CONSTANTS.MAX_TABS && !selected;
      tabIndex += 1
    ) {
      for (let slot = 0; slot < BANKING_CONSTANTS.MAX_BANK_SLOTS; slot += 1) {
        const position = `${tabIndex}:${slot}`;
        if (!usedBankPositions.has(position)) {
          selected = { slot, tabIndex };
          usedBankPositions.add(position);
          break;
        }
      }
    }
    if (!selected) return { ok: false, reason: "bank_full" };
    bank.push({ ...item, ...selected });
  }
  bank.sort(
    (left, right) =>
      left.tabIndex - right.tabIndex ||
      left.slot - right.slot ||
      left.itemId.localeCompare(right.itemId),
  );

  return {
    ok: true,
    committed: {
      bank,
      inventory,
      equipment,
      selectedSpell: input.selectedSpell,
    },
  };
}
