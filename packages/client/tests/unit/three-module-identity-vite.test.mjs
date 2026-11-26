import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { assertHyperiaNodeVersion } from "../../../../scripts/node-runtime-policy.mjs";

const file = fileURLToPath(import.meta.url);
const clientDir = path.resolve(path.dirname(file), "../..");
const repo = path.resolve(clientDir, "../..");
const worldDir = path.join(repo, "packages/shared/src/systems/shared/world");

function triangleGlb() {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
  });
  const body = new TextEncoder().encode(
    json.padEnd(Math.ceil(json.length / 4) * 4, " "),
  );
  const result = new ArrayBuffer(12 + 8 + body.length + 8 + 36);
  const view = new DataView(result);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, result.byteLength, true);
  view.setUint32(12, body.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(result, 20, body.length).set(body);
  view.setUint32(20 + body.length, 36, true);
  view.setUint32(24 + body.length, 0x004e4942, true);
  new Float32Array(result, 28 + body.length, 9).set([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
  ]);
  return result;
}

async function probe() {
  assertHyperiaNodeVersion(process.version);
  const { createServer } = await import("vite");
  const temporary = await mkdtemp(path.join(tmpdir(), "hyperia-three-vite-"));
  let server;
  try {
    server = await createServer({
      configFile: path.join(clientDir, "vite.config.ts"),
      mode: "development",
      cacheDir: path.join(temporary, "cache"),
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [
        {
          name: "three-regression-no-watcher",
          configResolved(config) {
            config.server.watch = null;
          },
        },
      ],
    });
    assert.equal(server.httpServer, null);
    assert.equal(server.config.server.hmr, false);
    assert.equal(server.config.server.watch, null);
    const client = server.environments.client;
    assert.equal(client.config.optimizeDeps.noDiscovery, true);
    // Real entry transforms establish Vite's normal safe-module import graph.
    await client.transformRequest("/index.tsx");
    await client.transformRequest(
      `/@fs${repo}/packages/shared/build/framework.client.js`,
    );
    const importer = path.join(
      repo,
      "packages/shared/src/utils/rendering/ModelCache.ts",
    );
    const loader = await client.pluginContainer.resolveId(
      "three/examples/jsm/loaders/GLTFLoader.js",
      importer,
    );
    const gpu = await client.pluginContainer.resolveId(
      "three/webgpu",
      path.join(repo, "packages/shared/src/extras/three/three.ts"),
    );
    const tsl = await client.pluginContainer.resolveId("three/tsl", importer);
    assert.ok(loader && gpu && tsl);
    const loaderCore = await client.pluginContainer.resolveId(
      "three",
      loader.id,
    );
    assert.ok(loaderCore);

    const context = vm.createContext({
      console,
      performance,
      TextDecoder,
      TextEncoder,
      ArrayBuffer,
      Uint8Array,
      AbortController,
      AbortSignal,
      URL,
      URLSearchParams,
      setTimeout,
      clearTimeout,
    });
    const modules = new Map();
    const urlFor = (id) => `/@fs${id}`;
    async function moduleFor(url) {
      if (!modules.has(url))
        modules.set(
          url,
          (async () => {
            const transformed = await client.transformRequest(url);
            assert.ok(transformed, `Actual Vite module missing: ${url}`);
            return new vm.SourceTextModule(transformed.code, {
              context,
              identifier: url,
              initializeImportMeta(meta) {
                meta.url = `http://localhost:3333${url}`;
              },
            });
          })(),
        );
      return modules.get(url);
    }
    const link = (specifier, referencing) => {
      const url = new URL(
        specifier,
        `http://localhost:3333${referencing.identifier}`,
      );
      assert.equal(url.origin, "http://localhost:3333");
      return moduleFor(url.pathname + url.search);
    };
    const loaderModule = await moduleFor(urlFor(loader.id));
    await loaderModule.link(link);
    await loaderModule.evaluate();
    const gpuModule = await moduleFor(urlFor(gpu.id));
    if (gpuModule.status === "unlinked") await gpuModule.link(link);
    if (gpuModule.status !== "evaluated") await gpuModule.evaluate();
    const tslModule = await moduleFor(urlFor(tsl.id));
    if (tslModule.status === "unlinked") await tslModule.link(link);
    if (tslModule.status !== "evaluated") await tslModule.evaluate();
    const gltf = await new loaderModule.namespace.GLTFLoader().parseAsync(
      triangleGlb(),
      "",
    );
    const meshes = [];
    gltf.scene.traverse((node) => {
      if (node.isMesh) meshes.push(node);
    });
    assert.equal(
      meshes.length,
      1,
      "real GLTFLoader parsed the binary triangle mesh",
    );
    context.THREE = gpuModule.namespace;
    const outcomes = {};
    for (const [sourceFile, name] of [
      ["GLBResourceInstancer.ts", "extractGeometryAndMaterial"],
      ["GLBTreeBatchedInstancer.ts", "extractAllMeshParts"],
    ]) {
      const source = await readFile(path.join(worldDir, sourceFile), "utf8");
      const ast = ts.createSourceFile(
        sourceFile,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const declaration = ast.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      assert.ok(declaration, `Actual extraction function ${name} missing`);
      const js = ts.transpileModule(declaration.getText(ast), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const extract = new vm.Script(`${js}\n${name}`).runInContext(context);
      const result = extract(gltf.scene);
      outcomes[name] = Array.isArray(result) ? result.length : result ? 1 : 0;
    }
    const proof = {
      actualViteConfig: true,
      noDiscovery: true,
      realBinaryGlbMeshes: meshes.length,
      loaderMeshRecognizedByWebgpu:
        meshes[0] instanceof gpuModule.namespace.Mesh,
      outcomes,
      nativeBrowserVerified: false,
      loaderCoreOptimized: client.depsOptimizer.isOptimizedDepFile(
        loaderCore.id,
      ),
      webgpuOptimized: client.depsOptimizer.isOptimizedDepFile(gpu.id),
      tslOptimized: client.depsOptimizer.isOptimizedDepFile(tsl.id),
      tslUniformShared:
        tslModule.namespace.uniform === gpuModule.namespace.TSL.uniform,
    };
    console.log("THREE_VITE_PROOF " + JSON.stringify(proof));
    assert.equal(proof.loaderMeshRecognizedByWebgpu, true);
    assert.equal(proof.tslUniformShared, true);
    assert.deepEqual(outcomes, {
      extractGeometryAndMaterial: 1,
      extractAllMeshParts: 1,
    });
  } finally {
    try {
      if (server) await server.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[2] === "--probe") {
  await probe();
} else {
  test(
    "actual Vite GLTFLoader mesh retains WebGPU identity through both production extraction functions",
    { timeout: 120_000 },
    async (t) => {
      const result = await promisify(execFile)(
        process.execPath,
        ["--experimental-vm-modules", file, "--probe"],
        {
          cwd: clientDir,
          timeout: 90_000,
          maxBuffer: 512 * 1024,
          env: {
            PATH: process.env.PATH,
            PLAYWRIGHT_TEST: "true",
            PUBLIC_PRIVY_APP_ID: "three-regression-local",
            PUBLIC_API_URL: "http://127.0.0.1:1",
            PUBLIC_WS_URL: "ws://127.0.0.1:1/ws",
            PUBLIC_CDN_URL: "http://127.0.0.1:1/game-assets",
            PUBLIC_APP_URL: "http://127.0.0.1:1",
          },
        },
      ).catch((error) => {
        if (error.stdout) t.diagnostic(error.stdout.trim());
        throw error;
      });
      t.diagnostic(result.stdout.trim());
      if (result.stderr.trim()) t.diagnostic(result.stderr.trim());
    },
  );
}
