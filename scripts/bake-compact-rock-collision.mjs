import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const source = new URL(
  "../packages/server/world/assets/rocks/compact-outcrops-v1/rock-moss-set.glb",
  import.meta.url,
);
const destination = new URL(
  "../packages/shared/src/data/compact-rock-collision-v1.json",
  import.meta.url,
);
const footprintDestination = new URL(
  "../packages/shared/src/data/compact-rock-footprints-v1.json",
  import.meta.url,
);
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Geometry-only derivative of the exact near meshes, not a simplified proxy.
 * Keep the original float32 positions and uint16 indices; child translations
 * remain explicit so server and visual transforms can be compared independently.
 */
function decodeSource(bytes) {
  assert.equal(
    sha(bytes),
    "62c8c753c57b7108f79c98ee0f1bbb2497c27e3fe55a15979765fa02da184c55",
  );
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const jsonLength = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
  assert.equal(bytes.readUInt32LE(24 + jsonLength), 0x004e4942);
  const bin = bytes.subarray(28 + jsonLength);
  assert.equal(bin.length, bytes.readUInt32LE(20 + jsonLength));
  assert.equal(doc.scenes.length, 1);
  assert.equal(doc.nodes.length, 9);
  const read = (index, type, componentType) => {
    const a = doc.accessors[index],
      v = doc.bufferViews[a.bufferView];
    assert.equal(a.type, type);
    assert.equal(a.componentType, componentType);
    assert(!a.sparse && !a.normalized);
    assert.equal(v.buffer, 0);
    assert.equal(v.byteStride, undefined);
    const count = a.count * (type === "VEC3" ? 3 : 1),
      length = count * (componentType === 5126 ? 4 : 2),
      offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    assert(
      offset >= 0 &&
        length > 0 &&
        (a.byteOffset ?? 0) + length <= v.byteLength &&
        offset + length <= bin.length,
    );
    return {
      count: a.count,
      data: bin.subarray(offset, offset + length).toString("base64"),
    };
  };
  return { doc, read };
}
export function bakeCompactRockCollision(bytes) {
  const { doc, read } = decodeSource(bytes);
  const meshes = ["rock10", "rock11", "rock13"].map((variant) => {
    const node = doc.nodes.find(
      (n) => n.name === `compact-outcrop-${variant}-lod0`,
    );
    assert(node);
    assert(!node.children && !node.rotation && !node.scale && !node.matrix);
    assert(doc.scenes[0].nodes.includes(doc.nodes.indexOf(node)));
    const mesh = doc.meshes[node.mesh];
    assert.equal(mesh.primitives.length, 1);
    const p = mesh.primitives[0];
    assert(p.mode === undefined || p.mode === 4);
    assert(!p.targets);
    const positions = read(p.attributes.POSITION, "VEC3", 5126),
      indices = read(p.indices, "SCALAR", 5123);
    assert.equal(indices.count, 3 * (variant === "rock13" ? 7928 : 8000));
    return {
      variant,
      translation: node.translation ?? [0, 0, 0],
      positions,
      indices,
    };
  });
  return {
    schemaVersion: 1,
    sourceSha256: sha(bytes),
    format: "float32-position-uint16-index-le-base64",
    meshes,
  };
}

/** Small synchronous startup metadata. Hulls enclose the union of ALL three
 * rendered LODs, not just a convenient radius or the near collision silhouette.
 */
export function bakeCompactRockFootprints(bytes) {
  const { doc, read } = decodeSource(bytes);
  const cross = (a, b, c) =>
    (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const footprints = ["rock10", "rock11", "rock13"].map((variant) => {
    const points = [];
    for (let lod = 0; lod < 3; lod++) {
      const node = doc.nodes.find(
        (n) => n.name === `compact-outcrop-${variant}-lod${lod}`,
      );
      assert(
        node && !node.children && !node.rotation && !node.scale && !node.matrix,
      );
      assert(doc.scenes[0].nodes.includes(doc.nodes.indexOf(node)));
      const mesh = doc.meshes[node.mesh];
      assert.equal(mesh.primitives.length, 1);
      const sourcePositions = read(
        mesh.primitives[0].attributes.POSITION,
        "VEC3",
        5126,
      );
      const positions = Buffer.from(sourcePositions.data, "base64");
      for (let i = 0; i < sourcePositions.count; i++)
        points.push({
          x: positions.readFloatLE(i * 12) + (node.translation?.[0] ?? 0),
          z: positions.readFloatLE(i * 12 + 8) + (node.translation?.[2] ?? 0),
        });
    }
    points.sort((a, b) => a.x - b.x || a.z - b.z);
    const chain = (rows) => {
      const result = [];
      for (const p of rows) {
        while (
          result.length >= 2 &&
          cross(result.at(-2), result.at(-1), p) <= 0
        )
          result.pop();
        result.push(p);
      }
      result.pop();
      return result;
    };
    const vertices = [...chain(points), ...chain([...points].reverse())];
    assert(vertices.length >= 3 && vertices.length <= 64);
    return { variant, vertices };
  });
  return { schemaVersion: 1, sourceSha256: sha(bytes), footprints };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, bake] of [
    [destination, bakeCompactRockCollision],
    [footprintDestination, bakeCompactRockFootprints],
  ]) {
    const bytes = Buffer.from(
      JSON.stringify(bake(readFileSync(source)), null, 2) + "\n",
    );
    if (process.argv.includes("--check"))
      assert.deepEqual(readFileSync(path), bytes, "Stale rock derivative");
    else {
      assert.equal(process.argv.length, 2);
      writeFileSync(path, bytes);
    }
    console.log(
      JSON.stringify({
        file: fileURLToPath(path),
        bytes: bytes.length,
        sha256: sha(bytes),
      }),
    );
  }
}
