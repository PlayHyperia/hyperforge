import { afterEach, describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EntityType, ResourceType } from "../../../../types/entities";
import { createRootedFlowerGeometry } from "../../../../../../procgen/src/flowers/RootedFlowerGeometry";
import type { GrassTerrainSurfaceSnapshot } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { createStorageInstancedMesh } from "../../../../utils/rendering/createStorageInstancedMesh";
import { captureFlowerResourceClearance } from "../FlowerResourceClearance";
import type { GrassGroundingInputLease } from "../GrassGroundingPipeline";
import type { GrassGroundingRoadSegment } from "../GrassBladeGrounding";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
} from "../TerrainGridSurface";
import type { RetainedTerrainRegion } from "../TerrainVisualManager";
import {
  ROOTED_FLOWER_PLACEMENT_LIMITS,
  createRootedFlowerPlacementSteps,
  getRootedFlowerPlacementBounds,
  type RootedFlowerPlacementRequest,
  type RootedFlowerPlacementResult,
} from "../RootedFlowerPlacement";
import { gridGeometry } from "./terrain-grid.fixture";

// Real retained terrain admission, actual flower geometry and live resource
// snapshots; no renderer, worker, owner-method replacement or GPU execution.
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});
const empty = (): GrassTerrainSurfaceSnapshot => ({
  schemaVersion: 1,
  zones: [],
  arenaFloorIds: [],
  arenaGradeHeight: null,
  waterBodies: [],
});

function fixture(
  height: (x: number, z: number) => number = (x, z) => 10 + x * 0.01 + z * 0.02,
) {
  const world = new World();
  const geometry = createRootedFlowerGeometry();
  const terrain = gridGeometry(128, 5, height);
  const surface = new RetainedTerrainSurface(
    1,
    "flower-placement-test",
    0,
    0,
    128,
    5,
    terrain,
  );
  const state = { region: true, inputs: true, inputStarts: 0, inputCloses: 0 };
  const region: RetainedTerrainRegion = {
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    surfaces: [surface],
    isCurrent: () => state.region && surface.matchesGeometry(terrain),
  };
  const input = (
    snapshot = empty(),
    roadSegments: GrassGroundingRoadSegment[] = [],
  ): GrassGroundingInputLease => ({
    isCurrent: () => state.inputs,
    steps: (function* () {
      state.inputStarts++;
      try {
        yield "actual-input-step-0";
        yield "actual-input-step-1";
        return { terrainSurface: snapshot, roadSegments };
      } finally {
        state.inputCloses++;
      }
    })(),
  });
  const resources = captureFlowerResourceClearance(world);
  const request = (
    overrides: Partial<RootedFlowerPlacementRequest> = {},
  ): RootedFlowerPlacementRequest => ({
    origin: { x: 4, z: 4 },
    seed: 1728,
    geometry,
    region,
    inputs: input(),
    resources,
    grassPlacement: () => 1,
    oceanLevel: 0,
    ...overrides,
  });
  cleanups.push(() => {
    geometry.dispose();
    terrain.dispose();
    world.destroy();
  });
  return { world, geometry, terrain, surface, region, state, input, request };
}

function drain(request: RootedFlowerPlacementRequest) {
  const steps = createRootedFlowerPlacementSteps(request);
  const phases: string[] = [];
  for (;;) {
    const next = steps.next();
    if (next.done) return { result: next.value, phases };
    phases.push(next.value);
    if (phases.length > ROOTED_FLOWER_PLACEMENT_LIMITS.maxSteps)
      throw new Error("Test step bound exceeded");
  }
}

function rows(result: RootedFlowerPlacementResult) {
  return Array.from({ length: result.count }, (_, index) =>
    Array.from(result.matrices.slice(index * 16, index * 16 + 16)),
  );
}

function addTree(world: World, x: number, z: number) {
  const entity = new ResourceEntity(world, {
    id: "flower-test-tree",
    name: "Flower test tree",
    type: EntityType.RESOURCE,
    position: { x, y: 10, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: null,
    interactionDistance: 3,
    description: "Actual flower placement resource fixture",
    model: null,
    resourceType: ResourceType.TREE,
    resourceId: "tree_general",
    harvestSkill: "woodcutting",
    requiredLevel: 1,
    harvestTime: 3000,
    respawnTime: 60000,
    harvestYield: [],
    depleted: false,
    lastHarvestTime: 0,
    footprint: "standard",
    properties: {
      movementComponent: null,
      combatComponent: null,
      healthComponent: null,
      visualComponent: null,
      health: { current: 0, max: 0 },
      level: 1,
      resourceType: ResourceType.TREE,
      harvestable: true,
      respawnTime: 60000,
      toolRequired: "none",
      skillRequired: "none",
      xpReward: 0,
    },
  });
  world.entities.set(entity.id, entity);
  cleanups.unshift(() => entity.destroy());
  return entity;
}

describe("bounded rooted flower placement", () => {
  it("is deterministic, sparse, detached, and forwards each fresh input step once", () => {
    const f = fixture();
    const before = Array.from(f.geometry.getAttribute("position").array);
    const a = drain(f.request()),
      b = drain(f.request());
    expect(a.result.count).toBeGreaterThan(0);
    expect(a.result.count).toBeLessThan(200);
    expect(a.result.diagnostics.candidates).toBe(484);
    expect(a.result.count).toBeLessThanOrEqual(484);
    expect(a.result.matrices.length).toBe(a.result.count * 16);
    expect(a.result.matrices).not.toBe(b.result.matrices);
    expect(a.result.matrices).toEqual(b.result.matrices);
    expect(a.phases).toEqual(b.phases);
    expect(
      a.phases.filter((phase) => phase.startsWith("actual-input")),
    ).toEqual(["actual-input-step-0", "actual-input-step-1"]);
    expect(f.state.inputStarts).toBe(2);
    expect(f.state.inputCloses).toBe(2);
    expect(a.result.isCurrent()).toBe(true);
    expect(a.result.diagnostics.deferredTerrain).toBe(0);
    expect(Object.isFrozen(a.result.diagnostics)).toBe(true);
    expect(Object.isFrozen(a.result.diagnostics.rejected)).toBe(true);
    expect(Reflect.set(a.result.diagnostics, "deferredTerrain", 99)).toBe(
      false,
    );
    expect(Array.from(f.geometry.getAttribute("position").array)).toEqual(
      before,
    );
  });

  it("keeps all matrices in retained world cells identical when the horizon moves", () => {
    const f = fixture();
    const a = drain(f.request()).result;
    const b = drain(f.request({ origin: { x: 12, z: 4 } })).result;
    const byPoint = new Map(
      rows(b).map((row) => [`${row[12]},${row[14]}`, row]),
    );
    let retained = 0;
    for (const row of rows(a)) {
      if (Math.hypot(row[12] - 12, row[14] - 4) > 40) continue;
      expect(byPoint.get(`${row[12]},${row[14]}`)).toEqual(row);
      retained++;
    }
    expect(retained).toBeGreaterThan(0);
    expect(drain(f.request({ seed: 1729 })).result.matrices).not.toEqual(
      a.matrices,
    );
  });

  it("samples the actual retained face at Float32 XZ and reports only root-center rounding", () => {
    const f = fixture((x, z) => 10.123456 + x * 0.0321 + z * 0.0143);
    const result = drain(f.request()).result;
    const sample: TerrainGridSample = {
      height: 0,
      nx: 0,
      ny: 0,
      nz: 0,
      faceIndex: -1,
    };
    let error = 0;
    for (const row of rows(result)) {
      expect(f.surface.sample(row[12], row[14], sample)).toBe(true);
      expect(row[13]).toBe(Math.fround(sample.height));
      error = Math.max(error, Math.abs(row[13] - sample.height));
      expect(row[5]).toBeGreaterThanOrEqual(0.85);
      expect(row[5]).toBeLessThanOrEqual(1.15);
      expect([row[1], row[3], row[4], row[6], row[7], row[9], row[11]]).toEqual(
        [0, 0, 0, 0, 0, 0, 0],
      );
      expect(row[15]).toBe(1);
      expect(Math.hypot(row[0], row[2])).toBeCloseTo(row[5], 6);
    }
    expect(result.diagnostics.maximumRootYRoundingError).toBe(error);
    expect(error).toBeGreaterThan(0);
  });

  it("uses the same complete capture bounds and preserves registered storage", () => {
    const f = fixture();
    const material = new THREE.MeshStandardNodeMaterial();
    const mesh = createStorageInstancedMesh(f.geometry, material, 512);
    cleanups.push(() => {
      mesh.dispose();
      material.dispose();
    });
    const storage = mesh.instanceMatrix;
    const before = Array.from(storage.array);
    const bounds = getRootedFlowerPlacementBounds(f.geometry, { x: 4, z: 4 });
    expect(bounds.maxX - 4).toBeGreaterThan(44);
    expect(bounds.maxX - 4).toBeLessThan(45);
    const region = { ...f.region, bounds };
    expect(drain(f.request({ region })).result.count).toBeGreaterThan(0);
    expect(mesh.instanceMatrix).toBe(storage);
    expect(Array.from(storage.array)).toEqual(before);
    expect(() =>
      drain(
        f.request({
          region: {
            ...region,
            bounds: { ...bounds, maxX: bounds.maxX - 0.001 },
          },
        }),
      ),
    ).toThrow(/swept horizon/);
  });

  it("rejects steep faces, ocean, and zero grass eligibility without a height fallback", () => {
    const steep = fixture((x) => 100 + x * 0.8);
    const slope = drain(steep.request()).result;
    expect(slope.count).toBe(0);
    expect(slope.diagnostics.rejected.slope).toBeGreaterThan(0);
    const flat = fixture();
    const water = drain(flat.request({ oceanLevel: 20 })).result;
    expect(water.count).toBe(0);
    expect(water.diagnostics.rejected.water).toBeGreaterThan(0);
    const habitat = drain(flat.request({ grassPlacement: () => 0 })).result;
    expect(habitat.count).toBe(0);
    expect(habitat.diagnostics.deferredTerrain).toBe(0);
    expect(habitat.diagnostics.rejected.habitat).toBeGreaterThan(0);
  });

  it("defers holes and overlapping owners, but proves known exclusions first", () => {
    const f = fixture();
    const missing: RetainedTerrainRegion = { ...f.region, surfaces: [] };
    const holes = drain(f.request({ region: missing })).result;
    expect(holes.count).toBe(0);
    expect(holes.diagnostics.deferredTerrain).toBeGreaterThan(0);
    const otherGeometry = gridGeometry(128, 5, () => 10);
    cleanups.push(() => otherGeometry.dispose());
    const other = new RetainedTerrainSurface(
      2,
      "flower-placement-test",
      0,
      0,
      128,
      5,
      otherGeometry,
    );
    const overlap = drain(
      f.request({ region: { ...f.region, surfaces: [f.surface, other] } }),
    ).result;
    expect(overlap.count).toBe(0);
    expect(overlap.diagnostics.rejected.overlap).toBeGreaterThan(0);
    expect(overlap.diagnostics.deferredTerrain).toBe(
      overlap.diagnostics.rejected.overlap,
    );
    const road = {
      startX: 4,
      startZ: 4,
      endX: 4,
      endZ: 4,
      width: 200,
      blendWidth: 1,
    };
    const excluded = drain(
      f.request({ region: missing, inputs: f.input(empty(), [road]) }),
    ).result;
    expect(excluded.count).toBe(0);
    expect(excluded.diagnostics.rejected.road).toBeGreaterThan(0);
    expect(excluded.diagnostics.deferredTerrain).toBe(0);
  });

  it("clears full road blends and polygon/water envelopes beyond the root point", () => {
    const f = fixture();
    const baseline = drain(f.request()).result;
    const row = rows(baseline)[0];
    const x = row[12],
      z = row[14];
    const reach = baseline.diagnostics.maximumHorizontalReach;
    const retains = (result: RootedFlowerPlacementResult) =>
      rows(result).some(
        (candidate) => candidate[12] === x && candidate[14] === z,
      );
    const road = {
      startX: x + reach / 2 + 0.1,
      endX: x + reach / 2 + 0.1,
      startZ: z,
      endZ: z,
      width: 0.1,
      blendWidth: 0.1,
      maxInfluence: 0,
    };
    expect(
      retains(drain(f.request({ inputs: f.input(empty(), [road]) })).result),
    ).toBe(false);
    const minX = x + 0.01,
      maxX = x + 0.02,
      minZ = z + 0.01,
      maxZ = z + 0.02;
    const polygon = {
      id: "flower-pad",
      minX,
      maxX,
      minZ,
      maxZ,
      vertices: [
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
      ],
    };
    expect(
      retains(
        drain(
          f.request({
            inputs: f.input({ ...empty(), exclusionPolygons: [polygon] }),
          }),
        ).result,
      ),
    ).toBe(false);
    expect(
      retains(
        drain(
          f.request({
            inputs: f.input({
              ...empty(),
              waterBodies: [
                {
                  id: "flower-water",
                  centerX: x + 0.02,
                  centerZ: z,
                  radius: 0.005,
                  surfaceY: 5,
                },
              ],
            }),
          }),
        ).result,
      ),
    ).toBe(false);
  });

  it("admits an actual deterministic candidate exactly on an agreeing shared edge", () => {
    const f = fixture(() => 10);
    const target = rows(drain(f.request()).result)[0];
    const seam = target[12];
    const leftGeometry = gridGeometry(128, 5, () => 10);
    const rightGeometry = gridGeometry(128, 5, () => 10);
    const left = new RetainedTerrainSurface(
      3,
      "flower-placement-test",
      seam - 64,
      0,
      128,
      5,
      leftGeometry,
    );
    const right = new RetainedTerrainSurface(
      2,
      "flower-placement-test",
      seam + 64,
      0,
      128,
      5,
      rightGeometry,
    );
    cleanups.push(() => {
      leftGeometry.dispose();
      rightGeometry.dispose();
    });
    const current = () =>
      left.matchesGeometry(leftGeometry) &&
      right.matchesGeometry(rightGeometry);
    const region = {
      bounds: f.region.bounds,
      surfaces: [left, right],
      isCurrent: current,
    };
    const a = drain(f.request({ region })).result;
    const b = drain(
      f.request({ region: { ...region, surfaces: [right, left] } }),
    ).result;
    expect(a.diagnostics.deferredTerrain).toBe(0);
    expect(a.diagnostics.rejected.overlap).toBe(0);
    expect(
      rows(a).find((row) => row[12] === target[12] && row[14] === target[14]),
    ).toEqual(target);
    expect(a.matrices).toEqual(b.matrices);
  });

  it.each(["steep", "cracked"] as const)(
    "fails closed at a %s shared edge without picking the easy owner",
    (kind) => {
      const f = fixture(() => 10);
      const target = rows(drain(f.request()).result)[0];
      const seam = target[12];
      const leftGeometry = gridGeometry(128, 5, () => 10);
      const rightGeometry = gridGeometry(128, 5, (x) =>
        kind === "steep" ? 10 + (x + 64) * 0.8 : 10.01,
      );
      const left = new RetainedTerrainSurface(
        1,
        "flower-placement-test",
        seam - 64,
        0,
        128,
        5,
        leftGeometry,
      );
      const right = new RetainedTerrainSurface(
        2,
        "flower-placement-test",
        seam + 64,
        0,
        128,
        5,
        rightGeometry,
      );
      cleanups.push(() => {
        leftGeometry.dispose();
        rightGeometry.dispose();
      });
      const region = {
        bounds: f.region.bounds,
        surfaces: [left, right],
        isCurrent: () =>
          left.matchesGeometry(leftGeometry) &&
          right.matchesGeometry(rightGeometry),
      };
      const result = drain(f.request({ region })).result;
      expect(
        rows(result).some(
          (row) => row[12] === target[12] && row[14] === target[14],
        ),
      ).toBe(false);
      if (kind === "steep") {
        expect(result.diagnostics.rejected.slope).toBeGreaterThan(0);
        expect(result.diagnostics.deferredTerrain).toBe(0);
      } else {
        expect(result.diagnostics.rejected.surface).toBeGreaterThan(0);
        expect(result.diagnostics.deferredTerrain).toBeGreaterThan(0);
      }
    },
  );

  it("rejects actual live resource envelopes and makes prior results stale on additions", () => {
    const f = fixture();
    const old = drain(f.request()).result;
    const row = rows(old)[0];
    const tree = addTree(f.world, row[12], row[14]);
    expect(old.isCurrent()).toBe(false);
    const resources = captureFlowerResourceClearance(f.world);
    const result = drain(f.request({ resources })).result;
    expect(result.diagnostics.rejected.resource).toBeGreaterThan(0);
    expect(
      rows(result).some(
        (candidate) => candidate[12] === row[12] && candidate[14] === row[14],
      ),
    ).toBe(false);
    tree.position.x += 1;
    expect(result.isCurrent()).toBe(false);
  });

  it("guards borrowed-read boundaries and closes cancelled input without releasing owners", () => {
    const f = fixture();
    const input = f.input();
    const steps = createRootedFlowerPlacementSteps(
      f.request({ inputs: input }),
    );
    for (;;) {
      const next = steps.next();
      if (next.done) throw new Error("Expected suspended input");
      if (next.value === "actual-input-step-0") break;
    }
    steps.return(undefined as never);
    expect(f.state.inputCloses).toBe(1);
    expect(f.region.isCurrent()).toBe(true);
    const stale = createRootedFlowerPlacementSteps(f.request());
    expect(stale.next().done).toBe(false);
    f.state.inputs = false;
    expect(() => {
      for (let step = 0; step < 2000; step++) {
        const next = stale.next();
        if (next.done) throw new Error("Unexpected stale publication");
        if (next.value === "flower_root_sample")
          throw new Error("Unexpected stale sampling");
      }
    }).toThrow(/Stale/);
    f.state.inputs = true;
    const changed = createRootedFlowerPlacementSteps(f.request());
    changed.next();
    f.geometry.getAttribute("position").needsUpdate = true;
    expect(() => changed.next()).toThrow(/Stale/);
  });

  it("rejects reuse and malformed bounded inputs", () => {
    const f = fixture();
    const input = f.input();
    drain(f.request({ inputs: input }));
    expect(() => drain(f.request({ inputs: input }))).toThrow(/reused/);
    expect(() => drain(f.request({ seed: 1.5 }))).toThrow(/request/);
    expect(() => drain(f.request({ origin: { x: 0, z: 0 } }))).toThrow(
      /request/,
    );
    expect(() => drain(f.request({ grassPlacement: () => NaN }))).toThrow(
      /eligibility/,
    );
    expect(() =>
      drain(
        f.request({
          inputs: f.input(empty(), [
            { startX: 0, startZ: 0, endX: 1, endZ: 0, width: NaN },
          ]),
        }),
      ),
    ).toThrow(/road capsule/);
    expect(() =>
      drain(
        f.request({
          inputs: f.input(
            empty(),
            Array.from({ length: 4097 }, () => ({
              startX: 0,
              startZ: 0,
              endX: 1,
              endZ: 0,
              width: 1,
            })),
          ),
        }),
      ),
    ).toThrow(/constraint inputs/);
  });
});
