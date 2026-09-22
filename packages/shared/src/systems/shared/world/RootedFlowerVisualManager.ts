import THREE, { uniform } from "../../../extras/three/three";
import { FlowerGen } from "@hyperforge/procgen";
import type { World } from "../../../core/World";
import { createStorageInstancedMesh } from "../../../utils/rendering/createStorageInstancedMesh";
import { captureFlowerResourceClearance } from "./FlowerResourceClearance";
import type { GrassGroundingInputLease } from "./GrassGroundingPipeline";
import type { TerrainGridBounds } from "./TerrainGridSurface";
import type { RetainedTerrainRegion } from "./TerrainVisualManager";
import {
  assertRootedFlowerPool,
  createRootedFlowerMaterial,
  getRootedFlowerWindBounds,
} from "./RootedFlowerMaterial";
import {
  createRootedFlowerPlacementSteps,
  getRootedFlowerPlacementBounds,
  type RootedFlowerPlacementResult,
} from "./RootedFlowerPlacement";
import { Wind } from "./Wind";

/** Independent flower work allowance: never borrowed from grass readiness or
 * its worker scheduler. Time is an observed soft slice; a generator resumption
 * is indivisible, so overruns remain visible in the receipt. */
export const ROOTED_FLOWER_OWNER_LIMITS = Object.freeze({
  capacity: 512,
  maxSurfaces: 16,
  sliceMs: 1,
  maxResumptionsPerUpdate: 256,
  maxResumptionsPerJob: 250_000,
  retryDelayMs: 1000,
});

type PlacementJob = {
  origin: { x: number; z: number };
  region: RetainedTerrainRegion;
  inputs: GrassGroundingInputLease;
  resources: ReturnType<typeof captureFlowerResourceClearance>;
  steps: Generator<string, RootedFlowerPlacementResult, void>;
  resumptions: number;
};

export type RootedFlowerVisualOptions = Readonly<{
  world: World;
  parent: THREE.Object3D;
  seed: number;
  oceanLevel: number;
  captureRegion(
    bounds: TerrainGridBounds,
    maximumSurfaces: number,
  ): RetainedTerrainRegion;
  prepareInputs(bounds: TerrainGridBounds): GrassGroundingInputLease;
  grassPlacement(x: number, z: number): number;
}>;

/** Explicit candidate only. One bounded, exclusively owned storage pool is
 * replaced atomically after its actual terrain/resource leases are rechecked.
 * It does not create physics objects, modify gameplay, or sample procedural Y. */
export class RootedFlowerVisualManager {
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly focus = uniform(new THREE.Vector2());
  private readonly windNodes = {
    time: uniform(0),
    strength: uniform(0),
    direction: uniform(new THREE.Vector2()),
  };
  private readonly wind: Wind;
  private readonly cameraPosition = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly up = new THREE.Vector3();
  private readonly identity = new THREE.Matrix4();
  private job: PlacementJob | null = null;
  private published: {
    origin: { x: number; z: number };
    result: RootedFlowerPlacementResult;
  } | null = null;
  private destroyed = false;
  private hasPrimaryFocus = false;
  private lastError: string | null = null;
  private retryAt = 0;
  private completedJobs = 0;
  private cancelledJobs = 0;
  private failedJobs = 0;
  private maximumSliceMs = 0;
  private maximumValidationMs = 0;
  private maximumPublicationMs = 0;
  private sliceOverruns = 0;
  private totalResumptions = 0;

  constructor(private readonly options: RootedFlowerVisualOptions) {
    if (
      !Number.isSafeInteger(options.seed) ||
      !Number.isFinite(options.oceanLevel)
    )
      throw new Error("Invalid rooted flower world inputs");
    const wind = options.world.getSystem("wind");
    if (!(wind instanceof Wind))
      throw new Error("Rooted flowers require the actual world wind owner");
    this.wind = wind;
    options.parent.updateWorldMatrix(true, false);
    if (!options.parent.matrixWorld.equals(this.identity))
      throw new Error("Rooted flower parent must remain at world identity");
    // This taller meadow variety lifts blossoms through the existing grass canopy;
    // the factory default remains a separate, smaller flower recipe.
    const geometry = FlowerGen.createRootedFlowerGeometry({ height: 0.75 });
    const material = createRootedFlowerMaterial(this.windNodes, {
      focus: this.focus,
      fadeStart: 24,
      fadeEnd: 32,
    });
    let ownedMesh: THREE.InstancedMesh | null = null;
    try {
      const mesh = createStorageInstancedMesh(
        geometry,
        material,
        ROOTED_FLOWER_OWNER_LIMITS.capacity,
      );
      ownedMesh = mesh;
      mesh.name = "RootedMeadowFlowers";
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      options.parent.add(mesh);
      mesh.updateWorldMatrix(true, false);
      assertRootedFlowerPool(mesh);
      this.geometry = geometry;
      this.material = material;
      this.mesh = mesh;
    } catch (error) {
      ownedMesh?.removeFromParent();
      ownedMesh?.dispose();
      geometry.dispose();
      material.dispose();
      throw error;
    }
  }

  private syncWind(): void {
    const { time, windStrength, windDirection } = this.wind.uniforms;
    if (
      ![
        time.value,
        windStrength.value,
        windDirection.value.x,
        windDirection.value.z,
      ].every(Number.isFinite)
    )
      throw new Error("Nonfinite rooted flower world wind");
    this.windNodes.time.value = time.value;
    this.windNodes.strength.value = windStrength.value;
    this.windNodes.direction.value.set(
      windDirection.value.x,
      windDirection.value.z,
    );
  }

  private currentOrigin() {
    return {
      x: Math.floor(this.focus.value.x / 8) * 8 + 4,
      z: Math.floor(this.focus.value.y / 8) * 8 + 4,
    };
  }

  private sameOrigin(a: { x: number; z: number }, b: { x: number; z: number }) {
    return a.x === b.x && a.z === b.z;
  }

  private cancelJob(): void {
    const job = this.job;
    if (!job) return;
    this.job = null;
    // return() closes delegated input generators as well as candidate work.
    job.steps.return(undefined as never);
    this.cancelledJobs++;
  }

  private retirePublished(): void {
    this.published = null;
    this.mesh.visible = false;
    this.mesh.count = 0;
  }

  invalidate(): void {
    if (this.destroyed) return;
    this.cancelJob();
    this.retirePublished();
    this.lastError = null;
    this.retryAt = 0;
  }

  /** Primary camera only, called by the existing main-render preparation hook.
   * Never change object visibility from the light's frustum or shadow camera. */
  prepareForRender(camera: THREE.Camera): void {
    if (this.destroyed) return;
    try {
      camera.getWorldPosition(this.cameraPosition);
      if (
        ![this.cameraPosition.x, this.cameraPosition.z].every(Number.isFinite)
      )
        throw new Error("Invalid rooted flower primary view");
      this.focus.value.set(this.cameraPosition.x, this.cameraPosition.z);
      this.hasPrimaryFocus = true;
      this.syncWind();
      this.mesh.updateWorldMatrix(true, false);
      if (!this.mesh.matrixWorld.equals(this.identity))
        throw new Error("Rooted flower pool left world identity");
      const start = performance.now();
      const current = this.published?.result.isCurrent() ?? true;
      this.maximumValidationMs = Math.max(
        this.maximumValidationMs,
        performance.now() - start,
      );
      if (!current) this.retirePublished();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.cancelJob();
    this.retirePublished();
    this.failedJobs++;
    this.lastError = String(
      error instanceof Error ? error.message : error,
    ).slice(0, 512);
    this.retryAt = performance.now() + ROOTED_FLOWER_OWNER_LIMITS.retryDelayMs;
  }

  private begin(origin: { x: number; z: number }): void {
    // Share the exact arithmetic, not a recomposed radius with different
    // floating-point association at translated world origins.
    const bounds = getRootedFlowerPlacementBounds(this.geometry, origin);
    const region = this.options.captureRegion(
      bounds,
      ROOTED_FLOWER_OWNER_LIMITS.maxSurfaces,
    );
    const inputs = this.options.prepareInputs(bounds);
    const resources = captureFlowerResourceClearance(
      this.options.world,
      {},
      bounds,
    );
    this.job = {
      origin,
      region,
      inputs,
      resources,
      resumptions: 0,
      steps: createRootedFlowerPlacementSteps({
        origin,
        seed: this.options.seed,
        geometry: this.geometry,
        region,
        inputs,
        resources,
        grassPlacement: this.options.grassPlacement,
        oceanLevel: this.options.oceanLevel,
      }),
    };
  }

  private publish(
    job: PlacementJob,
    result: RootedFlowerPlacementResult,
  ): void {
    // No await between the last live membership/terrain check and publication.
    if (
      this.job !== job ||
      !this.sameOrigin(job.origin, this.currentOrigin()) ||
      !result.isCurrent()
    ) {
      this.cancelJob();
      return;
    }
    if (
      !Number.isInteger(result.count) ||
      result.count < 0 ||
      result.count > ROOTED_FLOWER_OWNER_LIMITS.capacity ||
      result.matrices.length !== result.count * 16
    )
      throw new Error("Invalid bounded rooted flower publication");
    const start = performance.now();
    this.mesh.visible = false;
    this.mesh.instanceMatrix.array.set(result.matrices);
    this.mesh.count = result.count;
    assertRootedFlowerPool(this.mesh);
    if (result.count > 0) {
      this.mesh.computeBoundingBox();
      this.mesh.computeBoundingSphere();
      const padding = new THREE.Vector3();
      let spherePadding = 0;
      const height = this.geometry.getAttribute("flowerHeight").getY(0);
      for (let index = 0; index < result.count; index++) {
        this.mesh.getMatrixAt(index, this.matrix);
        this.up.setFromMatrixColumn(this.matrix, 1);
        const bounds = getRootedFlowerWindBounds(height, this.up.length());
        padding.x = Math.max(padding.x, bounds.x);
        padding.y = Math.max(padding.y, bounds.y);
        padding.z = Math.max(padding.z, bounds.z);
        spherePadding = Math.max(spherePadding, bounds.sphere);
      }
      this.mesh.boundingBox!.expandByVector(padding);
      this.mesh.boundingSphere!.radius += spherePadding;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.published = { origin: job.origin, result };
    this.job = null;
    this.completedJobs++;
    this.lastError = null;
    this.mesh.visible = result.count > 0;
    this.maximumPublicationMs = Math.max(
      this.maximumPublicationMs,
      performance.now() - start,
    );
  }

  /** Generation only. Primary focus is captured separately before rendering;
   * the fallback is used only until the first actual camera observation. */
  update(fallbackX: number, fallbackZ: number): void {
    if (this.destroyed) return;
    const start = performance.now();
    try {
      if (!this.hasPrimaryFocus) {
        if (![fallbackX, fallbackZ].every(Number.isFinite))
          throw new Error("Invalid rooted flower fallback focus");
        this.focus.value.set(fallbackX, fallbackZ);
      }
      this.syncWind();
      const origin = this.currentOrigin();
      if (
        this.job &&
        (!this.sameOrigin(this.job.origin, origin) ||
          !this.job.region.isCurrent() ||
          !this.job.inputs.isCurrent())
      )
        this.cancelJob();
      if (
        !this.job &&
        (!this.published || !this.sameOrigin(this.published.origin, origin)) &&
        performance.now() >= this.retryAt
      )
        this.begin(origin);
      const job = this.job;
      if (!job) return;
      for (
        let resumed = 0;
        resumed < ROOTED_FLOWER_OWNER_LIMITS.maxResumptionsPerUpdate;
        resumed++
      ) {
        if (performance.now() - start >= ROOTED_FLOWER_OWNER_LIMITS.sliceMs)
          break;
        if (++job.resumptions > ROOTED_FLOWER_OWNER_LIMITS.maxResumptionsPerJob)
          throw new Error("Rooted flower placement work cap exceeded");
        this.totalResumptions++;
        const step = job.steps.next();
        if (step.done) {
          this.publish(job, step.value);
          break;
        }
      }
    } catch (error) {
      this.fail(error);
    } finally {
      const elapsed = performance.now() - start;
      this.maximumSliceMs = Math.max(this.maximumSliceMs, elapsed);
      if (elapsed > ROOTED_FLOWER_OWNER_LIMITS.sliceMs) this.sliceOverruns++;
    }
  }

  getReceipt() {
    const current = this.published?.result.isCurrent() ?? false;
    return {
      candidate: "rooted-v1" as const,
      ready:
        !this.destroyed &&
        current &&
        this.published !== null &&
        this.sameOrigin(this.published.origin, this.currentOrigin()) &&
        this.published.result.diagnostics.deferredTerrain === 0 &&
        !this.job &&
        this.lastError === null,
      current,
      count: this.mesh.count,
      capacity: ROOTED_FLOWER_OWNER_LIMITS.capacity,
      pending: this.job !== null,
      destroyed: this.destroyed,
      lastError: this.lastError,
      completedJobs: this.completedJobs,
      cancelledJobs: this.cancelledJobs,
      failedJobs: this.failedJobs,
      totalResumptions: this.totalResumptions,
      maximumSliceMs: this.maximumSliceMs,
      maximumValidationMs: this.maximumValidationMs,
      maximumPublicationMs: this.maximumPublicationMs,
      sliceOverruns: this.sliceOverruns,
      placement: this.published?.result.diagnostics ?? null,
      limits: ROOTED_FLOWER_OWNER_LIMITS,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelJob();
    this.retirePublished();
    this.destroyed = true;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
