import { readFile, readdir } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

type ItemDefinition = {
  id?: string;
  type?: string;
};

type ItemRequirement = {
  itemId: string;
  quantity: number;
};

type ProcessingRecipe = {
  family: string;
  stableId: string;
  outputItemId: string | null;
  requirementAlternatives: ItemRequirement[][];
  tools: string[];
  consumables: string[];
};

type AcquisitionSource = {
  itemId: string;
  kind: "gathering" | "store" | "mob_drop" | "quest";
  sourceId: string;
};

type QuestCoverageDefinition = {
  id: string;
  requirements: {
    quests: string[];
    skills: Record<string, number>;
    items: string[];
  };
  stages: Array<{ id: string; type: string; target?: string }>;
  onStart?: { items?: Array<{ itemId: string }> };
  rewards?: { items?: Array<{ itemId: string }> };
};

type InteractionSkillRequirement = {
  skill: string;
  level: number;
  family: string;
};

const manifestRoot = new URL(
  "../../../world/assets/manifests/",
  import.meta.url,
);

async function readManifest<T>(relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(relativePath, manifestRoot), "utf8"),
  ) as T;
}

function requirement(itemId: string, quantity = 1): ItemRequirement {
  return { itemId, quantity };
}

describe("ordinary agent authored acquisition coverage", () => {
  let itemIds: Set<string>;
  let itemDefinitions: ItemDefinition[];
  let recipes: ProcessingRecipe[];
  let sources: AcquisitionSource[];
  let questItemReferences: Array<{ itemId: string; sourceId: string }>;
  let cookingBurntOutputIds: string[];
  let gatheringYieldIds: string[];
  let ammunitionIds: string[];
  let combatRuneIds: string[];
  let quests: QuestCoverageDefinition[];
  let interactionSkillRequirements: Map<string, InteractionSkillRequirement>;

  beforeAll(async () => {
    const itemDirectory = new URL("items/", manifestRoot);
    const itemFiles = (await readdir(itemDirectory))
      .filter((fileName) => fileName.endsWith(".json"))
      .sort();
    itemDefinitions = (
      await Promise.all(
        itemFiles.map((fileName) =>
          readManifest<ItemDefinition[]>(`items/${fileName}`),
        ),
      )
    ).flat();
    itemIds = new Set(
      itemDefinitions
        .map((item) => item.id)
        .filter((itemId): itemId is string => Boolean(itemId)),
    );

    const [
      cooking,
      crafting,
      firemaking,
      fletching,
      runecrafting,
      smelting,
      smithing,
      tanning,
    ] = await Promise.all(
      [
        "cooking",
        "crafting",
        "firemaking",
        "fletching",
        "runecrafting",
        "smelting",
        "smithing",
        "tanning",
      ].map((family) =>
        readManifest<{ recipes: Array<Record<string, unknown>> }>(
          `recipes/${family}.json`,
        ),
      ),
    );

    recipes = [
      ...cooking.recipes.map((entry) => ({
        family: "cooking",
        stableId: String(entry.raw),
        outputItemId: String(entry.cooked),
        requirementAlternatives: [[requirement(String(entry.raw))]],
        tools: [],
        consumables: [],
      })),
      ...crafting.recipes.map((entry) => ({
        family: "crafting",
        stableId: String(entry.output),
        outputItemId: String(entry.output),
        requirementAlternatives: [
          (entry.inputs as Array<{ item: string; amount: number }>).map(
            (input) => requirement(input.item, input.amount),
          ),
        ],
        tools: (entry.tools as string[]) ?? [],
        consumables: ((entry.consumables as Array<{ item: string }>) ?? []).map(
          (consumable) => consumable.item,
        ),
      })),
      ...firemaking.recipes.map((entry) => ({
        family: "firemaking",
        stableId: String(entry.log),
        outputItemId: null,
        requirementAlternatives: [[requirement(String(entry.log))]],
        tools: ["tinderbox"],
        consumables: [],
      })),
      ...fletching.recipes.map((entry) => ({
        family: "fletching",
        stableId: String(entry.output),
        outputItemId: String(entry.output),
        requirementAlternatives: [
          (entry.inputs as Array<{ item: string; amount: number }>).map(
            (input) => requirement(input.item, input.amount),
          ),
        ],
        tools: (entry.tools as string[]) ?? [],
        consumables: [],
      })),
      ...runecrafting.recipes.map((entry) => ({
        family: "runecrafting",
        stableId: String(entry.runeType),
        outputItemId: String(entry.runeItemId),
        requirementAlternatives: (entry.essenceTypes as string[]).map(
          (itemId) => [requirement(itemId)],
        ),
        tools: [],
        consumables: [],
      })),
      ...smelting.recipes.map((entry) => ({
        family: "smelting",
        stableId: String(entry.output),
        outputItemId: String(entry.output),
        requirementAlternatives: [
          (entry.inputs as Array<{ item: string; amount: number }>).map(
            (input) => requirement(input.item, input.amount),
          ),
        ],
        tools: [],
        consumables: [],
      })),
      ...smithing.recipes.map((entry) => ({
        family: "smithing",
        stableId: String(entry.output),
        outputItemId: String(entry.output),
        requirementAlternatives: [
          [requirement(String(entry.bar), Number(entry.barsRequired))],
        ],
        tools: ["hammer"],
        consumables: [],
      })),
      ...tanning.recipes.map((entry) => ({
        family: "tanning",
        stableId: String(entry.output),
        outputItemId: String(entry.output),
        requirementAlternatives: [[requirement(String(entry.input))]],
        tools: [],
        consumables: [],
      })),
    ];

    interactionSkillRequirements = new Map();
    const registerInteractionRequirement = (
      itemId: string,
      requirement: InteractionSkillRequirement,
    ) => {
      const existing = interactionSkillRequirements.get(itemId);
      if (!existing || requirement.level < existing.level) {
        interactionSkillRequirements.set(itemId, requirement);
      }
    };
    for (const entry of cooking.recipes) {
      registerInteractionRequirement(String(entry.cooked), {
        skill: "cooking",
        level: Number(entry.level),
        family: "cooking",
      });
    }
    for (const entry of crafting.recipes) {
      registerInteractionRequirement(String(entry.output), {
        skill: "crafting",
        level: Number(entry.level),
        family: "crafting",
      });
    }
    for (const entry of fletching.recipes) {
      registerInteractionRequirement(String(entry.output), {
        skill: "fletching",
        level: Number(entry.level),
        family: "fletching",
      });
    }
    for (const entry of runecrafting.recipes) {
      registerInteractionRequirement(String(entry.runeItemId), {
        skill: "runecrafting",
        level: Number(entry.levelRequired),
        family: "runecrafting",
      });
    }
    for (const [family, entries] of [
      ["smelting", smelting.recipes],
      ["smithing", smithing.recipes],
    ] as const) {
      for (const entry of entries) {
        registerInteractionRequirement(String(entry.output), {
          skill: "smithing",
          level: Number(entry.level),
          family,
        });
      }
    }

    cookingBurntOutputIds = cooking.recipes.map((entry) => String(entry.burnt));

    const gatheringManifests = await Promise.all(
      ["fishing", "mining", "woodcutting"].map((skill) =>
        readManifest<Record<string, unknown>>(`gathering/${skill}.json`),
      ),
    );
    const gatheringResources = gatheringManifests.flatMap(
      (manifest) =>
        Object.values(manifest).find(
          (value): value is Array<Record<string, unknown>> =>
            Array.isArray(value),
        ) ?? [],
    );
    sources = [];
    gatheringYieldIds = [];
    for (const resource of gatheringResources) {
      for (const drop of (resource.harvestYield as Array<{ itemId: string }>) ??
        []) {
        gatheringYieldIds.push(drop.itemId);
        sources.push({
          itemId: drop.itemId,
          kind: "gathering",
          sourceId: String(resource.id),
        });
      }
    }

    const stores =
      await readManifest<
        Array<{ id: string; items: Array<{ itemId: string }> }>
      >("stores.json");
    for (const store of stores) {
      for (const item of store.items) {
        sources.push({
          itemId: item.itemId,
          kind: "store",
          sourceId: store.id,
        });
      }
    }

    const npcs = await readManifest<
      Array<{
        id: string;
        drops?: {
          defaultDrop?: { enabled: boolean; itemId: string };
          always?: Array<{ itemId: string }>;
          common?: Array<{ itemId: string }>;
          uncommon?: Array<{ itemId: string }>;
          rare?: Array<{ itemId: string }>;
          veryRare?: Array<{ itemId: string }>;
        };
      }>
    >("npcs.json");
    for (const npc of npcs) {
      const drops = npc.drops;
      if (!drops) continue;
      const authoredDrops = [
        ...(drops.defaultDrop?.enabled ? [drops.defaultDrop] : []),
        ...(drops.always ?? []),
        ...(drops.common ?? []),
        ...(drops.uncommon ?? []),
        ...(drops.rare ?? []),
        ...(drops.veryRare ?? []),
      ];
      for (const drop of authoredDrops) {
        sources.push({
          itemId: drop.itemId,
          kind: "mob_drop",
          sourceId: npc.id,
        });
      }
    }

    const questManifest =
      await readManifest<Record<string, QuestCoverageDefinition>>(
        "quests.json",
      );
    quests = Object.values(questManifest);
    questItemReferences = [];
    for (const quest of quests) {
      const questItems = [
        ...quest.requirements.items,
        ...(quest.onStart?.items ?? []).map((item) => item.itemId),
        ...(quest.rewards?.items ?? []).map((item) => item.itemId),
        ...quest.stages
          .filter(
            (stage) =>
              (stage.type === "gather" || stage.type === "interact") &&
              stage.target &&
              stage.target !== "fire",
          )
          .map((stage) => stage.target!),
      ];
      for (const itemId of questItems) {
        questItemReferences.push({ itemId, sourceId: quest.id });
      }
      for (const itemId of [
        ...(quest.onStart?.items ?? []).map((item) => item.itemId),
        ...(quest.rewards?.items ?? []).map((item) => item.itemId),
      ]) {
        sources.push({ itemId, kind: "quest", sourceId: quest.id });
      }
    }

    const ammunition = await readManifest<{
      arrows: Array<{ id: string }>;
    }>("ammunition.json");
    ammunitionIds = ammunition.arrows.map((arrow) => arrow.id);
    const combatSpells = await readManifest<{
      standard: Record<
        string,
        Array<{ runes: Array<{ runeId: string; quantity: number }> }>
      >;
    }>("combat-spells.json");
    combatRuneIds = [
      ...new Set(
        Object.values(combatSpells.standard)
          .flat()
          .flatMap((spell) => spell.runes.map((rune) => rune.runeId)),
      ),
    ];
  });

  it("keeps every production recipe and quest item reference manifest-defined", () => {
    expect(recipes.length).toBeGreaterThan(0);
    for (const recipe of recipes) {
      const referencedItems = [
        ...(recipe.outputItemId ? [recipe.outputItemId] : []),
        ...recipe.requirementAlternatives.flat().map((entry) => entry.itemId),
        ...recipe.tools,
        ...recipe.consumables,
      ];
      for (const itemId of referencedItems) {
        expect(
          itemIds.has(itemId),
          `${recipe.family}:${recipe.stableId} references undefined item "${itemId}"`,
        ).toBe(true);
      }
    }

    for (const reference of questItemReferences) {
      expect(
        itemIds.has(reference.itemId),
        `Quest ${reference.sourceId} references undefined item "${reference.itemId}"`,
      ).toBe(true);
    }

    for (const itemId of cookingBurntOutputIds) {
      expect(
        itemIds.has(itemId),
        `Cooking manifest references undefined burnt output "${itemId}"`,
      ).toBe(true);
    }
  });

  it("proves every processing and combat consumable has an authored acquisition path", () => {
    const reachable = new Set(
      sources
        .filter((source) => itemIds.has(source.itemId))
        .map((source) => source.itemId),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const recipe of recipes) {
        if (!recipe.outputItemId || reachable.has(recipe.outputItemId))
          continue;
        const commonRequirements = [...recipe.tools, ...recipe.consumables];
        const hasReachableAlternative = recipe.requirementAlternatives.some(
          (alternative) =>
            [
              ...alternative.map((entry) => entry.itemId),
              ...commonRequirements,
            ].every((itemId) => reachable.has(itemId)),
        );
        if (hasReachableAlternative) {
          reachable.add(recipe.outputItemId);
          changed = true;
        }
      }
    }

    const processingDependencies = new Set(
      recipes.flatMap((recipe) => [
        ...recipe.requirementAlternatives.flat().map((entry) => entry.itemId),
        ...recipe.tools,
        ...recipe.consumables,
      ]),
    );
    for (const itemId of [
      ...processingDependencies,
      ...ammunitionIds,
      ...combatRuneIds,
    ]) {
      expect(
        reachable.has(itemId),
        `No authored acquisition path reaches required item "${itemId}"`,
      ).toBe(true);
    }
  });

  it("retains a direct public-source processing baseline for every ordinary combat specialization", () => {
    const directlyAcquirable = new Set(
      sources
        .filter((source) => itemIds.has(source.itemId))
        .map((source) => source.itemId),
    );
    const baselineFamilyBySpecialization = {
      melee: "smelting",
      ranged: "fletching",
      mage: "runecrafting",
    } as const;

    for (const [specialization, family] of Object.entries(
      baselineFamilyBySpecialization,
    )) {
      const candidates = recipes.filter((recipe) => recipe.family === family);
      expect(
        candidates.some((recipe) =>
          recipe.requirementAlternatives.some((alternative) =>
            [
              ...alternative.map((entry) => entry.itemId),
              ...recipe.tools,
              ...recipe.consumables,
            ].every((itemId) => directlyAcquirable.has(itemId)),
          ),
        ),
        `${specialization} has no directly acquirable ${family} baseline`,
      ).toBe(true);
    }
  });

  it("requires every production quest to declare the skill needed for its mandatory processing stages", () => {
    for (const quest of quests) {
      for (const stage of quest.stages) {
        if (
          stage.type !== "interact" ||
          !stage.target ||
          stage.target === "fire"
        )
          continue;

        const recipeRequirement = interactionSkillRequirements.get(
          stage.target,
        );
        expect(
          recipeRequirement,
          `Quest ${quest.id} stage ${stage.id} has no processing recipe for "${stage.target}"`,
        ).toBeDefined();
        if (!recipeRequirement) continue;

        const effectiveStartLevel =
          quest.requirements.skills[recipeRequirement.skill] ?? 1;
        expect(
          effectiveStartLevel,
          `Quest ${quest.id} stage ${stage.id} requires ${recipeRequirement.family} level ${recipeRequirement.level} for "${stage.target}" but only declares ${recipeRequirement.skill} level ${effectiveStartLevel}`,
        ).toBeGreaterThanOrEqual(recipeRequirement.level);
      }
    }
  });

  it("ratchets the unresolved optional gathering-content blocker", () => {
    const undefinedGatheringYields = [
      ...new Set(gatheringYieldIds.filter((itemId) => !itemIds.has(itemId))),
    ].sort();

    // Gold ore has an authored rock and world spawn but no item/economy/recipe
    // definition. Keep the exact known set visible until product authors its
    // role; any additional broken yield fails this gate immediately.
    expect(undefinedGatheringYields).toEqual(["gold_ore"]);

    const undefinedAuthoredSources = sources
      .filter((source) => !itemIds.has(source.itemId))
      .map((source) => `${source.kind}:${source.sourceId}:${source.itemId}`)
      .sort();
    expect(undefinedAuthoredSources).toEqual(["gathering:ore_gold:gold_ore"]);
  });
});
