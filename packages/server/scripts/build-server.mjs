import * as esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import fs from "fs";

import {
  createCompetitiveBuildManifest,
  serializeCompetitiveBuildManifest,
  verifyResolvedExternalGameplayRuntime,
  verifyResolvedSharedRuntime,
} from "../src/eliza/competitiveBuildIdentity.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "../");

// Note: Model bounds extraction is handled by turbo task `extract-bounds`
// which runs before this build script with proper caching based on GLB file changes.
// See turbo.json: server#extract-bounds

// Build the server
const serverCtx = await esbuild.context({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  platform: "node",
  format: "esm",
  bundle: true,
  treeShaking: true,
  minify: false,
  sourcemap: true,
  packages: "external",
  external: ["@hyperforge/shared"],
  target: "node22",
  loader: {
    ".ts": "ts",
  },
});

await serverCtx.rebuild();
await serverCtx.dispose();

// Build the agent behavior worker as a separate file (loaded by worker_threads)
const workerCtx = await esbuild.context({
  entryPoints: ["src/eliza/worker/agentBehaviorWorker.ts"],
  outfile: "dist/agentBehaviorWorker.js",
  platform: "node",
  format: "esm",
  bundle: true,
  treeShaking: true,
  minify: false,
  sourcemap: true,
  packages: "external",
  external: ["@hyperforge/shared"],
  target: "node22",
  loader: {
    ".ts": "ts",
  },
});

await workerCtx.rebuild();
await workerCtx.dispose();
console.log("✓ Agent behavior worker built");

// Build the pre-import verifier separately so production can attest the entire
// gameplay runtime before Node evaluates the server bundle or its dependencies.
const competitiveBootstrapPath = path.join(
  rootDir,
  "dist/competitiveServerBootstrap.js",
);
const competitiveBootstrapBuild = await esbuild.build({
  absWorkingDir: rootDir,
  entryPoints: ["src/eliza/competitiveServerBootstrap.ts"],
  outfile: competitiveBootstrapPath,
  platform: "node",
  format: "esm",
  bundle: true,
  treeShaking: true,
  minify: false,
  sourcemap: true,
  target: "node22",
  loader: {
    ".ts": "ts",
  },
  metafile: true,
});
const expectedBootstrapInputs = new Set(
  [
    "src/eliza/competitiveBuildIdentity.ts",
    "src/eliza/competitiveServerBootstrap.ts",
  ].map((inputPath) => path.normalize(path.resolve(rootDir, inputPath))),
);
const actualBootstrapInputs = Object.keys(
  competitiveBootstrapBuild.metafile.inputs,
).map((inputPath) => path.normalize(path.resolve(rootDir, inputPath)));
const unexpectedBootstrapInputs = actualBootstrapInputs.filter(
  (inputPath) => !expectedBootstrapInputs.has(inputPath),
);
const missingBootstrapInputs = [...expectedBootstrapInputs].filter(
  (inputPath) => !actualBootstrapInputs.includes(inputPath),
);
if (unexpectedBootstrapInputs.length > 0 || missingBootstrapInputs.length > 0) {
  throw new Error(
    `Competitive bootstrap input graph changed (unexpected: ${unexpectedBootstrapInputs.join(", ") || "none"}; missing: ${missingBootstrapInputs.join(", ") || "none"})`,
  );
}
const unexpectedBootstrapImports = Object.values(
  competitiveBootstrapBuild.metafile.outputs,
).flatMap((output) =>
  output.imports.filter(
    (runtimeImport) =>
      !runtimeImport.external || !runtimeImport.path.startsWith("node:"),
  ),
);
if (unexpectedBootstrapImports.length > 0) {
  throw new Error(
    `Competitive bootstrap has an unverified external import graph: ${unexpectedBootstrapImports
      .map((runtimeImport) => runtimeImport.path)
      .join(", ")}`,
  );
}
console.log("✓ Competitive pre-import bootstrap built");

// Copy PhysX WASM files to assets/web/ for server-side loading
const assetsDir = path.join(rootDir, "world/assets/web");
fs.mkdirSync(assetsDir, { recursive: true });

// Copy from physx-js-webidl package in workspace
const physxWasm = path.join(
  rootDir,
  "../physx-js-webidl/dist/physx-js-webidl.wasm",
);
const physxJs = path.join(
  rootDir,
  "../physx-js-webidl/dist/physx-js-webidl.js",
);

if (fs.existsSync(physxWasm)) {
  fs.copyFileSync(physxWasm, path.join(assetsDir, "physx-js-webidl.wasm"));
  fs.copyFileSync(physxJs, path.join(assetsDir, "physx-js-webidl.js"));
  console.log("✓ PhysX assets copied to world/assets/web/");
} else {
  console.error("❌ PhysX WASM not found at:", physxWasm);
  throw new Error(
    "PhysX WASM files missing - ensure @hyperforge/physx-js-webidl is built first",
  );
}

const serverBundlePath = path.join(rootDir, "dist/index.js");
const behaviorWorkerPath = path.join(rootDir, "dist/agentBehaviorWorker.js");
const dependencyLockPath = path.join(rootDir, "../../bun.lock");
const sharedBuildDirectory = path.join(rootDir, "../shared/build");
const resolvedSharedFrameworkUrl = import.meta.resolve("@hyperforge/shared");
const { resolvedSharedBuildDirectory, sharedRuntimeSha256 } =
  verifyResolvedSharedRuntime({
    canonicalSharedBuildDirectory: sharedBuildDirectory,
    resolvedFrameworkUrl: resolvedSharedFrameworkUrl,
  });
console.log(
  `✓ Resolved shared runtime verified (${resolvedSharedBuildDirectory})`,
);
const { externalGameplayRuntimeSha256 } = verifyResolvedExternalGameplayRuntime(
  {
    canonicalPackagesDirectory: path.join(rootDir, ".."),
    resolvedSharedFrameworkUrl,
    serverPhysxAssetsDirectory: assetsDir,
  },
);
console.log("✓ Resolved external gameplay runtime verified");

const manifest = createCompetitiveBuildManifest({
  serverBundlePath,
  behaviorWorkerPath,
  dependencyLockPath,
  resolvedSharedFrameworkUrl,
  serverPhysxAssetsDirectory: assetsDir,
});
if (
  manifest.sharedRuntimeSha256 !== sharedRuntimeSha256 ||
  manifest.externalGameplayRuntimeSha256 !== externalGameplayRuntimeSha256
) {
  throw new Error("Competitive build manifest runtime digest disagreement");
}
const manifestPath = path.join(rootDir, "dist/competitive-build.json");
fs.writeFileSync(
  manifestPath,
  serializeCompetitiveBuildManifest(manifest),
  "utf8",
);
const bootstrapModuleUrl = `${pathToFileURL(competitiveBootstrapPath).href}?build=${Date.now()}`;
const { verifyCompetitiveServerRuntime } = await import(bootstrapModuleUrl);
const verifiedBuildId = verifyCompetitiveServerRuntime({
  serverModuleUrl: pathToFileURL(serverBundlePath).href,
  resolvedSharedFrameworkUrl,
  serverPhysxAssetsDirectory: assetsDir,
});
if (verifiedBuildId !== manifest.buildId) {
  throw new Error("Competitive build manifest did not verify after write");
}
console.log(
  `✓ Competitive build manifest generated (${manifest.buildId.slice(0, 12)})`,
);

console.log("✓ Server built successfully");
