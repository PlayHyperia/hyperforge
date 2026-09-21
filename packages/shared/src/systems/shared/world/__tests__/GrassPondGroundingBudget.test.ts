import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { loadPhysX } from "../../../../physics/PhysXManager";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { ProceduralDocks } from "../ProceduralDocks";
import { TerrainVisualManager } from "../TerrainVisualManager";
import {
  FINE_MEADOW_APPEARANCE,
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  GRASS_CONFIG,
  GrassVisualManager,
} from "../GrassVisualManager";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import {
  groundGrassBladeSteps,
  GrassGroundingContinuation,
  type GrassBladeGroundingRequest,
} from "../GrassBladeGrounding";
import { prepareGroundedGrassSteps } from "../GrassGroundingPipeline";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { groundGrassBlades as legacyGroundGrassBlades } from "./fixtures/LegacyGrassBladeGroundingReference";

const attributes = [
  ["offsets", 3],
  ["rotScaleHash", 3],
  ["groundColors", 3],
  ["grassTints", 4],
  ["groundNormals", 3],
] as const;

// Bypass the test runner's passing-console suppression for durable diagnostic
// receipts. This never writes assets or changes any runtime owner.
const evidence = (label: string, json: string) =>
  process.stdout.write(`${label} ${json}\n`);

/** Offline observation of the actual generator, never an installation loop.
 * A complete scratch/merge×2/copy×2/edge×2 trace uniquely identifies the
 * existing two-interval sort. Keep the prospective pair-order label separate
 * so the before/after evidence does not silently relabel historical work. */
function drainGroundingWithPhaseAudit(request: GrassBladeGroundingRequest) {
  const steps = groundGrassBladeSteps(request);
  const phases: Record<string, number> = {};
  let coreResumptions = 0;
  let completeTwoIntervalMergeSorts = 0;
  let mergeSortTrace = "";
  const finishSort = () => {
    if (mergeSortTrace === "smmccee") completeTwoIntervalMergeSorts++;
    mergeSortTrace = "";
  };
  let step = steps.next();
  coreResumptions++;
  while (!step.done) {
    const phase = step.value;
    phases[phase] = (phases[phase] ?? 0) + 1;
    if (phase === "interval_scratch_allocation") {
      finishSort();
      mergeSortTrace = "s";
    } else if (
      mergeSortTrace &&
      (phase === "interval_merge" ||
        phase === "interval_copy" ||
        phase === "edge_interval")
    ) {
      // A longer trace cannot be the two-interval signature. Bound diagnostic
      // storage rather than retaining a trace proportional to triangle count.
      mergeSortTrace =
        mergeSortTrace.length < 8
          ? mergeSortTrace +
            (phase === "interval_merge"
              ? "m"
              : phase === "interval_copy"
                ? "c"
                : "e")
          : "not-pair";
    } else finishSort();
    step = steps.next();
    coreResumptions++;
  }
  finishSort();
  return {
    result: step.value,
    audit: {
      coreResumptions,
      phases,
      completeTwoIntervalMergeSorts,
      intervalPairOrders: phases.interval_pair_order ?? 0,
      scope:
        "One actual offline core drain; resumptions include the terminal next(). Sort signatures and phase counts are work observations, not CPU or GPU timing.",
    },
  };
}

// Explicit real-asset regressions: none of these overlays is a production default.
// Each uses its actual worker output, authored constraints and retained mesh.
const cases = [
  {
    name: "review52 retained pond grass work budget",
    test: "grounds the full native-failing northwest cell at near LOD without increasing its work cap",
    enabled: process.env.ASSETS_DIR?.includes(
      "/terrain-pond-review52-UNQUALIFIED/assets",
    ),
    label: "REVIEW52_NORTHWEST",
    nodes: [
      [350, 250],
      [350, 350],
    ],
    focus: [337.5, 287.5],
    key: "gcell_v1_13_11",
    bounds: { minX: 325, maxX: 350, minZ: 275, maxZ: 300 },
  },
  {
    name: "native35 retained pond southbank grass work budget",
    test: "grounds the full native-failing southbank cell at near LOD without increasing its work cap",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v7",
    ),
    label: "NATIVE35_SOUTHBANK",
    // The work cell touches the x400 leaf boundary. Its unmodified grounding
    // halo therefore leases both real 100m leaves, not a fabricated surface.
    nodes: [
      [450, 450],
      [350, 450],
    ],
    focus: [435, 452],
    key: "gcell_v1_16_17",
    bounds: { minX: 400, maxX: 425, minZ: 425, maxZ: 450 },
  },
  {
    name: "southern headland retained pond grass work budget",
    test: "grounds the reshaped southbank against its actual retained terrain without increasing its work cap",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v8",
    ),
    label: "HEADLAND_SOUTHBANK",
    nodes: [
      [450, 450],
      [350, 450],
    ],
    focus: [435, 452],
    key: "gcell_v1_16_17",
    bounds: { minX: 400, maxX: 425, minZ: 425, maxZ: 450 },
  },
  {
    name: "eastern shelf groundcover southbank work budget",
    test: "grounds the shelf study southbank without increasing its work cap",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "SHELF_STUDY_SOUTHBANK",
    nodes: [
      [450, 450],
      [350, 450],
    ],
    focus: [435, 452],
    key: "gcell_v1_16_17",
    bounds: { minX: 400, maxX: 425, minZ: 425, maxZ: 450 },
  },
  {
    name: "eastern shelf groundcover near-water work budget",
    test: "grounds the newly emerged eastern shelf against actual terrain within the original work cap",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "SHELF_STUDY_EASTBANK",
    nodes: [
      [450, 450],
      [450, 350],
    ],
    focus: [442, 420],
    key: "gcell_v1_17_16",
    bounds: { minX: 425, maxX: 450, minZ: 400, maxZ: 425 },
  },
  {
    name: "native52 startup LOD1 southbank work budget",
    test: "grounds the actual shelf southbank at the native52 startup focus and LOD1 within unchanged caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE52_LOD1_SOUTHBANK",
    nodes: [
      [450, 450],
      [350, 450],
    ],
    focus: [335, 431],
    lod: 1,
    key: "gcell_v1_16_17",
    bounds: { minX: 400, maxX: 425, minZ: 425, maxZ: 450 },
    native52: { inputClumps: 1009, retainedClumps: 974, operations: 210813 },
  },
  {
    name: "native52 startup LOD1 eastbank work budget",
    test: "grounds the actual shelf eastbank at the native52 startup focus and LOD1 within unchanged caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE52_LOD1_EASTBANK",
    nodes: [
      [450, 450],
      [450, 350],
    ],
    focus: [335, 431],
    lod: 1,
    key: "gcell_v1_17_16",
    bounds: { minX: 425, maxX: 450, minZ: 400, maxZ: 425 },
    native52: { inputClumps: 994, retainedClumps: 948, operations: 170572 },
  },
] as const;

describe.each(cases)("$name", (scenario) => {
  const test = it.skipIf(!scenario.enabled);
  test(
    scenario.test,
    async () => {
      const lod = "lod" in scenario ? scenario.lod : 0;
      await DataManager.getInstance().initialize();
      const world = new World();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      const roads = world.register(
        "roads",
        RoadNetworkSystem,
      ) as RoadNetworkSystem;
      const material = new THREE.MeshBasicMaterial();
      let visual: TerrainVisualManager | undefined;
      let manager: GrassVisualManager | undefined;
      let worker: Worker | undefined;
      let docks: ProceduralDocks | undefined;
      const failures: unknown[] = [];
      try {
        if ("native52" in scenario) {
          // Match the existing actual dock fixture: native triangle collision
          // must be installed before its owned grass exclusions are published.
          const previousEnvironment = process.env.NODE_ENV;
          process.env.NODE_ENV = "production";
          try {
            await loadPhysX();
          } finally {
            if (previousEnvironment === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousEnvironment;
          }
          await world.physics.init();
          // Select the actual native52 terrain/worker composition on these new
          // owners only. Historical near cases retain their original setup.
          // Lighting/sky are not CPU grounding inputs and are not qualified here.
          terrain["compactPondBlend"] = "composition-v1";
          terrain["compactSurfaceBlend"] = "height-v1";
          terrain["compactCoastBlend"] = null;
          terrain["compactDirtProjection"] = "stochastic-v1";
          terrain["compactRockProjection"] = "stochastic-v1";
          terrain["compactGrassColorGrade"] = "fine-meadow-green-v1";
        }
        await terrain.init();
        if ("native52" in scenario) {
          // Composition binds and seals these real owners during init. Do not
          // reload them after admission or bypass their restart-only contract.
          expect(
            terrain
              .getWaterBodyRegistry()
              .getAllBodies()
              .filter((body) => body.id === "haven_pond_water"),
          ).toHaveLength(1);
          expect(terrain["flatZones"].has("haven_pond_floor")).toBe(true);
        } else {
          // Preserve the original lifecycle of every historical near case.
          terrain["loadWaterBodiesFromManifest"]();
          terrain["loadFlatZonesFromManifest"]();
        }
        terrain["subscribeRoadNetworkEvents"]();
        await roads.init();
        await roads.start();
        if ("native52" in scenario) {
          docks = world.register("docks", ProceduralDocks) as ProceduralDocks;
          await docks.init();
          await docks.start();
          const diagnostics = docks.getCompactDiagnostics();
          expect(diagnostics.map((dock) => dock.id)).toEqual([
            "haven-fishing-landing",
            "haven-reed-jetty",
          ]);
          expect(
            diagnostics.every(
              (dock) =>
                dock.physicsActor && dock.physicsShape && dock.tiles === 24,
            ),
          ).toBe(true);
          expect(
            terrain["landscapeGrassSurface"].exclusionPolygons
              .filter((polygon) => polygon.id.startsWith("pond-dock-"))
              .map((polygon) => polygon.id),
          ).toEqual([
            "pond-dock-haven-fishing-landing",
            "pond-dock-haven-reed-jetty",
          ]);
        }
        const setup = {
          ...terrain["buildGrassWorkerSetup"](),
          compactGrassColorGrade:
            createCompactTerrainColorOperations().getGrassColorGrade().id,
        };
        if ("native52" in scenario) {
          expect(setup.compactPondBlend).toBe("composition-v1");
          expect(setup.compactPondBankField?.id).toBe("composition-v1");
          expect(setup.compactCoastBlend).toBeUndefined();
          expect(setup.compactGrassColorGrade).toBe("fine-meadow-green-v1");
        }
        visual = new TerrainVisualManager(
          { minSize: 100, maxDepth: 4, resolution: 128, rootChunkRadius: 0 },
          terrain["buildChunkTerrainProvider"](),
          new THREE.Group(),
          material,
          setup.terrainConfig,
          setup.seed,
          setup.biomeCenters,
          setup.biomes,
        );
        const retainedVisual = visual;
        const tree = visual.getQuadTree();
        const nodes = scenario.nodes.map(([x, z]: readonly [number, number]) =>
          tree.createNode(null, null, 100, x, z, 4),
        );
        for (const node of nodes) visual["generateChunkSync"](node);
        const admissionReceipts = nodes.map((node) => {
          const geometry = retainedVisual["chunks"].get(node.visualChunkKey!)!
            .mesh.geometry;
          const started = performance.now();
          const admission = RetainedTerrainSurface.prepare(
            node.id,
            setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
            node.centerX,
            node.centerZ,
            node.size,
            node.resolution,
            geometry,
          );
          let previous = "",
            steps = 0,
            indexSteps = 0,
            indexMs = 0;
          let step = admission.next();
          while (!step.done) {
            previous = step.value;
            steps++;
            const index = previous.startsWith("grounding-edge-index");
            if (index) indexSteps++;
            const resumeAt = performance.now();
            step = admission.next();
            if (index) indexMs += performance.now() - resumeAt;
          }
          expect(step.value.groundingEdgeIndexStats?.admissionSteps).toBe(
            indexSteps,
          );
          return {
            centerX: node.centerX,
            centerZ: node.centerZ,
            elapsedMs: performance.now() - started,
            steps,
            indexMs,
            indexSteps,
            index: step.value.groundingEdgeIndexStats,
            scope:
              "CPU re-admission of exact retained geometry, not native frame qualification",
          };
        });
        manager = new GrassVisualManager(
          setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
          new THREE.Group(),
          (node) => retainedVisual.getRetainedSurface(node),
          (x, z) => terrain["getHeightAtComputed"](x, z),
          setup.terrainConfig.WATER_THRESHOLD,
          (x, z) => terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
          (x, z) => terrain["isGrassExcludedAt"](x, z),
          (x, z, eligibility) =>
            terrain.getTerrainColorAt(x, z, true, eligibility),
          setup,
          {
            ...FINE_MEADOW_GRASS_VISUAL_PROFILE,
            roadClearance: "per-blade-v1",
          },
          undefined,
          (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
          (bounds) => retainedVisual.captureRetainedSurfaceRegion(bounds),
          "fine-meadow-v1",
          terrain["getCompactHabitatMaterial"]("haven-understory-v1"),
          "native52" in scenario ? "leaf-volume-v1" : undefined,
        );
        manager.setPlayerPosition(scenario.focus[0], scenario.focus[1]);
        manager.onNodeNeedsGeometry(nodes[0]);
        const key = scenario.key;
        const work = manager["liveWorkUnits"].get(key)!;
        expect(work.bounds).toEqual(scenario.bounds);
        expect(work.node).toBe(nodes[0]);
        if ("native52" in scenario)
          expect(manager["getLodLevel"](work)).toBe(lod);
        const input = manager["createWorkerInput"](work, key, lod);
        if ("native52" in scenario && key === "gcell_v1_17_16")
          expect(
            input.terrainSurface.exclusionPolygons?.find(
              (polygon) => polygon.id === "pond-dock-haven-reed-jetty",
            ),
          ).toMatchObject({ minX: 427, maxX: 435, minZ: 414, maxZ: 417 });
        expect(input.placementDistribution).toBe("fine-cell-stratified-v1");
        expect(input.clumpSpacing).toBe(0.7);
        worker = new Worker(
          `const {parentPort}=require('node:worker_threads');
        globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};
        ${GRASS_WORKER_CODE}
        parentPort.on('message',data=>self.onmessage({data}));`,
          { eval: true, env: {} },
        );
        const actualWorker = worker;
        const execute = (request: GrassWorkerInput) =>
          new Promise<GrassWorkerOutput>((resolve, reject) => {
            actualWorker.once("error", reject);
            actualWorker.once(
              "message",
              (message: { result?: GrassWorkerOutput; error?: string }) => {
                if (message.error) reject(new Error(message.error));
                else if (message.result) resolve(message.result);
                else reject(new Error("Missing actual grass worker result"));
              },
            );
            actualWorker.postMessage(request);
          });
        const output = await execute(input);
        if ("native52" in scenario)
          expect(output.count).toBe(scenario.native52.inputClumps);
        const ownSurface = visual.getRetainedSurface(nodes[0])!;
        const projected = projectGrassAnchors(
          output,
          ownSurface,
          (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
          (x, z) => terrain["isGrassExcludedAt"](x, z),
        );
        const halo = manager["groundingHalo"];
        const bounds = {
          minX: work.bounds.minX - halo,
          maxX: work.bounds.maxX + halo,
          minZ: work.bounds.minZ - halo,
          maxZ: work.bounds.maxZ + halo,
        };
        const region = visual.captureRetainedSurfaceRegion(bounds);
        expect(region.isCurrent()).toBe(true);
        expect(region.surfaces).toHaveLength(scenario.nodes.length);
        const lease = setup.prepareGroundingInputs!(bounds);
        let step = lease.steps.next();
        while (!step.done) step = lease.steps.next();
        const bankVerge = manager["compactMacroField"]?.bankVerge;
        const request: GrassBladeGroundingRequest = {
          data: projected,
          geometry: manager["lodGeometries"][lod],
          lod,
          geometryLayout: "fine-linear-sweep-3seg-v1",
          roadClearance: "per-blade-v1",
          ...(bankVerge ? { bankVerge } : {}),
          ownSurface,
          surfaces: region.surfaces,
          ...step.value,
          oceanLevel: setup.terrainConfig.WATER_THRESHOLD,
          wind: {
            x:
              GRASS_CONFIG.WIND_STRENGTH *
              FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX,
            z:
              GRASS_CONFIG.WIND_STRENGTH *
              FINE_MEADOW_APPEARANCE.BLADE_HEIGHT_MAX *
              0.55,
          },
        };
        const inputBefore = attributes.map(([key]) => projected[key].slice());
        const { result, audit } = drainGroundingWithPhaseAudit(request);
        evidence(
          `${scenario.label}_GRASS`,
          JSON.stringify({
            key,
            lod,
            focus: scenario.focus,
            ...("native52" in scenario
              ? {
                  native52HistoricalObservation: scenario.native52,
                  actualDockOwners: docks!.getCompactDiagnostics(),
                  native52ComparisonScope:
                    "Actual native52 input/retained counts are asserted; original live operations remain a historical comparator, not a timing or scheduling assertion.",
                  cpuSelections: {
                    pondBlend: setup.compactPondBlend,
                    pondBankField: setup.compactPondBankField?.id,
                    coastBlend: setup.compactCoastBlend ?? null,
                    terrainBlend: terrain["compactSurfaceBlend"],
                    dirtProjection: terrain["compactDirtProjection"],
                    rockProjection: terrain["compactRockProjection"],
                    grassAppearance: "fine-meadow-v1",
                    grassRoadClearance: request.roadClearance,
                    habitatComposition: "haven-understory-v1",
                    grassLighting: "leaf-volume-v1",
                  },
                }
              : {}),
            workBounds: work.bounds,
            groundingBounds: bounds,
            rawClumps: output.count,
            projectedClumps: projected.count,
            synchronousProcessedFraction:
              projected.count === 0
                ? 1
                : result.receipt.processedClumps / projected.count,
            ownSurface: {
              centerX: ownSurface.centerX,
              centerZ: ownSurface.centerZ,
              size: ownSurface.size,
              resolution: ownSurface.resolution,
            },
            surfaces: region.surfaces.length,
            edgeIndices: region.surfaces.map((surface) => ({
              centerX: surface.centerX,
              centerZ: surface.centerZ,
              ...surface.groundingEdgeIndexStats,
            })),
            admissionReceipts,
            bankVerge: !!bankVerge,
            status: result.status,
            reason: result.status === "defer" ? result.reason : null,
            receipt: result.receipt,
            phaseAudit: audit,
          }),
        );
        if (result.status === "defer") {
          // Attribution only: independent per-clump oracle work is not a passing
          // full-job result and never changes the production continuation cap.
          const empty = {
            count: 0,
            offsets: new Float32Array(),
            rotScaleHash: new Float32Array(),
            groundColors: new Float32Array(),
            grassTints: new Float32Array(),
            groundNormals: new Float32Array(),
          };
          const fixed = legacyGroundGrassBlades({ ...request, data: empty });
          let legacyWork = fixed.receipt.workUnits;
          let legacyTriangles = 0;
          let legacyRetained = 0;
          let maximumClumpWork = 0;
          for (let i = 0; i < projected.count; i++) {
            const data = {
              count: 1,
              offsets: projected.offsets.subarray(i * 3, i * 3 + 3),
              rotScaleHash: projected.rotScaleHash.subarray(i * 3, i * 3 + 3),
              groundColors: projected.groundColors.subarray(i * 3, i * 3 + 3),
              grassTints: projected.grassTints.subarray(i * 4, i * 4 + 4),
              groundNormals: projected.groundNormals.subarray(i * 3, i * 3 + 3),
            };
            const one = legacyGroundGrassBlades({ ...request, data });
            expect(one.status, `diagnostic oracle clump ${i}`).toBe("ready");
            legacyWork += one.receipt.workUnits - fixed.receipt.workUnits;
            legacyTriangles += one.receipt.triangleVisits;
            legacyRetained += one.receipt.retainedClumps;
            maximumClumpWork = Math.max(
              maximumClumpWork,
              one.receipt.workUnits,
            );
          }
          evidence(
            `${scenario.label}_LEGACY_ORACLE_ATTRIBUTION`,
            JSON.stringify({
              clumps: projected.count,
              legacyWork,
              legacyTriangles,
              legacyRetained,
              maximumClumpWork,
              fixedWork: fixed.receipt.workUnits,
              scope:
                "Independent per-clump oracle only; full production job still failed its cap",
            }),
          );
        }
        expect(result.status).toBe("ready");
        expect(result.receipt.workBudget).toBe(1_000_000);
        expect(result.receipt.workUnits).toBeLessThanOrEqual(1_000_000);
        if (result.status !== "ready") throw new Error(result.reason);
        if ("native52" in scenario)
          expect(result.data.count).toBe(scenario.native52.retainedClumps);

        // The frozen exhaustive implementation cannot finish this whole cell
        // under its existing cap. One-clump evaluations provide ONLY an
        // independent numerical oracle; the candidate above and the complete
        // continuation below must pass as single full-cell installations.
        const expectedData = Object.fromEntries(
          attributes.map(([key]) => [key, [] as number[]]),
        ) as Record<(typeof attributes)[number][0], number[]>;
        const expectedIndices: number[] = [];
        const expectedDeltas: number[] = [];
        const expectedVisibility: number[] = [];
        const expectedRejections = {
          terrain_edge: 0,
          pad: 0,
          road: 0,
          water: 0,
        };
        let expectedEndpointQueries = 0;
        let expectedMaxEndpointCorrection = 0;
        let expectedMaxCorrectedBaseError = 0;
        let expectedMaxAcceptedBaseError = 0;
        let expectedRetainedBlades = 0;
        let expectedPartialClumps = 0;
        let expectedMaskedBlades = 0;
        const expectedDependencies = new Map<
          GrassBladeGroundingRequest["ownSurface"],
          Set<"endpoint" | "edge" | "envelope">
        >();
        let expectedBounds: typeof result.sweptBounds = null;
        for (let i = 0; i < projected.count; i++) {
          const one = {
            count: 1,
            offsets: projected.offsets.subarray(i * 3, i * 3 + 3),
            rotScaleHash: projected.rotScaleHash.subarray(i * 3, i * 3 + 3),
            groundColors: projected.groundColors.subarray(i * 3, i * 3 + 3),
            grassTints: projected.grassTints.subarray(i * 4, i * 4 + 4),
            groundNormals: projected.groundNormals.subarray(i * 3, i * 3 + 3),
          };
          const legacy = legacyGroundGrassBlades({ ...request, data: one });
          expect(legacy.status, `legacy oracle clump ${i}`).toBe("ready");
          if (legacy.status !== "ready") throw new Error(legacy.reason);
          expectedEndpointQueries += legacy.receipt.endpointQueries;
          expectedMaxEndpointCorrection = Math.max(
            expectedMaxEndpointCorrection,
            legacy.receipt.maxEndpointCorrection,
          );
          expectedMaxCorrectedBaseError = Math.max(
            expectedMaxCorrectedBaseError,
            legacy.receipt.maxCorrectedBaseError,
          );
          expectedMaxAcceptedBaseError = Math.max(
            expectedMaxAcceptedBaseError,
            legacy.receipt.maxAcceptedBaseError,
          );
          for (const reason of Object.keys(expectedRejections) as Array<
            keyof typeof expectedRejections
          >)
            expectedRejections[reason] += legacy.receipt.rejected[reason];
          expectedRetainedBlades +=
            legacy.receipt.roadClearance!.retainedBlades;
          expectedPartialClumps += legacy.receipt.roadClearance!.partialClumps;
          expectedMaskedBlades +=
            legacy.receipt.roadClearance!.maskedRetainedBlades;
          for (const dependency of legacy.dependencies) {
            let uses = expectedDependencies.get(dependency.surface);
            if (!uses) {
              uses = new Set();
              expectedDependencies.set(dependency.surface, uses);
            }
            for (const use of dependency.uses) uses.add(use);
          }
          if (!legacy.data.count) continue;
          expect(legacy.sourceIndices).toEqual(new Uint32Array([0]));
          expectedIndices.push(i);
          expectedDeltas.push(...legacy.rootDeltas);
          expectedVisibility.push(...legacy.bladeVisibility!);
          for (const [key] of attributes)
            expectedData[key].push(...legacy.data[key]);
          const bounds = legacy.sweptBounds!;
          if (!expectedBounds) expectedBounds = { ...bounds };
          else {
            expectedBounds.minX = Math.min(expectedBounds.minX, bounds.minX);
            expectedBounds.maxX = Math.max(expectedBounds.maxX, bounds.maxX);
            expectedBounds.minY = Math.min(expectedBounds.minY, bounds.minY);
            expectedBounds.maxY = Math.max(expectedBounds.maxY, bounds.maxY);
            expectedBounds.minZ = Math.min(expectedBounds.minZ, bounds.minZ);
            expectedBounds.maxZ = Math.max(expectedBounds.maxZ, bounds.maxZ);
          }
        }
        for (const [index, [key]] of attributes.entries()) {
          expect(projected[key]).toEqual(inputBefore[index]);
          expect(result.data[key]).toEqual(new Float32Array(expectedData[key]));
        }
        expect(result.sourceIndices).toEqual(new Uint32Array(expectedIndices));
        expect(result.rootDeltas).toEqual(new Float32Array(expectedDeltas));
        expect(result.bladeVisibility).toEqual(
          new Uint32Array(expectedVisibility),
        );
        expect(result.sweptBounds).toEqual(expectedBounds);
        expect(result.receipt.processedClumps).toBe(projected.count);
        expect(result.receipt.retainedClumps).toBe(expectedIndices.length);
        expect(result.receipt.endpointQueries).toBe(expectedEndpointQueries);
        expect(result.receipt.maxEndpointCorrection).toBe(
          expectedMaxEndpointCorrection,
        );
        expect(result.receipt.maxCorrectedBaseError).toBe(
          expectedMaxCorrectedBaseError,
        );
        expect(result.receipt.maxAcceptedBaseError).toBe(
          expectedMaxAcceptedBaseError,
        );
        expect(result.receipt.rejected).toEqual(expectedRejections);
        expect(result.receipt.roadClearance).toEqual({
          mode: "per-blade-v1",
          retainedBlades: expectedRetainedBlades,
          partialClumps: expectedPartialClumps,
          maskedRetainedBlades: expectedMaskedBlades,
          visibilityBytes:
            expectedVisibility.length * Uint32Array.BYTES_PER_ELEMENT,
        });
        expect(result.dependencies).toEqual(
          [...expectedDependencies].map(([surface, uses]) => ({
            surface,
            uses: [...uses],
          })),
        );

        const pipelineStarted = performance.now();
        const pipeline = new GrassGroundingContinuation(
          prepareGroundedGrassSteps(
            { ...request, data: output },
            setup.prepareGroundingInputs!(bounds),
            (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
            (x, z) => terrain["isGrassExcludedAt"](x, z),
          ),
          () => region.isCurrent(),
        );
        while (pipeline.state.status === "running") pipeline.advance();
        evidence(
          `${scenario.label}_FULL_PIPELINE`,
          JSON.stringify({
            status: pipeline.state.status,
            reason:
              pipeline.state.status === "failed_budget"
                ? pipeline.state.reason
                : null,
            operations: pipeline.operations,
            activeMs: pipeline.activeMs,
            wallMs: performance.now() - pipelineStarted,
            maximumSliceMs: pipeline.maximumSliceMs,
            lastPhase: pipeline.lastPhase,
            lastSliceOperations: pipeline.lastSliceOperations,
            completedReceipt:
              pipeline.state.status === "ready" ||
              pipeline.state.status === "waiting_support"
                ? pipeline.state.result.receipt
                : null,
            scope:
              "Actual CPU full-cell continuation. Active time is cumulative slice elapsed time, not native browser qualification; failed jobs do not expose a processed-clump fraction.",
            outputHash: createHash("sha256")
              .update(Buffer.from(result.sourceIndices.buffer))
              .update(Buffer.from(result.rootDeltas.buffer))
              .update(Buffer.from(result.bladeVisibility!.buffer))
              .update(JSON.stringify(result.sweptBounds))
              .digest("hex"),
          }),
        );
        expect(pipeline.state.status).toBe("ready");
        if (pipeline.state.status !== "ready")
          throw new Error(pipeline.state.status);
        expect(pipeline.state.result.sourceIndices).toEqual(
          result.sourceIndices,
        );
        expect(pipeline.state.result.rootDeltas).toEqual(result.rootDeltas);
        expect(pipeline.state.result.bladeVisibility).toEqual(
          result.bladeVisibility,
        );
        expect(pipeline.state.result.sweptBounds).toEqual(result.sweptBounds);
        expect(pipeline.state.result.data.count).toBe(result.data.count);
        for (const [key] of attributes) {
          expect(pipeline.state.result.data[key]).toEqual(result.data[key]);
          expect(pipeline.state.result.data[key].buffer).not.toBe(
            result.data[key].buffer,
          );
          expect(pipeline.state.result.data[key].buffer).not.toBe(
            output[key].buffer,
          );
        }
        expect(pipeline.state.result.dependencies).toEqual(result.dependencies);
        expect({ ...pipeline.state.result.receipt, elapsedMs: 0 }).toEqual({
          ...result.receipt,
          elapsedMs: 0,
        });
        const expectedHeights = new Float32Array(result.data.count);
        const expectedNormals = new Float32Array(result.data.count * 3);
        for (let i = 0; i < result.sourceIndices.length; i++) {
          const source = result.sourceIndices[i];
          expectedHeights[i] = projected.grounding.computedHeights[source];
          for (let axis = 0; axis < 3; axis++)
            expectedNormals[i * 3 + axis] =
              projected.grounding.ecologicalNormals[source * 3 + axis];
        }
        expect(pipeline.state.result.grounding).toEqual({
          schemaVersion: projected.grounding.schemaVersion,
          surfaceRevision: projected.grounding.surfaceRevision,
          computedHeights: expectedHeights,
          ecologicalNormals: expectedNormals,
        });
        const grounding = pipeline.state.result.grounding;
        if (!grounding) throw new Error("Missing full-pipeline provenance");
        expect(grounding.computedHeights.buffer).not.toBe(
          projected.grounding.computedHeights.buffer,
        );
        expect(grounding.ecologicalNormals.buffer).not.toBe(
          projected.grounding.ecologicalNormals.buffer,
        );
      } catch (error) {
        failures.push(error);
      } finally {
        const release = (cleanup: () => void) => {
          try {
            cleanup();
          } catch (error) {
            failures.push(error);
          }
        };
        try {
          await worker?.terminate();
        } catch (error) {
          failures.push(error);
        }
        release(() => manager?.destroy());
        release(() => visual?.dispose());
        release(() => material.dispose());
        // Release native dock actors/exclusions before terrain or physics dies.
        release(() => docks?.destroy());
        release(() => world.destroy());
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Pond grass fixture and cleanup failed",
        );
    },
    30_000,
  );
});
