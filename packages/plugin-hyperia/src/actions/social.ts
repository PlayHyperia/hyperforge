/**
 * Social actions - CHAT_MESSAGE, GREET_PLAYER, SHARE_OPINION, OFFER_HELP
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import type { HyperiaService } from "../services/HyperiaService.js";
import type { ChatMessageCommand, Entity } from "../types.js";
import {
  recordEncounter,
  recordSocialAction,
  getTimeSinceLastSocial,
} from "../providers/socialMemory.js";
import { getPersonalityTraits } from "../providers/personalityProvider.js";
import { hasFood as detectHasFood } from "../utils/item-detection.js";
import {
  formatUntrustedPromptData,
  parseSafePublicChat,
} from "../utils/prompt-safety.js";

function isDevelopmentPublicModelChatEnabled(runtime: IAgentRuntime): boolean {
  const environment = String(process.env.NODE_ENV || "").toLowerCase();
  const enabled = String(
    runtime.getSetting("HYPERIA_LLM_PUBLIC_CHAT_ENABLED") || "",
  ).toLowerCase();
  return (
    (environment === "development" || environment === "test") &&
    enabled === "true"
  );
}

function isPlayerEntity(
  entity: Entity,
): entity is Entity & { playerId: string } {
  return (
    !!entity.playerId ||
    entity.entityType === "player" ||
    entity.type === "player"
  );
}

function getDistance2D(
  posA: [number, number, number] | null | undefined,
  posB: [number, number, number] | null | undefined,
): number | null {
  if (!posA || !posB) return null;
  const dx = posA[0] - posB[0];
  const dz = posA[2] - posB[2];
  return Math.sqrt(dx * dx + dz * dz);
}

export const chatMessageAction: Action = {
  name: "CHAT_MESSAGE",
  similes: ["CHAT", "SAY", "TALK", "SPEAK"],
  description:
    "Send a short chat message to nearby players. Keep messages brief (under 50 characters) like real MMO players.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service) return false;

    // Allow chat during combat so agents can trash talk during duels
    return service.isConnected();
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
      if (!service) {
        return {
          success: false,
          error: new Error("Hyperia service not available"),
        };
      }
      const content = message.content.text || "";

      const command: ChatMessageCommand = { message: content };
      await service.executeChatMessage(command);

      recordSocialAction();
      await callback?.({ text: `Said: "${content}"`, action: "CHAT_MESSAGE" });

      return { success: true, text: `Sent message: ${content}` };
    } catch (error) {
      await callback?.({
        text: `Failed to send message: ${error instanceof Error ? error.message : ""}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Say hello to everyone" } },
      {
        name: "agent",
        content: { text: 'Said: "hello to everyone"', action: "CHAT_MESSAGE" },
      },
    ],
  ],
};

export const greetPlayerAction: Action = {
  name: "GREET_PLAYER",
  similes: ["WAVE", "SAY_HELLO", "WELCOME"],
  description:
    "Greet a nearby player with a friendly message. Use when you notice someone new nearby.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player || player.inCombat) return false;

    const nearbyEntities = service.getNearbyEntities();
    const nearbyPlayers = nearbyEntities.filter(
      (e) => isPlayerEntity(e) && e.id !== player.id,
    );

    if (nearbyPlayers.length === 0) return false;

    const timeSince = getTimeSinceLastSocial();
    return timeSince > 30000;
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
      if (!player) return { success: false, error: "No player entity" };

      const nearbyEntities = service.getNearbyEntities();
      const nearbyPlayers = nearbyEntities.filter(
        (e) => isPlayerEntity(e) && e.id !== player.id,
      );

      if (nearbyPlayers.length === 0) {
        return { success: false, error: "No players nearby" };
      }

      const traits = getPersonalityTraits(runtime);
      const targetPlayer = nearbyPlayers[0];
      const targetName = targetPlayer.name || "there";

      const greetings = [
        `Hey ${targetName}!`,
        `Hi ${targetName}!`,
        `Yo ${targetName}!`,
        `${targetName}! o/`,
        `Sup ${targetName}`,
      ];

      if (traits.sociability > 0.7) {
        greetings.push(`${targetName}! Nice to see ya!`, `Welcome!`);
      }

      const greeting = greetings[Math.floor(Math.random() * greetings.length)];

      await service.executeChatMessage({ message: greeting });

      const pid = targetPlayer.playerId || targetPlayer.id;
      recordEncounter(runtime.agentId, pid, targetName, "greeted");
      recordSocialAction();

      await callback?.({
        text: `Greeted ${targetName}: "${greeting}"`,
        action: "GREET_PLAYER",
      });

      return {
        success: true,
        text: `Greeted ${targetName}`,
        data: { action: "GREET_PLAYER", playerName: targetName },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[GREET_PLAYER] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "system",
        content: { text: "New player 'Alex' appeared nearby" },
      },
      {
        name: "agent",
        content: {
          text: 'Greeted Alex: "Hey Alex! How\'s it going?"',
          action: "GREET_PLAYER",
        },
      },
    ],
  ],
};

export const shareOpinionAction: Action = {
  name: "SHARE_OPINION",
  similes: ["COMMENT", "THINK_ALOUD", "REMARK"],
  description:
    "Share a thought, opinion, or observation about current activity, surroundings, or the game world. Makes the agent feel more alive.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const playerEntity = service.getPlayerEntity();
    if (playerEntity?.inCombat) return false;

    const traits = getPersonalityTraits(runtime);
    const timeSince = getTimeSinceLastSocial();

    const chattinessThreshold = Math.max(
      20000,
      (1 - traits.chattiness) * 120000,
    );
    return timeSince > chattinessThreshold;
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
      if (!player) return { success: false, error: "No player entity" };

      const traits = getPersonalityTraits(runtime);
      const behaviorManager = service.getBehaviorManager();
      const goal = behaviorManager?.getGoal();
      const nearbyEntities = service.getNearbyEntities();

      const healthPercent = player.health
        ? Math.round((player.health.current / player.health.max) * 100)
        : 100;

      const nearbyTypes: string[] = [];
      for (const e of nearbyEntities.slice(0, 5)) {
        if (e.resourceType) nearbyTypes.push(e.resourceType);
        if (e.mobType) nearbyTypes.push(e.name || "mob");
      }
      const fallbacks = [
        "Good progress",
        "Staying focused",
        "Training is going well",
        "One step at a time",
        "Preparing for the next duel",
      ];
      const fallback = () =>
        fallbacks[Math.floor(Math.random() * fallbacks.length)];
      let opinion = fallback();

      if (isDevelopmentPublicModelChatEnabled(runtime)) {
        const prompt = [
          "Write one short, sportsmanlike RPG activity comment for public chat.",
          "Do not insult, threaten, advertise, link, or issue instructions.",
          "Return only one plain-text line using letters, numbers, spaces, and basic punctuation. Maximum 40 characters.",
          formatUntrustedPromptData("SOCIAL_CHAT_CONTEXT", {
            activity: goal?.description ?? "training",
            healthPercent,
            nearbyEntityTypes: nearbyTypes,
            style: traits.chattiness > 0.6 ? "casual" : "minimal",
          }),
        ].join("\n");

        try {
          const response = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt,
            maxTokens: 20,
            temperature: 0.8,
          });
          opinion = parseSafePublicChat(response, 40) ?? opinion;
        } catch {
          // The curated production-safe fallback is already selected.
        }
      }

      await service.executeChatMessage({ message: opinion });
      recordSocialAction();

      await callback?.({
        text: `Shared thought: "${opinion}"`,
        action: "SHARE_OPINION",
      });

      return {
        success: true,
        text: `Shared opinion: ${opinion}`,
        data: { action: "SHARE_OPINION", message: opinion },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[SHARE_OPINION] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "system",
        content: { text: "Agent is woodcutting, trees nearby" },
      },
      {
        name: "agent",
        content: {
          text: 'Shared thought: "These oak trees are perfect for training!"',
          action: "SHARE_OPINION",
        },
      },
    ],
  ],
};

export const offerHelpAction: Action = {
  name: "OFFER_HELP",
  similes: ["HELP_PLAYER", "ASSIST", "AID"],
  description:
    "Offer help to a nearby player who seems to need it (low health, new player, etc.). Can drop food or give advice.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player || player.inCombat) return false;

    const traits = getPersonalityTraits(runtime);
    if (traits.helpfulness < 0.3) return false;

    const nearbyEntities = service.getNearbyEntities();
    const nearbyPlayers = nearbyEntities.filter(
      (e) => isPlayerEntity(e) && e.id !== player.id,
    );

    return nearbyPlayers.length > 0;
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
      if (!player) return { success: false, error: "No player entity" };

      const nearbyEntities = service.getNearbyEntities();
      const nearbyPlayers = nearbyEntities.filter(
        (e) => isPlayerEntity(e) && e.id !== player.id,
      );

      if (nearbyPlayers.length === 0) {
        return { success: false, error: "No players nearby to help" };
      }

      const targetPlayer = nearbyPlayers[0];
      const targetName = targetPlayer.name || "friend";

      const targetHealth = targetPlayer.health;
      const isLowHealth =
        targetHealth &&
        targetHealth.max > 0 &&
        targetHealth.current / targetHealth.max < 0.4;

      const hasFood = detectHasFood(player);

      let helpMessage: string;
      let helpAction = "advice";

      if (isLowHealth && hasFood) {
        helpMessage = `${targetName} take this!`;
        helpAction = "drop_food";

        const foodItem = player.items.find((item) => {
          const name = (item.name || item.itemId || "").toLowerCase();
          return (
            name.includes("shrimp") ||
            name.includes("bread") ||
            name.includes("fish") ||
            name.includes("cooked") ||
            name.includes("meat")
          );
        });

        if (foodItem) {
          try {
            const receipt = await service.executeDropItem(
              foodItem.itemId || foodItem.name,
              1,
            );
            if (!receipt.success) {
              helpAction = "advice";
              helpMessage = `${targetName} eat some food!`;
            }
          } catch {
            helpAction = "advice";
            helpMessage = `${targetName} eat some food!`;
          }
        } else {
          helpAction = "advice";
          helpMessage = `${targetName} eat some food!`;
        }
      } else if (isLowHealth) {
        helpMessage = `${targetName} eat some food!`;
      } else {
        const tips = [
          `${targetName} check the starter chest!`,
          `${targetName} fish spots west of here`,
          `${targetName} goblins are good xp`,
          `gl ${targetName}!`,
        ];
        helpMessage = tips[Math.floor(Math.random() * tips.length)];
      }

      await service.executeChatMessage({ message: helpMessage });

      const pid = targetPlayer.playerId || targetPlayer.id;
      recordEncounter(runtime.agentId, pid, targetName, "offered help");
      recordSocialAction();

      const responseText = `Offered help to ${targetName}: "${helpMessage}"`;
      await callback?.({ text: responseText, action: "OFFER_HELP" });

      return {
        success: true,
        text: responseText,
        data: {
          action: "OFFER_HELP",
          playerName: targetName,
          helpType: helpAction,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OFFER_HELP] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "system",
        content: { text: "Player 'Newbie' nearby with low health" },
      },
      {
        name: "agent",
        content: {
          text: 'Offered help to Newbie: "Newbie, you look hurt! Here, take some food!"',
          action: "OFFER_HELP",
        },
      },
    ],
  ],
};

export const socialActions = [
  chatMessageAction,
  greetPlayerAction,
  shareOpinionAction,
  offerHelpAction,
];
