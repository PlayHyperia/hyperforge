import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createQuestSnapshot,
  validateQuestDefinition,
  type QuestDefinition,
  type QuestProgress,
  type QuestStatus,
} from "./quest-types";
import {
  canClaimQuest,
  calculateQuestProgress,
  isQuestListPayload,
  questFromSnapshot,
} from "../../../../client/src/game/systems/quest/questUtils";
import { useQuestSelectionStore } from "../../../../client/src/ui/stores/questStore";
import { subscribeQuestSnapshots } from "../../../../client/src/game/systems/quest/useQuestLog";
import { World } from "../../core/World";
import { ClientNetwork } from "../../systems/client/ClientNetwork";

function definition(): Record<string, unknown> {
  return {
    id: "receipt_quest",
    name: "Receipt Quest",
    description: "Validate exact completion rewards.",
    difficulty: "novice",
    questPoints: 1,
    replayable: false,
    requirements: { quests: [], skills: {}, items: [] },
    startNpc: "mentor",
    stages: [
      {
        id: "return_to_mentor",
        type: "dialogue",
        description: "Return to the mentor.",
      },
    ],
    onStart: { items: [{ itemId: "bronze_sword", quantity: 1 }] },
    rewards: {
      questPoints: 1,
      items: [{ itemId: "xp_lamp_100", quantity: 1 }],
      xp: { attack: 500, prayer: 100 },
    },
  };
}

describe("quest reward manifest validation", () => {
  it("accepts every current production quest reward shape", () => {
    const manifestPath = path.resolve(
      import.meta.dirname,
      "../../../../server/world/assets/manifests/quests.json",
    );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    for (const [questId, quest] of Object.entries(manifest)) {
      expect(validateQuestDefinition(questId, quest)).toEqual({
        valid: true,
        errors: [],
      });
    }
  });

  it("requires the two quest-point declarations to agree", () => {
    const quest = definition();
    (quest.rewards as Record<string, unknown>).questPoints = 2;
    expect(validateQuestDefinition("receipt_quest", quest)).toMatchObject({
      valid: false,
      errors: [expect.stringContaining("must match top-level 'questPoints'")],
    });
  });

  it("rejects unknown, zero, fractional, or oversized direct XP", () => {
    for (const xp of [
      { defence: 500 },
      { attack: 0 },
      { attack: 1.5 },
      { attack: 1_000_001 },
    ]) {
      const quest = definition();
      (quest.rewards as Record<string, unknown>).xp = xp;
      expect(validateQuestDefinition("receipt_quest", quest).valid).toBe(false);
    }
  });

  it("rejects duplicate, malformed, or impossible item reward entries", () => {
    for (const items of [
      [
        { itemId: "xp_lamp_100", quantity: 1 },
        { itemId: "xp_lamp_100", quantity: 1 },
      ],
      [{ itemId: "", quantity: 1 }],
      [{ itemId: "xp_lamp_100", quantity: 0 }],
      [{ itemId: "xp_lamp_100", quantity: 1.5 }],
    ]) {
      const quest = definition();
      (quest.rewards as Record<string, unknown>).items = items;
      expect(validateQuestDefinition("receipt_quest", quest).valid).toBe(false);
    }
  });
});

describe("authoritative quest journal projection", () => {
  function authored(): Record<string, QuestDefinition> {
    const manifestPath = process.env.ASSETS_DIR
      ? path.join(process.env.ASSETS_DIR, "manifests/quests.json")
      : path.resolve(
          import.meta.dirname,
          "../../../../server/world/assets/manifests/quests.json",
        );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as Record<string, QuestDefinition>;
    for (const [id, quest] of Object.entries(manifest))
      expect(validateQuestDefinition(id, quest)).toEqual({
        valid: true,
        errors: [],
      });
    return manifest;
  }

  function lumberjack(
    logs: number,
    fires = 0,
    status: QuestStatus = "in_progress",
  ) {
    const definition = authored().lumberjacks_first_lesson;
    const progress: QuestProgress = {
      playerId: "journal-test",
      questId: definition.id,
      status,
      currentStage:
        fires >= 6 ? "return" : logs >= 6 ? "burn_logs" : "chop_logs",
      stageProgress: { logs, fire: fires },
    };
    return createQuestSnapshot(definition, status, progress);
  }

  afterEach(() => {
    useQuestSelectionStore.getState().resetQuestList();
    useQuestSelectionStore.getState().clearSelectedQuest();
    useQuestSelectionStore.getState().setQuestStatuses([]);
  });

  it("preserves every authored required objective and its denominator before selection", () => {
    for (const definition of Object.values(authored())) {
      const snapshot = createQuestSnapshot(definition, "not_started");
      expect(isQuestListPayload({ quests: [snapshot], questPoints: 0 })).toBe(
        true,
      );
      const quest = questFromSnapshot(snapshot);
      const stages = definition.stages.filter(
        (stage) => stage.type !== "dialogue",
      );
      expect(
        quest.objectives.map(({ id, target }) => ({ id, target })),
      ).toEqual(stages.map(({ id, count }) => ({ id, target: count ?? 1 })));
      expect(calculateQuestProgress(quest)).toBe(0);
      expect(
        quest.objectives.every((objective) => objective.current === 0),
      ).toBe(true);
    }
  });

  it.each([
    [0, 0, "in_progress", 0],
    [1, 0, "in_progress", 8],
    [6, 0, "in_progress", 50],
    [6, 1, "in_progress", 58],
    [6, 6, "ready_to_complete", 100],
    [6, 6, "completed", 100],
  ] as const)(
    "projects logs=%i fires=%i status=%s as %i%%",
    (logs, fires, status, expected) => {
      const snapshot = lumberjack(logs, fires, status);
      const quest = questFromSnapshot(snapshot);
      expect(quest.objectives).toHaveLength(2);
      expect(calculateQuestProgress(quest)).toBe(expected);
      expect(quest.objectives[0].type).toBe("collect");
      expect(quest.state).toBe(status === "completed" ? "completed" : "active");
    },
  );

  it("uses retained future target progress and caps over-complete counts", () => {
    const quest = questFromSnapshot(lumberjack(1, 3));
    expect(quest.objectives.map((objective) => objective.current)).toEqual([
      1, 3,
    ]);
    expect(calculateQuestProgress(quest)).toBe(33);
    expect(calculateQuestProgress(questFromSnapshot(lumberjack(90, 90)))).toBe(
      100,
    );
  });

  it("uses authoritative kills and full authored ordering through return dialogue", () => {
    const definition = authored().goblin_slayer;
    const stage = definition.stages.find((entry) => entry.type === "kill")!;
    const progress: QuestProgress = {
      playerId: "journal-test",
      questId: definition.id,
      status: "in_progress",
      currentStage: stage.id,
      stageProgress: { kills: 3 },
    };
    expect(
      questFromSnapshot(
        createQuestSnapshot(definition, progress.status, progress),
      ).objectives[0].current,
    ).toBe(3);
    progress.currentStage = definition.stages.at(-1)!.id;
    expect(
      calculateQuestProgress(
        questFromSnapshot(
          createQuestSnapshot(definition, "ready_to_complete", progress),
        ),
      ),
    ).toBe(100);
  });

  it("copies server state and never mutates the authored definition or snapshot", () => {
    const definition = authored().lumberjacks_first_lesson;
    const original = JSON.stringify(definition);
    const progress: QuestProgress = {
      playerId: "journal-test",
      questId: definition.id,
      status: "in_progress",
      currentStage: "chop_logs",
      stageProgress: { logs: 1 },
    };
    const snapshot = createQuestSnapshot(definition, progress.status, progress);
    const before = JSON.stringify(snapshot);
    progress.stageProgress.logs = 5;
    questFromSnapshot(snapshot).objectives[0].current = 999;
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(JSON.stringify(definition)).toBe(original);
    expect(snapshot.stageProgress.logs).toBe(1);
  });

  it("refuses legacy/invalid rows instead of inventing a denominator", () => {
    const snapshot = lumberjack(1);
    expect(
      isQuestListPayload({
        quests: [{ id: snapshot.id, status: snapshot.status }],
        questPoints: 0,
      }),
    ).toBe(false);
    expect(
      isQuestListPayload({
        quests: [{ ...snapshot, stageProgress: { logs: Number.NaN } }],
        questPoints: 0,
      }),
    ).toBe(false);
    expect(
      isQuestListPayload({
        quests: [
          { ...snapshot, stages: [{ ...snapshot.stages[1], count: 0 }] },
        ],
        questPoints: 0,
      }),
    ).toBe(false);
  });

  it("keeps unselected, selected, pinned and reopened journal views on one snapshot", () => {
    const store = useQuestSelectionStore;
    store
      .getState()
      .applyQuestList({ quests: [lumberjack(1)], questPoints: 0 });
    expect(store.getState().selectedQuest).toBeNull();
    expect(calculateQuestProgress(store.getState().quests[0])).toBe(8);
    store
      .getState()
      .setSelectedQuest({ ...store.getState().quests[0], pinned: true });
    const previousSelection = store.getState().selectedQuest!;
    store
      .getState()
      .applyQuestList({ quests: [lumberjack(6)], questPoints: 0 });
    expect(calculateQuestProgress(previousSelection)).toBe(8);
    expect(calculateQuestProgress(store.getState().selectedQuest!)).toBe(50);
    store.getState().setSelectedQuest(previousSelection);
    expect(calculateQuestProgress(store.getState().selectedQuest!)).toBe(50);
    expect(store.getState().selectedQuest).toEqual({
      ...store.getState().quests[0],
      pinned: true,
    });
    store.getState().clearSelectedQuest();
    store
      .getState()
      .applyQuestList({ quests: [lumberjack(6, 1)], questPoints: 0 });
    store.getState().setSelectedQuest(store.getState().quests[0]);
    expect(calculateQuestProgress(store.getState().selectedQuest!)).toBe(58);
    expect(store.getState().questsLoaded).toBe(true);
  });

  it("refreshes detached selection through ready, claimed, abandoned and removed states", () => {
    const store = useQuestSelectionStore;
    store.getState().setSelectedQuest(questFromSnapshot(lumberjack(1)));
    for (const status of [
      "ready_to_complete",
      "completed",
      "not_started",
    ] as const) {
      const snapshot =
        status === "not_started"
          ? createQuestSnapshot(authored().lumberjacks_first_lesson, status)
          : lumberjack(6, 6, status);
      store.getState().applyQuestList({
        quests: [snapshot],
        questPoints: status === "completed" ? 1 : 0,
      });
      expect(store.getState().selectedQuest).toEqual(
        store.getState().quests[0],
      );
      expect(calculateQuestProgress(store.getState().selectedQuest!)).toBe(
        status === "not_started" ? 0 : 100,
      );
      expect(store.getState().questStatuses.get(snapshot.id)).toBe(
        store.getState().selectedQuest!.state,
      );
    }
    store.getState().applyQuestList({ quests: [], questPoints: 0 });
    expect(store.getState().selectedQuest).toBeNull();
  });

  it("clears prior-player selection and status at a new journal subscription", () => {
    const store = useQuestSelectionStore;
    store
      .getState()
      .applyQuestList({ quests: [lumberjack(6)], questPoints: 0 });
    store.getState().setSelectedQuest(store.getState().quests[0]);
    store.getState().resetQuestList();
    expect(store.getState().quests).toEqual([]);
    expect(store.getState().questsLoaded).toBe(false);
    expect(store.getState().selectedQuest).toBeNull();
    expect(store.getState().questStatuses.size).toBe(0);
  });

  it("does not equate all counted work with authoritative claim eligibility", () => {
    const snapshot = lumberjack(6, 6, "in_progress");
    const quest = questFromSnapshot(snapshot);
    expect(calculateQuestProgress(quest)).toBe(100);
    expect(quest.readyToComplete).toBe(false);
    expect(canClaimQuest(quest)).toBe(false);
    expect(
      questFromSnapshot({ ...snapshot, status: "ready_to_complete" })
        .readyToComplete,
    ).toBe(true);
    expect(
      canClaimQuest(
        questFromSnapshot({ ...snapshot, status: "ready_to_complete" }),
      ),
    ).toBe(true);
    const recovered = {
      ...lumberjack(6, 0, "ready_to_complete"),
      currentStage: "chop_logs",
    };
    expect(calculateQuestProgress(questFromSnapshot(recovered))).toBe(50);
    expect(canClaimQuest(questFromSnapshot(recovered))).toBe(false);
    const rounded = questFromSnapshot({
      ...snapshot,
      status: "ready_to_complete",
    });
    rounded.objectives[0] = {
      ...rounded.objectives[0],
      current: 199,
      target: 200,
    };
    expect(calculateQuestProgress(rounded)).toBe(100);
    expect(canClaimQuest(rounded)).toBe(false);
  });

  it("shares real network refresh ownership and retires the final listener and timer", async () => {
    const world = new World();
    const network = world.register("network", ClientNetwork) as ClientNetwork;
    // Use the actual client's offline reconnect queue, not a socket or send mock.
    const reconnect = network as unknown as {
      isReconnecting: boolean;
      outgoingQueue: Array<{ name: string; data: unknown }>;
    };
    reconnect.isReconnecting = true;
    const initialListeners = network.listenerCount("questList");
    const releaseMinimap = subscribeQuestSnapshots(world);
    const releaseList = subscribeQuestSnapshots(world);
    const releaseDetail = subscribeQuestSnapshots(world);
    try {
      expect(network.listenerCount("questList")).toBe(initialListeners + 1);
      expect(reconnect.outgoingQueue.map((entry) => entry.name)).toEqual([
        "getQuestList",
      ]);
      network.onQuestList({ quests: [lumberjack(1)], questPoints: 0 });
      useQuestSelectionStore
        .getState()
        .setSelectedQuest(useQuestSelectionStore.getState().quests[0]);
      releaseList();
      releaseMinimap();
      releaseList(); // Release is idempotent and cannot steal the detail's owner.
      for (let index = 0; index < 8; index++)
        network.onQuestProgressed({
          questId: "lumberjacks_first_lesson",
          stage: "chop_logs",
          progress: { logs: 2 },
          description: "Chop logs",
        });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(reconnect.outgoingQueue.map((entry) => entry.name)).toEqual([
        "getQuestList",
        "getQuestList",
      ]);
      network.onQuestList({ quests: [lumberjack(2)], questPoints: 0 });
      expect(
        calculateQuestProgress(
          useQuestSelectionStore.getState().selectedQuest!,
        ),
      ).toBe(17);
      // Old detail packets have no subscription and cannot overwrite the list.
      network.onQuestDetail(lumberjack(0));
      expect(
        calculateQuestProgress(
          useQuestSelectionStore.getState().selectedQuest!,
        ),
      ).toBe(17);
      network.onQuestProgressed({
        questId: "lumberjacks_first_lesson",
        stage: "chop_logs",
        progress: { logs: 3 },
        description: "Chop logs",
      });
      releaseDetail();
      expect(network.listenerCount("questList")).toBe(initialListeners);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(reconnect.outgoingQueue).toHaveLength(2);
      network.onQuestList({ quests: [lumberjack(6)], questPoints: 0 });
      expect(
        calculateQuestProgress(
          useQuestSelectionStore.getState().selectedQuest!,
        ),
      ).toBe(17);
    } finally {
      releaseList();
      releaseMinimap();
      releaseDetail();
      world.destroy();
    }
  });
});
