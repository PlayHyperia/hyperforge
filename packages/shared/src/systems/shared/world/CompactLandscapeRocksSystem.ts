import THREE from "../../../extras/three/three";
import { DataManager } from "../../../data/DataManager";
import { System } from "../infrastructure/System";
import { Collider } from "../../../nodes/Collider";
import { RigidBody } from "../../../nodes/RigidBody";
import type { StaticCollisionLease } from "../movement/CollisionMatrix";
import type { TerrainSystem } from "./TerrainSystem";
import type { CompactRockVariant } from "./CompactRockOutcropVisuals";
import { createCompactRockCollisionGeometry } from "./CompactRockGeometry";
import {
  groundCompactLandscapeRocks,
  type GroundedLandscapeRocks,
} from "./CompactLandscapeRocks";

export const COMPACT_LANDSCAPE_ROCKS_SYSTEM = "compact-landscape-rocks";

/** One authoritative static owner; no terrain edits, NPC/resource spawns or
 * per-tick collision rebuilding. Mesh cooking is shared by three geometries.
 */
export class CompactLandscapeRocksSystem extends System {
  private generation = 0;
  private record: GroundedLandscapeRocks | null = null;
  private lease: StaticCollisionLease | null = null;
  private geometry: ReadonlyMap<
    CompactRockVariant,
    THREE.BufferGeometry
  > | null = null;
  private bodies: RigidBody[] = [];
  private colliders: Collider[] = [];
  override getDependencies() {
    return { required: ["terrain"], optional: ["physics"] };
  }
  override async init() {
    if (this.initialized) return;
    const generation = ++this.generation;
    await DataManager.getInstance().initialize();
    if (generation === this.generation) this.initialized = true;
  }
  override async start() {
    if (!this.initialized || this.started) return;
    const generation = ++this.generation,
      descriptor = DataManager.getWorldConfig()?.compactLandscapeRocks;
    if (!descriptor) {
      this.started = true;
      return;
    }
    const geometry = await createCompactRockCollisionGeometry();
    if (generation !== this.generation) {
      for (const g of geometry.values()) g.dispose();
      return;
    }
    this.geometry = geometry;
    try {
      const terrain = this.world.getSystem<TerrainSystem>("terrain");
      if (!terrain)
        throw new Error("Landscape rocks require authoritative terrain");
      const record = groundCompactLandscapeRocks(descriptor, geometry, (x, z) =>
        terrain.getHeightAt(x, z),
      );
      if (this.world.physics)
        for (const p of record.placements) {
          const q = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            p.yaw,
          );
          const body = new RigidBody({
            type: "static",
            tag: p.id,
            position: [p.x, p.y, p.z],
            quaternion: q.toArray(),
            scale: [p.scale, p.scale, p.scale],
          });
          this.bodies.push(body);
          const collider = new Collider({
            type: "geometry",
            geometry: geometry.get(p.variant)!,
            convex: false,
            layer: "environment",
          });
          this.colliders.push(collider);
          body.add(collider);
          body.activate(this.world);
          if (
            !body.actor ||
            !body.actorHandle ||
            !collider.shape ||
            !collider.pmesh
          )
            throw new Error("Landscape rock native triangle collision failed");
        }
      this.lease = this.world.collision.acquireStaticFootprint(
        record.blockingTiles,
      );
      this.record = record;
      this.started = true;
    } catch (error) {
      try {
        this.release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Landscape rock startup and retirement failed",
        );
      }
      throw error;
    }
  }
  getRocks() {
    return this.record;
  }
  getDiagnostics() {
    return this.record
      ? {
          layoutId: this.record.descriptor.layoutId,
          placements: this.record.placements,
          support: this.record.support,
          blockingTiles: this.record.blockingTiles,
          physicsActors: this.bodies.filter((b) => b.actor).length,
          physicsShapes: this.colliders.filter((c) => c.shape).length,
          collisionGeometries: this.geometry?.size ?? 0,
          collisionTriangles: [...(this.geometry?.values() ?? [])].reduce(
            (n, g) => n + g.index!.count / 3,
            0,
          ),
        }
      : null;
  }
  private release() {
    const errors: unknown[] = [];
    const release = (action: () => void) => {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    };
    // A failed retirement must not skip the remaining independent owners.
    for (const body of this.bodies) release(() => body.deactivate());
    this.bodies = [];
    this.colliders = [];
    for (const g of this.geometry?.values() ?? []) release(() => g.dispose());
    this.geometry = null;
    release(() => this.lease?.release());
    this.lease = null;
    this.record = null;
    if (errors.length)
      throw new AggregateError(errors, "Landscape rock retirement failed");
  }
  override destroy() {
    ++this.generation;
    try {
      this.release();
    } finally {
      super.destroy();
    }
  }
}
