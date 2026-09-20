import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { resolveDuelClientCommand } from "./duel-stack-topology.mjs";
import { shutdownDuelStackChildren } from "./duel-stack-shutdown.mjs";
import { assertHyperiaNodeVersion } from "./node-runtime-policy.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientRoot = path.join(workspaceRoot, "packages/client");
const sourceRoot = path.join(clientRoot, "src");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);

async function waitFor(read, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function groupAlive(proc) {
  if (!proc?.pid) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error; // EPERM is never treated as absence.
  }
}

async function ownEphemeralPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function assertPortClear(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port }, resolve);
    });
  } finally {
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
}

async function responseText(url, timeoutMs = 30_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  assert.equal(response.status, 200, `Actual Vite request ${url}`);
  const body = await response.text();
  assert(body.length > 0 && body.length < 16 * 1024 * 1024);
  return body;
}

function assertCleanClientShutdown(shutdown, ownedPid) {
  assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
  assert.equal(shutdown.exitCode, 0);
  assert.deepEqual(shutdown.failures, []);
  assert.deepEqual(shutdown.forcedGroups, []);
  assert.deepEqual(shutdown.remainingGroups, []);
  assert.equal(shutdown.processGroupDiagnostics.inspectionErrorCount, 0);
  assert.equal(shutdown.processGroupDiagnostics.omittedInspectionErrors, 0);
  const owned = shutdown.processGroupDiagnostics.ownedProcesses;
  assert.equal(owned.length, 1);
  assert.equal(owned[0].ownedPid, ownedPid);
  assert(owned[0].exitObservedSinceShutdownEntry);
  assert(owned[0].closeObservedSinceShutdownEntry);
  assert.notEqual(owned[0].exitObservedSinceShutdownEntry.signal, "SIGKILL");
}

const preload = `
import { isMainThread } from "node:worker_threads";
import fs, { realpathSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
if (isMainThread) {
  const send = data => process.stdout.write("CLIENT_LIFECYCLE_WITNESS " + JSON.stringify(data) + "\\n");
  send({ event: "actual-vite-runtime", pid: process.pid,
    ppid: process.ppid, version: process.version, bun: process.versions.bun ?? null,
    executable: realpathSync(process.execPath), cwd: realpathSync(process.cwd()),
    entrypoint: realpathSync(process.argv[1]), arguments: process.argv.slice(2) });
  const calls = { watch: 0, watchFile: 0 };
  for (const key of ["watch", "watchFile"]) {
    const original = fs[key];
    fs[key] = function (...args) { calls[key]++; return Reflect.apply(original, this, args); };
  }
  syncBuiltinESMExports();
  const emit = process.emit;
  process.emit = function (event, ...args) {
    if (event === "SIGTERM") send({ event: "actual-watch-calls", ...calls });
    return Reflect.apply(emit, this, [event, ...args]);
  };
  globalThis.__clientLifecycleWatchWitness = options => send({ event: "actual-vite-watcher", useFsEvents: options.useFsEvents, usePolling: options.usePolling ?? false, interval: options.interval, binaryInterval: options.binaryInterval });
  registerHooks({ load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith("/vite/dist/node/chunks/node.js")) return result;
    const source = String(result.source);
    const marker = "this.options = opts;\\n\\t\\t\\tif (opts.useFsEvents)";
    if (source.split(marker).length !== 2) throw new Error("Actual Vite watcher witness needs review after dependency change");
    return { ...result, source: source.replace(marker, "this.options = opts;\\n\\t\\t\\tglobalThis.__clientLifecycleWatchWitness(opts);\\n\\t\\t\\tif (opts.useFsEvents)") };
  }});
}
`;

async function loadActualClientGraph(origin, viteEntry) {
  // Parse real Vite responses, not a hand-picked light entry fixture. This is
  // transform/shutdown coverage, not browser execution of computed imports.
  const requireVite = createRequire(viteEntry);
  const { init, parse } = requireVite("es-module-lexer");
  await init;
  const queue = ["/stream.tsx"];
  const seen = new Set();
  const deadline = Date.now() + 120_000;
  let bytes = 0;
  let computedImports = 0;
  while (queue.length) {
    assert(
      seen.size < 1200 && Date.now() < deadline,
      "Bounded real module graph",
    );
    const route = queue.shift();
    if (seen.has(route)) continue;
    seen.add(route);
    const response = await fetch(origin + route, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `Actual Vite graph request ${route}`);
    const source = await response.text();
    // The actual shared client build is ~28MB; this is a bounded transport
    // ceiling, not a lifecycle or rendering quality tolerance.
    assert(source.length < 32 * 1024 * 1024);
    bytes += Buffer.byteLength(source);
    if (
      !/javascript|ecmascript/.test(response.headers.get("content-type") ?? "")
    )
      continue;
    for (const entry of parse(source)[0]) {
      if (entry.n == null) {
        if (entry.d >= 0) computedImports++;
        continue;
      }
      if (!entry.n.startsWith("/") && !entry.n.startsWith(".")) continue;
      const url = new URL(entry.n, origin + route);
      if (url.origin === origin && !seen.has(url.pathname + url.search))
        queue.push(url.pathname + url.search);
    }
  }
  assert(
    seen.size > 500,
    "Exercise the actual game import graph, not just an HMR fixture",
  );
  return { modules: seen.size, bytes, computedImports };
}

async function sampleOwnedIdleCpu(pid) {
  const read = async () => {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "time="],
      { timeout: 1000 },
    );
    const text = stdout.trim();
    const components = text.split(":").map(Number);
    assert(components.length >= 2 && components.every(Number.isFinite));
    return {
      at: performance.now(),
      seconds: components.reduce((sum, part) => sum * 60 + part, 0),
      raw: text,
    };
  };
  const before = await read();
  await delay(5000);
  const after = await read();
  const wallMs = after.at - before.at;
  const cpuMs = (after.seconds - before.seconds) * 1000;
  assert(cpuMs >= 0);
  return {
    scope:
      "Five-second idle Vite-process CPU sample only; no baseline, GPU or production performance qualification",
    before,
    after,
    wallMs,
    cpuMs,
    corePercent: (cpuMs / wallMs) * 100,
  };
}

async function realClientCycle(production, iteration) {
  assert.equal(process.env.HYPERIA_RECOVERY_NO_MATERIALIZE, "1");
  const nodePath = process.versions.bun
    ? process.env.HYPERIA_TEST_NODE_PATH
    : process.execPath;
  assert(
    nodePath && path.isAbsolute(nodePath),
    "Bun parent requires an explicit actual Node executable",
  );
  if (!process.versions.bun) assertHyperiaNodeVersion(process.version);
  if (production) {
    for (const file of ["index.html", "stream.html"])
      assert(
        existsSync(path.join(clientRoot, "dist", file)) &&
          readFileSync(path.join(clientRoot, "dist", file)).length > 0,
        `Actual production client dist/${file} is required; build the client before running preview lifecycle tests. This test does not fabricate or modify dist.`,
      );
  }
  const directory = mkdtempSync(path.join(tmpdir(), "hyperia-vite-owner-"));
  const witnessPath = path.join(directory, "runtime-witness.mjs");
  writeFileSync(witnessPath, preload, { flag: "wx" });
  const fixtureName = `duel-client-lifecycle-${process.pid}-${randomUUID()}.js`;
  const fixturePath = path.join(sourceRoot, fixtureName);
  const fixtureBody = (revision) =>
    `export const lifecycleRevision = ${revision};\nif (import.meta.hot) import.meta.hot.accept();\n`;
  let fixtureOwned = false;
  let proc;
  let socket;
  let port;
  let closed = false;
  let childError = null;
  let result;
  let output = "";
  let fixtureTransform = null;
  const hmrPayloads = [];
  let cleanupForcedKill = false;
  let shutdownReceipt = null;
  const errors = [];
  const startedAt = new Date().toISOString();
  try {
    if (!production) {
      writeFileSync(fixturePath, fixtureBody(0), { flag: "wx" });
      fixtureOwned = true;
    }
    port = await ownEphemeralPort();
    const environment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/SECRET|PASSWORD|TOKEN|PRIVATE|CREDENTIAL|API_KEY|DATABASE_URL|RPC_URL|SOLANA|NODE_OPTIONS|BUN_OPTIONS|CHOKIDAR_|HYPERIA_VITE_POLLING/.test(
              key,
            ),
        ),
      ),
      // The duel launcher defaults to production NODE_ENV even for Vite dev.
      NODE_ENV: "production",
      HYPERIA_VITE_POLLING: production ? "false" : "true",
      E2E_DISABLE_SHARED_WATCH: "false",
      PLAYWRIGHT_TEST: "false",
      VITE_FORCE_OPTIMIZE_DEPS: "false",
      ...(!production
        ? { DEBUG: [process.env.DEBUG, "vite:hmr"].filter(Boolean).join(",") }
        : {}),
      NODE_OPTIONS: [`--import=${pathToFileURL(witnessPath).href}`]
        .filter(Boolean)
        .join(" "),
    };
    const command = resolveDuelClientCommand({
      workspaceRoot,
      nodePath,
      port,
      production,
      environment,
    });
    assert.equal(realpathSync(command.command), realpathSync(nodePath));
    assert.equal(realpathSync(command.opts.cwd), realpathSync(clientRoot));
    assert.equal(
      command.opts.env,
      environment,
      "Actual launch environment owner",
    );
    assert.deepEqual(command.args.slice(1), [
      ...(production ? ["preview"] : []),
      "--host",
      "--port",
      String(port),
      ...(production ? [] : ["--strictPort"]),
    ]);
    assert.equal(
      realpathSync(command.args[0]),
      realpathSync(path.join(clientRoot, "node_modules/vite/bin/vite.js")),
    );
    const messages = [];
    proc = spawn(command.command, command.args, {
      ...command.opts,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("error", (error) => {
      childError = error;
    });
    proc.once("close", () => {
      closed = true;
    });
    for (const stream of [proc.stdout, proc.stderr]) {
      let pending = "";
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-65_536);
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines)
          if (line.startsWith("CLIENT_LIFECYCLE_WITNESS ")) {
            try {
              assert(messages.length < 8, "Bounded actual runtime witnesses");
              messages.push(
                JSON.parse(line.slice("CLIENT_LIFECYCLE_WITNESS ".length)),
              );
            } catch (error) {
              childError = error;
            }
          }
      });
    }
    const checkLive = () => {
      if (childError) throw childError;
      assert.equal(
        proc.exitCode,
        null,
        "Vite exited before requested shutdown",
      );
      assert.equal(proc.signalCode, null);
      assert(!closed);
    };
    const witness = await waitFor(() => {
      checkLive();
      return messages.find(
        (message) => message.event === "actual-vite-runtime",
      );
    }, "actual directly owned Vite runtime");
    assert.equal(witness.pid, proc.pid, "Managed PID must itself execute Vite");
    assert.equal(witness.ppid, process.pid);
    assert.equal(witness.bun, null);
    assertHyperiaNodeVersion(witness.version);
    assert.equal(witness.executable, realpathSync(nodePath));
    assert.equal(witness.cwd, realpathSync(clientRoot));
    assert.equal(witness.entrypoint, realpathSync(command.args[0]));
    assert.deepEqual(witness.arguments, command.args.slice(1));
    const origin = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        checkLive();
        if (!output.includes(`:${port}/`)) return false;
        try {
          const response = await fetch(origin + "/stream.html", {
            signal: AbortSignal.timeout(1000),
          });
          await response.arrayBuffer();
          return response.status === 200;
        } catch (error) {
          if (
            error.name === "TimeoutError" ||
            error.cause?.code === "ECONNREFUSED"
          )
            return false;
          throw error;
        }
      },
      "real client HTTP readiness",
      30_000,
    );
    const html = await responseText(origin + "/stream.html");
    let hmrUpdated = false;
    let socketClosed = false;
    let graph = null;
    let idleCpu = null;
    if (!production) {
      assert.match(html, /stream\.tsx/u);
      const streamSource = await responseText(origin + "/stream.tsx");
      assert.match(streamSource, /import/u);
      const clientSource = await responseText(origin + "/@vite/client");
      graph = await loadActualClientGraph(origin, command.args[0]);
      {
        const watcher = messages.find(
          (message) => message.event === "actual-vite-watcher",
        );
        assert(watcher, "Observe the actual constructed Vite watcher");
        assert.equal(watcher.useFsEvents, false);
        assert.equal(watcher.usePolling, true);
        assert.equal(watcher.interval, 1000);
        assert.equal(watcher.binaryInterval, 1000);
      }
      const token = clientSource.match(
        /const\s+wsToken\s*=\s*["']([^"']+)["']/u,
      )?.[1];
      assert(token, "Use the real served HMR token, not a fabricated socket");
      const socketErrors = [];
      const payloads = hmrPayloads;
      socket = new WebSocket(
        `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
        "vite-hmr",
      );
      socket.on("error", (error) => socketErrors.push(error.message));
      socket.once("close", () => {
        socketClosed = true;
      });
      socket.on("message", (data) => {
        try {
          assert(payloads.length < 64, "Bounded actual HMR payload count");
          payloads.push(JSON.parse(data.toString()));
        } catch (error) {
          socketErrors.push(error.message);
        }
      });
      await waitFor(() => {
        checkLive();
        assert.deepEqual(socketErrors, []);
        return payloads.some((payload) => payload.type === "connected");
      }, "real Vite HMR connection");
      const fixtureResponse = await responseText(origin + "/" + fixtureName);
      fixtureTransform = fixtureResponse.slice(0, 8192);
      assert.match(fixtureResponse, /lifecycleRevision\s*=\s*0/u);
      assert.match(fixtureResponse, /import\.meta\.hot/u);
      assert.match(
        fixtureResponse,
        /createHotContext/u,
        "The fixture must be analyzed and instrumented by actual Vite, not served raw",
      );
      writeFileSync(fixturePath, fixtureBody(1)); // This test's exclusive source only.
      await waitFor(() => {
        checkLive();
        assert.deepEqual(socketErrors, []);
        return payloads.some(
          (payload) =>
            payload.type === "update" &&
            payload.updates?.some(
              (update) =>
                update.path === "/" + fixtureName ||
                update.acceptedPath === "/" + fixtureName,
            ),
        );
      }, "actual owned source update delivered over HMR");
      const updated = await responseText(
        origin + "/" + fixtureName + "?t=" + Date.now(),
      );
      assert.match(updated, /lifecycleRevision\s*=\s*1/u);
      assert.equal(
        socket.readyState,
        WebSocket.OPEN,
        "HMR stays live through shutdown",
      );
      hmrUpdated = true;
      if (
        iteration === 1 &&
        !process.versions.bun &&
        process.platform === "darwin"
      )
        idleCpu = await sampleOwnedIdleCpu(proc.pid);
    } else {
      const scripts = [
        ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gu),
      ].map((match) => match[1]);
      const bundle = scripts.find((src) =>
        /^\/?assets\/[^?#]+\.js$/u.test(src),
      );
      assert(bundle, "Actual production stream bundle must be referenced");
      const bundleUrl = new URL(bundle, origin + "/stream.html");
      assert.equal(bundleUrl.origin, origin);
      assert((await responseText(bundleUrl.href)).length > 100);
    }
    // Production defaults: no timeout override, fake ACK or relaxed forced-kill rule.
    shutdownReceipt = await shutdownDuelStackChildren({
      entries: [{ name: "game-client", proc }],
    });
    const shutdown = shutdownReceipt;
    await waitFor(() => closed, "actual Vite ChildProcess close", 2000);
    assertCleanClientShutdown(shutdown, witness.pid);
    if (!production) {
      const calls = messages.find(
        (message) => message.event === "actual-watch-calls",
      );
      assert(
        calls && calls.watchFile > 0,
        "Actual fs.watchFile polling is exercised",
      );
      assert.equal(calls.watch, 0, "No blocking native event watcher remains");
    }
    assert.equal(groupAlive(proc), false);
    if (!production)
      await waitFor(
        () => socketClosed,
        "Vite closed the real HMR socket",
        2000,
      );
    await assertPortClear(port);
    result = {
      production,
      iteration,
      pid: proc.pid,
      port,
      witness,
      parentRuntime: {
        node: process.version,
        bun: process.versions.bun ?? null,
      },
      watcherWitnesses: messages.filter(
        (message) => message.event !== "actual-vite-runtime",
      ),
      graph,
      idleCpu,
      hmrUpdated,
      shutdown,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  } catch (error) {
    errors.push(error);
  } finally {
    // Preserve a failed HMR assertion while independently observing the real
    // orderly-stop path. Emergency cleanup below cannot waive either failure.
    if (proc?.pid && !shutdownReceipt) {
      try {
        shutdownReceipt = await shutdownDuelStackChildren({
          entries: [{ name: "game-client", proc }],
        });
        await waitFor(() => closed, "failed-test Vite close", 2000);
        assertCleanClientShutdown(shutdownReceipt, proc.pid);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (proc?.pid && groupAlive(proc)) {
        cleanupForcedKill = true;
        process.kill(-proc.pid, "SIGKILL");
      }
      if (proc?.pid) {
        await waitFor(
          () => closed && !groupAlive(proc),
          "test-owned Vite teardown",
          3000,
        );
        if (port) await assertPortClear(port);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (fixtureOwned) {
        assert(lstatSync(fixturePath).isFile());
        assert(
          [fixtureBody(0), fixtureBody(1)].includes(
            readFileSync(fixturePath, "utf8"),
          ),
          "Never delete an externally changed fixture",
        );
        rmSync(fixturePath);
      }
      assert(path.basename(directory).startsWith("hyperia-vite-owner-"));
      rmSync(directory, { recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    // Node's TAP printer omits AggregateError.errors; retain bounded evidence.
    console.error(
      JSON.stringify({
        event: "client-lifecycle-failure",
        production,
        iteration,
        pid: proc?.pid,
        port,
        closed,
        exitCode: proc?.exitCode,
        signal: proc?.signalCode,
        cleanupForcedKill,
        shutdownReceipt,
        startedAt,
        endedAt: new Date().toISOString(),
        errors: errors.map((error) => ({
          message: error.message,
          stack: error.stack?.slice(0, 4096),
        })),
        hmrPayloads,
        fixtureTransform,
        viteOutput: output.slice(-8192),
      }),
    );
    throw new AggregateError(
      errors,
      "Actual Vite lifecycle failed; cleanup cannot turn failure into success: " +
        errors.map((error) => error.message).join("; "),
    );
  }
  return result;
}

// Exercise the identical assertions under the launcher's Bun parent without
// relying on Bun's separate node:test adapter. This is not a production mode.
if (process.argv.includes("--owned-client-probe")) {
  assert(process.versions.bun, "The standalone owner probe targets Bun");
  console.log(JSON.stringify(await realClientCycle(false, 1)));
} else {
  const cycleCount = 3;
  for (const production of [false, true]) {
    test(
      `real direct Vite ${production ? "preview" : "dev"} owner completes ${cycleCount} loaded shutdown cycles`,
      { timeout: 360_000 },
      async (t) => {
        assert.notEqual(
          process.platform,
          "win32",
          "These exact process-group regressions require POSIX",
        );
        for (let iteration = 1; iteration <= cycleCount; iteration++)
          t.diagnostic(
            JSON.stringify(await realClientCycle(production, iteration)),
          );
      },
    );
  }

  test("deployed launcher uses the resolved direct client owner for dev and preview", () => {
    const source = readFileSync(
      path.join(workspaceRoot, "scripts/duel-stack.mjs"),
      "utf8",
    );
    const declarations = [
      ...source.matchAll(/const\s+(\w+)\s*=\s*resolveDuelClientCommand\s*\(/gu),
    ];
    assert(
      declarations.length > 0,
      "Actual launcher must call the tested resolver",
    );
    for (const [, variable] of declarations) {
      const directSpawn = new RegExp(
        `spawnManaged\\(\\s*"game-client",\\s*${variable}\\.command,\\s*${variable}\\.args,\\s*${variable}\\.opts,?\\s*\\)`,
        "u",
      );
      assert.match(
        source,
        directSpawn,
        "Only the exact resolved command/args/options may own Vite",
      );
    }
    const clientRegion = source.slice(
      source.indexOf("if (!clientWasReady) {"),
      source.indexOf("await waitForHttp(gameServerHealthUrl"),
    );
    assert(clientRegion.includes("resolveDuelClientCommand"));
    assert.doesNotMatch(
      clientRegion,
      /spawnManaged\(\s*"game-client",\s*gameBunPath/u,
    );
    assert.match(clientRegion, /production:\s*useProductionBuild/u);
    assert.match(clientRegion, /environment:\s*gameEnv/u);
    assert.match(clientRegion, /nodePath:/u);
    assert.match(
      clientRegion,
      /writeClientRuntimeEnv/u,
      "Preview runtime-env installation is retained",
    );
    assert.match(
      clientRegion,
      /reuse-game-builds/u,
      "Existing build/reuse authority is retained",
    );
  });
}
