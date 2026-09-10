import { afterEach, describe, expect, it, vi } from "vitest";

import type { EntityData, World } from "../../../types";
import { ClientNetwork } from "../ClientNetwork";

function makeWindow(pathname: string, search = ""): Window {
  return { location: { pathname, search } } as unknown as Window;
}

function createWorld() {
  const add = vi.fn(() => null);
  const deserialize = vi.fn(async () => undefined);
  const remove = vi.fn();
  const world = {
    emit: vi.fn(),
    getTime: vi.fn(() => 0),
    settings: { deserialize: vi.fn() },
    chat: { deserialize: vi.fn() },
    entities: {
      add,
      deserialize,
      get: vi.fn(() => null),
      remove,
      player: undefined,
      values: vi.fn(() => [][Symbol.iterator]()),
    },
    getSystem: vi.fn(() => null),
    frameBudget: null,
  } as unknown as World;

  return { add, deserialize, remove, world };
}

function entity(id: string, type: string): EntityData {
  return { id, type } as EntityData;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClientNetwork streaming entity admission", () => {
  it("filters non-fighters from the initial arena broadcast snapshot", async () => {
    vi.stubGlobal("window", makeWindow("/stream.html"));
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
    const { deserialize, world } = createWorld();
    const network = new ClientNetwork(world);
    const snapshotEntities = [
      entity("tree", "resource"),
      entity("fighter-a", "player"),
      entity("banker", "npc"),
      entity("fighter-b", "player"),
    ];

    await network.onSnapshot({
      id: "spectator",
      serverTime: 0,
      spectatorMode: true,
      entities: snapshotEntities,
    } as Parameters<ClientNetwork["onSnapshot"]>[0]);
    network.onEntityModified({ id: "tree", changes: { active: true } });

    expect(deserialize).toHaveBeenCalledWith([
      snapshotEntities[1],
      snapshotEntities[3],
    ]);
    expect(network.pendingModifications.size).toBe(0);
  });

  it("keeps arena broadcast snapshots fighter-only without queuing filtered updates", () => {
    vi.stubGlobal("window", makeWindow("/stream.html"));
    const { add, world } = createWorld();
    const network = new ClientNetwork(world);

    network.onEntityAdded(entity("furnace", "static"));
    network.onEntityAdded(entity("fighter-a", "player"));
    network.onEntitiesBatchAdded([
      entity("tree", "resource"),
      entity("fighter-b", "player"),
      entity("banker", "npc"),
    ]);
    network.onEntityModified({ id: "tree", changes: { active: true } });

    expect(add.mock.calls.map(([data]) => data.id)).toEqual([
      "fighter-a",
      "fighter-b",
    ]);
    expect(network.pendingModifications.size).toBe(0);
  });

  it("preserves complete world snapshots for playable clients", () => {
    vi.stubGlobal("window", makeWindow("/play"));
    const { add, world } = createWorld();
    const network = new ClientNetwork(world);

    network.onEntitiesBatchAdded([
      entity("tree", "resource"),
      entity("banker", "npc"),
      entity("fighter", "player"),
    ]);

    expect(add.mock.calls.map(([data]) => data.id)).toEqual([
      "tree",
      "banker",
      "fighter",
    ]);
  });
});
