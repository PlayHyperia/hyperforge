/**
 * BankEntity - Bank booth/chest for storing items
 *
 * Represents a bank where players can store items securely.
 * Rendered as a black box on the client.
 *
 * **Extends**: InteractableEntity (players can interact to open bank)
 *
 * **Interaction**:
 * - Left-click: Opens bank interface
 * - Right-click: Context menu with "Use Bank" and "Examine"
 *
 * **Visual Representation**:
 * - Black chest-sized box (1 tile)
 *
 * **Runs on**: Server (authoritative), Client (visual)
 */

import THREE, { MeshStandardNodeMaterial } from "../../extras/three/three";
import type { World } from "../../core/World";
import type {
  EntityInteractionData,
  BankEntityConfig,
} from "../../types/entities";
import { EntityType, InteractionType } from "../../types/entities";
import {
  InteractableEntity,
  type InteractableConfig,
} from "../InteractableEntity";
import { EventType } from "../../types/events";
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

export class BankEntity extends InteractableEntity {
  protected config: BankEntityConfig;
  private bankId: string;

  /** Tiles this station occupies for collision (supports multi-tile footprints) */
  private collisionTiles: TileCoord[] = [];

  /** Footprint specification for this station */
  private footprint: FootprintSpec;

  /** Default interaction range for banks (in tiles) */
  private static readonly BANK_INTERACTION_RANGE = 3;

  constructor(world: World, config: BankEntityConfig) {
    // Convert BankEntityConfig to InteractableConfig format
    // Provide defaults for optional fields (like FurnaceEntity pattern)
    const interactionDistance =
      config.interactionDistance ?? BankEntity.BANK_INTERACTION_RANGE;
    const description =
      config.description ?? "A secure place to store your items.";

    const interactableConfig: InteractableConfig = {
      id: config.id,
      name: config.name || "Bank",
      type: EntityType.BANK,
      position: config.position,
      rotation: config.rotation
        ? { ...config.rotation }
        : { x: 0, y: 0, z: 0, w: 1 },
      scale: config.scale ?? { x: 1, y: 1, z: 1 },
      visible: config.visible ?? true,
      interactable: config.interactable ?? true,
      interactionType: InteractionType.BANK,
      interactionDistance: interactionDistance,
      description: description,
      model: config.model ?? null,
      interaction: {
        prompt: "Use Bank",
        description: description,
        range: interactionDistance,
        cooldown: 0,
        usesRemaining: -1,
        maxUses: -1,
        effect: "bank",
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
    this.config = config;
    this.bankId = config.properties?.bankId || "spawn_bank";
    // Get footprint from manifest (data-driven), allow per-instance override via config
    this.footprint =
      config.footprint ?? stationDataProvider.getFootprint("bank");

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
    const stationData = stationDataProvider.getStationData("bank");
    const modelPath = stationData?.model ?? null;
    const modelScale = stationData?.modelScale ?? 1.0;
    const modelYOffset = stationData?.modelYOffset ?? 0;

    // Try to load 3D model first
    if (modelPath && this.world.loader) {
      try {
        const { scene } = await modelCache.loadModel(modelPath, this.world);

        this.mesh = scene;
        this.mesh.name = `Bank_${this.id}`;

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
          type: "bank",
          entityId: this.id,
          name: this.config.name,
          interactable: true,
          bankId: this.bankId,
        };

        // Add to node
        if (this.node) {
          this.node.add(this.mesh);
          this.node.userData.type = "bank";
          this.node.userData.entityId = this.id;
          this.node.userData.interactable = true;
          this.node.userData.bankId = this.bankId;
        }

        // Initialize HLOD impostor support
        await this.initHLOD(`station_bank_${modelPath}`, {
          category: "station",
          atlasSize: 1024,
          hemisphere: true,
        });

        return;
      } catch (error) {
        console.warn(
          `[BankEntity] Failed to load bank model, using placeholder:`,
          error,
        );
      }
    }

    // FALLBACK: Create a black box for the bank (1 tile size, chest-like proportions)
    const boxHeight = 0.7;
    const geometry = new THREE.BoxGeometry(0.9, boxHeight, 0.9);
    const material = new MeshStandardNodeMaterial({
      color: 0x111111, // Very dark black
      roughness: 0.3,
      metalness: 0.8, // Metallic chest
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Bank_${this.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    // Offset mesh up so it sits on the ground (BoxGeometry is centered at origin)
    mesh.position.y = boxHeight / 2;
    this.mesh = mesh;

    // Set up userData for interaction detection
    mesh.userData = {
      type: "bank",
      entityId: this.id,
      name: this.config.name,
      interactable: true,
      bankId: this.bankId,
    };

    // Add mesh to the entity's node
    if (this.mesh && this.node) {
      this.node.add(this.mesh);

      // Also set userData on node for easier detection
      this.node.userData.type = "bank";
      this.node.userData.entityId = this.id;
      this.node.userData.interactable = true;
      this.node.userData.bankId = this.bankId;
    }
  }

  /**
   * Handle bank interaction - opens bank interface
   */
  public async handleInteraction(data: EntityInteractionData): Promise<void> {
    // Emit event to open bank
    this.world.emit(EventType.BANK_OPEN, {
      playerId: data.playerId,
      bankId: this.id,
    });

    // Send network packet to open bank on client
    if (this.world.isServer && this.world.network) {
      const network = this.world.network as {
        sendTo?: (playerId: string, packet: string, data: unknown) => void;
      };
      if (network.sendTo) {
        network.sendTo(data.playerId, "bankOpen", { bankId: this.id });
      }
    }
  }

  // PERF: Mutates buffer in-place instead of creating new objects
  getNetworkData(): Record<string, unknown> {
    const buf = super.getNetworkData();
    buf.bankId = this.bankId;
    return buf;
  }

  protected clientUpdate(deltaTime: number): void {
    super.clientUpdate(deltaTime);
    // Bank is static, no animation needed
  }
}
