import type THREE from "../../../extras/three/three";

export type TerrainGridHeightSample = {
  height: number;
  faceIndex: number;
};

export type TerrainGridSample = TerrainGridHeightSample & {
  nx: number;
  ny: number;
  nz: number;
};

export type TerrainGridBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/** Immutable CPU-only ranges into the actual main index buffer, before skirts.
 * Offsets count indices, not faces. The first resolution² positions remain the
 * original Float32 grid; additional surface vertices precede skirt vertices. */
export type TerrainCellTopology = Readonly<{
  schemaVersion: 1;
  resolution: number;
  cellIndexOffsets: readonly number[];
  surfaceVertexCount: number;
}>;

/** Detached copies of the admitted array views, not the live renderer buffers.
 * Payload bytes include packed topology offsets, not JS wrappers, strings or
 * any query metadata a receiving worker subsequently constructs. */
export type RetainedTerrainSurfaceSnapshot = Readonly<{
  schemaVersion: 1;
  nodeId: number;
  terrainProfileIdentity: string;
  revision: string;
  centerX: number;
  centerZ: number;
  size: number;
  resolution: number;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  topology: Readonly<{
    schemaVersion: 1;
    resolution: number;
    surfaceVertexCount: number;
    cellIndexOffsets: Uint32Array;
  }> | null;
  positionVersion: number;
  indexVersion: number;
  positionCount: number;
  indexCount: number;
  payloadBytes: number;
}>;

const SURFACE_SNAPSHOT_BATCH_ELEMENTS = 1024;

function* readCellTopology(
  geometry: THREE.BufferGeometry,
  resolution: number,
  checkCurrent: () => void,
): Generator<string, TerrainCellTopology | null, void> {
  const data = geometry.userData;
  const fail = (): never => {
    throw new Error("Invalid immutable retained terrain cell topology");
  };
  if (!data || typeof data !== "object") fail();
  const descriptor = Object.getOwnPropertyDescriptor(
    data,
    "terrainCellTopology",
  );
  if (!descriptor) {
    if ("terrainCellTopology" in data) fail();
    return null;
  }
  if (!("value" in descriptor) || !descriptor.enumerable) fail();
  const metadata: unknown = descriptor.value;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Object.getPrototypeOf(metadata) !== Object.prototype ||
    !Object.isFrozen(metadata)
  )
    fail();
  const keys = [
    "schemaVersion",
    "resolution",
    "cellIndexOffsets",
    "surfaceVertexCount",
  ];
  // Native own-key enumeration cannot yield internally. The valid wrapper has
  // four keys; malformed wrappers may allocate a larger native key list before
  // rejection. The admitted offset array below has at most 65,026 entries.
  yield "metadata-keys";
  checkCurrent();
  if (
    Object.getOwnPropertyNames(metadata).sort().join(",") !==
      [...keys].sort().join(",") ||
    Object.getOwnPropertySymbols(metadata).length
  )
    fail();
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(metadata, key);
    if (!field || !("value" in field) || !field.enumerable) return fail();
    values[key] = field.value;
  }
  const offsets = values.cellIndexOffsets,
    count = values.surfaceVertexCount;
  if (
    values.schemaVersion !== 1 ||
    values.resolution !== resolution ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < resolution * resolution ||
    count > 131072 ||
    !Array.isArray(offsets) ||
    Object.getPrototypeOf(offsets) !== Array.prototype ||
    !Object.isFrozen(offsets) ||
    offsets.length !== (resolution - 1) ** 2 + 1
  )
    return fail();
  yield "metadata-offset-keys";
  checkCurrent();
  if (
    Object.getOwnPropertyNames(offsets).length !== offsets.length + 1 ||
    Object.getOwnPropertySymbols(offsets).length
  )
    return fail();
  let previous = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (i % 256 === 0) {
      yield "metadata-offsets";
      checkCurrent();
    }
    const field = Object.getOwnPropertyDescriptor(offsets, String(i));
    if (
      !field ||
      !("value" in field) ||
      !field.enumerable ||
      !Number.isSafeInteger(field.value) ||
      field.value % 3 !== 0 ||
      (i === 0
        ? field.value !== 0
        : field.value - previous < 6 || field.value - previous > 512 * 3) ||
      field.value > 3_000_000
    )
      return fail();
    previous = field.value;
  }
  return metadata as TerrainCellTopology;
}

/** One-time proof of each indexed cell and its shared boundary partition.
 * Positive faces plus complete oriented edge incidence and boundary intervals
 * prohibit holes, overlaps, folds and cross-cell T-junctions. */
function* validateIndexedCells(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array,
  topology: TerrainCellTopology,
  checkCurrent: () => void,
): Generator<string, void, void> {
  const r = topology.resolution,
    offsets = topology.cellIndexOffsets,
    vertexCount = topology.surfaceVertexCount;
  const fail = (): never => {
    throw new Error("Invalid retained terrain indexed cell coverage");
  };
  if (
    positions.length < vertexCount * 3 ||
    indices.length < offsets[offsets.length - 1]
  )
    fail();
  for (let i = 0; i < vertexCount * 3; i++) {
    if (i % 256 === 0) {
      yield "topology-finite";
      checkCurrent();
    }
    if (!Number.isFinite(positions[i])) fail();
  }
  type Edge = { a: number; b: number; count: number; direction: number };
  const boundaryEdges = new Map<number, Edge>(),
    used = new Uint8Array(vertexCount),
    regular = new Uint8Array((r - 1) ** 2);
  // The constructor has already proved the finite, strictly increasing regular
  // Float32 prefix. Only this exact six-index pattern is an analytic rectangle
  // proof: both faces have positive winding, the diagonal has two opposite
  // incidences, and each side is its full directed coarse edge. Classify first
  // so adjoining refined cells can check those exact shared endpoint IDs.
  for (let z = 0; z < r - 1; z++)
    for (let x = 0; x < r - 1; x++) {
      const cell = z * (r - 1) + x,
        offset = offsets[cell],
        a = z * r + x;
      if (cell % 128 === 0) {
        yield "topology-regular";
        checkCurrent();
      }
      if (
        offsets[cell + 1] - offset !== 6 ||
        indices[offset] !== a ||
        indices[offset + 1] !== a + r ||
        indices[offset + 2] !== a + 1 ||
        indices[offset + 3] !== a + 1 ||
        indices[offset + 4] !== a + r ||
        indices[offset + 5] !== a + r + 1
      )
        continue;
      regular[cell] = 1;
      used[a] = used[a + r] = used[a + 1] = used[a + r + 1] = 1;
    }
  const addEdge = (map: Map<number, Edge>, a: number, b: number) => {
    const key = Math.min(a, b) * vertexCount + Math.max(a, b),
      old = map.get(key),
      direction = a < b ? 1 : -1;
    if (old) {
      if (++old.count > 2) fail();
      old.direction += direction;
    } else map.set(key, { a, b, count: 1, direction });
  };
  let faceWork = 0,
    boundaryWork = 0;
  for (let z = 0; z < r - 1; z++)
    for (let x = 0; x < r - 1; x++) {
      const cell = z * (r - 1) + x;
      if (cell % 128 === 0) {
        yield "topology-cells";
        checkCurrent();
      }
      // Two classified neighbors share the original grid IDs with opposite
      // directions by construction; neither needs an allocated edge record.
      if (regular[cell]) continue;
      const a = z * r + x,
        minX = positions[x * 3],
        maxX = positions[(x + 1) * 3],
        minZ = positions[z * r * 3 + 2],
        maxZ = positions[(z + 1) * r * 3 + 2];
      const edges = new Map<number, Edge>();
      const sides: [number, number][][] = [[], [], [], []];
      let area = 0;
      for (let i = offsets[cell]; i < offsets[cell + 1]; i += 3) {
        if (faceWork++ % 128 === 0) {
          yield "topology-faces";
          checkCurrent();
        }
        const a = indices[i],
          b = indices[i + 1],
          c = indices[i + 2];
        if (
          a >= vertexCount ||
          b >= vertexCount ||
          c >= vertexCount ||
          a === b ||
          a === c ||
          b === c
        )
          fail();
        for (const v of [a, b, c]) {
          used[v] = 1;
          if (
            positions[v * 3] < minX ||
            positions[v * 3] > maxX ||
            positions[v * 3 + 2] < minZ ||
            positions[v * 3 + 2] > maxZ
          )
            fail();
        }
        const signed =
          (positions[b * 3 + 2] - positions[a * 3 + 2]) *
            (positions[c * 3] - positions[a * 3]) -
          (positions[b * 3] - positions[a * 3]) *
            (positions[c * 3 + 2] - positions[a * 3 + 2]);
        if (!(signed > 0) || !Number.isFinite(signed)) fail();
        area += signed;
        addEdge(edges, a, b);
        addEdge(edges, b, c);
        addEdge(edges, c, a);
      }
      const expectedArea = 2 * (maxX - minX) * (maxZ - minZ);
      if (
        !Number.isFinite(area) ||
        Math.abs(area - expectedArea) >
          expectedArea *
            Number.EPSILON *
            (offsets[cell + 1] - offsets[cell]) *
            16
      )
        fail();
      for (const edge of edges.values()) {
        if (boundaryWork++ % 128 === 0) {
          yield "topology-boundaries";
          checkCurrent();
        }
        if (edge.count === 2) {
          if (edge.direction !== 0) fail();
          continue;
        }
        const ax = positions[edge.a * 3],
          az = positions[edge.a * 3 + 2],
          bx = positions[edge.b * 3],
          bz = positions[edge.b * 3 + 2];
        const side =
          ax === minX && bx === minX
            ? 0
            : ax === maxX && bx === maxX
              ? 1
              : az === minZ && bz === minZ
                ? 2
                : az === maxZ && bz === maxZ
                  ? 3
                  : -1;
        if (side === -1) fail();
        const start = side < 2 ? Math.min(az, bz) : Math.min(ax, bx),
          end = side < 2 ? Math.max(az, bz) : Math.max(ax, bx);
        if (!(end > start)) fail();
        sides[side].push([start, end]);
        const neighbor =
          side === 0
            ? x > 0
              ? cell - 1
              : -1
            : side === 1
              ? x < r - 2
                ? cell + 1
                : -1
              : side === 2
                ? z > 0
                  ? cell - (r - 1)
                  : -1
                : z < r - 2
                  ? cell + (r - 1)
                  : -1;
        if (neighbor >= 0 && regular[neighbor]) {
          // A regular neighbor owns one unsplit coarse edge. Coordinate-only
          // equality is insufficient: duplicate IDs or any subdivision would
          // introduce a T-junction, even if both cells had complete area.
          const expectedA =
              side === 0
                ? a
                : side === 1
                  ? a + r + 1
                  : side === 2
                    ? a + 1
                    : a + r,
            expectedB =
              side === 0
                ? a + r
                : side === 1
                  ? a + 1
                  : side === 2
                    ? a
                    : a + r + 1;
          if (edge.a !== expectedA || edge.b !== expectedB) fail();
        } else if (neighbor >= 0) {
          // Only refined/refined interfaces need the shared incidence map.
          // Root edges are proved by their cell's complete side intervals.
          addEdge(boundaryEdges, edge.a, edge.b);
        }
      }
      for (let side = 0; side < 4; side++) {
        // Sorting one side is native synchronous work, bounded by the already
        // admitted 512-face cell cap, never by the complete terrain mesh.
        yield "topology-side";
        checkCurrent();
        sides[side].sort((a, b) => a[0] - b[0]);
        let cursor = side < 2 ? minZ : minX;
        for (const [start, end] of sides[side]) {
          if (boundaryWork++ % 128 === 0) {
            yield "topology-intervals";
            checkCurrent();
          }
          if (start !== cursor) fail();
          cursor = end;
        }
        if (cursor !== (side < 2 ? maxZ : maxX)) fail();
      }
    }
  for (const edge of boundaryEdges.values()) {
    if (boundaryWork++ % 128 === 0) {
      yield "topology-shared-edges";
      checkCurrent();
    }
    if (edge.count !== 2 || edge.direction !== 0) fail();
  }
  for (let i = 0; i < used.length; i++) {
    if (i % 256 === 0) {
      yield "topology-used-vertices";
      checkCurrent();
    }
    if (used[i] !== 1) fail();
  }
}

export type TerrainTriangleVisitor = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  faceIndex: number,
) => void;

/** Caller-owned storage, overwritten by each successful cursor advance. */
export type TerrainGridTriangle = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** One bounded operation. The consumer charges both kinds of step, and runs
 * its unchanged barycentric narrow phase only for a returned triangle. */
export type TerrainGroundingEdgeCursor = {
  step(out: TerrainGridTriangle): "block" | "triangle" | null;
};

const GROUNDING_EDGE_BLOCK_FACES = 8;
const GROUNDING_EDGE_CHILD_FACES = 4;
// This is an envelope for the existing grass edge clipper, not a geometric
// epsilon. Qualification below makes all XZ edge products and det exact:
// dyadic integer edges <= 2^25, products <= 2^50, det integer <= 2^51.
// Local endpoints/vertices <= 64 and |dx|,|dz| <= 2 imply barycentric starts
// <= 2^21 and changes <= 2^15 before rounding. Including w=1-u-v, use loose
// computed bounds 2^23/2^17. Forward error of reconstructing any of the three
// exact affine barycentrics is < 2^-24 (subtraction, product, sum, division).
// For an accepted legacy interval, each barycentric is >= -beta: parallel
// admission is -1e-10 with |change|<1e-14; otherwise root rounding and the
// lo<=hi+1e-10 test contribute at most |change|*(1e-10+2^-48). This remains
// true at clamped lo, even for the legacy tolerated inverted interval.
// Exact barycentrics sum to one, at most two are negative, and XZ spans <=2,
// hence coordinate escape is <=4*beta. The last term bounds the difference
// between aLocal+t*(bWorld-aWorld) and the two rounded local endpoints, plus
// outward box arithmetic, under the bounded world-coordinate admission.
const GROUNDING_EDGE_ENVELOPE =
  4 * (2 ** 17 * (1e-10 + 2 ** -48) + 2 ** -24) + 2 ** -27;

type GroundingEdgeBlocks = {
  cellOffsets: Uint32Array;
  bounds: Float64Array;
  childBounds: Float64Array;
  stats: Readonly<{
    blocks: number;
    qualifiedBlocks: number;
    childSlots: number;
    qualifiedChildren: number;
    childBytes: number;
    childBoundFaceVisits: number;
    bytes: number;
    admissionSteps: number;
  }>;
};

/** Admission-owned, bounded metadata; no per-query geometry scan or lazy work.
 * Nonqualifying blocks are exhaustive, including skinny/near-degenerate faces.
 * Small cells have no index because a block test cannot save enough work. */
function* buildGroundingEdgeBlocks(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array,
  topology: TerrainCellTopology,
  checkCurrent: () => void,
): Generator<string, GroundingEdgeBlocks, void> {
  const offsets = topology.cellIndexOffsets,
    cellOffsets = new Uint32Array(offsets.length);
  let blocks = 0,
    qualifiedBlocks = 0,
    qualifiedChildren = 0,
    childBoundFaceVisits = 0,
    admissionSteps = 0;
  for (let cell = 0; cell < offsets.length - 1; cell++) {
    if (cell % 128 === 0) {
      admissionSteps++;
      yield "grounding-edge-index-cells";
      checkCurrent();
    }
    cellOffsets[cell] = blocks;
    const faces = (offsets[cell + 1] - offsets[cell]) / 3;
    if (faces > GROUNDING_EDGE_BLOCK_FACES)
      blocks += Math.ceil(faces / GROUNDING_EDGE_BLOCK_FACES);
  }
  cellOffsets[offsets.length - 1] = blocks;
  // Topology already caps every cell at 512 faces and total indices at 3m.
  admissionSteps++;
  yield "grounding-edge-index-allocation";
  checkCurrent();
  const bounds = new Float64Array(blocks * 4);
  // Two fixed child slots per parent, including unused/fallback slots. This
  // adds exactly 64 bytes per parent under the existing topology limits.
  admissionSteps++;
  yield "grounding-edge-index-child-allocation";
  checkCurrent();
  const childBounds = new Float64Array(blocks * 8);
  for (let cell = 0; cell < offsets.length - 1; cell++) {
    for (
      let block = cellOffsets[cell];
      block < cellOffsets[cell + 1];
      block++
    ) {
      admissionSteps++;
      yield "grounding-edge-index-block";
      checkCurrent();
      const start =
          offsets[cell] +
          (block - cellOffsets[cell]) * GROUNDING_EDGE_BLOCK_FACES * 3,
        end = Math.min(
          start + GROUNDING_EDGE_BLOCK_FACES * 3,
          offsets[cell + 1],
        ),
        hasChildren = end - start > GROUNDING_EDGE_CHILD_FACES * 3;
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity,
        qualified = true;
      for (let face = start; face < end; face += 3) {
        const ai = indices[face] * 3,
          bi = indices[face + 1] * 3,
          ci = indices[face + 2] * 3,
          ax = positions[ai],
          az = positions[ai + 2],
          bx = positions[bi],
          bz = positions[bi + 2],
          cx = positions[ci],
          cz = positions[ci + 2];
        for (const value of [ax, az, bx, bz, cx, cz])
          if (Math.abs(value) > 64 || !Number.isInteger(value * 2 ** 24))
            qualified = false;
        const ex = bx - ax,
          ez = bz - az,
          fx = cx - ax,
          fz = cz - az;
        if (
          Math.max(
            Math.abs(ex),
            Math.abs(ez),
            Math.abs(fx),
            Math.abs(fz),
            Math.abs(bx - cx),
            Math.abs(bz - cz),
          ) > 2 ||
          Math.abs(ex * fz - ez * fx) < 2 ** -12
        )
          qualified = false;
        minX = Math.min(minX, ax, bx, cx);
        maxX = Math.max(maxX, ax, bx, cx);
        minZ = Math.min(minZ, az, bz, cz);
        maxZ = Math.max(maxZ, az, bz, cz);
        if (hasChildren) {
          // The same admitted eight-face pass builds both four-face boxes;
          // no additional geometry scan or larger admission batch is hidden.
          const child =
            block * 8 +
            Math.floor((face - start) / (GROUNDING_EDGE_CHILD_FACES * 3)) * 4;
          if ((face - start) % (GROUNDING_EDGE_CHILD_FACES * 3) === 0) {
            childBounds[child] = childBounds[child + 2] = Infinity;
            childBounds[child + 1] = childBounds[child + 3] = -Infinity;
          }
          childBoundFaceVisits++;
          childBounds[child] = Math.min(childBounds[child], ax, bx, cx);
          childBounds[child + 1] = Math.max(childBounds[child + 1], ax, bx, cx);
          childBounds[child + 2] = Math.min(childBounds[child + 2], az, bz, cz);
          childBounds[child + 3] = Math.max(childBounds[child + 3], az, bz, cz);
        }
      }
      const k = block * 4;
      if (qualified) {
        qualifiedBlocks++;
        bounds[k] = minX - GROUNDING_EDGE_ENVELOPE;
        bounds[k + 1] = maxX + GROUNDING_EDGE_ENVELOPE;
        bounds[k + 2] = minZ - GROUNDING_EDGE_ENVELOPE;
        bounds[k + 3] = maxZ + GROUNDING_EDGE_ENVELOPE;
        if (hasChildren) {
          // Every child inherits its whole parent's numerical qualification.
          // Use the identical clipper envelope, not a tighter geometric bound.
          qualifiedChildren += 2;
          for (let child = block * 8; child < block * 8 + 8; child += 4) {
            childBounds[child] -= GROUNDING_EDGE_ENVELOPE;
            childBounds[child + 1] += GROUNDING_EDGE_ENVELOPE;
            childBounds[child + 2] -= GROUNDING_EDGE_ENVELOPE;
            childBounds[child + 3] += GROUNDING_EDGE_ENVELOPE;
          }
        }
      } else {
        // Nonfinite sentinel means no broad-phase test, not infinite padding.
        bounds[k] = NaN;
      }
    }
  }
  return {
    cellOffsets,
    bounds,
    childBounds,
    stats: Object.freeze({
      blocks,
      qualifiedBlocks,
      childSlots: blocks * 2,
      qualifiedChildren,
      childBytes: childBounds.byteLength,
      childBoundFaceVisits,
      bytes:
        cellOffsets.byteLength + bounds.byteLength + childBounds.byteLength,
      admissionSteps,
    }),
  };
}

/** One read-only retained-grid traversal, with no per-triangle allocations.
 * The surface owner must remain current while the caller suspends work. */
class RetainedTerrainTriangleCursor {
  private x: number;
  private z: number;
  private second = false;
  private indexOffset = 0;
  private edgeBlockEnd = 0;
  private edgeChildEnd = 0;
  private edgeChildOffset = 0;

  constructor(
    private readonly positions: Float32Array,
    private readonly resolution: number,
    private readonly x0: number,
    private readonly x1: number,
    private readonly z1: number,
    z0: number,
    private readonly indices?: Uint16Array | Uint32Array,
    private readonly cellOffsets?: readonly number[],
  ) {
    this.x = x0;
    this.z = z0;
    if (cellOffsets) this.indexOffset = cellOffsets[z0 * (resolution - 1) + x0];
  }

  hasNext(): boolean {
    return this.z <= this.z1 && this.x0 <= this.x1;
  }

  next(out: TerrainGridTriangle): boolean {
    if (!this.hasNext()) return false;
    const p = this.positions,
      r = this.resolution;
    if (this.indices && this.cellOffsets) {
      const offset = this.indexOffset;
      for (let k = 0; k < 3; k++) {
        const i = this.indices[offset + k] * 3;
        out[k * 3] = p[i];
        out[k * 3 + 1] = p[i + 1];
        out[k * 3 + 2] = p[i + 2];
      }
      out[9] = offset / 3;
      this.indexOffset += 3;
      if (
        this.indexOffset === this.cellOffsets[this.z * (r - 1) + this.x + 1]
      ) {
        if (++this.x > this.x1) {
          this.x = this.x0;
          this.z++;
        }
        if (this.hasNext())
          this.indexOffset = this.cellOffsets[this.z * (r - 1) + this.x];
      }
      return true;
    }
    const a = (this.z * r + this.x) * 3;
    const b = a + 3,
      c = a + r * 3,
      d = c + 3;
    const first = this.second ? b : a,
      last = this.second ? d : b;
    out[0] = p[first];
    out[1] = p[first + 1];
    out[2] = p[first + 2];
    out[3] = p[c];
    out[4] = p[c + 1];
    out[5] = p[c + 2];
    out[6] = p[last];
    out[7] = p[last + 1];
    out[8] = p[last + 2];
    out[9] = (this.z * (r - 1) + this.x) * 2 + (this.second ? 1 : 0);
    if (this.second && ++this.x > this.x1) {
      this.x = this.x0;
      this.z++;
    }
    this.second = !this.second;
    return true;
  }

  private skipIndexedRange(end: number, cell: number): void {
    this.indexOffset = end;
    if (end === this.cellOffsets![cell + 1]) {
      if (++this.x > this.x1) {
        this.x = this.x0;
        this.z++;
      }
      if (this.hasNext())
        this.indexOffset =
          this.cellOffsets![this.z * (this.resolution - 1) + this.x];
    }
  }

  /** Each parent/child AABB test returns its own charged block step. Missing
   * parents skip children; accepted faces retain next()'s exact copy/order. */
  edgeStep(
    out: TerrainGridTriangle,
    blocks: GroundingEdgeBlocks,
    bounds: TerrainGridBounds,
  ): "block" | "triangle" | null {
    if (!this.hasNext()) return null;
    if (!this.cellOffsets || !this.indices)
      return this.next(out) ? "triangle" : null;
    const cell = this.z * (this.resolution - 1) + this.x,
      firstBlock = blocks.cellOffsets[cell],
      lastBlock = blocks.cellOffsets[cell + 1];
    if (firstBlock === lastBlock) return this.next(out) ? "triangle" : null;
    if (this.indexOffset < this.edgeBlockEnd) {
      if (this.indexOffset < this.edgeChildEnd)
        return this.next(out) ? "triangle" : null;
      const child = this.edgeChildOffset,
        end = Math.min(
          this.indexOffset + GROUNDING_EDGE_CHILD_FACES * 3,
          this.edgeBlockEnd,
        );
      this.edgeChildOffset += 4;
      this.edgeChildEnd = end;
      if (
        bounds.maxX < blocks.childBounds[child] ||
        bounds.minX > blocks.childBounds[child + 1] ||
        bounds.maxZ < blocks.childBounds[child + 2] ||
        bounds.minZ > blocks.childBounds[child + 3]
      )
        this.skipIndexedRange(end, cell);
      return "block";
    }
    const block =
        firstBlock +
        Math.floor(
          (this.indexOffset - this.cellOffsets[cell]) /
            (GROUNDING_EDGE_BLOCK_FACES * 3),
        ),
      k = block * 4,
      end = Math.min(
        this.indexOffset + GROUNDING_EDGE_BLOCK_FACES * 3,
        this.cellOffsets[cell + 1],
      );
    this.edgeBlockEnd = end;
    this.edgeChildEnd = end;
    // A fallback block performs no AABB test and consumes only face steps.
    if (!Number.isFinite(blocks.bounds[k]))
      return this.next(out) ? "triangle" : null;
    if (
      bounds.maxX < blocks.bounds[k] ||
      bounds.minX > blocks.bounds[k + 1] ||
      bounds.maxZ < blocks.bounds[k + 2] ||
      bounds.minZ > blocks.bounds[k + 3]
    ) {
      this.skipIndexedRange(end, cell);
    } else if (end - this.indexOffset > GROUNDING_EDGE_CHILD_FACES * 3) {
      this.edgeChildOffset = block * 8;
      this.edgeChildEnd = this.indexOffset;
    }
    return "block";
  }
}

type AdmissionInput = {
  nodeId: number;
  terrainProfileIdentity: string;
  centerX: number;
  centerZ: number;
  size: number;
  resolution: number;
  geometry: THREE.BufferGeometry;
};

type AdmissionOwner = AdmissionInput & {
  revision: string;
  position: THREE.BufferAttribute;
  index: THREE.BufferAttribute;
  positions: Float32Array;
  indexArray: THREE.BufferAttribute["array"];
  positionVersion: number;
  indexVersion: number;
  positionCount: number;
  indexCount: number;
  positionLength: number;
  indexLength: number;
  positionNormalized: boolean;
  indexNormalized: boolean;
  indexItemSize: number;
  userData: THREE.BufferGeometry["userData"];
  metadataDescriptor: PropertyDescriptor | undefined;
  metadataPresent: boolean;
};

type AdmissionProof = AdmissionOwner & {
  topology: TerrainCellTopology | null;
  refinedIndices: Uint16Array | Uint32Array | null;
  groundingEdgeBlocks: GroundingEdgeBlocks | null;
};

function captureAdmissionOwner(input: AdmissionInput): AdmissionOwner {
  const { geometry, resolution, size, centerX, centerZ } = input,
    position = geometry.getAttribute("position"),
    index = geometry.getIndex();
  if (
    !Number.isInteger(resolution) ||
    resolution < 2 ||
    resolution > 256 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    !Number.isFinite(centerX) ||
    !Number.isFinite(centerZ) ||
    !position ||
    !("version" in position) ||
    position.itemSize !== 3 ||
    !(position.array instanceof Float32Array) ||
    position.count < resolution * resolution ||
    !index ||
    index.count < (resolution - 1) ** 2 * 6
  )
    throw new Error("Invalid retained terrain grid");
  const userData = geometry.userData,
    isObject = userData !== null && typeof userData === "object";
  return {
    ...input,
    revision: geometry.uuid,
    position,
    index,
    positions: position.array,
    indexArray: index.array,
    positionVersion: position.version,
    indexVersion: index.version,
    positionCount: position.count,
    indexCount: index.count,
    positionLength: position.array.length,
    indexLength: index.array.length,
    positionNormalized: position.normalized,
    indexNormalized: index.normalized,
    indexItemSize: index.itemSize,
    userData,
    metadataDescriptor: isObject
      ? Object.getOwnPropertyDescriptor(userData, "terrainCellTopology")
      : undefined,
    metadataPresent: isObject && "terrainCellTopology" in userData,
  };
}

/** O(1) borrowed-owner guard. As with installed retained surfaces, writes to
 * existing Three typed arrays must publish their BufferAttribute.needsUpdate
 * version; unannounced raw writes are not an independently observable revision. */
function assertAdmissionCurrent(owner: AdmissionOwner): void {
  const { geometry, position, index } = owner,
    data = geometry.userData,
    isObject = data !== null && typeof data === "object",
    descriptor = isObject
      ? Object.getOwnPropertyDescriptor(data, "terrainCellTopology")
      : undefined,
    old = owner.metadataDescriptor;
  if (
    geometry.uuid !== owner.revision ||
    geometry.getAttribute("position") !== position ||
    geometry.getIndex() !== index ||
    position.array !== owner.positions ||
    index.array !== owner.indexArray ||
    position.array.length !== owner.positionLength ||
    index.array.length !== owner.indexLength ||
    position.count !== owner.positionCount ||
    index.count !== owner.indexCount ||
    position.itemSize !== 3 ||
    index.itemSize !== owner.indexItemSize ||
    position.normalized !== owner.positionNormalized ||
    index.normalized !== owner.indexNormalized ||
    position.version !== owner.positionVersion ||
    index.version !== owner.indexVersion ||
    !Object.is(data, owner.userData) ||
    (isObject && "terrainCellTopology" in data) !== owner.metadataPresent ||
    Boolean(descriptor) !== Boolean(old) ||
    (descriptor &&
      old &&
      (!Object.is(descriptor.value, old.value) ||
        descriptor.get !== old.get ||
        descriptor.set !== old.set ||
        descriptor.enumerable !== old.enumerable ||
        descriptor.configurable !== old.configurable ||
        descriptor.writable !== old.writable))
  )
    throw new Error("Retained terrain geometry changed during admission");
}

/** The single strict validation path, consumed either synchronously or in
 * bounded batches. Delegation closes all active scans/maps on return/throw;
 * it never disposes the borrowed geometry or returns a partial owner. */
function* validateAdmission(
  input: AdmissionInput,
): Generator<string, AdmissionProof, void> {
  const owner = captureAdmissionOwner(input),
    { geometry, resolution, size, positions, index } = owner,
    checkCurrent = () => assertAdmissionCurrent(owner);
  yield "admission";
  checkCurrent();
  const topology = yield* readCellTopology(geometry, resolution, checkCurrent);
  let refinedIndices: Uint16Array | Uint32Array | null = null;
  if (topology) {
    if (
      index.itemSize !== 1 ||
      index.normalized ||
      !(
        index.array instanceof Uint16Array || index.array instanceof Uint32Array
      )
    )
      throw new Error("Invalid retained terrain indexed attribute");
    refinedIndices = index.array;
  }
  for (let z = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      const a = z * resolution + x,
        p = a * 3;
      if (a % 128 === 0) {
        yield "grid";
        checkCurrent();
      }
      if (
        positions[p] !==
          Math.fround(-size / 2 + x * (size / (resolution - 1))) ||
        positions[p + 2] !==
          Math.fround(-size / 2 + z * (size / (resolution - 1))) ||
        !Number.isFinite(positions[p + 1])
      )
        throw new Error(
          "Retained terrain grid is not an unmodified regular Float32 grid",
        );
      if (
        (x > 0 && positions[p] <= positions[p - 3]) ||
        (z > 0 && positions[p + 2] <= positions[p - resolution * 3 + 2])
      )
        throw new Error(
          "Retained terrain grid axes must be strictly increasing",
        );
      if (x === resolution - 1 || z === resolution - 1 || topology) continue;
      const offset = (z * (resolution - 1) + x) * 6;
      if (
        index.getX(offset) !== a ||
        index.getX(offset + 1) !== a + resolution ||
        index.getX(offset + 2) !== a + 1 ||
        index.getX(offset + 3) !== a + 1 ||
        index.getX(offset + 4) !== a + resolution ||
        index.getX(offset + 5) !== a + resolution + 1
      )
        throw new Error("Retained terrain triangle topology mismatch");
    }
  if (topology && refinedIndices)
    yield* validateIndexedCells(
      positions,
      refinedIndices,
      topology,
      checkCurrent,
    );
  const groundingEdgeBlocks =
    topology && refinedIndices
      ? yield* buildGroundingEdgeBlocks(
          positions,
          refinedIndices,
          topology,
          checkCurrent,
        )
      : null;
  yield "finalize";
  checkCurrent();
  return { ...owner, topology, refinedIndices, groundingEdgeBlocks };
}

function drainAdmission(input: AdmissionInput): AdmissionProof {
  const iterator = validateAdmission(input);
  for (;;) {
    const next = iterator.next();
    if (next.done) return next.value;
  }
}

// A private one-use handoff, set only immediately before the constructor and
// consumed at its first statement, before any borrowed object methods run.
// There is no extra public argument, boolean, or exported proof-producing API.
let preparedAdmission: AdmissionProof | null = null;

/** One installed geometry revision, never a procedural or bilinear approximation. */
export class RetainedTerrainSurface {
  readonly revision: string;
  private readonly positions: Float32Array;
  private readonly positionVersion: number;
  private readonly indexVersion: number;
  private readonly index: THREE.BufferAttribute;
  private readonly position: THREE.BufferAttribute;
  private readonly indexArray: THREE.BufferAttribute["array"];
  private readonly positionCount: number;
  private readonly indexCount: number;
  private readonly topology: TerrainCellTopology | null;
  private readonly refinedIndices: Uint16Array | Uint32Array | null;
  private readonly groundingEdgeBlocks: GroundingEdgeBlocks | null;
  private readonly checkGroundingEdgeCurrent: () => void;

  constructor(
    readonly nodeId: number,
    readonly terrainProfileIdentity: string,
    readonly centerX: number,
    readonly centerZ: number,
    readonly size: number,
    readonly resolution: number,
    geometry: THREE.BufferGeometry,
  ) {
    const pending = preparedAdmission;
    preparedAdmission = null;
    const input = {
      nodeId,
      terrainProfileIdentity,
      centerX,
      centerZ,
      size,
      resolution,
      geometry,
    };
    if (
      pending &&
      (!Object.is(pending.nodeId, nodeId) ||
        pending.terrainProfileIdentity !== terrainProfileIdentity ||
        !Object.is(pending.centerX, centerX) ||
        !Object.is(pending.centerZ, centerZ) ||
        !Object.is(pending.size, size) ||
        pending.resolution !== resolution ||
        pending.geometry !== geometry)
    )
      throw new Error("Retained terrain admission proof mismatch");
    const proof = pending ?? drainAdmission(input);
    assertAdmissionCurrent(proof);
    this.positions = proof.positions;
    this.position = proof.position;
    this.positionCount = proof.positionCount;
    this.indexCount = proof.indexCount;
    this.indexArray = proof.indexArray;
    this.revision = proof.revision;
    this.positionVersion = proof.positionVersion;
    this.indexVersion = proof.indexVersion;
    this.index = proof.index;
    this.topology = proof.topology;
    this.refinedIndices = proof.refinedIndices;
    this.groundingEdgeBlocks = proof.groundingEdgeBlocks;
    this.checkGroundingEdgeCurrent = () => assertAdmissionCurrent(proof);
  }

  /** Cooperatively validate borrowed geometry. No owner exists until done;
   * return/throw abandons only admission state, never the caller's geometry.
   * Phase batches bound JS work, not elapsed wall time or native enumeration. */
  static *prepare(
    nodeId: number,
    terrainProfileIdentity: string,
    centerX: number,
    centerZ: number,
    size: number,
    resolution: number,
    geometry: THREE.BufferGeometry,
  ): Generator<string, RetainedTerrainSurface, void> {
    const proof = yield* validateAdmission({
      nodeId,
      terrainProfileIdentity,
      centerX,
      centerZ,
      size,
      resolution,
      geometry,
    });
    assertAdmissionCurrent(proof);
    preparedAdmission = proof;
    try {
      return new RetainedTerrainSurface(
        nodeId,
        terrainProfileIdentity,
        centerX,
        centerZ,
        size,
        resolution,
        geometry,
      );
    } finally {
      // Normally the constructor has consumed this already; never leave a
      // transferable proof behind if construction exits exceptionally.
      if (preparedAdmission === proof) preparedAdmission = null;
    }
  }

  /** O(1) reservation preflight. The caller owns aggregate in-flight memory;
   * this owner never reserves, caches or transfers its live geometry. */
  snapshotByteLength(): number {
    this.checkGroundingEdgeCurrent();
    if (
      !(
        this.indexArray instanceof Uint16Array ||
        this.indexArray instanceof Uint32Array
      ) ||
      this.index.itemSize !== 1 ||
      this.index.normalized ||
      this.position.normalized
    )
      throw new Error("Unsupported retained terrain snapshot attribute layout");
    const bytes =
      this.positions.byteLength +
      this.indexArray.byteLength +
      (this.topology?.cellIndexOffsets.length ?? 0) *
        Uint32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error("Invalid retained terrain snapshot byte length");
    return bytes;
  }

  /** Copy under the original borrowed-owner guard at every suspension/batch.
   * Like retained admission, this observes published attribute versions, not
   * unannounced writes into otherwise unchanged source typed arrays. Native
   * allocations cannot be preempted; copying is bounded to 1024 elements/step.
   * Closing the iterator abandons only its private copies, never the source. */
  *copySnapshotSteps(
    maximumBytes: number,
  ): Generator<string, RetainedTerrainSurfaceSnapshot, void> {
    const payloadBytes = this.snapshotByteLength();
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
      throw new Error("Invalid retained terrain snapshot byte bound");
    if (payloadBytes > maximumBytes)
      throw new Error("Retained terrain snapshot exceeds byte bound");
    const sourceIndices = this.indexArray;
    if (!(
      sourceIndices instanceof Uint16Array ||
      sourceIndices instanceof Uint32Array
    ))
      throw new Error("Unsupported retained terrain snapshot index width");

    yield "snapshot-position-allocation";
    this.checkGroundingEdgeCurrent();
    const positions = new Float32Array(this.positions.length);
    this.checkGroundingEdgeCurrent();
    for (
      let start = 0;
      start < positions.length;
      start += SURFACE_SNAPSHOT_BATCH_ELEMENTS
    ) {
      yield "snapshot-position-copy";
      this.checkGroundingEdgeCurrent();
      positions.set(
        this.positions.subarray(
          start,
          Math.min(start + SURFACE_SNAPSHOT_BATCH_ELEMENTS, positions.length),
        ),
        start,
      );
      this.checkGroundingEdgeCurrent();
    }

    yield "snapshot-index-allocation";
    this.checkGroundingEdgeCurrent();
    const indices =
      sourceIndices instanceof Uint16Array
        ? new Uint16Array(sourceIndices.length)
        : new Uint32Array(sourceIndices.length);
    this.checkGroundingEdgeCurrent();
    for (
      let start = 0;
      start < indices.length;
      start += SURFACE_SNAPSHOT_BATCH_ELEMENTS
    ) {
      yield "snapshot-index-copy";
      this.checkGroundingEdgeCurrent();
      indices.set(
        sourceIndices.subarray(
          start,
          Math.min(start + SURFACE_SNAPSHOT_BATCH_ELEMENTS, indices.length),
        ),
        start,
      );
      this.checkGroundingEdgeCurrent();
    }

    let topology: RetainedTerrainSurfaceSnapshot["topology"] = null;
    if (this.topology) {
      yield "snapshot-topology-allocation";
      this.checkGroundingEdgeCurrent();
      const sourceOffsets = this.topology.cellIndexOffsets;
      const cellIndexOffsets = new Uint32Array(sourceOffsets.length);
      this.checkGroundingEdgeCurrent();
      for (
        let start = 0;
        start < cellIndexOffsets.length;
        start += SURFACE_SNAPSHOT_BATCH_ELEMENTS
      ) {
        yield "snapshot-topology-copy";
        this.checkGroundingEdgeCurrent();
        const end = Math.min(
          start + SURFACE_SNAPSHOT_BATCH_ELEMENTS,
          cellIndexOffsets.length,
        );
        for (let i = start; i < end; i++)
          cellIndexOffsets[i] = sourceOffsets[i];
        this.checkGroundingEdgeCurrent();
      }
      topology = Object.freeze({
        schemaVersion: 1,
        resolution: this.topology.resolution,
        surfaceVertexCount: this.topology.surfaceVertexCount,
        cellIndexOffsets,
      });
    }
    yield "snapshot-finalize";
    this.checkGroundingEdgeCurrent();
    return Object.freeze({
      schemaVersion: 1,
      nodeId: this.nodeId,
      terrainProfileIdentity: this.terrainProfileIdentity,
      revision: this.revision,
      centerX: this.centerX,
      centerZ: this.centerZ,
      size: this.size,
      resolution: this.resolution,
      positions,
      indices,
      topology,
      positionVersion: this.positionVersion,
      indexVersion: this.indexVersion,
      positionCount: this.positionCount,
      indexCount: this.indexCount,
      payloadBytes,
    });
  }

  matchesGeometry(geometry: THREE.BufferGeometry): boolean {
    const position = geometry.getAttribute("position");
    if (!geometry.userData || typeof geometry.userData !== "object")
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(
      geometry.userData,
      "terrainCellTopology",
    );
    const sameTopology = this.topology
      ? Boolean(
          descriptor &&
          "value" in descriptor &&
          descriptor.enumerable &&
          descriptor.value === this.topology,
        )
      : !("terrainCellTopology" in geometry.userData);
    return (
      geometry.uuid === this.revision &&
      position === this.position &&
      position?.array === this.positions &&
      position.count === this.positionCount &&
      position.itemSize === 3 &&
      "version" in position &&
      position.version === this.positionVersion &&
      geometry.index === this.index &&
      geometry.index?.array === this.indexArray &&
      geometry.index.count === this.indexCount &&
      geometry.index.version === this.indexVersion &&
      (!this.topology ||
        (geometry.index.itemSize === 1 && !geometry.index.normalized)) &&
      sameTopology
    );
  }

  /** True only for an admitted wholly canonical regular-grid owner. An
   * indexed owner is excluded even when some or all of its cells are regular;
   * this classification does not replace the caller's current-geometry lease. */
  get isRegularGrid(): boolean {
    return this.refinedIndices === null;
  }

  /** Read one admitted main-surface face into caller-owned storage, in the
   * same local coordinate/vertex order as createTriangleCursor; never skirts.
   * No traversal or face cache is retained. Held attribute revisions are
   * checked here; callers still own matchesGeometry/region.isCurrent checks
   * for geometry attribute replacement and topology ownership, as for sample.
   * Invalid requests or held revisions leave out untouched. */
  readTriangle(faceIndex: number, out: TerrainGridTriangle): boolean {
    const r = this.resolution,
      offsets = this.topology?.cellIndexOffsets,
      faceCount = offsets ? offsets[offsets.length - 1] / 3 : 2 * (r - 1) ** 2;
    if (
      !Number.isSafeInteger(faceIndex) ||
      faceIndex < 0 ||
      faceIndex >= faceCount ||
      this.position.version !== this.positionVersion ||
      this.position.array !== this.positions ||
      this.position.count !== this.positionCount ||
      this.position.itemSize !== 3 ||
      this.index.version !== this.indexVersion ||
      this.index.array !== this.indexArray ||
      this.index.count !== this.indexCount ||
      (this.topology && (this.index.itemSize !== 1 || this.index.normalized))
    )
      return false;
    const p = this.positions;
    let a: number, b: number, c: number;
    if (this.refinedIndices) {
      const i = faceIndex * 3;
      a = this.refinedIndices[i] * 3;
      b = this.refinedIndices[i + 1] * 3;
      c = this.refinedIndices[i + 2] * 3;
    } else {
      const cell = Math.floor(faceIndex / 2),
        first = (Math.floor(cell / (r - 1)) * r + (cell % (r - 1))) * 3,
        second = faceIndex % 2;
      a = first + second * 3;
      b = first + r * 3;
      c = second ? b + 3 : first + 3;
    }
    out[0] = p[a];
    out[1] = p[a + 1];
    out[2] = p[a + 2];
    out[3] = p[b];
    out[4] = p[b + 1];
    out[5] = p[b + 2];
    out[6] = p[c];
    out[7] = p[c + 1];
    out[8] = p[c + 2];
    out[9] = faceIndex;
    return true;
  }

  /** Read a canonical face only when the original cursor query lies strictly
   * inside that face's regular cell. Indexed owners use their admitted cell
   * offsets, not faceIndex / 2: earlier refinements can shift every later face.
   * Exact Float32 cell edges are excluded so the cursor cannot visit a refined
   * neighbour. This proves cell selection, not containment within one face;
   * the caller still proves that separately and owns the full geometry lease.
   * No cache/state is retained; every rejection leaves out untouched. */
  readCanonicalTriangleInBounds(
    faceIndex: number,
    bounds: TerrainGridBounds,
    out: TerrainGridTriangle,
  ): boolean {
    const r = this.resolution,
      offsets = this.topology?.cellIndexOffsets,
      faceCount = offsets ? offsets[offsets.length - 1] / 3 : 2 * (r - 1) ** 2,
      half = this.size / 2,
      { minX, maxX, minZ, maxZ } = bounds;
    if (
      !Number.isSafeInteger(faceIndex) ||
      faceIndex < 0 ||
      faceIndex >= faceCount ||
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minZ) ||
      !Number.isFinite(maxZ) ||
      minX > maxX ||
      minZ > maxZ ||
      maxX < -half ||
      minX > half ||
      maxZ < -half ||
      minZ > half
    )
      return false;
    let cell = Math.floor(faceIndex / 2),
      indexOffset = cell * 6;
    if (offsets) {
      let lo = 0,
        hi = offsets.length - 1;
      const faceOffset = faceIndex * 3;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        if (offsets[mid] <= faceOffset) lo = mid;
        else hi = mid;
      }
      cell = lo;
      indexOffset = offsets[cell];
      if (offsets[cell + 1] - indexOffset !== 6) return false;
    }
    const a = Math.floor(cell / (r - 1)) * r + (cell % (r - 1)),
      indices = this.indexArray,
      p = this.positions;
    if (
      indices[indexOffset] !== a ||
      indices[indexOffset + 1] !== a + r ||
      indices[indexOffset + 2] !== a + 1 ||
      indices[indexOffset + 3] !== a + 1 ||
      indices[indexOffset + 4] !== a + r ||
      indices[indexOffset + 5] !== a + r + 1 ||
      minX <= p[a * 3] ||
      maxX >= p[(a + 1) * 3] ||
      minZ <= p[a * 3 + 2] ||
      maxZ >= p[(a + r) * 3 + 2]
    )
      return false;
    return this.readTriangle(faceIndex, out);
  }

  /** Resume one original triangle at a time without repeating spatial queries
   * or allocating vertex tuples. Includes both cells at exact Float32 edges,
   * in the same row/cell/face order as visitTrianglesInBounds. */
  createTriangleCursor(
    bounds: TerrainGridBounds,
  ): RetainedTerrainTriangleCursor {
    if (
      ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(
        Number.isFinite,
      ) ||
      bounds.minX > bounds.maxX ||
      bounds.minZ > bounds.maxZ
    )
      throw new Error("Invalid retained triangle query");
    const half = this.size / 2,
      p = this.positions,
      r = this.resolution;
    if (
      bounds.maxX < -half ||
      bounds.minX > half ||
      bounds.maxZ < -half ||
      bounds.minZ > half
    )
      return new RetainedTerrainTriangleCursor(
        p,
        r,
        0,
        -1,
        -1,
        0,
        this.refinedIndices ?? undefined,
        this.topology?.cellIndexOffsets,
      );
    const bound = (
      value: number,
      stride: number,
      offset: number,
      upper: boolean,
    ) => {
      let lo = 0,
        hi = r;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1,
          coordinate = p[mid * stride + offset];
        if (coordinate < value || (upper && coordinate === value)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return new RetainedTerrainTriangleCursor(
      p,
      r,
      Math.max(0, bound(bounds.minX, 3, 0, false) - 1),
      Math.min(r - 2, bound(bounds.maxX, 3, 0, true) - 1),
      Math.min(r - 2, bound(bounds.maxZ, r * 3, 2, true) - 1),
      Math.max(0, bound(bounds.minZ, r * 3, 2, false) - 1),
      this.refinedIndices ?? undefined,
      this.topology?.cellIndexOffsets,
    );
  }

  /** Diagnostic receipt for the real admission-built metadata, not a cache
   * estimate. Null means this owner has no indexed terrain topology. */
  get groundingEdgeIndexStats(): GroundingEdgeBlocks["stats"] | null {
    return this.groundingEdgeBlocks?.stats ?? null;
  }

  /** Only for GrassBladeGrounding's documented affine edge clipper. Other
   * consumers retain createTriangleCursor's complete coarse-cell semantics.
   * Inputs are WORLD endpoints: dx must match bWorld-aWorld, never a
   * subtraction of already-rounded locals. Unsupported domains fall back. */
  createGroundingEdgeCursor(
    aWorldX: number,
    aWorldZ: number,
    bWorldX: number,
    bWorldZ: number,
  ): TerrainGroundingEdgeCursor | null {
    const blocks = this.groundingEdgeBlocks;
    if (!blocks || !blocks.stats.qualifiedBlocks) return null;
    if (
      ![aWorldX, aWorldZ, bWorldX, bWorldZ, this.centerX, this.centerZ].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 2 ** 20,
      ) ||
      Math.abs(bWorldX - aWorldX) > 2 ||
      Math.abs(bWorldZ - aWorldZ) > 2 ||
      ![
        aWorldX - this.centerX,
        bWorldX - this.centerX,
        aWorldZ - this.centerZ,
        bWorldZ - this.centerZ,
      ].every((value) => Math.abs(value) <= 64)
    )
      return null;
    this.checkGroundingEdgeCurrent();
    // Keep the original extrema/subtraction order and nominal-domain gate.
    const bounds = {
        minX: Math.min(aWorldX, bWorldX) - this.centerX,
        maxX: Math.max(aWorldX, bWorldX) - this.centerX,
        minZ: Math.min(aWorldZ, bWorldZ) - this.centerZ,
        maxZ: Math.max(aWorldZ, bWorldZ) - this.centerZ,
      },
      cursor = this.createTriangleCursor(bounds);
    return {
      step: (out) => {
        this.checkGroundingEdgeCurrent();
        return cursor.edgeStep(out, blocks, bounds);
      },
    };
  }

  /**
   * Bounded read-only access to original main-grid triangles (never skirts).
   * Bounds and vertices are chunk-local. The caller clips candidate triangles
   * to its exact footprint; this method deliberately includes boundary cells.
   */
  visitTrianglesInBounds(
    bounds: TerrainGridBounds,
    visit: TerrainTriangleVisitor,
    triangleBudget: number,
  ): { visited: number; exhausted: boolean } {
    if (
      ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(
        Number.isFinite,
      ) ||
      bounds.minX > bounds.maxX ||
      bounds.minZ > bounds.maxZ ||
      !Number.isSafeInteger(triangleBudget) ||
      triangleBudget < 0 ||
      triangleBudget > 1_000_000
    )
      throw new Error("Invalid retained triangle query");
    if (this.topology) {
      const cursor = this.createTriangleCursor(bounds),
        out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let visited = 0;
      while (cursor.hasNext()) {
        if (visited === triangleBudget) return { visited, exhausted: true };
        cursor.next(out);
        visit(
          out[0],
          out[1],
          out[2],
          out[3],
          out[4],
          out[5],
          out[6],
          out[7],
          out[8],
          out[9],
        );
        visited++;
      }
      return { visited, exhausted: false };
    }
    const half = this.size / 2;
    if (
      bounds.maxX < -half ||
      bounds.minX > half ||
      bounds.maxZ < -half ||
      bounds.minZ > half
    )
      return { visited: 0, exhausted: false };
    const p = this.positions;
    const r = this.resolution;
    // Search the actual Float32 axes, not an idealized division. At equality,
    // include both cells touching a boundary; otherwise visit only its owner.
    const axisBound = (
      value: number,
      stride: number,
      offset: number,
      upper: boolean,
    ) => {
      let low = 0,
        high = r;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (
          p[middle * stride + offset] < value ||
          (upper && p[middle * stride + offset] === value)
        )
          low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const x0 = Math.max(0, axisBound(bounds.minX, 3, 0, false) - 1);
    const x1 = Math.min(r - 2, axisBound(bounds.maxX, 3, 0, true) - 1);
    const z0 = Math.max(0, axisBound(bounds.minZ, r * 3, 2, false) - 1);
    const z1 = Math.min(r - 2, axisBound(bounds.maxZ, r * 3, 2, true) - 1);
    let visited = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const a = (z * r + x) * 3;
        const b = a + 3;
        const c = a + r * 3;
        const d = c + 3;
        const face = (z * (r - 1) + x) * 2;
        if (visited === triangleBudget) return { visited, exhausted: true };
        visit(
          p[a],
          p[a + 1],
          p[a + 2],
          p[c],
          p[c + 1],
          p[c + 2],
          p[b],
          p[b + 1],
          p[b + 2],
          face,
        );
        visited++;
        if (visited === triangleBudget) return { visited, exhausted: true };
        visit(
          p[b],
          p[b + 1],
          p[b + 2],
          p[c],
          p[c + 1],
          p[c + 2],
          p[d],
          p[d + 1],
          p[d + 2],
          face + 1,
        );
        visited++;
      }
    }
    return { visited, exhausted: false };
  }

  /** Local X/Z are the exact Float32 instance offsets used by the grass shader. */
  sample(localX: number, localZ: number, out: TerrainGridSample): boolean {
    return this.sampleAt(localX, localZ, out, out);
  }

  /** Same indexed face and height as sample(), without evaluating an unused
   * face normal. Caller-owned output is unchanged on a miss. */
  sampleHeight(
    localX: number,
    localZ: number,
    out: TerrainGridHeightSample,
  ): boolean {
    return this.sampleAt(localX, localZ, out);
  }

  private sampleAt(
    localX: number,
    localZ: number,
    out: TerrainGridHeightSample,
    normalOut?: TerrainGridSample,
  ): boolean {
    const p = this.positions;
    const r = this.resolution;
    const last = r - 1;
    if (
      !Number.isFinite(localX) ||
      !Number.isFinite(localZ) ||
      localX < p[0] ||
      localX > p[last * 3] ||
      localZ < p[2] ||
      localZ > p[last * r * 3 + 2]
    )
      return false;
    let x = Math.min(
      last - 1,
      Math.floor(((localX + this.size / 2) * last) / this.size),
    );
    let z = Math.min(
      last - 1,
      Math.floor(((localZ + this.size / 2) * last) / this.size),
    );
    // Ideal grid division may round to the adjacent cell at a Float32 boundary.
    if (x > 0 && localX < p[x * 3]) x--;
    else if (x < last - 1 && localX >= p[(x + 1) * 3]) x++;
    if (z > 0 && localZ < p[z * r * 3 + 2]) z--;
    else if (z < last - 1 && localZ >= p[(z + 1) * r * 3 + 2]) z++;
    if (this.topology && this.refinedIndices) {
      const cell = z * last + x,
        indices = this.refinedIndices,
        offsets = this.topology.cellIndexOffsets;
      for (let i = offsets[cell]; i < offsets[cell + 1]; i += 3) {
        const a = indices[i] * 3,
          b = indices[i + 1] * 3,
          c = indices[i + 2] * 3;
        const abx = p[b] - p[a],
          abz = p[b + 2] - p[a + 2],
          acx = p[c] - p[a],
          acz = p[c + 2] - p[a + 2];
        const area = abz * acx - abx * acz;
        // Classify each edge independently. Deriving wa as area - wb - wc
        // loses the exact zero on an axis-aligned boundary to cancellation,
        // causing valid outer-edge points to miss every indexed face. Direct
        // edge determinants retain the original query and require no tolerance.
        const wa =
          (p[c + 2] - p[b + 2]) * (localX - p[b]) -
          (p[c] - p[b]) * (localZ - p[b + 2]);
        const wb =
          (p[a + 2] - p[c + 2]) * (localX - p[c]) -
          (p[a] - p[c]) * (localZ - p[c + 2]);
        const wc = abz * (localX - p[a]) - abx * (localZ - p[a + 2]);
        if (wa < 0 || wb < 0 || wc < 0) continue;
        out.height =
          p[a + 1] +
          (p[b + 1] - p[a + 1]) * (wb / area) +
          (p[c + 1] - p[a + 1]) * (wc / area);
        if (normalOut) {
          const aby = p[b + 1] - p[a + 1],
            acy = p[c + 1] - p[a + 1],
            nx = aby * acz - abz * acy,
            nz = abx * acy - aby * acx;
          const length = Math.hypot(nx, area, nz);
          normalOut.nx = nx / length;
          normalOut.ny = area / length;
          normalOut.nz = nz / length;
        }
        out.faceIndex = i / 3;
        return true;
      }
      return false;
    }
    const a = (z * r + x) * 3;
    const b = a + 3;
    const c = a + r * 3;
    const d = c + 3;
    const dx = p[b] - p[a];
    const dz = p[c + 2] - p[a + 2];
    const u = (localX - p[a]) / dx;
    const v = (localZ - p[a + 2]) / dz;
    const first = u + v <= 1;
    out.height = first
      ? (1 - u - v) * p[a + 1] + u * p[b + 1] + v * p[c + 1]
      : (1 - v) * p[b + 1] + (1 - u) * p[c + 1] + (u + v - 1) * p[d + 1];
    if (normalOut) {
      const sx = first
        ? (p[b + 1] - p[a + 1]) / dx
        : (p[d + 1] - p[c + 1]) / dx;
      const sz = first
        ? (p[c + 1] - p[a + 1]) / dz
        : (p[d + 1] - p[b + 1]) / dz;
      const length = Math.hypot(sx, 1, sz);
      normalOut.nx = -sx / length;
      normalOut.ny = 1 / length;
      normalOut.nz = -sz / length;
    }
    out.faceIndex = (z * last + x) * 2 + (first ? 0 : 1);
    return true;
  }
}
