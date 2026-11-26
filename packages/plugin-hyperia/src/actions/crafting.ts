/**
 * Crafting actions for ElizaOS agents
 *
 * SMELT_ORE - Smelt ore into bars at a furnace
 * SMITH_ITEM - Smith bars into weapons/armor at an anvil
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
import type { Entity } from "../types.js";
import {
  hasOre,
  hasBars,
  hasLogs,
  hasKnife,
  hasHides,
  hasEssence,
} from "../utils/item-detection.js";

function getDistance2D(
  posA: [number, number, number] | null | undefined,
  posB: [number, number, number] | null | undefined,
): number | null {
  if (!posA || !posB) return null;
  const dx = posA[0] - posB[0];
  const dz = posA[2] - posB[2];
  return Math.sqrt(dx * dx + dz * dz);
}

function getTileDistance(
  posA: [number, number, number] | null | undefined,
  posB: [number, number, number] | null | undefined,
): number | null {
  if (!posA || !posB) return null;
  return Math.max(Math.abs(posA[0] - posB[0]), Math.abs(posA[2] - posB[2]));
}

const WORKSTATION_MOVE_POLL_MS = 200;
const WORKSTATION_MOVE_MIN_TIMEOUT_MS = 5_000;
const WORKSTATION_MOVE_MAX_TIMEOUT_MS = 30_000;

async function moveIntoWorkstationRange(
  service: HyperiaService,
  target: Entity,
  interactionRange: number,
): Promise<boolean> {
  const initialPlayer = service.getPlayerEntity();
  const initialDistance = getTileDistance(
    initialPlayer?.position,
    target.position,
  );
  if (initialDistance === null) return false;
  if (initialDistance <= interactionRange) return true;

  const timeoutMs = Math.min(
    WORKSTATION_MOVE_MAX_TIMEOUT_MS,
    Math.max(
      WORKSTATION_MOVE_MIN_TIMEOUT_MS,
      Math.ceil(initialDistance * 800 + 2_000),
    ),
  );
  await service.executeMove({ target: target.position, runMode: true });
  const deadline = Date.now() + timeoutMs;
  while (service.isConnected() && Date.now() <= deadline) {
    const player = service.getPlayerEntity();
    const currentTarget = service
      .getNearbyEntities()
      .find((entity) => entity.id === target.id);
    if (!currentTarget) return false;
    const distance = getTileDistance(player?.position, currentTarget.position);
    if (distance !== null && distance <= interactionRange) return true;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, WORKSTATION_MOVE_POLL_MS),
    );
  }
  return false;
}

function isFurnace(entity: Entity): boolean {
  const type = (entity.type || "").toLowerCase();
  const entityType = (entity.entityType || "").toLowerCase();
  return type === "furnace" || entityType === "furnace";
}

function isAnvil(entity: Entity): boolean {
  const type = (entity.type || "").toLowerCase();
  const entityType = (entity.entityType || "").toLowerCase();
  return type === "anvil" || entityType === "anvil";
}

function findNearestEntity(
  entities: Entity[],
  playerPos: [number, number, number],
  filter: (e: Entity) => boolean,
): Entity | null {
  let nearest: Entity | null = null;
  let nearestDist = Infinity;

  for (const entity of entities) {
    if (!filter(entity)) continue;
    const dist = getDistance2D(playerPos, entity.position);
    if (dist !== null && dist < nearestDist) {
      nearest = entity;
      nearestDist = dist;
    }
  }

  return nearest;
}

function getSmeltableBar(
  items: Array<{ name?: string; itemId?: string }>,
): string | null {
  const itemNames = items.map((i) => (i.name || i.itemId || "").toLowerCase());
  const hasCopper = itemNames.some((n) => n.includes("copper"));
  const hasTin = itemNames.some((n) => n.includes("tin"));
  const hasIronOre = itemNames.some(
    (n) => n.includes("iron") && n.includes("ore"),
  );

  if (hasCopper && hasTin) return "bronze_bar";
  if (hasIronOre) return "iron_bar";
  return null;
}

function detectBarType(
  items: Array<{ name?: string; itemId?: string }>,
): string | null {
  for (const item of items) {
    const name = (item.name || item.itemId || "").toLowerCase();
    if (name.includes("bronze") && name.includes("bar")) return "bronze_bar";
    if (name.includes("iron") && name.includes("bar")) return "iron_bar";
    if (name.includes("steel") && name.includes("bar")) return "steel_bar";
    if (name.includes("mithril") && name.includes("bar")) return "mithril_bar";
  }
  return null;
}

function isTanner(entity: Entity): boolean {
  return (entity.npcType || "").toLowerCase() === "tanner";
}

function isRuneAltar(entity: Entity): boolean {
  const type = (entity.type || "").toLowerCase();
  const entityType = (entity.entityType || "").toLowerCase();
  return (
    (type === "runecrafting_altar" || entityType === "runecrafting_altar") &&
    typeof entity.runeType === "string" &&
    /^[a-z][a-z0-9_]{0,31}$/.test(entity.runeType)
  );
}

function detectFletchRecipe(
  text: string,
  items: Array<{ name?: string; itemId?: string; quantity?: number }>,
): { recipeId: string; product: string } | null {
  let logItemId: string | null = null;
  for (const item of items) {
    const itemId = (item.itemId || "").toLowerCase();
    if (
      Number(item.quantity ?? 0) > 0 &&
      (itemId === "logs" || /^[a-z]+_logs$/.test(itemId))
    ) {
      logItemId = itemId;
      break;
    }
  }
  if (!logItemId) return null;

  const prefix = logItemId === "logs" ? "" : logItemId.replace(/_logs$/, "_");
  const output = text.includes("longbow")
    ? `${prefix}longbow_u`
    : text.includes("shortbow")
      ? `${prefix}shortbow_u`
      : "arrow_shaft";
  const product = output.replace(/_u$/, "").replace(/_/g, " ");
  return { recipeId: `${output}:${logItemId}`, product };
}

function detectHideInput(
  items: Array<{ name?: string; itemId?: string; quantity?: number }>,
): { itemId: "cowhide" | "green_dragonhide"; quantity: number } | null {
  for (const item of items) {
    const itemId = (item.itemId || "").toLowerCase();
    const quantity = Number(item.quantity ?? 0);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
    if (itemId === "green_dragonhide") return { itemId, quantity };
    if (itemId === "cowhide") return { itemId, quantity };
  }
  return null;
}

export const smeltOreAction: Action = {
  name: "SMELT_ORE",
  similes: ["SMELT", "USE_FURNACE", "MAKE_BARS"],
  description:
    "Smelt ore into metal bars at a furnace. Requires ore in inventory and a nearby furnace.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player?.position) return false;
    if (!hasOre(player)) return false;

    const nearbyEntities = service.getNearbyEntities();
    const furnace = findNearestEntity(
      nearbyEntities,
      player.position,
      isFurnace,
    );
    return furnace !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) return { success: false, error: "Service not available" };

      const player = service.getPlayerEntity();
      if (!player?.position)
        return { success: false, error: "No player position" };

      const nearbyEntities = service.getNearbyEntities();
      const furnace = findNearestEntity(
        nearbyEntities,
        player.position,
        isFurnace,
      );
      if (!furnace) {
        await callback?.({ text: "No furnace nearby.", action: "SMELT_ORE" });
        return { success: false, error: "No furnace nearby" };
      }

      if (!(await moveIntoWorkstationRange(service, furnace, 2))) {
        await callback?.({
          text: "I could not reach the furnace safely.",
          action: "SMELT_ORE",
        });
        return { success: false, error: "Furnace was not reached" };
      }

      const barType = getSmeltableBar(player.items);
      if (!barType) {
        await callback?.({
          text: "I don't have the right combination of ores to smelt anything.",
          action: "SMELT_ORE",
        });
        return { success: false, error: "No valid ore combination" };
      }

      const completed = await service.executeSmelting(furnace.id, barType, 1);
      if (!completed) {
        await callback?.({
          text: "Smelting did not complete; I will reassess before trying again.",
          action: "SMELT_ORE",
        });
        return {
          success: false,
          error: "Authoritative smelting completion was not received",
        };
      }

      const responseText = `Smelting ${barType.replace("_", " ")} at the furnace`;
      await callback?.({ text: responseText, action: "SMELT_ORE" });

      return {
        success: true,
        text: responseText,
        data: { action: "SMELT_ORE", barType, furnaceId: furnace.id },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[SMELT_ORE] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Smelt my ore into bars" } },
      {
        name: "agent",
        content: {
          text: "Smelting bronze bar at the furnace",
          action: "SMELT_ORE",
        },
      },
    ],
  ],
};

export const smithItemAction: Action = {
  name: "SMITH_ITEM",
  similes: ["SMITH", "USE_ANVIL", "FORGE_ITEM", "MAKE_WEAPON"],
  description:
    "Smith metal bars into weapons, armor, or tools at an anvil. Requires bars in inventory and a nearby anvil.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player?.position) return false;
    if (!hasBars(player)) return false;

    const nearbyEntities = service.getNearbyEntities();
    const anvil = findNearestEntity(nearbyEntities, player.position, isAnvil);
    return anvil !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) return { success: false, error: "Service not available" };

      const player = service.getPlayerEntity();
      if (!player?.position)
        return { success: false, error: "No player position" };

      const nearbyEntities = service.getNearbyEntities();
      const anvil = findNearestEntity(nearbyEntities, player.position, isAnvil);
      if (!anvil) {
        await callback?.({ text: "No anvil nearby.", action: "SMITH_ITEM" });
        return { success: false, error: "No anvil nearby" };
      }

      if (!(await moveIntoWorkstationRange(service, anvil, 2))) {
        await callback?.({
          text: "I could not reach the anvil safely.",
          action: "SMITH_ITEM",
        });
        return { success: false, error: "Anvil was not reached" };
      }

      const barType = detectBarType(player.items);
      if (!barType) {
        await callback?.({
          text: "I don't have any metal bars to smith with.",
          action: "SMITH_ITEM",
        });
        return { success: false, error: "No bars in inventory" };
      }

      const metalName = barType.replace("_bar", "");
      const recipeId = `${metalName}_dagger`;
      const completed = await service.executeSmithing(anvil.id, recipeId, 1);
      if (!completed) {
        await callback?.({
          text: "Smithing did not complete; I will reassess before trying again.",
          action: "SMITH_ITEM",
        });
        return {
          success: false,
          error: "Authoritative smithing completion was not received",
        };
      }

      const responseText = `Smithing a ${metalName} dagger at the anvil`;
      await callback?.({ text: responseText, action: "SMITH_ITEM" });

      return {
        success: true,
        text: responseText,
        data: {
          action: "SMITH_ITEM",
          barType,
          recipeId,
          anvilId: anvil.id,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[SMITH_ITEM] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Smith a bronze sword" } },
      {
        name: "agent",
        content: {
          text: "Smithing bronze equipment at the anvil",
          action: "SMITH_ITEM",
        },
      },
    ],
  ],
};

export const fletchItemAction: Action = {
  name: "FLETCH_ITEM",
  similes: ["FLETCH", "MAKE_BOW", "MAKE_ARROWS", "FLETCHING"],
  description:
    "Fletch logs into bows or arrow shafts, or string bows. Requires a knife and logs in inventory.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player?.position) return false;
    if (!hasKnife(player)) return false;
    if (!hasLogs(player)) return false;

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) return { success: false, error: "Service not available" };

      const player = service.getPlayerEntity();
      if (!player?.position)
        return { success: false, error: "No player position" };

      if (!hasKnife(player)) {
        await callback?.({
          text: "I need a knife to fletch.",
          action: "FLETCH_ITEM",
        });
        return { success: false, error: "No knife in inventory" };
      }

      if (!hasLogs(player)) {
        await callback?.({
          text: "I don't have any logs to fletch.",
          action: "FLETCH_ITEM",
        });
        return { success: false, error: "No logs in inventory" };
      }

      const text = (message.content.text || "").toLowerCase();
      const recipe = detectFletchRecipe(text, player.items);
      if (!recipe) {
        return { success: false, error: "No supported logs in inventory" };
      }
      const completed = await service.executeFletching(recipe.recipeId, 1);
      if (!completed) {
        await callback?.({
          text: "Fletching did not complete; I will reassess before trying again.",
          action: "FLETCH_ITEM",
        });
        return {
          success: false,
          error: "Authoritative fletching completion was not received",
        };
      }
      const responseText = `Fletching ${recipe.product}`;
      await callback?.({ text: responseText, action: "FLETCH_ITEM" });

      return {
        success: true,
        text: responseText,
        data: {
          action: "FLETCH_ITEM",
          product: recipe.product,
          recipeId: recipe.recipeId,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[FLETCH_ITEM] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Fletch some arrows" } },
      {
        name: "agent",
        content: { text: "Fletching arrow shafts", action: "FLETCH_ITEM" },
      },
    ],
    [
      { name: "user", content: { text: "Make a shortbow" } },
      {
        name: "agent",
        content: { text: "Fletching shortbow", action: "FLETCH_ITEM" },
      },
    ],
  ],
};

export const tanHideAction: Action = {
  name: "TAN_HIDE",
  similes: ["TAN", "TAN_LEATHER", "TANNING"],
  description:
    "Tan hides into leather at a tanner NPC. Requires coins and hides in inventory.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player?.position) return false;
    if (!hasHides(player) || !detectHideInput(player.items)) return false;

    const nearbyEntities = service.getNearbyEntities();
    const tanner = findNearestEntity(nearbyEntities, player.position, isTanner);
    return tanner !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) return { success: false, error: "Service not available" };

      const player = service.getPlayerEntity();
      if (!player?.position)
        return { success: false, error: "No player position" };

      if (!hasHides(player)) {
        await callback?.({
          text: "I don't have any hides to tan.",
          action: "TAN_HIDE",
        });
        return { success: false, error: "No hides in inventory" };
      }
      const hide = detectHideInput(player.items);
      if (!hide) {
        return { success: false, error: "No supported hides in inventory" };
      }

      const nearbyEntities = service.getNearbyEntities();
      const tanner = findNearestEntity(
        nearbyEntities,
        player.position,
        isTanner,
      );
      if (!tanner) {
        await callback?.({
          text: "No tanner nearby.",
          action: "TAN_HIDE",
        });
        return { success: false, error: "No tanner nearby" };
      }

      if (!(await moveIntoWorkstationRange(service, tanner, 2))) {
        await callback?.({
          text: "I could not reach the Tanner safely.",
          action: "TAN_HIDE",
        });
        return { success: false, error: "Tanner was not reached" };
      }

      const completed = await service.executeTanning(
        tanner.id,
        hide.itemId,
        hide.quantity,
      );
      if (!completed) {
        await callback?.({
          text: "Tanning did not complete; I will reassess before trying again.",
          action: "TAN_HIDE",
        });
        return {
          success: false,
          error: "Authoritative tanning completion was not received",
        };
      }

      const responseText = `Submitted ${hide.quantity} ${hide.itemId.replace(/_/g, " ")} for authoritative tanning`;
      await callback?.({ text: responseText, action: "TAN_HIDE" });

      return {
        success: true,
        text: responseText,
        data: {
          action: "TAN_HIDE",
          hideType: hide.itemId,
          quantity: hide.quantity,
          tannerId: tanner.id,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TAN_HIDE] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Tan my cowhides" } },
      {
        name: "agent",
        content: {
          text: "Tanning cowhides into leather at the tanner",
          action: "TAN_HIDE",
        },
      },
    ],
  ],
};

export const runecraftAction: Action = {
  name: "RUNECRAFT",
  similes: ["CRAFT_RUNES", "MAKE_RUNES", "RUNECRAFTING"],
  description:
    "Convert essence into runes at a runecrafting altar. Requires rune or pure essence in inventory and a nearby altar.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player?.position) return false;
    if (!hasEssence(player)) return false;

    const nearbyEntities = service.getNearbyEntities();
    const altar = findNearestEntity(
      nearbyEntities,
      player.position,
      isRuneAltar,
    );
    return altar !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) return { success: false, error: "Service not available" };

      const player = service.getPlayerEntity();
      if (!player?.position)
        return { success: false, error: "No player position" };

      if (!hasEssence(player)) {
        await callback?.({
          text: "I don't have any rune essence to craft with.",
          action: "RUNECRAFT",
        });
        return { success: false, error: "No essence in inventory" };
      }

      const nearbyEntities = service.getNearbyEntities();
      const altar = findNearestEntity(
        nearbyEntities,
        player.position,
        isRuneAltar,
      );
      if (!altar) {
        await callback?.({
          text: "No runecrafting altar nearby.",
          action: "RUNECRAFT",
        });
        return { success: false, error: "No altar nearby" };
      }

      if (!(await moveIntoWorkstationRange(service, altar, 2))) {
        await callback?.({
          text: "I could not reach the runecrafting altar safely.",
          action: "RUNECRAFT",
        });
        return { success: false, error: "Altar was not reached" };
      }

      const runeType = altar.runeType as string;
      const completed = await service.executeRunecrafting(altar.id, runeType);
      if (!completed) {
        await callback?.({
          text: "Runecrafting did not complete; I will reassess before trying again.",
          action: "RUNECRAFT",
        });
        return {
          success: false,
          error: "Authoritative runecrafting completion was not received",
        };
      }
      const responseText = `Crafting ${runeType} runes at the altar`;
      await callback?.({ text: responseText, action: "RUNECRAFT" });

      return {
        success: true,
        text: responseText,
        data: { action: "RUNECRAFT", runeType, altarId: altar.id },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[RUNECRAFT] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Craft some air runes" } },
      {
        name: "agent",
        content: {
          text: "Crafting air runes at the altar",
          action: "RUNECRAFT",
        },
      },
    ],
  ],
};

export const craftingActions = [
  smeltOreAction,
  smithItemAction,
  fletchItemAction,
  tanHideAction,
  runecraftAction,
];
