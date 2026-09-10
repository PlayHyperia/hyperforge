import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DataManager,
  type ExternalResourceData,
  type WoodcuttingManifest,
} from "../DataManager";
import { ALL_WORLD_AREAS } from "../world-areas";
import { ALL_NPCS } from "../npcs";
import { BIOMES } from "../world-structure";
import { stationDataProvider } from "../StationDataProvider";
import {
  WORLD_IDENTITY_MANIFESTS,
  WorldManifestIdentityBuilder,
} from "../WorldContentIdentity";

// Real providers and filesystem only. Each attempt uses an isolated materialized
// copy of the current authored manifests; no network/loader/hash methods replaced.
const authoredManifests = fileURLToPath(
  new URL("../../../../server/world/assets/manifests/", import.meta.url),
);
const originalEnv = {
  ASSETS_DIR: process.env.ASSETS_DIR,
  NODE_ENV: process.env.NODE_ENV,
  SKIP_VALIDATION: process.env.SKIP_VALIDATION,
};
const freshManager = (): DataManager =>
  Reflect.construct(DataManager, []) as DataManager;
const resources = (): Map<string, ExternalResourceData> =>
  (globalThis as { EXTERNAL_RESOURCES: Map<string, ExternalResourceData> })
    .EXTERNAL_RESOURCES;

describe("DataManager real filesystem world identity", () => {
  let temporaryRoot: string;
  let manifests: string;
  let manager: DataManager;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "hyperia-world-identity-test-"),
    );
    const assets = path.join(temporaryRoot, "packages/server/world/assets");
    manifests = path.join(assets, "manifests");
    await cp(authoredManifests, manifests, { recursive: true });
    process.env.ASSETS_DIR = assets;
    process.env.NODE_ENV = "test";
    process.env.SKIP_VALIDATION = "true";
    manager = freshManager();
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // Restore real shared registries before deleting this test's owned fixture.
    await freshManager().initialize();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("shares an in-flight startup promise and hashes the actual consumed files", async () => {
    const first = manager.initialize();
    const second = manager.initialize();
    expect(second).toBe(first);
    expect(() => DataManager.getWorldContentIdentity()).toThrow(
      "not initialized",
    );
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(manager.isReady()).toBe(true);
    const expected = new WorldManifestIdentityBuilder();
    for (const name of WORLD_IDENTITY_MANIFESTS)
      expected.record(
        name,
        JSON.parse(await readFile(path.join(manifests, name), "utf8")),
      );
    expect(DataManager.getWorldContentIdentity()).toBe(
      await expected.build(DataManager.getWorldTerrainProfile()),
    );
    expect(await manager.initialize()).toBe(a);
  });

  it("clears stale world, biome, NPC and gathering registries before loading", async () => {
    const stale = "identity_fixture_stale";
    ALL_WORLD_AREAS[stale] = {
      ...Object.values(ALL_WORLD_AREAS)[0],
      id: stale,
    };
    BIOMES[stale] = { ...Object.values(BIOMES)[0], id: stale };
    ALL_NPCS.set(stale, { ...ALL_NPCS.values().next().value!, id: stale });
    resources().set(stale, {
      ...resources().values().next().value!,
      id: stale,
    });
    await manager.initialize();
    expect(ALL_WORLD_AREAS[stale]).toBeUndefined();
    expect(BIOMES[stale]).toBeUndefined();
    expect(ALL_NPCS.has(stale)).toBe(false);
    expect(resources().has(stale)).toBe(false);
    expect(stationDataProvider.getAllStationTypes().length).toBeGreaterThan(0);
  });

  it.each(["world-config.json", "stations.json", "gathering/woodcutting.json"])(
    "cannot bypass missing %s with test mode or SKIP_VALIDATION; retry is clean",
    async (name) => {
      const file = path.join(manifests, name);
      const original = await readFile(file);
      await rm(file);
      await expect(manager.initialize()).rejects.toThrow();
      expect(manager.isReady()).toBe(false);
      expect(() => DataManager.getWorldContentIdentity()).toThrow(
        "not initialized",
      );
      expect(Object.keys(ALL_WORLD_AREAS)).toHaveLength(0);
      expect(ALL_NPCS.size).toBe(0);
      expect(resources().size).toBe(0);
      expect(stationDataProvider.getAllStationTypes()).toHaveLength(0);
      await writeFile(file, original);
      await manager.initialize();
      const recoveredIdentity = DataManager.getWorldContentIdentity();
      await freshManager().initialize();
      expect(DataManager.getWorldContentIdentity()).toBe(recoveredIdentity);
    },
  );

  it("does not record a stations manifest whose real provider partially failed", async () => {
    const file = path.join(manifests, "stations.json");
    const original = JSON.parse(await readFile(file, "utf8")) as {
      stations: unknown[];
    };
    await writeFile(
      file,
      JSON.stringify({ stations: [original.stations[0], null] }),
    );
    await expect(manager.initialize()).rejects.toThrow("stations.json");
    expect(stationDataProvider.getAllStationTypes()).toHaveLength(0);
    expect(manager.isReady()).toBe(false);
  });

  it("hashes and consumes the actual local woodcutting override", async () => {
    await manager.initialize();
    const assetOnlyIdentity = DataManager.getWorldContentIdentity();
    const localDir = path.join(
      temporaryRoot,
      "packages/server/manifests/gathering",
    );
    await mkdir(localDir, { recursive: true });
    const wood = JSON.parse(
      await readFile(
        path.join(manifests, "gathering/woodcutting.json"),
        "utf8",
      ),
    ) as WoodcuttingManifest;
    wood.trees[0].scale = (wood.trees[0].scale ?? 1) + 0.25;
    await writeFile(
      path.join(localDir, "woodcutting.json"),
      JSON.stringify(wood),
    );
    await freshManager().initialize();
    expect(resources().get(wood.trees[0].id)?.scale).toBe(wood.trees[0].scale);
    expect(DataManager.getWorldContentIdentity()).not.toBe(assetOnlyIdentity);
  });

  it("records genuine buildings absence, but rejects malformed existing buildings", async () => {
    await manager.initialize();
    const present = DataManager.getWorldContentIdentity();
    const file = path.join(manifests, "buildings.json");
    await rm(file);
    await freshManager().initialize();
    expect(DataManager.getBuildingsManifest()).toBeNull();
    const absent = DataManager.getWorldContentIdentity();
    expect(absent).not.toBe(present);
    await freshManager().initialize();
    expect(DataManager.getWorldContentIdentity()).toBe(absent);
    await writeFile(file, "null");
    const invalid = freshManager();
    await expect(invalid.initialize()).rejects.toThrow("buildings.json");
    expect(invalid.isReady()).toBe(false);
    expect(() => DataManager.getWorldContentIdentity()).toThrow();
  });

  it("honors an explicit missing assets directory instead of using another checkout", async () => {
    process.env.ASSETS_DIR = path.join(temporaryRoot, "absent-assets");
    await expect(manager.initialize()).rejects.toThrow();
    expect(manager.isReady()).toBe(false);
    expect(() => DataManager.getWorldContentIdentity()).toThrow();
  });
});
