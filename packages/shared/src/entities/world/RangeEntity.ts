/**
 * RangeEntity - Permanent cooking station
 *
 * Represents a cooking range (oven/stove) that players can cook on.
 * Ranges provide lower burn rates than fires for most foods.
 * Unlike fires, ranges are permanent fixtures in the world.
 *
 * **Extends**: InteractableEntity (players can interact to cook)
 *
 * **Interaction**:
 * - Left-click: Opens cook interface (if player has raw food)
 * - Right-click: Context menu with "Cook [item]" options and "Examine"
 *
 * **Visual Representation**:
 * - Gray/brown stove-like box
 *
 * Specialized ranges may provide a configured burn-rate reduction.
 *
 * **Runs on**: Server (authoritative), Client (visual)
 */

import THREE, { MeshStandardNodeMaterial } from "../../extras/three/three";
import type { World } from "../../core/World";
import { EntityType, InteractionType } from "../../types/entities";
import type { EntityInteractionData } from "../../types/entities";
import {
  InteractableEntity,
  type InteractableConfig,
} from "../InteractableEntity";
import { EventType } from "../../types/events";
import { PROCESSING_CONSTANTS } from "../../constants/ProcessingConstants";
import { stationDataProvider } from "../../data/StationDataProvider";
import { modelCache } from "../../utils/rendering/ModelCache";
import { CollisionFlag } from "../../systems/shared/movement/CollisionFlags";
import {
  worldToTile,
  type TileCoord,
} from "../../systems/shared/movement/TileSystem";
import {
  resolveFootprint,
  type FootprintSpec,
} from "../../types/game/resource-processing-types";

/**
 * Configuration for creating a RangeEntity.
 */
export interface RangeEntityConfig {
  id: string;
  name?: string;
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  /** Burn rate reduction (0 = standard, 0.05 = five percent) */
  burnReduction?: number;
  /** Collision footprint - predefined ("standard", "large") or custom { width, depth } */
  footprint?: FootprintSpec;
}

export class RangeEntity extends InteractableEntity {
  public readonly entityType = "range";
  public readonly isInteractable = true;
  public readonly isPermanent = true;

  /** Burn rate reduction (0-1, where 0.05 = 5% reduction) */
  public burnReduction: number;

  /** Display name */
  public displayName: string;

  /** Tiles this station occupies for collision (supports multi-tile footprints) */
  private collisionTiles: TileCoord[] = [];

  /** Footprint specification for this station */
  private footprint: FootprintSpec;

  constructor(world: World, config: RangeEntityConfig) {
    // Convert to InteractableConfig format
    const interactableConfig: InteractableConfig = {
      id: config.id,
      name: config.name || "Range",
      type: EntityType.RANGE,
      position: config.position,
      rotation: config.rotation
        ? { ...config.rotation, w: 1 }
        : { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.COOKING,
      interactionDistance: PROCESSING_CONSTANTS.FIRE.interactionRange,
      description: "A range for cooking food.",
      model: null,
      interaction: {
        prompt: "Cook",
        description: "Cook food on this range",
        range: PROCESSING_CONSTANTS.FIRE.interactionRange,
        cooldown: 0,
        usesRemaining: -1,
        maxUses: -1,
        effect: "cooking",
      },
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: { current: 1, max: 1 },
        level: 1,
      },
    };

    super(world, interactableConfig);

    this.displayName = config.name || "Range";
    this.burnReduction = config.burnReduction || 0;
    // Get footprint from manifest (data-driven), allow per-instance override via config
    this.footprint =
      config.footprint ?? stationDataProvider.getFootprint("range");

    // Register collision for this station (server-side only)
    // Supports multi-tile footprints (e.g., "large" = 2x2 or { width: 2, depth: 1 })
    // Collision is CENTERED on the model position, not starting from it
    if (this.world.isServer) {
      const centerTile = worldToTile(config.position.x, config.position.z);
      const size = resolveFootprint(this.footprint);

      // Offset to center the footprint on the model
      const offsetX = Math.floor(size.x / 2);
      const offsetZ = Math.floor(size.z / 2);

      // Calculate all tiles this station occupies (centered on position)
      for (let dx = 0; dx < size.x; dx++) {
        for (let dz = 0; dz < size.z; dz++) {
          const tile = {
            x: centerTile.x + dx - offsetX,
            z: centerTile.z + dz - offsetZ,
          };
          this.collisionTiles.push(tile);
          this.world.collision.addFlags(tile.x, tile.z, CollisionFlag.BLOCKED);
        }
      }
    }
  }

  /**
   * Clean up collision and resources when destroyed.
   */
  destroy(local?: boolean): void {
    // Unregister all collision tiles (server-side only)
    if (this.world.isServer && this.collisionTiles.length > 0) {
      for (const tile of this.collisionTiles) {
        this.world.collision.removeFlags(tile.x, tile.z, CollisionFlag.BLOCKED);
      }
      this.collisionTiles = [];
    }

    super.destroy(local);
  }

  /**
   * Return tiles occupied by this station for classic MMORPG-style interaction checking.
   * Uses the same tiles registered for collision.
   */
  protected override getOccupiedTiles(): TileCoord[] {
    // Return collision tiles if available, otherwise fall back to single tile
    if (this.collisionTiles.length > 0) {
      return this.collisionTiles;
    }
    // Fallback for client-side (collision tiles only registered on server)
    const pos = this.getPosition();
    return [worldToTile(pos.x, pos.z)];
  }

  protected async createMesh(): Promise<void> {
    // Don't create mesh on server
    if (this.world.isServer) {
      return;
    }

    // Get station data from manifest
    const stationData = stationDataProvider.getStationData("range");
    const modelPath = stationData?.model ?? null;
    const modelScale = stationData?.modelScale ?? 1.0;
    const modelYOffset = stationData?.modelYOffset ?? 0;

    // Try to load 3D model first
    if (modelPath && this.world.loader) {
      try {
        const { scene } = await modelCache.loadModel(modelPath, this.world);

        this.mesh = scene;
        this.mesh.name = `Range_${this.id}`;

        // Scale the model from manifest
        this.mesh.scale.set(modelScale, modelScale, modelScale);

        // Offset Y position so model base sits on ground
        this.mesh.position.y = modelYOffset;

        // Enable shadows and set layer for raycasting
        this.mesh.layers.set(1);
        this.mesh.traverse((child) => {
          child.layers.set(1);
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = false;
          }
        });

        // Set up userData for interaction detection
        this.mesh.userData = {
          type: "range",
          entityId: this.id,
          name: this.displayName,
          interactable: true,
          burnReduction: this.burnReduction,
        };

        // Add to node
        if (this.node) {
          this.node.add(this.mesh);
          this.node.userData.type = "range";
          this.node.userData.entityId = this.id;
          this.node.userData.interactable = true;
        }

        // Initialize HLOD impostor support
        await this.initHLOD(`station_range_${modelPath}`, {
          category: "station",
          atlasSize: 1024,
          hemisphere: true,
        });

        return;
      } catch (error) {
        console.warn(
          `[RangeEntity] Failed to load range model, using placeholder:`,
          error,
        );
      }
    }

    // FALLBACK: Create a red box for the range (placeholder, 1 tile size)
    const boxHeight = 0.8;
    const geometry = new THREE.BoxGeometry(0.9, boxHeight, 0.9);
    const material = new MeshStandardNodeMaterial({
      color: 0xcc3333, // Red (placeholder)
      roughness: 0.5,
      metalness: 0.3,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Range_${this.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    // Offset mesh up so it sits on the ground (BoxGeometry is centered at origin)
    mesh.position.y = boxHeight / 2;
    // Set layer for raycasting (required for interaction detection)
    mesh.layers.set(1);
    this.mesh = mesh;

    // Set up userData for interaction detection
    mesh.userData = {
      type: "range",
      entityId: this.id,
      name: this.displayName,
      interactable: true,
      burnReduction: this.burnReduction,
    };

    // Add mesh to the entity's node
    if (this.mesh && this.node) {
      this.node.add(this.mesh);

      // Also set userData on node for easier detection
      this.node.userData.type = "range";
      this.node.userData.entityId = this.id;
      this.node.userData.interactable = true;
    }
  }

  /**
   * Handle range interaction - opens cooking interface.
   */
  public async handleInteraction(data: EntityInteractionData): Promise<void> {
    // Emit event to start cooking interaction
    this.world.emit(EventType.COOKING_INTERACT, {
      playerId: data.playerId,
      rangeId: this.id,
      sourceType: "range" as const,
      position: this.position,
      burnReduction: this.burnReduction,
    });
  }

  /**
   * Get context menu actions for this range.
   */
  public getContextMenuActions(playerId: string): Array<{
    id: string;
    label: string;
    priority: number;
    handler: () => void;
  }> {
    const actions: Array<{
      id: string;
      label: string;
      priority: number;
      handler: () => void;
    }> = [];

    // Add "Cook" action
    actions.push({
      id: "cook",
      label: "Cook",
      priority: 1,
      handler: () => {
        this.world.emit(EventType.COOKING_INTERACT, {
          playerId,
          rangeId: this.id,
          sourceType: "range" as const,
          position: this.position,
          burnReduction: this.burnReduction,
        });
      },
    });

    // Add "Examine" action
    actions.push({
      id: "examine",
      label: "Examine",
      priority: 100,
      handler: () => {
        const examineText =
          this.burnReduction > 0
            ? `A well-maintained range. Cooking here reduces burn chance by ${(this.burnReduction * 100).toFixed(0)}%.`
            : "A range for cooking food.";
        this.world.emit(EventType.UI_MESSAGE, {
          playerId,
          message: examineText,
        });
      },
    });

    return actions;
  }

  // PERF: Mutates buffer in-place instead of creating new objects
  getNetworkData(): Record<string, unknown> {
    const buf = super.getNetworkData();
    buf.displayName = this.displayName;
    buf.burnReduction = this.burnReduction;
    buf.isPermanent = this.isPermanent;
    return buf;
  }

  /**
   * Client update - ranges are static but could have animations.
   */
  protected clientUpdate(deltaTime: number): void {
    super.clientUpdate(deltaTime);
    // Range is static, no animation needed
  }
}
