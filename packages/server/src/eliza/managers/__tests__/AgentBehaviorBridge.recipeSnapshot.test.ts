import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ammunitionService,
  COMBAT_SPELLS,
  ELEMENTAL_STAVES,
  ITEMS,
  ProcessingDataProvider,
} from "@hyperforge/shared";
import {
  ORDINARY_COMBAT_AMMUNITION_TARGET,
  ORDINARY_COMBAT_MAGIC_CAST_TARGET,
} from "../../ordinaryCombatSpecialization";
import {
  buildOrdinaryBankRetentionManifest,
  buildOrdinaryBankStagePlan,
  buildOrdinaryCombatSupplyGatheringCatalog,
  buildOrdinaryCombatSupplyPublicSourceCatalog,
  buildOrdinaryCombatSupplyRecipeCatalog,
} from "../../ordinaryAgentBanking";
import type { AgentInstance } from "../AgentBehaviorTicker";
import {
  initializeItems,
  processAgentTicks,
} from "../../worker/AgentBehaviorEngine";
import type { AgentTickInput } from "../../worker/workerTypes";

import {
  buildWorkerItemDataSnapshot,
  buildWorkerProcessingRecipeSnapshot,
} from "../AgentBehaviorBridge";

describe("AgentBehaviorBridge production recipe snapshot", () => {
  const previousItems = new Map<string, unknown>();
  let previousExternalResources: unknown;

  beforeAll(async () => {
    const [
      cooking,
      firemaking,
      smelting,
      smithing,
      crafting,
      tanning,
      fletching,
      runecrafting,
    ] = await Promise.all(
      [
        "cooking",
        "firemaking",
        "smelting",
        "smithing",
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
    );
    const itemIds = new Set<string>();
    for (const recipe of cooking.recipes) itemIds.add(recipe.raw);
    for (const recipe of firemaking.recipes) itemIds.add(recipe.log);
    for (const recipe of smelting.recipes) {
      itemIds.add(recipe.output);
      for (const input of recipe.inputs) itemIds.add(input.item);
    }
    for (const recipe of smithing.recipes) {
      itemIds.add(recipe.output);
      itemIds.add(recipe.bar);
    }
    itemIds.add("hammer");
    for (const recipe of crafting.recipes) {
      itemIds.add(recipe.output);
      for (const input of recipe.inputs) itemIds.add(input.item);
      for (const tool of recipe.tools) itemIds.add(tool);
      for (const consumable of recipe.consumables) {
        itemIds.add(consumable.item);
      }
    }
    for (const recipe of tanning.recipes) {
      itemIds.add(recipe.input);
      itemIds.add(recipe.output);
    }
    for (const recipe of fletching.recipes) {
      itemIds.add(recipe.output);
      for (const input of recipe.inputs) itemIds.add(input.item);
      for (const tool of recipe.tools) itemIds.add(tool);
    }
    for (const recipe of runecrafting.recipes) {
      itemIds.add(recipe.runeItemId);
      for (const essence of recipe.essenceTypes) itemIds.add(essence);
    }
    for (const itemId of itemIds) {
      previousItems.set(itemId, ITEMS.get(itemId));
      if (!ITEMS.has(itemId)) {
        ITEMS.set(itemId, {
          id: itemId,
          name: itemId,
          type: "resource",
        } as never);
      }
    }
    const itemManifests = await Promise.all(
      [
        "ammunition",
        "armor",
        "food",
        "misc",
        "resources",
        "runes",
        "tools",
        "weapons",
      ].map(async (name) =>
        JSON.parse(
          await readFile(
            new URL(
              `../../../../world/assets/manifests/items/${name}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    );
    for (const item of itemManifests.flat() as Array<{
      id: string;
      [key: string]: unknown;
    }>) {
      if (!previousItems.has(item.id)) {
        previousItems.set(item.id, ITEMS.get(item.id));
      }
      ITEMS.set(item.id, item as never);
    }

    const [woodcutting, mining, fishing] = await Promise.all(
      ["woodcutting", "mining", "fishing"].map(async (name) =>
        JSON.parse(
          await readFile(
            new URL(
              `../../../../world/assets/manifests/gathering/${name}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    );
    const resources = [...woodcutting.trees, ...mining.rocks, ...fishing.spots];
    const globals = globalThis as {
      EXTERNAL_RESOURCES?: Map<string, (typeof resources)[number]>;
    };
    previousExternalResources = globals.EXTERNAL_RESOURCES;
    globals.EXTERNAL_RESOURCES = new Map(
      resources.map((resource) => [resource.id, resource]),
    );

    const provider = ProcessingDataProvider.getInstance();
    provider.loadCookingRecipes(cooking);
    provider.loadFiremakingRecipes(firemaking);
    provider.loadSmeltingRecipes(smelting);
    provider.loadSmithingRecipes(smithing);
    provider.loadCraftingRecipes(crafting);
    provider.loadTanningRecipes(tanning);
    provider.loadFletchingRecipes(fletching);
    provider.loadRunecraftingRecipes(runecrafting);
    provider.rebuild();
  });

  afterAll(() => {
    for (const [itemId, item] of previousItems) {
      if (item) ITEMS.set(itemId, item as never);
      else ITEMS.delete(itemId);
    }
    const globals = globalThis as { EXTERNAL_RESOURCES?: unknown };
    if (previousExternalResources !== undefined) {
      globals.EXTERNAL_RESOURCES = previousExternalResources;
    } else {
      delete globals.EXTERNAL_RESOURCES;
    }
  });

  it("preserves every loaded cooking, smelting, and Smithing recipe exactly", () => {
    const provider = ProcessingDataProvider.getInstance();
    const snapshot = new Map(buildWorkerItemDataSnapshot());

    expect(provider.getCookableItemIds().size).toBeGreaterThan(0);
    for (const rawItemId of provider.getCookableItemIds()) {
      const recipe = provider.getCookingData(rawItemId);
      expect(snapshot.get(rawItemId)?.cooking).toEqual({
        cookedItemId: recipe?.cookedItemId,
        levelRequired: recipe?.levelRequired,
      });
    }

    expect(provider.getSmeltableBarIds().size).toBeGreaterThan(0);
    for (const barItemId of provider.getSmeltableBarIds()) {
      const recipe = provider.getSmeltingData(barItemId);
      expect(recipe?.inputs).toBeDefined();
      expect(snapshot.get(barItemId)?.smelting).toEqual({
        inputs: recipe?.inputs,
        levelRequired: recipe?.levelRequired,
      });
    }

    const smithingRecipes = provider.getAllSmithingRecipes();
    expect(smithingRecipes.length).toBeGreaterThan(0);
    for (const recipe of smithingRecipes) {
      expect(snapshot.get(recipe.itemId)?.smithing).toEqual({
        barItemId: recipe.barType,
        barsRequired: recipe.barsRequired,
        levelRequired: recipe.levelRequired,
        outputQuantity: recipe.outputQuantity,
      });
    }

    expect(() => structuredClone([...snapshot])).not.toThrow();
  });

  it("preserves every non-item-keyed processing recipe exactly", () => {
    const provider = ProcessingDataProvider.getInstance();
    const snapshot = buildWorkerProcessingRecipeSnapshot();

    expect(snapshot.firemaking).toHaveLength(provider.getBurnableLogIds().size);
    expect(snapshot.firemaking.length).toBeGreaterThan(0);
    expect(snapshot.crafting).toHaveLength(
      provider.getAllCraftingRecipes().length,
    );
    expect(snapshot.crafting.length).toBeGreaterThan(0);
    expect(snapshot.tanning).toHaveLength(
      provider.getAllTanningRecipes().length,
    );
    expect(snapshot.tanning.length).toBeGreaterThan(0);
    expect(snapshot.fletching).toHaveLength(
      provider.getAllFletchingRecipes().length,
    );
    expect(snapshot.fletching.length).toBeGreaterThan(0);
    expect(snapshot.runecrafting).toHaveLength(
      provider.getAllRunecraftingRecipes().length,
    );
    expect(snapshot.runecrafting.length).toBeGreaterThan(0);

    for (const recipe of provider.getAllFletchingRecipes()) {
      expect(
        snapshot.fletching.find(
          (candidate) => candidate.recipeId === recipe.recipeId,
        ),
      ).toEqual({
        recipeId: recipe.recipeId,
        outputItemId: recipe.output,
        outputQuantity: recipe.outputQuantity,
        category: recipe.category,
        inputs: recipe.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount,
        })),
        tools: recipe.tools,
        levelRequired: recipe.level,
      });
    }
    for (const recipe of provider.getAllRunecraftingRecipes()) {
      expect(
        snapshot.runecrafting.find(
          (candidate) => candidate.runeType === recipe.runeType,
        ),
      ).toEqual({
        runeType: recipe.runeType,
        runeItemId: recipe.runeItemId,
        essenceItemIds: recipe.essenceTypes,
        levelRequired: recipe.levelRequired,
      });
    }
    expect(() => structuredClone(snapshot)).not.toThrow();
  });

  it("keeps the private combat-precursor graph identical to the public worker graph", async () => {
    const workerItems = buildWorkerItemDataSnapshot();
    const workerRecipes = buildWorkerProcessingRecipeSnapshot();
    const expected = [
      ...workerItems.flatMap(([itemId, item]) =>
        item.smelting
          ? [
              {
                activity: "smelting" as const,
                stableId: itemId,
                outputItemId: itemId,
                outputQuantity: 1,
                levelRequired: item.smelting.levelRequired,
                inputAlternatives: [item.smelting.inputs],
                tools: [],
              },
            ]
          : [],
      ),
      ...workerItems.flatMap(([itemId, item]) =>
        item.smithing
          ? [
              {
                activity: "smithing" as const,
                stableId: itemId,
                outputItemId: itemId,
                outputQuantity: item.smithing.outputQuantity,
                levelRequired: item.smithing.levelRequired,
                inputAlternatives: [
                  [
                    {
                      itemId: item.smithing.barItemId,
                      quantity: item.smithing.barsRequired,
                    },
                  ],
                ],
                tools: ["hammer"],
              },
            ]
          : [],
      ),
      ...workerRecipes.fletching.map((recipe) => ({
        activity: "fletching" as const,
        stableId: recipe.recipeId,
        outputItemId: recipe.outputItemId,
        outputQuantity: recipe.outputQuantity,
        levelRequired: recipe.levelRequired,
        inputAlternatives: [recipe.inputs],
        tools: recipe.tools,
      })),
      ...workerRecipes.runecrafting.map((recipe) => ({
        activity: "runecrafting" as const,
        stableId: recipe.runeType,
        outputItemId: recipe.runeItemId,
        outputQuantity: 1,
        levelRequired: recipe.levelRequired,
        inputAlternatives: recipe.essenceItemIds.map((itemId) => [
          { itemId, quantity: 1 },
        ]),
        tools: [],
      })),
    ].sort(
      (left, right) =>
        left.levelRequired - right.levelRequired ||
        left.activity.localeCompare(right.activity) ||
        left.stableId.localeCompare(right.stableId),
    );

    expect(buildOrdinaryCombatSupplyRecipeCatalog()).toEqual(expected);
    expect(workerRecipes.gathering.length).toBeGreaterThan(0);
    expect(buildOrdinaryCombatSupplyGatheringCatalog()).toEqual(
      workerRecipes.gathering,
    );

    const [authoredStores, allNpcs] = await Promise.all(
      ["stores", "npcs"].map(async (name) =>
        JSON.parse(
          await readFile(
            new URL(
              `../../../../world/assets/manifests/${name}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    );
    const combatNpcs = allNpcs.filter((npc: { category: string }) =>
      ["mob", "boss", "quest"].includes(npc.category),
    );
    const publicSnapshot = buildWorkerProcessingRecipeSnapshot(
      combatNpcs,
      authoredStores,
    );
    const expectedPublicSourceItemIds = [
      ...new Set([
        ...publicSnapshot.stores.flatMap((store) =>
          store.items.map((item) => item.itemId),
        ),
        ...(publicSnapshot.guaranteedMobDrops ?? []).flatMap(
          (source) => source.itemIds,
        ),
      ]),
    ].sort((left, right) => left.localeCompare(right));
    expect(
      buildOrdinaryCombatSupplyPublicSourceCatalog(authoredStores, combatNpcs),
    ).toEqual(expectedPublicSourceItemIds);
  });

  it("stages the exact production bronze-arrow lineage before public gathering", () => {
    const instance = {
      state: "running",
      goal: {
        type: "banking",
        description: "Check exact combat supplies",
        bankPurpose: "combat_supply",
      },
      config: {
        characterId: "production-ranged-agent",
        accountId: "production-ranged-account",
        name: "Production ranged agent",
        combatSpecialization: "ranged",
      },
      service: {
        getGameState: () => ({
          inCombat: false,
          maxHealth: 20,
          skills: {
            attack: { level: 1, xp: 0 },
            ranged: { level: 1, xp: 0 },
            magic: { level: 1, xp: 0 },
            cooking: { level: 1, xp: 0 },
            smithing: { level: 5, xp: 0 },
            crafting: { level: 1, xp: 0 },
            fletching: { level: 5, xp: 0 },
            firemaking: { level: 1, xp: 0 },
            runecrafting: { level: 1, xp: 0 },
          },
          inventory: [],
          equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        }),
        getQuestState: () => [],
        getAvailableQuests: () => [],
        getWorld: () => ({ getSystem: () => ({}) }),
        getPrivateCoinBalance: () => 0,
      },
    } as unknown as AgentInstance;
    const bankItem = (itemId: string, quantity: number, slot: number) => ({
      itemId,
      quantity,
      slot,
      tabIndex: 0,
    });
    const readiness = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "shortbow",
          ammunitionId: "bronze_arrow",
          weaponScore: 1,
          ammunitionScore: 1,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };

    expect(
      buildOrdinaryBankStagePlan(
        instance,
        [
          bankItem("bronze_arrowtips", 15, 0),
          bankItem("bronze_bar", 3, 1),
          bankItem("headless_arrow", 15, 2),
          bankItem("arrow_shaft", 15, 3),
          bankItem("feathers", 45, 4),
          bankItem("logs", 2, 5),
          bankItem("knife", 1, 6),
          bankItem("hammer", 1, 7),
          bankItem("bronze_dagger", 1, 8),
        ],
        readiness,
      ),
    ).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "bronze_arrow",
      actionCount: 4,
      items: [
        { itemId: "arrow_shaft", quantity: 15 },
        { itemId: "bronze_arrowtips", quantity: 15 },
        { itemId: "bronze_bar", quantity: 3 },
        { itemId: "feathers", quantity: 45 },
        { itemId: "hammer", quantity: 1 },
        { itemId: "headless_arrow", quantity: 15 },
        { itemId: "knife", quantity: 1 },
        { itemId: "logs", quantity: 2 },
      ],
    });
  });

  it("stages owned production gathering tools before buying duplicates for the bronze-arrow lineage", () => {
    const instance = {
      state: "running",
      goal: {
        type: "banking",
        description: "Check exact combat supplies",
        bankPurpose: "combat_supply",
      },
      config: {
        characterId: "production-ranged-tool-agent",
        accountId: "production-ranged-tool-account",
        name: "Production ranged tool agent",
        combatSpecialization: "ranged",
      },
      service: {
        getGameState: () => ({
          inCombat: false,
          maxHealth: 20,
          skills: {
            attack: { level: 1, xp: 0 },
            ranged: { level: 1, xp: 0 },
            magic: { level: 1, xp: 0 },
            mining: { level: 1, xp: 0 },
            woodcutting: { level: 1, xp: 0 },
            smithing: { level: 5, xp: 0 },
            fletching: { level: 5, xp: 0 },
          },
          inventory: [],
          equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        }),
        getQuestState: () => [],
        getAvailableQuests: () => [],
        getWorld: () => ({ getSystem: () => ({}) }),
        getPrivateCoinBalance: () => 0,
      },
    } as unknown as AgentInstance;
    const readiness = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "shortbow",
          ammunitionId: "bronze_arrow",
          weaponScore: 1,
          ammunitionScore: 1,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };

    expect(
      buildOrdinaryBankStagePlan(
        instance,
        [
          {
            itemId: "bronze_hatchet",
            quantity: 1,
            slot: 0,
            tabIndex: 0,
          },
          {
            itemId: "bronze_pickaxe",
            quantity: 1,
            slot: 1,
            tabIndex: 0,
          },
          { itemId: "iron_ore", quantity: 5, slot: 2, tabIndex: 0 },
        ],
        readiness,
      ),
    ).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "bronze_arrow",
      actionCount: 4,
      items: [
        { itemId: "bronze_hatchet", quantity: 1 },
        { itemId: "bronze_pickaxe", quantity: 1 },
      ],
    });
  });

  it("hands bank-staged production tools into exact gathering and prerequisite training", async () => {
    const authoredStores = JSON.parse(
      await readFile(
        new URL(
          "../../../../world/assets/manifests/stores.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const recipes = buildWorkerProcessingRecipeSnapshot(
      undefined,
      authoredStores,
    );
    if (!recipes.combatReadiness) {
      throw new Error("Missing production combat readiness");
    }
    const readiness = recipes.combatReadiness;
    const bankInstance = {
      state: "running",
      goal: {
        type: "banking",
        description: "Check exact combat supplies",
        bankPurpose: "combat_supply",
      },
      config: {
        characterId: "production-ranged-handoff-agent",
        accountId: "production-ranged-handoff-account",
        name: "Production ranged handoff agent",
        combatSpecialization: "ranged",
      },
      service: {
        getGameState: () => ({
          inCombat: false,
          maxHealth: 20,
          skills: {
            attack: { level: 1, xp: 0 },
            ranged: { level: 1, xp: 0 },
            magic: { level: 1, xp: 0 },
            mining: { level: 1, xp: 0 },
            woodcutting: { level: 1, xp: 0 },
            smithing: { level: 5, xp: 0 },
            fletching: { level: 5, xp: 0 },
          },
          inventory: [],
          equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        }),
        getQuestState: () => [],
        getAvailableQuests: () => [],
        getWorld: () => ({ getSystem: () => ({}) }),
        getPrivateCoinBalance: () => 0,
      },
    } as unknown as AgentInstance;
    const stagePlan = buildOrdinaryBankStagePlan(
      bankInstance,
      [
        {
          itemId: "bronze_hatchet",
          quantity: 1,
          slot: 0,
          tabIndex: 0,
        },
        {
          itemId: "bronze_pickaxe",
          quantity: 1,
          slot: 1,
          tabIndex: 0,
        },
        { itemId: "knife", quantity: 1, slot: 2, tabIndex: 0 },
      ],
      readiness,
    );
    expect(stagePlan).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "iron_arrow",
      actionCount: 7,
      items: [
        { itemId: "bronze_hatchet", quantity: 1 },
        { itemId: "knife", quantity: 1 },
      ],
    });
    if (!stagePlan || !("items" in stagePlan)) return;

    initializeItems(buildWorkerItemDataSnapshot(), recipes);
    const food = { slot: 2, itemId: "lobster", quantity: 2 };
    const stagedItems = [
      ...stagePlan.items.map((item, slot) => ({ ...item, slot })),
      food,
    ];
    const makeWorkerInput = (
      inventoryItems: AgentTickInput["inventoryItems"],
      nearbyEntities: AgentTickInput["gameState"]["nearbyEntities"],
      stationPositions: AgentTickInput["stationPositions"] = [],
    ): AgentTickInput => ({
      characterId: "production-ranged-handoff-agent",
      combatSpecialization: "ranged",
      behaviorEpoch: 7,
      playerId: "production-ranged-handoff-player",
      name: "Production ranged handoff agent",
      gameState: {
        playerId: "production-ranged-handoff-player",
        position: [100, 0, 100],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 1, xp: 0 },
          ranged: { level: 1, xp: 0 },
          magic: { level: 1, xp: 0 },
          mining: { level: 1, xp: 0 },
          woodcutting: { level: 1, xp: 0 },
          smithing: { level: 5, xp: 0 },
          fletching: { level: 5, xp: 0 },
        },
        inventory: inventoryItems,
        equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        nearbyEntities,
        inCombat: false,
        currentTarget: null,
        selectedSpell: null,
        activePrayers: [],
      },
      inventoryItems,
      equippedItems: { weapon: "shortbow" },
      questState: [],
      availableQuests: [],
      storeRetryAfter: 0,
      coinRecoveryAuthorized: false,
      attackObservationRetryAfter: 0,
      bankStageRetryAfter: Date.now() + 300_000,
      questEntryAcquisitionQuestId: null,
      ordinaryProcessingAcquisitionAuthorized: true,
      survivalFoodAcquisitionAuthorized: false,
      ordinaryProcessingRetrySuppressions: [],
      agentState: {
        goal: {
          type: "banking",
          description: "Checked private combat custody",
          bankPurpose: "combat_supply",
        },
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
      stationPositions,
      storePositions: recipes.stores.map((store) => ({
        entityId: `production-${store.storeId}`,
        storeId: store.storeId,
        name: store.storeId,
        position: [100, 0, 100],
      })),
    });
    const nearby = [
      {
        id: "production-copper",
        name: "Copper rock",
        type: "resource" as const,
        resourceId: "ore_copper",
        position: [101, 0, 100] as [number, number, number],
        distance: 1,
      },
      {
        id: "production-pine",
        name: "Pine tree",
        type: "resource" as const,
        resourceId: "tree_pine",
        position: [102, 0, 100] as [number, number, number],
        distance: 2,
      },
    ];

    expect(
      processAgentTicks([makeWorkerInput(stagedItems, nearby)])[0].action,
    ).toEqual({ type: "gather", targetId: "production-pine" });
    const withLogs = [...stagedItems, { slot: 3, itemId: "logs", quantity: 1 }];
    expect(
      processAgentTicks([makeWorkerInput(withLogs, [])])[0].action,
    ).toEqual({
      type: "fletch",
      recipeId: "arrow_shaft:logs",
      quantity: 1,
    });
  });

  it("stages owned tools for the exact level-locked production training detour", async () => {
    const authoredStores = JSON.parse(
      await readFile(
        new URL(
          "../../../../world/assets/manifests/stores.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const recipes = buildWorkerProcessingRecipeSnapshot(
      undefined,
      authoredStores,
    );
    const readiness = recipes.combatReadiness;
    expect(readiness).toBeDefined();
    if (!readiness) return;
    const instance = {
      state: "running",
      goal: {
        type: "banking",
        description: "Check level-locked combat supplies",
        bankPurpose: "combat_supply",
      },
      config: {
        characterId: "production-smithing-detour-agent",
        accountId: "production-smithing-detour-account",
        name: "Production Smithing detour agent",
        combatSpecialization: "ranged",
      },
      service: {
        getGameState: () => ({
          inCombat: false,
          maxHealth: 20,
          skills: {
            attack: { level: 1, xp: 0 },
            ranged: { level: 1, xp: 0 },
            magic: { level: 1, xp: 0 },
            mining: { level: 1, xp: 0 },
            woodcutting: { level: 1, xp: 0 },
            smithing: { level: 5, xp: 0 },
            fletching: { level: 15, xp: 0 },
          },
          inventory: [{ slot: 0, itemId: "headless_arrow", quantity: 60 }],
          equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        }),
        getQuestState: () => [],
        getAvailableQuests: () => [],
        getWorld: () => ({ getSystem: () => ({}) }),
        getPrivateCoinBalance: () => 0,
      },
    } as unknown as AgentInstance;

    const stagePlan = buildOrdinaryBankStagePlan(
      instance,
      [
        {
          itemId: "bronze_pickaxe",
          quantity: 1,
          slot: 0,
          tabIndex: 0,
        },
        {
          itemId: "bronze_hatchet",
          quantity: 1,
          slot: 1,
          tabIndex: 0,
        },
      ],
      readiness,
    );
    expect(stagePlan).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "iron_arrow",
      actionCount: 7,
      items: [
        { itemId: "bronze_hatchet", quantity: 1 },
        { itemId: "bronze_pickaxe", quantity: 1 },
      ],
    });
    if (!stagePlan || !("items" in stagePlan)) return;

    initializeItems(buildWorkerItemDataSnapshot(), recipes);
    const stagedInventory = [
      { slot: 0, itemId: "headless_arrow", quantity: 60 },
      ...stagePlan.items.map((item, index) => ({ ...item, slot: index + 1 })),
      { slot: 2, itemId: "lobster", quantity: 2 },
    ];
    const makeWorkerInput = (
      inventoryItems: AgentTickInput["inventoryItems"],
      options: {
        skillOverrides?: AgentTickInput["gameState"]["skills"];
        nearbyEntities?: AgentTickInput["gameState"]["nearbyEntities"];
        stationPositions?: AgentTickInput["stationPositions"];
      } = {},
    ): AgentTickInput => ({
      characterId: "production-smithing-detour-agent",
      combatSpecialization: "ranged",
      behaviorEpoch: 11,
      playerId: "production-smithing-detour-player",
      name: "Production Smithing detour agent",
      gameState: {
        playerId: "production-smithing-detour-player",
        position: [100, 0, 100],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 1, xp: 0 },
          ranged: { level: 1, xp: 0 },
          magic: { level: 1, xp: 0 },
          mining: { level: 1, xp: 0 },
          woodcutting: { level: 1, xp: 0 },
          smithing: { level: 5, xp: 0 },
          fletching: { level: 15, xp: 0 },
          ...options.skillOverrides,
        },
        inventory: inventoryItems,
        equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        nearbyEntities: options.nearbyEntities ?? [
          {
            id: "production-tin",
            name: "Tin rock",
            type: "resource",
            resourceId: "ore_tin",
            position: [101, 0, 100],
            distance: 1,
          },
          {
            id: "production-copper",
            name: "Copper rock",
            type: "resource",
            resourceId: "ore_copper",
            position: [102, 0, 100],
            distance: 2,
          },
        ],
        inCombat: false,
        currentTarget: null,
        selectedSpell: null,
        activePrayers: [],
      },
      inventoryItems,
      equippedItems: { weapon: "shortbow" },
      questState: [],
      availableQuests: [],
      storeRetryAfter: 0,
      coinRecoveryAuthorized: false,
      attackObservationRetryAfter: 0,
      bankStageRetryAfter: Date.now() + 300_000,
      questEntryAcquisitionQuestId: null,
      ordinaryProcessingAcquisitionAuthorized: true,
      survivalFoodAcquisitionAuthorized: false,
      ordinaryProcessingRetrySuppressions: [],
      agentState: {
        goal: {
          type: "banking",
          description: "Checked private combat custody",
          bankPurpose: "combat_supply",
        },
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
      stationPositions: options.stationPositions ?? [],
      storePositions: recipes.stores.map((store) => ({
        entityId: `production-${store.storeId}`,
        storeId: store.storeId,
        name: store.storeId,
        position: [100, 0, 100],
      })),
    });

    expect(
      processAgentTicks([makeWorkerInput(stagedInventory)])[0].action,
    ).toEqual({ type: "gather", targetId: "production-copper" });
    expect(
      processAgentTicks([
        makeWorkerInput([
          ...stagedInventory,
          { slot: 3, itemId: "copper_ore", quantity: 1 },
        ]),
      ])[0].action,
    ).toEqual({ type: "gather", targetId: "production-tin" });

    const finalRecipeInstance = {
      ...instance,
      service: {
        ...instance.service,
        getGameState: () => ({
          inCombat: false,
          maxHealth: 20,
          skills: {
            attack: { level: 1, xp: 0 },
            ranged: { level: 1, xp: 0 },
            magic: { level: 1, xp: 0 },
            mining: { level: 15, xp: 0 },
            woodcutting: { level: 1, xp: 0 },
            smithing: { level: 20, xp: 0 },
            fletching: { level: 15, xp: 0 },
          },
          inventory: stagedInventory,
          equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        }),
      },
    } as unknown as AgentInstance;
    const finalRecipeStagePlan = buildOrdinaryBankStagePlan(
      finalRecipeInstance,
      [
        { itemId: "hammer", quantity: 1, slot: 0, tabIndex: 0 },
        {
          itemId: "bronze_hatchet",
          quantity: 1,
          slot: 1,
          tabIndex: 0,
        },
      ],
      readiness,
    );
    expect(finalRecipeStagePlan).toEqual({
      activity: "combat_supply_precursors",
      targetItemId: "iron_arrow",
      actionCount: 7,
      items: [{ itemId: "hammer", quantity: 1 }],
    });
    if (!finalRecipeStagePlan || !("items" in finalRecipeStagePlan)) return;

    const finalRecipeInventory = [
      ...stagedInventory,
      ...finalRecipeStagePlan.items.map((item, index) => ({
        ...item,
        slot: index + 3,
      })),
    ];
    const unlockedSkills = {
      mining: { level: 15, xp: 0 },
      smithing: { level: 20, xp: 0 },
    };
    const ironRock = {
      id: "production-iron",
      name: "Iron rock",
      type: "resource" as const,
      resourceId: "ore_iron",
      position: [101, 0, 100] as [number, number, number],
      distance: 1,
    };
    expect(
      processAgentTicks([
        makeWorkerInput(finalRecipeInventory, {
          skillOverrides: unlockedSkills,
          nearbyEntities: [ironRock],
        }),
      ])[0].action,
    ).toEqual({ type: "gather", targetId: "production-iron" });

    const furnace = {
      entityId: "production-furnace",
      stationType: "furnace" as const,
      name: "Production furnace",
      position: [100, 0, 100] as [number, number, number],
      interactionRange: 2,
    };
    const withIronOre = [
      ...finalRecipeInventory,
      { slot: 4, itemId: "iron_ore", quantity: 1 },
    ];
    expect(
      processAgentTicks([
        makeWorkerInput(withIronOre, {
          skillOverrides: unlockedSkills,
          nearbyEntities: [],
          stationPositions: [furnace],
        }),
      ])[0].action,
    ).toEqual({ type: "smelt", recipe: "iron_bar" });

    const anvil = {
      entityId: "production-anvil",
      stationType: "anvil" as const,
      name: "Production anvil",
      position: [100, 0, 100] as [number, number, number],
      interactionRange: 2,
    };
    const withIronBar = [
      ...finalRecipeInventory,
      { slot: 4, itemId: "iron_bar", quantity: 1 },
    ];
    expect(
      processAgentTicks([
        makeWorkerInput(withIronBar, {
          skillOverrides: unlockedSkills,
          nearbyEntities: [],
          stationPositions: [anvil],
        }),
      ])[0].action,
    ).toEqual({ type: "smith", recipe: "iron_arrowtips" });

    const withIronArrowtips = [
      ...finalRecipeInventory,
      { slot: 4, itemId: "iron_arrowtips", quantity: 15 },
    ];
    expect(
      processAgentTicks([
        makeWorkerInput(withIronArrowtips, {
          skillOverrides: unlockedSkills,
          nearbyEntities: [],
        }),
      ])[0].action,
    ).toEqual({
      type: "fletch",
      recipeId: "iron_arrow:iron_arrowtips",
      quantity: 1,
    });
  });

  it("retains the exact carried production bronze-arrow lineage during a capacity deposit", () => {
    const readiness = {
      ammunitionTarget: 50,
      magicCastTarget: 20,
      melee: [],
      ranged: [
        {
          weaponId: "shortbow",
          ammunitionId: "bronze_arrow",
          weaponScore: 1,
          ammunitionScore: 1,
          requiredRangedLevel: 1,
        },
      ],
      magic: [],
    };
    const instance = {
      state: "running",
      goal: {
        type: "banking",
        description: "Make room for exact combat supplies",
        bankPurpose: "combat_supply",
      },
      config: {
        characterId: "production-ranged-retention-agent",
        accountId: "production-ranged-retention-account",
        name: "Production ranged retention agent",
        combatSpecialization: "ranged",
      },
      service: {
        getGameState: () => ({
          inCombat: false,
          maxHealth: 20,
          skills: {
            attack: { level: 1, xp: 0 },
            ranged: { level: 1, xp: 0 },
            magic: { level: 1, xp: 0 },
            smithing: { level: 5, xp: 0 },
            fletching: { level: 5, xp: 0 },
            mining: { level: 1, xp: 0 },
            woodcutting: { level: 1, xp: 0 },
          },
          inventory: [
            { slot: 0, itemId: "bronze_arrow", quantity: 5 },
            { slot: 1, itemId: "bronze_arrowtips", quantity: 15 },
            { slot: 2, itemId: "bronze_bar", quantity: 1 },
            { slot: 3, itemId: "copper_ore", quantity: 7 },
            { slot: 4, itemId: "tin_ore", quantity: 7 },
            { slot: 5, itemId: "headless_arrow", quantity: 15 },
            { slot: 6, itemId: "arrow_shaft", quantity: 15 },
            { slot: 7, itemId: "feathers", quantity: 50 },
            { slot: 8, itemId: "logs", quantity: 5 },
            { slot: 9, itemId: "hammer", quantity: 1 },
            { slot: 10, itemId: "knife", quantity: 1 },
            { slot: 11, itemId: "iron_ore", quantity: 1 },
            { slot: 12, itemId: "bronze_hatchet", quantity: 1 },
            { slot: 13, itemId: "bronze_pickaxe", quantity: 1 },
          ],
          equipment: { weapon: { itemId: "shortbow", quantity: 1 } },
        }),
        getQuestState: () => [],
      },
    } as unknown as AgentInstance;

    expect(
      buildOrdinaryBankRetentionManifest(instance, {
        now: 1_000,
        combatReadinessCatalog: readiness,
      }),
    ).toEqual([
      { itemId: "arrow_shaft", quantity: 15 },
      { itemId: "bronze_arrow", quantity: 5 },
      { itemId: "bronze_arrowtips", quantity: 15 },
      { itemId: "bronze_bar", quantity: 1 },
      { itemId: "bronze_hatchet", quantity: 1 },
      { itemId: "bronze_pickaxe", quantity: 1 },
      { itemId: "copper_ore", quantity: 1 },
      { itemId: "feathers", quantity: 30 },
      { itemId: "hammer", quantity: 1 },
      { itemId: "headless_arrow", quantity: 15 },
      { itemId: "knife", quantity: 1 },
      { itemId: "logs", quantity: 1 },
      { itemId: "tin_ore", quantity: 1 },
    ]);
  });

  it("publishes only executable authored ranged and magic readiness combinations", async () => {
    const itemManifests = await Promise.all(
      [
        "ammunition",
        "armor",
        "food",
        "misc",
        "resources",
        "runes",
        "tools",
        "weapons",
      ].map(async (name) =>
        JSON.parse(
          await readFile(
            new URL(
              `../../../../world/assets/manifests/items/${name}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    );
    for (const item of itemManifests.flat() as Array<{
      id: string;
      [key: string]: unknown;
    }>) {
      if (!previousItems.has(item.id)) {
        previousItems.set(item.id, ITEMS.get(item.id));
      }
      ITEMS.set(item.id, item as never);
    }
    const authoredStores = JSON.parse(
      await readFile(
        new URL(
          "../../../../world/assets/manifests/stores.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const snapshot = buildWorkerProcessingRecipeSnapshot(
      undefined,
      authoredStores,
    );
    const workerItems = new Map(buildWorkerItemDataSnapshot());
    const readiness = snapshot.combatReadiness;
    expect(readiness).toBeDefined();
    expect(readiness?.ammunitionTarget).toBe(ORDINARY_COMBAT_AMMUNITION_TARGET);
    expect(readiness?.magicCastTarget).toBe(ORDINARY_COMBAT_MAGIC_CAST_TARGET);
    expect(readiness?.melee.length).toBeGreaterThan(0);
    expect(readiness?.ranged.length).toBeGreaterThan(0);
    expect(readiness?.magic.length).toBeGreaterThan(0);

    const storeItems = new Set(
      snapshot.stores.flatMap((store) =>
        store.items.map((item) => item.itemId),
      ),
    );
    expect(readiness?.melee.map((loadout) => loadout.weaponId)).toEqual(
      expect.arrayContaining([
        "bronze_shortsword",
        "bronze_longsword",
        "bronze_scimitar",
      ]),
    );
    for (const loadout of readiness?.melee ?? []) {
      expect(storeItems.has(loadout.weaponId)).toBe(true);
      expect(
        String(
          ITEMS.get(loadout.weaponId)?.attackType ?? "melee",
        ).toLowerCase(),
      ).toBe("melee");
      expect(
        workerItems.get(loadout.weaponId)?.smithing,
        `${loadout.weaponId} has no authored forging recipe`,
      ).toBeDefined();
    }
    for (const loadout of readiness?.ranged ?? []) {
      expect(storeItems.has(loadout.weaponId)).toBe(true);
      expect(storeItems.has(loadout.ammunitionId)).toBe(true);
      expect(
        String(ITEMS.get(loadout.weaponId)?.attackType).toLowerCase(),
      ).toBe("ranged");
      expect(ITEMS.get(loadout.ammunitionId)?.type).toBe("ammunition");
      expect(
        ammunitionService.areArrowsCompatible(
          loadout.weaponId,
          loadout.ammunitionId,
        ),
      ).toBe(true);
      expect(
        snapshot.fletching.some(
          (recipe) => recipe.outputItemId === loadout.weaponId,
        ),
        `${loadout.weaponId} has no authored Fletching recipe`,
      ).toBe(true);
      expect(
        snapshot.fletching.some(
          (recipe) => recipe.outputItemId === loadout.ammunitionId,
        ),
        `${loadout.ammunitionId} has no authored Fletching recipe`,
      ).toBe(true);
    }
    for (const loadout of readiness?.magic ?? []) {
      const spell = COMBAT_SPELLS[loadout.spellId];
      expect(spell).toBeDefined();
      expect(storeItems.has(loadout.weaponId)).toBe(true);
      expect(
        String(ITEMS.get(loadout.weaponId)?.attackType).toLowerCase(),
      ).toBe("magic");
      expect(loadout.providedRuneIds).toEqual(
        [...(ELEMENTAL_STAVES[loadout.weaponId] ?? [])].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(loadout.runes).toEqual(
        spell.runes.map((rune) => ({
          itemId: rune.runeId,
          quantityPerCast: rune.quantity,
        })),
      );
      for (const rune of loadout.runes) {
        expect(
          loadout.providedRuneIds.includes(rune.itemId) ||
            storeItems.has(rune.itemId),
        ).toBe(true);
        if (!loadout.providedRuneIds.includes(rune.itemId)) {
          expect(
            snapshot.runecrafting.some(
              (recipe) => recipe.runeItemId === rune.itemId,
            ),
            `${rune.itemId} has no authored Runecrafting recipe`,
          ).toBe(true);
        }
      }
    }
    expect(readiness?.ranged).toContainEqual(
      expect.objectContaining({
        weaponId: "shortbow",
        ammunitionId: "bronze_arrow",
      }),
    );
    expect(readiness?.magic).toContainEqual(
      expect.objectContaining({
        weaponId: "staff_of_air",
        spellId: "wind_strike",
      }),
    );
    expect(() => structuredClone(readiness)).not.toThrow();
  });

  it("publishes only exact guaranteed authored mob-drop sources", async () => {
    const npcs = JSON.parse(
      await readFile(
        new URL(
          "../../../../world/assets/manifests/npcs.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Array<{
      id: string;
      category: string;
      drops?: {
        defaultDrop?: { enabled: boolean; itemId: string };
        always?: Array<{ itemId: string; chance: number }>;
        common?: Array<{ itemId: string; chance: number }>;
        uncommon?: Array<{ itemId: string; chance: number }>;
        rare?: Array<{ itemId: string; chance: number }>;
        veryRare?: Array<{ itemId: string; chance: number }>;
      };
    }>;
    const combatNpcs = npcs.filter((entry) =>
      ["mob", "boss", "quest"].includes(entry.category),
    );
    const snapshot = buildWorkerProcessingRecipeSnapshot(combatNpcs as never);
    expect(snapshot.guaranteedMobDrops?.length).toBeGreaterThan(0);

    for (const npc of combatNpcs) {
      const drops = npc.drops;
      if (!drops) continue;
      const expected = [
        ...(drops.defaultDrop?.enabled ? [drops.defaultDrop.itemId] : []),
        ...[
          ...(drops.always ?? []),
          ...(drops.common ?? []),
          ...(drops.uncommon ?? []),
          ...(drops.rare ?? []),
          ...(drops.veryRare ?? []),
        ]
          .filter((drop) => drop.chance === 1)
          .map((drop) => drop.itemId),
      ];
      const actual = snapshot.guaranteedMobDrops?.find(
        (source) => source.mobType === npc.id,
      )?.itemIds;
      if (expected.length === 0) {
        expect(actual).toBeUndefined();
      } else {
        expect(actual).toEqual(
          [...new Set(expected)].sort((a, b) => a.localeCompare(b)),
        );
      }
    }

    expect(
      snapshot.guaranteedMobDrops?.find((source) => source.mobType === "cow")
        ?.itemIds,
    ).toContain("cowhide");
    expect(
      snapshot.guaranteedMobDrops?.find((source) => source.mobType === "goblin")
        ?.itemIds,
    ).toContain("coins");
  });

  it("preserves exact loaded gathering outputs and tool requirements", async () => {
    const [woodcutting, mining, fishing] = await Promise.all(
      ["woodcutting", "mining", "fishing"].map(async (name) =>
        JSON.parse(
          await readFile(
            new URL(
              `../../../../world/assets/manifests/gathering/${name}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    );
    const resources = [...woodcutting.trees, ...mining.rocks, ...fishing.spots];
    const globals = globalThis as {
      EXTERNAL_RESOURCES?: Map<string, (typeof resources)[number]>;
    };
    const previous = globals.EXTERNAL_RESOURCES;
    globals.EXTERNAL_RESOURCES = new Map(
      resources.map((resource) => [resource.id, resource]),
    );
    try {
      const snapshot = buildWorkerProcessingRecipeSnapshot();
      expect(snapshot.gathering).toHaveLength(resources.length);
      for (const resource of resources) {
        expect(
          snapshot.gathering.find(
            (candidate) => candidate.resourceId === resource.id,
          ),
        ).toEqual({
          resourceId: resource.id,
          harvestSkill: resource.harvestSkill,
          toolRequired: resource.toolRequired,
          levelRequired: resource.levelRequired,
          outputItemIds: [
            ...new Set<string>(
              resource.harvestYield.map(
                (drop: { itemId: string }) => drop.itemId,
              ),
            ),
          ].sort((a, b) => a.localeCompare(b)),
        });
      }
      expect(() => structuredClone(snapshot.gathering)).not.toThrow();
    } finally {
      if (previous) globals.EXTERNAL_RESOURCES = previous;
      else delete globals.EXTERNAL_RESOURCES;
    }
  });

  it("contains authored public recipes but no player custody or wallet state", () => {
    const serialized = JSON.stringify({
      items: buildWorkerItemDataSnapshot(),
      recipes: buildWorkerProcessingRecipeSnapshot(),
    });
    expect(serialized).toContain('"cooking"');
    expect(serialized).toContain('"smelting"');
    expect(serialized).toContain('"smithing"');
    expect(serialized).toContain('"fletching"');
    expect(serialized).toContain('"runecrafting"');
    expect(serialized).toContain('"gathering"');
    expect(serialized).not.toMatch(
      /bankItems|bankQuantity|inventoryItems|coinBalance|processingConsumableUses|wallet|privateKey|secretKey/,
    );
  });
});
