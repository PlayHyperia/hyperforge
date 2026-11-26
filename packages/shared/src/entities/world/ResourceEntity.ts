/**
 * ResourceEntity - Harvestable Resource Entity
 *
 * Represents gatherable resources in the world like trees, rocks, and fishing spots.
 * Players can interact with these to gather materials and gain experience.
 *
 * Visual rendering is delegated to a ResourceVisualStrategy chosen at construction
 * time, so this file contains only game logic (harvesting, depletion, respawn,
 * collision, network sync).
 *
 * @public
 */

import THREE from "../../extras/three/three";
import type { World } from "../../core/World";
import type { EntityData } from "../../types";
import {
  InteractableEntity,
  type InteractableConfig,
} from "../InteractableEntity";
import type {
  EntityInteractionData,
  ResourceEntityConfig,
} from "../../types/entities";
import { modelCache } from "../../utils/rendering/ModelCache";
import { EventType } from "../../types/events";
import { CollisionFlag } from "../../systems/shared/movement/CollisionFlags";
import {
  worldToTile,
  type TileCoord,
} from "../../systems/shared/movement/TileSystem";
import { FOOTPRINT_SIZES } from "../../types/game/resource-processing-types";
import type {
  ResourceVisualStrategy,
  ResourceVisualContext,
} from "./visuals/ResourceVisualStrategy";
import { createVisualStrategy } from "./visuals/createVisualStrategy";

// Re-export types for external use
export type { ResourceEntityConfig } from "../../types/entities";

export class ResourceEntity extends InteractableEntity {
  public config: ResourceEntityConfig;

  /** Tiles this resource occupies for collision (cached for cleanup) */
  private collisionTiles: TileCoord[] = [];

  /** True when the visual strategy handled depletion (instanced stump) — prevents swapToFullModel from removing the collision proxy */
  private depletionHandledByStrategy = false;

  // LOD meshes — owned by the visual strategy but stored here for Entity base class compat
  private lod1Mesh?: THREE.Object3D;
  private lod2Mesh?: THREE.Object3D;

  // Visual strategy (handles all rendering concerns)
  private visual: ResourceVisualStrategy;
  private visualCtx!: ResourceVisualContext;

  constructor(world: World, config: ResourceEntityConfig) {
    const interactableConfig: InteractableConfig = {
      ...config,
      interaction: {
        prompt: `${config.harvestSkill} ${config.resourceType}`,
        description: `${config.resourceType} - Level ${config.requiredLevel} ${config.harvestSkill} required`,
        range: 2.0,
        cooldown: config.harvestTime || 3000,
        usesRemaining: config.depleted ? 0 : -1,
        maxUses: -1,
        effect: "harvest",
      },
    };

    super(world, interactableConfig);
    this.config = {
      ...config,
      depleted: config.depleted !== undefined ? config.depleted : false,
      lastHarvestTime:
        config.lastHarvestTime !== undefined ? config.lastHarvestTime : 0,
    };

    this.health = 0;
    this.maxHealth = 0;

    // Collision registration (server-side, fishing spots don't block)
    if (this.world.isServer && config.resourceType !== "fishing_spot") {
      this.registerCollision();
    }

    // Pick visual strategy once — no more resourceType checks after this
    this.visual = createVisualStrategy(this.config);
  }

  // ===========================================================================
  // Visual context (lazy, created after super() sets up node/position)
  // ===========================================================================

  private getVisualCtx(): ResourceVisualContext {
    if (!this.visualCtx) {
      this.visualCtx = {
        world: this.world,
        config: this.config,
        id: this.id,
        node: this.node,
        position: this.position,
        getMesh: () => this.mesh,
        setMesh: (m) => {
          this.mesh = m;
        },
        getLod1Mesh: () => this.lod1Mesh,
        setLod1Mesh: (m) => {
          this.lod1Mesh = m;
        },
        getLod2Mesh: () => this.lod2Mesh,
        setLod2Mesh: (m) => {
          this.lod2Mesh = m;
        },
        hashString: (s) => this.hashString(s),
        initHLOD: (modelId, options) => this.initHLOD(modelId, options),
      };
    }
    return this.visualCtx;
  }

  /**
   * Shader-based highlight toggle. Returns true if the strategy handled it,
   * false if EntityHighlightService should fall back to the outline pass.
   */
  public setShaderHighlight(on: boolean): boolean {
    if (typeof this.visual.setShaderHighlight === "function") {
      this.visual.setShaderHighlight(this.getVisualCtx(), on);
      return true;
    }
    return super.setShaderHighlight(on);
  }

  // ===========================================================================
  // Collision
  // ===========================================================================

  private registerCollision(): void {
    const centerTile = worldToTile(this.position.x, this.position.z);
    const footprint = this.config.footprint || "standard";
    const size = FOOTPRINT_SIZES[footprint];
    const offsetX = Math.floor(size.x / 2);
    const offsetZ = Math.floor(size.z / 2);

    this.collisionTiles = [];
    for (let dx = 0; dx < size.x; dx++) {
      for (let dz = 0; dz < size.z; dz++) {
        this.collisionTiles.push({
          x: centerTile.x + dx - offsetX,
          z: centerTile.z + dz - offsetZ,
        });
      }
    }

    this.config.anchorTile = centerTile;
    this.config.occupiedTiles = this.collisionTiles;

    for (const tile of this.collisionTiles) {
      this.world.collision.addFlags(tile.x, tile.z, CollisionFlag.BLOCKED);
    }
  }

  private unregisterCollision(): void {
    for (const tile of this.collisionTiles) {
      this.world.collision.removeFlags(tile.x, tile.z, CollisionFlag.BLOCKED);
    }
    this.collisionTiles = [];
  }

  // ===========================================================================
  // Interaction / harvest
  // ===========================================================================

  public async handleInteraction(data: EntityInteractionData): Promise<void> {
    if (data.interactionType && data.interactionType !== "harvest") return;
    if (this.config.depleted) return;

    this.world.emit(EventType.RESOURCE_HARVEST_REQUEST, {
      playerId: data.playerId,
      entityId: this.id,
      resourceType: this.config.resourceType,
      resourceId: this.config.resourceId,
      harvestSkill: this.config.harvestSkill,
      requiredLevel: this.config.requiredLevel,
      harvestTime: this.config.harvestTime,
      harvestYield: this.config.harvestYield,
    });
  }

  public deplete(): void {
    if (!this.world.isServer) return;

    this.config.depleted = true;
    this.config.lastHarvestTime = Date.now();
    this.markNetworkDirty();

    const interactionComponent = this.getComponent("interaction");
    if (interactionComponent) {
      interactionComponent.data.interactable = false;
      interactionComponent.data.description = `${this.config.resourceType} - Depleted`;
    }

    // Respawn is handled by ResourceSystem.processRespawns() via tick-based timing.
    // No setTimeout here — tick-based respawn is deterministic and rules-accurate.
  }

  public respawn(): void {
    if (!this.world.isServer) return;

    this.config.depleted = false;
    this.markNetworkDirty();

    const interactionComponent = this.getComponent("interaction");
    if (interactionComponent) {
      interactionComponent.data.interactable = true;
      interactionComponent.data.description = `${this.config.resourceType} - Level ${this.config.requiredLevel} ${this.config.harvestSkill} required`;
    }
  }

  // ===========================================================================
  // Depletion visuals (stump swap)
  // ===========================================================================

  private async swapToStump(): Promise<void> {
    if (this.world.isServer || !this.node) return;

    const ctx = this.getVisualCtx();
    const handledByStrategy = await this.visual.onDepleted(ctx);
    this.depletionHandledByStrategy = handledByStrategy;

    if (!handledByStrategy) {
      await this.loadDepletedModel();
    }
  }

  private async swapToFullModel(): Promise<void> {
    if (this.world.isServer || !this.node) return;

    // Only remove the stump mesh if the entity loaded one individually.
    // When the instancer handles depletion, this.mesh is the collision proxy
    // and must NOT be removed.
    if (!this.depletionHandledByStrategy && this.mesh) {
      this.node.remove(this.mesh);
      this.mesh = null;
    }
    this.depletionHandledByStrategy = false;

    // Let the strategy restore its visual
    await this.visual.onRespawn(this.getVisualCtx());
  }

  /**
   * Load the depleted model (stump, depleted rock, etc.).
   * Shared across all resource types — the strategy doesn't handle this.
   */
  private async loadDepletedModel(): Promise<void> {
    const depletedModelPath = this.config.depletedModelPath;

    if (!depletedModelPath) {
      if (this.mesh) this.mesh.visible = false;
      return;
    }

    // Remove current mesh
    if (this.mesh) {
      this.node.remove(this.mesh);
      this.mesh = null;
    }

    try {
      const { scene } = await modelCache.loadModel(
        depletedModelPath,
        this.world,
      );

      this.mesh = scene;
      this.mesh.name = `ResourceDepleted_${this.config.resourceType}`;

      const modelScale = this.config.depletedModelScale ?? 0.3;
      this.mesh.scale.set(modelScale, modelScale, modelScale);

      this.mesh.layers.set(1);
      this.mesh.traverse((child) => {
        child.layers.set(1);
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      this.mesh.userData = {
        type: "resource",
        entityId: this.id,
        name: `${this.config.name} (Depleted)`,
        interactable: false,
        resourceType: this.config.resourceType,
        depleted: true,
      };

      const bbox = new THREE.Box3().setFromObject(this.mesh);
      this.mesh.position.set(0, -bbox.min.y, 0);

      this.node.add(this.mesh);
    } catch (err) {
      console.error(
        `[ResourceEntity] Failed to load depleted model "${depletedModelPath}" for ${this.id}:`,
        err,
      );
      if (this.mesh) this.mesh.visible = false;
    }
  }

  // ===========================================================================
  // Mesh creation / update (delegated)
  // ===========================================================================

  protected async createMesh(): Promise<void> {
    if (this.world.isServer || this.destroyed) return;
    await this.visual.createVisual(this.getVisualCtx());
    if (!this.destroyed) this.world.setHot(this, true);
  }

  protected clientUpdate(deltaTime: number): void {
    super.clientUpdate(deltaTime);
    if (this.world.isServer) return;
    this.visual.update(this.getVisualCtx(), deltaTime);
  }

  // ===========================================================================
  // Network sync
  // ===========================================================================

  serialize(): EntityData {
    const baseData = super.serialize();
    return {
      ...baseData,
      model: this.config.model,
      resourceType: this.config.resourceType,
      resourceId: this.config.resourceId,
      depleted: this.config.depleted,
      harvestSkill: this.config.harvestSkill,
      requiredLevel: this.config.requiredLevel,
      harvestTime: this.config.harvestTime,
      harvestYield: this.config.harvestYield,
      respawnTime: this.config.respawnTime,
      interactionDistance: this.config.interactionDistance || 3,
      description: this.config.description,
      modelScale: this.config.modelScale,
      depletedModelScale: this.config.depletedModelScale,
      depletedModelPath: this.config.depletedModelPath,
      procgenPreset: this.config.procgenPreset,
      modelVariants: this.config.modelVariants,
    } as EntityData;
  }

  // PERF: Mutates buffer in-place instead of creating new objects
  public getNetworkData(): Record<string, unknown> {
    const buf = super.getNetworkData();
    buf.model = this.config.model;
    buf.resourceType = this.config.resourceType;
    buf.resourceId = this.config.resourceId;
    buf.depleted = this.config.depleted;
    buf.harvestSkill = this.config.harvestSkill;
    buf.requiredLevel = this.config.requiredLevel;
    buf.harvestTime = this.config.harvestTime;
    buf.harvestYield = this.config.harvestYield;
    buf.respawnTime = this.config.respawnTime;
    buf.modelScale = this.config.modelScale;
    buf.depletedModelScale = this.config.depletedModelScale;
    buf.depletedModelPath = this.config.depletedModelPath;
    buf.procgenPreset = this.config.procgenPreset;
    buf.modelVariants = this.config.modelVariants;
    return buf;
  }

  public updateFromNetwork(data: Record<string, unknown>): void {
    if (data.depleted !== undefined) {
      const wasDepleted = this.config.depleted;
      this.config.depleted = Boolean(data.depleted);

      if (this.config.depleted && !wasDepleted) {
        this.swapToStump().catch((err) =>
          console.error(
            `[ResourceEntity] swapToStump failed for ${this.id}:`,
            err,
          ),
        );
      } else if (!this.config.depleted && wasDepleted) {
        this.swapToFullModel().catch((err) =>
          console.error(
            `[ResourceEntity] swapToFullModel failed for ${this.id}:`,
            err,
          ),
        );
      }
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  // ===========================================================================
  // Destroy
  // ===========================================================================

  destroy(local?: boolean): void {
    if (this.destroyed) return;
    if (this.world.isServer && this.collisionTiles.length > 0) {
      this.unregisterCollision();
    }

    // Delegate visual cleanup to strategy
    this.visual.destroy(this.getVisualCtx());

    if (!this.world.isServer) {
      this.world.setHot(this, false);
    }

    super.destroy(local);
  }
}
