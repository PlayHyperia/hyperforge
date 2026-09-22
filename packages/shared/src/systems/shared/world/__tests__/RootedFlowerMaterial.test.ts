import { describe, expect, it } from "vitest";
import { uniform } from "three/tsl";
import type { Node } from "three/webgpu";
import THREE from "../../../../extras/three/three";
import { createRootedFlowerGeometry } from "../../../../../../procgen/src/flowers/RootedFlowerGeometry";
import {
  INSTANCE_MATRIX_STORAGE_ATTRIBUTE,
  createStorageInstancedMesh,
} from "../../../../utils/rendering/createStorageInstancedMesh";
import {
  TREE_WIND_ATTRIBUTE,
  createTreeWindPositionNode,
  evaluateTreeWindBend,
} from "../TreeWind";
import {
  ROOTED_FLOWER_WIND_MAX_DISPLACEMENT,
  assertRootedFlowerPool,
  createRootedFlowerMaterial,
  getRootedFlowerWindMaxDisplacement,
} from "../RootedFlowerMaterial";

// Real rooted geometry, native storage attributes and native NodeBuilder stacks.
// These bounded CPU graph checks do not claim GPU or native visual approval.
function fixture(height = 0.38, capacity = 2) {
  const geometry = createRootedFlowerGeometry({ height });
  const wind = {
    time: uniform(7.25),
    strength: uniform(1.3),
    direction: uniform(new THREE.Vector2(0.6, 0.8)),
  };
  const material = createRootedFlowerMaterial(wind);
  const mesh = createStorageInstancedMesh(geometry, material, capacity);
  mesh.count = Math.min(2, capacity);
  for (let index = 0; index < mesh.count; index++) {
    mesh.setMatrixAt(
      index,
      new THREE.Matrix4().compose(
        new THREE.Vector3(19 + index * 7, 3, -42),
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          index === 0 ? 0.6 : -1.2,
        ),
        new THREE.Vector3().setScalar(index === 0 ? 0.8 : 3),
      ),
    );
  }
  return {
    geometry,
    wind,
    material,
    mesh,
    dispose() {
      mesh.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}

function node(value: unknown): Node {
  if (!(value instanceof THREE.Node)) throw new Error("Expected native node");
  return value;
}

function expand(root: unknown, mesh: THREE.Mesh): Node[] {
  let actual = node(root);
  while (Reflect.get(actual, "isVarNode"))
    actual = node(Reflect.get(actual, "node"));
  const builder: unknown = Reflect.construct(THREE.NodeBuilder, [
    mesh,
    null,
    null,
  ]);
  if (!(builder instanceof THREE.NodeBuilder))
    throw new Error("Native builder");
  Reflect.set(builder, "camera", new THREE.PerspectiveCamera(50, 1, 0.1, 1000));
  Reflect.set(builder, "shaderStage", "vertex");
  const add: unknown = Reflect.get(builder, "addStack");
  const remove: unknown = Reflect.get(builder, "removeStack");
  if (typeof add !== "function" || typeof remove !== "function")
    throw new Error("Native stack API");
  add.call(builder);
  try {
    const shader: unknown = Reflect.get(actual, "shaderNode");
    const callback: unknown =
      shader instanceof THREE.Node ? Reflect.get(shader, "jsFunc") : undefined;
    const result =
      typeof callback === "function" ? node(callback(builder)) : actual;
    const stack: unknown = Reflect.get(builder, "stack");
    if (!(stack instanceof THREE.StackNode)) throw new Error("Native stack");
    return [...stack.nodes, result];
  } finally {
    remove.call(builder);
  }
}

function nodes(roots: readonly Node[]): Set<Node> {
  const result = new Set<Node>();
  const visit = (current: Node) => {
    if (result.has(current)) return;
    if (result.size >= 4096) throw new Error("Bounded graph exceeded");
    result.add(current);
    for (const child of current.getChildren()) visit(child);
  };
  roots.forEach(visit);
  return result;
}

// Compare against the existing connected-tree position/normal graph, changing
// only its authored-height attribute name. No second arithmetic interpreter.
function structure(roots: readonly Node[]): unknown {
  const seen = new Map<Node, number>();
  const visit = (current: Node): unknown => {
    const previous = seen.get(current);
    if (previous !== undefined) return { ref: previous };
    if (seen.size >= 4096) throw new Error("Bounded graph exceeded");
    seen.set(current, seen.size);
    const value: unknown = Reflect.get(current, "value");
    return {
      type: current.type,
      nodeType: current.nodeType,
      fields: [
        "op",
        "method",
        "components",
        "name",
        "snippet",
        "_attributeName",
      ]
        .map((key) => Reflect.get(current, key))
        .map((field) =>
          field === TREE_WIND_ATTRIBUTE ? "flowerHeight" : field,
        ),
      value:
        typeof value === "number" || typeof value === "boolean"
          ? value
          : value instanceof THREE.Vector2 || value instanceof THREE.Vector3
            ? value.toArray()
            : value instanceof THREE.BufferAttribute
              ? Array.from(value.array)
              : undefined,
      children: [...current.getChildren()].map(visit),
    };
  };
  return roots.map(visit);
}

describe("inactive rooted flower material", () => {
  it("uses opaque, two-sided vertex colors with native matte lighting and fog", () => {
    const f = fixture();
    try {
      expect(f.material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
      expect(f.material).toMatchObject({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        fog: true,
        lights: true,
        map: null,
        normalMap: null,
        colorNode: null,
        normalNode: null,
        outputNode: null,
        castShadowPositionNode: null,
      });
      expect(f.material.color.toArray()).toEqual([1, 1, 1]);
      expect(f.geometry.hasAttribute("tangent")).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("borrows the exact per-world uniforms and existing native instance storage", () => {
    const f = fixture();
    try {
      const graph = [...nodes(expand(f.material.positionNode, f.mesh))];
      for (const borrowed of Object.values(f.wind))
        expect(graph).toContain(node(borrowed));
      const uniforms = graph.filter((item) =>
        Reflect.get(item, "isUniformNode"),
      );
      expect(
        uniforms.filter((item) => !Reflect.get(item, "isStorageBufferNode")),
      ).toHaveLength(3);
      const storage = graph.filter((item) =>
        Reflect.get(item, "isStorageBufferNode"),
      );
      expect(storage).toHaveLength(1);
      expect(Reflect.get(storage[0], "value")).toBe(f.mesh.instanceMatrix);
      expect(
        graph.some(
          (item) => Reflect.get(item, "_attributeName") === "flowerHeight",
        ),
      ).toBe(true);
      expect(
        graph.some(
          (item) => Reflect.get(item, "_attributeName") === "flowerPetal",
        ),
      ).toBe(false); // Independent flutter is deliberately not implemented.
      expect(graph.some((item) => Reflect.get(item, "isTextureNode"))).toBe(
        false,
      );
      f.wind.time.value = 12;
      f.wind.strength.value = 0.4;
      f.wind.direction.value.set(-0.2, 0.7);
      expect(Reflect.get(node(f.wind.time), "value")).toBe(12);
      expect(graph).toContain(node(f.wind.direction));
    } finally {
      f.dispose();
    }
  });

  it("retains the proven native position and inverse-transpose normal graph", () => {
    const f = fixture();
    try {
      const flower = structure(expand(f.material.positionNode, f.mesh));
      // A borrowed alias in this isolated fixture supplies the tree graph's
      // exact same height values without cloning or allocating matrix storage.
      f.geometry.setAttribute(
        TREE_WIND_ATTRIBUTE,
        f.geometry.getAttribute("flowerHeight"),
      );
      expect(flower).toEqual(
        structure(expand(createTreeWindPositionNode(f.wind), f.mesh)),
      );
      f.geometry.deleteAttribute(TREE_WIND_ATTRIBUTE);
    } finally {
      f.dispose();
    }
  });

  it("does not mutate or own source arrays, static bounds, transforms or wind", () => {
    const f = fixture();
    let geometryDisposals = 0;
    f.geometry.addEventListener("dispose", () => geometryDisposals++);
    const attributes = Object.entries(f.geometry.attributes).map(
      ([name, value]) => {
        if (!(value instanceof THREE.BufferAttribute))
          throw new Error("Native attribute");
        return {
          name,
          value,
          array: Array.from(value.array),
          version: value.version,
        };
      },
    );
    const box = f.geometry.boundingBox?.clone();
    const sphere = f.geometry.boundingSphere?.clone();
    const matrix = f.mesh.instanceMatrix;
    const world = f.mesh.matrixWorld.clone();
    const wind = [
      f.wind.time.value,
      f.wind.strength.value,
      ...f.wind.direction.value.toArray(),
    ];
    try {
      assertRootedFlowerPool(f.mesh);
      expand(f.material.positionNode, f.mesh);
      for (const previous of attributes) {
        expect(f.geometry.getAttribute(previous.name)).toBe(previous.value);
        expect(Array.from(previous.value.array)).toEqual(previous.array);
        expect(previous.value.version).toBe(previous.version);
      }
      expect(f.mesh.instanceMatrix).toBe(matrix);
      expect(f.mesh.matrixWorld.equals(world)).toBe(true);
      expect(f.geometry.boundingBox?.equals(box ?? new THREE.Box3())).toBe(
        true,
      );
      expect(
        f.geometry.boundingSphere?.equals(sphere ?? new THREE.Sphere()),
      ).toBe(true);
      expect([
        f.wind.time.value,
        f.wind.strength.value,
        ...f.wind.direction.value.toArray(),
      ]).toEqual(wind);
      f.material.dispose();
      expect(geometryDisposals).toBe(0);
      expect(f.geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE)).toBe(
        matrix,
      );
    } finally {
      f.dispose();
    }
    expect(geometryDisposals).toBe(1);
  });

  it.each([0.12, 0.38, 0.8])(
    "admits actual Float32 metadata at height %s",
    (height) => {
      const f = fixture(height);
      try {
        expect(() => assertRootedFlowerPool(f.mesh)).not.toThrow();
        expect(() => expand(f.material.positionNode, f.mesh)).not.toThrow();
      } finally {
        f.dispose();
      }
    },
  );

  it.each([
    [
      "missing height",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.deleteAttribute("flowerHeight"),
    ],
    [
      "missing normals",
      (f: ReturnType<typeof fixture>) => f.geometry.deleteAttribute("normal"),
    ],
    [
      "missing petal metadata",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.deleteAttribute("flowerPetal"),
    ],
    [
      "tangents",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.setAttribute(
          "tangent",
          new THREE.Float32BufferAttribute(
            new Float32Array(f.geometry.getAttribute("position").count * 4),
            4,
          ),
        ),
    ],
    [
      "height count",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.setAttribute(
          "flowerHeight",
          new THREE.Float32BufferAttribute([0, 0.38], 2),
        ),
    ],
    [
      "height item size",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.setAttribute(
          "flowerHeight",
          new THREE.Float32BufferAttribute(
            new Float32Array(f.geometry.getAttribute("position").count * 3),
            3,
          ),
        ),
    ],
    [
      "authored Y mismatch",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("flowerHeight").setX(0, 0.1),
    ],
    [
      "inconsistent height",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("flowerHeight").setY(0, 0.5),
    ],
    [
      "nonfinite position",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("position").setX(0, NaN),
    ],
    [
      "negative authored Y",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("position").setY(0, -1),
    ],
    [
      "zero normal",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("normal").setXYZ(0, 0, 0, 0),
    ],
    [
      "petal weight",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("flowerPetal").setW(0, 2),
    ],
    [
      "color",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("color").setX(0, -1),
    ],
    [
      "UV",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.getAttribute("uv").setY(0, 2),
    ],
    [
      "missing index",
      (f: ReturnType<typeof fixture>) => f.geometry.setIndex(null),
    ],
    [
      "invalid index",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.index?.setX(0, f.geometry.getAttribute("position").count),
    ],
  ] as const)("rejects %s before graph use", (_label, mutate) => {
    const f = fixture();
    try {
      mutate(f);
      expect(() => assertRootedFlowerPool(f.mesh)).toThrow(/flower/);
      expect(() => expand(f.material.positionNode, f.mesh)).toThrow(/flower/);
    } finally {
      f.dispose();
    }
  });

  it.each([
    [
      "unregistered storage",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.deleteAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
    ],
    [
      "wrong storage owner",
      (f: ReturnType<typeof fixture>) =>
        f.geometry.setAttribute(
          INSTANCE_MATRIX_STORAGE_ATTRIBUTE,
          new THREE.StorageInstancedBufferAttribute(new Float32Array(32), 16),
        ),
    ],
    [
      "ordinary instance buffer",
      (f: ReturnType<typeof fixture>) => {
        f.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
          f.mesh.instanceMatrix.array,
          16,
        );
      },
    ],
    [
      "nonidentity pool",
      (f: ReturnType<typeof fixture>) =>
        f.mesh.matrixWorld.makeTranslation(1, 0, 0),
    ],
    [
      "excess count",
      (f: ReturnType<typeof fixture>) => {
        f.mesh.count = 3;
      },
    ],
    [
      "fractional count",
      (f: ReturnType<typeof fixture>) => {
        f.mesh.count = 0.5;
      },
    ],
    [
      "negative count",
      (f: ReturnType<typeof fixture>) => {
        f.mesh.count = -1;
      },
    ],
    [
      "tilt",
      (f: ReturnType<typeof fixture>) =>
        f.mesh.setMatrixAt(1, new THREE.Matrix4().makeRotationX(0.2)),
    ],
    [
      "nonuniform scale",
      (f: ReturnType<typeof fixture>) =>
        f.mesh.setMatrixAt(1, new THREE.Matrix4().makeScale(1, 2, 1)),
    ],
    [
      "negative scale",
      (f: ReturnType<typeof fixture>) =>
        f.mesh.setMatrixAt(1, new THREE.Matrix4().makeScale(-1, -1, -1)),
    ],
    [
      "nonfinite matrix",
      (f: ReturnType<typeof fixture>) =>
        f.mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(NaN, 0, 0)),
    ],
  ] as const)(
    "rejects %s at explicit admission and graph construction",
    (_label, mutate) => {
      const f = fixture();
      try {
        mutate(f);
        expect(() => assertRootedFlowerPool(f.mesh)).toThrow();
        expect(() => expand(f.material.positionNode, f.mesh)).toThrow();
      } finally {
        f.dispose();
      }
    },
  );

  it.each([0, 513])(
    "rejects unsupported native storage capacity %s",
    (capacity) => {
      const f = fixture(0.38, capacity);
      try {
        expect(() => assertRootedFlowerPool(f.mesh)).toThrow(
          /storage instance pool/,
        );
      } finally {
        f.dispose();
      }
    },
  );

  it("rejects non-storage objects and missing borrowed wind nodes", () => {
    const f = fixture();
    const plain = new THREE.Mesh(f.geometry, f.material);
    const batched = new THREE.BatchedMesh(1, 3, 3, f.material);
    try {
      expect(() => assertRootedFlowerPool(plain)).toThrow(
        /storage instance pool/,
      );
      expect(() => assertRootedFlowerPool(batched)).toThrow(
        /storage instance pool/,
      );
      for (const invalid of [
        null,
        {},
        { ...f.wind, time: 0 },
        { ...f.wind, direction: new THREE.Vector2(1, 0) },
      ])
        expect(() =>
          Reflect.apply(createRootedFlowerMaterial, undefined, [invalid]),
        ).toThrow(/borrowed/);
    } finally {
      batched.dispose();
      f.dispose();
    }
  });
});

describe("connected flower displacement contract", () => {
  it.each([0.12, 0.38, 0.8])(
    "keeps roots fixed and all scaled vertices inside expanded static bounds: %s",
    (height) => {
      const geometry = createRootedFlowerGeometry({ height });
      const authored = geometry.getAttribute("flowerHeight");
      const position = geometry.getAttribute("position");
      const fullHeight = authored.getY(0);
      try {
        for (const scale of [0.1, 1, 3, 10000]) {
          const bound = getRootedFlowerWindMaxDisplacement(fullHeight, scale);
          expect(bound).toBeLessThanOrEqual(
            ROOTED_FLOWER_WIND_MAX_DISPLACEMENT,
          );
          const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(29, 4, -81),
            new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              -1.2,
            ),
            new THREE.Vector3().setScalar(scale),
          );
          if (!geometry.boundingBox) throw new Error("Missing static bounds");
          const box = geometry.boundingBox
            .clone()
            .applyMatrix4(matrix)
            .expandByVector(new THREE.Vector3(bound, 0, bound));
          for (const time of [0, 7.3, 100]) {
            for (let index = 0; index < position.count; index++) {
              const input = {
                heightAboveRoot: authored.getX(index),
                fullHeight,
                scale,
                rootX: 29,
                rootZ: -81,
                time,
                strength: 5,
                directionX: -3,
                directionZ: 4,
              };
              const bend = evaluateTreeWindBend(input);
              expect(Math.hypot(...bend.displacement)).toBeLessThanOrEqual(
                bound + 1e-12,
              );
              if (input.heightAboveRoot === 0) {
                expect(Math.hypot(...bend.displacement)).toBe(0);
                expect(Math.hypot(...bend.derivative)).toBe(0);
              }
              const world = new THREE.Vector3()
                .fromBufferAttribute(position, index)
                .applyMatrix4(matrix);
              const y = world.y;
              world.x += bend.displacement[0];
              world.z += bend.displacement[1];
              expect(world.y).toBe(y);
              expect(box.containsPoint(world)).toBe(true);
              expect(
                Math.hypot(
                  ...evaluateTreeWindBend({ ...input, strength: 0 })
                    .displacement,
                ),
              ).toBe(0);
              expect(
                Math.hypot(
                  ...evaluateTreeWindBend({
                    ...input,
                    directionX: 0,
                    directionZ: 0,
                  }).displacement,
                ),
              ).toBe(0);
            }
          }
        }
      } finally {
        geometry.dispose();
      }
    },
  );

  it("scales the flower-specific world bound before the shared amplitude cap", () => {
    expect(getRootedFlowerWindMaxDisplacement(0.38, 1)).toBeCloseTo(
      0.01368,
      12,
    );
    expect(getRootedFlowerWindMaxDisplacement(0.38, 3)).toBeCloseTo(
      0.04104,
      12,
    );
    expect(getRootedFlowerWindMaxDisplacement(0.8, 10000)).toBe(0.36);
    expect(ROOTED_FLOWER_WIND_MAX_DISPLACEMENT).toBe(0.36);
  });

  it.each([
    [NaN, 1],
    [Infinity, 1],
    [0, 1],
    [0.119, 1],
    [0.801, 1],
    [0.38, NaN],
    [0.38, Infinity],
    [0.38, 0],
    [0.38, -1],
    [0.38, 10001],
  ])("rejects invalid bound inputs height=%s scale=%s", (height, scale) => {
    expect(() => getRootedFlowerWindMaxDisplacement(height, scale)).toThrow(
      /bounds input/,
    );
  });
});
