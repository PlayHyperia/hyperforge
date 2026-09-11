import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { PlayerEntity } from "../../../entities/player/PlayerEntity";
import THREE from "../../../extras/three/three";
import { getDuelArenaGradeHeight } from "../../../data/arena-grading";
import { TerrainSystem } from "../../shared/world/TerrainSystem";
import { TownSystem } from "../../shared/world/TownSystem";
import type { BuildingLayoutInput } from "../../../types/world/building-collision-types";
import { ClientNetwork } from "../ClientNetwork";

// Actual CPU World/Terrain/Player/packet/interpolation path. This does not start
// a renderer or prove animated sole contact; the actual WebGPU capture does that.
type AuthoredTerrainInitialization = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(x: number, z: number, serverY: number) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  const authored = terrain as unknown as AuthoredTerrainInitialization;
  authored.loadWaterBodiesFromManifest();
  authored.loadFlatZonesFromManifest();
  const network = world.register("network", ClientNetwork) as ClientNetwork;
  const player = new PlayerEntity(world, {
    id: "actual-support-player",
    name: "Ground support regression",
    type: "player",
    position: [x, serverY, z],
    quaternion: [0, 0, 0, 1],
  });
  world.entities.set(player.id, player);
  cleanups.push(() => {
    world.entities.items.delete(player.id);
    world.entities.players.delete(player.id);
    player.destroy();
    world.destroy();
  });
  network.onEntityModified({
    id: player.id,
    changes: { p: [x, serverY, z], q: [0, 0, 0, 1] },
  });
  return { world, terrain, network, player };
}

describe("actual client player solid-surface support", () => {
  for (const [name, x, z] of [
    ["lobby", 385.5, 374.5],
    ["hospital", 345.5, 376.5],
    ["arena", 350.5, 405.5],
  ] as const) {
    it(`${name}: packet, stationary facing, diagonal walking and stop use the same solid top and clearance`, async () => {
      const grade = getDuelArenaGradeHeight();
      const { terrain, network, player } = await fixture(x, z, grade + 0.5);
      // Solid top is .27m centre + .3m thickness/2; terrain stays .4m.
      // These explicit independent values guard the former .4/.42 disagreement.
      const expectedRootY = grade + 0.42 + 0.01;
      expect(terrain.getHeightAt(x, z)).toBeCloseTo(grade + 0.4, 10);
      network.lateUpdate(1 / 60);
      expect(player.position.y).toBeCloseTo(expectedRootY, 10);
      expect(player.node.position.y).toBeCloseTo(expectedRootY, 10);
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.PI / 2,
      );
      network.onEntityModified({
        id: player.id,
        changes: { q: rotation.toArray() },
      });
      for (let frame = 0; frame < 20; frame++) {
        network.lateUpdate(1 / 60);
        expect(player.position.y).toBeCloseTo(expectedRootY, 10);
      }
      network.tileInterpolator.onMovementStart(
        player.id,
        [{ x: Math.floor(x) + 1, z: Math.floor(z) + 1 }],
        false,
        player.position,
        { x: Math.floor(x), z: Math.floor(z) },
        { x: Math.floor(x) + 1, z: Math.floor(z) + 1 },
        1,
      );
      for (let frame = 0; frame < 180; frame++) {
        network.lateUpdate(1 / 60);
        expect(player.position.y).toBeCloseTo(expectedRootY, 10);
        expect(player.node.position.y).toBeCloseTo(expectedRootY, 10);
      }
      expect(player.position.x).toBeCloseTo(x + 1, 8);
      expect(player.position.z).toBeCloseTo(z + 1, 8);
      expect(terrain.getHeightAt(x, z)).toBeCloseTo(grade + 0.4, 10);
    });
  }

  it("retains authoritative ground and upper-floor packet Y through the actual town-owned collision service", async () => {
    const { world, network, player } = await fixture(300.5, 320.5, 35.61);
    const towns = world.register("towns", TownSystem) as TownSystem;
    await towns.init();
    const floor = () => ({
      footprint: [
        [true, true],
        [true, true],
      ],
      roomMap: [
        [0, 0],
        [0, 0],
      ],
      internalOpenings: new Map<string, string>(),
      externalOpenings: new Map([["0,0,north", "door"]]),
    });
    const layout: BuildingLayoutInput = {
      width: 2,
      depth: 2,
      floors: 2,
      floorPlans: [floor(), floor()],
      stairs: null,
    };
    const collision = towns.getCollisionService();
    collision.registerBuilding(
      "client-support-building",
      "support-town",
      layout,
      { x: 300, y: 35, z: 320 },
      0,
    );
    expect(collision.isNearBuildingForElevation(300.5, 320.5)).toBe(true);
    // The first rotation packet already created interpolation state. It must
    // retain its authoritative initial height before any movement packet.
    network.lateUpdate(1 / 60);
    expect(player.position.y).toBe(35.61);
    let tickNumber = 1;
    for (const index of [0, 1, 0]) {
      const surface = collision.getFloorHeight(
        "client-support-building",
        index,
      )!;
      expect(surface).toBeGreaterThan(35);
      const serverRootY = surface + 0.01;
      network.onEntityTileUpdate({
        id: player.id,
        tile: { x: 300, z: 320 },
        worldPos: [300.5, serverRootY, 320.5],
        quaternion: [0, 0, 0, 1],
        emote: "idle",
        tickNumber: tickNumber++,
        moveSeq: 1,
      });
      for (let frame = 0; frame < 120; frame++) {
        network.lateUpdate(1 / 60);
        expect(player.position.y).toBe(serverRootY);
      }
    }
    // A teleport must replace confirmed Y on an existing interpolation state,
    // otherwise the following frame pulls the player back to the old floor.
    for (const index of [1, 0]) {
      const serverRootY =
        collision.getFloorHeight("client-support-building", index)! + 0.01;
      network.onPlayerTeleport({
        playerId: player.id,
        position: [300.5, serverRootY, 320.5],
        suppressEffect: true,
      });
      for (let frame = 0; frame < 120; frame++) {
        network.lateUpdate(1 / 60);
        expect(player.position.y).toBe(serverRootY);
      }
    }
  });

  it("ordinary land retains actual bridge-aware terrain sampling with clearance applied once", async () => {
    const { terrain, network, player } = await fixture(350.5, 320.5, 100);
    const ground = terrain.getHeightAt(player.position.x, player.position.z);
    network.lateUpdate(1 / 60);
    expect(player.position.y).toBeCloseTo(ground + 0.01, 10);
    for (let frame = 0; frame < 120; frame++) network.lateUpdate(1 / 60);
    expect(player.position.y).toBeCloseTo(ground + 0.01, 10);
    expect(terrain.getHeightAt(player.position.x, player.position.z)).toBe(
      ground,
    );
  });
});
