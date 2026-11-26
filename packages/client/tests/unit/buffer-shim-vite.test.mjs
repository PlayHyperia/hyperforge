import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { assertHyperiaNodeVersion } from "../../../../scripts/node-runtime-policy.mjs";

const thisFile = fileURLToPath(import.meta.url);
const clientDir = path.resolve(path.dirname(thisFile), "../..");
const execFileAsync = promisify(execFile);

async function probeViteBuffer() {
  assertHyperiaNodeVersion(process.version);
  const { createServer } = await import("vite");
  const temporaryDir = await mkdtemp(
    path.join(tmpdir(), "hyperia-buffer-vite-"),
  );
  const cacheDir = path.join(temporaryDir, "cache");
  let server;
  let serverClosed = false;
  let proof;
  try {
    server = await createServer({
      configFile: path.join(clientDir, "vite.config.ts"),
      mode: "development",
      cacheDir,
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [
        {
          name: "buffer-regression-no-watcher",
          configResolved(config) {
            // Vite's inline config merge drops null overrides. Set this on the
            // resolved TEST server before createServer creates any watcher.
            config.server.watch = null;
          },
        },
      ],
    });
    assert.equal(server.httpServer, null, "no HTTP listener is created");
    assert.equal(server.config.server.hmr, false);
    assert.equal(server.config.server.watch, null);
    assert.equal(server.config.cacheDir, cacheDir);
    const client = server.environments.client;
    assert.equal(client.config.optimizeDeps.noDiscovery, true);
    assert.ok(client.config.optimizeDeps.include.includes("buffer"));
    assert.ok(!client.config.optimizeDeps.include.includes("buffer/index.js"));
    const optimizer = client.depsOptimizer;
    assert.ok(optimizer);
    const importer = path.join(clientDir, "src/polyfills/buffer-shim.ts");

    // Transform the actual application shim, using the actual noDiscovery config.
    // This also waits for the optimizer's real interop decision for this import.
    const shim = await client.transformRequest("/polyfills/buffer-shim.ts");
    assert.ok(shim);
    const optimized = optimizer.metadata.optimized.buffer;
    assert.ok(optimized, "bare buffer has a completed optimizer entry");
    assert.equal(optimized.needsInterop, true);
    const bare = await client.pluginContainer.resolveId("buffer", importer);
    assert.ok(bare);
    assert.equal(bare.id.split("?")[0], optimized.file);
    assert.ok(optimizer.isOptimizedDepFile(bare.id));
    assert.ok(optimized.file.startsWith(`${cacheDir}${path.sep}`));
    assert.ok(shim.code.includes(optimized.file));

    // The former subpath resolves through the SAME real config/importer, but
    // bypasses the explicitly optimized bare ID and still serves raw CommonJS.
    const deep = await client.pluginContainer.resolveId(
      "buffer/index.js",
      importer,
    );
    assert.ok(deep);
    assert.equal(deep.id.split("?")[0], optimized.src);
    assert.equal(optimizer.isOptimizedDepFile(deep.id), false);
    assert.equal(optimizer.metadata.optimized["buffer/index.js"], undefined);
    const source = await readFile(importer, "utf8");
    const formerSource = source.replace(
      'from "buffer"',
      'from "buffer/index.js"',
    );
    assert.notEqual(formerSource, source);
    const oldShim = await client.pluginContainer.transform(
      formerSource,
      importer,
    );
    assert.ok(oldShim.code.includes(optimized.src));
    const oldModule = await client.transformRequest(`/@fs/${deep.id}`);
    assert.ok(oldModule);
    assert.match(oldModule.code, /require\(['"]base64-js['"]\)/);
    assert.throws(
      () => new vm.Script(oldModule.code).runInNewContext({ exports: {} }),
      { name: "ReferenceError", message: "require is not defined" },
    );
    assert.ok(!shim.code.includes(optimized.src));

    // Import ONLY Vite's generated browser dependency, not Node's built-in
    // buffer or the shim's global fallback. Native Chrome boot remains separate.
    const generated = await import(pathToFileURL(optimized.file).href);
    const BrowserBuffer = generated.default.Buffer;
    assert.equal(typeof BrowserBuffer, "function");
    assert.notEqual(BrowserBuffer, globalThis.Buffer);
    const message = "Hyperia buffer — \u{1f30a}";
    const encoded = BrowserBuffer.from(message, "utf8").toString("base64");
    assert.equal(
      BrowserBuffer.from(encoded, "base64").toString("utf8"),
      message,
    );
    assert.deepEqual(
      [...BrowserBuffer.from(new Uint8Array([0, 127, 128, 255]))],
      [0, 127, 128, 255],
    );
    const metadata = JSON.parse(
      await readFile(path.join(path.dirname(optimized.file), "_metadata.json")),
    );
    assert.equal(metadata.optimized.buffer.needsInterop, true);
    proof = {
      actualConfig: "packages/client/vite.config.ts",
      noDiscovery: true,
      optimizedInterop: true,
      formerDeepImportThrows: "require is not defined",
      optimizedExportRoundtrip: true,
      browserBootVerified: false,
      httpListenerCreated: false,
      hmr: false,
    };
  } finally {
    try {
      if (server) {
        await server.close();
        serverClosed = true;
        assert.equal(server.httpServer, null);
      }
    } finally {
      await rm(temporaryDir, { recursive: true, force: true });
    }
  }
  assert.equal(serverClosed, true);
  await assert.rejects(stat(temporaryDir), { code: "ENOENT" });
  process.stdout.write(
    `BUFFER_VITE_PROOF ${JSON.stringify({ ...proof, serverClosed, temporaryCacheRemoved: true })}\n`,
  );
}

if (process.argv[2] === "--probe") {
  await probeViteBuffer();
} else {
  test(
    "actual noDiscovery Vite transforms the shim through optimized buffer, not the raw CJS subpath",
    { timeout: 120_000 },
    async (t) => {
      // Deliberately do not inherit personal credentials or NODE_OPTIONS. The
      // config still loads its normal files, but exposed endpoints are local-only.
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [thisFile, "--probe"],
        {
          cwd: clientDir,
          timeout: 90_000,
          maxBuffer: 512 * 1024,
          env: {
            PATH: process.env.PATH,
            PLAYWRIGHT_TEST: "true",
            PUBLIC_PRIVY_APP_ID: "buffer-regression-local",
            PUBLIC_API_URL: "http://127.0.0.1:1",
            PUBLIC_WS_URL: "ws://127.0.0.1:1/ws",
            PUBLIC_CDN_URL: "http://127.0.0.1:1/game-assets",
            PUBLIC_APP_URL: "http://127.0.0.1:1",
            PUBLIC_ELIZAOS_URL: "http://127.0.0.1:1",
          },
        },
      );
      const receipt = stdout
        .split("\n")
        .find((line) => line.startsWith("BUFFER_VITE_PROOF "));
      assert.ok(receipt, `missing actual Vite receipt: ${stderr}`);
      const proof = JSON.parse(receipt.slice("BUFFER_VITE_PROOF ".length));
      assert.equal(proof.serverClosed, true);
      assert.equal(proof.temporaryCacheRemoved, true);
      assert.equal(proof.browserBootVerified, false);
      t.diagnostic(JSON.stringify(proof));
      if (stderr.trim()) t.diagnostic(stderr.trim());
    },
  );
}
