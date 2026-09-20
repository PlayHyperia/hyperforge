import {
  createOpenWorkshop,
  createBuildingMaterial,
  HAVEN_ARCHITECTURAL_ROOF_CONFIG,
  createHavenLocalMetricUV,
} from "@hyperforge/procgen/building";
import * as THREE from "../../extras/three/three";
import { attribute, bool, positionLocal, normalGeometry } from "three/tsl";
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
  const bank = record.descriptor.recipeId === "open-timber-bank-haven-v1";
  const haven =
    bank || record.descriptor.recipeId === "open-timber-smithy-haven-v3";
  const prefix = bank ? "compact-bank" : "compact-smithy";
  const geometry = createOpenWorkshop(record.feet, {
    ...(bank ? ({ recipe: "bank-pavilion-v1" } as const) : {}),
    architecturalFinish: haven ? "haven-v1" : undefined,
  });
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
        architecturalFinish: haven ? "haven-v1" : undefined,
        useVertexColors: false,
      });
      materials.add(material);
      material.name = `${prefix}-${config.type}`;
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
      ...(haven ? HAVEN_ARCHITECTURAL_ROOF_CONFIG : {}),
    });
    const stone = make({
      type: "stone-ashlar",
      baseColor: "#aaa18d",
      secondaryColor: "#797e72",
      accentColor: "#66695d",
      scale: haven ? 0.75 : 1.4,
      ...(haven
        ? { patternUV: createHavenLocalMetricUV(positionLocal, normalGeometry) }
        : {}),
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
      mesh.name = `${prefix}-${name}`;
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
    const cutaway = new CompactRoofCutaway(
      root,
      roofMesh,
      timberMesh,
      bank ? "bank" : "court",
    );
    const { fade, visible } = createCompactRoofFade(
      bank ? "compactBankRoofFade" : "compactSmithyRoofFade",
    );
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
  private visuals: ReturnType<typeof createCompactServiceCourtVisual>[] = [];
  override getDependencies() {
    return { required: [COMPACT_SERVICE_COURT_SYSTEM, "stage"] };
  }
  override start(): void {
    if (!this.initialized || this.started) return;
    const config = DataManager.getWorldConfig();
    const descriptors = [
      config?.compactServiceCourt,
      config?.compactBankPavilion,
    ].filter((descriptor) => descriptor !== undefined);
    if (!descriptors.length) return;
    const records = this.world
      .getSystem<CompactServiceCourtSystem>(COMPACT_SERVICE_COURT_SYSTEM)
      ?.getCourts();
    if (
      !records ||
      records.length !== descriptors.length ||
      descriptors.some(
        (descriptor) =>
          records.filter(
            (record) => record.descriptor.layoutId === descriptor.layoutId,
          ).length !== 1,
      )
    )
      throw new Error(
        "Compact service visuals require every admitted collision owner",
      );
    const pending: ReturnType<typeof createCompactServiceCourtVisual>[] = [];
    try {
      for (const record of records)
        pending.push(
          createCompactServiceCourtVisual(record, () => this.world.camera),
        );
      for (const visual of pending) this.world.stage.scene.add(visual.root);
      this.visuals = pending;
      this.started = true;
    } catch (error) {
      for (const visual of pending) visual.dispose();
      throw error;
    }
  }
  getDiagnostics() {
    return (
      this.getAllDiagnostics().find(
        (record) => record.layoutId === "compact-service-court-v1",
      ) ?? null
    );
  }
  getAllDiagnostics() {
    return Object.freeze(
      this.visuals.map((visual) =>
        Object.freeze({
          layoutId: visual.root.name,
          meshes: visual.root.children.length,
          triangles: visual.triangles,
          geometryBytes: visual.geometryBytes,
          materials: visual.materialCount,
          cutaway: {
            value: visual.cutaway.value,
            desired: visual.cutaway.desired,
            decisions: visual.cutaway.decisionCount,
          },
        }),
      ),
    );
  }
  override destroy(): void {
    for (const visual of this.visuals) visual.dispose();
    this.visuals = [];
    super.destroy();
  }
}

export function registerCompactServiceCourtVisuals(world: World): void {
  const config = DataManager.getWorldConfig();
  if (!config?.compactServiceCourt && !config?.compactBankPavilion) return;
  if (!world.getSystem(COMPACT_SERVICE_COURT_SYSTEM))
    world.register(COMPACT_SERVICE_COURT_SYSTEM, CompactServiceCourtSystem);
  if (!world.getSystem(COMPACT_SERVICE_COURT_VISUAL_SYSTEM))
    world.register(
      COMPACT_SERVICE_COURT_VISUAL_SYSTEM,
      CompactServiceCourtVisualsSystem,
    );
}
