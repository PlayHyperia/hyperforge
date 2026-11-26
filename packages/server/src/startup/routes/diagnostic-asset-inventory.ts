import type {
  World,
  CharacterInventorySystem,
  CharacterEquipmentSystem,
} from "@hyperforge/shared";
import { getItem } from "@hyperforge/shared";
import type { DatabaseSystem } from "../../systems/DatabaseSystem/index.js";
import {
  DIAGNOSTIC_ASSET_ITEMS,
  type DiagnosticAssetAction,
} from "./diagnostic-asset-inventory-policy.js";

/** Uses the real inventory debit/return and awaited equipment persistence APIs. */
export async function runDiagnosticAssetInventoryAction(
  world: World,
  request: DiagnosticAssetAction,
  assertStillIsolated: () => void,
) {
  assertStillIsolated();
  const playerId = request.characterId;
  const inventory = world.getSystem<CharacterInventorySystem>("inventory");
  const equipment = world.getSystem<CharacterEquipmentSystem>("equipment");
  const database = world.getSystem<DatabaseSystem>("database");
  if (
    !world.getPlayer(playerId) ||
    !inventory?.isInventoryReady(playerId) ||
    !equipment?.isEquipmentReady(playerId) ||
    !database?.getPool()
  ) {
    throw new Error(
      "Diagnostic player inventory/equipment/database is not ready",
    );
  }
  const ids = Object.keys(DIAGNOSTIC_ASSET_ITEMS) as Array<
    keyof typeof DIAGNOSTIC_ASSET_ITEMS
  >;
  for (const itemId of ids) {
    if (getItem(itemId)?.equipSlot !== DIAGNOSTIC_ASSET_ITEMS[itemId]) {
      throw new Error(`Canonical diagnostic item slot changed: ${itemId}`);
    }
  }
  const snapshot = async () => {
    assertStillIsolated();
    const liveInventory =
      inventory
        .getInventory(playerId)
        ?.items.filter((item) => item.quantity > 0)
        .map(({ slot, itemId, quantity }) => ({ slot, itemId, quantity })) ??
      [];
    const live = equipment.getPlayerEquipment(playerId);
    if (!live) throw new Error("Equipment disappeared");
    const slots = [...new Set(Object.values(DIAGNOSTIC_ASSET_ITEMS))];
    const liveEquipment = slots.map((slot) => ({
      slot,
      itemId: live[slot]?.itemId?.toString() ?? null,
      quantity: live[slot]?.quantity ?? 0,
    }));
    const [savedInventory, savedEquipment] = await Promise.all([
      database.getPlayerInventoryAsync(playerId),
      database.getPlayerEquipmentAsync(playerId),
    ]);
    assertStillIsolated();
    return {
      inventory: liveInventory,
      equipment: liveEquipment,
      persistedInventory: savedInventory.map(
        ({ slotIndex, itemId, quantity }) => ({
          slot: slotIndex,
          itemId,
          quantity,
        }),
      ),
      persistedEquipment: savedEquipment.map(
        ({ slotType, itemId, quantity }) => ({
          slot: slotType,
          itemId,
          quantity,
        }),
      ),
    };
  };
  const before = await snapshot();
  let receipt;
  const seeded: string[] = [];
  if (request.action === "seed") {
    // Add at most one of each fixed item, only when not already owned/worn.
    // This is explicit test-fixture provisioning, not an earned gameplay reward.
    for (const itemId of ids) {
      assertStillIsolated();
      const worn =
        equipment.getPlayerEquipment(playerId)?.[DIAGNOSTIC_ASSET_ITEMS[itemId]]
          ?.itemId;
      if (worn?.toString() === itemId || inventory.hasItem(playerId, itemId, 1))
        continue;
      if (!(await inventory.addItemDirect(playerId, { itemId, quantity: 1 }))) {
        throw new Error(`Diagnostic fixture provisioning rejected: ${itemId}`);
      }
      seeded.push(itemId);
    }
  } else if (request.action === "equip") {
    receipt = await equipment.equipOwnedItem(playerId, request.itemId);
  } else if (request.action === "unequip") {
    const slot = DIAGNOSTIC_ASSET_ITEMS[request.itemId];
    if (
      equipment.getPlayerEquipment(playerId)?.[slot]?.itemId?.toString() !==
      request.itemId
    ) {
      throw new Error("Refusing to unequip a different item");
    }
    receipt = await equipment.unequipOwnedItem(playerId, slot);
  }
  assertStillIsolated();
  const after = await snapshot();
  return {
    scope:
      "Local fixture inventory action; no production visual or readiness approval",
    action: request.action,
    playerId,
    seeded,
    receipt: receipt ?? null,
    before,
    after,
  };
}
