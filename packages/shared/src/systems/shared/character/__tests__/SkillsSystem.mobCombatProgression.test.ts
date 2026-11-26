import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import { EventBus } from "../../infrastructure/EventBus";
import { SkillsSystem } from "../SkillsSystem";

const PLAYER_ID = "mob-combat-progress-agent";
const OPERATION_ID =
  "ground-item-mob-loot:123e4567-e89b-42d3-a456-426614174000";

function createFixture() {
  const skill = () => ({ level: 1, xp: 0 });
  const stats = {
    attack: skill(),
    strength: skill(),
    defense: skill(),
    constitution: { level: 10, xp: 1_154 },
    ranged: skill(),
    magic: skill(),
    prayer: skill(),
    woodcutting: skill(),
    mining: skill(),
    fishing: skill(),
    firemaking: skill(),
    cooking: skill(),
    smithing: skill(),
    agility: skill(),
    crafting: skill(),
    fletching: skill(),
    runecrafting: skill(),
    health: { current: 20, max: 20 },
    combatLevel: 3,
    totalLevel: 26,
  };
  const entity = {
    id: PLAYER_ID,
    position: { x: 4, y: 0, z: 7 },
    components: new Map([["stats", stats]]),
    getComponent: (name: string) => (name === "stats" ? stats : undefined),
  };
  const eventBus = new EventBus();
  const world = {
    isServer: true,
    $eventBus: eventBus,
    entities: new Map([[PLAYER_ID, entity]]),
    getSystem: vi.fn(() => undefined),
  };
  return { eventBus, stats, world };
}

const committedProgress = [
  {
    skill: "strength" as const,
    xpAmount: 80,
    awardedXp: 80,
    operationCommittedXp: 80,
    currentXp: 80,
    currentLevel: 1,
  },
  {
    skill: "constitution" as const,
    xpAmount: 26,
    awardedXp: 26,
    operationCommittedXp: 1_180,
    currentXp: 1_180,
    currentLevel: 10,
  },
];

describe("SkillsSystem durable mob combat progression", () => {
  it("converges every committed quest reward without a second XP mutation", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const xpMutations: unknown[] = [];
    const xpDrops: unknown[] = [];
    fixture.eventBus.subscribe(EventType.SKILLS_XP_GAINED, (event) =>
      xpMutations.push(event),
    );
    fixture.eventBus.subscribe(EventType.XP_DROP_BROADCAST, (event) =>
      xpDrops.push(event),
    );
    await system.init();

    const questReceipt = {
      playerId: PLAYER_ID,
      questId: "receipt_quest",
      operationId: `quest-completion:${"a".repeat(64)}`,
      replayed: false,
      progress: [
        {
          skill: "attack" as const,
          xpAmount: 500,
          awardedXp: 500,
          operationCommittedXp: 500,
          currentXp: 500,
          currentLevel: 5,
        },
        {
          skill: "agility" as const,
          xpAmount: 100,
          awardedXp: 100,
          operationCommittedXp: 100,
          currentXp: 100,
          currentLevel: 2,
        },
        {
          skill: "prayer" as const,
          xpAmount: 100,
          awardedXp: 100,
          operationCommittedXp: 100,
          currentXp: 100,
          currentLevel: 2,
        },
      ],
      prayer: {
        pointUnits: 2_000_000,
        maxPoints: 2,
        activePrayers: [],
      },
    };
    fixture.eventBus.emitEvent(
      EventType.QUEST_COMPLETION_COMMITTED,
      questReceipt,
    );

    expect(fixture.stats.attack).toEqual({ level: 5, xp: 500 });
    expect(fixture.stats.agility).toEqual({ level: 2, xp: 100 });
    expect(fixture.stats.prayer).toEqual({ level: 2, xp: 100 });
    expect(xpMutations).toEqual([]);
    expect(xpDrops).toHaveLength(3);

    fixture.eventBus.emitEvent(EventType.QUEST_COMPLETED, {
      playerId: PLAYER_ID,
      questId: "receipt_quest",
      questName: "Receipt Quest",
      rewards: { questPoints: 1, items: [], xp: { attack: 500 } },
      progressionCommitted: true,
    });
    expect(fixture.stats.attack.xp).toBe(500);
    expect(xpMutations).toEqual([]);

    fixture.eventBus.emitEvent(EventType.QUEST_COMPLETION_COMMITTED, {
      ...questReceipt,
      replayed: true,
    });
    expect(xpDrops).toHaveLength(3);
    system.destroy();
  });

  it("converges a lethal competitive-duel receipt without creating an XP delta", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const xpMutations: unknown[] = [];
    const xpDrops: unknown[] = [];
    fixture.eventBus.subscribe(EventType.SKILLS_XP_GAINED, (event) =>
      xpMutations.push(event),
    );
    fixture.eventBus.subscribe(EventType.XP_DROP_BROADCAST, (event) =>
      xpDrops.push(event),
    );
    await system.init();

    fixture.eventBus.emitEvent(EventType.DUEL_COMBAT_PROGRESS_COMMITTED, {
      playerId: PLAYER_ID,
      damageOperationId: "123e4567-e89b-42d3-a456-426614174001",
      replayed: false,
      combatProgress: committedProgress,
    });

    expect(fixture.stats.strength).toEqual({ level: 1, xp: 80 });
    expect(fixture.stats.constitution).toEqual({ level: 10, xp: 1_180 });
    expect(xpMutations).toEqual([]);
    expect(xpDrops).toHaveLength(2);

    fixture.eventBus.emitEvent(EventType.DUEL_COMBAT_PROGRESS_COMMITTED, {
      playerId: PLAYER_ID,
      damageOperationId: "123e4567-e89b-42d3-a456-426614174001",
      replayed: true,
      combatProgress: committedProgress,
    });
    expect(xpDrops).toHaveLength(2);
    system.destroy();
  });

  it("reconciles exact committed skill snapshots without emitting a new XP mutation", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const skillUpdates: unknown[] = [];
    const xpMutations: unknown[] = [];
    const xpDrops: unknown[] = [];
    fixture.eventBus.subscribe(EventType.SKILLS_UPDATED, (event) => {
      skillUpdates.push(event);
    });
    fixture.eventBus.subscribe(EventType.SKILLS_XP_GAINED, (event) => {
      xpMutations.push(event);
    });
    fixture.eventBus.subscribe(EventType.XP_DROP_BROADCAST, (event) => {
      xpDrops.push(event);
    });
    await system.init();

    fixture.eventBus.emitEvent(EventType.MOB_LOOT_COMMITTED, {
      playerId: PLAYER_ID,
      lootOperationId: OPERATION_ID,
      replayed: false,
      combatProgress: committedProgress,
    });

    expect(fixture.stats.strength).toEqual({ level: 1, xp: 80 });
    expect(fixture.stats.constitution).toEqual({ level: 10, xp: 1_180 });
    expect(xpMutations).toEqual([]);
    expect(xpDrops).toHaveLength(2);
    expect(skillUpdates).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          playerId: PLAYER_ID,
          persistence: "already_committed",
        }),
      }),
    ]);
    fixture.eventBus.emitEvent(EventType.MOB_LOOT_COMMITTED, {
      playerId: PLAYER_ID,
      lootOperationId: OPERATION_ID,
      replayed: false,
      combatProgress: committedProgress,
    });
    expect(xpDrops).toHaveLength(2);
    system.destroy();
  });

  it("converges replay after restart without replaying visual XP and never regresses", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const xpDrops: unknown[] = [];
    fixture.eventBus.subscribe(EventType.XP_DROP_BROADCAST, (event) => {
      xpDrops.push(event);
    });
    await system.init();

    fixture.eventBus.emitEvent(EventType.MOB_LOOT_COMMITTED, {
      playerId: PLAYER_ID,
      lootOperationId: OPERATION_ID,
      replayed: true,
      combatProgress: committedProgress,
    });
    expect(fixture.stats.strength.xp).toBe(80);
    expect(xpDrops).toEqual([]);

    fixture.eventBus.emitEvent(EventType.MOB_LOOT_COMMITTED, {
      playerId: PLAYER_ID,
      lootOperationId: OPERATION_ID,
      replayed: true,
      combatProgress: [
        {
          ...committedProgress[0],
          operationCommittedXp: 40,
          currentXp: 40,
        },
      ],
    });
    expect(fixture.stats.strength.xp).toBe(80);
    expect(xpDrops).toEqual([]);
    system.destroy();
  });

  it("rejects a malformed committed snapshot before mutating live skills", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await system.init();
    try {
      fixture.eventBus.emitEvent(EventType.MOB_LOOT_COMMITTED, {
        playerId: PLAYER_ID,
        lootOperationId: OPERATION_ID,
        replayed: false,
        combatProgress: [
          {
            ...committedProgress[0],
            currentLevel: 99,
          },
        ],
      });
      expect(fixture.stats.strength).toEqual({ level: 1, xp: 0 });
      expect(error).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
      system.destroy();
    }
  });
});
