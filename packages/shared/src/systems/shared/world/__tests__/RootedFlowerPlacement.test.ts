import { afterEach, describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EntityType, ResourceType } from "../../../../types/entities";
import { createRootedFlowerGeometry } from "../../../../../../procgen/src/flowers/RootedFlowerGeometry";
import type { GrassTerrainSurfaceSnapshot } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { createStorageInstancedMesh } from "../../../../utils/rendering/createStorageInstancedMesh";
import { captureFlowerResourceClearance } from "../FlowerResourceClearance";
import { getRootedFlowerWindBounds } from "../RootedFlowerMaterial";
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
  getRootedFlowerCandidatePosition,
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

// Frozen original hash arithmetic, independent of the production helper.
// Population changes must not reshuffle position/acceptance/yaw/scale keys.
function originalFlowerHash(seed: number, x: number, z: number, lane: number) {
  let value =
    (seed ^
      Math.imul(x, 0x9e3779b1) ^
      Math.imul(z, 0x85ebca77) ^
      Math.imul(lane, 0xc2b2ae3d)) >>>
    0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
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
  it.each([0.12, 0.2, 0.38, 0.55, 0.75, 0.8])(
    "retains complete root transforms and clearance decisions for the two-head sprig at height %s",
    (height) => {
      const f = fixture();
      const original = createRootedFlowerGeometry({ height });
      const sprig = createRootedFlowerGeometry({
        height,
        variant: "meadow-sprig-v1",
      });
      cleanups.push(() => {
        original.dispose();
        sprig.dispose();
      });
      const road: GrassGroundingRoadSegment = {
        startX: -40,
        startZ: 0,
        endX: 40,
        endZ: 0,
        width: 3,
        blendWidth: 1,
      };
      const run = (geometry: THREE.BufferGeometry) =>
        drain(
          f.request({
            geometry,
            inputs: f.input(empty(), [road]),
          }),
        ).result;
      const baseline = run(original);
      const candidate = run(sprig);
      expect(baseline.count).toBeGreaterThan(0);
      expect(baseline.diagnostics.rejected.road).toBeGreaterThan(0);
      expect(getRootedFlowerPlacementBounds(sprig, { x: 4, z: 4 })).toEqual(
        getRootedFlowerPlacementBounds(original, { x: 4, z: 4 }),
      );
      expect(candidate.count).toBe(baseline.count);
      expect(candidate.matrices).toEqual(baseline.matrices);
      expect(candidate.diagnostics.maximumHorizontalReach).toBe(
        baseline.diagnostics.maximumHorizontalReach,
      );
      expect(candidate.diagnostics.maximumRootYRoundingError).toBe(
        baseline.diagnostics.maximumRootYRoundingError,
      );
      expect(candidate.diagnostics.rejected).toEqual(
        baseline.diagnostics.rejected,
      );
      expect(candidate.diagnostics.steps).toBeLessThanOrEqual(
        baseline.diagnostics.steps,
      );
      expect(candidate.isCurrent()).toBe(true);
    },
  );

  it("rejects candidate keys outside the continuation's admitted cell domain", () => {
    for (const [seed, cx, cz, ordinal] of [
      [NaN, 0, 0, 0],
      [-2147483649, 0, 0, 0],
      [0x100000000, 0, 0, 0],
      [0, 0.5, 0, 0],
      [0, -(2 ** 17) - 6, 0, 0],
      [0, 0, 2 ** 17 + 5, 0],
      [0, 0, 0, -1],
      [0, 0, 0, 4],
    ]) {
      expect(() =>
        getRootedFlowerCandidatePosition(seed, cx, cz, ordinal),
      ).toThrow(/bounded rooted flower candidate/);
    }
  });

  it("keeps compact candidates separated for supported factory geometry even at extreme Float32 cells", () => {
    let maximumFactoryReach = 0;
    for (const requestedHeight of [0.12, 0.38, 0.5, 0.75, 0.8]) {
      const geometry = createRootedFlowerGeometry({ height: requestedHeight });
      cleanups.push(() => geometry.dispose());
      const position = geometry.getAttribute("position");
      const height = geometry.getAttribute("flowerHeight").getY(0);
      let radius = 0;
      for (let vertex = 0; vertex < position.count; vertex++)
        radius = Math.max(
          radius,
          Math.hypot(position.getX(vertex), position.getZ(vertex)),
        );
      const scale = Math.fround(ROOTED_FLOWER_PLACEMENT_LIMITS.maxScale);
      const wind = getRootedFlowerWindBounds(height, scale);
      const reach =
        radius * scale * (1 + 2e-6) + Math.hypot(wind.x, wind.z) + 1e-5;
      maximumFactoryReach = Math.max(maximumFactoryReach, reach);
      expect(
        getRootedFlowerPlacementBounds(geometry, { x: 4, z: 4 }).maxX - 48,
      ).toBeCloseTo(reach, 12);
    }
    // All factory positions scale linearly with requested height. Below 0.8m,
    // the uncapped wind envelope is monotone, so 0.8m bounds intermediate sizes.
    // Generic admitted geometry can be wider: this is not a new placement gate.
    const nominalMinimum = 2 * 0.65 * Math.sin((Math.PI / 2 - 0.24) / 2);
    expect(nominalMinimum).toBeGreaterThan(0.8);
    const pairRoundingAllowance = Math.SQRT2 / 8;
    expect(nominalMinimum - pairRoundingAllowance).toBeGreaterThan(
      2 * maximumFactoryReach,
    );
    // Distinct cells retain >=0.75m inset on both sides of their shared edge.
    expect(1.5).toBeGreaterThan(2 * maximumFactoryReach);
    const cells = [
      [0, 0],
      [-1, -1],
      [55, 51],
      [-(2 ** 17) - 5, -(2 ** 17) - 5],
      [2 ** 17 + 4, 2 ** 17 + 4],
      [-(2 ** 17) - 5, 2 ** 17 + 4],
      [2 ** 17 + 4, -(2 ** 17) - 5],
      [2 ** 17 - 1, 2 ** 17],
    ] as const;
    for (const seed of [-2147483648, -1, 0, 1, 1728, 0xffffffff])
      for (const [cx, cz] of cells) {
        const candidates = Array.from({ length: 4 }, (_, ordinal) =>
          getRootedFlowerCandidatePosition(seed, cx, cz, ordinal),
        );
        for (const [ordinal, candidate] of candidates.entries()) {
          const angle =
            originalFlowerHash(seed, cx, cz, 1002) * Math.PI * 2 +
            ordinal * (Math.PI / 2) +
            (originalFlowerHash(seed, cx, cz, ordinal * 8) - 0.5) * 0.24;
          const radius =
            0.65 + originalFlowerHash(seed, cx, cz, ordinal * 8 + 1) * 0.3;
          expect(candidate).toEqual({
            x: Math.fround(
              cx * 8 +
                1.75 +
                originalFlowerHash(seed, cx, cz, 1000) * 4.5 +
                Math.cos(angle) * radius,
            ),
            z: Math.fround(
              cz * 8 +
                1.75 +
                originalFlowerHash(seed, cx, cz, 1001) * 4.5 +
                Math.sin(angle) * radius,
            ),
          });
          expect(candidate.x).toBeGreaterThanOrEqual(cx * 8 + 0.75);
          expect(candidate.x).toBeLessThanOrEqual(cx * 8 + 7.25);
          expect(candidate.z).toBeGreaterThanOrEqual(cz * 8 + 0.75);
          expect(candidate.z).toBeLessThanOrEqual(cz * 8 + 7.25);
          for (const other of candidates.slice(ordinal + 1)) {
            const distance = Math.hypot(
              candidate.x - other.x,
              candidate.z - other.z,
            );
            expect(distance).toBeGreaterThanOrEqual(
              nominalMinimum - pairRoundingAllowance - 1e-12,
            );
            expect(distance).toBeLessThanOrEqual(
              1.9 + pairRoundingAllowance + 1e-12,
            );
            expect(distance).toBeGreaterThan(2 * maximumFactoryReach);
          }
        }
      }
  });

  it.each([1, 0.63])(
    "fills sparse patches while preserving original accepted matrices with habitat %s",
    (habitat) => {
      const f = fixture(() => 10);
      const seed = 1728;
      const actual = drain(f.request({ seed, grassPlacement: () => habitat }));
      const expected: number[] = [];
      const previous: number[][] = [];
      let groupedCells = 0;
      let newlyPopulatedGroups = 0;
      for (let cx = -5; cx <= 5; cx++)
        for (let cz = -5; cz <= 5; cz++) {
          const patch = originalFlowerHash(
            seed,
            Math.floor(cx / 3),
            Math.floor(cz / 3),
            100,
          );
          let acceptedInCell = 0;
          for (let ordinal = 0; ordinal < 4; ordinal++) {
            const { x, z } = getRootedFlowerCandidatePosition(
              seed,
              cx,
              cz,
              ordinal,
            );
            if (Math.hypot(x - 4, z - 4) > 40) continue;
            const acceptance = originalFlowerHash(
              seed,
              cx,
              cz,
              ordinal * 8 + 2,
            );
            const formerlyAccepted =
              patch <= 0.42 &&
              acceptance < habitat * (0.25 + 0.5 * (1 - patch / 0.42));
            const accepted = acceptance < habitat * (0.6 + 0.35 * (1 - patch));
            // Raising population must retain every existing transform.
            if (formerlyAccepted) expect(accepted).toBe(true);
            if (!accepted) continue;
            const yaw =
              originalFlowerHash(seed, cx, cz, ordinal * 8 + 3) * Math.PI * 2;
            const scale =
              0.85 + originalFlowerHash(seed, cx, cz, ordinal * 8 + 4) * 0.3;
            const transform = new THREE.Matrix4().compose(
              new THREE.Vector3(x, 10, z),
              new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                yaw,
              ),
              new THREE.Vector3(scale, scale, scale),
            ).elements;
            expected.push(...transform);
            if (formerlyAccepted)
              previous.push(Array.from(new Float32Array(transform)));
            acceptedInCell++;
          }
          if (acceptedInCell >= 2) groupedCells++;
          if (patch > 0.42 && acceptedInCell >= 2) newlyPopulatedGroups++;
        }
      expect(groupedCells).toBeGreaterThan(20);
      expect(newlyPopulatedGroups).toBeGreaterThan(10);
      expect(actual.result.matrices).toEqual(new Float32Array(expected));
      expect(previous.length).toBeGreaterThan(0);
      expect(actual.result.count).toBeGreaterThan(previous.length * 2);
      const actualByRoot = new Map(
        rows(actual.result).map((row) => [`${row[12]},${row[14]}`, row]),
      );
      for (const row of previous)
        expect(actualByRoot.get(`${row[12]},${row[14]}`)).toEqual(row);
      expect(actual.result.diagnostics.candidates).toBe(484);
      expect(
        actual.phases.filter((phase) => phase === "flower_candidate"),
      ).toHaveLength(484);
      expect(actual.result.count).toBe(expected.length / 16);
      expect(ROOTED_FLOWER_PLACEMENT_LIMITS.candidatesPerCell).toBe(4);
      expect(actual.result.count).toBeLessThanOrEqual(
        ROOTED_FLOWER_PLACEMENT_LIMITS.maxCandidates,
      );
    },
  );

  it("is deterministic, broadly populated, detached, and forwards each fresh input step once", () => {
    const f = fixture();
    const before = Array.from(f.geometry.getAttribute("position").array);
    const a = drain(f.request()),
      b = drain(f.request());
    expect(a.result.count).toBeGreaterThan(200);
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

  it("validates every distant road once without repeating it for each flower", () => {
    const f = fixture(() => 10);
    const baseline = drain(f.request());
    const distant = Array.from({ length: 800 }, (_, index) => {
      const offset = 1000 + index;
      const x = index % 2 === 0 ? offset : -offset;
      const z = index % 4 < 2 ? offset : -offset;
      return { startX: x, startZ: z, endX: x + 1, endZ: z + 1, width: 2 };
    });
    const before = distant.map((road) => ({ ...road }));
    const actual = drain(f.request({ inputs: f.input(empty(), distant) }));
    expect(actual.result.matrices).toEqual(baseline.result.matrices);
    expect(actual.result.diagnostics.rejected).toEqual(
      baseline.result.diagnostics.rejected,
    );
    expect(actual.result.diagnostics.inputSteps).toBe(
      baseline.result.diagnostics.inputSteps,
    );
    expect(actual.result.diagnostics.steps).toBe(
      baseline.result.diagnostics.steps + distant.length,
    );
    expect(
      actual.phases.filter((phase) => phase === "flower_road_admission"),
    ).toHaveLength(distant.length);
    expect(actual.phases.filter((phase) => phase === "flower_road")).toEqual(
      [],
    );
    expect(distant).toEqual(before);
    expect(actual.result.isCurrent()).toBe(true);
  });

  it.each([0.5, 0.75])(
    "matches an independent all-road distance oracle at flower height %s without reordering retained roads",
    (height) => {
      const f = fixture(() => 10);
      const geometry = createRootedFlowerGeometry({ height });
      cleanups.push(() => geometry.dispose());
      const baseline = drain(f.request({ geometry })).result;
      const candidates = rows(baseline);
      expect(candidates.length).toBeGreaterThan(100);
      const first = candidates[0];
      const near: GrassGroundingRoadSegment[] = [
        {
          startX: -100,
          startZ: -100,
          endX: 100,
          endZ: 100,
          width: 0.2,
          blendWidth: 0.2,
        },
        { startX: 100, startZ: 8, endX: -100, endZ: 8, width: 0.5 },
        // A zero-length capsule at an actual accepted root.
        {
          startX: first[12],
          startZ: first[14],
          endX: first[12],
          endZ: first[14],
          width: 0,
          blendWidth: 0,
        },
        // Neither centerline enters the horizon; width/blend still affect it.
        {
          startX: 100,
          startZ: -100,
          endX: 100,
          endZ: 100,
          width: 130,
          blendWidth: 0,
        },
        {
          startX: -100,
          startZ: 4,
          endX: -100,
          endZ: 4,
          width: 0,
          blendWidth: 70,
          maxInfluence: 0,
        },
      ];
      const far: GrassGroundingRoadSegment = {
        startX: 1000,
        startZ: 1000,
        endX: 2000,
        endZ: 2000,
        width: 20,
      };
      const position = geometry.getAttribute("position");
      let radius = 0;
      for (let i = 0; i < position.count; i++)
        radius = Math.max(
          radius,
          Math.hypot(position.getX(i), position.getZ(i)),
        );
      // No production AABB/distance helper is used by this oracle. Start from
      // the real no-road population and evaluate every original road capsule.
      const blocked = (row: number[], road: GrassGroundingRoadSegment) => {
        const dx = road.endX - road.startX;
        const dz = road.endZ - road.startZ;
        const lengthSquared = dx * dx + dz * dz;
        const t =
          lengthSquared === 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  ((row[12] - road.startX) * dx +
                    (row[14] - road.startZ) * dz) /
                    lengthSquared,
                ),
              );
        const wind = getRootedFlowerWindBounds(
          geometry.getAttribute("flowerHeight").getY(0),
          row[5],
        );
        const horizontalScale = Math.max(
          Math.hypot(row[0], row[2]),
          Math.hypot(row[8], row[10]),
        );
        const reach =
          radius * horizontalScale * (1 + 2e-6) +
          Math.hypot(wind.x, wind.z) +
          1e-5;
        return (
          Math.hypot(
            row[12] - road.startX - t * dx,
            row[14] - road.startZ - t * dz,
          ) <=
          road.width / 2 + (road.blendWidth ?? 0.5) + reach
        );
      };
      const expected = candidates.filter(
        (row) => ![far, ...near].some((road) => blocked(row, road)),
      );
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(candidates.length);
      expect(expected).not.toContainEqual(first);
      for (const ordered of [near, [...near].reverse()]) {
        const supplied = [far, ...ordered, far];
        const actual = drain(
          f.request({ geometry, inputs: f.input(empty(), supplied) }),
        );
        let expectedRoadSteps = 0;
        for (const row of candidates)
          for (const road of ordered) {
            expectedRoadSteps++;
            if (blocked(row, road)) break;
          }
        expect(rows(actual.result)).toEqual(expected);
        expect(actual.result.diagnostics.rejected.road).toBe(
          candidates.length - expected.length,
        );
        expect(
          actual.phases.filter((phase) => phase === "flower_road_admission"),
        ).toHaveLength(supplied.length);
        expect(
          actual.phases.filter((phase) => phase === "flower_road"),
        ).toHaveLength(expectedRoadSteps);
      }
    },
  );

  it("keeps closed AABB contact on every side and culls only strictly distant roads", () => {
    const f = fixture(() => 10);
    const baseline = drain(f.request()).result;
    const needed = getRootedFlowerPlacementBounds(f.geometry, { x: 4, z: 4 });
    const contact: GrassGroundingRoadSegment[] = [
      {
        startX: needed.minX,
        startZ: 4,
        endX: needed.minX,
        endZ: 4,
        width: 0,
        blendWidth: 0,
      },
      {
        startX: needed.maxX,
        startZ: 4,
        endX: needed.maxX,
        endZ: 4,
        width: 0,
        blendWidth: 0,
      },
      {
        startX: 4,
        startZ: needed.minZ,
        endX: 4,
        endZ: needed.minZ,
        width: 0,
        blendWidth: 0,
      },
      {
        startX: 4,
        startZ: needed.maxZ,
        endX: 4,
        endZ: needed.maxZ,
        width: 0,
        blendWidth: 0,
      },
    ];
    const outside = contact.map((road, index) => ({
      ...road,
      startX: road.startX + (index === 0 ? -1e-6 : index === 1 ? 1e-6 : 0),
      endX: road.endX + (index === 0 ? -1e-6 : index === 1 ? 1e-6 : 0),
      startZ: road.startZ + (index === 2 ? -1e-6 : index === 3 ? 1e-6 : 0),
      endZ: road.endZ + (index === 2 ? -1e-6 : index === 3 ? 1e-6 : 0),
    }));
    const actual = drain(
      f.request({ inputs: f.input(empty(), [...contact, ...outside]) }),
    );
    expect(actual.result.matrices).toEqual(baseline.matrices);
    expect(
      actual.phases.filter((phase) => phase === "flower_road_admission"),
    ).toHaveLength(8);
    expect(
      actual.phases.filter((phase) => phase === "flower_road"),
    ).toHaveLength(baseline.count * 4);
  });

  it("still validates distant roads and applies the raw input cap before culling", () => {
    const f = fixture(() => 10);
    const far = {
      startX: 1000,
      startZ: 1000,
      endX: 1001,
      endZ: 1001,
      width: 1,
    };
    const roads = Array.from({ length: 4096 }, () => ({ ...far }));
    const actual = drain(f.request({ inputs: f.input(empty(), roads) }));
    expect(actual.result.count).toBeGreaterThan(0);
    expect(
      actual.phases.filter((phase) => phase === "flower_road_admission"),
    ).toHaveLength(4096);
    expect(actual.phases.filter((phase) => phase === "flower_road")).toEqual(
      [],
    );
    expect(() =>
      drain(f.request({ inputs: f.input(empty(), [...roads, far]) })),
    ).toThrow(/constraint inputs/);
    for (const invalid of [
      { ...far, startX: NaN },
      { ...far, endZ: Infinity },
      { ...far, width: -1 },
      { ...far, blendWidth: -1 },
      { ...far, startX: 2 ** 21 + 1 },
    ])
      expect(() =>
        drain(f.request({ inputs: f.input(empty(), [far, invalid]) })),
      ).toThrow(/road capsule/);
    expect(() =>
      drain(
        f.request({
          inputs: f.input(empty(), [
            ...roads.slice(0, -1),
            { ...far, width: -1 },
          ]),
        }),
      ),
    ).toThrow(/road capsule/);
  });

  it.each(["cancel", "invalidate"] as const)(
    "preserves %s semantics while distant-road admission is suspended",
    (action) => {
      const f = fixture();
      const far = {
        startX: 1000,
        startZ: 1000,
        endX: 1001,
        endZ: 1001,
        width: 1,
      };
      let disposals = 0;
      f.geometry.addEventListener("dispose", () => disposals++);
      f.terrain.addEventListener("dispose", () => disposals++);
      const steps = createRootedFlowerPlacementSteps(
        f.request({ inputs: f.input(empty(), [far, far]) }),
      );
      let admitted = 0;
      for (let count = 0; count < 2000 && admitted < 2; count++) {
        const step = steps.next();
        if (step.done) throw new Error("Expected suspended road admission");
        if (step.value === "flower_road_admission") admitted++;
      }
      expect(admitted).toBe(2);
      expect(f.state.inputCloses).toBe(1);
      if (action === "cancel") steps.return(undefined as never);
      else {
        f.state.inputs = false;
        expect(() => steps.next()).toThrow(/Stale/);
      }
      expect(f.state.inputCloses).toBe(1);
      expect(disposals).toBe(0);
      expect(f.region.isCurrent()).toBe(true);
    },
  );

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
