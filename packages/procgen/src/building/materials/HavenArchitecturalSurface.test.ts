import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { float, mat4, negateOnBackSide, vec2, vec3 } from "three/tsl";
import { createBuildingMaterial } from "./BuildingMaterialTSL";
import {
  createHavenReliefProfile,
  createHavenSurfaceResponse,
  havenReliefWorldNormal,
  havenReliefViewNormal,
  HAVEN_ARCHITECTURAL_ROOF_CONFIG,
  createHavenLocalMetricUV,
  type HavenSurfaceType,
} from "./HavenArchitecturalSurface";

const types: HavenSurfaceType[] = [
  "wood-plank",
  "shingle",
  "stone-ashlar",
  "plaster",
];
const fraction = (x: number) => x - Math.floor(x);
const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

// Independent scalar height definition; analytic gradients are never imported.
function referenceHeight(type: HavenSurfaceType, x: number, y: number) {
  if (type === "plaster")
    return Math.sin(2 * Math.PI * x) * Math.sin(2 * Math.PI * y) * 0.00025;
  if (type === "wood-plank") {
    const v = fraction(y / 0.15);
    return (smooth(v / 0.045) * smooth((1 - v) / 0.045) - 1) * 0.0007;
  }
  const shingle = type === "shingle",
    width = shingle ? 0.2 : 0.6,
    height = shingle ? 0.105 : 0.3;
  const row = Math.floor(y / height),
    u = fraction(x / width + fraction(row / 2)),
    v = fraction(y / height);
  const edge = shingle ? 0.04 : 0.06,
    gap = shingle ? 0.05 + 0.1 * Math.sin(Math.PI * u) : 0.05;
  return (
    (shingle ? 0.004 : 0.0025) *
    smooth(u / edge) *
    smooth((1 - u) / edge) *
    smooth((v - gap) / (shingle ? 0.08 : 0.06)) *
    smooth((1 - v) / (shingle ? 0.05 : 0.06))
  );
}

// Evaluate actual installed Three expression nodes. Unsupported operations fail;
// this is neither a GPU simulation nor a mocked renderer/graph.
function evaluate(root: THREE.Node): number[] {
  const memo = new Map<THREE.Node, number[]>();
  const visit = (n: THREE.Node): number[] => {
    if (memo.has(n)) return memo.get(n)!;
    const read = (key: string) => Reflect.get(n, key) as unknown;
    const child = (key: string) => visit(read(key) as THREE.Node);
    const combine = (keys: string[], fn: (...args: number[]) => number) => {
      const arrays = keys.map(child);
      return Array.from(
        { length: Math.max(...arrays.map((a) => a.length)) },
        (_, i) => fn(...arrays.map((a) => a[a.length === 1 ? 0 : i])),
      );
    };
    const compute = (): number[] => {
      const value = read("value");
      if (typeof value === "number") return [value];
      if (
        value instanceof THREE.Vector2 ||
        value instanceof THREE.Vector3 ||
        value instanceof THREE.Vector4 ||
        value instanceof THREE.Matrix4
      )
        return value.toArray();
      if (n.type === "VarNode" || n.type === "ConvertNode")
        return child("node");
      if (n.type === "StackNode") return child("outputNode");
      if (n.type === "ConditionalNode")
        return child("condNode")[0] ? child("ifNode") : child("elseNode");
      if (n.type === "JoinNode")
        return (read("nodes") as THREE.Node[]).flatMap(visit);
      if (n.type === "SplitNode")
        return [...String(read("components"))].map(
          (c) => child("node")["xyzw".indexOf(c)],
        );
      switch (read("op")) {
        case "+":
          return combine(["aNode", "bNode"], (a, b) => a + b);
        case "-":
          return combine(["aNode", "bNode"], (a, b) => a - b);
        case "/":
          return combine(["aNode", "bNode"], (a, b) => a / b);
        case "%":
          return combine(
            ["aNode", "bNode"],
            (a, b) => a - b * Math.floor(a / b),
          );
        case ">":
          return combine(["aNode", "bNode"], (a, b) => +(a > b));
        case "&&":
          return combine(
            ["aNode", "bNode"],
            (a, b) => +(Boolean(a) && Boolean(b)),
          );
        case "*": {
          const a = child("aNode"),
            b = child("bNode");
          if (a.length === 16 && b.length === 4)
            return new THREE.Vector4(...b)
              .applyMatrix4(new THREE.Matrix4().fromArray(a))
              .toArray();
          return combine(["aNode", "bNode"], (a, b) => a * b);
        }
      }
      switch (read("method")) {
        case "sin":
          return child("aNode").map(Math.sin);
        case "cos":
          return child("aNode").map(Math.cos);
        case "abs":
          return child("aNode").map(Math.abs);
        case "sign":
          return child("aNode").map(Math.sign);
        case "floor":
          return child("aNode").map(Math.floor);
        case "fract":
          return child("aNode").map(fraction);
        case "mod":
          return combine(
            ["aNode", "bNode"],
            (a, b) => a - b * Math.floor(a / b),
          );
        case "max":
          return combine(["aNode", "bNode"], Math.max);
        case "clamp":
          return combine(["aNode", "bNode", "cNode"], (x, a, b) =>
            Math.max(a, Math.min(b, x)),
          );
        case "smoothstep":
          return combine(["aNode", "bNode", "cNode"], (a, b, x) =>
            smooth((x - a) / (b - a)),
          );
        case "dot":
          return [
            child("aNode").reduce((s, a, i) => s + a * child("bNode")[i], 0),
          ];
        case "cross":
          return new THREE.Vector3(...child("aNode"))
            .cross(new THREE.Vector3(...child("bNode")))
            .toArray();
        case "normalize": {
          const a = child("aNode"),
            length = Math.hypot(...a);
          return a.map((v) => v / length);
        }
      }
      throw new Error(
        `Unsupported real node ${n.type}/${String(read("op"))}/${String(read("method"))}`,
      );
    };
    const result = compute();
    memo.set(n, result);
    return result;
  };
  return visit(root);
}

function graph(root: THREE.Node, builder?: THREE.NodeBuilder) {
  const nodes = new Set<THREE.Node>();
  const visit = (node: THREE.Node) => {
    if (nodes.has(node)) return;
    nodes.add(node);
    if (builder && Reflect.get(node, "isShaderCallNodeInternal"))
      visit(
        Reflect.apply(Reflect.get(node, "getOutputNode"), node, [
          builder,
        ]) as THREE.Node,
      );
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return [...nodes];
}
function close(actual: number[], expected: number[], tolerance = 1e-9) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((n, i) => {
    expect(Number.isFinite(n)).toBe(true);
    expect(Math.abs(n - expected[i])).toBeLessThanOrEqual(tolerance);
  });
}

describe("Haven actual procedural response (CPU arithmetic, not rendered acceptance)", () => {
  it("uses actual local-meter dominant-plane UVs across signed faces, preserving explicit object-scale semantics", () => {
    const point = new THREE.Vector3(2, 3, 5);
    for (const [normal, expected] of [
      [
        [0, 1, 0],
        [2, 5],
      ],
      [
        [0, -1, 0],
        [2, 5],
      ],
      [
        [1, 0, 0],
        [5, 3],
      ],
      [
        [-1, 0, 0],
        [5, 3],
      ],
      [
        [0, 0, 1],
        [2, 3],
      ],
      [
        [0, 0, -1],
        [2, 3],
      ],
    ])
      close(
        evaluate(
          createHavenLocalMetricUV(vec3(...point.toArray()), vec3(...normal)),
        ),
        expected,
      );
    const a = new THREE.Vector3(0, 0, 0),
      b = new THREE.Vector3(0.45, 0, 0);
    const owner = new THREE.Object3D();
    owner.position.set(350, 20, 328);
    owner.rotation.y = Math.PI;
    owner.scale.setScalar(2);
    owner.updateMatrixWorld(true);
    expect(
      a
        .clone()
        .applyMatrix4(owner.matrixWorld)
        .distanceTo(b.clone().applyMatrix4(owner.matrixWorld)),
    ).toBeCloseTo(0.9);
    close(
      evaluate(
        createHavenLocalMetricUV(vec3(...b.toArray()), vec3(0, 1, 0)).div(0.75),
      ),
      [0.6, 0],
    );
    // Local-meter pattern must not pretend scaled owners remain world-meter.
    expect(0.6 * 0.75).toBeCloseTo(0.45);
    expect(0.3 * 0.75).toBeCloseTo(0.225);
    expect(() =>
      createBuildingMaterial({ type: "stone-ashlar", patternUV: vec2(0) }),
    ).toThrow(/explicit Haven/);
    expect(() =>
      createBuildingMaterial({
        type: "stone-ashlar",
        architecturalFinish: "haven-v1",
        patternUV: {} as THREE.Node<"vec2">,
      }),
    ).toThrow(/actual node/);
  });
  it("routes one actual explicit pattern UV into both the expanded color and shared response graphs", () => {
    const pattern = createHavenLocalMetricUV(
      vec3(0.031, 0.23, 0.37),
      vec3(0, 1, 0),
    );
    const material = createBuildingMaterial({
      type: "stone-ashlar",
      architecturalFinish: "haven-v1",
      patternUV: pattern,
      scale: 0.75,
      useVertexColors: false,
    });
    const geometry = new THREE.BoxGeometry(),
      mesh = new THREE.Mesh(geometry, material);
    const builder = Reflect.construct(THREE.NodeBuilder, [
      mesh,
      null,
      null,
    ]) as THREE.NodeBuilder;
    try {
      const color = graph(material.colorNode!, builder),
        response = graph(material.roughnessNode!, builder);
      expect(color).toContain(pattern);
      expect(response).toContain(pattern);
      expect(
        response.some((n) =>
          ["TextureNode", "PassNode", "LoopNode", "BumpMapNode"].includes(
            n.type,
          ),
        ),
      ).toBe(false);
      expect(response.length).toBeLessThan(300);
    } finally {
      geometry.dispose();
      material.dispose();
    }
  });
  it("matches independent heights and finite-difference slopes for all four admitted surfaces", () => {
    for (const type of types)
      for (let i = 0; i < 180; i++) {
        const x = -0.49 + i * 0.007193,
          y = -0.37 + i * 0.005971;
        const p = createHavenReliefProfile(type, vec2(x, y)),
          e = 1e-7;
        close(evaluate(p.height), [referenceHeight(type, x, y)], 1e-12);
        close(
          evaluate(p.gradient),
          [
            (referenceHeight(type, x + e, y) -
              referenceHeight(type, x - e, y)) /
              (2 * e),
            (referenceHeight(type, x, y + e) -
              referenceHeight(type, x, y - e)) /
              (2 * e),
          ],
          3e-6,
        );
      }
  });
  it("closes periodic/staggered seams with continuous heights and gradients, including negative rows", () => {
    for (const type of types) {
      const sx = type === "shingle" ? 0.2 : type === "stone-ashlar" ? 0.6 : 1;
      const sy =
        type === "shingle"
          ? 0.105
          : type === "stone-ashlar"
            ? 0.3
            : type === "wood-plank"
              ? 0.15
              : 1;
      for (const axis of [0, 1])
        for (const row of [-3, -1, 0, 2])
          for (const along of [0.021, 0.093, 0.183]) {
            const point = [along, along];
            point[axis] = row * (axis === 0 ? sx : sy);
            const values = [-1, 1].map((sign) => {
              const p = [...point];
              p[axis] += sign * 1e-9;
              return createHavenReliefProfile(type, vec2(...p));
            });
            close(evaluate(values[0].height), evaluate(values[1].height), 1e-8);
            close(
              evaluate(values[0].gradient),
              evaluate(values[1].gradient),
              1e-6,
            );
          }
    }
  });
  it("bounds roughness/occlusion and smoothly removes subpixel relief without adding texture sampling", () => {
    for (const type of types)
      for (const [x, y] of [
        [0, 0],
        [-0.071, 0.021],
        [0.19, 0.13],
        [0.031, 0.011],
      ]) {
        const near = createHavenSurfaceResponse(
          type,
          vec2(x, y),
          vec2(0.00001),
          float(0.82),
        );
        const far = createHavenSurfaceResponse(
          type,
          vec2(x, y),
          vec2(1),
          float(0.82),
        );
        const r = evaluate(near.roughness)[0],
          ao = evaluate(near.ao)[0];
        expect(r).toBeGreaterThanOrEqual(0.82);
        expect(r).toBeLessThanOrEqual(0.89);
        expect(ao).toBeGreaterThanOrEqual(0.9);
        expect(ao).toBeLessThanOrEqual(1);
        close(evaluate(far.gradient), [0, 0]);
        close(evaluate(far.roughness), [0.82]);
        close(evaluate(far.ao), [1]);
        const nodes = graph(near.roughness);
        expect(
          nodes.some((n) =>
            ["TextureNode", "PassNode", "LoopNode", "BumpMapNode"].includes(
              n.type,
            ),
          ),
        ).toBe(false);
      }
  });
  it("matches displaced-tangent normals on real rotated/scaled/mirrored frames and actual camera view matrices", () => {
    for (const type of types)
      for (const mirrored of [-1, 1])
        for (const angle of [0, 0.7, 2.3]) {
          const u = 0.061,
            v = 0.014,
            e = 1e-7;
          const gradient = createHavenReliefProfile(type, vec2(u, v)).gradient;
          const q = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(angle, angle / 2, -angle / 3),
          );
          const U = new THREE.Vector3(1.7, 0, 0).applyQuaternion(q),
            V = new THREE.Vector3(0.4, 2.3, 0).applyQuaternion(q);
          const N = U.clone().cross(V).normalize();
          const dhdu =
              (referenceHeight(type, u + e, v) -
                referenceHeight(type, u - e, v)) /
              (2 * e),
            dhdv =
              (referenceHeight(type, u, v + e) -
                referenceHeight(type, u, v - e)) /
              (2 * e);
          const expected = U.clone()
            .addScaledVector(N, dhdu)
            .cross(V.clone().addScaledVector(N, dhdv))
            .normalize();
          // Arbitrary screen basis, reflected in X in half the cases.
          const dx = U.clone()
              .multiplyScalar(0.014 * mirrored)
              .addScaledVector(V, 0.003),
            dy = U.clone().multiplyScalar(0.002).addScaledVector(V, 0.017);
          const actual = havenReliefWorldNormal(
            gradient,
            vec2(0.014 * mirrored, 0.003),
            vec2(0.002, 0.017),
            vec3(...dx.toArray()),
            vec3(...dy.toArray()),
            vec3(...N.toArray()),
          );
          close(evaluate(actual), expected.toArray(), 2e-7);
          const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
          camera.position.set(3, 7, 11);
          camera.lookAt(0, 0, 0);
          camera.updateMatrixWorld(true);
          close(
            evaluate(
              havenReliefViewNormal(actual, mat4(camera.matrixWorldInverse)),
            ),
            expected
              .clone()
              .transformDirection(camera.matrixWorldInverse)
              .toArray(),
            2e-7,
          );
          close(
            evaluate(
              havenReliefWorldNormal(
                vec2(0),
                vec2(0),
                vec2(0),
                vec3(...dx.toArray()),
                vec3(...dy.toArray()),
                vec3(...N.toArray()),
              ),
            ),
            N.toArray(),
          );
        }
  });
  it("handles collapsed screen/UV support finitely and leaves neutral normals untouched", () => {
    for (const dx of [vec3(0), vec3(1, 0, 0)]) {
      close(
        evaluate(
          havenReliefWorldNormal(
            vec2(3, -2),
            vec2(0),
            vec2(0),
            dx,
            vec3(0),
            vec3(0, 0, 1),
          ),
        ),
        [0, 0, 1],
      );
    }
  });
  it("uses r186 completed-normal backface policy on real material owners", () => {
    for (const [side, sign] of [
      [THREE.FrontSide, 1],
      [THREE.BackSide, -1],
    ] as const) {
      const material = new THREE.MeshStandardNodeMaterial({ side }),
        geometry = new THREE.BoxGeometry(),
        mesh = new THREE.Mesh(geometry, material);
      const builder = Reflect.construct(THREE.NodeBuilder, [
        mesh,
        null,
        null,
      ]) as THREE.NodeBuilder;
      try {
        const call = graph(negateOnBackSide(vec3(0.2, 0.3, 0.4))).find((n) =>
          Reflect.get(n, "isShaderCallNodeInternal"),
        )!;
        const output = Reflect.apply(Reflect.get(call, "getOutputNode"), call, [
          builder,
        ]) as THREE.Node;
        close(evaluate(output), [0.2 * sign, 0.3 * sign, 0.4 * sign]);
      } finally {
        geometry.dispose();
        material.dispose();
      }
    }
  });
  it("keeps legacy omission and strict admission, owns no maps/passes, and shares each response across channels", () => {
    for (const type of types) {
      const old = createBuildingMaterial({ type, useVertexColors: false });
      const material = createBuildingMaterial({
        type,
        useVertexColors: false,
        architecturalFinish: "haven-v1",
      });
      try {
        expect(old.normalNode).toBeNull();
        expect(old.roughnessNode).toBeNull();
        expect(old.aoNode).toBeNull();
        const receipt = Object.getOwnPropertyDescriptor(
          material.userData,
          "havenArchitecturalFinish",
        )!;
        expect(receipt.writable).toBe(false);
        expect(receipt.configurable).toBe(false);
        expect(Object.isFrozen(receipt.value)).toBe(true);
        expect(receipt.value).toMatchObject({
          schemaVersion: 1,
          mode: "haven-v1",
          surface: type,
          normalSpace: "view",
          textureSamples: 0,
          displaced: false,
        });
        for (const key of [
          "map",
          "normalMap",
          "roughnessMap",
          "aoMap",
          "positionNode",
          "maskNode",
          "maskShadowNode",
        ] as const)
          expect(material[key]).toBe(old[key]);
        expect(material.transparent).toBe(false);
        expect(material.side).toBe(THREE.FrontSide);
        const roots = [
          material.normalNode!,
          material.roughnessNode!,
          material.aoNode!,
        ];
        const graphs = roots.map((root) => graph(root)),
          shared = graphs[0].filter(
            (n) =>
              n.type === "VarNode" &&
              String(Reflect.get(n, "name")).startsWith(
                "havenArchitecturalResponse_",
              ),
          );
        expect(shared).toHaveLength(1);
        for (const nodes of graphs) expect(nodes).toContain(shared[0]);
        expect(Reflect.get(shared[0], "name")).toBe(
          `havenArchitecturalResponse_${type.replaceAll("-", "_")}`,
        );
      } finally {
        old.dispose();
        material.dispose();
      }
    }
    expect(() =>
      createBuildingMaterial({
        type: "brick",
        architecturalFinish: "haven-v1",
      }),
    ).toThrow(/supported architectural/);
    expect(() =>
      createBuildingMaterial({
        type: "shingle",
        architecturalFinish: "invalid" as "haven-v1",
      }),
    ).toThrow(/supported architectural/);
    const roof = createBuildingMaterial({
      type: "shingle",
      architecturalFinish: "haven-v1",
      ...HAVEN_ARCHITECTURAL_ROOF_CONFIG,
    });
    try {
      expect(Object.isFrozen(HAVEN_ARCHITECTURAL_ROOF_CONFIG)).toBe(true);
      expect(roof.buildingUniforms.textureScale.value).toBe(0.35);
      expect((0.2 * 0.35) / 0.3).toBeCloseTo(0.233333333333);
      expect((0.105 * 0.35) / 0.3).toBeCloseTo(0.1225);
    } finally {
      roof.dispose();
    }
  });
});
