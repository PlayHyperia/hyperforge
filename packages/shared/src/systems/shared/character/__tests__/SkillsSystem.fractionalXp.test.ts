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
    id: "fractional-xp-agent",
    position: { x: 0, y: 0, z: 0 },
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
  return { stats, eventBus, world };
}

describe("SkillsSystem fractional XP", () => {
  it("preserves exact manifest fractions and rejects invalid XP events", async () => {
    const fixture = createFixture();
    const system = new SkillsSystem(fixture.world as unknown as World);
    const skillUpdates: Array<{ persistence?: "already_committed" }> = [];
    fixture.eventBus.subscribe(EventType.SKILLS_UPDATED, (event) => {
      skillUpdates.push(event.data as { persistence?: "already_committed" });
    });
    await system.init();

    fixture.eventBus.emitEvent(
      EventType.SKILLS_XP_GAINED,
      {
        playerId: "fractional-xp-agent",
        skill: "smithing",
        amount: 12.5,
      },
      "test",
    );
    expect(fixture.stats.smithing.xp).toBe(12.5);
    expect(skillUpdates).toHaveLength(1);
    expect(skillUpdates[0]?.persistence).toBeUndefined();

    for (const amount of [Number.NaN, -1, 0, 1_000_001]) {
      fixture.eventBus.emitEvent(
        EventType.SKILLS_XP_GAINED,
        {
          playerId: "fractional-xp-agent",
          skill: "smithing",
          amount,
        },
        "test",
      );
    }
    expect(fixture.stats.smithing.xp).toBe(12.5);
    system.destroy();
  });
});
