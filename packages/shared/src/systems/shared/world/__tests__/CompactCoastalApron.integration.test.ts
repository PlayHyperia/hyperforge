import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../../data/duel-manifest";
import { validateTreeAnchor } from "../BiomeResourceGenerator";
import {
  QUAD_CHUNK_WORKER_CODE,
  type QuadChunkWorkerOutput,
} from "../../../../utils/workers/QuadChunkWorker";
import {
  TERRAIN_WORKER_CODE,
  type TerrainWorkerOutput,
} from "../../../../utils/workers/TerrainWorker";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { TerrainSystem } from "../TerrainSystem";
import { TerrainQuadTree } from "../TerrainQuadTree";
import {
  assembleQuadChunkGeometry,
  assembleQuadChunkGeometrySteps,
  type ChunkTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
} from "../TerrainGridSurface";
import { createCompactIslandLandform } from "../CompactIslandLandform";
import { createCompactCoastalApron } from "../CompactCoastalApron";
import { createCompactIslandPaths } from "../CompactIslandPaths";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { GRASS_CONFIG } from "../GrassVisualManager";
import { TERRAIN_SHADER_CONSTANTS } from "../TerrainShader";
import {
  validateWorldTerrainProfile,
  serializeWorldTerrainProfile,
  worldTerrainProfileIdentity,
  getCompactCoastalApronSupport,
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

// Locked after bounded numeric authoring and real worker/anchor qualification.
// This manifest selection is not native visual or movement acceptance.
const previousCoastalApron = {
  schemaVersion: 1,
  minX: 445,
  maxX: 503,
  minZ: 436,
  maxZ: 539,
  featherX: 6,
  featherZ: 20,
  halo: 1,
  floorHeight: 2.5,
  referencePlateau: 28.15,
  knots: [
    [-26, 2.5, 0],
    [-9, 16, 0.12],
    [3, 17.5, 0.14],
    [15, 19.25, 0.18],
    [60, 28.15, 0],
  ],
};
const coastalApron = {
  ...previousCoastalApron,
  westernShoulder: { maxWidth: 24, startZ: 460, endZ: 539, featherZ: 24 },
};
const lowlandApron = {
  ...coastalApron,
  lowland: {
    minZ: 436,
    maxZ: 540,
    startX: 462,
    endX: 422,
    descentLength: 57,
    halfWidth: 12,
    westHoldX: 445,
    westMinX: 377,
    westReleaseZ: 458,
    westReleaseLength: 64,
    eastMaxX: 503,
    startBlend: 12,
    endBlend: 22,
    endHeight: 18.3,
  },
};
function lowlandAreaSamples(): [number, number][] {
  const points: [number, number][] = [];
  for (let z = 438; z <= 492; z += 0.5) {
    const t = Math.max(0, Math.min(1, (z - 458) / 64));
    const center = 462 - 40 * t * t * (3 - 2 * t);
    for (let offset = -10; offset <= 10; offset += 0.5)
      points.push([center + offset, z]);
  }
  return points;
}
// Independently declared source-support union, not a widened campus-overlapping
// bounding box or a production-derived oracle.
const rawSupports = [
  { minX: 445, maxX: 503, minZ: 436, maxZ: 539 },
  { minX: 427, maxX: 451, minZ: 460, maxZ: 539 },
];
const canonicalSupports = rawSupports.map((b) => ({
  minX: b.minX - 1,
  maxX: b.maxX + 1,
  minZ: b.minZ - 1,
  maxZ: b.maxZ + 1,
}));
function insideSupports(x: number, z: number, boxes: typeof rawSupports) {
  return boxes.some(
    (b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ,
  );
}
const worlds: World[] = [];
// Fixed after numeric04; both canonical and retained-mesh checks use these
// exact three-metre strips and filled corner/end discs, never a route search.
const coveRoute = [
  [472, 435],
  [472, 448],
  [468, 451],
  [462, 453],
  [456, 454],
  [454, 456],
  [454, 478],
];
const lowlandDiagonalRoute = [
  [462, 440],
  [460, 450],
  [455, 460],
  [451, 470],
  [445, 480],
  [440, 490],
];
function coveRouteSamples(route = coveRoute): [number, number][] {
  const samples: [number, number][] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1],
      b = route[i],
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz);
    const steps = Math.ceil(length / 0.25);
    for (let j = 0; j <= steps; j++)
      for (let k = -6; k <= 6; k++) {
        const offset = k * 0.25;
        samples.push([
          a[0] + (dx * j) / steps - (dz / length) * offset,
          a[1] + (dz * j) / steps + (dx / length) * offset,
        ]);
      }
  }
  for (const [x, z] of route)
    for (let dx = -1.5; dx <= 1.5; dx += 0.25)
      for (let dz = -1.5; dz <= 1.5; dz += 0.25)
        if (Math.hypot(dx, dz) <= 1.5) samples.push([x + dx, z + dz]);
  return samples;
}
function predecessor() {
  const { coastalApron: _apron, ...previous } =
    DataManager.getWorldTerrainProfile();
  return validateWorldTerrainProfile(previous);
}

/** Actual production source, with only browser message transport adapted. */
function actualWorker(source: string) {
  const worker = new Worker(
    `
    const {parentPort}=require("node:worker_threads");
    globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};
    ${source}
    parentPort.on("message",data=>self.onmessage({data}));
  `,
    { eval: true, env: {} },
  );
  return {
    run<T>(input: unknown): Promise<T> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Actual cove worker timeout")),
          10000,
        );
        const onError = (error: Error) => finish(error);
        const onMessage = (message: { result?: T; error?: string }) =>
          finish(
            message.error ? new Error(message.error) : null,
            message.result,
          );
        function finish(error: Error | null, result?: T) {
          clearTimeout(timer);
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
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
async function fixture(profile: WorldTerrainProfile) {
  const world = new World();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  // Select an admitted profile before real init; do not replace production
  // methods or mutate global DataManager/manifests to compare two worlds.
  terrain["activeTerrainProfile"] = profile;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  expect(terrain.captureCanonicalGroundLease().supportBounds).toHaveLength(19);
  return terrain;
}

describe("actual corrected compact cove", () => {
  it("derives candidate bank refinement from current owned ponds and invalidates preparation when they change", async () => {
    const live = DataManager.getWorldTerrainProfile();
    const baseline = await fixture(live);
    expect(
      baseline["buildChunkTerrainProvider"]().surfaceRefinementAnnuli,
    ).toBeUndefined();
    const profile = validateWorldTerrainProfile({
      ...live,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    const terrain = await fixture(profile);
    const provider = terrain["buildChunkTerrainProvider"]();
    const setup = terrain["buildGrassWorkerSetup"]();
    expect(provider.surfaceRefinementAnnuli).toEqual([
      { centerX: 343, centerZ: 302, innerRadius: 4.1, outerRadius: 7.9 },
    ]);
    const pond = terrain["flatZones"].get("haven_pond_floor")!;
    expect(pond.radialPond).toBeDefined();
    const lease = provider.capturePreparationLease(
      setup.biomeCenters,
      setup.biomes,
    );
    expect(lease.isCurrent()).toBe(true);
    terrain.registerFlatZone({
      ...pond,
      radialPond: { ...pond.radialPond!, shorelineAmplitude: 0.5 },
    });
    expect(lease.isCurrent()).toBe(false);
    expect(provider.surfaceRefinementAnnuli).toEqual([
      { centerX: 343, centerZ: 302, innerRadius: 4.5, outerRadius: 7.5 },
    ]);
    const replacementLease = provider.capturePreparationLease(
      setup.biomeCenters,
      setup.biomes,
    );
    terrain.unregisterFlatZone(pond.id);
    expect(replacementLease.isCurrent()).toBe(false);
    expect(provider.surfaceRefinementAnnuli).toEqual([]);
    // No feature is cached in the adapter, and no global manifest is mutated.
    expect(
      baseline["buildChunkTerrainProvider"]().surfaceRefinementAnnuli,
    ).toBeUndefined();
    expect(DataManager.getWorldTerrainProfile()).toEqual(live);
  });

  it.each([false, true])(
    "qualifies the combined southern meadow and rounded functional backings on fixed broad travel bands (headShoulder=%s)",
    async (withHeadShoulder) => {
      // The annular-pond-integration-focused04 failure retains the prior northern
      // fingerprint. Its adaptive bank/shared-edge staged/synchronous proofs and travel
      // gates pass: the bank changes only this leaf's mesh, not its original grid
      // height data. Both southern world04 geometry fingerprints remain exact.
      const expectedGeometryProofs: Record<string, string> = {
        "350,350,128":
          "8c8e6fea30eb9405f75aabed532f899885238f5d128b88932ce8c692a2eb56e6",
        "350,450,64":
          "c91fee5dd3526bd566196b86f90aa50c01faf9e1c31c025598a4c1d8a7ce5caa",
        "450,450,64":
          "193e5b59f2e1dd7a1baf9ec5e4346c109c7d8f00bf87fbc3bafda97fd5a619d1",
      };
      const bytes = (array: ArrayBufferView) =>
        Buffer.from(array.buffer, array.byteOffset, array.byteLength);
      const arrayHash = (array: ArrayBufferView) =>
        createHash("sha256").update(bytes(array)).digest("hex");
      const geometryProof = (
        geometry: THREE.BufferGeometry,
        heightDataSHA256: string,
      ) => ({
        heightDataSHA256,
        attributes: Object.fromEntries(
          Object.entries(geometry.attributes).map(([name, attribute]) => {
            if (!("array" in attribute))
              throw new Error("Unexpected interleaved terrain attribute");
            return [
              name,
              {
                type: attribute.array.constructor.name,
                itemSize: attribute.itemSize,
                normalized: attribute.normalized,
                sha256: arrayHash(attribute.array),
              },
            ];
          }),
        ),
        indexSHA256: arrayHash(geometry.getIndex()!.array),
        topologySHA256: createHash("sha256")
          .update(JSON.stringify(geometry.userData.terrainCellTopology ?? null))
          .digest("hex"),
      });
      type Evaluations = {
        heightQueries: number;
        flatQueries: number;
        roadQueries: number;
      };
      const newCounts = (): Evaluations => ({
        heightQueries: 0,
        flatQueries: 0,
        roadQueries: 0,
      });
      type PhaseCost = Evaluations & {
        steps: number;
        cpuMs: number;
        maxStepMs: number;
        maxHeightQueries: number;
        maxFlatQueries: number;
        maxRoadQueries: number;
      };
      type StepCost = {
        phases: Record<string, PhaseCost>;
        steps: number;
        cpuMs: number;
        maxStepMs: number;
        leaseChecks: number;
        leaseCheckMs: number;
      };
      const preparationGeometries = new Set<THREE.BufferGeometry>();
      const live = DataManager.getWorldTerrainProfile();
      const worldConfig = DataManager.getWorldConfig();
      const originalAreas = Object.entries(ALL_WORLD_AREAS);
      const areaBytes = JSON.stringify(ALL_WORLD_AREAS);
      const candidateAreas = structuredClone(ALL_WORLD_AREAS);
      const heightDatum = 28.419301523097687;
      const backingBoxes = [
        { id: "arena", minX: 339, maxX: 361, minZ: 393, maxZ: 419 },
        { id: "lobby", minX: 375, maxX: 395, minZ: 367, maxZ: 385 },
        { id: "hospital", minX: 338, maxX: 352, minZ: 369, maxZ: 383 },
      ];
      const meadow = {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      };
      const baselineProfile = validateWorldTerrainProfile({
        ...live,
        southernMeadow: meadow,
        // Detached world04 trial: long cove-head descent and one dominant ridge
        // shoulder. Existing controls only; original live manifest stays exact.
        coastalApron: {
          ...live.coastalApron!,
          lowland: { ...live.coastalApron!.lowland!, westHoldX: 394 },
        },
        terrace: {
          ...live.terrace!,
          crestHeight: 17.5,
          shelfHeight: 7,
          scarpRun: 16,
          shelfWidth: 8,
          apronWidth: 30,
        },
        ridgeBreakup: {
          ...live.ridgeBreakup!,
          northGapZ: -20,
          northGapDepth: 0,
          southGapZ: 27,
          southGapHalfWidth: 24,
          southGapDepth: 0.5,
        },
      });
      const bearing = baselineProfile.landform!.inletBearing;
      const headPoint = (along: number, y: number) => [
        baselineProfile.island.centerX +
          along * Math.cos(bearing) -
          8 * Math.sin(bearing),
        baselineProfile.island.centerZ +
          along * Math.sin(bearing) +
          8 * Math.cos(bearing),
        y,
      ];
      // Match the detached landform candidate, not a live manifest promotion.
      const profile = withHeadShoulder
        ? validateWorldTerrainProfile({
            ...baselineProfile,
            coastalApron: {
              ...baselineProfile.coastalApron!,
              headShoulder: {
                minX: 377,
                maxX: 444,
                minZ: 457,
                maxZ: 500,
                featherX: 8,
                featherZ: 4,
                start: headPoint(70, 25.4),
                end: headPoint(94, 19.2),
                leftWidth: 16,
                rightWidth: 24,
                startFade: 6,
                endFade: 8,
                leftSlope: 0.32,
                rightSlope: 0.18,
                creaseWidth: 2.4,
                blendHeight: 0.35,
              },
            },
          })
        : baselineProfile;
      const duel = candidateAreas.duel_arena;
      const oldCampus = duel.flatZones!.filter(
        (zone) => zone.id === "duel_arena_campus_grade",
      );
      expect(oldCampus).toHaveLength(1);
      expect(oldCampus[0].height).toBe(heightDatum);
      duel.arenaFloorDatum = { height: heightDatum };
      duel.flatZones = [
        ...duel.flatZones!.filter(
          (zone) => zone.id !== "duel_arena_campus_grade",
        ),
        ...backingBoxes.map((box) => ({
          id: `southern-meadow-${box.id}-backing`,
          centerX: (box.minX + box.maxX) / 2,
          centerZ: (box.minZ + box.maxZ) / 2,
          width: box.maxX - box.minX,
          depth: box.maxZ - box.minZ,
          height: heightDatum,
          blendRadius: 24,
          blendShape: "rounded" as const,
          blendComposition: "smooth-union" as const,
          excludeGrass: false,
        })),
      ];
      const withoutGrade = (area: typeof duel) => {
        const copy = structuredClone(area);
        delete copy.flatZones;
        delete copy.arenaFloorDatum;
        return copy;
      };
      expect(withoutGrade(duel)).toEqual(
        withoutGrade(ALL_WORLD_AREAS.duel_arena),
      );
      for (const [id, area] of originalAreas)
        if (id !== "duel_arena") expect(candidateAreas[id]).toEqual(area);

      const before = await fixture(live);
      let tree: TerrainQuadTree | undefined;
      let quad: ReturnType<typeof actualWorker> | undefined;
      let grass: ReturnType<typeof actualWorker> | undefined;
      const retained: {
        node: ReturnType<TerrainQuadTree["getFinalNodes"]>[number];
        surface: RetainedTerrainSurface;
        geometry: THREE.BufferGeometry;
        syncSurface: RetainedTerrainSurface;
        assemblyMs: number;
        retentionMs: number;
        heightDataSHA256: string;
        preparation: {
          assembly: StepCost;
          retention: StepCost;
          evaluations: Evaluations;
          geometryProofSHA256: string;
          exactStagedSyncBytes: boolean;
        };
      }[] = [];
      try {
        Object.assign(ALL_WORLD_AREAS, candidateAreas);
        const world = new World();
        worlds.push(world);
        const terrain = world.register(
          "terrain",
          TerrainSystem,
        ) as TerrainSystem;
        terrain["activeTerrainProfile"] = profile;
        await terrain.init();
        terrain["loadWaterBodiesFromManifest"]();
        terrain["loadFlatZonesFromManifest"]();
        expect(
          terrain.captureCanonicalGroundLease().supportBounds,
        ).toHaveLength(21);
        expect(terrain["flatZones"].has("duel_arena_campus_grade")).toBe(false);
        for (const box of backingBoxes)
          expect(
            terrain["flatZones"].get(`southern-meadow-${box.id}-backing`),
          ).toMatchObject({
            height: heightDatum,
            blendRadius: 24,
            blendShape: "rounded",
            blendComposition: "smooth-union",
          });
        const heightCache = new Map<string, number>();
        const height = (x: number, z: number) => {
          const key = `${x},${z}`;
          let value = heightCache.get(key);
          if (value === undefined) {
            value = terrain.getResourceGroundHeight(x, z);
            heightCache.set(key, value);
          }
          return value;
        };

        // Fail early on actual authored-grove slope/water/arena admission before
        // retaining geometry. Fresh startup with the real road owner is also
        // required by the detached-world builder; this is not installation proof.
        const groveAdmission =
          worldConfig!.compactResourceGroves!.regions.flatMap((region) =>
            region.anchors.map((anchor) => {
              const { x, z } = anchor.position;
              const source = terrain["createTreeGenerationSource"](
                Math.floor((x + 50) / 100),
                Math.floor((z + 50) / 100),
              );
              const admitted = validateTreeAnchor(
                {
                  context: source.context,
                  config: { ...source.config, maxSlope: 0.35 },
                },
                x,
                z,
                isPositionInsideDuelArenaZone,
              );
              return {
                id: anchor.id,
                x,
                z,
                previousY: before.getResourceGroundHeight(x, z),
                candidateY: height(x, z),
                slope: Math.hypot(
                  (height(x + 1, z) - height(x - 1, z)) / 2,
                  (height(x, z + 1) - height(x, z - 1)) / 2,
                ),
                rejection: admitted.rejection,
              };
            }),
          );
        console.log(
          "SOUTHERN_MEADOW_GROVE_ADMISSION",
          JSON.stringify(groveAdmission),
        );
        expect(groveAdmission).toHaveLength(35);
        expect(groveAdmission.filter((row) => row.rejection !== null)).toEqual(
          [],
        );
        expect(
          Math.max(...groveAdmission.map((row) => row.slope)),
        ).toBeLessThanOrEqual(0.35);

        // Preserve actual supports independently of the new open-ground tests.
        // These named boxes are the existing solid floor cores plus 1 m collars,
        // not a dynamically chosen exclusion around failing samples.
        let protectedSamples = 0,
          protectedMismatchCount = 0;
        const protectedMismatches: number[][] = [];
        const preserve = (x: number, z: number) => {
          const actual = height(x, z),
            previous = before.getResourceGroundHeight(x, z);
          if (actual !== previous) {
            protectedMismatchCount++;
            if (protectedMismatches.length < 16)
              protectedMismatches.push([x, z, previous, actual]);
          }
          protectedSamples++;
        };
        for (const box of backingBoxes)
          for (let x = box.minX; x <= box.maxX; x += 0.5)
            for (let z = box.minZ; z <= box.maxZ; z += 0.5) preserve(x, z);
        let stationZones = 0;
        for (const zone of before["flatZones"].values()) {
          if (!zone.id.startsWith("station_")) continue;
          stationZones++;
          for (const dx of [-zone.width / 2, 0, zone.width / 2])
            for (const dz of [-zone.depth / 2, 0, zone.depth / 2])
              preserve(zone.centerX + dx, zone.centerZ + dz);
        }
        // Actual lodge/plaza support and the entire authored pond rim remain
        // north of the meadow, including the canonical correction halo.
        for (let x = 332; x <= 368; x += 2)
          for (let z = 302; z <= 338; z += 2) preserve(x, z);
        for (let dx = -11; dx <= 11; dx += 0.5)
          for (let dz = -11; dz <= 11; dz += 0.5)
            if (Math.hypot(dx, dz) <= 11) preserve(343 + dx, 302 + dz);
        for (const x of [331.5, 341.5])
          for (const z of [335.5, 340.5])
            for (const dx of [-0.15, 0, 0.15])
              for (const dz of [-0.15, 0, 0.15]) preserve(x + dx, z + dz);

        const union = [
          { minX: 303, maxX: 501, minZ: 344, maxZ: 536 },
          // Exact existing terrace support has ax < -70, cross > -26,
          // az in (-50,60), ridge spine >= -112. Include the canonical 1 m halo.
          { minX: 211, maxX: 281, minZ: 349, maxZ: 461 },
          ...createCompactCoastalApron()
            .supportBounds(profile.coastalApron!)
            .map((box) => ({
              minX: box.minX - profile.coastalApron!.halo,
              maxX: box.maxX + profile.coastalApron!.halo,
              minZ: box.minZ - profile.coastalApron!.halo,
              maxZ: box.maxZ + profile.coastalApron!.halo,
            })),
          {
            minX:
              oldCampus[0].centerX -
              oldCampus[0].width / 2 -
              oldCampus[0].blendRadius -
              1,
            maxX:
              oldCampus[0].centerX +
              oldCampus[0].width / 2 +
              oldCampus[0].blendRadius +
              1,
            minZ:
              oldCampus[0].centerZ -
              oldCampus[0].depth / 2 -
              oldCampus[0].blendRadius -
              1,
            maxZ:
              oldCampus[0].centerZ +
              oldCampus[0].depth / 2 +
              oldCampus[0].blendRadius +
              1,
          },
          ...backingBoxes.map((box) => ({
            minX: box.minX - 25,
            maxX: box.maxX + 25,
            minZ: box.minZ - 25,
            maxZ: box.maxZ + 25,
          })),
        ];
        expect(stationZones).toBeGreaterThan(0);
        let outsideSamples = 0,
          outsideMismatchCount = 0;
        for (let x = 150; x <= 550; x += 4)
          for (let z = 200; z <= 600; z += 4)
            if (!insideSupports(x, z, union)) {
              if (height(x, z) !== before.getResourceGroundHeight(x, z))
                outsideMismatchCount++;
              outsideSamples++;
            }

        // Fixed before qualification: no route search or selection by outcomes.
        // The small connector fills the four-metre gap between the two broad
        // authoring bands; the neck crosses north of the still-wet bay.
        const bands = [
          { name: "meadow", minX: 328, maxX: 396, minZ: 390, maxZ: 455 },
          { name: "northern-neck", minX: 400, maxX: 470, minZ: 425, maxZ: 452 },
          {
            name: "lowland-descent",
            minX: 450,
            maxX: 466,
            minZ: 450,
            maxZ: 483,
          },
          {
            name: "meadow-neck-connector",
            minX: 392,
            maxX: 406,
            minZ: 432,
            maxZ: 444,
          },
          {
            name: "north-service-neck",
            minX: 352,
            maxX: 372,
            minZ: 350,
            maxZ: 390,
          },
        ];
        const cells = new Map<string, { x: number; z: number }>();
        const points = new Map<string, [number, number]>();
        const point = (x: number, z: number) => points.set(`${x},${z}`, [x, z]);
        const counts: Record<string, number> = {};
        for (const band of bands) {
          let count = 0;
          for (let x = band.minX; x < band.maxX; x++)
            for (let z = band.minZ; z < band.maxZ; z++) {
              if (
                backingBoxes.some(
                  (box) =>
                    x < box.maxX &&
                    x + 1 > box.minX &&
                    z < box.maxZ &&
                    z + 1 > box.minZ,
                )
              )
                continue;
              cells.set(`${x},${z}`, { x, z });
              for (const dx of [0, 0.5, 1])
                for (const dz of [0, 0.5, 1]) point(x + dx, z + dz);
              count++;
            }
          counts[band.name] = count;
        }
        const routePoints = [
          ...coveRouteSamples(),
          ...coveRouteSamples(lowlandDiagonalRoute),
        ];
        for (const [x, z] of routePoints) point(x, z);
        const directions = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [-1, 1],
          [1, -1],
          [-1, -1],
        ];
        const first = cells.values().next().value!;
        const queue = [first],
          reached = new Set([`${first.x},${first.z}`]);
        let diagonalEdges = 0;
        for (let i = 0; i < queue.length; i++)
          for (const [dx, dz] of directions) {
            const a = queue[i],
              key = `${a.x + dx},${a.z + dz}`,
              b = cells.get(key);
            if (
              !b ||
              (dx !== 0 &&
                dz !== 0 &&
                (!cells.has(`${a.x + dx},${a.z}`) ||
                  !cells.has(`${a.x},${a.z + dz}`)))
            )
              continue;
            if (dx !== 0 && dz !== 0) diagonalEdges++;
            if (!reached.has(key)) {
              reached.add(key);
              queue.push(b);
            }
          }
        expect(reached.size).toBe(cells.size);
        expect(diagonalEdges).toBeGreaterThan(1000);
        expect(counts.meadow).toBeGreaterThan(3500);
        for (const tx of [3, 4, 5])
          for (const tz of [3, 4, 5]) terrain["bakeWalkabilityFlags"](tx, tz);

        const setup = terrain["buildGrassWorkerSetup"]();
        const provider = terrain["buildChunkTerrainProvider"]();
        // Count callback entries only; delegate every value to the real World.
        // This does not replace canonical evaluation with a cached test field.
        const countedProvider = (
          counts: Evaluations,
        ): ChunkTerrainProvider => ({
          terrainProfileIdentity: provider.terrainProfileIdentity,
          TILE_SIZE: provider.TILE_SIZE,
          get surfaceRefinementZones() {
            return provider.surfaceRefinementZones;
          },
          get surfaceRefinementAnnuli() {
            return provider.surfaceRefinementAnnuli;
          },
          getHeightAtComputed(x, z) {
            counts.heightQueries++;
            return provider.getHeightAtComputed(x, z);
          },
          getFlatZoneHeight(x, z) {
            counts.flatQueries++;
            return provider.getFlatZoneHeight(x, z);
          },
          calculateRoadInfluenceAtVertex(x, z, tx, tz) {
            counts.roadQueries++;
            return provider.calculateRoadInfluenceAtVertex(x, z, tx, tz);
          },
        });
        const drainPreparation = <T>(
          iterator: Generator<string, T, void>,
          counts: Evaluations,
          lease: Readonly<{ isCurrent(): boolean }>,
        ): { value: T; cost: StepCost } => {
          const cost: StepCost = {
            phases: {},
            steps: 0,
            cpuMs: 0,
            maxStepMs: 0,
            leaseChecks: 0,
            leaseCheckMs: 0,
          };
          let completed = false;
          try {
            for (;;) {
              const guardStart = performance.now();
              if (!lease.isCurrent())
                throw new Error("Actual World preparation lease became stale");
              cost.leaseChecks++;
              cost.leaseCheckMs += performance.now() - guardStart;
              const before = { ...counts },
                start = performance.now();
              const next = iterator.next(),
                elapsed = performance.now() - start;
              const key = next.done ? "complete" : next.value;
              const phase = (cost.phases[key] ??= {
                ...newCounts(),
                steps: 0,
                cpuMs: 0,
                maxStepMs: 0,
                maxHeightQueries: 0,
                maxFlatQueries: 0,
                maxRoadQueries: 0,
              });
              phase.steps++;
              phase.cpuMs += elapsed;
              phase.maxStepMs = Math.max(phase.maxStepMs, elapsed);
              const heightQueries = counts.heightQueries - before.heightQueries,
                flatQueries = counts.flatQueries - before.flatQueries,
                roadQueries = counts.roadQueries - before.roadQueries;
              phase.heightQueries += heightQueries;
              phase.flatQueries += flatQueries;
              phase.roadQueries += roadQueries;
              phase.maxHeightQueries = Math.max(
                phase.maxHeightQueries,
                heightQueries,
              );
              phase.maxFlatQueries = Math.max(
                phase.maxFlatQueries,
                flatQueries,
              );
              phase.maxRoadQueries = Math.max(
                phase.maxRoadQueries,
                roadQueries,
              );
              cost.steps++;
              cost.cpuMs += elapsed;
              cost.maxStepMs = Math.max(cost.maxStepMs, elapsed);
              // Deterministic per-next work counts, not machine-time acceptance.
              expect(heightQueries).toBeLessThanOrEqual(128);
              expect(flatQueries).toBeLessThanOrEqual(64);
              expect(roadQueries).toBeLessThanOrEqual(32);
              if (next.done) {
                completed = true;
                return { value: next.value, cost };
              }
            }
          } finally {
            if (!completed) iterator.return(undefined as never);
          }
        };
        const treeConfig = {
          minSize: terrain["CONFIG"].QUADTREE_MIN_SIZE,
          maxDepth: terrain["CONFIG"].QUADTREE_MAX_DEPTH,
          resolution: 32,
          rootChunkRadius: 0,
        };
        tree = new TerrainQuadTree({
          ...treeConfig,
          fineDetailRegions: createCompactPreparationDetailRegions(
            profile,
            candidateAreas,
            terrain["CONFIG"].QUADTREE_RESOLUTION,
          ),
        });
        tree.update(368, 390.75);
        const baselineTree = new TerrainQuadTree({
          ...treeConfig,
          fineDetailRegions: createCompactPreparationDetailRegions(
            live,
            Object.fromEntries(originalAreas),
            before["CONFIG"].QUADTREE_RESOLUTION,
          ),
        });
        const predecessorResolutions = new Map<string, number>();
        try {
          baselineTree.update(368, 390.75);
          const layout = (value: TerrainQuadTree) =>
            value.getFinalNodes().map((node) => ({
              x: node.centerX,
              z: node.centerZ,
              size: node.size,
              resolution: node.resolution,
            }));
          const previousLayout = layout(baselineTree);
          for (const node of previousLayout)
            predecessorResolutions.set(
              `${node.x},${node.z},${node.size}`,
              node.resolution,
            );
          // The optional head requires real production detail admission. The
          // no-head baseline keeps its exact old layout; only leaves with area
          // inside the declared head support may receive the 128 grid.
          const head = profile.coastalApron?.headShoulder;
          expect(layout(tree)).toEqual(
            previousLayout.map((node) => {
              const intersectsHead =
                head &&
                node.x + node.size / 2 > head.minX &&
                node.x - node.size / 2 < head.maxX &&
                node.z + node.size / 2 > head.minZ &&
                node.z - node.size / 2 < head.maxZ;
              return intersectsHead ? { ...node, resolution: 128 } : node;
            }),
          );
        } finally {
          baselineTree.dispose();
        }
        const allPoints = [...points.values()];
        const leaves = tree
          .getFinalNodes()
          .filter((node) =>
            allPoints.some(
              ([x, z]) =>
                x >= node.boundingBox.xMin &&
                x <= node.boundingBox.xMax &&
                z >= node.boundingBox.zMin &&
                z <= node.boundingBox.zMax,
            ),
          );
        quad = actualWorker(QUAD_CHUNK_WORKER_CODE);
        let workerVertices = 0,
          changedSamples = 0;
        for (const node of leaves) {
          expect(node.size).toBe(100);
          expect([64, 128]).toContain(node.resolution);
          const output = await quad.run<QuadChunkWorkerOutput>({
            type: "generateQuadChunk",
            centerX: node.centerX,
            centerZ: node.centerZ,
            size: node.size,
            resolution: node.resolution,
            config: createTerrainWorkerConfig(profile, node.resolution),
            seed: setup.seed,
            biomeCenters: setup.biomeCenters,
            biomes: setup.biomes,
          });
          expect(output.terrainProfileIdentity).toBe(
            worldTerrainProfileIdentity(profile),
          );
          const step = node.size / (node.resolution - 1);
          for (let iz = 0; iz < node.resolution; iz++)
            for (let ix = 0; ix < node.resolution; ix++) {
              const x = node.centerX - node.size / 2 + ix * step,
                z = node.centerZ - node.size / 2 + iz * step;
              expect(output.heightData[iz * node.resolution + ix]).toBe(
                Math.fround(terrain["getHeightAtComputedSkipFlatZone"](x, z)),
              );
              workerVertices++;
            }
          const lease = provider.capturePreparationLease(
            setup.biomeCenters,
            setup.biomes,
          );
          expect(lease.isCurrent()).toBe(true);
          const syncCounts = newCounts(),
            stepCounts = newCounts();
          const assemblyStart = performance.now();
          const sync = assembleQuadChunkGeometry(
            output,
            countedProvider(syncCounts),
            terrain["CONFIG"].QUADTREE_SKIRT_DROP,
          );
          preparationGeometries.add(sync.geometry);
          const retentionStart = performance.now();
          const syncSurface = new RetainedTerrainSurface(
            node.id,
            worldTerrainProfileIdentity(profile),
            node.centerX,
            node.centerZ,
            node.size,
            node.resolution,
            sync.geometry,
          );
          const retentionMs = performance.now() - retentionStart;
          const staged = drainPreparation(
            assembleQuadChunkGeometrySteps(
              output,
              countedProvider(stepCounts),
              terrain["CONFIG"].QUADTREE_SKIRT_DROP,
            ),
            stepCounts,
            lease,
          );
          const { geometry, heightData } = staged.value;
          preparationGeometries.add(geometry);
          expect(lease.isCurrent()).toBe(true);
          expect(bytes(heightData).equals(bytes(sync.heightData))).toBe(true);
          expect(Object.keys(geometry.attributes)).toEqual(
            Object.keys(sync.geometry.attributes),
          );
          for (const [name, attribute] of Object.entries(
            sync.geometry.attributes,
          )) {
            if (!("array" in attribute))
              throw new Error("Unexpected interleaved terrain attribute");
            const actual = geometry.getAttribute(name);
            expect(actual.itemSize, name).toBe(attribute.itemSize);
            expect(actual.normalized, name).toBe(attribute.normalized);
            expect(actual.array.constructor, name).toBe(
              attribute.array.constructor,
            );
            expect(
              bytes(actual.array).equals(bytes(attribute.array)),
              name,
            ).toBe(true);
          }
          expect(
            bytes(geometry.getIndex()!.array).equals(
              bytes(sync.geometry.getIndex()!.array),
            ),
          ).toBe(true);
          expect(
            Buffer.from(
              JSON.stringify(geometry.userData.terrainCellTopology ?? null),
            ).equals(
              Buffer.from(
                JSON.stringify(
                  sync.geometry.userData.terrainCellTopology ?? null,
                ),
              ),
            ),
          ).toBe(true);
          expect(geometry.boundingBox).toEqual(sync.geometry.boundingBox);
          expect(geometry.boundingSphere).toEqual(sync.geometry.boundingSphere);
          const heightDataSHA256 = arrayHash(heightData);
          const proof = geometryProof(geometry, heightDataSHA256);
          expect(proof).toEqual(
            geometryProof(sync.geometry, arrayHash(sync.heightData)),
          );
          const geometryProofSHA256 = createHash("sha256")
            .update(JSON.stringify(proof))
            .digest("hex");
          const prepared = drainPreparation(
            RetainedTerrainSurface.prepare(
              node.id,
              worldTerrainProfileIdentity(profile),
              node.centerX,
              node.centerZ,
              node.size,
              node.resolution,
              geometry,
            ),
            stepCounts,
            lease,
          );
          expect(prepared.value.matchesGeometry(geometry)).toBe(true);
          expect(lease.isCurrent()).toBe(true);
          expect(stepCounts).toEqual(syncCounts);
          retained.push({
            node,
            geometry,
            surface: prepared.value,
            syncSurface,
            assemblyMs: retentionStart - assemblyStart,
            retentionMs,
            heightDataSHA256,
            preparation: {
              assembly: staged.cost,
              retention: prepared.cost,
              evaluations: stepCounts,
              geometryProofSHA256,
              exactStagedSyncBytes: true,
            },
          });
        }
        const sample: TerrainGridSample = {
          height: 0,
          nx: 0,
          ny: 1,
          nz: 0,
          faceIndex: 0,
        };
        const syncSample = { ...sample };
        let minHeight = Infinity,
          maxGrade = 0,
          maxFaceGrade = 0,
          maxGap = 0,
          maxAngle = 0,
          wet = 0,
          wetCorners = 0;
        let worstGap: number[] = [],
          worstGrade: number[] = [];
        let worstAngle: number[] = [],
          awayWorstGap: number[] = [],
          awayWorstAngle: number[] = [];
        let awayMaxGap = 0,
          awayMaxAngle = 0,
          crossingSamples = 0,
          awaySamples = 0;
        const crossingCells = new Map<string, boolean>();
        const corners = new Set<string>();
        const normal = new THREE.Vector3(),
          canonicalNormal = new THREE.Vector3();
        for (const [x, z] of allPoints) {
          const y = height(x, z);
          minHeight = Math.min(minHeight, y);
          if (y !== before.getResourceGroundHeight(x, z)) changedSamples++;
          const gx = (height(x + 0.25, z) - height(x - 0.25, z)) / 0.5,
            gz = (height(x, z + 0.25) - height(x, z - 0.25)) / 0.5;
          const grade = Math.hypot(gx, gz);
          if (grade > maxGrade) {
            maxGrade = grade;
            worstGrade = [x, z, y, grade];
          }
          canonicalNormal.set(-gx, 1, -gz).normalize();
          if (
            terrain.world.collision.hasFlags(
              Math.floor(x),
              Math.floor(z),
              CollisionFlag.WATER,
            )
          )
            wet++;
          let hits = 0;
          for (const entry of retained) {
            const stagedHit = entry.surface.sample(
              x - entry.node.centerX,
              z - entry.node.centerZ,
              sample,
            );
            expect(
              entry.syncSurface.sample(
                x - entry.node.centerX,
                z - entry.node.centerZ,
                syncSample,
              ),
            ).toBe(stagedHit);
            if (!stagedHit) continue;
            expect(sample).toEqual(syncSample);
            hits++;
            const gap = Math.abs(sample.height - y);
            if (gap > maxGap) {
              maxGap = gap;
              worstGap = [
                x,
                z,
                y,
                sample.height,
                entry.node.id,
                entry.node.resolution,
              ];
            }
            maxFaceGrade = Math.max(
              maxFaceGrade,
              Math.hypot(sample.nx, sample.nz) / sample.ny,
            );
            normal.set(sample.nx, sample.ny, sample.nz);
            const angle = (normal.angleTo(canonicalNormal) * 180) / Math.PI;
            if (angle > maxAngle) {
              maxAngle = angle;
              worstAngle = [x, z, angle, entry.node.id, entry.node.resolution];
            }
            const indices = entry.geometry.getIndex()!,
              position = entry.geometry.getAttribute("position");
            const topology = entry.geometry.userData.terrainCellTopology as
              { readonly cellIndexOffsets: readonly number[] } | undefined;
            let cell = Math.floor(sample.faceIndex / 2);
            if (topology) {
              const offsets = topology.cellIndexOffsets;
              let lo = 0,
                hi = offsets.length - 1;
              while (lo + 1 < hi) {
                const mid = (lo + hi) >>> 1;
                if (offsets[mid] <= sample.faceIndex * 3) lo = mid;
                else hi = mid;
              }
              cell = lo;
            }
            const cellKey = `${entry.node.id}:${cell}`;
            let crossing = crossingCells.get(cellKey);
            if (crossing === undefined) {
              // Diagnostic attribution only. Refinement retains the original
              // regular grid first, so use its four coarse-cell corners without
              // confusing variable face ranges with legacy paired triangles.
              const r = entry.node.resolution,
                row = Math.floor(cell / (r - 1)),
                column = cell % (r - 1),
                a = row * r + column;
              const cellIndices = [a, a + 1, a + r, a + r + 1];
              crossing = backingBoxes.some((box) => {
                let inside = 0;
                for (const i of cellIndices) {
                  const vx = entry.node.centerX + position.getX(i),
                    vz = entry.node.centerZ + position.getZ(i);
                  if (
                    vx >= box.minX &&
                    vx <= box.maxX &&
                    vz >= box.minZ &&
                    vz <= box.maxZ
                  )
                    inside++;
                }
                return inside > 0 && inside < 4;
              });
              crossingCells.set(cellKey, crossing);
            }
            if (crossing) crossingSamples++;
            else {
              awaySamples++;
              if (gap > awayMaxGap) {
                awayMaxGap = gap;
                awayWorstGap = [
                  x,
                  z,
                  y,
                  sample.height,
                  entry.node.id,
                  entry.node.resolution,
                ];
              }
              if (angle > awayMaxAngle) {
                awayMaxAngle = angle;
                awayWorstAngle = [
                  x,
                  z,
                  angle,
                  entry.node.id,
                  entry.node.resolution,
                ];
              }
            }
            for (let k = 0; k < 3; k++) {
              const i = indices.getX(sample.faceIndex * 3 + k),
                key = `${entry.node.id}:${i}`;
              if (corners.has(key)) continue;
              corners.add(key);
              minHeight = Math.min(minHeight, position.getY(i));
              if (
                terrain.world.collision.hasFlags(
                  Math.floor(entry.node.centerX + position.getX(i)),
                  Math.floor(entry.node.centerZ + position.getZ(i)),
                  CollisionFlag.WATER,
                )
              )
                wetCorners++;
            }
          }
          expect(hits).toBeGreaterThan(0);
        }
        const worstEntry = retained.find(
          (entry) => entry.node.id === worstGap[4],
        )!;
        const baselineSetup = before["buildGrassWorkerSetup"]();
        const baselineOutput = await quad.run<QuadChunkWorkerOutput>({
          type: "generateQuadChunk",
          centerX: worstEntry.node.centerX,
          centerZ: worstEntry.node.centerZ,
          size: worstEntry.node.size,
          resolution: worstEntry.node.resolution,
          config: createTerrainWorkerConfig(live, worstEntry.node.resolution),
          seed: baselineSetup.seed,
          biomeCenters: baselineSetup.biomeCenters,
          biomes: baselineSetup.biomes,
        });
        const baselineGeometry = assembleQuadChunkGeometry(
          baselineOutput,
          before["buildChunkTerrainProvider"](),
          before["CONFIG"].QUADTREE_SKIRT_DROP,
        ).geometry;
        let baselineWorst;
        try {
          const baselineSurface = new RetainedTerrainSurface(
            worstEntry.node.id,
            worldTerrainProfileIdentity(live),
            worstEntry.node.centerX,
            worstEntry.node.centerZ,
            worstEntry.node.size,
            worstEntry.node.resolution,
            baselineGeometry,
          );
          const triangleAt = (
            surface: RetainedTerrainSurface,
            geometry: THREE.BufferGeometry,
          ) => {
            const value: TerrainGridSample = {
              height: 0,
              nx: 0,
              ny: 1,
              nz: 0,
              faceIndex: 0,
            };
            expect(
              surface.sample(
                worstGap[0] - worstEntry.node.centerX,
                worstGap[1] - worstEntry.node.centerZ,
                value,
              ),
            ).toBe(true);
            const position = geometry.getAttribute("position"),
              indices = geometry.getIndex()!;
            return {
              sample: { ...value },
              vertices: Array.from({ length: 3 }, (_, k) => {
                const i = indices.getX(value.faceIndex * 3 + k);
                return [
                  worstEntry.node.centerX + position.getX(i),
                  position.getY(i),
                  worstEntry.node.centerZ + position.getZ(i),
                ];
              }),
            };
          };
          const previous = triangleAt(baselineSurface, baselineGeometry),
            current = triangleAt(worstEntry.surface, worstEntry.geometry);
          const canonical = before.getResourceGroundHeight(
            worstGap[0],
            worstGap[1],
          );
          baselineWorst = {
            x: worstGap[0],
            z: worstGap[1],
            canonical,
            gap: Math.abs(previous.sample.height - canonical),
            previous,
            current,
          };
        } finally {
          baselineGeometry.dispose();
        }
        // Real grass transport also consumes the authored rounded height zones,
        // unlike the raw quad worker whose host assembly applies grading.
        grass = actualWorker(GRASS_WORKER_CODE);
        const input: GrassWorkerInput = {
          type: "generateGrassInstances",
          config: createTerrainWorkerConfig(profile, 64),
          seed: setup.seed,
          biomeCenters: setup.biomeCenters,
          biomes: setup.biomes,
          chunkKey: "southern-meadow-rounded-backing",
          centerX: 385,
          centerZ: 430,
          size: 25,
          spacingMul: 1,
          grassSeed: 37,
          clumpSpacing: GRASS_CONFIG.CLUMP_SPACING,
          scaleMin: GRASS_CONFIG.SCALE_MIN,
          scaleMax: GRASS_CONFIG.SCALE_MAX,
          waterThreshold: profile.water.threshold,
          grassConfigs: setup.grassConfigs,
          shaderConstants: TERRAIN_SHADER_CONSTANTS,
          roadSegments: setup.getRoadSegmentsForRegion(
            372.5,
            417.5,
            397.5,
            442.5,
          ),
          roadBlendWidth: 0.5,
          tileSize: 100,
          grassEligibility: "compact-pbr-v1",
          terrainSurface: setup.getTerrainSurfaceForRegion(372, 417, 398, 443),
        };
        const result = await grass.run<GrassWorkerOutput>(input);
        expect(result.terrainProfileIdentity).toBe(
          worldTerrainProfileIdentity(profile),
        );
        expect(result.count).toBeGreaterThan(0);
        for (let i = 0; i < result.count; i++)
          expect(result.offsets[i * 3 + 1]).toBeCloseTo(
            height(
              input.centerX + result.offsets[i * 3],
              input.centerZ + result.offsets[i * 3 + 2],
            ),
            4,
          );

        if (withHeadShoulder) {
          // Assemble the exact no-head predecessor under the SAME real rounded
          // support owners. Scalar wet/dry samples cannot prove an interpolated
          // triangle's waterline stays put when its dry vertex moves.
          const baselineWorld = new World();
          worlds.push(baselineWorld);
          const baselineTerrain = baselineWorld.register(
            "terrain",
            TerrainSystem,
          ) as TerrainSystem;
          baselineTerrain["activeTerrainProfile"] = baselineProfile;
          await baselineTerrain.init();
          baselineTerrain["loadWaterBodiesFromManifest"]();
          baselineTerrain["loadFlatZonesFromManifest"]();
          const baselineSetup = baselineTerrain["buildGrassWorkerSetup"]();
          const baselineProvider =
            baselineTerrain["buildChunkTerrainProvider"]();
          let changedVertices = 0,
            maxDrop = 0,
            shorelineEdges = 0;
          let maxWaterlineShift = 0,
            maxWetTriangleChange = 0;
          const predecessorSurfaces = new Map<number, RetainedTerrainSurface>();
          const shapePredecessorProofs: Record<string, string> = {};
          const footprint = (geometry: THREE.BufferGeometry) => {
            const topology = geometry.userData.terrainCellTopology as
              { readonly cellIndexOffsets: readonly number[] } | undefined;
            return {
              vertices: geometry.getAttribute("position").count,
              triangles: geometry.getIndex()!.count / 3,
              attributeBytes: Object.values(geometry.attributes).reduce(
                (total, attribute) => {
                  if (!("array" in attribute))
                    throw new Error("Unexpected interleaved terrain attribute");
                  return total + attribute.array.byteLength;
                },
                0,
              ),
              indexBytes: geometry.getIndex()!.array.byteLength,
              topologyNumberPayloadBytes:
                (topology?.cellIndexOffsets.length ?? 0) * 8,
            };
          };
          const densityCosts: {
            x: number;
            z: number;
            previousResolution: number;
            candidateResolution: number;
            previous: ReturnType<typeof footprint>;
            candidate: ReturnType<typeof footprint>;
            addedTriangles: number;
            addedTypedBufferBytes: number;
            addedTopologyNumberPayloadBytes: number;
          }[] = [];
          for (const entry of retained) {
            const node = entry.node;
            const output = await quad.run<QuadChunkWorkerOutput>({
              type: "generateQuadChunk",
              centerX: node.centerX,
              centerZ: node.centerZ,
              size: node.size,
              resolution: node.resolution,
              config: createTerrainWorkerConfig(
                baselineProfile,
                node.resolution,
              ),
              seed: baselineSetup.seed,
              biomeCenters: baselineSetup.biomeCenters,
              biomes: baselineSetup.biomes,
            });
            const baseline = assembleQuadChunkGeometry(
              output,
              baselineProvider,
              baselineTerrain["CONFIG"].QUADTREE_SKIRT_DROP,
            );
            preparationGeometries.add(baseline.geometry);
            predecessorSurfaces.set(
              node.id,
              new RetainedTerrainSurface(
                node.id,
                worldTerrainProfileIdentity(baselineProfile),
                node.centerX,
                node.centerZ,
                node.size,
                node.resolution,
                baseline.geometry,
              ),
            );
            const previousProof = geometryProof(
              baseline.geometry,
              arrayHash(baseline.heightData),
            );
            const shapeKey = `${node.centerX},${node.centerZ},${node.resolution}`;
            shapePredecessorProofs[shapeKey] = createHash("sha256")
              .update(JSON.stringify(previousProof))
              .digest("hex");
            // Isolate SHAPE at the same admitted 128 layout. Separately retain
            // the original 64 predecessor proof and measure its allocation delta.
            // Exact same-layout water edges do not prove 64-to-128 shoreline equality.
            const previousResolution = predecessorResolutions.get(
              `${node.centerX},${node.centerZ},${node.size}`,
            )!;
            let original = baseline;
            if (previousResolution !== node.resolution) {
              const originalOutput = await quad.run<QuadChunkWorkerOutput>({
                type: "generateQuadChunk",
                centerX: node.centerX,
                centerZ: node.centerZ,
                size: node.size,
                resolution: previousResolution,
                config: createTerrainWorkerConfig(
                  baselineProfile,
                  previousResolution,
                ),
                seed: baselineSetup.seed,
                biomeCenters: baselineSetup.biomeCenters,
                biomes: baselineSetup.biomes,
              });
              original = assembleQuadChunkGeometry(
                originalOutput,
                baselineProvider,
                baselineTerrain["CONFIG"].QUADTREE_SKIRT_DROP,
              );
              preparationGeometries.add(original.geometry);
            }
            const originalProof = geometryProof(
              original.geometry,
              arrayHash(original.heightData),
            );
            expect(
              createHash("sha256")
                .update(JSON.stringify(originalProof))
                .digest("hex"),
            ).toBe(
              expectedGeometryProofs[
                `${node.centerX},${node.centerZ},${previousResolution}`
              ],
            );
            const previousCost = footprint(original.geometry);
            const candidateCost = footprint(entry.geometry);
            expect(candidateCost).toEqual(footprint(baseline.geometry));
            densityCosts.push({
              x: node.centerX,
              z: node.centerZ,
              previousResolution,
              candidateResolution: node.resolution,
              previous: previousCost,
              candidate: candidateCost,
              addedTriangles: candidateCost.triangles - previousCost.triangles,
              addedTypedBufferBytes:
                candidateCost.attributeBytes +
                candidateCost.indexBytes -
                previousCost.attributeBytes -
                previousCost.indexBytes,
              addedTopologyNumberPayloadBytes:
                candidateCost.topologyNumberPayloadBytes -
                previousCost.topologyNumberPayloadBytes,
            });
            const oldPosition = baseline.geometry.getAttribute("position");
            const newPosition = entry.geometry.getAttribute("position");
            const indices = entry.geometry.getIndex()!;
            expect(
              bytes(indices.array).equals(
                bytes(baseline.geometry.getIndex()!.array),
              ),
            ).toBe(true);
            expect(newPosition.count).toBe(oldPosition.count);
            const topology = entry.geometry.userData.terrainCellTopology as
              | {
                  readonly cellIndexOffsets: readonly number[];
                  readonly surfaceVertexCount: number;
                }
              | undefined;
            const surfaceVertexCount =
              topology?.surfaceVertexCount ?? node.resolution ** 2;
            const surfaceIndexCount =
              topology?.cellIndexOffsets.at(-1) ??
              (node.resolution - 1) ** 2 * 6;
            for (let i = 0; i < surfaceVertexCount; i++) {
              expect(newPosition.getX(i)).toBe(oldPosition.getX(i));
              expect(newPosition.getZ(i)).toBe(oldPosition.getZ(i));
              const drop = oldPosition.getY(i) - newPosition.getY(i);
              if (drop !== 0) changedVertices++;
              maxDrop = Math.max(maxDrop, drop);
            }
            const visited = new Set<string>();
            for (let face = 0; face < surfaceIndexCount; face += 3) {
              const vertices = [
                indices.getX(face),
                indices.getX(face + 1),
                indices.getX(face + 2),
              ];
              if (
                vertices.some(
                  (i) => oldPosition.getY(i) <= profile.water.threshold,
                )
              )
                for (const i of vertices)
                  maxWetTriangleChange = Math.max(
                    maxWetTriangleChange,
                    Math.abs(newPosition.getY(i) - oldPosition.getY(i)),
                  );
              for (let k = 0; k < 3; k++) {
                const a = vertices[k],
                  b = vertices[(k + 1) % 3];
                const key = `${Math.min(a, b)},${Math.max(a, b)}`;
                if (visited.has(key)) continue;
                visited.add(key);
                const oldA = oldPosition.getY(a) - profile.water.threshold;
                const oldB = oldPosition.getY(b) - profile.water.threshold;
                const newA = newPosition.getY(a) - profile.water.threshold;
                const newB = newPosition.getY(b) - profile.water.threshold;
                expect(newA <= 0).toBe(oldA <= 0);
                expect(newB <= 0).toBe(oldB <= 0);
                if (oldA <= 0 === oldB <= 0) continue;
                shorelineEdges++;
                const oldT = oldA / (oldA - oldB),
                  newT = newA / (newA - newB);
                maxWaterlineShift = Math.max(
                  maxWaterlineShift,
                  Math.abs(newT - oldT) *
                    Math.hypot(
                      oldPosition.getX(b) - oldPosition.getX(a),
                      oldPosition.getZ(b) - oldPosition.getZ(a),
                    ),
                );
              }
            }
          }
          let changedHeadSamples = 0,
            maxHeadGap = 0,
            maxHeadNormalAngle = 0;
          const predecessorSample = { ...sample };
          const predecessorNormal = new THREE.Vector3();
          const predecessorCanonicalNormal = new THREE.Vector3();
          let predecessorHeadMaxGap = 0,
            predecessorHeadMaxNormalAngle = 0;
          let worstHead: number[] = [],
            worstHeadNormal: number[] = [];
          // Evaluate the changed surface itself, not just the intentionally
          // preserved travel bands. Steep rock is not required to be walkable;
          // its geometric representation still cannot silently lose fidelity.
          for (let x = 377; x <= 444; x += 0.5)
            for (let z = 457; z <= 500; z += 0.5) {
              const y = height(x, z);
              if (y === baselineTerrain.getResourceGroundHeight(x, z)) continue;
              changedHeadSamples++;
              canonicalNormal
                .set(
                  -(height(x + 0.25, z) - height(x - 0.25, z)) / 0.5,
                  1,
                  -(height(x, z + 0.25) - height(x, z - 0.25)) / 0.5,
                )
                .normalize();
              predecessorCanonicalNormal
                .set(
                  -(
                    baselineTerrain.getResourceGroundHeight(x + 0.25, z) -
                    baselineTerrain.getResourceGroundHeight(x - 0.25, z)
                  ) / 0.5,
                  1,
                  -(
                    baselineTerrain.getResourceGroundHeight(x, z + 0.25) -
                    baselineTerrain.getResourceGroundHeight(x, z - 0.25)
                  ) / 0.5,
                )
                .normalize();
              let hits = 0;
              for (const entry of retained) {
                if (
                  !entry.surface.sample(
                    x - entry.node.centerX,
                    z - entry.node.centerZ,
                    sample,
                  )
                )
                  continue;
                hits++;
                expect(
                  predecessorSurfaces
                    .get(entry.node.id)!
                    .sample(
                      x - entry.node.centerX,
                      z - entry.node.centerZ,
                      predecessorSample,
                    ),
                ).toBe(true);
                predecessorHeadMaxGap = Math.max(
                  predecessorHeadMaxGap,
                  Math.abs(
                    predecessorSample.height -
                      baselineTerrain.getResourceGroundHeight(x, z),
                  ),
                );
                predecessorHeadMaxNormalAngle = Math.max(
                  predecessorHeadMaxNormalAngle,
                  (predecessorNormal
                    .set(
                      predecessorSample.nx,
                      predecessorSample.ny,
                      predecessorSample.nz,
                    )
                    .angleTo(predecessorCanonicalNormal) *
                    180) /
                    Math.PI,
                );
                const gap = Math.abs(sample.height - y);
                const angle =
                  (normal
                    .set(sample.nx, sample.ny, sample.nz)
                    .angleTo(canonicalNormal) *
                    180) /
                  Math.PI;
                if (gap > maxHeadGap) {
                  maxHeadGap = gap;
                  worstHead = [x, z, y, sample.height];
                }
                if (angle > maxHeadNormalAngle) {
                  maxHeadNormalAngle = angle;
                  worstHeadNormal = [x, z, angle];
                }
              }
              expect(hits).toBeGreaterThan(0);
            }
          let roots = 0,
            changedRoots = 0,
            maxRootGap = 0,
            maxRootNormalAngle = 0;
          let worstRoot: number[] = [],
            worstRootNormal: number[] = [];
          const rootAttribution = {
            changed: {
              count: 0,
              candidateGap: 0,
              predecessorGap: 0,
              candidateAngle: 0,
              predecessorAngle: 0,
            },
            unchanged: {
              count: 0,
              candidateGap: 0,
              predecessorGap: 0,
              candidateAngle: 0,
              predecessorAngle: 0,
            },
          };
          // Fixed full 75 x 50 m coverage encloses the authored support; retain
          // every worker-admitted root, including roots outside the actual cut.
          for (const centerX of [387.5, 412.5, 437.5])
            for (const centerZ of [462.5, 487.5]) {
              const minX = centerX - 12.5,
                maxX = centerX + 12.5;
              const minZ = centerZ - 12.5,
                maxZ = centerZ + 12.5;
              const headInput: GrassWorkerInput = {
                ...input,
                chunkKey: `coastal-head-${centerX}-${centerZ}`,
                centerX,
                centerZ,
                roadSegments: setup.getRoadSegmentsForRegion(
                  minX,
                  minZ,
                  maxX,
                  maxZ,
                ),
                terrainSurface: setup.getTerrainSurfaceForRegion(
                  minX - 0.5,
                  minZ - 0.5,
                  maxX + 0.5,
                  maxZ + 0.5,
                ),
              };
              const headGrass = await grass.run<GrassWorkerOutput>(headInput);
              expect(headGrass.terrainProfileIdentity).toBe(
                worldTerrainProfileIdentity(profile),
              );
              for (let i = 0; i < headGrass.count; i++) {
                const x = centerX + headGrass.offsets[i * 3];
                const z = centerZ + headGrass.offsets[i * 3 + 2];
                const rootY = headGrass.offsets[i * 3 + 1];
                expect(rootY).toBeCloseTo(height(x, z), 4);
                roots++;
                const predecessorY = baselineTerrain.getResourceGroundHeight(
                  x,
                  z,
                );
                const changed = height(x, z) !== predecessorY;
                if (changed) changedRoots++;
                const attribution = changed
                  ? rootAttribution.changed
                  : rootAttribution.unchanged;
                attribution.count++;
                const sd = GRASS_SURFACE_NORMAL_SAMPLE_DISTANCE;
                predecessorCanonicalNormal
                  .set(
                    -(
                      baselineTerrain.getResourceGroundHeight(x + sd, z) -
                      baselineTerrain.getResourceGroundHeight(x - sd, z)
                    ) /
                      (2 * sd),
                    1,
                    -(
                      baselineTerrain.getResourceGroundHeight(x, z + sd) -
                      baselineTerrain.getResourceGroundHeight(x, z - sd)
                    ) /
                      (2 * sd),
                  )
                  .normalize();
                const rootNormal = new THREE.Vector3(
                  headGrass.groundNormals[i * 3],
                  headGrass.groundNormals[i * 3 + 1],
                  headGrass.groundNormals[i * 3 + 2],
                ).normalize();
                let hits = 0;
                for (const entry of retained) {
                  if (
                    !entry.surface.sample(
                      x - entry.node.centerX,
                      z - entry.node.centerZ,
                      sample,
                    )
                  )
                    continue;
                  hits++;
                  expect(
                    predecessorSurfaces
                      .get(entry.node.id)!
                      .sample(
                        x - entry.node.centerX,
                        z - entry.node.centerZ,
                        predecessorSample,
                      ),
                  ).toBe(true);
                  const gap = Math.abs(sample.height - rootY);
                  const angle =
                    (normal
                      .set(sample.nx, sample.ny, sample.nz)
                      .angleTo(rootNormal) *
                      180) /
                    Math.PI;
                  attribution.candidateGap = Math.max(
                    attribution.candidateGap,
                    gap,
                  );
                  attribution.candidateAngle = Math.max(
                    attribution.candidateAngle,
                    angle,
                  );
                  attribution.predecessorGap = Math.max(
                    attribution.predecessorGap,
                    Math.abs(predecessorSample.height - predecessorY),
                  );
                  attribution.predecessorAngle = Math.max(
                    attribution.predecessorAngle,
                    (predecessorNormal
                      .set(
                        predecessorSample.nx,
                        predecessorSample.ny,
                        predecessorSample.nz,
                      )
                      .angleTo(predecessorCanonicalNormal) *
                      180) /
                      Math.PI,
                  );
                  if (gap > maxRootGap) {
                    maxRootGap = gap;
                    worstRoot = [x, z, rootY, sample.height];
                  }
                  if (angle > maxRootNormalAngle) {
                    maxRootNormalAngle = angle;
                    worstRootNormal = [x, z, angle];
                  }
                }
                expect(hits).toBeGreaterThan(0);
              }
            }
          console.log(
            "COVE_HEAD_RETAINED",
            JSON.stringify({
              changedVertices,
              maxDrop,
              shorelineEdges,
              maxWaterlineShift,
              maxWetTriangleChange,
              changedHeadSamples,
              maxHeadGap,
              maxHeadNormalAngle,
              predecessorHeadMaxGap,
              predecessorHeadMaxNormalAngle,
              worstHead,
              worstHeadNormal,
              roots,
              changedRoots,
              maxRootGap,
              maxRootNormalAngle,
              worstRoot,
              worstRootNormal,
              rootAttribution,
              shapePredecessorProofs,
              densityCosts,
              densityDelta: {
                retainedMeshCount: 0,
                triangles: densityCosts.reduce(
                  (total, entry) => total + entry.addedTriangles,
                  0,
                ),
                typedBufferBytes: densityCosts.reduce(
                  (total, entry) => total + entry.addedTypedBufferBytes,
                  0,
                ),
                topologyNumberPayloadBytes: densityCosts.reduce(
                  (total, entry) =>
                    total + entry.addedTopologyNumberPayloadBytes,
                  0,
                ),
                scope:
                  "Actual retained geometry buffers and unchanged leaf count; not measured native draw calls, GPU allocations or frame time.",
              },
              layouts: retained.map(({ node }) => [
                node.centerX,
                node.centerZ,
                node.size,
                node.resolution,
              ]),
              scope:
                "Actual worker and retained triangles under the detached combined profile. Waterline proof compares head/no-head at the SAME admitted resolution, not old64-to-new128 equality. No native movement, visuals, runtime grass projection or performance acceptance.",
            }),
          );
          // Soft assertions retain all failures and still execute the original
          // broad travel gates below; they do not waive any candidate gate.
          expect.soft(changedVertices).toBeGreaterThan(100);
          expect.soft(maxDrop).toBeGreaterThan(3);
          expect.soft(shorelineEdges).toBeGreaterThan(100);
          expect.soft(maxWaterlineShift).toBe(0);
          expect.soft(maxWetTriangleChange).toBe(0);
          expect.soft(changedHeadSamples).toBeGreaterThan(100);
          expect.soft(maxHeadGap).toBeLessThanOrEqual(0.05);
          expect.soft(maxHeadNormalAngle).toBeLessThanOrEqual(10);
          expect.soft(roots).toBeGreaterThan(100);
          expect.soft(changedRoots).toBeGreaterThan(100);
          expect.soft(maxRootGap).toBeLessThanOrEqual(0.05);
          expect.soft(maxRootNormalAngle).toBeLessThanOrEqual(10);
          for (const entry of retained) {
            const key = `${entry.node.centerX},${entry.node.centerZ},${entry.node.resolution}`;
            if (entry.node.centerZ === 450)
              expect(entry.preparation.geometryProofSHA256).not.toBe(
                shapePredecessorProofs[key],
              );
            else
              expect(entry.preparation.geometryProofSHA256).toBe(
                shapePredecessorProofs[key],
              );
          }
        }

        const groveRows = worldConfig!.compactResourceGroves!.regions.flatMap(
          (region) =>
            region.anchors.map((anchor) => ({
              region: region.id,
              id: anchor.id,
              subType: anchor.subType,
              x: anchor.position.x,
              z: anchor.position.z,
              scale: anchor.scale,
              rotation: anchor.rotation,
              authoredY: anchor.position.y,
              previousY: before.getResourceGroundHeight(
                anchor.position.x,
                anchor.position.z,
              ),
              candidateY: height(anchor.position.x, anchor.position.z),
            })),
        );
        expect(groveRows).toHaveLength(35);
        console.log(
          "SOUTHERN_MEADOW_COMBINED",
          JSON.stringify({
            recipe: meadow,
            coastalLowland: profile.coastalApron!.lowland,
            terrace: profile.terrace,
            ridgeBreakup: profile.ridgeBreakup,
            groveAdmission,
            backings: duel.flatZones,
            counts,
            accessibleSquareMetres: cells.size,
            reached: reached.size,
            diagonalEdges,
            samples: allPoints.length,
            protectedSamples,
            stationZones,
            protectedMismatchCount,
            protectedMismatches,
            outsideSamples,
            outsideMismatchCount,
            changedSamples,
            workerVertices,
            grassCount: result.count,
            leaves: leaves.map((node) => ({
              id: node.id,
              x: node.centerX,
              z: node.centerZ,
              size: node.size,
              resolution: node.resolution,
            })),
            geometryCost: retained.map((entry) => {
              const topology = entry.geometry.userData.terrainCellTopology as
                | {
                    readonly cellIndexOffsets: readonly number[];
                    readonly surfaceVertexCount: number;
                  }
                | undefined;
              const r = entry.node.resolution,
                index = entry.geometry.getIndex()!;
              const attributeBytes = Object.values(
                entry.geometry.attributes,
              ).reduce((sum, attribute) => {
                if (!("array" in attribute))
                  throw new Error("Unexpected interleaved terrain attribute");
                return sum + attribute.array.byteLength;
              }, 0);
              return {
                x: entry.node.centerX,
                z: entry.node.centerZ,
                resolution: r,
                vertices: entry.geometry.getAttribute("position").count,
                surfaceVertices: topology?.surfaceVertexCount ?? r * r,
                addedSurfaceVertices:
                  (topology?.surfaceVertexCount ?? r * r) - r * r,
                triangles: index.count / 3,
                baselineTriangles: (r - 1) ** 2 * 2 + (r - 1) * 8,
                attributeBytes,
                indexBytes: index.array.byteLength,
                offsetNumberPayloadBytes:
                  (topology?.cellIndexOffsets.length ?? 0) * 8,
                assemblyMs: entry.assemblyMs,
                retentionMs: entry.retentionMs,
                geometryProof: geometryProof(
                  entry.geometry,
                  entry.heightDataSHA256,
                ),
                stagedPreparation: {
                  ...entry.preparation,
                  scope:
                    "Actual World CPU iterator slices after a synchronous baseline (warm sequential diagnostic); phase labels identify the next returned yield. Lease-check timing is separate. Counts are real provider callback entries, not internal noise evaluations. No frame scheduler, native GPU, memory or performance acceptance.",
                },
                scope:
                  "Single CPU diagnostic timings and typed-buffer bytes, not native frame or memory acceptance",
              };
            }),
            minHeight,
            maxGrade,
            maxFaceGrade,
            maxGap,
            maxAngle,
            worstGap,
            worstGrade,
            worstAngle,
            floorCrossingDiagnostic: {
              crossingSamples,
              awaySamples,
              awayMaxGap,
              awayMaxAngle,
              awayWorstGap,
              awayWorstAngle,
              baselineWorst,
              scope:
                "Attribution only; all original travel samples still count in the unchanged final5cm/10degree gates.",
            },
            wet,
            wetCorners,
            groveCount: groveRows.length,
            groveHeightChanges: groveRows.filter(
              (row) => row.previousY !== row.candidateY,
            ),
            scope:
              "Candidate source and actual retained triangles only; no manifest activation, installed resource replacement or native movement/art acceptance.",
          }),
        );
        expect(protectedMismatchCount).toBe(0);
        expect(outsideMismatchCount).toBe(0);
        expect(changedSamples).toBeGreaterThan(1000);
        expect(minHeight).toBeGreaterThan(16.3);
        expect(wet).toBe(0);
        expect(wetCorners).toBe(0);
        expect(maxGrade).toBeLessThanOrEqual(0.4);
        expect(maxFaceGrade).toBeLessThanOrEqual(0.4);
        expect(maxGap).toBeLessThanOrEqual(0.05);
        expect(maxAngle).toBeLessThanOrEqual(10);
        // Report every proven sync/staged pair and complete the unchanged safety
        // gates before comparing the exact current candidate fingerprints.
        const actualGeometryProofs = Object.fromEntries(
          retained.map(({ node, preparation }) => [
            `${node.centerX},${node.centerZ},${node.resolution}`,
            preparation.geometryProofSHA256,
          ]),
        );
        if (withHeadShoulder) {
          expect(actualGeometryProofs["350,350,128"]).toBe(
            expectedGeometryProofs["350,350,128"],
          );
          expect(Object.keys(actualGeometryProofs).sort()).toEqual([
            "350,350,128",
            "350,450,128",
            "450,450,128",
          ]);
        } else expect(actualGeometryProofs).toEqual(expectedGeometryProofs);
      } finally {
        for (const geometry of preparationGeometries) geometry.dispose();
        tree?.dispose();
        await quad?.close();
        await grass?.close();
        for (const key of Object.keys(ALL_WORLD_AREAS))
          delete ALL_WORLD_AREAS[key];
        Object.assign(ALL_WORLD_AREAS, Object.fromEntries(originalAreas));
        expect(JSON.stringify(ALL_WORLD_AREAS)).toBe(areaBytes);
        expect(DataManager.getWorldTerrainProfile()).toBe(live);
        expect(DataManager.getWorldConfig()).toBe(worldConfig);
      }
    },
  );

  it("authors a broad connected dry coastal lowland on real corrected ground", async () => {
    const before = await fixture(
      validateWorldTerrainProfile({ ...predecessor(), coastalApron }),
    );
    const profile = validateWorldTerrainProfile({
      ...predecessor(),
      coastalApron: lowlandApron,
    });
    const terrain = await fixture(profile);
    for (const tx of [3, 4, 5])
      for (const tz of [4, 5]) terrain["bakeWalkabilityFlags"](tx, tz);
    const height = (x: number, z: number) =>
      terrain.getResourceGroundHeight(x, z);
    const points = [
      ...coveRouteSamples(),
      ...coveRouteSamples(lowlandDiagonalRoute),
      ...lowlandAreaSamples(),
    ];
    let minHeight = Infinity,
      maxGrade = 0,
      water = 0,
      changed = 0,
      maxChange = 0;
    let worst: number[] = [];
    for (const [x, z] of points) {
      const y = height(x, z);
      minHeight = Math.min(minHeight, y);
      const old = before.getResourceGroundHeight(x, z);
      if (old !== y) changed++;
      maxChange = Math.max(maxChange, Math.abs(old - y));
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        const grade = Math.abs(height(x + dx, z + dz) - y) / Math.hypot(dx, dz);
        if (grade > maxGrade) {
          maxGrade = grade;
          worst = [x, z, y, grade];
        }
      }
      if (
        terrain.world.collision.hasFlags(
          Math.floor(x),
          Math.floor(z),
          CollisionFlag.WATER,
        )
      )
        water++;
    }
    const grades = before.captureCanonicalGroundLease().supportBounds;
    let gradeChanges = 0,
      anchorChanges = 0,
      groveChanges = 0;
    for (const b of grades)
      for (let x = b.minX; x <= b.maxX; x += 2)
        for (let z = b.minZ; z <= b.maxZ; z += 2)
          if (height(x, z) !== before.getResourceGroundHeight(x, z))
            gradeChanges++;
    for (const area of Object.values(ALL_WORLD_AREAS))
      for (const entry of [
        ...(area.resources ?? []),
        ...(area.npcs ?? []),
        ...(area.stations ?? []),
      ])
        if (
          height(entry.position.x, entry.position.z) !==
          before.getResourceGroundHeight(entry.position.x, entry.position.z)
        )
          anchorChanges++;
    for (const region of DataManager.getWorldConfig()!.compactResourceGroves!
      .regions)
      for (const anchor of region.anchors)
        for (const [dx, dz] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ])
          if (
            height(anchor.position.x + dx, anchor.position.z + dz) !==
            before.getResourceGroundHeight(
              anchor.position.x + dx,
              anchor.position.z + dz,
            )
          )
            groveChanges++;
    const cells = new Map<string, { x: number; z: number }>();
    for (let z = 438; z < 492; z++) {
      const t = Math.max(0, Math.min(1, (z + 0.5 - 458) / 64)),
        center = 462 - 40 * t * t * (3 - 2 * t);
      for (let x = Math.ceil(center - 10); x + 0.5 <= center + 10; x++) {
        for (const [dx, dz] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
          [0.5, 0.5],
        ]) {
          expect(height(x + dx, z + dz)).toBeGreaterThan(16.3);
          expect(
            terrain.world.collision.hasFlags(x, z, CollisionFlag.WATER),
          ).toBe(false);
        }
        cells.set(`${x},${z}`, { x, z });
      }
    }
    const queue = [cells.values().next().value!],
      reached = new Set([`${queue[0].x},${queue[0].z}`]);
    let diagonalEdges = 0,
      maxLinkGrade = 0;
    for (let i = 0; i < queue.length; i++)
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]) {
        const a = queue[i],
          key = `${a.x + dx},${a.z + dz}`,
          b = cells.get(key);
        if (
          !b ||
          (dx !== 0 &&
            dz !== 0 &&
            (!cells.has(`${a.x + dx},${a.z}`) ||
              !cells.has(`${a.x},${a.z + dz}`)))
        )
          continue;
        if (dx !== 0 && dz !== 0) diagonalEdges++;
        const start = height(a.x + 0.5, a.z + 0.5),
          length = Math.hypot(dx, dz);
        for (const u of [0.25, 0.5, 0.75, 1]) {
          const x = a.x + 0.5 + dx * u,
            z = a.z + 0.5 + dz * u,
            y = height(x, z);
          expect(y).toBeGreaterThan(16.3);
          maxLinkGrade = Math.max(
            maxLinkGrade,
            Math.abs(y - start) / (u * length),
          );
        }
        if (!reached.has(key)) {
          reached.add(key);
          queue.push(b);
        }
      }
    expect(cells.size).toBeGreaterThanOrEqual(1000);
    expect(reached.size).toBe(cells.size);
    expect(diagonalEdges).toBeGreaterThan(1000);
    expect(maxLinkGrade).toBeLessThanOrEqual(0.4);
    const union = [
      ...canonicalSupports,
      { minX: 444, maxX: 504, minZ: 435, maxZ: 459 },
      { minX: 376, maxX: 504, minZ: 457, maxZ: 541 },
    ];
    let outside = 0;
    for (let x = 150; x <= 550; x += 4)
      for (let z = 200; z <= 600; z += 4)
        if (!insideSupports(x, z, union)) {
          expect(height(x, z)).toBe(before.getResourceGroundHeight(x, z));
          outside++;
        }
    console.log(
      "COVE_LOWLAND_NUMERIC",
      JSON.stringify({
        recipe: lowlandApron.lowland,
        points: points.length,
        areaPoints: lowlandAreaSamples().length,
        minHeight,
        maxGrade,
        water,
        changed,
        maxChange,
        worst,
        gradeChanges,
        anchorChanges,
        groveChanges,
        outside,
        connectedAreaSquareMetres: cells.size,
        reached: reached.size,
        diagonalEdges,
        maxLinkGrade,
        diagonalRoute: lowlandDiagonalRoute,
        proposedCamera: {
          eye: [495, 53, 503],
          target: [449, height(449, 467) + 0.35, 467],
          eyeGround: height(495, 503),
          targetGround: height(449, 467),
        },
        grades,
        sections: [436, 448, 458, 470, 480, 490, 493].map((z) => ({
          z,
          heights: [410, 425, 440, 455, 470, 485].map((x) => [x, height(x, z)]),
        })),
      }),
    );
    expect(gradeChanges).toBe(0);
    expect(anchorChanges).toBe(0);
    expect(groveChanges).toBe(0);
    expect(minHeight).toBeGreaterThan(16.3);
    expect(water).toBe(0);
    expect(maxGrade).toBeLessThanOrEqual(0.4);
    expect(changed).toBeGreaterThan(2000);
  });
  it("binds strict optional authoring and its normalization/support to the existing profile identity", () => {
    expect(DataManager.getWorldTerrainProfile().coastalApron).toEqual(
      lowlandApron,
    );
    const current = DataManager.getWorldTerrainProfile();
    expect(Object.isFrozen(current.coastalApron!.lowland)).toBe(true);
    const { lowland: _lowland, ...historicalApron } = current.coastalApron!;
    expect(historicalApron).toEqual(coastalApron);
    expect(
      serializeWorldTerrainProfile(
        validateWorldTerrainProfile(JSON.parse(JSON.stringify(current))),
      ),
    ).toBe(serializeWorldTerrainProfile(current));
    const old = predecessor(),
      candidate = validateWorldTerrainProfile({ ...old, coastalApron });
    expect(candidate.algorithm).toBe(old.algorithm);
    expect(candidate.id).toBe(old.id);
    expect(worldTerrainProfileIdentity(candidate)).not.toBe(
      worldTerrainProfileIdentity(old),
    );
    expect(
      serializeWorldTerrainProfile(
        validateWorldTerrainProfile(JSON.parse(JSON.stringify(candidate))),
      ),
    ).toBe(serializeWorldTerrainProfile(candidate));
    const { coastalApron: removed, ...stable } = candidate;
    expect(stable).toEqual(old);
    expect(Object.isFrozen(removed)).toBe(true);
    expect(createCompactCoastalApron().supportBounds(removed!)).toEqual(
      rawSupports,
    );
    expect(Object.isFrozen(removed!.westernShoulder)).toBe(true);
    const region = createCompactPreparationDetailRegions(
      candidate,
      ALL_WORLD_AREAS,
      64,
    )[3];
    expect(
      getCompactCoastalApronSupport(candidate.island, candidate.landform!),
    ).toEqual({
      minX: region.minX,
      maxX: region.maxX,
      maxZ: region.maxZ,
      minZ: region.minZ,
    });
    expect(
      createCompactPreparationDetailRegions(candidate, ALL_WORLD_AREAS, 64),
    ).toEqual(createCompactPreparationDetailRegions(old, ALL_WORLD_AREAS, 64));
    for (const invalid of [
      { ...old, coastalApron: undefined },
      { ...old, coastalApron: null },
      { ...SCULPTED_COMPACT_V4_PROFILE_FIXTURE, coastalApron },
      { ...old, coastalApron: { ...coastalApron, halo: 0.5 } },
      { ...old, coastalApron: { ...coastalApron, minZ: 431 } },
      { ...old, water: { ...old.water, oceanFloorHeight: 3 }, coastalApron },
      { ...old, height: { ...old.height, baseOffset: 29 }, coastalApron },
      // Original apron fits, but this wider optional shoulder escapes the
      // independently admitted bay/detail domain (including its one-metre halo).
      {
        ...old,
        coastalApron: {
          ...coastalApron,
          westernShoulder: { ...coastalApron.westernShoulder, maxWidth: 100 },
        },
      },
    ])
      expect(() => validateWorldTerrainProfile(invalid)).toThrow();
    let reads = 0;
    const getter = Object.defineProperty({ ...old }, "coastalApron", {
      enumerable: true,
      get() {
        reads++;
        return coastalApron;
      },
    });
    expect(() => validateWorldTerrainProfile(getter)).toThrow();
    expect(reads).toBe(0);
  });
  it("retains a fixed three-metre dry approach on actual corrected ground", async () => {
    const candidate = validateWorldTerrainProfile({
      ...DataManager.getWorldTerrainProfile(),
      coastalApron,
    });
    const current = await fixture(candidate);
    const height = (x: number, z: number) =>
      current.getResourceGroundHeight(x, z);
    const route = coveRoute,
      samples = coveRouteSamples();
    for (const tx of [4, 5])
      for (const tz of [4, 5]) current["bakeWalkabilityFlags"](tx, tz);
    let minHeight = Infinity,
      maxGrade = 0,
      minNearshoreCardinal = Infinity,
      wet = 0,
      nearshore = 0;
    let worst: number[] = [];
    for (const [x, z] of samples) {
      const y = height(x, z);
      minHeight = Math.min(minHeight, y);
      const slopes = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ].map(
        ([dx, dz]) => Math.abs(height(x + dx, z + dz) - y) / Math.hypot(dx, dz),
      );
      const slope = Math.max(...slopes);
      if (slope > maxGrade) {
        maxGrade = slope;
        worst = [x, z, y, slope];
      }
      if (y < 19) {
        nearshore++;
        minNearshoreCardinal = Math.min(
          minNearshoreCardinal,
          Math.max(...slopes.slice(0, 4)),
        );
      }
      if (
        current.world.collision.hasFlags(
          Math.floor(x),
          Math.floor(z),
          CollisionFlag.WATER,
        )
      )
        wet++;
    }
    console.log(
      "COVE_FIXED_ROUTE",
      JSON.stringify({
        route,
        width: 3,
        sampleSpacing: 0.25,
        samples: samples.length,
        minHeight,
        maxGrade,
        minNearshoreCardinal,
        nearshore,
        wet,
        worst,
        start: height(...(route[0] as [number, number])),
        end: height(...(route.at(-1)! as [number, number])),
      }),
    );
    expect(minHeight).toBeGreaterThan(16.3);
    expect(maxGrade).toBeLessThanOrEqual(0.4);
    expect(nearshore).toBeGreaterThan(100);
    expect(minNearshoreCardinal).toBeGreaterThanOrEqual(0.065);
    expect(wet).toBe(0);
    expect(height(...(route[0] as [number, number]))).toBeGreaterThan(27);
    expect(height(...(route.at(-1)! as [number, number]))).toBeLessThan(18.2);
  });
  it("widens only the western embankment while preserving route heights and bounded neighboring grades", async () => {
    const base = predecessor();
    const old = await fixture(
      validateWorldTerrainProfile({
        ...base,
        coastalApron: previousCoastalApron,
      }),
    );
    const current = await fixture(
      validateWorldTerrainProfile({ ...base, coastalApron }),
    );
    let preserved = 0,
      changed = 0,
      maxHeightChange = 0,
      maxOldGrade = 0,
      maxNewGrade = 0,
      maxStencilDelta = 0,
      maxNeighborGrade = 0;
    let worstStencil: number[] = [];
    for (const [x, z] of coveRouteSamples())
      for (const [dx, dz] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]) {
        const before = old.getResourceGroundHeight(x + dx, z + dz),
          after = current.getResourceGroundHeight(x + dx, z + dz),
          difference = Math.abs(after - before);
        if (difference > maxStencilDelta) {
          maxStencilDelta = difference;
          worstStencil = [x + dx, z + dz, before, after];
        }
        if (before === after) preserved++;
        if (dx === 0 && dz === 0) expect(after, `route ${x},${z}`).toBe(before);
        else
          maxNeighborGrade = Math.max(
            maxNeighborGrade,
            Math.abs(after - current.getResourceGroundHeight(x, z)) /
              Math.hypot(dx, dz),
          );
      }
    for (let z = 459; z <= 540; z += 2)
      for (let x = 426; x <= 452; x += 0.5) {
        const before = old.getResourceGroundHeight(x, z),
          after = current.getResourceGroundHeight(x, z);
        if (before !== after) changed++;
        maxHeightChange = Math.max(maxHeightChange, Math.abs(after - before));
        if (x <= 426 || x >= 452 || z <= 459 || z >= 540)
          expect(after).toBe(before);
        // Independent fixed bank cross-sections, not selected after finding a
        // better location. This measures the collar face, not walking acceptance.
        if (z >= 479 && z <= 513) {
          maxOldGrade = Math.max(
            maxOldGrade,
            Math.abs(
              old.getResourceGroundHeight(x + 0.25, z) -
                old.getResourceGroundHeight(x - 0.25, z),
            ) / 0.5,
          );
          maxNewGrade = Math.max(
            maxNewGrade,
            Math.abs(
              current.getResourceGroundHeight(x + 0.25, z) -
                current.getResourceGroundHeight(x - 0.25, z),
            ) / 0.5,
          );
        }
      }
    console.log(
      "COVE_WESTERN_SHOULDER",
      JSON.stringify({
        preserved,
        changed,
        maxHeightChange,
        maxOldGrade,
        maxNewGrade,
        maxStencilDelta,
        maxNeighborGrade,
        worstStencil,
        rawSupports,
        canonicalSupports,
      }),
    );
    expect(changed).toBeGreaterThan(0);
    expect(maxHeightChange).toBeGreaterThan(1);
    expect(maxNewGrade).toBeLessThan(maxOldGrade);
    // Canonical height itself samples a raw ±1 m shoreline stencil. A
    // canonical neighbor therefore reaches raw ±2 m: equality there was an
    // incorrect extra-halo claim (retained failed western-stencil01 receipt).
    // Preserve actual route height exactly, and its real neighbor-grade limit.
    expect(maxNeighborGrade).toBeLessThanOrEqual(0.4);
  });

  it("preserves outside ground, all actual grades, current grove anchors and existing routes", async () => {
    const live = DataManager.getWorldTerrainProfile();
    const previous = predecessor();
    const candidate = validateWorldTerrainProfile({
      ...previous,
      coastalApron,
    });
    const old = await fixture(previous),
      current = await fixture(candidate);
    const height = (x: number, z: number) =>
      current.getResourceGroundHeight(x, z);
    let changed = 0,
      unchangedOutside = 0,
      maximumChange = 0;
    for (let x = 150; x <= 550; x += 4)
      for (let z = 200; z <= 600; z += 4) {
        const before = old.getResourceGroundHeight(x, z),
          after = height(x, z);
        expect(Number.isFinite(after)).toBe(true);
        if (!insideSupports(x, z, canonicalSupports)) {
          expect(after, `outside ${x},${z}`).toBe(before);
          unchangedOutside++;
        }
        if (before !== after) {
          changed++;
          maximumChange = Math.max(maximumChange, Math.abs(after - before));
        }
      }
    expect(changed).toBeGreaterThan(0);
    expect(maximumChange).toBeGreaterThan(5);
    const same = (x: number, z: number) =>
      expect(height(x, z), `preserved ${x},${z}`).toBe(
        old.getResourceGroundHeight(x, z),
      );
    let boundary = 0,
      graded = 0,
      anchors = 0,
      groveAnchors = 0;
    for (const b of canonicalSupports) {
      for (let z = b.minZ; z <= b.maxZ; z += 0.5)
        for (const x of [b.minX - 0.0001, b.minX, b.maxX, b.maxX + 0.0001])
          if (!insideSupports(x, z, canonicalSupports)) {
            same(x, z);
            boundary++;
          }
      for (let x = b.minX; x <= b.maxX; x += 0.5)
        for (const z of [b.minZ - 0.0001, b.minZ, b.maxZ, b.maxZ + 0.0001])
          if (!insideSupports(x, z, canonicalSupports)) {
            same(x, z);
            boundary++;
          }
    }
    const supports = old.captureCanonicalGroundLease().supportBounds;
    expect(current.captureCanonicalGroundLease().supportBounds).toEqual(
      supports,
    );
    for (const b of supports) {
      expect(
        canonicalSupports.some(
          (s) =>
            b.maxX > s.minX &&
            b.minX < s.maxX &&
            b.maxZ > s.minZ &&
            b.minZ < s.maxZ,
        ),
      ).toBe(false);
      for (let x = b.minX; x <= b.maxX; x += 2)
        for (let z = b.minZ; z <= b.maxZ; z += 2) {
          same(x, z);
          graded++;
        }
    }
    for (const area of Object.values(ALL_WORLD_AREAS))
      for (const entry of [
        ...(area.resources ?? []),
        ...(area.npcs ?? []),
        ...(area.stations ?? []),
      ]) {
        same(entry.position.x, entry.position.z);
        anchors++;
      }
    for (const region of DataManager.getWorldConfig()!.compactResourceGroves!
      .regions) {
      expect(
        canonicalSupports.some(
          (s) =>
            region.bounds.maxX > s.minX &&
            region.bounds.minX < s.maxX &&
            region.bounds.maxZ > s.minZ &&
            region.bounds.minZ < s.maxZ,
        ),
      ).toBe(false);
      for (const anchor of region.anchors) {
        for (const [dx, dz] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ])
          same(anchor.position.x + dx, anchor.position.z + dz);
        groveAnchors++;
      }
    }
    expect(groveAnchors).toBeGreaterThan(20);
    expect(
      createCompactIslandPaths(
        candidate,
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        height,
      ),
    ).toEqual(
      createCompactIslandPaths(
        previous,
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        old.getResourceGroundHeight.bind(old),
      ),
    );
    console.log(
      "COVE_PREFLIGHT",
      JSON.stringify({
        changed,
        unchangedOutside,
        maximumChange,
        boundary,
        graded,
        anchors,
        groveAnchors,
      }),
    );
    expect(DataManager.getWorldTerrainProfile()).toBe(live);
  });

  it("joins across the old zero bay boundary without a clipped height overlay", () => {
    const old = predecessor(),
      candidate = validateWorldTerrainProfile({ ...old, coastalApron });
    const form = createCompactIslandLandform(),
      noise = new NoiseGenerator(old.seed);
    const c = Math.cos(old.landform!.inletBearing),
      s = Math.sin(old.landform!.inletBearing);
    const point = (along: number, across: number) =>
      [350 + along * c - across * s, 400 + along * s + across * c] as const;
    let opened = 0;
    for (const along of [135, 140, 145, 150, 155]) {
      let lo = -50,
        hi = 8;
      if (form.mask(...point(along, lo), noise, old) === 0) continue;
      expect(form.mask(...point(along, hi), noise, old)).toBe(0);
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (form.mask(...point(along, mid), noise, old) === 0) hi = mid;
        else lo = mid;
      }
      const [x, z] = point(along, hi);
      const middle = form.height(x, z, noise, candidate);
      if (middle <= candidate.water.oceanFloorHeight + 0.001) continue;
      opened++;
      const e = 1e-4;
      const a = form.height(...point(along, hi - e), noise, candidate),
        b = form.height(...point(along, hi + e), noise, candidate);
      expect(Math.abs(b - a)).toBeLessThan(0.002);
      expect(Math.abs((middle - a) / e - (b - middle) / e)).toBeLessThan(0.002);
    }
    expect(opened).toBeGreaterThan(0);
    // The optional factor cannot expand the positive outer coastline. Exact
    // unchanged outside samples include the complete old western bank.
    for (let x = 150; x <= 550; x += 5)
      for (let z = 200; z <= 600; z += 5) {
        const before = form.mask(x, z, noise, old),
          after = form.mask(x, z, noise, candidate);
        expect(after).toBeGreaterThanOrEqual(0);
        expect(after).toBeLessThanOrEqual(1);
        if (!insideSupports(x, z, rawSupports)) expect(after).toBe(before);
        if (
          Math.hypot(x - 350, z - 400) >=
          old.island.radius * (1 + old.island.maxCoastVariation)
        )
          expect(after).toBe(0);
      }
  });

  it.each([
    ["historical western shoulder", coastalApron],
    ["broad lowland", lowlandApron],
  ] as const)(
    "represents %s in actual retained finest-leaf triangles",
    async (label, recipe) => {
      const candidate = validateWorldTerrainProfile({
        ...DataManager.getWorldTerrainProfile(),
        coastalApron: recipe,
      });
      const terrain = await fixture(candidate);
      const setup = terrain["buildGrassWorkerSetup"]();
      const provider = terrain["buildChunkTerrainProvider"]();
      const baselineProfile = validateWorldTerrainProfile({
        ...predecessor(),
        coastalApron: previousCoastalApron,
      });
      const baselineTerrain = await fixture(baselineProfile);
      const baselineSetup = baselineTerrain["buildGrassWorkerSetup"]();
      const baselineProvider = baselineTerrain["buildChunkTerrainProvider"]();
      // Use the real tree's leaf bounds/detail admission, not an assumed tile
      // origin. No resolution, root, detail-region or subdivision change.
      const tree = new TerrainQuadTree({
        minSize: terrain["CONFIG"].QUADTREE_MIN_SIZE,
        maxDepth: terrain["CONFIG"].QUADTREE_MAX_DEPTH,
        resolution: 32,
        rootChunkRadius: 0,
        fineDetailRegions: createCompactPreparationDetailRegions(
          candidate,
          ALL_WORLD_AREAS,
          terrain["CONFIG"].QUADTREE_RESOLUTION,
        ),
      });
      tree.update(368, 390.75);
      const points = [
        ...coveRouteSamples(),
        ...(label === "broad lowland"
          ? [...lowlandAreaSamples(), ...coveRouteSamples(lowlandDiagonalRoute)]
          : []),
      ];
      const bankPoints: [number, number][] = [];
      for (let x = 426; x <= 452; x += 0.5)
        for (let z = 459; z <= 540; z += 0.5) bankPoints.push([x, z]);
      if (label === "broad lowland")
        for (let x = 376; x <= 504; x++)
          for (let z = 435; z <= 541; z++) bankPoints.push([x, z]);
      const allPoints = [...points, ...bankPoints];
      const leaves = tree
        .getFinalNodes()
        .filter((node) =>
          allPoints.some(
            ([x, z]) =>
              x >= node.boundingBox.xMin &&
              x <= node.boundingBox.xMax &&
              z >= node.boundingBox.zMin &&
              z <= node.boundingBox.zMax,
          ),
        );
      const worker = actualWorker(QUAD_CHUNK_WORKER_CODE);
      const retained: {
        surface: RetainedTerrainSurface;
        geometry: THREE.BufferGeometry;
        centerX: number;
        centerZ: number;
      }[] = [];
      const baselineRetained: typeof retained = [];
      let maxHeightGap = 0,
        maxFaceGrade = 0,
        maxNormalAngle = 0,
        minHeight = Infinity,
        minTriangleCornerHeight = Infinity,
        wetTriangleCorners = 0;
      let worstHeight: number[] = [],
        worstGrade: number[] = [];
      const triangles = new Set<string>();
      const routeLeafIds = new Set<number>();
      const sample: TerrainGridSample = {
        height: 0,
        nx: 0,
        ny: 1,
        nz: 0,
        faceIndex: 0,
      };
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        c = new THREE.Vector3(),
        normal = new THREE.Vector3(),
        canonicalNormal = new THREE.Vector3(),
        barycentric = new THREE.Vector3();
      const triangle = new THREE.Triangle(a, b, c),
        point = new THREE.Vector3();
      for (const tx of [4, 5])
        for (const tz of [4, 5]) terrain["bakeWalkabilityFlags"](tx, tz);
      try {
        expect(leaves.length).toBeGreaterThan(0);
        for (const node of leaves) {
          expect(node.size).toBe(100);
          expect(node.resolution).toBe(64);
          const output = await worker.run<QuadChunkWorkerOutput>({
            type: "generateQuadChunk",
            centerX: node.centerX,
            centerZ: node.centerZ,
            size: node.size,
            resolution: node.resolution,
            config: createTerrainWorkerConfig(candidate, node.resolution),
            seed: setup.seed,
            biomeCenters: setup.biomeCenters,
            biomes: setup.biomes,
          });
          const { geometry } = assembleQuadChunkGeometry(
            output,
            provider,
            terrain["CONFIG"].QUADTREE_SKIRT_DROP,
          );
          retained.push({
            geometry,
            centerX: node.centerX,
            centerZ: node.centerZ,
            surface: new RetainedTerrainSurface(
              node.id,
              worldTerrainProfileIdentity(candidate),
              node.centerX,
              node.centerZ,
              node.size,
              node.resolution,
              geometry,
            ),
          });
          const baselineOutput = await worker.run<QuadChunkWorkerOutput>({
            type: "generateQuadChunk",
            centerX: node.centerX,
            centerZ: node.centerZ,
            size: node.size,
            resolution: node.resolution,
            config: createTerrainWorkerConfig(baselineProfile, node.resolution),
            seed: baselineSetup.seed,
            biomeCenters: baselineSetup.biomeCenters,
            biomes: baselineSetup.biomes,
          });
          const baselineGeometry = assembleQuadChunkGeometry(
            baselineOutput,
            baselineProvider,
            baselineTerrain["CONFIG"].QUADTREE_SKIRT_DROP,
          ).geometry;
          baselineRetained.push({
            geometry: baselineGeometry,
            centerX: node.centerX,
            centerZ: node.centerZ,
            surface: new RetainedTerrainSurface(
              node.id,
              worldTerrainProfileIdentity(baselineProfile),
              node.centerX,
              node.centerZ,
              node.size,
              node.resolution,
              baselineGeometry,
            ),
          });
        }
        for (const [x, z] of points) {
          let hits = 0;
          for (const entry of retained) {
            if (
              !entry.surface.sample(
                x - entry.centerX,
                z - entry.centerZ,
                sample,
              )
            )
              continue;
            routeLeafIds.add(entry.surface.nodeId);
            hits++;
            const position = entry.geometry.getAttribute("position"),
              index = entry.geometry.getIndex()!;
            const face = sample.faceIndex * 3;
            a.fromBufferAttribute(position, index.getX(face));
            b.fromBufferAttribute(position, index.getX(face + 1));
            c.fromBufferAttribute(position, index.getX(face + 2));
            point.set(x - entry.centerX, sample.height, z - entry.centerZ);
            triangle.getBarycoord(point, barycentric);
            expect(barycentric.x).toBeGreaterThanOrEqual(-1e-9);
            expect(barycentric.y).toBeGreaterThanOrEqual(-1e-9);
            expect(barycentric.z).toBeGreaterThanOrEqual(-1e-9);
            expect(
              barycentric.x * a.y + barycentric.y * b.y + barycentric.z * c.y,
            ).toBeCloseTo(sample.height, 10);
            triangle.getNormal(normal);
            expect(normal.x).toBeCloseTo(sample.nx, 10);
            expect(normal.y).toBeCloseTo(sample.ny, 10);
            expect(normal.z).toBeCloseTo(sample.nz, 10);
            const y = terrain.getResourceGroundHeight(x, z),
              gap = Math.abs(sample.height - y),
              grade = Math.hypot(sample.nx, sample.nz) / sample.ny;
            if (gap > maxHeightGap) {
              maxHeightGap = gap;
              worstHeight = [x, z, y, sample.height];
            }
            if (grade > maxFaceGrade) {
              maxFaceGrade = grade;
              worstGrade = [x, z, grade];
            }
            minHeight = Math.min(minHeight, sample.height);
            // Explicit 0.25 m centred canonical stencil; this compares face
            // orientation, not interpolated shading normals or a GPU image.
            canonicalNormal
              .set(
                -(
                  terrain.getResourceGroundHeight(x + 0.25, z) -
                  terrain.getResourceGroundHeight(x - 0.25, z)
                ) / 0.5,
                1,
                -(
                  terrain.getResourceGroundHeight(x, z + 0.25) -
                  terrain.getResourceGroundHeight(x, z - 0.25)
                ) / 0.5,
              )
              .normalize();
            maxNormalAngle = Math.max(
              maxNormalAngle,
              (normal.angleTo(canonicalNormal) * 180) / Math.PI,
            );
            const key = `${entry.surface.nodeId}:${sample.faceIndex}`;
            if (!triangles.has(key)) {
              triangles.add(key);
              for (const vertex of [a, b, c]) {
                minTriangleCornerHeight = Math.min(
                  minTriangleCornerHeight,
                  vertex.y,
                );
                if (
                  terrain.world.collision.hasFlags(
                    Math.floor(entry.centerX + vertex.x),
                    Math.floor(entry.centerZ + vertex.z),
                    CollisionFlag.WATER,
                  )
                )
                  wetTriangleCorners++;
              }
            }
          }
          expect(hits).toBeGreaterThan(0);
        }
        console.log(
          "COVE_RETAINED_ROUTE",
          JSON.stringify({
            samples: points.length,
            label,
            leaves: leaves
              .filter((n) => routeLeafIds.has(n.id))
              .map((n) => ({
                centerX: n.centerX,
                centerZ: n.centerZ,
                size: n.size,
                resolution: n.resolution,
              })),
            pitch: 100 / 63,
            triangles: triangles.size,
            minHeight,
            minTriangleCornerHeight,
            wetTriangleCorners,
            maxHeightGap,
            worstHeight,
            maxFaceGrade,
            worstGrade,
            maxNormalAngle,
            canonicalNormalStencil: 0.25,
          }),
        );
        // Five-centimetre surface agreement and the same 40% walking grade are
        // explicit representation targets; a failure is not a resolution waiver.
        expect(maxHeightGap).toBeLessThanOrEqual(0.05);
        expect(maxFaceGrade).toBeLessThanOrEqual(0.4);
        expect(maxNormalAngle).toBeLessThanOrEqual(10);
        expect(minHeight).toBeGreaterThan(16.3);
        expect(minTriangleCornerHeight).toBeGreaterThan(16.3);
        expect(wetTriangleCorners).toBe(0);
        let bankMaxError = 0,
          bankNearWaterError = 0,
          bankMaxGrade = 0,
          bankMaxNormalAngle = 0,
          bankNearWaterSamples = 0,
          baselineBankMaxError = 0,
          baselineBankNearWaterError = 0;
        const baselineSample: TerrainGridSample = {
          height: 0,
          nx: 0,
          ny: 1,
          nz: 0,
          faceIndex: 0,
        };
        let bankWorst: number[] = [];
        for (const [x, z] of bankPoints) {
          let baselineHits = 0;
          for (const entry of baselineRetained)
            if (
              entry.surface.sample(
                x - entry.centerX,
                z - entry.centerZ,
                baselineSample,
              )
            ) {
              baselineHits++;
              const y = baselineTerrain.getResourceGroundHeight(x, z),
                error = Math.abs(baselineSample.height - y);
              baselineBankMaxError = Math.max(baselineBankMaxError, error);
              if (Math.abs(y - baselineProfile.water.threshold) <= 3)
                baselineBankNearWaterError = Math.max(
                  baselineBankNearWaterError,
                  error,
                );
            }
          expect(baselineHits).toBeGreaterThan(0);
          let hits = 0;
          for (const entry of retained) {
            if (
              !entry.surface.sample(
                x - entry.centerX,
                z - entry.centerZ,
                sample,
              )
            )
              continue;
            hits++;
            expect(
              [sample.height, sample.nx, sample.ny, sample.nz].every(
                Number.isFinite,
              ),
            ).toBe(true);
            expect(sample.ny).toBeGreaterThan(0);
            const position = entry.geometry.getAttribute("position"),
              index = entry.geometry.getIndex()!,
              face = sample.faceIndex * 3;
            a.fromBufferAttribute(position, index.getX(face));
            b.fromBufferAttribute(position, index.getX(face + 1));
            c.fromBufferAttribute(position, index.getX(face + 2));
            point.set(x - entry.centerX, sample.height, z - entry.centerZ);
            triangle.getBarycoord(point, barycentric);
            expect(
              Math.min(barycentric.x, barycentric.y, barycentric.z),
            ).toBeGreaterThanOrEqual(-1e-9);
            expect(
              barycentric.x * a.y + barycentric.y * b.y + barycentric.z * c.y,
            ).toBeCloseTo(sample.height, 10);
            triangle.getNormal(normal);
            expect(normal.x).toBeCloseTo(sample.nx, 10);
            expect(normal.y).toBeCloseTo(sample.ny, 10);
            expect(normal.z).toBeCloseTo(sample.nz, 10);
            const y = terrain.getResourceGroundHeight(x, z),
              error = Math.abs(sample.height - y);
            if (error > bankMaxError) {
              bankMaxError = error;
              bankWorst = [x, z, y, sample.height];
            }
            if (Math.abs(y - candidate.water.threshold) <= 3) {
              bankNearWaterSamples++;
              bankNearWaterError = Math.max(bankNearWaterError, error);
            }
            bankMaxGrade = Math.max(
              bankMaxGrade,
              Math.hypot(sample.nx, sample.nz) / sample.ny,
            );
            canonicalNormal
              .set(
                -(
                  terrain.getResourceGroundHeight(x + 0.25, z) -
                  terrain.getResourceGroundHeight(x - 0.25, z)
                ) / 0.5,
                1,
                -(
                  terrain.getResourceGroundHeight(x, z + 0.25) -
                  terrain.getResourceGroundHeight(x, z - 0.25)
                ) / 0.5,
              )
              .normalize();
            bankMaxNormalAngle = Math.max(
              bankMaxNormalAngle,
              (normal.angleTo(canonicalNormal) * 180) / Math.PI,
            );
          }
          expect(hits).toBeGreaterThan(0);
        }
        console.log(
          "COVE_RETAINED_WESTERN_SHOULDER",
          JSON.stringify({
            samples: bankPoints.length,
            label,
            leaves: leaves.map((n) => ({
              centerX: n.centerX,
              centerZ: n.centerZ,
              size: n.size,
              resolution: n.resolution,
            })),
            bankMaxError,
            baselineBankMaxError,
            baselineBankNearWaterError,
            bankNearWaterError,
            bankNearWaterSamples,
            bankMaxGrade,
            bankMaxNormalAngle,
            bankWorst,
            wholeBankDesiredMaxError: 0.3,
            wholeBankDesiredTargetMet: bankMaxError < 0.3,
          }),
        );
        // Exact predecessor comparison qualifies only this source candidate.
        // The desired .3 m whole-bank target remains OPEN: initial measurements
        // were .632388 m before / .316533 m after (mesh-baseline01 receipt).
        // Do not relabel that as absolute-target or native-art acceptance.
        expect(bankMaxError).toBeLessThan(baselineBankMaxError);
        expect(bankNearWaterError).toBeLessThan(baselineBankNearWaterError);
        expect(bankNearWaterError).toBeLessThan(0.18);
        expect(bankNearWaterSamples).toBeGreaterThan(100);
        if (label === "broad lowland") expect(bankMaxError).toBeLessThan(0.3);
      } finally {
        for (const entry of retained) entry.geometry.dispose();
        for (const entry of baselineRetained) entry.geometry.dispose();
        tree.dispose();
        await worker.close();
      }
    },
  );

  it.each([
    ["historical western shoulder", coastalApron],
    ["broad lowland", lowlandApron],
  ] as const)(
    "carries %s through real tile, quad and grass worker transport",
    async (label, recipe) => {
      const candidate = validateWorldTerrainProfile({
        ...predecessor(),
        coastalApron: recipe,
      });
      const terrain = await fixture(candidate),
        setup = terrain["buildGrassWorkerSetup"]();
      const tile = actualWorker(TERRAIN_WORKER_CODE),
        quad = actualWorker(QUAD_CHUNK_WORKER_CODE),
        grass = actualWorker(GRASS_WORKER_CODE);
      const resolution = 64,
        config = createTerrainWorkerConfig(candidate, resolution);
      const base = {
        config,
        seed: setup.seed,
        biomeCenters: setup.biomeCenters,
        biomes: setup.biomes,
      };
      expect(Object.isFrozen(config.TERRAIN_PROFILE.coastalApron)).toBe(true);
      expect(
        Object.isFrozen(structuredClone(config).TERRAIN_PROFILE.coastalApron),
      ).toBe(false);
      let changed = 0,
        vertices = 0,
        grassCount = 0;
      const old = await fixture(predecessor());
      try {
        for (const [tileX, tileZ] of [
          [5, 4],
          [5, 5],
          [4, 5],
        ]) {
          const a = await tile.run<TerrainWorkerOutput>({
            ...base,
            type: "generateHeightmap",
            tileX,
            tileZ,
          });
          const b = await quad.run<QuadChunkWorkerOutput>({
            ...base,
            type: "generateQuadChunk",
            centerX: tileX * 100,
            centerZ: tileZ * 100,
            size: 100,
            resolution,
          });
          expect(a.terrainProfileIdentity).toBe(
            worldTerrainProfileIdentity(candidate),
          );
          expect(b.terrainProfileIdentity).toBe(a.terrainProfileIdentity);
          expect(a.heightData).toEqual(b.heightData);
          expect(a.normalData).toEqual(b.normalData);
          const step = 100 / (resolution - 1);
          const raw = (ix: number, iz: number) =>
            Math.fround(
              terrain["getHeightAtComputedSkipFlatZone"](
                tileX * 100 + (-50 + ix * step),
                tileZ * 100 + (-50 + iz * step),
              ),
            );
          for (let iz = 0; iz < resolution; iz++)
            for (let ix = 0; ix < resolution; ix++) {
              const x = tileX * 100 + (-50 + ix * step),
                z = tileZ * 100 + (-50 + iz * step),
                index = iz * resolution + ix;
              expect(a.heightData[index]).toBe(raw(ix, iz));
              vertices++;
              if (
                Math.abs(
                  a.heightData[index] -
                    old["getHeightAtComputedSkipFlatZone"](x, z),
                ) > 0.1
              )
                changed++;
              const normal = new THREE.Vector3(
                -(raw(ix + 1, iz) - raw(ix - 1, iz)) / (2 * step),
                1,
                -(raw(ix, iz + 1) - raw(ix, iz - 1)) / (2 * step),
              ).normalize();
              for (let axis = 0; axis < 3; axis++)
                expect(a.normalData[index * 3 + axis]).toBeCloseTo(
                  normal.getComponent(axis),
                  6,
                );
            }
        }
        const input: GrassWorkerInput = {
          ...base,
          type: "generateGrassInstances",
          chunkKey: "coastal-apron-east",
          centerX: 460,
          centerZ: 467,
          size: 25,
          spacingMul: 1,
          grassSeed: 37,
          clumpSpacing: GRASS_CONFIG.CLUMP_SPACING,
          scaleMin: GRASS_CONFIG.SCALE_MIN,
          scaleMax: GRASS_CONFIG.SCALE_MAX,
          waterThreshold: candidate.water.threshold,
          grassConfigs: setup.grassConfigs,
          shaderConstants: TERRAIN_SHADER_CONSTANTS,
          roadSegments: setup.getRoadSegmentsForRegion(
            447.5,
            454.5,
            472.5,
            479.5,
          ),
          roadBlendWidth: 0.5,
          tileSize: 100,
          grassEligibility: "compact-pbr-v1",
          terrainSurface: setup.getTerrainSurfaceForRegion(447, 454, 473, 480),
        };
        const g = await grass.run<GrassWorkerOutput>(input);
        grassCount = g.count;
        expect(g.terrainProfileIdentity).toBe(
          worldTerrainProfileIdentity(candidate),
        );
        expect(g.count).toBeGreaterThan(0);
        for (let i = 0; i < g.count; i++) {
          const x = input.centerX + g.offsets[i * 3],
            z = input.centerZ + g.offsets[i * 3 + 2];
          expect(g.offsets[i * 3 + 1]).toBeCloseTo(
            terrain.getResourceGroundHeight(x, z),
            4,
          );
          expect(g.offsets[i * 3 + 1]).toBeGreaterThanOrEqual(
            candidate.water.threshold,
          );
        }
        const invalids = [
          { ...candidate, coastalApron: { ...recipe, lowland: undefined } },
          {
            ...candidate,
            coastalApron: {
              ...recipe,
              lowland: { ...lowlandApron.lowland, westMinX: 360 },
            },
          },
          { ...candidate, coastalApron: { ...coastalApron, halo: 0.5 } },
          { ...candidate, coastalApron: { ...coastalApron, minZ: 431 } },
          { ...candidate, height: { ...candidate.height, baseOffset: 29 } },
          {
            ...candidate,
            coastalApron: {
              ...coastalApron,
              westernShoulder: {
                ...coastalApron.westernShoulder,
                maxWidth: 100,
              },
            },
          },
          {
            ...candidate,
            coastalApron: { ...coastalApron, westernShoulder: undefined },
          },
        ];
        for (const p of invalids) {
          const bad = {
            ...base,
            type: "generateQuadChunk",
            centerX: 450,
            centerZ: 450,
            size: 100,
            resolution,
            config: {
              ...config,
              TERRAIN_PROFILE: p,
              TERRAIN_PROFILE_IDENTITY: `hyperia-world-terrain-profile-v1\n${JSON.stringify(p)}`,
            },
          };
          await expect(quad.run(bad)).rejects.toThrow();
        }
        console.log(
          "COVE_WORKERS",
          JSON.stringify({ label, vertices, changed, grassCount }),
        );
        expect(changed).toBeGreaterThan(100);
      } finally {
        await Promise.all([tile.close(), quad.close(), grass.close()]);
      }
    },
  );

  it.each([
    ["historical western shoulder", coastalApron],
    ["broad lowland", lowlandApron],
  ] as const)(
    "retains %s factory emission after minification without external helpers",
    async (_label, recipe) => {
      const candidate = validateWorldTerrainProfile({
        ...predecessor(),
        coastalApron: recipe,
      });
      const compiled = await build({
        entryPoints: [
          fileURLToPath(
            new URL("../CompactIslandLandform.ts", import.meta.url),
          ),
        ],
        bundle: true,
        write: false,
        platform: "neutral",
        format: "iife",
        globalName: "CoveBundle",
        keepNames: true,
        minify: true,
      });
      const source = runInNewContext(
        `${compiled.outputFiles[0].text}\nCoveBundle.buildCompactIslandLandformJS()`,
      ) as string;
      // The actual worker guard is exercised above. This separate test exercises
      // bundled factory closure in its own realm with immutable admitted JSON.
      const embedded = runInNewContext(
        `const profile=${JSON.stringify(candidate)};function freeze(value){if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}freeze(profile);const landform=${source};({height:(x,z,noise)=>landform.height(x,z,noise,profile),mask:(x,z,noise)=>landform.mask(x,z,noise,profile)});`,
      ) as {
        height(x: number, z: number, noise: NoiseGenerator): number;
        mask(x: number, z: number, noise: NoiseGenerator): number;
      };
      const form = createCompactIslandLandform(),
        noise = new NoiseGenerator(candidate.seed);
      for (let x = 440; x <= 505; x += 2.5)
        for (let z = 430; z <= 545; z += 2.5) {
          expect(embedded.height(x, z, noise)).toBe(
            form.height(x, z, noise, candidate),
          );
          expect(embedded.mask(x, z, noise)).toBe(
            form.mask(x, z, noise, candidate),
          );
        }
    },
  );
});
