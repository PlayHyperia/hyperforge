import type { OpenWorkshopGeometry } from "@hyperforge/procgen/building";
import * as THREE from "../../../extras/three/three";
import { DataManager } from "../../../data/DataManager";
import { Collider } from "../../../nodes/Collider";
import { RigidBody } from "../../../nodes/RigidBody";
import { System } from "../infrastructure/System";
import type { StaticCollisionLease } from "../movement/CollisionMatrix";
import {
  groundCompactServiceCourt,
  type OwnedCompactServiceCourt,
} from "./CompactServiceCourt";
import type { TerrainSystem } from "./TerrainSystem";

export const COMPACT_SERVICE_COURT_SYSTEM = "compact-service-court";

/** Shared authoritative post navigation and exact static triangle collision.
 * Does not register floors, interiors, services, resources, terrain edits or updates.
 */
export class CompactServiceCourtSystem extends System {
  private generation = 0;
  private record: OwnedCompactServiceCourt | null = null;
  private lease: StaticCollisionLease | null = null;
  private geometry: OpenWorkshopGeometry | null = null;
  private body: RigidBody | null = null;
  private colliders: Collider[] = [];
  private indexedViews: THREE.BufferGeometry[] = [];

  override getDependencies() {
    return { required: ["terrain"], optional: ["physics"] };
  }

  override async init(): Promise<void> {
    if (this.initialized) return;
    const generation = ++this.generation;
    await DataManager.getInstance().initialize();
    if (generation !== this.generation) return;
    this.initialized = true;
  }

  override async start(): Promise<void> {
    if (!this.initialized || this.started) return;
    const generation = ++this.generation;
    const descriptor = DataManager.getWorldConfig()?.compactServiceCourt;
    if (!descriptor) {
      this.started = true;
      return;
    }
    const { OPEN_WORKSHOP_POSTS, createOpenWorkshop } =
      await import("@hyperforge/procgen/building");
    if (generation !== this.generation) return;
    const terrain = this.world.getSystem<TerrainSystem>("terrain");
    if (!terrain)
      throw new Error("Compact service court requires authoritative terrain");
    const record = groundCompactServiceCourt(
      descriptor,
      OPEN_WORKSHOP_POSTS,
      (x, z) => terrain.getHeightAt(x, z),
    );
    try {
      if (this.world.physics) {
        this.geometry = createOpenWorkshop(record.feet);
        this.body = new RigidBody({
          type: "static",
          tag: descriptor.layoutId,
          position: [record.position.x, record.position.y, record.position.z],
        });
        for (const geometry of [
          this.geometry.timber,
          this.geometry.roof,
          this.geometry.footings,
        ]) {
          const indexed = new THREE.BufferGeometry();
          this.indexedViews.push(indexed);
          const position = geometry.getAttribute("position");
          indexed.setAttribute("position", position);
          indexed.setIndex(
            geometry.index ??
              Array.from({ length: position.count }, (_, i) => i),
          );
          const collider = new Collider({
            type: "geometry",
            geometry: indexed,
            convex: false,
            layer: "environment",
          });
          this.colliders.push(collider);
          this.body.add(collider);
        }
        this.body.activate(this.world);
        if (
          !this.body.actor ||
          !this.body.actorHandle ||
          this.colliders.some((c) => !c.shape || !c.pmesh)
        )
          throw new Error(
            "Compact service court native triangle collision failed",
          );
      }
      this.lease = this.world.collision.acquireStaticFootprint(
        record.blockingTiles,
      );
      this.record = record;
      this.started = true;
    } catch (error) {
      this.release();
      throw error;
    }
  }

  getCourt(): OwnedCompactServiceCourt | null {
    return this.record;
  }

  getDiagnostics() {
    return this.record
      ? Object.freeze({
          layoutId: this.record.descriptor.layoutId,
          blockingTiles: this.record.blockingTiles,
          feet: this.record.feet,
          position: this.record.position,
          physicsActor: Boolean(this.body?.actor),
          physicsShapes: this.colliders.filter((c) => c.shape).length,
        })
      : null;
  }

  private release(): void {
    try {
      this.body?.deactivate();
    } finally {
      this.body = null;
      this.colliders = [];
      for (const geometry of this.indexedViews) geometry.dispose();
      this.indexedViews = [];
      this.geometry?.dispose();
      this.geometry = null;
      this.lease?.release();
      this.lease = null;
      this.record = null;
    }
  }

  override destroy(): void {
    ++this.generation;
    this.release();
    super.destroy();
  }
}
