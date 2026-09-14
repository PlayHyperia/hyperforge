import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { World } from "../../../../core/World";
import THREE from "../../../../extras/three/three";
import { EventType } from "../../../../types/events";
import type { TerrainTile } from "../../../../types/world/terrain";
import type { RoadTileSegment } from "../../../../types/world/world-types";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  GRASS_WORKER_CODE,
  prepareGrassWorkerRequest,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainSystem } from "../TerrainSystem";
import { TERRAIN_SHADER_CONSTANTS } from "../TerrainShader";
import { TerrainQuadNode } from "../TerrainQuadTree";
import { TerrainVisualManager } from "../TerrainVisualManager";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import type { GrassWorkerSetup } from "../GrassVisualManager";

type TerrainInternals = {
  terrainTiles: Map<string, TerrainTile>;
  quadTreeVisualManager: TerrainVisualManager | null;
  runtimeIsServer: boolean;
  terrainContainer: THREE.Group;
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  subscribeRoadNetworkEvents(): void;
  generateTile(x: number, z: number, content: boolean): TerrainTile;
  unloadTile(tile: TerrainTile): void;
  refreshRoadInfluence(): Promise<void>;
  buildChunkTerrainProvider(): FullTerrainProvider;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  calculateRoadInfluenceAtVertex(
    x: number,
    z: number,
    tileX: number,
    tileZ: number,
  ): number;
  computeRoadInfluenceBatchCPU(
    vertices: Float32Array,
    tileX: number,
    tileZ: number,
    segments: RoadTileSegment[],
  ): Float32Array;
};
type ManagerInternals = {
  addMeshToScene(
    node: TerrainQuadNode,
    key: string,
    result: { geometry: THREE.BufferGeometry; heightData: Float32Array },
  ): void;
};
type Kind = "tiles" | "chunks";
const ownedWorlds = new Set<World>();
afterEach(() => {
  for (const world of ownedWorlds) world.destroy();
  ownedWorlds.clear();
});

/** Actual engine systems and generated terrain, with no renderer or timer mocks. */
async function fixture(kind: Kind) {
  const world = new World();
  ownedWorlds.add(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const internal = terrain as unknown as TerrainInternals;
  await terrain.init();
  internal.loadWaterBodiesFromManifest();
  internal.loadFlatZonesFromManifest();
  await roads.init();
  await roads.start();
  expect(roads.getRoadInfluenceAt(348, 321)).toBe(1);
  internal.subscribeRoadNetworkEvents();

  const tiles: TerrainTile[] = [];
  const meshes: THREE.Mesh[] = [];
  let manager: TerrainVisualManager | null = null;
  const container = new THREE.Group();
  internal.terrainContainer = container;
  const material = new THREE.MeshStandardNodeMaterial();
  const nodes: TerrainQuadNode[] = [];
  const provider = internal.buildChunkTerrainProvider();
  const profile = terrain.getWorldTerrainProfile();
  const resolution = 16;
  const size = profile.terrainTileSize;
  const pending: Promise<void>[] = [];
  const detachedGeometry: THREE.BufferGeometry[] = [];

  function addChunk(node: TerrainQuadNode, key: string): THREE.Mesh {
    const result = assembleQuadChunkGeometry(
      generateQuadChunkDataSync(
        node.centerX,
        node.centerZ,
        size,
        resolution,
        provider,
      ),
      provider,
      manager!.getQuadTree().config.skirtDrop,
    );
    (manager! as unknown as ManagerInternals).addMeshToScene(node, key, result);
    return manager!.getChunks().get(key)!.mesh;
  }
  if (kind === "tiles") {
    // Exercise the actual client-attribute geometry branch in this CPU test.
    // Keep runtimeIsClient false: no renderer, client systems or network are faked.
    internal.runtimeIsServer = false;
    // Four real tiles precede the on-road fifth tile. The production batch
    // boundary must yield even when those first four have no road segments.
    for (const [x, z] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 3],
    ]) {
      const tile = internal.generateTile(x, z, false);
      tiles.push(tile);
      meshes.push(tile.mesh);
      container.add(tile.mesh);
    }
  } else {
    const setup = internal.buildGrassWorkerSetup();
    manager = new TerrainVisualManager(
      { minSize: size, maxDepth: 1, resolution, rootChunkRadius: 0 },
      provider,
      container,
      material,
      createTerrainWorkerConfig(profile, resolution),
      profile.seed,
      setup.biomeCenters,
      setup.biomes,
    );
    internal.quadTreeVisualManager = manager;
    for (let i = 0; i < 5; i++) {
      const node = new TerrainQuadNode(
        manager.getQuadTree(),
        null,
        null,
        size,
        150 + i * size,
        350,
        manager.getQuadTree().config.maxDepth,
        9200 + i,
      );
      nodes.push(node);
      meshes.push(addChunk(node, `road-lifecycle-${i}`));
    }
    expect(internal.terrainTiles.size).toBe(0);
  }
  for (const mesh of meshes) {
    const attribute = mesh.geometry.getAttribute("roadInfluence");
    expect(attribute).toBeInstanceOf(THREE.BufferAttribute);
    (attribute.array as Float32Array).fill(-1);
  }
  const last = meshes[4];
  const lastGeometry = last.geometry;
  const attribute = lastGeometry.getAttribute(
    "roadInfluence",
  ) as THREE.BufferAttribute;
  const version = attribute.version;
  let disposals = 0;
  lastGeometry.addEventListener("dispose", () => {
    disposals++;
  });
  const begin = () => {
    const refresh = internal.refreshRoadInfluence();
    pending.push(refresh);
    // Async entry executes the first four entries synchronously, then suspends
    // on its real setTimeout. The fifth geometry cannot have been touched yet.
    expect(attribute.version).toBe(version);
    expect(Array.from(attribute.array).every((value) => value === -1)).toBe(
      true,
    );
    return refresh;
  };
  return {
    world,
    terrain,
    roads,
    internal,
    manager,
    meshes,
    attribute,
    version,
    begin,
    disposals: () => disposals,
    replaceEntry() {
      if (kind === "tiles") {
        internal.unloadTile(tiles[4]);
        const replacement = internal.generateTile(3, 3, false).mesh;
        container.add(replacement);
        return replacement;
      }
      const oldNode = nodes[4];
      const key = oldNode.visualChunkKey!;
      manager!.onNodeDestroyGeometry(oldNode);
      const node = new TerrainQuadNode(
        manager!.getQuadTree(),
        null,
        null,
        size,
        oldNode.centerX,
        oldNode.centerZ,
        oldNode.depth,
        oldNode.id + 100,
      );
      return addChunk(node, key);
    },
    replaceGeometry() {
      last.geometry = lastGeometry.clone();
      lastGeometry.dispose();
      return last;
    },
    detach() {
      last.removeFromParent();
      detachedGeometry.push(lastGeometry);
    },
    async close() {
      terrain.destroy();
      await Promise.all(pending);
      world.destroy();
      ownedWorlds.delete(world);
      for (const geometry of detachedGeometry) geometry.dispose();
      material.dispose();
    },
  };
}

describe("real yielding terrain road refresh ownership", () => {
  it("rejects malformed shoulder overrides at host admission and in the actual emitted worker without reading host getters", async () => {
    const f = await fixture("chunks");
    const setup = f.internal.buildGrassWorkerSetup();
    const road = { startX: 0, startZ: 0, endX: 1, endZ: 0, width: 1 };
    const input: GrassWorkerInput = {
      type: "generateGrassInstances",
      chunkKey: "road-profile-admission",
      centerX: 350,
      centerZ: 350,
      size: 100,
      spacingMul: 1,
      config: setup.terrainConfig,
      seed: setup.seed,
      biomeCenters: setup.biomeCenters,
      biomes: setup.biomes,
      grassSeed: 1,
      clumpSpacing: 25,
      scaleMin: 0.5,
      scaleMax: 1,
      waterThreshold: f.terrain.getWorldTerrainProfile().water.threshold,
      grassConfigs: setup.grassConfigs,
      shaderConstants: TERRAIN_SHADER_CONSTANTS,
      grassEligibility: "compact-pbr-v1",
      roadSegments: [road],
      roadBlendWidth: 0.5,
      tileSize: setup.tileSize,
      terrainSurface: setup.getTerrainSurfaceForRegion(300, 300, 400, 400),
    };
    const worker = new Worker(
      `const { parentPort } = require("node:worker_threads");
      globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
      ${GRASS_WORKER_CODE}
      parentPort.on("message", input => self.onmessage({data: input}));`,
      { eval: true, env: {} },
    );
    const run = (request: GrassWorkerInput) =>
      new Promise<{ error?: string; result?: GrassWorkerOutput }>(
        (resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            worker.off("error", fail);
            worker.off("message", receive);
          };
          const fail = (error: Error) => {
            cleanup();
            reject(error);
          };
          const receive = (response: {
            error?: string;
            result?: GrassWorkerOutput;
          }) => {
            cleanup();
            resolve(response);
          };
          const timer = setTimeout(
            () => fail(new Error("Actual grass admission worker deadline")),
            10000,
          );
          worker.once("error", fail);
          worker.once("message", receive);
          worker.postMessage(request);
        },
      );
    try {
      const prepared = prepareGrassWorkerRequest(input);
      expect(prepared.roadSegments).toBe(input.roadSegments);
      expect(Object.hasOwn(prepared.roadSegments[0], "blendWidth")).toBe(false);
      expect(Object.hasOwn(prepared.roadSegments[0], "maxInfluence")).toBe(
        false,
      );
      const ordinaryResult = await run(prepared);
      expect(ordinaryResult.error).toBeUndefined();
      expect(ordinaryResult.result).toBeDefined();
      const explicitResult = await run({
        ...prepared,
        roadSegments: [{ ...road, blendWidth: 0.5, maxInfluence: 1 }],
      });
      expect(explicitResult).toEqual(ordinaryResult);
      for (const profile of [
        { blendWidth: 0, maxInfluence: 0 },
        { blendWidth: 1024, maxInfluence: 1 },
        { blendWidth: 1.5, maxInfluence: 0.55 },
      ]) {
        const valid = { ...input, roadSegments: [{ ...road, ...profile }] };
        expect(() => prepareGrassWorkerRequest(valid)).not.toThrow();
        const response = await run(valid);
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
      }
      for (const key of ["blendWidth", "maxInfluence"] as const) {
        for (const value of [
          NaN,
          Infinity,
          -Infinity,
          -0.01,
          key === "blendWidth" ? 1024.01 : 1.01,
          undefined,
          null,
          "0.5",
        ]) {
          const invalid = { ...road };
          Object.defineProperty(invalid, key, { value, enumerable: true });
          const request = { ...input, roadSegments: [invalid] };
          expect(() => prepareGrassWorkerRequest(request)).toThrow(
            "Invalid grass worker road influence profile",
          );
          // These own data fields survive native structured-clone transport;
          // invoke the production message handler, not only its sampler helper.
          const response = await run(request);
          expect(response.error).toBe(
            "Invalid grass worker road influence profile",
          );
          expect(response.result).toBeUndefined();
        }
        let getterReads = 0;
        const accessor = { ...road };
        Object.defineProperty(accessor, key, {
          enumerable: true,
          get() {
            getterReads++;
            return 0.5;
          },
        });
        const inherited = { ...road };
        Object.setPrototypeOf(inherited, accessor);
        for (const invalid of [accessor, inherited])
          expect(() =>
            prepareGrassWorkerRequest({ ...input, roadSegments: [invalid] }),
          ).toThrow("Invalid grass worker road influence profile");
        expect(getterReads).toBe(0);
      }
    } finally {
      await worker.terminate();
      await f.close();
    }
  });

  it.each<Kind>(["tiles", "chunks"])(
    "retains fractional shoulders through actual region, cached point, batch, worker and refreshed %s attributes (CPU, not browser proof)",
    async (kind) => {
      const f = await fixture(kind);
      const worker = new Worker(
        `const { parentPort } = require("node:worker_threads");
        globalThis.self = { postMessage: message => parentPort.postMessage(message) };
        ${GRASS_WORKER_CODE}
        parentPort.on("message", rows => parentPort.postMessage(rows.map(row => calculateRoadInfluence(row.x, row.z, row.segments, row.defaultBlend))));`,
        { eval: true, env: {} },
      );
      try {
        // Configure the real RoadNetworkSystem, including shoulders whose
        // centerlines stop before positive/negative road-tile boundaries.
        const stored = f.roads.getRoads();
        const ordinary = { ...stored[0] };
        delete ordinary.blendWidth;
        delete ordinary.maxInfluence;
        stored.splice(
          0,
          stored.length,
          ...[300, -100].flatMap((boundary) => [
            {
              ...ordinary,
              id: `transport-shoulder-${boundary}`,
              width: 1,
              blendWidth: 2,
              maxInfluence: 0.55,
              path: [
                { x: boundary - 6, z: boundary - 0.25, y: 28 },
                { x: boundary - 0.25, z: boundary - 0.25, y: 28 },
              ],
              length: 5.75,
            },
            {
              ...ordinary,
              id: `transport-ordinary-${boundary}`,
              width: 1,
              path: [
                { x: boundary - 6, z: boundary - 10, y: 28 },
                { x: boundary - 0.25, z: boundary - 10, y: 28 },
              ],
              length: 5.75,
            },
          ]),
        );
        (f.roads as unknown as { buildTileCache(): void }).buildTileCache();
        // Existing event invalidation must clear the cached pre-edit segments.
        f.world.emit(EventType.ROADS_GENERATED, {
          roadCount: stored.length,
          townCount: 0,
          poiCount: 0,
          explorationRoadCount: 0,
        });
        const setup = f.internal.buildGrassWorkerSetup();
        const queries: Array<{
          x: number;
          z: number;
          segments: GrassWorkerInput["roadSegments"];
          defaultBlend: number;
        }> = [];
        const expected: number[] = [];
        for (const boundary of [300, -100]) {
          const points = [
            { x: boundary - 3.125, z: boundary - 0.25, value: 0.55 },
            { x: boundary - 3.125, z: boundary + 1.25, value: 0.275 },
            { x: boundary + 0.5, z: boundary + 0.5 },
            { x: boundary - 3.125, z: boundary + 2.25, value: 0 },
            { x: boundary - 3.125, z: boundary - 10, value: 1 },
            { x: boundary - 3.125, z: boundary - 9.25, value: 0.5 },
          ];
          for (const point of points) {
            const { x, z } = point;
            const tx = Math.floor(x / 100),
              tz = Math.floor(z / 100);
            const value = f.roads.getRoadInfluenceAt(x, z);
            if (point.value !== undefined)
              expect(value).toBeCloseTo(point.value, 12);
            else {
              expect(value).toBeGreaterThan(0);
              expect(value).toBeLessThan(0.55);
            }
            const tileSegments = f.roads.getRoadSegmentsForTile(tx, tz);
            const region = setup.getRoadSegmentsForRegion(x, z, x, z);
            const shoulder = region.filter((s) => s.maxInfluence === 0.55);
            expect(shoulder.length).toBeGreaterThan(0);
            expect(shoulder.every((s) => s.blendWidth === 2)).toBe(true);
            for (const segment of region.filter(
              (s) => s.maxInfluence === undefined,
            )) {
              expect(Object.hasOwn(segment, "blendWidth")).toBe(false);
              expect(Object.hasOwn(segment, "maxInfluence")).toBe(false);
            }
            // Repeat in the same road tile to exercise the cached lookup too.
            for (let repeat = 0; repeat < 2; repeat++)
              expect(
                f.internal.calculateRoadInfluenceAtVertex(x, z, tx, tz),
              ).toBeCloseTo(value, 12);
            const vertices = new Float32Array([x - tx * 100, z - tz * 100]);
            const batch = f.internal.computeRoadInfluenceBatchCPU(
              vertices,
              tx,
              tz,
              tileSegments,
            );
            expect(batch[0]).toBe(
              Math.fround(
                f.roads.getRoadInfluenceAt(
                  vertices[0] + tx * 100,
                  vertices[1] + tz * 100,
                ),
              ),
            );
            const lease = setup.prepareGroundingInputs!({
              minX: x,
              maxX: x,
              minZ: z,
              maxZ: z,
            });
            let step = lease.steps.next();
            while (!step.done) step = lease.steps.next();
            expect(lease.isCurrent()).toBe(true);
            expect(step.value.roadSegments).toEqual(region);
            queries.push({ x, z, segments: region, defaultBlend: 0.5 });
            expected.push(value);
          }
        }
        // A non-default request fallback still applies only to omitted fields;
        // authored shoulders must retain their own blend, including in worker JS.
        const legacy = {
          startX: -6,
          startZ: 0,
          endX: -0.25,
          endZ: 0,
          width: 1,
        };
        queries.push(
          { x: -3, z: 1.5, segments: [legacy], defaultBlend: 2 },
          {
            x: -3,
            z: 1.5,
            segments: [{ ...legacy, blendWidth: 2, maxInfluence: 0.55 }],
            defaultBlend: 0.125,
          },
          {
            x: -3,
            z: 0,
            segments: [{ ...legacy, blendWidth: 2, maxInfluence: 0 }],
            defaultBlend: 0.5,
          },
        );
        expected.push(0.5, 0.275, 0);
        const workerValues = await new Promise<number[]>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Actual grass sampler worker deadline")),
            10000,
          );
          worker.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          worker.once("message", (values: number[]) => {
            clearTimeout(timer);
            resolve(values);
          });
          worker.postMessage(queries);
        });
        expect(workerValues).toEqual(expected);

        // Compare complete real geometry attributes, not a replacement builder.
        // Starting empty also gives untouched no-road tiles their correct value.
        for (const mesh of f.meshes)
          (
            mesh.geometry.getAttribute("roadInfluence").array as Float32Array
          ).fill(0);
        await f.internal.refreshRoadInfluence();
        let fractional = 0;
        for (const mesh of f.meshes) {
          const positions = mesh.geometry.getAttribute("position");
          const influence = mesh.geometry.getAttribute("roadInfluence");
          for (let i = 0; i < positions.count; i++) {
            const value = influence.getX(i);
            expect(value).toBe(
              Math.fround(
                f.roads.getRoadInfluenceAt(
                  positions.getX(i) + mesh.position.x,
                  positions.getZ(i) + mesh.position.z,
                ),
              ),
            );
            if (value > 0 && value < 1) fractional++;
          }
        }
        expect(fractional).toBeGreaterThan(0);
      } finally {
        await worker.terminate();
        await f.close();
      }
    },
  );

  it.each<Kind>(["tiles", "chunks"])(
    "stops a suspended %s refresh after destroy and rejects new refresh entry",
    async (kind) => {
      const f = await fixture(kind);
      try {
        const older = f.begin();
        f.terrain.destroy();
        expect(f.disposals()).toBeGreaterThan(0);
        await older;
        await f.internal.refreshRoadInfluence();
        expect(f.attribute.version).toBe(f.version);
        expect(
          Array.from(f.attribute.array).every((value) => value === -1),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it.each<Kind>(["tiles", "chunks"])(
    "lets only the latest yielding %s refresh reach the fifth geometry",
    async (kind) => {
      const f = await fixture(kind);
      try {
        const older = f.begin();
        const newer = f.begin();
        await Promise.all([older, newer]);
        expect(f.attribute.version).toBe(f.version + 1);
        expect(
          Array.from(f.attribute.array).every(
            (value) => value >= 0 && value <= 1,
          ),
        ).toBe(true);
        if (kind === "tiles")
          expect(Math.max(...f.attribute.array)).toBeGreaterThan(0);
      } finally {
        await f.close();
      }
    },
  );

  for (const operation of ["replaceEntry", "replaceGeometry"] as const) {
    it.each<Kind>(["tiles", "chunks"])(
      `skips replaced snapshot ownership (${operation}, %s) without writing either old or new geometry`,
      async (kind) => {
        const f = await fixture(kind);
        try {
          const older = f.begin();
          const replacement = f[operation]();
          const replacementAttribute = replacement.geometry.getAttribute(
            "roadInfluence",
          ) as THREE.BufferAttribute;
          const replacementVersion = replacementAttribute.version;
          const replacementValues = Array.from(replacementAttribute.array);
          await older;
          expect(f.disposals()).toBeGreaterThan(0);
          expect(f.attribute.version).toBe(f.version);
          expect(
            Array.from(f.attribute.array).every((value) => value === -1),
          ).toBe(true);
          expect(replacementAttribute.version).toBe(replacementVersion);
          expect(Array.from(replacementAttribute.array)).toEqual(
            replacementValues,
          );
        } finally {
          await f.close();
        }
      },
    );
  }

  it.each<Kind>(["tiles", "chunks"])(
    "does not mutate detached %s geometry still present in its owning map",
    async (kind) => {
      const f = await fixture(kind);
      try {
        const older = f.begin();
        f.detach();
        await older;
        expect(f.attribute.version).toBe(f.version);
        expect(
          Array.from(f.attribute.array).every((value) => value === -1),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it("refreshes five actual quad meshes on ROADS_GENERATED without legacy terrain tiles", async () => {
    const f = await fixture("chunks");
    try {
      f.world.emit(EventType.ROADS_GENERATED, {
        roadCount: (f.world.getSystem("roads") as RoadNetworkSystem).getRoads()
          .length,
        townCount: 0,
        poiCount: 0,
        explorationRoadCount: 0,
      });
      const first = f.meshes[0].geometry.getAttribute(
        "roadInfluence",
      ) as THREE.BufferAttribute;
      expect(first.version).toBeGreaterThan(0);
      expect(f.attribute.version).toBe(f.version);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.attribute.version).toBe(f.version + 1);
      expect(
        Array.from(f.attribute.array).every(
          (value) => value >= 0 && value <= 1,
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});
