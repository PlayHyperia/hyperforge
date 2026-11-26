import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { InteractionType } from "../../../../types/entities";
import type { Resource } from "../../../../types/core/core";
import type {
  TerrainResourceSpawnBatch,
  TerrainResourceSpawnPoint,
} from "../../../../types/world/terrain";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { TerrainSystem } from "../../world/TerrainSystem";
import { EntityManager } from "../EntityManager";
import { ResourceSystem } from "../ResourceSystem";
import { ClientNetwork } from "../../../client/ClientNetwork";

/** Server role only: all lifecycle, entities, native Promises and collisions are real.
 * No renderer, socket service, persistence replacement or fake entity init. */
class CpuServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}

type Internals = {
  registerTerrainResources(data: TerrainResourceSpawnBatch): Promise<void>;
  onTerrainTileUnloaded(data: {
    tileId: string;
    tileX: number;
    tileZ: number;
  }): void;
  resources: Map<string, Resource>;
  respawnAtTick: Map<string, number>;
  terrainResourceLeases: Map<string, unknown>;
  terrainResourceTails: Map<string, Promise<void>>;
  terrainResourceRegistrations: Map<string, unknown>;
  initializeWorldAreaResources(): Promise<void>;
};

const worlds: World[] = [];
beforeAll(async () => {
  await DataManager.getInstance().initialize();
});
function fixture() {
  const world = new CpuServerWorld();
  worlds.push(world);
  const manager = world.register(
    "entity-manager",
    EntityManager,
  ) as EntityManager;
  const system = world.register("resource", ResourceSystem) as ResourceSystem;
  return { world, manager, system, internals: system as unknown as Internals };
}
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});

const point = (x = 10.5, z = 20.5): TerrainResourceSpawnPoint => ({
  id: "seeded-candidate-id-is-not-runtime-id",
  type: "tree",
  subType: "pine",
  position: { x, y: 12, z },
  scale: 1.125,
  rotation: 0.37,
});
const batch = (
  points = [point()],
  tileX = 0,
  tileZ = 0,
): TerrainResourceSpawnBatch => ({
  owner: { tileX, tileZ },
  spawnPoints: points,
});
const unload = (internals: Internals, tileX = 0, tileZ = 0) =>
  internals.onTerrainTileUnloaded({
    tileId: `${tileX},${tileZ}`,
    tileX,
    tileZ,
  });

describe("ResourceSystem real resource registration ownership", () => {
  it("deduplicates concurrent and settled identical batches without resetting availability or respawn", async () => {
    const { world, manager, internals } = fixture();
    const first = internals.registerTerrainResources(batch());
    const duplicate = internals.registerTerrainResources(batch());
    await Promise.all([first, duplicate]);
    const entity = manager.getEntity("tree_11_21");
    expect(entity).toBeInstanceOf(ResourceEntity);
    expect(manager.getAllEntities().size).toBe(1);
    expect(world.entities.get("tree_11_21")).toBe(entity);
    expect(world.collision.hasFlags(10, 20, CollisionFlag.BLOCKED)).toBe(true);
    const resource = internals.resources.get("tree_11_21")!;
    resource.isAvailable = false;
    resource.lastDepleted = Date.now();
    internals.respawnAtTick.set(resource.id, 1234);
    await internals.registerTerrainResources(batch());
    expect(manager.getEntity(resource.id)).toBe(entity);
    expect(internals.resources.get(resource.id)).toBe(resource);
    expect(resource.isAvailable).toBe(false);
    expect(internals.respawnAtTick.get(resource.id)).toBe(1234);
    expect(InteractionType.HARVEST).toBe("harvest");
    expect(entity!.config.interactionType).toBe("harvest");
  });

  it("invalidates an actual Entity.init await and removes its exact late collider/entity", async () => {
    const { world, manager, internals } = fixture();
    const pending = internals.registerTerrainResources(batch());
    // Constructor registers collision synchronously; EntityManager inserts only
    // after the real ResourceEntity.init native Promise chain completes.
    expect(world.collision.hasFlags(10, 20, CollisionFlag.BLOCKED)).toBe(true);
    expect(manager.getEntity("tree_11_21")).toBeUndefined();
    unload(internals);
    await pending;
    expect(manager.getAllEntities().size).toBe(0);
    expect(world.entities.get("tree_11_21")).toBeNull();
    expect(world.collision.hasFlags(10, 20, CollisionFlag.BLOCKED)).toBe(false);
    expect(internals.resources.size).toBe(0);
    expect(internals.terrainResourceRegistrations.size).toBe(0);
    expect(internals.terrainResourceTails.size).toBe(0);
  });

  it("serializes immediate unload/reload behind late creation, retaining only the new generation", async () => {
    const { world, manager, internals } = fixture();
    const first = internals.registerTerrainResources(batch());
    unload(internals);
    const next = internals.registerTerrainResources(batch());
    await Promise.all([first, next]);
    expect(manager.getAllEntities().size).toBe(1);
    expect(manager.getEntity("tree_11_21")).toBeInstanceOf(ResourceEntity);
    expect(world.collision.hasFlags(10, 20, CollisionFlag.BLOCKED)).toBe(true);
    expect(internals.resources.size).toBe(1);
    expect(internals.terrainResourceRegistrations.size).toBe(1);
    expect(internals.terrainResourceTails.size).toBe(0);
    unload(internals);
    expect(world.collision.hasFlags(10, 20, CollisionFlag.BLOCKED)).toBe(false);
    expect(manager.getAllEntities().size).toBe(0);
  });

  it("replaces full-content tile batches, including an empty generation", async () => {
    const { world, manager, internals } = fixture();
    const first = internals.registerTerrainResources(batch());
    const next = internals.registerTerrainResources(batch([point(12.5, 22.5)]));
    await Promise.all([first, next]);
    expect([...manager.getAllEntities().keys()]).toEqual(["tree_13_23"]);
    expect(world.collision.hasFlags(10, 20, CollisionFlag.BLOCKED)).toBe(false);
    await internals.registerTerrainResources(batch([]));
    expect(manager.getAllEntities().size).toBe(0);
    expect(world.collision.hasFlags(12, 22, CollisionFlag.BLOCKED)).toBe(false);
    expect(internals.terrainResourceLeases.size).toBe(1);
    unload(internals);
    expect(internals.terrainResourceLeases.size).toBe(0);
  });

  it("rejects conflicting same-coordinate variants before mutating the prior generation", async () => {
    const { manager, internals } = fixture();
    await internals.registerTerrainResources(batch());
    const entity = manager.getEntity("tree_11_21");
    await expect(
      internals.registerTerrainResources(
        batch([{ ...point(), subType: "oak" }]),
      ),
    ).rejects.toThrow("Conflicting registration");
    expect(manager.getEntity("tree_11_21")).toBe(entity);
    expect(internals.resources.size).toBe(1);
    const other = fixture();
    await expect(
      other.internals.registerTerrainResources(
        batch([point(), { ...point(), subType: "oak" }]),
      ),
    ).rejects.toThrow("Conflicting registration");
    expect(other.manager.getAllEntities().size).toBe(0);
    await internals.registerTerrainResources(batch([point(), point()]));
    expect(manager.getEntity("tree_11_21")).toBe(entity);
  });

  it("detaches queued spawn transforms and preserves legacy negative-coordinate IDs", async () => {
    const { manager, internals } = fixture();
    const input = batch([point(-25.5, -25.5)]);
    const pending = internals.registerTerrainResources(input);
    input.spawnPoints[0].position.x = 999;
    input.spawnPoints[0].scale = 500;
    await pending;
    const entity = manager.getEntity("tree_-26_-26") as ResourceEntity;
    expect(entity).toBeInstanceOf(ResourceEntity);
    expect(entity.position.x).toBe(-25.5);
    expect(entity.config.modelScale).not.toBe(500);
    unload(internals);
    expect(manager.getAllEntities().size).toBe(0);
  });

  it("rejects invalid owners/transforms and final snapped owner mismatch", async () => {
    const { manager, internals } = fixture();
    for (const input of [
      batch([point()], NaN),
      batch([point()], 0.5),
      batch([point(NaN)]),
      batch([{ ...point(), scale: -1 }]),
      batch([{ ...point(), rotation: Infinity }]),
      batch([point(75.5, 0.5)]),
    ])
      await expect(internals.registerTerrainResources(input)).rejects.toThrow();
    expect(manager.getAllEntities().size).toBe(0);
    expect(internals.terrainResourceLeases.size).toBe(0);
  });

  it("cleans pending creation after destruction and refuses any resurrection", async () => {
    const { world, manager, system, internals } = fixture();
    const pending = internals.registerTerrainResources(batch());
    system.destroy();
    await pending;
    await internals.registerTerrainResources(batch());
    expect(manager.getAllEntities().size).toBe(0);
    expect(world.collision.hasFlags(10, 20, CollisionFlag.BLOCKED)).toBe(false);
    expect(internals.resources.size).toBe(0);
  });

  it("does not destroy a foreign same-ID entity when retiring its original lease", async () => {
    const { manager, internals } = fixture();
    await internals.registerTerrainResources(batch());
    const original = manager.getEntity("tree_11_21") as ResourceEntity;
    manager.destroyEntity(original.id);
    const replacement = await manager.spawnEntity({
      ...original.config,
      name: "Independent owner",
    });
    expect(replacement).not.toBe(original);
    unload(internals);
    expect(manager.getEntity(original.id)).toBe(replacement);
  });

  it("preserves the real empty-property constructor and wire defaults", async () => {
    const { manager, internals } = fixture();
    await internals.registerTerrainResources(batch());
    const entity = manager.getEntity("tree_11_21") as ResourceEntity;
    const oldWorld = new CpuServerWorld();
    worlds.push(oldWorld);
    // Reconstruct the exact formerly accepted runtime input, despite its absent
    // declared property fields; this is the real class, not a replacement.
    const legacy: unknown = Reflect.construct(ResourceEntity, [
      oldWorld,
      { ...entity.config, properties: {} },
    ]);
    expect(legacy).toBeInstanceOf(ResourceEntity);
    if (!(legacy instanceof ResourceEntity))
      throw new Error("Unexpected resource constructor");
    try {
      await legacy.init();
      expect(entity.health).toBe(legacy.health);
      expect(entity.maxHealth).toBe(legacy.maxHealth);
      expect(entity.level).toBe(legacy.level);
      expect(entity.data.health).toBe(legacy.data.health);
      const { properties: explicit, ...currentNetwork } =
        entity.getNetworkData();
      const { properties: absent, ...legacyNetwork } = legacy.getNetworkData();
      expect(absent).toEqual({});
      expect(explicit).toEqual({});
      // Network serialization is JSON; compare that exact representation, not
      // per-instance Three vector/function prototypes carried in CPU buffers.
      expect(JSON.stringify(currentNetwork)).toBe(
        JSON.stringify(legacyNetwork),
      );
      expect(JSON.stringify(entity.serialize())).toBe(
        JSON.stringify(legacy.serialize()),
      );
    } finally {
      legacy.destroy();
    }
  });

  it("grounds authored land at its final snapped coordinate and protects it from tile unload", async () => {
    const { world, manager, internals } = fixture();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    const input = point(366, 310);
    input.position.y = -100;
    await internals.registerTerrainResources({
      isManifest: true,
      spawnPoints: [input],
    });
    const entity = manager.getEntity("tree_367_311") as ResourceEntity;
    expect(entity).toBeInstanceOf(ResourceEntity);
    expect(entity.position.x).toBe(366.5);
    expect(entity.position.z).toBe(310.5);
    expect(entity.position.y).toBe(
      terrain.getResourceGroundHeight(366.5, 310.5),
    );
    unload(internals, 4, 3);
    expect(manager.getEntity(entity.id)).toBe(entity);
    await internals.registerTerrainResources({
      isManifest: true,
      spawnPoints: [input],
    });
    expect(manager.getEntity(entity.id)).toBe(entity);
  });

  it("admits the complete real authored resource set with snapped land height and unchanged water height", async () => {
    const { world, manager, system, internals } = fixture();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    const loaders = terrain as unknown as {
      loadFlatZonesFromManifest(): void;
      loadWaterBodiesFromManifest(): void;
    };
    loaders.loadFlatZonesFromManifest();
    loaders.loadWaterBodiesFromManifest();
    await system.init();
    await internals.initializeWorldAreaResources();
    const entities = [...manager.getAllEntities().values()];
    expect(entities.length).toBe(
      Object.values(ALL_WORLD_AREAS).reduce(
        (count, area) => count + area.resources.length,
        0,
      ),
    );
    let fishing = 0;
    for (const entity of entities) {
      expect(entity).toBeInstanceOf(ResourceEntity);
      if (!(entity instanceof ResourceEntity))
        throw new Error("Unexpected entity");
      expect(entity.position.x % 1).toBe(0.5);
      expect(entity.position.z % 1).toBe(0.5);
      if (entity.config.resourceType === "fishing_spot") {
        fishing++;
        expect(entity.position.y).toBe(
          terrain
            .getWaterBodyRegistry()
            .getWaterSurfaceAt(entity.position.x, entity.position.z),
        );
      } else {
        expect(entity.position.y).toBe(
          terrain.getResourceGroundHeight(entity.position.x, entity.position.z),
        );
      }
    }
    expect(fishing).toBeGreaterThan(0);
    for (const entity of entities) {
      unload(
        internals,
        Math.floor((entity.position.x + 50) / 100),
        Math.floor((entity.position.z + 50) / 100),
      );
    }
    expect(manager.getAllEntities().size).toBe(entities.length);
  });

  for (const packet of ["single", "batch"] as const) {
    for (const networkFirst of [false, true]) {
      it(`retains authoritative client ownership (${packet}, network first: ${networkFirst})`, async () => {
        const server = fixture();
        await server.internals.registerTerrainResources(batch());
        const data = {
          ...server.manager.getEntity("tree_11_21")!.serialize(),
          depleted: true,
          position: [10.5, 34, 20.5] as [number, number, number],
          quaternion: [0, Math.sin(0.2), 0, Math.cos(0.2)] as [
            number,
            number,
            number,
            number,
          ],
        };
        const world = new World();
        worlds.push(world);
        const network = world.register(
          "network",
          ClientNetwork,
        ) as ClientNetwork;
        const system = world.register(
          "resource",
          ResourceSystem,
        ) as ResourceSystem;
        const internals = system as unknown as Internals;
        const add = () =>
          packet === "single"
            ? network.onEntityAdded(data)
            : network.onEntitiesBatchAdded([data]);
        if (networkFirst) add();
        await internals.registerTerrainResources(batch());
        const entity = world.entities.get(data.id);
        expect(entity).toBeInstanceOf(ResourceEntity);
        if (!networkFirst) add();
        expect(world.entities.get(data.id)).toBe(entity);
        if (!(entity instanceof ResourceEntity))
          throw new Error("Missing actual resource");
        expect(entity.config.depleted).toBe(true);
        expect(entity.position.toArray()).toEqual(data.position);
        expect(entity.node.quaternion.toArray()).toEqual(data.quaternion);
        expect(internals.resources.get(data.id)?.isAvailable).toBe(false);
        expect(internals.resources.get(data.id)?.position.y).toBe(34);
        unload(internals);
        expect(world.entities.get(data.id)).toBe(entity);
        expect(entity!.destroyed).toBe(false);
        // Let the actual no-renderer init chain finish before owned teardown.
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
    }
  }

  it("still destroys a client-only local terrain instance on unload", async () => {
    const world = new World();
    worlds.push(world);
    world.register("network", ClientNetwork);
    const internals = world.register(
      "resource",
      ResourceSystem,
    ) as unknown as Internals;
    await internals.registerTerrainResources(batch());
    const entity = world.entities.get("tree_11_21")!;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    unload(internals);
    expect(world.entities.get(entity.id)).toBeNull();
    expect(entity.destroyed).toBe(true);
  });

  it("rejects conflicting authoritative variant admission without transferring local ownership", async () => {
    const world = new World();
    worlds.push(world);
    const network = world.register("network", ClientNetwork) as ClientNetwork;
    const internals = world.register(
      "resource",
      ResourceSystem,
    ) as unknown as Internals;
    await internals.registerTerrainResources(batch());
    const entity = world.entities.get("tree_11_21")!;
    expect(() =>
      network.onEntityAdded({ ...entity.serialize(), resourceId: "tree_oak" }),
    ).toThrow("Conflicting authoritative resource variant");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    unload(internals);
    expect(entity.destroyed).toBe(true);
  });
});
