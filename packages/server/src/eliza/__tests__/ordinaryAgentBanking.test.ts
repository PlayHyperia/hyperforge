import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITEMS, ProcessingDataProvider } from "@hyperforge/shared";

import {
  buildOrdinaryBankRetentionManifest,
  buildOrdinaryBankStagePlan,
  executeOrdinaryBankDepositSurplus,
  executeOrdinaryBankStageMaterials,
  getOrdinaryBankOperationId,
  getOrdinaryBankStageOperationId,
  recordOrdinaryBankStageOutcome,
} from "../ordinaryAgentBanking";
import type {
  OrdinaryBankStageExecutionResult,
  OrdinaryCombatSupplyRecipe,
} from "../ordinaryAgentBanking";
import type { AgentInstance } from "../managers/AgentBehaviorTicker";
import type { AgentQuestInfo } from "../types";
import type { OrdinaryCombatReadinessCatalog } from "../ordinaryCombatReadinessSelection";

const testItems = [
  {
    id: "ordinary_hatchet",
    type: "tool",
    tool: { skill: "woodcutting", priority: 1 },
  },
  {
    id: "ordinary_pickaxe",
    type: "tool",
    tool: { skill: "mining", priority: 1 },
  },
  {
    id: "ordinary_weak_hatchet",
    type: "tool",
    tool: { skill: "woodcutting", priority: 5 },
  },
  { id: "ordinary_logs", type: "resource" },
  { id: "ordinary_lobster", type: "consumable", healAmount: 12 },
  { id: "ordinary_shrimp", type: "consumable", healAmount: 3 },
  { id: "ordinary_cooked_low", type: "consumable", healAmount: 3 },
  {
    id: "ordinary_net",
    type: "tool",
    tool: { skill: "fishing", priority: 1 },
  },
  { id: "ordinary_air_rune", type: "misc" },
  { id: "ordinary_arrow", type: "ammunition" },
  { id: "ordinary_ore_a", type: "resource", stackable: true },
  { id: "ordinary_ore_b", type: "resource", stackable: true },
  { id: "ordinary_bar", type: "resource", stackable: false },
  {
    id: "ordinary_sword",
    type: "weapon",
    stackable: false,
    equipSlot: "weapon",
    attackType: "MELEE",
    bonuses: { attack: 5, strength: 4 },
  },
  { id: "ordinary_craft_material", type: "resource", stackable: false },
  { id: "ordinary_craft_output", type: "resource", stackable: false },
  { id: "ordinary_needle", type: "tool", stackable: false },
  { id: "ordinary_thread", type: "tool", stackable: true },
  { id: "hammer", type: "tool", stackable: false },
  {
    id: "ordinary_staff",
    type: "weapon",
    equipSlot: "weapon",
    attackType: "MAGIC",
    bonuses: { attackMagic: 10 },
  },
  {
    id: "ordinary_bow",
    type: "weapon",
    equipSlot: "2h",
    attackType: "RANGED",
    bonuses: { attackRanged: 8 },
  },
  {
    id: "ordinary_raw_low",
    type: "resource",
    stackable: false,
    cooking: {
      cookedItemId: "ordinary_cooked_low",
      burntItemId: "ordinary_burnt_low",
      levelRequired: 1,
      xp: 10,
      stopBurnLevel: { fire: 20, range: 15 },
    },
  },
  {
    id: "ordinary_raw_high",
    type: "resource",
    stackable: false,
    cooking: {
      cookedItemId: "ordinary_cooked_high",
      burntItemId: "ordinary_burnt_high",
      levelRequired: 20,
      xp: 50,
      stopBurnLevel: { fire: 70, range: 65 },
    },
  },
] as const;

function makeInstance(input?: {
  weaponId?: string | null;
  maxHealth?: number;
  combatSpecialization?: "melee" | "ranged" | "mage";
  executeBankDepositAll?: ReturnType<typeof vi.fn>;
  inventory?: Array<{ slot: number; itemId: string; quantity: number }>;
  questState?: Array<{
    questId: string;
    status: string;
    stageTarget?: string;
    stageCount?: number;
  }>;
  availableQuests?: AgentQuestInfo[];
}): AgentInstance {
  const inventory = input?.inventory ?? [
    { slot: 0, itemId: "ordinary_hatchet", quantity: 3 },
    { slot: 1, itemId: "ordinary_weak_hatchet", quantity: 1 },
    { slot: 2, itemId: "ordinary_logs", quantity: 12 },
    { slot: 3, itemId: "ordinary_lobster", quantity: 2 },
    { slot: 4, itemId: "ordinary_shrimp", quantity: 8 },
    { slot: 5, itemId: "ordinary_air_rune", quantity: 50 },
    { slot: 6, itemId: "ordinary_arrow", quantity: 40 },
    ...(input?.combatSpecialization
      ? [
          { slot: 7, itemId: "ordinary_sword", quantity: 1 },
          {
            slot: 8,
            itemId:
              input.combatSpecialization === "mage"
                ? "ordinary_staff"
                : "ordinary_bow",
            quantity: 1,
          },
        ]
      : []),
  ];
  const executeBankDepositAll =
    input?.executeBankDepositAll ?? vi.fn(async () => ({ success: true }));
  return {
    state: "running",
    ...(input?.combatSpecialization
      ? {
          config: {
            characterId: "ordinary-agent",
            accountId: "ordinary-account",
            name: "Ordinary agent",
            combatSpecialization: input.combatSpecialization,
          },
        }
      : {}),
    service: {
      getGameState: () => ({
        maxHealth: input?.maxHealth ?? 20,
        inventory,
        equipment: input?.weaponId
          ? { weapon: { itemId: input.weaponId } }
          : {},
      }),
      getQuestState: () =>
        input?.questState ?? [
          {
            questId: "ordinary-logging-quest",
            status: "in_progress",
            stageTarget: "ordinary_logs",
            stageCount: 5,
          },
        ],
      getAvailableQuests: () => input?.availableQuests ?? [],
      executeBankDepositAll,
    },
  } as unknown as AgentInstance;
}

function makeStageInstance(input?: {
  maxHealth?: number;
  cookingLevel?: number;
  smithingLevel?: number;
  craftingLevel?: number;
  fletchingLevel?: number;
  firemakingLevel?: number;
  runecraftingLevel?: number;
  attackLevel?: number;
  rangedLevel?: number;
  magicLevel?: number;
  combatSpecialization?: "melee" | "ranged" | "mage";
  equipment?: Record<string, { itemId: string; quantity?: number }>;
  coinBalance?: number | null;
  inventory?: Array<{ slot: number; itemId: string; quantity: number }>;
  questTarget?: string | null;
  availableQuests?: AgentQuestInfo[];
  resourceSystemAvailable?: boolean;
  goal?: AgentInstance["goal"];
  executeBankOpen?: ReturnType<typeof vi.fn>;
  executeBankWithdraw?: ReturnType<typeof vi.fn>;
  executeBankWithdrawPlan?: ReturnType<typeof vi.fn>;
}): AgentInstance {
  const inventory = input?.inventory ?? [];
  return {
    state: "running",
    goal: input?.goal ?? null,
    config: {
      characterId: "ordinary-stage-agent",
      accountId: "ordinary-stage-account",
      name: "Ordinary stage agent",
      combatSpecialization: input?.combatSpecialization ?? "melee",
    },
    service: {
      getGameState: () => ({
        inCombat: false,
        health: input?.maxHealth ?? 20,
        maxHealth: input?.maxHealth ?? 20,
        skills: {
          cooking: { level: input?.cookingLevel ?? 99, xp: 0 },
          smithing: { level: input?.smithingLevel ?? 99, xp: 0 },
          crafting: { level: input?.craftingLevel ?? 99, xp: 0 },
          fletching: { level: input?.fletchingLevel ?? 99, xp: 0 },
          firemaking: { level: input?.firemakingLevel ?? 99, xp: 0 },
          runecrafting: { level: input?.runecraftingLevel ?? 99, xp: 0 },
          attack: { level: input?.attackLevel ?? 1, xp: 0 },
          ranged: { level: input?.rangedLevel ?? 1, xp: 0 },
          magic: { level: input?.magicLevel ?? 1, xp: 0 },
        },
        inventory,
        equipment: input?.equipment ?? {},
      }),
      getQuestState: () =>
        input?.questTarget
          ? [
              {
                status: "in_progress",
                stageTarget: input.questTarget,
              },
            ]
          : [],
      getAvailableQuests: () => input?.availableQuests ?? [],
      getWorld: () => ({
        getSystem: (name: string) =>
          name === "resource" && input?.resourceSystemAvailable !== false
            ? {}
            : null,
      }),
      executeBankOpen:
        input?.executeBankOpen ??
        vi.fn(async () => ({ success: false, bankItems: [] })),
      executeBankWithdraw:
        input?.executeBankWithdraw ?? vi.fn(async () => ({ success: false })),
      executeBankWithdrawPlan:
        input?.executeBankWithdrawPlan ??
        vi.fn(async () => ({ success: false })),
      getPrivateCoinBalance: () => input?.coinBalance ?? null,
    },
  } as unknown as AgentInstance;
}

describe("ordinary agent banking policy", () => {
  const previous = new Map<string, unknown>();
  let previousExternalResources: unknown;

  beforeEach(() => {
    previousExternalResources = (globalThis as { EXTERNAL_RESOURCES?: unknown })
      .EXTERNAL_RESOURCES;
    for (const item of testItems) {
      previous.set(item.id, ITEMS.get(item.id));
      ITEMS.set(item.id, {
        ...item,
        name: item.id,
        description: item.id,
        examine: item.id,
        tradeable: true,
        rarity: "common",
        modelPath: null,
        iconPath: "",
      } as never);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [itemId, prior] of previous) {
      if (prior) ITEMS.set(itemId, prior as never);
      else ITEMS.delete(itemId);
    }
    previous.clear();
    (globalThis as { EXTERNAL_RESOURCES?: unknown }).EXTERNAL_RESOURCES =
      previousExternalResources;
  });

  it("privately stages the strongest authored food without exposing bank custody", () => {
    const survivalGoal: AgentInstance["goal"] = {
      type: "banking",
      description: "Stage survival food",
      bankPurpose: "survival_food",
    };
    const bankItem = (itemId: string, quantity: number, slot: number) => ({
      itemId,
      quantity,
      slot,
      tabIndex: 0,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({ maxHealth: 10, goal: survivalGoal }),
        [
          bankItem("ordinary_shrimp", 20, 0),
          bankItem("ordinary_lobster", 5, 1),
        ],
      ),
    ).toEqual({
      activity: "survival_food",
      itemId: "ordinary_lobster",
      quantity: 1,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({ maxHealth: 10, goal: survivalGoal }),
        [bankItem("ordinary_shrimp", 2, 0)],
      ),
    ).toEqual({
      activity: "survival_food",
      itemId: "ordinary_shrimp",
      quantity: 2,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          maxHealth: 50,
          goal: survivalGoal,
          inventory: Array.from({ length: 27 }, (_, slot) => ({
            slot,
            itemId: "ordinary_logs",
            quantity: 1,
          })),
        }),
        [bankItem("ordinary_lobster", 10, 0)],
      ),
    ).toEqual({
      activity: "survival_food",
      itemId: "ordinary_lobster",
      quantity: 1,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({ maxHealth: 10, goal: survivalGoal }),
        [bankItem("ordinary_raw_low", 5, 0)],
      ),
    ).toBeNull();

    (
      globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
    ).EXTERNAL_RESOURCES = new Map([
      [
        "ordinary_fishing_spot",
        {
          id: "ordinary_fishing_spot",
          harvestSkill: "fishing",
          toolRequired: "ordinary_net",
          levelRequired: 1,
          harvestYield: [{ itemId: "ordinary_raw_low" }],
        },
      ],
    ]);
    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          maxHealth: 10,
          cookingLevel: 1,
          goal: survivalGoal,
        }),
        [bankItem("ordinary_net", 1, 0)],
      ),
    ).toEqual({
      activity: "survival_supply_tool",
      itemId: "ordinary_net",
      quantity: 1,
    });
  });

  it("re-derives and stages only the exact selected combat supply from private custody", () => {
    const catalog: OrdinaryCombatReadinessCatalog = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "ordinary_bow",
          ammunitionId: "ordinary_arrow",
          weaponScore: 8,
          ammunitionScore: 7,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const weaponId = catalog.ranged[0]!.weaponId;
    const ammunitionId = catalog.ranged[0]!.ammunitionId;
    const combatGoal: AgentInstance["goal"] = {
      type: "banking",
      description: "Check exact combat supplies",
      bankPurpose: "combat_supply",
    };
    const bankItem = (itemId: string, quantity: number, slot: number) => ({
      itemId,
      quantity,
      slot,
      tabIndex: 0,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          goal: combatGoal,
        }),
        [bankItem("ordinary_ore_a", 100, 0), bankItem(weaponId, 1, 1)],
        catalog,
      ),
    ).toEqual({
      activity: "combat_supply",
      itemId: weaponId,
      quantity: 1,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          goal: combatGoal,
          equipment: {
            weapon: { itemId: weaponId, quantity: 1 },
          },
        }),
        [bankItem(ammunitionId, 17, 0)],
        catalog,
      ),
    ).toEqual({
      activity: "combat_supply",
      itemId: ammunitionId,
      quantity: 17,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          goal: combatGoal,
        }),
        [bankItem("ordinary_ore_a", 100, 0)],
        catalog,
      ),
    ).toBeNull();
  });

  it("recursively stages only banked precursors in the exact selected combat supply graph", () => {
    const catalog: OrdinaryCombatReadinessCatalog = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "ordinary_bow",
          ammunitionId: "ordinary_arrow",
          weaponScore: 8,
          ammunitionScore: 7,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const recipes: OrdinaryCombatSupplyRecipe[] = [
      {
        activity: "smelting",
        stableId: "ordinary_bar",
        outputItemId: "ordinary_bar",
        outputQuantity: 1,
        levelRequired: 1,
        inputAlternatives: [
          [
            { itemId: "ordinary_ore_a", quantity: 1 },
            { itemId: "ordinary_ore_b", quantity: 1 },
          ],
        ],
        tools: [],
      },
      {
        activity: "fletching",
        stableId: "ordinary_arrow",
        outputItemId: "ordinary_arrow",
        outputQuantity: 10,
        levelRequired: 1,
        inputAlternatives: [
          [
            { itemId: "ordinary_bar", quantity: 1 },
            { itemId: "ordinary_logs", quantity: 1 },
          ],
        ],
        tools: ["hammer"],
      },
    ];
    const goal: AgentInstance["goal"] = {
      type: "banking",
      description: "Check exact combat supplies",
      bankPurpose: "combat_supply",
    };
    const bankItem = (itemId: string, quantity: number, slot: number) => ({
      itemId,
      quantity,
      slot,
      tabIndex: 0,
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          goal,
          equipment: { weapon: { itemId: "ordinary_bow" } },
        }),
        [
          bankItem("ordinary_sword", 1, 0),
          bankItem("ordinary_bar", 2, 1),
          bankItem("ordinary_logs", 5, 2),
          bankItem("ordinary_ore_a", 9, 3),
          bankItem("ordinary_ore_b", 3, 4),
          bankItem("hammer", 1, 5),
        ],
        catalog,
        recipes,
      ),
    ).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "ordinary_arrow",
      actionCount: 5,
      items: [
        { itemId: "hammer", quantity: 1 },
        { itemId: "ordinary_bar", quantity: 2 },
        { itemId: "ordinary_logs", quantity: 5 },
        { itemId: "ordinary_ore_a", quantity: 3 },
        { itemId: "ordinary_ore_b", quantity: 3 },
      ],
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          goal,
          equipment: {
            weapon: { itemId: "ordinary_bow" },
            ammunition: { itemId: "ordinary_arrow", quantity: 20 },
          },
        }),
        [
          bankItem("ordinary_bar", 2, 0),
          bankItem("ordinary_logs", 3, 1),
          bankItem("ordinary_ore_a", 1, 2),
          bankItem("ordinary_ore_b", 1, 3),
          bankItem("hammer", 1, 4),
        ],
        catalog,
        recipes,
      ),
    ).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "ordinary_arrow",
      actionCount: 3,
      items: [
        { itemId: "hammer", quantity: 1 },
        { itemId: "ordinary_bar", quantity: 2 },
        { itemId: "ordinary_logs", quantity: 3 },
        { itemId: "ordinary_ore_a", quantity: 1 },
        { itemId: "ordinary_ore_b", quantity: 1 },
      ],
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          goal,
          equipment: { weapon: { itemId: "ordinary_bow" } },
        }),
        [bankItem("ordinary_ore_b", 5, 0), bankItem("ordinary_sword", 1, 1)],
        catalog,
        [
          {
            activity: "fletching",
            stableId: "ordinary_alternative_arrow",
            outputItemId: "ordinary_arrow",
            outputQuantity: 10,
            levelRequired: 1,
            inputAlternatives: [
              [{ itemId: "ordinary_ore_a", quantity: 1 }],
              [{ itemId: "ordinary_ore_b", quantity: 1 }],
            ],
            tools: [],
          },
        ],
      ),
    ).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "ordinary_arrow",
      actionCount: 5,
      items: [{ itemId: "ordinary_ore_b", quantity: 5 }],
    });

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          goal,
          equipment: { weapon: { itemId: "ordinary_bow" } },
          inventory: [
            { slot: 0, itemId: "ordinary_bar", quantity: 2 },
            { slot: 1, itemId: "ordinary_logs", quantity: 5 },
            { slot: 2, itemId: "ordinary_ore_a", quantity: 3 },
            { slot: 3, itemId: "ordinary_ore_b", quantity: 3 },
            { slot: 4, itemId: "hammer", quantity: 1 },
          ],
        }),
        [bankItem("ordinary_sword", 1, 0)],
        catalog,
        recipes,
      ),
    ).toBeNull();
  });

  it("stages banked gathering tools for unresolved leaves in the exact combat-supply graph", () => {
    (
      globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
    ).EXTERNAL_RESOURCES = new Map([
      [
        "ordinary_copper_rock",
        {
          id: "ordinary_copper_rock",
          harvestSkill: "mining",
          toolRequired: "pickaxe",
          levelRequired: 1,
          harvestYield: [{ itemId: "ordinary_ore_a" }],
        },
      ],
      [
        "ordinary_tin_rock",
        {
          id: "ordinary_tin_rock",
          harvestSkill: "mining",
          toolRequired: "pickaxe",
          levelRequired: 1,
          harvestYield: [{ itemId: "ordinary_ore_b" }],
        },
      ],
      [
        "ordinary_tree",
        {
          id: "ordinary_tree",
          harvestSkill: "woodcutting",
          toolRequired: "ordinary_hatchet",
          levelRequired: 1,
          harvestYield: [{ itemId: "ordinary_logs" }],
        },
      ],
    ]);
    const catalog: OrdinaryCombatReadinessCatalog = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "ordinary_bow",
          ammunitionId: "ordinary_arrow",
          weaponScore: 8,
          ammunitionScore: 7,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const recipes: OrdinaryCombatSupplyRecipe[] = [
      {
        activity: "smelting",
        stableId: "ordinary_bar",
        outputItemId: "ordinary_bar",
        outputQuantity: 1,
        levelRequired: 1,
        inputAlternatives: [
          [
            { itemId: "ordinary_ore_a", quantity: 1 },
            { itemId: "ordinary_ore_b", quantity: 1 },
          ],
        ],
        tools: [],
      },
      {
        activity: "fletching",
        stableId: "ordinary_arrow",
        outputItemId: "ordinary_arrow",
        outputQuantity: 10,
        levelRequired: 1,
        inputAlternatives: [
          [
            { itemId: "ordinary_bar", quantity: 1 },
            { itemId: "ordinary_logs", quantity: 1 },
          ],
        ],
        tools: [],
      },
    ];

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          smithingLevel: 1,
          fletchingLevel: 1,
          goal: {
            type: "banking",
            description: "Check exact combat supplies",
            bankPurpose: "combat_supply",
          },
          equipment: { weapon: { itemId: "ordinary_bow" } },
        }),
        [
          {
            itemId: "ordinary_hatchet",
            quantity: 1,
            slot: 0,
            tabIndex: 0,
          },
          {
            itemId: "ordinary_pickaxe",
            quantity: 1,
            slot: 1,
            tabIndex: 0,
          },
          {
            itemId: "ordinary_craft_material",
            quantity: 5,
            slot: 2,
            tabIndex: 0,
          },
        ],
        catalog,
        recipes,
      ),
    ).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "ordinary_arrow",
      actionCount: 5,
      items: [
        { itemId: "ordinary_hatchet", quantity: 1 },
        { itemId: "ordinary_pickaxe", quantity: 1 },
      ],
    });
  });

  it("skips blocked training recipes and stages the exact first source-complete skill detour", () => {
    (
      globalThis as { EXTERNAL_RESOURCES?: Map<string, unknown> }
    ).EXTERNAL_RESOURCES = new Map([
      [
        "ordinary_copper_rock",
        {
          id: "ordinary_copper_rock",
          harvestSkill: "mining",
          toolRequired: "pickaxe",
          levelRequired: 1,
          harvestYield: [{ itemId: "ordinary_ore_a" }],
        },
      ],
    ]);
    const catalog: OrdinaryCombatReadinessCatalog = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "ordinary_bow",
          ammunitionId: "ordinary_arrow",
          weaponScore: 8,
          ammunitionScore: 7,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const recipes: OrdinaryCombatSupplyRecipe[] = [
      {
        activity: "fletching",
        stableId: "blocked_training",
        outputItemId: "ordinary_craft_output",
        outputQuantity: 1,
        levelRequired: 1,
        inputAlternatives: [[{ itemId: "unobtainable_input", quantity: 1 }]],
        tools: [],
      },
      {
        activity: "fletching",
        stableId: "source_complete_training",
        outputItemId: "ordinary_bar",
        outputQuantity: 1,
        levelRequired: 1,
        inputAlternatives: [[{ itemId: "ordinary_ore_a", quantity: 1 }]],
        tools: ["ordinary_pickaxe"],
      },
      {
        activity: "fletching",
        stableId: "locked_arrow",
        outputItemId: "ordinary_arrow",
        outputQuantity: 10,
        levelRequired: 20,
        inputAlternatives: [
          [{ itemId: "ordinary_craft_material", quantity: 1 }],
        ],
        tools: [],
      },
    ];

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          combatSpecialization: "ranged",
          rangedLevel: 1,
          fletchingLevel: 1,
          goal: {
            type: "banking",
            description: "Stage exact locked-skill training",
            bankPurpose: "combat_supply",
          },
          equipment: { weapon: { itemId: "ordinary_bow" } },
        }),
        [
          {
            itemId: "ordinary_bar",
            quantity: 1,
            slot: 0,
            tabIndex: 0,
          },
          {
            itemId: "ordinary_pickaxe",
            quantity: 1,
            slot: 1,
            tabIndex: 0,
          },
        ],
        catalog,
        recipes,
      ),
    ).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "ordinary_arrow",
      actionCount: 5,
      items: [{ itemId: "ordinary_pickaxe", quantity: 1 }],
    });
  });

  it("can stage every authored single-input cooking and Smithing batch from the production manifests", async () => {
    const recipePath = new URL(
      "../../../world/assets/manifests/recipes/cooking.json",
      import.meta.url,
    );
    const smithingPath = new URL(
      "../../../world/assets/manifests/recipes/smithing.json",
      import.meta.url,
    );
    const resourcePath = new URL(
      "../../../world/assets/manifests/items/resources.json",
      import.meta.url,
    );
    const recipeManifest = JSON.parse(await readFile(recipePath, "utf8")) as {
      recipes: Array<{
        raw: string;
        cooked: string;
        burnt: string;
        level: number;
        xp: number;
        ticks: number;
        stopBurnLevel: { fire: number; range: number };
      }>;
    };
    const resources = JSON.parse(
      await readFile(resourcePath, "utf8"),
    ) as Array<{ id?: string; [key: string]: unknown }>;
    const smithingManifest = JSON.parse(
      await readFile(smithingPath, "utf8"),
    ) as {
      recipes: Array<{
        output: string;
        bar: string;
        barsRequired: number;
        level: number;
        xp: number;
        ticks: number;
        category: string;
        outputQuantity?: number;
      }>;
    };
    const resourceIds = new Set(resources.map((resource) => resource.id));
    for (const resource of resources) {
      if (!resource.id) continue;
      if (!previous.has(resource.id)) {
        previous.set(resource.id, ITEMS.get(resource.id));
      }
      ITEMS.set(resource.id, resource as never);
    }
    const provider = ProcessingDataProvider.getInstance();
    provider.loadCookingRecipes(recipeManifest);
    provider.loadSmithingRecipes(smithingManifest);
    provider.rebuild();

    expect(recipeManifest.recipes.length).toBeGreaterThan(0);
    for (const recipe of recipeManifest.recipes) {
      expect(resourceIds.has(recipe.raw)).toBe(true);
      expect(
        buildOrdinaryBankStagePlan(
          makeStageInstance({ cookingLevel: recipe.level }),
          [
            {
              itemId: recipe.raw,
              quantity: 5,
              slot: 0,
              tabIndex: 0,
            },
          ],
        ),
      ).toEqual({
        activity: "cooking",
        itemId: recipe.raw,
        quantity: 5,
      });
    }

    expect(smithingManifest.recipes.length).toBeGreaterThan(0);
    for (const recipe of smithingManifest.recipes) {
      expect(resourceIds.has(recipe.bar)).toBe(true);
      expect(
        buildOrdinaryBankStagePlan(
          makeStageInstance({
            cookingLevel: 1,
            smithingLevel: recipe.level,
            questTarget: recipe.output,
            inventory: [{ slot: 0, itemId: "hammer", quantity: 1 }],
          }),
          [
            {
              itemId: recipe.bar,
              quantity: recipe.barsRequired * 5,
              slot: 0,
              tabIndex: 0,
            },
          ],
        ),
      ).toEqual({
        activity: "smithing",
        recipeId: recipe.output,
        itemId: recipe.bar,
        quantity: recipe.barsRequired * 5,
        actionCount: 5,
        items: [
          {
            itemId: recipe.bar,
            quantity: recipe.barsRequired * 5,
          },
        ],
      });
    }
    const recoveryRecipe = smithingManifest.recipes[0];
    expect(recoveryRecipe).toBeDefined();
    if (!recoveryRecipe) return;
    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          smithingLevel: recoveryRecipe.level,
          questTarget: recoveryRecipe.output,
        }),
        [
          {
            itemId: recoveryRecipe.bar,
            quantity: recoveryRecipe.barsRequired * 5,
            slot: 0,
            tabIndex: 0,
          },
          { itemId: "hammer", quantity: 1, slot: 1, tabIndex: 0 },
        ],
      ),
    ).toEqual({
      activity: "smithing",
      recipeId: recoveryRecipe.output,
      itemId: recoveryRecipe.bar,
      quantity: recoveryRecipe.barsRequired * 5,
      actionCount: 5,
      items: [
        {
          itemId: recoveryRecipe.bar,
          quantity: recoveryRecipe.barsRequired * 5,
        },
        { itemId: "hammer", quantity: 1 },
      ],
    });
  });

  it("derives complete Smelting, Crafting, and Fletching batches from production manifests", async () => {
    const [smelting, crafting, fletching, tanning, ...itemManifests] =
      await Promise.all(
        [
          "smelting",
          "crafting",
          "fletching",
          "tanning",
          "../items/ammunition",
          "../items/armor",
          "../items/food",
          "../items/misc",
          "../items/resources",
          "../items/runes",
          "../items/tools",
          "../items/weapons",
        ].map(async (name) =>
          JSON.parse(
            await readFile(
              new URL(
                `../../../world/assets/manifests/recipes/${name}.json`,
                import.meta.url,
              ),
              "utf8",
            ),
          ),
        ),
      );
    for (const manifest of itemManifests as Array<
      Array<{ id?: string; [key: string]: unknown }>
    >) {
      for (const item of manifest) {
        if (!item.id) continue;
        if (!previous.has(item.id)) previous.set(item.id, ITEMS.get(item.id));
        ITEMS.set(item.id, item as never);
      }
    }
    const provider = ProcessingDataProvider.getInstance();
    provider.loadSmeltingRecipes(smelting);
    provider.loadCraftingRecipes(crafting);
    provider.loadFletchingRecipes(fletching);
    provider.loadTanningRecipes(tanning);
    provider.rebuild();

    const makeBank = (
      requirements: Array<{ itemId: string; quantity: number }>,
    ) =>
      requirements.map((item, slot) => ({
        ...item,
        slot,
        tabIndex: 0,
      }));
    const normalized = (
      requirements: Array<{ itemId: string; quantity: number }>,
    ) => {
      const totals = new Map<string, number>();
      for (const item of requirements) {
        totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.quantity);
      }
      return [...totals]
        .map(([itemId, quantity]) => ({ itemId, quantity }))
        .sort((left, right) => left.itemId.localeCompare(right.itemId));
    };

    const smeltingRecipes = [...provider.getSmeltableBarIds()].map(
      (barItemId) => [barItemId, provider.getSmeltingData(barItemId)] as const,
    );
    expect(smeltingRecipes.length).toBeGreaterThan(0);
    for (const [barItemId, recipe] of smeltingRecipes) {
      expect(recipe?.inputs).toBeDefined();
      if (!recipe?.inputs) continue;
      const maximumItems = normalized(
        recipe.inputs.map((item) => ({
          itemId: item.itemId,
          quantity: item.quantity * 5,
        })),
      );
      const plan = buildOrdinaryBankStagePlan(
        makeStageInstance({
          smithingLevel: recipe.levelRequired,
          questTarget: barItemId,
        }),
        makeBank(maximumItems),
      );
      expect(plan).toMatchObject({
        activity: "smelting",
        recipeId: barItemId,
      });
      if (!plan || !("items" in plan)) continue;
      expect(plan.actionCount).toBeGreaterThanOrEqual(1);
      expect(plan.actionCount).toBeLessThanOrEqual(5);
      expect(plan.items).toEqual(
        normalized(
          recipe.inputs.map((item) => ({
            itemId: item.itemId,
            quantity: item.quantity * plan.actionCount,
          })),
        ),
      );
    }

    const craftingRecipes = provider.getAllCraftingRecipes();
    expect(craftingRecipes.length).toBeGreaterThan(0);
    for (const recipe of craftingRecipes) {
      const maximumItems = normalized([
        ...recipe.inputs.map((item) => ({
          itemId: item.item,
          quantity: item.amount * 5,
        })),
        ...recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
        ...recipe.consumables.map((consumable) => ({
          itemId: consumable.item,
          quantity: Math.ceil(5 / consumable.uses),
        })),
      ]);
      const plan = buildOrdinaryBankStagePlan(
        makeStageInstance({
          craftingLevel: recipe.level,
          questTarget: recipe.output,
        }),
        makeBank(maximumItems),
      );
      expect(plan).toMatchObject({
        activity: "crafting",
        recipeId: recipe.output,
      });
      if (!plan || !("items" in plan)) continue;
      expect(plan.actionCount).toBeGreaterThanOrEqual(1);
      expect(plan.actionCount).toBeLessThanOrEqual(5);
      expect(plan.items).toEqual(
        normalized([
          ...recipe.inputs.map((item) => ({
            itemId: item.item,
            quantity: item.amount * plan.actionCount,
          })),
          ...recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
          ...recipe.consumables.map((consumable) => ({
            itemId: consumable.item,
            quantity: Math.ceil(plan.actionCount / consumable.uses),
          })),
        ]),
      );
    }

    const fletchingRecipes = provider.getAllFletchingRecipes();
    expect(fletchingRecipes.length).toBeGreaterThan(0);
    for (const recipe of fletchingRecipes) {
      const maximumItems = normalized([
        ...recipe.inputs.map((item) => ({
          itemId: item.item,
          quantity: item.amount * 5,
        })),
        ...recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
      ]);
      const plan = buildOrdinaryBankStagePlan(
        makeStageInstance({
          fletchingLevel: recipe.level,
          questTarget: recipe.output,
        }),
        makeBank(maximumItems),
      );
      expect(plan).toMatchObject({
        activity: "fletching",
        recipeId: recipe.recipeId,
      });
      if (!plan || !("items" in plan)) continue;
      expect(plan.actionCount).toBeGreaterThanOrEqual(1);
      expect(plan.actionCount).toBeLessThanOrEqual(5);
      expect(plan.items).toEqual(
        normalized([
          ...recipe.inputs.map((item) => ({
            itemId: item.item,
            quantity: item.amount * plan.actionCount,
          })),
          ...recipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
        ]),
      );
    }

    const trainingRecipe = fletchingRecipes
      .filter((recipe) => recipe.level <= 1)
      .sort((left, right) => left.recipeId.localeCompare(right.recipeId))[0];
    const unrelatedRecipe = craftingRecipes
      .filter((recipe) => recipe.level <= 1)
      .sort((left, right) => left.output.localeCompare(right.output))[0];
    expect(trainingRecipe).toBeDefined();
    expect(unrelatedRecipe).toBeDefined();
    if (!trainingRecipe || !unrelatedRecipe) return;

    const lockedFletchingQuest: AgentQuestInfo = {
      questId: "fletchers_introduction",
      name: "Fletcher's Introduction",
      description: "Learn Fletching",
      difficulty: "novice",
      status: "not_started",
      canStart: false,
      requirements: {
        quests: [],
        skills: { fletching: 5 },
        items: [],
      },
      startNpc: "bowyer",
      onStartItems: [],
      rewardItems: [],
      stages: [],
    };
    const trainingRequirements = normalized([
      ...trainingRecipe.inputs.map((item) => ({
        itemId: item.item,
        quantity: item.amount * 5,
      })),
      ...trainingRecipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
    ]);
    const unrelatedRequirements = normalized([
      ...unrelatedRecipe.inputs.map((item) => ({
        itemId: item.item,
        quantity: item.amount * 5,
      })),
      ...unrelatedRecipe.tools.map((itemId) => ({ itemId, quantity: 1 })),
      ...unrelatedRecipe.consumables.map((consumable) => ({
        itemId: consumable.item,
        quantity: Math.ceil(5 / consumable.uses),
      })),
    ]);
    const trainingInstance = makeStageInstance({
      craftingLevel: 1,
      fletchingLevel: 1,
      availableQuests: [lockedFletchingQuest],
      resourceSystemAvailable: true,
      goal: {
        type: "banking",
        description: "Stage Fletching training",
        questId: "fletchers_introduction",
      },
    });
    expect(
      buildOrdinaryBankStagePlan(
        trainingInstance,
        makeBank(
          normalized([...trainingRequirements, ...unrelatedRequirements]),
        ),
      ),
    ).toMatchObject({
      activity: "fletching",
      recipeId: trainingRecipe.recipeId,
    });
    expect(
      buildOrdinaryBankStagePlan(
        trainingInstance,
        makeBank(unrelatedRequirements),
      ),
    ).toBeNull();
    expect(
      buildOrdinaryBankStagePlan(
        trainingInstance,
        makeBank([trainingRequirements[0]]),
      ),
    ).toMatchObject({
      activity: "fletching",
      recipeId: trainingRecipe.recipeId,
      entryTrainingRecovery: true,
      questId: "fletchers_introduction",
      items: [trainingRequirements[0]],
    });

    const lockedCraftingQuest: AgentQuestInfo = {
      ...lockedFletchingQuest,
      questId: "crafting_basics",
      name: "Crafting Basics",
      description: "Learn Crafting",
      requirements: {
        quests: [],
        skills: { crafting: 7 },
        items: [],
      },
      startNpc: "crafting_supplier",
    };
    const craftingTrainingInstance = makeStageInstance({
      craftingLevel: 1,
      fletchingLevel: 1,
      availableQuests: [lockedCraftingQuest, lockedFletchingQuest],
      resourceSystemAvailable: true,
      goal: {
        type: "banking",
        description: "Stage Crafting training",
        questId: "crafting_basics",
      },
    });
    expect(
      buildOrdinaryBankStagePlan(
        craftingTrainingInstance,
        makeBank(
          normalized([...trainingRequirements, ...unrelatedRequirements]),
        ),
      ),
    ).toMatchObject({
      activity: "crafting",
      recipeId: unrelatedRecipe.output,
    });
    expect(
      buildOrdinaryBankStagePlan(
        craftingTrainingInstance,
        makeBank(trainingRequirements),
      ),
    ).toBeNull();
    expect(
      buildOrdinaryBankStagePlan(
        craftingTrainingInstance,
        makeBank([unrelatedRequirements[0]]),
      ),
    ).toMatchObject({
      activity: "crafting",
      recipeId: unrelatedRecipe.output,
      entryTrainingRecovery: true,
      questId: "crafting_basics",
      items: [unrelatedRequirements[0]],
    });

    const leatherInput = unrelatedRecipe.inputs.find((input) =>
      tanning.recipes.some(
        (recipe: { input: string; output: string }) =>
          recipe.output === input.item,
      ),
    );
    const tanningRecipe = tanning.recipes.find(
      (recipe: { input: string; output: string }) =>
        recipe.output === leatherInput?.item,
    );
    expect(tanningRecipe).toBeDefined();
    if (tanningRecipe) {
      expect(
        buildOrdinaryBankStagePlan(
          craftingTrainingInstance,
          makeBank([
            {
              itemId: tanningRecipe.input,
              quantity: 5,
            },
          ]),
        ),
      ).toMatchObject({
        activity: "crafting",
        recipeId: unrelatedRecipe.output,
        entryTrainingRecovery: true,
        questId: "crafting_basics",
        items: [{ itemId: tanningRecipe.input, quantity: 5 }],
      });
    }

    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          craftingLevel: 1,
          fletchingLevel: 5,
          availableQuests: [{ ...lockedFletchingQuest, canStart: true }],
          resourceSystemAvailable: true,
          goal: {
            type: "banking",
            description: "Stale Fletching training request",
            questId: "fletchers_introduction",
          },
        }),
        makeBank(trainingRequirements),
      ),
    ).toBeNull();
  });

  it("authorizes public quest acquisition only after an exact private-bank miss", () => {
    const instance = makeStageInstance({
      goal: {
        type: "banking",
        description: "Stage Crafting training",
        questId: "crafting_basics",
      },
    });
    instance.bankStageRetryAfter = 0;
    instance.questEntryAcquisition = null;
    instance.ordinaryProcessingAcquisition = null;
    instance.survivalFoodAcquisition = null;
    const result = (
      reason: OrdinaryBankStageExecutionResult["reason"],
      applied = false,
    ): OrdinaryBankStageExecutionResult => ({
      settled: true,
      applied,
      receipt: null,
      operationId: "operation",
      retainedItems: [],
      reconciliationAttempts: 1,
      plan: null,
      reason,
    });

    recordOrdinaryBankStageOutcome(instance, result("nothing_to_stage"), 1_000);
    expect(instance.bankStageRetryAfter).toBe(301_000);
    expect(instance.questEntryAcquisition).toEqual({
      questId: "crafting_basics",
      expiresAt: 301_000,
    });
    expect(instance.ordinaryProcessingAcquisition).toBeNull();

    recordOrdinaryBankStageOutcome(
      instance,
      result("bank_open_rejected"),
      2_000,
    );
    expect(instance.bankStageRetryAfter).toBe(32_000);
    expect(instance.questEntryAcquisition).toBeNull();
    expect(instance.ordinaryProcessingAcquisition).toBeNull();
    expect(instance.survivalFoodAcquisition).toBeNull();

    recordOrdinaryBankStageOutcome(instance, result("completed", true), 3_000);
    expect(instance.bankStageRetryAfter).toBe(0);
    expect(instance.questEntryAcquisition).toBeNull();
    expect(instance.ordinaryProcessingAcquisition).toBeNull();
    expect(instance.survivalFoodAcquisition).toBeNull();
  });

  it("authorizes one public ordinary-processing baseline only after an exact general bank miss", () => {
    const instance = makeStageInstance({
      goal: {
        type: "banking",
        description: "Stage an authored processing batch from bank",
      },
    });
    instance.bankStageRetryAfter = 0;
    instance.questEntryAcquisition = null;
    instance.ordinaryProcessingAcquisition = null;
    instance.survivalFoodAcquisition = null;
    const outcome = (
      reason: OrdinaryBankStageExecutionResult["reason"],
      applied = false,
    ): OrdinaryBankStageExecutionResult => ({
      settled: true,
      applied,
      receipt: null,
      operationId: "general-processing-operation",
      retainedItems: [],
      reconciliationAttempts: 1,
      plan: null,
      reason,
    });

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("nothing_to_stage"),
      10_000,
    );
    expect(instance.bankStageRetryAfter).toBe(310_000);
    expect(instance.ordinaryProcessingAcquisition).toEqual({
      expiresAt: 310_000,
    });
    expect(instance.questEntryAcquisition).toBeNull();
    expect(instance.survivalFoodAcquisition).toBeNull();

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("bank_open_rejected"),
      11_000,
    );
    expect(instance.bankStageRetryAfter).toBe(41_000);
    expect(instance.ordinaryProcessingAcquisition).toBeNull();

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("completed", true),
      12_000,
    );
    expect(instance.bankStageRetryAfter).toBe(0);
    expect(instance.ordinaryProcessingAcquisition).toBeNull();
  });

  it("authorizes exact combat self-supply only after a confirmed private-bank miss", () => {
    const instance = makeStageInstance({
      goal: {
        type: "banking",
        description: "Check exact combat supplies",
        bankPurpose: "combat_supply",
      },
    });
    instance.bankStageRetryAfter = 0;
    instance.questEntryAcquisition = null;
    instance.ordinaryProcessingAcquisition = null;
    instance.survivalFoodAcquisition = null;
    const outcome = (
      reason: OrdinaryBankStageExecutionResult["reason"],
      applied = false,
    ): OrdinaryBankStageExecutionResult => ({
      settled: true,
      applied,
      receipt: null,
      operationId: "combat-supply-operation",
      retainedItems: [],
      reconciliationAttempts: 1,
      plan: applied
        ? {
            activity: "combat_supply",
            itemId: "ordinary_bow",
            quantity: 1,
          }
        : null,
      reason,
    });

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("nothing_to_stage"),
      20_000,
    );
    expect(instance.bankStageRetryAfter).toBe(320_000);
    expect(instance.ordinaryProcessingAcquisition).toEqual({
      expiresAt: 320_000,
    });
    expect(instance.questEntryAcquisition).toBeNull();
    expect(instance.survivalFoodAcquisition).toBeNull();

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("bank_open_rejected"),
      21_000,
    );
    expect(instance.bankStageRetryAfter).toBe(51_000);
    expect(instance.ordinaryProcessingAcquisition).toBeNull();

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("completed", true),
      22_000,
    );
    expect(instance.bankStageRetryAfter).toBe(0);
    expect(instance.ordinaryProcessingAcquisition).toBeNull();
  });

  it("authorizes public food recovery only after an exact survival-bank miss", () => {
    const instance = makeStageInstance({
      goal: {
        type: "banking",
        description: "Stage survival food",
        bankPurpose: "survival_food",
      },
    });
    instance.bankStageRetryAfter = 0;
    instance.questEntryAcquisition = null;
    instance.survivalFoodAcquisition = null;
    const outcome = (
      reason: OrdinaryBankStageExecutionResult["reason"],
    ): OrdinaryBankStageExecutionResult => ({
      settled: true,
      applied: false,
      receipt: null,
      operationId: "survival-operation",
      retainedItems: [],
      reconciliationAttempts: 1,
      plan: null,
      reason,
    });

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("nothing_to_stage"),
      5_000,
    );
    expect(instance.bankStageRetryAfter).toBe(305_000);
    expect(instance.survivalFoodAcquisition).toEqual({ expiresAt: 305_000 });

    recordOrdinaryBankStageOutcome(
      instance,
      outcome("bank_open_rejected"),
      6_000,
    );
    expect(instance.bankStageRetryAfter).toBe(36_000);
    expect(instance.survivalFoodAcquisition).toBeNull();

    recordOrdinaryBankStageOutcome(
      instance,
      {
        ...outcome("completed"),
        applied: true,
        plan: {
          activity: "survival_supply_tool",
          itemId: "ordinary_net",
          quantity: 1,
        },
      },
      7_000,
    );
    expect(instance.bankStageRetryAfter).toBe(307_000);
    expect(instance.survivalFoodAcquisition).toEqual({ expiresAt: 307_000 });
  });

  it("stages a conservative fresh consumable unit when the carried head may have only one use", () => {
    const provider = ProcessingDataProvider.getInstance();
    provider.loadSmeltingRecipes({ recipes: [] });
    provider.loadFletchingRecipes({ recipes: [] });
    provider.loadCraftingRecipes({
      recipes: [
        {
          output: "ordinary_craft_output",
          category: "leather",
          inputs: [{ item: "ordinary_craft_material", amount: 1 }],
          tools: ["ordinary_needle"],
          consumables: [{ item: "ordinary_thread", uses: 5 }],
          level: 1,
          xp: 1,
          ticks: 1,
          station: "none",
        },
      ],
    });
    provider.rebuild();
    const bank = [
      {
        itemId: "ordinary_craft_material",
        quantity: 5,
        slot: 0,
        tabIndex: 0,
      },
      { itemId: "ordinary_thread", quantity: 1, slot: 1, tabIndex: 0 },
    ];
    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          craftingLevel: 1,
          questTarget: "ordinary_craft_output",
          inventory: [
            { slot: 0, itemId: "ordinary_needle", quantity: 1 },
            { slot: 1, itemId: "ordinary_thread", quantity: 1 },
          ],
        }),
        bank,
      ),
    ).toEqual({
      activity: "crafting",
      recipeId: "ordinary_craft_output",
      actionCount: 5,
      items: [
        { itemId: "ordinary_craft_material", quantity: 5 },
        { itemId: "ordinary_thread", quantity: 1 },
      ],
    });
    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          craftingLevel: 1,
          questTarget: "ordinary_craft_output",
          inventory: [
            { slot: 0, itemId: "ordinary_needle", quantity: 1 },
            { slot: 1, itemId: "ordinary_thread", quantity: 2 },
          ],
        }),
        bank,
      ),
    ).toEqual({
      activity: "crafting",
      recipeId: "ordinary_craft_output",
      actionCount: 5,
      items: [{ itemId: "ordinary_craft_material", quantity: 5 }],
    });
  });

  it("stages every authored Firemaking, Tanning, and Runecrafting resource batch", async () => {
    const [firemaking, tanning, runecrafting, ...itemManifests] =
      await Promise.all(
        [
          "firemaking",
          "tanning",
          "runecrafting",
          "../items/ammunition",
          "../items/armor",
          "../items/food",
          "../items/misc",
          "../items/resources",
          "../items/runes",
          "../items/tools",
          "../items/weapons",
        ].map(async (name) =>
          JSON.parse(
            await readFile(
              new URL(
                `../../../world/assets/manifests/recipes/${name}.json`,
                import.meta.url,
              ),
              "utf8",
            ),
          ),
        ),
      );
    for (const manifest of itemManifests as Array<
      Array<{ id?: string; [key: string]: unknown }>
    >) {
      for (const item of manifest) {
        if (!item.id) continue;
        if (!previous.has(item.id)) previous.set(item.id, ITEMS.get(item.id));
        ITEMS.set(item.id, item as never);
      }
    }
    const provider = ProcessingDataProvider.getInstance();
    provider.loadSmeltingRecipes({ recipes: [] });
    provider.loadCraftingRecipes({ recipes: [] });
    provider.loadFletchingRecipes({ recipes: [] });
    provider.loadFiremakingRecipes(firemaking);
    provider.loadTanningRecipes(tanning);
    provider.loadRunecraftingRecipes(runecrafting);
    provider.rebuild();

    const firemakingRecipes = firemaking.recipes as Array<{
      log: string;
      level: number;
    }>;
    expect(firemakingRecipes).toHaveLength(8);
    for (const recipe of firemakingRecipes) {
      expect(
        buildOrdinaryBankStagePlan(
          makeStageInstance({
            firemakingLevel: recipe.level,
            questTarget: "fire",
          }),
          [
            { itemId: recipe.log, quantity: 5, slot: 0, tabIndex: 0 },
            { itemId: "tinderbox", quantity: 1, slot: 1, tabIndex: 0 },
          ],
        ),
      ).toEqual({
        activity: "firemaking",
        recipeId: recipe.log,
        actionCount: 5,
        items: [
          { itemId: recipe.log, quantity: 5 },
          { itemId: "tinderbox", quantity: 1 },
        ].sort((left, right) => left.itemId.localeCompare(right.itemId)),
      });
    }

    const tanningRecipes = tanning.recipes as Array<{
      input: string;
      output: string;
      cost: number;
    }>;
    expect(tanningRecipes).toHaveLength(2);
    for (const recipe of tanningRecipes) {
      const bank = [
        { itemId: recipe.input, quantity: 5, slot: 0, tabIndex: 0 },
      ];
      expect(
        buildOrdinaryBankStagePlan(
          makeStageInstance({
            coinBalance: recipe.cost * 5,
            questTarget: recipe.output,
          }),
          bank,
        ),
      ).toEqual({
        activity: "tanning",
        recipeId: recipe.output,
        actionCount: 5,
        items: [{ itemId: recipe.input, quantity: 5 }],
      });
      expect(
        buildOrdinaryBankStagePlan(
          makeStageInstance({
            coinBalance: Math.max(0, recipe.cost - 1),
            questTarget: recipe.output,
          }),
          bank,
        ),
      ).toBeNull();
      expect(
        buildOrdinaryBankStagePlan(
          makeStageInstance({
            coinBalance: recipe.cost * 3,
            questTarget: recipe.output,
          }),
          bank,
        ),
      ).toEqual({
        activity: "tanning",
        recipeId: recipe.output,
        actionCount: 3,
        items: [{ itemId: recipe.input, quantity: 3 }],
      });
    }

    const runecraftingRecipes = runecrafting.recipes as Array<{
      runeType: string;
      runeItemId: string;
      essenceTypes: string[];
      levelRequired: number;
    }>;
    expect(runecraftingRecipes).toHaveLength(6);
    for (const recipe of runecraftingRecipes) {
      const essence = [...recipe.essenceTypes].sort((left, right) =>
        left.localeCompare(right),
      );
      const bank = essence.map((itemId, slot) => ({
        itemId,
        quantity: slot === 0 ? 3 : 2,
        slot,
        tabIndex: 0,
      }));
      if (bank.length === 1) bank[0].quantity = 5;
      expect(
        buildOrdinaryBankStagePlan(
          makeStageInstance({
            runecraftingLevel: recipe.levelRequired,
            questTarget: recipe.runeItemId,
          }),
          bank,
        ),
      ).toEqual({
        activity: "runecrafting",
        recipeId: recipe.runeType,
        actionCount: 1,
        items: bank.map(({ itemId, quantity }) => ({ itemId, quantity })),
      });
    }
  });

  it("keeps source-derived tools, quest inputs, and one health bar while banking unrelated surplus", () => {
    const retained = buildOrdinaryBankRetentionManifest(
      makeInstance({ maxHealth: 20 }),
    );

    expect(retained).toEqual([
      { itemId: "ordinary_hatchet", quantity: 1 },
      { itemId: "ordinary_lobster", quantity: 2 },
      { itemId: "ordinary_logs", quantity: 5 },
    ]);
  });

  it("keeps authored artifacts from earlier stages until the active quest completes", () => {
    const quest: AgentQuestInfo = {
      questId: "ordinary-forging-path",
      name: "Ordinary forging path",
      description: "Gather two ores and forge a weapon",
      difficulty: "novice",
      status: "in_progress",
      canStart: false,
      requirements: { quests: [], skills: {}, items: ["ordinary_needle"] },
      startNpc: "ordinary-smith",
      onStartItems: [{ itemId: "hammer", quantity: 1 }],
      rewardItems: [],
      stages: [
        {
          id: "mine-a",
          type: "gather",
          description: "Mine ore A",
          target: "ordinary_ore_a",
          count: 4,
        },
        {
          id: "mine-b",
          type: "gather",
          description: "Mine ore B",
          target: "ordinary_ore_b",
          count: 4,
        },
        {
          id: "smelt",
          type: "interact",
          description: "Smelt bars",
          target: "ordinary_bar",
          count: 4,
        },
        {
          id: "smith",
          type: "interact",
          description: "Forge a sword",
          target: "ordinary_sword",
          count: 1,
        },
      ],
    };
    const retained = buildOrdinaryBankRetentionManifest(
      makeInstance({
        maxHealth: 0,
        inventory: [
          { slot: 0, itemId: "ordinary_ore_a", quantity: 4 },
          { slot: 1, itemId: "ordinary_ore_b", quantity: 1 },
          { slot: 2, itemId: "ordinary_bar", quantity: 2 },
          { slot: 3, itemId: "ordinary_sword", quantity: 2 },
          { slot: 4, itemId: "ordinary_needle", quantity: 1 },
          { slot: 5, itemId: "hammer", quantity: 1 },
          { slot: 6, itemId: "ordinary_craft_material", quantity: 5 },
        ],
        questState: [
          {
            questId: quest.questId,
            status: "in_progress",
            stageTarget: "ordinary_ore_b",
            stageCount: 4,
          },
        ],
        availableQuests: [quest],
      }),
    );

    expect(retained).toEqual([
      { itemId: "hammer", quantity: 1 },
      { itemId: "ordinary_bar", quantity: 2 },
      { itemId: "ordinary_needle", quantity: 1 },
      { itemId: "ordinary_ore_a", quantity: 4 },
      { itemId: "ordinary_ore_b", quantity: 1 },
      { itemId: "ordinary_sword", quantity: 1 },
    ]);
  });

  it("treats invalid health input as no food reserve instead of emitting an invalid manifest", () => {
    expect(
      buildOrdinaryBankRetentionManifest(makeInstance({ maxHealth: NaN })),
    ).toEqual([
      { itemId: "ordinary_hatchet", quantity: 1 },
      { itemId: "ordinary_logs", quantity: 5 },
    ]);
  });

  it("retains only combat supplies usable by the currently equipped style", () => {
    expect(
      buildOrdinaryBankRetentionManifest(
        makeInstance({ weaponId: "ordinary_staff" }),
      ),
    ).toContainEqual({ itemId: "ordinary_air_rune", quantity: 50 });
    expect(
      buildOrdinaryBankRetentionManifest(
        makeInstance({ weaponId: "ordinary_staff" }),
      ),
    ).not.toContainEqual({ itemId: "ordinary_arrow", quantity: 40 });

    expect(
      buildOrdinaryBankRetentionManifest(
        makeInstance({ weaponId: "ordinary_bow" }),
      ),
    ).toContainEqual({ itemId: "ordinary_arrow", quantity: 40 });
  });

  it("retains an incomplete specialist kit and one melee recovery weapon", () => {
    const mage = buildOrdinaryBankRetentionManifest(
      makeInstance({
        weaponId: "ordinary_sword",
        combatSpecialization: "mage",
      }),
    );
    expect(mage).toContainEqual({ itemId: "ordinary_staff", quantity: 1 });
    expect(mage).toContainEqual({ itemId: "ordinary_air_rune", quantity: 50 });
    expect(mage).toContainEqual({ itemId: "ordinary_sword", quantity: 1 });
    expect(mage).not.toContainEqual({ itemId: "ordinary_arrow", quantity: 40 });

    const ranged = buildOrdinaryBankRetentionManifest(
      makeInstance({
        weaponId: "ordinary_sword",
        combatSpecialization: "ranged",
      }),
    );
    expect(ranged).toContainEqual({ itemId: "ordinary_bow", quantity: 1 });
    expect(ranged).toContainEqual({ itemId: "ordinary_arrow", quantity: 40 });
    expect(ranged).toContainEqual({ itemId: "ordinary_sword", quantity: 1 });
    expect(ranged).not.toContainEqual({
      itemId: "ordinary_air_rune",
      quantity: 50,
    });
  });

  it("retains only the carried quantities consumed by an active exact combat-supply lineage", () => {
    const catalog: OrdinaryCombatReadinessCatalog = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "ordinary_bow",
          ammunitionId: "ordinary_arrow",
          weaponScore: 8,
          ammunitionScore: 7,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const recipes: OrdinaryCombatSupplyRecipe[] = [
      {
        activity: "smelting",
        stableId: "ordinary_bar",
        outputItemId: "ordinary_bar",
        outputQuantity: 1,
        levelRequired: 1,
        inputAlternatives: [
          [
            { itemId: "ordinary_ore_a", quantity: 1 },
            { itemId: "ordinary_ore_b", quantity: 1 },
          ],
        ],
        tools: [],
      },
      {
        activity: "fletching",
        stableId: "ordinary_arrow",
        outputItemId: "ordinary_arrow",
        outputQuantity: 10,
        levelRequired: 1,
        inputAlternatives: [
          [
            { itemId: "ordinary_bar", quantity: 1 },
            { itemId: "ordinary_logs", quantity: 1 },
          ],
        ],
        tools: ["hammer"],
      },
    ];
    const instance = makeStageInstance({
      combatSpecialization: "ranged",
      rangedLevel: 1,
      goal: {
        type: "banking",
        description: "Make room for exact combat supply",
        bankPurpose: "combat_supply",
      },
      equipment: { weapon: { itemId: "ordinary_bow" } },
      inventory: [
        { slot: 0, itemId: "ordinary_arrow", quantity: 10 },
        { slot: 1, itemId: "ordinary_bar", quantity: 2 },
        { slot: 2, itemId: "ordinary_logs", quantity: 9 },
        { slot: 3, itemId: "ordinary_ore_a", quantity: 9 },
        { slot: 4, itemId: "ordinary_ore_b", quantity: 9 },
        { slot: 5, itemId: "hammer", quantity: 2 },
        { slot: 6, itemId: "ordinary_craft_material", quantity: 7 },
      ],
    });

    expect(
      buildOrdinaryBankRetentionManifest(instance, {
        now: 1_000,
        combatReadinessCatalog: catalog,
        combatSupplyRecipes: recipes,
      }),
    ).toEqual([
      { itemId: "hammer", quantity: 1 },
      { itemId: "ordinary_arrow", quantity: 10 },
      { itemId: "ordinary_bar", quantity: 2 },
      { itemId: "ordinary_logs", quantity: 4 },
      { itemId: "ordinary_ore_a", quantity: 2 },
      { itemId: "ordinary_ore_b", quantity: 2 },
    ]);
  });

  it("retains exact carried inputs for a level-locked combat-supply training detour", () => {
    const catalog: OrdinaryCombatReadinessCatalog = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "ordinary_bow",
          ammunitionId: "ordinary_arrow",
          weaponScore: 8,
          ammunitionScore: 7,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const recipes: OrdinaryCombatSupplyRecipe[] = [
      {
        activity: "fletching",
        stableId: "training_bar",
        outputItemId: "ordinary_bar",
        outputQuantity: 1,
        levelRequired: 1,
        inputAlternatives: [[{ itemId: "ordinary_ore_a", quantity: 1 }]],
        tools: ["ordinary_pickaxe"],
      },
      {
        activity: "fletching",
        stableId: "locked_arrow",
        outputItemId: "ordinary_arrow",
        outputQuantity: 10,
        levelRequired: 20,
        inputAlternatives: [
          [{ itemId: "ordinary_craft_material", quantity: 1 }],
        ],
        tools: [],
      },
    ];
    const instance = makeStageInstance({
      combatSpecialization: "ranged",
      rangedLevel: 1,
      fletchingLevel: 1,
      goal: {
        type: "banking",
        description: "Retain exact locked-skill training inputs",
        bankPurpose: "combat_supply",
      },
      equipment: { weapon: { itemId: "ordinary_bow" } },
      inventory: [
        { slot: 0, itemId: "ordinary_ore_a", quantity: 4 },
        { slot: 1, itemId: "ordinary_pickaxe", quantity: 1 },
        { slot: 2, itemId: "ordinary_craft_material", quantity: 6 },
      ],
    });

    expect(
      buildOrdinaryBankRetentionManifest(instance, {
        combatReadinessCatalog: catalog,
        combatSupplyRecipes: recipes,
        combatSupplyPublicSourceItemIds: [],
      }),
    ).toEqual([
      { itemId: "ordinary_ore_a", quantity: 1 },
      { itemId: "ordinary_pickaxe", quantity: 1 },
    ]);
  });

  it("retains an exact combat lineage during bounded public acquisition but releases it after expiry", () => {
    const catalog: OrdinaryCombatReadinessCatalog = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "ordinary_bow",
          ammunitionId: "ordinary_arrow",
          weaponScore: 8,
          ammunitionScore: 7,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const recipes: OrdinaryCombatSupplyRecipe[] = [
      {
        activity: "fletching",
        stableId: "ordinary_arrow",
        outputItemId: "ordinary_arrow",
        outputQuantity: 10,
        levelRequired: 1,
        inputAlternatives: [
          [
            { itemId: "ordinary_bar", quantity: 1 },
            { itemId: "ordinary_logs", quantity: 1 },
          ],
        ],
        tools: ["hammer"],
      },
    ];
    const instance = makeStageInstance({
      combatSpecialization: "ranged",
      rangedLevel: 1,
      goal: {
        type: "provisioning",
        description: "Building exact combat supply",
      },
      equipment: { weapon: { itemId: "ordinary_bow" } },
      inventory: [
        { slot: 0, itemId: "ordinary_bar", quantity: 8 },
        { slot: 1, itemId: "ordinary_logs", quantity: 8 },
        { slot: 2, itemId: "hammer", quantity: 1 },
      ],
    });
    instance.ordinaryProcessingAcquisition = { expiresAt: 2_000 };
    const options = {
      combatReadinessCatalog: catalog,
      combatSupplyRecipes: recipes,
    };

    const active = buildOrdinaryBankRetentionManifest(instance, {
      ...options,
      now: 1_999,
    });
    expect(active).toContainEqual({ itemId: "ordinary_bar", quantity: 5 });
    expect(active).toContainEqual({ itemId: "ordinary_logs", quantity: 5 });

    const expired = buildOrdinaryBankRetentionManifest(instance, {
      ...options,
      now: 2_000,
    });
    expect(expired).not.toContainEqual({ itemId: "ordinary_bar", quantity: 5 });
    expect(expired).not.toContainEqual({
      itemId: "ordinary_logs",
      quantity: 5,
    });
    expect(expired).toEqual([{ itemId: "hammer", quantity: 1 }]);
  });

  it("derives one stable, namespace-separated custody key from the immutable attempt", () => {
    const attemptId = "f9d799a6-798a-4e87-a7f1-05c8a3556655";
    expect(getOrdinaryBankOperationId(attemptId)).toBe(
      getOrdinaryBankOperationId(attemptId),
    );
    expect(getOrdinaryBankOperationId(attemptId)).not.toBe(attemptId);
    expect(getOrdinaryBankOperationId(attemptId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(getOrdinaryBankStageOperationId(attemptId)).toBe(
      getOrdinaryBankStageOperationId(attemptId),
    );
    expect(getOrdinaryBankStageOperationId(attemptId)).not.toBe(
      getOrdinaryBankOperationId(attemptId),
    );
  });

  it("privately stages an exact authored cooking batch and prioritizes an active quest", () => {
    const instance = makeStageInstance({
      cookingLevel: 30,
      questTarget: "ordinary_cooked_low",
    });
    expect(
      buildOrdinaryBankStagePlan(instance, [
        {
          itemId: "ordinary_raw_high",
          quantity: 20,
          slot: 0,
          tabIndex: 0,
        },
        {
          itemId: "ordinary_raw_low",
          quantity: 5,
          slot: 1,
          tabIndex: 0,
        },
      ]),
    ).toEqual({
      activity: "cooking",
      itemId: "ordinary_raw_low",
      quantity: 5,
    });
  });

  it("rejects level-blocked, incomplete, and inventory-overflowing bank batches", () => {
    const bank = [
      {
        itemId: "ordinary_raw_high",
        quantity: 5,
        slot: 0,
        tabIndex: 0,
      },
    ];
    expect(
      buildOrdinaryBankStagePlan(makeStageInstance({ cookingLevel: 1 }), bank),
    ).toBeNull();
    expect(
      buildOrdinaryBankStagePlan(makeStageInstance({ cookingLevel: 30 }), [
        { ...bank[0], quantity: 4 },
      ]),
    ).toBeNull();
    expect(
      buildOrdinaryBankStagePlan(
        makeStageInstance({
          cookingLevel: 30,
          inventory: Array.from({ length: 24 }, (_, slot) => ({
            slot,
            itemId: "ordinary_logs",
            quantity: 1,
          })),
        }),
        bank,
      ),
    ).toBeNull();
  });

  it("replays one exact private withdrawal until an ambiguous commit is definitive", async () => {
    const executeBankOpen = vi.fn(async () => ({
      success: true,
      bankItems: [
        {
          itemId: "ordinary_raw_high",
          quantity: 12,
          slot: 0,
          tabIndex: 0,
        },
      ],
    }));
    const executeBankWithdraw = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        commitState: "unknown",
        failureReason: "commit_ambiguous",
      })
      .mockResolvedValueOnce({
        success: true,
        commitState: "committed",
        replayed: true,
      });
    const attemptId = "d6cbb5a8-0c87-47ad-9a28-b6f52bdf1088";
    const result = await executeOrdinaryBankStageMaterials(
      makeStageInstance({ executeBankOpen, executeBankWithdraw }),
      "bank-1",
      { attemptId } as never,
    );

    expect(result).toMatchObject({
      settled: true,
      applied: true,
      reason: "completed",
      reconciliationAttempts: 2,
      plan: {
        activity: "cooking",
        itemId: "ordinary_raw_high",
        quantity: 5,
      },
    });
    expect(executeBankOpen).toHaveBeenCalledOnce();
    expect(executeBankWithdraw).toHaveBeenCalledTimes(2);
    expect(executeBankWithdraw.mock.calls[0]).toEqual(
      executeBankWithdraw.mock.calls[1],
    );
    expect(executeBankWithdraw.mock.calls[0]).toEqual([
      "ordinary_raw_high",
      5,
      getOrdinaryBankStageOperationId(attemptId),
    ]);
  });

  it("replays one exact composite plan without exposing a partial withdrawal path", async () => {
    const provider = ProcessingDataProvider.getInstance();
    provider.loadSmeltingRecipes({
      recipes: [
        {
          output: "ordinary_bar",
          inputs: [
            { item: "ordinary_ore_a", amount: 1 },
            { item: "ordinary_ore_b", amount: 2 },
          ],
          level: 1,
          xp: 1,
          ticks: 1,
          successRate: 1,
        },
      ],
    });
    provider.loadCraftingRecipes({ recipes: [] });
    provider.loadFletchingRecipes({ recipes: [] });
    provider.rebuild();
    const executeBankOpen = vi.fn(async () => ({
      success: true,
      bankItems: [
        { itemId: "ordinary_ore_b", quantity: 10, slot: 0, tabIndex: 0 },
        { itemId: "ordinary_ore_a", quantity: 5, slot: 1, tabIndex: 0 },
      ],
    }));
    const executeBankWithdraw = vi.fn();
    const executeBankWithdrawPlan = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        commitState: "unknown",
        failureReason: "commit_ambiguous",
      })
      .mockResolvedValueOnce({
        success: true,
        commitState: "committed",
        replayed: true,
      });
    const attemptId = "26e536ce-0fbd-4a3a-974a-00a93cb717f9";
    const result = await executeOrdinaryBankStageMaterials(
      makeStageInstance({
        smithingLevel: 1,
        questTarget: "ordinary_bar",
        executeBankOpen,
        executeBankWithdraw,
        executeBankWithdrawPlan,
      }),
      "bank-1",
      { attemptId } as never,
    );
    const expectedItems = [
      { itemId: "ordinary_ore_a", quantity: 5 },
      { itemId: "ordinary_ore_b", quantity: 10 },
    ];

    expect(result).toMatchObject({
      settled: true,
      applied: true,
      reason: "completed",
      reconciliationAttempts: 2,
      plan: {
        activity: "smelting",
        recipeId: "ordinary_bar",
        actionCount: 5,
        items: expectedItems,
      },
    });
    expect(executeBankWithdraw).not.toHaveBeenCalled();
    expect(executeBankWithdrawPlan).toHaveBeenCalledTimes(2);
    expect(executeBankWithdrawPlan.mock.calls[0]).toEqual(
      executeBankWithdrawPlan.mock.calls[1],
    );
    expect(executeBankWithdrawPlan.mock.calls[0]).toEqual([
      expectedItems,
      getOrdinaryBankStageOperationId(attemptId),
    ]);
  });

  it("withdraws missing Smithing bars and hammer as one atomic composite", async () => {
    const provider = ProcessingDataProvider.getInstance();
    provider.loadSmeltingRecipes({ recipes: [] });
    provider.loadSmithingRecipes({
      recipes: [
        {
          output: "ordinary_sword",
          bar: "ordinary_bar",
          barsRequired: 1,
          level: 1,
          xp: 1,
          ticks: 1,
          category: "sword",
        },
      ],
    });
    provider.loadCraftingRecipes({ recipes: [] });
    provider.loadFletchingRecipes({ recipes: [] });
    provider.rebuild();
    const executeBankOpen = vi.fn(async () => ({
      success: true,
      bankItems: [
        { itemId: "ordinary_bar", quantity: 5, slot: 0, tabIndex: 0 },
        { itemId: "hammer", quantity: 1, slot: 1, tabIndex: 0 },
      ],
    }));
    const executeBankWithdraw = vi.fn();
    const executeBankWithdrawPlan = vi.fn(async () => ({
      success: true,
      commitState: "committed",
    }));
    const attemptId = "12c77ba8-df3f-491f-aed4-b554309dad50";
    const result = await executeOrdinaryBankStageMaterials(
      makeStageInstance({
        smithingLevel: 1,
        questTarget: "ordinary_sword",
        executeBankOpen,
        executeBankWithdraw,
        executeBankWithdrawPlan,
      }),
      "bank-1",
      { attemptId } as never,
    );
    const expectedItems = [
      { itemId: "hammer", quantity: 1 },
      { itemId: "ordinary_bar", quantity: 5 },
    ].sort((left, right) => left.itemId.localeCompare(right.itemId));

    expect(result).toMatchObject({
      settled: true,
      applied: true,
      reason: "completed",
      reconciliationAttempts: 1,
      plan: {
        activity: "smithing",
        recipeId: "ordinary_sword",
        actionCount: 5,
        items: expectedItems,
      },
    });
    expect(executeBankWithdraw).not.toHaveBeenCalled();
    expect(executeBankWithdrawPlan).toHaveBeenCalledWith(
      expectedItems,
      getOrdinaryBankStageOperationId(attemptId),
    );
  });

  it("replays the exact operation and retention manifest until ambiguous custody becomes definitive", async () => {
    const executeBankDepositAll = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        commitState: "unknown",
        failureReason: "commit_ambiguous",
      })
      .mockResolvedValueOnce({
        success: true,
        commitState: "committed",
        replayed: true,
      });
    const instance = makeInstance({ executeBankDepositAll });
    const attempt = {
      attemptId: "2fe12853-d88c-478d-af03-d14be33b92a1",
    } as never;

    const result = await executeOrdinaryBankDepositSurplus(
      instance,
      "bank-1",
      attempt,
    );

    expect(result).toMatchObject({
      settled: true,
      applied: true,
      reconciliationAttempts: 2,
    });
    expect(executeBankDepositAll).toHaveBeenCalledTimes(2);
    expect(executeBankDepositAll.mock.calls[0]).toEqual(
      executeBankDepositAll.mock.calls[1],
    );
    expect(executeBankDepositAll.mock.calls[0]?.[0]).toBe(
      getOrdinaryBankOperationId("2fe12853-d88c-478d-af03-d14be33b92a1"),
    );
    expect(executeBankDepositAll.mock.calls[0]?.[2]).toBe("bank-1");
  });

  it("holds the action open until a committed receipt is reflected in live inventory", async () => {
    const executeBankDepositAll = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        commitState: "committed",
        failureReason: "post_commit_sync_failed",
      })
      .mockResolvedValueOnce({
        success: true,
        commitState: "committed",
        replayed: true,
      });
    const instance = makeInstance({ executeBankDepositAll });

    const result = await executeOrdinaryBankDepositSurplus(instance, "bank-1", {
      attemptId: "a22e9a55-7b9d-47cd-953c-b96e0ca852e6",
    } as never);

    expect(result).toMatchObject({
      settled: true,
      applied: true,
      reconciliationAttempts: 2,
    });
    expect(executeBankDepositAll).toHaveBeenCalledTimes(2);
    expect(executeBankDepositAll.mock.calls[0]).toEqual(
      executeBankDepositAll.mock.calls[1],
    );
  });

  it("does not retry a definitive rejection under a new identity", async () => {
    const executeBankDepositAll = vi.fn(async () => ({
      success: false,
      commitState: "not_committed",
      failureReason: "bank_out_of_range",
    }));
    const result = await executeOrdinaryBankDepositSurplus(
      makeInstance({ executeBankDepositAll }),
      "bank-1",
      {
        attemptId: "35257e8d-eec5-4561-8658-b9a9fef401ee",
      } as never,
    );

    expect(result).toMatchObject({
      settled: true,
      applied: false,
      reconciliationAttempts: 1,
    });
    expect(executeBankDepositAll).toHaveBeenCalledOnce();
  });
});
