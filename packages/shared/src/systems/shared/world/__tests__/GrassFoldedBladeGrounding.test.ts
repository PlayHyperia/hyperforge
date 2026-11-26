import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  FINE_GRASS_FOLDED_BLADE_INDICES,
  getFoldedGrassBladeIndices,
  getGrassBladeLayout,
  isFoldedGrassBladeLayout,
  usesGrassBladeHeightFlex,
} from "../GrassBladeLayout";
import {
  GRASS_BLADE_GROUNDING_LIMITS,
  GrassBladeGroundingJob,
  captureGrassBankVerge,
  groundGrassBlades,
  type GrassBladeGroundingRequest,
} from "../GrassBladeGrounding";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import {
  createClumpGeometry,
  FINE_GRASS_FOLDED_BLADE_SHAPE,
} from "../GrassVisualManager";
import { gridGeometry } from "./terrain-grid.fixture";
import {
  bundleGrassGroundingWorker,
  createActualGroundingWorker,
  createGrassGroundingWorkerRequest,
  grassGroundingWorkerSemanticResult,
  runGrassGroundingWorker,
} from "./fixtures/GrassGroundingWorkerHarness";

const layoutId = "fine-folded-lancet-v1" as const;
const sheathLayoutId = "fine-folded-sheath-near5-v1" as const;
const groundingLayouts = [layoutId, sheathLayoutId] as const;

// Independent of the production layout/wind helper: source height recovers
// physical leaf height, while B/.95 is its normalized longitudinal height.
function foldedFlex(t: number, rawY: number, scale: number) {
  const height = 1.52 * t - 0.57 * t * t;
  const relativeHeight = Math.min(
    1,
    (scale * rawY) / (Math.max(height, 1e-5) * 0.86),
  );
  return relativeHeight * (height / 0.95) ** 2;
}

function bankFixture(heightScale: number) {
  return {
    minX: -3,
    maxX: 3,
    minZ: -3,
    maxZ: 3,
    feather: 2,
    wearStart: 0.1,
    wearEnd: 0.8,
    minimumScale: 0.55,
    heightScale,
    wear: [],
    wornHeightScale: heightScale,
    grassTint: [0.96, 0.88, 1] as const,
    tipBrightness: 1.08,
  };
}

type BladeBox = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/** Exact flat retained-plane oracle, with the actual authored buffers and
 * Float32 instance scale/yaw. No production wind or clearance math is reused. */
function bladeBoxes(
  f: ReturnType<typeof fixture>,
  bankHeight: number,
  legacy = false,
): BladeBox[] {
  const position = f.geometry.getAttribute("position");
  const uv = f.geometry.getAttribute("uv");
  const [yaw, scale] = f.request.data.rotScaleHash;
  return Array.from({ length: f.layout.bladesPerClump }, (_, blade) => {
    const box = {
      minX: Infinity,
      maxX: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };
    for (let local = 0; local < f.layout.verticesPerBlade; local++) {
      const vertex = blade * f.layout.verticesPerBlade + local;
      const t = uv.getY(vertex);
      const flex = legacy
        ? t ** 1.8
        : foldedFlex(t, position.getY(vertex), scale);
      const x =
        (position.getX(vertex) * Math.cos(yaw) -
          position.getZ(vertex) * Math.sin(yaw)) *
        scale;
      const z =
        (position.getX(vertex) * Math.sin(yaw) +
          position.getZ(vertex) * Math.cos(yaw)) *
        scale;
      const dx = f.request.wind.x * bankHeight * flex;
      const dz = f.request.wind.z * bankHeight * flex;
      box.minX = Math.min(box.minX, x - dx - 0.00001);
      box.maxX = Math.max(box.maxX, x + dx + 0.00001);
      box.minZ = Math.min(box.minZ, z - dz - 0.00001);
      box.maxZ = Math.max(box.maxZ, z + dz + 0.00001);
    }
    return box;
  });
}

// The vertical road spans every fixture blade in Z. Its exact hard-exclusion
// interval is [left, left + width], with no implicit shoulder feather.
function roadMask(boxes: readonly BladeBox[], left: number, width: number) {
  return boxes.reduce(
    (mask, box, blade) =>
      box.maxX >= left && box.minX <= left + width ? mask : mask | (1 << blade),
    0,
  );
}

function roadAt(left: number, width: number) {
  return {
    startX: left + width / 2,
    endX: left + width / 2,
    startZ: -5,
    endZ: 5,
    width,
    blendWidth: 0,
  };
}

/** Real generated blades and retained terrain; these CPU proofs are not GPU
 * contact, visual quality, native performance or acceptance evidence. */
function fixture(
  lod: 0 | 1 | 2 = 0,
  size = 100,
  geometryLayout: (typeof groundingLayouts)[number] = layoutId,
) {
  const layout = getGrassBladeLayout(lod, geometryLayout);
  const geometry = createClumpGeometry(
    layout.bladesPerClump,
    layout.bladeSegments,
    FINE_GRASS_FOLDED_BLADE_SHAPE,
    geometryLayout === sheathLayoutId
      ? lod === 0
        ? "folded-sheath-v1"
        : lod === 1
          ? "folded-lancet-v1"
          : undefined
      : lod === 0
        ? "folded-lancet-v1"
        : undefined,
  );
  const terrainGeometry = gridGeometry(size, 4, () => 20);
  const surface = new RetainedTerrainSurface(
    1,
    "folded-grounding-fixture",
    0,
    0,
    size,
    4,
    terrainGeometry,
  );
  const data = projectGrassAnchors(
    {
      count: 1,
      offsets: new Float32Array([0, 20, 0]),
      rotScaleHash: new Float32Array([0, 1, 0.4]),
      groundColors: new Float32Array([0.2, 0.3, 0.1]),
      grassTints: new Float32Array([1, 1, 1, 0.2]),
      groundNormals: new Float32Array([0, 1, 0]),
    },
    surface,
    () => -1000,
    () => false,
  );
  const request: GrassBladeGroundingRequest = {
    data,
    lod,
    geometryLayout,
    geometry,
    ownSurface: surface,
    surfaces: [surface],
    terrainSurface: {
      schemaVersion: 1,
      zones: [],
      waterBodies: [],
      arenaFloorIds: [],
      arenaGradeHeight: null,
    },
    roadSegments: [],
    oceanLevel: 0,
    wind: { x: 0.2, z: 0.11 },
  };
  return {
    layout,
    geometry,
    request,
    close() {
      geometry.dispose();
      terrainGeometry.dispose();
    },
  };
}

describe("explicit folded-lancet topology and CPU grounding", () => {
  it("keeps historical tier contracts and adds no root storage components", () => {
    expect(FINE_GRASS_FOLDED_BLADE_INDICES).toEqual([
      0, 1, 7, 0, 7, 2, 1, 3, 7, 2, 7, 4, 7, 8, 4, 7, 3, 8, 3, 5, 8, 4, 8, 6, 8,
      5, 6,
    ]);
    expect(Object.isFrozen(FINE_GRASS_FOLDED_BLADE_INDICES)).toBe(true);
    expect(getGrassBladeLayout(0, layoutId)).toEqual({
      geometryLayout: layoutId,
      lod: 0,
      bladesPerClump: 24,
      bladeSegments: 3,
      verticesPerBlade: 9,
      verticesPerClump: 216,
      trianglesPerClump: 216,
      rootComponents: 2,
    });
    for (const lod of [0, 1, 2]) {
      const legacy = getGrassBladeLayout(lod);
      const three = getGrassBladeLayout(lod, "fine-linear-sweep-3seg-v1");
      const four = getGrassBladeLayout(lod, "fine-linear-sweep-near4-v1");
      expect(three).toEqual({
        ...legacy,
        geometryLayout: three.geometryLayout,
      });
      expect(four.verticesPerClump).toBe([216, 60, 12][lod]);
      expect(four.trianglesPerClump).toBe([168, 36, 4][lod]);
      if (lod !== 0)
        expect(getGrassBladeLayout(lod, layoutId)).toEqual({
          ...legacy,
          geometryLayout: layoutId,
        });
    }
    expect(GRASS_BLADE_GROUNDING_LIMITS.defaultWorkBudget).toBe(1_000_000);
    expect(GRASS_BLADE_GROUNDING_LIMITS.maximumWorkBudget).toBe(1_000_000);
  });

  it.each(
    groundingLayouts.flatMap((geometryLayout) =>
      ([0, 1, 2] as const).map((lod) => ({ geometryLayout, lod })),
    ),
  )(
    "grounds actual $geometryLayout LOD$lod with exact per-blade root correction ownership",
    ({ geometryLayout, lod }) => {
      const f = fixture(lod, 100, geometryLayout);
      try {
        const before = structuredClone(f.request.data);
        const positionBefore = f.geometry
          .getAttribute("position")
          .array.slice();
        const result = groundGrassBlades(f.request);
        if (result.status !== "ready") throw new Error(result.reason);
        expect(result.receipt.geometryLayout).toBe(geometryLayout);
        expect(result.data.count).toBe(1);
        expect(result.rootDeltas.length).toBe(f.layout.bladesPerClump * 2);
        expect(result.receipt.correctionBytes).toBe(
          result.rootDeltas.byteLength,
        );
        // Even a constant plane uses barycentric products and sums: its
        // sampled double can differ from 20 by a few machine ulps. Assert
        // the exact Float32 correction at each actual root, not a fictitious
        // zero/burial offset, and independently bound that numerical residual.
        const positions = f.geometry.getAttribute("position");
        const sample = { height: 0, faceIndex: 0 };
        for (let blade = 0; blade < f.layout.bladesPerClump; blade++)
          for (let side = 0; side < 2; side++) {
            const vertex = blade * f.layout.verticesPerBlade + side;
            expect(positions.getY(vertex)).toBe(0);
            expect(
              f.request.ownSurface.sampleHeight(
                positions.getX(vertex),
                positions.getZ(vertex),
                sample,
              ),
            ).toBe(true);
            const correction = result.rootDeltas[blade * 2 + side];
            expect(correction).toBe(Math.fround(sample.height - 20));
            expect(Math.abs(correction)).toBeLessThanOrEqual(
              20 * Number.EPSILON * 8,
            );
          }
        expect(f.request.data).toEqual(before);
        expect(f.geometry.getAttribute("position").array).toEqual(
          positionBefore,
        );
      } finally {
        f.close();
      }
    },
  );

  it.each(
    groundingLayouts.flatMap((geometryLayout) =>
      ([0, 1, 2] as const).flatMap((lod) =>
        [0.7, 1, 1.3].flatMap((scale) =>
          [1, 0.65].map((bankHeight) => ({
            geometryLayout,
            lod,
            scale,
            bankHeight,
          })),
        ),
      ),
    ),
  )(
    "fits $geometryLayout LOD$lod sweeps and road masks at scale$scale / bank$bankHeight",
    ({ geometryLayout, lod, scale, bankHeight }) => {
      const f = fixture(lod, 100, geometryLayout);
      try {
        f.request.data.rotScaleHash[0] = 0.73;
        f.request.data.rotScaleHash[1] = scale;
        const request = {
          ...f.request,
          bankVerge: bankFixture(bankHeight),
          roadClearance: "per-blade-v1" as const,
        };
        const boxes = bladeBoxes(f, bankHeight);
        const result = groundGrassBlades(request);
        if (result.status !== "ready" || !result.sweptBounds)
          throw new Error("Expected complete real-geometry sweep");
        expect(result.data.count).toBe(1);
        expect(result.bladeVisibility?.[0]).toBe(
          2 ** f.layout.bladesPerClump - 1,
        );
        for (const axis of ["X", "Z"] as const) {
          expect(result.sweptBounds[`min${axis}`]).toBeCloseTo(
            Math.min(...boxes.map((box) => box[`min${axis}`])),
            9,
          );
          expect(result.sweptBounds[`max${axis}`]).toBeCloseTo(
            Math.max(...boxes.map((box) => box[`max${axis}`])),
            9,
          );
        }
        const position = f.geometry.getAttribute("position");
        const uv = f.geometry.getAttribute("uv");
        const actualScale = f.request.data.rotScaleHash[1];
        for (let blade = 0; blade < f.layout.bladesPerClump; blade++)
          for (const side of [0, 1]) {
            const vertex = blade * f.layout.verticesPerBlade + side;
            expect(uv.getY(vertex)).toBe(0);
            expect(position.getY(vertex)).toBe(0);
            expect(foldedFlex(0, position.getY(vertex), actualScale)).toBe(0);
            expect(Math.abs(result.rootDeltas[blade * 2 + side])).toBeLessThan(
              1e-12,
            );
          }
        const maxHeight = Math.max(
          ...Array.from({ length: position.count }, (_, i) => position.getY(i)),
        );
        expect(result.sweptBounds.minY).toBeCloseTo(20 - 0.00001, 9);
        expect(result.sweptBounds.maxY).toBeCloseTo(
          20 + maxHeight * actualScale * bankHeight + 0.00001,
          9,
        );
        // Every real edge/ridge/tip remains inside the certified CPU envelope
        // at both wind extrema and all distance-collapse endpoints. This is
        // independent arithmetic, not a claim of GPU contact or shader execution.
        for (let vertex = 0; vertex < position.count; vertex++) {
          const blade = Math.floor(vertex / f.layout.verticesPerBlade);
          const u = uv.getX(vertex);
          const correction =
            result.rootDeltas[blade * 2] * (1 - u) +
            result.rootDeltas[blade * 2 + 1] * u;
          const yaw = f.request.data.rotScaleHash[0];
          const x =
            (position.getX(vertex) * Math.cos(yaw) -
              position.getZ(vertex) * Math.sin(yaw)) *
            actualScale;
          const z =
            (position.getX(vertex) * Math.sin(yaw) +
              position.getZ(vertex) * Math.cos(yaw)) *
            actualScale;
          const flex = foldedFlex(
            uv.getY(vertex),
            position.getY(vertex),
            actualScale,
          );
          for (const fade of [0, 0.5, 1])
            for (const signX of [-1, 1])
              for (const signZ of [-1, 1]) {
                const point = {
                  X: x + signX * request.wind.x * bankHeight * flex,
                  Y:
                    20 +
                    position.getY(vertex) * actualScale * bankHeight * fade +
                    correction,
                  Z: z + signZ * request.wind.z * bankHeight * flex,
                };
                for (const axis of ["X", "Y", "Z"] as const) {
                  expect(point[axis]).toBeGreaterThanOrEqual(
                    result.sweptBounds[`min${axis}`],
                  );
                  expect(point[axis]).toBeLessThanOrEqual(
                    result.sweptBounds[`max${axis}`],
                  );
                }
              }
        }
        // A nonzero-width road through the middle of actual blade extrema
        // exercises retained and hidden blades at every scale and every LOD.
        const sorted = boxes.map((box) => box.maxX).sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const left = (sorted[middle - 1] + sorted[middle]) / 2;
        const width = 0.05;
        const expectedMask = roadMask(boxes, left, width);
        expect(expectedMask).toBeGreaterThan(0);
        expect(expectedMask).toBeLessThan(2 ** f.layout.bladesPerClump - 1);
        const masked = groundGrassBlades({
          ...request,
          roadSegments: [roadAt(left, width)],
        });
        if (masked.status !== "ready") throw new Error(masked.reason);
        expect(masked.data.count).toBe(1);
        expect(masked.bladeVisibility?.[0]).toBe(expectedMask);
        expect(masked.rootDeltas).toEqual(result.rootDeltas);
        expect(masked.receipt.workBudget).toBe(1_000_000);
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ...([0, 1] as const).map((lod) => ({ lod, geometryLayout: layoutId })),
    ...([0, 1, 2] as const).map((lod) => ({
      lod,
      geometryLayout: sheathLayoutId,
    })),
  ])(
    "masks an actual $geometryLayout LOD$lod intermediate-row sweep missed by the old exponent",
    ({ lod, geometryLayout }) => {
      const f = fixture(lod, 100, geometryLayout);
      try {
        f.request.data.rotScaleHash[1] = 1.3;
        let witness:
          | { blade: number; left: number; mask: number; oldMask: number }
          | undefined;
        // Bounded deterministic selection, never geometry mutation: find a
        // real blade/yaw where the new intermediate row extends beyond the
        // entire old blade AABB. A mere larger per-vertex factor is insufficient.
        for (let angle = 0; angle < 128 && !witness; angle++) {
          f.request.data.rotScaleHash[0] = (angle * Math.PI * 2) / 128;
          const current = bladeBoxes(f, 1);
          const previous = bladeBoxes(f, 1, true);
          for (let blade = 0; blade < current.length; blade++) {
            if (current[blade].maxX - previous[blade].maxX <= 0.0001) continue;
            const left = (current[blade].maxX + previous[blade].maxX) / 2;
            const mask = roadMask(current, left, 0.002);
            const oldMask = roadMask(previous, left, 0.002);
            if (mask && !(mask & (1 << blade)) && oldMask & (1 << blade)) {
              witness = { blade, left, mask, oldMask };
              break;
            }
          }
        }
        expect(
          witness,
          "Actual intermediate-row under-bound witness",
        ).toBeDefined();
        if (!witness) throw new Error("No deterministic wind-envelope witness");
        const position = f.geometry.getAttribute("position");
        const uv = f.geometry.getAttribute("uv");
        const first = witness.blade * f.layout.verticesPerBlade;
        expect(
          Array.from({ length: f.layout.verticesPerBlade }, (_, i) => first + i)
            .filter((v) => uv.getY(v) > 0 && uv.getY(v) < 1)
            .some(
              (v) =>
                foldedFlex(
                  uv.getY(v),
                  position.getY(v),
                  f.request.data.rotScaleHash[1],
                ) >
                uv.getY(v) ** 1.8,
            ),
        ).toBe(true);
        expect(witness.oldMask & (1 << witness.blade)).not.toBe(0);
        const result = groundGrassBlades({
          ...f.request,
          roadClearance: "per-blade-v1",
          roadSegments: [roadAt(witness.left, 0.002)],
        });
        if (result.status !== "ready") throw new Error(result.reason);
        expect(result.data.count).toBe(1);
        expect(result.bladeVisibility?.[0]).toBe(witness.mask);
        expect(result.bladeVisibility![0] & (1 << witness.blade)).toBe(0);
      } finally {
        f.close();
      }
    },
  );

  it.each([0, 1, 2] as const)(
    "retains exact exponent sweeps for historical LOD%s layouts",
    (lod) => {
      const f = fixture(lod);
      const geometry = createClumpGeometry(
        f.layout.bladesPerClump,
        f.layout.bladeSegments,
        FINE_GRASS_FOLDED_BLADE_SHAPE,
      );
      try {
        f.request.data.rotScaleHash[0] = 0.73;
        f.request.data.rotScaleHash[1] = 1.3;
        const legacy = {
          ...f,
          geometry,
          layout: getGrassBladeLayout(lod, "fine-linear-sweep-3seg-v1"),
        };
        const boxes = bladeBoxes(legacy, 1, true);
        for (const geometryLayout of [
          undefined,
          "fine-linear-sweep-3seg-v1",
        ] as const) {
          const result = groundGrassBlades({
            ...f.request,
            geometry,
            geometryLayout,
          });
          if (result.status !== "ready" || !result.sweptBounds)
            throw new Error("Expected retained historical sweep");
          expect(result.data.count).toBe(1);
          for (const axis of ["X", "Z"] as const) {
            expect(result.sweptBounds[`min${axis}`]).toBeCloseTo(
              Math.min(...boxes.map((box) => box[`min${axis}`])),
              9,
            );
            expect(result.sweptBounds[`max${axis}`]).toBeCloseTo(
              Math.max(...boxes.map((box) => box[`max${axis}`])),
              9,
            );
          }
        }
      } finally {
        geometry.dispose();
        f.close();
      }
    },
  );

  it.each(groundingLayouts)(
    "admits explicit %s for existing bank deformation",
    (geometryLayout) => {
      const bankVerge = {
        minX: -3,
        maxX: 3,
        minZ: -3,
        maxZ: 3,
        feather: 2,
        wearStart: 0.1,
        wearEnd: 0.8,
        minimumScale: 0.55,
        heightScale: 0.65,
        wear: [],
        wornHeightScale: 0.65,
        grassTint: [0.96, 0.88, 1] as const,
        tipBrightness: 1.08,
      };
      const f = fixture(0, 100, geometryLayout);
      try {
        expect(captureGrassBankVerge({ geometryLayout, bankVerge })).toEqual(
          bankVerge,
        );
        expect(() => captureGrassBankVerge({ bankVerge })).toThrow(
          /descriptor/,
        );
        const result = groundGrassBlades({ ...f.request, bankVerge });
        if (result.status !== "ready") throw new Error(result.reason);
        expect(result.data.count).toBe(1);
        const original = groundGrassBlades(f.request);
        if (original.status !== "ready") throw new Error(original.reason);
        expect(result.rootDeltas).toEqual(original.rootDeltas);
      } finally {
        f.close();
      }
    },
  );

  it("rejects old layouts, malformed centers and altered folded-face winding", () => {
    const f = fixture();
    try {
      for (const geometryLayout of [
        undefined,
        "fine-linear-sweep-3seg-v1",
        "fine-linear-sweep-near4-v1",
      ] as const)
        expect(() =>
          groundGrassBlades({ ...f.request, geometryLayout }),
        ).toThrow(/geometry|vertex|triangle/);
      const mutations: ((geometry: THREE.BufferGeometry) => void)[] = [
        (geometry) => geometry.getAttribute("uv").setX(7, 0),
        (geometry) => geometry.getAttribute("uv").setY(8, 0.5),
        (geometry) => geometry.getAttribute("position").setY(7, 0),
        (geometry) => {
          const index = geometry.getIndex()!;
          const a = index.getX(1);
          index.setX(1, index.getX(2));
          index.setX(2, a);
        },
      ];
      for (const mutate of mutations) {
        const geometry = f.geometry.clone();
        try {
          mutate(geometry);
          expect(() => groundGrassBlades({ ...f.request, geometry })).toThrow(
            /topology|triangle order/,
          );
        } finally {
          geometry.dispose();
        }
      }
    } finally {
      f.close();
    }
  });

  it.each([7, 8])(
    "includes appended center%s in exact wind bounds and per-blade road clearance",
    (center) => {
      const f = fixture();
      try {
        const road = {
          startX: 6,
          startZ: -1,
          endX: 6,
          endZ: 1,
          width: 0.05,
          blendWidth: 0,
        };
        const request: GrassBladeGroundingRequest = {
          ...f.request,
          roadClearance: "per-blade-v1",
          roadSegments: [road],
        };
        const clear = groundGrassBlades(request);
        if (clear.status !== "ready") throw new Error(clear.reason);
        expect(clear.bladeVisibility?.[0]).toBe(2 ** 24 - 1);
        // An adversarial position on the real generated layout isolates each
        // appended vertex. Omitting it from either sweep would miss this road.
        const position = f.geometry.getAttribute("position");
        const rootEdges = Array.from(position.array.slice(0, 6));
        position.setX(center, 6);
        position.setZ(center, 0);
        const swept = groundGrassBlades(f.request);
        if (swept.status !== "ready") throw new Error(swept.reason);
        if (!swept.sweptBounds)
          throw new Error("Expected nonempty swept bounds");
        const t = f.geometry.getAttribute("uv").getY(center);
        expect(swept.sweptBounds.maxX).toBeCloseTo(
          6 +
            f.request.wind.x * foldedFlex(t, position.getY(center), 1) +
            0.00001,
          8,
        );
        const culled = groundGrassBlades(request);
        if (culled.status !== "ready") throw new Error(culled.reason);
        expect(culled.data.count).toBe(1);
        expect(culled.bladeVisibility?.[0]).toBe(2 ** 24 - 2);
        expect(Array.from(position.array.slice(0, 6))).toEqual(rootEdges);
      } finally {
        f.close();
      }
    },
  );

  it("defers rather than publishing a center sweep beyond retained terrain", () => {
    const f = fixture(0, 10);
    try {
      const baseline = groundGrassBlades(f.request);
      expect(baseline.status).toBe("ready");
      f.geometry.getAttribute("position").setX(7, 6);
      const result = groundGrassBlades(f.request);
      expect(result).toMatchObject({
        status: "defer",
        reason: "missing_surface",
      });
      expect("data" in result).toBe(false);
      expect("rootDeltas" in result).toBe(false);
    } finally {
      f.close();
    }
  });

  it.each(groundingLayouts)(
    "preserves %s budget failure and caller cancellation without partial publication",
    (geometryLayout) => {
      const f = fixture(0, 100, geometryLayout);
      try {
        const complete = groundGrassBlades(f.request);
        if (complete.status !== "ready") throw new Error(complete.reason);
        const exhausted = groundGrassBlades({
          ...f.request,
          workBudget: complete.receipt.workUnits - 1,
        });
        expect(exhausted).toMatchObject({
          status: "defer",
          reason: "work_budget",
        });
        expect("rootDeltas" in exhausted).toBe(false);
        const before = structuredClone(f.request.data);
        const job = new GrassBladeGroundingJob(f.request, () => true);
        job.advance(1);
        expect(job.state.status).toBe("running");
        const operations = job.operations;
        job.cancel();
        expect(job.state).toEqual({ status: "cancelled", reason: "caller" });
        expect(job.operations).toBe(operations);
        expect("result" in job.state).toBe(false);
        expect(f.request.data).toEqual(before);
      } finally {
        f.close();
      }
    },
  );
});

describe("strict close-sheath CPU admission and transport", () => {
  it("resamples narrowed root edges on a real nonplanar surface instead of reusing wide-edge corrections", () => {
    const f = fixture(0, 100, sheathLayoutId);
    const old = fixture(0);
    const terrainGeometry = gridGeometry(
      4,
      17,
      (x, z) => 20 + 0.015 * (x * x + z * z),
    );
    const surface = new RetainedTerrainSurface(
      2,
      "sheath-root-curvature",
      0,
      0,
      4,
      17,
      terrainGeometry,
    );
    try {
      f.request.data.rotScaleHash[0] = 0.73;
      f.request.data.rotScaleHash[1] = 1.1;
      const data = projectGrassAnchors(
        f.request.data,
        surface,
        () => -1000,
        () => false,
      );
      const request = {
        ...f.request,
        data,
        ownSurface: surface,
        surfaces: [surface],
      };
      const result = groundGrassBlades(request);
      if (result.status !== "ready") throw new Error(result.reason);
      expect(result.data.count).toBe(1);
      const up = new THREE.Vector3(0, 1, 0);
      const tilt = new THREE.Quaternion().setFromUnitVectors(
        up,
        new THREE.Vector3().fromArray(data.groundNormals).normalize(),
      );
      const [yaw, scale] = data.rotScaleHash;
      const sample = { height: 0, faceIndex: 0 };
      const expectedCorrection = (
        geometry: THREE.BufferGeometry,
        index: number,
      ) => {
        const point = new THREE.Vector3()
          .fromBufferAttribute(geometry.getAttribute("position"), index)
          .multiplyScalar(scale)
          .applyAxisAngle(up, -yaw)
          .applyQuaternion(tilt)
          .add(new THREE.Vector3().fromArray(data.offsets));
        expect(surface.sampleHeight(point.x, point.z, sample)).toBe(true);
        return Math.fround(sample.height - point.y);
      };
      let distinctlyResampled = 0;
      for (let blade = 0; blade < 24; blade++)
        for (const side of [0, 1]) {
          const expected = expectedCorrection(f.geometry, blade * 15 + side);
          const previous = expectedCorrection(old.geometry, blade * 9 + side);
          // Independent quaternion rotation and production component arithmetic
          // differ by roundoff; tolerance is 50nm, not a clearance allowance.
          expect(result.rootDeltas[blade * 2 + side]).toBeCloseTo(expected, 7);
          if (Math.abs(expected - previous) > 1e-6) distinctlyResampled++;
        }
      expect(distinctlyResampled).toBeGreaterThan(0);
    } finally {
      f.close();
      old.close();
      terrainGeometry.dispose();
    }
  });

  it("admits only the explicit 24/24/12 chain without changing historical tiers or root storage", () => {
    const expected = [
      {
        bladesPerClump: 24,
        bladeSegments: 5,
        verticesPerBlade: 15,
        verticesPerClump: 360,
        trianglesPerClump: 408,
      },
      {
        bladesPerClump: 24,
        bladeSegments: 3,
        verticesPerBlade: 9,
        verticesPerClump: 216,
        trianglesPerClump: 216,
      },
      {
        bladesPerClump: 12,
        bladeSegments: 2,
        verticesPerBlade: 5,
        verticesPerClump: 60,
        trianglesPerClump: 36,
      },
    ];
    for (const lod of [0, 1, 2]) {
      const layout = getGrassBladeLayout(lod, sheathLayoutId);
      expect(layout).toEqual({
        geometryLayout: sheathLayoutId,
        lod,
        rootComponents: 2,
        ...expected[lod],
      });
      expect(Object.isFrozen(layout)).toBe(true);
      expect(isFoldedGrassBladeLayout(lod, sheathLayoutId)).toBe(lod < 2);
    }
    expect(usesGrassBladeHeightFlex(sheathLayoutId)).toBe(true);
    expect(usesGrassBladeHeightFlex(layoutId)).toBe(true);
    expect(usesGrassBladeHeightFlex("fine-linear-sweep-3seg-v1")).toBe(false);
    expect(getFoldedGrassBladeIndices(3)).toEqual(
      FINE_GRASS_FOLDED_BLADE_INDICES,
    );
    expect(getFoldedGrassBladeIndices(5)).toHaveLength(17 * 3);
    expect(Object.isFrozen(getFoldedGrassBladeIndices(5))).toBe(true);
    for (const segments of [0, 1, 2, 4, 6, 5.5, NaN, Infinity])
      expect(() => getFoldedGrassBladeIndices(segments)).toThrow();
    expect(() =>
      getGrassBladeLayout(0, "fine-folded-sheath-near6-v1" as never),
    ).toThrow(/layout/);
    expect(GRASS_BLADE_GROUNDING_LIMITS.defaultWorkBudget).toBe(1_000_000);
    expect(GRASS_BLADE_GROUNDING_LIMITS.maximumWorkBudget).toBe(1_000_000);
  });

  it.each([0, 1, 2] as const)(
    "rejects LOD%s wrong root/center/face layouts before admission",
    (lod) => {
      const f = fixture(lod, 100, sheathLayoutId);
      try {
        for (const geometryLayout of [
          undefined,
          "fine-linear-sweep-3seg-v1",
          layoutId,
        ] as const)
          expect(() =>
            groundGrassBlades({ ...f.request, geometryLayout }),
          ).toThrow(/geometry|vertex|triangle/);
        const mutations: ((geometry: THREE.BufferGeometry) => void)[] = [
          (geometry) => geometry.getAttribute("uv").setY(0, 0.1),
          (geometry) => geometry.getAttribute("position").setY(1, 0.1),
          (geometry) => {
            const indices = geometry.index!;
            const a = indices.getX(1);
            indices.setX(1, indices.getX(2));
            indices.setX(2, a);
          },
        ];
        if (lod < 2)
          for (let row = 1; row < f.layout.bladeSegments; row++) {
            const center = f.layout.bladeSegments * 2 + row;
            mutations.push(
              (geometry) => geometry.getAttribute("uv").setX(center, 0),
              (geometry) => geometry.getAttribute("uv").setY(center, 0),
              (geometry) => geometry.getAttribute("position").setY(center, 0),
            );
          }
        for (const mutate of mutations) {
          const geometry = f.geometry.clone();
          try {
            mutate(geometry);
            expect(() => groundGrassBlades({ ...f.request, geometry })).toThrow(
              /topology|triangle order/,
            );
          } finally {
            geometry.dispose();
          }
        }
        if (lod === 0) {
          const six = createClumpGeometry(
            24,
            6,
            FINE_GRASS_FOLDED_BLADE_SHAPE,
            "folded-sheath-v1",
          );
          try {
            expect(() =>
              groundGrassBlades({ ...f.request, geometry: six }),
            ).toThrow(/vertex/);
          } finally {
            six.dispose();
          }
        }
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ...[11, 12, 13, 14].map((center) => ({ lod: 0 as const, center })),
    ...[7, 8].map((center) => ({ lod: 1 as const, center })),
  ])(
    "includes LOD$lod center$center in wind, full-face clearance and missing-support checks",
    ({ lod, center }) => {
      const f = fixture(lod, 100, sheathLayoutId);
      const small = fixture(lod, 10, sheathLayoutId);
      try {
        const clear = groundGrassBlades({
          ...f.request,
          roadClearance: "per-blade-v1",
          roadSegments: [roadAt(5.99, 0.02)],
        });
        if (clear.status !== "ready") throw new Error(clear.reason);
        expect(clear.bladeVisibility?.[0]).toBe(2 ** 24 - 1);
        const position = f.geometry.getAttribute("position");
        const roots = position.array.slice(0, 6);
        position.setX(center, 6);
        position.setZ(center, 0);
        const swept = groundGrassBlades(f.request);
        if (swept.status !== "ready" || !swept.sweptBounds)
          throw new Error("Expected complete center sweep");
        const t = f.geometry.getAttribute("uv").getY(center);
        expect(swept.sweptBounds.maxX).toBeCloseTo(
          6 +
            f.request.wind.x * foldedFlex(t, position.getY(center), 1) +
            0.00001,
          8,
        );
        const masked = groundGrassBlades({
          ...f.request,
          roadClearance: "per-blade-v1",
          roadSegments: [roadAt(5.99, 0.02)],
        });
        if (masked.status !== "ready") throw new Error(masked.reason);
        expect(masked.bladeVisibility?.[0]).toBe(2 ** 24 - 2);
        expect(position.array.slice(0, 6)).toEqual(roots);
        small.geometry.getAttribute("position").setX(center, 6);
        const deferred = groundGrassBlades(small.request);
        expect(deferred).toMatchObject({
          status: "defer",
          reason: "missing_surface",
        });
        expect("rootDeltas" in deferred).toBe(false);
      } finally {
        f.close();
        small.close();
      }
    },
  );

  it("serially transfers every new tier through the actual worker without detaching live source buffers", async () => {
    const bundled = await bundleGrassGroundingWorker();
    const worker = await createActualGroundingWorker(bundled.source);
    try {
      for (const lod of [0, 1, 2] as const) {
        const f = fixture(lod, 100, sheathLayoutId);
        try {
          const sourceData = structuredClone(f.request.data);
          const sourcePosition = f.geometry
            .getAttribute("position")
            .array.slice();
          const request = {
            ...f.request,
            bankVerge: bankFixture(0.65),
            roadClearance: "per-blade-v1" as const,
          };
          const expected = groundGrassBlades(request);
          if (expected.status !== "ready") throw new Error(expected.reason);
          const packet = createGrassGroundingWorkerRequest(request, lod + 1);
          expect(packet.settings.geometryLayout).toBe(sheathLayoutId);
          expect(packet.settings.bankVerge).toEqual(request.bankVerge);
          expect(packet.geometry.position.length).toBe(
            f.layout.verticesPerClump * 3,
          );
          expect(packet.geometry.index.length).toBe(
            f.layout.trianglesPerClump * 3,
          );
          const response = await runGrassGroundingWorker(worker, packet);
          if (response.state.status !== "ready")
            throw new Error(
              `Unexpected worker terminal ${response.state.status}`,
            );
          if (response.state.result.status !== "ready")
            throw new Error("Ready worker must return accepted grounding");
          expect(
            grassGroundingWorkerSemanticResult(response.state.result, request),
          ).toEqual(grassGroundingWorkerSemanticResult(expected, request));
          expect(packet.geometry.position.byteLength).toBe(0);
          expect(packet.data.offsets.byteLength).toBe(0);
          expect(f.geometry.getAttribute("position").array).toEqual(
            sourcePosition,
          );
          expect(f.request.data).toEqual(sourceData);
          expect(response.state.result.rootDeltas.length).toBe(
            f.layout.bladesPerClump * 2,
          );
          expect(response.state.result.bladeVisibility?.[0]).toBe(
            2 ** f.layout.bladesPerClump - 1,
          );
        } finally {
          f.close();
        }
      }
    } finally {
      await worker.close();
    }
  });
});
