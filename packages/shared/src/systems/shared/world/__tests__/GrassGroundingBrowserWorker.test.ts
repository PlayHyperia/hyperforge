import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type {
  Browser,
  BrowserContext,
  Page,
  Worker as BrowserWorker,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  GrassGroundingClientRequest,
  GrassGroundingClientSettled,
} from "../../../../utils/workers/GrassGroundingWorkerClient";
import type {
  GrassGroundingWorkerCacheReceipt,
  GrassGroundingWorkerRequest,
  GrassGroundingWorkerResponse,
} from "../../../../utils/workers/GrassGroundingWorkerWire";
import {
  GRASS_BLADE_GROUNDING_LIMITS,
  groundGrassBlades,
} from "../GrassBladeGrounding";
import {
  createSameFaceCase,
  sameFaceInputHash,
  type SameFaceCase,
} from "./fixtures/GrassBladeGroundingSameFaceCases";
import {
  createGrassGroundingWorkerRequest,
  grassGroundingWorkerSemanticResult,
} from "./fixtures/GrassGroundingWorkerHarness";

// Explicitly opt-in: actual factory/flattened-sidecar/Vite production packaging
// and native browser transport proof. NOT the full game's build/configuration,
// integrated gameplay, rendering, startup performance or GPU memory acceptance.
const native =
  process.env.HYPERIA_NATIVE_GROUNDING_WORKER === "1"
    ? describe.sequential
    : describe.skip;
const cases: SameFaceCase[] = [
  "ordinary-lod0",
  "fine-near4",
  "mixed-exclusions",
  "empty",
];
type Encoded =
  null | boolean | string | number | Encoded[] | { [key: string]: Encoded };

/** Playwright's JSON boundary is not the worker's structured-clone boundary.
 * Preserve every typed-array byte and special number before crossing it. */
function encode(value: unknown): Encoded {
  if (value === undefined) return { $number: "undefined" };
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { $number: "-0" };
    if (!Number.isFinite(value)) return { $number: String(value) };
    return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (
    value instanceof Float32Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array
  )
    return {
      $view: value.constructor.name,
      hex: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("hex"),
    };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encode(item)]),
    );
  throw new Error("Unsupported browser qualification codec value");
}

function decode(value: Encoded): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value.$number === "string") {
    if (value.$number === "undefined") return undefined;
    if (value.$number === "-0") return -0;
    return Number(value.$number);
  }
  if (typeof value.$view === "string" && typeof value.hex === "string") {
    const bytes = Uint8Array.from(Buffer.from(value.hex, "hex"));
    if (value.$view === "Float32Array") return new Float32Array(bytes.buffer);
    if (value.$view === "Uint16Array") return new Uint16Array(bytes.buffer);
    if (value.$view === "Uint32Array") return new Uint32Array(bytes.buffer);
    throw new Error("Unsupported browser qualification array type");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decode(item)]),
  );
}

// Served as plain JavaScript; the browser imports only the actual production
// client/wire/entry bundles, never Vitest, Node crypto or the Node worker adapter.
const probeSource = String.raw`
(() => {
  const workers = new Set(), clients = new Set();
  function encode(value) {
    if (value === undefined) return {$number: "undefined"};
    if (typeof value === "number") {
      if (Object.is(value, -0)) return {$number: "-0"};
      if (!Number.isFinite(value)) return {$number: String(value)};
      return value;
    }
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (value instanceof Float32Array || value instanceof Uint16Array || value instanceof Uint32Array) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let hex = "";
      for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
      return {$view: value.constructor.name, hex};
    }
    if (Array.isArray(value)) return value.map(encode);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    throw new Error("Unsupported native codec value");
  }
  function decode(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(decode);
    if (typeof value.$number === "string") {
      if (value.$number === "undefined") return undefined;
      if (value.$number === "-0") return -0;
      return Number(value.$number);
    }
    if (typeof value.$view === "string" && typeof value.hex === "string") {
      const bytes = new Uint8Array(value.hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.hex.slice(i * 2, i * 2 + 2), 16);
      if (value.$view === "Float32Array") return new Float32Array(bytes.buffer);
      if (value.$view === "Uint16Array") return new Uint16Array(bytes.buffer);
      if (value.$view === "Uint32Array") return new Uint32Array(bytes.buffer);
      throw new Error("Unsupported native array type");
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  const api = globalThis.HyperiaGroundingTransport;
  globalThis.groundingTransportProbe = {
    roundtrip: value => encode(decode(value)),
    counts: () => ({workers: workers.size, clients: clients.size}),
    disposeAll() {
      for (const client of clients) client.destroy();
      for (const worker of workers) worker.terminate();
      clients.clear(); workers.clear();
    },
    async run(encodedRequests, cancelIndex = -1) {
      const totalStarted = performance.now();
      const worker = api.createGrassGroundingWorker();
      if (!(worker instanceof Worker)) throw new Error("Actual factory did not return a native Worker");
      workers.add(worker);
      let client;
      const rows = [], errors = [];
      try {
        client = new api.GrassGroundingWorkerClient(worker);
        clients.add(client);
        const messages = [];
        worker.addEventListener("error", event => errors.push(event.message));
        worker.addEventListener("messageerror", () => errors.push("messageerror"));
        worker.addEventListener("message", event => messages.push({
          type: event.data.type, jobId: event.data.jobId, busyAtReceive: client.busy,
        }));
        for (let i = 0; i < encodedRequests.length; i++) {
          const request = decode(encodedRequests[i]);
          const transfers = request.type === "release_surfaces" ? [] :
            api.grassGroundingWorkerInputTransfers({...request, jobId: 1});
          const inputBytes = transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
          const started = performance.now(), jobId = client.submit(request);
          const busyAfterSubmit = client.busy;
          const detached = transfers.every(buffer => buffer.byteLength === 0);
          let cancelSent = false, duplicateCancel = false, prematureSubmitRejected = false;
          if (i === cancelIndex) {
            cancelSent = client.cancel();
            duplicateCancel = client.cancel();
            try { client.submit({type: "release_surfaces", schemaVersion: 1, generation: request.generation, surfaceTokens: []}); }
            catch (error) { prematureSubmitRejected = String(error).includes("busy"); }
          }
          let settled = null, busyBeforeTake = false;
          while (!settled) {
            busyBeforeTake = client.busy;
            settled = client.takeSettled();
            if (!settled) {
              if (performance.now() - started >= 12000) throw new Error("Native transport qualification deadline exceeded");
              await new Promise(resolve => setTimeout(resolve, 4));
            }
          }
          rows.push({jobId, inputBytes, detached, busyAfterSubmit, busyBeforeTake,
            busyAfterTake: client.busy, cancelSent, duplicateCancel, prematureSubmitRejected,
            elapsedMs: performance.now() - started, settled,
            messages: messages.filter(message => message.jobId === jobId), cache: client.cacheReceipt});
        }
      } finally {
        if (client) { client.destroy(); clients.delete(client); }
        worker.terminate(); workers.delete(worker);
      }
      return encode({rows, errors, totalElapsedMs: performance.now() - totalStarted,
        cleanup: {workers: workers.size, clients: clients.size,
        clientTerminated: client.terminated, cache: client.cacheReceipt}});
    },
  };
})();`;

type Row = {
  jobId: number;
  inputBytes: number;
  detached: boolean;
  busyAfterSubmit: boolean;
  busyBeforeTake: boolean;
  busyAfterTake: boolean;
  cancelSent: boolean;
  duplicateCancel: boolean;
  prematureSubmitRejected: boolean;
  elapsedMs: number;
  settled: GrassGroundingClientSettled;
  messages: {
    type: GrassGroundingWorkerResponse["type"];
    jobId: number;
    busyAtReceive: boolean;
  }[];
  cache: GrassGroundingWorkerCacheReceipt;
};
type RunReceipt = {
  rows: Row[];
  errors: string[];
  totalElapsedMs: number;
  cleanup: {
    workers: number;
    clients: number;
    clientTerminated: boolean;
    cache: GrassGroundingWorkerCacheReceipt;
  };
};
type ProbeWindow = Window & {
  groundingTransportProbe: {
    roundtrip(value: Encoded): Encoded;
    run(requests: Encoded[], cancelIndex: number): Promise<Encoded>;
    counts(): { workers: number; clients: number };
    disposeAll(): void;
  };
};

function coldRequest(
  packet: GrassGroundingWorkerRequest,
): GrassGroundingClientRequest {
  const { jobId, ...request } = packet;
  expect(jobId).toBeGreaterThan(0);
  return request;
}

function cachedRequest(
  packet: GrassGroundingWorkerRequest,
): GrassGroundingClientRequest {
  const { type, jobId, surfaces, ...request } = packet;
  expect(type).toBe("start");
  expect(jobId).toBeGreaterThan(0);
  return {
    ...request,
    type: "start_cached",
    surfaceTokens: surfaces.map(({ token }) => token),
  };
}

function resultResponse(row: Row) {
  const settled = row.settled;
  if (settled.status !== "response" || settled.response.type !== "result")
    throw new Error(
      "Expected actual native fit response: " + JSON.stringify(settled),
    );
  const response = settled.response;
  if (
    response.state.status !== "ready" &&
    response.state.status !== "waiting_support"
  )
    throw new Error("Native fit did not complete: " + JSON.stringify(response));
  return { ...response, result: response.state.result };
}

native(
  "native Chrome grass worker transport (not integrated gameplay/performance acceptance)",
  () => {
    let browser: Browser | undefined,
      context: BrowserContext | undefined,
      page: Page | undefined,
      server: Server | undefined;
    let temporaryRoot: string | undefined;
    let adapter: {
      available: boolean;
      secureContext: boolean;
      userAgent: string;
      vendor: string;
      architecture: string;
    };
    const browserErrors: string[] = [];
    const workerUrls: string[] = [];
    const activeWorkers = new Set<BrowserWorker>();
    const servedWorkerPaths = new Set<string>();
    const workerAssetPaths: string[] = [];
    const sourceInputs: string[] = [];
    const emittedAssets: { path: string; bytes: number }[] = [];
    const viteChunks: {
      path: string;
      imports: string[];
      dynamicImports: string[];
    }[] = [];

    async function cleanup() {
      try {
        if (page && !page.isClosed())
          await page.evaluate(() =>
            (
              window as unknown as ProbeWindow
            ).groundingTransportProbe?.disposeAll(),
          );
      } finally {
        try {
          await context?.close();
        } finally {
          try {
            await browser?.close();
          } finally {
            try {
              if (server) {
                const owned = server;
                server = undefined;
                if (owned.listening)
                  await new Promise<void>((resolve, reject) => {
                    owned.close((error) => (error ? reject(error) : resolve()));
                    owned.closeAllConnections();
                  });
              }
            } finally {
              if (temporaryRoot) {
                // Only the unique directory returned by this fixture's mkdtemp;
                // never a project path, shared cache or other test's artifact.
                const owned = temporaryRoot;
                temporaryRoot = undefined;
                await rm(owned, { recursive: true, force: true });
              }
            }
          }
        }
      }
    }

    beforeAll(async () => {
      try {
        const clientPath = fileURLToPath(
          new URL(
            "../../../../utils/workers/GrassGroundingWorkerClient.ts",
            import.meta.url,
          ),
        );
        const wirePath = fileURLToPath(
          new URL(
            "../../../../utils/workers/GrassGroundingWorkerWire.ts",
            import.meta.url,
          ),
        );
        const factoryPath = fileURLToPath(
          new URL(
            "../../../../utils/workers/createGrassGroundingWorker.ts",
            import.meta.url,
          ),
        );
        const workerPath = fileURLToPath(
          new URL(
            "../../../../utils/workers/GrassGroundingWorker.entry.ts",
            import.meta.url,
          ),
        );
        const client = await build({
          stdin: {
            contents: `export { GrassGroundingWorkerClient } from ${JSON.stringify(clientPath)}; export { grassGroundingWorkerInputTransfers } from ${JSON.stringify(wirePath)}; export { createGrassGroundingWorker } from ${JSON.stringify(factoryPath)};`,
            loader: "ts",
            resolveDir: fileURLToPath(new URL(".", import.meta.url)),
          },
          bundle: true,
          write: false,
          metafile: true,
          platform: "browser",
          format: "esm",
          target: "es2022",
          minify: false,
          keepNames: true,
        });
        const worker = await build({
          entryPoints: [workerPath],
          bundle: true,
          write: false,
          metafile: true,
          platform: "browser",
          format: "esm",
          target: "es2022",
          minify: true,
          keepNames: true,
        });
        expect(client.outputFiles).toHaveLength(1);
        expect(worker.outputFiles).toHaveLength(1);
        const inputs = [
          ...Object.keys(client.metafile.inputs),
          ...Object.keys(worker.metafile.inputs),
        ];
        sourceInputs.push(...new Set(inputs));
        expect(
          inputs.some((path) => path.endsWith("GrassGroundingWorkerClient.ts")),
        ).toBe(true);
        expect(
          inputs.some((path) => path.endsWith("GrassGroundingWorker.entry.ts")),
        ).toBe(true);
        expect(
          inputs.some((path) => path.endsWith("createGrassGroundingWorker.ts")),
        ).toBe(true);
        expect(
          inputs.filter((path) =>
            /__tests__|vitest|playwright|worker_threads|node:|packages\/server|WebGPURenderer/.test(
              path,
            ),
          ),
        ).toEqual([]);

        // Reproduce the real shared library's flattened sibling contract using
        // private generated inputs. Vite must resolve and emit that literal URL;
        // no synthetic Worker constructor or manually chosen worker URL exists.
        temporaryRoot = await mkdtemp(
          join(tmpdir(), "hyperia-native-grounding-packaging-"),
        );
        const sharedBuild = join(temporaryRoot, "shared", "build");
        await mkdir(sharedBuild, { recursive: true });
        await writeFile(
          join(sharedBuild, "framework.client.js"),
          client.outputFiles[0].text,
        );
        await writeFile(
          join(sharedBuild, "grass-grounding.worker.js"),
          worker.outputFiles[0].text,
        );
        const entryPath = join(temporaryRoot, "entry.js");
        await writeFile(
          entryPath,
          'import * as transport from "./shared/build/framework.client.js";\n' +
            "globalThis.HyperiaGroundingTransport = transport;\n" +
            probeSource,
        );
        const { build: buildVite } = await import("vite");
        const built = await buildVite({
          configFile: false,
          envDir: false,
          root: temporaryRoot,
          mode: "production",
          publicDir: false,
          cacheDir: join(temporaryRoot, "vite-cache"),
          logLevel: "warn",
          build: {
            write: false,
            emptyOutDir: false,
            copyPublicDir: false,
            outDir: join(temporaryRoot, "vite-output"),
            target: "es2022",
            minify: false,
            sourcemap: false,
            rollupOptions: {
              input: entryPath,
              output: { entryFileNames: "client.js" },
            },
          },
        });
        const assets = new Map<string, string | Uint8Array>();
        for (const bundle of Array.isArray(built) ? built : [built]) {
          if (!("output" in bundle)) {
            await bundle.close();
            throw new Error("Unexpected watch-mode Vite packaging result");
          }
          for (const output of bundle.output) {
            const path = "/" + output.fileName;
            if (assets.has(path))
              throw new Error(
                "Duplicate emitted native packaging asset: " + path,
              );
            const source =
              output.type === "chunk" ? output.code : output.source;
            assets.set(path, source);
            emittedAssets.push({
              path,
              bytes:
                typeof source === "string"
                  ? Buffer.byteLength(source)
                  : source.byteLength,
            });
            if (output.type === "chunk")
              viteChunks.push({
                path,
                imports: output.imports,
                dynamicImports: output.dynamicImports,
              });
            if (/\/grass-grounding\.worker-[^/]+\.js$/.test(path))
              workerAssetPaths.push(path);
          }
        }
        process.stdout.write(
          "Native grounding focused Vite packaging " +
            JSON.stringify({
              sourceInputs,
              emittedAssets,
              viteChunks,
              workerAssetPaths,
              factory: "createGrassGroundingWorker",
              write: false,
              configFile: false,
              scope:
                "Compilation receipt only; real factory URL, native transport and byte parity are asserted by the following browser cases. Not a full game build.",
            }) +
            "\n",
        );
        expect(assets.has("/client.js")).toBe(true);
        expect(workerAssetPaths).toHaveLength(1);
        server = createServer((request, response) => {
          const path = request.url?.split("?")[0];
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          if (path === "/") {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(
              '<!doctype html><meta charset="utf-8"><title>Hyperia native grounding transport qualification</title><p>Actual factory/Vite/native Worker proof. No gameplay or rendering acceptance.</p><script type="module" src="/client.js"></script>',
            );
          } else if (path !== undefined && assets.has(path)) {
            response.setHeader(
              "Content-Type",
              "text/javascript; charset=utf-8",
            );
            if (workerAssetPaths.includes(path)) servedWorkerPaths.add(path);
            response.end(assets.get(path));
          } else {
            response.statusCode = 404;
            response.end();
          }
        });
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(0, "127.0.0.1", () => {
            server!.removeListener("error", reject);
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Owned loopback server did not acquire a port");
        const { chromium } = await import("playwright");
        browser = await chromium.launch({
          channel: "chrome",
          headless: false,
          args: ["--use-angle=metal", "--enable-features=WebGPU,UnsafeWebGPU"],
        });
        context = await browser.newContext();
        page = await context.newPage();
        page.on("pageerror", (error) => browserErrors.push(error.message));
        page.on("worker", (worker) => {
          workerUrls.push(worker.url());
          activeWorkers.add(worker);
          worker.once("close", () => activeWorkers.delete(worker));
        });
        await page.goto(`http://127.0.0.1:${address.port}/`, {
          waitUntil: "load",
        });
        adapter = await page.evaluate(async () => {
          if (!navigator.gpu)
            throw new Error("Native qualification requires navigator.gpu");
          const actual = await navigator.gpu.requestAdapter();
          if (!actual)
            throw new Error(
              "Native qualification could not acquire a WebGPU adapter",
            );
          return {
            available: true,
            secureContext: globalThis.isSecureContext,
            userAgent: navigator.userAgent,
            vendor: actual.info.vendor,
            architecture: actual.info.architecture,
          };
        });
        expect(adapter.available).toBe(true);
        expect(adapter.secureContext).toBe(true);
        expect(context.pages()).toHaveLength(1);
      } catch (error) {
        await cleanup();
        throw error;
      }
    }, 30_000);
    afterAll(cleanup, 15_000);

    async function run(
      label: string,
      requests: GrassGroundingClientRequest[],
      cancelIndex = -1,
    ): Promise<RunReceipt> {
      if (!page) throw new Error("Native browser was not initialized");
      const firstWorker = workerUrls.length;
      // Only strings cross Playwright's type-level serialization boundary;
      // typed bytes and special numbers remain protected by the explicit codec.
      const serialized = await page.evaluate(
        async (payload) => {
          const { packets, cancelIndex } = JSON.parse(payload) as {
            packets: Encoded[];
            cancelIndex: number;
          };
          return JSON.stringify(
            await (
              window as unknown as ProbeWindow
            ).groundingTransportProbe.run(packets, cancelIndex),
          );
        },
        JSON.stringify({ packets: requests.map(encode), cancelIndex }),
      );
      const receipt = decode(JSON.parse(serialized) as Encoded) as RunReceipt;
      const actualWorkerUrls = workerUrls.slice(firstWorker);
      expect(actualWorkerUrls).toHaveLength(1);
      for (const url of actualWorkerUrls) {
        const actual = new URL(url);
        expect(actual.origin).toBe(new URL(page.url()).origin);
        expect(actual.pathname).toBe(workerAssetPaths[0]);
        expect(servedWorkerPaths.has(actual.pathname)).toBe(true);
      }
      // Native Playwright worker-close events independently confirm the
      // fixture's own JS custody counters; no Worker prototype replacement.
      await expect.poll(() => activeWorkers.size, { timeout: 3000 }).toBe(0);
      expect(receipt.errors).toEqual([]);
      expect(browserErrors).toEqual([]);
      expect(Number.isFinite(receipt.totalElapsedMs)).toBe(true);
      expect(receipt.totalElapsedMs).toBeGreaterThanOrEqual(0);
      expect(receipt.cleanup).toEqual({
        workers: 0,
        clients: 0,
        clientTerminated: true,
        cache: { owners: 0, inputBytes: 0, derivedBytesReserved: 0 },
      });
      expect(receipt.rows).toHaveLength(requests.length);
      for (const row of receipt.rows) {
        expect(row.detached).toBe(true);
        expect(row.busyAfterSubmit).toBe(true);
        expect(row.busyBeforeTake).toBe(true);
        expect(row.busyAfterTake).toBe(false);
        expect(row.messages.length).toBeGreaterThan(0);
        expect(row.messages.every((message) => message.busyAtReceive)).toBe(
          true,
        );
        expect(row.settled.status, JSON.stringify(row.settled)).toBe(
          "response",
        );
        for (const field of [
          "dispatchCpuMs",
          "postMessageCpuMs",
          "receiveCpuMs",
        ] as const) {
          expect(Number.isFinite(row.settled[field])).toBe(true);
          expect(row.settled[field]).toBeGreaterThanOrEqual(0);
        }
      }
      process.stdout.write(
        "Native browser grounding transport proof " +
          JSON.stringify({
            label,
            adapter,
            packaging: {
              sourceInputs,
              emittedAssets,
              viteChunks,
              workerAssetPaths,
              actualWorkerUrls,
              activeNativeWorkersAfter: activeWorkers.size,
              actualFactory: "createGrassGroundingWorker",
              focusedViteProductionBuild: true,
              fullGameBuild: false,
            },
            errors: receipt.errors,
            browserErrors,
            cleanup: receipt.cleanup,
            // Includes worker lifetime, all admissions and all fits/release; no free
            // cache warmup. Excludes Node/browser-boundary encode/decode outside run.
            totalElapsedMs: receipt.totalElapsedMs,
            rows: receipt.rows.map((row) => {
              const settled = row.settled;
              const response =
                settled.status === "response" ? settled.response : null;
              return {
                jobId: row.jobId,
                requestType: settled.requestType,
                inputBytes: row.inputBytes,
                detached: row.detached,
                elapsedMs: row.elapsedMs,
                dispatchCpuMs: settled.dispatchCpuMs,
                postMessageCpuMs: settled.postMessageCpuMs,
                receiveCpuMs: settled.receiveCpuMs,
                state:
                  response && "state" in response
                    ? response.state.status
                    : response?.type,
                work: response && "work" in response ? response.work : null,
                lastPhase:
                  response && "lastPhase" in response
                    ? response.lastPhase
                    : null,
                terrainRebuildWork:
                  response && "terrainRebuildWork" in response
                    ? response.terrainRebuildWork
                    : null,
                derivedBytesReserved:
                  response && "derivedBytesReserved" in response
                    ? response.derivedBytesReserved
                    : null,
                resultBytes:
                  response && "resultBytes" in response
                    ? response.resultBytes
                    : null,
                cache: row.cache,
                cancelled: row.cancelSent,
                messages: row.messages,
              };
            }),
            scope:
              "Actual factory, flattened sibling, focused Vite production packaging, native Worker/client transport and byte parity only. Timings include browser scheduling; no full game build/configuration, integrated gameplay, rendering or performance acceptance.",
          }) +
          "\n",
      );
      return receipt;
    }

    it("preserves typed bytes and ±Infinity/−0 across the qualification boundary", async () => {
      if (!page) throw new Error("Native browser was not initialized");
      const source = {
        numbers: [Infinity, -Infinity, -0, NaN, undefined],
        floats: new Float32Array([-0, Infinity, -Infinity, NaN, 0.1]),
        shorts: new Uint16Array([0, 65535]),
        words: new Uint32Array([0, 4294967295]),
      };
      const encoded = encode(source);
      const serialized = await page.evaluate(
        (payload) =>
          JSON.stringify(
            (
              window as unknown as ProbeWindow
            ).groundingTransportProbe.roundtrip(JSON.parse(payload) as Encoded),
          ),
        JSON.stringify(encoded),
      );
      expect(JSON.parse(serialized) as Encoded).toEqual(encoded);
      const restored = decode(encoded) as typeof source;
      expect(Object.is(restored.numbers[2], -0)).toBe(true);
      expect(encode(restored)).toEqual(encoded);
    });

    it.each(cases)(
      "matches actual cold grounding byte-for-byte for %s",
      async (id) => {
        const fixture = createSameFaceCase(id);
        try {
          const original = sameFaceInputHash(fixture),
            expected = groundGrassBlades(fixture.request);
          const { rows } = await run(id + "/cold", [
            coldRequest(createGrassGroundingWorkerRequest(fixture.request)),
          ]);
          const actual = resultResponse(rows[0]);
          expect(
            grassGroundingWorkerSemanticResult(actual.result, fixture.request),
          ).toEqual(
            grassGroundingWorkerSemanticResult(expected, fixture.request),
          );
          expect(actual.inputBytes).toBe(rows[0].inputBytes);
          expect(actual.terrainRebuildWork).not.toBeNull();
          expect(actual.work.operations).toBeGreaterThan(0);
          expect(rows[0].cache.owners).toBe(0);
          expect(sameFaceInputHash(fixture)).toBe(original);
        } finally {
          fixture.dispose();
        }
      },
    );

    it.each(cases)(
      "admits, fits, repeats twice and releases actual cached owners for %s",
      async (id) => {
        const fixture = createSameFaceCase(id);
        try {
          const original = sameFaceInputHash(fixture),
            expected = groundGrassBlades(fixture.request);
          const packet = createGrassGroundingWorkerRequest(fixture.request);
          const requests: GrassGroundingClientRequest[] = packet.surfaces.map(
            ({ token, snapshot }) => ({
              type: "prepare_surface",
              schemaVersion: 1,
              generation: packet.generation,
              token,
              snapshot,
              consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
            }),
          );
          const count = requests.length;
          for (let i = 0; i < 3; i++)
            requests.push(
              cachedRequest(createGrassGroundingWorkerRequest(fixture.request)),
            );
          requests.push({
            type: "release_surfaces",
            schemaVersion: 1,
            generation: packet.generation,
            surfaceTokens: packet.surfaces.map(({ token }) => token),
          });
          const { rows } = await run(
            id + "/cached-admit-initial-two-repeats-release",
            requests,
          );
          let preparationOperations = 0;
          for (const row of rows.slice(0, count)) {
            const settled = row.settled;
            if (
              settled.status !== "response" ||
              settled.response.type !== "surface_prepared"
            )
              throw new Error("Missing native preparation acknowledgement");
            expect(settled.response.state.status).toBe("prepared");
            expect(settled.response.work.operations).toBeGreaterThan(0);
            expect(settled.response.inputBytes).toBe(row.inputBytes);
            preparationOperations += settled.response.work.operations;
          }
          expect(preparationOperations).toBeGreaterThan(0);
          for (const row of rows.slice(count, count + 3)) {
            const actual = resultResponse(row);
            expect(
              grassGroundingWorkerSemanticResult(
                actual.result,
                fixture.request,
              ),
            ).toEqual(
              grassGroundingWorkerSemanticResult(expected, fixture.request),
            );
            expect(actual.terrainRebuildWork).toBeNull();
            expect(actual.derivedBytesReserved).toBe(0);
            expect(actual.inputBytes).toBe(row.inputBytes);
            expect(row.cache.owners).toBe(count);
          }
          const release = rows[rows.length - 1];
          expect(
            release.settled.status === "response" &&
              release.settled.response.type,
          ).toBe("surfaces_released");
          expect(release.cache).toEqual({
            owners: 0,
            inputBytes: 0,
            derivedBytesReserved: 0,
          });
          expect(sameFaceInputHash(fixture)).toBe(original);
        } finally {
          fixture.dispose();
        }
      },
    );

    it("retains its occupied slot until actual cancellation acknowledgement, then recovers", async () => {
      const fixture = createSameFaceCase("fine-near4"),
        recovery = createSameFaceCase("empty");
      try {
        const packet = createGrassGroundingWorkerRequest(fixture.request);
        // Keep the actual small terrain/blade fixture. Expand only authored input
        // clumps to the existing cap so an immediate cancel races genuine sliced
        // work rather than a trivially complete fit. No scheduling overrides.
        const count = GRASS_BLADE_GROUNDING_LIMITS.maxClumps;
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundColors",
          "grassTints",
          "groundNormals",
        ] as const) {
          const stride = key === "grassTints" ? 4 : 3;
          const first = packet.data[key].slice(0, stride),
            values = new Float32Array(count * stride);
          for (let i = 0; i < count; i++) values.set(first, i * stride);
          packet.data[key] = values;
        }
        packet.data.count = count;
        const { rows } = await run(
          "cancel-acknowledgement-and-recovery",
          [
            coldRequest(packet),
            coldRequest(createGrassGroundingWorkerRequest(recovery.request)),
          ],
          0,
        );
        const cancelled = rows[0];
        expect(cancelled.cancelSent).toBe(true);
        expect(cancelled.duplicateCancel).toBe(false);
        expect(cancelled.prematureSubmitRejected).toBe(true);
        if (
          cancelled.settled.status !== "response" ||
          cancelled.settled.response.type !== "result"
        )
          throw new Error("Missing native cancellation acknowledgement");
        expect(cancelled.settled.response.state).toEqual({
          status: "cancelled",
          reason: "caller",
        });
        expect(cancelled.messages.map((message) => message.type)).toEqual([
          "accepted",
          "result",
        ]);
        const actual = resultResponse(rows[1]);
        expect(
          grassGroundingWorkerSemanticResult(actual.result, recovery.request),
        ).toEqual(
          grassGroundingWorkerSemanticResult(
            groundGrassBlades(recovery.request),
            recovery.request,
          ),
        );
      } finally {
        fixture.dispose();
        recovery.dispose();
      }
    });
  },
);
