import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { INSTANCE_MATRIX_STORAGE_ATTRIBUTE } from "../../../../utils/rendering/createStorageInstancedMesh";
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
import {
  groundGrassBlades,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
} from "../GrassBladeGrounding";
import { prepareGroundedGrassSteps } from "../GrassGroundingPipeline";
import { GrassGroundingWorkerJob } from "../GrassGroundingWorkerCoordinator";
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
  createClumpGeometry,
  FINE_GRASS_ROOTED_FAN_COMPOSITION,
  FINE_GRASS_ROOTED_FAN_SHAPE,
  FINE_GRASS_MEADOW_CANOPY_COMPOSITION,
  FINE_GRASS_MEADOW_CANOPY_SHAPE,
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
  STREAMING_GRASS_VISUAL_PROFILE,
  GrassVisualManager,
} from "../GrassVisualManager";
import { getGrassBladeLayout } from "../GrassBladeLayout";
import type { GrassGeometryCandidate } from "../../../../runtime/clientViewportMode";
import type { GrassPlacementCoverageTrial } from "../../../../utils/workers/GrassPlacementCell";
import type { GrassGroundingWorkerPort } from "../../../../utils/workers/GrassGroundingWorkerClient";
import { ActualGrassGroundingClientPort } from "./fixtures/ActualGrassGroundingClientPort";
import { bundleGrassGroundingWorker } from "./fixtures/GrassGroundingWorkerHarness";

/** Actual World terrain, road constraints, retained geometry, placement and
 * grounding pipeline. Test orchestration does not replace manager methods. */
async function fixture(
  grade?: CompactGrassColorGrade,
  coverageTrial?: GrassPlacementCoverageTrial,
  resolution = 16,
  groundingPort?: GrassGroundingWorkerPort,
  lightingCandidate?: "leaf-volume-v1",
  geometryCandidate?: GrassGeometryCandidate,
  roadClearance?: "per-blade-v1",
) {
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
  const setupDisposals: (() => void)[] = [];
  try {
    await DataManager.getInstance().initialize();
    const world = new World();
    setupDisposals.push(() => world.destroy());
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const roads = world.register(
      "roads",
      RoadNetworkSystem,
    ) as RoadNetworkSystem;
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
    setupDisposals.push(() => material.dispose());
    const visual = new TerrainVisualManager(
      { minSize: 100, maxDepth: 4, resolution, rootChunkRadius: 0 },
      terrain["buildChunkTerrainProvider"](),
      new THREE.Group(),
      material,
      setup.terrainConfig,
      setup.seed,
      setup.biomeCenters,
      setup.biomes,
    );
    setupDisposals.push(() => visual.dispose());
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
      (x, z) => terrain["isGrassExcludedAt"](x, z),
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
            roadInfluence: terrain["calculateRoadInfluenceAtVertex"](
              x,
              z,
              0,
              0,
            ),
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
      {
        ...FINE_MEADOW_GRASS_VISUAL_PROFILE,
        ...(coverageTrial ? { coverageTrial } : {}),
        ...(roadClearance ? { roadClearance } : {}),
      },
      undefined,
      (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
      (bounds) => visual.captureRetainedSurfaceRegion(bounds),
      "fine-meadow-v1",
      undefined,
      lightingCandidate,
      groundingPort
        ? {
            mode: "worker-v1",
            createPort: () => groundingPort,
            isSurfaceCurrent: (surface) =>
              visual.isRetainedSurfaceCurrent(surface),
          }
        : undefined,
      geometryCandidate,
    );
    setupDisposals.push(() => owner.destroy());
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
  } catch (error) {
    // A rejected async setup cannot return its close method to the caller.
    // Release every resource already created, including the placement worker.
    const cleanupErrors: unknown[] = [];
    for (const dispose of setupDisposals.reverse()) {
      try {
        dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await worker.terminate();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length)
      throw new Error([String(error), ...cleanupErrors.map(String)].join("\n"));
    throw error;
  }
}

describe("fine meadow cells borrow actual terrain owners without replacing them", () => {
  it.each([
    {
      selection: "rooted-fan-v1",
      composition: FINE_GRASS_ROOTED_FAN_COMPOSITION,
      shape: FINE_GRASS_ROOTED_FAN_SHAPE,
    },
    {
      selection: "meadow-canopy-v1",
      composition: FINE_GRASS_MEADOW_CANOPY_COMPOSITION,
      shape: FINE_GRASS_MEADOW_CANOPY_SHAPE,
    },
  ] as const)(
    "publishes explicit $selection at all three tiers with unchanged sheath placement inputs",
    async ({ selection, composition, shape }) => {
      const baseline = await fixture(
        undefined,
        undefined,
        16,
        undefined,
        "leaf-volume-v1",
        "sheath-close-v1",
        "per-blade-v1",
      );
      let candidate: Awaited<ReturnType<typeof fixture>> | undefined;
      try {
        candidate = await fixture(
          undefined,
          undefined,
          16,
          undefined,
          "leaf-volume-v1",
          selection,
          "per-blade-v1",
        );
        const owner = candidate.owner;
        expect(owner.getProfileReceipt()).toMatchObject({
          geometryCandidate: selection,
          geometryLayout: "fine-folded-sheath-near5-v1",
          clumpSpacing: 0.7,
          clumpSpacingMultiplier: 1,
          maxRenderDistance: 140,
          placement: {
            cellSize: 25,
            nearLodDistance: 40,
            detailLodDistance: 12,
          },
        });
        expect(baseline.owner.getProfileReceipt().geometryCandidate).toBe(
          "sheath-close-v1",
        );
        const warmed: number[] = [];
        let sampleGeometryDisposals = 0;
        let sampleMaterialDisposals = 0;
        let sourceGeometryDisposals = 0;
        for (const source of owner["lodGeometries"])
          source.addEventListener("dispose", () => sourceGeometryDisposals++);
        await owner.precompileRepresentativeChunk(async (object) => {
          if (!(object instanceof THREE.InstancedMesh))
            throw new Error("Actual composed-grass warmup mesh required");
          const material = object.material;
          if (Array.isArray(material))
            throw new Error("Single actual warmup material required");
          const lod = warmed.length;
          const source = owner["lodGeometries"][lod];
          warmed.push(object.geometry.getAttribute("position").count);
          for (const name of ["position", "normal", "uv"])
            expect(object.geometry.getAttribute(name).array).toEqual(
              source.getAttribute(name).array,
            );
          expect(object.geometry.index?.array).toEqual(source.index?.array);
          expect(object.geometry.userData.grassRootComposition).toEqual(
            composition,
          );
          expect(material.userData.grassBladeLayout).toBe(
            getGrassBladeLayout(lod, "fine-folded-sheath-near5-v1"),
          );
          object.geometry.addEventListener(
            "dispose",
            () => sampleGeometryDisposals++,
          );
          material.addEventListener("dispose", () => sampleMaterialDisposals++);
        });
        // Actual owned sample construction/disposal, not native GPU compilation.
        expect(warmed).toEqual([360, 216, 60]);
        expect(sampleGeometryDisposals).toBe(3);
        expect(sampleMaterialDisposals).toBe(3);
        expect(sourceGeometryDisposals).toBe(0);
        expect(Object.isFrozen(shape)).toBe(true);
        for (const key of Object.keys(composition))
          expect(
            Object.getOwnPropertyDescriptor(composition, key),
          ).toMatchObject({
            writable: false,
            configurable: false,
          });
        if ("heightFactors" in composition)
          for (const factors of [
            composition.heightFactors,
            composition.widthFactors,
            composition.arcFactors,
          ])
            expect(Object.isFrozen(factors)).toBe(true);
        const baselineInput = baseline.owner["createWorkerInput"](
          baseline.work,
          baseline.work.key,
          0,
        );
        const baselineOutput = await baseline.execute(baselineInput);
        expect(baselineOutput.count).toBeGreaterThan(0);
        for (const lod of [0, 1, 2] as const) {
          const descriptor = getGrassBladeLayout(
            lod,
            "fine-folded-sheath-near5-v1",
          );
          const expected = createClumpGeometry(
            descriptor.bladesPerClump,
            descriptor.bladeSegments,
            shape,
            lod === 0
              ? "folded-sheath-v1"
              : lod === 1
                ? "folded-lancet-v1"
                : undefined,
          );
          try {
            const source = owner["lodGeometries"][lod];
            const previous = baseline.owner["lodGeometries"][lod];
            expect(source.userData.grassRootComposition).toBe(composition);
            expect(
              Object.getOwnPropertyDescriptor(
                source.userData,
                "grassRootComposition",
              ),
            ).toEqual({
              value: composition,
              enumerable: true,
              configurable: false,
              writable: false,
            });
            expect(Object.isFrozen(source.userData.grassRootComposition)).toBe(
              true,
            );
            expect(previous.userData).not.toHaveProperty(
              "grassRootComposition",
            );
            for (const name of ["position", "normal", "uv"])
              expect(
                source.getAttribute(name).array,
                `LOD${lod} ${name}`,
              ).toEqual(expected.getAttribute(name).array);
            if (!source.index || !previous.index || !expected.index)
              throw new Error(
                "Actual indexed composed-grass/sheath templates required",
              );
            expect(source.index.array).toEqual(expected.index.array);
            expect(source.index.array).toEqual(previous.index.array);
            expect(source.getAttribute("uv").array).toEqual(
              previous.getAttribute("uv").array,
            );
            expect(source.getAttribute("position").array).not.toEqual(
              previous.getAttribute("position").array,
            );
            expect(source.getAttribute("position").count).toBe(
              descriptor.verticesPerClump,
            );
            expect(source.index.count / 3).toBe(descriptor.trianglesPerClump);
            const input = owner["createWorkerInput"](
              candidate.work,
              candidate.work.key,
              lod,
            );
            expect(input).toEqual(baselineInput);
            expect(input).not.toHaveProperty("geometryCandidate");
            expect(input).not.toHaveProperty("grassRootComposition");
            owner["lodFocusX"] = candidate.work.bounds.maxX + [0, 20, 60][lod];
            owner["lodFocusZ"] =
              (candidate.work.bounds.minZ + candidate.work.bounds.maxZ) / 2;
            if (lod)
              owner["pendingLodSwap"].set(candidate.work.key, {
                node: candidate.node,
                work: candidate.work,
                desiredLod: lod,
              });
            const queued = await candidate.queue(lod, lod !== 0);
            expect(queued.input).toEqual(baselineInput);
            expect(queued.output).toEqual(baselineOutput);
            owner["processSettledWorkerResults"]();
            expect(candidate.finish()).toBe(1);
            const chunk = owner["chunks"].get(candidate.work.key);
            if (!chunk)
              throw new Error("Grounded composed-grass publication required");
            expect(chunk.lodLevel).toBe(lod);
            expect(chunk.mesh.count).toBeGreaterThan(0);
            for (const name of ["position", "normal", "uv"])
              expect(chunk.mesh.geometry.getAttribute(name).array).toEqual(
                expected.getAttribute(name).array,
              );
            expect(chunk.mesh.geometry.index?.array).toEqual(
              expected.index.array,
            );
            expect(chunk.mesh.geometry.userData.grassRootComposition).toEqual(
              composition,
            );
            const roots = chunk.mesh.geometry.getAttribute("grassRootDeltas");
            expect(roots.itemSize).toBe(2);
            expect(roots.count).toBe(
              chunk.mesh.count * descriptor.bladesPerClump,
            );
            expect(Array.from(roots.array).every(Number.isFinite)).toBe(true);
            const masks = chunk.mesh.geometry.getAttribute(
              "grassBladeVisibility",
            );
            expect(masks.count).toBe(chunk.mesh.count);
            if (!(masks.array instanceof Uint32Array))
              throw new Error(
                "Actual composed-grass Uint32 visibility masks required",
              );
            let visibleBlades = 0;
            for (const mask of masks.array) {
              expect(mask).toBeGreaterThan(0);
              expect(mask).toBeLessThan(2 ** descriptor.bladesPerClump);
              for (let bits = mask; bits; bits &= bits - 1) visibleBlades++;
            }
            const admission = chunk.mesh.userData.grassBladeGrounding;
            expect(admission.geometryLayout).toBe(
              "fine-folded-sheath-near5-v1",
            );
            expect(admission.roadClearance.retainedBlades).toBe(visibleBlades);
            const sourceIndices = admission.sourceIndices;
            if (!(sourceIndices instanceof Uint32Array))
              throw new Error(
                "Actual composed-grass accepted source indices required",
              );
            expect(sourceIndices.length).toBe(chunk.mesh.count);
            expect(
              sourceIndices.every((index) => index < queued.output.count),
            ).toBe(true);
            const material = chunk.mesh.material;
            if (Array.isArray(material))
              throw new Error(
                "Single actual grounded composed-grass material required",
              );
            expect(material.userData.grassBladeLayout).toBe(descriptor);
            expect(material.userData.fineGrassCanopyLighting.normalSource).toBe(
              lod < 2 ? "geometry-fold" : undefined,
            );
            const retained = owner["completedGrounding"].get(
              candidate.work.key,
            );
            if (!retained)
              throw new Error(
                "Current composed-grass grounding lease required",
              );
            expect(retained.region.isCurrent()).toBe(true);
            expect(retained.inputs.isCurrent()).toBe(true);
            expect(owner.getProfileReceipt()).toMatchObject({
              geometryCandidate: selection,
              geometryLayout: "fine-folded-sheath-near5-v1",
              grounding: { failedChunks: 0 },
            });
            // Root composition changes blade envelopes. Do not demand identical
            // final acceptance or masks merely because the placement inputs match.
          } finally {
            expected.dispose();
          }
        }
      } finally {
        candidate?.close();
        baseline.close();
      }
    },
  );

  it.each(["rooted-fan-v1", "meadow-canopy-v1", "meadow-field-v1"] as const)(
    "rejects composed grass without the explicit leaf-volume selection: %s",
    async (selection) => {
      let unexpected: Awaited<ReturnType<typeof fixture>> | undefined;
      try {
        await expect(
          fixture(
            undefined,
            undefined,
            16,
            undefined,
            undefined,
            selection,
          ).then((value) => {
            unexpected = value;
            return value;
          }),
        ).rejects.toThrow(
          "Grass geometry requires the explicit leaf-volume fine meadow",
        );
      } finally {
        unexpected?.close();
      }
    },
  );

  it("preserves full placement and old distant templates while publishing all three close-detail tiers", async () => {
    const baseline = await fixture(
      undefined,
      undefined,
      16,
      undefined,
      "leaf-volume-v1",
    );
    const candidate = await fixture(
      undefined,
      undefined,
      16,
      undefined,
      "leaf-volume-v1",
      "sheath-close-v1",
    );
    try {
      const owner = candidate.owner;
      expect(owner.getProfileReceipt()).toMatchObject({
        geometryLayout: "fine-folded-sheath-near5-v1",
        clumpSpacing: 0.7,
        maxRenderDistance: 140,
        placement: { cellSize: 25, nearLodDistance: 40, detailLodDistance: 12 },
      });
      expect(
        baseline.owner.getProfileReceipt().placement?.detailLodDistance,
      ).toBeUndefined();
      const warmed: number[] = [];
      let disposedGeometry = 0;
      let disposedMaterial = 0;
      await owner.precompileRepresentativeChunk(async (object) => {
        expect(object).toBeInstanceOf(THREE.InstancedMesh);
        const mesh = object as THREE.InstancedMesh;
        const material = mesh.material;
        if (Array.isArray(material))
          throw new Error("One warmup material required");
        const lod = warmed.length;
        warmed.push(mesh.geometry.getAttribute("position").count);
        expect(material.userData.grassBladeLayout).toBe(
          getGrassBladeLayout(lod, "fine-folded-sheath-near5-v1"),
        );
        expect(material.userData.fineGrassCanopyLighting.normalSource).toBe(
          lod < 2 ? "geometry-fold" : undefined,
        );
        mesh.geometry.addEventListener("dispose", () => disposedGeometry++);
        material.addEventListener("dispose", () => disposedMaterial++);
      });
      // This verifies actual warmup object lifecycle, not a native compilation.
      expect(warmed).toEqual([360, 216, 60]);
      expect(disposedGeometry).toBe(3);
      expect(disposedMaterial).toBe(3);
      for (const [candidateLod, oldLod] of [
        [1, 0],
        [2, 1],
      ]) {
        const a = owner["lodGeometries"][candidateLod],
          b = baseline.owner["lodGeometries"][oldLod];
        for (const key of ["position", "normal", "uv"])
          expect(a.getAttribute(key).array).toEqual(b.getAttribute(key).array);
        expect(a.index!.array).toEqual(b.index!.array);
      }
      const inputs = [0, 1, 2].map((lod) =>
        owner["createWorkerInput"](candidate.work, candidate.work.key, lod),
      );
      expect(inputs[0].spacingMul).toBe(1);
      expect(inputs[1]).toEqual(inputs[0]);
      expect(inputs[2]).toEqual(inputs[0]);
      let firstOutput: GrassWorkerOutput | undefined;
      for (const lod of [0, 1, 2] as const) {
        owner["lodFocusX"] = candidate.work.bounds.maxX + [0, 20, 60][lod];
        owner["lodFocusZ"] =
          (candidate.work.bounds.minZ + candidate.work.bounds.maxZ) / 2;
        if (lod)
          owner["pendingLodSwap"].set(candidate.work.key, {
            node: candidate.node,
            work: candidate.work,
            desiredLod: lod,
          });
        const queued = await candidate.queue(lod, lod !== 0);
        if (firstOutput)
          for (const key of [
            "offsets",
            "rotScaleHash",
            "groundColors",
            "grassTints",
            "groundNormals",
          ] as const)
            expect(queued.output[key]).toEqual(firstOutput[key]);
        else firstOutput = queued.output;
        owner["processSettledWorkerResults"]();
        expect(candidate.finish()).toBe(1);
        const chunk = owner["chunks"].get(candidate.work.key)!;
        expect(chunk.lodLevel).toBe(lod);
        expect(chunk.mesh.count).toBeGreaterThan(0);
        const descriptor = getGrassBladeLayout(
          lod,
          "fine-folded-sheath-near5-v1",
        );
        expect(chunk.mesh.geometry.getAttribute("position").count).toBe(
          [360, 216, 60][lod],
        );
        expect(chunk.mesh.geometry.index!.count / 3).toBe([408, 216, 36][lod]);
        expect(chunk.mesh.geometry.getAttribute("grassRootDeltas").count).toBe(
          chunk.mesh.count * descriptor.bladesPerClump,
        );
        const material = chunk.mesh.material;
        if (Array.isArray(material))
          throw new Error("One grounded material required");
        expect(material.userData.grassBladeLayout).toBe(descriptor);
        expect(material.userData.fineGrassCanopyLighting.normalSource).toBe(
          lod < 2 ? "geometry-fold" : undefined,
        );
        if (lod < 2)
          expect(material.userData.fineGrassCanopyLighting.geometryLayout).toBe(
            "fine-folded-sheath-near5-v1",
          );
        expect(owner.getProfileReceipt().grounding?.failedChunks).toBe(0);
        expect(
          owner["completedGrounding"]
            .get(candidate.work.key)!
            .region.isCurrent(),
        ).toBe(true);
      }
    } finally {
      baseline.close();
      candidate.close();
    }
  });

  it("selects the denser ribbon field explicitly at all three grounded LODs", async () => {
    const f = await fixture(
      undefined,
      undefined,
      16,
      undefined,
      "leaf-volume-v1",
      "meadow-field-v1",
      "per-blade-v1",
    );
    try {
      const owner = f.owner;
      expect(owner.getProfileReceipt()).toMatchObject({
        geometryCandidate: "meadow-field-v1",
        geometryLayout: "fine-meadow-ribbon-v1",
        clumpSpacing: 0.5,
        clumpSpacingMultiplier: 0.5 / 0.7,
        maxRenderDistance: 140,
        placement: { cellSize: 25, nearLodDistance: 40, detailLodDistance: 12 },
      });
      const warmed: number[] = [];
      await owner.precompileRepresentativeChunk(async (object) => {
        const mesh = object as THREE.InstancedMesh;
        expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
        const material = mesh.material;
        if (Array.isArray(material))
          throw new Error("One field material required");
        const lod = warmed.length;
        warmed.push(mesh.geometry.getAttribute("position").count);
        expect(material.userData.grassBladeLayout).toBe(
          getGrassBladeLayout(lod, "fine-meadow-ribbon-v1"),
        );
        expect(material.userData.fineGrassCanopyLighting).toMatchObject({
          normalSource: "geometry-ribbon-relief",
          foldTangent: Math.tan((18 * Math.PI) / 180),
          geometryLayout: "fine-meadow-ribbon-v1",
        });
        // The explicit field owns its modest shading relief at every tier.
        expect(owner["materialForLod"](lod)).toBe(owner["foldedMaterial"]);
        expect(owner["materialForLod"](lod).normalNode).toBe(
          owner["foldedBladeNormalNode"],
        );
      });
      expect(warmed).toEqual([147, 105, 60]);
      for (const work of owner["liveWorkUnits"].values()) {
        const inputs = [0, 1, 2].map((lod) =>
          owner["createWorkerInput"](work, work.key, lod),
        );
        expect(inputs[0].clumpSpacing).toBe(0.5);
        expect(inputs[0].spacingMul).toBe(1);
        expect(inputs[1]).toEqual(inputs[0]);
        expect(inputs[2]).toEqual(inputs[0]);
        expect(inputs[0].placementCoverage).toBeUndefined();
      }
      for (const [distance, lod] of [
        [0, 0],
        [20, 1],
        [60, 2],
      ]) {
        owner["lodFocusX"] = f.work.bounds.maxX + distance;
        owner["lodFocusZ"] = (f.work.bounds.minZ + f.work.bounds.maxZ) / 2;
        expect(owner["getLodLevel"](f.work)).toBe(lod);
      }
    } finally {
      f.close();
    }
  });

  it("rejects mixing the dense field and the historical single-cell coverage trial", async () => {
    await expect(
      fixture(
        undefined,
        {
          id: "sixty-centimetre-cell-v1",
          cell: { schemaVersion: 1, size: 25, indexX: 15, indexZ: 14 },
        },
        16,
        undefined,
        "leaf-volume-v1",
        "meadow-field-v1",
      ),
    ).rejects.toThrow("cannot mix");
  });

  it("honors both close-detail hysteresis boundaries, multi-tier jumps and transformed-parent safety", async () => {
    const f = await fixture(
      undefined,
      undefined,
      16,
      undefined,
      "leaf-volume-v1",
      "sheath-close-v1",
    );
    try {
      const focus = (distance: number) => {
        f.owner["lodFocusX"] = f.work.bounds.maxX + distance;
        f.owner["lodFocusZ"] = (f.work.bounds.minZ + f.work.bounds.maxZ) / 2;
      };
      const swap = async (lod: 0 | 1 | 2, distance: number) => {
        focus(distance);
        f.owner["pendingLodSwap"].set(f.work.key, {
          node: f.node,
          work: f.work,
          desiredLod: lod,
        });
        await f.queue(lod, true);
        f.owner["processSettledWorkerResults"]();
        expect(f.finish()).toBe(1);
        expect(f.owner["chunks"].get(f.work.key)!.lodLevel).toBe(lod);
      };
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      expect(f.finish()).toBe(1);
      for (const [distance, expected] of [
        [13.199, 0],
        [13.201, 1],
        [42, 1],
        [44.001, 2],
      ]) {
        focus(distance);
        expect(f.owner["desiredLod"](f.work)).toBe(expected);
      }
      await swap(2, 60);
      for (const [distance, expected] of [
        [36.001, 2],
        [35.999, 1],
        [11, 1],
        [10.799, 0],
      ]) {
        focus(distance);
        expect(f.owner["desiredLod"](f.work)).toBe(expected);
      }
      await swap(1, 20);
      for (const [distance, expected] of [
        [44, 1],
        [44.001, 2],
        [10.801, 1],
        [10.799, 0],
      ]) {
        focus(distance);
        expect(f.owner["desiredLod"](f.work)).toBe(expected);
      }
      focus(1000);
      f.container.position.x = 1;
      f.container.updateMatrixWorld(true);
      expect(f.owner["desiredLod"](f.work)).toBe(0);
    } finally {
      f.close();
    }
  });

  it("publishes five-section detail through the real grounding worker without changing the sync result", async () => {
    const port = new ActualGrassGroundingClientPort(
      (await bundleGrassGroundingWorker()).source,
    );
    await port.ready();
    const sync = await fixture(
      undefined,
      undefined,
      16,
      undefined,
      "leaf-volume-v1",
      "sheath-close-v1",
    );
    const worker = await fixture(
      undefined,
      undefined,
      16,
      port,
      "leaf-volume-v1",
      "sheath-close-v1",
    );
    try {
      await sync.queue();
      sync.owner["processSettledWorkerResults"]();
      expect(sync.finish()).toBe(1);
      await worker.queue();
      worker.owner["processSettledWorkerResults"]();
      let uploads = 0;
      const deadline = performance.now() + 10000;
      while (
        worker.owner["groundingJobs"].get(worker.work.key)?.job.state.status ===
        "running"
      ) {
        uploads += worker.owner["advanceGroundingJob"]();
        if (performance.now() >= deadline)
          throw new Error("Sheath grounding worker deadline");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(uploads).toBe(1);
      const a = sync.owner["chunks"].get(sync.work.key)!.mesh,
        b = worker.owner["chunks"].get(worker.work.key)!.mesh;
      expect(b.count).toBe(a.count);
      for (const key of Object.keys(a.geometry.attributes))
        expect(b.geometry.getAttribute(key).array, key).toEqual(
          a.geometry.getAttribute(key).array,
        );
      expect(b.geometry.boundingBox).toEqual(a.geometry.boundingBox);
      expect(worker.owner.getProfileReceipt().grounding).toMatchObject({
        execution: "worker-v1",
        failedChunks: 0,
        completedChunks: 1,
      });
    } finally {
      sync.close();
      worker.close();
    }
  });

  it("publishes through the actual grounding worker with identical mesh attributes and one upload per advance", async () => {
    const port = new ActualGrassGroundingClientPort(
      (await bundleGrassGroundingWorker()).source,
    );
    await port.ready();
    const original = await fixture();
    const candidate = await fixture(undefined, undefined, 16, port);
    try {
      await original.queue();
      original.owner["processSettledWorkerResults"]();
      expect(original.finish()).toBe(1);
      await candidate.queue();
      candidate.owner["processSettledWorkerResults"]();
      let uploads = 0;
      const deadline = performance.now() + 10_000;
      while (
        candidate.owner["groundingJobs"].get(candidate.work.key)?.job.state
          .status === "running"
      ) {
        const result = candidate.owner["advanceGroundingJob"]();
        expect(result).toBeLessThanOrEqual(1);
        uploads += result;
        if (performance.now() >= deadline)
          throw new Error("Actual manager grounding worker deadline");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(uploads).toBe(1);
      const before = original.owner["chunks"].get(original.work.key)!.mesh;
      const after = candidate.owner["chunks"].get(candidate.work.key)!.mesh;
      expect(after.count).toBe(before.count);
      expect(Object.keys(after.geometry.attributes).sort()).toEqual(
        Object.keys(before.geometry.attributes).sort(),
      );
      for (const name of Object.keys(before.geometry.attributes)) {
        expect(after.geometry.getAttribute(name).array, name).toEqual(
          before.geometry.getAttribute(name).array,
        );
      }
      expect(after.geometry.boundingBox).toEqual(before.geometry.boundingBox);
      const receipt = candidate.owner.getProfileReceipt().grounding!;
      expect(receipt.execution).toBe("worker-v1");
      expect(receipt.completedChunks).toBe(1);
      expect(receipt.failedChunks).toBe(0);
      expect(receipt.worker!.preparedOwners).toBeGreaterThan(0);
      expect(receipt.worker!.activeGeneration).toBeNull();
      expect(
        original.owner.getProfileReceipt().grounding!.execution,
      ).toBeUndefined();
      const retained = candidate.owner["completedGrounding"].get(
        candidate.work.key,
      )!;
      expect(retained.region.isCurrent()).toBe(true);
      expect(retained.inputs.isCurrent()).toBe(true);
      const prepared = receipt.worker!.preparedOwners;
      candidate.owner.rebuildAllChunks();
      await candidate.queue();
      candidate.owner["processSettledWorkerResults"]();
      while (
        candidate.owner["groundingJobs"].get(candidate.work.key)?.job.state
          .status === "running"
      ) {
        candidate.owner["advanceGroundingJob"]();
        if (performance.now() >= deadline)
          throw new Error("Actual manager cached worker deadline");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(
        candidate.owner.getProfileReceipt().grounding!.worker!.preparedOwners,
      ).toBe(prepared);
      expect(
        candidate.owner.getProfileReceipt().grounding!.worker!.cacheHits,
      ).toBeGreaterThan(0);
      expect(
        candidate.owner["chunks"].get(candidate.work.key)!.mesh.count,
      ).toBe(before.count);
      candidate.owner.destroy();
      expect(port.terminateCalls).toBe(1);
      expect(port.listenerCount).toBe(0);
      expect(
        candidate.owner.getProfileReceipt().grounding!.worker!.cacheOwners,
      ).toBe(0);
    } finally {
      original.close();
      candidate.close();
      await port.close();
    }
  });

  it("shares the original frame allowance across synchronous worker phases and stops while the actual reply is pending", async () => {
    const port = new ActualGrassGroundingClientPort(
      (await bundleGrassGroundingWorker()).source,
    );
    await port.ready();
    const f = await fixture(undefined, undefined, 16, port);
    try {
      const second = f.owner["liveWorkUnits"].get("gcell_v1_14_14")!;
      await f.queue();
      await f.queue(0, false, second);
      f.owner["processSettledWorkerResults"]();
      f.owner["processSettledWorkerResults"]();
      const entries = [...f.owner["groundingJobs"].values()],
        coordinator = f.owner["groundingWorker"]!;
      expect(entries).toHaveLength(2);
      expect(
        entries.every(({ job }) => job instanceof GrassGroundingWorkerJob),
      ).toBe(true);
      const operations = () =>
        coordinator.receipt.admissionOperations +
        entries.reduce((sum, { job }) => sum + job.operations, 0);
      let uploads = 0;
      const advanceFrame = () => {
        // Read actual parked transport evidence, without consuming or replacing
        // it. Remote work is cumulative and is not main-frame work allowance.
        const pending = coordinator["pending"],
          settled = coordinator["client"]["slot"]?.settled,
          response = settled?.status === "response" ? settled.response : null,
          remoteOperations =
            pending &&
            response &&
            (response.type === "surface_prepared" || response.type === "result")
              ? response.work.operations - pending.seed.operations
              : 0,
          selected =
            coordinator.activeJob ??
            entries.find(({ job }) => job.state.status === "running")?.job,
          startsAtCache =
            selected instanceof GrassGroundingWorkerJob &&
            selected.phase === "cache",
          before = operations(),
          started = performance.now(),
          uploaded = f.owner["advanceGroundingJob"](),
          elapsed = performance.now() - started;
        const consumedReply =
          pending !== null && coordinator["pending"] !== pending;
        const mainOperations =
          operations() - before - (consumedReply ? remoteOperations : 0);
        expect(mainOperations).toBeGreaterThanOrEqual(0);
        expect(mainOperations).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations,
        );
        expect(uploaded).toBeLessThanOrEqual(1);
        uploads += uploaded;
        // A deadline is cooperative, not an elapsed-time promise. Conditional
        // evidence avoids demanding a submillisecond win under native GC or
        // preemption: a fast cache call must do more than cache setup alone.
        if (
          startsAtCache &&
          elapsed < GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs
        )
          expect(mainOperations).toBeGreaterThan(2);
        const active = coordinator.activeJob;
        if (
          active?.state.status === "running" &&
          active.phase !== "waiting_worker" &&
          active.lastSliceOperations > 0 &&
          mainOperations <
            GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations
        )
          expect(elapsed).toBeGreaterThanOrEqual(
            GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs,
          );
        return mainOperations;
      };
      const deadline = performance.now() + 10_000;
      let pendingWaitChecked = false,
        frames = 0;
      while (f.owner["groundingJobs"].size && frames++ < 10_000) {
        advanceFrame();
        const pending = coordinator["pending"];
        if (pending && !pendingWaitChecked) {
          expect(coordinator["client"]["slot"]?.settled).toBeNull();
          const held = coordinator.activeJob,
            before = coordinator.receipt,
            calls = port.postCalls,
            beforeUploads = uploads;
          // No event-loop yield: even if the real worker finishes in parallel,
          // its actual reply cannot be delivered until this call stack exits.
          // These are state/progress checks, not an unobservable poll-count claim.
          for (let i = 0; i < 3; i++) {
            expect(advanceFrame()).toBe(0);
            expect(coordinator["pending"]).toBe(pending);
            expect(coordinator.activeJob).toBe(held);
            expect(coordinator.receipt.phase).toBe("waiting_worker");
            expect(coordinator.receipt.reservedInputBytes).toBe(
              before.reservedInputBytes,
            );
            expect(coordinator.receipt.reservedDerivedBytes).toBe(
              before.reservedDerivedBytes,
            );
            expect(coordinator.receipt.preparedOwners).toBe(
              before.preparedOwners,
            );
            expect(port.postCalls).toBe(calls);
            expect(uploads).toBe(beforeUploads);
            expect(entries[1].job.operations).toBe(0);
            expect(entries[1].job.lastPhase).toBeNull();
          }
          pendingWaitChecked = true;
        }
        if (pending) {
          if (pending.kind === "prepare_surface")
            await port.waitFor("surface_prepared", pending.id);
          else if (pending.kind === "start_cached")
            await port.waitFor("result", pending.id);
          else await port.waitFor("surfaces_released", pending.id);
        }
        if (performance.now() >= deadline)
          throw new Error("Actual manager phase-chain deadline");
      }
      expect(frames).toBeLessThan(10_000);
      expect(pendingWaitChecked).toBe(true);
      expect(uploads).toBe(2);
      expect(f.owner["chunks"].size).toBe(2);
      expect(f.owner["completedGrounding"].size).toBe(2);
      expect(f.owner.getProfileReceipt().grounding!.failedChunks).toBe(0);
      expect(coordinator.activeJob).toBeNull();
      expect(coordinator.receipt.lastAdmissionFailure).toBeNull();
    } finally {
      f.close();
      await port.close();
    }
  });

  it("retires an actual in-flight worker job on terrain invalidation and never publishes its stale mesh", async () => {
    const port = new ActualGrassGroundingClientPort(
      (await bundleGrassGroundingWorker()).source,
    );
    await port.ready();
    const f = await fixture(undefined, undefined, 16, port);
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      const entry = f.owner["groundingJobs"].get(f.work.key)!;
      const deadline = performance.now() + 10_000;
      while (entry.job.lastPhase !== "worker_fit_dispatch") {
        f.owner["advanceGroundingJob"]();
        expect(entry.job.state.status).toBe("running");
        if (performance.now() >= deadline)
          throw new Error("Actual manager worker dispatch deadline");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const cachedOwners =
        f.owner.getProfileReceipt().grounding!.worker!.cacheOwners;
      expect(cachedOwners).toBeGreaterThan(0);
      f.visual.onNodeDestroyGeometry(f.node);
      f.owner.onNodeDestroyGeometry(f.node);
      expect(f.visual.isRetainedSurfaceCurrent(entry.ticket.surface)).toBe(
        false,
      );
      expect(entry.job.state.status).toBe("cancelled");
      while (
        f.owner.getProfileReceipt().grounding!.worker!.activeGeneration !==
          null ||
        f.owner.getProfileReceipt().grounding!.worker!.cacheOwners !==
          cachedOwners - 1 ||
        f.owner.getProfileReceipt().grounding!.worker!.phase !== "idle"
      ) {
        expect(f.owner["advanceGroundingJob"]()).toBe(0);
        if (performance.now() >= deadline)
          throw new Error("Actual manager worker cancellation deadline");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(f.container.children).toHaveLength(0);
      expect(f.owner["completedGrounding"].size).toBe(0);
      expect(f.owner["groundingJobs"].size).toBe(0);
      expect(
        f.owner.getProfileReceipt().grounding!.worker!.lastAdmissionFailure,
      ).toBeNull();
    } finally {
      f.close();
      await port.close();
    }
  });

  it("measures bounded coverage choices against the unchanged actual retained-grounding work limit", async () => {
    const f = await fixture(undefined, undefined, 128);
    try {
      f.owner.onNodeNeedsGeometry(f.nodes[3]);
      const work = f.owner["liveWorkUnits"].get("gcell_v1_12_11")!;
      for (const spacing of [0.7, 0.65, 0.6, 0.55, 0.5]) {
        const input = {
          ...f.owner["createWorkerInput"](work, work.key, 0),
          clumpSpacing: spacing,
        };
        const output = await f.execute(input);
        const ticket = f.owner["createWorkerTicket"](work, work.key, 0, false);
        const region = f.visual.captureRetainedSurfaceRegion(
          ticket.grounding!.bounds,
        );
        const steps = prepareGroundedGrassSteps(
          {
            data: output,
            ownSurface: ticket.surface,
            surfaces: region.surfaces,
            geometry: f.owner["lodGeometries"][0],
            lod: 0,
            geometryLayout: FINE_MEADOW_APPEARANCE.GEOMETRY_LAYOUT,
            oceanLevel: f.setup.terrainConfig.WATER_THRESHOLD,
            wind: {
              x:
                GRASS_CONFIG.WIND_STRENGTH *
                FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX,
              z:
                GRASS_CONFIG.WIND_STRENGTH *
                FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX *
                0.55,
            },
          },
          ticket.grounding!.inputs!,
          (x, z) => f.terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
          (x, z) => f.terrain["isGrassExcludedAt"](x, z),
        );
        let cursor = steps.next();
        while (!cursor.done) cursor = steps.next();
        const result = cursor.value;
        process.stdout.write(
          JSON.stringify({
            coverageWorkProbe: true,
            spacing,
            workerClumps: output.count,
            status: result.status,
            ...(result.status === "defer" ? { reason: result.reason } : {}),
            receipt: result.receipt,
          }) + "\n",
        );
        expect(result.receipt.workBudget).toBe(1_000_000);
        expect(result.receipt.workUnits).toBeLessThanOrEqual(1_000_000);
        if (spacing === 0.7) expect(result.status).toBe("ready");
        if (spacing === 0.5) expect(result.status).toBe("defer");
      }
      expect(f.container.children).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("limits the restart-owned coverage trial to one actual cell with exact unchanged neighbour arrays at both tiers", async () => {
    const trial = {
      id: "sixty-centimetre-cell-v1" as const,
      cell: {
        schemaVersion: 1 as const,
        size: 25 as const,
        indexX: 12,
        indexZ: 11,
      },
    };
    const baseline = await fixture();
    const candidate = await fixture(undefined, trial);
    try {
      const receipt = candidate.owner.getProfileReceipt();
      expect(receipt.placement?.coverageTrial).toEqual(trial);
      expect(receipt.placement?.coverageTrial).not.toBe(trial);
      expect(Object.isFrozen(receipt.placement?.coverageTrial)).toBe(true);
      expect(Object.isFrozen(receipt.placement?.coverageTrial?.cell)).toBe(
        true,
      );
      expect(
        Object.prototype.hasOwnProperty.call(
          baseline.owner.getProfileReceipt().placement,
          "coverageTrial",
        ),
      ).toBe(false);
      trial.cell.indexX = 13;
      expect(receipt.placement?.coverageTrial?.cell.indexX).toBe(12);
      expect(receipt.clumpSpacing).toBe(0.7);
      expect(receipt.maxRenderDistance).toBe(140);
      expect(receipt.maxChunksPerFrame).toBe(1);
      for (const f of [baseline, candidate])
        f.owner.onNodeNeedsGeometry(f.nodes[3]);
      let changed = 0;
      for (const work of candidate.owner["liveWorkUnits"].values()) {
        const original = baseline.owner["liveWorkUnits"].get(work.key)!;
        const selected = work.key === "gcell_v1_12_11";
        for (const lod of [0, 1]) {
          const input = candidate.owner["createWorkerInput"](
            work,
            work.key,
            lod,
          );
          const before = baseline.owner["createWorkerInput"](
            original,
            original.key,
            lod,
          );
          expect(input.clumpSpacing).toBe(selected ? 0.6 : 0.7);
          expect(input.placementCoverage).toBe(
            selected ? "sixty-centimetre-cell-v1" : undefined,
          );
          const output = await candidate.execute(input);
          const oldOutput = await baseline.execute(before);
          const sync = candidate.owner["generateInstanceData"](work, 1);
          expect(output.count).toBe(sync?.count ?? 0);
          for (const field of [
            "offsets",
            "rotScaleHash",
            "groundColors",
            "grassTints",
            "groundNormals",
          ] as const) {
            expect(output[field]).toEqual(sync?.[field] ?? new Float32Array());
            if (!selected) expect(output[field]).toEqual(oldOutput[field]);
          }
          if (!selected) {
            expect(input).toEqual(before);
            expect(output).toEqual(oldOutput);
          } else {
            changed++;
            expect(output.count).toBeGreaterThan(oldOutput.count);
            expect(output.count).toBeLessThanOrEqual(1737);
            expect(oldOutput.count).toBeLessThanOrEqual(1276);
            for (let i = 0; i < output.count; i++) {
              const x = work.node.centerX + output.offsets[i * 3];
              const z = work.node.centerZ + output.offsets[i * 3 + 2];
              const water = candidate.terrain
                .getWaterBodyRegistry()
                .getWaterSurfaceAt(x, z);
              expect(candidate.terrain["isGrassExcludedAt"](x, z)).toBe(false);
              if (water !== null)
                expect(
                  candidate.terrain["getHeightAtComputed"](x, z),
                ).toBeGreaterThan(water);
            }
          }
        }
      }
      expect(changed).toBe(2);
    } finally {
      candidate.close();
      baseline.close();
    }
  });

  it("preserves selected coverage through real worker, synchronous fallback and retained grounding without changing blade geometry", async () => {
    const trial: GrassPlacementCoverageTrial = {
      id: "sixty-centimetre-cell-v1",
      cell: { schemaVersion: 1, size: 25, indexX: 12, indexZ: 11 },
    };
    const worker = await fixture(undefined, trial, 128);
    const fallback = await fixture(undefined, trial, 128);
    try {
      for (const f of [worker, fallback]) {
        f.owner.onNodeNeedsGeometry(f.nodes[3]);
        f.owner.setPlayerPosition(312.5, 287.5);
      }
      for (const lod of [0, 1]) {
        const chunks: THREE.InstancedMesh[] = [];
        for (const f of [worker, fallback]) {
          const work = f.owner["liveWorkUnits"].get("gcell_v1_12_11")!;
          f.owner["lodFocusX"] = lod ? 380 : 312.5;
          f.owner["lodFocusZ"] = 287.5;
          if (f === worker) {
            const { ticket, output } = await f.queue(lod, lod === 1, work);
            f.owner["settledWorkerResults"].length = 0;
            const missing = { ...output };
            delete missing.placementCoverage;
            for (const bad of [
              missing,
              { ...output, placementCoverage: undefined },
              { ...output, placementCoverage: "unsupported" },
            ]) {
              expect(() =>
                f.owner["settleWorkerResult"](ticket, bad as GrassWorkerOutput),
              ).toThrow(/coverage/);
              expect(f.owner["settledWorkerResults"]).toHaveLength(0);
            }
            f.owner["settleWorkerResult"](ticket, output);
          } else f.owner["createChunkMesh"](work, lod, lod === 1);
          expect(
            f.owner["settledWorkerResults"][0].data.placementCoverage,
          ).toBe(trial.id);
          f.owner["processSettledWorkerResults"]();
          expect(f.finish(work.key)).toBe(1);
          const chunk = f.owner["chunks"].get(work.key)!;
          expect(chunk.mesh.count).toBeGreaterThan(0);
          expect(chunk.mesh.userData.grassPlacementCoverage).toBe(trial.id);
          expect(chunk.mesh.userData.grassPlacementCell).toBe(
            work.placementCell,
          );
          expect(
            chunk.mesh.userData.grassBladeGrounding.inputClumps,
          ).toBeGreaterThan(1276);
          chunks.push(chunk.mesh);
        }
        const [a, b] = chunks;
        expect(a.count).toBe(b.count);
        expect(a.boundingBox).toEqual(b.boundingBox);
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
        expect(a.userData.grassBladeGrounding.sourceIndices).toEqual(
          b.userData.grassBladeGrounding.sourceIndices,
        );
      }
    } finally {
      fallback.close();
      worker.close();
    }
  });

  it("cancels the selected coverage job on actual constraint invalidation before publishing", async () => {
    const f = await fixture(
      undefined,
      {
        id: "sixty-centimetre-cell-v1",
        cell: { schemaVersion: 1, size: 25, indexX: 12, indexZ: 11 },
      },
      128,
    );
    f.terrain["grassVisualManager"] = f.owner;
    try {
      f.owner.onNodeNeedsGeometry(f.nodes[3]);
      const work = f.owner["liveWorkUnits"].get("gcell_v1_12_11")!;
      f.owner.setPlayerPosition(312.5, 287.5);
      f.owner["lodFocusX"] = 312.5;
      f.owner["lodFocusZ"] = 287.5;
      const { ticket, output } = await f.queue(0, false, work);
      f.owner["processSettledWorkerResults"]();
      const pending = f.owner["groundingJobs"].get(work.key)!;
      expect(pending.job.state.status).toBe("running");
      f.terrain.registerFlatZone({
        id: "selected-coverage-constraint-invalidation",
        centerX: 312.5,
        centerZ: 287.5,
        width: 2,
        depth: 2,
        height: f.terrain.getHeightAt(312.5, 287.5),
        blendRadius: 0,
      });
      expect(pending.job.state.status).toBe("cancelled");
      expect(f.owner["groundingJobs"].has(work.key)).toBe(false);
      f.owner["settleWorkerResult"](ticket, output);
      expect(f.owner["settledWorkerResults"]).toHaveLength(0);
      expect(f.owner["advanceGroundingJob"]()).toBe(0);
      expect(f.owner["completedNodes"].has(work.key)).toBe(false);
      expect(f.container.children).toHaveLength(0);
    } finally {
      f.close();
    }
  });

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
      const replacementWorker = await f.queue();
      f.owner["processSettledWorkerResults"]();
      const replacement = f.owner["groundingJobs"].get(f.work.key);
      const uploads = f.finish();
      const state = replacement?.job.state;
      const detail =
        uploads === 1
          ? undefined
          : JSON.stringify({
              key: f.work.key,
              status: state?.status ?? "missing",
              reason:
                state && "reason" in state
                  ? state.reason
                  : state?.status === "waiting_support"
                    ? state.result.reason
                    : null,
              activeMs: replacement?.job.activeMs ?? null,
              maximumSliceMs: replacement?.job.maximumSliceMs ?? null,
              operations: replacement?.job.operations ?? null,
              lastPhase: replacement?.job.lastPhase ?? null,
              workerCount: replacementWorker.output.count,
              retainedCount:
                state?.status === "ready" ? state.result.data.count : null,
              published: f.owner["completedNodes"].has(f.work.key),
              installedClumps:
                f.owner["chunks"].get(f.work.key)?.mesh.count ?? 0,
              regionCurrent: replacement?.region?.isCurrent() ?? null,
              inputsCurrent:
                replacement?.ticket.grounding?.inputs?.isCurrent() ?? null,
              error:
                state?.status === "failed_input" && state.error instanceof Error
                  ? state.error.message.slice(0, 240)
                  : null,
            });
      expect(uploads, detail).toBe(1);
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
            (x, z) => f.terrain["isGrassExcludedAt"](x, z),
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
        (x, z) => f.terrain["isGrassExcludedAt"](x, z),
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
      const material = chunk.mesh.material;
      expect(Array.isArray(material)).toBe(false);
      if (Array.isArray(material))
        throw new Error("A grounded grass chunk must use one material");
      expect(material.userData.grassBladeLayout).toBe(layout);
      expect(
        Object.getOwnPropertyDescriptor(material.userData, "grassBladeLayout"),
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

  it.each([
    {
      name: "historical 0→1→0",
      candidate: false,
      from: 0,
      to: 1,
      home: -15,
      away: 50,
    },
    {
      name: "close detail 0→1→0",
      candidate: true,
      from: 0,
      to: 1,
      home: 0,
      away: 20,
    },
    {
      name: "close detail 1→0→1",
      candidate: true,
      from: 1,
      to: 0,
      home: 20,
      away: 0,
    },
    {
      name: "close detail 1→2→1",
      candidate: true,
      from: 1,
      to: 2,
      home: 20,
      away: 60,
    },
    {
      name: "close detail 2→1→2",
      candidate: true,
      from: 2,
      to: 1,
      home: 60,
      away: 20,
    },
  ] as const)(
    "cancels a running opposite-LOD grounding job before it can replace a still-correct mesh: $name",
    async (scenario) => {
      // Retain the historical real-placement-worker/local-grounding case. New
      // tiers additionally exercise an actual pending grounding-worker reply.
      const port = scenario.candidate
        ? new ActualGrassGroundingClientPort(
            (await bundleGrassGroundingWorker()).source,
          )
        : undefined;
      let ownedFixture: Awaited<ReturnType<typeof fixture>> | undefined;
      try {
        if (port) await port.ready();
        const f = (ownedFixture = await fixture(
          undefined,
          undefined,
          16,
          port,
          scenario.candidate ? "leaf-volume-v1" : undefined,
          scenario.candidate ? "sheath-close-v1" : undefined,
          scenario.candidate ? "per-blade-v1" : undefined,
        ));
        const focus = (distance: number) => {
          f.owner["lodFocusX"] = f.work.bounds.maxX + distance;
          f.owner["lodFocusZ"] = (f.work.bounds.minZ + f.work.bounds.maxZ) / 2;
        };
        focus(scenario.home);
        const initial = await f.queue(scenario.from);
        f.owner["processSettledWorkerResults"]();
        if (port) {
          let uploads = 0;
          const deadline = performance.now() + 10000;
          while (
            f.owner["groundingJobs"].get(f.work.key)?.job.state.status ===
            "running"
          ) {
            const uploaded = f.owner["advanceGroundingJob"]();
            expect(uploaded).toBeLessThanOrEqual(1);
            uploads += uploaded;
            if (performance.now() >= deadline)
              throw new Error(
                "Opposite-LOD initial worker publication deadline",
              );
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          expect(uploads).toBe(1);
        } else expect(f.finish()).toBe(1);

        const current = f.owner["chunks"].get(f.work.key);
        if (!current)
          throw new Error("Initial grounded cell must be published");
        const original = current.mesh;
        const material = original.material;
        if (Array.isArray(material))
          throw new Error("One grounded material required");
        const geometryLayout = scenario.candidate
          ? "fine-folded-sheath-near5-v1"
          : "fine-linear-sweep-3seg-v1";
        const layout = getGrassBladeLayout(scenario.from, geometryLayout);
        expect(current.lodLevel).toBe(scenario.from);
        expect(original.count).toBeGreaterThan(0);
        expect(material.userData.grassBladeLayout).toBe(layout);
        expect(layout.verticesPerBlade).toBe(
          scenario.candidate ? [15, 9, 5][scenario.from] : 7,
        );
        expect(original.geometry.getAttribute("position").count).toBe(
          scenario.candidate ? [360, 216, 60][scenario.from] : 168,
        );
        expect(original.geometry.index?.count).toBe(
          scenario.candidate ? [1224, 648, 108][scenario.from] : 360,
        );
        for (const name of ["position", "normal", "uv"])
          expect(original.geometry.getAttribute(name).array).toEqual(
            f.owner["lodGeometries"][scenario.from].getAttribute(name).array,
          );
        const roots = original.geometry.getAttribute("grassRootDeltas");
        const masks = original.geometry.getAttribute("grassBladeVisibility");
        expect(roots.itemSize).toBe(2);
        expect(roots.count).toBe(original.count * layout.bladesPerClump);
        let visibleBlades = 0;
        if (scenario.candidate) {
          expect(masks.count).toBe(original.count);
          if (!(masks.array instanceof Uint32Array))
            throw new Error("Published blade masks must remain Uint32");
          for (const mask of masks.array) {
            expect(mask).toBeGreaterThan(0);
            expect(mask).toBeLessThan(2 ** layout.bladesPerClump);
            for (let bits = mask; bits; bits &= bits - 1) visibleBlades++;
          }
        } else expect(masks).toBeUndefined();
        const grounding = original.userData.grassBladeGrounding;
        const sourceIndices = grounding.sourceIndices;
        if (!(sourceIndices instanceof Uint32Array))
          throw new Error("Actual admitted source indices required");
        expect(sourceIndices.length).toBe(original.count);
        expect(
          sourceIndices.every((index) => index < initial.output.count),
        ).toBe(true);
        if (scenario.candidate)
          expect(grounding.roadClearance.retainedBlades).toBe(visibleBlades);
        else expect(grounding.roadClearance).toBeUndefined();
        const attributes = Object.entries(original.geometry.attributes).map(
          ([name, attribute]) => ({
            name,
            attribute,
            values: attribute.array.slice(),
          }),
        );
        const initialSources = sourceIndices.slice();
        const originalAdmission = f.owner["completedGrounding"].get(f.work.key);
        if (!originalAdmission)
          throw new Error("Initial grounding lease required");
        let geometryDisposals = 0;
        let materialDisposals = 0;
        original.geometry.addEventListener(
          "dispose",
          () => geometryDisposals++,
        );
        material.addEventListener("dispose", () => materialDisposals++);

        focus(scenario.away);
        expect(f.owner["desiredLod"](f.work)).toBe(scenario.to);
        f.owner["pendingLodSwap"].set(f.work.key, {
          node: f.node,
          work: f.work,
          desiredLod: scenario.to,
        });
        const queued = await f.queue(scenario.to, true);
        if (scenario.candidate) {
          expect(initial.input.spacingMul).toBe(1);
          expect(queued.input).toEqual(initial.input);
          for (const name of [
            "offsets",
            "rotScaleHash",
            "groundColors",
            "grassTints",
            "groundNormals",
          ] as const)
            expect(queued.output[name]).toEqual(initial.output[name]);
        }
        f.owner["processSettledWorkerResults"]();
        const entry = f.owner["groundingJobs"].get(f.work.key);
        if (!entry) throw new Error("Opposite-LOD grounding job required");
        const job = entry.job;
        expect(job.state.status).toBe("running");
        let pendingReply: number | null = null;
        if (port) {
          expect(job).toBeInstanceOf(GrassGroundingWorkerJob);
          const deadline = performance.now() + 10000;
          while (job.lastPhase !== "worker_fit_dispatch") {
            expect(f.owner["advanceGroundingJob"]()).toBe(0);
            expect(job.state.status).toBe("running");
            if (performance.now() >= deadline)
              throw new Error("Opposite-LOD cached worker dispatch deadline");
            // Do not yield after the actual dispatch: the cancellation occurs
            // before the real reply can be delivered to the main event loop.
            if (job.lastPhase !== "worker_fit_dispatch")
              await new Promise<void>((resolve) => setImmediate(resolve));
          }
          const coordinator = f.owner["groundingWorker"];
          if (!coordinator)
            throw new Error("Actual grounding coordinator required");
          expect(coordinator["pending"]?.kind).toBe("start_cached");
          expect(coordinator["client"]["slot"]?.settled).toBeNull();
          pendingReply = coordinator.receipt.transportJobId;
          expect(coordinator.receipt.reservedInputBytes).toBeGreaterThan(
            coordinator.receipt.cacheInputBytes,
          );
        }

        focus(scenario.home);
        expect(f.owner["desiredLod"](f.work)).toBe(scenario.from);
        f.owner["cancelObsoleteLodWork"]();
        expect(job.state.status).toBe("cancelled");
        expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
        expect(f.owner["pendingLodSwap"].has(f.work.key)).toBe(false);
        expect(f.owner["advanceGroundingJob"]()).toBe(0);
        expect(f.owner["chunks"].get(f.work.key)?.mesh).toBe(original);

        if (port) {
          if (pendingReply === null)
            throw new Error("Real pending reply identity required");
          // This is the worker's unmodified terminal response, whether its
          // cancellation won the race or a ready response was already in flight.
          const reply = await port.waitFor("result", pendingReply);
          expect(reply.jobId).toBe(pendingReply);
          expect(["cancelled", "ready"]).toContain(reply.state.status);
          const coordinator = f.owner["groundingWorker"];
          if (!coordinator)
            throw new Error("Actual grounding coordinator required");
          const deadline = performance.now() + 10000;
          while (
            coordinator.receipt.activeGeneration !== null ||
            coordinator.receipt.phase !== "idle"
          ) {
            expect(f.owner["advanceGroundingJob"]()).toBe(0);
            if (performance.now() >= deadline)
              throw new Error(
                "Cancelled opposite-LOD payload release deadline",
              );
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          expect(coordinator.receipt.transportJobId).toBeNull();
          expect(coordinator.receipt.reservedOwners).toBe(
            coordinator.receipt.cacheOwners,
          );
          expect(coordinator.receipt.reservedInputBytes).toBe(
            coordinator.receipt.cacheInputBytes,
          );
          expect(coordinator.receipt.reservedDerivedBytes).toBe(
            coordinator.receipt.cacheDerivedBytesReserved,
          );
          expect(coordinator.receipt.lastAdmissionFailure).toBeNull();
          expect(coordinator.receipt.lastFittingFailure).toBeUndefined();
          // LOD cancellation releases its transient payload, not still-valid
          // retained terrain owners or the currently displayed mesh's lease.
          expect(coordinator.receipt.cacheOwners).toBeGreaterThan(0);
        }
        // Duplicate-after-consumption is a separate stale-message guard: this
        // ticket's placement result was already consumed to start grounding.
        f.owner["settleWorkerResult"](queued.ticket, queued.output);
        expect(f.owner["processSettledWorkerResults"]()).toBe(0);
        expect(f.owner["advanceGroundingJob"]()).toBe(0);
        expect(f.owner["workerInflight"].has(f.work.key)).toBe(false);
        expect(f.owner["settledWorkerResults"]).toHaveLength(0);

        // Also cancel a genuinely outstanding placement request before its
        // actual worker reply can be delivered. No fabricated result or replay.
        focus(scenario.away);
        f.owner["pendingLodSwap"].set(f.work.key, {
          node: f.node,
          work: f.work,
          desiredLod: scenario.to,
        });
        const placementInput = f.owner["createWorkerInput"](
          f.work,
          f.work.key,
          scenario.to,
        );
        const placementTicket = f.owner["createWorkerTicket"](
          f.work,
          f.work.key,
          scenario.to,
          true,
        );
        const outstandingPlacement = f.execute(placementInput);
        let placementOutput: GrassWorkerOutput;
        try {
          focus(scenario.home);
          f.owner["cancelObsoleteLodWork"]();
        } finally {
          // Always consume this real request, including a cancellation failure.
          placementOutput = await outstandingPlacement;
        }
        expect(f.owner["workerInflight"].has(f.work.key)).toBe(false);
        expect(f.owner["pendingLodSwap"].has(f.work.key)).toBe(false);
        expect(placementOutput.count).toBeGreaterThan(0);
        f.owner["settleWorkerResult"](placementTicket, placementOutput);
        expect(f.owner["settledWorkerResults"]).toHaveLength(0);
        expect(f.owner["processSettledWorkerResults"]()).toBe(0);
        expect(f.owner["advanceGroundingJob"]()).toBe(0);
        expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
        expect(f.owner["chunks"].get(f.work.key)).toBe(current);
        expect(f.owner["completedGrounding"].get(f.work.key)).toBe(
          originalAdmission,
        );
        expect(originalAdmission.region.isCurrent()).toBe(true);
        expect(originalAdmission.inputs.isCurrent()).toBe(true);
        expect(grounding.sourceIndices).toEqual(initialSources);
        for (const { name, attribute, values } of attributes) {
          expect(original.geometry.getAttribute(name), name).toBe(attribute);
          expect(attribute.array, name).toEqual(values);
        }
        expect(geometryDisposals).toBe(0);
        expect(materialDisposals).toBe(0);
        expect(f.owner.getProfileReceipt().grounding?.failedChunks).toBe(0);
        f.owner.destroy();
        expect(geometryDisposals).toBe(1);
        expect(materialDisposals).toBe(1);
        expect(f.owner["completedGrounding"].size).toBe(0);
        expect(f.container.children).toHaveLength(0);
        if (port) {
          expect(port.terminateCalls).toBe(1);
          expect(port.listenerCount).toBe(0);
          expect(f.owner.getProfileReceipt().grounding?.worker).toMatchObject({
            cacheOwners: 0,
            reservedOwners: 0,
            reservedInputBytes: 0,
            reservedDerivedBytes: 0,
          });
        }
      } finally {
        try {
          ownedFixture?.close();
        } finally {
          await port?.close();
        }
      }
    },
  );

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

  it.each([
    undefined,
    "sheath-close-v1",
    "rooted-fan-v1",
    "meadow-canopy-v1",
    "meadow-field-v1",
  ] as const)(
    "stops precompilation after real owner teardown without submitting another tier, candidate=%s",
    async (geometryCandidate) => {
      const f = await fixture(
        undefined,
        undefined,
        16,
        undefined,
        "leaf-volume-v1",
        geometryCandidate,
      );
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const submitted: number[] = [];
      let sampleGeometryDisposals = 0;
      let sampleMaterialDisposals = 0;
      try {
        const warmup = f.owner.precompileRepresentativeChunk(async (object) => {
          const mesh = object as THREE.InstancedMesh;
          expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
          const material = mesh.material;
          if (Array.isArray(material))
            throw new Error("One warmup material required");
          submitted.push(mesh.geometry.getAttribute("position").count);
          mesh.geometry.addEventListener(
            "dispose",
            () => sampleGeometryDisposals++,
          );
          material.addEventListener("dispose", () => sampleMaterialDisposals++);
          await pending;
        });
        expect(submitted).toEqual([
          geometryCandidate === "meadow-field-v1"
            ? 147
            : geometryCandidate
              ? 360
              : 216,
        ]);
        expect(sampleGeometryDisposals).toBe(0);
        f.owner.destroy();
        release!();
        await expect(warmup).rejects.toThrow(
          "Grass destroyed during precompilation",
        );
        expect(submitted).toEqual([
          geometryCandidate === "meadow-field-v1"
            ? 147
            : geometryCandidate
              ? 360
              : 216,
        ]);
        expect(sampleGeometryDisposals).toBe(1);
        expect(sampleMaterialDisposals).toBe(1);
        let lateSubmissions = 0;
        await expect(
          f.owner.precompileRepresentativeChunk(async () => {
            lateSubmissions++;
          }),
        ).rejects.toThrow("Grass destroyed during precompilation");
        expect(lateSubmissions).toBe(0);
        expect(f.container.children).toHaveLength(0);
      } finally {
        release?.();
        f.close();
      }
    },
  );

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

  it("hands validated ready-empty work to the next nearest job within the same shared allowance", async () => {
    const f = await fixture();
    try {
      const nextWork = f.owner["liveWorkUnits"].get("gcell_v1_15_15")!;
      const farWork = f.owner["liveWorkUnits"].get("gcell_v1_14_14")!;
      // Author a real grass-free service footprint, then regenerate the actual
      // retained terrain before creating tickets. The production worker itself
      // must return empty data; no generated arrays or counts are replaced.
      f.terrain.registerFlatZone({
        id: "empty-handoff-service-footprint",
        centerX: 387.5,
        centerZ: 362.5,
        width: 25,
        depth: 25,
        height: f.terrain.getHeightAt(387.5, 362.5),
        blendRadius: 0,
        excludeGrass: true,
      });
      for (const node of f.nodes) f.visual["generateChunkSync"](node);
      // Insertion order deliberately differs from distance order after the
      // nearest empty cell. No continuation or manager method is replaced.
      expect((await f.queue()).output.count).toBe(0);
      await f.queue(0, false, farWork);
      await f.queue(0, false, nextWork);
      for (let i = 0; i < 3; i++) f.owner["processSettledWorkerResults"]();
      const empty = f.owner["groundingJobs"].get(f.work.key)!;
      const next = f.owner["groundingJobs"].get(nextWork.key)!;
      const far = f.owner["groundingJobs"].get(farWork.key)!;
      // Resume real empty preparation to its final allocation boundary, leaving
      // completion/publication and the handoff to the actual manager call.
      while (
        empty.job.state.status === "running" &&
        empty.job.lastPhase !== "bounded_output_allocation"
      )
        empty.job.advance(1);
      expect(empty.job.state.status).toBe("running");
      const before = [empty, next, far].map((entry) => entry.job.operations);
      const started = performance.now();
      const firstPublished = f.owner["advanceGroundingJob"]();
      const elapsed = performance.now() - started;
      expect(firstPublished).toBeLessThanOrEqual(1);
      expect(empty.job.state.status).toBe("ready");
      expect(f.owner["groundingJobs"].has(f.work.key)).toBe(false);
      expect(f.owner["completedGrounding"].get(f.work.key)?.region).toBe(
        empty.region,
      );
      expect(f.owner["chunks"].has(f.work.key)).toBe(false);
      // Real clocks/GC may exhaust the cooperative deadline during even a tiny
      // completion. Without that exhaustion, the next job must receive work.
      if (next.job.operations === 0)
        expect(elapsed).toBeGreaterThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.targetSliceMs,
        );
      expect(far.job.operations).toBe(0);
      expect(
        [empty, next, far].reduce(
          (sum, entry, i) => sum + entry.job.operations - before[i],
          0,
        ),
      ).toBeLessThanOrEqual(
        GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations,
      );
      let calls = 0,
        uploads = firstPublished;
      while (f.owner["groundingJobs"].size && calls++ < 1000) {
        const jobs = [next, far];
        const previous = jobs.map((entry) => entry.job.operations);
        const published = f.owner["advanceGroundingJob"]();
        expect(published).toBeLessThanOrEqual(1);
        uploads += published;
        expect(
          jobs.reduce(
            (sum, entry, i) => sum + entry.job.operations - previous[i],
            0,
          ),
        ).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations,
        );
        if (published && f.owner["chunks"].size === 1)
          expect(far.job.operations).toBe(0);
      }
      expect(calls).toBeLessThan(1000);
      expect(uploads).toBe(2);
      expect(f.owner["chunks"].size).toBe(2);
      expect(f.owner.getProfileReceipt().grounding?.readyEmptyChunks).toBe(1);
    } finally {
      f.close();
    }
  });

  it("does not hand off after cancellation or failed retained ownership", async () => {
    const f = await fixture();
    try {
      const secondWork = f.owner["liveWorkUnits"].get("gcell_v1_14_14")!;
      await f.queue();
      await f.queue(0, false, secondWork);
      f.owner["processSettledWorkerResults"]();
      f.owner["processSettledWorkerResults"]();
      const first = f.owner["groundingJobs"].get(f.work.key)!;
      const second = f.owner["groundingJobs"].get(secondWork.key)!;
      // Replace the actual rendered surface without the manager reconciliation
      // pass so the real continuation discovers invalidation on selection.
      f.visual["generateChunkSync"](f.node);
      expect(f.owner["advanceGroundingJob"]()).toBe(0);
      expect(first.job.state.status).toBe("cancelled");
      expect(second.job.operations).toBe(0);
      expect(f.owner["completedGrounding"].has(f.work.key)).toBe(false);
      expect(f.container.children).toHaveLength(0);
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
      (x, z) => f.terrain["isGrassExcludedAt"](x, z),
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
        expect(
          Object.prototype.hasOwnProperty.call(input, "placementDistribution"),
        ).toBe(false);
        expect(
          Object.prototype.hasOwnProperty.call(input, "placementCell"),
        ).toBe(false);
        const cpu = legacy["generateInstanceData"](
          work,
          GRASS_CONFIG.LOD_TIERS[lod].spacingMul,
        );
        const output = await f.execute(input);
        expect(
          Object.prototype.hasOwnProperty.call(output, "placementDistribution"),
        ).toBe(false);
        expect(
          Object.prototype.hasOwnProperty.call(output, "placementCell"),
        ).toBe(false);
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

  it("preserves storage-backed grounded chunk identity matrices across parent motion, reparenting and real LOD replacement", async () => {
    const f = await fixture();
    const scene = new THREE.Scene(),
      firstParent = new THREE.Group(),
      secondParent = new THREE.Group(),
      referenceParent = new THREE.Group();
    scene.add(firstParent, secondParent);
    function check(mesh: THREE.InstancedMesh) {
      const geometry = mesh.geometry,
        material = mesh.material,
        count = mesh.count,
        local = mesh.matrix.clone();
      expect(mesh.instanceMatrix).toBeInstanceOf(
        THREE.StorageInstancedBufferAttribute,
      );
      expect(geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE)).toBe(
        mesh.instanceMatrix,
      );
      expect(mesh.instanceMatrix.usage).toBe(THREE.StaticDrawUsage);
      expect(mesh.instanceMatrix.version).toBe(1);
      expect(mesh.instanceMatrix.count).toBe(count);
      expect(mesh.instanceMatrix.array.byteLength).toBe(count * 16 * 4);
      expect(geometry.getAttribute("instanceOffset").count).toBe(count);
      const identities = new Float32Array(count * 16);
      const identity = new THREE.Matrix4();
      for (let index = 0; index < count; index++) {
        identity.toArray(identities, index * 16);
      }
      expect(mesh.instanceMatrix.array).toEqual(identities);
      expect(
        f.owner["lodGeometries"].some((source) =>
          source.hasAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
        ),
      ).toBe(false);
      const buffers = [
        ...Object.values(geometry.attributes),
        ...(geometry.index ? [geometry.index] : []),
      ].map((attribute) => {
        const array =
          attribute instanceof THREE.InterleavedBufferAttribute
            ? attribute.data.array
            : attribute.array;
        const bytes = new Uint8Array(
          array.buffer,
          array.byteOffset,
          array.byteLength,
        );
        return { bytes, before: bytes.slice() };
      });
      const reference = new THREE.Object3D();
      reference.position.copy(mesh.position);
      reference.quaternion.copy(mesh.quaternion);
      reference.scale.copy(mesh.scale);
      referenceParent.add(reference);
      firstParent.add(f.container, referenceParent);
      try {
        expect(mesh.matrixAutoUpdate).toBe(false);
        expect(mesh.matrixWorldAutoUpdate).toBe(true);
        expect(mesh.castShadow).toBe(false);
        expect(mesh.receiveShadow).toBe(true);
        expect(mesh.frustumCulled).toBe(true);
        for (const parent of [firstParent, secondParent]) {
          parent.position.set(17, -3, 29);
          parent.rotation.set(0.12, -0.31, 0.07);
          parent.scale.set(1.2, 0.9, -1.1);
          parent.add(f.container, referenceParent);
          for (let frame = 0; frame < 4; frame++) {
            parent.position.x += 3;
            scene.updateMatrixWorld(true);
            expect(mesh.matrixWorld.elements).toEqual(
              reference.matrixWorld.elements,
            );
            expect(mesh.matrix.elements).toEqual(local.elements);
            expect(f.container.matrixAutoUpdate).toBe(true);
            expect(f.container.matrixWorldAutoUpdate).toBe(true);
            const bounds = mesh
              .boundingBox!.clone()
              .applyMatrix4(reference.matrixWorld);
            const center = bounds.getCenter(new THREE.Vector3());
            const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
            camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
            camera.updateProjectionMatrix();
            camera.position.copy(center).add(new THREE.Vector3(0, 80, 80));
            for (const expected of [true, false]) {
              camera.lookAt(
                expected
                  ? center
                  : camera.position.clone().add(new THREE.Vector3(0, 0, 100)),
              );
              camera.updateMatrixWorld(true);
              const frustum = new THREE.Frustum().setFromProjectionMatrix(
                new THREE.Matrix4().multiplyMatrices(
                  camera.projectionMatrix,
                  camera.matrixWorldInverse,
                ),
                camera.coordinateSystem,
              );
              expect(frustum.intersectsBox(bounds)).toBe(expected);
              expect(mesh.intersectsFrustum(frustum)).toBe(expected);
            }
          }
        }
        expect(mesh.geometry).toBe(geometry);
        expect(mesh.material).toBe(material);
        expect(mesh.count).toBe(count);
        expect(mesh.instanceMatrix.version).toBe(1);
        expect(mesh.instanceMatrix.array).toEqual(identities);
        for (const { bytes, before } of buffers) expect(bytes).toEqual(before);
      } finally {
        reference.removeFromParent();
        f.container.removeFromParent();
        f.container.updateMatrixWorld(true);
      }
    }
    try {
      await f.queue();
      f.owner["processSettledWorkerResults"]();
      expect(f.finish()).toBe(1);
      const original = f.owner["chunks"].get(f.work.key)!.mesh;
      check(original);
      let disposed = 0;
      original.geometry.addEventListener("dispose", () => {
        expect(
          original.geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
        ).toBe(original.instanceMatrix);
        disposed++;
      });
      f.owner["lodFocusX"] = 450;
      f.owner["lodFocusZ"] = 362.5;
      f.owner["pendingLodSwap"].set(f.work.key, {
        node: f.node,
        work: f.work,
        desiredLod: 1,
      });
      await f.queue(1, true);
      f.owner["processSettledWorkerResults"]();
      expect(f.finish()).toBe(1);
      const replacement = f.owner["chunks"].get(f.work.key)!;
      expect(replacement.lodLevel).toBe(1);
      expect(replacement.mesh).not.toBe(original);
      expect(original.parent).toBeNull();
      expect(disposed).toBe(1);
      check(replacement.mesh);
      expect(replacement.mesh.instanceMatrix).not.toBe(original.instanceMatrix);
      expect(replacement.mesh.instanceMatrix.array).not.toBe(
        original.instanceMatrix.array,
      );
      let replacementDisposals = 0;
      replacement.mesh.geometry.addEventListener("dispose", () => {
        expect(
          replacement.mesh.geometry.getAttribute(
            INSTANCE_MATRIX_STORAGE_ATTRIBUTE,
          ),
        ).toBe(replacement.mesh.instanceMatrix);
        replacementDisposals++;
      });
      f.owner["retireGrassWork"](f.work.key);
      expect(replacementDisposals).toBe(1);
      expect(replacement.mesh.parent).toBeNull();
      expect(f.owner["chunks"].has(f.work.key)).toBe(false);
      expect(disposed).toBe(1);
    } finally {
      f.container.removeFromParent();
      f.close();
    }
  });
});
