import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  type Dirent,
  type PathOrFileDescriptor,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTERNAL_AGENT_BUILD_MANIFEST_VERSION = 1 as const;

export type ExternalAgentBuildManifest = {
  schemaVersion: typeof EXTERNAL_AGENT_BUILD_MANIFEST_VERSION;
  algorithm: "sha256";
  buildId: string;
  executableTreeSha256: string;
  packageJsonSha256: string;
  dependencyLockSha256: string;
};

export type ExternalAgentExecutableBuildIdentity = {
  buildId: string;
  verified: boolean;
};

type ReadFile = {
  (path: PathOrFileDescriptor): Buffer;
  (path: PathOrFileDescriptor, encoding: "utf8"): string;
};

type ReadDirectory = (
  path: string,
  options: { withFileTypes: true },
) => Dirent[];

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MANIFEST_KEYS = [
  "algorithm",
  "buildId",
  "dependencyLockSha256",
  "executableTreeSha256",
  "packageJsonSha256",
  "schemaVersion",
] as const;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const listExecutableFiles = (
  buildDirectory: string,
  readDirectory: ReadDirectory,
): string[] => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readDirectory(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(path);
      }
    }
  };
  visit(buildDirectory);
  return files.sort((left, right) => {
    const leftRelative = relative(buildDirectory, left).split(sep).join("/");
    const rightRelative = relative(buildDirectory, right).split(sep).join("/");
    return leftRelative < rightRelative
      ? -1
      : leftRelative > rightRelative
        ? 1
        : 0;
  });
};

export function computeExternalAgentExecutableTreeSha256(input: {
  buildDirectory: string;
  readFile?: ReadFile;
  readDirectory?: ReadDirectory;
}): string {
  const buildDirectory = resolve(input.buildDirectory);
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  const readDirectory = input.readDirectory ?? readdirSync;
  const files = listExecutableFiles(buildDirectory, readDirectory);
  if (files.length === 0) {
    throw new Error("external agent build contains no executable JavaScript");
  }
  const digest = createHash("sha256");
  digest.update("hyperia-external-agent-js-tree-v1\n");
  for (const path of files) {
    const relativePath = relative(buildDirectory, path).split(sep).join("/");
    digest.update(`${relativePath}\0${sha256(readFile(path))}\n`);
  }
  return digest.digest("hex");
}

export function computeExternalAgentBuildId(input: {
  executableTreeSha256: string;
  packageJsonSha256: string;
  dependencyLockSha256: string;
}): string {
  for (const digest of [
    input.executableTreeSha256,
    input.packageJsonSha256,
    input.dependencyLockSha256,
  ]) {
    if (!SHA256_HEX.test(digest)) {
      throw new Error("external agent build artifact digest is invalid");
    }
  }
  return sha256(
    [
      "hyperia-external-agent-build-v1",
      input.executableTreeSha256,
      input.packageJsonSha256,
      input.dependencyLockSha256,
    ].join("\n"),
  );
}

export function createExternalAgentBuildManifest(input: {
  buildDirectory: string;
  packageJsonPath: string;
  dependencyLockPath: string;
  readFile?: ReadFile;
  readDirectory?: ReadDirectory;
}): ExternalAgentBuildManifest {
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  const executableTreeSha256 = computeExternalAgentExecutableTreeSha256({
    buildDirectory: input.buildDirectory,
    readFile,
    readDirectory: input.readDirectory,
  });
  const packageJsonSha256 = sha256(readFile(resolve(input.packageJsonPath)));
  const dependencyLockSha256 = sha256(
    readFile(resolve(input.dependencyLockPath)),
  );
  return {
    schemaVersion: EXTERNAL_AGENT_BUILD_MANIFEST_VERSION,
    algorithm: "sha256",
    buildId: computeExternalAgentBuildId({
      executableTreeSha256,
      packageJsonSha256,
      dependencyLockSha256,
    }),
    executableTreeSha256,
    packageJsonSha256,
    dependencyLockSha256,
  };
}

const parseExternalAgentBuildManifest = (
  raw: string,
): ExternalAgentBuildManifest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("external agent build manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("external agent build manifest is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== MANIFEST_KEYS.length ||
    keys.some((key, index) => key !== MANIFEST_KEYS[index]) ||
    record.schemaVersion !== EXTERNAL_AGENT_BUILD_MANIFEST_VERSION ||
    record.algorithm !== "sha256" ||
    typeof record.buildId !== "string" ||
    typeof record.executableTreeSha256 !== "string" ||
    typeof record.packageJsonSha256 !== "string" ||
    typeof record.dependencyLockSha256 !== "string"
  ) {
    throw new Error("external agent build manifest shape is invalid");
  }
  const manifest = record as ExternalAgentBuildManifest;
  if (
    !SHA256_HEX.test(manifest.buildId) ||
    !SHA256_HEX.test(manifest.executableTreeSha256) ||
    !SHA256_HEX.test(manifest.packageJsonSha256) ||
    !SHA256_HEX.test(manifest.dependencyLockSha256)
  ) {
    throw new Error("external agent build manifest digest is invalid");
  }
  return manifest;
};

export function resolveExternalAgentExecutableBuildIdentity(input: {
  moduleUrl: string;
  nodeEnv: string | undefined;
  fileExists?: (path: string) => boolean;
  readFile?: ReadFile;
  readDirectory?: ReadDirectory;
}): ExternalAgentExecutableBuildIdentity {
  const modulePath = fileURLToPath(input.moduleUrl);
  const buildDirectory = dirname(modulePath);
  const manifestPath = resolve(buildDirectory, "external-agent-build.json");
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? (readFileSync as ReadFile);
  if (!fileExists(manifestPath)) {
    if (input.nodeEnv === "production" || input.nodeEnv === "staging") {
      throw new Error(
        "external agent build manifest is required in production and staging",
      );
    }
    return {
      buildId: sha256(
        `hyperia-external-agent-unverified-source-v1:${input.nodeEnv || "development"}`,
      ),
      verified: false,
    };
  }
  if (
    resolve(modulePath) !==
    resolve(buildDirectory, "externalAgentBuildIdentity.js")
  ) {
    throw new Error(
      "external agent build manifest is not beside the running module",
    );
  }
  const manifest = parseExternalAgentBuildManifest(
    readFile(manifestPath, "utf8"),
  );
  const actual = createExternalAgentBuildManifest({
    buildDirectory,
    packageJsonPath: resolve(buildDirectory, "../package.json"),
    dependencyLockPath: resolve(buildDirectory, "../../../bun.lock"),
    readFile,
    readDirectory: input.readDirectory,
  });
  if (
    actual.executableTreeSha256 !== manifest.executableTreeSha256 ||
    actual.packageJsonSha256 !== manifest.packageJsonSha256 ||
    actual.dependencyLockSha256 !== manifest.dependencyLockSha256 ||
    actual.buildId !== manifest.buildId
  ) {
    throw new Error("external agent executable does not match its manifest");
  }
  return { buildId: actual.buildId, verified: true };
}

let cachedIdentity: ExternalAgentExecutableBuildIdentity | null = null;

export function getExternalAgentExecutableBuildIdentity(): ExternalAgentExecutableBuildIdentity {
  if (cachedIdentity) return cachedIdentity;
  cachedIdentity = resolveExternalAgentExecutableBuildIdentity({
    moduleUrl: import.meta.url,
    nodeEnv: process.env.NODE_ENV,
  });
  return cachedIdentity;
}
