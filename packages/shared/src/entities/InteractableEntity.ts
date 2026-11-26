/**
 * InteractableEntity - Base Interactable Entity
 *
 * Abstract base class for entities that players can interact with.
 * Provides standardized interaction mechanics including prompts, cooldowns,
 * and usage tracking.
 *
 * **Extends**: Entity (adds interaction functionality)
 *
 * **Key Features**:
 *
 * **Interaction System**:
 * - Interaction prompts ("Take", "Harvest", "Talk", etc.)
 * - Range checking (player must be within distance)
 * - Cooldown system (prevents spam)
 * - Usage tracking (limited use items)
 * - Required items (tools, keys, etc.)
 *
 * **Interaction Component**:
 * - Interactable flag
 * - Interaction distance
 * - Prompt text for UI
 * - Description for tooltip
 * - Last interaction time
 * - Uses remaining counter
 *
 * **Usage Mechanics**:
 * - Infinite uses (usesRemaining = -1)
 * - Limited uses (doors, chests, consumables)
 * - Single use (ground items)
 * - Cooldown period between uses
 *
 * **Requirements**:
 * - Level requirements
 * - Skill requirements
 * - Item requirements (tools)
 * - Item consumption on use
 *
 * **Interaction Effects**:
 * - Custom effect strings ('harvest', 'pickup', 'open', etc.)
 * - Particle effects on interaction
 * - Sound effects
 * - Animation triggers
 *
 * **Visual Feedback**:
 * - Highlight when in range
 * - Interaction prompt above entity
 * - Progress bar for timed interactions
 * - Disabled appearance when on cooldown
 *
 * **Network Sync**:
 * - Interaction state broadcasted
 * - Uses remaining synced
 * - Cooldown state updated
 *
 * **Subclasses**:
 * - ItemEntity: Pickup items from ground
 * - ResourceEntity: Harvest trees, rocks, fish
 * - HeadstoneEntity: Loot corpses
 * - NPCEntity: Talk to NPCs, open shops
 *
 * **Runs on**: Server (authoritative), Client (visual + UI)
 * **Referenced by**: InteractionSystem, all interactable entities
 *
 * @public
 */

import { Entity } from "./Entity";
import type { World } from "../core/World";
import type { EntityConfig, EntityInteractionData } from "../types/entities";
import type { Position3D } from "../types/core/core";
import {
  worldToTile,
  type TileCoord,
} from "../systems/shared/movement/TileSystem";

export interface InteractableConfig extends EntityConfig {
  interaction?: {
    prompt?: string;
    description?: string;
    range?: number;
    cooldown?: number;
    usesRemaining?: number;
    maxUses?: number;
    requiresItem?: string;
    consumesItem?: boolean;
    effect?: string;
  };
}

export abstract class InteractableEntity extends Entity {
  // Interaction properties
  protected interactionPrompt: string = "Interact";
  protected interactionDescription: string = "";
  protected interactionRange: number = 2.0;
  protected interactionCooldown: number = 0;
  protected lastInteractionTime: number = 0;

  // Usage tracking
  protected usesRemaining: number = -1; // -1 = infinite uses
  protected maxUses: number = -1;
  protected requiredItem: string | null = null;
  protected consumesItem: boolean = false;
  protected interactionEffect: string | null = null;

  constructor(world: World, config: InteractableConfig) {
    super(world, config);

    // Initialize interaction properties from config
    if (config.interaction) {
      this.interactionPrompt =
        config.interaction.prompt || this.interactionPrompt;
      this.interactionDescription =
        config.interaction.description || this.interactionDescription;
      this.interactionRange = config.interaction.range || this.interactionRange;
      this.interactionCooldown =
        config.interaction.cooldown || this.interactionCooldown;
      this.usesRemaining =
        config.interaction.usesRemaining ?? this.usesRemaining;
      this.maxUses = config.interaction.maxUses ?? this.maxUses;
      this.requiredItem = config.interaction.requiresItem || null;
      this.consumesItem = config.interaction.consumesItem || false;
      this.interactionEffect = config.interaction.effect || null;
    }

    this.initializeInteraction();
  }

  protected initializeInteraction(): void {
    // Override interaction component with enhanced data
    this.addComponent("interaction", {
      type: this.type,
      interactable: true,
      distance: this.interactionRange,
      prompt: this.interactionPrompt,
      description: this.interactionDescription,
      cooldown: this.interactionCooldown,
      lastInteractionTime: 0,
      usesRemaining: this.usesRemaining,
      maxUses: this.maxUses,
      requiredItem: this.requiredItem,
      consumesItem: this.consumesItem,
      effect: this.interactionEffect,
    });

    // Add usage tracking component if there are limited uses
    if (this.maxUses > 0) {
      this.addComponent("usage", {
        usesRemaining: this.usesRemaining,
        maxUses: this.maxUses,
        isExhausted: this.usesRemaining <= 0,
        resetTime: null, // Can be set for items that regenerate uses
      });
    }
  }

  // === Interaction Methods ===

  /**
   * Get tiles occupied by this entity for interaction checking.
   * Override in subclasses (e.g., station entities) to return multi-tile footprints.
   * Default: single tile at entity position.
   *
   * classic MMORPG-style: Interaction is allowed if player is within `interactionRange`
   * tiles of ANY occupied tile, using Chebyshev distance (diagonals count as 1).
   */
  protected getOccupiedTiles(): TileCoord[] {
    const pos = this.getPosition();
    return [worldToTile(pos.x, pos.z)];
  }

  /**
   * Calculate tile distance (Chebyshev distance) between two tiles.
   * Diagonal movement counts as 1 step, matching classic tick-based mechanics.
   */
  private getTileDistance(t1: TileCoord, t2: TileCoord): number {
    return Math.max(Math.abs(t1.x - t2.x), Math.abs(t1.z - t2.z));
  }

  /**
   * Calculate minimum tile distance from player to any occupied tile.
   * For multi-tile objects, finds the closest occupied tile.
   */
  private calculateTileDistance(playerPosition: Position3D): number {
    const playerTile = worldToTile(playerPosition.x, playerPosition.z);
    const occupiedTiles = this.getOccupiedTiles();

    let minDistance = Infinity;
    for (const tile of occupiedTiles) {
      const dist = this.getTileDistance(playerTile, tile);
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    return minDistance;
  }

  /**
   * Check if a player can interact with this entity
   */
  public canInteract(playerId: string, playerPosition: Position3D): boolean {
    // Check if entity is destroyed
    if (this.destroyed) {
      return false;
    }

    // Check usage limits
    if (this.maxUses > 0 && this.usesRemaining <= 0) {
      return false;
    }

    // Check cooldown
    const now = Date.now();
    if (
      this.interactionCooldown > 0 &&
      now - this.lastInteractionTime < this.interactionCooldown
    ) {
      return false;
    }

    // Check distance using classic MMORPG-style tile distance (Chebyshev)
    // Player must be within interactionRange tiles of ANY occupied tile
    const tileDistance = this.calculateTileDistance(playerPosition);

    if (tileDistance > this.interactionRange) {
      return false;
    }

    // Additional checks can be overridden by subclasses
    return this.canInteractCustom(playerId, playerPosition);
  }

  /**
   * Custom interaction validation - can be overridden by subclasses
   */
  protected canInteractCustom(
    _playerId: string,
    _playerPosition: Position3D,
  ): boolean {
    return true;
  }

  /**
   * Handle interaction with this entity
   */
  protected async onInteract(data: EntityInteractionData): Promise<void> {
    const playerPos = data.playerPosition || data.position;

    // Validate interaction
    if (!this.canInteract(data.playerId, playerPos)) {
      this.handleInteractionDenied(data);
      return;
    }

    // Update interaction tracking
    this.lastInteractionTime = Date.now();

    // Consume use if limited
    if (this.maxUses > 0) {
      this.usesRemaining--;

      // Update usage component
      const usageComponent = this.getComponent("usage");
      if (usageComponent) {
        usageComponent.data.usesRemaining = this.usesRemaining;
        usageComponent.data.isExhausted = this.usesRemaining <= 0;
      }
    }

    // Update interaction component
    const interactionComponent = this.getComponent("interaction");
    if (interactionComponent) {
      interactionComponent.data.lastInteractionTime = this.lastInteractionTime;
      interactionComponent.data.usesRemaining = this.usesRemaining;
    }

    // Emit interaction event
    this.emit("interaction", {
      entityId: this.id,
      playerId: data.playerId,
      interactionType: data.interactionType,
      position: this.getPosition(),
      usesRemaining: this.usesRemaining,
    });

    // Trigger interaction effect if specified
    if (this.interactionEffect) {
      this.triggerEffect(this.interactionEffect, data);
    }

    // Call custom interaction logic
    await this.handleInteraction(data);

    // Handle exhaustion if no uses remaining
    if (this.maxUses > 0 && this.usesRemaining <= 0) {
      await this.handleExhaustion(data);
    }
  }

  /**
   * Handle when interaction is denied
   */
  protected handleInteractionDenied(data: EntityInteractionData): void {
    let reason = "Cannot interact";

    if (this.maxUses > 0 && this.usesRemaining <= 0) {
      reason = "No uses remaining";
    } else if (
      this.interactionCooldown > 0 &&
      Date.now() - this.lastInteractionTime < this.interactionCooldown
    ) {
      reason = "On cooldown";
    } else {
      reason = "Too far away";
    }

    this.emit("interaction-denied", {
      entityId: this.id,
      playerId: data.playerId,
      reason,
      position: this.getPosition(),
    });
  }

  /**
   * Trigger a visual or audio effect
   */
  protected triggerEffect(
    effectName: string,
    data: EntityInteractionData,
  ): void {
    this.emit("effect", {
      entityId: this.id,
      playerId: data.playerId,
      effect: effectName,
      position: this.getPosition(),
    });
  }

  /**
   * Handle when entity is exhausted (no uses remaining)
   */
  protected async handleExhaustion(data: EntityInteractionData): Promise<void> {
    this.emit("exhausted", {
      entityId: this.id,
      playerId: data.playerId,
      position: this.getPosition(),
    });

    // Default behavior: make entity non-interactable
    const interactionComponent = this.getComponent("interaction");
    if (interactionComponent) {
      interactionComponent.data.interactable = false;
    }
  }

  /**
   * Reset uses to maximum (for respawning resources, etc.)
   */
  public resetUses(): void {
    if (this.maxUses > 0) {
      this.usesRemaining = this.maxUses;

      const usageComponent = this.getComponent("usage");
      if (usageComponent) {
        usageComponent.data.usesRemaining = this.usesRemaining;
        usageComponent.data.isExhausted = false;
      }

      const interactionComponent = this.getComponent("interaction");
      if (interactionComponent) {
        interactionComponent.data.usesRemaining = this.usesRemaining;
        interactionComponent.data.interactable = true;
      }

      this.emit("uses-reset", {
        entityId: this.id,
        usesRemaining: this.usesRemaining,
      });
    }
  }

  /**
   * Get interaction information for UI display
   */
  public getInteractionInfo(): {
    prompt: string;
    description: string;
    range: number;
    usesRemaining: number;
    maxUses: number;
    canInteract: boolean;
  } {
    return {
      prompt: this.interactionPrompt,
      description: this.interactionDescription,
      range: this.interactionRange,
      usesRemaining: this.usesRemaining,
      maxUses: this.maxUses,
      canInteract: this.usesRemaining !== 0 && !this.destroyed,
    };
  }

  // === Abstract Methods ===

  /**
   * Custom interaction handling - must be implemented by subclasses
   */
  public abstract handleInteraction(data: EntityInteractionData): Promise<void>;

  /**
   * Create the entity's visual representation - from Entity
   */
  protected abstract createMesh(): Promise<void>;

  // === Getters ===

  public getInteractionPrompt(): string {
    return this.interactionPrompt;
  }
  public getInteractionDescription(): string {
    return this.interactionDescription;
  }
  public getInteractionRange(): number {
    return this.interactionRange;
  }
  /**
   * Return the exact rectangular tile footprint used by interaction checks.
   * Server-side autonomous navigation uses this public, derived view instead
   * of reconstructing collision dimensions from display metadata.
   */
  public getInteractionFootprint(): { width: number; depth: number } {
    const occupiedTiles = this.getOccupiedTiles();
    if (occupiedTiles.length === 0) return { width: 1, depth: 1 };

    let minX = occupiedTiles[0].x;
    let maxX = occupiedTiles[0].x;
    let minZ = occupiedTiles[0].z;
    let maxZ = occupiedTiles[0].z;
    for (let index = 1; index < occupiedTiles.length; index++) {
      const tile = occupiedTiles[index];
      minX = Math.min(minX, tile.x);
      maxX = Math.max(maxX, tile.x);
      minZ = Math.min(minZ, tile.z);
      maxZ = Math.max(maxZ, tile.z);
    }
    return { width: maxX - minX + 1, depth: maxZ - minZ + 1 };
  }
  public getUsesRemaining(): number {
    return this.usesRemaining;
  }
  public getMaxUses(): number {
    return this.maxUses;
  }
  public getRequiredItem(): string | null {
    return this.requiredItem;
  }
  public getConsumesItem(): boolean {
    return this.consumesItem;
  }
}
