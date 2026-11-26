/**
 * NPCEntity - Non-Player Character Entity
 *
 * Represents friendly NPCs like shopkeepers, bankers, trainers, and quest givers.
 * NPCs provide services to players through dialogue and interaction menus.
 *
 * **Extends**: Entity (not combatant - NPCs cannot be attacked)
 *
 * **Key Features**:
 *
 * **NPC Types**:
 * - **Store**: Sells and buys items (shopkeepers)
 * - **Bank**: Provides item storage (bankers)
 * - **Trainer**: Teaches skills or abilities
 * - **Quest**: Gives quests and rewards
 * - **Dialogue**: General conversation
 *
 * **Interaction System**:
 * - Player clicks NPC to interact
 * - Opens appropriate UI based on NPC type
 * - Dialogue trees (simple or complex)
 * - Service menus (shop, bank, training)
 *
 * **Dialogue**:
 * - Multiple dialogue lines
 * - Context-aware responses
 * - Service advertisements
 * - Quest information
 *
 * **Shop System** (if npcType === 'store'):
 * - Inventory of items to sell
 * - Buy/sell prices
 * - Stock quantities
 * - Purchase restrictions
 *
 * **Banking** (if npcType === 'bank'):
 * - Opens player's bank storage
 * - Deposit/withdraw items
 * - Currency storage
 * - Shared across all bank NPCs
 *
 * **Visual Representation**:
 * - 3D model or humanoid mesh
 * - Name shown in right-click menu (classic MMORPG pattern)
 * - NO health bar (cannot be damaged)
 * - Idle animations
 * - Interaction highlight when in range
 *
 * **Persistence**:
 * - NPCs are defined in world configuration
 * - Position and properties persist
 * - Inventory/stock may regenerate
 *
 * **Runs on**: Server (authoritative), Client (visual + UI)
 * **Referenced by**: NPCSystem, StoreSystem, BankingSystem, InteractionSystem
 *
 * @public
 */

import THREE, {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from "../../extras/three/three";
import type { World } from "../../core/World";
import { Entity } from "../Entity";
import type {
  EntityInteractionData,
  NPCEntityConfig,
} from "../../types/entities";
import type {
  EntityData,
  VRMAvatarInstance,
  LoadedAvatar,
} from "../../types/index";
import { modelCache } from "../../utils/rendering/ModelCache";
import { EventType } from "../../types/events";
import { Emotes } from "../../data/playerEmotes";
import { DISTANCE_CONSTANTS } from "../../constants/GameConstants";
import {
  AnimationLOD,
  getCameraPosition,
} from "../../utils/rendering/AnimationLOD";
import { RAYCAST_PROXY } from "../../systems/client/interaction/constants";

// Re-export types for external use
export type { NPCEntityConfig } from "../../types/entities";

const NPC_IMPOSTOR_DISTANCES = {
  impostorDistance: 50,
  cullDistance: DISTANCE_CONSTANTS.RENDER.NPC,
  hysteresis: 5,
} as const;

// Continue releasing independent owners if a synchronous dispose listener
// throws, then report the first failure. No shared texture/cache is released.
function runNPCCleanup(actions: Array<() => void>): void {
  let failed = false;
  let firstError: unknown;
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

class NPCModelResources {
  private readonly owned = new Set<{ dispose(): void }>();
  private released = false;

  constructor(
    readonly scene: THREE.Object3D,
    ownership: "cached-glb" | "vrm" | "placeholder",
  ) {
    // Snapshot ownership at acquisition, before interaction/effects can change
    // a material reference. Both loaders share geometry; only the VRM factory
    // makes fresh instance materials. SkeletonUtils clones own their skeletons.
    scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (node instanceof THREE.SkinnedMesh) this.owned.add(node.skeleton);
      if (ownership === "placeholder") this.owned.add(node.geometry);
      if (ownership !== "cached-glb") {
        for (const material of Array.isArray(node.material)
          ? node.material
          : [node.material]) {
          this.owned.add(material);
        }
      }
    });
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    const resources = [...this.owned];
    this.owned.clear();
    runNPCCleanup([
      () => this.scene.removeFromParent(),
      ...resources.map((resource) => () => resource.dispose()),
    ]);
  }
}

export class NPCEntity extends Entity {
  public config: NPCEntityConfig;

  // VRM avatar instance (for VRM models with emote support)
  private _avatarInstance: VRMAvatarInstance | null = null;
  private _currentEmote: string | null = null;
  private _modelResources: NPCModelResources | null = null;

  // PERFORMANCE: Raycast proxy mesh for fast entity detection
  // VRM SkinnedMesh raycast is extremely slow (~700-1800ms) because THREE.js
  // must transform every vertex by bone weights. This simple capsule is instant.
  private _raycastProxy: THREE.Mesh | null = null;

  /** Animation LOD controller - throttles animation updates for distant NPCs */
  private readonly _animationLOD = new AnimationLOD({
    fullDistance: 20, // Full 60fps animation within 20m (NPCs need close-up detail)
    halfDistance: 40, // 30fps animation at 20-40m
    quarterDistance: 60, // 15fps animation at 40-60m
    pauseDistance: 90, // No animation beyond 90m (bind pose)
  });

  async init(): Promise<void> {
    await super.init();

    // CRITICAL: Register for update loop (client only - NPCs don't need server updates)
    if (this.world.isClient && !this.destroyed) {
      this.world.setHot(this, true);
    }
  }

  constructor(world: World, config: NPCEntityConfig) {
    super(world, config);
    this.config = {
      ...config,
      dialogueLines: config.dialogueLines || ["Hello there!"],
      services: config.services || [],
      questIds: config.questIds,
    };
    if (config.storeId) {
      this.data.storeId = config.storeId;
    }

    // NPCs don't have health bars - they're not combatants
    // Set health to 0 to prevent health bar creation
    this.health = 0;
    this.maxHealth = 0;
  }

  protected async onInteract(data: EntityInteractionData): Promise<void> {
    const { playerId, interactionType } = data;

    switch (interactionType) {
      case "talk":
        this.handleTalk(playerId);
        break;
      case "trade":
        this.handleTrade(playerId);
        break;
      case "bank":
        this.handleBank(playerId);
        break;
      case "train":
        this.handleTrain(playerId);
        break;
      case "quest":
        this.handleQuest(playerId);
        break;
      default:
        this.handleTalk(playerId);
        break;
    }
  }

  private handleTalk(playerId: string): void {
    // Emit NPC_INTERACTION so DialogueSystem can look up dialogue tree from npcs.json
    this.world.emit(EventType.NPC_INTERACTION, {
      playerId,
      npcId: this.id,
      npc: {
        id: this.config.npcId,
        name: this.config.name,
        type: this.config.npcType,
      },
      npcEntityId: this.id,
    });
  }

  private handleTrade(playerId: string): void {
    if (this.config.npcType !== "store") {
      return;
    }

    // Send store interface request
    this.world.emit(EventType.STORE_OPEN_REQUEST, {
      playerId,
      npcId: this.config.npcId,
      inventory: this.config.inventory || [],
    });
  }

  private handleBank(playerId: string): void {
    if (this.config.npcType !== "bank") {
      return;
    }

    // Send bank interface request
    this.world.emit(EventType.BANK_OPEN_REQUEST, {
      playerId,
      npcId: this.config.npcId,
    });
  }

  private handleTrain(playerId: string): void {
    if (this.config.npcType !== "trainer") {
      return;
    }

    // Send training interface request
    this.world.emit(EventType.NPC_TRAINER_OPEN, {
      playerId,
      npcId: this.config.npcId,
      skillsOffered: this.config.skillsOffered || [],
    });
  }

  private handleQuest(playerId: string): void {
    if (this.config.npcType !== "quest_giver") {
      return;
    }

    // Send quest interface request
    this.world.emit(EventType.NPC_QUEST_OPEN, {
      playerId,
      npcId: this.config.npcId,
      questsAvailable: this.config.questsAvailable || [],
    });
  }

  /**
   * Setup idle animation for NPCs (usually a subtle idle loop)
   * Uses embedded animations if available, otherwise loads from model's animation directory
   */
  private setupIdleAnimation(
    animations: THREE.AnimationClip[],
  ): THREE.AnimationClip | null {
    if (!this.mesh) return null;

    // Find the SkinnedMesh to apply animation to
    let skinnedMesh: THREE.SkinnedMesh | null = null;
    this.mesh.traverse((child) => {
      if (!skinnedMesh && (child as THREE.SkinnedMesh).isSkinnedMesh) {
        skinnedMesh = child as THREE.SkinnedMesh;
      }
    });

    if (!skinnedMesh) {
      // No SkinnedMesh = static model, no animations needed
      return null;
    }

    // Create AnimationMixer
    const mixer = new THREE.AnimationMixer(skinnedMesh);

    // Find idle animation (prioritize "idle" or "standing")
    const idleClip = animations.find(
      (clip) =>
        clip.name.toLowerCase().includes("idle") ||
        clip.name.toLowerCase().includes("standing"),
    );

    const impostorClip = idleClip ?? animations[0] ?? null;

    if (idleClip) {
      // Use embedded idle animation
      const action = mixer.clipAction(idleClip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();

      // Store mixer on entity for update in clientUpdate
      (this as { mixer?: THREE.AnimationMixer }).mixer = mixer;
    } else {
      // No idle animation found in embedded clips
      // Try to load from model's animation directory (same skeleton = compatible)
      (this as { mixer?: THREE.AnimationMixer }).mixer = mixer;
      this.loadModelIdleAnimation(mixer);
    }

    return impostorClip;
  }

  /**
   * Load idle animation from the model's own animation directory
   * This ensures bone name compatibility (same skeleton)
   * Service NPCs (bank, store) should stand still, not walk
   *
   * Note: If no idle animation exists, the NPC stays in bind pose (standing)
   * which is appropriate for service NPCs. This is not an error condition.
   */
  private async loadModelIdleAnimation(
    _mixer: THREE.AnimationMixer,
  ): Promise<void> {
    // Service NPCs (banker, shopkeeper, trainer) should stand still
    // The bind pose of human_rigged.glb is a standing pose which is appropriate
    // We intentionally don't load walk/run animations for service NPCs
    // If an idle animation is needed later, add idle.glb to the model's animations folder
  }

  /**
   * Load VRM model and create avatar instance with emote support
   * This uses the same avatar system as player avatars, enabling proper emote playback
   */
  private async loadVRMModel(): Promise<void> {
    if (!this.world.loader) {
      console.warn(
        `[NPCEntity] ${this.id}: No world.loader available for VRM loading`,
      );
      return;
    }
    if (!this.config.model) {
      console.warn(`[NPCEntity] ${this.id}: No model path configured`);
      return;
    }
    if (!this.world.stage?.scene) {
      console.warn(`[NPCEntity] ${this.id}: No world.stage.scene available`);
      return;
    }

    // Create VRM hooks with scene reference (CRITICAL for visibility!)
    const vrmHooks = {
      scene: this.world.stage.scene,
      octree: this.world.stage?.octree,
      camera: this.world.camera,
      loader: this.world.loader,
    };

    // Load the VRM avatar using the same loader as players
    const src = (await this.world.loader.load(
      "avatar",
      this.config.model,
    )) as LoadedAvatar;

    // The loader result/factory is shared. A retired NPC must not instantiate
    // it: factory.create mounts its own scene and octree item immediately.
    if (this.destroyed) return;

    // Convert to nodes
    const nodeMap = src.toNodes(vrmHooks);
    const avatarNode = nodeMap.get("avatar") || nodeMap.get("root");

    if (!avatarNode) {
      console.warn(
        `[NPCEntity] ${this.id}: No avatar/root node found in VRM for ${this.config.model}`,
      );
      return;
    }

    // Get the factory from the avatar node
    const avatarNodeWithFactory = avatarNode as {
      factory?: {
        create: (matrix: THREE.Matrix4, hooks?: unknown) => VRMAvatarInstance;
      };
    };

    if (!avatarNodeWithFactory?.factory) {
      console.warn(
        `[NPCEntity] ${this.id}: No VRM factory found on avatar node for ${this.config.model}`,
      );
      return;
    }

    // Update our node's transform
    this.node.updateMatrix();
    this.node.updateMatrixWorld(true);

    // Create the VRM instance using the factory
    const instance = avatarNodeWithFactory.factory.create(
      this.node.matrixWorld,
      vrmHooks,
    );
    if (!instance) {
      console.warn(
        `[NPCEntity] ${this.id}: VRM factory.create() returned null for ${this.config.model}`,
      );
      return;
    }
    const instanceScene = instance.raw?.scene;
    const resources = instanceScene
      ? new NPCModelResources(instanceScene, "vrm")
      : null;
    // Scene attachment can synchronously notify listeners which retire this
    // entity before create returns. Only this new instance belongs to us.
    if (this.destroyed) {
      runNPCCleanup([() => instance.destroy(), () => resources?.dispose()]);
      return;
    }
    this._avatarInstance = instance;
    this._modelResources = resources;

    // Set initial emote to idle (service NPCs should stand still)
    this._currentEmote = Emotes.IDLE;
    this._avatarInstance.setEmote(this._currentEmote);

    // Set up userData for interaction detection on the avatar
    // Get the VRM scene from the instance
    const instanceWithRaw = this._avatarInstance as {
      raw?: { scene?: THREE.Object3D };
    };
    if (instanceWithRaw?.raw?.scene) {
      // Set mesh reference for proper entity tracking (required for animation to work)
      this.mesh = instanceWithRaw.raw.scene;
      this.mesh.name = `NPC_VRM_${this.config.npcType}_${this.id}`;

      const userData = {
        type: "npc",
        entityId: this.id,
        npcId: this.config.npcId,
        name: this.config.name,
        interactable: true,
        npcType: this.config.npcType,
        services: this.config.services,
      };
      instanceWithRaw.raw.scene.userData = {
        ...instanceWithRaw.raw.scene.userData,
        ...userData,
      };

      // PERFORMANCE: Set VRM mesh to layer 1 (main camera only, not minimap)
      // Minimap only renders terrain and uses 2D dots for entities
      this.mesh.layers.set(1);
      this.mesh.traverse((child) => {
        child.userData = { ...userData };
        child.layers.set(1);
        // PERFORMANCE: Disable raycasting on VRM meshes - use _raycastProxy instead
        // SkinnedMesh raycast is extremely slow (~700-1800ms) because THREE.js
        // must transform every vertex by bone weights. The capsule proxy is instant.
        child.raycast = () => {};
      });

      // Animated impostor support for VRM NPCs (idle loop)
      // DISABLED: Animated impostor system not ready for agents/player characters
      // this.cleanupAnimatedHLOD();
      // void this.initAnimatedHLODFromEmote(
      //   `npc_${this.config.npcId}`,
      //   Emotes.IDLE,
      //   this._avatarInstance?.raw,
      //   NPC_IMPOSTOR_DISTANCES,
      // );
    }
  }

  /**
   * Update animation mixer each frame (legacy - use updateAnimationsWithDelta for LOD)
   */
  private updateAnimations(deltaTime: number): void {
    this.updateAnimationsWithDelta(deltaTime);
  }

  /**
   * Create invisible raycast proxy for fast click detection
   *
   * PERFORMANCE: VRM SkinnedMesh raycast is extremely slow (~700-1800ms) because
   * THREE.js must transform every vertex by bone weights. This simple capsule
   * mesh is added directly to THREE.Scene and provides instant raycast response.
   */
  private createRaycastProxy(): void {
    if (this.destroyed || this._raycastProxy) return;

    const scene = this.world.stage?.scene;
    if (!scene) return;

    // Create capsule geometry sized for humanoid NPC
    const geometry = new THREE.CapsuleGeometry(
      RAYCAST_PROXY.BASE_RADIUS,
      RAYCAST_PROXY.BASE_HEIGHT,
      RAYCAST_PROXY.CAP_SEGMENTS,
      RAYCAST_PROXY.HEIGHT_SEGMENTS,
    );
    // WebGPU-compatible invisible material for raycasting
    const material = new MeshBasicNodeMaterial();
    material.visible = false; // Invisible but raycastable

    this._raycastProxy = new THREE.Mesh(geometry, material);
    this._raycastProxy.name = `NPC_RaycastProxy_${this.config.npcType}_${this.id}`;

    // CRITICAL: Set userData for click detection (matches VRM/GLB userData)
    this._raycastProxy.userData = {
      type: "npc",
      entityId: this.id,
      npcId: this.config.npcId,
      name: this.config.name,
      interactable: true,
      npcType: this.config.npcType,
      services: this.config.services,
    };

    // Set to layer 1 (main camera only, not minimap)
    this._raycastProxy.layers.set(1);

    // Add directly to THREE.Scene (bypasses Node system for performance)
    scene.add(this._raycastProxy);
    if (this.destroyed) return;

    // Sync initial position
    this._raycastProxy.position.copy(this.node.position);
    this._raycastProxy.position.y += RAYCAST_PROXY.Y_OFFSET;
  }

  protected async createMesh(): Promise<void> {
    if (this.destroyed || this.world.isServer) {
      return;
    }

    // PERFORMANCE: Create invisible raycast proxy FIRST for instant click detection
    // This bypasses expensive VRM SkinnedMesh raycast (~700-1800ms per click)
    this.createRaycastProxy();
    if (this.destroyed) return;

    // Try to load 3D model if available
    if (this.config.model && this.world.loader) {
      try {
        // Check if this is a VRM file (uses Avatar system with emote support)
        if (this.config.model.endsWith(".vrm")) {
          // Load VRM via avatar system - this handles emote retargeting
          await this.loadVRMModel();
          return;
        }

        // GLB model - load directly
        const { scene, animations } = await modelCache.loadModel(
          this.config.model,
          this.world,
        );
        const resources = new NPCModelResources(scene, "cached-glb");

        if (this.destroyed) {
          resources.dispose();
          return;
        }

        this._modelResources = resources;
        this.mesh = scene;
        this.mesh.name = `NPC_${this.config.npcType}_${this.id}`;

        // GLB models: Don't manually scale - it breaks skeleton/animations
        // The model should be exported at the correct scale
        this.mesh.scale.set(1, 1, 1);
        this.mesh.updateMatrix();
        this.mesh.updateMatrixWorld(true);

        // NOW bind the skeleton at the scaled size and set layer for minimap exclusion
        this.mesh.layers.set(1); // Main camera only, not minimap
        this.mesh.traverse((child) => {
          // PERFORMANCE: Set all children to layer 1 (minimap only sees layer 0)
          child.layers.set(1);

          if (child instanceof THREE.SkinnedMesh && child.skeleton) {
            // Ensure mesh matrix is updated
            child.updateMatrix();
            child.updateMatrixWorld(true);

            // Bind skeleton with DetachedBindMode (like VRM)
            child.bindMode = THREE.DetachedBindMode;
            child.bindMatrix.copy(child.matrixWorld);
            child.bindMatrixInverse.copy(child.bindMatrix).invert();
          }
        });

        // Set up userData for interaction detection (raycasting)
        // CRITICAL: Set on root AND all children so raycast hits work
        // npcId is the manifest ID (e.g., "bank_clerk"), entityId is the instance ID
        const userData = {
          type: "npc",
          entityId: this.id,
          npcId: this.config.npcId, // Manifest ID for dialogue lookup
          name: this.config.name,
          interactable: true,
          npcType: this.config.npcType,
          services: this.config.services,
        };
        this.mesh.userData = userData;
        this.mesh.traverse((child) => {
          child.userData = { ...userData };
          // PERFORMANCE: Disable raycasting on GLB meshes - use _raycastProxy instead
          child.raycast = () => {};
        });

        // Add as child of node (standard approach with correct scale)
        // Position is relative to node, so keep it at origin
        this.mesh.position.set(0, 0, 0);
        this.mesh.quaternion.identity();
        this.node.add(this.mesh);
        if (this.destroyed) return;

        // Setup animations if available (NPCs usually have idle animations)
        let impostorClip: THREE.AnimationClip | null = null;
        if (animations.length > 0) {
          impostorClip = this.setupIdleAnimation(animations);
        }

        const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
        if (this.mesh && mixer && impostorClip) {
          // DISABLED: Animated impostor system not ready for agents/player characters
          // this.cleanupAnimatedHLOD();
          // const bakeSource = this.cloneForAnimatedImpostor(this.mesh);
          // const bakeMixer = this.createImpostorMixer(bakeSource);
          // void this.initAnimatedHLOD(
          //   `npc_${this.config.npcId}`,
          //   bakeMixer,
          //   impostorClip,
          //   bakeSource,
          //   NPC_IMPOSTOR_DISTANCES,
          // );
        }

        return;
      } catch (error) {
        // A synchronous setup/attachment failure after acquisition must not
        // leave the old clone mounted behind its fallback or mixer retained.
        this.takeModelCleanup()();
        // A rejected pending load must not resurrect a retired placeholder.
        if (this.destroyed) return;
        console.warn(
          `[NPCEntity] Failed to load model for ${this.config.npcType}, using placeholder:`,
          error,
        );
        // Fall through to placeholder
      }
    }

    const geometry = new THREE.CapsuleGeometry(0.35, 1.4, 4, 8);
    // Use MeshStandardNodeMaterial for proper WebGPU lighting (responds to sun, moon, and environment maps)
    const material = new MeshStandardNodeMaterial();
    material.color = new THREE.Color(0x6b4423);
    material.roughness = 0.8;
    material.metalness = 0.0;
    this.mesh = new THREE.Mesh(geometry, material);
    this._modelResources = new NPCModelResources(this.mesh, "placeholder");
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = `NPC_${this.config.npcType}_${this.id}`;

    // PERFORMANCE: Set placeholder to layer 1 (main camera only, not minimap)
    this.mesh.layers.set(1);

    // CRITICAL: Set userData for interaction detection (raycasting)
    // npcId is the manifest ID (e.g., "bank_clerk"), entityId is the instance ID
    this.mesh.userData = {
      type: "npc",
      entityId: this.id,
      npcId: this.config.npcId, // Manifest ID for dialogue lookup
      name: this.config.name,
      interactable: true,
      npcType: this.config.npcType,
      services: this.config.services,
    };

    this.mesh.scale.set(1, 2, 1);

    if (this.mesh instanceof THREE.Mesh && this.mesh.material) {
      if (this.mesh.material instanceof THREE.MeshStandardMaterial) {
        const meshMaterial = this.mesh.material;
        switch (this.config.npcType) {
          case "bank":
            meshMaterial.color.setHex(0x00ff00);
            break;
          case "store":
            meshMaterial.color.setHex(0x0000ff);
            break;
          case "quest_giver":
            meshMaterial.color.setHex(0xffff00);
            break;
          case "trainer":
            meshMaterial.color.setHex(0xff00ff);
            break;
          default:
            meshMaterial.color.setHex(0xffffff);
            break;
        }
      }
    }

    if (this.mesh) {
      this.node.add(this.mesh);
    }
  }

  /**
   * Update animations on client side
   */
  protected clientUpdate(deltaTime: number): void {
    super.clientUpdate(deltaTime);

    // PERFORMANCE: Sync raycast proxy position with NPC
    if (this._raycastProxy) {
      this._raycastProxy.position.copy(this.node.position);
      this._raycastProxy.position.y += RAYCAST_PROXY.Y_OFFSET;
    }

    // ANIMATION LOD: Calculate distance to camera once and throttle animation updates
    // This reduces CPU/GPU load for distant NPCs significantly
    const cameraPos = getCameraPosition(this.world);
    const animLODResult = cameraPos
      ? this._animationLOD.updateFromPosition(
          this.node.position.x,
          this.node.position.z,
          cameraPos.x,
          cameraPos.z,
          deltaTime,
        )
      : {
          shouldUpdate: true,
          effectiveDelta: deltaTime,
          lodLevel: 0,
          distanceSq: 0,
        };
    const isAnimatedImpostor = this.animatedHLODState?.isImpostor === true;

    // VRM avatar path: Update avatar instance
    if (this._avatarInstance) {
      // Update avatar position to follow node (always, for proper positioning)
      this._avatarInstance.move(this.node.matrixWorld);

      // ANIMATION LOD: Only update VRM animation when LOD allows
      if (!isAnimatedImpostor && animLODResult.shouldUpdate) {
        this._avatarInstance.update(animLODResult.effectiveDelta);
      }
      return;
    }

    // GLB mesh path: Update animation mixer (only when LOD allows)
    if (!isAnimatedImpostor && animLODResult.shouldUpdate) {
      this.updateAnimationsWithDelta(animLODResult.effectiveDelta);
    }
  }

  /**
   * Update animations with specified delta time (for LOD-throttled updates)
   */
  private updateAnimationsWithDelta(deltaTime: number): void {
    const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
    if (mixer) {
      mixer.update(deltaTime);

      // CRITICAL: Update skeleton (exactly like VRM does!)
      if (this.mesh) {
        this.mesh.traverse((child) => {
          if (child instanceof THREE.SkinnedMesh && child.skeleton) {
            child.skeleton.bones.forEach((bone) => bone.updateMatrixWorld());
          }
        });
      }
    }
  }

  // PERF: Mutates buffer in-place instead of creating new objects
  public getNetworkData(): Record<string, unknown> {
    const buf = super.getNetworkData();
    buf.model = this.config.model;
    buf.npcType = this.config.npcType;
    buf.npcId = this.config.npcId;
    buf.storeId = this.config.storeId;
    buf.services = this.config.services;
    buf.questIds = this.config.questIds;
    return buf;
  }

  // Override serialize to include NPC-specific fields for network transmission
  public override serialize(): EntityData {
    const base = super.serialize();
    return {
      ...base,
      model: this.config.model,
      npcType: this.config.npcType,
      npcId: this.config.npcId,
      storeId: this.config.storeId,
      services: this.config.services,
      questIds: this.config.questIds,
    };
  }

  public addService(service: string): void {
    if (!this.world.isServer) return;

    if (!this.config.services.includes(service)) {
      this.config.services.push(service);
      this.markNetworkDirty();
    }
  }

  public removeService(service: string): void {
    if (!this.world.isServer) return;

    const index = this.config.services.indexOf(service);
    if (index > -1) {
      this.config.services.splice(index, 1);
      this.markNetworkDirty();
    }
  }

  public updateInventory(inventory: NPCEntityConfig["inventory"]): void {
    if (!this.world.isServer) return;

    this.config.inventory = inventory;
    this.markNetworkDirty();
  }

  /**
   * Relinquish references before callbacks can reenter destruction. The base
   * Entity teardown must never receive a borrowed loader/cache geometry.
   */
  private takeModelCleanup(): () => void {
    const avatar = this._avatarInstance;
    const resources = this._modelResources;
    const mixer = (this as { mixer?: THREE.AnimationMixer }).mixer;
    this._avatarInstance = null;
    this._currentEmote = null;
    this._modelResources = null;
    (this as { mixer?: THREE.AnimationMixer }).mixer = undefined;
    if (resources && this.mesh === resources.scene) this.mesh = null;
    return () =>
      runNPCCleanup([
        () => mixer?.stopAllAction(),
        () => {
          if (mixer) mixer.uncacheRoot(mixer.getRoot());
        },
        () => avatar?.destroy(),
        () => resources?.dispose(),
      ]);
  }

  /** Override destroy to release only this NPC's render resources. */
  override destroy(): void {
    this.world.setHot(this, false);
    if (this.destroyed) return;
    const releaseModel = this.takeModelCleanup();
    const proxy = this._raycastProxy;
    this._raycastProxy = null;
    runNPCCleanup([
      // Sets destroyed before any disposal callbacks, and cleans normal entity
      // ownership. takeModelCleanup excluded the loader-owned mesh above.
      () => super.destroy(),
      releaseModel,
      () => proxy?.removeFromParent(),
      () => proxy?.geometry.dispose(),
      () => {
        if (proxy) (proxy.material as THREE.Material).dispose();
      },
    ]);
  }
}
