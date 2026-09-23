import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  FINE_GRASS_FOLDED_BLADE_INDICES,
  getGrassBladeLayout,
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

const layoutId = "fine-folded-lancet-v1" as const;

/** Real generated blades and retained terrain; these CPU proofs are not GPU
 * contact, visual quality, native performance or acceptance evidence. */
function fixture(lod: 0 | 1 | 2 = 0, size = 100) {
  const layout = getGrassBladeLayout(lod, layoutId);
  const geometry = createClumpGeometry(
    layout.bladesPerClump,
    layout.bladeSegments,
    FINE_GRASS_FOLDED_BLADE_SHAPE,
    lod === 0 ? "folded-lancet-v1" : undefined,
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
    geometryLayout: layoutId,
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

  it.each([0, 1, 2] as const)(
    "grounds actual LOD%s with exact per-blade root correction ownership",
    (lod) => {
      const f = fixture(lod);
      try {
        const before = structuredClone(f.request.data);
        const positionBefore = f.geometry
          .getAttribute("position")
          .array.slice();
        const result = groundGrassBlades(f.request);
        if (result.status !== "ready") throw new Error(result.reason);
        expect(result.receipt.geometryLayout).toBe(layoutId);
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

  it("admits only the explicit fine layout for existing bank deformation", () => {
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
    const f = fixture();
    try {
      expect(
        captureGrassBankVerge({ geometryLayout: layoutId, bankVerge }),
      ).toEqual(bankVerge);
      expect(() => captureGrassBankVerge({ bankVerge })).toThrow(/descriptor/);
      const result = groundGrassBlades({ ...f.request, bankVerge });
      if (result.status !== "ready") throw new Error(result.reason);
      expect(result.data.count).toBe(1);
      const original = groundGrassBlades(f.request);
      if (original.status !== "ready") throw new Error(original.reason);
      expect(result.rootDeltas).toEqual(original.rootDeltas);
    } finally {
      f.close();
    }
  });

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
          6 + f.request.wind.x * t ** 1.8 + 0.00001,
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

  it("preserves budget failure and caller cancellation without partial publication", () => {
    const f = fixture();
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
  });
});
