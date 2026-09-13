import type { World } from "../../core/World";
import type THREE from "../../extras/three/three";
import { DataManager } from "../../data/DataManager";
import { System } from "../shared/infrastructure/System";
import { CompactRockOutcropVisuals } from "../shared/world/CompactRockOutcropVisuals";
import {
  COMPACT_LANDSCAPE_ROCKS_SYSTEM,
  CompactLandscapeRocksSystem,
} from "../shared/world/CompactLandscapeRocksSystem";

export const COMPACT_LANDSCAPE_ROCKS_VISUAL_SYSTEM =
  "compact-landscape-rocks-visuals";
export class CompactLandscapeRocksVisualsSystem extends System {
  private generation = 0;
  private visual: CompactRockOutcropVisuals | null = null;
  override getDependencies() {
    return { required: [COMPACT_LANDSCAPE_ROCKS_SYSTEM], optional: [] };
  }
  override async start() {
    if (this.started) return;
    const generation = ++this.generation;
    const record = this.world
      .getSystem<CompactLandscapeRocksSystem>(COMPACT_LANDSCAPE_ROCKS_SYSTEM)
      ?.getRocks();
    if (!record) {
      this.started = true;
      return;
    }
    const visual = new CompactRockOutcropVisuals(record.placements);
    this.visual = visual;
    try {
      await visual.load(this.world);
      if (generation !== this.generation) {
        visual.dispose();
        return;
      }
      visual.group.name = "CompactLandscapeRocks";
      this.world.stage.scene.add(visual.group);
      this.started = true;
      const height = this.world.graphics?.renderer.domElement.height;
      if (height) this.prepareForRender(this.world.camera, height);
    } catch (error) {
      visual.dispose();
      if (this.visual === visual) this.visual = null;
      throw error;
    }
  }
  /** Select once for the actual main render camera, before shadow/render-list
   * construction. Update-phase cameras can be replaced by late-update or an
   * authored camera director; selecting there gives the wrong frame's LOD.
   */
  prepareForRender(camera: THREE.PerspectiveCamera, height: number) {
    if (!this.started || !this.visual) return;
    this.visual.update(camera, height);
  }
  getDiagnostics() {
    return this.visual?.getDiagnostics() ?? null;
  }
  override destroy() {
    ++this.generation;
    this.visual?.dispose();
    this.visual = null;
    super.destroy();
  }
}
export function registerCompactLandscapeRocksVisuals(world: World) {
  if (!DataManager.getWorldConfig()?.compactLandscapeRocks) return;
  if (!world.getSystem(COMPACT_LANDSCAPE_ROCKS_SYSTEM))
    world.register(COMPACT_LANDSCAPE_ROCKS_SYSTEM, CompactLandscapeRocksSystem);
  if (!world.getSystem(COMPACT_LANDSCAPE_ROCKS_VISUAL_SYSTEM))
    world.register(
      COMPACT_LANDSCAPE_ROCKS_VISUAL_SYSTEM,
      CompactLandscapeRocksVisualsSystem,
    );
}
