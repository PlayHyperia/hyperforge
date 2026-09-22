import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import type { Node } from "three/webgpu";
import { WGSLNodeBuilder } from "three/webgpu";
import { JSDOM } from "jsdom";
import {
  batchIndirectIndex,
  float,
  instanceIndex,
  normalLocal,
  positionLocal,
  tangentGeometry,
  tangentLocal,
  vec2,
  vec3,
} from "three/tsl";
import { createStorageInstancedMesh } from "../../../../utils/rendering/createStorageInstancedMesh";
import {
  TREE_WIND_ATTRIBUTE,
  TREE_WIND_MAX_DISPLACEMENT,
  assertTreeWindInstanceMatrix,
  cloneGeometryWithTreeWind,
  createTreeWindBendNodes,
  createTreeWindFrameNodes,
  createTreeWindPositionNode,
  deriveTreeWindDescriptor,
  evaluateTreeWindBend,
} from "../TreeWind";

// Actual geometry, instance buffers, TSL arithmetic and NodeBuilder stacks.
// No renderer/device/capability mock, shader replacement or native GPU claim.
function geometry(ys: number[]) {
  const result = new THREE.BufferGeometry();
  result.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      ys.flatMap((y, index) => [index * 0.2, y, -index * 0.1]),
      3,
    ),
  );
  result.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      ys.flatMap(() => [1, 0, 0]),
      3,
    ),
  );
  result.setAttribute(
    "tangent",
    new THREE.Float32BufferAttribute(
      ys.flatMap(() => [0, 1, 0, -1]),
      4,
    ),
  );
  result.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      ys.flatMap((_, index) => [index % 2, 0.5, 0]),
      3,
    ),
  );
  return result;
}

function actualNode(value: unknown): Node {
  if (!(value instanceof THREE.Node))
    throw new Error("Expected actual TSL node");
  return value;
}

function withStack<T>(
  mesh: THREE.Mesh,
  action: (builder: THREE.NodeBuilder) => T,
): T {
  // The r186 JS class is constructible; its declaration marks it abstract.
  const actual: unknown = Reflect.construct(THREE.NodeBuilder, [
    mesh,
    null,
    null,
  ]);
  if (!(actual instanceof THREE.NodeBuilder))
    throw new Error("Missing actual builder");
  const builder = actual;
  Reflect.set(builder, "camera", new THREE.PerspectiveCamera(50, 1, 0.1, 1000));
  Reflect.set(builder, "shaderStage", "vertex");
  const add: unknown = Reflect.get(builder, "addStack");
  const remove: unknown = Reflect.get(builder, "removeStack");
  if (typeof add !== "function" || typeof remove !== "function")
    throw new Error("Missing native stack methods");
  add.call(builder);
  try {
    return action(builder);
  } finally {
    remove.call(builder);
  }
}

function stackNodes(builder: THREE.NodeBuilder): Node[] {
  const stack: unknown = Reflect.get(builder, "stack");
  if (!(stack instanceof THREE.StackNode))
    throw new Error("Missing actual stack");
  return stack.nodes;
}

/** Arithmetic evaluator of the real graph. Unknown operations fail, and native
 * texture/instance contents are read directly. This is NOT a GPU emulator. */
function evaluator(
  values = new Map<Node, number[]>(),
  builder?: THREE.NodeBuilder,
) {
  const cache = new Map<Node, number[]>();
  const visit = (node: Node): number[] => {
    const fixed = values.get(node) ?? cache.get(node);
    if (fixed) return fixed;
    const read = (name: string): unknown => Reflect.get(node, name);
    const child = (name: string) => visit(actualNode(read(name)));
    let result: number[];
    const value = read("value");
    if (read("isAssignNode")) {
      const target = actualNode(read("targetNode"));
      result = child("sourceNode");
      values.set(target, result);
      cache.set(target, result);
    } else if (read("isTextureNode")) {
      if (
        !(value instanceof THREE.DataTexture) ||
        !(value.image.data instanceof Float32Array) ||
        read("sampler") !== false
      )
        throw new Error("Expected native data textureLoad");
      const uv = child("uvNode");
      const index = (uv[1] * value.image.width + uv[0]) * 4;
      result = Array.from(value.image.data.slice(index, index + 4));
    } else if (typeof value === "number" || typeof value === "boolean") {
      result = [Number(value)];
    } else if (
      value instanceof THREE.Vector2 ||
      value instanceof THREE.Vector3 ||
      value instanceof THREE.Vector4
    ) {
      result = value.toArray();
    } else if (value instanceof Float32Array) {
      result = Array.from(value);
    } else if (value instanceof THREE.BufferAttribute) {
      result = Array.from(value.array);
    } else if (
      node.type === "ArrayElementNode" ||
      node.type === "StorageArrayElementNode"
    ) {
      const parent = actualNode(read("node"));
      const array = visit(parent);
      const index = child("indexNode")[0];
      // A native matrix buffer is an array of mat4; indexing the resulting mat4
      // yields its vec4 column. No substitute matrix is supplied to this graph.
      const width = Reflect.get(parent, "isBufferNode") ? 16 : 4;
      result = array.slice(index * width, (index + 1) * width);
    } else if (["VarNode", "VaryingNode", "ConvertNode"].includes(node.type)) {
      result = child("node");
      const to = read("convertTo");
      if (to === "int" || to === "uint") result = result.map(Math.trunc);
    } else if (node.type === "SplitNode") {
      const source = child("node");
      result = [...String(read("components"))].map(
        (c) => source["xyzw".indexOf(c)],
      );
    } else if (node.type === "JoinNode") {
      const children: unknown = read("nodes");
      if (!Array.isArray(children)) throw new Error("Expected joined nodes");
      result = children.flatMap((item: unknown) => visit(actualNode(item)));
    } else if (node.type === "ConditionalNode") {
      result = child("condNode")[0] ? child("ifNode") : child("elseNode");
    } else {
      const a = child("aNode");
      const method = read("method");
      if (method === "length") result = [Math.hypot(...a)];
      else if (method === "normalize")
        result = a.map((x) => x / Math.hypot(...a));
      else if (method === "sin") result = a.map(Math.sin);
      else {
        const b = child("bNode");
        if (read("op") === "*" && a.length === 16 && b.length === 4) {
          const transformed = new THREE.Vector4(b[0], b[1], b[2], b[3])
            .applyMatrix4(new THREE.Matrix4().fromArray(a))
            .toArray();
          cache.set(node, transformed);
          return transformed;
        }
        const c = read("cNode") instanceof THREE.Node ? child("cNode") : [0];
        result = Array.from(
          { length: Math.max(a.length, b.length, c.length) },
          (_, index) => {
            const x = a[a.length === 1 ? 0 : index];
            const y = b[b.length === 1 ? 0 : index];
            const z = c[c.length === 1 ? 0 : index];
            const op = read("op");
            if (op === "+") return x + y;
            if (op === "-") return x - y;
            if (op === "*") return x * y;
            if (op === "/") return x / y;
            if (op === "%") return x % y;
            if (op === ">") return Number(x > y);
            if (op === "<") return Number(x < y);
            if (op === "&&") return Number(Boolean(x) && Boolean(y));
            if (method === "min") return Math.min(x, y);
            if (method === "max") return Math.max(x, y);
            if (method === "clamp") return Math.min(z, Math.max(y, x));
            throw new Error(
              `Unknown ${node.type}/${String(method)}/${String(op)}`,
            );
          },
        );
        // Native batching divides ints; retain the actual shader type semantics.
        if (
          read("op") === "/" &&
          builder &&
          ["int", "uint"].includes(node.getNodeType(builder))
        ) {
          result = result.map(Math.trunc);
        }
      }
    }
    if (result.some((n) => !Number.isFinite(n)))
      throw new Error(`Nonfinite ${node.type}`);
    cache.set(node, result);
    return result;
  };
  return visit;
}

const numeric = {
  heightAboveRoot: 6,
  fullHeight: 12,
  scale: 1,
  rootX: 449,
  rootZ: 410,
  time: 7.3,
  strength: 1.2,
  directionX: 0.6,
  directionZ: 0.8,
};

describe("connected tree wind geometry ownership", () => {
  it("uses actual full LOD0 union, explicit root, shared part/LOD metadata and owned clones", () => {
    const bark = geometry([-0.92, 0, 8]);
    const leaves = geometry([4, 18, 12]);
    const lod = geometry([-1, 4, 19]);
    bark.computeBoundingBox();
    if (!bark.boundingBox) throw new Error("Missing real geometry bounds");
    bark.boundingBox.max.y = 900; // stale cache must not supply wind top
    const before = Array.from(bark.attributes.position.array);
    const descriptor = deriveTreeWindDescriptor([bark, leaves], 0);
    const owned = [bark, leaves, lod].map((g) =>
      cloneGeometryWithTreeWind(g, descriptor),
    );
    try {
      expect(descriptor).toEqual({
        schemaVersion: 1,
        rootY: 0,
        topY: 18,
        height: 18,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      owned.forEach((g, i) => {
        expect(g.attributes.position).not.toBe(
          [bark, leaves, lod][i].attributes.position,
        );
        expect(g.attributes.normal).not.toBe(
          [bark, leaves, lod][i].attributes.normal,
        );
        expect(g.attributes.color.array).toEqual(
          [bark, leaves, lod][i].attributes.color.array,
        );
        expect(g.getAttribute(TREE_WIND_ATTRIBUTE).getY(0)).toBe(18);
      });
      expect(owned[0].getAttribute(TREE_WIND_ATTRIBUTE).getX(1)).toBe(0);
      expect(owned[2].getAttribute(TREE_WIND_ATTRIBUTE).getX(2)).toBe(19);
      expect(bark.hasAttribute(TREE_WIND_ATTRIBUTE)).toBe(false);
      expect(Array.from(bark.attributes.position.array)).toEqual(before);
      expect(bark.boundingBox.max.y).toBe(900);
      const single = deriveTreeWindDescriptor(
        [bark, leaves],
        bark.attributes.position.getY(0),
      );
      expect(single.rootY).toBe(bark.attributes.position.getY(0));
      expect(single.height).toBe(18 - single.rootY);
    } finally {
      owned.forEach((g) => g.dispose());
      bark.dispose();
      leaves.dispose();
      lod.dispose();
    }
  });

  it("rejects empty, nonfinite and root-above-top input without source mutation", () => {
    const source = geometry([0, 1, 2]);
    try {
      expect(() => deriveTreeWindDescriptor([], 0)).toThrow();
      expect(() => deriveTreeWindDescriptor([source], 2)).toThrow();
      expect(() => deriveTreeWindDescriptor([source], NaN)).toThrow();
      source.attributes.position.setY(1, Infinity);
      expect(() => deriveTreeWindDescriptor([source], 0)).toThrow();
      expect(source.hasAttribute(TREE_WIND_ATTRIBUTE)).toBe(false);
    } finally {
      source.dispose();
    }
  });

  it("preserves indexed box faces, groups, UVs and borrowed disposal ownership", () => {
    const source = new THREE.BoxGeometry(2, 12, 2);
    source.translate(0, 6, 0);
    const descriptor = deriveTreeWindDescriptor([source], 0);
    let sourceDisposals = 0;
    source.addEventListener("dispose", () => {
      sourceDisposals++;
    });
    const owned = cloneGeometryWithTreeWind(source, descriptor);
    try {
      expect(owned.index?.array).toEqual(source.index?.array);
      expect(owned.index).not.toBe(source.index);
      expect(owned.groups).toEqual(source.groups);
      for (const name of ["position", "normal", "uv"]) {
        expect(owned.getAttribute(name).array).toEqual(
          source.getAttribute(name).array,
        );
        expect(owned.getAttribute(name).array).not.toBe(
          source.getAttribute(name).array,
        );
      }
      expect(() => cloneGeometryWithTreeWind(owned, descriptor)).toThrow(
        "already",
      );
    } finally {
      owned.dispose();
    }
    expect(sourceDisposals).toBe(0);
    source.dispose();
    expect(sourceDisposals).toBe(1);
  });
});

describe("connected tree wind equations and actual TSL", () => {
  it("agrees with actual TSL across roots, top clamp, strength, scales and directions", () => {
    const source = geometry([0, 1, 2]);
    const material = new THREE.MeshStandardNodeMaterial();
    const mesh = new THREE.Mesh(source, material);
    try {
      withStack(mesh, () => {
        for (const height of [-1, 0, 0.0001, 2, 6, 12, 18]) {
          for (const scale of [0.1, 0.8, 1, 3]) {
            for (const strength of [-1, 0, 1, 2, 20]) {
              const input = {
                ...numeric,
                heightAboveRoot: height,
                scale,
                strength,
              };
              const actual = createTreeWindBendNodes(
                vec2(height, 12),
                {
                  root: vec3(input.rootX, 100, input.rootZ),
                  scale: float(scale),
                },
                {
                  time: float(input.time),
                  strength: float(strength),
                  direction: vec2(0.6, 0.8),
                },
              );
              const evaluate = evaluator();
              const expected = evaluateTreeWindBend(input);
              evaluate(actual.displacement).forEach((n, i) =>
                expect(n).toBeCloseTo(expected.displacement[i], 12),
              );
              evaluate(actual.derivative).forEach((n, i) =>
                expect(n).toBeCloseTo(expected.derivative[i], 12),
              );
              expect(Math.hypot(...expected.displacement)).toBeLessThanOrEqual(
                TREE_WIND_MAX_DISPLACEMENT,
              );
              if (height <= 0 || strength <= 0)
                expect(expected.displacement.map(Math.abs)).toEqual([0, 0]);
            }
          }
        }
        for (const direction of [
          [0, 0],
          [10, -20],
        ]) {
          const input = {
            ...numeric,
            directionX: direction[0],
            directionZ: direction[1],
          };
          const actual = createTreeWindBendNodes(
            vec2(6, 12),
            { root: vec3(449, 0, 410), scale: float(1) },
            {
              time: float(input.time),
              strength: float(input.strength),
              direction: vec2(direction[0], direction[1]),
            },
          );
          const expected = evaluateTreeWindBend(input);
          evaluator()(actual.displacement).forEach((n, i) =>
            expect(n).toBeCloseTo(expected.displacement[i], 12),
          );
        }
      });
    } finally {
      source.dispose();
      material.dispose();
    }
  });

  it("has the analytic world-height derivative, scale-aware amplitude and finite invalid-input guards", () => {
    expect(
      Math.hypot(...evaluateTreeWindBend(numeric).displacement),
    ).toBeGreaterThan(0.001);
    for (const scale of [0.1, 0.8, 1, 3]) {
      const input = { ...numeric, scale };
      const result = evaluateTreeWindBend(input);
      const eps = 0.00001;
      const plus = evaluateTreeWindBend({
        ...input,
        heightAboveRoot: input.heightAboveRoot + eps / scale,
      });
      const minus = evaluateTreeWindBend({
        ...input,
        heightAboveRoot: input.heightAboveRoot - eps / scale,
      });
      result.derivative.forEach((n, i) =>
        expect(n).toBeCloseTo(
          (plus.displacement[i] - minus.displacement[i]) / (2 * eps),
          9,
        ),
      );
    }
    expect(
      evaluateTreeWindBend({ ...numeric, scale: 0.1 }).displacement[0],
    ).toBeCloseTo(evaluateTreeWindBend(numeric).displacement[0] * 0.12, 12);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => evaluateTreeWindBend({ ...numeric, time: value })).toThrow();
    }
    expect(() => evaluateTreeWindBend({ ...numeric, fullHeight: 0 })).toThrow();
    expect(() => evaluateTreeWindBend({ ...numeric, scale: 0 })).toThrow();
  });

  it("admits yaw/uniform transforms and rejects tilt, shear, nonuniform and mirrored matrices", () => {
    const good = new THREE.Matrix4().compose(
      new THREE.Vector3(400, 28, 410),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.7),
      new THREE.Vector3(0.8, 0.8, 0.8),
    );
    expect(() => assertTreeWindInstanceMatrix(good)).not.toThrow();
    for (const matrix of [
      new THREE.Matrix4().makeRotationX(0.1),
      new THREE.Matrix4().makeScale(1, 2, 1),
      new THREE.Matrix4().makeScale(-1, 1, 1),
      new THREE.Matrix4().makeScale(0, 0, 0),
    ])
      expect(() => assertTreeWindInstanceMatrix(matrix)).toThrow();
    const bad = good.clone();
    bad.elements[8] += 0.1;
    expect(() => assertTreeWindInstanceMatrix(bad)).toThrow();
  });
});

describe("native instance-frame and position-node ownership", () => {
  const frames = [
    { yaw: 0.6, scale: 0.8 },
    { yaw: -1.2, scale: 3 },
    { yaw: 1.7, scale: 0.1 },
  ];
  const bases = [
    { basis: "horizontal", normal: [1, 0, 0], tangent: [0, 0, 1] },
    { basis: "oblique", normal: [1, -1, 1], tangent: [1, 2, 1] },
  ];
  const cases = ["batch", "storage"].flatMap((kind) =>
    frames.flatMap((frame) =>
      bases.flatMap((basis) =>
        [0, 1.2].map((strength) => ({ kind, ...frame, ...basis, strength })),
      ),
    ),
  );
  it.each(cases)(
    "$kind yaw=$yaw scale=$scale $basis strength=$strength uses authored tangent matrix then J, without modifying shared data",
    ({
      kind,
      yaw,
      scale,
      normal: authoredNormal,
      tangent: authoredTangent,
      strength,
    }) => {
      const source = geometry([0, 6, 12]);
      const normalInput = new THREE.Vector3()
        .fromArray(authoredNormal)
        .normalize();
      const tangentInput = new THREE.Vector3()
        .fromArray(authoredTangent)
        .normalize();
      for (let vertex = 0; vertex < 3; vertex++) {
        source.attributes.normal.setXYZ(
          vertex,
          normalInput.x,
          normalInput.y,
          normalInput.z,
        );
        source.attributes.tangent.setXYZ(
          vertex,
          tangentInput.x,
          tangentInput.y,
          tangentInput.z,
        );
      }
      // Use the actual Float32 attribute values, not their pre-storage doubles.
      normalInput.fromBufferAttribute(source.attributes.normal, 1);
      tangentInput.fromBufferAttribute(source.attributes.tangent, 1);
      const owned = cloneGeometryWithTreeWind(
        source,
        deriveTreeWindDescriptor([source], 0),
      );
      const material = new THREE.MeshStandardNodeMaterial();
      const mesh =
        kind === "batch"
          ? new THREE.BatchedMesh(8, 3, 0, material)
          : createStorageInstancedMesh(owned, material, 8);
      let id = 3;
      if (mesh instanceof THREE.BatchedMesh) {
        const geoId = mesh.addGeometry(owned);
        mesh.addInstance(geoId);
        mesh.addInstance(geoId);
        mesh.addInstance(geoId);
        id = mesh.addInstance(geoId);
        mesh.deleteInstance(1); // indirect ID is NOT a compact draw index
      }
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(449, 28, 410),
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          yaw,
        ),
        new THREE.Vector3(scale, scale, scale),
      );
      mesh.setMatrixAt(id, matrix);
      assertTreeWindInstanceMatrix(matrix);
      const before = new THREE.Matrix4();
      mesh.getMatrixAt(id, before);
      try {
        withStack(mesh, (builder) => {
          const frame = createTreeWindFrameNodes(mesh);
          const values = new Map<Node, number[]>([
            [batchIndirectIndex, [id]],
            [instanceIndex, [id]],
          ]);
          const evaluate = evaluator(values, builder);
          expect(evaluate(frame.root)).toEqual([449, 28, 410]);
          expect(evaluate(frame.scale)[0]).toBeCloseTo(scale, 6);
          const root = createTreeWindPositionNode({
            time: float(numeric.time),
            strength: float(strength),
            direction: vec2(0.6, 0.8),
          });
          let call: Node = root;
          while (Reflect.get(call, "isVarNode"))
            call = actualNode(Reflect.get(call, "node"));
          const shader: unknown = Reflect.get(call, "shaderNode");
          if (!(shader instanceof THREE.Node))
            throw new Error("Missing actual shader Fn");
          const callback: unknown = Reflect.get(shader, "jsFunc");
          if (typeof callback !== "function")
            throw new Error("Missing shader callback");
          const stackStart = stackNodes(builder).length;
          const output: unknown = callback(builder);
          const normal = normalInput
            .clone()
            .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(before));
          const tangent = tangentInput.clone().transformDirection(before);
          const position = new THREE.Vector3(0.2, 6, -0.1).applyMatrix4(before);
          values.set(normalLocal, normal.toArray());
          values.set(tangentGeometry, [...tangentInput.toArray(), -1]);
          // Actual r186 prior states differ: storage leaves authored tangents;
          // batching multiplies row-vector * matrix, applying inverse yaw.
          const nativeTangent =
            kind === "batch"
              ? tangentInput
                  .clone()
                  .applyMatrix3(
                    new THREE.Matrix3().setFromMatrix4(before).transpose(),
                  )
                  .normalize()
              : tangentInput.clone();
          values.set(tangentLocal, nativeTangent.toArray());
          expect(nativeTangent.distanceTo(tangent)).toBeGreaterThan(0.1);
          values.set(positionLocal, position.toArray());
          // The actual metadata attribute is supplied per vertex; it is not a
          // replacement matrix, renderer, or alternate deformation implementation.
          const graph = new Set<Node>();
          const visit = (node: Node) => {
            if (graph.has(node)) return;
            graph.add(node);
            for (const child of node.getChildren()) visit(child);
          };
          const statements = stackNodes(builder).slice(stackStart);
          statements.forEach(visit);
          visit(actualNode(output));
          for (const node of graph) {
            if (Reflect.get(node, "_attributeName") === TREE_WIND_ATTRIBUTE)
              values.set(node, [6, 12]);
          }
          statements.forEach(evaluate);
          const actual = evaluate(actualNode(output));
          const expected = evaluateTreeWindBend({
            ...numeric,
            strength,
            scale: evaluate(frame.scale)[0],
          });
          expect(actual[0]).toBeCloseTo(
            position.x + expected.displacement[0],
            10,
          );
          expect(actual[1]).toBe(position.y);
          expect(actual[2]).toBeCloseTo(
            position.z + expected.displacement[1],
            10,
          );
          const expectedNormal = new THREE.Vector3(
            normal.x,
            normal.y -
              expected.derivative[0] * normal.x -
              expected.derivative[1] * normal.z,
            normal.z,
          ).normalize();
          evaluate(normalLocal).forEach((n, i) =>
            expect(n).toBeCloseTo(expectedNormal.toArray()[i], 10),
          );
          const transformedTangent = new THREE.Vector3(
            tangent.x + expected.derivative[0] * tangent.y,
            tangent.y,
            tangent.z + expected.derivative[1] * tangent.y,
          ).normalize();
          evaluate(tangentLocal).forEach((n, i) =>
            expect(n).toBeCloseTo(transformedTangent.toArray()[i], 10),
          );
          expect(expectedNormal.dot(transformedTangent)).toBeCloseTo(0, 12);
          expect(
            [...graph].filter((node) => Reflect.get(node, "isTextureNode"))
              .length,
          ).toBe(kind === "batch" ? 3 : 0);
          const buffers = [...graph].filter((node) =>
            Reflect.get(node, "isStorageBufferNode"),
          );
          expect(buffers).toHaveLength(kind === "storage" ? 1 : 0);
          if (mesh instanceof THREE.InstancedMesh)
            expect(Reflect.get(buffers[0], "value")).toBe(mesh.instanceMatrix);
          expect(
            [...graph].some(
              (node) => Reflect.get(node, "_attributeName") === "color",
            ),
          ).toBe(false);
        });
        const after = new THREE.Matrix4();
        mesh.getMatrixAt(id, after);
        expect(after.elements).toEqual(before.elements);
        expect(source.hasAttribute(TREE_WIND_ATTRIBUTE)).toBe(false);
        expect(owned.attributes.tangent.getW(0)).toBe(-1);
      } finally {
        mesh.dispose();
        owned.dispose();
        source.dispose();
        material.dispose();
      }
    },
  );

  it("generates actual r186 WGSL storage position/normal/tangent flow", () => {
    const source = geometry([0, 6, 12]);
    const owned = cloneGeometryWithTreeWind(
      source,
      deriveTreeWindDescriptor([source], 0),
    );
    const material = new THREE.MeshStandardNodeMaterial();
    const mesh = createStorageInstancedMesh(owned, material, 8);
    const dom = new JSDOM("<canvas></canvas>");
    const canvas = dom.window.document.querySelector("canvas");
    if (!canvas) throw new Error("Missing actual HTMLCanvasElement");
    // Actual uninitialized renderer; no adapter/device/context/init/render call.
    // JSDOM supplies only the constructor's DOM owner, not GPU capabilities.
    const renderer = new THREE.WebGPURenderer({ canvas });
    try {
      const candidate = new WGSLNodeBuilder(mesh, renderer);
      Reflect.set(
        candidate,
        "camera",
        new THREE.PerspectiveCamera(50, 1, 0.1, 1000),
      );
      Reflect.set(candidate, "shaderStage", "vertex");
      const node = createTreeWindPositionNode({
        time: float(7.3),
        strength: float(1.2),
        direction: vec2(0.6, 0.8),
      });
      const generate: unknown = Reflect.get(candidate, "flowStagesNode");
      if (typeof generate !== "function")
        throw new Error("Missing actual WGSL flow method");
      const flow: unknown = generate.call(candidate, node, "vec3");
      if (
        !flow ||
        typeof flow !== "object" ||
        !("code" in flow) ||
        !("result" in flow) ||
        typeof flow.code !== "string" ||
        typeof flow.result !== "string"
      ) {
        throw new Error("Invalid actual WGSL flow result");
      }
      expect(flow.result).toMatch(/positionLocal|nodeVar/);
      expect(flow.code).toContain("normalLocal = normalize(");
      expect(flow.code).toContain("tangentLocal = normalize(");
      expect(flow.code).toContain("sin(");
      expect(flow.code).toContain("clamp(");
      expect(flow.code).toContain("NodeBuffer_");
      expect(flow.code).toContain("instanceIndex");
      expect(flow.code).toContain("0.018");
      expect(flow.code).not.toMatch(/undefined|NaN|Infinity/);
    } finally {
      renderer.dispose();
      dom.window.close();
      mesh.dispose();
      owned.dispose();
      source.dispose();
      material.dispose();
    }
  });

  it("resolves separate batch objects and rejects nonidentity pools/unsupported meshes", () => {
    const source = geometry([0, 1, 2]);
    const material = new THREE.MeshStandardNodeMaterial();
    const a = new THREE.BatchedMesh(2, 3, 0, material);
    const b = new THREE.BatchedMesh(2, 3, 0, material);
    a.addInstance(a.addGeometry(source));
    b.addInstance(b.addGeometry(source));
    a.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 2, 3));
    b.setMatrixAt(0, new THREE.Matrix4().makeTranslation(4, 5, 6));
    try {
      withStack(a, (builder) => {
        const evaluate = evaluator(
          new Map([[batchIndirectIndex, [0]]]),
          builder,
        );
        expect(evaluate(createTreeWindFrameNodes(a).root)).toEqual([1, 2, 3]);
        expect(evaluate(createTreeWindFrameNodes(b).root)).toEqual([4, 5, 6]);
        b.matrixWorld.makeTranslation(1, 0, 0);
        expect(() => createTreeWindFrameNodes(b)).toThrow("identity");
        expect(() =>
          createTreeWindFrameNodes(new THREE.Mesh(source, material)),
        ).toThrow();
        const ordinary = new THREE.InstancedMesh(source, material, 2);
        try {
          expect(() => createTreeWindFrameNodes(ordinary)).toThrow("storage");
        } finally {
          ordinary.dispose();
        }
      });
    } finally {
      a.dispose();
      b.dispose();
      source.dispose();
      material.dispose();
    }
  });
});
