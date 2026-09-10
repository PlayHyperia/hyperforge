import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";

// Installation/provenance tests, not a substitute for actual WebGPU rendering.
const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const packageRoot = resolve(dirname(require.resolve("three/webgpu")), "..");
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const expected = {
  "src/renderers/webgpu/WebGPUBackend.js":
    "c31501180c9f3448041e89bf2d2574782e70a82e5925136f7a5040e69425117d",
  "build/three.webgpu.js":
    "9322a909a8a67d4548a8c3d68bc1db27e331031e7d8f06b8ad76b1e7fe5b7442",
  "build/three.webgpu.nodes.js":
    "109d40d380a9b141f7d0efa04fd389fc3c25f1bb73ec1140301a0de28ead9cc3",
};

test("the exact Three version has a durable Bun lifecycle patch", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root)));
  const installed = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json")),
  );
  assert.equal(installed.version, "0.183.2");
  assert.equal(manifest.overrides.three, installed.version);
  assert.equal(
    manifest.patchedDependencies["three@0.183.2"],
    "patches/three@0.183.2.patch",
  );
  assert.equal(
    hash(new URL("patches/three@0.183.2.patch", root)),
    "2fea19cde14e9dea24926af325de72e6a5b2d11b3dc7f3cba71c736390f337af",
  );
});

test("public WebGPU imports resolve to the patched distributed entries", () => {
  assert.equal(
    require.resolve("three/webgpu"),
    resolve(packageRoot, "build/three.webgpu.js"),
  );
  assert.equal(
    require.resolve("three/src/Three.WebGPU.js"),
    resolve(packageRoot, "src/Three.WebGPU.js"),
  );
});

for (const [file, sha256] of Object.entries(expected)) {
  test(`installed ${file} has the reviewed lifecycle fix`, () => {
    assert.equal(hash(resolve(packageRoot, file)), sha256);
  });
}
