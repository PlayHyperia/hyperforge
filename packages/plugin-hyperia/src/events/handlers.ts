/**
 * Event handlers - Map Hyperia game events to ElizaOS Memory storage
 *
 * These handlers listen to game events and store significant events as memories
 * for the agent to learn from and reference later.
 */

import { logger, type IAgentRuntime } from "@elizaos/core";
import type { HyperiaService } from "../services/HyperiaService.js";
import type { Entity, EventType } from "../types.js";

/**
 * Register all game event handlers with the service
 */
export function registerEventHandlers(
  runtime: IAgentRuntime,
  service: HyperiaService,
): void {
  // Combat events
  service.onGameEvent("COMBAT_STARTED", async (data: unknown) => {
    const eventData = data as { targetName: string; targetId: string };
    await storeCombatMemory(runtime, "Combat started", eventData, [
      "combat",
      "started",
    ]);
  });

  service.onGameEvent("COMBAT_ENDED", async (data: unknown) => {
    const eventData = data as { outcome: "victory" | "defeat" };
    await storeCombatMemory(
      runtime,
      `Combat ended: ${eventData.outcome}`,
      eventData,
      ["combat", "ended", eventData.outcome],
    );
  });

  // NOTE: COMBAT_KILL is an internal server event that is NOT sent over WebSocket.
  // We keep this handler in case we add the packet in the future.
  service.onGameEvent("COMBAT_KILL", async (data: unknown) => {
    const eventData = data as { targetName: string; xpGained: number };
    await storeCombatMemory(
      runtime,
      `Defeated ${eventData.targetName}`,
      eventData,
      ["combat", "victory", "kill"],
    );
    logger.info(
      `[HyperiaPlugin] Defeated ${eventData.targetName}, gained ${eventData.xpGained} XP`,
    );

    // Update goal progress if we have a combat_training goal
    const behaviorManager = service.getBehaviorManager();
    const goal = behaviorManager?.getGoal();
    if (goal?.type === "combat_training") {
      // Check if the killed target matches our goal target (if specified)
      const targetMatches =
        !goal.targetEntity ||
        eventData.targetName
          .toLowerCase()
          .includes(goal.targetEntity.toLowerCase());

      if (targetMatches) {
        behaviorManager?.updateGoalProgress(1);
        logger.info(
          `[HyperiaPlugin] Goal progress updated: ${goal.progress + 1}/${goal.target} (killed ${eventData.targetName})`,
        );
      }
    }
  });

  // Track mob kills via ENTITY_LEFT - when a mob entity is removed, it likely died
  // This is a workaround since COMBAT_KILL isn't sent over WebSocket
  // The service stores the removed entity before deletion via getLastRemovedEntity()
  logger.info(
    "[HyperiaPlugin] 📝 Registering ENTITY_LEFT handler for kill tracking",
  );
  service.onGameEvent("ENTITY_LEFT", async (data: unknown) => {
    // Get the removed entity data (stored by HyperiaService before cache deletion)
    const entity = service.getLastRemovedEntity();
    if (!entity) {
      logger.debug(
        "[HyperiaPlugin] ENTITY_LEFT fired but no entity data available",
      );
      return;
    }

    // Check if this was a mob entity
    logger.debug(
      `[HyperiaPlugin] ENTITY_LEFT: ${entity.name || entity.id} (type=${entity.type}, mobType=${entity.mobType})`,
    );
    const isMob =
      "mobType" in entity ||
      entity.type === "mob" ||
      entity.entityType === "mob" ||
      (entity.name &&
        /goblin|bandit|skeleton|zombie|rat|spider|wolf/i.test(entity.name));

    if (!isMob) {
      logger.debug(
        `[HyperiaPlugin] Entity ${entity.name} is not a mob, skipping`,
      );
      return;
    }

    logger.info(
      `[HyperiaPlugin] Mob removed: ${entity.name || entity.id} (likely killed)`,
    );

    // Update goal progress if we have a combat_training goal
    const behaviorManager = service.getBehaviorManager();
    const goal = behaviorManager?.getGoal();

    logger.debug(
      `[HyperiaPlugin] Current goal: ${goal ? `${goal.type} - ${goal.progress}/${goal.target}` : "none"}`,
    );

    if (goal?.type === "combat_training") {
      // Check if the killed target matches our goal target (if specified)
      const targetMatches =
        !goal.targetEntity ||
        (entity.name &&
          entity.name?.toLowerCase().includes(goal.targetEntity.toLowerCase()));

      logger.debug(
        `[HyperiaPlugin] Target match check: goalTarget="${goal.targetEntity}", entityName="${entity.name}", matches=${targetMatches}`,
      );

      if (targetMatches) {
        behaviorManager?.updateGoalProgress(1);
        logger.info(
          `[HyperiaPlugin] Goal progress updated: ${goal.progress + 1}/${goal.target} (mob removed: ${entity.name})`,
        );
      } else {
        logger.debug(
          `[HyperiaPlugin] Mob ${entity.name} doesn't match goal target ${goal.targetEntity}`,
        );
      }
    } else if (goal) {
      logger.debug(
        `[HyperiaPlugin] Goal type is ${goal.type}, not combat_training`,
      );
    }
  });

  // Track mob health to detect kills via ENTITY_UPDATED
  // This is the MAIN method for kill detection since mobs don't get removed - they respawn in place
  const previousMobHealth = new Map<string, number>();

  // Periodically prune stale entries to prevent unbounded growth
  // (mobs that were damaged but never killed won't be cleaned up otherwise)
  const MOB_HEALTH_PRUNE_INTERVAL = 60_000; // every 60s
  const MOB_HEALTH_MAX_ENTRIES = 100;
  const mobHealthPruneTimer = setInterval(() => {
    if (previousMobHealth.size > MOB_HEALTH_MAX_ENTRIES) {
      // Remove oldest entries (Map preserves insertion order)
      const excess = previousMobHealth.size - MOB_HEALTH_MAX_ENTRIES;
      const iter = previousMobHealth.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next();
        if (key.done) break;
        previousMobHealth.delete(key.value);
      }
    }
  }, MOB_HEALTH_PRUNE_INTERVAL);
  mobHealthPruneTimer.unref?.();

  logger.info(
    "[HyperiaPlugin] 📝 Registering ENTITY_UPDATED handler for kill tracking",
  );
  service.onGameEvent("ENTITY_UPDATED", async (data: unknown) => {
    const updateData = data as {
      id?: string;
      changes?: Record<string, unknown>;
      currentHealth?: number;
      maxHealth?: number;
      deathTime?: number | null;
      mobType?: string;
      type?: string;
    };

    // Extract entity ID and changes
    const entityId =
      updateData.id ||
      ((updateData as Record<string, unknown>).entityId as string);
    const changes = updateData.changes || updateData;

    if (!entityId) return;

    // Get entity from cache to check if it's a mob
    const entity = service.getGameState()?.nearbyEntities.get(entityId);
    const entityAny = (entity || changes) as Record<string, unknown>;

    // Check if this is a mob
    const isMob =
      entityAny.mobType !== undefined ||
      entityAny.type === "mob" ||
      (entity?.name &&
        /goblin|bandit|skeleton|zombie|rat|spider|wolf/i.test(entity.name));

    if (!isMob) return;

    // Get current health from changes
    const currentHealth = (changes as Record<string, unknown>).currentHealth as
      number | undefined;
    const deathTime = (changes as Record<string, unknown>).deathTime as
      number | null | undefined;
    const previousHealth = previousMobHealth.get(entityId);

    // Update tracked health
    if (currentHealth !== undefined) {
      previousMobHealth.set(entityId, currentHealth);
    }

    // Detect kill: health dropped to 0 OR deathTime was just set
    const healthDroppedToZero =
      currentHealth !== undefined &&
      currentHealth <= 0 &&
      (previousHealth === undefined || previousHealth > 0);
    const justDied =
      deathTime !== undefined && deathTime !== null && deathTime > 0;

    if (healthDroppedToZero || justDied) {
      const mobName = entity?.name || (entityAny.mobType as string) || entityId;
      logger.info(
        `[HyperiaPlugin] 💀 Mob killed detected: ${mobName} (health: ${previousHealth} → ${currentHealth}, deathTime: ${deathTime})`,
      );

      // Update goal progress if we have a combat_training goal
      const behaviorManager = service.getBehaviorManager();
      const goal = behaviorManager?.getGoal();

      if (goal?.type === "combat_training") {
        // Check if the killed target matches our goal target (if specified)
        const targetMatches =
          !goal.targetEntity ||
          mobName.toLowerCase().includes(goal.targetEntity.toLowerCase());

        if (targetMatches) {
          behaviorManager?.updateGoalProgress(1);
          logger.info(
            `[HyperiaPlugin] 🎯 Goal progress updated: ${goal.progress + 1}/${goal.target} (killed ${mobName})`,
          );
        } else {
          logger.debug(
            `[HyperiaPlugin] Mob ${mobName} doesn't match goal target ${goal.targetEntity}`,
          );
        }
      }

      // Clear this mob from tracking so we can detect the next kill after respawn
      previousMobHealth.delete(entityId);
    }
  });

  service.onGameEvent("ENTITY_DEATH", async (data: unknown) => {
    const eventData = data as { entityType?: string };
    if (eventData.entityType === "player") {
      await storeCombatMemory(runtime, "Player died in combat", data, [
        "combat",
        "death",
      ]);
      logger.warn("[HyperiaPlugin] Player died");
    }
  });

  // Resource gathering events
  service.onGameEvent("RESOURCE_GATHERED", async (data: unknown) => {
    const eventData = data as {
      resourceName: string;
      resourceType: string;
      position: [number, number, number];
      xpGained: number;
    };
    await storeResourceMemory(
      runtime,
      `Gathered ${eventData.resourceName}`,
      eventData,
      ["resource", "gathered", eventData.resourceType],
    );

    // Update goal progress if we have a woodcutting goal and gathered from a tree
    const behaviorManager = service.getBehaviorManager();
    const goal = behaviorManager?.getGoal();
    if (
      goal?.type === "woodcutting" &&
      (eventData.resourceType === "tree" ||
        eventData.resourceName.toLowerCase().includes("tree") ||
        eventData.resourceName.toLowerCase().includes("log"))
    ) {
      behaviorManager?.updateGoalProgress(1);
      logger.info(
        `[HyperiaPlugin] Goal progress updated: ${goal.progress + 1}/${goal.target} (gathered ${eventData.resourceName})`,
      );
    }
  });

  service.onGameEvent("RESOURCE_DEPLETED", async (data: unknown) => {
    const eventData = data as {
      resourceName: string;
      position: [number, number, number];
    };
    await storeResourceMemory(
      runtime,
      `${eventData.resourceName} depleted`,
      eventData,
      ["resource", "depleted"],
    );
  });

  service.onGameEvent("RESOURCE_RESPAWNED", async (data: unknown) => {
    const eventData = data as {
      resourceName: string;
      position: [number, number, number];
    };
    await storeResourceMemory(
      runtime,
      `${eventData.resourceName} respawned`,
      eventData,
      ["resource", "respawned"],
    );
    logger.info(
      `[HyperiaPlugin] Resource respawned: ${eventData.resourceName}`,
    );
  });

  // Track previous skill levels to detect level-ups from skillsUpdated
  let previousSkillLevels: Record<string, number> = {};

  // NOTE: SKILLS_LEVEL_UP is an internal server event NOT sent over WebSocket.
  // We keep this handler in case we add the packet in the future.
  service.onGameEvent("SKILLS_LEVEL_UP", async (data: unknown) => {
    const eventData = data as { skillName: string; newLevel: number };
    await handleSkillLevelUp(
      runtime,
      service,
      eventData.skillName,
      eventData.newLevel,
    );
  });

  // Detect level-ups from SKILLS_UPDATED packet by comparing with previous levels
  // This is the main way we detect skill level-ups since SKILLS_LEVEL_UP isn't sent over WebSocket
  service.onGameEvent("SKILLS_UPDATED", async (data: unknown) => {
    const skillsData = data as {
      skills?: Record<string, { level: number; xp: number }>;
    };

    if (!skillsData?.skills) {
      logger.debug(
        "[HyperiaPlugin] SKILLS_UPDATED received but no skills data",
      );
      return;
    }

    logger.debug(
      `[HyperiaPlugin] SKILLS_UPDATED received with ${Object.keys(skillsData.skills).length} skills`,
    );

    // Check each skill for level-ups
    for (const [skillName, skillInfo] of Object.entries(skillsData.skills)) {
      const previousLevel = previousSkillLevels[skillName] || 0;
      const newLevel = skillInfo.level;

      // Detect level-up (skip initial load where previousLevel is 0)
      if (previousLevel > 0 && newLevel > previousLevel) {
        logger.info(
          `[HyperiaPlugin] Detected level-up via SKILLS_UPDATED: ${skillName} ${previousLevel} → ${newLevel}`,
        );
        await handleSkillLevelUp(runtime, service, skillName, newLevel);
      } else if (previousLevel === 0) {
        logger.debug(
          `[HyperiaPlugin] Initial skill load: ${skillName} = ${newLevel}`,
        );
      }

      // Update tracked level
      previousSkillLevels[skillName] = newLevel;
    }
  });

  service.onGameEvent("SKILLS_XP_GAINED", async (data: unknown) => {
    const eventData = data as {
      skillName: string;
      xpGained: number;
      totalXp: number;
    };
    logger.debug(
      `[HyperiaPlugin] XP gained in ${eventData.skillName}: +${eventData.xpGained}`,
    );
  });

  // Inventory events
  service.onGameEvent("ITEM_PICKED_UP", async (data: unknown) => {
    const eventData = data as { itemName: string; quantity: number };
    logger.debug(
      `[HyperiaPlugin] Picked up: ${eventData.itemName} x${eventData.quantity}`,
    );
  });

  service.onGameEvent("ITEM_DROPPED", async (data: unknown) => {
    const eventData = data as {
      itemName?: string;
      itemId?: string;
      quantity: number;
    };
    logger.debug(
      `[HyperiaPlugin] Dropped: ${eventData.itemName ?? eventData.itemId ?? "unknown"} x${eventData.quantity}`,
    );
  });

  // Player interaction events
  service.onGameEvent("PLAYER_JOINED", async (data: unknown) => {
    const eventData = data as { playerName: string; playerId: string };
    await storeFactMemory(
      runtime,
      `Player ${eventData.playerName} joined`,
      eventData,
      ["player", "joined"],
    );
    logger.info(`[HyperiaPlugin] Player joined: ${eventData.playerName}`);
  });

  service.onGameEvent("PLAYER_LEFT", async (data: unknown) => {
    const eventData = data as { playerName: string; playerId: string };
    logger.info(`[HyperiaPlugin] Player left: ${eventData.playerName}`);
  });

  // Chat message handling - process through ElizaOS runtime
  service.onGameEvent("CHAT_MESSAGE", async (data: unknown) => {
    const chatData = data as {
      from: string;
      fromId: string | null;
      text: string;
      timestamp: number;
    };

    // Ignore system messages (from: "System" or fromId is null)
    if (chatData.from === "System" || !chatData.fromId) {
      logger.info(
        `[HyperiaPlugin] Ignoring system message: "${chatData.text}"`,
      );
      return;
    }

    // Ignore messages from the agent itself
    const agentCharacterId = service.getGameState()?.playerEntity?.id;
    if (chatData.fromId === agentCharacterId) {
      return;
    }

    logger.info(
      `[HyperiaPlugin] Chat message from ${chatData.from}: "${chatData.text}"`,
    );

    try {
      // Store chat message as memory for context
      await runtime.createMemory(
        {
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: runtime.agentId,
          content: {
            text: chatData.text,
            source: "hyperia_chat",
          },
        },
        "messages",
        false,
      );

      // Note: Chat messages from players are stored for context but not actively processed
      // The autonomous behavior manager handles action selection based on goals
      logger.info(
        `[HyperiaPlugin] Stored chat message from ${chatData.from} for context`,
      );
    } catch (error) {
      logger.error({ error }, "[HyperiaPlugin] Failed to store chat message:");
    }
  });

  logger.info("[HyperiaPlugin] Event handlers registered");
}

/**
 * Store combat event as memory
 */
async function storeCombatMemory(
  runtime: IAgentRuntime,
  description: string,
  data: unknown,
  tags: string[],
): Promise<void> {
  try {
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId, // Use agentId as fallback roomId
        content: {
          text: description,
          source: "hyperia_game_event",
        },
        metadata: {
          type: "custom",
          timestamp: Date.now(),
          tags: ["hyperia", "combat", ...tags],
        },
        // Don't pass embedding - let ElizaOS generate it
      },
      "facts",
      false,
    );

    logger.debug(`[HyperiaPlugin] Stored combat memory: ${description}`);
  } catch (error) {
    logger.error({ error }, "[HyperiaPlugin] Failed to store combat memory:");
  }
}

/**
 * Store resource event as memory
 */
async function storeResourceMemory(
  runtime: IAgentRuntime,
  description: string,
  data: unknown,
  tags: string[],
): Promise<void> {
  try {
    const eventData = data as {
      resourceName?: string;
      position?: [number, number, number];
    };

    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: {
          text: `${description}${eventData.position ? ` at [${eventData.position.join(", ")}]` : ""}`,
          source: "hyperia_game_event",
        },
        metadata: {
          type: "custom",
          timestamp: Date.now(),
          tags: ["hyperia", "resource", ...tags],
        },
        // Don't pass embedding - let ElizaOS generate it
      },
      "facts",
      false,
    );

    logger.debug(`[HyperiaPlugin] Stored resource memory: ${description}`);
  } catch (error) {
    logger.error({ error }, "[HyperiaPlugin] Failed to store resource memory:");
  }
}

/**
 * Store general fact as memory
 */
async function storeFactMemory(
  runtime: IAgentRuntime,
  description: string,
  data: unknown,
  tags: string[],
): Promise<void> {
  try {
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: {
          text: description,
          source: "hyperia_game_event",
        },
        metadata: {
          type: "custom",
          timestamp: Date.now(),
          tags: ["hyperia", ...tags],
        },
        // Don't pass embedding - let ElizaOS generate it
      },
      "facts",
      false,
    );

    logger.debug(`[HyperiaPlugin] Stored fact memory: ${description}`);
  } catch (error) {
    logger.error({ error }, "[HyperiaPlugin] Failed to store fact memory:");
  }
}

/**
 * Handle skill level-up - store memory and check goal completion
 */
async function handleSkillLevelUp(
  runtime: IAgentRuntime,
  service: HyperiaService,
  skillName: string,
  newLevel: number,
): Promise<void> {
  // Store memory
  await storeFactMemory(
    runtime,
    `Leveled up ${skillName} to level ${newLevel}`,
    { skillName, newLevel },
    ["skill", "levelup", skillName],
  );

  logger.info(`[HyperiaPlugin] Skill level up: ${skillName} → ${newLevel}`);

  // Check if we've reached our skill goal
  const behaviorManager = service.getBehaviorManager();
  const goal = behaviorManager?.getGoal();
  if (
    goal?.targetSkill &&
    goal.targetSkillLevel &&
    skillName.toLowerCase() === goal.targetSkill.toLowerCase()
  ) {
    // Update goal progress to current skill level
    behaviorManager?.setSkillProgress(newLevel);

    if (newLevel >= goal.targetSkillLevel) {
      logger.info(
        `[HyperiaPlugin] 🎯 Skill goal COMPLETE! Reached ${skillName} level ${newLevel} (target was ${goal.targetSkillLevel})`,
      );
      behaviorManager?.clearGoal();
    } else {
      logger.info(
        `[HyperiaPlugin] 🎯 Skill goal progress: ${skillName} ${newLevel}/${goal.targetSkillLevel}`,
      );
    }
  }
}
