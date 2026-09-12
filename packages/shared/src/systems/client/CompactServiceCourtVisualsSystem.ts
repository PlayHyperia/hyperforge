import {
  createOpenWorkshop,
  createBuildingMaterial,
} from "@hyperforge/procgen/building";
import * as THREE from "../../extras/three/three";
import { attribute, bool } from "three/tsl";
import {
  CompactRoofCutaway,
  createCompactRoofFade,
} from "./CompactRoofCutaway";
import type { World } from "../../core/World";
import { DataManager } from "../../data/DataManager";
import { System } from "../shared/infrastructure/System";
import type { OwnedCompactServiceCourt } from "../shared/world/CompactServiceCourt";
import {
  COMPACT_SERVICE_COURT_SYSTEM,
  CompactServiceCourtSystem,
} from "../shared/world/CompactServiceCourtSystem";
import { applySkyFog } from "../shared/world/FogConfig";

export const COMPACT_SERVICE_COURT_VISUAL_SYSTEM =
  "compact-service-court-visuals";

/** Private render lease: no borrowed textures, no lights, no per-frame rebuild. */
export function createCompactServiceCourtVisual(
  record: OwnedCompactServiceCourt,
  mainCamera?: () => THREE.Camera,
) {
  const geometry = createOpenWorkshop(record.feet);
  const materials = new Set<THREE.Material>();
  const root = new THREE.Group();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    geometry.dispose();
    for (const material of materials) material.dispose();
  };
  try {
    const make = (config: Parameters<typeof createBuildingMaterial>[0]) => {
      const material = createBuildingMaterial({
        ...config,
        useVertexColors: false,
      });
      materials.add(material);
      material.name = `compact-smithy-${config.type}`;
      applySkyFog(material);
      return material;
    };
    const timber = make({
      type: "wood-plank",
      woodFiltering: "footprint-v1",
      baseColor: "#756149",
      secondaryColor: "#514639",
      accentColor: "#433d33",
      scale: 2,
      roughness: 0.82,
      variation: 0.28,
    });
    const roof = make({
      type: "shingle",
      shingleFiltering: "footprint-v1",
      baseColor: "#79776e",
      secondaryColor: "#5d625c",
      accentColor: "#333e3e",
      scale: 0.35,
      roughness: 0.94,
      variation: 0.3,
    });
    const stone = make({
      type: "stone-ashlar",
      baseColor: "#aaa18d",
      secondaryColor: "#797e72",
      accentColor: "#66695d",
      scale: 1.4,
      roughness: 0.88,
      variation: 0.32,
    });
    let triangles = 0,
      geometryBytes = 0;
    for (const [name, material] of [
      ["timber", timber],
      ["roof", roof],
      ["footings", stone],
    ] as const) {
      const mesh = new THREE.Mesh(geometry[name], material);
      mesh.name = `compact-smithy-${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(1);
      root.add(mesh);
      triangles +=
        (mesh.geometry.index?.count ??
          mesh.geometry.getAttribute("position").count) / 3;
      for (const attribute of Object.values(mesh.geometry.attributes))
        geometryBytes +=
          attribute instanceof THREE.InterleavedBufferAttribute
            ? attribute.data.array.byteLength
            : attribute.array.byteLength;
      geometryBytes += mesh.geometry.index?.array.byteLength ?? 0;
    }
    root.name = record.descriptor.layoutId;
    root.position.set(record.position.x, record.position.y, record.position.z);
    root.updateMatrixWorld(true);
    const roofMesh = root.children[1] as THREE.Mesh;
    const timberMesh = root.children[0] as THREE.Mesh;
    const cutaway = new CompactRoofCutaway(root, roofMesh, timberMesh);
    const { fade, visible } = createCompactRoofFade("compactSmithyRoofFade");
    roof.maskNode = visible;
    timber.maskNode = attribute("courtRoof", "float").lessThan(0.5).or(visible);
    // r186 explicitly selects this mask for shadow passes, independently of
    // maskNode. Never fade the shadow, collider, navigation or ground support.
    roof.maskShadowNode = bool(true);
    timber.maskShadowNode = bool(true);
    cutaway.installPointerFilter(roofMesh);
    cutaway.installPointerFilter(timberMesh);
    for (const mesh of [roofMesh, timberMesh])
      mesh.onBeforeRender = (renderer, _scene, camera) => {
        if (disposed || !mainCamera) return;
        // Three's mesh callback type names its older renderer, but this runtime
        // is WebGPU-only and uses the current shared Renderer.info.frame owner.
        const frame = (renderer as unknown as { info: { frame: number } }).info
          .frame;
        fade.value = cutaway.valueForPass(
          camera,
          mainCamera(),
          frame,
          performance.now(),
        );
      };
    return {
      root,
      triangles,
      geometryBytes,
      materialCount: materials.size,
      cutaway,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export class CompactServiceCourtVisualsSystem extends System {
  private visual: ReturnType<typeof createCompactServiceCourtVisual> | null =
    null;
  override getDependencies() {
    return { required: [COMPACT_SERVICE_COURT_SYSTEM, "stage"] };
  }
  override start(): void {
    if (
      !this.initialized ||
      this.visual ||
      !DataManager.getWorldConfig()?.compactServiceCourt
    )
      return;
    const record = this.world
      .getSystem<CompactServiceCourtSystem>(COMPACT_SERVICE_COURT_SYSTEM)
      ?.getCourt();
    if (!record)
      throw new Error("Compact smithy requires its admitted collision owner");
    this.visual = createCompactServiceCourtVisual(
      record,
      () => this.world.camera,
    );
    this.world.stage.scene.add(this.visual.root);
    this.started = true;
  }
  getDiagnostics() {
    return this.visual
      ? Object.freeze({
          layoutId: this.visual.root.name,
          meshes: this.visual.root.children.length,
          triangles: this.visual.triangles,
          geometryBytes: this.visual.geometryBytes,
          materials: this.visual.materialCount,
          cutaway: {
            value: this.visual.cutaway.value,
            desired: this.visual.cutaway.desired,
            decisions: this.visual.cutaway.decisionCount,
          },
        })
      : null;
  }
  override destroy(): void {
    this.visual?.dispose();
    this.visual = null;
    super.destroy();
  }
}

export function registerCompactServiceCourtVisuals(world: World): void {
  if (!DataManager.getWorldConfig()?.compactServiceCourt) return;
  if (!world.getSystem(COMPACT_SERVICE_COURT_SYSTEM))
    world.register(COMPACT_SERVICE_COURT_SYSTEM, CompactServiceCourtSystem);
  if (!world.getSystem(COMPACT_SERVICE_COURT_VISUAL_SYSTEM))
    world.register(
      COMPACT_SERVICE_COURT_VISUAL_SYSTEM,
      CompactServiceCourtVisualsSystem,
    );
}
