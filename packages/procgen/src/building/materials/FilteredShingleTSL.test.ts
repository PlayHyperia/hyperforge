import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { float, uv, vec2, vec3 } from "three/tsl";
import {
  createFilteredShingleColorNode,
  integrateShingleFootprintNode,
  SHINGLE_CORRELATED_HASH_MEAN,
  SHINGLE_CURVE_PI,
  SHINGLE_MEAN_GAP,
  shingleStatisticalMeanNode,
} from "./FilteredShingleTSL";
import {
  createBuildingMaterial,
  type BuildingMaterialConfig,
} from "./BuildingMaterialTSL";

type Pair = [number, number];
const base = new THREE.Color("#686e6b").toArray();
const secondary = new THREE.Color("#485759").toArray();
const variation = 0.3;
const fractNumber = (x: number) => x - Math.floor(x);
const hash = (x: number, y: number) =>
  fractNumber(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123);

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
function kernel(center: Pair, width: Pair) {
  return inStack(() =>
    integrateShingleFootprintNode(
      vec2(...center),
      vec2(...width),
      vec3(...base),
      vec3(...secondary),
      float(variation),
    ),
  );
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

// Independent dense midpoint integration of the ORIGINAL color function. The
// vertical piecewise-constant shader is integrated exactly per row; horizontal
// samples evaluate sin directly, never the candidate's roots/antiderivative.
function denseOriginal(center: Pair, width: Pair, samples = 32768): number[] {
  const low = center.map((v, i) => v - width[i] / 2);
  const high = center.map((v, i) => v + width[i] / 2);
  const sum = [0, 0, 0];
  for (let i = 0; i < samples; i++) {
    const x = low[0] + ((i + 0.5) / samples) * width[0];
    for (let row = Math.floor(low[1]); row <= Math.floor(high[1]); row++) {
      const vLo = Math.max(0, low[1] - row),
        vHi = Math.min(1, high[1] - row);
      if (vHi <= vLo) continue;
      const stagger = (row - 2 * Math.floor(row / 2)) * 0.5;
      const column = Math.floor(x + stagger),
        u = fractNumber(x + stagger);
      const edge = 0.05 + 0.1 * Math.sin(3.14159 * u);
      const gap = Math.max(0, Math.min(vHi, edge) - vLo);
      const h = hash(column, row);
      for (let c = 0; c < 3; c++) {
        const solid =
          (base[c] + (secondary[c] - base[c]) * h * variation) *
          (0.95 + 0.1 * h);
        sum[c] += solid * (vHi - vLo - gap) + base[c] * 0.3 * gap;
      }
    }
  }
  return sum.map((v) => v / (samples * width[1]));
}
function expectClose(actual: number[], expected: number[], tolerance: number) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((x, i) => {
    expect(Number.isFinite(x)).toBe(true);
    expect(Math.abs(x - expected[i])).toBeLessThan(tolerance);
  });
}

describe("compact-only analytic shingle footprint candidate", () => {
  it("integrates both periodic boundaries, curved cusps, negative UV and staggered cells against the dense original", () => {
    const cases: [Pair, Pair][] = [
      [
        [0.5, 0.15],
        [0.2, 0.1],
      ],
      [
        [0.5, 0.15],
        [0.001, 0.001],
      ],
      [
        [0.0, 0.05],
        [0.2, 0.2],
      ],
      [
        [0.999, 0.999],
        [0.2, 0.2],
      ],
      [
        [0.49, 1.01],
        [0.35, 0.6],
      ],
      [
        [0.49, -0.01],
        [0.35, 0.6],
      ],
      [
        [-0.51, -1.01],
        [0.2, 0.33],
      ],
      [
        [-5.0, -6.0],
        [1, 1],
      ],
      [
        [5.12, 11.28],
        [0.19, 0.6786],
      ],
      [
        [-4.6, 3.1],
        [0.18, 0.3444],
      ],
      [
        [0.37, 0.0],
        [1, 0.15],
      ],
      [
        [0.37, 1.0],
        [1, 0.15],
      ],
      [
        [0.5, 0.7],
        [0.0001, 0.0001],
      ],
      [
        [-1.25, 2.02],
        [0.4, 0.0001],
      ],
    ];
    for (const [center, width] of cases)
      expectClose(
        evaluate(kernel(center, width)),
        denseOriginal(center, width),
        0.000005,
      );
  });

  it("is continuous at periodic row/column joins and invariant to footprint reflection", () => {
    for (const center of [
      [0, 0],
      [0.5, 1],
      [-1.5, -1],
      [0.5, 0.15],
    ] as Pair[]) {
      const expected = evaluate(kernel(center, [0.2, 0.6]));
      for (const width of [
        [-0.2, 0.6],
        [0.2, -0.6],
        [-0.2, -0.6],
      ] as Pair[])
        expectClose(evaluate(kernel(center, width)), expected, 1e-12);
      for (let axis = 0; axis < 2; axis++) {
        const a: Pair = [...center],
          b: Pair = [...center];
        a[axis] -= 1e-7;
        b[axis] += 1e-7;
        expectClose(
          evaluate(kernel(a, [0.2, 0.6])),
          evaluate(kernel(b, [0.2, 0.6])),
          1e-6,
        );
      }
    }
  });

  it("retains resolved legacy colors and the exact scale; no arbitrary distant brightness constant", () => {
    for (const center of [
      [0.3, 0.01],
      [0.3, 0.6],
      [-2.7, -3.4],
      [5.1, 11.8],
    ] as Pair[])
      expectClose(
        evaluate(kernel(center, [0.0001, 0.0001])),
        denseOriginal(center, [0.0001, 0.0001], 64),
        1e-10,
      );
    const result = inStack(() =>
      createFilteredShingleColorNode(
        uv().div(1.25),
        vec3(...base),
        vec3(...secondary),
        float(variation),
      ),
    );
    const derivatives = graph(result).filter(
      (n) => Reflect.get(n, "method") === "fwidth",
    );
    expect(derivatives).toHaveLength(1);
    const input = Reflect.get(derivatives[0], "aNode") as THREE.Node;
    expect(
      graph(input).some((n) =>
        ["fract", "floor"].includes(String(Reflect.get(n, "method"))),
      ),
    ).toBe(false);
    const vectors = graph(input)
      .map((n) => Reflect.get(n, "value") as unknown)
      .filter((v) => v instanceof THREE.Vector2);
    expect(vectors.some((v) => v.x === 0.2 && v.y === 0.15 * (1 - 0.3))).toBe(
      true,
    );
  });

  it("uses the correlated tint/thickness mean and smoothly approaches it only for unresolved footprints", () => {
    expect(SHINGLE_CURVE_PI).toBe(3.14159);
    expect(SHINGLE_CORRELATED_HASH_MEAN).toBe(61 / 120);
    const expected = base.map(
      (b, i) =>
        (b + (secondary[i] - b) * variation * (61 / 120)) *
          (1 - SHINGLE_MEAN_GAP) +
        b * 0.3 * SHINGLE_MEAN_GAP,
    );
    expectClose(
      evaluate(
        shingleStatisticalMeanNode(
          vec3(...base),
          vec3(...secondary),
          float(variation),
        ),
      ),
      expected,
      1e-15,
    );
    // Independently integrate uniform h, retaining its correlation in both factors.
    const integrated = [0, 0, 0];
    const count = 100000;
    for (let i = 0; i < count; i++) {
      const h = (i + 0.5) / count;
      base.forEach((b, c) => {
        integrated[c] +=
          ((b + (secondary[c] - b) * variation * h) *
            (0.95 + 0.1 * h) *
            (1 - SHINGLE_MEAN_GAP) +
            b * 0.3 * SHINGLE_MEAN_GAP) /
          count;
      });
    }
    expectClose(integrated, expected, 1e-12);
    for (const center of [
      [-2.9, 3.95],
      [0.5, 0.15],
      [5, -11],
    ] as Pair[]) {
      expectClose(evaluate(kernel(center, [2, 0.1])), expected, 1e-15);
      expectClose(evaluate(kernel(center, [100, 100])), expected, 1e-15);
      for (const boundary of [1, 2])
        expectClose(
          evaluate(kernel(center, [boundary - 1e-7, 0.6])),
          evaluate(kernel(center, [boundary + 1e-7, 0.6])),
          1e-6,
        );
    }
  });

  it("keeps float32 zero/tiny widths and cusps finite and convex at actual roof and large cell IDs", () => {
    for (const offset of [0, -6, 12, 10000, -10000]) {
      for (const point of [
        [0.0, 0.0],
        [0.5, 0.15],
        [0.99, 0.05],
        [0.5, 0.6],
      ] as Pair[]) {
        const center: Pair = [offset + point[0], offset + point[1]];
        for (const width of [
          [0, 0],
          [1e-8, -1e-8],
          [0.0001, 0.0001],
          [0.2, 0.6],
          [2, 2],
        ] as Pair[]) {
          const result = evaluate(kernel(center, width), true);
          result.forEach((x, i) => {
            expect(Number.isFinite(x)).toBe(true);
            expect(x).toBeGreaterThanOrEqual(base[i] * 0.3 - 1e-6);
            expect(x).toBeLessThanOrEqual(
              Math.max(base[i], secondary[i]) * 1.05 + 1e-6,
            );
          });
        }
      }
    }
    // Isolate geometric rounding from the intentionally chaotic legacy hash:
    // identical colors + variation=0 still retain hash-driven thickness, so use
    // the actual evaluated hash to bound each convex contribution above. Here
    // origin zero gives exact hash0 and permits a strict cusp accuracy oracle.
    for (const center of [
      [0.5, 0.15],
      [0.9, 0.08090172],
      [0.3, 0.6],
    ] as Pair[])
      expectClose(
        evaluate(kernel(center, [0.0001, 0.0001]), true),
        denseOriginal(center, [0.0001, 0.0001]),
        0.0001,
      );
  });

  it("constructs actual bounded material graphs with explicit sharing and preserves direct legacy materials", () => {
    const config = {
      type: "shingle",
      baseColor: "#686e6b",
      secondaryColor: "#485759",
      accentColor: "#333e3e",
      scale: 1.25,
      roughness: 0.8,
      variation: 0.3,
      metalness: 0,
      useVertexColors: false,
    } satisfies BuildingMaterialConfig;
    const old = createBuildingMaterial(config);
    const filtered = createBuildingMaterial({
      ...config,
      shingleFiltering: "footprint-v1",
    });
    try {
      expect(old).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
      expect(filtered).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
      for (const key of [
        "roughness",
        "metalness",
        "side",
        "transparent",
        "depthWrite",
        "alphaTest",
        "normalNode",
        "positionNode",
      ] as const)
        expect(filtered[key]).toEqual(old[key]);
      for (const key of Object.keys(
        old.buildingUniforms,
      ) as (keyof typeof old.buildingUniforms)[])
        expect(filtered.buildingUniforms[key].value).toEqual(
          old.buildingUniforms[key].value,
        );
      const oldNodes = graph(old.colorNode!, builder());
      const current = graph(filtered.colorNode!, builder());
      expect(oldNodes.some((n) => Reflect.get(n, "method") === "fwidth")).toBe(
        false,
      );
      expect(
        current.filter((n) => Reflect.get(n, "method") === "fwidth"),
      ).toHaveLength(1);
      const asin = current.filter((n) => Reflect.get(n, "method") === "asin");
      expect(asin).toHaveLength(4);
      for (const node of asin)
        expect(
          current.some(
            (n) => n.type === "VarNode" && Reflect.get(n, "node") === node,
          ),
        ).toBe(true);
      expect(
        current.filter((n) => Reflect.get(n, "method") === "sin"),
      ).toHaveLength(20);
      expect(
        current.some((n) =>
          ["LoopNode", "TextureNode", "RenderOutputNode", "PassNode"].includes(
            n.type,
          ),
        ),
      ).toBe(false);
      expect(current).toHaveLength(1088);
    } finally {
      old.dispose();
      filtered.dispose();
    }
    expect(() =>
      createBuildingMaterial({
        type: "brick",
        shingleFiltering: "footprint-v1",
      }),
    ).toThrow(/explicit shingle/);
    expect(() =>
      createBuildingMaterial({
        type: "shingle",
        shingleFiltering: "unknown" as "footprint-v1",
      }),
    ).toThrow(/explicit shingle/);
  });

  it("retains the legacy shingle branch expression and restricts the sole runtime opt-in to the compact roof", () => {
    const source = readFileSync(
      new URL("./BuildingMaterialTSL.ts", import.meta.url),
      "utf8",
    );
    const legacy = source
      .slice(
        source.indexOf("// Shingle\n"),
        source.indexOf("    } else {\n      surfaceColor.assign(uBaseColor)"),
      )
      .trim()
      .replace(/^\s+/gm, "");
    expect(legacy).toBe(
      `// Shingle
patternResult.assign(shinglePattern(scaledUV));
const isShingle = patternResult.x;
const shingleId = patternResult.yz;
const thickness = patternResult.w;

const shingleNoise = tslHash(shingleId);
const shingleColor = mix(
uBaseColor,
uSecondaryColor,
shingleNoise.mul(uVariation),
);
const shadedColor = shingleColor.mul(thickness);
surfaceColor.assign(mix(uBaseColor.mul(0.3), shadedColor, isShingle));
}`.replace(/^\s+/gm, ""),
    );
    const lodge = readFileSync(
      new URL(
        "../../../../shared/src/systems/client/CompactPreparationLodgeVisualsSystem.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(lodge.match(/shingleFiltering:/g)).toHaveLength(1);
    expect(lodge).toContain(
      'type: "shingle",\n      shingleFiltering: "footprint-v1",',
    );
  });
});
