import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { assertHyperiaNodeVersion } from "./node-runtime-policy.mjs";

const clientConfig = new URL(
  "../packages/client/playwright.config.ts",
  import.meta.url,
);
const serverDirectory = fileURLToPath(
  new URL("../packages/server/", import.meta.url),
);
const require = createRequire(clientConfig);
const ts = require("typescript");
const nativeOnly = { skip: process.platform !== "darwin" };

/** Evaluate the actual config with real Playwright, without starting its services. */
function movementServerConfig() {
  const source = readFileSync(clientConfig, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  new Script(compiled.outputText, {
    filename: fileURLToPath(clientConfig),
  }).runInNewContext({
    require,
    module,
    exports: module.exports,
    process: {
      platform: process.platform,
      versions: process.versions,
      execPath: process.execPath,
      env: {
        PW_NATIVE_MOVEMENT: "true",
        POSTGRES_CONTAINER: `hyperia-native-movement-bootstrap-${process.pid}`,
      },
    },
  });
  return module.exports.default.webServer[0];
}

function runEntry(
  server,
  {
    env = {},
    cwd = serverDirectory,
    prefix = "",
    command = server.command,
  } = {},
) {
  return spawnSync("/bin/sh", ["-c", `${prefix}${command} --preflight-only`], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...server.env,
      PW_NATIVE_MOVEMENT: "true",
      POSTGRES_USER: "hyperia_native_bootstrap_test",
      POSTGRES_PASSWORD: "local-unused-preflight-only",
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
}

test(
  "actual native command and hooks admit a real file Worker, then only verify the server build",
  nativeOnly,
  (t) => {
    assertHyperiaNodeVersion(process.version);
    const server = movementServerConfig();
    const directory = mkdtempSync(
      path.join(tmpdir(), "hyperia-native-worker-regression-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const probe = path.join(directory, "worker-probe.mjs");
    writeFileSync(
      path.join(directory, "worker.mjs"),
      'import { parentPort } from "node:worker_threads"; parentPort.postMessage(process.execArgv);',
    );
    writeFileSync(
      probe,
      `
    import assert from "node:assert/strict";
    import { Worker, isMainThread } from "node:worker_threads";
    if (isMainThread) {
      const worker = new Worker(new URL("./worker.mjs", import.meta.url));
      let observed = false;
      await new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", argv => {
          try {
            assert.deepEqual(argv, process.execArgv);
            assert(!argv.some(value => value.startsWith("--input-type")));
            assert(argv.includes("./scripts/register-hooks.mjs"));
            observed = true;
          } catch (error) { reject(error); }
        });
        worker.once("exit", code => code === 0 && observed ? resolve() : reject(Error("Actual file Worker failed")));
      });
      console.log(JSON.stringify({ event: "native-file-worker-probe", inheritedExact: true, code: 0 }));
    }
  `,
    );
    // NODE_OPTIONS adds an observation-only preloader to the exact config command.
    // It never replaces execArgv or configures the Worker's inherited options.
    const result = runEntry(server, {
      env: { NODE_OPTIONS: `--import=${probe}` },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /"event":"native-file-worker-probe","inheritedExact":true,"code":0/,
    );
    assert.match(result.stdout, /"event":"native-movement-server-owner"/);
    assert.match(
      result.stdout,
      /Competitive server build [a-f0-9]{12} verified before gameplay import/,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /ERR_INPUT_TYPE_NOT_ALLOWED/,
    );
    // An actual Docker read verifies the positive preflight created no database.
    assert.equal(
      execFileSync(
        "docker",
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${server.env.POSTGRES_CONTAINER}$`,
          "--format",
          "{{.ID}}",
        ],
        { encoding: "utf8", timeout: 5000 },
      ).trim(),
      "",
    );

    const historical = server.command.replace(
      "../../scripts/native-movement-server.mjs",
      '--input-type=module -e "" --',
    );
    const negative = runEntry(server, {
      command: historical,
      env: { NODE_OPTIONS: `--import=${probe}` },
    });
    assert.equal(negative.error, undefined);
    assert.equal(negative.signal, null);
    assert.equal(negative.status, 1);
    assert.match(negative.stderr, /ERR_INPUT_TYPE_NOT_ALLOWED/);
    assert.doesNotMatch(
      negative.stdout,
      /native-movement-server-owner|Competitive server build/,
    );
  },
);

test(
  "actual native entry rejects every occupied owned port before bootstrap",
  nativeOnly,
  async () => {
    const server = movementServerConfig();
    for (const port of [3333, 5555, 5556, 57832]) {
      const blocker = createServer();
      await new Promise((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen({ port, exclusive: true }, resolve);
      });
      try {
        const result = runEntry(server);
        assert.equal(result.status, 1, `occupied ${port}`);
        assert.equal(result.signal, null);
        assert.match(result.stderr, /EADDRINUSE/);
        assert.doesNotMatch(
          result.stdout,
          /native-movement-server-owner|Competitive server build/,
        );
      } finally {
        await new Promise((resolve, reject) =>
          blocker.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);

test(
  "actual native entry rejects missing opt-in, unsafe container and wrong cwd",
  nativeOnly,
  () => {
    const server = movementServerConfig();
    for (const [options, reason] of [
      [{ env: { PW_NATIVE_MOVEMENT: "false" } }, /explicit macOS project/],
      [
        { env: { POSTGRES_CONTAINER: "personal-database" } },
        /unique POSTGRES_CONTAINER/,
      ],
      [
        {
          cwd: path.dirname(serverDirectory),
          command: server.command
            .replace(
              "./scripts/register-hooks.mjs",
              "./server/scripts/register-hooks.mjs",
            )
            .replace(
              "../../scripts/native-movement-server.mjs",
              "../scripts/native-movement-server.mjs",
            ),
        },
        /packages\/server cwd/,
      ],
    ]) {
      const result = runEntry(server, options);
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      assert.match(result.stderr, reason);
      assert.doesNotMatch(
        result.stdout,
        /native-movement-server-owner|Competitive server build/,
      );
    }
  },
);
