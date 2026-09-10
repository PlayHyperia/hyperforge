import { afterEach, describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import { validateKillToken } from "../../../utils/game/KillTokenUtils";
import { MobEntity } from "../MobEntity";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MobEntity mob-life loot identity", () => {
  it("emits at most one authenticated loot operation for one mob life", async () => {
    vi.stubEnv(
      "KILL_TOKEN_SECRET",
      "mob-life-identity-regression-secret-32-bytes",
    );
    let dead = false;
    const emitted: Array<{
      type: EventType;
      payload: Record<string, unknown>;
    }> = [];
    const context = {
      id: "mob-life-identity-1",
      config: {
        mobType: "guard",
        level: 12,
        maxHealth: 20,
        currentHealth: 0,
        aiState: "combat",
        deathTime: null,
        targetPlayerId: "agent-1",
      },
      world: {
        currentTick: 40,
        emit: (type: EventType, payload: Record<string, unknown>) => {
          emitted.push({ type, payload });
        },
        getSystem: () => null,
        getPlayer: () => null,
      },
      deathManager: {
        isCurrentlyDead: () => dead,
        die: () => {
          dead = true;
        },
      },
      respawnManager: { startRespawnTimer: vi.fn() },
      combatManager: {
        getLastAttackerId: () => "agent-1",
      },
      aggroManager: { clearTarget: vi.fn() },
      unregisterOccupancy: vi.fn(),
      getPosition: () => ({ x: 40.5, y: 0.2, z: 40.5 }),
      setHealth: vi.fn(),
      setServerEmote: vi.fn(),
      markNetworkDirty: vi.fn(),
    };
    const die = MobEntity.prototype.die as (this: typeof context) => void;

    die.call(context);
    die.call(context);

    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.type === EventType.NPC_DIED),
      ).toHaveLength(1);
    });
    expect(context.unregisterOccupancy).toHaveBeenCalledTimes(1);
    expect(
      emitted.filter((event) => event.type === EventType.COMBAT_KILL),
    ).toHaveLength(0);
    const death = emitted.find(
      (event) => event.type === EventType.NPC_DIED,
    )!.payload;
    expect(death.lootOperationId).toMatch(
      /^ground-item-mob-loot:[0-9a-f-]{36}$/,
    );
    expect(death.killToken).toMatch(/^[a-f0-9]{64}$/);
    expect(death.attackStyle).toBe("aggressive");
    expect(death.damageDealt).toBe(20);
    await expect(
      validateKillToken(
        String(death.mobId),
        String(death.killedBy),
        Number(death.timestamp),
        String(death.killToken),
        String(death.lootOperationId),
        String(death.attackStyle),
        Number(death.damageDealt),
      ),
    ).resolves.toBe(true);
  });
});
