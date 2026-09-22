import { describe, expect, it } from "vitest";
import { instanceIndex, normalLocal, positionLocal, uniform } from "three/tsl";
import type { Node } from "three/webgpu";
import THREE from "../../../../extras/three/three";
import { createRootedFlowerGeometry } from "../../../../../../procgen/src/flowers/RootedFlowerGeometry";
import {
  INSTANCE_MATRIX_STORAGE_ATTRIBUTE,
  createStorageInstancedMesh,
} from "../../../../utils/rendering/createStorageInstancedMesh";
import { evaluateTreeWindBend } from "../TreeWind";
import {
  ROOTED_FLOWER_WIND_MAX_DISPLACEMENT,
  assertRootedFlowerPool,
  createRootedFlowerMaterial,
  getRootedFlowerWindBounds,
  getRootedFlowerWindMaxDisplacement,
  type RootedFlowerFadeOptions,
} from "../RootedFlowerMaterial";

// Real rooted geometry, native storage attributes and native NodeBuilder stacks.
// These bounded CPU graph checks do not claim GPU or native visual approval.
function fixture(height = 0.38, capacity = 2, fade?: RootedFlowerFadeOptions) {
  const geometry = createRootedFlowerGeometry({ height });
  const wind = {
    time: uniform(7.25),
    strength: uniform(1.3),
    direction: uniform(new THREE.Vector2(0.6, 0.8)),
  };
  const material = createRootedFlowerMaterial(wind, fade);
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

function expand(
  root: unknown,
  mesh: THREE.Mesh,
  camera: THREE.Camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000),
): Node[] {
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
  Reflect.set(builder, "camera", camera);
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

// Bounded arithmetic traversal of the actual native graph, following the
// existing TreeWind test convention. Not a renderer/device or GPU emulator.
// Unknown operations fail; the graph reads the actual storage matrix array.
function graphSample(
  roots: readonly Node[],
  f: ReturnType<typeof fixture>,
  vertex: number,
  authoredOverride?: THREE.Vector3,
  instance = 0,
) {
  const authored =
    authoredOverride ??
    new THREE.Vector3().fromBufferAttribute(
      f.geometry.getAttribute("position"),
      vertex,
    );
  const matrix = new THREE.Matrix4();
  f.mesh.getMatrixAt(instance, matrix);
  const initialNormal = new THREE.Vector3()
    .fromBufferAttribute(f.geometry.getAttribute("normal"), vertex)
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix));
  const values = new Map<Node, number[]>([
    [node(instanceIndex), [instance]],
    [node(positionLocal), authored.clone().applyMatrix4(matrix).toArray()],
    [node(normalLocal), initialNormal.toArray()],
  ]);
  const cache = new Map<Node, number[]>();
  const visit = (current: Node): number[] => {
    const fixed = values.get(current) ?? cache.get(current);
    if (fixed) return fixed;
    if (cache.size >= 4096)
      throw new Error("Bounded arithmetic graph exceeded");
    const read = (name: string): unknown => Reflect.get(current, name);
    const child = (name: string) => visit(node(read(name)));
    const value = read("value");
    const attributeName = read("_attributeName");
    let result: number[];
    if (read("isAssignNode")) {
      const target = node(read("targetNode"));
      result = child("sourceNode");
      values.set(target, result);
      cache.set(target, result);
    } else if (typeof attributeName === "string") {
      const attribute = f.geometry.getAttribute(attributeName);
      result = Array.from(
        attribute.array.slice(
          vertex * attribute.itemSize,
          (vertex + 1) * attribute.itemSize,
        ),
      );
      if (attributeName === "position") result = authored.toArray();
      if (attributeName === "flowerHeight") result[0] = authored.y;
    } else if (typeof value === "number" || typeof value === "boolean") {
      result = [Number(value)];
    } else if (
      value instanceof THREE.Vector2 ||
      value instanceof THREE.Vector3 ||
      value instanceof THREE.Vector4
    ) {
      result = value.toArray();
    } else if (value instanceof THREE.BufferAttribute) {
      result = Array.from(value.array);
    } else if (
      current.type === "ArrayElementNode" ||
      current.type === "StorageArrayElementNode"
    ) {
      const parent = node(read("node"));
      const array = visit(parent);
      const index = child("indexNode")[0];
      const width = Reflect.get(parent, "isBufferNode") ? 16 : 4;
      result = array.slice(index * width, (index + 1) * width);
    } else if (
      ["VarNode", "VaryingNode", "ConvertNode"].includes(current.type)
    ) {
      result = child("node");
    } else if (current.type === "SplitNode") {
      const source = child("node");
      result = [...String(read("components"))].map(
        (component) => source["xyzw".indexOf(component)],
      );
    } else if (current.type === "JoinNode") {
      const children: unknown = read("nodes");
      if (!Array.isArray(children)) throw new Error("Native joined nodes");
      result = children.flatMap((item: unknown) => visit(node(item)));
    } else if (current.type === "ConditionalNode") {
      result = child("condNode")[0] ? child("ifNode") : child("elseNode");
    } else {
      const a = child("aNode");
      const method = read("method");
      if (method === "length") result = [Math.hypot(...a)];
      else if (method === "normalize")
        result = a.map((component) => component / Math.hypot(...a));
      else if (method === "sin") result = a.map(Math.sin);
      else {
        const b = child("bNode");
        if (read("op") === "*" && a.length === 16 && b.length === 4) {
          result = new THREE.Vector4(b[0], b[1], b[2], b[3])
            .applyMatrix4(new THREE.Matrix4().fromArray(a))
            .toArray();
        } else {
          const c = read("cNode") instanceof THREE.Node ? child("cNode") : [0];
          result = Array.from(
            { length: Math.max(a.length, b.length, c.length) },
            (_, index) => {
              const x = a[a.length === 1 ? 0 : index];
              const y = b[b.length === 1 ? 0 : index];
              const z = c[c.length === 1 ? 0 : index];
              switch (read("op")) {
                case "+":
                  return x + y;
                case "-":
                  return x - y;
                case "*":
                  return x * y;
                case "/":
                  return x / y;
                case ">":
                  return Number(x > y);
                case "<":
                  return Number(x < y);
                case "&&":
                  return Number(Boolean(x) && Boolean(y));
              }
              if (method === "min") return Math.min(x, y);
              if (method === "max") return Math.max(x, y);
              if (method === "clamp") return Math.min(z, Math.max(y, x));
              if (method === "smoothstep") {
                const t = Math.max(0, Math.min(1, (z - x) / (y - x)));
                return t * t * (3 - 2 * t);
              }
              throw new Error(
                `Unknown native arithmetic ${current.type}/${String(method)}/${String(read("op"))}`,
              );
            },
          );
        }
      }
    }
    if (result.some((component) => !Number.isFinite(component)))
      throw new Error(`Nonfinite ${current.type}`);
    cache.set(current, result);
    return result;
  };
  const result = roots.map(visit);
  return {
    position: new THREE.Vector3().fromArray(result[result.length - 1]),
    normal: new THREE.Vector3().fromArray(visit(node(normalLocal))),
  };
}

// Independent scalar statement of the documented composed equations. The
// native graph is tested against this and differentiated directly below.
function numericSample(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  vertex: number,
  time: number,
  strength = 5,
  direction = new THREE.Vector2(-3, 4),
) {
  const authored = new THREE.Vector3().fromBufferAttribute(
    geometry.getAttribute("position"),
    vertex,
  );
  const petal = geometry.getAttribute("flowerPetal");
  const height = geometry.getAttribute("flowerHeight").getY(vertex);
  const scale = new THREE.Vector3().setFromMatrixColumn(matrix, 1).length();
  const root = new THREE.Vector3().setFromMatrixPosition(matrix);
  const q = new THREE.Vector4(
    authored.x - petal.getX(vertex),
    authored.y - petal.getY(vertex),
    authored.z - petal.getZ(vertex),
    0,
  ).applyMatrix4(matrix);
  const worldHeight = height * scale;
  const phase =
    root.x * 0.013 +
    root.z * 0.017 +
    (71 * petal.getX(vertex) + 113 * petal.getZ(vertex)) / height;
  const a =
    ((Math.sin(time * 2.1 + phase) * Math.min(2, Math.max(0, strength))) / 2) *
    Math.min(direction.length(), 1);
  const k =
    petal.getW(vertex) > 0
      ? (0.6 * Math.min(worldHeight, 1) * a) / worldHeight ** 2
      : 0;
  const radiusSquared = q.x ** 2 + q.z ** 2;
  const capSquared = (0.08 * worldHeight) ** 2;
  const dy = k * Math.min(radiusSquared, capSquared);
  const slope = radiusSquared < capSquared ? 2 * k : 0;
  const gradient = new THREE.Vector2(slope * q.x, slope * q.z);
  const input = {
    heightAboveRoot: authored.y + dy / scale,
    fullHeight: height,
    scale,
    rootX: root.x,
    rootZ: root.z,
    time,
    strength,
    directionX: direction.x,
    directionZ: direction.y,
  };
  const bend = evaluateTreeWindBend(input);
  const normal = new THREE.Vector3()
    .fromBufferAttribute(geometry.getAttribute("normal"), vertex)
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix));
  normal.x -= gradient.x * normal.y;
  normal.z -= gradient.y * normal.y;
  normal.y -= bend.derivative[0] * normal.x + bend.derivative[1] * normal.z;
  const position = authored
    .clone()
    .applyMatrix4(matrix)
    .add(new THREE.Vector3(bend.displacement[0], dy, bend.displacement[1]));
  return { position, normal: normal.normalize(), dy, gradient, bend, input };
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
      ).toBe(true);
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

  it("composes flutter rather than claiming equality with the stem-only graph", () => {
    const f = fixture();
    try {
      const graph = expand(f.material.positionNode, f.mesh);
      const matrix = new THREE.Matrix4();
      f.mesh.getMatrixAt(0, matrix);
      const petal = f.geometry.getAttribute("flowerPetal");
      const vertex = Array.from(
        { length: petal.count },
        (_, index) => index,
      ).find((index) => petal.getW(index) === 1);
      if (vertex === undefined) throw new Error("Actual petal tip missing");
      const expected = numericSample(
        f.geometry,
        matrix,
        vertex,
        f.wind.time.value,
        f.wind.strength.value,
        f.wind.direction.value,
      );
      const actual = graphSample(graph, f, vertex);
      expect(Math.abs(expected.dy)).toBeGreaterThan(1e-7);
      expect(actual.position.distanceTo(expected.position)).toBeLessThan(1e-12);
      expect(actual.normal.distanceTo(expected.normal)).toBeLessThan(1e-12);
      const oldBend = evaluateTreeWindBend({
        ...expected.input,
        heightAboveRoot: f.geometry.getAttribute("position").getY(vertex),
      });
      expect(
        Math.hypot(
          expected.bend.displacement[0] - oldBend.displacement[0],
          expected.bend.displacement[1] - oldBend.displacement[1],
        ),
      ).toBeGreaterThan(1e-9);
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
  it.each([
    { yaw: 0.6, scale: 0.8 },
    { yaw: -1.2, scale: 3 },
    { yaw: 1.7, scale: 0.1 },
    { yaw: -0.4, scale: 10000 },
  ])(
    "matches the real native graph after yaw=$yaw scale=$scale and both wind stages",
    ({ yaw, scale }) => {
      const f = fixture();
      f.mesh.setMatrixAt(
        0,
        new THREE.Matrix4().compose(
          new THREE.Vector3(19, 3, -42),
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            yaw,
          ),
          new THREE.Vector3().setScalar(scale),
        ),
      );
      const matrix = new THREE.Matrix4();
      f.mesh.getMatrixAt(0, matrix);
      try {
        const graph = expand(f.material.positionNode, f.mesh);
        const petals = f.geometry.getAttribute("flowerPetal");
        const selected = [0, 60, 70, 81, 82, 106, 107, 339, 340, 361];
        for (const time of [0, 7.3, 100]) {
          f.wind.time.value = time;
          for (const vertex of selected) {
            const expected = numericSample(
              f.geometry,
              matrix,
              vertex,
              time,
              f.wind.strength.value,
              f.wind.direction.value,
            );
            const actual = graphSample(graph, f, vertex);
            expect(actual.position.distanceTo(expected.position)).toBeLessThan(
              1e-10,
            );
            expect(actual.normal.distanceTo(expected.normal)).toBeLessThan(
              1e-10,
            );
            expect(actual.normal.length()).toBeCloseTo(1, 12);
            if (petals.getW(vertex) === 0)
              expect(Math.abs(expected.dy)).toBe(0);
          }
        }
        for (const zero of ["strength", "direction"] as const) {
          f.wind.strength.value = zero === "strength" ? 0 : 1.3;
          f.wind.direction.value.set(
            zero === "direction" ? 0 : 0.6,
            zero === "direction" ? 0 : 0.8,
          );
          for (const vertex of selected) {
            const actual = graphSample(graph, f, vertex);
            const original = new THREE.Vector3()
              .fromBufferAttribute(f.geometry.getAttribute("position"), vertex)
              .applyMatrix4(matrix);
            expect(actual.position.toArray()).toEqual(original.toArray());
          }
        }
      } finally {
        f.dispose();
      }
    },
  );

  it.each([
    { yaw: 0.6, scale: 0.8 },
    { yaw: -1.2, scale: 3 },
    { yaw: 1.7, scale: 0.1 },
  ])(
    "has the composed inverse-transpose normal by native graph finite differences: $yaw/$scale",
    ({ yaw, scale }) => {
      const f = fixture();
      f.mesh.setMatrixAt(
        0,
        new THREE.Matrix4().compose(
          new THREE.Vector3(19, 3, -42),
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            yaw,
          ),
          new THREE.Vector3().setScalar(scale),
        ),
      );
      const matrix = new THREE.Matrix4();
      f.mesh.getMatrixAt(0, matrix);
      const inverseLinear = new THREE.Matrix3().setFromMatrix4(matrix).invert();
      try {
        const graph = expand(f.material.positionNode, f.mesh);
        for (const vertex of [87, 94, 105, 211]) {
          const authored = new THREE.Vector3().fromBufferAttribute(
            f.geometry.getAttribute("position"),
            vertex,
          );
          const originalNormal = new THREE.Vector3()
            .fromBufferAttribute(f.geometry.getAttribute("normal"), vertex)
            .applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix))
            .normalize();
          const tangent = originalNormal
            .clone()
            .cross(new THREE.Vector3(1, 0, 0))
            .normalize();
          const bitangent = originalNormal.clone().cross(tangent).normalize();
          const actual = graphSample(graph, f, vertex);
          const epsilon =
            f.geometry.getAttribute("flowerHeight").getY(vertex) * scale * 1e-4;
          for (const direction of [tangent, bitangent]) {
            const step = direction
              .clone()
              .multiplyScalar(epsilon)
              .applyMatrix3(inverseLinear);
            const plus = graphSample(
              graph,
              f,
              vertex,
              authored.clone().add(step),
            ).position;
            const minus = graphSample(
              graph,
              f,
              vertex,
              authored.clone().sub(step),
            ).position;
            const derivative = plus.sub(minus).multiplyScalar(0.5 / epsilon);
            expect(Math.abs(actual.normal.dot(derivative))).toBeLessThan(2e-6);
          }
        }
      } finally {
        f.dispose();
      }
    },
  );

  it("has zero value and slope at the actual shared hinge and a bounded outer radial cap", () => {
    const f = fixture();
    try {
      const graph = expand(f.material.positionNode, f.mesh);
      const vertex = 82;
      const petal = f.geometry.getAttribute("flowerPetal");
      expect(petal.getW(vertex)).toBeGreaterThan(0);
      const hinge = new THREE.Vector3(
        petal.getX(vertex),
        petal.getY(vertex),
        petal.getZ(vertex),
      );
      const matrix = new THREE.Matrix4();
      f.mesh.getMatrixAt(0, matrix);
      const scale = new THREE.Vector3().setFromMatrixColumn(matrix, 1).length();
      const height = f.geometry.getAttribute("flowerHeight").getY(vertex);
      const atHinge = graphSample(graph, f, vertex, hinge);
      const hingeWorld = hinge.clone().applyMatrix4(matrix);
      expect(atHinge.position.y).toBe(hingeWorld.y);
      const epsilon = height * 1e-4;
      const plus = graphSample(
        graph,
        f,
        vertex,
        hinge.clone().add(new THREE.Vector3(epsilon, 0, 0)),
      );
      const minus = graphSample(
        graph,
        f,
        vertex,
        hinge.clone().sub(new THREE.Vector3(epsilon, 0, 0)),
      );
      expect(
        Math.abs((plus.position.y - minus.position.y) / (2 * epsilon * scale)),
      ).toBeLessThan(1e-10);
      const bounds = getRootedFlowerWindBounds(height, scale);
      const outside = hinge.clone().add(new THREE.Vector3(height * 0.09, 0, 0));
      const farther = hinge.clone().add(new THREE.Vector3(height * 0.1, 0, 0));
      const capped = graphSample(graph, f, vertex, outside);
      const cappedFarther = graphSample(graph, f, vertex, farther);
      expect(
        Math.abs(capped.position.y - outside.clone().applyMatrix4(matrix).y),
      ).toBeLessThanOrEqual(bounds.y + 1e-12);
      expect(capped.position.y).toBe(cappedFarther.position.y);
      expect(capped.normal.distanceTo(cappedFarther.normal)).toBeLessThan(
        1e-12,
      );
    } finally {
      f.dispose();
    }
  });

  it.each([0.12, 0.38, 0.8])(
    "keeps roots fixed and all scaled vertices inside expanded static bounds: %s",
    (height) => {
      const geometry = createRootedFlowerGeometry({ height });
      const authored = geometry.getAttribute("flowerHeight");
      const position = geometry.getAttribute("position");
      const petals = geometry.getAttribute("flowerPetal");
      const fullHeight = authored.getY(0);
      try {
        for (const scale of [0.1, 1, 3, 10000]) {
          const bounds = getRootedFlowerWindBounds(fullHeight, scale);
          expect(bounds.sphere).toBeLessThanOrEqual(
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
          if (
            !geometry.boundingBox ||
            !geometry.boundingSphere ||
            !geometry.index
          )
            throw new Error("Missing static bounds/index");
          const box = geometry.boundingBox
            .clone()
            .applyMatrix4(matrix)
            .expandByVector(new THREE.Vector3(bounds.x, bounds.y, bounds.z));
          const sphere = geometry.boundingSphere.clone().applyMatrix4(matrix);
          sphere.radius += bounds.sphere;
          for (const time of [0, 7.3, 100]) {
            const deformed: THREE.Vector3[] = [];
            for (let index = 0; index < position.count; index++) {
              const sample = numericSample(geometry, matrix, index, time);
              const original = new THREE.Vector3()
                .fromBufferAttribute(position, index)
                .applyMatrix4(matrix);
              expect(Math.abs(sample.dy)).toBeLessThanOrEqual(bounds.y + 1e-12);
              expect(
                Math.hypot(...sample.bend.displacement),
              ).toBeLessThanOrEqual(bounds.x + 1e-12);
              expect(sample.position.distanceTo(original)).toBeLessThanOrEqual(
                bounds.sphere + 1e-10,
              );
              if (authored.getX(index) === 0)
                expect(sample.position.toArray()).toEqual(original.toArray());
              if (petals.getW(index) === 0) {
                expect(Math.abs(sample.dy)).toBe(0);
                expect(sample.gradient.length()).toBe(0);
              }
              expect(box.containsPoint(sample.position)).toBe(true);
              expect(sphere.containsPoint(sample.position)).toBe(true);
              expect(
                numericSample(
                  geometry,
                  matrix,
                  index,
                  time,
                  0,
                ).position.toArray(),
              ).toEqual(original.toArray());
              expect(
                numericSample(
                  geometry,
                  matrix,
                  index,
                  time,
                  5,
                  new THREE.Vector2(),
                ).position.toArray(),
              ).toEqual(original.toArray());
              deformed.push(sample.position);
            }
            // Rendered triangles are affine interpolations of these vertices.
            // Convex expanded boxes/spheres contain their entire surfaces.
            for (
              let triangle = 0;
              triangle < geometry.index.count;
              triangle += 3
            ) {
              const [a, b, c] = [0, 1, 2].map(
                (offset) =>
                  deformed[geometry.index?.getX(triangle + offset) ?? 0],
              );
              const center = a
                .clone()
                .add(b)
                .add(c)
                .multiplyScalar(1 / 3);
              expect(box.containsPoint(center)).toBe(true);
              expect(sphere.containsPoint(center)).toBe(true);
              expect(
                b.clone().sub(a).cross(c.clone().sub(a)).lengthSq(),
              ).toBeGreaterThan(1e-30);
            }
          }
        }
      } finally {
        geometry.dispose();
      }
    },
  );

  it("exports explicit combined XYZ and sphere bounds, never a stem-only full bound", () => {
    const small = getRootedFlowerWindBounds(0.38, 1);
    expect(small.x).toBeCloseTo(0.01368, 12);
    expect(small.z).toBe(small.x);
    expect(small.y).toBeCloseTo(0.00384 * 0.38, 12);
    expect(small.sphere).toBe(Math.hypot(small.x, small.y));
    expect(getRootedFlowerWindMaxDisplacement(0.38, 1)).toBe(small.sphere);
    expect(getRootedFlowerWindBounds(0.38, 3).x).toBeCloseTo(0.04104, 12);
    const capped = getRootedFlowerWindBounds(0.8, 10000);
    expect(capped.x).toBe(0.36);
    expect(capped.y).toBeCloseTo(0.00384, 12);
    expect(capped.sphere).toBe(ROOTED_FLOWER_WIND_MAX_DISPLACEMENT);
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
    expect(() => getRootedFlowerWindBounds(height, scale)).toThrow(
      /bounds input/,
    );
  });
});

describe("optional owner-focused rooted flower fade", () => {
  it("keeps the default graph unchanged and borrows one additional focus only when requested", () => {
    const focus = uniform(new THREE.Vector2(19, -42));
    const options: RootedFlowerFadeOptions = {
      focus,
      fadeStart: 24,
      fadeEnd: 32,
    };
    const baseline = fixture();
    const faded = fixture(0.38, 2, options);
    try {
      const originalGraph = [
        ...nodes(expand(baseline.material.positionNode, baseline.mesh)),
      ];
      const graph = [...nodes(expand(faded.material.positionNode, faded.mesh))];
      expect(
        originalGraph.some(
          (item) => Reflect.get(item, "method") === "smoothstep",
        ),
      ).toBe(false);
      expect(
        graph.filter((item) => Reflect.get(item, "method") === "smoothstep"),
      ).toHaveLength(1);
      const uniforms = graph.filter(
        (item) =>
          Reflect.get(item, "isUniformNode") &&
          !Reflect.get(item, "isStorageBufferNode"),
      );
      expect(new Set(uniforms)).toEqual(
        new Set([...Object.values(faded.wind), focus]),
      );
      expect(
        graph.filter((item) => Reflect.get(item, "isStorageBufferNode")),
      ).toHaveLength(1);
      expect(graph.some((item) => Reflect.get(item, "isTextureNode"))).toBe(
        false,
      );
      expect(faded.material).toMatchObject({
        transparent: false,
        opacity: 1,
        opacityNode: null,
        alphaTest: 0,
        alphaToCoverage: false,
        normalNode: null,
        castShadowPositionNode: null,
        roughness: baseline.material.roughness,
        depthWrite: baseline.material.depthWrite,
      });
      // Capture the borrowed node itself, not a mutable caller options object.
      Reflect.set(options, "focus", uniform(new THREE.Vector2(1000, 1000)));
      Reflect.set(options, "fadeStart", 0);
      expect([
        ...nodes(expand(faded.material.positionNode, faded.mesh)),
      ]).toContain(focus);
      faded.material.dispose();
      expect(focus.value.toArray()).toEqual([19, -42]);
      expect(faded.mesh.instanceMatrix).toBe(
        faded.geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
      );
    } finally {
      baseline.dispose();
      faded.dispose();
    }
  });

  it("shrinks the complete wind-deformed geometry uniformly about each root at the fixed endpoints", () => {
    const focus = uniform(new THREE.Vector2());
    const baseline = fixture();
    const faded = fixture(0.38, 2, { focus, fadeStart: 24, fadeEnd: 32 });
    try {
      const originalGraph = expand(
        baseline.material.positionNode,
        baseline.mesh,
      );
      const graph = expand(faded.material.positionNode, faded.mesh);
      const count = faded.geometry.getAttribute("position").count;
      for (const instance of [0, 1]) {
        const matrix = new THREE.Matrix4();
        faded.mesh.getMatrixAt(instance, matrix);
        const root = new THREE.Vector3().setFromMatrixPosition(matrix);
        const scale = new THREE.Vector3()
          .setFromMatrixColumn(matrix, 1)
          .length();
        const height = faded.geometry.getAttribute("flowerHeight").getY(0);
        const windBounds = getRootedFlowerWindBounds(height, scale);
        const box = faded.geometry.boundingBox
          ?.clone()
          .applyMatrix4(matrix)
          .expandByVector(
            new THREE.Vector3(windBounds.x, windBounds.y, windBounds.z),
          );
        const sphere = faded.geometry.boundingSphere
          ?.clone()
          .applyMatrix4(matrix);
        if (!box || !sphere) throw new Error("Actual flower bounds missing");
        sphere.radius += windBounds.sphere;
        expect(box.containsPoint(root)).toBe(true);
        expect(sphere.containsPoint(root)).toBe(true);
        for (const [distance, retained] of [
          [0, 1],
          [24, 1],
          [26, 0.84375],
          [28, 0.5],
          [30, 0.15625],
          [32, 0],
          [40, 0],
        ]) {
          // Non-axis-aligned focus proves the world-XZ radial distance.
          focus.value.set(root.x + distance * 0.6, root.z + distance * 0.8);
          for (let vertex = 0; vertex < count; vertex++) {
            const full = graphSample(
              originalGraph,
              baseline,
              vertex,
              undefined,
              instance,
            );
            const actual = graphSample(
              graph,
              faded,
              vertex,
              undefined,
              instance,
            );
            const expected = full.position
              .clone()
              .sub(root)
              .multiplyScalar(retained)
              .add(root);
            expect(actual.position.distanceTo(expected)).toBeLessThan(1e-12);
            expect(actual.normal.toArray()).toEqual(full.normal.toArray());
            expect(actual.normal.length()).toBeCloseTo(1, 12);
            expect(box.containsPoint(actual.position)).toBe(true);
            expect(sphere.containsPoint(actual.position)).toBe(true);
            if (retained === 0)
              expect(actual.position.toArray()).toEqual(root.toArray());
          }
          // Exact root anchor, not a promise that the stem ring keeps its width.
          const anchor = graphSample(
            graph,
            faded,
            0,
            new THREE.Vector3(),
            instance,
          );
          expect(anchor.position.toArray()).toEqual(root.toArray());
        }
      }
    } finally {
      baseline.dispose();
      faded.dispose();
    }
  });

  it("uses identical vertex fade for primary and shadow cameras and observes live owner focus", () => {
    const focus = uniform(new THREE.Vector2(19 + 28, -42));
    const f = fixture(0.38, 2, { focus, fadeStart: 24, fadeEnd: 32 });
    const main = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
    main.position.set(19, 5, -38);
    main.updateMatrixWorld();
    const shadow = new THREE.OrthographicCamera(-120, 120, 120, -120, 0.1, 600);
    shadow.position.set(-200, 400, 500);
    shadow.updateMatrixWorld();
    try {
      const mainGraph = expand(f.material.positionNode, f.mesh, main);
      const shadowGraph = expand(f.material.positionNode, f.mesh, shadow);
      for (const distance of [0, 28, 32]) {
        focus.value.set(19 + distance, -42);
        for (const vertex of [0, 81, 82, 106, 211, 361]) {
          const a = graphSample(mainGraph, f, vertex);
          const b = graphSample(shadowGraph, f, vertex);
          expect(a.position.toArray()).toEqual(b.position.toArray());
          expect(a.normal.toArray()).toEqual(b.normal.toArray());
          if (distance === 32)
            expect(a.position.toArray()).toEqual([19, 3, -42]);
          else
            expect(
              a.position.distanceTo(new THREE.Vector3(19, 3, -42)),
            ).toBeGreaterThan(0);
        }
      }
    } finally {
      f.dispose();
    }
  });

  it("rejects malformed fade options and non-vec2 native nodes before graph use", () => {
    const f = fixture();
    const focus = uniform(new THREE.Vector2());
    try {
      for (const invalid of [
        null,
        {},
        { focus },
        { focus, fadeStart: 0, fadeEnd: 32 },
        { focus, fadeStart: 24, fadeEnd: 33 },
        { focus: new THREE.Vector2(), fadeStart: 24, fadeEnd: 32 },
      ])
        expect(() =>
          Reflect.apply(createRootedFlowerMaterial, undefined, [
            f.wind,
            invalid,
          ]),
        ).toThrow(/fade/);
      for (const invalidFocus of [uniform(1), uniform(new THREE.Vector3())]) {
        const material: unknown = Reflect.apply(
          createRootedFlowerMaterial,
          undefined,
          [f.wind, { focus: invalidFocus, fadeStart: 24, fadeEnd: 32 }],
        );
        if (!(material instanceof THREE.MeshStandardNodeMaterial))
          throw new Error("Actual node material required");
        try {
          expect(() => expand(material.positionNode, f.mesh)).toThrow(
            "fade focus must be vec2",
          );
        } finally {
          material.dispose();
        }
      }
    } finally {
      f.dispose();
    }
  });
});

describe("petal attachment admission", () => {
  const petalVertices = (f: ReturnType<typeof fixture>) => {
    const petal = f.geometry.getAttribute("flowerPetal");
    return Array.from({ length: petal.count }, (_, vertex) => vertex).filter(
      (vertex) => petal.getW(vertex) > 0,
    );
  };

  it.each([
    [
      "no petal groups",
      (f: ReturnType<typeof fixture>) => {
        for (const vertex of petalVertices(f))
          f.geometry.getAttribute("flowerPetal").setW(vertex, 0);
      },
    ],
    [
      "inconsistent hinge in one triangle",
      (f: ReturnType<typeof fixture>) => {
        const vertex = petalVertices(f)[0];
        const petal = f.geometry.getAttribute("flowerPetal");
        petal.setX(vertex, petal.getX(vertex) + 0.0001);
      },
    ],
    [
      "missing exact shared hinge",
      (f: ReturnType<typeof fixture>) => {
        const petal = f.geometry.getAttribute("flowerPetal");
        const reference = petalVertices(f)[0];
        const key = [
          petal.getX(reference),
          petal.getY(reference),
          petal.getZ(reference),
        ];
        for (const vertex of petalVertices(f)) {
          if (
            petal.getX(vertex) === key[0] &&
            petal.getY(vertex) === key[1] &&
            petal.getZ(vertex) === key[2]
          )
            petal.setY(vertex, key[1] + 0.0001);
        }
      },
    ],
    [
      "stationary vertex inside a petal",
      (f: ReturnType<typeof fixture>) => {
        f.geometry.getAttribute("flowerPetal").setW(petalVertices(f)[0], 0);
      },
    ],
    [
      "radius outside declared envelope",
      (f: ReturnType<typeof fixture>) => {
        const vertex = petalVertices(f)[0];
        const petal = f.geometry.getAttribute("flowerPetal");
        f.geometry
          .getAttribute("position")
          .setX(
            vertex,
            petal.getX(vertex) +
              0.081 * f.geometry.getAttribute("flowerHeight").getY(vertex),
          );
      },
    ],
    [
      "root vertex marked as a petal",
      (f: ReturnType<typeof fixture>) => {
        f.geometry.getAttribute("flowerPetal").setXYZW(0, 0, 0, 0, 0.2);
      },
    ],
  ] as const)("rejects %s without mutating geometry", (_label, mutate) => {
    const f = fixture();
    try {
      mutate(f);
      const before = Object.entries(f.geometry.attributes).map(
        ([name, attribute]) => [name, Array.from(attribute.array)],
      );
      expect(() => assertRootedFlowerPool(f.mesh)).toThrow(/flower/);
      expect(() => expand(f.material.positionNode, f.mesh)).toThrow(/flower/);
      expect(
        Object.entries(f.geometry.attributes).map(([name, attribute]) => [
          name,
          Array.from(attribute.array),
        ]),
      ).toEqual(before);
    } finally {
      f.dispose();
    }
  });
});
