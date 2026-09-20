import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import { resolveFootprint } from "../../../../types/game/resource-processing-types";
import { isPositionInsideCombatArena } from "../../../../data/duel-manifest";
import {
  getDuelArenaEgressPosition,
  getDuelArenaLobbyReturnPosition,
} from "../../../../data/arena-grading";
import { loadPhysX } from "../../../../physics/PhysXManager";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import THREE from "../../../../extras/three/three";
import { Collider } from "../../../../nodes/Collider";
import { RigidBody } from "../../../../nodes/RigidBody";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { StationSpawnerSystem } from "../../entities/StationSpawnerSystem";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import {
  getCardinalAdjacentTiles,
  worldToTile,
  type TileCoord,
} from "../../movement/TileSystem";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import {
  CompactServiceCourtSystem,
  COMPACT_SERVICE_COURT_SYSTEM,
} from "../CompactServiceCourtSystem";
import {
  CompactLandscapeRocksSystem,
  COMPACT_LANDSCAPE_ROCKS_SYSTEM,
} from "../CompactLandscapeRocksSystem";
import type {
  WorldArea,
  WorldConfigManifest,
} from "../../../../types/world/world-types";
import { TerrainSystem } from "../TerrainSystem";
import { createAuthoredTerrainSurfaceOperations } from "../AuthoredTerrainSurface";
import type { FlatZone } from "../../../../types/world/terrain";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import {
  COMPACT_TERRAIN_COMPOSITION,
  createCompactTerrainColorOperations,
} from "../CompactTerrainPalette";
import { sampleNoiseCPU, TERRAIN_SHADER_CONSTANTS } from "../TerrainShader";
import { GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../TerrainQuadChunkGenerator";
import { createCompactRockCollisionGeometry } from "../CompactRockGeometry";
import { createCompactLandscapeRockFootprints } from "../CompactLandscapeRockFootprints";
import {
  COMPACT_POND_MODELS,
  createCompactPondDressing,
} from "../CompactPondDressing";
import {
  groundCompactLandscapeRocks,
  validateCompactLandscapeRocks,
} from "../CompactLandscapeRocks";

// Explicit development-overlay test. Normal suites retain their historical
// fixtures; the candidate is admitted by the real manifest loader at startup.
const candidate = process.env.HYPERIA_POND_LAYOUT_CANDIDATE;
const review49 = candidate === "review49";
const review52 = candidate === "review52";
const review66 = candidate === "review66";
const review69 = candidate === "review69";
const review73 = candidate === "review73";
const review75 = candidate === "review75";
// Review75 retains the complete Review74 physical fixture; only a material
// role on the existing southern sector changes. Both use the same thresholds.
const review74 = candidate === "review74" || review75;
const compositionBank = review69 || review73 || review74;
const pairedBank = review52 || review66 || compositionBank;
const enabled = candidate === "preview44" || review49 || pairedBank;
const worlds: World[] = [];
const bodies: RigidBody[] = [];
const owned: { dispose(): void }[] = [];
const config = DataManager.getWorldConfig()!;
const profile = DataManager.getWorldTerrainProfile();
let compositionBaselineZone: FlatZone | undefined;
class CpuServerWorld extends World {
  override get isServer() {
    return true;
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const assets = process.env.ASSETS_DIR;
  expect(assets).toBeTruthy();
  expect(assets).toContain(
    review75
      ? "terrain-pond-review75-UNQUALIFIED/assets"
      : review74
        ? "terrain-pond-review74-UNQUALIFIED/assets"
        : review73
          ? "terrain-pond-review73-UNQUALIFIED/assets"
          : review69
            ? "terrain-pond-review69-UNQUALIFIED/assets"
            : review66
              ? "terrain-pond-review66-UNQUALIFIED/assets"
              : review52
                ? "terrain-pond-review52-UNQUALIFIED/assets"
                : review49
                  ? "terrain-pond-review49-UNQUALIFIED/assets"
                  : "southern-meadow-preview44-UNQUALIFIED/assets",
  );
  const raw = JSON.parse(
    readFileSync(resolve(assets!, "manifests/world-config.json"), "utf8"),
  ) as WorldConfigManifest;
  expect(config.compactLandscapeRocks).toEqual(raw.compactLandscapeRocks);
  expect(profile.southernMeadow).toBeDefined();
  const pond = DataManager.getInstance().getWorldArea("haven_pond")!;
  if (review75) {
    const baseline = resolve(
      process.cwd(),
      "../../../asset-studio/game-test-integration/terrain-pond-review74-UNQUALIFIED/assets/manifests",
    );
    const original = JSON.parse(
      readFileSync(resolve(baseline, "world-areas.json"), "utf8"),
    ) as { level1Areas: Record<string, WorldArea> };
    const radial = original.level1Areas.haven_pond.flatZones!.find(
      (zone) => zone.id === "haven_pond_floor",
    )!.radialPond!;
    const composition = radial.bankComposition!;
    expect(composition.sectors.some((sector) => sector.sectorIndex === 2)).toBe(
      false,
    );
    radial.bankComposition = {
      ...composition,
      sectors: [
        ...composition.sectors,
        { sectorIndex: 2, surface: "mineral-shore" },
      ],
    };
    expect(
      JSON.parse(
        readFileSync(resolve(assets!, "manifests/world-areas.json"), "utf8"),
      ),
    ).toEqual(original);
    expect(raw).toEqual(
      JSON.parse(readFileSync(resolve(baseline, "world-config.json"), "utf8")),
    );
  }
  expect(
    pond.flatZones?.find((zone) => zone.radialPond)?.radialPond?.bankSectors,
  ).toHaveLength(pairedBank ? 4 : review49 ? 3 : 2);
  if (review49) {
    const original = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../../../asset-studio/game-test-integration/southern-meadow-preview44-UNQUALIFIED/assets/manifests/world-areas.json",
        ),
        "utf8",
      ),
    ) as { level1Areas: Record<string, WorldArea> };
    const admitted = JSON.parse(
      readFileSync(resolve(assets!, "manifests/world-areas.json"), "utf8"),
    ) as typeof original;
    const sectors = admitted.level1Areas.haven_pond.flatZones?.find(
      (zone) => zone.radialPond,
    )?.radialPond?.bankSectors;
    expect(sectors).toHaveLength(3);
    expect(sectors!.pop()).toEqual({
      bearing: 0.7,
      halfWidth: 0.55,
      innerRadius: 6.4,
      innerHeight: 27.86,
    });
    // Compare the complete source object, not just the selected pond fields.
    // The older two-sector overlay is immutable evidence, not our new fixture.
    expect(admitted).toEqual(original);
    expect(pond.flatZones?.find((zone) => zone.radialPond)?.radialPond).toEqual(
      {
        ...original.level1Areas.haven_pond.flatZones!.find(
          (zone) => zone.radialPond,
        )!.radialPond,
        bankSectors: [
          ...sectors!,
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
        ],
      },
    );
  }
  if (review52) {
    const baseline = resolve(
      process.cwd(),
      "../../../asset-studio/game-test-integration/terrain-pond-review49-UNQUALIFIED/assets/manifests",
    );
    const originalAreas = JSON.parse(
      readFileSync(resolve(baseline, "world-areas.json"), "utf8"),
    ) as { level1Areas: Record<string, WorldArea> };
    const admittedAreas = JSON.parse(
      readFileSync(resolve(assets!, "manifests/world-areas.json"), "utf8"),
    ) as typeof originalAreas;
    const originalPond = originalAreas.level1Areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!.radialPond!;
    expect(originalPond.bankSectors).toHaveLength(3);
    expect(originalPond.bankSectors![0]).toEqual({
      bearing: -2.321287905152458,
      halfWidth: 0.6981317007977318,
      innerRadius: 6.25,
      innerHeight: 27.84,
    });
    // Only this parsed comparison object changes. The historical asset bytes
    // and their original three-sector native fixture remain untouched.
    originalPond.bankSectors = [
      {
        bearing: -2.321287905152458,
        halfWidth: 0.6981317007977318,
        innerRadius: 6,
        innerHeight: 27.98,
        outerRadius: 8.2,
        outerHeight: 28.55,
      },
      ...originalPond.bankSectors!.slice(1),
      {
        bearing: -1.5533430342749532,
        halfWidth: 0.8726646259971648,
        innerRadius: 7.1,
        innerHeight: 27.86,
        outerRadius: 8.7,
        outerHeight: 27.99,
      },
    ];
    // Whole-object comparison protects water, resources, stations, NPCs,
    // southeast contact and every unrelated area field.
    expect(admittedAreas).toEqual(originalAreas);
    expect(pond.flatZones?.find((zone) => zone.radialPond)?.radialPond).toEqual(
      originalPond,
    );
    const originalConfig = JSON.parse(
      readFileSync(resolve(baseline, "world-config.json"), "utf8"),
    ) as WorldConfigManifest;
    const moves = [
      { id: "pond-north-01", x: 339.25, z: 294.9 },
      { id: "pond-north-02", x: 340.45, z: 294.3 },
      { id: "pond-north-03", x: 336.8, z: 294.9 },
      { id: "pond-north-04", x: 337.8, z: 293.8 },
      { id: "pond-west-03", x: 337.6, z: 296 },
      { id: "pond-west-04", x: 338, z: 295 },
    ];
    for (const move of moves) {
      const placements = originalConfig.compactLandscapeRocks!.rocks.filter(
        (rock) => rock.id === move.id,
      );
      expect(placements, move.id).toHaveLength(1);
    }
    originalConfig.compactLandscapeRocks = {
      ...originalConfig.compactLandscapeRocks!,
      rocks: originalConfig.compactLandscapeRocks!.rocks.map((rock) => {
        const move = moves.find((entry) => entry.id === rock.id);
        return move ? { ...rock, x: move.x, z: move.z } : rock;
      }),
    };
    // Preserve every ID, variant, scale, yaw and all unselected configuration.
    expect(raw).toEqual(originalConfig);
  }
  if (review66) {
    const baseline = resolve(
      process.cwd(),
      "../../../asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/assets/manifests",
    );
    type AreasManifest = {
      starterTowns: Record<string, WorldArea>;
      level1Areas: Record<string, WorldArea>;
      level2Areas: Record<string, WorldArea>;
      level3Areas: Record<string, WorldArea>;
      specialAreas?: Record<string, WorldArea>;
    };
    const originalAreas = JSON.parse(
      readFileSync(resolve(baseline, "world-areas.json"), "utf8"),
    ) as AreasManifest;
    const admittedAreas = JSON.parse(
      readFileSync(resolve(assets!, "manifests/world-areas.json"), "utf8"),
    ) as AreasManifest;
    const originalPond = originalAreas.level1Areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!.radialPond!;
    const sectors = originalPond.bankSectors!;
    expect(sectors).toHaveLength(4);
    expect(sectors[0]).toEqual({
      bearing: -2.321287905152458,
      halfWidth: 0.6981317007977318,
      innerRadius: 6,
      innerHeight: 27.98,
      outerRadius: 8.2,
      outerHeight: 28.55,
    });
    expect(sectors[3]).toEqual({
      bearing: -1.5533430342749532,
      halfWidth: 0.8726646259971648,
      innerRadius: 7.1,
      innerHeight: 27.86,
      outerRadius: 8.7,
      outerHeight: 27.99,
    });
    // Modify only the parsed comparison object. The candidate changes five
    // authored fields, not historical assets, water, actors or access policy.
    originalPond.bankSectors = [
      { ...sectors[0], innerRadius: 6.1, innerHeight: 28.08 },
      sectors[1],
      sectors[2],
      {
        ...sectors[3],
        innerRadius: 6.8,
        innerHeight: 28.08,
        outerHeight: 28.24,
      },
    ];
    expect(admittedAreas).toEqual(originalAreas);
    // DataManager initializes in the Vitest setup, before this module. Check
    // the actual loaded areas so an ignored/late ASSETS_DIR cannot pass merely
    // because the candidate file itself contains the expected authoring data.
    expect(ALL_WORLD_AREAS).toEqual({
      ...admittedAreas.starterTowns,
      ...admittedAreas.level1Areas,
      ...admittedAreas.level2Areas,
      ...admittedAreas.level3Areas,
      ...admittedAreas.specialAreas,
    });
    expect(raw).toEqual(
      JSON.parse(
        readFileSync(resolve(baseline, "world-config.json"), "utf8"),
      ) as WorldConfigManifest,
    );
  }
  if (review69) {
    const baseline = resolve(
      process.cwd(),
      "../../../asset-studio/game-test-integration/terrain-pond-review68-UNQUALIFIED/assets/manifests",
    );
    type AreasManifest = {
      starterTowns: Record<string, WorldArea>;
      level1Areas: Record<string, WorldArea>;
      level2Areas: Record<string, WorldArea>;
      level3Areas: Record<string, WorldArea>;
      specialAreas?: Record<string, WorldArea>;
    };
    const originalAreas = JSON.parse(
      readFileSync(resolve(baseline, "world-areas.json"), "utf8"),
    ) as AreasManifest;
    const admittedAreas = JSON.parse(
      readFileSync(resolve(assets!, "manifests/world-areas.json"), "utf8"),
    ) as AreasManifest;
    const originalZone = originalAreas.level1Areas.haven_pond.flatZones!.find(
      (zone) => zone.id === "haven_pond_floor",
    )!;
    expect(originalZone.height).toBe(26.6);
    compositionBaselineZone = structuredClone(originalZone) as FlatZone;
    const originalPond = originalZone.radialPond!;
    const sectors = originalPond.bankSectors!;
    expect(sectors).toHaveLength(4);
    expect(sectors[0]).toEqual({
      bearing: -2.321287905152458,
      halfWidth: 0.6981317007977318,
      innerRadius: 6.1,
      innerHeight: 28.08,
      outerRadius: 8.2,
      outerHeight: 28.55,
    });
    expect(sectors[3]).toEqual({
      bearing: -1.5533430342749532,
      halfWidth: 0.8726646259971648,
      innerRadius: 6.8,
      innerHeight: 28.08,
      outerRadius: 8.7,
      outerHeight: 28.24,
    });
    originalPond.bankSectors = [
      {
        bearing: -2.321287905152458,
        halfWidth: 0.6981317007977318,
        innerRadius: 5.6,
        innerHeight: 28.08,
        outerRadius: 8.8,
        outerHeight: 28.5,
      },
      sectors[1],
      sectors[2],
      {
        bearing: -1.5533430342749532,
        halfWidth: 0.8726646259971648,
        innerRadius: 6.6,
        innerHeight: 28.04,
        outerRadius: 9.6,
        outerHeight: 28.24,
      },
    ];
    // Only the two northern geometry rows change. Whole-object equality protects
    // water, bed, south/NE sectors, mapping, resources and every unrelated field.
    expect(admittedAreas).toEqual(originalAreas);
    expect(originalPond.bankComposition).toEqual({
      schemaVersion: 1,
      sectors: [
        { sectorIndex: 0, surface: "cutbank" },
        { sectorIndex: 1, surface: "dry-turf" },
        { sectorIndex: 3, surface: "sedge-shelf" },
      ],
    });
    expect(ALL_WORLD_AREAS).toEqual({
      ...admittedAreas.starterTowns,
      ...admittedAreas.level1Areas,
      ...admittedAreas.level2Areas,
      ...admittedAreas.level3Areas,
      ...admittedAreas.specialAreas,
    });
    expect(raw).toEqual(
      JSON.parse(readFileSync(resolve(baseline, "world-config.json"), "utf8")),
    );
  }
  if (review73 || review74) {
    const baseline = resolve(
      process.cwd(),
      "../../../asset-studio/game-test-integration/terrain-pond-review68-UNQUALIFIED/assets/manifests",
    );
    type AreasManifest = {
      starterTowns: Record<string, WorldArea>;
      level1Areas: Record<string, WorldArea>;
      level2Areas: Record<string, WorldArea>;
      level3Areas: Record<string, WorldArea>;
      specialAreas?: Record<string, WorldArea>;
    };
    const originalAreas = JSON.parse(
      readFileSync(resolve(baseline, "world-areas.json"), "utf8"),
    ) as AreasManifest;
    const admittedAreas = JSON.parse(
      readFileSync(resolve(assets!, "manifests/world-areas.json"), "utf8"),
    ) as AreasManifest;
    const originalZone = originalAreas.level1Areas.haven_pond.flatZones!.find(
      (zone) => zone.id === "haven_pond_floor",
    )!;
    expect(originalZone.height).toBe(26.6);
    compositionBaselineZone = structuredClone(originalZone) as FlatZone;
    const originalPond = originalZone.radialPond!;
    const sectors = originalPond.bankSectors!;
    expect(sectors).toHaveLength(4);
    expect(sectors[0]).toEqual({
      bearing: -2.321287905152458,
      halfWidth: 0.6981317007977318,
      innerRadius: 6.1,
      innerHeight: 28.08,
      outerRadius: 8.2,
      outerHeight: 28.55,
    });
    expect(sectors[3]).toEqual({
      bearing: -1.5533430342749532,
      halfWidth: 0.8726646259971648,
      innerRadius: 6.8,
      innerHeight: 28.08,
      outerRadius: 8.7,
      outerHeight: 28.24,
    });
    expect(originalPond.bankComposition).toEqual({
      schemaVersion: 1,
      sectors: [
        { sectorIndex: 0, surface: "cutbank" },
        { sectorIndex: 1, surface: "dry-turf" },
        { sectorIndex: 3, surface: "sedge-shelf" },
      ],
    });
    originalPond.bankSectors = [
      {
        bearing: -2.321287905152458,
        halfWidth: 0.5235987755982988,
        innerRadius: 6.3,
        innerHeight: review74 ? 27.4 : 27.95,
        outerRadius: 7.6,
        outerHeight: review74 ? 28.4 : 28.64,
      },
      sectors[1],
      sectors[2],
      {
        bearing: -1.6755160819145565,
        halfWidth: 0.767944870877505,
        innerRadius: 6.9,
        innerHeight: 27.86,
        outerRadius: 8.85,
        outerHeight: 28.22,
      },
    ];
    originalPond.bankComposition = {
      schemaVersion: 1,
      sectors: [
        {
          sectorIndex: 0,
          surface: "cutbank",
          ...(review74
            ? {}
            : { groundCover: { emergenceHeight: 0.15, fullHeight: 0.3 } }),
        },
        {
          sectorIndex: 1,
          surface: "dry-turf",
          groundCover: { emergenceHeight: 0.06, fullHeight: 0.16 },
        },
        {
          sectorIndex: 3,
          surface: "sedge-shelf",
          groundCover: review74
            ? { emergenceHeight: 0.11, fullHeight: 0.24 }
            : { emergenceHeight: 0.04, fullHeight: 0.12 },
        },
      ],
    };
    if (review75) {
      originalPond.bankComposition = {
        ...originalPond.bankComposition,
        sectors: [
          ...originalPond.bankComposition.sectors,
          { sectorIndex: 2, surface: "mineral-shore" },
        ],
      };
    }
    // Mutate only this parsed comparison object. Exact complete-source equality
    // forbids changes to water, bed, NE/south, roads, resources and other areas.
    expect(admittedAreas).toEqual(originalAreas);
    expect(ALL_WORLD_AREAS).toEqual({
      ...admittedAreas.starterTowns,
      ...admittedAreas.level1Areas,
      ...admittedAreas.level2Areas,
      ...admittedAreas.level3Areas,
      ...admittedAreas.specialAreas,
    });
    const originalConfig = JSON.parse(
      readFileSync(resolve(baseline, "world-config.json"), "utf8"),
    ) as WorldConfigManifest;
    const moves = [
      {
        id: "pond-west-02",
        previousX: 335.9,
        previousZ: 296.8,
        x: 336.3,
        z: 296,
      },
      {
        id: "pond-north-03",
        previousX: 336.8,
        previousZ: 294.9,
        x: 337.1,
        z: 294.3,
      },
    ];
    for (const move of moves) {
      const original = originalConfig.compactLandscapeRocks!.rocks.filter(
        (rock) => rock.id === move.id,
      );
      expect(original).toHaveLength(1);
      expect([original[0].x, original[0].z]).toEqual([
        move.previousX,
        move.previousZ,
      ]);
    }
    originalConfig.compactLandscapeRocks = {
      ...originalConfig.compactLandscapeRocks!,
      rocks: originalConfig.compactLandscapeRocks!.rocks.map((rock) => {
        const move = moves.find((entry) => entry.id === rock.id);
        return move ? { ...rock, x: move.x, z: move.z } : rock;
      }),
    };
    // Only the two independently admitted X/Z moves repair the changed bank
    // contact. Every ID, model, scale, yaw, count and unrelated config is exact.
    expect(raw).toEqual(originalConfig);
  }
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await loadPhysX();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

afterEach(() => {
  for (const body of bodies.splice(0)) body.deactivate();
  for (const world of worlds.splice(0)) world.destroy();
  for (const object of owned.splice(0)) object.dispose();
});

async function terrainFixture() {
  const world = new CpuServerWorld();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  if (compositionBank) {
    terrain["compactPondBlend"] = "composition-v1";
    terrain["compactSurfaceBlend"] = "height-v1";
  }
  await terrain.init();
  if (!terrain["compositionManifestLoaded"]) {
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
  }
  if (compositionBank) {
    expect(
      terrain["compactPondBankField"]?.sectors.map((sector) => sector.surface),
    ).toEqual([
      "cutbank",
      "dry-turf",
      review75 ? "mineral-shore" : undefined,
      "sedge-shelf",
    ]);
  }
  if (review73 || review74) {
    expect(
      terrain["compactPondBankField"]?.sectors.map(
        (sector) => sector.groundCover,
      ),
    ).toEqual([
      review74 ? undefined : { emergenceHeight: 0.15, fullHeight: 0.3 },
      { emergenceHeight: 0.06, fullHeight: 0.16 },
      undefined,
      review74
        ? { emergenceHeight: 0.11, fullHeight: 0.24 }
        : { emergenceHeight: 0.04, fullHeight: 0.12 },
    ]);
  }
  return { world, terrain };
}

describe.skipIf(!enabled)(
  `${candidate ?? "disabled"} actual candidate shoreline rock layout`,
  () => {
    it.skipIf(!pairedBank)(
      "keeps the paired-bank water disk covered and checks the complete northern shoulder against retained triangles and native cooking",
      async () => {
        const { world, terrain } = await terrainFixture();
        await world.physics.init();
        const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
        const zone = terrain["flatZones"].get("haven_pond_floor")!;
        const sectors = zone.radialPond!.bankSectors!;
        expect(sectors).toHaveLength(4);
        const paired = sectors.filter(
          (sector) => sector.outerRadius !== undefined,
        );
        expect(paired).toHaveLength(2);
        const provider = terrain["buildChunkTerrainProvider"]();
        const getHeight = (angle: number, radius: number) =>
          provider.getHeightAtComputed(
            pond.centerX + Math.cos(angle) * radius,
            pond.centerZ + Math.sin(angle) * radius,
          );
        let minimumWaterEdgeClearance = Infinity;
        for (let degrees = 0; degrees < 360; degrees++) {
          const edge = getHeight((degrees * Math.PI) / 180, pond.radius);
          expect(Number.isFinite(edge), `water edge ${degrees}`).toBe(true);
          expect(edge, `water edge ${degrees}`).toBeGreaterThan(pond.surfaceY);
          minimumWaterEdgeClearance = Math.min(
            minimumWaterEdgeClearance,
            edge - pond.surfaceY,
          );
        }
        // Inspect every integer bearing touched by the two changed supports,
        // plus their exact centers/joins. This permits the intended dry outer
        // shoulder to roll down; it must never form another submerged pocket.
        const affectedAngles = new Set<number>(
          paired.flatMap((sector) => [
            sector.bearing - sector.halfWidth,
            sector.bearing,
            sector.bearing + sector.halfWidth,
          ]),
        );
        for (let degrees = -180; degrees < 180; degrees++) {
          const angle = (degrees * Math.PI) / 180;
          if (
            paired.some(
              (sector) => Math.abs(angle - sector.bearing) <= sector.halfWidth,
            )
          )
            affectedAngles.add(angle);
        }
        let radialProbes = 0,
          minimumLaterDryClearance = Infinity,
          latestFirstDryRadius = 0;
        for (const angle of affectedAngles) {
          expect(getHeight(angle, 0)).toBeLessThan(pond.surfaceY);
          let firstDryRadius: number | null = null;
          for (let step = 1; step <= 220; step++) {
            const radius = step / 20;
            const height = getHeight(angle, radius);
            expect(Number.isFinite(height), `radial ${angle}/${radius}`).toBe(
              true,
            );
            if (firstDryRadius === null && height > pond.surfaceY) {
              firstDryRadius = radius;
              latestFirstDryRadius = Math.max(latestFirstDryRadius, radius);
            }
            if (firstDryRadius !== null) {
              expect(
                height,
                `later water pocket ${angle}/${radius}`,
              ).toBeGreaterThan(pond.surfaceY);
              minimumLaterDryClearance = Math.min(
                minimumLaterDryClearance,
                height - pond.surfaceY,
              );
            }
            radialProbes++;
          }
          expect(firstDryRadius, `no dry shoreline ${angle}`).not.toBeNull();
          expect(firstDryRadius!).toBeLessThanOrEqual(pond.radius);
        }
        // The new northern support crosses the Z=300 leaf boundary. Generate
        // BOTH real 100 m leaves, retaining the existing refinement policy.
        // These are production-generated retained triangles cooked in PhysX,
        // not an exercise of the live terrain click-collider ownership path.
        const leaves = [250, 350].map((centerZ) => {
          const centerX = 350,
            resolution = 128;
          const { geometry } = assembleQuadChunkGeometry(
            generateQuadChunkDataSync(
              centerX,
              centerZ,
              100,
              resolution,
              provider,
            ),
            provider,
            15,
          );
          const material = new THREE.MeshBasicMaterial();
          owned.push(geometry, material);
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(centerX, 0, centerZ);
          mesh.updateMatrixWorld(true);
          const surface = new RetainedTerrainSurface(
            review75
              ? 75
              : review74
                ? 74
                : review73
                  ? 73
                  : review69
                    ? 69
                    : review66
                      ? 66
                      : 52,
            provider.terrainProfileIdentity,
            centerX,
            centerZ,
            100,
            resolution,
            geometry,
          );
          const body = new RigidBody({
            type: "static",
            tag: `${candidate}-bank-${centerZ}`,
            position: [centerX, 0, centerZ],
          });
          bodies.push(body);
          const collider = new Collider({
            type: "geometry",
            geometry,
            convex: false,
            layer: "environment",
          });
          body.add(collider);
          body.activate(world);
          expect(body.actor).toBeTruthy();
          expect(collider.shape).toBeTruthy();
          return { centerX, centerZ, geometry, mesh, surface, body };
        });
        const angles = [
          ...new Set([
            ...paired.flatMap((sector) =>
              [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].map(
                (fraction) => sector.bearing + sector.halfWidth * fraction,
              ),
            ),
            // Retain a southern control as well as the actual changed shoulders.
            0.7,
          ]),
        ];
        const radii = [
          5.5,
          6,
          6.4,
          6.55,
          7,
          7.1,
          7.25,
          7.5,
          7.9,
          8.1,
          8.2,
          8.5,
          8.7,
          9,
          9.5,
          10,
          10.5,
          10.9,
          11,
          // Preserve all historical probes and add the candidate's new knots.
          ...(review66 ? [6.1, 6.8] : []),
          ...(review69 ? [5.6, 6.1, 6.6, 6.8, 7.35, 8.8, 9.6] : []),
          ...(review73 || review74 ? [6.3, 6.9, 7.6, 8.85] : []),
        ];
        const ray = new THREE.Raycaster();
        const down = new THREE.Vector3(0, -1, 0);
        const origin = new THREE.Vector3();
        const sample = { height: 0, nx: 0, ny: 0, nz: 0, faceIndex: 0 };
        let probes = 0,
          maximumCanonicalError = 0,
          maximumNativeSurfaceError = 0;
        let worstCanonicalSample: {
          angle: number;
          radius: number;
          x: number;
          z: number;
          retainedHeight: number;
          canonicalHeight: number;
        } | null = null;
        for (const angle of angles)
          for (const radius of radii) {
            origin.set(
              Math.fround(pond.centerX + Math.cos(angle) * radius),
              100,
              Math.fround(pond.centerZ + Math.sin(angle) * radius),
            );
            const leaf = leaves.find(
              (entry) =>
                origin.z >= entry.centerZ - 50 && origin.z < entry.centerZ + 50,
            )!;
            expect(leaf).toBeDefined();
            ray.set(origin, down);
            ray.far = 100;
            const visible = ray.intersectObject(leaf.mesh, false)[0];
            expect(visible).toBeTruthy();
            expect(
              leaf.surface.sample(
                origin.x - leaf.centerX,
                origin.z - leaf.centerZ,
                sample,
              ),
            ).toBe(true);
            expect(sample.height).toBeCloseTo(visible.point.y, 9);
            const canonicalHeight = provider.getHeightAtComputed(
              origin.x,
              origin.z,
            );
            const canonicalError = Math.abs(sample.height - canonicalHeight);
            if (canonicalError > maximumCanonicalError) {
              maximumCanonicalError = canonicalError;
              worstCanonicalSample = {
                angle,
                radius,
                x: origin.x,
                z: origin.z,
                retainedHeight: sample.height,
                canonicalHeight,
              };
            }
            const actual = world.physics.raycast(origin, down, 100);
            expect(actual).not.toBeNull();
            const normal = visible
              .face!.normal.clone()
              .transformDirection(leaf.mesh.matrixWorld);
            const surfaceError = Math.abs(
              actual!.point.clone().sub(visible.point).dot(normal),
            );
            const magnitude = Math.max(
              Math.abs(origin.x),
              Math.abs(origin.y),
              Math.abs(origin.z),
            );
            const ulp = 2 ** (Math.floor(Math.log2(magnitude)) - 23);
            expect(
              surfaceError,
              `native retained ${angle}/${radius}`,
            ).toBeLessThanOrEqual(8 * ulp);
            maximumNativeSurfaceError = Math.max(
              maximumNativeSurfaceError,
              surfaceError,
            );
            probes++;
          }
        if (review66 || compositionBank) {
          const ops = createCompactTerrainColorOperations();
          // Match the actual native selection, not a rejected material proposal.
          const field = compositionBank
            ? ops.macroField(
                profile,
                undefined,
                "composition-v1",
                terrain["compactPondBankField"]!,
              )
            : ops.macroField(profile, undefined, "relief-contact-v1");
          const admittedPond = ops.validatePond(pond);
          const bearings = [
            sectors[0].bearing,
            sectors[0].bearing - sectors[0].halfWidth,
            (sectors[0].bearing + sectors[3].bearing) / 2,
            sectors[3].bearing,
            sectors[3].bearing + sectors[3].halfWidth,
            sectors[1].bearing,
            sectors[2].bearing,
          ];
          const rows = bearings.flatMap((angle) =>
            radii.map((radius) => {
              const x = Math.fround(pond.centerX + Math.cos(angle) * radius);
              const z = Math.fround(pond.centerZ + Math.sin(angle) * radius);
              const leaf = leaves.find(
                (entry) => z >= entry.centerZ - 50 && z < entry.centerZ + 50,
              )!;
              expect(leaf).toBeDefined();
              expect(
                leaf.surface.sample(x - leaf.centerX, z - leaf.centerZ, sample),
              ).toBe(true);
              const height = provider.getHeightAtComputed(x, z);
              const distance = GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE;
              const dx =
                (provider.getHeightAtComputed(x + distance, z) -
                  provider.getHeightAtComputed(x - distance, z)) /
                (2 * distance);
              const dz =
                (provider.getHeightAtComputed(x, z + distance) -
                  provider.getHeightAtComputed(x, z - distance)) /
                (2 * distance);
              const workerSlope = 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);
              const input = {
                noiseValue: sampleNoiseCPU(
                  x,
                  z,
                  TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
                ),
                distortNoise: sampleNoiseCPU(
                  x,
                  z,
                  TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
                ),
                meadowNoise: sampleNoiseCPU(
                  x,
                  z,
                  COMPACT_TERRAIN_COMPOSITION.meadowNoiseScale,
                ),
                slope: workerSlope,
                roadInfluence: provider.calculateRoadInfluenceAtVertex(
                  x,
                  z,
                  0,
                  0,
                ),
                surface: {
                  x,
                  z,
                  height,
                  pond: admittedPond,
                  macroField: field,
                },
              };
              const margin = ops.pondMarginAt(input);
              const historical = ops.pondWeights({
                ...input.surface,
                noiseValue: input.distortNoise,
              });
              const selected = ops.pondWeights(
                { ...input.surface, noiseValue: input.distortNoise },
                field?.pondDistribution,
                margin,
              );
              expect(selected.wetness).toBe(historical.wetness);
              const row = {
                angle,
                radius,
                x,
                z,
                canonicalHeight: height,
                retainedHeight: sample.height,
                retainedFaceSlope: 1 - Math.abs(sample.ny),
                workerSlope,
                roadInfluence: input.roadInfluence,
                originalSoil: historical.soil,
                selectedSoil: selected.soil,
                wetness: selected.wetness,
                marginCover: margin.cover,
                marginExposure: margin.exposure,
                supportBeforeCoast: ops.grassSupportBeforeCoast(input),
                selectedSupport: ops.grassSupport(input),
                ...(compositionBank ? ops.bankCompositionAt(input) : {}),
              };
              expect(Object.values(row).every(Number.isFinite)).toBe(true);
              return row;
            }),
          );
          process.stdout.write(
            JSON.stringify({
              [`${candidate}Transect`]: {
                coastBlend: null,
                pondBlend: compositionBank
                  ? "composition-v1"
                  : "relief-contact-v1",
                scope:
                  "CPU canonical/indexed face and palette proxy; not native shader interpolation, texture-height competition or continuous bank-width proof",
                rows,
              },
            }) + "\n",
          );
        }
        if (compositionBank) {
          const authored = createAuthoredTerrainSurfaceOperations();
          expect(compositionBaselineZone).toBeDefined();
          let unchangedSouthernSamples = 0;
          // Same underlying owner and candidate order; replace only the pond's
          // two authored rows in memory. No second World or alternate height solver.
          for (let degrees = 0; degrees <= 180; degrees += 5)
            for (let quarter = 20; quarter <= 44; quarter++) {
              const angle = (degrees * Math.PI) / 180;
              const radius = quarter / 4;
              const x = pond.centerX + Math.cos(angle) * radius;
              const z = pond.centerZ + Math.sin(angle) * radius;
              const current = terrain["getAuthoredSurfaceCandidates"](x, z);
              const prior = current.map((entry) =>
                entry.id === zone.id ? compositionBaselineZone! : entry,
              );
              const solve = (entries: readonly FlatZone[]) =>
                authored.resolveHeight(
                  entries,
                  x,
                  z,
                  () => terrain.getProceduralHeightAt(x, z),
                  terrain["arenaFloorZoneIds"],
                  terrain["arenaGradeHeight"],
                );
              expect(
                solve(current),
                `southern geometry ${degrees}/${radius}`,
              ).toBe(solve(prior));
              unchangedSouthernSamples++;
            }
          expect(unchangedSouthernSamples).toBe(925);
          process.stdout.write(
            JSON.stringify({
              [`${candidate}SouthernGeometry`]: {
                unchangedSamples: unchangedSouthernSamples,
                source:
                  "Review68 copied zone with identical underlying owner and candidate ordering",
              },
            }) + "\n",
          );
        }
        for (const leaf of leaves) leaf.body.deactivate();
        expect(world.physics.raycast(origin, down, 100)).toBeNull();
        process.stdout.write(
          JSON.stringify({
            [`${candidate}RetainedBank`]: {
              waterEdgeRays: 360,
              affectedAngles: affectedAngles.size,
              radialProbes,
              minimumWaterEdgeClearance,
              minimumLaterDryClearance,
              latestFirstDryRadius,
              probes,
              maximumCanonicalError,
              worstCanonicalSample,
              maximumNativeSurfaceError,
              leaves: leaves.map((leaf) => ({
                centerX: leaf.centerX,
                centerZ: leaf.centerZ,
                triangles: leaf.geometry.index!.count / 3,
              })),
              liveTerrainCollisionOwnerExercised: false,
            },
          }) + "\n",
        );
        // Keep the pre-existing 2 cm gate, including the previously untested
        // 7.9–11 m shoulder. A failed candidate requires a real owner fix.
        expect(
          maximumCanonicalError,
          JSON.stringify(worstCanonicalSample),
        ).toBeLessThanOrEqual(0.02);
      },
      60000,
    );

    it.skipIf(!review49)(
      "keeps the loaded review49 water boundary covered and its retained bank triangles consistent with native cooking",
      async () => {
        const { world, terrain } = await terrainFixture();
        await world.physics.init();
        const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
        const profile = terrain["flatZones"].get("haven_pond_floor")!;
        expect(profile.radialPond!.bankSectors).toHaveLength(3);
        const provider = terrain["buildChunkTerrainProvider"]();
        let minimumWaterEdgeClearance = Infinity;
        // The actual admitted source must rise above the unchanged water disk on
        // every ray, including the original sectors and their warped shoulders.
        for (let degrees = 0; degrees < 360; degrees++) {
          const angle = (degrees * Math.PI) / 180;
          const edge = provider.getHeightAtComputed(
            pond.centerX + Math.cos(angle) * pond.radius,
            pond.centerZ + Math.sin(angle) * pond.radius,
          );
          expect(edge).toBeGreaterThan(pond.surfaceY);
          minimumWaterEdgeClearance = Math.min(
            minimumWaterEdgeClearance,
            edge - pond.surfaceY,
          );
        }
        // The changed sector is entirely in the existing 100 m / 128 leaf.
        // Cook the exact production-generated retained triangles, not an analytic
        // plane or the coarser runtime click collider. Runtime ownership is not
        // exercised by this isolated cooking test.
        const centerX = 350,
          centerZ = 350,
          resolution = 128;
        const { geometry } = assembleQuadChunkGeometry(
          generateQuadChunkDataSync(
            centerX,
            centerZ,
            100,
            resolution,
            provider,
          ),
          provider,
          15,
        );
        const material = new THREE.MeshBasicMaterial();
        owned.push(geometry, material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(centerX, 0, centerZ);
        mesh.updateMatrixWorld(true);
        const surface = new RetainedTerrainSurface(
          49,
          provider.terrainProfileIdentity,
          centerX,
          centerZ,
          100,
          resolution,
          geometry,
        );
        const body = new RigidBody({
          type: "static",
          tag: "review49-bank",
          position: [centerX, 0, centerZ],
        });
        bodies.push(body);
        const collider = new Collider({
          type: "geometry",
          geometry,
          convex: false,
          layer: "environment",
        });
        body.add(collider);
        body.activate(world);
        expect(body.actor).toBeTruthy();
        expect(collider.shape).toBeTruthy();
        const ray = new THREE.Raycaster();
        const down = new THREE.Vector3(0, -1, 0);
        const origin = new THREE.Vector3();
        const sample = { height: 0, nx: 0, ny: 0, nz: 0, faceIndex: 0 };
        let probes = 0,
          maximumCanonicalError = 0,
          maximumNativeSurfaceError = 0;
        for (const angle of [0.15, 0.4, 0.7, 1, 1.25])
          for (const radius of [6.5, 7, 7.25, 7.5, 8, 8.5, 9, 10]) {
            origin.set(
              Math.fround(pond.centerX + Math.cos(angle) * radius),
              100,
              Math.fround(pond.centerZ + Math.sin(angle) * radius),
            );
            ray.set(origin, down);
            ray.far = 100;
            const visible = ray.intersectObject(mesh, false)[0];
            expect(visible).toBeTruthy();
            expect(
              surface.sample(origin.x - centerX, origin.z - centerZ, sample),
            ).toBe(true);
            expect(sample.height).toBeCloseTo(visible.point.y, 9);
            const canonicalError = Math.abs(
              sample.height - provider.getHeightAtComputed(origin.x, origin.z),
            );
            // Existing retained pond-profile admission is 2 cm; do not widen it
            // just to admit this new shoulder.
            expect(canonicalError).toBeLessThanOrEqual(0.02);
            maximumCanonicalError = Math.max(
              maximumCanonicalError,
              canonicalError,
            );
            const actual = world.physics.raycast(origin, down, 100);
            expect(actual).not.toBeNull();
            const normal = visible
              .face!.normal.clone()
              .transformDirection(mesh.matrixWorld);
            const surfaceError = Math.abs(
              actual!.point.clone().sub(visible.point).dot(normal),
            );
            const magnitude = Math.max(
              Math.abs(origin.x),
              Math.abs(origin.y),
              Math.abs(origin.z),
            );
            const ulp = 2 ** (Math.floor(Math.log2(magnitude)) - 23);
            expect(surfaceError).toBeLessThanOrEqual(8 * ulp);
            maximumNativeSurfaceError = Math.max(
              maximumNativeSurfaceError,
              surfaceError,
            );
            probes++;
          }
        body.deactivate();
        expect(world.physics.raycast(origin, down, 100)).toBeNull();
        process.stdout.write(
          JSON.stringify({
            review49RetainedBank: {
              probes,
              minimumWaterEdgeClearance,
              maximumCanonicalError,
              maximumNativeSurfaceError,
              triangles: geometry.index!.count / 3,
              liveTerrainCollisionOwnerExercised: false,
            },
          }) + "\n",
        );
      },
      60000,
    );

    it("reports every exact candidate rock support and retains the four workshop entries", async () => {
      const descriptor = config.compactLandscapeRocks!;
      expect(validateCompactLandscapeRocks(descriptor, profile)).toEqual(
        descriptor,
      );
      const original = JSON.parse(
        readFileSync(
          resolve(
            process.cwd(),
            "../../../asset-studio/fine-meadow01/southern-meadow-world20/manifests/world-config.json",
          ),
          "utf8",
        ),
      ) as WorldConfigManifest;
      expect(descriptor.rocks).toHaveLength(17);
      expect(
        descriptor.rocks.filter((p) => p.id.startsWith("workshop-")),
      ).toEqual(
        original.compactLandscapeRocks!.rocks.filter((p) =>
          p.id.startsWith("workshop-"),
        ),
      );
      expect(
        descriptor.rocks.map(({ id, variant, yaw }) => ({ id, variant, yaw })),
      ).toEqual(
        original.compactLandscapeRocks!.rocks.map(({ id, variant, yaw }) => ({
          id,
          variant,
          yaw,
        })),
      );
      const { terrain } = await terrainFixture();
      const geometry = await createCompactRockCollisionGeometry();
      owned.push(...geometry.values());
      console.info(
        JSON.stringify({
          [`${candidate}SourceBounds`]: [...geometry].map(
            ([variant, mesh]) => ({
              variant,
              min: mesh.boundingBox!.min.toArray(),
              max: mesh.boundingBox!.max.toArray(),
            }),
          ),
        }),
      );
      const pond =
        DataManager.getInstance().getWorldArea("haven_pond")!.waterBodies![0];
      const footprints = createCompactLandscapeRockFootprints(descriptor);
      const failures: { id: string; reason: string }[] = [];
      const report: object[] = [];
      for (const p of descriptor.rocks) {
        let observedMinimum = Infinity,
          observedMaximum = -Infinity,
          observedSamples = 0;
        let minimumPoint: { x: number; z: number } | null = null,
          maximumPoint: { x: number; z: number } | null = null;
        try {
          const record = groundCompactLandscapeRocks(
            { ...descriptor, rocks: [p] },
            geometry,
            (x, z) => {
              const height = terrain.getHeightAt(x, z);
              if (height < observedMinimum) {
                observedMinimum = height;
                minimumPoint = { x, z };
              }
              if (height > observedMaximum) {
                observedMaximum = height;
                maximumPoint = { x, z };
              }
              observedSamples++;
              return height;
            },
          );
          const support = record.support[0];
          const footprint = footprints.find((f) => f.id === p.id)!;
          const maximumZ = Math.max(...footprint.vertices.map((v) => v.z));
          report.push({
            ...p,
            y: record.placements[0].y,
            samples: support.samples,
            relief: support.maximum - support.minimum,
            minimum: support.minimum,
            maximum: support.maximum,
            clearanceAboveWater: support.minimum - pond.surfaceY,
            maximumZ,
            occupiedTiles: record.blockingTiles,
          });
          if (p.id.startsWith("pond-")) {
            if (maximumZ >= pond.centerZ)
              failures.push({
                id: p.id,
                reason: `all-LOD footprint crosses south: ${maximumZ}`,
              });
            if (support.minimum < pond.surfaceY)
              failures.push({
                id: p.id,
                reason: `dry outcrop support below water: ${support.minimum}`,
              });
          }
        } catch (error) {
          if (compositionBank) {
            const box = geometry.get(p.variant)!.boundingBox!;
            const maximumAllowedRelief =
              0.8 * (box.max.y - box.min.y) * p.scale - 0.08 - 0.15;
            report.push({
              ...p,
              failed: true,
              observedSamples,
              minimum: observedMinimum,
              maximum: observedMaximum,
              minimumPoint,
              maximumPoint,
              relief: observedMaximum - observedMinimum,
              maximumAllowedRelief,
              excessRelief:
                observedMaximum - observedMinimum - maximumAllowedRelief,
            });
          }
          failures.push({
            id: p.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      console.info(
        JSON.stringify({ [`${candidate}Support`]: report, failures }),
      );
      if (
        (review52 &&
          process.env.HYPERIA_POND_ROCK_SUPPORT_REVIEW ===
            "review52-proposals-v1") ||
        (review73 &&
          process.env.HYPERIA_POND_ROCK_SUPPORT_REVIEW ===
            "review73-proposals-v1")
      ) {
        // Explicit bounded authoring probes only. Never replace admitted poses,
        // relax the production owner or let a passing proposal hide its failure.
        const proposals = review73
          ? [
              { id: "pond-west-02", positions: [[336.3, 296]] },
              {
                id: "pond-north-03",
                positions: [
                  [337.1, 294.7],
                  [337.1, 294.3],
                ],
              },
            ]
          : [
              {
                id: "pond-west-03",
                positions: [
                  [337.9, 296.8],
                  [337.5, 296.4],
                  [337.3, 296.1],
                  [337.6, 296],
                  [337.9, 295.7],
                  [337.5, 295.8],
                ],
              },
              {
                id: "pond-west-04",
                positions: [
                  [338.5, 295.7],
                  [338.2, 295.3],
                  [338, 295],
                  [338.5, 295],
                  [338.8, 294.9],
                  [338.5, 294.6],
                ],
              },
              {
                id: "pond-north-03",
                positions: [
                  [340, 295.35],
                  [336.8, 294.9],
                  [337, 294.9],
                  [337.1, 295.1],
                  [337, 294.6],
                ],
              },
              {
                id: "pond-north-04",
                positions: [
                  [341.45, 294.4],
                  [337.8, 293.8],
                  [338, 293.5],
                  [337.7, 294.1],
                  [337.3, 294.1],
                ],
              },
            ];
        const rows = proposals.flatMap(({ id, positions }) =>
          positions.map(([x, z]) => {
            const source = descriptor.rocks.find((rock) => rock.id === id)!;
            const placement = { ...source, x, z };
            let minimum = Infinity,
              maximum = -Infinity,
              samples = 0;
            let error: string | null = null;
            let blockingTiles: readonly { x: number; z: number }[] = [];
            try {
              const result = groundCompactLandscapeRocks(
                { ...descriptor, rocks: [placement] },
                geometry,
                (px, pz) => {
                  const height = terrain.getHeightAt(px, pz);
                  minimum = Math.min(minimum, height);
                  maximum = Math.max(maximum, height);
                  samples++;
                  return height;
                },
              );
              blockingTiles = result.blockingTiles;
            } catch (failure) {
              error =
                failure instanceof Error ? failure.message : String(failure);
            }
            const box = geometry.get(placement.variant)!.boundingBox!;
            const maximumZ = Math.max(
              ...createCompactLandscapeRockFootprints({
                ...descriptor,
                rocks: [placement],
              })[0].vertices.map((vertex) => vertex.z),
            );
            return {
              ...placement,
              error,
              samples,
              minimum,
              maximum,
              relief: maximum - minimum,
              // Same exposed-top arithmetic as the actual owner, using the exact
              // heights observed through its callback even when it rejects.
              exposedTopAboveHighestSupport:
                0.8 * (box.max.y - box.min.y) * placement.scale -
                0.08 -
                (maximum - minimum),
              waterMargin: minimum - pond.surfaceY,
              southernMargin: pond.centerZ - maximumZ,
              blockingTiles,
            };
          }),
        );
        console.info(
          JSON.stringify({ [`${candidate}ExplicitRockProposals`]: rows }),
        );
      }
      expect(failures).toEqual([]);
      const complete = groundCompactLandscapeRocks(
        descriptor,
        geometry,
        (x, z) => terrain.getHeightAt(x, z),
      );
      expect(complete.placements).toHaveLength(17);
      expect(complete.blockingTiles.length).toBeLessThanOrEqual(256);
      console.info(
        JSON.stringify({ [`${candidate}Occupancy`]: complete.blockingTiles }),
      );
    });

    it.skipIf(!pairedBank)(
      "admits the 40-instance northern planting while retaining full underwater and southern-clearance guards",
      async () => {
        const { terrain } = await terrainFixture();
        const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
        // Invoke the real fail-closed factory over the admitted terrain. Its
        // disk lattice checks must pass without sliding or removing instances.
        const placements = createCompactPondDressing(
          profile,
          ALL_WORLD_AREAS,
          (x, z) => terrain.getHeightAt(x, z),
        );
        expect(placements).toHaveLength(40);
        expect(new Set(placements.map((row) => row.id)).size).toBe(40);
        expect(
          Object.fromEntries(
            Object.keys(COMPACT_POND_MODELS).map((model) => [
              model,
              placements.filter((row) => row.model === model).length,
            ]),
          ),
        ).toEqual({
          boulder: 4,
          stone: 6,
          fern: 8,
          bush: 3,
          reed: 15,
          sorrel: 4,
        });
        let minimumRockWaterClearance = Infinity;
        let minimumSouthernClearance = Infinity;
        for (const row of placements) {
          const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
          expect(row.z + radius, row.id).toBeLessThan(pond.centerZ);
          minimumSouthernClearance = Math.min(
            minimumSouthernClearance,
            pond.centerZ - row.z - radius,
          );
          expect(
            Number.isFinite(terrain.getHeightAt(row.x, row.z)),
            row.id,
          ).toBe(true);
          if (row.model !== "boulder" && row.model !== "stone") continue;
          expect(
            Math.hypot(row.x - pond.centerX, row.z - pond.centerZ) + radius,
            row.id,
          ).toBeLessThan(pond.radius);
          // Add disk-boundary and center probes to the factory's full interior
          // lattice admission, retaining its unchanged 4 cm underwater margin.
          for (let index = -1; index < 64; index++) {
            const angle = (index * Math.PI) / 32;
            const x = row.x + (index < 0 ? 0 : Math.cos(angle) * radius);
            const z = row.z + (index < 0 ? 0 : Math.sin(angle) * radius);
            const height = terrain.getHeightAt(x, z);
            expect(height, `${row.id} disk ${index}`).toBeLessThan(
              pond.surfaceY - 0.04,
            );
            minimumRockWaterClearance = Math.min(
              minimumRockWaterClearance,
              pond.surfaceY - height,
            );
          }
        }
        process.stdout.write(
          JSON.stringify({
            [`${candidate}Dressing`]: {
              placements,
              minimumRockWaterClearance,
              minimumSouthernClearance,
              actualVisualModelContactExercised: false,
            },
          }) + "\n",
        );
      },
    );

    it("keeps actual resource/station approaches and southern fishing access reachable with native rock occupancy", async () => {
      const { world, terrain } = await terrainFixture();
      await world.physics.init();
      const manager = world.register(
        "entity-manager",
        EntityManager,
      ) as EntityManager;
      const roads = world.register(
        "roads",
        RoadNetworkSystem,
      ) as RoadNetworkSystem;
      const resources = world.register(
        "resource",
        ResourceSystem,
      ) as ResourceSystem;
      const stations = world.register(
        "station-spawner",
        StationSpawnerSystem,
      ) as StationSpawnerSystem;
      const court = world.register(
        COMPACT_SERVICE_COURT_SYSTEM,
        CompactServiceCourtSystem,
      ) as CompactServiceCourtSystem;
      const rocks = world.register(
        COMPACT_LANDSCAPE_ROCKS_SYSTEM,
        CompactLandscapeRocksSystem,
      ) as CompactLandscapeRocksSystem;
      await roads.init();
      await resources.init();
      await court.init();
      await rocks.init();
      await roads.start();
      await terrain.start();
      // This CPU owner fixture has no listening ServerNetwork. Invoke the actual
      // terrain owner over its generated tiles; never synthesize collision flags.
      // This validates resulting navigation, not network/server startup ordering.
      for (const tile of terrain.getTiles().values())
        terrain["bakeWalkabilityFlags"](tile.x, tile.z);
      const settle = () =>
        Promise.all([...resources["terrainResourceTails"].values()]);
      await settle();
      await resources["initializeWorldAreaResources"]();
      await settle();
      await stations.start();
      await court.start();
      const census = resources.getAllResources();
      expect(census.filter((r) => r.type === "tree")).toHaveLength(48);
      if (pairedBank)
        expect(census.filter((r) => r.type === "fishing_spot")).toHaveLength(5);
      const subjects = census
        .filter((r) => r.type !== "fishing_spot")
        .map((r) => {
          expect(manager.getEntity(r.id), r.id).toBeInstanceOf(ResourceEntity);
          return { id: r.id, position: r.position, width: 1, depth: 1 };
        });
      for (const station of Object.values(ALL_WORLD_AREAS).flatMap(
        (a) => a.stations ?? [],
      )) {
        expect(
          manager.getEntity(`station_${station.id}`),
          station.id,
        ).toBeTruthy();
        const footprint = resolveFootprint(
          stationDataProvider.getFootprint(station.type),
        );
        subjects.push({
          id: `station_${station.id}`,
          position: station.position,
          width: footprint.x,
          depth: footprint.z,
        });
      }
      const walkable = (p: TileCoord, from?: TileCoord) =>
        p.x >= 250 &&
        p.x < 550 &&
        p.z >= 250 &&
        p.z < 550 &&
        !isPositionInsideCombatArena(p.x + 0.5, p.z + 0.5) &&
        world.collision.isWalkable(p.x, p.z) &&
        (!from || !world.collision.isBlocked(from.x, from.z, p.x, p.z));
      const approaches = subjects.map((s) => ({
        id: s.id,
        tiles: getCardinalAdjacentTiles(
          worldToTile(s.position.x, s.position.z),
          s.width,
          s.depth,
        ).filter((t) => walkable(t)),
      }));
      for (const row of approaches)
        expect(row.tiles.length, row.id).toBeGreaterThan(0);
      if (pairedBank) {
        expect(subjects).toHaveLength(69);
        expect(
          approaches.reduce((count, row) => count + row.tiles.length, 0),
        ).toBe(293);
      }
      const pond = ALL_WORLD_AREAS.haven_pond;
      const southFishing: TileCoord[] = [];
      for (
        let z = Math.ceil(pond.waterBodies![0].centerZ);
        z <= pond.bounds.maxZ;
        z++
      )
        for (let x = pond.bounds.minX; x <= pond.bounds.maxX; x++) {
          const p = { x, z };
          if (
            walkable(p) &&
            getCardinalAdjacentTiles(p, 1, 1).some((n) =>
              world.collision.hasFlags(n.x, n.z, CollisionFlag.WATER),
            )
          )
            southFishing.push(p);
        }
      expect(southFishing.length).toBeGreaterThan(0);
      if (pairedBank) {
        const protectedSouthernTiles = [
          [302, [334, 350]],
          [303, [334, 350]],
          [304, [334, 350]],
          [305, [334, 350]],
          [306, [334, 350]],
          [307, [335, 336, 349]],
          [308, [337, 338, 339, 340, 341, 347, 348]],
          [309, [341, 347]],
          [310, [342, 343, 344, 345, 346]],
        ] as const;
        expect(southFishing).toEqual(
          protectedSouthernTiles.flatMap(([z, xs]) =>
            xs.map((x) => ({ x, z })),
          ),
        );
        expect(southFishing).toHaveLength(27);
      }
      const outerPond: TileCoord[] = [
        { x: 332, z: 309 },
        { x: 330, z: 295 },
        { x: 343, z: 290 },
        { x: 354, z: 295 },
        { x: 354, z: 309 },
      ];
      const starts = [
        { x: 348, z: 322 },
        ...[
          getDuelArenaLobbyReturnPosition(true),
          getDuelArenaLobbyReturnPosition(false),
          getDuelArenaEgressPosition(),
        ].map((p) => worldToTile(p.x, p.z)),
      ];
      const targets = [
        ...approaches.flatMap((row) =>
          row.tiles.map((tile) => ({ label: row.id, tile })),
        ),
        ...southFishing.map((tile) => ({ label: "southern-fishing", tile })),
        ...outerPond.map((tile) => ({ label: "outer-pond", tile })),
      ];
      const bfs = new BFSPathfinder();
      const route = (start: TileCoord, target: TileCoord, label: string) => {
        expect(walkable(start), `${label} start`).toBe(true);
        expect(walkable(target), `${label} target`).toBe(true);
        let cursor = start,
          edges = 0,
          offRoad = 0,
          longestOffRoad = 0;
        const seen = new Set<string>();
        for (
          let part = 0;
          part < 12 && (cursor.x !== target.x || cursor.z !== target.z);
          part++
        ) {
          const segment = bfs.findPath(cursor, target, walkable);
          expect(segment.length, label).toBeGreaterThan(0);
          for (const tile of segment) {
            expect(
              Math.max(
                Math.abs(tile.x - cursor.x),
                Math.abs(tile.z - cursor.z),
              ),
              label,
            ).toBe(1);
            expect(walkable(tile, cursor), label).toBe(true);
            offRoad =
              roads.getRoadInfluenceAt(tile.x + 0.5, tile.z + 0.5) === 0 &&
              roads.getRoadInfluenceAt(cursor.x + 0.5, cursor.z + 0.5) === 0
                ? offRoad + 1
                : 0;
            longestOffRoad = Math.max(longestOffRoad, offRoad);
            cursor = tile;
            edges++;
          }
          const key = `${cursor.x},${cursor.z}`;
          expect(seen.has(key), label).toBe(false);
          seen.add(key);
        }
        expect(cursor, label).toEqual(target);
        return { edges, longestOffRoad };
      };
      // Establish reachable approaches before adding this candidate's real owner.
      for (const row of targets)
        route(starts[0], row.tile, `before ${row.label}`);
      const baselineFlags = new Map(
        southFishing.map((p) => [
          `${p.x},${p.z}`,
          world.collision.getFlags(p.x, p.z),
        ]),
      );
      await rocks.start();
      expect(rocks.getDiagnostics()).toMatchObject({
        physicsActors: 17,
        physicsShapes: 17,
        collisionGeometries: 3,
      });
      for (const tile of rocks.getRocks()!.blockingTiles)
        expect(walkable(tile)).toBe(false);
      let routes = 0,
        edges = 0,
        longestOffRoad = 0;
      for (const start of starts)
        for (const row of targets) {
          const result = route(start, row.tile, `candidate ${row.label}`);
          routes++;
          edges += result.edges;
          longestOffRoad = Math.max(longestOffRoad, result.longestOffRoad);
        }
      for (let i = 0; i < outerPond.length; i++)
        route(
          outerPond[i],
          outerPond[(i + 1) % outerPond.length],
          "outer-pond circulation",
        );
      if (pairedBank) expect(routes).toBe(1300);
      for (const p of southFishing)
        expect(world.collision.getFlags(p.x, p.z)).toBe(
          baselineFlags.get(`${p.x},${p.z}`),
        );
      expect(longestOffRoad).toBeGreaterThanOrEqual(8);
      expect(resources.getAllResources()).toEqual(census);
      process.stdout.write(
        JSON.stringify({
          [`${candidate}Navigation`]: {
            subjects: subjects.length,
            approaches: approaches.reduce((n, row) => n + row.tiles.length, 0),
            southernFishingTiles: southFishing,
            outerPond,
            routes,
            edges,
            longestOffRoad,
            resourceCounts: {
              trees: census.filter((r) => r.type === "tree").length,
              fish: census.filter((r) => r.type === "fishing_spot").length,
            },
            nativeOwner: rocks.getDiagnostics(),
          },
        }) + "\n",
      );
    }, 60000);
  },
);
