import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DataManager,
  World,
  TerrainSystem,
  TownSystem,
  PlayerEntity,
  resolvePlayerRootHeight,
  PLAYER_ROOT_CLEARANCE,
  getDuelArenaConfig,
  GATHERING_CONSTANTS,
  calculateDistance2D,
  tileToWorld,
  worldToTile,
  createResourceID,
  CollisionFlag,
  CharacterInventorySystem as InventorySystem,
  ResourceSystem,
  getItem,
  ALL_WORLD_AREAS,
  EventType,
  loadPhysX,
  type BuildingCollisionService,
  type EntityID,
} from "@hyperforge/shared";
import type { BuildingLayoutInput } from "../../../../../shared/src/types/world/building-collision-types";
import type { TerrainResourceSpawnPoint } from "../../../../../shared/src/types/world/terrain";
import { EmbeddedHyperiaService } from "../../../eliza/EmbeddedHyperiaService";
import { TileMovementManager } from "../tile-movement";
import { CollisionMatrix } from "../../../../../shared/src/systems/shared/movement/CollisionMatrix";
import { PendingGatherManager } from "../PendingGatherManager";
import { EntityManager } from "../../../../../shared/src/systems/shared/entities/EntityManager";
import { SkillsSystem } from "../../../../../shared/src/systems/shared/character/SkillsSystem";
import { getExternalResource } from "../../../../../shared/src/utils/ExternalAssetUtils";
import { DuelOrchestrator } from "../../StreamingDuelScheduler/managers/DuelOrchestrator";
import { ArenaPoolManager } from "../../DuelSystem/ArenaPoolManager";
import { validatePhysicalBankAccess } from "../../../shared/PhysicalBankAccess";
import { RoadNetworkSystem } from "../../../../../shared/src/systems/shared/world/RoadNetworkSystem";
import { ProceduralDocks } from "../../../../../shared/src/systems/shared/world/ProceduralDocks";
import { CompactServiceCourtSystem } from "../../../../../shared/src/systems/shared/world/CompactServiceCourtSystem";
import { CompactLandscapeRocksSystem } from "../../../../../shared/src/systems/shared/world/CompactLandscapeRocksSystem";
import { StationSpawnerSystem } from "../../../../../shared/src/systems/shared/entities/StationSpawnerSystem";
import { MobNPCSpawnerSystem } from "../../../../../shared/src/systems/shared/entities/MobNPCSpawnerSystem";
import { compactPathIntersectsBounds } from "../../../../../shared/src/systems/shared/world/CompactIslandPaths";
import { getCompactPondDockDirection } from "../../../../../shared/src/systems/shared/world/DockDefinition";
import {
  getDuelArenaProtectionBounds,
  isPositionInsideDuelArenaZone,
} from "../../../../../shared/src/data/duel-manifest";
import { BANK_PAVILION_POSTS } from "../../../../../procgen/src/building/generator/OpenWorkshop";
import { groundCompactServiceCourt } from "../../../../../shared/src/systems/shared/world/CompactServiceCourt";
import {
  createCompactPondDressing,
  COMPACT_POND_MODELS,
} from "../../../../../shared/src/systems/shared/world/CompactPondDressing";
import { getCompactPondDockSupportBounds } from "../../../../../shared/src/systems/shared/world/DockDefinition";
import { BankEntity } from "../../../../../shared/src/entities/world/BankEntity";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../../../../../shared/src/systems/shared/world/TerrainQuadChunkGenerator";
import { RetainedTerrainSurface } from "../../../../../shared/src/systems/shared/world/TerrainGridSurface";
import { TerrainQuadTree } from "../../../../../shared/src/systems/shared/world/TerrainQuadTree";
import { createCompactPreparationDetailRegions } from "../../../../../shared/src/systems/shared/world/CompactIslandDetail";

class CpuServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}
const worlds: World[] = [];
const routeOwnerReleases: Array<() => void> = [];
beforeAll(async () => {
  await DataManager.getInstance().initialize();
  if (process.env.HYPERIA_POND_BANK_ROUTES === "1") {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await loadPhysX();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  }
});
afterEach(() => {
  const failures: unknown[] = [];
  const attempt = (release: () => void) => {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const release of routeOwnerReleases.splice(0).reverse())
    attempt(release);
  for (const world of worlds.splice(0)) attempt(() => world.destroy());
  if (failures.length)
    throw new AggregateError(failures, "Player support fixture cleanup failed");
});

async function fixture() {
  const world = new CpuServerWorld();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const towns = world.register("towns", TownSystem) as TownSystem;
  await terrain.init();
  const authored = terrain as unknown as {
    loadWaterBodiesFromManifest(): void;
    loadFlatZonesFromManifest(): void;
  };
  authored.loadWaterBodiesFromManifest();
  authored.loadFlatZonesFromManifest();
  await towns.init();
  const buildings = towns.getCollisionService();
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
  buildings.registerBuilding(
    "support-building",
    "test-town",
    layout,
    { x: 300, y: 35, z: 320 },
    0,
  );
  expect(world.getSystem("buildingCollision")).toBeUndefined();
  const packets: Array<{ name: string; data: unknown }> = [];
  const movement = new TileMovementManager(world, (name, data) => {
    packets.push({ name, data });
  });
  routeOwnerReleases.push(() => movement.destroy());
  return { world, terrain, buildings, movement, packets };
}

function addPlayer(
  world: World,
  id: string,
  position: [number, number, number],
) {
  const player = new PlayerEntity(world, {
    id,
    name: id,
    type: "player",
    position,
    quaternion: [0, 0, 0, 1],
  });
  world.entities.set(id, player);
  return player;
}

function spawnHeight(
  service: EmbeddedHyperiaService,
  p: [number, number, number],
) {
  return (
    service as unknown as {
      groundSpawnPosition(
        p: [number, number, number],
      ): [number, number, number];
    }
  ).groundSpawnPosition(p);
}

// Real CPU admission owners and actual authored water/terrain. No transport,
// database, reward ticks or renderer: these cases prove approach selection and
// cleanup, not simultaneous catches, persistence or rendered fishing quality.
async function fishingFixture(bakeForRelocation = false) {
  const world = new CpuServerWorld();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  if (bakeForRelocation) {
    const body = terrain
      .getWaterBodyRegistry()
      .getAllBodies()
      .find((entry) => entry.id === "haven_pond_water");
    if (!body) throw new Error("Missing authored fishing basin");
    const size = terrain.getWorldTerrainProfile().terrainTileSize;
    for (
      let x = Math.floor((body.centerX - body.radius + size / 2) / size);
      x <= Math.floor((body.centerX + body.radius + size / 2) / size);
      x++
    )
      for (
        let z = Math.floor((body.centerZ - body.radius + size / 2) / size);
        z <= Math.floor((body.centerZ + body.radius + size / 2) / size);
        z++
      ) {
        terrain["generateTile"](x, z, false);
        terrain["bakeWalkabilityFlags"](x, z);
      }
  }
  world.register("entity-manager", EntityManager);
  const resources = world.register(
    "resource",
    ResourceSystem,
  ) as ResourceSystem;
  await resources.init();
  const inventory = world.register(
    "inventory",
    InventorySystem,
  ) as InventorySystem;
  const packets: Array<{ name: string; data: unknown }> = [];
  const send = (name: string, data: unknown) =>
    packets.push({ name, data: structuredClone(data) });
  const movement = new TileMovementManager(world, send);
  routeOwnerReleases.push(() => movement.destroy());
  const pending = new PendingGatherManager(world, movement, send);
  const body = terrain
    .getWaterBodyRegistry()
    .getAllBodies()
    .find((entry) => entry.id === "haven_pond_water");
  if (!body) throw new Error("Missing authored fishing basin");
  // The manifest-backed runtime accepts fishing families; the legacy terrain
  // spawn subtype union currently lists only trees/ores. Do not fake a family.
  const fishingSubtype = "net" as TerrainResourceSpawnPoint["subType"];
  let position: { x: number; y: number; z: number } | undefined;
  // Use the real east bank, outside protected floors/campus. Resource admission
  // remains authoritative; no exemption or fake always-walkable terrain is used.
  for (
    let x = Math.floor(body.centerX + body.radius);
    x >= Math.floor(body.centerX) && !position;
    x--
  ) {
    for (
      let z = Math.floor(body.centerZ - body.radius);
      z <= Math.ceil(body.centerZ + body.radius);
      z++
    ) {
      const candidate = { x: x + 0.5, y: body.surfaceY, z: z + 0.5 };
      if (
        terrain.getWaterBodyRegistry().getBodyAt(candidate.x, candidate.z)
          ?.id !== body.id ||
        terrain.getResourceGroundHeight(candidate.x, candidate.z) >=
          body.surfaceY ||
        !resources["createResourceFromSpawnPoint"](
          { type: "fish", subType: fishingSubtype, position: candidate },
          true,
        )
      )
        continue;
      const approach = movement.findClosestWalkableTile(
        candidate,
        4,
        (tile) =>
          calculateDistance2D(tileToWorld(tile), candidate) <=
          GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE,
      );
      if (approach) {
        position = candidate;
        break;
      }
    }
  }
  if (!position) throw new Error("No admitted real fishing shore");
  await resources["registerTerrainResources"]({
    isManifest: true,
    spawnPoints: [{ type: "fish", subType: fishingSubtype, position }],
  });
  const resource = resources.getAllResources()[0];
  expect(resource.position).toEqual(position);
  const addAngler = (id: string, tile: { x: number; z: number }) => {
    const p = tileToWorld(tile);
    const player = addPlayer(world, id, [
      p.x,
      resolvePlayerRootHeight(p.x, p.z, terrain)!,
      p.z,
    ]);
    movement.syncPlayerPosition(id, player.position);
    // Seed a real inventory's initial fixture state; no DB or reward operation
    // is simulated. Tool eligibility reads the actual manifest item/system.
    inventory["initializeInventory"]({ id });
    const tool = getItem(resource.toolRequired);
    if (!tool) throw new Error("Missing manifest fishing tool");
    inventory
      .getInventory(id)!
      .items.push({ slot: 0, itemId: tool.id, quantity: 1, item: tool });
    return player;
  };
  const available = (outside = false) => {
    const tile = movement.findClosestWalkableTile(
      resource.position,
      10,
      (tile) => {
        const distance = calculateDistance2D(
          tileToWorld(tile),
          resource.position,
        );
        return (
          (outside
            ? distance > GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE
            : distance <= GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE) &&
          movement.isTileAvailableForPlayer("unplaced-fishing-arrival", tile)
        );
      },
    );
    if (!tile) throw new Error("No available actual shore tile");
    return tile;
  };
  return {
    world,
    terrain,
    resources,
    resource,
    movement,
    pending,
    packets,
    addAngler,
    available,
  };
}

// Opt-in real candidate admission lane: no substituted manifests, resource
// placements, skill/tool predicates, movement, random source or reward result.
// It does not run reward ticks or provide a database/transport acceptance proof.
async function allTierFishingFixture(withRouteOwners = false) {
  expect(process.env.ASSETS_DIR).toBeTruthy();
  const area = Object.values(ALL_WORLD_AREAS).find(
    (entry) => entry.fishing?.waterBodyId === "haven_pond_water",
  );
  expect(area?.fishing?.spotCount).toBe(14);
  expect(area!.fishing!.spotTypes).toHaveLength(7);
  const world = new CpuServerWorld();
  worlds.push(world);
  if (withRouteOwners) await world.physics.init();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  const body = terrain
    .getWaterBodyRegistry()
    .getAllBodies()
    .find((entry) => entry.id === area!.fishing!.waterBodyId)!;
  expect(body).toBeDefined();
  world.register("entity-manager", EntityManager);
  const resources = world.register(
    "resource",
    ResourceSystem,
  ) as ResourceSystem;
  await resources.init();
  const routeOwners = withRouteOwners
    ? {
        towns: world.register("towns", TownSystem) as TownSystem,
        roads: world.register("roads", RoadNetworkSystem) as RoadNetworkSystem,
        docks: world.register("docks", ProceduralDocks) as ProceduralDocks,
        courts: world.register(
          "compact-service-court",
          CompactServiceCourtSystem,
        ) as CompactServiceCourtSystem,
        rocks: world.register(
          "compact-landscape-rocks",
          CompactLandscapeRocksSystem,
        ) as CompactLandscapeRocksSystem,
        stations: world.register(
          "station-spawner",
          StationSpawnerSystem,
        ) as StationSpawnerSystem,
        npcs: world.register(
          "mob-npc-spawner",
          MobNPCSpawnerSystem,
        ) as MobNPCSpawnerSystem,
      }
    : null;
  if (routeOwners) {
    // Native CPU collision geometry is real; no renderer or physics stepping.
    // Release these leases before World's built-in physics owner is retired.
    for (const owner of [
      routeOwners.docks,
      routeOwners.courts,
      routeOwners.rocks,
    ])
      routeOwnerReleases.push(() => owner.destroy());
    await routeOwners.towns.init();
    await routeOwners.towns.start();
    await routeOwners.roads.init();
    await routeOwners.roads.start();
    await routeOwners.docks.init();
    await routeOwners.courts.init();
    await routeOwners.rocks.init();
  }
  const bankStations = Object.values(ALL_WORLD_AREAS).flatMap((entry) =>
    (entry.stations ?? []).filter((station) => station.type === "bank"),
  );
  const coverage = withRouteOwners
    ? {
        minX: Math.min(
          area!.bounds.minX,
          ...bankStations.map((station) => station.position.x),
        ),
        maxX: Math.max(
          area!.bounds.maxX,
          ...bankStations.map((station) => station.position.x),
        ),
        minZ: Math.min(
          area!.bounds.minZ,
          ...bankStations.map((station) => station.position.z),
        ),
        maxZ: Math.max(
          area!.bounds.maxZ,
          ...bankStations.map((station) => station.position.z),
        ),
      }
    : area!.bounds;
  const size = terrain.getWorldTerrainProfile().terrainTileSize;
  const generatedRouteTiles: Array<{
    x: number;
    z: number;
    contentGenerated: boolean;
    resources: number;
  }> = [];
  for (
    let x = Math.floor((coverage.minX + size / 2) / size);
    x <= Math.floor((coverage.maxX + size / 2) / size);
    x++
  )
    for (
      let z = Math.floor((coverage.minZ + size / 2) / size);
      z <= Math.floor((coverage.maxZ + size / 2) / size);
      z++
    ) {
      const tile = terrain["generateTile"](x, z, withRouteOwners);
      if (withRouteOwners)
        generatedRouteTiles.push({
          x,
          z,
          contentGenerated: tile.contentGenerated === true,
          resources: tile.resources.length,
        });
      terrain["bakeWalkabilityFlags"](x, z);
    }
  if (routeOwners) {
    await Promise.all([...resources["terrainResourceTails"].values()]);
    await routeOwners.courts.start();
    await routeOwners.docks.start();
    await routeOwners.rocks.start();
    await routeOwners.stations.start();
    await routeOwners.npcs.init();
    // Use the production manifest spawn owner, excluding its unrelated test
    // goblin/default mob and unticked dynamic mob simulation.
    await routeOwners.npcs["spawnAllNPCsFromManifest"]();
    new ArenaPoolManager().registerArenaWallCollision(world.collision);
    await resources["initializeWorldAreaResources"]();
    await Promise.all([...resources["terrainResourceTails"].values()]);
  }
  const inventory = world.register(
    "inventory",
    InventorySystem,
  ) as InventorySystem;
  await inventory.init();
  const skills = world.register("skills", SkillsSystem) as SkillsSystem;
  await skills.init();
  if (!routeOwners)
    await resources["spawnDynamicFishingSpots"](area!.id, area!);
  const spots = resources
    .getAllResources()
    .filter((resource) => resource.type === "fishing_spot")
    .sort((left, right) => left.id.localeCompare(right.id));
  expect(spots).toHaveLength(14);
  const variant = (resource: (typeof spots)[number]) =>
    resources["resourceVariants"].get(createResourceID(resource.id))!;
  const counts = new Map<string, number>();
  for (const spot of spots) {
    const family = variant(spot);
    counts.set(family, (counts.get(family) ?? 0) + 1);
    expect(world.entities.get(spot.id)).toBeDefined();
    expect(
      resources["boundFishingResources"].has(createResourceID(spot.id)),
    ).toBe(true);
    expect(
      terrain.getWaterBodyRegistry().getBodyAt(spot.position.x, spot.position.z)
        ?.id,
    ).toBe(body.id);
  }
  expect(counts).toEqual(
    new Map(area!.fishing!.spotTypes.map((family) => [family, 2])),
  );
  expect(
    new Set(spots.flatMap((spot) => spot.drops.map((drop) => drop.itemId)))
      .size,
  ).toBe(12);
  const packets: Array<{ name: string; data: unknown }> = [];
  const send = (name: string, data: unknown) =>
    packets.push({ name, data: structuredClone(data) });
  const movement = new TileMovementManager(world, send);
  routeOwnerReleases.push(() => movement.destroy());
  const pending = new PendingGatherManager(world, movement, send);
  const addAngler = async (
    id: string,
    resource: (typeof spots)[number],
    restored?: {
      tile: { x: number; z: number };
      inventory?: Array<{
        itemId: string;
        slotIndex: number;
        quantity: number;
      }>;
    },
  ) => {
    const start =
      restored?.tile ??
      movement.findClosestWalkableTile(resource.position, 10, (tile) => {
        const p = tileToWorld(tile);
        return (
          calculateDistance2D(p, resource.position) >
            GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE &&
          terrain.getResourceGroundHeight(p.x, p.z) >= body.surfaceY &&
          movement.isTileAvailableForPlayer(id, tile)
        );
      });
    expect(
      start,
      `No supported dry start for ${variant(resource)} ${resource.id}`,
    ).not.toBeNull();
    const p = tileToWorld(start!);
    expect(movement.isTileAvailableForPlayer(id, start!)).toBe(true);
    expect(terrain.getResourceGroundHeight(p.x, p.z)).toBeGreaterThanOrEqual(
      body.surfaceY,
    );
    const player = addPlayer(world, id, [
      p.x,
      resolvePlayerRootHeight(p.x, p.z, terrain)!,
      p.z,
    ]);
    movement.syncPlayerPosition(id, player.position);
    const manifest = getExternalResource(variant(resource))!;
    const level = Math.max(
      resource.levelRequired,
      ...manifest.harvestYield.map((drop) => drop.levelRequired ?? 1),
    );
    skills.setSkillLevel(id, "fishing", level);
    // Character entry normally supplies this authoritative skill snapshot on
    // entity.data before the real registration owner publishes SKILLS_UPDATED.
    player.data.skills = skills.getSkills(id)!;
    await skills["loadPlayerSkillsFromDatabase"](id);
    expect(resources["playerSkills"].get(id)?.fishing.level).toBe(level);
    const itemIds = [resource.toolRequired, resource.secondaryRequired].filter(
      (item): item is string => !!item,
    );
    for (const item of itemIds) expect(getItem(item)).not.toBeNull();
    await inventory["loadInventoryFromPayload"](
      id,
      restored?.inventory ??
        itemIds.map((itemId, slotIndex) => ({
          itemId,
          slotIndex,
          quantity: itemId === resource.secondaryRequired ? 10 : 1,
        })),
    );
    expect(resources.playerHasRequiredToolForResource(id, resource.id)).toBe(
      true,
    );
    return { player, resource, level, start: { ...start! } };
  };
  return {
    world,
    terrain,
    resources,
    inventory,
    skills,
    spots,
    variant,
    body,
    movement,
    pending,
    packets,
    addAngler,
    routeOwners,
    bankStations,
    generatedRouteTiles,
  };
}

describe.runIf(process.env.HYPERIA_FISHING_CAPACITY === "1")(
  "actual all-tier candidate basin capacity (CPU admission only)",
  () => {
    it("admits fourteen all-tier anglers, handles extra arrivals and owner re-entry, and follows a real relocation", async () => {
      const f = await allTierFishingFixture();
      const anglers: Array<Awaited<ReturnType<typeof f.addAngler>>> = [];
      for (const [index, resource] of f.spots.entries())
        anglers.push(await f.addAngler(`basin-angler-${index}`, resource));
      const receipt = (phase: string) => ({
        phase,
        assetDirectory: process.env.ASSETS_DIR,
        spots: f.spots.map((spot) => ({
          id: spot.id,
          family: f.variant(spot),
          position: spot.position,
        })),
        actors: anglers.map(({ player, resource, level, start }) => ({
          id: player.id,
          resourceId: resource.id,
          level,
          start,
          position: player.position.toArray(),
          gathering: f.resources.isPlayerGatheringResource(
            player.id,
            resource.id,
          ),
          target:
            f.pending["pendingGathers"].get(player.id)?.targetShoreTile ?? null,
          movement: f.movement.getPlayerMovementDebug(player.id),
        })),
        reservations: f.pending["approachReservations"].size,
        pending: f.pending["pendingGathers"].size,
      });
      const admitted = anglers.map(({ player, resource }) =>
        f.pending.queuePendingGather(player.id, resource.id, 0, true),
      );
      console.log(JSON.stringify(receipt("fourteen-initial-queue")));
      expect(
        admitted.filter(Boolean).length,
        JSON.stringify(receipt("initial-admission-failure")),
      ).toBe(14);
      for (
        let tick = 1;
        tick <= 20 && f.pending["pendingGathers"].size;
        tick++
      ) {
        f.world.currentTick = tick;
        f.movement.onTick(tick);
        f.pending.processTick(tick);
      }
      const final = receipt("fourteen-arrivals");
      console.log(JSON.stringify(final));
      expect(
        final.actors.filter((actor) => actor.gathering).length,
        JSON.stringify(final),
      ).toBe(14);
      expect(f.pending["pendingGathers"].size).toBe(0);
      expect(f.pending["approachReservations"].size).toBe(0);
      expect(
        new Set(
          anglers.map(({ player }) => {
            const tile = worldToTile(player.position.x, player.position.z);
            return `${tile.x},${tile.z}`;
          }),
        ).size,
      ).toBe(14);
      for (const { player, resource } of anglers) {
        expect(
          calculateDistance2D(player.position, resource.position),
        ).toBeLessThanOrEqual(GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE);
        expect(
          f.terrain.getResourceGroundHeight(
            player.position.x,
            player.position.z,
          ),
        ).toBeGreaterThanOrEqual(f.body.surfaceY);
        expect(
          f.movement.isTileAvailableForPlayer(
            player.id,
            worldToTile(player.position.x, player.position.z),
          ),
        ).toBe(true);
      }

      // Fourteen resource targets are not a hard angler cap. Each extra arrival
      // must either complete a legal independent approach or reject cleanly.
      const extraFamilies = new Set<string>();
      const overflow = [];
      for (const resource of f.spots) {
        if (extraFamilies.has(f.variant(resource))) continue;
        extraFamilies.add(f.variant(resource));
        const extra = await f.addAngler(
          `basin-extra-${overflow.length}`,
          resource,
        );
        const accepted = f.pending.queuePendingGather(
          extra.player.id,
          resource.id,
          f.world.currentTick,
          true,
        );
        overflow.push({ ...extra, accepted });
        if (!accepted) {
          expect(f.pending["pendingGathers"].has(extra.player.id)).toBe(false);
          expect(
            [...f.pending["approachReservations"].values()].some(
              (entry) => entry.playerId === extra.player.id,
            ),
          ).toBe(false);
          expect(f.movement.hasMovementIntent(extra.player.id)).toBe(false);
        }
      }
      const overflowStart = f.world.currentTick;
      for (
        let tick = overflowStart + 1;
        tick <= overflowStart + 20 && f.pending["pendingGathers"].size;
        tick++
      ) {
        f.world.currentTick = tick;
        f.movement.onTick(tick);
        f.pending.processTick(tick);
      }
      console.log(
        JSON.stringify({
          phase: "seven-extra-arrivals",
          actors: overflow.map(({ player, resource, accepted }) => ({
            id: player.id,
            resourceId: resource.id,
            family: f.variant(resource),
            accepted,
            gathering: f.resources.isPlayerGatheringResource(
              player.id,
              resource.id,
            ),
            movement: f.movement.getPlayerMovementDebug(player.id),
            pending: f.pending["pendingGathers"].get(player.id) ?? null,
          })),
        }),
      );
      for (const extra of overflow)
        expect(
          f.resources.isPlayerGatheringResource(
            extra.player.id,
            extra.resource.id,
          ),
          `Extra ${extra.player.id} admission=${extra.accepted}`,
        ).toBe(extra.accepted);
      expect(f.pending["pendingGathers"].size).toBe(0);
      expect(f.pending["approachReservations"].size).toBe(0);
      for (const { player, resource } of anglers)
        expect(
          f.resources.isPlayerGatheringResource(player.id, resource.id),
        ).toBe(true);
      const allAnglers = [...anglers, ...overflow];
      expect(
        new Set(
          allAnglers.map(({ player }) => {
            const tile = worldToTile(player.position.x, player.position.z);
            return `${tile.x},${tile.z}`;
          }),
        ).size,
      ).toBe(21);

      // Actual owner cleanup/re-entry, not socket authentication or DB durability.
      const leaving = anglers[0];
      const savedTile = worldToTile(
        leaving.player.position.x,
        leaving.player.position.z,
      );
      const savedInventory = f.inventory
        .getInventory(leaving.player.id)!
        .items.map((item) => ({
          itemId: item.itemId,
          slotIndex: item.slot,
          quantity: item.quantity,
        }));
      f.world.emit(EventType.MOVEMENT_CLICK_TO_MOVE, {
        playerId: leaving.player.id,
        targetPosition: leaving.player.position,
      });
      expect(
        f.resources.isPlayerGatheringResource(
          leaving.player.id,
          leaving.resource.id,
        ),
      ).toBe(false);
      f.pending.onPlayerDisconnect(leaving.player.id);
      f.movement.cleanup(leaving.player.id);
      expect(f.world.entities.remove(leaving.player.id)).toBe(true);
      expect(f.resources["playerSkills"].has(leaving.player.id)).toBe(false);
      const returned = await f.addAngler(leaving.player.id, leaving.resource, {
        tile: savedTile,
        inventory: savedInventory,
      });
      anglers[0] = returned;
      expect(
        f.pending.queuePendingGather(
          returned.player.id,
          returned.resource.id,
          f.world.currentTick,
          true,
        ),
      ).toBe(true);
      const returnStart = f.world.currentTick;
      for (
        let tick = returnStart + 1;
        tick <= returnStart + 20 && f.pending["pendingGathers"].size;
        tick++
      ) {
        f.world.currentTick = tick;
        f.movement.onTick(tick);
        f.pending.processTick(tick);
      }
      expect(
        f.resources.isPlayerGatheringResource(
          returned.player.id,
          returned.resource.id,
        ),
      ).toBe(true);
      expect(f.pending["approachReservations"].size).toBe(0);
      expect(
        f.inventory.getInventory(returned.player.id)!.items.map((item) => ({
          itemId: item.itemId,
          slotIndex: item.slot,
          quantity: item.quantity,
        })),
      ).toEqual(savedInventory);

      // Respect the real request rate limit; no fake clock or limiter edits.
      await new Promise((resolve) =>
        setTimeout(resolve, GATHERING_CONSTANTS.RATE_LIMIT_MS + 1),
      );
      const movedResource = returned.resource;
      const oldPosition = { ...movedResource.position };
      const affected = [
        ...anglers,
        ...overflow.filter((entry) => entry.accepted),
      ].filter((actor) => actor.resource.id === movedResource.id);
      f.resources["relocateFishingSpot"](
        createResourceID(movedResource.id),
        f.world.currentTick,
      );
      expect(
        calculateDistance2D(oldPosition, movedResource.position),
      ).toBeGreaterThanOrEqual(
        GATHERING_CONSTANTS.FISHING_SPOT_MOVE.relocateMinDistance,
      );
      expect(
        f.terrain
          .getWaterBodyRegistry()
          .getBodyAt(movedResource.position.x, movedResource.position.z)?.id,
      ).toBe(f.body.id);
      for (const actor of affected) {
        expect(
          f.resources.isPlayerGatheringResource(
            actor.player.id,
            movedResource.id,
          ),
        ).toBe(false);
        const approach = f.pending["findFishingApproach"](
          actor.player.id,
          movedResource.position,
        );
        const accepted = f.pending.queuePendingGather(
          actor.player.id,
          movedResource.id,
          f.world.currentTick,
          true,
        );
        if (!accepted) {
          const stencil = (center: { x: number; z: number }) =>
            [-1, 0, 1].flatMap((dx) =>
              [-1, 0, 1].map((dz) => {
                const tile = { x: center.x + dx, z: center.z + dz };
                return {
                  ...tile,
                  flags: f.world.collision.getFlags(tile.x, tile.z),
                  available: f.movement.isTileAvailableForPlayer(
                    actor.player.id,
                    tile,
                  ),
                };
              }),
            );
          console.log(
            JSON.stringify({
              phase: "pond-fishing-relocation-admission-failed",
              oldPosition,
              newPosition: { ...movedResource.position },
              resourceId: movedResource.id,
              playerId: actor.player.id,
              playerPosition: actor.player.position.toArray(),
              approach,
              accepted,
              pending: f.pending["pendingGathers"].get(actor.player.id) ?? null,
              movement: f.movement.getPlayerMovementDebug(actor.player.id),
              iterations: f.movement["pathfinder"].getLastIterationsUsed(),
              partial: f.movement["pathfinder"].wasLastPathPartial(),
              failedExact: approach
                ? f.movement.hasFailedMovementTo(actor.player.id, approach)
                : null,
              startStencil: stencil(
                worldToTile(actor.player.position.x, actor.player.position.z),
              ),
              approachStencil: approach ? stencil(approach) : null,
            }),
          );
        }
        expect(accepted, `Relocation requeue ${actor.player.id}`).toBe(true);
      }
      const relocationStart = f.world.currentTick;
      for (
        let tick = relocationStart + 1;
        tick <= relocationStart + 20 && f.pending["pendingGathers"].size;
        tick++
      ) {
        f.world.currentTick = tick;
        f.movement.onTick(tick);
        f.pending.processTick(tick);
      }
      console.log(
        JSON.stringify({
          ...receipt("after-owner-reentry-and-relocation"),
          oldPosition,
          movedResourceId: movedResource.id,
          extraAccepted: overflow.filter((entry) => entry.accepted).length,
        }),
      );
      for (const actor of [
        ...anglers,
        ...overflow.filter((entry) => entry.accepted),
      ]) {
        expect(
          f.resources.isPlayerGatheringResource(
            actor.player.id,
            actor.resource.id,
          ),
          actor.player.id,
        ).toBe(true);
        expect(
          calculateDistance2D(actor.player.position, actor.resource.position),
        ).toBeLessThanOrEqual(GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE);
        expect(
          f.terrain.getResourceGroundHeight(
            actor.player.position.x,
            actor.player.position.z,
          ),
        ).toBeGreaterThanOrEqual(f.body.surfaceY);
        expect(
          f.movement.isTileAvailableForPlayer(
            actor.player.id,
            worldToTile(actor.player.position.x, actor.player.position.z),
          ),
        ).toBe(true);
        expect(f.movement.hasMovementIntent(actor.player.id)).toBe(false);
      }
      expect(
        new Set(
          [...anglers, ...overflow].map(({ player }) => {
            const tile = worldToTile(player.position.x, player.position.z);
            return `${tile.x},${tile.z}`;
          }),
        ).size,
      ).toBe(21);
      expect(f.pending["pendingGathers"].size).toBe(0);
      expect(f.pending["approachReservations"].size).toBe(0);
    });
  },
);

describe.runIf(process.env.HYPERIA_POND_BANK_ROUTES === "1")(
  "actual candidate pond-to-bank circulation (CPU owners, not bank persistence)",
  () => {
    it.each(["static-lease", "player-occupancy"] as const)(
      "refreshes same-tick collision caches without a pending observer after %s changes",
      async (kind) => {
        const f = await allTierFishingFixture(true);
        const start = { x: 394, z: 408 },
          watched = { x: 393, z: 408 };
        const destination = { x: 418, z: 432 };
        const point = tileToWorld(start);
        const player = addPlayer(f.world, `uncached-pond-${kind}`, [
          point.x,
          resolvePlayerRootHeight(point.x, point.z, f.terrain)!,
          point.z,
        ]);
        f.movement.syncPlayerPosition(player.id, player.position);
        f.movement.onTick(f.world.currentTick);
        expect(f.movement["_pendingGuidedSearches"].size).toBe(0);
        expect(f.movement["stopGuidedCollisionObservation"]).toBeNull();
        expect(f.movement.isTileAvailableForPlayer(player.id, watched)).toBe(
          true,
        );
        const flagsBefore = f.world.collision.getFlags(watched.x, watched.z);
        let blockedAvailable = true,
          blockedEdge = true;
        if (kind === "static-lease") {
          const lease = f.world.collision.acquireStaticFootprint([watched]);
          try {
            blockedAvailable = f.movement.isTileAvailableForPlayer(
              player.id,
              watched,
            );
            blockedEdge = f.movement["isTileTraversableForPlayer"](
              player.id,
              watched,
              0,
              start,
            );
          } finally {
            expect(lease.release()).toBe(true);
          }
        } else {
          const at = tileToWorld(watched);
          const blocker = addPlayer(f.world, "same-tick-real-blocker", [
            at.x,
            resolvePlayerRootHeight(at.x, at.z, f.terrain)!,
            at.z,
          ]);
          try {
            f.movement.syncPlayerPosition(blocker.id, blocker.position);
            blockedAvailable = f.movement.isTileAvailableForPlayer(
              player.id,
              watched,
            );
            blockedEdge = f.movement["isTileTraversableForPlayer"](
              player.id,
              watched,
              0,
              start,
            );
          } finally {
            f.movement.cleanup(blocker.id);
            f.world.entities.remove(blocker.id);
          }
        }
        expect(f.world.collision.getFlags(watched.x, watched.z)).toBe(
          flagsBefore,
        );
        const reopenedAvailable = f.movement.isTileAvailableForPlayer(
          player.id,
          watched,
        );
        const reopenedEdge = f.movement["isTileTraversableForPlayer"](
          player.id,
          watched,
          0,
          start,
        );
        console.log(
          JSON.stringify({
            phase: "same-tick-pond-collision-cache",
            kind,
            start,
            watched,
            blockedAvailable,
            blockedEdge,
            reopenedAvailable,
            reopenedEdge,
            tick: f.world.currentTick,
          }),
        );
        expect.soft(blockedAvailable).toBe(false);
        expect.soft(blockedEdge).toBe(false);
        expect.soft(reopenedAvailable).toBe(true);
        expect.soft(reopenedEdge).toBe(true);
        expect(
          f.movement.movePlayerToward(
            player.id,
            tileToWorld(destination),
            true,
          ),
        ).toBe(true);
        let ticks = 0;
        const arrived = () => {
          const tile = worldToTile(player.position.x, player.position.z);
          return tile.x === destination.x && tile.z === destination.z;
        };
        for (; ticks < 256 && !arrived(); ticks++) {
          f.world.currentTick++;
          f.movement.onTick(f.world.currentTick);
          expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(
            1000,
          );
          expect(
            f.movement["pathfinder"].getLastIterationsUsed(),
          ).toBeLessThanOrEqual(250);
          if (!f.movement.hasMovementIntent(player.id) && !arrived()) break;
        }
        expect(arrived()).toBe(true);
        f.pending.onPlayerDisconnect(player.id);
        f.movement.cleanup(player.id);
        f.world.entities.remove(player.id);
      },
    );

    it("preserves the actual pending frontier when the same movement intent is repeated", async () => {
      const f = await allTierFishingFixture(true);
      const position = tileToWorld({ x: 394, z: 408 });
      const destination = { x: 418, z: 432 };
      const player = addPlayer(f.world, "restated-pond-intent", [
        position.x,
        resolvePlayerRootHeight(position.x, position.z, f.terrain)!,
        position.z,
      ]);
      f.movement.syncPlayerPosition(player.id, player.position);
      const target = tileToWorld(destination);
      expect(f.movement.movePlayerToward(player.id, target, true)).toBe(true);
      const pending = f.movement["_pendingGuidedSearches"].get(player.id)!;
      expect(pending).toBeDefined();
      const initialIterations = pending.search.totalIterations;
      const initialBudget = f.movement["_bfsIterationsThisTick"];
      for (let repeat = 0; repeat < 10; repeat++) {
        expect(f.movement.movePlayerToward(player.id, target, true)).toBe(true);
        expect(f.movement["_pendingGuidedSearches"].get(player.id)).toBe(
          pending,
        );
        expect(pending.search.totalIterations).toBe(initialIterations);
        expect(f.movement["_bfsIterationsThisTick"]).toBe(initialBudget);
      }
      let ticks = 0;
      const arrived = () => {
        const tile = worldToTile(player.position.x, player.position.z);
        return tile.x === destination.x && tile.z === destination.z;
      };
      for (; ticks < 256 && !arrived(); ticks++) {
        f.world.currentTick++;
        f.movement.onTick(f.world.currentTick);
        expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(1000);
        expect(
          f.movement["pathfinder"].getLastIterationsUsed(),
        ).toBeLessThanOrEqual(250);
      }
      expect(arrived()).toBe(true);
      expect(pending.search.totalIterations).toBeGreaterThan(initialIterations);
      console.log(
        JSON.stringify({
          phase: "restated-pond-intent",
          repeats: 10,
          initialIterations,
          retainedIterations: pending.search.totalIterations,
          ticks,
          reached: arrived(),
        }),
      );
      f.movement.cleanup(player.id);
      f.world.entities.remove(player.id);
    });

    it("destroys actual movement observers and jobs without retiring the reusable collision owner", async () => {
      const f = await allTierFishingFixture(true);
      const collision = f.world.collision;
      if (!(collision instanceof CollisionMatrix))
        throw new Error("Expected actual collision owner");
      const listenersBeforePending = collision["changeListeners"].size;
      expect(f.movement["stopCollisionCacheObservation"]).not.toBeNull();
      const position = tileToWorld({ x: 394, z: 408 });
      const player = addPlayer(f.world, "destroy-pending-pond-owner", [
        position.x,
        resolvePlayerRootHeight(position.x, position.z, f.terrain)!,
        position.z,
      ]);
      f.movement.syncPlayerPosition(player.id, player.position);
      expect(
        f.movement.movePlayerToward(
          player.id,
          tileToWorld({ x: 418, z: 432 }),
          true,
        ),
      ).toBe(true);
      expect(f.movement["_pendingGuidedSearches"].has(player.id)).toBe(true);
      expect(collision["changeListeners"].size).toBe(
        listenersBeforePending + 1,
      );
      f.movement.destroy();
      f.movement.destroy();
      expect(f.movement["stopCollisionCacheObservation"]).toBeNull();
      expect(f.movement["stopGuidedCollisionObservation"]).toBeNull();
      expect(f.movement["_pendingGuidedSearches"].size).toBe(0);
      expect(f.movement["playerStates"].size).toBe(0);
      expect(f.movement.hasMovementIntent(player.id)).toBe(false);
      expect(
        f.world.entityOccupancy.getOccupant({ x: 394, z: 408 }),
      ).toBeNull();
      expect(collision["changeListeners"].size).toBe(
        listenersBeforePending - 1,
      );
      const replacement = new TileMovementManager(f.world, (name, data) => {
        f.packets.push({ name, data });
      });
      routeOwnerReleases.push(() => replacement.destroy());
      expect(collision["changeListeners"].size).toBe(listenersBeforePending);
      const tile = { x: 393, z: 408 };
      const originalFlags = f.world.collision.getFlags(tile.x, tile.z);
      expect(replacement.isTileAvailableForPlayer(player.id, tile)).toBe(true);
      const lease = f.world.collision.acquireStaticFootprint([tile]);
      try {
        expect(replacement.isTileAvailableForPlayer(player.id, tile)).toBe(
          false,
        );
      } finally {
        expect(lease.release()).toBe(true);
      }
      expect(replacement.isTileAvailableForPlayer(player.id, tile)).toBe(true);
      expect(f.world.collision.getFlags(tile.x, tile.z)).toBe(originalFlags);
      expect(collision["changeListeners"].size).toBe(listenersBeforePending);
      replacement.destroy();
      expect(collision["changeListeners"].size).toBe(
        listenersBeforePending - 1,
      );
      console.log(
        JSON.stringify({
          phase: "movement-owner-destroy",
          listenersBeforePending,
          listenersAfter: collision["changeListeners"].size,
          pending: f.movement["_pendingGuidedSearches"].size,
          collisionReusable: true,
        }),
      );
      f.world.entities.remove(player.id);
    });

    it.each(["global", "per-player"] as const)(
      "retires a real active lookahead after entity removal through %s ticks",
      async (processor) => {
        const f = await allTierFishingFixture(true);
        const start = { x: 347, z: 318 };
        const position = tileToWorld(start);
        const player = addPlayer(f.world, `removed-lookahead-${processor}`, [
          position.x,
          resolvePlayerRootHeight(position.x, position.z, f.terrain)!,
          position.z,
        ]);
        f.movement.syncPlayerPosition(player.id, player.position);
        expect(
          f.movement.movePlayerToward(
            player.id,
            tileToWorld({ x: 418, z: 432 }),
            true,
          ),
        ).toBe(true);
        let ticks = 0;
        for (; ticks < 256; ticks++) {
          if (
            f.movement.isMoving(player.id) &&
            f.movement["_pendingGuidedSearches"].has(player.id)
          )
            break;
          f.world.currentTick++;
          if (processor === "global") f.movement.onTick(f.world.currentTick);
          else f.movement.processPlayerTick(player.id, f.world.currentTick);
          expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(
            1000,
          );
          expect(
            f.movement["pathfinder"].getLastIterationsUsed(),
          ).toBeLessThanOrEqual(250);
          if (!f.movement.hasMovementIntent(player.id)) break;
        }
        expect(f.movement.isMoving(player.id)).toBe(true);
        expect(f.movement["_pendingGuidedSearches"].has(player.id)).toBe(true);
        const before = f.movement.getPlayerMovementDebug(player.id);
        const occupied = worldToTile(player.position.x, player.position.z);
        f.world.entities.remove(player.id);
        expect(f.world.entities.get(player.id)).toBeNull();
        f.world.currentTick++;
        if (processor === "global") f.movement.onTick(f.world.currentTick);
        else f.movement.processPlayerTick(player.id, f.world.currentTick);
        expect(f.movement["playerStates"].has(player.id)).toBe(false);
        expect(f.movement["_pendingGuidedSearches"].size).toBe(0);
        expect(f.movement["stopGuidedCollisionObservation"]).toBeNull();
        expect(f.movement["stopCollisionCacheObservation"]).not.toBeNull();
        expect(f.movement.hasMovementIntent(player.id)).toBe(false);
        expect(f.world.entityOccupancy.getOccupant(occupied)).toBeNull();
        console.log(
          JSON.stringify({
            phase: "missing-entity-active-lookahead",
            processor,
            ticks,
            before,
            occupied,
          }),
        );
      },
    );

    it("shares the unchanged search budget across five real concurrent pond intents", async () => {
      const f = await allTierFishingFixture(true);
      const starts = [
        { x: 394, z: 408 },
        { x: 397, z: 405 },
        { x: 393, z: 407 },
        { x: 392, z: 406 },
        { x: 396, z: 404 },
      ];
      const players = starts.map((tile, index) => {
        expect(
          f.movement.isTileAvailableForPlayer(`budget-pond-${index}`, tile),
        ).toBe(true);
        const point = tileToWorld(tile);
        const player = addPlayer(f.world, `budget-pond-${index}`, [
          point.x,
          resolvePlayerRootHeight(point.x, point.z, f.terrain)!,
          point.z,
        ]);
        f.movement.syncPlayerPosition(player.id, player.position);
        return player;
      });
      const target = tileToWorld({ x: 418, z: 432 });
      const admissions = players.map((player) => {
        const accepted = f.movement.movePlayerToward(player.id, target, true);
        expect(accepted).toBe(true);
        expect(f.movement.hasMovementIntent(player.id)).toBe(true);
        expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(1000);
        expect(
          f.movement["pathfinder"].getLastIterationsUsed(),
        ).toBeLessThanOrEqual(250);
        return {
          playerId: player.id,
          accepted,
          sharedIterations: f.movement["_bfsIterationsThisTick"],
          pendingSearch: f.movement["_pendingGuidedSearches"].has(player.id),
          queued: f.movement["_pendingNonCombatMoves"].has(player.id),
        };
      });
      expect(f.movement["_bfsIterationsThisTick"]).toBe(1000);
      expect(
        admissions.some((entry) => entry.queued && !entry.pendingSearch),
      ).toBe(true);
      const slices = [];
      for (let tick = 1; tick <= 6; tick++) {
        f.world.currentTick = tick;
        f.movement.onTick(tick);
        const iterations = f.movement["_bfsIterationsThisTick"];
        expect(iterations).toBeLessThanOrEqual(1000);
        expect(
          f.movement["pathfinder"].getLastIterationsUsed(),
        ).toBeLessThanOrEqual(250);
        slices.push({
          tick,
          iterations,
          pending: f.movement["_pendingGuidedSearches"].size,
        });
      }
      // This proves shared scheduling, not five actors occupying one endpoint.
      for (const player of players) {
        f.movement.stopPlayer(player.id);
        f.movement.cleanup(player.id);
        f.world.entities.remove(player.id);
      }
      expect(f.movement["_pendingGuidedSearches"].size).toBe(0);
      expect(f.movement["stopGuidedCollisionObservation"]).toBeNull();
      console.log(
        JSON.stringify({
          phase: "five-player-pond-search-budget",
          admissions,
          slices,
        }),
      );
    });

    it.each([
      { start: { x: 394, z: 408 }, destination: { x: 418, z: 432 } },
      { start: { x: 397, z: 405 }, destination: { x: 422, z: 430 } },
    ])(
      "continues deterministic stranded pond route $start.x,$start.z",
      async ({ start, destination }) => {
        const f = await allTierFishingFixture(true);
        const startPosition = tileToWorld(start);
        const target = tileToWorld(destination);
        const player = addPlayer(
          f.world,
          `stranded-route-${start.x}-${start.z}`,
          [
            startPosition.x,
            resolvePlayerRootHeight(
              startPosition.x,
              startPosition.z,
              f.terrain,
            )!,
            startPosition.z,
          ],
        );
        f.movement.syncPlayerPosition(player.id, player.position);
        expect(
          f.movement.isTileAvailableForPlayer(player.id, destination),
        ).toBe(true);
        const accepted = f.movement.movePlayerToward(player.id, target, true);
        let maximumTickIterations = f.movement["_bfsIterationsThisTick"];
        let maximumLastSearchIterations =
          f.movement["pathfinder"].getLastIterationsUsed();
        let resumedSlices = 0;
        let maximumRetainedSearchAdvance = 0;
        let ticks = 0;
        const arrived = () => {
          const tile = worldToTile(player.position.x, player.position.z);
          return tile.x === destination.x && tile.z === destination.z;
        };
        for (; ticks < 256 && !arrived(); ticks++) {
          const previousSearch = f.movement["_pendingGuidedSearches"].get(
            player.id,
          )?.search;
          const previousIterations = previousSearch?.totalIterations ?? 0;
          f.world.currentTick++;
          f.movement.onTick(f.world.currentTick);
          if (previousSearch) {
            const advance = previousSearch.totalIterations - previousIterations;
            expect(advance).toBeGreaterThanOrEqual(0);
            expect(advance).toBeLessThanOrEqual(250);
            maximumRetainedSearchAdvance = Math.max(
              maximumRetainedSearchAdvance,
              advance,
            );
            if (advance > 0) resumedSlices++;
          }
          maximumTickIterations = Math.max(
            maximumTickIterations,
            f.movement["_bfsIterationsThisTick"],
          );
          maximumLastSearchIterations = Math.max(
            maximumLastSearchIterations,
            f.movement["pathfinder"].getLastIterationsUsed(),
          );
          expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(
            1000,
          );
          expect(
            f.movement["pathfinder"].getLastIterationsUsed(),
          ).toBeLessThanOrEqual(250);
          expect(player.position.y).toBeCloseTo(
            resolvePlayerRootHeight(
              player.position.x,
              player.position.z,
              f.terrain,
            )!,
            5,
          );
          if (!f.movement.hasMovementIntent(player.id) && !arrived()) break;
        }
        const receipt = {
          phase: "deterministic-stranded-pond-route",
          start,
          destination,
          accepted,
          reached: arrived(),
          ticks,
          maximumTickIterations,
          maximumLastSearchIterations,
          maximumRetainedSearchAdvance,
          resumedSlices,
          movement: f.movement.getPlayerMovementDebug(player.id),
          failedExact: f.movement.hasFailedMovementTo(player.id, destination),
          position: player.position.toArray(),
        };
        console.log(JSON.stringify(receipt));
        expect.soft(accepted, JSON.stringify(receipt)).toBe(true);
        expect.soft(arrived(), JSON.stringify(receipt)).toBe(true);
        expect(resumedSlices).toBeGreaterThan(0);
        expect(f.movement["_pendingGuidedSearches"].size).toBe(0);
        expect(f.movement["stopGuidedCollisionObservation"]).toBeNull();
        f.pending.onPlayerDisconnect(player.id);
        f.movement.cleanup(player.id);
        f.world.entities.remove(player.id);
      },
    );

    it.each(["stop", "new-target", "sync", "cleanup"] as const)(
      "retires the actual pending pond search on %s without resurrecting it",
      async (action) => {
        const f = await allTierFishingFixture(true);
        const start = { x: 394, z: 408 };
        const destination = { x: 418, z: 432 };
        const position = tileToWorld(start);
        const player = addPlayer(f.world, `pending-pond-${action}`, [
          position.x,
          resolvePlayerRootHeight(position.x, position.z, f.terrain)!,
          position.z,
        ]);
        f.movement.syncPlayerPosition(player.id, player.position);
        expect(
          f.movement.movePlayerToward(
            player.id,
            tileToWorld(destination),
            true,
          ),
        ).toBe(true);
        const search = f.movement["_pendingGuidedSearches"].get(player.id);
        expect(search).toBeDefined();
        expect(f.movement.hasMovementIntent(player.id)).toBe(true);
        expect(
          f.movement["pathfinder"].getLastIterationsUsed(),
        ).toBeLessThanOrEqual(250);
        expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(1000);
        const before = player.position.toArray();
        let replacement: { x: number; z: number } | null = null;
        if (action === "stop") f.movement.stopPlayer(player.id);
        else if (action === "cleanup") f.movement.cleanup(player.id);
        else if (action === "sync")
          f.movement.syncPlayerPosition(player.id, player.position);
        else {
          replacement = f.movement.findClosestWalkableTile(
            { x: position.x - 1, z: position.z },
            2,
            (tile) =>
              (tile.x !== start.x || tile.z !== start.z) &&
              f.movement.isTileAvailableForPlayer(player.id, tile),
          );
          expect(replacement).not.toBeNull();
          expect(
            f.movement.movePlayerToward(
              player.id,
              tileToWorld(replacement!),
              true,
            ),
          ).toBe(true);
        }
        expect(
          f.movement["_pendingGuidedSearches"].get(player.id)?.search,
        ).not.toBe(search!.search);
        for (let tick = 1; tick <= 8; tick++) {
          f.world.currentTick = tick;
          f.movement.onTick(tick);
          expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(
            1000,
          );
          expect(
            f.movement["pathfinder"].getLastIterationsUsed(),
          ).toBeLessThanOrEqual(250);
          expect(
            f.movement["_pendingGuidedSearches"].get(player.id)?.search,
          ).not.toBe(search!.search);
        }
        expect(f.movement.hasMovementIntent(player.id)).toBe(false);
        expect(f.movement["_pendingGuidedSearches"].size).toBe(0);
        expect(f.movement["stopGuidedCollisionObservation"]).toBeNull();
        expect(f.movement.hasFailedMovementTo(player.id, destination)).toBe(
          false,
        );
        if (replacement)
          expect(worldToTile(player.position.x, player.position.z)).toEqual(
            replacement,
          );
        else expect(player.position.toArray()).toEqual(before);
        if (action === "cleanup")
          expect(f.movement["playerStates"].has(player.id)).toBe(false);
        console.log(
          JSON.stringify({
            phase: "pending-pond-search-retired",
            action,
            start,
            destination,
            replacement,
            position: player.position.toArray(),
          }),
        );
        f.pending.onPlayerDisconnect(player.id);
        f.movement.cleanup(player.id);
        f.world.entities.remove(player.id);
      },
    );

    it.each(["static-lease", "player-occupancy"] as const)(
      "invalidates an actual pending pond search across %s close and reopen",
      async (kind) => {
        const f = await allTierFishingFixture(true);
        const start = { x: 394, z: 408 };
        const destination = { x: 418, z: 432 };
        const position = tileToWorld(start);
        const player = addPlayer(f.world, "pending-pond-collision-change", [
          position.x,
          resolvePlayerRootHeight(position.x, position.z, f.terrain)!,
          position.z,
        ]);
        f.movement.syncPlayerPosition(player.id, player.position);
        expect(
          f.movement.movePlayerToward(
            player.id,
            tileToWorld(destination),
            true,
          ),
        ).toBe(true);
        const pending = f.movement["_pendingGuidedSearches"].get(player.id);
        expect(pending).toBeDefined();
        const distant = { x: start.x + 80, z: start.z + 80 };
        expect(pending!.search.hasCheckedTile(distant.x, distant.z)).toBe(
          false,
        );
        const unrelated = f.world.collision.acquireStaticFootprint([distant]);
        try {
          expect(pending!.dirty).toBe(false);
          expect(f.movement["_pendingGuidedSearches"].get(player.id)).toBe(
            pending,
          );
        } finally {
          expect(unrelated.release()).toBe(true);
        }
        expect(pending!.dirty).toBe(false);
        const watched = [-1, 0, 1]
          .flatMap((dx) =>
            [-1, 0, 1].map((dz) => ({ x: start.x + dx, z: start.z + dz })),
          )
          .find(
            (tile) =>
              (tile.x !== start.x || tile.z !== start.z) &&
              pending!.search.hasCheckedTile(tile.x, tile.z) &&
              f.movement.isTileAvailableForPlayer(player.id, tile),
          );
        if (!watched)
          throw new Error(
            "Real pending search has no available checked neighbor",
          );
        const initialFlags = f.world.collision.getFlags(watched.x, watched.z);
        if (kind === "static-lease") {
          const obstacle = f.world.collision.acquireStaticFootprint([watched]);
          try {
            expect(
              f.world.collision.hasFlags(
                watched.x,
                watched.z,
                CollisionFlag.BLOCKED,
              ),
            ).toBe(true);
            expect(
              f.movement.isTileAvailableForPlayer(player.id, watched),
            ).toBe(false);
            expect(pending!.dirty).toBe(true);
          } finally {
            expect(obstacle.release()).toBe(true);
          }
        } else {
          const point = tileToWorld(watched);
          const blocker = addPlayer(f.world, "pending-search-real-occupant", [
            point.x,
            resolvePlayerRootHeight(point.x, point.z, f.terrain)!,
            point.z,
          ]);
          try {
            f.movement.syncPlayerPosition(blocker.id, blocker.position);
            expect(f.world.entityOccupancy.getOccupant(watched)?.entityId).toBe(
              blocker.id,
            );
            expect(
              f.movement.isTileAvailableForPlayer(player.id, watched),
            ).toBe(false);
            expect(pending!.dirty).toBe(true);
          } finally {
            f.movement.cleanup(blocker.id);
            f.world.entities.remove(blocker.id);
          }
          expect(f.world.entityOccupancy.getOccupant(watched)).toBeNull();
        }
        expect(f.world.collision.getFlags(watched.x, watched.z)).toBe(
          initialFlags,
        );
        // Close/reopen before advancing isolates invalidation. It does not ask a
        // completed unreachable route to retry forever after a future opening.
        let ticks = 0;
        const arrived = () => {
          const tile = worldToTile(player.position.x, player.position.z);
          return tile.x === destination.x && tile.z === destination.z;
        };
        for (; ticks < 256 && !arrived(); ticks++) {
          f.world.currentTick++;
          f.movement.onTick(f.world.currentTick);
          expect(
            f.movement["_pendingGuidedSearches"].get(player.id)?.search,
          ).not.toBe(pending!.search);
          expect(f.movement["_bfsIterationsThisTick"]).toBeLessThanOrEqual(
            1000,
          );
          expect(
            f.movement["pathfinder"].getLastIterationsUsed(),
          ).toBeLessThanOrEqual(250);
          expect(
            f.world.collision.hasFlags(
              Math.floor(player.position.x),
              Math.floor(player.position.z),
              CollisionFlag.BLOCKED |
                CollisionFlag.WATER |
                CollisionFlag.STEEP_SLOPE,
            ),
          ).toBe(false);
          if (!f.movement.hasMovementIntent(player.id) && !arrived()) break;
        }
        console.log(
          JSON.stringify({
            phase: "pending-pond-search-collision-invalidation",
            kind,
            watched,
            distant,
            start,
            destination,
            ticks,
            reached: arrived(),
            movement: f.movement.getPlayerMovementDebug(player.id),
          }),
        );
        expect(arrived()).toBe(true);
        expect(f.movement["_pendingGuidedSearches"].size).toBe(0);
        expect(f.movement["stopGuidedCollisionObservation"]).toBeNull();
        f.pending.onPlayerDisconnect(player.id);
        f.movement.cleanup(player.id);
        f.world.entities.remove(player.id);
      },
    );

    it("keeps the authored corridor clear and walks both decks and every fishing family to the physical bank and back", async () => {
      const f = await allTierFishingFixture(true);
      const owners = f.routeOwners!;
      const config = DataManager.getWorldConfig()!;
      expect(ALL_WORLD_AREAS.duel_arena.duelProtection).toBe(
        "facility-floors-v1",
      );
      expect(config.compactPondDocks?.docks).toHaveLength(2);
      const outlyingCourt = config.compactServiceCourts?.courts.find(
        (court) => court.layoutId === "haven-pond-bank-v1",
      );
      expect(f.bankStations).toHaveLength(outlyingCourt ? 2 : 1);
      expect(f.generatedRouteTiles).toHaveLength(4);
      expect(f.generatedRouteTiles.every((tile) => tile.contentGenerated)).toBe(
        true,
      );
      const banks = f.bankStations.map((station) => {
        const bankId = `station_${station.id}`,
          bank = f.world.entities.get(bankId)!;
        expect(bank).toBeInstanceOf(BankEntity);
        expect(bank.position.x).toBe(station.position.x);
        expect(bank.position.z).toBe(station.position.z);
        return { bankId, bank };
      });
      expect(owners.docks.getCompactDiagnostics()).toHaveLength(2);
      for (const dock of owners.docks.getCompactDiagnostics()) {
        expect(dock.tiles).toBe(24);
        expect(dock.physicsActor && dock.physicsShape).toBe(true);
      }
      expect(owners.courts.getAllDiagnostics()).toHaveLength(
        outlyingCourt ? 3 : 2,
      );
      expect(
        owners.courts.getAllDiagnostics().every((court) => court.physicsActor),
      ).toBe(true);
      expect(owners.rocks.getDiagnostics()?.physicsActors).toBeGreaterThan(0);
      const manifestNpcs = Object.values(ALL_WORLD_AREAS).flatMap(
        (area) => area.npcs ?? [],
      );
      for (const npc of manifestNpcs)
        expect(
          [...f.world.entities.values()].some(
            (entity) =>
              entity.id.startsWith(`npc_${npc.id}_`) &&
              entity.position.x === npc.position.x &&
              entity.position.z === npc.position.z,
          ),
          `Missing actual NPC ${npc.id}`,
        ).toBe(true);
      expect(
        f.resources
          .getAllResources()
          .some((resource) => resource.type === "tree"),
      ).toBe(true);

      let outlyingSupport: Record<string, unknown> | null = null;
      if (outlyingCourt) {
        const { x, z } = outlyingCourt.position;
        const record = owners.courts
          .getCourts()
          .find(
            (court) => court.descriptor.layoutId === outlyingCourt.layoutId,
          )!;
        expect(record).toBeDefined();
        const bank = f.world.entities.get(
          `station_${outlyingCourt.stationIds[0]}`,
        );
        if (!(bank instanceof BankEntity))
          throw new Error("Outlying court lost its actual bank owner");
        const allowedBlocked = new Set(
          [...record.blockingTiles, ...bank["collisionTiles"]].map(
            (tile) => `${tile.x},${tile.z}`,
          ),
        );
        const canonical = groundCompactServiceCourt(
          outlyingCourt,
          BANK_PAVILION_POSTS,
          (a, b) => f.terrain.getResourceGroundHeight(a, b),
        );
        const provider = f.terrain["buildChunkTerrainProvider"]();
        const terrainConfig = f.terrain["CONFIG"];
        const tree = new TerrainQuadTree({
          minSize: terrainConfig.QUADTREE_MIN_SIZE,
          maxDepth: terrainConfig.QUADTREE_MAX_DEPTH,
          splitRatio: terrainConfig.QUADTREE_SPLIT_RATIO,
          unsplitMultiplier: terrainConfig.QUADTREE_UNSPLIT_MULTIPLIER,
          resolution: terrainConfig.QUADTREE_RESOLUTION,
          fineDetailRegions: createCompactPreparationDetailRegions(
            f.terrain.getWorldTerrainProfile(),
            ALL_WORLD_AREAS,
            terrainConfig.QUADTREE_RESOLUTION,
          ),
          rootChunkRadius: 0,
        });
        let leaf: {
          centerX: number;
          centerZ: number;
          size: number;
          resolution: number;
        };
        try {
          tree.update(x, z);
          const node = tree
            .getFinalNodes()
            .find(
              (candidate) =>
                Math.abs(candidate.centerX - x) < candidate.size / 2 &&
                Math.abs(candidate.centerZ - z) < candidate.size / 2,
            );
          if (!node)
            throw new Error("Outlying bank has no actual terrain leaf");
          leaf = {
            centerX: node.centerX,
            centerZ: node.centerZ,
            size: node.size,
            resolution: node.resolution,
          };
        } finally {
          tree.dispose();
        }
        const { centerX, centerZ, size, resolution } = leaf;
        const geometry = assembleQuadChunkGeometry(
          generateQuadChunkDataSync(
            centerX,
            centerZ,
            size,
            resolution,
            provider,
          ),
          provider,
          terrainConfig.QUADTREE_SKIRT_DROP,
        ).geometry;
        try {
          const retained = new RetainedTerrainSurface(
            1,
            provider.terrainProfileIdentity,
            centerX,
            centerZ,
            size,
            resolution,
            geometry,
          );
          const out = { height: 0, nx: 0, ny: 1, nz: 0, faceIndex: 0 };
          const sample = (a: number, b: number) => {
            expect(retained.sample(a - centerX, b - centerZ, out)).toBe(true);
            return out.height;
          };
          const rendered = groundCompactServiceCourt(
            outlyingCourt,
            BANK_PAVILION_POSTS,
            sample,
          );
          let samples = 0,
            maximumHeightError = 0,
            wet = 0;
          let maximumHeightWitness: Record<string, number> | null = null;
          const unexpectedBlocked = new Set<string>();
          for (let a = x - 5; a <= x + 5; a += 0.25)
            for (let b = z - 5; b <= z + 5; b += 0.25) {
              const height = f.terrain.getResourceGroundHeight(a, b);
              const renderedHeight = sample(a, b);
              const error = Math.abs(renderedHeight - height);
              if (error > maximumHeightError) {
                maximumHeightError = error;
                maximumHeightWitness = {
                  x: a,
                  z: b,
                  canonical: height,
                  retained: renderedHeight,
                  error,
                };
              }
              const water = f.terrain.getWaterBodyRegistry().getBodyAt(a, b);
              if (water && height <= water.surfaceY) wet++;
              const tx = Math.floor(a),
                tz = Math.floor(b),
                key = `${tx},${tz}`;
              if (
                f.world.collision.hasFlags(
                  tx,
                  tz,
                  CollisionFlag.BLOCKED |
                    CollisionFlag.WATER |
                    CollisionFlag.STEEP_SLOPE,
                ) &&
                !allowedBlocked.has(key)
              )
                unexpectedBlocked.add(key);
              samples++;
            }
          expect
            .soft(maximumHeightError, JSON.stringify(maximumHeightWitness))
            .toBeLessThanOrEqual(0.02);
          expect(wet).toBe(0);
          expect([...unexpectedBlocked]).toEqual([]);
          expect(
            Math.abs(record.position.y - canonical.position.y),
          ).toBeLessThanOrEqual(0.02);
          expect(
            Math.abs(rendered.position.y - canonical.position.y),
          ).toBeLessThanOrEqual(0.02);
          for (const bounds of [
            ...getDuelArenaProtectionBounds(),
            ...config.compactPondDocks!.docks.map(
              getCompactPondDockSupportBounds,
            ),
          ])
            expect(
              compactPathIntersectsBounds({ x, z }, { x, z }, bounds, 5),
            ).toBe(false);
          const habitat = createCompactPondDressing(
            f.terrain.getWorldTerrainProfile(),
            ALL_WORLD_AREAS,
            (a, b) => f.terrain.getResourceGroundHeight(a, b),
            config.compactPondDocks,
          );
          for (const plant of habitat) {
            const radius =
              COMPACT_POND_MODELS[plant.model].radius * plant.scale;
            expect(
              Math.abs(plant.x - x) > 5 + radius ||
                Math.abs(plant.z - z) > 5 + radius,
            ).toBe(true);
          }
          const entries = [
            { x: x - 5, z },
            { x: x + 5, z },
            { x, z: z - 5 },
            { x, z: z + 5 },
          ];
          for (const entry of entries)
            expect(
              f.movement.isTileAvailableForPlayer(
                "pond-bank-entry-probe",
                worldToTile(entry.x, entry.z),
              ),
            ).toBe(true);
          outlyingSupport = {
            layoutId: outlyingCourt.layoutId,
            leaf,
            samples,
            maximumHeightError,
            maximumHeightWitness,
            wet,
            unexpectedBlocked: [...unexpectedBlocked],
            entries,
            canonicalFeet: canonical.feet,
            retainedFeet: rendered.feet,
            retainedVertices: geometry.getAttribute("position").count,
            retainedTriangles: geometry.index!.count / 3,
          };
        } finally {
          geometry.dispose();
        }
      }

      const protection = getDuelArenaProtectionBounds();
      const pondPaths = owners.roads
        .getRoads()
        .filter((road) => road.id.includes("pond-bank"));
      expect(pondPaths.length).toBeGreaterThan(0);
      const paintedProtection: Array<{
        path: string;
        segment: number;
        bounds: unknown;
      }> = [];
      const paintedWater: Array<{ path: string; x: number; z: number }> = [];
      let widthSamples = 0;
      for (const road of pondPaths) {
        const radius = road.width / 2 + (road.blendWidth ?? 0);
        for (let index = 1; index < road.path.length; index++) {
          const a = road.path[index - 1],
            b = road.path[index];
          for (const bounds of protection)
            if (compactPathIntersectsBounds(a, b, bounds, radius))
              paintedProtection.push({ path: road.id, segment: index, bounds });
          // Whole capsule perimeter at <=0.25m longitudinal intervals and 32
          // bearings, not just path centers. Exact rectangle checks above cover
          // protected aprons continuously; water checks remain sampled evidence.
          const steps = Math.max(
            1,
            Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25),
          );
          for (let step = 0; step <= steps; step++)
            for (let bearing = 0; bearing < 32; bearing++) {
              const angle = (bearing * Math.PI) / 16;
              const x =
                a.x + ((b.x - a.x) * step) / steps + Math.cos(angle) * radius;
              const z =
                a.z + ((b.z - a.z) * step) / steps + Math.sin(angle) * radius;
              widthSamples++;
              if (
                f.terrain.getWaterBodyRegistry().getBodyAt(x, z)?.id ===
                  f.body.id &&
                f.terrain.getResourceGroundHeight(x, z) <= f.body.surfaceY
              )
                paintedWater.push({ path: road.id, x, z });
            }
        }
      }
      expect
        .soft(
          paintedProtection,
          "Paint width/blend enters a protected facility apron",
        )
        .toEqual([]);
      expect
        .soft(
          paintedWater.slice(0, 10),
          "Paint width/blend enters actual pond water",
        )
        .toEqual([]);

      const journeys: Array<{
        origin: string;
        bankId: string;
        start: number[];
        bank: number[];
        end: number[];
        legs: Array<{
          label: string;
          accepted: boolean;
          reached: boolean;
          ticks: number;
          protectedTiles: string[];
          blockedTiles: string[];
        }>;
        bankAccess: ReturnType<typeof validatePhysicalBankAccess>;
      }> = [];
      const walk = (
        player: PlayerEntity,
        target: { x: number; z: number },
        label: string,
      ) => {
        const destination = worldToTile(target.x, target.z);
        const accepted = f.movement.movePlayerToward(
          player.id,
          {
            x: target.x,
            y: resolvePlayerRootHeight(
              target.x,
              target.z,
              f.terrain,
              owners.towns.getCollisionService(),
            )!,
            z: target.z,
          },
          false,
        );
        let ticks = 0;
        const protectedTiles = new Set<string>(),
          blockedTiles = new Set<string>();
        const arrived = () => {
          const tile = worldToTile(player.position.x, player.position.z);
          return tile.x === destination.x && tile.z === destination.z;
        };
        let precedingPath: Record<string, unknown> | null = null;
        for (; ticks < 256 && !arrived(); ticks++) {
          const state = f.movement["playerStates"].get(player.id);
          precedingPath = {
            ...f.movement.getPlayerMovementDebug(player.id),
            lastPathPartial: state?.lastPathPartial ?? null,
            pathEnd: state?.path.at(-1) ? { ...state.path.at(-1)! } : null,
          };
          f.world.currentTick++;
          f.movement.onTick(f.world.currentTick);
          const tile = worldToTile(player.position.x, player.position.z);
          if (
            isPositionInsideDuelArenaZone(player.position.x, player.position.z)
          )
            protectedTiles.add(`${tile.x},${tile.z}`);
          // The actor's own OCCUPIED_PLAYER bit is not an obstacle violation.
          if (
            f.world.collision.hasFlags(
              tile.x,
              tile.z,
              CollisionFlag.BLOCKED |
                CollisionFlag.WATER |
                CollisionFlag.STEEP_SLOPE,
            )
          )
            blockedTiles.add(`${tile.x},${tile.z}`);
          expect(player.position.y).toBeCloseTo(
            resolvePlayerRootHeight(
              player.position.x,
              player.position.z,
              f.terrain,
              owners.towns.getCollisionService(),
            )!,
            5,
          );
          if (!f.movement.hasMovementIntent(player.id) && !arrived()) break;
        }
        const result = {
          label,
          accepted,
          reached: arrived(),
          ticks,
          protectedTiles: [...protectedTiles],
          blockedTiles: [...blockedTiles],
          failure: arrived()
            ? null
            : {
                playerId: player.id,
                position: player.position.toArray(),
                destination,
                movement: f.movement.getPlayerMovementDebug(player.id),
                precedingPath,
                iterations: f.movement["pathfinder"].getLastIterationsUsed(),
                partial: f.movement["pathfinder"].wasLastPathPartial(),
                failedExact: f.movement.hasFailedMovementTo(
                  player.id,
                  destination,
                ),
                destinationAvailable: f.movement.isTileAvailableForPlayer(
                  player.id,
                  destination,
                ),
              },
        };
        expect
          .soft(
            result.reached,
            JSON.stringify({
              result,
              movement: f.movement.getPlayerMovementDebug(player.id),
            }),
          )
          .toBe(true);
        // Ordinary navigation is not constrained to painted paths. Lobby and
        // hospital transit is permitted; retain crossings as design evidence,
        // not an invented collision wall or a protected-route qualification.
        expect
          .soft(result.blockedTiles, `${label} crossed a blocked tile`)
          .toEqual([]);
        return result;
      };
      const roundTrip = (origin: string, player: PlayerEntity) => {
        const start = player.position.toArray();
        expect(
          isPositionInsideDuelArenaZone(start[0], start[2]),
          `${origin} preparation origin`,
        ).toBe(false);
        for (const { bank, bankId } of banks) {
          expect.soft(player.position.toArray()).toEqual(start);
          // Preserve a real failed return. Never teleport or compare another
          // bank from a different starting point just to complete the receipt.
          if (
            !player.position
              .toArray()
              .every((value, index) => value === start[index])
          )
            break;
          const target = f.movement.findClosestWalkableTile(
            bank.position,
            2,
            (tile) => {
              const point = tileToWorld(tile);
              return (
                f.movement.isTileAvailableForPlayer(player.id, tile) &&
                Math.max(
                  Math.abs(point.x - bank.position.x),
                  Math.abs(point.z - bank.position.z),
                ) <= 2
              );
            },
          );
          expect(
            target,
            `No actual bank interaction tile from ${origin}`,
          ).not.toBeNull();
          const outbound = walk(
            player,
            tileToWorld(target!),
            `${origin}:${bankId}:bank`,
          );
          const bankPosition = player.position.toArray();
          expect
            .soft(
              isPositionInsideDuelArenaZone(bankPosition[0], bankPosition[2]),
              `${origin} bank destination`,
            )
            .toBe(false);
          const bankAccess = validatePhysicalBankAccess(
            f.world,
            player.id,
            bankId,
          );
          expect
            .soft(bankAccess, `${origin} cannot access real bank entity`)
            .toBeNull();
          const inbound = walk(
            player,
            { x: start[0], z: start[2] },
            `${origin}:${bankId}:return`,
          );
          journeys.push({
            origin,
            bankId,
            start,
            bank: bankPosition,
            end: player.position.toArray(),
            legs: [outbound, inbound],
            bankAccess,
          });
        }
      };
      const retire = (player: PlayerEntity) => {
        f.pending.onPlayerDisconnect(player.id);
        f.movement.cleanup(player.id);
        f.world.entities.remove(player.id);
      };
      for (const dock of config.compactPondDocks!.docks) {
        const direction = getCompactPondDockDirection(dock.rotation);
        const tile = worldToTile(
          dock.x + direction.x * 4.5,
          dock.z + direction.z * 4.5,
        );
        const position = tileToWorld(tile);
        expect(owners.docks.isDockTile(tile.x, tile.z)).toBe(true);
        const player = addPlayer(f.world, `bank-route-${dock.id}`, [
          position.x,
          resolvePlayerRootHeight(position.x, position.z, f.terrain)!,
          position.z,
        ]);
        f.movement.syncPlayerPosition(player.id, player.position);
        roundTrip(dock.id, player);
        retire(player);
      }
      const testedFamilies = new Set<string>();
      for (const resource of f.spots) {
        const family = f.variant(resource);
        if (testedFamilies.has(family)) continue;
        testedFamilies.add(family);
        const { player } = await f.addAngler(`bank-route-${family}`, resource);
        expect(
          f.pending.queuePendingGather(
            player.id,
            resource.id,
            f.world.currentTick,
            true,
          ),
        ).toBe(true);
        for (
          let i = 0;
          i < 20 && f.pending["pendingGathers"].has(player.id);
          i++
        ) {
          f.world.currentTick++;
          f.movement.onTick(f.world.currentTick);
          f.pending.processTick(f.world.currentTick);
        }
        expect(
          f.resources.isPlayerGatheringResource(player.id, resource.id),
        ).toBe(true);
        f.resources["stopGathering"]({ playerId: player.id });
        roundTrip(family, player);
        retire(player);
      }
      expect(testedFamilies.size).toBe(7);
      expect.soft(journeys).toHaveLength(9 * banks.length);
      const nonDockWitnesses = [];
      for (const family of testedFamilies) {
        const id = `bank-route-nondock-${family}`;
        const candidates = f.spots
          .filter((spot) => f.variant(spot) === family)
          .map((resource) => {
            const anchor = worldToTile(
              resource.position.x,
              resource.position.z,
            );
            const dryTiles: Array<{ x: number; z: number }> = [];
            const range = GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE;
            for (let dx = -Math.ceil(range); dx <= Math.ceil(range); dx++)
              for (let dz = -Math.ceil(range); dz <= Math.ceil(range); dz++) {
                const tile = { x: anchor.x + dx, z: anchor.z + dz },
                  point = tileToWorld(tile);
                if (
                  !owners.docks.isDockTile(tile.x, tile.z) &&
                  calculateDistance2D(point, resource.position) <= range &&
                  f.terrain.getResourceGroundHeight(point.x, point.z) >=
                    f.body.surfaceY &&
                  f.movement.isTileAvailableForPlayer(id, tile)
                )
                  dryTiles.push(tile);
              }
            // The real owner always chooses its nearest available approach. Do
            // not occupy a deck, replace availability or force a preferred shore.
            const selected = f.pending["findFishingApproach"](
              id,
              resource.position,
            );
            return { resource, dryTiles, selected };
          });
        const witness = candidates.find(
          ({ selected, dryTiles }) =>
            selected &&
            dryTiles.some(
              (tile) => tile.x === selected.x && tile.z === selected.z,
            ),
        );
        const receipt = {
          family,
          candidates: candidates.map(({ resource, dryTiles, selected }) => ({
            resourceId: resource.id,
            dryNonDockTiles: dryTiles.length,
            selected,
          })),
          selectedResourceId: witness?.resource.id ?? null,
          shore: witness?.selected ?? null,
        };
        nonDockWitnesses.push(receipt);
        expect.soft(witness, JSON.stringify(receipt)).toBeDefined();
        if (!witness?.selected) continue;
        const { player } = await f.addAngler(id, witness.resource, {
          tile: witness.selected,
        });
        expect(
          f.pending.queuePendingGather(
            id,
            witness.resource.id,
            f.world.currentTick,
            true,
          ),
        ).toBe(true);
        expect(
          f.resources.isPlayerGatheringResource(id, witness.resource.id),
        ).toBe(true);
        expect(f.pending["pendingGathers"].has(id)).toBe(false);
        expect(
          owners.docks.isDockTile(
            Math.floor(player.position.x),
            Math.floor(player.position.z),
          ),
        ).toBe(false);
        f.resources["stopGathering"]({ playerId: id });
        roundTrip(`non-dock-${family}`, player);
        retire(player);
      }
      expect
        .soft(nonDockWitnesses.filter((witness) => witness.selectedResourceId))
        .toHaveLength(7);
      expect.soft(journeys).toHaveLength(16 * banks.length);
      const comparisons = outlyingCourt
        ? [...new Set(journeys.map((journey) => journey.origin))].map(
            (origin) => {
              const primary = journeys.find(
                (journey) =>
                  journey.origin === origin &&
                  journey.bankId === "station_bank_spawn",
              );
              const secondary = journeys.find(
                (journey) =>
                  journey.origin === origin &&
                  journey.bankId === `station_${outlyingCourt.stationIds[0]}`,
              );
              if (
                !primary ||
                !secondary ||
                [primary, secondary].some(
                  (journey) =>
                    journey.legs.some((leg) => !leg.reached) ||
                    journey.bankAccess !== null,
                )
              )
                return {
                  origin,
                  complete: false,
                  availableBanks: [primary?.bankId, secondary?.bankId].filter(
                    Boolean,
                  ),
                };
              expect(primary.start).toEqual(secondary.start);
              const ticks = (journey: (typeof journeys)[number]) =>
                journey.legs.reduce((sum, leg) => sum + leg.ticks, 0);
              return {
                origin,
                complete: true,
                primaryTicks: ticks(primary),
                secondaryTicks: ticks(secondary),
                savedTicks: ticks(primary) - ticks(secondary),
              };
            },
          )
        : [];
      console.log(
        JSON.stringify({
          phase: "pond-bank-cpu-routes",
          assetDirectory: process.env.ASSETS_DIR,
          widthSamples,
          paintedProtection,
          paintedWaterCount: paintedWater.length,
          docks: owners.docks.getCompactDiagnostics(),
          courts: owners.courts.getAllDiagnostics(),
          resourceCount: f.resources.getAllResources().length,
          generatedRouteTiles: f.generatedRouteTiles,
          manifestNpcCount: manifestNpcs.length,
          journeys,
          nonDockWitnesses,
          outlyingSupport,
          comparisons,
          excluded: [
            "bank deposit/withdraw persistence",
            "crowd throughput",
            "native render",
            "physics stepping",
            "dynamic mobs",
            "terrain resources outside the four route tiles",
          ],
        }),
      );
    });
  },
);

describe("real fishing approach admission (CPU, not basin crowd/reward acceptance)", () => {
  it("rejects farther dry shore when every in-range approach is occupied", async () => {
    const f = await fishingFixture();
    const legal: Array<{ x: number; z: number }> = [];
    const anchorX = Math.floor(f.resource.position.x),
      anchorZ = Math.floor(f.resource.position.z);
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++) {
        const tile = { x: anchorX + dx, z: anchorZ + dz };
        if (
          calculateDistance2D(tileToWorld(tile), f.resource.position) <=
            GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE &&
          f.movement.isTileAvailableForPlayer("arrival", tile)
        )
          legal.push(tile);
      }
    expect(legal.length).toBeGreaterThan(0);
    for (const [index, tile] of legal.entries())
      f.addAngler(`shore-occupant-${index}`, tile);
    const arrival = f.addAngler("shore-overflow-arrival", f.available(true));
    const before = f.packets.length;
    expect(f.pending.queuePendingGather(arrival.id, f.resource.id, 0)).toBe(
      false,
    );
    expect(f.pending["pendingGathers"].size).toBe(0);
    expect(f.pending["approachReservations"].size).toBe(0);
    expect(f.movement.isMoving(arrival.id)).toBe(false);
    expect(f.packets.length).toBe(before);
    expect(f.world.entityOccupancy.getStats().playerTileCount).toBe(
      legal.length + 1,
    );
  });

  it("admits the exact four-metre boundary using real dry support and gathering tools", async () => {
    const f = await fishingFixture();
    const anchor = {
      x: Math.floor(f.resource.position.x),
      z: Math.floor(f.resource.position.z),
    };
    const boundary = [
      { x: anchor.x + 4, z: anchor.z },
      { x: anchor.x - 4, z: anchor.z },
      { x: anchor.x, z: anchor.z + 4 },
      { x: anchor.x, z: anchor.z - 4 },
    ].find((tile) =>
      f.movement.isTileAvailableForPlayer("boundary-angler", tile),
    );
    expect(boundary).toBeDefined();
    const player = f.addAngler("boundary-angler", boundary!);
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++) {
        const tile = { x: anchor.x + dx, z: anchor.z + dz };
        if (tile.x === boundary!.x && tile.z === boundary!.z) continue;
        if (
          calculateDistance2D(tileToWorld(tile), f.resource.position) <=
            GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE &&
          f.movement.isTileAvailableForPlayer("boundary-blocker", tile)
        )
          f.addAngler(`boundary-blocker-${dx}-${dz}`, tile);
      }
    expect(calculateDistance2D(player.position, f.resource.position)).toBe(
      GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE,
    );
    expect(f.pending.queuePendingGather(player.id, f.resource.id, 0)).toBe(
      true,
    );
    expect(
      f.resources.isPlayerGatheringResource(player.id, f.resource.id),
    ).toBe(true);
    expect(f.pending["approachReservations"].size).toBe(0);
    expect(f.pending["pendingGathers"].size).toBe(0);
  });

  it("releases the approach and arrival emote when actual pathfinding rejects an enclosed actor", async () => {
    const f = await fishingFixture();
    const tile = f.available(true);
    const player = f.addAngler("enclosed-angler", tile);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        if (dx || dz)
          f.world.collision.addFlags(
            tile.x + dx,
            tile.z + dz,
            CollisionFlag.BLOCKED,
          );
      }
    expect(f.pending.queuePendingGather(player.id, f.resource.id, 0)).toBe(
      false,
    );
    expect(f.pending["approachReservations"].size).toBe(0);
    expect(f.pending["pendingGathers"].size).toBe(0);
    expect(f.movement["arrivalEmotes"].has(player.id)).toBe(false);
    expect(f.movement["arrivalEmoteResolvers"].has(player.id)).toBe(false);
    expect(f.movement.isMoving(player.id)).toBe(false);
    expect(
      f.resources.isPlayerGatheringResource(player.id, f.resource.id),
    ).toBe(false);
    expect(
      f.packets.some((packet) => packet.name === "tileMovementStart"),
    ).toBe(false);
    const failed = f.movement["failedExactRoutes"].get(player.id)!;
    expect(failed).toBeDefined();
    expect(f.movement.hasFailedMovementTo(player.id, failed)).toBe(true);
    expect(
      f.movement.hasFailedMovementTo(player.id, {
        x: failed.x + 1,
        z: failed.z,
      }),
    ).toBe(false);
    // Clear an actual failure receipt, not merely an already-empty map.
    f.movement.stopPlayer(player.id);
    expect(f.movement.hasFailedMovementTo(player.id, failed)).toBe(false);
    expect(f.movement["failedExactRoutes"].has(player.id)).toBe(false);
    expect(f.pending.queuePendingGather(player.id, f.resource.id, 1)).toBe(
      false,
    );
    expect(f.movement.hasFailedMovementTo(player.id, failed)).toBe(true);
    expect(
      f.movement.movePlayerToward(player.id, player.position, false, 0),
    ).toBe(true);
    expect(f.movement.hasFailedMovementTo(player.id, failed)).toBe(false);
    expect(f.movement["failedExactRoutes"].has(player.id)).toBe(false);
  });

  it("keeps valid reservations on rejected replacement, then releases them on cancellation and disconnect", async () => {
    const f = await fishingFixture();
    const first = f.addAngler("reservation-first", f.available(true));
    expect(f.pending.queuePendingGather(first.id, f.resource.id, 0)).toBe(true);
    const retained = f.pending["pendingGathers"].get(first.id);
    const keys = [...f.pending["approachReservations"].keys()];
    expect(
      f.pending.queuePendingGather(first.id, "missing-fishing-resource", 1),
    ).toBe(false);
    expect(f.pending["pendingGathers"].get(first.id)).toBe(retained);
    expect([...f.pending["approachReservations"].keys()]).toEqual(keys);
    const second = f.addAngler("reservation-second", f.available(true));
    expect(f.pending.queuePendingGather(second.id, f.resource.id, 1)).toBe(
      true,
    );
    expect(f.pending["approachReservations"].size).toBe(2);
    for (const request of f.pending["pendingGathers"].values()) {
      expect(
        calculateDistance2D(
          tileToWorld(request.targetShoreTile!),
          f.resource.position,
        ),
      ).toBeLessThanOrEqual(GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE);
      expect(
        f.terrain.isPositionWalkableFast(
          ...([
            tileToWorld(request.targetShoreTile!).x,
            tileToWorld(request.targetShoreTile!).z,
          ] as [number, number]),
        ),
      ).toBe(true);
    }
    f.pending.cancelPendingGather(first.id);
    expect(f.pending["pendingGathers"].has(first.id)).toBe(false);
    expect(f.pending["approachReservations"].size).toBe(1);
    f.pending.onPlayerDisconnect(second.id);
    expect(f.pending["pendingGathers"].size).toBe(0);
    expect(f.pending["approachReservations"].size).toBe(0);
  });

  it("replans a real relocated fishing entity through the same reach and occupancy checks", async () => {
    const f = await fishingFixture(true);
    const player = f.addAngler("relocating-shore-angler", f.available(true));
    const attempt = "11111111-1111-4111-8111-111111111111";
    expect(
      f.pending.queuePendingGather(player.id, f.resource.id, 0, true, attempt),
    ).toBe(true);
    expect(
      f.resources.playerHasRequiredToolForResource(player.id, f.resource.id),
    ).toBe(true);
    expect(f.movement["arrivalEmotes"].get(player.id)).toBe("fishing");
    expect(f.movement.isMoving(player.id)).toBe(true);
    expect(
      f.resources.isPlayerGatheringResource(player.id, f.resource.id),
    ).toBe(false);
    const before = { ...f.resource.position };
    f.resources["relocateFishingSpot"](createResourceID(f.resource.id), 1);
    expect(
      calculateDistance2D(before, f.resource.position),
    ).toBeGreaterThanOrEqual(
      GATHERING_CONSTANTS.FISHING_SPOT_MOVE.relocateMinDistance,
    );
    expect(
      calculateDistance2D(before, f.resource.position),
    ).toBeLessThanOrEqual(GATHERING_CONSTANTS.FISHING_SPOT_MOVE.relocateRadius);
    expect(f.world.entities.get(f.resource.id)!.position.toArray()).toEqual([
      f.resource.position.x,
      f.resource.position.y,
      f.resource.position.z,
    ]);
    f.pending.processTick(1);
    const next = f.pending["pendingGathers"].get(player.id);
    // A real random relocation may place its new legal shore under the actor;
    // that is immediate admission, not a failed or missing replan.
    if (next) {
      expect(next.resourcePosition).toEqual(f.resource.position);
      expect(next.completionAttemptId).toBe(attempt);
      expect(next.runMode).toBe(true);
      expect(next.resourceAnchorTile).toEqual({
        x: Math.floor(f.resource.position.x),
        z: Math.floor(f.resource.position.z),
      });
      expect(f.pending["approachReservations"].size).toBe(1);
      expect(
        calculateDistance2D(
          tileToWorld(next.targetShoreTile!),
          f.resource.position,
        ),
      ).toBeLessThanOrEqual(GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE);
    } else {
      expect(
        f.resources.isPlayerGatheringResource(player.id, f.resource.id),
      ).toBe(true);
    }
    for (let tick = 2; tick <= 20 && f.pending["pendingGathers"].size; tick++) {
      f.movement.onTick(tick);
      f.pending.processTick(tick);
    }
    expect(f.pending["pendingGathers"].size).toBe(0);
    expect(f.pending["approachReservations"].size).toBe(0);
    expect(
      f.resources.isPlayerGatheringResource(player.id, f.resource.id),
    ).toBe(true);
  });

  it("waits for real obstruction retries, then changes an abandoned shore without resetting its attempt deadline", async () => {
    const f = await fishingFixture();
    const angler = f.addAngler("obstructed-shore-angler", f.available(true));
    const attempt = "22222222-2222-4222-8222-222222222222";
    expect(
      f.pending.queuePendingGather(angler.id, f.resource.id, 0, true, attempt),
    ).toBe(true);
    const original = f.pending["pendingGathers"].get(angler.id)!;
    const blocked = { ...original.targetShoreTile! };
    f.addAngler("new-shore-occupant", blocked);
    let sawDeferred = false,
      sawTerminal = false;
    for (
      let tick = 1;
      tick <= 20 && f.pending["pendingGathers"].has(angler.id);
      tick++
    ) {
      f.movement.onTick(tick);
      const retrying = f.movement["_pendingObstructionReplans"].has(angler.id);
      const before = f.pending["pendingGathers"].get(angler.id)!;
      if (retrying) {
        sawDeferred = true;
        expect(f.movement.isMoving(angler.id)).toBe(false);
        expect(f.movement.hasMovementIntent(angler.id)).toBe(true);
        expect(f.movement.hasFailedMovementTo(angler.id, blocked)).toBe(false);
      }
      const terminal = !f.movement.hasMovementIntent(angler.id);
      if (terminal && !sawTerminal)
        expect(f.movement.hasFailedMovementTo(angler.id, blocked)).toBe(true);
      f.pending.processTick(tick);
      const after = f.pending["pendingGathers"].get(angler.id);
      if (retrying) {
        expect(after).toBe(before);
        expect(after!.targetShoreTile).toEqual(blocked);
        expect(after!.failedFishingApproaches).toBeUndefined();
      } else if (terminal && !sawTerminal) {
        sawTerminal = true;
        expect(before.failedFishingApproaches).toEqual(
          new Set([`${blocked.x},${blocked.z}`]),
        );
        expect(before.targetShoreTile).not.toEqual(blocked);
      }
      if (after) {
        expect(after.createdTick).toBe(0);
        expect(after.completionAttemptId).toBe(attempt);
      }
    }
    expect(sawDeferred).toBe(true);
    expect(sawTerminal).toBe(true);
    expect(f.pending["pendingGathers"].size).toBe(0);
    expect(f.pending["approachReservations"].size).toBe(0);
    expect(
      f.resources.isPlayerGatheringResource(angler.id, f.resource.id),
    ).toBe(true);
    expect(worldToTile(angler.position.x, angler.position.z)).not.toEqual(
      blocked,
    );
  });

  it("retains a fishing shore while the actual shared BFS budget has deferred its route", async () => {
    const f = await fishingFixture();
    const driver = f.addAngler("budget-consuming-angler", f.available(true));
    const island = f.terrain.getWorldTerrainProfile().island;
    // Real long path requests consume the real pathfinder's global tick budget;
    // no counter, queue, clock, terrain predicate or movement method is replaced.
    for (
      let index = 0;
      index < 64 &&
      f.movement["_bfsIterationsThisTick"] <
        TileMovementManager["MAX_BFS_ITERATIONS_PER_TICK"];
      index++
    ) {
      const destination = f.movement.findClosestWalkableTile(
        {
          x: island.centerX + (index % 16),
          z: island.centerZ + Math.floor(index / 16),
        },
        10,
      );
      expect(destination).not.toBeNull();
      f.movement.movePlayerToward(
        driver.id,
        tileToWorld(destination!),
        true,
        0,
      );
    }
    expect(f.movement["_bfsIterationsThisTick"]).toBeGreaterThanOrEqual(
      TileMovementManager["MAX_BFS_ITERATIONS_PER_TICK"],
    );
    const angler = f.addAngler("budget-deferred-angler", f.available(true));
    expect(
      f.pending.queuePendingGather(angler.id, f.resource.id, 0, true),
    ).toBe(true);
    expect(f.movement.isMoving(angler.id)).toBe(false);
    expect(f.movement["_pendingNonCombatMoves"].has(angler.id)).toBe(true);
    expect(f.movement.hasMovementIntent(angler.id)).toBe(true);
    const request = f.pending["pendingGathers"].get(angler.id)!;
    const shore = { ...request.targetShoreTile! };
    f.pending.processTick(0);
    expect(f.pending["pendingGathers"].get(angler.id)).toBe(request);
    expect(request.targetShoreTile).toEqual(shore);
    expect(request.failedFishingApproaches).toBeUndefined();
    f.movement.stopPlayer(angler.id);
    expect(f.movement.hasMovementIntent(angler.id)).toBe(false);
    expect(f.movement.hasFailedMovementTo(angler.id, shore)).toBe(false);
    const packetsAfterStop = f.packets.length;
    for (let tick = 1; tick <= 21; tick++) f.pending.processTick(tick);
    expect(f.movement.hasMovementIntent(angler.id)).toBe(false);
    expect(f.packets.length).toBe(packetsAfterStop);
    expect(
      f.resources.isPlayerGatheringResource(angler.id, f.resource.id),
    ).toBe(false);
    expect(f.pending["pendingGathers"].size).toBe(0);
    expect(f.pending["approachReservations"].size).toBe(0);
  });

  it("never restarts fishing after an explicit action stop of an active approach", async () => {
    const f = await fishingFixture();
    const angler = f.addAngler("action-stopped-angler", f.available(true));
    expect(
      f.pending.queuePendingGather(angler.id, f.resource.id, 0, true),
    ).toBe(true);
    expect(f.movement.isMoving(angler.id)).toBe(true);
    const request = f.pending["pendingGathers"].get(angler.id)!;
    const before = angler.position.toArray();
    // Processing actions use this real movement-owner stop. An idle path is
    // not a route failure and cannot authorize fishing to restart on its own.
    f.movement.stopPlayer(angler.id);
    expect(
      f.movement.hasFailedMovementTo(angler.id, request.targetShoreTile!),
    ).toBe(false);
    const packetsAfterStop = f.packets.length;
    for (let tick = 1; tick <= 21; tick++) {
      f.movement.onTick(tick);
      f.pending.processTick(tick);
    }
    expect(f.movement.hasMovementIntent(angler.id)).toBe(false);
    expect(angler.position.toArray()).toEqual(before);
    expect(f.packets.length).toBe(packetsAfterStop);
    expect(request.failedFishingApproaches).toBeUndefined();
    expect(
      f.resources.isPlayerGatheringResource(angler.id, f.resource.id),
    ).toBe(false);
    expect(f.pending["pendingGathers"].size).toBe(0);
    expect(f.pending["approachReservations"].size).toBe(0);
  });

  it("replans four real anglers onto distinct in-range shores after an actual spot relocation", async () => {
    const f = await fishingFixture(true);
    const anglers = Array.from({ length: 4 }, (_, index) =>
      f.addAngler(`moving-group-${index}`, f.available(true)),
    );
    for (const player of anglers) {
      expect(
        f.pending.queuePendingGather(player.id, f.resource.id, 0, true),
      ).toBe(true);
      expect(f.movement["arrivalEmotes"].get(player.id)).toBe("fishing");
      expect(
        f.resources.isPlayerGatheringResource(player.id, f.resource.id),
      ).toBe(false);
    }
    expect(f.pending["approachReservations"].size).toBe(4);
    expect(f.pending["pendingGathers"].size).toBe(4);
    const before = { ...f.resource.position };
    f.resources["relocateFishingSpot"](createResourceID(f.resource.id), 1);
    expect(
      calculateDistance2D(before, f.resource.position),
    ).toBeGreaterThanOrEqual(
      GATHERING_CONSTANTS.FISHING_SPOT_MOVE.relocateMinDistance,
    );
    f.pending.processTick(1);
    const ownedApproaches = new Set<string>();
    for (const player of anglers) {
      const next = f.pending["pendingGathers"].get(player.id);
      const tile =
        next?.targetShoreTile ??
        worldToTile(player.position.x, player.position.z);
      expect(tile).toBeDefined();
      if (next) {
        expect(next.resourcePosition).toEqual(f.resource.position);
        expect(next.resourceAnchorTile).toEqual({
          x: Math.floor(f.resource.position.x),
          z: Math.floor(f.resource.position.z),
        });
        expect(next.runMode).toBe(true);
        expect(
          f.resources.isPlayerGatheringResource(player.id, f.resource.id),
        ).toBe(false);
        expect(f.movement["arrivalEmotes"].get(player.id)).toBe("fishing");
      } else {
        // Relocation can legitimately make an already occupied dry tile the
        // immediate approach. It must be an actual session, not a dropped replan.
        expect(
          f.resources.isPlayerGatheringResource(player.id, f.resource.id),
        ).toBe(true);
      }
      expect(
        calculateDistance2D(tileToWorld(tile), f.resource.position),
      ).toBeLessThanOrEqual(GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE);
      ownedApproaches.add(`${tile.x},${tile.z}`);
    }
    expect(ownedApproaches.size).toBe(4);
    expect(f.pending["approachReservations"].size).toBe(
      f.pending["pendingGathers"].size,
    );
    for (let tick = 2; tick <= 20 && f.pending["pendingGathers"].size; tick++) {
      f.movement.onTick(tick);
      f.pending.processTick(tick);
    }
    expect(
      f.pending["pendingGathers"].size,
      JSON.stringify({
        before,
        after: f.resource.position,
        actors: anglers.map((player) => ({
          id: player.id,
          position: player.position.toArray(),
          gathering: f.resources.isPlayerGatheringResource(
            player.id,
            f.resource.id,
          ),
        })),
        remaining: [...f.pending["pendingGathers"].values()].map((request) => ({
          playerId: request.playerId,
          target: request.targetShoreTile,
          movement: f.movement["playerStates"].get(request.playerId),
          obstructionReplan: f.movement["_pendingObstructionReplans"].get(
            request.playerId,
          ),
          deferredMove: f.movement["_pendingNonCombatMoves"].get(
            request.playerId,
          ),
        })),
      }),
    ).toBe(0);
    expect(f.pending["approachReservations"].size).toBe(0);
    for (const player of anglers)
      expect(
        f.resources.isPlayerGatheringResource(player.id, f.resource.id),
      ).toBe(true);
    expect(
      new Set(
        anglers.map((player) => {
          const tile = worldToTile(player.position.x, player.position.z);
          return `${tile.x},${tile.z}`;
        }),
      ).size,
    ).toBe(4);
  });
});

describe("real server spawn and both tile-movement support paths", () => {
  it("retains solid-floor height when a second agent is relocated out of an occupied lobby spawn", async () => {
    const { world, terrain, movement, packets } = await fixture();
    const y = resolvePlayerRootHeight(385, 374, terrain)!;
    const first = addPlayer(world, "occupied-support-first", [385, y, 374]);
    const second = addPlayer(world, "occupied-support-second", [385, y, 374]);
    movement.syncPlayerPosition(first.id, first.position);
    const relocated = movement.syncPlayerPosition(second.id, second.position);
    expect([relocated.x, relocated.z]).not.toEqual([385, 374]);
    expect(relocated.y).toBe(y);
    expect(second.position.y).toBe(first.position.y);
    expect(
      relocated.y - terrain.getHeightAt(relocated.x, relocated.z),
    ).toBeCloseTo(0.03, 12);
    expect(second.data.position).toEqual([relocated.x, y, relocated.z]);
    expect(packets).toContainEqual({
      name: "tileMovementEnd",
      data: expect.objectContaining({
        id: second.id,
        reason: "occupied_spawn_relocation",
        worldPos: [relocated.x, y, relocated.z],
      }),
    });
    expect(movement.syncPlayerPosition(second.id, second.position)).toEqual(
      relocated,
    );
  });
  it("grounds actual streaming duel spawn and fallback return without altering valid saved-position repair policy", async () => {
    const { world, terrain } = await fixture();
    const unexpectedMutation = (): never => {
      throw new Error("Support queries must not mutate a duel");
    };
    const orchestrator = new DuelOrchestrator(
      world,
      () => null,
      unexpectedMutation,
      () => new Map(),
      unexpectedMutation,
      unexpectedMutation,
      () => [],
      () => [],
    );
    const config = getDuelArenaConfig();
    const x = config.baseX + config.arenaWidth / 2,
      z = config.baseZ + config.arenaLength / 2;
    expect(orchestrator.getGroundedY(x, z, config.baseY)).toBe(
      resolvePlayerRootHeight(x, z, terrain),
    );
    expect(
      orchestrator.getGroundedY(x, z, config.baseY) - terrain.getHeightAt(x, z),
    ).toBeCloseTo(0.03, 12);
    for (const id of ["support-return-a", "support-return-b"]) {
      const fallback = orchestrator.getFallbackLobbyPosition(id);
      expect(fallback[1]).toBe(
        resolvePlayerRootHeight(fallback[0], fallback[2], terrain),
      );
      expect(orchestrator.sanitizeRestorePosition(null, id)).toEqual(fallback);
      const validSaved: [number, number, number] = [
        fallback[0],
        fallback[1] + 1,
        fallback[2],
      ];
      expect(orchestrator.sanitizeRestorePosition(validSaved, id)).toEqual(
        validSaved,
      );
    }
  });
  for (const mode of ["all-players", "single-player"] as const)
    for (const floorIndex of [0, 1]) {
      it(`${mode} uses the actual town-owned floor${floorIndex} with identical spawn and movement clearance`, async () => {
        const { world, terrain, buildings, movement, packets } =
          await fixture();
        const floor =
          buildings.getBuilding("support-building")!.floors[floorIndex];
        const id = `support-${mode}-${floorIndex}`;
        const player = addPlayer(world, id, [
          297.5,
          floor.elevation + 0.1,
          317.5,
        ]);
        buildings.updatePlayerBuildingState(
          id as EntityID,
          297,
          317,
          floor.elevation,
        );
        expect(buildings.getPlayerFloor(id as EntityID)).toBe(floorIndex);
        const service = new EmbeddedHyperiaService(
          world,
          id,
          "test-account",
          id,
        );
        const spawn = spawnHeight(service, [
          297.5,
          floor.elevation + 0.1,
          317.5,
        ]);
        expect(spawn[1]).toBe(floor.elevation + PLAYER_ROOT_CLEARANCE);
        player.position.fromArray(spawn);
        player.data.position = spawn;
        movement.syncPlayerPosition(id, player.position);
        expect(
          movement.movePlayerToward(
            id,
            { x: 298.5, y: spawn[1], z: 317.5 },
            false,
          ),
        ).toBe(true);
        if (mode === "all-players") movement.onTick(1);
        else movement.processPlayerTick(id, 1);
        expect(player.position.toArray()).toEqual([
          298.5,
          floor.elevation + PLAYER_ROOT_CLEARANCE,
          317.5,
        ]);
        expect(player.data.position).toEqual(player.position.toArray());
        expect(player.position.y).toBe(
          resolvePlayerRootHeight(298.5, 317.5, terrain, buildings, floorIndex),
        );
        expect(packets.length).toBeGreaterThan(0);
        // No first-step9cm drop, and stopping does not create another clearance.
        const before = player.position.y;
        if (mode === "all-players") movement.onTick(2);
        else movement.processPlayerTick(id, 2);
        expect(player.position.y).toBe(before);
      });
    }

  for (const mode of ["all-players", "single-player"] as const)
    it(`${mode} follows actual lobby solid top on the first step`, async () => {
      const { world, terrain, movement } = await fixture();
      const id = `lobby-${mode}`;
      const service = new EmbeddedHyperiaService(world, id, "test-account", id);
      const spawn = spawnHeight(service, [382.5, 100, 374.5]);
      const player = addPlayer(world, id, spawn);
      expect(spawn[1] - terrain.getHeightAt(spawn[0], spawn[2])).toBeCloseTo(
        0.03,
        12,
      );
      movement.syncPlayerPosition(id, player.position);
      expect(
        movement.movePlayerToward(
          id,
          { x: 383.5, y: spawn[1], z: 374.5 },
          false,
        ),
      ).toBe(true);
      if (mode === "all-players") movement.onTick(1);
      else movement.processPlayerTick(id, 1);
      expect(player.position.x).toBe(383.5);
      expect(player.position.y).toBeCloseTo(spawn[1], 12);
    });

  it("resolves the town-owned service in the actual movement wall predicate", async () => {
    const { world, buildings, movement } = await fixture();
    const id = "wall-support";
    const floor = buildings.getBuilding("support-building")!.floors[0];
    const wall = floor.wallSegments.find(
      (row) => !row.hasOpening && row.side === "west",
    )!;
    const start = {
      x: wall.tileX - 0.5,
      y: floor.elevation,
      z: wall.tileZ + 0.5,
    };
    const player = addPlayer(world, id, [start.x, start.y, start.z]);
    movement.syncPlayerPosition(id, player.position);
    // Exercise the actual production predicate; this isn't an always-true world.
    const internals = movement as unknown as {
      isTileWalkable(
        tile: { x: number; z: number },
        floor: number,
        from: { x: number; z: number },
        buildingId: string | null,
      ): boolean;
      getBuildingCollision(): BuildingCollisionService | null;
    };
    expect(internals.getBuildingCollision()).toBe(buildings);
    expect(
      internals.isTileWalkable(
        { x: wall.tileX, z: wall.tileZ },
        0,
        { x: wall.tileX - 1, z: wall.tileZ },
        null,
      ),
    ).toBe(false);
  });
});
