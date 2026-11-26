import { expect } from "vitest";
import { openSync, closeSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import THREE from "../../../../../extras/three/three";

// Exact hydrated LOD0 GLB headers are read, not model-bounds.json (which omits
// some source node scales). This is conservative transformed declared geometry,
// not alpha silhouettes, wind, decoded GPU data or visual acceptance.
type GlbDocument = {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  }[];
  meshes: {
    primitives: { attributes: { POSITION: number }; indices?: number }[];
  }[];
  accessors: {
    min?: [number, number, number];
    max?: [number, number, number];
    count: number;
  }[];
};
export function modelBounds(asset: string, scale = 1) {
  const relative = asset.replace(/^asset:\/\//, "");
  expect(relative).toMatch(/^models\/(trees|stations)\/[^.]+\.glb$/);
  const filename = fileURLToPath(
    new URL(
      `../../../../../../../server/world/assets/${relative}`,
      import.meta.url,
    ),
  );
  const fd = openSync(filename, "r");
  let document: GlbDocument;
  try {
    const header = Buffer.alloc(20);
    expect(readSync(fd, header, 0, 20, 0)).toBe(20);
    expect(header.readUInt32LE(0)).toBe(0x46546c67);
    expect(header.readUInt32LE(4)).toBe(2);
    expect(header.readUInt32LE(16)).toBe(0x4e4f534a);
    const bytes = header.readUInt32LE(12);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    const json = Buffer.alloc(bytes);
    expect(readSync(fd, json, 0, bytes, 20)).toBe(bytes);
    document = JSON.parse(json.toString("utf8")) as GlbDocument;
  } finally {
    closeSync(fd);
  }
  const box = new THREE.Box3();
  let triangles = 0,
    primitives = 0;
  function visit(index: number, parent: THREE.Matrix4) {
    const node = document.nodes[index];
    const local = node.matrix
      ? new THREE.Matrix4().fromArray(node.matrix)
      : new THREE.Matrix4().compose(
          new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
          new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
          new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
        );
    const matrix = parent.clone().multiply(local);
    if (node.mesh !== undefined)
      for (const primitive of document.meshes[node.mesh].primitives) {
        const position = document.accessors[primitive.attributes.POSITION];
        if (!position.min || !position.max)
          throw new Error("GLB position bounds required");
        const primitiveBox = new THREE.Box3(
          new THREE.Vector3(...position.min),
          new THREE.Vector3(...position.max),
        ).applyMatrix4(matrix);
        box.union(primitiveBox);
        triangles +=
          (primitive.indices === undefined
            ? position.count
            : document.accessors[primitive.indices].count) / 3;
        primitives++;
      }
    for (const child of node.children ?? []) visit(child, matrix);
  }
  for (const index of document.scenes[document.scene ?? 0].nodes)
    visit(index, new THREE.Matrix4().makeScale(scale, scale, scale));
  expect(box.isEmpty()).toBe(false);
  return {
    box,
    radius: Math.hypot(
      Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
      Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
    ),
    triangles,
    primitives,
  };
}
