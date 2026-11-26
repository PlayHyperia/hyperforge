import THREE from "../../../extras/three/three";
import type { World } from "../../../core/World";
import { modelCache } from "../../../utils/rendering/ModelCache";

export const COMPACT_ROCK_LIBRARY =
  "asset://rocks/compact-outcrops-v1/rock-moss-set.glb";
export const COMPACT_ROCK_VARIANTS = ["rock10", "rock11", "rock13"] as const;
export type CompactRockVariant = (typeof COMPACT_ROCK_VARIANTS)[number];
export type CompactRockPlacement = Readonly<{
  id: string;
  variant: CompactRockVariant;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}>;
type Level = 0 | 1 | 2;
type Batch = { mesh: THREE.InstancedMesh; transform: THREE.Matrix4 };

/** Explicit consumer for a nine-mesh geometry library. Never adds the library
 * itself to the world. Terrain/collision owners must supply admitted placements;
 * this render owner does not grant walkability or silently solve ground contact.
 */
export class CompactRockOutcropVisuals {
  readonly group = new THREE.Group();
  private readonly batches = new Map<CompactRockVariant, Batch[]>();
  private readonly levels: Level[];
  private readonly matrices: THREE.Matrix4[];
  private readonly cameraPosition = new THREE.Vector3();
  private disposed = false;
  private installed = false;
  private signature = "";
  private uploads = 0;

  constructor(readonly placements: readonly CompactRockPlacement[]) {
    if (
      placements.length === 0 ||
      placements.length > 48 ||
      new Set(placements.map((p) => p.id)).size !== placements.length ||
      placements.some(
        (p) =>
          !p.id ||
          !COMPACT_ROCK_VARIANTS.includes(p.variant) ||
          ![p.x, p.y, p.z, p.yaw, p.scale].every(Number.isFinite) ||
          p.scale < 0.5 ||
          p.scale > 1.5,
      )
    )
      throw new Error("Invalid compact rock placement or instance budget");
    this.placements = Object.freeze(
      placements.map((p) => Object.freeze({ ...p })),
    );
    this.group.name = "CompactRockOutcrops";
    this.levels = placements.map(() => 0);
    const axis = new THREE.Vector3(0, 1, 0);
    this.matrices = placements.map((p) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(p.x, p.y, p.z),
        new THREE.Quaternion().setFromAxisAngle(axis, p.yaw),
        new THREE.Vector3(p.scale, p.scale, p.scale),
      ),
    );
  }

  async load(world: World): Promise<void> {
    const loaded = await modelCache.loadModel(COMPACT_ROCK_LIBRARY, world, {
      shareMaterials: true,
      generateLODs: false,
    });
    if (!this.disposed) this.install(loaded.scene);
  }

  install(library: THREE.Object3D): void {
    if (this.disposed) return;
    if (this.installed)
      throw new Error("Compact rock library already installed");
    library.updateMatrixWorld(true);
    const sources = new Map<string, THREE.Mesh>();
    library.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (node instanceof THREE.SkinnedMesh || sources.has(node.name))
        throw new Error(
          "Compact rock library must contain unique static meshes",
        );
      sources.set(node.name, node);
    });
    if (sources.size !== 9)
      throw new Error("Compact rock library requires exactly nine LOD meshes");
    const materials = new Set<THREE.Material>();
    // Validate the complete library before allocating any draw instances.
    for (const variant of COMPACT_ROCK_VARIANTS) {
      for (const level of [0, 1, 2] as const) {
        const mesh = sources.get(`compact-outcrop-${variant}-lod${level}`);
        if (!mesh || !(mesh.material instanceof THREE.MeshStandardNodeMaterial))
          throw new Error(
            "Compact rock library requires converted PBR materials",
          );
        const geometry = mesh.geometry;
        const position = geometry.getAttribute("position");
        const normal = geometry.getAttribute("normal");
        const uv = geometry.getAttribute("uv");
        const triangles = geometry.index ? geometry.index.count / 3 : 0;
        const expected =
          level === 0
            ? variant === "rock13"
              ? 7928
              : 8000
            : level === 1
              ? 2000
              : 500;
        if (
          !position ||
          !normal ||
          !uv ||
          normal.count !== position.count ||
          uv.count !== position.count ||
          triangles !== expected ||
          Object.keys(geometry.morphAttributes).length
        )
          throw new Error(
            "Compact rock geometry differs from the admitted LOD kit",
          );
        geometry.computeBoundingBox();
        const box = geometry
          .boundingBox!.clone()
          .applyMatrix4(mesh.matrixWorld);
        if (
          ![...box.min.toArray(), ...box.max.toArray()].every(
            Number.isFinite,
          ) ||
          box.min.x < -1.2 ||
          box.max.x > 1.2 ||
          box.min.z < -1.2 ||
          box.max.z > 1 ||
          box.min.y < -0.35 ||
          box.max.y > 1.1
        )
          throw new Error(
            "Compact rock library lost its centered meter-scale pivots",
          );
        const material = mesh.material;
        if (
          !material.map ||
          !material.normalMap ||
          !material.roughnessMap ||
          material.transparent ||
          material.metalness !== 0
        )
          throw new Error(
            "Compact rock library lost its opaque scanned material",
          );
        materials.add(material);
      }
    }
    if (materials.size !== 1)
      throw new Error(
        "Compact rock library requires one shared converted material",
      );
    try {
      for (const variant of COMPACT_ROCK_VARIANTS) {
        const count = this.placements.filter(
          (p) => p.variant === variant,
        ).length;
        if (!count) continue;
        const batches: Batch[] = [];
        this.batches.set(variant, batches);
        for (const level of [0, 1, 2] as const) {
          const source = sources.get(`compact-outcrop-${variant}-lod${level}`)!;
          const mesh = new THREE.InstancedMesh(
            source.geometry,
            source.material,
            count,
          );
          mesh.name = `compact-outcrop-${variant}-lod${level}`;
          mesh.count = 0;
          mesh.visible = false;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.layers.set(1);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          batches.push({ mesh, transform: source.matrixWorld.clone() });
          this.group.add(mesh);
        }
      }
      this.installed = true;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Projected-error target with 20% hysteresis. The measured errors are sampled
   * surface deviations, not exhaustive bounds; distances require motion review.
   * No per-frame geometry rebuilding, material cloning, or image work.
   */
  update(camera: THREE.PerspectiveCamera, drawingBufferHeight: number): void {
    if (this.disposed || !this.installed) return;
    if (
      !Number.isFinite(drawingBufferHeight) ||
      drawingBufferHeight <= 0 ||
      drawingBufferHeight > 16384 ||
      !Number.isFinite(camera.fov) ||
      camera.fov <= 0 ||
      camera.fov >= 180 ||
      !Number.isFinite(camera.zoom) ||
      camera.zoom <= 0
    )
      throw new Error(
        "Compact rock LOD needs a valid native render projection",
      );
    camera.getWorldPosition(this.cameraPosition);
    const focal =
      (drawingBufferHeight * camera.zoom) /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    for (let i = 0; i < this.placements.length; i++) {
      const p = this.placements[i];
      // Subtract the full scaled bounding sphere radius for near-surface error.
      const distance = Math.max(
        0.01,
        Math.hypot(
          p.x - this.cameraPosition.x,
          p.y - this.cameraPosition.y,
          p.z - this.cameraPosition.z,
        ) -
          p.scale * 1.8,
      );
      const error = (level: Level) =>
        ([0, 0.014, 0.034][level] * p.scale * focal) / distance;
      let level = this.levels[i];
      while (level > 0 && error(level) > 0.78) level = (level - 1) as Level;
      while (level < 2 && error((level + 1) as Level) < 0.52)
        level = (level + 1) as Level;
      this.levels[i] = level;
    }
    const signature = this.levels.join("");
    if (signature === this.signature) return;
    this.signature = signature;
    for (const batches of this.batches.values())
      for (const { mesh } of batches) mesh.count = 0;
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < this.placements.length; i++) {
      const batch = this.batches.get(this.placements[i].variant)![
        this.levels[i]
      ];
      matrix.multiplyMatrices(this.matrices[i], batch.transform);
      batch.mesh.setMatrixAt(batch.mesh.count++, matrix);
    }
    for (const batches of this.batches.values())
      for (const { mesh } of batches) {
        mesh.visible = mesh.count > 0;
        if (mesh.count) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingBox();
          mesh.computeBoundingSphere();
        }
      }
    this.uploads++;
  }

  getDiagnostics() {
    return {
      installed: this.installed,
      disposed: this.disposed,
      placements: this.placements.length,
      levels: [...this.levels],
      uploads: this.uploads,
      batches: [...this.batches.values()].flat().map(({ mesh }) => ({
        name: mesh.name,
        count: mesh.count,
        visible: mesh.visible,
        triangles: (mesh.count * mesh.geometry.index!.count) / 3,
        geometry: mesh.geometry.uuid,
        material: (mesh.material as THREE.Material).uuid,
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const batches of this.batches.values())
      for (const { mesh } of batches) mesh.dispose();
    this.group.clear();
    this.batches.clear();
    // The model cache owns geometry, materials and all textures.
  }
}
