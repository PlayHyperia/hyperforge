import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import * as arenaGrading from "../../../../data/arena-grading";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import { inferLOD1Path, inferLOD2Path } from "../LODConfig";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { TerrainQuadTree } from "../TerrainQuadTree";
import {
  GrassVisualManager,
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
} from "../GrassVisualManager";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import {
  createCompactIslandPaths,
  compactPathSegmentDistance,
} from "../CompactIslandPaths";

const CAPSULES = [
  ["bank-apron", 346, 320, 350, 320.5, 4],
  ["bank-clerk-approach", 350, 320.5, 354, 324, 3],
  ["bank-shopkeeper-approach", 346, 320, 344, 323, 2.5],
  ["workshop-apron", 334.75, 334.75, 339, 334.25, 3.5],
  ["workshop-supplier-approach", 336.5, 333, 337.5, 331.5, 2.5],
] as const;
class CpuServerWorld extends World {
  override get isServer() {
    return true;
  }
}
async function fixture() {
  const world = new CpuServerWorld();
  const manager = world.register(
    "entity-manager",
    EntityManager,
  ) as EntityManager;
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const resources = world.register(
    "resource",
    ResourceSystem,
  ) as ResourceSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  await roads.init();
  await roads.start();
  return { world, terrain, roads, manager, resources };
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function segments(roads: ReturnType<RoadNetworkSystem["getRoads"]>) {
  return roads.flatMap((road) =>
    road.path.slice(1).map((end, i) => ({
      startX: road.path[i].x,
      startZ: road.path[i].z,
      endX: end.x,
      endZ: end.z,
      width: road.width,
    })),
  );
}

// Declared POSITION bounds, including actual glTF node transforms, not alpha
// silhouettes or native rendered/wind bounds. A radial envelope covers any yaw.
function modelRadius(asset: string): number {
  expect(asset).toMatch(
    /^asset:\/\/models\/trees\/(?:[a-z0-9_]+\/)?[a-z0-9_]+\.glb$/,
  );
  const path = fileURLToPath(
    new URL(
      `../../../../../../server/world/assets/${asset.slice(8)}`,
      import.meta.url,
    ),
  );
  const fd = openSync(path, "r");
  let doc: {
    scene?: number;
    scenes: { nodes: number[] }[];
    nodes: {
      mesh?: number;
      children?: number[];
      matrix?: number[];
      translation?: number[];
      rotation?: number[];
      scale?: number[];
    }[];
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: { min: number[]; max: number[] }[];
  };
  try {
    const header = Buffer.alloc(20);
    expect(readSync(fd, header, 0, 20, 0)).toBe(20);
    expect(header.readUInt32LE(0)).toBe(0x46546c67);
    expect(header.readUInt32LE(16)).toBe(0x4e4f534a);
    const size = header.readUInt32LE(12);
    expect(size).toBeLessThan(2 * 1024 * 1024);
    const bytes = Buffer.alloc(size);
    expect(readSync(fd, bytes, 0, size, 20)).toBe(size);
    doc = JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
  const bounds = new THREE.Box3();
  function visit(index: number, parent: THREE.Matrix4) {
    const node = doc.nodes[index];
    const local = node.matrix
      ? new THREE.Matrix4().fromArray(node.matrix)
      : new THREE.Matrix4().compose(
          new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
          new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
          new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]),
        );
    const transform = parent.clone().multiply(local);
    if (node.mesh !== undefined)
      for (const primitive of doc.meshes[node.mesh].primitives) {
        const position = doc.accessors[primitive.attributes.POSITION];
        bounds.union(
          new THREE.Box3(
            new THREE.Vector3().fromArray(position.min),
            new THREE.Vector3().fromArray(position.max),
          ).applyMatrix4(transform),
        );
      }
    for (const child of node.children ?? []) visit(child, transform);
  }
  for (const node of doc.scenes[doc.scene ?? 0].nodes)
    visit(node, new THREE.Matrix4());
  expect(bounds.isEmpty()).toBe(false);
  return Math.hypot(
    Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
    Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)),
  );
}

describe("five surface-only service clearings, actual CPU owners (not native visual proof)", () => {
  it("retains the original six path values and exact authored capsule endpoints/widths", async () => {
    const f = await fixture();
    try {
      const paths = createCompactIslandPaths(
        DataManager.getWorldTerrainProfile(),
        DataManager.getInstance().getAllWorldAreas(),
        getDuelArenaConfig(),
        f.terrain.getHeightAt.bind(f.terrain),
      );
      // Independently executed immutable probe55 factory against this actual
      // admitted terrain before retaining this digest (all values deep-equal).
      // Archived source SHA256:e3ec507c8d053d52e43878dd1e03146db68e07dd2c7f66d4a1a7670401927670.
      // No archived workspace path, dynamic compilation or Git needed by this test.
      expect(digest(paths.slice(0, 6))).toBe(
        "5586fa7d23825c111fa469282ffbbfcb45934c8375cf17de655ff33d955fb6d4",
      );
      expect(
        paths
          .slice(6)
          .map((path) => [
            path.id.slice("compact-clearing-".length),
            path.path[0].x,
            path.path[0].z,
            path.path.at(-1)!.x,
            path.path.at(-1)!.z,
            path.width,
          ]),
      ).toEqual(CAPSULES);
      process.stdout.write(
        "Clearing segments/points/length " +
          JSON.stringify(
            paths
              .slice(6)
              .map((p) => [p.id, p.path.length - 1, p.path.length, p.length]),
          ) +
          "\n",
      );
    } finally {
      f.world.destroy();
    }
  });

  it("rejects missing, duplicate, nonfinite or unsafe admitted service anchors without mutating their manifest", async () => {
    const f = await fixture();
    try {
      const original = DataManager.getInstance().getAllWorldAreas();
      const before = JSON.stringify(original);
      for (const mode of [
        "missing",
        "duplicate",
        "infinite",
        "nan",
        "water",
        "floor",
      ] as const) {
        const areas = structuredClone(original);
        const npcs = areas.central_haven.npcs!;
        const clerk = npcs.find((n) => n.id === "bank_clerk")!;
        if (mode === "missing") npcs.splice(npcs.indexOf(clerk), 1);
        if (mode === "duplicate") npcs.push(structuredClone(clerk));
        if (mode === "infinite") clerk.position.x = Infinity;
        if (mode === "nan") clerk.position.z = NaN;
        if (mode === "water") Object.assign(clerk.position, { x: 345, z: 302 });
        if (mode === "floor") Object.assign(clerk.position, { x: 387, z: 376 });
        expect(
          () =>
            createCompactIslandPaths(
              DataManager.getWorldTerrainProfile(),
              areas,
              getDuelArenaConfig(),
              f.terrain.getHeightAt.bind(f.terrain),
            ),
          mode,
        ).toThrow();
      }
      expect(JSON.stringify(original)).toBe(before);
    } finally {
      f.world.destroy();
    }
  });

  it("keeps the complete padded footprints dry and clears the pond bank, floors, lodge and all 29 actual resource models", async () => {
    const f = await fixture();
    try {
      await f.resources.init();
      await f.terrain.start();
      await Promise.all([...f.resources["terrainResourceTails"].values()]);
      await f.resources["initializeWorldAreaResources"]();
      const trees = f.resources
        .getAllResources()
        .filter((r) => r.type === "tree");
      expect(trees).toHaveLength(29);
      const areas = DataManager.getInstance().getAllWorldAreas();
      const floors = arenaGrading.createDuelArenaFloorZones(
        getDuelArenaConfig(),
        arenaGrading.getDuelArenaGradeHeight(areas),
      );
      const radii = new Map<string, number>();
      const actualTrees = trees.map((tree) => {
        const e = f.manager.getEntity(tree.id);
        expect(e).toBeInstanceOf(ResourceEntity);
        if (!(e instanceof ResourceEntity))
          throw new Error("Actual tree missing");
        const variants = e.config.modelVariants ?? [e.config.model!];
        const asset = variants[e["hashString"](e.id) % variants.length];
        if (!radii.has(asset))
          radii.set(
            asset,
            Math.max(
              ...[asset, inferLOD1Path(asset), inferLOD2Path(asset)].map(
                modelRadius,
              ),
            ),
          );
        return {
          id: e.id,
          x: e.position.x,
          z: e.position.z,
          radius: radii.get(asset)! * (e.config.modelScale ?? 1),
        };
      });
      let samples = 0,
        minDryMargin = Infinity,
        maxSlope = 0,
        minTreeMargin = Infinity;
      for (const [, ax, az, bx, bz, width] of CAPSULES) {
        const a = { x: ax, z: az },
          b = { x: bx, z: bz },
          radius = width / 2 + 0.5;
        for (const tree of actualTrees) {
          const margin =
            compactPathSegmentDistance(tree, a, b) - radius - tree.radius;
          expect(margin, tree.id).toBeGreaterThan(0.5);
          minTreeMargin = Math.min(minTreeMargin, margin);
        }
        expect(
          compactPathSegmentDistance({ x: 343, z: 302 }, a, b) - radius,
        ).toBeGreaterThan(11);
        // Entire analytical capsule at 0.125m spacing, plus an expanded AABB.
        // The AABB is conservative (also covers rounded-cap corners outside paint).
        for (
          let x = Math.min(ax, bx) - radius;
          x <= Math.max(ax, bx) + radius + 1e-8;
          x += 0.125
        )
          for (
            let z = Math.min(az, bz) - radius;
            z <= Math.max(az, bz) + radius + 1e-8;
            z += 0.125
          ) {
            const y = f.terrain.getResourceGroundHeight(x, z);
            expect(Number.isFinite(y)).toBe(true);
            const water = f.terrain
              .getWaterBodyRegistry()
              .getWaterSurfaceAt(x, z);
            expect(y).toBeGreaterThan(water + 0.1);
            minDryMargin = Math.min(minDryMargin, y - water);
            const dx =
              (f.terrain.getResourceGroundHeight(x + 0.1, z) -
                f.terrain.getResourceGroundHeight(x - 0.1, z)) /
              0.2;
            const dz =
              (f.terrain.getResourceGroundHeight(x, z + 0.1) -
                f.terrain.getResourceGroundHeight(x, z - 0.1)) /
              0.2;
            maxSlope = Math.max(maxSlope, Math.hypot(dx, dz));
            for (const floor of floors)
              expect(
                Math.abs(x - floor.centerX) <= floor.width / 2 &&
                  Math.abs(z - floor.centerZ) <= floor.depth / 2,
              ).toBe(false);
            expect(
              x >= 393.502 && x <= 402.498 && z >= 365.55 && z <= 376.55,
            ).toBe(false);
            samples++;
          }
      }
      expect(maxSlope).toBeLessThan(0.1);
      process.stdout.write(
        "Service clearing conservative AABB CPU samples " +
          JSON.stringify({
            samples,
            minDryMargin,
            maxSlope,
            minTreeMargin,
            modelCount: radii.size,
          }) +
          "\n",
      );
      const bounds = f.roads["calculateRoadMaskBounds"](
        f.roads.getRoadSegmentsForGPU(),
      );
      const mask = f.roads.generateRoadInfluenceTexture(
        256,
        bounds.worldSize,
        0.5,
        bounds.centerX,
        bounds.centerZ,
      )!;
      const pixel = bounds.worldSize / 256;
      let minMaskTreeMargin = Infinity,
        minClearingMaskBankMargin = Infinity,
        nonzero = 0;
      for (let iz = 0; iz < 256; iz++)
        for (let ix = 0; ix < 256; ix++) {
          if (mask.data[iz * 256 + ix] === 0) continue;
          const x = ix * pixel - bounds.worldSize / 2 + bounds.centerX;
          const z = iz * pixel - bounds.worldSize / 2 + bounds.centerZ;
          // Full nonzero texel influence under actual index/N producer + linear
          // sampler centers, not just the mask texel's nominal world coordinate.
          const minX = x - 0.5 * pixel,
            maxX = x + 1.5 * pixel;
          const minZ = z - 0.5 * pixel,
            maxZ = z + 1.5 * pixel;
          for (const tree of actualTrees) {
            const margin =
              Math.hypot(
                Math.max(minX - tree.x, 0, tree.x - maxX),
                Math.max(minZ - tree.z, 0, tree.z - maxZ),
              ) - tree.radius;
            expect(margin, tree.id).toBeGreaterThan(0);
            minMaskTreeMargin = Math.min(minMaskTreeMargin, margin);
          }
          if (
            CAPSULES.some(
              ([, ax, az, bx, bz, width]) =>
                compactPathSegmentDistance(
                  { x, z },
                  { x: ax, z: az },
                  { x: bx, z: bz },
                ) <
                width / 2 + 0.5,
            )
          ) {
            const margin =
              Math.hypot(
                Math.max(minX - 343, 0, 343 - maxX),
                Math.max(minZ - 302, 0, 302 - maxZ),
              ) - 11;
            expect(margin).toBeGreaterThan(0);
            minClearingMaskBankMargin = Math.min(
              minClearingMaskBankMargin,
              margin,
            );
          }
          for (const sx of [minX, maxX])
            for (const sz of [minZ, maxZ]) {
              const y = f.terrain.getResourceGroundHeight(sx, sz);
              expect(Number.isFinite(y)).toBe(true);
              expect(y).toBeGreaterThan(
                f.terrain.getWaterBodyRegistry().getWaterSurfaceAt(sx, sz) +
                  0.1,
              );
            }
          nonzero++;
        }
      process.stdout.write(
        "Complete actual 256 bilinear mask envelope " +
          JSON.stringify({
            nonzero,
            minMaskTreeMargin,
            minClearingMaskBankMargin,
          }) +
          "\n",
      );
    } finally {
      f.world.destroy();
    }
  });

  it("records actual mask rephase and preserves the complete six-leaf native-worker census without changing RNG", async () => {
    const f = await fixture();
    const tree = new TerrainQuadTree({
      minSize: 100,
      maxDepth: 4,
      resolution: 16,
    });
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};${GRASS_WORKER_CODE}\nparentPort.on('message',data=>self.onmessage({data}));`,
      { eval: true, env: {} },
    );
    let owner: GrassVisualManager | undefined;
    async function run(input: GrassWorkerInput): Promise<GrassWorkerOutput> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Actual worker deadline")),
          10000,
        );
        const onMessage = (message: {
          error?: string;
          result?: GrassWorkerOutput;
        }) => {
          if (message.error) finish(new Error(message.error));
          else if (message.result) {
            finish();
            resolve(message.result);
          }
        };
        function finish(error?: Error) {
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", finish);
          if (error) reject(error);
        }
        worker.once("message", onMessage);
        worker.once("error", finish);
        worker.postMessage(input);
      });
    }
    try {
      const current = f.roads.getRoads().slice();
      const oldSegments = segments(current.slice(0, 6));
      const currentSegments = f.roads.getRoadSegmentsForGPU();
      const oldBounds = f.roads["calculateRoadMaskBounds"](oldSegments);
      const newBounds = f.roads["calculateRoadMaskBounds"](currentSegments);
      expect(f.roads["calculateRoadMaskTextureSize"](newBounds.worldSize)).toBe(
        256,
      );
      expect(newBounds.worldSize).toBe(oldBounds.worldSize);
      expect(oldBounds).toEqual({
        worldSize: 85.5,
        centerX: 360.85,
        centerZ: 351.5,
      });
      expect(newBounds).toEqual({
        worldSize: 85.5,
        centerX: 359.55,
        centerZ: 351.5,
      });
      const currentMask = f.roads.generateRoadInfluenceTexture(
        256,
        newBounds.worldSize,
        0.5,
        newBounds.centerX,
        newBounds.centerZ,
      )!;
      let baselineMask: typeof currentMask;
      try {
        // Actual producer, with exactly the immutable original six roads.
        // No terrain/grass input, seed, sampler or baked-mask kernel replacement.
        f.roads.getRoads().splice(6);
        baselineMask = f.roads.generateRoadInfluenceTexture(
          256,
          oldBounds.worldSize,
          0.5,
          oldBounds.centerX,
          oldBounds.centerZ,
        )!;
      } finally {
        f.roads.getRoads().splice(0, f.roads.getRoads().length, ...current);
      }
      function linear(
        mask: typeof currentMask,
        bounds: typeof oldBounds,
        x: number,
        z: number,
      ) {
        const tx =
          ((x - bounds.centerX + bounds.worldSize / 2) / bounds.worldSize) *
            256 -
          0.5;
        const tz =
          ((z - bounds.centerZ + bounds.worldSize / 2) / bounds.worldSize) *
            256 -
          0.5;
        const ix = Math.floor(tx),
          iz = Math.floor(tz),
          fx = tx - ix,
          fz = tz - iz;
        const sample = (sx: number, sz: number) =>
          mask.data[
            Math.max(0, Math.min(255, sz)) * 256 +
              Math.max(0, Math.min(255, sx))
          ];
        return (
          (sample(ix, iz) * (1 - fx) + sample(ix + 1, iz) * fx) * (1 - fz) +
          (sample(ix, iz + 1) * (1 - fx) + sample(ix + 1, iz + 1) * fx) * fz
        );
      }
      let unchangedRoadSamples = 0,
        maxOldRoadMaskDelta = 0;
      for (const segment of oldSegments) {
        const length = Math.hypot(
          segment.endX - segment.startX,
          segment.endZ - segment.startZ,
        );
        if (!length) continue;
        for (const fraction of [0, 0.25, 0.5, 0.75, 1])
          for (const side of [-1, 1])
            for (const edge of [
              0,
              segment.width / 2,
              segment.width / 2 + 0.25,
              segment.width / 2 + 0.5,
            ]) {
              const x =
                segment.startX +
                (segment.endX - segment.startX) * fraction -
                ((side * (segment.endZ - segment.startZ)) / length) * edge;
              const z =
                segment.startZ +
                (segment.endZ - segment.startZ) * fraction +
                ((side * (segment.endX - segment.startX)) / length) * edge;
              // Outside every new capsule AND its conservative two-texel halo:
              // changes here are mask phase, not newly painted clearing influence.
              if (
                CAPSULES.some(
                  ([, ax, az, bx, bz, width]) =>
                    compactPathSegmentDistance(
                      { x, z },
                      { x: ax, z: az },
                      { x: bx, z: bz },
                    ) <=
                    width / 2 + 0.5 + (2 * newBounds.worldSize) / 256,
                )
              )
                continue;
              maxOldRoadMaskDelta = Math.max(
                maxOldRoadMaskDelta,
                Math.abs(
                  linear(currentMask, newBounds, x, z) -
                    linear(baselineMask, oldBounds, x, z),
                ),
              );
              unchangedRoadSamples++;
            }
      }
      expect(unchangedRoadSamples).toBeGreaterThan(5000);
      expect(maxOldRoadMaskDelta).toBeGreaterThan(0);
      process.stdout.write(
        "Original-road bilinear rephase samples (not native pixels) " +
          JSON.stringify({ unchangedRoadSamples, maxOldRoadMaskDelta }) +
          "\n",
      );
      process.stdout.write(
        "Service clearing mask phase (same 256 allocation) " +
          JSON.stringify({
            oldBounds,
            newBounds,
            oldSegments: oldSegments.length,
            newSegments: currentSegments.length,
          }) +
          "\n",
      );
      const setup = f.terrain["buildGrassWorkerSetup"]();
      // Input production requires no retained mesh; no ticket is dispatched here.
      owner = new GrassVisualManager(
        setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
        new THREE.Group(),
        () => null,
        f.terrain.getResourceGroundHeight.bind(f.terrain),
        setup.terrainConfig.WATER_THRESHOLD,
        (x, z) => f.roads.getRoadInfluenceAt(x, z),
        (x, z) => f.terrain.isGrassExcludedAt(x, z),
        (x, z, eligibility) =>
          f.terrain.getTerrainColorAt(x, z, true, eligibility),
        setup,
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
        undefined,
        (x, z) => f.terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
      );
      owner.setPlayerPosition(385, 374);
      const oldKeys = new Set(oldSegments.map(digest));
      const receipts = [];
      for (const [x, z] of [
        [450, 350],
        [250, 350],
        [350, 350],
        [350, 450],
        [450, 450],
        [350, 250],
      ]) {
        const node = tree.createNode(null, null, 100, x, z, 4);
        const input = owner["createWorkerInput"](node, `clearing_${x}_${z}`, 1);
        const baseline = {
          ...input,
          roadSegments: input.roadSegments.filter((s) =>
            oldKeys.has(digest(s)),
          ),
        };
        const [before, after] = [await run(baseline), await run(input)];
        for (const key of [
          "offsets",
          "rotScaleHash",
          "grassTints",
          "groundNormals",
          "groundColors",
        ] as const)
          expect(after[key], `${x},${z}/${key}`).toEqual(before[key]);
        receipts.push([
          x,
          z,
          before.count,
          after.count,
          baseline.roadSegments.length,
          input.roadSegments.length,
        ]);
      }
      expect(receipts.map((r) => r[3])).toEqual([271, 503, 139, 532, 493, 343]);
      process.stdout.write(
        "Service clearing actual native-worker before/after (not GPU cost) " +
          JSON.stringify(receipts) +
          "\n",
      );
    } finally {
      owner?.destroy();
      await worker.terminate();
      tree.dispose();
      f.world.destroy();
    }
  }, 20000);
});
