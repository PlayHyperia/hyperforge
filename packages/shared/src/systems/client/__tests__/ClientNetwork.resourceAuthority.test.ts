import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { ResourceEntity } from "../../../entities/world/ResourceEntity";
import type { Resource } from "../../../types/core/core";
import type { TerrainResourceSpawnBatch } from "../../../types/world/terrain";
import { ResourceSystem } from "../../shared/entities/ResourceSystem";
import { ClientNetwork } from "../ClientNetwork";

// Real engine classes and their native init/lease Promises. No replaced loader,
// fabricated socket, GPU, renderer, persistence service or production time clock.
type Resources = {
  registerTerrainResources(batch: TerrainResourceSpawnBatch): Promise<void>;
  onTerrainTileUnloaded(data: {
    tileId: string;
    tileX: number;
    tileZ: number;
  }): void;
  resources: Map<string, Resource>;
  respawnAtTick: Map<string, number>;
  terrainResourceTails: Map<string, Promise<void>>;
  terrainResourceRegistrations: Map<
    string,
    { registration: { entity: ResourceEntity | null } }
  >;
  clientResourceAuthority: { open: boolean; states: Map<string, boolean> };
};
type Network = {
  beginResourceAuthority(): void;
  closeResourceAuthority(): void;
  resourceAuthorityToken: object | null;
};
const worlds: World[] = [];
beforeAll(async () => {
  await DataManager.getInstance().initialize();
});
afterEach(async () => {
  for (const world of worlds.splice(0)) world.destroy();
  for (let i = 0; i < 12; i++) await Promise.resolve();
});
function fixture() {
  const world = new World();
  worlds.push(world);
  const network = world.register("network", ClientNetwork) as ClientNetwork;
  const system = world.register("resource", ResourceSystem) as ResourceSystem;
  const r = system as unknown as Resources;
  const n = network as unknown as Network;
  // The exact connection-initialization boundary, without opening a transport.
  // Socket transport/serialization has a separate native-loopback regression.
  n.beginResourceAuthority();
  const begin = () => {
    n.beginResourceAuthority();
    return n.resourceAuthorityToken!;
  };
  const point = {
    id: "2_4_tree_0",
    type: "tree" as const,
    subType: "banana" as const,
    position: { x: 288.5, y: 30.5, z: 507.5 },
    scale: 1.15,
    rotation: 0.37,
  };
  const batch: TerrainResourceSpawnBatch = {
    owner: { tileX: 3, tileZ: 5 },
    spawnPoints: [point],
  };
  const id = "tree_289_508";
  const snapshot = (isAvailable: boolean, respawnAt = 1) =>
    network.onResourceSnapshot({
      resources: [
        {
          id,
          type: "tree",
          position: { ...point.position },
          isAvailable,
          respawnAt,
        },
      ],
    });
  const entity = () => {
    const value = world.entities.get(id);
    expect(value).toBeInstanceOf(ResourceEntity);
    if (!(value instanceof ResourceEntity))
      throw new Error("Missing actual tree");
    return value;
  };
  const unload = () =>
    r.onTerrainTileUnloaded({ tileId: "3,5", tileX: 3, tileZ: 5 });
  const settle = async () => {
    await Promise.all([...r.terrainResourceTails.values()]);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return {
    world,
    network,
    system,
    r,
    n,
    begin,
    batch,
    id,
    snapshot,
    entity,
    unload,
    settle,
  };
}

describe("client resource authority across late join and local residency", () => {
  for (const snapshotFirst of [true, false]) {
    it(`seeds distant depleted state before local publication (snapshot first: ${snapshotFirst})`, async () => {
      const f = fixture();
      expect(Math.hypot(288.5 - 384.5, 507.5 - 374.5)).toBeGreaterThan(110);
      if (snapshotFirst) f.snapshot(false);
      await f.r.registerTerrainResources(f.batch);
      if (!snapshotFirst) {
        expect(f.world.entities.get(f.id)).toBeNull();
        expect(f.r.resources.has(f.id)).toBe(false);
        f.snapshot(false);
      }
      await f.settle();
      expect(f.entity().config.depleted).toBe(true);
      expect(f.entity().data.depleted).toBe(true);
      expect(f.r.resources.get(f.id)?.isAvailable).toBe(false);
      expect(f.r.respawnAtTick.size).toBe(0); // Expired respawnAt never invents availability.
      expect(f.entity().position.toArray()).toEqual([288.5, 30.5, 507.5]);
      expect(
        f.r.terrainResourceRegistrations.get(f.id)?.registration.entity,
      ).toBe(f.entity());
    });
  }

  it("does not lose a snapshot arriving in the initial registration's native Promise tail", async () => {
    const f = fixture();
    const pending = f.r.registerTerrainResources(f.batch);
    expect(f.r.terrainResourceTails.size).toBe(1);
    f.snapshot(false);
    await pending;
    expect(f.entity().config.depleted).toBe(true);
    expect(f.r.terrainResourceTails.size).toBe(0);
  });

  it("updates an already resident local actor and retains authoritative state across unload/reload", async () => {
    const f = fixture();
    f.snapshot(true);
    await f.r.registerTerrainResources(f.batch);
    const first = f.entity();
    f.snapshot(false);
    expect(f.entity()).toBe(first);
    expect(first.config.depleted).toBe(true);
    expect(f.r.resources.get(f.id)?.isAvailable).toBe(false);
    f.unload();
    expect(first.destroyed).toBe(true);
    expect(f.world.entities.get(f.id)).toBeNull();
    expect(f.r.clientResourceAuthority.states.get(f.id)).toBe(true);
    await f.r.registerTerrainResources(f.batch);
    expect(f.entity()).not.toBe(first);
    expect(f.entity().config.depleted).toBe(true);
    expect(f.r.respawnAtTick.size).toBe(0);
  });

  it("retains ordered depletion/respawn while absent and accepts duplicate events idempotently", async () => {
    const f = fixture();
    f.network.onResourceDepleted({ resourceId: f.id });
    await f.r.registerTerrainResources(f.batch);
    expect(f.entity().config.depleted).toBe(true);
    f.unload();
    f.network.onResourceRespawned({ resourceId: f.id });
    f.network.onResourceRespawned({ resourceId: f.id });
    await f.r.registerTerrainResources(f.batch);
    const next = f.entity();
    expect(next.config.depleted).toBe(false);
    expect(f.r.resources.get(f.id)?.isAvailable).toBe(true);
    f.network.onResourceDepleted({ resourceId: f.id });
    f.network.onResourceDepleted({ resourceId: f.id });
    expect(f.entity()).toBe(next);
    expect(next.config.depleted).toBe(true);
    expect(f.r.respawnAtTick.size).toBe(0);
  });

  for (const borrowed of [false, true]) {
    it(`re-gates an omitted local snapshot row without retiring network ownership (borrowed: ${borrowed})`, async () => {
      const f = fixture();
      f.snapshot(true);
      await f.r.registerTerrainResources(f.batch);
      const original = f.entity();
      if (borrowed) f.network.onEntityAdded(original.serialize());
      f.network.onResourceSnapshot({ resources: [] });
      expect(f.r.clientResourceAuthority.states.has(f.id)).toBe(false);
      expect(original.destroyed).toBe(!borrowed);
      expect(f.world.entities.get(f.id)).toBe(borrowed ? original : null);
      expect(
        f.r.terrainResourceRegistrations.get(f.id)?.registration.entity,
      ).toBeNull();
      if (!borrowed) {
        expect(f.r.resources.has(f.id)).toBe(false);
        // Repeated terrain admission must not reinitialize unknown availability.
        await f.r.registerTerrainResources(f.batch);
        expect(f.world.entities.get(f.id)).toBeNull();
        expect(f.world.entities.hot.has(original)).toBe(false);
        expect(original.node.parent).toBeNull();
      }
      f.snapshot(false);
      await f.settle();
      expect(f.entity().config.depleted).toBe(true);
      if (borrowed) expect(f.entity()).toBe(original);
      else expect(f.entity()).not.toBe(original);
    });
  }

  it("retains a generic authoritative depleted delta before a local entity exists", async () => {
    const f = fixture();
    f.network.onEntityModified({ id: f.id, changes: { depleted: true } });
    await f.r.registerTerrainResources(f.batch);
    expect(f.entity().config.depleted).toBe(true);
  });

  for (const depleted of [true, false]) {
    it(`does not replay an older queued boolean over latest dedicated state ${depleted}`, async () => {
      const f = fixture();
      f.network.onEntityModified({
        id: f.id,
        changes: { depleted: !depleted, name: "Retained generic field" },
      });
      if (depleted) f.network.onResourceDepleted({ resourceId: f.id });
      else f.network.onResourceRespawned({ resourceId: f.id });
      await f.r.registerTerrainResources(f.batch);
      const entity = f.entity();
      f.network.onEntityAdded({ ...entity.serialize(), depleted });
      expect(entity.config.depleted).toBe(depleted);
      expect(f.r.resources.get(f.id)?.isAvailable).toBe(!depleted);
      expect(entity.data.name).toBe("Retained generic field");
    });
  }

  for (const kind of ["single", "batch"] as const) {
    it(`keeps genuine ${kind} entity ownership distinct from snapshot availability`, async () => {
      const f = fixture();
      f.snapshot(false);
      await f.r.registerTerrainResources(f.batch);
      const owned = f.entity();
      const data = { ...owned.serialize(), depleted: false };
      if (kind === "single") f.network.onEntityAdded(data);
      else f.network.onEntitiesBatchAdded([data]);
      expect(f.entity()).toBe(owned);
      expect(owned.config.depleted).toBe(false);
      expect(
        f.r.terrainResourceRegistrations.get(f.id)?.registration.entity,
      ).toBeNull();
      f.unload();
      expect(f.entity()).toBe(owned);
      expect(owned.destroyed).toBe(false);
      f.snapshot(false);
      expect(owned.config.depleted).toBe(true);
    });
  }

  it("reconnect cancels a real pending actor init and ignores stale session writes and closes", async () => {
    const f = fixture();
    const oldToken = f.n.resourceAuthorityToken!;
    f.snapshot(true);
    const pending = f.r.registerTerrainResources(f.batch);
    const old = f.entity();
    f.begin();
    expect(old.destroyed).toBe(true);
    expect(f.world.entities.get(f.id)).toBeNull();
    f.system.applyClientResourceState(oldToken, f.id, false);
    f.system.applyClientResourceSnapshot(oldToken, [
      { id: f.id, type: "tree", isAvailable: true },
    ]);
    f.system.closeClientResourceAuthority(oldToken);
    expect(f.r.clientResourceAuthority.open).toBe(true);
    expect(f.r.clientResourceAuthority.states.size).toBe(0);
    await pending;
    expect(f.world.entities.get(f.id)).toBeNull();
    f.snapshot(false);
    await f.settle();
    const replacement = f.entity();
    expect(replacement).not.toBe(old);
    expect(replacement.config.depleted).toBe(true);
    old.destroy();
    expect(f.entity()).toBe(replacement);
    expect(f.world.entities.hot.has(old)).toBe(false);
    expect(old.node.parent).toBeNull();
  });

  it("close/destroy keeps unknown state pending and cannot publish a retired lease", async () => {
    const f = fixture();
    const token = f.n.resourceAuthorityToken!;
    const pending = f.r.registerTerrainResources(f.batch);
    f.n.closeResourceAuthority();
    f.system.applyClientResourceState(token, f.id, false);
    await pending;
    expect(f.world.entities.get(f.id)).toBeNull();
    f.begin();
    f.unload();
    f.snapshot(false);
    expect(f.world.entities.get(f.id)).toBeNull();
    f.system.destroy();
    f.snapshot(true);
    expect(f.world.entities.get(f.id)).toBeNull();
  });

  it("validates full snapshots atomically without converting invalid or absent state into available", async () => {
    const f = fixture();
    await f.r.registerTerrainResources(f.batch);
    const token = f.n.resourceAuthorityToken!;
    const row = { id: f.id, type: "tree", isAvailable: false };
    expect(() =>
      f.system.applyClientResourceSnapshot(token, [row, row]),
    ).toThrow(/Duplicate/);
    expect(f.world.entities.get(f.id)).toBeNull();
    expect(f.r.clientResourceAuthority.states.size).toBe(0);
    f.system.applyClientResourceSnapshot(token, []);
    expect(f.world.entities.get(f.id)).toBeNull();
    const invalid = { ...row, isAvailable: "false" };
    expect(() =>
      f.system.applyClientResourceSnapshot(token, [
        invalid as unknown as typeof row,
      ]),
    ).toThrow(/Invalid/);
    expect(f.world.entities.get(f.id)).toBeNull();
  });
});
