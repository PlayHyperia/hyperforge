import { describe, expect, it } from "vitest";
import { MeshStandardNodeMaterial, StorageBufferAttribute } from "three/webgpu";
import { instanceIndex, uniform, vec3, vertexIndex } from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";
import type StorageBufferNode from "three/src/nodes/accessors/StorageBufferNode.js";
import {
  getGrassBladeLayout,
  type FineGrassGeometryLayout,
} from "../GrassBladeLayout";
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

/** Inspect the actual constructed TSL address. Integer division mirrors the
 * uint operands here; this deliberately does not claim native GPU execution. */
function storageAddress(node: Node, instance: number, vertex: number): number {
  if (node === instanceIndex) return instance;
  if (node === vertexIndex) return vertex;
  const value: unknown = Reflect.get(node, "value");
  if (node.type === "ConstNode" && Number.isSafeInteger(value))
    return value as number;
  const child = (name: string): number => {
    const next: unknown = Reflect.get(node, name);
    if (!(next instanceof THREE.Node))
      throw new Error(`Unexpected ${name} on ${node.type}`);
    return storageAddress(next, instance, vertex);
  };
  if (node.type === "ConvertNode" || node.type === "VarNode")
    return child("node");
  if (node.type !== "OperatorNode")
    throw new Error(`Unexpected grass address node ${node.type}`);
  const a = child("aNode"),
    b = child("bNode");
  switch (Reflect.get(node, "op")) {
    case "+":
      return a + b;
    case "*":
      return a * b;
    case "/":
      return Math.floor(a / b);
    default:
      throw new Error("Unexpected grass address operation");
  }
}

describe("real Three grounding bindings and provenance (not a GPU test)", () => {
  it("admits only explicit bounded layouts, not array-derived topology", () => {
    expect(getGrassBladeLayout(0)).toMatchObject({
      verticesPerBlade: 7,
      verticesPerClump: 168,
      trianglesPerClump: 120,
    });
    expect(getGrassBladeLayout(0, "fine-linear-sweep-near4-v1")).toMatchObject({
      verticesPerBlade: 9,
      verticesPerClump: 216,
      trianglesPerClump: 168,
      rootComponents: 2,
    });
    expect(getGrassBladeLayout(1, "fine-linear-sweep-near4-v1")).toMatchObject({
      verticesPerBlade: 5,
      verticesPerClump: 60,
      trianglesPerClump: 36,
    });
    for (const lod of [-1, 3, 0.5, NaN, Infinity])
      expect(() => getGrassBladeLayout(lod)).toThrow(/layout/);
    for (const layout of [
      null,
      "",
      "ordinary-v1",
      {},
      "fine-linear-sweep-near5-v1",
    ])
      expect(() =>
        getGrassBladeLayout(0, layout as FineGrassGeometryLayout),
      ).toThrow(/layout/);
    const base = new MeshStandardNodeMaterial();
    base.positionNode = vec3(0);
    for (const [vertices, layout] of [
      [216, undefined],
      [216, "fine-linear-sweep-3seg-v1"],
      [168, "fine-linear-sweep-near4-v1"],
    ] as const) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(vertices * 3), 3),
      );
      try {
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(48),
            1,
            0,
            layout,
          ),
        ).toThrow(/binding/);
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
      } finally {
        geometry.dispose();
      }
    }
    base.dispose();
  });
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

  it.each([
    { lod: 0, blades: 24, vertices: 7, count: 1276, geometryLayout: undefined },
    { lod: 1, blades: 12, vertices: 5, count: 1276, geometryLayout: undefined },
    { lod: 0, blades: 24, vertices: 7, count: 4096, geometryLayout: undefined },
    { lod: 1, blades: 12, vertices: 5, count: 4096, geometryLayout: undefined },
    {
      lod: 0,
      blades: 24,
      vertices: 7,
      count: 1276,
      geometryLayout: "fine-linear-sweep-3seg-v1" as const,
    },
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 1276,
      geometryLayout: "fine-linear-sweep-near4-v1" as const,
    },
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 4096,
      geometryLayout: "fine-linear-sweep-near4-v1" as const,
    },
    {
      lod: 1,
      blades: 12,
      vertices: 5,
      count: 1276,
      geometryLayout: "fine-linear-sweep-near4-v1" as const,
    },
  ])(
    "keeps LOD$lod count$count correction capacity and every boundary address exact",
    ({ lod, blades, vertices, count, geometryLayout }) => {
      // 1,276 is the complete proposed 25 m/.7 m candidate quota, not an
      // accepted-population claim. The existing 4,096 hard cap stays unchanged.
      expect(Math.ceil(25 ** 2 / 0.7 ** 2)).toBe(1276);
      const base = new MeshStandardNodeMaterial(),
        geometry = new THREE.BufferGeometry();
      base.positionNode = vec3(1, 2, 3);
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(blades * vertices * 3), 3),
      );
      let material: MeshStandardNodeMaterial | undefined;
      try {
        // Reject cross-tier correction layouts before publishing any binding.
        const otherBlades = lod === 0 ? 12 : 24;
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(count * otherBlades * 2),
            count,
            lod,
            geometryLayout,
          ),
        ).toThrow("Invalid grounded grass binding");
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(4097 * blades * 2),
            4097,
            lod,
            geometryLayout,
          ),
        ).toThrow("Invalid grounded grass binding");
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);

        const deltas = Float32Array.from(
          { length: count * blades * 2 },
          (_, i) => (i % 1024) / 1024,
        );
        material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
          geometryLayout,
        );
        if (geometryLayout === undefined)
          expect(Object.hasOwn(material.userData, "grassBladeLayout")).toBe(
            false,
          );
        else {
          const descriptor = getGrassBladeLayout(lod, geometryLayout);
          expect(material.userData.grassBladeLayout).toBe(descriptor);
          expect(Object.isFrozen(descriptor)).toBe(true);
          expect(
            Object.getOwnPropertyDescriptor(
              material.userData,
              "grassBladeLayout",
            ),
          ).toMatchObject({
            writable: false,
            configurable: false,
            enumerable: true,
          });
        }
        const binding = geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
        expect(binding).toBeInstanceOf(StorageBufferAttribute);
        expect(binding.itemSize).toBe(2);
        expect(binding.count).toBe(count * blades);
        expect(binding.array).toBe(deltas);
        expect(binding.array.byteLength).toBe(count * blades * 8);
        const accesses = new Set<Node>();
        material.positionNode!.traverse((node) => {
          if (
            Reflect.get(node, "isArrayElementNode") === true &&
            Reflect.get(Reflect.get(node, "node"), "value") === binding
          )
            accesses.add(node);
        });
        expect(accesses.size).toBe(1);
        const address: unknown = Reflect.get([...accesses][0], "indexNode");
        if (!(address instanceof THREE.Node))
          throw new Error("Missing actual root storage address");
        for (const instance of [0, 1, count - 1])
          for (let vertex = 0; vertex < blades * vertices; vertex++) {
            const actual = storageAddress(address, instance, vertex);
            expect(actual).toBe(
              instance * blades + Math.floor(vertex / vertices),
            );
            expect(actual).toBeGreaterThanOrEqual(0);
            expect(actual).toBeLessThan(binding.count);
          }
        expect(storageAddress(address, count - 1, blades * vertices - 1)).toBe(
          binding.count - 1,
        );
        expect(base.positionNode).not.toBe(material.positionNode);
      } finally {
        material?.dispose();
        geometry.dispose();
        base.dispose();
      }
    },
  );

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
