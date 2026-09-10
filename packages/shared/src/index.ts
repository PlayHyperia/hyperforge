/**
 * index.ts - @hyperforge/shared Package Entry Point
 *
 * This is the main export file for the Hyperia 3D multiplayer game engine.
 * It provides a comprehensive public API for building 3D multiplayer games and applications.
 *
 * Package Purpose:
 * Hyperia is a full-featured 3D multiplayer game engine built on three.js and PhysX.
 * It provides client-server architecture with authoritative physics, real-time voice chat,
 * VRM avatar support, and a complete RPG game framework.
 *
 * Main Exports:
 *
 * 1. World Factories:
 *    - createClientWorld(): Creates browser client world
 *    - createServerWorld(): Creates Node.js server world
 *    - createViewerWorld(): Creates lightweight viewer world
 *    - createNodeClientWorld(): Creates headless Node.js client
 *
 * 2. Core Classes:
 *    - World: Central game world container and ECS coordinator
 *    - System: Base class for all game systems
 *    - Entity: Base entity class for game objects
 *    - PlayerLocal: Local player controller
 *    - PlayerRemote: Remote player representation
 *
 * 3. Systems:
 *    - Physics, Graphics, Audio, Input, Network, etc.
 *    - All client and server systems
 *
 * 4. Types:
 *    - Comprehensive TypeScript types for all APIs
 *    - Entity, Component, System interfaces
 *    - Network, Physics, and Event types
 *
 * 5. Utilities:
 *    - THREE.js helpers and extensions
 *    - PhysX integration utilities
 *    - Validation, logging, and math utilities
 *
 * 6. Nodes:
 *    - Scene graph node types (Mesh, Group, UI, Avatar, etc.)
 *
 * Architecture Notes:
 * - Client and server share most code but have environment-specific systems
 * - PhysX physics runs on both client (via WASM) and server (via Node.js bindings)
 * - Server is authoritative for all game state
 * - Event-driven architecture with type-safe EventBus
 * - Entity Component System (ECS) pattern for game objects
 *
 * Bundle Optimization:
 * This file avoids importing Node.js modules at top-level so client bundlers
 * (like Vite) don't pull server-only dependencies into browser bundles.
 * Server-specific imports are isolated to createServerWorld() and server systems.
 *
 * Used by: Client package, Server package, Plugin-Hyperia package
 */

// Export world factories from runtime/
export * from "./runtime";

// Export terrain shader for unified rendering (used by Asset Forge)
export {
  createTerrainMaterial,
  generateNoiseTexture,
  getNoiseTexture,
  sampleNoiseAtPosition,
  getGrassiness,
  calculateSlope,
  type TerrainUniforms,
} from "./systems/shared/world/TerrainShader";

// Export core classes
export * from "./core";

// Export entity classes
export { PlayerEntity } from "./entities/player/PlayerEntity";
export { PlayerLocal } from "./entities/player/PlayerLocal";
export { PlayerRemote } from "./entities/player/PlayerRemote";
export { MobEntity } from "./entities/npc/MobEntity";
export type { EventCallback } from "./entities/Entity";

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

// Export networking types from types/networking.ts
export type {
  ConnectionParams,
  NetworkWithSocket,
  NodeWebSocket,
  ServerStats,
  SpawnData,
  User,
  Socket as SocketInterface,
  SocketOptions,
  NetworkMetrics,
  MovementValidationResult,
  MovementConfig,
} from "./types/network/networking";

// Export Socket class
export { Socket } from "./platform/shared/Socket";

// Export database types for server use

// Export EventType enum
export { EventType } from "./types/events";

// Export PlayerMigration class
export { PlayerMigration } from "./types/core/core";

// Export enums (these are values, not types)
export {
  WeaponType,
  EquipmentSlotName,
  AttackType,
  ItemType,
} from "./types/core/core";
export { BANKING_CONSTANTS } from "./constants/BankingConstants";

// Export DeathState enum for death/respawn system
export { DeathState } from "./types/entities/entities";

// Export death/loot types for shadow state and transaction tracking
export type {
  LootResult,
  LootFailureReason,
  PendingLootTransaction,
  DeathAuditEntry,
  DeathAuditAction,
  DeathItemData,
  DeathLock,
} from "./types/death";

// Export db helpers and type guards for server usage
export { dbHelpers, isDatabaseInstance } from "./types/network/database";

// Export role utilities
export {
  addRole,
  removeRole,
  hasRole,
  serializeRoles,
  hasModPermission,
  hasAdminPermission,
  isProtectedFromModAction,
  uuid,
} from "./utils/index";

// Export ID generation utilities (for transaction tracking, etc.)
export { generateTransactionId } from "./utils/IdGenerator";
export {
  calculateCombatLevel,
  getPrimaryCombatType,
  MIN_COMBAT_LEVEL,
  MAX_COMBAT_LEVEL,
} from "./utils/game/CombatLevelCalculator";
export type {
  CombatSkills,
  CombatType,
} from "./utils/game/CombatLevelCalculator";
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

// Export SeededRandom and game RNG utilities (rules-accurate deterministic RNG)
export {
  SeededRandom,
  initializeGameRng,
  getGameRng,
  getGameSeed,
  getGameRngState,
} from "./utils/SeededRandom";
export type { SeededRandomState } from "./utils/SeededRandom";

// Rules-accurate combat calculators used by authoritative replay and retained
// launch verification. Every calculator accepts an explicit SeededRandom.
export {
  calculateDamage,
  calculateHitChance,
  type CombatStats,
  type HitCalculationResult,
  type PrayerCombatBonuses,
} from "./utils/game/CombatCalculations";
export {
  calculateRangedDamage,
  type RangedDamageParams,
  type RangedDamageResult,
} from "./systems/shared/combat/RangedDamageCalculator";
export {
  calculateMagicDamage,
  type MagicDamageParams,
  type MagicDamageResult,
} from "./systems/shared/combat/MagicDamageCalculator";

// Export branded type identifiers for compile-time type safety
export type {
  PlayerID,
  ItemID,
  MobID,
  EntityID,
  StoreID,
  BankID,
  ResourceID,
  NPCID,
  SessionID,
  QuestID,
  SkillID,
  ZoneID,
  ChunkID,
  SlotNumber,
} from "./types/core/identifiers";
export {
  isValidPlayerID,
  isValidMobID,
  isValidEntityID,
  isValidItemID,
  isValidStoreID,
  isValidBankID,
  isValidResourceID,
  isValidNPCID,
  isValidSessionID,
  isValidSlotNumber,
  isValidQuestID,
  isValidSkillID,
  isValidZoneID,
  isValidChunkID,
  createPlayerID,
  createMobID,
  createEntityID,
  createItemID,
  createStoreID,
  createBankID,
  createResourceID,
  createNPCID,
  createSessionID,
  createSlotNumber,
  createQuestID,
  createSkillID,
  createZoneID,
  createChunkID,
} from "./types/core/identifiers";

// Export prayer type guards and types
export {
  isValidPrayerId,
  isValidPrayerTogglePayload,
  isValidPrayerBonuses,
  getPlayerPrayerLevel,
  getPlayerPrayerBonus,
  getPlayerPrayerXp,
  MAX_PRAYER_ID_LENGTH,
  MAX_ACTIVE_PRAYERS,
  PRAYER_TOGGLE_COOLDOWN_MS,
  PRAYER_TOGGLE_RATE_LIMIT,
  PRAYER_ID_PATTERN,
} from "./types/game/prayer-types";
export type {
  PrayerCategory,
  PrayerBonuses,
  PrayerDefinition,
  PrayerManifest,
  PrayerState,
  PrayerTogglePayload,
  PrayerToggledEvent,
  PrayerStateSyncPayload,
  PlayerWithPrayerStats,
} from "./types/game/prayer-types";

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
export {
  getStreamingDuelDamageAuthority,
  registerStreamingDuelDamageAuthority,
} from "./systems/shared/combat/StreamingDuelDamageAuthority";
export type {
  StreamingDuelDamageAuthority,
  StreamingDuelDamageCommitAuthority,
} from "./systems/shared/combat/StreamingDuelDamageAuthority";
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

// Export trade types
export { TRADE_CONSTANTS } from "./types/game/trade-types";
export type {
  TradeStatus,
  TradeCancelReason,
  TradeOfferItem,
  TradeParticipant,
  TradeSession,
  TradeRequestPayload,
  TradeRequestRespondPayload,
  TradeAddItemPayload,
  TradeRemoveItemPayload,
  TradeSetQuantityPayload,
  TradeAcceptPayload,
  TradeCancelAcceptPayload,
  TradeCancelPayload,
  TradeIncomingPayload,
  TradeStartedPayload,
  TradeOfferView,
  TradeUpdatedPayload,
  TradeCompletedPayload,
  TradeCancelledPayload,
  TradeErrorPayload,
  TradeWindowState,
  TradeRequestModalState,
} from "./types/game/trade-types";

// Export social/friend system types
export { SOCIAL_CONSTANTS } from "./types/game/social-types";
export type {
  FriendStatus,
  Friend,
  FriendStatusUpdateData,
  FriendRequest,
  IgnoredPlayer,
  PrivateMessage,
  PrivateChatFailReason,
  FriendsListSyncData,
  SocialErrorCode,
  SocialError,
} from "./types/game/social-types";

// Export duel arena types and utilities
export {
  DEFAULT_DUEL_RULES,
  validateRuleCombination,
  INVALID_RULE_COMBINATIONS,
  DEFAULT_EQUIPMENT_RESTRICTIONS,
  createDuelParticipant,
  DUEL_CHALLENGE_TIMEOUT_MS,
  DuelErrorCode,
  DuelEvents,
} from "./types/game/duel-types";
export type {
  DuelRules,
  EquipmentSlotRestriction,
  EquipmentRestrictions,
  StakedItem,
  DuelParticipant,
  DuelState,
  DuelSession,
  ArenaSpawnPoint,
  ArenaBounds,
  Arena,
  PendingDuelChallenge,
  DuelEventName,
} from "./types/game/duel-types";

// Export quest type guards for server validation
export { isValidQuestId } from "./types/game/quest-types";

// Export item helpers used by server network snapshot
export {
  ITEMS,
  getItem,
  getBaseItem,
  getNotedItem,
  canBeNoted,
  isNotedItemId,
  getBaseItemId,
  getNotedItemId,
  NOTE_SUFFIX,
} from "./data/items";

// Authoritative runtime view of the loaded processing recipe manifests.
export {
  ProcessingDataProvider,
  processingDataProvider,
} from "./data/ProcessingDataProvider";
export type { CookingItemData } from "./data/ProcessingDataProvider";

// Export store helpers used by authoritative server/store planning.
export { getAllStores, getStoreById } from "./data/banks-stores";

// Public authored combat-NPC catalog used by the server's deterministic
// acquisition planner. Runtime drop rolls remain server-authoritative.
export { getCombatNPCs } from "./data/npcs";

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
  StreamingPreparationVisualDiagnostics,
  StreamingPreparationVisualPlayerDiagnostics,
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
export {
  getStreamingPreparationEntityPosition,
  hasActiveStreamingPreparationPresentation,
  resolveStreamingPreparationFocus,
} from "./runtime/streamingPreparationFocus";
export type {
  StreamingPreparationEntity,
  StreamingPreparationFocus,
  StreamingPreparationParticipant,
  StreamingPreparationPhase,
  StreamingPreparationPosition,
} from "./runtime/streamingPreparationFocus";

// Export spell service for magic combat
export { spellService } from "./systems/shared/combat/SpellService";
export type { Spell } from "./systems/shared/combat/SpellService";

// Export combat spell manifest data (used by duel orchestrator for best-spell selection)
export { COMBAT_SPELLS, SPELL_ORDER } from "./data/combat-spells";
export type { SpellData } from "./data/combat-spells";

// Export elemental staff rune mappings (used by duel orchestrator for rune provisioning)
export { ELEMENTAL_STAVES } from "./data/runes";

// Export world area data for server use
export { ALL_WORLD_AREAS, STARTER_TOWNS } from "./data/world-areas";

// Export systems (organized by platform for tree-shaking)
export { Entities } from "./systems/shared";
export { Physics } from "./systems/shared";
export { Particles } from "./systems/shared";
export { LODs } from "./systems/shared";

// Atlased Impostor System - optimized impostor rendering for diverse forests
export {
  AtlasedImpostorManager,
  ATLASED_IMPOSTOR_CONFIG,
  AtlasedImpostorDebug,
  runAtlasedImpostorTests,
  visualTest as atlasedImpostorVisualTest,
  downloadAllSlots as atlasedImpostorDownloadSlots,
} from "./systems/shared/rendering";
export {
  AtlasedTreeImpostors,
  ATLASED_TREE_CONFIG,
} from "./systems/shared/world";

export { ClientInterface } from "./systems/client/ClientInterface"; // UI state, preferences, stats display
export { ClientLoader } from "./systems/client/ClientLoader";
// ServerNetwork removed from main exports - import directly from ./systems/server when needed on server side
export { Environment } from "./systems/shared";
export { ClientNetwork } from "./systems/client/ClientNetwork";
export type { InventorySnapshot } from "./systems/client/ClientNetwork";
export { ClientGraphics } from "./systems/client/ClientGraphics";
export { ClientRuntime } from "./systems/client/ClientRuntime"; // Client lifecycle and diagnostics
export { ClientAudio } from "./systems/client/ClientAudio";
export { ClientLiveKit } from "./systems/client/ClientLiveKit";
export { ClientInput } from "./systems/client/ClientInput";
export { ServerRuntime } from "./systems/server/ServerRuntime"; // Server lifecycle and monitoring
export { ClientActions } from "./systems/client/ClientActions";
export { EventBus } from "./systems/shared";
export { System as SystemClass } from "./systems/shared";
export { SystemBase } from "./systems/shared";
export {
  CombatSystem,
  ammunitionService,
  runeService,
} from "./systems/shared/combat";
export {
  PrayerSystem,
  PRAYER_POINT_UNITS_PER_POINT,
} from "./systems/shared/character/PrayerSystem";
// Concrete character systems are already part of the server framework bundle.
// Export explicit runtime aliases so server integration harnesses and external
// world hosts can instantiate the same classes without reaching into source
// paths and accidentally creating duplicate shared-data singletons.
export { InventorySystem as CharacterInventorySystem } from "./systems/shared/character/InventorySystem";
export { EquipmentSystem as CharacterEquipmentSystem } from "./systems/shared/character/EquipmentSystem";
export { PlayerSystem } from "./systems/shared/character/PlayerSystem";
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
export { LootSystem } from "./systems/shared/economy/LootSystem";
export { StoreSystem } from "./systems/shared/economy/StoreSystem";
export { GroundItemSystem } from "./systems/shared/economy/GroundItemSystem";
export { ResourceSystem } from "./systems/shared/entities/ResourceSystem";
export { QuestSystem } from "./systems/shared/progression/QuestSystem";
export {
  FOOTPRINT_SIZES,
  resolveFootprint,
} from "./types/game/resource-processing-types";
export type {
  ResourceFootprint,
  FootprintDimensions,
  FootprintSpec,
  Resource,
  Fire,
} from "./types/game/resource-processing-types";
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

// Export client network utilities
export { PendingActionTracker } from "./systems/client/network/PendingActionTracker";

// Export node client components
export { ServerLoader } from "./systems/server/ServerLoader";
export { NodeClient } from "./systems/client/NodeClient";
export { Node } from "./nodes/Node";
// Re-export commonly used node classes to satisfy API extractor
export { UI } from "./nodes/UI";
export { UIView } from "./nodes/UIView";
export { UIText } from "./nodes/UIText";
export { Group } from "./nodes/Group";
export { Mesh } from "./nodes/Mesh";
export { Avatar } from "./nodes/Avatar";
export { storage } from "./platform/shared/storage";
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

// Combat validation utilities
export {
  validateEntityId,
  validateUUID,
  validateAttackType,
  validateCombatRequest,
  validateAttackStyleRequest,
  sanitizeDisplayName,
  type CombatRequestValidation,
  type AttackStyleValidation,
} from "./utils/game/CombatValidation";

export { getGatheringRewardOperationIdForAttempt } from "./utils/game/GatheringReceiptIdentity";
export { getGroundItemPickupOperationIdForAttempt } from "./utils/game/GroundItemPickupReceiptIdentity";
export {
  generateGroundItemDropOperationId,
  generateGroundItemDeathOperationId,
  generateGroundItemMobLootOperationId,
  generateGroundItemSourceContributionId,
  generateGroundItemSourceEntityId,
} from "./utils/game/GroundItemSourceIdentity";
export { serializeGroundItemDropCommitFingerprint } from "./utils/game/GroundItemDropRegistration";
export { serializeGroundItemDeathCommitFingerprint } from "./utils/game/GroundItemDeathRegistration";
export {
  serializeGroundItemMobLootCommitFingerprint,
  type GroundItemMobLootIdentity,
} from "./utils/game/GroundItemMobLootRegistration";
export {
  getProcessingFireExtinguishOperationId,
  serializeProcessingFireExtinguishFingerprint,
  type ProcessingFireExtinguishIdentity,
} from "./utils/game/ProcessingFireExtinguishRegistration";
export {
  ammunitionShotIdentityFromRequest,
  serializeAmmunitionShotFingerprint,
  type AmmunitionShotIdentity,
} from "./utils/game/AmmunitionShotRegistration";
export {
  generateKillToken,
  isKillTokenValidationAvailable,
  MAX_MOB_COMBAT_DAMAGE,
  validateKillToken,
  validateKillTokenSignature,
} from "./utils/game/KillTokenUtils";
export { serializeGroundItemSourceRegistrationFingerprint } from "./utils/game/GroundItemSourceRegistration";

export { isTouch, cls, hashFile } from "./platform/client/utils-client";
export { ReactiveVector3 } from "./extras/animation/ReactiveVector3";
export { createEmoteFactory } from "./extras/three/createEmoteFactory";
export { createNode } from "./extras/three/createNode";
export { glbToNodes } from "./extras/three/glbToNodes";
export { Emotes } from "./data/playerEmotes";
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
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
  isPositionInsideCombatArena,
  type DuelRuleDefinition,
  type EquipmentSlotDefinition,
  type DuelEquipmentSlot,
  type DuelCombatArenaBounds,
  type DuelArenaConfig,
} from "./data/duel-manifest";
export { ControlPriorities } from "./systems/client/ControlPriorities";
export { downloadFile } from "./utils/downloadFile";
export * from "./utils/typeGuards";
export { getExternalResources } from "./utils/ExternalAssetUtils";

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
  PlayerStats,
  Skills,
  PlayerEquipmentItems,
  PlayerCombatData,
  SystemConfig,
  SkillData,
  MovementComponent,
  InventoryItem,
  InventorySlotItem,
  Item,
  Inventory,
  PlayerEquipment,
  CombatStyle,
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
// Re-export storage types
export type { Storage } from "./platform/shared/storage";
export { LocalStorage } from "./platform/shared/storage";
// Export server-side NodeStorage for Node/Bun runtimes
export { NodeStorage } from "./platform/server/storage.server";
// Export file-based Storage class (for server use)
// export { Storage as FileStorage } from './systems/Storage'; // Disabled: file doesn't exist

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
export { SystemLogger } from "./utils/Logger";

// Export network/system interface types
export type {
  NetworkSystem,
  EquipmentSystem,
} from "./types/systems/system-interfaces";
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
export type {
  FrozenCombatArmorIds,
  FrozenCombatArmorSlot,
  FrozenCombatLoadoutDefinition,
  FrozenCombatLoadoutSwitchRequest,
  FrozenCombatLoadoutSwitchReceipt,
  OwnedDuelPreparationPlanRequest,
  OwnedDuelPreparationPlanRecoveryRequest,
  OwnedDuelPreparationPlanFailureReason,
  OwnedDuelPreparationPlanReceipt,
} from "./systems/shared/character/EquipmentSystem";
export { FROZEN_COMBAT_ARMOR_SLOTS } from "./systems/shared/character/EquipmentSystem";

// Export Panel utility
export { default as Panel } from "./libs/stats-gl/panel";

// Export ClientActions internal handler type
export type { ClientActionHandler } from "./systems/client/ClientActions";

// Export alternate HotReloadable and RaycastHit for nodes/UI references
// Export MinimalHotReloadable from physics (renamed to avoid conflict)
export type { MinimalHotReloadable } from "./types/systems/physics";

// Export environment and stage types
export type {
  BaseEnvironment,
  EnvironmentModel,
  SkyHandle,
  SkyInfo,
  SkyNode,
} from "./types/index";
export { LooseOctree } from "./utils/physics/LooseOctree";
export { quaternionPool } from "./utils/pools/QuaternionPool";
export type { PooledQuaternion } from "./utils/pools/QuaternionPool";
export { tilePool } from "./utils/pools/TilePool";
export { bfsPool } from "./systems/shared/movement/ObjectPools";
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
// Export specific event payload types for convenience
export type {
  SkillsLevelUpEvent,
  EquipmentSyncData,
  InventorySyncData,
  FletchingInterfaceOpenPayload,
} from "./types/events";

// Export additional core types
export type { SkillsData } from "./types/systems/system-interfaces";
export type {
  HealthComponent,
  VisualComponent,
  EntityCombatComponent,
  PlayerCombatStyle,
} from "./types/entities";
export type { GroupType } from "./types/rendering/nodes";
export type {
  InventoryItemInfo,
  ActionBarSlotContent,
  ActionBarSlotUpdatePayload,
  ActionBarSlotSwapPayload,
} from "./types/events";

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
  PlayerRow,
  ItemRow,
  InventoryRow,
  EquipmentRow,
  PlayerSessionRow,
  WorldChunkRow,
  InventorySaveItem,
  EquipmentSaveItem,
  CombatLoadoutPersistenceSnapshot,
  CombatLoadoutCommitRequest,
  CombatLoadoutCommitReceipt,
  BankSaveItem,
  DuelPreparationPlanPersistenceSnapshot,
  DuelPreparationPlanRecoveryEvidence,
  DuelPreparationPlanCommitRequest,
  DuelPreparationPlanRecoveryRequest,
  DuelPreparationPlanCommitReceipt,
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
  GroundItemMobLootCommitRequest,
  GroundItemMobLootCommitReceipt,
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
  GatheringRewardSkill,
  GatheringRewardItem,
  GatheringRewardCommitRequest,
  GatheringRewardCommitReceipt,
  GatheringResourceState,
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

// Export entity types (PlayerEntity class is exported above, so only export other types here)
export type {
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
export {
  writePacket,
  readPacket,
  getPacketId,
  getPacketName,
  PACKET_NAMES,
} from "./platform/shared/packets";

// Export physics utilities
export { installThreeJSExtensions } from "./utils/physics/PhysicsUtils";

// Export spawn utilities
export { CircularSpawnArea } from "./utils/physics/CircularSpawnArea";

// Export terrain system
export { TerrainSystem } from "./systems/shared";

// Export town, POI, and road systems
export { TownSystem } from "./systems/shared";
export { POISystem } from "./systems/shared";
export { RoadNetworkSystem } from "./systems/shared";
export { BuildingCollisionService } from "./systems/shared/world/BuildingCollisionService";

// Building collision types (for navigation systems)
export type {
  WallDirection,
  WallSegment,
  StairTile,
  StepTile,
  FloorCollisionData,
  BuildingCollisionData,
  PlayerBuildingState,
  BuildingCollisionResult,
  BuildingLayoutInput,
  CellCoord,
} from "./types/world/building-collision-types";
export {
  cellToWorldTile,
  rotateWallDirection,
  getOppositeDirection,
  toWallDirection,
  tileKey as buildingTileKey,
} from "./types/world/building-collision-types";

// Export tile movement system (classic fantasy MMORPG-style)
export {
  // Constants
  TILE_SIZE,
  TICK_DURATION_MS,
  TILES_PER_TICK_WALK,
  TILES_PER_TICK_RUN,
  MAX_PATH_LENGTH,
  PATHFIND_RADIUS,
  TILE_DIRECTIONS,
  // Utility functions
  worldToTile,
  worldToTileInto,
  tileToWorld,
  tileToWorldInto,
  snapToTileCenter,
  tileManhattanDistance,
  tileChebyshevDistance,
  tilesEqual,
  tilesAdjacent,
  tilesWithinRange,
  tilesWithinMeleeRange,
  tilesCardinallyAdjacent,
  getBestAdjacentTile,
  getBestCombatRangeTile,
  getBestMeleeTile,
  getBestUnoccupiedMeleeTile,
  getBestStepOutTile,
  getAdjacentTiles,
  getResourceAdjacentTiles,
  findBestResourceInteractionTile,
  isAdjacentToResource,
  // Cardinal-only resource interaction (AAA quality)
  getCardinalAdjacentTiles,
  findBestCardinalInteractionTile,
  isCardinallyAdjacentToResource,
  getCardinalFaceDirection,
  getCardinalFaceAngle,
  CARDINAL_FACE_ANGLES,
  isDiagonal,
  tileKey,
  parseTileKey,
  clampTile,
  createTileMovementState,
  // Combat pathfinding: LoS and valid tile generation
  hasLineOfSight,
  getValidRangedTiles,
  getValidMeleeTiles,
} from "./systems/shared/movement/TileSystem";
export type {
  TileCoord,
  TileInteractionArrival,
  TileMovementState,
  TileFlags,
  CardinalDirection,
} from "./systems/shared/movement/TileSystem";
export { BFSPathfinder } from "./systems/shared/movement/BFSPathfinder";
export {
  chaseStep,
  getChasePathfinder,
  ChasePathfinder,
} from "./systems/shared/movement/ChasePathfinding";
export type { WalkabilityChecker } from "./systems/shared/movement/BFSPathfinder";
export {
  getCachedTimestamp,
  updateCachedTimestamp,
} from "./systems/shared/movement/ObjectPools";
export {
  CollisionFlag,
  CollisionMask,
} from "./systems/shared/movement/CollisionFlags";
export {
  CollisionMatrix,
  ZONE_SIZE,
} from "./systems/shared/movement/CollisionMatrix";
export type { ICollisionMatrix } from "./systems/shared/movement/CollisionMatrix";
export {
  EntityOccupancyMap,
  entityOccupancyMap,
} from "./systems/shared/movement/EntityOccupancyMap";
export type {
  OccupantType,
  OccupancyEntry,
  OccupancyStats,
  IEntityOccupancy,
} from "./systems/shared/movement/EntityOccupancyMap";

// ============================================================================
// Interaction System (Store, Bank, Dialogue)
// Single source of truth for session management, validation, and distance
// ============================================================================

// Constants
export {
  SessionType,
  INTERACTION_DISTANCE,
  TRANSACTION_RATE_LIMIT_MS,
  SESSION_CONFIG,
  INPUT_LIMITS,
} from "./constants/interaction";

// Client input constants (click distances, drag thresholds, raycast ranges)
export { INPUT } from "./systems/client/interaction/constants";

// Combat constants (tick-based timing, ranges, etc.)
export { COMBAT_CONSTANTS } from "./constants/CombatConstants";
export { PROCESSING_CONSTANTS } from "./constants/ProcessingConstants";
export {
  acquirePreparationActionFence,
  canPlayerPerformPreparationAction,
  canPlayerUseProcessingStation,
} from "./systems/shared/interaction/ProcessingStationAuthority";
export type { PreparationActionFence } from "./systems/shared/interaction/ProcessingStationAuthority";
export { stationDataProvider } from "./data/StationDataProvider";
export type {
  ModelBoundsManifest,
  StationsManifest,
} from "./data/StationDataProvider";
export {
  PROCESSING_QUIESCENCE_SYSTEM_NAMES,
  isPlayerProcessingQuiescent,
  requestPlayerProcessingQuiescence,
} from "./systems/shared/interaction/ProcessingQuiescence";
export type {
  PlayerProcessingQuiescenceSystem,
  ProcessingQuiescenceRequestResult,
  ProcessingQuiescenceSystemName,
} from "./systems/shared/interaction/ProcessingQuiescence";

// Home teleport constants (cooldown, cast time)
export { HOME_TELEPORT_CONSTANTS } from "./constants/GameConstants";

// Distance constants for render culling, LOD, and server simulation
export { DISTANCE_CONSTANTS } from "./constants/GameConstants";

// Terrain constants (water threshold, walkable slopes, etc.)
// Single source of truth for terrain-related values used across all systems
export { TERRAIN_CONSTANTS } from "./constants/GameConstants";

// Inventory constants (slot counts, stack sizes)
export { INVENTORY_CONSTANTS } from "./constants/GameConstants";

// Player constants (health, stamina, speeds)
export { PLAYER_CONSTANTS } from "./constants/GameConstants";

// Gathering constants (tick-based timing, ranges, etc.)
export { GATHERING_CONSTANTS } from "./constants/GatheringConstants";
export { resolveGatheringPresentationEmote } from "./systems/shared/entities/gathering/ToolUtils";

// Smithing prerequisites shared by authoritative execution and agent planners
export { SMITHING_CONSTANTS } from "./constants/SmithingConstants";

// Context menu colors (rules-accurate styling)
export { CONTEXT_MENU_COLORS } from "./constants/GameConstants";

// Weapon style configuration (rules-accurate style restrictions per weapon)
export {
  WEAPON_STYLE_CONFIG,
  getAvailableStyles,
  isStyleValidForWeapon,
  getDefaultStyleForWeapon,
} from "./constants/WeaponStyleConfig";

// Hit delay calculator (rules-accurate projectile delays)
export {
  calculateHitDelay,
  calculateMeleeHitDelay,
  calculateRangedHitDelay,
  calculateMagicHitDelay,
  calculateTileDistance,
  calculateEuclideanDistance,
  createProjectile,
  shouldProjectileHit,
  getProjectileProgress,
  getHitDelayExamples,
} from "./utils/game/HitDelayCalculator";
export type {
  HitDelayAttackType,
  ProjectileData,
  HitDelayResult,
} from "./utils/game/HitDelayCalculator";

// Distance utilities (classic MMORPG-style Chebyshev)
export {
  chebyshevDistance,
  isWithinDistance,
  type Position2D,
} from "./utils/distance";

// Types and interfaces
export type {
  InteractionSession,
  ISessionReader,
  ISessionWriter,
  ISessionManager,
  ITransactionValidator,
  IRateLimiter,
  ValidationResult,
  SessionCloseReason,
} from "./types/interaction";

// Context menu styled label type (for combat level colors)
export type { LabelSegment } from "./systems/client/interaction/types";

// Bank equipment type guards, types, and constants
export {
  isValidPlayerEquipmentData,
  isValidPlayerEquipmentStructure,
  MVP_EQUIPMENT_SLOTS,
} from "./types/bank-equipment";
export { VALID_EQUIPMENT_SLOT_KEYS } from "./constants/BankEquipmentConstants";
export type {
  PlayerEquipmentData,
  EquipmentSlotItem,
  BankEquipmentError,
  BankRightPanelMode,
  WithdrawTarget,
  BankWithdrawToEquipmentRequest,
  BankWithdrawToEquipmentResponse,
  BankDepositEquipmentRequest,
  BankDepositEquipmentResponse,
} from "./types/bank-equipment";

// Load testing utilities
export { LoadTestBot, BotPoolManager } from "./testing";
export type {
  LoadTestBehavior,
  LoadTestBotConfig,
  LoadTestBotMetrics,
  BotPoolConfig,
  AggregatedMetrics,
} from "./testing";

// ============================================================================
// Worker utilities for off-main-thread processing
// ============================================================================

// Frame budget manager for reducing main thread jank
export {
  FrameBudgetManager,
  getFrameBudget,
  WorkPriority,
  budgeted,
} from "./utils/FrameBudgetManager";
export type { FrameTimingStats } from "./utils/FrameBudgetManager";
export {
  DurationHistogram,
  type DurationPercentiles,
} from "./utils/DurationHistogram";
export {
  classifyStreamResourceCategory,
  StreamPerformanceTelemetry,
  normalizeStreamingPerformanceSnapshot,
  type StreamFramePerformanceSnapshot,
  type StreamLongFrameSample,
  type StreamPerformanceFrameSample,
  type StreamPerformanceResourceSample,
  type StreamRendererMetricSnapshot,
  type StreamResourceCategory,
  type StreamResourceMetricSnapshot,
  type StreamResourcePerformanceSnapshot,
  type StreamingPerformanceSnapshot,
} from "./systems/client/StreamPerformanceTelemetry";

// Physics Worker - Offloads PhysX simulation to web worker
export {
  isPhysicsWorkerAvailable,
  initPhysicsWorker,
  isPhysicsWorkerReady,
  simulateInWorker,
  addActorToWorker,
  removeActorFromWorker,
  setWorkerActorTransform,
  setWorkerActorVelocity,
  destroyPhysicsWorker,
  type PhysicsActorType,
  type SerializedShape,
  type SerializedActor,
  type ActorTransform,
  type ActorVelocity,
  type SerializedContactEvent,
  type SerializedTriggerEvent,
  type PhysicsWorkerInput,
  type PhysicsWorkerOutput,
} from "./utils/workers/PhysicsWorker";

// Minimap Worker - 2D Canvas minimap rendering in web worker
export {
  MinimapWorkerManager,
  isMinimapWorkerSupported,
  createMinimapWorkerWithCanvas,
  createMinimapWorker,
  type MinimapTile,
  type MinimapEntity,
  type MinimapCamera,
  type MinimapConfig,
  type MinimapWorkerInput,
  type MinimapWorkerOutput,
} from "./utils/workers/MinimapWorker";

// WebGPU is REQUIRED - there is no WebGL fallback

// GPU Compute - WebGPU compute shader infrastructure
export {
  // Core compute context
  RuntimeComputeContext,
  isWebGPUAvailable,
  isWebGPURenderer,
  getGlobalComputeContext,
  initializeGlobalComputeContext,
  // Terrain compute (road influence, vertex colors, instance matrices)
  TerrainComputeContext,
  getGlobalTerrainComputeContext,
  initializeGlobalTerrainComputeContext,
  isTerrainComputeAvailable,
  // Networking compute (interest management, spatial queries, aggro)
  NetworkingComputeContext,
  getGlobalNetworkingComputeContext,
  isNetworkingComputeAvailable,
  // GPU culling
  GPUCullingManager,
  shouldUseGPUCulling,
  matricesToFloat32Array,
  getGlobalCullingManager,
  // Shader exports
  TERRAIN_SHADERS,
  ROAD_INFLUENCE_SHADER,
  TERRAIN_VERTEX_COLOR_SHADER,
  INSTANCE_MATRIX_SHADER,
  BATCH_DISTANCE_SHADER,
  NETWORKING_SHADERS,
} from "./utils/compute";
export type {
  ComputePipelineConfig,
  ComputeBufferConfig,
  DispatchConfig,
  GPURoadSegment,
  GPUBiomeData,
  GPUInstanceTRS,
  TerrainComputeConfig,
  GPUEntityInterest,
  GPUPlayerPosition,
  GPUSpatialQuery,
  GPUSpatialCandidate,
  GPUMobData,
  GPUAggroResult,
  GPUAABB,
  GPUOverlapPair,
  GPUSoundSource,
  GPUListener,
  GPUSpawnCandidate,
  GPUOccupiedPosition,
  GPUSpawnResult,
  GPULootDrop,
  GPULootPlayer,
  GPULootResult,
  NetworkingComputeConfig,
  CullingGroupConfig,
  CullingGroup,
  FrustumData,
} from "./utils/compute";
