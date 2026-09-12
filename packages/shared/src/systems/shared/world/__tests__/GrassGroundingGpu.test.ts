import { describe, expect, it } from "vitest";
import { MeshStandardNodeMaterial, StorageBufferAttribute } from "three/webgpu";
import { uniform, vec3 } from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";
import type StorageBufferNode from "three/src/nodes/accessors/StorageBufferNode.js";
import THREE from "../../../../extras/three/three";
import {
  createGroundedGrassMaterial,
  GRASS_ROOT_STORAGE_ATTRIBUTE,
} from "../GrassGroundingGpu";
import {
  remapGrassGroundingSteps,
  type GrassGrounding,
} from "../GrassTerrainProjection";

function drain<T>(steps: Generator<string, T, void>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("real Three grounding bindings and provenance (not a GPU test)", () => {
  it.each([0, 1, 2])(
    "owns one independent LOD%s storage binding per chunk while borrowing base nodes/maps",
    (lod) => {
      const blades = [24, 12, 4][lod],
        vertices = [7, 5, 3][lod];
      const base = new MeshStandardNodeMaterial(),
        texture = new THREE.Texture(),
        time = uniform(0);
      base.positionNode = vec3(time, 0, 0);
      base.map = texture;
      const basePosition = base.positionNode;
      let textureDisposals = 0,
        baseDisposals = 0;
      texture.addEventListener("dispose", () => textureDisposals++);
      base.addEventListener("dispose", () => baseDisposals++);
      const chunks = [1, 3].map((count) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(blades * vertices * 3), 3),
        );
        const deltas = Float32Array.from(
          { length: count * blades * 2 },
          (_, i) => i * 0.01,
        );
        const material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
        );
        return { geometry, material, deltas };
      });
      try {
        const bindings: StorageBufferAttribute[] = [];
        for (const { geometry, material, deltas } of chunks) {
          const nodes: Node[] = [];
          (material.positionNode as Node).traverse((node) => nodes.push(node));
          const storage = [
            ...new Set(
              nodes.filter(
                (node): node is StorageBufferNode<"vec2"> =>
                  "isStorageBufferNode" in node &&
                  node.isStorageBufferNode === true,
              ),
            ),
          ];
          expect(storage).toHaveLength(1);
          expect(storage[0].bufferCount).toBe(0);
          expect(storage[0].nodeType).toBe("vec2");
          expect(storage[0].access).toBe("readOnly");
          const binding = geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
          expect(binding).toBeInstanceOf(StorageBufferAttribute);
          expect(storage[0].value).toBe(binding);
          expect(binding.array).toBe(deltas);
          expect(nodes).toContain(basePosition);
          expect(nodes).toContain(time);
          expect(material.map).toBe(texture);
          expect(base.positionNode).toBe(basePosition);
          expect(() =>
            createGroundedGrassMaterial(
              base,
              geometry,
              deltas,
              deltas.length / (blades * 2),
              lod,
            ),
          ).toThrow();
          bindings.push(binding as StorageBufferAttribute);
        }
        expect(bindings[0]).not.toBe(bindings[1]);
      } finally {
        for (const { geometry, material } of chunks) {
          geometry.dispose();
          material.dispose();
        }
        expect(baseDisposals).toBe(0);
        expect(textureDisposals).toBe(0);
        base.dispose();
        texture.dispose();
      }
    },
  );

  it("rejects wrong capacity/layout before attaching a storage allocation", () => {
    const base = new MeshStandardNodeMaterial(),
      geometry = new THREE.BufferGeometry();
    base.positionNode = vec3(0);
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(180), 3),
    );
    try {
      for (const count of [-1, 0, 1.1, 4097, NaN])
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(24),
            count,
            1,
          ),
        ).toThrow();
      for (const lod of [-1, 0, 2, 3])
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(24),
            1,
            lod,
          ),
        ).toThrow();
      expect(() =>
        createGroundedGrassMaterial(base, geometry, new Float32Array(23), 1, 1),
      ).toThrow();
      expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
    } finally {
      geometry.dispose();
      base.dispose();
    }
  });

  it("compacts ecological provenance in admitted order without retaining or changing borrowed arrays", () => {
    const source: GrassGrounding = {
      schemaVersion: 1,
      surfaceRevision: "retained:7",
      computedHeights: new Float32Array([10, 20, 30]),
      ecologicalNormals: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    };
    const before = structuredClone(source);
    const result = drain(
      remapGrassGroundingSteps(source, new Uint32Array([0, 2])),
    );
    expect(result).toEqual({
      ...source,
      computedHeights: new Float32Array([10, 30]),
      ecologicalNormals: new Float32Array([1, 2, 3, 7, 8, 9]),
    });
    expect(source).toEqual(before);
    expect(result.computedHeights.buffer).not.toBe(
      source.computedHeights.buffer,
    );
    expect(result.ecologicalNormals.buffer).not.toBe(
      source.ecologicalNormals.buffer,
    );
    expect(
      drain(remapGrassGroundingSteps(source, new Uint32Array())),
    ).toMatchObject({
      computedHeights: new Float32Array(),
      ecologicalNormals: new Float32Array(),
    });
    for (const indices of [[0, 0], [2, 1], [3], [0, 1, 2, 3]])
      expect(() =>
        drain(remapGrassGroundingSteps(source, new Uint32Array(indices))),
      ).toThrow();
    source.computedHeights[0] = NaN;
    expect(() =>
      drain(remapGrassGroundingSteps(source, new Uint32Array([0]))),
    ).toThrow();
  });
});
