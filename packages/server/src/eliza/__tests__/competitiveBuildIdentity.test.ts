import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as buildWithEsbuild } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  COMPETITIVE_BUILD_MANIFEST_VERSION,
  EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS,
  SERVER_PHYSX_RUNTIME_ARTIFACTS,
  SHARED_RUNTIME_ARTIFACTS,
  createCompetitiveBuildManifest,
  resolveCanonicalExternalGameplayRuntimePackageDirectories,
  resolveCompetitiveExecutableBuildId,
  serializeCompetitiveBuildManifest,
  verifyResolvedExternalGameplayRuntime,
  verifyResolvedSharedRuntime,
  type CompetitiveBuildManifest,
  type ExternalGameplayRuntimePackageDirectories,
} from "../competitiveBuildIdentity.js";

const temporaryDirectories: string[] = [];
let bootstrapBuildDirectory = "";
let bootstrapBundlePath = "";
let bootstrapBuildInputs: string[] = [];

beforeAll(async () => {
  bootstrapBuildDirectory = mkdtempSync(
    resolve(tmpdir(), "hyperia-competitive-bootstrap-build-"),
  );
  bootstrapBundlePath = resolve(
    bootstrapBuildDirectory,
    "competitiveServerBootstrap.mjs",
  );
  const buildResult = await buildWithEsbuild({
    entryPoints: [
      fileURLToPath(
        new URL("../competitiveServerBootstrap.ts", import.meta.url),
      ),
    ],
    outfile: bootstrapBundlePath,
    platform: "node",
    format: "esm",
    bundle: true,
    target: "node22",
    metafile: true,
  });
  bootstrapBuildInputs = Object.keys(buildResult.metafile.inputs);
});

afterAll(() => {
  if (bootstrapBuildDirectory) {
    rmSync(bootstrapBuildDirectory, { recursive: true, force: true });
  }
});

type RuntimePackageExports = Record<string, { import: string }>;

function writePackageJson(
  packageDirectory: string,
  packageName: string,
  packageExports?: RuntimePackageExports,
): void {
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    resolve(packageDirectory, "package.json"),
    JSON.stringify({
      name: packageName,
      type: "module",
      ...(packageExports ? { exports: packageExports } : {}),
    }),
  );
}

function packageExportsFor(
  spec: (typeof EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS)[number],
): RuntimePackageExports {
  return Object.fromEntries(
    spec.entrypoints.map((entrypoint) => [
      entrypoint.exportSubpath,
      { import: entrypoint.importTarget },
    ]),
  );
}

function writeRuntimePackages(
  packagesDirectory: string,
  contentsPrefix: string,
): {
  sharedBuildDirectory: string;
  packageDirectories: ExternalGameplayRuntimePackageDirectories;
} {
  const sharedPackageDirectory = resolve(packagesDirectory, "shared");
  const sharedBuildDirectory = resolve(sharedPackageDirectory, "build");
  writePackageJson(sharedPackageDirectory, "@hyperforge/shared", {
    ".": { import: "./build/framework.js" },
  });
  mkdirSync(sharedBuildDirectory, { recursive: true });
  for (const name of SHARED_RUNTIME_ARTIFACTS) {
    writeFileSync(
      resolve(sharedBuildDirectory, name),
      `${contentsPrefix}:shared:${name}`,
    );
  }

  const packageDirectories =
    resolveCanonicalExternalGameplayRuntimePackageDirectories(
      packagesDirectory,
    );
  for (const spec of EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS) {
    const packageDirectory = packageDirectories[spec.packageName];
    writePackageJson(
      packageDirectory,
      spec.packageName,
      packageExportsFor(spec),
    );
    const outputDirectory = resolve(packageDirectory, spec.outputDirectory);
    mkdirSync(outputDirectory, { recursive: true });
    if ("artifactNames" in spec) {
      for (const name of spec.artifactNames) {
        writeFileSync(
          resolve(outputDirectory, name),
          `${contentsPrefix}:${spec.packageName}:${name}`,
        );
      }
    } else {
      writeFileSync(
        resolve(outputDirectory, "index.js"),
        `${contentsPrefix}:${spec.packageName}:entry`,
      );
      mkdirSync(resolve(outputDirectory, "nested"), { recursive: true });
      writeFileSync(
        resolve(outputDirectory, "nested/runtime.js"),
        `${contentsPrefix}:${spec.packageName}:nested`,
      );
    }
    for (const entrypoint of spec.entrypoints) {
      const entrypointPath = resolve(packageDirectory, entrypoint.importTarget);
      if (!existsSync(entrypointPath)) {
        mkdirSync(dirname(entrypointPath), { recursive: true });
        writeFileSync(
          entrypointPath,
          `${contentsPrefix}:${spec.packageName}:${entrypoint.exportSubpath}`,
        );
      }
    }
  }

  const sharedDependencyScope = resolve(
    sharedPackageDirectory,
    "node_modules/@hyperforge",
  );
  mkdirSync(sharedDependencyScope, { recursive: true });
  for (const spec of EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS) {
    const packageBasename = spec.packageName.split("/").at(-1);
    if (!packageBasename) throw new Error("runtime package name is invalid");
    symlinkSync(
      packageDirectories[spec.packageName],
      resolve(sharedDependencyScope, packageBasename),
      "dir",
    );
  }
  return { sharedBuildDirectory, packageDirectories };
}

function buildFixture(input: { serverBundleContents?: string } = {}) {
  const repository = mkdtempSync(resolve(tmpdir(), "hyperia-build-identity-"));
  temporaryDirectories.push(repository);
  const packagesDirectory = resolve(repository, "packages");
  const runtimePackages = writeRuntimePackages(
    packagesDirectory,
    "current runtime bytes",
  );
  const dist = resolve(packagesDirectory, "server/dist");
  const serverPhysxAssetsDirectory = resolve(
    packagesDirectory,
    "server/world/assets/web",
  );
  mkdirSync(dist, { recursive: true });
  mkdirSync(serverPhysxAssetsDirectory, { recursive: true });
  const serverBundle = resolve(dist, "index.js");
  const workerBundle = resolve(dist, "agentBehaviorWorker.js");
  const lockfile = resolve(repository, "bun.lock");
  writeFileSync(
    serverBundle,
    input.serverBundleContents ?? "server executable bytes",
  );
  writeFileSync(workerBundle, "worker executable bytes");
  writeFileSync(lockfile, "dependency lock bytes");
  for (const name of SERVER_PHYSX_RUNTIME_ARTIFACTS) {
    writeFileSync(
      resolve(serverPhysxAssetsDirectory, name),
      readFileSync(
        resolve(
          runtimePackages.packageDirectories["@hyperforge/physx-js-webidl"],
          "dist",
          name,
        ),
      ),
    );
  }

  const runtimeScope = resolve(repository, "runtime/node_modules/@hyperforge");
  mkdirSync(runtimeScope, { recursive: true });
  const runtimeSharedLink = resolve(runtimeScope, "shared");
  symlinkSync(resolve(packagesDirectory, "shared"), runtimeSharedLink, "dir");
  const resolvedSharedFrameworkUrl = pathToFileURL(
    resolve(runtimeSharedLink, "build/framework.js"),
  ).href;
  const manifest = createCompetitiveBuildManifest({
    serverBundlePath: serverBundle,
    behaviorWorkerPath: workerBundle,
    dependencyLockPath: lockfile,
    resolvedSharedFrameworkUrl,
    serverPhysxAssetsDirectory,
  });
  writeFileSync(
    resolve(dirname(serverBundle), "competitive-build.json"),
    serializeCompetitiveBuildManifest(manifest),
  );
  return {
    repository,
    packagesDirectory,
    serverBundle,
    workerBundle,
    lockfile,
    sharedBuild: runtimePackages.sharedBuildDirectory,
    packageDirectories: runtimePackages.packageDirectories,
    runtimeSharedLink,
    resolvedSharedFrameworkUrl,
    serverPhysxAssetsDirectory,
    manifest,
  };
}

function runBootstrapSubprocess(
  fixture: ReturnType<typeof buildFixture>,
  input: { nodeEnv?: string } = {},
) {
  const runnerPath = resolve(fixture.repository, "run-bootstrap.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { startVerifiedCompetitiveServer } from ${JSON.stringify(pathToFileURL(bootstrapBundlePath).href)};`,
      "try {",
      "  await startVerifiedCompetitiveServer({",
      `    serverModuleUrl: ${JSON.stringify(pathToFileURL(fixture.serverBundle).href)},`,
      `    resolvedSharedFrameworkUrl: ${JSON.stringify(fixture.resolvedSharedFrameworkUrl)},`,
      `    serverPhysxAssetsDirectory: ${JSON.stringify(fixture.serverPhysxAssetsDirectory)},`,
      "  });",
      "} catch (error) {",
      "  console.error(error instanceof Error ? error.stack : String(error));",
      "  process.exitCode = 1;",
      "}",
      "",
    ].join("\n"),
  );
  const pinnedNodeExecutable = fileURLToPath(
    new URL(
      "../../../../../../.toolchains/node-v22.23.2/node-v22.23.2-darwin-arm64/bin/node",
      import.meta.url,
    ),
  );
  const nodeExecutable = existsSync(pinnedNodeExecutable)
    ? pinnedNodeExecutable
    : process.execPath;
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (input.nodeEnv === undefined) {
    delete environment.NODE_ENV;
  } else {
    environment.NODE_ENV = input.nodeEnv;
  }
  const result = spawnSync(nodeExecutable, [runnerPath], {
    encoding: "utf8",
    env: environment,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return result;
}

function resolveFixtureBuildId(fixture: ReturnType<typeof buildFixture>) {
  return resolveCompetitiveExecutableBuildId({
    moduleUrl: pathToFileURL(fixture.serverBundle).href,
    nodeEnv: "production",
    resolvedSharedFrameworkUrl: fixture.resolvedSharedFrameworkUrl,
    serverPhysxAssetsDirectory: fixture.serverPhysxAssetsDirectory,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("competitive executable build identity", () => {
  it("keeps the pre-attestation bundle free of gameplay inputs", () => {
    expect(
      bootstrapBuildInputs
        .map((inputPath) => inputPath.split(/[\\/]/).slice(-2).join("/"))
        .sort(),
    ).toEqual([
      "eliza/competitiveBuildIdentity.ts",
      "eliza/competitiveServerBootstrap.ts",
    ]);
  });

  it("evaluates the gameplay entrypoint only after a real subprocess verifies it", () => {
    const markerPath = resolve(
      tmpdir(),
      `hyperia-gameplay-sentinel-${Date.now()}`,
    );
    const fixture = buildFixture({
      serverBundleContents: [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(markerPath)}, "gameplay evaluated");`,
      ].join("\n"),
    });

    const result = runBootstrapSubprocess(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(markerPath, "utf8")).toBe("gameplay evaluated");
    rmSync(markerPath, { force: true });
  });

  it("does not evaluate gameplay when the manifest is stale", () => {
    const markerPath = resolve(
      tmpdir(),
      `hyperia-stale-manifest-sentinel-${Date.now()}`,
    );
    const fixture = buildFixture({
      serverBundleContents: [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(markerPath)}, "must not execute");`,
      ].join("\n"),
    });
    writeFileSync(
      resolve(dirname(fixture.serverBundle), "competitive-build.json"),
      serializeCompetitiveBuildManifest({
        ...fixture.manifest,
        buildId: "00".repeat(32),
      }),
    );

    const result = runBootstrapSubprocess(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/artifact does not match/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("requires a manifest before gameplay even outside production mode", () => {
    const markerPath = resolve(
      tmpdir(),
      `hyperia-missing-manifest-sentinel-${Date.now()}`,
    );
    const fixture = buildFixture({
      serverBundleContents: [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(markerPath)}, "must not execute");`,
      ].join("\n"),
    });
    rmSync(resolve(dirname(fixture.serverBundle), "competitive-build.json"));

    for (const nodeEnv of [undefined, "development"]) {
      const result = runBootstrapSubprocess(fixture, { nodeEnv });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/manifest is required in production/);
      expect(existsSync(markerPath)).toBe(false);
    }
  });

  it("does not evaluate gameplay when the resolved runtime diverges", () => {
    const markerPath = resolve(
      tmpdir(),
      `hyperia-runtime-divergence-sentinel-${Date.now()}`,
    );
    const fixture = buildFixture({
      serverBundleContents: [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(markerPath)}, "must not execute");`,
      ].join("\n"),
    });
    writeFileSync(
      resolve(
        fixture.packageDirectories["@hyperforge/procgen"],
        "dist/nested/runtime.js",
      ),
      "diverged resolved gameplay runtime",
    );

    const result = runBootstrapSubprocess(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/artifact does not match/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("does not evaluate gameplay when resolved PhysX bytes diverge", () => {
    const markerPath = resolve(
      tmpdir(),
      `hyperia-physx-divergence-sentinel-${Date.now()}`,
    );
    const fixture = buildFixture({
      serverBundleContents: [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(markerPath)}, "must not execute");`,
      ].join("\n"),
    });
    writeFileSync(
      resolve(
        fixture.packageDirectories["@hyperforge/physx-js-webidl"],
        "dist/physx-js-webidl.wasm",
      ),
      "diverged resolved PhysX runtime",
    );

    const result = runBootstrapSubprocess(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/artifact does not match/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("generates and re-verifies one schema-v3 manifest from shared helpers", () => {
    const fixture = buildFixture();
    expect(fixture.manifest.schemaVersion).toBe(
      COMPETITIVE_BUILD_MANIFEST_VERSION,
    );
    expect(
      JSON.parse(serializeCompetitiveBuildManifest(fixture.manifest)),
    ).toEqual(fixture.manifest);
    expect(resolveFixtureBuildId(fixture)).toBe(fixture.manifest.buildId);
  });

  it("requires resolved shared and transitive workspace outputs to match fresh builds", () => {
    const fixture = buildFixture();
    expect(
      verifyResolvedSharedRuntime({
        canonicalSharedBuildDirectory: fixture.sharedBuild,
        resolvedFrameworkUrl: fixture.resolvedSharedFrameworkUrl,
      }).sharedRuntimeSha256,
    ).toBe(fixture.manifest.sharedRuntimeSha256);
    expect(
      verifyResolvedExternalGameplayRuntime({
        canonicalPackagesDirectory: fixture.packagesDirectory,
        resolvedSharedFrameworkUrl: fixture.resolvedSharedFrameworkUrl,
        serverPhysxAssetsDirectory: fixture.serverPhysxAssetsDirectory,
      }).externalGameplayRuntimeSha256,
    ).toBe(fixture.manifest.externalGameplayRuntimeSha256);
  });

  it("fails closed when the resolved shared symlink is retargeted after build", () => {
    const fixture = buildFixture();
    const stalePackagesDirectory = resolve(
      fixture.repository,
      "stale-packages",
    );
    writeRuntimePackages(stalePackagesDirectory, "stale runtime bytes");
    unlinkSync(fixture.runtimeSharedLink);
    symlinkSync(
      resolve(stalePackagesDirectory, "shared"),
      fixture.runtimeSharedLink,
      "dir",
    );

    expect(() => resolveFixtureBuildId(fixture)).toThrow(
      /artifact does not match/,
    );
  });

  it("fails closed when a transitive runtime symlink is retargeted after build", () => {
    const fixture = buildFixture();
    const stalePackagesDirectory = resolve(
      fixture.repository,
      "stale-packages",
    );
    const stale = writeRuntimePackages(
      stalePackagesDirectory,
      "stale runtime bytes",
    );
    const procgenLink = resolve(
      fixture.packagesDirectory,
      "shared/node_modules/@hyperforge/procgen",
    );
    unlinkSync(procgenLink);
    symlinkSync(
      stale.packageDirectories["@hyperforge/procgen"],
      procgenLink,
      "dir",
    );

    expect(() => resolveFixtureBuildId(fixture)).toThrow(
      /artifact does not match/,
    );
  });

  it("binds non-entry procgen, decimation, and impostor JavaScript", () => {
    for (const packageName of [
      "@hyperforge/procgen",
      "@hyperforge/decimation",
      "@hyperforge/impostor",
    ] as const) {
      const fixture = buildFixture();
      writeFileSync(
        resolve(
          fixture.packageDirectories[packageName],
          "dist/nested/runtime.js",
        ),
        `changed ${packageName} nested runtime`,
      );
      expect(() => resolveFixtureBuildId(fixture)).toThrow(
        /artifact does not match/,
      );
    }
  });

  it("binds both resolved and browser-served PhysX JavaScript and WASM", () => {
    const resolvedFixture = buildFixture();
    writeFileSync(
      resolve(
        resolvedFixture.packageDirectories["@hyperforge/physx-js-webidl"],
        "dist/physx-js-webidl.wasm",
      ),
      "changed resolved PhysX WASM",
    );
    expect(() => resolveFixtureBuildId(resolvedFixture)).toThrow(
      /artifact does not match/,
    );

    const servedFixture = buildFixture();
    writeFileSync(
      resolve(servedFixture.serverPhysxAssetsDirectory, "physx-js-webidl.js"),
      "changed served PhysX JavaScript",
    );
    expect(() => resolveFixtureBuildId(servedFixture)).toThrow(
      /artifact does not match/,
    );
  });

  it("binds runtime package metadata that controls module resolution", () => {
    const fixture = buildFixture();
    writeFileSync(
      resolve(
        fixture.packageDirectories["@hyperforge/procgen"],
        "package.json",
      ),
      JSON.stringify({
        name: "@hyperforge/procgen",
        type: "module",
        exports: { ".": "./dist/other.js" },
      }),
    );
    expect(() => resolveFixtureBuildId(fixture)).toThrow(/entrypoint mismatch/);
  });

  it("rejects a used package export that leaves the covered output tree", () => {
    const fixture = buildFixture();
    const procgenSpec = EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS.find(
      (spec) => spec.packageName === "@hyperforge/procgen",
    );
    if (!procgenSpec) throw new Error("procgen runtime spec is missing");
    const packageDirectory = fixture.packageDirectories["@hyperforge/procgen"];
    const packageExports = packageExportsFor(procgenSpec);
    packageExports["./building"] = { import: "../outside.js" };
    writeFileSync(resolve(packageDirectory, "../outside.js"), "outside bytes");
    writePackageJson(packageDirectory, "@hyperforge/procgen", packageExports);

    expect(() => resolveFixtureBuildId(fixture)).toThrow(/entrypoint mismatch/);
  });

  it("rejects earlier node and default conditions that can override import", () => {
    for (const condition of ["node", "default"] as const) {
      const fixture = buildFixture();
      const procgenSpec = EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS.find(
        (spec) => spec.packageName === "@hyperforge/procgen",
      );
      if (!procgenSpec) throw new Error("procgen runtime spec is missing");
      const packageDirectory =
        fixture.packageDirectories["@hyperforge/procgen"];
      const packageExports: Record<string, unknown> =
        packageExportsFor(procgenSpec);
      packageExports["."] = {
        [condition]: "./unhashed.js",
        import: "./dist/index.js",
      };
      writeFileSync(resolve(packageDirectory, "unhashed.js"), "unhashed bytes");
      writeFileSync(
        resolve(packageDirectory, "package.json"),
        JSON.stringify({
          name: "@hyperforge/procgen",
          type: "module",
          exports: packageExports,
        }),
      );

      expect(() => resolveFixtureBuildId(fixture)).toThrow(
        condition === "node"
          ? /unsupported export condition/
          : /export condition target mismatch/,
      );
    }
  });

  it("rejects an empty JavaScript output tree for each recursive package", () => {
    for (const packageName of [
      "@hyperforge/decimation",
      "@hyperforge/impostor",
      "@hyperforge/procgen",
    ] as const) {
      const fixture = buildFixture();
      const outputDirectory = resolve(
        fixture.packageDirectories[packageName],
        "dist",
      );
      rmSync(outputDirectory, { recursive: true, force: true });
      mkdirSync(outputDirectory, { recursive: true });

      expect(() => resolveFixtureBuildId(fixture)).toThrow(
        /contains no matching artifacts/,
      );
    }
  });

  it("fails closed when a bundled executable artifact changes", () => {
    const fixture = buildFixture();
    writeFileSync(fixture.workerBundle, "changed worker executable bytes");
    expect(() => resolveFixtureBuildId(fixture)).toThrow(
      /artifact does not match/,
    );
  });

  it("requires the generated manifest for production source execution", () => {
    expect(() =>
      resolveCompetitiveExecutableBuildId({
        moduleUrl: import.meta.url,
        nodeEnv: "production",
        fileExists: () => false,
      }),
    ).toThrow(/required in production/);
  });

  it("uses an explicit non-production identity for source-mode tests", () => {
    const first = resolveCompetitiveExecutableBuildId({
      moduleUrl: import.meta.url,
      nodeEnv: "test",
      fileExists: () => false,
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(
      resolveCompetitiveExecutableBuildId({
        moduleUrl: import.meta.url,
        nodeEnv: "test",
        fileExists: () => false,
      }),
    );
  });

  it("rejects older schemas, extra fields, and a forged build ID", () => {
    const fixture = buildFixture();
    const manifestPath = resolve(
      dirname(fixture.serverBundle),
      "competitive-build.json",
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...fixture.manifest, schemaVersion: 2 }),
    );
    expect(() => resolveFixtureBuildId(fixture)).toThrow(/shape is invalid/);

    writeFileSync(
      manifestPath,
      JSON.stringify({ ...fixture.manifest, secret: "unexpected" }),
    );
    expect(() => resolveFixtureBuildId(fixture)).toThrow(/shape is invalid/);

    writeFileSync(
      manifestPath,
      JSON.stringify({ ...fixture.manifest, buildId: "00".repeat(32) }),
    );
    expect(() => resolveFixtureBuildId(fixture)).toThrow(
      /artifact does not match/,
    );
  });

  it("keeps the generated manifest type exact", () => {
    const fixture = buildFixture();
    const manifest: CompetitiveBuildManifest = fixture.manifest;
    expect(Object.keys(manifest).sort()).toEqual([
      "algorithm",
      "behaviorWorkerSha256",
      "buildId",
      "dependencyLockSha256",
      "externalGameplayRuntimeSha256",
      "schemaVersion",
      "serverBundleSha256",
      "sharedRuntimeSha256",
    ]);
  });
});
