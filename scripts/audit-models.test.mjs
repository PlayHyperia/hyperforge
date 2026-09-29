import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  auditModels,
  categorizeModel,
  collectModels,
  inspectModel,
  parseOptions,
  summarizeModelDocument,
} from "./audit-models.mjs";

const cli = new URL("./audit-models.mjs", import.meta.url);
function document(triangles = 2) {
  return {
    asset: { version: "2.0" },
    accessors: [{ count: triangles * 3, type: "VEC3", componentType: 5126 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}
function glb(doc) {
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const out = Buffer.alloc(20 + padded.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(out, 20);
  return out;
}
function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "hyperia-model-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function file(dir, name, doc = document()) {
  const filename = path.join(dir, name);
  writeFileSync(
    filename,
    path.extname(name) === ".gltf" ? JSON.stringify(doc) : glb(doc),
  );
  return filename;
}

test("counts every mesh and primitive, without double-counting shared position storage", () => {
  const d = document(3);
  d.meshes[0].primitives.push({ attributes: { POSITION: 0 } });
  d.meshes.push({ primitives: [{ attributes: { POSITION: 0 } }] });
  d.nodes.push({ mesh: 1 });
  d.scenes[0].nodes.push(1);
  const s = summarizeModelDocument(d);
  assert.equal(s.definitionTriangles, 9);
  assert.equal(s.triangles, 9);
  assert.equal(s.vertices, 9);
  assert.equal(s.primitiveCount, 3);
  assert.equal(s.meshCount, 2);
});

test("accounts for indexed triangles, strip and fan slots", () => {
  const d = document();
  d.accessors.push({ count: 9, type: "SCALAR", componentType: 5123 });
  d.meshes[0].primitives = [4, 5, 6].map((mode) => ({
    attributes: { POSITION: 0 },
    indices: 1,
    mode,
  }));
  assert.equal(summarizeModelDocument(d).triangles, 3 + 7 + 7);
});

test("node copies and GPU instancing cannot hide behind one small shared mesh", () => {
  const d = document(4);
  d.accessors.push({ count: 10, type: "VEC3" });
  d.nodes.push({
    mesh: 0,
    extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } },
  });
  d.scenes[0].nodes.push(1);
  const s = summarizeModelDocument(d);
  assert.equal(s.definitionTriangles, 4);
  assert.equal(s.allNodeTriangles, 44);
  assert.equal(s.maxSceneTriangles, 44);
  assert.equal(s.triangles, 44);
  assert.equal(s.loaderSelectedScene.triangles, 44);
  assert.equal(s.loaderSelectedScene.primitiveOccurrences, 2);
  assert.equal(s.loaderSelectedScene.primitiveInstanceOccurrences, 11);
  assert.deepEqual(
    s.loaderSelectedScene.nodes.map((node) => ({
      index: node.nodeIndex,
      instances: node.instanceCount,
      triangles: node.triangles,
      primitives: node.primitiveOccurrences,
      primitiveInstances: node.primitiveInstanceOccurrences,
    })),
    [
      {
        index: 0,
        instances: 1,
        triangles: 4,
        primitives: 1,
        primitiveInstances: 1,
      },
      {
        index: 1,
        instances: 10,
        triangles: 40,
        primitives: 1,
        primitiveInstances: 10,
      },
    ],
  );
});

test("alternate scenes are reported independently and unused definitions remain in the inventory gate", () => {
  const d = document(3);
  d.meshes.push({ primitives: [{ attributes: { POSITION: 0 } }] });
  d.scenes.push({ nodes: [0] });
  const s = summarizeModelDocument(d);
  assert.deepEqual(s.sceneTriangles, [3, 3]);
  assert.equal(s.triangles, 6);
  assert.equal(s.maxSceneTriangles, 3);
  assert.deepEqual(
    s.meshes.map((mesh) => mesh.triangles),
    [3, 3],
  );
});

test("omitted scene selects scene zero while preserving the historical explicit-default field", (t) => {
  const d = document(3);
  delete d.scene;
  d.meshes[0].name = "selected mesh";
  d.nodes[0].name = "selected node";
  const before = structuredClone(d);
  const s = inspectModel(file(directory(t), "implicit.gltf", d));
  const selected = s.loaderSelectedScene;
  assert.equal(s.defaultSceneTriangles, null);
  assert.equal(s.triangles, 3);
  assert.equal(selected.status, "resolved");
  assert.equal(selected.index, 0);
  assert.equal(selected.basis, "implicit-scene-0");
  assert.equal(selected.triangles, 3);
  assert.equal(selected.primitiveOccurrences, 1);
  assert.equal(selected.primitiveInstanceOccurrences, 1);
  assert.deepEqual(selected.nodes, [
    {
      nodeIndex: 0,
      nodeName: "selected node",
      meshIndex: 0,
      meshName: "selected mesh",
      instanceCount: 1,
      triangles: 3,
      primitiveOccurrences: 1,
      primitiveInstanceOccurrences: 1,
      materialIndices: [],
      usesDefaultMaterial: true,
    },
  ]);
  assert.deepEqual(d, before);
});

test("explicit alternate scene excludes orphan nodes and unused definitions only from the selected census", () => {
  const d = document(3);
  d.accessors.push(
    { count: 60, type: "VEC3", componentType: 5126 },
    { count: 15, type: "VEC3", componentType: 5126 },
    { count: 21, type: "VEC3", componentType: 5126 },
  );
  d.meshes.push(
    { name: "orphan mesh", primitives: [{ attributes: { POSITION: 1 } }] },
    { name: "selected mesh", primitives: [{ attributes: { POSITION: 2 } }] },
    {
      name: "unused definition",
      primitives: [{ attributes: { POSITION: 3 } }],
    },
  );
  d.nodes.push({ mesh: 1, name: "orphan" }, { children: [3] }, { mesh: 2 });
  d.scenes.push({ nodes: [2] });
  d.scene = 1;
  const s = summarizeModelDocument(d);
  assert.equal(s.definitionTriangles, 35);
  assert.equal(s.allNodeTriangles, 28);
  assert.equal(s.triangles, 35);
  assert.deepEqual(s.sceneTriangles, [3, 5]);
  assert.equal(s.defaultSceneTriangles, 5);
  assert.equal(s.loaderSelectedScene.index, 1);
  assert.equal(s.loaderSelectedScene.basis, "explicit-scene");
  assert.equal(s.loaderSelectedScene.triangles, 5);
  assert.deepEqual(
    s.loaderSelectedScene.nodes.map((node) => node.nodeIndex),
    [3],
  );
});

test("two selected nodes referencing one mesh count both occurrences through a parent hierarchy", () => {
  const d = document(3);
  d.meshes[0].primitives.push({ attributes: { POSITION: 0 } });
  d.nodes.push({ mesh: 0 }, { children: [0, 1] });
  d.scenes[0].nodes = [2];
  const s = summarizeModelDocument(d);
  assert.equal(s.definitionTriangles, 6);
  assert.equal(s.loaderSelectedScene.triangles, 12);
  assert.equal(s.loaderSelectedScene.primitiveOccurrences, 4);
  assert.equal(s.loaderSelectedScene.primitiveInstanceOccurrences, 4);
  assert.deepEqual(
    s.loaderSelectedScene.nodes.map((node) => node.meshIndex),
    [0, 0],
  );
});

test("selected materials count unique source slots and one implicit default, not runtime clones", () => {
  const d = document();
  d.materials = [{ name: "used" }, { name: "unused" }];
  d.meshes[0].primitives.push({ attributes: { POSITION: 0 }, material: 0 });
  d.nodes.push({ mesh: 0 });
  d.scenes[0].nodes.push(1);
  const s = summarizeModelDocument(d);
  assert.equal(s.materialCount, 1); // Existing definition field stays unchanged.
  assert.equal(s.loaderSelectedScene.materialCount, 2);
  assert.deepEqual(s.loaderSelectedScene.materialIndices, [0]);
  assert.equal(s.loaderSelectedScene.usesDefaultMaterial, true);
  for (const node of s.loaderSelectedScene.nodes) {
    assert.deepEqual(node.materialIndices, [0]);
    assert.equal(node.usesDefaultMaterial, true);
  }
  const noMaterials = summarizeModelDocument(document());
  assert.equal(noMaterials.materialCount, 0);
  assert.equal(noMaterials.loaderSelectedScene.materialCount, 1);
  assert.equal(noMaterials.loaderSelectedScene.usesDefaultMaterial, true);
  d.meshes[0].primitives[0].material = 0;
  const explicitOnly = summarizeModelDocument(d).loaderSelectedScene;
  assert.equal(explicitOnly.materialCount, 1);
  assert.equal(explicitOnly.usesDefaultMaterial, false);
  assert.match(explicitOnly.scope, /not visibility, actual draw calls/);
  assert.match(explicitOnly.scope, /alternative library-mesh selection/);
});

test("missing scenes leave the loader-selected census unresolved, including animation-only data", () => {
  for (const animated of [false, true]) {
    const d = document();
    delete d.scene;
    delete d.scenes;
    if (animated) {
      delete d.meshes;
      delete d.nodes[0].mesh;
      d.animations = [{ channels: [], samplers: [] }];
    }
    const s = summarizeModelDocument(d);
    assert.equal(s.contentKind, animated ? "animation-only" : "mesh-asset");
    assert.equal(s.triangles, animated ? 0 : 2);
    assert.equal(s.loaderSelectedScene.status, "unresolved-no-scenes");
    assert.equal(s.loaderSelectedScene.basis, "no-scenes");
    for (const key of [
      "index",
      "triangles",
      "primitiveOccurrences",
      "primitiveInstanceOccurrences",
      "materialCount",
      "materialIndices",
      "usesDefaultMaterial",
      "nodes",
    ])
      assert.equal(s.loaderSelectedScene[key], null, key);
  }
});

test("an existing empty selected scene is distinct from an unresolved absent scene", () => {
  const d = document(3);
  d.scenes.push({});
  d.scene = 1;
  const s = summarizeModelDocument(d);
  assert.equal(s.triangles, 3);
  assert.equal(s.loaderSelectedScene.status, "resolved");
  assert.equal(s.loaderSelectedScene.index, 1);
  assert.equal(s.loaderSelectedScene.triangles, 0);
  assert.equal(s.loaderSelectedScene.primitiveOccurrences, 0);
  assert.equal(s.loaderSelectedScene.primitiveInstanceOccurrences, 0);
  assert.equal(s.loaderSelectedScene.materialCount, 0);
  assert.deepEqual(s.loaderSelectedScene.nodes, []);
});

test("animation-only documents are explicit non-geometry entries, not inspection failures", (t) => {
  const dir = directory(t),
    d = document();
  delete d.meshes;
  delete d.nodes[0].mesh;
  d.animations = [{ channels: [], samplers: [] }];
  const filename = file(dir, "motion.glb", d);
  const result = auditModels([filename]);
  assert.equal(result.models[0].contentKind, "animation-only");
  assert.equal(result.models[0].triangles, 0);
  assert.equal(result.models[0].budgetApplicable, false);
  assert.equal(result.summary.inspectionErrors, 0);
  assert.equal(result.models[0].loaderSelectedScene.status, "resolved");
  assert.equal(result.models[0].loaderSelectedScene.triangles, 0);
  assert.equal(result.models[0].loaderSelectedScene.materialCount, 0);
});

test("skin, morph, material and compressed metadata is reported without invoking a decoder", () => {
  const d = document();
  d.materials = [{}, {}];
  d.meshes[0].primitives[0].material = 1;
  d.meshes[0].primitives[0].attributes.JOINTS_0 = 0;
  d.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
  d.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} };
  d.bufferViews = [{ extensions: { EXT_meshopt_compression: {} } }];
  d.images = [{ mimeType: "image/ktx2" }, { uri: "albedo.webp" }, {}];
  d.extensions = { VRMC_vrm: {} };
  const s = summarizeModelDocument(d);
  assert.equal(s.skinnedPrimitiveCount, 1);
  assert.equal(s.morphPrimitiveCount, 1);
  assert.equal(s.materialCount, 1);
  assert.equal(s.vrm, true);
  assert.deepEqual(s.textureFormats, [".webp", "image/ktx2", "unknown"]);
  assert.deepEqual(s.extensions, [
    "EXT_meshopt_compression",
    "KHR_draco_mesh_compression",
  ]);
});

test("invalid or unsupported primitive metadata never silently counts as zero", () => {
  const bad = [
    (d) => {
      delete d.meshes[0].primitives[0].attributes.POSITION;
    },
    (d) => {
      d.accessors[0].count = 8;
    },
    (d) => {
      d.accessors[0].count = 0;
    },
    (d) => {
      d.accessors[0].type = "SCALAR";
    },
    (d) => {
      d.meshes[0].primitives[0].mode = 1;
    },
    (d) => {
      d.meshes[0].primitives[0].indices = 99;
    },
    (d) => {
      d.meshes[0].primitives[0].material = 99;
    },
    (d) => {
      d.meshes[0].primitives = [];
    },
    (d) => {
      d.meshes = [];
    },
  ];
  for (const change of bad) {
    const d = document();
    change(d);
    assert.throws(() => summarizeModelDocument(d));
  }
});

test("invalid indices types/counts are rejected", () => {
  for (const entry of [
    { count: 6, type: "VEC3", componentType: 5123 },
    { count: 6, type: "SCALAR", componentType: 5126 },
    { count: 7, type: "SCALAR", componentType: 5123 },
  ]) {
    const d = document();
    d.accessors.push(entry);
    d.meshes[0].primitives[0].indices = 1;
    assert.throws(() => summarizeModelDocument(d));
  }
});

test("invalid scene references, cycles and multiple parents cannot yield partial counts", () => {
  for (const change of [
    (d) => {
      d.nodes[0].mesh = 99;
    },
    (d) => {
      d.scene = 99;
    },
    (d) => {
      d.scene = null;
    },
    (d) => {
      d.scene = "0";
    },
    (d) => {
      d.scene = 0.5;
    },
    (d) => {
      d.scene = -1;
    },
    (d) => {
      d.nodes[0].children = [0];
    },
    (d) => {
      d.nodes.push({ children: [0] });
      d.nodes[0].children = [1];
    },
    (d) => {
      d.nodes.push({ children: [0] }, { children: [0] });
    },
    (d) => {
      d.scenes[0].nodes = [0, 0];
    },
    (d) => {
      d.scenes[0].nodes = [99];
    },
  ]) {
    const d = document();
    change(d);
    assert.throws(() => summarizeModelDocument(d));
  }
});

test("GPU instance metadata must have consistent finite positive counts", () => {
  for (const counts of [[], [3, 4], [0], [Number.MAX_SAFE_INTEGER]]) {
    const d = document(3);
    const attributes = {};
    counts.forEach((count, index) => {
      attributes[index ? "SCALE" : "TRANSLATION"] = d.accessors.length;
      d.accessors.push({ count });
    });
    d.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes } };
    assert.throws(() => summarizeModelDocument(d));
  }
});

test("GLB, glTF and VRM files are read directly and leave original bytes intact", (t) => {
  const dir = directory(t);
  for (const name of ["rock.glb", "tree.gltf", "avatar.vrm"]) {
    const filename = file(dir, name);
    const before = readFileSync(filename);
    const s = inspectModel(filename);
    assert.equal(s.triangles, 2);
    assert.equal(s.sha256.length, 64);
    assert.deepEqual(readFileSync(filename), before);
  }
});

test("truncated GLB after an otherwise readable JSON chunk fails", (t) => {
  const dir = directory(t),
    filename = file(dir, "bad.glb");
  const input = readFileSync(filename),
    bad = Buffer.concat([input, Buffer.alloc(8)]);
  bad.writeUInt32LE(bad.length, 8);
  bad.writeUInt32LE(100, input.length);
  bad.writeUInt32LE(0x004e4942, input.length + 4);
  writeFileSync(filename, bad);
  assert.throws(() => inspectModel(filename), /truncated/);
});

test("collects LODs and uppercase extensions, deduplicates explicit inputs", (t) => {
  const dir = directory(t);
  const base = file(dir, "sword.glb");
  file(dir, "sword_lod1.glb");
  file(dir, "sword_lod2.GLB");
  mkdirSync(path.join(dir, "sub"));
  file(path.join(dir, "sub"), "tree.vrm");
  assert.equal(collectModels([dir, base]).length, 4);
});

test("empty, missing and nested-symlink scopes fail instead of silently skipping coverage", (t) => {
  const dir = directory(t);
  assert.throws(() => collectModels([dir]), /empty coverage/);
  assert.throws(() => collectModels([path.join(dir, "absent")]));
  const base = file(dir, "base.glb");
  symlinkSync(base, path.join(dir, "alias.glb"));
  assert.throws(() => collectModels([dir]), /symlink/);
  assert.equal(collectModels([path.join(dir, "alias.glb")]).length, 1);
});

test("over-budget and unreadable models fail the report, retaining each error", (t) => {
  const dir = directory(t),
    base = file(dir, "rock.glb", document(4));
  const invalid = path.join(dir, "invalid.glb");
  writeFileSync(invalid, "bad");
  const r = auditModels([base, invalid], { maxTriangles: 3 });
  assert.deepEqual(r.summary, {
    total: 2,
    passed: 0,
    failed: 2,
    inspectionErrors: 1,
  });
  assert.throws(() => auditModels([]));
  assert.equal(r.models[0].triangles, 4);
});

test("CLI JSON has no progress chatter and fails inspection errors", (t) => {
  const dir = directory(t),
    base = file(dir, "rock.glb");
  const result = spawnSync(
    process.execPath,
    [cli.pathname, "--json", "--max-triangles", "1", base],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).summary.failed, 1);
  assert.equal(result.stderr, "");
  const missing = spawnSync(
    process.execPath,
    [cli.pathname, "--json", path.join(dir, "absent")],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).summary.inspectionErrors, 1);
});

test("CLI passing threshold and fix guidance never mutate input", (t) => {
  const dir = directory(t),
    base = file(dir, "rock.glb");
  const before = readFileSync(base);
  const result = spawnSync(
    process.execPath,
    [cli.pathname, "--json", "--fix", "--max-triangles", "2", base],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).summary.passed, 1);
  assert.match(
    JSON.parse(result.stdout).optimizationGuidance,
    /No files changed/,
  );
  assert.deepEqual(readFileSync(base), before);
});

test("explicit caps are validated and VRM classification wins over filename substrings", () => {
  for (const args of [
    ["--max-triangles"],
    ["--max-triangles", "NaN"],
    ["--max-triangles", "0"],
    ["--wat"],
  ])
    assert.throws(() => parseOptions(args));
  assert.deepEqual(categorizeModel("armored-knight.vrm"), {
    category: "avatar",
    limit: 20000,
  });
  assert.equal(categorizeModel("bronze_pickaxe_lod2.glb").limit, 10000);
  assert.equal(parseOptions(["--max-triangles", "100"]).maxTriangles, 100);
});
