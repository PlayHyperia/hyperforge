/**
 * Actual production six-leaf grass worker, with Node message transport only.
 * Run from repository root: bun scripts/check-compact-grass-material.ts
 *   baseline /absolute/external/before.json
 *   compare /absolute/external/before.json /absolute/external/after.json
 * Exclusive JSON outputs contain exact typed-array VIEW hashes, not GPU proof.
 * The same current 11-road input is generated in both processes; no old scene,
 * mask, seed, factory, terrain sampler or eligibility is substituted.
 * Bun loads production TS/__dirname, while a real Node22 Worker computes arrays.
 * COMPACT_GRASS_NODE22 may specify the Node22 binary on other machines.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import THREE from "../packages/shared/src/extras/three/three";
import { World } from "../packages/shared/src/core/World";
import { DataManager } from "../packages/shared/src/data/DataManager";
import { TerrainSystem } from "../packages/shared/src/systems/shared/world/TerrainSystem";
import { RoadNetworkSystem } from "../packages/shared/src/systems/shared/world/RoadNetworkSystem";
import { TerrainQuadTree } from "../packages/shared/src/systems/shared/world/TerrainQuadTree";
import {
  GrassVisualManager,
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
} from "../packages/shared/src/systems/shared/world/GrassVisualManager";
import {
  GRASS_WORKER_CODE,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../packages/shared/src/utils/workers/GrassWorker";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = "packages/shared/src/";
const world = `${shared}systems/shared/world/`;
const palettePath = `${world}CompactTerrainPalette.ts`;
const pinPaths = [
  "scripts/check-compact-grass-material.ts",
  "scripts/check-compact-grass-material.test.ts",
  "package.json",
  "packages/shared/package.json",
  "node_modules/three/package.json",
  "node_modules/tsx/package.json",
  `${shared}core/World.ts`,
  `${shared}data/DataManager.ts`,
  `${shared}data/arena-grading.ts`,
  `${shared}data/duel-manifest.ts`,
  `${shared}runtime/clientViewportMode.ts`,
  ...[
    "TerrainSystem",
    "RoadNetworkSystem",
    "TerrainQuadTree",
    "GrassVisualManager",
    "TerrainHeightParams",
    "TerrainBiomeTypes",
    "WorldTerrainProfile",
    "CompactIslandLandform",
    "CompactIslandPaths",
    "CompactIslandDetail",
    "CompactResourceGroves",
    "AuthoredTerrainSurface",
    "RoadInfluence",
  ].map((name) => `${world}${name}.ts`),
  ...["GrassWorker", "TerrainWorkerShared", "GrassTerrainSurfaceSnapshot"].map(
    (name) => `${shared}utils/workers/${name}.ts`,
  ),
  palettePath,
  ...[
    "world-config",
    "world-areas",
    "biomes",
    "duel-arenas",
    "npcs",
    "buildings",
  ].map((name) => `packages/server/world/assets/manifests/${name}.json`),
];
export const NON_COLOR_KEYS = [
  "offsets",
  "rotScaleHash",
  "grassTints",
  "groundNormals",
] as const;
const ARRAY_KEYS = [...NON_COLOR_KEYS, "groundColors"] as const;
const LEAVES = [
  [450, 350],
  [250, 350],
  [350, 350],
  [350, 450],
  [450, 450],
  [350, 250],
] as const;
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
type Pin = { path: string; bytes: number; sha256: string };
type ArrayReceipt = {
  type: "Float32Array";
  length: number;
  bytes: number;
  sha256: string;
};
/** Tagged values preserve Sets/typed views/undefined/-0 across Bun→Node JSON IPC. */
export function encodeMaterialWorkerInput(value: unknown): unknown {
  let visited = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown): unknown => {
    assert(++visited <= 100000, "Input value count bound");
    if (item === null) return ["null"];
    if (item === undefined) return ["undefined"];
    if (typeof item === "number") {
      assert(Number.isFinite(item), "Non-finite input number");
      return ["number", Object.is(item, -0) ? "-0" : item];
    }
    if (typeof item === "string" || typeof item === "boolean")
      return [typeof item, item];
    assert(
      typeof item === "object" && !ancestors.has(item),
      "Unsupported or cyclic input",
    );
    ancestors.add(item);
    try {
      if (item instanceof Set) return ["Set", [...item].map(visit)];
      if (item instanceof Map)
        return ["Map", [...item].map(([k, v]) => [visit(k), visit(v)])];
      if (ArrayBuffer.isView(item)) {
        assert(
          [
            "Uint8Array",
            "Uint8ClampedArray",
            "Int8Array",
            "Uint16Array",
            "Int16Array",
            "Uint32Array",
            "Int32Array",
            "Float32Array",
            "Float64Array",
          ].includes(item.constructor.name),
          "Unsupported input view",
        );
        return [
          "view",
          item.constructor.name,
          Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString(
            "base64",
          ),
        ];
      }
      if (item instanceof ArrayBuffer)
        return ["buffer", Buffer.from(item).toString("base64")];
      if (Array.isArray(item)) {
        assert.equal(
          Object.keys(item).length,
          item.length,
          "Sparse/extended input array",
        );
        return ["array", item.map(visit)];
      }
      assert(
        Object.getPrototypeOf(item) === Object.prototype ||
          Object.getPrototypeOf(item) === null,
        "Non-wire input object",
      );
      return ["object", Object.entries(item).map(([k, v]) => [k, visit(v)])];
    } finally {
      ancestors.delete(item);
    }
  };
  const encoded = visit(value);
  assert(
    Buffer.byteLength(JSON.stringify(encoded)) <= 2 * 1024 * 1024,
    "Encoded input byte bound",
  );
  return encoded;
}
/** Self-contained native IPC decoder; it performs no terrain/value substitution. */
export function decodeMaterialWorkerInput(encoded: unknown): unknown {
  const value = encoded as [string, unknown, unknown];
  const entries = value[1] as unknown[];
  switch (value[0]) {
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "number":
      return value[1] === "-0" ? -0 : value[1];
    case "string":
    case "boolean":
      return value[1];
    case "array":
      return entries.map(decodeMaterialWorkerInput);
    case "Set":
      return new Set(entries.map(decodeMaterialWorkerInput));
    case "Map":
      return new Map(
        (entries as unknown[][]).map(([k, v]) => [
          decodeMaterialWorkerInput(k),
          decodeMaterialWorkerInput(v),
        ]),
      );
    case "object":
      return Object.fromEntries(
        (entries as unknown[][]).map(([k, v]) => [
          k,
          decodeMaterialWorkerInput(v),
        ]),
      );
    case "buffer":
      return Uint8Array.from(Buffer.from(value[1] as string, "base64")).buffer;
    case "view": {
      const constructors = {
        Uint8Array,
        Uint8ClampedArray,
        Int8Array,
        Uint16Array,
        Int16Array,
        Uint32Array,
        Int32Array,
        Float32Array,
        Float64Array,
      };
      const Constructor = constructors[value[1] as keyof typeof constructors];
      if (!Constructor) throw Error("Unknown input typed view");
      return new Constructor(
        Uint8Array.from(Buffer.from(value[2] as string, "base64")).buffer,
      );
    }
    default:
      throw Error("Unknown input transport tag");
  }
}
type LeafReceipt = {
  center: number[];
  inputSha256: string;
  inputBytes: number;
  chunkKey: string;
  count: number;
  grassEligibility: string | undefined;
  terrainProfileIdentity: string;
  arrays: Record<(typeof ARRAY_KEYS)[number], ArrayReceipt>;
};
export type MaterialWorkerSnapshot = {
  schemaVersion: 1;
  scope: string;
  createdAt: string;
  runtime: {
    node: string;
    three: string;
    bun: string;
    architecture: string;
    byteOrder: string;
  };
  sourcePins: Pin[];
  workerCodeSha256: string;
  workerCodeBytes: number;
  scene: {
    worldContentIdentity: unknown;
    profile: unknown;
    grassProfile: unknown;
    roads: number;
    roadSegments: number;
    focus: number[];
  };
  leaves: LeafReceipt[];
  totalClumps: number;
};

async function sourcePins(): Promise<Pin[]> {
  return Promise.all(
    pinPaths.map(async (name) => {
      const bytes = await readFile(path.join(repo, name));
      assert(bytes.length <= 4 * 1024 * 1024, `Source pin bound: ${name}`);
      return { path: name, bytes: bytes.length, sha256: hash(bytes) };
    }),
  );
}
function arrayReceipt(
  array: Float32Array,
  count: number,
  width: number,
): ArrayReceipt {
  assert(
    array instanceof Float32Array,
    "Actual worker must return Float32Array",
  );
  assert.equal(array.length, count * width, "Exact populated view length");
  assert(array.every(Number.isFinite), "Non-finite actual worker value");
  const bytes = new Uint8Array(
    array.buffer,
    array.byteOffset,
    array.byteLength,
  );
  return {
    type: "Float32Array",
    length: array.length,
    bytes: bytes.byteLength,
    sha256: hash(bytes),
  };
}
function workerSession() {
  // JSON IPC is portable between Bun and Node. Only transport serializes the
  // exact populated byte views; production generation still runs in Node Worker.
  const driver = `
    const {Worker}=require('node:worker_threads');
    const decodeMaterialWorkerInput=${decodeMaterialWorkerInput.toString()};
    process.once('message', code => {
      if(process.versions.node.split('.')[0]!=='22') throw Error('Node22 required');
      const worker=new Worker(code,{eval:true,env:{},execArgv:[]});
      worker.on('error',e=>process.send({error:e.stack||e.message}));
      worker.on('message',message=>{
        if(message.result){
          for(const key of ['offsets','rotScaleHash','grassTints','groundNormals','groundColors']){
            const a=message.result[key];
            if(!(a instanceof Float32Array)) throw Error('Non-Float32 native output');
            message.result[key]={type:'Float32Array',length:a.length,
              base64:Buffer.from(a.buffer,a.byteOffset,a.byteLength).toString('base64')};
          }
        }
        process.send(message);
      });
      process.on('message', input=>{
        if(input===null) worker.terminate().then(()=>process.exit(0));
        else worker.postMessage(decodeMaterialWorkerInput(input));
      });
      process.send({ready:true,node:process.versions.node});
    });`;
  const worker = spawn(
    process.env.COMPACT_GRASS_NODE22 ?? "/opt/homebrew/opt/node@22/bin/node",
    ["--input-type=commonjs", "-e", driver],
    {
      env: {},
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    },
  );
  let stderr = "";
  worker.stderr!.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8192);
  });
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Node worker startup deadline")),
      10_000,
    );
    const onExit = () =>
      finish(new Error(`Node worker startup failed: ${stderr}`));
    const onMessage = (message: { ready?: boolean; node?: string }) => {
      if (message.ready && message.node?.startsWith("22.")) {
        finish();
        resolve(message.node);
      } else finish(new Error("Invalid Node worker ready receipt"));
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      worker.off("exit", onExit);
      worker.off("error", finish);
      worker.off("message", onMessage);
      if (error) reject(error);
    }
    worker.once("exit", onExit);
    worker.once("error", finish);
    worker.once("message", onMessage);
  });
  worker.send(
    `const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};${GRASS_WORKER_CODE}\nparentPort.on('message',data=>self.onmessage({data}));`,
  );
  return {
    ready,
    async run(input: GrassWorkerInput): Promise<GrassWorkerOutput> {
      await ready;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Actual worker deadline (10s)")),
          10_000,
        );
        const onExit = (code: number) =>
          finish(new Error(`Actual worker exited before result: ${code}`));
        const onMessage = (message: {
          error?: string;
          result?: GrassWorkerOutput;
        }) => {
          if (message.error) finish(new Error(message.error));
          else if (message.result) {
            try {
              for (const key of ARRAY_KEYS) {
                const encoded = message.result[key] as unknown as {
                  type: string;
                  length: number;
                  base64: string;
                };
                assert.equal(encoded.type, "Float32Array");
                assert(
                  Number.isInteger(encoded.length) &&
                    encoded.length >= 0 &&
                    encoded.length <= 16384,
                );
                assert(
                  typeof encoded.base64 === "string" &&
                    encoded.base64.length <= 100000,
                );
                const bytes = Uint8Array.from(
                  Buffer.from(encoded.base64, "base64"),
                );
                assert.equal(bytes.length, encoded.length * 4);
                message.result[key] = new Float32Array(bytes.buffer);
              }
              finish();
              resolve(message.result);
            } catch (error) {
              finish(error as Error);
            }
          } else finish(new Error("Malformed actual worker message"));
        };
        function finish(error?: Error) {
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", finish);
          worker.off("exit", onExit);
          if (error) reject(error);
        }
        worker.once("message", onMessage);
        worker.once("error", finish);
        worker.once("exit", onExit);
        worker.send(encodeMaterialWorkerInput(input));
      });
    },
    close: async () => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.kill("SIGKILL");
        }, 2000);
        const deadline = setTimeout(() => {
          worker.off("exit", onExit);
          reject(new Error("Owned Node worker failed to exit"));
        }, 4000);
        const onExit = () => {
          clearTimeout(timer);
          clearTimeout(deadline);
          resolve();
        };
        worker.once("exit", onExit);
        if (worker.connected) worker.send(null);
        else worker.kill("SIGTERM");
      });
    },
  };
}

export async function captureMaterialWorkerSnapshot(): Promise<MaterialWorkerSnapshot> {
  assert.equal(
    process.versions.bun,
    "1.3.14",
    "Use pinned Bun1.3.14 for production TS loading",
  );
  assert.equal(
    process.env.ASSETS_DIR,
    undefined,
    "Do not override the canonical local manifest source",
  );
  assert.equal(
    await realpath(process.cwd()),
    await realpath(repo),
    "Run from repository root",
  );
  const pins = await sourcePins();
  await DataManager.getInstance().initialize();
  const cpuWorld = new World();
  const terrain = cpuWorld.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = cpuWorld.register(
    "roads",
    RoadNetworkSystem,
  ) as RoadNetworkSystem;
  const tree = new TerrainQuadTree({
    minSize: 100,
    maxDepth: 4,
    resolution: 16,
  });
  let owner: GrassVisualManager | undefined;
  let session: ReturnType<typeof workerSession> | undefined;
  try {
    await terrain.init();
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
    await roads.init();
    await roads.start();
    assert.equal(roads.getRoads().length, 11, "Fixed admitted forecourt scene");
    assert.equal(
      roads.getRoadSegmentsForGPU().length,
      222,
      "Fixed actual road segment census",
    );
    const setup = terrain["buildGrassWorkerSetup"]();
    owner = new GrassVisualManager(
      setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
      new THREE.Group(),
      // createWorkerInput does not consume retained geometry or dispatch a job.
      // This study stops at actual worker arrays; it does not install blade meshes.
      () => null,
      terrain.getResourceGroundHeight.bind(terrain),
      setup.terrainConfig.WATER_THRESHOLD,
      (x, z) => roads.getRoadInfluenceAt(x, z),
      (x, z) => terrain.isGrassExcludedAt(x, z),
      (x, z, eligibility) => terrain.getTerrainColorAt(x, z, true, eligibility),
      setup,
      COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
      undefined,
      (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
    );
    owner.setPlayerPosition(385, 374);
    session = workerSession();
    const leaves: LeafReceipt[] = [];
    for (const [x, z] of LEAVES) {
      const node = tree.createNode(null, null, 100, x, z, 4);
      const input = owner["createWorkerInput"](node, `clearing_${x}_${z}`, 1);
      const encodedInput = encodeMaterialWorkerInput(input);
      assert.deepEqual(
        decodeMaterialWorkerInput(encodedInput),
        input,
        "Exact typed input round trip",
      );
      const inputText = JSON.stringify(encodedInput);
      assert(
        inputText.length < 2 * 1024 * 1024,
        "Bounded exact production input",
      );
      const output = await session.run(input);
      assert.equal(output.type, "grassInstanceResult");
      assert.equal(output.chunkKey, input.chunkKey);
      assert.equal(output.grassEligibility, "compact-pbr-v1");
      assert.equal(
        output.terrainProfileIdentity,
        input.config.TERRAIN_PROFILE_IDENTITY,
      );
      assert(
        Number.isInteger(output.count) &&
          output.count > 0 &&
          output.count <= 4096,
      );
      const arrays = Object.fromEntries(
        ARRAY_KEYS.map((key) => [
          key,
          arrayReceipt(output[key], output.count, key === "grassTints" ? 4 : 3),
        ]),
      ) as LeafReceipt["arrays"];
      leaves.push({
        center: [x, z],
        inputSha256: hash(inputText),
        inputBytes: Buffer.byteLength(inputText),
        chunkKey: output.chunkKey,
        count: output.count,
        grassEligibility: output.grassEligibility,
        terrainProfileIdentity: output.terrainProfileIdentity,
        arrays,
      });
    }
    assert.deepEqual(
      leaves.map((leaf) => leaf.count),
      [271, 503, 139, 532, 493, 343],
      "Current forecourt CPU fixture, not all native resident grass",
    );
    assert.deepEqual(
      await sourcePins(),
      pins,
      "Sources changed during CPU capture",
    );
    const packageVersion = async (name: string) =>
      JSON.parse(
        await readFile(
          path.join(repo, `node_modules/${name}/package.json`),
          "utf8",
        ),
      ).version as string;
    return {
      schemaVersion: 1,
      scope:
        "Six exact current production CPU worker inputs; geometry/variation hashes, not installed GPU buffers, rendering, residency, color art approval or performance.",
      createdAt: new Date().toISOString(),
      runtime: {
        node: await session.ready,
        three: await packageVersion("three"),
        bun: process.versions.bun!,
        architecture: process.arch,
        byteOrder:
          new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
            ? "little"
            : "big",
      },
      sourcePins: pins,
      workerCodeSha256: hash(GRASS_WORKER_CODE),
      workerCodeBytes: Buffer.byteLength(GRASS_WORKER_CODE),
      scene: {
        worldContentIdentity: DataManager.getWorldContentIdentity(),
        profile: DataManager.getWorldTerrainProfile(),
        grassProfile: COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
        roads: roads.getRoads().length,
        roadSegments: roads.getRoadSegmentsForGPU().length,
        focus: [385, 374],
      },
      leaves,
      totalClumps: leaves.reduce((total, leaf) => total + leaf.count, 0),
    };
  } finally {
    try {
      await session?.close();
    } finally {
      try {
        owner?.destroy();
      } finally {
        try {
          tree.dispose();
        } finally {
          cpuWorld.destroy();
        }
      }
    }
  }
}

export function compareMaterialWorkerSnapshots(
  before: MaterialWorkerSnapshot,
  after: MaterialWorkerSnapshot,
) {
  const failures: string[] = [];
  const equal = (label: string, a: unknown, b: unknown) => {
    if (jsonHash(a) !== jsonHash(b)) failures.push(label);
  };
  equal("schema", before.schemaVersion, 1);
  equal("schema after", after.schemaVersion, 1);
  equal("runtime", before.runtime, after.runtime);
  equal("scene/profile/input configuration", before.scene, after.scene);
  equal(
    "source path set",
    before.sourcePins.map((p) => p.path),
    after.sourcePins.map((p) => p.path),
  );
  equal(
    "invariant source pins (only palette may change)",
    before.sourcePins.filter((p) => p.path !== palettePath),
    after.sourcePins.filter((p) => p.path !== palettePath),
  );
  equal("six-leaf census", before.leaves.length, 6);
  equal("six-leaf census after", after.leaves.length, 6);
  equal("total clumps", before.totalClumps, after.totalClumps);
  let changedColorLeaves = 0;
  let unchangedNonColorArrayViews = 0;
  for (let i = 0; i < before.leaves.length; i++) {
    const old = before.leaves[i],
      current = after.leaves[i];
    if (!current) {
      failures.push(`missing leaf ${i}`);
      continue;
    }
    const { arrays: oldArrays, ...oldIdentity } = old;
    const { arrays: newArrays, ...newIdentity } = current;
    equal(`leaf ${i} exact input/identity/count`, oldIdentity, newIdentity);
    for (const key of NON_COLOR_KEYS) {
      equal(`leaf ${i} ${key}`, oldArrays[key], newArrays[key]);
      if (jsonHash(oldArrays[key]) === jsonHash(newArrays[key]))
        unchangedNonColorArrayViews++;
    }
    const { sha256: oldColor, ...oldShape } = oldArrays.groundColors;
    const { sha256: newColor, ...newShape } = newArrays.groundColors;
    equal(`leaf ${i} groundColors shape`, oldShape, newShape);
    if (oldColor !== newColor) changedColorLeaves++;
    else failures.push(`leaf ${i} groundColors unchanged`);
  }
  return {
    passed: failures.length === 0,
    changedColorLeaves,
    unchangedNonColorArrayViews,
    failures,
  };
}

async function main(args: string[]) {
  const [mode, baselinePath, resultPath] = args;
  assert(
    (mode === "baseline" && args.length === 2) ||
      (mode === "compare" && args.length === 3),
    "Usage: baseline EXTERNAL.json | compare BEFORE.json EXTERNAL.json",
  );
  const outputPath = mode === "baseline" ? baselinePath : resultPath;
  assert(
    path.isAbsolute(outputPath) && path.extname(outputPath) === ".json",
    "Absolute JSON output required",
  );
  const parent = await realpath(path.dirname(outputPath));
  assert(
    !parent.startsWith(`${await realpath(repo)}${path.sep}`) &&
      parent !== (await realpath(repo)),
    "Evidence must be outside the game repository",
  );
  let baseline: MaterialWorkerSnapshot | undefined;
  let baselineHash: string | undefined;
  if (mode === "compare") {
    assert(path.isAbsolute(baselinePath));
    assert(
      (await stat(baselinePath)).size <= 1024 * 1024,
      "Bounded baseline JSON",
    );
    const bytes = await readFile(baselinePath);
    baselineHash = hash(bytes);
    baseline = JSON.parse(bytes.toString());
  }
  const snapshot = await captureMaterialWorkerSnapshot();
  const comparison = baseline
    ? compareMaterialWorkerSnapshots(baseline, snapshot)
    : null;
  const result = comparison
    ? { ...snapshot, comparison, baselineSha256: baselineHash }
    : snapshot;
  const bytes = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(outputPath, bytes, { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ outputPath, sha256: hash(bytes), sourcePins: snapshot.sourcePins.length, totalClumps: snapshot.totalClumps, leafCounts: snapshot.leaves.map((leaf) => leaf.count), comparison })}\n`,
  );
  if (comparison && !comparison.passed) process.exitCode = 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
