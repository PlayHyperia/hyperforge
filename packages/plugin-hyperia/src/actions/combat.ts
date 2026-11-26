/**
 * Combat actions - ATTACK_ENTITY, CHANGE_COMBAT_STYLE, EAT_FOOD
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";
import type { HyperiaService } from "../services/HyperiaService.js";
import type {
  AttackEntityCommand,
  UseItemCommand,
  CombatStyle,
} from "../types.js";
import { getPrayerIds } from "../utils/world-data.js";

export const attackEntityAction: Action = {
  name: "ATTACK_TARGET",
  similes: ["ATTACK", "FIGHT", "COMBAT"],
  description: "Attack a specific NPC or player by name from chat command.",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) return false;
    const playerEntity = service.getPlayerEntity();

    if (!service.isConnected() || !playerEntity) {
      return false;
    }

    if (playerEntity.alive === false || playerEntity.inCombat) {
      return false;
    }

    return true;
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
      const entities = service.getNearbyEntities();
      const content = message.content.text || "";

      const targetEntity = entities.find(
        (e) =>
          e.name?.toLowerCase().includes(content.toLowerCase()) &&
          "mobType" in e,
      );

      if (!targetEntity) {
        await callback?.({
          text: "Could not find that NPC nearby.",
          error: true,
        });
        return {
          success: false,
          error: new Error(
            "return { success: false, error: 'Target not found' };",
          ),
        };
      }

      const command: AttackEntityCommand = { targetEntityId: targetEntity.id };
      await service.executeAttack(command);

      await callback?.({
        text: `Attacking ${targetEntity.name}`,
        action: "ATTACK_ENTITY",
      });

      return {
        success: true,
        text: `Started attacking ${targetEntity.name}`,
        data: { action: "ATTACK_ENTITY" },
      };
    } catch (error) {
      await callback?.({
        text: `Failed to attack: ${error instanceof Error ? error.message : "Unknown error"}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Attack the goblin" } },
      {
        name: "agent",
        content: { text: "Attacking Goblin", action: "ATTACK_ENTITY" },
      },
    ],
  ],
};

export const changeCombatStyleAction: Action = {
  name: "CHANGE_COMBAT_STYLE",
  similes: ["COMBAT_STYLE", "ATTACK_STYLE"],
  description: "Change combat style: attack, strength, defense, or ranged.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) return false;
    return service.isConnected();
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    try {
      const content = (message.content.text || "").toLowerCase();
      let style: CombatStyle = "attack";

      if (content.includes("strength")) style = "strength";
      else if (content.includes("defense")) style = "defense";
      else if (content.includes("ranged")) style = "ranged";

      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }
      await service.executeChangeAttackStyle(style);

      await callback?.({
        text: `Changed combat style to ${style}`,
        action: "CHANGE_COMBAT_STYLE",
      });

      return { success: true, text: `Combat style set to ${style}` };
    } catch (error) {
      await callback?.({
        text: `Failed to change style: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Use strength style" } },
      {
        name: "agent",
        content: {
          text: "Changed combat style to strength",
          action: "CHANGE_COMBAT_STYLE",
        },
      },
    ],
  ],
};

export const togglePrayerAction: Action = {
  name: "TOGGLE_PRAYER",
  similes: ["PRAY", "TOGGLE_PRAY", "ACTIVATE_PRAYER", "DEACTIVATE_PRAYER"],
  description:
    "Toggle a Prayer exposed by the current game manifest. Specify its exact id, for example: 'pray rock_skin'.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) return false;
    return service.isConnected();
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    try {
      const content = (message.content.text || "").toLowerCase();

      // Match prayer from manifest (data-driven) with space/underscore normalization
      let prayerId: string | null = null;
      const knownPrayers = getPrayerIds();
      if (knownPrayers.length === 0) {
        const text =
          "Prayer data is unavailable, so no Prayer request was submitted.";
        await callback?.({ text, error: true });
        return {
          success: false,
          text,
          error: new Error("Prayer manifest unavailable"),
        };
      }
      const normalizedInput = content.replace(/\s+/g, "_");
      for (const id of knownPrayers) {
        if (
          normalizedInput.includes(id) ||
          content.includes(id.replace(/_/g, " "))
        ) {
          prayerId = id;
          break;
        }
      }

      if (!prayerId) {
        const text = "Specify a Prayer available in the current game manifest.";
        await callback?.({ text, error: true });
        return {
          success: false,
          text,
          error: new Error("Unknown or missing Prayer"),
        };
      }

      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }

      const receipt = await service.executeTogglePrayer(prayerId);
      if (!receipt.success) {
        const text = `Prayer request rejected: ${receipt.message ?? receipt.reason ?? "unknown reason"}`;
        await callback?.({ text, error: true });
        return {
          success: false,
          text,
          error: new Error(receipt.reason ?? "Prayer request rejected"),
        };
      }

      const isActive = receipt.activePrayers.includes(prayerId);
      const state = isActive ? "active" : "inactive";

      await callback?.({
        text: `Prayer ${prayerId} is ${state}.`,
        action: "TOGGLE_PRAYER",
      });

      return {
        success: true,
        text: `Prayer ${prayerId} is ${state}.`,
        data: { active: isActive, receipt },
      };
    } catch (error) {
      await callback?.({
        text: `Failed to toggle prayer: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Activate rock skin" } },
      {
        name: "agent",
        content: {
          text: "Prayer rock_skin is active.",
          action: "TOGGLE_PRAYER",
        },
      },
    ],
  ],
};
