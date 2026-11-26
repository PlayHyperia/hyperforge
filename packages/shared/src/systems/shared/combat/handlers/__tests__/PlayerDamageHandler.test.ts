import { describe, expect, it, vi } from "vitest";

import type { World } from "../../../../../core/World";
import type { EntityID } from "../../../../../types/core/identifiers";
import { PlayerDamageHandler } from "../PlayerDamageHandler";

function createHandler(initialHealth: number) {
  let health = initialHealth;
  const attacker = { id: "attacker" };
  const target = {
    id: "target",
    getHealth: () => health,
    isAlive: () => health > 0,
    data: { health },
  };
  const entities = new Map<string, unknown>([
    ["attacker", attacker],
    ["target", target],
  ]);
  const damagePlayer = vi.fn(
    (_playerId: string, amount: number, _source?: string) => {
      if (amount <= 0 || health <= 0) return false;
      health = Math.max(0, health - amount);
      target.data.health = health;
      return true;
    },
  );
  const world = {
    entities: { get: (id: string) => entities.get(id) },
    getPlayer: (id: string) => (id === "target" ? target : null),
  } as unknown as World;
  const handler = new PlayerDamageHandler(world);
  handler.cachePlayerSystem({
    damagePlayer,
    getPlayerAutoRetaliate: () => true,
  });
  return { handler, damagePlayer };
}

describe("PlayerDamageHandler health authority", () => {
  it("keeps a living method-backed target in combat after a zero-hit", () => {
    const { handler, damagePlayer } = createHandler(40);

    expect(
      handler.applyDamage(
        "target" as EntityID,
        0,
        "attacker" as EntityID,
        "player",
      ),
    ).toEqual({ actualDamage: 0, targetDied: false, success: true });
    expect(damagePlayer).not.toHaveBeenCalled();
  });

  it("measures positive damage from the same canonical health source", () => {
    const { handler, damagePlayer } = createHandler(40);

    expect(
      handler.applyDamage(
        "target" as EntityID,
        5,
        "attacker" as EntityID,
        "player",
      ),
    ).toEqual({ actualDamage: 5, targetDied: false, success: true });
    expect(damagePlayer).toHaveBeenCalledOnce();
  });
});
