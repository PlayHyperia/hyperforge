import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { World } from "../../../../core/World";
import { ALL_WORLD_AREAS, type WorldArea } from "../../../../data/world-areas";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import type {
  FlatZone,
  RadialPondTerrainProfile,
} from "../../../../types/world/terrain";
import { TerrainSystem } from "../TerrainSystem";
import {
  COMPACT_PREPARATION_LODGE,
  getCompactPreparationLodgeFootprint,
} from "../CompactPreparationLodge";

type ManifestArea = WorldArea & {
  flatZones?: Array<{
    id: string;
    centerX: number;
    centerZ: number;
    width: number;
    depth: number;
    height?: number;
    heightOffset?: number;
    blendRadius: number;
    excludeGrass?: boolean;
    radialPond?: RadialPondTerrainProfile;
  }>;
};

type TerrainInternals = {
  initializeTerrainGenerator(): void;
  loadFlatZonesFromManifest(): void;
  getFlatZoneHeight(x: number, z: number): number | null;
  flatZones: Map<string, FlatZone>;
};

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../server/world/assets/manifests/world-areas.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, Record<string, ManifestArea>>;
const actualAreas = Object.assign({}, ...Object.values(manifest)) as Record<
  string,
  ManifestArea
>;
const haven = actualAreas.central_haven;
const originalAreas = Object.entries(ALL_WORLD_AREAS);

function installAreas(areas: Record<string, ManifestArea>): void {
  for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
  Object.assign(ALL_WORLD_AREAS, areas);
}

function terrainFor(areas: Record<string, ManifestArea>) {
  installAreas(areas);
  // Real World, generator, station provider, flat-zone resolver and default noise.
  // Do not start rendering/physics or replace height functions with test doubles.
  const world = Object.assign(new World(), { config: { terrainSeed: 0 } });
  const terrain = new TerrainSystem(world);
  const internals = terrain as unknown as TerrainInternals;
  internals.initializeTerrainGenerator();
  internals.loadFlatZonesFromManifest();
  return { terrain, internals };
}

function explicitOnly(areas: Record<string, ManifestArea>) {
  return Object.fromEntries(
    Object.entries(areas).map(([id, area]) => [id, { ...area, stations: [] }]),
  );
}

function padHeights(internals: TerrainInternals) {
  return [...internals.flatZones.values()]
    .filter((zone) => zone.id.startsWith("station_"))
    .map((zone) => [zone.id, zone.height] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}

function stationArea(id: string, x: number, z: number): ManifestArea {
  return {
    ...haven,
    id,
    flatZones: [],
    stations: [{ id, type: "bank", position: { x, y: 0, z } }],
  };
}

describe("TerrainSystem deterministic manifest station grading", () => {
  it("releases natural plaza ground without changing heights or removing station and lodge protection", () => {
    const current = terrainFor(actualAreas);
    const previousAreas = structuredClone(actualAreas);
    const previousHaven = previousAreas.central_haven;
    previousHaven.flatZones = previousHaven.flatZones!.filter(
      (zone) => zone.id !== "central_haven_lodge_grass_clearance",
    );
    delete previousHaven.flatZones![0].excludeGrass;
    const previous = terrainFor(previousAreas);
    const plaza = current.internals.flatZones.get("central_haven_plaza")!;
    const lodge = current.internals.flatZones.get(
      "central_haven_lodge_grass_clearance",
    )!;
    expect(plaza.excludeGrass).toBe(false);
    expect(lodge).toMatchObject({
      excludeGrass: true,
      centerX: 350,
      centerZ: 326.97,
      width: 10,
      depth: 12.06,
      height: plaza.height,
      blendRadius: 0,
    });
    // The only extra shaping zone is inside the already constant campus grade.
    // Compare the real resolver, including pond and automatic station pads.
    let released = 0;
    for (let x = 300; x <= 400; x += 0.5)
      for (let z = 275; z <= 390; z += 0.5) {
        expect(current.terrain.getHeightAt(x, z)).toBe(
          previous.terrain.getHeightAt(x, z),
        );
        const wasExcluded = previous.terrain["isGrassExcludedAt"](x, z);
        const excluded = current.terrain["isGrassExcludedAt"](x, z);
        if (wasExcluded && !excluded) {
          released += 0.25;
          expect(Math.abs(x - plaza.centerX)).toBeLessThanOrEqual(24);
          expect(Math.abs(z - plaza.centerZ)).toBeLessThanOrEqual(24);
        }
        // The lodge is wholly inside the old exclusion, not new distant clearing.
        if (!wasExcluded) expect(excluded).toBe(false);
      }
    // Measured half-meter-grid area; this is not a continuous area integral.
    expect(released).toBe(797.25);
    process.stdout.write(
      `Plaza released sampled area: ${released} square meters\n`,
    );
    expect(padHeights(current.internals)).toEqual(
      padHeights(previous.internals),
    );
    for (const [id, pad] of current.internals.flatZones) {
      if (!id.startsWith("station_")) continue;
      expect(pad).toEqual(previous.internals.flatZones.get(id));
      // Existing full pad/core/blend remains excluded on both roles.
      for (
        let x = pad.centerX - pad.width / 2;
        x <= pad.centerX + pad.width / 2;
        x += 0.5
      )
        for (
          let z = pad.centerZ - pad.depth / 2;
          z <= pad.centerZ + pad.depth / 2;
          z += 0.5
        )
          expect(current.terrain["isGrassExcludedAt"](x, z)).toBe(true);
    }
    const footprint = getCompactPreparationLodgeFootprint(
      COMPACT_PREPARATION_LODGE,
    );
    // Shared footprint includes actual roof trim and every foundation step.
    expect(lodge.centerX - lodge.width / 2).toBeCloseTo(
      footprint.minX - 0.5,
      6,
    );
    expect(lodge.centerX + lodge.width / 2).toBeCloseTo(
      footprint.maxX + 0.5,
      6,
    );
    expect(lodge.centerZ - lodge.depth / 2).toBeCloseTo(
      footprint.minZ - 0.5,
      6,
    );
    expect(lodge.centerZ + lodge.depth / 2).toBeCloseTo(
      footprint.maxZ + 0.5,
      6,
    );
    for (let x = footprint.minX; x <= footprint.maxX; x += 0.25)
      for (let z = footprint.minZ; z <= footprint.maxZ; z += 0.25)
        expect(current.terrain["isGrassExcludedAt"](x, z)).toBe(true);
  });

  beforeEach(() => {
    // Global test setup loads the real station/model-bounds manifests. Fail
    // instead of silently exercising fallback dimensions when assets are absent.
    expect(stationDataProvider.getStationData("bank")).toMatchObject({
      flattenGround: true,
      flattenPadding: 2,
    });
    expect(haven.stations).toHaveLength(5);
  });

  afterEach(() => {
    for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
    Object.assign(ALL_WORLD_AREAS, Object.fromEntries(originalAreas));
  });

  it("uses the actual plaza grade for every hub pad despite different procedural heights", () => {
    const { terrain, internals } = terrainFor(actualAreas);
    const plaza = haven.flatZones![0];
    const plazaHeight = internals.flatZones.get(plaza.id)!.height;
    // The relocated campus keeps its explicitly authored common elevation,
    // independently of the procedural surface at the new world coordinates.
    expect(plaza.height).toBeDefined();
    expect(plazaHeight).toBe(plaza.height);
    let largestRawDifference = 0;
    for (const station of haven.stations!) {
      const pad = internals.flatZones.get(`station_${station.id}`)!;
      expect(pad.height).toBe(plazaHeight);
      expect(terrain.getHeightAt(station.position.x, station.position.z)).toBe(
        plazaHeight,
      );
      largestRawDifference = Math.max(
        largestRawDifference,
        Math.abs(
          terrain.getProceduralHeightAt(
            station.position.x,
            station.position.z,
          ) - plazaHeight,
        ),
      );
    }
    expect(largestRawDifference).toBeGreaterThan(0.5);
  });

  it("keeps current manifest pad grades independent of area, station and explicit-zone order", () => {
    const first = padHeights(terrainFor(actualAreas).internals);
    const reversed = Object.fromEntries(
      Object.entries(actualAreas)
        .reverse()
        .map(([id, area]) => [
          id,
          {
            ...area,
            stations: area.stations ? [...area.stations].reverse() : undefined,
            flatZones: area.flatZones
              ? [...area.flatZones].reverse()
              : undefined,
          },
        ]),
    );
    expect(padHeights(terrainFor(reversed).internals)).toEqual(first);
  });

  it("grades the complete existing preparation campus including all six rune altars", () => {
    const { terrain, internals } = terrainFor(actualAreas);
    const campus = actualAreas.preparation_training_grounds;
    const campusGrade = internals.flatZones.get("preparation_campus_grade")!;
    const plazaGrade = internals.flatZones.get("central_haven_plaza")!;
    expect(campusGrade.height).toBe(plazaGrade.height);
    expect(campusGrade.width).toBe(campus.bounds.maxX - campus.bounds.minX);
    expect(campusGrade.depth).toBe(campus.bounds.maxZ - campus.bounds.minZ);
    const stations = [...haven.stations!, ...campus.stations!];
    expect(stations).toHaveLength(11);
    for (const station of stations) {
      const { x, z } = station.position;
      expect(internals.flatZones.get(`station_${station.id}`)!.height).toBe(
        campusGrade.height,
      );
      // Contact must not change at a narrow pad-center spike. The actual mesh
      // footprint and render-triangle agreement are additionally checked live.
      for (const [dx, dz] of [
        [0, 0],
        [-0.5, -0.5],
        [-0.5, 0.5],
        [0.5, -0.5],
        [0.5, 0.5],
      ]) {
        expect(terrain.getHeightAt(x + dx, z + dz)).toBe(campusGrade.height);
      }
    }
  });

  it("samples grading from later areas before any overlapping automatic pad exists", () => {
    const areas: Record<string, ManifestArea> = {
      west: stationArea("west", 0, 0),
      east: stationArea("east", 2.25, 0),
      grading: {
        ...haven,
        stations: [],
        flatZones: [
          {
            id: "explicit_grade",
            centerX: 0,
            centerZ: 0,
            width: 2,
            depth: 2,
            height: 40,
            blendRadius: 3,
          },
        ],
      },
    };
    const baseline = terrainFor(explicitOnly(areas));
    const expectedEast = baseline.internals.getFlatZoneHeight(2.25, 0);
    expect(expectedEast).not.toBeNull();
    expect(expectedEast).not.toBe(40);
    const { internals } = terrainFor(areas);
    expect(internals.flatZones.get("station_west")!.height).toBe(40);
    expect(internals.flatZones.get("station_east")!.height).toBe(expectedEast);
    expect(
      padHeights(
        terrainFor(Object.fromEntries(Object.entries(areas).reverse()))
          .internals,
      ),
    ).toEqual(padHeights(internals));
  });

  it("retains each raw procedural fallback when no explicit zone applies", () => {
    const { centerX, centerZ } = haven.flatZones![0];
    const { terrain, internals } = terrainFor({
      west: stationArea("west", centerX, centerZ),
      east: stationArea("east", centerX + 2.25, centerZ),
    });
    for (const [id, x] of [
      ["west", centerX],
      ["east", centerX + 2.25],
    ] as const) {
      expect(internals.flatZones.get(`station_${id}`)!.height).toBe(
        terrain.getProceduralHeightAt(x, centerZ),
      );
    }
    expect(internals.flatZones.get("station_west")!.height).not.toBe(
      internals.flatZones.get("station_east")!.height,
    );
  });

  it("preserves an explicit zero grade instead of falling back to raw terrain", () => {
    const { terrain, internals } = terrainFor({
      station: stationArea("zero_grade_station", 0, 0),
      grading: {
        ...haven,
        stations: [],
        flatZones: [
          {
            id: "zero_grade",
            centerX: 0,
            centerZ: 0,
            width: 10,
            depth: 10,
            height: 0,
            blendRadius: 2,
          },
        ],
      },
    });
    expect(terrain.getProceduralHeightAt(0, 0)).not.toBe(0);
    expect(internals.flatZones.get("station_zero_grade_station")!.height).toBe(
      0,
    );
  });

  it("preserves actual radial pond bed, bank and shoreline priority over station pads", () => {
    const baseline = terrainFor(explicitOnly(actualAreas));
    const pond = [...baseline.internals.flatZones.values()].find(
      (zone) => zone.radialPond,
    )!;
    expect(pond.radialPond).toBeDefined();
    const radial = pond.radialPond!;
    const radii = [
      0,
      radial.bedRadius + 0.5,
      radial.bankInnerRadius + 0.5,
      radial.bankOuterRadius + pond.blendRadius * 0.5,
    ];
    const samples = radii.map((radius) => ({
      x: pond.centerX + radius,
      z: pond.centerZ,
      expected: baseline.internals.getFlatZoneHeight(
        pond.centerX + radius,
        pond.centerZ,
      ),
    }));
    const bankX = pond.centerX + radial.bankInnerRadius + 0.5;
    const { terrain, internals } = terrainFor({
      ...actualAreas,
      pond_bank_station: stationArea("pond_bank_station", bankX, pond.centerZ),
    });
    expect(internals.flatZones.get("station_pond_bank_station")!.height).toBe(
      radial.bankHeight,
    );
    for (const sample of samples) {
      expect(terrain.getHeightAt(sample.x, sample.z)).toBe(sample.expected);
    }
  });
});
