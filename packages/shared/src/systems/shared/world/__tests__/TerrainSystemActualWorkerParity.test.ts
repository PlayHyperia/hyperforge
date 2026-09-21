import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import {
  QUAD_CHUNK_WORKER_CODE,
  type QuadChunkWorkerOutput,
} from "../../../../utils/workers/QuadChunkWorker";
import { TerrainSystem } from "../TerrainSystem";
import type { GrassWorkerSetup } from "../GrassVisualManager";
import type { FlatZone } from "../../../../types/world/terrain";
import {
  assembleQuadChunkGeometry,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import {
  RetainedTerrainSurface,
  type TerrainCellTopology,
  type TerrainGridSample,
} from "../TerrainGridSurface";
import { validateRadialPondTerrainProfile } from "../RadialPondTerrainProfile";

type TerrainInternals = {
  flatZones: Map<string, FlatZone>;
  flatZonesByTile: Map<string, FlatZone[]>;
  arenaFloorZoneIds: Set<string>;
  initializeTerrainGenerator(): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  buildChunkTerrainProvider(): FullTerrainProvider;
  loadFlatZonesFromManifest(): void;
  loadWaterBodiesFromManifest(): void;
  getHeightAtComputed(x: number, z: number): number;
  getFlatZoneHeight(x: number, z: number): number | null;
};

/** Executes production inline worker JS; only the browser message transport is adapted. */
function createActualWorker() {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
    ${QUAD_CHUNK_WORKER_CODE}
    parentPort.on("message", data => self.onmessage({ data }));
  `,
    { eval: true, env: {} },
  );
  return {
    run(input: unknown): Promise<QuadChunkWorkerOutput> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error("Actual quad worker timeout")),
          5000,
        );
        const onError = (error: Error) => finish(error);
        const onMessage = (message: {
          result?: QuadChunkWorkerOutput;
          error?: string;
        }) =>
          finish(
            message.error ? new Error(message.error) : null,
            message.result,
          );
        function finish(error: Error | null, result?: QuadChunkWorkerOutput) {
          clearTimeout(timeout);
          worker.off("error", onError);
          worker.off("message", onMessage);
          if (error) reject(error);
          else resolve(result!);
        }
        worker.once("error", onError);
        worker.once("message", onMessage);
        worker.postMessage(input);
      });
    },
    close: () => worker.terminate(),
  };
}

describe("actual compact TerrainSystem biome/shore/worker integration", () => {
  it("replaces a moved same-ID zone without stale coordinates or duplicate index references", () => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    const original: FlatZone = {
      id: "replacement-grade",
      centerX: 175,
      centerZ: 225,
      width: 8,
      depth: 10,
      height: 22,
      blendRadius: 2,
    };
    terrain.registerFlatZone(original);
    const originalTiles = [...internals.flatZonesByTile.keys()];
    const moved = { ...original, centerX: 425, centerZ: 475, height: 31 };
    terrain.registerFlatZone(moved);
    terrain.registerFlatZone({ ...moved });
    expect(internals.flatZones.size).toBe(1);
    expect(
      internals.getFlatZoneHeight(original.centerX, original.centerZ),
    ).toBeNull();
    expect(
      terrain.getFlatZoneAt(original.centerX, original.centerZ),
    ).toBeNull();
    expect(internals.getFlatZoneHeight(moved.centerX, moved.centerZ)).toBe(
      moved.height,
    );
    for (const key of originalTiles)
      expect(
        internals.flatZonesByTile
          .get(key)
          ?.some((zone) => zone.id === moved.id) ?? false,
      ).toBe(false);
    for (const zones of internals.flatZonesByTile.values()) {
      expect(zones).toHaveLength(1);
      expect(zones[0]).toBe(internals.flatZones.get(moved.id));
      expect(zones[0]).toMatchObject(moved);
    }
  });

  it.each([
    [149.5, 249.5],
    [150.5, 250.5],
    [249.5, 349.5],
    [250.5, 350.5],
  ])("finds a narrow zone beside a centered tile boundary at %s,%s", (x, z) => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    const zone: FlatZone = {
      id: "boundary-grade",
      centerX: x,
      centerZ: z,
      width: 0.2,
      depth: 0.2,
      height: 24,
      blendRadius: 0,
    };
    terrain.registerFlatZone(zone);
    // Registration and public queries now detach height-bearing records so
    // caller mutation cannot silently bypass canonical-ground leases.
    expect(terrain.getFlatZoneAt(x, z)).toEqual(zone);
    expect(terrain.getFlatZoneAt(x, z)).not.toBe(zone);
    expect(terrain.getFlatZoneAt(x + 0.11, z)).toBeNull();
    expect(terrain.getFlatZoneAt(x, z + 0.11)).toBeNull();
    terrain.unregisterFlatZone(zone.id);
    expect(terrain.getFlatZoneAt(x, z)).toBeNull();
    expect(internals.flatZonesByTile.size).toBe(0);
  });

  it("repeatedly loads the actual 19-zone manifest without duplicates or losing any of the three arena overlays", () => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    let indexedReferenceCount: number | null = null;
    for (let pass = 0; pass < 3; pass++) {
      internals.loadFlatZonesFromManifest();
      expect(internals.flatZones.size).toBe(19);
      expect(
        internals.flatZones.get("central_haven_lodge_grass_clearance"),
      ).toMatchObject({ excludeGrass: true, width: 10, depth: 12.06 });
      expect(internals.arenaFloorZoneIds.size).toBe(3);
      let references = 0;
      for (const zones of internals.flatZonesByTile.values()) {
        references += zones.length;
        expect(new Set(zones.map((zone) => zone.id)).size).toBe(zones.length);
        for (const zone of zones)
          expect(zone).toBe(internals.flatZones.get(zone.id));
      }
      if (indexedReferenceCount !== null)
        expect(references).toBe(indexedReferenceCount);
      indexedReferenceCount = references;
      for (const id of internals.arenaFloorZoneIds) {
        const floor = internals.flatZones.get(id)!;
        expect(
          internals.getFlatZoneHeight(floor.centerX, floor.centerZ),
          `${id} center after pass ${pass}`,
        ).toBe(floor.height);
        for (const dx of [-1, 1])
          for (const dz of [-1, 1]) {
            expect(
              internals.getFlatZoneHeight(
                floor.centerX + dx * (floor.width / 2 - 0.05),
                floor.centerZ + dz * (floor.depth / 2 - 0.05),
              ),
              `${id} corner after pass ${pass}`,
            ).toBe(floor.height);
          }
      }
    }
  });

  it("removes every centered spatial-index entry when an actual arena floor is unregistered", () => {
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    internals.loadFlatZonesFromManifest();
    const ids = [...internals.arenaFloorZoneIds];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(internals.flatZones.has(id)).toBe(true);
      terrain.unregisterFlatZone(id);
      expect(internals.arenaFloorZoneIds.has(id)).toBe(false);
      expect(internals.flatZones.has(id)).toBe(false);
      const ghosts = [...internals.flatZonesByTile]
        .filter(([, zones]) => zones.some((zone) => zone.id === id))
        .map(([key]) => key);
      expect(
        ghosts,
        `unregistered ${id} remains in centered terrain tiles`,
      ).toEqual([]);
    }
  });

  it("matches the real sculpted compact landform before grading, then assembles actual authored campus/pond/floor heights", async () => {
    expect(DataManager.getInstance().isReady()).toBe(true);
    const terrain = new TerrainSystem(new World());
    const internals = terrain as unknown as TerrainInternals;
    internals.initializeTerrainGenerator();
    const setup = internals.buildGrassWorkerSetup();
    const provider = internals.buildChunkTerrainProvider();
    const profile = terrain.getWorldTerrainProfile();
    const resolution = setup.terrainConfig.TILE_RESOLUTION;
    const size = setup.tileSize;
    const samples: QuadChunkWorkerOutput[] = [];
    const worker = createActualWorker();
    let shoreCount = 0;
    let temperateBiomeCount = 0;
    let rawMaximumError = 0;
    let rawWorst = "";
    try {
      // Actual production resolution, eight regions spanning coast, authored
      // relief, preparation campus, arena platforms and pond. Mixed-biome
      // numeric coverage remains in TerrainProfileWorkerParity.test.ts.
      for (const [centerX, centerZ] of [
        [200, 250],
        [300, 350],
        [400, 350],
        [300, 450],
        [400, 450],
        [500, 550],
        [500, 400],
        [350, 550],
      ]) {
        const output = await worker.run({
          type: "generateQuadChunk",
          centerX,
          centerZ,
          size,
          resolution,
          config: setup.terrainConfig,
          seed: setup.seed,
          biomeCenters: setup.biomeCenters,
          biomes: setup.biomes,
        });
        samples.push(output);
        expect(output.terrainProfileIdentity).toBe(
          provider.terrainProfileIdentity,
        );
        for (let iz = 0; iz < resolution; iz++)
          for (let ix = 0; ix < resolution; ix++) {
            const x = centerX - size / 2 + (ix * size) / (resolution - 1);
            const z = centerZ - size / 2 + (iz * size) / (resolution - 1);
            const expected = Math.fround(internals.getHeightAtComputed(x, z));
            const actual = output.heightData[iz * resolution + ix];
            const error = Math.abs(actual - expected);
            if (error > rawMaximumError) {
              rawMaximumError = error;
              rawWorst = `at ${x},${z}: worker ${actual}, CPU ${expected}`;
            }
            const base = terrain.getProceduralHeightAt(x, z);
            if (
              base >
                profile.water.threshold - profile.shoreline.UNDERWATER_BAND &&
              base < profile.water.threshold + profile.shoreline.LAND_BAND
            )
              shoreCount++;
            if (terrain.computeBiomeWeightsByPosition(x, z).forest === 1)
              temperateBiomeCount++;
          }
      }
      expect(shoreCount).toBeGreaterThan(100);
      expect(temperateBiomeCount).toBe(
        resolution * resolution * samples.length,
      );
      expect(rawMaximumError, rawWorst).toBe(0);

      internals.loadFlatZonesFromManifest();
      let gradedVertices = 0;
      let finalMaximumError = 0;
      let finalWorst = "";
      for (const output of samples) {
        const original = output.heightData.slice();
        const assembled = assembleQuadChunkGeometry(output, provider, 3);
        try {
          const position = assembled.geometry.getAttribute("position");
          for (let iz = 0; iz < resolution; iz++)
            for (let ix = 0; ix < resolution; ix++) {
              const index = iz * resolution + ix;
              const x =
                output.centerX - size / 2 + (ix * size) / (resolution - 1);
              const z =
                output.centerZ - size / 2 + (iz * size) / (resolution - 1);
              if (internals.getFlatZoneHeight(x, z) !== null) gradedVertices++;
              const expected = Math.fround(internals.getHeightAtComputed(x, z));
              const error = Math.abs(assembled.heightData[index] - expected);
              if (error > finalMaximumError) {
                finalMaximumError = error;
                finalWorst = `at ${x},${z}: mesh ${assembled.heightData[index]}, CPU ${expected}`;
              }
              expect(position.getY(index)).toBe(assembled.heightData[index]);
            }
          expect(output.heightData).toEqual(original);
        } finally {
          assembled.geometry.dispose();
        }
      }
      expect(gradedVertices).toBeGreaterThan(1000);
      expect(finalMaximumError, finalWorst).toBe(0);
    } finally {
      await worker.close();
    }
  }, 20000);

  it.skipIf(
    !process.env.ASSETS_DIR ||
      basename(resolve(process.env.ASSETS_DIR)) !== "assets-v8" ||
      basename(dirname(resolve(process.env.ASSETS_DIR))) !==
        "inland-pond-integration01-UNQUALIFIED",
  )(
    "admits the real v8 southern headland through actual worker and retained terrain without moving protected v7 shore",
    async () => {
      // This explicitly selected, unpromoted asset fixture must never silently
      // substitute the default manifests or reconstruct a synthetic pond.
      const assets = resolve(process.env.ASSETS_DIR!);
      const previousAssets = join(dirname(assets), "assets-v7");
      type PondManifest = {
        level1Areas: {
          haven_pond: {
            flatZones: FlatZone[];
            waterBodies: Array<{
              id: string;
              centerX: number;
              centerZ: number;
              radius: number;
              surfaceY: number;
            }>;
          };
        };
      };
      const manifestFiles = [previousAssets, assets].map((directory) => {
        const path = join(directory, "manifests/world-areas.json");
        const bytes = readFileSync(path);
        return {
          path,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          data: JSON.parse(bytes.toString("utf8")) as PondManifest,
        };
      });
      const [beforeManifest, afterManifest] = manifestFiles.map(
        (file) => file.data,
      );
      const pondZone = (manifest: PondManifest): FlatZone => {
        const zone = manifest.level1Areas.haven_pond.flatZones.find(
          (row) => row.id === "haven_pond_floor",
        );
        if (!zone?.radialPond?.bankSectors)
          throw new Error("Real headland fixture has no radial pond sectors");
        return zone;
      };
      const beforeZone = pondZone(beforeManifest);
      const afterZone = pondZone(afterManifest);
      expect(validateRadialPondTerrainProfile(beforeZone)).toBeNull();
      expect(validateRadialPondTerrainProfile(afterZone)).toBeNull();
      expect(beforeZone.radialPond!.bankSectors![2]).toEqual({
        bearing: 1.4,
        halfWidth: 0.6,
        innerRadius: 18.5,
        innerHeight: 25.1,
        outerRadius: 26,
        outerHeight: 25.8,
      });
      expect(afterZone.radialPond!.bankSectors![2]).toEqual({
        bearing: 1.4,
        halfWidth: 0.5,
        innerRadius: 14.8,
        innerHeight: 25.45,
        outerRadius: 23.5,
        outerHeight: 25.8,
      });
      const restored = structuredClone(afterManifest);
      pondZone(restored).radialPond!.bankSectors![2] = structuredClone(
        beforeZone.radialPond!.bankSectors![2],
      );
      expect(restored).toEqual(beforeManifest);
      expect(readFileSync(join(assets, "manifests/world-config.json"))).toEqual(
        readFileSync(join(previousAssets, "manifests/world-config.json")),
      );
      expect(DataManager.getInstance().isReady()).toBe(true);
      expect(DataManager.getWorldConfig()?.compactPondDocks).toBeDefined();

      const worlds = [new World(), new World()];
      const terrains = worlds.map(
        (world) => world.register("terrain", TerrainSystem) as TerrainSystem,
      );
      const geometries: THREE.BufferGeometry[] = [];
      const worker = createActualWorker();
      try {
        // Both real owners admit the currently selected manifests first. The
        // complete manifest comparison above proves that replacing this one
        // real v7 zone reproduces its predecessor, without global mutation.
        for (const terrain of terrains) {
          const internal = terrain as unknown as TerrainInternals;
          await terrain.init();
          internal.loadWaterBodiesFromManifest();
          internal.loadFlatZonesFromManifest();
          expect(internal.flatZones.get(afterZone.id)).toMatchObject(afterZone);
        }
        const [before, after] = terrains;
        before.registerFlatZone(beforeZone);
        const providers = terrains.map((terrain) =>
          (terrain as unknown as TerrainInternals).buildChunkTerrainProvider(),
        );
        const leases = terrains.map((terrain) =>
          terrain.captureCanonicalGroundLease(),
        );
        const setups = terrains.map((terrain) =>
          (terrain as unknown as TerrainInternals).buildGrassWorkerSetup(),
        );
        // Authored grades are applied by the assembler, not by this raw quad
        // worker. Compare its complete input, excluding grass-only callbacks.
        for (const key of [
          "terrainConfig",
          "seed",
          "biomeCenters",
          "biomes",
          "tileSize",
        ] as const)
          expect(setups[0][key]).toEqual(setups[1][key]);
        expect(providers[0].terrainProfileIdentity).toBe(
          providers[1].terrainProfileIdentity,
        );
        const body = afterManifest.level1Areas.haven_pond.waterBodies.find(
          (row) => row.id === "haven_pond_water",
        )!;
        expect(body).toEqual({
          id: "haven_pond_water",
          centerX: 410,
          centerZ: 415,
          radius: 27,
          surfaceY: 24.6,
        });
        for (const terrain of terrains)
          expect(
            terrain
              .getWaterBodyRegistry()
              .getBodyAt(body.centerX, body.centerZ),
          ).toMatchObject(body);

        const rows: Array<{
          centerX: number;
          centerZ: number;
          surfaces: RetainedTerrainSurface[];
        }> = [];
        const meshCensus: Array<Record<string, number>> = [];
        for (const [centerX, centerZ] of [
          [450, 450],
          [350, 450],
          [450, 350],
          [350, 350],
        ]) {
          const setup = setups[0];
          const output = await worker.run({
            type: "generateQuadChunk",
            centerX,
            centerZ,
            size: 100,
            resolution: 128,
            config: setup.terrainConfig,
            seed: setup.seed,
            biomeCenters: setup.biomeCenters,
            biomes: setup.biomes,
          });
          expect(output.terrainProfileIdentity).toBe(
            providers[0].terrainProfileIdentity,
          );
          const rawHeights = output.heightData.slice();
          const surfaces = providers.map((provider, version) => {
            // Keep the production refinement failure/caps intact. A candidate
            // that cannot assemble is a failed geometry trial, not a skip.
            const assembled = assembleQuadChunkGeometry(output, provider, 3);
            geometries.push(assembled.geometry);
            expect(output.heightData).toEqual(rawHeights);
            const topology = assembled.geometry.userData
              .terrainCellTopology as TerrainCellTopology;
            const extraVertices = topology.surfaceVertexCount - 128 * 128;
            expect(extraVertices).toBeLessThanOrEqual(65536);
            let maxCellFaces = 0;
            for (let cell = 1; cell < topology.cellIndexOffsets.length; cell++)
              maxCellFaces = Math.max(
                maxCellFaces,
                (topology.cellIndexOffsets[cell] -
                  topology.cellIndexOffsets[cell - 1]) /
                  3,
              );
            expect(maxCellFaces).toBeLessThanOrEqual(512);
            for (const name of ["position", "normal"] as const) {
              const attribute = assembled.geometry.getAttribute(name);
              for (let index = 0; index < attribute.count; index++)
                expect(
                  [
                    attribute.getX(index),
                    attribute.getY(index),
                    attribute.getZ(index),
                  ].every(Number.isFinite),
                ).toBe(true);
            }
            const surface = new RetainedTerrainSurface(
              version + 1,
              provider.terrainProfileIdentity,
              centerX,
              centerZ,
              100,
              128,
              assembled.geometry,
            );
            expect(surface.matchesGeometry(assembled.geometry)).toBe(true);
            meshCensus.push({
              version: version + 7,
              centerX,
              centerZ,
              extraVertices,
              maxCellFaces,
              vertices: assembled.geometry.getAttribute("position").count,
              triangles: assembled.geometry.index!.count / 3,
            });
            return surface;
          });
          rows.push({ centerX, centerZ, surfaces });
        }
        const out: TerrainGridSample = {
          height: 0,
          nx: 0,
          ny: 1,
          nz: 0,
          faceIndex: 0,
        };
        const sampleMesh = (version: number, x: number, z: number) => {
          const row = rows.find(
            (entry) =>
              Math.abs(x - entry.centerX) <= 50 &&
              Math.abs(z - entry.centerZ) <= 50,
          );
          if (
            !row ||
            !row.surfaces[version].sample(x - row.centerX, z - row.centerZ, out)
          )
            throw new Error(`No actual retained pond surface at ${x},${z}`);
          return out;
        };
        const maxima = providers.map(() => ({
          heightError: 0,
          normalDegrees: 0,
          probes: 0,
        }));
        let unchangedOutsideSector = 0;
        for (let degree = 0; degree < 360; degree++) {
          const angle = ((degree + 0.317) * Math.PI) / 180;
          const distance = Math.abs(
            Math.atan2(Math.sin(angle - 1.4), Math.cos(angle - 1.4)),
          );
          for (let radial = 0; radial <= 470; radial++) {
            const radius = 9.45 + radial * 0.05;
            const x = 410 + radius * Math.cos(angle);
            const z = 415 + radius * Math.sin(angle);
            if (distance >= 0.601) {
              expect(leases[0].sampleHeight(x, z)).toBe(
                leases[1].sampleHeight(x, z),
              );
              unchangedOutsideSector++;
            }
            providers.forEach((provider, version) => {
              const mesh = sampleMesh(version, x, z);
              const height = provider.getHeightAtComputed(x, z);
              const h = 0.03125;
              const nx =
                -(
                  provider.getHeightAtComputed(x + h, z) -
                  provider.getHeightAtComputed(x - h, z)
                ) /
                (2 * h);
              const nz =
                -(
                  provider.getHeightAtComputed(x, z + h) -
                  provider.getHeightAtComputed(x, z - h)
                ) /
                (2 * h);
              const cosine =
                (nx * mesh.nx + mesh.ny + nz * mesh.nz) / Math.hypot(nx, 1, nz);
              const degrees =
                (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
              expect(
                [height, nx, nz, mesh.height, degrees].every(Number.isFinite),
              ).toBe(true);
              maxima[version].heightError = Math.max(
                maxima[version].heightError,
                Math.abs(mesh.height - height),
              );
              maxima[version].normalDegrees = Math.max(
                maxima[version].normalDegrees,
                degrees,
              );
              maxima[version].probes++;
            });
          }
        }
        expect(unchangedOutsideSector).toBeGreaterThan(130000);
        for (const maximum of maxima) {
          expect(maximum.probes).toBe(169560);
          expect(maximum.heightError).toBeLessThanOrEqual(0.02);
          expect(maximum.normalDegrees).toBeLessThanOrEqual(6);
        }

        // One wet interval per radial spoke proves a connected sampled basin
        // with no isolated dry island/wet pocket; this is not a navmesh claim.
        const shoreRadii = providers.map((provider, version) => {
          const radii: number[] = [];
          for (let degree = 0; degree < 360; degree++) {
            const angle = (degree * Math.PI) / 180;
            let transitions = 0;
            let wasWet = true;
            for (let radial = 0; radial <= 270; radial++) {
              const radius = radial / 10;
              const x = 410 + radius * Math.cos(angle);
              const z = 415 + radius * Math.sin(angle);
              const wet = provider.getHeightAtComputed(x, z) < body.surfaceY;
              if (wet !== wasWet) transitions++;
              wasWet = wet;
            }
            expect(transitions, `v${version + 7} water spoke ${degree}`).toBe(
              1,
            );
            expect(wasWet).toBe(false);
            let low = 0,
              high = 27;
            for (let step = 0; step < 30; step++) {
              const radius = (low + high) / 2;
              if (
                provider.getHeightAtComputed(
                  410 + radius * Math.cos(angle),
                  415 + radius * Math.sin(angle),
                ) < body.surfaceY
              )
                low = radius;
              else high = radius;
            }
            radii.push((low + high) / 2);
          }
          return radii;
        });
        const headlandDegree = Math.round((1.4 * 180) / Math.PI);
        const recession =
          shoreRadii[0][headlandDegree] - shoreRadii[1][headlandDegree];
        expect(recession).toBeGreaterThan(2.5);
        expect(recession).toBeLessThan(3.5);
        // Same east cove, stronger asymmetry against the changed south shore.
        expect(shoreRadii[0][0]).toBe(shoreRadii[1][0]);
        expect(
          shoreRadii[1][0] - shoreRadii[1][headlandDegree],
        ).toBeGreaterThan(
          shoreRadii[0][0] - shoreRadii[0][headlandDegree] + 2.5,
        );
        const headlandPoint = [
          410 + 14.5 * Math.cos(1.4),
          415 + 14.5 * Math.sin(1.4),
        ] as const;
        expect(before.getResourceGroundHeight(...headlandPoint)).toBeLessThan(
          body.surfaceY,
        );
        expect(after.getResourceGroundHeight(...headlandPoint)).toBeGreaterThan(
          body.surfaceY + 0.5,
        );
        expect(sampleMesh(0, ...headlandPoint).height).toBeLessThan(
          body.surfaceY,
        );
        expect(sampleMesh(1, ...headlandPoint).height).toBeGreaterThan(
          body.surfaceY + 0.5,
        );

        let protectedSamples = 0;
        const unchanged = (x: number, z: number) => {
          expect(leases[0].sampleHeight(x, z)).toBe(
            leases[1].sampleHeight(x, z),
          );
          const oldSample = { ...sampleMesh(0, x, z) };
          const nextSample = sampleMesh(1, x, z);
          expect([
            nextSample.height,
            nextSample.nx,
            nextSample.ny,
            nextSample.nz,
          ]).toEqual([
            oldSample.height,
            oldSample.nx,
            oldSample.ny,
            oldSample.nz,
          ]);
          protectedSamples++;
        };
        // Full deck/apron support rectangles for both real docks, not only
        // their origins; exact render support equality is independent of PhysX.
        for (const [minX, maxX, minZ, maxZ] of [
          [388, 396, 423, 426],
          [427, 435, 414, 417],
          [370, 396, 405, 448],
        ])
          for (let x = minX; x <= maxX; x += 0.25)
            for (let z = minZ; z <= maxZ; z += 0.25) unchanged(x, z);
        // Beyond the radial support, every heading retains exact authority.
        for (let degree = 0; degree < 360; degree++)
          for (const radius of [33.1, 36, 39]) {
            const angle = (degree * Math.PI) / 180;
            const x = 410 + radius * Math.cos(angle);
            const z = 415 + radius * Math.sin(angle);
            expect(leases[0].sampleHeight(x, z)).toBe(
              leases[1].sampleHeight(x, z),
            );
          }
        for (const lease of leases) expect(lease.isCurrent()).toBe(true);
        process.stdout.write(
          `Actual v8 headland ${JSON.stringify({
            manifestFiles: manifestFiles.map(({ path, bytes, sha256 }) => ({
              path,
              bytes,
              sha256,
            })),
            meshCensus,
            maxima,
            unchangedOutsideSector,
            protectedSamples,
            waterSpokesPerVersion: 360,
            headlandRecession: recession,
            nativeOrNavigationOrPerformanceAcceptance: false,
          })}\n`,
        );
      } finally {
        await worker.close();
        geometries.forEach((geometry) => geometry.dispose());
        for (const world of worlds) await world.destroy();
      }
    },
    30000,
  );
});
