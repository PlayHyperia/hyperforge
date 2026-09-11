/**
 * @hyperforge/shared - CLIENT ONLY
 *
 * Client-safe exports that don't include any Node.js-specific code
 */

// IMPORTANT: DO NOT export createServerWorld or any server systems here
// This entry point is specifically for browser/client builds

export { createClientWorld } from "./runtime/createClientWorld";
export { createViewerWorld } from "./runtime/createViewerWorld";
export {
  createEditorWorld,
  initEditorWorld,
  EditorWorld,
} from "./runtime/createEditorWorld";
export type { EditorWorldOptions } from "./runtime/createEditorWorld";
export { World } from "./core/World";
export {
  STREAMING_RENDER_PROFILES,
  resolveExplicitStreamingRenderProfile,
  resolveStreamingRenderFrameRate,
  resolveStreamingRenderPreferences,
  evaluateStreamingRenderProfileApplication,
  type StreamingRenderPreferences,
  type StreamingRenderAppliedState,
  type StreamingRenderProfileApplication,
  type StreamingRenderProfile,
  type StreamingRenderProfileId,
} from "./runtime/clientViewportMode";

// Export editor systems
export {
  EditorCameraSystem,
  EditorSelectionSystem,
  EditorGizmoSystem,
} from "./systems/editor";
export type {
  EditorCameraMode,
  EditorCameraConfig,
  CameraBookmark,
  Selectable,
  SelectionChangeEvent,
  EditorSelectionConfig,
  TransformMode,
  TransformSpace,
  TransformEvent,
  EditorGizmoConfig,
} from "./systems/editor";

// Export entity classes
export { Entity } from "./entities/Entity";
export type { EventCallback } from "./entities/Entity";
export { PlayerLocal } from "./entities/player/PlayerLocal";
export { PlayerRemote } from "./entities/player/PlayerRemote";

// Export System class from core systems
export { System } from "./systems/shared";

// Export all types from types/index.ts
export type {
  Anchors,
  Chat,
  ChatMessage,
  Component,
  // Entity Component System Types
  Entity as EntityInterface,
  Events,
  // UI and control types
  HotReloadable,
  Matrix4,
  // Network Types
  NetworkConnection,
  // Physics Types
  PhysicsOptions,
  // Player Types
  Player,
  PlayerInput,
  PlayerStats,
  Quaternion,
  // Additional system interfaces
  Settings,
  Stage,
  // System Types
  System as SystemInterface,
  // Math Types
  Vector3,
  World as WorldInterface,
  // Core World Types
  WorldOptions,
  // Additional interfaces without corresponding classes
  ClientMonitor,
  ServerDB,
} from "./types/index";

// Export EventType enum
export { EventType } from "./types/events";

// Export PlayerMigration
export { PlayerMigration } from "./types/core/core";

// Export enums (these are values, not types)
export { WeaponType, EquipmentSlotName } from "./types/core/core";

// Weapon style configuration (rules-accurate style restrictions per weapon)
export {
  WEAPON_STYLE_CONFIG,
  getAvailableStyles,
  isStyleValidForWeapon,
  getDefaultStyleForWeapon,
} from "./constants/WeaponStyleConfig";

// Export db helpers and type guards for server usage
export { dbHelpers, isDatabaseInstance } from "./types/network/database";

// Export role utilities
export {
  addRole,
  removeRole,
  hasRole,
  serializeRoles,
  uuid,
} from "./utils/index";

// Export ID generation utilities (for transaction tracking, etc.)
export { generateTransactionId } from "./utils/IdGenerator";
export {
  deriveStreamingGuardrailReason,
  hasValidStreamingGuardrailAgentSnapshot,
  hasValidStreamingGuardrailArenaPositions,
  isActiveStreamingGuardrailPhase,
  requiresStreamingArenaPositions,
} from "./utils/rendering/streamingGuardrails";
export type {
  StreamingGuardrailAgentSnapshot,
  StreamingGuardrailArenaPositions,
  StreamingGuardrailPhase,
} from "./utils/rendering/streamingGuardrails";
export {
  AVATAR_AUTHORED_MOTION_ACTION_LIMIT,
  AVATAR_AUTHORED_MOTION_SCHEMA_VERSION,
  AVATAR_AUTHORED_MOTION_URL_MAX_LENGTH,
  sanitizeAvatarAuthoredMotionUrl,
} from "./extras/three/AvatarAuthoredMotionDiagnostics";
export type {
  AvatarAuthoredMotionActionDiagnostics,
  AvatarAuthoredMotionDiagnostics,
} from "./extras/three/AvatarAuthoredMotionDiagnostics";

// Export the exact privacy-safe public duel action observation contract.
export {
  STREAMING_DUEL_ACTION_OBSERVATION_LIMIT,
  STREAMING_DUEL_ACTION_OBSERVATION_SCHEMA_VERSION,
  STREAMING_DUEL_PUBLIC_COMBAT_ROLES,
  STREAMING_DUEL_PUBLIC_PRAYERS,
  STREAMING_DUEL_PUBLIC_STYLES,
  STREAMING_DUEL_PUBLIC_TACTICAL_MACROS,
  parseStreamingDuelActionObservation,
  parseStreamingDuelDamageObservationContext,
  parseStreamingDuelExecutorObservationContext,
  parseStreamingDuelFoodObservationContext,
  parseStreamingDuelPrayerObservationContext,
  parseStreamingDuelRoleSwitchObservationContext,
  parseStreamingDuelStyleObservationContext,
} from "./types/game/streaming-duel-action-observation";
export {
  DUEL_PREPARATION_COMBAT_ROLES,
  DUEL_PREPARATION_ROLE_POLICY_VERSION,
  EXTERNAL_DUEL_PREPARATION_MODEL,
  EXTERNAL_DUEL_PREPARATION_MODEL_PROVIDER,
  EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
  MAX_EXTERNAL_DUEL_PREPARATION_ARMOR_OPTIONS,
  MAX_EXTERNAL_DUEL_PREPARATION_OPPONENT_HISTORY,
  MAX_EXTERNAL_DUEL_PREPARATION_FOOD_OPTIONS,
  MAX_EXTERNAL_DUEL_PREPARATION_PLAN_OPTIONS,
  normalizeExternalDuelPreparationPlanStrategyDecision,
  normalizeExternalDuelPreparationPublicName,
  normalizeExternalDuelPreparationOpponentHistorySummary,
  normalizeExternalDuelPreparationPublicProfile,
  normalizeExternalDuelPreparationStrategyDecision,
  normalizeExternalDuelPreparationStrategyRequest,
  normalizeExternalDuelPreparationStrategyResponse,
  normalizeExternalDuelPreparationTacticalStrategy,
} from "./types/game/external-duel-preparation-strategy";
export type {
  DuelPreparationBoundedStrategyDecision,
  DuelPreparationCombatRole,
  ExternalDuelPreparationArmorOption,
  ExternalDuelPreparationOpponentHistoryEntry,
  ExternalDuelPreparationOpponentHistorySummary,
  ExternalDuelPreparationFoodOption,
  ExternalDuelPreparationPlanOption,
  ExternalDuelPreparationPublicProfile,
  ExternalDuelPreparationStrategyDecision,
  ExternalDuelPreparationStrategyRequest,
  ExternalDuelPreparationStrategyResponse,
  ExternalDuelPreparationTacticalStrategy,
} from "./types/game/external-duel-preparation-strategy";
export type {
  StreamingDuelActionObservation,
  StreamingDuelDamageObservationContext,
  StreamingDuelExecutorObservationContext,
  StreamingDuelFoodObservationContext,
  StreamingDuelPrayerObservationContext,
  StreamingDuelRoleSwitchObservationContext,
  StreamingDuelStyleObservationContext,
  StreamingDuelPublicCombatRole,
  StreamingDuelPublicPrayer,
  StreamingDuelPublicStyle,
  StreamingDuelPublicTacticalMacro,
} from "./types/game/streaming-duel-action-observation";

// Export the strict frozen strategy summary disclosed to duel spectators.
export {
  STREAMING_DUEL_PUBLIC_STRATEGY_APPROACHES,
  STREAMING_DUEL_PUBLIC_STRATEGY_ATTACK_STYLES,
  STREAMING_DUEL_PUBLIC_STRATEGY_SOURCES,
  STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
  parseStreamingDuelStrategySummary,
} from "./types/game/streaming-duel-strategy-summary";
export type {
  StreamingDuelPublicStrategyApproach,
  StreamingDuelPublicStrategyAttackStyle,
  StreamingDuelPublicStrategySource,
  StreamingDuelStrategySummary,
} from "./types/game/streaming-duel-strategy-summary";

// Export the strict public status for the selected pre-market contestants.
export {
  STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION,
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT,
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES,
  STREAMING_DUEL_PUBLIC_PREPARATION_MODES,
  STREAMING_DUEL_PUBLIC_PREPARATION_STATUSES,
  parseStreamingDuelPreparationSummary,
} from "./types/game/streaming-duel-preparation-summary";
export type {
  StreamingDuelPreparationContestantSummary,
  StreamingDuelPreparationSummary,
  StreamingDuelPublicPreparationActivity,
  StreamingDuelPublicPreparationMode,
  StreamingDuelPublicPreparationStatus,
} from "./types/game/streaming-duel-preparation-summary";

// Export the strict, privacy-safe preparation processing presentation contract.
export {
  PROCESSING_SKILLS,
  isProcessingSkill,
  normalizeProcessingInteractionPresentationState,
  resolveProcessingInteractionBodyEmote,
} from "./types/game/processing-interaction-presentation";
export type {
  ProcessingInteractionPresentationPhase,
  ProcessingInteractionPresentationState,
  ProcessingInteractionTargetPosition,
} from "./types/game/processing-interaction-presentation";

// Export death/loot types for shadow state and transaction tracking
export type {
  LootResult,
  LootFailureReason,
  PendingLootTransaction,
} from "./types/death";

// Export tile utilities (used for classic MMORPG-style tile-based distance checks)
export {
  worldToTile,
  tileToWorld,
  tilesEqual,
  tilesAdjacent,
  tilesWithinRange,
  TILE_SIZE,
  parseTileKey,
  type TileCoord,
} from "./systems/shared/movement/TileSystem";

// Export item helpers used by server network snapshot
export { ITEMS, getItem } from "./data/items";

// Item type detection helpers (rules-accurate inventory actions)
export {
  isFood,
  isPotion,
  isBone,
  isWeapon,
  isShield,
  usesWield,
  usesWear,
  isNotedItem,
  getPrimaryAction,
  getPrimaryActionFromManifest,
  HANDLED_INVENTORY_ACTIONS,
} from "./utils/item-helpers";
export type { PrimaryActionType } from "./utils/item-helpers";

// Context menu colors (rules-accurate styling)
export { CONTEXT_MENU_COLORS } from "./constants/GameConstants";

// Home teleport constants (cooldown, cast time)
export { HOME_TELEPORT_CONSTANTS } from "./constants/GameConstants";

// Inventory constants (slot counts, stack sizes)
export { INVENTORY_CONSTANTS } from "./constants/GameConstants";

// Player constants (health, stamina, speeds)
export { PLAYER_CONSTANTS } from "./constants/GameConstants";

// Terrain constants (water threshold, walkable slopes) — single source of truth
export { TERRAIN_CONSTANTS } from "./constants/GameConstants";

// Client input constants (click-to-move distance, drag threshold, raycast range)
export { INPUT } from "./systems/client/interaction/constants";

// Export avatar options for character creation and duel identity
export {
  AVATAR_OPTIONS,
  CANONICAL_DUEL_AVATAR_ID,
  CANONICAL_DUEL_AVATAR_URL,
  DEFAULT_AVATAR_URL,
  getAvatarByUrl,
  getDuelAvatarUrlForStyle,
} from "./data/avatars";
export { DIAGNOSTIC_AVATAR_OPTIONS } from "./data/avatars";
export type { AvatarOption, DuelAvatarStyle } from "./data/avatars";

// Export skill data for UI displays
export {
  SKILL_ICONS,
  getSkillIcon,
  SKILL_DEFINITIONS,
  getSkillDefinition,
  getSkillsByCategory,
  type SkillDefinition,
  type SkillCategory,
} from "./data/skill-icons";

// Export skill unlocks for level-up notifications
export {
  SKILL_UNLOCKS,
  getUnlocksAtLevel,
  getUnlocksUpToLevel,
  getUnlocksForSkill,
  getAllSkillUnlocks,
  clearSkillUnlocksCache,
  loadSkillUnlocks,
  isSkillUnlocksLoaded,
  resetSkillUnlocks,
} from "./data/skill-unlocks";
export type {
  SkillUnlock,
  UnlockType,
  SkillUnlocksManifest,
} from "./data/skill-unlocks";

// Export prayer data provider for UI panels
export { prayerDataProvider } from "./data/PrayerDataProvider";
export type {
  PrayerDefinition,
  PrayerCategory,
} from "./data/PrayerDataProvider";

// Export spell service for magic spellbook UI
export { spellService } from "./systems/shared/combat/SpellService";
export type { Spell } from "./systems/shared/combat/SpellService";

// Export CLIENT system classes only (NO SERVER SYSTEMS)
export { Entities } from "./systems/shared";
export { Physics } from "./systems/shared";
export { Particles } from "./systems/shared";
export { LODs } from "./systems/shared";
export { ClientInterface } from "./systems/client/ClientInterface"; // UI state, preferences, stats display
export { ClientLoader } from "./systems/client/ClientLoader";
export { Environment } from "./systems/shared";
export { ClientNetwork } from "./systems/client/ClientNetwork";
export { ClientGraphics } from "./systems/client/ClientGraphics";
export { ClientRuntime } from "./systems/client/ClientRuntime"; // Client lifecycle and diagnostics
export { ClientAudio } from "./systems/client/ClientAudio";
export { ClientLiveKit } from "./systems/client/ClientLiveKit";
export { ClientInput } from "./systems/client/ClientInput";
export {
  attachEquipmentVisualToVRM,
  createDynamicBowStringController,
  extractEquipmentAttachmentData,
  hasValidDynamicBowString,
  isSkinnedEquipmentSkeletonCompatible,
  removeEquipmentVisual,
  resolveEquipmentVisualData,
  resolveEquipmentVisualUrls,
  shouldRenderHeldEquipmentVisual,
  validateStreamingEquipmentVisualModel,
} from "./systems/client/EquipmentVisualHelpers";
export type {
  DuelEquipmentFitData,
  DynamicBowStringController,
  DynamicBowStringData,
  DynamicBowStringTransition,
  EquipmentAttachmentData,
  EquipmentVisualModelData,
  EquipmentVisualStore,
  EquipmentVisualUrlResolution,
  HeldEquipmentVisualState,
  StreamingEquipmentVisualValidation,
  StreamingEquipmentVisualValidationReason,
} from "./systems/client/EquipmentVisualHelpers";
export {
  EquipmentVisualSystem,
  STREAMING_DUEL_INTENTIONALLY_INVISIBLE_EQUIPMENT_SLOTS,
  STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOTS,
  isStreamingDuelVisibleEquipmentSlot,
} from "./systems/client/EquipmentVisualSystem";
export type {
  StreamingDuelEquipmentVisualContract,
  StreamingDuelBowPresentationDiagnostics,
  StreamingDuelBowTransitionEvent,
  StreamingDuelEquipmentVisualExpectation,
  StreamingDuelEquipmentVisualLoadStatus,
  StreamingDuelEquipmentVisualReadiness,
  StreamingDuelEquipmentVisualRequirement,
  StreamingDuelVisibleEquipmentSlot,
} from "./systems/client/EquipmentVisualSystem";
export type {
  StreamingArrowVisualCancellationEvent,
  StreamingArrowVisualImpactEvent,
  StreamingArrowVisualSpawnEvent,
  StreamingProjectileVisualDiagnostics,
} from "./systems/client/ProjectileRenderer";
export type {
  StreamingDamagePresentationDiagnostics,
  StreamingDamagePresentationEvent,
} from "./systems/client/DamageSplatSystem";
export { ClientActions } from "./systems/client/ClientActions";
export { DevStats } from "./systems/client/DevStats"; // FPS counter and dev performance telemetry
export {
  classifyStreamResourceCategory,
  StreamPerformanceTelemetry,
  normalizeStreamingPerformanceSnapshot,
} from "./systems/client/StreamPerformanceTelemetry";
export type {
  StreamFramePerformanceSnapshot,
  StreamLongFrameSample,
  StreamPerformanceFrameSample,
  StreamRendererMetricSnapshot,
  StreamResourceCategory,
  StreamResourceMetricSnapshot,
  StreamResourcePerformanceSnapshot,
  StreamPerformanceResourceSample,
  StreamingPerformanceSnapshot,
} from "./systems/client/StreamPerformanceTelemetry";
export { EventBus } from "./systems/shared";
export { System as SystemClass } from "./systems/shared";
export { SystemBase } from "./systems/shared";
export { PendingActionTracker } from "./systems/client/network/PendingActionTracker";

// Export node client components directly from their source modules (NOT ServerLoader, ServerRuntime, ServerLiveKit)
export { createNodeClientWorld } from "./runtime/createNodeClientWorld";
export { NodeClient } from "./systems/client/NodeClient";
// Environment system works in both browser and Node contexts
export { Node } from "./nodes/Node";
// Re-export commonly used node classes to satisfy API extractor
export { UI } from "./nodes/UI";
export { UIView } from "./nodes/UIView";
export { UIText } from "./nodes/UIText";
export { Group } from "./nodes/Group";
export { Mesh } from "./nodes/Mesh";
export { Avatar } from "./nodes/Avatar";
// Export client-only storage (no Node.js dependencies)
export { storage, LocalStorage } from "./platform/shared/storage";
export {
  loadPhysX,
  waitForPhysX,
  getPhysX,
  isPhysXReady,
} from "./physics/PhysXManager";

// Export renderer utilities (WebGPU only - no WebGL fallback)
export {
  createRenderer,
  configureRenderer,
  configureShadowMaps,
  type WebGPURenderer,
  type RendererOptions,
} from "./utils/rendering/RendererFactory";

export {
  createPostProcessing,
  type PostProcessingComposer,
} from "./utils/rendering/PostProcessingFactory";

// Material and mesh optimizations
export {
  optimizeMaterialForWebGPU,
  createOptimizedInstancedMesh,
  getWebGPUCapabilities,
  logWebGPUInfo,
} from "./utils/rendering/RendererFactory";

export {
  isNumber,
  isBoolean,
  isString,
  isObject,
  isArray,
  isValidColor,
  isValidUrl,
  validatePosition,
  calculateDistance,
  calculateDistance2D,
} from "./utils/ValidationUtils";

export { isTouch, cls, hashFile } from "./platform/client/utils-client";
export { ReactiveVector3 } from "./extras/animation/ReactiveVector3";
export { createEmoteFactory } from "./extras/three/createEmoteFactory";
export { createNode } from "./extras/three/createNode";
export { glbToNodes } from "./extras/three/glbToNodes";
export { Emotes } from "./data/playerEmotes";
export { ALL_WORLD_AREAS, STARTER_TOWNS } from "./data/world-areas";
export {
  DUEL_RULE_DEFINITIONS,
  DUEL_RULE_LABELS,
  EQUIPMENT_SLOT_DEFINITIONS,
  EQUIPMENT_SLOT_LABELS,
  EQUIPMENT_SLOTS_ORDERED,
  VALID_DUEL_RULE_KEYS,
  DUEL_EQUIPMENT_SLOT_KEYS,
  isValidDuelRuleKey,
  isValidEquipmentSlot,
  getIncompatibleRules,
  areRulesCompatible,
  getCombatArenaBoundsContainingPositions,
  isPositionInsideCombatArena,
  type DuelRuleDefinition,
  type EquipmentSlotDefinition,
  type DuelEquipmentSlot,
  type DuelCombatArenaBounds,
} from "./data/duel-manifest";
export { ControlPriorities } from "./systems/client/ControlPriorities";
export { downloadFile } from "./utils/downloadFile";
export { Curve } from "./extras/animation/Curve";
export { buttons, propToLabel } from "./extras/ui/buttons";
// GLTFLoader export disabled due to TypeScript declaration generation issues
// Users can import it directly: import { GLTFLoader } from './libs/gltfloader/GLTFLoader';

// NOTE: CSM (WebGL) removed - use CSMShadowNode from three/addons/csm/CSMShadowNode.js for WebGPU

// PhysX asset path helper function
export function getPhysXAssetPath(assetName: string): string {
  // In the browser, serve assets from CDN /web/ directory
  if (typeof window !== "undefined") {
    return `/web/${assetName}`;
  }
  // In Node.js, compute path relative to this module using URL without importing node:path
  try {
    const here = new URL(import.meta.url);
    const vendorUrl = new URL(`../vendor/${assetName}`, here);
    // pathname is fine for local filesystem access in Node
    return vendorUrl.pathname;
  } catch {
    return assetName;
  }
}

// Export THREE namespace as a default-only module export
export { default as THREE } from "./extras/three/three";
export { BorrowedMaterialEnvironment } from "./extras/three/BorrowedMaterialEnvironment";
export { fitBoundedDirectionalShadow } from "./extras/three/BoundedDirectionalShadow";

// Export Vector3 compatibility utilities for plugin use
export {
  toTHREEVector3,
  assignVector3,
  cloneVector3,
  createVector3,
  toVector3Object,
  isVector3Like,
} from "./extras/animation/vector3-compatibility";

// Export PhysX types
export type {
  PxVec3,
  PxTransform,
  PxQuat,
  PxSphereGeometry,
  PxCapsuleGeometry,
} from "./types/systems/physics";
export type {
  PxScene,
  PxFoundation,
  PxTolerancesScale,
  PxCookingParams,
  PxPhysics,
  PxMaterial,
  PxRaycastResult,
  PxSweepResult,
  PxOverlapResult,
  PxControllerManager,
  PxControllerFilters,
  PxActor,
  PxRigidDynamic,
  PxRigidStatic,
  PxRigidBody,
  PxShape,
  PxGeometry,
  PxDefaultAllocator,
  PxDefaultErrorCallback,
  PxQueryFilterData,
} from "./types/systems/physics";

// Re-export types referenced by API Extractor warnings
export type { PhysXInfo, PhysXModule } from "./types/systems/physics";
export type {
  InterpolatedPhysicsHandle,
  NonInterpolatedPhysicsHandle,
} from "./types/systems/physics";
// Re-export specific core types referenced by entity declarations
export type {
  PlayerDeathData,
  Player as PlayerCore,
  PlayerHealth,
  PlayerStamina,
  PlayerPosition,
  Skills,
  PlayerEquipmentItems,
  PlayerCombatData,
  SystemConfig,
  SkillData,
  MovementComponent,
  InventoryItem,
  Item,
  Inventory,
  PlayerEquipment,
  AttackType,
  CombatStyle,
  ItemType,
  ItemRarity,
  CombatBonuses,
  EquipmentSlot,
} from "./types/core/core";
export type { Physics as PhysicsInterface } from "./types/index";
// Re-export UI-related types used by UIView/UIText/UI
export type {
  UIData,
  UIViewData,
  DisplayType,
  EdgeValue,
  FlexBasis,
  UIContext,
  UISceneItem,
  UIYogaNode,
} from "./types/rendering/nodes";
export type { NodeData, Position3D } from "./types/index";
// Re-export extras used by PlayerRemote and others
export { LerpVector3 } from "./extras/animation/LerpVector3";
export { LerpQuaternion } from "./extras/animation/LerpQuaternion";
// Re-export core utility types referenced by declarations
export type { RaycastHit, NetworkData } from "./types/index";
// Re-export entity configuration types
export type { EntityConfig, EntityInteractionData } from "./types/entities";
// Re-export GLB typing used by createEmoteFactory
export type { GLBData } from "./types/index";
// Re-export storage types (client-only)
export type { Storage } from "./platform/shared/storage";
// NodeStorage is only available from the main index (server-side)
// Re-export nodes namespace for createNode typings
export * as Nodes from "./nodes";

// Export additional UI/node types used by various node declarations
export type {
  UITextData,
  TextAlign,
  FontWeight,
  UIImageData,
  UIPointerEvent,
  UIWheelEvent,
  RigidBodyData,
  MeshData,
  SkinnedMeshData,
  SkyData,
  ActionData,
  DistanceModelType,
  LODItem,
  LODNode,
  LODData,
  AvatarData,
  VRMAvatarFactory,
  AvatarHooks,
  VRMAvatarInstance,
  ControllerData,
  ColliderData,
  JointData,
  ParticlesData,
  PhysicsTriggerEvent,
  PhysicsContactEvent,
  JointLimits,
  JointDrive,
  PhysXActor,
  PhysXController,
  PhysXJoint,
  PxJointLimitCone,
  PxConstraintFlag,
  PxJointAngularLimitPair,
  PxRigidBodyFlag,
  PhysXMoveFlags,
  AudioData,
  ImageData,
} from "./types/rendering/nodes";

export type {
  ActorHandle,
  PxControllerCollisionFlags,
  PxRigidBodyFlagEnum,
} from "./types/systems/physics";
export type { PhysXShape, PhysXMesh } from "./systems/shared";

// Export Node internal types
export type { NodeProxy, NodeStats } from "./nodes/Node";

// Export LooseOctree internal types
export type {
  LooseOctreeNode,
  OctreeHelper,
  LooseOctreeOptions,
} from "./utils/physics/LooseOctree";

// Export additional system and event types
export type { SystemConstructor, SystemDependencies } from "./systems/shared";
export type {
  EventSubscription,
  SystemEvent,
  EventHandler,
} from "./systems/shared";
export type {
  EventMap,
  ProcessingRequestCommitStatus,
  ProcessingProgressPhase,
  ProcessingRejectionReason,
  ProcessingRequestProgressPayload,
  ProcessingRequestRejectedPayload,
  ProcessingRequestStatusPayload,
  ProcessingRequestEnvelope,
  RecoverableProcessingRequest,
  RecoverableProcessingRequestStatus,
  ProcessingSkill,
} from "./types/events";
export {
  getProcessingRequestOperationId,
  normalizeProcessingRequestEnvelope,
  normalizeProcessingRequestId,
} from "./types/events";
export type {
  AnyEvent,
  EventType as EventTypeEnum,
  EventPayloads,
} from "./types/events";
export type { LoaderResult } from "./types/index";
export type { ComponentDefinition, EntityData } from "./types/index";
export type { Entities as EntitiesInterface } from "./types/index";
export type { SystemLogger } from "./utils/Logger";

// Export network/system interface types
export type { NetworkSystem } from "./types/systems/system-interfaces";
export type { IEventsInterface } from "./systems/shared";

// Export Client Interface types
export type {
  ClientUIState,
  PrefsKey,
  PrefsValue,
  ClientPrefsData,
} from "./systems/client/ClientInterface";
export type { ChatListener } from "./systems/shared";
export type { UIProxy } from "./types/rendering/nodes";

// Export Panel utility
export { default as Panel } from "./libs/stats-gl/panel";

// Export ClientActions internal handler type
export type { ClientActionHandler } from "./systems/client/ClientActions";

// Export alternate HotReloadable and RaycastHit for nodes/UI references
// Export HotReloadable from physics as well (needed by PlayerLocal)
export type { HotReloadable as HotReloadable_2 } from "./types/systems/physics";

// Export environment and stage types
export type {
  BaseEnvironment,
  EnvironmentModel,
  SkyHandle,
  SkyInfo,
  SkyNode,
} from "./types/index";
export { LooseOctree } from "./utils/physics/LooseOctree";
export type {
  MaterialWrapper,
  InsertOptions,
  StageHandle,
  MaterialOptions,
} from "./systems/shared";
export type {
  OctreeItem,
  ExtendedIntersection,
  RenderHelperItem,
  GeometryPhysXMesh,
} from "./types/systems/physics";
export type {
  ParticleEmitter,
  EmitterNode,
  ParticleMessage,
  ParticleMessageData,
} from "./types/rendering/particles";

// Export client audio types
export type { AudioGroupGains } from "./types/index";

// Export control types
export type {
  ControlBinding,
  ControlsBinding,
  ControlAction,
  TouchInfo,
  ControlEntry,
  ButtonEntry,
  MouseInput,
  ValueEntry,
  VectorEntry,
  ScreenEntry,
  PointerEntry,
  InputState,
} from "./types/index";

// Export entity and interaction types
export type {
  BaseEntityProperties,
  EntityType,
  InteractionType,
} from "./types/entities";

// Export event payloads namespace
export * as Payloads from "./types/events";

// Export additional core types
export type { SkillsData } from "./types/systems/system-interfaces";
export type {
  HealthComponent,
  VisualComponent,
  EntityCombatComponent,
  PlayerCombatStyle,
} from "./types/entities";
export type { GroupType } from "./types/rendering/nodes";
export type { InventoryItemInfo } from "./types/events";
export type { MaterialProxy } from "./types/rendering/materials";

// Export database/event types
export type {
  InventoryCanAddEvent,
  InventoryRemoveCoinsEvent,
  InventoryCheckEvent,
  InventoryHasEquippedEvent,
  BankDepositEvent,
  BankWithdrawEvent,
  BankDepositSuccessEvent,
  UIMessageEvent,
  StoreOpenEvent,
  StoreCloseEvent,
  StoreBuyEvent,
  StoreSellEvent,
} from "./types/events";

// Export settings data
export type { SettingsData } from "./types/index";

// Export SystemDatabase and TypedKnexDatabase to fix API Extractor warnings
export type {
  SystemDatabase,
  TypedKnexDatabase,
  ConfigRow,
  UserRow,
  EntityRow,
  DatabaseRow,
  InventoryDebitRequirement,
  InventoryDebitCommitRequest,
  InventoryDebitCommitReceipt,
  GroundItemSourceStatus,
  GroundItemSourceState,
  GroundItemSourceRegistrationRequest,
  GroundItemSourceRegistrationReceipt,
  GroundItemDropCommitRequest,
  GroundItemDropCommitReceipt,
  GroundItemDeathCommitRequest,
  GroundItemDeathCommitReceipt,
  GroundItemPickupCommitRequest,
  GroundItemPickupCommitReceipt,
  FoodConsumptionOperationStatus,
  FoodConsumptionCompletionReason,
  FoodConsumptionCommitRequest,
  FoodConsumptionCompleteRequest,
  FoodConsumptionCommitReceipt,
  DuelDamageCompetitiveAuthority,
  DuelDamageCompetitiveTerminal,
  DuelDamageCommitRequest,
  DuelDamageCommitReceipt,
  BoneBurialCommitRequest,
  BoneBurialCommitReceipt,
  QuestRewardSkill,
  QuestCompletionRewardItem,
  QuestStartRewardItem,
  QuestStartCommitRequest,
  QuestStartCommitReceipt,
  QuestCompletionRewardXp,
  QuestCompletionProgressReceipt,
  QuestCompletionCommitRequest,
  QuestCompletionCommitReceipt,
  EquipmentStackDebitCommitRequest,
  EquipmentStackDebitCommitReceipt,
  AmmunitionRecoveryDisposition,
  AmmunitionShotCommitRequest,
  AmmunitionShotCommitReceipt,
  StreamingDuelExecutorCommand,
  StreamingDuelExecutorCommandOutcome,
  StreamingDuelExecutorCommandRequest,
  StreamingDuelExecutorCommandCompletionRequest,
  StreamingDuelExecutorCommandReceipt,
  PrayerPersistenceSnapshot,
  PrayerStateTransitionKind,
  PrayerStateCommitRequest,
  PrayerStateCommitReceipt,
} from "./types/network/database";

export type {
  PrayerActionFailureReason,
  PrayerActionReceipt,
  PrayerCustodyView,
} from "./systems/shared/character/PrayerSystem";
export type {
  BoneBurialFailureReason,
  BoneBurialReceipt,
  FoodConsumptionFailureReason,
  FoodConsumptionReceipt,
} from "./systems/shared/character/PlayerSystem";

// Export entity types
export type {
  PlayerEntity,
  CharacterController,
  CharacterControllerOptions,
  NetworkPacket,
} from "./types/index";

// Export video and model types
export type {
  VideoFactory,
  LoadedModel,
  LoadedEmote,
  LoadedAvatar,
  SnapshotData,
  VideoSource,
  HSNode,
} from "./types/index";

// Export player touch/stick types used by PlayerLocal
export type { PlayerTouch, PlayerStickState } from "./types/systems/physics";
// Export additional physics handle types referenced in declarations
export type {
  PhysicsHandle,
  PhysicsRaycastHit,
  PhysicsOverlapHit,
  BasePhysicsHandle,
  InterpolationData,
  ContactEvent,
  TriggerEvent,
} from "./types/systems/physics";
export type { Collider, RigidBody, PhysicsMaterial } from "./types/index";
export type {
  InternalContactCallback,
  InternalTriggerCallback,
  ExtendedContactEvent,
  ExtendedTriggerEvent,
  OverlapHit,
} from "./systems/shared";
export { writePacket, readPacket } from "./platform/shared/packets";
export { Socket } from "./platform/shared/Socket";

// Export physics utilities
export { installThreeJSExtensions } from "./utils/physics/PhysicsUtils";

// Export spawn utilities
export { CircularSpawnArea } from "./utils/physics/CircularSpawnArea";

// Export terrain system
export { TerrainSystem } from "./systems/shared";

// Export pathfinding utilities (used by NavigationVisualizer and building navigation)
export { BFSPathfinder } from "./systems/shared/movement/BFSPathfinder";
export type { WalkabilityChecker } from "./systems/shared/movement/BFSPathfinder";

// Export building collision utilities
export {
  cellToWorldTile,
  rotateWallDirection,
  getOppositeDirection,
  toWallDirection,
  tileKey as buildingTileKey,
} from "./types/world/building-collision-types";
export type {
  WallDirection,
  WallSegment,
  StairTile,
  FloorCollisionData,
} from "./types/world/building-collision-types";
