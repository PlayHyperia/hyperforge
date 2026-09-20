import type { OpenWorkshopGeometry } from "@hyperforge/procgen/building";
import * as THREE from "../../../extras/three/three";
import { DataManager } from "../../../data/DataManager";
import { Collider } from "../../../nodes/Collider";
import { RigidBody } from "../../../nodes/RigidBody";
import { System } from "../infrastructure/System";
import type { StaticCollisionLease } from "../movement/CollisionMatrix";
import {
  createCompactServiceCourtGrassExclusions,
  groundCompactServiceCourt,
  type OwnedCompactServiceCourt,
} from "./CompactServiceCourt";
import type { TerrainSystem } from "./TerrainSystem";

export const COMPACT_SERVICE_COURT_SYSTEM = "compact-service-court";

type CourtResources = {
  record: OwnedCompactServiceCourt;
  lease: StaticCollisionLease | null;
  grassExclusionLease: { release(): void } | null;
  geometry: OpenWorkshopGeometry | null;
  body: RigidBody | null;
  colliders: Collider[];
  indexedViews: THREE.BufferGeometry[];
};

/** Shared authoritative post navigation and exact static triangle collision.
 * Does not register floors, interiors, services, resources, terrain edits or updates.
 */
export class CompactServiceCourtSystem extends System {
  private generation = 0;
  private records: readonly OwnedCompactServiceCourt[] = Object.freeze([]);
  private resources: CourtResources[] = [];

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
    const config = DataManager.getWorldConfig();
    const descriptors: OwnedCompactServiceCourt["descriptor"][] = [];
    if (config?.compactServiceCourt)
      descriptors.push(config.compactServiceCourt);
    if (config?.compactBankPavilion)
      descriptors.push(config.compactBankPavilion);
    if (!descriptors.length) {
      this.started = true;
      return;
    }
    const { OPEN_WORKSHOP_POSTS, BANK_PAVILION_POSTS, createOpenWorkshop } =
      await import("@hyperforge/procgen/building");
    if (generation !== this.generation) return;
    const terrain = this.world.getSystem<TerrainSystem>("terrain");
    if (!terrain)
      throw new Error("Compact service court requires authoritative terrain");
    try {
      for (const descriptor of descriptors) {
        const isBank = descriptor.layoutId === "compact-bank-pavilion-v1";
        const posts = isBank ? BANK_PAVILION_POSTS : OPEN_WORKSHOP_POSTS;
        const record = groundCompactServiceCourt(descriptor, posts, (x, z) =>
          terrain.getHeightAt(x, z),
        );
        const owned: CourtResources = {
          record,
          lease: null,
          grassExclusionLease: null,
          geometry: null,
          body: null,
          colliders: [],
          indexedViews: [],
        };
        // Register partial ownership before allocating: any later failure must
        // unwind this court and every previously admitted court together.
        this.resources.push(owned);
        if (this.world.physics) {
          owned.geometry = createOpenWorkshop(record.feet, {
            recipe: isBank ? "bank-pavilion-v1" : "smithy-v1",
            architecturalFinish:
              isBank ||
              record.descriptor.recipeId === "open-timber-smithy-haven-v3"
                ? "haven-v1"
                : undefined,
          });
          owned.body = new RigidBody({
            type: "static",
            tag: descriptor.layoutId,
            position: [record.position.x, record.position.y, record.position.z],
          });
          for (const geometry of [
            owned.geometry.timber,
            owned.geometry.roof,
            owned.geometry.footings,
          ]) {
            const indexed = new THREE.BufferGeometry();
            owned.indexedViews.push(indexed);
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
            owned.colliders.push(collider);
            owned.body.add(collider);
          }
          owned.body.activate(this.world);
          if (
            !owned.body.actor ||
            !owned.body.actorHandle ||
            owned.colliders.some((c) => !c.shape || !c.pmesh)
          )
            throw new Error(
              "Compact service court native triangle collision failed",
            );
        }
        owned.lease = this.world.collision.acquireStaticFootprint(
          record.blockingTiles,
        );
        owned.grassExclusionLease = terrain.acquireGrassExclusionPolygons(
          createCompactServiceCourtGrassExclusions(record, posts),
        );
      }
      this.records = Object.freeze(this.resources.map(({ record }) => record));
      this.started = true;
    } catch (error) {
      try {
        this.release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Compact service courts failed startup and cleanup",
        );
      }
      throw error;
    }
  }

  getCourt(): OwnedCompactServiceCourt | null {
    return (
      this.records.find(
        (record) => record.descriptor.layoutId === "compact-service-court-v1",
      ) ?? null
    );
  }

  getCourts(): readonly OwnedCompactServiceCourt[] {
    return this.records;
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
      this.records.map((record) => {
        const owned = this.resources.find((entry) => entry.record === record)!;
        return Object.freeze({
          layoutId: record.descriptor.layoutId,
          blockingTiles: record.blockingTiles,
          feet: record.feet,
          position: record.position,
          physicsActor: Boolean(owned.body?.actor),
          physicsShapes: owned.colliders.filter((c) => c.shape).length,
        });
      }),
    );
  }

  private release(): void {
    this.records = Object.freeze([]);
    const resources = this.resources.splice(0).reverse();
    const errors: unknown[] = [];
    const attempt = (action: () => void) => {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const owned of resources) {
      attempt(() => owned.body?.deactivate());
      for (const geometry of owned.indexedViews)
        attempt(() => geometry.dispose());
      attempt(() => owned.geometry?.dispose());
      attempt(() => owned.lease?.release());
      attempt(() => owned.grassExclusionLease?.release());
    }
    if (errors.length)
      throw new AggregateError(errors, "Compact service courts failed cleanup");
  }

  override destroy(): void {
    ++this.generation;
    try {
      this.release();
    } finally {
      super.destroy();
    }
  }
}
