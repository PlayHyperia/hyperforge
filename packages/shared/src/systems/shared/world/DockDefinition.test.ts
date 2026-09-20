import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataManager } from "../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import type {
  CompactPondDockPlacement,
  CompactPondDocksManifest,
  WorldArea,
  WorldConfigManifest,
} from "../../../types/world/world-types";
import {
  COMPACT_POND_DOCK_DIMENSIONS,
  ISLAND_DOCKS,
  getCompactPondDockCoreBounds,
  getCompactPondDockDirection,
  getCompactPondDockSupportBounds,
  validateCompactPondDockBindings,
  validateCompactPondDocks,
} from "./DockDefinition";
import { LEGACY_TERRAIN_PROFILE_FIXTURE } from "./WorldTerrainProfile";

function candidate(): CompactPondDocksManifest {
  return {
    schemaVersion: 1,
    layoutId: "compact-pond-docks-v1",
    terrainProfileId: "compact-duel-island-v6",
    waterBodyId: "haven_pond_water",
    docks: [
      {
        id: "fishing-landing",
        x: 340.5,
        z: 308,
        rotation: 0,
        recipeId: "haven-fishing-landing-v1",
      },
      {
        id: "reed-jetty",
        x: 350,
        z: 300.5,
        rotation: 270,
        recipeId: "haven-reed-jetty-v1",
      },
    ],
  };
}

const admit = (value: unknown) =>
  validateCompactPondDocks(value, DataManager.getWorldTerrainProfile());

describe("Compact pond dock manifest admission", () => {
  it("preserves legacy empty placements and absent opt-in", () => {
    expect(ISLAND_DOCKS).toEqual([]);
    expect(admit(undefined)).toBeUndefined();
    expect(validateCompactPondDockBindings(undefined, {})).toBeUndefined();
  });

  it("copies and deeply freezes admitted descriptors", () => {
    const input = candidate();
    const layout = admit(input)!;
    expect(layout).toEqual(input);
    expect(layout).not.toBe(input);
    expect(layout.docks[0]).not.toBe(input.docks[0]);
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.docks)).toBe(true);
    expect(layout.docks.every(Object.isFrozen)).toBe(true);
    Object.assign(input.docks[0], { x: 400.5 });
    expect(layout.docks[0].x).toBe(340.5);
    expect(() => Object.assign(layout.docks[0], { x: 1 })).toThrow();
  });

  it.each([
    [
      0,
      340.5,
      308,
      { x: 0, z: -1 },
      [339, 342, 302, 308],
      [339, 342, 302, 310],
    ],
    [
      90,
      340,
      308.5,
      { x: 1, z: 0 },
      [340, 346, 307, 310],
      [338, 346, 307, 310],
    ],
    [
      180,
      340.5,
      308,
      { x: 0, z: 1 },
      [339, 342, 308, 314],
      [339, 342, 306, 314],
    ],
    [
      270,
      340,
      308.5,
      { x: -1, z: 0 },
      [334, 340, 307, 310],
      [334, 342, 307, 310],
    ],
  ] as const)(
    "owns exactly 18 core and 24 support tiles for compass %s",
    (rotation, x, z, direction, coreValues, supportValues) => {
      const dock: CompactPondDockPlacement = {
        ...candidate().docks[0],
        x,
        z,
        rotation,
      };
      expect(getCompactPondDockDirection(rotation)).toEqual(direction);
      const core = getCompactPondDockCoreBounds(dock);
      const support = getCompactPondDockSupportBounds(dock);
      expect(Object.values(core)).toEqual(coreValues);
      expect(Object.values(support)).toEqual(supportValues);
      for (const bounds of [core, support]) {
        expect(Object.values(bounds).every(Number.isInteger)).toBe(true);
        expect(Object.isFrozen(bounds)).toBe(true);
      }
      expect((core.maxX - core.minX) * (core.maxZ - core.minZ)).toBe(18);
      expect(
        (support.maxX - support.minX) * (support.maxZ - support.minZ),
      ).toBe(24);
      expect(COMPACT_POND_DOCK_DIMENSIONS).toEqual({
        width: 3,
        length: 6,
        landingLength: 2,
      });
    },
  );

  it.each<[string, unknown]>([
    ["schemaVersion", 2],
    ["layoutId", "unknown"],
    ["terrainProfileId", "compact-duel-island-v5"],
    ["waterBodyId", ""],
    ["waterBodyId", "Not Valid"],
    ["extra", true],
    ["docks", []],
    ["docks", null],
  ])("rejects invalid layout field %s=%s", (key, value) => {
    expect(() => admit({ ...candidate(), [key]: value })).toThrow();
  });

  it.each<[string, unknown]>([
    ["id", ""],
    ["id", "INVALID"],
    ["rotation", 45],
    ["rotation", "90"],
    ["x", 340],
    ["z", 308.5],
    ["x", Infinity],
    ["x", NaN],
    ["recipeId", "unknown"],
    ["width", 3],
  ])("rejects invalid placement field %s=%s", (key, value) => {
    const layout = candidate();
    Object.assign(layout.docks[0], { [key]: value });
    expect(() => admit(layout)).toThrow();
  });

  it("requires two distinct ids and exactly one of each recipe", () => {
    for (const key of ["id", "recipeId"] as const) {
      const layout = candidate();
      Object.assign(layout.docks[1], { [key]: layout.docks[0][key] });
      expect(() => admit(layout)).toThrow("duplicate");
    }
    expect(() =>
      admit({ ...candidate(), docks: candidate().docks.slice(0, 1) }),
    ).toThrow();
    expect(() =>
      admit({
        ...candidate(),
        docks: [...candidate().docks, candidate().docks[0]],
      }),
    ).toThrow();
  });

  it("rejects overlapping or touching approaches, even when core decks are separate", () => {
    const layout = candidate();
    Object.assign(layout.docks[1], { x: 340.5, z: 312, rotation: 180 });
    // First support reaches z=310; second approach starts at z=310.
    expect(() => admit(layout)).toThrow("overlap or touch");
    Object.assign(layout.docks[1], { z: 311 });
    expect(() => admit(layout)).toThrow("overlap or touch");
    Object.assign(layout.docks[1], { z: 313 });
    expect(admit(layout)).toBeDefined();
  });

  it("keeps the full landing inside profile bounds, not only the water deck", () => {
    const profile = DataManager.getWorldTerrainProfile();
    const layout = candidate();
    Object.assign(layout.docks[0], {
      x: profile.bounds.minX + 1.5,
      z: profile.bounds.maxZ - 1,
    });
    expect(() => admit(layout)).toThrow("landing or deck");
    expect(() =>
      validateCompactPondDocks(candidate(), LEGACY_TERRAIN_PROFILE_FIXTURE),
    ).toThrow("profile or layout");
  });

  it("rejects accessors, prototypes, sparse arrays, symbols and hidden fields before copying", () => {
    let reads = 0;
    const accessor = candidate();
    Object.defineProperty(accessor.docks[0], "x", {
      enumerable: true,
      get() {
        reads++;
        return 340.5;
      },
    });
    expect(() => admit(accessor)).toThrow("accessors");
    expect(reads).toBe(0);
    const prototype = candidate();
    Object.setPrototypeOf(prototype.docks[0], { inherited: 1 });
    expect(() => admit(prototype)).toThrow("plain JSON");
    const sparse = candidate();
    delete (sparse.docks as CompactPondDockPlacement[])[0];
    expect(() => admit(sparse)).toThrow();
    const symbol = candidate();
    Object.defineProperty(symbol, Symbol("hidden"), { value: true });
    expect(() => admit(symbol)).toThrow();
    const hidden = candidate();
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => admit(hidden)).toThrow();
  });

  it("binds the real authored explicit water record without borrowing its mutable object", () => {
    const body = validateCompactPondDockBindings(
      admit(candidate()),
      ALL_WORLD_AREAS,
    )!;
    const source = Object.values(ALL_WORLD_AREAS)
      .flatMap((area) => area.waterBodies ?? [])
      .find((row) => row.id === body.id)!;
    expect(body).toEqual(source);
    expect(body).not.toBe(source);
    expect(Object.isFrozen(body)).toBe(true);
  });

  it("rejects missing, ambiguous, distant and nonfinite bound basins", () => {
    const layout = admit(candidate())!;
    const area = Object.values(ALL_WORLD_AREAS).find((row) =>
      row.waterBodies?.some((body) => body.id === layout.waterBodyId),
    )!;
    const body = area.waterBodies!.find(
      (row) => row.id === layout.waterBodyId,
    )!;
    const withBody = (value: typeof body): Record<string, WorldArea> => ({
      pond: { ...area, waterBodies: [value] },
    });
    expect(() => validateCompactPondDockBindings(layout, {})).toThrow(
      "missing or ambiguous",
    );
    expect(() =>
      validateCompactPondDockBindings(layout, {
        ...withBody(body),
        duplicate: { ...area, waterBodies: [body] },
      }),
    ).toThrow("missing or ambiguous");
    for (const radius of [0, -1, 32.01])
      expect(() =>
        validateCompactPondDockBindings(layout, withBody({ ...body, radius })),
      ).toThrow("bounded");
    expect(() =>
      validateCompactPondDockBindings(
        layout,
        withBody({ ...body, surfaceY: NaN }),
      ),
    ).toThrow();
    expect(() =>
      validateCompactPondDockBindings(
        layout,
        withBody({ ...body, centerX: 500 }),
      ),
    ).toThrow("does not intersect");
  });

  it("DataManager rejects malformed optional docks before publishing configuration", () => {
    const config = DataManager.getWorldConfig()!;
    const identity = DataManager.getWorldContentIdentity();
    expect(() =>
      DataManager.setWorldConfig({
        ...structuredClone(config),
        compactPondDocks: { ...candidate(), docks: [] },
      }),
    ).toThrow("compactPondDocks");
    expect(DataManager.getWorldConfig()).toBe(config);
    expect(DataManager.getWorldContentIdentity()).toBe(identity);
  });
});

describe("Compact pond docks mandatory real-filesystem startup binding", () => {
  const savedEnv = {
    ASSETS_DIR: process.env.ASSETS_DIR,
    NODE_ENV: process.env.NODE_ENV,
    SKIP_VALIDATION: process.env.SKIP_VALIDATION,
  };
  let temporaryRoot: string | undefined;
  const freshManager = () => Reflect.construct(DataManager, []) as DataManager;
  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await freshManager().initialize();
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("cannot skip a missing water binding; corrected startup admits immutable docks", async () => {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "hyperia-pond-dock-admission-"),
    );
    const assets = path.join(temporaryRoot, "packages/server/world/assets");
    const manifests = path.join(assets, "manifests");
    const source = fileURLToPath(
      new URL("../../../../../server/world/assets/manifests/", import.meta.url),
    );
    await cp(source, manifests, { recursive: true });
    const configPath = path.join(manifests, "world-config.json");
    const config = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as WorldConfigManifest;
    config.compactPondDocks = { ...candidate(), waterBodyId: "missing_pond" };
    await writeFile(configPath, JSON.stringify(config));
    process.env.ASSETS_DIR = assets;
    process.env.NODE_ENV = "test";
    process.env.SKIP_VALIDATION = "true";
    const manager = freshManager();
    await expect(manager.initialize()).rejects.toThrow(
      "water binding is missing or ambiguous",
    );
    expect(manager.isReady()).toBe(false);
    expect(DataManager.getWorldConfig()).toBeNull();
    expect(() => DataManager.getWorldContentIdentity()).toThrow(
      "not initialized",
    );
    config.compactPondDocks = candidate();
    await writeFile(configPath, JSON.stringify(config));
    await manager.initialize();
    expect(manager.isReady()).toBe(true);
    expect(DataManager.getWorldConfig()!.compactPondDocks).toEqual(candidate());
    expect(
      Object.isFrozen(DataManager.getWorldConfig()!.compactPondDocks!.docks[0]),
    ).toBe(true);
    expect(DataManager.getWorldContentIdentity()).toMatch(/^[0-9a-f]{64}$/);
  });
});
