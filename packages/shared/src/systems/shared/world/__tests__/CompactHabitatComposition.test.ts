import { describe, expect, it } from "vitest";
import type { Node } from "three/webgpu";
import habitatData from "../../../../data/compact-haven-habitat-v1.json";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import THREE, {
  attribute,
  float,
  min,
  max,
  smoothstep,
} from "../../../../extras/three/three";
import {
  evaluateCompactHabitatSoil,
  sampleCompactHabitatSoil,
  validateCompactHabitatComposition,
  type CompactHabitatArithmetic,
  type CompactHabitatBounds,
  type CompactHabitatDescriptor,
  type CompactHabitatField,
} from "../CompactHabitatComposition";

// Deliberately unrelated to the game's habitat layout: authoring must remain
// data-driven, and translated/rotated copies must retain the same field.
const bounds: CompactHabitatBounds = {
  minX: -40,
  maxX: 40,
  minZ: -40,
  maxZ: 40,
};
const first = {
  id: "first-pocket",
  vertices: [
    [-12, -8],
    [8, -8],
    [12, -2],
    [8, 10],
    [-7, 12],
    [-13, 2],
  ],
  edgeWidth: 3,
  strength: 0.55,
};
const second = {
  id: "second-pocket",
  vertices: [
    [2, -4],
    [16, -7],
    [22, 1],
    [15, 16],
    [4, 13],
    [-1, 4],
  ],
  edgeWidth: 4,
  strength: 0.8,
};
function descriptor() {
  return structuredClone({ schemaVersion: 1, pockets: [first, second] });
}
function rectangle() {
  return {
    schemaVersion: 1,
    pockets: [
      {
        id: "rectangle",
        vertices: [
          [-10, -8],
          [10, -8],
          [10, 8],
          [-10, 8],
        ],
        edgeWidth: 2,
        strength: 0.6,
      },
    ],
  };
}

const tsl: CompactHabitatArithmetic<Node<"float">> = {
  constant: (value) => float(value),
  add: (a, b) => a.add(b),
  mul: (a, b) => a.mul(b),
  min: (a, b) => min(a, b),
  max: (a, b) => max(a, b),
  smoothstep: (low, high, value) => smoothstep(low, high, value),
};

/** Read only actual constructed Three TSL nodes. Unknown operations throw.
 * This checks node arithmetic, not a renderer, WGSL execution or GPU timing. */
function nodeValue(root: Node, x: number, z: number): number {
  const cache = new Map<Node, number>();
  const visit = (node: Node): number => {
    const previous = cache.get(node);
    if (previous !== undefined) return previous;
    const read = (key: string): unknown => Reflect.get(node, key);
    const child = (key: string) => {
      const next = read(key);
      if (!(next instanceof THREE.Node))
        throw new Error(`Missing ${key} on ${node.type}`);
      return visit(next);
    };
    const calculate = () => {
      if (node.type === "AttributeNode") {
        if (read("_attributeName") === "worldX") return x;
        if (read("_attributeName") === "worldZ") return z;
        throw new Error("Unexpected field attribute");
      }
      const value = read("value");
      if (typeof value === "number") return value;
      if (node.type === "ConvertNode" || node.type === "VarNode")
        return child("node");
      const a = child("aNode"),
        b = child("bNode");
      if (read("op") === "+") return a + b;
      if (read("op") === "*") return a * b;
      if (read("method") === "min") return Math.min(a, b);
      if (read("method") === "max") return Math.max(a, b);
      if (read("method") === "smoothstep") {
        const c = child("cNode");
        const t = Math.max(0, Math.min(1, (c - a) / (b - a)));
        return t * t * (3 - 2 * t);
      }
      throw new Error(`Unexpected habitat node ${node.type}`);
    };
    const result = calculate();
    if (!Number.isFinite(result)) throw new Error("Nonfinite habitat node");
    cache.set(node, result);
    return result;
  };
  return visit(root);
}

// Independent signed edge-distance reference, using point-relative cross
// products rather than the compiled halfplane expression under test.
function reference(x: number, z: number, source: CompactHabitatDescriptor) {
  return Math.max(
    0,
    ...source.pockets.map((pocket) => {
      const distance = Math.min(
        ...pocket.vertices.map((a, index) => {
          const b = pocket.vertices[(index + 1) % pocket.vertices.length];
          const dx = b[0] - a[0],
            dz = b[1] - a[1];
          return (dx * (z - a[1]) - dz * (x - a[0])) / Math.hypot(dx, dz);
        }),
      );
      const t = Math.max(0, Math.min(1, distance / pocket.edgeWidth));
      return pocket.strength * t * t * (3 - 2 * t);
    }),
  );
}

describe("bounded authored habitat composition", () => {
  it("admits the actual separate authoring JSON and covers its authoritative functional tree positions", () => {
    const field = validateCompactHabitatComposition(
      habitatData.composition,
      habitatData.bounds,
    );
    expect(field.descriptor.pockets).toHaveLength(2);
    expect(field.pockets.reduce((sum, p) => sum + p.edges.length, 0)).toBe(12);
    const node = evaluateCompactHabitatSoil(
      attribute("worldX", "float"),
      attribute("worldZ", "float"),
      field,
      tsl,
    );
    const nodes = new Set<Node>();
    const visit = (current: Node) => {
      if (nodes.has(current)) return;
      expect(nodes.size).toBeLessThan(512);
      nodes.add(current);
      const value: unknown = Reflect.get(current, "value");
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      expect(Reflect.get(current, "isTextureNode")).not.toBe(true);
      expect(Reflect.get(current, "isVaryingNode")).not.toBe(true);
      for (const child of current.getChildren()) visit(child);
    };
    visit(node);
    expect(
      [...nodes]
        .filter((n) => n.type === "AttributeNode")
        .map((n) => Reflect.get(n, "_attributeName"))
        .sort(),
    ).toEqual(["worldX", "worldZ"]);
    const resources = Object.values(ALL_WORLD_AREAS).flatMap(
      (area) => area.resources ?? [],
    );
    for (const anchor of habitatData.treeAnchors) {
      const matches = resources.filter(
        (r) => r.type === "tree" && r.instanceId === anchor.instanceId,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].position.x).toBe(anchor.x);
      expect(matches[0].position.z).toBe(anchor.z);
      const weight = sampleCompactHabitatSoil(anchor.x, anchor.z, field);
      expect(weight).toBeGreaterThan(0.2);
      expect(nodeValue(node, anchor.x, anchor.z)).toBe(weight);
    }
    const config = DataManager.getWorldConfig();
    expect(config?.terrainProfile?.id).toBe(habitatData.terrainProfileId);
    expect(habitatData.toeAnchors).toEqual(
      config?.terrainProfile?.havenShoulder?.toe.map(([x, z]) => [x, z]),
    );
    for (const anchor of habitatData.rockAnchors) {
      const matches = config?.compactLandscapeRocks?.rocks.filter(
        (r) => r.id === anchor.id,
      );
      expect(matches).toHaveLength(1);
      expect(matches![0].x).toBe(anchor.x);
      expect(matches![0].z).toBe(anchor.z);
      expect(
        sampleCompactHabitatSoil(anchor.x, anchor.z, field),
      ).toBeGreaterThan(0);
      expect(nodeValue(node, anchor.x, anchor.z)).toBe(
        sampleCompactHabitatSoil(anchor.x, anchor.z, field),
      );
    }
    // Source-backed authoring, not proof of native contact or art acceptance.
    expect(field.bounds).toEqual(habitatData.bounds);
  });

  it("detaches and deeply freezes descriptor, explicit bounds and normalized halfplanes", () => {
    const input = descriptor(),
      inputBounds = { ...bounds };
    const field = validateCompactHabitatComposition(input, inputBounds);
    const before = JSON.stringify(field);
    input.pockets[0].vertices[0][0] = 30;
    input.pockets[0].edgeWidth = 4;
    inputBounds.minX = -100;
    expect(JSON.stringify(field)).toBe(before);
    for (const value of [
      field,
      field.bounds,
      field.descriptor,
      field.descriptor.pockets,
      field.pockets,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    for (const pocket of field.descriptor.pockets) {
      expect(Object.isFrozen(pocket)).toBe(true);
      expect(Object.isFrozen(pocket.vertices)).toBe(true);
      for (const point of pocket.vertices)
        expect(Object.isFrozen(point)).toBe(true);
    }
    for (const pocket of field.pockets) {
      expect(Object.isFrozen(pocket)).toBe(true);
      expect(Object.isFrozen(pocket.edges)).toBe(true);
      for (const edge of pocket.edges) {
        expect(Object.isFrozen(edge)).toBe(true);
        expect(Math.hypot(edge.nx, edge.nz)).toBeCloseTo(1, 14);
      }
    }
  });

  it("has exact axis-aligned support, authored core strength and continuous inner/outer fade boundaries", () => {
    const field = validateCompactHabitatComposition(rectangle(), bounds);
    for (const [x, z] of [
      [-10, -8],
      [10, 8],
      [-10, 0],
      [10, 0],
      [0, 8],
      [0, -8],
      [10.00001, 0],
      [-100, 0],
      [0, 100],
    ]) {
      expect(sampleCompactHabitatSoil(x, z, field)).toBe(0);
    }
    expect(sampleCompactHabitatSoil(0, 0, field)).toBe(0.6);
    expect(sampleCompactHabitatSoil(9, 0, field)).toBeCloseTo(0.3, 15);
    expect(sampleCompactHabitatSoil(8, 0, field)).toBe(0.6);
    for (const boundary of [8, 10]) {
      const epsilon = 1e-5;
      const left = sampleCompactHabitatSoil(boundary - epsilon, 0, field);
      const center = sampleCompactHabitatSoil(boundary, 0, field);
      const right = sampleCompactHabitatSoil(boundary + epsilon, 0, field);
      expect(Math.abs(left - center)).toBeLessThan(5e-11);
      expect(Math.abs(right - center)).toBeLessThan(5e-11);
      expect(Math.abs((right - left) / (2 * epsilon))).toBeLessThan(5e-6);
    }
  });

  it("matches the independent polygon reference and actual TSL over interiors, edges, vertices, overlap and outside", () => {
    const field = validateCompactHabitatComposition(descriptor(), bounds);
    const node = evaluateCompactHabitatSoil(
      attribute("worldX", "float"),
      attribute("worldZ", "float"),
      field,
      tsl,
    );
    let samples = 0;
    for (let x = -18; x <= 26; x += 0.5)
      for (let z = -13; z <= 22; z += 0.5) {
        const cpu = sampleCompactHabitatSoil(x, z, field);
        expect(cpu).toBeGreaterThanOrEqual(0);
        expect(cpu).toBeLessThanOrEqual(0.8);
        expect(cpu).toBeCloseTo(reference(x, z, field.descriptor), 13);
        expect(nodeValue(node, x, z)).toBe(cpu);
        samples++;
      }
    for (const pocket of field.descriptor.pockets) {
      const single = validateCompactHabitatComposition(
        { schemaVersion: 1, pockets: [pocket] },
        bounds,
      );
      const singleNode = evaluateCompactHabitatSoil(
        attribute("worldX", "float"),
        attribute("worldZ", "float"),
        single,
        tsl,
      );
      for (let index = 0; index < pocket.vertices.length; index++) {
        const a = pocket.vertices[index],
          b = pocket.vertices[(index + 1) % pocket.vertices.length];
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const x = a[0] + t * (b[0] - a[0]),
            z = a[1] + t * (b[1] - a[1]);
          expect(sampleCompactHabitatSoil(x, z, single)).toBeLessThan(1e-26);
          expect(nodeValue(singleNode, x, z)).toBe(
            sampleCompactHabitatSoil(x, z, single),
          );
          const nx = -(b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
          const nz = (b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
          expect(
            sampleCompactHabitatSoil(x - nx * 1e-6, z - nz * 1e-6, single),
          ).toBe(0);
        }
      }
    }
    expect(samples).toBe(6319);
  });

  it("uses strongest-pocket union rather than additive darkening and stays continuous where ownership changes", () => {
    const a = validateCompactHabitatComposition(
      { schemaVersion: 1, pockets: [first] },
      bounds,
    );
    const b = validateCompactHabitatComposition(
      { schemaVersion: 1, pockets: [second] },
      bounds,
    );
    const union = validateCompactHabitatComposition(descriptor(), bounds);
    let overlapSamples = 0;
    for (let x = -3; x <= 12; x += 0.25)
      for (let z = -3; z <= 12; z += 0.25) {
        const wa = sampleCompactHabitatSoil(x, z, a),
          wb = sampleCompactHabitatSoil(x, z, b);
        const weight = sampleCompactHabitatSoil(x, z, union);
        expect(weight).toBe(Math.max(wa, wb));
        if (wa > 0 && wb > 0) {
          expect(weight).toBeLessThan(wa + wb);
          overlapSamples++;
        }
        // MAX may have an internal derivative crease. Its values remain
        // continuous; do not mislabel the full field as globally C1 smooth.
        for (const direction of [-1, 1]) {
          expect(
            Math.abs(
              sampleCompactHabitatSoil(x + direction * 1e-6, z, union) - weight,
            ),
          ).toBeLessThanOrEqual(1e-6);
        }
      }
    expect(overlapSamples).toBeGreaterThan(1000);
  });

  it("retains field shape under translated/rotated explicit authoring bounds", () => {
    const original = validateCompactHabitatComposition(descriptor(), bounds);
    const angle = 0.73,
      c = Math.cos(angle),
      s = Math.sin(angle);
    const transform = ([x, z]: readonly number[]) => [
      320 + c * x - s * z,
      350 + s * x + c * z,
    ];
    const transformed = descriptor();
    for (const pocket of transformed.pockets)
      pocket.vertices = pocket.vertices.map(transform);
    const field = validateCompactHabitatComposition(transformed, {
      minX: 260,
      maxX: 380,
      minZ: 290,
      maxZ: 410,
    });
    for (let x = -20; x <= 25; x += 1)
      for (let z = -15; z <= 20; z += 1) {
        const p = transform([x, z]);
        expect(sampleCompactHabitatSoil(p[0], p[1], field)).toBeCloseTo(
          sampleCompactHabitatSoil(x, z, original),
          12,
        );
      }
  });

  it("retains zero absent-candidate behavior and refuses unadmitted compiled fields", () => {
    for (const field of [undefined, null]) {
      expect(sampleCompactHabitatSoil(320, 350, field)).toBe(0);
      expect(
        nodeValue(
          evaluateCompactHabitatSoil(
            attribute("worldX", "float"),
            attribute("worldZ", "float"),
            field,
            tsl,
          ),
          320,
          350,
        ),
      ).toBe(0);
    }
    const field = validateCompactHabitatComposition(descriptor(), bounds);
    const clone: CompactHabitatField = structuredClone(field);
    expect(() => sampleCompactHabitatSoil(0, 0, clone)).toThrow(
      "unadmitted field",
    );
    expect(() =>
      evaluateCompactHabitatSoil(float(0), float(0), clone, tsl),
    ).toThrow("unadmitted field");
    expect(() => sampleCompactHabitatSoil(Number.NaN, 0, field)).toThrow(
      "coordinate",
    );
    expect(() => sampleCompactHabitatSoil(0, Infinity, field)).toThrow(
      "coordinate",
    );
    expect(
      sampleCompactHabitatSoil(
        0,
        0,
        validateCompactHabitatComposition(clone.descriptor, clone.bounds),
      ),
    ).toBe(sampleCompactHabitatSoil(0, 0, field));
  });

  it("rejects malformed, out-of-bounds, duplicate, collinear, concave, clockwise and self-crossing authoring", () => {
    const invalid: unknown[] = [
      null,
      {},
      { schemaVersion: 2, pockets: [first] },
      { schemaVersion: 1, pockets: [] },
      { schemaVersion: 1, pockets: [first, second, { ...first, id: "third" }] },
      { ...descriptor(), unknown: true },
      { schemaVersion: 1, pockets: [first, first] },
    ];
    for (const change of [
      { edgeWidth: 1.99 },
      { edgeWidth: 4.01 },
      { strength: -0.01 },
      { strength: 1.01 },
      { strength: Infinity },
      { id: "" },
      { id: "BAD" },
      { unknown: true },
      {
        vertices: [
          [0, 0],
          [1, 0],
        ],
      },
      {
        vertices: [
          [0, 0],
          [5, 0],
          [5, 0],
          [0, 5],
        ],
      },
      {
        vertices: [
          [0, 0],
          [5, 0],
          [10, 0],
          [0, 5],
        ],
      },
      {
        vertices: [
          [0, 0],
          [0, 5],
          [5, 5],
          [5, 0],
        ],
      },
      {
        vertices: [
          [0, 0],
          [5, 0],
          [2, 2],
          [5, 5],
          [0, 5],
        ],
      },
      {
        vertices: [
          [0, 0],
          [5, 5],
          [0, 5],
          [5, 0],
        ],
      },
      {
        vertices: [
          [-41, 0],
          [5, 0],
          [5, 5],
        ],
      },
      {
        vertices: [
          [0, Number.NaN],
          [5, 0],
          [5, 5],
        ],
      },
      {
        vertices: [
          [0, 0, 1],
          [5, 0],
          [5, 5],
        ],
      },
    ])
      invalid.push({ schemaVersion: 1, pockets: [{ ...first, ...change }] });
    // A pentagram can retain same-sign local turns; pairwise nonadjacent
    // edge admission must reject it independently of local convexity tests.
    const pentagon = Array.from({ length: 5 }, (_, i) => [
      10 * Math.cos((i * Math.PI * 2) / 5),
      10 * Math.sin((i * Math.PI * 2) / 5),
    ]);
    invalid.push({
      schemaVersion: 1,
      pockets: [
        {
          ...first,
          vertices: [
            pentagon[0],
            pentagon[2],
            pentagon[4],
            pentagon[1],
            pentagon[3],
          ],
        },
      ],
    });
    for (const source of invalid)
      expect(() => validateCompactHabitatComposition(source, bounds)).toThrow(
        "Invalid compact habitat",
      );
    for (const changed of [
      { ...bounds, minX: 40 },
      { ...bounds, maxZ: Infinity },
      { ...bounds, extra: true },
    ])
      expect(() =>
        validateCompactHabitatComposition(descriptor(), changed),
      ).toThrow("Invalid compact habitat");
  });

  it("rejects accessors, sparse arrays, extra array fields and custom prototypes without reading getters", () => {
    let reads = 0;
    const getter = {
      schemaVersion: 1,
      get pockets() {
        reads++;
        return [first];
      },
    };
    expect(() => validateCompactHabitatComposition(getter, bounds)).toThrow(
      "fields",
    );
    const point = [0, 0];
    Object.defineProperty(point, "0", {
      get: () => {
        reads++;
        return 0;
      },
    });
    expect(() =>
      validateCompactHabitatComposition(
        {
          schemaVersion: 1,
          pockets: [{ ...first, vertices: [point, [10, 0], [0, 10]] }],
        },
        bounds,
      ),
    ).toThrow("element");
    const sparse = [first, second];
    delete sparse[0];
    expect(() =>
      validateCompactHabitatComposition(
        { schemaVersion: 1, pockets: sparse },
        bounds,
      ),
    ).toThrow();
    const extra = [first];
    Object.defineProperty(extra, "extra", { value: true });
    expect(() =>
      validateCompactHabitatComposition(
        { schemaVersion: 1, pockets: extra },
        bounds,
      ),
    ).toThrow();
    const custom = Object.assign(
      Object.create({ inherited: true }),
      descriptor(),
    ) as unknown;
    expect(() => validateCompactHabitatComposition(custom, bounds)).toThrow();
    expect(reads).toBe(0);
  });
});
