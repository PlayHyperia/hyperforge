import { afterEach, describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EntityType, ResourceType } from "../../../../types/entities";
import type { ResourceFootprint } from "../../../../types/game/resource-processing-types";
import {
  getCardinalAdjacentTiles,
  tileToWorld,
} from "../../movement/TileSystem";
import {
  FLOWER_RESOURCE_CLEARANCE_LIMITS,
  captureFlowerResourceClearance,
} from "../FlowerResourceClearance";
import type { TerrainGridBounds } from "../TerrainGridSurface";

// Real client World/Entities/ResourceEntity construction. No renderer, transport,
// asset loader or terrain job is started, and no production methods are replaced.
const worlds: World[] = [];
const resources: ResourceEntity[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.destroy();
  for (const world of worlds.splice(0)) world.destroy();
});
function createWorld() {
  const world = new World();
  worlds.push(world);
  return world;
}
function addResource(
  world: World,
  id: string,
  options: {
    resourceType?: ResourceType;
    x?: number;
    y?: number;
    z?: number;
    footprint?: ResourceFootprint;
    depleted?: boolean;
  } = {},
) {
  const resourceType = options.resourceType ?? ResourceType.TREE;
  const resource = new ResourceEntity(world, {
    id,
    name: id,
    type: EntityType.RESOURCE,
    position: { x: options.x ?? 10.5, y: options.y ?? 3, z: options.z ?? 20.5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: null,
    interactionDistance: 3,
    description: "Actual resource clearance fixture",
    model: null,
    resourceType,
    resourceId:
      resourceType === ResourceType.TREE ? "tree_general" : "ore_copper",
    harvestSkill: resourceType === ResourceType.TREE ? "woodcutting" : "mining",
    requiredLevel: 1,
    harvestTime: 3000,
    respawnTime: 60000,
    harvestYield: [],
    depleted: options.depleted ?? false,
    lastHarvestTime: 0,
    footprint: options.footprint,
    properties: {
      movementComponent: null,
      combatComponent: null,
      healthComponent: null,
      visualComponent: null,
      health: { current: 0, max: 0 },
      level: 1,
      resourceType,
      harvestable: true,
      respawnTime: 60000,
      toolRequired: "none",
      skillRequired: "none",
      xpReward: 0,
    },
  });
  resources.push(resource);
  world.entities.set(id, resource);
  return resource;
}

describe("bounded live flower resource clearance", () => {
  it("captures actual client tree/ore actors without a ResourceSystem registration", () => {
    const world = createWorld();
    addResource(world, "tree_z", {
      x: -0.25,
      z: -20.25,
      footprint: "standard",
    });
    const ore = addResource(world, "ore_a", {
      resourceType: ResourceType.MINING_ROCK,
      footprint: "large",
    });
    addResource(world, "fish", { resourceType: ResourceType.FISHING_SPOT });
    ore.position.set(30.25, 9, -3.25);
    expect(ore.config.position).not.toEqual({ x: 30.25, y: 9, z: -3.25 });
    const snapshot = captureFlowerResourceClearance(world);
    expect(snapshot.rows.map((row) => row.id)).toEqual(["ore_a", "tree_z"]);
    expect(snapshot.rows[0].position).toEqual({ x: 30.25, y: 9, z: -3.25 });
    expect(snapshot.rows[1].anchorTile).toEqual({ x: -1, z: -21 });
    expect(snapshot.receipt).toEqual({
      schemaVersion: 1,
      policy: "live-resource-tile-envelope-v1",
      scannedEntities: 3,
      obstacleCount: 2,
      conservativeFallbackCount: 0,
      limits: { maxScannedEntities: 4096, maxObstacles: 512 },
    });
    expect(snapshot.isCurrent()).toBe(true);
  });

  for (const [footprint, size] of [
    ["standard", 1],
    ["large", 2],
    ["massive", 3],
  ] as const) {
    it(`reserves every occupied/cardinal approach tile for ${footprint}`, () => {
      const world = createWorld();
      addResource(world, "tree", { x: -2.5, z: -4.5, footprint });
      const snapshot = captureFlowerResourceClearance(world);
      const row = snapshot.rows[0];
      expect(row.radius).toBe(Math.hypot(size / 2 + 1, size / 2 + 1));
      const tiles = getCardinalAdjacentTiles(row.anchorTile, size, size);
      expect(tiles).toHaveLength(size * 4);
      for (let x = 0; x < size; x++)
        for (let z = 0; z < size; z++) {
          tiles.push({ x: row.anchorTile.x + x, z: row.anchorTile.z + z });
        }
      for (const tile of tiles) {
        const center = tileToWorld(tile);
        expect(snapshot.accepts(center, 0)).toBe(false);
        for (const dx of [-0.499, 0.499])
          for (const dz of [-0.499, 0.499]) {
            expect(
              snapshot.accepts({ x: center.x + dx, z: center.z + dz }, 0),
            ).toBe(false);
          }
      }
      expect(
        snapshot.accepts(
          { x: row.center.x + row.radius + 0.1, z: row.center.z },
          0,
        ),
      ).toBe(true);
    });
  }

  it("uses a conservative massive footprint for omitted client metadata", () => {
    const world = createWorld();
    addResource(world, "tree");
    const snapshot = captureFlowerResourceClearance(world);
    expect(snapshot.rows[0].footprint).toBe("massive");
    expect(snapshot.rows[0].footprintSource).toBe("conservative-max");
    expect(snapshot.rows[0].radius).toBe(Math.hypot(2.5, 2.5));
    expect(snapshot.receipt.conservativeFallbackCount).toBe(1);
  });

  it("expands the reservation by the supplied maximum flower geometry/wind reach", () => {
    const world = createWorld();
    addResource(world, "tree", { footprint: "standard" });
    const snapshot = captureFlowerResourceClearance(world);
    const row = snapshot.rows[0];
    const point = { x: row.center.x + row.radius + 0.25, z: row.center.z };
    expect(snapshot.accepts(point, 0.2)).toBe(true);
    expect(snapshot.accepts(point, 0.3)).toBe(false);
    for (const reach of [-1, NaN, Infinity])
      expect(snapshot.accepts(point, reach)).toBe(false);
    expect(snapshot.accepts({ x: NaN, z: 0 }, 0)).toBe(false);
    expect(snapshot.accepts({ x: 0, z: Infinity }, 0)).toBe(false);
  });

  it("preserves depleted/regrowing resource clearance and detaches all receipt rows", () => {
    const world = createWorld();
    const tree = addResource(world, "tree", { depleted: true });
    const snapshot = captureFlowerResourceClearance(world);
    expect(snapshot.rows[0].depleted).toBe(true);
    expect(snapshot.accepts(tree.position, 0)).toBe(false);
    for (const value of [
      snapshot,
      snapshot.rows,
      snapshot.rows[0],
      snapshot.rows[0].position,
      snapshot.rows[0].center,
      snapshot.rows[0].anchorTile,
      snapshot.receipt,
      snapshot.receipt.limits,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    tree.config.depleted = false;
    expect(snapshot.rows[0].depleted).toBe(true);
    expect(snapshot.isCurrent()).toBe(false);
    const regrown = captureFlowerResourceClearance(world);
    expect(regrown.accepts(tree.position, 0)).toBe(false);
    expect(regrown.rows[0].radius).toBe(snapshot.rows[0].radius);
    expect(regrown.isCurrent()).toBe(true);
  });

  it("revalidates additions, removal, and identical-scalar same-ID owner replacement", () => {
    const world = createWorld();
    const first = addResource(world, "tree", { footprint: "standard" });
    const before = captureFlowerResourceClearance(world);
    const added = addResource(world, "ore", {
      resourceType: ResourceType.MINING_ROCK,
    });
    expect(before.isCurrent()).toBe(false);
    world.entities.remove(added.id);
    expect(before.isCurrent()).toBe(true);
    const replacement = addResource(world, first.id, { footprint: "standard" });
    expect(replacement.position.toArray()).toEqual(first.position.toArray());
    expect(before.isCurrent()).toBe(false);
    const replaced = captureFlowerResourceClearance(world);
    world.entities.remove(replacement.id);
    expect(replaced.isCurrent()).toBe(false);
  });

  it("revalidates live transform and footprint changes without relying on events", () => {
    const world = createWorld();
    const tree = addResource(world, "tree", { footprint: "standard" });
    const snapshot = captureFlowerResourceClearance(world);
    tree.position.y += 0.1;
    expect(snapshot.isCurrent()).toBe(false);
    tree.position.y = snapshot.rows[0].position.y;
    tree.config.footprint = "large";
    expect(snapshot.isCurrent()).toBe(false);
    tree.config.footprint = "standard";
    tree.position.x += 20;
    // Candidate checks intentionally use only the detached job snapshot.
    expect(snapshot.accepts(tree.position, 0)).toBe(true);
    expect(snapshot.isCurrent()).toBe(false);
    expect(
      captureFlowerResourceClearance(world).accepts(tree.position, 0),
    ).toBe(false);
  });

  it("does not depend on insertion order or unrelated fishing state", () => {
    const world = createWorld();
    const tree = addResource(world, "tree");
    const ore = addResource(world, "ore", {
      resourceType: ResourceType.MINING_ROCK,
    });
    const snapshot = captureFlowerResourceClearance(world);
    world.entities.items.delete(tree.id);
    world.entities.set(tree.id, tree);
    addResource(world, "fish", { resourceType: ResourceType.FISHING_SPOT });
    expect(world.entities.get(ore.id)).toBe(ore);
    expect(snapshot.isCurrent()).toBe(true);
  });

  it("rejects source ownership inconsistencies and duplicate aliases", () => {
    const world = createWorld();
    const tree = addResource(world, "tree");
    world.entities.items.delete(tree.id);
    world.entities.set("wrong-key", tree);
    expect(() => captureFlowerResourceClearance(world)).toThrow(/ownership/);
    world.entities.set(tree.id, tree);
    expect(() => captureFlowerResourceClearance(world)).toThrow(/ownership/);
    world.entities.items.delete("wrong-key");
    const snapshot = captureFlowerResourceClearance(world);
    tree.destroy();
    expect(snapshot.isCurrent()).toBe(false);
    expect(captureFlowerResourceClearance(world).rows).toEqual([]);
  });

  it("rejects a foreign-world actor even if installed in the local entity map", () => {
    const world = createWorld();
    const foreign = addResource(createWorld(), "tree");
    world.entities.set(foreign.id, foreign);
    expect(() => captureFlowerResourceClearance(world)).toThrow(/ownership/);
  });

  for (const axis of ["x", "y", "z"] as const) {
    it(`fails closed on a nonfinite live ${axis} coordinate`, () => {
      const world = createWorld();
      const tree = addResource(world, "tree");
      const snapshot = captureFlowerResourceClearance(world);
      tree.position[axis] = NaN;
      expect(snapshot.isCurrent()).toBe(false);
      expect(() => captureFlowerResourceClearance(world)).toThrow(/position/);
    });
  }

  it("does not convert malformed explicit footprints into a fallback", () => {
    const world = createWorld();
    const tree = addResource(world, "tree");
    const snapshot = captureFlowerResourceClearance(world);
    Object.defineProperty(tree.config, "footprint", {
      value: "unknown",
      configurable: true,
    });
    expect(snapshot.isCurrent()).toBe(false);
    expect(() => captureFlowerResourceClearance(world)).toThrow(/footprint/);
  });

  it("enforces both exact inclusive bounds and retains no partial admission", () => {
    const world = createWorld();
    addResource(world, "tree");
    addResource(world, "fish", { resourceType: ResourceType.FISHING_SPOT });
    const snapshot = captureFlowerResourceClearance(world, {
      maxScannedEntities: 2,
      maxObstacles: 1,
    });
    expect(snapshot.receipt.scannedEntities).toBe(2);
    expect(snapshot.isCurrent()).toBe(true);
    const ore = addResource(world, "ore", {
      resourceType: ResourceType.MINING_ROCK,
    });
    expect(snapshot.isCurrent()).toBe(false);
    expect(() =>
      captureFlowerResourceClearance(world, { maxScannedEntities: 2 }),
    ).toThrow(/scanned-entity cap/);
    expect(() =>
      captureFlowerResourceClearance(world, { maxObstacles: 1 }),
    ).toThrow(/obstacle cap/);
    world.entities.remove(ore.id);
    expect(snapshot.isCurrent()).toBe(true);
  });

  for (const key of ["maxScannedEntities", "maxObstacles"] as const) {
    for (const limit of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      FLOWER_RESOURCE_CLEARANCE_LIMITS[key] + 1,
    ]) {
      it(`rejects invalid ${key} limit ${limit}`, () => {
        expect(() =>
          captureFlowerResourceClearance(createWorld(), { [key]: limit }),
        ).toThrow(/limits/);
      });
    }
  }
});

describe("region-scoped live flower resource reservations", () => {
  const bounds: Readonly<TerrainGridBounds> = Object.freeze({
    minX: 0,
    maxX: 10,
    minZ: 0,
    maxZ: 10,
  });

  it("retains intersecting circle envelopes even when resource positions and circle centers are outside", () => {
    const world = createWorld();
    addResource(world, "near", { x: 5.25, z: 5.25, footprint: "standard" });
    addResource(world, "crossing", {
      x: 11.25,
      z: 5.25,
      footprint: "standard",
    });
    addResource(world, "corner", { x: 11.25, z: 11.25, footprint: "standard" });
    addResource(world, "outside", {
      x: 12.25,
      z: 12.25,
      footprint: "standard",
    });
    const snapshot = captureFlowerResourceClearance(
      world,
      { maxObstacles: 3 },
      bounds,
    );
    expect(snapshot.rows.map((row) => row.id)).toEqual([
      "corner",
      "crossing",
      "near",
    ]);
    expect(snapshot.rows[0].center).toEqual({ x: 11.5, z: 11.5 });
    expect(snapshot.accepts({ x: 10, z: 10 }, 0)).toBe(false);
    expect(snapshot.accepts({ x: 10, z: 5.5 }, 0)).toBe(false);
    expect(snapshot.receipt.scannedEntities).toBe(4);
    expect(snapshot.receipt.obstacleCount).toBe(3);
    expect(snapshot.receipt.region).toEqual(bounds);
    expect(snapshot.isCurrent()).toBe(true);
    expect(() =>
      captureFlowerResourceClearance(world, { maxObstacles: 3 }),
    ).toThrow(/obstacle cap/);
  });

  it("ignores distant additions/removal but detects new nearby actors and far actors relocating into the region", () => {
    const world = createWorld();
    const near = addResource(world, "near", { x: 5.25, z: 5.25 });
    const far = addResource(world, "far", { x: 50.25, z: 50.25 });
    const snapshot = captureFlowerResourceClearance(world, {}, bounds);
    const distantAddition = addResource(world, "distant-addition", {
      x: 100,
      z: 100,
    });
    expect(snapshot.isCurrent()).toBe(true);
    world.entities.remove(distantAddition.id);
    expect(snapshot.isCurrent()).toBe(true);
    const nearAddition = addResource(world, "near-addition", {
      x: 8.25,
      z: 8.25,
    });
    expect(snapshot.isCurrent()).toBe(false);
    world.entities.remove(nearAddition.id);
    expect(snapshot.isCurrent()).toBe(true);
    far.position.set(8.25, 3, 8.25);
    expect(snapshot.isCurrent()).toBe(false);
    far.position.set(50.25, 3, 50.25);
    expect(snapshot.isCurrent()).toBe(true);
    near.position.set(50, 3, 50);
    expect(snapshot.isCurrent()).toBe(false);
    near.position.set(5.25, 3, 5.25);
    expect(snapshot.isCurrent()).toBe(true);
    world.entities.remove(near.id);
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("preserves same-ID entity and actual node ownership for retained actors", () => {
    const world = createWorld();
    const near = addResource(world, "near", { x: 5.25, z: 5.25 });
    addResource(world, "far", { x: 50.25, z: 50.25 });
    const snapshot = captureFlowerResourceClearance(world, {}, bounds);
    addResource(world, "far", { x: 50.25, z: 50.25 });
    expect(snapshot.isCurrent()).toBe(true);
    const originalNode = near.node;
    near.node = new THREE.Object3D();
    near.node.position.copy(originalNode.position);
    near.node.quaternion.copy(originalNode.quaternion);
    near.node.scale.copy(originalNode.scale);
    expect(near.node.position.toArray()).toEqual(
      originalNode.position.toArray(),
    );
    expect(snapshot.isCurrent()).toBe(false);
    near.node = originalNode;
    expect(snapshot.isCurrent()).toBe(true);
    const replacement = addResource(world, "near", { x: 5.25, z: 5.25 });
    expect(replacement.position.toArray()).toEqual(near.position.toArray());
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("keeps geometric regrowth reservations current across depletion while retaining at-capture audit state", () => {
    const world = createWorld();
    const near = addResource(world, "near", {
      x: 5.25,
      z: 5.25,
      depleted: true,
    });
    const far = addResource(world, "far", { x: 50.25, z: 50.25 });
    const scoped = captureFlowerResourceClearance(world, {}, bounds);
    const unscoped = captureFlowerResourceClearance(world);
    near.config.depleted = false;
    far.config.depleted = true;
    expect(scoped.isCurrent()).toBe(true);
    expect(unscoped.isCurrent()).toBe(false);
    expect(scoped.rows[0].depleted).toBe(true);
    expect(scoped.accepts(near.position, 0)).toBe(false);
    expect(
      captureFlowerResourceClearance(world, {}, bounds).rows[0].depleted,
    ).toBe(false);
    near.config.depleted = true;
    expect(scoped.isCurrent()).toBe(true);
    Object.defineProperty(far.config, "depleted", {
      value: "invalid",
      configurable: true,
    });
    expect(scoped.isCurrent()).toBe(false);
    expect(() => captureFlowerResourceClearance(world, {}, bounds)).toThrow(
      /position\/state/,
    );
  });

  it("still invalidates clearance-relevant type, position and footprint changes", () => {
    const world = createWorld();
    const near = addResource(world, "near", {
      x: 5.25,
      z: 5.25,
      footprint: "standard",
    });
    const snapshot = captureFlowerResourceClearance(world, {}, bounds);
    near.config.resourceType = ResourceType.MINING_ROCK;
    expect(snapshot.isCurrent()).toBe(false);
    near.config.resourceType = ResourceType.TREE;
    expect(snapshot.isCurrent()).toBe(true);
    near.config.footprint = "large";
    expect(snapshot.isCurrent()).toBe(false);
    near.config.footprint = "standard";
    near.position.y += 0.1;
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("captures a detached frozen region and rejects candidate reach beyond it", () => {
    const world = createWorld();
    addResource(world, "just-outside", {
      x: 13.25,
      z: 5.25,
      footprint: "standard",
    });
    const requested = { ...bounds };
    const snapshot = captureFlowerResourceClearance(world, {}, requested);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.receipt.region).not.toBe(requested);
    expect(Object.isFrozen(snapshot.receipt.region)).toBe(true);
    requested.maxX = 100;
    expect(snapshot.receipt.region).toEqual(bounds);
    expect(snapshot.isCurrent()).toBe(true);
    expect(snapshot.accepts({ x: 9, z: 5 }, 1)).toBe(true);
    // This omitted obstacle could intersect a flower extending outside capture.
    expect(snapshot.accepts({ x: 9, z: 5 }, 3)).toBe(false);
    expect(snapshot.accepts({ x: -0.01, z: 5 }, 0)).toBe(false);
    expect(snapshot.accepts({ x: 5, z: 5 }, 5)).toBe(true);
    expect(snapshot.accepts({ x: 5, z: 5 }, 5.001)).toBe(false);
    expect(captureFlowerResourceClearance(world).receipt).not.toHaveProperty(
      "region",
    );
  });

  it("caps all scanned actors but only relevant obstacles without returning a partial snapshot", () => {
    const world = createWorld();
    addResource(world, "near", { x: 5.25, z: 5.25 });
    const far = addResource(world, "far", { x: 50.25, z: 50.25 });
    addResource(world, "farther", { x: 100, z: 100 });
    const limits = { maxScannedEntities: 3, maxObstacles: 1 };
    const snapshot = captureFlowerResourceClearance(world, limits, bounds);
    expect(snapshot.receipt.scannedEntities).toBe(3);
    expect(snapshot.receipt.obstacleCount).toBe(1);
    const extra = addResource(world, "extra-distant", { x: 200, z: 200 });
    expect(snapshot.isCurrent()).toBe(false);
    expect(() => captureFlowerResourceClearance(world, limits, bounds)).toThrow(
      /scanned-entity cap/,
    );
    world.entities.remove(extra.id);
    expect(snapshot.isCurrent()).toBe(true);
    far.position.set(8.25, 3, 8.25);
    expect(snapshot.isCurrent()).toBe(false);
    expect(() => captureFlowerResourceClearance(world, limits, bounds)).toThrow(
      /obstacle cap/,
    );
  });

  it("rejects malformed, nonfinite, reversed and accessor regions without invoking getters", () => {
    const world = createWorld();
    for (const invalid of [
      null,
      {},
      { ...bounds, minX: NaN },
      { ...bounds, maxX: Infinity },
      { ...bounds, minZ: -Infinity },
      { ...bounds, maxZ: NaN },
      { ...bounds, minX: 11 },
      { ...bounds, minZ: 11 },
      { ...bounds, minX: -Number.MAX_VALUE, maxX: Number.MAX_VALUE },
    ])
      expect(() =>
        Reflect.apply(captureFlowerResourceClearance, undefined, [
          world,
          {},
          invalid,
        ]),
      ).toThrow(/region/);
    let reads = 0;
    const accessor = { ...bounds };
    Object.defineProperty(accessor, "maxX", {
      get() {
        reads++;
        return 10;
      },
    });
    expect(() => captureFlowerResourceClearance(world, {}, accessor)).toThrow(
      /region/,
    );
    expect(reads).toBe(0);
  });
});
