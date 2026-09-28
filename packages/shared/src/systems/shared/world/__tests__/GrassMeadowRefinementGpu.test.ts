import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { float, sin, vec3, vertexIndex } from "three/tsl";
import { StorageBufferAttribute, WGSLNodeBuilder } from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import THREE from "../../../../extras/three/three";
import {
  createClumpGeometry,
  createMeadowDetailClumpGeometry,
  createMeadowAuthoredClumpGeometry,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
} from "../GrassVisualManager";
import type { GrassMeadowAuthoredBlade } from "../GrassMeadowAuthoredShape";
import { createMeadowFootprintArchBuffers } from "../GrassMeadowFootprintArch";
import { createMeadowSweptBladeBuffers } from "../GrassMeadowSweptBlade";
import { GRASS_MEADOW_REFINEMENT } from "../GrassBladeLayout";
import {
  createGrassMeadowRefinementResponse,
  createGrassMeadowAuthoredResponse,
  createGrassMeadowFootprintArchResponse,
  createGrassMeadowSweptBladeResponse,
  createGrassMeadowRestHeightColorCoordinate,
  GRASS_MEADOW_COARSE_POSITION_T_ATTRIBUTE,
  GRASS_MEADOW_COARSE_NORMAL_U_ATTRIBUTE,
  GRASS_MEADOW_PARENT_PAIRS_ATTRIBUTE,
  type GrassMeadowRefinementSample,
  type GrassMeadowFootprintArchSample,
} from "../GrassMeadowRefinementGpu";

const NAMES = [
  GRASS_MEADOW_COARSE_POSITION_T_ATTRIBUTE,
  GRASS_MEADOW_COARSE_NORMAL_U_ATTRIBUTE,
  GRASS_MEADOW_PARENT_PAIRS_ATTRIBUTE,
];
function fixture(
  action: (r: ReturnType<typeof createMeadowDetailClumpGeometry>) => void,
) {
  const r = createMeadowDetailClumpGeometry();
  try {
    action(r);
  } finally {
    r.geometry.dispose();
    r.coarseGeometry.dispose();
  }
}
function actual(value: unknown): Node {
  if (!(value instanceof THREE.Node))
    throw new Error("Expected actual TSL node");
  return value;
}
function nodes(roots: readonly Node[]) {
  const found = new Set<Node>();
  const visit = (n: Node) => {
    if (found.has(n)) return;
    found.add(n);
    for (const child of n.getChildren()) visit(child);
  };
  roots.forEach(visit);
  return [...found];
}

/** Evaluates the actual small arithmetic/storage graph, rejecting unknown nodes.
 * This is a CPU graph oracle, not a renderer/device mock or GPU qualification. */
function evaluateGraph(
  root: Node,
  geometry: THREE.BufferGeometry,
  vertex: number,
  roundToFloat32 = false,
): number[] {
  const cache = new Map<Node, number[]>();
  const visit = (n: Node): number[] => {
    const cached = cache.get(n);
    if (cached) return cached;
    const read = (key: string): unknown => Reflect.get(n, key);
    const child = (key: string) => visit(actual(read(key)));
    const value = read("value");
    let out: number[];
    if (n === vertexIndex) out = [vertex];
    else if (typeof value === "number") out = [value];
    else if (
      read("isStorageBufferNode") &&
      value instanceof StorageBufferAttribute
    )
      out = Array.from(value.array);
    else if (n.type === "AttributeNode") {
      const name = read("_attributeName");
      if (typeof name !== "string") throw new Error("Missing attribute name");
      const a = geometry.getAttribute(name);
      if (!(a instanceof THREE.BufferAttribute))
        throw new Error("Missing actual attribute");
      out = Array.from(
        a.array.slice(vertex * a.itemSize, (vertex + 1) * a.itemSize),
      );
    } else if (n.type === "StorageArrayElementNode") {
      const parent = actual(read("node"));
      const buffer: unknown = Reflect.get(parent, "value");
      if (!(buffer instanceof StorageBufferAttribute))
        throw new Error("Missing storage owner");
      const index = child("indexNode")[0];
      out = visit(parent).slice(
        index * buffer.itemSize,
        (index + 1) * buffer.itemSize,
      );
    } else if (n.type === "SplitNode") {
      const a = child("node");
      out = [...String(read("components"))].map((c) => a["xyzw".indexOf(c)]);
    } else if (n.type === "JoinNode") {
      const children = read("nodes");
      if (!Array.isArray(children)) throw new Error("Missing joined nodes");
      out = children.flatMap((v: unknown) => visit(actual(v)));
    } else if (["ConvertNode", "VarNode"].includes(n.type)) out = child("node");
    else if (n.type === "ConditionalNode")
      out = child("condNode")[0] ? child("ifNode") : child("elseNode");
    else if (read("method") === "normalize") {
      const a = child("aNode");
      const length = Math.hypot(...a);
      if (!(length > 0)) throw new Error("Degenerate graph normalization");
      out = a.map((value) => value / length);
    } else if (read("method") === "sin") {
      out = child("aNode").map(Math.sin);
    } else {
      const a = child("aNode"),
        b = child("bNode");
      const c = read("cNode") instanceof THREE.Node ? child("cNode") : [0];
      out = Array.from(
        { length: Math.max(a.length, b.length, c.length) },
        (_, i) => {
          const x = a[a.length === 1 ? 0 : i],
            y = b[b.length === 1 ? 0 : i],
            z = c[c.length === 1 ? 0 : i];
          if (read("op") === "+") return x + y;
          if (read("op") === "-") return x - y;
          if (read("op") === "*") return x * y;
          if (read("op") === "/") {
            const isUint = (node: Node): boolean =>
              node.type === "VarNode"
                ? isUint(actual(Reflect.get(node, "node")))
                : Reflect.get(node, "nodeType") === "uint";
            const integer = [
              actual(read("aNode")),
              actual(read("bNode")),
            ].every(isUint);
            return integer ? Math.floor(x / y) : x / y;
          }
          if (read("op") === "==") return Number(x === y);
          if (read("method") === "mix") return x * (1 - z) + y * z;
          if (read("method") === "clamp") return Math.max(y, Math.min(z, x));
          throw new Error(
            `Unknown graph node ${n.type}/${String(read("method"))}`,
          );
        },
      );
    }
    if (roundToFloat32) out = out.map(Math.fround);
    if (out.some((v) => !Number.isFinite(v)))
      throw new Error("Nonfinite graph result");
    cache.set(n, out);
    return out;
  };
  return visit(root);
}

function response({ position, normal, t }: GrassMeadowRefinementSample) {
  return {
    position: position.add(vec3(t.mul(t), t.mul(t).mul(t), t.mul(0.3))),
    normal: normal.add(vec3(t.mul(t), t.mul(0.2), 0)),
    width: vec3(t.mul(t), t.mul(t).mul(t), t),
  };
}
function expected(
  geometry: THREE.BufferGeometry,
  vertex: number,
  t = geometry.getAttribute("uv").getY(vertex),
) {
  const p = new THREE.Vector3()
    .fromBufferAttribute(geometry.getAttribute("position"), vertex)
    .toArray();
  const n = new THREE.Vector3()
    .fromBufferAttribute(geometry.getAttribute("normal"), vertex)
    .toArray();
  return {
    position: [p[0] + t * t, p[1] + t * t * t, p[2] + t * 0.3],
    normal: [n[0] + t * t, n[1] + t * 0.2, n[2]],
    width: [t * t, t * t * t, t],
  };
}

describe("geometry-owned meadow refinement response", () => {
  it("packs canonical detached storage and registers ownership, not vertex inputs", () =>
    fixture(({ geometry, coarseGeometry, coarseVertexPairs }) => {
      const before = Object.keys(coarseGeometry.attributes);
      const result = createGrassMeadowRefinementResponse(
        geometry,
        coarseGeometry,
        float(0),
        response,
      );
      const attributes = NAMES.map((name) => geometry.getAttribute(name));
      expect(attributes.every((a) => a instanceof StorageBufferAttribute)).toBe(
        true,
      );
      expect(attributes.map((a) => a.count)).toEqual([147, 147, 315]);
      expect(attributes.reduce((sum, a) => sum + a.array.byteLength, 0)).toBe(
        7224,
      );
      expect(attributes[2].array).toEqual(coarseVertexPairs);
      for (let i = 0; i < 147; i++) {
        const p = coarseGeometry.getAttribute("position"),
          n = coarseGeometry.getAttribute("normal"),
          u = coarseGeometry.getAttribute("uv");
        expect(Array.from(attributes[0].array.slice(i * 4, i * 4 + 4))).toEqual(
          [p.getX(i), p.getY(i), p.getZ(i), u.getY(i)],
        );
        expect(Array.from(attributes[1].array.slice(i * 4, i * 4 + 4))).toEqual(
          [n.getX(i), n.getY(i), n.getZ(i), u.getX(i)],
        );
      }
      const graph = nodes(Object.values(result));
      const buffers = graph.filter((n) =>
        Reflect.get(n, "isStorageBufferNode"),
      );
      expect(buffers).toHaveLength(3);
      expect(buffers.map((n) => Reflect.get(n, "access"))).toEqual([
        "readOnly",
        "readOnly",
        "readOnly",
      ]);
      expect(
        graph.filter((n) =>
          NAMES.includes(String(Reflect.get(n, "_attributeName"))),
        ),
      ).toHaveLength(0);
      expect(Object.keys(coarseGeometry.attributes)).toEqual(before);
      let disposed = 0;
      geometry.addEventListener("dispose", () => {
        disposed++;
      });
      geometry.dispose();
      expect(disposed).toBe(1); // Native buffer retirement still requires a GPU run.
      expect(NAMES.every((name) => !coarseGeometry.hasAttribute(name))).toBe(
        true,
      );
    }));

  it("allocates independent owner copies and rejects rebinding", () =>
    fixture(({ geometry, coarseGeometry }) => {
      const other = geometry.clone();
      try {
        createGrassMeadowRefinementResponse(
          geometry,
          coarseGeometry,
          float(0),
          response,
        );
        createGrassMeadowRefinementResponse(
          other,
          coarseGeometry,
          float(1),
          response,
        );
        for (const name of NAMES) {
          expect(geometry.getAttribute(name)).not.toBe(
            other.getAttribute(name),
          );
          expect(geometry.getAttribute(name).array).not.toBe(
            other.getAttribute(name).array,
          );
          expect(geometry.getAttribute(name).array).toEqual(
            other.getAttribute(name).array,
          );
        }
        const old = geometry.getAttribute(NAMES[0]).getX(0);
        coarseGeometry.getAttribute("position").setX(0, old + 1);
        expect(geometry.getAttribute(NAMES[0]).getX(0)).toBe(old);
        expect(() =>
          createGrassMeadowRefinementResponse(
            geometry,
            coarseGeometry,
            float(0),
            response,
          ),
        ).toThrow(/already bound/);
      } finally {
        other.dispose();
      }
    }));

  it.each([-2, 0, 0.25, 1, 3])(
    "interpolates evaluated parent responses, never normalized, at clamped weight %s",
    (weight) =>
      fixture(({ geometry, coarseGeometry }) => {
        let calls = 0;
        const result = createGrassMeadowRefinementResponse(
          geometry,
          coarseGeometry,
          float(weight),
          (sample) => {
            calls++;
            return response(sample);
          },
        );
        expect(calls).toBe(3);
        let nonlinearDifferences = 0;
        let unnormalized = 0;
        for (let v = 0; v < 315; v++) {
          const base = Math.floor(v / 15) * 7;
          const pair = GRASS_MEADOW_REFINEMENT.parentPairs[v % 15];
          const a = expected(coarseGeometry, base + pair[0]),
            b = expected(coarseGeometry, base + pair[1]),
            fine = expected(geometry, v);
          for (const key of ["position", "normal", "width"] as const) {
            const actual = evaluateGraph(result[key], geometry, v);
            const w = Math.max(0, Math.min(1, weight));
            const want = a[key].map(
              (x, i) => (x + b[key][i]) * 0.5 * (1 - w) + fine[key][i] * w,
            );
            actual.forEach((x, i) => expect(x).toBeCloseTo(want[i], 12));
            if (key === "normal" && Math.abs(Math.hypot(...actual) - 1) > 0.01)
              unnormalized++;
          }
          const ta = coarseGeometry.getAttribute("uv").getY(base + pair[0]);
          const tb = coarseGeometry.getAttribute("uv").getY(base + pair[1]);
          if (
            Math.abs((ta * ta + tb * tb) * 0.5 - ((ta + tb) * 0.5) ** 2) > 1e-5
          )
            nonlinearDifferences++;
        }
        expect(nonlinearDifferences).toBe(168);
        expect(unnormalized).toBeGreaterThan(100);
        expect(
          nodes(Object.values(result)).some(
            (n) => Reflect.get(n, "method") === "normalize",
          ),
        ).toBe(false);
      }),
  );

  const corruptions: ReadonlyArray<
    readonly [
      string,
      (fine: THREE.BufferGeometry, coarse: THREE.BufferGeometry) => void,
    ]
  > = [
    [
      "refined index",
      (g) => {
        g.index?.setX(0, 1);
      },
    ],
    [
      "coarse index",
      (_, g) => {
        g.index?.setX(0, 1);
      },
    ],
    [
      "original position",
      (g) => {
        g.getAttribute("position").setX(0, 9);
      },
    ],
    [
      "original normal",
      (g) => {
        g.getAttribute("normal").setX(0, 9);
      },
    ],
    [
      "fine barycentric UV",
      (g) => {
        g.getAttribute("uv").setX(13, 0);
      },
    ],
    [
      "coarse UV",
      (_, g) => {
        g.getAttribute("uv").setY(0, 0.5);
      },
    ],
    [
      "nonfinite fine",
      (g) => {
        g.getAttribute("position").setY(7, NaN);
      },
    ],
    [
      "truncated stream",
      (g) => {
        g.setAttribute("normal", new THREE.Float32BufferAttribute(3, 3));
      },
    ],
    [
      "instanced stream",
      (g) => {
        g.setAttribute(
          "normal",
          new THREE.InstancedBufferAttribute(new Float32Array(945), 3),
        );
      },
    ],
    [
      "prior binding",
      (g) => {
        g.setAttribute(NAMES[1], new StorageBufferAttribute(4, 4));
      },
    ],
  ];
  it.each(corruptions)("rejects %s before binding or callback", (_, corrupt) =>
    fixture(({ geometry, coarseGeometry }) => {
      corrupt(geometry, coarseGeometry);
      const before = { ...geometry.attributes };
      let called = false;
      expect(() =>
        createGrassMeadowRefinementResponse(
          geometry,
          coarseGeometry,
          float(0),
          (s) => {
            called = true;
            return response(s);
          },
        ),
      ).toThrow();
      expect(called).toBe(false);
      expect(geometry.attributes).toEqual(before);
    }),
  );

  it("does not attach anything when callback construction fails", () =>
    fixture(({ geometry, coarseGeometry }) => {
      const before = { ...geometry.attributes };
      const failure = new Error("intentional graph failure");
      expect(() =>
        createGrassMeadowRefinementResponse(
          geometry,
          coarseGeometry,
          float(0),
          () => {
            throw failure;
          },
        ),
      ).toThrow(failure);
      expect(geometry.attributes).toEqual(before);
    }));

  it("generates actual r186 WGSL storage reads without extra vertex streams", () =>
    fixture(({ geometry, coarseGeometry }) => {
      const result = createGrassMeadowRefinementResponse(
        geometry,
        coarseGeometry,
        float(0.4),
        response,
      );
      const material = new THREE.MeshStandardNodeMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      const dom = new JSDOM("<canvas></canvas>");
      const canvas = dom.window.document.querySelector("canvas");
      if (!canvas) throw new Error("Missing canvas constructor owner");
      // Real, uninitialized WebGPU renderer: no device/render or fake capabilities.
      const renderer = new THREE.WebGPURenderer({ canvas });
      try {
        for (const node of Object.values(result)) {
          const builder = new WGSLNodeBuilder(mesh, renderer);
          Reflect.set(builder, "camera", new THREE.PerspectiveCamera());
          Reflect.set(builder, "shaderStage", "vertex");
          const generate: unknown = Reflect.get(builder, "flowStagesNode");
          if (typeof generate !== "function")
            throw new Error("Missing native flow method");
          const flow: unknown = generate.call(builder, node, "vec3");
          if (
            !flow ||
            typeof flow !== "object" ||
            !("code" in flow) ||
            !("result" in flow) ||
            typeof flow.code !== "string" ||
            typeof flow.result !== "string"
          )
            throw new Error("Invalid native flow result");
          const text = flow.code + flow.result;
          expect(text).toContain("NodeBuffer_");
          expect(text).toContain("vertexIndex");
          expect(text).toContain("mix(");
          expect(text).not.toMatch(/undefined|NaN|Infinity|normalize\(/);
          for (const name of NAMES) expect(text).not.toContain(name);
        }
      } finally {
        renderer.dispose();
        dom.window.close();
        material.dispose();
      }
    }));
});

describe("explicit authored meadow endpoint response", () => {
  function authored(
    action: (r: ReturnType<typeof createMeadowAuthoredClumpGeometry>) => void,
  ) {
    const r = createMeadowAuthoredClumpGeometry();
    try {
      action(r);
    } finally {
      r.geometry.dispose();
      r.coarseGeometry.dispose();
    }
  }

  it.each([-1, 0, 0.5, 1, 2])(
    "preserves evaluated coarse parents at clamped weight %s",
    (weight) =>
      authored(({ geometry, coarseGeometry }) => {
        const before = Array.from(
          coarseGeometry.getAttribute("position").array,
        );
        const result = createGrassMeadowAuthoredResponse(
          geometry,
          coarseGeometry,
          float(weight),
          response,
        );
        const w = Math.max(0, Math.min(1, weight));
        let changedInterior = 0;
        for (let v = 0; v < 315; v++) {
          const base = Math.floor(v / 15) * 7;
          const pair = GRASS_MEADOW_REFINEMENT.parentPairs[v % 15];
          const a = expected(coarseGeometry, base + pair[0]);
          const b = expected(coarseGeometry, base + pair[1]);
          const fine = expected(geometry, v);
          for (const key of ["position", "normal", "width"] as const) {
            const want = a[key].map(
              (x, i) => (x + b[key][i]) * 0.5 * (1 - w) + fine[key][i] * w,
            );
            evaluateGraph(result[key], geometry, v).forEach((x, i) =>
              expect(x).toBeCloseTo(want[i], 12),
            );
          }
          if (
            v % 15 >= 2 &&
            v % 15 <= 5 &&
            Math.abs(fine.position[0] - a.position[0]) +
              Math.abs(fine.position[2] - a.position[2]) >
              1e-5
          )
            changedInterior++;
        }
        expect(changedInterior).toBeGreaterThan(40);
        expect(
          Array.from(coarseGeometry.getAttribute("position").array),
        ).toEqual(before);
        expect(
          nodes(Object.values(result)).some(
            (n) => Reflect.get(n, "method") === "normalize",
          ),
        ).toBe(false);
        expect(NAMES.map((name) => geometry.getAttribute(name).count)).toEqual([
          147, 147, 315,
        ]);
      }),
  );

  it("keeps the conforming endpoint's exact original-vertex contract", () =>
    authored(({ geometry, coarseGeometry }) => {
      let called = false;
      expect(() =>
        createGrassMeadowRefinementResponse(
          geometry,
          coarseGeometry,
          float(0),
          (s) => {
            called = true;
            return response(s);
          },
        ),
      ).toThrow(/Changed meadow refinement original vertex/);
      expect(called).toBe(false);
      expect(NAMES.every((name) => !geometry.hasAttribute(name))).toBe(true);
    }));

  it("rejects an unmarked conforming endpoint before binding", () =>
    fixture(({ geometry, coarseGeometry }) => {
      let called = false;
      expect(() =>
        createGrassMeadowAuthoredResponse(
          geometry,
          coarseGeometry,
          float(0),
          (s) => {
            called = true;
            return response(s);
          },
        ),
      ).toThrow();
      expect(called).toBe(false);
      expect(NAMES.every((name) => !geometry.hasAttribute(name))).toBe(true);
    }));

  it.each(["position", "normal", "uv"] as const)(
    "rejects altered authored %s before binding",
    (name) =>
      authored(({ geometry, coarseGeometry }) => {
        const a = geometry.getAttribute(name);
        a.setX(12, a.getX(12) + 0.02);
        let called = false;
        expect(() =>
          createGrassMeadowAuthoredResponse(
            geometry,
            coarseGeometry,
            float(1),
            (s) => {
              called = true;
              return response(s);
            },
          ),
        ).toThrow();
        expect(called).toBe(false);
        expect(NAMES.every((key) => !geometry.hasAttribute(key))).toBe(true);
      }),
  );

  it("validates cloned metadata and owns detached storage", () =>
    authored(({ geometry, coarseGeometry }) => {
      const clone = geometry.clone();
      try {
        createGrassMeadowAuthoredResponse(
          clone,
          coarseGeometry,
          float(0.5),
          response,
        );
        expect(NAMES.every((name) => !geometry.hasAttribute(name))).toBe(true);
        expect(clone.getAttribute(NAMES[0]).array).not.toBe(
          coarseGeometry.getAttribute("position").array,
        );
      } finally {
        clone.dispose();
      }
    }));
});

describe.each([
  {
    name: "footprint-locked arch",
    createBuffers: createMeadowFootprintArchBuffers,
    bind: createGrassMeadowFootprintArchResponse,
    swept: false,
  },
  {
    name: "complete swept blade",
    createBuffers: createMeadowSweptBladeBuffers,
    bind: createGrassMeadowSweptBladeResponse,
    swept: true,
  },
])("explicit $name response", ({ createBuffers, bind, swept }) => {
  function arch(
    action: (value: {
      geometry: THREE.BufferGeometry;
      coarseGeometry: THREE.BufferGeometry;
    }) => void,
  ) {
    const blades: GrassMeadowAuthoredBlade[] = [];
    const coarseGeometry = createClumpGeometry(
      21,
      3,
      FINE_GRASS_MEADOW_FIELD_SHAPE,
      undefined,
      (blade) => blades.push(blade),
    );
    const geometry = new THREE.BufferGeometry();
    try {
      const data = createBuffers(
        coarseGeometry,
        blades,
        FINE_GRASS_MEADOW_FIELD_SHAPE,
      );
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(data.positions, 3),
      );
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(data.normals, 3),
      );
      geometry.setAttribute("uv", new THREE.BufferAttribute(data.uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.userData[data.layout.metadataKey] = data.recipe;
      action({ geometry, coarseGeometry });
    } finally {
      geometry.dispose();
      coarseGeometry.dispose();
    }
  }

  const fineResponse = (sample: GrassMeadowFootprintArchSample) => ({
    ...response({
      ...sample,
      t: swept ? sin(sample.t.mul(Math.PI * 0.5)) : sample.t,
    }),
    width: sample.widthAxis,
  });

  it.each([-1, 0, 0.5, 1, 2])(
    "separates coarse/fine evaluation with apex-safe width at weight %s",
    (weight) =>
      arch(({ geometry, coarseGeometry }) => {
        let coarseCalls = 0;
        let fineCalls = 0;
        let widthGraph: Node | undefined;
        const before = { ...coarseGeometry.attributes };
        const result = bind(
          geometry,
          coarseGeometry,
          float(weight),
          (sample) => {
            coarseCalls++;
            expect(Object.keys(sample).sort()).toEqual([
              "normal",
              "position",
              "t",
            ]);
            return response(sample);
          },
          (sample) => {
            fineCalls++;
            widthGraph = sample.widthAxis;
            return fineResponse(sample);
          },
        );
        expect([coarseCalls, fineCalls]).toEqual([2, 1]);
        expect(coarseGeometry.attributes).toEqual(before);
        expect(NAMES.map((name) => geometry.getAttribute(name).count)).toEqual([
          147, 147, 315,
        ]);
        expect(
          NAMES.reduce(
            (sum, name) => sum + geometry.getAttribute(name).array.byteLength,
            0,
          ),
        ).toBe(7224);
        expect(Object.keys(geometry.attributes).sort()).toEqual(
          [...NAMES, "position", "normal", "uv"].sort(),
        );
        const widthNodes = nodes([actual(widthGraph)]);
        const widthStorage = widthNodes.filter((node) =>
          Reflect.get(node, "isStorageBufferNode"),
        );
        expect(widthStorage).toHaveLength(1);
        expect(Reflect.get(widthStorage[0], "value")).toBe(
          geometry.getAttribute(NAMES[0]),
        );
        expect(widthNodes.some((node) => node.type === "AttributeNode")).toBe(
          false,
        );
        const cp = coarseGeometry.getAttribute("position");
        const w = Math.max(0, Math.min(1, weight));
        for (let vertex = 0; vertex < 315; vertex++) {
          const base = Math.floor(vertex / 15) * 7;
          const [pa, pb] = GRASS_MEADOW_REFINEMENT.parentPairs[vertex % 15];
          const a = expected(coarseGeometry, base + pa);
          const b = expected(coarseGeometry, base + pb);
          const materialT = geometry.getAttribute("uv").getY(vertex);
          const fine = expected(
            geometry,
            vertex,
            swept ? Math.sin(materialT * Math.PI * 0.5) : materialT,
          );
          fine.width = new THREE.Vector3()
            .fromBufferAttribute(cp, base + 1)
            .sub(new THREE.Vector3().fromBufferAttribute(cp, base))
            .normalize()
            .toArray();
          expect(
            Math.hypot(...evaluateGraph(actual(widthGraph), geometry, vertex)),
          ).toBeCloseTo(1, 12);
          for (const key of ["position", "normal", "width"] as const) {
            const want = a[key].map(
              (value, axis) =>
                (value + b[key][axis]) * 0.5 * (1 - w) + fine[key][axis] * w,
            );
            evaluateGraph(result[key], geometry, vertex).forEach(
              (value, axis) => expect(value).toBeCloseTo(want[axis], 12),
            );
          }
        }
        // No normalization is inserted into the interpolated normal response.
        expect(
          nodes([result.normal]).some(
            (node) => Reflect.get(node, "method") === "normalize",
          ),
        ).toBe(false);
      }),
  );

  it("does not silently admit the arch under either historical endpoint", () =>
    arch(({ geometry, coarseGeometry }) => {
      for (const bind of [
        createGrassMeadowRefinementResponse,
        createGrassMeadowAuthoredResponse,
      ]) {
        let called = false;
        expect(() =>
          bind(geometry, coarseGeometry, float(0), (sample) => {
            called = true;
            return response(sample);
          }),
        ).toThrow();
        expect(called).toBe(false);
        expect(NAMES.some((name) => geometry.hasAttribute(name))).toBe(false);
      }
    }));

  it.each(["position", "normal", "uv", "index", "metadata", "root-span"])(
    "rejects invalid %s before callbacks or storage attachment",
    (field) =>
      arch(({ geometry, coarseGeometry }) => {
        if (field === "metadata") geometry.userData = {};
        else if (field === "index") geometry.index!.setX(0, 1);
        else if (field === "root-span") {
          const p = coarseGeometry.getAttribute("position");
          p.setXYZ(1, p.getX(0), p.getY(0), p.getZ(0));
        } else {
          const a = geometry.getAttribute(field);
          a.setX(12, a.getX(12) + 0.02);
        }
        const before = { ...geometry.attributes };
        let calls = 0;
        expect(() =>
          bind(
            geometry,
            coarseGeometry,
            float(0),
            (sample) => {
              calls++;
              return response(sample);
            },
            (sample) => {
              calls++;
              return fineResponse(sample);
            },
          ),
        ).toThrow();
        expect(calls).toBe(0);
        expect(geometry.attributes).toEqual(before);
      }),
  );

  it.each(["coarse", "fine"])(
    "does not attach storage after a %s callback failure",
    (where) =>
      arch(({ geometry, coarseGeometry }) => {
        const before = { ...geometry.attributes };
        const failure = new Error("intentional endpoint callback failure");
        expect(() =>
          bind(
            geometry,
            coarseGeometry,
            float(0.5),
            (sample) => {
              if (where === "coarse") throw failure;
              return response(sample);
            },
            (sample) => {
              if (where === "fine") throw failure;
              return fineResponse(sample);
            },
          ),
        ).toThrow(failure);
        expect(geometry.attributes).toEqual(before);
      }),
  );

  it("rejects absent fine evaluators and incomplete response graphs atomically", () =>
    arch(({ geometry, coarseGeometry }) => {
      const before = { ...geometry.attributes };
      for (const invalid of [undefined, () => ({})]) {
        expect(() =>
          Reflect.apply(bind, undefined, [
            geometry,
            coarseGeometry,
            float(0),
            response,
            invalid,
          ]),
        ).toThrow();
        expect(geometry.attributes).toEqual(before);
      }
    }));

  it("compiles the positive-UV bearing from existing vertex-stage storage", () =>
    arch(({ geometry, coarseGeometry }) => {
      let width: Node | undefined;
      bind(geometry, coarseGeometry, float(1), response, (sample) => {
        width = sample.widthAxis;
        return fineResponse(sample);
      });
      const material = new THREE.MeshStandardNodeMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      const dom = new JSDOM("<canvas></canvas>");
      const canvas = dom.window.document.querySelector("canvas");
      if (!canvas) throw new Error("Missing canvas constructor owner");
      const renderer = new THREE.WebGPURenderer({ canvas });
      try {
        const builder = new WGSLNodeBuilder(mesh, renderer);
        Reflect.set(builder, "camera", new THREE.PerspectiveCamera());
        Reflect.set(builder, "shaderStage", "vertex");
        const generate: unknown = Reflect.get(builder, "flowStagesNode");
        if (typeof generate !== "function")
          throw new Error("Missing native flow method");
        const flow: unknown = generate.call(builder, actual(width), "vec3");
        if (
          !flow ||
          typeof flow !== "object" ||
          !("code" in flow) ||
          !("result" in flow)
        )
          throw new Error("Invalid native flow");
        const code = String(flow.code) + String(flow.result);
        expect(code).toMatch(/normalize\(/);
        expect(code).toMatch(/vertexIndex\s*\/\s*15u/);
        expect(code).toContain("7u");
        expect(code).toContain("NodeBuffer_");
        expect(code).not.toMatch(
          /normalLocal|normalView|attribute|undefined|NaN|Infinity/,
        );
        for (const name of NAMES) expect(code).not.toContain(name);
      } finally {
        renderer.dispose();
        dom.window.close();
        material.dispose();
      }
    }));
});

describe("opt-in swept rest-height color coordinate", () => {
  function sweptFixture(
    quartic: boolean,
    action: (
      geometry: THREE.BufferGeometry,
      coarse: THREE.BufferGeometry,
    ) => void,
  ) {
    const blades: GrassMeadowAuthoredBlade[] = [];
    const shape = {
      ...FINE_GRASS_MEADOW_FIELD_SHAPE,
      ...(quartic
        ? { BLADE_WIDTH_BEZIER_CONTROL_POINTS: [0.25, 2.3, 1.3, 0, 0] as const }
        : {}),
    };
    const coarse = createClumpGeometry(21, 3, shape, undefined, (blade) =>
      blades.push(blade),
    );
    const geometry = new THREE.BufferGeometry();
    try {
      const data = createMeadowSweptBladeBuffers(coarse, blades, shape);
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(data.positions, 3),
      );
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(data.normals, 3),
      );
      geometry.setAttribute("uv", new THREE.BufferAttribute(data.uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.userData[data.layout.metadataKey] = data.recipe;
      action(geometry, coarse);
    } finally {
      geometry.dispose();
      coarse.dispose();
    }
  }

  it.each([false, true])(
    "exposes raw fine height using only the existing position storage (quartic %s)",
    (quartic) =>
      sweptFixture(quartic, (geometry, coarse) => {
        const result = createGrassMeadowSweptBladeResponse(
          geometry,
          coarse,
          float(0.5),
          response,
          response,
          true,
        );
        const restHeight = actual(result.restHeight);
        expect(NAMES.map((name) => geometry.getAttribute(name).count)).toEqual([
          147, 147, 315,
        ]);
        expect(Object.keys(geometry.attributes).sort()).toEqual(
          [...NAMES, "normal", "position", "uv"].sort(),
        );
        const graph = nodes([restHeight]);
        const buffers = graph.filter((node) =>
          Reflect.get(node, "isStorageBufferNode"),
        );
        expect(buffers).toHaveLength(1);
        expect(Reflect.get(buffers[0], "value")).toBe(
          geometry.getAttribute(NAMES[0]),
        );
        expect(
          graph
            .filter((node) => node.type === "AttributeNode")
            .map((node) => Reflect.get(node, "_attributeName")),
        ).toEqual(["position"]);
        expect(graph.some((node) => node.type === "VaryingNode")).toBe(false);
        for (let vertex = 0; vertex < 315; vertex++) {
          const height = geometry.getAttribute("position").getY(vertex);
          const tip = coarse
            .getAttribute("position")
            .getY(Math.floor(vertex / 15) * 7 + 6);
          expect(evaluateGraph(restHeight, geometry, vertex)[0]).toBe(
            height / tip,
          );
        }
      }),
  );

  it("keeps the default and explicit-false response graph and binding layout unchanged", () =>
    sweptFixture(true, (geometry, coarse) => {
      const clone = geometry.clone();
      try {
        const implicit = createGrassMeadowSweptBladeResponse(
          geometry,
          coarse,
          float(0.5),
          response,
          response,
        );
        const explicit = createGrassMeadowSweptBladeResponse(
          clone,
          coarse,
          float(0.5),
          response,
          response,
          false,
        );
        for (const result of [implicit, explicit]) {
          expect(Object.keys(result)).toEqual(["position", "normal", "width"]);
          expect(result.restHeight).toBeUndefined();
        }
        for (const name of NAMES)
          expect(geometry.getAttribute(name).array).toEqual(
            clone.getAttribute(name).array,
          );
        for (let vertex = 0; vertex < 315; vertex++)
          for (const key of ["position", "normal", "width"] as const)
            expect(evaluateGraph(implicit[key], geometry, vertex)).toEqual(
              evaluateGraph(explicit[key], clone, vertex),
            );
        expect(
          nodes([implicit.position, implicit.normal, implicit.width]).map(
            (node) => node.type,
          ),
        ).toEqual(
          nodes([explicit.position, explicit.normal, explicit.width]).map(
            (node) => node.type,
          ),
        );
      } finally {
        clone.dispose();
      }
    }));

  it.each([0, -0.01, NaN, Infinity])(
    "rejects invalid source tip %s before callbacks or binding",
    (tip) =>
      sweptFixture(true, (geometry, coarse) => {
        coarse.getAttribute("position").setY(6, tip);
        const before = { ...geometry.attributes };
        let calls = 0;
        const evaluate = (sample: GrassMeadowRefinementSample) => {
          calls++;
          return response(sample);
        };
        expect(() =>
          createGrassMeadowSweptBladeResponse(
            geometry,
            coarse,
            float(1),
            evaluate,
            evaluate,
            true,
          ),
        ).toThrow();
        expect(calls).toBe(0);
        expect(geometry.attributes).toEqual(before);
      }),
  );

  it("retains the canonical coordinate exactly at zero, including negative zero", () => {
    const geometry = new THREE.BufferGeometry();
    try {
      for (const t of [
        -0,
        0,
        Math.fround(1 / 6),
        Math.fround(1 / 3),
        Math.fround(2 / 3),
        1,
      ]) {
        for (const weight of [-2, -0, 0]) {
          const canonical = float(t);
          const node = createGrassMeadowRestHeightColorCoordinate(
            float(0.99),
            canonical,
            float(weight),
          );
          expect(node.type).toBe("ConditionalNode");
          expect(Reflect.get(node, "ifNode")).toBe(canonical);
          expect(Object.is(evaluateGraph(node, geometry, 0, true)[0], t)).toBe(
            true,
          );
        }
      }
    } finally {
      geometry.dispose();
    }
  });

  it("is finite, bounded and monotone with exact root/tip and clamped weights", () => {
    const geometry = new THREE.BufferGeometry();
    try {
      for (const weight of [-2, 0, 0.25, 0.5, 1, 3]) {
        let previous = -1;
        for (let sample = 0; sample <= 120; sample++) {
          const t = sample / 120;
          const h = 1 - (1 - Math.sin((t * Math.PI) / 2)) ** 2;
          const node = createGrassMeadowRestHeightColorCoordinate(
            float(h),
            float(t),
            float(weight),
          );
          const value = evaluateGraph(node, geometry, 0, true)[0];
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(previous);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          if (sample === 0 || sample === 120) expect(value).toBe(t);
          previous = value;
        }
      }
    } finally {
      geometry.dispose();
    }
  });

  it.each([false, true])(
    "bounds the Float32 coordinate approximation against all actual coarse blades and fine barycentrics (quartic %s)",
    (quartic) =>
      sweptFixture(quartic, (geometry, coarse) => {
        const position = geometry.getAttribute("position");
        const cp = coarse.getAttribute("position");
        const cu = coarse.getAttribute("uv");
        const barycentrics = [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
          [0.5, 0.5, 0],
          [0.2, 0.3, 0.5],
          [1 / 3, 1 / 3, 1 / 3],
        ];
        const sat = (value: number) => Math.max(0, Math.min(1, value));
        let maximumError = 0;
        let samples = 0;
        for (let blade = 0; blade < 21; blade++) {
          const base = blade * 7;
          const tip = cp.getY(base + 6);
          const b1 = cp.getY(base + 2) / tip,
            b2 = cp.getY(base + 4) / tip;
          const u1 = cu.getY(base + 2),
            u2 = cu.getY(base + 4);
          for (let triangle = 0; triangle < 15; triangle++) {
            const ids = [0, 1, 2].map((corner) =>
              geometry.index!.getX(blade * 45 + triangle * 3 + corner),
            );
            for (const barycentric of barycentrics) {
              const exactHeight = ids.reduce(
                (sum, vertex, corner) =>
                  sum + (position.getY(vertex) / tip) * barycentric[corner],
                0,
              );
              const roundedHeight = Math.fround(
                ids.reduce(
                  (sum, vertex, corner) =>
                    sum +
                    Math.fround(position.getY(vertex) / tip) *
                      barycentric[corner],
                  0,
                ),
              );
              const expected =
                u1 * sat(exactHeight / b1) +
                (u2 - u1) * sat((exactHeight - b1) / (b2 - b1)) +
                (1 - u2) * sat((exactHeight - b2) / (1 - b2));
              const node = createGrassMeadowRestHeightColorCoordinate(
                float(roundedHeight),
                float(0),
                float(1),
              );
              maximumError = Math.max(
                maximumError,
                Math.abs(evaluateGraph(node, geometry, 0, true)[0] - expected),
              );
              samples++;
            }
          }
        }
        expect(samples).toBe(1890);
        expect(maximumError).toBeGreaterThan(0);
        expect(maximumError).toBeLessThan(2e-7);
      }),
  );

  it("compiles the rest-height read only in the supplied vertex graph without new storage", () =>
    sweptFixture(true, (geometry, coarse) => {
      const result = createGrassMeadowSweptBladeResponse(
        geometry,
        coarse,
        float(1),
        response,
        response,
        true,
      );
      const material = new THREE.MeshStandardNodeMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      const dom = new JSDOM("<canvas></canvas>");
      const canvas = dom.window.document.querySelector("canvas");
      if (!canvas) throw new Error("Missing canvas constructor owner");
      const renderer = new THREE.WebGPURenderer({ canvas });
      try {
        const builder = new WGSLNodeBuilder(mesh, renderer);
        Reflect.set(builder, "camera", new THREE.PerspectiveCamera());
        Reflect.set(builder, "shaderStage", "vertex");
        const generate: unknown = Reflect.get(builder, "flowStagesNode");
        if (typeof generate !== "function")
          throw new Error("Missing native flow method");
        const flow: unknown = generate.call(
          builder,
          actual(result.restHeight),
          "float",
        );
        if (
          !flow ||
          typeof flow !== "object" ||
          !("code" in flow) ||
          !("result" in flow)
        )
          throw new Error("Invalid native flow");
        const code = String(flow.code) + String(flow.result);
        expect(code).toMatch(/vertexIndex\s*\/\s*15u/);
        expect(code).toContain("7u");
        expect(code).toContain("6u");
        expect(code).toContain("NodeBuffer_");
        expect(code).not.toMatch(/undefined|NaN|Infinity/);
        for (const name of NAMES) expect(code).not.toContain(name);
        const color = createGrassMeadowRestHeightColorCoordinate(
          float(0.5),
          float(0.3),
          float(1),
        );
        expect(
          nodes([color]).some(
            (node) =>
              Reflect.get(node, "isStorageBufferNode") ||
              node.type === "AttributeNode" ||
              node.type === "VaryingNode",
          ),
        ).toBe(false);
      } finally {
        renderer.dispose();
        dom.window.close();
        material.dispose();
      }
    }));
});
