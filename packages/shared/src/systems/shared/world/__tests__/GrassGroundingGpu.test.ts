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
  GRASS_BLADE_VISIBILITY_ATTRIBUTE,
  GRASS_ROOT_STORAGE_ATTRIBUTE,
} from "../GrassGroundingGpu";
import {
  remapGrassGroundingSteps,
  type GrassGrounding,
} from "../GrassTerrainProjection";
import {
  createClumpGeometry,
  FINE_GRASS_FOLDED_BLADE_SHAPE,
  FINE_MEADOW_APPEARANCE,
} from "../GrassVisualManager";

function drain<T>(steps: Generator<string, T, void>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Inspect the actual constructed TSL address. Integer division mirrors the
 * uint operands here; this deliberately does not claim native GPU execution. */
function storageAddress(
  node: Node,
  instance: number,
  vertex: number,
  visibility?: number,
): number {
  if (node === instanceIndex) return instance;
  if (node === vertexIndex) return vertex;
  const value: unknown = Reflect.get(node, "value");
  if (node.type === "ConstNode" && Number.isSafeInteger(value))
    return value as number;
  const child = (name: string): number => {
    const next: unknown = Reflect.get(node, name);
    if (!(next instanceof THREE.Node))
      throw new Error(`Unexpected ${name} on ${node.type}`);
    return storageAddress(next, instance, vertex, visibility);
  };
  if (node.type === "ConvertNode" || node.type === "VarNode")
    return child("node");
  if (node.type === "StorageArrayElementNode") {
    const binding = childNode(node, "node"),
      attribute: unknown = Reflect.get(binding, "value");
    if (
      binding.nodeType !== "uint" ||
      !(attribute instanceof StorageBufferAttribute) ||
      !(attribute.array instanceof Uint32Array)
    )
      throw new Error("Expected actual uint visibility storage");
    const index = child("indexNode");
    if (index !== instance || attribute.getX(index) !== visibility)
      throw new Error(
        "Visibility address/value differs from compacted instance",
      );
    return attribute.getX(index);
  }
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
    case ">>":
      return a >>> b;
    case "&":
      return a & b;
    case "!=":
      return Number(a !== b);
    default:
      throw new Error("Unexpected grass address operation");
  }
}

function childNode(node: Node, name: string): Node {
  const child: unknown = Reflect.get(node, name);
  if (!(child instanceof THREE.Node))
    throw new Error(`Missing actual ${name} on ${node.type}`);
  return child;
}

/** Actual graph topology and inputs, excluding allocation-specific UUIDs. */
function graphShape(node: Node): unknown {
  const value: unknown = Reflect.get(node, "value");
  return {
    type: node.type,
    nodeType: node.nodeType,
    op: Reflect.get(node, "op"),
    method: Reflect.get(node, "method"),
    components: Reflect.get(node, "components"),
    convertTo: Reflect.get(node, "convertTo"),
    attributeName: Reflect.get(node, "_attributeName"),
    scope: Reflect.get(node, "scope"),
    access: Reflect.get(node, "access"),
    bufferCount: Reflect.get(node, "bufferCount"),
    value:
      value instanceof THREE.BufferAttribute
        ? Array.from(value.array)
        : typeof value === "number"
          ? value
          : undefined,
    children: [...node.getChildren()].map(graphShape),
  };
}

function bindingGeometry(
  lod: number,
  count: number,
  geometryLayout?: FineGrassGeometryLayout,
): THREE.BufferGeometry {
  const tier = getGrassBladeLayout(lod, geometryLayout);
  const actualSheath = geometryLayout === "fine-folded-sheath-near5-v1";
  const geometry = actualSheath
    ? createClumpGeometry(
        tier.bladesPerClump,
        tier.bladeSegments,
        FINE_GRASS_FOLDED_BLADE_SHAPE,
        lod === 0
          ? "folded-sheath-v1"
          : lod === 1
            ? "folded-lancet-v1"
            : undefined,
      )
    : new THREE.BufferGeometry();
  if (!actualSheath)
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array(
          getGrassBladeLayout(lod, geometryLayout).verticesPerClump * 3,
        ),
        3,
      ),
    );
  geometry.setAttribute(
    "instanceOffset",
    new THREE.InstancedBufferAttribute(
      Float32Array.from({ length: count * 3 }, (_, index) => index * 1.25 - 7),
      3,
    ),
  );
  return geometry;
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
    expect(getGrassBladeLayout(0, "fine-folded-lancet-v1")).toMatchObject({
      bladeSegments: 3,
      verticesPerBlade: 9,
      verticesPerClump: 216,
      trianglesPerClump: 216,
      rootComponents: 2,
    });
    for (const lod of [0, 1, 2])
      expect(
        getGrassBladeLayout(lod, "fine-folded-sheath-near5-v1"),
      ).toMatchObject({
        bladesPerClump: [24, 24, 12][lod],
        bladeSegments: [5, 3, 2][lod],
        verticesPerBlade: [15, 9, 5][lod],
        verticesPerClump: [360, 216, 60][lod],
        trianglesPerClump: [408, 216, 36][lod],
        rootComponents: 2,
      });
    for (const lod of [-1, 3, 0.5, NaN, Infinity])
      expect(() => getGrassBladeLayout(lod)).toThrow(/layout/);
    for (const layout of [
      null,
      "",
      "ordinary-v1",
      {},
      "fine-linear-sweep-near5-v1",
      "fine-folded-sheath-near6-v1",
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
      [168, "fine-folded-lancet-v1"],
      [216, "fine-folded-sheath-near5-v1"],
      [432, "fine-folded-sheath-near5-v1"],
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
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 1276,
      geometryLayout: "fine-folded-lancet-v1" as const,
    },
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 4096,
      geometryLayout: "fine-folded-lancet-v1" as const,
    },
    ...[1276, 4096].flatMap((count) =>
      [0, 1, 2].map((lod) => ({
        lod,
        count,
        blades: [24, 24, 12][lod],
        vertices: [15, 9, 5][lod],
        geometryLayout: "fine-folded-sheath-near5-v1" as const,
      })),
    ),
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
        const otherBlades = blades === 24 ? 12 : 24;
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
          expect(
            Object.prototype.hasOwnProperty.call(
              material.userData,
              "grassBladeLayout",
            ),
          ).toBe(false);
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
        const positionNode = material.positionNode;
        if (!(positionNode instanceof THREE.Node))
          throw new Error("Missing actual corrected grass position node");
        positionNode.traverse((node) => {
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

  it.each(
    (
      [
        undefined,
        "fine-linear-sweep-3seg-v1",
        "fine-linear-sweep-near4-v1",
        "fine-folded-lancet-v1",
        "fine-folded-sheath-near5-v1",
      ] as const
    ).flatMap((geometryLayout) =>
      [0, 1, 2].map((lod) => ({ geometryLayout, lod })),
    ),
  )(
    "selects exact per-instance visible blade bits and a common collapse anchor for $geometryLayout LOD$lod",
    ({ geometryLayout, lod }) => {
      const tier = getGrassBladeLayout(lod, geometryLayout),
        count = 3,
        allBits = 2 ** tier.bladesPerClump - 1,
        masks = new Uint32Array([1, 2 ** (tier.bladesPerClump - 1), allBits]),
        maskBefore = masks.slice(),
        base = new MeshStandardNodeMaterial(),
        time = uniform(0.37),
        geometry = bindingGeometry(lod, count, geometryLayout),
        unmaskedGeometry = bindingGeometry(lod, count, geometryLayout),
        deltas = Float32Array.from(
          { length: count * tier.bladesPerClump * 2 },
          (_, index) => (index + 1) / 16,
        );
      base.positionNode = vec3(time, 9, -3);
      const borrowedPosition = base.positionNode;
      let material: MeshStandardNodeMaterial | undefined,
        unmasked: MeshStandardNodeMaterial | undefined;
      try {
        material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
          geometryLayout,
          masks,
        );
        unmasked = createGroundedGrassMaterial(
          base,
          unmaskedGeometry,
          deltas,
          count,
          lod,
          geometryLayout,
        );
        const binding = geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE);
        expect(binding).toBeInstanceOf(StorageBufferAttribute);
        if (!(binding instanceof StorageBufferAttribute))
          throw new Error("Missing actual visibility binding");
        expect(binding.array).toBe(masks);
        expect(binding.array.byteLength).toBe(count * 4);
        expect(binding.count).toBe(count);
        expect(binding.itemSize).toBe(1);
        expect(binding.isStorageBufferAttribute).toBe(true);
        expect(binding).not.toBeInstanceOf(THREE.InstancedBufferAttribute);
        expect(binding.normalized).toBe(false);
        const selected = material.positionNode as Node;
        expect(selected.type).toBe("ConditionalNode");
        const condition = childNode(selected, "condNode"),
          corrected = childNode(selected, "ifNode"),
          collapsed = childNode(selected, "elseNode");
        expect(graphShape(corrected)).toEqual(
          graphShape(unmasked.positionNode as Node),
        );
        expect(collapsed.type).toBe("AttributeNode");
        expect(collapsed.nodeType).toBe("vec3");
        expect(Reflect.get(collapsed, "_attributeName")).toBe("instanceOffset");
        expect([...collapsed.getChildren()]).toEqual([]);
        const nodes: Node[] = [];
        selected.traverse((node) => nodes.push(node));
        const maskStorage = nodes.filter(
          (node) =>
            node.type === "StorageBufferNode" &&
            Reflect.get(node, "value") === binding,
        );
        expect(new Set(maskStorage).size).toBe(1);
        expect(maskStorage[0].nodeType).toBe("uint");
        expect(Reflect.get(maskStorage[0], "bufferCount")).toBe(0);
        expect(Reflect.get(maskStorage[0], "access")).toBe("readOnly");
        expect(
          nodes.some(
            (node) =>
              node.type === "AttributeNode" &&
              Reflect.get(node, "_attributeName") ===
                GRASS_BLADE_VISIBILITY_ATTRIBUTE,
          ),
        ).toBe(false);
        expect(nodes).toContain(borrowedPosition);
        expect(nodes).toContain(time);
        expect(
          nodes.filter((node) => node.type === "ConditionalNode"),
        ).toHaveLength(1);
        expect(nodes.some((node) => /Discard/.test(node.type))).toBe(false);
        const offset = geometry.getAttribute("instanceOffset");
        for (let instance = 0; instance < count; instance++) {
          const anchor = [
            offset.getX(instance),
            offset.getY(instance),
            offset.getZ(instance),
          ];
          for (let blade = 0; blade < tier.bladesPerClump; blade++) {
            const visible = (masks[instance] & (1 << blade)) !== 0;
            const hiddenPositions: number[][] = [];
            for (let v = 0; v < tier.verticesPerBlade; v++) {
              const vertex = blade * tier.verticesPerBlade + v;
              expect(
                storageAddress(
                  condition,
                  instance,
                  vertex,
                  binding.getX(instance),
                ),
              ).toBe(Number(visible));
              if (!visible) {
                // Interpret the actual selected attribute leaf, not an invented
                // shader: no vertex-dependent node or correction follows it.
                const actual = geometry.getAttribute(
                  Reflect.get(collapsed, "_attributeName"),
                );
                hiddenPositions.push([
                  actual.getX(instance),
                  actual.getY(instance),
                  actual.getZ(instance),
                ]);
              }
            }
            if (!visible) {
              expect(hiddenPositions).toHaveLength(tier.verticesPerBlade);
              for (const position of hiddenPositions)
                expect(position).toEqual(anchor);
              const a = new THREE.Vector3().fromArray(hiddenPositions[0]),
                b = new THREE.Vector3().fromArray(hiddenPositions[1]),
                c = new THREE.Vector3().fromArray(hiddenPositions[2]);
              expect(b.sub(a).cross(c.sub(a)).lengthSq()).toBe(0);
            }
          }
        }
        expect(masks).toEqual(maskBefore);
        expect(base.positionNode).toBe(borrowedPosition);
        expect(
          unmaskedGeometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
        ).toBe(false);
      } finally {
        material?.dispose();
        unmasked?.dispose();
        geometry.dispose();
        unmaskedGeometry.dispose();
        base.dispose();
      }
    },
  );

  it.each([
    {
      geometryLayout: "fine-folded-lancet-v1",
      lod: 0,
      blades: 24,
      segments: 3,
      vertices: 9,
      triangles: 9,
      crossSection: "folded-lancet-v1",
      centers: [7, 8],
    },
    {
      geometryLayout: "fine-folded-sheath-near5-v1",
      lod: 0,
      blades: 24,
      segments: 5,
      vertices: 15,
      triangles: 17,
      crossSection: "folded-sheath-v1",
      centers: [11, 12, 13, 14],
    },
    {
      geometryLayout: "fine-folded-sheath-near5-v1",
      lod: 1,
      blades: 24,
      segments: 3,
      vertices: 9,
      triangles: 9,
      crossSection: "folded-lancet-v1",
      centers: [7, 8],
    },
    {
      geometryLayout: "fine-folded-sheath-near5-v1",
      lod: 2,
      blades: 12,
      segments: 2,
      vertices: 5,
      triangles: 3,
      crossSection: undefined,
      centers: [],
    },
  ] as const)(
    "addresses every actual $geometryLayout LOD$lod vertex, center and root pair without new vertex-input bindings",
    ({
      geometryLayout,
      lod,
      blades,
      segments,
      vertices,
      triangles,
      crossSection,
      centers,
    }) => {
      const geometry = createClumpGeometry(
        blades,
        segments,
        FINE_GRASS_FOLDED_BLADE_SHAPE,
        crossSection,
      );
      const base = new MeshStandardNodeMaterial();
      base.positionNode = vec3(0);
      const count = 3;
      const deltas = Float32Array.from(
        { length: count * blades * 2 },
        (_, i) => (i + 1) / 4,
      );
      const masks = new Uint32Array([
        1,
        1 << (blades - 1),
        0x555555 & (2 ** blades - 1),
      ]);
      geometry.setAttribute(
        "instanceOffset",
        new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      );
      let material: MeshStandardNodeMaterial | undefined;
      try {
        expect(geometry.getAttribute("position").count).toBe(blades * vertices);
        expect(geometry.getIndex()?.count).toBe(blades * triangles * 3);
        // Historical/default tier descriptors must not interpret a new stride
        // or population. Equal stride alone is not a topology proof: exact
        // folded index order is validated by CPU admission, not this binder.
        for (const wrong of [undefined, "fine-linear-sweep-3seg-v1"] as const) {
          expect(() =>
            createGroundedGrassMaterial(
              base,
              geometry,
              deltas,
              count,
              lod,
              wrong,
              masks,
            ),
          ).toThrow(/binding/);
          expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(
            false,
          );
          expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
            false,
          );
        }
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            deltas,
            count,
            lod,
            geometryLayout,
            new Uint32Array([1, 2 ** blades, 1]),
          ),
        ).toThrow(/visibility/);
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
        expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
          false,
        );
        material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
          geometryLayout,
          masks,
        );
        const roots = geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
        const visibility = geometry.getAttribute(
          GRASS_BLADE_VISIBILITY_ATTRIBUTE,
        );
        if (
          !(roots instanceof StorageBufferAttribute) ||
          !(visibility instanceof StorageBufferAttribute)
        )
          throw new Error("Missing actual folded storage bindings");
        const selected = material.positionNode;
        if (!(selected instanceof THREE.Node))
          throw new Error("Missing actual folded position graph");
        expect(selected.type).toBe("ConditionalNode");
        const condition = childNode(selected, "condNode");
        const nodes = new Set<Node>();
        selected.traverse((node) => nodes.add(node));
        const mixes = [...nodes].filter(
          (node) =>
            node.type === "MathNode" && Reflect.get(node, "method") === "mix",
        );
        expect(mixes).toHaveLength(1);
        const mix = mixes[0];
        const rootAccess = childNode(childNode(mix, "aNode"), "node");
        expect(rootAccess.type).toBe("StorageArrayElementNode");
        expect(Reflect.get(childNode(rootAccess, "node"), "value")).toBe(roots);
        const address = childNode(rootAccess, "indexNode");
        const uv = geometry.getAttribute("uv");
        // Interpret only the actual constructed scalar root mix and its bound
        // storage/UV leaves; no renderer or replacement shader is simulated.
        const scalar = (
          node: Node,
          instance: number,
          vertex: number,
        ): number => {
          if (node.type === "VarNode" || node.type === "ConvertNode")
            return scalar(childNode(node, "node"), instance, vertex);
          if (
            node.type === "MathNode" &&
            Reflect.get(node, "method") === "mix"
          ) {
            const a = scalar(childNode(node, "aNode"), instance, vertex);
            const b = scalar(childNode(node, "bNode"), instance, vertex);
            const t = scalar(childNode(node, "cNode"), instance, vertex);
            return a * (1 - t) + b * t;
          }
          if (node.type !== "SplitNode")
            throw new Error("Unexpected actual root interpolation node");
          const component: unknown = Reflect.get(node, "components");
          const source = childNode(node, "node");
          if (
            source.type === "AttributeNode" &&
            Reflect.get(source, "_attributeName") === "uv" &&
            component === "x"
          )
            return uv.getX(vertex);
          if (
            source.type !== "StorageArrayElementNode" ||
            Reflect.get(childNode(source, "node"), "value") !== roots ||
            (component !== "x" && component !== "y")
          )
            throw new Error(
              "Root interpolation must use its own vec2 storage and actual uv.x",
            );
          const index = storageAddress(
            childNode(source, "indexNode"),
            instance,
            vertex,
          );
          return component === "x" ? roots.getX(index) : roots.getY(index);
        };
        for (const instance of [0, 1, 2])
          for (let blade = 0; blade < blades; blade++) {
            const root = instance * blades + blade;
            for (let local = 0; local < vertices; local++) {
              const vertex = blade * vertices + local;
              expect(storageAddress(address, instance, vertex)).toBe(root);
              expect(
                storageAddress(condition, instance, vertex, masks[instance]),
              ).toBe(Number((masks[instance] & (1 << blade)) !== 0));
              const u = uv.getX(vertex);
              expect(scalar(mix, instance, vertex)).toBe(
                deltas[root * 2] * (1 - u) + deltas[root * 2 + 1] * u,
              );
            }
            for (const center of centers) {
              const vertex = blade * vertices + center;
              expect(uv.getX(vertex)).toBe(0.5);
              expect(uv.getY(vertex)).toBe(
                Math.fround((center - 2 * segments) / segments),
              );
              expect(scalar(mix, instance, vertex)).toBe(
                (deltas[root * 2] + deltas[root * 2 + 1]) / 2,
              );
              if (blade < blades - 1) {
                expect(
                  storageAddress(address, instance, vertex + vertices - center),
                ).toBe(root + 1);
                expect(storageAddress(address, instance, vertex)).not.toBe(
                  storageAddress(address, instance, vertex + vertices - center),
                );
              }
            }
          }
        // These two runtime arrays must not add vertex inputs to the existing
        // eight-buffer production layout. Native compilation remains a later gate.
        const storage = [...nodes].filter(
          (node) => node.type === "StorageBufferNode",
        );
        expect(storage).toHaveLength(2);
        for (const node of storage) {
          expect(Reflect.get(node, "bufferCount")).toBe(0);
          expect(Reflect.get(node, "access")).toBe("readOnly");
        }
        expect(new Set(storage.map((node) => node.nodeType))).toEqual(
          new Set(["vec2", "uint"]),
        );
        expect(
          [...nodes]
            .filter((node) => node.type === "AttributeNode")
            .map((node) => Reflect.get(node, "_attributeName"))
            .sort(),
        ).toEqual(["instanceOffset", "uv"]);
        for (const binding of [roots, visibility])
          expect(binding).not.toBeInstanceOf(THREE.InstancedBufferAttribute);
        expect(roots.array.byteLength).toBe(count * blades * 2 * 4);
        expect(visibility.array.byteLength).toBe(count * 4);
      } finally {
        material?.dispose();
        geometry.dispose();
        base.dispose();
      }
    },
  );

  it.each([1, 2])(
    "retains the historical LOD%s root/mask graph for the folded near-only layout",
    (lod) => {
      const oldTier = getGrassBladeLayout(lod, "fine-linear-sweep-3seg-v1");
      const foldedTier = getGrassBladeLayout(lod, "fine-folded-lancet-v1");
      expect(foldedTier).toEqual({
        ...oldTier,
        geometryLayout: "fine-folded-lancet-v1",
      });
      const base = new MeshStandardNodeMaterial();
      base.positionNode = vec3(1, 2, 3);
      const oldGeometry = bindingGeometry(lod, 2, "fine-linear-sweep-3seg-v1");
      const foldedGeometry = bindingGeometry(lod, 2, "fine-folded-lancet-v1");
      const deltas = Float32Array.from(
        { length: 2 * oldTier.bladesPerClump * 2 },
        (_, i) => i / 8,
      );
      const masks = new Uint32Array([1, 2 ** oldTier.bladesPerClump - 1]);
      const oldMaterial = createGroundedGrassMaterial(
        base,
        oldGeometry,
        deltas,
        2,
        lod,
        "fine-linear-sweep-3seg-v1",
        masks,
      );
      const foldedMaterial = createGroundedGrassMaterial(
        base,
        foldedGeometry,
        deltas,
        2,
        lod,
        "fine-folded-lancet-v1",
        masks,
      );
      try {
        const oldNode = oldMaterial.positionNode,
          foldedNode = foldedMaterial.positionNode;
        if (
          !(oldNode instanceof THREE.Node) ||
          !(foldedNode instanceof THREE.Node)
        )
          throw new Error("Missing actual LOD position graph");
        expect(graphShape(foldedNode)).toEqual(graphShape(oldNode));
        expect(Object.keys(foldedGeometry.attributes)).toEqual(
          Object.keys(oldGeometry.attributes),
        );
      } finally {
        oldMaterial.dispose();
        foldedMaterial.dispose();
        oldGeometry.dispose();
        foldedGeometry.dispose();
        base.dispose();
      }
    },
  );

  it("leaves omitted and explicit-undefined mask graphs and attributes identical", () => {
    const base = new MeshStandardNodeMaterial(),
      omittedGeometry = bindingGeometry(1, 1),
      undefinedGeometry = bindingGeometry(1, 1),
      deltas = new Float32Array(24);
    base.positionNode = vec3(1, 2, 3);
    // Legacy bindings never required instanceOffset, and still must not.
    omittedGeometry.deleteAttribute("instanceOffset");
    undefinedGeometry.deleteAttribute("instanceOffset");
    const omitted = createGroundedGrassMaterial(
        base,
        omittedGeometry,
        deltas,
        1,
        1,
      ),
      explicit = createGroundedGrassMaterial(
        base,
        undefinedGeometry,
        deltas,
        1,
        1,
        undefined,
        undefined,
      );
    try {
      expect(graphShape(omitted.positionNode as Node)).toEqual(
        graphShape(explicit.positionNode as Node),
      );
      for (const geometry of [omittedGeometry, undefinedGeometry])
        expect(Object.keys(geometry.attributes)).toEqual([
          "position",
          GRASS_ROOT_STORAGE_ATTRIBUTE,
        ]);
      for (const material of [omitted, explicit]) {
        const positionNode = material.positionNode;
        if (!(positionNode instanceof THREE.Node))
          throw new Error("Missing actual unmasked grass position node");
        expect(positionNode.type).toBe("VarNode");
        const sum = childNode(positionNode, "node");
        expect(sum.type).toBe("OperatorNode");
        expect(Reflect.get(sum, "op")).toBe("+");
        const nodes: Node[] = [];
        positionNode.traverse((node) => nodes.push(node));
        expect(nodes.some((node) => node.type === "ConditionalNode")).toBe(
          false,
        );
        expect(
          nodes.some(
            (node) =>
              Reflect.get(node, "_attributeName") ===
              GRASS_BLADE_VISIBILITY_ATTRIBUTE,
          ),
        ).toBe(false);
      }
    } finally {
      omitted.dispose();
      explicit.dispose();
      omittedGeometry.dispose();
      undefinedGeometry.dispose();
      base.dispose();
    }
  });

  it.each([0, 1, 2])(
    "rejects invalid LOD%s visibility masks before mutating geometry",
    (lod) => {
      const tier = getGrassBladeLayout(lod),
        base = new MeshStandardNodeMaterial(),
        geometry = bindingGeometry(lod, 2),
        deltas = new Float32Array(4 * tier.bladesPerClump),
        valid = 2 ** tier.bladesPerClump - 1;
      base.positionNode = vec3(0);
      try {
        for (const invalid of [
          null,
          [1, 1],
          new Float32Array([1, 1]),
          new Int32Array([1, 1]),
          new Uint32Array(),
          new Uint32Array([1]),
          new Uint32Array([1, 1, 1]),
          new Uint32Array([0, 1]),
          new Uint32Array([1, 0]),
          new Uint32Array([valid, 2 ** tier.bladesPerClump]),
          new Uint32Array([1, 0xffffffff]),
        ]) {
          expect(() =>
            createGroundedGrassMaterial(
              base,
              geometry,
              deltas,
              2,
              lod,
              undefined,
              invalid as Uint32Array,
            ),
          ).toThrow(/visibility/);
          expect(Object.keys(geometry.attributes)).toEqual([
            "position",
            "instanceOffset",
          ]);
        }
        const previous = new THREE.InstancedBufferAttribute(
          new Uint32Array([1, 1]),
          1,
        );
        geometry.setAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE, previous);
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            deltas,
            2,
            lod,
            undefined,
            new Uint32Array([1, 1]),
          ),
        ).toThrow(/visibility/);
        expect(geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
          previous,
        );
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
      } finally {
        geometry.dispose();
        base.dispose();
      }
    },
  );

  it("requires a finite per-instance Float32 common anchor for masked bindings", () => {
    const base = new MeshStandardNodeMaterial(),
      geometry = bindingGeometry(1, 2);
    base.positionNode = vec3(0);
    const repeated = new THREE.InstancedBufferAttribute(
      new Float32Array(6),
      3,
      false,
      2,
    );
    const nan = new THREE.InstancedBufferAttribute(
      new Float32Array([0, NaN, 0, 0, 0, 0]),
      3,
    );
    try {
      for (const offset of [
        undefined,
        new THREE.BufferAttribute(new Float32Array(6), 3),
        new THREE.InstancedBufferAttribute(new Float32Array(4), 2),
        new THREE.InstancedBufferAttribute(new Float32Array(3), 3),
        new THREE.InstancedBufferAttribute(new Float32Array(9), 3),
        new THREE.InstancedBufferAttribute(new Float32Array(6), 3, true),
        new THREE.InstancedBufferAttribute(new Uint32Array(6), 3),
        repeated,
        nan,
      ]) {
        if (offset) geometry.setAttribute("instanceOffset", offset);
        else geometry.deleteAttribute("instanceOffset");
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(48),
            2,
            1,
            undefined,
            new Uint32Array([1, 1]),
          ),
        ).toThrow(/visibility/);
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
        expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
          false,
        );
      }
    } finally {
      geometry.dispose();
      base.dispose();
    }
  });

  it("gives each masked chunk independent geometry bindings without retiring borrowed resources", () => {
    const base = new MeshStandardNodeMaterial(),
      texture = new THREE.Texture(),
      time = uniform(0);
    base.positionNode = vec3(time, 0, 0);
    base.map = texture;
    let baseDisposals = 0,
      textureDisposals = 0;
    base.addEventListener("dispose", () => baseDisposals++);
    texture.addEventListener("dispose", () => textureDisposals++);
    const chunks = [1, 2].map((count) => {
      const geometry = bindingGeometry(1, count),
        masks = new Uint32Array(count).fill(1);
      const material = createGroundedGrassMaterial(
        base,
        geometry,
        new Float32Array(count * 24),
        count,
        1,
        undefined,
        masks,
      );
      return { geometry, material, masks };
    });
    try {
      expect(
        chunks[0].geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
      ).not.toBe(
        chunks[1].geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
      );
      expect(
        chunks[0].geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
      ).not.toBe(chunks[1].geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE));
      for (const { geometry, material, masks } of chunks) {
        let geometryDisposals = 0,
          materialDisposals = 0;
        geometry.addEventListener("dispose", () => {
          geometryDisposals++;
          expect(
            geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE).array,
          ).toBe(masks);
          expect(
            geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
          ).toBeInstanceOf(StorageBufferAttribute);
        });
        material.addEventListener("dispose", () => materialDisposals++);
        expect(material.map).toBe(texture);
        material.dispose();
        expect(geometryDisposals).toBe(0);
        expect(materialDisposals).toBe(1);
        geometry.dispose();
        expect(geometryDisposals).toBe(1);
      }
      expect(baseDisposals).toBe(0);
      expect(textureDisposals).toBe(0);
      expect(time.value).toBe(0);
    } finally {
      base.dispose();
      texture.dispose();
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
