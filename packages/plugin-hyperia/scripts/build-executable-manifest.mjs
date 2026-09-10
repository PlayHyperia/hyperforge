import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = resolve(pluginRoot, "dist");
const identityModulePath = resolve(
  buildDirectory,
  "externalAgentBuildIdentity.js",
);
const identity = await import(pathToFileURL(identityModulePath).href);
const manifest = identity.createExternalAgentBuildManifest({
  buildDirectory,
  packageJsonPath: resolve(pluginRoot, "package.json"),
  dependencyLockPath: resolve(pluginRoot, "../../bun.lock"),
});
writeFileSync(
  resolve(buildDirectory, "external-agent-build.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
const verified = identity.resolveExternalAgentExecutableBuildIdentity({
  moduleUrl: pathToFileURL(identityModulePath).href,
  nodeEnv: "production",
});
if (!verified.verified || verified.buildId !== manifest.buildId) {
  throw new Error("external agent build manifest did not verify after write");
}
console.log(`External agent executable build manifest: ${manifest.buildId}`);
