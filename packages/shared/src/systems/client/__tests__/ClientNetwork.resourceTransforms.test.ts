import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { ResourceEntity } from "../../../entities/world/ResourceEntity";
import { PlayerEntity } from "../../../entities/player/PlayerEntity";
import THREE from "../../../extras/three/three";
import { EventType } from "../../../types/events";
import { EntityType, ResourceType } from "../../../types/entities";
import { TerrainSystem } from "../../shared/world/TerrainSystem";
import { ClientNetwork } from "../ClientNetwork";
import { PLAYER_ROOT_CLEARANCE } from "../../../utils/movement/PlayerSupport";

type AuthoredTerrainInitialization = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function createWorld() {
  const world = new World();
  const terrain = new TerrainSystem(world);
  world.addSystem("terrain", terrain);
  // Real admitted initialization before client networking; no renderer is started.
  await terrain.init();
  // The two production start-phase loaders, without starting tile/physics streaming.
  const authored = terrain as unknown as AuthoredTerrainInitialization;
  authored.loadWaterBodiesFromManifest();
  authored.loadFlatZonesFromManifest();
  const network = new ClientNetwork(world);
  world.addSystem("network", network);
  cleanups.push(
    () => terrain.destroy(),
    () => network.destroy(),
  );
  return { world, terrain, network };
}

function addFishingSpot(
  world: World,
  resourceType = ResourceType.FISHING_SPOT,
) {
  const harvestSkill =
    resourceType === ResourceType.TREE
      ? "woodcutting"
      : resourceType === ResourceType.MINING_ROCK
        ? "mining"
        : "fishing";
  const spot = new ResourceEntity(world, {
    id: "fish_341_308",
    name: "Net Fishing Spot",
    type: EntityType.RESOURCE,
    position: { x: 340.5, y: 27.8, z: 307.5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: null,
    interactionDistance: 2,
    description: "Fishing relocation regression",
    model: null,
    resourceType,
    resourceId:
      resourceType === ResourceType.TREE
        ? "tree_general"
        : resourceType === ResourceType.MINING_ROCK
          ? "ore_copper"
          : "fishing_spot_net",
    harvestSkill,
    requiredLevel: 1,
    harvestTime: 3000,
    respawnTime: 0,
    harvestYield: [],
    depleted: false,
    lastHarvestTime: 0,
    properties: {
      movementComponent: null,
      combatComponent: null,
      healthComponent: null,
      visualComponent: null,
      health: { current: 0, max: 0 },
      level: 1,
      resourceType,
      harvestable: true,
      respawnTime: 0,
      toolRequired: "small_fishing_net",
      skillRequired: harvestSkill,
      xpReward: 0,
    },
  });
  world.entities.items.set(spot.id, spot);
  cleanups.push(() => {
    world.entities.items.delete(spot.id);
    spot.destroy();
  });
  return spot;
}

describe("actual resource network transform ownership", () => {
  for (const moveFirst of [true, false]) {
    it(`keeps fishing on water through actual packet handlers and frame updates (move first: ${moveFirst})`, async () => {
      const { world, terrain, network } = await createWorld();
      const spot = addFishingSpot(world);
      // Exact moved coordinate retained by probe27; Y comes from the real registry.
      const target = {
        x: 347.5,
        y: terrain.getWaterBodyRegistry().getWaterSurfaceAt(347.5, 306.25),
        z: 306.25,
      };
      const bedHeight = terrain.getHeightAt(target.x, target.z);
      expect(target.y - bedHeight).toBeGreaterThan(0.8);
      const moved = () =>
        network.onFishingSpotMoved({
          resourceId: spot.id,
          oldPosition: { x: 340.5, y: 27.8, z: 307.5 },
          newPosition: { ...target },
        });
      const modified = () =>
        network.onEntityModified({
          id: spot.id,
          changes: {
            p: [target.x, target.y, target.z],
            q: [0, 0, 0, 1],
            position: [target.x, target.y, target.z],
          },
        });
      if (moveFirst) {
        moved();
        network.lateUpdate(1 / 60);
        modified();
      } else {
        modified();
        network.lateUpdate(1 / 60);
        moved();
      }
      for (let frame = 0; frame < 120; frame++) network.lateUpdate(1 / 60);
      expect(spot.position.toArray()).toEqual([target.x, target.y, target.z]);
      expect(spot.config.position).toEqual(target);
      expect(spot.data.position).toEqual([target.x, target.y, target.z]);
      expect(network.tileInterpolator.hasState(spot.id)).toBe(false);
    });
  }

  it("applies isolated/repeated relocation without retaining packets or stale character interpolation", async () => {
    const { world, terrain, network } = await createWorld();
    const spot = addFishingSpot(world);
    const rotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      0.6,
    );
    network.tileInterpolator.setCombatRotation(
      spot.id,
      rotation,
      spot.position,
    );
    expect(network.tileInterpolator.hasState(spot.id)).toBe(true);
    let movedEvents = 0;
    world.on(EventType.RESOURCE_SPAWNED, () => {
      movedEvents++;
    });
    for (const [x, z] of [
      [347.5, 306.25],
      [340.5, 307.5],
      [343.5, 298.5],
    ]) {
      const target = {
        x,
        y: terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
        z,
      };
      const packet = {
        resourceId: spot.id,
        oldPosition: spot.getPosition(),
        newPosition: { ...target },
      };
      network.onFishingSpotMoved(packet);
      packet.newPosition.y = -100;
      for (let frame = 0; frame < 10; frame++) network.lateUpdate(1 / 60);
      expect(spot.getPosition()).toEqual(target);
      expect(spot.config.position).toEqual(target);
      expect(spot.data.position).toEqual([target.x, target.y, target.z]);
      expect(network.tileInterpolator.hasState(spot.id)).toBe(false);
    }
    expect(movedEvents).toBe(3);
    expect(spot.networkDirty).toBe(false);
  });

  for (const resourceType of [
    ResourceType.FISHING_SPOT,
    ResourceType.TREE,
    ResourceType.MINING_ROCK,
  ]) {
    it(`preserves direct p-only, q-only and metadata updates for an actual ${resourceType} resource`, async () => {
      const { world, network } = await createWorld();
      const spot = addFishingSpot(world, resourceType);
      const target = [347.5, 30, 306.25];
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        1.2,
      );
      const received: unknown[] = [];
      world.on(EventType.ENTITY_MODIFIED, (event) => {
        received.push(event);
      });
      network.onEntityModified({ id: spot.id, p: target });
      network.tileInterpolator.setCombatRotation(
        spot.id,
        rotation,
        spot.position,
      );
      network.onEntityModified({
        id: spot.id,
        changes: { q: rotation.toArray() },
      });
      expect(network.tileInterpolator.hasState(spot.id)).toBe(false);
      network.tileInterpolator.setCombatRotation(
        spot.id,
        rotation,
        spot.position,
      );
      network.onEntityModified({
        id: spot.id,
        changes: { description: "Replicated resource description" },
      });
      for (let frame = 0; frame < 20; frame++) network.lateUpdate(1 / 60);
      expect(spot.position.toArray()).toEqual(target);
      expect(spot.config.position).toEqual({
        x: target[0],
        y: target[1],
        z: target[2],
      });
      expect(spot.data.position).toEqual(target);
      expect(spot.data.position).not.toBe(target);
      expect(spot.node.quaternion.angleTo(rotation)).toBeLessThan(1e-6);
      expect(spot.data.quaternion).toEqual(rotation.toArray());
      expect(spot.config.rotation).toEqual({
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
        w: rotation.w,
      });
      expect(spot.data.description).toBe("Replicated resource description");
      expect(received).toHaveLength(3);
      expect(network.tileInterpolator.hasState(spot.id)).toBe(false);
      expect(spot.networkDirty).toBe(false);
    });
  }

  it("rejects invalid transform fields before merging data while preserving ordinary resource updates", async () => {
    const { world, network } = await createWorld();
    const spot = addFishingSpot(world);
    const position = [347.5, 27.8, 306.25];
    const quaternion = [0, 0, 0, 1];
    network.onEntityModified({
      id: spot.id,
      changes: { position, quaternion },
    });
    const metadata = {
      health: 17,
      depleted: false,
      properties: { harvestable: false, xpReward: 7 },
      description: "Still propagated with an invalid transform",
      e: "idle",
    };
    for (const invalid of [
      { p: [347.5, Number.NaN, 306.25], q: [0, 0, 0, Infinity] },
      { position: [347.5, -Infinity, 306.25], quaternion: [0, 0, 0] },
      { position: "invalid", quaternion: [0, 0, "invalid", 1] },
    ]) {
      network.tileInterpolator.setCombatRotation(
        spot.id,
        new THREE.Quaternion(),
        spot.position,
      );
      network.onEntityModified({
        id: spot.id,
        changes: { ...metadata, ...invalid },
      });
      for (let frame = 0; frame < 20; frame++) network.lateUpdate(1 / 60);
      expect(spot.position.toArray()).toEqual(position);
      expect(spot.data.position).toEqual(position);
      expect(spot.config.position).toEqual({ x: 347.5, y: 27.8, z: 306.25 });
      expect(spot.node.quaternion.toArray()).toEqual(quaternion);
      expect(spot.data.quaternion).toEqual(quaternion);
      expect(spot.config.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
      expect(spot.data).toMatchObject(metadata);
      expect(spot.data.emote).toBe("idle");
      expect(network.tileInterpolator.hasState(spot.id)).toBe(false);
    }
    // Depletion still uses the existing specialized handler/ResourceEntity method;
    // ordinary data merges above must not replace that ownership.
    let depletedEvents = 0;
    world.on(EventType.RESOURCE_DEPLETED, () => depletedEvents++);
    network.onResourceDepleted({ resourceId: spot.id });
    await Promise.resolve();
    expect(spot.config.depleted).toBe(true);
    expect(depletedEvents).toBe(1);
    expect(spot.networkDirty).toBe(false);
  });

  it("keeps actual PlayerEntity ground-following with player clearance and smooth stationary facing", async () => {
    const { world, terrain, network } = await createWorld();
    const player = new PlayerEntity(world, {
      id: "resource-regression-player",
      name: "Character control",
      type: "player",
      position: [347.5, 27.8, 306.25],
      quaternion: [0, 0, 0, 1],
    });
    world.entities.items.set(player.id, player);
    cleanups.push(() => {
      world.entities.items.delete(player.id);
      player.destroy();
    });
    network.onEntityModified({
      id: player.id,
      changes: { p: [347.5, 27.8, 306.25], q: [0, 0, 0, 1] },
    });
    network.lateUpdate(1 / 60);
    expect(network.tileInterpolator.hasState(player.id)).toBe(true);
    expect(player.position.y).toBe(
      terrain.getHeightAt(347.5, 306.25) + PLAYER_ROOT_CLEARANCE,
    );
    const before = player.node.quaternion.clone();
    const target = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    network.onEntityModified({
      id: player.id,
      changes: { q: target.toArray() },
    });
    network.lateUpdate(1 / 60);
    expect(player.node.quaternion.angleTo(before)).toBeGreaterThan(0);
    expect(player.node.quaternion.angleTo(target)).toBeGreaterThan(0.1);
    for (let frame = 0; frame < 120; frame++) network.lateUpdate(1 / 60);
    expect(player.node.quaternion.angleTo(target)).toBeLessThan(0.001);
    expect(player.position.y).toBe(
      terrain.getHeightAt(347.5, 306.25) + PLAYER_ROOT_CLEARANCE,
    );
  });
});
