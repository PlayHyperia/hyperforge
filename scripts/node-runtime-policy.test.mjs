import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertHyperiaNodeVersion,
  HYPERIA_NODE_TYPES_VERSION,
  HYPERIA_NODE_VERSION,
} from "./node-runtime-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("accepts only the exact pinned Node runtime", () => {
  assert.equal(assertHyperiaNodeVersion("v22.23.2"), HYPERIA_NODE_VERSION);
  assert.equal(assertHyperiaNodeVersion("22.23.2"), HYPERIA_NODE_VERSION);

  for (const version of [
    "v22.23.1",
    "v22.24.0",
    "v24.19.0",
    "v25.2.1",
    "v26.0.0",
    "not-a-version",
    "",
  ]) {
    assert.throws(
      () => assertHyperiaNodeVersion(version),
      new RegExp(`requires Node\\.js ${HYPERIA_NODE_VERSION} exactly`),
    );
  }
});

test("keeps local, manifest, container, and server-start pins synchronized", () => {
  assert.equal(read(".node-version").trim(), HYPERIA_NODE_VERSION);
  assert.equal(read(".nvmrc").trim(), HYPERIA_NODE_VERSION);

  const rootManifest = JSON.parse(read("package.json"));
  const serverManifest = JSON.parse(read("packages/server/package.json"));
  assert.equal(rootManifest.engines.node, HYPERIA_NODE_VERSION);
  assert.equal(serverManifest.engines.node, HYPERIA_NODE_VERSION);
  assert.equal(
    rootManifest.overrides["@types/node"],
    HYPERIA_NODE_TYPES_VERSION,
  );
  assert.equal(
    rootManifest.scripts.preinstall,
    "node scripts/node-runtime-policy.mjs",
  );
  assert.equal(
    serverManifest.scripts.prestart,
    "node ../../scripts/node-runtime-policy.mjs",
  );
  assert.equal(
    serverManifest.scripts.start,
    "node --import ./scripts/register-hooks.mjs ../../scripts/start-hyperia-server.mjs",
  );
  assert.equal(
    rootManifest.scripts["server:container:smoke"],
    "node scripts/smoke-server-container.mjs",
  );

  const dockerfile = read("Dockerfile.server");
  assert.match(
    dockerfile,
    new RegExp(
      `FROM node:${HYPERIA_NODE_VERSION}-bookworm-slim AS node-build-tools`,
    ),
  );
  assert.match(
    dockerfile,
    new RegExp(`FROM node:${HYPERIA_NODE_VERSION}-trixie-slim AS runtime`),
  );
  assert.match(
    dockerfile,
    /CMD \["node", "--import", "\/app\/packages\/server\/scripts\/register-hooks\.mjs", "\/app\/scripts\/start-hyperia-server\.mjs"\]/,
  );
  assert.match(dockerfile, /cd \/app\/packages\/impostors && bun run build/);
  assert.match(dockerfile, /cd \/app\/packages\/client && bun run build:cf/);
  assert.doesNotMatch(
    dockerfile,
    /node \.\.\/\.\.\/node_modules\/(?:typescript|vite)\//,
    "container builds must resolve tools through each isolated workspace",
  );
  assert.match(
    dockerfile,
    /ARG HYPERIA_ASSETS_REV=[0-9a-f]{40}/,
    "container assets must be pinned to a full immutable commit",
  );
  assert.match(
    dockerfile,
    /test "\$\(git -C packages\/server\/world\/assets rev-parse HEAD\)" = "\$\{HYPERIA_ASSETS_REV\}"/,
    "container build must verify the resolved asset revision",
  );
  assert.match(
    dockerfile,
    /rm -rf packages\/server\/world\/assets\/\.git/,
    "runtime image must not retain the asset repository metadata",
  );
  assert.match(
    dockerfile,
    /chmod -R a=rX \/app\/packages\/server\/src\/database\/migrations/,
    "migration inputs must be readable regardless of host file modes",
  );
  assert.match(
    dockerfile,
    /USER node[\s\S]*?RUN test -r \/app\/packages\/server\/src\/database\/migrations\/0000_numerous_korvac\.sql[\s\S]*?test ! -w \/app\/packages\/server\/src\/database\/migrations\/0000_numerous_korvac\.sql/,
    "the non-root runtime user must prove migrations are readable and immutable",
  );
  assert.doesNotMatch(
    dockerfile,
    /COPY --from=builder \/app\/packages\/server\/(?:src|scripts)\s+\.\/packages\/server\/(?:src|scripts)/,
    "runtime images must not copy the complete server source or test-harness tree",
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/packages\/server\/scripts\/register-hooks\.mjs[\s\S]*?\/app\/packages\/server\/scripts\/node-esm-hooks\.mjs\s+\.\/packages\/server\/scripts\//,
    "runtime images must copy only the two required Node hook scripts",
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/packages\/server\/src\/database\/migrations\s*\\?\s+\.\/packages\/server\/src\/database\/migrations/,
    "runtime images must retain the complete migration journal",
  );

  const assetInstaller = read("scripts/ensure-assets.mjs");
  assert.match(
    assetInstaller,
    /\^\[0-9a-f\]\{40\}\$\/i/,
    "asset installer must reject non-commit revision selectors",
  );
  assert.match(
    assetInstaller,
    /\[\s*"-C",\s*assetsDir,\s*"fetch",\s*"--depth",\s*"1",\s*"origin",\s*requestedRevision,?\s*\]/,
    "asset installer must fetch the requested immutable commit directly",
  );

  for (const relativePath of [
    "package.json",
    "packages/asset-forge/package.json",
    "packages/client/package.json",
    "packages/decimation/package.json",
    "packages/duel-oracle-evm/package.json",
    "packages/procgen/package.json",
    "packages/server/package.json",
    "packages/shared/package.json",
    "packages/vast-keeper/package.json",
    "packages/web3/package.json",
    "packages/website/package.json",
  ]) {
    const manifest = JSON.parse(read(relativePath));
    assert.equal(
      manifest.devDependencies["@types/node"],
      HYPERIA_NODE_TYPES_VERSION,
      `${relativePath} must use the Node 22 type line`,
    );
  }
});

test("routes production starts through the pre-import attestation wrapper", () => {
  const expectedStartCommand =
    "node --import /app/packages/server/scripts/register-hooks.mjs /app/scripts/start-hyperia-server.mjs";
  for (const relativePath of ["railway.json", "railway.server.json"]) {
    const railwayManifest = JSON.parse(read(relativePath));
    assert.equal(
      railwayManifest.deploy.startCommand,
      expectedStartCommand,
      `${relativePath} must not bypass the attestation wrapper`,
    );
  }

  const serverStart = read("scripts/start-hyperia-server.mjs");
  assert.match(serverStart, /competitiveServerBootstrap\.js/);
  assert.match(serverStart, /verifyCompetitiveServerRuntime/);
  assert.match(serverStart, /startVerifiedCompetitiveServer/);
  assert.match(serverStart, /--preflight-only/);
});

test("makes every Bun workflow select the repository Node pin", () => {
  const workflowsDirectory = path.join(root, ".github", "workflows");
  const workflowNames = fs
    .readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

  for (const name of workflowNames) {
    const source = fs.readFileSync(path.join(workflowsDirectory, name), "utf8");
    if (source.includes("oven-sh/setup-bun")) {
      let bunSetupIndex = source.indexOf("oven-sh/setup-bun");
      while (bunSetupIndex >= 0) {
        const precedingSteps = source.slice(
          Math.max(0, bunSetupIndex - 500),
          bunSetupIndex,
        );
        assert.match(
          precedingSteps,
          /uses: actions\/setup-node@v6[\s\S]*?node-version-file: \.node-version/,
          `${name} must install the pinned Node runtime before every Bun setup`,
        );
        bunSetupIndex = source.indexOf("oven-sh/setup-bun", bunSetupIndex + 1);
      }
    }

    if (source.includes("actions/setup-node")) {
      assert.doesNotMatch(
        source,
        /^\s+node-version:\s/m,
        `${name} must not carry a second inline Node pin`,
      );
      assert.match(
        source,
        /node-version-file: \.node-version/,
        `${name} must use .node-version`,
      );
    }
  }
});

test("keeps the canonical container smoke in CI", () => {
  const integrationWorkflow = read(".github/workflows/integration.yml");
  assert.match(integrationWorkflow, /^ {2}server-container-smoke:$/m);
  assert.match(
    integrationWorkflow,
    /run: node scripts\/smoke-server-container\.mjs/,
  );
});

test("checks the runtime before the duel launcher mutates or builds anything", () => {
  const launcher = read("scripts/duel-stack.mjs");
  const mainBody = launcher.slice(launcher.indexOf("async function main()"));
  const runtimeCheck = mainBody.indexOf(
    "assertSupportedUwsNodeVersion(nodeVersion)",
  );
  const firstOutputMutation = mainBody.indexOf(
    "prepareHlsOutput(hlsOutputPath)",
  );

  assert.ok(runtimeCheck >= 0, "launcher runtime check must exist");
  assert.ok(firstOutputMutation >= 0, "launcher output preparation must exist");
  assert.ok(
    runtimeCheck < firstOutputMutation,
    "runtime check must happen before output preparation",
  );
});
