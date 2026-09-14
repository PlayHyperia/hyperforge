import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ClientGraphics } from "../../../client/ClientGraphics";
import { DataManager } from "../../../../data/DataManager";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { TerrainVisualManager } from "../TerrainVisualManager";
import {
  projectGrassAnchors,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { groundGrassBlades } from "../GrassBladeGrounding";
import { gridGeometry } from "./terrain-grid.fixture";
import {
  createCompactTerrainColorOperations,
  COMPACT_TERRAIN_COMPOSITION,
  type CompactGrassColorGrade,
} from "../CompactTerrainPalette";
import {
  generateNoiseTexture,
  getNoiseTexture,
  sampleNoiseCPU,
  TERRAIN_SHADER_CONSTANTS,
} from "../TerrainShader";
import {
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
  STREAMING_GRASS_VISUAL_PROFILE,
  GrassVisualManager,
} from "../GrassVisualManager";
import { getGrassBladeLayout } from "../GrassBladeLayout";

/** Actual World terrain, road constraints, retained geometry, placement and
 * grounding pipeline. Test orchestration does not replace manager methods. */
async function fixture(grade?: CompactGrassColorGrade) {
  const worker = new Worker(
    `const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};
    ${GRASS_WORKER_CODE}
    parentPort.on('message',data=>self.onmessage({data}));`,
    { eval: true, env: {} },
  );
  function execute(input: GrassWorkerInput): Promise<GrassWorkerOutput> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Real grass worker deadline")),
        10000,
      );
      function finish(error?: Error) {
        clearTimeout(timer);
        worker.off("error", onError);
        worker.off("message", onMessage);
        if (error) reject(error);
      }
      function onError(error: Error) {
        finish(error);
      }
      function onMessage(message: {
        error?: string;
        result?: GrassWorkerOutput;
      }) {
        if (message.error) finish(new Error(message.error));
        else if (message.result) {
          finish();
          resolve(message.result);
        }
      }
      worker.once("error", onError);
      worker.once("message", onMessage);
      worker.postMessage(input);
    });
  }
  await DataManager.getInstance().initialize();
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  terrain["subscribeRoadNetworkEvents"]();
  await roads.init();
  await roads.start();
  const setup = {
    ...terrain["buildGrassWorkerSetup"](),
    ...(grade ? { compactGrassColorGrade: grade } : {}),
  };
  const colorOperations = createCompactTerrainColorOperations();
  const material = new THREE.MeshBasicMaterial();
  const visual = new TerrainVisualManager(
    { minSize: 100, maxDepth: 4, resolution: 16, rootChunkRadius: 0 },
    terrain["buildChunkTerrainProvider"](),
    new THREE.Group(),
    material,
    setup.terrainConfig,
    setup.seed,
    setup.biomeCenters,
    setup.biomes,
  );
  const tree = visual.getQuadTree();
  const nodes = [-100, 0, 100].flatMap((dx) =>
    [-100, 0, 100].map((dz) =>
      tree.createNode(null, null, 100, 350 + dx, 350 + dz, 4),
    ),
  );
  for (const node of nodes) visual["generateChunkSync"](node);
  const node = nodes[4];
  const container = new THREE.Group();
  const owner = new GrassVisualManager(
    setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
    container,
    (leaf) => visual.getRetainedSurface(leaf),
    (x, z) => terrain["getHeightAtComputed"](x, z),
    setup.terrainConfig.WATER_THRESHOLD,
    (x, z) => terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
    (x, z) => terrain.isGrassExcludedAt(x, z),
    (x, z, eligibility) => {
      const base = terrain.getTerrainColorAt(x, z, true, eligibility);
      if (!grade) return base;
      // Explicit CPU provider and real shared palette, not a browser route or
      // private TerrainSystem cache override. Native startup proves selection.
      const height = terrain["getHeightAtComputed"](x, z);
      const dx =
        terrain["getHeightAtComputed"](x + 0.5, z) -
        terrain["getHeightAtComputed"](x - 0.5, z);
      const dz =
        terrain["getHeightAtComputed"](x, z + 0.5) -
        terrain["getHeightAtComputed"](x, z - 0.5);
      const gradient = Math.sqrt(dx * dx + dz * dz);
      return {
        ...base,
        ...colorOperations.sample({
          grassColorGrade: grade,
          noiseValue: sampleNoiseCPU(
            x,
            z,
            TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
          ),
          meadowNoise: sampleNoiseCPU(
            x,
            z,
            COMPACT_TERRAIN_COMPOSITION.meadowNoiseScale,
          ),
          distortNoise: sampleNoiseCPU(
            x,
            z,
            TERRAIN_SHADER_CONSTANTS.DISTORT_NOISE_SCALE,
          ),
          slope: 1 - 1 / Math.sqrt(1 + gradient * gradient),
          roadInfluence: terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
          surface: {
            x,
            z,
            height,
            pond: terrain["getCompactPondMaterial"](),
            macroField: terrain["getCompactMacroMaterial"](),
            plantingLobes: setup.compactPlantingLobes,
          },
        }),
      };
    },
    setup,
    FINE_MEADOW_GRASS_VISUAL_PROFILE,
    undefined,
    (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
    (bounds) => visual.captureRetainedSurfaceRegion(bounds),
    "fine-meadow-v1",
  );
  owner.setPlayerPosition(385, 374);
  owner["lodFocusX"] = 385;
  owner["lodFocusZ"] = 374;
  owner.onNodeNeedsGeometry(node);
  const work = owner["liveWorkUnits"].get("gcell_v1_15_14")!;
  async function queue(lod = 0, swap = false, target = work) {
    const input = owner["createWorkerInput"](target, target.key, lod);
    const ticket = owner["createWorkerTicket"](target, target.key, lod, swap);
    const output = await execute(input);
    owner["settleWorkerResult"](ticket, output);
    return { input, ticket, output };
  }
  function finish(key = work.key) {
    let slices = 0,
      uploads = 0;
    while (
      owner["groundingJobs"].get(key)?.job.state.status === "running" &&
      slices++ < 1000
    )
      uploads += owner["advanceGroundingJob"]();
    expect(slices).toBeLessThan(1000);
    return uploads;
  }
  return {
    world,
    terrain,
    setup,
    visual,
    tree,
    nodes,
    node,
    owner,
    container,
    work,
    queue,
    execute,
    finish,
    close() {
      void worker.terminate();
      owner.destroy();
      visual.dispose();
      material.dispose();
      world.destroy();
    },
  };
}

describe("fine meadow cells borrow actual terrain owners without replacing them", () => {
  it("cancels in-flight grounding when only a registered station grass boundary changes", async () => {
    const f = await fixture();
    // Wire the existing real manager to terrain's production invalidation path.
    f.terrain["grassVisualManager"] = f.owner;
    try {
      const zone = {
        id: "grass-clearance-live-replacement",
        centerX: 387.5,
        centerZ: 362.5,
        width: 25,
        depth: 25,
        height: f.terrain.getHeightAt(387.5, 362.5),
        blendRadius: 0,
        grassExclusionBounds: { minX: 389, maxX: 390, minZ: 363, maxZ: 364 },
      };
      f.terrain.registerFlatZone(zone);
      const old = f.setup.getTerrainSurfaceForRegion(375, 350, 400, 375);
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      const pending = f.owner["groundingJobs"].get(f.work.key)!;
      expect(pending.job.state.status).toBe("running");
      f.terrain.registerFlatZone({
        id: "remote-grass-update",
        centerX: 1000,
        centerZ: 1000,
        width: 2,
        depth: 2,
        height: 28,
        blendRadius: 1,
      });
      f.owner["reconcileGrassHorizon"]();
      expect(f.owner["groundingJobs"].get(f.work.key)).toBe(pending);
      expect(pending.job.state.status).toBe("running");
      const terrainSurface = f.visual.getRetainedSurface(f.node);
      f.terrain.registerFlatZone({
        ...zone,
        grassExclusionBounds: {
          minX: 389.25,
          maxX: 389.75,
          minZ: 363.25,
          maxZ: 363.75,
        },
      });
      expect(pending.job.state.status).toBe("cancelled");
      expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
      expect(f.owner["advanceGroundingJob"]()).toBe(0);
      expect(f.container.children).toHaveLength(0);
      expect(f.visual.getRetainedSurface(f.node)).toBe(terrainSurface);
      expect(
        old.zones.find((entry) => entry.id === zone.id)!.grassExclusionBounds,
      ).toEqual(zone.grassExclusionBounds);
      const next = f.setup.getTerrainSurfaceForRegion(375, 350, 400, 375);
      expect(
        next.zones.find((entry) => entry.id === zone.id)!.grassExclusionBounds,
      ).toEqual({
        minX: 389.25,
        maxX: 389.75,
        minZ: 363.25,
        maxZ: 363.75,
      });
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      expect(f.finish()).toBe(1);
      expect(f.owner.getProfileReceipt().grounding?.failedChunks).toBe(0);
    } finally {
      f.terrain["grassVisualManager"] = null;
      f.close();
    }
  });

  it("keeps live grass sampling invariant across actual terrain noise texture initialization", async () => {
    // Native grade capture exposed this off-center cell: the initialized
    // main-thread texture branch must not select different clumps to workers.
    expect(getNoiseTexture()).toBeNull();
    const f = await fixture("fine-meadow-green-v1");
    try {
      const parent = f.nodes.find(
        (node) => node.centerX === 250 && node.centerZ === 250,
      )!;
      f.owner.onNodeNeedsGeometry(parent);
      const works = ["gcell_v1_10_11", f.work.key].map((key) =>
        f.owner["liveWorkUnits"].get(key)!,
      );
      const attributes = [
        "offsets",
        "rotScaleHash",
        "groundColors",
        "grassTints",
        "groundNormals",
      ] as const;
      const before: Array<{
        work: (typeof works)[number];
        lod: number;
        input: GrassWorkerInput;
        cpu: GrassAnchorData;
        worker: GrassWorkerOutput;
      }> = [];
      for (const work of works) {
        expect(work).toBeDefined();
        for (const lod of [0, 1]) {
          const input = f.owner["createWorkerInput"](work, work.key, lod);
          const cpu = f.owner["generateInstanceData"](
            work,
            GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
          )!;
          const worker = await f.execute(input);
          expect(cpu.count).toBeGreaterThan(0);
          expect(cpu.count).toBeLessThanOrEqual(1276);
          expect(worker.count).toBe(cpu.count);
          for (const attribute of attributes)
            expect(worker[attribute]).toEqual(cpu[attribute]);
          before.push({ work, lod, input, cpu, worker });
        }
      }
      // Creates the exact production bytes and cached DataTexture, not a mock
      // texture or a synthetic replacement for the manager's color callback.
      const texture = generateNoiseTexture();
      expect(getNoiseTexture()).toBe(texture);
      expect(generateNoiseTexture()).toBe(texture);
      for (const entry of before) {
        const cpu = f.owner["generateInstanceData"](
          entry.work,
          GRASS_CONFIG.LOD_TIERS[entry.lod].spacingMul,
        )!;
        const worker = await f.execute(entry.input);
        expect(cpu.count).toBe(entry.cpu.count);
        expect(worker.count).toBe(cpu.count);
        for (const attribute of attributes) {
          expect(cpu[attribute]).toEqual(entry.cpu[attribute]);
          expect(worker[attribute]).toEqual(cpu[attribute]);
        }
        const surface = f.visual.getRetainedSurface(entry.work.node)!;
        const projectedCpu = projectGrassAnchors(
          cpu,
          surface,
          f.owner["getWaterSurfaceAt"],
          f.owner["isInFlatZone"],
        );
        const projectedWorker = projectGrassAnchors(
          worker,
          surface,
          f.owner["getWaterSurfaceAt"],
          f.owner["isInFlatZone"],
        );
        expect(projectedWorker.count).toBe(projectedCpu.count);
        for (const attribute of attributes)
          expect(projectedWorker[attribute]).toEqual(projectedCpu[attribute]);
        expect(projectedWorker.grounding).toEqual(projectedCpu.grounding);
      }
    } finally {
      f.close();
    }
  });

  it("keeps grass color grade manager and emitted-worker arrays exact at both tiers without changing placement", async () => {
    const f = await fixture("fine-meadow-green-v1");
    try {
      const captured = f.owner["createWorkerInput"](f.work, f.work.key, 0);
      expect(captured.compactGrassColorGrade).toBe("fine-meadow-green-v1");
      // Caller-owned setup cannot change the manager's captured primitive.
      Reflect.set(
        f.setup,
        "compactGrassColorGrade",
        "wrong-after-construction",
      );
      expect(
        f.owner["createWorkerInput"](f.work, f.work.key, 0)
          .compactGrassColorGrade,
      ).toBe("fine-meadow-green-v1");
      let changedColors = 0;
      for (const work of f.owner["liveWorkUnits"].values())
        for (const lod of [0, 1]) {
          const input = f.owner["createWorkerInput"](work, work.key, lod);
          const sync = f.owner["generateInstanceData"](
            work,
            GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
          );
          const graded = await f.execute(input);
          expect(graded.compactGrassColorGrade).toBe("fine-meadow-green-v1");
          expect(graded.count).toBe(sync?.count ?? 0);
          for (const name of [
            "offsets",
            "rotScaleHash",
            "groundColors",
            "grassTints",
            "groundNormals",
          ] as const)
            expect(graded[name]).toEqual(sync?.[name] ?? new Float32Array());
          const baselineInput = { ...input };
          delete baselineInput.compactGrassColorGrade;
          const baseline = await f.execute(baselineInput);
          expect(baseline.count).toBe(graded.count);
          expect(baseline.placementCell).toEqual(graded.placementCell);
          for (const name of [
            "offsets",
            "rotScaleHash",
            "grassTints",
            "groundNormals",
          ] as const)
            expect(graded[name]).toEqual(baseline[name]);
          for (let i = 0; i < graded.groundColors.length; i++)
            if (!Object.is(graded.groundColors[i], baseline.groundColors[i]))
              changedColors++;
        }
      expect(changedColors).toBeGreaterThan(0);
    } finally {
      f.close();
    }
  }, 30000);

  it("rejects wrong or absent grass color grade before worker publication and keeps real grounded geometry identical", async () => {
    const baseline = await fixture();
    const graded = await fixture("fine-meadow-green-v1");
    try {
      for (const lod of [0, 1]) {
        for (const f of [baseline, graded]) {
          f.owner["lodFocusX"] = lod ? 450 : 385;
          f.owner["lodFocusZ"] = 362.5;
          const { ticket, output } = await f.queue(lod, lod === 1);
          f.owner["settledWorkerResults"].length = 0;
          for (const badGrade of [
            undefined,
            null,
            "wrong",
            "fine-meadow-green-v1",
          ]) {
            if (badGrade === output.compactGrassColorGrade) continue;
            expect(() =>
              f.owner["settleWorkerResult"](ticket, {
                ...output,
                compactGrassColorGrade: badGrade,
              } as GrassWorkerOutput),
            ).toThrow(/grass color grade mismatch/);
            expect(f.owner["settledWorkerResults"]).toHaveLength(0);
          }
          if (output.compactGrassColorGrade) {
            const missing = { ...output };
            delete missing.compactGrassColorGrade;
            expect(() =>
              f.owner["settleWorkerResult"](ticket, missing),
            ).toThrow(/grass color grade mismatch/);
          }
          f.owner["settleWorkerResult"](ticket, output);
          f.owner["processSettledWorkerResults"]();
          expect(f.finish()).toBe(1);
        }
        const a = baseline.owner["chunks"].get(baseline.work.key)!.mesh;
        const b = graded.owner["chunks"].get(graded.work.key)!.mesh;
        expect(a.count).toBe(b.count);
        expect(a.count).toBeGreaterThan(0);
        expect(a.boundingBox).toEqual(b.boundingBox);
        expect(a.boundingSphere).toEqual(b.boundingSphere);
        expect(a.geometry.index!.array).toEqual(b.geometry.index!.array);
        for (const name of [
          "position",
          "normal",
          "uv",
          "instanceOffset",
          "instanceRotScaleHash",
          "instanceGroundNormal",
          "grassRootDeltas",
        ])
          expect(a.geometry.getAttribute(name).array).toEqual(
            b.geometry.getAttribute(name).array,
          );
        expect(a.instanceMatrix.array).toEqual(b.instanceMatrix.array);
        expect(a.userData.grassBladeGrounding.sourceIndices).toEqual(
          b.userData.grassBladeGrounding.sourceIndices,
        );
        expect(a.userData.grassBladeGrounding.sweptBounds).toEqual(
          b.userData.grassBladeGrounding.sweptBounds,
        );
      }
    } finally {
      graded.close();
      baseline.close();
    }
  });

  it("rejects grass color grade on a nonfine manager before publishing any mesh", async () => {
    const f = await fixture();
    const container = new THREE.Group();
    try {
      expect(
        () =>
          new GrassVisualManager(
            f.setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
            container,
            (node) => f.visual.getRetainedSurface(node),
            (x, z) => f.terrain["getHeightAtComputed"](x, z),
            f.setup.terrainConfig.WATER_THRESHOLD,
            (x, z) => f.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
            (x, z) => f.terrain.isGrassExcludedAt(x, z),
            (x, z, eligibility) =>
              f.terrain.getTerrainColorAt(x, z, true, eligibility),
            { ...f.setup, compactGrassColorGrade: "fine-meadow-green-v1" },
            STREAMING_GRASS_VISUAL_PROFILE,
          ),
      ).toThrow(/grade requires the explicit fine meadow/);
      expect(container.children).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("preserves the grass color grade through real synchronous fallback and grounded publication", async () => {
    const f = await fixture("fine-meadow-green-v1");
    try {
      const expected = f.owner["generateInstanceData"](f.work, 1)!;
      expect(expected.count).toBeGreaterThan(0);
      const projected = projectGrassAnchors(
        expected,
        f.visual.getRetainedSurface(f.work.node)!,
        (x, z) => f.terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
        (x, z) => f.terrain.isGrassExcludedAt(x, z),
      );
      f.owner["createChunkMesh"](f.work, 0);
      expect(f.owner["settledWorkerResults"]).toHaveLength(1);
      expect(
        f.owner["settledWorkerResults"][0].data.compactGrassColorGrade,
      ).toBe("fine-meadow-green-v1");
      expect(f.owner["settledWorkerResults"][0].data.groundColors).toEqual(
        expected.groundColors,
      );
      f.owner["processSettledWorkerResults"]();
      expect(f.finish()).toBe(1);
      const chunk = f.owner["chunks"].get(f.work.key)!;
      expect(chunk.mesh.count).toBeGreaterThan(0);
      const sourceIds: Uint32Array =
        chunk.mesh.userData.grassBladeGrounding.sourceIndices;
      expect(chunk.mesh.userData.grassBladeGrounding.inputClumps).toBe(
        projected.count,
      );
      const colors = chunk.mesh.geometry.getAttribute("instanceGroundColor");
      expect(colors.count).toBe(sourceIds.length);
      for (let i = 0; i < sourceIds.length; i++)
        expect([colors.getX(i), colors.getY(i), colors.getZ(i)]).toEqual([
          projected.groundColors[sourceIds[i] * 3],
          projected.groundColors[sourceIds[i] * 3 + 1],
          projected.groundColors[sourceIds[i] * 3 + 2],
        ]);
    } finally {
      f.close();
    }
  });

  it("maps early projection rejection before blade source indices in a real retained-grid grass color grade control", async () => {
    const f = await fixture("fine-meadow-green-v1");
    // Explicit numerical surface and input, not a claim that this flat patch is
    // deployed terrain. Both projection and blade grounding are real functions.
    const geometry = gridGeometry(20, 3, () => 20);
    try {
      const surface = new RetainedTerrainSurface(
        1,
        "numerical-projection-index-control",
        0,
        0,
        20,
        3,
        geometry,
      );
      const data: GrassAnchorData = {
        count: 4,
        offsets: new Float32Array([-6, 20, 0, -2, 20, 0, 2, 20, 0, 6, 20, 0]),
        rotScaleHash: new Float32Array([
          0, 1, 0.1, 0, 1, 0.2, 0, 1, 0.3, 0, 1, 0.4,
        ]),
        groundColors: new Float32Array([
          0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.3, 0.4, 0.5, 0.4, 0.5, 0.6,
        ]),
        grassTints: new Float32Array([
          1, 0, 0, 0.1, 0, 1, 0, 0.2, 0, 0, 1, 0.3, 1, 1, 0, 0.4,
        ]),
        groundNormals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      };
      const original = structuredClone(data);
      // Drop original 0 at water admission and original 1 at exclusion. The
      // remaining raw indices 2/3 become projected indices 0/1.
      const projected = projectGrassAnchors(
        data,
        surface,
        (x) => (x < -4 ? 20 : 0),
        (x) => x < 0,
      );
      expect(data).toEqual(original);
      expect(projected.count).toBe(2);
      expect(projected.offsets).toEqual(data.offsets.slice(6));
      expect(projected.groundColors).toEqual(data.groundColors.slice(6));
      const result = groundGrassBlades({
        data: projected,
        lod: 0,
        geometryLayout: FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        geometry: f.owner["lodGeometries"][0],
        ownSurface: surface,
        surfaces: [surface],
        terrainSurface: {
          schemaVersion: 1,
          zones: [],
          waterBodies: [],
          arenaFloorIds: [],
          arenaGradeHeight: null,
        },
        roadSegments: [],
        oceanLevel: 0,
        wind: { x: 0, z: 0 },
      });
      expect(result.status).toBe("ready");
      if (result.status !== "ready")
        throw new Error("Numerical blade control failed");
      expect(result.sourceIndices).toEqual(new Uint32Array([0, 1]));
      expect(result.data.count).toBe(2);
      for (let i = 0; i < result.data.count; i++) {
        const source = result.sourceIndices[i];
        const actual = result.data.groundColors.slice(i * 3, i * 3 + 3);
        expect(actual).toEqual(
          projected.groundColors.slice(source * 3, source * 3 + 3),
        );
        // Negative control: the earlier direct-raw-index shortcut is wrong.
        expect(actual).not.toEqual(
          data.groundColors.slice(source * 3, source * 3 + 3),
        );
      }
    } finally {
      geometry.dispose();
      f.close();
    }
  });

  it("matches real synchronous manager and emitted-worker arrays in all sixteen cells at both active tiers", async () => {
    const f = await fixture();
    try {
      for (const work of f.owner["liveWorkUnits"].values()) {
        for (const lod of [0, 1]) {
          const sync = f.owner["generateInstanceData"](
            work,
            GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
          );
          const input = f.owner["createWorkerInput"](work, work.key, lod);
          const output = await f.execute(input);
          expect(input.placementDistribution).toBe("fine-cell-stratified-v1");
          expect(output.placementDistribution).toBe(
            input.placementDistribution,
          );
          expect(output.count).toBe(sync?.count ?? 0);
          for (const name of [
            "offsets",
            "rotScaleHash",
            "groundColors",
            "grassTints",
            "groundNormals",
          ] as const)
            expect(output[name]).toEqual(sync?.[name] ?? new Float32Array());
        }
      }
    } finally {
      f.close();
    }
  });
  it("preserves real retained-surface CPU/worker parity across parent boundaries and negative cells with explicit stratified placement", async () => {
    const f = await fixture();
    try {
      const cases = [
        { centerX: 350, centerZ: 350, indexX: 15, indexZ: 14 },
        { centerX: 450, centerZ: 350, indexX: 16, indexZ: 14 },
        { centerX: -50, centerZ: 350, indexX: -1, indexZ: 14 },
        { centerX: 50, centerZ: 350, indexX: 0, indexZ: 14 },
        { centerX: -50, centerZ: -50, indexX: -1, indexZ: -1 },
      ];
      const attributes = [
        "offsets",
        "rotScaleHash",
        "groundColors",
        "grassTints",
        "groundNormals",
      ] as const;
      let positiveClumps = 0;
      for (const { centerX, centerZ, indexX, indexZ } of cases) {
        let node = f.nodes.find(
          (entry) => entry.centerX === centerX && entry.centerZ === centerZ,
        );
        if (!node) {
          node = f.tree.createNode(null, null, 100, centerX, centerZ, 4);
          f.visual["generateChunkSync"](node);
        }
        f.owner.onNodeNeedsGeometry(node);
        const work = f.owner["liveWorkUnits"].get(
          `gcell_v1_${indexX}_${indexZ}`,
        )!;
        expect(work).toBeDefined();
        expect(work.node).toBe(node);
        const surface = f.visual.getRetainedSurface(node)!;
        expect(surface).not.toBeNull();
        expect(surface.nodeId).toBe(node.id);
        let near: GrassWorkerOutput | undefined;
        for (const lod of [0, 1]) {
          const input = f.owner["createWorkerInput"](work, work.key, lod);
          expect(input.placementDistribution).toBe("fine-cell-stratified-v1");
          expect(input.placementCell).toEqual({
            schemaVersion: 1,
            size: 25,
            indexX,
            indexZ,
          });
          expect([input.centerX, input.centerZ, input.size]).toEqual([
            centerX,
            centerZ,
            100,
          ]);
          const cpu = f.owner["generateInstanceData"](
            work,
            GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
          );
          const result = await f.execute(input);
          expect(result.placementDistribution).toBe(
            input.placementDistribution,
          );
          expect(result.placementCell).toEqual(input.placementCell);
          expect(result.placementCell).not.toBe(input.placementCell);
          expect(result.count).toBe(cpu?.count ?? 0);
          expect(result.count).toBeLessThanOrEqual(1276);
          for (const key of attributes)
            expect(result[key]).toEqual(cpu?.[key] ?? new Float32Array(0));
          if (near) {
            expect(result.count).toBe(near.count);
            for (const key of attributes)
              expect(result[key]).toEqual(near[key]);
          } else near = result;
          // Negative cells use actual terrain and can genuinely be underwater.
          // Empty parity is retained; no replacement terrain/density forces grass.
          const cpuData: GrassAnchorData = cpu ?? {
            count: 0,
            offsets: new Float32Array(0),
            rotScaleHash: new Float32Array(0),
            groundColors: new Float32Array(0),
            grassTints: new Float32Array(0),
            groundNormals: new Float32Array(0),
          };
          const projectedCpu = projectGrassAnchors(
            cpuData,
            surface,
            f.owner["getWaterSurfaceAt"],
            f.owner["isInFlatZone"],
          );
          const projectedWorker = projectGrassAnchors(
            result,
            surface,
            f.owner["getWaterSurfaceAt"],
            f.owner["isInFlatZone"],
          );
          expect(projectedWorker.count).toBe(projectedCpu.count);
          for (const key of attributes)
            expect(projectedWorker[key]).toEqual(projectedCpu[key]);
          expect(projectedWorker.grounding).toEqual(projectedCpu.grounding);
          for (let i = 0; i < result.count; i++) {
            const x = centerX + result.offsets[i * 3];
            const z = centerZ + result.offsets[i * 3 + 2];
            expect(x).toBeGreaterThanOrEqual(work.bounds.minX);
            expect(x).toBeLessThan(work.bounds.maxX);
            expect(z).toBeGreaterThanOrEqual(work.bounds.minZ);
            expect(z).toBeLessThan(work.bounds.maxZ);
          }
          if (indexX >= 0 && indexZ >= 0) positiveClumps += result.count;
        }
      }
      expect(positiveClumps).toBeGreaterThan(0);
      expect(f.container.children).toHaveLength(0);
      expect(f.owner["groundingJobs"].size).toBe(0);
    } finally {
      f.close();
    }
  }, 30000);

  it("rejects absent or malformed active distribution before either nonempty or empty worker completion", async () => {
    const f = await fixture();
    try {
      const input = f.owner["createWorkerInput"](f.work, f.work.key, 0);
      const ticket = f.owner["createWorkerTicket"](
        f.work,
        f.work.key,
        0,
        false,
      );
      const populated = await f.execute(input);
      expect(populated.count).toBeGreaterThan(0);
      // A real empty worker response is a wire-admission control, not a change
      // to production ecology or an accepted empty completion for this ticket.
      const empty = await f.execute({
        ...input,
        grassConfigs: Object.fromEntries(
          Object.entries(input.grassConfigs).map(([key, config]) => [
            key,
            { ...config, density: 0 },
          ]),
        ),
      });
      expect(empty.count).toBe(0);
      for (const result of [populated, empty]) {
        expect(result.placementDistribution).toBe("fine-cell-stratified-v1");
        const missing = { ...result };
        delete missing.placementDistribution;
        for (const malformed of [
          missing,
          ...[undefined, null, false, "", "fine-cell-stratified-v2"].map(
            (value) => ({ ...result, placementDistribution: value }),
          ),
        ]) {
          expect(() =>
            f.owner["settleWorkerResult"](
              ticket,
              malformed as GrassWorkerOutput,
            ),
          ).toThrow(/placement distribution/i);
          expect(f.owner["settledWorkerResults"]).toHaveLength(0);
          expect(f.owner["completedNodes"].has(f.work.key)).toBe(false);
          expect(f.owner["groundingJobs"].size).toBe(0);
          expect(f.container.children).toHaveLength(0);
          expect(f.owner["workerInflight"].get(f.work.key)).toBe(ticket);
        }
      }
      f.owner["settleWorkerResult"](ticket, populated);
      expect(f.owner["settledWorkerResults"]).toHaveLength(1);
      expect(f.owner.getStreamingReadiness([f.node]).readyChunks).toBe(0);
    } finally {
      f.close();
    }
  });

  it("partitions one real 100m leaf into sixteen immutable deterministic cells and counts readiness per cell", async () => {
    const f = await fixture();
    try {
      const cells = [...f.owner["liveWorkUnits"].values()];
      expect(cells).toHaveLength(16);
      expect(new Set(cells.map((cell) => cell.node))).toEqual(
        new Set([f.node]),
      );
      expect(
        cells.every(
          (cell) =>
            Object.isFrozen(cell) &&
            Object.isFrozen(cell.bounds) &&
            Object.isFrozen(cell.placementCell),
        ),
      ).toBe(true);
      expect(
        cells.reduce(
          (area, cell) =>
            area +
            (cell.bounds.maxX - cell.bounds.minX) *
              (cell.bounds.maxZ - cell.bounds.minZ),
          0,
        ),
      ).toBe(10000);
      const before = f.owner.getProfileReceipt();
      expect(before.liveNodes).toBe(1);
      expect(before.placement).toEqual({
        schemaVersion: 1,
        mode: "world-cells-v1",
        cellSize: 25,
        placementDistribution: "fine-cell-stratified-v1",
        nearLodDistance: 40,
        liveCells: 16,
      });
      expect(f.owner.getStreamingReadiness([f.node], 140)).toMatchObject({
        ready: false,
        requiredChunks: 16,
        readyChunks: 0,
      });
      f.owner.onNodeNeedsGeometry(f.node);
      expect(f.owner["pendingNodes"]).toHaveLength(16);
      expect([...f.owner["liveWorkUnits"].values()]).toEqual(cells);
      const input = f.owner["createWorkerInput"](f.work, f.work.key, 0);
      expect([input.centerX, input.centerZ, input.size]).toEqual([
        350, 350, 100,
      ]);
      expect(input.placementCell).toEqual({
        schemaVersion: 1,
        size: 25,
        indexX: 15,
        indexZ: 14,
      });
      expect(input.placementCell).not.toBe(f.work.placementCell);
      expect(Object.isFrozen(input.placementCell)).toBe(true);
      const ticket = f.owner["createWorkerTicket"](
        f.work,
        f.work.key,
        0,
        false,
      );
      expect(ticket.surface).toBe(f.visual.getRetainedSurface(f.node));
      expect(
        ticket.grounding!.bounds.maxX - ticket.grounding!.bounds.minX,
      ).toBeCloseTo(25 + 2 * f.owner["groundingHalo"]);
    } finally {
      f.close();
    }
  });

  it("generates deterministic parent-local offsets and installs real LOD0 grounding and per-pass bounds", async () => {
    const f = await fixture();
    try {
      const first = f.owner["generateInstanceData"](f.work, 1)!;
      expect(first.count).toBeGreaterThan(0);
      expect(first.count).toBeLessThanOrEqual(1276);
      expect(f.owner["generateInstanceData"](f.work, 1)).toEqual(first);
      for (let i = 0; i < first.count; i++) {
        expect(first.offsets[i * 3] + f.node.centerX).toBeGreaterThanOrEqual(
          375,
        );
        expect(first.offsets[i * 3] + f.node.centerX).toBeLessThanOrEqual(400);
        expect(
          first.offsets[i * 3 + 2] + f.node.centerZ,
        ).toBeGreaterThanOrEqual(350);
        expect(first.offsets[i * 3 + 2] + f.node.centerZ).toBeLessThanOrEqual(
          375,
        );
      }
      const { output } = await f.queue();
      expect(output.count).toBeGreaterThan(0);
      expect(output.count).toBe(first.count);
      for (const name of [
        "offsets",
        "rotScaleHash",
        "groundColors",
        "grassTints",
        "groundNormals",
      ] as const)
        expect(output[name]).toEqual(first[name]);
      expect(f.owner["processSettledWorkerResults"]()).toBe(0);
      expect(f.finish()).toBe(1);
      const chunk = f.owner["chunks"].get(f.work.key)!;
      expect(chunk.node).toBe(f.node);
      expect(chunk.work).toBe(f.work);
      expect(chunk.lodLevel).toBe(0);
      expect(chunk.mesh.position.toArray()).toEqual([350, 0, 350]);
      const layout = getGrassBladeLayout(
        0,
        FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
      );
      expect(chunk.mesh.geometry.getAttribute("position").count).toBe(
        layout.verticesPerClump,
      );
      expect(chunk.mesh.geometry.index!.count / 3).toBe(
        layout.trianglesPerClump,
      );
      expect(f.owner.getProfileReceipt().geometryLayout).toBe(
        FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
      );
      expect(chunk.mesh.userData.grassBladeGrounding.geometryLayout).toBe(
        FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
      );
      expect(chunk.mesh.material.userData.grassBladeLayout).toBe(layout);
      expect(
        Object.getOwnPropertyDescriptor(
          chunk.mesh.material.userData,
          "grassBladeLayout",
        ),
      ).toMatchObject({
        writable: false,
        configurable: false,
        enumerable: true,
      });
      expect(chunk.mesh.geometry.getAttribute("grassRootDeltas").count).toBe(
        chunk.mesh.count * 24,
      );
      expect(chunk.mesh.userData.grassPlacementCell).toBe(f.work.placementCell);
      expect(chunk.mesh.userData.grassBladeGrounding).toBeDefined();
      expect(chunk.mesh.frustumCulled).toBe(true);
      expect(chunk.mesh.receiveShadow).toBe(true);
      expect(chunk.mesh.castShadow).toBe(false);
      expect(f.owner.getStreamingReadiness([f.node]).readyChunks).toBe(1);
      expect(f.owner.getProfileReceipt().grounding?.failedChunks).toBe(0);
    } finally {
      f.close();
    }
  });

  it("rejects missing or cross-cell worker identity before any empty completion", async () => {
    const f = await fixture();
    try {
      const { ticket, output } = await f.queue();
      f.owner["settledWorkerResults"].length = 0;
      const wrong: GrassWorkerOutput = {
        ...output,
        placementCell: { schemaVersion: 1, size: 25, indexX: 14, indexZ: 14 },
      };
      expect(() => f.owner["settleWorkerResult"](ticket, wrong)).toThrow(
        "placement cell mismatch",
      );
      const { placementCell: _cell, ...missing } = output;
      expect(() => f.owner["settleWorkerResult"](ticket, missing)).toThrow(
        "grass placement cell",
      );
      expect(f.owner.getStreamingReadiness([f.node]).readyChunks).toBe(0);
      expect(f.container.children).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("uses actual camera world position and 36/44m hysteresis, with hero fallback for transformed parents", async () => {
    const f = await fixture();
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      f.finish();
      const group = new THREE.Group(),
        camera = new THREE.PerspectiveCamera();
      group.position.set(300, 0, 350);
      group.add(camera);
      camera.position.set(144, 40, 12.5);
      camera.lookAt(0, 0, -1);
      group.updateMatrixWorld(true);
      // Exact world x444 is44m beyond the cell's far edge, not local x144.
      f.owner["pendingNodes"].length = 0;
      f.owner.update(385, 374, camera);
      expect(f.owner["lodFocusX"]).toBe(444);
      expect(f.owner["desiredLod"](f.work)).toBe(0);
      f.owner["lodFocusX"] = 444.01;
      expect(f.owner["desiredLod"](f.work)).toBe(1);
      f.owner["pendingLodSwap"].set(f.work.key, {
        node: f.node,
        work: f.work,
        desiredLod: 1,
      });
      await f.queue(1, true);
      while (f.owner["settledWorkerResults"].length)
        f.owner["processSettledWorkerResults"]();
      f.finish();
      expect(f.owner["chunks"].get(f.work.key)!.lodLevel).toBe(1);
      expect(
        f.owner["chunks"]
          .get(f.work.key)!
          .mesh.geometry.getAttribute("position").count,
      ).toBe(60);
      f.owner["lodFocusX"] = 436;
      expect(f.owner["desiredLod"](f.work)).toBe(1);
      f.owner["lodFocusX"] = 435.99;
      expect(f.owner["desiredLod"](f.work)).toBe(0);
      f.owner["lodFocusX"] = 1000;
      f.container.position.x = 1;
      f.container.updateMatrixWorld(true);
      expect(f.owner["desiredLod"](f.work)).toBe(0);
    } finally {
      f.close();
    }
  });

  it("cancels a running opposite-LOD grounding job before it can replace a still-correct mesh", async () => {
    const f = await fixture();
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      f.finish();
      const original = f.owner["chunks"].get(f.work.key)!.mesh;
      f.owner["lodFocusX"] = 450;
      f.owner["lodFocusZ"] = 362.5;
      f.owner["pendingLodSwap"].set(f.work.key, {
        node: f.node,
        work: f.work,
        desiredLod: 1,
      });
      await f.queue(1, true);
      f.owner["processSettledWorkerResults"]();
      const job = f.owner["groundingJobs"].get(f.work.key)!.job;
      expect(job.state.status).toBe("running");
      f.owner["lodFocusX"] = 385;
      f.owner["cancelObsoleteLodWork"]();
      expect(job.state.status).toBe("cancelled");
      expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
      expect(f.owner["advanceGroundingJob"]()).toBe(0);
      expect(f.owner["chunks"].get(f.work.key)!.mesh).toBe(original);
    } finally {
      f.close();
    }
  });

  it("retires every child on parent replacement and ignores late old-parent teardown/results", async () => {
    const f = await fixture();
    try {
      const { ticket, output } = await f.queue();
      const replacement = f.tree.createNode(null, null, 100, 350, 350, 4);
      f.visual["generateChunkSync"](replacement);
      // Registration may precede the old leaf's destruction callback. Spatial
      // cell ownership replaces the old parent atomically without a fake node.
      f.owner.onNodeNeedsGeometry(replacement);
      const current = f.owner["liveWorkUnits"].get(f.work.key)!;
      expect(current).not.toBe(f.work);
      expect(current.node).toBe(replacement);
      const next = f.owner["createWorkerTicket"](
        current,
        current.key,
        0,
        false,
      );
      f.owner.onNodeDestroyGeometry(f.node);
      f.owner["settleWorkerResult"](ticket, output);
      expect(f.owner["workerInflight"].get(current.key)).toBe(next);
      expect(f.owner["liveWorkUnits"].size).toBe(16);
      expect(f.owner["liveNodes"].size).toBe(1);
      f.owner.onNodeDestroyGeometry(replacement);
      expect(f.owner["liveWorkUnits"].size).toBe(0);
      expect(f.owner["workerInflight"].size).toBe(0);
      expect(f.owner["pendingNodes"]).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("invalidates only intersecting child halos and rebuilds without duplicate children", async () => {
    const f = await fixture();
    try {
      const works = [...f.owner["liveWorkUnits"].values()];
      const tickets = works.map((work) =>
        f.owner["createWorkerTicket"](work, work.key, 0, false),
      );
      f.owner.invalidateRegion(386, 361, 387, 362);
      expect(f.owner["workerInflight"].size).toBe(15);
      expect(f.owner["workerInflight"].has(f.work.key)).toBe(false);
      for (const ticket of tickets.filter((entry) => entry.key !== f.work.key))
        expect(f.owner["workerInflight"].get(ticket.key)).toBe(ticket);
      f.owner.rebuildAllChunks();
      f.owner.rebuildAllChunks();
      expect(f.owner["pendingNodes"]).toHaveLength(16);
      expect(
        new Set(f.owner["pendingNodes"].map((entry) => entry.work!.key)).size,
      ).toBe(16);
      expect(f.owner["workerInflight"].size).toBe(0);
      expect(f.visual.getRetainedSurface(f.node)).not.toBeNull();
    } finally {
      f.close();
    }
  });

  it("precompiles the actual fine LOD0 storage layout and disposes only its private sample", async () => {
    const f = await fixture();
    try {
      const surface = f.visual.getRetainedSurface(f.node);
      let observed = false;
      await f.owner.precompileRepresentativeChunk(async (object) => {
        expect(object).toBeInstanceOf(THREE.InstancedMesh);
        const mesh = object as THREE.InstancedMesh;
        const layout = getGrassBladeLayout(
          0,
          FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
        );
        expect(mesh.geometry.getAttribute("position").count).toBe(
          layout.verticesPerClump,
        );
        expect(
          (mesh.material as THREE.Material).userData.grassBladeLayout,
        ).toBe(layout);
        expect(mesh.geometry.getAttribute("grassRootDeltas").count).toBe(24);
        observed = true;
      });
      expect(observed).toBe(true);
      expect(f.visual.getRetainedSurface(f.node)).toBe(surface);
      expect(f.container.children).toHaveLength(0);
      const misaligned = f.tree.createNode(null, null, 100, 351, 350, 4);
      expect(() => f.owner.onNodeNeedsGeometry(misaligned)).toThrow(
        "aligned 25m cells",
      );
    } finally {
      f.close();
    }
  });

  it("rejects a retired terrain surface before grounding publication and renews the exact affected owner", async () => {
    const f = await fixture();
    try {
      const { ticket } = await f.queue();
      f.owner["processSettledWorkerResults"]();
      const job = f.owner["groundingJobs"].get(f.work.key)!.job;
      f.visual["generateChunkSync"](f.node);
      expect(f.visual.getRetainedSurface(f.node)).not.toBe(ticket.surface);
      f.owner["reconcileGrassHorizon"]();
      expect(job.state.status).toBe("cancelled");
      expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
      expect(f.owner["advanceGroundingJob"]()).toBe(0);
      expect(f.owner.getStreamingReadiness([f.node]).readyChunks).toBe(0);
      expect(f.container.children).toHaveLength(0);
      const next = f.owner["createWorkerTicket"](f.work, f.work.key, 0, false);
      expect(next.surface).toBe(f.visual.getRetainedSurface(f.node));
    } finally {
      f.close();
    }
  });

  it("keeps a single manager-wide grounding and upload allowance across multiple cells", async () => {
    const f = await fixture();
    try {
      const second = f.owner["liveWorkUnits"].get("gcell_v1_14_14")!;
      await f.queue();
      await f.queue(0, false, second);
      expect(f.owner["settledWorkerResults"]).toHaveLength(2);
      expect(f.owner["processSettledWorkerResults"]()).toBe(0);
      expect(f.owner["groundingJobs"].size).toBe(1);
      expect(f.owner["settledWorkerResults"]).toHaveLength(1);
      expect(f.owner["processSettledWorkerResults"]()).toBe(0);
      expect(f.owner["groundingJobs"].size).toBe(2);
      const jobs = [...f.owner["groundingJobs"].values()];
      f.owner["advanceGroundingJob"]();
      expect(jobs[0].job.operations).toBeGreaterThan(0);
      expect(jobs[1].job.operations).toBe(0);
      let frames = 0;
      while (f.owner["groundingJobs"].size && frames++ < 1000)
        expect(f.owner["advanceGroundingJob"]()).toBeLessThanOrEqual(1);
      expect(frames).toBeLessThan(1000);
      expect(f.owner.getProfileReceipt().grounding?.failedChunks).toBe(0);
      expect(f.owner["chunks"].size).toBe(2);
    } finally {
      f.close();
    }
  });

  it("waits for genuine neighboring retained support and resumes only after its lease is renewed", async () => {
    const f = await fixture();
    try {
      const east = f.nodes.find(
        (node) => node.centerX === 450 && node.centerZ === 350,
      )!;
      f.visual.onNodeDestroyGeometry(east);
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      expect(f.finish()).toBe(0);
      const entry = f.owner["groundingJobs"].get(f.work.key)!;
      expect(entry.job.state.status).toBe("waiting_support");
      expect(f.owner.getStreamingReadiness([f.node]).readyChunks).toBe(0);
      expect(f.container.children).toHaveLength(0);
      f.visual["generateChunkSync"](east);
      expect(entry.region!.isCurrent()).toBe(false);
      f.owner["reconcileGrassHorizon"]();
      expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      expect(f.finish()).toBe(1);
      expect(f.owner.getStreamingReadiness([f.node]).readyChunks).toBe(1);
    } finally {
      f.close();
    }
  });

  it("captures the actual primary render pose without executing or allocating grass work, then consumes its detached frustum", async () => {
    const f = await fixture();
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      f.finish();
      const parent = new THREE.Group(),
        camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 500);
      parent.position.set(300, 0, 300);
      parent.add(camera);
      camera.position.set(33, 45, 31);
      camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
      Reflect.set(camera, "_reversedDepth", true);
      camera.updateProjectionMatrix();
      camera.lookAt(387.5, 28, 362.5);
      // The parent and child are deliberately not refreshed after this move.
      parent.position.x = 301;
      const projection = camera.projectionMatrix.clone();
      const before = f.owner.getProfileReceipt();
      const mesh = f.owner["chunks"].get(f.work.key)!.mesh;
      const geometry = mesh.geometry,
        material = mesh.material;
      const cacheMatrix = f.owner["primaryViewProjection"],
        cacheFrustum = f.owner["primaryViewFrustum"];
      const oldFocus = f.owner["lodFocusX"];
      f.terrain["grassVisualManager"] = f.owner;
      f.terrain.prepareGrassForRender(camera);
      expect(f.owner["primaryViewX"]).toBe(334);
      expect(f.owner["primaryViewZ"]).toBe(331);
      expect(f.owner["primaryViewValid"]).toBe(true);
      expect(f.owner["lodFocusX"]).toBe(oldFocus); // next-update contract
      expect(f.owner.getProfileReceipt()).toEqual(before);
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(material);
      expect(camera.projectionMatrix).toEqual(projection);
      const expected = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        ),
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      expect(
        expected.intersectsBox(f.owner["chunks"].get(f.work.key)!.box),
      ).toBe(true);
      // Reusing this same camera object simulates the director's early pose.
      parent.position.set(0, 0, 0);
      camera.position.set(391, 45, 377);
      camera.lookAt(500, 45, 500);
      parent.updateMatrixWorld(true);
      const transient = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        ),
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      expect(
        transient.intersectsBox(f.owner["chunks"].get(f.work.key)!.box),
      ).toBe(false);
      f.owner.update(385, 374, camera);
      expect([f.owner["lodFocusX"], f.owner["lodFocusZ"]]).toEqual([334, 331]);
      expect(f.owner["desiredLod"](f.work)).toBe(1);
      expect(f.owner["frustum"].planes).toEqual(expected.planes);
      expect(f.owner["primaryViewProjection"]).toBe(cacheMatrix);
      expect(f.owner["primaryViewFrustum"]).toBe(cacheFrustum);
      expect([f.owner["playerX"], f.owner["playerZ"]]).toEqual([385, 374]);
      expect(f.owner["playerPosUniform"].value.toArray()).toEqual([
        385, 0, 374,
      ]);
    } finally {
      f.close();
    }
  });

  it("cancels obsolete grounding only on the next update after a final-view camera cut", async () => {
    const f = await fixture();
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      const job = f.owner["groundingJobs"].get(f.work.key)!.job;
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 500);
      camera.position.set(333, 45, 331);
      camera.lookAt(387.5, 28, 362.5);
      f.owner.capturePrimaryView(camera);
      expect(job.state.status).toBe("running");
      expect(job.operations).toBe(0);
      camera.position.set(391, 45, 377);
      camera.updateMatrixWorld();
      f.owner.update(385, 374, camera);
      expect(job.state.status).toBe("cancelled");
      expect(f.owner["getLodLevel"](f.work)).toBe(1);
      expect(f.owner["chunks"].has(f.work.key)).toBe(false);
    } finally {
      f.close();
    }
  });

  it("invokes the real Terrain forwarding hook before ClientGraphics reaches the unavailable renderer", async () => {
    const f = await fixture();
    try {
      f.terrain["grassVisualManager"] = f.owner;
      f.world.camera.position.set(333, 45, 331);
      f.world.camera.lookAt(387.5, 28, 362.5);
      const graphics = new ClientGraphics(f.world);
      // No fake renderer/browser/GPU: this deliberately unstarted graphics
      // object can only execute its real CPU-side primary-view preparation.
      expect(() => graphics.render()).toThrow(TypeError);
      expect(f.owner["hasPrimaryView"]).toBe(true);
      expect([f.owner["primaryViewX"], f.owner["primaryViewZ"]]).toEqual([
        333, 331,
      ]);
      expect(f.owner["workerInflight"].size).toBe(0);
      expect(f.owner["groundingJobs"].size).toBe(0);
      expect(f.container.children).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("fails an invalid primary projection to hero and ignores captures after disposal", async () => {
    const f = await fixture();
    try {
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(1000, 40, 1000);
      camera.projectionMatrix.elements.fill(0);
      f.owner.capturePrimaryView(camera);
      expect(f.owner["primaryViewValid"]).toBe(false);
      f.owner.update(385, 374);
      expect(f.owner["getLodLevel"](f.work)).toBe(0);
      f.owner.destroy();
      const x = f.owner["primaryViewX"];
      camera.position.x = 2000;
      f.owner.capturePrimaryView(camera);
      expect(f.owner["primaryViewX"]).toBe(x);
    } finally {
      f.close();
    }
  });

  it("leaves legacy camera ownership and CPU/worker placement untouched without a distribution marker", async () => {
    const f = await fixture();
    const legacy = new GrassVisualManager(
      f.setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
      new THREE.Group(),
      (node) => f.visual.getRetainedSurface(node),
      (x, z) => f.terrain["getHeightAtComputed"](x, z),
      f.setup.terrainConfig.WATER_THRESHOLD,
      (x, z) => f.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
      (x, z) => f.terrain.isGrassExcludedAt(x, z),
      (x, z, eligibility) =>
        f.terrain.getTerrainColorAt(x, z, true, eligibility),
      f.setup,
      STREAMING_GRASS_VISUAL_PROFILE,
    );
    try {
      const camera = new THREE.PerspectiveCamera();
      const matrix = camera.matrixWorld.clone();
      camera.position.set(500, 40, 500); // deliberately dirty
      const before = legacy.getProfileReceipt();
      legacy.capturePrimaryView(camera);
      expect(legacy["hasPrimaryView"]).toBe(false);
      expect(camera.matrixWorld).toEqual(matrix);
      expect(legacy.getProfileReceipt()).toEqual(before);
      expect(before.placement).toBeUndefined();
      legacy.setPlayerPosition(385, 374);
      legacy.onNodeNeedsGeometry(f.node);
      const work = [...legacy["liveWorkUnits"].values()][0];
      expect(work.node).toBe(f.node);
      expect(work.placementCell).toBeUndefined();
      for (const lod of [0, 1]) {
        const input = legacy["createWorkerInput"](work, work.key, lod);
        expect(Object.hasOwn(input, "placementDistribution")).toBe(false);
        expect(Object.hasOwn(input, "placementCell")).toBe(false);
        const cpu = legacy["generateInstanceData"](
          work,
          GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
        );
        const output = await f.execute(input);
        expect(Object.hasOwn(output, "placementDistribution")).toBe(false);
        expect(Object.hasOwn(output, "placementCell")).toBe(false);
        expect(output.count).toBe(cpu?.count ?? 0);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundColors",
          "grassTints",
          "groundNormals",
        ] as const)
          expect(output[key]).toEqual(cpu?.[key] ?? new Float32Array(0));
        const ticket = legacy["createWorkerTicket"](work, work.key, lod, false);
        for (const value of [undefined, "fine-cell-stratified-v1", ""])
          expect(() =>
            legacy["settleWorkerResult"](ticket, {
              ...output,
              placementDistribution: value,
            } as GrassWorkerOutput),
          ).toThrow(/placement distribution/i);
        expect(legacy["settledWorkerResults"]).toHaveLength(0);
        expect(legacy["completedNodes"].size).toBe(0);
        legacy["settleWorkerResult"](ticket, output);
        expect(legacy["settledWorkerResults"]).toHaveLength(1);
        legacy["settledWorkerResults"].length = 0;
      }
    } finally {
      legacy.destroy();
      f.close();
    }
  });

  it("retires a budget-deferred orphan LOD intent after a primary camera cut outside its frustum", async () => {
    const f = await fixture();
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      f.finish();
      const original = f.owner["chunks"].get(f.work.key)!.mesh;
      // Genuine scheduler state between publishing an intent and acquiring its
      // one-per-update worker slot. No worker/job owns this deferred request.
      f.owner["pendingLodSwap"].set(f.work.key, {
        node: f.node,
        work: f.work,
        desiredLod: 1,
      });
      expect(f.owner["workerInflight"].has(f.work.key)).toBe(false);
      expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 500);
      camera.position.set(391, 45, 377);
      camera.lookAt(500, 45, 500);
      f.owner.capturePrimaryView(camera);
      expect(
        f.owner["primaryViewFrustum"].intersectsBox(
          f.owner["chunks"].get(f.work.key)!.box,
        ),
      ).toBe(false);
      f.owner.update(385, 374, camera);
      expect(f.owner["pendingLodSwap"].has(f.work.key)).toBe(false);
      expect(f.owner["chunks"].get(f.work.key)!.mesh).toBe(original);
      for (let frame = 0; frame < 3; frame++) {
        f.owner.capturePrimaryView(camera);
        f.owner.update(385, 374, camera);
        expect(f.owner["pendingLodSwap"].has(f.work.key)).toBe(false);
      }
    } finally {
      f.close();
    }
  });

  it("retains a valid fine LOD intent while its actual grounding job still owns publication", async () => {
    const f = await fixture();
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      f.finish();
      f.owner["lodFocusX"] = 450;
      f.owner["lodFocusZ"] = 362.5;
      f.owner["pendingLodSwap"].set(f.work.key, {
        node: f.node,
        work: f.work,
        desiredLod: 1,
      });
      await f.queue(1, true);
      f.owner["processSettledWorkerResults"]();
      const entry = f.owner["groundingJobs"].get(f.work.key)!;
      f.owner["cancelObsoleteLodWork"]();
      expect(f.owner["pendingLodSwap"].get(f.work.key)?.desiredLod).toBe(1);
      expect(f.owner["groundingJobs"].get(f.work.key)).toBe(entry);
      expect(f.finish()).toBe(1);
      expect(f.owner["pendingLodSwap"].has(f.work.key)).toBe(false);
      expect(f.owner["chunks"].get(f.work.key)!.lodLevel).toBe(1);
    } finally {
      f.close();
    }
  });
});
