import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindPinnedBunToEnvironment,
  parsePinnedBunVersion,
  resolvePinnedBunRuntime,
} from "./duel-bun-runtime-policy.mjs";

const launcherSource = readFileSync(
  new URL("./duel-stack.mjs", import.meta.url),
  "utf8",
);
const productionSource = readFileSync(
  new URL("../ecosystem.config.cjs", import.meta.url),
  "utf8",
);
const policyUrl = new URL("./duel-bun-runtime-policy.mjs", import.meta.url)
  .href;
const gameBun = requireRealBun("DUEL_HYPERIA_BUN_PATH", "1.3.14");
const hyperbetBun = requireRealBun("DUEL_HYPERBET_BUN_PATH", "1.3.6");

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

function runPolicySubprocess(workspaceRoot, cwd, environment, body) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { execFileSync } from "node:child_process";
         import { resolvePinnedBunRuntime, bindPinnedBunToEnvironment } from ${JSON.stringify(policyUrl)};
         const workspaceRoot = ${JSON.stringify(workspaceRoot)};
         const version = (command, env) => execFileSync(command, ["--version"], { env, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
         ${body}`,
      ],
      {
        cwd,
        env: { ...process.env, ...environment },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

function withWorkspace(packageManager, run) {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "hyperia-bun-policy-"));
  try {
    writeFileSync(
      path.join(workspaceRoot, "package.json"),
      `${JSON.stringify({ packageManager })}\n`,
    );
    run(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test("accepts only an exact Bun package-manager version", () => {
  assert.equal(parsePinnedBunVersion("bun@1.3.14", "Hyperia"), "1.3.14");
  assert.throws(
    () => parsePinnedBunVersion("bun@>=1.3.14", "Hyperia"),
    /must declare one exact packageManager bun version/u,
  );
  assert.throws(
    () => parsePinnedBunVersion(undefined, "Hyperia"),
    /must declare one exact packageManager bun version/u,
  );
});

test("PATH-selected real Bun remains bound after another installed Bun shadows PATH", () => {
  for (const [selected, shadow, expectedVersion, shadowVersion] of [
    [gameBun, hyperbetBun, "1.3.14", "1.3.6"],
    [hyperbetBun, gameBun, "1.3.6", "1.3.14"],
  ]) {
    withWorkspace(`bun@${expectedVersion}`, (workspaceRoot) => {
      const result = runPolicySubprocess(
        workspaceRoot,
        workspaceRoot,
        { PATH: path.dirname(selected) },
        `const runtime = resolvePinnedBunRuntime({ label: "PATH proof", workspaceRoot, processPath: "" });
         const poisoned = { ...process.env, PATH: ${JSON.stringify(path.dirname(shadow))} };
         console.log(JSON.stringify({ runtime, shadowVersion: version("bun", poisoned), directVersion: version(runtime.path, poisoned), nestedVersion: version("bun", bindPinnedBunToEnvironment(poisoned, runtime.path)) }));`,
      );
      assert.equal(result.shadowVersion, shadowVersion);
      assert.equal(result.directVersion, expectedVersion);
      assert.equal(result.nestedVersion, expectedVersion);
      assert.equal(result.runtime.path, selected);
      assert.equal(path.isAbsolute(result.runtime.path), true);
    });
  }
});

test("relative and empty PATH entries resolve against subprocess cwd, not workspace", () => {
  withWorkspace("bun@1.3.14", (workspaceRoot) => {
    const cwd = path.join(workspaceRoot, "working");
    const bin = path.join(cwd, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(gameBun, path.join(cwd, "bun"));
    symlinkSync(gameBun, path.join(bin, "bun"));
    for (const searchPath of [
      "",
      ".",
      "bin",
      `${path.delimiter}${path.dirname(hyperbetBun)}`,
    ]) {
      const result = runPolicySubprocess(
        workspaceRoot,
        cwd,
        { PATH: searchPath },
        `const runtime = resolvePinnedBunRuntime({ label: "cwd proof", workspaceRoot, processPath: "" });
         console.log(JSON.stringify({ runtime, version: version(runtime.path, { ...process.env, PATH: ${JSON.stringify(path.dirname(hyperbetBun))} }) }));`,
      );
      assert.equal(
        result.runtime.path,
        path.join(realpathSync(searchPath === "bin" ? bin : cwd), "bun"),
      );
      assert.equal(result.version, "1.3.14");
    }
  });
});

test("PATH lookup skips missing and directory entries but never skips a wrong-version executable", () => {
  withWorkspace("bun@1.3.14", (workspaceRoot) => {
    const blockedDirectory = path.join(workspaceRoot, "not-an-executable");
    mkdirSync(path.join(blockedDirectory, "bun"), { recursive: true });
    const result = runPolicySubprocess(
      workspaceRoot,
      workspaceRoot,
      {
        PATH: [
          path.join(workspaceRoot, "missing"),
          blockedDirectory,
          path.dirname(gameBun),
        ].join(path.delimiter),
      },
      `console.log(JSON.stringify(resolvePinnedBunRuntime({ label: "PATH entry proof", workspaceRoot, processPath: "" })));`,
    );
    assert.equal(result.path, gameBun);
    const mismatch = runPolicySubprocess(
      workspaceRoot,
      workspaceRoot,
      {
        PATH: [path.dirname(hyperbetBun), path.dirname(gameBun)].join(
          path.delimiter,
        ),
      },
      `try { resolvePinnedBunRuntime({ label: "PATH mismatch proof", workspaceRoot, processPath: "" }); console.log(JSON.stringify({ rejected: false })); }
       catch (error) { console.log(JSON.stringify({ rejected: true, error: error.message })); }`,
    );
    assert.equal(mismatch.rejected, true);
    assert.match(mismatch.error, /requires Bun 1\.3\.14/u);
    assert.match(mismatch.error, /bun=1\.3\.6/u);
  });
});

test("an explicit absolute runtime alias wins over a different PATH runtime", () => {
  withWorkspace("bun@1.3.6", (workspaceRoot) => {
    const result = runPolicySubprocess(
      workspaceRoot,
      workspaceRoot,
      { PATH: path.dirname(gameBun) },
      `const runtime = resolvePinnedBunRuntime({ label: "override proof", workspaceRoot, configuredPath: ${JSON.stringify(hyperbetBun)}, processPath: "" });
       console.log(JSON.stringify({ runtime, directVersion: version(runtime.path, process.env), nestedVersion: version("bun", bindPinnedBunToEnvironment(process.env, runtime.path)) }));`,
    );
    assert.equal(result.runtime.path, hyperbetBun);
    assert.equal(result.directVersion, "1.3.6");
    assert.equal(result.nestedVersion, "1.3.6");
  });
});

test("selects the first candidate with the workspace's exact version", () => {
  withWorkspace("bun@1.3.14", (workspaceRoot) => {
    const result = resolvePinnedBunRuntime({
      label: "Hyperia",
      workspaceRoot,
      configuredPath: hyperbetBun,
      processPath: gameBun,
      pathCommand: "",
    });

    assert.deepEqual(result, {
      path: gameBun,
      version: "1.3.14",
      expectedVersion: "1.3.14",
    });
    assert.equal(
      resolvePinnedBunRuntime({
        label: "Hyperia",
        workspaceRoot,
        configuredPath: gameBun,
        processPath: hyperbetBun,
        pathCommand: "",
      }).path,
      gameBun,
    );
  });
});

test("resolves a configured relative executable from its workspace", () => {
  withWorkspace("bun@1.3.6", (workspaceRoot) => {
    mkdirSync(path.join(workspaceRoot, ".runtime"));
    symlinkSync(hyperbetBun, path.join(workspaceRoot, ".runtime", "bun"));
    const result = resolvePinnedBunRuntime({
      label: "Hyperbet",
      workspaceRoot,
      configuredPath: ".runtime/bun",
      processPath: gameBun,
    });

    assert.equal(result.path, path.join(workspaceRoot, ".runtime/bun"));
  });
});

test("binds nested package scripts to the selected absolute Bun runtime", () => {
  const selectedDirectory = path.dirname(gameBun);
  const oldDirectory = path.dirname(hyperbetBun);
  const environment = bindPinnedBunToEnvironment(
    { PATH: [oldDirectory, selectedDirectory].join(path.delimiter) },
    gameBun,
  );

  assert.equal(
    environment.PATH,
    [selectedDirectory, oldDirectory].join(path.delimiter),
  );
});

test("keeps the environment helper non-mutating for legacy non-absolute input", () => {
  const environment = { PATH: "/usr/local/bin" };
  assert.deepEqual(bindPinnedBunToEnvironment(environment, "bun"), environment);
  assert.notEqual(bindPinnedBunToEnvironment(environment, "bun"), environment);
});

test("fails closed and reports every mismatched candidate", () => {
  withWorkspace("bun@1.3.14", (workspaceRoot) => {
    const missingRuntime = path.join(workspaceRoot, "missing-bun");
    assert.throws(
      () =>
        resolvePinnedBunRuntime({
          label: "Hyperia",
          workspaceRoot,
          configuredPath: missingRuntime,
          processPath: hyperbetBun,
          pathCommand: "",
        }),
      (error) => {
        assert.match(error.message, /Hyperia requires Bun 1\.3\.14/u);
        assert.ok(error.message.includes(`${missingRuntime}=unavailable`));
        assert.ok(error.message.includes(`${hyperbetBun}=1.3.6`));
        return true;
      },
    );
  });
});

test("binds the orchestrator and every child class to explicit pinned runtimes", () => {
  assert.match(
    launcherSource,
    /label: "Hyperia",[\s\S]*?configuredPath: process\.env\.DUEL_HYPERIA_BUN_PATH,[\s\S]*?processPath: process\.execPath,[\s\S]*?pathCommand: ""/u,
  );
  assert.match(launcherSource, /const gameBunPath = gameBunRuntime\.path/u);
  assert.match(launcherSource, /requireHyperbetBunPath\(\)/u);
  assert.match(
    launcherSource,
    /hyperbetBackendEnv = bindPinnedBunToEnvironment\(/u,
  );
  assert.match(
    launcherSource,
    /const bettingEnv = bindPinnedBunToEnvironment\(/u,
  );
  assert.match(
    launcherSource,
    /const keeperEnv = bindPinnedBunToEnvironment\(/u,
  );
  assert.match(
    launcherSource,
    /"keeper-bot",\s*requireHyperbetBunPath\(\),\s*withHyperbetBunRuntimeArgs\(\[\s*path\.join\(hyperbetKeeperDir, "src\/duelBot\.ts"\)/u,
  );
  assert.match(
    launcherSource,
    /const HYPERBET_BUN_RUNTIME_PREFIX_ARGS = Object\.freeze\(\[\s*"--config=\/dev\/null",\s*"--no-install"/u,
  );
  for (const childName of [
    "solana-build",
    "solana-launch-config-runtime-preflight",
    "solana-program-readiness-runtime-preflight",
    "solana-launch-config",
    "hyperbet-backend",
    "hyperbet-app-build",
    "betting-app",
    "keeper-bot",
  ]) {
    assert.match(
      launcherSource,
      new RegExp(
        `"${childName}",[\\s\\S]{0,140}?requireHyperbetBunPath\\(\\),[\\s\\S]{0,80}?withHyperbetBunRuntimeArgs\\(`,
        "u",
      ),
      `${childName} must use the non-installing Hyperbet runtime invocation`,
    );
  }
  assert.match(
    launcherSource,
    /const args = withHyperbetBunRuntimeArgs\(\[[\s\S]*?"--wallet",[\s\S]*?await runCommand\(\s*"solana-program-readiness",\s*requireHyperbetBunPath\(\),\s*args,/u,
  );
  assert.doesNotMatch(launcherSource, /command === "bun"/u);
  assert.match(
    productionSource,
    /interpreter: process\.env\.DUEL_HYPERIA_BUN_PATH \|\| "bun"/u,
  );
});

test("managed local SOL freezes distinct launch roles before keeper startup", () => {
  assert.match(
    launcherSource,
    /managedLocalSolanaRoles = Object\.fromEntries/u,
  );
  assert.match(launcherSource, /SOLANA_LAUNCH_CONFIG_FREEZE_APPROVED: "true"/u);
  assert.match(launcherSource, /"--cluster",\s*"localnet",\s*"--freeze"/u);
  assert.match(
    launcherSource,
    /fightOracle\?\.frozen !== true[\s\S]*?duelMarket\?\.frozen !== true/u,
  );
  assert.match(launcherSource, /secretRef: writeEphemeralSolanaKeypairFile\(/u);
  assert.match(
    launcherSource,
    /Object\.entries\(managedRoleKeypairs\)\.map\(\(\[role, keypair\]\)/u,
  );
  const readinessIndex = launcherSource.indexOf('"solana-program-readiness",');
  const initializerIndex = launcherSource.indexOf(
    '"solana-launch-config",',
    readinessIndex,
  );
  assert.ok(readinessIndex >= 0, "dispatch readiness gate must exist");
  assert.ok(
    initializerIndex > readinessIndex,
    "dispatch readiness must run before launch configuration mutates state",
  );
  const readinessFunctionStart = launcherSource.indexOf(
    "async function waitForManagedLocalSolanaProgramDispatch(input)",
  );
  const readinessFunctionEnd = launcherSource.indexOf(
    "async function startManagedLocalSolana()",
    readinessFunctionStart,
  );
  const readinessFunctionSource = launcherSource.slice(
    readinessFunctionStart,
    readinessFunctionEnd,
  );
  for (const flag of [
    "--oracle-dispute-window-secs",
    "--trade-treasury-fee-bps",
    "--trade-market-maker-fee-bps",
    "--winnings-market-maker-fee-bps",
    "--reporter",
    "--finalizer",
    "--challenger",
    "--market-operator",
    "--treasury",
    "--market-maker",
  ]) {
    assert.match(
      readinessFunctionSource,
      new RegExp(`"${flag}"`, "u"),
      `${flag} must be explicit in the dispatch-readiness probe`,
    );
  }
  const roleGenerationIndex = launcherSource.indexOf(
    "const managedRoleKeypairs = Object.fromEntries",
  );
  const readinessInvocationIndex = launcherSource.indexOf(
    "await waitForManagedLocalSolanaProgramDispatch({",
  );
  assert.ok(
    roleGenerationIndex >= 0 && roleGenerationIndex < readinessInvocationIndex,
    "the exact launch roles must exist before dispatch readiness is evaluated",
  );
  assert.match(
    launcherSource,
    /configuration: \{\s*oracleDisputeWindowSeconds: localOracleDisputeWindowSeconds,\s*\.\.\.localFeePolicy,/u,
  );
  assert.match(
    launcherSource,
    /SOLANA_ORACLE_DISPUTE_WINDOW_SECS: localOracleDisputeWindowSeconds/u,
  );
  for (const hiddenFallback of [
    /keeperDefaults\.TRADE_TREASURY_FEE_BPS \|\|\s*"100"/u,
    /keeperDefaults\.TRADE_MARKET_MAKER_FEE_BPS \|\|\s*"100"/u,
    /keeperDefaults\.WINNINGS_MARKET_MAKER_FEE_BPS \|\|\s*"200"/u,
  ]) {
    assert.doesNotMatch(launcherSource, hiddenFallback);
  }
  assert.match(
    launcherSource,
    /const requiredKeeperLaunchPolicy = \[[\s\S]*?"TRADE_TREASURY_FEE_BPS"[\s\S]*?"TRADE_MARKET_MAKER_FEE_BPS"[\s\S]*?"WINNINGS_MARKET_MAKER_FEE_BPS"[\s\S]*?"SOLANA_ORACLE_DISPUTE_WINDOW_SECS"/u,
  );
  assert.match(
    launcherSource,
    /requiredKeeperLaunchPolicy\.push\("SOLANA_LAUNCH_FEE_POLICY_APPROVED"\)/u,
  );
  assert.doesNotMatch(
    launcherSource,
    /launch configuration is not transaction-ready yet; retrying/u,
  );
});
