import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  defaultGenerator,
  createRng,
  type BuildingRecipe,
} from "@hyperforge/procgen/building";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { getDuelArenaSolidSurfaceHeight } from "../../../../data/arena-grading";
import {
  canonicalWorldJson,
  WORLD_IDENTITY_MANIFESTS,
  WorldManifestIdentityBuilder,
} from "../../../../data/WorldContentIdentity";
import { COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";
import { TerrainSystem } from "../TerrainSystem";
import { TownSystem } from "../TownSystem";
import {
  COMPACT_PREPARATION_LODGE,
  COMPACT_PREPARATION_LODGE_BUILDING_ID,
  createCompactPreparationLodgeLayout,
  getCompactPreparationLodgePlacement,
  validateCompactPreparationLodge,
} from "../CompactPreparationLodge";

// Independent retained report01.proposedLayoutRecipe used by the qualified
// report04 placement. This CPU test does not claim rendered roof/physics proof.
const QUALIFIED_RECIPE: BuildingRecipe = {
  label: "Bank",
  widthRange: [2, 2],
  depthRange: [2, 2],
  floors: 1,
  floorsRange: [1, 1],
  entranceCount: 1,
  archBias: 0.8,
  extraConnectionChance: 0.4,
  entranceArchChance: 0,
  roomSpanRange: [2, 2],
  minRoomArea: 4,
  minUpperFloorCells: 3,
  minUpperFloorShrinkCells: 2,
  windowChance: 0.35,
  patioDoorChance: 0,
  patioDoorCountRange: [1, 1],
  footprintStyle: "default",
  foyerDepthRange: [1, 2],
  foyerWidthRange: [1, 2],
  excludeFoyerFromUpper: true,
  upperInsetRange: [1, 2],
  upperCarveChance: 0.1,
  frontSide: "south",
  wallMaterial: "stone",
  foundationStepsRange: [2, 2],
  hasBasement: false,
  basementChance: 0.8,
  basementLevels: 1,
  basementCoverage: 0.7,
  carveChance: 0,
};
const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
  area: ALL_WORLD_AREAS.duel_arena,
};
const worlds: World[] = [];
beforeEach(() => {
  // Real startup admission, temporarily before identity finalization. No fake
  // loader, terrain, collision service, generator, renderer or World is used.
  DataManager["worldContentIdentity"] = null;
  const config = structuredClone(saved.config!);
  delete config.compactPreparationLodge;
  DataManager.setWorldConfig(config);
});
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
  ALL_WORLD_AREAS.duel_arena = saved.area;
});
const profile = () => DataManager.getWorldTerrainProfile();
const copy = () => structuredClone(COMPACT_PREPARATION_LODGE);
function admit() {
  DataManager.setWorldConfig({
    ...DataManager.getWorldConfig()!,
    compactPreparationLodge: copy(),
  });
}
class ServerWorld extends World {
  override get isServer() {
    return true;
  }
}
class ClientWorld extends World {
  override get isServer() {
    return false;
  }
  override get isClient() {
    return true;
  }
}
async function fixture(server = true) {
  admit();
  const world = server ? new ServerWorld() : new ClientWorld();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const towns = world.register("towns", TownSystem) as TownSystem;
  await terrain.init();
  await towns.init();
  return { world, terrain, towns };
}

describe("compact preparation lodge admission and actual shared collision ownership", () => {
  it("leaves absent descriptors absent and admits only a detached deeply frozen exact placement", () => {
    expect(
      validateCompactPreparationLodge(undefined, COMPACT_WORLD_TERRAIN_PROFILE),
    ).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        DataManager.getWorldConfig()!,
        "compactPreparationLodge",
      ),
    ).toBe(false);
    const input = copy(),
      result = validateCompactPreparationLodge(input, profile())!;
    expect(result).toEqual(COMPACT_PREPARATION_LODGE);
    expect(result).not.toBe(input);
    expect(result.position).not.toBe(input.position);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.position)).toBe(true);
    expect(() => Object.assign(result.position, { x: 0 })).toThrow();
    expect(() =>
      validateCompactPreparationLodge(input, COMPACT_WORLD_TERRAIN_PROFILE),
    ).toThrow("profile");
    expect(() =>
      validateCompactPreparationLodge(input, {
        ...profile(),
        bounds: { ...profile().bounds, maxX: 400 },
      }),
    ).toThrow("containment");
  });

  it.each([
    ["schema", { schemaVersion: 2 }],
    ["layout", { layoutId: "other" }],
    ["profile", { terrainProfileId: "compact-duel-island-v3" }],
    ["position", { position: { x: 397, z: 370 } }],
    ["rotation", { rotation: Math.PI / 2 }],
    ["seed", { layoutSeed: "compact-bank-lodge01:398,370:8x8:south" }],
    ["recipe", { recipeId: "bank" }],
    ["extra", { extra: true }],
    ["nested extra", { position: { x: 398, z: 370, y: 0 } }],
    ["nonfinite", { rotation: NaN }],
    ["huge", { extra: "x".repeat(2048) }],
  ])(
    "rejects unsupported %s without changing current admission",
    (_label, patch) => {
      const original = DataManager.getWorldConfig();
      const bad = Object.assign(copy(), patch);
      expect(() => validateCompactPreparationLodge(bad, profile())).toThrow();
      expect(() =>
        DataManager.setWorldConfig({
          ...original!,
          compactPreparationLodge: bad,
        }),
      ).toThrow();
      expect(DataManager.getWorldConfig()).toBe(original);
    },
  );

  it("rejects null, getters, cycles and symbols without executing caller code", () => {
    let calls = 0;
    const accessor = copy();
    Object.defineProperty(accessor, "layoutSeed", {
      enumerable: true,
      get() {
        calls++;
        return COMPACT_PREPARATION_LODGE.layoutSeed;
      },
    });
    const cycle = Object.assign(copy(), { nested: {} });
    cycle.nested = cycle;
    for (const bad of [
      null,
      accessor,
      cycle,
      Object.assign(copy(), { [Symbol("hidden")]: 1 }),
    ]) {
      expect(() => validateCompactPreparationLodge(bad, profile())).toThrow();
    }
    expect(calls).toBe(0);
  });

  it("changes the actual complete world identity and forbids adding/removing it after admission", async () => {
    const absent = structuredClone(DataManager.getWorldConfig()!);
    const identity = async (config: unknown) => {
      const builder = new WorldManifestIdentityBuilder();
      for (const name of WORLD_IDENTITY_MANIFESTS)
        builder.record(
          name,
          name === "world-config.json"
            ? config
            : JSON.parse(
                readFileSync(
                  new URL(
                    `../../../../../../server/world/assets/manifests/${name}`,
                    import.meta.url,
                  ),
                  "utf8",
                ),
              ),
        );
      return builder.build(profile());
    };
    const without = await identity(absent);
    admit();
    const present = DataManager.getWorldConfig()!;
    const withLodge = await identity(present);
    expect(withLodge).not.toBe(without);
    expect(Object.isFrozen(present.compactPreparationLodge!.position)).toBe(
      true,
    );
    DataManager["worldContentIdentity"] = withLodge;
    expect(() => DataManager.setWorldConfig(present)).not.toThrow();
    expect(() => DataManager.setWorldConfig(absent)).toThrow("fresh startup");
  });

  it("retains the exact qualified recipe/legacy RNG seed and solid platform Y", async () => {
    const expected = defaultGenerator.generateLayout(
      QUALIFIED_RECIPE,
      createRng("compact-bank-lodge01:360,318:8x8:south"),
    );
    const actual = await createCompactPreparationLodgeLayout(
      COMPACT_PREPARATION_LODGE,
      defaultGenerator,
    );
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({
      width: 2,
      depth: 2,
      floors: 1,
      foundationSteps: 2,
    });
    expect(actual.floorPlans).toHaveLength(1);
    const placement = getCompactPreparationLodgePlacement(
      COMPACT_PREPARATION_LODGE,
    );
    expect(placement).toEqual({
      x: 398,
      y: getDuelArenaSolidSurfaceHeight(398, 370),
      z: 370,
      rotation: 0,
    });
    expect(placement.y).toBeCloseTo(28.83930152309769, 10);
    expect(Object.isFrozen(placement)).toBe(true);
  });

  it.each([true, false])(
    "owns one shared actual layout/collision without generic towns or mesh work (server=%s)",
    async (server) => {
      const { world, terrain, towns } = await fixture(server);
      const zones = [...terrain["flatZones"]];
      const sceneChildren = [...world.stage.scene.children];
      expect(towns["townGenerator"]).toBeUndefined();
      expect(towns["buildingGenerator"]).toBeUndefined();
      await Promise.all([towns.start(), towns.start()]);
      const owner = towns.getCompactPreparationLodge()!;
      const service = towns.getCollisionService();
      expect(owner).not.toBeNull();
      expect(Object.isFrozen(owner)).toBe(true);
      expect(Object.isFrozen(owner.position)).toBe(true);
      expect(service.getBuildingCount()).toBe(1);
      expect(towns.getBuildingLayout(owner.buildingId)).toBe(owner.layout);
      expect([...towns.getAllBuildingLayouts().values()]).toEqual([
        owner.layout,
      ]);
      expect(towns.getTowns()).toEqual([]);
      expect(towns.getAllBuildingNPCSpawnPoints()).toEqual([]);
      expect([...terrain["flatZones"]]).toEqual(zones);
      expect(world.stage.scene.children).toEqual(sceneChildren);
      const collision = service.getBuilding(owner.buildingId)!;
      expect(collision.floors.map((floor) => floor.floorIndex)).toEqual([0]);
      expect(collision.worldPosition).toEqual(owner.position);
      await towns.init();
      await towns.start();
      expect(towns.getCompactPreparationLodge()).toBe(owner);
      expect(service.getBuildingCount()).toBe(1);
      towns.destroy();
      towns.destroy();
      expect(service.getBuildingCount()).toBe(0);
      expect(towns.getCompactPreparationLodge()).toBeNull();
      await expect(towns.start()).rejects.toThrow("initialization");
      await towns.init();
      await towns.start();
      expect(towns.getCollisionService().getBuildingCount()).toBe(1);
      expect(towns.getCompactPreparationLodge()).not.toBe(owner);
    },
  );

  it("does not publish or register a layout after destroy during its real async creation", async () => {
    const { towns } = await fixture();
    const service = towns.getCollisionService();
    const pending = towns.start();
    towns.destroy();
    await pending;
    expect(towns.getCompactPreparationLodge()).toBeNull();
    expect(service.getBuildingCount()).toBe(0);
    expect(towns.getAllBuildingLayouts().size).toBe(0);
    await towns.init();
    await towns.start();
    expect(service.getBuildingCount()).toBe(1);
  });

  it("fails closed without a real solid platform and creates no terrain fallback collision", async () => {
    const { towns } = await fixture();
    delete ALL_WORLD_AREAS.duel_arena;
    await expect(towns.start()).rejects.toThrow(
      "solid lobby platform is unavailable",
    );
    expect(towns.getCompactPreparationLodge()).toBeNull();
    expect(towns.getCollisionService().getBuildingCount()).toBe(0);
  });

  it("never replaces a foreign existing ID or unregisters its collision on failed start/destroy", async () => {
    const { towns } = await fixture();
    const service = towns.getCollisionService();
    const layout = await createCompactPreparationLodgeLayout(
      COMPACT_PREPARATION_LODGE,
      defaultGenerator,
    );
    const input = towns["convertLayoutToInput"](layout);
    service.registerBuilding(
      COMPACT_PREPARATION_LODGE_BUILDING_ID,
      "foreign",
      input,
      { x: 450, y: 20, z: 450 },
      0,
    );
    const foreign = service.getBuilding(COMPACT_PREPARATION_LODGE_BUILDING_ID);
    await expect(towns.start()).rejects.toThrow("already owned");
    towns.destroy();
    expect(service.getBuilding(COMPACT_PREPARATION_LODGE_BUILDING_ID)).toBe(
      foreign,
    );
    service.unregisterBuilding(COMPACT_PREPARATION_LODGE_BUILDING_ID);
  });

  it("does not unregister a newer same-ID collision after its own registration is replaced", async () => {
    const { towns } = await fixture();
    await towns.start();
    const owner = towns.getCompactPreparationLodge()!;
    const service = towns.getCollisionService();
    service.unregisterBuilding(owner.buildingId);
    service.registerBuilding(
      owner.buildingId,
      "replacement",
      towns["convertLayoutToInput"](owner.layout),
      { x: 450, y: 20, z: 450 },
      0,
    );
    const replacement = service.getBuilding(owner.buildingId);
    await expect(towns.start()).rejects.toThrow("ownership was replaced");
    towns.destroy();
    expect(service.getBuilding(owner.buildingId)).toBe(replacement);
    service.unregisterBuilding(owner.buildingId);
  });

  it("keeps the descriptor admission module's procgen imports type-only until layout creation", () => {
    const source = readFileSync(
      new URL("../CompactPreparationLodge.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /import type[\s\S]*?from "@hyperforge\/procgen\/building"/,
    );
    expect(
      source.match(/await import\("@hyperforge\/procgen\/building"\)/g),
    ).toHaveLength(1);
    expect(canonicalWorldJson(COMPACT_PREPARATION_LODGE).length).toBeLessThan(
      1024,
    );
  });
});
