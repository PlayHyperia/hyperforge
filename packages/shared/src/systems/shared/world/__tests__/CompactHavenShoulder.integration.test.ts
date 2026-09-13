import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import {
  QUAD_CHUNK_WORKER_CODE,
  type QuadChunkWorkerInput,
  type QuadChunkWorkerOutput,
} from "../../../../utils/workers/QuadChunkWorker";
import type { BufferGeometry } from "../../../../extras/three/three";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import {
  createCompactIslandPaths,
  compactPathIntersectsBounds,
} from "../CompactIslandPaths";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../TerrainQuadChunkGenerator";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
} from "../TerrainGridSurface";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as baseline,
  HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE as candidate,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";
import groveLayouts from "./fixtures/CompactResourceGroves.layouts.json";

// Independent authoring envelope, not expectations copied from the new sampler.
const SUPPORT = { minX: 272, maxX: 314, minZ: 303, maxZ: 367 };
const inside = (x: number, z: number) =>
  x > SUPPORT.minX && x < SUPPORT.maxX && z > SUPPORT.minZ && z < SUPPORT.maxZ;

class CpuServerWorld extends World {
  override get isServer() {
    return true;
  }
}
const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
};
const worlds: World[] = [];

async function fixture(profile: WorldTerrainProfile) {
  if (!saved.config) throw new Error("Current world manifest was not loaded");
  // Both fixtures retain the complete current content. Only the admitted
  // terrain profile differs; the candidate uses the same compact layout ID.
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig({
    ...structuredClone(saved.config),
    terrainProfile: structuredClone(profile),
  });
  const world = new CpuServerWorld();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  await roads.init();
  await roads.start();
  return {
    world,
    terrain,
    roads,
    provider: terrain["buildChunkTerrainProvider"](),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let previous: Fixture, next: Fixture;

beforeAll(async () => {
  previous = await fixture(baseline);
  next = await fixture(candidate);
}, 20000);
afterAll(() => {
  for (const world of worlds.splice(0)) world.destroy();
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
});

/** Execute the real emitted worker body and its message handler in a fresh VM.
 * JSON parsing occurs inside that realm, like native structured-clone input;
 * only its postMessage transport is supplied by this CPU test harness. */
function runEmittedWorker(input: QuadChunkWorkerInput): QuadChunkWorkerOutput {
  let response: { result?: QuadChunkWorkerOutput; error?: string } | undefined;
  runInNewContext(
    QUAD_CHUNK_WORKER_CODE +
      "\nself.onmessage({data:JSON.parse(requestJSON)});",
    {
      requestJSON: JSON.stringify(input),
      self: {
        postMessage(message: {
          result?: QuadChunkWorkerOutput;
          error?: string;
        }) {
          response = structuredClone(message);
        },
      },
    },
    { timeout: 5000 },
  );
  if (!response || response.error || !response.result)
    throw new Error(
      response?.error ?? "Emitted quad worker returned no result",
    );
  return response.result;
}

function actualRoadMask(f: Fixture) {
  const bounds = f.roads["calculateRoadMaskBounds"](
    f.roads.getRoadSegmentsForGPU(),
  );
  const result = f.roads.generateRoadInfluenceTexture(
    256,
    bounds.worldSize,
    0.5,
    bounds.centerX,
    bounds.centerZ,
  );
  if (!result) throw new Error("Actual compact roads did not produce a mask");
  return result;
}

function allocation(geometry: BufferGeometry) {
  if (!geometry.index) throw new Error("Terrain mesh has no index");
  return {
    triangles: geometry.index.count / 3,
    bytes:
      geometry.index.array.byteLength +
      Object.values(geometry.attributes).reduce(
        (sum, attribute) => sum + attribute.array.byteLength,
        0,
      ),
  };
}

/** Independent indexed-triangle plane, not a bilinear or procedural stand-in. */
function trianglePlane(
  geometry: BufferGeometry,
  face: number,
  x: number,
  z: number,
) {
  const index = geometry.index;
  if (!index) throw new Error("Missing terrain triangles");
  const p = geometry.getAttribute("position");
  const a = index.getX(face * 3),
    b = index.getX(face * 3 + 1),
    c = index.getX(face * 3 + 2);
  const ax = p.getX(a),
    ay = p.getY(a),
    az = p.getZ(a);
  const ux = p.getX(b) - ax,
    uy = p.getY(b) - ay,
    uz = p.getZ(b) - az;
  const vx = p.getX(c) - ax,
    vy = p.getY(c) - ay,
    vz = p.getZ(c) - az;
  const determinant = ux * vz - vx * uz;
  const u = ((x - ax) * vz - vx * (z - az)) / determinant;
  const v = (ux * (z - az) - (x - ax) * uz) / determinant;
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return {
    height: ay + u * uy + v * vy,
    nx: nx / length,
    ny: ny / length,
    nz: nz / length,
  };
}

describe("actual Haven shoulder terrain, emitted worker and retained geometry", () => {
  it("retains current protected grades, known tree probes and the complete real road-mask support", () => {
    expect(previous.terrain.getWorldTerrainProfile()).toEqual(baseline);
    expect(next.terrain.getWorldTerrainProfile()).toEqual(candidate);
    expect(next.provider.terrainProfileIdentity).not.toBe(
      previous.provider.terrainProfileIdentity,
    );
    let checks = 0;
    const unchanged = (x: number, z: number) => {
      expect(next.terrain.getResourceGroundHeight(x, z), `${x},${z}`).toBe(
        previous.terrain.getResourceGroundHeight(x, z),
      );
      checks++;
    };
    // Frozen existing coordinates + frozen prior grove layouts, not a claimed
    // fresh resource census. The native companion owns ResourceSystem/PhysX/BFS.
    const originalTreePositions = [
      [280.5, 512.5],
      [280.5, 517.5],
      [288.5, 507.5],
      [310.5, 294.5],
      [334.5, 265.5],
      [366.5, 322.5],
      [318.5, 312.5],
      [318.5, 344.5],
      [376.5, 287.5],
      [381.5, 329.5],
      [323.5, 288.5],
      [501.5, 418.5],
      [502.5, 431.5],
    ];
    const treePositions = [
      ...originalTreePositions,
      ...groveLayouts.previous.regions
        .flatMap((region) => region.anchors)
        .map((a) => [a.position.x, a.position.z]),
      ...groveLayouts.additions.map((a) => [a.position.x, a.position.z]),
    ];
    expect(treePositions).toHaveLength(48);
    for (const [x, z] of treePositions)
      for (let dx = -4; dx <= 4; dx += 0.5)
        for (let dz = -4; dz <= 4; dz += 0.5) unchanged(x + dx, z + dz);
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      for (const item of [...(area.stations ?? []), ...(area.npcs ?? [])])
        for (let dx = -2; dx <= 2; dx += 0.5)
          for (let dz = -2; dz <= 2; dz += 0.5)
            unchanged(item.position.x + dx, item.position.z + dz);
      for (const mob of area.mobSpawns ?? [])
        for (let dx = -mob.spawnRadius; dx <= mob.spawnRadius; dx += 0.5)
          for (let dz = -mob.spawnRadius; dz <= mob.spawnRadius; dz += 0.5)
            if (dx * dx + dz * dz <= mob.spawnRadius ** 2)
              unchanged(mob.position.x + dx, mob.position.z + dz);
    }
    for (const zone of next.terrain["flatZones"].values()) {
      const before = previous.terrain["flatZones"].get(zone.id);
      expect(zone).toEqual(before);
    }
    for (let x = 332; x <= 354; x += 0.5)
      for (let z = 291; z <= 313; z += 0.5) unchanged(x, z);
    for (let x = 316; x <= 420; x++)
      for (let z = 348.5; z <= 433; z++) unchanged(x, z);
    const paths = (f: Fixture) =>
      createCompactIslandPaths(
        f.terrain.getWorldTerrainProfile(),
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        f.terrain.getResourceGroundHeight.bind(f.terrain),
      );
    expect(paths(next)).toEqual(paths(previous));
    expect(paths(next)).toHaveLength(11);
    for (const road of paths(next))
      for (let i = 1; i < road.path.length; i++)
        expect(
          compactPathIntersectsBounds(
            road.path[i - 1],
            road.path[i],
            SUPPORT,
            road.width / 2 + 0.5,
          ),
        ).toBe(false);
    const beforeMask = actualRoadMask(previous),
      afterMask = actualRoadMask(next);
    expect(afterMask).toEqual(beforeMask);
    expect([afterMask.worldSize, afterMask.centerX, afterMask.centerZ]).toEqual(
      [85.5, 359.55, 351.5],
    );
    const pixel = afterMask.worldSize / afterMask.width;
    let supportTexels = 0;
    for (let iz = 0; iz < afterMask.height; iz++)
      for (let ix = 0; ix < afterMask.width; ix++) {
        if (afterMask.data[iz * afterMask.width + ix] === 0) continue;
        const x = ix * pixel - afterMask.worldSize / 2 + afterMask.centerX;
        const z = iz * pixel - afterMask.worldSize / 2 + afterMask.centerZ;
        expect(
          x + pixel * 1.5 <= SUPPORT.minX ||
            x - pixel / 2 >= SUPPORT.maxX ||
            z + pixel * 1.5 <= SUPPORT.minZ ||
            z - pixel / 2 >= SUPPORT.maxZ,
        ).toBe(true);
        for (const dx of [-0.5, 0.5, 1.5])
          for (const dz of [-0.5, 0.5, 1.5])
            unchanged(x + dx * pixel, z + dz * pixel);
        supportTexels++;
      }
    expect(supportTexels).toBe(4684);
    process.stdout.write(
      `Haven protected CPU terrain/roads: ${JSON.stringify({ knownTreeCoordinates: treePositions.length, checks, paths: 11, supportTexels, freshCensusOrBfs: false })}\n`,
    );
  });

  it("retains the same node owners across preparation, arena and functional-grove viewpoints", () => {
    const rows = (tree: TerrainQuadTree) =>
      tree
        .getFinalNodes()
        .map((node) => [node.centerX, node.centerZ, node.size])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const counts = [];
    for (const [x, z] of [
      [350, 340],
      [385, 374],
      [350, 406],
      [318, 312],
      [287, 400],
      [459, 383],
    ]) {
      const oldTree = new TerrainQuadTree({
        resolution: 16,
        rootChunkRadius: 0,
        fineDetailRegions: createCompactPreparationDetailRegions(
          baseline,
          ALL_WORLD_AREAS,
          64,
        ),
      });
      const newTree = new TerrainQuadTree({
        resolution: 16,
        rootChunkRadius: 0,
        fineDetailRegions: createCompactPreparationDetailRegions(
          candidate,
          ALL_WORLD_AREAS,
          64,
        ),
      });
      try {
        oldTree.update(x, z);
        newTree.update(x, z);
        expect(rows(newTree), `Node owners changed at ${x},${z}`).toEqual(
          rows(oldTree),
        );
        counts.push({ x, z, nodes: newTree.getFinalNodes().length });
      } finally {
        oldTree.dispose();
        newTree.dispose();
      }
    }
    process.stdout.write(
      `Haven retained node-owner viewpoints: ${JSON.stringify(counts)}\n`,
    );
  });

  it("refines only the existing western leaf and matches actual emitted workers at baseline and candidate densities", () => {
    const regions = createCompactPreparationDetailRegions(
      candidate,
      ALL_WORLD_AREAS,
      64,
    );
    const previousRegions = createCompactPreparationDetailRegions(
      baseline,
      ALL_WORLD_AREAS,
      64,
    );
    expect(regions).toEqual([
      ...previousRegions,
      { ...SUPPORT, resolution: 128, keepMinSize: true },
    ]);
    const tree = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      fineDetailRegions: regions,
    });
    const previousTree = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      fineDetailRegions: previousRegions,
    });
    const geometries: BufferGeometry[] = [];
    try {
      tree.update(350, 340);
      previousTree.update(350, 340);
      const nodes = tree.getFinalNodes();
      expect(nodes).toHaveLength(61);
      const previousNodes = previousTree.getFinalNodes();
      const nodeRows = (rows: typeof nodes) =>
        rows
          .map((n) => [n.centerX, n.centerZ, n.size])
          .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      expect(nodeRows(nodes)).toEqual(nodeRows(previousNodes));
      const densityChanges = nodes.filter((node) => {
        const old = previousNodes.find(
          (n) =>
            n.centerX === node.centerX &&
            n.centerZ === node.centerZ &&
            n.size === node.size,
        );
        return old?.resolution !== node.resolution;
      });
      expect(
        densityChanges.map((n) => [n.centerX, n.centerZ, n.resolution]),
      ).toEqual([[250, 350, 128]]);
      const touched = nodes
        .filter(
          (n) =>
            n.centerX + n.size / 2 > SUPPORT.minX &&
            n.centerX - n.size / 2 < SUPPORT.maxX &&
            n.centerZ + n.size / 2 > SUPPORT.minZ &&
            n.centerZ - n.size / 2 < SUPPORT.maxZ,
        )
        .sort((a, b) => a.centerX - b.centerX);
      expect(
        touched.map((n) => [n.centerX, n.centerZ, n.size, n.resolution]),
      ).toEqual([
        [250, 350, 100, 128],
        [350, 350, 100, 128],
      ]);
      const receipts = [];
      let addedTriangles = 0,
        addedBytes = 0;
      for (const node of touched) {
        const previousNode = previousNodes.find(
          (n) =>
            n.centerX === node.centerX &&
            n.centerZ === node.centerZ &&
            n.size === node.size,
        )!;
        const resolutions = [previousNode.resolution, node.resolution];
        const generated = [previous, next].map((f, i) =>
          generateQuadChunkDataSync(
            node.centerX,
            node.centerZ,
            node.size,
            resolutions[i],
            f.provider,
          ),
        );
        const assembled = generated.map((data, i) =>
          assembleQuadChunkGeometry(data, [previous, next][i].provider, 15),
        );
        geometries.push(...assembled.map((a) => a.geometry));
        const oldAllocation = allocation(assembled[0].geometry),
          newAllocation = allocation(assembled[1].geometry);
        const increment = {
          triangles: newAllocation.triangles - oldAllocation.triangles,
          bytes: newAllocation.bytes - oldAllocation.bytes,
        };
        expect(increment).toEqual(
          node.centerX === 250
            ? { triangles: 24832, bytes: 1000448 }
            : { triangles: 0, bytes: 0 },
        );
        addedTriangles += increment.triangles;
        addedBytes += increment.bytes;
        if (resolutions[0] === resolutions[1])
          expect(assembled[1].geometry.index!.array).toEqual(
            assembled[0].geometry.index!.array,
          );
        expect(Object.keys(assembled[1].geometry.attributes)).toEqual(
          Object.keys(assembled[0].geometry.attributes),
        );
        if (resolutions[0] === resolutions[1])
          expect(
            assembled[1].geometry.getAttribute("roadInfluence").array,
          ).toEqual(assembled[0].geometry.getAttribute("roadInfluence").array);
        let changedVertices = 0;
        for (let iz = 0; iz < node.resolution; iz++)
          for (let ix = 0; ix < node.resolution; ix++) {
            const index = iz * node.resolution + ix;
            const x = node.centerX - 50 + (ix * 100) / (node.resolution - 1),
              z = node.centerZ - 50 + (iz * 100) / (node.resolution - 1);
            if (
              Math.fround(previous.terrain.getResourceGroundHeight(x, z)) !==
              assembled[1].heightData[index]
            ) {
              expect(
                inside(x, z),
                `Changed retained vertex outside shoulder ${x},${z}`,
              ).toBe(true);
              changedVertices++;
            }
          }
        expect(changedVertices).toBeGreaterThan(0);
        for (const [i, f] of [previous, next].entries()) {
          const setup = f.terrain["buildGrassWorkerSetup"]();
          const request: QuadChunkWorkerInput = {
            type: "generateQuadChunk",
            centerX: node.centerX,
            centerZ: node.centerZ,
            size: node.size,
            resolution: resolutions[i],
            config: setup.terrainConfig,
            seed: setup.seed,
            biomeCenters: setup.biomeCenters,
            biomes: setup.biomes,
          };
          const output = runEmittedWorker(request);
          expect(output.terrainProfileIdentity).toBe(
            f.provider.terrainProfileIdentity,
          );
          const rawHeightCopy = output.heightData.slice();
          const fromWorker = assembleQuadChunkGeometry(output, f.provider, 15);
          geometries.push(fromWorker.geometry);
          expect(output.heightData).toEqual(rawHeightCopy);
          expect(fromWorker.heightData).toEqual(assembled[i].heightData);
          expect(fromWorker.geometry.getAttribute("position").array).toEqual(
            assembled[i].geometry.getAttribute("position").array,
          );
          expect(fromWorker.geometry.getAttribute("normal").array).toEqual(
            assembled[i].geometry.getAttribute("normal").array,
          );
        }
        receipts.push({
          center: [node.centerX, node.centerZ],
          previousResolution: previousNode.resolution,
          resolution: node.resolution,
          changedVertices,
          ...allocation(assembled[1].geometry),
        });
      }
      expect({ addedTriangles, addedBytes }).toEqual({
        addedTriangles: 24832,
        addedBytes: 1000448,
      });
      process.stdout.write(
        `Haven emitted worker/retained allocation: ${JSON.stringify({ unchangedFinalNodes: nodes.length, addedNodeOwners: 0, addedTriangles, addedBytes, workerRequests: 4, receipts, gpuOrVisualAcceptance: false })}\n`,
      );
    } finally {
      for (const geometry of geometries) geometry.dispose();
      tree.dispose();
      previousTree.dispose();
    }
  });

  it("samples actual indexed triangle planes and removes the candidate density-mismatch seam", () => {
    const geometries: BufferGeometry[] = [];
    const sample: TerrainGridSample = {
      height: 0,
      nx: 0,
      ny: 1,
      nz: 0,
      faceIndex: 0,
    };
    const surfaces: RetainedTerrainSurface[][] = [[], []];
    const receipts = [];
    try {
      for (const [i, f] of [previous, next].entries())
        for (const [centerX, resolution] of [
          [250, i === 0 ? 64 : 128],
          [350, 128],
        ]) {
          const chunk = assembleQuadChunkGeometry(
            generateQuadChunkDataSync(
              centerX,
              350,
              100,
              resolution,
              f.provider,
            ),
            f.provider,
            15,
          );
          geometries.push(chunk.geometry);
          const surface = new RetainedTerrainSurface(
            centerX,
            f.provider.terrainProfileIdentity,
            centerX,
            350,
            100,
            resolution,
            chunk.geometry,
          );
          surfaces[i].push(surface);
          let maximumAnalyticError = 0,
            maximumPlaneError = 0,
            maximumNormalError = 0,
            queries = 0;
          let worst: number[] = [];
          for (let iz = 0; iz < resolution - 1; iz++)
            for (let ix = 0; ix < resolution - 1; ix++)
              for (const [u, v] of [
                [0.25, 0.25],
                [0.5, 0.5],
                [0.75, 0.75],
                [0.2, 0.65],
                [0.75, 0.6],
              ]) {
                const lx = -50 + ((ix + u) * 100) / (resolution - 1),
                  lz = -50 + ((iz + v) * 100) / (resolution - 1);
                const x = centerX + lx,
                  z = 350 + lz;
                if (
                  x < SUPPORT.minX - 2 ||
                  x > SUPPORT.maxX + 2 ||
                  z < SUPPORT.minZ - 2 ||
                  z > SUPPORT.maxZ + 2
                )
                  continue;
                expect(surface.sample(lx, lz, sample)).toBe(true);
                const plane = trianglePlane(
                  chunk.geometry,
                  sample.faceIndex,
                  lx,
                  lz,
                );
                maximumPlaneError = Math.max(
                  maximumPlaneError,
                  Math.abs(sample.height - plane.height),
                );
                maximumNormalError = Math.max(
                  maximumNormalError,
                  Math.hypot(
                    sample.nx - plane.nx,
                    sample.ny - plane.ny,
                    sample.nz - plane.nz,
                  ),
                );
                const error = Math.abs(
                  sample.height - f.terrain.getResourceGroundHeight(x, z),
                );
                if (error > maximumAnalyticError) {
                  maximumAnalyticError = error;
                  worst = [x, z];
                }
                queries++;
              }
          expect(queries).toBeGreaterThan(1000);
          expect(maximumPlaneError).toBeLessThan(1e-10);
          expect(maximumNormalError).toBeLessThan(1e-10);
          // Keep the historical coarse ceiling for baseline; the selected
          // shape/refinement has a stricter 10cm analytic sampling ceiling.
          // Neither substitutes for actual character contact or native art.
          process.stdout.write(
            `Haven retained surface residual: ${JSON.stringify({ candidate: i === 1, centerX, resolution, queries, maximumPlaneError, maximumNormalError, maximumAnalyticError, worst })}\n`,
          );
          expect
            .soft(maximumAnalyticError)
            .toBeLessThanOrEqual(i === 0 ? 0.35 : 0.1);
          receipts.push({
            candidate: i === 1,
            centerX,
            resolution,
            queries,
            maximumAnalyticError,
          });
          if (centerX === 350)
            for (const [x, z] of [
              [318.5, 312.5],
              [318.5, 344.5],
              [335, 336],
              [338, 336],
              [348, 318],
            ]) {
              expect(surface.sample(x - centerX, z - 350, sample)).toBe(true);
              expect(
                Math.abs(
                  sample.height - f.terrain.getResourceGroundHeight(x, z),
                ),
              ).toBeLessThan(0.00001);
            }
        }
      const seams = surfaces.map((pair) => {
        let maximum = 0;
        for (let z = SUPPORT.minZ; z <= SUPPORT.maxZ; z += 0.25) {
          expect(pair[0].sample(50, z - 350, sample)).toBe(true);
          const left = sample.height;
          expect(pair[1].sample(-50, z - 350, sample)).toBe(true);
          maximum = Math.max(maximum, Math.abs(left - sample.height));
        }
        return maximum;
      });
      process.stdout.write(
        `Haven retained seam diagnostic: ${JSON.stringify({ x: 300, before: seams[0], after: seams[1], receipts, artAndCharacterAcceptance: false })}\n`,
      );
      // Matching Float32 edge grids remove the former 14cm density mismatch.
      // Tiny residual is floating-point interpolation arithmetic, not a skirt.
      expect(seams[1]).toBeLessThan(1e-10);
    } finally {
      for (const geometry of geometries) geometry.dispose();
    }
  });
});
