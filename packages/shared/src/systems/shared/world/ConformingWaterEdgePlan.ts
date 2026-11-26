import {
  CONFORMING_WATER_GRID_LIMITS,
  type ConformingWaterGridInput,
  type WaterGridSide,
} from "./ConformingWaterGrid";
import type { TerrainQuadNode } from "./TerrainQuadTree";

export type ConformingWaterLeaf = Readonly<
  Pick<TerrainQuadNode, "id" | "depth" | "centerX" | "centerZ" | "size"> & {
    /** Explicit water pitch, not terrain resolution or an inferred LOD. */
    spacing: number;
  }
>;
export type ConformingWaterEdgePlanInput = Readonly<{
  root: Readonly<Pick<TerrainQuadNode, "centerX" | "centerZ" | "size">>;
  lattice: ConformingWaterGridInput["lattice"];
  leaves: readonly ConformingWaterLeaf[];
}>;
export type ConformingWaterLeafPlan = ConformingWaterGridInput &
  Readonly<{ id: number; depth: number }>;

export const CONFORMING_WATER_EDGE_PLAN_LIMITS = Object.freeze({
  maxLeaves: 1024,
  maxDepth: 16,
  maxRootLatticeIntervals: 1048576,
  maxEdgeCoordinates: 262144,
});

type PartitionNode = {
  leaf: boolean;
  children: Map<number, PartitionNode>;
};
type Edge = {
  leaf: number;
  side: WaterGridSide;
  start: number;
  end: number;
  stride: number;
  coordinates: Set<number>;
  covered: number;
};
type Line = { negative: Edge[]; positive: Edge[] };

/**
 * Plans ONE complete terrain-root partition, including classified dry leaves.
 * It neither classifies water nor selects the live/staged partition. In
 * particular, TerrainQuadTree.getFinalNodes() can contain overlapping retiring
 * parents/children during transitions; those inputs deliberately fail closed.
 *
 * Prefix coverage rejects holes/overlaps without a finest-cell raster. Sorted
 * opposite edge intervals then union their native vertices. No geometry, mesh,
 * callback, borrowed-array mutation, or neighbor-cache mutation occurs here.
 */
export function createConformingWaterEdgePlan(
  input: ConformingWaterEdgePlanInput,
): Readonly<{
  leaves: readonly ConformingWaterLeafPlan[];
  counts: Readonly<{
    leaves: number;
    partitionNodes: number;
    sharedIntervals: number;
    nativeEdgeCoordinates: number;
    plannedEdgeCoordinates: number;
  }>;
}> {
  const limits = CONFORMING_WATER_EDGE_PLAN_LIMITS;
  const exact = (value: number): number => {
    if (!Number.isFinite(value) || Math.fround(value) !== value)
      throw new RangeError(
        "Water edge plan requires exact finite Float32 coordinates",
      );
    return value === 0 ? 0 : value;
  };
  const root = {
    centerX: exact(input.root.centerX),
    centerZ: exact(input.root.centerZ),
    size: exact(input.root.size),
  };
  const lattice = Object.freeze({
    originX: exact(input.lattice.originX),
    originZ: exact(input.lattice.originZ),
    spacing: exact(input.lattice.spacing),
  });
  if (root.size <= 0 || lattice.spacing <= 0)
    throw new RangeError("Water edge plan requires positive root and lattice");
  const index = (value: number, origin: number): number => {
    exact(value);
    const result = (value - origin) / lattice.spacing;
    if (
      !Number.isSafeInteger(result) ||
      origin + result * lattice.spacing !== value
    )
      throw new RangeError("Water edge plan coordinate is off lattice");
    return result;
  };
  const rootX = index(root.centerX - root.size / 2, lattice.originX);
  const rootZ = index(root.centerZ - root.size / 2, lattice.originZ);
  const endX = index(root.centerX + root.size / 2, lattice.originX);
  const endZ = index(root.centerZ + root.size / 2, lattice.originZ);
  const span = root.size / lattice.spacing;
  if (
    !Number.isSafeInteger(span) ||
    span < 1 ||
    span > limits.maxRootLatticeIntervals ||
    !Number.isInteger(Math.log2(span)) ||
    endX - rootX !== span ||
    endZ - rootZ !== span
  )
    throw new RangeError(
      "Water edge plan requires a bounded dyadic root lattice",
    );
  if (
    !Array.isArray(input.leaves) ||
    input.leaves.length < 1 ||
    input.leaves.length > limits.maxLeaves
  )
    throw new RangeError("Water edge plan leaf count exceeds bounds");

  const tree: PartitionNode = { leaf: false, children: new Map() };
  let partitionNodes = 1;
  let nativeEdgeCoordinates = 0;
  const ids = new Set<number>();
  const leaves = input.leaves
    .map((leaf) => {
      const { id, depth } = leaf;
      if (!Number.isSafeInteger(id) || id < 0 || ids.has(id))
        throw new RangeError("Water edge plan requires unique safe leaf IDs");
      ids.add(id);
      if (!Number.isInteger(depth) || depth < 0 || depth > limits.maxDepth)
        throw new RangeError("Water edge plan depth exceeds bounds");
      const size = exact(leaf.size),
        spacing = exact(leaf.spacing);
      const centerX = exact(leaf.centerX),
        centerZ = exact(leaf.centerZ);
      if (size !== root.size / 2 ** depth || spacing <= 0)
        throw new RangeError(
          "Water edge plan leaf size differs from its dyadic depth",
        );
      const minX = index(centerX - size / 2, lattice.originX),
        maxX = index(centerX + size / 2, lattice.originX);
      const minZ = index(centerZ - size / 2, lattice.originZ),
        maxZ = index(centerZ + size / 2, lattice.originZ);
      const leafSpan = size / lattice.spacing;
      const x = (minX - rootX) / leafSpan,
        z = (minZ - rootZ) / leafSpan;
      const stride = spacing / lattice.spacing,
        segments = size / spacing;
      if (
        !Number.isSafeInteger(leafSpan) ||
        leafSpan < 1 ||
        !Number.isSafeInteger(x) ||
        !Number.isSafeInteger(z) ||
        x < 0 ||
        z < 0 ||
        x >= 2 ** depth ||
        z >= 2 ** depth ||
        maxX - minX !== leafSpan ||
        maxZ - minZ !== leafSpan
      )
        throw new RangeError(
          "Water edge plan leaf is outside or misaligned with root",
        );
      if (
        !Number.isSafeInteger(stride) ||
        stride < 1 ||
        !Number.isInteger(segments) ||
        segments < 1 ||
        segments > CONFORMING_WATER_GRID_LIMITS.maxSegmentsPerAxis
      )
        throw new RangeError(
          "Water edge plan native pitch is not a bounded lattice grid",
        );
      nativeEdgeCoordinates += 4 * (segments + 1);
      if (nativeEdgeCoordinates > limits.maxEdgeCoordinates)
        throw new RangeError("Water edge plan coordinate budget exceeded");
      let node = tree;
      for (let level = 0; level < depth; level++) {
        if (node.leaf)
          throw new RangeError("Water edge plan contains overlapping leaves");
        const divisor = 2 ** (depth - level - 1);
        const quadrant =
          (Math.floor(x / divisor) % 2) + 2 * (Math.floor(z / divisor) % 2);
        let child = node.children.get(quadrant);
        if (!child) {
          child = { leaf: false, children: new Map() };
          node.children.set(quadrant, child);
          partitionNodes++;
        }
        node = child;
      }
      if (node.leaf || node.children.size)
        throw new RangeError("Water edge plan contains overlapping leaves");
      node.leaf = true;
      return { id, depth, spacing, stride, minX, maxX, minZ, maxZ };
    })
    .sort((a, b) => a.id - b.id);
  const covered = (node: PartitionNode): void => {
    if (node.leaf) return;
    if (node.children.size !== 4)
      throw new RangeError(
        "Water edge plan partition has a hole (dry leaves are required)",
      );
    for (const child of node.children.values()) covered(child);
  };
  covered(tree);

  const xLines = new Map<number, Line>(),
    zLines = new Map<number, Line>();
  const edges: Record<WaterGridSide, Edge>[] = [];
  const addEdge = (
    leaf: number,
    side: WaterGridSide,
    lines: Map<number, Line>,
    fixed: number,
    start: number,
    end: number,
    positive: boolean,
  ): Edge => {
    const edge: Edge = {
      leaf,
      side,
      start,
      end,
      stride: leaves[leaf].stride,
      coordinates: new Set(),
      covered: 0,
    };
    for (let at = start; at <= end; at += edge.stride) edge.coordinates.add(at);
    let line = lines.get(fixed);
    if (!line) {
      line = { negative: [], positive: [] };
      lines.set(fixed, line);
    }
    line[positive ? "positive" : "negative"].push(edge);
    return edge;
  };
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    edges.push({
      minX: addEdge(i, "minX", xLines, leaf.minX, leaf.minZ, leaf.maxZ, true),
      maxX: addEdge(i, "maxX", xLines, leaf.maxX, leaf.minZ, leaf.maxZ, false),
      minZ: addEdge(i, "minZ", zLines, leaf.minZ, leaf.minX, leaf.maxX, true),
      maxZ: addEdge(i, "maxZ", zLines, leaf.maxZ, leaf.minX, leaf.maxX, false),
    });
  }
  let plannedEdgeCoordinates = nativeEdgeCoordinates,
    sharedIntervals = 0;
  const include = (
    target: Edge,
    source: Edge,
    start: number,
    end: number,
  ): void => {
    for (
      let at =
        source.start +
        Math.ceil((start - source.start) / source.stride) * source.stride;
      at <= end;
      at += source.stride
    ) {
      if (target.coordinates.has(at)) continue;
      if (
        target.coordinates.size >=
          CONFORMING_WATER_GRID_LIMITS.maxEdgeVertices ||
        plannedEdgeCoordinates >= limits.maxEdgeCoordinates
      )
        throw new RangeError("Water edge plan coordinate budget exceeded");
      target.coordinates.add(at);
      plannedEdgeCoordinates++;
    }
  };
  const join = (
    lines: Map<number, Line>,
    first: number,
    last: number,
  ): void => {
    for (const [fixed, line] of lines) {
      for (const list of [line.negative, line.positive]) {
        list.sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i++)
          if (list[i].start < list[i - 1].end)
            throw new RangeError(
              "Water edge plan has overlapping edge ownership",
            );
      }
      if (fixed === first || fixed === last) {
        if (line[fixed === first ? "negative" : "positive"].length)
          throw new RangeError(
            "Water edge plan has invalid outer edge ownership",
          );
        continue;
      }
      let a = 0,
        b = 0;
      while (a < line.negative.length && b < line.positive.length) {
        const left = line.negative[a],
          right = line.positive[b];
        const start = Math.max(left.start, right.start),
          end = Math.min(left.end, right.end);
        if (start >= end)
          throw new RangeError(
            "Water edge plan has unmatched internal edge ownership",
          );
        include(left, right, start, end);
        include(right, left, start, end);
        left.covered += end - start;
        right.covered += end - start;
        sharedIntervals++;
        if (left.end <= right.end) a++;
        if (right.end <= left.end) b++;
      }
      for (const edge of [...line.negative, ...line.positive])
        if (edge.covered !== edge.end - edge.start)
          throw new RangeError("Water edge plan has an internal edge hole");
    }
  };
  join(xLines, rootX, endX);
  join(zLines, rootZ, endZ);
  const world = (coordinate: number, origin: number): number =>
    exact(origin + coordinate * lattice.spacing);
  const plans = leaves.map((leaf, i): ConformingWaterLeafPlan => {
    // A valid edge coordinate does not imply a representable fan center at a
    // large world origin. Check exactly the cells that acquire subdivisions.
    const segments = (leaf.maxX - leaf.minX) / leaf.stride;
    const transitionCells = new Set<number>();
    for (const side of ["minX", "maxX", "minZ", "maxZ"] as const) {
      const onX = side === "minX" || side === "maxX";
      const edge = edges[i][side];
      for (const at of edge.coordinates) {
        const offset = (at - edge.start) / edge.stride;
        if (Number.isInteger(offset)) continue;
        const cell = Math.floor(offset);
        const x = onX ? (side === "minX" ? 0 : segments - 1) : cell;
        const z = onX ? cell : side === "minZ" ? 0 : segments - 1;
        transitionCells.add(z * segments + x);
      }
    }
    for (const cell of transitionCells) {
      const x = leaf.minX + (cell % segments) * leaf.stride;
      const z = leaf.minZ + Math.floor(cell / segments) * leaf.stride;
      for (const [at, origin] of [
        [x, lattice.originX],
        [z, lattice.originZ],
      ]) {
        const first = world(at, origin),
          last = world(at + leaf.stride, origin);
        exact(first + (last - first) / 2);
      }
    }
    const edge = (side: WaterGridSide, origin: number): readonly number[] =>
      Object.freeze(
        [...edges[i][side].coordinates]
          .sort((a, b) => a - b)
          .map((at) => world(at, origin)),
      );
    return Object.freeze({
      id: leaf.id,
      depth: leaf.depth,
      spacing: leaf.spacing,
      lattice,
      bounds: Object.freeze({
        minX: world(leaf.minX, lattice.originX),
        maxX: world(leaf.maxX, lattice.originX),
        minZ: world(leaf.minZ, lattice.originZ),
        maxZ: world(leaf.maxZ, lattice.originZ),
      }),
      edges: Object.freeze({
        minX: edge("minX", lattice.originZ),
        maxX: edge("maxX", lattice.originZ),
        minZ: edge("minZ", lattice.originX),
        maxZ: edge("maxZ", lattice.originX),
      }),
    });
  });
  return Object.freeze({
    leaves: Object.freeze(plans),
    counts: Object.freeze({
      leaves: leaves.length,
      partitionNodes,
      sharedIntervals,
      nativeEdgeCoordinates,
      plannedEdgeCoordinates,
    }),
  });
}
