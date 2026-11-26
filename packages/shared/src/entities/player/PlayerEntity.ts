/**
 * PlayerEntity - Server-Side Player Entity
 *
 * Represents player characters on the server with full game state.
 * This is the authoritative player representation used for gameplay logic.
 *
 * **Extends**: CombatantEntity (combat-capable entity with health)
 *
 * **Key Features**:
 *
 * **Character Progression**:
 * - Skills and levels (attack, strength, defense, constitution, ranged, etc.)
 * - Experience points (XP) tracking for all skills
 * - Combat level calculation
 * - Stamina system for actions
 *
 * **Inventory & Equipment**:
 * - 28-slot inventory (classic fantasy MMORPG-style)
 * - Equipment slots (weapon, helmet, body, legs, shield, etc.)
 * - Item quantities and metadata
 * - Coins/currency
 *
 * **Combat System**:
 * - Combat style selection (attack, strength, defense, ranged)
 * - Attack bonuses from equipment
 * - Defense bonuses from armor
 * - Prayer system (future)
 * - Special attacks (future)
 *
 * **Player State**:
 * - Position and rotation
 * - Running state
 * - Combat state (in combat, target)
 * - Effects (buffs, debuffs)
 * - Session data
 *
 * **UI Elements**:
 * - Name shown in right-click menu (classic MMORPG pattern)
 * - Health bar (when damaged)
 * - Stamina bar (when depleted)
 * - Combat indicators
 *
 * **Database Persistence**:
 * - Character data saved to PostgreSQL
 * - Inventory persisted on changes
 * - Equipment saved on equip/unequip
 * - Position saved periodically
 *
 * **Network Synchronization**:
 * - State broadcasted to all nearby clients
 * - Position updates at 30 FPS
 * - Equipment changes trigger visual updates
 * - Health changes update UI
 *
 * **Runs on**: Server only
 * **Referenced by**: PlayerSystem, ServerNetwork, CombatSystem
 * **Subclasses**: PlayerLocal (client), PlayerRemote (client)
 *
 * @public
 */

import THREE, { MeshStandardNodeMaterial } from "../../extras/three/three";
import type { World } from "../../core/World";
import type { EntityData, Vector3 } from "../../types";
import type {
  EntityInteractionData,
  PlayerEntityData,
  PlayerCombatStyle,
  PlayerEntityProperties,
} from "../../types/entities";
import type {
  CombatBonuses,
  EquipmentComponent,
  InventoryItem,
  Player,
  PrayerComponent,
  StatsComponent,
} from "../../types/core/core";
import { EntityType, InteractionType, DeathState } from "../../types/entities";
import { clamp } from "../../utils/game/EntityUtils";
import { CombatantEntity, type CombatantConfig } from "../CombatantEntity";

export class PlayerEntity extends CombatantEntity {
  // Player interface data - stored privately
  private playerData: Partial<Player>;

  // Player-specific properties
  public readonly playerId: string;
  public readonly playerName: string;
  public readonly hyperiaPlayerId: string;
  public readonly isAgent: boolean;
  public readonly isEmbeddedAgent: boolean;

  // Player-specific properties for internal use
  private combatStyle: string;
  private isRunning: boolean = false;

  // Player-specific UI elements (healthBar now in Entity)
  private staminaBarUI: THREE.Sprite | null = null;

  // Chat animation - override in subclasses if needed
  chat(_text: string): void {
    // Default implementation - no animation
    // Subclasses like PlayerRemote can override to show chat bubbles
  }

  constructor(world: World, data: EntityData, local?: boolean) {
    // Cast to PlayerEntityData - this is safe because the entity registry ensures
    // player entities only receive PlayerEntityData at runtime
    const playerData = data as PlayerEntityData;

    // Ensure skills field exists with defaults if not provided
    if (!playerData.skills) {
      playerData.skills = {
        attack: { level: 1, xp: 0 },
        strength: { level: 1, xp: 0 },
        defense: { level: 1, xp: 0 },
        constitution: { level: 10, xp: 1154 },
        ranged: { level: 1, xp: 0 },
        magic: { level: 1, xp: 0 },
        prayer: { level: 1, xp: 0 },
        woodcutting: { level: 1, xp: 0 },
        mining: { level: 1, xp: 0 },
        fishing: { level: 1, xp: 0 },
        firemaking: { level: 1, xp: 0 },
        cooking: { level: 1, xp: 0 },
        smithing: { level: 1, xp: 0 },
        agility: { level: 1, xp: 0 },
        crafting: { level: 1, xp: 0 },
        fletching: { level: 1, xp: 0 },
        runecrafting: { level: 1, xp: 0 },
      };
    }

    // Convert PlayerEntityData to CombatantConfig format
    const config: CombatantConfig = {
      id: data.id,
      name: data.name || playerData.playerName,
      type: EntityType.PLAYER,
      position: {
        x: data.position ? data.position[0] : 0,
        y: data.position ? data.position[1] : 0,
        z: data.position ? data.position[2] : 0,
      },
      rotation: data.quaternion
        ? {
            x: data.quaternion[0],
            y: data.quaternion[1],
            z: data.quaternion[2],
            w: data.quaternion[3],
          }
        : { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.TALK,
      interactionDistance: 2,
      description: `Player: ${playerData.playerName || data.name}`,
      model: null,
      properties: {
        // Base entity properties
        // Health should equal constitution level (per user requirement)
        health: {
          current:
            Number.isFinite(playerData.health) && playerData.health > 0
              ? playerData.health
              : playerData.skills?.constitution?.level || 10,
          max:
            Number.isFinite(playerData.maxHealth) && playerData.maxHealth > 0
              ? playerData.maxHealth
              : playerData.skills?.constitution?.level || 10,
        },
        level: playerData.level || 1,

        // Player-specific properties (keeping old names for internal use)
        playerId: playerData.playerId,
        playerName: playerData.playerName || data.name,
        stamina: {
          current: playerData.stamina || 100,
          max: playerData.maxStamina || 100,
        },
        combatStyle: (playerData.combatStyle || "attack") as PlayerCombatStyle,

        // Use minimal component implementations with type assertions
        // These will be properly initialized by the systems that use them
        statsComponent: {
          combatLevel: playerData.level || 1,
          level: playerData.level || 1,
          health: {
            current:
              Number.isFinite(playerData.health) && playerData.health > 0
                ? playerData.health
                : playerData.skills?.constitution?.level || 10,
            max:
              Number.isFinite(playerData.maxHealth) && playerData.maxHealth > 0
                ? playerData.maxHealth
                : playerData.skills?.constitution?.level || 10,
          },
          attack: playerData.skills.attack,
          defense: playerData.skills.defense,
          strength: playerData.skills.strength,
          ranged: playerData.skills.ranged,
          magic: { level: 1, xp: 0 },
          constitution: playerData.skills.constitution,
          prayer: {
            level: playerData.skills.prayer?.level || 1,
            xp: playerData.skills.prayer?.xp || 0,
            points: 1,
            maxPoints: 1,
          },
          woodcutting: playerData.skills.woodcutting,
          mining: playerData.skills.mining,
          fishing: playerData.skills.fishing,
          firemaking: playerData.skills.firemaking,
          cooking: playerData.skills.cooking,
          smithing: playerData.skills.smithing || { level: 1, xp: 0 },
          agility: playerData.skills.agility || { level: 1, xp: 0 },
          crafting: playerData.skills.crafting || { level: 1, xp: 0 },
          fletching: playerData.skills.fletching || { level: 1, xp: 0 },
          runecrafting: playerData.skills.runecrafting || { level: 1, xp: 0 },
          // Placeholder for complex fields - will be initialized by systems
          activePrayers: [] as PrayerComponent,
          equipment: {} as EquipmentComponent,
          equippedSpell: null,
          effects: {
            onSlayerTask: false,
            targetIsDragon: false,
            targetMagicLevel: 1,
          },
          combatBonuses: {} as CombatBonuses,
        } as StatsComponent,

        inventoryComponent: {
          items: [] as InventoryItem[],
          capacity: 30,
          coins: 0,
        },

        equipmentComponent: {
          weapon: null,
          shield: null,
          helmet: null,
          body: null,
          legs: null,
          boots: null,
          gloves: null,
          cape: null,
          amulet: null,
          ring: null,
          arrows: null,
        },

        // Active prayer IDs (manifest-driven)
        prayerComponent: [],

        // Base entity components
        movementComponent: {
          position: { x: 0, y: 0, z: 0 },
          velocity: new THREE.Vector3(0, 0, 0),
          targetPosition: null,
          destination: null,
          speed: 5,
          movementSpeed: 5,
          isMoving: false,
          path: [],
          pathNodes: [],
          currentPathIndex: 0,
          lastMovementTime: 0,
        },

        combatComponent: null, // Will be set properly in parent constructor

        healthComponent: {
          current:
            Number.isFinite(playerData.health) && playerData.health > 0
              ? playerData.health
              : playerData.skills?.constitution?.level || 10,
          max:
            Number.isFinite(playerData.maxHealth) && playerData.maxHealth > 0
              ? playerData.maxHealth
              : playerData.skills?.constitution?.level || 10,
          regenerationRate: 1,
          isDead: false,
        },

        visualComponent: {
          mesh: null,
          nameSprite: null,
          healthSprite: null,
          isVisible: true,
          currentAnimation: null,
          animationTime: 0,
        },
      } as PlayerEntityProperties,
      combat: {
        attack: 15, // Default player attack
        defense: 10, // Default player defense
        attackSpeed: 1.0,
        criticalChance: 0.1,
        combatLevel: playerData.level || 1,
        respawnTime: 0, // Players don't auto-respawn
        aggroRadius: 0, // Players don't have aggro
        attackRange: 1.5,
      },
    };

    super(world, config, local);
    // Ensure type is serialized as string 'player' for client-side entity construction
    this.type = "player";
    (this.data as { type?: string }).type = "player";

    // CRITICAL: Set owner field for network identification
    if (data.owner !== undefined) {
      this.data.owner = data.owner;
    }

    // Also preserve other network/identity fields
    if (data.userId !== undefined) {
      this.data.userId = data.userId;
    }
    if (data.avatar !== undefined) {
      this.data.avatar = data.avatar;
    }
    if (data.sessionAvatar !== undefined) {
      this.data.sessionAvatar = data.sessionAvatar;
    }
    if (data.wallet !== undefined) {
      this.data.wallet = data.wallet;
    }
    // Preserve auto-retaliate preference for client-side access
    const autoRetaliateValue = (data as { autoRetaliate?: boolean })
      .autoRetaliate;
    if (autoRetaliateValue !== undefined) {
      (this.data as { autoRetaliate?: boolean }).autoRetaliate =
        autoRetaliateValue;
    }

    // PlayerEntity converts its input into a CombatantConfig before calling
    // Entity, so extension fields would otherwise be dropped. Keep AI identity
    // on both the instance and serialized data; terrain streaming, networking,
    // and scheduler discovery all rely on these authoritative markers.
    this.isAgent = playerData.isAgent === true;
    this.isEmbeddedAgent = playerData.isEmbeddedAgent === true;
    if (playerData.isAgent !== undefined) {
      this.data.isAgent = playerData.isAgent;
    }
    if (playerData.isEmbeddedAgent !== undefined) {
      this.data.isEmbeddedAgent = playerData.isEmbeddedAgent;
    }

    // Initialize player-specific properties
    this.playerId = playerData.playerId || data.id;
    this.playerName = playerData.playerName || data.name || "Unknown";
    this.hyperiaPlayerId = String(
      playerData.hyperiaPlayerId || playerData.playerId || data.id || "",
    );

    // Initialize Player interface data
    const defaultSkill = { level: 1, xp: 0 };
    this.playerData = {
      // Stamina (player-specific)
      stamina: {
        current: playerData.stamina || 100,
        max: playerData.maxStamina || 100,
      },

      // Skills - default starting skills
      skills: {
        attack: defaultSkill,
        strength: defaultSkill,
        defense: defaultSkill,
        constitution: { level: 10, xp: 0 }, // Higher starting constitution
        ranged: defaultSkill,
        magic: defaultSkill,
        prayer: defaultSkill,
        woodcutting: defaultSkill,
        mining: defaultSkill,
        fishing: defaultSkill,
        firemaking: defaultSkill,
        cooking: defaultSkill,
        smithing: defaultSkill,
        agility: defaultSkill,
        crafting: defaultSkill,
        fletching: defaultSkill,
        runecrafting: defaultSkill,
      },

      // Equipment - initially empty
      equipment: {
        weapon: null,
        shield: null,
        helmet: null,
        body: null,
        legs: null,
        boots: null,
        gloves: null,
        cape: null,
        amulet: null,
        ring: null,
        arrows: null,
      },

      // Coins
      coins: 0,

      // Combat
      combat: {
        combatLevel: playerData.level || 1,
        combatStyle: "attack",
        inCombat: false,
        combatTarget: null,
        autoRetaliate:
          (playerData.autoRetaliate as boolean | undefined) ?? true, // classic MMORPG default: ON, persisted from DB
      },

      // Death system
      death: {
        deathLocation: null,
        respawnTime: 0,
      },

      // Session metadata
      lastAction: null,
      lastSaveTime: Date.now(),
      sessionId: null,
    };

    // Internal properties
    this.combatStyle = playerData.combatStyle || "attack";

    // Add player-specific components

    // Add stamina component (player-specific)
    this.addComponent("stamina", {
      current: this.playerData.stamina!.current,
      max: this.playerData.stamina!.max,
      drainRate: 20.0, // Stamina per second when running
      regenRate: 15.0, // Stamina per second when walking/idle
    });

    // Override combat component with player-specific settings
    const combatComponent = this.getComponent("combat");
    if (combatComponent && combatComponent.data) {
      combatComponent.data.combatStyle = this.combatStyle;
      combatComponent.data.attackCooldown = 2000; // ms between attacks
    }

    // Override health component with player-specific settings
    // Health should equal constitution level (per user requirement)
    const healthComponent = this.getComponent("health");
    const constitutionLevel = playerData.skills.constitution.level;
    const maxHealth =
      Number.isFinite(constitutionLevel) && constitutionLevel > 0
        ? constitutionLevel
        : 10;
    // Constitution owns the maximum pool, while a finite positive persisted
    // value owns the current pool. Requiring current === max here silently
    // healed every partially damaged player during entity hydration.
    const configHealth = this.config.properties?.health?.current;
    const currentHealth =
      Number.isFinite(configHealth) &&
      configHealth !== undefined &&
      configHealth > 0
        ? Math.min(configHealth, maxHealth)
        : maxHealth;

    if (healthComponent && healthComponent.data) {
      healthComponent.data.regenerationRate = 1.0; // HP per second regen out of combat
      // Ensure health is set to constitution level
      const healthData = healthComponent.data as {
        current?: number;
        max?: number;
        regenerationRate?: number;
        isDead?: boolean;
      };
      healthData.current = currentHealth;
      healthData.max = maxHealth;

      // Also update Entity's health properties to match
      this.health = currentHealth;
      this.maxHealth = maxHealth;

      // Update entity data for network sync (critical for initial spawn)
      this.data.health = currentHealth;
      (this.data as { maxHealth?: number }).maxHealth = maxHealth;
    } else {
      // Fallback if health component doesn't exist
      this.health = maxHealth;
      this.maxHealth = maxHealth;

      // Update entity data for network sync (critical for initial spawn)
      this.data.health = maxHealth;
      (this.data as { maxHealth?: number }).maxHealth = maxHealth;
    }

    this.addComponent("movement", {
      isMoving: false,
      isRunning: this.isRunning,
      speed: 3.0, // walking speed
      runSpeed: 6.0,
      destination: null,
      path: [],
    });

    this.addComponent("inventory", {
      items: playerData.inventory || [],
      capacity: 28, // classic fantasy MMORPG-style 28 slots
      coins: 0,
    });

    this.addComponent("equipment", {
      weapon: null,
      shield: null,
      helmet: null,
      body: null,
      legs: null,
      arrows: null, // Required for bow usage per GDD
    });

    this.addComponent("stats", {
      // Combat skills - store FULL SkillData objects for SkillsSystem
      attack: playerData.skills.attack || defaultSkill,
      strength: playerData.skills.strength || defaultSkill,
      defense: playerData.skills.defense || defaultSkill,
      constitution: playerData.skills.constitution || defaultSkill,
      ranged: playerData.skills.ranged || defaultSkill,
      // Non-combat skills
      woodcutting: playerData.skills.woodcutting || defaultSkill,
      mining: playerData.skills.mining || defaultSkill,
      fishing: playerData.skills.fishing || defaultSkill,
      firemaking: playerData.skills.firemaking || defaultSkill,
      cooking: playerData.skills.cooking || defaultSkill,
      smithing: playerData.skills.smithing || defaultSkill,
      agility: playerData.skills.agility || defaultSkill,
      crafting: playerData.skills.crafting || defaultSkill,
      fletching: playerData.skills.fletching || defaultSkill,
      runecrafting: playerData.skills.runecrafting || defaultSkill,
      // Additional stats from StatsComponent interface
      combatLevel: 3, // Will be calculated by skills system
      totalLevel: 9, // Sum of all skill levels
      health: { current: currentHealth, max: maxHealth },
      level: this.config.properties?.level || 1,
      // HP stats for combat level calculation
      hitpoints: {
        level: constitutionLevel,
        xp: playerData.skills.constitution.xp || 0,
        current: currentHealth,
        max: maxHealth,
      },
      prayer: {
        level: playerData.skills.prayer?.level || 1,
        xp: playerData.skills.prayer?.xp || 0,
        points: playerData.skills.prayer?.level || 1, // Points default to level
        maxPoints: playerData.skills.prayer?.level || 1, // Max points equal level
      },
      magic: playerData.skills.magic || defaultSkill,
    });
  }

  /**
   * Get Player interface representation - provides compatibility with Player interface
   */
  public getPlayerData(): Player {
    return {
      // Core identity
      id: this.playerId,
      hyperiaPlayerId: this.hyperiaPlayerId,
      name: this.playerName,

      // Health and status (delegate to Entity properties)
      health: {
        current: this.health,
        max: this.maxHealth,
      },
      alive: this.health > 0,

      // Position (delegate to Entity position)
      position: {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },

      // Player-specific data from playerData
      stamina: this.playerData.stamina!,
      skills: this.playerData.skills!,
      equipment: this.playerData.equipment!,
      coins: this.playerData.coins!,
      combat: this.playerData.combat!,
      death: this.playerData.death!,
      lastAction: this.playerData.lastAction!,
      lastSaveTime: this.playerData.lastSaveTime!,
      sessionId: this.playerData.sessionId!,
    };
  }

  /**
   * Update Player interface data from external Player object
   */
  public updateFromPlayerData(playerData: Partial<Player>): void {
    if (playerData.stamina) {
      this.playerData.stamina = playerData.stamina;
    }
    if (playerData.skills) {
      this.playerData.skills = playerData.skills;
    }
    if (playerData.equipment) {
      this.playerData.equipment = playerData.equipment;
    }
    if (playerData.coins !== undefined) {
      this.playerData.coins = playerData.coins;
    }
    if (playerData.combat) {
      this.playerData.combat = playerData.combat;
    }
    if (playerData.death) {
      this.playerData.death = playerData.death;
    }
    if (playerData.lastAction !== undefined) {
      this.playerData.lastAction = playerData.lastAction;
    }
    if (playerData.lastSaveTime !== undefined) {
      this.playerData.lastSaveTime = playerData.lastSaveTime;
    }
    if (playerData.sessionId !== undefined) {
      this.playerData.sessionId = playerData.sessionId;
    }

    // Update Entity properties for conflicting data
    if (playerData.health) {
      this.setHealth(playerData.health.current);
    }
    if (playerData.position) {
      this.setPosition(playerData.position);
    }
  }

  /**
   * Create the player's visual representation - implements Entity.createMesh
   */
  protected async createMesh(): Promise<void> {
    // Create player capsule geometry (represents the player body)
    const geometry = new THREE.CapsuleGeometry(0.4, 1.2, 4, 8);
    // Use MeshStandardNodeMaterial for WebGPU-native TSL dissolve support
    const material = new MeshStandardNodeMaterial({
      color: 0x4169e1, // Royal blue for player
      emissive: 0x1a3470,
      emissiveIntensity: 0.15,
      roughness: 0.7,
      metalness: 0.1,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.y = 0.8; // Position at feet level

    // PERFORMANCE: Set player mesh to layer 1 (main camera only, not minimap)
    // Minimap only renders terrain and uses 2D dots for entities
    mesh.layers.set(1);

    // Set userData for interaction detection
    mesh.userData = {
      type: "player",
      entityId: this.id,
      name: this.playerName,
      interactable: false, // Players aren't interactable via context menu
      entity: this,
      entityType: EntityType.PLAYER,
      playerId: this.playerId,
    };

    this.mesh = mesh;

    // Add mesh to the entity's node
    this.node.add(this.mesh!);

    // Add mesh component to ECS
    this.addComponent("mesh", {
      mesh: this.mesh,
      geometry: geometry,
      material: material,
      castShadow: true,
      receiveShadow: true,
    });

    // Note: UI creation (name tag, health bar) is now handled by Entity.initializeVisuals()
    // Stamina bar will be created in initializeVisuals override
  }

  /**
   * Override initializeVisuals to add player-specific stamina bar
   */
  protected initializeVisuals(): void {
    // Call parent to create name tag and health bar
    super.initializeVisuals();

    // Create player-specific stamina bar
    this.createStaminaBar();
  }

  /**
   * Create stamina bar UI - player-specific
   */
  private createStaminaBar(): void {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    canvas.width = 200;
    canvas.height = 15;

    this.updateStaminaBarCanvas(canvas, context);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
    });
    const staminaSprite = new THREE.Sprite(material);
    staminaSprite.scale.set(1.5, 0.1, 1);
    staminaSprite.position.set(0, 1.5, 0); // Position below health bar

    this.staminaBarUI = staminaSprite;
    if (this.world.stage.scene) {
      this.world.stage.scene.add(staminaSprite);
    }
  }

  /**
   * Update stamina bar visual representation
   */
  private updateStaminaBarCanvas(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
  ): void {
    const staminaPercent =
      this.playerData.stamina!.current / this.playerData.stamina!.max;

    // Clear canvas
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    context.fillStyle = "rgba(0, 0, 0, 0.8)";
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Stamina bar (blue/green color)
    const barWidth = (canvas.width - 4) * staminaPercent;
    const staminaColor =
      staminaPercent > 0.6
        ? "#60a5fa"
        : staminaPercent > 0.3
          ? "#fbbf24"
          : "#ef4444";
    context.fillStyle = staminaColor;
    context.fillRect(2, 2, barWidth, canvas.height - 4);

    // Border
    context.strokeStyle = "#1e40af"; // Blue border for stamina
    context.lineWidth = 1;
    context.strokeRect(0, 0, canvas.width, canvas.height);
  }

  // Note: Health bar handled by HealthBars system
  // Names shown in right-click context menu only (classic MMORPG pattern)

  // Player-specific methods that can be called by Systems

  /**
   * Set player health - uses Entity's implementation
   */
  public setHealth(health: number): void {
    // Use parent's health management (includes UI updates, events, component updates)
    super.setHealth(health);

    // Note: Player interface health is computed dynamically in getPlayerData()
  }

  /**
   * Set player stamina and update UI
   */
  public setStamina(stamina: number): void {
    this.playerData.stamina!.current = clamp(
      stamina,
      0,
      this.playerData.stamina!.max,
    );

    // Update stamina component
    const staminaComponent = this.getComponent("stamina");
    if (staminaComponent) {
      staminaComponent.data.current = this.playerData.stamina!.current;
    }

    // Update UI if present
    if (this.staminaBarUI) {
      // Strong type assumption - stamina bar is a Sprite with SpriteMaterial
      const spriteMaterial = this.staminaBarUI.material as THREE.SpriteMaterial;
      const canvas = spriteMaterial.map!.image as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      this.updateStaminaBarCanvas(canvas, context);
      spriteMaterial.map!.needsUpdate = true;
    }

    // Emit stamina change event
    this.emit("stamina-changed", {
      playerId: this.playerId,
      stamina: this.playerData.stamina!.current,
      maxStamina: this.playerData.stamina!.max,
    });
  }

  /**
   * Set running state
   */
  public setRunning(running: boolean): void {
    this.isRunning = running;

    // Update movement component
    const movementComponent = this.getComponent("movement");
    if (movementComponent) {
      movementComponent.data.isRunning = running;
    }
  }

  /**
   * Get current player stats for external systems
   */
  public getStats() {
    return {
      id: this.playerId,
      name: this.playerName,
      level: this.level,
      health: {
        current: this.health,
        max: this.maxHealth,
      },
      stamina: this.playerData.stamina!,
      combatStyle: this.combatStyle,
      isRunning: this.isRunning,
      position: {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
    };
  }

  /**
   * Handle player death - override CombatantEntity.die()
   */
  protected die(): void {
    // Call parent die() for basic death handling
    super.die();

    // Player-specific death handling
    // Emit death event for other systems to handle
    this.emit("player-died", {
      playerId: this.playerId,
      position: this.getPosition(),
      inventory: this.getComponent("inventory")?.data,
    });
  }

  /**
   * Respawn player at specified location - override CombatantEntity.respawn()
   */
  public respawn(position?: Vector3, health?: number): void {
    if (position) {
      // Set new position before calling parent respawn
      this.setPosition(position);
    }

    // Call parent respawn for basic respawn handling
    super.respawn();

    // Restore health if specified
    if (health !== undefined) {
      this.setHealth(health);
    }

    // Restore stamina (player-specific)
    this.setStamina(this.playerData.stamina!.max);

    // Emit player-specific respawn event
    this.emit("player-respawned", {
      playerId: this.playerId,
      position: this.getPosition(),
    });
  }

  /**
   * Handle interactions with the player - implements Entity.onInteract
   */
  protected async onInteract(data: EntityInteractionData): Promise<void> {
    // Handle different interaction types
    switch (data.interactionType) {
      case "trade":
        // Emit trade request event
        this.emit("player-trade-request", {
          playerId: this.playerId,
          interactorId: data.playerId,
          position: this.getPosition(),
        });
        break;
      case "challenge":
        // Emit PvP challenge event
        this.emit("player-challenge", {
          challengedPlayerId: this.playerId,
          challengerId: data.playerId,
          position: this.getPosition(),
        });
        break;
      default:
        // Default interaction - examine player
        this.emit("player-examine", {
          playerId: this.playerId,
          examinerPlayerId: data.playerId,
          playerStats: this.getStats(),
        });
        break;
    }
  }

  // ==========================================================================
  // Law of Demeter Helper Methods - Death State Management
  // ==========================================================================

  /**
   * Get the current death state
   * Encapsulates access to entity.data.deathState
   */
  public getDeathState(): DeathState {
    const data = this.data as { deathState?: DeathState };
    return data.deathState ?? DeathState.ALIVE;
  }

  /**
   * Set the death state and mark network dirty
   * Encapsulates modification of entity.data.deathState
   */
  public setDeathState(state: DeathState): void {
    const data = this.data as { deathState?: DeathState };
    data.deathState = state;
    this.markNetworkDirty();
  }

  /**
   * Clear the death position (used after respawn)
   * Encapsulates modification of entity.data.deathPosition and respawnTick
   */
  public clearDeathPosition(): void {
    const data = this.data as {
      deathPosition?: [number, number, number];
      respawnTick?: number;
    };
    data.deathPosition = undefined;
    data.respawnTick = undefined;
    this.markNetworkDirty();
  }

  /**
   * Set the current animation/emote
   * Encapsulates modification of entity.data.e (emote field)
   */
  public setAnimation(animation: string): void {
    const data = this.data as { e?: string };
    data.e = animation;
    this.markNetworkDirty();
  }

  /**
   * Check if the player is currently dead or dying
   */
  public isDeadOrDying(): boolean {
    const state = this.getDeathState();
    return state === DeathState.DYING || state === DeathState.DEAD;
  }

  /**
   * Reset death state to alive (used after duel or respawn)
   * Combines clearing death state, position, and setting idle animation
   */
  public resetDeathState(): void {
    const data = this.data as {
      deathState?: DeathState;
      deathPosition?: [number, number, number];
      respawnTick?: number;
      e?: string;
    };
    data.deathState = DeathState.ALIVE;
    data.deathPosition = undefined;
    data.respawnTick = undefined;
    data.e = "idle";
    this.markNetworkDirty();
  }

  /**
   * Clean up when entity is destroyed - Entity handles most cleanup
   */
  public destroy(): void {
    // Clean up player-specific stamina bar
    if (this.staminaBarUI && this.world.stage.scene) {
      this.world.stage.scene.remove(this.staminaBarUI);
      // NOTE: Don't dispose sprite material or texture - they will be GC'd
      // when the sprite is no longer referenced. Disposing synchronously
      // causes WebGPU texture cache corruption with dual-renderer setup.
      this.staminaBarUI = null;
    }

    // Call parent destroy (handles name tag, health bar, mesh, and standard cleanup)
    super.destroy();
  }
}
