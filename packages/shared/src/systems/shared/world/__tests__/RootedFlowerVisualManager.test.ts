import { afterEach, describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EntityType, ResourceType } from "../../../../types/entities";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  createGrassTerrainSurfaceOperations,
  createGrassTerrainSurfaceSnapshot,
} from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import { INSTANCE_MATRIX_STORAGE_ATTRIBUTE } from "../../../../utils/rendering/createStorageInstancedMesh";
import type { GrassGroundingInputLease } from "../GrassGroundingPipeline";
import type { GrassGroundingRoadSegment } from "../GrassBladeGrounding";
import type { TerrainGridBounds } from "../TerrainGridSurface";
import {
  TerrainVisualManager,
  type VisualManagerTerrainProvider,
} from "../TerrainVisualManager";
import { BiomeType } from "../TerrainBiomeTypes";
import { COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";
import { WaterBodyRegistry } from "../WaterBodyRegistry";
import { Wind } from "../Wind";
import { captureFlowerResourceClearance } from "../FlowerResourceClearance";
import {
  assertRootedFlowerPool,
  getRootedFlowerWindBounds,
} from "../RootedFlowerMaterial";
import {
  ROOTED_FLOWER_OWNER_LIMITS,
  RootedFlowerVisualManager,
} from "../RootedFlowerVisualManager";

// Numerical terrain input, not a replacement manager, sampler, clock or loader.
// Actual production chunk generation/admission owns all retained triangles.
class NumericalTerrain implements VisualManagerTerrainProvider {
  private readonly config = createTerrainWorkerConfig(
    COMPACT_WORLD_TERRAIN_PROFILE,
    9,
  );
  readonly terrainProfileIdentity = this.config.TERRAIN_PROFILE_IDENTITY;
  readonly TILE_SIZE = this.config.TILE_SIZE;
  readonly MAX_HEIGHT = this.config.MAX_HEIGHT;
  readonly WATER_LEVEL_NORMALIZED = this.config.WATER_LEVEL_NORMALIZED;
  readonly SHORELINE_THRESHOLD = this.config.SHORELINE_THRESHOLD;
  readonly SHORELINE_STRENGTH = this.config.SHORELINE_STRENGTH;
  capturePreparationLease() {
    return Object.freeze({ isCurrent: () => true });
  }
  getHeightAtComputed(x: number, z: number) {
    return 20 + 0.004 * x + 0.006 * z + 0.0001 * x * z;
  }
  getFlatZoneHeight() {
    return null;
  }
  calculateRoadInfluenceAtVertex() {
    return 0;
  }
  computeBiomeWeightsAtPosition() {
    return { biomeWeightMap: new Map([[BiomeType.Forest, 1]]), totalWeight: 1 };
  }
  computeBiomeWeightsByPosition() {
    return { [BiomeType.Forest]: 1 };
  }
  getBiomeId() {
    return 1;
  }
  getBiomeColor() {
    return { r: 0.2, g: 0.4, b: 0.1 };
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

function fixture(
  options: { terrain?: boolean; inputRoads?: number; seed?: number } = {},
) {
  const world = new World();
  const registered = world.register("wind", Wind);
  if (!(registered instanceof Wind))
    throw new Error("Actual registered wind missing");
  const wind = registered;
  const parent = new THREE.Group();
  const terrainParent = new THREE.Group();
  const terrainMaterial = new THREE.MeshStandardNodeMaterial();
  const provider = new NumericalTerrain();
  const config = createTerrainWorkerConfig(COMPACT_WORLD_TERRAIN_PROFILE, 9);
  const visual = new TerrainVisualManager(
    { minSize: 256, maxDepth: 1, resolution: 9, rootChunkRadius: 0 },
    provider,
    terrainParent,
    terrainMaterial,
    config,
    COMPACT_WORLD_TERRAIN_PROFILE.seed,
    [],
    {},
  );
  let createdOwner: RootedFlowerVisualManager | undefined;
  cleanups.push(() => {
    createdOwner?.destroy();
    visual.dispose();
    terrainMaterial.dispose();
    world.destroy();
  });
  const node = visual.getQuadTree().createNode(null, null, 256, 4, 4, 1);
  const installTerrain = () => visual["generateChunkSync"](node);
  if (options.terrain !== false) installTerrain();
  const water = new WaterBodyRegistry(0);
  const captures: Readonly<TerrainGridBounds>[] = [];
  const ledger = { created: 0, started: 0, closed: 0, yielded: 0 };
  const roads: GrassGroundingRoadSegment[] = Array.from(
    { length: options.inputRoads ?? 0 },
    (_, index) => ({
      startX: 10000 + index,
      startZ: 10000,
      endX: 10000 + index,
      endZ: 10001,
      width: 1,
      blendWidth: 0.5,
    }),
  );
  const prepareInputs = (
    bounds: TerrainGridBounds,
  ): GrassGroundingInputLease => {
    ledger.created++;
    const lease = water.captureRegion(bounds);
    const source = createGrassTerrainSurfaceSnapshot({
      zones: [],
      arenaFloorIds: [],
      arenaGradeHeight: null,
      waterBodies: water
        .getAllBodies()
        .map(({ id, centerX, centerZ, radius, surfaceY }) => ({
          id,
          centerX,
          centerZ,
          radius,
          surfaceY,
        })),
    });
    return {
      isCurrent: lease.isCurrent,
      steps: (function* () {
        ledger.started++;
        try {
          const terrainSurface =
            yield* createGrassTerrainSurfaceOperations().cloneSnapshotSteps(
              source,
            );
          const roadSegments: GrassGroundingRoadSegment[] = [];
          for (const road of roads) {
            ledger.yielded++;
            yield "numerical_constraint_road_copy";
            roadSegments.push({ ...road });
          }
          return { terrainSurface, roadSegments };
        } finally {
          ledger.closed++;
        }
      })(),
    };
  };
  const owner = new RootedFlowerVisualManager({
    world,
    parent,
    seed: options.seed ?? 12345,
    oceanLevel: 0,
    captureRegion(bounds, maximumSurfaces) {
      captures.push(Object.freeze({ ...bounds }));
      return visual.captureRetainedSurfaceRegion(bounds, maximumSurfaces);
    },
    prepareInputs,
    grassPlacement: () => 1,
  });
  createdOwner = owner;
  const candidate = parent.getObjectByName("RootedMeadowFlowers");
  if (!(candidate instanceof THREE.InstancedMesh))
    throw new Error("Actual flower storage mesh missing");
  const mesh = candidate;
  if (!(mesh.material instanceof THREE.MeshStandardNodeMaterial))
    throw new Error("Actual flower material missing");
  const material = mesh.material;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(4, 30, 4);
  camera.updateMatrixWorld(true);
  return {
    world,
    wind,
    parent,
    terrainParent,
    visual,
    node,
    installTerrain,
    water,
    captures,
    ledger,
    owner,
    mesh,
    material,
    camera,
  };
}

type Fixture = ReturnType<typeof fixture>;

// Real clock and existing owner budgets are never replaced or stretched.
// This finite driver checks resumptions, not machine-dependent performance.
function pump(
  f: Fixture,
  until: () => boolean = () => f.owner.getReceipt().ready,
  maximumUpdates = 4000,
) {
  for (let update = 0; update < maximumUpdates; update++) {
    if (until()) return update;
    const before = f.owner.getReceipt().totalResumptions;
    f.owner.update(4, 4);
    const receipt = f.owner.getReceipt();
    expect(receipt.totalResumptions - before).toBeLessThanOrEqual(
      ROOTED_FLOWER_OWNER_LIMITS.maxResumptionsPerUpdate,
    );
    if (receipt.lastError) throw new Error(receipt.lastError);
  }
  throw new Error("Flower fixture exceeded its finite update bound");
}

function liveMatrices(f: Fixture) {
  return Array.from(f.mesh.instanceMatrix.array.slice(0, f.mesh.count * 16));
}

function addTree(f: Fixture, id: string, x: number, z: number) {
  const resource = new ResourceEntity(f.world, {
    id,
    name: id,
    type: EntityType.RESOURCE,
    position: { x, y: 20, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: null,
    interactionDistance: 3,
    description: "Actual flower-resource integration fixture",
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
  f.world.entities.set(id, resource);
  return resource;
}

describe("bounded actual rooted-flower owner (CPU lifecycle, not GPU/performance proof)", () => {
  it("starts hidden with an exclusive 512-slot storage allocation and no synchronous publication", () => {
    const f = fixture();
    expect(f.owner.getReceipt()).toMatchObject({
      ready: false,
      pending: false,
      count: 0,
      capacity: 512,
      totalResumptions: 0,
    });
    expect(f.mesh.visible).toBe(false);
    expect(f.mesh.instanceMatrix).toBeInstanceOf(
      THREE.StorageInstancedBufferAttribute,
    );
    expect(f.mesh.instanceMatrix.count).toBe(512);
    expect(
      f.mesh.geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE),
    ).toBe(f.mesh.instanceMatrix);
    expect(f.mesh.frustumCulled).toBe(true);
    expect(f.material.transparent).toBe(false);
    expect(f.material.opacity).toBe(1);
    f.owner.update(4, 4);
    expect(f.owner.getReceipt()).toMatchObject({
      ready: false,
      pending: true,
      completedJobs: 0,
    });
    expect(f.owner.getReceipt().totalResumptions).toBeLessThanOrEqual(256);
  });

  it("publishes deterministic actual matrices on the retained triangles after multiple bounded slices", () => {
    const f = fixture();
    const updates = pump(f);
    const receipt = f.owner.getReceipt();
    expect(updates).toBeGreaterThan(1);
    expect(receipt).toMatchObject({
      ready: true,
      pending: false,
      completedJobs: 1,
      failedJobs: 0,
    });
    expect(receipt.count).toBeGreaterThan(0);
    expect(receipt.count).toBeLessThanOrEqual(484);
    expect(receipt.placement?.deferredTerrain).toBe(0);
    expect(receipt.totalResumptions).toBeGreaterThan(256);
    expect(receipt.maximumSliceMs).toBeGreaterThanOrEqual(0);
    expect(receipt.maximumPublicationMs).toBeGreaterThanOrEqual(0);
    expect(f.mesh.visible).toBe(true);
    assertRootedFlowerPool(f.mesh);
    const matrix = new THREE.Matrix4();
    const ray = new THREE.Raycaster();
    f.terrainParent.updateMatrixWorld(true);
    for (let index = 0; index < f.mesh.count; index++) {
      f.mesh.getMatrixAt(index, matrix);
      const root = new THREE.Vector3().setFromMatrixPosition(matrix);
      ray.set(
        new THREE.Vector3(root.x, 100, root.z),
        new THREE.Vector3(0, -1, 0),
      );
      const hit = ray.intersectObjects(f.terrainParent.children, true)[0];
      if (!hit)
        throw new Error("Actual retained triangle ray intersection missing");
      expect(root.y).toBe(Math.fround(hit.point.y));
      expect(f.mesh.boundingBox?.containsPoint(root)).toBe(true);
      expect(f.mesh.boundingSphere?.containsPoint(root)).toBe(true);
    }
    const original = liveMatrices(f);
    const array = f.mesh.instanceMatrix.array;
    const version = f.mesh.instanceMatrix.version;
    f.owner.invalidate();
    expect(f.owner.getReceipt().ready).toBe(false);
    pump(f);
    expect(liveMatrices(f)).toEqual(original);
    expect(f.mesh.instanceMatrix.array).toBe(array);
    expect(f.mesh.instanceMatrix.version).toBe(version + 1);
    expect(f.owner.getReceipt().completedJobs).toBe(2);
  });

  it("keeps per-world wind isolated even when the legacy Wind singleton is changed by another world", () => {
    const a = fixture(),
      b = fixture();
    a.wind.setStrength(0.4);
    a.wind.setDirection(new THREE.Vector3(1, 0, 0));
    a.wind.update(3);
    b.wind.setStrength(1.7);
    b.wind.setDirection(new THREE.Vector3(0, 0, -1));
    b.wind.update(9);
    a.owner.prepareForRender(a.camera);
    b.owner.prepareForRender(b.camera);
    const aNodes = a.owner["windNodes"],
      bNodes = b.owner["windNodes"];
    expect(aNodes.time.value).toBe(3);
    expect(bNodes.time.value).toBe(9);
    expect(aNodes.strength.value).toBe(0.4);
    expect(bNodes.strength.value).toBe(1.7);
    expect(aNodes.direction.value.toArray()).toEqual([1, 0]);
    expect(bNodes.direction.value.toArray()).toEqual([0, -1]);
    expect(aNodes.time).not.toBe(bNodes.time);
    a.wind.update(0.25);
    a.owner.prepareForRender(a.camera);
    expect(aNodes.time.value).toBe(3.25);
    expect(bNodes.time.value).toBe(9);
  });

  it("uses the actual parented primary camera for fade focus without shadow-camera render callbacks", () => {
    const f = fixture();
    const cameraParent = new THREE.Group();
    cameraParent.position.set(16, 0, -8);
    cameraParent.add(f.camera);
    cameraParent.updateMatrixWorld(true);
    f.owner.prepareForRender(f.camera);
    expect(f.owner["focus"].value.toArray()).toEqual([20, -4]);
    f.owner.update(1000, 1000);
    expect(f.owner["focus"].value.toArray()).toEqual([20, -4]);
    expect(f.captures).toHaveLength(1);
    expect((f.captures[0].minX + f.captures[0].maxX) / 2).toBe(20);
    expect((f.captures[0].minZ + f.captures[0].maxZ) / 2).toBe(-4);
    expect(f.mesh.onBeforeRender).toBe(THREE.Object3D.prototype.onBeforeRender);
    expect(f.mesh.onBeforeShadow).toBe(THREE.Object3D.prototype.onBeforeShadow);
    expect(f.material.castShadowPositionNode).toBeNull();
    expect(f.material.positionNode).not.toBeNull();
    expect(f.material.opacityNode).toBeNull();
  });

  it("reports a camera cut as not ready before update even while the previous terrain lease remains current", () => {
    const f = fixture();
    f.owner.prepareForRender(f.camera);
    pump(f);
    const completedJobs = f.owner.getReceipt().completedJobs;
    expect(f.owner.getReceipt()).toMatchObject({ ready: true, current: true });

    f.camera.position.x = 20;
    f.camera.updateMatrixWorld(true);
    f.owner.prepareForRender(f.camera);
    // Inspect before update: surviving terrain ownership does not mean the
    // newly selected camera cell already has its completed placement job.
    expect(f.owner.getReceipt()).toMatchObject({
      ready: false,
      current: true,
      pending: false,
      completedJobs,
    });

    pump(f);
    expect(f.owner.getReceipt()).toMatchObject({
      ready: true,
      current: true,
      pending: false,
      completedJobs: completedJobs + 1,
    });
    const capture = f.captures[f.captures.length - 1];
    expect((capture.minX + capture.maxX) / 2).toBe(20);
  });

  it("closes active input work on invalidation and focus migration without partial matrix publication", () => {
    const f = fixture({ inputRoads: 1024 });
    pump(f, () => f.ledger.started === 1 && f.ledger.closed === 0);
    expect(f.owner.getReceipt().pending).toBe(true);
    expect(f.ledger.yielded).toBeGreaterThan(0);
    f.owner.invalidate();
    expect(f.ledger.closed).toBe(1);
    expect(f.owner.getReceipt()).toMatchObject({
      cancelledJobs: 1,
      pending: false,
      count: 0,
      ready: false,
    });
    pump(f, () => f.ledger.started === 2 && f.ledger.closed === 1);
    f.camera.position.x = 20;
    f.camera.updateMatrixWorld(true);
    f.owner.prepareForRender(f.camera);
    f.owner.update(4, 4);
    expect(f.ledger.closed).toBe(2);
    expect(f.owner.getReceipt().cancelledJobs).toBe(2);
    expect(f.mesh.visible).toBe(false);
    expect(f.mesh.count).toBe(0);
  });

  it("retires publication before render on retained-geometry revision or actual water-lease changes", () => {
    const f = fixture();
    pump(f);
    const terrainMesh = f.terrainParent.children.find(
      (child) => child instanceof THREE.Mesh,
    );
    if (!(terrainMesh instanceof THREE.Mesh))
      throw new Error("Actual terrain mesh missing");
    terrainMesh.geometry.getAttribute("position").needsUpdate = true;
    f.owner.prepareForRender(f.camera);
    expect(f.owner.getReceipt().ready).toBe(false);
    expect(f.mesh.count).toBe(0);
    expect(f.mesh.visible).toBe(false);
    const waterCase = fixture();
    pump(waterCase);
    const waterX = waterCase.mesh.instanceMatrix.array[12],
      waterZ = waterCase.mesh.instanceMatrix.array[14];
    const previousCount = waterCase.mesh.count;
    waterCase.water.register({
      id: "new-water",
      centerX: waterX,
      centerZ: waterZ,
      radius: 3,
      radiusSq: 9,
      surfaceY: 25,
      sourceType: "explicit",
    });
    waterCase.owner.prepareForRender(waterCase.camera);
    expect(waterCase.owner.getReceipt().ready).toBe(false);
    expect(waterCase.mesh.count).toBe(0);
    pump(waterCase);
    expect(
      waterCase.owner.getReceipt().placement?.rejected.water,
    ).toBeGreaterThan(0);
    expect(waterCase.mesh.count).toBeLessThan(previousCount);
    for (let index = 0; index < waterCase.mesh.count; index++) {
      const offset = index * 16;
      expect(
        Math.hypot(
          waterCase.mesh.instanceMatrix.array[offset + 12] - waterX,
          waterCase.mesh.instanceMatrix.array[offset + 14] - waterZ,
        ),
      ).toBeGreaterThan(3);
    }
  });

  it("revalidates new and same-ID replaced resources but preserves reserved clearance through depletion", () => {
    const f = fixture();
    pump(f);
    const firstX = f.mesh.instanceMatrix.array[12],
      firstZ = f.mesh.instanceMatrix.array[14];
    const tree = addTree(f, "live-tree", firstX, firstZ);
    f.owner.prepareForRender(f.camera);
    expect(f.mesh.count).toBe(0);
    pump(f);
    const admitted = liveMatrices(f);
    const clearance = captureFlowerResourceClearance(f.world);
    const position = f.mesh.geometry.getAttribute("position");
    let staticRadius = 0;
    for (let vertex = 0; vertex < position.count; vertex++)
      staticRadius = Math.max(
        staticRadius,
        Math.hypot(position.getX(vertex), position.getZ(vertex)),
      );
    for (let index = 0; index < f.mesh.count; index++) {
      const offset = index * 16;
      const data = f.mesh.instanceMatrix.array;
      const wind = getRootedFlowerWindBounds(
        f.mesh.geometry.getAttribute("flowerHeight").getY(0),
        data[offset + 5],
      );
      const horizontalScale = Math.max(
        Math.hypot(data[offset], data[offset + 2]),
        Math.hypot(data[offset + 8], data[offset + 10]),
      );
      const reach =
        staticRadius * horizontalScale * (1 + 2e-6) +
        Math.hypot(wind.x, wind.z) +
        1e-5;
      expect(
        clearance.accepts(
          {
            x: f.mesh.instanceMatrix.array[offset + 12],
            z: f.mesh.instanceMatrix.array[offset + 14],
          },
          reach,
        ),
      ).toBe(true);
    }
    const retainedCount = f.mesh.count;
    const retainedVersion = f.mesh.instanceMatrix.version;
    const completedJobs = f.owner.getReceipt().completedJobs;
    tree.config.depleted = true;
    f.owner.prepareForRender(f.camera);
    f.owner.update(4, 4);
    expect(f.owner.getReceipt()).toMatchObject({
      ready: true,
      pending: false,
      completedJobs,
    });
    expect(f.mesh.visible).toBe(true);
    expect(f.mesh.count).toBe(retainedCount);
    expect(f.mesh.instanceMatrix.version).toBe(retainedVersion);
    expect(liveMatrices(f)).toEqual(admitted);
    tree.config.depleted = false;
    f.owner.prepareForRender(f.camera);
    f.owner.update(4, 4);
    expect(f.owner.getReceipt()).toMatchObject({
      ready: true,
      pending: false,
      completedJobs,
    });
    expect(f.mesh.instanceMatrix.version).toBe(retainedVersion);
    expect(liveMatrices(f)).toEqual(admitted);
    const replacement = addTree(f, tree.id, firstX, firstZ);
    replacement.config.depleted = tree.config.depleted;
    tree.destroy();
    f.owner.prepareForRender(f.camera);
    expect(f.owner.getReceipt().ready).toBe(false);
    expect(f.mesh.count).toBe(0);
    pump(f);
    expect(liveMatrices(f)).toEqual(admitted);
  });

  it("does not retire or regenerate the pool for unrelated far resource additions, edits or removal", () => {
    const f = fixture();
    pump(f);
    const matrices = liveMatrices(f);
    const count = f.mesh.count;
    const version = f.mesh.instanceMatrix.version;
    const completedJobs = f.owner.getReceipt().completedJobs;
    const unchanged = () => {
      f.owner.prepareForRender(f.camera);
      f.owner.update(4, 4);
      expect(f.owner.getReceipt()).toMatchObject({
        ready: true,
        pending: false,
        completedJobs,
      });
      expect(f.mesh.visible).toBe(true);
      expect(f.mesh.count).toBe(count);
      expect(f.mesh.instanceMatrix.version).toBe(version);
      expect(liveMatrices(f)).toEqual(matrices);
    };
    const distant = addTree(f, "far-tree", 500, 500);
    unchanged();
    distant.position.set(600, 20, 600);
    distant.config.footprint = "massive";
    distant.config.depleted = true;
    unchanged();
    expect(f.world.entities.remove(distant.id)).toBe(true);
    unchanged();
  });

  it("cancels a suspended actual water lease and closes its active generator before any publication", () => {
    const f = fixture({ inputRoads: 1024 });
    pump(f, () => f.ledger.started === 1 && f.ledger.closed === 0);
    f.water.register({
      id: "arriving-water",
      centerX: 4,
      centerZ: 4,
      radius: 1,
      radiusSq: 1,
      surfaceY: 24,
      sourceType: "explicit",
    });
    f.owner.update(4, 4);
    expect(f.ledger.closed).toBe(1);
    expect(f.owner.getReceipt().cancelledJobs).toBe(1);
    expect(f.owner.getReceipt().completedJobs).toBe(0);
    expect(f.mesh.count).toBe(0);
    pump(f, () => f.ledger.started === 2 && f.ledger.closed === 1);
    f.owner.destroy();
    expect(f.ledger.closed).toBe(2);
    expect(f.owner.getReceipt()).toMatchObject({
      pending: false,
      ready: false,
      count: 0,
      destroyed: true,
    });
  });

  it("never calls missing terrain a ready empty publication and can recover after actual terrain arrives", () => {
    const f = fixture({ terrain: false });
    pump(
      f,
      () =>
        !f.owner.getReceipt().pending &&
        f.owner.getReceipt().totalResumptions > 256,
    );
    expect(f.owner.getReceipt().ready).toBe(false);
    expect(f.owner.getReceipt().placement?.deferredTerrain).toBeGreaterThan(0);
    expect(f.mesh.visible).toBe(false);
    expect(f.mesh.count).toBe(0);
    f.installTerrain();
    // The actual retained-region lease detects arrival at the normal render
    // hook; no manual invalidate or fake clock advance manufactures recovery.
    f.owner.prepareForRender(f.camera);
    pump(f);
    expect(f.owner.getReceipt().ready).toBe(true);
    expect(f.mesh.count).toBeGreaterThan(0);
  });

  it("disposes only the exclusive flower resources, exactly once, and leaves borrowed terrain alive", () => {
    const f = fixture();
    pump(f);
    let geometries = 0,
      materials = 0,
      meshes = 0,
      terrainDisposals = 0;
    f.mesh.geometry.addEventListener("dispose", () => geometries++);
    f.material.addEventListener("dispose", () => materials++);
    f.mesh.addEventListener("dispose", () => meshes++);
    const terrainMesh = f.terrainParent.children.find(
      (child) => child instanceof THREE.Mesh,
    );
    if (!(terrainMesh instanceof THREE.Mesh))
      throw new Error("Actual terrain mesh missing");
    terrainMesh.geometry.addEventListener("dispose", () => terrainDisposals++);
    const surface = f.visual.getRetainedSurface(f.node);
    if (!surface) throw new Error("Borrowed retained surface missing");
    f.owner.destroy();
    f.owner.destroy();
    f.owner.update(4, 4);
    f.owner.prepareForRender(f.camera);
    expect({ geometries, materials, meshes, terrainDisposals }).toEqual({
      geometries: 1,
      materials: 1,
      meshes: 1,
      terrainDisposals: 0,
    });
    expect(f.parent.children).toHaveLength(0);
    expect(f.owner.getReceipt()).toMatchObject({
      ready: false,
      pending: false,
      count: 0,
      destroyed: true,
    });
    expect(f.visual.getRetainedSurface(f.node)).toBe(surface);
    expect(surface.matchesGeometry(terrainMesh.geometry)).toBe(true);
  });
});
