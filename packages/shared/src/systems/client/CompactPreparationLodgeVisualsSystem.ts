import {
  BuildingGenerator,
  createBuildingMaterial,
} from "@hyperforge/procgen/building";
import * as THREE from "../../extras/three/three";
import { attribute, positionLocal, select } from "three/tsl";
import type { Node } from "three/webgpu";
import type { World } from "../../core/World";
import { DataManager } from "../../data/DataManager";
import { Collider } from "../../nodes/Collider";
import { RigidBody } from "../../nodes/RigidBody";
import { System } from "../shared/infrastructure/System";
import type { OwnedCompactPreparationLodge } from "../shared/world/CompactPreparationLodge";
import { applySkyFog } from "../shared/world/FogConfig";
import { TownSystem } from "../shared/world/TownSystem";

export const COMPACT_LODGE_VISUAL_SYSTEM = "compact-preparation-lodge-visuals";

/** Private mesh/material lease. The authoritative layout remains TownSystem's. */
export function createCompactPreparationLodgeVisual(
  record: OwnedCompactPreparationLodge,
) {
  const generator = new BuildingGenerator();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  let root: THREE.Group | null = null;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root?.removeFromParent();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    // Its material is private, but primitive geometry templates are global.
    generator.dispose({ clearGeometryCache: false });
  };
  try {
    const result = generator.generate("bank", {
      seed: record.descriptor.layoutSeed,
      cachedLayout: record.layout,
      roofStyle: "gable",
      includeRoof: true,
      includeProps: false,
      generateLODs: false,
      useGreedyMeshing: true,
      // Scene PBR lighting is authoritative; do not bake a second lighting pass
      // into the vertex colors or multiply the material by those old colors.
      enableInteriorLighting: false,
    });
    if (!result || !(result.mesh instanceof THREE.Group))
      throw new Error(
        "Compact lodge generation did not return a building group",
      );
    root = result.mesh;
    const meshes: THREE.Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes.push(object);
      geometries.add(object.geometry);
    });
    const roles = new Set([
      "floors",
      "walls",
      "roof",
      "windowFrames",
      "doorFrames",
    ]);
    if (
      meshes.length !== roles.size ||
      meshes.some((mesh) => !roles.delete(mesh.name))
    ) {
      throw new Error(
        "Compact preparation lodge geometry roles changed; qualify a new recipe",
      );
    }
    const make = (config: Parameters<typeof createBuildingMaterial>[0]) => {
      const material = createBuildingMaterial({
        ...config,
        useVertexColors: false,
      });
      material.name = `compact-lodge-${config.type}`;
      applySkyFog(material);
      materials.add(material);
      return material;
    };
    const stone = make({
      type: "stone-ashlar",
      baseColor: "#aaa18d",
      secondaryColor: "#797e72",
      accentColor: "#66695d",
      scale: 1.4,
      roughness: 0.88,
      variation: 0.32,
    });
    const wood = make({
      type: "wood-plank",
      baseColor: "#756149",
      secondaryColor: "#514639",
      accentColor: "#433d33",
      scale: 0.75,
      roughness: 0.82,
      variation: 0.28,
    });
    const roof = make({
      type: "shingle",
      shingleFiltering: "footprint-v1",
      baseColor: "#686e6b",
      secondaryColor: "#485759",
      accentColor: "#333e3e",
      scale: 1.25,
      roughness: 0.8,
      variation: 0.3,
    });
    const walls = make({
      type: "plaster",
      baseColor: "#d4cbb5",
      secondaryColor: "#b8b49c",
      accentColor: "#aaa18d",
      scale: 1.2,
      roughness: 0.92,
      variation: 0.3,
    });
    const plasterColor = walls.colorNode as Node<"vec3">;
    // Gable trim already carries its material ID in uv2; no additional mesh,
    // texture, light or draw call is needed for wood trim / stone plinth.
    walls.colorNode = select(
      attribute("uv2", "vec2").x.greaterThan(0.95),
      wood.colorNode as Node<"vec3">,
      select(
        positionLocal.y.lessThan(0.61),
        stone.colorNode as Node<"vec3">,
        plasterColor,
      ),
    );
    const roleMaterials = {
      floors: stone,
      walls,
      roof,
      windowFrames: wood,
      doorFrames: wood,
    };
    let triangles = 0;
    let geometryBytes = 0;
    for (const mesh of meshes) {
      mesh.material = roleMaterials[mesh.name as keyof typeof roleMaterials];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(mesh.name === "floors" ? 2 : 1);
      mesh.userData.buildingId = record.buildingId;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      triangles +=
        (mesh.geometry.index?.count ??
          mesh.geometry.getAttribute("position").count) / 3;
      for (const attribute of Object.values(mesh.geometry.attributes)) {
        geometryBytes +=
          attribute instanceof THREE.InterleavedBufferAttribute
            ? attribute.data.array.byteLength
            : attribute.array.byteLength;
      }
      geometryBytes += mesh.geometry.index?.array.byteLength ?? 0;
    }
    root.name = record.buildingId;
    root.position.set(record.position.x, record.position.y, record.position.z);
    root.rotation.y = record.rotation;
    root.updateMatrixWorld(true);
    return {
      root,
      meshes: Object.freeze(meshes),
      triangles,
      geometryBytes,
      materialCount: materials.size,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** A single admitted building in interactive and broadcast worlds. No update loop. */
export class CompactPreparationLodgeVisualsSystem extends System {
  private visual: ReturnType<
    typeof createCompactPreparationLodgeVisual
  > | null = null;
  private body: RigidBody | null = null;
  private colliders: Collider[] = [];
  private indexedCollisionViews: THREE.BufferGeometry[] = [];
  private destroyed = false;

  override init(): Promise<void> {
    this.destroyed = false;
    return super.init({});
  }

  override getDependencies() {
    return { required: ["towns", "stage"], optional: ["physics"] };
  }

  override start(): void {
    if (
      this.destroyed ||
      this.visual ||
      !DataManager.getWorldConfig()?.compactPreparationLodge
    )
      return;
    const record = this.world
      .getSystem<TownSystem>("towns")
      ?.getCompactPreparationLodge();
    if (!record)
      throw new Error(
        "Compact lodge visual requires its authoritative collision owner",
      );
    const visual = createCompactPreparationLodgeVisual(record);
    try {
      if (this.world.physics) {
        // Actual triangle openings, not the generic closed perimeter boxes or
        // its synthetic flat roof. Broadcast worlds do not create PhysX nodes.
        this.body = new RigidBody({
          type: "static",
          tag: record.buildingId,
          position: [record.position.x, record.position.y, record.position.z],
        });
        this.body.rotation.y = record.rotation;
        for (const mesh of visual.meshes) {
          let collisionGeometry = mesh.geometry;
          if (!collisionGeometry.index) {
            // Frame meshes are triangle lists; PhysX cooking requires explicit
            // indices. Borrow their exact position data without rewriting the
            // rendered geometry or changing any vertex/triangle ordering.
            const position = mesh.geometry.getAttribute("position");
            collisionGeometry = new THREE.BufferGeometry();
            this.indexedCollisionViews.push(collisionGeometry);
            collisionGeometry.setAttribute("position", position);
            collisionGeometry.setIndex(
              Array.from({ length: position.count }, (_, i) => i),
            );
          }
          const collider = new Collider({
            type: "geometry",
            geometry: collisionGeometry,
            convex: false,
            layer: "environment",
            position: mesh.position.toArray(),
            quaternion: mesh.quaternion.toArray(),
            scale: mesh.scale.toArray(),
          });
          this.colliders.push(collider);
          this.body.add(collider);
        }
        this.body.activate(this.world);
        if (
          !this.body.actor ||
          !this.body.actorHandle ||
          this.colliders.some((collider) => !collider.shape || !collider.pmesh)
        ) {
          throw new Error(
            "Compact lodge static triangle collision failed to initialize",
          );
        }
      }
      this.world.stage.scene.add(visual.root);
      this.visual = visual;
      this.started = true;
    } catch (error) {
      try {
        this.releasePhysics();
      } finally {
        visual.dispose();
      }
      throw error;
    }
  }

  getDiagnostics() {
    return this.visual
      ? Object.freeze({
          buildingId: this.visual.root.name,
          meshes: this.visual.meshes.length,
          triangles: this.visual.triangles,
          geometryBytes: this.visual.geometryBytes,
          materials: this.visual.materialCount,
          physicsShapes: this.colliders.filter((collider) => collider.shape)
            .length,
          physicsActor: Boolean(this.body?.actor),
        })
      : null;
  }

  private releasePhysics() {
    try {
      this.body?.deactivate();
    } finally {
      this.body = null;
      this.colliders = [];
      for (const geometry of this.indexedCollisionViews) geometry.dispose();
      this.indexedCollisionViews = [];
    }
  }

  override destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.releasePhysics();
    } finally {
      this.visual?.dispose();
      this.visual = null;
      super.destroy();
    }
  }
}

/** Call after manifest admission in both viewport modes; never register POIs. */
export function registerCompactPreparationLodgeVisuals(world: World): void {
  if (!DataManager.getWorldConfig()?.compactPreparationLodge) return;
  if (!world.getSystem("towns")) world.register("towns", TownSystem);
  if (!world.getSystem(COMPACT_LODGE_VISUAL_SYSTEM))
    world.register(
      COMPACT_LODGE_VISUAL_SYSTEM,
      CompactPreparationLodgeVisualsSystem,
    );
}
