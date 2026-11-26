import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../../types/events";
import type { World } from "../../../../types/index";
import { EventBus } from "../../infrastructure/EventBus";
import { SkillsSystem } from "../SkillsSystem";

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
    combatLevel: 3,
    totalLevel: 26,
  };
  const entity = {
    id: "atomic-prayer-agent",
    data: {} as { skills?: typeof stats },
    position: { x: 4, y: 0, z: 7 },
    components: new Map([["stats", stats]]),
    getComponent: (name: string) => (name === "stats" ? stats : undefined),
  };
  const eventBus = new EventBus();
  const world = {
    isServer: true,
    $eventBus: eventBus,
    entities: new Map([[entity.id, entity]]),
    getSystem: vi.fn(() => undefined),
  };
  return { entity, stats, eventBus, world };
}

describe("SkillsSystem committed Prayer reconciliation", () => {
  it("rejects every generic Prayer progression entry point", async () => {
    const fixture = createFixture();
    const emitEvent = vi.spyOn(fixture.eventBus, "emitEvent");
    const system = new SkillsSystem(fixture.world as unknown as World);

    system.grantXP("atomic-prayer-agent", "prayer", 100);
    system.setSkillLevel("atomic-prayer-agent", "prayer", 20);
    system.resetSkill("atomic-prayer-agent", "prayer");
    await system.init();
    fixture.eventBus.emitEvent(
      EventType.SKILLS_XP_GAINED,
      {
        playerId: "atomic-prayer-agent",
        skill: "prayer",
        amount: 100,
      },
      "untrusted-generic-source",
    );

    expect(fixture.stats.prayer).toEqual({ level: 1, xp: 0 });
    expect(emitEvent).not.toHaveBeenCalledWith(
      EventType.XP_DROP_BROADCAST,
      expect.anything(),
      expect.anything(),
    );
  });

  it("counts Magic and Prayer XP once and retains Prayer milestones", () => {
    const fixture = createFixture();
    fixture.stats.magic.xp = 20;
    fixture.stats.prayer.xp = 30;
    const emitEvent = vi.spyOn(fixture.eventBus, "emitEvent");
    const system = new SkillsSystem(fixture.world as unknown as World);

    expect(system.getTotalXP(fixture.stats)).toBe(1_204);

    const level50Xp = system.getXPForLevel(50);
    expect(
      system.reconcileCommittedPrayerProgression(
        "atomic-prayer-agent",
        level50Xp,
        50,
        level50Xp - 30,
        false,
      ),
    ).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.SKILLS_MILESTONE,
      expect.objectContaining({
        entityId: "atomic-prayer-agent",
        skill: "prayer",
        milestone: expect.objectContaining({ level: 50 }),
      }),
      expect.anything(),
    );
  });

  it("applies exact committed state without emitting a second XP mutation", () => {
    const fixture = createFixture();
    const emitEvent = vi.spyOn(fixture.eventBus, "emitEvent");
    const system = new SkillsSystem(fixture.world as unknown as World);

    expect(
      system.reconcileCommittedPrayerProgression(
        "atomic-prayer-agent",
        100,
        2,
        100,
        false,
      ),
    ).toBe(true);
    expect(fixture.stats.prayer).toEqual({ level: 2, xp: 100 });
    expect(fixture.stats.totalLevel).toBe(27);
    expect(emitEvent).not.toHaveBeenCalledWith(
      EventType.SKILLS_XP_GAINED,
      expect.anything(),
      expect.anything(),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.XP_DROP_BROADCAST,
      expect.objectContaining({
        playerId: "atomic-prayer-agent",
        skill: "prayer",
        amount: 100,
        newXp: 100,
        newLevel: 2,
      }),
      expect.anything(),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.SKILLS_LEVEL_UP,
      expect.objectContaining({
        entityId: "atomic-prayer-agent",
        skill: "prayer",
        oldLevel: 1,
        newLevel: 2,
      }),
      expect.anything(),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.SKILLS_UPDATED,
      expect.objectContaining({
        playerId: "atomic-prayer-agent",
        persistence: "already_committed",
      }),
      expect.anything(),
    );
  });

  it("publishes database-loaded skills without scheduling a write-back", async () => {
    const fixture = createFixture();
    fixture.entity.data = { skills: fixture.stats };
    const emitEvent = vi.spyOn(fixture.eventBus, "emitEvent");
    const system = new SkillsSystem(fixture.world as unknown as World);
    await (
      system as unknown as {
        loadPlayerSkillsFromDatabase(playerId: string): Promise<void>;
      }
    ).loadPlayerSkillsFromDatabase("atomic-prayer-agent");

    expect(emitEvent).toHaveBeenCalledWith(
      EventType.SKILLS_UPDATED,
      expect.objectContaining({
        playerId: "atomic-prayer-agent",
        skills: fixture.stats,
        persistence: "already_committed",
      }),
      expect.anything(),
    );
  });

  it("converges a replay without duplicating one-time presentation events", () => {
    const fixture = createFixture();
    fixture.stats.prayer = { level: 2, xp: 100 };
    fixture.stats.totalLevel = 27;
    const emitEvent = vi.spyOn(fixture.eventBus, "emitEvent");
    const system = new SkillsSystem(fixture.world as unknown as World);

    expect(
      system.reconcileCommittedPrayerProgression(
        "atomic-prayer-agent",
        100,
        2,
        100,
        true,
      ),
    ).toBe(true);
    expect(emitEvent).not.toHaveBeenCalledWith(
      EventType.XP_DROP_BROADCAST,
      expect.anything(),
      expect.anything(),
    );
    expect(emitEvent).not.toHaveBeenCalledWith(
      EventType.SKILLS_LEVEL_UP,
      expect.anything(),
      expect.anything(),
    );
  });
});
