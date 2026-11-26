import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import type { World } from "../../../types";
import { ClientNetwork } from "../ClientNetwork";

function createWorld() {
  return {
    emit: vi.fn(),
    entities: {
      get: vi.fn(() => null),
      player: undefined,
    },
    getSystem: vi.fn(() => null),
    frameBudget: null,
  } as unknown as World;
}

const launch = (networkEventId: string) => ({
  attackerId: "ranger-a",
  targetId: "ranger-b",
  projectileType: "arrow",
  sourcePosition: { x: 1, y: 1.2, z: 2 },
  targetPosition: { x: 6, y: 1.2, z: 2 },
  arrowId: "bronze_arrow",
  travelDurationMs: 600,
  tick: 42,
  networkEventId,
});

const hit = (networkEventId: string) => ({
  attackerId: "ranger-a",
  targetId: "ranger-b",
  damage: 7,
  projectileType: "arrow",
  position: { x: 6, y: 1.2, z: 2 },
  tick: 47,
  networkEventId,
});

describe("ClientNetwork projectile spatial-delivery deduplication", () => {
  it("emits one launch for repeated nearby-topic copies", () => {
    const world = createWorld();
    const network = new ClientNetwork(world);
    const packet = launch("server-a:1");

    for (let copy = 0; copy < 9; copy += 1) {
      network.onProjectileLaunched({ ...packet });
    }

    expect(world.emit).toHaveBeenCalledTimes(1);
    expect(world.emit).toHaveBeenCalledWith(
      EventType.COMBAT_PROJECTILE_LAUNCHED,
      packet,
    );
  });

  it("preserves distinct same-tick launches from one attacker", () => {
    const world = createWorld();
    const network = new ClientNetwork(world);

    network.onProjectileLaunched(launch("server-a:1"));
    network.onProjectileLaunched(launch("server-a:2"));

    expect(world.emit).toHaveBeenCalledTimes(2);
  });

  it("treats one authoritative identity as one event even if a duplicate copy is malformed differently", () => {
    const world = createWorld();
    const network = new ClientNetwork(world);

    network.onProjectileLaunched(launch("server-a:1"));
    network.onProjectileLaunched({
      ...launch("server-a:1"),
      targetPosition: { x: 99, y: 1.2, z: 2 },
    });

    expect(world.emit).toHaveBeenCalledTimes(1);
  });

  it("emits one impact for repeated nearby-topic copies", () => {
    const world = createWorld();
    const network = new ClientNetwork(world);
    const packet = hit("server-a:3");

    for (let copy = 0; copy < 9; copy += 1) {
      network.onProjectileHit({ ...packet });
    }

    expect(world.emit).toHaveBeenCalledTimes(1);
    expect(world.emit).toHaveBeenCalledWith(
      EventType.COMBAT_PROJECTILE_HIT,
      packet,
    );
  });

  it("retains rolling-deploy protection when event identity is absent", () => {
    const world = createWorld();
    const network = new ClientNetwork(world);
    const { networkEventId: _ignored, ...legacyLaunch } = launch("");

    network.onProjectileLaunched({ ...legacyLaunch });
    network.onProjectileLaunched({ ...legacyLaunch });

    expect(world.emit).toHaveBeenCalledTimes(1);
  });
});
