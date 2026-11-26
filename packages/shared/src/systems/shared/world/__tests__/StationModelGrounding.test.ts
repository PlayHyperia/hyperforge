import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBounds, NodeIO } from "@gltf-transform/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import type {
  ModelBoundsManifest,
  StationsManifest,
} from "../../../../data/StationDataProvider";
import { STATION_GROUND_CLEARANCE } from "../../entities/StationSpawnerSystem";

const assets = new URL(
  "../../../../../../server/world/assets/",
  import.meta.url,
);
const manifest = JSON.parse(
  readFileSync(new URL("manifests/stations.json", assets), "utf8"),
) as StationsManifest;
const boundsManifest = JSON.parse(
  readFileSync(new URL("manifests/model-bounds.json", assets), "utf8"),
) as ModelBoundsManifest;
const areasManifest = JSON.parse(
  readFileSync(new URL("manifests/world-areas.json", assets), "utf8"),
) as Record<
  string,
  Record<
    string,
    { stations?: Array<{ type: string; position: { x: number; z: number } }> }
  >
>;
const actualStations = Object.values(areasManifest).flatMap((group) =>
  Object.values(group).flatMap((area) => area.stations ?? []),
);

describe("authored station model grounding", () => {
  it("covers every launch station family", () => {
    expect(manifest.stations.map((station) => station.type).sort()).toEqual([
      "altar",
      "anvil",
      "bank",
      "furnace",
      "range",
      "runecrafting_altar",
    ]);
  });

  for (const station of manifest.stations) {
    it(`grounds the actual ${station.type} GLB using its runtime scale, offset and entity clearance`, async () => {
      expect(station.model).toMatch(/^asset:\/\/models\/stations\//);
      const document = await new NodeIO().read(
        fileURLToPath(new URL(station.model!.slice("asset://".length), assets)),
      );
      const scene = document.getRoot().getDefaultScene();
      expect(scene).not.toBeNull();
      // Real GLB vertex data and node transforms, not a generated test model or
      // trusted bounding-box metadata. Static stations must remain unskinned.
      expect(document.getRoot().listSkins()).toHaveLength(0);
      expect(document.getRoot().listAnimations()).toHaveLength(0);
      const bounds = getBounds(scene!);
      expect(bounds.min.every(Number.isFinite)).toBe(true);
      expect(bounds.max.every(Number.isFinite)).toBe(true);
      const recorded = boundsManifest.models.find(
        (entry) => entry.assetPath === station.model,
      );
      expect(recorded).toBeDefined();
      for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
        expect(bounds.min[index]).toBeCloseTo(recorded!.bounds.min[axis], 6);
        expect(bounds.max[index]).toBeCloseTo(recorded!.bounds.max[axis], 6);
      }
      const baseAboveGround =
        bounds.min[1] * station.modelScale +
        station.modelYOffset +
        STATION_GROUND_CLEARANCE;
      expect(Math.abs(baseAboveGround)).toBeLessThanOrEqual(0.000001);
      // Mesh contact across its footprint still needs real rendered-terrain
      // verification; this test isolates the authored static-model origin.
    });
  }
});

describe("authored station grass-only clearance", () => {
  function loadActualData(): void {
    stationDataProvider.loadStations(structuredClone(manifest));
    stationDataProvider.loadModelBounds(structuredClone(boundsManifest));
  }

  beforeEach(loadActualData);
  afterEach(loadActualData);

  it("opts in only the furnace and anvil without changing their grading or collision data", () => {
    expect(
      manifest.stations
        .filter((station) => station.grassClearanceMargin !== undefined)
        .map((station) => station.type)
        .sort(),
    ).toEqual(["anvil", "furnace"]);
    const current = structuredClone(
      manifest.stations.map((station) =>
        stationDataProvider.getStationData(station.type),
      ),
    );
    const legacy = structuredClone(manifest);
    for (const station of legacy.stations) delete station.grassClearanceMargin;
    stationDataProvider.loadStations(legacy);
    for (const [index, station] of manifest.stations.entries()) {
      const withoutMargin = current[index]!;
      delete withoutMargin.grassClearanceMargin;
      expect(stationDataProvider.getStationData(station.type)).toEqual(
        withoutMargin,
      );
      expect(
        stationDataProvider.getGrassExclusionBounds(station.type, 335, 336),
      ).toBeUndefined();
      expect(
        Object.prototype.hasOwnProperty.call(
          stationDataProvider.getStationData(station.type)!,
          "grassClearanceMargin",
        ),
      ).toBe(false);
    }
    expect(
      stationDataProvider.getGrassExclusionBounds("unknown", 335, 336),
    ).toBeUndefined();
  });

  it("qualifies an input-only bank/range/altar clearance candidate against their actual GLBs without changing defaults or collision", async () => {
    const original = structuredClone(manifest);
    const candidate = structuredClone(manifest);
    const selected = new Set(["bank", "range", "altar"]);
    const previous = new Map(
      manifest.stations.map((station) => [
        station.type,
        structuredClone(stationDataProvider.getStationData(station.type)),
      ]),
    );
    const footprints = new Map(
      manifest.stations.map((station) => [
        station.type,
        structuredClone(stationDataProvider.getFootprint(station.type)),
      ]),
    );
    for (const station of candidate.stations) {
      if (!selected.has(station.type)) continue;
      expect(station.grassClearanceMargin).toBeUndefined();
      station.grassClearanceMargin = 1.25;
    }
    stationDataProvider.loadStations(candidate);
    for (const station of candidate.stations) {
      const runtime = structuredClone(
        stationDataProvider.getStationData(station.type)!,
      );
      expect(stationDataProvider.getFootprint(station.type)).toEqual(
        footprints.get(station.type),
      );
      if (!selected.has(station.type)) {
        expect(runtime).toEqual(previous.get(station.type));
        continue;
      }
      expect(runtime.grassClearanceMargin).toBe(1.25);
      delete runtime.grassClearanceMargin;
      expect(runtime).toEqual(previous.get(station.type));
      const placement = actualStations.find(
        (entry) => entry.type === station.type,
      )!;
      const { x, z } = placement.position;
      const document = await new NodeIO().read(
        fileURLToPath(new URL(station.model!.slice("asset://".length), assets)),
      );
      expect(document.getRoot().listSkins()).toHaveLength(0);
      expect(document.getRoot().listAnimations()).toHaveLength(0);
      const bounds = getBounds(document.getRoot().getDefaultScene()!);
      const resolved = stationDataProvider.getGrassExclusionBounds(
        station.type,
        x,
        z,
      )!;
      for (const [index, minKey, maxKey, pivot] of [
        [0, "minX", "maxX", x],
        [2, "minZ", "maxZ", z],
      ] as const) {
        expect(resolved[minKey]).toBe(
          pivot + bounds.min[index] * station.modelScale - 1.25,
        );
        expect(resolved[maxKey]).toBe(
          pivot + bounds.max[index] * station.modelScale + 1.25,
        );
        expect((resolved[minKey] + resolved[maxKey]) / 2).not.toBe(pivot);
      }
      expect(
        Math.abs(
          bounds.min[1] * station.modelScale +
            station.modelYOffset +
            STATION_GROUND_CLEARANCE,
        ),
      ).toBeLessThanOrEqual(0.000001);
    }
    // This is explicit input qualification, not a default manifest promotion.
    expect(manifest).toEqual(original);
    expect(
      JSON.parse(
        readFileSync(new URL("manifests/stations.json", assets), "utf8"),
      ),
    ).toEqual(original);
  });

  for (const station of manifest.stations.filter(
    (entry) => entry.grassClearanceMargin !== undefined,
  )) {
    it(`uses the actual ${station.type} GLB extents and world pivot, not rounded collision tiles`, async () => {
      const placement = actualStations.find(
        (entry) => entry.type === station.type,
      );
      expect(placement).toBeDefined();
      const { x, z } = placement!.position;
      const document = await new NodeIO().read(
        fileURLToPath(new URL(station.model!.slice("asset://".length), assets)),
      );
      const bounds = getBounds(document.getRoot().getDefaultScene()!);
      const resolved = stationDataProvider.getGrassExclusionBounds(
        station.type,
        x,
        z,
      )!;
      expect(station.grassClearanceMargin).toBe(1.25);
      for (const [index, minKey, maxKey, pivot] of [
        [0, "minX", "maxX", x],
        [2, "minZ", "maxZ", z],
      ] as const) {
        expect(resolved[minKey]).toBeCloseTo(
          pivot + bounds.min[index] * station.modelScale - 1.25,
          6,
        );
        expect(resolved[maxKey]).toBeCloseTo(
          pivot + bounds.max[index] * station.modelScale + 1.25,
          6,
        );
        // The authored meshes are slightly off-center: a dimension-only box
        // would silently erase their actual pivot offset.
        expect((resolved[minKey] + resolved[maxKey]) / 2).not.toBe(pivot);
      }
      const expected =
        station.type === "furnace"
          ? [
              332.6146410405636, 337.38228702545166, 333.6583015024662,
              338.3402434885502,
            ]
          : [
              336.2475669980049, 339.75392150878906, 334.46100148558617,
              337.53767850995064,
            ];
      for (const [index, key] of (
        ["minX", "maxX", "minZ", "maxZ"] as const
      ).entries()) {
        expect(resolved[key]).toBe(expected[index]);
      }
      const original = { ...resolved };
      resolved.minX = 0;
      expect(
        stationDataProvider.getGrassExclusionBounds(station.type, x, z),
      ).toEqual(original);
    });
  }

  it("allows stations-before-bounds loading but rejects resolution until real bounds arrive", () => {
    stationDataProvider.loadModelBounds({ ...boundsManifest, models: [] });
    expect(() => stationDataProvider.loadStations(manifest)).not.toThrow();
    expect(
      stationDataProvider.getStationData("furnace")?.grassClearanceMargin,
    ).toBe(1.25);
    expect(() =>
      stationDataProvider.getGrassExclusionBounds("furnace", 335, 336),
    ).toThrow(/finite, nonempty XZ model bounds/);
    stationDataProvider.loadModelBounds(boundsManifest);
    const resolved = stationDataProvider.getGrassExclusionBounds(
      "furnace",
      335,
      336,
    );
    stationDataProvider.loadStations(manifest);
    expect(
      stationDataProvider.getGrassExclusionBounds("furnace", 335, 336),
    ).toEqual(resolved);
  });

  it("accepts a zero margin as the exact scaled model extent", () => {
    const stations = structuredClone(manifest);
    const furnace = stations.stations.find(
      (station) => station.type === "furnace",
    )!;
    furnace.grassClearanceMargin = 0;
    stationDataProvider.loadStations(stations);
    const bounds = boundsManifest.models.find(
      (entry) => entry.assetPath === furnace.model,
    )!.bounds;
    expect(
      stationDataProvider.getGrassExclusionBounds("furnace", 335, 336),
    ).toEqual({
      minX: 335 + bounds.min.x * furnace.modelScale,
      maxX: 335 + bounds.max.x * furnace.modelScale,
      minZ: 336 + bounds.min.z * furnace.modelScale,
      maxZ: 336 + bounds.max.z * furnace.modelScale,
    });
  });

  it.each([-1, NaN, Infinity, -Infinity, "1.25", null])(
    "rejects invalid authored grass margin %s before replacing the live station table",
    (margin) => {
      const stations = structuredClone(manifest);
      const furnace = stations.stations.find(
        (station) => station.type === "furnace",
      )!;
      Reflect.set(furnace, "grassClearanceMargin", margin);
      const previous = stationDataProvider.getStationData("furnace");
      expect(() => stationDataProvider.loadStations(stations)).toThrow(
        /furnace: grassClearanceMargin must be a finite nonnegative number/,
      );
      expect(stationDataProvider.getStationData("furnace")).toBe(previous);
    },
  );

  it.each([0, -1, NaN, Infinity])(
    "rejects unusable model scale %s",
    (scale) => {
      const stations = structuredClone(manifest);
      stations.stations.find(
        (station) => station.type === "furnace",
      )!.modelScale = scale;
      stationDataProvider.loadStations(stations);
      expect(() =>
        stationDataProvider.getGrassExclusionBounds("furnace", 335, 336),
      ).toThrow(/model and positive finite modelScale/);
    },
  );

  it.each([null, "", "asset://models/missing.glb"])(
    "rejects unusable model %s without inventing a collision-footprint clearance",
    (model) => {
      const stations = structuredClone(manifest);
      stations.stations.find((station) => station.type === "furnace")!.model =
        model;
      stationDataProvider.loadStations(stations);
      expect(() =>
        stationDataProvider.getGrassExclusionBounds("furnace", 335, 336),
      ).toThrow(/grass clearance requires/);
    },
  );

  it.each(["nonfinite", "empty", "reversed", "missing-min"] as const)(
    "rejects %s raw XZ bounds",
    (invalid) => {
      const source = structuredClone(boundsManifest);
      const bounds = source.models.find(
        (entry) => entry.id === "stations/furnace",
      )!.bounds;
      if (invalid === "nonfinite") bounds.min.x = NaN;
      if (invalid === "empty") bounds.max.z = bounds.min.z;
      if (invalid === "reversed") bounds.min.x = bounds.max.x + 1;
      if (invalid === "missing-min") Reflect.deleteProperty(bounds, "min");
      stationDataProvider.loadModelBounds(source);
      expect(() =>
        stationDataProvider.getGrassExclusionBounds("furnace", 335, 336),
      ).toThrow(/finite, nonempty XZ model bounds/);
    },
  );

  it.each([
    [NaN, 336],
    [335, Infinity],
  ])("rejects nonfinite world position %s, %s", (x, z) => {
    expect(() =>
      stationDataProvider.getGrassExclusionBounds("furnace", x, z),
    ).toThrow(/finite world position/);
  });

  it("rejects overflowing or unrepresentable world bounds", () => {
    expect(() =>
      stationDataProvider.getGrassExclusionBounds(
        "furnace",
        Number.MAX_VALUE,
        336,
      ),
    ).toThrow(/cannot be represented/);
    const stations = structuredClone(manifest);
    stations.stations.find(
      (station) => station.type === "furnace",
    )!.modelScale = Number.MAX_VALUE;
    stationDataProvider.loadStations(stations);
    expect(() =>
      stationDataProvider.getGrassExclusionBounds(
        "furnace",
        Number.MAX_VALUE,
        336,
      ),
    ).toThrow(/cannot be represented/);
  });
});
