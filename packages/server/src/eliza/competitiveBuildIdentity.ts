import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  type Dirent,
  type PathOrFileDescriptor,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPETITIVE_BUILD_MANIFEST_VERSION = 3 as const;

export type CompetitiveBuildManifest = {
  schemaVersion: typeof COMPETITIVE_BUILD_MANIFEST_VERSION;
  algorithm: "sha256";
  buildId: string;
  serverBundleSha256: string;
  behaviorWorkerSha256: string;
  sharedRuntimeSha256: string;
  externalGameplayRuntimeSha256: string;
  dependencyLockSha256: string;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = [
  "algorithm",
  "behaviorWorkerSha256",
  "buildId",
  "dependencyLockSha256",
  "externalGameplayRuntimeSha256",
  "schemaVersion",
  "serverBundleSha256",
  "sharedRuntimeSha256",
] as const;

export const SHARED_RUNTIME_ARTIFACTS = [
  "PhysXManager.server.js",
  "framework.js",
  "storage.server.js",
] as const;

const SHARED_RUNTIME_ENTRYPOINTS = [
  { exportSubpath: ".", importTarget: "./build/framework.js" },
] as const;

export const EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS = [
  {
    packageName: "@hyperforge/decimation",
    canonicalDirectoryName: "decimation",
    outputDirectory: "dist",
    artifactSuffixes: [".js"],
    entrypoints: [{ exportSubpath: ".", importTarget: "./dist/index.js" }],
  },
  {
    packageName: "@hyperforge/impostor",
    canonicalDirectoryName: "impostors",
    outputDirectory: "dist",
    artifactSuffixes: [".js"],
    entrypoints: [{ exportSubpath: ".", importTarget: "./dist/index.js" }],
  },
  {
    packageName: "@hyperforge/physx-js-webidl",
    canonicalDirectoryName: "physx-js-webidl",
    outputDirectory: "dist",
    artifactNames: ["physx-js-webidl.js", "physx-js-webidl.wasm"],
    entrypoints: [
      {
        exportSubpath: ".",
        importTarget: "./dist/physx-js-webidl.js",
      },
    ],
  },
  {
    packageName: "@hyperforge/procgen",
    canonicalDirectoryName: "procgen",
    outputDirectory: "dist",
    artifactSuffixes: [".js"],
    entrypoints: [
      { exportSubpath: ".", importTarget: "./dist/index.js" },
      {
        exportSubpath: "./building",
        importTarget: "./dist/building/index.js",
      },
      {
        exportSubpath: "./building/town",
        importTarget: "./dist/building/town/index.js",
      },
      { exportSubpath: "./grass", importTarget: "./dist/grass/index.js" },
      {
        exportSubpath: "./items/dock",
        importTarget: "./dist/items/dock/index.js",
      },
      { exportSubpath: "./plant", importTarget: "./dist/plant/index.js" },
      { exportSubpath: "./rock", importTarget: "./dist/rock/index.js" },
      {
        exportSubpath: "./terrain",
        importTarget: "./dist/terrain/index.js",
      },
    ],
  },
] as const;

export const SERVER_PHYSX_RUNTIME_ARTIFACTS = [
  "physx-js-webidl.js",
  "physx-js-webidl.wasm",
] as const;

type ExternalGameplayRuntimePackageName =
  (typeof EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS)[number]["packageName"];

export type ExternalGameplayRuntimePackageDirectories = Record<
  ExternalGameplayRuntimePackageName,
  string
>;

type ReadFile = {
  (path: PathOrFileDescriptor): Buffer;
  (path: PathOrFileDescriptor, encoding: "utf8"): string;
};

type ReadDirectory = (
  path: string,
  options: { withFileTypes: true },
) => Dirent[];

export function verifyResolvedSharedRuntime(input: {
  canonicalSharedBuildDirectory: string;
  resolvedFrameworkUrl: string;
  fileExists?: (path: string) => boolean;
  readFile?: ReadFile;
}): {
  resolvedSharedBuildDirectory: string;
  sharedRuntimeSha256: string;
} {
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  const resolvedFrameworkPath = fileURLToPath(input.resolvedFrameworkUrl);
  if (resolvedFrameworkPath.split(/[\\/]/).at(-1) !== "framework.js") {
    throw new Error(
      `Resolved @hyperforge/shared entry is not framework.js: ${resolvedFrameworkPath}`,
    );
  }

  const resolvedSharedBuildDirectory = dirname(resolvedFrameworkPath);
  const canonicalSharedPackageDirectory = dirname(
    input.canonicalSharedBuildDirectory,
  );
  const canonicalSharedMetadata = readPackageMetadata(
    canonicalSharedPackageDirectory,
    "@hyperforge/shared",
    fileExists,
    readFile,
  );
  assertPackageRuntimeEntrypoints({
    packageDirectory: canonicalSharedPackageDirectory,
    packageName: "@hyperforge/shared",
    outputDirectory: input.canonicalSharedBuildDirectory,
    metadata: canonicalSharedMetadata,
    entrypoints: SHARED_RUNTIME_ENTRYPOINTS,
    fileExists,
  });
  const resolvedSharedPackageDirectory = dirname(resolvedSharedBuildDirectory);
  const resolvedSharedMetadata = readPackageMetadata(
    resolvedSharedPackageDirectory,
    "@hyperforge/shared",
    fileExists,
    readFile,
  );
  assertPackageRuntimeEntrypoints({
    packageDirectory: resolvedSharedPackageDirectory,
    packageName: "@hyperforge/shared",
    outputDirectory: resolvedSharedBuildDirectory,
    metadata: resolvedSharedMetadata,
    entrypoints: SHARED_RUNTIME_ENTRYPOINTS,
    fileExists,
  });
  for (const name of SHARED_RUNTIME_ARTIFACTS) {
    const resolvedArtifactPath = resolve(resolvedSharedBuildDirectory, name);
    if (!fileExists(resolvedArtifactPath)) {
      throw new Error(
        `Resolved @hyperforge/shared runtime artifact is missing: ${resolvedArtifactPath}`,
      );
    }
  }

  const canonicalSharedRuntimeSha256 = computeSharedRuntimeSha256(
    input.canonicalSharedBuildDirectory,
    readFile,
  );
  const resolvedSharedRuntimeSha256 = computeSharedRuntimeSha256(
    resolvedSharedBuildDirectory,
    readFile,
  );
  if (resolvedSharedRuntimeSha256 !== canonicalSharedRuntimeSha256) {
    throw new Error(
      "Resolved @hyperforge/shared runtime does not match the freshly built shared runtime",
    );
  }

  return {
    resolvedSharedBuildDirectory,
    sharedRuntimeSha256: resolvedSharedRuntimeSha256,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeCompetitiveBuildId(input: {
  serverBundleSha256: string;
  behaviorWorkerSha256: string;
  sharedRuntimeSha256: string;
  externalGameplayRuntimeSha256: string;
  dependencyLockSha256: string;
}): string {
  for (const digest of [
    input.serverBundleSha256,
    input.behaviorWorkerSha256,
    input.sharedRuntimeSha256,
    input.externalGameplayRuntimeSha256,
    input.dependencyLockSha256,
  ]) {
    if (!SHA256_HEX.test(digest)) {
      throw new Error("competitive build artifact digest is invalid");
    }
  }
  return sha256(
    [
      "hyperia-competitive-build-v3",
      input.serverBundleSha256,
      input.behaviorWorkerSha256,
      input.sharedRuntimeSha256,
      input.externalGameplayRuntimeSha256,
      input.dependencyLockSha256,
    ].join("\n"),
  );
}

export function computeSharedRuntimeSha256(
  sharedBuildDirectory: string,
  readFile: (path: PathOrFileDescriptor) => Buffer = readFileSync,
): string {
  const digest = createHash("sha256");
  digest.update("hyperia-shared-runtime-v2\n");
  digest.update(
    `package.json\0${sha256(readFile(resolve(sharedBuildDirectory, "../package.json")))}\n`,
  );
  for (const name of SHARED_RUNTIME_ARTIFACTS) {
    digest.update(
      `${name}\0${sha256(readFile(resolve(sharedBuildDirectory, name)))}\n`,
    );
  }
  return digest.digest("hex");
}

const toPortableRelativePath = (base: string, path: string): string =>
  relative(base, path).split(sep).join("/");

type PackageMetadata = Record<string, unknown>;

const readPackageMetadata = (
  packageDirectory: string,
  expectedPackageName: string,
  fileExists: (path: string) => boolean,
  readFile: ReadFile,
): PackageMetadata => {
  const packageJsonPath = resolve(packageDirectory, "package.json");
  if (!fileExists(packageJsonPath)) {
    throw new Error(
      `Competitive runtime package metadata is missing: ${packageJsonPath}`,
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFile(packageJsonPath, "utf8"));
  } catch {
    throw new Error(
      `Competitive runtime package metadata is invalid: ${packageJsonPath}`,
    );
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(
      `Competitive runtime package metadata is invalid: ${packageJsonPath}`,
    );
  }
  const record = metadata as PackageMetadata;
  if (record.name !== expectedPackageName) {
    throw new Error(
      `Competitive runtime package identity mismatch: expected ${expectedPackageName}`,
    );
  }
  return record;
};

const readReviewedImportTarget = (
  packageExports: unknown,
  exportSubpath: string,
  packageSpecifier: string,
  reviewedImportTarget: string,
): string | null => {
  if (typeof packageExports === "string") {
    return exportSubpath === "." ? packageExports : null;
  }
  if (
    !packageExports ||
    typeof packageExports !== "object" ||
    Array.isArray(packageExports)
  ) {
    return null;
  }
  const exportsRecord = packageExports as Record<string, unknown>;
  const exported = exportsRecord[exportSubpath];
  if (typeof exported === "string") return exported;
  if (!exported || typeof exported !== "object" || Array.isArray(exported)) {
    return null;
  }
  const conditions = exported as Record<string, unknown>;
  for (const [condition, target] of Object.entries(conditions)) {
    if (
      condition !== "types" &&
      condition !== "import" &&
      condition !== "require" &&
      condition !== "default"
    ) {
      throw new Error(
        `Competitive runtime package uses an unsupported export condition: ${packageSpecifier} (${condition})`,
      );
    }
    if (typeof target !== "string") {
      throw new Error(
        `Competitive runtime package export condition must be a flat string: ${packageSpecifier} (${condition})`,
      );
    }
    if (
      (condition === "require" || condition === "default") &&
      target !== reviewedImportTarget
    ) {
      throw new Error(
        `Competitive runtime package export condition target mismatch: ${packageSpecifier} (${condition})`,
      );
    }
  }
  const importTarget = conditions.import;
  return typeof importTarget === "string" ? importTarget : null;
};

const assertPackageRuntimeEntrypoints = (input: {
  packageDirectory: string;
  packageName: string;
  outputDirectory: string;
  metadata: PackageMetadata;
  entrypoints: readonly {
    exportSubpath: string;
    importTarget: string;
  }[];
  fileExists: (path: string) => boolean;
}): void => {
  for (const entrypoint of input.entrypoints) {
    const packageSpecifier = `${input.packageName}${entrypoint.exportSubpath === "." ? "" : entrypoint.exportSubpath.slice(1)}`;
    const importTarget = readReviewedImportTarget(
      input.metadata.exports,
      entrypoint.exportSubpath,
      packageSpecifier,
      entrypoint.importTarget,
    );
    if (importTarget !== entrypoint.importTarget) {
      throw new Error(
        `Competitive runtime package entrypoint mismatch: ${packageSpecifier}`,
      );
    }
    const artifactPath = resolve(input.packageDirectory, importTarget);
    const outputRelativePath = relative(input.outputDirectory, artifactPath);
    if (
      outputRelativePath === "" ||
      outputRelativePath === ".." ||
      outputRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(outputRelativePath)
    ) {
      throw new Error(
        `Competitive runtime package entrypoint is outside its covered output: ${packageSpecifier}`,
      );
    }
    if (!input.fileExists(artifactPath)) {
      throw new Error(
        `Competitive runtime package entrypoint is missing: ${artifactPath}`,
      );
    }
  }
};

const findRuntimePackageDirectory = (input: {
  fromPath: string;
  packageName: ExternalGameplayRuntimePackageName;
  fileExists: (path: string) => boolean;
  readFile: ReadFile;
}): string => {
  const packageSegments = input.packageName.split("/");
  let directory = dirname(resolve(input.fromPath));
  while (true) {
    const candidate = resolve(directory, "node_modules", ...packageSegments);
    if (input.fileExists(resolve(candidate, "package.json"))) {
      readPackageMetadata(
        candidate,
        input.packageName,
        input.fileExists,
        input.readFile,
      );
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Competitive runtime package cannot be resolved from @hyperforge/shared: ${input.packageName}`,
  );
};

export function resolveExternalGameplayRuntimePackageDirectories(input: {
  resolvedSharedFrameworkUrl: string;
  fileExists?: (path: string) => boolean;
  readFile?: ReadFile;
}): ExternalGameplayRuntimePackageDirectories {
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  const resolvedSharedFrameworkPath = fileURLToPath(
    input.resolvedSharedFrameworkUrl,
  );
  const directories = {} as ExternalGameplayRuntimePackageDirectories;
  for (const spec of EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS) {
    directories[spec.packageName] = findRuntimePackageDirectory({
      fromPath: resolvedSharedFrameworkPath,
      packageName: spec.packageName,
      fileExists,
      readFile,
    });
  }
  return directories;
}

export function resolveCanonicalExternalGameplayRuntimePackageDirectories(
  packagesDirectory: string,
): ExternalGameplayRuntimePackageDirectories {
  const directories = {} as ExternalGameplayRuntimePackageDirectories;
  for (const spec of EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS) {
    directories[spec.packageName] = resolve(
      packagesDirectory,
      spec.canonicalDirectoryName,
    );
  }
  return directories;
}

const listRuntimeFiles = (input: {
  directory: string;
  artifactSuffixes: readonly string[];
  fileExists: (path: string) => boolean;
  readDirectory: ReadDirectory;
}): string[] => {
  if (!input.fileExists(input.directory)) {
    throw new Error(
      `Competitive runtime output directory is missing: ${input.directory}`,
    );
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of input.readDirectory(directory, {
      withFileTypes: true,
    })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isSymbolicLink()) {
        throw new Error(
          `Competitive runtime output contains an unsupported symlink: ${path}`,
        );
      } else if (
        entry.isFile() &&
        input.artifactSuffixes.some((suffix) => entry.name.endsWith(suffix))
      ) {
        files.push(path);
      }
    }
  };
  visit(input.directory);
  if (files.length === 0) {
    throw new Error(
      `Competitive runtime output contains no matching artifacts: ${input.directory}`,
    );
  }
  return files.sort((left, right) => {
    const leftRelative = toPortableRelativePath(input.directory, left);
    const rightRelative = toPortableRelativePath(input.directory, right);
    return leftRelative < rightRelative
      ? -1
      : leftRelative > rightRelative
        ? 1
        : 0;
  });
};

export function computeExternalGameplayRuntimeSha256(input: {
  packageDirectories: ExternalGameplayRuntimePackageDirectories;
  serverPhysxAssetsDirectory: string;
  fileExists?: (path: string) => boolean;
  readFile?: ReadFile;
  readDirectory?: ReadDirectory;
}): string {
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  const readDirectory = input.readDirectory ?? readdirSync;
  const artifacts: Array<{ label: string; path: string }> = [];
  for (const spec of EXTERNAL_GAMEPLAY_RUNTIME_PACKAGE_SPECS) {
    const packageDirectory = input.packageDirectories[spec.packageName];
    const metadata = readPackageMetadata(
      packageDirectory,
      spec.packageName,
      fileExists,
      readFile,
    );
    artifacts.push({
      label: `${spec.packageName}/package.json`,
      path: resolve(packageDirectory, "package.json"),
    });
    const outputDirectory = resolve(packageDirectory, spec.outputDirectory);
    if ("artifactNames" in spec) {
      for (const artifactName of spec.artifactNames) {
        artifacts.push({
          label: `${spec.packageName}/${spec.outputDirectory}/${artifactName}`,
          path: resolve(outputDirectory, artifactName),
        });
      }
    } else {
      for (const artifactPath of listRuntimeFiles({
        directory: outputDirectory,
        artifactSuffixes: spec.artifactSuffixes,
        fileExists,
        readDirectory,
      })) {
        artifacts.push({
          label: `${spec.packageName}/${spec.outputDirectory}/${toPortableRelativePath(outputDirectory, artifactPath)}`,
          path: artifactPath,
        });
      }
    }
    assertPackageRuntimeEntrypoints({
      packageDirectory,
      packageName: spec.packageName,
      outputDirectory,
      metadata,
      entrypoints: spec.entrypoints,
      fileExists,
    });
  }
  for (const artifactName of SERVER_PHYSX_RUNTIME_ARTIFACTS) {
    artifacts.push({
      label: `@hyperforge/server/world/assets/web/${artifactName}`,
      path: resolve(input.serverPhysxAssetsDirectory, artifactName),
    });
  }
  artifacts.sort((left, right) =>
    left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
  );
  if (artifacts.length === 0) {
    throw new Error("Competitive external gameplay runtime is empty");
  }
  const digest = createHash("sha256");
  digest.update("hyperia-external-gameplay-runtime-v1\n");
  let previousLabel: string | null = null;
  for (const artifact of artifacts) {
    if (artifact.label === previousLabel) {
      throw new Error(
        `Competitive runtime artifact label is duplicated: ${artifact.label}`,
      );
    }
    previousLabel = artifact.label;
    if (!fileExists(artifact.path)) {
      throw new Error(
        `Competitive runtime artifact is missing: ${artifact.path}`,
      );
    }
    digest.update(`${artifact.label}\0${sha256(readFile(artifact.path))}\n`);
  }
  return digest.digest("hex");
}

export function verifyResolvedExternalGameplayRuntime(input: {
  canonicalPackagesDirectory: string;
  resolvedSharedFrameworkUrl: string;
  serverPhysxAssetsDirectory: string;
  fileExists?: (path: string) => boolean;
  readFile?: ReadFile;
  readDirectory?: ReadDirectory;
}): {
  packageDirectories: ExternalGameplayRuntimePackageDirectories;
  externalGameplayRuntimeSha256: string;
} {
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  const readDirectory = input.readDirectory ?? readdirSync;
  const canonicalPackageDirectories =
    resolveCanonicalExternalGameplayRuntimePackageDirectories(
      input.canonicalPackagesDirectory,
    );
  const packageDirectories = resolveExternalGameplayRuntimePackageDirectories({
    resolvedSharedFrameworkUrl: input.resolvedSharedFrameworkUrl,
    fileExists,
    readFile,
  });
  const canonicalSha256 = computeExternalGameplayRuntimeSha256({
    packageDirectories: canonicalPackageDirectories,
    serverPhysxAssetsDirectory: input.serverPhysxAssetsDirectory,
    fileExists,
    readFile,
    readDirectory,
  });
  const resolvedSha256 = computeExternalGameplayRuntimeSha256({
    packageDirectories,
    serverPhysxAssetsDirectory: input.serverPhysxAssetsDirectory,
    fileExists,
    readFile,
    readDirectory,
  });
  if (resolvedSha256 !== canonicalSha256) {
    throw new Error(
      "Resolved external gameplay runtime does not match the freshly built workspace runtime",
    );
  }
  return {
    packageDirectories,
    externalGameplayRuntimeSha256: resolvedSha256,
  };
}

export function createCompetitiveBuildManifest(input: {
  serverBundlePath: string;
  behaviorWorkerPath: string;
  dependencyLockPath: string;
  resolvedSharedFrameworkUrl: string;
  serverPhysxAssetsDirectory: string;
  fileExists?: (path: string) => boolean;
  readFile?: ReadFile;
  readDirectory?: ReadDirectory;
}): CompetitiveBuildManifest {
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  const readDirectory = input.readDirectory ?? readdirSync;
  const resolvedSharedFrameworkPath = fileURLToPath(
    input.resolvedSharedFrameworkUrl,
  );
  if (resolvedSharedFrameworkPath.split(/[\\/]/).at(-1) !== "framework.js") {
    throw new Error(
      `Resolved @hyperforge/shared entry is not framework.js: ${resolvedSharedFrameworkPath}`,
    );
  }
  const resolvedSharedBuildDirectory = dirname(resolvedSharedFrameworkPath);
  const resolvedSharedPackageDirectory = dirname(resolvedSharedBuildDirectory);
  const resolvedSharedMetadata = readPackageMetadata(
    resolvedSharedPackageDirectory,
    "@hyperforge/shared",
    fileExists,
    readFile,
  );
  assertPackageRuntimeEntrypoints({
    packageDirectory: resolvedSharedPackageDirectory,
    packageName: "@hyperforge/shared",
    outputDirectory: resolvedSharedBuildDirectory,
    metadata: resolvedSharedMetadata,
    entrypoints: SHARED_RUNTIME_ENTRYPOINTS,
    fileExists,
  });
  for (const name of SHARED_RUNTIME_ARTIFACTS) {
    const artifactPath = resolve(resolvedSharedBuildDirectory, name);
    if (!fileExists(artifactPath)) {
      throw new Error(
        `Resolved @hyperforge/shared runtime artifact is missing: ${artifactPath}`,
      );
    }
  }
  const packageDirectories = resolveExternalGameplayRuntimePackageDirectories({
    resolvedSharedFrameworkUrl: input.resolvedSharedFrameworkUrl,
    fileExists,
    readFile,
  });
  const digests = {
    serverBundleSha256: sha256(readFile(resolve(input.serverBundlePath))),
    behaviorWorkerSha256: sha256(readFile(resolve(input.behaviorWorkerPath))),
    sharedRuntimeSha256: computeSharedRuntimeSha256(
      resolvedSharedBuildDirectory,
      readFile,
    ),
    externalGameplayRuntimeSha256: computeExternalGameplayRuntimeSha256({
      packageDirectories,
      serverPhysxAssetsDirectory: input.serverPhysxAssetsDirectory,
      fileExists,
      readFile,
      readDirectory,
    }),
    dependencyLockSha256: sha256(readFile(resolve(input.dependencyLockPath))),
  };
  return {
    schemaVersion: COMPETITIVE_BUILD_MANIFEST_VERSION,
    algorithm: "sha256",
    buildId: computeCompetitiveBuildId(digests),
    ...digests,
  };
}

export function serializeCompetitiveBuildManifest(
  manifest: CompetitiveBuildManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseManifest(raw: string): CompetitiveBuildManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("competitive build manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("competitive build manifest is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== MANIFEST_KEYS.length ||
    keys.some((key, index) => key !== MANIFEST_KEYS[index]) ||
    record.schemaVersion !== COMPETITIVE_BUILD_MANIFEST_VERSION ||
    record.algorithm !== "sha256" ||
    typeof record.buildId !== "string" ||
    typeof record.serverBundleSha256 !== "string" ||
    typeof record.behaviorWorkerSha256 !== "string" ||
    typeof record.sharedRuntimeSha256 !== "string" ||
    typeof record.externalGameplayRuntimeSha256 !== "string" ||
    typeof record.dependencyLockSha256 !== "string"
  ) {
    throw new Error("competitive build manifest shape is invalid");
  }
  const manifest = record as CompetitiveBuildManifest;
  if (
    !SHA256_HEX.test(manifest.buildId) ||
    !SHA256_HEX.test(manifest.serverBundleSha256) ||
    !SHA256_HEX.test(manifest.behaviorWorkerSha256) ||
    !SHA256_HEX.test(manifest.sharedRuntimeSha256) ||
    !SHA256_HEX.test(manifest.externalGameplayRuntimeSha256) ||
    !SHA256_HEX.test(manifest.dependencyLockSha256)
  ) {
    throw new Error("competitive build manifest digest is invalid");
  }
  return manifest;
}

export function resolveCompetitiveExecutableBuildId(input: {
  moduleUrl: string;
  nodeEnv: string | undefined;
  resolvedSharedFrameworkUrl?: string;
  serverPhysxAssetsDirectory?: string;
  fileExists?: (path: string) => boolean;
  readFile?: ReadFile;
  readDirectory?: ReadDirectory;
}): string {
  const modulePath = fileURLToPath(input.moduleUrl);
  const buildDirectory = dirname(modulePath);
  const manifestPath = resolve(buildDirectory, "competitive-build.json");
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? (readFileSync as ReadFile);

  if (!fileExists(manifestPath)) {
    if (input.nodeEnv === "production") {
      throw new Error("competitive build manifest is required in production");
    }
    return sha256(
      `hyperia-unattested-source-build-v1:${input.nodeEnv || "development"}`,
    );
  }

  const manifest = parseManifest(readFile(manifestPath, "utf8"));
  const serverBundlePath = resolve(buildDirectory, "index.js");
  const behaviorWorkerPath = resolve(buildDirectory, "agentBehaviorWorker.js");
  const dependencyLockPath = resolve(buildDirectory, "../../../bun.lock");
  if (resolve(modulePath) !== serverBundlePath) {
    throw new Error(
      "competitive build manifest is not beside the running bundle",
    );
  }

  const actual = createCompetitiveBuildManifest({
    serverBundlePath,
    behaviorWorkerPath,
    dependencyLockPath,
    resolvedSharedFrameworkUrl:
      input.resolvedSharedFrameworkUrl ??
      import.meta.resolve("@hyperforge/shared"),
    serverPhysxAssetsDirectory:
      input.serverPhysxAssetsDirectory ??
      resolve(buildDirectory, "../world/assets/web"),
    fileExists,
    readFile,
    readDirectory: input.readDirectory,
  });
  if (
    actual.serverBundleSha256 !== manifest.serverBundleSha256 ||
    actual.behaviorWorkerSha256 !== manifest.behaviorWorkerSha256 ||
    actual.sharedRuntimeSha256 !== manifest.sharedRuntimeSha256 ||
    actual.externalGameplayRuntimeSha256 !==
      manifest.externalGameplayRuntimeSha256 ||
    actual.dependencyLockSha256 !== manifest.dependencyLockSha256 ||
    actual.buildId !== manifest.buildId
  ) {
    throw new Error("competitive build artifact does not match its manifest");
  }
  return actual.buildId;
}

let cachedBuildId: string | null = null;

export function getCompetitiveExecutableBuildId(): string {
  if (cachedBuildId) return cachedBuildId;
  cachedBuildId = resolveCompetitiveExecutableBuildId({
    moduleUrl: import.meta.url,
    nodeEnv: process.env.NODE_ENV,
  });
  return cachedBuildId;
}
