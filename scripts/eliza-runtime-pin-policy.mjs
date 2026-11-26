#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXPECTED_ELIZA_RUNTIME_VERSIONS = Object.freeze({
  "@elizaos/core": "2.0.0-alpha.537",
  "@elizaos/plugin-anthropic": "2.0.0-alpha.537",
  "@elizaos/plugin-goals": "2.0.0-alpha.10",
  "@elizaos/plugin-groq": "2.0.0-alpha.10",
  "@elizaos/plugin-openai": "2.0.0-alpha.537",
  "@elizaos/plugin-sql": "2.0.0-alpha.20",
});

const REQUIRED_MANIFEST_PINS = Object.freeze({
  "package.json": [
    "@elizaos/core",
    "@elizaos/plugin-anthropic",
    "@elizaos/plugin-groq",
    "@elizaos/plugin-openai",
    "@elizaos/plugin-sql",
  ],
  "packages/plugin-hyperia/package.json": [
    "@elizaos/core",
    "@elizaos/plugin-anthropic",
    "@elizaos/plugin-openai",
    "@elizaos/plugin-sql",
  ],
  "packages/server/package.json": [
    "@elizaos/core",
    "@elizaos/plugin-anthropic",
    "@elizaos/plugin-goals",
    "@elizaos/plugin-groq",
    "@elizaos/plugin-openai",
    "@elizaos/plugin-sql",
  ],
});

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
];

const FORBIDDEN_DIRECT_PROVIDER_PACKAGES = new Set([
  "@openrouter/ai-sdk-provider",
]);

const PROVIDER_POLICY_SOURCE_FILES = [
  "packages/client/src/components/streaming/DuelInfoPanel.tsx",
  "packages/client/src/game/dashboard/AgentSettings.tsx",
  "packages/client/src/screens/CharacterEditorScreen.tsx",
  "packages/client/src/utils/characterTemplate.ts",
  "packages/plugin-hyperia/character.ts",
  "packages/server/src/eliza/AgentManager.ts",
  "packages/server/src/eliza/ModelAgentSpawner.ts",
  "packages/server/src/eliza/agentHelpers.ts",
  "packages/server/src/eliza/index.ts",
  "packages/server/src/eliza/types.ts",
  "packages/server/src/startup/routes/agent-routes.ts",
];

const FORBIDDEN_PROVIDER_MARKER = /\b(?:elizacloud|ollama|openrouter|xai)\b/iu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isExactVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u.test(
    String(value ?? ""),
  );
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function packageManifestPaths(root) {
  const packageRoot = path.join(root, "packages");
  const workspaceManifests = fs
    .readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "package.json"))
    .filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
  return ["package.json", ...workspaceManifests].sort();
}

export function auditElizaRuntimePins(root) {
  const violations = [];
  const manifestPaths = packageManifestPaths(root);

  for (const relativePath of manifestPaths) {
    const manifest = readJson(root, relativePath);
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const [name, actualVersion] of Object.entries(dependencies)) {
        if (
          (name.startsWith("@elizaos/") &&
            !(name in EXPECTED_ELIZA_RUNTIME_VERSIONS)) ||
          FORBIDDEN_DIRECT_PROVIDER_PACKAGES.has(name)
        ) {
          violations.push({
            file: relativePath,
            section,
            package: name,
            expected: "not declared by a launch workspace",
            actual: String(actualVersion),
          });
        }
      }
      for (const [name, expectedVersion] of Object.entries(
        EXPECTED_ELIZA_RUNTIME_VERSIONS,
      )) {
        if (!(name in dependencies)) continue;
        const actualVersion = dependencies[name];
        if (
          !isExactVersion(actualVersion) ||
          actualVersion !== expectedVersion
        ) {
          violations.push({
            file: relativePath,
            section,
            package: name,
            expected: expectedVersion,
            actual: String(actualVersion),
          });
        }
      }
    }
  }

  for (const relativePath of PROVIDER_POLICY_SOURCE_FILES) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const match = source.match(FORBIDDEN_PROVIDER_MARKER);
    if (match) {
      violations.push({
        file: relativePath,
        section: "provider-policy",
        package: match[0],
        expected: "openai, anthropic, or groq only",
        actual: match[0],
      });
    }
  }

  for (const [relativePath, requiredPackages] of Object.entries(
    REQUIRED_MANIFEST_PINS,
  )) {
    const manifest = readJson(root, relativePath);
    const declared = Object.assign(
      {},
      ...DEPENDENCY_SECTIONS.map((section) => manifest[section] ?? {}),
    );
    for (const name of requiredPackages) {
      if (declared[name] !== EXPECTED_ELIZA_RUNTIME_VERSIONS[name]) {
        violations.push({
          file: relativePath,
          section: "required",
          package: name,
          expected: EXPECTED_ELIZA_RUNTIME_VERSIONS[name],
          actual: String(declared[name] ?? "missing"),
        });
      }
    }
  }

  const rootManifest = readJson(root, "package.json");
  for (const name of REQUIRED_MANIFEST_PINS["package.json"]) {
    const expectedVersion = EXPECTED_ELIZA_RUNTIME_VERSIONS[name];
    if (rootManifest.overrides?.[name] !== expectedVersion) {
      violations.push({
        file: "package.json",
        section: "overrides",
        package: name,
        expected: expectedVersion,
        actual: String(rootManifest.overrides?.[name] ?? "missing"),
      });
    }
  }

  const lockSource = fs.readFileSync(path.join(root, "bun.lock"), "utf8");
  for (const [name, version] of Object.entries(
    EXPECTED_ELIZA_RUNTIME_VERSIONS,
  )) {
    const resolution = new RegExp(
      `"${escapeRegExp(name)}": \\["${escapeRegExp(name)}@${escapeRegExp(version)}"`,
      "u",
    );
    if (!resolution.test(lockSource)) {
      violations.push({
        file: "bun.lock",
        section: "packages",
        package: name,
        expected: version,
        actual: "missing exact resolution",
      });
    }
  }

  return {
    ok: violations.length === 0,
    manifestCount: manifestPaths.length,
    providerPolicySourceCount: PROVIDER_POLICY_SOURCE_FILES.length,
    pinnedPackageCount: Object.keys(EXPECTED_ELIZA_RUNTIME_VERSIONS).length,
    violations,
  };
}

function isDirectInvocation() {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint &&
    import.meta.url === pathToFileURL(path.resolve(entrypoint)).href,
  );
}

if (isDirectInvocation()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = auditElizaRuntimePins(root);
  const output = JSON.stringify(result, null, 2);
  if (!result.ok) {
    console.error(output);
    process.exitCode = 1;
  } else {
    console.log(output);
  }
}
