import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import * as GPU from "three/webgpu";
import { mix, pmremTexture, uniform } from "three/tsl";

// Installation/provenance tests, not a substitute for actual WebGPU rendering.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = new URL("../", import.meta.url);
const packageRoot = resolve(dirname(require.resolve("three/webgpu")), "..");
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const expected = {
  "src/renderers/common/Renderer.js":
    "e8bdeff08687cf51f30233487f5a50e2bc0e9d3dbc53d2d0bcc66876a476c876",
  "src/renderers/webgpu/WebGPUBackend.js":
    "f572de154dbce29e906209aa103399d38653b7601c3605b0fce20b0c8d80efb9",
  "build/three.webgpu.js":
    "0c0fb04913a2e0f882eb5380bd71fa73c4cb8cc5df97880cc5f89486f69ebbe7",
  "build/three.webgpu.nodes.js":
    "eebda68b6c53b58260a615853cf0c67817ff5c9005f2c0e1697f07fe5596971e",
  "src/materials/nodes/manager/NodeMaterialObserver.js":
    "fb841e636c424c196a82a727dd1cd57f6f3964fedd548a4bf510d9e38bd86f83",
  "src/nodes/display/ViewportTextureNode.js":
    "af363e3ff1ac9d7103e6e93769bacc7a3547efe1481bcc1a58f12672af14f099",
};

test("the exact Three version has a durable Bun lifecycle patch", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root)));
  const installed = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json")),
  );
  assert.equal(installed.version, "0.186.0");
  assert.equal(manifest.overrides.three, installed.version);
  assert.equal(
    manifest.patchedDependencies["three@0.186.0"],
    "patches/three@0.186.0.patch",
  );
  assert.equal(
    hash(new URL("patches/three@0.186.0.patch", root)),
    "ff83278324a9dc5c0ebf5b8bb9c1ce5f0db45a2b2ed152c022ec81035582f706",
  );
  const patch = readFileSync(
    new URL("patches/three@0.186.0.patch", root),
    "utf8",
  );
  assert.deepEqual(
    [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
      .map((match) => {
        assert.equal(match[1], match[2]);
        return match[1];
      })
      .sort(),
    Object.keys(expected).sort(),
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

// Real CPU-side Three graphs/observers, not renderer or GPU substitutes. A
// stationary PBR draw must refresh inherited dynamic IBL just like an envNode
// assigned directly to its material. Native paired renders verify the result.
test("inherited scene lighting nodes keep stationary PBR bindings live", () => {
  const scene = new GPU.Scene();
  const a = new GPU.RenderTarget(384, 512);
  const b = new GPU.RenderTarget(384, 512);
  const material = new GPU.MeshStandardNodeMaterial();
  const geometry = new GPU.BoxGeometry();
  const mesh = new GPU.Mesh(geometry, material);
  const builder = new GPU.NodeBuilder(mesh, null, null);
  builder.scene = scene;
  builder.environmentNode = scene.environmentNode = mix(
    pmremTexture(a.texture),
    pmremTexture(b.texture),
    uniform(0),
  );
  try {
    assert.equal(material.setupObserver(builder).hasNode, true);
    const physical = new GPU.MeshPhysicalNodeMaterial();
    builder.material = physical;
    assert.equal(physical.setupObserver(builder).hasNode, true);
    physical.dispose();
    builder.material = material;
    material.lights = false;
    assert.equal(material.setupObserver(builder).hasNode, false);
    material.lights = true;
    // An explicit static material environment takes precedence over scene IBL.
    material.envMap = a.texture;
    assert.equal(material.setupObserver(builder).hasNode, false);
    material.envMap = null;
    // Lighting-disabled passes do not inherit the scene environment.
    builder.environmentNode = null;
    assert.equal(material.setupObserver(builder).hasNode, false);
    // Ordinary static scene texture lighting retains the existing fast path.
    scene.environmentNode = null;
    scene.environment = a.texture;
    builder.environmentNode = GPU.TSL.texture(a.texture);
    assert.equal(material.setupObserver(builder).hasNode, false);
    // Directly assigned dynamic nodes already require full updates.
    material.envNode = pmremTexture(a.texture);
    assert.equal(material.setupObserver(builder).hasNode, true);
  } finally {
    material.dispose();
    geometry.dispose();
    a.dispose();
    b.dispose();
  }
});

test("installed disposal clears an existing animation callback without restarting initialization", () => {
  const file = "src/renderers/common/Renderer.js";
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(packageRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const rendererClass = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "Renderer",
  );
  assert.ok(rendererClass);
  const dispose = rendererClass.members.find(
    (node) =>
      ts.isMethodDeclaration(node) && node.name.getText(source) === "dispose",
  );
  assert.ok(dispose?.body);
  assert.ok(
    dispose.modifiers.some((node) => node.kind === ts.SyntaxKind.AsyncKeyword),
  );
  const animationCalls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      assert.notEqual(callee, "this.setAnimationLoop");
      assert.notEqual(callee, "this.init");
      if (callee === "this._animation.setAnimationLoop")
        animationCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(dispose.body);
  assert.equal(animationCalls.length, 1);
  const call = animationCalls[0];
  assert.equal(call.arguments.length, 1);
  assert.equal(call.arguments[0].kind, ts.SyntaxKind.NullKeyword);
  const guard = call.parent.parent;
  assert.ok(ts.isIfStatement(guard));
  assert.equal(guard.expression.getText(source), "this._animation !== null");
});

test("RendererFactory awaits failed-renderer disposal before the default-limit retry", () => {
  const file = "packages/shared/src/utils/rendering/RendererFactory.ts";
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(file, root), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const factory = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "createRenderer",
  );
  assert.ok(factory?.body);
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "renderer.dispose"
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  assert.equal(calls.length, 1);
  assert.ok(ts.isAwaitExpression(calls[0].parent));
});

// Source-contract checks: no renderer/device is fabricated here. Actual filter
// appearance and framebuffer-copy behavior require the real WebGPU browser gate.
for (const [file, expectedParent] of [
  [
    "packages/shared/src/utils/rendering/RendererFactory.ts",
    ts.SyntaxKind.BindingElement,
  ],
  [
    "packages/shared/src/systems/client/ClientGraphics.ts",
    ts.SyntaxKind.PropertyAssignment,
  ],
  [
    "scripts/two-hand-candidate-playback-browser.ts",
    ts.SyntaxKind.BinaryExpression,
  ],
]) {
  test(`${file} explicitly selects the supported WebGPU PCF filter`, () => {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(file, root), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const selections = [];
    const visit = (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "THREE"
      ) {
        assert.notEqual(node.name.text, "PCFSoftShadowMap");
        if (node.name.text === "PCFShadowMap") selections.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(selections.length, 1);
    const selection = selections[0];
    assert.equal(selection.parent.kind, expectedParent);
    if (ts.isBinaryExpression(selection.parent)) {
      assert.equal(
        selection.parent.left.getText(source),
        "renderer.shadowMap.type",
      );
      assert.equal(
        selection.parent.operatorToken.kind,
        ts.SyntaxKind.EqualsToken,
      );
      assert.equal(selection.parent.right, selection);
    } else {
      assert.equal(selection.parent.name.getText(source), "type");
      assert.equal(selection.parent.initializer, selection);
    }
  });
}
