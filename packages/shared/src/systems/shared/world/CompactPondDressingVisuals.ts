import THREE from "../../../extras/three/three";
import { materialColor, vec3, vec4, mix, dot } from "three/tsl";
import type { Node } from "three/webgpu";
import type { World } from "../../../types";
import { modelCache } from "../../../utils/rendering/ModelCache";
import {
  COMPACT_POND_MODELS,
  COMPACT_POND_ROOT_SUPPORT,
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
  bounds: THREE.Box3;
  supportBounds: THREE.Box3;
  supportMode: "full-footprint" | "root-slice";
  supportVertexCount: number;
  materials: THREE.MeshStandardNodeMaterial[];
  sampleQueries: number;
  maxSampleQueries: number;
};

const PALETTE = Object.freeze({
  boulder: { tint: [1.04, 1.02, 0.93], blend: 0.3, gain: 1.05 },
  stone: { tint: [1.04, 1.0, 0.9], blend: 0.75, gain: 0.53 },
  // The CC0 scanned fern already has the intended natural leaf palette.
  fern: { tint: [1.0, 1.0, 1.0], blend: 0.0, gain: 1.0 },
  bush: { tint: [0.94, 1.1, 0.63], blend: 0.8, gain: 0.85 },
  reed: { tint: [1.0, 1.0, 1.0], blend: 0.0, gain: 1.0 },
});

type Point = { x: number; z: number };
type Footprint = { minX: number; maxX: number; minZ: number; maxZ: number };

function clip(
  polygon: Point[],
  axis: "x" | "z",
  limit: number,
  sign: number,
): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const da = (a[axis] - limit) * sign,
      db = (b[axis] - limit) * sign;
    if (da >= 0) result.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      result.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) });
    }
  }
  return result;
}

/** Cache owns geometry/maps; this owner owns instances and five palette clones. */
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
        bounds: new THREE.Box3(),
        supportBounds: new THREE.Box3(),
        supportMode:
          model === "boulder" || model === "stone"
            ? "full-footprint"
            : "root-slice",
        supportVertexCount: 0,
        materials: [],
        sampleQueries: 0,
        maxSampleQueries: 0,
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
    const bounds = new THREE.Box3();
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
        bounds.expandByPoint(vertex);
      }
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      if (
        materials.some(
          (material) => !(material instanceof THREE.MeshStandardNodeMaterial),
        )
      )
        throw new Error(
          "Pond model requires the actual cache WebGPU material conversion",
        );
      sources.push(object);
    });
    if (!sources.length || sources.length > 8)
      throw new Error("Invalid pond primitive budget");
    // A crown can overhang lower ground without moving its roots downhill.
    // Derive the actual lower central geometry once, preserving all source
    // hierarchy transforms. A missing stem footprint fails, never falls back
    // silently to a canopy box or a synthetic floating pivot.
    const supportBounds = new THREE.Box3();
    let supportVertexCount = 0;
    for (const source of sources) {
      const positions = source.geometry.getAttribute("position");
      for (let i = 0; i < positions.count; i++) {
        vertex
          .fromBufferAttribute(positions, i)
          .applyMatrix4(source.matrixWorld);
        if (
          asset.supportMode === "full-footprint" ||
          (vertex.y <= bounds.min.y + COMPACT_POND_ROOT_SUPPORT.sliceHeight &&
            Math.hypot(vertex.x, vertex.z) <=
              COMPACT_POND_ROOT_SUPPORT.centerRadius)
        ) {
          supportBounds.expandByPoint(vertex);
          supportVertexCount++;
        }
      }
    }
    if (
      !supportVertexCount ||
      supportBounds.max.x <= supportBounds.min.x ||
      supportBounds.max.z <= supportBounds.min.z
    )
      throw new Error(
        "Pond plant requires a finite nondegenerate root-slice footprint",
      );
    // Validate every primitive before allocating or attaching any instance.
    const privateMaterials = new Map<
      THREE.Material,
      THREE.MeshStandardNodeMaterial
    >();
    const adoptMaterial = (
      source: THREE.Material,
    ): THREE.MeshStandardNodeMaterial => {
      const existing = privateMaterials.get(source);
      if (existing) return existing;
      const material = (source as THREE.MeshStandardNodeMaterial).clone();
      // NodeMaterial.copy preserves the node graph, not its classic PBR maps.
      // Reuse the installed Three material copy path; texture references stay
      // borrowed while color/vector values become instance-private.
      THREE.MeshStandardMaterial.prototype.copy.call(
        material,
        source as THREE.MeshStandardNodeMaterial,
      );
      const original = vec4(
        ((source as THREE.MeshStandardNodeMaterial)
          .colorNode as Node<"vec4"> | null) ?? materialColor,
      );
      const palette = PALETTE[model];
      const luminance = dot(original.rgb, vec3(0.2126, 0.7152, 0.0722));
      material.colorNode = vec4(
        mix(
          original.rgb,
          vec3(...(palette.tint as [number, number, number])).mul(luminance),
          palette.blend,
        ).mul(palette.gain),
        original.a,
      );
      material.name = `CompactPond_${model}_Muted`;
      material.userData.compactPondPalette = {
        ...palette,
        tint: [...palette.tint],
      };
      privateMaterials.set(source, material);
      asset.materials.push(material);
      return material;
    };
    for (const source of sources) {
      const mesh = new THREE.InstancedMesh(
        source.geometry,
        Array.isArray(source.material)
          ? source.material.map(adoptMaterial)
          : adoptMaterial(source.material),
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
    asset.bounds.copy(bounds);
    asset.supportBounds.copy(supportBounds);
    asset.supportVertexCount = supportVertexCount;
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
      const footprints = asset.placements.map((p) =>
        this.getFootprint(asset.supportBounds, p),
      );
      // Nine ownership lookups per placement at 4 Hz; no height samples or
      // matrix uploads until a touched retained geometry revision changes.
      const surfaces = footprints.map((box) => {
        const unique = new Set<RetainedTerrainSurface>();
        for (const x of [box.minX, (box.minX + box.maxX) / 2, box.maxX])
          for (const z of [box.minZ, (box.minZ + box.maxZ) / 2, box.maxZ]) {
            const surface = surfaceAt(x, z);
            if (!surface) return null;
            unique.add(surface);
          }
        return [...unique];
      });
      const signature = surfaces
        .map((list) => list?.map((s) => s.revision).join(",") ?? "missing")
        .join("|");
      if (signature === asset.signature) continue;
      asset.signature = signature;
      asset.sampleQueries = 0;
      let count = 0;
      for (let i = 0; i < asset.placements.length; i++) {
        const p = asset.placements[i],
          ownedSurfaces = surfaces[i];
        if (!ownedSurfaces) continue;
        const support = this.getSupportHeight(
          footprints[i],
          ownedSurfaces,
          asset,
        );
        if (support === null) continue;
        const rootOffset =
          asset.supportMode === "root-slice"
            ? asset.supportBounds.min.y * p.scale
            : 0;
        this.position.set(p.x, support - p.burial - rootOffset, p.z);
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
      asset.maxSampleQueries = Math.max(
        asset.maxSampleQueries,
        asset.sampleQueries,
      );
      for (const batch of asset.batches) {
        batch.mesh.count = count;
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.mesh.computeBoundingBox();
        batch.mesh.computeBoundingSphere();
      }
      asset.visible = count;
    }
  }

  private getFootprint(bounds: THREE.Box3, p: CompactPondPlacement): Footprint {
    const box = {
      minX: Infinity,
      maxX: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };
    const c = Math.cos(p.yaw) * p.scale,
      s = Math.sin(p.yaw) * p.scale;
    for (const x of [bounds.min.x, bounds.max.x])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const wx = p.x + c * x + s * z,
          wz = p.z - s * x + c * z;
        box.minX = Math.min(box.minX, wx);
        box.maxX = Math.max(box.maxX, wx);
        box.minZ = Math.min(box.minZ, wz);
        box.maxZ = Math.max(box.maxZ, wz);
      }
    return box;
  }

  /** Exact affine minimum over the conservative rotated support footprint.
   * This buries the support plane on slopes, without claiming every irregular
   * model vertex touches ground. No raycasts, new mesh or texture allocation.
   */
  private getSupportHeight(
    box: Footprint,
    surfaces: readonly RetainedTerrainSurface[],
    asset: Asset,
  ): number | null {
    let minimum = Infinity,
      coveredArea = 0,
      queries = 0;
    const rectangles: Footprint[] = [];
    for (const surface of surfaces) {
      const half = surface.size / 2;
      const region = {
        minX: Math.max(box.minX, surface.centerX - half),
        maxX: Math.min(box.maxX, surface.centerX + half),
        minZ: Math.max(box.minZ, surface.centerZ - half),
        maxZ: Math.min(box.maxZ, surface.centerZ + half),
      };
      if (region.maxX <= region.minX || region.maxZ <= region.minZ) continue;
      if (
        rectangles.some(
          (r) =>
            Math.min(r.maxX, region.maxX) - Math.max(r.minX, region.minX) >
              1e-8 &&
            Math.min(r.maxZ, region.maxZ) - Math.max(r.minZ, region.minZ) >
              1e-8,
        )
      )
        return null;
      rectangles.push(region);
      coveredArea += (region.maxX - region.minX) * (region.maxZ - region.minZ);
      const step = surface.size / (surface.resolution - 1);
      const minCellX = Math.max(
        0,
        Math.floor((region.minX - surface.centerX + half) / step) - 1,
      );
      const minCellZ = Math.max(
        0,
        Math.floor((region.minZ - surface.centerZ + half) / step) - 1,
      );
      const maxCellX = Math.min(
        surface.resolution - 2,
        Math.ceil((region.maxX - surface.centerX + half) / step),
      );
      const maxCellZ = Math.min(
        surface.resolution - 2,
        Math.ceil((region.maxZ - surface.centerZ + half) / step),
      );
      // Current <=3.2 m conservative boxes on >=100 m leaves need less than this
      // fixed ceiling, including the maximum 256-point terrain grid.
      if ((maxCellX - minCellX + 1) * (maxCellZ - minCellZ + 1) > 256)
        return null;
      for (let iz = minCellZ; iz <= maxCellZ; iz++)
        for (let ix = minCellX; ix <= maxCellX; ix++) {
          const x0 = surface.centerX + Math.fround(-half + ix * step),
            x1 = surface.centerX + Math.fround(-half + (ix + 1) * step);
          const z0 = surface.centerZ + Math.fround(-half + iz * step),
            z1 = surface.centerZ + Math.fround(-half + (iz + 1) * step);
          for (let polygon of [
            [
              { x: x0, z: z0 },
              { x: x0, z: z1 },
              { x: x1, z: z0 },
            ],
            [
              { x: x1, z: z0 },
              { x: x0, z: z1 },
              { x: x1, z: z1 },
            ],
          ]) {
            polygon = clip(
              clip(
                clip(clip(polygon, "x", region.minX, 1), "x", region.maxX, -1),
                "z",
                region.minZ,
                1,
              ),
              "z",
              region.maxZ,
              -1,
            );
            for (const point of polygon) {
              if (++queries > 4096) return null;
              asset.sampleQueries++;
              if (
                !surface.sample(
                  point.x - surface.centerX,
                  point.z - surface.centerZ,
                  this.sample,
                )
              )
                return null;
              minimum = Math.min(minimum, this.sample.height);
            }
          }
        }
    }
    const area = (box.maxX - box.minX) * (box.maxZ - box.minZ);
    return Number.isFinite(minimum) &&
      Math.abs(coveredArea - area) <= Math.max(1e-8, area * 1e-8)
      ? minimum
      : null;
  }

  getReceipt() {
    const assets = [...this.assets].map(([model, asset]) => ({
      model,
      status: asset.status,
      error: asset.error,
      instances: asset.placements.length,
      visible: asset.visible,
      primitives: asset.batches.length,
      support: {
        mode: asset.supportMode,
        selectedVertices: asset.supportVertexCount,
        bounds:
          asset.status === "loaded"
            ? {
                min: asset.supportBounds.min.toArray(),
                max: asset.supportBounds.max.toArray(),
              }
            : null,
        fullGeometryBounds:
          asset.status === "loaded"
            ? {
                min: asset.bounds.min.toArray(),
                max: asset.bounds.max.toArray(),
              }
            : null,
        rootSlice:
          asset.supportMode === "root-slice" ? COMPACT_POND_ROOT_SUPPORT : null,
        scope:
          asset.supportMode === "root-slice"
            ? "Lower central geometry support only; overhanging crown is not a root contact surface. Complete source geometry remains in culling bounds."
            : "Conservative complete geometry XZ footprint; unchanged rock support policy.",
      },
      paletteMaterials: asset.materials.length,
      sampleQueries: asset.sampleQueries,
      maxSampleQueries: asset.maxSampleQueries,
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
        batch.mesh.dispose(); // Instance GPU resources only.
      }
      for (const material of asset.materials) material.dispose(); // Borrowed maps/geometry survive.
      asset.materials.length = 0;
      asset.batches.length = 0;
      asset.visible = 0;
    }
    this.group.removeFromParent();
  }
}
