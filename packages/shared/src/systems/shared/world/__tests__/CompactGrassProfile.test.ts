import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import {
  GRASS_WORKER_CODE,
  generateGrassPlacementsAsync,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import {
  GrassVisualManager,
  GRASS_CONFIG,
  STREAMING_GRASS_VISUAL_PROFILE,
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  DENSE_MEADOW_GRASS_VISUAL_PROFILE,
  NATURAL_TUFT_APPEARANCE,
  type GrassVisualProfile,
} from "../GrassVisualManager";
import { TerrainVisualManager } from "../TerrainVisualManager";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
  SCULPTED_COMPACT_V2_PROFILE_FIXTURE,
  SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import { sampleCompactHabitatSoil } from "../CompactHabitatComposition";

/** Actual production source in a native worker; only message transport is adapted. */
function workerSession() {
  const worker = new Worker(
    `const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};
    ${GRASS_WORKER_CODE}
    parentPort.on('message',data=>self.onmessage({data}));`,
    { eval: true, env: {} },
  );
  return {
    run(input: GrassWorkerInput) {
      return new Promise<GrassWorkerOutput>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Actual worker deadline")),
          10000,
        );
        const onError = (error: Error) => finish(error);
        const onMessage = (message: {
          result?: GrassWorkerOutput;
          error?: string;
        }) => {
          if (message.error) finish(new Error(message.error));
          else if (message.result) {
            finish();
            resolve(message.result);
          }
        };
        function finish(error?: Error) {
          clearTimeout(timer);
          worker.off("error", onError);
          worker.off("message", onMessage);
          if (error) reject(error);
        }
        worker.once("error", onError);
        worker.once("message", onMessage);
        worker.postMessage(input);
      });
    },
    close: () => worker.terminate(),
  };
}

async function fixture(
  profile: WorldTerrainProfile = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  previousPlaza = false,
  previousCampus = previousPlaza,
) {
  await DataManager.getInstance().initialize();
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  terrain.getWorldTerrainProfile();
  // Isolated historical sampler selection before real init. Non-shape config is
  // identical; do not mutate DataManager or replace any generator/material method.
  terrain["activeTerrainProfile"] = profile;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  if (previousCampus) {
    const grade = terrain["flatZones"].get("duel_arena_campus_grade")!;
    terrain.registerFlatZone({ ...grade, excludeGrass: undefined });
  }
  if (previousPlaza) {
    // Explicit historical surface fixture. Preserve old census oracles when
    // comparing terrain algorithms; the current manifest is tested separately.
    terrain.unregisterFlatZone("central_haven_lodge_grass_clearance");
    terrain["landscapeGrassSurface"].exclusionPolygons = [];
    const plaza = terrain["flatZones"].get("central_haven_plaza")!;
    terrain.registerFlatZone({ ...plaza, excludeGrass: undefined });
  }
  terrain["subscribeRoadNetworkEvents"]();
  await roads.init();
  await roads.start();
  const setup = terrain["buildGrassWorkerSetup"]();
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
  const nodes = [
    [450, 350],
    [250, 350],
    [350, 350],
    [350, 450],
    [450, 450],
    [350, 250],
  ].map(([x, z]) => tree.createNode(null, null, 100, x, z, 4));
  const allNodes = new Map(
    nodes.map((node) => [`${node.centerX},${node.centerZ}`, node]),
  );
  function ensureSurface(node: (typeof nodes)[number]) {
    if (!visual.getRetainedSurface(node)) visual["generateChunkSync"](node);
    return visual.getRetainedSurface(node);
  }
  function installSupport(node: (typeof nodes)[number]) {
    for (const dx of [-100, 0, 100])
      for (const dz of [-100, 0, 100]) {
        const x = node.centerX + dx,
          z = node.centerZ + dz,
          key = `${x},${z}`;
        let adjacent = allNodes.get(key);
        if (!adjacent) {
          adjacent = tree.createNode(null, null, 100, x, z, 4);
          allNodes.set(key, adjacent);
        }
        ensureSurface(adjacent);
      }
  }
  const managers: GrassVisualManager[] = [];
  const worker = workerSession();
  function manager(
    profile: GrassVisualProfile,
    regionOwner = true,
    appearance?: "natural-tuft-v1",
    habitat?: ConstructorParameters<typeof GrassVisualManager>[14],
  ) {
    const container = new THREE.Group();
    const owner = new GrassVisualManager(
      setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
      container,
      ensureSurface,
      (x, z) => terrain["getHeightAtComputed"](x, z),
      setup.terrainConfig.WATER_THRESHOLD,
      (x, z) => terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
      (x, z) => terrain.isGrassExcludedAt(x, z),
      (x, z, eligibility) => terrain.getTerrainColorAt(x, z, true, eligibility),
      setup,
      profile,
      undefined,
      (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
      regionOwner
        ? (bounds) => visual.captureRetainedSurfaceRegion(bounds)
        : undefined,
      appearance,
      habitat,
    );
    owner.setPlayerPosition(385, 374);
    managers.push(owner);
    return { owner, container };
  }
  return {
    world,
    terrain,
    setup,
    tree,
    nodes,
    worker,
    manager,
    visual,
    installSupport,
    async close() {
      await worker.close();
      for (const owner of managers) owner.destroy();
      visual.dispose();
      material.dispose();
      world.destroy();
    },
  };
}

describe("opt-in compact grass, actual terrain and native worker (not GPU proof)", () => {
  async function queueGrounding(
    f: Awaited<ReturnType<typeof fixture>>,
    owner: GrassVisualManager,
    node = f.nodes[0],
    empty = false,
  ) {
    owner.onNodeNeedsGeometry(node);
    const key = owner["chunkKey"](node),
      ticket = owner["createWorkerTicket"](node, key, 1, false);
    const data = await f.worker.run(owner["createWorkerInput"](node, key, 1));
    // Explicit valid empty input exercises completion, not a simulated worker.
    const output = empty
      ? {
          ...data,
          count: 0,
          offsets: new Float32Array(),
          rotScaleHash: new Float32Array(),
          groundColors: new Float32Array(),
          grassTints: new Float32Array(),
          groundNormals: new Float32Array(),
        }
      : data;
    owner["settleWorkerResult"](ticket, output);
    expect(owner["processSettledWorkerResults"]()).toBe(0);
    const entry = owner["groundingJobs"].get(key)!;
    expect(entry).toBeDefined();
    return { key, entry, data };
  }
  function finishGrounding(owner: GrassVisualManager, key: string) {
    let frames = 0,
      uploads = 0;
    while (
      owner["groundingJobs"].get(key)?.job.state.status === "running" &&
      frames++ < 1000
    )
      uploads += owner["advanceGroundingJob"]();
    expect(frames).toBeLessThan(1000);
    return uploads;
  }

  it("keeps all six real worker populations and full grounded buffers exact when only habitat root color is enabled", async () => {
    const f = await fixture(HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE);
    try {
      const field = f.terrain["getCompactHabitatMaterial"](
        "haven-understory-v1",
      );
      expect(field).not.toBeNull();
      const baseline = f.manager(
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
        true,
        "natural-tuft-v1",
      ).owner;
      const candidate = f.manager(
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
        true,
        "natural-tuft-v1",
        field,
      ).owner;
      const attributes = [
        "instanceOffset",
        "instanceRotScaleHash",
        "instanceGroundColor",
        "instanceGrassTint",
        "instanceGroundNormal",
        "grassRootDeltas",
        "position",
        "normal",
        "uv",
      ];
      let total = 0,
        insideHabitat = 0;
      for (const node of f.nodes) {
        f.installSupport(node);
        const before = await queueGrounding(f, baseline, node);
        const after = await queueGrounding(f, candidate, node);
        expect(after.data.count).toBe(before.data.count);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundColors",
          "grassTints",
          "groundNormals",
        ] as const)
          expect(after.data[key]).toEqual(before.data[key]);
        expect(finishGrounding(baseline, before.key)).toBe(1);
        expect(finishGrounding(candidate, after.key)).toBe(1);
        const a = candidate["chunks"].get(after.key)!,
          b = baseline["chunks"].get(before.key)!;
        for (const material of [candidate["material"], a.mesh.material]) {
          expect(Array.isArray(material)).toBe(false);
          if (Array.isArray(material))
            throw new Error("One grass material required");
          expect(material.userData.compactHabitatComposition).toBe(field);
          expect(
            Object.getOwnPropertyDescriptor(
              material.userData,
              "compactHabitatComposition",
            ),
          ).toEqual({
            value: field,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        }
        expect(a.mesh.material).not.toBe(candidate["material"]);
        expect(Array.isArray(b.mesh.material)).toBe(false);
        if (Array.isArray(b.mesh.material))
          throw new Error("One grass material required");
        expect(
          b.mesh.material.userData.compactHabitatComposition,
        ).toBeUndefined();
        expect(a.mesh.count).toBe(b.mesh.count);
        expect(a.mesh.userData.grassBladeGrounding.sourceIndices).toEqual(
          b.mesh.userData.grassBladeGrounding.sourceIndices,
        );
        expect(a.mesh.userData.grassBladeGrounding.sweptBounds).toEqual(
          b.mesh.userData.grassBladeGrounding.sweptBounds,
        );
        expect(a.mesh.userData.grassBladeGrounding.rejected).toEqual(
          b.mesh.userData.grassBladeGrounding.rejected,
        );
        expect(a.box).toEqual(b.box);
        expect(a.mesh.boundingBox).toEqual(b.mesh.boundingBox);
        expect(a.mesh.boundingSphere).toEqual(b.mesh.boundingSphere);
        expect(a.mesh.geometry.index!.array).toEqual(
          b.mesh.geometry.index!.array,
        );
        expect(Object.keys(a.mesh.geometry.attributes).sort()).toEqual(
          Object.keys(b.mesh.geometry.attributes).sort(),
        );
        for (const name of attributes) {
          const aa = a.mesh.geometry.getAttribute(name),
            ba = b.mesh.geometry.getAttribute(name);
          expect(aa.itemSize).toBe(ba.itemSize);
          expect(aa.count).toBe(ba.count);
          expect(aa.normalized).toBe(ba.normalized);
          expect(aa.array.constructor).toBe(ba.array.constructor);
          expect(
            new Uint8Array(
              aa.array.buffer,
              aa.array.byteOffset,
              aa.array.byteLength,
            ),
          ).toEqual(
            new Uint8Array(
              ba.array.buffer,
              ba.array.byteOffset,
              ba.array.byteLength,
            ),
          );
        }
        for (const owner of [baseline, candidate]) {
          const completed = owner["completedGrounding"].get(before.key)!;
          expect(completed.region.isCurrent()).toBe(true);
          expect(completed.inputs.isCurrent()).toBe(true);
        }
        const offsets = a.mesh.geometry.getAttribute("instanceOffset");
        for (let i = 0; i < a.mesh.count; i++)
          if (
            sampleCompactHabitatSoil(
              node.centerX + offsets.getX(i),
              node.centerZ + offsets.getZ(i),
              field,
            ) > 0
          )
            insideHabitat++;
        total += a.mesh.count;
      }
      expect(total).toBeGreaterThan(0);
      expect(insideHabitat).toBeGreaterThan(0);
      expect(candidate.getProfileReceipt().installedClumps).toBe(
        baseline.getProfileReceipt().installedClumps,
      );
      for (const owner of [baseline, candidate])
        expect(owner.getProfileReceipt()).toMatchObject({
          installedChunks: 6,
          grounding: { runningChunks: 0, failedChunks: 0, completedChunks: 6 },
        });
    } finally {
      await f.close();
    }
  }, 120_000);

  it("grounds the natural tuft candidate against all six real leaves without reseeding or bypassing rejection", async () => {
    const f = await fixture();
    try {
      const baseline = f.manager(DENSE_MEADOW_GRASS_VISUAL_PROFILE).owner;
      const candidate = f.manager(
        DENSE_MEADOW_GRASS_VISUAL_PROFILE,
        true,
        NATURAL_TUFT_APPEARANCE.id,
      ).owner;
      const census: {
        leaf: number[];
        input: number;
        baseline: number;
        candidate: number;
        common: number;
      }[] = [];
      for (const node of f.nodes) {
        f.installSupport(node);
        const before = await queueGrounding(f, baseline, node);
        const after = await queueGrounding(f, candidate, node);
        expect(after.data.count).toBe(before.data.count);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundColors",
          "grassTints",
          "groundNormals",
        ] as const)
          expect(after.data[key]).toEqual(before.data[key]);
        expect(finishGrounding(baseline, before.key)).toBe(1);
        expect(finishGrounding(candidate, after.key)).toBe(1);
        const oldMesh = baseline["chunks"].get(before.key)!.mesh;
        const mesh = candidate["chunks"].get(after.key)!.mesh;
        const oldSources = oldMesh.userData.grassBladeGrounding
          .sourceIndices as Uint32Array;
        const sources = mesh.userData.grassBladeGrounding
          .sourceIndices as Uint32Array;
        const oldIndices = new Map(
          [...oldSources].map((source, i) => [source, i]),
        );
        const evidence = mesh.userData.grassBladeGrounding;
        expect(mesh.userData.grassAppearance).toBe(NATURAL_TUFT_APPEARANCE.id);
        expect(evidence.retainedClumps).toBe(mesh.count);
        expect(evidence.maxAcceptedBaseError).toBeLessThanOrEqual(0.02);
        expect(evidence.processedClumps).toBe(evidence.inputClumps);
        expect(mesh.count).toBeLessThanOrEqual(after.data.count);
        expect(new Set(sources).size).toBe(mesh.count);
        expect(mesh.geometry.index!.count / 3).toBe(36);
        const roots = mesh.geometry.getAttribute("grassRootDeltas");
        expect(roots.array.byteLength).toBe(mesh.count * 96);
        for (const value of roots.array)
          expect(Number.isFinite(value)).toBe(true);
        let common = 0;
        for (let i = 0; i < sources.length; i++) {
          if (i) expect(sources[i]).toBeGreaterThan(sources[i - 1]);
          const old = oldIndices.get(sources[i]);
          if (old === undefined) continue;
          common++;
          // Full-root rejection may change the population; shared survivors
          // must retain all actual placement, normal and color components.
          for (const key of [
            "instanceOffset",
            "instanceRotScaleHash",
            "instanceGroundColor",
            "instanceGrassTint",
            "instanceGroundNormal",
          ]) {
            const a = mesh.geometry.getAttribute(key),
              b = oldMesh.geometry.getAttribute(key);
            for (const get of [
              "getX",
              "getY",
              "getZ",
              ...(a.itemSize === 4 ? ["getW" as const] : []),
            ] as const)
              expect(a[get](i)).toBe(b[get](old));
          }
        }
        expect(common).toBeGreaterThan(0);
        expect(candidate.getProfileReceipt().grounding!.failedChunks).toBe(0);
        census.push({
          leaf: [node.centerX, node.centerZ],
          input: after.data.count,
          baseline: oldMesh.count,
          candidate: mesh.count,
          common,
        });
      }
      // This is an actual terrain/worker/grounding census, not GPU timing or
      // an assertion that a shape change leaves accepted populations equal.
      console.info(
        "Natural tuft post-grounding census",
        JSON.stringify(census),
      );
      expect(candidate.getProfileReceipt()).toMatchObject({
        profileId: "compact-meadow-v2",
        minimumLodLevel: 1,
        clumpSpacing: 1.75,
        maxRenderDistance: 140,
        maxChunksPerFrame: 1,
        installedChunks: 6,
        grounding: { runningChunks: 0, failedChunks: 0, completedChunks: 6 },
      });
    } finally {
      await f.close();
    }
  }, 120_000);

  it("keeps grounded grass available to each actual render camera after an earlier update camera rejects it", async () => {
    const f = await fixture();
    try {
      const { owner, container } = f.manager(
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
      );
      const node = f.nodes[2]; // Actual preparation leaf centered at (350,350).
      f.installSupport(node);
      const { key } = await queueGrounding(f, owner, node);
      expect(finishGrounding(owner, key)).toBe(1);
      const chunk = owner["chunks"].get(key)!,
        mesh = chunk.mesh;
      container.updateMatrixWorld(true);
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 10000);
      camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
      camera.updateProjectionMatrix();
      camera.position.set(410, 34, 370);
      camera.lookAt(500, 34, 370); // Earlier director/update view looks away.
      camera.updateMatrixWorld(true);
      owner.update(385, 374, camera);
      const frustum = () =>
        new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
          ),
          camera.coordinateSystem,
          camera.reversedDepth,
        );
      expect(frustum().intersectsBox(chunk.box)).toBe(false);
      // The renderer must decide each pass; an update must not remove the mesh
      // from every later camera's traversal by writing Object3D.visible=false.
      expect(mesh.visible).toBe(true);
      expect(mesh.frustumCulled).toBe(true);
      expect(mesh.intersectsFrustum(frustum())).toBe(false);
      const before = mesh.matrixWorld.toArray();
      camera.position.set(322, 30.019301523097685, 321);
      camera.lookAt(337, 29.219301523097688, 336);
      camera.updateMatrixWorld(true);
      expect(frustum().intersectsBox(chunk.box)).toBe(true);
      expect(mesh.intersectsFrustum(frustum())).toBe(true);
      expect(mesh.matrixWorld.toArray()).toEqual(before);
      const near = camera.clone();
      near.updateMatrixWorld(true);
      // A following pass with another camera must not inherit that decision.
      camera.position.set(410, 34, 370);
      camera.lookAt(500, 34, 370);
      camera.updateMatrixWorld(true);
      expect(mesh.intersectsFrustum(frustum())).toBe(false);
      expect(mesh.visible).toBe(true);
      const array = new THREE.ArrayCamera([camera, near]);
      const multiview = new THREE.FrustumArray().setFromArrayCamera(array);
      expect(mesh.intersectsFrustum(multiview)).toBe(true);
      // The local bound also follows prepared transforms, not a stale world box.
      expect(
        mesh
          .boundingBox!.clone()
          .applyMatrix4(mesh.matrixWorld)
          .equals(chunk.box),
      ).toBe(true);
      container.position.x = -1000;
      container.updateMatrixWorld(true);
      expect(mesh.intersectsFrustum(multiview)).toBe(false);
      near.position.x -= 1000;
      near.updateMatrixWorld(true);
      multiview.setFromArrayCamera(array);
      expect(mesh.intersectsFrustum(multiview)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("installs only complete fitted chunks, keeps independent correction storage, and disposes owned resources exactly once", async () => {
    const f = await fixture();
    try {
      const { owner, container } = f.manager(
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
      );
      for (const node of f.nodes.slice(0, 2)) f.installSupport(node);
      const base = owner["material"],
        disposal = { base: 0, mesh: 0, geometry: 0, material: 0 };
      base.addEventListener("dispose", () => disposal.base++);
      const buffers: ArrayBufferLike[] = [];
      for (const node of f.nodes.slice(0, 2)) {
        const { key, entry } = await queueGrounding(f, owner, node);
        expect(owner.getStreamingReadiness([node], 140).ready).toBe(false);
        expect(entry.job.advance(1).status).toBe("running");
        expect(owner["chunks"].has(key)).toBe(false);
        expect(finishGrounding(owner, key)).toBe(1);
        expect(owner.getStreamingReadiness([node], 140).ready).toBe(true);
        const mesh = owner["chunks"].get(key)!.mesh;
        expect(mesh.material).not.toBe(base);
        expect(mesh.quaternion.toArray()).toEqual([0, 0, 0, 1]);
        expect(mesh.scale.toArray()).toEqual([1, 1, 1]);
        expect(mesh.position.toArray()).toEqual([
          node.centerX,
          0,
          node.centerZ,
        ]);
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(mesh.count - 1, matrix);
        expect(matrix.equals(new THREE.Matrix4())).toBe(true);
        const roots = mesh.geometry.getAttribute("grassRootDeltas");
        expect(roots.array.byteLength).toBe(mesh.count * 96);
        expect(mesh.userData.grassGrounding.computedHeights.length).toBe(
          mesh.count,
        );
        expect(mesh.userData.grassBladeGrounding.sourceIndices.length).toBe(
          mesh.count,
        );
        buffers.push(roots.array.buffer);
        mesh.addEventListener("dispose", () => disposal.mesh++);
        mesh.geometry.addEventListener("dispose", () => disposal.geometry++);
        mesh.material.addEventListener("dispose", () => disposal.material++);
      }
      expect(buffers[0]).not.toBe(buffers[1]);
      const receipt = owner.getProfileReceipt();
      expect(receipt.grounding!.correctionBytes).toBe(
        receipt.installedClumps * 96,
      );
      expect(receipt.grounding).toMatchObject({
        runningChunks: 0,
        failedChunks: 0,
        completedChunks: 2,
      });
      owner.rebuildAllChunks();
      expect(container.children).toHaveLength(0);
      expect(disposal).toEqual({ base: 0, mesh: 2, geometry: 2, material: 2 });
      owner.destroy();
      owner.destroy();
      expect(disposal).toEqual({ base: 1, mesh: 2, geometry: 2, material: 2 });
    } finally {
      await f.close();
    }
  });

  it("keeps missing support asleep, then retires it when a real neighboring terrain mesh arrives", async () => {
    const f = await fixture();
    try {
      const { owner, container } = f.manager(
          COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
        ),
        node = f.nodes[0];
      const waiting = await queueGrounding(f, owner);
      expect(finishGrounding(owner, waiting.key)).toBe(0);
      expect(waiting.entry.job.state.status).toBe("waiting_support");
      const operations = waiting.entry.job.operations;
      for (let frame = 0; frame < 30; frame++) owner.update(385, 374);
      expect(waiting.entry.job.operations).toBe(operations);
      expect(owner["groundingJobs"].get(waiting.key)).toBe(waiting.entry);
      expect(container.children).toHaveLength(0);
      expect(owner.getStreamingReadiness([node], 140).ready).toBe(false);
      f.installSupport(node);
      owner["reconcileGrassHorizon"]();
      expect(owner["groundingJobs"].has(waiting.key)).toBe(false);
      const fresh = await queueGrounding(f, owner);
      expect(finishGrounding(owner, fresh.key)).toBe(1);
      const own = f.visual.getRetainedSurface(node);
      f.visual.invalidateRegion(501, 349, 502, 351);
      expect(f.visual.getRetainedSurface(node)).toBe(own);
      expect(owner.getStreamingReadiness([node], 140).ready).toBe(false);
      owner["reconcileGrassHorizon"]();
      expect(container.children).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("cancels suspended inputs on water arrival or constraint invalidation beyond the old normal-only halo", async () => {
    const f = await fixture();
    try {
      const { owner } = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE),
        node = f.nodes[0];
      f.installSupport(node);
      const first = await queueGrounding(f, owner);
      first.entry.job.advance(8);
      f.terrain.getWaterBodyRegistry().register({
        id: "lease-arrival",
        centerX: 490,
        centerZ: 350,
        radius: 2,
        radiusSq: 4,
        surfaceY: 20,
        sourceType: "explicit",
      });
      owner["reconcileGrassHorizon"]();
      expect(first.entry.job.state.status).toBe("cancelled");
      const next = await queueGrounding(f, owner);
      next.entry.job.advance(8);
      expect(owner["groundingHalo"]).toBeGreaterThan(1);
      owner.invalidateRegion(500.8, 349, 501, 351);
      expect(next.entry.job.state.status).toBe("cancelled");
      expect(owner["groundingJobs"].size).toBe(0);
      expect(owner.getProfileReceipt().installedClumps).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("records a missing owner as terminal failure without retrying or declaring ready, and admits valid empty work", async () => {
    const f = await fixture();
    try {
      const failed = f.manager(
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
        false,
      ).owner;
      const first = await queueGrounding(f, failed);
      expect(finishGrounding(failed, first.key)).toBe(0);
      expect(first.entry.job.state.status).toBe("failed_input");
      for (let frame = 0; frame < 30; frame++) failed.update(385, 374);
      expect(failed["groundingJobs"].get(first.key)).toBe(first.entry);
      expect(failed.getProfileReceipt().grounding!.failedChunks).toBe(1);
      const { owner, container } = f.manager(
        COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
      );
      f.installSupport(f.nodes[0]);
      const empty = await queueGrounding(f, owner, f.nodes[0], true);
      expect(finishGrounding(owner, empty.key)).toBe(0);
      expect(container.children).toHaveLength(0);
      expect(owner.getStreamingReadiness([f.nodes[0]], 140).ready).toBe(true);
      expect(owner.getProfileReceipt().grounding).toMatchObject({
        completedChunks: 1,
        readyEmptyChunks: 1,
        correctionBytes: 0,
      });
    } finally {
      await f.close();
    }
  });

  it("precompiles the real correction layout and releases the sample on either callback success or failure", async () => {
    const f = await fixture();
    try {
      const { owner } = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE),
        disposal = { geometry: 0, material: 0, mesh: 0, base: 0 };
      owner["material"].addEventListener("dispose", () => disposal.base++);
      for (const fail of [false, true]) {
        const work = owner.precompileRepresentativeChunk(async (object) => {
          expect(object).toBeInstanceOf(THREE.InstancedMesh);
          const mesh = object as THREE.InstancedMesh<
            THREE.BufferGeometry,
            THREE.Material
          >;
          expect(
            mesh.geometry.getAttribute("grassRootDeltas").array.byteLength,
          ).toBe(96);
          expect(mesh.material).not.toBe(owner["material"]);
          mesh.geometry.addEventListener("dispose", () => disposal.geometry++);
          mesh.material.addEventListener("dispose", () => disposal.material++);
          mesh.addEventListener("dispose", () => disposal.mesh++);
          if (fail) throw new Error("Deliberate precompile callback rejection");
        });
        if (fail) await expect(work).rejects.toThrow(/Deliberate/);
        else await work;
      }
      expect(disposal).toEqual({ geometry: 2, material: 2, mesh: 2, base: 0 });
    } finally {
      await f.close();
    }
  });

  it("pins quantized-worker buffers in all six coast-baseline v4 leaves", async () => {
    // Measured 2026-09-11 against published b6b3af00e factory in a real worker.
    // Palette SHA256:15cf7643c8dec05ac6f480c0b03ca20aab10bc5f74207ec0f9340b5b9812f910.
    // Worker source SHA256:8e4b4c4fe4f2a5a5639e8ae214f19b6c4e66ce753b30b9f34d99538675fffdb1,
    // byte-identical before/after that earlier coast change. These are HISTORICAL
    // ANALYTIC-worker results, not the repaired texture-aligned sampler oracle.
    // One-off comparison used the original factory,
    // not reimplemented algebra, and compared every element before hashing.
    // No Git CLI/history is required to run this retained regression.
    const historicalAnalytic = [
      [
        450,
        350,
        271,
        "f182c957130d903f1d09ce99efe3d92d0a440560b37af7ee5fd40ad8e7daa164",
        "6414005f88a7bb2afc20c4433d3e8562882a855a54918d6257ca0a9ed06d0956",
        "781177c879353a2be1aa5089c7b5f31a3532134f26a5a5d1a80a5e0c1f747d3e",
        "50929c953a47d2831ab4bb9e03a07331068fee50e54a862cd0d7bb2decb82410",
      ],
      [
        250,
        350,
        503,
        "b874a69c16b795ed2b6a62cab29e37d3fc8aecc18617b8ff2645604441f38f45",
        "b75a842bc5bc9d6ac0d76121f0793bc345e0591ace456659139b0a274d11660a",
        "7e6740c91f7c21b361fbb73984f22afef3896b669f9e2a87d31f6e18e9a48432",
        "c91d3c58a0037f1a43aa536e6797b2585210604c7aa006f351731c3fefbffe10",
      ],
      [
        350,
        350,
        139,
        "4c3de808146aaf1e5f7f2bd63b8ca6ac20fb1beec20cfb8751fc4859a832c647",
        "f544f7e4c3d5bc4397762c29a2d27e7550c1cb1d393e5f954e68750679bcd06d",
        "0490457beeeb50176ad0e3eb207977b25d0883c2d401c3543eb6017bf728de92",
        "55c40ebad9297b397ddeb92e1617b8d26e8b59150061116efdf2ea4e0f2a2ff6",
      ],
      [
        350,
        450,
        532,
        "95fc9dac164150df8288083d6983d0bdb531b1b4b3dc61df534f15ecb129ba34",
        "b40e2116d3fa9b4216be2509e52041becfc729c651259f263e164660eabd3337",
        "2b1b920dc641c4fc04e479010122eb7e8861af9fc9ee2fe3b1e9fcdaaf44ce3b",
        "886eeedcc8a55990839487362ca1279209fc91b5927b1d58db123b6a941398c3",
      ],
      [
        450,
        450,
        493,
        "a290d43449bbfbaf0df4c52b419568ea6f325df588c18b577cdd257797232e04",
        "a00280c1860355b98de6603362f205125c465cd57080f29a29c09f5ee40bf226",
        "e06df083901ad7705f627b9bd377a232b94303edbfbc89b41fa801708314f467",
        "4f0ebfbfd7b91ffe35b255a9545ec0b201df093e4763db8c4236c5b9116d7dfa",
      ],
      [
        350,
        250,
        343,
        "4b0fda3b503bb9545c92b8a3c343700f4de8b66b5c74c0ebe34081deb293f218",
        "e62e719e8e67862b061b19db348ee13d2236f0dd6dc1b10ab0be83e7ebd4d163",
        "1dfd030cba9544202ffa3b1402e496443211a1ffafc714ebe7acb33b5f67b859",
        "c7c9709722f56bbefdd377ae17a1733a253ac9ec847749a397440e0d2c9fe90b",
      ],
    ];
    // Sampler-only correction: GPU texture bytes, geometry, profile and density
    // settings are unmodified,
    // but byte-filtered noise can change acceptance and subsequent RNG use even
    // in leaves whose final counts stay equal. Keep the old complete hashes above.
    const expected = [
      historicalAnalytic[0],
      [
        250,
        350,
        503,
        "ea35d20bea1bd705df0cd1985ff6531f9e1bf2ed04d7c3020c47b739eea300e0",
        "3e084a2eb120406b53281dddf6ad1002db654311008472fa675a387cd09dedd8",
        "7e6740c91f7c21b361fbb73984f22afef3896b669f9e2a87d31f6e18e9a48432",
        "f0e7c2a55509d73359d4e5ef603687d2ce5995bab08a0e3467d0dbddcaf574e0",
      ],
      historicalAnalytic[2],
      [
        350,
        450,
        529,
        "ba56cff67eafc509836bcd01df2185d49a571b9f8b088a9c61e71bfed48b0704",
        "79c0d4dde33573eea75d76772e68c22d0a8b90f1aa431aff1c61538fbaa42951",
        "983f405d430c0a3f827f49b5427bf797a0751b33d2f6eea438c7fe4e61937090",
        "47c885dd1795e80ba0441dc384beeb646323d652f05f59a8029d5ee98261954f",
      ],
      [
        450,
        450,
        493,
        "1bc671970ae18bef258c077a60e2f4d696fa5cf127294ac66b5a0072373a8c6b",
        "82a470c53a60e1fe6223dca920af1d1adce50487ae442fe7fcdb7d00b4a64934",
        "e06df083901ad7705f627b9bd377a232b94303edbfbc89b41fa801708314f467",
        "14aeb5181c010558e46cf3e921d5800db412ca9335421fbc4394d3ec55bad290",
      ],
      [
        350,
        250,
        343,
        "7bd0d542e247b2927f5ecd468420feea3ac79bfa515ab9fceb921c1d79009240",
        "e7423c5f2cfa8d05b3675c2398d564c5b28438337dff113c43d371398ab57c21",
        "1dfd030cba9544202ffa3b1402e496443211a1ffafc714ebe7acb33b5f67b859",
        "1faf5fa9a300001d8306796fc58a67cf95a208564caeeea30563a67b21a1cdf6",
      ],
    ];
    const f = await fixture(SCULPTED_COMPACT_V3_PROFILE_FIXTURE, true);
    try {
      const owner = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
      const receipts = [];
      for (const node of f.nodes) {
        const input = owner["createWorkerInput"](node, `coast_${node.id}`, 1);
        const after = await f.worker.run(input);
        const sync = owner["generateInstanceData"](node, 1)!;
        expect(sync.count).toBe(after.count);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundColors",
          "grassTints",
          "groundNormals",
        ] as const) {
          expect(
            Buffer.from(
              sync[key].buffer,
              sync[key].byteOffset,
              sync[key].byteLength,
            ),
          ).toEqual(
            Buffer.from(
              after[key].buffer,
              after[key].byteOffset,
              after[key].byteLength,
            ),
          );
        }
        const hashes: string[] = [];
        for (const key of [
          "offsets",
          "rotScaleHash",
          "grassTints",
          "groundNormals",
        ] as const) {
          const data = after[key];
          hashes.push(
            createHash("sha256")
              .update(
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
              )
              .digest("hex"),
          );
        }
        receipts.push([node.centerX, node.centerZ, after.count, ...hashes]);
      }
      expect(receipts).toEqual(expected);
      expect(receipts).not.toEqual(historicalAnalytic);
    } finally {
      await f.close();
    }
  }, 20000);

  it("matches physical layer algebra and fails closed on unknown/legacy terrain opt-ins", () => {
    const ops = createCompactTerrainColorOperations();
    const surface = {
      x: 350,
      z: 320,
      height: 28.4,
      pond: null,
      macroField: ops.macroField(SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE),
    };
    for (const noiseValue of [0, 0.2, 0.5, 0.8, 1])
      for (const slope of [0, 0.05, 0.1, 0.2, 0.5]) {
        const input = { noiseValue, distortNoise: 0.37, slope, surface };
        const weights = ops.weights({
          noiseValue,
          slope,
          distortNoise: 0.37,
          roadInfluence: 0,
          pondSurface: { soil: 0, wetness: 0 },
          macroSurface: ops.macroWeights(
            surface.x,
            surface.z,
            noiseValue,
            surface.macroField,
          ),
        });
        expect(ops.grassSupport(input)).toBe(
          (1 - weights.dirt) * (1 - weights.cliff),
        );
      }
    expect(
      ops.grassSupport({
        noiseValue: 0.5,
        distortNoise: 0.5,
        slope: 0,
        surface: {
          x: 343,
          z: 302,
          height: 27,
          pond: {
            id: "haven_pond_water",
            centerX: 343,
            centerZ: 302,
            radius: 7.5,
            surfaceY: 27.8,
          },
        },
      }),
    ).toBe(0);
    expect(ops.grassEligibility(undefined, "compact-island-sculpt-v2")).toBe(
      "legacy-biome-v1",
    );
    for (const value of [null, false, true, "compact", "legacy", {}])
      expect(() =>
        ops.grassEligibility(value, "compact-island-sculpt-v2"),
      ).toThrow();
    expect(() =>
      ops.grassEligibility("compact-pbr-v1", "compact-island-sculpt-v1"),
    ).toThrow();
  });

  it("changes only grass root colour inside admitted soil, preserving every worker placement byte", async () => {
    const f = await fixture();
    try {
      const { owner } = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
      const ops = createCompactTerrainColorOperations();
      let changedColours = 0;
      for (const node of f.nodes) {
        const input = owner["createWorkerInput"](
          node,
          owner["chunkKey"](node),
          1,
        );
        expect(input.compactPlantingLobes).toHaveLength(4);
        const [before, after] = [
          await f.worker.run({ ...input, compactPlantingLobes: [] }),
          await f.worker.run(input),
        ];
        expect(after.count).toBe(before.count);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "grassTints",
          "groundNormals",
        ] as const)
          expect(new Uint8Array(after[key].buffer)).toEqual(
            new Uint8Array(before[key].buffer),
          );
        for (let i = 0; i < after.count; i++) {
          const changed = [0, 1, 2].some(
            (channel) =>
              after.groundColors[i * 3 + channel] !==
              before.groundColors[i * 3 + channel],
          );
          if (!changed) continue;
          changedColours++;
          const x = node.centerX + after.offsets[i * 3];
          const z = node.centerZ + after.offsets[i * 3 + 2];
          expect(
            ops.plantingSoil(x, z, 0.5, input.compactPlantingLobes),
          ).toBeGreaterThan(0);
        }
      }
      expect(changedColours).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  it("grounds the current natural plaza with unchanged density, actual worker/CPU parity and retained service exclusions", async () => {
    const f = await fixture();
    try {
      const { owner } = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
      const counts: number[] = [];
      for (const node of f.nodes) {
        const input = owner["createWorkerInput"](
          node,
          owner["chunkKey"](node),
          1,
        );
        const output = await f.worker.run(input);
        const sync = owner["generateInstanceData"](node, 1)!;
        expect(sync.count).toBe(output.count);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundColors",
          "grassTints",
          "groundNormals",
        ] as const)
          for (let i = 0; i < sync[key].length; i++)
            expect(sync[key][i]).toBeCloseTo(output[key][i], 4);
        counts.push(output.count);
      }
      process.stdout.write(
        `Current plaza worker census: ${JSON.stringify(counts)}\n`,
      );
      // Same sampling/density: two campus and eight northern clumps now fall
      // inside the authored all-LOD rock silhouettes. Other leaves unchanged.
      expect(counts).toEqual([715, 552, 1008, 1199, 820, 341]);
      const node = f.nodes[2];
      f.installSupport(node);
      const { key, entry, data } = await queueGrounding(f, owner, node);
      expect(data.count).toBe(counts[2]);
      const uploads = finishGrounding(owner, key);
      expect(
        uploads,
        JSON.stringify({
          status: entry.job.state.status,
          activeMs: entry.job.activeMs,
          operations: entry.job.operations,
          maximumSliceMs: entry.job.maximumSliceMs,
        }),
      ).toBe(1);
      const state = entry.job.state;
      expect(state.status).toBe("ready");
      if (state.status !== "ready")
        throw new Error("Current plaza failed actual grounding");
      const result = state.result;
      let naturalPlazaClumps = 0;
      for (let i = 0; i < result.data.count; i++) {
        const x = node.centerX + result.data.offsets[i * 3];
        const z = node.centerZ + result.data.offsets[i * 3 + 2];
        expect(f.terrain["isGrassExcludedAt"](x, z)).toBe(false);
        expect(
          f.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
        ).toBeLessThanOrEqual(0.8);
        if (x >= 326 && x <= 374 && z >= 296 && z <= 344) naturalPlazaClumps++;
      }
      process.stdout.write(
        `Landscape plaza grounding census: ${JSON.stringify({ accepted: result.data.count, naturalPlazaClumps })}\n`,
      );
      // Two root exclusions plus one additional swept-blade exclusion.
      expect(result.data.count).toBe(933);
      expect(naturalPlazaClumps).toBe(110);
      expect(result.receipt.rejected.pad).toBeGreaterThan(0);
      expect(result.receipt.maxAcceptedBaseError).toBeLessThanOrEqual(0.05);
      expect(result.rootDeltas.byteLength).toBe(result.data.count * 96);
      expect(owner["chunks"].get(key)!.mesh.count).toBe(result.data.count);
      process.stdout.write(
        `Current plaza grounded census: ${JSON.stringify({ accepted: result.data.count, naturalPlazaClumps, receipt: result.receipt })}\n`,
      );
    } finally {
      await f.close();
    }
  });

  it.each([
    {
      profile: SCULPTED_COMPACT_V2_PROFILE_FIXTURE,
      historicalAnalytic: {
        fixedLod2: 12,
        fixedLod1: 337,
        total: 2130,
        leaves: [271, 503, 139, 510, 364, 343],
      },
      total: 2129,
      fixedLod1: 384,
      fixedLeaves: [178, 72, 9, 0, 120, 5],
      leaves: [271, 503, 139, 506, 367, 343],
    },
    {
      profile: SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
      historicalAnalytic: {
        fixedLod2: 12,
        fixedLod1: 337,
        total: 2281,
        leaves: [271, 503, 139, 532, 493, 343],
      },
      total: 2278,
      fixedLod1: 384,
      fixedLeaves: [178, 72, 9, 0, 120, 5],
      leaves: [271, 503, 139, 529, 493, 343],
    },
    {
      profile: SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
      historicalAnalytic: {
        fixedLod2: 12,
        fixedLod1: 334,
        total: 2298,
        leaves: [271, 520, 139, 532, 493, 343],
      },
      total: 2295,
      fixedLod1: 377,
      fixedLeaves: [178, 65, 9, 0, 120, 5],
      leaves: [271, 520, 139, 529, 493, 343],
    },
    {
      profile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      historicalAnalytic: {
        fixedLod2: 12,
        fixedLod1: 334,
        total: 2273,
        leaves: [271, 495, 139, 532, 493, 343],
      },
      total: 2270,
      fixedLod1: 380,
      fixedLeaves: [178, 68, 9, 0, 120, 5],
      leaves: [271, 495, 139, 529, 493, 343],
    },
  ])(
    "pins quantized sampling on the previous plaza's native-worker census for $profile.id",
    async ({
      profile,
      historicalAnalytic,
      total: candidateTotal,
      fixedLod1,
      fixedLeaves,
      leaves,
    }) => {
      const f = await fixture(profile, true);
      try {
        const fixed = f.manager(STREAMING_GRASS_VISUAL_PROFILE).owner;
        const candidate = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
        const variants = [
          {
            owner: fixed,
            lod: 2,
            total: 13,
            campus: 0,
            leaves: [9, 0, 0, 0, 4, 0],
          },
          {
            owner: fixed,
            lod: 1,
            total: fixedLod1,
            campus: 0,
            leaves: fixedLeaves,
          },
          {
            owner: candidate,
            lod: 1,
            total: candidateTotal,
            campus: 143,
            leaves,
          },
        ];
        // The unconditional sampler repair also changes ordinary fixed-arena
        // eligibility, not only the compact opt-in. Retain all old oracles and
        // pin the corrected counts per leaf, with exact CPU/worker buffer parity.
        const census = [];
        const expectedCensus = [];
        for (const variant of variants) {
          const leafCounts = [];
          let total = 0,
            campus = 0;
          for (const node of f.nodes) {
            const input = variant.owner["createWorkerInput"](
              node,
              `grass_${node.id}`,
              variant.lod,
            );
            expect(input.grassConfigs.forest.minGrassWeight).toBe(0.6);
            const output = await f.worker.run(input);
            expect(output.grassEligibility).toBe(input.grassEligibility);
            total += output.count;
            leafCounts.push([node.centerX, node.centerZ, output.count]);
            for (let i = 0; i < output.count; i++) {
              const x = node.centerX + output.offsets[i * 3],
                z = node.centerZ + output.offsets[i * 3 + 2],
                y = output.offsets[i * 3 + 1];
              if (x >= 314 && x < 386 && z >= 284 && z < 356) campus++;
              expect(f.terrain.isGrassExcludedAt(x, z)).toBe(false);
              expect(y).toBeGreaterThanOrEqual(
                f.terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z) +
                  0.1 -
                  1e-4,
              );
              expect(
                f.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
              ).toBeLessThanOrEqual(0.8);
            }
            {
              const sync = variant.owner["generateInstanceData"](
                node,
                GRASS_CONFIG.LOD_TIERS[variant.lod].spacingMul,
              );
              expect(sync?.count ?? 0).toBe(output.count);
              if (sync)
                for (const name of [
                  "offsets",
                  "rotScaleHash",
                  "groundColors",
                  "grassTints",
                  "groundNormals",
                ] as const) {
                  expect(sync[name].length).toBe(output[name].length);
                  expect(
                    Buffer.from(
                      sync[name].buffer,
                      sync[name].byteOffset,
                      sync[name].byteLength,
                    ),
                  ).toEqual(
                    Buffer.from(
                      output[name].buffer,
                      output[name].byteOffset,
                      output[name].byteLength,
                    ),
                  );
                }
            }
          }
          process.stdout.write(
            `Actual grass profile census: ${JSON.stringify({ profile: profile.id, eligibility: variant.owner.getProfileReceipt().eligibility, lod: variant.lod, leafCounts, total, campus })}\n`,
          );
          census.push({
            lod: variant.lod,
            eligibility: variant.owner.getProfileReceipt().eligibility,
            total,
            campus,
            leaves: leafCounts.map((row) => row[2]),
          });
          expectedCensus.push({
            lod: variant.lod,
            eligibility: variant.owner.getProfileReceipt().eligibility,
            total: variant.total,
            campus: variant.campus,
            leaves: variant.leaves,
          });
          if (variant.owner === candidate) {
            process.stdout.write(
              `Quantized compact grass CPU census (actual native worker, unchanged density; not GPU cost): ${JSON.stringify({ profile: profile.id, leafCounts, total, campus, nominalTriangles: total * 36 })}\n`,
            );
          }
        }
        process.stdout.write(
          `Historical analytic versus corrected quantized census: ${JSON.stringify({ profile: profile.id, historicalAnalytic, quantized: census })}\n`,
        );
        expect(census).toEqual(expectedCensus);
        expect(candidate["lodGeometries"][1].index!.count / 3).toBe(36);
        expect(candidate.getProfileReceipt()).toMatchObject({
          profileId: "compact-island-v1",
          eligibility: "compact-pbr-v1",
          minimumLodLevel: 1,
          clumpSpacing: 2.8,
          maxRenderDistance: 140,
          maxChunksPerFrame: 1,
          castShadow: false,
        });
        expect(fixed.getProfileReceipt()).toMatchObject({
          profileId: "fixed-arena-v1",
          eligibility: "legacy-biome-v1",
          minimumLodLevel: 2,
        });
      } finally {
        await f.close();
      }
    },
    20000,
  );

  it("measures both changed terrace leaves including the western leaf outside the fixed camera census", async () => {
    const results = [];
    for (const profile of [
      SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
      SCULPTED_COMPACT_V4_PROFILE_FIXTURE,
    ]) {
      const f = await fixture(profile, false, true);
      try {
        const owner = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
        const counts = [];
        for (const z of [350, 450]) {
          const node = f.tree.createNode(null, null, 100, 250, z, 4);
          const output = await f.worker.run(
            owner["createWorkerInput"](node, owner["chunkKey"](node), 1),
          );
          const sync = owner["generateInstanceData"](node, 1);
          expect(sync?.count ?? 0).toBe(output.count);
          if (sync)
            for (const name of [
              "offsets",
              "rotScaleHash",
              "groundNormals",
              "groundColors",
              "grassTints",
            ] as const) {
              expect(sync[name].length).toBe(output[name].length);
              expect(
                Buffer.from(
                  sync[name].buffer,
                  sync[name].byteOffset,
                  sync[name].byteLength,
                ),
              ).toEqual(
                Buffer.from(
                  output[name].buffer,
                  output[name].byteOffset,
                  output[name].byteLength,
                ),
              );
            }
          counts.push(output.count);
        }
        results.push({ profile: profile.id, counts });
      } finally {
        await f.close();
      }
    }
    process.stdout.write(
      `Both terrace leaf grass census: ${JSON.stringify(results)}\n`,
    );
    const historicalAnalytic = [
      { profile: "compact-duel-island-v4", counts: [503, 632] },
      { profile: "compact-duel-island-v5", counts: [520, 657] },
    ];
    expect(results).toEqual([
      historicalAnalytic[0],
      { profile: "compact-duel-island-v5", counts: [520, 654] },
    ]);
    expect(results).not.toEqual(historicalAnalytic);
  });

  it("tags actual results and rejects tainted modes before generation or pool availability", async () => {
    const f = await fixture();
    try {
      const candidate = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
      const node = f.nodes[2],
        key = candidate["chunkKey"](node);
      const input = candidate["createWorkerInput"](node, key, 1);
      const legacy = await f.worker.run({
        ...input,
        grassEligibility: undefined,
      });
      const explicit = await f.worker.run({
        ...input,
        grassEligibility: "legacy-biome-v1",
      });
      expect(explicit).toEqual(legacy);
      candidate.onNodeNeedsGeometry(node);
      const ticket = candidate["createWorkerTicket"](node, key, 1, false);
      expect(() => candidate["settleWorkerResult"](ticket, legacy)).toThrow(
        /eligibility mismatch/,
      );
      const unknown = {
        ...input,
        grassEligibility: "compact",
      } as unknown as GrassWorkerInput;
      await expect(f.worker.run(unknown)).rejects.toThrow(/eligibility/);
      await expect(generateGrassPlacementsAsync(unknown)).rejects.toThrow(
        /eligibility/,
      );
      const oldProfile = SCULPTED_COMPACT_V1_PROFILE_FIXTURE;
      await expect(
        f.worker.run({
          ...input,
          config: createTerrainWorkerConfig(oldProfile, 4),
        }),
      ).rejects.toThrow(/eligibility/);
      for (const change of [
        { minimumLodLevel: 2 },
        { clumpSpacingMultiplier: 1 },
        { maxRenderDistance: 500 },
        { maxChunksPerFrame: 2 },
        { eligibility: "legacy-biome-v1" as const },
      ]) {
        expect(() =>
          f.manager({ ...COMPACT_ISLAND_GRASS_VISUAL_PROFILE, ...change }),
        ).toThrow(/profile mismatch/);
      }
    } finally {
      await f.close();
    }
  });

  it("retires old-profile inflight/settled work on destroy and preserves one-upload/horizon guards", async () => {
    const f = await fixture();
    try {
      const old = f.manager(STREAMING_GRASS_VISUAL_PROFILE);
      const next = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
      const node = f.nodes[2],
        key = old.owner["chunkKey"](node);
      old.owner.onNodeNeedsGeometry(node);
      const ticket = old.owner["createWorkerTicket"](node, key, 2, false);
      const output = await f.worker.run(
        old.owner["createWorkerInput"](node, key, 2),
      );
      old.owner.destroy();
      old.owner["settleWorkerResult"](ticket, output);
      old.owner["rejectWorkerResult"](ticket, new Error("late old profile"));
      expect(old.owner.getProfileReceipt()).toMatchObject({
        destroyed: true,
        inflightChunks: 0,
        settledChunks: 0,
        installedClumps: 0,
      });
      for (const n of f.nodes.slice(0, 3)) {
        f.installSupport(n);
        next.owner.onNodeNeedsGeometry(n);
        const k = next.owner["chunkKey"](n),
          t = next.owner["createWorkerTicket"](n, k, 1, false);
        next.owner["settleWorkerResult"](
          t,
          await f.worker.run(next.owner["createWorkerInput"](n, k, 1)),
        );
      }
      expect(next.owner["processSettledWorkerResults"]()).toBe(0);
      expect(next.container.children).toHaveLength(0);
      expect(next.owner.getProfileReceipt().settledChunks).toBe(2);
      expect(next.owner.getProfileReceipt().grounding).toMatchObject({
        runningChunks: 1,
        completedChunks: 0,
      });
      let uploaded = 0;
      for (let frame = 0; frame < 1000 && !uploaded; frame++)
        uploaded += next.owner["advanceGroundingJob"]();
      expect(uploaded).toBe(1);
      expect(next.container.children).toHaveLength(1);
      expect(next.owner.getProfileReceipt().settledChunks).toBe(2);
      next.owner.update(1000, 1000);
      expect(next.container.children).toHaveLength(0);
      expect(next.owner.getProfileReceipt().installedClumps).toBe(0);
      expect(GRASS_CONFIG.LOD_TIERS[1].bladesPerClump).toBe(12);
    } finally {
      await f.close();
    }
  });
});
