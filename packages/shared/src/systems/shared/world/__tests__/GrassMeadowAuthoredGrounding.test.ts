import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  groundGrassBladeSteps,
  GrassGroundingContinuation,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
} from "../GrassBladeGrounding";
import {
  GRASS_MEADOW_REFINEMENT,
  getGrassBladeWindFactor,
} from "../GrassBladeLayout";
import { createMeadowAuthoredClumpGeometry } from "../GrassVisualManager";
import {
  projectGrassAnchors,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { prepareGroundedGrassSteps } from "../GrassGroundingPipeline";
import { gridGeometry } from "./terrain-grid.fixture";

function fixture(slope = false, count = 1) {
  const endpoint = createMeadowAuthoredClumpGeometry();
  const terrain = gridGeometry(
    100,
    11,
    (x, z) => 20 + (slope ? 0.07 * x - 0.04 * z : 0),
  );
  const surface = new RetainedTerrainSurface(
    101,
    "authored-union-test-v1",
    0,
    0,
    100,
    11,
    terrain,
  );
  const source: GrassAnchorData = {
    count,
    offsets: new Float32Array(count * 3),
    rotScaleHash: new Float32Array(count * 3),
    groundColors: new Float32Array(count * 3).fill(0.3),
    grassTints: new Float32Array(count * 4).fill(0.2),
    groundNormals: new Float32Array(count * 3),
  };
  for (let i = 0; i < count; i++) {
    source.offsets.set([(i % 8) * 2 - 4, 20, Math.floor(i / 8) * 2 - 4], i * 3);
    source.rotScaleHash.set([0.43 + i * 0.27, 0.7 + (i % 3) * 0.3, 0.4], i * 3);
    source.groundNormals.set([0, 1, 0], i * 3);
  }
  const data = projectGrassAnchors(
    source,
    surface,
    () => -1000,
    () => false,
  );
  const request: GrassBladeGroundingRequest = {
    data,
    geometry: endpoint.geometry,
    geometryLayout: "fine-meadow-ribbon-v1",
    authoredMeadow: {
      kind: "meadow-authored-union-v1",
      coarseGeometry: endpoint.coarseGeometry,
    },
    lod: 0,
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
    roadClearance: "per-blade-v1",
    oceanLevel: 0,
    wind: { x: 0.129, z: 0.07095 },
  };
  return {
    ...endpoint,
    terrain,
    surface,
    request,
    dispose() {
      endpoint.geometry.dispose();
      endpoint.coarseGeometry.dispose();
      terrain.dispose();
    },
  };
}

function drain(steps: ReturnType<typeof groundGrassBladeSteps>) {
  let operations = 0,
    step = steps.next();
  while (!step.done) {
    operations++;
    step = steps.next();
  }
  return { result: step.value, operations };
}
function ready(result: GrassBladeGroundingResult) {
  if (result.status !== "ready") throw new Error(`Unexpected ${result.reason}`);
  return result;
}
function coarseRequest(
  f: ReturnType<typeof fixture>,
): GrassBladeGroundingRequest {
  return {
    ...f.request,
    authoredMeadow: undefined,
    geometry: f.coarseGeometry,
  };
}

/** Independent real Three quaternion transforms on actual vertex streams. */
function worldPoint(
  f: ReturnType<typeof fixture>,
  geometry: THREE.BufferGeometry,
  instance: number,
  vertex: number,
  deltas: Float32Array,
  stride: number,
  fade: number,
  windX: number,
  windZ: number,
) {
  const data = f.request.data,
    k = instance * 3;
  const p = geometry.getAttribute("position"),
    uv = geometry.getAttribute("uv");
  const scale = data.rotScaleHash[k + 1];
  const point = new THREE.Vector3(
    p.getX(vertex),
    p.getY(vertex) * fade,
    p.getZ(vertex),
  )
    .multiplyScalar(scale)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), -data.rotScaleHash[k])
    .applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3().fromArray(data.groundNormals, k),
      ),
    )
    .add(new THREE.Vector3().fromArray(data.offsets, k));
  const blade = Math.floor(vertex / stride),
    d = (instance * 21 + blade) * 2,
    u = uv.getX(vertex);
  point.y += deltas[d] * (1 - u) + deltas[d + 1] * u;
  const flex = getGrassBladeWindFactor(
    uv.getY(vertex),
    p.getY(vertex),
    scale,
    "fine-meadow-ribbon-v1",
  );
  point.x += windX * flex;
  point.z += windZ * flex;
  return point;
}

function bladeBoxes(
  f: ReturnType<typeof fixture>,
  geometry: THREE.BufferGeometry,
  stride: number,
) {
  return Array.from({ length: 21 }, (_, blade) => {
    const box = new THREE.Box3();
    for (let local = 0; local < stride; local++)
      for (const fade of [0, 1])
        for (const sx of [-1, 1])
          for (const sz of [-1, 1])
            box.expandByPoint(
              worldPoint(
                f,
                geometry,
                0,
                blade * stride + local,
                new Float32Array(42),
                stride,
                fade,
                sx * f.request.wind.x,
                sz * f.request.wind.z,
              ),
            );
    return box.expandByScalar(0.00001);
  });
}

describe("explicit authored/coarse union grounding kernel (no publication)", () => {
  it.each(["value", "getter", "inherited"] as const)(
    "rejects authored %s at the ordinary pipeline before input consumption or projection",
    (kind) => {
      const f = fixture();
      let consumed = 0,
        getters = 0;
      try {
        if (kind === "getter")
          Object.defineProperty(f.request, "authoredMeadow", {
            get() {
              getters++;
              throw new Error("Getter invoked");
            },
          });
        if (kind === "inherited") {
          const value = f.request.authoredMeadow;
          delete f.request.authoredMeadow;
          Object.setPrototypeOf(f.request, { authoredMeadow: value });
        }
        const before = structuredClone(f.request.data);
        const inputs = {
          isCurrent: () => true,
          steps: (function* () {
            consumed++;
            yield "actual_test_input";
            return {
              terrainSurface: f.request.terrainSurface,
              roadSegments: [...f.request.roadSegments],
            };
          })(),
        };
        const steps = prepareGroundedGrassSteps(
          f.request,
          inputs,
          () => -1000,
          () => false,
        );
        expect(() => steps.next()).toThrow(/installed-anchor certification/);
        expect(consumed).toBe(0);
        expect(getters).toBe(0);
        expect(f.request.data).toEqual(before);
      } finally {
        f.dispose();
      }
    },
  );

  it.each([false, true])(
    "preserves installed arrays and exact root corrections on slope=%s",
    (slope) => {
      const f = fixture(slope, 3);
      try {
        const before = structuredClone(f.request.data);
        const old = ready(
          drain(groundGrassBladeSteps(coarseRequest(f))).result,
        );
        const union = ready(drain(groundGrassBladeSteps(f.request)).result);
        expect(union.data.count).toBe(before.count);
        for (const key of [
          "offsets",
          "rotScaleHash",
          "groundNormals",
          "groundColors",
          "grassTints",
        ] as const)
          expect(new Uint32Array(union.data[key].buffer)).toEqual(
            new Uint32Array(before[key].buffer),
          );
        expect(f.request.data).toEqual(before);
        expect(union.sourceIndices).toEqual(new Uint32Array([0, 1, 2]));
        expect(new Uint32Array(union.rootDeltas.buffer)).toEqual(
          new Uint32Array(old.rootDeltas.buffer),
        );
        expect(union.bladeVisibility).toEqual(old.bladeVisibility);
        expect(union.receipt.authoredMeadow).toEqual({
          kind: "meadow-authored-union-v1",
          authoredVerticesPerBlade: 15,
          coarseVerticesPerBlade: 7,
        });
        expect(union.receipt.endpointQueries).toBe(3 * 42);
        expect(union.receipt.workUnits).toBeGreaterThan(old.receipt.workUnits);
        const b = union.sweptBounds;
        if (!b) throw new Error("Missing actual union bounds");
        for (let instance = 0; instance < 3; instance++)
          for (let v = 0; v < 315; v++) {
            const [a, z] = GRASS_MEADOW_REFINEMENT.parentPairs[v % 15],
              base = Math.floor(v / 15) * 7;
            for (const fade of [0, 1])
              for (const sx of [-1, 1])
                for (const sz of [-1, 1]) {
                  const point = worldPoint(
                    f,
                    f.geometry,
                    instance,
                    v,
                    union.rootDeltas,
                    15,
                    fade,
                    sx * f.request.wind.x,
                    sz * f.request.wind.z,
                  );
                  const parent = worldPoint(
                    f,
                    f.coarseGeometry,
                    instance,
                    base + a,
                    old.rootDeltas,
                    7,
                    fade,
                    sx * f.request.wind.x,
                    sz * f.request.wind.z,
                  )
                    .add(
                      worldPoint(
                        f,
                        f.coarseGeometry,
                        instance,
                        base + z,
                        old.rootDeltas,
                        7,
                        fade,
                        sx * f.request.wind.x,
                        sz * f.request.wind.z,
                      ),
                    )
                    .multiplyScalar(0.5);
                  for (const weight of [0, 0.25, 0.5, 0.75, 1]) {
                    const q = parent.clone().lerp(point, weight);
                    expect(q.x).toBeGreaterThanOrEqual(b.minX);
                    expect(q.x).toBeLessThanOrEqual(b.maxX);
                    expect(q.y).toBeGreaterThanOrEqual(b.minY);
                    expect(q.y).toBeLessThanOrEqual(b.maxY);
                    expect(q.z).toBeGreaterThanOrEqual(b.minZ);
                    expect(q.z).toBeLessThanOrEqual(b.maxZ);
                  }
                }
          }
      } finally {
        f.dispose();
      }
    },
  );

  it("uses the union road mask and rejects an actually new authored extent", () => {
    const f = fixture();
    try {
      // A new authored extent is a real upgrade hazard. Do not assume that this
      // canonical shape must also exhibit a coarse-only AABB corner.
      f.request.wind = { x: 0, z: 0 };
      const coarse = bladeBoxes(f, f.coarseGeometry, 7),
        authored = bladeBoxes(f, f.geometry, 15);
      let point: THREE.Vector3 | undefined,
        affected = -1;
      for (let blade = 0; blade < 21 && !point; blade++)
        for (const x of [authored[blade].min.x, authored[blade].max.x])
          for (const z of [authored[blade].min.z, authored[blade].max.z]) {
            const candidate = new THREE.Vector3(x, 20, z),
              previous = coarse[blade];
            const distance = Math.hypot(
              Math.max(previous.min.x - x, 0, x - previous.max.x),
              Math.max(previous.min.z - z, 0, z - previous.max.z),
            );
            if (distance > 0.002) {
              point = candidate;
              affected = blade;
            }
          }
      if (!point) throw new Error("No nonvacuous authored-only envelope point");
      const p = point;
      f.request.roadSegments = [
        {
          startX: p.x,
          endX: p.x,
          startZ: p.z,
          endZ: p.z,
          width: 0.001,
          blendWidth: 0,
        },
      ];
      let expected = 0;
      for (let blade = 0; blade < 21; blade++) {
        const box = coarse[blade].clone().union(authored[blade]);
        if (
          Math.hypot(
            Math.max(box.min.x - p.x, 0, p.x - box.max.x),
            Math.max(box.min.z - p.z, 0, p.z - box.max.z),
          ) > 0.0005
        )
          expected |= 1 << blade;
      }
      expect(expected).not.toBe(0);
      expect(expected & (1 << affected)).toBe(0);
      const original = ready(
        drain(groundGrassBladeSteps(coarseRequest(f))).result,
      );
      expect((original.bladeVisibility?.[0] ?? 0) & (1 << affected)).not.toBe(
        0,
      );
      const result = ready(drain(groundGrassBladeSteps(f.request)).result);
      expect(result.data.count).toBe(1);
      expect(result.bladeVisibility).toEqual(new Uint32Array([expected]));
    } finally {
      f.dispose();
    }
  });

  it.each(["pad", "water", "missing", "overlap"] as const)(
    "retains the existing %s exclusion/support gate on the complete union",
    (kind) => {
      const f = fixture();
      const extra: THREE.BufferGeometry[] = [];
      try {
        if (kind === "pad")
          f.request.terrainSurface.exclusionPolygons = [
            {
              id: "union-pad",
              minX: -5,
              maxX: -3,
              minZ: -5,
              maxZ: -3,
              vertices: [
                { x: -5, z: -5 },
                { x: -3, z: -5 },
                { x: -3, z: -3 },
                { x: -5, z: -3 },
              ],
            },
          ];
        if (kind === "water")
          f.request.terrainSurface.waterBodies = [
            {
              id: "union-water",
              centerX: -4,
              centerZ: -4,
              radius: 2,
              surfaceY: 20,
            },
          ];
        if (kind === "missing") {
          f.request.data.offsets[0] = -49.99;
          f.request.data.offsets[2] = -49.99;
        }
        if (kind === "overlap") {
          const g = gridGeometry(100, 11, () => 20);
          extra.push(g);
          f.request.surfaces = [
            f.surface,
            new RetainedTerrainSurface(
              102,
              f.surface.terrainProfileIdentity,
              0,
              0,
              100,
              11,
              g,
            ),
          ];
        }
        const result = drain(groundGrassBladeSteps(f.request)).result;
        if (kind === "missing" || kind === "overlap")
          expect(result).toMatchObject({
            status: "defer",
            reason:
              kind === "missing" ? "missing_surface" : "overlapping_surface",
          });
        else {
          const r = ready(result);
          expect(r.data.count).toBe(0);
          expect(r.receipt.rejected[kind]).toBe(1);
        }
      } finally {
        f.dispose();
        extra.forEach((g) => g.dispose());
      }
    },
  );

  it("shares existing work/continuation limits, cancellation and no partial ready result", () => {
    const f = fixture();
    try {
      const old = ready(drain(groundGrassBladeSteps(coarseRequest(f))).result);
      const union = ready(drain(groundGrassBladeSteps(f.request)).result);
      f.request.workBudget = Math.floor(
        (old.receipt.workUnits + union.receipt.workUnits) / 2,
      );
      const failed = drain(groundGrassBladeSteps(f.request)).result;
      expect(failed).toMatchObject({ status: "defer", reason: "work_budget" });
      expect("data" in failed).toBe(false);
      f.request.workBudget = undefined;
      const budget = new GrassGroundingContinuation(
        groundGrassBladeSteps(f.request),
        () => true,
        { operations: 999999, activeMs: 0, maximumSliceMs: 0 },
      );
      expect(budget.advance()).toMatchObject({
        status: "failed_budget",
        reason: "operations",
      });
      expect(budget.operations).toBe(1_000_000);
      let current = true;
      const cancelled = new GrassGroundingContinuation(
        groundGrassBladeSteps(f.request),
        () => current,
      );
      while (
        cancelled.state.status === "running" &&
        cancelled.lastPhase !== "blade_swept_bounds"
      )
        cancelled.advance(1);
      expect(cancelled.state.status).toBe("running");
      current = false;
      expect(cancelled.advance()).toEqual({
        status: "cancelled",
        reason: "invalidated",
      });
      expect("result" in cancelled.state).toBe(false);
      expect(GRASS_BLADE_GROUNDING_JOB_LIMITS).toMatchObject({
        maximumOperations: 1_000_000,
        maximumActiveMs: 250,
        maximumSliceOperations: 8192,
        targetSliceMs: 2,
      });
    } finally {
      f.dispose();
    }
  });

  it.each([
    "omitted",
    "lod",
    "layout",
    "count",
    "kind",
    "extra",
    "getter",
    "inherited",
    "coarse-getter",
    "position",
    "normal",
    "uv",
    "index",
    "draw",
    "group",
  ] as const)("rejects invalid explicit admission %s", (kind) => {
    const f = fixture();
    let getterCalls = 0;
    try {
      if (kind === "omitted") delete f.request.authoredMeadow;
      if (kind === "lod") f.request.lod = 1;
      if (kind === "layout")
        f.request.geometryLayout = "fine-linear-sweep-3seg-v1";
      if (kind === "count") f.request.data.count = 129;
      if (kind === "kind")
        Object.defineProperty(f.request.authoredMeadow, "kind", {
          value: "other",
        });
      if (kind === "extra")
        Object.defineProperty(f.request.authoredMeadow, "extra", { value: 1 });
      if (kind === "getter")
        Object.defineProperty(f.request, "authoredMeadow", {
          get() {
            getterCalls++;
            throw new Error("getter invoked");
          },
        });
      if (kind === "inherited") {
        const option = f.request.authoredMeadow;
        delete f.request.authoredMeadow;
        Object.setPrototypeOf(f.request, { authoredMeadow: option });
      }
      if (kind === "coarse-getter")
        Object.defineProperty(f.request.authoredMeadow, "coarseGeometry", {
          get() {
            getterCalls++;
            throw new Error("getter invoked");
          },
        });
      if (kind === "position" || kind === "normal" || kind === "uv") {
        const a = f.geometry.getAttribute(kind);
        a.setX(8, a.getX(8) + 0.01);
      }
      if (kind === "index") {
        const i = f.geometry.index;
        if (!i) throw new Error("Missing index");
        i.setX(0, 3);
      }
      if (kind === "draw") f.geometry.setDrawRange(3, 6);
      if (kind === "group") f.geometry.addGroup(0, 3, 0);
      expect(() => drain(groundGrassBladeSteps(f.request))).toThrow();
      expect(getterCalls).toBe(0);
    } finally {
      f.dispose();
    }
  });
});
