import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { World } from "../../../../core/World";
import { ALL_WORLD_AREAS, type WorldArea } from "../../../../data/world-areas";
import {
  stationDataProvider,
  type ModelBoundsManifest,
  type StationsManifest,
} from "../../../../data/StationDataProvider";
import type {
  FlatZone,
  RadialPondTerrainProfile,
} from "../../../../types/world/terrain";
import { TerrainSystem } from "../TerrainSystem";
import { createAuthoredTerrainSurfaceOperations } from "../AuthoredTerrainSurface";
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
const modelBounds = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../server/world/assets/manifests/model-bounds.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ModelBoundsManifest;
const stationManifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../server/world/assets/manifests/stations.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as StationsManifest;
const authoredSurface = createAuthoredTerrainSurfaceOperations();

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
    // Keep this earlier plaza-only comparison historical. Both Worlds use the
    // same current station clearances; only the broad-grade flags differ. This
    // is not a replay of historical station-pad grass populations.
    const plazaAreas = structuredClone(actualAreas);
    delete plazaAreas.duel_arena.flatZones!.find(
      (zone) => zone.id === "duel_arena_campus_grade",
    )!.excludeGrass;
    const current = terrainFor(plazaAreas);
    const previousAreas = structuredClone(plazaAreas);
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
      // Protect the current grass footprint, not the larger grading pad.
      const grass = pad.grassExclusionBounds ?? {
        minX: pad.centerX - pad.width / 2,
        maxX: pad.centerX + pad.width / 2,
        minZ: pad.centerZ - pad.depth / 2,
        maxZ: pad.centerZ + pad.depth / 2,
      };
      for (let x = grass.minX; x <= grass.maxX; x += 0.5)
        for (let z = grass.minZ; z <= grass.maxZ; z += 0.5) {
          expect(authoredSurface.isGrassExcluded([pad], x, z)).toBe(true);
          expect(current.terrain["isGrassExcludedAt"](x, z)).toBe(true);
        }
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

  it("releases the broad arena grade without changing terrain or any protected footprint", () => {
    // Both Worlds deliberately have the same current station model clearances.
    // The historical difference here is only the broad arena-grade exclusion.
    const current = terrainFor(actualAreas);
    const previousAreas = structuredClone(actualAreas);
    delete previousAreas.duel_arena.flatZones!.find(
      (zone) => zone.id === "duel_arena_campus_grade",
    )!.excludeGrass;
    const previous = terrainFor(previousAreas);
    const grade = current.internals.flatZones.get("duel_arena_campus_grade")!;
    expect(grade.excludeGrass).toBe(false);
    let releasedSamples = 0;
    const currentGrades = new Float64Array(155 * 270);
    const previousGrades = new Float64Array(currentGrades.length);
    let gradingSamples = 0;
    // Cover the entire grade plus its transition and one metre of exterior.
    for (let x = 291; x <= 445; x += 1) {
      for (let z = 323.5; z <= 458; z += 0.5) {
        currentGrades[gradingSamples] = current.terrain.getHeightAt(x, z);
        previousGrades[gradingSamples] = previous.terrain.getHeightAt(x, z);
        expect(currentGrades[gradingSamples]).toBe(
          previousGrades[gradingSamples],
        );
        gradingSamples++;
        const wasExcluded = previous.terrain["isGrassExcludedAt"](x, z);
        const excluded = current.terrain["isGrassExcludedAt"](x, z);
        if (wasExcluded && !excluded) {
          releasedSamples++;
          expect(Math.abs(x - grade.centerX)).toBeLessThanOrEqual(
            grade.width / 2 + grade.blendRadius,
          );
          expect(Math.abs(z - grade.centerZ)).toBeLessThanOrEqual(
            grade.depth / 2 + grade.blendRadius,
          );
        }
        if (!wasExcluded) expect(excluded).toBe(false);
      }
    }
    expect(gradingSamples).toBe(currentGrades.length);
    expect(Buffer.from(currentGrades.buffer)).toEqual(
      Buffer.from(previousGrades.buffer),
    );
    expect(releasedSamples).toBeGreaterThan(30000);
    expect(padHeights(current.internals)).toEqual(
      padHeights(previous.internals),
    );
    for (const [id, zone] of current.internals.flatZones) {
      if (id === grade.id) continue;
      expect(zone).toEqual(previous.internals.flatZones.get(id));
      if (zone.excludeGrass === false) continue;
      // Explicit grass bounds have inclusive edges/corners. Other unchanged
      // zones still protect their full historical core and blending ring.
      const bounds = zone.grassExclusionBounds ?? {
        minX: zone.centerX - zone.width / 2 - zone.blendRadius,
        maxX: zone.centerX + zone.width / 2 + zone.blendRadius,
        minZ: zone.centerZ - zone.depth / 2 - zone.blendRadius,
        maxZ: zone.centerZ + zone.depth / 2 + zone.blendRadius,
      };
      for (const x of [
        bounds.minX,
        (bounds.minX + bounds.maxX) / 2,
        bounds.maxX,
      ])
        for (const z of [
          bounds.minZ,
          (bounds.minZ + bounds.maxZ) / 2,
          bounds.maxZ,
        ]) {
          if (zone.grassExclusionBounds)
            expect(authoredSurface.isGrassExcluded([zone], x, z), zone.id).toBe(
              true,
            );
          expect(
            current.terrain["isGrassExcludedAt"](x, z),
            `${zone.id} grass protection at ${x},${z}`,
          ).toBe(true);
        }
    }
    expect(
      [...current.internals.flatZones.values()]
        .filter((zone) => zone.grassExclusionBounds)
        .map((zone) => zone.id)
        .sort(),
    ).toEqual(["station_anvil_spawn", "station_furnace_spawn"]);
    for (const [type, scale, oldCorner] of [
      ["furnace", 1.5, [329, 330]],
      ["anvil", 0.5, [342.5, 340.5]],
    ] as const) {
      const station = haven.stations!.find((station) => station.type === type)!;
      const data = stationDataProvider.getStationData(type)!;
      expect(data.modelScale).toBe(scale);
      expect(data.grassClearanceMargin).toBe(1.25);
      const raw = modelBounds.models.find(
        (model) => model.assetPath === data.model,
      )!.bounds;
      const zone = current.internals.flatZones.get(`station_${station.id}`)!;
      expect(zone.grassExclusionBounds).toEqual({
        minX: station.position.x + raw.min.x * scale - 1.25,
        maxX: station.position.x + raw.max.x * scale + 1.25,
        minZ: station.position.z + raw.min.z * scale - 1.25,
        maxZ: station.position.z + raw.max.z * scale + 1.25,
      });
      // Former station-halo points are now released. The comparison World
      // still excludes them because its broad arena grade is retained, NOT
      // because it uses a different or reconstructed historical station pad.
      const { grassExclusionBounds, ...oldHalo } = zone;
      expect(grassExclusionBounds).toBeDefined();
      expect(
        authoredSurface.isGrassExcluded([oldHalo], oldCorner[0], oldCorner[1]),
      ).toBe(true);
      expect(
        authoredSurface.isGrassExcluded([zone], oldCorner[0], oldCorner[1]),
      ).toBe(false);
      expect(
        current.terrain["isGrassExcludedAt"](oldCorner[0], oldCorner[1]),
      ).toBe(false);
      expect(
        previous.terrain["isGrassExcludedAt"](oldCorner[0], oldCorner[1]),
      ).toBe(true);
      expect(current.terrain.getHeightAt(oldCorner[0], oldCorner[1])).toBe(
        previous.terrain.getHeightAt(oldCorner[0], oldCorner[1]),
      );
    }
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

  it("releases only the three candidate station grass halos while preserving exact terrain, collision and lodge protection", () => {
    const candidate = structuredClone(stationManifest);
    const selectedTypes = new Set(["bank", "range", "altar"]);
    const selectedZones = new Set(
      haven
        .stations!.filter((station) => selectedTypes.has(station.type))
        .map((station) => `station_${station.id}`),
    );
    expect(selectedZones.size).toBe(3);
    const originalFootprints = new Map(
      stationManifest.stations.map((station) => [
        station.type,
        structuredClone(stationDataProvider.getFootprint(station.type)),
      ]),
    );
    const previous = terrainFor(actualAreas);
    try {
      for (const station of candidate.stations)
        if (selectedTypes.has(station.type)) {
          expect(station.grassClearanceMargin).toBeUndefined();
          station.grassClearanceMargin = 1.25;
        }
      stationDataProvider.loadStations(candidate);
      const current = terrainFor(actualAreas);
      expect(padHeights(current.internals)).toEqual(
        padHeights(previous.internals),
      );
      expect(current.internals.flatZones.size).toBe(
        previous.internals.flatZones.size,
      );
      const previousHalos: FlatZone[] = [];
      for (const [id, zone] of current.internals.flatZones) {
        const before = previous.internals.flatZones.get(id)!;
        if (!selectedZones.has(id)) {
          expect(zone).toEqual(before);
          continue;
        }
        expect(before.grassExclusionBounds).toBeUndefined();
        const { grassExclusionBounds, ...grading } = zone;
        expect(grassExclusionBounds).toBeDefined();
        expect(grading).toEqual(before);
        previousHalos.push(before);
        const bounds = grassExclusionBounds!;
        for (const x of [
          bounds.minX,
          (bounds.minX + bounds.maxX) / 2,
          bounds.maxX,
        ])
          for (const z of [
            bounds.minZ,
            (bounds.minZ + bounds.maxZ) / 2,
            bounds.maxZ,
          ]) {
            expect(authoredSurface.isGrassExcluded([zone], x, z)).toBe(true);
            expect(current.terrain["isGrassExcludedAt"](x, z)).toBe(true);
          }
      }
      for (const station of stationManifest.stations)
        expect(stationDataProvider.getFootprint(station.type)).toEqual(
          originalFootprints.get(station.type),
        );

      let released = 0;
      // Cover the whole preparation campus and exterior, not just the changed
      // three rectangles. Compare actual height bytes and every exclusion bit.
      const beforeHeights: number[] = [];
      const afterHeights: number[] = [];
      for (let x = 290; x <= 445; x += 0.5)
        for (let z = 275; z <= 460; z += 0.5) {
          beforeHeights.push(previous.terrain.getHeightAt(x, z));
          afterHeights.push(current.terrain.getHeightAt(x, z));
          const wasExcluded = previous.terrain["isGrassExcludedAt"](x, z);
          const excluded = current.terrain["isGrassExcludedAt"](x, z);
          if (wasExcluded === excluded) continue;
          expect(wasExcluded).toBe(true);
          expect(excluded).toBe(false);
          expect(authoredSurface.isGrassExcluded(previousHalos, x, z)).toBe(
            true,
          );
          released++;
        }
      expect(released).toBeGreaterThan(0);
      expect(Buffer.from(new Float64Array(afterHeights).buffer)).toEqual(
        Buffer.from(new Float64Array(beforeHeights).buffer),
      );
      for (const [x, z] of [
        [345, 315],
        [350, 315],
        [340, 315],
        [352, 310],
      ]) {
        expect(previous.terrain["isGrassExcludedAt"](x, z)).toBe(true);
        expect(current.terrain["isGrassExcludedAt"](x, z)).toBe(false);
      }
      const lodge = getCompactPreparationLodgeFootprint(
        COMPACT_PREPARATION_LODGE,
      );
      for (let x = lodge.minX; x <= lodge.maxX; x += 0.25)
        for (let z = lodge.minZ; z <= lodge.maxZ; z += 0.25)
          expect(current.terrain["isGrassExcludedAt"](x, z)).toBe(true);
      process.stdout.write(
        `Three-station input-only candidate: ${released} half-metre samples released; ${beforeHeights.length} exact height samples; no native coverage claim\n`,
      );
    } finally {
      stationDataProvider.loadStations(structuredClone(stationManifest));
    }
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
