import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMBAT_SPELLS,
  DeathState,
  ITEMS,
  getDuelArenaConfig,
  isPositionInsideCombatArena,
  prayerDataProvider,
} from "@hyperforge/shared";
import { AgentManager } from "../AgentManager";
import { getDuelPreparationAttackSupplyTarget } from "../duelPreparationPlan";
import { EmbeddedHyperiaService } from "../EmbeddedHyperiaService";
import type {
  DuelPreparationPlanExecutionRequest,
  EmbeddedGameState,
} from "../types";
import {
  DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT,
  DUEL_PREPARATION_LOCAL_REVOCATION_EVENT,
  PostgresDuelPreparationStore,
} from "../../systems/StreamingDuelScheduler/preparation";
import { STREAMING_TIMING } from "../../systems/StreamingDuelScheduler/types";
import prayersManifest from "../../../world/assets/manifests/prayers.json";

const externalPreparationHostOwnerId = "6f153f9c-8ee4-4ddc-86eb-8d7413457bd0";
const externalPreparationExecutableBuildId = "ab".repeat(32);

vi.mock(
  "../../streaming/duel-equipment-presentation.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../streaming/duel-equipment-presentation.js")
      >();
    return {
      ...actual,
      isStreamingDuelEquipmentPresentationEligible: (
        itemId: unknown,
        slot: unknown,
      ) =>
        (typeof itemId === "string" && itemId.startsWith("test_prep_")) ||
        actual.isStreamingDuelEquipmentPresentationEligible(itemId, slot),
    };
  },
);

type Skill = { level: number; xp: number };

type TestEntity = {
  id: string;
  type: string;
  isAgent?: boolean;
  data: Record<string, any>;
};

type CharacterRow = {
  id: string;
  accountId: string;
  name: string;
  savedData?: Record<string, unknown> | null;
};

const EMPTY_FROZEN_ARMOR_IDS = {
  helmet: null,
  body: null,
  legs: null,
  boots: null,
  gloves: null,
  cape: null,
  amulet: null,
  ring: null,
} as const;

function createMockWorld(terrainHeight: number) {
  const entities = new Map<string, TestEntity>();
  const characters = new Map<string, CharacterRow>();
  const combatCalls: Array<{ attackerId: string; targetId: string }> = [];
  const combatPreparationFences = new Map<string, string>();
  const gatherCalls: Array<{ playerId: string; resourceId: string }> = [];

  const defaultSkills: Record<string, Skill> = {
    attack: { level: 10, xp: 0 },
    strength: { level: 10, xp: 0 },
    defense: { level: 10, xp: 0 },
    constitution: { level: 20, xp: 0 },
    ranged: { level: 1, xp: 0 },
    magic: { level: 1, xp: 0 },
    prayer: { level: 1, xp: 0 },
    woodcutting: { level: 1, xp: 0 },
    mining: { level: 1, xp: 0 },
    fishing: { level: 1, xp: 0 },
    firemaking: { level: 1, xp: 0 },
    cooking: { level: 1, xp: 0 },
    smithing: { level: 1, xp: 0 },
  };

  const world = {
    entities: {
      items: entities,
      get: (id: string) => entities.get(id),
      add: (entityData: Record<string, unknown>) => {
        const id = String(entityData.id);
        const skillsFromEntity = (entityData.skills ?? defaultSkills) as Record<
          string,
          Skill
        >;
        const entity: TestEntity = {
          id,
          type: String(entityData.type ?? "object"),
          isAgent: Boolean(entityData.isAgent),
          data: {
            ...entityData,
            skills: Object.fromEntries(
              Object.entries(skillsFromEntity).map(([key, value]) => [
                key,
                { ...value },
              ]),
            ),
          },
        };
        entities.set(id, entity);
        return entity;
      },
      remove: (id: string) => {
        entities.delete(id);
      },
      getAllEntities: () => entities,
    },
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getSystem: vi.fn((name: string) => {
      if (name === "database") {
        return {
          getCharactersAsync: async (accountId: string) =>
            Array.from(characters.values())
              .filter((character) => character.accountId === accountId)
              .map((character) => ({
                id: character.id,
                name: character.name,
                avatar: null,
                wallet: null,
              })),
          getPlayerAsync: async (characterId: string) =>
            characters.get(characterId)?.savedData ?? null,
        };
      }

      if (name === "terrain") {
        return {
          getHeightAt: () => terrainHeight,
        };
      }

      if (name === "combat") {
        return {
          beginDuelPreparationCombatFence: (
            entityId: string,
            preparationId: string,
          ) => {
            const current = combatPreparationFences.get(entityId);
            if (current && current !== preparationId) return false;
            combatPreparationFences.set(entityId, preparationId);
            return true;
          },
          endDuelPreparationCombatFence: (
            entityId: string,
            preparationId: string,
          ) => {
            if (combatPreparationFences.get(entityId) !== preparationId) {
              return false;
            }
            combatPreparationFences.delete(entityId);
            return true;
          },
          startCombat: (attackerId: string, targetId: string) => {
            combatCalls.push({ attackerId, targetId });
            const attacker = entities.get(attackerId);
            const target = entities.get(targetId);
            if (!attacker || !target) {
              return false;
            }
            if ((attacker.data.health ?? 0) <= 0) {
              return false;
            }
            if ((target.data.health ?? 0) <= 0) {
              return false;
            }
            target.data.health = Math.max(0, (target.data.health ?? 0) - 4);
            target.data.inCombat = target.data.health > 0;
            target.data.combatTarget =
              target.data.health > 0 ? attackerId : null;
            return true;
          },
        };
      }

      if (name === "resource") {
        return {
          startGathering: (playerId: string, resourceId: string) => {
            gatherCalls.push({ playerId, resourceId });
            const player = entities.get(playerId);
            const woodcutting = player?.data.skills?.woodcutting as Skill;
            if (!woodcutting) {
              return;
            }
            woodcutting.xp += 60;
            while (woodcutting.xp >= 100) {
              woodcutting.xp -= 100;
              woodcutting.level += 1;
            }
          },
        };
      }

      if (name === "movement") {
        return {
          requestMovement: (
            entityId: string,
            target: [number, number, number],
          ) => {
            const entity = entities.get(entityId);
            if (!entity) {
              return;
            }
            entity.data.position = [...target];
          },
          cancelMovement: vi.fn(),
        };
      }

      return null;
    }),
    settings: {
      avatar: { url: "asset://avatars/test.vrm" },
    },
  };

  const registerCharacter = (
    accountId: string,
    characterId: string,
    name: string,
    savedData: Record<string, unknown> | null = null,
  ) => {
    characters.set(characterId, {
      id: characterId,
      accountId,
      name,
      savedData,
    });
  };

  const addMob = (id: string, position: [number, number, number]) => {
    entities.set(id, {
      id,
      type: "mob",
      data: {
        id,
        type: "mob",
        name: "Test Goblin",
        mobType: "goblin",
        position,
        health: 20,
        maxHealth: 20,
      },
    });
  };

  const addResource = (
    id: string,
    position: [number, number, number],
    resourceType: string,
  ) => {
    entities.set(id, {
      id,
      type: "resource",
      data: {
        id,
        type: "resource",
        name: "Test Resource",
        resourceType,
        position,
      },
    });
  };

  return {
    world,
    entities,
    combatCalls,
    combatPreparationFences,
    gatherCalls,
    registerCharacter,
    addMob,
    addResource,
  };
}

async function forceTestShutdown(manager: AgentManager): Promise<void> {
  // Most unit cases intentionally use a DB-free world while leaving a private
  // preparation fixture attached. Remove only that fixture during teardown so
  // strict production shutdown behavior remains testable in dedicated cases.
  for (const instance of (manager as any).agents.values()) {
    instance.duelPreparation = undefined;
  }
  await manager.shutdown();
}

describe("AgentManager autonomous loop", () => {
  it("applies exact scheduler recovery holds to a tracked embedded service", () => {
    const ctx = createMockWorld(10);
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const setCompetitiveRecoveryCustodyHold = vi.fn();
    (manager as any).agents.set("agent-recovery", {
      service: { setCompetitiveRecoveryCustodyHold },
    });
    const registration = ctx.world.on.mock.calls.find(
      ([event]) => event === DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT,
    );
    expect(registration).toBeDefined();
    const listener = registration?.[1] as (payload: unknown) => void;
    const preparationId = "00000000-0000-4000-8000-000000000001";

    listener({
      preparationId,
      agentId: "agent-recovery",
      active: true,
    });
    listener({
      preparationId,
      agentId: "agent-recovery",
      active: false,
    });
    listener({
      preparationId: "invalid",
      agentId: "agent-recovery",
      active: true,
    });

    expect(setCompetitiveRecoveryCustodyHold.mock.calls).toEqual([
      [preparationId, true],
      [preparationId, false],
    ]);
    manager.dispose();
  });

  const duelPreparationItems = [
    {
      id: "test_prep_sword",
      name: "Test Preparation Sword",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "MELEE",
      stackable: false,
      bonuses: { attack: 8, strength: 7 },
      requirements: { level: 1, skills: { attack: 1 } },
    },
    {
      id: "test_prep_reserve_sword",
      name: "Test Preparation Reserve Sword",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "MELEE",
      stackable: false,
      bonuses: { attack: 1, strength: 1 },
      requirements: { level: 1, skills: { attack: 1 } },
    },
    {
      id: "bronze_shortsword",
      name: "Bronze Shortsword",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "MELEE",
      stackable: false,
      bonuses: { attack: 4, strength: 3 },
      requirements: { level: 1, skills: { attack: 1 } },
    },
    {
      id: "bronze_dagger",
      name: "Bronze Dagger",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "MELEE",
      stackable: false,
      bonuses: { attack: 4, strength: 3 },
      requirements: { level: 1, skills: { attack: 1 } },
    },
    {
      id: "bronze_full_helm",
      name: "Bronze Full Helm",
      type: "armor",
      equipSlot: "helmet",
      stackable: false,
      bonuses: { defenseStab: 4, defenseSlash: 5, defenseCrush: 3 },
      requirements: { level: 1, skills: { defence: 1 } },
    },
    {
      id: "shortbow",
      name: "Shortbow",
      type: "weapon",
      equipSlot: "2h",
      attackType: "RANGED",
      weaponType: "BOW",
      stackable: false,
      bonuses: { attackRanged: 8 },
      requirements: { skills: { ranged: 1 } },
    },
    {
      id: "bronze_arrow",
      name: "Bronze Arrow",
      type: "ammunition",
      equipSlot: "arrows",
      stackable: true,
      requirements: { skills: { ranged: 1 } },
    },
    {
      id: "staff_of_air",
      name: "Staff of Air",
      type: "weapon",
      equipSlot: "weapon",
      attackType: "MAGIC",
      weaponType: "STAFF",
      stackable: false,
      bonuses: { attackMagic: 10 },
      requirements: { skills: { magic: 1 } },
    },
    {
      id: "fire_rune",
      name: "Fire Rune",
      type: "material",
      stackable: true,
    },
    {
      id: "mind_rune",
      name: "Mind Rune",
      type: "material",
      stackable: true,
    },
    {
      id: "lobster",
      name: "Lobster",
      type: "consumable",
      healAmount: 12,
      stackable: false,
    },
    {
      id: "test_prep_food",
      name: "Test Preparation Food",
      type: "consumable",
      healAmount: 6,
      stackable: false,
    },
    {
      id: "test_prep_junk",
      name: "Test Preparation Junk",
      type: "material",
      stackable: false,
    },
    {
      id: "test_prep_weak_body",
      name: "Test Preparation Weak Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: { defenseStab: 2, defenseSlash: 2, defenseCrush: 2 },
    },
    {
      id: "test_prep_strong_body",
      name: "Test Preparation Strong Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      requirements: { skills: { defence: 20 } },
      bonuses: { defenseStab: 12, defenseSlash: 14, defenseCrush: 10 },
    },
    {
      id: "test_prep_overleveled_body",
      name: "Test Preparation Overleveled Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      requirements: { skills: { defence: 40 } },
      bonuses: { defenseStab: 50, defenseSlash: 50, defenseCrush: 50 },
    },
    {
      id: "test_prep_metal_body",
      name: "Test Preparation Metal Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: {
        attackMagic: -30,
        defenseStab: 30,
        defenseSlash: 30,
        defenseCrush: 30,
      },
    },
    {
      id: "test_prep_wizard_body",
      name: "Test Preparation Wizard Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: { attackMagic: 3, defenseMagic: 3 },
    },
    {
      id: "test_prep_ranged_defense_body",
      name: "Test Preparation Ranged Defense Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: { defenseRanged: 20, defenseMagic: 1 },
    },
    {
      id: "test_prep_magic_defense_body",
      name: "Test Preparation Magic Defense Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: { defenseRanged: 1, defenseMagic: 20 },
    },
    {
      id: "test_prep_shield",
      name: "Test Preparation Shield",
      type: "armor",
      equipSlot: "shield",
      stackable: false,
      bonuses: { defenseStab: 5, defenseSlash: 5, defenseCrush: 5 },
    },
    {
      id: "test_prep_melee_body",
      name: "Test Preparation Melee Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: { defenseStab: 4, defenseSlash: 4, defenseCrush: 4 },
    },
    {
      id: "test_prep_melee_offense_body",
      name: "Test Preparation Melee Offense Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: {
        attackSlash: 6,
        defenseStab: 1,
        defenseSlash: 1,
        defenseCrush: 1,
      },
    },
    {
      id: "test_prep_ranged_body",
      name: "Test Preparation Ranged Body",
      type: "armor",
      equipSlot: "body",
      stackable: false,
      bonuses: { attackRanged: 8, defenseRanged: 2 },
    },
    {
      id: "water_rune",
      name: "Water Rune",
      type: "material",
      stackable: true,
    },
  ] as const;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.spyOn(
      AgentManager.prototype as unknown as {
        beginDuelPreparationHostLease(
          instance: unknown,
          preparationId: string,
        ): Promise<boolean>;
      },
      "beginDuelPreparationHostLease",
    ).mockResolvedValue(true);
    prayerDataProvider.loadPrayers(prayersManifest);
    prayerDataProvider.rebuild();
    for (const item of duelPreparationItems) {
      ITEMS.set(item.id, item as never);
    }
    vi.spyOn(
      EmbeddedHyperiaService.prototype,
      "executeDuelPreparationPlan",
    ).mockImplementation(async function (
      this: EmbeddedHyperiaService,
      request,
    ) {
      return {
        ok: true,
        playerId: (this as unknown as { characterId: string }).characterId,
        operationId: request.operationId,
        preparationId: request.preparationId,
        requestFingerprint: "test-atomic-plan-fingerprint",
        changed: true,
        replayed: false,
        committed: request.committed,
        recoveryEvidence: request.recoveryEvidence,
      };
    });
  });

  afterEach(() => {
    for (const item of duelPreparationItems) {
      ITEMS.delete(item.id);
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("keeps scripted agents off model runtimes unless explicitly enabled", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-scripted", "agent-scripted", "Scripted Agent");
    ctx.registerCharacter("acct-hybrid", "agent-hybrid", "Hybrid Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const ensureChatRuntime = vi
      .spyOn(
        manager as unknown as {
          ensureChatRuntime(characterId: string): Promise<unknown>;
        },
        "ensureChatRuntime",
      )
      .mockResolvedValue(null);

    try {
      await manager.createAgent({
        characterId: "agent-scripted",
        accountId: "acct-scripted",
        name: "Scripted Agent",
        scriptedRole: "combat",
        autoStart: true,
      });

      expect(ensureChatRuntime).not.toHaveBeenCalled();
      expect(manager.getAgentInfo("agent-scripted")?.llmEnabled).toBe(false);

      await manager.createAgent({
        characterId: "agent-hybrid",
        accountId: "acct-hybrid",
        name: "Hybrid Agent",
        scriptedRole: "combat",
        enableLlm: true,
        autoStart: false,
      });
      expect(manager.getAgentInfo("agent-hybrid")?.llmEnabled).toBe(true);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fences pending model output when a chat runtime is stopped or replaced", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-runtime", "agent-runtime", "Runtime Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    await manager.createAgent({
      characterId: "agent-runtime",
      accountId: "acct-runtime",
      name: "Runtime Agent",
      autoStart: false,
    });
    const instance = (manager as any).agents.get("agent-runtime");
    const stop = vi.fn().mockResolvedValue(undefined);
    instance.chatRuntime = { stop };
    instance.chatRuntimeInfo = {
      provider: "test-provider",
      model: "test-model",
      source: "test",
    };
    instance.chatRuntimeConfigSig = "old-runtime";
    instance.pendingLlmResult = { action: { type: "idle" } };
    instance.llmPlan = {
      steps: ["old step"],
      currentStep: 0,
      createdAt: Date.now(),
      goal: "old goal",
    };
    instance.llmOutcomeBuffer = ["fail", "fail"];
    instance.llmCircuitOpenUntil = Date.now() + 60_000;
    const priorBehaviorEpoch = instance.behaviorEpoch;
    const priorRuntimeGeneration = instance.chatRuntimeGeneration;

    await (manager as any).stopChatRuntime("agent-runtime");

    expect(stop).toHaveBeenCalledTimes(1);
    expect(instance.chatRuntime).toBeNull();
    expect(instance.chatRuntimeInfo).toBeNull();
    expect(instance.chatRuntimeConfigSig).toBeUndefined();
    expect(instance.pendingLlmResult).toBeUndefined();
    expect(instance.llmPlan).toBeUndefined();
    expect(instance.llmOutcomeBuffer).toEqual([]);
    expect(instance.llmCircuitOpenUntil).toBeUndefined();
    expect(instance.behaviorEpoch).toBe(priorBehaviorEpoch + 1);
    expect(instance.chatRuntimeGeneration).toBe(priorRuntimeGeneration + 1);

    await forceTestShutdown(manager);
  });

  it("recovers agents from stale dead-loop state outside active streaming duel", async () => {
    const terrainHeight = 9;
    const ctx = createMockWorld(terrainHeight);
    ctx.registerCharacter("acct-4", "agent-loop", "Loop Agent");
    ctx.addResource("resource-tree", [2, terrainHeight + 0.1, 0], "tree");

    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-loop",
        accountId: "acct-4",
        name: "Loop Agent",
        scriptedRole: "woodcutting",
        autoStart: true,
      });

      await Promise.resolve();
      await Promise.resolve();

      const agent = ctx.entities.get("agent-loop");
      expect(agent).toBeDefined();

      agent!.data.health = 0;
      agent!.data.deathState = DeathState.DYING;
      agent!.data.isDead = true;
      agent!.data.inCombat = true;
      agent!.data.combatTarget = "mob-goblin";
      agent!.data.inStreamingDuel = true;
      agent!.data.preventRespawn = true;

      await manager.executeBehaviorTick("agent-loop");

      expect(agent!.data.health).toBe(agent!.data.maxHealth);
      expect(agent!.data.deathState).toBe(DeathState.ALIVE);
      expect(agent!.data.isDead).toBe(false);
      expect(agent!.data.inStreamingDuel).toBe(false);
      expect(agent!.data.preventRespawn).toBe(false);
      expect(agent!.data.inCombat).toBe(false);
      expect(agent!.data.combatTarget).toBeNull();
      expect(agent!.data.position[1]).toBeCloseTo(terrainHeight + 0.1, 5);
      expect(
        isPositionInsideCombatArena(
          agent!.data.position[0],
          agent!.data.position[2],
        ),
      ).toBe(false);
      expect(
        Math.hypot(agent!.data.position[0], agent!.data.position[2]),
      ).toBeLessThanOrEqual(8);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("teleports non-dueling agents out of combat arena tiles", async () => {
    const terrainHeight = 9;
    const ctx = createMockWorld(terrainHeight);
    ctx.registerCharacter("acct-5", "agent-out", "Outside Agent");

    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-out",
        accountId: "acct-5",
        name: "Outside Agent",
        scriptedRole: "combat",
        autoStart: true,
      });

      await Promise.resolve();
      await Promise.resolve();

      const agent = ctx.entities.get("agent-out");
      expect(agent).toBeDefined();

      // Place agent inside arena 1 while not in a duel.
      const arena = getDuelArenaConfig();
      agent!.data.position = [
        arena.baseX + arena.arenaWidth / 2,
        terrainHeight + 0.1,
        arena.baseZ + arena.arenaLength / 2,
      ];
      agent!.data.inStreamingDuel = false;
      agent!.data.preventRespawn = false;

      await manager.executeBehaviorTick("agent-out");

      expect(
        isPositionInsideCombatArena(
          agent!.data.position[0],
          agent!.data.position[2],
        ),
      ).toBe(false);
      expect(agent!.data._teleport).toBe(true);
      expect(agent!.data.inStreamingDuel).toBe(false);
      expect(agent!.data.preventRespawn).toBe(false);

      // Ejected agents should remain near the starter area, away from arenas.
      expect(
        Math.hypot(agent!.data.position[0], agent!.data.position[2]),
      ).toBeLessThanOrEqual(8);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("automatically opens only the selected agent's private preparation bank", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-prep", "agent-prep", "Prepared Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-prep",
        accountId: "acct-prep",
        name: "Prepared Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-prep");
      const open = vi
        .spyOn(instance.service, "executeDuelPreparationBankOpen")
        .mockResolvedValue({
          success: true,
          operationId: "f9771187-7443-4612-bf51-f2db8903dd77",
          commitState: "not_applicable",
          replayed: false,
          action: "open",
          playerId: "agent-prep",
          bankId: "duel-preparation:3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
          itemId: null,
          requestedQuantity: 0,
          committedQuantity: 0,
          inventoryQuantityAfter: null,
          bankQuantityAfter: null,
          bankItems: [
            { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
          ],
        });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-prep",
        agent1Name: "Prepared Agent",
        agent2Id: "agent-opponent",
        agent2Name: "Opponent",
      });

      expect(open).toHaveBeenCalledWith("3c477a8d-ae92-4a0e-88ec-7b6fa779e761");
      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(atomicPlan.mock.calls[0][0]).toMatchObject({
        preparationId: "3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expectedBank: [
          { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
        ],
        committed: {
          bank: [],
          inventory: [],
          equipment: [
            {
              slotType: "weapon",
              itemId: "test_prep_sword",
              quantity: 1,
            },
          ],
          selectedSpell: null,
        },
      });
      expect(instance.goal).toMatchObject({
        type: "banking",
        description: "Prepare a legal duel loadout against Opponent",
      });
      expect(instance.duelPreparation).toMatchObject({
        status: "planning",
        opponentId: "agent-opponent",
        bankItems: [],
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({
          agentId: "agent-prep",
          preparationId: "3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
        }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_bank_status",
        expect.objectContaining({
          agentId: "agent-prep",
          success: true,
        }),
      );
      expect(ctx.combatPreparationFences.get("agent-prep")).toBe(
        "3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
      );
      (manager as any).duelPreparationReadinessListener({
        preparationId: "3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
        agentId: "agent-prep",
      });
      expect(ctx.combatPreparationFences.get("agent-prep")).toBe(
        "3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
      );
      (manager as any).duelPreparationTerminalListener({
        preparationId: "3c477a8d-ae92-4a0e-88ec-7b6fa779e761",
      });
      expect(ctx.combatPreparationFences.has("agent-prep")).toBe(false);
      expect(instance.duelPreparation).toBeUndefined();
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("prepares an authenticated external contestant through the same atomic server-owned plan", async () => {
    const ctx = createMockWorld(9);
    const agentId = "external-preparation-agent";
    ctx.world.entities.add({
      id: agentId,
      type: "player",
      userId: "external-account",
      name: "External Preparation Agent",
      position: [0, 9, 0],
      health: 20,
      maxHealth: 20,
      skills: {
        attack: { level: 10, xp: 0 },
        strength: { level: 10, xp: 0 },
        defense: { level: 10, xp: 0 },
        constitution: { level: 20, xp: 0 },
        ranged: { level: 1, xp: 0 },
        magic: { level: 1, xp: 0 },
        prayer: { level: 1, xp: 0 },
      },
    });
    const bankOpen = vi
      .spyOn(EmbeddedHyperiaService.prototype, "executeDuelPreparationBankOpen")
      .mockResolvedValue({
        success: true,
        operationId: "b4d6da8b-4369-44f7-bf03-0a3a69a9a8d5",
        commitState: "not_applicable",
        replayed: false,
        action: "open",
        playerId: agentId,
        bankId: "duel-preparation:ba31b909-d6ed-40a8-b389-2a2497248ef1",
        itemId: null,
        requestedQuantity: 0,
        committedQuantity: 0,
        inventoryQuantityAfter: null,
        bankQuantityAfter: null,
        bankItems: [
          { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
        ],
      });
    const recoverPlan = vi
      .spyOn(
        EmbeddedHyperiaService.prototype,
        "executeDuelPreparationPlanRecovery",
      )
      .mockResolvedValue(null);
    vi.spyOn(EmbeddedHyperiaService.prototype, "getGameState").mockReturnValue({
      playerId: agentId,
      position: [0, 9, 0],
      health: 20,
      maxHealth: 20,
      alive: true,
      skills: {
        attack: { level: 10, xp: 0 },
        strength: { level: 10, xp: 0 },
        defense: { level: 10, xp: 0 },
        constitution: { level: 20, xp: 0 },
        ranged: { level: 1, xp: 0 },
        magic: { level: 1, xp: 0 },
        prayer: { level: 1, xp: 0 },
      },
      inventory: [],
      equipment: {},
      nearbyEntities: [],
      inCombat: false,
      currentTarget: null,
      selectedSpell: null,
      activePrayers: [],
      prayerPointUnits: 0,
    });
    const depositAll = vi.spyOn(
      EmbeddedHyperiaService.prototype,
      "executeBankDepositAll",
    );
    const withdraw = vi.spyOn(
      EmbeddedHyperiaService.prototype,
      "executeBankWithdraw",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      const preparationId = "ba31b909-d6ed-40a8-b389-2a2497248ef1";
      await (manager as any).handleDuelPreparationSelected({
        preparationId,
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: agentId,
        agent1Name: "External Preparation Agent",
        agent2Id: "external-opponent",
        agent2Name: "External Opponent",
      });
      await (manager as any).startExternalDuelPreparation(
        preparationId,
        agentId,
        externalPreparationHostOwnerId,
        externalPreparationExecutableBuildId,
      );

      expect(bankOpen).toHaveBeenCalledWith(preparationId);
      expect(depositAll).not.toHaveBeenCalled();
      expect(withdraw).not.toHaveBeenCalled();
      expect(manager.hasAgent(agentId)).toBe(false);
      expect(manager.getAgentService(agentId)).toBeInstanceOf(
        EmbeddedHyperiaService,
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ preparationId, agentId }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          preparationId,
          agentId,
          status: "ready_for_validation",
          planningSource: "deterministic",
        }),
      );

      const atomicPlan = vi.mocked(
        EmbeddedHyperiaService.prototype.executeDuelPreparationPlan,
      );
      const committedRequest = atomicPlan.mock.calls[0]![0];
      recoverPlan.mockResolvedValue({
        ok: true,
        playerId: agentId,
        operationId: committedRequest.operationId,
        preparationId,
        requestFingerprint: "test-atomic-plan-fingerprint",
        changed: false,
        replayed: true,
        committed: committedRequest.committed,
        recoveryEvidence: committedRequest.recoveryEvidence,
      });
      await (manager as any).startExternalDuelPreparation(
        preparationId,
        agentId,
        externalPreparationHostOwnerId,
        externalPreparationExecutableBuildId,
      );

      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(recoverPlan).toHaveBeenCalledTimes(2);
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          preparationId,
          agentId,
          atomicPlanReplayed: true,
          recoveredCommittedPlan: true,
        }),
      );
      (manager as any).externalPlayerLeftListener({
        playerId: agentId,
        reconnectGraceActive: true,
        reconnectGraceExpiresAt: Date.now() + 30_000,
      });
      expect(manager.getAgentService(agentId)).toBeNull();
      expect(ctx.entities.has(agentId)).toBe(true);
      expect(
        (manager as any).pendingExternalDuelPreparations.has(
          `${preparationId}\u0000${agentId}`,
        ),
      ).toBe(true);

      await (manager as any).startExternalDuelPreparation(
        preparationId,
        agentId,
        externalPreparationHostOwnerId,
        externalPreparationExecutableBuildId,
      );

      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(recoverPlan).toHaveBeenCalledTimes(3);
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          preparationId,
          agentId,
          atomicPlanReplayed: true,
          recoveredCommittedPlan: true,
        }),
      );

      (manager as any).externalPlayerLeftListener({ playerId: agentId });
      expect(manager.getAgentService(agentId)).toBeNull();
      expect(
        (manager as any).pendingExternalDuelPreparations.has(
          `${preparationId}\u0000${agentId}`,
        ),
      ).toBe(false);
    } finally {
      await forceTestShutdown(manager);
      expect(ctx.entities.has(agentId)).toBe(true);
    }
  });

  it("fences an in-flight external strategy during reconnect grace while preserving its exact assignment", async () => {
    const ctx = createMockWorld(9);
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const preparationId = "9a7cf8be-b1b5-47bf-96c7-788564be22e7";
    const agentId = "external-reconnect-agent";
    const key = `${preparationId}\u0000${agentId}`;
    const revokeDuelPreparationBankAccess = vi.fn();
    const endDuelPreparationCombatFence = vi.fn();
    const detachExistingPlayer = vi.fn();
    const resolveStrategy = vi.fn();
    const strategyTimer = setTimeout(() => undefined, 60_000);
    const context = {
      config: {
        characterId: agentId,
        accountId: "external-reconnect-account",
        name: "External Reconnect Agent",
        enableLlm: false,
      },
      service: {
        revokeDuelPreparationBankAccess,
        endDuelPreparationCombatFence,
        detachExistingPlayer,
      },
      chatRuntime: null,
      duelPreparation: {
        preparationId,
        status: "planning",
      },
      goal: null,
    };
    (manager as any).externalCompetitiveAgents.set(agentId, {
      context,
      authenticatedExternalDecision: false,
      hostOwnerId: externalPreparationHostOwnerId,
      executableBuildId: externalPreparationExecutableBuildId,
    });
    (manager as any).pendingExternalDuelPreparations.set(key, {
      preparationId,
      agentId,
      opponentId: "external-reconnect-opponent",
      opponentName: "External Reconnect Opponent",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      alreadyReady: false,
      opponentHistory: [],
    });
    (manager as any).pendingExternalDuelPreparationStrategies.set(
      "reconnect-request",
      {
        preparationId,
        agentId,
        decisionDeadlineAt: Date.now() + 30_000,
        preparationOptions: [],
        foodOptions: [],
        armorOptions: [],
        availablePrayerIds: [],
        resolve: resolveStrategy,
        timer: strategyTimer,
      },
    );
    (manager as any).externalDuelPreparationStarts.set(
      key,
      new Promise<void>(() => undefined),
    );

    try {
      (manager as any).externalPlayerLeftListener({
        playerId: agentId,
        reconnectGraceActive: true,
        reconnectGraceExpiresAt: Date.now() + 30_000,
      });

      expect(resolveStrategy).toHaveBeenCalledOnce();
      expect(resolveStrategy).toHaveBeenCalledWith(null);
      expect(revokeDuelPreparationBankAccess).toHaveBeenCalledWith(
        preparationId,
      );
      expect(endDuelPreparationCombatFence).toHaveBeenCalledWith(preparationId);
      expect(detachExistingPlayer).toHaveBeenCalledOnce();
      expect(context.duelPreparation).toBeUndefined();
      expect((manager as any).externalCompetitiveAgents.has(agentId)).toBe(
        false,
      );
      expect(
        (manager as any).pendingExternalDuelPreparationStrategies.has(
          "reconnect-request",
        ),
      ).toBe(false);
      expect((manager as any).externalDuelPreparationStarts.has(key)).toBe(
        false,
      );
      expect((manager as any).pendingExternalDuelPreparations.has(key)).toBe(
        true,
      );

      (manager as any).externalPlayerLeftListener({ playerId: agentId });
      expect((manager as any).pendingExternalDuelPreparations.has(key)).toBe(
        false,
      );
    } finally {
      clearTimeout(strategyTimer);
      await forceTestShutdown(manager);
    }
  });

  it("freezes an authenticated external ElizaOS choice of a second-ranked owned plan without exposing custody", async () => {
    const ctx = createMockWorld(9);
    const agentId = "external-model-preparation-agent";
    ctx.world.entities.add({
      id: agentId,
      type: "player",
      userId: "external-model-account",
      name: "External Model Preparation Agent",
      position: [0, 9, 0],
      health: 20,
      maxHealth: 20,
      skills: {
        attack: { level: 10, xp: 0 },
        strength: { level: 10, xp: 0 },
        defense: { level: 10, xp: 0 },
        constitution: { level: 20, xp: 0 },
        ranged: { level: 10, xp: 0 },
        magic: { level: 1, xp: 0 },
        prayer: { level: 1, xp: 0 },
      },
    });
    vi.spyOn(
      EmbeddedHyperiaService.prototype,
      "executeDuelPreparationBankOpen",
    ).mockResolvedValue({
      success: true,
      operationId: "77777777-7777-4777-8777-777777777777",
      commitState: "not_applicable",
      replayed: false,
      action: "open",
      playerId: agentId,
      bankId: "duel-preparation:88888888-8888-4888-8888-888888888888",
      itemId: null,
      requestedQuantity: 0,
      committedQuantity: 0,
      inventoryQuantityAfter: null,
      bankQuantityAfter: null,
      bankItems: [
        { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
        {
          itemId: "test_prep_reserve_sword",
          quantity: 1,
          slot: 1,
          tabIndex: 0,
        },
        { itemId: "shortbow", quantity: 1, slot: 2, tabIndex: 0 },
        { itemId: "bronze_arrow", quantity: 20, slot: 3, tabIndex: 0 },
        { itemId: "lobster", quantity: 4, slot: 4, tabIndex: 0 },
        { itemId: "test_prep_food", quantity: 4, slot: 5, tabIndex: 0 },
        {
          itemId: "test_prep_melee_offense_body",
          quantity: 1,
          slot: 6,
          tabIndex: 0,
        },
        {
          itemId: "test_prep_melee_body",
          quantity: 1,
          slot: 7,
          tabIndex: 0,
        },
      ],
    });
    vi.spyOn(
      EmbeddedHyperiaService.prototype,
      "executeDuelPreparationPlanRecovery",
    ).mockResolvedValue(null);
    vi.spyOn(EmbeddedHyperiaService.prototype, "getGameState").mockReturnValue({
      playerId: agentId,
      position: [0, 9, 0],
      health: 20,
      maxHealth: 20,
      alive: true,
      skills: {
        attack: { level: 10, xp: 0 },
        strength: { level: 10, xp: 0 },
        defense: { level: 10, xp: 0 },
        constitution: { level: 20, xp: 0 },
        ranged: { level: 10, xp: 0 },
        magic: { level: 1, xp: 0 },
        prayer: { level: 1, xp: 0 },
      },
      inventory: [],
      equipment: {},
      nearbyEntities: [],
      inCombat: false,
      currentTarget: null,
      selectedSpell: null,
      activePrayers: [],
      prayerPointUnits: 0,
    });
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    vi.spyOn(manager as any, "getAutonomyPersistenceAccess").mockReturnValue({
      db: {},
      pool: {},
    });
    const bindStrategyContext = vi
      .spyOn(PostgresDuelPreparationStore.prototype, "bindStrategyContext")
      .mockImplementation(async (input) => ({
        ...input,
        agentName: "Persisted External Agent",
        opponentName: "Persisted External Opponent",
        ownPublicProfile: {
          narrative: "Patient preparation specialist.",
          pillars: ["adaptation"],
        },
        opponentPublicProfile: {
          narrative: "Public ranged specialist.",
          pillars: ["spacing"],
        },
        boundAt: Date.now(),
      }));
    ctx.world.emit.mockImplementation((event: string, payload: unknown) => {
      if (event !== "duel:preparation:external_strategy_request") return;
      const request = payload as {
        agentId: string;
        requestId: string;
        preparationId: string;
        preparationOptions: Array<{
          planOptionId: string;
          primaryStyle: "melee" | "ranged" | "mage";
          styleRank: number;
        }>;
        foodOptions: Array<{
          foodOptionId: string;
          recoveryRank: number;
          quantity: number;
        }>;
        armorOptions: Array<{
          armorOptionId: string;
          planOptionId: string;
          offenseRank: number;
          focusedDefenseRank: number | null;
          totalDefenseRank: number;
        }>;
      };
      const selectedOption = request.preparationOptions.find(
        (option) => option.primaryStyle === "melee" && option.styleRank === 2,
      )!;
      const selectedFoodOption = request.foodOptions.find(
        (option) => option.recoveryRank === 2,
      )!;
      const selectedArmorOption = request.armorOptions.find(
        (option) =>
          option.planOptionId === selectedOption.planOptionId &&
          option.totalDefenseRank === 1,
      )!;
      (manager as any).duelPreparationExternalStrategyResponseListener({
        agentId: request.agentId,
        requestId: request.requestId,
        preparationId: request.preparationId,
        status: "selected",
        decision: {
          armorOptionId: selectedArmorOption.armorOptionId,
          planOptionId: selectedOption.planOptionId,
          foodOptionId: selectedFoodOption.foodOptionId,
          primaryStyle: "melee",
          reason: "Use the reserve one-handed plan and keep the shield option.",
          tacticalStrategy: {
            approach: "balanced",
            tacticalMacro: "pressure",
            attackStyle: "controlled",
            prayer: null,
            preferredCombatRole: "melee",
            foodThreshold: 40,
            switchDefensiveAt: 30,
            reasoning: "Preserve the option to use a shield while pressuring.",
          },
        },
      });
    });
    try {
      const preparationId = "88888888-8888-4888-8888-888888888888";
      await (manager as any).handleDuelPreparationSelected({
        preparationId,
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: agentId,
        agent1Name: "External Model Preparation Agent",
        agent2Id: "external-model-opponent",
        agent2Name: "External Model Opponent",
        agent1OpponentHistory: [
          {
            cycleId: "external-prior-melee-cycle",
            finishedAt: Date.now() - 1_000,
            result: "loss",
            ownOpeningStyle: "ranged",
            opponentOpeningStyle: "melee",
            ownDamage: 8,
            opponentDamage: 20,
            winReason: "kill",
          },
        ],
      });
      await (manager as any).startExternalDuelPreparation(
        preparationId,
        agentId,
        externalPreparationHostOwnerId,
        externalPreparationExecutableBuildId,
      );

      const requestCall = ctx.world.emit.mock.calls.find(
        ([event]) => event === "duel:preparation:external_strategy_request",
      );
      expect(requestCall?.[1]).toMatchObject({
        agentId,
        preparationId,
        agentName: "Persisted External Agent",
        opponentName: "Persisted External Opponent",
        ownPublicProfile: {
          narrative: "Patient preparation specialist.",
          pillars: ["adaptation"],
        },
        opponentPublicProfile: {
          narrative: "Public ranged specialist.",
          pillars: ["spacing"],
        },
        availableRoles: ["melee", "ranged"],
        deterministicRole: "melee",
      });
      expect(bindStrategyContext).toHaveBeenCalledWith(
        expect.objectContaining({
          preparationId,
          agentId,
          hostOwnerId: externalPreparationHostOwnerId,
          policyVersion: "duel-preparation-role-v3",
          protocolVersion: "external-duel-preparation-strategy-v5",
          opponentHistorySummary: {
            sampleSize: 1,
            observedOpponentOpeningStyleFocus: "melee",
            recent: [
              {
                result: "loss",
                ownOpeningStyle: "ranged",
                opponentOpeningStyle: "melee",
                winReason: "kill",
              },
            ],
          },
        }),
      );
      expect(
        JSON.stringify(bindStrategyContext.mock.calls[0]?.[0]),
      ).not.toMatch(
        /bankItems|itemId|quantity|wallet|cycleId|finishedAt|ownDamage|opponentDamage/iu,
      );
      const requestOptions = (requestCall?.[1] as any).preparationOptions;
      const requestFoodOptions = (requestCall?.[1] as any).foodOptions;
      const requestArmorOptions = (requestCall?.[1] as any).armorOptions;
      const selectedRequestOption = requestOptions.find(
        (option: { primaryStyle: string; styleRank: number }) =>
          option.primaryStyle === "melee" && option.styleRank === 2,
      );
      const selectedRequestFoodOption = requestFoodOptions.find(
        (option: { recoveryRank: number }) => option.recoveryRank === 2,
      );
      const selectedRequestArmorOption = requestArmorOptions.find(
        (option: { planOptionId: string; totalDefenseRank: number }) =>
          option.planOptionId === selectedRequestOption.planOptionId &&
          option.totalDefenseRank === 1,
      );
      expect(selectedRequestOption).toBeDefined();
      expect(selectedRequestFoodOption).toBeDefined();
      expect(selectedRequestArmorOption).toBeDefined();
      expect(requestOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            primaryStyle: "melee",
            styleRank: 1,
            attackSupplyUnits: null,
          }),
          expect.objectContaining({
            primaryStyle: "melee",
            styleRank: 2,
            attackSupplyUnits: null,
          }),
          expect.objectContaining({
            primaryStyle: "ranged",
            styleRank: 1,
            attackSupplyUnits: 20,
          }),
        ]),
      );
      expect(requestFoodOptions).toEqual([
        expect.objectContaining({ recoveryRank: 1, quantity: 2 }),
        expect.objectContaining({ recoveryRank: 2, quantity: 4 }),
      ]);
      expect(requestArmorOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            planOptionId: selectedRequestOption.planOptionId,
            offenseRank: 1,
            focusedDefenseRank: 2,
            totalDefenseRank: 2,
          }),
          expect.objectContaining({
            planOptionId: selectedRequestOption.planOptionId,
            offenseRank: 2,
            focusedDefenseRank: 1,
            totalDefenseRank: 1,
          }),
        ]),
      );
      expect(JSON.stringify(requestCall?.[1])).not.toContain("bankItems");
      expect(JSON.stringify(requestCall?.[1])).not.toContain("private");
      expect(JSON.stringify(requestCall?.[1])).not.toMatch(
        /cycleId|finishedAt|ownDamage|opponentDamage/iu,
      );

      const plan = vi
        .mocked(EmbeddedHyperiaService.prototype.executeDuelPreparationPlan)
        .mock.calls.at(-1)?.[0];
      expect(plan).toBeDefined();
      expect(plan?.recoveryEvidence).toMatchObject({
        primaryStyle: "melee",
        planningSource: "model",
        modelProvider: "external-elizaos",
        model: "authenticated-remote-strategy-v5",
        decisionOutcome: "model_selected",
        selectedPlanOptionId: selectedRequestOption.planOptionId,
        selectedPlanStyleRank: 2,
        selectedFoodOptionId: selectedRequestFoodOption.foodOptionId,
        selectedFoodRecoveryRank: 2,
        selectedArmorOptionId: selectedRequestArmorOption.armorOptionId,
        selectedArmorOffenseRank: 2,
        selectedArmorFocusedDefenseRank: 1,
        selectedArmorTotalDefenseRank: 1,
      });
      expect(plan?.committed.selectedSpell).toBeNull();
      expect(
        plan?.committed.equipment.find((item) => item.slotType === "weapon")
          ?.itemId,
      ).toBe("test_prep_reserve_sword");
      expect(
        plan?.committed.equipment.find((item) => item.slotType === "body")
          ?.itemId,
      ).toBe("test_prep_melee_body");
      expect(
        plan?.committed.inventory.filter(
          (item) => item.itemId === "test_prep_food",
        ),
      ).toHaveLength(4);
      expect(
        plan?.committed.inventory.some((item) => item.itemId === "lobster"),
      ).toBe(false);
      expect(
        manager.getCompetitiveAgentPolicyBinding(
          agentId,
          "duel-preparation-role-v3",
        ),
      ).toMatchObject({
        provider: "external-elizaos",
        model: "authenticated-remote-strategy-v5",
        decisionRuntime: "authenticated_external",
        combatControllerEnabled: true,
      });
    } finally {
      await forceTestShutdown(manager);
      expect(ctx.entities.has(agentId)).toBe(true);
    }
  });

  it("does not ask the external model when immutable strategy context cannot be bound", async () => {
    const ctx = createMockWorld(9);
    const agentId = "external-context-failure-agent";
    const preparationId = "ad740ced-54ea-4c59-a7f5-c844cf79e882";
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const context = {
      config: {
        characterId: agentId,
        accountId: "external-context-failure-account",
        name: "External Context Failure Agent",
        enableLlm: false,
      },
      service: {
        endDuelPreparationCombatFence: vi.fn(),
        detachExistingPlayer: vi.fn(),
      },
      chatRuntime: null,
      duelPreparation: {
        preparationId,
        opponentId: "external-context-failure-opponent",
        opponentName: "External Context Failure Opponent",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        opponentHistory: [],
        status: "planning",
        bankOpenedAt: Date.now(),
        bankItems: [],
        failureReason: null,
        strategy: null,
      },
      goal: null,
    };
    (manager as any).externalCompetitiveAgents.set(agentId, {
      context,
      authenticatedExternalDecision: false,
      hostOwnerId: externalPreparationHostOwnerId,
      executableBuildId: externalPreparationExecutableBuildId,
    });
    vi.spyOn(manager as any, "getAutonomyPersistenceAccess").mockReturnValue({
      db: {},
      pool: {},
    });
    vi.spyOn(
      PostgresDuelPreparationStore.prototype,
      "bindStrategyContext",
    ).mockRejectedValue(new Error("exact host lease expired"));

    try {
      const preparationOptions = [
        {
          planOptionId: "11111111-1111-4111-8111-111111111111",
          primaryStyle: "melee",
          styleRank: 1,
          attackSupplyUnits: null,
          canUseShield: true,
        },
        {
          planOptionId: "22222222-2222-4222-8222-222222222222",
          primaryStyle: "ranged",
          styleRank: 1,
          attackSupplyUnits: 20,
          canUseShield: false,
        },
      ];
      const armorOptions = preparationOptions.map((option, index) => ({
        armorOptionId:
          index === 0
            ? "33333333-3333-4333-8333-333333333333"
            : "44444444-4444-4444-8444-444444444444",
        planOptionId: option.planOptionId,
        offenseRank: 1,
        focusedDefenseRank: null,
        totalDefenseRank: 1,
      }));
      await expect(
        (manager as any).chooseExternalDuelPreparationPlan({
          instance: context,
          preparation: context.duelPreparation,
          availableRoles: ["melee", "ranged"],
          availablePrayerIds: [],
          preparationOptions,
          foodOptions: [],
          armorOptions,
          deterministicPlanOptionId: preparationOptions[0].planOptionId,
          deterministicFoodOptionId: null,
          deterministicArmorOptionId: armorOptions[0].armorOptionId,
          deterministicRole: "melee",
          ownPublicVision: null,
          opponentPublicVision: null,
        }),
      ).resolves.toMatchObject({
        planOptionId: preparationOptions[0].planOptionId,
        primaryStyle: "melee",
        source: "deterministic",
        decisionOutcome: "deterministic_runtime_unavailable",
      });
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:external_strategy_request",
        expect.anything(),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("times out an external strategy request to one deterministic fallback and ignores a late replay", async () => {
    const ctx = createMockWorld(9);
    const agentId = "external-timeout-agent";
    const preparationId = "99999999-9999-4999-8999-999999999999";
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const context = {
      config: {
        characterId: agentId,
        accountId: "external-timeout-account",
        name: "External Timeout Agent",
        enableLlm: false,
      },
      service: {
        endDuelPreparationCombatFence: vi.fn(),
        detachExistingPlayer: vi.fn(),
      },
      chatRuntime: null,
      duelPreparation: {
        preparationId,
        opponentId: "external-timeout-opponent",
        opponentName: "External Timeout Opponent",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        opponentHistory: [],
        status: "planning",
        bankOpenedAt: Date.now(),
        bankItems: [],
        failureReason: null,
        strategy: null,
      },
      goal: null,
    };
    (manager as any).externalCompetitiveAgents.set(agentId, {
      context,
      authenticatedExternalDecision: false,
      hostOwnerId: null,
      executableBuildId: externalPreparationExecutableBuildId,
    });

    try {
      const preparationOptions = [
        {
          planOptionId: "11111111-1111-4111-8111-111111111111",
          primaryStyle: "melee",
          styleRank: 1,
          attackSupplyUnits: null,
          canUseShield: true,
        },
        {
          planOptionId: "22222222-2222-4222-8222-222222222222",
          primaryStyle: "ranged",
          styleRank: 1,
          attackSupplyUnits: 20,
          canUseShield: false,
        },
      ];
      const armorOptions = preparationOptions.map((option, index) => ({
        armorOptionId:
          index === 0
            ? "33333333-3333-4333-8333-333333333333"
            : "44444444-4444-4444-8444-444444444444",
        planOptionId: option.planOptionId,
        offenseRank: 1,
        focusedDefenseRank: null,
        totalDefenseRank: 1,
      }));
      const resultPromise = (manager as any).chooseExternalDuelPreparationPlan({
        instance: context,
        preparation: context.duelPreparation,
        availableRoles: ["melee", "ranged"],
        availablePrayerIds: [],
        preparationOptions,
        foodOptions: [],
        armorOptions,
        deterministicPlanOptionId: preparationOptions[0].planOptionId,
        deterministicFoodOptionId: null,
        deterministicArmorOptionId: armorOptions[0].armorOptionId,
        deterministicRole: "melee",
        ownPublicVision: null,
        opponentPublicVision: null,
      });
      const request = ctx.world.emit.mock.calls.find(
        ([event]) => event === "duel:preparation:external_strategy_request",
      )?.[1] as {
        requestId: string;
        preparationId: string;
        decisionDeadlineAt: number;
      };
      expect(request).toMatchObject({ preparationId });

      vi.setSystemTime(request.decisionDeadlineAt);
      (manager as any).duelPreparationExternalStrategyResponseListener({
        agentId,
        requestId: request.requestId,
        preparationId,
        status: "selected",
        decision: {
          armorOptionId: armorOptions[1].armorOptionId,
          planOptionId: preparationOptions[1].planOptionId,
          foodOptionId: null,
          primaryStyle: "ranged",
          reason: "Boundary replay.",
          tacticalStrategy: {
            approach: "balanced",
            tacticalMacro: "kite",
            attackStyle: "accurate",
            prayer: null,
            preferredCombatRole: "ranged",
            foodThreshold: 40,
            switchDefensiveAt: 30,
            reasoning: "This response arrived at the exact deadline.",
          },
        },
      });
      await expect(resultPromise).resolves.toMatchObject({
        primaryStyle: "melee",
        source: "deterministic",
        decisionOutcome: "deterministic_model_failed",
      });
      expect(
        (manager as any).pendingExternalDuelPreparationStrategies.size,
      ).toBe(0);

      (manager as any).duelPreparationExternalStrategyResponseListener({
        agentId,
        requestId: request.requestId,
        preparationId,
        status: "selected",
        decision: {
          armorOptionId: armorOptions[1].armorOptionId,
          planOptionId: preparationOptions[1].planOptionId,
          foodOptionId: null,
          primaryStyle: "ranged",
          reason: "Late replay.",
          tacticalStrategy: {
            approach: "balanced",
            tacticalMacro: "kite",
            attackStyle: "accurate",
            prayer: null,
            preferredCombatRole: "ranged",
            foodThreshold: 40,
            switchDefensiveAt: 30,
            reasoning: "This response arrived after the deadline.",
          },
        },
      });
      expect(
        (manager as any).externalCompetitiveAgents.get(agentId)
          .authenticatedExternalDecision,
      ).toBe(false);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("drains an ordinary equipment action before opening private preparation custody", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-fenced", "agent-fenced", "Fenced Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-fenced",
        accountId: "acct-fenced",
        name: "Fenced Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-fenced");
      const bridge = (manager as any).behaviorBridge;
      let finishEquip!: () => void;
      const equipPending = new Promise<any>((resolve) => {
        finishEquip = () =>
          resolve({
            ok: true,
            playerId: "agent-fenced",
            itemId: "ordinary_sword",
            slot: "weapon",
            changed: true,
          });
      });
      const equip = vi
        .spyOn(instance.service, "executeEquip")
        .mockImplementation(() => equipPending);
      const open = vi
        .spyOn(instance.service, "executeDuelPreparationBankOpen")
        .mockResolvedValue({ success: true, bankItems: [] });

      const applyPromise = bridge.applyTickResultWithDrain({
        characterId: "agent-fenced",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "equip", itemId: "ordinary_sword" },
        updatedState: {
          goal: { type: "exploring", description: "Ordinary exploration" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });
      await vi.waitFor(() => expect(equip).toHaveBeenCalledTimes(1));

      const preparationPromise = (manager as any).handleDuelPreparationSelected(
        {
          preparationId: "11a64a30-58d8-430c-b52c-19c9761804af",
          selectedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          agent1Id: "agent-fenced",
          agent1Name: "Fenced Agent",
          agent2Id: "agent-opponent",
          agent2Name: "Opponent",
        },
      );

      await vi.waitFor(() =>
        expect(instance.duelPreparation?.preparationId).toBe(
          "11a64a30-58d8-430c-b52c-19c9761804af",
        ),
      );
      expect(instance.behaviorEpoch).toBe(1);
      expect(open).not.toHaveBeenCalled();

      finishEquip();
      await applyPromise;
      await preparationPromise;

      expect(open).toHaveBeenCalledWith("11a64a30-58d8-430c-b52c-19c9761804af");
      expect(instance.goal).toMatchObject({ type: "banking" });
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("advances the food cooldown only after an authoritative consumption receipt", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-food-truth", "agent-food-truth", "Food Truth");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-food-truth",
        accountId: "acct-food-truth",
        name: "Food Truth",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-food-truth");
      const bridge = (manager as any).behaviorBridge;
      const foodId = Array.from(ITEMS.entries()).find(
        ([, item]) =>
          typeof (item as { healAmount?: unknown }).healAmount === "number" &&
          Number((item as { healAmount: number }).healAmount) > 0,
      )?.[0];
      expect(foodId).toBeDefined();
      instance.lastAteAt = 100;
      const use = vi
        .spyOn(instance.service, "executeUse")
        .mockResolvedValueOnce({ ok: false } as never)
        .mockResolvedValueOnce({ ok: true } as never);
      const makeResult = () => ({
        characterId: "agent-food-truth",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "use" as const, itemId: foodId! },
        updatedState: {
          goal: { type: "combat" as const, description: "Train safely" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      await bridge.applyTickResultWithDrain(makeResult());
      expect(use).toHaveBeenCalledTimes(1);
      expect(instance.lastAteAt).toBe(100);

      const successfulAttemptStartedAt = Date.now();
      await bridge.applyTickResultWithDrain(makeResult());
      expect(use).toHaveBeenCalledTimes(2);
      expect(instance.lastAteAt).toBeGreaterThanOrEqual(
        successfulAttemptStartedAt,
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("advances processing activity only after authoritative completion", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-processing", "agent-processing", "Processor");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-processing",
        accountId: "acct-processing",
        name: "Processor",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-processing");
      const bridge = (manager as any).behaviorBridge;
      instance.lastActivity = 100;
      let attemptSequence = 0;
      bridge.beginAutonomyProgressionAttempt = vi.fn(
        async (
          _candidate: unknown,
          actionType: "smelt",
          decisionSource: "llm" | "scripted",
        ) => {
          attemptSequence += 1;
          return {
            attemptId: `11111111-1111-4111-8111-${String(attemptSequence).padStart(12, "0")}`,
            characterId: "agent-processing",
            phase: "ordinary_progression",
            goalType: "smithing",
            actionType,
            decisionSource,
            startedAt: 100 + attemptSequence,
          };
        },
      );
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;
      const smelt = vi
        .spyOn(instance.service, "executeSmelt")
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("processing subsystem unavailable"));
      const result = {
        characterId: "agent-processing",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "smelt", recipe: "bronze_bar" },
        updatedState: {
          goal: { type: "smithing", description: "Smelt bronze" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      };

      await bridge.applyTickResultWithDrain(result);
      expect(smelt).toHaveBeenCalledTimes(1);
      expect(smelt).toHaveBeenNthCalledWith(
        1,
        "bronze_bar",
        "11111111-1111-4111-8111-000000000001",
      );
      expect(instance.lastActivity).toBe(100);
      expect(persist).toHaveBeenNthCalledWith(
        1,
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: null,
          outcome: "rejected",
        },
        expect.objectContaining({
          attemptId: "11111111-1111-4111-8111-000000000001",
        }),
      );
      expect(instance.ordinaryProcessingRetries).toEqual([
        expect.objectContaining({
          actionType: "smelt",
          intentId: "bronze_bar",
          consecutiveFailures: 1,
        }),
      ]);

      // A stale worker/model result cannot replay the exact rejection while
      // its technical cooldown is active.
      await bridge.applyTickResultWithDrain(result);
      expect(smelt).toHaveBeenCalledTimes(1);
      expect(instance.lastActivity).toBe(100);
      expect(persist).toHaveBeenNthCalledWith(2, instance, {
        attemptedActionType: "idle",
        appliedActionType: null,
        outcome: "idle",
      });

      instance.ordinaryProcessingRetries[0].retryAfter = Date.now() - 1;
      await bridge.applyTickResultWithDrain(result);
      expect(smelt).toHaveBeenCalledTimes(2);
      expect(instance.lastActivity).toBeGreaterThan(100);
      expect(persist).toHaveBeenNthCalledWith(
        3,
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: "smelt",
          outcome: "completed",
        },
        expect.objectContaining({
          attemptId: "11111111-1111-4111-8111-000000000002",
        }),
      );
      expect(instance.ordinaryProcessingRetries).toEqual([]);

      const lastSuccessfulActivity = instance.lastActivity;
      await bridge.applyTickResultWithDrain(result);
      expect(smelt).toHaveBeenCalledTimes(3);
      expect(instance.lastActivity).toBe(lastSuccessfulActivity);
      expect(persist).toHaveBeenNthCalledWith(
        4,
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: null,
          outcome: "failed",
        },
        expect.objectContaining({
          attemptId: "11111111-1111-4111-8111-000000000003",
        }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("checkpoints ordinary autonomy only after the action dispatch returns", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-checkpoint",
      "agent-checkpoint",
      "Checkpoint Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-checkpoint",
        accountId: "acct-checkpoint",
        name: "Checkpoint Agent",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-checkpoint");
      const bridge = (manager as any).behaviorBridge;
      const attempt = {
        attemptId: "22222222-2222-4222-8222-222222222222",
        characterId: "agent-checkpoint",
        phase: "ordinary_progression",
        goalType: "smithing",
        actionType: "smelt",
        decisionSource: "scripted",
        startedAt: 200,
      };
      bridge.beginAutonomyProgressionAttempt = vi
        .fn()
        .mockResolvedValue(attempt);
      let finishSmelt!: () => void;
      const smeltPending = new Promise<boolean>((resolve) => {
        finishSmelt = () => resolve(true);
      });
      vi.spyOn(instance.service, "executeSmelt").mockReturnValue(smeltPending);
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;

      const apply = bridge.applyTickResultWithDrain({
        characterId: "agent-checkpoint",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "smelt", recipe: "bronze_bar" },
        updatedState: {
          goal: { type: "smithing", description: "Smelt bronze" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      await Promise.resolve();
      expect(persist).not.toHaveBeenCalled();
      finishSmelt();
      await apply;
      expect(persist).toHaveBeenCalledOnce();
      expect(persist).toHaveBeenCalledWith(
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: "smelt",
          outcome: "completed",
        },
        attempt,
      );
      expect(instance.service.executeSmelt).toHaveBeenCalledWith(
        "bronze_bar",
        attempt.attemptId,
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("binds gravestone custody to the tracked attempt and waits for completion", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-grave-recovery",
      "agent-grave-recovery",
      "Grave Recovery",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-grave-recovery",
        accountId: "acct-grave-recovery",
        name: "Grave Recovery",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-grave-recovery");
      const bridge = (manager as any).behaviorBridge;
      const attempt = {
        attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        characterId: "agent-grave-recovery",
        phase: "ordinary_progression",
        goalType: null,
        actionType: "lootGravestone",
        decisionSource: "scripted",
        startedAt: Date.now(),
      };
      bridge.beginAutonomyProgressionAttempt = vi
        .fn()
        .mockResolvedValue(attempt);
      let finishLoot!: (success: boolean) => void;
      const lootPending = new Promise<boolean>((resolve) => {
        finishLoot = resolve;
      });
      const loot = vi
        .spyOn(instance.service, "executeLootGravestone")
        .mockReturnValue(lootPending);
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;

      const apply = bridge.applyTickResultWithDrain({
        characterId: "agent-grave-recovery",
        behaviorEpoch: instance.behaviorEpoch,
        action: {
          type: "lootGravestone",
          gravestoneId: "gravestone_agent-grave-recovery_1",
        },
        updatedState: {
          goal: null,
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      await vi.waitFor(() => expect(loot).toHaveBeenCalledOnce());
      expect(loot).toHaveBeenCalledWith(
        "gravestone_agent-grave-recovery_1",
        attempt.attemptId,
      );
      expect(persist).not.toHaveBeenCalled();

      finishLoot(true);
      await apply;
      expect(persist).toHaveBeenCalledWith(
        instance,
        {
          attemptedActionType: "lootGravestone",
          appliedActionType: "lootGravestone",
          outcome: "completed",
        },
        attempt,
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("binds ground pickup to the tracked attempt before checkpointing completion", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-pickup-recovery",
      "agent-pickup-recovery",
      "Pickup Recovery",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-pickup-recovery",
        accountId: "acct-pickup-recovery",
        name: "Pickup Recovery",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-pickup-recovery");
      const bridge = (manager as any).behaviorBridge;
      const attempt = {
        attemptId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        characterId: "agent-pickup-recovery",
        phase: "ordinary_progression",
        goalType: null,
        actionType: "pickup",
        decisionSource: "scripted",
        startedAt: Date.now(),
      };
      bridge.beginAutonomyProgressionAttempt = vi
        .fn()
        .mockResolvedValue(attempt);
      let finishPickup!: (success: boolean) => void;
      const pickupPending = new Promise<boolean>((resolve) => {
        finishPickup = resolve;
      });
      const pickup = vi
        .spyOn(instance.service, "executePickup")
        .mockReturnValue(pickupPending);
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;

      const apply = bridge.applyTickResultWithDrain({
        characterId: "agent-pickup-recovery",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "pickup", targetId: "ground_item_drop_1" },
        updatedState: {
          goal: null,
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      await vi.waitFor(() => expect(pickup).toHaveBeenCalledOnce());
      expect(pickup).toHaveBeenCalledWith(
        "ground_item_drop_1",
        attempt.attemptId,
      );
      expect(persist).not.toHaveBeenCalled();

      finishPickup(true);
      await apply;
      expect(persist).toHaveBeenCalledWith(
        instance,
        {
          attemptedActionType: "pickup",
          appliedActionType: "pickup",
          outcome: "completed",
        },
        attempt,
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("rejects receipt-bound custody actions from the generic fallback executor", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-fallback-custody",
      "agent-fallback-custody",
      "Fallback Custody",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-fallback-custody",
        accountId: "acct-fallback-custody",
        name: "Fallback Custody",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-fallback-custody");
      const bridge = (manager as any).behaviorBridge;
      const loot = vi.spyOn(instance.service, "executeLootGravestone");
      const pickup = vi.spyOn(instance.service, "executePickup");
      const actions = [
        { type: "pickup", targetId: "ground_item_drop_1" },
        {
          type: "lootGravestone",
          gravestoneId: "gravestone_agent-fallback-custody_1",
        },
        { type: "bury", itemId: "bones" },
        {
          type: "storeBuy",
          storeId: "store-1",
          itemId: "bronze_pickaxe",
          quantity: 1,
        },
        { type: "bankDepositAll", bankId: "bank-1" },
        { type: "bankWithdraw", bankId: "bank-1" },
      ];

      for (const action of actions) {
        await expect(bridge.executeAction(instance, action)).resolves.toEqual({
          attemptedActionType: action.type,
          appliedActionType: null,
          outcome: "rejected",
        });
      }
      expect(loot).not.toHaveBeenCalled();
      expect(pickup).not.toHaveBeenCalled();
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("forwards the tracked attempt and safe context through both manager adapters", async () => {
    const ctx = createMockWorld(9);
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      const instance = {
        config: { characterId: "adapter-agent" },
      } as never;
      const actionResult = {
        attemptedActionType: "smelt",
        appliedActionType: "smelt",
        outcome: "completed",
      } as const;
      const attempt = {
        attemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        characterId: "adapter-agent",
        phase: "ordinary_progression",
        goalType: "smelting",
        actionType: "smelt",
        decisionSource: "scripted",
        startedAt: 1_000,
      } as const;
      const safeContext = {
        goal: { type: "smelting", description: "Smelt one verified bar" },
        plan: null,
        memories: [],
        recentActionLog: [],
        tickCounter: 4,
      } as const;
      const persist = vi.fn().mockResolvedValue(undefined);
      (manager as any).persistAutonomyCheckpoint = persist;

      await (manager as any).behaviorBridge.persistAutonomyCheckpoint(
        instance,
        actionResult,
        attempt,
        safeContext,
      );
      await (manager as any).behaviorTicker.persistAutonomyCheckpoint(
        instance,
        actionResult,
        attempt,
        safeContext,
      );

      expect(persist).toHaveBeenNthCalledWith(
        1,
        instance,
        actionResult,
        attempt,
        safeContext,
      );
      expect(persist).toHaveBeenNthCalledWith(
        2,
        instance,
        actionResult,
        attempt,
        safeContext,
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("confirms the durable started edge before dispatching a tracked action", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-start-first",
      "agent-start-first",
      "Start First",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-start-first",
        accountId: "acct-start-first",
        name: "Start First",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-start-first");
      const bridge = (manager as any).behaviorBridge;
      const attempt = {
        attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        characterId: "agent-start-first",
        phase: "ordinary_progression",
        goalType: "smelting",
        actionType: "smelt",
        decisionSource: "scripted",
        startedAt: Date.now(),
      };
      let confirmStart!: () => void;
      const startPending = new Promise<typeof attempt>((resolve) => {
        confirmStart = () => resolve(attempt);
      });
      const begin = vi.fn().mockReturnValue(startPending);
      bridge.beginAutonomyProgressionAttempt = begin;
      const smelt = vi
        .spyOn(instance.service, "executeSmelt")
        .mockResolvedValue(true);
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;

      const apply = bridge.applyTickResultWithDrain({
        characterId: "agent-start-first",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "smelt", recipe: "bronze_bar" },
        updatedState: {
          goal: { type: "smelting", description: "Smelt bronze" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
      expect(smelt).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      confirmStart();
      await apply;

      expect(begin).toHaveBeenCalledWith(instance, "smelt", "scripted");
      expect(smelt).toHaveBeenCalledOnce();
      expect(persist).toHaveBeenCalledWith(
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: "smelt",
          outcome: "completed",
        },
        attempt,
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fails closed when the started edge cannot be confirmed", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-untracked", "agent-untracked", "Untracked");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-untracked",
        accountId: "acct-untracked",
        name: "Untracked",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-untracked");
      const bridge = (manager as any).behaviorBridge;
      instance.lastActivity = 100;
      bridge.beginAutonomyProgressionAttempt = vi
        .fn()
        .mockRejectedValue(new Error("progression database unavailable"));
      const smelt = vi.spyOn(instance.service, "executeSmelt");
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;

      await bridge.applyTickResultWithDrain({
        characterId: "agent-untracked",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "smelt", recipe: "bronze_bar" },
        updatedState: {
          goal: { type: "smelting", description: "Smelt bronze" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      expect(smelt).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(instance.lastActivity).toBe(100);
      expect(instance.recentActionLog).toEqual([
        { tick: 1, action: "scripted:smelt", result: "failed" },
      ]);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("closes a tracked action from pre-selection context when selection fences it in flight", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-fenced-ledger",
      "agent-fenced-ledger",
      "Fenced Ledger",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-fenced-ledger",
        accountId: "acct-fenced-ledger",
        name: "Fenced Ledger",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-fenced-ledger");
      const bridge = (manager as any).behaviorBridge;
      const attempt = {
        attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        characterId: "agent-fenced-ledger",
        phase: "ordinary_progression",
        goalType: "smelting",
        actionType: "smelt",
        decisionSource: "scripted",
        startedAt: Date.now(),
      };
      bridge.beginAutonomyProgressionAttempt = vi
        .fn()
        .mockResolvedValue(attempt);
      let finishSmelt!: () => void;
      const smeltPending = new Promise<boolean>((resolve) => {
        finishSmelt = () => resolve(true);
      });
      const smelt = vi
        .spyOn(instance.service, "executeSmelt")
        .mockReturnValue(smeltPending);
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;
      instance.recentActionLog = [];

      const apply = bridge.applyTickResultWithDrain({
        characterId: "agent-fenced-ledger",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "smelt", recipe: "bronze_bar" },
        updatedState: {
          goal: { type: "smelting", description: "Smelt before selection" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });
      await vi.waitFor(() => expect(smelt).toHaveBeenCalledOnce());

      instance.behaviorEpoch += 1;
      instance.duelPreparation = {
        preparationId: "preparation-fence",
      } as never;
      instance.goal = {
        type: "banking",
        description: "Private duel preparation",
      };
      finishSmelt();
      await apply;

      expect(instance.recentActionLog).toEqual([]);
      expect(persist).toHaveBeenCalledWith(
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: "smelt",
          outcome: "completed",
        },
        attempt,
        expect.objectContaining({
          goal: {
            type: "smelting",
            description: "Smelt before selection",
          },
          recentActionLog: [],
        }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("commits a consumed model plan and feedback only after its action result returns", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-model-truth",
      "agent-model-truth",
      "Model Truth",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-model-truth",
        accountId: "acct-model-truth",
        name: "Model Truth",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-model-truth");
      const bridge = (manager as any).behaviorBridge;
      const attempt = {
        attemptId: "33333333-3333-4333-8333-333333333333",
        characterId: "agent-model-truth",
        phase: "ordinary_progression",
        goalType: "smelting",
        actionType: "smelt",
        decisionSource: "llm",
        startedAt: 300,
      };
      bridge.beginAutonomyProgressionAttempt = vi
        .fn()
        .mockResolvedValue(attempt);
      const useModel = vi.fn();
      instance.chatRuntime = { useModel };
      instance.autonomyRecoveryPending = true;
      instance.memories = ["Previously verified context"];
      instance.recentActionLog = [];
      instance.tickCounter = 0;
      instance.llmPlan = {
        steps: ["Old advisory step"],
        currentStep: 0,
        createdAt: 10,
        goal: "Old goal",
      };
      instance.pendingLlmResult = {
        action: { type: "smelt", recipe: "bronze_bar" },
        reasoning: "Convert held ore into a usable bar.",
        goal: { type: "smelting", description: "Prepare a bronze bar" },
        plan: ["Smelt the ore", "Reassess the inventory"],
        thinking: "The furnace action is currently legal.",
        planStep: 1,
      };

      let finishSmelt!: () => void;
      const smeltPending = new Promise<boolean>((resolve) => {
        finishSmelt = () => {
          instance.chatRuntime = null;
          resolve(false);
        };
      });
      const smelt = vi
        .spyOn(instance.service, "executeSmelt")
        .mockReturnValue(smeltPending);
      const persist = vi.fn().mockResolvedValue(undefined);
      bridge.persistAutonomyCheckpoint = persist;

      const apply = bridge.applyTickResultWithDrain({
        characterId: "agent-model-truth",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "idle" },
        updatedState: {
          goal: { type: "idle", description: "Worker fallback" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      await vi.waitFor(() => expect(smelt).toHaveBeenCalledOnce());
      expect(instance.llmPlan.steps).toEqual(["Old advisory step"]);
      expect(instance.recentActionLog).toEqual([]);
      expect(instance.autonomyRecoveryPending).toBe(true);
      expect(persist).not.toHaveBeenCalled();

      finishSmelt();
      await apply;

      expect(instance.llmPlan).toMatchObject({
        steps: ["Smelt the ore", "Reassess the inventory"],
        currentStep: 1,
        goal: "Prepare a bronze bar",
      });
      expect(instance.memories).toEqual(["Previously verified context"]);
      expect(instance.recentActionLog).toEqual([
        { tick: 1, action: "llm:smelt", result: "rejected" },
      ]);
      expect(instance.recentLlmActions).toEqual(["smelt:rejected:none"]);
      expect(instance.autonomyRecoveryPending).toBe(false);
      expect(instance.pendingLlmResult).toBeUndefined();
      expect(useModel).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledWith(
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: null,
          outcome: "rejected",
        },
        attempt,
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("discards an unconsumed prefetch when persistent navigation owns the tick", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-stale-model",
      "agent-stale-model",
      "Stale Model",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-stale-model",
        accountId: "acct-stale-model",
        name: "Stale Model",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-stale-model");
      const bridge = (manager as any).behaviorBridge;
      const useModel = vi.fn();
      instance.chatRuntime = { useModel };
      instance.navigationTarget = {
        position: [500, 0, 500],
        description: "Verified destination",
        setAt: Date.now(),
      };
      instance.pendingLlmResult = {
        action: { type: "smelt", recipe: "bronze_bar" },
        reasoning: "This observation will become stale.",
        goal: { type: "smelting", description: "Smelt bronze" },
        plan: ["Smelt bronze"],
        thinking: null,
        planStep: 0,
      };
      const move = vi
        .spyOn(instance.service, "executeMove")
        .mockResolvedValue(true);
      const smelt = vi.spyOn(instance.service, "executeSmelt");

      await bridge.applyTickResultWithDrain({
        characterId: "agent-stale-model",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "idle" },
        updatedState: {
          goal: { type: "exploring", description: "Continue navigation" },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      expect(move).toHaveBeenCalledWith([500, 0, 500], true);
      expect(smelt).not.toHaveBeenCalled();
      expect(instance.pendingLlmResult).toBeUndefined();
      expect(instance.llmPlan).toBeUndefined();
      expect(instance.recentLlmActions).toBeUndefined();
      expect(instance.recentActionLog).toEqual([
        {
          tick: 1,
          action: "scripted:move",
          result: "dispatched; applied=move",
        },
      ]);
      expect(useModel).not.toHaveBeenCalled();
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("keeps a skill-training bank approach ahead of a stale model prefetch", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-training-bank",
      "agent-training-bank",
      "Training Bank Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-training-bank",
        accountId: "acct-training-bank",
        name: "Training Bank Agent",
        scriptedRole: "mining",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-training-bank");
      const bridge = (manager as any).behaviorBridge;
      instance.chatRuntime = { useModel: vi.fn() };
      instance.pendingLlmResult = {
        action: { type: "smelt", recipe: "bronze_bar" },
        reasoning: "This observation predates the training-bank route.",
        goal: { type: "smelting", description: "Smelt bronze" },
        plan: ["Smelt bronze"],
        thinking: null,
        planStep: 0,
      };
      const move = vi
        .spyOn(instance.service, "executeMove")
        .mockResolvedValue(true);
      const smelt = vi.spyOn(instance.service, "executeSmelt");

      await bridge.applyTickResultWithDrain({
        characterId: "agent-training-bank",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "move", target: [110, 0, 100], runMode: true },
        updatedState: {
          goal: {
            type: "banking",
            description: "Stage Fletching training",
            questId: "fletchers_introduction",
            questName: "Fletcher's Introduction",
          },
          questsAccepted: [],
          currentTargetId: null,
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      expect(move).toHaveBeenCalledWith([110, 0, 100], true);
      expect(smelt).not.toHaveBeenCalled();
      expect(instance.pendingLlmResult).toBeUndefined();
      expect(instance.goal).toMatchObject({
        type: "banking",
        questId: "fletchers_introduction",
      });
      expect(instance.llmPlan).toBeUndefined();
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("keeps guaranteed-source quest acquisition ahead of a stale model prefetch", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-training-source",
      "agent-training-source",
      "Training Source Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-training-source",
        accountId: "acct-training-source",
        name: "Training Source Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-training-source");
      const bridge = (manager as any).behaviorBridge;
      instance.chatRuntime = { useModel: vi.fn() };
      instance.pendingLlmResult = {
        action: { type: "smelt", recipe: "bronze_bar" },
        reasoning: "This observation predates the guaranteed source target.",
        goal: { type: "smelting", description: "Smelt bronze" },
        plan: ["Smelt bronze"],
        thinking: null,
        planStep: 0,
      };
      const attack = vi
        .spyOn(instance.service, "executeAttack")
        .mockResolvedValue(true);
      const smelt = vi.spyOn(instance.service, "executeSmelt");

      await bridge.applyTickResultWithDrain({
        characterId: "agent-training-source",
        behaviorEpoch: instance.behaviorEpoch,
        action: { type: "attack", targetId: "exact-cow" },
        updatedState: {
          goal: {
            type: "provisioning",
            description: "Acquire guaranteed cowhide for Crafting training",
            questId: "crafting_basics",
            questName: "Crafting Basics",
          },
          questsAccepted: [],
          currentTargetId: "exact-cow",
          lastGatherTargetId: null,
          lastGatherQueuedAt: 0,
          lastCombatChatAt: 0,
        },
      });

      expect(attack).toHaveBeenCalledWith("exact-cow");
      expect(smelt).not.toHaveBeenCalled();
      expect(instance.pendingLlmResult).toBeUndefined();
      expect(instance.goal).toMatchObject({
        type: "provisioning",
        questId: "crafting_basics",
      });
      expect(instance.llmPlan).toBeUndefined();
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fails a selected preparation when the fenced ordinary-action drain rejects", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-preparation-drain",
      "agent-preparation-drain",
      "Preparation Drain Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await manager.createAgent({
        characterId: "agent-preparation-drain",
        accountId: "acct-preparation-drain",
        name: "Preparation Drain Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-preparation-drain");
      const bridge = (manager as any).behaviorBridge;
      vi.spyOn(bridge, "waitForAgentQuiescence").mockRejectedValue(
        new Error("ordinary action receipt unavailable"),
      );
      const bankOpen = vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      );
      const revoke = vi.spyOn(
        instance.service,
        "revokeDuelPreparationBankAccess",
      );
      const preparationId = "3f990f0f-ac41-4824-81ba-4cf614bcacf2";

      await (manager as any).handleDuelPreparationSelected({
        preparationId,
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-preparation-drain",
        agent2Id: "agent-opponent",
      });

      expect(bankOpen).not.toHaveBeenCalled();
      expect(instance.duelPreparation).toMatchObject({
        preparationId,
        status: "failed",
        failureReason: "preparation_assignment_failed",
      });
      expect(revoke).toHaveBeenCalledWith(preparationId);
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          preparationId,
          agentId: "agent-preparation-drain",
          status: "failed",
          failureReason: "preparation_assignment_failed",
        }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Unexpected duel preparation assignment failure for agent-preparation-drain",
        ),
        "ordinary action receipt unavailable",
      );
    } finally {
      consoleError.mockRestore();
      await forceTestShutdown(manager);
    }
  });

  it("bounds a wedged ordinary-action drain by the durable preparation deadline", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-preparation-deadline",
      "agent-preparation-deadline",
      "Preparation Deadline Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await manager.createAgent({
        characterId: "agent-preparation-deadline",
        accountId: "acct-preparation-deadline",
        name: "Preparation Deadline Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get(
        "agent-preparation-deadline",
      );
      const bridge = (manager as any).behaviorBridge;
      vi.spyOn(bridge, "waitForAgentQuiescence").mockReturnValue(
        new Promise<void>(() => undefined),
      );
      const bankOpen = vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      );
      const preparationId = "74a5908d-d560-4bc8-a2e7-eb97af402de8";
      const startedAt = Date.now();

      await (manager as any).handleDuelPreparationSelected({
        preparationId,
        selectedAt: startedAt,
        expiresAt: startedAt + 25,
        agent1Id: "agent-preparation-deadline",
        agent2Id: "agent-opponent",
      });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(bankOpen).not.toHaveBeenCalled();
      expect(instance.duelPreparation).toMatchObject({
        preparationId,
        status: "failed",
        failureReason: "preparation_quiescence_deadline_exceeded",
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          preparationId,
          agentId: "agent-preparation-deadline",
          status: "failed",
          failureReason: "preparation_quiescence_deadline_exceeded",
        }),
      );
    } finally {
      consoleError.mockRestore();
      await forceTestShutdown(manager);
    }
  });

  it("reports one rejected assignment immediately and terminal cancellation releases its wedged peer", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-preparation-reject",
      "agent-preparation-reject",
      "Preparation Reject Agent",
    );
    ctx.registerCharacter(
      "acct-preparation-wedge",
      "agent-preparation-wedge",
      "Preparation Wedge Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      for (const [characterId, accountId, name] of [
        [
          "agent-preparation-reject",
          "acct-preparation-reject",
          "Preparation Reject Agent",
        ],
        [
          "agent-preparation-wedge",
          "acct-preparation-wedge",
          "Preparation Wedge Agent",
        ],
      ] as const) {
        await manager.createAgent({
          characterId,
          accountId,
          name,
          scriptedRole: "combat",
          autoStart: true,
        });
      }
      const bridge = (manager as any).behaviorBridge;
      vi.spyOn(bridge, "waitForAgentQuiescence").mockImplementation(
        (agentId: unknown) =>
          agentId === "agent-preparation-reject"
            ? Promise.reject(new Error("durable drain rejected"))
            : new Promise<void>(() => undefined),
      );
      const preparationId = "7c361f54-7168-43c8-a3a8-f985c017b3d6";
      let handlerCompleted = false;
      const handling = (manager as any)
        .handleDuelPreparationSelected({
          preparationId,
          selectedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          agent1Id: "agent-preparation-reject",
          agent2Id: "agent-preparation-wedge",
        })
        .then(() => {
          handlerCompleted = true;
        });

      await vi.waitFor(() =>
        expect(ctx.world.emit).toHaveBeenCalledWith(
          "duel:preparation:agent_plan_status",
          expect.objectContaining({
            preparationId,
            agentId: "agent-preparation-reject",
            status: "failed",
            failureReason: "preparation_assignment_failed",
          }),
        ),
      );
      expect(handlerCompleted).toBe(false);
      (manager as any).duelPreparationTerminalListener({ preparationId });
      await handling;

      expect(handlerCompleted).toBe(true);
      expect((manager as any).duelPreparationQuiescenceCancellations.size).toBe(
        0,
      );
      expect(
        (manager as any).agents.get("agent-preparation-reject").duelPreparation,
      ).toBeUndefined();
      expect(
        (manager as any).agents.get("agent-preparation-wedge").duelPreparation,
      ).toBeUndefined();
    } finally {
      consoleError.mockRestore();
      await forceTestShutdown(manager);
    }
  });

  it("finishes a previously committed withdrawal from authoritative inventory after restart", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-resume", "agent-resume", "Resume Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-resume",
        accountId: "acct-resume",
        name: "Resume Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-resume");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-resume",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: { attack: { level: 10, xp: 0 } },
        inventory: [{ slot: 0, itemId: "test_prep_sword", quantity: 1 }],
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      const selection = {
        preparationId: "85975a78-8943-4efc-b12e-0d08c414997b",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-resume",
        agent2Id: "agent-opponent",
      };
      await (manager as any).handleDuelPreparationSelected(selection);

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        { slotType: "weapon", itemId: "test_prep_sword", quantity: 1 },
      ]);
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-resume" }),
      );
      const publicActivities = vi
        .mocked(ctx.world.emit)
        .mock.calls.filter(
          ([event]) => event === "duel:preparation:public_activity",
        )
        .map(([, payload]) => payload);
      expect(publicActivities).toEqual([
        {
          preparationId: "85975a78-8943-4efc-b12e-0d08c414997b",
          agentId: "agent-resume",
          activity: "planning",
          mode: "working",
          occurredAt: expect.any(Number),
          revision: 1,
        },
        {
          preparationId: "85975a78-8943-4efc-b12e-0d08c414997b",
          agentId: "agent-resume",
          activity: "provisioning",
          mode: "working",
          occurredAt: expect.any(Number),
          revision: 2,
        },
      ]);
      expect(JSON.stringify(publicActivities)).not.toContain("test_prep_sword");

      await (manager as any).handleDuelPreparationSelected(selection);
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(
        vi
          .mocked(ctx.world.emit)
          .mock.calls.filter(
            ([event]) => event === "duel:preparation:public_activity",
          )
          .at(-1),
      ).toEqual([
        "duel:preparation:public_activity",
        expect.objectContaining({
          preparationId: selection.preparationId,
          agentId: "agent-resume",
          activity: "provisioning",
          revision: 3,
        }),
      ]);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("publishes preparation activity only after the durable append resolves", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-activity-ledger",
      "agent-activity-ledger",
      "Activity Ledger Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-activity-ledger",
        accountId: "acct-activity-ledger",
        name: "Activity Ledger Agent",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-activity-ledger");
      const preparationId = "7a408d97-f8fc-4d3e-aa21-b847411f7859";
      instance.duelPreparation = { preparationId };
      vi.spyOn(manager as any, "getAutonomyPersistenceAccess").mockReturnValue({
        db: {},
        pool: {},
      });
      let resolveAppend!: (value: {
        preparationId: string;
        agentId: string;
        activity: "planning";
        mode: "working";
        occurredAt: number;
        revision: number;
      }) => void;
      const append = vi
        .spyOn(PostgresDuelPreparationStore.prototype, "appendPublicActivity")
        .mockReturnValue(
          new Promise((resolve) => {
            resolveAppend = resolve;
          }),
        );

      const publishing = (manager as any).emitPreparationActivity(
        instance,
        preparationId,
        "planning",
        "working",
      );
      expect(
        vi
          .mocked(ctx.world.emit)
          .mock.calls.some(
            ([event]) => event === "duel:preparation:public_activity",
          ),
      ).toBe(false);

      resolveAppend({
        preparationId,
        agentId: "agent-activity-ledger",
        activity: "planning",
        mode: "working",
        occurredAt: Date.now() + 5,
        revision: 77,
      });
      await publishing;

      expect(append).toHaveBeenCalledWith({
        preparationId,
        agentId: "agent-activity-ledger",
        ownerId: expect.any(String),
        activity: "planning",
        mode: "working",
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:public_activity",
        {
          preparationId,
          agentId: "agent-activity-ledger",
          activity: "planning",
          mode: "working",
          occurredAt: Date.now() + 5,
          revision: 77,
        },
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("recovers a committed whole-plan receipt after restart without replanning", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-plan-recovery",
      "agent-plan-recovery",
      "Plan Recovery Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-plan-recovery",
        accountId: "acct-plan-recovery",
        name: "Plan Recovery Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-plan-recovery");
      const policyBinding = (manager as any).getCompetitiveAgentPolicyBinding(
        "agent-plan-recovery",
        "duel-preparation-role-v3",
      );
      const planEvidence = {
        primaryStyle: "melee",
        availableStyles: ["melee"],
        planningSource: "deterministic",
        planningPolicyVersion: "duel-preparation-role-v3",
        agentPolicyFingerprint: policyBinding.fingerprint,
        modelProvider: policyBinding.provider,
        model: policyBinding.model,
        tacticalStrategy: {
          approach: "balanced",
          tacticalMacro: "pressure",
          attackStyle: "aggressive",
          prayer: null,
          preferredCombatRole: null,
          foodThreshold: 40,
          switchDefensiveAt: 30,
          reasoning: "Use the deterministic role-aware competitive fallback.",
        },
      } as const;
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({ success: true, bankItems: [] });
      const recover = vi
        .spyOn(instance.service, "executeDuelPreparationPlanRecovery")
        .mockImplementation(async (operationId, preparationId) => ({
          ok: true,
          playerId: "agent-plan-recovery",
          operationId: String(operationId),
          preparationId: String(preparationId),
          requestFingerprint: "persisted-plan-fingerprint",
          changed: false,
          replayed: true,
          committed: {
            bank: [],
            inventory: [],
            equipment: [
              {
                slotType: "weapon",
                itemId: "test_prep_sword",
                quantity: 1,
              },
            ],
            selectedSpell: null,
          },
          recoveryEvidence: planEvidence,
        }));
      const plan = vi.mocked(instance.service.executeDuelPreparationPlan);
      plan.mockClear();

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "41c7c91b-fbfa-46c8-8ee9-f267f3cf86e7",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-plan-recovery",
        agent2Id: "agent-opponent",
      });

      expect(recover).toHaveBeenCalledOnce();
      expect(plan).not.toHaveBeenCalled();
      expect(instance.duelPreparation.status).toBe("planning");
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          agentId: "agent-plan-recovery",
          recoveredCommittedPlan: true,
          atomicPlanReplayed: true,
          planEvidence,
        }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({
          agentId: "agent-plan-recovery",
          planEvidence,
        }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("provisions a complete owned ranged setup and bounded food without creating supplies", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-ranged", "agent-ranged", "Ranged Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-ranged",
        accountId: "acct-ranged",
        name: "Ranged Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-ranged");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-ranged",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 1, xp: 0 },
          strength: { level: 1, xp: 0 },
          ranged: { level: 10, xp: 0 },
          magic: { level: 1, xp: 0 },
        },
        inventory: [],
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "bronze_arrow", quantity: 60, slot: 1, tabIndex: 0 },
          { itemId: "lobster", quantity: 8, slot: 2, tabIndex: 0 },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const autocast = vi.spyOn(instance.service, "executeSetAutocast");
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "3ce02ec1-8635-40f4-ac92-f06667323b31",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-ranged",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(autocast).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(atomicPlan.mock.calls[0][0].recoveryEvidence).toMatchObject({
        primaryStyle: "ranged",
        availableStyles: ["ranged"],
        planningSource: "deterministic",
        planningPolicyVersion: "duel-preparation-role-v3",
        decisionOutcome: "deterministic_single_legal_role",
        decisionLatencyMs: expect.any(Number),
      });
      expect(atomicPlan.mock.calls[0][0].recoveryEvidence).not.toHaveProperty(
        "reason",
      );
      expect(atomicPlan.mock.calls[0][0].committed).toMatchObject({
        inventory: Array.from({ length: 2 }, () =>
          expect.objectContaining({ itemId: "lobster", quantity: 1 }),
        ),
        equipment: [
          { slotType: "arrows", itemId: "bronze_arrow", quantity: 60 },
          { slotType: "weapon", itemId: "shortbow", quantity: 1 },
        ],
        selectedSpell: null,
      });
      expect(instance.duelPreparation.strategy).toEqual({
        primaryStyle: "ranged",
        availableStyles: ["ranged"],
        opponentHistorySampleSize: 0,
        defensiveFocus: null,
        weaponId: "shortbow",
        ammunitionId: "bronze_arrow",
        spellId: null,
        foodItemId: "lobster",
        foodQuantity: 2,
        tacticalStrategy: {
          approach: "balanced",
          tacticalMacro: "orbit",
          attackStyle: "aggressive",
          prayer: null,
          preferredCombatRole: null,
          foodThreshold: 40,
          switchDefensiveAt: 30,
          reasoning: "Use the deterministic role-aware competitive fallback.",
        },
        loadouts: {
          ranged: {
            weaponId: "shortbow",
            ammunitionId: "bronze_arrow",
            spellId: null,
            armorIds: EMPTY_FROZEN_ARMOR_IDS,
          },
        },
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-ranged" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("replaces equipped armor with the strongest legal owned option for the opening role", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-armor", "agent-armor", "Armored Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-armor",
        accountId: "acct-armor",
        name: "Armored Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-armor");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-armor",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 10, xp: 0 },
          strength: { level: 10, xp: 0 },
          defense: { level: 20, xp: 0 },
        },
        inventory: [],
        equipment: {
          weapon: { itemId: "test_prep_sword", quantity: 1 },
          body: { itemId: "test_prep_weak_body", quantity: 1 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          {
            itemId: "test_prep_strong_body",
            quantity: 1,
            slot: 0,
            tabIndex: 0,
          },
          {
            itemId: "test_prep_overleveled_body",
            quantity: 1,
            slot: 1,
            tabIndex: 0,
          },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "47c42b2d-9993-4d47-8168-1220642369c2",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-armor",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toContainEqual({
        slotType: "body",
        itemId: "test_prep_strong_body",
        quantity: 1,
      });
      expect(
        atomicPlan.mock.calls[0][0].committed.equipment,
      ).not.toContainEqual(
        expect.objectContaining({ itemId: "test_prep_overleveled_body" }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          agentId: "agent-armor",
          defensiveEquipmentCount: 1,
        }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-armor" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("banks unsupported visible gear and commits only a certified public-duel weapon", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-certified-fit",
      "agent-certified-fit",
      "Certified Fit Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-certified-fit",
        accountId: "acct-certified-fit",
        name: "Certified Fit Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-certified-fit");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-certified-fit",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 10, xp: 0 },
          strength: { level: 10, xp: 0 },
          defense: { level: 10, xp: 0 },
        },
        inventory: [],
        equipment: {
          weapon: { itemId: "bronze_dagger", quantity: 1 },
          helmet: { itemId: "bronze_full_helm", quantity: 1 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          {
            itemId: "bronze_shortsword",
            quantity: 1,
            slot: 0,
            tabIndex: 0,
          },
        ],
      });
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "06fa119d-e87b-4bd6-a690-e2466777e35d",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-certified-fit",
        agent2Id: "agent-opponent",
      });

      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        {
          slotType: "weapon",
          itemId: "bronze_shortsword",
          quantity: 1,
        },
      ]);
      expect(atomicPlan.mock.calls[0][0].committed.bank).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: "bronze_dagger", quantity: 1 }),
          expect.objectContaining({
            itemId: "bronze_full_helm",
            quantity: 1,
          }),
        ]),
      );
      expect(instance.duelPreparation.strategy).toMatchObject({
        weaponId: "bronze_shortsword",
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          agentId: "agent-certified-fit",
          defensiveEquipmentCount: 0,
          defensiveUnequipCount: 1,
        }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-certified-fit" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("uses opening-role offense before aggregate defense when selecting owned armor", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-mage-armor", "agent-mage-armor", "Mage Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-mage-armor",
        accountId: "acct-mage-armor",
        name: "Mage Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-mage-armor");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-mage-armor",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: { magic: { level: 1, xp: 0 } },
        inventory: [],
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "staff_of_air", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "mind_rune", quantity: 20, slot: 1, tabIndex: 0 },
          {
            itemId: "test_prep_metal_body",
            quantity: 1,
            slot: 2,
            tabIndex: 0,
          },
          {
            itemId: "test_prep_wizard_body",
            quantity: 1,
            slot: 3,
            tabIndex: 0,
          },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      vi.spyOn(instance.service, "executeSetAutocast").mockResolvedValue(true);
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "11fc364f-4dbf-4efb-94ca-67a73cc719fb",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-mage-armor",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        { slotType: "body", itemId: "test_prep_wizard_body", quantity: 1 },
        { slotType: "weapon", itemId: "staff_of_air", quantity: 1 },
      ]);
      expect(atomicPlan.mock.calls[0][0].committed.bank).toContainEqual(
        expect.objectContaining({ itemId: "test_prep_metal_body" }),
      );
      expect(instance.duelPreparation.strategy.primaryStyle).toBe("mage");
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-mage-armor" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("causally changes owned armor selection from verified opponent opening history", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-ranged-focus",
      "agent-ranged-focus",
      "Ranged Focus Agent",
    );
    ctx.registerCharacter(
      "acct-magic-focus",
      "agent-magic-focus",
      "Magic Focus Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      for (const [characterId, accountId, name] of [
        ["agent-ranged-focus", "acct-ranged-focus", "Ranged Focus Agent"],
        ["agent-magic-focus", "acct-magic-focus", "Magic Focus Agent"],
      ] as const) {
        await manager.createAgent({
          characterId,
          accountId,
          name,
          scriptedRole: "combat",
          autoStart: true,
        });
        const instance = (manager as any).agents.get(characterId);
        vi.spyOn(instance.service, "getGameState").mockReturnValue({
          playerId: characterId,
          position: [0, 9, 0],
          health: 20,
          maxHealth: 20,
          alive: true,
          skills: {
            attack: { level: 10, xp: 0 },
            strength: { level: 10, xp: 0 },
          },
          inventory: [],
          equipment: {
            weapon: { itemId: "test_prep_sword", quantity: 1 },
          },
          nearbyEntities: [],
          inCombat: false,
          currentTarget: null,
          activePrayers: [],
        });
        vi.spyOn(
          instance.service,
          "executeDuelPreparationBankOpen",
        ).mockResolvedValue({
          success: true,
          bankItems: [
            {
              itemId: "test_prep_ranged_defense_body",
              quantity: 1,
              slot: 0,
              tabIndex: 0,
            },
            {
              itemId: "test_prep_magic_defense_body",
              quantity: 1,
              slot: 1,
              tabIndex: 0,
            },
          ],
        });
      }

      const selectedAt = Date.now();
      const historyFor = (opponentOpeningStyle: "ranged" | "mage") => [
        {
          cycleId: `prior-${opponentOpeningStyle}`,
          finishedAt: selectedAt - 1_000,
          result: "loss",
          ownOpeningStyle: "melee",
          opponentOpeningStyle,
          ownDamage: 8,
          opponentDamage: 20,
          winReason: "kill",
        },
      ];
      await (manager as any).handleDuelPreparationSelected({
        preparationId: "70c869b9-edc7-4655-971e-0f5d8bf1ea53",
        selectedAt,
        expiresAt: selectedAt + 60_000,
        agent1Id: "agent-ranged-focus",
        agent2Id: "opponent-ranged-focus",
        agent1OpponentHistory: historyFor("ranged"),
      });
      await (manager as any).handleDuelPreparationSelected({
        preparationId: "350fe2ad-b4bc-43ad-a064-1156418f96a6",
        selectedAt,
        expiresAt: selectedAt + 60_000,
        agent1Id: "agent-magic-focus",
        agent2Id: "opponent-magic-focus",
        agent1OpponentHistory: historyFor("mage"),
      });

      const rangedInstance = (manager as any).agents.get("agent-ranged-focus");
      const magicInstance = (manager as any).agents.get("agent-magic-focus");
      const planCalls = vi.mocked(
        rangedInstance.service.executeDuelPreparationPlan,
      ).mock.calls;
      const rangedPlan = planCalls.find(
        (call: any[]) =>
          call[0].preparationId === "70c869b9-edc7-4655-971e-0f5d8bf1ea53",
      )?.[0];
      const magicPlan = planCalls.find(
        (call: any[]) =>
          call[0].preparationId === "350fe2ad-b4bc-43ad-a064-1156418f96a6",
      )?.[0];
      expect(rangedPlan?.committed.equipment).toContainEqual({
        slotType: "body",
        itemId: "test_prep_ranged_defense_body",
        quantity: 1,
      });
      expect(magicPlan?.committed.equipment).toContainEqual({
        slotType: "body",
        itemId: "test_prep_magic_defense_body",
        quantity: 1,
      });
      expect(rangedInstance.duelPreparation.strategy).toMatchObject({
        defensiveFocus: "ranged",
        opponentHistorySampleSize: 1,
      });
      expect(magicInstance.duelPreparation.strategy).toMatchObject({
        defensiveFocus: "mage",
        opponentHistorySampleSize: 1,
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          agentId: "agent-ranged-focus",
          defensiveFocus: "ranged",
          opponentHistorySampleSize: 1,
        }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("authoritatively removes role-penalizing worn armor when no useful replacement exists", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-mage-empty",
      "agent-mage-empty",
      "Unarmored Mage",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-mage-empty",
        accountId: "acct-mage-empty",
        name: "Unarmored Mage",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-mage-empty");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-mage-empty",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: { magic: { level: 1, xp: 0 } },
        inventory: [{ slot: 0, itemId: "mind_rune", quantity: 20 }],
        equipment: {
          weapon: { itemId: "staff_of_air", quantity: 1 },
          body: { itemId: "test_prep_metal_body", quantity: 1 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({ success: true, bankItems: [] });
      const equip = vi.spyOn(instance.service, "executeEquip");
      const unequip = vi
        .spyOn(instance.service, "executeUnequipOwned")
        .mockResolvedValue({
          ok: true,
          playerId: "agent-mage-empty",
          itemId: "test_prep_metal_body",
          slot: "body",
          changed: true,
        });
      vi.spyOn(instance.service, "executeSetAutocast").mockResolvedValue(true);
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "d5658048-c818-4fcf-84d2-b24935380cae",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-mage-empty",
        agent2Id: "agent-opponent",
      });

      expect(equip).not.toHaveBeenCalled();
      expect(unequip).not.toHaveBeenCalled();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        { slotType: "weapon", itemId: "staff_of_air", quantity: 1 },
      ]);
      expect(atomicPlan.mock.calls[0][0].committed.bank).toContainEqual(
        expect.objectContaining({ itemId: "test_prep_metal_body" }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          defensiveEquipmentCount: 0,
          defensiveUnequipCount: 1,
        }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-mage-empty" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("never provisions or equips a shield for a two-handed opening weapon", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-2h", "agent-2h", "Two Handed Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-2h",
        accountId: "acct-2h",
        name: "Two Handed Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-2h");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-2h",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: { ranged: { level: 10, xp: 0 } },
        inventory: [],
        equipment: {
          shield: { itemId: "test_prep_shield", quantity: 1 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "bronze_arrow", quantity: 50, slot: 1, tabIndex: 0 },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "943694b1-aa19-4ff7-8f46-bb13289734f9",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-2h",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ]);
      expect(atomicPlan.mock.calls[0][0].committed.bank).toContainEqual(
        expect.objectContaining({ itemId: "test_prep_shield" }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({ defensiveEquipmentCount: 0 }),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-2h" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("does not report readiness when authoritative defensive equipment equip fails", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-armor-fail",
      "agent-armor-fail",
      "Armor Failure",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-armor-fail",
        accountId: "acct-armor-fail",
        name: "Armor Failure",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-armor-fail");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-armor-fail",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 10, xp: 0 },
          strength: { level: 10, xp: 0 },
          defense: { level: 20, xp: 0 },
        },
        inventory: [],
        equipment: {
          weapon: { itemId: "test_prep_sword", quantity: 1 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          {
            itemId: "test_prep_strong_body",
            quantity: 1,
            slot: 0,
            tabIndex: 0,
          },
        ],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationPlan",
      ).mockResolvedValue({
        ok: false,
        playerId: "agent-armor-fail",
        operationId: "65c62158-c8fa-48ef-b2d0-558590c568d1",
        preparationId: "65c62158-c8fa-48ef-b2d0-558590c568d1",
        changed: false,
        replayed: false,
        reason: "committed_state_apply_failed",
      });

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "65c62158-c8fa-48ef-b2d0-558590c568d1",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-armor-fail",
        agent2Id: "agent-opponent",
      });

      expect(instance.duelPreparation.status).toBe("failed");
      expect(instance.duelPreparation.failureReason).toBe(
        "committed_state_apply_failed",
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          agentId: "agent-armor-fail",
          status: "failed",
          failureReason: "committed_state_apply_failed",
        }),
      );
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.anything(),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("atomically banks displaced armor without a transient inventory overflow", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-capacity", "agent-capacity", "Capacity Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    const slots = [
      "shield",
      "helmet",
      "body",
      "legs",
      "boots",
      "gloves",
      "cape",
      "amulet",
      "ring",
    ] as const;
    const temporaryItemIds = ["test_prep_weak_sword", "test_prep_old_arrow"];
    try {
      ITEMS.set("test_prep_weak_sword", {
        id: "test_prep_weak_sword",
        name: "Weak Sword",
        type: "weapon",
        equipSlot: "weapon",
        attackType: "MELEE",
        stackable: false,
        bonuses: {},
      } as never);
      ITEMS.set("test_prep_old_arrow", {
        id: "test_prep_old_arrow",
        name: "Old Arrow",
        type: "ammunition",
        equipSlot: "arrows",
        stackable: true,
      } as never);
      for (const slot of slots) {
        const weakId = `test_prep_weak_${slot}`;
        const strongId = `test_prep_strong_${slot}`;
        temporaryItemIds.push(weakId, strongId);
        ITEMS.set(weakId, {
          id: weakId,
          name: `Weak ${slot}`,
          type: "armor",
          equipSlot: slot,
          stackable: false,
          bonuses: { defenseStab: 1 },
        } as never);
        ITEMS.set(strongId, {
          id: strongId,
          name: `Strong ${slot}`,
          type: "armor",
          equipSlot: slot,
          stackable: false,
          bonuses: { defenseStab: 10 },
        } as never);
      }

      await manager.createAgent({
        characterId: "agent-capacity",
        accountId: "acct-capacity",
        name: "Capacity Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-capacity");
      const equipment = Object.fromEntries([
        ["weapon", { itemId: "test_prep_weak_sword", quantity: 1 }],
        ["arrows", { itemId: "test_prep_old_arrow", quantity: 30 }],
        ...slots.map((slot) => [
          slot,
          { itemId: `test_prep_weak_${slot}`, quantity: 1 },
        ]),
      ]);
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-capacity",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 10, xp: 0 },
          strength: { level: 10, xp: 0 },
          defense: { level: 10, xp: 0 },
          ranged: { level: 1, xp: 0 },
          magic: { level: 5, xp: 0 },
        },
        inventory: [],
        equipment,
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "shortbow", quantity: 1, slot: 1, tabIndex: 0 },
          { itemId: "bronze_arrow", quantity: 50, slot: 2, tabIndex: 0 },
          { itemId: "staff_of_air", quantity: 1, slot: 3, tabIndex: 0 },
          { itemId: "mind_rune", quantity: 20, slot: 4, tabIndex: 0 },
          { itemId: "water_rune", quantity: 20, slot: 5, tabIndex: 0 },
          { itemId: "lobster", quantity: 4, slot: 6, tabIndex: 0 },
          ...slots.map((slot, index) => ({
            itemId: `test_prep_strong_${slot}`,
            quantity: 1,
            slot: index + 7,
            tabIndex: 0,
          })),
        ],
      });
      const deposit = vi.spyOn(instance.service, "executeBankDeposit");
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "1ea25621-5643-40c2-a9bd-668b9bfc17d2",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-capacity",
        agent2Id: "agent-opponent",
      });

      expect(instance.duelPreparation.status).toBe("planning");
      expect(instance.duelPreparation.failureReason).toBeNull();
      expect(deposit).not.toHaveBeenCalled();
      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      const committed = atomicPlan.mock.calls[0][0].committed;
      for (const slot of slots) {
        expect(committed.equipment).toContainEqual({
          slotType: slot,
          itemId: `test_prep_strong_${slot}`,
          quantity: 1,
        });
        expect(committed.bank).toContainEqual(
          expect.objectContaining({ itemId: `test_prep_weak_${slot}` }),
        );
      }
      expect(committed.inventory.length).toBeLessThanOrEqual(28);
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-capacity" }),
      );
    } finally {
      for (const itemId of temporaryItemIds) ITEMS.delete(itemId);
      await forceTestShutdown(manager);
    }
  });

  it("counts equipped ammunition exactly and carries all owned arrows below the duration target", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-ranged-stack",
      "agent-ranged-stack",
      "Stack Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-ranged-stack",
        accountId: "acct-ranged-stack",
        name: "Stack Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-ranged-stack");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-ranged-stack",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 1, xp: 0 },
          strength: { level: 1, xp: 0 },
          ranged: { level: 10, xp: 0 },
          magic: { level: 1, xp: 0 },
        },
        inventory: [],
        equipment: {
          weapon: { itemId: "shortbow", quantity: 1 },
          arrows: { itemId: "bronze_arrow", quantity: 30 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "bronze_arrow", quantity: 100, slot: 0, tabIndex: 0 },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      vi.spyOn(instance.service, "executeSetAutocast").mockResolvedValue(true);
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "d5ca0a7a-1e63-4d53-ae63-601d89f3a5a1",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-ranged-stack",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toContainEqual({
        slotType: "arrows",
        itemId: "bronze_arrow",
        quantity: 130,
      });
      expect(atomicPlan.mock.calls[0][0].committed.bank).not.toContainEqual(
        expect.objectContaining({ itemId: "bronze_arrow" }),
      );
      expect(instance.duelPreparation.strategy).toMatchObject({
        primaryStyle: "ranged",
        ammunitionId: "bronze_arrow",
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-ranged-stack" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("clears a full ordinary inventory before withdrawing the exact duel loadout", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-full-prep", "agent-full-prep", "Full Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-full-prep",
        accountId: "acct-full-prep",
        name: "Full Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-full-prep");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-full-prep",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 1, xp: 0 },
          strength: { level: 1, xp: 0 },
          ranged: { level: 10, xp: 0 },
          magic: { level: 1, xp: 0 },
        },
        inventory: Array.from({ length: 28 }, (_, slot) => ({
          slot,
          itemId: "test_prep_junk",
          quantity: 1,
        })),
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "bronze_arrow", quantity: 60, slot: 1, tabIndex: 0 },
          { itemId: "lobster", quantity: 8, slot: 2, tabIndex: 0 },
        ],
      });
      const deposit = vi
        .spyOn(instance.service, "executeBankDeposit")
        .mockResolvedValue({ success: true, commitState: "committed" });
      const withdraw = vi
        .spyOn(instance.service, "executeBankWithdraw")
        .mockResolvedValue({ success: true, commitState: "committed" });
      vi.spyOn(instance.service, "executeEquip").mockResolvedValue({
        ok: true,
        playerId: "agent-full-prep",
        itemId: "shortbow",
        slot: "weapon",
        changed: true,
      });
      vi.spyOn(instance.service, "executeSetAutocast").mockResolvedValue(true);
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "8d0d86df-b5a5-41ab-bfb9-4980de8b6096",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-full-prep",
        agent2Id: "agent-opponent",
      });

      expect(deposit).not.toHaveBeenCalled();
      expect(withdraw).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(atomicPlan.mock.calls[0][0].committed.bank).toContainEqual(
        expect.objectContaining({ itemId: "test_prep_junk", quantity: 28 }),
      );
      expect(atomicPlan.mock.calls[0][0].committed.inventory).toHaveLength(2);
      expect(
        atomicPlan.mock.calls[0][0].committed.inventory.every(
          (row: { itemId: string; quantity: number }) =>
            row.itemId === "lobster" && row.quantity === 1,
        ),
      ).toBe(true);
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 60 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ]);
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-full-prep" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fails preparation before any withdrawal or equip when inventory reconciliation fails", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-reconcile-fail",
      "agent-reconcile-fail",
      "Safe Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-reconcile-fail",
        accountId: "acct-reconcile-fail",
        name: "Safe Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-reconcile-fail");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-reconcile-fail",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 10, xp: 0 },
          strength: { level: 10, xp: 0 },
          ranged: { level: 1, xp: 0 },
          magic: { level: 1, xp: 0 },
        },
        inventory: [{ slot: 0, itemId: "test_prep_junk", quantity: 1 }],
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
        ],
      });
      const deposit = vi
        .spyOn(instance.service, "executeBankDeposit")
        .mockResolvedValue({ success: true, commitState: "committed" });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const atomicPlan = vi
        .spyOn(instance.service, "executeDuelPreparationPlan")
        .mockImplementation(async (request: any) => ({
          ok: false,
          playerId: "agent-reconcile-fail",
          operationId: request.operationId,
          preparationId: request.preparationId,
          changed: false,
          replayed: false,
          reason: "persistence_failed",
        }));

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "6768d591-f62a-4f86-96b8-a0c5ae56ecce",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-reconcile-fail",
        agent2Id: "agent-opponent",
      });

      expect(deposit).not.toHaveBeenCalled();
      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(instance.duelPreparation).toMatchObject({
        status: "failed",
        failureReason: "persistence_failed",
      });
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.anything(),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("provisions only owned runes for the strongest castable magic setup", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-mage", "agent-mage", "Magic Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-mage",
        accountId: "acct-mage",
        name: "Magic Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-mage");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-mage",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 1, xp: 0 },
          strength: { level: 1, xp: 0 },
          ranged: { level: 1, xp: 0 },
          magic: { level: 13, xp: 0 },
        },
        inventory: [],
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "staff_of_air", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "fire_rune", quantity: 500, slot: 1, tabIndex: 0 },
          { itemId: "mind_rune", quantity: 500, slot: 2, tabIndex: 0 },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const autocast = vi
        .spyOn(instance.service, "executeSetAutocast")
        .mockResolvedValue(true);
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "296308e6-bf81-4a8d-988b-3bcd02158f14",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-mage",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(autocast).not.toHaveBeenCalled();
      expect(atomicPlan.mock.calls[0][0].committed).toMatchObject({
        equipment: [
          { slotType: "weapon", itemId: "staff_of_air", quantity: 1 },
        ],
        selectedSpell: "fire_strike",
      });
      const expectedCasts = getDuelPreparationAttackSupplyTarget(
        STREAMING_TIMING.MAX_FIGHT_DURATION,
        COMBAT_SPELLS.fire_strike.attackSpeed,
      );
      expect(atomicPlan.mock.calls[0][0].committed.inventory).toEqual([
        expect.objectContaining({
          itemId: "fire_rune",
          quantity: expectedCasts * 3,
        }),
        expect.objectContaining({
          itemId: "mind_rune",
          quantity: expectedCasts,
        }),
      ]);
      expect(atomicPlan.mock.calls[0][0].committed.bank).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemId: "fire_rune",
            quantity: 500 - expectedCasts * 3,
          }),
          expect.objectContaining({
            itemId: "mind_rune",
            quantity: 500 - expectedCasts,
          }),
        ]),
      );
      expect(instance.duelPreparation.strategy).toMatchObject({
        primaryStyle: "mage",
        weaponId: "staff_of_air",
        spellId: "fire_strike",
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-mage" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("provisions complete owned alternatives while equipping only the primary strategy", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-multistyle",
      "agent-multistyle",
      "Adaptive Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-multistyle",
        accountId: "acct-multistyle",
        name: "Adaptive Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-multistyle");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-multistyle",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 20, xp: 0 },
          strength: { level: 20, xp: 0 },
          ranged: { level: 15, xp: 0 },
          magic: { level: 13, xp: 0 },
        },
        inventory: [],
        equipment: {
          weapon: { itemId: "shortbow", quantity: 1 },
          arrows: { itemId: "bronze_arrow", quantity: 500 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "staff_of_air", quantity: 1, slot: 1, tabIndex: 0 },
          { itemId: "fire_rune", quantity: 60, slot: 2, tabIndex: 0 },
          { itemId: "mind_rune", quantity: 20, slot: 3, tabIndex: 0 },
          { itemId: "lobster", quantity: 8, slot: 4, tabIndex: 0 },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const autocast = vi
        .spyOn(instance.service, "executeSetAutocast")
        .mockResolvedValue(true);
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "9712c3e3-7908-43cb-a50e-1099d0c33eb1",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-multistyle",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(autocast).not.toHaveBeenCalled();
      const expectedArrowReserve = getDuelPreparationAttackSupplyTarget(
        STREAMING_TIMING.MAX_FIGHT_DURATION,
        Math.max(1, (ITEMS.get("shortbow")?.attackSpeed ?? 4) - 1),
      );
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        {
          slotType: "arrows",
          itemId: "bronze_arrow",
          quantity: expectedArrowReserve,
        },
        { slotType: "weapon", itemId: "test_prep_sword", quantity: 1 },
      ]);
      expect(
        atomicPlan.mock.calls[0][0].committed.inventory.map(
          (row: { itemId: string; quantity: number }) => [
            row.itemId,
            row.quantity,
          ],
        ),
      ).toEqual([
        ["fire_rune", 60],
        ["lobster", 1],
        ["lobster", 1],
        ["mind_rune", 20],
        ["shortbow", 1],
        ["staff_of_air", 1],
      ]);
      expect(atomicPlan.mock.calls[0][0].committed.bank).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemId: "bronze_arrow",
            quantity: 500 - expectedArrowReserve,
          }),
        ]),
      );
      expect(instance.duelPreparation.strategy).toEqual({
        primaryStyle: "melee",
        availableStyles: ["melee", "ranged", "mage"],
        opponentHistorySampleSize: 0,
        defensiveFocus: null,
        weaponId: "test_prep_sword",
        ammunitionId: null,
        spellId: null,
        foodItemId: "lobster",
        foodQuantity: 2,
        tacticalStrategy: {
          approach: "balanced",
          tacticalMacro: "pressure",
          attackStyle: "aggressive",
          prayer: null,
          preferredCombatRole: null,
          foodThreshold: 40,
          switchDefensiveAt: 30,
          reasoning: "Use the deterministic role-aware competitive fallback.",
        },
        loadouts: {
          melee: {
            weaponId: "test_prep_sword",
            ammunitionId: null,
            spellId: null,
            armorIds: EMPTY_FROZEN_ARMOR_IDS,
          },
          ranged: {
            weaponId: "shortbow",
            ammunitionId: "bronze_arrow",
            spellId: null,
            armorIds: EMPTY_FROZEN_ARMOR_IDS,
          },
          mage: {
            weaponId: "staff_of_air",
            ammunitionId: null,
            spellId: "fire_strike",
            armorIds: EMPTY_FROZEN_ARMOR_IDS,
          },
        },
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-multistyle" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("refreshes persisted custody once and rebuilds an exact forged multi-style plan after live projection drift", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-forged-refresh",
      "agent-forged-refresh",
      "Forged Adaptive Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-forged-refresh",
        accountId: "acct-forged-refresh",
        name: "Forged Adaptive Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-forged-refresh");
      const gameState: EmbeddedGameState = {
        playerId: "agent-forged-refresh",
        position: [0, 9, 0],
        health: 40,
        maxHealth: 40,
        alive: true,
        skills: {
          attack: { level: 20, xp: 0 },
          strength: { level: 20, xp: 0 },
          defense: { level: 20, xp: 0 },
          constitution: { level: 40, xp: 0 },
          ranged: { level: 20, xp: 0 },
          magic: { level: 40, xp: 0 },
        },
        inventory: [
          { slot: 0, itemId: "shortbow", quantity: 1 },
          { slot: 1, itemId: "lobster", quantity: 1 },
          { slot: 2, itemId: "lobster", quantity: 1 },
          { slot: 3, itemId: "lobster", quantity: 1 },
          { slot: 4, itemId: "lobster", quantity: 1 },
        ],
        equipment: {
          weapon: { itemId: "bronze_shortsword", quantity: 1 },
          arrows: { itemId: "bronze_arrow", quantity: 500 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      };
      const service = instance.service as EmbeddedHyperiaService;
      vi.spyOn(service, "getGameState").mockReturnValue(gameState);
      const bankItems = [
        { itemId: "staff_of_air", quantity: 1, slot: 0, tabIndex: 0 },
        { itemId: "fire_rune", quantity: 500, slot: 1, tabIndex: 0 },
        { itemId: "mind_rune", quantity: 500, slot: 2, tabIndex: 0 },
      ];
      const bankOpen = vi
        .spyOn(service, "executeDuelPreparationBankOpen")
        .mockResolvedValue({
          success: true,
          operationId: "open-forged-refresh",
          commitState: "not_applicable",
          replayed: false,
          action: "open",
          playerId: "agent-forged-refresh",
          bankId: "duel-preparation:f52b5a3f-dca7-47a8-a8f6-7514eef8ef6f",
          itemId: null,
          requestedQuantity: 0,
          committedQuantity: 0,
          inventoryQuantityAfter: null,
          bankQuantityAfter: null,
          bankItems,
        });
      const refresh = vi
        .spyOn(service, "executeDuelPreparationCustodyRefresh")
        .mockResolvedValue(true);
      const atomicPlan = vi
        .spyOn(service, "executeDuelPreparationPlan")
        .mockImplementationOnce(async (request: any) => ({
          ok: false,
          playerId: "agent-forged-refresh",
          operationId: request.operationId,
          preparationId: request.preparationId,
          changed: false,
          replayed: false,
          reason: "custody_violation",
        }))
        .mockImplementationOnce(async (request: any) => ({
          ok: true,
          playerId: "agent-forged-refresh",
          operationId: request.operationId,
          preparationId: request.preparationId,
          requestFingerprint: "refreshed-plan-fingerprint",
          changed: true,
          replayed: false,
          committed: request.committed,
          recoveryEvidence: request.recoveryEvidence,
        }));

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "f52b5a3f-dca7-47a8-a8f6-7514eef8ef6f",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-forged-refresh",
        agent2Id: "agent-opponent",
      });

      expect(refresh).toHaveBeenCalledOnce();
      expect(bankOpen).toHaveBeenCalledTimes(2);
      expect(atomicPlan).toHaveBeenCalledTimes(2);
      const committed = (
        atomicPlan.mock.calls[1]![0] as DuelPreparationPlanExecutionRequest
      ).committed;
      const owned = new Map<string, number>();
      for (const row of [
        ...committed.bank,
        ...committed.inventory,
        ...committed.equipment,
      ]) {
        owned.set(row.itemId, (owned.get(row.itemId) ?? 0) + row.quantity);
      }
      expect(Object.fromEntries(owned)).toMatchObject({
        bronze_shortsword: 1,
        shortbow: 1,
        bronze_arrow: 500,
        staff_of_air: 1,
        fire_rune: 500,
        mind_rune: 500,
        lobster: 4,
      });
      expect(instance.duelPreparation).toMatchObject({
        status: "planning",
        failureReason: null,
        strategy: {
          availableStyles: expect.arrayContaining(["melee", "ranged", "mage"]),
        },
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.objectContaining({ agentId: "agent-forged-refresh" }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fails closed after one persisted-custody refresh when the rebuilt plan still mismatches", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-refresh-bound",
      "agent-refresh-bound",
      "Bounded Refresh Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-refresh-bound",
        accountId: "acct-refresh-bound",
        name: "Bounded Refresh Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-refresh-bound");
      const service = instance.service as EmbeddedHyperiaService;
      vi.spyOn(service, "getGameState").mockReturnValue({
        playerId: "agent-refresh-bound",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 20, xp: 0 },
          strength: { level: 20, xp: 0 },
          defense: { level: 20, xp: 0 },
          constitution: { level: 20, xp: 0 },
          ranged: { level: 1, xp: 0 },
          magic: { level: 1, xp: 0 },
        },
        inventory: [],
        equipment: {
          weapon: { itemId: "bronze_shortsword", quantity: 1 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      const bankOpen = vi
        .spyOn(service, "executeDuelPreparationBankOpen")
        .mockResolvedValue({
          success: true,
          operationId: "open-refresh-bound",
          commitState: "not_applicable",
          replayed: false,
          action: "open",
          playerId: "agent-refresh-bound",
          bankId: "duel-preparation:77644faf-a82a-4826-838f-da4fc86cc7c7",
          itemId: null,
          requestedQuantity: 0,
          committedQuantity: 0,
          inventoryQuantityAfter: null,
          bankQuantityAfter: null,
          bankItems: [],
        });
      const refresh = vi
        .spyOn(service, "executeDuelPreparationCustodyRefresh")
        .mockResolvedValue(true);
      const atomicPlan = vi
        .spyOn(service, "executeDuelPreparationPlan")
        .mockImplementation(async (request) => ({
          ok: false,
          playerId: "agent-refresh-bound",
          operationId: request.operationId,
          preparationId: request.preparationId,
          changed: false,
          replayed: false,
          reason: "custody_violation",
        }));

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "77644faf-a82a-4826-838f-da4fc86cc7c7",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-refresh-bound",
        agent2Id: "agent-opponent",
      });

      expect(refresh).toHaveBeenCalledOnce();
      expect(bankOpen).toHaveBeenCalledTimes(2);
      expect(atomicPlan).toHaveBeenCalledTimes(2);
      expect(instance.duelPreparation).toMatchObject({
        status: "failed",
        failureReason: "custody_violation",
      });
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.anything(),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("lets a validated ElizaOS preference choose the opening role while preserving every legal alternative, including a displaced equipped weapon", async () => {
    vi.stubEnv("EMBEDDED_AGENT_DUEL_PREPARATION_LLM", "true");
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-model-prep",
      "agent-model-prep",
      "Adaptive Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-model-prep",
        accountId: "acct-model-prep",
        name: "Adaptive Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-model-prep");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-model-prep",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 20, xp: 0 },
          strength: { level: 20, xp: 0 },
          ranged: { level: 10, xp: 0 },
          magic: { level: 1, xp: 0 },
          prayer: { level: 26, xp: 0 },
        },
        inventory: [],
        equipment: {
          weapon: { itemId: "test_prep_sword", quantity: 1 },
        },
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
        prayerPointUnits: 26_000_000,
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "bronze_arrow", quantity: 60, slot: 1, tabIndex: 0 },
          { itemId: "test_prep_shield", quantity: 1, slot: 2, tabIndex: 0 },
          {
            itemId: "test_prep_ranged_body",
            quantity: 1,
            slot: 3,
            tabIndex: 0,
          },
          {
            itemId: "test_prep_melee_body",
            quantity: 1,
            slot: 4,
            tabIndex: 0,
          },
        ],
      });
      const useModel = vi.fn(async (..._args: unknown[]) =>
        Promise.resolve(
          JSON.stringify({
            primaryStyle: "ranged",
            reason: "Open with mobility against this opponent.",
            tacticalStrategy: {
              approach: "balanced",
              tacticalMacro: "kite",
              attackStyle: "accurate",
              prayer: "hawk_eye",
              preferredCombatRole: null,
              foodThreshold: 35,
              switchDefensiveAt: 25,
              reasoning: "Use frozen spacing macros and adapt visible roles.",
            },
          }),
        ),
      );
      instance.chatRuntime = { useModel, stop: vi.fn(async () => undefined) };
      instance.chatRuntimeInfo = {
        provider: "openai",
        model: "test/model",
        source: "test",
      };
      instance.chatRuntimeConfigSig = "test-runtime-config";
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      vi.spyOn(instance.service, "executeSetAutocast").mockResolvedValue(true);
      const atomicPlan = vi.mocked(instance.service.executeDuelPreparationPlan);

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "fcbdc73f-834a-4622-a707-952881ae853a",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-model-prep",
        agent1Name: "Adaptive Agent",
        agent2Id: "agent-opponent",
        agent2Name: "Pressure Agent",
      });

      expect(useModel).toHaveBeenCalledOnce();
      const modelOptions = useModel.mock.calls[0]?.[1] as
        { prompt?: unknown } | undefined;
      const prompt = String(modelOptions?.prompt);
      expect(prompt).toContain("Pressure Agent");
      expect(prompt).toContain('["melee","ranged"]');
      expect(prompt).not.toContain("test_prep_sword");
      expect(prompt).not.toContain("shortbow");
      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(atomicPlan.mock.calls[0][0].committed.equipment).toEqual([
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 60 },
        { slotType: "body", itemId: "test_prep_ranged_body", quantity: 1 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ]);
      expect(atomicPlan.mock.calls[0][0].committed.inventory).toHaveLength(3);
      expect(atomicPlan.mock.calls[0][0].committed.inventory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemId: "test_prep_melee_body",
            quantity: 1,
          }),
          expect.objectContaining({ itemId: "test_prep_shield", quantity: 1 }),
          expect.objectContaining({ itemId: "test_prep_sword", quantity: 1 }),
        ]),
      );
      expect(instance.duelPreparation.strategy).toMatchObject({
        primaryStyle: "ranged",
        availableStyles: ["ranged", "melee"],
        weaponId: "shortbow",
        ammunitionId: "bronze_arrow",
        loadouts: {
          ranged: {
            weaponId: "shortbow",
            armorIds: expect.objectContaining({
              body: "test_prep_ranged_body",
            }),
          },
          melee: {
            weaponId: "test_prep_sword",
            armorIds: expect.objectContaining({
              body: "test_prep_melee_body",
            }),
          },
        },
        tacticalStrategy: {
          tacticalMacro: "kite",
          preferredCombatRole: null,
          foodThreshold: 35,
        },
      });
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          agentId: "agent-model-prep",
          primaryStyle: "ranged",
          planningSource: "model",
          planningPolicyVersion: "duel-preparation-role-v3",
          tacticalMacro: "kite",
        }),
      );
      const readyPayload = ctx.world.emit.mock.calls.find(
        ([event]) => event === "duel:preparation:ready",
      )?.[1] as
        | {
            planEvidence?: {
              agentPolicyFingerprint?: string;
              modelProvider?: string;
              model?: string;
            };
          }
        | undefined;
      const frozenBinding = manager.getCompetitiveAgentPolicyBinding(
        "agent-model-prep",
        "duel-preparation-role-v3",
      );
      expect(readyPayload?.planEvidence).toMatchObject({
        agentPolicyFingerprint: frozenBinding?.fingerprint,
        modelProvider: frozenBinding?.provider,
        model: frozenBinding?.model,
      });
      instance.chatRuntimeInfo = {
        ...instance.chatRuntimeInfo,
        model: "test/changed-model",
      };
      expect(
        manager.getCompetitiveAgentPolicyBinding(
          "agent-model-prep",
          "duel-preparation-role-v3",
        )?.fingerprint,
      ).not.toBe(frozenBinding?.fingerprint);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("never changes competitive equipment when the complete bank plan does not commit", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-bank-failure",
      "agent-bank-failure",
      "Safe Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-bank-failure",
        accountId: "acct-bank-failure",
        name: "Safe Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-bank-failure");
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: "agent-bank-failure",
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: {
          attack: { level: 20, xp: 0 },
          strength: { level: 20, xp: 0 },
          ranged: { level: 15, xp: 0 },
          magic: { level: 1, xp: 0 },
        },
        inventory: [],
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [
          { itemId: "test_prep_sword", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "shortbow", quantity: 1, slot: 1, tabIndex: 0 },
          { itemId: "bronze_arrow", quantity: 50, slot: 2, tabIndex: 0 },
        ],
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const autocast = vi.spyOn(instance.service, "executeSetAutocast");
      const atomicPlan = vi
        .spyOn(instance.service, "executeDuelPreparationPlan")
        .mockImplementation(async (request: any) => ({
          ok: false,
          playerId: "agent-bank-failure",
          operationId: request.operationId,
          preparationId: request.preparationId,
          changed: false,
          replayed: false,
          reason: "persistence_failed",
        }));

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "6425b0d0-5c32-4313-8728-dd2e38a92ed3",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-bank-failure",
        agent2Id: "agent-opponent",
      });

      expect(withdraw).not.toHaveBeenCalled();
      expect(atomicPlan).toHaveBeenCalledOnce();
      expect(instance.duelPreparation).toMatchObject({
        status: "failed",
        failureReason: "persistence_failed",
      });
      expect(equip).not.toHaveBeenCalled();
      expect(autocast).not.toHaveBeenCalled();
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.anything(),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it.each([
    {
      label: "a ranged weapon without compatible ammunition",
      accountId: "acct-incomplete-ranged",
      characterId: "agent-incomplete-ranged",
      preparationId: "338017b9-f772-4f9e-a575-f71b99a9d843",
      skills: {
        attack: { level: 1, xp: 0 },
        strength: { level: 1, xp: 0 },
        ranged: { level: 10, xp: 0 },
        magic: { level: 1, xp: 0 },
      },
      bankItems: [{ itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 }],
    },
    {
      label: "a magic weapon without the required runes",
      accountId: "acct-incomplete-magic",
      characterId: "agent-incomplete-magic",
      preparationId: "4a20b3e2-f340-4526-92da-63165dbb0e3f",
      skills: {
        attack: { level: 1, xp: 0 },
        strength: { level: 1, xp: 0 },
        ranged: { level: 1, xp: 0 },
        magic: { level: 13, xp: 0 },
      },
      bankItems: [
        { itemId: "staff_of_air", quantity: 1, slot: 0, tabIndex: 0 },
        { itemId: "fire_rune", quantity: 60, slot: 1, tabIndex: 0 },
      ],
    },
  ])("fails closed for $label", async (fixture) => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      fixture.accountId,
      fixture.characterId,
      "Incomplete Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: fixture.characterId,
        accountId: fixture.accountId,
        name: "Incomplete Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get(fixture.characterId);
      vi.spyOn(instance.service, "getGameState").mockReturnValue({
        playerId: fixture.characterId,
        position: [0, 9, 0],
        health: 20,
        maxHealth: 20,
        alive: true,
        skills: fixture.skills,
        inventory: [],
        equipment: {},
        nearbyEntities: [],
        inCombat: false,
        currentTarget: null,
        activePrayers: [],
      });
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: fixture.bankItems,
      });
      const withdraw = vi.spyOn(instance.service, "executeBankWithdraw");
      const equip = vi.spyOn(instance.service, "executeEquip");
      const autocast = vi.spyOn(instance.service, "executeSetAutocast");

      await (manager as any).handleDuelPreparationSelected({
        preparationId: fixture.preparationId,
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: fixture.characterId,
        agent2Id: "agent-opponent",
      });

      expect(instance.duelPreparation).toMatchObject({
        status: "failed",
        failureReason: "no_complete_owned_combat_setup",
      });
      expect(withdraw).not.toHaveBeenCalled();
      expect(equip).not.toHaveBeenCalled();
      expect(autocast).not.toHaveBeenCalled();
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.anything(),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fails closed when the selected agent owns no legal preparation weapon", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-unarmed", "agent-unarmed", "Unarmed Agent");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-unarmed",
        accountId: "acct-unarmed",
        name: "Unarmed Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-unarmed");
      vi.spyOn(
        instance.service,
        "executeDuelPreparationBankOpen",
      ).mockResolvedValue({
        success: true,
        bankItems: [],
      });
      const revoke = vi.spyOn(
        instance.service,
        "revokeDuelPreparationBankAccess",
      );

      await (manager as any).handleDuelPreparationSelected({
        preparationId: "6ecb99d2-3a66-461e-a74a-3fd90e0d7551",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-unarmed",
        agent2Id: "agent-opponent",
      });

      expect(instance.duelPreparation).toMatchObject({
        status: "failed",
        failureReason: "no_owned_legal_weapon",
      });
      expect(revoke).toHaveBeenCalledWith(
        "6ecb99d2-3a66-461e-a74a-3fd90e0d7551",
      );
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:ready",
        expect.anything(),
      );
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          status: "failed",
          failureReason: "no_owned_legal_weapon",
        }),
      );
      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          agentId: "agent-opponent",
          status: "failed",
          failureReason: "agent_unavailable",
        }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("does not report external contestants as unavailable merely because this manager does not own them", async () => {
    const ctx = createMockWorld(9);
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      const preparationId = "e8f6a902-b29d-4db5-a6cc-4370d4b37bde";

      await (manager as any).handleDuelPreparationSelected({
        preparationId,
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "external-agent-alpha",
        agent2Id: "external-agent-beta",
      });

      expect(ctx.world.emit).not.toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          preparationId,
          status: "failed",
          failureReason: "agent_unavailable",
        }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("releases both local agents when their shared preparation authority is revoked", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter("acct-alpha", "agent-alpha", "Alpha");
    ctx.registerCharacter("acct-beta", "agent-beta", "Beta");
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });

    try {
      await manager.createAgent({
        characterId: "agent-alpha",
        accountId: "acct-alpha",
        name: "Alpha",
        autoStart: true,
      });
      await manager.createAgent({
        characterId: "agent-beta",
        accountId: "acct-beta",
        name: "Beta",
        autoStart: true,
      });
      const preparationId = "2ffca39d-3041-45fc-a2cc-239c7a12368f";
      const instances = (manager as any).agents as Map<string, any>;
      const alpha = instances.get("agent-alpha");
      const beta = instances.get("agent-beta");
      const alphaRevoke = vi.spyOn(
        alpha.service,
        "revokeDuelPreparationBankAccess",
      );
      const betaRevoke = vi.spyOn(
        beta.service,
        "revokeDuelPreparationBankAccess",
      );
      for (const instance of [alpha, beta]) {
        instance.duelPreparation = {
          preparationId,
          status: "planning",
        };
        instance.goal = { type: "banking", description: "prepare" };
      }

      expect(ctx.world.on).toHaveBeenCalledWith(
        DUEL_PREPARATION_LOCAL_REVOCATION_EVENT,
        (manager as any).duelPreparationTerminalListener,
      );

      (manager as any).duelPreparationTerminalListener({ preparationId });

      expect(alpha.duelPreparation).toBeUndefined();
      expect(beta.duelPreparation).toBeUndefined();
      expect(alpha.goal).toBeNull();
      expect(beta.goal).toBeNull();
      expect(alphaRevoke).toHaveBeenCalledWith(preparationId);
      expect(betaRevoke).toHaveBeenCalledWith(preparationId);
      expect((manager as any).preparationActivities.size).toBe(0);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it.each([
    { transition: "pause", stateLabel: "paused" },
    { transition: "stop", stateLabel: "stopped" },
    { transition: "remove", stateLabel: "removed" },
  ] as const)(
    "fails and revokes an active preparation when its agent is $stateLabel",
    async ({ transition }) => {
      vi.stubEnv("DISABLE_AI", "true");
      const ctx = createMockWorld(9);
      const characterId = `agent-${transition}`;
      ctx.registerCharacter(`acct-${transition}`, characterId, transition);
      const manager = new AgentManager(ctx.world as never, {
        startBehaviorBridge: false,
      });
      try {
        await manager.createAgent({
          characterId,
          accountId: `acct-${transition}`,
          name: transition,
          autoStart: true,
        });
        const preparationId =
          transition === "pause"
            ? "1f8a9e89-7408-4e86-9f6f-9d8d95de98b1"
            : transition === "stop"
              ? "43c55b44-d4c7-48b7-b6f5-c3477d46001b"
              : "7eb56dc9-9251-4263-8cb1-69dbe305ffbf";
        const instance = (manager as any).agents.get(characterId);
        instance.duelPreparation = {
          preparationId,
          status: "planning",
        };
        instance.goal = { type: "banking", description: "prepare" };
        const originalGetSystem = ctx.world.getSystem.getMockImplementation()!;
        (ctx.world.getSystem as any).mockImplementation((name: string) => {
          const system = originalGetSystem(name);
          if (name !== "database") return system;
          return {
            ...(system as object),
            getDb: () => ({}),
            getPool: () => ({}),
          };
        });
        const report = vi
          .spyOn(
            PostgresDuelPreparationStore.prototype,
            "reportContestantUnavailable",
          )
          .mockResolvedValue({
            preparationId,
            agentId: characterId,
            reason: "agent_unavailable",
            reportedAt: Date.now(),
          });
        const revoke = vi.spyOn(
          instance.service,
          "revokeDuelPreparationBankAccess",
        );

        if (transition === "pause") {
          await manager.pauseAgent(characterId);
        } else if (transition === "stop") {
          await manager.stopAgent(characterId);
        } else {
          await manager.removeAgent(characterId);
        }

        expect(instance.duelPreparation).toMatchObject({
          preparationId,
          status: "failed",
          failureReason: "agent_unavailable",
        });
        expect(revoke).toHaveBeenCalledWith(preparationId);
        expect(ctx.world.emit).toHaveBeenCalledWith(
          "duel:preparation:agent_plan_status",
          expect.objectContaining({
            preparationId,
            agentId: characterId,
            status: "failed",
            failureReason: "agent_unavailable",
          }),
        );
        expect(report).toHaveBeenCalledWith({
          preparationId,
          agentId: characterId,
        });
        expect(manager.hasAgent(characterId)).toBe(transition !== "remove");
      } finally {
        await forceTestShutdown(manager);
      }
    },
  );

  it("refuses to stop an active preparation contestant without shared persistence", async () => {
    vi.stubEnv("DISABLE_AI", "true");
    const ctx = createMockWorld(9);
    const characterId = "agent-unavailability-persistence-missing";
    ctx.registerCharacter(
      "acct-unavailability-persistence-missing",
      characterId,
      "Unavailable Persistence",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId,
        accountId: "acct-unavailability-persistence-missing",
        name: "Unavailable Persistence",
        autoStart: true,
      });
      const preparationId = "779367c8-208f-4848-b54f-c9fe4c2164d7";
      const instance = (manager as any).agents.get(characterId);
      instance.duelPreparation = {
        preparationId,
        status: "planning",
      };

      await expect(manager.stopAgent(characterId)).rejects.toThrow(
        "duel_preparation_unavailability_persistence_unavailable",
      );

      expect(instance.state).toBe("running");
      expect(instance.duelPreparation).toMatchObject({
        preparationId,
        status: "failed",
        failureReason: "agent_unavailable",
      });
      instance.duelPreparation = undefined;
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("keeps graceful shutdown retryable until every active preparation report is durable", async () => {
    vi.stubEnv("DISABLE_AI", "true");
    const ctx = createMockWorld(9);
    const characterId = "agent-retryable-shutdown";
    ctx.registerCharacter(
      "acct-retryable-shutdown",
      characterId,
      "Retryable Shutdown",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    let completed = false;
    try {
      await manager.createAgent({
        characterId,
        accountId: "acct-retryable-shutdown",
        name: "Retryable Shutdown",
        autoStart: true,
      });
      const preparationId = "3fd1194b-e51f-494b-a938-940eaf754421";
      const instance = (manager as any).agents.get(characterId);
      instance.duelPreparation = {
        preparationId,
        status: "planning",
      };

      const shutdowns = await Promise.allSettled([
        manager.shutdown(),
        manager.shutdown(),
      ]);
      expect(shutdowns).toHaveLength(2);
      for (const shutdown of shutdowns) {
        expect(shutdown.status).toBe("rejected");
        expect(
          shutdown.status === "rejected"
            ? String(shutdown.reason?.message ?? shutdown.reason)
            : "",
        ).toContain(`AgentManager shutdown failed closed for: ${characterId}`);
      }

      expect(manager.hasAgent(characterId)).toBe(true);
      expect(instance.state).toBe("running");
      expect((manager as any).isShuttingDown).toBe(false);
      expect((manager as any).shutdownPromise).toBeNull();
      expect(ctx.world.off).not.toHaveBeenCalled();

      const originalGetSystem = ctx.world.getSystem.getMockImplementation()!;
      (ctx.world.getSystem as any).mockImplementation((name: string) => {
        const system = originalGetSystem(name);
        if (name !== "database") return system;
        return {
          ...(system as object),
          getDb: () => ({}),
          getPool: () => ({}),
        };
      });
      const report = vi
        .spyOn(
          PostgresDuelPreparationStore.prototype,
          "reportContestantUnavailable",
        )
        .mockResolvedValue({
          preparationId,
          agentId: characterId,
          reason: "agent_unavailable",
          reportedAt: Date.now(),
        });

      await manager.shutdown();

      expect(report).toHaveBeenCalledWith({
        preparationId,
        agentId: characterId,
      });
      expect(manager.hasAgent(characterId)).toBe(false);
      expect(ctx.world.off).toHaveBeenCalled();
      completed = true;
    } finally {
      if (!completed) await forceTestShutdown(manager);
    }
  });

  it("fails closed before pausing until cross-process unavailability is durable, then retries the exact report", async () => {
    vi.stubEnv("DISABLE_AI", "true");
    const ctx = createMockWorld(9);
    const characterId = "agent-durable-unavailability";
    ctx.registerCharacter(
      "acct-durable-unavailability",
      characterId,
      "Durable Unavailability",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId,
        accountId: "acct-durable-unavailability",
        name: "Durable Unavailability",
        autoStart: true,
      });
      const preparationId = "4d88d573-1dd9-49e6-b35a-1ee5c9923204";
      const instance = (manager as any).agents.get(characterId);
      instance.duelPreparation = {
        preparationId,
        status: "planning",
      };

      const originalGetSystem = ctx.world.getSystem.getMockImplementation()!;
      (ctx.world.getSystem as any).mockImplementation((name: string) => {
        const system = originalGetSystem(name);
        if (name !== "database") return system;
        return {
          ...(system as object),
          getDb: () => ({}),
          getPool: () => ({}),
        };
      });
      const report = vi
        .spyOn(
          PostgresDuelPreparationStore.prototype,
          "reportContestantUnavailable",
        )
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValue({
          preparationId,
          agentId: characterId,
          reason: "agent_unavailable",
          reportedAt: Date.now(),
        });

      await expect(manager.pauseAgent(characterId)).rejects.toThrow(
        "database unavailable",
      );
      expect(instance.state).toBe("running");
      expect(instance.duelPreparation).toMatchObject({
        preparationId,
        status: "failed",
        failureReason: "agent_unavailable",
      });

      await manager.pauseAgent(characterId);

      expect(report).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenNthCalledWith(1, {
        preparationId,
        agentId: characterId,
      });
      expect(report).toHaveBeenNthCalledWith(2, {
        preparationId,
        agentId: characterId,
      });
      expect(instance.state).toBe("paused");
      const failureEvents = ctx.world.emit.mock.calls.filter(
        (call: any[]) => call[0] === "duel:preparation:agent_plan_status",
      );
      expect(failureEvents).toHaveLength(1);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("keeps one exact private-preparation host lease alive and stops it at the terminal edge", async () => {
    vi.stubEnv("STREAMING_DUEL_PREPARATION_MS", "60000");
    (
      AgentManager.prototype as unknown as {
        beginDuelPreparationHostLease: ReturnType<typeof vi.fn>;
      }
    ).beginDuelPreparationHostLease.mockRestore();
    const ctx = createMockWorld(9);
    const characterId = "agent-host-lease-live";
    ctx.registerCharacter("acct-host-lease-live", characterId, "Lease Live");
    const originalGetSystem = ctx.world.getSystem.getMockImplementation()!;
    const pool = {};
    (ctx.world.getSystem as any).mockImplementation((name: string) => {
      const system = originalGetSystem(name);
      if (name !== "database") return system;
      return {
        ...(system as object),
        getDb: () => ({}),
        getPool: () => pool,
      };
    });
    const claim = vi
      .spyOn(PostgresDuelPreparationStore.prototype, "claimContestantHostLease")
      .mockImplementation(async (input) => ({
        ...input,
        executableBuildId: input.executableBuildId ?? null,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + input.leaseDurationMs,
      }));
    const heartbeat = vi
      .spyOn(
        PostgresDuelPreparationStore.prototype,
        "heartbeatContestantHostLease",
      )
      .mockImplementation(async (input) => ({
        ...input,
        executableBuildId: input.executableBuildId ?? null,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + input.leaseDurationMs,
      }));
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId,
        accountId: "acct-host-lease-live",
        name: "Lease Live",
        autoStart: true,
      });
      const preparationId = "bc1a2d5b-66f3-4329-a1ce-8d2854f5e662";
      const instance = (manager as any).agents.get(characterId);
      instance.duelPreparation = { preparationId, status: "planning" };

      await expect(
        (manager as any).beginDuelPreparationHostLease(instance, preparationId),
      ).resolves.toBe(true);
      expect(claim).toHaveBeenCalledOnce();
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(claim.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          preparationId,
          agentId: characterId,
          leaseDurationMs: 15_000,
          ownerId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          executableBuildId: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      );
      expect(heartbeat.mock.calls[0]?.[0].ownerId).toBe(
        claim.mock.calls[0]?.[0].ownerId,
      );
      expect((manager as any).duelPreparationHostLeaseHeartbeats.size).toBe(1);

      (manager as any).duelPreparationReadinessListener({
        preparationId,
        agentId: characterId,
      });
      expect(instance.duelPreparation).toMatchObject({
        preparationId,
        status: "ready",
      });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(heartbeat.mock.calls[1]?.[0]).toEqual(
        heartbeat.mock.calls[0]?.[0],
      );
      expect(instance.duelPreparation).toMatchObject({
        preparationId,
        status: "ready",
      });

      (manager as any).duelPreparationTerminalListener({ preparationId });
      expect((manager as any).duelPreparationHostLeaseHeartbeats.size).toBe(0);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("retries the complete private-preparation host lease handshake after a serialization conflict", async () => {
    vi.stubEnv("STREAMING_DUEL_PREPARATION_MS", "60000");
    (
      AgentManager.prototype as unknown as {
        beginDuelPreparationHostLease: ReturnType<typeof vi.fn>;
      }
    ).beginDuelPreparationHostLease.mockRestore();
    const ctx = createMockWorld(9);
    const characterId = "agent-host-lease-conflict";
    ctx.registerCharacter(
      "acct-host-lease-conflict",
      characterId,
      "Lease Conflict",
    );
    const originalGetSystem = ctx.world.getSystem.getMockImplementation()!;
    const pool = {};
    (ctx.world.getSystem as any).mockImplementation((name: string) => {
      const system = originalGetSystem(name);
      if (name !== "database") return system;
      return {
        ...(system as object),
        getDb: () => ({}),
        getPool: () => pool,
      };
    });
    const claim = vi
      .spyOn(PostgresDuelPreparationStore.prototype, "claimContestantHostLease")
      .mockImplementation(async (input) => ({
        ...input,
        executableBuildId: input.executableBuildId ?? null,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + input.leaseDurationMs,
      }));
    const conflict = Object.assign(
      new Error("could not serialize access due to read/write dependencies"),
      { code: "40001" },
    );
    const heartbeat = vi
      .spyOn(
        PostgresDuelPreparationStore.prototype,
        "heartbeatContestantHostLease",
      )
      .mockRejectedValueOnce(conflict)
      .mockImplementation(async (input) => ({
        ...input,
        executableBuildId: input.executableBuildId ?? null,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + input.leaseDurationMs,
      }));
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId,
        accountId: "acct-host-lease-conflict",
        name: "Lease Conflict",
        autoStart: true,
      });
      const preparationId = "cb68bd13-340b-499b-a2ae-64b43d358d3c";
      const instance = (manager as any).agents.get(characterId);
      instance.duelPreparation = { preparationId, status: "planning" };

      const leasePromise = (manager as any).beginDuelPreparationHostLease(
        instance,
        preparationId,
      );
      await vi.advanceTimersByTimeAsync(10);

      await expect(leasePromise).resolves.toBe(true);
      expect(claim).toHaveBeenCalledTimes(2);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(claim.mock.calls[1]?.[0]).toEqual(claim.mock.calls[0]?.[0]);
      expect((manager as any).duelPreparationHostLeaseHeartbeats.size).toBe(1);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fails closed after exhausting private-preparation host lease conflict retries", async () => {
    vi.stubEnv("STREAMING_DUEL_PREPARATION_MS", "60000");
    (
      AgentManager.prototype as unknown as {
        beginDuelPreparationHostLease: ReturnType<typeof vi.fn>;
      }
    ).beginDuelPreparationHostLease.mockRestore();
    const ctx = createMockWorld(9);
    const characterId = "agent-host-lease-conflict-exhausted";
    ctx.registerCharacter(
      "acct-host-lease-conflict-exhausted",
      characterId,
      "Lease Conflict Exhausted",
    );
    const originalGetSystem = ctx.world.getSystem.getMockImplementation()!;
    const pool = {};
    (ctx.world.getSystem as any).mockImplementation((name: string) => {
      const system = originalGetSystem(name);
      if (name !== "database") return system;
      return {
        ...(system as object),
        getDb: () => ({}),
        getPool: () => pool,
      };
    });
    const conflict = Object.assign(
      new Error("could not serialize access due to read/write dependencies"),
      { code: "40001" },
    );
    const claim = vi
      .spyOn(PostgresDuelPreparationStore.prototype, "claimContestantHostLease")
      .mockRejectedValue(conflict);
    const heartbeat = vi.spyOn(
      PostgresDuelPreparationStore.prototype,
      "heartbeatContestantHostLease",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId,
        accountId: "acct-host-lease-conflict-exhausted",
        name: "Lease Conflict Exhausted",
        autoStart: true,
      });
      const preparationId = "8ed3d751-5c64-418b-a28a-7acbd5688b8d";
      const instance = (manager as any).agents.get(characterId);
      instance.duelPreparation = { preparationId, status: "planning" };

      const leasePromise = (manager as any).beginDuelPreparationHostLease(
        instance,
        preparationId,
      );
      const rejection = expect(leasePromise).rejects.toBe(conflict);
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(claim).toHaveBeenCalledTimes(5);
      expect(heartbeat).not.toHaveBeenCalled();
      expect((manager as any).duelPreparationHostLeaseHeartbeats.size).toBe(0);
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("fails and durably reports the contestant when its exact host lease is lost", async () => {
    vi.stubEnv("STREAMING_DUEL_PREPARATION_MS", "60000");
    (
      AgentManager.prototype as unknown as {
        beginDuelPreparationHostLease: ReturnType<typeof vi.fn>;
      }
    ).beginDuelPreparationHostLease.mockRestore();
    const ctx = createMockWorld(9);
    const characterId = "agent-host-lease-lost";
    ctx.registerCharacter("acct-host-lease-lost", characterId, "Lease Lost");
    const originalGetSystem = ctx.world.getSystem.getMockImplementation()!;
    const pool = {};
    (ctx.world.getSystem as any).mockImplementation((name: string) => {
      const system = originalGetSystem(name);
      if (name !== "database") return system;
      return {
        ...(system as object),
        getDb: () => ({}),
        getPool: () => pool,
      };
    });
    vi.spyOn(
      PostgresDuelPreparationStore.prototype,
      "claimContestantHostLease",
    ).mockImplementation(async (input) => ({
      ...input,
      executableBuildId: input.executableBuildId ?? null,
      claimedAt: Date.now(),
      heartbeatAt: Date.now(),
      expiresAt: Date.now() + input.leaseDurationMs,
    }));
    const heartbeat = vi
      .spyOn(
        PostgresDuelPreparationStore.prototype,
        "heartbeatContestantHostLease",
      )
      .mockImplementationOnce(async (input) => ({
        ...input,
        executableBuildId: input.executableBuildId ?? null,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + input.leaseDurationMs,
      }))
      .mockResolvedValueOnce(null);
    const report = vi
      .spyOn(
        PostgresDuelPreparationStore.prototype,
        "reportContestantUnavailable",
      )
      .mockImplementation(async (input) => ({
        ...input,
        reason: "agent_unavailable",
        reportedAt: Date.now(),
      }));
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId,
        accountId: "acct-host-lease-lost",
        name: "Lease Lost",
        autoStart: true,
      });
      const preparationId = "1f79e5c8-767f-45c6-9a24-b833a84e6be8";
      const instance = (manager as any).agents.get(characterId);
      instance.duelPreparation = { preparationId, status: "planning" };

      await expect(
        (manager as any).beginDuelPreparationHostLease(instance, preparationId),
      ).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(instance.duelPreparation).toMatchObject({
        preparationId,
        status: "failed",
        failureReason: "agent_unavailable",
      });
      expect(report).toHaveBeenCalledWith({
        preparationId,
        agentId: characterId,
      });
      expect((manager as any).duelPreparationHostLeaseHeartbeats.size).toBe(0);
      expect(ctx.world.emit).toHaveBeenCalledWith(
        "duel:preparation:agent_plan_status",
        expect.objectContaining({
          preparationId,
          agentId: characterId,
          status: "failed",
          failureReason: "agent_unavailable",
        }),
      );
    } finally {
      await forceTestShutdown(manager);
    }
  });

  it("recovers persisted readiness without reopening the agent bank", async () => {
    const ctx = createMockWorld(9);
    ctx.registerCharacter(
      "acct-recovered",
      "agent-recovered",
      "Recovered Agent",
    );
    const manager = new AgentManager(ctx.world as never, {
      startBehaviorBridge: false,
    });
    try {
      await manager.createAgent({
        characterId: "agent-recovered",
        accountId: "acct-recovered",
        name: "Recovered Agent",
        scriptedRole: "combat",
        autoStart: true,
      });
      const instance = (manager as any).agents.get("agent-recovered");
      const open = vi.spyOn(instance.service, "executeDuelPreparationBankOpen");
      const revoke = vi.spyOn(
        instance.service,
        "revokeDuelPreparationBankAccess",
      );
      const beginHostLease = vi.spyOn(
        manager as any,
        "beginDuelPreparationHostLease",
      );
      const emitActivity = vi.spyOn(manager as any, "emitPreparationActivity");

      const selection = {
        preparationId: "8619852c-221f-433e-837c-8c50f22f0d70",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1Id: "agent-recovered",
        agent1Ready: true,
        agent2Id: "agent-opponent",
        agent2Ready: false,
      };

      await (manager as any).handleDuelPreparationSelected(selection);
      await (manager as any).handleDuelPreparationSelected(selection);

      expect(instance.duelPreparation).toMatchObject({
        status: "ready",
        bankItems: [],
      });
      expect(beginHostLease).not.toHaveBeenCalled();
      expect(emitActivity).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenNthCalledWith(
        1,
        "8619852c-221f-433e-837c-8c50f22f0d70",
      );
      expect(revoke).toHaveBeenNthCalledWith(
        2,
        "8619852c-221f-433e-837c-8c50f22f0d70",
      );
      const failureEvents = ctx.world.emit.mock.calls.filter(
        (call: any[]) =>
          call[0] === "duel:preparation:agent_plan_status" &&
          call[1]?.status === "failed",
      );
      expect(failureEvents).toHaveLength(0);
    } finally {
      await forceTestShutdown(manager);
    }
  });
});
