import THREE from "../../../extras/three/three";
import type { World } from "../../../types";
import { modelCache } from "../../../utils/rendering/ModelCache";
import {
  COMPACT_POND_MODELS,
  type CompactPondModel,
  type CompactPondPlacement,
} from "./CompactPondDressing";
import type { RetainedTerrainSurface } from "./TerrainGridSurface";

type Batch = {
  mesh: THREE.InstancedMesh;
  sourceMatrix: THREE.Matrix4;
};
type Asset = {
  status: "loading" | "loaded" | "failed";
  error: string | null;
  placements: readonly CompactPondPlacement[];
  batches: Batch[];
  signature: string;
  visible: number;
};

/** Bounded static scenery. Cache owns all geometry/material/maps, never this owner. */
export class CompactPondDressingVisuals {
  readonly group = new THREE.Group();
  private readonly assets = new Map<CompactPondModel, Asset>();
  private destroyed = false;
  private elapsed = 0.25;
  private readonly matrix = new THREE.Matrix4();
  private readonly partMatrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly sample = { height: 0, nx: 0, ny: 1, nz: 0, faceIndex: 0 };

  constructor(
    parent: THREE.Object3D,
    readonly placements: readonly CompactPondPlacement[],
  ) {
    if (
      placements.length > 64 ||
      new Set(placements.map((p) => p.id)).size !== placements.length
    )
      throw new Error("Invalid compact pond instance budget/identities");
    this.group.name = "CompactPondDressing";
    for (const model of Object.keys(
      COMPACT_POND_MODELS,
    ) as CompactPondModel[]) {
      this.assets.set(model, {
        status: "loading",
        error: null,
        placements: placements.filter((p) => p.model === model),
        batches: [],
        signature: "",
        visible: 0,
      });
    }
    parent.add(this.group);
  }

  async load(world: World): Promise<void> {
    await Promise.all(
      [...this.assets.keys()].map(async (model) => {
        try {
          const loaded = await modelCache.loadModel(
            "asset://vegetation/compact-pond-v1/" +
              COMPACT_POND_MODELS[model].file,
            world,
            { shareMaterials: true, generateLODs: false },
          );
          if (this.destroyed) return;
          this.install(model, loaded.scene);
        } catch (error) {
          if (this.destroyed) return;
          const asset = this.assets.get(model)!;
          asset.status = "failed";
          asset.error = error instanceof Error ? error.message : String(error);
          console.error(
            "[CompactPondDressing] Asset unavailable:",
            model,
            asset.error,
          );
        }
      }),
    );
  }

  /** Adopt every static mesh/material group, including its complete hierarchy transform. */
  install(model: CompactPondModel, scene: THREE.Object3D): void {
    if (this.destroyed) return;
    const asset = this.assets.get(model)!;
    if (asset.status !== "loading")
      throw new Error("Pond asset already settled");
    scene.updateMatrixWorld(true);
    const sources: THREE.Mesh[] = [];
    const vertex = new THREE.Vector3();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (
        object instanceof THREE.SkinnedMesh ||
        Object.keys(object.geometry.morphAttributes).length
      )
        throw new Error("Pond dressing must be static geometry");
      const positions = object.geometry.getAttribute("position");
      if (!positions || positions.count === 0)
        throw new Error("Empty pond model");
      for (let i = 0; i < positions.count; i++) {
        vertex
          .fromBufferAttribute(positions, i)
          .applyMatrix4(object.matrixWorld);
        if (
          ![vertex.x, vertex.y, vertex.z].every(Number.isFinite) ||
          Math.hypot(vertex.x, vertex.z) > COMPACT_POND_MODELS[model].radius ||
          vertex.y < -0.001 ||
          vertex.y > 1.5
        )
          throw new Error("Pond model exceeds admitted meter/pivot bounds");
      }
      sources.push(object);
    });
    if (!sources.length || sources.length > 8)
      throw new Error("Invalid pond primitive budget");
    // Validate every primitive before allocating or attaching any instance.
    for (const source of sources) {
      const mesh = new THREE.InstancedMesh(
        source.geometry,
        source.material,
        asset.placements.length,
      );
      mesh.name = `CompactPond_${model}_${asset.batches.length}`;
      mesh.count = 0;
      mesh.receiveShadow = true;
      mesh.castShadow = model === "boulder" || model === "bush";
      mesh.frustumCulled = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.compactPondModel = model;
      asset.batches.push({ mesh, sourceMatrix: source.matrixWorld.clone() });
      this.group.add(mesh);
    }
    asset.status = "loaded";
    this.elapsed = 0.25;
  }

  update(
    delta: number,
    surfaceAt: (x: number, z: number) => RetainedTerrainSurface | null,
  ): void {
    if (this.destroyed) return;
    this.elapsed += Number.isFinite(delta) ? Math.max(0, delta) : 0;
    if (this.elapsed < 0.25) return;
    this.elapsed = 0;
    for (const asset of this.assets.values()) {
      if (asset.status !== "loaded") continue;
      const surfaces = asset.placements.map((p) => surfaceAt(p.x, p.z));
      const signature = surfaces.map((s) => s?.revision ?? "missing").join("|");
      if (signature === asset.signature) continue;
      asset.signature = signature;
      let count = 0;
      for (let i = 0; i < asset.placements.length; i++) {
        const p = asset.placements[i],
          surface = surfaces[i];
        if (
          !surface ||
          !surface.sample(
            p.x - surface.centerX,
            p.z - surface.centerZ,
            this.sample,
          )
        )
          continue;
        this.position.set(p.x, this.sample.height - p.burial, p.z);
        this.rotation.setFromAxisAngle(this.up, p.yaw);
        this.scale.setScalar(p.scale);
        this.matrix.compose(this.position, this.rotation, this.scale);
        for (const batch of asset.batches) {
          batch.mesh.setMatrixAt(
            count,
            this.partMatrix.multiplyMatrices(this.matrix, batch.sourceMatrix),
          );
        }
        count++;
      }
      for (const batch of asset.batches) {
        batch.mesh.count = count;
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.mesh.computeBoundingBox();
        batch.mesh.computeBoundingSphere();
      }
      asset.visible = count;
    }
  }

  getReceipt() {
    const assets = [...this.assets].map(([model, asset]) => ({
      model,
      status: asset.status,
      error: asset.error,
      instances: asset.placements.length,
      visible: asset.visible,
      primitives: asset.batches.length,
    }));
    return {
      id: "compact-pond-v1",
      destroyed: this.destroyed,
      ready:
        !this.destroyed &&
        assets.every((a) => a.status === "loaded" && a.visible === a.instances),
      instances: this.placements.length,
      visible: assets.reduce((sum, a) => sum + a.visible, 0),
      assets,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const asset of this.assets.values()) {
      for (const batch of asset.batches) {
        batch.mesh.removeFromParent();
        batch.mesh.dispose(); // Instance GPU resources only. Borrowed maps/materials/geometry survive.
      }
      asset.batches.length = 0;
      asset.visible = 0;
    }
    this.group.removeFromParent();
  }
}
