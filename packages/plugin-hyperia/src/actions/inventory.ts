/**
 * Inventory actions - EQUIP_ITEM, USE_ITEM, DROP_ITEM, PICKUP_ITEM
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { HyperiaService } from "../services/HyperiaService.js";
import type {
  EquipItemCommand,
  UseItemCommand,
  Equipment,
  Entity,
  InventoryItem,
} from "../types.js";
import { getItemName } from "../utils/item-detection.js";

// Max distance to pick up items
const MAX_PICKUP_DISTANCE = 4;

// Max items to drop in a single "drop all" operation (prevents memory leak / DoS)
const MAX_DROP_ALL_ITEMS = 50;

// Delay between drops in milliseconds
const DROP_DELAY_MS = 150;

/**
 * Calculate 2D distance between player and entity
 */
function getEntityDistance(
  playerPos: unknown,
  entityPos: unknown,
): number | null {
  let px: number, pz: number;
  if (Array.isArray(playerPos) && playerPos.length >= 3) {
    px = playerPos[0];
    pz = playerPos[2];
  } else if (playerPos && typeof playerPos === "object" && "x" in playerPos) {
    const pos = playerPos as { x: number; z: number };
    px = pos.x;
    pz = pos.z;
  } else {
    return null;
  }

  let ex: number, ez: number;
  if (Array.isArray(entityPos) && entityPos.length >= 3) {
    ex = entityPos[0];
    ez = entityPos[2];
  } else if (entityPos && typeof entityPos === "object" && "x" in entityPos) {
    const pos = entityPos as { x: number; z: number };
    ex = pos.x;
    ez = pos.z;
  } else {
    return null;
  }

  const dx = px - ex;
  const dz = pz - ez;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Check if an entity is a ground item
 */
function isGroundItem(e: Entity): boolean {
  const entityType = (e.type || "").toLowerCase();
  return entityType === "item" || entityType === "grounditem";
}

export const equipItemAction: Action = {
  name: "EQUIP_ITEM",
  similes: ["EQUIP", "WIELD", "WEAR"],
  description: "Equip a weapon or armor from inventory.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) return false;
    const playerEntity = service.getPlayerEntity();

    return service.isConnected() && (playerEntity?.items?.length ?? 0) > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }
      const playerEntity = service.getPlayerEntity();
      const content = message.content.text || "";
      const searchTerm = content.toLowerCase();

      // Find item using centralized item name detection (handles name, itemId, etc.)
      const item = playerEntity?.items.find((i) => {
        const itemName = getItemName(i);
        return itemName.includes(searchTerm);
      });

      // If no specific item requested, find first equippable item (weapon-like)
      const equippableItem =
        item ||
        playerEntity?.items.find((i) => {
          const itemName = getItemName(i);
          return (
            itemName.includes("hatchet") ||
            itemName.includes("pickaxe") ||
            itemName.includes("shortsword") ||
            itemName.includes("longsword") ||
            itemName.includes("2h sword") ||
            itemName.includes("2h_sword") ||
            itemName.includes("scimitar") ||
            itemName.includes("dagger") ||
            itemName.includes("shortbow") ||
            itemName.includes("longbow") ||
            itemName.includes("staff")
          );
        });

      if (!equippableItem) {
        await callback?.({
          text: "No equippable item found in inventory.",
          error: true,
        });
        return { success: false };
      }

      // Get the item name for display and slot detection
      const itemName = getItemName(equippableItem);
      const itemDisplayName =
        equippableItem.name || equippableItem.itemId || itemName;

      // Get the item ID to send to server - prefer itemId (server format) over id (legacy)
      // Server expects itemId (e.g., "bronze_hatchet"), not the unique instance ID
      let serverItemId: string | undefined;

      if (
        typeof equippableItem.itemId === "string" &&
        equippableItem.itemId.length > 0
      ) {
        serverItemId = equippableItem.itemId;
      } else if (
        typeof equippableItem.id === "string" &&
        equippableItem.id.length > 0
      ) {
        serverItemId = equippableItem.id;
      }

      if (!serverItemId) {
        logger.warn("[EQUIP_ITEM] Could not determine item ID for equipping");
        await callback?.({
          text: "Could not get item ID for equipping.",
          error: true,
        });
        return { success: false };
      }

      // Determine equip slot based on item name
      let equipSlot: keyof Equipment = "weapon";
      if (itemName.includes("shield")) equipSlot = "shield";
      else if (itemName.includes("helmet")) equipSlot = "helmet";
      else if (itemName.includes("body") || itemName.includes("platebody"))
        equipSlot = "body";
      else if (itemName.includes("legs")) equipSlot = "legs";
      else if (itemName.includes("boots")) equipSlot = "boots";

      const command: EquipItemCommand = { itemId: serverItemId, equipSlot };
      await service.executeEquipItem(command);

      await callback?.({
        text: `Equipped ${itemDisplayName}`,
        action: "EQUIP_ITEM",
      });

      return { success: true, text: `Equipped ${itemDisplayName}` };
    } catch (error) {
      await callback?.({
        text: `Failed to equip: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Equip bronze sword" } },
      {
        name: "agent",
        content: { text: "Equipped Bronze Sword", action: "EQUIP_ITEM" },
      },
    ],
  ],
};

export const useItemAction: Action = {
  name: "USE_ITEM",
  similes: ["EAT", "DRINK", "CONSUME"],
  description: "Use an item from inventory (eat food, drink potion, etc.).",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) return false;
    const playerEntity = service.getPlayerEntity();

    return service.isConnected() && (playerEntity?.items?.length ?? 0) > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }
      const playerEntity = service.getPlayerEntity();
      const content = message.content.text || "";

      const item = playerEntity?.items.find((i) =>
        i.name?.toLowerCase().includes(content.toLowerCase()),
      );

      if (!item) {
        await callback?.({ text: "Item not found in inventory.", error: true });
        return { success: false };
      }

      const command: UseItemCommand = { itemId: item.id };
      await service.executeUseItem(command);

      await callback?.({ text: `Used ${item.name}`, action: "USE_ITEM" });

      return { success: true, text: `Used ${item.name}` };
    } catch (error) {
      await callback?.({
        text: `Failed to use item: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Eat the bread" } },
      { name: "agent", content: { text: "Used Bread", action: "USE_ITEM" } },
    ],
  ],
};

export const dropItemAction: Action = {
  name: "DROP_ITEM",
  similes: ["DROP", "DISCARD", "THROW_AWAY", "TRASH", "REMOVE"],
  description: "Drop an item from inventory onto the ground.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) {
      logger.debug("[DROP_ITEM] Validation failed: no service");
      return false;
    }

    if (!service.isConnected()) {
      logger.debug("[DROP_ITEM] Validation failed: not connected");
      return false;
    }

    const playerEntity = service.getPlayerEntity();
    if (!playerEntity || playerEntity.alive === false) {
      logger.debug("[DROP_ITEM] Validation failed: player not alive");
      return false;
    }

    if (playerEntity.inCombat) {
      logger.debug("[DROP_ITEM] Validation failed: player in combat");
      return false;
    }

    const hasItems = (playerEntity.items?.length ?? 0) > 0;
    logger.info(
      `[DROP_ITEM] Validation: ${playerEntity.items?.length ?? 0} items in inventory`,
    );
    return hasItems;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }
      const playerEntity = service.getPlayerEntity();
      const content = (message.content.text || "").toLowerCase();

      if (!playerEntity?.items || playerEntity.items.length === 0) {
        await callback?.({
          text: "No items in inventory to drop.",
          error: true,
        });
        return { success: false };
      }

      // Helper to get item name - server sends items with nested `item` property
      // Structure: { slot, itemId, quantity, item: { id, name, type, ... } }
      const getItemName = (i: InventoryItem): string | null => {
        // Check for nested item.name (server format)
        if (i.item && typeof i.item === "object") {
          if (i.item.name && typeof i.item.name === "string") {
            return i.item.name;
          }
        }
        // Check for direct name (legacy format)
        if (i.name && typeof i.name === "string") {
          return i.name;
        }
        return null;
      };

      // Helper to get item ID
      const getItemId = (i: InventoryItem): string | null => {
        // Check for itemId (server format)
        if (i.itemId && typeof i.itemId === "string") {
          return i.itemId;
        }
        // Check for direct id (legacy format)
        if (i.id && typeof i.id === "string") {
          return i.id;
        }
        return null;
      };

      // Helper to get item quantity
      const getItemQuantity = (i: InventoryItem): number => {
        if (typeof i.quantity === "number") {
          return i.quantity;
        }
        return 1;
      };

      // Helper to get inventory slot number (needed for dropping specific instances of same item)
      const getItemSlot = (i: InventoryItem): number | undefined => {
        if (typeof i.slot === "number") {
          return i.slot;
        }
        return undefined;
      };

      // Filter out items without names
      const validItems = playerEntity.items.filter((i) => i && getItemName(i));

      logger.info(
        `[DROP_ITEM] Found ${validItems.length} valid items with names out of ${playerEntity.items?.length ?? 0} total`,
      );

      if (validItems.length === 0) {
        // Log the first item's structure for debugging
        if ((playerEntity.items?.length ?? 0) > 0) {
          logger.info(
            `[DROP_ITEM] First item structure: ${JSON.stringify(playerEntity.items[0])}`,
          );
        }
        await callback?.({
          text: "No valid items in inventory to drop.",
          error: true,
        });
        return { success: false };
      }

      // Helper to escape regex special characters for word boundary matching
      const escapeRegexDrop = (str: string) =>
        str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Check if user wants to drop ALL items
      const isDropAll =
        content.includes("all") ||
        content.includes("everything") ||
        content.includes("every item");

      // Check if it's "drop all <item type>" vs "drop all items/everything"
      const isDropAllOfType =
        isDropAll &&
        !content.includes("items") &&
        !content.includes("everything") &&
        !content.includes("every item") &&
        !content.includes("inventory");

      if (isDropAll) {
        let itemsToDrop: InventoryItem[];

        if (isDropAllOfType) {
          // "drop all logs" - find all items matching a specific type
          // Uses word boundary matching to prevent false matches
          itemsToDrop = validItems.filter((i) => {
            const itemName = getItemName(i)?.toLowerCase();
            if (!itemName) return false;
            // Check if message contains the item name (with word boundaries)
            const nameRegex = new RegExp(
              `\\b${escapeRegexDrop(itemName)}\\b`,
              "i",
            );
            if (nameRegex.test(content)) return true;
            // Also check individual words from item name
            const itemWords = itemName.split(/\s+/);
            return itemWords.some((word) => {
              if (word.length <= 3) return false;
              const wordRegex = new RegExp(
                `\\b${escapeRegexDrop(word)}\\b`,
                "i",
              );
              return wordRegex.test(content);
            });
          });

          if (itemsToDrop.length === 0) {
            const itemList = validItems
              .map((i) => getItemName(i))
              .filter(Boolean)
              .join(", ");
            await callback?.({
              text: `No matching items found. Available: ${itemList}`,
              error: true,
            });
            return { success: false };
          }
        } else {
          // "drop all items" / "drop everything" - drop ALL items
          itemsToDrop = validItems;
        }

        // Limit items to prevent memory leak / DoS
        const limitedItems = itemsToDrop.slice(0, MAX_DROP_ALL_ITEMS);
        const wasLimited = itemsToDrop.length > MAX_DROP_ALL_ITEMS;

        logger.info(
          `[DROP_ITEM] Dropping ${limitedItems.length} items (drop all)${wasLimited ? ` - limited from ${itemsToDrop.length}` : ""}`,
        );

        const droppedNames: string[] = [];
        let failedCount = 0;
        const MAX_CONSECUTIVE_FAILURES = 3; // Stop if too many failures in a row
        let consecutiveFailures = 0;

        for (const item of limitedItems) {
          // Early termination on too many consecutive failures
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.warn(
              `[DROP_ITEM] Stopping drop-all after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
            );
            break;
          }

          const itemId = getItemId(item);
          const itemName = getItemName(item);
          const quantity = getItemQuantity(item);
          const slot = getItemSlot(item);

          if (itemId) {
            try {
              logger.info(
                `[DROP_ITEM] Dropping ${itemName} (id=${itemId}, qty=${quantity}, slot=${slot})`,
              );
              const receipt = await service.executeDropItem(
                itemId,
                quantity,
                slot,
              );
              if (receipt.success) {
                droppedNames.push(itemName || itemId);
                consecutiveFailures = 0; // Reset on success
              } else {
                throw new Error(receipt.reason);
              }
            } catch (dropError) {
              logger.warn(
                `[DROP_ITEM] Failed to drop ${itemName}: ${dropError instanceof Error ? dropError.message : String(dropError)}`,
              );
              failedCount++;
              consecutiveFailures++;
            }
            // Small delay between drops to avoid server issues
            await new Promise((resolve) => setTimeout(resolve, DROP_DELAY_MS));
          }
        }

        const stoppedEarly =
          droppedNames.length + failedCount < limitedItems.length;
        const allRequestedDropsCommitted =
          failedCount === 0 &&
          !wasLimited &&
          !stoppedEarly &&
          droppedNames.length === itemsToDrop.length;
        const committedSummary =
          droppedNames.length === 0
            ? "No items were dropped"
            : droppedNames.length <= 3
              ? `Dropped ${droppedNames.join(", ")}`
              : `Dropped ${droppedNames.length} items`;
        const details = [
          failedCount > 0 ? `${failedCount} failed` : null,
          stoppedEarly ? "stopped after repeated failures" : null,
          wasLimited ? `limited to ${MAX_DROP_ALL_ITEMS}` : null,
        ].filter((detail): detail is string => detail !== null);
        const summary = `${committedSummary}${details.length > 0 ? ` (${details.join("; ")})` : ""}`;

        await callback?.({
          text: summary,
          ...(allRequestedDropsCommitted
            ? { action: "DROP_ITEM" }
            : { error: true }),
        });
        logger.info(
          `[DROP_ITEM] Dropped ${droppedNames.length} items, ${failedCount} failed: ${droppedNames.join(", ")}`,
        );

        return { success: allRequestedDropsCommitted, text: summary };
      }

      // Single item drop - try to find item matching the user's description
      // Uses word boundary matching to prevent false matches
      const matchedItem = validItems.find((i) => {
        const itemName = getItemName(i)?.toLowerCase();
        if (!itemName) return false;
        // Check if message contains the item name (with word boundaries)
        const nameRegex = new RegExp(`\\b${escapeRegexDrop(itemName)}\\b`, "i");
        if (nameRegex.test(content)) return true;
        // Also check individual words from item name (e.g., "hatchet" from "Bronze Hatchet")
        const itemWords = itemName.split(/\s+/);
        return itemWords.some((word) => {
          if (word.length <= 3) return false;
          const wordRegex = new RegExp(`\\b${escapeRegexDrop(word)}\\b`, "i");
          return wordRegex.test(content);
        });
      });

      if (!matchedItem) {
        // List available items for the user
        const itemList = validItems
          .map((i) => getItemName(i))
          .filter(Boolean)
          .join(", ");
        await callback?.({
          text: `Item not found in inventory. Available items: ${itemList}`,
          error: true,
        });
        return { success: false };
      }

      const itemId = getItemId(matchedItem);
      const itemName = getItemName(matchedItem);
      const slot = getItemSlot(matchedItem);

      if (!itemId) {
        await callback?.({ text: "Could not get item ID.", error: true });
        return { success: false };
      }

      logger.info(
        `[DROP_ITEM] Dropping item: ${itemName} (id=${itemId}, slot=${slot})`,
      );

      const receipt = await service.executeDropItem(itemId, 1, slot);
      if (!receipt.success) {
        throw new Error(receipt.reason);
      }

      await callback?.({ text: `Dropped ${itemName}`, action: "DROP_ITEM" });

      logger.info(`[DROP_ITEM] Dropped ${itemName}`);

      return { success: true, text: `Dropped ${itemName}` };
    } catch (error) {
      logger.error(
        `[DROP_ITEM] Error: ${error instanceof Error ? error.message : error}`,
      );
      await callback?.({
        text: `Failed to drop: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Drop the bronze hatchet" } },
      {
        name: "agent",
        content: { text: "Dropped Bronze Hatchet", action: "DROP_ITEM" },
      },
    ],
    [
      { name: "user", content: { text: "Discard the junk" } },
      { name: "agent", content: { text: "Dropped Junk", action: "DROP_ITEM" } },
    ],
    [
      { name: "user", content: { text: "Drop all logs" } },
      {
        name: "agent",
        content: { text: "Dropped Logs, Logs, Logs", action: "DROP_ITEM" },
      },
    ],
    [
      { name: "user", content: { text: "Drop everything" } },
      {
        name: "agent",
        content: { text: "Dropped 10 items", action: "DROP_ITEM" },
      },
    ],
    [
      { name: "user", content: { text: "Drop all items" } },
      {
        name: "agent",
        content: { text: "Dropped 5 items", action: "DROP_ITEM" },
      },
    ],
  ],
};

/**
 * PICKUP_ITEM - Pick up an item from the ground
 */
export const pickupItemAction: Action = {
  name: "PICKUP_ITEM",
  similes: ["PICKUP", "PICK_UP", "GRAB", "TAKE", "LOOT", "GET"],
  description: "Pick up an item from the ground nearby.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) {
      logger.debug("[PICKUP_ITEM] Validation failed: no service");
      return false;
    }

    if (!service.isConnected()) {
      logger.debug("[PICKUP_ITEM] Validation failed: not connected");
      return false;
    }

    const player = service.getPlayerEntity();
    if (!player || player.alive === false) {
      logger.debug("[PICKUP_ITEM] Validation failed: player not alive");
      return false;
    }

    // Check for ground items within approach range (20m)
    const entities = service.getNearbyEntities() || [];
    const playerPos = player.position;
    const groundItems = entities.filter((e) => {
      if (!isGroundItem(e)) return false;
      const entityPos = e.position;
      if (!entityPos) return false;
      const dist = getEntityDistance(playerPos, entityPos);
      return dist !== null && dist <= 20;
    });

    logger.info(
      `[PICKUP_ITEM] Validation: ${groundItems.length} ground items within 20m`,
    );

    return groundItems.length > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }

      const entities = service.getNearbyEntities() || [];
      const player = service.getPlayerEntity();
      const playerPos = player?.position;
      const content = (message.content.text || "").toLowerCase();

      // Find all ground items
      const groundItems = entities.filter(isGroundItem);

      // Get items with distance, sorted by nearest
      const itemsWithDistance = groundItems
        .map((e) => {
          const entityPos = e.position;
          const dist = entityPos
            ? getEntityDistance(playerPos, entityPos)
            : null;
          return { entity: e, distance: dist, position: entityPos };
        })
        .filter((t) => t.distance !== null)
        .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));

      // Try to find item matching the user's description using a scoring system
      // Higher score = better match. We prioritize items that match more words from the user's request
      // Uses word boundary checks to prevent false matches (e.g., "log" in "dialogue")
      const scoreItem = (item: { entity: Entity }) => {
        const itemName = (item.entity.name ?? "").toLowerCase();
        const itemWords = itemName.split(/\s+/);
        const contentWords = content.split(/\s+/).filter((w) => w.length > 2);

        // Perfect match - item name is exactly in the content (with word boundaries)
        const exactNameRegex = new RegExp(
          `\\b${escapeRegex(itemName)}\\b`,
          "i",
        );
        if (exactNameRegex.test(content)) return 100;

        // Score based on how many item words are in the content
        let score = 0;
        for (const itemWord of itemWords) {
          if (itemWord.length <= 3) continue; // Skip short words like "of", "the"

          // Word boundary check - prevents "log" matching in "dialogue"
          const wordBoundaryRegex = new RegExp(
            `\\b${escapeRegex(itemWord)}\\b`,
            "i",
          );
          if (wordBoundaryRegex.test(content)) {
            score += 10; // Each matching word adds 10 points
          }

          // Also check if any content word matches (exact word match)
          for (const contentWord of contentWords) {
            if (contentWord === itemWord) {
              score += 5; // Exact word match bonus
            }
          }
        }

        return score;
      };

      // Helper to escape regex special characters
      const escapeRegex = (str: string) =>
        str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Score all items and find the best match
      const scoredItems = itemsWithDistance.map((item) => ({
        ...item,
        score: scoreItem(item),
      }));

      // Sort by score (highest first), then by distance (nearest first)
      scoredItems.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.distance ?? 999) - (b.distance ?? 999);
      });

      // Get the best matching item (score > 0 means at least one word matched)
      let targetItem = scoredItems.find((item) => item.score > 0);

      // If no match by name, pick the nearest item
      if (!targetItem && scoredItems.length > 0) {
        targetItem = scoredItems[0];
        logger.info(
          `[PICKUP_ITEM] No item matching in "${content}", picking nearest: ${targetItem.entity.name}`,
        );
      }

      // Log the matching for debugging
      if (targetItem && targetItem.score > 0) {
        logger.info(
          `[PICKUP_ITEM] Best match: "${targetItem.entity.name}" (score=${targetItem.score}) for request "${content}"`,
        );
      }

      if (!targetItem) {
        await callback?.({
          text: "No items found nearby to pick up.",
          error: true,
        });
        return { success: false };
      }

      const item = targetItem.entity;
      const itemDistance = targetItem.distance ?? 0;

      logger.info(
        `[PICKUP_ITEM] Found item: ${item.name} (${item.id}) at distance ${itemDistance.toFixed(1)}m`,
      );

      // If too far, walk to it first
      if (itemDistance > MAX_PICKUP_DISTANCE) {
        const itemPos = targetItem.position as
          [number, number, number] | { x: number; y: number; z: number };

        let itemX: number, itemY: number, itemZ: number;
        if (Array.isArray(itemPos)) {
          [itemX, itemY, itemZ] = itemPos as [number, number, number];
        } else if (itemPos && typeof itemPos === "object" && "x" in itemPos) {
          itemX = itemPos.x;
          itemY = itemPos.y;
          itemZ = itemPos.z;
        } else {
          await callback?.({
            text: "Could not locate item position.",
            error: true,
          });
          return { success: false };
        }

        // Max move distance allowed by server (200 tiles, use 150 for safety)
        const MAX_MOVE_DISTANCE = 150;

        let targetPos: [number, number, number];
        let responseText: string;

        if (itemDistance > MAX_MOVE_DISTANCE) {
          // Move in steps - calculate intermediate waypoint
          let px: number, pz: number;
          if (Array.isArray(playerPos) && playerPos.length >= 3) {
            px = playerPos[0];
            pz = playerPos[2];
          } else if (
            playerPos &&
            typeof playerPos === "object" &&
            "x" in playerPos &&
            "z" in playerPos
          ) {
            px = Number((playerPos as Record<string, unknown>).x);
            pz = Number((playerPos as Record<string, unknown>).z);
          } else {
            await callback?.({
              text: "Could not get player position.",
              error: true,
            });
            return { success: false };
          }

          const dx = itemX - px;
          const dz = itemZ - pz;
          const ratio = MAX_MOVE_DISTANCE / itemDistance;
          const stepX = px + dx * ratio;
          const stepZ = pz + dz * ratio;

          targetPos = [stepX, itemY, stepZ];
          responseText = `Walking towards ${item.name} (${Math.round(itemDistance - MAX_MOVE_DISTANCE)}m remaining)...`;

          logger.info(
            `[PICKUP_ITEM] Distance ${itemDistance.toFixed(0)}m exceeds max ${MAX_MOVE_DISTANCE}, moving to intermediate point`,
          );
        } else {
          targetPos = [itemX, itemY, itemZ];
          responseText = `Walking to pick up ${item.name}...`;
        }

        logger.info(
          `[PICKUP_ITEM] Walking to ${item.name} at ${JSON.stringify(targetPos)}`,
        );

        await service.executeMove({ target: targetPos, runMode: false });

        // If we were walking directly to the item (not an intermediate waypoint), try to pick it up after arriving
        if (itemDistance <= MAX_MOVE_DISTANCE) {
          // Wait a moment for movement to complete
          await new Promise((r) => setTimeout(r, 2000));

          const newPlayerPos = service.getPlayerEntity()?.position;
          if (newPlayerPos) {
            const newDist = getEntityDistance(newPlayerPos, itemPos);
            if (newDist !== null && newDist <= MAX_PICKUP_DISTANCE * 1.5) {
              await service.executePickupItem(item.id);
              await callback?.({
                text: `Walked to and picked up ${item.name}`,
                action: "PICKUP_ITEM",
              });
              logger.info(
                `[PICKUP_ITEM] Auto-picked up ${item.name} after walking`,
              );
              return {
                success: true,
                text: `Walked to and picked up ${item.name}`,
              };
            }
          }
        }

        await callback?.({
          text: responseText,
          action: "PICKUP_ITEM",
        });
        return { success: true, text: responseText };
      }

      // Close enough - pick it up
      await service.executePickupItem(item.id);

      await callback?.({
        text: `Picked up ${item.name}`,
        action: "PICKUP_ITEM",
      });

      logger.info(`[PICKUP_ITEM] Picked up ${item.name}`);

      return { success: true, text: `Picked up ${item.name}` };
    } catch (error) {
      logger.error(
        `[PICKUP_ITEM] Error: ${error instanceof Error ? error.message : error}`,
      );
      await callback?.({
        text: `Failed to pick up: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Pick up the bronze hatchet" } },
      {
        name: "agent",
        content: { text: "Picked up Bronze Hatchet", action: "PICKUP_ITEM" },
      },
    ],
    [
      { name: "user", content: { text: "Grab that sword" } },
      {
        name: "agent",
        content: {
          text: "Walking to pick up Bronze Sword...",
          action: "PICKUP_ITEM",
        },
      },
    ],
    [
      { name: "user", content: { text: "Loot the coins" } },
      {
        name: "agent",
        content: { text: "Picked up Coins", action: "PICKUP_ITEM" },
      },
    ],
  ],
};

// Max distance to loot gravestone
const MAX_GRAVESTONE_DISTANCE = 4;

/**
 * LOOT_GRAVESTONE - Loot all items from the player's own gravestone after death
 */
export const lootGravestoneAction: Action = {
  name: "LOOT_GRAVESTONE",
  similes: ["LOOT_GRAVE", "RECOVER_ITEMS", "GET_GRAVESTONE"],
  description:
    "Loot all items from your gravestone after dying. Walk to it if needed.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) return false;

    if (!service.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player || player.alive === false) return false;

    const playerId = player.id;
    if (!playerId) return false;

    // Check for nearby gravestone matching this player
    const entities = service.getNearbyEntities() || [];
    return entities.some((e) => {
      const id = e.id || "";
      const name = (e.name || "").toLowerCase();
      return (
        (id.includes("gravestone") && id.includes(playerId)) ||
        (name.includes("gravestone") && name.includes(playerId))
      );
    });
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }

      const player = service.getPlayerEntity();
      const playerId = player?.id;
      if (!player || !playerId) {
        await callback?.({ text: "Player not available.", error: true });
        return { success: false };
      }

      const entities = service.getNearbyEntities() || [];
      const gravestone = entities.find((e) => {
        const id = e.id || "";
        const name = (e.name || "").toLowerCase();
        return (
          (id.includes("gravestone") && id.includes(playerId)) ||
          (name.includes("gravestone") && name.includes(playerId))
        );
      });

      if (!gravestone) {
        await callback?.({
          text: "No gravestone found nearby.",
          error: true,
        });
        return { success: false };
      }

      // Calculate distance
      const dist = getEntityDistance(player.position, gravestone.position);

      // If too far, walk to it first
      if (dist !== null && dist > MAX_GRAVESTONE_DISTANCE) {
        const gravePos = gravestone.position as
          [number, number, number] | { x: number; y: number; z: number };

        let targetPos: [number, number, number];
        if (Array.isArray(gravePos)) {
          targetPos = [gravePos[0], gravePos[1], gravePos[2]];
        } else if (
          gravePos &&
          typeof gravePos === "object" &&
          "x" in gravePos
        ) {
          targetPos = [gravePos.x, gravePos.y, gravePos.z];
        } else {
          await callback?.({
            text: "Could not locate gravestone position.",
            error: true,
          });
          return { success: false };
        }

        logger.info(
          `[LOOT_GRAVESTONE] Walking to gravestone at distance ${dist.toFixed(1)}m`,
        );
        await service.executeMove({ target: targetPos, runMode: true });
        await callback?.({
          text: "Running to gravestone to recover items...",
          action: "LOOT_GRAVESTONE",
        });
        return { success: true, text: "Running to gravestone..." };
      }

      // Close enough — loot it
      logger.info(`[LOOT_GRAVESTONE] Looting gravestone ${gravestone.id}`);
      await service.lootGravestone(gravestone.id);

      await callback?.({
        text: "Looted all items from gravestone!",
        action: "LOOT_GRAVESTONE",
      });

      return { success: true, text: "Recovered items from gravestone" };
    } catch (error) {
      logger.error(
        `[LOOT_GRAVESTONE] Error: ${error instanceof Error ? error.message : error}`,
      );
      await callback?.({
        text: `Failed to loot gravestone: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Loot my gravestone" } },
      {
        name: "agent",
        content: {
          text: "Looted all items from gravestone!",
          action: "LOOT_GRAVESTONE",
        },
      },
    ],
  ],
};
