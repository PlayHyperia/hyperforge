import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { getNPCById } from "../../../../data/npcs";
import { ALL_WORLD_AREAS, STARTER_TOWNS } from "../../../../data/world-areas";
import { NPCEntity } from "../../../../entities/npc/NPCEntity";
import { loadPhysX } from "../../../../physics/PhysXManager";
import { EntityType } from "../../../../types/entities/entities";
import { EventType } from "../../../../types/events";
import type { WorldArea } from "../../../../types/world/world-types";
import { TerrainSystem } from "../../world/TerrainSystem";
import { TownSystem } from "../../world/TownSystem";
import { EntityManager } from "../EntityManager";
import { MobNPCSpawnerSystem } from "../MobNPCSpawnerSystem";
import { NPCSystem } from "../NPCSystem";
import { entityIdValidator } from "../../combat/EntityIdValidator";

// Real server-role World, production systems and native PhysX. No transport or
// renderer is installed: these tests qualify authoritative spawning, not VRMs.
class NPCServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
  override get isClient(): boolean {
    return false;
  }
}

beforeAll(async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await loadPhysX();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

describe("MobNPCSpawnerSystem authoritative placement identity", () => {
  const originalAreas = new Map(Object.entries(ALL_WORLD_AREAS));
  const worlds: NPCServerWorld[] = [];
  const area = (): WorldArea => ({
    id: "placement_town",
    name: "Placement Town",
    description: "Authoritative placement fixture",
    difficultyLevel: 0,
    bounds: { minX: -10, maxX: 30, minZ: -10, maxZ: 30 },
    biomeType: "starter_town",
    safeZone: true,
    npcs: [
      {
        id: "torvin",
        type: "quest_giver",
        storeId: "sword_store",
        position: { x: 2, y: 0, z: 3 },
      },
    ],
    resources: [],
    mobSpawns: [],
  });

  beforeEach(() => {
    for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
    // Keep the actual terrain/water manifest; vary only authored NPC inputs.
    for (const [key, value] of originalAreas)
      ALL_WORLD_AREAS[key] = { ...value, npcs: [] };
    ALL_WORLD_AREAS.placement_town = area();
    expect(getNPCById("torvin")).toBeDefined();
  });
  afterEach(async () => {
    for (const world of worlds.splice(0)) {
      await world.$eventBus.waitForPendingHandlers();
      world.destroy();
    }
    for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
    for (const [key, value] of originalAreas) ALL_WORLD_AREAS[key] = value;
  });

  async function fixture() {
    const world = new NPCServerWorld();
    worlds.push(world);
    await world.physics.init();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    terrain.registerFlatZone({
      id: "npc-ground",
      centerX: 2,
      centerZ: 3,
      width: 20,
      depth: 20,
      height: 7,
      blendRadius: 0,
    });
    const manager = world.register(
      "entity-manager",
      EntityManager,
    ) as EntityManager;
    await manager.init();
    const towns = world.register("towns", TownSystem) as TownSystem;
    const spawner = world.register(
      "mob-npc-spawner",
      MobNPCSpawnerSystem,
    ) as MobNPCSpawnerSystem;
    await spawner.init();
    const spawned: string[] = [],
      registrations: unknown[] = [];
    world.$eventBus.subscribe(EventType.ENTITY_SPAWNED, (event) => {
      if (
        event.data.entityType === EntityType.NPC &&
        typeof event.data.entityId === "string"
      )
        spawned.push(event.data.entityId);
    });
    world.$eventBus.subscribe(EventType.STORE_REGISTER_NPC, (event) => {
      registrations.push(event.data);
    });
    const npcs = () => manager.getEntitiesByType(EntityType.NPC) as NPCEntity[];
    return {
      world,
      terrain,
      manager,
      towns,
      spawner,
      spawned,
      registrations,
      npcs,
    };
  }

  it("preserves grounded position, manifest services/quests/model and exact store registration", async () => {
    const f = await fixture();
    await f.spawner.start();
    const [npc] = f.npcs();
    const manifest = getNPCById("torvin")!;
    expect(f.npcs()).toHaveLength(1);
    expect(npc.config).toMatchObject({
      npcId: "torvin",
      storeId: "sword_store",
      npcType: "quest_giver",
      name: manifest.name,
      model: manifest.appearance.modelPath,
      services: manifest.services.types,
      questIds: manifest.services.questIds,
      position: { x: 2, y: 7, z: 3 },
    });
    expect(f.registrations).toEqual([
      {
        npcId: npc.id,
        storeId: "sword_store",
        position: { x: 2, y: 0, z: 3 },
        name: manifest.name,
        area: "placement_town",
      },
    ]);
  });

  it("reserves concurrent and repeated startup before asynchronous Entity.init publishes", async () => {
    const f = await fixture();
    await Promise.all([
      f.spawner.start(),
      f.spawner.start(),
      f.spawner.start(),
    ]);
    await f.spawner.start();
    expect(f.npcs()).toHaveLength(1);
    expect(f.spawned).toEqual([f.npcs()[0].id]);
    expect(f.registrations).toHaveLength(1);
  });

  it("does not respawn manifest NPCs on repeated terrain unload/reload and retains town registration", async () => {
    const f = await fixture();
    const safe: unknown[] = [],
      banks: unknown[] = [];
    f.world.on("safezone:created", (event) => safe.push(event));
    f.world.on("bank:registered", (event) => banks.push(event));
    const npcSystem = f.world.register("npc", NPCSystem) as NPCSystem;
    await npcSystem.init();
    await f.spawner.start();
    for (let i = 0; i < 3; i++) {
      f.world.$eventBus.emitEvent(EventType.TERRAIN_TILE_UNLOADED, {
        tileX: 0,
        tileZ: 0,
      });
      f.world.$eventBus.emitEvent(EventType.TERRAIN_TILE_GENERATED, {
        tileX: 0,
        tileZ: 0,
        biome: "starter_town",
        contentGenerated: true,
      });
      await f.world.$eventBus.waitForPendingHandlers();
    }
    expect(f.npcs()).toHaveLength(1);
    expect(f.spawned).toHaveLength(1);
    expect(npcSystem.getTowns()).toHaveLength(
      Object.keys(STARTER_TOWNS).length,
    );
    expect(safe).toHaveLength(Object.keys(STARTER_TOWNS).length);
    expect(banks).toHaveLength(
      Object.values(STARTER_TOWNS).filter((t) =>
        t.npcs.some((n) => n.type === "bank"),
      ).length,
    );
  });

  it("retains separate placements of one definition while metadata changes do not create a new placement", async () => {
    const a = ALL_WORLD_AREAS.placement_town;
    a.npcs.push({ ...a.npcs[0], position: { x: 5, y: 0, z: 6 } });
    ALL_WORLD_AREAS.other = { ...area(), id: "other" };
    const f = await fixture();
    await f.spawner.start();
    const ids = f
      .npcs()
      .map((n) => n.id)
      .sort();
    expect(ids).toHaveLength(3);
    a.npcs[0].storeId = "different_service_metadata";
    a.npcs[0].type = "bank";
    a.npcs.reverse();
    await f.spawner.start();
    expect(
      f
        .npcs()
        .map((n) => n.id)
        .sort(),
    ).toEqual(ids);
    expect(f.spawned).toHaveLength(3);
  });

  it("shares in-flight placement ownership across spawners and keeps residents across replacement", async () => {
    const f = await fixture();
    const second = f.world.register(
      "replacement-spawner",
      MobNPCSpawnerSystem,
    ) as MobNPCSpawnerSystem;
    await second.init();
    await Promise.all([f.spawner.start(), second.start()]);
    f.spawner.destroy();
    await second.start();
    expect(f.npcs()).toHaveLength(1);
    expect(f.spawned).toHaveLength(1);
  });

  it("releases failed placement reservations so the same authored placement can retry", async () => {
    const f = await fixture();
    f.terrain.registerFlatZone({
      id: "npc-ground",
      centerX: 2,
      centerZ: 3,
      width: 20,
      depth: 20,
      height: 3000,
      blendRadius: 0,
    });
    expect(f.terrain.getHeightAt(2, 3)).toBe(3000);
    await f.spawner["spawnAllNPCsFromManifest"]();
    expect(f.npcs()).toHaveLength(0);
    f.terrain.registerFlatZone({
      id: "npc-ground",
      centerX: 2,
      centerZ: 3,
      width: 20,
      depth: 20,
      height: 7,
      blendRadius: 0,
    });
    await f.spawner["spawnAllNPCsFromManifest"]();
    expect(f.npcs()).toHaveLength(1);
    expect(f.spawned).toHaveLength(1);
  });

  it("retires a pending authoritative spawn when its spawner is destroyed", async () => {
    const f = await fixture();
    await f.spawner["spawnAllNPCsFromManifest"]();
    const config = structuredClone(f.npcs()[0].config);
    f.manager.destroyEntity(config.id);
    f.registrations.length = 0;
    const pending = f.spawner["spawnNPCPlacement"](f.manager, config);
    // Real async Entity.init yields; no delayed-loader or promise mock.
    await Promise.resolve();
    expect(f.npcs()).toHaveLength(0);
    f.spawner.destroy();
    await pending;
    expect(f.npcs()).toHaveLength(0);
    expect(f.registrations).toHaveLength(0);
    await f.spawner.start();
    expect(f.npcs()).toHaveLength(0);
  });

  it("lets a live replacement retry after the initializing owner is destroyed", async () => {
    const f = await fixture();
    await f.spawner["spawnAllNPCsFromManifest"]();
    const config = structuredClone(f.npcs()[0].config);
    f.manager.destroyEntity(config.id);
    const second = f.world.register(
      "replacement-spawner",
      MobNPCSpawnerSystem,
    ) as MobNPCSpawnerSystem;
    await second.init();
    const first = f.spawner["spawnNPCPlacement"](f.manager, config);
    const replacement = second["spawnNPCPlacement"](f.manager, config);
    await Promise.resolve();
    f.spawner.destroy();
    expect(await Promise.all([first, replacement])).toEqual([false, true]);
    expect(f.npcs()).toHaveLength(1);
    expect(f.world.entities.get(f.npcs()[0].id)).toBe(f.npcs()[0]);
  });

  it("leaves no late NPC in a destroyed real world", async () => {
    const f = await fixture();
    await f.spawner["spawnAllNPCsFromManifest"]();
    const config = structuredClone(f.npcs()[0].config);
    f.manager.destroyEntity(config.id);
    f.registrations.length = 0;
    const pending = f.spawner["spawnNPCPlacement"](f.manager, config);
    await Promise.resolve();
    f.world.destroy();
    worlds.splice(worlds.indexOf(f.world), 1);
    await pending;
    expect(f.manager.getAllEntities().size).toBe(0);
    expect(f.world.entities.items.size).toBe(0);
    expect(f.world.hot.size).toBe(0);
    expect(f.registrations).toHaveLength(0);
  });

  it("publishes each actual manifest placement once across startup and its terrain events", async () => {
    for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
    for (const [key, value] of originalAreas) ALL_WORLD_AREAS[key] = value;
    const f = await fixture();
    const npcSystem = f.world.register("npc", NPCSystem) as NPCSystem;
    await npcSystem.init();
    const placements = Object.values(ALL_WORLD_AREAS).flatMap((a) => a.npcs);
    expect(placements.length).toBeGreaterThan(0);
    await f.spawner.start();
    const size = f.terrain.getTileSize();
    for (const npc of placements) {
      f.world.$eventBus.emitEvent(EventType.TERRAIN_TILE_GENERATED, {
        tileX: Math.floor(npc.position.x / size),
        tileZ: Math.floor(npc.position.z / size),
        biome: "starter_town",
        contentGenerated: true,
      });
    }
    await f.world.$eventBus.waitForPendingHandlers();
    expect(f.npcs()).toHaveLength(placements.length);
    expect(f.spawned).toHaveLength(placements.length);
    for (const npc of f.npcs()) {
      expect(entityIdValidator.validate(npc.id).valid).toBe(true);
      expect(npc.id.startsWith(`npc_${npc.config.npcId}_`)).toBe(true);
      const definition = getNPCById(npc.config.npcId)!;
      expect(npc.config.services).toEqual(definition.services.types);
      expect(npc.config.questIds).toEqual(definition.services.questIds);
      expect(npc.config.model).toEqual(definition.appearance.modelPath);
      const { x, z } = npc.config.position;
      expect(npc.config.position.y).toBe(f.terrain.getHeightAt(x, z));
    }
  });

  it("keeps one procedural NPC per actual building, including two buildings of the same type", async () => {
    const f = await fixture();
    f.towns["towns"].push({
      id: "procedural-town",
      name: "Native Town",
      position: { x: 20, y: 7, z: 20 },
      size: "hamlet",
      safeZoneRadius: 30,
      biome: "plains",
      suitabilityScore: 1,
      connectedRoads: [],
      buildings: [0, 1].map((i) => ({
        id: `bank-${i}`,
        type: "bank",
        position: { x: 20 + i * 10, y: 7, z: 20 },
        rotation: i * 0.5,
        size: { width: 4, depth: 4 },
      })),
    });
    const points = f.towns.getAllBuildingNPCSpawnPoints();
    expect(points).toHaveLength(2);
    await Promise.all([
      f.spawner["spawnBuildingNPCs"](),
      f.spawner["spawnBuildingNPCs"](),
    ]);
    await f.spawner["spawnBuildingNPCs"]();
    expect(f.npcs()).toHaveLength(2);
    expect(f.spawned).toHaveLength(2);
    for (const point of points) {
      const npc = f.npcs().find((n) => n.config.npcId === point.buildingId)!;
      expect(entityIdValidator.validate(npc.id).valid).toBe(true);
      expect(npc.config.position).toEqual(point.position);
      expect(npc.config.rotation).toEqual({
        x: 0,
        y: Math.sin(point.rotation / 2),
        z: 0,
        w: Math.cos(point.rotation / 2),
      });
      expect(npc.config.services).toEqual(["bank"]);
    }
  });
});
