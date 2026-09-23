import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { beforeAll, describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { MeshSSSNodeMaterial } from "three/webgpu";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { loadPhysX } from "../../../../physics/PhysXManager";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { createGrassPlacementCellOperations } from "../../../../utils/workers/GrassPlacementCell";
import {
  STREAMING_TERRAIN_QUADTREE_RESOLUTION,
  TerrainSystem,
} from "../TerrainSystem";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { ProceduralDocks } from "../ProceduralDocks";
import {
  COMPACT_SERVICE_COURT_SYSTEM,
  CompactServiceCourtSystem,
} from "../CompactServiceCourtSystem";
import { TerrainVisualManager } from "../TerrainVisualManager";
import {
  FINE_MEADOW_APPEARANCE,
  FINE_MEADOW_GRASS_VISUAL_PROFILE,
  GRASS_CONFIG,
  GrassVisualManager,
  createClumpGeometry,
  FINE_GRASS_FOLDED_BLADE_LIGHTING,
  FINE_GRASS_LEAF_VOLUME_LIGHTING,
  FINE_GRASS_MEADOW_FIELD_COMPOSITION,
} from "../GrassVisualManager";
import {
  getGrassBladeLayout,
  usesGrassBladeHeightFlex,
} from "../GrassBladeLayout";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import {
  groundGrassBladeSteps,
  GrassGroundingContinuation,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
} from "../GrassBladeGrounding";
import {
  prepareGroundedGrassSteps,
  finishGroundedGrassWorkerSteps,
} from "../GrassGroundingPipeline";
import {
  GrassGroundingPreparationContinuation,
  prepareGrassGroundingHandoffSteps,
} from "../GrassGroundingHandoff";
import { GrassGroundingWorkerCoordinator } from "../GrassGroundingWorkerCoordinator";
import {
  GrassGroundingWorkerClient,
  type GrassGroundingClientSettled,
} from "../../../../utils/workers/GrassGroundingWorkerClient";
import {
  GRASS_GROUNDING_WORKER_LIMITS,
  type GrassGroundingWorkerResponse,
} from "../../../../utils/workers/GrassGroundingWorkerWire";
import { ActualGrassGroundingClientPort } from "./fixtures/ActualGrassGroundingClientPort";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { groundGrassBlades as legacyGroundGrassBlades } from "./fixtures/LegacyGrassBladeGroundingReference";
import {
  bundleGrassGroundingWorker,
  createActualGroundingWorker,
  createGrassGroundingWorkerRequest,
  grassGroundingWorkerSemanticResult,
  prepareCachedGrassGroundingWorkerRequest,
  runGrassGroundingWorker,
  type ActualGroundingWorker,
  type GroundingWorkerCpuProfile,
} from "./fixtures/GrassGroundingWorkerHarness";

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

// One explicit diagnostic run, never enabled by ordinary regression commands.
// Only the native95 western or native121 reconstructed cached request is admitted.
const cpuProfilePrefix = process.env.HYPERIA_GRASS_CACHED_PROFILE_PREFIX;
const cachedBaselinePath = process.env.HYPERIA_GRASS_CACHED_BASELINE_BUNDLE;
let cachedBaselineSource: string | undefined;
const hashBytes = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
// v8 preserves native Sets, typed arrays and non-finite numeric sentinels.
// These are exact serialized inputs for this Node version, not portable
// cross-engine canonical hashes or historical browser packet hashes.
function serializedInputReceipt(value: unknown) {
  const bytes = serialize(value);
  return {
    format: "node-v8",
    nodeVersion: process.version,
    bytes: bytes.length,
    sha256: hashBytes(bytes),
  };
}
let profileSourcePins: { path: string; bytes: number; sha256: string }[] = [];
function writeProfileEvidence(suffix: string, value: string) {
  if (!cpuProfilePrefix) throw new Error("CPU profile evidence is not enabled");
  const path = `${cpuProfilePrefix}${suffix}`;
  writeFileSync(path, value, { flag: "wx" });
  return { path, bytes: Buffer.byteLength(value), sha256: hashBytes(value) };
}

function saveCachedProfile(
  receipt: GroundingWorkerCpuProfile,
  reconstruction: {
    label: string;
    key: string;
    historicalSource: string;
    historicalSourceSHA256: string;
  },
) {
  // Preserve the raw observation, including profiler/production failures,
  // before asserting qualification. Never turn a failed budget into a pass.
  const raw = JSON.stringify(receipt.profile);
  const profileFile = writeProfileEvidence(".cpuprofile", raw);
  const { profile, ...metadata } = receipt;
  const sourcesUnchanged = profileSourcePins.every(
    (pin) => hashBytes(readFileSync(pin.path)) === pin.sha256,
  );
  const metadataFile = writeProfileEvidence(
    "-receipt.json",
    JSON.stringify(
      {
        ...metadata,
        reconstruction,
        profileFile,
        nodeCount: profile?.nodes.length ?? 0,
        sampleCount: profile?.samples?.length ?? 0,
        profileStartTimeUs: profile?.startTime ?? null,
        profileEndTimeUs: profile?.endTime ?? null,
        sourcesUnchanged,
        scope:
          "One sampled Node22 worker-isolate cached request: validation, fitting, result packing, task waits, GC and profiler overhead. Surface preparation and module startup excluded. Sample weights are not exclusive CPU time, native browser measurements, or performance acceptance. Node Inspector start/stop perturbs execution; original 250ms/1M caps remain enforced. The identified current-source reconstruction is not a byte-exact historical packet; this separately prepared cached fit has a zero consumed seed, not the later measured production handoff seed.",
      },
      null,
      2,
    ),
  );
  evidence(
    `${reconstruction.label}_CACHED_CPU_PROFILE`,
    JSON.stringify(metadataFile),
  );
  expect(receipt.error).toBeNull();
  expect(receipt.samplingIntervalUs).toBe(1000);
  expect(receipt.startAcknowledgedAtMs).not.toBeNull();
  expect(receipt.stopRequestedAtMs).toBeGreaterThanOrEqual(
    receipt.startAcknowledgedAtMs!,
  );
  expect(receipt.stopAcknowledgedAtMs).toBeGreaterThanOrEqual(
    receipt.stopRequestedAtMs,
  );
  expect(sourcesUnchanged).toBe(true);
  expect(profile).not.toBeNull();
  expect(profile!.nodes.length).toBeGreaterThan(0);
  expect(profile!.nodes.length).toBeLessThanOrEqual(100_000);
  expect(profile!.samples!.length).toBeGreaterThan(0);
  expect(profile!.samples!.length).toBeLessThanOrEqual(100_000);
  expect(profile!.samples).toHaveLength(profile!.timeDeltas!.length);
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16 * 1024 * 1024);
}

// Hash the actual view, not spare capacity in a shared/subarray backing buffer.
// Separate color hashes let source A/B comparisons permit appearance changes
// without concealing a change to population, transforms or grounding evidence.
function bufferReceipt(array: Float32Array | Uint16Array | Uint32Array) {
  return {
    type: array.constructor.name,
    length: array.length,
    bytes: array.byteLength,
    sha256: createHash("sha256")
      .update(Buffer.from(array.buffer, array.byteOffset, array.byteLength))
      .digest("hex"),
  };
}

function attributeReceipts(
  data: Pick<GrassWorkerOutput, "count" | (typeof attributes)[number][0]>,
) {
  return {
    count: data.count,
    attributes: Object.fromEntries(
      attributes.map(([key]) => [key, bufferReceipt(data[key])]),
    ),
  };
}

function groundedBufferReceipts(
  result: Pick<
    Extract<GrassBladeGroundingResult, { status: "ready" }>,
    "data" | "sourceIndices" | "rootDeltas" | "bladeVisibility" | "sweptBounds"
  >,
) {
  return {
    ...attributeReceipts(result.data),
    sourceIndices: bufferReceipt(result.sourceIndices),
    rootDeltas: bufferReceipt(result.rootDeltas),
    bladeVisibility: bufferReceipt(result.bladeVisibility!),
    sweptBounds: result.sweptBounds,
  };
}

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

const native95Observation = {
  source: "native95/process.json",
  sourceSHA256:
    "541d1bf57683eced884124c3bb6eed7258d30c8e279de9e7389917fe715ef7f5",
  frameworkSHA256:
    "0f155760f04d55354bf473c54416d601e36fcb61891ee389dc36c7a56e1d1e43",
  workerSHA256:
    "46529c13932497ade3e4c54f2322bdf8395bac3086203c1dc7e727f41bc80015",
  worldConfigSHA256:
    "60f98f5e300db1eb58902723d4f9a5859db4b3a75fc78ec81e1b3673832ac254",
  worldAreasSHA256:
    "fdda05c65a178f3cf6dc9eec5187711c251f77b7ff2c0659f0ccce29fa254e7f",
  phase: "grounding_operation",
  scope:
    "Historical failed prefixes from a host-interrupted native run. The receipt preserves focus, cell bounds, LOD and profile, but no worker input arrays, retained-surface snapshots or packet hashes. This is current-source reconstruction using the actual v9 owners and unchanged limits, not byte-exact historical input, host-suspension reproduction or native startup qualification.",
} as const;

// Explicit real-asset regressions: none of these overlays is a production default.
// Each uses its actual worker output, authored constraints and retained mesh.
const native144Cases = (
  [
    {
      key: "gcell_v1_13_17",
      bounds: { minX: 325, maxX: 350, minZ: 425, maxZ: 450 },
      nodes: [[350, 450]],
      resolutions: [128],
      label: "WEST_MEADOW",
      failedOperations: 160035,
      failedActiveMs: 113.90000000223517,
      baselineInputClumps: 1272,
      baselineWorkUnits: 683686,
    },
    {
      key: "gcell_v1_12_16",
      bounds: { minX: 300, maxX: 325, minZ: 400, maxZ: 425 },
      // This cell crosses both x300 and z400. Retain all four actual owners;
      // never replace the western regular-grid owner with a refined surface.
      nodes: [
        [350, 450],
        [250, 450],
        [250, 350],
        [350, 350],
      ],
      resolutions: [128, 64, 128, 128],
      label: "SOUTHWEST_BOUNDARY",
      failedOperations: 174126,
      failedActiveMs: 57.099999994039536,
      baselineInputClumps: 1247,
      baselineWorkUnits: 683730,
    },
  ] as const
).map((cell) => ({
  name: `native144 startup LOD0 sheath ${cell.key} work budget`,
  test: `reconstructs the native144 ${cell.key} geometric-budget failure with actual v10 owners and unchanged caps`,
  enabled: process.env.ASSETS_DIR?.endsWith(
    "/inland-pond-integration01-UNQUALIFIED/assets-v10",
  ),
  label: `NATIVE144_LOD0_${cell.label}`,
  nodes: cell.nodes,
  resolutions: cell.resolutions,
  focus: [335, 431] as const,
  lod: 0 as const,
  key: cell.key,
  bounds: cell.bounds,
  nativeSheath: {
    id: "native144" as const,
    source: "native144/process.json",
    sourceSHA256:
      "26f5618a7b482f906cf045ba5e3025ed7e6de866e40216da93f1366d1629f37c",
    worldConfigSHA256:
      "60f98f5e300db1eb58902723d4f9a5859db4b3a75fc78ec81e1b3673832ac254",
    worldAreasSHA256:
      "438cabb6f34e965b708f0276d050cb2cda222252bdc8412123ee0c7e50e210c3",
    failedOperations: cell.failedOperations,
    failedActiveMs: cell.failedActiveMs,
    lastPhase: "blade_swept_bounds",
    failureReason: "grounding_work",
    baselineSource: "native143/process.json",
    baselineSourceSHA256:
      "f30c55457ce060c823e2782e7a6a1fb88eb745acc4848270f760c9c91d495230",
    baselineInputClumps: cell.baselineInputClumps,
    baselineWorkUnits: cell.baselineWorkUnits,
    scope:
      "Native144 retained two failed geometric-work prefixes, not worker packets. Current-source reconstruction uses actual v10 composition, retained owners, focus and explicit sheath geometry. Native143 counts pin unchanged source placement only; current clearance, outputs and work are independently observed. No byte-exact historical replay, native startup, art or performance qualification.",
  },
}));

const native146Case = {
  name: "native146 first-camera LOD0 sheath gcell_v1_15_17 work budget",
  test: "reconstructs the native146 gcell_v1_15_17 first-camera geometric-budget failure with actual v10 owners and unchanged caps",
  enabled: process.env.ASSETS_DIR?.endsWith(
    "/inland-pond-integration01-UNQUALIFIED/assets-v10",
  ),
  label: "NATIVE146_LOD0_POND_BANK_ARRIVAL",
  // This actual halo crosses x400. Both retained owners are selected by the
  // existing v10 detail policy, not a synthetic terrain or resolution override.
  nodes: [
    [350, 450],
    [450, 450],
  ],
  resolutions: [128, 128],
  focus: [372, 448],
  lod: 0,
  key: "gcell_v1_15_17",
  bounds: { minX: 375, maxX: 400, minZ: 425, maxZ: 450 },
  nativeSheath: {
    id: "native146",
    source: "native146/process.json",
    sourceSHA256:
      "0a505d7e08dcb42f1ac00a8946d5c99d87f6c6e297d2e589bc139ed0c11fcaf3",
    worldConfigSHA256:
      "60f98f5e300db1eb58902723d4f9a5859db4b3a75fc78ec81e1b3673832ac254",
    worldAreasSHA256:
      "438cabb6f34e965b708f0276d050cb2cda222252bdc8412123ee0c7e50e210c3",
    failedOperations: 204088,
    failedActiveMs: 57.399999994784594,
    lastPhase: "blade_swept_bounds",
    failureReason: "grounding_work",
    nodeId: 49,
    isLodSwap: true,
    cameraId: "pond-bank-arrival",
    baselineSource: "native145/pond-bank-arrival.json",
    baselineSourceSHA256:
      "fc99d78e9019d32ad429b5112e931e41b10ae64a086db7f89de90b3142180c94",
    baselineInputClumps: 1125,
    baselineWorkUnits: 731800,
    scope:
      "Native146 completed startup but failed this first-camera LOD swap under the geometric-work cap; its worker packet was not retained. Current-source reconstruction uses actual v10 composition, both retained owners, camera focus, the real service-court footing-exclusion owner and explicit sheath geometry. Native145 matched-view counts pin unchanged source placement only, not candidate retention, masks or work. This is an isolated full-cell reconstruction, not byte-exact historical replay, LOD scheduling, native startup, art or performance qualification.",
  },
} as const;

// Same real source populations and retained owners, newly composed templates.
// Historical receipts pin the scenario only, never the new geometry or masks.
const rootedFanCases = [...native144Cases, native146Case].map((source) => ({
  ...source,
  name: `rooted fan LOD0 ${source.key} actual v10 work budget`,
  test: `fits rooted fan ${source.key} using actual v10 owners and unchanged caps`,
  label: `ROOTED_FAN_${source.key.toUpperCase()}`,
  geometryCandidate: "rooted-fan-v1" as const,
  nativeSheath: {
    ...source.nativeSheath,
    scope:
      "New rooted-fan geometry evaluated on the historical source-placement scenario. This is not historical geometry replay; retention, masks and cost are newly measured. " +
      source.nativeSheath.scope,
  },
}));

const meadowCanopyCases = [...native144Cases, native146Case].map((source) => ({
  ...source,
  name: `meadow canopy LOD0 ${source.key} actual v10 work budget`,
  test: `fits meadow canopy ${source.key} using actual v10 owners and unchanged caps`,
  label: `MEADOW_CANOPY_${source.key.toUpperCase()}`,
  geometryCandidate: "meadow-canopy-v1" as const,
  nativeSheath: {
    ...source.nativeSheath,
    scope:
      "New eight-fan meadow-canopy geometry evaluated against the same historical source-placement scenario and retained owners. Retention, masks, swept bounds and cost are measured anew, not equated to historical sheath or rooted-fan outcomes. " +
      source.nativeSheath.scope,
  },
}));

// New placement, not a replay or resampling of the old source population.
// Preserve the real terrain/exclusion owners but deliberately do not inherit
// nativeSheath: its source counts and folded-layout assertions remain historical.
const meadowFieldCases = [...native144Cases, native146Case].flatMap((source) =>
  ([0, 1, 2] as const).map((lod) => ({
    name: `meadow field LOD${lod} ${source.key} actual v10 work budget`,
    test: `fits unsliced meadow field LOD${lod} ${source.key} new half-metre grid with unchanged caps`,
    enabled: source.enabled,
    label: `MEADOW_FIELD_LOD${lod}_${source.key.toUpperCase()}`,
    nodes: source.nodes,
    resolutions: source.resolutions,
    focus:
      lod === 0
        ? source.focus
        : ([
            source.bounds.maxX + (lod === 1 ? 20 : 60),
            (source.bounds.minZ + source.bounds.maxZ) / 2,
          ] as const),
    lod,
    key: source.key,
    bounds: source.bounds,
    geometryCandidate: "meadow-field-v1" as const,
    meadowField: {
      worldConfigSHA256: source.nativeSheath.worldConfigSHA256,
      worldAreasSHA256: source.nativeSheath.worldAreasSHA256,
      serviceCourt: source.nativeSheath.id === "native146",
      scope:
        "Fresh full 25m cell at 0.5m spacing, with actual v10 terrain/road/exclusion owners and the production meadow-field ribbon template. All placement, retention, masks, swept bounds and work are newly measured. No historical source-count, source-index or mask equality; no truncation, cap increase, native scheduling, art or performance qualification.",
    },
  })),
);

const historicalCases = [
  {
    name: "native121 startup LOD0 western pond work budget",
    test: "reconstructs the native121 failed cell using actual v10 owners and unchanged fitting caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v10",
    ),
    label: "NATIVE121_LOD0_WESTERN_POND",
    // The swept halo crosses z400. Both retained owners are generated with
    // production detail policy; neither resolution nor geometry is fabricated.
    nodes: [
      [350, 450],
      [350, 350],
    ],
    focus: [335, 431],
    lod: 0,
    key: "gcell_v1_13_16",
    bounds: { minX: 325, maxX: 350, minZ: 400, maxZ: 425 },
    native121: {
      source: "native121/process.json",
      sourceSHA256:
        "977bd7479aab493974a6ac2fb46a806e1106f769b7c7d060a7c3754abca32f62",
      frameworkSHA256:
        "5cbdd06f132e21cb305baa7a50602e83df9a1340a65de083473aff72de97bb7d",
      workerSHA256:
        "a8444e4226d69bdc642bea32c84b7a68f63071d6462570b8048e6e22dcbf00f7",
      worldConfigSHA256:
        "60f98f5e300db1eb58902723d4f9a5859db4b3a75fc78ec81e1b3673832ac254",
      worldAreasSHA256:
        "438cabb6f34e965b708f0276d050cb2cda222252bdc8412123ee0c7e50e210c3",
      nodeId: 49,
      generation: 47,
      jobId: 43,
      phase: "grounding_operation",
      submittedWork: {
        operations: 1755,
        activeMs: 1.5999999046325684,
        maximumSliceMs: 1.5999999046325684,
      },
      rawWorkerWork: {
        operations: 100251,
        activeMs: 252.90000009536743,
        maximumSliceMs: 73.59999990463257,
      },
      mainObservedWork: {
        operations: 100253,
        activeMs: 254.30000019073486,
        maximumSliceMs: 1.5999999046325684,
        cumulativeMaximumSliceMs: 73.59999990463257,
      },
      scope:
        "Historical native121 failed fitting prefix, not a retained packet. Current-source v10 reconstruction uses its cell/focus/LOD and actual retained owners. IDs/revisions, input arrays and scheduling are newly produced. The historical submitted ledger is recorded only; the production handoff below generates a fresh measured seed. No byte-exact historical replay, exclusive CPU attribution or native startup qualification.",
    },
  },
  {
    name: "native118 startup retained surface admission",
    test: "reconstructs the native118 failed surface using actual v10 terrain and original admission caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v10",
    ),
    label: "NATIVE118_SURFACE_ADMISSION",
    nodes: [[350, 450]],
    native118: {
      source: "native118/process.json",
      sourceSHA256:
        "d25877937b6c7fad7b3cb4e481b89f60536e5bf2ac41b287e6e9ccf541f44ae7",
      nodeId: 49,
      centerX: 350,
      centerZ: 450,
      size: 100,
      resolution: 128,
      inputBytes: 1_728_164,
      derivedBytesReserved: 2_861_401,
      lastPhase: "topology-side",
      workerWork: {
        operations: 2413,
        activeMs: 270.40000009536743,
        maximumSliceMs: 96,
      },
      worldConfigSHA256:
        "60f98f5e300db1eb58902723d4f9a5859db4b3a75fc78ec81e1b3673832ac254",
      worldAreasSHA256:
        "438cabb6f34e965b708f0276d050cb2cda222252bdc8412123ee0c7e50e210c3",
      scope:
        "Historical native118 failed surface admission, not a retained packet. Current-source reconstruction is not byte-exact historical input or native performance qualification; offline node IDs/revisions are newly allocated, and the zero work seed intentionally excludes historical main-thread preparation costs.",
    },
  },
  {
    name: "native108 startup LOD1 pond bank work budget",
    test: "reconstructs the native108 failed cell with actual retained neighbours and original caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v10",
    ),
    label: "NATIVE108_LOD1_POND_BANK",
    nodes: [
      [350, 450],
      [450, 450],
    ],
    focus: [335, 431],
    lod: 1,
    key: "gcell_v1_15_17",
    bounds: { minX: 375, maxX: 400, minZ: 425, maxZ: 450 },
    native108: {
      source: "native108/process.json",
      sourceSHA256:
        "13305732a00eb269c8c9719fd9f5ec9d8aef7db706d508ac17709923400a4deb",
      workerOperations: 148346,
      workerSliceElapsedMs: 250.00000143051147,
      workerMaximumSliceMs: 13.900000095367432,
      scope:
        "Historical worker-terminal failed prefix with nominal host, not complete work or exclusive CPU. Current-source reconstruction uses actual v10 terrain, original focus/cell/LOD and production detail. Native108 did not retain its exact packet; this is not byte-exact historical replay or native startup qualification.",
    },
  },
  {
    name: "native106 startup LOD0 western meadow work budget",
    test: "reconstructs the native106 failed cell using actual v10 owners and unchanged fitting caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v10",
    ),
    label: "NATIVE106_LOD0_WESTERN_MEADOW",
    // The cell's original halo crosses z400; detail comes from production
    // preparation regions, not a hardcoded all-fine retained terrain fixture.
    nodes: [
      [350, 450],
      [350, 350],
    ],
    focus: [335, 431],
    lod: 0,
    key: "gcell_v1_14_16",
    bounds: { minX: 350, maxX: 375, minZ: 400, maxZ: 425 },
    native106: {
      source: "native106/process.json",
      sourceSHA256:
        "40e09ffd6a0bb40e1c3f0119ddea64ddb5c3e331138c783915d6dfa77f1d71d7",
      workerOperations: 146048,
      workerSliceElapsedMs: 250.90000009536743,
      workerMaximumSliceMs: 89.2999997138977,
      scope:
        "Historical worker-terminal failed prefix with nominal host, not complete work or exclusive CPU. Current-source reconstruction uses actual v10 terrain, original focus/cell/LOD and production detail. Native106 did not retain the exact input packet; this is not byte-exact historical replay or native startup qualification.",
    },
  },
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
  {
    name: "native52 startup LOD1 northwest cutbank work budget",
    test: "grounds the actual cutbank at the native52 startup focus and LOD1 within unchanged caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE52_LOD1_CUTBANK",
    // This real work cell ends at x400 and starts at z400. Its unchanged
    // swept halo needs all four adjacent retained 100m leaves.
    nodes: [
      [350, 450],
      [450, 450],
      [350, 350],
      [450, 350],
    ],
    focus: [335, 431],
    lod: 1,
    key: "gcell_v1_15_16",
    bounds: { minX: 375, maxX: 400, minZ: 400, maxZ: 425 },
    native52: {
      inputClumps: 726,
      retainedClumps: 699,
      operations: 169797,
      jobId: 114,
      source: "native52/startup-grass-budget-ledger.json",
      sourceSHA256:
        "f525d0334030277dd9af1703ce43149022fbe6c88df9a6cc397c2b57a5d39c04",
      frameworkSHA256:
        "6530f342ced7b0457afcfe047cba5b2a5bd34f7d2c4a55ded49ebc0df01b3151",
      worldAreasSHA256:
        "fdda05c65a178f3cf6dc9eec5187711c251f77b7ff2c0659f0ccce29fa254e7f",
    },
  },
  {
    name: "native72 startup LOD1 southwest bank work budget",
    test: "grounds the exact native72 failed cell with unchanged fitting limits",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE72_LOD1_SOUTHWEST_BANK",
    // This is the x375..400 cell, not its x400..425 neighbor. Owner ordering
    // must match the real cell; its unchanged halo crosses the x400 boundary.
    nodes: [
      [350, 450],
      [450, 450],
    ],
    focus: [335, 431],
    lod: 1,
    key: "gcell_v1_15_17",
    bounds: { minX: 375, maxX: 400, minZ: 425, maxZ: 450 },
    native72: {
      source: "native72/process.json",
      sourceSHA256:
        "68001f7328f46e0647eec51ec08ac528bdcd7b06cb2f1f43412a2695ba57f5df",
      failedOperations: 153028,
      failedActiveMs: 251.69999980926514,
      scope:
        "Historical failed prefix, not completed input/retained counts or total fitting work.",
    },
  },
  {
    name: "native74 startup LOD0 western arena approach work budget",
    test: "grounds the exact native74 western failed cell with unchanged fitting limits",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE74_LOD0_WEST_APPROACH",
    // The original cell crosses z400 through its swept halo. Its own southern
    // leaf is first, matching the actual startup focus and retained owner.
    nodes: [
      [350, 450],
      [350, 350],
    ],
    focus: [335, 431],
    lod: 0,
    key: "gcell_v1_13_16",
    bounds: { minX: 325, maxX: 350, minZ: 400, maxZ: 425 },
    native74: {
      source: "native74/process.json",
      sourceSHA256:
        "91ceeaecf76bb42a609ee88e7efb7686fc0e89d0899586154723adf42b12c375",
      failedOperations: 104733,
      failedActiveMs: 262.6000008583069,
      scope:
        "Historical remote-fitting failed prefix, not completed counts or actual CPU utilization.",
    },
  },
  {
    name: "native74 startup LOD0 eastern arena approach work budget",
    test: "grounds the exact native74 eastern failed cell with unchanged fitting limits",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE74_LOD0_EAST_APPROACH",
    nodes: [
      [350, 450],
      [350, 350],
    ],
    focus: [335, 431],
    lod: 0,
    key: "gcell_v1_14_16",
    bounds: { minX: 350, maxX: 375, minZ: 400, maxZ: 425 },
    native74: {
      source: "native74/process.json",
      sourceSHA256:
        "91ceeaecf76bb42a609ee88e7efb7686fc0e89d0899586154723adf42b12c375",
      failedOperations: 145218,
      failedActiveMs: 250.50000047683716,
      scope:
        "Historical remote-fitting failed prefix, not completed counts or actual CPU utilization.",
    },
  },
  {
    name: "native82 startup LOD0 mixed-resolution western meadow work budget",
    test: "grounds the exact native82 western failed cell using the admitted mixed-resolution terrain policy",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE82_LOD0_WESTERN_MEADOW",
    // Unlike the historical all-128 fixtures, this cell's swept halo crosses
    // x300 into the western 64-grid owner. Derive both resolutions from the
    // actual native compact detail policy; never upgrade the neighbour here.
    nodes: [
      [350, 450],
      [250, 450],
    ],
    focus: [335, 431],
    lod: 0,
    key: "gcell_v1_12_17",
    bounds: { minX: 300, maxX: 325, minZ: 425, maxZ: 450 },
    native82: {
      source: "native82/process.json",
      sourceSHA256:
        "1424f7aedbe41d1709037e00979f19a6081cee85dd99b95e12e683a8b6ee5280",
      failedOperations: 112014,
      failedActiveMs: 250.69999933242798,
      scope:
        "Historical native failed prefix, not a completed work total. This CPU replay uses current production owners and the unchanged fitting limits; it does not qualify native startup.",
    },
  },
  {
    name: "native95 startup LOD0 western boundary work budget",
    test: "reconstructs the native95 western failed cell with actual mixed-detail owners and unchanged caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE95_LOD0_WESTERN_BOUNDARY",
    // The own western leaf is 64-grid. The unchanged halo crosses both x300
    // and z400; the Haven shoulder upgrades the northwestern neighbour to 128.
    nodes: [
      [250, 450],
      [350, 450],
      [250, 350],
      [350, 350],
    ],
    resolutions: [64, 128, 128, 128],
    focus: [335, 431],
    lod: 0,
    key: "gcell_v1_11_16",
    bounds: { minX: 275, maxX: 300, minZ: 400, maxZ: 425 },
    native95: {
      ...native95Observation,
      failedOperations: 214029,
      failedActiveMs: 251.5999994277954,
    },
  },
  {
    name: "native95 startup LOD1 southern shoulder work budget",
    test: "reconstructs the native95 southern failed cell with actual retained-detail owners and unchanged caps",
    enabled: process.env.ASSETS_DIR?.endsWith(
      "/inland-pond-integration01-UNQUALIFIED/assets-v9",
    ),
    label: "NATIVE95_LOD1_SOUTHERN_SHOULDER",
    // The x400-crossing halo uses both real southern pond/head-shoulder leaves.
    nodes: [
      [350, 450],
      [450, 450],
    ],
    resolutions: [128, 128],
    focus: [335, 431],
    lod: 1,
    key: "gcell_v1_15_18",
    bounds: { minX: 375, maxX: 400, minZ: 450, maxZ: 475 },
    native95: {
      ...native95Observation,
      failedOperations: 101642,
      failedActiveMs: 250.9000005722046,
    },
  },
  ...(
    [
      [
        "WEST",
        "gcell_v1_13_17",
        325,
        350,
        173197,
        252.3,
        "grounding_operation",
      ],
      [
        "EAST",
        "gcell_v1_14_17",
        350,
        375,
        180895,
        250.3,
        "worker_publication_values",
      ],
    ] as const
  ).map(
    ([side, key, minX, maxX, failedOperations, failedActiveMs, lastPhase]) => ({
      name: `native86 startup LOD0 ${side.toLowerCase()} meadow work budget`,
      test: `grounds the exact native86 ${side.toLowerCase()} failed cell using the admitted v10 terrain policy`,
      enabled: process.env.ASSETS_DIR?.endsWith(
        "/inland-pond-integration01-UNQUALIFIED/assets-v10",
      ),
      label: `NATIVE86_LOD0_${side}_MEADOW`,
      // Both exact cells and their current swept halos are inside this owner.
      // Its resolution is selected by the same production detail policy as the
      // native82 case, not an unconditional upgraded 128-grid fixture.
      nodes: [[350, 450]] as const,
      focus: [335, 431] as const,
      lod: 0 as const,
      key,
      bounds: { minX, maxX, minZ: 425, maxZ: 450 },
      native86: {
        source: "native86/process.json",
        sourceSHA256:
          "efb2e6310099fb24c3304dab0bd05494dcbe932885eac1bc3b688048e2292221",
        failedOperations,
        failedActiveMs,
        lastPhase,
        scope:
          "Historical failed prefix, rounded active time and last phase. This current-source CPU replay uses the actual v10 assets and production retained-detail policy, not a native startup qualification.",
      },
    }),
  ),
] as const;

type PondGroundingScenario =
  | (typeof native144Cases)[number]
  | typeof native146Case
  | (typeof rootedFanCases)[number]
  | (typeof meadowCanopyCases)[number]
  | (typeof meadowFieldCases)[number]
  | (typeof historicalCases)[number];

// Keep the original tuple's exact union members: combining two variadic
// spreads directly normalizes absent discriminators into optional fields.
const cases: readonly PondGroundingScenario[] = [
  ...native144Cases,
  native146Case,
  ...rootedFanCases,
  ...meadowCanopyCases,
  ...meadowFieldCases,
  ...historicalCases,
];

let groundingWorkerSource: string;
let groundingWorkerSourcePins: {
  path: string;
  bytes: number;
  sha256: string;
}[] = [];
const surfaceReconstructionSourcePaths = [
  fileURLToPath(import.meta.url),
  ...[
    "./fixtures/GrassGroundingWorkerHarness.ts",
    "./fixtures/ActualGrassGroundingClientPort.ts",
    "../TerrainSystem.ts",
    "../TerrainVisualManager.ts",
    "../TerrainQuadTree.ts",
    "../TerrainQuadChunkGenerator.ts",
    "../TerrainGridSurface.ts",
    "../GrassBladeGrounding.ts",
    "../CompactIslandDetail.ts",
    "../../../../utils/workers/TerrainWorkerShared.ts",
    "../../../../utils/workers/GrassGroundingWorker.entry.ts",
    "../../../../utils/workers/GrassGroundingWorkerClient.ts",
    "../../../../utils/workers/GrassGroundingWorkerWire.ts",
    "../../../../data/DataManager.ts",
  ].map((path) => fileURLToPath(new URL(path, import.meta.url))),
].sort();
const fittingReconstructionSourcePaths = [
  ...surfaceReconstructionSourcePaths,
  ...[
    "../GrassVisualManager.ts",
    "../GrassTerrainProjection.ts",
    "../GrassGroundingHandoff.ts",
    "../GrassGroundingWorkerCoordinator.ts",
    "../GrassBladeLayout.ts",
    "../GrassGroundingPipeline.ts",
    "../CompactTerrainPalette.ts",
    "../RoadNetworkSystem.ts",
    "../ProceduralDocks.ts",
    "../../../../utils/workers/GrassWorker.ts",
  ].map((path) => fileURLToPath(new URL(path, import.meta.url))),
].sort();
beforeAll(async () => {
  if (cachedBaselinePath) {
    expect(cpuProfilePrefix).toBeUndefined();
    expect(isAbsolute(cachedBaselinePath)).toBe(true);
    expect(
      process.env.ASSETS_DIR?.endsWith("/assets-v9") ||
        process.env.ASSETS_DIR?.endsWith(
          "/inland-pond-integration01-UNQUALIFIED/assets-v10",
        ),
    ).toBe(true);
    cachedBaselineSource = readFileSync(cachedBaselinePath, "utf8");
    expect(hashBytes(cachedBaselineSource)).toBe(
      process.env.HYPERIA_GRASS_CACHED_BASELINE_SHA256,
    );
  }
  if (cpuProfilePrefix) {
    expect(isAbsolute(cpuProfilePrefix)).toBe(true);
    expect(
      process.env.ASSETS_DIR?.endsWith("/assets-v9") ||
        process.env.ASSETS_DIR?.endsWith(
          "/inland-pond-integration01-UNQUALIFIED/assets-v10",
        ),
    ).toBe(true);
  }
  if (cases.some((scenario) => scenario.enabled)) {
    const bundle = await bundleGrassGroundingWorker({
      cpuProfileSourceMap: !!cpuProfilePrefix,
    });
    groundingWorkerSource = bundle.source;
    groundingWorkerSourcePins = bundle.inputs.map((path) => {
      const absolute = resolve(path);
      const bytes = readFileSync(absolute);
      return { path: absolute, bytes: bytes.length, sha256: hashBytes(bytes) };
    });
    if (cpuProfilePrefix) {
      const paths = new Set([
        ...bundle.inputs.map((path) => resolve(path)),
        fileURLToPath(import.meta.url),
        fileURLToPath(
          new URL("./fixtures/GrassGroundingWorkerHarness.ts", import.meta.url),
        ),
      ]);
      profileSourcePins = [...paths].sort().map((path) => {
        const bytes = readFileSync(path);
        return { path, bytes: bytes.length, sha256: hashBytes(bytes) };
      });
      writeProfileEvidence(
        "-sources.json",
        JSON.stringify(
          {
            node: process.version,
            sourcePins: profileSourcePins,
            bundle: writeProfileEvidence("-bundle.js", bundle.source),
            sourceMap: writeProfileEvidence(
              "-bundle.js.map",
              bundle.sourceMap!,
            ),
          },
          null,
          2,
        ),
      );
    }
  }
});

describe.each(cases)("$name", (scenario: PondGroundingScenario) => {
  const test = it.skipIf(!scenario.enabled);
  test(
    scenario.test,
    async () => {
      const lod = "lod" in scenario ? scenario.lod : 0;
      const isMeadowField = "meadowField" in scenario;
      const usesNativeComposition =
        isMeadowField ||
        "nativeSheath" in scenario ||
        "native52" in scenario ||
        "native72" in scenario ||
        "native74" in scenario ||
        "native82" in scenario ||
        "native86" in scenario ||
        "native106" in scenario ||
        "native108" in scenario ||
        "native118" in scenario ||
        "native121" in scenario ||
        "native95" in scenario;
      const usesNativeDetail =
        isMeadowField ||
        "nativeSheath" in scenario ||
        "native82" in scenario ||
        "native86" in scenario ||
        "native106" in scenario ||
        "native108" in scenario ||
        "native118" in scenario ||
        "native121" in scenario ||
        "native95" in scenario;
      const reconstructionObservation =
        "meadowField" in scenario
          ? scenario.meadowField
          : "nativeSheath" in scenario
            ? scenario.nativeSheath
            : "native121" in scenario
              ? scenario.native121
              : "native118" in scenario
                ? scenario.native118
                : null;
      const reconstructionAssets = reconstructionObservation
        ? [
            {
              path: resolve(
                process.env.ASSETS_DIR!,
                "manifests/world-config.json",
              ),
              expectedSHA256: reconstructionObservation.worldConfigSHA256,
            },
            {
              path: resolve(
                process.env.ASSETS_DIR!,
                "manifests/world-areas.json",
              ),
              expectedSHA256: reconstructionObservation.worldAreasSHA256,
            },
          ].map((pin) => {
            const bytes = readFileSync(pin.path);
            return { ...pin, bytes: bytes.length, sha256: hashBytes(bytes) };
          })
        : [];
      const reconstructionSources = reconstructionObservation
        ? [
            ...new Set(
              isMeadowField ||
                "native121" in scenario ||
                "nativeSheath" in scenario
                ? [
                    ...fittingReconstructionSourcePaths,
                    ...groundingWorkerSourcePins.map((pin) => pin.path),
                    ...(("meadowField" in scenario &&
                      scenario.meadowField.serviceCourt) ||
                    ("nativeSheath" in scenario &&
                      scenario.nativeSheath.id === "native146")
                      ? [
                          "../CompactServiceCourtSystem.ts",
                          "../CompactServiceCourt.ts",
                        ].map((path) =>
                          fileURLToPath(new URL(path, import.meta.url)),
                        )
                      : []),
                  ]
                : surfaceReconstructionSourcePaths,
            ),
          ]
            .sort()
            .map((path) => {
              const bytes = readFileSync(path);
              return { path, bytes: bytes.length, sha256: hashBytes(bytes) };
            })
        : [];
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
      let historicalRibbonGeometry: THREE.BufferGeometry | undefined;
      let worker: Worker | undefined;
      let groundingWorker: ActualGroundingWorker | undefined;
      let clientPort: ActualGrassGroundingClientPort | undefined;
      let groundingClient: GrassGroundingWorkerClient | undefined;
      let coordinator: GrassGroundingWorkerCoordinator | undefined;
      let publishedWorkerResult:
        | Extract<
            ReturnType<typeof legacyGroundGrassBlades>,
            { status: "ready" }
          >
        | undefined;
      let docks: ProceduralDocks | undefined;
      let serviceCourts: CompactServiceCourtSystem | undefined;
      const failures: unknown[] = [];
      reconstruction: try {
        if (
          isMeadowField ||
          "native121" in scenario ||
          "nativeSheath" in scenario
        ) {
          evidence(
            `${scenario.label}_SOURCE_INPUT_PINS`,
            JSON.stringify({
              ...(isMeadowField
                ? { candidateScenario: reconstructionObservation }
                : { historicalObservation: reconstructionObservation }),
              nodeVersion: process.version,
              assets: reconstructionAssets,
              sourcePins: reconstructionSources,
              workerBundle: {
                bytes: Buffer.byteLength(groundingWorkerSource),
                sha256: hashBytes(groundingWorkerSource),
              },
              scope:
                "Named reconstruction/placement/handoff owners plus all actual grounding-worker bundle inputs; not a complete application closure. Historical artifact hashes are provenance references, not current-source equality assertions.",
            }),
          );
          expect(
            reconstructionAssets.every(
              (pin) => pin.sha256 === pin.expectedSHA256,
            ),
          ).toBe(true);
        }
        if (usesNativeComposition) {
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
          // Select the actual native terrain/worker composition on these new
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
        if (usesNativeComposition) {
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
        if (usesNativeComposition) {
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
        if (
          ("meadowField" in scenario && scenario.meadowField.serviceCourt) ||
          ("nativeSheath" in scenario &&
            scenario.nativeSheath.id === "native146")
        ) {
          // Native145's saved outlyingBank authority includes these four live
          // footing exclusions inside cell15_17. Terrain/roads/docks omit this
          // deterministic owner; its missing placement exclusions are not RNG
          // or a reason to replace the historical 1125 source-count assertion.
          serviceCourts = world.register(
            COMPACT_SERVICE_COURT_SYSTEM,
            CompactServiceCourtSystem,
          ) as CompactServiceCourtSystem;
          await serviceCourts.init();
          await serviceCourts.start();
          const pondCourt = serviceCourts
            .getAllDiagnostics()
            .find((court) => court.layoutId === "haven-pond-bank-v1");
          expect(pondCourt).toMatchObject({
            position: { x: 384, z: 438 },
            blockingTiles: [
              { x: 380, z: 434 },
              { x: 387, z: 434 },
              { x: 380, z: 441 },
              { x: 387, z: 441 },
            ],
          });
          const footings = terrain[
            "landscapeGrassSurface"
          ].exclusionPolygons.filter((polygon) =>
            polygon.id.startsWith("haven-pond-bank-v1-footing-"),
          );
          expect(footings.map((polygon) => polygon.id)).toEqual(
            [0, 1, 2, 3].map((index) => `haven-pond-bank-v1-footing-${index}`),
          );
          evidence(
            `${scenario.label}_SERVICE_COURT_OWNER`,
            JSON.stringify({
              historicalSource: "native145/process.json#outlyingBank.authority",
              historicalSourceSHA256:
                "f863378b5fba84c713d5295f9932de20bc7abe50036a52b1b18b069356a3ff7a",
              actualOwner: pondCourt,
              actualGrassExclusions: footings,
              scope:
                "Actual shared court owner and its four deterministic pond-bank grass polygons. CPU fixture includes native physics; historical art owner reported no physics actor. Grass XZ footprints, not physics presence or cached ground heights, are the placement inputs being reconstructed.",
            }),
          );
        }
        const setup = {
          ...terrain["buildGrassWorkerSetup"](),
          compactGrassColorGrade:
            createCompactTerrainColorOperations().getGrassColorGrade().id,
        };
        if (usesNativeComposition) {
          expect(setup.compactPondBlend).toBe("composition-v1");
          expect(setup.compactPondBankField?.id).toBe("composition-v1");
          expect(setup.compactCoastBlend).toBeUndefined();
          expect(setup.compactGrassColorGrade).toBe("fine-meadow-green-v1");
        }
        const nativeDetailRegions = usesNativeDetail
          ? createCompactPreparationDetailRegions(
              terrain.getWorldTerrainProfile(),
              DataManager.getInstance().getAllWorldAreas(),
              terrain["CONFIG"].QUADTREE_RESOLUTION,
            )
          : undefined;
        visual = new TerrainVisualManager(
          {
            minSize: 100,
            maxDepth: 4,
            resolution: nativeDetailRegions
              ? STREAMING_TERRAIN_QUADTREE_RESOLUTION
              : 128,
            ...(nativeDetailRegions
              ? { fineDetailRegions: nativeDetailRegions }
              : {}),
            rootChunkRadius: 0,
          },
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
        if ("native82" in scenario) {
          expect(
            DataManager.getInstance().getAllWorldAreas().haven_pond.bounds,
          ).toEqual({ minX: 377, maxX: 443, minZ: 382, maxZ: 448 });
          expect(nodes.map((node) => node.resolution)).toEqual([128, 64]);
        }
        if ("native86" in scenario)
          expect(nodes.map((node) => node.resolution)).toEqual([128]);
        if (
          "native95" in scenario ||
          "nativeSheath" in scenario ||
          "meadowField" in scenario
        )
          expect(nodes.map((node) => node.resolution)).toEqual(
            scenario.resolutions,
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
            indexMs = 0,
            maxStepMs = 0,
            maxStepPhase = "",
            maxIndexStepMs = 0,
            maxIndexStepPhase = "";
          const resume = () => {
            const resumeAt = performance.now();
            const next = admission.next();
            const elapsed = performance.now() - resumeAt;
            if (elapsed > maxStepMs) {
              maxStepMs = elapsed;
              maxStepPhase = `${previous || "admission_start"} -> ${next.done ? "admission_complete" : next.value}`;
            }
            if (previous.startsWith("grounding-edge-index")) {
              indexMs += elapsed;
              if (elapsed > maxIndexStepMs) {
                maxIndexStepMs = elapsed;
                maxIndexStepPhase = `${previous} -> ${next.done ? "admission_complete" : next.value}`;
              }
            }
            return next;
          };
          let step = resume();
          while (!step.done) {
            previous = step.value;
            steps++;
            const index = previous.startsWith("grounding-edge-index");
            if (index) indexSteps++;
            step = resume();
          }
          if (
            ("native82" in scenario && node.centerX === 250) ||
            (("native95" in scenario ||
              "native106" in scenario ||
              "native108" in scenario ||
              "native118" in scenario ||
              "native121" in scenario ||
              "nativeSheath" in scenario ||
              isMeadowField) &&
              step.value.isRegularGrid)
          ) {
            // Historical pond fixtures all build refined 128-grid owners.
            // Startup/shoulder reconstruction may also lease regular owners;
            // resolution alone does not imply annular refinement or an index.
            if ("native82" in scenario) expect(node.resolution).toBe(64);
            expect(step.value.isRegularGrid).toBe(true);
            expect(step.value.groundingEdgeIndexStats).toBeNull();
            expect(indexSteps).toBe(0);
          } else {
            expect(step.value.groundingEdgeIndexStats?.admissionSteps).toBe(
              indexSteps,
            );
          }
          return {
            centerX: node.centerX,
            centerZ: node.centerZ,
            ...(usesNativeDetail
              ? {
                  resolution: node.resolution,
                  isRegularGrid: step.value.isRegularGrid,
                }
              : {}),
            elapsedMs: performance.now() - started,
            steps,
            indexMs,
            indexSteps,
            maxStepMs,
            maxStepPhase,
            maxIndexStepMs,
            maxIndexStepPhase,
            index: step.value.groundingEdgeIndexStats,
            scope:
              "CPU re-admission of exact retained geometry, including the first/terminal step. Index timing is attributed to the preceding yielded phase. Observed elapsed time includes allocation/GC and is not native frame qualification.",
          };
        });
        if ("native118" in scenario) {
          const node = nodes[0];
          const surface = retainedVisual.getRetainedSurface(node);
          if (!surface)
            throw new Error("Missing reconstructed native118 retained owner");
          const copies = surface.copySnapshotSteps(
            GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes,
          );
          let step = copies.next();
          let copyResumptions = 1;
          try {
            while (!step.done && copyResumptions < 10_000) {
              step = copies.next();
              copyResumptions++;
            }
            if (!step.done)
              throw new Error("Native118 snapshot copy exceeded step bound");
          } finally {
            if (!step.done) copies.return(undefined as never);
          }
          const snapshot = step.value;
          const snapshotReceipt = {
            nodeId: snapshot.nodeId,
            sourceRevision: snapshot.revision,
            terrainProfileIdentity: snapshot.terrainProfileIdentity,
            centerX: snapshot.centerX,
            centerZ: snapshot.centerZ,
            size: snapshot.size,
            resolution: snapshot.resolution,
            positionVersion: snapshot.positionVersion,
            indexVersion: snapshot.indexVersion,
            positions: bufferReceipt(snapshot.positions),
            indices: bufferReceipt(snapshot.indices),
            topology: snapshot.topology
              ? {
                  schemaVersion: snapshot.topology.schemaVersion,
                  resolution: snapshot.topology.resolution,
                  surfaceVertexCount: snapshot.topology.surfaceVertexCount,
                  cellIndexOffsets: bufferReceipt(
                    snapshot.topology.cellIndexOffsets,
                  ),
                }
              : null,
          };
          const copiedBytes =
            snapshot.positions.byteLength +
            snapshot.indices.byteLength +
            (snapshot.topology?.cellIndexOffsets.byteLength ?? 0);
          const consumed = { operations: 0, activeMs: 0, maximumSliceMs: 0 };
          let response: Extract<
            GrassGroundingWorkerResponse,
            { type: "surface_prepared" }
          > | null = null;
          let transportError: string | null = null;
          let jobId: number | null = null;
          const workerStartedAt = new Date().toISOString();
          const workerStarted = performance.now();
          try {
            clientPort = new ActualGrassGroundingClientPort(
              groundingWorkerSource,
            );
            await clientPort.ready();
            groundingClient = new GrassGroundingWorkerClient(clientPort);
            jobId = groundingClient.submit({
              type: "prepare_surface",
              schemaVersion: 1,
              generation: 1,
              token: 1,
              snapshot,
              consumed,
            });
            response = await clientPort.waitFor("surface_prepared", jobId);
          } catch (error) {
            transportError = String(error).slice(0, 2048);
          }
          const workerCompletedAt = new Date().toISOString();
          const workerWallMs = performance.now() - workerStarted;
          const settled = groundingClient?.takeSettled() ?? null;
          const pinsBefore = [
            ...reconstructionSources,
            ...reconstructionAssets,
          ];
          const pinsAfter = pinsBefore.map((pin) => {
            const bytes = readFileSync(pin.path);
            return {
              path: pin.path,
              bytes: bytes.length,
              sha256: hashBytes(bytes),
            };
          });
          const sourcesUnchanged = pinsBefore.every(
            (pin, i) =>
              pin.bytes === pinsAfter[i].bytes &&
              pin.sha256 === pinsAfter[i].sha256,
          );
          const copiedBuffersDetached =
            snapshot.positions.byteLength === 0 &&
            snapshot.indices.byteLength === 0 &&
            (!snapshot.topology ||
              snapshot.topology.cellIndexOffsets.byteLength === 0);
          // Persist raw failures before success/identity assertions. The actual
          // worker caps remain unchanged; no historical elapsed time is seeded.
          evidence(
            scenario.label,
            JSON.stringify({
              schemaVersion: 1,
              nodeVersion: process.version,
              historicalObservation: scenario.native118,
              assets: reconstructionAssets,
              sourcePins: reconstructionSources,
              sourcePinScope:
                "Named reconstruction, generator and admission owners plus the actual worker bundle hash; not a complete application dependency closure.",
              sourcePinsAfter: pinsAfter,
              sourcesUnchanged,
              workerBundle: {
                bytes: Buffer.byteLength(groundingWorkerSource),
                sha256: hashBytes(groundingWorkerSource),
              },
              terrain: {
                seed: setup.seed,
                detailRegions: nativeDetailRegions,
                snapshot: snapshotReceipt,
                mainThreadReconstructedAdmission: admissionReceipts,
                copyResumptions,
                copiedBytes,
                historicalInputBytesMatch:
                  copiedBytes === scenario.native118.inputBytes,
              },
              worker: {
                jobId,
                generation: 1,
                token: 1,
                consumed,
                startedAt: workerStartedAt,
                completedAt: workerCompletedAt,
                wallMsIncludingStartupAndTransport: workerWallMs,
                copiedBuffersDetached,
                rawResponse: response,
                settled,
                transportError,
                historicalInputBytesMatch:
                  response?.inputBytes === scenario.native118.inputBytes,
                historicalDerivedBytesMatch:
                  response?.derivedBytesReserved ===
                  scenario.native118.derivedBytesReserved,
              },
              scope:
                "Actual Node worker surface-only admission with zero consumed seed and original limits. Main-thread reconstructed admission, worker continuation slice-elapsed observations and host/transport wall time are separate; none locates or explains native118's historical 96ms slice. Fresh node IDs and revisions, no historical packet arrays/hash, no placement/fitting, no native startup or performance approval.",
            }),
          );
          expect(
            reconstructionAssets.every(
              (pin) => pin.sha256 === pin.expectedSHA256,
            ),
          ).toBe(true);
          expect(sourcesUnchanged).toBe(true);
          expect(nodes).toHaveLength(1);
          expect(snapshotReceipt).toMatchObject({
            centerX: 350,
            centerZ: 450,
            size: 100,
            resolution: 128,
          });
          expect(snapshotReceipt.topology).not.toBeNull();
          expect(copiedBytes).toBe(scenario.native118.inputBytes);
          expect(transportError).toBeNull();
          expect(copiedBuffersDetached).toBe(true);
          expect(settled?.status).toBe("response");
          if (settled?.status === "response")
            expect(settled.response).toBe(response);
          if (!response)
            throw new Error("Missing native118 surface admission response");
          expect(response.inputBytes).toBe(scenario.native118.inputBytes);
          expect(response.derivedBytesReserved).toBe(
            scenario.native118.derivedBytesReserved,
          );
          expect(response.state).toEqual({
            status: "prepared",
            token: 1,
            sourceRevision: snapshotReceipt.sourceRevision,
          });
          expect(response.work.operations).toBeGreaterThan(0);
          expect(response.work.activeMs).toBeGreaterThan(0);
          expect(response.work.maximumSliceMs).toBeGreaterThan(0);
          expect(retainedVisual.isRetainedSurfaceCurrent(surface)).toBe(true);
          // A labeled exit still reaches finally and its error aggregation;
          // returning here would silently skip cleanup failures below.
          break reconstruction;
        }
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
          usesNativeComposition ? "leaf-volume-v1" : undefined,
          undefined,
          "geometryCandidate" in scenario
            ? scenario.geometryCandidate
            : "nativeSheath" in scenario
              ? "sheath-close-v1"
              : undefined,
        );
        if (usesNativeComposition) {
          // Consume the focus through the real update boundary before queuing
          // any work; setPlayerPosition alone does not update the LOD focus.
          manager.update(scenario.focus[0], scenario.focus[1]);
        } else manager.setPlayerPosition(scenario.focus[0], scenario.focus[1]);
        manager.onNodeNeedsGeometry(nodes[0]);
        const key = scenario.key;
        const work = manager["liveWorkUnits"].get(key)!;
        expect(work.bounds).toEqual(scenario.bounds);
        expect(work.node).toBe(nodes[0]);
        if (usesNativeComposition)
          expect(manager["getLodLevel"](work)).toBe(lod);
        const input = manager["createWorkerInput"](work, key, lod);
        if ("native52" in scenario && key === "gcell_v1_17_16")
          expect(
            input.terrainSurface.exclusionPolygons?.find(
              (polygon) => polygon.id === "pond-dock-haven-reed-jetty",
            ),
          ).toMatchObject({ minX: 427, maxX: 435, minZ: 414, maxZ: 417 });
        expect(input.placementDistribution).toBe("fine-cell-stratified-v1");
        expect(input.clumpSpacing).toBe(isMeadowField ? 0.5 : 0.7);
        if (isMeadowField) {
          expect(input.spacingMul).toBe(1);
          expect(input.placementCoverage).toBeUndefined();
          expect(input.placementCell).toMatchObject({ size: 25 });
          expect(
            createGrassPlacementCellOperations().resolveDomain(input).maxCount,
          ).toBe(2500);
          expect(manager.getProfileReceipt().placement).toMatchObject({
            cellSize: 25,
            detailLodDistance: 12,
            nearLodDistance: 40,
          });
        }
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
        if (isMeadowField) {
          expect(output.count).toBeGreaterThan(0);
          expect(output.count).toBeLessThanOrEqual(2500);
          for (const [key, stride] of attributes)
            expect(output[key]).toHaveLength(output.count * stride);
        }
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
        if ("native82" in scenario) {
          expect(
            region.surfaces.map((surface) => ({
              centerX: surface.centerX,
              centerZ: surface.centerZ,
              size: surface.size,
              resolution: surface.resolution,
            })),
          ).toEqual([
            { centerX: 350, centerZ: 450, size: 100, resolution: 128 },
            { centerX: 250, centerZ: 450, size: 100, resolution: 64 },
          ]);
        }
        if (
          "native95" in scenario ||
          "nativeSheath" in scenario ||
          "meadowField" in scenario
        ) {
          expect(
            region.surfaces.map((surface) => [
              surface.centerX,
              surface.centerZ,
              surface.size,
              surface.resolution,
            ]),
          ).toEqual(
            scenario.nodes.map(
              ([x, z]: readonly [number, number], index: number) => [
                x,
                z,
                100,
                scenario.resolutions[index],
              ],
            ),
          );
        }
        const lease = setup.prepareGroundingInputs!(bounds);
        let step = lease.steps.next();
        while (!step.done) step = lease.steps.next();
        const bankVerge = manager["compactMacroField"]?.bankVerge;
        const pondServiceGround =
          manager["compactMacroField"]?.pondServiceGround;
        const request: GrassBladeGroundingRequest = {
          data: projected,
          geometry: manager["lodGeometries"][lod],
          lod,
          geometryLayout: manager.getProfileReceipt().geometryLayout,
          roadClearance: "per-blade-v1",
          ...(bankVerge ? { bankVerge } : {}),
          ...(pondServiceGround ? { pondServiceGround } : {}),
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
        expect(request.geometryLayout).toBe(
          isMeadowField
            ? "fine-meadow-ribbon-v1"
            : "nativeSheath" in scenario
              ? "fine-folded-sheath-near5-v1"
              : usesNativeComposition
                ? "fine-folded-lancet-v1"
                : "fine-linear-sweep-3seg-v1",
        );
        const actualLayout = getGrassBladeLayout(lod, request.geometryLayout);
        if ("geometryCandidate" in scenario) {
          expect(manager.getProfileReceipt().geometryCandidate).toBe(
            scenario.geometryCandidate,
          );
          expect(request.geometry.userData.grassRootComposition.id).toBe(
            scenario.geometryCandidate,
          );
          expect(
            Object.isFrozen(request.geometry.userData.grassRootComposition),
          ).toBe(true);
        }
        if ("nativeSheath" in scenario) {
          expect(actualLayout).toMatchObject({
            bladesPerClump: 24,
            bladeSegments: 5,
            verticesPerBlade: 15,
            verticesPerClump: 360,
            trianglesPerClump: 408,
            rootComponents: 2,
          });
          expect(manager.getProfileReceipt().placement?.detailLodDistance).toBe(
            12,
          );
          expect(projected.count).toBe(
            scenario.nativeSheath.baselineInputClumps,
          );
          expect(request.workBudget).toBeUndefined();
        }
        if (isMeadowField) {
          expect(actualLayout).toMatchObject(
            [
              {
                bladesPerClump: 21,
                bladeSegments: 3,
                verticesPerBlade: 7,
                verticesPerClump: 147,
                trianglesPerClump: 105,
                rootComponents: 2,
              },
              {
                bladesPerClump: 21,
                bladeSegments: 2,
                verticesPerBlade: 5,
                verticesPerClump: 105,
                trianglesPerClump: 63,
                rootComponents: 2,
              },
              {
                bladesPerClump: 12,
                bladeSegments: 2,
                verticesPerBlade: 5,
                verticesPerClump: 60,
                trianglesPerClump: 36,
                rootComponents: 2,
              },
            ][lod],
          );
          expect(usesGrassBladeHeightFlex(request.geometryLayout)).toBe(true);
          expect(request.geometry.userData.grassRootComposition).toEqual(
            FINE_GRASS_MEADOW_FIELD_COMPOSITION,
          );
          expect(projected.count).toBeGreaterThan(0);
          expect(projected.count).toBeLessThanOrEqual(output.count);
          expect(request.workBudget).toBeUndefined();
        }
        expect(request.geometry.getAttribute("position").count).toBe(
          actualLayout.verticesPerClump,
        );
        expect(request.geometry.index!.count).toBe(
          actualLayout.trianglesPerClump * 3,
        );
        // The frozen oracle knows ribbon faces only. Keep a real, explicitly
        // separate historical-shape control; it cannot qualify the new fold.
        if (usesNativeComposition && !isMeadowField && lod === 0)
          historicalRibbonGeometry = createClumpGeometry(
            24,
            3,
            FINE_MEADOW_APPEARANCE,
          );
        const historicalShapeRequest: GrassBladeGroundingRequest =
          usesNativeComposition && !isMeadowField
            ? {
                ...request,
                geometry: historicalRibbonGeometry ?? request.geometry,
                geometryLayout: "fine-linear-sweep-3seg-v1",
              }
            : request;
        // Keep this exact detached copy for the subsequent cold-worker trial;
        // hashing does not copy live renderer inputs or alter fitting ledgers.
        const reconstructionCopyStarted = performance.now();
        const reconstructionPacket =
          "native121" in scenario
            ? createGrassGroundingWorkerRequest(request)
            : null;
        const reconstructionCopyMs =
          performance.now() - reconstructionCopyStarted;
        if ("native121" in scenario && reconstructionPacket) {
          evidence(
            `${scenario.label}_RECONSTRUCTED_INPUT`,
            JSON.stringify({
              key,
              lod,
              focus: scenario.focus,
              historicalObservation: scenario.native121,
              terrainSeed: setup.seed,
              terrainProfileIdentity:
                setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
              detailRegions: nativeDetailRegions,
              workBounds: work.bounds,
              groundingBounds: bounds,
              placementInput: serializedInputReceipt(input),
              rawWorker: attributeReceipts(output),
              projectedWorker: attributeReceipts(projected),
              packet: serializedInputReceipt(reconstructionPacket),
              constraints: serializedInputReceipt(
                reconstructionPacket.constraints,
              ),
              settings: reconstructionPacket.settings,
              consumed: reconstructionPacket.consumed,
              geometry: {
                position: bufferReceipt(reconstructionPacket.geometry.position),
                normal: bufferReceipt(reconstructionPacket.geometry.normal),
                uv: bufferReceipt(reconstructionPacket.geometry.uv),
                index: bufferReceipt(reconstructionPacket.geometry.index),
                drawCount: reconstructionPacket.geometry.drawCount,
              },
              retainedOwners: reconstructionPacket.surfaces.map(
                ({ token, snapshot }) => ({
                  token,
                  nodeId: snapshot.nodeId,
                  sourceRevision: snapshot.revision,
                  centerX: snapshot.centerX,
                  centerZ: snapshot.centerZ,
                  size: snapshot.size,
                  resolution: snapshot.resolution,
                  terrainProfileIdentity: snapshot.terrainProfileIdentity,
                  positions: bufferReceipt(snapshot.positions),
                  indices: bufferReceipt(snapshot.indices),
                  topology: snapshot.topology
                    ? {
                        schemaVersion: snapshot.topology.schemaVersion,
                        resolution: snapshot.topology.resolution,
                        surfaceVertexCount:
                          snapshot.topology.surfaceVertexCount,
                        cellIndexOffsets: bufferReceipt(
                          snapshot.topology.cellIndexOffsets,
                        ),
                      }
                    : null,
                }),
              ),
              mainThreadReconstructedAdmission: admissionReceipts,
              fixtureCopyMs: reconstructionCopyMs,
              scope:
                "Source-bound reconstruction before fitting. Exact current input/geometry views are pinned, including actual production neighbors; historical arrays were not retained. Fixture capture/hash costs are outside the worker cap and reported separately from the later measured production handoff, not native performance evidence.",
            }),
          );
          expect(
            region.surfaces.map((surface) => [
              surface.centerX,
              surface.centerZ,
              surface.size,
            ]),
          ).toEqual(
            scenario.nodes.map(([x, z]: readonly [number, number]) => [
              x,
              z,
              100,
            ]),
          );
          expect(ownSurface.resolution).toBe(128);
          expect(pondServiceGround).toEqual(setup.pondServiceGround);
        }
        if ("native95" in scenario) {
          expect(pondServiceGround).toBeDefined();
          expect(pondServiceGround).toEqual(setup.pondServiceGround);
          evidence(
            `${scenario.label}_RECONSTRUCTED_INPUT`,
            JSON.stringify({
              key,
              lod,
              focus: scenario.focus,
              native95HistoricalObservation: scenario.native95,
              terrainProfileIdentity:
                setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
              rawWorker: attributeReceipts(output),
              projectedWorker: attributeReceipts(projected),
              bankVerge: request.bankVerge ?? null,
              pondServiceGround: request.pondServiceGround,
              geometryLayout: request.geometryLayout,
              roadClearance: request.roadClearance,
              wind: request.wind,
              oceanLevel: request.oceanLevel,
              workBounds: work.bounds,
              groundingBounds: bounds,
              retainedRegion: region.surfaces.map((surface) => ({
                centerX: surface.centerX,
                centerZ: surface.centerZ,
                size: surface.size,
                resolution: surface.resolution,
              })),
            }),
          );
        }
        if ("nativeSheath" in scenario || "meadowField" in scenario) {
          expect(pondServiceGround).toBeDefined();
          expect(pondServiceGround).toEqual(setup.pondServiceGround);
          const packet = createGrassGroundingWorkerRequest(request);
          evidence(
            `${scenario.label}_RECONSTRUCTED_INPUT`,
            JSON.stringify({
              key,
              lod,
              focus: scenario.focus,
              ...("meadowField" in scenario
                ? { candidateScenario: scenario.meadowField }
                : { historicalObservation: scenario.nativeSheath }),
              geometryCandidate: manager.getProfileReceipt().geometryCandidate,
              terrainSeed: setup.seed,
              terrainProfileIdentity:
                setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
              placementInput: serializedInputReceipt(input),
              rawWorker: attributeReceipts(output),
              projectedWorker: attributeReceipts(projected),
              packet: serializedInputReceipt(packet),
              constraints: serializedInputReceipt(packet.constraints),
              settings: packet.settings,
              consumed: packet.consumed,
              geometry: {
                position: bufferReceipt(packet.geometry.position),
                normal: bufferReceipt(packet.geometry.normal),
                uv: bufferReceipt(packet.geometry.uv),
                index: bufferReceipt(packet.geometry.index),
                drawCount: packet.geometry.drawCount,
              },
              workBounds: work.bounds,
              groundingBounds: bounds,
              retainedOwners: packet.surfaces.map(({ token, snapshot }) => ({
                token,
                centerX: snapshot.centerX,
                centerZ: snapshot.centerZ,
                size: snapshot.size,
                resolution: snapshot.resolution,
                positions: bufferReceipt(snapshot.positions),
                indices: bufferReceipt(snapshot.indices),
              })),
              scope:
                "meadowField" in scenario
                  ? scenario.meadowField.scope
                  : scenario.nativeSheath.scope,
            }),
          );
        }
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
                  native52ComparisonScope:
                    "Actual native52 input/retained counts are asserted; original live operations remain a historical comparator, not a timing or scheduling assertion.",
                }
              : {}),
            ...("native72" in scenario
              ? { native72HistoricalObservation: scenario.native72 }
              : {}),
            ...("native74" in scenario
              ? { native74HistoricalObservation: scenario.native74 }
              : {}),
            ...("native86" in scenario
              ? { native86HistoricalObservation: scenario.native86 }
              : {}),
            ...("native106" in scenario
              ? { native106HistoricalObservation: scenario.native106 }
              : {}),
            ...("native108" in scenario
              ? { native108HistoricalObservation: scenario.native108 }
              : {}),
            ...("native121" in scenario
              ? { native121HistoricalObservation: scenario.native121 }
              : {}),
            ...("nativeSheath" in scenario
              ? {
                  [`${scenario.nativeSheath.id}HistoricalObservation`]:
                    scenario.nativeSheath,
                }
              : {}),
            ...("native95" in scenario
              ? { native95HistoricalObservation: scenario.native95 }
              : {}),
            ...(usesNativeDetail
              ? {
                  ...("native82" in scenario
                    ? { native82HistoricalObservation: scenario.native82 }
                    : {}),
                  terrainDetailPolicy: {
                    baseResolution: STREAMING_TERRAIN_QUADTREE_RESOLUTION,
                    gameplayResolution: terrain["CONFIG"].QUADTREE_RESOLUTION,
                    fineDetailRegions: nativeDetailRegions,
                    retainedRegion: region.surfaces.map((surface) => ({
                      centerX: surface.centerX,
                      centerZ: surface.centerZ,
                      size: surface.size,
                      resolution: surface.resolution,
                    })),
                  },
                }
              : {}),
            ...(usesNativeComposition
              ? {
                  actualDockOwners: docks!.getCompactDiagnostics(),
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
                    grassGeometryLayout: request.geometryLayout,
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
            ...(pondServiceGround ? { pondServiceGround: true } : {}),
            status: result.status,
            reason: result.status === "defer" ? result.reason : null,
            receipt: result.receipt,
            phaseAudit: audit,
          }),
        );
        if (result.status === "defer" && !isMeadowField) {
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
          const diagnosticRequest = { ...historicalShapeRequest };
          delete diagnosticRequest.pondServiceGround;
          const fixed = legacyGroundGrassBlades({
            ...diagnosticRequest,
            data: empty,
          });
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
            const one = legacyGroundGrassBlades({ ...diagnosticRequest, data });
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
                "Frozen per-clump historical-ribbon oracle without pond-service wear only; not folded geometry evidence. Full current production job still failed its cap.",
            }),
          );
        }
        expect(result.status).toBe("ready");
        expect(result.receipt.workBudget).toBe(1_000_000);
        expect(result.receipt.workUnits).toBeLessThanOrEqual(1_000_000);
        if (result.status !== "ready") throw new Error(result.reason);
        if (isMeadowField) {
          expect(result.receipt.processedClumps).toBe(projected.count);
          expect(result.receipt.maxAcceptedBaseError).toBeLessThanOrEqual(0.02);
          expect(result.rootDeltas).toHaveLength(
            result.data.count * actualLayout.bladesPerClump * 2,
          );
          expect(result.bladeVisibility).toHaveLength(result.data.count);
          const validBits = 2 ** actualLayout.bladesPerClump - 1;
          let previousSource = -1;
          let visibleBlades = 0;
          for (let row = 0; row < result.data.count; row++) {
            const source = result.sourceIndices[row];
            expect(source).toBeGreaterThan(previousSource);
            expect(source).toBeLessThan(projected.count);
            previousSource = source;
            let mask = result.bladeVisibility![row];
            expect(mask).toBeGreaterThan(0);
            expect(mask).toBeLessThanOrEqual(validBits);
            while (mask) {
              visibleBlades++;
              mask &= mask - 1;
            }
          }
          expect(result.receipt.roadClearance?.retainedBlades).toBe(
            visibleBlades,
          );
        }
        if ("native52" in scenario)
          expect(result.data.count).toBe(scenario.native52.retainedClumps);

        groundingWorker = await createActualGroundingWorker(
          groundingWorkerSource,
        );
        const copyStarted = performance.now();
        const packet =
          reconstructionPacket ?? createGrassGroundingWorkerRequest(request);
        expect(packet.settings.pondServiceGround).toEqual(pondServiceGround);
        if (pondServiceGround)
          expect(packet.settings.pondServiceGround).not.toBe(pondServiceGround);
        const snapshotCopyMs = reconstructionPacket
          ? reconstructionCopyMs
          : performance.now() - copyStarted;
        const workerStarted = performance.now();
        const workerResult = await runGrassGroundingWorker(
          groundingWorker,
          packet,
        );
        evidence(
          `${scenario.label}_GROUNDING_WORKER`,
          JSON.stringify({
            key,
            lod,
            status: workerResult.state.status,
            reason:
              workerResult.state.status === "failed_budget"
                ? workerResult.state.reason
                : workerResult.state.status === "failed_input"
                  ? workerResult.state.error
                  : null,
            work: workerResult.work,
            ...("native121" in scenario
              ? { timing: workerResult.timing ?? null }
              : {}),
            lastPhase: workerResult.lastPhase,
            terrainRebuildWork: workerResult.terrainRebuildWork,
            inputBytes: workerResult.inputBytes,
            derivedBytesReserved: workerResult.derivedBytesReserved,
            resultBytes: workerResult.resultBytes,
            snapshotCopyMs,
            workerWallMs: performance.now() - workerStarted,
            scope:
              "Actual browser-target worker bundle in a Node worker realm. Original work/CPU limits include terrain reconstruction and full-cell fitting. Fixture snapshot copying is measured separately, not budgeted production handoff. Payload reservations are not total heap. This is numerical/transport evidence, not native browser or game scheduling qualification.",
          }),
        );
        // Preserve the cold monolithic trial as a diagnostic. Its measured
        // repeated admission exhausted the original fitting budget; the actual
        // candidate below instead has an explicit once-per-owner lifecycle.
        // Unexpected errors remain failures, and successful cold outputs still
        // must be bitwise identical. No cold failure is relabeled as a pass.
        if (workerResult.state.status === "ready")
          expect(
            grassGroundingWorkerSemanticResult(
              workerResult.state.result,
              request,
            ),
          ).toEqual(grassGroundingWorkerSemanticResult(result, request));
        else
          expect(workerResult.state).toEqual({
            status: "failed_budget",
            reason: "active_cpu",
          });
        await groundingWorker.close();
        groundingWorker = undefined;

        const cachedStarted = performance.now();
        const profileCachedFit =
          !!cpuProfilePrefix &&
          (("native95" in scenario && scenario.key === "gcell_v1_11_16") ||
            ("native121" in scenario && scenario.key === "gcell_v1_13_16"));
        groundingWorker = await createActualGroundingWorker(
          groundingWorkerSource,
          { profileCachedFit },
        );
        const cachedCopyStarted = performance.now();
        const cachedPacket = createGrassGroundingWorkerRequest(request);
        const cachedCopyMs = performance.now() - cachedCopyStarted;
        const cachedInput =
          "native121" in scenario ? serializedInputReceipt(cachedPacket) : null;
        const prepared = await prepareCachedGrassGroundingWorkerRequest(
          groundingWorker,
          cachedPacket,
        );
        if (profileCachedFit) {
          const executionSource = groundingWorker.executionSource;
          writeProfileEvidence("-worker-eval.js", executionSource);
          writeProfileEvidence(
            "-request.json",
            JSON.stringify(
              {
                key,
                lod,
                jobId: prepared.request.jobId,
                generation: prepared.request.generation,
                settings: prepared.request.settings,
                consumed: prepared.request.consumed,
                ...("native121" in scenario
                  ? {
                      historicalObservation: scenario.native121,
                      scope:
                        "Current-source reconstructed native121 cached fit with zero seed. Separately measured production handoff follows; not historical byte-exact replay.",
                    }
                  : {}),
                projected: attributeReceipts(projected),
                admissions: prepared.admissions,
                bundleStartLineOneBased: executionSource
                  .slice(0, executionSource.indexOf(groundingWorkerSource))
                  .split("\n").length,
              },
              null,
              2,
            ),
          );
        }
        const fitStarted = performance.now();
        let completedAt = fitStarted;
        // Await BOTH the original result/transfer checks and profiler stop
        // receipt before owned termination, even if either branch fails.
        const [fitOutcome, profileOutcome] = await Promise.allSettled([
          runGrassGroundingWorker(groundingWorker, prepared.request).then(
            (result) => {
              completedAt = performance.now();
              return result;
            },
          ),
          profileCachedFit
            ? groundingWorker.takeCpuProfile(
                prepared.request.jobId,
                prepared.request.generation,
              )
            : Promise.resolve(null),
        ]);
        const profileFailures: unknown[] = [];
        if ("native121" in scenario && fitOutcome.status === "fulfilled") {
          const raw = fitOutcome.value;
          evidence(
            `${scenario.label}_RAW_CACHED_FIT`,
            JSON.stringify({
              jobId: raw.jobId,
              generation: raw.generation,
              state:
                raw.state.status === "ready" ? { status: "ready" } : raw.state,
              work: raw.work,
              timing: raw.timing ?? null,
              lastPhase: raw.lastPhase,
              inputBytes: raw.inputBytes,
              derivedBytesReserved: raw.derivedBytesReserved,
              resultBytes: raw.resultBytes,
            }),
          );
        }
        if (fitOutcome.status === "rejected")
          profileFailures.push(fitOutcome.reason);
        if (profileOutcome.status === "rejected")
          profileFailures.push(profileOutcome.reason);
        else if (profileOutcome.value) {
          try {
            const historical =
              "native121" in scenario
                ? scenario.native121
                : "native95" in scenario
                  ? scenario.native95
                  : null;
            if (!historical)
              throw new Error("Unadmitted cached-fit profile scenario");
            saveCachedProfile(profileOutcome.value, {
              label: "native121" in scenario ? scenario.label : "NATIVE95",
              key,
              historicalSource: historical.source,
              historicalSourceSHA256: historical.sourceSHA256,
            });
          } catch (error) {
            profileFailures.push(error);
          }
        }
        if (profileFailures.length === 1) throw profileFailures[0];
        if (profileFailures.length > 1)
          throw new AggregateError(
            profileFailures,
            "Cached worker result and diagnostic profile failed",
          );
        if (fitOutcome.status !== "fulfilled") throw fitOutcome.reason;
        const cachedResult = fitOutcome.value;
        evidence(
          `${scenario.label}_CACHED_GROUNDING_WORKER`,
          JSON.stringify({
            key,
            lod,
            ...(cachedInput ? { reconstructedInput: cachedInput } : {}),
            admissions: prepared.admissions,
            status: cachedResult.state.status,
            reason:
              cachedResult.state.status === "failed_budget"
                ? cachedResult.state.reason
                : cachedResult.state.status === "failed_input"
                  ? cachedResult.state.error
                  : null,
            work: cachedResult.work,
            timing: cachedResult.timing ?? null,
            lastPhase: cachedResult.lastPhase,
            inputBytes: cachedResult.inputBytes,
            derivedBytesReserved: cachedResult.derivedBytesReserved,
            resultBytes: cachedResult.resultBytes,
            cpuProfileEnabled: profileCachedFit,
            snapshotCopyMs: cachedCopyMs,
            fittingWallMs: completedAt - fitStarted,
            coldEndToEndWallMs: completedAt - cachedStarted,
            totalActiveMs:
              cachedResult.work.activeMs +
              prepared.admissions.reduce(
                (sum, admission) => sum + admission.work.activeMs,
                0,
              ),
            scope:
              "Explicit one-time per-owner terrain admission followed by a full-cell fit under the unchanged fitting cap. Every preparation retains its own bounded work receipt; total active and cold wall time include them. Fixture copying is measured, not production-scheduler qualified. Actual browser bundle runs in a Node worker realm, not gameplay or native browser qualification.",
          }),
        );
        expect(cachedResult.state.status).toBe("ready");
        if (cachedResult.state.status !== "ready")
          throw new Error(
            `Actual cached pond worker ${cachedResult.state.status}`,
          );
        if ("nativeSheath" in scenario || isMeadowField) {
          expect(cachedResult.work.operations).toBeLessThan(1_000_000);
          expect(cachedResult.work.activeMs).toBeLessThan(250);
        }
        expect(
          grassGroundingWorkerSemanticResult(
            cachedResult.state.result,
            request,
          ),
        ).toEqual(grassGroundingWorkerSemanticResult(result, request));
        // Copied input ownership has moved; the live renderer and projection
        // arrays remain intact and the original region is still authoritative.
        expect(region.isCurrent()).toBe(true);
        for (const [index, [key]] of attributes.entries())
          expect(projected[key]).toEqual(inputBefore[index]);
        await groundingWorker.close();
        groundingWorker = undefined;

        // One declared diagnostic comparison, off in ordinary regressions.
        // Fresh isolates and transferred copies for every AB/BA pair; never
        // reuse detached buffers, warm an owner, relax caps or use a profiler.
        if (
          cachedBaselineSource &&
          (("native95" in scenario && scenario.key === "gcell_v1_11_16") ||
            ("native121" in scenario && scenario.key === "gcell_v1_13_16"))
        ) {
          const expected = grassGroundingWorkerSemanticResult(result, request);
          const order = [
            "baseline",
            "candidate",
            "candidate",
            "baseline",
            "baseline",
            "candidate",
            "candidate",
            "baseline",
          ] as const;
          for (const [index, variant] of order.entries()) {
            const source =
              variant === "baseline"
                ? cachedBaselineSource
                : groundingWorkerSource;
            const coldStarted = performance.now();
            groundingWorker = await createActualGroundingWorker(source);
            const comparisonPacket = createGrassGroundingWorkerRequest(request);
            const comparisonInput =
              "native121" in scenario
                ? serializedInputReceipt(comparisonPacket)
                : null;
            const comparisonPrepared =
              await prepareCachedGrassGroundingWorkerRequest(
                groundingWorker,
                comparisonPacket,
              );
            const started = performance.now();
            const comparison = await runGrassGroundingWorker(
              groundingWorker,
              comparisonPrepared.request,
            );
            const finished = performance.now();
            evidence(
              "native121" in scenario
                ? `${scenario.label}_CACHED_AB`
                : "NATIVE95_CACHED_AB",
              JSON.stringify({
                index,
                variant,
                key,
                lod,
                ...("native121" in scenario
                  ? { historicalObservation: scenario.native121 }
                  : {}),
                ...(comparisonInput
                  ? { reconstructedInput: comparisonInput }
                  : {}),
                bundleSHA256: hashBytes(source),
                status: comparison.state.status,
                ...("native121" in scenario
                  ? {
                      failure:
                        comparison.state.status === "ready"
                          ? null
                          : comparison.state,
                      timing: comparison.timing ?? null,
                    }
                  : {}),
                work: comparison.work,
                lastPhase: comparison.lastPhase,
                inputBytes: comparison.inputBytes,
                resultBytes: comparison.resultBytes,
                admissions: comparisonPrepared.admissions,
                fittingWallMs: finished - started,
                coldEndToEndWallMs: finished - coldStarted,
                buffers:
                  comparison.state.status === "ready" &&
                  comparison.state.result.status === "ready"
                    ? groundedBufferReceipts(comparison.state.result)
                    : null,
                scope:
                  "Four serial AB/BA pairs, fresh Node worker isolates, identical current-source cell and original caps. Includes scheduling and GC; no browser, frame-rate or exclusive CPU claim. Failed observations are retained before assertions.",
              }),
            );
            expect(comparison.state.status).toBe("ready");
            if (comparisonInput) expect(comparisonInput).toEqual(cachedInput);
            if (comparison.state.status !== "ready")
              throw new Error(`Cached comparison failed: ${variant}`);
            expect(
              grassGroundingWorkerSemanticResult(
                comparison.state.result,
                request,
              ),
            ).toEqual(expected);
            expect(comparison.work.operations).toBe(
              cachedResult.work.operations,
            );
            expect(comparison.inputBytes).toBe(cachedResult.inputBytes);
            expect(comparison.resultBytes).toBe(cachedResult.resultBytes);
            for (const [inputIndex, [attribute]] of attributes.entries())
              expect(projected[attribute]).toEqual(inputBefore[inputIndex]);
            await groundingWorker.close();
            groundingWorker = undefined;
          }
        }

        // Exercise production handoff/client/publication against the actual
        // full pond cell. The fixture still owns once-per-surface capture;
        // manager cache lifecycle and native frame scheduling remain separate.
        const handoffStarted = performance.now();
        const handoffInputs = setup.prepareGroundingInputs!(bounds);
        const isCurrent = () => region.isCurrent() && handoffInputs.isCurrent();
        const handoff = new GrassGroundingPreparationContinuation(
          prepareGrassGroundingHandoffSteps(
            { ...request, data: output },
            handoffInputs,
            (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
            (x, z) => terrain["isGrassExcludedAt"](x, z),
          ),
          isCurrent,
        );
        for (let i = 0; i < 10_000 && handoff.state.status === "running"; i++)
          handoff.advance();
        if ("native121" in scenario) {
          evidence(
            `${scenario.label}_HANDOFF_PREPARATION`,
            JSON.stringify({
              key,
              lod,
              state:
                handoff.state.status === "prepared"
                  ? { status: "prepared" }
                  : handoff.state,
              submittedWork: {
                operations: handoff.operations,
                activeMs: handoff.activeMs,
                maximumSliceMs: handoff.maximumSliceMs,
              },
              historicalSubmittedWork: scenario.native121.submittedWork,
              scope:
                "Fresh measured production projection/copy/constraint handoff seed; historical elapsed time and work are not injected or subtracted.",
            }),
          );
        }
        if (handoff.state.status !== "prepared")
          throw new Error(
            "Pond handoff did not prepare: " + JSON.stringify(handoff.state),
          );
        const transferred = handoff.state.prepared;
        clientPort = new ActualGrassGroundingClientPort(groundingWorkerSource);
        await clientPort.ready();
        groundingClient = new GrassGroundingWorkerClient(clientPort);
        const copyAt = performance.now();
        const admittedSources =
          createGrassGroundingWorkerRequest(request).surfaces;
        const captureMs = performance.now() - copyAt;
        const admissions: GrassGroundingClientSettled[] = [];
        for (const owner of admittedSources) {
          const jobId = groundingClient.submit({
            type: "prepare_surface",
            schemaVersion: 1,
            generation: 1,
            token: owner.token,
            snapshot: owner.snapshot,
            consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
          });
          await clientPort.waitFor("surface_prepared", jobId);
          const settled = groundingClient.takeSettled();
          if (
            settled?.status !== "response" ||
            settled.response.type !== "surface_prepared" ||
            settled.response.state.status !== "prepared"
          )
            throw new Error(
              "Pond client admission failed: " + JSON.stringify(settled),
            );
          admissions.push(settled);
        }
        const fitId = groundingClient.submit({
          type: "start_cached",
          schemaVersion: 1,
          generation: 1,
          ownSurfaceToken: region.surfaces.indexOf(ownSurface) + 1,
          surfaceTokens: admittedSources.map((owner) => owner.token),
          geometry: transferred.geometry,
          data: transferred.data,
          constraints: transferred.constraints,
          settings: transferred.settings,
          consumed: {
            operations: handoff.operations,
            activeMs: handoff.activeMs,
            maximumSliceMs: handoff.maximumSliceMs,
          },
        });
        const rawFit = await clientPort.waitFor("result", fitId);
        const settled = groundingClient.takeSettled();
        if ("native121" in scenario) {
          evidence(
            `${scenario.label}_HANDOFF_RAW_RESPONSE`,
            JSON.stringify({
              key,
              lod,
              jobId: rawFit.jobId,
              generation: rawFit.generation,
              state:
                rawFit.state.status === "ready"
                  ? { status: "ready" }
                  : rawFit.state,
              work: rawFit.work,
              timing: rawFit.timing ?? null,
              lastPhase: rawFit.lastPhase,
              inputBytes: rawFit.inputBytes,
              resultBytes: rawFit.resultBytes,
              settlementStatus: settled?.status ?? null,
            }),
          );
        }
        if (
          settled?.status !== "response" ||
          settled.response.type !== "result"
        )
          throw new Error(
            "Pond client fitting transport failed: " + JSON.stringify(settled),
          );
        const fit = settled.response;
        if ("native121" in scenario) expect(fit).toBe(rawFit);
        const transportMs = settled.dispatchCpuMs + settled.receiveCpuMs;
        evidence(
          `${scenario.label}_HANDOFF_WORKER`,
          JSON.stringify({
            key,
            lod,
            state: fit.state.status,
            work: fit.work,
            ...("native121" in scenario
              ? {
                  failure: fit.state.status === "ready" ? null : fit.state,
                  timing: fit.timing ?? null,
                  lastPhase: fit.lastPhase,
                  historicalSubmittedWork: scenario.native121.submittedWork,
                }
              : {}),
            preparation: {
              operations: handoff.operations,
              activeMs: handoff.activeMs,
              maximumSliceMs: handoff.maximumSliceMs,
            },
            dispatchCpuMs: settled.dispatchCpuMs,
            postMessageCpuMs: settled.postMessageCpuMs,
            receiveCpuMs: settled.receiveCpuMs,
            transportMs,
            captureMs,
            admissions,
            scope:
              "Real pond inputs through production projection/copy, client and actual isolated worker; all fitting work and measured main transport cost must survive publication without a new budget. Fixture terrain capture/admission remains separately measured, not a game-manager cache qualification.",
          }),
        );
        expect(fit.state.status).toBe("ready");
        if (fit.state.status !== "ready")
          throw new Error("Pond handoff fitting failed");
        expect(fit.work.activeMs + transportMs).toBeLessThan(250);
        const publication = new GrassGroundingContinuation(
          finishGroundedGrassWorkerSteps(fit.state.result, {
            ownSurface,
            surfaces: region.surfaces.map((surface, index) => ({
              token: index + 1,
              surface,
            })),
            grounding: transferred.grounding,
            lod,
            geometryLayout: request.geometryLayout,
            roadClearance: request.roadClearance,
          }),
          isCurrent,
          {
            operations: fit.work.operations,
            activeMs: fit.work.activeMs + transportMs,
            // Summed main callback cost is a conservative slice upper bound.
            maximumSliceMs: Math.max(fit.work.maximumSliceMs, transportMs),
          },
        );
        for (
          let i = 0;
          i < 10_000 && publication.state.status === "running";
          i++
        )
          publication.advance();
        evidence(
          `${scenario.label}_HANDOFF_PUBLICATION`,
          JSON.stringify({
            key,
            lod,
            state: publication.state.status,
            operations: publication.operations,
            activeMs: publication.activeMs,
            maximumSliceMs: publication.maximumSliceMs,
            ...("native121" in scenario
              ? {
                  failure:
                    publication.state.status === "ready"
                      ? null
                      : publication.state,
                  timing: publication.captureTiming(),
                  lastPhase: publication.lastPhase,
                }
              : {}),
            totalColdWallMs: performance.now() - handoffStarted,
            scope:
              "Full projection + fitting + main transport + numeric validation/provenance remap under the unchanged cumulative limits. One-time terrain capture and explicit admission are separately reported above. Node worker realm and real world inputs, not a native frame-rate claim.",
          }),
        );
        if (publication.state.status !== "ready")
          throw new Error(
            "Pond worker publication failed: " +
              JSON.stringify(publication.state),
          );
        publishedWorkerResult = publication.state.result;
        const { grounding: retainedEvidence, ...numerical } =
          publishedWorkerResult;
        expect(retainedEvidence).toBeDefined();
        expect(grassGroundingWorkerSemanticResult(numerical, request)).toEqual(
          grassGroundingWorkerSemanticResult(result, request),
        );
        groundingClient.destroy();
        groundingClient = undefined;
        await clientPort.close();
        clientPort = undefined;

        if (isMeadowField) {
          // Fresh actual coordinator: prepare/copy each retained owner once,
          // then repeat the whole unsliced cell through the warm owner cache.
          // Neither run resets the fitting ledger between handoff and publish.
          clientPort = new ActualGrassGroundingClientPort(
            groundingWorkerSource,
          );
          await clientPort.ready();
          coordinator = new GrassGroundingWorkerCoordinator(
            clientPort,
            (surface) => retainedVisual.isRetainedSurfaceCurrent(surface),
          );
          for (const cacheState of ["cold", "warm"] as const) {
            const coordinatorInputs = setup.prepareGroundingInputs!(bounds);
            const job = coordinator.createJob(
              { ...request, data: output },
              coordinatorInputs,
              (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
              (x, z) => terrain["isGrassExcludedAt"](x, z),
              () => region.isCurrent() && coordinatorInputs.isCurrent(),
            );
            for (
              let advance = 0;
              advance < 10_000 && job.state.status === "running";
              advance++
            ) {
              job.advance();
              const reservation = coordinator.receipt;
              expect(reservation.reservedOwners).toBeLessThanOrEqual(
                GRASS_GROUNDING_WORKER_LIMITS.maximumCachedSurfaces,
              );
              expect(reservation.reservedInputBytes).toBeLessThanOrEqual(
                GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes,
              );
              expect(reservation.reservedDerivedBytes).toBeLessThanOrEqual(
                GRASS_GROUNDING_WORKER_LIMITS.maximumDerivedBytes,
              );
              const remoteId = job.transportJobId;
              if (remoteId !== null) {
                // This bounded two-run fixture has no owner replacement or
                // eviction. Fail if it unexpectedly dispatches another kind.
                expect([
                  "worker_surface_dispatch",
                  "worker_fit_dispatch",
                ]).toContain(job.lastPhase);
                await clientPort.waitFor(
                  job.lastPhase === "worker_surface_dispatch"
                    ? "surface_prepared"
                    : "result",
                  remoteId,
                );
              }
            }
            evidence(
              `${scenario.label}_COORDINATOR_${cacheState.toUpperCase()}`,
              JSON.stringify({
                key,
                lod,
                state:
                  job.state.status === "ready"
                    ? { status: "ready" }
                    : job.state,
                operations: job.operations,
                activeMs: job.activeMs,
                maximumSliceMs: job.cumulativeMaximumSliceMs,
                lastPhase: job.lastPhase,
                coordinator: coordinator.receipt,
                output:
                  job.state.status === "ready"
                    ? groundedBufferReceipts(job.state.result)
                    : null,
                scope:
                  "Actual production coordinator with real retained surfaces, worker bundle, projection/handoff and publication. Cold per-owner admission is accounted separately; warm reuse does not remove any fitting charge. Full new-grid cell, unchanged caps, no native scheduling or rendering claim.",
              }),
            );
            expect(job.state.status).toBe("ready");
            if (job.state.status !== "ready")
              throw new Error(
                `Meadow field ${cacheState} coordinator ${job.state.status}`,
              );
            expect(job.operations).toBeLessThan(1_000_000);
            expect(job.activeMs).toBeLessThan(250);
            expect(job.state.result.receipt.processedClumps).toBe(
              projected.count,
            );
            const { grounding: coordinatedGrounding, ...coordinatedNumerical } =
              job.state.result;
            expect(
              grassGroundingWorkerSemanticResult(coordinatedNumerical, request),
            ).toEqual(grassGroundingWorkerSemanticResult(result, request));
            expect(coordinatedGrounding).toEqual(
              publishedWorkerResult.grounding,
            );
            expect(coordinator.receipt.preparedOwners).toBe(
              region.surfaces.length,
            );
            expect(coordinator.receipt.cacheOwners).toBe(
              region.surfaces.length,
            );
            expect(coordinator.receipt.lastAdmissionFailure).toBeNull();
            expect(coordinator.receipt.lastFittingFailure).toBeUndefined();
            if (cacheState === "warm")
              expect(coordinator.receipt.cacheHits).toBeGreaterThanOrEqual(
                region.surfaces.length,
              );
            for (const [index, [key]] of attributes.entries())
              expect(projected[key]).toEqual(inputBefore[index]);
          }
          coordinator.destroy();
          coordinator = undefined;
          await clientPort.close();
          clientPort = undefined;
        }

        // The frozen legacy reference does not admit this new layout or its
        // height-flex response. Never relabel its geometry to make it pass.
        // New-grid correctness is checked above/below on the actual full cell;
        // independent shape/flex/clearance unit tests remain a separate gate.
        if (!isMeadowField) {
          // The frozen reference predates pond-service wear and folded faces.
          // Preserve its exact oracle comparison against a separately capped
          // numerical control, never against current faces it cannot represent.
          // Remove service wear and, when needed, select the historical shape.
          // The generated placement/colors, projected roots, roads, terrain and town
          // verge are identical. Folded near requests use the historical ribbon
          // geometry above ONLY for this independent oracle control. All current
          // folded-face worker/handoff/publication checks keep their full caps.
          let oracleRequest = request;
          let oracleResult = result;
          if (pondServiceGround || usesNativeComposition) {
            oracleRequest = { ...historicalShapeRequest };
            delete oracleRequest.pondServiceGround;
            expect(request.pondServiceGround).toBe(pondServiceGround);
            expect(oracleRequest.data).toBe(request.data);
            expect(oracleRequest.surfaces).toBe(request.surfaces);
            expect(oracleRequest.roadSegments).toBe(request.roadSegments);
            expect(oracleRequest.bankVerge).toBe(request.bankVerge);
            const controlStarted = performance.now();
            const control = new GrassGroundingContinuation(
              groundGrassBladeSteps(oracleRequest),
              isCurrent,
            );
            while (control.state.status === "running") control.advance();
            evidence(
              `${scenario.label}_NO_SERVICE_WEAR_CONTROL`,
              JSON.stringify({
                key,
                lod,
                status: control.state.status,
                geometryLayout: oracleRequest.geometryLayout,
                currentGeometryLayout: request.geometryLayout,
                historicalRibbonControl: usesNativeComposition,
                reason:
                  control.state.status === "failed_budget"
                    ? control.state.reason
                    : null,
                operations: control.operations,
                activeMs: control.activeMs,
                maximumSliceMs: control.maximumSliceMs,
                wallMs: performance.now() - controlStarted,
                lastPhase: control.lastPhase,
                scope:
                  "Historical-ribbon/no-service-wear numerical control under unchanged operation/active-time caps. Fine leaf-volume near uses the original seven-vertex geometry; other tiers retain their exact geometry bytes. This frozen-oracle control does not qualify current folded faces. Current geometry remains independently subject to all worker/handoff/full-pipeline assertions.",
              }),
            );
            expect(control.state.status).toBe("ready");
            if (control.state.status !== "ready")
              throw new Error(
                "No-service-wear control " + control.state.status,
              );
            oracleResult = control.state.result;
            expect(oracleResult.receipt.workBudget).toBe(1_000_000);
            expect(oracleResult.receipt.workUnits).toBeLessThanOrEqual(
              1_000_000,
            );

            const masks = (grounded: typeof result) =>
              new Map(
                Array.from(
                  grounded.sourceIndices,
                  (source, index) =>
                    [source, grounded.bladeVisibility![index]] as const,
                ),
              );
            const currentMasks = masks(result);
            const controlMasks = masks(oracleResult);
            const maskExamples: Array<{
              sourceIndex: number;
              current: number;
              control: number;
            }> = [];
            let changedMasks = 0;
            let addedRetainedClumps = 0;
            let removedRetainedClumps = 0;
            for (
              let sourceIndex = 0;
              sourceIndex < projected.count;
              sourceIndex++
            ) {
              const current = currentMasks.get(sourceIndex) ?? 0;
              const previous = controlMasks.get(sourceIndex) ?? 0;
              if (
                currentMasks.has(sourceIndex) &&
                !controlMasks.has(sourceIndex)
              )
                addedRetainedClumps++;
              if (
                !currentMasks.has(sourceIndex) &&
                controlMasks.has(sourceIndex)
              )
                removedRetainedClumps++;
              if (current === previous) continue;
              changedMasks++;
              if (maskExamples.length < 16)
                maskExamples.push({
                  sourceIndex,
                  current,
                  control: previous,
                });
            }
            const currentBuffers = groundedBufferReceipts(result);
            const controlBuffers = groundedBufferReceipts(oracleResult);
            evidence(
              `${scenario.label}_SERVICE_WEAR_COMPARISON`,
              JSON.stringify({
                key,
                lod,
                current: currentBuffers,
                noServiceWearHistoricalRibbonControl: controlBuffers,
                changedMasks,
                addedRetainedClumps,
                removedRetainedClumps,
                maskExamples,
                scope:
                  "Source-index-aligned current/control hashes and masks: changes can include both physical folded geometry and service wear. The frozen oracle qualifies only the historical-ribbon/no-service-wear control. New folded-face and current-wear correctness require separate independently derived geometry/wind/road-clearance tests, not worker/pipeline agreement alone.",
              }),
            );
            if ("native72" in scenario) {
              // This exact southwest cell overlaps the admitted apron. Keep the
              // previously exposed difference observable; other cells need not
              // change, and no numerical delta/count is invented as a golden.
              expect(changedMasks).toBeGreaterThan(0);
              expect(currentBuffers.bladeVisibility.sha256).not.toBe(
                controlBuffers.bladeVisibility.sha256,
              );
            }
          }

          // One-clump frozen-reference evaluations provide ONLY the independent
          // numerical oracle for oracleResult. They never divide/reset the cap
          // of the full-cell control or current worker/pipeline installations.
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
            const legacy = legacyGroundGrassBlades({
              ...oracleRequest,
              data: one,
            });
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
            expectedPartialClumps +=
              legacy.receipt.roadClearance!.partialClumps;
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
            expect(oracleResult.data[key]).toEqual(
              new Float32Array(expectedData[key]),
            );
          }
          expect(oracleResult.sourceIndices).toEqual(
            new Uint32Array(expectedIndices),
          );
          expect(oracleResult.rootDeltas).toEqual(
            new Float32Array(expectedDeltas),
          );
          expect(oracleResult.bladeVisibility).toEqual(
            new Uint32Array(expectedVisibility),
          );
          expect(oracleResult.sweptBounds).toEqual(expectedBounds);
          expect(oracleResult.receipt.processedClumps).toBe(projected.count);
          expect(oracleResult.receipt.retainedClumps).toBe(
            expectedIndices.length,
          );
          expect(oracleResult.receipt.endpointQueries).toBe(
            expectedEndpointQueries,
          );
          expect(oracleResult.receipt.maxEndpointCorrection).toBe(
            expectedMaxEndpointCorrection,
          );
          expect(oracleResult.receipt.maxCorrectedBaseError).toBe(
            expectedMaxCorrectedBaseError,
          );
          expect(oracleResult.receipt.maxAcceptedBaseError).toBe(
            expectedMaxAcceptedBaseError,
          );
          expect(oracleResult.receipt.rejected).toEqual(expectedRejections);
          expect(oracleResult.receipt.roadClearance).toEqual({
            mode: "per-blade-v1",
            retainedBlades: expectedRetainedBlades,
            partialClumps: expectedPartialClumps,
            maskedRetainedBlades: expectedMaskedBlades,
            visibilityBytes:
              expectedVisibility.length * Uint32Array.BYTES_PER_ELEMENT,
          });
          expect(oracleResult.dependencies).toEqual(
            [...expectedDependencies].map(([surface, uses]) => ({
              surface,
              uses: [...uses],
            })),
          );
        }

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
              "Actual CPU full-cell continuation. Active time is cumulative slice elapsed time, not native browser qualification; failed jobs do not expose a processed-clump fraction. coreResultOutputHash refers to the earlier untimed core drain; completedPipelineOutputHash is null unless the timed pipeline is ready.",
            coreResultOutputHash: createHash("sha256")
              .update(Buffer.from(result.sourceIndices.buffer))
              .update(Buffer.from(result.rootDeltas.buffer))
              .update(Buffer.from(result.bladeVisibility!.buffer))
              .update(JSON.stringify(result.sweptBounds))
              .digest("hex"),
            completedPipelineOutputHash:
              pipeline.state.status === "ready"
                ? createHash("sha256")
                    .update(
                      Buffer.from(pipeline.state.result.sourceIndices.buffer),
                    )
                    .update(
                      Buffer.from(pipeline.state.result.rootDeltas.buffer),
                    )
                    .update(
                      Buffer.from(
                        pipeline.state.result.bladeVisibility!.buffer,
                      ),
                    )
                    .update(JSON.stringify(pipeline.state.result.sweptBounds))
                    .digest("hex")
                : null,
          }),
        );
        expect(pipeline.state.status).toBe("ready");
        if (pipeline.state.status !== "ready")
          throw new Error(pipeline.state.status);
        if ("nativeSheath" in scenario) {
          expect(pipeline.operations).toBeLessThan(1_000_000);
          expect(pipeline.activeMs).toBeLessThan(250);
          expect(pipeline.state.result.receipt.processedClumps).toBe(
            projected.count,
          );
          expect(pipeline.state.result.receipt.geometryLayout).toBe(
            "fine-folded-sheath-near5-v1",
          );
        }
        if (isMeadowField) {
          expect(pipeline.operations).toBeLessThan(1_000_000);
          expect(pipeline.activeMs).toBeLessThan(250);
          expect(pipeline.state.result.receipt.processedClumps).toBe(
            projected.count,
          );
          expect(pipeline.state.result.receipt.geometryLayout).toBe(
            "fine-meadow-ribbon-v1",
          );
        }
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
        expect(publishedWorkerResult?.grounding).toEqual(
          pipeline.state.result.grounding,
        );
        const grounding = pipeline.state.result.grounding;
        if (!grounding) throw new Error("Missing full-pipeline provenance");
        expect(grounding.computedHeights.buffer).not.toBe(
          projected.grounding.computedHeights.buffer,
        );
        expect(grounding.ecologicalNormals.buffer).not.toBe(
          projected.grounding.ecologicalNormals.buffer,
        );
        evidence(
          `${scenario.label}_BUFFER_HASHES`,
          JSON.stringify({
            key,
            lod,
            focus: scenario.focus,
            rawWorker: attributeReceipts(output),
            projectedWorker: attributeReceipts(projected),
            fullPipeline: {
              ...attributeReceipts(pipeline.state.result.data),
              sourceIndices: bufferReceipt(pipeline.state.result.sourceIndices),
              rootDeltas: bufferReceipt(pipeline.state.result.rootDeltas),
              bladeVisibility: bufferReceipt(
                pipeline.state.result.bladeVisibility!,
              ),
              sweptBounds: pipeline.state.result.sweptBounds,
              provenance: {
                schemaVersion: grounding.schemaVersion,
                surfaceRevision: grounding.surfaceRevision,
                computedHeights: bufferReceipt(grounding.computedHeights),
                ecologicalNormals: bufferReceipt(grounding.ecologicalNormals),
              },
            },
            scope: isMeadowField
              ? "Exact current-source CPU array-view hashes after unsliced core, actual cached-worker, cold/warm coordinator, handoff/publication and full-pipeline agreement. Source indices refer only to this fresh half-metre grid; no historical placement/mask equality or legacy-layout oracle claim. No native buffer or GPU claim."
              : "Exact current-source CPU array-view hashes after full worker/pipeline assertions and a separately identified historical-ribbon oracle control. Source indices refer to projected worker rows. A geometry trial may change clearance masks/retained rows and swept bounds, not the source placement population. No native buffer or GPU claim.",
          }),
        );
        if (usesNativeComposition) {
          const base = manager["material"];
          const near = manager["materialForLod"](0);
          const selected = manager["materialForLod"](lod);
          let baseDisposals = 0,
            nearDisposals = 0,
            chunkDisposals = 0;
          base.addEventListener("dispose", () => baseDisposals++);
          near.addEventListener("dispose", () => nearDisposals++);
          expect(near).not.toBe(base);
          expect(selected).toBe(isMeadowField || lod === 0 ? near : base);
          expect(pipeline.state.result.data.count).toBeGreaterThan(0);
          manager["createChunkMeshFromWorkerData"](
            work,
            { ...output, ...pipeline.state.result.data },
            lod,
            grounding,
            pipeline.state.result,
          );
          const mesh = manager["chunks"].get(key)?.mesh;
          if (!mesh || !(mesh.material instanceof MeshSSSNodeMaterial))
            throw new Error(
              "Expected actual folded-profile SSS chunk publication",
            );
          expect(mesh.count).toBe(pipeline.state.result.data.count);
          expect(mesh.material).not.toBe(selected);
          expect(mesh.material.normalNode).toBe(selected.normalNode);
          expect(mesh.material.colorNode).toBe(base.colorNode);
          expect(mesh.material.aoNode).toBe(base.aoNode);
          expect(mesh.material.userData.grassBladeLayout).toEqual(actualLayout);
          if (isMeadowField) {
            expect(mesh.material.userData.fineGrassCanopyLighting).toBe(
              selected.userData.fineGrassCanopyLighting,
            );
            expect(mesh.material.userData.fineGrassCanopyLighting).toEqual({
              ...FINE_GRASS_LEAF_VOLUME_LIGHTING,
              foldTangent: Math.tan((18 * Math.PI) / 180),
              normalSource: "geometry-ribbon-relief",
              geometryLayout: "fine-meadow-ribbon-v1",
            });
            expect(
              Object.isFrozen(mesh.material.userData.fineGrassCanopyLighting),
            ).toBe(true);
          } else if ("nativeSheath" in scenario) {
            expect(mesh.material.userData.fineGrassCanopyLighting).toBe(
              selected.userData.fineGrassCanopyLighting,
            );
            expect(mesh.material.userData.fineGrassCanopyLighting).toEqual({
              ...FINE_GRASS_FOLDED_BLADE_LIGHTING,
              geometryLayout: "fine-folded-sheath-near5-v1",
            });
            expect(
              Object.isFrozen(mesh.material.userData.fineGrassCanopyLighting),
            ).toBe(true);
          } else
            expect(mesh.material.userData.fineGrassCanopyLighting).toBe(
              lod === 0
                ? FINE_GRASS_FOLDED_BLADE_LIGHTING
                : FINE_GRASS_LEAF_VOLUME_LIGHTING,
            );
          expect(
            Object.getOwnPropertyDescriptor(
              mesh.material.userData,
              "fineGrassCanopyLighting",
            ),
          ).toMatchObject({ writable: false, configurable: false });
          expect(mesh.geometry.getAttribute("position").array).toEqual(
            request.geometry.getAttribute("position").array,
          );
          expect(mesh.geometry.getAttribute("grassRootDeltas").array).toEqual(
            pipeline.state.result.rootDeltas,
          );
          mesh.material.addEventListener("dispose", () => chunkDisposals++);
          manager["retireGrassChunk"](key);
          expect(manager["chunks"].has(key)).toBe(false);
          expect([baseDisposals, nearDisposals, chunkDisposals]).toEqual([
            0, 0, 1,
          ]);
          manager.destroy();
          expect([baseDisposals, nearDisposals, chunkDisposals]).toEqual([
            1, 1, 1,
          ]);
          manager.destroy();
          expect([baseDisposals, nearDisposals, chunkDisposals]).toEqual([
            1, 1, 1,
          ]);
        }
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
        try {
          await groundingWorker?.close();
        } catch (error) {
          failures.push(error);
        }
        release(() => groundingClient?.destroy());
        release(() => coordinator?.destroy());
        try {
          await clientPort?.close();
        } catch (error) {
          failures.push(error);
        }
        release(() => manager?.destroy());
        release(() => historicalRibbonGeometry?.dispose());
        release(() => visual?.dispose());
        release(() => material.dispose());
        // Release native dock actors/exclusions before terrain or physics dies.
        release(() => serviceCourts?.destroy());
        release(() => docks?.destroy());
        release(() => world.destroy());
        if (
          isMeadowField ||
          "native121" in scenario ||
          "nativeSheath" in scenario
        )
          release(() => {
            const pinsBefore = [
              ...reconstructionSources,
              ...reconstructionAssets,
            ];
            const pinsAfter = pinsBefore.map(({ path }) => {
              const bytes = readFileSync(path);
              return { path, bytes: bytes.length, sha256: hashBytes(bytes) };
            });
            const sourcesUnchanged = pinsBefore.every(
              (pin, i) =>
                pin.bytes === pinsAfter[i].bytes &&
                pin.sha256 === pinsAfter[i].sha256,
            );
            evidence(
              `${scenario.label}_SOURCE_INPUT_POSTFLIGHT`,
              JSON.stringify({
                sourcePinsAfter: pinsAfter,
                sourcesUnchanged,
                failures: failures.map((error) =>
                  error instanceof Error
                    ? `${error.name}: ${error.message}`
                    : String(error),
                ),
                scope:
                  "Recorded after owned cleanup even when any unchanged fitting/publication budget or assertion failed. No failed observation is retried or relabeled as a passing native replay.",
              }),
            );
            expect(sourcesUnchanged).toBe(true);
          });
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
