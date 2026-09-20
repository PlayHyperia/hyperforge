import { createHash } from "node:crypto";
import THREE from "../../../../../extras/three/three";
import type { GrassTerrainSurfaceSnapshot } from "../../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import type {
  GrassBladeGroundingRequest,
  GrassBladeGroundingResult,
} from "../../GrassBladeGrounding";
import { getGrassBladeLayout } from "../../GrassBladeLayout";
import {
  createClumpGeometry,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
} from "../../GrassVisualManager";
import {
  projectGrassAnchors,
  type GrassAnchorData,
} from "../../GrassTerrainProjection";
import {
  RetainedTerrainSurface,
  type TerrainCellTopology,
} from "../../TerrainGridSurface";
import { gridGeometry } from "../terrain-grid.fixture";

type Point = readonly [number, number, number?, number?];
const emptySnapshot = (): GrassTerrainSurfaceSnapshot => ({
  schemaVersion: 1,
  zones: [],
  waterBodies: [],
  arenaFloorIds: [],
  arenaGradeHeight: null,
});

/** Actual admitted indexed triangles: nonplanar five-face fans above regular
 * cells, with a shared edge cut. No renderer, worker or surface method doubles. */
function refinedGeometry(skinny = false) {
  const geometry = gridGeometry(100, 3, (x, z) => 20 + x * 0.02 + z * 0.01);
  const values = Array.from(geometry.getAttribute("position").array);
  values.push(
    0,
    20.7,
    -25,
    skinny ? -0.0001 : -25,
    skinny ? 20.7 : 23,
    -25,
    25,
    19.2,
    -25,
  );
  const indices: number[] = [],
    offsets = [0];
  for (const [center, boundary] of [
    [10, [0, 3, 4, 9, 1]],
    [11, [1, 9, 4, 5, 2]],
  ] as const) {
    for (let i = 0; i < boundary.length; i++)
      indices.push(center, boundary[i], boundary[(i + 1) % boundary.length]);
    offsets.push(indices.length);
  }
  indices.push(3, 6, 4, 4, 6, 7);
  offsets.push(indices.length);
  indices.push(4, 7, 5, 5, 7, 8);
  offsets.push(indices.length);
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(values), 3),
  );
  geometry.setIndex(indices);
  const topology: TerrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution: 3,
    cellIndexOffsets: Object.freeze(offsets),
    surfaceVertexCount: 12,
  });
  geometry.userData.terrainCellTopology = topology;
  return geometry;
}

/** A genuine indexed owner, even when every cell retains its two original
 * faces. The optional first-cell fan shifts every subsequent face index by
 * two without changing any canonical neighbor's six vertex IDs. */
function indexedCanonicalGeometry(firstCellFan = false) {
  const resolution = 5;
  const geometry = gridGeometry(
    128,
    resolution,
    (x, z) => 20 + Math.sin(x * 0.03) * 0.5 + Math.cos(z * 0.04) * 0.3,
  );
  const values = Array.from(geometry.getAttribute("position").array);
  const indices: number[] = [],
    offsets = [0];
  if (firstCellFan) values.push(-48, 24, -48);
  for (let z = 0; z < resolution - 1; z++)
    for (let x = 0; x < resolution - 1; x++) {
      const a = z * resolution + x;
      if (firstCellFan && x === 0 && z === 0) {
        const boundary = [a, a + resolution, a + resolution + 1, a + 1];
        for (let i = 0; i < 4; i++)
          indices.push(25, boundary[i], boundary[(i + 1) % 4]);
      } else
        indices.push(
          a,
          a + resolution,
          a + 1,
          a + 1,
          a + resolution,
          a + resolution + 1,
        );
      offsets.push(indices.length);
    }
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(values), 3),
  );
  geometry.setIndex(indices);
  geometry.userData.terrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution,
    cellIndexOffsets: Object.freeze(offsets),
    surfaceVertexCount: values.length / 3,
  } satisfies TerrainCellTopology);
  return geometry;
}

/** Adjacent representable *input* coordinates, not a decimal epsilon that
 * disappears when the worker/projection stores the anchor in Float32. */
function adjacentFloat32(value: number, direction: -1 | 1) {
  const floats = new Float32Array([value]);
  const bits = new Uint32Array(floats.buffer);
  bits[0] += value < 0 ? -direction : direction;
  return floats[0];
}

export const INDEXED_SAME_FACE_CASES = [
  "indexed-canonical-interiors",
  "indexed-mixed-canonical",
  "indexed-shifted-canonical",
  "indexed-refined-only",
  "indexed-cell-boundaries",
  "indexed-diagonal-boundaries",
  "indexed-translated-canonical",
] as const;

export const SAME_FACE_CASES = [
  "ordinary-lod0",
  "ordinary-lod1",
  "ordinary-lod2",
  "fine-lod0",
  "fine-lod1",
  "fine-lod2",
  "fine-near4",
  "fine-dense-flat",
  "fine-dense-plane",
  "fine-dense-nonplanar",
  "regular-cell-boundaries",
  "regular-diagonal-boundaries",
  "refined-interiors",
  "refined-boundaries",
  "refined-skinny-neighbor",
  "adjacent-owners",
  "adjacent-reversed",
  "missing-neighbor",
  "overlapping-owners",
  "mixed-exclusions",
  "terrain-edge-rejection",
  "empty",
  "budget-one",
  ...INDEXED_SAME_FACE_CASES,
] as const;
export type SameFaceCase = (typeof SAME_FACE_CASES)[number];

export function createSameFaceCase(id: SameFaceCase) {
  const fine = !id.startsWith("ordinary") && id !== "terrain-edge-rejection";
  const lod: 0 | 1 | 2 = id.endsWith("lod2")
    ? 2
    : id.endsWith("lod1")
      ? 1
      : id === "terrain-edge-rejection"
        ? 1
        : 0;
  const geometryLayout = fine
    ? id === "fine-near4"
      ? "fine-linear-sweep-near4-v1"
      : "fine-linear-sweep-3seg-v1"
    : undefined;
  const layout = getGrassBladeLayout(lod, geometryLayout);
  const blade = createClumpGeometry(
    layout.bladesPerClump,
    layout.bladeSegments,
    fine ? FINE_MEADOW_APPEARANCE : GRASS_CONFIG,
  );
  const geometries: THREE.BufferGeometry[] = [blade];
  const owned: {
    surface: RetainedTerrainSurface;
    geometry: THREE.BufferGeometry;
  }[] = [];
  const height =
    id === "fine-dense-plane"
      ? (x: number, z: number) => 20 + 0.12 * x - 0.07 * z
      : id === "fine-dense-nonplanar"
        ? (x: number, z: number) =>
            20 + Math.sin(x * 0.12) * 1.3 + Math.cos(z * 0.17) * 0.7
        : id === "terrain-edge-rejection"
          ? (x: number) => 20 + 20 * Math.abs(x)
          : () => 20;
  const make = (
    nodeId: number,
    centerX = 0,
    resolution = 16,
    size = 100,
    refined = false,
    centerZ = 0,
  ) => {
    const geometry =
      id === "indexed-mixed-canonical" || id === "indexed-refined-only"
        ? refinedGeometry()
        : id.startsWith("indexed-")
          ? indexedCanonicalGeometry(id === "indexed-shifted-canonical")
          : refined
            ? refinedGeometry(id === "refined-skinny-neighbor")
            : gridGeometry(size, resolution, (x, z) => height(x + centerX, z));
    geometries.push(geometry);
    const surface = new RetainedTerrainSurface(
      nodeId,
      "same-face-numerical-v1",
      centerX,
      centerZ,
      size,
      resolution,
      geometry,
    );
    owned.push({ surface, geometry });
    return surface;
  };
  const own = make(
    101,
    id === "indexed-translated-canonical" ? 4096 : 0,
    id.startsWith("refined") ||
      id === "terrain-edge-rejection" ||
      id === "indexed-mixed-canonical" ||
      id === "indexed-refined-only"
      ? 3
      : id.startsWith("indexed-")
        ? 5
        : 16,
    id.startsWith("indexed-") &&
      id !== "indexed-mixed-canonical" &&
      id !== "indexed-refined-only"
      ? 128
      : 100,
    id.startsWith("refined"),
    id === "indexed-translated-canonical" ? -2048 : 0,
  );
  let points: Point[] = [
    [-17.2, -11.4, 0.13],
    [-8.1, 6.3, 1.27],
    [13.2, -16.7, 3.18],
    [25.4, 20.1, 5.31],
  ];
  if (id.startsWith("fine-dense"))
    points = Array.from({ length: 64 }, (_, i) => [
      -34 + (i % 8) * 8,
      -31 + Math.floor(i / 8) * 7.7,
      (i * 0.137) % (Math.PI * 2),
      0.8 + (i % 5) * 0.1,
    ]);
  if (id === "regular-cell-boundaries") {
    const p = owned[0].geometry.getAttribute("position"),
      x = p.getX(7),
      z = p.getZ(7 * 16);
    points = [
      [x, z],
      [x - 1e-5, z + 1e-5, 0.7],
      [x + 1e-5, z - 1e-5, 2.1],
      [x, z + 0.2, 4.2],
    ];
  }
  if (id === "regular-diagonal-boundaries")
    points = [
      [0, 0],
      [-0.00001, 0, 0.7],
      [0.00001, 0, 1.9],
      [-13.333333, 13.333333, 3.7],
    ];
  if (id === "refined-interiors")
    points = [
      [-36, -35, 0.17],
      [-32, -10, 1.7],
      [30, -14, 2.9],
      [-25, 24, 3.1],
      [22, 27, 5.5],
    ];
  if (id === "refined-boundaries")
    points = [
      [0, -25],
      [-0.00001, -25, 0.8],
      [0.00001, -25, 2.9],
      [-25, -25, 4.2],
      [25, -25, 5.1],
      [0, 0, 0.37],
    ];
  if (id === "refined-skinny-neighbor")
    points = [
      [-1e-10, -12.5, 0.33, 1e-8],
      [-1e-9, -12.5, 1.7, 1e-8],
      [-1e-8, -12.5, 3.1, 1e-8],
    ];
  if (id === "indexed-canonical-interiors")
    points = Array.from({ length: 32 }, (_, i) => {
      const cell = Math.floor(i / 2),
        x = -64 + (cell % 4) * 32,
        z = -64 + Math.floor(cell / 4) * 32;
      return [
        x + (i % 2 ? 24 : 7),
        z + (i % 2 ? 21 : 9),
        i * 0.17,
        0.8 + (i % 3) * 0.1,
      ];
    });
  if (id === "indexed-mixed-canonical")
    points = [
      [-25, 24, 3.1],
      [22, 27, 5.5],
      [-37, 12, 0.37],
      [35, 38, 1.41],
    ];
  if (id === "indexed-shifted-canonical")
    points = [
      [-24, -53, 0.17],
      [-7, -41, 1.7],
      [7, -55, 2.9],
      [24, -39, 3.1],
      [-53, -23, 5.5],
      [-40, -7, 0.47],
    ];
  if (id === "indexed-refined-only")
    points = [
      [-36, -35, 0.17],
      [-32, -10, 1.7],
      [30, -14, 2.9],
    ];
  if (id === "indexed-cell-boundaries")
    points = [
      [-32, -49, 0.33, 1e-8],
      [adjacentFloat32(-32, -1), -49, 0.33, 1e-8],
      [adjacentFloat32(-32, 1), -49, 0.33, 1e-8],
      [-49, -32, 1.7, 1e-8],
      [-49, adjacentFloat32(-32, -1), 1.7, 1e-8],
      [-49, adjacentFloat32(-32, 1), 1.7, 1e-8],
    ];
  if (id === "indexed-diagonal-boundaries")
    points = [
      [-48, -48, 0.33, 1e-8],
      [adjacentFloat32(-48, -1), -48, 0.33, 1e-8],
      [adjacentFloat32(-48, 1), -48, 0.33, 1e-8],
    ];
  const surfaces = [own];
  if (
    id.startsWith("adjacent") ||
    id === "missing-neighbor" ||
    id === "overlapping-owners"
  ) {
    points = [
      [49.8, -9, 0.17],
      [49.8, 0, 1.7],
      [49.8, 8, 3.1],
    ];
    if (id !== "missing-neighbor") surfaces.push(make(202, 100, 64));
    if (id === "adjacent-reversed") surfaces.reverse();
    if (id === "overlapping-owners") surfaces.push(make(303, 50, 16, 200));
  }
  if (id === "mixed-exclusions")
    points = [
      [-20, -10],
      [0, 0],
      [10, 10],
      [20, 0],
      [30, -10],
    ];
  if (id === "terrain-edge-rejection") {
    const p = blade.getAttribute("position"),
      ny = 1 / Math.hypot(20, 1);
    points = [
      [(-(p.getX(0) + p.getX(1)) / 2) * ny, -(p.getZ(0) + p.getZ(1)) / 2],
    ];
  }
  if (id === "empty") points = [];
  const raw: GrassAnchorData = {
    count: points.length,
    offsets: new Float32Array(points.length * 3),
    rotScaleHash: new Float32Array(points.length * 3),
    groundColors: new Float32Array(points.length * 3),
    grassTints: new Float32Array(points.length * 4),
    groundNormals: new Float32Array(points.length * 3),
  };
  points.forEach(([x, z, rotation = 0, scale = 1], i) => {
    raw.offsets.set([x, 20, z], i * 3);
    raw.rotScaleHash.set([rotation, scale, 0.2 + i / 1000], i * 3);
    raw.groundColors.set([0.1 + i / 1000, 0.3, 0.2], i * 3);
    raw.grassTints.set([1, 0.9, 0.8, 0.2 + i / 1000], i * 4);
    raw.groundNormals.set([0, 1, 0], i * 3);
  });
  const data = projectGrassAnchors(
    raw,
    own,
    () => -1000,
    () => false,
  );
  const request: GrassBladeGroundingRequest = {
    data,
    lod,
    geometry: blade,
    ...(geometryLayout ? { geometryLayout } : {}),
    ownSurface: own,
    surfaces,
    terrainSurface: emptySnapshot(),
    roadSegments: [],
    oceanLevel: 0,
    wind: { x: 0.4, z: 0.165 },
  };
  if (id === "mixed-exclusions") {
    request.terrainSurface.zones.push({
      id: "pad",
      centerX: -20,
      centerZ: -10,
      width: 4,
      depth: 4,
      height: 20,
      blendRadius: 0,
    });
    request.roadSegments = [
      { startX: 0, startZ: -30, endX: 0, endZ: 30, width: 2 },
    ];
    request.terrainSurface.waterBodies.push({
      id: "water",
      centerX: 10,
      centerZ: 10,
      radius: 4,
      surfaceY: 20,
    });
  }
  if (id === "terrain-edge-rejection") request.maximumBaseError = 0.001;
  if (id === "refined-skinny-neighbor") request.wind = { x: 0, z: 0 };
  if (id === "budget-one") request.workBudget = 1;
  return {
    request,
    owned,
    geometries,
    dispose: () => geometries.forEach((geometry) => geometry.dispose()),
  };
}

function rawBytes(values: ArrayBufferView) {
  return Buffer.from(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  ).toString("hex");
}
export function sameFaceSemantic(result: GrassBladeGroundingResult) {
  // Only measured work/timing and the new diagnostic hit counter may differ.
  // Unknown receipt fields remain included so future semantic changes fail.
  const receipt = Object.fromEntries(
    Object.entries(result.receipt).filter(
      ([key]) =>
        !["elapsedMs", "triangleVisits", "workUnits", "sameFaceEdges"].includes(
          key,
        ),
    ),
  );
  return {
    keys: Object.keys(result).sort(),
    status: result.status,
    ...(result.status === "defer"
      ? { reason: result.reason }
      : {
          count: result.data.count,
          arrays: Object.fromEntries(
            [
              "offsets",
              "rotScaleHash",
              "groundColors",
              "grassTints",
              "groundNormals",
            ].map((key) => [
              key,
              rawBytes(
                result.data[key as keyof Omit<GrassAnchorData, "count">],
              ),
            ]),
          ),
          rootDeltas: rawBytes(result.rootDeltas),
          sourceIndices: rawBytes(result.sourceIndices),
          sweptBounds: result.sweptBounds,
        }),
    dependencies: result.dependencies.map(({ surface, uses }) => ({
      nodeId: surface.nodeId,
      uses: [...uses],
    })),
    receipt,
  };
}
export function sameFaceHash(result: GrassBladeGroundingResult) {
  return createHash("sha256")
    .update(JSON.stringify(sameFaceSemantic(result)))
    .digest("hex");
}
export function sameFaceInputHash(
  value: ReturnType<typeof createSameFaceCase>,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        data: Object.fromEntries(
          Object.entries(value.request.data)
            .filter(([key]) => key !== "grounding")
            .map(([key, values]) => [
              key,
              typeof values === "number" ? values : rawBytes(values),
            ]),
        ),
        geometries: value.geometries.map((geometry) => ({
          attributes: Object.fromEntries(
            Object.entries(geometry.attributes).map(([key, attribute]) => [
              key,
              rawBytes(attribute.array),
            ]),
          ),
          index: geometry.index ? rawBytes(geometry.index.array) : null,
        })),
        terrainSurface: value.request.terrainSurface,
        roads: value.request.roadSegments,
      }),
    )
    .digest("hex");
}

export function drainSameFaceSteps(
  steps: Generator<string, GrassBladeGroundingResult, void>,
) {
  let operations = 0;
  for (;;) {
    const next = steps.next();
    operations++;
    if (operations > 1_000_000)
      throw new Error("Same-face fixture exceeded the unchanged operation cap");
    if (next.done) return { result: next.value, operations };
  }
}
