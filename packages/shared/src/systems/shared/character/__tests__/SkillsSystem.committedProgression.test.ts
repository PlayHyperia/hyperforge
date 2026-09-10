import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import { EventBus } from "../../infrastructure/EventBus";
import { SkillsSystem } from "../SkillsSystem";

const PLAYER_ID = "committed-progression-agent";
const OPERATION_ID = "processing-action:committed-progression-1";

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

const committedProgress = {
  playerId: PLAYER_ID,
  operationId: OPERATION_ID,
  replayed: false,
  skill: "cooking" as const,
  xpAmount: 12.5,
  awardedXp: 12.5,
  operationCommittedXp: 12.5,
  currentXp: 12.5,
  currentLevel: 1,
};

describe("SkillsSystem committed progression convergence", () => {
  it("applies an exact fractional snapshot once without emitting another XP mutation", async () => {
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

    fixture.eventBus.emitEvent(
      EventType.SKILLS_PROGRESS_COMMITTED,
      committedProgress,
    );
    fixture.eventBus.emitEvent(
      EventType.SKILLS_PROGRESS_COMMITTED,
      committedProgress,
    );

    expect(fixture.stats.cooking).toEqual({ level: 1, xp: 12.5 });
    expect(xpMutations).toEqual([]);
    expect(xpDrops).toHaveLength(1);
    expect(skillUpdates).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          playerId: PLAYER_ID,
          persistence: "already_committed",
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          playerId: PLAYER_ID,
          persistence: "already_committed",
        }),
      }),
    ]);
    system.destroy();
  });

  it("converges replay without visual XP and refuses an older snapshot", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const xpDrops: unknown[] = [];
    fixture.eventBus.subscribe(EventType.XP_DROP_BROADCAST, (event) => {
      xpDrops.push(event);
    });
    await system.init();

    fixture.eventBus.emitEvent(EventType.SKILLS_PROGRESS_COMMITTED, {
      ...committedProgress,
      replayed: true,
      operationCommittedXp: 37.5,
      currentXp: 37.5,
    });
    fixture.eventBus.emitEvent(EventType.SKILLS_PROGRESS_COMMITTED, {
      ...committedProgress,
      replayed: true,
    });

    expect(fixture.stats.cooking).toEqual({ level: 1, xp: 37.5 });
    expect(xpDrops).toEqual([]);
    system.destroy();
  });

  it("rejects malformed committed progression before live mutation", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await system.init();
    try {
      fixture.eventBus.emitEvent(EventType.SKILLS_PROGRESS_COMMITTED, {
        ...committedProgress,
        currentLevel: 99,
      });
      fixture.eventBus.emitEvent(EventType.SKILLS_PROGRESS_COMMITTED, {
        ...committedProgress,
        skill: "prayer",
      } as never);
      expect(fixture.stats.cooking).toEqual({ level: 1, xp: 0 });
      expect(fixture.stats.prayer).toEqual({ level: 1, xp: 0 });
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
      system.destroy();
    }
  });
});
