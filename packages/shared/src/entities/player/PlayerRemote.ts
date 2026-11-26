/**
 * PlayerRemote - Remote Player Entity
 *
 * Represents other players in the multiplayer world. Displays their avatars
 * and animations based on network state updates from the server.
 *
 * **Key Features**:
 *
 * **Network Interpolation**:
 * - Smoothly interpolates position and rotation between network updates
 * - Uses LerpVector3 and LerpQuaternion for smooth movement
 * - Handles teleportation (instant position changes)
 * - Velocity calculation for animation blending
 *
 * **Visual Representation**:
 * - VRM avatar rendering
 * - Name shown in right-click menu (classic MMORPG pattern)
 * - Chat bubbles for messages
 * - Health bar (if in combat)
 * - Capsule collider visualization (debug mode)
 *
 * **Animation System**:
 * - Idle animation when stationary
 * - Walk/run animations based on velocity
 * - Emote playback (wave, dance, etc.)
 * - Smooth transitions between animations
 *
 * **Chat Bubbles**:
 * - Text bubbles appear above player when they chat
 * - Auto-dismiss after timeout
 * - Wraps long messages
 * - 3D UI that faces the camera
 *
 * **Network State**:
 * - Receives position/rotation updates from server (8Hz typical)
 * - Interpolates between updates for smooth 60fps rendering
 * - Handles player effects (sitting, emotes, etc.)
 * - Synchronizes avatar changes
 *
 * **Lifecycle**:
 * 1. Constructed when another player joins
 * 2. spawn() creates visual representation
 * 3. update() interpolates position and updates animations
 * 4. destroy() cleans up avatar and UI
 *
 * **Runs on**: Client only (browser)
 * **Referenced by**: Entities system (when entityAdded packet received)
 *
 * @public
 */

import type {
  EntityData,
  HotReloadable,
  NetworkData,
  LoadedAvatar,
} from "../../types/index";
import { DeathState } from "../../types/entities/entities";
import {
  Emotes,
  essentialEmotes,
  GATHERING_PRESENTATION_EMOTE_URLS,
} from "../../data/playerEmotes";
import {
  resolveStreamingDuelAttackEmote,
  resolveStreamingDuelLocomotionEmote,
} from "../../data/streamingDuelPresentationEmotes";
import {
  AvatarLOD,
  DEFAULT_AVATAR_URL,
  getAvatarByUrl,
  getAvatarLODForDistanceWithHysteresis,
  getAvatarUrlForLOD,
} from "../../data/avatars";
import type { World } from "../../core/World";
import { createNode } from "../../extras/three/createNode";
import { LerpQuaternion } from "../../extras/animation/LerpQuaternion";
import { LerpVector3 } from "../../extras/animation/LerpVector3";
import THREE from "../../extras/three/three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { Entity } from "../Entity";
import { Avatar, Group, Mesh, UI, UIView, UIText } from "../../nodes";
import { EventType } from "../../types/events";
import type { PlayerEffect, VRMHooks } from "../../types/systems/physics";
import type {
  HealthBars as HealthBarsSystem,
  HealthBarHandle,
} from "../../systems/client/HealthBars";
import { COMBAT_CONSTANTS } from "../../constants/CombatConstants";
import { DISTANCE_CONSTANTS } from "../../constants/GameConstants";
import { ticksToMs } from "../../utils/game/CombatCalculations";
import {
  AnimationLOD,
  ANIMATION_LOD_PRESETS,
  getCameraPosition,
} from "../../utils/rendering/AnimationLOD";
import {
  DistanceFadeController,
  ENTITY_FADE_CONFIGS,
  FadeState,
} from "../../utils/rendering/DistanceFade";
import { UIRenderer } from "../../utils/rendering/UIRenderer";
import { MobInstancedRenderer } from "../../utils/rendering/InstancedMeshManager";
import {
  isStreamPageRoute,
  isStreamingLikeViewport,
} from "../../runtime/clientViewportMode";
import {
  normalizeFishingInteractionPresentationState,
  resolveFishingInteractionBodyEmote,
  resolveFishingInteractionBodyMotionOffsetSeconds,
} from "../../systems/shared/entities/gathering/FishingInteractionPresentation";
import {
  normalizeProcessingInteractionPresentationState,
  resolveProcessingInteractionBodyEmote,
} from "../../types/game/processing-interaction-presentation";
import type {
  MobAnimationState,
  MobInstancedHandle,
  VRMAvatarInstance,
} from "../../types/rendering/nodes";

interface AvatarWithInstance {
  instance: {
    destroy: () => void;
    move: (matrix: THREE.Matrix4) => void;
    update: (delta: number) => void;
    disableRateCheck?: () => void;
    preloadEmote?: (emote: string) => void;
    setEmoteAndWait?: (emote: string, timeoutMs?: number) => Promise<void>;
    setEmote?: (emote: string, startTimeSeconds?: number) => void;
    raw?: VRMAvatarInstance["raw"];
  } | null;
  getHeadToHeight?: () => number;
  setEmote?: (emote: string, startTimeSeconds?: number) => void;
  preloadEmote?: (emote: string) => void;
  setEmoteAndWait?: (emote: string, timeoutMs?: number) => Promise<void>;
  getBoneTransform?: (boneName: string) => THREE.Matrix4 | null;
  deactivate?: () => void;
  emote?: string | null;
}

let capsuleGeometry: THREE.CapsuleGeometry;
{
  const radius = 0.3;
  const inner = 1.2;
  const height = radius + inner + radius;
  capsuleGeometry = new THREE.CapsuleGeometry(radius, inner); // matches PlayerLocal capsule size
  capsuleGeometry.translate(0, height / 2, 0);
}

const PLAYER_IMPOSTOR_DISTANCES = {
  impostorDistance: 80,
  cullDistance: DISTANCE_CONSTANTS.RENDER.PLAYER,
  hysteresis: 5,
} as const;

let _remoteDeathTraceCache: boolean | undefined;
function isRemoteDeathTraceEnabled(): boolean {
  if (_remoteDeathTraceCache !== undefined) return _remoteDeathTraceCache;
  if (typeof window === "undefined") {
    _remoteDeathTraceCache = false;
    return false;
  }
  try {
    _remoteDeathTraceCache =
      new URLSearchParams(window.location.search).get("traceRemoteDeath") ===
      "1";
  } catch {
    _remoteDeathTraceCache = false;
  }
  return _remoteDeathTraceCache;
}

const FALLBACK_AVATAR_RETRY_DELAY_MS = 15_000;
const FALLBACK_PLAYER_PALETTE = [
  0x27f5d2, 0xff5b6d, 0xf7c948, 0x7dd3fc,
] as const;

const REMOTE_EMOTE_URLS: Readonly<Record<string, string>> = Object.freeze({
  idle: Emotes.IDLE,
  walk: Emotes.WALK,
  run: Emotes.RUN,
  float: Emotes.FLOAT,
  fall: Emotes.FALL,
  flip: Emotes.FLIP,
  talk: Emotes.TALK,
  combat: Emotes.COMBAT,
  sword_swing: Emotes.SWORD_SWING,
  "2h_idle": Emotes.TWO_HAND_IDLE,
  "2h_slash": Emotes.TWO_HAND_SLASH,
  range: Emotes.RANGE,
  spell_cast: Emotes.SPELL_CAST,
  ...GATHERING_PRESENTATION_EMOTE_URLS,
  death: Emotes.DEATH,
  squat: Emotes.SQUAT,
  victory: Emotes.VICTORY,
});

function resolveRemoteEmoteUrl(emote?: string, data?: EntityData): string {
  const duelPresentation = data
    ? (resolveStreamingDuelLocomotionEmote(emote, data) ??
      resolveStreamingDuelAttackEmote(emote, data))
    : null;
  if (duelPresentation) return duelPresentation;
  const processing = normalizeProcessingInteractionPresentationState(
    data?.processingInteractionPresentation,
  );
  if (processing?.phase === "working" && processing.skill) {
    const bodyEmote = resolveProcessingInteractionBodyEmote(processing.skill);
    return bodyEmote ? REMOTE_EMOTE_URLS[bodyEmote] : Emotes.IDLE;
  }
  if (!emote) return Emotes.IDLE;
  return emote.startsWith("asset://")
    ? emote
    : (REMOTE_EMOTE_URLS[emote] ?? Emotes.IDLE);
}

function getSynchronizedServerTimeSeconds(world: World): number | null {
  const network = world.network as { getTime?: () => number } | undefined;
  if (typeof network?.getTime !== "function") return null;
  const value = network.getTime();
  return Number.isFinite(value) ? value : null;
}

function resolveRemoteFishingBodyMotionOffset(
  data: EntityData,
  serverEmote: string | undefined,
  currentServerTimeSeconds: number | null,
): { revision: number | null; offsetSeconds: number | null } {
  const state = normalizeFishingInteractionPresentationState(
    data.fishingInteractionPresentation,
  );
  if (!state) return { revision: null, offsetSeconds: null };
  const expectedBodyEmote = state.itemId
    ? resolveFishingInteractionBodyEmote(state.itemId, state.phase)
    : "idle";
  if (
    serverEmote !== expectedBodyEmote ||
    !GATHERING_PRESENTATION_EMOTE_URLS[expectedBodyEmote]
  ) {
    return { revision: state.revision, offsetSeconds: null };
  }
  return {
    revision: state.revision,
    offsetSeconds: resolveFishingInteractionBodyMotionOffsetSeconds(
      state,
      currentServerTimeSeconds,
    ),
  };
}

const fallbackHeadGeometry = new THREE.SphereGeometry(0.28, 16, 16);
const fallbackBeaconGeometry = new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8);
const OWNED_FALLBACK_GEOMETRY_KEY = "__hyperiaOwnedFallbackGeometry";

function cloneFallbackGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
  const clone = geometry.clone();
  // Only dispose geometries that were explicitly cloned for one fallback
  // avatar instance; shared source geometries must remain alive.
  clone.userData[OWNED_FALLBACK_GEOMETRY_KEY] = true;
  return clone;
}

function fallbackPlayerColorSeed(id: string): number {
  let seed = 0;
  for (let index = 0; index < id.length; index += 1) {
    seed = (seed * 31 + id.charCodeAt(index)) >>> 0;
  }
  return seed;
}

export class PlayerRemote extends Entity implements HotReloadable {
  isPlayer: boolean;
  // Explicit non-local flag for tests
  isLocal: boolean = false;
  base!: Group;
  body!: Mesh;
  collider!: Mesh;
  aura!: Group;
  private _healthBarHandle: HealthBarHandle | null = null; // Separate health bar (HealthBars system)
  private _healthBarVisibleUntil: number = 0; // Timestamp when health bar should hide (fallback timer)
  bubble!: UI;
  bubbleBox!: UIView;
  bubbleText!: UIText;
  avatarUrl?: string;
  private avatarLOD: AvatarLOD = AvatarLOD.LOD0;
  avatar?: Avatar;
  lerpPosition: LerpVector3;
  lerpQuaternion: LerpQuaternion;
  teleport: number = 0;
  speaking?: boolean;
  onEffectEnd?: () => void;
  chatTimer?: NodeJS.Timeout;
  destroyed: boolean = false;
  private lastEmote?: string;
  private lastFishingInteractionPresentationRevision?: number;
  private isLoadingAvatar: boolean = false;
  private prevPosition: THREE.Vector3 = new THREE.Vector3();
  public velocity = new THREE.Vector3();
  public enableInterpolation: boolean = false; // Disabled - ensure basic movement works first
  private _tempMatrix1 = new THREE.Matrix4();
  private _tempVector3_1 = new THREE.Vector3();
  // Pre-allocated temps for update/lateUpdate to avoid per-frame allocations
  private _combatQuat = new THREE.Quaternion();
  private _combatAxis = new THREE.Vector3(0, 1, 0);
  private _healthBarMatrix = new THREE.Matrix4();

  // Raycast proxy mesh - added directly to THREE.Scene for fast raycasting
  // This bypasses the Node system and avoids expensive SkinnedMesh raycast
  private raycastProxy: THREE.Mesh | null = null;

  // Combat state for classic fantasy MMORPG-style auto-retaliate
  combat = {
    inCombat: false,
    combatTarget: null as string | null,
  };

  /** Combat level for classic MMORPG-style display and PvP range checks */
  get combatLevel(): number {
    return (this.data.combatLevel as number) || 3; // Default to classic MMORPG minimum
  }

  // Guard to prevent double initialization
  private _initialized: boolean = false;

  /** Animation LOD controller - throttles animation updates for distant players */
  private readonly _animationLOD = new AnimationLOD(
    ANIMATION_LOD_PRESETS.PLAYER,
  );
  /** Track if idle pose has been applied at least once - prevents T-pose at frozen distances */
  private _hasAppliedIdlePose = false;

  /** Distance fade controller - dissolve effect for entities near render distance */
  private _distanceFade: DistanceFadeController | null = null;
  private _fallbackAvatarRoot: THREE.Group | null = null;
  private _nextAvatarRetryAt = 0;

  /** GPU instancing for batched rendering of player avatars */
  private _instancedRenderer: MobInstancedRenderer | null = null;
  private _instancedHandle: MobInstancedHandle | null = null;

  constructor(world: World, data: EntityData, local?: boolean) {
    super(world, data, local);
    this.isPlayer = true;
    this.lerpPosition = new LerpVector3(new THREE.Vector3(), 0);
    this.lerpQuaternion = new LerpQuaternion(new THREE.Quaternion(), 0);
    this.init();
  }

  /**
   * Override initializeVisuals to skip UIRenderer-based UI elements
   * PlayerRemote uses HealthBars system for health bars
   */
  protected initializeVisuals(): void {
    // Skip UIRenderer - we use HealthBars system
    // Do not call super.initializeVisuals()
  }

  async init(): Promise<void> {
    // Prevent double initialization (constructor calls init(), then Entities.add() calls it again)
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    this.base = createNode("group") as Group;
    // Position and rotation are now handled by Entity base class
    // Use entity's position/rotation properties instead of data

    this.body = createNode("rigidbody", { type: "kinematic" }) as Mesh;
    this.body.active = (this.data.effect as PlayerEffect)?.anchorId
      ? false
      : true;
    this.base.add(this.body);
    this.collider = createNode("collider", {
      type: "geometry",
      convex: true,
      geometry: capsuleGeometry,
      layer: "player",
    }) as Mesh;
    this.body.add(this.collider);

    // Create raycast proxy mesh for fast entity detection
    // PERFORMANCE: VRM SkinnedMesh raycast is extremely slow (~700ms) because THREE.js
    // must transform every vertex by bone weights. This simple capsule mesh is instant.
    // The proxy is added directly to THREE.Scene, bypassing the Node system entirely.
    const proxyMaterial = new MeshBasicNodeMaterial();
    proxyMaterial.visible = false; // Invisible but still raycastable
    this.raycastProxy = new THREE.Mesh(capsuleGeometry, proxyMaterial);
    this.raycastProxy.userData = {
      type: "player",
      entityId: this.id,
      name: this.data.name || "Player",
      interactable: true,
    };
    // Add directly to THREE.Scene - bypasses Node.add() validation
    const scene = this.world.stage?.scene;
    if (scene) {
      scene.add(this.raycastProxy);
      // Sync initial position
      this.raycastProxy.position.copy(this.position);
    }

    this.aura = createNode("group") as Group;

    // The broadcast HUD already owns contestant identity and health. Duplicating
    // world-space labels on the canonical stream causes names and health bars to
    // collide with the upper-third scoreboard whenever the camera moves close.
    const showWorldSpaceCombatUi = !isStreamPageRoute();

    // Create nametag sprite floating above the character's head
    if (showWorldSpaceCombatUi) {
      const playerName = (this.data.name as string) || "Player";
      const isAgent = !!(this.data.isAgent as boolean);
      const nameCanvas = UIRenderer.createNameTag(playerName, {
        width: 80,
        height: 13,
        fontSize: 7,
        textColor: isAgent ? "#ffe066" : "#ffffff",
        backgroundColor: "rgba(0, 0, 0, 0.65)",
      });
      this.nameSprite = UIRenderer.createSpriteFromCanvas(nameCanvas, 0.4);
      this.nameSprite.position.set(0, 2.35, 0);
      this.nameSprite.renderOrder = 999;
      if (this.node) {
        this.node.add(this.nameSprite);
      }
    }

    // Register with HealthBars system
    const healthbars = this.world.getSystem?.("healthbars") as
      HealthBarsSystem | undefined;

    if (healthbars && showWorldSpaceCombatUi) {
      const currentHealth = (this.data.health as number) || 100;
      const maxHealth = (this.data.maxHealth as number) || 100;
      this._healthBarHandle = healthbars.add(this.id, currentHealth, maxHealth);
      // Health bar starts hidden (classic fantasy MMORPG pattern: only show during combat)
    }

    this.bubble = createNode("ui", {
      width: 300,
      height: 512,
      pivot: "bottom-center",
      billboard: "full",
      scaler: [3, 30],
      justifyContent: "flex-end",
      alignItems: "center",
      active: false,
    }) as UI;
    this.bubbleBox = createNode("uiview", {
      backgroundColor: "rgba(0, 0, 0, 0.8)",
      borderRadius: 10,
      padding: 10,
    }) as UIView;
    this.bubbleText = createNode("uitext", {
      color: "white",
      fontWeight: 100,
      lineHeight: 1.4,
      fontSize: 16,
    }) as UIText;
    this.bubble.add(this.bubbleBox);
    this.bubbleBox.add(this.bubbleText);
    this.aura?.add(this.bubble);

    this.aura?.activate(this.world);
    this.base.activate(this.world);

    // Note: Group nodes don't have Three.js representations - their children handle their own scene addition
    // The base node is activated separately and manages its own scene presence

    // Base node is used for UI elements (chat bubble)

    // Start avatar loading but don't await it - let it complete asynchronously
    this.applyAvatar();

    this.lerpPosition = new LerpVector3(this.position, this.world.networkRate);
    // IMPORTANT: Use the entity's actual quaternion, not the cloned getter
    this.lerpQuaternion = new LerpQuaternion(
      this.node.quaternion,
      this.world.networkRate,
    );
    this.teleport = 0;

    this.world.setHot(this, true);
    // Initialize previous position for speed-based emote calculation
    this.prevPosition.copy(this.position);
  }

  private getRequestedAvatarUrl(): string {
    return (
      (this.data.sessionAvatar as string) ||
      (this.data.avatar as string) ||
      DEFAULT_AVATAR_URL
    );
  }

  private resolveAvatarLODSelection(
    cameraPosition = getCameraPosition(this.world),
  ): { url: string; lod: AvatarLOD } {
    const requestedUrl = this.getRequestedAvatarUrl();
    const avatar = getAvatarByUrl(requestedUrl);
    if (!avatar) {
      return { url: requestedUrl, lod: AvatarLOD.LOD0 };
    }

    const activeAvatar = this.avatarUrl
      ? getAvatarByUrl(this.avatarUrl)
      : undefined;
    const currentLOD =
      activeAvatar?.id === avatar.id ? this.avatarLOD : AvatarLOD.LOD0;
    if (!cameraPosition) {
      return {
        url: getAvatarUrlForLOD(avatar, currentLOD),
        lod: currentLOD,
      };
    }

    const dx = this.node.position.x - cameraPosition.x;
    const dz = this.node.position.z - cameraPosition.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const lod = getAvatarLODForDistanceWithHysteresis(distance, currentLOD);
    return { url: getAvatarUrlForLOD(avatar, lod), lod };
  }

  async applyAvatar() {
    const selection = this.resolveAvatarLODSelection();
    const avatarUrl = selection.url;

    // Skip if already loading ANY avatar (prevent race conditions)
    if (this.isLoadingAvatar) {
      return;
    }

    // Skip if avatar already loaded (either instanced or individual)
    if (
      this.avatarUrl === avatarUrl &&
      (this.avatar || this._instancedHandle)
    ) {
      return;
    }

    // Skip avatar loading on server (no loader system)
    if (!this.world.loader) {
      return;
    }

    // Set loading flag to prevent duplicate loads
    this.isLoadingAvatar = true;

    let loadSuccess = false;
    let candidateAvatar: Avatar | null = null;
    const previousAvatar = this.avatar;

    const disposeCandidate = () => {
      if (!candidateAvatar || candidateAvatar === this.avatar) return;
      candidateAvatar.deactivate();
      const avatarWithInstance = candidateAvatar as AvatarWithInstance;
      avatarWithInstance.instance?.destroy();
      candidateAvatar = null;
    };

    try {
      // TODO: GPU instanced rendering disabled pending animation fixes
      // The instanced renderer has issues with VRM bone propagation causing T-pose
      // Re-enable once VRM animation retargeting is working correctly
      //
      // Clean up previous instanced handle if switching avatars
      if (this._instancedHandle && this._instancedRenderer) {
        this._instancedRenderer.remove(this._instancedHandle);
        this._instancedHandle = null;
        this._instancedRenderer = null;
      }

      // Load VRM avatar using individual loading (known working path)
      // Retry up to 3 times with exponential backoff for transient network failures
      // (large VRM files ~56MB can fail on first attempt during server startup)
      const MAX_AVATAR_RETRIES = 3;
      let src: LoadedAvatar | null = null;
      for (let attempt = 1; attempt <= MAX_AVATAR_RETRIES; attempt++) {
        try {
          src = (await this.world.loader.load(
            "avatar",
            avatarUrl,
          )) as LoadedAvatar;
          break; // success
        } catch (retryErr) {
          if (attempt < MAX_AVATAR_RETRIES) {
            const delayMs = 2000 * Math.pow(2, attempt - 1);
            console.warn(
              `[PlayerRemote] Avatar fetch attempt ${attempt}/${MAX_AVATAR_RETRIES} failed, retrying in ${delayMs}ms...`,
              retryErr instanceof Error ? retryErr.message : retryErr,
            );
            await new Promise((r) => setTimeout(r, delayMs));
          } else {
            throw retryErr; // exhausted retries, let outer catch handle it
          }
        }
      }
      if (!src) {
        throw new Error("Avatar load returned null after retries");
      }

      // CRITICAL: Pass VRM hooks to toNodes() so VRMFactory applies normalization and rotation
      // This must happen DURING toNodes() call, not after
      const vrmHooks = {
        scene: this.world.stage.scene!, // Non-null assertion - scene must exist for avatar loading
        octree: this.world.stage.octree as VRMHooks["octree"],
        camera: this.world.camera,
        loader: this.world.loader,
      };
      const nodeMap = src.toNodes(vrmHooks);

      const rootNode = nodeMap.get("root");
      if (!rootNode) {
        throw new Error(
          `[PlayerRemote] No root node found in loaded avatar. Available keys: ${Array.from(nodeMap.keys())}`,
        );
      }

      // The avatar node is a child of the root node or in the map directly
      // MATCH PlayerLocal: Simple fallback logic
      const avatarNode = nodeMap.get("avatar") || rootNode;

      // Prepare the replacement completely before touching the currently
      // visible avatar. This keeps distance LOD and bank/loadout swaps atomic.
      const nodeToUse = avatarNode;
      candidateAvatar = nodeToUse as Avatar;

      // Set up the avatar node properly - cast to access internal properties
      interface AvatarNodeInternal {
        ctx: World;
        parent: { matrixWorld: THREE.Matrix4 } | null;
        activate: (world: World) => void;
        mount: () => Promise<void>;
        hooks: VRMHooks;
        position: THREE.Vector3;
      }
      const nodeObj = nodeToUse as Avatar & AvatarNodeInternal;
      nodeObj.ctx = this.world;

      // Assign the VRM hooks to the node (already passed to toNodes above)
      nodeObj.hooks = vrmHooks;

      // Set the parent so the node knows where it belongs in the hierarchy
      // Note: PlayerRemote uses Hyperia Group node (not raw THREE.Group like PlayerLocal)
      // The node system handles matrix updates automatically
      interface NodeWithParent {
        parent?: { matrixWorld: THREE.Matrix4 };
      }
      (nodeObj as NodeWithParent).parent = {
        matrixWorld: this.base.matrixWorld,
      };

      // CRITICAL: Avatar node position should be at origin (0,0,0) (matches PlayerLocal)
      // The instance.move() method will position it at the base's world position
      nodeObj.position.set(0, 0, 0);

      // Activate and mount the avatar node
      nodeObj.activate(this.world);
      await nodeObj.mount();

      // The avatar instance will be managed by the VRM factory
      // Don't add anything to base - the VRM scene is added to world.stage.scene

      // Disable distance-based LOD throttling for smooth animations
      const avatarWithInstance = nodeToUse as unknown as AvatarWithInstance;
      if (!avatarWithInstance.instance) {
        throw new Error(
          `[PlayerRemote] Avatar instance missing for ${avatarUrl}`,
        );
      }
      avatarWithInstance.instance.disableRateCheck?.();

      // Set up positioning
      const headHeight = candidateAvatar.getHeadToHeight()!;
      // Bubble goes at head height for chat

      nodeObj.position.set(0, 0, 0);

      // PERFORMANCE: Disable raycasting on VRM meshes - use raycastProxy instead
      // SkinnedMesh raycast is extremely slow (~700ms) because THREE.js must
      // transform every vertex by bone weights. The capsule proxy mesh is instant.
      const instanceWithRaw = avatarWithInstance.instance as unknown as {
        raw?: { scene?: THREE.Object3D };
      };
      const candidateScene = instanceWithRaw.raw?.scene;
      if (!candidateScene) {
        throw new Error(`[PlayerRemote] Avatar scene missing for ${avatarUrl}`);
      }
      candidateScene.visible = false;
      candidateScene.traverse((child: THREE.Object3D) => {
        child.raycast = () => {}; // No-op raycast
      });

      // Apply the authoritative current emote before reveal. Using idle for
      // every LOD swap creates a visible one-frame combat hitch.
      const deathState = (this.data as { deathState?: DeathState }).deathState;
      const requestedEmote =
        deathState === DeathState.DYING || deathState === DeathState.DEAD
          ? Emotes.DEATH
          : resolveRemoteEmoteUrl(
              ((this.data.emote ?? this.data.e) as string | undefined) ??
                this.lastEmote,
              this.data,
            );
      const requestedServerEmote = (this.data.emote ?? this.data.e) as
        string | undefined;
      const fishingMotion = resolveRemoteFishingBodyMotionOffset(
        this.data,
        requestedServerEmote,
        getSynchronizedServerTimeSeconds(this.world),
      );
      const avatarWithEmote = candidateAvatar as AvatarWithInstance;
      if (avatarWithEmote.instance?.setEmoteAndWait) {
        await avatarWithEmote.instance.setEmoteAndWait(requestedEmote, 3000);
        if (fishingMotion.offsetSeconds !== null && avatarWithEmote.setEmote) {
          avatarWithEmote.setEmote(requestedEmote, fishingMotion.offsetSeconds);
        }
      } else if (avatarWithEmote.setEmote) {
        avatarWithEmote.setEmote(
          requestedEmote,
          fishingMotion.offsetSeconds ?? undefined,
        );
      }

      if (isStreamingLikeViewport() && this.world.graphics?.precompileObject) {
        await this.world.graphics.precompileObject(candidateScene);
      }

      // Pre-warm essential emotes in background to prevent T-pose on first use
      // This is fire-and-forget - doesn't block avatar display
      if (avatarWithEmote.instance?.preloadEmote) {
        for (const emote of essentialEmotes) {
          if (emote !== requestedEmote) {
            avatarWithEmote.instance.preloadEmote(emote);
          }
        }
      }

      // Calculate camera height for spectator mode (same as PlayerLocal)
      interface AvatarWithHeight {
        height?: number;
      }
      const avatarHeight = (candidateAvatar as AvatarWithHeight).height ?? 1.5;
      const camHeight = Math.max(1.2, avatarHeight * 0.9);

      // Position and pose the candidate before the atomic visibility handoff.
      this.base.position.copy(this.node.position);
      this.base.quaternion.copy(this.node.quaternion);
      this.base.updateTransform();
      avatarWithInstance.instance.move(this.base.matrixWorld);
      avatarWithInstance.instance.update(0);

      // If authoritative avatar data or camera distance changed while loading,
      // discard this candidate rather than committing an already-stale LOD.
      const latestSelection = this.resolveAvatarLODSelection();
      if (this.destroyed || latestSelection.url !== avatarUrl) {
        disposeCandidate();
        return;
      }

      // Show the ready replacement before removing the previous scene. This
      // intentionally permits one overlap instant instead of one empty frame.
      candidateScene.visible = true;
      this.disposeHLOD();
      if (previousAvatar) {
        previousAvatar.deactivate();
        (previousAvatar as AvatarWithInstance).instance?.destroy();
      }
      this.clearFallbackAvatar();

      const committedAvatar = candidateAvatar;
      const committedScene = candidateScene;
      this.avatar = committedAvatar;
      this.avatarUrl = avatarUrl;
      this.avatarLOD = selection.lod;
      this.mesh = committedScene;
      this.bubble.position.y = headHeight + 0.2;
      this.lastEmote = requestedEmote;
      this.lastFishingInteractionPresentationRevision =
        fishingMotion.revision ?? undefined;
      this._hasAppliedIdlePose = true;
      this._nextAvatarRetryAt = 0;

      // HLOD uses the selected geometry. Guard the deferred bake callback so
      // an older LOD can never mutate a replacement avatar's scene.
      await this.initHLOD(`vrm_player_${this.id}_${avatarUrl}`, {
        category: "player",
        atlasSize: 512,
        hemisphere: true,
        freezeAnimationAtLOD1: true,
        prepareForBake: async () => {
          if (this.avatar !== committedAvatar || this.mesh !== committedScene) {
            return;
          }
          const savedPosition = committedScene.position.clone();
          const savedQuaternion = committedScene.quaternion.clone();
          committedScene.position.set(0, 0, 0);
          committedScene.quaternion.identity();
          (committedAvatar as AvatarWithInstance).instance?.update(0);
          committedScene.updateMatrixWorld(true);
          Promise.resolve().then(() => {
            if (
              this.avatar !== committedAvatar ||
              this.mesh !== committedScene
            ) {
              return;
            }
            committedScene.position.copy(savedPosition);
            committedScene.quaternion.copy(savedQuaternion);
            committedScene.updateMatrixWorld(true);
          });
        },
      });

      loadSuccess = true;
      candidateAvatar = null;

      // SPECTATOR FIX: Emit PLAYER_AVATAR_READY so camera system can set proper offset
      // This is critical for spectator mode to work correctly
      this.world.emit(EventType.PLAYER_AVATAR_READY, {
        playerId: this.id,
        avatar: this.avatar,
        camHeight: camHeight,
      });
    } catch (error) {
      console.error("[PlayerRemote] Avatar load failed:", error);
      loadSuccess = false;
      disposeCandidate();
      if (!this.avatar) {
        this.ensureFallbackAvatar();
      }
      this._nextAvatarRetryAt = Date.now() + FALLBACK_AVATAR_RETRY_DELAY_MS;
    } finally {
      // Clear loading flag
      this.isLoadingAvatar = false;
      // Emit event so spectators and loading screens can track avatar completion
      this.world.emit(EventType.AVATAR_LOAD_COMPLETE, {
        playerId: this.id,
        success: loadSuccess,
      });
    }
  }

  private clearFallbackAvatar(): void {
    if (!this._fallbackAvatarRoot) {
      return;
    }

    const fallbackRoot = this._fallbackAvatarRoot;
    this._fallbackAvatarRoot = null;
    fallbackRoot.removeFromParent();
    fallbackRoot.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      if (child.geometry.userData[OWNED_FALLBACK_GEOMETRY_KEY] === true) {
        child.geometry.dispose();
      }
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose());
        return;
      }
      child.material.dispose();
    });
    if (this.mesh === fallbackRoot) {
      this.mesh = null;
    }
  }

  private ensureFallbackAvatar(): void {
    if (this._fallbackAvatarRoot) {
      return;
    }

    const colorSeed =
      fallbackPlayerColorSeed(this.id) % FALLBACK_PLAYER_PALETTE.length;
    const primaryColor = new THREE.Color(FALLBACK_PLAYER_PALETTE[colorSeed]);
    const accentColor = new THREE.Color(
      FALLBACK_PLAYER_PALETTE[(colorSeed + 1) % FALLBACK_PLAYER_PALETTE.length],
    );

    const bodyMaterial = new MeshBasicNodeMaterial();
    bodyMaterial.color = primaryColor;
    const headMaterial = new MeshBasicNodeMaterial();
    headMaterial.color = accentColor;

    const body = new THREE.Mesh(
      cloneFallbackGeometry(capsuleGeometry),
      bodyMaterial,
    );
    body.name = `PlayerRemoteFallbackBody_${this.id}`;
    body.scale.setScalar(1.45);

    const head = new THREE.Mesh(
      cloneFallbackGeometry(fallbackHeadGeometry),
      headMaterial,
    );
    head.name = `PlayerRemoteFallbackHead_${this.id}`;
    head.position.y = 2.15;

    const beaconMaterial = new MeshBasicNodeMaterial();
    beaconMaterial.color = accentColor;
    const beacon = new THREE.Mesh(
      cloneFallbackGeometry(fallbackBeaconGeometry),
      beaconMaterial,
    );
    beacon.name = `PlayerRemoteFallbackBeacon_${this.id}`;
    beacon.position.y = 3.05;

    const fallbackRoot = new THREE.Group();
    fallbackRoot.name = `PlayerRemoteFallback_${this.id}`;
    fallbackRoot.add(body);
    fallbackRoot.add(head);
    fallbackRoot.add(beacon);

    const scene = this.world.stage?.scene;
    if (scene) {
      scene.add(fallbackRoot);
    } else {
      this.node.add(fallbackRoot);
    }
    this._fallbackAvatarRoot = fallbackRoot;
    this.mesh = fallbackRoot;
  }

  getAnchorMatrix() {
    const effect = this.data.effect as PlayerEffect | undefined;
    if (effect?.anchorId) {
      return this.world.anchors.get(effect.anchorId);
    }
    return null;
  }

  fixedUpdate(_delta: number): void {
    // Implement fixedUpdate as required by HotReloadable interface
    // This method is called at fixed intervals for physics updates
    // Currently no specific implementation needed
  }

  update(delta: number): void {
    // GPU INSTANCING: Update instanced rendering position/state
    // If using instanced rendering, the renderer handles LOD, culling, and animation
    if (this._instancedHandle && this._instancedRenderer) {
      // Update position from interpolation
      this.node.position.copy(this.position);
      this._instancedRenderer.updateTransform(
        this._instancedHandle,
        this.position,
        this.base.quaternion,
      );

      // Update animation state based on movement
      const speed = this.velocity.length();
      const targetState: MobAnimationState = speed > 0.1 ? "walk" : "idle";
      if (this._instancedHandle.state !== targetState) {
        this._instancedRenderer.updateState(
          this._instancedHandle,
          targetState,
          this.position,
          this.base.quaternion,
        );
      }
      // Instanced renderer handles everything else (LOD, fade, animation)
      // But we still need to sync raycast proxy
      if (this.raycastProxy) {
        this.raycastProxy.position.copy(this.position);
        this.raycastProxy.position.y += 0.8; // capsule center offset
      }
      return;
    }

    // DISTANCE FADE: Apply dissolve effect and cull distant players
    const cameraPos = getCameraPosition(this.world);
    if (
      cameraPos &&
      !this.isLoadingAvatar &&
      !this.destroyed &&
      Date.now() >= this._nextAvatarRetryAt
    ) {
      const desiredAvatar = this.resolveAvatarLODSelection(cameraPos);
      if (desiredAvatar.url !== this.avatarUrl) {
        void this.applyAvatar();
      }
    }
    if (cameraPos) {
      // Initialize DistanceFadeController once we have a node
      if (!this._distanceFade && this.node) {
        this._distanceFade = new DistanceFadeController(
          this.node,
          ENTITY_FADE_CONFIGS.PLAYER,
          true, // Enable shader-based dissolve
        );
      }

      // Update fade and check if culled
      if (this._distanceFade) {
        const fadeResult = this._distanceFade.update(
          cameraPos.x,
          cameraPos.z,
          this.node.position.x,
          this.node.position.z,
        );

        // If culled, hide VRM avatar (which is NOT a child of this.node and
        // therefore not hidden by DistanceFadeController) then skip updates.
        // Without this, VRM stays visible at its last position — causing stale
        // avatar ghosts to accumulate in the duel arena after agents teleport out.
        if (fadeResult.state === FadeState.CULLED) {
          if (this.avatar) {
            const inst = (this.avatar as AvatarWithInstance).instance as
              { raw?: { scene?: THREE.Object3D } } | undefined;
            if (inst?.raw?.scene) {
              inst.raw.scene.visible = false;
            }
          }
          return;
        }
      }
    }

    // Restore VRM visibility when entity re-enters draw range after being culled.
    // The cull path above hides the VRM scene; this re-shows it.
    if (this.avatar) {
      const inst = (this.avatar as AvatarWithInstance).instance as
        { raw?: { scene?: THREE.Object3D } } | undefined;
      if (inst?.raw?.scene && !inst.raw.scene.visible) {
        inst.raw.scene.visible = true;
      }
    }

    // ANIMATION LOD: Calculate distance to camera once for animation throttling
    // This reduces CPU/GPU load for distant players significantly
    const animLODResult = cameraPos
      ? this._animationLOD.updateFromPosition(
          this.node.position.x,
          this.node.position.z,
          cameraPos.x,
          cameraPos.z,
          delta,
        )
      : {
          shouldUpdate: true,
          effectiveDelta: delta,
          lodLevel: 0,
          distanceSq: 0,
          shouldApplyRestPose: false,
        };

    // T-POSE FIX: When entering frozen state (or never applied idle), apply idle pose once
    // This ensures remote players at frozen/culled distances show idle pose instead of T-pose
    const needsIdlePoseApplication =
      animLODResult.shouldApplyRestPose || !this._hasAppliedIdlePose;

    if (needsIdlePoseApplication && this.avatar) {
      type AvatarWithIdlePose = {
        instance?: {
          setEmote?: (emote: string) => void;
          update?: (delta: number) => void;
        };
      };
      const avatarWithInstance = this.avatar as AvatarWithIdlePose;
      if (avatarWithInstance.instance) {
        const instance = avatarWithInstance.instance;
        // Ensure idle emote is set
        if (instance.setEmote) {
          instance.setEmote(Emotes.IDLE);
        }
        // Apply frame 0 to bake idle pose into skeleton
        if (instance.update) {
          instance.update(0);
        }
        this._hasAppliedIdlePose = true;
      }
    }

    const anchor = this.getAnchorMatrix();
    if (!anchor) {
      // Check if TileInterpolator is controlling this entity's position
      // If so, skip our position interpolation to avoid fighting
      const tileControlled = this.data.tileInterpolatorControlled === true;

      if (!tileControlled) {
        // Update lerp values
        this.lerpPosition.update(delta);
        this.lerpQuaternion.update(delta);

        // FORCE APPLY POSITION - no interpolation bullshit
        if (!this.enableInterpolation) {
          // Get the target position directly from lerp.current and apply it
          const targetPos = this.lerpPosition.current;
          if (targetPos) {
            this.base.position.copy(targetPos);
            this.node.position.copy(targetPos);
            this.position.copy(targetPos);
          }

          const targetRot = this.lerpQuaternion.current;
          if (targetRot) {
            this.node.quaternion.copy(targetRot);
            this.base.quaternion.copy(targetRot);
          }
          // CRITICAL: Update base transform AFTER both position and rotation are set
          this.base.updateTransform();
        } else {
          // Use interpolated values
          this.base.position.copy(this.lerpPosition.value);
          this.node.position.copy(this.lerpPosition.value);
          this.position.copy(this.lerpPosition.value);
          this.node.quaternion.copy(this.lerpQuaternion.value);
          this.base.quaternion.copy(this.lerpQuaternion.value);
          // CRITICAL: Update base transform AFTER both position and rotation are set
          this.base.updateTransform();
        }
      } else {
        // AAA ARCHITECTURE: TileInterpolator is Single Source of Truth for transform
        // When TileInterpolator controls this entity, it handles BOTH position AND rotation:
        // - Position: Smooth tile-to-tile interpolation
        // - Rotation: Movement direction when walking, combat rotation when standing still
        //
        // Combat rotation comes via entityModified → ClientNetwork → TileInterpolator.setCombatRotation()
        // TileInterpolator applies rotation to base.quaternion in its update()
        //
        // We just need to sync the transform here - TileInterpolator does the rest.
        this.base.updateTransform();
      }
    }

    // Update node matrices for rendering
    if (this.node) {
      this.node.updateMatrix();
      this.node.updateMatrixWorld(true);
    }

    // Run base client update after transforms are synced
    super.clientUpdate(delta);
    const isAnimatedImpostor = this.animatedHLODState?.isImpostor === true;

    // Retry avatar loading if a previous attempt failed.
    // applyAvatar() is fire-and-forget from init(), so if the initial load
    // fails (e.g., large VRM under memory pressure or concurrent loads),
    // the entity stays invisible with no retry. This safety net re-triggers
    // the load on the next frame.
    if (
      !this.avatar &&
      !this.isLoadingAvatar &&
      !this.destroyed &&
      Date.now() >= this._nextAvatarRetryAt
    ) {
      this.applyAvatar();
    }

    // Update avatar position to follow player
    if (this.avatar && (this.avatar as AvatarWithInstance).instance) {
      const instance = (this.avatar as AvatarWithInstance).instance;
      interface InstanceWithRaw {
        raw?: { scene?: THREE.Object3D };
      }
      const instanceWithRaw = instance as InstanceWithRaw;

      // Directly set the avatar scene position
      if (instanceWithRaw?.raw?.scene) {
        const avatarScene = instanceWithRaw.raw.scene;

        // The VRM scene has matrixAutoUpdate = false, so we need to update matrices manually
        // Create a temporary matrix - consider moving this to a class property for reuse
        const worldMatrix = this._tempMatrix1;
        const tempScale = this._tempVector3_1.set(1, 1, 1);
        worldMatrix.compose(
          this.node.position,
          this.node.quaternion,
          tempScale,
        );

        // Set both matrix and matrixWorld since auto update is disabled
        avatarScene.matrix.copy(worldMatrix);
        avatarScene.matrixWorld.copy(worldMatrix);

        // Debug logging disabled to prevent memory pressure
        // Uncomment for debugging remote avatar movement
        // if (Math.random() < 0.001) {  // 0.1% chance
        //   console.log('[PlayerRemote] Moving avatar:', {
        //     id: this.id,
        //     nodePos: this.node.position.toArray(),
        //     avatarMatrixWorld: avatarScene.matrixWorld.elements.slice(12, 15), // Translation part
        //     matrixAutoUpdate: avatarScene.matrixAutoUpdate
        //   })
        // }
      }

      // CRITICAL: Update avatar position/rotation every frame (matches PlayerLocal)
      // The move() method applies the transform matrix with normalization and rotation
      if (instance && instance.move && this.base) {
        instance.move(this.base.matrixWorld);
      }

      // ANIMATION LOD: Only update avatar animations when LOD allows
      // This significantly reduces CPU/GPU load for distant players
      if (
        instance &&
        instance.update &&
        animLODResult.shouldUpdate &&
        !isAnimatedImpostor
      ) {
        instance.update(animLODResult.effectiveDelta);
      }

      // Post-animation ground clamping - ensures avatar's feet never go below terrain
      // This verifies the final bone positions after animation and adjusts if needed
      const terrain = this.world.getSystem("terrain");
      if (
        terrain &&
        "getHeightAt" in terrain &&
        instance &&
        "clampToGround" in instance
      ) {
        try {
          // Use base.position which should be the world position for remote players
          const terrainHeight = (
            terrain as { getHeightAt: (x: number, z: number) => number }
          ).getHeightAt(this.base.position.x, this.base.position.z);
          if (Number.isFinite(terrainHeight)) {
            const groundAdjustment = (
              instance as { clampToGround: (y: number) => number }
            ).clampToGround(terrainHeight);
            // Store adjustment in VRM instance (NOT position - that would cause camera jitter for spectators)
            // The adjustment will be applied in the next move() call
            const instanceWithAdjust = instance as {
              setGroundAdjustment?: (adj: number) => void;
            };
            if (instanceWithAdjust.setGroundAdjustment) {
              instanceWithAdjust.setGroundAdjustment(groundAdjustment);
            }
          }
        } catch (_err) {
          // Terrain tile not generated yet
        }
      }

      // Safety net: ensure VRM scene is visible when entity is at LOD0.
      // HLOD can set this.mesh.visible = false during camera transitions
      // (e.g., streaming duel camera cuts). If the LOD transitions back to 0
      // but the mesh stays invisible due to an edge case, this restores it.
      if (this.mesh && !isAnimatedImpostor) {
        const lodLevel = this.animatedHLODState?.currentLOD ?? 0;
        if (lodLevel === 0 && !this.mesh.visible) {
          this.mesh.visible = true;
        }
      }
    }

    if (this._fallbackAvatarRoot) {
      this._fallbackAvatarRoot.position.copy(this.node.position);
      this._fallbackAvatarRoot.quaternion.copy(this.node.quaternion);
      this._fallbackAvatarRoot.updateMatrix();
      this._fallbackAvatarRoot.updateMatrixWorld(true);
    }

    // Use server-provided emote state directly - no inference
    // The server/PlayerLocal sends the correct animation state
    let serverEmote = (this.data.emote ?? this.data.e) as string | undefined;

    // AAA QUALITY: Force death emote when player is in DYING state
    // This is a safety net - if deathState is DYING, the animation MUST be death
    // regardless of what serverEmote says (protects against race conditions)
    const currentDeathState = (this.data as { deathState?: DeathState })
      .deathState;
    if (
      currentDeathState === DeathState.DYING ||
      currentDeathState === DeathState.DEAD
    ) {
      if (serverEmote !== "death") {
        if (isRemoteDeathTraceEnabled()) {
          console.debug(
            `[PlayerRemote] FORCING death emote (was "${serverEmote}") because deathState=${currentDeathState} for ${this.id}`,
          );
        }
        serverEmote = "death";
        this.data.emote = "death"; // Also fix the data for consistency
      }
    }

    // DEBUG: Log when death emote is set but we're in update()
    if (serverEmote === "death" && isRemoteDeathTraceEnabled()) {
      console.debug(`[PlayerRemote] update() with death emote:`, {
        id: this.id,
        hasAvatar: !!this.avatar,
        lastEmote: this.lastEmote,
        deathUrl: Emotes.DEATH,
        deathState: currentDeathState,
      });
    }

    if (this.avatar) {
      let desiredUrl: string;

      if (serverEmote) {
        desiredUrl = resolveRemoteEmoteUrl(serverEmote, this.data);
      } else {
        // Default to idle if no emote data
        desiredUrl = Emotes.IDLE;
      }

      const fishingMotion = resolveRemoteFishingBodyMotionOffset(
        this.data,
        serverEmote,
        getSynchronizedServerTimeSeconds(this.world),
      );
      const fishingRevisionChanged =
        fishingMotion.offsetSeconds !== null &&
        fishingMotion.revision !==
          this.lastFishingInteractionPresentationRevision;

      // Update animation if changed
      if (desiredUrl !== this.lastEmote || fishingRevisionChanged) {
        // DEBUG: Log death emote application
        if (
          (serverEmote === "death" || desiredUrl === Emotes.DEATH) &&
          isRemoteDeathTraceEnabled()
        ) {
          console.debug(`[PlayerRemote] update() applying death emote:`, {
            id: this.id,
            serverEmote,
            desiredUrl,
            lastEmote: this.lastEmote,
            hasEmoteProperty: "emote" in this.avatar,
            hasSetEmoteMethod: "setEmote" in this.avatar,
          });
        }
        if (fishingMotion.offsetSeconds !== null && "setEmote" in this.avatar) {
          (this.avatar as Avatar).setEmote(
            desiredUrl,
            fishingMotion.offsetSeconds,
          );
        } else if ("emote" in this.avatar) {
          interface AvatarWithEmote {
            emote?: string | null;
          }
          (this.avatar as AvatarWithEmote).emote = desiredUrl;
        } else if ("setEmote" in this.avatar) {
          (this.avatar as Avatar).setEmote(desiredUrl);
        }
        this.lastEmote = desiredUrl;
      } else if (serverEmote === "death" && isRemoteDeathTraceEnabled()) {
        // DEBUG: Death emote but animation already matches
        console.debug(`[PlayerRemote] update() death emote already applied:`, {
          id: this.id,
          desiredUrl,
          lastEmote: this.lastEmote,
        });
      }
      this.lastFishingInteractionPresentationRevision =
        fishingMotion.revision ?? undefined;
    } else if (serverEmote === "death" && isRemoteDeathTraceEnabled()) {
      // DEBUG: Avatar not available when death emote is set
      console.warn(`[PlayerRemote] update() death emote but NO AVATAR:`, {
        id: this.id,
        emote: this.data.emote,
      });
    }

    // Sync raycast proxy position with player
    if (this.raycastProxy) {
      this.raycastProxy.position.copy(this.position);
    }

    // Update prev position at end of frame
    this.prevPosition.copy(this.position);
  }

  lateUpdate(_delta: number): void {
    const anchor = this.getAnchorMatrix();
    if (anchor) {
      this.lerpPosition.snap();
      this.lerpQuaternion.snap();
      this.position.setFromMatrixPosition(anchor);
      this.rotation.setFromRotationMatrix(anchor);
      this.base.clean();
    }
    if (this.avatar) {
      const matrix = this.avatar.getBoneTransform("head");
      if (matrix) this.aura.position.setFromMatrixPosition(matrix);
    }

    // Update health bar position in HealthBars system
    if (this._healthBarHandle && this.base) {
      // Use pre-allocated matrix to avoid per-frame allocations
      this._healthBarMatrix.copy(this.base.matrixWorld);
      this._healthBarMatrix.elements[13] += 2.0; // Health bar at Y=2.0
      this._healthBarHandle.move(this._healthBarMatrix);
    }

    // Fallback: Hide health bar after combat timeout if server c:false was missed
    // This handles edge cases where network packet is lost or getPlayer() fails on server
    if (this._healthBarHandle && this._healthBarVisibleUntil > 0) {
      if (Date.now() >= this._healthBarVisibleUntil) {
        this._healthBarHandle.hide();
        this._healthBarVisibleUntil = 0;
      }
    }
  }

  postLateUpdate(_delta: number): void {
    // Implement postLateUpdate as required by HotReloadable interface
    // This method is called after all other update methods
    // Currently no specific implementation needed
  }

  setEffect(effect: string, onEnd?: () => void) {
    if (this.data.effect) {
      this.data.effect = undefined;
      this.onEffectEnd?.();
      this.onEffectEnd = undefined;
    }
    this.data.effect = { emote: effect };
    this.onEffectEnd = onEnd;
    // Strong type assumption - effect structure is known
    const hasAnchor = effect && (effect as PlayerEffect).anchorId;
    this.body.active = !hasAnchor;
  }

  setSpeaking(speaking: boolean) {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    // Speaking state tracked - visual indicator could be added to avatar/aura if needed
  }

  override modify(data: Partial<NetworkData>) {
    const previousRequestedAvatarUrl = this.getRequestedAvatarUrl();
    // Strong type assumptions - check properties directly
    if ("t" in data) {
      this.teleport++;
    }
    if (data.p !== undefined) {
      // Check if TileInterpolator is controlling position - if so, skip position updates
      // TileInterpolator handles position smoothly, we don't want to fight it
      const tileControlled = this.data.tileInterpolatorControlled === true;
      if (!tileControlled) {
        // Position is no longer stored in EntityData, apply directly to entity transform
        this.lerpPosition.pushArray(data.p, this.teleport || null);
        // Apply position immediately for responsiveness - assume it's a 3-element array
        const pos = data.p as number[];
        // Update base, node, and position IMMEDIATELY
        this.base.position.set(pos[0], pos[1], pos[2]);
        this.node.position.set(pos[0], pos[1], pos[2]);
        this.position.set(pos[0], pos[1], pos[2]);
        // CRITICAL: Force base to update its matrix so instance.move() gets correct transform
        this.base.updateTransform();
      }

      // Note: PLAYER_TELEPORTED VFX is emitted by ClientNetwork.onPlayerTeleport
      // when the dedicated playerTeleport packet arrives. Do NOT emit here —
      // the entity position may be stale at this point, causing ghost effects.
    }
    if (data.q !== undefined) {
      // AAA ARCHITECTURE: Rotation handling depends on whether TileInterpolator is active
      //
      // When TileInterpolator IS active:
      //   - ClientNetwork routes rotation to TileInterpolator.setCombatRotation()
      //   - data.q will NOT arrive here (stripped from entityModified)
      //   - TileInterpolator applies rotation to base.quaternion
      //
      // When TileInterpolator is NOT active (e.g., entity not in world.entities.players):
      //   - data.q arrives here and is pushed to lerpQuaternion
      //   - update() applies lerpQuaternion to node.quaternion
      //
      // This ensures single source of truth: TileInterpolator when active, lerpQuaternion otherwise.
      this.lerpQuaternion.pushArray(data.q, this.teleport || null);
    }
    if (data.e !== undefined) {
      // AAA QUALITY: Protect death animation from being overwritten
      // When a player is DYING, only allow "death" emote - block all others (especially "idle")
      // This prevents race conditions where scheduled emote resets arrive after death packets
      const currentDeathState = (this.data as { deathState?: DeathState })
        .deathState;
      const isCurrentlyDying =
        currentDeathState === DeathState.DYING ||
        currentDeathState === DeathState.DEAD;

      if (isCurrentlyDying && data.e !== "death") {
        // Player is dying - ignore non-death emote changes but continue processing other data
        // IMPORTANT: Don't return early! Other data (position, etc.) still needs to be processed
        if (isRemoteDeathTraceEnabled()) {
          console.debug(
            `[PlayerRemote] BLOCKED emote change to "${data.e}" during death for ${this.id} (deathState=${currentDeathState})`,
          );
        }
        // Skip emote assignment but continue with rest of modify()
      } else {
        // DEBUG: Log death emote setting
        if (data.e === "death" && isRemoteDeathTraceEnabled()) {
          console.debug(`[PlayerRemote] Setting death emote:`, {
            id: this.id,
            oldEmote: this.data.emote,
            newEmote: data.e,
            hasAvatar: !!this.avatar,
            lastEmote: this.lastEmote,
            deathState: currentDeathState,
          });
        }
        // Keep the compact network alias and the full animation field atomic.
        // Lifecycle rendering checks both values, so updating only `emote`
        // leaves a stale `e: "death"` capable of hiding held equipment after
        // the authoritative respawn has already returned the player to idle.
        this.data.emote = data.e;
        this.data.e = data.e;
      }
    }
    if (data.ef !== undefined) {
      this.setEffect(data.ef as string);
    }
    if (data.name !== undefined) {
      this.data.name = data.name as string;
      // Update nametag sprite if it exists
      if (this.nameSprite) {
        const isAgent = !!(this.data.isAgent as boolean);
        const nameCanvas = UIRenderer.createNameTag(data.name as string, {
          width: 80,
          height: 13,
          fontSize: 7,
          textColor: isAgent ? "#ffe066" : "#ffffff",
          backgroundColor: "rgba(0, 0, 0, 0.65)",
        });
        UIRenderer.updateSpriteTexture(this.nameSprite, nameCanvas);
      }
    }
    if (data.combatLevel !== undefined) {
      this.data.combatLevel = data.combatLevel as number;
      // Combat level stored in data - shown in right-click menu (classic MMORPG pattern)
    }
    if (data.maxHealth !== undefined) {
      this.data.maxHealth = data.maxHealth as number;
    }
    if (data.health !== undefined) {
      const currentHealth = data.health as number;
      const maxHealth = (this.data.maxHealth as number) || 100;

      this.data.health = currentHealth;

      // Update health bar via HealthBars system
      if (this._healthBarHandle) {
        this._healthBarHandle.setHealth(currentHealth, maxHealth);
      }

      this.world.emit(EventType.PLAYER_HEALTH_UPDATED, {
        playerId: this.data.id,
        health: currentHealth,
        maxHealth: maxHealth,
      });
    }
    if (data.avatar !== undefined) {
      this.data.avatar = data.avatar as string;
    }
    if (data.sessionAvatar !== undefined) {
      this.data.sessionAvatar = data.sessionAvatar as string;
    }
    if (data.roles !== undefined) {
      this.data.roles = data.roles as string[];
    }
    if (data.v !== undefined) {
      // Strong type assumption - v is a 3-element array when provided
      const vel = data.v as number[];
      this.velocity.set(vel[0], vel[1], vel[2]);
    }
    // Handle combat state updates for classic fantasy MMORPG-style auto-retaliate rotation
    // Using abbreviated key 'c' for inCombat (network efficiency)
    if ("c" in data) {
      const newInCombat = data.c as boolean;
      this.combat.inCombat = newInCombat;
      // Show/hide health bar via HealthBars system (classic fantasy MMORPG pattern)
      if (this._healthBarHandle) {
        if (newInCombat) {
          // Sync health bar with current entity data before showing.
          // This prevents stale health from a previous duel being displayed
          // when the bar becomes visible, regardless of packet ordering.
          const currentHealth = (this.data.health as number) || 0;
          const maxHealth = (this.data.maxHealth as number) || 100;
          this._healthBarHandle.setHealth(currentHealth, maxHealth);
          // In combat - show health bar and set/extend timeout
          this._healthBarHandle.show();
          this._healthBarVisibleUntil =
            Date.now() + ticksToMs(COMBAT_CONSTANTS.COMBAT_TIMEOUT_TICKS);
        } else {
          // Combat ended - hide and clear timer
          this._healthBarHandle.hide();
          this._healthBarVisibleUntil = 0;
        }
      }
    }
    // Using abbreviated key 'ct' for combatTarget (network efficiency)
    if ("ct" in data) {
      this.combat.combatTarget = data.ct as string | null;
    }
    if (this.getRequestedAvatarUrl() !== previousRequestedAvatarUrl) {
      // A genuinely new authoritative avatar should not inherit the retry
      // fence from a different URL. Duplicate network projections, however,
      // must not bypass backoff after a transport failure.
      this._nextAvatarRetryAt = 0;
      this.applyAvatar();
    }
  }

  chat(msg: string) {
    this.bubbleText.value = msg;
    this.bubble.active = true;
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.chatTimer = setTimeout(() => {
      this.bubble.active = false;
    }, 5000);
  }

  override destroy(_local?: boolean) {
    // Guard uses inherited Entity.destroyed flag
    if (this.destroyed) return;
    // NOTE: Do NOT set this.destroyed = true here!
    // Entity.destroy() sets it, and if we set it first, super.destroy() will
    // immediately return and the node won't be removed from the scene.

    // 1a. Clean up instanced rendering handle
    if (this._instancedHandle && this._instancedRenderer) {
      this._instancedRenderer.remove(this._instancedHandle);
      this._instancedHandle = null;
      this._instancedRenderer = null;
    }

    // 1b. Remove raycast proxy from scene
    if (this.raycastProxy) {
      const scene = this.world.stage?.scene;
      if (scene) {
        scene.remove(this.raycastProxy);
      }
      this.raycastProxy.geometry.dispose();
      (this.raycastProxy.material as THREE.Material).dispose();
      this.raycastProxy = null;
    }

    // 2. Clear timers
    if (this.chatTimer) clearTimeout(this.chatTimer);

    // 3. Clean up distance fade controller
    if (this._distanceFade) {
      this._distanceFade.dispose();
      this._distanceFade = null;
    }

    // 4. Clean up avatar (VRM instance is added directly to world.stage.scene)
    // Must destroy the instance to remove from scene, not just set to undefined
    if (this.avatar) {
      this.avatar.deactivate();
      // Destroy VRM instance to remove from scene
      const avatarWithInstance = this.avatar as AvatarWithInstance;
      if (avatarWithInstance.instance) {
        avatarWithInstance.instance.destroy();
      }
      this.avatar = undefined;
    }
    this.clearFallbackAvatar();

    // 5. Deactivate visual components
    this.base.deactivate();
    this.aura.deactivate();

    // 6. Unregister from hot updates
    this.world.setHot(this, false);

    // 7. Clean up health bar from HealthBars system
    if (this._healthBarHandle) {
      this._healthBarHandle.destroy();
      this._healthBarHandle = null;
    }

    // 8. Call parent destroy to:
    //    - Set destroyed = true
    //    - Remove node from scene
    //    - Dispose mesh/materials
    //    - Clean up physics
    //    - Clean up components
    // Pass false to prevent duplicate entityRemoved broadcast
    // (server already sent it via handleDisconnect, and Entities.remove()
    // is what called us so we don't need to call it again)
    super.destroy(false);
  }

  public toggleInterpolation(enabled: boolean): void {
    this.enableInterpolation = enabled;
  }
}
