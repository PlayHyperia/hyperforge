import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventType } from "@hyperforge/shared";
import { EmbeddedHyperiaService } from "../EmbeddedHyperiaService";
import { loadWorldProfileTestFixture } from "./worldProfileTestFixture";

beforeEach(loadWorldProfileTestFixture);

type TestEntity = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position?: {
    x: number;
    y: number;
    z: number;
    set: (x: number, y: number, z: number) => void;
  };
};

function createMockQuestSystem() {
  return {
    getActiveQuests: vi.fn().mockReturnValue([]),
    getQuestDefinition: vi.fn().mockReturnValue(undefined),
    getAllQuestDefinitions: vi.fn().mockReturnValue([]),
    getQuestStatus: vi.fn().mockReturnValue("not_started"),
    canStartQuest: vi.fn().mockReturnValue(true),
    completeQuest: vi.fn().mockResolvedValue(false),
    startQuest: vi.fn().mockResolvedValue(true),
  };
}

function createMockWorld(options?: {
  questSystem?: ReturnType<typeof createMockQuestSystem> | null;
  npcEntities?: Array<{
    id: string;
    name: string;
    npcType?: string;
    type?: string;
    position: [number, number, number];
  }>;
}) {
  const questSystem = options?.questSystem ?? null;
  const npcEntities = options?.npcEntities ?? [];

  const entities = new Map<string, TestEntity>();

  // Seed NPC entities
  for (const npc of npcEntities) {
    const pos = {
      x: npc.position[0],
      y: npc.position[1],
      z: npc.position[2],
      set(x: number, y: number, z: number) {
        pos.x = x;
        pos.y = y;
        pos.z = z;
      },
    };
    entities.set(npc.id, {
      id: npc.id,
      type: npc.type || "npc",
      data: {
        name: npc.name,
        npcType: npc.npcType || "quest_giver",
        type: npc.type || "npc",
        npcId: npc.id,
        position: [...npc.position],
      },
      position: pos,
    });
  }

  const emit = vi.fn();

  const world = {
    entities: {
      items: entities,
      get: (id: string) => entities.get(id),
      add: (entityData: Record<string, unknown>) => {
        const id = String(entityData.id);
        const rawPosition = Array.isArray(entityData.position)
          ? (entityData.position as [number, number, number])
          : [0, 0, 0];
        const position = {
          x: rawPosition[0],
          y: rawPosition[1],
          z: rawPosition[2],
          set(x: number, y: number, z: number) {
            position.x = x;
            position.y = y;
            position.z = z;
          },
        };
        const entity: TestEntity = {
          id,
          type: String(entityData.type ?? "object"),
          data: { ...entityData, position: [...rawPosition] },
          position,
        };
        entities.set(id, entity);
        return entity;
      },
      remove: (id: string) => {
        entities.delete(id);
      },
    },
    on: vi.fn(),
    off: vi.fn(),
    emit,
    getSystem: vi.fn((name: string) => {
      if (name === "quest") return questSystem;
      if (name === "database") {
        return {
          getCharactersAsync: async () => [
            { id: "agent-1", name: "TestAgent", avatar: null, wallet: null },
          ],
          getPlayerAsync: async () => null,
        };
      }
      if (name === "terrain") {
        return { getHeightAt: () => 10 };
      }
      return null;
    }),
    settings: {
      avatar: { url: "asset://avatars/test.vrm" },
    },
  };

  return { world, entities, emit };
}

async function createInitializedService(
  worldOptions?: Parameters<typeof createMockWorld>[0],
) {
  const ctx = createMockWorld(worldOptions);
  const service = new EmbeddedHyperiaService(
    ctx.world as never,
    "agent-1",
    "acct-1",
    "TestAgent",
  );
  await service.initialize();
  return { service, ...ctx };
}

describe("EmbeddedHyperiaService quest methods", () => {
  // =========================================================================
  // executeQuestComplete
  // =========================================================================
  describe("executeQuestComplete", () => {
    it("calls QuestSystem.completeQuest with correct playerId and questId", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.completeQuest.mockResolvedValue(true);

      const { service } = await createInitializedService({ questSystem });

      const result = await service.executeQuestComplete("goblin_slayer");

      expect(result).toBe(true);
      expect(questSystem.completeQuest).toHaveBeenCalledWith(
        "agent-1",
        "goblin_slayer",
      );
    });

    it("returns false when QuestSystem returns false (quest not ready)", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.completeQuest.mockResolvedValue(false);

      const { service } = await createInitializedService({ questSystem });

      const result = await service.executeQuestComplete("goblin_slayer");

      expect(result).toBe(false);
    });

    it("returns false when quest system is not available", async () => {
      const { service } = await createInitializedService({ questSystem: null });

      const result = await service.executeQuestComplete("goblin_slayer");

      expect(result).toBe(false);
    });

    it("returns false when agent is not active (stopped)", async () => {
      const questSystem = createMockQuestSystem();
      const { service } = await createInitializedService({ questSystem });

      await service.stop();

      const result = await service.executeQuestComplete("goblin_slayer");

      expect(result).toBe(false);
      expect(questSystem.completeQuest).not.toHaveBeenCalled();
    });

    it("returns false when questId is empty string", async () => {
      const questSystem = createMockQuestSystem();
      const { service } = await createInitializedService({ questSystem });

      const result = await service.executeQuestComplete("");

      expect(result).toBe(false);
      expect(questSystem.completeQuest).not.toHaveBeenCalled();
    });

    it("does NOT emit QUEST_COMPLETED event directly (QuestSystem handles that)", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.completeQuest.mockResolvedValue(true);

      const { service, emit } = await createInitializedService({ questSystem });

      await service.executeQuestComplete("goblin_slayer");

      const questCompletedEmits = emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EventType.QUEST_COMPLETED,
      );
      expect(questCompletedEmits.length).toBe(0);
    });
  });

  // =========================================================================
  // executeQuestAccept
  // =========================================================================
  describe("executeQuestAccept", () => {
    it("emits QUEST_START_ACCEPTED event with correct data", async () => {
      const { service, emit } = await createInitializedService();

      const result = await service.executeQuestAccept("goblin_slayer");

      expect(result).toBe(true);
      expect(emit).toHaveBeenCalledWith(EventType.QUEST_START_ACCEPTED, {
        playerId: "agent-1",
        questId: "goblin_slayer",
      });
    });

    it("returns false when questId is empty", async () => {
      const { service, emit } = await createInitializedService();

      const result = await service.executeQuestAccept("");

      expect(result).toBe(false);
      const questEmits = emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EventType.QUEST_START_ACCEPTED,
      );
      expect(questEmits.length).toBe(0);
    });

    it("returns false when not active", async () => {
      const { service } = await createInitializedService();
      await service.stop();

      const result = await service.executeQuestAccept("goblin_slayer");

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // getQuestState
  // =========================================================================
  describe("getQuestState", () => {
    it("returns empty array when not active", async () => {
      const questSystem = createMockQuestSystem();
      const { service } = await createInitializedService({ questSystem });
      await service.stop();

      const result = service.getQuestState();

      expect(result).toEqual([]);
    });

    it("returns empty array when quest system unavailable", async () => {
      const { service } = await createInitializedService({ questSystem: null });

      const result = service.getQuestState();

      expect(result).toEqual([]);
    });

    it("returns empty array when no active quests", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.getActiveQuests.mockReturnValue([]);

      const { service } = await createInitializedService({ questSystem });

      const result = service.getQuestState();

      expect(result).toEqual([]);
    });

    it("returns quest progress with stage details", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.getActiveQuests.mockReturnValue([
        {
          questId: "goblin_slayer",
          status: "in_progress",
          currentStage: "kill_goblins",
          stageProgress: { kills: 7 },
        },
      ]);
      questSystem.getQuestDefinition.mockReturnValue({
        id: "goblin_slayer",
        name: "Goblin Slayer",
        description: "Kill goblins",
        startNpc: "captain_rowan",
        stages: [
          { id: "start", type: "dialogue", description: "Talk to Captain" },
          {
            id: "kill_goblins",
            type: "kill",
            description: "Kill 15 goblins",
            target: "goblin",
            count: 15,
          },
          { id: "return", type: "dialogue", description: "Return to Captain" },
        ],
      });

      const { service } = await createInitializedService({ questSystem });

      const result = service.getQuestState();

      expect(result).toHaveLength(1);
      expect(result[0].questId).toBe("goblin_slayer");
      expect(result[0].name).toBe("Goblin Slayer");
      expect(result[0].status).toBe("in_progress");
      expect(result[0].currentStage).toBe("kill_goblins");
      expect(result[0].stageDescription).toBe("Kill 15 goblins");
      expect(result[0].stageType).toBe("kill");
      expect(result[0].stageTarget).toBe("goblin");
      expect(result[0].stageCount).toBe(15);
      expect(result[0].stageProgress).toEqual({ kills: 7 });
      expect(result[0].startNpc).toBe("captain_rowan");
    });

    it("handles missing quest definition gracefully (uses questId as name)", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.getActiveQuests.mockReturnValue([
        {
          questId: "unknown_quest",
          status: "in_progress",
          currentStage: "step1",
          stageProgress: {},
        },
      ]);
      questSystem.getQuestDefinition.mockReturnValue(undefined);

      const { service } = await createInitializedService({ questSystem });

      const result = service.getQuestState();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("unknown_quest");
      expect(result[0].stageDescription).toBe("");
      expect(result[0].stageType).toBe("unknown");
      expect(result[0].startNpc).toBe("");
    });

    it("returns multiple active quests", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.getActiveQuests.mockReturnValue([
        {
          questId: "q1",
          status: "in_progress",
          currentStage: "s1",
          stageProgress: {},
        },
        {
          questId: "q2",
          status: "ready_to_complete",
          currentStage: "s2",
          stageProgress: { items: 5 },
        },
      ]);
      questSystem.getQuestDefinition.mockReturnValue(undefined);

      const { service } = await createInitializedService({ questSystem });

      const result = service.getQuestState();

      expect(result).toHaveLength(2);
      expect(result[0].questId).toBe("q1");
      expect(result[1].questId).toBe("q2");
      expect(result[1].status).toBe("ready_to_complete");
    });
  });

  // =========================================================================
  // getAvailableQuests
  // =========================================================================
  describe("getAvailableQuests", () => {
    it("returns empty when not active", async () => {
      const questSystem = createMockQuestSystem();
      const { service } = await createInitializedService({ questSystem });
      await service.stop();

      expect(service.getAvailableQuests()).toEqual([]);
    });

    it("returns empty when quest system unavailable", async () => {
      const { service } = await createInitializedService({ questSystem: null });

      expect(service.getAvailableQuests()).toEqual([]);
    });

    it("returns quest definitions with status", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.getAllQuestDefinitions.mockReturnValue([
        {
          id: "goblin_slayer",
          name: "Goblin Slayer",
          description: "Kill goblins",
          difficulty: "novice",
          startNpc: "captain_rowan",
          requirements: {
            quests: [],
            skills: { attack: 3 },
            items: ["bronze_shortsword"],
          },
          stages: [
            {
              id: "kill",
              type: "kill",
              description: "Kill goblins",
              target: "goblin",
              count: 15,
            },
          ],
          onStart: { items: [{ itemId: "bronze_shortsword", quantity: 1 }] },
          rewards: {
            questPoints: 1,
            items: [{ itemId: "xp_lamp", quantity: 1 }],
            xp: { attack: 500 },
          },
        },
      ]);
      questSystem.getQuestStatus.mockReturnValue("not_started");

      const { service } = await createInitializedService({ questSystem });

      const result = service.getAvailableQuests();

      expect(result).toHaveLength(1);
      expect(result[0].questId).toBe("goblin_slayer");
      expect(result[0].name).toBe("Goblin Slayer");
      expect(result[0].status).toBe("not_started");
      expect(result[0].canStart).toBe(true);
      expect(result[0].requirements).toEqual({
        quests: [],
        skills: { attack: 3 },
        items: ["bronze_shortsword"],
      });
      expect(questSystem.canStartQuest).toHaveBeenCalledWith(
        "agent-1",
        "goblin_slayer",
      );
      expect(result[0].startNpc).toBe("captain_rowan");
      expect(result[0].onStartItems).toEqual([
        { itemId: "bronze_shortsword", quantity: 1 },
      ]);
      expect(result[0].rewardItems).toEqual([
        { itemId: "xp_lamp", quantity: 1 },
      ]);
      expect(result[0].stages).toHaveLength(1);
      expect(result[0].stages[0].type).toBe("kill");
    });

    it("fails closed when the authoritative eligibility query rejects a quest", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.canStartQuest.mockReturnValue(false);
      questSystem.getAllQuestDefinitions.mockReturnValue([
        {
          id: "locked_quest",
          name: "Locked Quest",
          description: "Requires more training",
          difficulty: "novice",
          startNpc: "trainer",
          requirements: {
            quests: [],
            skills: { crafting: 7 },
            items: [],
          },
          stages: [],
          rewards: { questPoints: 0, items: [], xp: {} },
        },
      ]);

      const { service } = await createInitializedService({ questSystem });

      expect(service.getAvailableQuests()[0]).toMatchObject({
        questId: "locked_quest",
        status: "not_started",
        canStart: false,
      });
    });

    it("returns correct status for each quest (completed, in_progress, not_started)", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.getAllQuestDefinitions.mockReturnValue([
        {
          id: "q1",
          name: "Q1",
          description: "",
          difficulty: "novice",
          startNpc: "a",
          stages: [],
          rewards: { questPoints: 0, items: [], xp: {} },
        },
        {
          id: "q2",
          name: "Q2",
          description: "",
          difficulty: "novice",
          startNpc: "b",
          stages: [],
          rewards: { questPoints: 0, items: [], xp: {} },
        },
        {
          id: "q3",
          name: "Q3",
          description: "",
          difficulty: "novice",
          startNpc: "c",
          stages: [],
          rewards: { questPoints: 0, items: [], xp: {} },
        },
      ]);
      questSystem.getQuestStatus
        .mockReturnValueOnce("completed")
        .mockReturnValueOnce("in_progress")
        .mockReturnValueOnce("not_started");

      const { service } = await createInitializedService({ questSystem });

      const result = service.getAvailableQuests();

      expect(result[0].status).toBe("completed");
      expect(result[1].status).toBe("in_progress");
      expect(result[2].status).toBe("not_started");
    });

    it("handles quest with no onStart items", async () => {
      const questSystem = createMockQuestSystem();
      questSystem.getAllQuestDefinitions.mockReturnValue([
        {
          id: "q1",
          name: "Q1",
          description: "",
          difficulty: "novice",
          startNpc: "a",
          stages: [],
          rewards: { questPoints: 0, items: [], xp: {} },
        },
      ]);
      questSystem.getQuestStatus.mockReturnValue("not_started");

      const { service } = await createInitializedService({ questSystem });

      const result = service.getAvailableQuests();

      expect(result[0].onStartItems).toEqual([]);
    });
  });

  // =========================================================================
  // getAllNPCPositions
  // =========================================================================
  describe("getAllNPCPositions", () => {
    it("returns empty when not active", async () => {
      const { service } = await createInitializedService();
      await service.stop();

      expect(service.getAllNPCPositions()).toEqual([]);
    });

    it("returns NPC entities from world", async () => {
      const { service } = await createInitializedService({
        npcEntities: [
          {
            id: "captain_rowan",
            name: "Captain Rowan",
            npcType: "quest_giver",
            position: [50, 10, 30],
          },
          {
            id: "fisherman_pete",
            name: "Fisherman Pete",
            npcType: "quest_giver",
            position: [-100, 5, 200],
          },
        ],
      });

      const result = service.getAllNPCPositions();

      expect(result.length).toBeGreaterThanOrEqual(2);
      const captainEntry = result.find((n) => n.name === "Captain Rowan");
      expect(captainEntry).toBeDefined();
      expect(captainEntry!.position).toEqual([50, 10, 30]);

      const peteEntry = result.find((n) => n.name === "Fisherman Pete");
      expect(peteEntry).toBeDefined();
      expect(peteEntry!.position).toEqual([-100, 5, 200]);
    });

    it("excludes non-NPC entities", async () => {
      const { service, entities } = await createInitializedService();

      // Add a non-NPC entity
      const rawPos = [20, 5, 30] as [number, number, number];
      const position = {
        x: rawPos[0],
        y: rawPos[1],
        z: rawPos[2],
        set(x: number, y: number, z: number) {
          position.x = x;
          position.y = y;
          position.z = z;
        },
      };
      entities.set("tree-1", {
        id: "tree-1",
        type: "resource",
        data: {
          name: "Oak Tree",
          type: "resource",
          resourceType: "tree",
          position: [...rawPos],
        },
        position,
      });

      const result = service.getAllNPCPositions();

      const treeEntry = result.find((n) => n.name === "Oak Tree");
      expect(treeEntry).toBeUndefined();
    });

    it("returns NPC entities far from the agent (no distance filter)", async () => {
      const { service } = await createInitializedService({
        npcEntities: [
          {
            id: "far_npc",
            name: "Distant Wizard",
            npcType: "quest_giver",
            position: [9999, 10, 9999],
          },
        ],
      });

      const result = service.getAllNPCPositions();

      const farNpc = result.find((n) => n.name === "Distant Wizard");
      expect(farNpc).toBeDefined();
      expect(farNpc!.position).toEqual([9999, 10, 9999]);
    });
  });
});
