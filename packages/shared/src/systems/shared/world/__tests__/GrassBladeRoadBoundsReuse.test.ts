import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  groundGrassBladeSteps,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
} from "../GrassBladeGrounding";
import {
  getGrassBladeLayout,
  type FineGrassGeometryLayout,
} from "../GrassBladeLayout";
import {
  createClumpGeometry,
  FINE_GRASS_FOLDED_BLADE_SHAPE,
  FINE_MEADOW_APPEARANCE,
  GRASS_CONFIG,
} from "../GrassVisualManager";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";
import { groundGrassBladeSteps as legacySteps } from "./fixtures/LegacyGrassBladeGroundingReference";
import { sameFaceSemantic } from "./fixtures/GrassBladeGroundingSameFaceCases";

const layouts = [
  undefined,
  "fine-linear-sweep-3seg-v1",
  "fine-linear-sweep-near4-v1",
  "fine-folded-lancet-v1",
  "fine-folded-sheath-near5-v1",
] as const;
const cases = layouts.flatMap((geometryLayout) =>
  ([0, 1, 2] as const).map((lod) => ({ geometryLayout, lod })),
);

function fixture(
  geometryLayout: FineGrassGeometryLayout | undefined,
  lod: 0 | 1 | 2,
) {
  const layout = getGrassBladeLayout(lod, geometryLayout);
  const heightFlex =
    geometryLayout === "fine-folded-lancet-v1" ||
    geometryLayout === "fine-folded-sheath-near5-v1";
  const crossSection =
    geometryLayout === "fine-folded-sheath-near5-v1"
      ? lod === 0
        ? "folded-sheath-v1"
        : lod === 1
          ? "folded-lancet-v1"
          : undefined
      : geometryLayout === "fine-folded-lancet-v1" && lod === 0
        ? "folded-lancet-v1"
        : undefined;
  const geometry = createClumpGeometry(
    layout.bladesPerClump,
    layout.bladeSegments,
    heightFlex
      ? FINE_GRASS_FOLDED_BLADE_SHAPE
      : geometryLayout
        ? FINE_MEADOW_APPEARANCE
        : GRASS_CONFIG,
    crossSection,
  );
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  if (
    !(position instanceof THREE.BufferAttribute) ||
    !(uv instanceof THREE.BufferAttribute)
  )
    throw Error("Expected actual non-interleaved generated grass buffers");
  const terrain = gridGeometry(100, 17, (x, z) => 20 + 0.08 * x - 0.04 * z);
  const surface = new RetainedTerrainSurface(
    7,
    "road-bounds-reuse-fixture",
    0,
    0,
    100,
    17,
    terrain,
  );
  const data = projectGrassAnchors(
    {
      count: 1,
      offsets: new Float32Array([9, 20, 9]),
      rotScaleHash: new Float32Array([0.7, 1.3, 0.4]),
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
    ...(geometryLayout ? { geometryLayout } : {}),
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
    roadClearance: "per-blade-v1",
    roadSegments: [],
    oceanLevel: 0,
    // +0/-0 is a real borrowed-input mismatch without changing the numeric
    // road envelope. It forces the old branch, not a mocked implementation.
    wind: { x: 0, z: 0.11 },
  };
  return {
    request,
    layout,
    heightFlex,
    position,
    uv,
    dispose() {
      geometry.dispose();
      terrain.dispose();
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Box = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Independently retain the original two-fade scalar XZ sweep, including its
 * arithmetic order and numeric guard. Never call the production wind/bounds
 * helpers. The real projected Float32 normal/yaw/scale and buffers are inputs. */
function roadBoxes(f: Fixture): Box[] {
  const { data, wind } = f.request;
  const [x, , z] = data.offsets;
  const [rotation, scale] = data.rotScaleHash;
  const [nx, ny, nz] = data.groundNormals;
  const cos = Math.cos(rotation),
    sin = Math.sin(rotation),
    q = 1 / (1 + ny),
    cross = -nx * nz * q,
    tiltX = ny + nz * nz * q,
    tiltZ = ny + nx * nx * q;
  return Array.from({ length: f.layout.bladesPerClump }, (_, blade) => {
    const box = {
      minX: Infinity,
      maxX: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };
    for (let local = 0; local < f.layout.verticesPerBlade; local++) {
      const v = blade * f.layout.verticesPerBlade + local;
      const t = f.uv.getY(v),
        py = f.position.getY(v);
      const curve = t * (2 * 0.76 + t * (0.95 - 2 * 0.76));
      const amplitude = Math.min(
        1,
        (scale * py) / (Math.max(curve, 1e-5) * 0.86),
      );
      const fraction = curve / 0.95;
      const factor = f.heightFlex ? amplitude * fraction * fraction : t ** 1.8;
      for (const fade of [0, 1]) {
        const rx =
            (f.position.getX(v) * cos - f.position.getZ(v) * sin) * scale,
          rz = (f.position.getX(v) * sin + f.position.getZ(v) * cos) * scale,
          ry = py * 1 * scale * fade;
        const wx = x + rx * tiltX + ry * nx + rz * cross,
          wz = z + rx * cross + ry * nz + rz * tiltZ;
        box.minX = Math.min(box.minX, wx - wind.x * 1 * factor - 0.00001);
        box.maxX = Math.max(box.maxX, wx + wind.x * 1 * factor + 0.00001);
        box.minZ = Math.min(box.minZ, wz - wind.z * 1 * factor - 0.00001);
        box.maxZ = Math.max(box.maxZ, wz + wind.z * 1 * factor + 0.00001);
      }
    }
    return box;
  });
}

function verticalRoad(left: number, width = 0.08) {
  return {
    startX: left + width / 2,
    endX: left + width / 2,
    startZ: -40,
    endZ: 40,
    width,
    blendWidth: 0,
  };
}

function enteringRoad(f: Fixture) {
  // Enter the actual outer envelope narrowly, independent of whichever blade
  // owns the largest X. This guarantees a real road-bound sweep at every LOD.
  return verticalRoad(Math.max(...roadBoxes(f).map((box) => box.maxX)) - 0.001);
}

function expectedMask(f: Fixture, boxes = roadBoxes(f)) {
  let mask = (1 << f.layout.bladesPerClump) - 1;
  boxes.forEach((box, blade) => {
    // All test roads are genuinely vertical and cover the complete blade in Z;
    // capsule distance therefore reduces independently to interval distance.
    if (
      f.request.roadSegments.some((road) => {
        expect(road.startX).toBe(road.endX);
        expect(road.startZ).toBeLessThan(box.minZ);
        expect(road.endZ).toBeGreaterThan(box.maxZ);
        const distance = Math.max(
          box.minX - road.startX,
          0,
          road.startX - box.maxX,
        );
        return distance <= road.width / 2;
      })
    )
      mask &= ~(1 << blade);
  });
  return mask;
}

function run(
  f: Fixture,
  options: {
    fallback?: boolean;
    mutate?: (roadBlade: number) => void;
    beforeRoads?: () => void;
  } = {},
) {
  const steps = groundGrassBladeSteps(f.request);
  const trace: string[] = [];
  const boxes: Box[] = [];
  let roadBlade = 0,
    fallbackApplied = false,
    mainSweepComplete = false;
  for (;;) {
    const step = steps.next();
    if (step.done)
      return { result: step.value, trace, roadBlade, fallbackApplied, boxes };
    trace.push(step.value);
    if (trace.length > 100_000)
      throw Error("Bounded road fixture did not finish");
    if (!mainSweepComplete && step.value === "coverage_owner") {
      mainSweepComplete = true;
      options.beforeRoads?.();
    }
    if (step.value === "road_blade_bounds") {
      if (options.fallback && !fallbackApplied) {
        expect(Object.is(f.request.wind.x, 0)).toBe(true);
        f.request.wind.x = -0;
        fallbackApplied = true;
      }
      options.mutate?.(roadBlade);
      boxes.push(roadBoxes(f)[roadBlade++]);
    }
  }
}

function assertSameOutput(
  a: GrassBladeGroundingResult,
  b: GrassBladeGroundingResult,
) {
  expect(sameFaceSemantic(a)).toEqual(sameFaceSemantic(b));
  if (a.status !== "ready" || b.status !== "ready")
    throw Error("Expected ready road results");
  // The historical semantic helper predates visibility bytes: assert them
  // separately instead of silently relying only on its key/receipt comparison.
  const bytes = (array: ArrayBufferView | undefined) =>
    array
      ? Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString(
          "hex",
        )
      : null;
  expect(bytes(a.bladeVisibility)).toBe(bytes(b.bladeVisibility));
  expect(a.sweptBounds).toEqual(b.sweptBounds);
}

describe("exact per-blade road sweep reuse", () => {
  it.each(cases)(
    "preserves $geometryLayout LOD$lod output and removes only real road transforms",
    ({ geometryLayout, lod }) => {
      for (const roads of [false, true]) {
        const current = fixture(geometryLayout, lod);
        const reference = fixture(geometryLayout, lod);
        try {
          if (roads) {
            const road = enteringRoad(current);
            current.request.roadSegments = [road];
            reference.request.roadSegments = [road];
          }
          const actual = run(current),
            fallback = run(reference, { fallback: true });
          assertSameOutput(actual.result, fallback.result);
          expect(actual.trace).toEqual(fallback.trace);
          expect(actual.roadBlade).toBe(
            roads ? current.layout.bladesPerClump : 0,
          );
          expect(fallback.fallbackApplied).toBe(roads);
          expect(
            fallback.result.receipt.workUnits - actual.result.receipt.workUnits,
          ).toBe(roads ? current.layout.verticesPerClump : 0);
          if (actual.result.status !== "ready")
            throw Error("Expected ready road fixture");
          const mask = expectedMask(current);
          expect(mask).not.toBe(0);
          if (roads)
            expect(mask).not.toBe((1 << current.layout.bladesPerClump) - 1);
          expect(Array.from(actual.result.bladeVisibility ?? [])).toEqual([
            mask,
          ]);
          if (!current.heightFlex) {
            const legacy = legacySteps(current.request);
            let step = legacy.next();
            let operations = 0;
            while (!step.done) {
              if (++operations > 100_000)
                throw Error("Legacy road fixture did not finish");
              step = legacy.next();
            }
            expect(sameFaceSemantic(actual.result)).toEqual(
              sameFaceSemantic(step.value),
            );
            if (step.value.status !== "ready")
              throw Error("Expected ready legacy fixture");
            expect(actual.result.bladeVisibility).toEqual(
              step.value.bladeVisibility,
            );
          }
        } finally {
          current.dispose();
          reference.dispose();
        }
      }
    },
  );

  it.each([-1e-7, 0, 1e-7])(
    "retains exact road tangency (%s) and multiple-road masks",
    (epsilon) => {
      const current = fixture("fine-folded-sheath-near5-v1", 0);
      const reference = fixture("fine-folded-sheath-near5-v1", 0);
      try {
        const boxes = roadBoxes(current);
        const roads = [
          verticalRoad(boxes[0].maxX + epsilon),
          enteringRoad(current),
        ];
        current.request.roadSegments = roads;
        reference.request.roadSegments = roads;
        const actual = run(current),
          fallback = run(reference, { fallback: true });
        assertSameOutput(actual.result, fallback.result);
        expect(actual.trace).toEqual(fallback.trace);
        expect(actual.roadBlade).toBe(current.layout.bladesPerClump);
        expect(
          fallback.result.receipt.workUnits - actual.result.receipt.workUnits,
        ).toBe(current.layout.verticesPerClump);
        if (actual.result.status !== "ready")
          throw Error("Expected ready tangent fixture");
        const mask = expectedMask(current, boxes);
        expect(Array.from(actual.result.bladeVisibility ?? [])).toEqual(
          mask ? [mask] : [],
        );
      } finally {
        current.dispose();
        reference.dispose();
      }
    },
  );

  it.each([
    "x",
    "y",
    "z",
    "uv-y",
    "signed-x",
    "signed-y",
    "signed-z",
    "signed-uv-y",
    "uv-x",
  ] as const)(
    "rereads borrowed %s after the main sweep without attribute-version writes",
    (change) => {
      const current = fixture("fine-folded-sheath-near5-v1", 0);
      const reference = fixture("fine-folded-sheath-near5-v1", 0);
      try {
        const signed = change.startsWith("signed-");
        const axis = change.endsWith("x") ? 0 : change.endsWith("y") ? 1 : 2;
        const uvChange = change.includes("uv-");
        const local = signed ? 0 : current.layout.verticesPerBlade - 1;
        // Zero inputs are installed before admission. Their sign changes only
        // after the full sweep, so Object.is must distinguish borrowed bytes.
        if (signed)
          for (const f of [current, reference]) {
            if (uvChange) f.uv.setY(local, 0);
            else f.position.setComponent(local, axis, 0);
          }
        const road = enteringRoad(current);
        current.request.roadSegments = [road];
        reference.request.roadSegments = [road];
        const mutate = (f: Fixture) => {
          const positionVersion = f.position.version,
            uvVersion = f.uv.version;
          if (uvChange) {
            if (change === "uv-x") f.uv.setX(local, 1.7);
            else f.uv.setY(local, signed ? -0 : 0.91);
          } else
            f.position.setComponent(
              local,
              axis,
              signed ? -0 : f.position.getComponent(local, axis) + 3,
            );
          expect(f.position.version).toBe(positionVersion);
          expect(f.uv.version).toBe(uvVersion);
          if (signed)
            expect(
              Object.is(
                uvChange
                  ? f.uv.getY(local)
                  : f.position.getComponent(local, axis),
                -0,
              ),
            ).toBe(true);
        };
        const actual = run(current, { beforeRoads: () => mutate(current) });
        const fallback = run(reference, {
          fallback: true,
          beforeRoads: () => mutate(reference),
        });
        assertSameOutput(actual.result, fallback.result);
        expect(actual.trace).toEqual(fallback.trace);
        expect(actual.roadBlade).toBe(current.layout.bladesPerClump);
        const { verticesPerBlade: v, bladesPerClump: b } = current.layout;
        // Reuse checks each vertex once. A mismatch checks local+1 vertices and
        // then executes all original2V transforms; other blades still reuse.
        expect(
          fallback.result.receipt.workUnits - actual.result.receipt.workUnits,
        ).toBe(change === "uv-x" ? b * v : (b - 1) * v - (local + 1));
        if (actual.result.status !== "ready")
          throw Error("Expected borrowed-input road result");
        const mask = expectedMask(current, actual.boxes);
        expect(Array.from(actual.result.bladeVisibility ?? [])).toEqual(
          mask ? [mask] : [],
        );
      } finally {
        current.dispose();
        reference.dispose();
      }
    },
  );

  it.each(["before-roads", "between-blades"] as const)(
    "rereads changed wind %s and preserves old continuation outputs",
    (when) => {
      const current = fixture("fine-folded-sheath-near5-v1", 0);
      const reference = fixture("fine-folded-sheath-near5-v1", 0);
      try {
        const road = enteringRoad(current);
        current.request.roadSegments = [road];
        reference.request.roadSegments = [road];
        const mutate = (f: Fixture) => {
          f.request.wind.z = 0.42;
        };
        const options = (f: Fixture) =>
          when === "before-roads"
            ? { beforeRoads: () => mutate(f) }
            : {
                mutate: (blade: number) => {
                  if (blade === 3) mutate(f);
                },
              };
        const actual = run(current, options(current));
        const fallback = run(reference, {
          fallback: true,
          ...options(reference),
        });
        assertSameOutput(actual.result, fallback.result);
        expect(actual.trace).toEqual(fallback.trace);
        expect(actual.roadBlade).toBe(current.layout.bladesPerClump);
        expect(
          fallback.result.receipt.workUnits - actual.result.receipt.workUnits,
        ).toBe(
          when === "before-roads" ? 0 : 3 * current.layout.verticesPerBlade,
        );
        if (actual.result.status !== "ready")
          throw Error("Expected live-wind road result");
        const mask = expectedMask(current, actual.boxes);
        expect(Array.from(actual.result.bladeVisibility ?? [])).toEqual(
          mask ? [mask] : [],
        );
      } finally {
        current.dispose();
        reference.dispose();
      }
    },
  );

  it("invalidates only the later blade whose borrowed position changes between road batches", () => {
    const current = fixture("fine-folded-sheath-near5-v1", 0);
    const reference = fixture("fine-folded-sheath-near5-v1", 0);
    try {
      const road = enteringRoad(current);
      current.request.roadSegments = [road];
      reference.request.roadSegments = [road];
      const local = 8,
        blade = 3;
      const mutate = (f: Fixture, ordinal: number) => {
        if (ordinal !== blade) return;
        const vertex = blade * f.layout.verticesPerBlade + local;
        const version = f.position.version;
        f.position.setX(vertex, f.position.getX(vertex) + 3);
        expect(f.position.version).toBe(version);
      };
      const actual = run(current, {
        mutate: (ordinal) => mutate(current, ordinal),
      });
      const fallback = run(reference, {
        fallback: true,
        mutate: (ordinal) => mutate(reference, ordinal),
      });
      assertSameOutput(actual.result, fallback.result);
      expect(actual.trace).toEqual(fallback.trace);
      expect(actual.roadBlade).toBe(current.layout.bladesPerClump);
      expect(
        fallback.result.receipt.workUnits - actual.result.receipt.workUnits,
      ).toBe(
        (current.layout.bladesPerClump - 1) * current.layout.verticesPerBlade -
          (local + 1),
      );
      if (actual.result.status !== "ready")
        throw Error("Expected later borrowed blade result");
      const mask = expectedMask(current, actual.boxes);
      expect(Array.from(actual.result.bladeVisibility ?? [])).toEqual(
        mask ? [mask] : [],
      );
    } finally {
      current.dispose();
      reference.dispose();
    }
  });

  it("never reuses partial or preceding-clump bounds after borrowed count changes", () => {
    const current = fixture("fine-folded-sheath-near5-v1", 0);
    const reference = fixture("fine-folded-sheath-near5-v1", 0);
    try {
      for (const f of [current, reference]) {
        const data = f.request.data;
        const duplicate = (values: Float32Array) =>
          new Float32Array([...values, ...values]);
        const pair = {
          count: 2,
          offsets: duplicate(data.offsets),
          rotScaleHash: duplicate(data.rotScaleHash),
          groundColors: duplicate(data.groundColors),
          grassTints: duplicate(data.grassTints),
          groundNormals: duplicate(data.groundNormals),
        };
        // Same source/UV/wind, different world transform: previous-clump bounds
        // must not be accepted merely because all borrowed vertices still match.
        pair.offsets[3] += 0.3;
        pair.offsets[5] += 0.2;
        f.request.data = projectGrassAnchors(
          pair,
          f.request.ownSurface,
          () => -1000,
          () => false,
        );
        f.request.roadSegments = [verticalRoad(8.5, 2)];
      }
      const exercise = (f: Fixture, fallback: boolean) => {
        const steps = groundGrassBladeSteps(f.request);
        const trace: string[] = [];
        const fullCount = f.position.count,
          version = f.position.version;
        let clump = -1,
          sweepBlade = 0,
          roadBlade = 0,
          roadBatches = 0;
        let truncated = false,
          allocationCountChanged = false;
        for (;;) {
          const step = steps.next();
          if (step.done) {
            expect(allocationCountChanged).toBe(true);
            expect(truncated).toBe(true);
            expect(clump).toBe(1);
            expect(roadBatches).toBe(2 * f.layout.bladesPerClump);
            expect(f.position.count).toBe(fullCount);
            expect(f.position.version).toBe(version);
            return { result: step.value, trace };
          }
          trace.push(step.value);
          if (trace.length > 100_000)
            throw Error("Two-clump fixture did not finish");
          if (step.value === "bounded_staging_allocation") {
            // Validation has finished. Cache capacity must use the admitted
            // layout, not this mutable public count at allocation/resumption.
            Object.assign(f.position, { count: 1 });
            allocationCountChanged = true;
          } else if (step.value === "anchor_surface") {
            clump++;
            sweepBlade = roadBlade = 0;
            Object.assign(f.position, { count: fullCount });
            f.request.wind.x = 0;
          } else if (step.value === "blade_swept_bounds") {
            if (clump === 1 && sweepBlade === 1) {
              // First blade complete, second blade visits just its first root,
              // all later blades unvisited. Restore only after the sweep ends.
              Object.assign(f.position, {
                count: f.layout.verticesPerBlade + 1,
              });
              truncated = true;
            }
            sweepBlade++;
          } else if (step.value === "coverage_owner") {
            Object.assign(f.position, { count: fullCount });
          } else if (step.value === "road_blade_bounds") {
            if (fallback && roadBlade === 0) f.request.wind.x = -0;
            roadBlade++;
            roadBatches++;
          }
        }
      };
      const actual = exercise(current, false),
        fallback = exercise(reference, true);
      assertSameOutput(actual.result, fallback.result);
      expect(actual.trace).toEqual(fallback.trace);
      // Exactly24 complete blades in clump1, one in clump2. Partial/unvisited
      // blades execute the original road sweep with no cache guard charges.
      expect(
        fallback.result.receipt.workUnits - actual.result.receipt.workUnits,
      ).toBe(
        (current.layout.bladesPerClump + 1) * current.layout.verticesPerBlade,
      );
    } finally {
      current.dispose();
      reference.dispose();
    }
  });
});
