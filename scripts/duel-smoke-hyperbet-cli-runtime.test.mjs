import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDuelSmokeHyperbetCliInvocation } from "./duel-smoke-hyperbet-cli-runtime.mjs";

const hyperbetBun = requireRealBun("DUEL_HYPERBET_BUN_PATH", "1.3.6");
const gameBun = requireRealBun("DUEL_HYPERIA_BUN_PATH", "1.3.14");

function requireRealBun(variableName, expectedVersion) {
  const executable = process.env[variableName]?.trim();
  try {
    assert.ok(executable && path.isAbsolute(executable));
    assert.equal(
      execFileSync(executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
      expectedVersion,
    );
    return executable;
  } catch (error) {
    throw new Error(
      `Runtime proof requires real Bun ${expectedVersion}; configure ${variableName} to its absolute executable`,
      { cause: error },
    );
  }
}

function withWorkspace(run) {
  const workspaceRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-hyperbet-cli-"),
  );
  const scriptDirectory = path.join(workspaceRoot, "keeper", "src");
  mkdirSync(scriptDirectory, { recursive: true });
  const scriptPath = path.join(scriptDirectory, "runtime.ts");
  writeFileSync(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ type: "module", packageManager: "bun@1.3.6" }),
  );
  writeFileSync(
    scriptPath,
    "console.log(JSON.stringify({version:Bun.version,execPath:process.execPath,args:process.argv.slice(2),marker:process.env.RUNTIME_TEST_MARKER ?? null}));\n",
  );
  try {
    run({ workspaceRoot, scriptPath });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function childOptions(workspaceRoot, env) {
  return {
    cwd: workspaceRoot,
    env,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  };
}

test("real Hyperbet pin defeats game PATH and bypasses an active ancestor bunfig preload", () => {
  withWorkspace(({ workspaceRoot, scriptPath }) => {
    const markerPath = path.join(workspaceRoot, "preload-executed.txt");
    const preloadPath = path.join(workspaceRoot, "hostile-preload.ts");
    writeFileSync(
      preloadPath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "executed"); throw new Error("HOSTILE_PARENT_BUNFIG_PRELOAD");\n`,
    );
    writeFileSync(
      path.join(workspaceRoot, "bunfig.toml"),
      `preload = [${JSON.stringify(preloadPath)}]\n`,
    );
    const environment = {
      PATH: [
        path.dirname(gameBun),
        path.dirname(hyperbetBun),
        "/usr/bin",
        "/bin",
      ].join(path.delimiter),
      DUEL_HYPERBET_BUN_PATH: hyperbetBun,
      RUNTIME_TEST_MARKER: "preserved",
    };
    const originalEnvironment = { ...environment };
    const originalArgs = [scriptPath, "list", "--status", "SUCCEEDED"];
    const unpinned = JSON.parse(
      execFileSync(
        "bun",
        ["--config=/dev/null", "--no-install", scriptPath],
        childOptions(workspaceRoot, environment),
      ),
    );
    assert.equal(
      unpinned.version,
      "1.3.14",
      "negative control must expose inherited game Bun",
    );
    assert.equal(realpathSync(unpinned.execPath), realpathSync(gameBun));
    assert.throws(
      () =>
        execFileSync(
          hyperbetBun,
          ["--no-install", scriptPath],
          childOptions(workspaceRoot, environment),
        ),
      (error) => {
        assert.match(String(error.stderr), /HOSTILE_PARENT_BUNFIG_PRELOAD/u);
        return true;
      },
    );
    assert.equal(readFileSync(markerPath, "utf8"), "executed");
    rmSync(markerPath);

    const invocation = buildDuelSmokeHyperbetCliInvocation({
      workspaceRoot,
      args: originalArgs,
      environment,
    });
    assert.equal(invocation.command, hyperbetBun);
    assert.deepEqual(invocation.args, [
      "--config=/dev/null",
      "--no-install",
      ...originalArgs,
    ]);
    assert.equal(
      invocation.env.PATH.split(path.delimiter)[0],
      path.dirname(hyperbetBun),
    );
    assert.deepEqual(environment, originalEnvironment);
    assert.deepEqual(originalArgs, [
      scriptPath,
      "list",
      "--status",
      "SUCCEEDED",
    ]);
    assert.notEqual(invocation.env, environment);
    const result = JSON.parse(
      execFileSync(
        invocation.command,
        invocation.args,
        childOptions(workspaceRoot, invocation.env),
      ),
    );
    assert.equal(result.version, "1.3.6");
    assert.equal(realpathSync(result.execPath), realpathSync(hyperbetBun));
    assert.equal(result.marker, "preserved");
    assert.deepEqual(result.args, ["list", "--status", "SUCCEEDED"]);
    assert.equal(
      existsSync(markerPath),
      false,
      "hostile configuration must not execute",
    );
    assert.equal(existsSync(path.join(workspaceRoot, "node_modules")), false);
    assert.equal(existsSync(path.join(workspaceRoot, "bun.lock")), false);
  });
});

test("rejects the actual wrong-version configured runtime without fallback", () => {
  withWorkspace(({ workspaceRoot, scriptPath }) => {
    assert.throws(
      () =>
        buildDuelSmokeHyperbetCliInvocation({
          workspaceRoot,
          args: [scriptPath],
          environment: {
            DUEL_HYPERBET_BUN_PATH: gameBun,
            PATH: path.dirname(hyperbetBun),
          },
        }),
      /Hyperbet requires Bun 1\.3\.6/u,
    );
  });
});

test("the real CLI rejects a missing dependency without materializing an install", () => {
  withWorkspace(({ workspaceRoot, scriptPath }) => {
    writeFileSync(
      scriptPath,
      'import "@hyperia-smoke/no-install-proof-missing";\n',
    );
    const invocation = buildDuelSmokeHyperbetCliInvocation({
      workspaceRoot,
      args: [scriptPath],
      environment: {
        DUEL_HYPERBET_BUN_PATH: hyperbetBun,
        PATH: "/usr/bin:/bin",
      },
    });
    assert.throws(
      () =>
        execFileSync(
          invocation.command,
          invocation.args,
          childOptions(workspaceRoot, invocation.env),
        ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(
          String(error.stderr),
          /Cannot find module '@hyperia-smoke\/no-install-proof-missing'/u,
        );
        return true;
      },
    );
    assert.equal(existsSync(path.join(workspaceRoot, "node_modules")), false);
    assert.equal(existsSync(path.join(workspaceRoot, "bun.lock")), false);
    assert.equal(existsSync(path.join(workspaceRoot, "bun.lockb")), false);
  });
});

test("rejects an unavailable configured runtime without fallback", () => {
  withWorkspace(({ workspaceRoot, scriptPath }) => {
    assert.throws(
      () =>
        buildDuelSmokeHyperbetCliInvocation({
          workspaceRoot,
          args: [scriptPath],
          environment: {
            DUEL_HYPERBET_BUN_PATH: path.join(workspaceRoot, "missing-bun"),
            PATH: path.dirname(hyperbetBun),
          },
        }),
      /Hyperbet requires Bun 1\.3\.6/u,
    );
  });
});

test("reads and rejects an invalid workspace pin before invoking a runtime", () => {
  withWorkspace(({ workspaceRoot, scriptPath }) => {
    writeFileSync(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({ packageManager: "bun@^1.3.6" }),
    );
    assert.throws(
      () =>
        buildDuelSmokeHyperbetCliInvocation({
          workspaceRoot,
          args: [scriptPath],
          environment: { DUEL_HYPERBET_BUN_PATH: hyperbetBun },
        }),
      /must declare one exact packageManager bun version/u,
    );
  });
});

test("rejects implicit runtime selection and malformed script invocation", () => {
  withWorkspace(({ workspaceRoot, scriptPath }) => {
    const valid = {
      workspaceRoot,
      args: [scriptPath],
      environment: { DUEL_HYPERBET_BUN_PATH: hyperbetBun },
    };
    for (const configuredPath of [undefined, "", " ", "bun", "bun\0bad", 42]) {
      assert.throws(
        () =>
          buildDuelSmokeHyperbetCliInvocation({
            ...valid,
            environment: { DUEL_HYPERBET_BUN_PATH: configuredPath },
          }),
        /explicit DUEL_HYPERBET_BUN_PATH/u,
      );
    }
    for (const args of [
      undefined,
      [],
      ["--eval", "1"],
      ["relative.ts"],
      [scriptPath, 42],
      [scriptPath, "nul\0value"],
    ]) {
      assert.throws(
        () => buildDuelSmokeHyperbetCliInvocation({ ...valid, args }),
        /absolute script path/u,
      );
    }
    for (const args of [
      [workspaceRoot],
      [path.join(workspaceRoot, "..", "outside.ts")],
    ]) {
      assert.throws(
        () => buildDuelSmokeHyperbetCliInvocation({ ...valid, args }),
        /inside its workspace/u,
      );
    }
    for (const invalidRoot of [undefined, "relative", "", "/nul\0root"]) {
      assert.throws(
        () =>
          buildDuelSmokeHyperbetCliInvocation({
            ...valid,
            workspaceRoot: invalidRoot,
          }),
        /absolute path/u,
      );
    }
  });
});

test("the smoke's terminal and dispute collectors use the guarded Hyperbet invocation", () => {
  const source = readFileSync(
    new URL("./smoke-duel-launch.mjs", import.meta.url),
    "utf8",
  );
  const terminal = source.slice(
    source.indexOf("async function readTerminalSuccess("),
    source.indexOf("async function readProgramAccount("),
  );
  const collectorStart = source.indexOf(
    "async function captureDuelDisputeEvidence(",
  );
  const collector = source.slice(
    collectorStart,
    source.indexOf("\nasync function ", collectorStart + 1),
  );
  for (const [body, invocationName] of [
    [terminal, "invocation"],
    [collector, "collectorInvocation"],
  ]) {
    assert.match(body, /buildDuelSmokeHyperbetCliInvocation\(\{/u);
    assert.match(body, /workspaceRoot: workspace\.root/u);
    assert.match(
      body,
      new RegExp(
        `runBoundedChildCommand\\(\\s*${invocationName}\\.command,\\s*${invocationName}\\.args,`,
        "u",
      ),
    );
    assert.match(body, new RegExp(`env: ${invocationName}\\.env`, "u"));
    assert.doesNotMatch(
      body,
      /(?:execFileAsync|runBoundedChildCommand)\(\s*"bun"/u,
    );
  }
});
