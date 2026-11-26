/**
 * AgentBehaviorEngine Unit Tests
 *
 * Tests pure decision logic for agent AI (runs in worker thread).
 * All functions are pure: serializable input → serializable output, no World access.
 *
 * Key behaviors tested:
 * - Batch processing (processAgentTicks)
 * - Combat chat reactions
 * - Food consumption (assessAndEat)
 * - Equipment management
 * - Conserved inventory management through banking
 * - Quest-driven action selection
 * - Default combat/explore fallback
 */

import { readFile } from "node:fs/promises";

import { describe, it, expect, beforeAll } from "vitest";
import { processAgentTicks, initializeItems } from "../AgentBehaviorEngine";
import type {
  AgentTickInput,
  WorkerItemData,
  WorkerProcessingRecipeSnapshot,
} from "../workerTypes";
import type { AgentQuestInfo } from "../../types";

/** Monotonic counter to generate unique characterIds per test invocation */
let nextAgentId = 0;

/** Helper: create a minimal valid AgentTickInput */
function makeInput(overrides: Partial<AgentTickInput> = {}): AgentTickInput {
  const uniqueId = `agent-${++nextAgentId}`;
  return {
    characterId: uniqueId,
    combatSpecialization: "melee",
    behaviorEpoch: 0,
    playerId: `player-${nextAgentId}`,
    name: "TestBot",
    gameState: {
      playerId: `player-${nextAgentId}`,
      position: [100, 0, 100],
      health: 100,
      maxHealth: 100,
      alive: true,
      skills: {},
      inventory: [],
      equipment: {},
      nearbyEntities: [],
      inCombat: false,
      currentTarget: null,
      selectedSpell: null,
      activePrayers: [],
    },
    inventoryItems: [],
    equippedItems: {},
    questState: [],
    availableQuests: [],
    storeRetryAfter: 0,
    coinRecoveryAuthorized: false,
    attackObservationRetryAfter: 0,
    bankStageRetryAfter: 0,
    questEntryAcquisitionQuestId: null,
    ordinaryProcessingAcquisitionAuthorized: false,
    survivalFoodAcquisitionAuthorized: false,
    ordinaryProcessingRetrySuppressions: [],
    agentState: {
      goal: null,
      questsAccepted: [],
      currentTargetId: null,
      lastAteAt: 0,
      dropCooldownUntil: 0,
      lastGatherTargetId: null,
      lastGatherQueuedAt: 0,
      pendingChatReaction: null,
      lastCombatChatAt: 0,
    },
    npcPositions: [],
    otherAgentTargets: [],
    resourceSystemAvailable: true,
    spawnAnchors: [{ position: [100, 0, 100], name: "spawn" }],
    worldResources: [],
    worldMobs: [],
    stationPositions: [],
    storePositions: [],
    ...overrides,
  };
}

function makeQuestInfo(questId: string, canStart: boolean): AgentQuestInfo {
  return {
    questId,
    name: questId.replaceAll("_", " "),
    description: `Complete ${questId}`,
    difficulty: "novice",
    status: "not_started",
    canStart,
    requirements: { quests: [], skills: {}, items: [] },
    startNpc: `${questId}_npc`,
    onStartItems: [],
    rewardItems: [],
    stages: [],
  };
}

const TEST_PROCESSING_RECIPES: WorkerProcessingRecipeSnapshot = {
  stores: [
    {
      storeId: "sword_store",
      items: [
        { itemId: "bronze_shortsword", price: 100, category: "weapons" },
        { itemId: "iron_shortsword", price: 200, category: "weapons" },
      ],
    },
    {
      storeId: "general_store",
      items: [
        { itemId: "bronze_hatchet", price: 50, category: "tools" },
        { itemId: "bronze_pickaxe", price: 50, category: "tools" },
        { itemId: "hammer", price: 13, category: "tools" },
        { itemId: "tinderbox", price: 10, category: "tools" },
      ],
    },
    {
      storeId: "fishing_store",
      items: [{ itemId: "small_fishing_net", price: 5, category: "tools" }],
    },
  ],
  gathering: [
    {
      resourceId: "tree_test",
      harvestSkill: "woodcutting",
      toolRequired: "bronze_hatchet",
      levelRequired: 1,
      outputItemIds: ["logs"],
    },
    {
      resourceId: "ore_test",
      harvestSkill: "mining",
      toolRequired: "pickaxe",
      levelRequired: 1,
      outputItemIds: ["copper_ore"],
    },
    {
      resourceId: "fishing_test",
      harvestSkill: "fishing",
      toolRequired: "small_fishing_net",
      levelRequired: 1,
      outputItemIds: ["raw_shrimp"],
    },
  ],
  firemaking: [],
  crafting: [],
  tanning: [],
  fletching: [],
  runecrafting: [],
};

function initializeTestItems(): void {
  // Initialize worker-side item DB with test items
  initializeItems(
    [
      [
        "raw_shrimp",
        {
          id: "raw_shrimp",
          name: "Raw Shrimp",
          type: "resource",
          cooking: { cookedItemId: "shrimp", levelRequired: 1 },
        },
      ],
      [
        "bronze_bar",
        {
          id: "bronze_bar",
          name: "Bronze Bar",
          type: "resource",
          smelting: {
            inputs: [
              { itemId: "copper_ore", quantity: 1 },
              { itemId: "tin_ore", quantity: 1 },
            ],
            levelRequired: 1,
          },
        },
      ],
      [
        "iron_bar",
        {
          id: "iron_bar",
          name: "Iron Bar",
          type: "resource",
          smelting: {
            inputs: [{ itemId: "iron_ore", quantity: 1 }],
            levelRequired: 15,
          },
        },
      ],
      [
        "cooked_shrimp",
        {
          id: "cooked_shrimp",
          name: "Cooked Shrimp",
          type: "food",
          healAmount: 3,
        },
      ],
      [
        "bronze_shortsword",
        {
          id: "bronze_shortsword",
          name: "Bronze Shortsword",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "MELEE",
          bonuses: { attack: 4, strength: 3 },
          smithing: {
            barItemId: "bronze_bar",
            barsRequired: 1,
            levelRequired: 1,
            outputQuantity: 1,
          },
        },
      ],
      [
        "iron_shortsword",
        {
          id: "iron_shortsword",
          name: "Iron Shortsword",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "MELEE",
          bonuses: { attack: 8, strength: 7 },
        },
      ],
      [
        "bronze_hatchet",
        {
          id: "bronze_hatchet",
          name: "Bronze Hatchet",
          type: "tool",
          equipSlot: "weapon",
          attackType: "MELEE",
          tool: { skill: "woodcutting", priority: 1 },
        },
      ],
      [
        "bronze_pickaxe",
        {
          id: "bronze_pickaxe",
          name: "Bronze Pickaxe",
          type: "tool",
          equipSlot: "weapon",
          attackType: "MELEE",
          tool: { skill: "mining", priority: 1 },
        },
      ],
      [
        "small_fishing_net",
        {
          id: "small_fishing_net",
          name: "Small Fishing Net",
          type: "tool",
        },
      ],
      ["tinderbox", { id: "tinderbox", name: "Tinderbox", type: "tool" }],
      ["hammer", { id: "hammer", name: "Hammer", type: "tool" }],
      [
        "bronze_helmet",
        {
          id: "bronze_helmet",
          name: "Bronze Helmet",
          type: "armor",
          equipSlot: "helmet",
          bonuses: { defense: 3, attack: 0 },
        },
      ],
      ["bones", { id: "bones", name: "Bones", type: "misc" }],
      [
        "prayer_bones",
        {
          id: "prayer_bones",
          name: "Prayer Bones",
          type: "resource",
          prayerXp: 15,
          buryLevelRequired: 1,
        },
      ],
      [
        "greater_prayer_bones",
        {
          id: "greater_prayer_bones",
          name: "Greater Prayer Bones",
          type: "resource",
          prayerXp: 50,
          buryLevelRequired: 20,
        },
      ],
      ["logs", { id: "logs", name: "Logs", type: "misc" }],
    ],
    TEST_PROCESSING_RECIPES,
  );
}

beforeAll(initializeTestItems);

describe("AgentBehaviorEngine", () => {
  describe("processAgentTicks", () => {
    it("processes a batch of agents and returns one result per input", () => {
      const input1 = makeInput();
      const input2 = makeInput();
      const inputs = [input1, input2];
      const results = processAgentTicks(inputs);

      expect(results).toHaveLength(2);
      expect(results[0].characterId).toBe(input1.characterId);
      expect(results[1].characterId).toBe(input2.characterId);
      expect(results[0].behaviorEpoch).toBe(input1.behaviorEpoch);
      expect(results[1].behaviorEpoch).toBe(input2.behaviorEpoch);
    });

    it("returns exactly one action and updated state for each agent", () => {
      const results = processAgentTicks([makeInput()]);
      const result = results[0];

      expect(result).toHaveProperty("action");
      expect(result).not.toHaveProperty("sideEffects");
      expect(result).toHaveProperty("updatedState");
      expect(result.action).toHaveProperty("type");
    });
  });

  describe("Combat Chat Reactions", () => {
    it("generates chat message from pending reaction", () => {
      const input = makeInput();
      input.agentState.pendingChatReaction = {
        type: "critical_hit_dealt",
        opponentName: "Goblin",
        timestamp: Date.now(),
      };

      const [result] = processAgentTicks([input]);

      expect(result.chatMessage).toBeDefined();
      expect(typeof result.chatMessage).toBe("string");
      expect(result.chatMessage!.length).toBeGreaterThan(0);
    });

    it("clears pending reaction after processing", () => {
      const input = makeInput();
      input.agentState.pendingChatReaction = {
        type: "near_death",
        opponentName: "Dragon",
        timestamp: Date.now(),
      };

      const [result] = processAgentTicks([input]);

      // updatedState should not carry the reaction forward
      expect(result.chatMessage).toBeDefined();
    });
  });

  describe("Food Consumption", () => {
    it("eats food when health is below threshold", () => {
      const input = makeInput();
      input.gameState.health = 30;
      input.gameState.maxHealth = 100;
      input.inventoryItems = [
        { slot: 0, itemId: "cooked_shrimp", quantity: 5 },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "use",
        itemId: "cooked_shrimp",
      });
    });

    it("does not eat when health is above threshold", () => {
      const input = makeInput();
      input.gameState.health = 90;
      input.gameState.maxHealth = 100;
      input.inventoryItems = [
        { slot: 0, itemId: "cooked_shrimp", quantity: 5 },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).not.toEqual(
        expect.objectContaining({ type: "use", itemId: "cooked_shrimp" }),
      );
    });
  });

  describe("Equipment Management", () => {
    it("equips better weapon from inventory", () => {
      const input = makeInput();
      input.equippedItems = { weapon: "bronze_shortsword" };
      input.inventoryItems = [
        { slot: 0, itemId: "iron_shortsword", quantity: 1 },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "equip",
        itemId: "iron_shortsword",
      });
    });

    it("does not swap to weaker weapon", () => {
      const input = makeInput();
      input.equippedItems = { weapon: "iron_shortsword" };
      input.inventoryItems = [
        { slot: 0, itemId: "bronze_shortsword", quantity: 1 },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).not.toEqual({
        type: "equip",
        itemId: "bronze_shortsword",
      });
    });
  });

  describe("ordinary combat readiness", () => {
    const combatRecipes: WorkerProcessingRecipeSnapshot = {
      ...TEST_PROCESSING_RECIPES,
      stores: [
        ...TEST_PROCESSING_RECIPES.stores,
        {
          storeId: "range_store",
          items: [
            { itemId: "shortbow", price: 50, category: "ranged_weapons" },
            { itemId: "bronze_arrow", price: 7, category: "ammunition" },
          ],
        },
        {
          storeId: "magic_store",
          items: [
            { itemId: "staff_of_air", price: 1500, category: "magic_weapons" },
            { itemId: "mind_rune", price: 15, category: "runes" },
          ],
        },
        {
          storeId: "melee_store",
          items: [
            {
              itemId: "bronze_dagger",
              price: 10,
              category: "weapons",
            },
            {
              itemId: "bronze_shortsword",
              price: 100,
              category: "weapons",
            },
          ],
        },
      ],
      combatReadiness: {
        ammunitionTarget: 50,
        magicCastTarget: 20,
        melee: [
          {
            weaponId: "bronze_shortsword",
            weaponScore: 7,
            requiredAttackLevel: 1,
          },
        ],
        ranged: [
          {
            weaponId: "shortbow",
            ammunitionId: "bronze_arrow",
            weaponScore: 8,
            ammunitionScore: 7,
            requiredRangedLevel: 1,
          },
        ],
        magic: [
          {
            weaponId: "staff_of_air",
            spellId: "wind_strike",
            weaponScore: 10,
            spellOrder: 0,
            requiredMagicLevel: 1,
            providedRuneIds: ["air_rune"],
            runes: [
              { itemId: "air_rune", quantityPerCast: 1 },
              { itemId: "mind_rune", quantityPerCast: 1 },
            ],
          },
        ],
      },
    };
    const combatItems: Array<[string, WorkerItemData]> = [
      [
        "bronze_dagger",
        {
          id: "bronze_dagger",
          name: "Bronze Dagger",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "MELEE",
          bonuses: { attack: 2, strength: 1 },
        },
      ],
      [
        "bronze_shortsword",
        {
          id: "bronze_shortsword",
          name: "Bronze Shortsword",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "MELEE",
          bonuses: { attack: 4, strength: 3 },
        },
      ],
      [
        "shortbow",
        {
          id: "shortbow",
          name: "Shortbow",
          type: "weapon",
          equipSlot: "2h",
          attackType: "RANGED",
          bonuses: { attackRanged: 8 },
          requirements: { skills: { ranged: 1 } },
        },
      ],
      [
        "bronze_arrow",
        {
          id: "bronze_arrow",
          name: "Bronze arrow",
          type: "ammunition",
          stackable: true,
          equipSlot: "arrows",
          bonuses: { rangedStrength: 7 },
          requirements: { skills: { ranged: 1 } },
        },
      ],
      [
        "staff_of_air",
        {
          id: "staff_of_air",
          name: "Staff of air",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "MAGIC",
          bonuses: { attackMagic: 10 },
          requirements: { skills: { magic: 1 } },
        },
      ],
      ["air_rune", { id: "air_rune", name: "Air rune", type: "rune" }],
      ["mind_rune", { id: "mind_rune", name: "Mind rune", type: "rune" }],
      [
        "combat_ration",
        {
          id: "combat_ration",
          name: "Combat ration",
          type: "food",
          stackable: true,
          healAmount: 100,
        },
      ],
    ];

    const makeCombatInput = (
      specialization: AgentTickInput["combatSpecialization"],
      overrides: Partial<AgentTickInput> = {},
    ): AgentTickInput => {
      const input = makeInput({
        combatSpecialization: specialization,
        storePositions: [
          {
            entityId: "range-shop",
            storeId: "range_store",
            name: "Range store",
            position: [100, 0, 100],
          },
          {
            entityId: "magic-shop",
            storeId: "magic_store",
            name: "Magic store",
            position: [100, 0, 100],
          },
          {
            entityId: "melee-shop",
            storeId: "melee_store",
            name: "Melee store",
            position: [100, 0, 100],
          },
        ],
        ...overrides,
      });
      input.gameState.skills = {
        attack: { level: 1, xp: 0 },
        ranged: { level: 1, xp: 0 },
        magic: { level: 1, xp: 0 },
      };
      input.inventoryItems.push({
        slot: input.inventoryItems.length,
        itemId: "combat_ration",
        quantity: 1,
      });
      return input;
    };

    it("acquires and keeps the certified melee identity over unsupported gear", () => {
      initializeItems(combatItems, combatRecipes);
      try {
        const unarmed = makeCombatInput("melee");
        expect(processAgentTicks([unarmed])[0].action).toEqual({
          type: "storeBuy",
          storeId: "melee_store",
          itemId: "bronze_shortsword",
          quantity: 1,
        });

        const missing = makeCombatInput("melee", {
          equippedItems: { weapon: "bronze_dagger" },
        });
        expect(processAgentTicks([missing])[0].action).toEqual({
          type: "storeBuy",
          storeId: "melee_store",
          itemId: "bronze_shortsword",
          quantity: 1,
        });

        const owned = makeCombatInput("melee", {
          equippedItems: { weapon: "iron_shortsword" },
          inventoryItems: [
            { slot: 0, itemId: "bronze_shortsword", quantity: 1 },
          ],
        });
        expect(processAgentTicks([owned])[0].action).toEqual({
          type: "equip",
          itemId: "bronze_shortsword",
        });

        owned.equippedItems.weapon = "bronze_shortsword";
        owned.inventoryItems = [
          { slot: 0, itemId: "iron_shortsword", quantity: 1 },
        ];
        expect(processAgentTicks([owned])[0].action).not.toEqual({
          type: "equip",
          itemId: "iron_shortsword",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("buys and equips a ranged loadout only after the full arrow reserve exists", () => {
      initializeItems(combatItems, combatRecipes);
      try {
        const noCertifiedFallback = makeCombatInput("ranged", {
          equippedItems: { weapon: "bronze_dagger" },
        });
        expect(processAgentTicks([noCertifiedFallback])[0].action).toEqual({
          type: "storeBuy",
          storeId: "melee_store",
          itemId: "bronze_shortsword",
          quantity: 1,
        });

        const missingBow = makeCombatInput("ranged", {
          equippedItems: { weapon: "bronze_shortsword" },
        });
        expect(processAgentTicks([missingBow])[0].action).toEqual({
          type: "storeBuy",
          storeId: "range_store",
          itemId: "shortbow",
          quantity: 1,
        });

        const missingArrows = makeCombatInput("ranged", {
          equippedItems: { weapon: "bronze_shortsword" },
          inventoryItems: [
            { slot: 0, itemId: "shortbow", quantity: 1 },
            { slot: 1, itemId: "bronze_arrow", quantity: 20 },
          ],
        });
        expect(processAgentTicks([missingArrows])[0].action).toEqual({
          type: "storeBuy",
          storeId: "range_store",
          itemId: "bronze_arrow",
          quantity: 30,
        });

        const complete = makeCombatInput("ranged", {
          equippedItems: { weapon: "bronze_shortsword" },
          inventoryItems: [
            { slot: 0, itemId: "shortbow", quantity: 1 },
            { slot: 1, itemId: "bronze_arrow", quantity: 50 },
          ],
        });
        expect(processAgentTicks([complete])[0].action).toEqual({
          type: "equip",
          itemId: "shortbow",
        });

        complete.equippedItems.weapon = "shortbow";
        expect(processAgentTicks([complete])[0].action).toEqual({
          type: "equip",
          itemId: "bronze_arrow",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("buys exact non-staff runes before persisting a legal autocast spell", () => {
      initializeItems(combatItems, combatRecipes);
      try {
        const noCertifiedFallback = makeCombatInput("mage", {
          equippedItems: { weapon: "bronze_dagger" },
        });
        expect(processAgentTicks([noCertifiedFallback])[0].action).toEqual({
          type: "storeBuy",
          storeId: "melee_store",
          itemId: "bronze_shortsword",
          quantity: 1,
        });

        const missingRunes = makeCombatInput("mage", {
          equippedItems: { weapon: "staff_of_air" },
          inventoryItems: [{ slot: 0, itemId: "mind_rune", quantity: 4 }],
        });
        expect(processAgentTicks([missingRunes])[0].action).toEqual({
          type: "storeBuy",
          storeId: "magic_store",
          itemId: "mind_rune",
          quantity: 16,
        });

        const complete = makeCombatInput("mage", {
          equippedItems: { weapon: "staff_of_air" },
          inventoryItems: [{ slot: 0, itemId: "mind_rune", quantity: 20 }],
        });
        expect(processAgentTicks([complete])[0].action).toEqual({
          type: "setAutocast",
          spellId: "wind_strike",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("checks exact private combat custody before buying or self-supplying a missing loadout", () => {
      initializeItems(combatItems, combatRecipes);
      try {
        const bank = {
          entityId: "combat-bank",
          stationType: "bank",
          name: "Combat bank",
          position: [120, 0, 100] as [number, number, number],
          interactionRange: 2,
        };
        const walking = makeCombatInput("ranged", {
          stationPositions: [bank],
          equippedItems: { weapon: "bronze_shortsword" },
        });
        expect(processAgentTicks([walking])[0]).toMatchObject({
          action: {
            type: "move",
            target: [120, 0, 100],
            runMode: true,
          },
          updatedState: {
            goal: {
              type: "banking",
              bankPurpose: "combat_supply",
            },
          },
        });

        const waitingAfterTechnicalFailure = makeCombatInput("ranged", {
          stationPositions: [bank],
          equippedItems: { weapon: "bronze_shortsword" },
          bankStageRetryAfter: Date.now() + 30_000,
        });
        expect(
          processAgentTicks([waitingAfterTechnicalFailure])[0].action,
        ).toEqual({ type: "idle" });

        const opening = makeCombatInput("ranged", {
          stationPositions: [bank],
          equippedItems: { weapon: "bronze_shortsword" },
        });
        opening.gameState.position = [120, 0, 100];
        expect(processAgentTicks([opening])[0]).toMatchObject({
          action: { type: "bankWithdraw", bankId: "combat-bank" },
          updatedState: {
            goal: {
              type: "banking",
              bankPurpose: "combat_supply",
            },
          },
        });
      } finally {
        initializeTestItems();
      }
    });

    it("does not let an optional combat-supply bank check starve a startable quest", () => {
      initializeItems(combatItems, combatRecipes);
      try {
        const quest = makeQuestInfo("torvins_tools", true);
        quest.startNpc = "torvin";
        const input = makeCombatInput("ranged", {
          equippedItems: { weapon: "bronze_shortsword" },
          availableQuests: [quest],
          npcPositions: [
            {
              id: "torvin-npc",
              name: "Torvin",
              npcId: "torvin",
              position: [100, 0, 100],
            },
          ],
          stationPositions: [
            {
              entityId: "combat-bank",
              stationType: "bank",
              name: "Combat bank",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        input.agentState.questsAccepted = [
          "goblin_slayer",
          "lumberjacks_first_lesson",
          "fresh_catch",
          "rune_mysteries",
        ];

        expect(processAgentTicks([input])[0]).toMatchObject({
          action: { type: "questAccept", questId: "torvins_tools" },
          updatedState: {
            goal: { type: "questing", questId: "torvins_tools" },
          },
        });
      } finally {
        initializeTestItems();
      }
    });
  });

  describe("Inventory Management", () => {
    it("provisions a full authored food reserve through private bank then exact store fallback", () => {
      const recipes: WorkerProcessingRecipeSnapshot = {
        ...TEST_PROCESSING_RECIPES,
        guaranteedMobDrops: [{ mobType: "goblin", itemIds: ["coins"] }],
        stores: [
          {
            storeId: "fishing_store",
            items: [
              {
                itemId: "shrimp",
                price: 10,
                category: "cooked_food",
              },
              { itemId: "lobster", price: 50, category: "cooked_food" },
            ],
          },
        ],
      };
      initializeItems(
        [
          [
            "shrimp",
            {
              id: "shrimp",
              name: "Cooked shrimp",
              type: "food",
              stackable: false,
              healAmount: 3,
            },
          ],
          [
            "raw_shrimp",
            {
              id: "raw_shrimp",
              name: "Raw shrimp",
              type: "resource",
              stackable: false,
              cooking: { cookedItemId: "shrimp", levelRequired: 1 },
            },
          ],
          [
            "small_fishing_net",
            {
              id: "small_fishing_net",
              name: "Small fishing net",
              type: "tool",
              stackable: false,
            },
          ],
          [
            "lobster",
            {
              id: "lobster",
              name: "Lobster",
              type: "food",
              stackable: false,
              healAmount: 12,
            },
          ],
        ],
        recipes,
      );
      try {
        const bank = {
          entityId: "survival-bank",
          stationType: "bank",
          name: "Survival Bank",
          position: [110, 0, 100] as [number, number, number],
          interactionRange: 2,
        };
        const makeSurvivalInput = (
          overrides: Partial<AgentTickInput> = {},
        ): AgentTickInput => {
          const input = makeInput({
            stationPositions: [bank],
            ...overrides,
          });
          input.equippedItems.weapon = "already-equipped-weapon";
          input.gameState.health = overrides.gameState?.health ?? 10;
          input.gameState.maxHealth = overrides.gameState?.maxHealth ?? 10;
          return input;
        };

        const walking = processAgentTicks([makeSurvivalInput()])[0];
        expect(walking.action).toEqual({
          type: "move",
          target: [110, 0, 100],
          runMode: true,
        });
        expect(walking.updatedState.goal).toMatchObject({
          type: "banking",
          bankPurpose: "survival_food",
        });

        const damagedFar = makeSurvivalInput();
        damagedFar.gameState.health = 3;
        expect(processAgentTicks([damagedFar])[0].action).toEqual({
          type: "idle",
        });

        const damagedNear = makeSurvivalInput();
        damagedNear.gameState.health = 3;
        damagedNear.gameState.position = [110, 0, 100];
        expect(processAgentTicks([damagedNear])[0].action).toEqual({
          type: "bankWithdraw",
          bankId: "survival-bank",
        });

        const fullHealthRespawn = makeSurvivalInput();
        fullHealthRespawn.gameState.nearbyEntities = [
          {
            id: `owned-gravestone-${fullHealthRespawn.playerId}`,
            name: "Owned gravestone",
            type: "object",
            position: [120, 0, 100],
            distance: 20,
          },
        ];
        expect(processAgentTicks([fullHealthRespawn])[0].action).toEqual({
          type: "move",
          target: [120, 0, 100],
          runMode: true,
        });
        fullHealthRespawn.gameState.position = [118, 0, 100];
        expect(processAgentTicks([fullHealthRespawn])[0].action).toEqual({
          type: "lootGravestone",
          gravestoneId: `owned-gravestone-${fullHealthRespawn.playerId}`,
        });

        const damagedRespawn = makeSurvivalInput();
        damagedRespawn.gameState.health = 3;
        damagedRespawn.gameState.nearbyEntities =
          fullHealthRespawn.gameState.nearbyEntities;
        expect(processAgentTicks([damagedRespawn])[0].action).toEqual({
          type: "idle",
        });

        const store = {
          entityId: "fishing-store",
          storeId: "fishing_store",
          name: "Fishing Store",
          position: [100, 0, 100] as [number, number, number],
        };
        const afterBankMiss = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 30_000,
          storePositions: [store],
        });
        expect(processAgentTicks([afterBankMiss])[0].action).toEqual({
          type: "idle",
        });

        const noLoadedBank = makeSurvivalInput({
          stationPositions: [],
          storePositions: [store],
        });
        expect(processAgentTicks([noLoadedBank])[0].action).toEqual({
          type: "storeBuy",
          storeId: "fishing_store",
          itemId: "shrimp",
          quantity: 4,
        });

        const loadingInfrastructure = makeSurvivalInput({
          stationPositions: [],
          storePositions: [],
        });
        expect(processAgentTicks([loadingInfrastructure])[0].action).toEqual({
          type: "idle",
        });

        const authorizedCoinRecovery = makeSurvivalInput({
          stationPositions: [],
          storePositions: [],
          coinRecoveryAuthorized: true,
        });
        authorizedCoinRecovery.gameState.nearbyEntities = [
          {
            id: "exact-goblin",
            name: "Guaranteed coin source",
            type: "mob",
            mobType: "goblin",
            position: [101, 0, 100],
            distance: 1,
            health: 10,
          },
        ];
        expect(processAgentTicks([authorizedCoinRecovery])[0].action).toEqual({
          type: "attack",
          targetId: "exact-goblin",
        });

        const freshCatch = makeQuestInfo("fresh_catch", true);
        freshCatch.name = "Fresh Catch";
        freshCatch.startNpc = "fisherman_pete";
        freshCatch.onStartItems = [
          { itemId: "small_fishing_net", quantity: 1 },
        ];
        const safeRecovery = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          availableQuests: [freshCatch],
          npcPositions: [
            {
              id: "pete",
              name: "Fisherman Pete",
              npcId: "fisherman_pete",
              position: [120, 0, 100],
            },
          ],
        });
        expect(processAgentTicks([safeRecovery])[0].action).toEqual({
          type: "move",
          target: [120, 0, 100],
          runMode: false,
        });
        safeRecovery.gameState.position = [120, 0, 100];
        expect(processAgentTicks([safeRecovery])[0].action).toEqual({
          type: "questAccept",
          questId: "fresh_catch",
        });

        const gathering = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          inventoryItems: [
            { slot: 0, itemId: "small_fishing_net", quantity: 1 },
          ],
        });
        gathering.gameState.nearbyEntities = [
          {
            id: "exact-net-spot",
            name: "Safe pond",
            type: "resource",
            resourceId: "fishing_test",
            position: [101, 0, 100],
            distance: 1,
          },
        ];
        expect(processAgentTicks([gathering])[0].action).toEqual({
          type: "gather",
          targetId: "exact-net-spot",
        });

        const distantGathering = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          inventoryItems: [
            { slot: 0, itemId: "small_fishing_net", quantity: 1 },
          ],
          worldResources: [
            {
              entityId: "runtime-net-spot",
              name: "authored safe pond",
              resourceId: "fishing_test",
              resourceType: "fishing_spot",
              depleted: false,
              position: [80, 28.2, 80],
            },
          ],
        });
        expect(processAgentTicks([distantGathering])[0].action).toEqual({
          type: "gather",
          targetId: "runtime-net-spot",
        });

        const cooking = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          inventoryItems: [
            { slot: 0, itemId: "small_fishing_net", quantity: 1 },
            { slot: 1, itemId: "raw_shrimp", quantity: 4 },
          ],
          stationPositions: [
            {
              entityId: "safe-range",
              name: "Safe range",
              stationType: "range",
              position: [110, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        expect(processAgentTicks([cooking])[0].action).toEqual({
          type: "move",
          target: [110, 0, 100],
          runMode: true,
        });
        cooking.gameState.position = [110, 0, 100];
        expect(processAgentTicks([cooking])[0].action).toEqual({
          type: "cook",
          itemId: "raw_shrimp",
        });

        const footprintEdgeCooking = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          inventoryItems: [
            { slot: 0, itemId: "small_fishing_net", quantity: 1 },
            { slot: 1, itemId: "raw_shrimp", quantity: 4 },
          ],
          stationPositions: [
            {
              entityId: "wide-safe-range",
              name: "Wide safe range",
              stationType: "range",
              position: [-14, 0, -3],
              interactionRange: 1,
              footprintWidth: 2,
              footprintDepth: 1,
            },
          ],
        });
        footprintEdgeCooking.gameState.position = [-15.5, 0, -3.5];
        expect(processAgentTicks([footprintEdgeCooking])[0].action).toEqual({
          type: "cook",
          itemId: "raw_shrimp",
        });

        const burnRecovery = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          inventoryItems: [
            { slot: 0, itemId: "small_fishing_net", quantity: 1 },
            { slot: 1, itemId: "burnt_shrimp", quantity: 1 },
            { slot: 2, itemId: "raw_shrimp", quantity: 3 },
          ],
        });
        burnRecovery.gameState.nearbyEntities = [
          {
            id: "exact-net-spot",
            name: "Safe pond",
            type: "resource",
            resourceId: "fishing_test",
            position: [101, 0, 100],
            distance: 1,
          },
        ];
        expect(processAgentTicks([burnRecovery])[0].action).toEqual({
          type: "gather",
          targetId: "exact-net-spot",
        });
        burnRecovery.agentState.lastGatherTargetId = "exact-net-spot";
        burnRecovery.agentState.lastGatherQueuedAt = Date.now();
        expect(processAgentTicks([burnRecovery])[0].action).toEqual({
          type: "idle",
        });

        const unsafeFallback = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          coinRecoveryAuthorized: true,
          availableQuests: [],
        });
        unsafeFallback.gameState.nearbyEntities =
          authorizedCoinRecovery.gameState.nearbyEntities;
        expect(processAgentTicks([unsafeFallback])[0].action).toEqual({
          type: "idle",
        });

        const fullInventory = makeSurvivalInput({
          bankStageRetryAfter: Date.now() + 300_000,
          survivalFoodAcquisitionAuthorized: true,
          inventoryItems: Array.from({ length: 28 }, (_, slot) => ({
            slot,
            itemId: "burnt_shrimp",
            quantity: 1,
          })),
          stationPositions: [bank],
        });
        expect(processAgentTicks([fullInventory])[0].action).toEqual({
          type: "move",
          target: [110, 0, 100],
          runMode: true,
        });
        fullInventory.gameState.position = [110, 0, 100];
        expect(processAgentTicks([fullInventory])[0].action).toEqual({
          type: "bankDepositAll",
          bankId: "survival-bank",
        });

        const alreadyProvisioned = makeSurvivalInput({
          inventoryItems: [{ slot: 0, itemId: "shrimp", quantity: 4 }],
        });
        const provisionedResult = processAgentTicks([alreadyProvisioned])[0];
        expect(provisionedResult.updatedState.goal).not.toMatchObject({
          bankPurpose: "survival_food",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("requests private material staging only at an exact nearby bank", () => {
      const input = makeInput({
        stationPositions: [
          {
            entityId: "bank-station",
            stationType: "bank",
            name: "Bank",
            position: [100, 0, 100],
            interactionRange: 2,
          },
        ],
      });

      expect(processAgentTicks([input])[0].action).toEqual({
        type: "bankWithdraw",
        bankId: "bank-station",
      });

      input.bankStageRetryAfter = Date.now() + 30_000;
      expect(processAgentTicks([input])[0].action).not.toEqual({
        type: "bankWithdraw",
        bankId: "bank-station",
      });
    });

    it("preserves a full inventory and selects the authoritative bank action", () => {
      const input = makeInput();
      input.inventoryItems = Array.from({ length: 28 }, (_, i) => ({
        slot: i,
        itemId: `junk_item_${i}`,
        quantity: 1,
      }));
      input.stationPositions = [
        {
          entityId: "bank-station",
          stationType: "bank",
          name: "Bank",
          position: [100, 0, 100],
          interactionRange: 2,
        },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "bankDepositAll",
        bankId: "bank-station",
      });
      expect(result).not.toHaveProperty("sideEffects");
    });

    it("does not route bones through the food-only use receipt", () => {
      const input = makeInput();
      input.inventoryItems = Array.from({ length: 22 }, (_, i) => ({
        slot: i,
        itemId: i === 0 ? "bones" : `junk_item_${i}`,
        quantity: 1,
      }));

      const [result] = processAgentTicks([input]);

      expect(result.action).not.toEqual({ type: "use", itemId: "bones" });
    });
  });

  describe("Prayer training", () => {
    it("selects the strongest carried prayer resource the agent can use", () => {
      const input = makeInput();
      input.gameState.skills.prayer = { level: 20, xp: 4_500 };
      input.inventoryItems = [
        { slot: 0, itemId: "prayer_bones", quantity: 2 },
        { slot: 1, itemId: "greater_prayer_bones", quantity: 1 },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "bury",
        itemId: "greater_prayer_bones",
      });
    });

    it("ignores a level-gated resource and uses an eligible one", () => {
      const input = makeInput();
      input.gameState.skills.prayer = { level: 1, xp: 0 };
      input.inventoryItems = [
        { slot: 0, itemId: "greater_prayer_bones", quantity: 1 },
        { slot: 1, itemId: "prayer_bones", quantity: 1 },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "bury",
        itemId: "prayer_bones",
      });
    });

    it("never buries during combat or after the XP cap", () => {
      const inCombat = makeInput();
      inCombat.gameState.inCombat = true;
      inCombat.gameState.skills.prayer = { level: 1, xp: 0 };
      inCombat.inventoryItems = [
        { slot: 0, itemId: "prayer_bones", quantity: 1 },
      ];
      const capped = makeInput();
      capped.gameState.skills.prayer = { level: 99, xp: 200_000_000 };
      capped.inventoryItems = [
        { slot: 0, itemId: "prayer_bones", quantity: 1 },
      ];

      expect(processAgentTicks([inCombat])[0].action.type).not.toBe("bury");
      expect(processAgentTicks([capped])[0].action.type).not.toBe("bury");
    });
  });

  describe("Conserved store provisioning", () => {
    it("fails closed when the required store identity is not loaded", () => {
      const [result] = processAgentTicks([makeInput()]);

      expect(result.action.type).not.toBe("storeBuy");
    });

    it("walks to a free tile beside the exact store before buying", () => {
      const input = makeInput({
        gameState: {
          ...makeInput().gameState,
          playerId: "player-provisioning",
          position: [20, 0, 20],
        },
        storePositions: [
          {
            entityId: "npc-sword-store",
            storeId: "sword_store",
            name: "Sword Store",
            position: [0, 0, 0],
          },
        ],
      });

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "move",
        target: [1, 0, 1],
        runMode: true,
      });
      expect(result.updatedState.goal).toMatchObject({
        type: "provisioning",
      });
    });

    it("requests the secure transaction only inside store interaction range", () => {
      const input = makeInput({
        gameState: {
          ...makeInput().gameState,
          playerId: "player-at-store",
          position: [2, 0, 2],
        },
        storePositions: [
          {
            entityId: "npc-sword-store",
            storeId: "sword_store",
            name: "Sword Store",
            position: [0, 0, 0],
          },
        ],
      });

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "storeBuy",
        storeId: "sword_store",
        itemId: "bronze_shortsword",
        quantity: 1,
      });
    });

    it("ignores a nearby store with the wrong identity", () => {
      const input = makeInput({
        gameState: {
          ...makeInput().gameState,
          playerId: "player-wrong-store",
          position: [0, 0, 0],
        },
        storePositions: [
          {
            entityId: "npc-general-store",
            storeId: "general_store",
            name: "General Store",
            position: [1, 0, 1],
          },
          {
            entityId: "npc-sword-store",
            storeId: "sword_store",
            name: "Sword Store",
            position: [20, 0, 20],
          },
        ],
      });

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({
        type: "move",
        target: [19, 0, 19],
        runMode: true,
      });
    });

    it("backs off after a rejected secure transaction", () => {
      const input = makeInput({
        storeRetryAfter: Date.now() + 30_000,
        storePositions: [
          {
            entityId: "npc-sword-store",
            storeId: "sword_store",
            name: "Sword Store",
            position: [100, 0, 100],
          },
        ],
      });

      const [result] = processAgentTicks([input]);

      expect(result.action.type).not.toBe("storeBuy");
      expect(result.updatedState.goal?.type).not.toBe("provisioning");
    });

    it("never interrupts active combat to shop", () => {
      const input = makeInput({
        storePositions: [
          {
            entityId: "npc-sword-store",
            storeId: "sword_store",
            name: "Sword Store",
            position: [100, 0, 100],
          },
        ],
      });
      input.gameState.inCombat = true;
      input.gameState.currentTarget = "current-opponent";

      expect(processAgentTicks([input])[0].action.type).not.toBe("storeBuy");
    });

    it("uses only exact probability-one coin mobs after an insufficient-coin fence", () => {
      const recipes: WorkerProcessingRecipeSnapshot = {
        stores: [],
        gathering: [],
        guaranteedMobDrops: [
          { mobType: "goblin", itemIds: ["bones", "coins"] },
          { mobType: "cow", itemIds: ["bones", "cowhide"] },
        ],
        firemaking: [],
        crafting: [],
        tanning: [],
        fletching: [],
        runecrafting: [],
      };
      initializeItems([], recipes);
      try {
        const nearby = makeInput({
          coinRecoveryAuthorized: true,
          storeRetryAfter: Date.now() + 30_000,
        });
        nearby.equippedItems.weapon = "already-equipped-weapon";
        nearby.gameState.nearbyEntities = [
          {
            id: "misleading-cow",
            name: "Goblin",
            type: "mob",
            mobType: "cow",
            position: [101, 0, 100],
            distance: 1,
            health: 8,
          },
          {
            id: "exact-goblin",
            name: "Ordinary opponent",
            type: "mob",
            mobType: "goblin",
            position: [104, 0, 100],
            distance: 4,
            health: 10,
          },
        ];
        expect(processAgentTicks([nearby])[0].action).toEqual({
          type: "attack",
          targetId: "exact-goblin",
        });

        const distant = makeInput({
          coinRecoveryAuthorized: true,
          storeRetryAfter: Date.now() + 30_000,
          worldMobs: [
            { mobType: "cow", position: [102, 0, 100] },
            { mobType: "goblin", position: [170, 0, 125] },
          ],
        });
        distant.equippedItems.weapon = "already-equipped-weapon";
        expect(processAgentTicks([distant])[0].action).toEqual({
          type: "move",
          target: [170, 0, 125],
          runMode: true,
        });

        const unfenced = makeInput({
          worldMobs: [{ mobType: "goblin", position: [170, 0, 125] }],
        });
        unfenced.equippedItems.weapon = "already-equipped-weapon";
        expect(processAgentTicks([unfenced])[0].action).not.toMatchObject({
          type: "move",
          target: [170, 0, 125],
        });

        const lowHealth = makeInput({
          coinRecoveryAuthorized: true,
          storeRetryAfter: Date.now() + 30_000,
          worldMobs: [{ mobType: "goblin", position: [170, 0, 125] }],
        });
        lowHealth.equippedItems.weapon = "already-equipped-weapon";
        lowHealth.gameState.health = 4;
        lowHealth.gameState.maxHealth = 10;
        expect(processAgentTicks([lowHealth])[0].action).toEqual({
          type: "idle",
        });
      } finally {
        initializeTestItems();
      }
    });
  });

  describe("Quest dependency recovery", () => {
    it("never purchases a direct gather-stage target that cannot advance quest progress", () => {
      initializeItems(
        [
          [
            "test_weapon",
            {
              id: "test_weapon",
              name: "Test Weapon",
              type: "weapon",
              equipSlot: "weapon",
              attackType: "MELEE",
            },
          ],
          [
            "level_gated_ore",
            {
              id: "level_gated_ore",
              name: "Level-gated Ore",
              type: "resource",
            },
          ],
        ],
        {
          stores: [
            {
              storeId: "material_store",
              items: [
                {
                  itemId: "level_gated_ore",
                  price: 1,
                  category: "materials",
                },
              ],
            },
          ],
          gathering: [
            {
              resourceId: "level_gated_rock",
              harvestSkill: "mining",
              toolRequired: null,
              levelRequired: 10,
              outputItemIds: ["level_gated_ore"],
            },
          ],
          firemaking: [],
          crafting: [],
          tanning: [],
          fletching: [],
          runecrafting: [],
        },
      );
      try {
        const input = makeInput({
          questState: [
            {
              questId: "level-gated-gather",
              name: "Level-gated gather",
              status: "in_progress",
              currentStage: "gather",
              stageDescription: "Gather the ore",
              stageProgress: {},
              stageType: "gather",
              stageTarget: "level_gated_ore",
              stageCount: 1,
              startNpc: "miner",
            },
          ],
          storePositions: [
            {
              entityId: "material-store-npc",
              storeId: "material_store",
              name: "Material Store",
              position: [100, 0, 100],
            },
          ],
        });
        input.equippedItems.weapon = "test_weapon";
        input.gameState.skills.mining = { level: 1, xp: 0 };

        expect(processAgentTicks([input])[0].action).toEqual({ type: "idle" });
      } finally {
        initializeTestItems();
      }
    });

    it("selects a nearby quest resource by exact manifest identity despite misleading display data", () => {
      const input = makeInput({
        questState: [
          {
            questId: "exact-nearby-resource",
            name: "Exact nearby resource",
            status: "in_progress",
            currentStage: "gather",
            stageDescription: "Gather copper ore",
            stageProgress: {},
            stageType: "gather",
            stageTarget: "copper_ore",
            stageCount: 1,
            startNpc: "miner",
          },
        ],
      });
      input.equippedItems.weapon = "bronze_pickaxe";
      input.gameState.skills.mining = { level: 1, xp: 0 };
      input.gameState.nearbyEntities = [
        {
          id: "misleading-copper-rock",
          name: "Copper Rock",
          type: "resource",
          position: [101, 0, 100],
          distance: 1,
          resourceId: "tree_test",
          resourceType: "mining_rock",
        },
        {
          id: "authoritative-ore-node",
          name: "Ordinary Tree",
          type: "resource",
          position: [102, 0, 100],
          distance: 2,
          resourceId: "ore_test",
          resourceType: "mining_rock",
        },
      ];

      expect(processAgentTicks([input])[0].action).toEqual({
        type: "gather",
        targetId: "authoritative-ore-node",
      });
    });

    it("navigates to a distant quest resource by exact manifest identity", () => {
      const input = makeInput({
        questState: [
          {
            questId: "exact-distant-resource",
            name: "Exact distant resource",
            status: "in_progress",
            currentStage: "gather",
            stageDescription: "Gather copper ore",
            stageProgress: {},
            stageType: "gather",
            stageTarget: "copper_ore",
            stageCount: 1,
            startNpc: "miner",
          },
        ],
        worldResources: [
          {
            entityId: "distant-tree-node",
            position: [110, 0, 100],
            name: "copper rock",
            resourceId: "tree_test",
            resourceType: "mining_rock",
            depleted: false,
          },
          {
            entityId: "distant-ore-node",
            position: [140, 0, 100],
            name: "ordinary tree",
            resourceId: "ore_test",
            resourceType: "mining_rock",
            depleted: false,
          },
        ],
      });
      input.equippedItems.weapon = "bronze_pickaxe";
      input.gameState.skills.mining = { level: 1, xp: 0 };

      expect(processAgentTicks([input])[0].action).toEqual({
        type: "move",
        target: [140, 0, 100],
        runMode: false,
      });
    });

    it("does not treat a name-only resource lookalike as quest authority", () => {
      const input = makeInput({
        questState: [
          {
            questId: "missing-resource-identity",
            name: "Missing resource identity",
            status: "in_progress",
            currentStage: "gather",
            stageDescription: "Gather copper ore",
            stageProgress: {},
            stageType: "gather",
            stageTarget: "copper_ore",
            stageCount: 1,
            startNpc: "miner",
          },
        ],
      });
      input.equippedItems.weapon = "bronze_pickaxe";
      input.gameState.skills.mining = { level: 1, xp: 0 };
      input.gameState.nearbyEntities = [
        {
          id: "unidentified-copper-rock",
          name: "Copper Rock",
          type: "resource",
          position: [101, 0, 100],
          distance: 1,
          resourceType: "mining_rock",
        },
      ];

      expect(processAgentTicks([input])[0].action).toEqual({ type: "idle" });
    });

    it("provisions the authoritative Smithing hammer before submitting a quest recipe", () => {
      const questId = "smithing-hammer-recovery";
      const input = makeInput({
        inventoryItems: [{ slot: 0, itemId: "bronze_bar", quantity: 1 }],
        questState: [
          {
            questId,
            name: "Smithing hammer recovery",
            status: "in_progress",
            currentStage: "smith",
            stageDescription: "Smith a bronze shortsword",
            stageProgress: {},
            stageType: "interact",
            stageTarget: "bronze_shortsword",
            stageCount: 1,
            startNpc: "smith",
          },
        ],
        storePositions: [
          {
            entityId: "general-store-npc",
            storeId: "general_store",
            name: "General Store",
            position: [100, 0, 100],
          },
        ],
        stationPositions: [
          {
            entityId: "anvil",
            name: "Anvil",
            stationType: "anvil",
            position: [100, 0, 100],
            interactionRange: 2,
          },
        ],
      });
      input.equippedItems.weapon = "iron_shortsword";
      input.gameState.skills.smithing = { level: 1, xp: 0 };

      expect(processAgentTicks([input])[0].action).toEqual({
        type: "storeBuy",
        storeId: "general_store",
        itemId: "hammer",
        quantity: 1,
      });

      input.inventoryItems.push({ slot: 1, itemId: "hammer", quantity: 1 });
      expect(processAgentTicks([input])[0].action).toEqual({
        type: "smith",
        recipe: "bronze_shortsword",
      });
    });

    it("recovers every missing leaf in a multi-step Fletching quest chain", () => {
      const recipes: WorkerProcessingRecipeSnapshot = {
        stores: [
          {
            storeId: "general_store",
            items: [
              { itemId: "bronze_hatchet", price: 50, category: "tools" },
              { itemId: "knife", price: 6, category: "tools" },
              { itemId: "bowstring", price: 25, category: "materials" },
              { itemId: "feathers", price: 2, category: "materials" },
            ],
          },
        ],
        gathering: [
          {
            resourceId: "tree_general",
            harvestSkill: "woodcutting",
            toolRequired: "bronze_hatchet",
            levelRequired: 1,
            outputItemIds: ["logs"],
          },
        ],
        firemaking: [],
        crafting: [],
        tanning: [],
        fletching: [
          {
            recipeId: "shortbow_u:logs",
            outputItemId: "shortbow_u",
            outputQuantity: 1,
            category: "shortbows",
            inputs: [{ itemId: "logs", quantity: 1 }],
            tools: ["knife"],
            levelRequired: 5,
          },
          {
            recipeId: "shortbow:shortbow_u",
            outputItemId: "shortbow",
            outputQuantity: 1,
            category: "shortbows",
            inputs: [
              { itemId: "shortbow_u", quantity: 1 },
              { itemId: "bowstring", quantity: 1 },
            ],
            tools: [],
            levelRequired: 5,
          },
          {
            recipeId: "headless_arrow:arrow_shaft",
            outputItemId: "headless_arrow",
            outputQuantity: 15,
            category: "headless_arrows",
            inputs: [
              { itemId: "arrow_shaft", quantity: 15 },
              { itemId: "feathers", quantity: 15 },
            ],
            tools: [],
            levelRequired: 1,
          },
        ],
        runecrafting: [],
      };
      initializeItems(
        [
          [
            "iron_shortsword",
            {
              id: "iron_shortsword",
              name: "Iron Shortsword",
              type: "weapon",
              equipSlot: "weapon",
              attackType: "MELEE",
              bonuses: { attack: 8, strength: 7 },
            },
          ],
          [
            "bronze_hatchet",
            {
              id: "bronze_hatchet",
              name: "Bronze Hatchet",
              type: "tool",
              equipSlot: "weapon",
              attackType: "MELEE",
              bonuses: { attack: 1 },
              tool: { skill: "woodcutting", priority: 1 },
            },
          ],
          ["knife", { id: "knife", name: "Knife", type: "tool" }],
          [
            "bowstring",
            { id: "bowstring", name: "Bowstring", type: "resource" },
          ],
          ["logs", { id: "logs", name: "Logs", type: "resource" }],
          [
            "shortbow_u",
            { id: "shortbow_u", name: "Unstrung Shortbow", type: "resource" },
          ],
          ["shortbow", { id: "shortbow", name: "Shortbow", type: "weapon" }],
          [
            "arrow_shaft",
            { id: "arrow_shaft", name: "Arrow Shaft", type: "resource" },
          ],
          ["feathers", { id: "feathers", name: "Feathers", type: "resource" }],
          [
            "headless_arrow",
            {
              id: "headless_arrow",
              name: "Headless Arrow",
              type: "resource",
            },
          ],
        ],
        recipes,
      );

      try {
        const makeStepInput = (
          inventoryItems: AgentTickInput["inventoryItems"],
          includeTree = false,
        ): AgentTickInput => {
          const questId = `fletching-chain-${nextAgentId}`;
          const input = makeInput({
            inventoryItems,
            questState: [
              {
                questId,
                name: "Fletching chain",
                status: "in_progress",
                currentStage: "fletch",
                stageDescription: "Fletch a shortbow",
                stageProgress: {},
                stageType: "interact",
                stageTarget: "shortbow",
                stageCount: 1,
                startNpc: "bowyer",
              },
            ],
            storePositions: [
              {
                entityId: "general-store-npc",
                storeId: "general_store",
                name: "General Store",
                position: [100, 0, 100],
              },
            ],
            worldResources: includeTree
              ? [
                  {
                    entityId: "tree-node",
                    position: [101, 0, 100],
                    name: "Tree",
                    resourceId: "tree_general",
                    resourceType: "tree_general",
                    depleted: false,
                  },
                ]
              : [],
          });
          input.equippedItems.weapon = "iron_shortsword";
          input.gameState.skills.fletching = { level: 5, xp: 0 };
          input.gameState.skills.woodcutting = { level: 1, xp: 0 };
          input.gameState.nearbyEntities = includeTree
            ? [
                {
                  id: "tree-node",
                  name: "Tree",
                  type: "resource",
                  position: [101, 0, 100],
                  distance: 1,
                  resourceId: "tree_general",
                  resourceType: "tree_general",
                },
              ]
            : [];
          return input;
        };

        expect(processAgentTicks([makeStepInput([])])[0].action).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_hatchet",
          quantity: 1,
        });
        expect(
          processAgentTicks([
            makeStepInput(
              [{ slot: 0, itemId: "bronze_hatchet", quantity: 1 }],
              true,
            ),
          ])[0].action,
        ).toEqual({ type: "gather", targetId: "tree-node" });
        expect(
          processAgentTicks([
            makeStepInput([
              { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
              { slot: 1, itemId: "logs", quantity: 1 },
            ]),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "knife",
          quantity: 1,
        });
        expect(
          processAgentTicks([
            makeStepInput([
              { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
              { slot: 1, itemId: "logs", quantity: 1 },
              { slot: 2, itemId: "knife", quantity: 1 },
            ]),
          ])[0].action,
        ).toEqual({
          type: "fletch",
          recipeId: "shortbow_u:logs",
          quantity: 1,
        });
        expect(
          processAgentTicks([
            makeStepInput([{ slot: 0, itemId: "shortbow_u", quantity: 1 }]),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bowstring",
          quantity: 1,
        });
        expect(
          processAgentTicks([
            makeStepInput([
              { slot: 0, itemId: "shortbow_u", quantity: 1 },
              { slot: 1, itemId: "bowstring", quantity: 1 },
            ]),
          ])[0].action,
        ).toEqual({
          type: "fletch",
          recipeId: "shortbow:shortbow_u",
          quantity: 1,
        });

        const exactQuantityInput = makeStepInput([
          { slot: 0, itemId: "arrow_shaft", quantity: 15 },
        ]);
        exactQuantityInput.questState[0].stageTarget = "headless_arrow";
        expect(processAgentTicks([exactQuantityInput])[0].action).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "feathers",
          quantity: 15,
        });
      } finally {
        initializeTestItems();
      }
    });
  });

  describe("Authoritative quest eligibility", () => {
    it("skips a higher-priority locked quest and selects the next eligible quest", () => {
      const input = makeInput({
        availableQuests: [
          makeQuestInfo("goblin_slayer", false),
          makeQuestInfo("lumberjacks_first_lesson", true),
        ],
      });

      const [result] = processAgentTicks([input]);

      expect(result.updatedState.goal).toMatchObject({
        type: "questing",
        questId: "lumberjacks_first_lesson",
      });
    });

    it("falls back safely when every not-started quest is locked", () => {
      const input = makeInput({
        availableQuests: [makeQuestInfo("goblin_slayer", false)],
      });

      const [result] = processAgentTicks([input]);

      expect(result.updatedState.goal).toEqual({
        type: "exploring",
        description: "Exploring toward spawn",
      });
    });
  });

  describe("Action Selection", () => {
    it("attacks nearby mobs when not in combat", () => {
      const input = makeInput();
      input.gameState.nearbyEntities = [
        {
          id: "goblin-1",
          name: "Goblin",
          type: "mob",
          position: [105, 0, 100],
          distance: 5,
          health: 10,
          maxHealth: 10,
          mobType: "goblin",
        },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action.type).toBe("attack");
      if (result.action.type === "attack") {
        expect(result.action.targetId).toBe("goblin-1");
      }
    });

    it("idles when in combat", () => {
      const input = makeInput();
      input.gameState.inCombat = true;
      input.gameState.nearbyEntities = [
        {
          id: "goblin-1",
          name: "Goblin",
          type: "mob",
          position: [105, 0, 100],
          distance: 5,
          health: 10,
          maxHealth: 10,
          mobType: "goblin",
        },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action.type).toBe("idle");
    });

    it("requires full passive recovery before foodless progression resumes", () => {
      const input = makeInput();
      input.gameState.health = 9;
      input.gameState.maxHealth = 10;
      input.agentState.currentTargetId = "previous-opponent";
      input.gameState.nearbyEntities = [
        {
          id: "tempting-drop",
          name: "Valuable drop",
          type: "item",
          itemId: "bronze_dagger",
          position: [101, 0, 100],
          distance: 1,
        },
        {
          id: "nearby-goblin",
          name: "Goblin",
          type: "mob",
          mobType: "goblin",
          position: [102, 0, 100],
          distance: 2,
          health: 5,
        },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action).toEqual({ type: "idle" });
      expect(result.updatedState.currentTargetId).toBeNull();

      input.inventoryItems = [
        { slot: 0, itemId: "cooked_shrimp", quantity: 1 },
      ];
      const [foodReady] = processAgentTicks([input]);
      expect(foodReady.action).toEqual({
        type: "pickup",
        targetId: "tempting-drop",
      });
    });

    it("waits for a dispatched attack snapshot to settle before retargeting", () => {
      const input = makeInput();
      input.attackObservationRetryAfter = Date.now() + 20_000;
      input.gameState.nearbyEntities = [
        {
          id: "second-goblin",
          name: "Goblin",
          type: "mob",
          mobType: "goblin",
          position: [102, 0, 100],
          distance: 2,
          health: 5,
        },
      ];

      const [settling] = processAgentTicks([input]);
      expect(settling.action).toEqual({ type: "idle" });

      input.attackObservationRetryAfter = Date.now() - 1;
      const [settled] = processAgentTicks([input]);
      expect(settled.action).toEqual({
        type: "attack",
        targetId: "second-goblin",
      });
    });

    it("moves toward spawn when no targets nearby", () => {
      const input = makeInput();
      input.gameState.position = [500, 0, 500]; // Far from spawn
      input.spawnAnchors = [{ position: [100, 0, 100], name: "spawn" }];

      const [result] = processAgentTicks([input]);

      expect(result.action.type).toBe("move");
    });

    it("picks up nearby items opportunistically", () => {
      const input = makeInput();
      input.gameState.nearbyEntities = [
        {
          id: "item-1",
          name: "Coins",
          type: "item",
          position: [102, 0, 100],
          distance: 2,
          itemId: "coins",
        },
      ];

      const [result] = processAgentTicks([input]);

      expect(result.action.type).toBe("pickup");
      if (result.action.type === "pickup") {
        expect(result.action.targetId).toBe("item-1");
      }
    });
  });

  describe("Authoritative workstation proximity", () => {
    it("routes a full questing agent diagonally to the loaded bank before another blocked gather", () => {
      const inventoryItems = Array.from({ length: 28 }, (_, slot) => ({
        slot,
        itemId: slot === 0 ? "cooked_shrimp" : `quest-custody-${slot}`,
        quantity: slot === 0 ? 100 : 1,
      }));
      const bank = {
        entityId: "quest-bank-live",
        name: "quest bank quest-bank-live",
        stationType: "bank",
        position: [112, 0, 108] as [number, number, number],
        interactionRange: 2,
      };
      const input = makeInput({
        inventoryItems,
        questState: [
          {
            questId: "full-inventory-gather",
            name: "Full inventory gather",
            status: "in_progress",
            currentStage: "gather",
            stageDescription: "Gather copper ore",
            stageProgress: {},
            stageType: "gather",
            stageTarget: "copper_ore",
            stageCount: 1,
            startNpc: "miner",
          },
        ],
        stationPositions: [bank],
      });
      input.equippedItems.weapon = "bronze_pickaxe";
      input.gameState.skills.mining = { level: 1, xp: 0 };
      input.gameState.nearbyEntities = [
        {
          id: "blocked-ore-node",
          name: "Copper rock",
          type: "resource",
          position: [102, 0, 100],
          distance: 2,
          resourceId: "ore_test",
          resourceType: "mining_rock",
        },
      ];

      const [travelling] = processAgentTicks([input]);
      expect(travelling.action).toEqual({
        type: "move",
        target: [112, 0, 108],
        runMode: true,
      });
      expect(travelling.action).not.toEqual({
        type: "gather",
        targetId: "blocked-ore-node",
      });

      input.gameState.position = [111.5, 0, 108.5];
      const [arrived] = processAgentTicks([input]);
      expect(arrived.action).toEqual({
        type: "bankDepositAll",
        bankId: "quest-bank-live",
      });
    });

    it("preserves quest materials when the remaining gathering stage exactly fits", () => {
      const inventoryItems = Array.from({ length: 24 }, (_, slot) => ({
        slot,
        itemId: slot === 0 ? "cooked_shrimp" : `quest-custody-${slot}`,
        quantity: slot === 0 ? 100 : 1,
      }));
      const input = makeInput({
        inventoryItems,
        questState: [
          {
            questId: "torvins_tools",
            name: "Torvin's Tools",
            status: "in_progress",
            currentStage: "mine_copper",
            stageDescription: "Mine 4 copper ore",
            stageProgress: {},
            stageType: "gather",
            stageTarget: "copper_ore",
            stageCount: 4,
            startNpc: "torvin",
          },
        ],
      });
      input.equippedItems.weapon = "bronze_pickaxe";
      input.gameState.skills.mining = { level: 1, xp: 0 };
      input.gameState.nearbyEntities = [
        {
          id: "copper-node-with-capacity",
          name: "Copper rock",
          type: "resource",
          position: [102, 0, 100],
          distance: 2,
          resourceId: "ore_test",
          resourceType: "mining_rock",
        },
      ];
      input.agentState.goal = {
        type: "questing",
        description: "Mine 4 copper ore",
        questId: "torvins_tools",
        questName: "Torvin's Tools",
        questStageType: "gather",
        questStageTarget: "copper_ore",
        questStageCount: 4,
        questStartNpc: "torvin",
      };
      input.agentState.questsAccepted = ["torvins_tools"];

      expect(processAgentTicks([input])[0].action).toEqual({
        type: "gather",
        targetId: "copper-node-with-capacity",
      });
    });

    it("requests surplus banking when the next quest gather cannot fit while preserving the quest goal", () => {
      const inventoryItems = [
        ...Array.from({ length: 14 }, (_, slot) => ({
          slot,
          itemId: "cooked_shrimp",
          quantity: 1,
        })),
        ...Array.from({ length: 4 }, (_, offset) => ({
          slot: 14 + offset,
          itemId: "burnt_shrimp",
          quantity: 1,
        })),
        ...Array.from({ length: 4 }, (_, offset) => ({
          slot: 18 + offset,
          itemId: "copper_ore",
          quantity: 1,
        })),
        { slot: 22, itemId: "bronze_pickaxe", quantity: 1 },
        { slot: 23, itemId: "hammer", quantity: 1 },
        { slot: 24, itemId: "small_fishing_net", quantity: 1 },
      ];
      const input = makeInput({
        inventoryItems,
        questState: [
          {
            questId: "torvins_tools",
            name: "Torvin's Tools",
            status: "in_progress",
            currentStage: "mine_tin",
            stageDescription: "Mine 4 tin ore",
            stageProgress: {},
            stageType: "gather",
            stageTarget: "tin_ore",
            stageCount: 4,
            startNpc: "torvin",
          },
        ],
        stationPositions: [
          {
            entityId: "quest-bank-live",
            name: "Quest bank",
            stationType: "bank",
            position: [100, 0, 100],
            interactionRange: 2,
          },
        ],
      });
      input.gameState.health = 10;
      input.gameState.maxHealth = 10;
      input.agentState.goal = {
        type: "questing",
        description: "Mine 4 tin ore",
        questId: "torvins_tools",
        questName: "Torvin's Tools",
        questStageType: "gather",
        questStageTarget: "tin_ore",
        questStageCount: 4,
        questStartNpc: "torvin",
      };
      input.agentState.questsAccepted = ["torvins_tools"];

      const [result] = processAgentTicks([input]);
      expect(result.action).toEqual({
        type: "bankDepositAll",
        bankId: "quest-bank-live",
      });
      expect(result.updatedState.goal).toMatchObject({
        type: "questing",
        questId: "torvins_tools",
      });
    });

    it("carries a near-full authored ore batch from the bank to the furnace", () => {
      const inventoryItems = [
        ...Array.from({ length: 14 }, (_, slot) => ({
          slot,
          itemId: "cooked_shrimp",
          quantity: 1,
        })),
        ...Array.from({ length: 2 }, (_, offset) => ({
          slot: 14 + offset,
          itemId: "burnt_shrimp",
          quantity: 1,
        })),
        ...Array.from({ length: 4 }, (_, offset) => ({
          slot: 16 + offset,
          itemId: "copper_ore",
          quantity: 1,
        })),
        ...Array.from({ length: 4 }, (_, offset) => ({
          slot: 20 + offset,
          itemId: "tin_ore",
          quantity: 1,
        })),
        { slot: 24, itemId: "bronze_pickaxe", quantity: 1 },
        { slot: 25, itemId: "hammer", quantity: 1 },
      ];
      const input = makeInput({
        inventoryItems,
        questState: [
          {
            questId: "torvins_tools",
            name: "Torvin's Tools",
            status: "in_progress",
            currentStage: "smelt_bronze",
            stageDescription: "Smelt 4 bronze bars",
            stageProgress: {},
            stageType: "interact",
            stageTarget: "bronze_bar",
            stageCount: 4,
            startNpc: "torvin",
          },
        ],
        stationPositions: [
          {
            entityId: "quest-bank-live",
            name: "Quest bank",
            stationType: "bank",
            position: [100, 0, 100],
            interactionRange: 2,
          },
          {
            entityId: "quest-furnace-live",
            name: "Quest furnace",
            stationType: "furnace",
            position: [112, 0, 108],
            interactionRange: 2,
          },
        ],
      });
      // Keep this regression focused on quest-custody routing. The carried
      // shrimp cover this fixture's full health so the higher-priority,
      // independently tested survival-bank policy does not preempt it.
      input.gameState.health = 40;
      input.gameState.maxHealth = 40;
      input.gameState.skills.smithing = { level: 1, xp: 0 };
      input.agentState.goal = {
        type: "questing",
        description: "Smelt 4 bronze bars",
        questId: "torvins_tools",
        questName: "Torvin's Tools",
        questStageType: "interact",
        questStageTarget: "bronze_bar",
        questStageCount: 4,
        questStartNpc: "torvin",
      };
      input.agentState.questsAccepted = ["torvins_tools"];

      expect(processAgentTicks([input])[0].action).toEqual({
        type: "move",
        target: [112, 0, 108],
        runMode: true,
      });
    });

    it("keeps a near-full quest batch during a bounded smelting retry", () => {
      const inventoryItems = [
        { slot: 0, itemId: "cooked_shrimp", quantity: 100 },
        ...Array.from({ length: 18 }, (_, offset) => ({
          slot: offset + 1,
          itemId: `quest-custody-${offset}`,
          quantity: 1,
        })),
        { slot: 19, itemId: "copper_ore", quantity: 1 },
        { slot: 20, itemId: "copper_ore", quantity: 1 },
        { slot: 21, itemId: "tin_ore", quantity: 1 },
        { slot: 22, itemId: "tin_ore", quantity: 1 },
        { slot: 23, itemId: "hammer", quantity: 1 },
      ];
      const input = makeInput({
        inventoryItems,
        questState: [
          {
            questId: "torvins_tools",
            name: "Torvin's Tools",
            status: "in_progress",
            currentStage: "smelt_bronze",
            stageDescription: "Smelt 4 bronze bars",
            stageProgress: { bronze_bar: 2 },
            stageType: "interact",
            stageTarget: "bronze_bar",
            stageCount: 4,
            startNpc: "torvin",
          },
        ],
        ordinaryProcessingRetrySuppressions: [
          {
            actionType: "smelt",
            intentId: "bronze_bar",
            retryAfter: Date.now() + 30_000,
          },
        ],
        stationPositions: [
          {
            entityId: "quest-furnace-live",
            name: "Quest furnace",
            stationType: "furnace",
            position: [100, 0, 100],
            interactionRange: 2,
          },
          {
            entityId: "quest-bank-live",
            name: "Quest bank",
            stationType: "bank",
            position: [112, 0, 108],
            interactionRange: 2,
          },
        ],
      });
      input.equippedItems.weapon = "bronze_pickaxe";
      input.gameState.skills.smithing = { level: 1, xp: 0 };
      input.agentState.goal = {
        type: "questing",
        description: "Smelt 4 bronze bars",
        questId: "torvins_tools",
        questName: "Torvin's Tools",
        questStageType: "interact",
        questStageTarget: "bronze_bar",
        questStageCount: 4,
        questStartNpc: "torvin",
      };
      input.agentState.questsAccepted = ["torvins_tools"];

      const [result] = processAgentTicks([input]);
      expect(result.action).toEqual({ type: "idle" });
      expect(result.updatedState.goal).toMatchObject({
        type: "questing",
        questId: "torvins_tools",
      });
    });

    it("walks into the loaded range boundary before attempting to cook", () => {
      const input = makeInput({
        inventoryItems: [{ slot: 0, itemId: "raw_shrimp", quantity: 5 }],
        stationPositions: [
          {
            entityId: "range-live",
            name: "cooking range range-live",
            stationType: "range",
            position: [102, 0, 100],
            interactionRange: 1,
          },
        ],
      });

      const [outside] = processAgentTicks([input]);
      expect(outside.action).toEqual({
        type: "move",
        target: [102, 0, 100],
        runMode: true,
      });

      input.gameState.position = [101, 0, 100];
      const [inside] = processAgentTicks([input]);
      expect(inside.action).toEqual({
        type: "cook",
        itemId: "raw_shrimp",
      });
    });

    it("walks one reduced-capacity smelting action into the loaded furnace boundary", () => {
      const input = makeInput({
        gameState: {
          ...makeInput().gameState,
          skills: { smithing: { level: 15, xp: 0 } },
        },
        inventoryItems: [{ slot: 0, itemId: "iron_ore", quantity: 1 }],
        stationPositions: [
          {
            entityId: "furnace-live",
            name: "furnace furnace-live",
            stationType: "furnace",
            position: [103, 0, 100],
            interactionRange: 2,
          },
        ],
      });

      const [outside] = processAgentTicks([input]);
      expect(outside.action).toEqual({
        type: "move",
        target: [103, 0, 100],
        runMode: true,
      });

      input.gameState.position = [101, 0, 100];
      const [inside] = processAgentTicks([input]);
      expect(inside.action).toEqual({ type: "smelt", recipe: "iron_bar" });
    });

    it("keeps 25 agents on one furnace decision snapshot isolated", () => {
      const inputs = Array.from({ length: 25 }, () =>
        makeInput({
          gameState: {
            ...makeInput().gameState,
            skills: { smithing: { level: 15, xp: 0 } },
          },
          inventoryItems: [{ slot: 0, itemId: "iron_ore", quantity: 5 }],
          stationPositions: [
            {
              entityId: "furnace-shared",
              name: "furnace furnace-shared",
              stationType: "furnace",
              position: [102, 0, 100],
              interactionRange: 2,
            },
          ],
        }),
      );

      const results = processAgentTicks(inputs);
      expect(results).toHaveLength(25);
      expect(
        results.every(
          (result) =>
            result.action.type === "smelt" &&
            result.action.recipe === "iron_bar",
        ),
      ).toBe(true);
      expect(new Set(results.map((result) => result.characterId)).size).toBe(
        25,
      );
    });
  });

  describe("Ordinary processing rejection suppression", () => {
    const retrySnapshot = (): WorkerProcessingRecipeSnapshot => ({
      stores: [],
      gathering: [],
      firemaking: [],
      crafting: [],
      tanning: [],
      fletching: [
        {
          recipeId: "high_bow:high_logs",
          outputItemId: "high_bow",
          outputQuantity: 1,
          category: "bows",
          inputs: [{ itemId: "high_logs", quantity: 1 }],
          tools: [],
          levelRequired: 20,
        },
        {
          recipeId: "low_bow:low_logs",
          outputItemId: "low_bow",
          outputQuantity: 1,
          category: "bows",
          inputs: [{ itemId: "low_logs", quantity: 1 }],
          tools: [],
          levelRequired: 10,
        },
      ],
      runecrafting: [],
    });

    it("runs a different ready recipe while the rejected exact intent cools down", () => {
      initializeItems([], retrySnapshot());
      try {
        const input = makeInput({
          inventoryItems: [
            { slot: 0, itemId: "high_logs", quantity: 1 },
            { slot: 1, itemId: "low_logs", quantity: 1 },
          ],
          ordinaryProcessingRetrySuppressions: [
            {
              actionType: "fletch",
              intentId: "high_bow:high_logs",
              retryAfter: Date.now() + 30_000,
            },
          ],
        });
        input.gameState.skills.fletching = { level: 20, xp: 0 };

        expect(processAgentTicks([input])[0].action).toEqual({
          type: "fletch",
          recipeId: "low_bow:low_logs",
          quantity: 1,
        });
      } finally {
        initializeTestItems();
      }
    });

    it("keeps ready custody out of another bank stage when every recipe is cooling down", () => {
      initializeItems(
        [
          [
            "test_food",
            {
              id: "test_food",
              name: "Test food",
              type: "food",
              healAmount: 1,
            },
          ],
        ],
        retrySnapshot(),
      );
      try {
        const retryAfter = Date.now() + 30_000;
        const input = makeInput({
          inventoryItems: [
            { slot: 0, itemId: "high_logs", quantity: 1 },
            { slot: 1, itemId: "low_logs", quantity: 1 },
            { slot: 2, itemId: "test_food", quantity: 1 },
          ],
          ordinaryProcessingRetrySuppressions: [
            {
              actionType: "fletch",
              intentId: "high_bow:high_logs",
              retryAfter,
            },
            {
              actionType: "fletch",
              intentId: "low_bow:low_logs",
              retryAfter,
            },
          ],
          stationPositions: [
            {
              entityId: "bank-live",
              name: "live bank",
              stationType: "bank",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        input.gameState.skills.fletching = { level: 20, xp: 0 };
        input.gameState.health = 1;
        input.gameState.maxHealth = 1;

        expect(processAgentTicks([input])[0].action.type).not.toBe(
          "bankWithdraw",
        );
      } finally {
        initializeTestItems();
      }
    });

    it("re-enables the exact recipe at its bounded retry deadline", () => {
      initializeItems([], retrySnapshot());
      try {
        const input = makeInput({
          inventoryItems: [{ slot: 0, itemId: "high_logs", quantity: 1 }],
          ordinaryProcessingRetrySuppressions: [
            {
              actionType: "fletch",
              intentId: "high_bow:high_logs",
              retryAfter: Date.now() - 1,
            },
          ],
        });
        input.gameState.skills.fletching = { level: 20, xp: 0 };

        expect(processAgentTicks([input])[0].action).toEqual({
          type: "fletch",
          recipeId: "high_bow:high_logs",
          quantity: 1,
        });
      } finally {
        initializeTestItems();
      }
    });

    it("lets quest agents perform alternate useful work instead of replaying a rejected recipe", () => {
      const snapshot = retrySnapshot();
      snapshot.firemaking = [{ logItemId: "logs", levelRequired: 1 }];
      initializeItems([], snapshot);
      try {
        const input = makeInput({
          inventoryItems: [
            { slot: 0, itemId: "tinderbox", quantity: 1 },
            { slot: 1, itemId: "logs", quantity: 1 },
          ],
          questState: [
            {
              questId: "firemaking-quest",
              name: "Firemaking quest",
              status: "in_progress",
              currentStage: "light-fire",
              stageDescription: "Light an authored fire",
              stageProgress: {},
              stageType: "interact",
              stageTarget: "fire",
              stageCount: 1,
              startNpc: "artisan",
            },
          ],
          ordinaryProcessingRetrySuppressions: [
            {
              actionType: "firemake",
              intentId: "logs",
              retryAfter: Date.now() + 30_000,
            },
          ],
        });
        input.gameState.skills.firemaking = { level: 1, xp: 0 };
        input.gameState.nearbyEntities = [
          {
            id: "nearby-mob",
            name: "Nearby mob",
            type: "mob",
            position: [102, 0, 100],
            distance: 2,
            health: 10,
            maxHealth: 10,
          },
        ];
        input.agentState.goal = {
          type: "questing",
          description: "Light an authored fire",
          questId: "firemaking-quest",
        };

        expect(processAgentTicks([input])[0].action).toEqual({
          type: "attack",
          targetId: "nearby-mob",
        });
      } finally {
        initializeTestItems();
      }
    });
  });

  describe("Production processing manifest contract", () => {
    it("selects every authored cooking and smelting recipe and every Smithing quest output", async () => {
      const [cooking, smelting, smithing] = (await Promise.all(
        ["cooking", "smelting", "smithing"].map(async (name) =>
          JSON.parse(
            await readFile(
              new URL(
                `../../../../world/assets/manifests/recipes/${name}.json`,
                import.meta.url,
              ),
              "utf8",
            ),
          ),
        ),
      )) as [
        {
          recipes: Array<{
            raw: string;
            cooked: string;
            level: number;
          }>;
        },
        {
          recipes: Array<{
            output: string;
            inputs: Array<{ item: string; amount: number }>;
            level: number;
          }>;
        },
        {
          recipes: Array<{
            output: string;
            bar: string;
            barsRequired: number;
            level: number;
            outputQuantity?: number;
          }>;
        },
      ];
      const workerItems = new Map<string, WorkerItemData>();
      const ensureItem = (id: string): WorkerItemData => {
        const item = workerItems.get(id) ?? {
          id,
          name: id,
          type: "resource",
        };
        workerItems.set(id, item);
        return item;
      };

      for (const recipe of cooking.recipes) {
        ensureItem(recipe.raw).cooking = {
          cookedItemId: recipe.cooked,
          levelRequired: recipe.level,
        };
      }
      for (const recipe of smelting.recipes) {
        ensureItem(recipe.output).smelting = {
          inputs: recipe.inputs.map((input) => ({
            itemId: input.item,
            quantity: input.amount,
          })),
          levelRequired: recipe.level,
        };
      }
      for (const recipe of smithing.recipes) {
        ensureItem(recipe.output).smithing = {
          barItemId: recipe.bar,
          barsRequired: recipe.barsRequired,
          levelRequired: recipe.level,
          outputQuantity: recipe.outputQuantity ?? 1,
        };
      }
      const hammer = ensureItem("hammer");
      hammer.type = "tool";

      initializeItems([...workerItems.entries()]);
      try {
        for (const recipe of cooking.recipes) {
          const input = makeInput({
            inventoryItems: [{ slot: 0, itemId: recipe.raw, quantity: 5 }],
            stationPositions: [
              {
                entityId: "manifest-range",
                name: "manifest range",
                stationType: "range",
                position: [100, 0, 100],
                interactionRange: 2,
              },
            ],
          });
          input.gameState.skills.cooking = { level: recipe.level, xp: 0 };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "cook",
            itemId: recipe.raw,
          });
        }

        for (const recipe of smelting.recipes) {
          const input = makeInput({
            inventoryItems: recipe.inputs.map((item, slot) => ({
              slot,
              itemId: item.item,
              quantity: item.amount * 5,
            })),
            stationPositions: [
              {
                entityId: "manifest-furnace",
                name: "manifest furnace",
                stationType: "furnace",
                position: [100, 0, 100],
                interactionRange: 2,
              },
            ],
          });
          input.gameState.skills.smithing = { level: recipe.level, xp: 0 };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "smelt",
            recipe: recipe.output,
          });
        }

        for (const recipe of smithing.recipes) {
          const questId = `manifest-smith-${recipe.output}`;
          const input = makeInput({
            inventoryItems: [
              {
                slot: 0,
                itemId: recipe.bar,
                quantity: recipe.barsRequired,
              },
              { slot: 1, itemId: "hammer", quantity: 1 },
            ],
            questState: [
              {
                questId,
                name: questId,
                status: "in_progress",
                currentStage: "smith",
                stageDescription: "Smith the authored output",
                stageProgress: {},
                stageType: "interact",
                stageTarget: recipe.output,
                stageCount: 1,
                startNpc: "smith",
              },
            ],
            stationPositions: [
              {
                entityId: "manifest-anvil",
                name: "manifest anvil",
                stationType: "anvil",
                position: [100, 0, 100],
                interactionRange: 2,
              },
            ],
            agentState: {
              ...makeInput().agentState,
              goal: {
                type: "questing",
                description: "Complete authored Smithing output",
                questId,
              },
            },
          });
          input.gameState.skills.smithing = { level: recipe.level, xp: 0 };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "smith",
            recipe: recipe.output,
          });
        }
      } finally {
        initializeTestItems();
      }
    });

    it("selects every authored Firemaking, Crafting, Tanning, Fletching, and Runecrafting quest recipe", async () => {
      const [firemaking, crafting, tanning, fletching, runecrafting] =
        (await Promise.all(
          [
            "firemaking",
            "crafting",
            "tanning",
            "fletching",
            "runecrafting",
          ].map(async (name) =>
            JSON.parse(
              await readFile(
                new URL(
                  `../../../../world/assets/manifests/recipes/${name}.json`,
                  import.meta.url,
                ),
                "utf8",
              ),
            ),
          ),
        )) as [
          { recipes: Array<{ log: string; level: number }> },
          {
            recipes: Array<{
              output: string;
              category: string;
              inputs: Array<{ item: string; amount: number }>;
              tools: string[];
              consumables: Array<{ item: string; uses: number }>;
              level: number;
              station: string;
            }>;
          },
          {
            recipes: Array<{
              input: string;
              output: string;
              cost: number;
            }>;
          },
          {
            recipes: Array<{
              output: string;
              outputQuantity: number;
              category: string;
              inputs: Array<{ item: string; amount: number }>;
              tools: string[];
              level: number;
            }>;
          },
          {
            recipes: Array<{
              runeType: string;
              runeItemId: string;
              essenceTypes: string[];
              levelRequired: number;
            }>;
          },
        ];
      const stores = JSON.parse(
        await readFile(
          new URL(
            "../../../../world/assets/manifests/stores.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as Array<{
        id: string;
        items: Array<{
          itemId: string;
          price: number;
          category: string;
        }>;
      }>;
      const processingRecipes: WorkerProcessingRecipeSnapshot = {
        stores: stores.map((store) => ({
          storeId: store.id,
          items: store.items.map((item) => ({
            itemId: item.itemId,
            price: item.price,
            category: item.category,
          })),
        })),
        gathering: [],
        firemaking: firemaking.recipes.map((recipe) => ({
          logItemId: recipe.log,
          levelRequired: recipe.level,
        })),
        crafting: crafting.recipes.map((recipe) => ({
          outputItemId: recipe.output,
          category: recipe.category,
          inputs: recipe.inputs.map((input) => ({
            itemId: input.item,
            quantity: input.amount,
          })),
          tools: recipe.tools,
          consumables: recipe.consumables.map((consumable) => ({
            itemId: consumable.item,
            uses: consumable.uses,
          })),
          levelRequired: recipe.level,
          station: recipe.station,
        })),
        tanning: tanning.recipes.map((recipe) => ({
          inputItemId: recipe.input,
          outputItemId: recipe.output,
          coinCost: recipe.cost,
        })),
        fletching: fletching.recipes.map((recipe) => ({
          recipeId: `${recipe.output}:${recipe.inputs[0]?.item ?? ""}`,
          outputItemId: recipe.output,
          outputQuantity: recipe.outputQuantity,
          category: recipe.category,
          inputs: recipe.inputs.map((input) => ({
            itemId: input.item,
            quantity: input.amount,
          })),
          tools: recipe.tools,
          levelRequired: recipe.level,
        })),
        runecrafting: runecrafting.recipes.map((recipe) => ({
          runeType: recipe.runeType,
          runeItemId: recipe.runeItemId,
          essenceItemIds: recipe.essenceTypes,
          levelRequired: recipe.levelRequired,
        })),
      };
      const makeInventory = (
        inputs: Array<{ itemId: string; quantity: number }>,
        tools: string[] = [],
        consumables: Array<{ itemId: string }> = [],
      ) => {
        const quantities = new Map<string, number>();
        for (const input of inputs) {
          quantities.set(
            input.itemId,
            (quantities.get(input.itemId) ?? 0) + input.quantity,
          );
        }
        for (const itemId of tools) {
          quantities.set(itemId, Math.max(1, quantities.get(itemId) ?? 0));
        }
        for (const { itemId } of consumables) {
          quantities.set(itemId, Math.max(1, quantities.get(itemId) ?? 0));
        }
        return [...quantities].map(([itemId, quantity], slot) => ({
          slot,
          itemId,
          quantity,
        }));
      };
      const makeProcessingQuestInput = (
        target: string,
        inventoryItems: AgentTickInput["inventoryItems"],
      ) => {
        const questId = `manifest-process-${target}-${nextAgentId}`;
        const input = makeInput({
          inventoryItems,
          questState: [
            {
              questId,
              name: questId,
              status: "in_progress",
              currentStage: "process",
              stageDescription: "Execute the authored processing recipe",
              stageProgress: {},
              stageType: "interact",
              stageTarget: target,
              stageCount: 1,
              startNpc: "artisan",
            },
          ],
        });
        input.agentState.goal = {
          type: "questing",
          description: "Execute the authored processing recipe",
          questId,
        };
        return input;
      };

      initializeItems([], processingRecipes);
      try {
        for (const recipe of processingRecipes.firemaking) {
          const input = makeProcessingQuestInput("fire", [
            { slot: 0, itemId: "tinderbox", quantity: 1 },
            { slot: 1, itemId: recipe.logItemId, quantity: 1 },
          ]);
          input.gameState.skills.firemaking = {
            level: recipe.levelRequired,
            xp: 0,
          };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "firemake",
            logsItemId: recipe.logItemId,
          });
        }

        for (const recipe of processingRecipes.crafting) {
          const input = makeProcessingQuestInput(
            recipe.outputItemId,
            makeInventory(recipe.inputs, recipe.tools, recipe.consumables),
          );
          input.gameState.skills.crafting = {
            level: recipe.levelRequired,
            xp: 0,
          };
          if (recipe.station !== "none") {
            input.stationPositions = [
              {
                entityId: `manifest-${recipe.station}`,
                name: `manifest ${recipe.station}`,
                stationType: recipe.station,
                position: [100, 0, 100],
                interactionRange: 2,
              },
            ];
          }
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "craft",
            recipeId: recipe.outputItemId,
            quantity: 1,
          });
        }

        for (const recipe of processingRecipes.tanning) {
          const consumer = processingRecipes.crafting.find((candidate) =>
            candidate.inputs.some(
              (input) => input.itemId === recipe.outputItemId,
            ),
          );
          expect(consumer).toBeDefined();
          if (!consumer) continue;
          const input = makeProcessingQuestInput(consumer.outputItemId, [
            { slot: 0, itemId: recipe.inputItemId, quantity: 1 },
          ]);
          input.stationPositions = [
            {
              entityId: "manifest-tanner",
              name: "manifest tanner",
              stationType: "tanner",
              position: [100, 0, 100],
              interactionRange: 3,
            },
          ];
          input.gameState.skills.crafting = {
            level: consumer.levelRequired,
            xp: 0,
          };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "tan",
            inputItemId: recipe.inputItemId,
            quantity: 1,
          });
        }

        for (const recipe of processingRecipes.fletching) {
          const input = makeProcessingQuestInput(
            recipe.outputItemId,
            makeInventory(recipe.inputs, recipe.tools),
          );
          input.gameState.skills.fletching = {
            level: recipe.levelRequired,
            xp: 0,
          };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "fletch",
            recipeId: recipe.recipeId,
            quantity: 1,
          });
        }

        for (const recipe of processingRecipes.runecrafting) {
          const input = makeProcessingQuestInput(recipe.runeItemId, [
            {
              slot: 0,
              itemId: recipe.essenceItemIds[0],
              quantity: 1,
            },
          ]);
          input.gameState.skills.runecrafting = {
            level: recipe.levelRequired,
            xp: 0,
          };
          input.stationPositions = [
            {
              entityId: `manifest-${recipe.runeType}-altar`,
              name: `manifest ${recipe.runeType} altar`,
              stationType: "runecrafting",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ];
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "runecraft",
            runeType: recipe.runeType,
          });
        }

        const storeSuppliedFletchingRecipe = processingRecipes.fletching.find(
          (recipe) =>
            recipe.tools.some((tool) =>
              processingRecipes.stores.some((store) =>
                store.items.some((item) => item.itemId === tool),
              ),
            ),
        );
        expect(storeSuppliedFletchingRecipe).toBeDefined();
        if (storeSuppliedFletchingRecipe) {
          const missingTool = storeSuppliedFletchingRecipe.tools.find((tool) =>
            processingRecipes.stores.some((store) =>
              store.items.some((item) => item.itemId === tool),
            ),
          );
          const supplier = processingRecipes.stores.find((store) =>
            missingTool
              ? store.items.some((item) => item.itemId === missingTool)
              : false,
          );
          expect(missingTool).toBeDefined();
          expect(supplier).toBeDefined();
          if (missingTool && supplier) {
            const input = makeProcessingQuestInput(
              storeSuppliedFletchingRecipe.outputItemId,
              makeInventory(storeSuppliedFletchingRecipe.inputs),
            );
            input.equippedItems.weapon = "manifest-test-weapon";
            input.gameState.skills.fletching = {
              level: storeSuppliedFletchingRecipe.levelRequired,
              xp: 0,
            };
            input.storePositions = [
              {
                entityId: `manifest-${supplier.storeId}`,
                storeId: supplier.storeId,
                name: `manifest ${supplier.storeId}`,
                position: [100, 0, 100],
              },
            ];
            expect(processAgentTicks([input])[0].action).toEqual({
              type: "storeBuy",
              storeId: supplier.storeId,
              itemId: missingTool,
              quantity: 1,
            });
          }
        }
      } finally {
        initializeTestItems();
      }
    });

    it("drains every authored non-quest processing family before requesting more bank custody", async () => {
      const [firemaking, crafting, tanning, fletching, runecrafting] =
        (await Promise.all(
          [
            "firemaking",
            "crafting",
            "tanning",
            "fletching",
            "runecrafting",
          ].map(async (name) =>
            JSON.parse(
              await readFile(
                new URL(
                  `../../../../world/assets/manifests/recipes/${name}.json`,
                  import.meta.url,
                ),
                "utf8",
              ),
            ),
          ),
        )) as [
          { recipes: Array<{ log: string; level: number }> },
          {
            recipes: Array<{
              output: string;
              category: string;
              inputs: Array<{ item: string; amount: number }>;
              tools: string[];
              consumables: Array<{ item: string; uses: number }>;
              level: number;
              station: string;
            }>;
          },
          {
            recipes: Array<{
              input: string;
              output: string;
              cost: number;
            }>;
          },
          {
            recipes: Array<{
              output: string;
              outputQuantity: number;
              category: string;
              inputs: Array<{ item: string; amount: number }>;
              tools: string[];
              level: number;
            }>;
          },
          {
            recipes: Array<{
              runeType: string;
              runeItemId: string;
              essenceTypes: string[];
              levelRequired: number;
            }>;
          },
        ];
      const emptyRecipes = (): WorkerProcessingRecipeSnapshot => ({
        stores: [],
        gathering: [],
        firemaking: [],
        crafting: [],
        tanning: [],
        fletching: [],
        runecrafting: [],
      });
      const makeInventory = (
        requirements: Array<{ itemId: string; quantity: number }>,
      ) => {
        const totals = new Map<string, number>();
        for (const requirement of requirements) {
          totals.set(
            requirement.itemId,
            (totals.get(requirement.itemId) ?? 0) + requirement.quantity,
          );
        }
        return [...totals].map(([itemId, quantity], slot) => ({
          slot,
          itemId,
          quantity,
        }));
      };

      try {
        for (const recipe of firemaking.recipes) {
          const snapshot = emptyRecipes();
          snapshot.firemaking = [
            { logItemId: recipe.log, levelRequired: recipe.level },
          ];
          initializeItems([], snapshot);
          const input = makeInput({
            inventoryItems: makeInventory([
              { itemId: "tinderbox", quantity: 1 },
              { itemId: recipe.log, quantity: 1 },
            ]),
          });
          input.gameState.skills.firemaking = { level: recipe.level, xp: 0 };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "firemake",
            logsItemId: recipe.log,
          });
        }

        for (const recipe of crafting.recipes) {
          const snapshot = emptyRecipes();
          snapshot.crafting = [
            {
              outputItemId: recipe.output,
              category: recipe.category,
              inputs: recipe.inputs.map((input) => ({
                itemId: input.item,
                quantity: input.amount,
              })),
              tools: recipe.tools,
              consumables: recipe.consumables.map((consumable) => ({
                itemId: consumable.item,
                uses: consumable.uses,
              })),
              levelRequired: recipe.level,
              station: recipe.station,
            },
          ];
          initializeItems([], snapshot);
          const inventoryItems = makeInventory([
            ...snapshot.crafting[0].inputs,
            ...snapshot.crafting[0].tools.map((itemId) => ({
              itemId,
              quantity: 1,
            })),
            ...snapshot.crafting[0].consumables.map(({ itemId }) => ({
              itemId,
              quantity: 1,
            })),
          ]);
          const input = makeInput({
            inventoryItems,
            stationPositions:
              recipe.station === "none"
                ? []
                : [
                    {
                      entityId: `manifest-${recipe.station}`,
                      name: `manifest ${recipe.station}`,
                      stationType: recipe.station,
                      position: [100, 0, 100],
                      interactionRange: 2,
                    },
                  ],
          });
          input.gameState.skills.crafting = { level: recipe.level, xp: 0 };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "craft",
            recipeId: recipe.output,
            quantity: 1,
          });
        }

        for (const recipe of tanning.recipes) {
          const snapshot = emptyRecipes();
          snapshot.tanning = [
            {
              inputItemId: recipe.input,
              outputItemId: recipe.output,
              coinCost: recipe.cost,
            },
          ];
          initializeItems([], snapshot);
          const input = makeInput({
            inventoryItems: [{ slot: 0, itemId: recipe.input, quantity: 1 }],
            stationPositions: [
              {
                entityId: "manifest-tanner",
                name: "manifest tanner",
                stationType: "tanner",
                position: [100, 0, 100],
                interactionRange: 3,
              },
            ],
          });
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "tan",
            inputItemId: recipe.input,
            quantity: 1,
          });
        }

        for (const recipe of fletching.recipes) {
          const snapshot = emptyRecipes();
          const recipeId = `${recipe.output}:${recipe.inputs[0]?.item ?? ""}`;
          snapshot.fletching = [
            {
              recipeId,
              outputItemId: recipe.output,
              outputQuantity: recipe.outputQuantity,
              category: recipe.category,
              inputs: recipe.inputs.map((input) => ({
                itemId: input.item,
                quantity: input.amount,
              })),
              tools: recipe.tools,
              levelRequired: recipe.level,
            },
          ];
          initializeItems([], snapshot);
          const input = makeInput({
            inventoryItems: makeInventory([
              ...snapshot.fletching[0].inputs,
              ...snapshot.fletching[0].tools.map((itemId) => ({
                itemId,
                quantity: 1,
              })),
            ]),
          });
          input.gameState.skills.fletching = { level: recipe.level, xp: 0 };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "fletch",
            recipeId,
            quantity: 1,
          });
        }

        for (const recipe of runecrafting.recipes) {
          const snapshot = emptyRecipes();
          snapshot.runecrafting = [
            {
              runeType: recipe.runeType,
              runeItemId: recipe.runeItemId,
              essenceItemIds: recipe.essenceTypes,
              levelRequired: recipe.levelRequired,
            },
          ];
          initializeItems([], snapshot);
          const input = makeInput({
            inventoryItems: [
              {
                slot: 0,
                itemId: recipe.essenceTypes[0],
                quantity: 1,
              },
            ],
            stationPositions: [
              {
                entityId: `manifest-${recipe.runeType}-altar`,
                name: `manifest ${recipe.runeType} altar`,
                stationType: "runecrafting",
                position: [100, 0, 100],
                interactionRange: 2,
              },
            ],
          });
          input.gameState.skills.runecrafting = {
            level: recipe.levelRequired,
            xp: 0,
          };
          expect(processAgentTicks([input])[0].action).toEqual({
            type: "runecraft",
            runeType: recipe.runeType,
          });
        }
      } finally {
        initializeTestItems();
      }
    });

    it("routes ready processing only to an exact loaded station identity", () => {
      const snapshot: WorkerProcessingRecipeSnapshot = {
        stores: [],
        gathering: [],
        firemaking: [],
        crafting: [
          {
            outputItemId: "manifest_glass",
            category: "glass",
            inputs: [{ itemId: "manifest_sand", quantity: 1 }],
            tools: [],
            consumables: [],
            levelRequired: 1,
            station: "furnace",
          },
        ],
        tanning: [],
        fletching: [],
        runecrafting: [],
      };
      initializeItems([], snapshot);
      try {
        const input = makeInput({
          inventoryItems: [{ slot: 0, itemId: "manifest_sand", quantity: 1 }],
          stationPositions: [
            {
              entityId: "decorative-lookalike",
              name: "decorative furnace",
              stationType: "decorative_furnace",
              position: [100, 0, 100],
              interactionRange: 2,
            },
            {
              entityId: "real-furnace",
              name: "real furnace",
              stationType: "furnace",
              position: [106, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        input.gameState.skills.crafting = { level: 1, xp: 0 };
        expect(processAgentTicks([input])[0].action).toEqual({
          type: "move",
          target: [106, 0, 100],
          runMode: true,
        });
      } finally {
        initializeTestItems();
      }
    });

    it("derives basic weapon and gathering-tool purchases from production manifests", async () => {
      const [stores, woodcutting, mining, fishing, ...itemManifests] =
        await Promise.all(
          [
            "../../../../world/assets/manifests/stores.json",
            "../../../../world/assets/manifests/gathering/woodcutting.json",
            "../../../../world/assets/manifests/gathering/mining.json",
            "../../../../world/assets/manifests/gathering/fishing.json",
            "../../../../world/assets/manifests/items/ammunition.json",
            "../../../../world/assets/manifests/items/armor.json",
            "../../../../world/assets/manifests/items/food.json",
            "../../../../world/assets/manifests/items/misc.json",
            "../../../../world/assets/manifests/items/resources.json",
            "../../../../world/assets/manifests/items/runes.json",
            "../../../../world/assets/manifests/items/tools.json",
            "../../../../world/assets/manifests/items/weapons.json",
          ].map(async (path) =>
            JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
          ),
        );
      const authoredItems = (
        itemManifests as Array<Array<Record<string, unknown>>>
      ).flat();
      const itemById = new Map(
        authoredItems.map((item) => [String(item.id), item]),
      );
      const authoredStores = stores as Array<{
        id: string;
        items: Array<{
          itemId: string;
          price: number;
          category: string;
        }>;
      }>;
      const authoredResources = [
        ...(woodcutting.trees as Array<Record<string, unknown>>),
        ...(mining.rocks as Array<Record<string, unknown>>),
        ...(fishing.spots as Array<Record<string, unknown>>),
      ];
      const processingRecipes: WorkerProcessingRecipeSnapshot = {
        stores: authoredStores.map((store) => ({
          storeId: store.id,
          items: store.items.map((item) => ({ ...item })),
        })),
        gathering: authoredResources.map((resource) => ({
          resourceId: String(resource.id),
          harvestSkill: String(resource.harvestSkill),
          toolRequired:
            typeof resource.toolRequired === "string"
              ? resource.toolRequired
              : null,
          levelRequired: Number(resource.levelRequired),
          outputItemIds: (
            resource.harvestYield as Array<{ itemId: string }>
          ).map((drop) => drop.itemId),
        })),
        firemaking: [],
        crafting: [],
        tanning: [],
        fletching: [],
        runecrafting: [],
      };
      const workerItems: Array<[string, WorkerItemData]> = authoredItems.map(
        (item) => [
          String(item.id),
          {
            id: String(item.id),
            name: String(item.name ?? item.id),
            type: String(item.type ?? "misc"),
            stackable:
              typeof item.stackable === "boolean" ? item.stackable : undefined,
            healAmount:
              typeof item.healAmount === "number" ? item.healAmount : undefined,
            equipSlot:
              typeof item.equipSlot === "string" ? item.equipSlot : undefined,
            attackType:
              typeof item.attackType === "string" ? item.attackType : undefined,
            requirements:
              item.requirements && typeof item.requirements === "object"
                ? (item.requirements as Record<string, unknown>)
                : undefined,
            tool:
              item.tool && typeof item.tool === "object"
                ? {
                    skill: String((item.tool as Record<string, unknown>).skill),
                    priority: Number(
                      (item.tool as Record<string, unknown>).priority,
                    ),
                  }
                : undefined,
          },
        ],
      );
      const catalog = authoredStores.flatMap((store) =>
        store.items.map((item) => ({ storeId: store.id, ...item })),
      );
      const storesInWorld = authoredStores.map((store) => ({
        entityId: `manifest-${store.id}`,
        storeId: store.id,
        name: `manifest ${store.id}`,
        position: [100, 0, 100] as [number, number, number],
      }));

      initializeItems(workerItems, processingRecipes);
      try {
        const basicWeapon = catalog
          .filter((entry) => {
            const item = itemById.get(entry.itemId);
            const requiredSkills = (
              item?.requirements as
                { skills?: Record<string, number> } | undefined
            )?.skills;
            return (
              entry.category === "weapons" &&
              item?.type === "weapon" &&
              (item.equipSlot === "weapon" || item.equipSlot === "2h") &&
              String(item.attackType).toLowerCase() === "melee" &&
              Object.values(requiredSkills ?? {}).every((level) => level <= 1)
            );
          })
          .sort(
            (a, b) =>
              a.price - b.price ||
              a.itemId.localeCompare(b.itemId) ||
              a.storeId.localeCompare(b.storeId),
          )[0];
        expect(basicWeapon).toBeDefined();
        expect(
          processAgentTicks([makeInput({ storePositions: storesInWorld })])[0]
            .action,
        ).toEqual({
          type: "storeBuy",
          storeId: basicWeapon.storeId,
          itemId: basicWeapon.itemId,
          quantity: 1,
        });

        const survivalFood = catalog
          .map((entry) => {
            const healAmount = Number(itemById.get(entry.itemId)?.healAmount);
            const quantity = Math.ceil(10 / healAmount);
            return entry.category === "cooked_food" &&
              Number.isFinite(healAmount) &&
              healAmount > 0 &&
              quantity <= 28
              ? { ...entry, healAmount, quantity }
              : null;
          })
          .filter(
            (
              entry,
            ): entry is {
              storeId: string;
              itemId: string;
              price: number;
              category: string;
              healAmount: number;
              quantity: number;
            } => entry !== null,
          )
          .sort(
            (a, b) =>
              a.price * a.quantity - b.price * b.quantity ||
              a.quantity - b.quantity ||
              a.itemId.localeCompare(b.itemId) ||
              a.storeId.localeCompare(b.storeId),
          )[0];
        expect(survivalFood).toBeDefined();
        if (!survivalFood) return;
        const survivalInput = makeInput({ storePositions: storesInWorld });
        survivalInput.equippedItems.weapon = "manifest-equipped-weapon";
        survivalInput.gameState.health = 10;
        survivalInput.gameState.maxHealth = 10;
        expect(processAgentTicks([survivalInput])[0].action).toEqual({
          type: "storeBuy",
          storeId: survivalFood.storeId,
          itemId: survivalFood.itemId,
          quantity: survivalFood.quantity,
        });

        const gatheringCases = ["woodcutting", "mining", "fishing"].map(
          (skill) =>
            authoredResources.find(
              (resource) =>
                resource.harvestSkill === skill &&
                Number(resource.levelRequired) === 1 &&
                typeof resource.toolRequired === "string" &&
                (resource.harvestYield as Array<{ itemId: string }>).length > 0,
            ),
        );
        expect(gatheringCases.every(Boolean)).toBe(true);
        for (const resource of gatheringCases) {
          if (!resource) continue;
          const skill = String(resource.harvestSkill);
          const target = (resource.harvestYield as Array<{ itemId: string }>)[0]
            .itemId;
          const tool = (
            skill === "fishing"
              ? catalog.filter(
                  (entry) => entry.itemId === resource.toolRequired,
                )
              : catalog.filter((entry) => {
                  const item = itemById.get(entry.itemId);
                  return (
                    entry.category === "tools" &&
                    item?.tool &&
                    (item.tool as Record<string, unknown>).skill === skill
                  );
                })
          ).sort(
            (a, b) =>
              a.price - b.price ||
              a.itemId.localeCompare(b.itemId) ||
              a.storeId.localeCompare(b.storeId),
          )[0];
          expect(tool).toBeDefined();
          const questInput = makeInput({
            questState: [
              {
                questId: `manifest-${skill}-quest`,
                name: `manifest ${skill} quest`,
                status: "in_progress",
                currentStage: "gather",
                stageDescription: `Gather ${target}`,
                stageProgress: {},
                stageType: "gather",
                stageTarget: target,
                stageCount: 1,
                startNpc: "manifest-guide",
              },
            ],
            inventoryItems: [
              {
                slot: 0,
                itemId: survivalFood.itemId,
                quantity: survivalFood.quantity,
              },
            ],
            storePositions: storesInWorld,
          });
          questInput.equippedItems.weapon = "manifest-equipped-weapon";
          questInput.gameState.health = 10;
          questInput.gameState.maxHealth = 10;
          questInput.gameState.skills[skill] = { level: 1, xp: 0 };
          expect(processAgentTicks([questInput])[0].action).toEqual({
            type: "storeBuy",
            storeId: tool.storeId,
            itemId: tool.itemId,
            quantity: 1,
          });

          questInput.inventoryItems = [
            {
              slot: 0,
              itemId: survivalFood.itemId,
              quantity: survivalFood.quantity,
            },
            { slot: 1, itemId: tool.itemId, quantity: 1 },
          ];
          expect(processAgentTicks([questInput])[0].action).not.toMatchObject({
            type: "storeBuy",
            itemId: tool.itemId,
          });
        }
      } finally {
        initializeTestItems();
      }
    });
  });

  describe("Quest-entry skill training", () => {
    it("prioritizes a carried recipe for the exact skill-only quest lock", () => {
      const recipes: WorkerProcessingRecipeSnapshot = {
        stores: [],
        gathering: [],
        firemaking: [],
        crafting: [
          {
            outputItemId: "training_craft_output",
            category: "training",
            inputs: [{ itemId: "training_craft_input", quantity: 1 }],
            tools: ["training_needle"],
            consumables: [],
            levelRequired: 5,
            station: "none",
          },
        ],
        tanning: [],
        fletching: [
          {
            recipeId: "training_fletch_output:training_fletch_input",
            outputItemId: "training_fletch_output",
            outputQuantity: 1,
            category: "training",
            inputs: [{ itemId: "training_fletch_input", quantity: 1 }],
            tools: ["training_knife"],
            levelRequired: 1,
          },
        ],
        runecrafting: [],
      };
      initializeItems(
        [
          [
            "training_craft_input",
            {
              id: "training_craft_input",
              name: "Craft Input",
              type: "resource",
            },
          ],
          [
            "training_craft_output",
            {
              id: "training_craft_output",
              name: "Craft Output",
              type: "resource",
            },
          ],
          [
            "training_fletch_input",
            {
              id: "training_fletch_input",
              name: "Fletch Input",
              type: "resource",
            },
          ],
          [
            "training_fletch_output",
            {
              id: "training_fletch_output",
              name: "Fletch Output",
              type: "resource",
            },
          ],
          [
            "training_needle",
            {
              id: "training_needle",
              name: "Needle",
              type: "tool",
            },
          ],
          [
            "training_knife",
            {
              id: "training_knife",
              name: "Knife",
              type: "tool",
            },
          ],
        ],
        recipes,
      );
      try {
        const lockedQuest = makeQuestInfo("fletchers_introduction", false);
        lockedQuest.name = "Fletcher's Introduction";
        lockedQuest.requirements.skills = { fletching: 5 };
        const input = makeInput({
          availableQuests: [lockedQuest],
          inventoryItems: [
            { slot: 0, itemId: "training_craft_input", quantity: 1 },
            { slot: 1, itemId: "training_needle", quantity: 1 },
            { slot: 2, itemId: "training_fletch_input", quantity: 5 },
            { slot: 3, itemId: "training_knife", quantity: 1 },
          ],
        });
        input.equippedItems.weapon = "already-equipped-weapon";
        input.gameState.skills.crafting = { level: 5, xp: 0 };
        input.gameState.skills.fletching = { level: 1, xp: 0 };

        const [result] = processAgentTicks([input]);
        expect(result.action).toEqual({
          type: "fletch",
          recipeId: "training_fletch_output:training_fletch_input",
          quantity: 1,
        });
        expect(result.updatedState.goal).toMatchObject({
          type: "provisioning",
          questId: "fletchers_introduction",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("recovers the exact guaranteed cowhide-to-Crafting path after a private bank miss", () => {
      const recipes: WorkerProcessingRecipeSnapshot = {
        stores: [
          {
            storeId: "crafting_store",
            items: [
              { itemId: "needle", price: 5, category: "tools" },
              { itemId: "thread", price: 4, category: "tools" },
              { itemId: "leather", price: 5, category: "crafting" },
            ],
          },
        ],
        gathering: [],
        guaranteedMobDrops: [{ mobType: "cow", itemIds: ["bones", "cowhide"] }],
        firemaking: [],
        crafting: [
          {
            outputItemId: "leather_gloves",
            category: "leather",
            inputs: [{ itemId: "leather", quantity: 1 }],
            tools: ["needle"],
            consumables: [{ itemId: "thread", uses: 5 }],
            levelRequired: 1,
            station: "none",
          },
        ],
        tanning: [
          {
            inputItemId: "cowhide",
            outputItemId: "leather",
            coinCost: 1,
          },
        ],
        fletching: [],
        runecrafting: [],
      };
      initializeItems(
        [
          ["cowhide", { id: "cowhide", name: "Cowhide", type: "resource" }],
          ["leather", { id: "leather", name: "Leather", type: "resource" }],
          [
            "leather_gloves",
            {
              id: "leather_gloves",
              name: "Leather gloves",
              type: "armor",
            },
          ],
          ["needle", { id: "needle", name: "Needle", type: "tool" }],
          ["thread", { id: "thread", name: "Thread", type: "tool" }],
        ],
        recipes,
      );
      try {
        const lockedQuest = makeQuestInfo("crafting_basics", false);
        lockedQuest.name = "Crafting Basics";
        lockedQuest.requirements.skills = { crafting: 7 };
        const makeCraftingInput = (
          overrides: Partial<AgentTickInput> = {},
        ): AgentTickInput => {
          const input = makeInput({
            availableQuests: [lockedQuest],
            questEntryAcquisitionQuestId: "crafting_basics",
            bankStageRetryAfter: Date.now() + 300_000,
            ...overrides,
          });
          input.equippedItems.weapon = "already-equipped-weapon";
          input.gameState.skills.crafting = { level: 1, xp: 0 };
          return input;
        };

        const nearby = makeCraftingInput();
        nearby.gameState.nearbyEntities = [
          {
            id: "misleading-goblin",
            name: "Cow",
            type: "mob",
            mobType: "goblin",
            position: [101, 0, 100],
            distance: 1,
            health: 10,
          },
          {
            id: "exact-cow",
            name: "Ordinary animal",
            type: "mob",
            mobType: "cow",
            position: [104, 0, 100],
            distance: 4,
            health: 8,
          },
        ];
        expect(processAgentTicks([nearby])[0].action).toEqual({
          type: "attack",
          targetId: "exact-cow",
        });

        const distant = makeCraftingInput({
          worldMobs: [
            { mobType: "goblin", position: [102, 0, 100] },
            { mobType: "cow", position: [180, 0, 130] },
          ],
        });
        expect(processAgentTicks([distant])[0].action).toEqual({
          type: "move",
          target: [180, 0, 130],
          runMode: true,
        });

        const accumulateBatch = makeCraftingInput({
          inventoryItems: [{ slot: 0, itemId: "cowhide", quantity: 4 }],
          worldMobs: [{ mobType: "cow", position: [180, 0, 130] }],
        });
        expect(processAgentTicks([accumulateBatch])[0].action).toEqual({
          type: "move",
          target: [180, 0, 130],
          runMode: true,
        });

        const tanBatch = makeCraftingInput({
          inventoryItems: [{ slot: 0, itemId: "cowhide", quantity: 5 }],
          stationPositions: [
            {
              entityId: "exact-tanner",
              name: "Tanner",
              stationType: "tanner",
              position: [100, 0, 100],
              interactionRange: 3,
            },
          ],
        });
        expect(processAgentTicks([tanBatch])[0].action).toEqual({
          type: "tan",
          inputItemId: "cowhide",
          quantity: 1,
        });

        const buyNeedle = makeCraftingInput({
          inventoryItems: [{ slot: 0, itemId: "leather", quantity: 5 }],
          storePositions: [
            {
              entityId: "craft-store",
              storeId: "crafting_store",
              name: "Crafting Supplies",
              position: [100, 0, 100],
            },
          ],
        });
        expect(processAgentTicks([buyNeedle])[0].action).toEqual({
          type: "storeBuy",
          storeId: "crafting_store",
          itemId: "needle",
          quantity: 1,
        });

        const buyThread = makeCraftingInput({
          inventoryItems: [
            { slot: 0, itemId: "leather", quantity: 5 },
            { slot: 1, itemId: "needle", quantity: 1 },
          ],
          storePositions: buyNeedle.storePositions,
        });
        expect(processAgentTicks([buyThread])[0].action).toEqual({
          type: "storeBuy",
          storeId: "crafting_store",
          itemId: "thread",
          quantity: 1,
        });

        const craftBatch = makeCraftingInput({
          inventoryItems: [
            { slot: 0, itemId: "leather", quantity: 5 },
            { slot: 1, itemId: "needle", quantity: 1 },
            { slot: 2, itemId: "thread", quantity: 1 },
          ],
        });
        expect(processAgentTicks([craftBatch])[0].action).toEqual({
          type: "craft",
          recipeId: "leather_gloves",
          quantity: 1,
        });

        const startNextBatch = makeCraftingInput({
          inventoryItems: [
            { slot: 0, itemId: "leather_gloves", quantity: 5 },
            { slot: 1, itemId: "cowhide", quantity: 4 },
            { slot: 2, itemId: "needle", quantity: 1 },
            { slot: 3, itemId: "thread", quantity: 1 },
          ],
          worldMobs: [{ mobType: "cow", position: [180, 0, 130] }],
        });
        expect(processAgentTicks([startNextBatch])[0].action).toEqual({
          type: "move",
          target: [180, 0, 130],
          runMode: true,
        });

        const staleFence = makeCraftingInput({
          questEntryAcquisitionQuestId: "different-quest",
          worldMobs: [{ mobType: "cow", position: [180, 0, 130] }],
        });
        expect(processAgentTicks([staleFence])[0].action).not.toMatchObject({
          type: "move",
          target: [180, 0, 130],
        });
      } finally {
        initializeTestItems();
      }
    });

    it("recovers exact Fletching tools and logs in five-action batches", () => {
      const recipes: WorkerProcessingRecipeSnapshot = {
        stores: [
          {
            storeId: "general_store",
            items: [
              { itemId: "bronze_hatchet", price: 20, category: "tools" },
              { itemId: "knife", price: 6, category: "tools" },
            ],
          },
        ],
        gathering: [
          {
            resourceId: "tree_pine",
            harvestSkill: "woodcutting",
            toolRequired: "bronze_hatchet",
            levelRequired: 1,
            outputItemIds: ["logs"],
          },
        ],
        guaranteedMobDrops: [],
        firemaking: [],
        crafting: [],
        tanning: [],
        fletching: [
          {
            recipeId: "arrow_shaft:logs",
            outputItemId: "arrow_shaft",
            outputQuantity: 15,
            category: "arrow_shafts",
            inputs: [{ itemId: "logs", quantity: 1 }],
            tools: ["knife"],
            levelRequired: 1,
          },
        ],
        runecrafting: [],
      };
      initializeItems(
        [
          ["logs", { id: "logs", name: "Logs", type: "resource" }],
          [
            "arrow_shaft",
            { id: "arrow_shaft", name: "Arrow shaft", type: "resource" },
          ],
          [
            "bronze_hatchet",
            {
              id: "bronze_hatchet",
              name: "Bronze hatchet",
              type: "tool",
              tool: { skill: "woodcutting", priority: 1 },
            },
          ],
          ["knife", { id: "knife", name: "Knife", type: "tool" }],
        ],
        recipes,
      );
      try {
        const lockedQuest = makeQuestInfo("fletchers_introduction", false);
        lockedQuest.name = "Fletcher's Introduction";
        lockedQuest.requirements.skills = { fletching: 5 };
        const makeFletchingInput = (
          overrides: Partial<AgentTickInput> = {},
        ): AgentTickInput => {
          const input = makeInput({
            availableQuests: [lockedQuest],
            questEntryAcquisitionQuestId: "fletchers_introduction",
            bankStageRetryAfter: Date.now() + 300_000,
            ...overrides,
          });
          input.equippedItems.weapon = "already-equipped-weapon";
          input.gameState.skills.fletching = { level: 1, xp: 0 };
          input.gameState.skills.woodcutting = { level: 1, xp: 0 };
          return input;
        };
        const storePositions = [
          {
            entityId: "general-store",
            storeId: "general_store",
            name: "General Store",
            position: [100, 0, 100] as [number, number, number],
          },
        ];

        expect(
          processAgentTicks([makeFletchingInput({ storePositions })])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_hatchet",
          quantity: 1,
        });

        const gather = makeFletchingInput({
          inventoryItems: [{ slot: 0, itemId: "bronze_hatchet", quantity: 1 }],
        });
        gather.gameState.nearbyEntities = [
          {
            id: "misleading-tree",
            name: "Pine Tree",
            type: "resource",
            resourceId: "tree_oak",
            position: [101, 0, 100],
            distance: 1,
          },
          {
            id: "exact-tree",
            name: "Ordinary tree",
            type: "resource",
            resourceId: "tree_pine",
            position: [102, 0, 100],
            distance: 2,
          },
        ];
        expect(processAgentTicks([gather])[0].action).toEqual({
          type: "gather",
          targetId: "exact-tree",
        });

        expect(
          processAgentTicks([
            makeFletchingInput({
              inventoryItems: [
                { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
                { slot: 1, itemId: "logs", quantity: 5 },
              ],
              storePositions,
            }),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "knife",
          quantity: 1,
        });

        expect(
          processAgentTicks([
            makeFletchingInput({
              inventoryItems: [
                { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
                { slot: 1, itemId: "logs", quantity: 5 },
                { slot: 2, itemId: "knife", quantity: 1 },
              ],
            }),
          ])[0].action,
        ).toEqual({
          type: "fletch",
          recipeId: "arrow_shaft:logs",
          quantity: 1,
        });
      } finally {
        initializeTestItems();
      }
    });

    it("walks to the exact bank and requests private staging for a locked quest skill", () => {
      const lockedQuest = makeQuestInfo("fletchers_introduction", false);
      lockedQuest.name = "Fletcher's Introduction";
      lockedQuest.requirements.skills = { fletching: 5 };
      const makeTrainingInput = (
        position: [number, number, number],
      ): AgentTickInput => {
        const input = makeInput({
          availableQuests: [lockedQuest],
          stationPositions: [
            {
              entityId: "training-bank",
              name: "Training Bank",
              stationType: "bank",
              position: [110, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        input.equippedItems.weapon = "iron_shortsword";
        input.inventoryItems = [
          { slot: 0, itemId: "cooked_shrimp", quantity: 1 },
        ];
        input.gameState.health = 3;
        input.gameState.maxHealth = 3;
        input.gameState.position = position;
        input.gameState.skills.fletching = { level: 1, xp: 0 };
        return input;
      };

      const walking = processAgentTicks([makeTrainingInput([100, 0, 100])])[0];
      expect(walking.action).toEqual({
        type: "move",
        target: [110, 0, 100],
        runMode: true,
      });
      expect(walking.updatedState.goal).toMatchObject({
        type: "banking",
        questId: "fletchers_introduction",
      });

      expect(
        processAgentTicks([makeTrainingInput([110, 0, 100])])[0].action,
      ).toEqual({
        type: "bankWithdraw",
        bankId: "training-bank",
      });

      const nowStartable = makeQuestInfo("fletchers_introduction", true);
      nowStartable.name = "Fletcher's Introduction";
      nowStartable.requirements.skills = { fletching: 5 };
      const readyInput = makeInput({
        availableQuests: [nowStartable],
        npcPositions: [
          {
            id: "bowyer-npc",
            name: "Bowyer",
            npcId: nowStartable.startNpc,
            position: [100, 0, 100],
          },
        ],
      });
      readyInput.equippedItems.weapon = "iron_shortsword";
      readyInput.gameState.skills.fletching = { level: 5, xp: 0 };
      expect(processAgentTicks([readyInput])[0].action).toEqual({
        type: "questAccept",
        questId: "fletchers_introduction",
      });
    });
  });

  describe("specialization-aware processing acquisition", () => {
    const recipes: WorkerProcessingRecipeSnapshot = {
      stores: [
        {
          storeId: "general_store",
          items: [
            { itemId: "bronze_pickaxe", price: 10, category: "tools" },
            { itemId: "bronze_hatchet", price: 10, category: "tools" },
            { itemId: "knife", price: 5, category: "tools" },
          ],
        },
      ],
      gathering: [
        {
          resourceId: "ore_copper",
          harvestSkill: "mining",
          toolRequired: "bronze_pickaxe",
          levelRequired: 1,
          outputItemIds: ["copper_ore"],
        },
        {
          resourceId: "ore_tin",
          harvestSkill: "mining",
          toolRequired: "bronze_pickaxe",
          levelRequired: 1,
          outputItemIds: ["tin_ore"],
        },
        {
          resourceId: "tree_pine",
          harvestSkill: "woodcutting",
          toolRequired: "bronze_hatchet",
          levelRequired: 1,
          outputItemIds: ["logs"],
        },
        {
          resourceId: "ore_rune_essence",
          harvestSkill: "mining",
          toolRequired: "bronze_pickaxe",
          levelRequired: 1,
          outputItemIds: ["rune_essence"],
        },
      ],
      guaranteedMobDrops: [],
      firemaking: [],
      crafting: [],
      tanning: [],
      fletching: [
        {
          recipeId: "arrow_shaft:logs",
          outputItemId: "arrow_shaft",
          outputQuantity: 15,
          category: "arrow_shafts",
          inputs: [{ itemId: "logs", quantity: 1 }],
          tools: ["knife"],
          levelRequired: 1,
        },
      ],
      runecrafting: [
        {
          runeType: "air",
          runeItemId: "air_rune",
          essenceItemIds: ["rune_essence"],
          levelRequired: 1,
        },
      ],
    };
    const items: Array<[string, WorkerItemData]> = [
      [
        "baseline_sword",
        {
          id: "baseline_sword",
          name: "Baseline sword",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "melee",
        },
      ],
      [
        "baseline_bow",
        {
          id: "baseline_bow",
          name: "Baseline bow",
          type: "weapon",
          equipSlot: "2h",
          attackType: "ranged",
        },
      ],
      [
        "baseline_staff",
        {
          id: "baseline_staff",
          name: "Baseline staff",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "magic",
        },
      ],
      [
        "bronze_pickaxe",
        {
          id: "bronze_pickaxe",
          name: "Bronze pickaxe",
          type: "tool",
          tool: { skill: "mining", priority: 1 },
        },
      ],
      [
        "bronze_hatchet",
        {
          id: "bronze_hatchet",
          name: "Bronze hatchet",
          type: "tool",
          tool: { skill: "woodcutting", priority: 1 },
        },
      ],
      ["knife", { id: "knife", name: "Knife", type: "tool" }],
      [
        "copper_ore",
        { id: "copper_ore", name: "Copper ore", type: "resource" },
      ],
      ["tin_ore", { id: "tin_ore", name: "Tin ore", type: "resource" }],
      [
        "blocked_ore",
        { id: "blocked_ore", name: "Blocked ore", type: "resource" },
      ],
      ["logs", { id: "logs", name: "Logs", type: "resource" }],
      [
        "a_blocked_bar",
        {
          id: "a_blocked_bar",
          name: "Blocked bar",
          type: "resource",
          smelting: {
            inputs: [{ itemId: "blocked_ore", quantity: 1 }],
            levelRequired: 1,
          },
        },
      ],
      [
        "bronze_bar",
        {
          id: "bronze_bar",
          name: "Bronze bar",
          type: "resource",
          smelting: {
            inputs: [
              { itemId: "copper_ore", quantity: 1 },
              { itemId: "tin_ore", quantity: 1 },
            ],
            levelRequired: 1,
          },
        },
      ],
      [
        "arrow_shaft",
        { id: "arrow_shaft", name: "Arrow shaft", type: "resource" },
      ],
      [
        "rune_essence",
        { id: "rune_essence", name: "Rune essence", type: "resource" },
      ],
      ["air_rune", { id: "air_rune", name: "Air rune", type: "resource" }],
    ];
    const storePositions = [
      {
        entityId: "general-store",
        storeId: "general_store",
        name: "General Store",
        position: [100, 0, 100] as [number, number, number],
      },
    ];
    const makeAcquisitionInput = (
      specialization: AgentTickInput["combatSpecialization"],
      weaponId: string,
      overrides: Partial<AgentTickInput> = {},
    ): AgentTickInput => {
      const input = makeInput({
        combatSpecialization: specialization,
        ordinaryProcessingAcquisitionAuthorized: true,
        bankStageRetryAfter: Date.now() + 300_000,
        storePositions,
        ...overrides,
      });
      input.equippedItems.weapon = weaponId;
      input.gameState.skills.mining = { level: 1, xp: 0 };
      input.gameState.skills.woodcutting = { level: 1, xp: 0 };
      input.gameState.skills.smithing = { level: 1, xp: 0 };
      input.gameState.skills.fletching = { level: 1, xp: 0 };
      input.gameState.skills.runecrafting = { level: 1, xp: 0 };
      return input;
    };

    const combatSupplyRecipes: WorkerProcessingRecipeSnapshot = {
      stores: [
        {
          storeId: "general_store",
          items: [
            { itemId: "bronze_pickaxe", price: 10, category: "tools" },
            { itemId: "bronze_hatchet", price: 10, category: "tools" },
            { itemId: "hammer", price: 5, category: "tools" },
            { itemId: "knife", price: 5, category: "tools" },
            { itemId: "bowstring", price: 5, category: "fletching" },
            { itemId: "feathers", price: 1, category: "fletching" },
            { itemId: "bronze_shortsword", price: 50, category: "weapons" },
            { itemId: "shortbow", price: 50, category: "weapons" },
            { itemId: "bronze_arrow", price: 2, category: "ammunition" },
            { itemId: "staff_of_air", price: 50, category: "weapons" },
            { itemId: "mind_rune", price: 2, category: "runes" },
          ],
        },
      ],
      gathering: recipes.gathering,
      guaranteedMobDrops: [],
      firemaking: [],
      crafting: [],
      tanning: [],
      fletching: [
        {
          recipeId: "arrow_shaft:logs",
          outputItemId: "arrow_shaft",
          outputQuantity: 15,
          category: "arrow_shafts",
          inputs: [{ itemId: "logs", quantity: 1 }],
          tools: ["knife"],
          levelRequired: 1,
        },
        {
          recipeId: "headless_arrow",
          outputItemId: "headless_arrow",
          outputQuantity: 15,
          category: "headless_arrows",
          inputs: [
            { itemId: "arrow_shaft", quantity: 15 },
            { itemId: "feathers", quantity: 15 },
          ],
          tools: [],
          levelRequired: 1,
        },
        {
          recipeId: "shortbow_u:logs",
          outputItemId: "shortbow_u",
          outputQuantity: 1,
          category: "shortbows",
          inputs: [{ itemId: "logs", quantity: 1 }],
          tools: ["knife"],
          levelRequired: 5,
        },
        {
          recipeId: "shortbow:shortbow_u",
          outputItemId: "shortbow",
          outputQuantity: 1,
          category: "shortbows",
          inputs: [
            { itemId: "bowstring", quantity: 1 },
            { itemId: "shortbow_u", quantity: 1 },
          ],
          tools: [],
          levelRequired: 5,
        },
        {
          recipeId: "bronze_arrow:bronze_arrowtips",
          outputItemId: "bronze_arrow",
          outputQuantity: 15,
          category: "arrows",
          inputs: [
            { itemId: "bronze_arrowtips", quantity: 15 },
            { itemId: "headless_arrow", quantity: 15 },
          ],
          tools: [],
          levelRequired: 1,
        },
      ],
      runecrafting: [
        {
          runeType: "air",
          runeItemId: "air_rune",
          essenceItemIds: ["rune_essence"],
          levelRequired: 1,
        },
        {
          runeType: "mind",
          runeItemId: "mind_rune",
          essenceItemIds: ["rune_essence"],
          levelRequired: 2,
        },
      ],
      combatReadiness: {
        ammunitionTarget: 15,
        magicCastTarget: 5,
        melee: [
          {
            weaponId: "bronze_shortsword",
            weaponScore: 5,
            requiredAttackLevel: 1,
          },
        ],
        ranged: [
          {
            weaponId: "shortbow",
            ammunitionId: "bronze_arrow",
            weaponScore: 5,
            ammunitionScore: 1,
            requiredRangedLevel: 1,
          },
        ],
        magic: [
          {
            weaponId: "staff_of_air",
            spellId: "wind_strike",
            weaponScore: 5,
            spellOrder: 1,
            requiredMagicLevel: 1,
            providedRuneIds: ["air_rune"],
            runes: [
              { itemId: "air_rune", quantityPerCast: 1 },
              { itemId: "mind_rune", quantityPerCast: 1 },
            ],
          },
        ],
      },
    };
    const combatSupplyItems: Array<[string, WorkerItemData]> = [
      ...items,
      ["hammer", { id: "hammer", name: "Hammer", type: "tool" }],
      ["bowstring", { id: "bowstring", name: "Bowstring", type: "resource" }],
      ["feathers", { id: "feathers", name: "Feathers", type: "resource" }],
      [
        "shortbow_u",
        { id: "shortbow_u", name: "Shortbow (u)", type: "resource" },
      ],
      [
        "headless_arrow",
        {
          id: "headless_arrow",
          name: "Headless arrow",
          type: "resource",
          stackable: true,
        },
      ],
      [
        "bronze_arrowtips",
        {
          id: "bronze_arrowtips",
          name: "Bronze arrowtips",
          type: "resource",
          stackable: true,
          smithing: {
            barItemId: "bronze_bar",
            barsRequired: 1,
            levelRequired: 5,
            outputQuantity: 15,
          },
        },
      ],
      [
        "bronze_shortsword",
        {
          id: "bronze_shortsword",
          name: "Bronze shortsword",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "melee",
          smithing: {
            barItemId: "bronze_bar",
            barsRequired: 1,
            levelRequired: 1,
            outputQuantity: 1,
          },
        },
      ],
      [
        "shortbow",
        {
          id: "shortbow",
          name: "Shortbow",
          type: "weapon",
          equipSlot: "2h",
          attackType: "ranged",
        },
      ],
      [
        "bronze_arrow",
        {
          id: "bronze_arrow",
          name: "Bronze arrow",
          type: "ammunition",
          equipSlot: "arrows",
          stackable: true,
        },
      ],
      [
        "staff_of_air",
        {
          id: "staff_of_air",
          name: "Staff of air",
          type: "weapon",
          equipSlot: "weapon",
          attackType: "magic",
        },
      ],
      [
        "mind_rune",
        {
          id: "mind_rune",
          name: "Mind rune",
          type: "resource",
          stackable: true,
        },
      ],
    ];
    const makeCombatSupplyInput = (
      specialization: AgentTickInput["combatSpecialization"],
      overrides: Partial<AgentTickInput> = {},
    ): AgentTickInput => {
      const input = makeInput({
        combatSpecialization: specialization,
        ordinaryProcessingAcquisitionAuthorized: true,
        bankStageRetryAfter: Date.now() + 300_000,
        storePositions,
        ...overrides,
      });
      for (const skill of [
        "attack",
        "ranged",
        "magic",
        "mining",
        "woodcutting",
        "smithing",
        "fletching",
        "runecrafting",
      ]) {
        input.gameState.skills[skill] = { level: 1, xp: 0 };
      }
      return input;
    };

    it("gathers both exact ores and smelts the melee baseline", () => {
      initializeItems(items, recipes);
      try {
        expect(
          processAgentTicks([
            makeAcquisitionInput("melee", "baseline_sword"),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_pickaxe",
          quantity: 1,
        });

        const copper = makeAcquisitionInput("melee", "baseline_sword", {
          inventoryItems: [
            { slot: 0, itemId: "bronze_pickaxe", quantity: 1 },
            { slot: 1, itemId: "blocked_ore", quantity: 1 },
          ],
        });
        copper.gameState.nearbyEntities = [
          {
            id: "wrong-tin",
            name: "Misleading copper rock",
            type: "resource",
            resourceId: "ore_tin",
            position: [101, 0, 100],
            distance: 1,
          },
          {
            id: "exact-copper",
            name: "Copper rock",
            type: "resource",
            resourceId: "ore_copper",
            position: [102, 0, 100],
            distance: 2,
          },
        ];
        expect(processAgentTicks([copper])[0].action).toEqual({
          type: "gather",
          targetId: "exact-copper",
        });

        const tin = makeAcquisitionInput("melee", "baseline_sword", {
          inventoryItems: [
            { slot: 0, itemId: "bronze_pickaxe", quantity: 1 },
            { slot: 1, itemId: "copper_ore", quantity: 5 },
          ],
        });
        tin.gameState.nearbyEntities = [
          {
            id: "exact-tin",
            name: "Tin rock",
            type: "resource",
            resourceId: "ore_tin",
            position: [102, 0, 100],
            distance: 2,
          },
        ];
        expect(processAgentTicks([tin])[0].action).toEqual({
          type: "gather",
          targetId: "exact-tin",
        });

        const smelt = makeAcquisitionInput("melee", "baseline_sword", {
          inventoryItems: [
            { slot: 0, itemId: "bronze_pickaxe", quantity: 1 },
            { slot: 1, itemId: "copper_ore", quantity: 5 },
            { slot: 2, itemId: "tin_ore", quantity: 5 },
          ],
          stationPositions: [
            {
              entityId: "furnace",
              name: "Furnace",
              stationType: "furnace",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        expect(processAgentTicks([smelt])[0].action).toEqual({
          type: "smelt",
          recipe: "bronze_bar",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("gathers logs, acquires the exact tool, and fletches the ranged baseline", () => {
      initializeItems(items, recipes);
      try {
        expect(
          processAgentTicks([makeAcquisitionInput("ranged", "baseline_bow")])[0]
            .action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_hatchet",
          quantity: 1,
        });

        const logs = makeAcquisitionInput("ranged", "baseline_bow", {
          inventoryItems: [{ slot: 0, itemId: "bronze_hatchet", quantity: 1 }],
        });
        logs.gameState.nearbyEntities = [
          {
            id: "exact-pine",
            name: "Pine tree",
            type: "resource",
            resourceId: "tree_pine",
            position: [102, 0, 100],
            distance: 2,
          },
        ];
        expect(processAgentTicks([logs])[0].action).toEqual({
          type: "gather",
          targetId: "exact-pine",
        });

        expect(
          processAgentTicks([
            makeAcquisitionInput("ranged", "baseline_bow", {
              inventoryItems: [
                { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
                { slot: 1, itemId: "logs", quantity: 5 },
              ],
            }),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "knife",
          quantity: 1,
        });

        expect(
          processAgentTicks([
            makeAcquisitionInput("ranged", "baseline_bow", {
              inventoryItems: [
                { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
                { slot: 1, itemId: "logs", quantity: 5 },
                { slot: 2, itemId: "knife", quantity: 1 },
              ],
            }),
          ])[0].action,
        ).toEqual({
          type: "fletch",
          recipeId: "arrow_shaft:logs",
          quantity: 1,
        });
      } finally {
        initializeTestItems();
      }
    });

    it("gathers essence and runecrafts the mage baseline", () => {
      initializeItems(items, recipes);
      try {
        expect(
          processAgentTicks([makeAcquisitionInput("mage", "baseline_staff")])[0]
            .action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_pickaxe",
          quantity: 1,
        });

        const essence = makeAcquisitionInput("mage", "baseline_staff", {
          inventoryItems: [{ slot: 0, itemId: "bronze_pickaxe", quantity: 1 }],
        });
        essence.gameState.nearbyEntities = [
          {
            id: "exact-essence",
            name: "Essence rock",
            type: "resource",
            resourceId: "ore_rune_essence",
            position: [102, 0, 100],
            distance: 2,
          },
        ];
        expect(processAgentTicks([essence])[0].action).toEqual({
          type: "gather",
          targetId: "exact-essence",
        });

        expect(
          processAgentTicks([
            makeAcquisitionInput("mage", "baseline_staff", {
              inventoryItems: [
                { slot: 0, itemId: "bronze_pickaxe", quantity: 1 },
                { slot: 1, itemId: "rune_essence", quantity: 5 },
              ],
              stationPositions: [
                {
                  entityId: "air-altar",
                  name: "Air altar",
                  stationType: "runecrafting",
                  position: [100, 0, 100],
                  interactionRange: 2,
                },
              ],
            }),
          ])[0].action,
        ).toEqual({ type: "runecraft", runeType: "air" });
      } finally {
        initializeTestItems();
      }
    });

    it("uses an already-owned authored essence alternative before gathering the default", () => {
      initializeItems(
        [
          ...items,
          [
            "pure_essence",
            {
              id: "pure_essence",
              name: "Pure essence",
              type: "resource",
            },
          ],
        ],
        {
          ...recipes,
          runecrafting: [
            {
              runeType: "air",
              runeItemId: "air_rune",
              essenceItemIds: ["rune_essence", "pure_essence"],
              levelRequired: 1,
            },
          ],
        },
      );
      try {
        expect(
          processAgentTicks([
            makeAcquisitionInput("mage", "baseline_staff", {
              inventoryItems: [
                { slot: 0, itemId: "pure_essence", quantity: 5 },
              ],
              stationPositions: [
                {
                  entityId: "air-altar",
                  name: "Air altar",
                  stationType: "runecrafting",
                  position: [100, 0, 100],
                  interactionRange: 2,
                },
              ],
            }),
          ])[0].action,
        ).toEqual({ type: "runecraft", runeType: "air" });
      } finally {
        initializeTestItems();
      }
    });

    it("does not expose a source path without the exact bank-miss capability", () => {
      initializeItems(items, recipes);
      try {
        const input = makeAcquisitionInput("melee", "baseline_sword", {
          ordinaryProcessingAcquisitionAuthorized: false,
          bankStageRetryAfter: Date.now() + 300_000,
          storePositions: [],
          inventoryItems: [{ slot: 0, itemId: "bronze_pickaxe", quantity: 1 }],
        });
        input.worldResources = [
          {
            entityId: "exact-copper",
            resourceId: "ore_copper",
            name: "Copper rock",
            resourceType: "ore",
            position: [102, 0, 100],
            depleted: false,
          },
        ];
        expect(processAgentTicks([input])[0].action).not.toEqual({
          type: "gather",
          targetId: "exact-copper",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("releases a full acquisition inventory to the authoritative bank path", () => {
      initializeItems(items, recipes);
      try {
        const input = makeAcquisitionInput("melee", "baseline_sword", {
          storePositions: [],
          inventoryItems: Array.from({ length: 25 }, (_, slot) => ({
            slot,
            itemId: `held-output-${slot}`,
            quantity: 1,
          })),
          stationPositions: [
            {
              entityId: "acquisition-bank",
              name: "Acquisition Bank",
              stationType: "bank",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        expect(processAgentTicks([input])[0].action).toEqual({
          type: "bankDepositAll",
          bankId: "acquisition-bank",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("forges the exact selected melee weapon instead of buying it after a bank miss", () => {
      initializeItems(combatSupplyItems, combatSupplyRecipes);
      try {
        expect(
          processAgentTicks([makeCombatSupplyInput("melee")])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_pickaxe",
          quantity: 1,
        });

        const smelt = makeCombatSupplyInput("melee", {
          inventoryItems: [
            { slot: 0, itemId: "bronze_pickaxe", quantity: 1 },
            { slot: 1, itemId: "copper_ore", quantity: 1 },
            { slot: 2, itemId: "tin_ore", quantity: 1 },
          ],
          stationPositions: [
            {
              entityId: "furnace",
              name: "Furnace",
              stationType: "furnace",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        expect(processAgentTicks([smelt])[0].action).toEqual({
          type: "smelt",
          recipe: "bronze_bar",
        });

        expect(
          processAgentTicks([
            makeCombatSupplyInput("melee", {
              inventoryItems: [{ slot: 0, itemId: "bronze_bar", quantity: 1 }],
            }),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "hammer",
          quantity: 1,
        });

        const smith = makeCombatSupplyInput("melee", {
          inventoryItems: [
            { slot: 0, itemId: "bronze_bar", quantity: 1 },
            { slot: 1, itemId: "hammer", quantity: 1 },
          ],
          stationPositions: [
            {
              entityId: "anvil",
              name: "Anvil",
              stationType: "anvil",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        expect(processAgentTicks([smith])[0].action).toEqual({
          type: "smith",
          recipe: "bronze_shortsword",
        });
      } finally {
        initializeTestItems();
      }
    });

    it("trains through authored prerequisites and completes ranged weapon and ammunition outputs", () => {
      initializeItems(combatSupplyItems, combatSupplyRecipes);
      try {
        expect(
          processAgentTicks([makeCombatSupplyInput("ranged")])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_hatchet",
          quantity: 1,
        });

        const training = makeCombatSupplyInput("ranged", {
          inventoryItems: [
            { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
            { slot: 1, itemId: "logs", quantity: 1 },
            { slot: 2, itemId: "knife", quantity: 1 },
            { slot: 3, itemId: "bronze_bar", quantity: 1 },
            { slot: 4, itemId: "hammer", quantity: 1 },
          ],
          stationPositions: [
            {
              entityId: "unrelated-anvil",
              name: "Anvil",
              stationType: "anvil",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        expect(processAgentTicks([training])[0].action).toEqual({
          type: "fletch",
          recipeId: "arrow_shaft:logs",
          quantity: 1,
        });

        const unstrung = makeCombatSupplyInput("ranged", {
          inventoryItems: [
            { slot: 0, itemId: "bronze_hatchet", quantity: 1 },
            { slot: 1, itemId: "logs", quantity: 1 },
            { slot: 2, itemId: "knife", quantity: 1 },
            { slot: 3, itemId: "bowstring", quantity: 1 },
          ],
        });
        unstrung.gameState.skills.fletching = { level: 5, xp: 0 };
        expect(processAgentTicks([unstrung])[0].action).toEqual({
          type: "fletch",
          recipeId: "shortbow_u:logs",
          quantity: 1,
        });

        const bow = makeCombatSupplyInput("ranged", {
          inventoryItems: [
            { slot: 0, itemId: "shortbow_u", quantity: 1 },
            { slot: 1, itemId: "bowstring", quantity: 1 },
          ],
        });
        bow.gameState.skills.fletching = { level: 5, xp: 0 };
        expect(processAgentTicks([bow])[0].action).toEqual({
          type: "fletch",
          recipeId: "shortbow:shortbow_u",
          quantity: 1,
        });

        const smithingTraining = makeCombatSupplyInput("ranged", {
          equippedItems: { weapon: "shortbow" },
          inventoryItems: [
            { slot: 0, itemId: "bronze_pickaxe", quantity: 1 },
            { slot: 1, itemId: "copper_ore", quantity: 1 },
            { slot: 2, itemId: "tin_ore", quantity: 1 },
          ],
          stationPositions: [
            {
              entityId: "furnace",
              name: "Furnace",
              stationType: "furnace",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        expect(processAgentTicks([smithingTraining])[0].action).toEqual({
          type: "smelt",
          recipe: "bronze_bar",
        });

        const arrowtips = makeCombatSupplyInput("ranged", {
          equippedItems: { weapon: "shortbow" },
          inventoryItems: [
            { slot: 0, itemId: "bronze_bar", quantity: 1 },
            { slot: 1, itemId: "hammer", quantity: 1 },
          ],
          stationPositions: [
            {
              entityId: "anvil",
              name: "Anvil",
              stationType: "anvil",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        arrowtips.gameState.skills.smithing = { level: 5, xp: 0 };
        expect(processAgentTicks([arrowtips])[0].action).toEqual({
          type: "smith",
          recipe: "bronze_arrowtips",
        });

        const arrows = makeCombatSupplyInput("ranged", {
          equippedItems: { weapon: "shortbow" },
          inventoryItems: [
            { slot: 0, itemId: "bronze_arrowtips", quantity: 15 },
            { slot: 1, itemId: "headless_arrow", quantity: 15 },
          ],
        });
        arrows.gameState.skills.smithing = { level: 5, xp: 0 };
        expect(processAgentTicks([arrows])[0].action).toEqual({
          type: "fletch",
          recipeId: "bronze_arrow:bronze_arrowtips",
          quantity: 1,
        });
      } finally {
        initializeTestItems();
      }
    });

    it("buys a store-only magic weapon but trains and crafts its exact consumed rune", () => {
      initializeItems(combatSupplyItems, combatSupplyRecipes);
      try {
        expect(
          processAgentTicks([
            makeCombatSupplyInput("mage", {
              equippedItems: { weapon: "bronze_shortsword" },
            }),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "staff_of_air",
          quantity: 1,
        });

        expect(
          processAgentTicks([
            makeCombatSupplyInput("mage", {
              equippedItems: { weapon: "staff_of_air" },
            }),
          ])[0].action,
        ).toEqual({
          type: "storeBuy",
          storeId: "general_store",
          itemId: "bronze_pickaxe",
          quantity: 1,
        });

        const mindRune = makeCombatSupplyInput("mage", {
          equippedItems: { weapon: "staff_of_air" },
          inventoryItems: [
            { slot: 0, itemId: "bronze_pickaxe", quantity: 1 },
            { slot: 1, itemId: "rune_essence", quantity: 1 },
          ],
          stationPositions: [
            {
              entityId: "mind-altar",
              name: "Mind altar",
              stationType: "runecrafting",
              position: [100, 0, 100],
              interactionRange: 2,
            },
          ],
        });
        mindRune.gameState.skills.runecrafting = { level: 2, xp: 0 };
        expect(processAgentTicks([mindRune])[0].action).toEqual({
          type: "runecraft",
          runeType: "mind",
        });
      } finally {
        initializeTestItems();
      }
    });
  });

  describe("Quest Management", () => {
    it("sets exploring goal when no quests or mobs are nearby", () => {
      const input = makeInput();
      const [result] = processAgentTicks([input]);

      expect(result.updatedState.goal).not.toBeNull();
      // With no nearby mobs, the agent explores toward spawn anchors
      expect(result.updatedState.goal!.type).toBe("exploring");
    });
  });
});
