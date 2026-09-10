import { describe, it, expect } from "vitest";
import { DataManager, dataManager } from "../DataManager";
import { LEGACY_TERRAIN_PROFILE_FIXTURE } from "../../systems/shared/world/WorldTerrainProfile";
import type { WorldConfigManifest } from "../../types/world/world-types";

function copyConfig(): WorldConfigManifest {
  expect(dataManager.isReady()).toBe(true);
  return JSON.parse(
    JSON.stringify(DataManager.getWorldConfig()),
  ) as WorldConfigManifest;
}

describe("DataManager identified world configuration", () => {
  it("admits an identical copy without replacing the identified immutable configuration", () => {
    const previous = DataManager.getWorldConfig();
    const identity = DataManager.getWorldContentIdentity();
    const copy = copyConfig();
    DataManager.setWorldConfig(copy);
    expect(DataManager.getWorldConfig()).toBe(previous);
    expect(DataManager.getWorldContentIdentity()).toBe(identity);
    copy.towns.townCount++;
    expect(DataManager.getWorldConfig()!.towns.townCount).not.toBe(
      copy.towns.townCount,
    );
  });

  it("rejects mutation of returned nested configuration and profile", () => {
    expect(() => {
      DataManager.getWorldConfig()!.terrain.maxHeight = 99;
    }).toThrow();
    expect(() => {
      DataManager.getWorldTerrainProfile().island.radius = 99;
    }).toThrow();
  });

  it("rejects hot replacement even when the terrain fields themselves are compatible", () => {
    const config = copyConfig();
    config.towns.townCount++;
    expect(() => DataManager.setWorldConfig(config)).toThrow("fresh startup");
  });

  it("rejects null, omitted profile and the legacy numeric fixture", () => {
    expect(() =>
      DataManager.setWorldConfig(null as unknown as WorldConfigManifest),
    ).toThrow();
    const omitted = copyConfig();
    delete omitted.terrainProfile;
    expect(() => DataManager.setWorldConfig(omitted)).toThrow();
    expect(() =>
      DataManager.setWorldConfig({
        ...copyConfig(),
        terrainProfile: LEGACY_TERRAIN_PROFILE_FIXTURE,
      }),
    ).toThrow();
  });

  it.each(["tileSize", "worldSize", "maxHeight", "waterThreshold"] as const)(
    "rejects conflicting %s",
    (field) => {
      const config = copyConfig();
      config.terrain[field]++;
      expect(() => DataManager.setWorldConfig(config)).toThrow("conflicts");
    },
  );

  it("rejects a seed conflict and accessors without invoking them", () => {
    const config = copyConfig();
    config.seed = (config.seed ?? 0) + 1;
    expect(() => DataManager.setWorldConfig(config)).toThrow("conflicts");
    let reads = 0;
    Object.defineProperty(config, "terrainProfile", {
      enumerable: true,
      get: () => {
        reads++;
        throw new Error("must not run");
      },
    });
    expect(() => DataManager.setWorldConfig(config)).toThrow("accessors");
    expect(reads).toBe(0);
  });

  it.each([0, 1, 1.5, 257, "64", null, undefined, NaN, Infinity])(
    "rejects invalid startup tile resolution %s",
    (value) => {
      const config = copyConfig();
      Object.assign(config.terrain, { tileResolution: value });
      expect(() => DataManager.setWorldConfig(config)).toThrow();
    },
  );

  it("rejects malformed configuration containers and coerced world sizes", () => {
    for (const field of ["terrain", "towns", "roads"]) {
      expect(() =>
        DataManager.setWorldConfig({ ...copyConfig(), [field]: null }),
      ).toThrow("requires");
    }
    const config = copyConfig();
    Object.assign(config.terrain, { worldSize: "4" });
    expect(() => DataManager.setWorldConfig(config)).toThrow("integer");
  });

  it("protects the identified buildings manifest from mutation and replacement", () => {
    const buildings = DataManager.getBuildingsManifest();
    expect(buildings).not.toBeNull();
    const copy = JSON.parse(JSON.stringify(buildings)) as NonNullable<
      typeof buildings
    >;
    DataManager.setBuildingsManifest(copy);
    expect(DataManager.getBuildingsManifest()).toBe(buildings);
    expect(() => {
      buildings!.version++;
    }).toThrow();
    copy.version++;
    expect(() => DataManager.setBuildingsManifest(copy)).toThrow(
      "fresh startup",
    );
  });
});
