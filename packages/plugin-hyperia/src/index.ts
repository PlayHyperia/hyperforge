/**
 * @hyperforge/plugin-hyperia - ElizaOS Plugin for Hyperia
 *
 * This plugin connects ElizaOS AI agents to Hyperia multiplayer RPG worlds,
 * enabling agents to play as real players with full access to game mechanics.
 *
 * Architecture:
 * - Service: HyperiaService manages WebSocket connection and game state
 * - Providers: Supply game context (health, inventory, nearby entities, skills, equipment, actions)
 * - Actions: Execute game commands (movement, combat, skills, inventory, social, banking)
 * - Event Handlers: Store game events as memories for learning
 */

import type { Plugin, IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { z } from "zod";
import {
  hyperiaAppBridge,
  hyperiaAppMeta,
  type HyperiaAppBridge,
  type HyperiaAppMeta,
} from "./app.js";

// Service
import {
  HyperiaService,
  resolveDefaultHyperiaServerUrl,
} from "./services/HyperiaService.js";

// Providers
import { gameStateProvider } from "./providers/gameState.js";
import { inventoryProvider } from "./providers/inventory.js";
import { nearbyEntitiesProvider } from "./providers/nearbyEntities.js";
import { skillsProvider } from "./providers/skills.js";
import { equipmentProvider } from "./providers/equipment.js";
import { availableActionsProvider } from "./providers/availableActions.js";
import { goalProvider } from "./providers/goalProvider.js";
import { possibilitiesProvider } from "./providers/possibilitiesProvider.js";
import { goalTemplatesProvider } from "./providers/goalTemplatesProvider.js";
import { guardrailsProvider } from "./providers/guardrailsProvider.js";
import { questProvider } from "./providers/questProvider.js";
import { personalityProvider } from "./providers/personalityProvider.js";
import { socialMemoryProvider } from "./providers/socialMemory.js";
import { duelProvider } from "./providers/duelProvider.js";
import { mapProvider } from "./providers/mapProvider.js";
import { localChatProvider } from "./providers/localChatProvider.js";

// Actions
import {
  moveToAction,
  followEntityAction,
  stopMovementAction,
  homeTeleportAction,
} from "./actions/movement.js";
import {
  attackEntityAction,
  changeCombatStyleAction,
  togglePrayerAction,
} from "./actions/combat.js";
import {
  chopTreeAction,
  catchFishAction,
  mineRockAction,
  lightFireAction,
  cookFoodAction,
} from "./actions/skills.js";
import {
  equipItemAction,
  useItemAction,
  dropItemAction,
  pickupItemAction,
} from "./actions/inventory.js";
import {
  chatMessageAction,
  greetPlayerAction,
  shareOpinionAction,
  offerHelpAction,
} from "./actions/social.js";
import {
  bankDepositAction,
  bankWithdrawAction,
  bankDepositAllAction,
} from "./actions/banking.js";
import {
  talkToNpcAction,
  acceptQuestAction,
  completeQuestAction,
  checkQuestAction,
} from "./actions/quests.js";
import {
  smeltOreAction,
  smithItemAction,
  fletchItemAction,
  tanHideAction,
  runecraftAction,
} from "./actions/crafting.js";
import { buyItemAction, sellItemAction } from "./actions/shopping.js";
import {
  exploreAction,
  fleeAction,
  idleAction,
  approachEntityAction,
  attackEntityAction as autonomousAttackAction,
} from "./actions/autonomous.js";
import { setGoalAction, navigateToAction } from "./actions/goals.js";
import { challengeDuelAction, acceptDuelAction } from "./actions/duel.js";
import { requestTradeAction } from "./actions/trading.js";

// Evaluators
import {
  survivalEvaluator,
  explorationEvaluator,
  socialEvaluator,
  combatEvaluator,
} from "./evaluators/index.js";
import { goalEvaluator } from "./evaluators/goalEvaluator.js";

// Event handlers
import { registerEventHandlers } from "./events/handlers.js";

// API routes
import { callbackRoute, statusRoute } from "./routes/auth.js";
import { getSettingsRoute } from "./routes/settings.js";
import { getLogsRoute } from "./routes/logs.js";
import { messageRoute } from "./routes/message.js";
import { goalRoute } from "./routes/goal.js";

// Configuration schema
const configSchema = z.object({
  HYPERIA_SERVER_URL: z
    .string()
    .url()
    .optional()
    .default(resolveDefaultHyperiaServerUrl())
    .describe("WebSocket URL for Hyperia server"),
  HYPERIA_AUTO_RECONNECT: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val !== "false")
    .describe("Automatically reconnect on disconnect"),
  HYPERIA_AUTH_TOKEN: z
    .string()
    .optional()
    .describe("Privy auth token for authenticated connections"),
  HYPERIA_PRIVY_USER_ID: z
    .string()
    .optional()
    .describe("Privy user ID for authenticated connections"),
  HYPERIA_AUTONOMY_MODE: z
    .string()
    .optional()
    .default("llm")
    .describe("Autonomy mode: 'llm' or 'scripted'"),
  HYPERIA_SCRIPTED_ROLE: z
    .string()
    .optional()
    .describe("Scripted role for non-LLM bots"),
  HYPERIA_SILENT_CHAT: z
    .string()
    .optional()
    .default("false")
    .describe("Disable chat processing for silent bots"),
  HYPERIA_OPERATOR_CHAT_ENTITY_ID: z
    .string()
    .optional()
    .describe(
      "Exact server-authenticated entity ID allowed to issue in-world operator commands; unset denies all",
    ),
  HYPERIA_LLM_PUBLIC_CHAT_ENABLED: z
    .string()
    .optional()
    .default("false")
    .describe("Development/test-only opt-in for model-generated public chat"),
  HYPERIA_FLEE_HEALTH_PERCENT: z
    .string()
    .optional()
    .describe("Health percent threshold for fleeing"),
  HYPERIA_MOB_LEVEL_MAX_ABOVE: z
    .string()
    .optional()
    .describe("Max mob level above player to engage"),
  HYPERIA_MOB_LEVEL_MAX_BELOW: z
    .string()
    .optional()
    .describe("Max mob level below player to engage"),
  HYPERIA_RESOURCE_LEVEL_MAX_ABOVE: z
    .string()
    .optional()
    .describe("Max resource level above skill to gather"),
  HYPERIA_RESOURCE_LEVEL_MAX_BELOW: z
    .string()
    .optional()
    .describe("Max resource level below skill to gather"),
  HYPERIA_RESOURCE_APPROACH_RANGE: z
    .string()
    .optional()
    .describe("Approach range for resource gathering (units)"),
});

function normalizeEnvValue(value: string | undefined, fallback = ""): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Hyperia Plugin for ElizaOS
 *
 * Enables AI agents to play Hyperia as real players with:
 * - Real-time game state awareness via providers
 * - Full action repertoire (movement, combat, skills, inventory, social)
 * - Event-driven memory storage for learning
 * - Automatic reconnection and error handling
 */
type HyperiaPlugin = Plugin & {
  app: HyperiaAppMeta;
  appBridge: HyperiaAppBridge;
};

export const hyperiaPlugin: HyperiaPlugin = {
  name: "@hyperforge/plugin-hyperia",
  description: "Connect ElizaOS AI agents to Hyperia 3D multiplayer RPG worlds",
  app: hyperiaAppMeta,
  appBridge: hyperiaAppBridge,

  config: {
    HYPERIA_SERVER_URL: normalizeEnvValue(
      process.env.HYPERIA_SERVER_URL,
      resolveDefaultHyperiaServerUrl(),
    ),
    HYPERIA_AUTO_RECONNECT: normalizeEnvValue(
      process.env.HYPERIA_AUTO_RECONNECT,
      "true",
    ),
    HYPERIA_AUTH_TOKEN: normalizeEnvValue(process.env.HYPERIA_AUTH_TOKEN),
    HYPERIA_PRIVY_USER_ID: normalizeEnvValue(process.env.HYPERIA_PRIVY_USER_ID),
    HYPERIA_AUTONOMY_MODE: normalizeEnvValue(
      process.env.HYPERIA_AUTONOMY_MODE,
      "llm",
    ),
    HYPERIA_SCRIPTED_ROLE: normalizeEnvValue(process.env.HYPERIA_SCRIPTED_ROLE),
    HYPERIA_SILENT_CHAT: normalizeEnvValue(
      process.env.HYPERIA_SILENT_CHAT,
      "false",
    ),
    HYPERIA_OPERATOR_CHAT_ENTITY_ID: normalizeEnvValue(
      process.env.HYPERIA_OPERATOR_CHAT_ENTITY_ID,
    ),
    HYPERIA_LLM_PUBLIC_CHAT_ENABLED: normalizeEnvValue(
      process.env.HYPERIA_LLM_PUBLIC_CHAT_ENABLED,
      "false",
    ),
    HYPERIA_FLEE_HEALTH_PERCENT: normalizeEnvValue(
      process.env.HYPERIA_FLEE_HEALTH_PERCENT,
    ),
    HYPERIA_MOB_LEVEL_MAX_ABOVE: normalizeEnvValue(
      process.env.HYPERIA_MOB_LEVEL_MAX_ABOVE,
    ),
    HYPERIA_MOB_LEVEL_MAX_BELOW: normalizeEnvValue(
      process.env.HYPERIA_MOB_LEVEL_MAX_BELOW,
    ),
    HYPERIA_RESOURCE_LEVEL_MAX_ABOVE: normalizeEnvValue(
      process.env.HYPERIA_RESOURCE_LEVEL_MAX_ABOVE,
    ),
    HYPERIA_RESOURCE_LEVEL_MAX_BELOW: normalizeEnvValue(
      process.env.HYPERIA_RESOURCE_LEVEL_MAX_BELOW,
    ),
    HYPERIA_RESOURCE_APPROACH_RANGE: normalizeEnvValue(
      process.env.HYPERIA_RESOURCE_APPROACH_RANGE,
    ),
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    logger.info("[HyperiaPlugin] Initializing plugin...");

    try {
      // Validate configuration
      const validatedConfig = await configSchema.parseAsync(config);

      // Set environment variables from validated config
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value !== undefined) {
          process.env[key] = String(value);
        }
      }

      logger.info("[HyperiaPlugin] Configuration validated");
      logger.info(
        `[HyperiaPlugin] Server URL: ${validatedConfig.HYPERIA_SERVER_URL}`,
      );
      logger.info(
        `[HyperiaPlugin] Auto-reconnect: ${validatedConfig.HYPERIA_AUTO_RECONNECT}`,
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages =
          error.issues?.map((e) => e.message)?.join(", ") ||
          "Unknown validation error";
        throw new Error(
          `[HyperiaPlugin] Invalid configuration: ${errorMessages}`,
        );
      }
      throw new Error(
        `[HyperiaPlugin] Configuration error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logger.info("[HyperiaPlugin] Plugin initialized successfully");
  },

  // Service for managing game connection and state
  services: [HyperiaService],

  // Providers supply game context to the agent
  providers: [
    goalProvider, // Current goal and progress (runs first for goal-aware decisions)
    duelProvider, // Active duel context and opponent info
    gameStateProvider, // Player health, stamina, position, combat status
    inventoryProvider, // Inventory items, coins, free slots
    nearbyEntitiesProvider, // Players, NPCs, resources nearby
    skillsProvider, // Skill levels and XP
    equipmentProvider, // Equipped items
    availableActionsProvider, // Context-aware available actions
    possibilitiesProvider, // What actions are currently possible (LLM context)
    goalTemplatesProvider, // Structured goal templates for beginners
    guardrailsProvider, // Safety constraints and warnings
    questProvider, // Quest status, active objectives, nearby quest NPCs
    personalityProvider, // Personality traits influencing behavior
    socialMemoryProvider, // Relationship tracking and social awareness
    mapProvider, // World map: towns, POIs, distances, compass directions
    localChatProvider, // Recent chat messages from nearby players/agents
  ],

  // Evaluators assess game state for autonomous decision making
  evaluators: [
    goalEvaluator, // Check goal progress and provide recommendations (runs first)
    survivalEvaluator, // Assess health, threats, survival needs
    explorationEvaluator, // Identify exploration opportunities
    socialEvaluator, // Identify social interaction opportunities
    combatEvaluator, // Assess combat opportunities and threats
  ],

  // HTTP API routes for agent management
  routes: [
    callbackRoute,
    statusRoute,
    getSettingsRoute,
    getLogsRoute,
    messageRoute,
    goalRoute,
  ],

  // Actions the agent can perform in the game
  actions: [
    // Goal-oriented actions (highest priority for autonomous behavior)
    setGoalAction, // Set a new goal when none exists
    navigateToAction, // Navigate to goal location

    // Autonomous behavior actions (used by AutonomousBehaviorManager)
    autonomousAttackAction, // Attack nearby mobs (autonomous-friendly)
    exploreAction, // Move to explore new areas
    fleeAction, // Run away from danger
    idleAction, // Stand still and observe
    approachEntityAction, // Move towards a specific entity
    // Duel actions (for agent vs agent PvP)
    challengeDuelAction, // Challenge nearby player to a duel
    acceptDuelAction, // Accept incoming duel challenge

    // Movement
    moveToAction,
    followEntityAction,
    stopMovementAction,

    // Combat
    attackEntityAction,
    changeCombatStyleAction,
    togglePrayerAction,

    // Skills
    chopTreeAction,
    catchFishAction,
    mineRockAction,
    lightFireAction,
    cookFoodAction,

    // Inventory
    equipItemAction,
    useItemAction,
    dropItemAction,
    pickupItemAction,

    // Social
    chatMessageAction,
    greetPlayerAction,
    shareOpinionAction,
    offerHelpAction,

    // Quest interactions
    talkToNpcAction,
    acceptQuestAction,
    completeQuestAction,
    checkQuestAction,

    // Crafting
    smeltOreAction,
    smithItemAction,
    fletchItemAction,
    tanHideAction,
    runecraftAction,

    // Shopping
    buyItemAction,
    sellItemAction,

    // Banking
    bankDepositAction,
    bankWithdrawAction,
    bankDepositAllAction,

    // Trading
    requestTradeAction,

    // Teleport
    homeTeleportAction,
  ],

  // Event handlers for storing game events as memories
  events: {
    // Service started - register event handlers
    RUN_STARTED: [
      async (payload) => {
        const runtime = payload.runtime;
        const service = runtime.getService<HyperiaService>("hyperiaService");

        if (service) {
          // Only register handlers once per service instance
          if (!service.arePluginEventHandlersRegistered()) {
            registerEventHandlers(runtime, service);
            service.markPluginEventHandlersRegistered();
            logger.info(
              "[HyperiaPlugin] Event handlers registered on RUN_STARTED",
            );
          } else {
            logger.debug(
              "[HyperiaPlugin] Event handlers already registered, skipping",
            );
          }
        } else {
          logger.warn(
            "[HyperiaPlugin] HyperiaService not found, could not register event handlers",
          );
        }
      },
    ],
  },
};

// Default export
export default hyperiaPlugin;

// Export types for external use
export * from "./types.js";
export { HyperiaService };
export * from "./app.js";

// Export content packs
export * from "./content-packs/index.js";
