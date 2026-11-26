import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  createExternalAgentBuildManifest,
  resolveExternalAgentExecutableBuildIdentity,
} from "../externalAgentBuildIdentity.js";

const temporaryDirectories: string[] = [];

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "hyperia-external-build-"));
  temporaryDirectories.push(root);
  const pluginRoot = resolve(root, "packages", "plugin-hyperia");
  const buildDirectory = resolve(pluginRoot, "dist");
  mkdirSync(resolve(buildDirectory, "services"), { recursive: true });
  writeFileSync(
    resolve(buildDirectory, "externalAgentBuildIdentity.js"),
    "export const identity = true;\n",
  );
  writeFileSync(
    resolve(buildDirectory, "services", "HyperiaService.js"),
    "export const service = true;\n",
  );
  writeFileSync(resolve(pluginRoot, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(resolve(root, "bun.lock"), "fixture-lock\n");
  const moduleUrl = pathToFileURL(
    resolve(buildDirectory, "externalAgentBuildIdentity.js"),
  ).href;
  return { root, pluginRoot, buildDirectory, moduleUrl };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("external agent executable build identity", () => {
  it("verifies one deterministic exact executable tree and dependency boundary", () => {
    const { root, pluginRoot, buildDirectory, moduleUrl } = fixture();
    const manifest = createExternalAgentBuildManifest({
      buildDirectory,
      packageJsonPath: resolve(pluginRoot, "package.json"),
      dependencyLockPath: resolve(root, "bun.lock"),
    });
    writeFileSync(
      resolve(buildDirectory, "external-agent-build.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    expect(
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "production",
      }),
    ).toEqual({ buildId: manifest.buildId, verified: true });
    expect(
      createExternalAgentBuildManifest({
        buildDirectory,
        packageJsonPath: resolve(pluginRoot, "package.json"),
        dependencyLockPath: resolve(root, "bun.lock"),
      }),
    ).toEqual(manifest);
  });

  it("rejects executable, package, lock, manifest, and module-location drift", () => {
    const { root, pluginRoot, buildDirectory, moduleUrl } = fixture();
    const manifest = createExternalAgentBuildManifest({
      buildDirectory,
      packageJsonPath: resolve(pluginRoot, "package.json"),
      dependencyLockPath: resolve(root, "bun.lock"),
    });
    const manifestPath = resolve(buildDirectory, "external-agent-build.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(
      resolve(buildDirectory, "services", "HyperiaService.js"),
      "export const service = false;\n",
    );
    expect(() =>
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "production",
      }),
    ).toThrow("does not match its manifest");

    writeFileSync(
      resolve(buildDirectory, "services", "HyperiaService.js"),
      "export const service = true;\n",
    );
    writeFileSync(resolve(pluginRoot, "package.json"), '{"name":"drifted"}\n');
    expect(() =>
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "production",
      }),
    ).toThrow("does not match its manifest");

    writeFileSync(resolve(pluginRoot, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(resolve(root, "bun.lock"), "drifted-lock\n");
    expect(() =>
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "production",
      }),
    ).toThrow("does not match its manifest");

    writeFileSync(resolve(root, "bun.lock"), "fixture-lock\n");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(manifestPath, "utf8")),
        extra: true,
      }),
    );
    expect(() =>
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "production",
      }),
    ).toThrow("shape is invalid");
    expect(() =>
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl: pathToFileURL(
          resolve(buildDirectory, "services", "HyperiaService.js"),
        ).href,
        nodeEnv: "production",
        fileExists: () => true,
      }),
    ).toThrow("not beside the running module");
  });

  it("fails closed without a deployment manifest and labels source use unverified", () => {
    const { moduleUrl } = fixture();
    expect(() =>
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "production",
      }),
    ).toThrow("required in production and staging");
    expect(() =>
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "staging",
      }),
    ).toThrow("required in production and staging");
    expect(
      resolveExternalAgentExecutableBuildIdentity({
        moduleUrl,
        nodeEnv: "test",
      }),
    ).toMatchObject({
      verified: false,
      buildId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });
});
