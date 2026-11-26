import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { resolveCompactCoastBlend } from "../../../../runtime/clientViewportMode";
import { ALL_WORLD_AREAS, type WorldArea } from "../../../../data/world-areas";
import type { FlatZone } from "../../../../types/world/terrain";
import studyRecipe from "../__fixtures__/inland-pond-basin-candidate.json";
import { createCompactPondDressing } from "../CompactPondDressing";
import {
  COMPACT_TERRAIN_COMPOSITION,
  createCompactTerrainColorOperations,
} from "../CompactTerrainPalette";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainSystem } from "../TerrainSystem";
import { sampleNoiseCPU, TERRAIN_SHADER_CONSTANTS } from "../TerrainShader";

type PondManifest = { level1Areas: Record<string, WorldArea> };

function pondZone(manifest: PondManifest): FlatZone {
  const zone = manifest.level1Areas.haven_pond.flatZones?.find(
    (row) => row.id === "haven_pond_floor",
  );
  if (!zone?.radialPond?.bankComposition || typeof zone.height !== "number")
    throw new Error("Shelf trial requires the complete actual pond manifest");
  return { ...zone, height: zone.height };
}

function sourceReceipt(path: string) {
  const bytes = readFileSync(path);
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("isolated real-manifest eastern pond shelf groundcover study", () => {
  it.skipIf(
    !process.env.ASSETS_DIR ||
      basename(resolve(process.env.ASSETS_DIR)) !== "assets-v9" ||
      basename(dirname(resolve(process.env.ASSETS_DIR))) !==
        "inland-pond-integration01-UNQUALIFIED",
  )(
    "bounds actual v9 material and CPU placement changes while v8 physical shore, roads and habitat remain exact",
    async () => {
      const assets = resolve(process.env.ASSETS_DIR!);
      const previousAssets = join(dirname(assets), "assets-v8");
      const manifestPaths = [previousAssets, assets].map((directory) =>
        join(directory, "manifests/world-areas.json"),
      );
      const manifests = manifestPaths.map(
        (path) => JSON.parse(readFileSync(path, "utf8")) as PondManifest,
      );
      const zones = manifests.map(pondZone);
      const recipe = studyRecipe.easternShelfGroundCoverStudy;
      expect(recipe).toMatchObject({
        flatZoneId: "haven_pond_floor",
        sectorIndex: 1,
        before: { emergenceHeight: 0.08, fullHeight: 0.2 },
        after: { emergenceHeight: 0.04, fullHeight: 0.12 },
      });
      const covers = zones.map((zone) =>
        zone.radialPond!.bankComposition!.sectors.find(
          (row) => row.sectorIndex === recipe.sectorIndex,
        ),
      );
      expect(covers[0]).toEqual({
        sectorIndex: 1,
        surface: "sedge-shelf",
        groundCover: recipe.before,
      });
      expect(covers[1]).toEqual({
        sectorIndex: 1,
        surface: "sedge-shelf",
        groundCover: recipe.after,
      });
      const restored = structuredClone(manifests[1]);
      const restoredZone = restored.level1Areas.haven_pond.flatZones!.find(
        (row) => row.id === recipe.flatZoneId,
      )!;
      Object.assign(
        restoredZone.radialPond!.bankComposition!.sectors.find(
          (row) => row.sectorIndex === recipe.sectorIndex,
        )!,
        { groundCover: recipe.before },
      );
      expect(restored).toEqual(manifests[0]);
      expect(readFileSync(join(assets, "manifests/world-config.json"))).toEqual(
        readFileSync(join(previousAssets, "manifests/world-config.json")),
      );
      expect(zones[0].radialPond!.bankSectors).toEqual(
        zones[1].radialPond!.bankSectors,
      );
      await DataManager.getInstance().initialize();
      // The actual native pond URL does not select coastBlend. Omission is
      // undefined, not distribution-v1; do not add an unrelated art trial.
      expect(resolveCompactCoastBlend()).toBeUndefined();
      const area = ALL_WORLD_AREAS.haven_pond;
      const originalZones = area.flatZones;
      expect(originalZones).toEqual(
        manifests[1].level1Areas.haven_pond.flatZones,
      );
      const config = DataManager.getWorldConfig()!;
      if (!config.compactPondDocks)
        throw new Error("Actual shelf trial requires the admitted dock layout");
      const worlds: World[] = [];
      const owners: Array<{
        terrain: TerrainSystem;
        roads: RoadNetworkSystem;
        placements: ReturnType<typeof createCompactPondDressing>;
      }> = [];
      try {
        // Composition is a sealed startup owner. Admit each exact real manifest
        // before init, rather than bypassing its deliberate hot-swap rejection.
        // Shared data references are restored even when admission throws.
        for (const manifest of manifests) {
          area.flatZones = structuredClone(
            manifest.level1Areas.haven_pond.flatZones,
          );
          const world = new World();
          worlds.push(world);
          const terrain = world.register(
            "terrain",
            TerrainSystem,
          ) as TerrainSystem;
          const roads = world.register(
            "roads",
            RoadNetworkSystem,
          ) as RoadNetworkSystem;
          terrain["compactPondBlend"] = "composition-v1";
          terrain["compactSurfaceBlend"] = "height-v1";
          terrain["compactCoastBlend"] = null;
          terrain["compactDirtProjection"] = "stochastic-v1";
          terrain["compactRockProjection"] = "stochastic-v1";
          terrain["compactGrassColorGrade"] = "fine-meadow-green-v1";
          await terrain.init();
          terrain["subscribeRoadNetworkEvents"]();
          await roads.init();
          await roads.start();
          expect(terrain["flatZones"].get(recipe.flatZoneId)).toMatchObject(
            pondZone(manifest),
          );
          const field = terrain["compactPondBankField"]!;
          expect(field.id).toBe("composition-v1");
          expect(Object.isFrozen(field)).toBe(true);
          expect(field.sectors[1].groundCover).toEqual(
            pondZone(manifest).radialPond!.bankComposition!.sectors[1]
              .groundCover,
          );
          const setup = terrain["buildGrassWorkerSetup"]();
          expect(setup.compactPondBankField).toEqual(field);
          expect(setup.compactPondBlend).toBe("composition-v1");
          expect(setup.compactCoastBlend).toBeUndefined();
          expect(() =>
            terrain.registerFlatZone(
              pondZone(manifests[manifest === manifests[0] ? 1 : 0]),
            ),
          ).toThrow("Bound pond composition terrain changes require restart");
          owners.push({
            terrain,
            roads,
            placements: createCompactPondDressing(
              terrain.getWorldTerrainProfile(),
              ALL_WORLD_AREAS,
              (x, z) => terrain.getResourceGroundHeight(x, z),
              config.compactPondDocks,
            ),
          });
        }
        area.flatZones = originalZones;
        const [before, after] = owners;
        expect(before.placements).toHaveLength(28);
        expect(after.placements).toEqual(before.placements);
        expect(after.roads.getRoads()).toEqual(before.roads.getRoads());
        expect(after.roads.getRoadSegmentsForGPU()).toEqual(
          before.roads.getRoadSegmentsForGPU(),
        );
        const beforeMask = before.roads.getRoadInfluenceTextureData();
        expect(beforeMask).not.toBeNull();
        expect(after.roads.getRoadInfluenceTextureData()).toEqual(beforeMask);
        expect(after.terrain.getWaterBodyRegistry().getAllBodies()).toEqual(
          before.terrain.getWaterBodyRegistry().getAllBodies(),
        );
        const providers = owners.map(({ terrain }) =>
          terrain["buildChunkTerrainProvider"](),
        );
        expect(providers[1].surfaceRefinementAnnuli).toEqual(
          providers[0].surfaceRefinementAnnuli,
        );
        expect(providers[1].surfaceRefinementZones).toEqual(
          providers[0].surfaceRefinementZones,
        );
        const leases = owners.map(({ terrain }) =>
          terrain.captureCanonicalGroundLease(),
        );
        const macros = owners.map(({ terrain }) =>
          terrain["getCompactMacroMaterial"](),
        );
        const op = createCompactTerrainColorOperations();
        const pond = after.terrain["compactPondBankField"]!.pond;
        const sector = zones[1].radialPond!.bankSectors![recipe.sectorIndex];
        const counts = {
          samples: 0,
          physicalExact: 0,
          outsideDeltaDomainExact: 0,
          materialChanged: 0,
          cpuPlacementIncreased: 0,
          beforePositiveCpuPlacement: 0,
          afterPositiveCpuPlacement: 0,
          beforeCpuPlacementSum: 0,
          afterCpuPlacementSum: 0,
          dryWaterAnchorCpuIncrease: 0,
          roadMaskedSamples: 0,
          protectedDockAndWestSamples: 0,
        };
        const maxima = {
          materialChannelDelta: 0,
          cpuPlacementDelta: 0,
          targetShareDelta: 0,
        };
        const examples: Array<Record<string, number>> = [];
        for (let iz = 0; iz <= 264; iz++)
          for (let ix = 0; ix <= 264; ix++) {
            const x = 377 + ix * 0.25,
              z = 382 + iz * 0.25;
            const height = leases[0].sampleHeight(x, z);
            expect(leases[1].sampleHeight(x, z)).toBe(height);
            const water = before.terrain
              .getWaterBodyRegistry()
              .getWaterSurfaceAt(x, z);
            expect(
              after.terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
            ).toBe(water);
            const colors = owners.map(({ terrain }) =>
              terrain.getTerrainColorAt(x, z, true, "compact-pbr-v1"),
            );
            for (const color of colors)
              expect(
                Object.values(color)
                  .filter((v) => typeof v === "number")
                  .every(Number.isFinite),
              ).toBe(true);
            expect([colors[1].nx, colors[1].ny, colors[1].nz]).toEqual([
              colors[0].nx,
              colors[0].ny,
              colors[0].nz,
            ]);
            const road = before.terrain["calculateRoadInfluenceAtVertex"](
              x,
              z,
              0,
              0,
            );
            expect(
              after.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
            ).toBe(road);
            if (road >= 0.8) counts.roadMaskedSamples++;
            const noiseValue = sampleNoiseCPU(
              x,
              z,
              TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
            );
            const distortNoise = sampleNoiseCPU(
              x,
              z,
              TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
            );
            const inputs = macros.map((macroField) => ({
              noiseValue,
              distortNoise,
              meadowNoise: sampleNoiseCPU(
                x,
                z,
                COMPACT_TERRAIN_COMPOSITION.meadowNoiseScale,
              ),
              slope: 1 - colors[0].ny,
              roadInfluence: road,
              surface: { x, z, height, pond, macroField },
            }));
            const fields = inputs.map((input) => op.bankCompositionAt(input));
            expect(fields[1].groundCoverWeight).toBe(
              fields[0].groundCoverWeight,
            );
            expect(fields[1].groundCoverGrassShare).toBeGreaterThanOrEqual(
              fields[0].groundCoverGrassShare - 1e-12,
            );
            const relative = height - pond.surfaceY;
            const distance = Math.hypot(x - pond.centerX, z - pond.centerZ);
            const bearing = Math.atan2(z - pond.centerZ, x - pond.centerX);
            const angularDistance = Math.abs(
              Math.atan2(
                Math.sin(bearing - sector.bearing),
                Math.cos(bearing - sector.bearing),
              ),
            );
            // Both recipes use the same <=1 cm existing-noise shift. Outside
            // this exact enclosing band their emergence is identically 0 or 1.
            const possibleDelta =
              angularDistance < sector.halfWidth &&
              distance <
                pond.radius + COMPACT_TERRAIN_COMPOSITION.pondBankReach &&
              relative > 0.03 &&
              relative < 0.21 &&
              road < 0.8;
            const channelDelta = Math.max(
              ...(["r", "g", "b"] as const).map((key) =>
                Math.abs(colors[1][key] - colors[0][key]),
              ),
            );
            const placementDelta =
              colors[1].grassPlacement - colors[0].grassPlacement;
            expect(placementDelta).toBeGreaterThanOrEqual(-1e-12);
            if (!possibleDelta) {
              expect(colors[1]).toEqual(colors[0]);
              expect(fields[1]).toEqual(fields[0]);
              counts.outsideDeltaDomainExact++;
            }
            if (channelDelta > 1e-12) {
              expect(possibleDelta).toBe(true);
              counts.materialChanged++;
            }
            if (placementDelta > 1e-12) {
              expect(possibleDelta).toBe(true);
              counts.cpuPlacementIncreased++;
              if (height >= water + 0.1) counts.dryWaterAnchorCpuIncrease++;
              if (examples.length < 6)
                examples.push({
                  x,
                  z,
                  relative,
                  before: colors[0].grassPlacement,
                  after: colors[1].grassPlacement,
                  placementDelta,
                });
            }
            // These are support samples from the real CPU API, NOT accepted
            // clumps, retained wind-safe blades, GPU allocations or throughput.
            if (colors[0].grassPlacement > 0)
              counts.beforePositiveCpuPlacement++;
            if (colors[1].grassPlacement > 0)
              counts.afterPositiveCpuPlacement++;
            counts.beforeCpuPlacementSum += colors[0].grassPlacement;
            counts.afterCpuPlacementSum += colors[1].grassPlacement;
            maxima.materialChannelDelta = Math.max(
              maxima.materialChannelDelta,
              channelDelta,
            );
            maxima.cpuPlacementDelta = Math.max(
              maxima.cpuPlacementDelta,
              placementDelta,
            );
            maxima.targetShareDelta = Math.max(
              maxima.targetShareDelta,
              fields[1].groundCoverGrassShare - fields[0].groundCoverGrassShare,
            );
            if (
              (x <= 396 && z >= 405) ||
              (x >= 427 && x <= 435 && z >= 414 && z <= 417)
            )
              counts.protectedDockAndWestSamples++;
            counts.samples++;
            counts.physicalExact++;
          }
        expect(counts.samples).toBe(70225);
        expect(counts.physicalExact).toBe(counts.samples);
        expect(counts.outsideDeltaDomainExact).toBeGreaterThan(65000);
        expect(counts.materialChanged).toBeGreaterThan(0);
        expect(counts.cpuPlacementIncreased).toBeGreaterThan(0);
        expect(counts.dryWaterAnchorCpuIncrease).toBeGreaterThan(0);
        expect(counts.roadMaskedSamples).toBeGreaterThan(0);
        expect(counts.protectedDockAndWestSamples).toBeGreaterThan(10000);
        expect(counts.afterCpuPlacementSum).toBeGreaterThan(
          counts.beforeCpuPlacementSum,
        );
        for (const lease of leases) expect(lease.isCurrent()).toBe(true);
        const sources = [
          import.meta.url,
          new URL("../CompactTerrainPalette.ts", import.meta.url).href,
          new URL("../TerrainSystem.ts", import.meta.url).href,
          new URL("../CompactTerrainMaterial.ts", import.meta.url).href,
          new URL("../../../../utils/workers/GrassWorker.ts", import.meta.url)
            .href,
          new URL(
            "../__fixtures__/inland-pond-basin-candidate.json",
            import.meta.url,
          ).href,
        ].map((url) => sourceReceipt(fileURLToPath(url)));
        console.info(
          "Actual eastern shelf groundcover CPU study",
          JSON.stringify({
            manifests: manifestPaths.map(sourceReceipt),
            sources,
            recipe,
            counts,
            maxima,
            examples,
            habitatPlacements: after.placements.length,
            roadCount: after.roads.getRoads().length,
            geometryOrPhysicsRebuild: false,
            retainedGrassOrGpuOrNativeVisualAcceptance: false,
          }),
        );
      } finally {
        area.flatZones = originalZones;
        for (const world of worlds) await world.destroy();
      }
    },
    30000,
  );
});
