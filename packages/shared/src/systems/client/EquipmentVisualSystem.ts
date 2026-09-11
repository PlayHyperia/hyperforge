/**
 * Equipment Visual System (Client-Only)
 *
 * Handles visual rendering of equipped items on player avatars using VRM bones.
 * Works with weapons exported from Asset Forge with pre-baked attachment data.
 *
 * **How It Works:**
 * 1. Listens for PLAYER_EQUIPMENT_CHANGED events
 * 2. Loads weapon GLB from Asset Forge (with userData.hyperia metadata)
 * 3. Attaches weapon to VRM bone specified in metadata
 * 4. Transforms are pre-baked - just attach directly!
 *
 * **Asset Forge Integration:**
 * - Weapons fitted in Asset Forge Equipment Page
 * - Exported with VRM bone attachment data
 * - Position/rotation already baked into GLB hierarchy
 * - See: /packages/asset-forge/WEAPON_FITTING_GUIDE.md
 */

import { GLTFLoader } from "../../libs/gltfloader/GLTFLoader";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import * as THREE from "three";
import { EventType } from "../../types/events";
import { SystemBase } from "../shared/infrastructure/SystemBase";
import type { World } from "../../types";
import type { VRM } from "@pixiv/three-vrm";
import { EQUIPMENT_SLOT_NAMES } from "../../constants/EquipmentConstants";
import type { Entity } from "../../entities/Entity";
import { AttackType } from "../../types/game/item-types";
import { getItem } from "../../data/items";
import { getAvatarByUrl } from "../../data/avatars";
import {
  attachEquipmentVisualToVRM,
  cloneEquipmentVisualModel,
  createDynamicBowStringController,
  createStableHeldEquipmentPoseController,
  createTwoHandEquipmentGripController,
  disposeEquipmentVisualMaterials,
  extractEquipmentAttachmentData,
  extractFishingWorldVisualPlacement,
  removeEquipmentVisual,
  resolveEquipmentVisualData,
  resolveEquipmentVisualUrls,
  shouldRenderHeldEquipmentVisual,
  validateStreamingEquipmentVisualModel,
  type EquipmentVisualModelData,
  type EquipmentVisualStore,
  type DynamicBowStringController,
  type DynamicBowStringTransition,
  type StableHeldEquipmentPoseController,
  type TwoHandEquipmentGripController,
} from "./EquipmentVisualHelpers";
import { isStreamingLikeViewport } from "../../runtime/clientViewportMode";
import {
  NeutralShortsWearState,
  requestsNeutralShortsReplacement,
} from "./NeutralShortsWearState";
import {
  FISHING_INTERACTION_PHASE_DURATION_SECONDS,
  FISHING_WORLD_INTERACTION_BODY_MOTION_DURATION_SECONDS,
  FISHING_WORLD_TRANSFER_TIMING,
  normalizeFishingInteractionPresentationState,
  type FishingInteractionPresentationState,
} from "../shared/entities/gathering/FishingInteractionPresentation";
import {
  normalizeProcessingInteractionPresentationState,
  resolveProcessingInteractionBodyEmote,
  type ProcessingInteractionPresentationState,
} from "../../types/game/processing-interaction-presentation";

export const STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOTS = Object.freeze([
  "weapon",
  "shield",
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
] as const);

export type StreamingDuelVisibleEquipmentSlot =
  (typeof STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOTS)[number];

/**
 * These competitive slots are deliberately represented outside the avatar
 * mesh contract. Ammunition is rendered by the authoritative projectile path;
 * jewellery remains exact in the public loadout UI but is below the approved
 * broadcast-camera readability threshold.
 */
export const STREAMING_DUEL_INTENTIONALLY_INVISIBLE_EQUIPMENT_SLOTS =
  Object.freeze({
    arrows: "authoritative_projectile_visual",
    amulet: "public_loadout_disclosure_only",
    ring: "public_loadout_disclosure_only",
  } as const);

export interface StreamingDuelEquipmentVisualRequirement {
  playerId: string;
  itemId: string;
  slot: StreamingDuelVisibleEquipmentSlot;
}

export interface StreamingDuelEquipmentVisualExpectation {
  playerId: string;
  itemId: string | null;
  slot: StreamingDuelVisibleEquipmentSlot;
}

export interface StreamingDuelEquipmentVisualContract {
  cycleId: string;
  requirements: StreamingDuelEquipmentVisualRequirement[];
  currentEquipment: StreamingDuelEquipmentVisualExpectation[];
}

export type StreamingDuelEquipmentVisualLoadStatus =
  | "loading"
  | "ready"
  | "missing_model"
  | "invalid_model"
  | "load_failed"
  | "avatar_unavailable"
  | "unapproved_avatar"
  | "incompatible_avatar";

export interface StreamingDuelEquipmentVisualReadiness {
  configured: boolean;
  ready: boolean;
  cycleId: string | null;
  requiredCount: number;
  requiredPlayerCount: number;
  readyCount: number;
  expectedPlayerCount: number;
  /** Exact currently equipped visible-slot meshes expected on contestants. */
  activeVisualCount: number;
  /** Active meshes whose complete Object3D hierarchy is visible. */
  activeVisibleCount: number;
  /** Contestants with at least one currently equipped visible-slot mesh. */
  activePlayerCount: number;
  /** Active contestants for whom every current mesh is visible. */
  activeVisiblePlayerCount: number;
  unresolved: Array<
    StreamingDuelEquipmentVisualRequirement & {
      status: StreamingDuelEquipmentVisualLoadStatus;
    }
  >;
  attachmentMismatches: Array<
    StreamingDuelEquipmentVisualExpectation & {
      desiredItemId: string | null;
      attachedItemId: string | null;
    }
  >;
}

export interface StreamingPreparationVisualPlayerDiagnostics {
  playerId: string;
  presentationActive: boolean;
  gatheringToolItemId: string | null;
  fishingPhase: FishingInteractionPresentationState["phase"] | null;
  desiredItemId: string | null;
  attachedItemId: string | null;
  heldVisualPresent: boolean;
  heldVisualVisible: boolean;
  worldVisualPresent: boolean;
  worldVisualVisible: boolean;
  attachedToCurrentAvatar: boolean;
  gatheringRevision: number | null;
  fishingRevision: number | null;
  processingSkill?: ProcessingInteractionPresentationState["skill"];
  processingPhase?: ProcessingInteractionPresentationState["phase"] | null;
  processingRevision?: number | null;
  processingTargetPosition?: ProcessingInteractionPresentationState["targetPosition"];
  processingBodyEmote?: "squat" | null;
  processingBodyMotionReady?: boolean;
  processingTargetReady?: boolean;
  ready: boolean;
}

export interface StreamingPreparationVisualDiagnostics {
  schemaVersion: 1;
  updatedAt: number;
  activeCount: number;
  readyCount: number;
  ready: boolean;
  players: StreamingPreparationVisualPlayerDiagnostics[];
}

function isVisibleInObjectHierarchy(
  object: THREE.Object3D | undefined,
): boolean {
  if (!object) return false;
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.visible === false) return false;
    current = current.parent;
  }
  return true;
}

export interface StreamingDuelBowTransitionEvent {
  sequence: number;
  playerId: string;
  itemId: string | null;
  kind: DynamicBowStringTransition["kind"];
  performanceTimeMs: number;
  releaseAtPerformanceTimeMs: number | null;
  networkEventId: string | null;
  lastVisibleNockWorldPosition: [number, number, number] | null;
  drawHandWorldPosition: [number, number, number] | null;
}

export interface StreamingDuelBowPresentationDiagnostics {
  schemaVersion: 1;
  updatedAt: number;
  performanceTimeMs: number;
  latestSequence: number;
  players: Array<{
    playerId: string;
    itemId: string | null;
    controllerReady: boolean;
    nockedArrowVisible: boolean;
    nockedArrowWorldPosition: [number, number, number] | null;
  }>;
  recentTransitions: StreamingDuelBowTransitionEvent[];
}

type StreamingVisualRequirementState =
  StreamingDuelEquipmentVisualRequirement & {
    status: StreamingDuelEquipmentVisualLoadStatus;
  };

const STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOT_SET = new Set<string>(
  STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOTS,
);
const STREAMING_ASSET_BASE_READY_TIMEOUT_MS = 15_000;

export function isStreamingDuelVisibleEquipmentSlot(
  slot: string,
): slot is StreamingDuelVisibleEquipmentSlot {
  return STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOT_SET.has(slot.toLowerCase());
}

/**
 * Transient gathering tools are not part of the frozen duel-loadout contract,
 * but a streaming client must still reject a tool fitted to the wrong avatar.
 */
export function isStreamingDuelCertifiedEquipmentSlot(slot: string): boolean {
  return (
    isStreamingDuelVisibleEquipmentSlot(slot) ||
    slot.toLowerCase() === "gatheringtool"
  );
}

function streamingVisualRequirementKey(
  requirement: StreamingDuelEquipmentVisualRequirement,
): string {
  return `${requirement.playerId}\u0000${requirement.slot}\u0000${requirement.itemId}`;
}

interface AvatarLike {
  instance?: {
    raw?: {
      userData?: {
        vrm?: VRM;
      };
      scene?: THREE.Object3D;
    };
  } | null;
}

interface PlayerWithAvatar extends Entity {
  /** PlayerLocal exposes VRM via _avatar getter */
  _avatar?: AvatarLike;
  /** PlayerRemote stores VRM in avatar property */
  avatar?: AvatarLike;
  avatarUrl?: string;
  data: Entity["data"] & { avatar?: unknown };
}

/** Resolve avatar from either PlayerLocal (_avatar) or PlayerRemote (avatar) */
function getAvatar(player: PlayerWithAvatar): AvatarLike | undefined {
  return player._avatar || player.avatar;
}

function getPlayerAvatarId(player: PlayerWithAvatar): string | null {
  const avatarUrl =
    player.avatarUrl ??
    (typeof player.data?.avatar === "string" ? player.data.avatar : null);
  return avatarUrl ? (getAvatarByUrl(avatarUrl)?.id ?? null) : null;
}

function equipmentModelCacheKey(
  itemId: string,
  avatarId: string | null | undefined,
): string {
  return `${avatarId ?? "default"}\u0000${itemId}`;
}

function equipmentControllerKey(playerId: string, slot: string): string {
  return `${playerId}\u0000${slot.toLowerCase()}`;
}

async function sha256ArrayBuffer(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface PlayerEquipmentVisuals {
  weapon?: THREE.Object3D;
  shield?: THREE.Object3D;
  helmet?: THREE.Object3D;
  body?: THREE.Object3D;
  legs?: THREE.Object3D;
  boots?: THREE.Object3D;
  gloves?: THREE.Object3D;
  cape?: THREE.Object3D;
  amulet?: THREE.Object3D;
  ring?: THREE.Object3D;
  arrows?: THREE.Object3D;
  gatheringtool?: THREE.Object3D;
}

type FishingWorldTransition = {
  kind: "release" | "retrieve";
  startedAtPerformanceMs: number;
  durationMs: number;
  transferDelayMs: number;
  arcHeightMetres: number;
  anchorLocked: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromQuaternion: THREE.Quaternion;
  toQuaternion: THREE.Quaternion;
  fromScale: THREE.Vector3;
  toScale: THREE.Vector3;
};

type ActiveFishingWorldProp = {
  interactionId: string;
  itemId: "small_fishing_net" | "lobster_pot";
  phase: FishingInteractionPresentationState["phase"];
  object: THREE.Object3D;
  worldTemplate: THREE.Object3D;
  visualKind: "held_clone" | "world_model";
  targetPosition: THREE.Vector3;
  transition: FishingWorldTransition | null;
};

const FISHING_WORLD_RELEASE_DURATION_MS =
  FISHING_INTERACTION_PHASE_DURATION_SECONDS * 1_000;
const FISHING_WORLD_RETRIEVE_DURATION_MS =
  FISHING_WORLD_INTERACTION_BODY_MOTION_DURATION_SECONDS * 1_000;

export class EquipmentVisualSystem extends SystemBase {
  private gltfParser: GLTFLoader;
  private playerEquipment = new Map<string, PlayerEquipmentVisuals>();

  // Cache loaded weapon models to avoid reloading
  private weaponCache = new Map<string, GLTF>();
  private weaponLoadPromises = new Map<string, Promise<GLTF | null>>();
  private equipmentLoadGeneration = 0;

  // The public stream configures this from the exact immutable combat
  // snapshot. A fixed starter-weapon list cannot represent agent-owned gear.
  private streamingVisualCycleId: string | null = null;
  private streamingVisualRequirementSignature = "";
  private streamingVisualGeneration = 0;
  private streamingVisualRequirements = new Map<
    string,
    StreamingVisualRequirementState
  >();
  private streamingVisualExpectations: StreamingDuelEquipmentVisualExpectation[] =
    [];
  private streamingVisualContractConfigured = false;

  // Desired identity is updated before any asynchronous work begins. Attached
  // identity is written only after the exact model is on the current avatar.
  private desiredEquipmentItemIds = new Map<
    string,
    Map<string, string | null>
  >();
  private attachedEquipmentItemIds = new Map<string, Map<string, string>>();
  // Distinguishes repeated same-item requests while their fitted model is
  // loading. Desired identity alone cannot tell an older async completion from
  // a newer request when both item IDs match.
  private equipmentRequestVersions = new Map<string, number>();
  private equipmentRequestSequence = 0;
  private readonly neutralShortsWearState = new NeutralShortsWearState();
  // Readiness must prove that the attached identities belong to the avatar
  // currently rendered for the player, not merely that their item IDs match.
  private attachedEquipmentAvatarVrms = new Map<string, Map<string, VRM>>();

  // Queue equipment changes that are waiting for VRM to load
  private pendingEquipment = new Map<
    string,
    { slot: string; itemId: string }[]
  >();

  // Authoritative temporary tool intent for active gathering sessions. Keeping
  // this separate from the generic equipment queue prevents a late avatar/model
  // load from resurrecting a tool after the gathering session has already ended.
  private activeGatheringToolItemIds = new Map<string, string>();
  private latestGatheringToolPresentationRevisions = new Map<string, number>();
  private fishingInteractionStates = new Map<
    string,
    FishingInteractionPresentationState
  >();
  private latestFishingInteractionPresentationRevisions = new Map<
    string,
    number
  >();
  private processingInteractionStates = new Map<
    string,
    ProcessingInteractionPresentationState
  >();
  private latestProcessingInteractionPresentationRevisions = new Map<
    string,
    number
  >();
  private fishingWorldProps = new Map<string, ActiveFishingWorldProp>();
  private fishingWorldModelCache = new Map<string, GLTF>();
  private fishingWorldModelLoadPromises = new Map<
    string,
    Promise<GLTF | null>
  >();
  private fishingWorldRequestVersions = new Map<string, number>();
  private fishingWorldVisualFailures = new Set<string>();

  // Track players whose weapon is hidden during non-melee combat (magic/ranged)
  private hiddenWeaponsCombat = new Set<string>();

  // Timers to restore weapon visibility after non-melee attack animation completes
  private combatWeaponRestoreTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  // Track item ID in weapon slot per player (to check if it's melee before hiding)
  private playerWeaponItemIds = new Map<string, string>();

  // Render-synchronized nock controller for each equipped dynamic bowstring.
  private dynamicBowStrings = new Map<string, DynamicBowStringController>();
  private pendingBowReleases = new Map<
    string,
    {
      receivedAtPerformanceMs: number;
      delayMs: number;
      arrowId?: string;
      networkEventId?: string;
    }
  >();
  private bowTransitionSequence = 0;
  private readonly recentBowTransitions: StreamingDuelBowTransitionEvent[] = [];
  private static readonly MAX_RECENT_BOW_TRANSITIONS = 128;

  // Long fitted weapons can opt into an avatar-local pose that cancels wrist
  // roll while preserving the certified hand attachment point.
  private stableHeldEquipmentPoses = new Map<
    string,
    StableHeldEquipmentPoseController
  >();

  // Authored long handles can opt into a render-synchronized correction that
  // keeps the animated off hand on the shaft without moving the primary grip.
  private twoHandEquipmentGrips = new Map<
    string,
    TwoHandEquipmentGripController
  >();

  // How long to keep weapon hidden after the last non-melee attack (ms).
  // Using ~4 ticks (2400ms) to cover the full attack animation at standard speed.
  private static readonly COMBAT_WEAPON_RESTORE_DELAY_MS = 2400;

  constructor(world: World) {
    super(world, {
      name: "equipment-visual",
      dependencies: {
        required: [],
        optional: ["player", "equipment"],
      },
      autoCleanup: true,
    });
    // Initialize parser with meshopt decoder for compressed GLB files
    // NOTE: We use ClientLoader.loadFile() for the fetch/cache layer (IndexedDB etc.)
    // and only use this GLTFLoader for parsing the bytes into a scene.
    this.gltfParser = new GLTFLoader();
    this.gltfParser.setMeshoptDecoder(MeshoptDecoder);
  }

  async init(): Promise<void> {
    // Only run on client
    if (this.world.isServer) {
      return;
    }

    // Subscribe to equipment changes
    this.subscribe(
      EventType.PLAYER_EQUIPMENT_CHANGED,
      (data: { playerId: string; slot: string; itemId: string | null }) => {
        this.handleEquipmentChange(data);
      },
    );

    // Clean up when player leaves
    this.subscribe(EventType.PLAYER_CLEANUP, (data: { playerId: string }) => {
      this.cleanupPlayerEquipment(data.playerId);
    });

    // When VRM finishes loading, replay cached equipment through the normal handler.
    // This handles the case where equipmentUpdated arrived before VRM was ready.
    // By routing through handleEquipmentChange (the proven real-time path), we get
    // the same bone lookup and attachment logic that works for live equip changes.
    this.subscribe(
      EventType.AVATAR_LOAD_COMPLETE,
      (data: { playerId: string; success: boolean }) => {
        if (!data.success) return;

        const player = this.world.entities.get(data.playerId) as
          PlayerWithAvatar | undefined;
        const currentVrm = player
          ? getAvatar(player)?.instance?.raw?.userData?.vrm
          : undefined;
        const attachedVrms = this.attachedEquipmentAvatarVrms.get(
          data.playerId,
        );
        const avatarReplaced = Boolean(
          currentVrm &&
          attachedVrms &&
          [...attachedVrms.values()].some((vrm) => vrm !== currentVrm),
        );
        if (avatarReplaced) {
          try {
            this.invalidatePlayerVisualAttachments(data.playerId, currentVrm);
          } catch (error) {
            // Cleanup has attempted every old slot. Keep replaying the new
            // avatar instead of stranding it after a resource listener fails.
            this.logger.warn("Avatar equipment cleanup reported failures", {
              playerId: data.playerId,
              error,
            });
          }
        }

        this.hydrateFishingInteractionPresentationFromEntity(data.playerId);
        this.hydrateProcessingInteractionPresentationFromEntity(data.playerId);
        this.hydrateGatheringToolPresentationFromEntity(data.playerId);

        const desired = this.desiredEquipmentItemIds.get(data.playerId);
        const replayedSlots = new Set<string>();

        // 1. Replay any items from the pending queue
        const pending = this.pendingEquipment.get(data.playerId);
        if (pending && pending.length > 0) {
          const items = [...pending]; // Copy before clearing
          this.pendingEquipment.delete(data.playerId);
          for (const { slot, itemId } of items) {
            const slotKey = slot.toLowerCase();
            if (desired?.get(slotKey) !== itemId) continue;
            replayedSlots.add(slotKey);
            this.handleEquipmentChange({
              playerId: data.playerId,
              slot,
              itemId,
            });
          }
        }

        // 2. Safety net: also replay from network cache (lastEquipmentByPlayerId)
        //    Catches equipment that was dropped because entity didn't exist yet
        interface NetworkWithEquipmentCache {
          lastEquipmentByPlayerId?: Record<string, Record<string, unknown>>;
        }
        const network = this.world.network as
          NetworkWithEquipmentCache | undefined;
        const cached = network?.lastEquipmentByPlayerId?.[data.playerId];
        if (cached) {
          const slots = EQUIPMENT_SLOT_NAMES;
          for (const slot of slots) {
            const slotKey = slot.toLowerCase();
            // A handled equipment event, including an explicit unequip, is
            // newer authority than this recovery cache. Never resurrect a
            // cached item over a known desired value.
            if (desired?.has(slotKey)) continue;
            const slotData = cached[slot] as
              { itemId?: string; item?: { id?: string } } | null | undefined;
            const itemId = slotData?.itemId || slotData?.item?.id;
            if (itemId && String(itemId) !== "0") {
              replayedSlots.add(slotKey);
              this.handleEquipmentChange({
                playerId: data.playerId,
                slot,
                itemId: String(itemId),
              });
            }
          }
        }

        // 3. If a different avatar instance replaced the one holding the
        // visuals, replay desired persistent slots even when no cache entry is
        // available. The old attachment identities were invalidated above.
        if (desired) {
          for (const [slot, itemId] of desired) {
            if (
              slot === "gatheringtool" ||
              !itemId ||
              replayedSlots.has(slot)
            ) {
              continue;
            }
            // Local avatars expose their instance while idle is still loading
            // with the scene hidden. A complete garment may already be attached
            // but not yet own shorts visibility; readiness must retry that lease.
            const legVisual = this.playerEquipment.get(data.playerId)?.legs;
            const needsClothingRefresh =
              slot === "legs" &&
              legVisual &&
              requestsNeutralShortsReplacement(legVisual);
            if (!avatarReplaced && !needsClothingRefresh) continue;
            this.handleEquipmentChange({
              playerId: data.playerId,
              slot,
              itemId,
            });
          }
        }

        // 4. Gathering tools are transient public action state rather than
        // persistent equipment. Replay only the still-active intent so a hide
        // received before avatar readiness cannot produce a ghost tool.
        const gatheringToolItemId = this.activeGatheringToolItemIds.get(
          data.playerId,
        );
        if (gatheringToolItemId) {
          void this.applyGatheringToolShow(data.playerId, gatheringToolItemId);
        }
      },
    );

    // Show the active gathering tool instead of the combat loadout.
    this.subscribe(
      EventType.GATHERING_TOOL_SHOW,
      (data: {
        playerId: string;
        itemId: string;
        slot: string;
        revision?: number;
      }) => {
        this.handleGatheringToolShow(data);
      },
    );

    // Hide gathering tool when gathering stops
    this.subscribe(
      EventType.GATHERING_TOOL_HIDE,
      (data: { playerId: string; slot: string; revision?: number }) => {
        this.handleGatheringToolHide(data);
      },
    );

    this.subscribe(
      EventType.FISHING_INTERACTION_PRESENTATION,
      (data: { playerId: string } & Record<string, unknown>) => {
        void this.handleFishingInteractionPresentation(data);
      },
    );

    this.subscribe(
      EventType.PROCESSING_INTERACTION_PRESENTATION,
      (data: { playerId: string } & Record<string, unknown>) => {
        this.handleProcessingInteractionPresentation(data);
      },
    );

    // Hide a melee weapon during magic/ranged attacks.
    this.subscribe(
      EventType.COMBAT_PROJECTILE_LAUNCHED,
      (data: {
        attackerId: string;
        projectileType?: string;
        delayMs?: number;
        arrowId?: string;
        networkEventId?: string;
      }) => {
        this.handleCombatProjectileLaunched(data);
      },
    );
  }

  setStreamingDuelEquipmentVisualContract(
    contract: StreamingDuelEquipmentVisualContract,
  ): void {
    const cycleId = contract.cycleId.trim();
    const previousCycleId = this.streamingVisualCycleId;
    const requirements = new Map<
      string,
      StreamingDuelEquipmentVisualRequirement
    >();
    for (const requirement of contract.requirements) {
      const playerId = requirement.playerId.trim();
      const itemId = requirement.itemId.trim();
      const slot = requirement.slot.toLowerCase();
      if (!playerId || !itemId || !isStreamingDuelVisibleEquipmentSlot(slot)) {
        continue;
      }
      const normalized = { playerId, itemId, slot };
      requirements.set(streamingVisualRequirementKey(normalized), normalized);
    }
    const normalizedRequirements = [...requirements.values()].sort((a, b) =>
      streamingVisualRequirementKey(a).localeCompare(
        streamingVisualRequirementKey(b),
      ),
    );
    const requirementSignature = JSON.stringify(normalizedRequirements);

    // An empty cycle ID is the legitimate maintenance/IDLE projection. The
    // method call itself is the configuration boundary; before the first call
    // readiness remains fail-closed.
    this.streamingVisualContractConfigured = true;
    this.streamingVisualCycleId = cycleId || null;
    this.streamingVisualExpectations = contract.currentEquipment
      .filter(
        (expectation) =>
          expectation.playerId.trim().length > 0 &&
          isStreamingDuelVisibleEquipmentSlot(expectation.slot),
      )
      .map((expectation) => ({
        playerId: expectation.playerId.trim(),
        itemId: expectation.itemId?.trim() || null,
        slot: expectation.slot.toLowerCase() as StreamingDuelVisibleEquipmentSlot,
      }));

    // A cold spectator can receive the immutable public duel snapshot before
    // its avatar is ready and after the initial replicated equipment event has
    // already passed. Seed only genuinely unknown slots from that signed-off
    // snapshot. Never overwrite a known desired value: the equipment stream
    // can legitimately lead this projection by one update during a role
    // switch, and the readiness logic below already handles that bounded race.
    for (const expectation of this.streamingVisualExpectations) {
      const desired = this.desiredEquipmentItemIds.get(expectation.playerId);
      if (desired?.has(expectation.slot)) continue;
      void this.handleEquipmentChange({
        playerId: expectation.playerId,
        slot: expectation.slot,
        itemId: expectation.itemId,
      });
    }

    if (
      previousCycleId === this.streamingVisualCycleId &&
      this.streamingVisualRequirementSignature === requirementSignature &&
      this.streamingVisualRequirements.size === normalizedRequirements.length
    ) {
      return;
    }

    this.streamingVisualRequirementSignature = requirementSignature;
    const generation = ++this.streamingVisualGeneration;
    this.streamingVisualRequirements.clear();
    for (const requirement of normalizedRequirements) {
      const key = streamingVisualRequirementKey(requirement);
      this.streamingVisualRequirements.set(key, {
        ...requirement,
        status: "loading",
      });
      const player = this.world.entities.get(requirement.playerId) as
        PlayerWithAvatar | undefined;
      const avatarId = player ? getPlayerAvatarId(player) : null;
      void this.loadEquipmentModel(
        requirement.itemId,
        requirement.slot,
        null,
        avatarId,
      )
        .then((model) => {
          if (generation !== this.streamingVisualGeneration) return;
          const current = this.streamingVisualRequirements.get(key);
          if (!current) return;
          if (!model) {
            current.status = "missing_model";
            return;
          }
          const validation = validateStreamingEquipmentVisualModel(
            model.scene,
            requirement.slot,
            { itemId: requirement.itemId, avatarId: avatarId ?? undefined },
          );
          current.status = validation.valid
            ? "ready"
            : validation.reason === "incompatible_avatar"
              ? "incompatible_avatar"
              : "invalid_model";
        })
        .catch((error: unknown) => {
          if (generation !== this.streamingVisualGeneration) return;
          const current = this.streamingVisualRequirements.get(key);
          if (!current) return;
          current.status = "load_failed";
          const detail =
            error instanceof Error
              ? error.message
              : String(error ?? "unknown error");
          this.logger.warn(
            `Failed to pre-warm required streaming equipment ${requirement.itemId} (${requirement.slot}): ${detail}`,
          );
        });
    }
  }

  getStreamingDuelEquipmentVisualReadiness(): StreamingDuelEquipmentVisualReadiness {
    const requirementStates = [...this.streamingVisualRequirements.values()];
    const unresolved = requirementStates.flatMap((requirement) => {
      if (requirement.status !== "ready") return [{ ...requirement }];

      const player = this.world.entities.get(requirement.playerId) as
        PlayerWithAvatar | undefined;
      const rawInstance = player ? getAvatar(player)?.instance?.raw : undefined;
      const vrm = rawInstance?.userData?.vrm;
      if (!player || !vrm) {
        return [{ ...requirement, status: "avatar_unavailable" as const }];
      }

      const avatarId = getPlayerAvatarId(player);
      if (!avatarId) {
        return [{ ...requirement, status: "unapproved_avatar" as const }];
      }

      const model = this.weaponCache.get(
        equipmentModelCacheKey(requirement.itemId, avatarId),
      );
      if (!model) {
        return [{ ...requirement, status: "invalid_model" as const }];
      }
      const validation = validateStreamingEquipmentVisualModel(
        model.scene,
        requirement.slot,
        { itemId: requirement.itemId, avatarId, vrm },
      );
      if (!validation.valid) {
        return [
          {
            ...requirement,
            status:
              validation.reason === "incompatible_avatar"
                ? ("incompatible_avatar" as const)
                : ("invalid_model" as const),
          },
        ];
      }
      return [];
    });
    const attachmentMismatches = this.streamingVisualExpectations.flatMap(
      (expectation) => {
        const desiredItemId =
          this.desiredEquipmentItemIds
            .get(expectation.playerId)
            ?.get(expectation.slot) ?? null;
        const attachedItemId =
          this.attachedEquipmentItemIds
            .get(expectation.playerId)
            ?.get(expectation.slot) ?? null;
        const player = this.world.entities.get(expectation.playerId) as
          PlayerWithAvatar | undefined;
        const currentVrm = player
          ? getAvatar(player)?.instance?.raw?.userData?.vrm
          : undefined;
        const attachedToCurrentAvatar =
          !attachedItemId ||
          (Boolean(currentVrm) &&
            this.attachedEquipmentAvatarVrms
              .get(expectation.playerId)
              ?.get(expectation.slot) === currentVrm);
        const desiredVisualIsAttached = desiredItemId === attachedItemId;
        const projectedVisualMatches = desiredItemId === expectation.itemId;
        const desiredVisualIsFrozen = desiredItemId
          ? this.streamingVisualRequirements.has(
              streamingVisualRequirementKey({
                playerId: expectation.playerId,
                itemId: desiredItemId,
                slot: expectation.slot,
              }),
            )
          : false;

        // The public cycle projection and the replicated equipment event are
        // delivered on separate ordered streams. A committed in-fight role
        // switch can therefore make the cycle's current-item hint one update
        // behind the server-originated equipment event. Treat that bounded
        // transition as ready only when the desired visual is already attached
        // and the item belongs to this cycle's frozen, pre-warmed loadout set.
        // Unknown or half-applied equipment remains fail-closed.
        const matches =
          desiredVisualIsAttached &&
          attachedToCurrentAvatar &&
          (projectedVisualMatches || desiredVisualIsFrozen);
        return matches
          ? []
          : [
              {
                ...expectation,
                desiredItemId,
                attachedItemId,
              },
            ];
      },
    );
    const readyCount = requirementStates.length - unresolved.length;
    const requiredPlayerCount = new Set(
      requirementStates.map((requirement) => requirement.playerId),
    ).size;
    const expectedPlayerCount = new Set(
      this.streamingVisualExpectations.map(
        (expectation) => expectation.playerId,
      ),
    ).size;
    const activeVisuals = this.streamingVisualExpectations.flatMap(
      (expectation) => {
        const desiredItemId =
          this.desiredEquipmentItemIds
            .get(expectation.playerId)
            ?.get(expectation.slot) ?? null;
        const attachedItemId =
          this.attachedEquipmentItemIds
            .get(expectation.playerId)
            ?.get(expectation.slot) ?? null;
        const desiredVisualIsFrozen = desiredItemId
          ? this.streamingVisualRequirements.has(
              streamingVisualRequirementKey({
                playerId: expectation.playerId,
                itemId: desiredItemId,
                slot: expectation.slot,
              }),
            )
          : false;
        // Equipment events can lead the public cycle projection by one ordered
        // update during a committed role switch. In that bounded case, inspect
        // the already-attached frozen item rather than the stale projection.
        const activeItemId =
          desiredItemId === attachedItemId && desiredVisualIsFrozen
            ? desiredItemId
            : expectation.itemId;
        if (!activeItemId) return [];
        const object = this.playerEquipment.get(expectation.playerId)?.[
          expectation.slot
        ];
        return [
          {
            playerId: expectation.playerId,
            visible: isVisibleInObjectHierarchy(object),
          },
        ];
      },
    );
    const activePlayerIds = new Set(
      activeVisuals.map((visual) => visual.playerId),
    );
    const activeVisiblePlayerIds = new Set(
      [...activePlayerIds].filter((playerId) =>
        activeVisuals
          .filter((visual) => visual.playerId === playerId)
          .every((visual) => visual.visible),
      ),
    );
    return {
      configured: this.streamingVisualContractConfigured,
      ready:
        this.streamingVisualContractConfigured &&
        unresolved.length === 0 &&
        attachmentMismatches.length === 0,
      cycleId: this.streamingVisualCycleId,
      requiredCount: requirementStates.length,
      requiredPlayerCount,
      readyCount,
      expectedPlayerCount,
      activeVisualCount: activeVisuals.length,
      activeVisibleCount: activeVisuals.filter((visual) => visual.visible)
        .length,
      activePlayerCount: activePlayerIds.size,
      activeVisiblePlayerCount: activeVisiblePlayerIds.size,
      unresolved,
      attachmentMismatches,
    };
  }

  getStreamingPreparationVisualDiagnostics(
    playerIds: readonly string[],
  ): StreamingPreparationVisualDiagnostics {
    const uniquePlayerIds = [
      ...new Set(
        playerIds.filter(
          (playerId) => typeof playerId === "string" && playerId.length > 0,
        ),
      ),
    ];
    const players = uniquePlayerIds.map((playerId) => {
      const gatheringToolItemId =
        this.activeGatheringToolItemIds.get(playerId) ?? null;
      const fishingState = this.fishingInteractionStates.get(playerId);
      const processingState = this.processingInteractionStates.get(playerId);
      const processingActive = Boolean(
        processingState && processingState.phase === "working",
      );
      const presentationActive = Boolean(
        gatheringToolItemId ||
        (fishingState && fishingState.phase !== "idle") ||
        processingActive,
      );
      const desiredItemId =
        this.desiredEquipmentItemIds.get(playerId)?.get("gatheringtool") ??
        null;
      const attachedItemId =
        this.attachedEquipmentItemIds.get(playerId)?.get("gatheringtool") ??
        null;
      const heldVisual = this.playerEquipment.get(playerId)?.gatheringtool;
      const worldVisual = this.fishingWorldProps.get(playerId)?.object;
      const player = this.world.entities.get(playerId) as
        PlayerWithAvatar | undefined;
      const replicatedProcessingState =
        normalizeProcessingInteractionPresentationState(
          player?.data?.processingInteractionPresentation,
        );
      const currentVrm = player
        ? getAvatar(player)?.instance?.raw?.userData?.vrm
        : undefined;
      const attachedToCurrentAvatar = Boolean(
        currentVrm &&
        this.attachedEquipmentAvatarVrms.get(playerId)?.get("gatheringtool") ===
          currentVrm,
      );
      const heldVisualPresent = Boolean(heldVisual);
      const heldVisualVisible = isVisibleInObjectHierarchy(heldVisual);
      const worldVisualPresent = Boolean(worldVisual);
      const worldVisualVisible = isVisibleInObjectHierarchy(worldVisual);
      const visualPresent = heldVisualPresent || worldVisualPresent;
      const visualVisible = heldVisualVisible || worldVisualVisible;
      const gatheringPresentationActive = Boolean(
        gatheringToolItemId || (fishingState && fishingState.phase !== "idle"),
      );
      const gatheringReady = Boolean(
        !gatheringPresentationActive ||
        (gatheringToolItemId &&
          desiredItemId === gatheringToolItemId &&
          attachedItemId === gatheringToolItemId &&
          attachedToCurrentAvatar &&
          visualPresent &&
          visualVisible),
      );
      const processingBodyEmote = processingState?.skill
        ? resolveProcessingInteractionBodyEmote(processingState.skill)
        : null;
      const processingBodyMotionReady = Boolean(
        !processingActive ||
        (processingBodyEmote &&
          (player?.data?.e === processingBodyEmote ||
            player?.data?.emote === processingBodyEmote ||
            (replicatedProcessingState?.phase === "working" &&
              replicatedProcessingState.skill === processingState?.skill &&
              replicatedProcessingState.revision >=
                (processingState?.revision ?? Number.MAX_SAFE_INTEGER)))),
      );
      const processingTargetReady = Boolean(
        !processingActive ||
        processingState?.targetPosition ||
        processingState?.skill === "crafting" ||
        processingState?.skill === "fletching",
      );
      const ready = Boolean(
        presentationActive &&
        gatheringReady &&
        processingBodyMotionReady &&
        processingTargetReady,
      );

      return {
        playerId,
        presentationActive,
        gatheringToolItemId,
        fishingPhase: fishingState?.phase ?? null,
        desiredItemId,
        attachedItemId,
        heldVisualPresent,
        heldVisualVisible,
        worldVisualPresent,
        worldVisualVisible,
        attachedToCurrentAvatar,
        gatheringRevision:
          this.latestGatheringToolPresentationRevisions.get(playerId) ?? null,
        fishingRevision:
          this.latestFishingInteractionPresentationRevisions.get(playerId) ??
          null,
        processingSkill: processingState?.skill ?? null,
        processingPhase: processingState?.phase ?? null,
        processingRevision:
          this.latestProcessingInteractionPresentationRevisions.get(playerId) ??
          null,
        processingTargetPosition: processingState?.targetPosition ?? null,
        processingBodyEmote,
        processingBodyMotionReady,
        processingTargetReady,
        ready,
      };
    });
    const activePlayers = players.filter((player) => player.presentationActive);
    const readyCount = activePlayers.filter((player) => player.ready).length;
    return {
      schemaVersion: 1,
      updatedAt: Date.now(),
      activeCount: activePlayers.length,
      readyCount,
      ready: activePlayers.length > 0 && readyCount === activePlayers.length,
      players,
    };
  }

  isStreamingPreparationPresentationActive(playerId: string): boolean {
    const fishingState = this.fishingInteractionStates.get(playerId);
    const processingState = this.processingInteractionStates.get(playerId);
    return (
      this.activeGatheringToolItemIds.has(playerId) ||
      Boolean(fishingState && fishingState.phase !== "idle") ||
      Boolean(processingState && processingState.phase === "working")
    );
  }

  /**
   * Resolve the live replicated interaction target without depending on the
   * entity snapshot being mutated by a post-join presentation event.
   */
  getStreamingPreparationActivityTargetPosition(
    playerIds: readonly string[],
  ): { x: number; y: number; z: number } | null {
    const targets = [...new Set(playerIds)].flatMap((playerId) => {
      const target =
        this.processingInteractionStates.get(playerId)?.targetPosition ??
        this.fishingInteractionStates.get(playerId)?.targetPosition;
      return target &&
        Number.isFinite(target.x) &&
        Number.isFinite(target.y) &&
        Number.isFinite(target.z)
        ? [target]
        : [];
    });
    if (targets.length === 0) return null;
    return targets.reduce(
      (total, target) => ({
        x: total.x + target.x / targets.length,
        y: total.y + target.y / targets.length,
        z: total.z + target.z / targets.length,
      }),
      { x: 0, y: 0, z: 0 },
    );
  }

  getStreamingDuelBowPresentationDiagnostics(
    playerIds: readonly string[],
  ): StreamingDuelBowPresentationDiagnostics {
    const allowedPlayerIds = new Set(
      playerIds.filter((playerId) => typeof playerId === "string" && playerId),
    );
    const players = [...allowedPlayerIds].map((playerId) => {
      const controller = this.dynamicBowStrings.get(playerId);
      const visible = controller?.nockedArrow.visible === true;
      let nockedArrowWorldPosition: [number, number, number] | null = null;
      if (controller && visible) {
        const position = controller.nockedArrow.getWorldPosition(
          new THREE.Vector3(),
        );
        if ([position.x, position.y, position.z].every(Number.isFinite)) {
          nockedArrowWorldPosition = [position.x, position.y, position.z];
        }
      }
      return {
        playerId,
        itemId: this.playerWeaponItemIds.get(playerId) ?? null,
        controllerReady: Boolean(controller),
        nockedArrowVisible: visible,
        nockedArrowWorldPosition,
      };
    });
    return {
      schemaVersion: 1,
      updatedAt: Date.now(),
      performanceTimeMs: performance.now(),
      latestSequence: this.bowTransitionSequence,
      players,
      recentTransitions: this.recentBowTransitions.filter((transition) =>
        allowedPlayerIds.has(transition.playerId),
      ),
    };
  }

  /**
   * Release the exact committed bow launch immediately when its authoritative
   * impact overtakes the client-side animation deadline under load.
   */
  releaseCommittedArrowNow(playerId: string, networkEventId: string): boolean {
    if (
      typeof playerId !== "string" ||
      playerId.length === 0 ||
      playerId.length > 256 ||
      typeof networkEventId !== "string" ||
      networkEventId.length === 0 ||
      networkEventId.length > 256
    ) {
      return false;
    }

    const controller = this.dynamicBowStrings.get(playerId);
    if (controller?.releaseNow(networkEventId)) return true;

    // If the fitted bow has not attached yet, retire only this exact buffered
    // release. ProjectileRenderer will use its authoritative launch payload as
    // the fallback, and a later attachment must not replay a stale nock event.
    const pending = this.pendingBowReleases.get(playerId);
    if (pending?.networkEventId === networkEventId) {
      this.pendingBowReleases.delete(playerId);
    }
    return false;
  }

  /** Retire only the bow draw associated with an exact server cancellation. */
  cancelCommittedArrow(playerId: string, networkEventId: string): boolean {
    if (
      typeof playerId !== "string" ||
      playerId.length === 0 ||
      playerId.length > 256 ||
      typeof networkEventId !== "string" ||
      networkEventId.length === 0 ||
      networkEventId.length > 256
    ) {
      return false;
    }

    const controller = this.dynamicBowStrings.get(playerId);
    if (controller?.cancelRelease(networkEventId)) return true;

    const pending = this.pendingBowReleases.get(playerId);
    if (pending?.networkEventId === networkEventId) {
      this.pendingBowReleases.delete(playerId);
      return true;
    }
    return false;
  }

  private recordBowTransition(
    playerId: string,
    transition: DynamicBowStringTransition,
  ): void {
    const event: StreamingDuelBowTransitionEvent = {
      sequence: ++this.bowTransitionSequence,
      playerId,
      itemId: this.playerWeaponItemIds.get(playerId) ?? null,
      kind: transition.kind,
      performanceTimeMs: transition.performanceTimeMs,
      releaseAtPerformanceTimeMs:
        transition.kind === "scheduled"
          ? transition.releaseAtPerformanceTimeMs
          : null,
      networkEventId: transition.networkEventId,
      lastVisibleNockWorldPosition:
        transition.kind === "released"
          ? transition.lastVisibleNockWorldPosition
          : null,
      drawHandWorldPosition:
        transition.kind === "released"
          ? transition.drawHandWorldPosition
          : null,
    };
    this.recentBowTransitions.push(event);
    if (
      this.recentBowTransitions.length >
      EquipmentVisualSystem.MAX_RECENT_BOW_TRANSITIONS
    ) {
      this.recentBowTransitions.shift();
    }
    if (
      transition.kind === "released" &&
      transition.networkEventId &&
      transition.drawHandWorldPosition
    ) {
      // The controller and renderer consume the same authoritative launch ID.
      // Releasing the buffered arrow in this call stack prevents independent
      // browser timers from drifting apart under encoder CPU pressure.
      const projectileRenderer = this.world.getSystem?.(
        "projectile-renderer",
      ) as
        | {
            releaseDelayedArrow?: (
              networkEventId: string,
              drawHandWorldPosition: readonly [number, number, number],
            ) => boolean;
          }
        | undefined;
      projectileRenderer?.releaseDelayedArrow?.(
        transition.networkEventId,
        transition.drawHandWorldPosition,
      );
    }
  }

  private setDesiredEquipmentItem(
    playerId: string,
    slot: string,
    itemId: string | null,
  ): void {
    let desired = this.desiredEquipmentItemIds.get(playerId);
    if (!desired) {
      desired = new Map();
      this.desiredEquipmentItemIds.set(playerId, desired);
    }
    desired.set(slot.toLowerCase(), itemId);
  }

  private setAttachedEquipmentItem(
    playerId: string,
    slot: string,
    itemId: string | null,
    vrm?: VRM,
  ): void {
    const slotKey = slot.toLowerCase();
    let attached = this.attachedEquipmentItemIds.get(playerId);
    if (!attached) {
      if (!itemId) return;
      attached = new Map();
      this.attachedEquipmentItemIds.set(playerId, attached);
    }
    if (itemId) {
      attached.set(slotKey, itemId);
      if (vrm) {
        let owners = this.attachedEquipmentAvatarVrms.get(playerId);
        if (!owners) {
          owners = new Map();
          this.attachedEquipmentAvatarVrms.set(playerId, owners);
        }
        owners.set(slotKey, vrm);
      }
    } else {
      attached.delete(slotKey);
      this.attachedEquipmentAvatarVrms.get(playerId)?.delete(slotKey);
      if (attached.size === 0) {
        this.attachedEquipmentItemIds.delete(playerId);
        this.attachedEquipmentAvatarVrms.delete(playerId);
      }
    }
  }

  private nextEquipmentRequestVersion(playerId: string, slot: string): number {
    const key = `${playerId}\u0000${slot.toLowerCase()}`;
    // Never reuse a token after entity cleanup/rejoin with the same player ID.
    const version = ++this.equipmentRequestSequence;
    this.equipmentRequestVersions.set(key, version);
    return version;
  }

  private isCurrentEquipmentRequest(
    playerId: string,
    slot: string,
    version: number,
  ): boolean {
    return (
      this.equipmentRequestVersions.get(
        `${playerId}\u0000${slot.toLowerCase()}`,
      ) === version
    );
  }

  private async handleEquipmentChange(data: {
    playerId: string;
    slot: string;
    itemId: string | null;
  }): Promise<void> {
    const { playerId, slot, itemId } = data;

    // Skip invalid itemIds (only "0" is invalid, null means unequip)
    if (itemId === "0") {
      return;
    }

    const requestVersion = this.nextEquipmentRequestVersion(playerId, slot);
    this.setDesiredEquipmentItem(playerId, slot, itemId);
    // Every new authoritative value supersedes an older pre-avatar value for
    // this slot, including an unequip. Without clearing first, equip ->
    // unequip before avatar readiness could replay the removed item later.
    this.removePendingEquipmentSlot(playerId, slot);

    // Restore the owned garment even if the entity/VRM disappeared meanwhile.
    if (!itemId && slot.toLowerCase() === "legs") {
      const equipment = this.playerEquipment.get(playerId);
      if (equipment) this.unequipVisual(playerId, slot, equipment);
      else this.neutralShortsWearState.clear(playerId);
      return;
    }

    // This is authoritative identity state, so update it even when the avatar
    // is not ready and the visual must wait.
    if (slot.toLowerCase() === "weapon") {
      if (itemId) this.playerWeaponItemIds.set(playerId, itemId);
      else this.playerWeaponItemIds.delete(playerId);
    }

    // Get player entity to access VRM
    const player = this.world.entities.get(playerId);
    if (!player) {
      // Entity doesn't exist yet (equipmentUpdated arrived before entityAdded)
      // Queue for later — AVATAR_LOAD_COMPLETE or update() will process it
      if (itemId && itemId !== "0") {
        const queue = this.pendingEquipment.get(playerId) ?? [];
        queue.push({ slot, itemId });
        this.pendingEquipment.set(playerId, queue);
      }
      return;
    }

    // CRITICAL: instance.raw is GLTF, VRM is in userData.vrm!
    // PlayerLocal uses _avatar getter, PlayerRemote uses avatar property
    const playerWithAvatar = player as PlayerWithAvatar;
    const resolvedAvatar = getAvatar(playerWithAvatar);
    const avatarInstance = resolvedAvatar?.instance;
    const vrm = avatarInstance?.raw?.userData?.vrm;

    if (!avatarInstance || !vrm) {
      // Queue this equipment change to retry when VRM is ready
      // Only queue if itemId is valid (not null or "0")
      if (itemId && itemId !== "0") {
        const queue = this.pendingEquipment.get(playerId) ?? [];
        queue.push({ slot, itemId });
        this.pendingEquipment.set(playerId, queue);
      }

      return;
    }

    // Get or create equipment visuals for this player
    if (!this.playerEquipment.has(playerId)) {
      this.playerEquipment.set(playerId, {});
    }
    const equipment = this.playerEquipment.get(playerId)!;

    // Arrow debit and other atomic equipment mutations publish a complete
    // equipment snapshot. Do not tear down and rebuild an unchanged fitted
    // weapon: doing so can cancel its authoritative nock/release timer and
    // creates a visible readiness gap even though neither the item nor avatar
    // changed.
    const slotKey = slot.toLowerCase() as keyof PlayerEquipmentVisuals;
    if (
      itemId &&
      this.attachedEquipmentItemIds.get(playerId)?.get(slotKey) === itemId &&
      this.attachedEquipmentAvatarVrms.get(playerId)?.get(slotKey) === vrm &&
      equipment[slotKey]
    ) {
      if (slotKey === "legs") {
        this.neutralShortsWearState.refresh({
          playerId,
          modelRoot: equipment[slotKey],
          slot,
          itemId,
          avatarId: getPlayerAvatarId(playerWithAvatar),
          vrm,
        });
      }
      this.applyHeldEquipmentVisibility(playerId, equipment);
      return;
    }

    // Handle unequip (itemId is null)
    if (!itemId) {
      this.unequipVisual(playerId, slot, equipment, vrm);
      return;
    }

    // Handle equip - load and attach weapon
    await this.equipVisual(
      playerId,
      slot,
      itemId,
      equipment,
      vrm,
      requestVersion,
    );
  }

  private unequipVisual(
    playerId: string,
    slot: string,
    equipment: PlayerEquipmentVisuals,
    _vrm?: VRM,
  ): void {
    // Remove existing visual for this slot
    const slotKey = slot.toLowerCase() as keyof PlayerEquipmentVisuals;
    const twoHandControllerKey = equipmentControllerKey(playerId, slot);
    const errors: unknown[] = [];
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    if (slotKey === "legs") {
      attempt(() => this.neutralShortsWearState.clear(playerId));
    }
    const twoHandGrip = this.twoHandEquipmentGrips.get(twoHandControllerKey);
    this.twoHandEquipmentGrips.delete(twoHandControllerKey);
    if (twoHandGrip) attempt(() => twoHandGrip.dispose());
    if (slotKey === "weapon") {
      const bow = this.dynamicBowStrings.get(playerId);
      this.dynamicBowStrings.delete(playerId);
      if (bow) attempt(() => bow.dispose());
      const heldPose = this.stableHeldEquipmentPoses.get(playerId);
      this.stableHeldEquipmentPoses.delete(playerId);
      if (heldPose) attempt(() => heldPose.dispose());
    }
    attempt(() =>
      removeEquipmentVisual(equipment as EquipmentVisualStore, slotKey),
    );
    this.setAttachedEquipmentItem(playerId, slot, null);
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Equipment unequip failed for ${playerId}/${slot}`,
      );
    }
  }

  /**
   * Try to resolve item data from the network's cached equipmentUpdated payload.
   * The server sends the full Item object per slot; this is our fallback when
   * the client-side ITEMS map doesn't contain a newly-added weapon yet.
   */
  private getItemFromNetworkCache(
    playerId: string,
    slot: string,
  ): EquipmentVisualModelData | null {
    interface NetworkWithEquipmentCache {
      lastEquipmentByPlayerId?: Record<string, Record<string, unknown>>;
    }
    const network = this.world.network as NetworkWithEquipmentCache | undefined;
    const cached = network?.lastEquipmentByPlayerId?.[playerId];
    if (!cached) return null;
    const slotData = cached[slot] as
      { item?: EquipmentVisualModelData } | null | undefined;
    return slotData?.item ?? null;
  }

  private async equipVisual(
    playerId: string,
    slot: string,
    itemId: string,
    equipment: PlayerEquipmentVisuals,
    _vrm: VRM,
    requestVersion: number,
  ): Promise<void> {
    // Weapons retain their strict role-switch behavior. A qualified complete
    // leg garment instead remains a visual fallback while loading: its exact
    // old attached item ID stays published, so readiness cannot call it ready
    // for the new desired item. Shorts and their covering garment swap together.
    const retainCompleteLegs =
      slot.toLowerCase() === "legs" &&
      this.neutralShortsWearState.retains(playerId, equipment.legs, _vrm);
    const twoHandControllerKey = equipmentControllerKey(playerId, slot);
    this.twoHandEquipmentGrips.get(twoHandControllerKey)?.dispose();
    this.twoHandEquipmentGrips.delete(twoHandControllerKey);
    if (slot.toLowerCase() === "weapon") {
      this.dynamicBowStrings.get(playerId)?.dispose();
      this.dynamicBowStrings.delete(playerId);
      this.stableHeldEquipmentPoses.get(playerId)?.dispose();
      this.stableHeldEquipmentPoses.delete(playerId);
    }
    if (!retainCompleteLegs) {
      if (slot.toLowerCase() === "legs") {
        this.neutralShortsWearState.clear(playerId);
      }
      removeEquipmentVisual(
        equipment as EquipmentVisualStore,
        slot.toLowerCase(),
      );
      this.setAttachedEquipmentItem(playerId, slot, null);
    }
    let ownedCandidate: THREE.Object3D | undefined;
    try {
      const requestedPlayer = this.world.entities.get(playerId) as
        PlayerWithAvatar | undefined;
      if (!requestedPlayer) return;
      const requestedAvatarId = getPlayerAvatarId(requestedPlayer);
      const cachedItem = this.getItemFromNetworkCache(playerId, slot);
      // The immutable stream contract prewarms every allowed combat weapon.
      // Use that cached model synchronously so an atomic role switch cannot
      // expose a render frame between removal of the old controller and
      // attachment of the new one. Uncached exploration equipment retains the
      // asynchronous loading path.
      const gltf =
        this.weaponCache.get(
          equipmentModelCacheKey(itemId, requestedAvatarId),
        ) ??
        (await this.loadEquipmentModel(
          itemId,
          slot,
          cachedItem,
          requestedAvatarId,
        ));
      if (!gltf) return;

      const currentPlayer = this.world.entities.get(playerId) as
        PlayerWithAvatar | undefined;
      if (!currentPlayer) {
        // The entity can legitimately leave the spectator interest set while
        // its asynchronous model load is in flight. There is no avatar left to
        // mutate, so abandon this stale completion quietly.
        return;
      }
      const currentRawInstance = getAvatar(currentPlayer)?.instance?.raw;
      const currentVrm = currentRawInstance?.userData?.vrm;
      const avatarId = getPlayerAvatarId(currentPlayer);
      if (avatarId !== requestedAvatarId || currentVrm !== _vrm) {
        // The avatar changed while its fitted model was loading. A new
        // equipment event will resolve the model for the replacement rig.
        return;
      }
      // Complete clothing replacement requires the fitted structural contract
      // in ordinary gameplay too, not only in the competitive viewport.
      const requiresFittedValidation =
        (isStreamingLikeViewport() &&
          isStreamingDuelCertifiedEquipmentSlot(slot)) ||
        (slot.toLowerCase() === "legs" &&
          requestsNeutralShortsReplacement(gltf.scene));
      const streamingValidationReason = requiresFittedValidation
        ? !avatarId
          ? "unapproved_avatar"
          : !currentVrm
            ? "avatar_unavailable"
            : validateStreamingEquipmentVisualModel(gltf.scene, slot, {
                itemId,
                avatarId,
                vrm: currentVrm,
              }).reason
        : null;

      if (streamingValidationReason) {
        console.error(
          `[EquipmentVisual] ❌ Invalid fitted streaming model for ${itemId} (${slot}): ${streamingValidationReason}`,
        );
        return;
      }

      const desiredItemId = this.desiredEquipmentItemIds
        .get(playerId)
        ?.get(slot.toLowerCase());
      if (
        desiredItemId !== itemId ||
        !this.isCurrentEquipmentRequest(playerId, slot, requestVersion)
      ) {
        // A newer atomic role switch won this slot while the old model loaded.
        return;
      }

      const weaponMesh = cloneEquipmentVisualModel(gltf.scene);
      ownedCandidate = weaponMesh;

      // Re-check after cloning in case the contestant left or changed avatars
      // during the asynchronous load completion.
      const player = this.world.entities.get(playerId) as
        PlayerWithAvatar | undefined;
      if (!player) {
        return;
      }

      const rawInstance = getAvatar(player)?.instance?.raw;
      const activeVrm = rawInstance?.userData?.vrm;
      const avatarRoot = (rawInstance?.scene || rawInstance) as
        THREE.Object3D | undefined;

      if (!avatarRoot || !activeVrm) {
        console.error(
          `[EquipmentVisual] ❌ Could not resolve avatar root for ${playerId}`,
        );
        return;
      }

      if (activeVrm !== currentVrm || getPlayerAvatarId(player) !== avatarId) {
        // An avatar replacement won the race. The authoritative equipment
        // event for the new avatar will fit and attach a fresh instance.
        return;
      }
      if (!this.isCurrentEquipmentRequest(playerId, slot, requestVersion)) {
        return;
      }

      const attached = attachEquipmentVisualToVRM({
        slot,
        modelRoot: weaponMesh,
        visuals: equipment as EquipmentVisualStore,
        vrm: activeVrm,
        avatarRoot,
        lighting: { mode: "authored-scene" },
      });

      if (!attached) {
        console.error(
          `[EquipmentVisual] ❌ Failed to attach ${itemId} to slot ${slot}`,
        );
        return;
      }
      if (slot.toLowerCase() === "legs") {
        this.neutralShortsWearState.commit({
          playerId,
          modelRoot: weaponMesh,
          slot,
          itemId,
          avatarId,
          vrm: activeVrm,
        });
      }
      if (slot.toLowerCase() === "weapon") {
        const bowString = createDynamicBowStringController({
          modelRoot: weaponMesh,
          vrm: activeVrm,
          onTransition: (transition) =>
            this.recordBowTransition(playerId, transition),
          getState: () => {
            const current = this.world.entities.get(playerId) as
              PlayerWithAvatar | undefined;
            const data = current?.data as
              | { emote?: unknown; e?: unknown; deathState?: unknown }
              | undefined;
            return {
              emote: data?.emote,
              abbreviatedEmote: data?.e,
              deathState: data?.deathState,
            };
          },
        });
        if (bowString) {
          this.dynamicBowStrings.set(playerId, bowString);
          this.flushPendingBowRelease(playerId, bowString);
        } else if (
          extractEquipmentAttachmentData(
            weaponMesh,
          )?.weaponType?.toLowerCase() === "bow"
        ) {
          console.error(
            `[EquipmentVisual] ❌ Could not create the dynamic bowstring for ${itemId}`,
          );
        }
        const stablePose = createStableHeldEquipmentPoseController({
          modelRoot: weaponMesh,
          vrm: activeVrm,
          avatarRoot,
        });
        if (stablePose) {
          this.stableHeldEquipmentPoses.set(playerId, stablePose);
        } else if (
          extractEquipmentAttachmentData(
            weaponMesh,
          )?.weaponType?.toLowerCase() === "staff"
        ) {
          console.error(
            `[EquipmentVisual] ❌ Could not create the stable held pose for ${itemId}`,
          );
        }
      }
      const twoHandGrip = createTwoHandEquipmentGripController({
        modelRoot: weaponMesh,
        vrm: activeVrm,
        avatarRoot,
      });
      if (twoHandGrip) {
        this.twoHandEquipmentGrips.set(twoHandControllerKey, twoHandGrip);
      } else if (extractEquipmentAttachmentData(weaponMesh)?.twoHandGrip) {
        console.error(
          `[EquipmentVisual] ❌ Could not create the two-hand grip for ${itemId}`,
        );
      }
      this.setAttachedEquipmentItem(playerId, slot, itemId, activeVrm);
      this.applyHeldEquipmentVisibility(playerId, equipment);
      // Transfer only after controller/clothing/readiness setup succeeds.
      ownedCandidate = undefined;
    } catch (error) {
      console.error(`[EquipmentVisual] ❌ Error equipping ${itemId}:`, error);
    } finally {
      if (ownedCandidate) {
        const stored =
          equipment[slot.toLowerCase() as keyof PlayerEquipmentVisuals];
        if (stored?.getObjectById(ownedCandidate.id)) {
          // A failed post-attachment setup also owns its new controllers and
          // clothing state. Do not leave a partially configured visible item.
          this.unequipVisual(playerId, slot, equipment);
        } else {
          ownedCandidate.removeFromParent();
          disposeEquipmentVisualMaterials(ownedCandidate);
        }
      }
    }
  }

  private async loadEquipmentModel(
    itemId: string,
    slot: string,
    fallbackItemData: EquipmentVisualModelData | null,
    avatarId?: string | null,
  ): Promise<GLTF | null> {
    const cacheKey = equipmentModelCacheKey(itemId, avatarId);
    const cached = this.weaponCache.get(cacheKey);
    if (cached) return cached;

    const pending = this.weaponLoadPromises.get(cacheKey);
    if (pending) return pending;

    const generation = this.equipmentLoadGeneration;
    const loadPromise = (async (): Promise<GLTF | null> => {
      // Stream-state HTTP can win the startup race against the spectator
      // WebSocket snapshot. Until that snapshot lands, World still carries its
      // placeholder `/assets/` base and Vite answers model requests with index
      // HTML. Wait for the authoritative server asset base before resolving a
      // contract URL.
      if (isStreamingLikeViewport()) {
        const deadline = Date.now() + STREAMING_ASSET_BASE_READY_TIMEOUT_MS;
        while (
          !(this.world.network as { connected?: boolean } | undefined)
            ?.connected
        ) {
          if (Date.now() >= deadline) {
            throw new Error(
              `Streaming network snapshot was not ready after ${STREAMING_ASSET_BASE_READY_TIMEOUT_MS}ms`,
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
        }
      }
      const assetsUrl = this.world.assetsUrl?.replace(/\/$/, "") || "";
      const itemData = resolveEquipmentVisualData({
        itemId,
        fallbackItemData,
      });
      const urls = resolveEquipmentVisualUrls({
        assetsUrl,
        itemId,
        slot,
        avatarId,
        requireAvatarSpecificFit: isStreamingLikeViewport(),
        itemData,
        fallbackItemData,
      });
      if (!urls) return null;

      // Load through ClientLoader to benefit from IndexedDB persistence,
      // request deduplication, and bounded fetch concurrency.
      const loader = this.world.loader;
      let file: File | undefined;
      let resolvedUrl = urls.primaryUrl;
      try {
        file = loader ? await loader.loadFile(urls.primaryUrl) : undefined;
      } catch (error) {
        if (!urls.fallbackUrl) throw error;
        file = loader ? await loader.loadFile(urls.fallbackUrl) : undefined;
        resolvedUrl = urls.fallbackUrl;
      }

      if (!file) {
        throw new Error(
          `[EquipmentVisual] Failed to load model: ${resolvedUrl}`,
        );
      }

      const buffer = await file.arrayBuffer();
      if (urls.contentSha256) {
        const actualSha256 = await sha256ArrayBuffer(buffer);
        if (actualSha256 !== urls.contentSha256) {
          await (
            loader as
              { clearCachedFile?: (url: string) => Promise<void> } | undefined
          )?.clearCachedFile?.(resolvedUrl);
          throw new Error(
            `[EquipmentVisual] Content SHA-256 mismatch for ${itemId}: expected ${urls.contentSha256}, received ${actualSha256}`,
          );
        }
      }
      const gltf = (await this.gltfParser.parseAsync(
        buffer,
        resolvedUrl,
      )) as GLTF;
      if (isStreamingLikeViewport() && this.world.graphics?.precompileObject) {
        await this.world.graphics.precompileObject(gltf.scene);
      }
      if (generation === this.equipmentLoadGeneration) {
        this.weaponCache.set(cacheKey, gltf);
      }
      return gltf;
    })();

    this.weaponLoadPromises.set(cacheKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (this.weaponLoadPromises.get(cacheKey) === loadPromise) {
        this.weaponLoadPromises.delete(cacheKey);
      }
    }
  }

  /**
   * classic MMORPG-STYLE: Hide melee weapon during magic/ranged attacks.
   *
   * When a non-melee projectile is launched, the attacker's equipped melee weapon
   * should be hidden for the duration of the attack animation. Staffs and bows
   * (ranged/magic attackType) are left visible since they ARE the attack weapon.
   */
  private handleCombatProjectileLaunched(data: {
    attackerId: string;
    projectileType?: string;
    delayMs?: number;
    arrowId?: string;
    networkEventId?: string;
  }): void {
    const { attackerId } = data;
    if (data.projectileType === "arrow") {
      const delayMs = data.delayMs ?? 0;
      const controller = this.dynamicBowStrings.get(attackerId);
      if (controller) {
        controller.scheduleRelease(delayMs, data.arrowId, data.networkEventId);
        this.pendingBowReleases.delete(attackerId);
      } else if (
        typeof attackerId === "string" &&
        attackerId.length > 0 &&
        Number.isFinite(delayMs) &&
        delayMs >= 0 &&
        delayMs <= 5_000 &&
        (data.arrowId === undefined ||
          (typeof data.arrowId === "string" && data.arrowId.length <= 128)) &&
        (data.networkEventId === undefined ||
          (typeof data.networkEventId === "string" &&
            data.networkEventId.length > 0 &&
            data.networkEventId.length <= 256))
      ) {
        // Role authority and its first attack can arrive before the fitted bow
        // finishes its async attachment. Preserve the authoritative release
        // deadline so the visual does not silently lose its nock/release phase.
        this.pendingBowReleases.set(attackerId, {
          receivedAtPerformanceMs: performance.now(),
          delayMs,
          ...(data.arrowId ? { arrowId: data.arrowId } : {}),
          ...(data.networkEventId
            ? { networkEventId: data.networkEventId }
            : {}),
        });
      }
    }

    const equipment = this.playerEquipment.get(attackerId);
    if (!equipment?.weapon) return;

    // Only hide if the equipped weapon is a melee weapon (sword, scimitar, etc.)
    const weaponItemId = this.playerWeaponItemIds.get(attackerId);
    if (weaponItemId) {
      const itemData = getItem(weaponItemId);
      // Staff, bow, crossbow, wand have non-melee attackType — leave them visible
      if (itemData?.attackType && itemData.attackType !== AttackType.MELEE) {
        return;
      }
    }

    // Hide the melee weapon (avoid double-hiding)
    if (equipment.weapon.visible) {
      equipment.weapon.visible = false;
    }
    this.hiddenWeaponsCombat.add(attackerId);

    // Reset restore timer — extends window if attacks keep firing
    const existing = this.combatWeaponRestoreTimers.get(attackerId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.restoreCombatHiddenWeapon(attackerId);
    }, EquipmentVisualSystem.COMBAT_WEAPON_RESTORE_DELAY_MS);
    this.combatWeaponRestoreTimers.set(attackerId, timer);
  }

  private flushPendingBowRelease(
    playerId: string,
    controller: DynamicBowStringController,
  ): void {
    const pending = this.pendingBowReleases.get(playerId);
    if (!pending) return;
    this.pendingBowReleases.delete(playerId);

    const remainingMs =
      pending.receivedAtPerformanceMs + pending.delayMs - performance.now();
    // A replay after the projectile already spawned would manufacture false
    // continuity. The evidence gate allows 250ms of release/spawn skew, so
    // anything older is discarded and remains a visible certification failure.
    if (remainingMs < -250) return;
    controller.scheduleRelease(
      Math.max(0, remainingMs),
      pending.arrowId,
      pending.networkEventId,
    );
  }

  private restoreCombatHiddenWeapon(playerId: string): void {
    this.combatWeaponRestoreTimers.delete(playerId);
    if (!this.hiddenWeaponsCombat.has(playerId)) return;
    this.hiddenWeaponsCombat.delete(playerId);

    const equipment = this.playerEquipment.get(playerId);
    if (!equipment?.weapon) return;

    this.applyHeldEquipmentVisibility(playerId, equipment);
  }

  /** Detach every owned visual even if a resource's disposal listener fails. */
  private clearPlayerAttachmentObjects(playerId: string): unknown[] {
    const errors: unknown[] = [];
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    attempt(() => this.neutralShortsWearState.clear(playerId));
    const bow = this.dynamicBowStrings.get(playerId);
    this.dynamicBowStrings.delete(playerId);
    if (bow) attempt(() => bow.dispose());
    const heldPose = this.stableHeldEquipmentPoses.get(playerId);
    this.stableHeldEquipmentPoses.delete(playerId);
    if (heldPose) attempt(() => heldPose.dispose());
    for (const [key, controller] of this.twoHandEquipmentGrips) {
      if (key.startsWith(`${playerId}\u0000`)) {
        this.twoHandEquipmentGrips.delete(key);
        attempt(() => controller.dispose());
      }
    }
    const equipment = this.playerEquipment.get(playerId);
    this.playerEquipment.delete(playerId);
    if (equipment) {
      for (const slot of Object.keys(equipment)) {
        attempt(() =>
          removeEquipmentVisual(equipment as EquipmentVisualStore, slot),
        );
      }
    }
    return errors;
  }

  private cleanupPlayerEquipment(playerId: string): void {
    const errors = this.clearPlayerAttachmentObjects(playerId);
    this.pendingEquipment.delete(playerId);
    this.activeGatheringToolItemIds.delete(playerId);
    this.latestGatheringToolPresentationRevisions.delete(playerId);
    this.fishingInteractionStates.delete(playerId);
    this.latestFishingInteractionPresentationRevisions.delete(playerId);
    this.processingInteractionStates.delete(playerId);
    this.latestProcessingInteractionPresentationRevisions.delete(playerId);
    try {
      this.removeFishingWorldProp(playerId);
    } catch (error) {
      errors.push(error);
    }
    this.fishingWorldRequestVersions.delete(playerId);
    this.pendingBowReleases.delete(playerId);
    this.hiddenWeaponsCombat.delete(playerId);
    this.playerWeaponItemIds.delete(playerId);
    this.desiredEquipmentItemIds.delete(playerId);
    this.attachedEquipmentItemIds.delete(playerId);
    this.attachedEquipmentAvatarVrms.delete(playerId);
    for (const key of this.equipmentRequestVersions.keys()) {
      if (key.startsWith(`${playerId}\u0000`)) {
        this.equipmentRequestVersions.delete(key);
      }
    }
    const timer = this.combatWeaponRestoreTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.combatWeaponRestoreTimers.delete(playerId);
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Equipment cleanup failed for ${playerId}`,
      );
    }
  }

  private invalidatePlayerVisualAttachments(
    playerId: string,
    currentVrm?: VRM,
  ): void {
    if (currentVrm) {
      const errors: unknown[] = [];
      const equipment = this.playerEquipment.get(playerId);
      const owners = this.attachedEquipmentAvatarVrms.get(playerId);
      if (equipment && owners) {
        for (const [slot, owner] of owners) {
          if (owner !== currentVrm) {
            try {
              this.unequipVisual(playerId, slot, equipment);
            } catch (error) {
              errors.push(error);
            }
          }
        }
      }
      if (errors.length) {
        throw new AggregateError(
          errors,
          `Equipment replacement cleanup failed for ${playerId}`,
        );
      }
      return;
    }
    const errors = this.clearPlayerAttachmentObjects(playerId);
    this.attachedEquipmentItemIds.delete(playerId);
    this.attachedEquipmentAvatarVrms.delete(playerId);
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Equipment invalidation failed for ${playerId}`,
      );
    }
  }

  private acceptFishingInteractionPresentationRevision(
    playerId: string,
    revision: unknown,
  ): boolean {
    if (
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1 ||
      (revision as number) > Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }
    const numericRevision = revision as number;
    const latest =
      this.latestFishingInteractionPresentationRevisions.get(playerId);
    if (latest !== undefined && numericRevision <= latest) return false;
    this.latestFishingInteractionPresentationRevisions.set(
      playerId,
      numericRevision,
    );
    return true;
  }

  private hydrateFishingInteractionPresentationFromEntity(
    playerId: string,
  ): void {
    const player = this.world.entities.get(playerId) as
      | (PlayerWithAvatar & {
          data?: { fishingInteractionPresentation?: unknown };
        })
      | undefined;
    const state = player?.data?.fishingInteractionPresentation;
    if (!state || typeof state !== "object") return;
    const revision = (state as { revision?: unknown }).revision;
    if (
      !this.acceptFishingInteractionPresentationRevision(playerId, revision)
    ) {
      return;
    }
    void this.applyFishingInteractionPresentation(playerId, state);
  }

  private acceptProcessingInteractionPresentationRevision(
    playerId: string,
    revision: unknown,
  ): boolean {
    if (
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1 ||
      (revision as number) > Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }
    const numericRevision = revision as number;
    const latest =
      this.latestProcessingInteractionPresentationRevisions.get(playerId);
    if (latest !== undefined && numericRevision <= latest) return false;
    this.latestProcessingInteractionPresentationRevisions.set(
      playerId,
      numericRevision,
    );
    return true;
  }

  private hydrateProcessingInteractionPresentationFromEntity(
    playerId: string,
  ): void {
    const player = this.world.entities.get(playerId) as
      | (PlayerWithAvatar & {
          data?: { processingInteractionPresentation?: unknown };
        })
      | undefined;
    const state = normalizeProcessingInteractionPresentationState(
      player?.data?.processingInteractionPresentation,
    );
    if (
      !state ||
      !this.acceptProcessingInteractionPresentationRevision(
        playerId,
        state.revision,
      )
    ) {
      return;
    }
    this.applyProcessingInteractionPresentation(playerId, state);
  }

  private handleProcessingInteractionPresentation(
    data: { playerId: string } & Record<string, unknown>,
  ): void {
    if (typeof data.playerId !== "string") return;
    const playerId = data.playerId.trim();
    if (!playerId || playerId.length > 256) return;
    const { playerId: _playerId, ...rawState } = data;
    const state = normalizeProcessingInteractionPresentationState(rawState);
    if (
      !state ||
      !this.acceptProcessingInteractionPresentationRevision(
        playerId,
        state.revision,
      )
    ) {
      return;
    }
    this.applyProcessingInteractionPresentation(playerId, state);
  }

  private applyProcessingInteractionPresentation(
    playerId: string,
    state: ProcessingInteractionPresentationState,
  ): void {
    if (state.phase === "idle") {
      this.processingInteractionStates.delete(playerId);
      return;
    }
    this.processingInteractionStates.set(playerId, state);
  }

  private async handleFishingInteractionPresentation(
    data: { playerId: string } & Record<string, unknown>,
  ): Promise<void> {
    if (typeof data.playerId !== "string") return;
    const playerId = data.playerId.trim();
    if (!playerId) return;
    if (
      !this.acceptFishingInteractionPresentationRevision(
        playerId,
        data.revision,
      )
    ) {
      return;
    }
    await this.applyFishingInteractionPresentation(playerId, data);
  }

  private async applyFishingInteractionPresentation(
    playerId: string,
    value: unknown,
  ): Promise<void> {
    const state = normalizeFishingInteractionPresentationState(value);
    if (!state || state.phase === "idle") {
      this.fishingInteractionStates.delete(playerId);
      this.removeFishingWorldProp(playerId);
      const equipment = this.playerEquipment.get(playerId);
      if (equipment) this.applyHeldEquipmentVisibility(playerId, equipment);
      return;
    }

    this.fishingInteractionStates.set(playerId, state);
    const equipment = this.playerEquipment.get(playerId);
    if (equipment) this.applyHeldEquipmentVisibility(playerId, equipment);
    await this.syncFishingWorldProp(playerId, state);
  }

  private shouldShowFishingWorldProp(
    state: FishingInteractionPresentationState | undefined,
  ): state is FishingInteractionPresentationState & {
    itemId: "small_fishing_net" | "lobster_pot";
    interactionId: string;
    targetPosition: { x: number; y: number; z: number };
  } {
    return Boolean(
      state &&
      state.interactionId &&
      state.targetPosition &&
      (state.itemId === "small_fishing_net" ||
        state.itemId === "lobster_pot") &&
      (state.phase === "released" ||
        state.phase === "deployed" ||
        state.phase === "retrieving"),
    );
  }

  private nextFishingWorldRequestVersion(playerId: string): number {
    const next = (this.fishingWorldRequestVersions.get(playerId) ?? 0) + 1;
    this.fishingWorldRequestVersions.set(playerId, next);
    return next;
  }

  private removeFishingWorldProp(playerId: string): void {
    this.nextFishingWorldRequestVersion(playerId);
    const prop = this.fishingWorldProps.get(playerId);
    this.fishingWorldProps.delete(playerId);
    if (prop) {
      prop.object.removeFromParent();
      disposeEquipmentVisualMaterials(prop.object);
    }
  }

  private createFishingHeldTransitionVisual(
    playerId: string,
    itemId: "small_fishing_net" | "lobster_pot",
    worldTemplate: THREE.Object3D,
  ): THREE.Object3D | null {
    const heldTool = this.playerEquipment.get(playerId)?.gatheringtool;
    const fittedWrapper = heldTool?.getObjectByName("EquipmentWrapper");
    const placement = extractFishingWorldVisualPlacement(worldTemplate, itemId);
    if (!fittedWrapper || !placement) return null;

    const clone = cloneEquipmentVisualModel(fittedWrapper);
    const existing = extractEquipmentAttachmentData(clone);
    clone.userData.hyperia = {
      ...(existing ?? {}),
      fishingWorld: {
        schemaVersion: 1,
        itemId,
        placement: {
          positionOffset: [...placement.positionOffset],
          rotationEulerDegrees: [...placement.rotationEulerDegrees],
          scale: placement.scale,
        },
      },
    };
    return clone;
  }

  private replaceFishingWorldPropObject(
    prop: ActiveFishingWorldProp,
    replacement: THREE.Object3D,
    visualKind: ActiveFishingWorldProp["visualKind"],
  ): void {
    const previous = prop.object;
    if (previous === replacement) {
      prop.visualKind = visualKind;
      return;
    }
    replacement.position.copy(previous.position);
    replacement.quaternion.copy(previous.quaternion);
    replacement.scale.copy(previous.scale);
    replacement.visible = previous.visible;
    const parent = previous.parent;
    if (parent) {
      parent.add(replacement);
      parent.remove(previous);
    }
    prop.object = replacement;
    prop.visualKind = visualKind;
    disposeEquipmentVisualMaterials(previous);
  }

  private useFishingHeldTransitionVisual(
    playerId: string,
    prop: ActiveFishingWorldProp,
  ): boolean {
    if (prop.visualKind === "held_clone") return true;
    const replacement = this.createFishingHeldTransitionVisual(
      playerId,
      prop.itemId,
      prop.worldTemplate,
    );
    if (!replacement) return false;
    this.replaceFishingWorldPropObject(prop, replacement, "held_clone");
    return true;
  }

  private useFishingWorldModelVisual(prop: ActiveFishingWorldProp): void {
    if (prop.visualKind === "world_model") return;
    this.replaceFishingWorldPropObject(
      prop,
      cloneEquipmentVisualModel(prop.worldTemplate),
      "world_model",
    );
  }

  private getFishingHeldWorldTransform(playerId: string): {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  } {
    const equipment = this.playerEquipment.get(playerId);
    const heldTool = equipment?.gatheringtool;
    if (heldTool) {
      const fittedWrapper = heldTool.getObjectByName("EquipmentWrapper");
      const transformRoot = fittedWrapper ?? heldTool;
      transformRoot.updateWorldMatrix(true, false);
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      transformRoot.matrixWorld.decompose(position, quaternion, scale);
      return { position, quaternion, scale };
    }
    const player = this.world.entities.get(playerId) as
      (PlayerWithAvatar & { node?: THREE.Object3D }) | undefined;
    if (player?.node) {
      player.node.updateWorldMatrix(true, false);
      const position = player.node.getWorldPosition(new THREE.Vector3());
      position.y += 1.1;
      return {
        position,
        quaternion: player.node.getWorldQuaternion(new THREE.Quaternion()),
        scale: player.node.getWorldScale(new THREE.Vector3()),
      };
    }
    return {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
    };
  }

  private getFishingTransitionStartedAtPerformanceMs(
    state: FishingInteractionPresentationState,
    durationMs: number,
  ): number {
    const network = this.world.network as
      { getTime?: () => number } | undefined;
    const currentServerTimeSeconds = network?.getTime?.();
    const phaseStartedAtServerTimeMs = state.phaseStartedAtServerTimeMs;
    if (
      typeof currentServerTimeSeconds !== "number" ||
      !Number.isFinite(currentServerTimeSeconds) ||
      typeof phaseStartedAtServerTimeMs !== "number" ||
      !Number.isFinite(phaseStartedAtServerTimeMs)
    ) {
      return performance.now();
    }
    const elapsedMs = THREE.MathUtils.clamp(
      currentServerTimeSeconds * 1_000 - phaseStartedAtServerTimeMs,
      0,
      durationMs,
    );
    return performance.now() - elapsedMs;
  }

  private applyFishingWorldTransition(
    playerId: string,
    prop: ActiveFishingWorldProp,
    now: number,
  ): void {
    const transition = prop.transition;
    if (!transition) return;
    const elapsedMs = Math.max(0, now - transition.startedAtPerformanceMs);

    if (transition.kind === "release") {
      const held = this.getFishingHeldWorldTransform(playerId);
      if (elapsedMs <= transition.transferDelayMs) {
        transition.from.copy(held.position);
        transition.fromQuaternion.copy(held.quaternion);
        transition.fromScale.copy(held.scale);
        prop.object.position.copy(held.position);
        prop.object.quaternion.copy(held.quaternion);
        prop.object.scale.copy(held.scale);
        return;
      }
      if (!transition.anchorLocked) {
        transition.anchorLocked = true;
        transition.from.copy(held.position);
        transition.fromQuaternion.copy(held.quaternion);
        transition.fromScale.copy(held.scale);
      }
      const travelDurationMs = Math.max(
        1,
        transition.durationMs - transition.transferDelayMs,
      );
      const alpha = THREE.MathUtils.clamp(
        (elapsedMs - transition.transferDelayMs) / travelDurationMs,
        0,
        1,
      );
      prop.object.position.lerpVectors(transition.from, transition.to, alpha);
      prop.object.position.y +=
        4 * transition.arcHeightMetres * alpha * (1 - alpha);
      prop.object.quaternion.slerpQuaternions(
        transition.fromQuaternion,
        transition.toQuaternion,
        alpha,
      );
      prop.object.scale.lerpVectors(
        transition.fromScale,
        transition.toScale,
        alpha,
      );
      if (alpha >= 1) prop.transition = null;
      return;
    }

    if (elapsedMs <= transition.transferDelayMs) {
      prop.object.position.copy(transition.from);
      prop.object.quaternion.copy(transition.fromQuaternion);
      prop.object.scale.copy(transition.fromScale);
      return;
    }
    this.useFishingHeldTransitionVisual(playerId, prop);
    const held = this.getFishingHeldWorldTransform(playerId);
    transition.to.copy(held.position);
    transition.toQuaternion.copy(held.quaternion);
    transition.toScale.copy(held.scale);
    const travelDurationMs = Math.max(
      1,
      transition.durationMs - transition.transferDelayMs,
    );
    const alpha = THREE.MathUtils.clamp(
      (elapsedMs - transition.transferDelayMs) / travelDurationMs,
      0,
      1,
    );
    const eased = alpha * alpha * (3 - 2 * alpha);
    prop.object.position.lerpVectors(transition.from, transition.to, eased);
    prop.object.quaternion.slerpQuaternions(
      transition.fromQuaternion,
      transition.toQuaternion,
      eased,
    );
    prop.object.scale.lerpVectors(
      transition.fromScale,
      transition.toScale,
      eased,
    );
    if (alpha >= 1) prop.transition = null;
  }

  private configureFishingWorldProp(
    playerId: string,
    prop: ActiveFishingWorldProp,
    state: FishingInteractionPresentationState & {
      itemId: "small_fishing_net" | "lobster_pot";
    },
  ): void {
    if (!state.targetPosition || !state.interactionId) return;
    const previousPhase = prop.phase;
    if (
      state.phase === "deployed" ||
      (state.phase === "retrieving" && previousPhase !== "retrieving")
    ) {
      this.useFishingWorldModelVisual(prop);
    }
    const placement = extractFishingWorldVisualPlacement(
      prop.object,
      state.itemId,
    );
    if (!placement) return;
    const target = new THREE.Vector3(
      state.targetPosition.x + placement.positionOffset[0],
      state.targetPosition.y + placement.positionOffset[1],
      state.targetPosition.z + placement.positionOffset[2],
    );
    const targetQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(placement.rotationEulerDegrees[0]),
        THREE.MathUtils.degToRad(placement.rotationEulerDegrees[1]),
        THREE.MathUtils.degToRad(placement.rotationEulerDegrees[2]),
      ),
    );
    const targetScale = new THREE.Vector3().setScalar(placement.scale);

    const repeatedPhase = previousPhase === state.phase;
    prop.interactionId = state.interactionId;
    prop.phase = state.phase;
    prop.targetPosition.copy(target);
    if (repeatedPhase) return;

    if (state.phase === "released") {
      const held = this.getFishingHeldWorldTransform(playerId);
      const timing = FISHING_WORLD_TRANSFER_TIMING[state.itemId];
      prop.transition = {
        kind: "release",
        startedAtPerformanceMs: this.getFishingTransitionStartedAtPerformanceMs(
          state,
          FISHING_WORLD_RELEASE_DURATION_MS,
        ),
        durationMs: FISHING_WORLD_RELEASE_DURATION_MS,
        transferDelayMs: timing.releaseDelaySeconds * 1_000,
        arcHeightMetres: timing.releaseArcHeightMetres,
        anchorLocked: false,
        from: held.position,
        to: target.clone(),
        fromQuaternion: held.quaternion,
        toQuaternion: targetQuaternion.clone(),
        fromScale: held.scale,
        toScale: targetScale.clone(),
      };
      this.applyFishingWorldTransition(playerId, prop, performance.now());
      return;
    }
    if (state.phase === "retrieving") {
      const held = this.getFishingHeldWorldTransform(playerId);
      prop.transition = {
        kind: "retrieve",
        startedAtPerformanceMs: this.getFishingTransitionStartedAtPerformanceMs(
          state,
          FISHING_WORLD_RETRIEVE_DURATION_MS,
        ),
        durationMs: FISHING_WORLD_RETRIEVE_DURATION_MS,
        transferDelayMs:
          FISHING_WORLD_TRANSFER_TIMING.retrieve.pickupDelaySeconds * 1_000,
        arcHeightMetres: 0,
        anchorLocked: true,
        from: target.clone(),
        to: held.position,
        fromQuaternion: targetQuaternion.clone(),
        toQuaternion: held.quaternion,
        fromScale: targetScale.clone(),
        toScale: held.scale,
      };
      this.applyFishingWorldTransition(playerId, prop, performance.now());
      return;
    }
    prop.object.position.copy(target);
    prop.object.quaternion.copy(targetQuaternion);
    prop.object.scale.copy(targetScale);
    prop.transition = null;
  }

  private async syncFishingWorldProp(
    playerId: string,
    state: FishingInteractionPresentationState,
  ): Promise<void> {
    if (!this.shouldShowFishingWorldProp(state)) {
      this.removeFishingWorldProp(playerId);
      return;
    }

    const existing = this.fishingWorldProps.get(playerId);
    if (
      existing?.itemId === state.itemId &&
      existing.interactionId === state.interactionId
    ) {
      this.configureFishingWorldProp(playerId, existing, state);
      return;
    }

    this.removeFishingWorldProp(playerId);
    const requestVersion = this.nextFishingWorldRequestVersion(playerId);
    const model = await this.loadFishingWorldModel(playerId, state.itemId);
    const current = this.fishingInteractionStates.get(playerId);
    if (
      !model ||
      this.fishingWorldRequestVersions.get(playerId) !== requestVersion ||
      !this.shouldShowFishingWorldProp(current) ||
      current.revision !== state.revision ||
      current.interactionId !== state.interactionId ||
      current.itemId !== state.itemId
    ) {
      return;
    }

    const worldTemplate = model.scene;
    const heldTransitionVisual =
      state.phase === "released"
        ? this.createFishingHeldTransitionVisual(
            playerId,
            state.itemId,
            worldTemplate,
          )
        : null;
    const object =
      heldTransitionVisual ?? cloneEquipmentVisualModel(worldTemplate);
    let transferred = false;
    let ownedProp: ActiveFishingWorldProp | undefined;
    try {
      if (!extractFishingWorldVisualPlacement(object, state.itemId)) {
        const failureKey = `${state.itemId}:invalid_world_metadata`;
        if (!this.fishingWorldVisualFailures.has(failureKey)) {
          this.fishingWorldVisualFailures.add(failureKey);
          console.error(
            `[EquipmentVisual] Invalid fishing world metadata for ${state.itemId}`,
          );
        }
        return;
      }
      const scene = this.world.stage?.scene;
      if (!scene) return;
      const prop: ActiveFishingWorldProp = {
        interactionId: state.interactionId,
        itemId: state.itemId,
        phase: "idle",
        object,
        worldTemplate,
        visualKind: heldTransitionVisual ? "held_clone" : "world_model",
        targetPosition: new THREE.Vector3(),
        transition: null,
      };
      ownedProp = prop;
      this.fishingWorldProps.set(playerId, prop);
      scene.add(object);
      this.configureFishingWorldProp(playerId, prop, state);
      transferred = true;
    } finally {
      if (!transferred) {
        if (ownedProp && this.fishingWorldProps.get(playerId) === ownedProp) {
          // Configuration may replace the initial object with a transition
          // clone; release the currently owned prop, not just the first mesh.
          this.removeFishingWorldProp(playerId);
        } else {
          object.removeFromParent();
          disposeEquipmentVisualMaterials(object);
        }
      }
    }
  }

  private async loadFishingWorldModel(
    playerId: string,
    itemId: "small_fishing_net" | "lobster_pot",
  ): Promise<GLTF | null> {
    const cached = this.fishingWorldModelCache.get(itemId);
    if (cached) return cached;
    const pending = this.fishingWorldModelLoadPromises.get(itemId);
    if (pending) return pending;

    const generation = this.equipmentLoadGeneration;
    const load = (async (): Promise<GLTF | null> => {
      const fallback = this.getItemFromNetworkCache(playerId, "gatheringTool");
      const item = resolveEquipmentVisualData({
        itemId,
        fallbackItemData: fallback,
      });
      const modelPath = item?.modelPath;
      if (typeof modelPath !== "string" || !modelPath.startsWith("asset://")) {
        return null;
      }
      const assetsUrl = this.world.assetsUrl?.replace(/\/$/u, "") || "";
      const url = modelPath.replace("asset://", `${assetsUrl}/`);
      const file = await this.world.loader?.loadFile(url);
      if (!file) return null;
      const gltf = (await this.gltfParser.parseAsync(
        await file.arrayBuffer(),
        url,
      )) as GLTF;
      if (generation === this.equipmentLoadGeneration) {
        this.fishingWorldModelCache.set(itemId, gltf);
      }
      return gltf;
    })();
    this.fishingWorldModelLoadPromises.set(itemId, load);
    try {
      return await load;
    } catch (error) {
      const failureKey = `${itemId}:load_failed`;
      if (!this.fishingWorldVisualFailures.has(failureKey)) {
        this.fishingWorldVisualFailures.add(failureKey);
        console.error(
          `[EquipmentVisual] Failed to load fishing world model for ${itemId}:`,
          error,
        );
      }
      return null;
    } finally {
      if (this.fishingWorldModelLoadPromises.get(itemId) === load) {
        this.fishingWorldModelLoadPromises.delete(itemId);
      }
    }
  }

  private acceptGatheringToolPresentationRevision(
    playerId: string,
    revision: unknown,
  ): boolean {
    if (revision === undefined) {
      return !this.latestGatheringToolPresentationRevisions.has(playerId);
    }
    if (
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1 ||
      (revision as number) > Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }
    const numericRevision = revision as number;
    const latest = this.latestGatheringToolPresentationRevisions.get(playerId);
    if (latest !== undefined && numericRevision <= latest) return false;
    this.latestGatheringToolPresentationRevisions.set(
      playerId,
      numericRevision,
    );
    return true;
  }

  private hydrateGatheringToolPresentationFromEntity(playerId: string): void {
    const player = this.world.entities.get(playerId) as
      | (PlayerWithAvatar & {
          data?: {
            gatheringToolPresentation?: {
              revision?: unknown;
              itemId?: unknown;
            };
          };
        })
      | undefined;
    const state = player?.data?.gatheringToolPresentation;
    if (!state) return;
    if (
      !this.acceptGatheringToolPresentationRevision(playerId, state.revision)
    ) {
      return;
    }

    if (state.itemId === null) {
      this.applyGatheringToolHide(playerId);
      return;
    }
    if (
      typeof state.itemId !== "string" ||
      !state.itemId ||
      state.itemId !== state.itemId.trim() ||
      state.itemId.length > 128
    ) {
      this.applyGatheringToolHide(playerId);
      return;
    }
    this.activeGatheringToolItemIds.set(playerId, state.itemId);
    this.setDesiredEquipmentItem(playerId, "gatheringTool", state.itemId);
    this.removePendingEquipmentSlot(playerId, "gatheringTool");
  }

  /** Show a temporary tool while suppressing an incompatible combat loadout. */
  private async handleGatheringToolShow(data: {
    playerId: string;
    itemId: string;
    slot: string;
    revision?: number;
  }): Promise<void> {
    if (
      typeof data.playerId !== "string" ||
      typeof data.itemId !== "string" ||
      typeof data.slot !== "string"
    ) {
      return;
    }
    const playerId = data.playerId.trim();
    const itemId = data.itemId.trim();
    if (!playerId || !itemId || data.slot.toLowerCase() !== "weapon") return;
    if (
      !this.acceptGatheringToolPresentationRevision(playerId, data.revision)
    ) {
      return;
    }

    await this.applyGatheringToolShow(playerId, itemId);
  }

  private async applyGatheringToolShow(
    playerId: string,
    itemId: string,
  ): Promise<void> {
    const requestVersion = this.nextEquipmentRequestVersion(
      playerId,
      "gatheringTool",
    );
    this.activeGatheringToolItemIds.set(playerId, itemId);
    this.setDesiredEquipmentItem(playerId, "gatheringTool", itemId);
    this.removePendingEquipmentSlot(playerId, "gatheringTool");

    // Get player entity to access VRM
    const player = this.world.entities.get(playerId);
    if (!player) {
      return;
    }

    // Suppress an already-rendered combat loadout immediately, even when the
    // avatar or gathering-tool asset is not ready yet. This fails closed rather
    // than showing a sword/shield during mining, woodcutting, or fishing.
    const existingEquipment = this.playerEquipment.get(playerId);
    if (existingEquipment) {
      this.applyHeldEquipmentVisibility(playerId, existingEquipment);
    }

    const playerWithAvatar = player as PlayerWithAvatar;
    const avatarInstance = getAvatar(playerWithAvatar)?.instance;
    const vrm = avatarInstance?.raw?.userData?.vrm;

    if (!avatarInstance || !vrm) {
      // AVATAR_LOAD_COMPLETE replays only the still-active intent above.
      return;
    }

    // Get or create equipment visuals for this player
    if (!this.playerEquipment.has(playerId)) {
      this.playerEquipment.set(playerId, {});
    }
    const equipment = this.playerEquipment.get(playerId)!;
    this.applyHeldEquipmentVisibility(playerId, equipment);
    await this.equipVisual(
      playerId,
      "gatheringTool",
      itemId,
      equipment,
      vrm,
      requestVersion,
    );
    this.applyHeldEquipmentVisibility(playerId, equipment);
    const fishingState = this.fishingInteractionStates.get(playerId);
    if (fishingState) {
      await this.syncFishingWorldProp(playerId, fishingState);
    }
  }

  /**
   * Hide the temporary gathering tool when gathering stops
   *
   * This removes the gathering tool and restores any previously hidden weapon.
   */
  private handleGatheringToolHide(data: {
    playerId: string;
    slot: string;
    revision?: number;
  }): void {
    if (typeof data.playerId !== "string" || typeof data.slot !== "string") {
      return;
    }
    const playerId = data.playerId.trim();
    if (!playerId || data.slot.toLowerCase() !== "weapon") return;
    if (
      !this.acceptGatheringToolPresentationRevision(playerId, data.revision)
    ) {
      return;
    }

    this.applyGatheringToolHide(playerId);
  }

  private applyGatheringToolHide(playerId: string): void {
    // Clear intent before touching the scene so an in-flight model load or a
    // later avatar-ready callback cannot win this race.
    this.nextEquipmentRequestVersion(playerId, "gatheringTool");
    this.activeGatheringToolItemIds.delete(playerId);
    this.setDesiredEquipmentItem(playerId, "gatheringTool", null);
    this.removePendingEquipmentSlot(playerId, "gatheringTool");
    this.fishingInteractionStates.delete(playerId);
    this.removeFishingWorldProp(playerId);

    const equipment = this.playerEquipment.get(playerId);
    if (!equipment) {
      return;
    }

    this.unequipVisual(playerId, "gatheringTool", equipment);
    this.applyHeldEquipmentVisibility(playerId, equipment);
  }

  private removePendingEquipmentSlot(playerId: string, slot: string): void {
    const pending = this.pendingEquipment.get(playerId);
    if (!pending) return;
    const slotKey = slot.toLowerCase();
    const filtered = pending.filter(
      (entry) => entry.slot.toLowerCase() !== slotKey,
    );
    if (filtered.length > 0) this.pendingEquipment.set(playerId, filtered);
    else this.pendingEquipment.delete(playerId);
  }

  private applyHeldEquipmentVisibility(
    playerId: string,
    equipment: PlayerEquipmentVisuals,
  ): void {
    const player = this.world.entities.get(playerId) as
      PlayerWithAvatar | undefined;
    const playerData = player?.data as
      { emote?: unknown; e?: unknown; deathState?: unknown } | undefined;
    const showHeldEquipment = shouldRenderHeldEquipmentVisual({
      emote: playerData?.emote,
      abbreviatedEmote: playerData?.e,
      deathState: playerData?.deathState,
    });
    const gatheringToolActive = this.activeGatheringToolItemIds.has(playerId);
    const fishingState = this.fishingInteractionStates.get(playerId);
    const gatheringToolInWorld =
      this.shouldShowFishingWorldProp(fishingState) &&
      fishingState.itemId === this.activeGatheringToolItemIds.get(playerId);

    if (equipment.weapon) {
      equipment.weapon.visible =
        showHeldEquipment &&
        !gatheringToolActive &&
        !this.hiddenWeaponsCombat.has(playerId);
    }
    if (equipment.shield) {
      equipment.shield.visible = showHeldEquipment && !gatheringToolActive;
    }
    if (equipment.gatheringtool) {
      equipment.gatheringtool.visible =
        showHeldEquipment && gatheringToolActive && !gatheringToolInWorld;
    }
  }

  update(_dt: number): void {
    for (const [playerId, equipment] of this.playerEquipment.entries()) {
      this.applyHeldEquipmentVisibility(playerId, equipment);
    }
    for (const controller of this.stableHeldEquipmentPoses.values()) {
      controller.update();
    }
    for (const controller of this.twoHandEquipmentGrips.values()) {
      controller.update();
    }
    // Position and orient the bow before rebuilding its dependent string and
    // nocked-arrow geometry for this frame.
    for (const controller of this.dynamicBowStrings.values()) {
      controller.update();
    }
    const now = performance.now();
    for (const [playerId, prop] of this.fishingWorldProps) {
      this.applyFishingWorldTransition(playerId, prop, now);
    }

    // Process pending equipment for players whose VRM has now loaded
    for (const [playerId, pendingItems] of this.pendingEquipment.entries()) {
      if (pendingItems.length === 0) continue;

      const player = this.world.entities.get(playerId);
      if (!player) {
        // Player is gone, clear queue
        this.pendingEquipment.delete(playerId);
        continue;
      }

      const playerWithAvatar = player as PlayerWithAvatar;
      const resolvedAvatar = getAvatar(playerWithAvatar);
      const avatarInstance = resolvedAvatar?.instance;

      // CRITICAL: instance.raw is GLTF, VRM is in userData.vrm!
      const vrm = avatarInstance?.raw?.userData?.vrm as VRM | undefined;

      if (avatarInstance && vrm) {
        // VRM is now ready! Process all pending equipment
        // Process each pending item
        for (const { slot, itemId } of pendingItems) {
          if (slot.toLowerCase() === "gatheringtool") {
            if (this.activeGatheringToolItemIds.get(playerId) === itemId) {
              void this.handleGatheringToolShow({
                playerId,
                itemId,
                slot: "weapon",
              });
            }
            continue;
          }
          void this.handleEquipmentChange({ playerId, slot, itemId });
        }

        // Clear the queue
        this.pendingEquipment.delete(playerId);
      }
    }
  }

  destroy(): void {
    const errors: unknown[] = [];
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    this.equipmentLoadGeneration += 1;
    attempt(() => this.neutralShortsWearState.dispose());
    // Clean up all equipment
    for (const playerId of this.playerEquipment.keys()) {
      attempt(() => this.cleanupPlayerEquipment(playerId));
    }
    for (const playerId of this.fishingWorldProps.keys()) {
      attempt(() => this.removeFishingWorldProp(playerId));
    }
    // Controllers may outlive a failed/missing attachment; they still own resources.
    for (const controller of [
      ...this.dynamicBowStrings.values(),
      ...this.stableHeldEquipmentPoses.values(),
      ...this.twoHandEquipmentGrips.values(),
    ]) {
      attempt(() => controller.dispose());
    }

    // Clear all timers
    for (const timer of this.combatWeaponRestoreTimers.values()) {
      clearTimeout(timer);
    }

    // Clear cache and pending equipment
    this.weaponCache.clear();
    this.weaponLoadPromises.clear();
    this.pendingEquipment.clear();
    this.activeGatheringToolItemIds.clear();
    this.latestGatheringToolPresentationRevisions.clear();
    this.fishingInteractionStates.clear();
    this.latestFishingInteractionPresentationRevisions.clear();
    this.processingInteractionStates.clear();
    this.latestProcessingInteractionPresentationRevisions.clear();
    this.fishingWorldProps.clear();
    this.fishingWorldModelCache.clear();
    this.fishingWorldModelLoadPromises.clear();
    this.fishingWorldRequestVersions.clear();
    this.fishingWorldVisualFailures.clear();
    this.pendingBowReleases.clear();
    this.combatWeaponRestoreTimers.clear();
    this.hiddenWeaponsCombat.clear();
    this.dynamicBowStrings.clear();
    this.stableHeldEquipmentPoses.clear();
    this.twoHandEquipmentGrips.clear();
    this.playerWeaponItemIds.clear();
    this.desiredEquipmentItemIds.clear();
    this.attachedEquipmentItemIds.clear();
    this.attachedEquipmentAvatarVrms.clear();
    this.equipmentRequestVersions.clear();
    this.streamingVisualGeneration += 1;
    this.streamingVisualRequirements.clear();
    this.streamingVisualExpectations = [];
    this.streamingVisualCycleId = null;
    this.streamingVisualRequirementSignature = "";
    this.streamingVisualContractConfigured = false;

    attempt(() => super.destroy());
    if (errors.length) {
      throw new AggregateError(errors, "Equipment system teardown failed");
    }
  }
}
