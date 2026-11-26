import { describe, expect, it } from "vitest";
import THREE from "../../../extras/three/three";
import {
  CONFORMING_WATER_GRID_LIMITS,
  createConformingWaterGrid,
  type ConformingWaterGrid,
  type ConformingWaterGridInput,
  type WaterGridSide,
} from "./ConformingWaterGrid";

const sides: readonly WaterGridSide[] = ["minX", "maxX", "minZ", "maxZ"];
const range = (min: number, max: number, step: number): number[] =>
  Array.from({ length: (max - min) / step + 1 }, (_, i) => min + i * step);

function input(
  minX = 0,
  minZ = 0,
  spacing = 12.5,
  edgeSpacing: Partial<Record<WaterGridSide, number>> = {},
  originX = 0,
  originZ = 0,
): ConformingWaterGridInput {
  const maxX = minX + 25;
  const maxZ = minZ + 25;
  return {
    bounds: { minX, maxX, minZ, maxZ },
    spacing,
    lattice: { originX, originZ, spacing: 3.125 },
    edges: {
      minX: range(minZ, maxZ, edgeSpacing.minX ?? spacing),
      maxX: range(minZ, maxZ, edgeSpacing.maxX ?? spacing),
      minZ: range(minX, maxX, edgeSpacing.minZ ?? spacing),
      maxZ: range(minX, maxX, edgeSpacing.maxZ ?? spacing),
    },
  };
}

function point(grid: ConformingWaterGrid, index: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(
    grid.geometry.getAttribute("position"),
    index,
  );
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Independent triangle/edge audit of the actual Three BufferGeometry. */
function audit(
  grid: ConformingWaterGrid,
  spec: ConformingWaterGridInput,
): void {
  const geometry = grid.geometry;
  expect(geometry).toBeInstanceOf(THREE.BufferGeometry);
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const indices = geometry.getIndex()!;
  expect(positions.array).toBeInstanceOf(Float32Array);
  expect(
    indices.array instanceof Uint16Array ||
      indices.array instanceof Uint32Array,
  ).toBe(true);
  expect(positions.count).toBe(
    grid.counts.baseVertices +
      grid.counts.addedEdgeVertices +
      grid.counts.transitionCells,
  );
  expect(indices.count).toBe(3 * grid.counts.triangles);
  expect(grid.counts.triangles).toBe(
    2 * grid.counts.cells +
      2 * grid.counts.transitionCells +
      grid.counts.addedEdgeVertices,
  );
  const used = new Set<number>();
  const incidences = new Map<string, number>();
  let area = 0;
  for (let i = 0; i < indices.count; i += 3) {
    const ids = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(Number.isInteger(id) && id >= 0 && id < positions.count).toBe(
        true,
      );
      used.add(id);
    }
    const triangle = new THREE.Triangle(
      ...(ids.map((id) => point(grid, id)) as [
        THREE.Vector3,
        THREE.Vector3,
        THREE.Vector3,
      ]),
    );
    const normal = triangle.getNormal(new THREE.Vector3());
    // Cross products can produce -0 on horizontal axes; it is the same exact
    // geometric normal, not a tolerance or permission for reversed winding.
    expect(normal.x === 0 && normal.y === 1 && normal.z === 0).toBe(true);
    expect(triangle.getArea()).toBeGreaterThan(0);
    area += triangle.getArea();
    for (let j = 0; j < 3; j++) {
      const key = edgeKey(ids[j], ids[(j + 1) % 3]);
      incidences.set(key, (incidences.get(key) ?? 0) + 1);
    }
  }
  expect(used.size).toBe(positions.count);
  expect(area).toBe(
    (spec.bounds.maxX - spec.bounds.minX) *
      (spec.bounds.maxZ - spec.bounds.minZ),
  );
  const boundary = new Set<string>();
  for (const side of sides) {
    const edge = grid.edges[side];
    expect(edge.length).toBe(spec.edges[side].length);
    const onX = side === "minX" || side === "maxX";
    for (let i = 0; i < edge.length; i++) {
      const p = point(grid, edge[i]);
      expect(onX ? p.z : p.x).toBe(spec.edges[side][i]);
      expect(onX ? p.x : p.z).toBe(spec.bounds[side]);
      if (i > 0) boundary.add(edgeKey(edge[i - 1], edge[i]));
    }
  }
  for (const [key, count] of incidences)
    expect(count).toBe(boundary.has(key) ? 1 : 2);
  for (const key of boundary) expect(incidences.get(key)).toBe(1);
  for (let i = 0; i < positions.count; i++) {
    const p = point(grid, i);
    expect(p.y).toBe(0);
    expect(p.x >= spec.bounds.minX && p.x <= spec.bounds.maxX).toBe(true);
    expect(p.z >= spec.bounds.minZ && p.z <= spec.bounds.maxZ).toBe(true);
    expect(p.toArray().every(Number.isFinite)).toBe(true);
    expect([normals.getX(i), normals.getY(i), normals.getZ(i)]).toEqual([
      0, 1, 0,
    ]);
    expect(uv.getX(i) >= 0 && uv.getX(i) <= 1).toBe(true);
    expect(uv.getY(i) >= 0 && uv.getY(i) <= 1).toBe(true);
  }
  expect(geometry.boundingBox!.min.toArray()).toEqual([
    spec.bounds.minX,
    0,
    spec.bounds.minZ,
  ]);
  expect(geometry.boundingBox!.max.toArray()).toEqual([
    spec.bounds.maxX,
    0,
    spec.bounds.maxZ,
  ]);
}

type Point2 = { x: number; z: number };
const cross = (a: Point2, b: Point2, c: Point2): number =>
  (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);

/** Convex clipping, independent of the grid's fan construction. */
function intersectionArea(first: Point2[], second: Point2[]): number {
  let polygon = first;
  for (let i = 0; i < second.length && polygon.length; i++) {
    const a = second[i],
      b = second[(i + 1) % second.length];
    const next: Point2[] = [];
    for (let j = 0; j < polygon.length; j++) {
      const p = polygon[j],
        q = polygon[(j + 1) % polygon.length];
      const cp = cross(a, b, p),
        cq = cross(a, b, q);
      if (cp >= 0) next.push(p);
      if ((cp < 0 && cq > 0) || (cp > 0 && cq < 0)) {
        const t = cp / (cp - cq);
        next.push({ x: p.x + t * (q.x - p.x), z: p.z + t * (q.z - p.z) });
      }
    }
    polygon = next;
  }
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i],
      q = polygon[(i + 1) % polygon.length];
    twiceArea += p.x * q.z - q.x * p.z;
  }
  return Math.abs(twiceArea) / 2;
}

function assertNoOverlap(grid: ConformingWaterGrid): void {
  const index = grid.geometry.getIndex()!;
  const triangles: Point2[][] = [];
  for (let i = 0; i < index.count; i += 3)
    triangles.push([0, 1, 2].map((j) => point(grid, index.getX(i + j))));
  for (let i = 0; i < triangles.length; i++)
    for (let j = i + 1; j < triangles.length; j++)
      expect(intersectionArea(triangles[i], triangles[j])).toBeLessThan(1e-8);
}

function sharedEdge(
  a: ConformingWaterGrid,
  sideA: WaterGridSide,
  b: ConformingWaterGrid,
  sideB: WaterGridSide,
): void {
  const first = new Float32Array(
    Array.from(a.edges[sideA]).flatMap((id) => point(a, id).toArray()),
  );
  const second = new Float32Array(
    Array.from(b.edges[sideB]).flatMap((id) => point(b, id).toArray()),
  );
  expect(new Uint8Array(first.buffer)).toEqual(new Uint8Array(second.buffer));
}

function assertJoinedXEdge(
  grids: readonly ConformingWaterGrid[],
  x: number,
  expectedZ: readonly number[],
): void {
  const incidences = new Map<string, number>();
  for (const grid of grids) {
    const index = grid.geometry.getIndex()!;
    for (let i = 0; i < index.count; i += 3) {
      for (let j = 0; j < 3; j++) {
        const a = point(grid, index.getX(i + j));
        const b = point(grid, index.getX(i + ((j + 1) % 3)));
        if (a.x !== x || b.x !== x) continue;
        const key = `${Math.min(a.z, b.z)}:${Math.max(a.z, b.z)}`;
        incidences.set(key, (incidences.get(key) ?? 0) + 1);
      }
    }
  }
  expect(incidences.size).toBe(expectedZ.length - 1);
  for (let i = 1; i < expectedZ.length; i++)
    expect(incidences.get(`${expectedZ[i - 1]}:${expectedZ[i]}`)).toBe(2);
}

describe("inert conforming world-space water grid", () => {
  it("keeps an ordinary 12.5 m grid at two +Y triangles per cell", () => {
    const spec = input();
    const grid = createConformingWaterGrid(spec);
    try {
      audit(grid, spec);
      expect(grid.geometry.getIndex()!.array).toBeInstanceOf(Uint16Array);
      expect(grid.counts).toEqual({
        cells: 4,
        baseVertices: 9,
        addedEdgeVertices: 0,
        transitionCells: 0,
        triangles: 8,
      });
      assertNoOverlap(grid);
    } finally {
      grid.geometry.dispose();
    }
  });

  it("uses Uint32 only when the bounded grid requires it", () => {
    const segments = CONFORMING_WATER_GRID_LIMITS.maxSegmentsPerAxis;
    const end = segments * 12.5;
    const coordinates = range(0, end, 12.5);
    const grid = createConformingWaterGrid({
      bounds: { minX: 0, maxX: end, minZ: 0, maxZ: end },
      spacing: 12.5,
      lattice: { originX: 0, originZ: 0, spacing: 3.125 },
      edges: {
        minX: coordinates,
        maxX: coordinates,
        minZ: coordinates,
        maxZ: coordinates,
      },
    });
    try {
      expect(grid.geometry.getIndex()!.array).toBeInstanceOf(Uint32Array);
      expect(grid.geometry.getAttribute("position").count).toBe(
        (segments + 1) ** 2,
      );
      expect(grid.geometry.getIndex()!.count).toBe(segments ** 2 * 6);
      expect(grid.counts.transitionCells).toBe(0);
    } finally {
      grid.geometry.dispose();
    }
  });

  it.each([
    [0, 0],
    [-350, -400],
    [1000.125, -600.375],
  ])(
    "shares exact Float32 edges between 12.5 and 6.25 m grids at root %s,%s",
    (rootX, rootZ) => {
      const coarseSpec = input(
        rootX,
        rootZ,
        12.5,
        { maxX: 6.25 },
        rootX,
        rootZ,
      );
      const fineSpec = input(rootX + 25, rootZ, 6.25, {}, rootX, rootZ);
      const coarse = createConformingWaterGrid(coarseSpec);
      const fine = createConformingWaterGrid(fineSpec);
      try {
        audit(coarse, coarseSpec);
        audit(fine, fineSpec);
        sharedEdge(coarse, "maxX", fine, "minX");
        assertJoinedXEdge([coarse, fine], rootX + 25, coarseSpec.edges.maxX);
        expect(coarse.counts).toEqual({
          cells: 4,
          baseVertices: 9,
          addedEdgeVertices: 2,
          transitionCells: 2,
          triangles: 14,
        });
        assertNoOverlap(coarse);
      } finally {
        coarse.geometry.dispose();
        fine.geometry.dispose();
      }
    },
  );

  it("joins one coarse leaf to two smaller fine leaves with no long seam edge", () => {
    const coarseSpec = input(0, 0, 12.5, { maxX: 6.25 });
    const fineSpecs = [0, 12.5].map((minZ): ConformingWaterGridInput => ({
      bounds: { minX: 25, maxX: 37.5, minZ, maxZ: minZ + 12.5 },
      spacing: 6.25,
      lattice: coarseSpec.lattice,
      edges: {
        minX: range(minZ, minZ + 12.5, 6.25),
        maxX: range(minZ, minZ + 12.5, 6.25),
        minZ: [25, 31.25, 37.5],
        maxZ: [25, 31.25, 37.5],
      },
    }));
    const specs = [coarseSpec, ...fineSpecs];
    const grids = specs.map(createConformingWaterGrid);
    try {
      grids.forEach((grid, i) => audit(grid, specs[i]));
      assertJoinedXEdge(grids, 25, coarseSpec.edges.maxX);
      sharedEdge(grids[1], "maxZ", grids[2], "minZ");
    } finally {
      grids.forEach((grid) => grid.geometry.dispose());
    }
  });

  it("triangulates mixed refinements on all four sides and corners without overlaps", () => {
    const spec = input(-25, -25, 12.5, {
      minX: 6.25,
      maxX: 3.125,
      minZ: 3.125,
      maxZ: 6.25,
    });
    const grid = createConformingWaterGrid(spec);
    try {
      audit(grid, spec);
      expect(grid.counts.transitionCells).toBe(4);
      assertNoOverlap(grid);
      expect(grid.edges.minX[0]).toBe(grid.edges.minZ[0]);
      expect(grid.edges.maxX.at(-1)).toBe(grid.edges.maxZ.at(-1));
      expect(grid.edges.minX.at(-1)).toBe(grid.edges.maxZ[0]);
      expect(grid.edges.maxX[0]).toBe(grid.edges.minZ.at(-1));
    } finally {
      grid.geometry.dispose();
    }
  });

  it("preserves interior cells and supports nonuniform ordered edge subdivisions", () => {
    const spec = input(0, 0, 6.25);
    const irregular = {
      ...spec,
      edges: { ...spec.edges, minX: [0, 3.125, 6.25, 12.5, 15.625, 18.75, 25] },
    };
    const grid = createConformingWaterGrid(irregular);
    try {
      audit(grid, irregular);
      expect(grid.counts.transitionCells).toBe(2);
      assertNoOverlap(grid);
    } finally {
      grid.geometry.dispose();
    }
  });

  it("returns detached deterministic buffers and edge lists", () => {
    const spec = input(0, 0, 12.5, { minX: 6.25, maxZ: 6.25 });
    const first = createConformingWaterGrid(spec),
      second = createConformingWaterGrid(spec);
    try {
      expect(first.geometry.getAttribute("position").array).toEqual(
        second.geometry.getAttribute("position").array,
      );
      expect(first.geometry.getIndex()!.array).toEqual(
        second.geometry.getIndex()!.array,
      );
      expect(first.geometry.getAttribute("position").array).not.toBe(
        second.geometry.getAttribute("position").array,
      );
      expect(first.edges.minX).not.toBe(second.edges.minX);
      const original = point(first, first.edges.minX[1]);
      (spec.edges.minX as number[])[1] = 99;
      expect(point(first, first.edges.minX[1])).toEqual(original);
      first.edges.minX[1] = 0;
      expect(second.edges.minX[1]).not.toBe(0);
    } finally {
      first.geometry.dispose();
      second.geometry.dispose();
    }
  });

  it.each([
    ["duplicate", [0, 6.25, 6.25, 12.5, 25]],
    ["descending", [0, 12.5, 6.25, 25]],
    ["missing native point", [0, 6.25, 25]],
    ["missing start", [6.25, 12.5, 25]],
    ["missing end", [0, 12.5, 18.75]],
    ["off lattice", [0, 1, 12.5, 25]],
    ["NaN", [0, NaN, 12.5, 25]],
    ["infinite", [0, 12.5, Infinity, 25]],
  ] as const)("rejects %s edge data", (_name, edge) => {
    const spec = input();
    expect(() =>
      createConformingWaterGrid({
        ...spec,
        edges: { ...spec.edges, minX: edge },
      }),
    ).toThrow(RangeError);
  });

  it("rejects missing/oversized edge lists before geometry construction", () => {
    const spec = input();
    for (const edge of [
      undefined,
      [],
      new Array(CONFORMING_WATER_GRID_LIMITS.maxEdgeVertices + 1).fill(0),
    ])
      expect(() =>
        createConformingWaterGrid({
          ...spec,
          edges: { ...spec.edges, minX: edge as unknown as number[] },
        }),
      ).toThrow(RangeError);
  });

  it.each([0, -1, NaN, Infinity, 1, 0.1, 50])(
    "rejects invalid native pitch %s",
    (spacing) => {
      expect(() => createConformingWaterGrid({ ...input(), spacing })).toThrow(
        RangeError,
      );
    },
  );

  it("rejects invalid, unbounded and imprecise domains/lattices", () => {
    const spec = input();
    const invalid = [
      { ...spec, bounds: { ...spec.bounds, minX: 25 } },
      { ...spec, bounds: { ...spec.bounds, maxX: 25.5 } },
      { ...spec, bounds: { ...spec.bounds, maxX: 12.5 * 257 } },
      { ...spec, bounds: { ...spec.bounds, maxX: Infinity } },
      { ...spec, lattice: { ...spec.lattice, originX: 1 } },
      { ...spec, lattice: { ...spec.lattice, spacing: 0 } },
      { ...spec, lattice: { ...spec.lattice, spacing: -3.125 } },
      { ...spec, lattice: { ...spec.lattice, spacing: NaN } },
      input(2 ** 28, 0, 12.5),
    ];
    for (const candidate of invalid)
      expect(() => createConformingWaterGrid(candidate)).toThrow(RangeError);
  });

  it("rejects a transition-cell center that would round despite exact edge positions", () => {
    const x = 2 ** 24;
    const spec: ConformingWaterGridInput = {
      bounds: { minX: x, maxX: x + 2, minZ: 0, maxZ: 2 },
      spacing: 2,
      lattice: { originX: x, originZ: 0, spacing: 1 },
      edges: {
        minX: [0, 1, 2],
        maxX: [0, 2],
        minZ: [x, x + 2],
        maxZ: [x, x + 2],
      },
    };
    expect(() => createConformingWaterGrid(spec)).toThrow(/Float32/);
  });
});
