import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const owners = [
  ".",
  "packages/shared",
  "packages/client",
  "packages/server",
  "packages/procgen",
  "packages/impostors",
  "packages/asset-forge",
  "packages/plugin-hyperia",
  "packages/website",
];
const packageRoot = (require) =>
  realpathSync(resolve(dirname(require.resolve("three")), ".."));

test("all renderer owners and VRM peers resolve one installed r186 package", async () => {
  const require = createRequire(resolve(root, "package.json"));
  const canonical = packageRoot(require);
  const core = await import(
    pathToFileURL(resolve(canonical, "build/three.module.js"))
  );
  assert.equal(core.REVISION, "186");
  for (const owner of owners) {
    const ownerRequire = createRequire(resolve(root, owner, "package.json"));
    const actual = packageRoot(ownerRequire);
    assert.equal(actual, canonical, owner);
    const metadata = JSON.parse(readFileSync(resolve(actual, "package.json")));
    assert.equal(metadata.version, "0.186.0", owner);
    const gpu = await import(
      pathToFileURL(ownerRequire.resolve("three/webgpu"))
    );
    const tsl = await import(pathToFileURL(ownerRequire.resolve("three/tsl")));
    assert.equal(gpu.Object3D, core.Object3D, owner);
    assert.equal(gpu.BufferGeometry, core.BufferGeometry, owner);
    assert.equal(gpu.Material, core.Material, owner);
    assert.equal(tsl.uniform, gpu.TSL.uniform, owner);
  }
  const vrmRequire = createRequire(
    realpathSync(require.resolve("@pixiv/three-vrm")),
  );
  assert.equal(packageRoot(vrmRequire), canonical, "VRM runtime peer");
  for (const name of [
    "@pixiv/three-vrm-core",
    "@pixiv/three-vrm-materials-mtoon",
  ]) {
    const peerRequire = createRequire(realpathSync(vrmRequire.resolve(name)));
    assert.equal(packageRoot(peerRequire), canonical, name);
  }
});

// This guards installed Node/ESM identity. It does not certify Vite's bundle graph,
// shader compilation, avatar deformation, browser performance or stream output.
