import { describe, expect, it } from "vitest";
import {
  CONFORMING_WATER_EDGE_PLAN_LIMITS,
  createConformingWaterEdgePlan,
  type ConformingWaterEdgePlanInput,
  type ConformingWaterLeaf,
} from "./ConformingWaterEdgePlan";
import { TerrainQuadTree } from "./TerrainQuadTree";

const root = { centerX: 0, centerZ: 0, size: 100 };
const rootLeaf: ConformingWaterLeaf = { ...root, id: 1, depth: 0, spacing: 25 };
const lattice = { originX: -50, originZ: -50, spacing: 3.125 };
const spec = (
  leaves: readonly ConformingWaterLeaf[],
): ConformingWaterEdgePlanInput => ({ root, lattice, leaves });
function split(
  leaves: readonly ConformingWaterLeaf[],
  id: number,
): ConformingWaterLeaf[] {
  return leaves.flatMap((leaf) =>
    leaf.id !== id
      ? [leaf]
      : [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ].map(([x, z], i) => ({
          id: leaf.id * 4 + i,
          depth: leaf.depth + 1,
          size: leaf.size / 2,
          centerX: leaf.centerX + (x * leaf.size) / 4,
          centerZ: leaf.centerZ + (z * leaf.size) / 4,
          spacing: leaf.spacing / 2,
        })),
  );
}
const initial = () => split([rootLeaf], 1);
const sides = ["minX", "maxX", "minZ", "maxZ"] as const;
type Plan = ReturnType<typeof createConformingWaterEdgePlan>;

/** Independent complete segment incidence, not the planner's interval join. */
function audit(plan: Plan, input: ConformingWaterEdgePlanInput): void {
  const segments = new Map<string, { count: number; outer: boolean }>();
  let coordinates = 0;
  for (const leaf of plan.leaves) {
    expect(Object.isFrozen(leaf)).toBe(true);
    for (const side of sides) {
      const edge = leaf.edges[side],
        onX = side === "minX" || side === "maxX";
      expect(Object.isFrozen(edge)).toBe(true);
      const start = onX ? leaf.bounds.minZ : leaf.bounds.minX;
      const end = onX ? leaf.bounds.maxZ : leaf.bounds.maxX;
      expect(edge[0]).toBe(start);
      expect(edge.at(-1)).toBe(end);
      for (let at = start; at <= end; at += leaf.spacing)
        expect(edge).toContain(at);
      coordinates += edge.length;
      for (let i = 1; i < edge.length; i++) {
        expect(edge[i]).toBeGreaterThan(edge[i - 1]);
        expect(Math.fround(edge[i])).toBe(edge[i]);
        const fixed = leaf.bounds[side];
        const center = onX ? input.root.centerX : input.root.centerZ;
        const outer =
          fixed === center - input.root.size / 2 ||
          fixed === center + input.root.size / 2;
        const key = `${onX ? "x" : "z"}:${fixed}:${edge[i - 1]}:${edge[i]}`;
        const existing = segments.get(key);
        if (existing) existing.count++;
        else segments.set(key, { count: 1, outer });
      }
    }
  }
  for (const row of segments.values())
    expect(row.count).toBe(row.outer ? 1 : 2);
  expect(coordinates).toBe(plan.counts.plannedEdgeCoordinates);
  expect(plan.counts.plannedEdgeCoordinates).toBeLessThanOrEqual(
    CONFORMING_WATER_EDGE_PLAN_LIMITS.maxEdgeCoordinates,
  );
  expect(plan.counts.partitionNodes).toBeLessThanOrEqual(
    1 + input.leaves.length * CONFORMING_WATER_EDGE_PLAN_LIMITS.maxDepth,
  );
  // Area is an additional independent check; prefix coverage is not assumed.
  expect(
    plan.leaves.reduce(
      (area, leaf) =>
        area +
        (leaf.bounds.maxX - leaf.bounds.minX) *
          (leaf.bounds.maxZ - leaf.bounds.minZ),
      0,
    ),
  ).toBe(input.root.size ** 2);
}

describe("inert complete-partition water edge planning", () => {
  it("keeps a single root's complete native outer edges", () => {
    const input = spec([rootLeaf]),
      plan = createConformingWaterEdgePlan(input);
    audit(plan, input);
    expect(plan.counts).toEqual({
      leaves: 1,
      partitionNodes: 1,
      sharedIntervals: 0,
      nativeEdgeCoordinates: 20,
      plannedEdgeCoordinates: 20,
    });
    expect(plan.leaves[0].edges.minX).toEqual([-50, -25, 0, 25, 50]);
  });

  it("joins an entire mixed-depth partition, including one-to-many dyadic neighbors", () => {
    const input = spec(split(split(initial(), 5), 20));
    const plan = createConformingWaterEdgePlan(input);
    audit(plan, input);
    const coarse = plan.leaves.find((leaf) => leaf.id === 4)!;
    expect(coarse.edges.maxX).toEqual([
      -50, -46.875, -43.75, -40.625, -37.5, -34.375, -31.25, -28.125, -25,
      -18.75, -12.5, -6.25, 0,
    ]);
    expect(plan.counts.plannedEdgeCoordinates).toBeGreaterThan(
      plan.counts.nativeEdgeCoordinates,
    );
  });

  it("split then merge restores the exact plans, independent of input order", () => {
    const before = createConformingWaterEdgePlan(spec(initial()));
    const splitLeaves = split(initial(), 5);
    const during = createConformingWaterEdgePlan(spec(splitLeaves));
    audit(during, spec(splitLeaves));
    const merged = [
      ...splitLeaves.filter((leaf) => leaf.depth === 1),
      initial().find((leaf) => leaf.id === 5)!,
    ].reverse();
    expect(createConformingWaterEdgePlan(spec(merged))).toEqual(before);
    expect(
      createConformingWaterEdgePlan(spec([...splitLeaves].reverse())),
    ).toEqual(during);
  });

  it.each([
    [0, 0],
    [-350, -400],
    [1000.125, -600.375],
  ])("retains exact translated Float32 plans at %s,%s", (x, z) => {
    const leaves = split(initial(), 5).map((leaf) => ({
      ...leaf,
      centerX: leaf.centerX + x,
      centerZ: leaf.centerZ + z,
    }));
    const input = {
      root: { ...root, centerX: x, centerZ: z },
      lattice: { ...lattice, originX: x - 50, originZ: z - 50 },
      leaves,
    };
    audit(createConformingWaterEdgePlan(input), input);
  });

  it("owns frozen detached plans and never mutates borrowed descriptors", () => {
    const input = structuredClone(spec(split(initial(), 5)));
    const saved = structuredClone(input),
      plan = createConformingWaterEdgePlan(input);
    expect(input).toEqual(saved);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.leaves)).toBe(true);
    expect(Object.isFrozen(plan.counts)).toBe(true);
    expect(Object.isFrozen(plan.leaves[0].lattice)).toBe(true);
    expect(Object.isFrozen(plan.leaves[0].bounds)).toBe(true);
    expect(Object.isFrozen(plan.leaves[0].edges)).toBe(true);
    const again = createConformingWaterEdgePlan(input);
    expect(again).toEqual(plan);
    expect(again.leaves[0].edges.minX).not.toBe(plan.leaves[0].edges.minX);
    expect(() => (plan.leaves[0].edges.minX as number[]).push(123)).toThrow(
      TypeError,
    );
  });

  it("uses the actual tree's initial complete terrain partition, not water classification", () => {
    const tree = new TerrainQuadTree({
      minSize: 25,
      maxDepth: 2,
      rootChunkRadius: 0,
    });
    try {
      tree.update(0, 0);
      const nodes = tree.getFinalNodes();
      const input = spec(
        nodes.map((node) => ({
          id: node.id,
          depth: node.depth,
          centerX: node.centerX,
          centerZ: node.centerZ,
          size: node.size,
          spacing: node.size / 4,
        })),
      );
      const plan = createConformingWaterEdgePlan(input);
      audit(plan, input);
      expect(plan.leaves).toHaveLength(nodes.length);
      // Dry/wet eligibility is deliberately absent. Omitting even one alleged
      // dry leaf would turn the geometry ownership partition into a hole.
      expect(() =>
        createConformingWaterEdgePlan({
          ...input,
          leaves: input.leaves.slice(1),
        }),
      ).toThrow(/hole/);
    } finally {
      tree.dispose();
    }
  });

  it.each([false, true])(
    "rejects retiring parent/child overlap in either order (%s)",
    (reverse) => {
      const leaves = [rootLeaf, ...initial()];
      expect(() =>
        createConformingWaterEdgePlan(
          spec(reverse ? leaves.reverse() : leaves),
        ),
      ).toThrow(/overlapping/);
    },
  );

  it("rejects a coverage hole, duplicate ID, duplicate owner, and misaligned T junction", () => {
    expect(() =>
      createConformingWaterEdgePlan(spec(initial().slice(1))),
    ).toThrow(/hole/);
    expect(() =>
      createConformingWaterEdgePlan(spec([...initial(), initial()[0]])),
    ).toThrow(/unique/);
    expect(() =>
      createConformingWaterEdgePlan(
        spec([...initial(), { ...initial()[0], id: 1000 }]),
      ),
    ).toThrow(/overlapping/);
    const shifted = initial().map((leaf, i) =>
      i === 0 ? { ...leaf, centerZ: leaf.centerZ + 3.125 } : leaf,
    );
    expect(() => createConformingWaterEdgePlan(spec(shifted))).toThrow(
      /misaligned/,
    );
  });

  it.each([
    { id: -1 },
    { id: NaN },
    { depth: -1 },
    { depth: 17 },
    { depth: 0.5 },
    { size: 25 },
    { centerX: Infinity },
    { centerX: 0.1 },
    { centerX: 75 },
    { spacing: 0 },
    { spacing: 0.1 },
    { spacing: 9.375 },
  ])("rejects malformed leaf fields %j", (change) => {
    expect(() =>
      createConformingWaterEdgePlan(
        spec(
          initial().map((leaf, i) => (i === 0 ? { ...leaf, ...change } : leaf)),
        ),
      ),
    ).toThrow(RangeError);
  });

  it("rejects missing, excessive and non-dyadic root/lattice inputs", () => {
    for (const input of [
      spec([]),
      spec(new Array(1025).fill(rootLeaf)),
      { ...spec([rootLeaf]), root: { ...root, size: 0 } },
      { ...spec([rootLeaf]), lattice: { ...lattice, originX: 1 } },
      { ...spec([rootLeaf]), lattice: { ...lattice, spacing: 0 } },
      { ...spec([rootLeaf]), lattice: { ...lattice, spacing: 1 } },
      { ...spec([rootLeaf]), lattice: { ...lattice, spacing: 0.000001 } },
    ])
      expect(() => createConformingWaterEdgePlan(input)).toThrow(RangeError);
  });

  it("rejects an imprecise transition center even when all leaf bounds are Float32", () => {
    const x = 2 ** 24;
    const base: ConformingWaterLeaf = {
      id: 1,
      depth: 0,
      centerX: x,
      centerZ: 0,
      size: 8,
      spacing: 4,
    };
    const leaves = split([base], 1).map((leaf) =>
      leaf.id === 4 ? { ...leaf, spacing: 1 } : leaf,
    );
    expect(() =>
      createConformingWaterEdgePlan({
        root: base,
        lattice: { originX: x - 4, originZ: -4, spacing: 1 },
        leaves,
      }),
    ).toThrow(/Float32/);
  });

  it("bounds a complete 1024-leaf plan without a finest-cell raster", () => {
    const leaves: ConformingWaterLeaf[] = [];
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++)
        leaves.push({
          id: z * 32 + x,
          depth: 5,
          centerX: -50 + (x + 0.5) * 3.125,
          centerZ: -50 + (z + 0.5) * 3.125,
          size: 3.125,
          spacing: 3.125,
        });
    const input = {
      ...spec(leaves),
      lattice: { ...lattice, spacing: 0.09765625 },
    };
    const plan = createConformingWaterEdgePlan(input);
    expect(plan.counts).toEqual({
      leaves: 1024,
      partitionNodes: 1365,
      sharedIntervals: 1984,
      nativeEdgeCoordinates: 8192,
      plannedEdgeCoordinates: 8192,
    });
    expect(() =>
      createConformingWaterEdgePlan({
        ...input,
        lattice: { ...lattice, spacing: 3.125 / 256 },
        leaves: leaves.map((leaf) => ({ ...leaf, spacing: 3.125 / 256 })),
      }),
    ).toThrow(/budget/);
  });

  it("rejects a fine boundary union exceeding the per-edge cap", () => {
    let leaves = initial();
    for (let level = 1; level <= 5; level++) {
      const ids = leaves
        .filter(
          (leaf) =>
            leaf.depth === level &&
            leaf.centerX - leaf.size / 2 === 0 &&
            leaf.centerZ < 0,
        )
        .map((leaf) => leaf.id);
      for (const id of ids) leaves = split(leaves, id);
    }
    const input = {
      ...spec(leaves.map((leaf) => ({ ...leaf, spacing: leaf.size / 256 }))),
      lattice: { ...lattice, spacing: 100 / 16384 },
    };
    expect(() => createConformingWaterEdgePlan(input)).toThrow(/budget/);
  });
});
