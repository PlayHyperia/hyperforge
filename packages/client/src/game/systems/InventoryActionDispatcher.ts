/**
 * Centralized inventory action dispatching.
 * Eliminates duplication between context menu and left-click handlers.
 *
 * This dispatcher is the single source of truth for handling inventory actions.
 * Both context menu selections and left-click primary actions route through here.
 *
 * Supports optimistic updates for eat/drink/drop actions: the UI item is removed
 * immediately and the network request is sent in parallel. The server's authoritative
 * inventoryUpdated response replaces the local cache regardless, so explicit rollback
 * is rarely needed — only on timeout (5 s without server response).
 */

import {
  EventType,
  uuid,
  getItem,
  type Item,
  type ClientNetwork,
} from "@hyperforge/shared";
import type { ClientWorld } from "../../types";

export interface InventoryActionContext {
  world: ClientWorld;
  itemId: string;
  slot: number;
  quantity?: number;
}

export interface ActionResult {
  success: boolean;
  message?: string;
  operationId?: string;
}

/** Actions that are intentionally no-ops (don't warn) */
const SILENT_ACTIONS = new Set(["cancel"]);

/**
 * Dispatch an inventory action to the appropriate handler.
 * Single source of truth for action handling.
 *
 * @param action - The action ID (e.g., "eat", "wield", "drop")
 * @param ctx - Context containing world, itemId, slot, and optional quantity
 * @returns ActionResult indicating success/failure
 */
export function dispatchInventoryAction(
  action: string,
  ctx: InventoryActionContext,
): ActionResult {
  const { world, itemId, slot, quantity = 1 } = ctx;
  const localPlayer = world.getPlayer();

  if (!localPlayer) {
    return { success: false, message: "No local player" };
  }

  const network = world.network as ClientNetwork | null;

  switch (action) {
    case "eat":
    case "drink":
    case "bury": {
      // Optimistic: remove the item from UI immediately (ClientNetwork
      // handles snapshot + rollback tracking internally)
      network?.applyOptimisticRemoval(localPlayer.id, slot, 1);
      // Send to server — server handles validation, consumption, and effects
      // Server flow: useItem → INVENTORY_USE → InventorySystem → ITEM_USED → PlayerSystem
      world.network?.send("useItem", { itemId, slot });
      return { success: true };
    }

    case "wield":
    case "wear":
      world.network?.send("equipItem", {
        playerId: localPlayer.id,
        itemId,
        inventorySlot: slot,
      });
      return { success: true };

    case "drop": {
      if (!network?.dropItem) {
        return {
          success: false,
          message: "Authoritative item dropping is unavailable",
        };
      }
      try {
        // ClientNetwork binds the intent to a secure durable identity before
        // sending. Only after that succeeds may the UI hide the local item.
        const operationId = network.dropItem(itemId, slot, quantity);
        network.applyOptimisticRemoval(localPlayer.id, slot, quantity);
        return { success: true, operationId };
      } catch {
        return {
          success: false,
          message: "Could not create an authoritative drop operation",
        };
      }
    }

    case "examine": {
      const itemData = getItem(itemId);
      const examineText = itemData?.examine || `It's a ${itemId}.`;

      world.emit(EventType.UI_TOAST, {
        message: examineText,
        type: "info",
      });

      if (world.chat?.add) {
        world.chat.add({
          id: uuid(),
          from: "",
          body: examineText,
          createdAt: new Date().toISOString(),
          timestamp: Date.now(),
        });
      }
      return { success: true };
    }

    case "use":
      world.emit(EventType.ITEM_ACTION_SELECTED, {
        playerId: localPlayer.id,
        actionId: "use",
        itemId,
        slot,
      });
      return { success: true };

    case "rub": {
      // Handle XP lamp usage - check if item has useEffect with type "xp_lamp"
      const lampData = getItem(itemId) as Item & {
        useEffect?: { type: string; xpAmount: number };
      };
      if (lampData?.useEffect?.type === "xp_lamp") {
        // Emit event to open skill selection modal
        world.emit(EventType.XP_LAMP_USE_REQUEST, {
          playerId: localPlayer.id,
          itemId,
          slot,
          xpAmount: lampData.useEffect.xpAmount,
        });
        return { success: true };
      }
      // Fall through to default if not an XP lamp
      console.warn(
        `[InventoryActionDispatcher] Rub action on non-lamp item: ${itemId}`,
      );
      return { success: false, message: "Cannot rub this item" };
    }

    case "cancel":
      // Intentional no-op - menu already closed by EntityContextMenu
      return { success: true };

    default:
      // Only warn for truly unhandled actions, not intentional no-ops
      if (!SILENT_ACTIONS.has(action)) {
        console.warn(
          `[InventoryActionDispatcher] Unhandled action: "${action}" for item "${itemId}". ` +
            `Check inventoryActions in item manifest.`,
        );
      }
      return { success: false, message: `Unhandled action: ${action}` };
  }
}
