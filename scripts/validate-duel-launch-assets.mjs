#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateLaunchWorldAreaSafety } from "./lib/launch-world-area-safety.mjs";
import {
  readLaunchAssetByteEvidence,
  resolveLaunchAssetReadTimeoutMs,
} from "./lib/launch-asset-byte-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const assetsRoot = path.resolve(
  process.env.ASSETS_DIR ||
    path.join(workspaceRoot, "packages/server/world/assets"),
);
const manifestsRoot = path.join(assetsRoot, "manifests");
const failures = [];
const assetByteEvidence = new Map();
const assetReadTimeoutMs = resolveLaunchAssetReadTimeoutMs(
  process.env.DUEL_ASSET_READ_TIMEOUT_MS,
);
let assetReadTimedOut = false;

const essentialDuelAssetUrls = [
  "asset://avatars/duel-candidates/duel-steve.vrm",
  "asset://avatars/duel-candidates/duel-steve_lod1.vrm",
  "asset://avatars/duel-candidates/duel-steve_lod2.vrm",
  "asset://emotes/emote-idle.glb",
  "asset://emotes/emote-walk.glb",
  "asset://emotes/emote-run.glb",
  "asset://emotes/emote-bow-duel-idle-steve.glb",
  "asset://emotes/emote-bow-duel-walk-steve.glb",
  "asset://emotes/emote-bow-duel-run-steve.glb",
  "asset://emotes/emote-one-hand-idle-steve.glb",
  "asset://emotes/emote-one-hand-walk-steve.glb",
  "asset://emotes/emote-one-hand-run-steve.glb",
  "asset://emotes/emote-2h-duel-idle-steve.glb",
  "asset://emotes/emote-2h-duel-walk-steve.glb",
  "asset://emotes/emote-2h-duel-run-steve.glb",
  "asset://emotes/emote-2h-duel-slash-steve.glb",
  "asset://emotes/emote-float.glb",
  "asset://emotes/emote-fall.glb",
  "asset://emotes/emote-flip.glb",
  "asset://emotes/emote-talk.glb",
  "asset://emotes/emote-punching.glb",
  "asset://emotes/emote_sword_swing.glb",
  "asset://emotes/emote-2h-idle.glb",
  "asset://emotes/emote-2h-slash.glb",
  "asset://emotes/emote-range.glb",
  "asset://emotes/emote-spell-cast.glb",
  "asset://emotes/emote-steve-woodcutting.glb",
  "asset://emotes/emote-steve-mining.glb",
  "asset://emotes/emote-steve-fishing-cast.glb",
  "asset://emotes/emote-harpoon-water-strike.glb",
  "asset://emotes/emote-steve-small-fishing-net-release.glb",
  "asset://emotes/emote-steve-fishing-retrieve.glb",
  "asset://emotes/emote-steve-lobster-pot-deploy.glb",
  "asset://emotes/emote-death.glb",
  "asset://emotes/emote-squat.glb",
  "asset://emotes/emote-waving-both-hands.glb",
  "asset://emotes/emote-dance-happy.glb",
  "asset://textures/terrain-biomes/grass.png",
  "asset://textures/terrain-biomes/dirt.png",
  "asset://textures/terrain-biomes/cliff.png",
  "asset://textures/terrain-biomes/desertGrass.png",
  "asset://textures/terrain-biomes/desertDirt.png",
  "asset://textures/terrain-biomes/snowgrass.png",
  "asset://textures/terrain-biomes/snowdirt.png",
];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  const absolutePath = path.join(manifestsRoot, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    fail(`${relativePath} is missing or is not a regular file`);
    return null;
  }
  if (!readAssetEvidence(relativePath, relativePath, absolutePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(
      `${relativePath} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function readWorkspaceJson(relativePath) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    fail(`${relativePath} is missing or is not a regular file`);
    return null;
  }
  if (!readAssetEvidence(relativePath, relativePath, absolutePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(
      `${relativePath} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAssetEvidence(location, value, absolutePath) {
  if (assetReadTimedOut) return null;

  let result = assetByteEvidence.get(absolutePath);
  if (!result) {
    result = readLaunchAssetByteEvidence(absolutePath, {
      timeoutMs: assetReadTimeoutMs,
    });
    assetByteEvidence.set(absolutePath, result);
  }
  if (!result.ok) {
    fail(`${location} ${result.error}: ${value}`);
    if (result.timeout) assetReadTimedOut = true;
    return null;
  }
  return result.evidence;
}

function assertAssetUrl(location, value) {
  if (typeof value !== "string" || !value.startsWith("asset://")) {
    fail(`${location} must contain an asset:// URL`);
    return null;
  }

  const relativePath = value.slice("asset://".length);
  const absolutePath = path.resolve(assetsRoot, relativePath);
  if (
    absolutePath === assetsRoot ||
    !absolutePath.startsWith(`${assetsRoot}${path.sep}`)
  ) {
    fail(`${location} escapes the asset root: ${value}`);
    return null;
  }

  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    fail(`${location} references a missing asset: ${value}`);
    return null;
  }

  return readAssetEvidence(location, value, absolutePath);
}

function assertLockedAssetUrl(location, value, expectedSha256) {
  const evidence = assertAssetUrl(location, value);
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    fail(`${location} must declare a lowercase SHA-256 lock`);
    return;
  }
  if (evidence && evidence.sha256 !== expectedSha256) {
    fail(
      `${location} drifted from SHA-256 ${expectedSha256}; received ${evidence.sha256}`,
    );
  }
}

// The compact client and deployment preflight share one hash-locked kit.
// Exact known PNG bytes imply the authored dimensions/channels; browser loading
// additionally validates decode dimensions and explicit non-premultiplied upload.
const compactTerrainTextures = readWorkspaceJson(
  "packages/shared/src/data/compact-terrain-textures.json",
);
const compactTerrainKeys = ["grass", "dirt", "rock"].flatMap((layer) =>
  ["albedo-roughness", "normal-ao"].map((channels) => `${layer}-${channels}`),
);
if (
  !isRecord(compactTerrainTextures) ||
  Object.keys(compactTerrainTextures).sort().join("|") !==
    [...compactTerrainKeys].sort().join("|")
) {
  fail("Compact terrain texture contract must contain exactly six packed maps");
} else {
  for (const key of compactTerrainKeys) {
    assertLockedAssetUrl(
      `compact terrain ${key}`,
      `asset://terrain/textures/compact-pbr/${key}.png`,
      compactTerrainTextures[key],
    );
  }
}

const compactPondModels = readWorkspaceJson(
  "packages/shared/src/data/compact-pond-models.json",
);
const compactPondFiles = [
  "boulder",
  "flat_stone",
  "fern",
  "bush",
  "reed_clump",
].map((name) => `pond_${name}.glb`);
if (
  !isRecord(compactPondModels) ||
  Object.keys(compactPondModels).sort().join("|") !==
    [...compactPondFiles].sort().join("|")
) {
  fail("Compact pond model contract must contain exactly five models");
} else {
  for (const file of compactPondFiles) {
    assertLockedAssetUrl(
      `compact pond ${file}`,
      `asset://vegetation/compact-pond-v1/${file}`,
      compactPondModels[file],
    );
  }
}

const buildings = readJson("buildings.json");
if (
  !isRecord(buildings) ||
  typeof buildings.version !== "number" ||
  !Array.isArray(buildings.towns) ||
  !isRecord(buildings.buildingTypes) ||
  !isRecord(buildings.sizeDefinitions)
) {
  fail("buildings.json does not match the BuildingsManifest shape");
}

const worldConfig = readJson("world-config.json");
if (
  !isRecord(worldConfig) ||
  worldConfig.version !== 1 ||
  !isRecord(worldConfig.terrain) ||
  !isRecord(worldConfig.towns) ||
  !isRecord(worldConfig.roads)
) {
  fail("world-config.json does not contain the required launch sections");
} else {
  const terrainWater = worldConfig.terrain.waterThreshold;
  const townWater = worldConfig.towns.waterThreshold;
  if (terrainWater !== 16 || townWater !== terrainWater) {
    fail(
      `world-config water thresholds must match the authoritative terrain level (16); received terrain=${String(terrainWater)}, towns=${String(townWater)}`,
    );
  }
  if (worldConfig.roads.roadWidth !== 6) {
    fail(
      `world-config roads.roadWidth must match the authoritative terrain road width (6); received ${String(worldConfig.roads.roadWidth)}`,
    );
  }
}

const npcs = readJson("npcs.json");
const stationsDocument = readJson("stations.json");
const woodcutting = readJson("gathering/woodcutting.json");
const mining = readJson("gathering/mining.json");
const fishing = readJson("gathering/fishing.json");
const resourceItems = readJson("items/resources.json");
const stores = readJson("stores.json");
const worldAreas = readJson("world-areas.json");
const music = readJson("music.json");

if (!Array.isArray(music) || music.length === 0) {
  fail("music.json must contain at least one playable track");
} else {
  const musicIds = new Set();
  for (const [index, track] of music.entries()) {
    const location = `music.json[${index}]`;
    if (!isRecord(track) || typeof track.id !== "string" || !track.id) {
      fail(`${location} must declare a non-empty id`);
      continue;
    }
    if (musicIds.has(track.id)) {
      fail(`${location} duplicates track id ${track.id}`);
    }
    musicIds.add(track.id);
    assertAssetUrl(`${location}.path`, track.path);
  }
  for (const requiredCategory of ["intro", "normal", "combat"]) {
    if (!music.some((track) => track?.category === requiredCategory)) {
      fail(`music.json must contain a ${requiredCategory} track`);
    }
  }
}

for (const failure of validateLaunchWorldAreaSafety(worldAreas)) {
  fail(failure);
}

const npcIds = new Set(
  Array.isArray(npcs) ? npcs.map((npc) => npc?.id).filter(Boolean) : [],
);
const stationTypes = new Set(
  Array.isArray(stationsDocument?.stations)
    ? stationsDocument.stations.map((station) => station?.type).filter(Boolean)
    : [],
);
const gatheringResources = [
  ...(Array.isArray(woodcutting?.trees) ? woodcutting.trees : []),
  ...(Array.isArray(mining?.rocks) ? mining.rocks : []),
  ...(Array.isArray(fishing?.spots) ? fishing.spots : []),
];
const resourceIds = new Set(
  gatheringResources.map((resource) => resource?.id).filter(Boolean),
);
const gatheringResourcesById = new Map(
  gatheringResources
    .filter((resource) => typeof resource?.id === "string")
    .map((resource) => [resource.id, resource]),
);
const resourceItemIds = new Set(
  (Array.isArray(resourceItems) ? resourceItems : [])
    .map((item) => item?.id)
    .filter(Boolean),
);
const storeIds = new Set(
  (Array.isArray(stores) ? stores : [])
    .map((store) => store?.id)
    .filter(Boolean),
);
if (!Array.isArray(stores)) {
  fail("stores.json must contain an array of store definitions");
}
if (Array.isArray(stores) && storeIds.size !== stores.length) {
  fail("stores.json must assign every store a unique, non-empty ID");
}
const storesById = new Map(
  (Array.isArray(stores) ? stores : [])
    .filter((store) => typeof store?.id === "string")
    .map((store) => [store.id, store]),
);

const areaGroups = [
  "starterTowns",
  "level1Areas",
  "level2Areas",
  "level3Areas",
  "specialAreas",
];
const areas = [];
for (const groupName of areaGroups) {
  const group = worldAreas?.[groupName];
  if (!isRecord(group)) {
    fail(`world-areas.json.${groupName} must be an object`);
    continue;
  }
  areas.push(...Object.values(group));
}

const waterBodyIds = new Set();
for (const area of areas) {
  const areaId = area?.id || "unknown-area";
  const bounds = area?.bounds;
  const boundValues = [bounds?.minX, bounds?.maxX, bounds?.minZ, bounds?.maxZ];
  const validBounds =
    isRecord(bounds) &&
    boundValues.every((value) => Number.isFinite(value)) &&
    bounds.minX < bounds.maxX &&
    bounds.minZ < bounds.maxZ;
  if (!validBounds) {
    fail(`${areaId} must define finite, ordered X/Z bounds`);
  }

  const assertInsideArea = (
    location,
    position,
    halfWidth = 0,
    halfDepth = halfWidth,
  ) => {
    if (
      !isRecord(position) ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.z)
    ) {
      fail(`${location} must define a finite X/Z position`);
      return;
    }
    if (
      validBounds &&
      (position.x - halfWidth < bounds.minX ||
        position.x + halfWidth > bounds.maxX ||
        position.z - halfDepth < bounds.minZ ||
        position.z + halfDepth > bounds.maxZ)
    ) {
      const extent =
        halfWidth === halfDepth
          ? `radius ${halfWidth}`
          : `X/Z half-extents (${halfWidth}, ${halfDepth})`;
      fail(
        `${location} at (${position.x}, ${position.z}) with ${extent} falls outside ${areaId} bounds`,
      );
    }
  };

  for (const npc of Array.isArray(area?.npcs) ? area.npcs : []) {
    if (!npcIds.has(npc?.id)) {
      fail(`${areaId} references unknown NPC ${String(npc?.id)}`);
    }
    assertInsideArea(`${areaId} NPC ${String(npc?.id)}`, npc?.position);
    if (npc?.storeId && !storeIds.has(npc.storeId)) {
      fail(
        `${areaId} NPC ${String(npc?.id)} references unknown store ${String(npc.storeId)}`,
      );
    }
  }
  for (const resource of Array.isArray(area?.resources) ? area.resources : []) {
    if (!resourceIds.has(resource?.resourceId)) {
      fail(
        `${areaId} references unknown resource ${String(resource?.resourceId)}`,
      );
    }
    assertInsideArea(
      `${areaId} resource ${String(resource?.resourceId)}`,
      resource?.position,
    );
  }
  for (const station of Array.isArray(area?.stations) ? area.stations : []) {
    if (!stationTypes.has(station?.type)) {
      fail(
        `${areaId} references unknown station type ${String(station?.type)}`,
      );
    }
    assertInsideArea(
      `${areaId} station ${String(station?.id)}`,
      station?.position,
    );
  }
  for (const spawn of Array.isArray(area?.mobSpawns) ? area.mobSpawns : []) {
    const radius = Number.isFinite(spawn?.spawnRadius) ? spawn.spawnRadius : 0;
    assertInsideArea(
      `${areaId} mob spawn ${String(spawn?.mobId)}`,
      spawn?.position,
      radius,
    );
  }
  for (const zone of Array.isArray(area?.flatZones) ? area.flatZones : []) {
    if (
      typeof zone?.id !== "string" ||
      zone.id.length === 0 ||
      !Number.isFinite(zone?.centerX) ||
      !Number.isFinite(zone?.centerZ) ||
      !Number.isFinite(zone?.width) ||
      !Number.isFinite(zone?.depth) ||
      !Number.isFinite(zone?.blendRadius) ||
      zone.width <= 0 ||
      zone.depth <= 0 ||
      zone.blendRadius < 0
    ) {
      fail(`${areaId} contains an invalid flat zone ${String(zone?.id)}`);
      continue;
    }
    assertInsideArea(
      `${areaId} flat zone ${zone.id}`,
      { x: zone.centerX, z: zone.centerZ },
      zone.width / 2,
      zone.depth / 2,
    );
  }
  for (const body of Array.isArray(area?.waterBodies) ? area.waterBodies : []) {
    if (
      typeof body?.id !== "string" ||
      body.id.length === 0 ||
      !Number.isFinite(body?.centerX) ||
      !Number.isFinite(body?.centerZ) ||
      !Number.isFinite(body?.radius) ||
      !Number.isFinite(body?.surfaceY) ||
      body.radius <= 0
    ) {
      fail(`${areaId} contains an invalid water body ${String(body?.id)}`);
      continue;
    }
    if (waterBodyIds.has(body.id)) {
      fail(`world-areas.json contains duplicate water body ID ${body.id}`);
    }
    waterBodyIds.add(body.id);
    assertInsideArea(
      `${areaId} water body ${body.id}`,
      { x: body.centerX, z: body.centerZ },
      body.radius,
    );
  }
  if (area?.fishing?.enabled) {
    if (
      !Number.isSafeInteger(area.fishing.spotCount) ||
      area.fishing.spotCount <= 0 ||
      !Array.isArray(area.fishing.spotTypes) ||
      area.fishing.spotTypes.length === 0
    ) {
      fail(`${areaId} has an invalid dynamic fishing configuration`);
    }
    for (const spotType of area.fishing.spotTypes ?? []) {
      if (!resourceIds.has(spotType)) {
        fail(`${areaId} references unknown fishing spot ${String(spotType)}`);
      }
    }
  }
}

const duelArena = worldAreas?.specialAreas?.duel_arena;
if (!isRecord(duelArena)) {
  fail("world-areas.json is missing specialAreas.duel_arena");
} else {
  for (const field of ["npcs", "resources", "mobSpawns", "stations"]) {
    if (!Array.isArray(duelArena[field]) || duelArena[field].length !== 0) {
      fail(
        `duel_arena must not publish ${field}; launch preparation and banking are scheduler-owned`,
      );
    }
  }
}

const preparationHub = worldAreas?.starterTowns?.central_haven;
const preparationPond = worldAreas?.level1Areas?.haven_pond;
const preparationTraining =
  worldAreas?.level1Areas?.preparation_training_grounds;
const preparationAreas = [
  preparationHub,
  preparationPond,
  preparationTraining,
].filter(isRecord);
const requiredPreparationFishingSpots = [
  "fishing_spot_net",
  "fishing_spot_bait",
  "fishing_spot_fly",
  "fishing_spot_cage",
  "fishing_spot_harpoon",
];
for (const area of preparationAreas) {
  for (const placement of Array.isArray(area.resources) ? area.resources : []) {
    const resource = gatheringResourcesById.get(placement?.resourceId);
    for (const reward of Array.isArray(resource?.harvestYield)
      ? resource.harvestYield
      : []) {
      if (!resourceItemIds.has(reward?.itemId)) {
        fail(
          `${String(area.id)} resource ${String(placement?.resourceId)} yields undefined item ${String(reward?.itemId)}`,
        );
      }
    }
  }
}
if (!isRecord(preparationHub)) {
  fail("world-areas.json is missing starterTowns.central_haven");
} else {
  const bounds = preparationHub.bounds;
  const boundValues = [bounds?.minX, bounds?.maxX, bounds?.minZ, bounds?.maxZ];
  if (
    !isRecord(bounds) ||
    !boundValues.every((value) => Number.isFinite(value)) ||
    bounds.minX >= bounds.maxX ||
    bounds.minZ >= bounds.maxZ
  ) {
    fail("central_haven must define finite, ordered X/Z bounds");
  } else {
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    if (width > 48 || depth > 48) {
      fail(
        `central_haven must remain a compact service plaza (maximum 48x48); received ${width}x${depth}`,
      );
    }

    const assertPositionInsideHub = (location, position, radius = 0) => {
      if (
        !isRecord(position) ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.z)
      ) {
        fail(`${location} must define a finite X/Z position`);
        return;
      }
      if (
        position.x - radius < bounds.minX ||
        position.x + radius > bounds.maxX ||
        position.z - radius < bounds.minZ ||
        position.z + radius > bounds.maxZ
      ) {
        fail(
          `${location} at (${position.x}, ${position.z}) with radius ${radius} falls outside central_haven bounds`,
        );
      }
    };

    for (const npc of Array.isArray(preparationHub.npcs)
      ? preparationHub.npcs
      : []) {
      assertPositionInsideHub(
        `central_haven NPC ${String(npc?.id)}`,
        npc?.position,
      );
    }
    for (const resource of Array.isArray(preparationHub.resources)
      ? preparationHub.resources
      : []) {
      assertPositionInsideHub(
        `central_haven resource ${String(resource?.resourceId)}`,
        resource?.position,
      );
    }
    for (const station of Array.isArray(preparationHub.stations)
      ? preparationHub.stations
      : []) {
      assertPositionInsideHub(
        `central_haven station ${String(station?.id)}`,
        station?.position,
      );
    }
    for (const spawn of Array.isArray(preparationHub.mobSpawns)
      ? preparationHub.mobSpawns
      : []) {
      const radius = Number.isFinite(spawn?.spawnRadius)
        ? spawn.spawnRadius
        : 0;
      assertPositionInsideHub(
        `central_haven mob spawn ${String(spawn?.mobId)}`,
        spawn?.position,
        radius,
      );
    }
  }

  if (preparationHub.safeZone !== true) {
    fail("central_haven must remain a safe preparation hub");
  }
  if (
    !Array.isArray(preparationHub.mobSpawns) ||
    preparationHub.mobSpawns.length !== 0
  ) {
    fail("central_haven cannot declare training mobs inside its safe zone");
  }

  const hubStationTypes = new Set(
    preparationAreas
      .flatMap((area) => (Array.isArray(area.stations) ? area.stations : []))
      .map((station) => station?.type)
      .filter(Boolean),
  );
  for (const requiredStationType of [
    "bank",
    "furnace",
    "anvil",
    "altar",
    "range",
    "runecrafting_altar",
  ]) {
    if (!hubStationTypes.has(requiredStationType)) {
      fail(
        `central_haven is missing required preparation station type ${requiredStationType}`,
      );
    }
  }

  const hubStoreIds = new Set(
    (Array.isArray(preparationHub.npcs) ? preparationHub.npcs : [])
      .map((npc) => npc?.storeId)
      .filter(Boolean),
  );
  for (const requiredStoreId of [
    "general_store",
    "fishing_store",
    "sword_store",
    "magic_store",
    "range_store",
    "armor_store",
    "crafting_store",
  ]) {
    if (!hubStoreIds.has(requiredStoreId)) {
      fail(`central_haven is missing required store ${requiredStoreId}`);
    }
  }

  const spawnX = (bounds.minX + bounds.maxX) / 2;
  const spawnZ = (bounds.minZ + bounds.maxZ) / 2;
  const routeTargets = preparationAreas.flatMap((area) => [
    ...(Array.isArray(area.npcs) ? area.npcs : []).map((entry) => ({
      id: `NPC ${String(entry?.id)}`,
      position: entry?.position,
    })),
    ...(Array.isArray(area.resources) ? area.resources : []).map((entry) => ({
      id: `resource ${String(entry?.resourceId)}`,
      position: entry?.position,
    })),
    ...(Array.isArray(area.stations) ? area.stations : []).map((entry) => ({
      id: `station ${String(entry?.id)}`,
      position: entry?.position,
    })),
    ...(Array.isArray(area.mobSpawns) ? area.mobSpawns : []).map((entry) => ({
      id: `mob ${String(entry?.mobId)}`,
      position: entry?.position,
    })),
  ]);
  for (const target of routeTargets) {
    if (!isRecord(target.position)) continue;
    const distance = Math.max(
      Math.abs(target.position.x - spawnX),
      Math.abs(target.position.z - spawnZ),
    );
    if (distance > 32) {
      fail(
        `preparation ${target.id} is ${distance} tiles from spawn; launch targets must stay within the 32-tile open-grid route envelope`,
      );
    }
  }

  const requiredProvisioningInventory = {
    sword_store: ["bronze_shortsword"],
    general_store: ["bronze_hatchet", "bronze_pickaxe", "tinderbox"],
    fishing_store: ["small_fishing_net"],
    crafting_store: ["leather", "needle", "thread"],
  };
  for (const [storeId, requiredItems] of Object.entries(
    requiredProvisioningInventory,
  )) {
    const store = storesById.get(storeId);
    const inventoryIds = new Set(
      (Array.isArray(store?.items) ? store.items : [])
        .map((item) => item?.itemId ?? item?.id)
        .filter(Boolean),
    );
    for (const itemId of requiredItems) {
      if (!inventoryIds.has(itemId)) {
        fail(`${storeId} is missing agent provisioning item ${itemId}`);
      }
    }
  }
}

if (!isRecord(preparationPond)) {
  fail("world-areas.json is missing the compact haven_pond preparation area");
} else {
  if (preparationPond.safeZone !== true) {
    fail("haven_pond must remain safe while agents acquire food");
  }
  if (preparationPond.fishing?.enabled !== true) {
    fail("haven_pond must enable dynamic fishing");
  }
  if (
    !Array.isArray(preparationPond.waterBodies) ||
    preparationPond.waterBodies.length === 0
  ) {
    fail("haven_pond must define explicit water geometry for reliable fishing");
  }
  const pondFloor = (preparationPond.flatZones ?? []).find(
    (zone) => zone?.id === "haven_pond_floor",
  );
  const pondWater = (preparationPond.waterBodies ?? []).find(
    (body) => body?.id === "haven_pond_water",
  );
  const authoredFishingSpotIds = (preparationPond.resources ?? [])
    .filter((resource) => resource?.type === "fishing_spot")
    .map((resource) => resource?.resourceId);
  const dynamicFishingSpotIds = Array.isArray(
    preparationPond.fishing?.spotTypes,
  )
    ? preparationPond.fishing.spotTypes
    : [];
  const configuredFishingSpotIds = new Set([
    ...authoredFishingSpotIds,
    ...dynamicFishingSpotIds,
  ]);
  for (const requiredSpotId of requiredPreparationFishingSpots) {
    if (!configuredFishingSpotIds.has(requiredSpotId)) {
      fail(
        `haven_pond is missing preparation fishing method ${requiredSpotId}`,
      );
    }
  }
  if (
    preparationPond.fishing?.spotCount !== dynamicFishingSpotIds.length ||
    new Set(dynamicFishingSpotIds).size !== dynamicFishingSpotIds.length
  ) {
    fail(
      "haven_pond must assign one distinct dynamic spot type to every dynamic fishing spawn",
    );
  }
  if (
    !pondFloor ||
    !pondWater ||
    !Number.isFinite(pondFloor.height) ||
    pondFloor.height >= pondWater.surfaceY
  ) {
    fail("haven_pond floor must remain below its explicit water surface");
  }
  const radialPond = pondFloor?.radialPond;
  if (
    !isRecord(radialPond) ||
    ![
      radialPond.bedRadius,
      radialPond.bankInnerRadius,
      radialPond.bankOuterRadius,
      radialPond.bankHeight,
    ].every(Number.isFinite) ||
    radialPond.bedRadius <= 0 ||
    radialPond.bedRadius >= radialPond.bankInnerRadius ||
    radialPond.bankInnerRadius >= radialPond.bankOuterRadius ||
    radialPond.bankHeight <= pondWater?.surfaceY ||
    pondWater?.radius <= radialPond.bankInnerRadius ||
    pondWater?.radius >= radialPond.bankOuterRadius ||
    pondFloor?.blendRadius <= 0 ||
    pondFloor?.width <
      2 * (radialPond.bankOuterRadius + pondFloor.blendRadius) ||
    pondFloor?.depth < 2 * (radialPond.bankOuterRadius + pondFloor.blendRadius)
  ) {
    fail(
      "haven_pond must define a finite radial bed, visible shoreline, dry bank, and complete outer terrain blend",
    );
  }
  if (
    pondFloor?.centerX !== pondWater?.centerX ||
    pondFloor?.centerZ !== pondWater?.centerZ
  ) {
    fail("haven_pond floor and water must share the same authored center");
  }
}

if (!isRecord(preparationTraining)) {
  fail("world-areas.json is missing level1Areas.preparation_training_grounds");
} else {
  const width =
    preparationTraining.bounds.maxX - preparationTraining.bounds.minX;
  const depth =
    preparationTraining.bounds.maxZ - preparationTraining.bounds.minZ;
  if (width > 80 || depth > 80) {
    fail(
      `preparation_training_grounds must remain compact (maximum 80x80); received ${width}x${depth}`,
    );
  }
  if (
    preparationTraining.safeZone !== false ||
    preparationTraining.difficultyLevel <= 0
  ) {
    fail("preparation_training_grounds must permit real combat training");
  }
  if (
    !Array.isArray(preparationTraining.mobSpawns) ||
    preparationTraining.mobSpawns.length === 0
  ) {
    fail("preparation_training_grounds must declare training mobs");
  }
  let trainingMobCount = 0;
  for (const spawn of preparationTraining.mobSpawns ?? []) {
    trainingMobCount += Number.isSafeInteger(spawn?.maxCount)
      ? spawn.maxCount
      : 0;
    const closestToSpawn =
      Math.hypot(spawn.position.x, spawn.position.z) - spawn.spawnRadius;
    if (closestToSpawn <= 25) {
      fail(
        `training mob ${String(spawn.mobId)} intersects the 25-tile town safety radius and can be suppressed at runtime`,
      );
    }
  }
  if (trainingMobCount > 20) {
    fail(
      `preparation_training_grounds declares ${trainingMobCount} simultaneous mobs; launch cap is 20`,
    );
  }
}

const ammunition = readJson("items/ammunition.json");
const weapons = readJson("items/weapons.json");
const tools = readJson("items/tools.json");
const duelPresentation = readJson("duel-presentation-assets.json");
const bowDuelPresentation = readWorkspaceJson(
  "scripts/certified-bow-duel-presentation-asset-install.json",
);
const runeArrow = Array.isArray(ammunition)
  ? ammunition.find((item) => item?.id === "rune_arrow")
  : null;
for (const arrowId of ["bronze_arrow", "iron_arrow"]) {
  const arrow = Array.isArray(ammunition)
    ? ammunition.find((item) => item?.id === arrowId)
    : null;
  if (!arrow) {
    fail(`items/ammunition.json is missing ${arrowId}`);
    continue;
  }
  assertAssetUrl(`${arrowId}.modelPath`, arrow.modelPath);
  assertAssetUrl(`${arrowId}.equippedModelPath`, arrow.equippedModelPath);
  assertAssetUrl(`${arrowId}.iconPath`, arrow.iconPath);
}
if (!runeArrow) {
  fail("items/ammunition.json is missing rune_arrow");
} else {
  if (runeArrow.modelPath !== null || runeArrow.equippedModelPath !== null) {
    fail(
      "rune_arrow must explicitly disable inferred equipped models; ProjectileRenderer owns its in-flight geometry",
    );
  }
  assertAssetUrl("rune_arrow.iconPath", runeArrow.iconPath);
}

for (const weaponId of [
  "bronze_shortsword",
  "bronze_longsword",
  "bronze_scimitar",
  "shortbow",
  "magic_shortbow",
  "staff_of_air",
]) {
  const weapon = Array.isArray(weapons)
    ? weapons.find((item) => item?.id === weaponId)
    : null;
  if (!weapon) {
    fail(`items/weapons.json is missing ${weaponId}`);
    continue;
  }
  assertAssetUrl(`${weaponId}.modelPath`, weapon.modelPath);
  assertAssetUrl(`${weaponId}.equippedModelPath`, weapon.equippedModelPath);
  assertAssetUrl(`${weaponId}.iconPath`, weapon.iconPath);
}

const expectedBowDuelMotionIds = ["idle", "walk", "run"];
const expectedBowDuelWeaponIds = ["shortbow", "magic_shortbow"];
if (
  bowDuelPresentation?.schemaVersion !== 1 ||
  bowDuelPresentation.activationId !== "steve-bow-duel-natural-v1" ||
  bowDuelPresentation.avatarId !== "steve" ||
  bowDuelPresentation.candidateId !== "natural" ||
  JSON.stringify(bowDuelPresentation.weaponItemIds) !==
    JSON.stringify(expectedBowDuelWeaponIds) ||
  !Array.isArray(bowDuelPresentation.motions) ||
  bowDuelPresentation.motions.length !== expectedBowDuelMotionIds.length ||
  !Array.isArray(bowDuelPresentation.equipment) ||
  bowDuelPresentation.equipment.length !== expectedBowDuelWeaponIds.length
) {
  fail("certified bow-duel presentation authority is invalid");
} else {
  for (const [index, motion] of bowDuelPresentation.motions.entries()) {
    const motionId = expectedBowDuelMotionIds[index];
    const expectedAssetUrl = `asset://${motion.destinationPath}${
      motion.playbackSpeed === 1 ? "" : `?s=${motion.playbackSpeed}`
    }`;
    if (
      motion.id !== motionId ||
      motion.assetUrl !== expectedAssetUrl ||
      motion.destinationPath.includes("candidates")
    ) {
      fail(`${motionId} bow-duel motion is not canonical`);
      continue;
    }
    assertLockedAssetUrl(
      `steve-bow-duel-natural-v1.${motionId}`,
      `asset://${motion.destinationPath}`,
      motion.sha256,
    );
  }
  for (const [index, equipment] of bowDuelPresentation.equipment.entries()) {
    const itemId = expectedBowDuelWeaponIds[index];
    const weapon = Array.isArray(weapons)
      ? weapons.find((candidate) => candidate?.id === itemId)
      : null;
    const expectedAssetUrl = `asset://${equipment.activePath}`;
    if (
      equipment.itemId !== itemId ||
      weapon?.equippedModelPath !== expectedAssetUrl
    ) {
      fail(`${itemId} does not select its certified active bow fit`);
      continue;
    }
    assertLockedAssetUrl(
      `steve-bow-duel-natural-v1.${itemId}`,
      expectedAssetUrl,
      equipment.activeSha256,
    );
  }
}

const harpoon = Array.isArray(tools)
  ? tools.find((item) => item?.id === "harpoon")
  : null;
const presentationActivations = Array.isArray(duelPresentation?.activations)
  ? duelPresentation.activations
  : [];
const corePreparationFamilies = [
  {
    itemIds: [
      "bronze_hatchet",
      "iron_hatchet",
      "steel_hatchet",
      "mithril_hatchet",
      "adamant_hatchet",
      "rune_hatchet",
    ],
    bodyEmoteKey: "chopping",
    motionAssetUrl: "asset://emotes/emote-steve-woodcutting.glb",
    rollbackBodyEmotePath: "asset://emotes/emote_chopping.glb",
  },
  {
    itemIds: [
      "bronze_pickaxe",
      "iron_pickaxe",
      "steel_pickaxe",
      "mithril_pickaxe",
      "adamant_pickaxe",
      "rune_pickaxe",
    ],
    bodyEmoteKey: "mining",
    motionAssetUrl: "asset://emotes/emote-steve-mining.glb",
    rollbackBodyEmotePath: "asset://emotes/emote_chopping.glb",
  },
  {
    itemIds: ["fishing_rod"],
    bodyEmoteKey: "fishing_rod",
    motionAssetUrl: "asset://emotes/emote-steve-fishing-cast.glb",
    rollbackBodyEmotePath: "asset://emotes/emote-fishing.glb",
  },
];
const fishingInteractionAuthorities = [
  {
    itemId: "fly_fishing_rod",
    bodyEmoteKey: "fly_fishing_rod",
    equipmentAssetUrl:
      "asset://models/tools/fishing-interactions/fly-fishing-rod-steve-fitted.glb",
    motionAssetUrl: "asset://emotes/emote-steve-fishing-cast.glb",
    durationSeconds: 1.933333,
    loopSeamExact: true,
  },
  {
    itemId: "small_fishing_net",
    bodyEmoteKey: "small_fishing_net",
    equipmentAssetUrl:
      "asset://models/tools/fishing-interactions/small-fishing-net-steve-fitted.glb",
    motionAssetUrl: "asset://emotes/emote-steve-small-fishing-net-release.glb",
    durationSeconds: 1.2,
    releaseSeconds: 0.78,
    retrievalAssetUrl: "asset://emotes/emote-steve-fishing-retrieve.glb",
    retrievalDurationSeconds: 1.2,
    pickupSeconds: 0.42,
    worldAssetUrl:
      "asset://models/tools/fishing-interactions/small-fishing-net-world.glb",
  },
  {
    itemId: "lobster_pot",
    bodyEmoteKey: "lobster_pot",
    equipmentAssetUrl:
      "asset://models/tools/fishing-interactions/lobster-pot-steve-fitted.glb",
    motionAssetUrl: "asset://emotes/emote-steve-lobster-pot-deploy.glb",
    durationSeconds: 1.2,
    releaseSeconds: 1.08,
    retrievalAssetUrl: "asset://emotes/emote-steve-fishing-retrieve.glb",
    retrievalDurationSeconds: 1.2,
    pickupSeconds: 0.42,
    worldAssetUrl:
      "asset://models/tools/fishing-interactions/lobster-pot-world.glb",
  },
];
const requiredPreparationActivationIds = new Set([
  "steve-harpoon-v1",
  ...corePreparationFamilies.flatMap((family) =>
    family.itemIds.map((itemId) => `steve-${itemId.replaceAll("_", "-")}-v1`),
  ),
  ...fishingInteractionAuthorities.map(
    ({ itemId }) => `steve-${itemId.replaceAll("_", "-")}-v1`,
  ),
]);
const harpoonActivation = presentationActivations.find(
  (activation) => activation?.activationId === "steve-harpoon-v1",
);
if (
  duelPresentation?.schemaVersion !== 1 ||
  presentationActivations.length !== requiredPreparationActivationIds.size ||
  new Set(presentationActivations.map((activation) => activation?.activationId))
    .size !== presentationActivations.length ||
  presentationActivations.some(
    (activation) =>
      !requiredPreparationActivationIds.has(activation?.activationId),
  ) ||
  !isRecord(harpoonActivation) ||
  harpoonActivation.state !== "active" ||
  harpoonActivation.avatarId !== "steve" ||
  harpoonActivation.itemId !== "harpoon" ||
  harpoonActivation.slot !== "gatheringtool" ||
  harpoonActivation.bodyEmoteKey !== "harpoon"
) {
  fail(
    `duel-presentation-assets.json must contain exactly the ${requiredPreparationActivationIds.size} certified Steve preparation authorities`,
  );
} else {
  if (
    harpoonActivation.motion?.durationSeconds !== 1.2 ||
    harpoonActivation.motion?.strikeSeconds !== 0.6 ||
    harpoonActivation.motion?.recoverySeconds !== 0.6
  ) {
    fail("steve-harpoon-v1 must match the two authoritative 600 ms phases");
  }
  if (
    harpoonActivation.rollback?.equippedModelPath !== null ||
    !isRecord(harpoonActivation.rollback?.equippedModelPathsByAvatar) ||
    Object.keys(harpoonActivation.rollback.equippedModelPathsByAvatar)
      .length !== 0 ||
    harpoonActivation.rollback?.bodyEmotePath !== null ||
    harpoonActivation.rollback?.removeInstalledAssets !== true
  ) {
    fail(
      "steve-harpoon-v1 must retain an exact fail-closed rollback projection",
    );
  }
  assertLockedAssetUrl(
    "steve-harpoon-v1.equipment",
    harpoonActivation.equipment?.assetUrl,
    harpoonActivation.equipment?.sha256,
  );
  assertLockedAssetUrl(
    "steve-harpoon-v1.motion",
    harpoonActivation.motion?.assetUrl,
    harpoonActivation.motion?.sha256,
  );
}

for (const family of corePreparationFamilies) {
  for (const itemId of family.itemIds) {
    const activationId = `steve-${itemId.replaceAll("_", "-")}-v1`;
    const activation = presentationActivations.find(
      (candidate) => candidate?.activationId === activationId,
    );
    const item = Array.isArray(tools)
      ? tools.find((candidate) => candidate?.id === itemId)
      : null;
    if (!item) {
      fail(`items/tools.json is missing ${itemId}`);
      continue;
    }
    if (
      !isRecord(activation) ||
      activation.activationGroupId !== "steve-core-preparation-v1" ||
      activation.state !== "active" ||
      activation.avatarId !== "steve" ||
      activation.itemId !== itemId ||
      activation.slot !== "gatheringtool" ||
      activation.bodyEmoteKey !== family.bodyEmoteKey ||
      activation.motion?.assetUrl !== family.motionAssetUrl ||
      !Number.isFinite(activation.motion?.durationSeconds) ||
      activation.motion.durationSeconds <= 0 ||
      activation.motion?.loopSeamExact !== true ||
      activation.rollback?.bodyEmotePath !== family.rollbackBodyEmotePath ||
      !isRecord(activation.rollback?.gatheringModelPathsByAvatar) ||
      Object.keys(activation.rollback.gatheringModelPathsByAvatar).length !==
        0 ||
      activation.rollback?.removeInstalledAssets !== true
    ) {
      fail(`${activationId} does not match its certified runtime authority`);
      continue;
    }
    const gatheringPaths = item.gatheringModelPathsByAvatar;
    if (
      !isRecord(gatheringPaths) ||
      Object.keys(gatheringPaths).length !== 1 ||
      gatheringPaths.steve !== activation.equipment?.assetUrl
    ) {
      fail(`${itemId} must select only its active exact Steve gathering fit`);
    }
    assertLockedAssetUrl(
      `${activationId}.equipment`,
      activation.equipment?.assetUrl,
      activation.equipment?.sha256,
    );
    assertLockedAssetUrl(
      `${activationId}.motion`,
      activation.motion?.assetUrl,
      activation.motion?.sha256,
    );
  }
}
for (const authority of fishingInteractionAuthorities) {
  const activationId = `steve-${authority.itemId.replaceAll("_", "-")}-v1`;
  const activation = presentationActivations.find(
    (candidate) => candidate?.activationId === activationId,
  );
  const item = Array.isArray(tools)
    ? tools.find((candidate) => candidate?.id === authority.itemId)
    : null;
  if (!item) {
    fail(`items/tools.json is missing ${authority.itemId}`);
    continue;
  }
  const hasDeploymentLifecycle = authority.retrievalAssetUrl !== undefined;
  const motionTiming = activation?.motion?.presentationTiming;
  const retrievalTiming = activation?.retrievalMotion?.presentationTiming;
  if (
    !isRecord(activation) ||
    activation.activationGroupId !== "steve-fishing-interactions-v1" ||
    activation.state !== "active" ||
    activation.avatarId !== "steve" ||
    activation.itemId !== authority.itemId ||
    activation.slot !== "gatheringtool" ||
    activation.bodyEmoteKey !== authority.bodyEmoteKey ||
    activation.equipment?.assetUrl !== authority.equipmentAssetUrl ||
    activation.motion?.assetUrl !== authority.motionAssetUrl ||
    Math.abs(
      Number(activation.motion?.durationSeconds) - authority.durationSeconds,
    ) > 0.000001 ||
    (authority.loopSeamExact === true &&
      activation.motion?.loopSeamExact !== true) ||
    (hasDeploymentLifecycle &&
      (!isRecord(motionTiming) ||
        motionTiming.durationSeconds !== authority.durationSeconds ||
        motionTiming.releaseSeconds !== authority.releaseSeconds ||
        activation.retrievalMotion?.assetUrl !== authority.retrievalAssetUrl ||
        activation.retrievalMotion?.durationSeconds !==
          authority.retrievalDurationSeconds ||
        !isRecord(retrievalTiming) ||
        retrievalTiming.durationSeconds !==
          authority.retrievalDurationSeconds ||
        retrievalTiming.pickupSeconds !== authority.pickupSeconds ||
        activation.worldModel?.assetUrl !== authority.worldAssetUrl)) ||
    (!hasDeploymentLifecycle &&
      (activation.retrievalMotion !== undefined ||
        activation.worldModel !== undefined)) ||
    !isRecord(activation.rollback?.gatheringModelPathsByAvatar) ||
    Object.keys(activation.rollback.gatheringModelPathsByAvatar).length !== 0 ||
    activation.rollback?.removeInstalledAssets !== true ||
    (hasDeploymentLifecycle && activation.rollback?.modelPath !== null)
  ) {
    fail(`${activationId} does not match its certified runtime authority`);
    continue;
  }
  const gatheringPaths = item.gatheringModelPathsByAvatar;
  if (
    item.equippedModelPath != null ||
    !isRecord(gatheringPaths) ||
    Object.keys(gatheringPaths).length !== 1 ||
    gatheringPaths.steve !== authority.equipmentAssetUrl
  ) {
    fail(
      `${authority.itemId} must select its active exact Steve gathering fit without a generic equipped override`,
    );
  }
  assertLockedAssetUrl(
    `${activationId}.equipment`,
    activation.equipment?.assetUrl,
    activation.equipment?.sha256,
  );
  assertLockedAssetUrl(
    `${activationId}.motion`,
    activation.motion?.assetUrl,
    activation.motion?.sha256,
  );
  if (hasDeploymentLifecycle) {
    assertLockedAssetUrl(
      `${activationId}.retrievalMotion`,
      activation.retrievalMotion?.assetUrl,
      activation.retrievalMotion?.sha256,
    );
    assertLockedAssetUrl(
      `${activationId}.worldModel`,
      activation.worldModel?.assetUrl,
      activation.worldModel?.sha256,
    );
  }
}
if (!harpoon) {
  fail("items/tools.json is missing harpoon");
} else if (harpoonActivation) {
  const fittedPaths = harpoon.equippedModelPathsByAvatar;
  if (
    harpoon.equippedModelPath !== null ||
    !isRecord(fittedPaths) ||
    Object.keys(fittedPaths).length !== 1 ||
    fittedPaths.steve !== harpoonActivation.equipment?.assetUrl
  ) {
    fail(
      "harpoon must fail closed by default and select only the active exact Steve fit",
    );
  }
}

for (const impactFile of [
  "sword-clash-001.mp3",
  "sword-clash-002.mp3",
  "sword-clash-003.mp3",
  "sword-clash-004.mp3",
  "sword-clash-005.mp3",
  "sword-clash-006.mp3",
]) {
  assertAssetUrl(
    `melee impact ${impactFile}`,
    `asset://audio/soundeffects/${impactFile}`,
  );
}

for (const assetUrl of essentialDuelAssetUrls) {
  assertAssetUrl(`essential duel asset ${assetUrl}`, assetUrl);
}

if (failures.length > 0) {
  console.error("Duel launch asset validation failed:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Duel launch asset validation passed: ${areas.length} areas, ${resourceIds.size} resources, ${npcIds.size} NPC definitions, ${stationTypes.size} station types.`,
  );
}
