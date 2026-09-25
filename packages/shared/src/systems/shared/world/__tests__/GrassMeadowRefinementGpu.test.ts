import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { float, vec3, vertexIndex } from "three/tsl";
import { StorageBufferAttribute, WGSLNodeBuilder } from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import THREE from "../../../../extras/three/three";
import {
  createMeadowDetailClumpGeometry,
  createMeadowAuthoredClumpGeometry,
} from "../GrassVisualManager";
import { GRASS_MEADOW_REFINEMENT } from "../GrassBladeLayout";
import {
  createGrassMeadowRefinementResponse,
  createGrassMeadowAuthoredResponse,
  GRASS_MEADOW_COARSE_POSITION_T_ATTRIBUTE,
  GRASS_MEADOW_COARSE_NORMAL_U_ATTRIBUTE,
  GRASS_MEADOW_PARENT_PAIRS_ATTRIBUTE,
  type GrassMeadowRefinementSample,
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
    else {
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
          if (read("op") === "*") return x * y;
          if (read("method") === "mix") return x * (1 - z) + y * z;
          if (read("method") === "clamp") return Math.max(y, Math.min(z, x));
          throw new Error(
            `Unknown graph node ${n.type}/${String(read("method"))}`,
          );
        },
      );
    }
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
function expected(geometry: THREE.BufferGeometry, vertex: number) {
  const p = new THREE.Vector3()
    .fromBufferAttribute(geometry.getAttribute("position"), vertex)
    .toArray();
  const n = new THREE.Vector3()
    .fromBufferAttribute(geometry.getAttribute("normal"), vertex)
    .toArray();
  const t = geometry.getAttribute("uv").getY(vertex);
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
