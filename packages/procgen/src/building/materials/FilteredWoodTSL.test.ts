import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { float, uv, vec2, vec3 } from "three/tsl";
import { readFileSync } from "node:fs";
import {
  createFilteredWoodColorNode,
  integrateWoodFootprintNode,
  woodStatisticalMeanNode,
  WOOD_GAP_FRACTION,
} from "./FilteredWoodTSL";
import { createBuildingMaterial } from "./BuildingMaterialTSL";
const fractNumber = (x: number) => x - Math.floor(x);
// Actual installed Three stack/graph construction, not a renderer mock. No
// build()/shader compilation/rendering is attempted without a native renderer.
function builder() {
  return Reflect.construct(THREE.NodeBuilder, [
    null,
    null,
    null,
  ]) as THREE.NodeBuilder & { addStack(): void; removeStack(): void };
}
function inStack<T>(create: () => T): T {
  const native = builder();
  native.addStack();
  try {
    return create();
  } finally {
    native.removeStack();
  }
}
// Only these actual TSL expression operations are admitted. f32 rounds every
// arithmetic node/constant; native transcendental implementations and FMA may
// differ, so this is an adversarial CPU rounding check, not WGSL execution.
function evaluate(root: THREE.Node, f32 = false): number[] {
  const round = f32 ? Math.fround : (x: number) => x;
  const memo = new Map<THREE.Node, number[]>();
  const visit = (node: THREE.Node): number[] => {
    const old = memo.get(node);
    if (old) return old;
    const read = (key: string): unknown => Reflect.get(node, key);
    const child = (key: string) => {
      const value = read(key);
      if (!value || Reflect.get(value as object, "isNode") !== true)
        throw new Error(`Missing ${node.type}.${key}`);
      return visit(value as THREE.Node);
    };
    const combine = (keys: string[], fn: (...args: number[]) => number) => {
      const values = keys.map(child);
      return Array.from(
        { length: Math.max(...values.map((v) => v.length)) },
        (_, i) => fn(...values.map((v) => v[v.length === 1 ? 0 : i])),
      );
    };
    const calculate = (): number[] => {
      const value = read("value");
      if (typeof value === "number") return [value];
      if (
        value instanceof THREE.Vector2 ||
        value instanceof THREE.Vector3 ||
        value instanceof THREE.Color
      )
        return value.toArray();
      if (node.type === "ConvertNode" || node.type === "VarNode")
        return child("node");
      if (node.type === "JoinNode")
        return (read("nodes") as THREE.Node[]).flatMap(visit);
      if (node.type === "SplitNode")
        return [...String(read("components"))].map(
          (c) => child("node")["xyzw".indexOf(c)],
        );
      if (node.type === "ConditionalNode")
        return child("condNode")[0] ? child("ifNode") : child("elseNode");
      switch (read("op")) {
        case "+":
          return combine(["aNode", "bNode"], (a, b) => a + b);
        case "-":
          return combine(["aNode", "bNode"], (a, b) => a - b);
        case "*":
          return combine(["aNode", "bNode"], (a, b) => a * b);
        case "/":
          return combine(["aNode", "bNode"], (a, b) => a / b);
        case "%":
          return combine(
            ["aNode", "bNode"],
            (a, b) => a - b * Math.floor(a / b),
          );
        case "<":
          return combine(["aNode", "bNode"], (a, b) => +(a < b));
      }
      switch (read("method")) {
        case "abs":
          return child("aNode").map(Math.abs);
        case "floor":
          return child("aNode").map(Math.floor);
        case "fract":
          return child("aNode").map(fractNumber);
        case "sin":
          return child("aNode").map(Math.sin);
        case "asin":
          return child("aNode").map(Math.asin);
        case "min":
          return combine(["aNode", "bNode"], Math.min);
        case "max":
          return combine(["aNode", "bNode"], Math.max);
        // r186 WGSL modulo, deliberately NOT JavaScript's negative remainder.
        case "mod":
          return combine(
            ["aNode", "bNode"],
            (a, b) => a - b * Math.floor(a / b),
          );
        case "clamp":
          return combine(["aNode", "bNode", "cNode"], (x, lo, hi) =>
            Math.max(lo, Math.min(hi, x)),
          );
        case "mix":
          return combine(
            ["aNode", "bNode", "cNode"],
            (a, b, t) => round(a * round(1 - t)) + round(b * t),
          );
        case "smoothstep":
          return combine(["aNode", "bNode", "cNode"], (a, b, x) => {
            const t = Math.max(
              0,
              Math.min(1, round(round(x - a) / round(b - a))),
            );
            return round(t * t) * round(3 - round(2 * t));
          });
      }
      throw new Error(
        `Unsupported actual node ${node.type}/${String(read("op"))}/${String(read("method"))}`,
      );
    };
    const result = calculate().map(round);
    memo.set(node, result);
    return result;
  };
  return visit(root);
}

function graph(root: THREE.Node, native?: THREE.NodeBuilder) {
  const nodes = new Set<THREE.Node>();
  const visit = (node: THREE.Node) => {
    if (nodes.has(node)) return;
    nodes.add(node);
    const getOutput = Reflect.get(node, "getOutputNode") as unknown;
    if (
      native &&
      typeof getOutput === "function" &&
      Reflect.get(node, "isShaderCallNodeInternal")
    )
      visit(Reflect.apply(getOutput, node, [native]) as THREE.Node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return [...nodes];
}

const base = [0.35, 0.24, 0.13] as const,
  secondary = [0.18, 0.12, 0.07] as const,
  accent = [0.07, 0.05, 0.03] as const,
  variation = 0.28;
type Pair = [number, number];
const kernel = (center: Pair, width: Pair) =>
  inStack(() =>
    integrateWoodFootprintNode(
      vec2(...center),
      vec2(...width),
      vec3(...base),
      vec3(...secondary),
      vec3(...accent),
      float(variation),
    ),
  );
const hash = (x: number, y: number) =>
  fractNumber(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function point(u: number, v: number, uWidth: number): number[] {
  const row = Math.floor(v / 0.15),
    local = fractNumber(v / 0.15);
  if (local < WOOD_GAP_FRACTION || local > 1 - WOOD_GAP_FRACTION)
    return [...accent];
  const tint = hash(row, 0),
    grain = fractNumber(fractNumber(u / 2) + tint * 0.3) * 20,
    c = Math.floor(grain),
    f = fractNumber(grain);
  const noise =
    hash(c, row) * (1 - smooth(0, 1, f)) + hash(c + 1, row) * smooth(0, 1, f);
  const filtered =
    noise * (1 - smooth(0.5, 1, Math.abs(uWidth) * 10)) +
    0.5 * smooth(0.5, 1, Math.abs(uWidth) * 10);
  return base.map(
    (b, i) =>
      (b + (secondary[i] - b) * tint * variation) * (1 - filtered * 0.045),
  );
}
function dense(center: Pair, width: Pair): number[] {
  const count = 8192,
    sum = [0, 0, 0],
    w = Math.max(0.0001, Math.min(1, Math.abs(width[1]) / 0.15)) * 0.15;
  for (let i = 0; i < count; i++) {
    const row = point(
      center[0],
      center[1] + ((i + 0.5) / count - 0.5) * w,
      width[0],
    );
    for (let c = 0; c < 3; c++) sum[c] += row[c] / count;
  }
  return sum;
}
function close(a: number[], b: number[], tolerance: number) {
  for (let i = 0; i < a.length; i++)
    expect(Math.abs(a[i] - b[i])).toBeLessThan(tolerance);
}
describe("compact timber pixel-footprint color", () => {
  it("integrates both narrow seam edges and both neighboring plank colors against dense original sampling", () => {
    for (const u of [-3.3, 0.2, 7.1])
      for (const v of [-0.151, -0.001, 0, 0.004, 0.075, 0.149, 0.3])
        for (const width of [0.000015, 0.001, 0.011, 0.075, 0.15]) {
          const center: Pair = [u, v],
            footprint: Pair = [0.00001, width];
          close(
            evaluate(kernel(center, footprint)),
            dense(center, footprint),
            0.00008,
          );
        }
  });
  it("preserves resolved grain; suppresses longitudinal subpixel noise without deleting per-board tint", () => {
    for (const width of [0.00001, 0.05, 0.075, 0.1, 0.4])
      for (const u of [0.011, 0.193, 0.731, 1.997]) {
        close(
          evaluate(kernel([u, 0.075], [width, 0.00001])),
          point(u, 0.075, width),
          1e-10,
        );
      }
    close(
      evaluate(kernel([0.11, 0.075], [0.11, 0.00001])),
      evaluate(kernel([1.77, 0.075], [0.11, 0.00001])),
      1e-10,
    );
    expect(evaluate(kernel([0.11, 0.075], [0.00001, 0.00001]))).not.toEqual(
      evaluate(kernel([1.77, 0.075], [0.00001, 0.00001])),
    );
  });
  it("converges to a bounded statistical mean across unresolved rows with finite float32 tiny/negative-coordinate arithmetic", () => {
    const mean = evaluate(
      woodStatisticalMeanNode(
        vec3(...base),
        vec3(...secondary),
        vec3(...accent),
        float(variation),
      ),
    );
    for (const width of [0.3, 0.6, 100])
      for (const v of [-10.001, 0, 9.937])
        close(evaluate(kernel([1.1, v], [0.005, width])), mean, 1e-10);
    for (const v of [-100, -0.15, -0.005, 0, 0.005, 0.15, 100])
      for (const width of [
        0, 0.0000001, 0.000015, 0.01, 0.15, 0.225, 0.3, 100,
      ]) {
        const values = evaluate(kernel([0.173, v], [width, width]), true);
        for (let i = 0; i < 3; i++) {
          expect(Number.isFinite(values[i])).toBe(true);
          expect(values[i]).toBeGreaterThanOrEqual(accent[i] - 0.000001);
          expect(values[i]).toBeLessThanOrEqual(base[i] + 0.000001);
        }
      }
  });
  it("constructs actual fixed-work TSL graph, takes one continuous derivative, and introduces no textures or render passes", () => {
    const node = inStack(() =>
      createFilteredWoodColorNode(
        uv(),
        vec3(...base),
        vec3(...secondary),
        vec3(...accent),
        float(variation),
      ),
    );
    const nodes = graph(node, builder());
    expect(
      nodes.filter((n) => Reflect.get(n, "method") === "fwidth"),
    ).toHaveLength(1);
    expect(
      nodes.filter((n) => Reflect.get(n, "method") === "sin"),
    ).toHaveLength(6);
    expect(
      nodes.some((n) =>
        ["LoopNode", "TextureNode", "PassNode", "RenderOutputNode"].includes(
          n.type,
        ),
      ),
    ).toBe(false);
    expect(nodes.length).toBeLessThan(600);
  });
  it("is explicit timber-only admission and leaves material lighting/shadow/geometry state unchanged", () => {
    const old = createBuildingMaterial({
        type: "wood-plank",
        useVertexColors: false,
      }),
      candidate = createBuildingMaterial({
        type: "wood-plank",
        woodFiltering: "footprint-v1",
        useVertexColors: false,
      });
    try {
      for (const key of [
        "roughness",
        "metalness",
        "transparent",
        "depthWrite",
        "side",
        "normalNode",
        "positionNode",
        "maskNode",
        "maskShadowNode",
      ] as const)
        expect(candidate[key]).toEqual(old[key]);
      expect(
        graph(old.colorNode!, builder()).some(
          (n) => Reflect.get(n, "method") === "fwidth",
        ),
      ).toBe(false);
      expect(
        graph(candidate.colorNode!, builder()).filter(
          (n) => Reflect.get(n, "method") === "fwidth",
        ),
      ).toHaveLength(1);
    } finally {
      old.dispose();
      candidate.dispose();
    }
    expect(() =>
      createBuildingMaterial({ type: "brick", woodFiltering: "footprint-v1" }),
    ).toThrow(/explicit wood-plank/);
    expect(() =>
      createBuildingMaterial({
        type: "wood-plank",
        woodFiltering: "bad" as "footprint-v1",
      }),
    ).toThrow(/explicit wood-plank/);
    const source = readFileSync(
      new URL(
        "../../../../shared/src/systems/client/CompactServiceCourtVisualsSystem.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source.match(/woodFiltering:/g)).toHaveLength(1);
  });
});
