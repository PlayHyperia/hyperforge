/**
 * DuelOrchestrator - Combat preparation, execution, and cleanup for streaming duels.
 *
 * Extracted from StreamingDuelScheduler to isolate all combat-related concerns:
 * contestant creation, weapon/food provisioning, arena teleportation, combat AI
 * management, HP tracking, fight resolution, and post-duel cleanup.
 */

import type {
  OwnedDuelPreparationPlanReceipt,
  PrayerActionReceipt,
  PrayerCustodyView,
  StreamingDuelActionObservation,
  StreamingDuelDamageObservationContext,
  StreamingDuelExecutorCommandReceipt,
  StreamingDuelRoleSwitchObservationContext,
  World,
} from "@hyperforge/shared";
import crypto from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttackType,
  COMBAT_SPELLS,
  DeathState,
  DEFAULT_DUEL_RULES,
  ELEMENTAL_STAVES,
  EventType,
  ITEMS,
  PlayerEntity,
  SPELL_ORDER,
  ammunitionService,
  calculateCombatLevel,
  getDuelArenaConfig,
  getItem,
  isPositionInsideCombatArena,
  parseStreamingDuelRoleSwitchObservationContext,
  parseStreamingDuelDamageObservationContext,
  runeService,
  worldToTile,
  createEntityID,
} from "@hyperforge/shared";
import {
  DuelCombatAI,
  type DuelCombatPublicActionObservation,
} from "../../../duel/DuelCombatAI.js";
import type { EmbeddedHyperiaService } from "../../../eliza/EmbeddedHyperiaService.js";
import type { CompetitiveAgentPolicyBinding } from "../../../eliza/competitiveAgentPolicy.js";
import {
  type StreamingDuelCycle,
  type AgentContestant,
  type LeaderboardEntry,
  type RecentDuelEntry,
  type StreamingCombatEngagementMetrics,
  type StreamingDuelWinReason,
  type FrozenStreamingCombatLoadouts,
  type FrozenStreamingArmorIds,
  type SwitchableStreamingCombatRole,
  FROZEN_STREAMING_ARMOR_SLOTS,
  STREAMING_TIMING,
} from "../types.js";
import { getDuelFoodItemForLevels, isDuelFoodItemId } from "../../duelFood.js";
import { Logger } from "../../ServerNetwork/services";
import { errMsg } from "../../../shared/errMsg.js";
import type { CompetitiveSnapshotContestant } from "../competitive-snapshot.js";
import { normalizeCompetitiveTacticalStrategy } from "../competitive-tactical-strategy.js";
import { getAvailablePrayerIdsForLevel } from "../competitive-prayer-policy.js";
import { STREAMING_DUEL_ARENA_ID } from "../../DuelSystem/streaming-arena.js";
import type { StreamingDuelActionObservationDraft } from "../public-action-observation-buffer.js";
import {
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationLedgerHealth,
  type StreamingDuelActionObservationPersistence,
  type StreamingDuelActionObservationStore,
} from "../public-action-observation-ledger.js";
import { isStreamingDuelEquipmentPresentationEligible } from "../../../streaming/duel-equipment-presentation.js";
import { getDuelPreparationPlanOperationId } from "../../../eliza/duelPreparationPlan.js";

/**
 * The physical arena remains large enough for ordinary player duels, while the
 * broadcast loop uses a tighter centered footprint. The resulting 14x16 space
 * still permits the full eight-unit projectile band, diagonal footwork, and
 * melee pursuit without forcing the camera to frame unused corners.
 */
const STREAMING_DUEL_COMBAT_WIDTH = 14;
const STREAMING_DUEL_COMBAT_LENGTH = 16;

const isLoopbackRuntimeUrl = (
  rawValue: string | undefined,
  allowedProtocols: readonly string[],
): boolean => {
  try {
    const parsed = new URL(String(rawValue || ""));
    const hostname = parsed.hostname.toLowerCase();
    return (
      allowedProtocols.includes(parsed.protocol) &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]" ||
        hostname === "::1")
    );
  } catch {
    return false;
  }
};

const STREAMING_ITEM_ICON_AVAILABILITY = new Map<string, boolean>();

function streamingAssetRootCandidates(): string[] {
  const configuredWorld =
    String(process.env.WORLD ?? "world").trim() || "world";
  const roots = [
    path.resolve(process.cwd(), configuredWorld, "assets"),
    path.resolve(process.cwd(), "world/assets"),
    path.resolve(process.cwd(), "packages/server/world/assets"),
    fileURLToPath(new URL("../world/assets/", import.meta.url)),
    fileURLToPath(new URL("../../../../world/assets/", import.meta.url)),
  ];
  return [...new Set(roots)];
}

/**
 * Only publish icon URLs that this server artifact can actually serve.
 * A missing advertised path makes every stream viewer issue the same failing
 * request; omitting it lets the client use its deterministic semantic fallback.
 */
function isServedStreamingItemIcon(iconPath: string): boolean {
  const cached = STREAMING_ITEM_ICON_AVAILABILITY.get(iconPath);
  if (cached !== undefined) return cached;

  if (!iconPath.startsWith("asset://")) {
    STREAMING_ITEM_ICON_AVAILABILITY.set(iconPath, false);
    return false;
  }

  const relativePath = iconPath.slice("asset://".length);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").includes("..")
  ) {
    STREAMING_ITEM_ICON_AVAILABILITY.set(iconPath, false);
    return false;
  }

  let available = false;
  for (const rootCandidate of streamingAssetRootCandidates()) {
    try {
      const root = realpathSync(rootCandidate);
      const candidate = realpathSync(path.resolve(root, relativePath));
      if (
        candidate.startsWith(`${root}${path.sep}`) &&
        statSync(candidate).isFile()
      ) {
        available = true;
        break;
      }
    } catch {
      // A candidate root or asset may not exist in a particular source/bundle
      // layout. Continue through the bounded list of supported layouts.
    }
  }

  STREAMING_ITEM_ICON_AVAILABILITY.set(iconPath, available);
  return available;
}

export function isLocalDiagnosticDuelRuntime(env: NodeJS.ProcessEnv): boolean {
  const localSolanaIsNoMoney =
    env.DUEL_LOCAL_SOLANA_MODE === "true" &&
    isLoopbackRuntimeUrl(env.SOLANA_RPC_URL, ["http:", "https:"]);
  const hyperbetIsNoMoney =
    env.DUEL_WITH_HYPERBET === "false" ||
    (env.DUEL_WITH_HYPERBET === "true" &&
      (env.DUEL_HYPERBET_READ_ONLY_MODE === "true" || localSolanaIsNoMoney));
  return (
    env.NODE_ENV === "production" &&
    env.DUEL_LOCAL_SMOKE_MODE === "true" &&
    env.LOAD_TEST_MODE === "true" &&
    env.DUEL_BETTING_ENABLED === "false" &&
    hyperbetIsNoMoney &&
    env.STREAMING_DUEL_SCHEDULER_ROLE === "authority" &&
    isLoopbackRuntimeUrl(env.PUBLIC_API_URL, ["http:", "https:"]) &&
    isLoopbackRuntimeUrl(env.PUBLIC_WS_URL, ["ws:", "wss:"])
  );
}

// ============================================================================
// Types
// ============================================================================

type DuelFoodProvisionedSlot = {
  slot: number;
  itemId: string;
};

type CompetitiveAgentPolicyManager = {
  getAgentService(characterId: string): EmbeddedHyperiaService | null;
  getCompetitiveAgentPolicyBinding(
    characterId: string,
    planningPolicyVersion: string,
  ): CompetitiveAgentPolicyBinding | null;
};

type ValidatedCompetitiveAgentPolicy = {
  service: EmbeddedHyperiaService;
  binding: CompetitiveAgentPolicyBinding;
};

/** Inventory system shape used by the orchestrator. */
type InventorySystem = {
  getInventory?: (playerId: string) =>
    | {
        playerId: string;
        items: Array<{ slot: number; itemId: string; quantity: number }>;
        coins: number;
      }
    | undefined;
  /** Authoritative inventory for UI / streaming (entity.data is often stale). */
  getInventoryData?: (playerId: string) => {
    items: Array<{
      slot?: number;
      itemId?: string;
      quantity?: number;
    }>;
  };
  addItemDirect?: (
    playerId: string,
    item: { itemId: string; quantity: number; slot?: number },
  ) => Promise<boolean>;
  removeItem?: (data: {
    playerId: string;
    itemId: string;
    quantity: number;
    slot?: number;
  }) => Promise<boolean>;
  isInventoryReady?: (playerId: string) => boolean;
} | null;

type DuelEquipmentSlotName = "weapon" | "arrows" | "shield";
type CompetitiveEquipmentSlotName =
  | DuelEquipmentSlotName
  | "helmet"
  | "body"
  | "legs"
  | "boots"
  | "gloves"
  | "cape"
  | "amulet"
  | "ring";

type DuelEquipmentSlotView = {
  itemId?: string | number | null;
  item?: { id?: string | null } | null;
  quantity?: number;
} | null;

type DuelEquipmentView = Partial<
  Record<CompetitiveEquipmentSlotName, DuelEquipmentSlotView>
>;

type DuelEquipmentSlotSnapshot = {
  itemId: string;
  quantity: number;
} | null;

type DuelCombatSetupSnapshot = {
  equipment: Record<DuelEquipmentSlotName, DuelEquipmentSlotSnapshot>;
  selectedSpell: string | null;
  inventoryQuantityByItemId: Map<string, number>;
  provisionedItemIds: Set<string>;
  frozenEquipment: Record<
    CompetitiveEquipmentSlotName,
    DuelEquipmentSlotSnapshot
  >;
  frozenInventory: Array<{ slot: number; itemId: string; quantity: number }>;
  frozenSkillLevels: Record<string, number>;
  prayer: {
    pointUnits: number;
    points: number;
    maxPoints: number;
    activePrayers: string[];
  };
  fingerprint: string;
  availableCombatStyles: DuelCombatRole[];
  combatLoadouts: FrozenStreamingCombatLoadouts;
  initialCombatRole: DuelCombatRole;
  diagnosticProvisioningAllowed: boolean;
  diagnosticMultiStyleAllowed: boolean;
};

type PrayerSystemView = {
  getPrayerCustody?: (playerId: string) => PrayerCustodyView;
  deactivateAllPrayers?: (
    playerId: string,
    operationId?: string,
  ) => Promise<PrayerActionReceipt>;
  restorePrayerPoints?: (
    playerId: string,
    amount: number,
    operationId?: string,
  ) => Promise<PrayerActionReceipt>;
};

type PlayerSystemView = {
  isPlayerReady?: (playerId: string) => boolean;
};

export type CompetitiveLoadoutFreezeResult =
  | {
      ok: true;
      fingerprint: string | null;
      availableCombatStyles: DuelCombatRole[];
      combatLoadouts: FrozenStreamingCombatLoadouts;
      initialCombatRole: DuelCombatRole;
      diagnostic: boolean;
    }
  | { ok: false; reason: string };

export type FrozenCompetitiveState = {
  equipment: Array<{ slot: string; itemId: string; quantity: number }>;
  inventory: Array<{ slot: number; itemId: string; quantity: number }>;
  selectedSpell: string | null;
  skillLevels: Array<{ skill: string; level: number }>;
  prayer: {
    pointUnits: number;
    points: number;
    maxPoints: number;
    activePrayers: string[];
  };
  fingerprint: string | null;
  initialCombatRole: DuelCombatRole;
  availableCombatStyles: DuelCombatRole[];
  combatLoadouts: FrozenStreamingCombatLoadouts;
  diagnostic: boolean;
};

/** Equipment system shape used by the orchestrator. */
type EquipmentSystem = {
  getPlayerEquipment?: (playerId: string) => DuelEquipmentView | undefined;
  isEquipmentReady?: (playerId: string) => boolean;
  recoverOwnedDuelPreparationPlan?: (
    playerId: string,
    request: { operationId: string; preparationId: string },
  ) => Promise<OwnedDuelPreparationPlanReceipt | null>;
  canPlayerEquipItem?: (playerId: string, itemId: string | number) => boolean;
  equipItemDirect?: (
    playerId: string,
    itemId: string | number,
    quantity?: number,
  ) => Promise<{
    success: boolean;
    error?: string;
    equippedSlot?: string;
    displacedItems: Array<{ itemId: string; slot: string; quantity: number }>;
  }>;
  unequipItemDirect?: (
    playerId: string,
    slotName: string,
  ) => Promise<{
    success: boolean;
    error?: string;
    itemId?: string;
    quantity: number;
  }>;
  /** Slot name → Item or null; same source the game client uses. */
  getEquipmentData?: (playerId: string) => Record<string, unknown>;
  switchOwnedCombatLoadout?: (
    playerId: string,
    request: {
      operationId: string;
      requestFingerprint: string;
      targetRole: SwitchableStreamingCombatRole;
      allowedLoadouts: FrozenStreamingCombatLoadouts;
      publicActionObservation?: StreamingDuelRoleSwitchObservationContext;
    },
  ) => Promise<{
    ok: boolean;
    changed: boolean;
    replayed: boolean;
    reason?: string;
  }>;
} | null;

/** Type for network with send method */
interface NetworkWithSend {
  send: <T>(name: string, data: T, ignoreSocketId?: string) => void;
}

type AgentCombatData = {
  inCombat?: boolean;
  combatTarget?: string | null;
  ct?: string | null;
  c?: boolean;
  attackTarget?: string | null;
};

// ============================================================================
// Constants
// ============================================================================

/** Duel-eligible bronze weapons with certified canonical-avatar presentation. */
const DUEL_BRONZE_WEAPON_IDS = [
  "bronze_shortsword",
  "bronze_longsword",
  "bronze_scimitar",
] as const;

/** Weapon types whose canonical-avatar motion sheets pass the launch gate. */
export const STREAMING_DUEL_PRESENTATION_ELIGIBLE_MELEE_WEAPON_TYPES = new Set([
  // The canonical item manifest names the shortsword family `SWORD`.
  "SWORD",
  "LONGSWORD",
  "SCIMITAR",
]);

export function isStreamingDuelMeleeWeaponTypePresentationEligible(
  weaponType: unknown,
): boolean {
  return (
    typeof weaponType === "string" &&
    STREAMING_DUEL_PRESENTATION_ELIGIBLE_MELEE_WEAPON_TYPES.has(
      weaponType.toUpperCase(),
    )
  );
}
/**
 * Half of the presentation-space center separation for melee contestants.
 * 0.65 keeps each center inside its cardinally adjacent tile while leaving a
 * 0.7-unit gap between the avatars' 0.3-radius spatial capsules. This prevents
 * normal attack poses from reading as body overlap without changing tile-range
 * authority or introducing a second bell-time reposition.
 */
const STREAMING_COMBAT_START_OFFSET = 0.65;

/** Combat role types for duel arena agents. */
export type DuelCombatRole = "melee" | "ranged" | "mage" | "prayer";

/**
 * When skill scores tie, prefer ranged/mage over melee so streaming duels
 * actually exercise bow and magic (default stats are often all equal).
 */
const ROLE_SCORE_TIE_ORDER: readonly DuelCombatRole[] = [
  "ranged",
  "mage",
  "prayer",
  "melee",
];

/** Fallback gear when skill-based selection fails or entity is missing. */
const MELEE_FALLBACK_WEAPON = "bronze_shortsword";
const RANGED_FALLBACK_BOW = "shortbow";
const RANGED_FALLBACK_ARROW = "bronze_arrow";
const MAGE_FALLBACK_STAFF = "staff_of_air";
const MAGE_FALLBACK_SPELL = "wind_strike";
const STANDALONE_SINGLE_STYLE_MELEE_WEAPON = "bronze_shortsword";
const RUNE_PROVISION_QTY = 500;
const COMPETITIVE_EQUIPMENT_SLOTS: readonly CompetitiveEquipmentSlotName[] = [
  "weapon",
  "shield",
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
  "amulet",
  "ring",
  "arrows",
];

type DuelCombatAIDiagnosticSnapshot = {
  characterId: string;
  cycleId: string | null;
  duelId: string | null;
  active: boolean;
  capturedAtMs: number;
} & ReturnType<DuelCombatAI["getStats"]>;

export function resolveStandaloneSingleStyleCombatLoadout(
  role: DuelCombatRole,
): Readonly<{
  weaponId: string;
  arrowsId: string | null;
  spellId: string | null;
}> {
  if (role === "ranged") {
    return Object.freeze({
      weaponId: RANGED_FALLBACK_BOW,
      arrowsId: RANGED_FALLBACK_ARROW,
      spellId: null,
    });
  }
  if (role === "mage") {
    return Object.freeze({
      weaponId: MAGE_FALLBACK_STAFF,
      arrowsId: null,
      spellId: MAGE_FALLBACK_SPELL,
    });
  }
  return Object.freeze({
    weaponId: STANDALONE_SINGLE_STYLE_MELEE_WEAPON,
    arrowsId: null,
    spellId: null,
  });
}

// ============================================================================
// DuelOrchestrator Class
// ============================================================================

export class DuelOrchestrator {
  // -- Owned state --
  private combatAIs: Map<string, DuelCombatAI> = new Map();
  /** Bounded post-terminal evidence for the most recently stopped pair only. */
  private lastStoppedCombatAIDiagnostics: DuelCombatAIDiagnosticSnapshot[] = [];
  private validatedCompetitiveAgentPolicies: {
    cycleId: string;
    manager: CompetitiveAgentPolicyManager;
    agents: Map<string, ValidatedCompetitiveAgentPolicy>;
  } | null = null;
  /** Services locked into arena mode — bounds cleared and autonomy restored in stopCombatAIs. */
  private _arenaModeServices: Array<{
    service: {
      clearArenaBounds(): void;
      setAutonomousBehaviorEnabled(enabled: boolean): void;
      isAutonomousBehaviorConfigured?(): boolean;
    };
    wasAutonomous: boolean;
  }> = [];
  private combatLoopInterval: ReturnType<typeof setInterval> | null = null;
  private combatLoopTickCount: number = 0;
  private combatRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  private victoryEmoteTimeout: ReturnType<typeof setTimeout> | null = null;
  private combatRetryCount: number = 0;
  private static readonly MAX_COMBAT_RETRIES = 5;
  private engagementMetrics: Omit<
    StreamingCombatEngagementMetrics,
    "currentRetryCount"
  > = {
    checks: 0,
    retries: 0,
    recoveries: 0,
    failures: 0,
    proximityCorrections: 0,
  };
  private duelFoodSlotsByAgent: Map<string, DuelFoodProvisionedSlot[]> =
    new Map();
  private combatRolesByAgent: Map<string, DuelCombatRole> = new Map();
  private combatSetupSnapshotsByAgent = new Map<
    string,
    DuelCombatSetupSnapshot
  >();
  private combatSetupInFlightByAgent = new Map<string, Promise<string>>();
  /**
   * Receipt-backed prayer teardown starts as soon as combat becomes terminal
   * and is awaited again by cycle cleanup. Keeping the same promise closes the
   * ten-second presentation window where an arena prayer could otherwise keep
   * draining after combat authority has stopped.
   */
  private prayerTeardownInFlightByCycle = new Map<string, Promise<void>>();
  /** Fence for async controller ticks whose authority was just revoked. */
  private combatAiShutdownInFlight: Promise<void> = Promise.resolve();
  /** One pair-level controller transaction; scheduled ticks coalesce while busy. */
  private combatAiTickInFlight: Promise<void> | null = null;
  /**
   * Fence for database-backed arrow/rune terminals created while combat stops.
   * Loadout cleanup and player unload must not overtake these exact receipts.
   */
  private combatCustodyShutdownInFlight: Promise<void> = Promise.resolve();
  /** Durable publication boundary plus immutable public tail for one cycle. */
  private readonly publicActionObservations: StreamingDuelActionObservationLedger;
  /** Debug director: force a contestant's combat style for the next prep only. */
  private debugCombatRoleOverrideByCharacterId = new Map<
    string,
    DuelCombatRole
  >();
  /**
   * Explicit loopback/no-money diagnostics that exercise the real frozen
   * loadout switch controller. The runtime boundary is rechecked at freeze,
   * preparation, and every switch; this set alone grants no authority.
   */
  private diagnosticMultiStyleCharacterIds = new Set<string>();
  // ---- Contestant Cache (Memory Optimization) ----
  /** Cached contestant objects keyed by "agentId:opponentId" */
  private _contestantCache: Map<string, AgentContestant> = new Map();
  /** Cache expiry timestamp for contestant cache */
  private _contestantCacheExpiry = 0;
  /** Cache duration in ms (invalidate every 250ms to allow HP updates) */
  private static readonly CONTESTANT_CACHE_TTL_MS = 250;

  constructor(
    private readonly world: World,
    private readonly getCurrentCycle: () => StreamingDuelCycle | null,
    private readonly setCurrentCycleFields: (
      fields: Partial<StreamingDuelCycle>,
    ) => void,
    private readonly getAgentStats: () => Map<
      string,
      {
        characterId: string;
        name: string;
        provider: string;
        model: string;
        wins: number;
        losses: number;
        combatLevel: number;
        currentStreak: number;
      }
    >,
    private readonly onResolution: (
      winnerId: string | null,
      loserId: string | null,
      winReason: StreamingDuelWinReason,
      terminalAtOverride?: number,
    ) => void,
    private readonly onAbort: (
      reason: string,
      occurredAtOverride?: number,
    ) => void,
    private readonly getLeaderboard: () => LeaderboardEntry[],
    private readonly getRecentDuels: () => RecentDuelEntry[],
    private readonly isSyntheticDiagnosticAgent: (
      playerId: string,
    ) => boolean = () => false,
    publicActionObservationStore: StreamingDuelActionObservationStore | null = null,
    private readonly isEquipmentPresentationEligible: (
      itemId: string,
      slot: CompetitiveEquipmentSlotName,
    ) => boolean = isStreamingDuelEquipmentPresentationEligible,
  ) {
    this.publicActionObservations = new StreamingDuelActionObservationLedger(
      publicActionObservationStore,
      {
        onError: (message) => {
          Logger.warn(
            "StreamingDuelScheduler",
            `Public duel action persistence degraded: ${message}`,
          );
        },
      },
    );
  }

  // ============================================================================
  // Public accessors for state owned by this orchestrator
  // ============================================================================

  /** Get the duel food slots tracked by this orchestrator for a given agent. */
  getDuelFoodSlotsByAgent(): Map<string, DuelFoodProvisionedSlot[]> {
    return this.duelFoodSlotsByAgent;
  }

  getEngagementMetrics(): StreamingCombatEngagementMetrics {
    return {
      ...this.engagementMetrics,
      currentRetryCount: this.combatRetryCount,
    };
  }

  getPublicActionObservations(
    cycleId: string,
  ): readonly StreamingDuelActionObservation[] {
    return this.publicActionObservations.getSnapshot(cycleId);
  }

  getPublicActionObservationHealth(): StreamingDuelActionObservationLedgerHealth {
    return this.publicActionObservations.getHealth();
  }

  activatePublicActionObservations(cycleId: string): void {
    this.publicActionObservations.activateCycle(cycleId);
  }

  waitForPublicActionObservations(): Promise<void> {
    return this.publicActionObservations.waitForIdle();
  }

  private recordControllerPublicAction(
    cycleId: string,
    duelId: string,
    actorId: string,
    opponentId: string,
    observation: DuelCombatPublicActionObservation,
    persistence?: StreamingDuelActionObservationPersistence,
  ): void {
    const cycle = this.getCurrentCycle();
    if (
      !cycle ||
      cycle.cycleId !== cycleId ||
      cycle.phase !== "FIGHTING" ||
      ![cycle.agent1?.characterId, cycle.agent2?.characterId].includes(
        actorId,
      ) ||
      ![cycle.agent1?.characterId, cycle.agent2?.characterId].includes(
        opponentId,
      ) ||
      actorId === opponentId
    ) {
      return;
    }

    const accepted = this.publicActionObservations.record(
      {
        ...observation,
        cycleId,
        duelId,
        actorId,
        opponentId,
        phase: "FIGHTING",
      } as StreamingDuelActionObservationDraft,
      persistence,
    );
    if (!accepted) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Rejected public duel action observation for ${actorId}`,
      );
    }
  }

  createAuthoritativeDamageObservationContext(
    attackerId: string,
    targetId: string,
    requestedDamage: number,
  ): StreamingDuelDamageObservationContext | null {
    const cycle = this.getCurrentCycle();
    if (
      !cycle ||
      cycle.phase !== "FIGHTING" ||
      !Number.isSafeInteger(requestedDamage) ||
      requestedDamage <= 0 ||
      !(
        (attackerId === cycle.agent1?.characterId &&
          targetId === cycle.agent2?.characterId) ||
        (attackerId === cycle.agent2?.characterId &&
          targetId === cycle.agent1?.characterId)
      )
    ) {
      return null;
    }
    const ai = this.combatAIs.get(attackerId);
    if (!ai) return null;
    const stats = ai.getStats();
    const parsed = parseStreamingDuelDamageObservationContext({
      operationId: crypto.randomUUID(),
      tick: stats.tickCount,
      observedAt: Date.now(),
      cycleId: cycle.cycleId,
      duelId: cycle.duelId ?? `streaming-${cycle.cycleId}`,
      actorId: attackerId,
      opponentId: targetId,
      phase: "FIGHTING",
      combatRole: stats.combatRole,
      tacticalMacro: stats.lastExecutedTacticalMacro,
      requestedDamage,
    });
    return parsed;
  }

  recordAuthoritativeDamageObservation(
    attackerId: string,
    targetId: string,
    damage: number,
    context?: StreamingDuelDamageObservationContext,
  ): void {
    const cycle = this.getCurrentCycle();
    if (!cycle || cycle.phase !== "FIGHTING") return;
    const parsedContext =
      context === undefined
        ? null
        : parseStreamingDuelDamageObservationContext(context);
    if (context !== undefined) {
      if (
        !parsedContext ||
        parsedContext.cycleId !== cycle.cycleId ||
        parsedContext.duelId !==
          (cycle.duelId ?? `streaming-${cycle.cycleId}`) ||
        parsedContext.actorId !== attackerId ||
        parsedContext.opponentId !== targetId ||
        damage > parsedContext.requestedDamage
      ) {
        Logger.warn(
          "StreamingDuelScheduler",
          "Rejected mismatched authoritative duel damage receipt",
        );
        return;
      }
      this.recordControllerPublicAction(
        parsedContext.cycleId,
        parsedContext.duelId,
        attackerId,
        targetId,
        {
          tick: parsedContext.tick,
          combatRole: parsedContext.combatRole,
          tacticalMacro: parsedContext.tacticalMacro,
          action: "damage",
          outcome: "committed",
          value: "hit",
          amount: damage,
        },
        {
          operationId: parsedContext.operationId,
          observedAt: parsedContext.observedAt,
        },
      );
      return;
    }

    // Unit/local worlds without PostgreSQL retain immediate presentation. A
    // configured production ledger never accepts an unreceipted duel hit.
    if (this.publicActionObservations.getHealth().configured) {
      Logger.warn(
        "StreamingDuelScheduler",
        "Rejected duel damage without its atomic health receipt",
      );
      return;
    }
    const ai = this.combatAIs.get(attackerId);
    if (!ai) return;
    const stats = ai.getStats();
    if (
      stats.combatRole !== "melee" &&
      stats.combatRole !== "ranged" &&
      stats.combatRole !== "mage"
    ) {
      return;
    }
    this.recordControllerPublicAction(
      cycle.cycleId,
      cycle.duelId ?? `streaming-${cycle.cycleId}`,
      attackerId,
      targetId,
      {
        tick: stats.tickCount,
        combatRole: stats.combatRole,
        tacticalMacro: stats.lastExecutedTacticalMacro,
        action: "damage",
        outcome: "committed",
        value: "hit",
        amount: damage,
      },
    );
  }

  // ============================================================================
  // Contestant Creation
  // ============================================================================

  /**
   * Create or update a cached AgentContestant for streaming state.
   * MEMORY OPTIMIZATION: Caches and updates contestants in place to avoid
   * creating new objects every 500ms broadcast.
   */
  createContestant(
    agentId: string,
    opponentId?: string,
  ): AgentContestant | null {
    const now = Date.now();
    const cacheKey = `${agentId}:${opponentId ?? ""}`;

    // Check cache expiry
    if (now > this._contestantCacheExpiry) {
      this._contestantCache.clear();
      this._contestantCacheExpiry =
        now + DuelOrchestrator.CONTESTANT_CACHE_TTL_MS;
    }

    // Check for cached contestant
    const cached = this._contestantCache.get(cacheKey);

    const entity = this.world.entities.get(agentId);
    if (!entity) {
      // Remove from cache if entity no longer exists
      if (cached) this._contestantCache.delete(cacheKey);
      return null;
    }

    const data = entity.data as {
      name?: string;
      health?: number;
      maxHealth?: number;
      position?: [number, number, number] | { x: number; y: number; z: number };
      skills?: Record<string, { level: number }>;
      equipment?: unknown;
      inventory?: unknown;
    };

    // If cached, just update mutable fields (HP, stats) and return
    if (cached) {
      const stats = this.getAgentStats().get(agentId);
      const skills = this.getAgentSkillLevels(agentId);
      const constitution = skills.constitution || 10;
      const currentHealth = Number(data.health);

      cached.currentHp = Number.isFinite(currentHealth)
        ? Math.max(0, Math.min(constitution, currentHealth))
        : constitution;
      cached.maxHp = constitution;
      cached.wins = stats?.wins || 0;
      cached.losses = stats?.losses || 0;
      const loadout = this.snapshotLoadoutFromWorld(agentId, data);
      cached.equipment = loadout.equipment;
      cached.inventory = loadout.inventory;
      cached.itemIconPaths = this.buildItemIconPathsForLoadout(
        cached.equipment,
        cached.inventory,
      );
      return cached;
    }

    // Create new contestant (first time only)
    const stats = this.getAgentStats().get(agentId);
    const parts = agentId.split("-");
    const provider = parts[1] || "unknown";
    const model = parts.slice(2).join("-") || "unknown";

    const entityPosition = (entity as { position?: unknown }).position;
    const normalizedPosition =
      this.normalizePosition(data.position) ??
      this.normalizePosition(entityPosition);
    const originalPosition = this.sanitizeRestorePosition(
      normalizedPosition,
      agentId,
    );

    // Calculate combat level
    const skills = this.getAgentSkillLevels(agentId);
    const attack = skills.attack || 1;
    const strength = skills.strength || 1;
    const defense = skills.defense || 1;
    const constitution = skills.constitution || 10;
    const combatLevel = calculateCombatLevel({
      attack,
      strength,
      defense,
      hitpoints: constitution,
      ranged: skills.ranged || 1,
      magic: skills.magic || 1,
      prayer: skills.prayer || 1,
    });

    let rank = 0;
    const leaderboard = this.getLeaderboard();
    for (let i = 0; i < leaderboard.length; i++) {
      if (leaderboard[i].characterId === agentId) {
        rank = leaderboard[i].rank;
        break;
      }
    }

    let headToHeadWins = 0;
    let headToHeadLosses = 0;
    if (opponentId) {
      for (const duel of this.getRecentDuels()) {
        if (duel.winnerId === agentId && duel.loserId === opponentId) {
          headToHeadWins++;
        } else if (duel.winnerId === opponentId && duel.loserId === agentId) {
          headToHeadLosses++;
        }
      }
    }

    const loadout = this.snapshotLoadoutFromWorld(agentId, data);
    const itemIconPaths = this.buildItemIconPathsForLoadout(
      loadout.equipment,
      loadout.inventory,
    );
    const prayerCustody = this.getPrayerSystem()?.getPrayerCustody?.(agentId);
    const currentHealth = Number(data.health);
    const contestant: AgentContestant = {
      characterId: agentId,
      name: data.name || agentId,
      provider,
      model,
      combatLevel,
      wins: stats?.wins || 0,
      losses: stats?.losses || 0,
      currentHp: Number.isFinite(currentHealth)
        ? Math.max(0, Math.min(constitution, currentHealth))
        : constitution,
      maxHp: constitution,
      originalPosition,
      damageDealtThisFight: 0,
      highestHit: 0,
      attacksLanded: 0,
      healsUsed: 0,
      equipment: loadout.equipment,
      inventory: loadout.inventory,
      itemIconPaths,
      loadoutFingerprint: null,
      availableCombatStyles: [],
      combatLoadouts: {},
      loadoutFrozen: false,
      prayerPointUnits: prayerCustody?.pointUnits ?? 0,
      prayerPoints: prayerCustody?.points ?? 0,
      prayerMaxPoints: prayerCustody?.maxPoints ?? 1,
      rank,
      headToHeadWins,
      headToHeadLosses,
    };

    // Cache for future calls
    this._contestantCache.set(cacheKey, contestant);
    return contestant;
  }

  /** Clear the contestant cache (call when cycle ends) */
  clearContestantCache(): void {
    this._contestantCache.clear();
    this._contestantCacheExpiry = 0;
  }

  snapshotAgentEquipment(equipment: unknown): Record<string, string> {
    if (!equipment || typeof equipment !== "object") {
      return {};
    }

    const snapshot: Record<string, string> = {};
    for (const [slot, rawValue] of Object.entries(
      equipment as Record<string, unknown>,
    )) {
      const itemId = this.extractItemId(rawValue);
      if (itemId) {
        snapshot[slot] = itemId;
      }
    }
    return snapshot;
  }

  snapshotAgentInventory(
    inventory: unknown,
  ): Array<{ itemId: string; quantity: number } | null> {
    const slots: Array<{ itemId: string; quantity: number } | null> =
      Array.from({ length: 28 }, () => null);

    const sourceItems = Array.isArray(inventory)
      ? inventory
      : inventory &&
          typeof inventory === "object" &&
          Array.isArray((inventory as { items?: unknown[] }).items)
        ? ((inventory as { items: unknown[] }).items ?? [])
        : [];

    for (const [index, rawItem] of sourceItems.entries()) {
      if (!rawItem || typeof rawItem !== "object") {
        continue;
      }

      const item = rawItem as Record<string, unknown>;
      const itemId = this.extractItemId(item);
      if (!itemId) {
        continue;
      }

      const rawSlot = Number(item.slot);
      const slot = Number.isFinite(rawSlot) ? rawSlot : index;
      if (slot < 0 || slot >= slots.length) {
        continue;
      }

      const rawQuantity = Number(item.quantity ?? item.qty ?? 1);
      const quantity =
        Number.isFinite(rawQuantity) && rawQuantity > 0
          ? Math.floor(rawQuantity)
          : 1;

      slots[slot] = { itemId, quantity };
    }

    return slots;
  }

  extractItemId(value: unknown): string | null {
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : null;
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    const direct = record.itemId ?? record.id;
    if (typeof direct === "string") {
      const normalized = direct.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }

    const nested = record.item;
    if (nested && typeof nested === "object") {
      const nestedRecord = nested as Record<string, unknown>;
      const nestedId = nestedRecord.itemId ?? nestedRecord.id;
      if (typeof nestedId === "string") {
        const normalized = nestedId.trim();
        return normalized.length > 0 ? normalized : null;
      }
    }

    return null;
  }

  /**
   * Read inventory/equipment from character systems when available.
   * Streaming overlay icons were empty because entity.data.* is not kept in sync
   * with InventorySystem / EquipmentSystem.
   */
  private snapshotLoadoutFromWorld(
    playerId: string,
    entityData: { equipment?: unknown; inventory?: unknown },
  ): {
    equipment: Record<string, string>;
    inventory: Array<{ itemId: string; quantity: number } | null>;
  } {
    const invSys = this.world.getSystem("inventory") as InventorySystem | null;
    const inventory = invSys?.getInventoryData
      ? this.snapshotAgentInventory(
          invSys.getInventoryData(playerId).items ?? [],
        )
      : this.snapshotAgentInventory(entityData.inventory);

    const eqSys = this.world.getSystem("equipment") as EquipmentSystem | null;
    const equipment = eqSys?.getEquipmentData
      ? this.snapshotAgentEquipment(eqSys.getEquipmentData(playerId))
      : this.snapshotAgentEquipment(entityData.equipment);

    return { equipment, inventory };
  }

  /**
   * Map each item id in the loadout to manifest iconPath so the streaming client
   * can show PNGs without relying on browser-side ITEMS or cross-host manifest fetch.
   */
  buildItemIconPathsForLoadout(
    equipment: Record<string, string>,
    inventory: Array<{ itemId: string; quantity: number } | null>,
  ): Record<string, string> {
    const paths: Record<string, string> = {};
    const ids = new Set<string>();
    for (const v of Object.values(equipment)) {
      if (typeof v === "string" && v.trim()) {
        ids.add(v.trim());
      }
    }
    for (const cell of inventory) {
      if (cell?.itemId?.trim()) {
        ids.add(cell.itemId.trim());
      }
    }
    for (const rawId of ids) {
      const normalized = rawId.endsWith("_noted")
        ? rawId.replace(/_noted$/, "")
        : rawId;
      const def = getItem(normalized) ?? getItem(rawId);
      const p = def?.iconPath?.trim();
      if (!p || !isServedStreamingItemIcon(p)) {
        continue;
      }
      paths[rawId] = p;
      if (normalized !== rawId && paths[normalized] === undefined) {
        paths[normalized] = p;
      }
    }
    return paths;
  }

  /** Re-sync contestant loadout from world systems (call during fight broadcasts). */
  refreshContestantLoadout(contestant: AgentContestant): void {
    const entity = this.world.entities.get(contestant.characterId);
    const data = (entity?.data ?? {}) as {
      equipment?: unknown;
      inventory?: unknown;
    };
    const next = this.snapshotLoadoutFromWorld(contestant.characterId, data);
    contestant.equipment = next.equipment;
    contestant.inventory = next.inventory;
    contestant.itemIconPaths = this.buildItemIconPathsForLoadout(
      contestant.equipment,
      contestant.inventory,
    );
    const prayer = this.getPrayerSystem()?.getPrayerCustody?.(
      contestant.characterId,
    );
    if (prayer?.ready) {
      contestant.prayerPointUnits = prayer.pointUnits;
      contestant.prayerPoints = prayer.points;
      contestant.prayerMaxPoints = prayer.maxPoints;
    }
  }

  // ============================================================================
  // Duel Preparation
  // ============================================================================

  async prepareContestantsForDuel(): Promise<void> {
    const cycle = this.getCurrentCycle();
    if (!cycle?.agent1 || !cycle?.agent2) return;

    const { agent1, agent2 } = cycle;
    const preparedCycleId = cycle.cycleId;
    const levelDiff = Math.abs(agent1.combatLevel - agent2.combatLevel);
    const frozen1 = this.combatSetupSnapshotsByAgent.get(agent1.characterId);
    const frozen2 = this.combatSetupSnapshotsByAgent.get(agent2.characterId);
    if (!frozen1 || !frozen2) {
      throw new Error("competitive_loadout_not_frozen");
    }
    if (
      frozen1.diagnosticProvisioningAllowed !==
      frozen2.diagnosticProvisioningAllowed
    ) {
      throw new Error("mixed_diagnostic_and_competitive_matchup");
    }
    if (!frozen1.diagnosticProvisioningAllowed) {
      this.assertCompetitiveLoadoutUnchanged(agent1.characterId, frozen1);
      this.assertCompetitiveLoadoutUnchanged(agent2.characterId, frozen2);
    }

    // CRITICAL: Stop any active combat and movement BEFORE any async
    // operations below. During awaits, the event loop is free and combat
    // system ticks can fire — if agents are still in combat, attack/damage
    // events would be broadcast at pre-arena positions.
    this.forceStopAgentCombat(agent1.characterId);
    this.forceStopAgentCombat(agent2.characterId);
    await this.waitForCombatCustodySettlements();
    this.world.emit("player:movement:cancel", { playerId: agent1.characterId });
    this.world.emit("player:movement:cancel", { playerId: agent2.characterId });

    let role1 = frozen1.initialCombatRole;
    let role2 = frozen2.initialCombatRole;
    let weapon1 = frozen1.equipment.weapon?.itemId ?? "unarmed";
    let weapon2 = frozen2.equipment.weapon?.itemId ?? "unarmed";

    if (frozen1.diagnosticProvisioningAllowed) {
      // Isolated local diagnostics intentionally retain style-directed setup
      // so render and combat scenarios can be reproduced without an economy.
      const [base1, base2] = this.assignCombatRolesForDuelPair(
        agent1.characterId,
        agent2.characterId,
      );
      [role1, role2] = this.applyDebugCombatRoleOverrides(
        agent1.characterId,
        agent2.characterId,
        base1,
        base2,
      );
    }
    this.combatRolesByAgent.set(agent1.characterId, role1);
    this.combatRolesByAgent.set(agent2.characterId, role2);
    if (frozen1.diagnosticProvisioningAllowed) {
      const setup1 = frozen1.diagnosticMultiStyleAllowed
        ? this.ensureDiagnosticMultiStyleCombatSetup(
            agent1.characterId,
            role1,
            frozen1.combatLoadouts,
          )
        : this.ensureAgentCombatSetup(agent1.characterId, role1);
      const setup2 = frozen2.diagnosticMultiStyleAllowed
        ? this.ensureDiagnosticMultiStyleCombatSetup(
            agent2.characterId,
            role2,
            frozen2.combatLoadouts,
          )
        : this.ensureAgentCombatSetup(agent2.characterId, role2);
      this.combatSetupInFlightByAgent.set(agent1.characterId, setup1);
      this.combatSetupInFlightByAgent.set(agent2.characterId, setup2);

      const setupResults = await Promise.allSettled([setup1, setup2]);
      if (this.combatSetupInFlightByAgent.get(agent1.characterId) === setup1) {
        this.combatSetupInFlightByAgent.delete(agent1.characterId);
      }
      if (this.combatSetupInFlightByAgent.get(agent2.characterId) === setup2) {
        this.combatSetupInFlightByAgent.delete(agent2.characterId);
      }

      if (setupResults[0].status === "rejected") {
        throw setupResults[0].reason;
      }
      if (setupResults[1].status === "rejected") {
        throw setupResults[1].reason;
      }
      weapon1 = setupResults[0].value;
      weapon2 = setupResults[1].value;
    }

    // Shutdown/cancellation may have won the race while setup was awaiting DB
    // persistence. Its cleanup waits for these setup promises and restores the
    // snapshot; do not mutate health/prayer after that cycle is no longer live.
    if (this.getCurrentCycle()?.cycleId !== preparedCycleId) {
      return;
    }

    // NOTE: Food provisioning removed — agents must self-provision food
    // through fishing/cooking between duels. They fight with whatever
    // food/gear they've gathered autonomously.

    // Health remains a duel-rule reset. Prayer is a conserved preparation
    // resource for competitive contestants and may only be provisioned in the
    // explicitly isolated diagnostic path.
    this.restoreHealth(agent1.characterId);
    this.restoreHealth(agent2.characterId);
    if (frozen1.diagnosticProvisioningAllowed) {
      await Promise.all([
        this.restorePrayerPointsForDuel(agent1.characterId),
        this.restorePrayerPointsForDuel(agent2.characterId),
      ]);
    }

    // NOTE: Teleport is handled separately in startCountdown() so agents
    // appear in the arena at the exact moment the countdown begins on screen.

    Logger.info(
      "StreamingDuelScheduler",
      `Contestants prepared: ${agent1.name} (${role1}, ${weapon1}) vs ${agent2.name} (${role2}, ${weapon2}) (levelDiff=${levelDiff})`,
    );
  }

  private assertCompetitiveLoadoutUnchanged(
    playerId: string,
    frozen: DuelCombatSetupSnapshot,
  ): void {
    const current = this.buildCompetitiveLoadoutSnapshot(playerId, true);
    if (!current.result.ok || !current.snapshot) {
      throw new Error(
        `competitive_loadout_unavailable:${current.result.ok ? "unknown" : current.result.reason}`,
      );
    }
    if (current.snapshot.fingerprint !== frozen.fingerprint) {
      throw new Error("competitive_loadout_changed_after_market_open");
    }
  }

  getBronzeWeaponPool(): string[] {
    const manifestWeapons = Array.from(ITEMS.values())
      .filter((item) => {
        if (item.type !== "weapon") return false;
        if ((item.tier ?? "").toLowerCase() !== "bronze") return false;
        if (item.equipable === false) return false;
        if (item.equipSlot !== "weapon" && item.equipSlot !== "2h")
          return false;
        if (!isStreamingDuelEquipmentPresentationEligible(item.id, "weapon"))
          return false;
        return isStreamingDuelMeleeWeaponTypePresentationEligible(
          item.weaponType,
        );
      })
      .map((item) => item.id);

    if (manifestWeapons.length > 0) {
      return manifestWeapons;
    }

    return [...DUEL_BRONZE_WEAPON_IDS];
  }

  getEquippedWeaponId(playerId: string): string | null {
    const equipmentSystem = this.getEquipmentSystem();
    if (!equipmentSystem?.getPlayerEquipment) {
      return null;
    }

    const equipment = equipmentSystem.getPlayerEquipment(playerId);
    const weaponSlot = equipment?.weapon;
    const rawWeaponId = weaponSlot?.itemId ?? weaponSlot?.item?.id ?? null;
    if (rawWeaponId === null || rawWeaponId === undefined) {
      return null;
    }

    const normalizedWeaponId = String(rawWeaponId).trim();
    return normalizedWeaponId.length > 0 ? normalizedWeaponId : null;
  }

  /**
   * Validate a contestant without mutating or reserving their state. The
   * scheduler uses this before matchmaking so an invalid contestant can never
   * create a market-open event.
   */
  inspectCompetitiveLoadout(playerId: string): CompetitiveLoadoutFreezeResult {
    return this.buildCompetitiveLoadoutSnapshot(playerId, false).result;
  }

  /** Deactivate persisted ambient prayers before the immutable market
   * snapshot. This is an authorized state transition, not a resource top-up. */
  async preparePrayerForCompetitiveFreeze(
    playerId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.isDiagnosticProvisioningAllowed(playerId)) return { ok: true };
    const prayer = this.getPrayerSystem();
    const initial = prayer?.getPrayerCustody?.(playerId);
    if (!initial) return { ok: false, reason: "prayer_state_unavailable" };
    if (!initial.ready || !initial.persistenceHealthy) {
      return { ok: false, reason: "prayer_state_not_ready" };
    }
    if (initial.activePrayers.length > 0) {
      if (!prayer?.deactivateAllPrayers) {
        return {
          ok: false,
          reason: "prayer_deactivation_unavailable",
        };
      }
      const receipt = await prayer.deactivateAllPrayers(
        playerId,
        `market-freeze-prayer:${crypto.randomUUID()}`,
      );
      if (!receipt.success || receipt.activePrayers.length > 0) {
        return {
          ok: false,
          reason: receipt.reason ?? "prayer_deactivation_failed",
        };
      }
    }
    const committed = prayer?.getPrayerCustody?.(playerId);
    if (
      !committed?.ready ||
      !committed.persistenceHealthy ||
      committed.activePrayers.length > 0
    ) {
      return { ok: false, reason: "prayer_state_not_freezable" };
    }
    return { ok: true };
  }

  /**
   * Replay the immutable whole-plan receipt before a replacement process
   * reconstructs a public competitive snapshot. The equipment system repairs
   * only custody-conserving durable projection drift and then applies the same
   * receipt to live inventory/equipment state.
   */
  async recoverCompetitivePreparationLoadout(
    playerId: string,
    preparationId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const equipmentSystem = this.getEquipmentSystem();
    if (!equipmentSystem?.recoverOwnedDuelPreparationPlan) {
      return { ok: false, reason: "atomic_persistence_unavailable" };
    }
    const operationId = getDuelPreparationPlanOperationId(
      preparationId,
      playerId,
    );
    try {
      const receipt = await equipmentSystem.recoverOwnedDuelPreparationPlan(
        playerId,
        { operationId, preparationId },
      );
      if (!receipt) {
        return { ok: false, reason: "preparation_plan_missing" };
      }
      if (!receipt.ok) return { ok: false, reason: receipt.reason };
      if (
        receipt.playerId !== playerId ||
        receipt.preparationId !== preparationId ||
        receipt.operationId !== operationId
      ) {
        return { ok: false, reason: "committed_state_apply_failed" };
      }
      return { ok: true };
    } catch (error) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Competitive preparation recovery failed for ${playerId}: ${errMsg(error)}`,
      );
      return { ok: false, reason: "persistence_failed" };
    }
  }

  /**
   * Freeze the exact equipment, inventory, spell, and combat skill levels that
   * bettors will evaluate. This must happen before any market-open event.
   */
  freezeCompetitiveLoadout(
    contestant: AgentContestant,
  ): CompetitiveLoadoutFreezeResult {
    if (this.combatSetupSnapshotsByAgent.has(contestant.characterId)) {
      return { ok: false, reason: "competitive_loadout_already_frozen" };
    }

    const built = this.buildCompetitiveLoadoutSnapshot(
      contestant.characterId,
      true,
    );
    if (!built.result.ok || !built.snapshot) {
      return built.result;
    }

    this.combatSetupSnapshotsByAgent.set(
      contestant.characterId,
      built.snapshot,
    );
    contestant.loadoutFingerprint = built.result.fingerprint;
    contestant.availableCombatStyles = [...built.result.availableCombatStyles];
    contestant.combatLoadouts = this.cloneFrozenCombatLoadouts(
      built.result.combatLoadouts,
    );
    contestant.loadoutFrozen =
      !built.result.diagnostic || built.snapshot.diagnosticMultiStyleAllowed;
    contestant.prayerPointUnits = built.snapshot.prayer.pointUnits;
    contestant.prayerPoints = built.snapshot.prayer.points;
    contestant.prayerMaxPoints = built.snapshot.prayer.maxPoints;
    return built.result;
  }

  /**
   * Restore an already-normalized diagnostic freeze after a cold replacement.
   * This is deliberately unavailable to public/non-diagnostic contestants:
   * those must reconstruct and verify live custody through
   * freezeCompetitiveLoadout(). Local multi-style fixtures provision their
   * gear by design, so their persisted snapshot is the exact replay authority.
   */
  restoreDiagnosticCompetitiveLoadoutFromSnapshot(
    contestant: AgentContestant,
    persisted: CompetitiveSnapshotContestant,
  ): CompetitiveLoadoutFreezeResult {
    if (
      !isLocalDiagnosticDuelRuntime(process.env) ||
      !contestant.characterId.startsWith("sparbot-standalone-") ||
      contestant.characterId !== persisted.agentId ||
      persisted.preparation.planningSource !== "diagnostic" ||
      typeof persisted.loadoutFingerprint !== "string" ||
      this.combatSetupSnapshotsByAgent.has(contestant.characterId)
    ) {
      return {
        ok: false,
        reason: "diagnostic_snapshot_restore_not_authorized",
      };
    }

    const frozenEquipment = Object.fromEntries(
      COMPETITIVE_EQUIPMENT_SLOTS.map((slotName) => [slotName, null]),
    ) as Record<CompetitiveEquipmentSlotName, DuelEquipmentSlotSnapshot>;
    for (const item of persisted.equipment) {
      if (
        !COMPETITIVE_EQUIPMENT_SLOTS.includes(
          item.slot as CompetitiveEquipmentSlotName,
        )
      ) {
        return { ok: false, reason: "diagnostic_snapshot_slot_invalid" };
      }
      frozenEquipment[item.slot as CompetitiveEquipmentSlotName] = {
        itemId: item.itemId,
        quantity: item.quantity,
      };
    }
    const frozenInventory = persisted.inventory.map((item) => ({ ...item }));
    const frozenSkillLevels = Object.fromEntries(
      persisted.skillLevels.map((skill) => [skill.skill, skill.level]),
    );
    const prayer = {
      ...persisted.prayer,
      activePrayers: [...persisted.prayer.activePrayers],
    };
    const inventoryQuantityByItemId = new Map<string, number>();
    for (const item of frozenInventory) {
      inventoryQuantityByItemId.set(
        item.itemId,
        (inventoryQuantityByItemId.get(item.itemId) ?? 0) + item.quantity,
      );
    }
    const fingerprint = this.fingerprintCompetitiveLoadout({
      equipment: frozenEquipment,
      inventory: frozenInventory,
      selectedSpell: persisted.selectedSpell,
      skillLevels: frozenSkillLevels,
      prayer,
    });
    if (persisted.loadoutFingerprint !== fingerprint) {
      return {
        ok: false,
        reason: "diagnostic_snapshot_fingerprint_mismatch",
      };
    }
    const availableCombatStyles = [...persisted.availableCombatStyles];
    const diagnosticMultiStyleAllowed = availableCombatStyles.length > 1;
    const snapshot: DuelCombatSetupSnapshot = {
      equipment: frozenEquipment,
      selectedSpell: persisted.selectedSpell,
      inventoryQuantityByItemId,
      provisionedItemIds: new Set<string>(),
      frozenEquipment,
      frozenInventory,
      frozenSkillLevels,
      prayer,
      fingerprint,
      availableCombatStyles,
      combatLoadouts: this.cloneFrozenCombatLoadouts(persisted.combatLoadouts),
      initialCombatRole: persisted.initialCombatStyle,
      diagnosticProvisioningAllowed: true,
      diagnosticMultiStyleAllowed,
    };
    this.combatSetupSnapshotsByAgent.set(contestant.characterId, snapshot);
    contestant.loadoutFingerprint = fingerprint;
    contestant.availableCombatStyles = [...availableCombatStyles];
    contestant.combatLoadouts = this.cloneFrozenCombatLoadouts(
      persisted.combatLoadouts,
    );
    contestant.loadoutFrozen = diagnosticMultiStyleAllowed;
    contestant.prayerPointUnits = prayer.pointUnits;
    contestant.prayerPoints = prayer.points;
    contestant.prayerMaxPoints = prayer.maxPoints;
    return {
      ok: true,
      fingerprint,
      availableCombatStyles,
      combatLoadouts: this.cloneFrozenCombatLoadouts(persisted.combatLoadouts),
      initialCombatRole: persisted.initialCombatStyle,
      diagnostic: true,
    };
  }

  /** Public-only exact state captured by freezeCompetitiveLoadout(). */
  getFrozenCompetitiveState(playerId: string): FrozenCompetitiveState | null {
    const frozen = this.combatSetupSnapshotsByAgent.get(playerId);
    if (!frozen) return null;
    const equipment = Object.entries(frozen.frozenEquipment)
      .flatMap(([slot, item]) =>
        item ? [{ slot, itemId: item.itemId, quantity: item.quantity }] : [],
      )
      .sort((left, right) => left.slot.localeCompare(right.slot));
    const skillLevels = Object.entries(frozen.frozenSkillLevels)
      .map(([skill, level]) => ({ skill, level }))
      .sort((left, right) => left.skill.localeCompare(right.skill));
    return {
      equipment,
      inventory: frozen.frozenInventory.map((item) => ({ ...item })),
      selectedSpell: frozen.selectedSpell,
      skillLevels,
      prayer: {
        ...frozen.prayer,
        activePrayers: [...frozen.prayer.activePrayers],
      },
      fingerprint: frozen.fingerprint,
      initialCombatRole: frozen.initialCombatRole,
      availableCombatStyles: [...frozen.availableCombatStyles],
      combatLoadouts: this.cloneFrozenCombatLoadouts(frozen.combatLoadouts),
      diagnostic: frozen.diagnosticProvisioningAllowed,
    };
  }

  /** Release a freeze when cycle creation fails before a market exists. */
  releaseCompetitiveLoadout(playerId: string): void {
    this.combatSetupSnapshotsByAgent.delete(playerId);
    this.combatRolesByAgent.delete(playerId);
  }

  releaseCompetitiveLoadoutsForCycle(cycle: StreamingDuelCycle): void {
    for (const contestant of [cycle.agent1, cycle.agent2]) {
      if (contestant) this.releaseCompetitiveLoadout(contestant.characterId);
    }
  }

  private buildCompetitiveLoadoutSnapshot(
    playerId: string,
    requireInactivePrayer: boolean,
  ): {
    result: CompetitiveLoadoutFreezeResult;
    snapshot?: DuelCombatSetupSnapshot;
  } {
    const isSynthetic = this.isSyntheticDiagnosticAgent(playerId);
    if (
      isSynthetic &&
      process.env.NODE_ENV === "production" &&
      !isLocalDiagnosticDuelRuntime(process.env)
    ) {
      return {
        result: {
          ok: false,
          reason: "synthetic_diagnostic_contestant_disabled_in_production",
        },
      };
    }

    // Unit fixtures and explicitly registered local sparbots retain temporary
    // gear provisioning. No non-synthetic development contestant receives it.
    const diagnosticProvisioningAllowed =
      this.isDiagnosticProvisioningAllowed(playerId);
    const playerSystem = this.getPlayerSystem();
    if (playerSystem?.isPlayerReady && !playerSystem.isPlayerReady(playerId)) {
      return { result: { ok: false, reason: "player_state_not_ready" } };
    }
    if (!diagnosticProvisioningAllowed && !playerSystem?.isPlayerReady) {
      return {
        result: { ok: false, reason: "player_state_unavailable" },
      };
    }
    const entity = this.world.entities.get(playerId);
    if (!entity) {
      return { result: { ok: false, reason: "contestant_missing" } };
    }

    const equipmentSystem = this.getEquipmentSystem();
    const inventorySystem = this.getInventorySystem();
    if (!equipmentSystem?.getPlayerEquipment) {
      return {
        result: { ok: false, reason: "equipment_state_unavailable" },
      };
    }
    if (
      equipmentSystem.isEquipmentReady &&
      !equipmentSystem.isEquipmentReady(playerId)
    ) {
      return { result: { ok: false, reason: "equipment_not_ready" } };
    }
    if (!inventorySystem?.getInventory) {
      return {
        result: { ok: false, reason: "inventory_state_unavailable" },
      };
    }
    if (
      inventorySystem.isInventoryReady &&
      !inventorySystem.isInventoryReady(playerId)
    ) {
      return { result: { ok: false, reason: "inventory_not_ready" } };
    }

    const equipment = equipmentSystem.getPlayerEquipment(playerId);
    const inventory = inventorySystem.getInventory(playerId);
    if (!equipment) {
      return {
        result: { ok: false, reason: "equipment_not_initialized" },
      };
    }
    if (!inventory) {
      return {
        result: { ok: false, reason: "inventory_not_initialized" },
      };
    }

    const prayerSystem = this.getPrayerSystem();
    const prayerCustody = prayerSystem?.getPrayerCustody?.(playerId);
    if (
      !diagnosticProvisioningAllowed &&
      (!prayerCustody?.ready || !prayerCustody.persistenceHealthy)
    ) {
      return { result: { ok: false, reason: "prayer_state_not_ready" } };
    }
    if (
      !diagnosticProvisioningAllowed &&
      requireInactivePrayer &&
      (prayerCustody?.activePrayers.length ?? 0) > 0
    ) {
      return {
        result: { ok: false, reason: "active_prayers_not_frozen" },
      };
    }
    const frozenPrayer = {
      pointUnits: prayerCustody?.pointUnits ?? 0,
      points: prayerCustody?.points ?? 0,
      maxPoints: prayerCustody?.maxPoints ?? 1,
      activePrayers: [...(prayerCustody?.activePrayers ?? [])].sort(),
    };

    const frozenEquipment = Object.fromEntries(
      COMPETITIVE_EQUIPMENT_SLOTS.map((slotName) => [
        slotName,
        this.snapshotEquipmentSlot(equipment[slotName]),
      ]),
    ) as Record<CompetitiveEquipmentSlotName, DuelEquipmentSlotSnapshot>;
    if (!diagnosticProvisioningAllowed) {
      for (const slotName of COMPETITIVE_EQUIPMENT_SLOTS) {
        const itemId = frozenEquipment[slotName]?.itemId;
        if (itemId && !this.isEquipmentPresentationEligible(itemId, slotName)) {
          return {
            result: {
              ok: false,
              reason: `equipment_presentation_not_certified:${slotName}:${itemId}`,
            },
          };
        }
      }
    }
    const frozenInventory: Array<{
      slot: number;
      itemId: string;
      quantity: number;
    }> = [];
    const seenSlots = new Set<number>();
    for (const rawItem of inventory.items ?? []) {
      const slot = Number(rawItem.slot);
      const itemId = String(rawItem.itemId ?? "").trim();
      const quantity = Number(rawItem.quantity);
      if (
        !Number.isSafeInteger(slot) ||
        slot < 0 ||
        slot >= 28 ||
        seenSlots.has(slot) ||
        !itemId ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        if (!diagnosticProvisioningAllowed) {
          return {
            result: { ok: false, reason: "invalid_inventory_state" },
          };
        }
        continue;
      }
      seenSlots.add(slot);
      frozenInventory.push({ slot, itemId, quantity });
    }
    frozenInventory.sort((a, b) => a.slot - b.slot);

    const selectedSpell = this.getSelectedSpell(playerId);
    const frozenSkillLevels = this.getAgentSkillLevels(playerId);
    if (Object.keys(frozenSkillLevels).length === 0) {
      return { result: { ok: false, reason: "invalid_skill_state" } };
    }
    const fingerprint = this.fingerprintCompetitiveLoadout({
      equipment: frozenEquipment,
      inventory: frozenInventory,
      selectedSpell,
      skillLevels: frozenSkillLevels,
      prayer: frozenPrayer,
    });
    const inventoryQuantityByItemId = new Map<string, number>();
    for (const item of frozenInventory) {
      inventoryQuantityByItemId.set(
        item.itemId,
        (inventoryQuantityByItemId.get(item.itemId) ?? 0) + item.quantity,
      );
    }

    let readiness:
      | {
          ok: true;
          initialCombatRole: DuelCombatRole;
          availableCombatStyles: DuelCombatRole[];
          combatLoadouts: FrozenStreamingCombatLoadouts;
        }
      | { ok: false; reason: string };
    const diagnosticMultiStyleAllowed =
      diagnosticProvisioningAllowed &&
      this.isDiagnosticMultiStyleAllowed(playerId);
    if (diagnosticProvisioningAllowed) {
      const diagnosticRole =
        this.debugCombatRoleOverrideByCharacterId.get(playerId) ??
        this.pickCombatRoleBySkills(playerId);
      if (diagnosticMultiStyleAllowed) {
        if (diagnosticRole === "prayer") {
          return {
            result: {
              ok: false,
              reason: "diagnostic_multi_style_opening_role_invalid",
            },
          };
        }
        readiness = {
          ok: true,
          initialCombatRole: diagnosticRole,
          availableCombatStyles: ["melee", "ranged", "mage"],
          combatLoadouts: this.buildDiagnosticMultiStyleLoadouts(),
        };
      } else {
        readiness = {
          ok: true,
          initialCombatRole: diagnosticRole,
          availableCombatStyles: [diagnosticRole],
          combatLoadouts: {},
        };
      }
    } else {
      readiness = this.validateCompetitiveCombatReadiness(
        playerId,
        frozenEquipment,
        frozenInventory,
        selectedSpell,
        frozenSkillLevels,
      );
    }
    if (!readiness.ok) {
      return { result: readiness };
    }

    const snapshot: DuelCombatSetupSnapshot = {
      equipment: {
        weapon: frozenEquipment.weapon,
        arrows: frozenEquipment.arrows,
        shield: frozenEquipment.shield,
      },
      selectedSpell,
      inventoryQuantityByItemId,
      provisionedItemIds: new Set<string>(),
      frozenEquipment,
      frozenInventory,
      frozenSkillLevels,
      prayer: frozenPrayer,
      fingerprint,
      availableCombatStyles: readiness.availableCombatStyles,
      combatLoadouts: this.cloneFrozenCombatLoadouts(readiness.combatLoadouts),
      initialCombatRole: readiness.initialCombatRole,
      diagnosticProvisioningAllowed,
      diagnosticMultiStyleAllowed,
    };
    return {
      result: {
        ok: true,
        fingerprint,
        availableCombatStyles: readiness.availableCombatStyles,
        combatLoadouts: this.cloneFrozenCombatLoadouts(
          readiness.combatLoadouts,
        ),
        initialCombatRole: readiness.initialCombatRole,
        diagnostic: diagnosticProvisioningAllowed,
      },
      snapshot,
    };
  }

  private getSelectedSpell(playerId: string): string | null {
    const entitySelectedSpell = (
      this.world.entities.get(playerId)?.data as {
        selectedSpell?: string | null;
      }
    )?.selectedSpell;
    const playerSelectedSpell = (
      this.world as {
        getPlayer?: (id: string) => {
          data?: { selectedSpell?: string | null };
        } | null;
      }
    ).getPlayer?.(playerId)?.data?.selectedSpell;
    const selectedSpell = playerSelectedSpell ?? entitySelectedSpell ?? null;
    return typeof selectedSpell === "string" && selectedSpell.trim()
      ? selectedSpell.trim()
      : null;
  }

  private fingerprintCompetitiveLoadout(input: {
    equipment: Record<CompetitiveEquipmentSlotName, DuelEquipmentSlotSnapshot>;
    inventory: Array<{ slot: number; itemId: string; quantity: number }>;
    selectedSpell: string | null;
    skillLevels: Record<string, number>;
    prayer: {
      pointUnits: number;
      maxPoints: number;
      activePrayers: string[];
    };
  }): string {
    const skills = Object.entries(input.skillLevels).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const equipment = COMPETITIVE_EQUIPMENT_SLOTS.map((slotName) => [
      slotName,
      input.equipment[slotName],
    ]);
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          equipment,
          inventory: input.inventory,
          selectedSpell: input.selectedSpell,
          skills,
          prayer: input.prayer,
        }),
      )
      .digest("hex");
  }

  private validateCompetitiveCombatReadiness(
    playerId: string,
    equipment: Record<CompetitiveEquipmentSlotName, DuelEquipmentSlotSnapshot>,
    inventory: Array<{ slot: number; itemId: string; quantity: number }>,
    selectedSpell: string | null,
    skills: Record<string, number>,
  ):
    | {
        ok: true;
        initialCombatRole: DuelCombatRole;
        availableCombatStyles: DuelCombatRole[];
        combatLoadouts: FrozenStreamingCombatLoadouts;
      }
    | { ok: false; reason: string } {
    const equipmentSystem = this.getEquipmentSystem();
    const weaponId = equipment.weapon?.itemId ?? null;
    const weapon = weaponId ? getItem(weaponId) : null;
    if (
      weaponId &&
      equipmentSystem?.canPlayerEquipItem &&
      !equipmentSystem.canPlayerEquipItem(playerId, weaponId)
    ) {
      return { ok: false, reason: "equipped_weapon_requirements_not_met" };
    }

    let initialCombatRole: SwitchableStreamingCombatRole;
    if (selectedSpell) {
      const spell = COMBAT_SPELLS[selectedSpell];
      if (!spell) {
        return { ok: false, reason: "selected_spell_invalid" };
      }
      if ((skills.magic ?? 1) < spell.level) {
        return { ok: false, reason: "selected_spell_level_not_met" };
      }
      if (!weapon || !this.isMageStaff(weapon.id)) {
        return { ok: false, reason: "selected_spell_weapon_invalid" };
      }
      const runeValidation = runeService.hasRequiredRunes(
        inventory,
        spell.runes,
        weapon,
      );
      if (!runeValidation.valid) {
        return { ok: false, reason: "selected_spell_runes_missing" };
      }
      initialCombatRole = "mage";
    } else if (weapon && this.isRangedBow(weapon.id)) {
      const arrows = equipment.arrows;
      if (!arrows || arrows.quantity <= 0) {
        return { ok: false, reason: "equipped_arrows_missing" };
      }
      const arrowItem = getItem(arrows.itemId);
      const arrowValidation = ammunitionService.validateArrows(
        weapon,
        arrowItem
          ? ({ itemId: arrows.itemId, item: arrowItem } as never)
          : null,
        skills.ranged ?? 1,
      );
      if (!arrowValidation.valid) {
        return {
          ok: false,
          reason: `equipped_arrows_${arrowValidation.errorCode?.toLowerCase() ?? "invalid"}`,
        };
      }
      initialCombatRole = "ranged";
    } else {
      if (!weapon || !this.isMeleeWeapon(weapon.id)) {
        return { ok: false, reason: "equipped_combat_weapon_missing" };
      }
      initialCombatRole = "melee";
    }

    const combatLoadouts = this.buildFrozenCombatLoadouts(
      playerId,
      equipment,
      inventory,
      skills,
      selectedSpell,
      initialCombatRole,
    );
    const availableCombatStyles = (["melee", "ranged", "mage"] as const).filter(
      (style) => Boolean(combatLoadouts[style]),
    );
    if (!availableCombatStyles.includes(initialCombatRole)) {
      return { ok: false, reason: "initial_combat_style_not_usable" };
    }
    return {
      ok: true,
      initialCombatRole,
      availableCombatStyles,
      combatLoadouts,
    };
  }

  private buildFrozenCombatLoadouts(
    playerId: string,
    equipment: Record<CompetitiveEquipmentSlotName, DuelEquipmentSlotSnapshot>,
    inventory: Array<{ slot: number; itemId: string; quantity: number }>,
    skills: Record<string, number>,
    selectedSpell: string | null,
    initialCombatRole: SwitchableStreamingCombatRole,
  ): FrozenStreamingCombatLoadouts {
    const equipmentSystem = this.getEquipmentSystem();
    const ownedQuantity = new Map<string, number>();
    for (const item of inventory) {
      ownedQuantity.set(
        item.itemId,
        (ownedQuantity.get(item.itemId) ?? 0) + item.quantity,
      );
    }
    for (const slot of COMPETITIVE_EQUIPMENT_SLOTS) {
      const item = equipment[slot];
      if (item) {
        ownedQuantity.set(
          item.itemId,
          (ownedQuantity.get(item.itemId) ?? 0) + item.quantity,
        );
      }
    }
    const canEquip = (itemId: string): boolean =>
      !equipmentSystem?.canPlayerEquipItem ||
      equipmentSystem.canPlayerEquipItem(playerId, itemId);
    const ownedItemIds = [...ownedQuantity.keys()].sort();
    const weapons = ownedItemIds
      .map((itemId) => getItem(itemId))
      .filter((item): item is NonNullable<typeof item> =>
        Boolean(
          item?.type === "weapon" &&
          canEquip(item.id) &&
          this.isEquipmentPresentationEligible(item.id, "weapon"),
        ),
      );
    const loadouts: FrozenStreamingCombatLoadouts = {};
    const bonus = (
      item: NonNullable<ReturnType<typeof getItem>>,
      key: string,
    ): number => {
      const value = (item.bonuses as Record<string, number> | undefined)?.[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    const roleOffense = (
      item: NonNullable<ReturnType<typeof getItem>>,
      role: SwitchableStreamingCombatRole,
    ): number => {
      if (role === "ranged") {
        return bonus(item, "attackRanged") + bonus(item, "rangedStrength");
      }
      if (role === "mage") return bonus(item, "attackMagic");
      return (
        Math.max(
          bonus(item, "attackStab"),
          bonus(item, "attackSlash"),
          bonus(item, "attackCrush"),
        ) +
        bonus(item, "strength") +
        bonus(item, "meleeStrength")
      );
    };
    const totalDefense = (
      item: NonNullable<ReturnType<typeof getItem>>,
    ): number =>
      bonus(item, "defenseStab") +
      bonus(item, "defenseSlash") +
      bonus(item, "defenseCrush") +
      bonus(item, "defenseRanged") +
      bonus(item, "defenseMagic");
    const shields = ownedItemIds
      .map((itemId) => getItem(itemId))
      .filter((item): item is NonNullable<typeof item> =>
        Boolean(
          item?.type === "armor" &&
          item.equipSlot === "shield" &&
          canEquip(item.id) &&
          this.isEquipmentPresentationEligible(item.id, "shield"),
        ),
      );
    const selectShield = (
      role: SwitchableStreamingCombatRole,
      weapon: NonNullable<ReturnType<typeof getItem>>,
    ): string | null => {
      if (weapon.is2h || weapon.equipSlot === "2h") return null;
      return (
        shields
          .filter((shield) => {
            const offense = roleOffense(shield, role);
            return offense >= 0 && (offense > 0 || totalDefense(shield) > 0);
          })
          .sort(
            (left, right) =>
              roleOffense(right, role) - roleOffense(left, role) ||
              totalDefense(right) - totalDefense(left) ||
              left.id.localeCompare(right.id),
          )[0]?.id ?? null
      );
    };
    const armorBySlot = new Map(
      FROZEN_STREAMING_ARMOR_SLOTS.map((slot) => [
        slot,
        ownedItemIds
          .map((itemId) => getItem(itemId))
          .filter((item): item is NonNullable<typeof item> =>
            Boolean(
              item?.type === "armor" &&
              item.equipSlot === slot &&
              canEquip(item.id) &&
              this.isEquipmentPresentationEligible(item.id, slot),
            ),
          ),
      ]),
    );
    const selectArmorIds = (
      role: SwitchableStreamingCombatRole,
    ): FrozenStreamingArmorIds =>
      Object.fromEntries(
        FROZEN_STREAMING_ARMOR_SLOTS.map((slot) => {
          const selectedArmor = armorBySlot
            .get(slot)!
            .filter((armor) => {
              const offense = roleOffense(armor, role);
              return offense >= 0 && (offense > 0 || totalDefense(armor) > 0);
            })
            .sort(
              (left, right) =>
                roleOffense(right, role) - roleOffense(left, role) ||
                totalDefense(right) - totalDefense(left) ||
                left.id.localeCompare(right.id),
            )[0];
          return [slot, selectedArmor?.id ?? null];
        }),
      ) as FrozenStreamingArmorIds;

    const meleeWeapons = weapons
      .filter((weapon) => this.isMeleeWeapon(weapon.id))
      .sort(
        (a, b) =>
          this.scoreMeleeWeapon(b.id) - this.scoreMeleeWeapon(a.id) ||
          a.id.localeCompare(b.id),
      );
    if (meleeWeapons[0]) {
      const meleeWeapon = meleeWeapons[0];
      loadouts.melee = {
        role: "melee",
        weaponId: meleeWeapon.id,
        arrowsId: null,
        shieldId: selectShield("melee", meleeWeapon),
        spellId: null,
        armorIds: selectArmorIds("melee"),
      };
    }

    const bows = weapons
      .filter((weapon) => this.isRangedBow(weapon.id))
      .sort(
        (a, b) =>
          this.scoreRangedBow(b.id) - this.scoreRangedBow(a.id) ||
          a.id.localeCompare(b.id),
      );
    const arrows = ownedItemIds
      .filter(
        (itemId) =>
          (ownedQuantity.get(itemId) ?? 0) > 0 &&
          ammunitionService.hasArrows({ itemId } as never),
      )
      .sort(
        (a, b) =>
          this.scoreArrows(b) - this.scoreArrows(a) || a.localeCompare(b),
      );
    for (const bow of bows) {
      const arrowId = arrows.find((candidate) =>
        ammunitionService.areArrowsCompatible(bow.id, candidate),
      );
      if (!arrowId) continue;
      loadouts.ranged = {
        role: "ranged",
        weaponId: bow.id,
        arrowsId: arrowId,
        shieldId: selectShield("ranged", bow),
        spellId: null,
        armorIds: selectArmorIds("ranged"),
      };
      break;
    }

    const staffs = weapons
      .filter((weapon) => this.isMageStaff(weapon.id))
      .sort(
        (a, b) =>
          this.scoreMageStaff(b.id) - this.scoreMageStaff(a.id) ||
          a.id.localeCompare(b.id),
      );
    const spells = SPELL_ORDER.map((spellId) => ({
      spellId,
      spell: COMBAT_SPELLS[spellId],
    }))
      .filter(
        (entry) =>
          Boolean(entry.spell) && (skills.magic ?? 1) >= entry.spell.level,
      )
      .sort(
        (a, b) =>
          b.spell.level - a.spell.level || a.spellId.localeCompare(b.spellId),
      );
    for (const staff of staffs) {
      const spell = spells.find(
        (entry) =>
          runeService.hasRequiredRunes(inventory, entry.spell.runes, staff)
            .valid,
      );
      if (!spell) continue;
      loadouts.mage = {
        role: "mage",
        weaponId: staff.id,
        arrowsId: null,
        shieldId: selectShield("mage", staff),
        spellId: spell.spellId,
        armorIds: selectArmorIds("mage"),
      };
      break;
    }

    const currentWeaponId = equipment.weapon?.itemId ?? null;
    const currentWeapon = currentWeaponId ? getItem(currentWeaponId) : null;
    const currentShieldId =
      currentWeapon && !currentWeapon.is2h && currentWeapon.equipSlot !== "2h"
        ? (equipment.shield?.itemId ?? null)
        : null;
    const currentArmorIds = Object.fromEntries(
      FROZEN_STREAMING_ARMOR_SLOTS.map((slot) => [
        slot,
        equipment[slot]?.itemId ?? null,
      ]),
    ) as FrozenStreamingArmorIds;
    if (currentWeaponId && initialCombatRole === "melee") {
      loadouts.melee = {
        role: "melee",
        weaponId: currentWeaponId,
        arrowsId: null,
        shieldId: currentShieldId,
        spellId: null,
        armorIds: currentArmorIds,
      };
    } else if (
      currentWeaponId &&
      initialCombatRole === "ranged" &&
      equipment.arrows
    ) {
      loadouts.ranged = {
        role: "ranged",
        weaponId: currentWeaponId,
        arrowsId: equipment.arrows.itemId,
        shieldId: currentShieldId,
        spellId: null,
        armorIds: currentArmorIds,
      };
    } else if (
      currentWeaponId &&
      initialCombatRole === "mage" &&
      selectedSpell
    ) {
      loadouts.mage = {
        role: "mage",
        weaponId: currentWeaponId,
        arrowsId: null,
        shieldId: currentShieldId,
        spellId: selectedSpell,
        armorIds: currentArmorIds,
      };
    }
    return loadouts;
  }

  private cloneFrozenCombatLoadouts(
    loadouts: FrozenStreamingCombatLoadouts,
  ): FrozenStreamingCombatLoadouts {
    const clone: FrozenStreamingCombatLoadouts = {};
    for (const role of ["melee", "ranged", "mage"] as const) {
      const loadout = loadouts[role];
      if (loadout) {
        clone[role] = {
          ...loadout,
          ...(loadout.armorIds ? { armorIds: { ...loadout.armorIds } } : {}),
        };
      }
    }
    return clone;
  }

  private buildDiagnosticMultiStyleLoadouts(): FrozenStreamingCombatLoadouts {
    return {
      melee: {
        role: "melee",
        weaponId: MELEE_FALLBACK_WEAPON,
        arrowsId: null,
        shieldId: null,
        spellId: null,
        armorIds: Object.fromEntries(
          FROZEN_STREAMING_ARMOR_SLOTS.map((slot) => [slot, null]),
        ) as FrozenStreamingArmorIds,
      },
      ranged: {
        role: "ranged",
        weaponId: RANGED_FALLBACK_BOW,
        arrowsId: RANGED_FALLBACK_ARROW,
        shieldId: null,
        spellId: null,
        armorIds: Object.fromEntries(
          FROZEN_STREAMING_ARMOR_SLOTS.map((slot) => [slot, null]),
        ) as FrozenStreamingArmorIds,
      },
      mage: {
        role: "mage",
        weaponId: MAGE_FALLBACK_STAFF,
        arrowsId: null,
        shieldId: null,
        spellId: MAGE_FALLBACK_SPELL,
        armorIds: Object.fromEntries(
          FROZEN_STREAMING_ARMOR_SLOTS.map((slot) => [slot, null]),
        ) as FrozenStreamingArmorIds,
      },
    };
  }

  private snapshotEquipmentSlot(
    slot: DuelEquipmentSlotView | undefined,
  ): DuelEquipmentSlotSnapshot {
    const rawItemId = slot?.itemId ?? slot?.item?.id ?? null;
    if (rawItemId === null || rawItemId === undefined) {
      return null;
    }
    const itemId = String(rawItemId).trim();
    if (!itemId) {
      return null;
    }
    const quantity =
      typeof slot?.quantity === "number" &&
      Number.isSafeInteger(slot.quantity) &&
      slot.quantity > 0
        ? slot.quantity
        : 1;
    return { itemId, quantity };
  }

  private markProvisionedInventoryItem(playerId: string, itemId: string): void {
    this.combatSetupSnapshotsByAgent
      .get(playerId)
      ?.provisionedItemIds.add(itemId);
  }

  /** Get the authoritative flat skill map. Returns `{}` on missing/invalid state. */
  private getAgentSkillLevels(characterId: string): Record<string, number> {
    const skillSystem = this.world.getSystem("skills") as {
      getSkills?: (
        playerId: string,
      ) => Record<string, { level: number }> | undefined;
    } | null;
    const systemSkills = skillSystem?.getSkills?.(characterId);
    const entity = this.world.entities.get(characterId);
    const entitySkills = (
      entity?.data as { skills?: Record<string, { level: number }> } | undefined
    )?.skills;
    const skills =
      systemSkills && Object.keys(systemSkills).length > 0
        ? systemSkills
        : entitySkills;
    if (!skills) return {};
    const result: Record<string, number> = {};
    for (const [name, data] of Object.entries(skills)) {
      const level = data?.level;
      if (!Number.isSafeInteger(level) || level < 1) return {};
      result[name] = level;
    }
    return result;
  }

  /** Per-role skill score (higher = better fit). Used for role ordering. */
  private roleSkillScore(
    skills: Record<string, number>,
    role: DuelCombatRole,
  ): number {
    switch (role) {
      case "melee":
        return (skills.attack ?? 1) + (skills.strength ?? 1);
      case "ranged":
        return (skills.ranged ?? 1) * 2;
      case "mage":
        return (skills.magic ?? 1) * 2;
      case "prayer":
        return (skills.prayer ?? 1) * 2 + (skills.strength ?? 1);
    }
  }

  /**
   * Best → worst roles for this skill set. Equal scores use ROLE_SCORE_TIE_ORDER
   * (ranged before mage before melee) so default equal stats yield ranged/mage use.
   */
  private sortedCombatRolesBySkills(
    skills: Record<string, number>,
  ): DuelCombatRole[] {
    const roles: DuelCombatRole[] = ["melee", "ranged", "mage", "prayer"];
    return [...roles].sort((a, b) => {
      const sa = this.roleSkillScore(skills, a);
      const sb = this.roleSkillScore(skills, b);
      if (sb !== sa) return sb - sa;
      return ROLE_SCORE_TIE_ORDER.indexOf(a) - ROLE_SCORE_TIE_ORDER.indexOf(b);
    });
  }

  /**
   * Assign roles so the two agents usually differ in style (spectacle + weapon variety).
   * Agent1 gets their top pick; agent2 gets their strongest choice that differs from agent1.
   */
  private assignCombatRolesForDuelPair(
    characterId1: string,
    characterId2: string,
  ): [DuelCombatRole, DuelCombatRole] {
    const s1 = this.getAgentSkillLevels(characterId1);
    const s2 = this.getAgentSkillLevels(characterId2);
    const order1 = this.sortedCombatRolesBySkills(s1);
    const order2 = this.sortedCombatRolesBySkills(s2);
    let role1 = order1[0];
    const preferred2 =
      order2.find((r) => r !== role1) ?? order2[1] ?? order2[0];
    let role2: DuelCombatRole = preferred2;
    if (role2 === role1) {
      // Fully symmetric builds — rotate by stable hash so cycles vary (melee/ranged/mage).
      const h =
        (characterId1.codePointAt(0) ?? 0) ^
        (characterId2.codePointAt(0) ?? 0) ^
        (characterId1.length ^ characterId2.length);
      const pool: DuelCombatRole[] = ["melee", "ranged", "mage", "prayer"];
      role1 = pool[Math.abs(h) % 4];
      role2 = pool[(Math.abs(h) + 1) % 4];
    }
    return [role1, role2];
  }

  /** Pick combat role based on agent's actual skill levels (single-agent / tests). */
  pickCombatRoleBySkills(characterId: string): DuelCombatRole {
    return this.sortedCombatRolesBySkills(
      this.getAgentSkillLevels(characterId),
    )[0];
  }

  /**
   * Permanently bind a character to a specific combat role.  Unlike the old
   * one-shot override, this persists across all future duels so agents whose
   * name advertises a style ("Keldrath Mage") always fight with the matching
   * weapon and AI config.
   */
  setDebugCombatRoleOverride(characterId: string, role: DuelCombatRole): void {
    this.debugCombatRoleOverrideByCharacterId.set(characterId, role);
  }

  setDiagnosticMultiStyleAllowed(characterId: string, allowed: boolean): void {
    if (allowed) this.diagnosticMultiStyleCharacterIds.add(characterId);
    else this.diagnosticMultiStyleCharacterIds.delete(characterId);
  }

  /** Remove a persistent role override (e.g. when a sparbot is unregistered). */
  clearDebugCombatRoleOverride(characterId: string): void {
    this.debugCombatRoleOverrideByCharacterId.delete(characterId);
    this.diagnosticMultiStyleCharacterIds.delete(characterId);
  }

  private applyDebugCombatRoleOverrides(
    id1: string,
    id2: string,
    base1: DuelCombatRole,
    base2: DuelCombatRole,
  ): [DuelCombatRole, DuelCombatRole] {
    const o1 = this.debugCombatRoleOverrideByCharacterId.get(id1);
    const o2 = this.debugCombatRoleOverrideByCharacterId.get(id2);
    // Do NOT clear — overrides are persistent for sparbot agents whose names
    // advertise a specific style. They are removed when the agent is unregistered.

    let r1 = o1 !== undefined ? o1 : base1;
    let r2 = o2 !== undefined ? o2 : base2;
    if (r1 !== r2) {
      return [r1, r2];
    }
    if (o1 !== undefined && o2 === undefined) {
      const alt = this.sortedCombatRolesBySkills(
        this.getAgentSkillLevels(id2),
      ).find((x) => x !== r1);
      return [r1, alt ?? "mage"];
    }
    if (o1 === undefined && o2 !== undefined) {
      const alt = this.sortedCombatRolesBySkills(
        this.getAgentSkillLevels(id1),
      ).find((x) => x !== r2);
      return [alt ?? "mage", r2];
    }
    if (o1 !== undefined && o2 !== undefined) {
      // Explicit sparbot styles describe their stable visual/combat identity.
      // Two melee sparbots must not silently turn one contestant into a
      // point-blank archer merely to manufacture role variety.
      return [r1, r2];
    }
    return [base1, base2];
  }

  // --------------------------------------------------------------------------
  // Weapon scoring helpers
  // --------------------------------------------------------------------------

  /** Score a melee weapon by its offensive bonuses. */
  private scoreMeleeWeapon(itemId: string): number {
    const item = ITEMS.get(itemId);
    if (!item) return -1;
    const b = item.bonuses;
    return (
      (b?.attack ?? 0) +
      (b?.attackStab ?? 0) +
      (b?.attackSlash ?? 0) +
      (b?.attackCrush ?? 0) +
      (b?.strength ?? 0) +
      (b?.meleeStrength ?? 0)
    );
  }

  /** Score a ranged bow by its offensive bonuses. */
  private scoreRangedBow(itemId: string): number {
    const item = ITEMS.get(itemId);
    if (!item) return -1;
    const b = item.bonuses;
    return (b?.attackRanged ?? 0) + (b?.ranged ?? 0);
  }

  /** Score arrows by ranged strength. */
  private scoreArrows(itemId: string): number {
    const item = ITEMS.get(itemId);
    if (!item) return -1;
    const b = item.bonuses;
    return (b?.rangedStrength ?? 0) + (b?.ranged ?? 0);
  }

  /** Score a magic staff by its offensive bonuses. */
  private scoreMageStaff(itemId: string): number {
    const item = ITEMS.get(itemId);
    if (!item) return -1;
    const b = item.bonuses;
    return (b?.attackMagic ?? 0) + (b?.magicDamage ?? 0);
  }

  /** Get item IDs from the agent's inventory that match a filter. */
  private getInventoryItemIds(
    characterId: string,
    filter: (itemId: string) => boolean,
  ): string[] {
    const inventorySystem = this.getInventorySystem();
    if (!inventorySystem?.getInventory) return [];
    const inv = inventorySystem.getInventory(characterId);
    if (!inv?.items) return [];
    return inv.items
      .map((slot) => slot.itemId)
      .filter((id) => id && filter(id));
  }

  /** Check if an item is a melee weapon. */
  private isMeleeWeapon(itemId: string): boolean {
    const item = ITEMS.get(itemId);
    if (!item || item.type !== "weapon") return false;
    if (item.attackType !== AttackType.MELEE) return false;
    if (item.equipSlot !== "weapon" && item.equipSlot !== "2h") return false;
    return (
      item.equipable !== false &&
      isStreamingDuelMeleeWeaponTypePresentationEligible(item.weaponType)
    );
  }

  /** Check if an item is a ranged bow. */
  private isRangedBow(itemId: string): boolean {
    const item = ITEMS.get(itemId);
    if (!item || item.type !== "weapon") return false;
    if (item.attackType !== AttackType.RANGED) return false;
    const wt = (item.weaponType ?? "").toString().toUpperCase();
    return wt === "BOW" && item.equipable !== false;
  }

  /** Check if an item is a magic staff/wand. */
  private isMageStaff(itemId: string): boolean {
    const item = ITEMS.get(itemId);
    if (!item || item.type !== "weapon") return false;
    if (item.attackType !== AttackType.MAGIC) return false;
    const wt = (item.weaponType ?? "").toString().toUpperCase();
    return (wt === "STAFF" || wt === "WAND") && item.equipable !== false;
  }

  // --------------------------------------------------------------------------
  // Best-gear selection helpers
  // --------------------------------------------------------------------------

  /**
   * Pick the best melee weapon considering: manifest weapons the agent qualifies
   * for, their currently equipped weapon, and weapons in their inventory.
   * Returns `{ weaponId, alreadyEquipped }` so the equip step can be skipped.
   */
  private pickBestMeleeWeapon(characterId: string): {
    weaponId: string;
    alreadyEquipped: boolean;
  } {
    const equipmentSystem = this.getEquipmentSystem();

    // --- Best from manifest (what we'd conjure) ---
    let manifestBestId: string | null = null;
    let manifestBestScore = -1;

    for (const item of ITEMS.values()) {
      if (item.type !== "weapon") continue;
      if (item.attackType !== AttackType.MELEE) continue;
      if (item.equipSlot !== "weapon" && item.equipSlot !== "2h") continue;
      if (item.equipable === false) continue;
      if (
        !isStreamingDuelMeleeWeaponTypePresentationEligible(item.weaponType)
      ) {
        continue;
      }
      // Limit to bronze tier so mage/ranged matchups stay fair
      if ((item.tier ?? "").toLowerCase() !== "bronze") continue;

      if (
        equipmentSystem?.canPlayerEquipItem &&
        !equipmentSystem.canPlayerEquipItem(characterId, item.id)
      ) {
        continue;
      }

      const score = this.scoreMeleeWeapon(item.id);
      if (score > manifestBestScore) {
        manifestBestScore = score;
        manifestBestId = item.id;
      }
    }

    // --- Currently equipped weapon ---
    const equippedId = this.getEquippedWeaponId(characterId);
    const equippedScore =
      equippedId && this.isMeleeWeapon(equippedId)
        ? this.scoreMeleeWeapon(equippedId)
        : -1;

    // --- Best melee weapon in inventory ---
    const invMeleeIds = this.getInventoryItemIds(characterId, (id) =>
      this.isMeleeWeapon(id),
    );
    let invBestId: string | null = null;
    let invBestScore = -1;
    for (const id of invMeleeIds) {
      // Must also pass equip requirements
      if (
        equipmentSystem?.canPlayerEquipItem &&
        !equipmentSystem.canPlayerEquipItem(characterId, id)
      ) {
        continue;
      }
      const score = this.scoreMeleeWeapon(id);
      if (score > invBestScore) {
        invBestScore = score;
        invBestId = id;
      }
    }

    // --- Pick the overall best ---
    // Prefer agent's own gear (equipped > inventory) over conjured manifest weapons
    if (
      equippedScore >= 0 &&
      equippedScore >= manifestBestScore &&
      equippedScore >= invBestScore &&
      equippedId
    ) {
      Logger.info(
        "StreamingDuelScheduler",
        `Agent ${characterId} keeping equipped melee weapon ${equippedId} (score=${equippedScore})`,
      );
      return { weaponId: equippedId, alreadyEquipped: true };
    }

    if (invBestScore > manifestBestScore && invBestId) {
      Logger.info(
        "StreamingDuelScheduler",
        `Agent ${characterId} equipping inventory melee weapon ${invBestId} (score=${invBestScore} > manifest=${manifestBestScore})`,
      );
      return { weaponId: invBestId, alreadyEquipped: false };
    }

    if (manifestBestId) {
      return { weaponId: manifestBestId, alreadyEquipped: false };
    }

    // Fallback
    const pool = this.getBronzeWeaponPool();
    return {
      weaponId: pool[0] ?? MELEE_FALLBACK_WEAPON,
      alreadyEquipped: false,
    };
  }

  /**
   * Pick the best ranged bow + arrows, considering equipped gear and inventory.
   */
  private pickBestRangedWeapon(characterId: string): {
    bowId: string;
    arrowId: string;
    bowAlreadyEquipped: boolean;
  } {
    const equipmentSystem = this.getEquipmentSystem();
    const skills = this.getAgentSkillLevels(characterId);
    const rangedLevel = skills.ranged ?? 1;

    // --- Best bow from manifest ---
    let manifestBowId: string | null = null;
    let manifestBowScore = -1;
    for (const item of ITEMS.values()) {
      if (item.type !== "weapon") continue;
      if (String(item.attackType ?? "").toLowerCase() !== AttackType.RANGED) {
        continue;
      }
      const wt = (item.weaponType ?? "").toString().toUpperCase();
      if (wt !== "BOW") continue;
      if (item.equipable === false) continue;

      if (
        equipmentSystem?.canPlayerEquipItem &&
        !equipmentSystem.canPlayerEquipItem(characterId, item.id)
      ) {
        continue;
      }

      const score = this.scoreRangedBow(item.id);
      if (score > manifestBowScore) {
        manifestBowScore = score;
        manifestBowId = item.id;
      }
    }

    // --- Currently equipped bow ---
    const equippedId = this.getEquippedWeaponId(characterId);
    const equippedBowScore =
      equippedId && this.isRangedBow(equippedId)
        ? this.scoreRangedBow(equippedId)
        : -1;

    // --- Best bow in inventory ---
    const invBowIds = this.getInventoryItemIds(characterId, (id) =>
      this.isRangedBow(id),
    );
    let invBowId: string | null = null;
    let invBowScore = -1;
    for (const id of invBowIds) {
      if (
        equipmentSystem?.canPlayerEquipItem &&
        !equipmentSystem.canPlayerEquipItem(characterId, id)
      ) {
        continue;
      }
      const score = this.scoreRangedBow(id);
      if (score > invBowScore) {
        invBowScore = score;
        invBowId = id;
      }
    }

    // Pick best bow
    let finalBowId: string;
    let bowAlreadyEquipped = false;
    if (
      equippedBowScore >= 0 &&
      equippedBowScore >= manifestBowScore &&
      equippedBowScore >= invBowScore &&
      equippedId
    ) {
      finalBowId = equippedId;
      bowAlreadyEquipped = true;
      Logger.info(
        "StreamingDuelScheduler",
        `Agent ${characterId} keeping equipped bow ${equippedId} (score=${equippedBowScore})`,
      );
    } else if (invBowScore > manifestBowScore && invBowId) {
      finalBowId = invBowId;
      Logger.info(
        "StreamingDuelScheduler",
        `Agent ${characterId} equipping inventory bow ${invBowId} (score=${invBowScore} > manifest=${manifestBowScore})`,
      );
    } else {
      finalBowId = manifestBowId ?? RANGED_FALLBACK_BOW;
    }

    // --- Best arrows from manifest ---
    let bestArrowId: string | null = null;
    let bestArrowScore = -1;
    for (const item of ITEMS.values()) {
      if (item.type !== "ammunition") continue;
      if (item.equipSlot !== "arrows") continue;
      const reqLevel =
        item.requirements?.skills?.ranged ?? item.requirements?.level ?? 1;
      if (rangedLevel < reqLevel) continue;
      if (!ammunitionService.areArrowsCompatible(finalBowId, item.id)) {
        continue;
      }

      const score = this.scoreArrows(item.id);
      if (score > bestArrowScore) {
        bestArrowScore = score;
        bestArrowId = item.id;
      }
    }

    // Check inventory for arrows too
    const invArrowIds = this.getInventoryItemIds(characterId, (id) => {
      const item = ITEMS.get(id);
      return item?.type === "ammunition" && item?.equipSlot === "arrows";
    });
    for (const id of invArrowIds) {
      const item = ITEMS.get(id);
      const reqLevel =
        item?.requirements?.skills?.ranged ?? item?.requirements?.level ?? 1;
      if (rangedLevel < reqLevel) continue;
      if (!ammunitionService.areArrowsCompatible(finalBowId, id)) continue;
      const score = this.scoreArrows(id);
      if (score > bestArrowScore) {
        bestArrowScore = score;
        bestArrowId = id;
      }
    }

    return {
      bowId: finalBowId,
      arrowId: bestArrowId ?? RANGED_FALLBACK_ARROW,
      bowAlreadyEquipped,
    };
  }

  /**
   * Pick the best mage setup, considering equipped staff and inventory.
   */
  private pickBestMageSetup(characterId: string): {
    staffId: string;
    spellId: string;
    runes: Array<{ runeId: string; quantity: number }>;
    staffAlreadyEquipped: boolean;
  } {
    const equipmentSystem = this.getEquipmentSystem();
    const skills = this.getAgentSkillLevels(characterId);
    const magicLevel = skills.magic ?? 1;

    // --- Best spell (highest-level spell the agent qualifies for) ---
    let bestSpellId = MAGE_FALLBACK_SPELL;
    for (const id of SPELL_ORDER) {
      const spell = COMBAT_SPELLS[id];
      if (spell && magicLevel >= spell.level) {
        bestSpellId = id;
      }
    }
    const chosenSpell = COMBAT_SPELLS[bestSpellId];
    const spellElement = chosenSpell?.element ?? "air";

    // --- Best staff from manifest ---
    let manifestStaffId: string | null = null;
    let manifestStaffScore = -1;
    let manifestMatchesElement = false;

    for (const item of ITEMS.values()) {
      if (item.type !== "weapon") continue;
      if (item.attackType !== AttackType.MAGIC) continue;
      const wt = (item.weaponType ?? "").toString().toUpperCase();
      if (wt !== "STAFF" && wt !== "WAND") continue;
      if (item.equipable === false) continue;

      if (
        equipmentSystem?.canPlayerEquipItem &&
        !equipmentSystem.canPlayerEquipItem(characterId, item.id)
      ) {
        continue;
      }

      const score = this.scoreMageStaff(item.id);
      const infiniteRunes = ELEMENTAL_STAVES[item.id] ?? [];
      const matchesElement = infiniteRunes.includes(`${spellElement}_rune`);

      if (
        score > manifestStaffScore ||
        (score === manifestStaffScore &&
          matchesElement &&
          !manifestMatchesElement)
      ) {
        manifestStaffScore = score;
        manifestStaffId = item.id;
        manifestMatchesElement = matchesElement;
      }
    }

    // --- Currently equipped staff ---
    const equippedId = this.getEquippedWeaponId(characterId);
    const equippedStaffScore =
      equippedId && this.isMageStaff(equippedId)
        ? this.scoreMageStaff(equippedId)
        : -1;

    // --- Best staff in inventory ---
    const invStaffIds = this.getInventoryItemIds(characterId, (id) =>
      this.isMageStaff(id),
    );
    let invStaffId: string | null = null;
    let invStaffScore = -1;
    for (const id of invStaffIds) {
      if (
        equipmentSystem?.canPlayerEquipItem &&
        !equipmentSystem.canPlayerEquipItem(characterId, id)
      ) {
        continue;
      }
      const score = this.scoreMageStaff(id);
      if (score > invStaffScore) {
        invStaffScore = score;
        invStaffId = id;
      }
    }

    // Pick best staff
    let staffId: string;
    let staffAlreadyEquipped = false;
    if (
      equippedStaffScore >= 0 &&
      equippedStaffScore >= manifestStaffScore &&
      equippedStaffScore >= invStaffScore &&
      equippedId
    ) {
      staffId = equippedId;
      staffAlreadyEquipped = true;
      Logger.info(
        "StreamingDuelScheduler",
        `Agent ${characterId} keeping equipped staff ${equippedId} (score=${equippedStaffScore})`,
      );
    } else if (invStaffScore > manifestStaffScore && invStaffId) {
      staffId = invStaffId;
      Logger.info(
        "StreamingDuelScheduler",
        `Agent ${characterId} equipping inventory staff ${invStaffId} (score=${invStaffScore} > manifest=${manifestStaffScore})`,
      );
    } else {
      staffId = manifestStaffId ?? MAGE_FALLBACK_STAFF;
    }

    // --- Runes needed (exclude runes provided by the chosen staff) ---
    const infiniteFromStaff = ELEMENTAL_STAVES[staffId] ?? [];
    const runes: Array<{ runeId: string; quantity: number }> = [];
    if (chosenSpell?.runes) {
      for (const req of chosenSpell.runes) {
        if (!infiniteFromStaff.includes(req.runeId)) {
          runes.push({ runeId: req.runeId, quantity: RUNE_PROVISION_QTY });
        }
      }
    }

    return { staffId, spellId: bestSpellId, runes, staffAlreadyEquipped };
  }

  /**
   * Stackable duel prep (arrows, runes) uses InventorySystem.addItemDirect.
   * Fresh embedded sparbots may still be loading inventory from DB — wait so
   * provisions are not dropped on a throwaway placeholder inventory.
   */
  private async waitForInventoryReadyPlayer(playerId: string): Promise<void> {
    const inventorySystem = this.getInventorySystem();
    if (!inventorySystem?.isInventoryReady) {
      return;
    }
    if (inventorySystem.isInventoryReady(playerId)) {
      return;
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (inventorySystem.isInventoryReady(playerId)) {
        return;
      }
    }
  }

  /**
   * Equip agent for their duel role (melee / ranged / mage).
   * Weapons and ammo go through EquipmentSystem.equipItemDirect (no prior
   * inventory needed). Arrows and runes are also written to inventory for
   * combat paths that read stacks from the bag.
   */
  async ensureAgentCombatSetup(
    playerId: string,
    role: DuelCombatRole,
  ): Promise<string> {
    if (
      playerId.startsWith("sparbot-standalone-") &&
      isLocalDiagnosticDuelRuntime(process.env)
    ) {
      return this.ensureStandaloneSingleStyleCombatSetup(playerId, role);
    }
    if (role === "ranged" || role === "mage") {
      await this.waitForInventoryReadyPlayer(playerId);
    }
    switch (role) {
      case "melee":
      case "prayer": {
        const { weaponId, alreadyEquipped } =
          this.pickBestMeleeWeapon(playerId);
        if (!alreadyEquipped) {
          await this.equipMeleeWeapon(playerId, weaponId);
          const equippedWeaponId = this.getEquippedWeaponId(playerId);
          if (equippedWeaponId) {
            this.markProvisionedInventoryItem(playerId, equippedWeaponId);
          }
        }
        return weaponId;
      }
      case "ranged": {
        const { bowId, arrowId, bowAlreadyEquipped } =
          this.pickBestRangedWeapon(playerId);
        await this.equipRangedGear(
          playerId,
          bowId,
          arrowId,
          bowAlreadyEquipped,
        );
        if (!bowAlreadyEquipped) {
          const equippedWeaponId = this.getEquippedWeaponId(playerId);
          if (equippedWeaponId) {
            this.markProvisionedInventoryItem(playerId, equippedWeaponId);
          }
        }
        return bowId;
      }
      case "mage": {
        const { staffId, spellId, runes, staffAlreadyEquipped } =
          this.pickBestMageSetup(playerId);
        await this.equipMageGear(
          playerId,
          staffId,
          spellId,
          runes,
          staffAlreadyEquipped,
        );
        if (!staffAlreadyEquipped) {
          const equippedWeaponId = this.getEquippedWeaponId(playerId);
          if (equippedWeaponId) {
            this.markProvisionedInventoryItem(playerId, equippedWeaponId);
          }
        }
        return staffId;
      }
    }
  }

  private async ensureStandaloneSingleStyleCombatSetup(
    playerId: string,
    role: DuelCombatRole,
  ): Promise<string> {
    const loadout = resolveStandaloneSingleStyleCombatLoadout(role);
    if (role === "ranged") {
      if (!loadout.arrowsId) {
        throw new Error("diagnostic_single_style_arrows_missing");
      }
      await this.waitForInventoryReadyPlayer(playerId);
      await this.equipRangedGear(playerId, loadout.weaponId, loadout.arrowsId);
    } else if (role === "mage") {
      const spell = loadout.spellId ? COMBAT_SPELLS[loadout.spellId] : null;
      if (!loadout.spellId || !spell) {
        throw new Error("diagnostic_single_style_spell_missing");
      }
      await this.waitForInventoryReadyPlayer(playerId);
      const infiniteRunes = new Set(ELEMENTAL_STAVES[loadout.weaponId] ?? []);
      await this.equipMageGear(
        playerId,
        loadout.weaponId,
        loadout.spellId,
        spell.runes
          .filter((rune) => !infiniteRunes.has(rune.runeId))
          .map((rune) => ({
            runeId: rune.runeId,
            quantity: RUNE_PROVISION_QTY,
          })),
      );
    } else {
      await this.equipMeleeWeapon(playerId, loadout.weaponId);
    }

    const equippedWeaponId = this.getEquippedWeaponId(playerId);
    if (equippedWeaponId !== loadout.weaponId) {
      throw new Error(
        `diagnostic_single_style_equip_failed:${role}:${loadout.weaponId}`,
      );
    }
    this.markProvisionedInventoryItem(playerId, equippedWeaponId);
    return equippedWeaponId;
  }

  private async ensureDiagnosticMultiStyleCombatSetup(
    playerId: string,
    openingRole: DuelCombatRole,
    loadouts: FrozenStreamingCombatLoadouts,
  ): Promise<string> {
    if (
      !isLocalDiagnosticDuelRuntime(process.env) ||
      openingRole === "prayer" ||
      !loadouts[openingRole]
    ) {
      throw new Error("diagnostic_multi_style_boundary_invalid");
    }
    await this.waitForInventoryReadyPlayer(playerId);
    const openingLoadout = loadouts[openingRole];
    if (!openingLoadout) {
      throw new Error("diagnostic_multi_style_opening_loadout_missing");
    }

    if (openingRole === "melee") {
      await this.equipMeleeWeapon(playerId, openingLoadout.weaponId);
    } else if (openingRole === "ranged") {
      if (!openingLoadout.arrowsId) {
        throw new Error("diagnostic_multi_style_arrows_missing");
      }
      await this.equipRangedGear(
        playerId,
        openingLoadout.weaponId,
        openingLoadout.arrowsId,
      );
    } else {
      const spellId = openingLoadout.spellId;
      const spell = spellId ? COMBAT_SPELLS[spellId] : null;
      if (!spellId || !spell) {
        throw new Error("diagnostic_multi_style_spell_missing");
      }
      const infiniteRunes = new Set(
        ELEMENTAL_STAVES[openingLoadout.weaponId] ?? [],
      );
      await this.equipMageGear(
        playerId,
        openingLoadout.weaponId,
        spellId,
        spell.runes
          .filter((rune) => !infiniteRunes.has(rune.runeId))
          .map((rune) => ({
            runeId: rune.runeId,
            quantity: RUNE_PROVISION_QTY,
          })),
      );
    }

    const equippedWeaponId = this.getEquippedWeaponId(playerId);
    if (equippedWeaponId !== openingLoadout.weaponId) {
      throw new Error("diagnostic_multi_style_opening_equip_failed");
    }

    // Direct diagnostic equipment is synthetic and does not debit inventory.
    // Track the opening weapon too, otherwise unequipping it during a switch
    // leaves one extra copy in the bag after every completed duel. Cleanup
    // reconciles this item back to the exact pre-duel inventory baseline.
    this.markProvisionedInventoryItem(playerId, openingLoadout.weaponId);

    const inventorySystem = this.getInventorySystem();
    if (!inventorySystem?.addItemDirect) {
      throw new Error("diagnostic_multi_style_inventory_unavailable");
    }
    const addProvisioned = async (itemId: string, quantity: number) => {
      const added = await inventorySystem.addItemDirect?.(playerId, {
        itemId,
        quantity,
      });
      if (!added) {
        throw new Error(`diagnostic_multi_style_provision_failed:${itemId}`);
      }
      this.markProvisionedInventoryItem(playerId, itemId);
    };

    for (const role of ["melee", "ranged", "mage"] as const) {
      const loadout = loadouts[role];
      if (!loadout) {
        throw new Error(`diagnostic_multi_style_loadout_missing:${role}`);
      }
      if (role !== openingRole) {
        await addProvisioned(loadout.weaponId, 1);
      }
      if (role === "ranged" && role !== openingRole) {
        if (!loadout.arrowsId) {
          throw new Error("diagnostic_multi_style_arrows_missing");
        }
        await addProvisioned(loadout.arrowsId, RUNE_PROVISION_QTY);
      }
      if (role === "mage" && role !== openingRole) {
        const spell = loadout.spellId ? COMBAT_SPELLS[loadout.spellId] : null;
        if (!spell) {
          throw new Error("diagnostic_multi_style_spell_missing");
        }
        const infiniteRunes = new Set(ELEMENTAL_STAVES[loadout.weaponId] ?? []);
        for (const rune of spell.runes) {
          if (!infiniteRunes.has(rune.runeId)) {
            await addProvisioned(rune.runeId, RUNE_PROVISION_QTY);
          }
        }
      }
    }

    return openingLoadout.weaponId;
  }

  /** Equip a specific melee weapon, falling back to bronze if it fails. */
  private async equipMeleeWeapon(
    playerId: string,
    weaponId: string,
  ): Promise<void> {
    const equipmentSystem = this.getEquipmentSystem();
    if (
      !equipmentSystem?.getPlayerEquipment ||
      !equipmentSystem.equipItemDirect
    ) {
      return;
    }

    // Try the chosen weapon first
    try {
      const equipResult = await equipmentSystem.equipItemDirect(
        playerId,
        weaponId,
      );
      if (equipResult.success) {
        Logger.info(
          "StreamingDuelScheduler",
          `Auto-equipped melee ${weaponId} for ${playerId}`,
        );
        return;
      }
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to auto-equip ${weaponId} for ${playerId}: ${equipResult.error ?? "unknown error"}`,
      );
    } catch (err) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Error auto-equipping ${weaponId} for ${playerId}: ${errMsg(err)}`,
      );
    }

    // Fallback: try bronze weapons from the pool
    if (weaponId !== MELEE_FALLBACK_WEAPON) {
      const fallbacks = this.getBronzeWeaponPool();
      for (const fallbackId of fallbacks) {
        if (
          equipmentSystem.canPlayerEquipItem &&
          !equipmentSystem.canPlayerEquipItem(playerId, fallbackId)
        ) {
          continue;
        }
        try {
          const result = await equipmentSystem.equipItemDirect(
            playerId,
            fallbackId,
          );
          if (result.success) {
            Logger.info(
              "StreamingDuelScheduler",
              `Fallback-equipped melee ${fallbackId} for ${playerId} (wanted ${weaponId})`,
            );
            return;
          }
        } catch {
          // Try next fallback
        }
      }
    }

    Logger.warn(
      "StreamingDuelScheduler",
      `Cannot auto-equip any melee weapon for ${playerId} (tried ${weaponId} + fallbacks)`,
    );
  }

  /** Equip bow + arrows for ranged agents. */
  private async equipRangedGear(
    playerId: string,
    bowId: string,
    arrowId: string,
    bowAlreadyEquipped = false,
  ): Promise<void> {
    const equipmentSystem = this.getEquipmentSystem();
    if (!equipmentSystem?.equipItemDirect) return;

    // Skip bow equip if agent already has this bow equipped
    let bowEquipped = bowAlreadyEquipped;
    if (!bowAlreadyEquipped) {
      try {
        const bowResult = await equipmentSystem.equipItemDirect(
          playerId,
          bowId,
        );
        if (bowResult.success) {
          bowEquipped = true;
          Logger.info(
            "StreamingDuelScheduler",
            `Equipped ${bowId} for ranged agent ${playerId}`,
          );
        } else {
          Logger.warn(
            "StreamingDuelScheduler",
            `Failed to equip ${bowId} for ${playerId}: ${bowResult.error ?? "unknown"}`,
          );
        }
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Error equipping ${bowId} for ${playerId}: ${errMsg(err)}`,
        );
      }

      // Fallback bow if chosen one failed
      if (!bowEquipped && bowId !== RANGED_FALLBACK_BOW) {
        try {
          const fallbackResult = await equipmentSystem.equipItemDirect(
            playerId,
            RANGED_FALLBACK_BOW,
          );
          if (fallbackResult.success) {
            Logger.info(
              "StreamingDuelScheduler",
              `Fallback-equipped ${RANGED_FALLBACK_BOW} for ranged agent ${playerId} (wanted ${bowId})`,
            );
          }
        } catch {
          // Best effort
        }
      }
    }

    // Equip and persist the complete diagnostic arrow stack. Combat debits
    // ammunition transactionally from the equipment table, so mutating only
    // the live slot after a one-item save would make the first shot consume the
    // entire durable stack and leave every later auto-attack without ammo.
    try {
      const arrowResult = await equipmentSystem.equipItemDirect(
        playerId,
        arrowId,
        RUNE_PROVISION_QTY,
      );
      if (arrowResult.success) {
        // Also add arrows to inventory as a backup — some combat paths
        // read arrow count from inventory rather than equipment slot.
        const inventorySystem = this.getInventorySystem();
        if (inventorySystem?.addItemDirect) {
          try {
            const added = await inventorySystem.addItemDirect(playerId, {
              itemId: arrowId,
              quantity: RUNE_PROVISION_QTY,
            });
            if (added) {
              this.markProvisionedInventoryItem(playerId, arrowId);
            }
          } catch {
            // Best effort — equipment slot quantity is the primary source
          }
        }

        Logger.info(
          "StreamingDuelScheduler",
          `Equipped ${arrowId} (qty=${RUNE_PROVISION_QTY}) for ranged agent ${playerId}`,
        );
      } else {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to equip ${arrowId} for ${playerId}: ${arrowResult.error ?? "unknown"}`,
        );
      }
    } catch (err) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Error equipping ${arrowId} arrows for ${playerId}: ${errMsg(err)}`,
      );
    }
  }

  /** Equip staff, set autocast spell, and add required runes for mage agents. */
  private async equipMageGear(
    playerId: string,
    staffId: string,
    spellId: string,
    runes: Array<{ runeId: string; quantity: number }>,
    staffAlreadyEquipped = false,
  ): Promise<void> {
    const equipmentSystem = this.getEquipmentSystem();
    if (!equipmentSystem?.equipItemDirect) return;

    // Skip staff equip if agent already has this staff equipped
    if (!staffAlreadyEquipped) {
      let staffEquipped = false;
      try {
        const staffResult = await equipmentSystem.equipItemDirect(
          playerId,
          staffId,
        );
        if (staffResult.success) {
          staffEquipped = true;
          Logger.info(
            "StreamingDuelScheduler",
            `Equipped ${staffId} for mage agent ${playerId}`,
          );
        } else {
          Logger.warn(
            "StreamingDuelScheduler",
            `Failed to equip ${staffId} for ${playerId}: ${staffResult.error ?? "unknown"}`,
          );
        }
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Error equipping ${staffId} for ${playerId}: ${errMsg(err)}`,
        );
      }

      // Fallback staff if chosen one failed
      if (!staffEquipped && staffId !== MAGE_FALLBACK_STAFF) {
        try {
          const fallbackResult = await equipmentSystem.equipItemDirect(
            playerId,
            MAGE_FALLBACK_STAFF,
          );
          if (fallbackResult.success) {
            Logger.info(
              "StreamingDuelScheduler",
              `Fallback-equipped ${MAGE_FALLBACK_STAFF} for mage agent ${playerId} (wanted ${staffId})`,
            );
            // Recalculate runes for fallback staff (it provides different infinite runes)
            const fallbackInfinite =
              ELEMENTAL_STAVES[MAGE_FALLBACK_STAFF] ?? [];
            const spell = COMBAT_SPELLS[spellId];
            if (spell?.runes) {
              runes = [];
              for (const req of spell.runes) {
                if (!fallbackInfinite.includes(req.runeId)) {
                  runes.push({
                    runeId: req.runeId,
                    quantity: RUNE_PROVISION_QTY,
                  });
                }
              }
            }
          }
        } catch {
          // Best effort
        }
      }
    }

    // (#19) Validate spell element matches staff element after any fallback.
    // If mismatched, find the best spell matching the staff's infinite runes.
    const actualStaffId = staffAlreadyEquipped
      ? staffId
      : (this.getEquippedWeaponId(playerId) ?? staffId);
    const staffInfinite = ELEMENTAL_STAVES[actualStaffId] ?? [];
    const currentSpell = COMBAT_SPELLS[spellId];
    if (currentSpell) {
      const spellElement = currentSpell.element ?? "air";
      const staffProvidesSpellElement = staffInfinite.includes(
        `${spellElement}_rune`,
      );
      if (!staffProvidesSpellElement && staffInfinite.length > 0) {
        // Staff doesn't match spell element — find best spell that matches
        const staffElements = staffInfinite
          .filter((r: string) => r.endsWith("_rune"))
          .map((r: string) => r.replace("_rune", ""));
        const skills = this.getAgentSkillLevels(playerId);
        const magicLevel = skills.magic ?? 1;
        let bestMatchSpellId = spellId; // keep current as fallback
        for (const sid of SPELL_ORDER) {
          const sp = COMBAT_SPELLS[sid];
          if (
            sp &&
            magicLevel >= sp.level &&
            staffElements.includes(sp.element ?? "")
          ) {
            bestMatchSpellId = sid;
          }
        }
        if (bestMatchSpellId !== spellId) {
          spellId = bestMatchSpellId;
          // Recalculate runes for the new spell
          const newSpell = COMBAT_SPELLS[spellId];
          if (newSpell?.runes) {
            runes = [];
            for (const req of newSpell.runes) {
              if (!staffInfinite.includes(req.runeId)) {
                runes.push({
                  runeId: req.runeId,
                  quantity: RUNE_PROVISION_QTY,
                });
              }
            }
          }
          Logger.info(
            "StreamingDuelScheduler",
            `Spell validation: switched ${playerId} to ${spellId} (matches staff ${actualStaffId})`,
          );
        }
      }
    }

    // Set autocast spell.
    // Belt-and-suspenders: set selectedSpell directly on entity data AND via
    // world.getPlayer() (which the CombatSystem reads), then emit the event.
    // The event handler in PlayerSystem early-returns if the agent isn't in its
    // internal players map, so direct assignment ensures the combat system sees
    // the spell regardless.
    const entity = this.world.entities.get(playerId);
    if (entity?.data) {
      (entity.data as { selectedSpell?: string | null }).selectedSpell =
        spellId;
    }
    const playerEntity = (
      this.world as {
        getPlayer?: (id: string) => { data?: Record<string, unknown> } | null;
      }
    ).getPlayer?.(playerId);
    if (playerEntity?.data) {
      playerEntity.data.selectedSpell = spellId;
    }
    this.world.emit(EventType.PLAYER_SET_AUTOCAST, {
      playerId,
      spellId,
    });

    // Add required runes to inventory
    if (runes.length === 0) {
      Logger.info(
        "StreamingDuelScheduler",
        `No runes needed for mage agent ${playerId} (staff covers all spell runes)`,
      );
      return;
    }

    const inventorySystem = this.getInventorySystem();
    if (inventorySystem?.addItemDirect) {
      await this.waitForInventoryReadyPlayer(playerId);

      const results: string[] = [];
      try {
        for (const rune of runes) {
          const added = await inventorySystem.addItemDirect(playerId, {
            itemId: rune.runeId,
            quantity: rune.quantity,
          });
          if (added) {
            this.markProvisionedInventoryItem(playerId, rune.runeId);
          }
          results.push(`${rune.runeId}=${added}`);
        }
        const allOk = results.every((r) => r.endsWith("=true"));
        if (!allOk) {
          Logger.warn(
            "StreamingDuelScheduler",
            `Partial rune add for mage agent ${playerId}: ${results.join(", ")}`,
          );
        } else {
          Logger.info(
            "StreamingDuelScheduler",
            `Added runes for mage agent ${playerId}: ${runes.map((r) => `${r.quantity} ${r.runeId}`).join(", ")}`,
          );
        }
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Error adding runes for ${playerId}: ${errMsg(err)}`,
        );
      }
    }
  }

  /**
   * Restore the exact pre-duel loadout and inventory quantities. Scheduler
   * gear is virtual and equipItemDirect displaces existing slots without
   * moving them into inventory, so blanket unequip/removal would destroy a
   * contestant's legitimate weapon, ammunition, runes, or autocast choice.
   */
  async cleanupAgentCombatSetup(playerId: string): Promise<void> {
    const setupInFlight = this.combatSetupInFlightByAgent.get(playerId);
    if (setupInFlight) {
      try {
        await setupInFlight;
      } catch {
        // Restore whatever portion of setup completed before the failure.
      }
    }

    const snapshot = this.combatSetupSnapshotsByAgent.get(playerId);
    if (!snapshot) {
      this.combatRolesByAgent.delete(playerId);
      return;
    }

    // Competitive contestants use their own conserved gear and supplies.
    // Combat consumption and any later legal in-fight equipment transition
    // must persist; restoring the market-open quantities would mint resources.
    if (!snapshot.diagnosticProvisioningAllowed) {
      this.combatSetupSnapshotsByAgent.delete(playerId);
      this.combatRolesByAgent.delete(playerId);
      return;
    }

    try {
      await this.restoreEquipmentSnapshot(playerId, snapshot);
      await this.restoreSelectedSpell(playerId, snapshot.selectedSpell);
      await this.reconcileProvisionedInventory(playerId, snapshot);
    } finally {
      this.combatSetupSnapshotsByAgent.delete(playerId);
      this.combatRolesByAgent.delete(playerId);
    }
  }

  private async restoreEquipmentSnapshot(
    playerId: string,
    snapshot: DuelCombatSetupSnapshot,
  ): Promise<void> {
    const equipmentSystem = this.getEquipmentSystem();
    if (
      !equipmentSystem?.getPlayerEquipment ||
      !equipmentSystem.unequipItemDirect ||
      !equipmentSystem.equipItemDirect
    ) {
      return;
    }

    const slotNames: readonly DuelEquipmentSlotName[] = [
      "weapon",
      "arrows",
      "shield",
    ];
    const currentEquipment = equipmentSystem.getPlayerEquipment(playerId);
    const alreadyRestored = slotNames.every((slotName) => {
      const current = this.snapshotEquipmentSlot(currentEquipment?.[slotName]);
      const original = snapshot.equipment[slotName];
      return (
        current?.itemId === original?.itemId &&
        (current?.quantity ?? null) === (original?.quantity ?? null)
      );
    });
    if (alreadyRestored) {
      return;
    }

    // Clear temporary state first. This also handles a temporary two-handed
    // weapon that displaced the contestant's original shield.
    for (const slotName of ["arrows", "shield", "weapon"] as const) {
      const current = this.snapshotEquipmentSlot(
        equipmentSystem.getPlayerEquipment(playerId)?.[slotName],
      );
      if (!current) continue;
      try {
        const result = await equipmentSystem.unequipItemDirect(
          playerId,
          slotName,
        );
        if (!result.success) {
          Logger.warn(
            "StreamingDuelScheduler",
            `Failed to clear temporary ${slotName} for ${playerId}: ${result.error ?? "unknown"}`,
          );
        }
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to clear temporary ${slotName} for ${playerId}: ${errMsg(err)}`,
        );
      }
    }

    // Restore weapon before shield so a temporary two-handed weapon cannot
    // cause the original shield restoration to reject. Ammunition is last.
    for (const slotName of ["weapon", "shield", "arrows"] as const) {
      const original = snapshot.equipment[slotName];
      if (!original) continue;
      try {
        const result = await equipmentSystem.equipItemDirect(
          playerId,
          original.itemId,
          original.quantity,
        );
        if (!result.success) {
          Logger.warn(
            "StreamingDuelScheduler",
            `Failed to restore ${slotName} ${original.itemId} for ${playerId}: ${result.error ?? "unknown"}`,
          );
          continue;
        }
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to restore ${slotName} ${original.itemId} for ${playerId}: ${errMsg(err)}`,
        );
      }
    }
  }

  private async restoreSelectedSpell(
    playerId: string,
    selectedSpell: string | null,
  ): Promise<void> {
    const entity = this.world.entities.get(playerId);
    if (entity?.data) {
      (entity.data as { selectedSpell?: string | null }).selectedSpell =
        selectedSpell;
    }
    const playerEntity = (
      this.world as {
        getPlayer?: (id: string) => { data?: Record<string, unknown> } | null;
      }
    ).getPlayer?.(playerId);
    if (playerEntity?.data) {
      playerEntity.data.selectedSpell = selectedSpell;
    }
    const databaseSystem = this.world.getSystem("database") as {
      savePlayerAsync?: (
        playerId: string,
        data: { selectedSpell: string | null },
      ) => Promise<void>;
    } | null;
    if (this.world.isServer && databaseSystem?.savePlayerAsync) {
      await databaseSystem.savePlayerAsync(playerId, { selectedSpell });
    }
    try {
      this.world.emit(EventType.PLAYER_SET_AUTOCAST, {
        playerId,
        spellId: selectedSpell,
      });
    } catch (err) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to restore autocast for ${playerId}: ${errMsg(err)}`,
      );
    }
  }

  private async reconcileProvisionedInventory(
    playerId: string,
    snapshot: DuelCombatSetupSnapshot,
  ): Promise<void> {
    if (snapshot.provisionedItemIds.size === 0) {
      return;
    }

    const inventorySystem = this.getInventorySystem();
    if (
      !inventorySystem?.getInventory ||
      !inventorySystem.removeItem ||
      !inventorySystem.addItemDirect
    ) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Cannot reconcile scheduler-provisioned inventory for ${playerId}`,
      );
      return;
    }

    for (const itemId of snapshot.provisionedItemIds) {
      const baseline = snapshot.inventoryQuantityByItemId.get(itemId) ?? 0;
      let inventory = inventorySystem.getInventory(playerId);
      if (!inventory) continue;
      let current = inventory.items
        .filter((item) => item.itemId === itemId)
        .reduce((sum, item) => sum + item.quantity, 0);

      if (current > baseline) {
        let excess = current - baseline;
        for (const item of [...inventory.items]) {
          if (item.itemId !== itemId || excess <= 0) continue;
          const quantity = Math.min(excess, item.quantity);
          try {
            const removed = await inventorySystem.removeItem({
              playerId,
              itemId,
              quantity,
              slot: item.slot,
            });
            if (removed) {
              excess -= quantity;
            }
          } catch (err) {
            Logger.warn(
              "StreamingDuelScheduler",
              `Failed to remove provisioned ${itemId} from ${playerId}: ${errMsg(err)}`,
            );
          }
        }
      } else if (current < baseline) {
        const missing = baseline - current;
        try {
          const restored = await inventorySystem.addItemDirect(playerId, {
            itemId,
            quantity: missing,
          });
          if (!restored) {
            Logger.warn(
              "StreamingDuelScheduler",
              `Failed to restore ${missing} pre-duel ${itemId} for ${playerId}`,
            );
          }
        } catch (err) {
          Logger.warn(
            "StreamingDuelScheduler",
            `Failed to restore pre-duel ${itemId} for ${playerId}: ${errMsg(err)}`,
          );
        }
      }

      inventory = inventorySystem.getInventory(playerId);
      current =
        inventory?.items
          .filter((item) => item.itemId === itemId)
          .reduce((sum, item) => sum + item.quantity, 0) ?? 0;
      if (current !== baseline) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Inventory cleanup mismatch for ${playerId} ${itemId}: expected=${baseline} actual=${current}`,
        );
      }
    }
  }

  async fillInventoryWithFood(
    playerId: string,
    foodItemId: string,
  ): Promise<DuelFoodProvisionedSlot[]> {
    const inventorySystem = this.getInventorySystem();

    if (!inventorySystem?.getInventory || !inventorySystem?.addItemDirect) {
      Logger.warn("StreamingDuelScheduler", "Inventory system not available");
      return [];
    }

    try {
      // Wait for inventory to be ready
      if (
        inventorySystem.isInventoryReady &&
        !inventorySystem.isInventoryReady(playerId)
      ) {
        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (inventorySystem.isInventoryReady(playerId)) break;
        }
      }

      const inventory = inventorySystem.getInventory(playerId);
      if (!inventory) {
        Logger.warn(
          "StreamingDuelScheduler",
          `No inventory found for ${playerId}`,
        );
        return [];
      }

      // Get occupied slots
      const occupiedSlots = new Set(inventory.items.map((item) => item.slot));

      // Fill empty slots with food (assume 28 slots max)
      const maxSlots = 28;
      let foodAdded = 0;
      const addedSlots: DuelFoodProvisionedSlot[] = [];

      for (let slot = 0; slot < maxSlots; slot++) {
        if (!occupiedSlots.has(slot)) {
          try {
            await inventorySystem.addItemDirect(playerId, {
              itemId: foodItemId,
              quantity: 1,
              slot,
            });
            foodAdded++;
            addedSlots.push({ slot, itemId: foodItemId });
          } catch (slotErr) {
            // Slot might be invalid, continue
          }
        }
      }

      Logger.info(
        "StreamingDuelScheduler",
        `Filled ${foodAdded} slots with ${foodItemId} for ${playerId}`,
      );
      return addedSlots;
    } catch (err) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to fill inventory: ${errMsg(err)}`,
      );
      return [];
    }
  }

  // ============================================================================
  // Health Restoration
  // ============================================================================

  /**
   * Top up prayer points before a duel so DuelCombatAI offensive/defensive prayers
   * are not rejected with "No prayer points remaining".
   */
  private async restorePrayerPointsForDuel(playerId: string): Promise<void> {
    const prayer = this.getPrayerSystem();
    const custody = prayer?.getPrayerCustody?.(playerId);
    if (!prayer?.restorePrayerPoints || !custody?.ready) return;

    const maxUnits = custody.maxPoints * 1_000_000;
    const needUnits = Math.max(0, maxUnits - custody.pointUnits);
    if (needUnits <= 0) return;
    const receipt = await prayer.restorePrayerPoints(
      playerId,
      needUnits / 1_000_000,
      `diagnostic-duel-prayer:${crypto.randomUUID()}`,
    );
    if (!receipt.success) {
      throw new Error(
        `diagnostic_prayer_restore_failed:${receipt.reason ?? "unknown"}`,
      );
    }
  }

  restoreHealth(playerId: string, quiet = false): void {
    const entity = this.world.entities.get(playerId);
    if (!entity) return;

    const data = entity.data as {
      health?: number;
      maxHealth?: number;
      alive?: boolean;
      position?:
        [number, number, number] | { x?: number; y?: number; z?: number };
      skills?: Record<string, { level: number }>;
      deathState?: DeathState;
    };

    // The SkillsSystem is authoritative after character hydration. Entity
    // payloads can retain the default level-10 health fields even though the
    // persisted combat skills are already loaded, so using entity.skills here
    // can make the advertised snapshot and the actual fight disagree.
    const constitution = this.getAgentSkillLevels(playerId).constitution || 10;
    const maxHealth = constitution;

    // PlayerEntity and PlayerSystem each own authoritative state used by
    // different combat paths. Synchronize the internal PlayerSystem pool even
    // when the contestant survived the previous duel; its normal respawn
    // handler correctly refuses to heal a living player.
    const playerSystem = this.world.getSystem("player") as {
      restorePlayerHealth?: (id: string, health: number) => boolean;
    } | null;
    playerSystem?.restorePlayerHealth?.(playerId, maxHealth);

    // Restore to full and clear stale death state so startCombat() can engage.
    if (entity instanceof PlayerEntity) {
      entity.resetDeathState();
      entity.setHealthAndMaxHealth(maxHealth, maxHealth);
      entity.markNetworkDirty();
    } else {
      data.health = maxHealth;
      data.maxHealth = maxHealth;
      data.deathState = DeathState.ALIVE;

      const healthComponent = (
        entity as {
          getComponent?: (name: string) => {
            data?: { current?: number; max?: number; isDead?: boolean };
          } | null;
        }
      ).getComponent?.("health");

      if (healthComponent?.data) {
        healthComponent.data.current = maxHealth;
        healthComponent.data.max = maxHealth;
        healthComponent.data.isDead = false;
      }
    }

    // Keep raw entity data in sync for network serialization.
    data.health = maxHealth;
    data.maxHealth = maxHealth;
    data.alive = true;
    data.deathState = DeathState.ALIVE;

    // In quiet mode (used during fight-start HP top-up), skip respawn/death
    // events that cause visible teleport snaps on clients. The entity health
    // values and ENTITY_MODIFIED emission below are sufficient for HP sync.
    if (!quiet) {
      const respawnPosition =
        this.normalizePosition(data.position) ??
        this.normalizePosition((entity as { position?: unknown }).position) ??
        this.getFallbackLobbyPosition(playerId);

      // Synchronize PlayerSystem alive/death flags after duel-owned deaths.
      this.world.emit(EventType.PLAYER_RESPAWNED, {
        playerId,
        spawnPosition: {
          x: respawnPosition[0],
          y: respawnPosition[1],
          z: respawnPosition[2],
        },
        townName: "Streaming Duel Arena",
      });

      // Ensure client and server systems clear any lingering dead flags.
      this.world.emit(EventType.PLAYER_SET_DEAD, {
        playerId,
        isDead: false,
      });
    }

    // Update contestant data
    const cycle = this.getCurrentCycle();
    if (cycle?.agent1?.characterId === playerId) {
      cycle.agent1.currentHp = maxHealth;
      cycle.agent1.maxHp = maxHealth;
    } else if (cycle?.agent2?.characterId === playerId) {
      cycle.agent2.currentHp = maxHealth;
      cycle.agent2.maxHp = maxHealth;
    }

    // Emit health update
    this.world.emit(EventType.ENTITY_MODIFIED, {
      id: playerId,
      changes: { health: maxHealth, maxHealth },
    });
  }

  // ============================================================================
  // Arena Teleportation
  // ============================================================================

  teleportToArena(
    agent1Id: string,
    agent2Id: string,
    suppressEffect = false,
  ): void {
    // Enter directly on the grounded, cardinally adjacent combat marks. The
    // previous presentation marks were 16 tiles apart and forced a second
    // teleport at the bell, producing a visible snap on every duel.
    this.teleportToCombatPositions(agent1Id, agent2Id, suppressEffect);

    Logger.info(
      "StreamingDuelScheduler",
      "Contestants teleported to combat-ready arena marks, facing each other",
    );
  }

  private getEntityOccupancy(): World["entityOccupancy"] | null {
    return (
      (
        this.world as World & {
          entityOccupancy?: World["entityOccupancy"];
        }
      ).entityOccupancy ?? null
    );
  }

  /**
   * Make the two authoritative combat marks available before either contestant
   * is teleported. A live bystander is safely ejected, a stale registry entry
   * is removed, and a live mob fails staging closed because arena manifests
   * must never place ecology on a combat mark.
   */
  private prepareStreamingCombatMarks(
    contestantIds: readonly [string, string],
    positions: readonly [[number, number, number], [number, number, number]],
  ): void {
    const occupancy = this.getEntityOccupancy();
    if (!occupancy) return;

    const marks = positions.map(([x, , z]) => worldToTile(x, z));
    if (marks[0].x === marks[1].x && marks[0].z === marks[1].z) {
      throw new Error("streaming_arena_combat_marks_share_tile");
    }

    const contestants = new Set(contestantIds);
    for (const mark of marks) {
      const occupant = occupancy.getOccupant(mark);
      if (!occupant || contestants.has(String(occupant.entityId))) continue;
      if (
        occupant.entityType === "mob" &&
        this.world.entities.get(String(occupant.entityId))
      ) {
        throw new Error("streaming_arena_mark_occupied_by_live_mob");
      }
    }

    // Contestants can already occupy either mark during idempotent restaging.
    // Vacating both first avoids sequential teleport order displacing one.
    for (const contestantId of contestantIds) {
      occupancy.vacate(createEntityID(contestantId));
    }

    for (const mark of marks) {
      const occupant = occupancy.getOccupant(mark);
      if (!occupant) continue;

      const occupantId = String(occupant.entityId);
      const entity = this.world.entities.get(occupantId);
      if (occupant.entityType === "mob" && entity) {
        throw new Error("streaming_arena_mark_occupied_by_live_mob");
      }

      occupancy.vacate(occupant.entityId);
      if (entity) {
        const egress = this.sanitizeRestorePosition(null, occupantId);
        this.teleportPlayer(occupantId, egress, undefined, true);
        Logger.warn(
          "StreamingDuelScheduler",
          "Ejected a non-contestant from an authoritative combat mark",
          { occupantId, mark },
        );
      }

      if (occupancy.getOccupant(mark)) {
        throw new Error("streaming_arena_mark_could_not_be_cleared");
      }
    }
  }

  /** Confirm synchronous network teleport handling claimed both exact marks. */
  private assertStreamingCombatMarkOwnership(
    contestantIds: readonly [string, string],
    positions: readonly [[number, number, number], [number, number, number]],
  ): void {
    const occupancy = this.getEntityOccupancy();
    if (!occupancy) return;

    for (let index = 0; index < contestantIds.length; index++) {
      const [x, , z] = positions[index];
      const mark = worldToTile(x, z);
      const occupant = occupancy.getOccupant(mark);
      if (
        occupant?.entityType !== "player" ||
        String(occupant.entityId) !== contestantIds[index]
      ) {
        throw new Error(
          `streaming_arena_mark_claim_failed:${contestantIds[index]}:${mark.x},${mark.z}`,
        );
      }
    }
  }

  /**
   * Place contestants on valid combat tiles. CombatSystem range-one melee is
   * cardinal-only, so the two positions must differ by exactly one tile on
   * one axis and zero tiles on the other.
   */
  teleportToCombatPositions(
    agent1Id: string,
    agent2Id: string,
    suppressEffect = true,
  ): void {
    const arenaConfig = getDuelArenaConfig();
    const arenaId = Math.max(
      1,
      Math.min(STREAMING_DUEL_ARENA_ID, arenaConfig.arenaCount),
    );
    const row = Math.floor((arenaId - 1) / arenaConfig.columns);
    const col = (arenaId - 1) % arenaConfig.columns;
    const centerX =
      arenaConfig.baseX +
      col * (arenaConfig.arenaWidth + arenaConfig.arenaGap) +
      arenaConfig.arenaWidth / 2;
    const centerZ =
      arenaConfig.baseZ +
      row * (arenaConfig.arenaLength + arenaConfig.arenaGap) +
      arenaConfig.arenaLength / 2;

    // Keep the stationary axis at a tile center. Use the nearest tile boundary
    // on the separation axis so fractional/odd-sized arena centers still place
    // both presentation marks inside two cardinally adjacent tiles.
    const centerTileX = Math.floor(centerX) + 0.5;
    const centerTileZ = Math.floor(centerZ) + 0.5;
    const centerBoundaryX = Math.round(centerX);
    const centerBoundaryZ = Math.round(centerZ);
    let agent1X = centerTileX;
    let agent1Z = centerBoundaryZ - STREAMING_COMBAT_START_OFFSET;
    let agent2X = centerTileX;
    let agent2Z = centerBoundaryZ + STREAMING_COMBAT_START_OFFSET;
    if (arenaConfig.spawnLayout === "alongWidth") {
      agent1X = centerBoundaryX - STREAMING_COMBAT_START_OFFSET;
      agent1Z = centerTileZ;
      agent2X = centerBoundaryX + STREAMING_COMBAT_START_OFFSET;
      agent2Z = centerTileZ;
    }

    const agent1Pos: [number, number, number] = [
      agent1X,
      this.getGroundedY(agent1X, agent1Z, arenaConfig.baseY),
      agent1Z,
    ];
    const agent2Pos: [number, number, number] = [
      agent2X,
      this.getGroundedY(agent2X, agent2Z, arenaConfig.baseY),
      agent2Z,
    ];

    this.prepareStreamingCombatMarks(
      [agent1Id, agent2Id],
      [agent1Pos, agent2Pos],
    );
    this.teleportPlayer(agent1Id, agent1Pos, agent2Pos, suppressEffect);
    this.teleportPlayer(agent2Id, agent2Pos, agent1Pos, suppressEffect);
    this.assertStreamingCombatMarkOwnership(
      [agent1Id, agent2Id],
      [agent1Pos, agent2Pos],
    );

    const cycle = this.getCurrentCycle();
    if (cycle) {
      cycle.arenaId = arenaId;
      cycle.arenaPositions = { agent1: agent1Pos, agent2: agent2Pos };
    }
  }

  /** Arena AABB for clamping agent combat AI strafe / chase targets */
  /**
   * Enforce a minimum physical separation between the two fighting agents.
   * Authoritative tile occupancy prevents shared tiles. This legacy fallback
   * still protects old/non-tile movement paths from visual capsule overlap.
   * When agents get within MIN_SEP units, push them
   * apart symmetrically by teleport. Called every combat loop tick (600ms).
   */
  private enforceAgentSeparation(id1: string, id2: string): void {
    // DuelCombatAI owns spacing for either AI-controlled contestant. A teleport
    // clears TileMovementManager state, so applying this fallback while a kite
    // path is still leaving overlap traps the pair in a teleport/cancel loop.
    // Retain the hard safety net only for legacy fights with no movement AI.
    if (this.combatAIs.has(id1) || this.combatAIs.has(id2)) return;

    const MIN_SEP = 0.6;
    const e1 = this.world.entities.get(id1);
    const e2 = this.world.entities.get(id2);
    if (!e1?.position || !e2?.position) return;
    const p1 = e1.position as { x: number; y: number; z: number };
    const p2 = e2.position as { x: number; y: number; z: number };
    const dx = p1.x - p2.x;
    const dz = p1.z - p2.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= MIN_SEP) return;
    const push = (MIN_SEP - dist) / 2 + 0.3;
    if (dist > 0.05) {
      const nx = dx / dist;
      const nz = dz / dist;
      this.world.emit("player:teleport", {
        playerId: id1,
        position: { x: p1.x + nx * push, y: p1.y, z: p1.z + nz * push },
        suppressEffect: true,
      });
      this.world.emit("player:teleport", {
        playerId: id2,
        position: { x: p2.x - nx * push, y: p2.y, z: p2.z - nz * push },
        suppressEffect: true,
      });
    } else {
      // Co-located: push along X axis
      this.world.emit("player:teleport", {
        playerId: id1,
        position: { x: p1.x + push, y: p1.y, z: p1.z },
        suppressEffect: true,
      });
      this.world.emit("player:teleport", {
        playerId: id2,
        position: { x: p2.x - push, y: p2.y, z: p2.z },
        suppressEffect: true,
      });
    }
  }

  /**
   * Teleport any contestant that has drifted outside the arena back inside.
   * Called every combat loop tick (600ms) as a hard safety net for physics overshoot.
   */
  private enforceStreamingArenaBounds(
    characterIds: string[],
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ): void {
    const INSET = 1.5;
    for (const id of characterIds) {
      const entity = this.world.entities.get(id);
      if (!entity?.position) continue;
      const { x, y, z } = entity.position as {
        x: number;
        y: number;
        z: number;
      };
      const cx = Math.min(
        bounds.maxX - INSET,
        Math.max(bounds.minX + INSET, x),
      );
      const cz = Math.min(
        bounds.maxZ - INSET,
        Math.max(bounds.minZ + INSET, z),
      );
      if (Math.abs(cx - x) > 0.1 || Math.abs(cz - z) > 0.1) {
        this.world.emit("player:teleport", {
          playerId: id,
          position: { x: cx, y, z: cz },
          suppressEffect: true,
        });
      }
    }
  }

  getStreamingArenaMovementBounds(): {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  } {
    const arenaConfig = getDuelArenaConfig();
    const arenaId = Math.max(
      1,
      Math.min(STREAMING_DUEL_ARENA_ID, arenaConfig.arenaCount),
    );
    const row = Math.floor((arenaId - 1) / arenaConfig.columns);
    const col = (arenaId - 1) % arenaConfig.columns;
    const centerX =
      arenaConfig.baseX +
      col * (arenaConfig.arenaWidth + arenaConfig.arenaGap) +
      arenaConfig.arenaWidth / 2;
    const centerZ =
      arenaConfig.baseZ +
      row * (arenaConfig.arenaLength + arenaConfig.arenaGap) +
      arenaConfig.arenaLength / 2;
    const combatWidth = Math.min(
      arenaConfig.arenaWidth,
      STREAMING_DUEL_COMBAT_WIDTH,
    );
    const combatLength = Math.min(
      arenaConfig.arenaLength,
      STREAMING_DUEL_COMBAT_LENGTH,
    );
    return {
      minX: centerX - combatWidth / 2,
      maxX: centerX + combatWidth / 2,
      minZ: centerZ - combatLength / 2,
      maxZ: centerZ + combatLength / 2,
    };
  }

  /**
   * Get grounded Y using terrain height when available.
   */
  getGroundedY(x: number, z: number, fallbackY: number): number {
    const terrain = this.world.getSystem("terrain") as {
      getHeightAt?: (x: number, z: number) => number;
    } | null;

    const sampledY = terrain?.getHeightAt?.(x, z);
    return typeof sampledY === "number" && Number.isFinite(sampledY)
      ? sampledY
      : fallbackY;
  }

  normalizePosition(position: unknown): [number, number, number] | null {
    if (Array.isArray(position) && position.length >= 3) {
      const x = Number(position[0]);
      const y = Number(position[1]);
      const z = Number(position[2]);
      if (Number.isFinite(x) && Number.isFinite(z)) {
        return [x, Number.isFinite(y) ? y : 0, z];
      }
      return null;
    }

    if (position && typeof position === "object") {
      const pos = position as { x?: number; y?: number; z?: number };
      if (Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
        return [pos.x as number, Number(pos.y ?? 0), pos.z as number];
      }
    }

    return null;
  }

  /**
   * Deterministic fallback near duel lobby to avoid overlapping resets.
   */
  getFallbackLobbyPosition(agentId: string): [number, number, number] {
    const lobby = getDuelArenaConfig().lobbySpawnPoint;

    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
      hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
    }

    const angle = ((hash % 360) * Math.PI) / 180;
    const radius = 6 + (hash % 4);
    const x = lobby.x + Math.cos(angle) * radius;
    const z = lobby.z + Math.sin(angle) * radius;
    const y = this.getGroundedY(x, z, lobby.y);

    return [x, y, z];
  }

  /**
   * Keep restore positions safe for spectator camera and terrain grounding.
   */
  sanitizeRestorePosition(
    position: [number, number, number] | null,
    agentId: string,
  ): [number, number, number] {
    const fallback = this.getFallbackLobbyPosition(agentId);
    if (!position) {
      return fallback;
    }

    const [x, y, z] = position;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return fallback;
    }

    // Never restore non-dueling agents back into combat arena tiles.
    if (isPositionInsideCombatArena(x, z)) {
      return fallback;
    }

    // Only reject positions that are clearly out-of-world (very far from origin).
    // Agents should be free to roam the world between duels.
    const distFromOrigin = Math.hypot(x, z);
    if (distFromOrigin > 2000) {
      return fallback;
    }

    const terrainY = this.getGroundedY(x, z, fallback[1]);
    const yTooLow = !Number.isFinite(y) || y < terrainY - 15;
    const yTooHigh = Number.isFinite(y) && y > terrainY + 80;
    const safeY = yTooLow || yTooHigh ? terrainY : y;

    return [x, safeY, z];
  }

  teleportPlayer(
    playerId: string,
    position: [number, number, number],
    faceToward?: [number, number, number],
    suppressEffect = false,
  ): void {
    const entity = this.world.entities.get(playerId);
    if (!entity) return;

    // Position as object for events
    const posObj = { x: position[0], y: position[1], z: position[2] };

    // Calculate rotation to face opponent if specified
    let rotation = 0;
    if (faceToward) {
      const dx = faceToward[0] - position[0];
      const dz = faceToward[2] - position[2];
      rotation = Math.atan2(dx, dz);
    }

    // Update entity data - keep as tuple format for type compatibility
    entity.data.position = position;
    entity.data.rotation = rotation;

    // Mark as teleport for network sync (tells client to snap, not lerp)
    entity.data._teleport = true;

    // Emit teleport event for network system to handle properly.
    // suppressEffect tells the client to skip the visual beam/glow effect
    // (used during FIGHTING-phase proximity corrections).
    this.world.emit("player:teleport", {
      playerId,
      position: posObj,
      rotation,
      suppressEffect,
    });

    // Emit entity modified for immediate sync
    this.world.emit(EventType.ENTITY_MODIFIED, {
      id: playerId,
      changes: {
        position,
        rotation,
        _teleport: true,
      },
    });

    Logger.debug(
      "StreamingDuelScheduler",
      `Teleported ${playerId} to [${position.join(", ")}]`,
    );
  }

  // ============================================================================
  // Fight Execution
  // ============================================================================

  startFight(fightStartedAt = Date.now()): void {
    const cycle = this.getCurrentCycle();
    if (!cycle) return;

    // Phase guard — only transition from COUNTDOWN (Fix B).
    if (cycle.phase !== "COUNTDOWN") return;

    const { agent1, agent2 } = cycle;

    // Validate both agents exist and are alive (Fix B).
    const entity1 = agent1 ? this.world.entities.get(agent1.characterId) : null;
    const entity2 = agent2 ? this.world.entities.get(agent2.characterId) : null;
    const alive1 =
      entity1 && ((entity1.data as { health?: number }).health ?? 0) > 0;
    const alive2 =
      entity2 && ((entity2.data as { health?: number }).health ?? 0) > 0;

    if (!alive1 && !alive2) {
      // Both agents missing — caller should handle abort
      return;
    }
    if (!alive1 && agent2) {
      this.onResolution(agent2.characterId, agent1?.characterId ?? "", "kill");
      return;
    }
    if (!alive2 && agent1) {
      this.onResolution(agent1.characterId, agent2?.characterId ?? "", "kill");
      return;
    }

    if (!Number.isSafeInteger(fightStartedAt) || fightStartedAt <= 0) {
      this.onAbort("competitive_timing_contract_invalid");
      return;
    }
    const now = fightStartedAt;
    this.publicActionObservations.activateCycle(cycle.cycleId);
    this.setCurrentCycleFields({
      phase: "FIGHTING",
      phaseStartTime: now,
      fightStartTime: now,
      countdownValue: null,
    });
    // The public phase can render on the next browser frame. Establish both
    // authoritative targets at the same boundary so the first FIGHTING frame
    // never inherits countdown/movement orientation.
    this.reassertDuelFaceTargets(cycle.cycleId);

    Logger.info("StreamingDuelScheduler", "Fight started!");

    // Mark agents as in duel (prevents normal respawn mechanics)
    this.setDuelFlags(true);

    // Guarantee full HP at fight start. Health was restored during prep, but
    // agents may have taken incidental damage during the countdown (lingering
    // combat ticks, environmental damage, etc.).
    // quiet=true: skip PLAYER_RESPAWNED/PLAYER_SET_DEAD events that cause
    // visible teleport snaps on clients during the FIGHTING phase.
    if (agent1) this.restoreHealth(agent1.characterId, true);
    if (agent2) this.restoreHealth(agent2.characterId, true);

    // Emit fight start (streaming-specific event for spectator UI)
    this.world.emit("streaming:fight:start", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId ?? `streaming-${cycle.cycleId}`,
      duelKeyHex: cycle.duelKeyHex,
      betCloseTime: cycle.betCloseTime ?? now,
      fightStartTime: now,
      agent1Id: agent1?.characterId,
      agent2Id: agent2?.characterId,
      duration:
        STREAMING_TIMING.FIGHTING_DURATION +
        STREAMING_TIMING.END_WARNING_DURATION,
    });

    // Emit standard duel fight start so agent plugins enter combat mode.
    // The duel-events listener sends duelFightStart to both agent sockets.
    if (agent1 && agent2) {
      const duelId = cycle.duelId ?? `streaming-${cycle.cycleId}`;
      this.world.emit(EventType.DUEL_FIGHT_START, {
        duelId,
        challengerId: agent1.characterId,
        targetId: agent2.characterId,
        arenaId: cycle.arenaId ?? 0,
      });
    }

    // Make agents attack each other
    this.initiateAgentCombat();

    // Start DuelCombatAI for each agent (tick-based heal/buff/attack decisions)
    this.startCombatAIs().catch((err) => {
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to start combat AIs: ${errMsg(err)}`,
      );
      const activeCycle = this.getCurrentCycle();
      if (
        activeCycle?.cycleId === cycle.cycleId &&
        activeCycle.phase === "FIGHTING"
      ) {
        this.onAbort("competitive_agent_policy_unavailable");
      }
    });
  }

  /**
   * Start DuelCombatAI instances for both agents.
   * These run alongside the re-engagement loop and handle food eating,
   * potion usage, and combat phase awareness (opening, trading, finishing).
   */
  private async switchFrozenCombatRole(
    cycleId: string,
    playerId: string,
    targetRole: SwitchableStreamingCombatRole,
    operationId: string,
    publicActionObservation?: StreamingDuelRoleSwitchObservationContext,
  ): Promise<{
    ok: boolean;
    retryable: boolean;
    replayed?: boolean;
    reason?: string;
  }> {
    const cycle = this.getCurrentCycle();
    const contestant =
      cycle?.agent1?.characterId === playerId
        ? cycle.agent1
        : cycle?.agent2?.characterId === playerId
          ? cycle.agent2
          : null;
    const frozen = this.combatSetupSnapshotsByAgent.get(playerId);
    const parsedPublicActionObservation =
      publicActionObservation === undefined
        ? undefined
        : parseStreamingDuelRoleSwitchObservationContext(
            publicActionObservation,
          );
    const expectedOperationPrefix = `combat-loadout:${cycleId}:${playerId}:`;
    const diagnosticSwitchAllowed = Boolean(
      frozen?.diagnosticProvisioningAllowed &&
      frozen.diagnosticMultiStyleAllowed &&
      isLocalDiagnosticDuelRuntime(process.env),
    );
    if (
      !cycle ||
      cycle.cycleId !== cycleId ||
      cycle.phase !== "FIGHTING" ||
      !contestant ||
      !frozen ||
      (publicActionObservation !== undefined &&
        (!parsedPublicActionObservation ||
          parsedPublicActionObservation.cycleId !== cycleId ||
          parsedPublicActionObservation.duelId !==
            (cycle.duelId ?? `streaming-${cycleId}`) ||
          parsedPublicActionObservation.actorId !== playerId ||
          parsedPublicActionObservation.opponentId !==
            (cycle.agent1?.characterId === playerId
              ? cycle.agent2?.characterId
              : cycle.agent1?.characterId) ||
          parsedPublicActionObservation.targetRole !== targetRole)) ||
      (frozen.diagnosticProvisioningAllowed && !diagnosticSwitchAllowed) ||
      !frozen.combatLoadouts[targetRole] ||
      !operationId.startsWith(expectedOperationPrefix)
    ) {
      return {
        ok: false,
        retryable: false,
        reason: "orchestrator_boundary_rejected",
      };
    }
    const sequence = Number(operationId.slice(expectedOperationPrefix.length));
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 12) {
      return {
        ok: false,
        retryable: false,
        reason: "operation_sequence_invalid",
      };
    }

    const equipmentSystem = this.getEquipmentSystem();
    if (!equipmentSystem?.switchOwnedCombatLoadout) {
      return {
        ok: false,
        retryable: false,
        reason: "equipment_system_unavailable",
      };
    }

    const opponentId =
      cycle.agent1?.characterId === playerId
        ? cycle.agent2?.characterId
        : cycle.agent1?.characterId;
    const combatSystem = this.world.getSystem("combat") as {
      hasActiveProjectilesBetween?: (
        entityAId: string,
        entityBId: string,
      ) => boolean;
      quiesceAutoAttacksBetween?: (
        entityAId: string,
        entityBId: string,
      ) => boolean;
    } | null;
    if (
      opponentId &&
      combatSystem?.hasActiveProjectilesBetween?.(playerId, opponentId)
    ) {
      // forceStopAgentCombat tears down the shared combat pair and therefore
      // cancels its delayed damage. Finish the committed attack first; the AI
      // retries this exact operation ID from a later authoritative tick.
      return combatSystem.quiesceAutoAttacksBetween?.(playerId, opponentId) ===
        true
        ? {
            ok: false,
            retryable: true,
            reason: "attack_in_flight",
          }
        : {
            ok: false,
            retryable: false,
            reason: "attack_quiesce_unavailable",
          };
    }
    const requestFingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          cycleId,
          playerId,
          frozenFingerprint: frozen.fingerprint,
          targetRole,
          loadout: frozen.combatLoadouts[targetRole],
          ...(parsedPublicActionObservation
            ? { publicActionObservation: parsedPublicActionObservation }
            : {}),
        }),
      )
      .digest("hex");

    // Combat must be recreated from the committed weapon profile. Ending it
    // before persistence also prevents an attack tick from consuming supplies
    // while the custody transaction is comparing its expected pre-state.
    this.forceStopAgentCombat(playerId);
    const receipt = await equipmentSystem.switchOwnedCombatLoadout(playerId, {
      operationId,
      requestFingerprint,
      targetRole,
      allowedLoadouts: frozen.combatLoadouts,
      ...(parsedPublicActionObservation
        ? { publicActionObservation: parsedPublicActionObservation }
        : {}),
    });
    if (!receipt.ok) {
      return {
        ok: false,
        retryable:
          receipt.reason === "inventory_busy" ||
          receipt.reason === "persistence_failed" ||
          receipt.reason === "committed_state_apply_failed",
        reason: receipt.reason,
      };
    }

    this.combatRolesByAgent.set(playerId, targetRole);
    const entity = this.world.entities.get(playerId);
    if (entity?.data.inStreamingDuel === true) {
      (entity.data as Record<string, unknown>).streamingDuelCombatRole =
        targetRole;
      (entity.data as Record<string, unknown>).streamingDuelWeaponId =
        this.getEquippedWeaponId(playerId);
    }
    this.refreshContestantLoadout(contestant);
    Logger.info(
      "StreamingDuelScheduler",
      `Committed frozen combat role switch for ${playerId}: ${targetRole}${receipt.replayed ? " (replayed)" : ""}`,
    );
    return { ok: true, retryable: false, replayed: receipt.replayed };
  }

  /**
   * Bind each pre-market planner identity and exact embedded game service.
   * Diagnostic/no-money contestants use their separate synthetic path;
   * persisted public markets always fail closed and never pass the planner
   * runtime into combat.
   */
  async validateCompetitiveAgentPolicies(input: {
    cycleId: string;
    diagnostic: boolean;
    contestants: readonly [
      CompetitiveSnapshotContestant,
      CompetitiveSnapshotContestant,
    ];
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (input.diagnostic) {
      this.validatedCompetitiveAgentPolicies = null;
      return { ok: true };
    }

    for (const contestant of input.contestants) {
      const availableRoles = contestant.availableCombatStyles.filter(
        (style): style is SwitchableStreamingCombatRole =>
          style === "melee" || style === "ranged" || style === "mage",
      );
      const prayerLevel =
        contestant.skillLevels?.find((skill) => skill.skill === "prayer")
          ?.level ?? 1;
      const availablePrayerIds =
        (contestant.prayer?.pointUnits ?? 0) > 0
          ? getAvailablePrayerIdsForLevel(prayerLevel)
          : [];
      if (
        !normalizeCompetitiveTacticalStrategy(
          contestant.preparation.tacticalStrategy,
          availableRoles,
          availablePrayerIds,
        )
      ) {
        this.validatedCompetitiveAgentPolicies = null;
        return {
          ok: false,
          reason: "competitive_tactical_strategy_unavailable",
        };
      }
    }

    const existing = this.validatedCompetitiveAgentPolicies;
    if (existing?.cycleId === input.cycleId) {
      for (const contestant of input.contestants) {
        const expected = existing.agents.get(contestant.agentId);
        let currentService: EmbeddedHyperiaService | null;
        let current: CompetitiveAgentPolicyBinding | null;
        try {
          currentService = existing.manager.getAgentService(contestant.agentId);
          current = existing.manager.getCompetitiveAgentPolicyBinding(
            contestant.agentId,
            contestant.preparation.planningPolicyVersion,
          );
        } catch {
          currentService = null;
          current = null;
        }
        if (
          !expected ||
          !current ||
          !current.combatControllerEnabled ||
          currentService !== expected.service
        ) {
          this.validatedCompetitiveAgentPolicies = null;
          return {
            ok: false,
            reason: "competitive_agent_policy_unavailable",
          };
        }
        if (
          current.fingerprint !== expected.binding.fingerprint ||
          current.provider !== expected.binding.provider ||
          current.model !== expected.binding.model
        ) {
          this.validatedCompetitiveAgentPolicies = null;
          return { ok: false, reason: "competitive_agent_policy_drift" };
        }
      }
      return { ok: true };
    }

    const { getAgentManager } = await import("../../../eliza/AgentManager.js");
    const manager = getAgentManager() as CompetitiveAgentPolicyManager | null;
    if (!manager) {
      this.validatedCompetitiveAgentPolicies = null;
      return {
        ok: false,
        reason: "competitive_agent_policy_unavailable",
      };
    }

    const agents = new Map<string, ValidatedCompetitiveAgentPolicy>();
    for (const contestant of input.contestants) {
      let service: EmbeddedHyperiaService | null;
      let binding: CompetitiveAgentPolicyBinding | null;
      try {
        service = manager.getAgentService(contestant.agentId);
        binding = manager.getCompetitiveAgentPolicyBinding(
          contestant.agentId,
          contestant.preparation.planningPolicyVersion,
        );
      } catch {
        this.validatedCompetitiveAgentPolicies = null;
        return {
          ok: false,
          reason: "competitive_agent_policy_unavailable",
        };
      }
      if (!service || !binding || !binding.combatControllerEnabled) {
        this.validatedCompetitiveAgentPolicies = null;
        return {
          ok: false,
          reason: "competitive_agent_policy_unavailable",
        };
      }
      if (
        binding.fingerprint !== contestant.preparation.agentPolicyFingerprint ||
        binding.provider !== contestant.provider ||
        binding.model !== contestant.model
      ) {
        this.validatedCompetitiveAgentPolicies = null;
        return { ok: false, reason: "competitive_agent_policy_drift" };
      }
      agents.set(contestant.agentId, { service, binding });
    }

    this.validatedCompetitiveAgentPolicies = {
      cycleId: input.cycleId,
      manager,
      agents,
    };
    return { ok: true };
  }

  /**
   * Synchronous combat-tick guard. Only the embedded game service and
   * deterministic controller remain authoritative after market publication;
   * the planning model runtime is deliberately absent from DuelCombatAI.
   */
  private hasCurrentCompetitiveAgentPolicies(
    cycle: StreamingDuelCycle,
  ): boolean {
    const snapshot = cycle.competitiveSnapshot;
    if (!snapshot || snapshot.diagnostic) return true;
    const validated = this.validatedCompetitiveAgentPolicies;
    if (!validated || validated.cycleId !== cycle.cycleId) return false;

    for (const contestant of snapshot.contestants) {
      const expected = validated.agents.get(contestant.agentId);
      let currentService: EmbeddedHyperiaService | null;
      let current: CompetitiveAgentPolicyBinding | null;
      try {
        currentService = validated.manager.getAgentService(contestant.agentId);
        current = validated.manager.getCompetitiveAgentPolicyBinding(
          contestant.agentId,
          contestant.preparation.planningPolicyVersion,
        );
      } catch {
        return false;
      }
      if (
        !expected ||
        !current ||
        currentService !== expected.service ||
        !current.combatControllerEnabled ||
        current.fingerprint !== expected.binding.fingerprint ||
        current.provider !== expected.binding.provider ||
        current.model !== expected.binding.model
      ) {
        return false;
      }
    }
    return true;
  }

  async startCombatAIs(): Promise<void> {
    await this.stopCombatAIs();
    this.combatRetryCount = 0;

    const cycle = this.getCurrentCycle();
    if (!cycle?.agent1 || !cycle?.agent2) return;

    const combatAiEnabled =
      (process.env.STREAMING_DUEL_COMBAT_AI_ENABLED || "true")
        .toLowerCase()
        .trim() !== "false";
    if (!combatAiEnabled) {
      Logger.info(
        "StreamingDuelScheduler",
        "Combat AI disabled via STREAMING_DUEL_COMBAT_AI_ENABLED=false; relying on combat system re-engagement loop",
      );
      return;
    }

    const { agent1, agent2 } = cycle;
    const competitive =
      cycle.competitiveSnapshot && !cycle.competitiveSnapshot.diagnostic;
    let service1: EmbeddedHyperiaService | null;
    let service2: EmbeddedHyperiaService | null;
    let runtime1: CompetitiveAgentPolicyBinding["runtime"];
    let runtime2: CompetitiveAgentPolicyBinding["runtime"];

    if (competitive) {
      const validated = this.validatedCompetitiveAgentPolicies;
      if (
        !validated ||
        validated.cycleId !== cycle.cycleId ||
        !this.hasCurrentCompetitiveAgentPolicies(cycle)
      ) {
        throw new Error("competitive_agent_policy_not_validated");
      }
      const policy1 = validated.agents.get(agent1.characterId);
      const policy2 = validated.agents.get(agent2.characterId);
      if (!policy1 || !policy2) {
        throw new Error("competitive_agent_policy_not_validated");
      }
      service1 = policy1.service;
      service2 = policy2.service;
      // A money-bearing fight never receives a model runtime. The model's only
      // authority ended when its validated tactic was frozen into the snapshot.
      runtime1 = null;
      runtime2 = null;
    } else {
      const { getAgentManager } =
        await import("../../../eliza/AgentManager.js");
      const { getAgentRuntimeByCharacterId } =
        await import("../../../eliza/ModelAgentSpawner.js");
      const manager = getAgentManager();
      service1 = manager?.getAgentService(agent1.characterId) ?? null;
      service2 = manager?.getAgentService(agent2.characterId) ?? null;
      runtime1 = getAgentRuntimeByCharacterId(agent1.characterId);
      runtime2 = getAgentRuntimeByCharacterId(agent2.characterId);
    }

    const role1 = this.combatRolesByAgent.get(agent1.characterId) ?? "melee";
    const role2 = this.combatRolesByAgent.get(agent2.characterId) ?? "melee";
    const tacticalStrategy1 = cycle.competitiveSnapshot?.contestants.find(
      (contestant) => contestant.agentId === agent1.characterId,
    )?.preparation.tacticalStrategy;
    const tacticalStrategy2 = cycle.competitiveSnapshot?.contestants.find(
      (contestant) => contestant.agentId === agent2.characterId,
    )?.preparation.tacticalStrategy;
    if (competitive && (!tacticalStrategy1 || !tacticalStrategy2)) {
      throw new Error("competitive_tactical_strategy_unavailable");
    }
    const frozen1 = this.combatSetupSnapshotsByAgent.get(agent1.characterId);
    const frozen2 = this.combatSetupSnapshotsByAgent.get(agent2.characterId);
    const availablePrayerIds1 =
      frozen1 && frozen1.prayer.pointUnits > 0
        ? getAvailablePrayerIdsForLevel(frozen1.frozenSkillLevels.prayer ?? 1)
        : [];
    const availablePrayerIds2 =
      frozen2 && frozen2.prayer.pointUnits > 0
        ? getAvailablePrayerIdsForLevel(frozen2.frozenSkillLevels.prayer ?? 1)
        : [];
    const movementClampBounds = this.getStreamingArenaMovementBounds();
    const baseAiConfig = {
      noFood: DEFAULT_DUEL_RULES.noFood,
      movementClampBounds,
    };

    // Lock both services into arena mode:
    // 1. Clamp all movement to arena bounds (no reactive correction teleports).
    // 2. Disable autonomous behavior loop so agents don't wander off to quest
    //    or explore between DuelCombatAI ticks.
    this._arenaModeServices = [];
    for (const svc of [service1, service2]) {
      if (!svc) continue;
      const wasAutonomous =
        svc.isAutonomousBehaviorConfigured?.() ?? svc.isAutonomousEnabled();
      svc.setArenaBounds(movementClampBounds);
      svc.setAutonomousBehaviorEnabled(false);
      this._arenaModeServices.push({ service: svc, wasAutonomous });
    }

    const hasSystemLookup =
      typeof (this.world as { getSystem?: unknown }).getSystem === "function";
    const executorDatabase = (
      hasSystemLookup ? this.world.getSystem("database") : undefined
    ) as
      | {
          listPendingStreamingDuelExecutorCommandsAsync?: (
            cycleId: string,
          ) => Promise<StreamingDuelExecutorCommandReceipt[]>;
        }
      | undefined;
    if (executorDatabase?.listPendingStreamingDuelExecutorCommandsAsync) {
      const pending =
        await executorDatabase.listPendingStreamingDuelExecutorCommandsAsync(
          cycle.cycleId,
        );
      const serviceByActor = new Map<string, EmbeddedHyperiaService>();
      if (service1) serviceByActor.set(agent1.characterId, service1);
      if (service2) serviceByActor.set(agent2.characterId, service2);
      const duelId = cycle.duelId ?? `streaming-${cycle.cycleId}`;
      for (const command of pending) {
        const context = command.publicActionObservation;
        const service = serviceByActor.get(context.actorId);
        const expectedOpponent =
          context.actorId === agent1.characterId
            ? agent2.characterId
            : context.actorId === agent2.characterId
              ? agent1.characterId
              : null;
        if (
          !service ||
          !expectedOpponent ||
          command.playerId !== context.actorId ||
          context.cycleId !== cycle.cycleId ||
          context.duelId !== duelId ||
          context.opponentId !== expectedOpponent
        ) {
          throw new Error("streaming_duel_executor_recovery_invalid");
        }
        const recovered =
          await service.recoverStreamingDuelExecutorCommand(command);
        if (!recovered.completed || !recovered.outcome) {
          throw new Error("streaming_duel_executor_recovery_incomplete");
        }
        this.recordControllerPublicAction(
          cycle.cycleId,
          duelId,
          context.actorId,
          context.opponentId,
          {
            tick: context.tick,
            combatRole: context.combatRole,
            tacticalMacro: context.tacticalMacro,
            action: context.action,
            outcome: recovered.outcome,
            value: context.value,
            amount: null,
          } as DuelCombatPublicActionObservation,
          {
            operationId: context.operationId,
            observedAt: context.observedAt,
          },
        );
      }
    } else if (competitive && hasSystemLookup) {
      throw new Error("streaming_duel_executor_database_unavailable");
    }

    if (service1) {
      const ai1 = new DuelCombatAI(
        service1,
        agent2.characterId,
        {
          ...baseAiConfig,
          combatRole: role1,
          opponentCombatRole: role2,
          tacticalStrategy: tacticalStrategy1,
          availablePrayerIds: availablePrayerIds1,
          combatLoadouts:
            frozen1 &&
            (!frozen1.diagnosticProvisioningAllowed ||
              frozen1.diagnosticMultiStyleAllowed)
              ? this.cloneFrozenCombatLoadouts(frozen1.combatLoadouts)
              : {},
          loadoutSwitchOperationPrefix: `combat-loadout:${cycle.cycleId}:${agent1.characterId}`,
          switchCombatRole: async (
            targetRole,
            operationId,
            publicActionObservation,
          ) => {
            const result = await this.switchFrozenCombatRole(
              cycle.cycleId,
              agent1.characterId,
              targetRole,
              operationId,
              publicActionObservation,
            );
            if (result.ok) service1.invalidateCombatLoadoutObservation();
            return result;
          },
          initialStrafeSign: 1,
          publicActionIdentity: {
            cycleId: cycle.cycleId,
            duelId: cycle.duelId ?? `streaming-${cycle.cycleId}`,
            actorId: agent1.characterId,
            opponentId: agent2.characterId,
            phase: "FIGHTING",
          },
          onPublicActionObservation: (observation, persistence) => {
            this.recordControllerPublicAction(
              cycle.cycleId,
              cycle.duelId ?? `streaming-${cycle.cycleId}`,
              agent1.characterId,
              agent2.characterId,
              observation,
              persistence,
            );
          },
        },
        runtime1 ?? undefined,
        // Trash talk callback — sends chat as overhead bubble via the agent's service
        (text) => {
          service1.sendChatMessage(text).catch(() => {});
        },
      );
      ai1.setContext(agent1.name, agent2.combatLevel, agent2.name);
      ai1.start();
      this.combatAIs.set(agent1.characterId, ai1);
      const entity1 = this.world.entities.get(agent1.characterId);
      if (entity1) {
        (entity1.data as Record<string, unknown>).duelAiControlsMovement = true;
      }
      Logger.info(
        "StreamingDuelScheduler",
        `Combat AI started for ${agent1.name} (role=${role1}, frozen pre-market tactic)`,
      );
    }

    if (service2) {
      const ai2 = new DuelCombatAI(
        service2,
        agent1.characterId,
        {
          ...baseAiConfig,
          combatRole: role2,
          opponentCombatRole: role1,
          tacticalStrategy: tacticalStrategy2,
          availablePrayerIds: availablePrayerIds2,
          combatLoadouts:
            frozen2 &&
            (!frozen2.diagnosticProvisioningAllowed ||
              frozen2.diagnosticMultiStyleAllowed)
              ? this.cloneFrozenCombatLoadouts(frozen2.combatLoadouts)
              : {},
          loadoutSwitchOperationPrefix: `combat-loadout:${cycle.cycleId}:${agent2.characterId}`,
          switchCombatRole: async (
            targetRole,
            operationId,
            publicActionObservation,
          ) => {
            const result = await this.switchFrozenCombatRole(
              cycle.cycleId,
              agent2.characterId,
              targetRole,
              operationId,
              publicActionObservation,
            );
            if (result.ok) service2.invalidateCombatLoadoutObservation();
            return result;
          },
          initialStrafeSign: -1,
          publicActionIdentity: {
            cycleId: cycle.cycleId,
            duelId: cycle.duelId ?? `streaming-${cycle.cycleId}`,
            actorId: agent2.characterId,
            opponentId: agent1.characterId,
            phase: "FIGHTING",
          },
          onPublicActionObservation: (observation, persistence) => {
            this.recordControllerPublicAction(
              cycle.cycleId,
              cycle.duelId ?? `streaming-${cycle.cycleId}`,
              agent2.characterId,
              agent1.characterId,
              observation,
              persistence,
            );
          },
        },
        runtime2 ?? undefined,
        // Trash talk callback — sends chat as overhead bubble via the agent's service
        (text) => {
          service2.sendChatMessage(text).catch(() => {});
        },
      );
      ai2.setContext(agent2.name, agent1.combatLevel, agent1.name);
      ai2.start();
      this.combatAIs.set(agent2.characterId, ai2);
      const entity2 = this.world.entities.get(agent2.characterId);
      if (entity2) {
        (entity2.data as Record<string, unknown>).duelAiControlsMovement = true;
      }
      Logger.info(
        "StreamingDuelScheduler",
        `Combat AI started for ${agent2.name} (role=${role2}, frozen pre-market tactic)`,
      );
    }
  }

  /** Bounded live or most-recent terminal diagnostics for the authoritative pair. */
  getCombatAIDiagnostics(): DuelCombatAIDiagnosticSnapshot[] {
    if (this.combatAIs.size === 0) {
      return this.lastStoppedCombatAIDiagnostics.map((diagnostic) => ({
        ...diagnostic,
      }));
    }
    const cycle = this.getCurrentCycle();
    const capturedAtMs = Date.now();
    return [...this.combatAIs].map(([characterId, ai]) => ({
      characterId,
      cycleId: cycle?.cycleId ?? null,
      duelId: cycle?.duelId ?? null,
      active: true,
      capturedAtMs,
      ...ai.getStats(),
    }));
  }

  /** Stop all DuelCombatAI instances and log their final stats. */
  stopCombatAIs(): Promise<void> {
    const previousShutdown = this.combatAiShutdownInFlight;
    const activePairTick = this.combatAiTickInFlight ?? Promise.resolve();
    const tickShutdowns: Promise<void>[] = [];
    const cycle = this.getCurrentCycle();
    const capturedAtMs = Date.now();
    const stoppedDiagnostics: DuelCombatAIDiagnosticSnapshot[] = [];
    for (const [characterId, ai] of this.combatAIs) {
      const stats = ai.getStats();
      stoppedDiagnostics.push({
        characterId,
        cycleId: cycle?.cycleId ?? null,
        duelId: cycle?.duelId ?? null,
        active: false,
        capturedAtMs,
        ...stats,
      });
      Logger.info(
        "StreamingDuelScheduler",
        `Combat AI request stats for ${characterId}: role=${stats.combatRole}, switches=${stats.successfulRoleSwitches}/${stats.roleSwitchAttempts} (${stats.roleSwitchDeferrals} attack-completion deferrals, ${stats.roleSwitchFailures} failed), engagements=${stats.engagementAccepts}/${stats.engagementAttempts} accepted (${stats.engagementRejects} rejected, ${stats.engagementErrors} errored), styles=${stats.styleChangeAccepts}/${stats.styleChangeAttempts} accepted (${stats.styleChangeRejects} rejected, ${stats.styleChangeErrors} errored), prayers=${stats.prayerToggleCommits}/${stats.prayerToggleAttempts} committed (${stats.prayerToggleRejects} rejected; last failure=${stats.lastPrayerToggleFailureReason ?? "none"}), ${stats.foodUseAttempts} food-use attempts, movement=${stats.movementAccepts}/${stats.movementRequests} accepted (${stats.movementRejects} rejected, ${stats.movementErrors} errored; ${stats.movementPathsActive} active/${stats.movementPathsInactive} inactive paths), distance=${stats.minObservedDistance?.toFixed(2) ?? "n/a"}..${stats.maxObservedDistance?.toFixed(2) ?? "n/a"}, ${stats.totalDamageDealt} observed dmg dealt`,
      );
      tickShutdowns.push(ai.stopAndWaitForIdle());
      const entity = this.world.entities.get(characterId);
      if (entity) {
        (entity.data as Record<string, unknown>).duelAiControlsMovement = false;
      }
    }
    if (stoppedDiagnostics.length > 0) {
      this.lastStoppedCombatAIDiagnostics = stoppedDiagnostics;
    }
    this.combatAIs.clear();
    // Release arena mode: restore movement freedom and autonomous behavior.
    for (const { service, wasAutonomous } of this._arenaModeServices) {
      service.clearArenaBounds();
      service.setAutonomousBehaviorEnabled(wasAutonomous);
    }
    this._arenaModeServices = [];
    const shutdown = Promise.all([
      previousShutdown,
      activePairTick,
      ...tickShutdowns,
    ]).then(() => undefined);
    this.combatAiShutdownInFlight = shutdown;
    void shutdown.then(() => {
      if (this.combatAiShutdownInFlight === shutdown) {
        this.combatAiShutdownInFlight = Promise.resolve();
      }
    });
    return shutdown;
  }

  /** Await all projectile custody already authorized by the combat runtime. */
  waitForCombatCustodySettlements(): Promise<void> {
    return this.combatCustodyShutdownInFlight;
  }

  // ============================================================================
  // Duel Flags
  // ============================================================================

  /** Set or clear duel flags on agents to prevent normal respawn */
  setDuelFlags(inDuel: boolean): void {
    const cycle = this.getCurrentCycle();
    if (!cycle?.agent1 || !cycle?.agent2) return;

    const { agent1, agent2 } = cycle;

    const entity1 = this.world.entities.get(agent1.characterId);
    const entity2 = this.world.entities.get(agent2.characterId);

    if (entity1) {
      entity1.data.inStreamingDuel = inDuel;
      entity1.data.preventRespawn = inDuel;
      (entity1.data as Record<string, unknown>).streamingDuelCombatRole = inDuel
        ? (this.combatRolesByAgent.get(agent1.characterId) ?? "melee")
        : null;
      (entity1.data as Record<string, unknown>).streamingDuelWeaponId = inDuel
        ? this.getEquippedWeaponId(agent1.characterId)
        : null;
      (entity1.data as Record<string, unknown>).streamingDuelOpponentId = inDuel
        ? agent2.characterId
        : null;
      if (!inDuel) {
        (entity1.data as Record<string, unknown>).duelAiControlsMovement =
          false;
      }
    }
    if (entity2) {
      entity2.data.inStreamingDuel = inDuel;
      entity2.data.preventRespawn = inDuel;
      (entity2.data as Record<string, unknown>).streamingDuelCombatRole = inDuel
        ? (this.combatRolesByAgent.get(agent2.characterId) ?? "melee")
        : null;
      (entity2.data as Record<string, unknown>).streamingDuelWeaponId = inDuel
        ? this.getEquippedWeaponId(agent2.characterId)
        : null;
      (entity2.data as Record<string, unknown>).streamingDuelOpponentId = inDuel
        ? agent1.characterId
        : null;
      if (!inDuel) {
        (entity2.data as Record<string, unknown>).duelAiControlsMovement =
          false;
      }
    }
  }

  /**
   * Clear streaming duel flags for contestants in a cycle.
   */
  clearDuelFlagsForCycle(cycle: StreamingDuelCycle | null): void {
    if (!cycle) {
      return;
    }

    const ids = [
      cycle.agent1?.characterId ?? null,
      cycle.agent2?.characterId ?? null,
    ].filter((playerId): playerId is string => playerId !== null);
    for (const playerId of ids) {
      const entity = this.world.entities.get(playerId);
      if (!entity) {
        continue;
      }
      entity.data.inStreamingDuel = false;
      entity.data.preventRespawn = false;
      (entity.data as Record<string, unknown>).arenaBounds = null;
      (entity.data as Record<string, unknown>).streamingDuelOpponentId = null;
      (entity.data as Record<string, unknown>).streamingDuelCombatRole = null;
      (entity.data as Record<string, unknown>).streamingDuelWeaponId = null;
      (entity.data as Record<string, unknown>).duelAiControlsMovement = false;
    }
  }

  /**
   * Clear flags from a completed cycle without clobbering agents that are
   * already contestants in a newly-started cycle.
   */
  clearDuelFlagsForCycleIfInactive(cycle: StreamingDuelCycle | null): void {
    if (!cycle) {
      return;
    }

    const currentCycle = this.getCurrentCycle();
    const currentAgent1Id = currentCycle?.agent1?.characterId ?? null;
    const currentAgent2Id = currentCycle?.agent2?.characterId ?? null;
    const ids = [
      cycle.agent1?.characterId ?? null,
      cycle.agent2?.characterId ?? null,
    ].filter((playerId): playerId is string => playerId !== null);

    for (const playerId of ids) {
      if (playerId === currentAgent1Id || playerId === currentAgent2Id) {
        continue;
      }

      const entity = this.world.entities.get(playerId);
      if (!entity) {
        continue;
      }
      entity.data.inStreamingDuel = false;
      entity.data.preventRespawn = false;
      (entity.data as Record<string, unknown>).arenaBounds = null;
      (entity.data as Record<string, unknown>).streamingDuelOpponentId = null;
      (entity.data as Record<string, unknown>).streamingDuelCombatRole = null;
      (entity.data as Record<string, unknown>).streamingDuelWeaponId = null;
      (entity.data as Record<string, unknown>).duelAiControlsMovement = false;
    }
  }

  /**
   * Clear stale duel flags from idle agents when no duel owns them.
   */
  clearStaleDuelFlagsForIdleAgents(availableAgents: Set<string>): void {
    const cycle = this.getCurrentCycle();
    if (cycle) {
      return;
    }

    for (const agentId of availableAgents) {
      const entity = this.world.entities.get(agentId);
      if (!entity) {
        continue;
      }

      if (
        entity.data.inStreamingDuel === true ||
        entity.data.preventRespawn === true
      ) {
        entity.data.inStreamingDuel = false;
        entity.data.preventRespawn = false;
        (entity.data as Record<string, unknown>).arenaBounds = null;
        (entity.data as Record<string, unknown>).streamingDuelOpponentId = null;
        (entity.data as Record<string, unknown>).streamingDuelCombatRole = null;
        (entity.data as Record<string, unknown>).streamingDuelWeaponId = null;
        (entity.data as Record<string, unknown>).duelAiControlsMovement = false;
      }
    }
  }

  // ============================================================================
  // Combat Engagement
  // ============================================================================

  initiateAgentCombat(): void {
    const cycle = this.getCurrentCycle();
    if (!cycle?.agent1 || !cycle?.agent2) return;

    const { agent1, agent2 } = cycle;

    this.tryMutualCombat(agent1.characterId, agent2.characterId);

    const cycleAfter = this.getCurrentCycle();
    if (!cycleAfter || cycleAfter.phase !== "FIGHTING") {
      return;
    }

    Logger.info(
      "StreamingDuelScheduler",
      `Combat initiated between ${agent1.name} and ${agent2.name}`,
    );

    // Set entity-level combat flags only when CombatSystem didn't establish
    // state (e.g., startCombat failed due to range/validation). This prevents
    // masking engagement failures — DuelCombatAI checks these flags to decide
    // whether to call executeAttack(), so false positives cause agents to idle.
    const combatSystem = this.world.getSystem("combat") as {
      isInCombat?: (entityId: string) => boolean;
    } | null;
    if (!combatSystem?.isInCombat?.(agent1.characterId)) {
      this.setAgentCombatTarget(agent1.characterId, agent2.characterId);
    }
    if (!combatSystem?.isInCombat?.(agent2.characterId)) {
      this.setAgentCombatTarget(agent2.characterId, agent1.characterId);
    }

    // Fix L — Verify combat actually engaged; schedule one retry if not.
    this.scheduleCombatRetryIfNeeded(agent1.characterId, agent2.characterId);

    // Start combat re-engagement loop to keep agents fighting
    this.startCombatLoop();
  }

  /** Set combat target on an agent entity */
  setAgentCombatTarget(agentId: string, targetId: string): void {
    const entity = this.world.entities.get(agentId);
    if (!entity) return;

    entity.data.combatTarget = targetId;
    entity.data.inCombat = true;
    entity.data.attackTarget = targetId;
  }

  /**
   * Force-stop any active combat on an agent via the CombatSystem.
   *
   * This is essential before teleporting agents to the arena. Without it, the
   * CombatSystem's internal state (attack cooldowns, target tracking, chase
   * movement) continues independently of entity.data flags — combat ticks can
   * fire during async operations and broadcast attack events at pre-arena
   * positions.
   *
   * Also clears entity-level combat flags and emits a COMBAT_STOP_ATTACK event
   * so all listeners (animation, face direction, UI) properly reset.
   */
  forceStopAgentCombat(agentId: string): void {
    const combatSystem = this.world.getSystem("combat") as {
      forceEndCombat?: (entityId: string) => void;
      isInCombat?: (entityId: string) => boolean;
      waitForProjectileCustodySettlements?: () => Promise<void>;
    } | null;

    // Use the CombatSystem's forceEndCombat to properly tear down internal
    // combat state (StateService entries, attack cooldowns, animation resets).
    if (combatSystem?.forceEndCombat) {
      try {
        combatSystem.forceEndCombat(agentId);
      } catch {
        // Agent may not have active combat state; safe to ignore.
      }
    }
    if (combatSystem?.waitForProjectileCustodySettlements) {
      const previousShutdown = this.combatCustodyShutdownInFlight;
      const shutdown = Promise.all([
        previousShutdown,
        combatSystem.waitForProjectileCustodySettlements(),
      ]).then(() => undefined);
      this.combatCustodyShutdownInFlight = shutdown;
      void shutdown.then(
        () => {
          if (this.combatCustodyShutdownInFlight === shutdown) {
            this.combatCustodyShutdownInFlight = Promise.resolve();
          }
        },
        () => undefined,
      );
    }

    // Clear entity-level combat flags as a belt-and-suspenders measure.
    const entity = this.world.entities.get(agentId);
    if (entity) {
      (entity.data as AgentCombatData).inCombat = false;
      (entity.data as AgentCombatData).combatTarget = null;
      (entity.data as AgentCombatData).ct = null;
      (entity.data as AgentCombatData).c = false;
      (entity.data as AgentCombatData).attackTarget = null;
    }

    // Notify other systems (animation, face direction) to stop combat visuals.
    this.world.emit(EventType.COMBAT_STOP_ATTACK, { attackerId: agentId });
  }

  /**
   * Keep duel contestants within melee range to guarantee engagement.
   */
  ensureDuelProximity(agent1Id: string, agent2Id: string): void {
    const tileDelta = this.getTileDelta(agent1Id, agent2Id);
    const validCardinalSpacing =
      tileDelta !== null && tileDelta.dx + tileDelta.dz === 1;
    if (!validCardinalSpacing) {
      this.engagementMetrics.proximityCorrections++;
      Logger.warn(
        "StreamingDuelScheduler",
        `Contestants not in valid cardinal melee spacing (tileDelta=${tileDelta ? `${tileDelta.dx},${tileDelta.dz}` : "unknown"}), repositioning`,
      );
      this.teleportToCombatPositions(agent1Id, agent2Id, true);
    }
  }

  logCombatStartFailure(
    attackerId: string,
    targetId: string,
    side: "a1" | "a2",
  ): void {
    const tileDelta = this.getTileDelta(attackerId, targetId);
    Logger.warn(
      "StreamingDuelScheduler",
      `startCombat failed (${side}) attacker=${attackerId} target=${targetId} tileDelta=${tileDelta ? `${tileDelta.dx},${tileDelta.dz}` : "unknown"}`,
    );
  }

  /**
   * Fix L — After initiating combat, verify agents are actually engaged.
   * If neither is in combat after 1.5s, re-teleport to fix spacing and retry.
   */
  clearCombatRetryTimeout(): void {
    if (this.combatRetryTimeout) {
      clearTimeout(this.combatRetryTimeout);
      this.combatRetryTimeout = null;
    }
  }

  scheduleCombatRetryIfNeeded(agent1Id: string, agent2Id: string): void {
    this.clearCombatRetryTimeout();
    this.combatRetryTimeout = setTimeout(() => {
      this.combatRetryTimeout = null;
      const cycle = this.getCurrentCycle();
      if (!cycle || cycle.phase !== "FIGHTING") return;

      this.engagementMetrics.checks++;
      const combatSystem = this.world.getSystem("combat") as {
        startCombat?: (
          attackerId: string,
          targetId: string,
          options?: { attackerType?: string; targetType?: string },
        ) => boolean;
        isInCombat?: (entityId: string) => boolean;
        getDuelDamageReconciliationStats?: () => {
          pendingOperations?: unknown;
        };
      } | null;

      const entity1 = this.world.entities.get(agent1Id);
      const entity2 = this.world.entities.get(agent2Id);

      // Check CombatSystem state only — entity.data flags can be stale from
      // setAgentCombatTarget() and mask engagement failures.
      const inCombat1 = combatSystem?.isInCombat?.(agent1Id) ?? false;
      const inCombat2 = combatSystem?.isInCombat?.(agent2Id) ?? false;

      if (inCombat1 && inCombat2) {
        if (this.combatRetryCount > 1) {
          this.engagementMetrics.recoveries++;
        }
        this.combatRetryCount = 0; // Reset on success
        return;
      }

      // Persisted duel damage is committed before it mutates live health. A
      // hit can therefore be settling at the exact instant this wall-clock
      // watchdog samples combat state. Repositioning or counting a failure in
      // that custody window can tear down a healthy fight, and this 3-second
      // check naturally phase-locks with several weapon cadences. Defer without
      // consuming the retry budget; the normal fight deadline still bounds an
      // indefinitely unresolved persistence operation.
      const pendingDamageOperations = Number(
        combatSystem?.getDuelDamageReconciliationStats?.().pendingOperations ??
          0,
      );
      if (
        Number.isSafeInteger(pendingDamageOperations) &&
        pendingDamageOperations > 0
      ) {
        this.scheduleCombatRetryIfNeeded(agent1Id, agent2Id);
        return;
      }

      this.combatRetryCount++;
      if (this.combatRetryCount > DuelOrchestrator.MAX_COMBAT_RETRIES) {
        this.engagementMetrics.failures++;
        Logger.warn(
          "StreamingDuelScheduler",
          `Combat retry limit reached (${this.combatRetryCount}/${DuelOrchestrator.MAX_COMBAT_RETRIES}) — cancelling duel as no contest`,
        );
        this.combatRetryCount = 0;
        this.onAbort("combat_engagement_failed");
        return;
      }

      this.engagementMetrics.retries++;

      Logger.warn(
        "StreamingDuelScheduler",
        `Combat retry ${this.combatRetryCount}/${DuelOrchestrator.MAX_COMBAT_RETRIES}: neither agent in combat, re-teleporting`,
      );

      // Re-teleport to fix spacing, then retry combat
      this.ensureDuelProximity(agent1Id, agent2Id);

      if (combatSystem?.startCombat) {
        combatSystem.startCombat(agent1Id, agent2Id, {
          attackerType: "player",
          targetType: "player",
        });
        const cycleAfterRetry = this.getCurrentCycle();
        if (cycleAfterRetry?.phase === "FIGHTING") {
          combatSystem.startCombat(agent2Id, agent1Id, {
            attackerType: "player",
            targetType: "player",
          });
        }
      }

      this.setAgentCombatTarget(agent1Id, agent2Id);
      this.setAgentCombatTarget(agent2Id, agent1Id);

      // Schedule another retry check — if combat still hasn't started, the
      // counter will increment and eventually trigger the abort.
      this.scheduleCombatRetryIfNeeded(agent1Id, agent2Id);
    }, 3000); // 5 ticks at 600ms - aligned with combat loop re-engagement interval
  }

  getTileDelta(
    entityAId: string,
    entityBId: string,
  ): { dx: number; dz: number } | null {
    const entityA = this.world.entities.get(entityAId);
    const entityB = this.world.entities.get(entityBId);
    if (!entityA || !entityB) return null;

    const posA = entityA.data.position as
      | [number, number, number]
      | { x: number; y?: number; z: number }
      | undefined;
    const posB = entityB.data.position as
      | [number, number, number]
      | { x: number; y?: number; z: number }
      | undefined;
    if (!posA || !posB) return null;

    const ax = Array.isArray(posA) ? posA[0] : posA.x;
    const az = Array.isArray(posA) ? posA[2] : posA.z;
    const bx = Array.isArray(posB) ? posB[0] : posB.x;
    const bz = Array.isArray(posB) ? posB[2] : posB.z;

    const tileAx = Math.floor(ax);
    const tileAz = Math.floor(az);
    const tileBx = Math.floor(bx);
    const tileBz = Math.floor(bz);
    return {
      dx: Math.abs(tileAx - tileBx),
      dz: Math.abs(tileAz - tileBz),
    };
  }

  // ============================================================================
  // Combat Loop
  // ============================================================================

  /**
   * Start a loop that drives DuelCombatAI ticks and re-engages agents.
   *
   * Runs every 600ms (TICK_DURATION_MS) so AI decisions are aligned with
   * the game tick cadence instead of drifting on an independent setInterval.
   * Re-engagement for agents WITHOUT an active AI runs every 5th tick (~3s).
   */
  startCombatLoop(): void {
    // Clear any existing loop
    if (this.combatLoopInterval) {
      clearInterval(this.combatLoopInterval);
    }
    this.combatLoopTickCount = 0;
    const TICK_MS = 600; // Match game tick duration

    this.combatLoopInterval = setInterval(() => {
      const cycle = this.getCurrentCycle();
      if (!cycle || cycle.phase !== "FIGHTING") {
        if (this.combatLoopInterval) {
          clearInterval(this.combatLoopInterval);
          this.combatLoopInterval = null;
        }
        return;
      }
      void this.runCombatAITickOnce().catch((err) => {
        Logger.warn(
          "StreamingDuelScheduler",
          `Combat AI pair tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, TICK_MS);
  }

  /**
   * Execute one causally ordered controller tick for the current pair. A slow
   * durable movement or engagement commit cannot overlap the opponent's next
   * decision or accumulate interval backlog. First-mover order alternates on
   * each admitted tick so serialization introduces no persistent side bias.
   */
  runCombatAITickOnce(): Promise<void> {
    if (this.combatAiTickInFlight) return this.combatAiTickInFlight;
    const cycle = this.getCurrentCycle();
    if (
      !cycle ||
      cycle.phase !== "FIGHTING" ||
      !cycle.agent1 ||
      !cycle.agent2
    ) {
      return Promise.resolve();
    }
    this.combatLoopTickCount++;
    const tickNumber = this.combatLoopTickCount;
    const operation = this.executeCombatAITick(
      cycle.cycleId,
      cycle.agent1.characterId,
      cycle.agent2.characterId,
      tickNumber,
    );
    this.combatAiTickInFlight = operation;
    const clearOperation = (): void => {
      if (this.combatAiTickInFlight === operation) {
        this.combatAiTickInFlight = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  waitForCombatAITick(): Promise<void> {
    return this.combatAiTickInFlight ?? Promise.resolve();
  }

  private async executeCombatAITick(
    cycleId: string,
    agent1Id: string,
    agent2Id: string,
    tickNumber: number,
  ): Promise<void> {
    const cycle = this.getCurrentCycle();
    if (!cycle || cycle.cycleId !== cycleId || cycle.phase !== "FIGHTING") {
      return;
    }
    if (!this.hasCurrentCompetitiveAgentPolicies(cycle)) {
      Logger.warn(
        "StreamingDuelScheduler",
        "Competitive agent policy changed after market freeze; cancelling the duel",
      );
      this.onAbort("competitive_agent_policy_drift");
      return;
    }

    this.enforceStreamingArenaBounds(
      [agent1Id, agent2Id],
      this.getStreamingArenaMovementBounds(),
    );
    this.reassertDuelFaceTargets(cycleId);

    const controllerEntries = [...this.combatAIs];
    if (tickNumber % 2 === 0) controllerEntries.reverse();
    for (const [characterId, ai] of controllerEntries) {
      const currentCycle = this.getCurrentCycle();
      if (
        !currentCycle ||
        currentCycle.cycleId !== cycleId ||
        currentCycle.phase !== "FIGHTING" ||
        this.combatAIs.get(characterId) !== ai
      ) {
        return;
      }
      try {
        await ai.externalTick();
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Combat AI tick error for ${characterId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.reassertDuelFaceTargets(cycleId);
      }
    }

    const currentCycle = this.getCurrentCycle();
    if (
      !currentCycle ||
      currentCycle.cycleId !== cycleId ||
      currentCycle.phase !== "FIGHTING"
    ) {
      return;
    }
    this.enforceAgentSeparation(agent1Id, agent2Id);

    if (tickNumber % 5 !== 0) return;
    const agent1HasAI = this.combatAIs.has(agent1Id);
    const agent2HasAI = this.combatAIs.has(agent2Id);
    if (agent1HasAI && agent2HasAI) return;

    const entity1 = this.world.entities.get(agent1Id);
    const entity2 = this.world.entities.get(agent2Id);
    if (!agent1HasAI && entity1 && !entity1.data.combatTarget) {
      this.setAgentCombatTarget(agent1Id, agent2Id);
    }
    if (!agent2HasAI && entity2 && !entity2.data.combatTarget) {
      this.setAgentCombatTarget(agent2Id, agent1Id);
    }
    this.tryMutualCombat(agent1Id, agent2Id);
  }

  private reassertDuelFaceTargets(cycleId: string): void {
    const cycle = this.getCurrentCycle();
    if (
      !cycle ||
      cycle.cycleId !== cycleId ||
      cycle.phase !== "FIGHTING" ||
      !cycle.agent1 ||
      !cycle.agent2
    ) {
      return;
    }

    this.world.emit(EventType.COMBAT_FACE_TARGET, {
      playerId: cycle.agent1.characterId,
      targetId: cycle.agent2.characterId,
    });
    this.world.emit(EventType.COMBAT_FACE_TARGET, {
      playerId: cycle.agent2.characterId,
      targetId: cycle.agent1.characterId,
    });
  }

  /**
   * Attempt to start mutual combat between two agents via the combat system.
   * Handles proximity checks, failure logging, and mid-resolution bail.
   */
  tryMutualCombat(agent1Id: string, agent2Id: string): void {
    const combatSystem = this.world.getSystem("combat") as {
      startCombat?: (
        attackerId: string,
        targetId: string,
        options?: {
          attackerType?: string;
          targetType?: string;
          weaponType?: AttackType;
        },
      ) => boolean;
      isInCombat?: (entityId: string) => boolean;
      getCombatData?: (
        entityId: string,
      ) => { targetId?: unknown; inCombat?: boolean } | null;
    } | null;

    if (!combatSystem?.startCombat) {
      Logger.warn(
        "StreamingDuelScheduler",
        "Combat system not available or missing startCombat method",
      );
      return;
    }

    this.ensureDuelProximity(agent1Id, agent2Id);

    // Resolve weapon type from each agent's combat role so the combat system
    // creates the correct state (melee / ranged / magic). Without this, all
    // agents default to MELEE, which means magic and ranged agents never fire
    // their projectile-based attacks.
    const roleToWeaponType = (role: DuelCombatRole): AttackType => {
      switch (role) {
        case "mage":
          return AttackType.MAGIC;
        case "ranged":
          return AttackType.RANGED;
        default:
          return AttackType.MELEE;
      }
    };
    const role1 = this.combatRolesByAgent.get(agent1Id) ?? "melee";
    const role2 = this.combatRolesByAgent.get(agent2Id) ?? "melee";
    const weaponType1 = roleToWeaponType(role1);
    const weaponType2 = roleToWeaponType(role2);

    // Guard: Don't replace existing combat state if agent already has a valid
    // state targeting the correct opponent. createAttackerState replaces the
    // state Map entry which resets nextAttackTick — for slow weapons (2H swords,
    // attackSpeed 7) the auto-attack loop never reaches nextAttackTick because
    // repeated re-engagement keeps pushing it forward (starvation pattern).
    const hasValidState = (attackerId: string, targetId: string): boolean => {
      if (!combatSystem.getCombatData || !combatSystem.isInCombat) return false;
      if (!combatSystem.isInCombat(attackerId)) return false;
      const state = combatSystem.getCombatData(attackerId);
      return !!(state?.inCombat && String(state.targetId) === targetId);
    };

    if (!hasValidState(agent1Id, agent2Id)) {
      const started1 = combatSystem.startCombat(agent1Id, agent2Id, {
        attackerType: "player",
        targetType: "player",
        weaponType: weaponType1,
      });
      if (!started1) {
        this.logCombatStartFailure(agent1Id, agent2Id, "a1");
      }
    }

    // First attack may have ended the duel; do not allow stale follow-up hit.
    const cycle = this.getCurrentCycle();
    if (!cycle || cycle.phase !== "FIGHTING") {
      return;
    }

    if (!hasValidState(agent2Id, agent1Id)) {
      const started2 = combatSystem.startCombat(agent2Id, agent1Id, {
        attackerType: "player",
        targetType: "player",
        weaponType: weaponType2,
      });
      if (!started2) {
        this.logCombatStartFailure(agent2Id, agent1Id, "a2");
      }
    }
  }

  /** Stop the combat loop */
  stopCombatLoop(): void {
    if (this.combatLoopInterval) {
      clearInterval(this.combatLoopInterval);
      this.combatLoopInterval = null;
    }
  }

  // ============================================================================
  // HP Tracking
  // ============================================================================

  updateContestantHp(): void {
    const cycle = this.getCurrentCycle();
    if (!cycle?.agent1 || !cycle?.agent2) return;

    const entity1 = this.world.entities.get(cycle.agent1.characterId);
    const entity2 = this.world.entities.get(cycle.agent2.characterId);
    const previousHp1 = cycle.agent1.currentHp;
    const previousHp2 = cycle.agent2.currentHp;

    let nextHp1 = previousHp1;
    let nextHp2 = previousHp2;

    if (entity1) {
      const data = entity1.data as { health?: number };
      const maxHealth =
        this.getAgentSkillLevels(cycle.agent1.characterId).constitution || 10;
      const health = Number(data.health);
      nextHp1 = Number.isFinite(health)
        ? Math.max(0, Math.min(maxHealth, health))
        : 0;
      cycle.agent1.currentHp = nextHp1;
      cycle.agent1.maxHp = maxHealth;
    }

    if (entity2) {
      const data = entity2.data as { health?: number };
      const maxHealth =
        this.getAgentSkillLevels(cycle.agent2.characterId).constitution || 10;
      const health = Number(data.health);
      nextHp2 = Number.isFinite(health)
        ? Math.max(0, Math.min(maxHealth, health))
        : 0;
      cycle.agent2.currentHp = nextHp2;
      cycle.agent2.maxHp = maxHealth;
    }

    if (cycle.phase !== "FIGHTING") {
      return;
    }

    // Fallback for combat paths that mutate HP without emitting
    // COMBAT_DAMAGE_DEALT. If the damage event already fired, currentHp was
    // synchronized immediately and these deltas stay at zero.
    const hpLost1 = Math.max(0, previousHp1 - nextHp1);
    const hpLost2 = Math.max(0, previousHp2 - nextHp2);

    if (hpLost1 > 0) {
      cycle.agent2.damageDealtThisFight += hpLost1;
    }

    if (hpLost2 > 0) {
      cycle.agent1.damageDealtThisFight += hpLost2;
    }
  }

  // ============================================================================
  // Fight Resolution
  // ============================================================================

  endFightByTimeout(terminalAtOverride?: number): void {
    const cycle = this.getCurrentCycle();
    if (!cycle?.agent1 || !cycle?.agent2) return;

    // Defense-in-depth: only run during FIGHTING phase (Fix G).
    if (cycle.phase !== "FIGHTING") return;

    const { agent1, agent2 } = cycle;

    // A timeout without any combat evidence is an infrastructure failure, not
    // a sporting draw. Cancelling prevents fabricated results from reaching
    // the betting bridge or oracle publisher.
    if (
      agent1.damageDealtThisFight === 0 &&
      agent2.damageDealtThisFight === 0 &&
      agent1.currentHp === agent1.maxHp &&
      agent2.currentHp === agent2.maxHp
    ) {
      this.onAbort("no_combat_activity", terminalAtOverride);
      return;
    }

    // Determine winner by HP percentage
    const hp1Percent = agent1.currentHp / agent1.maxHp;
    const hp2Percent = agent2.currentHp / agent2.maxHp;

    let winnerId: string;
    let loserId: string;
    let winReason: "hp_advantage" | "damage_advantage";

    if (hp1Percent > hp2Percent) {
      winnerId = agent1.characterId;
      loserId = agent2.characterId;
      winReason = "hp_advantage";
    } else if (hp2Percent > hp1Percent) {
      winnerId = agent2.characterId;
      loserId = agent1.characterId;
      winReason = "hp_advantage";
    } else {
      // Tied HP - check damage dealt
      if (agent1.damageDealtThisFight > agent2.damageDealtThisFight) {
        winnerId = agent1.characterId;
        loserId = agent2.characterId;
        winReason = "damage_advantage";
      } else if (agent2.damageDealtThisFight > agent1.damageDealtThisFight) {
        winnerId = agent2.characterId;
        loserId = agent1.characterId;
        winReason = "damage_advantage";
      } else {
        // True draw — both HP and damage equal, with no winner or loser.
        this.startResolution(null, null, "draw", terminalAtOverride);
        return;
      }
    }

    this.startResolution(winnerId, loserId, winReason, terminalAtOverride);
  }

  startResolution(
    winnerId: string | null,
    loserId: string | null,
    winReason: StreamingDuelWinReason,
    terminalAtOverride?: number,
  ): void {
    const cycle = this.getCurrentCycle();
    if (!cycle) return;

    // Idempotency guard — only transition from FIGHTING or COUNTDOWN (Fix C).
    if (cycle.phase !== "FIGHTING" && cycle.phase !== "COUNTDOWN") {
      return;
    }

    const isDraw = winReason === "draw";
    if (!isDraw && (!winnerId || !loserId || winnerId === loserId)) {
      Logger.error(
        "StreamingDuelScheduler",
        `Invalid winning resolution (${winReason}): winner=${winnerId ?? "none"} loser=${loserId ?? "none"}`,
      );
      this.onAbort("invalid_resolution_participants");
      return;
    }
    if (isDraw) {
      winnerId = null;
      loserId = null;
    }

    // Stop the combat loop, retry timeout, and AIs
    this.stopCombatLoop();
    this.clearCombatRetryTimeout();
    this.stopCombatAIs();
    // Duel prayers are a conserved preparation resource. Stop their durable
    // drain at the terminal boundary; never restore the points spent in-fight.
    // Cleanup awaits this exact promise and retries a failed persistence edge.
    void this.beginDuelPrayerTeardown(cycle).catch((error) => {
      Logger.error(
        "StreamingDuelScheduler",
        `Immediate prayer teardown failed for cycle ${cycle.cycleId}: ${errMsg(error)}`,
      );
    });

    // CombatSystem runs on the authoritative world tick independently of the
    // duel AI loop. Stop both contestants immediately so no auto-attack or
    // delayed projectile can mutate HP during RESOLUTION or a following cycle.
    for (const agent of [cycle.agent1, cycle.agent2]) {
      if (agent) this.forceStopAgentCombat(agent.characterId);
    }

    // Notify the facade to handle resolution (phase transition, stats, recording, camera)
    this.onResolution(winnerId, loserId, winReason, terminalAtOverride);

    // Delay the victory emote so all death/combat cleanup (emote resets,
    // combat state teardown, scheduled animation resets) finishes first.
    // Without this, the "victory" emote gets immediately overwritten by
    // stale "idle" resets from the combat animation system.
    if (winnerId) {
      const resolvedWinnerId = winnerId;
      if (this.victoryEmoteTimeout) {
        clearTimeout(this.victoryEmoteTimeout);
      }
      this.victoryEmoteTimeout = setTimeout(() => {
        this.victoryEmoteTimeout = null;
        const liveCycle = this.getCurrentCycle();
        if (
          liveCycle?.phase !== "RESOLUTION" ||
          liveCycle.winnerId !== resolvedWinnerId
        ) {
          return;
        }
        this.triggerVictoryEmote(resolvedWinnerId);
        this.fireVictoryTrashTalk(resolvedWinnerId);
      }, 600);
    }
  }

  /**
   * Trigger victory emote on the winning agent.
   * Called after a short delay so all death/combat cleanup has finished
   * and won't overwrite the emote.
   */
  triggerVictoryEmote(winnerId: string): void {
    const network = this.world.network as NetworkWithSend | undefined;
    if (!network?.send) return;

    // Set emote on the server entity so any future entity sync includes it
    const entity = this.world.entities.get(winnerId);
    if (entity?.data) {
      entity.data.emote = "victory";
    }

    // Broadcast victory emote to all clients
    network.send("entityModified", {
      id: winnerId,
      changes: {
        e: "victory",
      },
    });

    Logger.info(
      "StreamingDuelScheduler",
      `Triggered victory emote for winner ${winnerId}`,
    );
  }

  /**
   * Fire a victory trash talk message from the winning agent.
   * Uses the agent's chat service to display a closing taunt overhead.
   */
  private fireVictoryTrashTalk(winnerId: string): void {
    const VICTORY_TAUNTS = [
      "GG EZ",
      "Too easy",
      "Get good",
      "Was that it?",
      "Next!",
      "Sit down kid",
      "Another one bites the dust",
      "Unmatched",
    ];

    // Fire-and-forget: try to send a victory taunt via agent service
    void (async () => {
      try {
        const { getAgentManager } =
          await import("../../../eliza/AgentManager.js");
        const manager = getAgentManager();
        const service = manager?.getAgentService(winnerId);
        if (service) {
          const msg =
            VICTORY_TAUNTS[Math.floor(Math.random() * VICTORY_TAUNTS.length)];
          await service.sendChatMessage(msg);
        }
      } catch {
        // Swallow — chat failure must not break resolution
      }
    })();
  }

  // ============================================================================
  // Post-Duel Cleanup
  // ============================================================================

  async cleanupAfterDuel(
    cycleSnapshot: StreamingDuelCycle,
    duelFoodSlotsSnapshotByAgent: Map<string, DuelFoodProvisionedSlot[]>,
  ): Promise<void> {
    if (!cycleSnapshot.agent1 || !cycleSnapshot.agent2) return;

    const { agent1, agent2 } = cycleSnapshot;
    const agent1TrackedFoodSlots =
      duelFoodSlotsSnapshotByAgent.get(agent1.characterId) ?? [];
    const agent2TrackedFoodSlots =
      duelFoodSlotsSnapshotByAgent.get(agent2.characterId) ?? [];

    // Restore the visible/runtime state immediately. Equipment and inventory
    // work can await persistence internally, but must not leave dead, fighting,
    // or arena-bound entities visible while it completes.
    this.restoreCycleContestants(cycleSnapshot, false);

    try {
      // A controller receipt can still be committing a frozen role switch or
      // consuming provisioned food after stop() revokes future decisions.
      // Do not inspect or mutate those custody domains until that exact tick
      // has fully unwound.
      await Promise.all([
        this.combatAiShutdownInFlight,
        this.combatCustodyShutdownInFlight,
      ]);
      // Remove scheduler-owned combat gear and food.
      await Promise.all([
        this.finishDuelPrayerTeardown(cycleSnapshot),
        this.cleanupAgentCombatSetup(agent1.characterId),
        this.cleanupAgentCombatSetup(agent2.characterId),
        this.removeDuelFood(agent1.characterId, agent1TrackedFoodSlots),
        this.removeDuelFood(agent2.characterId, agent2TrackedFoodSlots),
      ]);
    } finally {
      // Defer flag clear until current death-event dispatch unwinds. If we clear
      // synchronously here, PlayerDeathSystem may treat duel deaths as normal deaths
      // and force a Central Haven respawn before cleanup completes.
      // Use the captured cycle snapshot so async completion cannot clear flags
      // for a newly-started cycle.
      globalThis.queueMicrotask(() => {
        this.clearDuelFlagsForCycleIfInactive(cycleSnapshot);
      });
    }
  }

  /**
   * Restore a cancelled or shutdown cycle without waiting for the normal
   * resolution timer. Basic entity state is repaired synchronously; the
   * returned promise tracks scheduler-owned loadout cleanup.
   */
  async cleanupAfterAbort(cycleSnapshot: StreamingDuelCycle): Promise<void> {
    const agents = [cycleSnapshot.agent1, cycleSnapshot.agent2].filter(
      (agent): agent is AgentContestant => agent !== null,
    );
    if (agents.length === 0) {
      return;
    }

    const trackedFoodByAgent = new Map<string, DuelFoodProvisionedSlot[]>();
    for (const agent of agents) {
      trackedFoodByAgent.set(agent.characterId, [
        ...(this.duelFoodSlotsByAgent.get(agent.characterId) ?? []),
      ]);
      this.duelFoodSlotsByAgent.delete(agent.characterId);
    }

    this.restoreCycleContestants(cycleSnapshot, true);
    this.clearDuelFlagsForCycle(cycleSnapshot);

    // Match normal resolution: scheduler-owned equipment and food must not
    // race an already-authorized controller receipt during an abort.
    await Promise.all([
      this.combatAiShutdownInFlight,
      this.combatCustodyShutdownInFlight,
    ]);
    await Promise.all([
      this.finishDuelPrayerTeardown(cycleSnapshot),
      ...agents.map((agent) => this.cleanupAgentCombatSetup(agent.characterId)),
      ...agents.map((agent) =>
        this.removeDuelFood(
          agent.characterId,
          trackedFoodByAgent.get(agent.characterId) ?? [],
        ),
      ),
    ]);
  }

  /**
   * Begin one idempotent, durable prayer teardown for a terminal duel. A
   * competitive cycle that previously passed prayer custody validation fails
   * closed if that custody disappears; diagnostic cycles without a prayer
   * system remain valid no-money fixtures.
   */
  private beginDuelPrayerTeardown(
    cycleSnapshot: StreamingDuelCycle,
  ): Promise<void> {
    const existing = this.prayerTeardownInFlightByCycle.get(
      cycleSnapshot.cycleId,
    );
    if (existing) return existing;

    const combatAiShutdown = this.combatAiShutdownInFlight;
    const teardown = (async () => {
      await combatAiShutdown;
      await this.deactivateDuelPrayers(cycleSnapshot);
    })();
    this.prayerTeardownInFlightByCycle.set(cycleSnapshot.cycleId, teardown);
    return teardown;
  }

  private async finishDuelPrayerTeardown(
    cycleSnapshot: StreamingDuelCycle,
  ): Promise<void> {
    const teardown = this.beginDuelPrayerTeardown(cycleSnapshot);
    try {
      await teardown;
    } finally {
      if (
        this.prayerTeardownInFlightByCycle.get(cycleSnapshot.cycleId) ===
        teardown
      ) {
        this.prayerTeardownInFlightByCycle.delete(cycleSnapshot.cycleId);
      }
    }
  }

  private async deactivateDuelPrayers(
    cycleSnapshot: StreamingDuelCycle,
  ): Promise<void> {
    const agents = [cycleSnapshot.agent1, cycleSnapshot.agent2].filter(
      (agent): agent is AgentContestant => agent !== null,
    );
    if (agents.length === 0) return;

    const prayer = this.getPrayerSystem();
    const competitive =
      cycleSnapshot.competitiveSnapshot !== null &&
      cycleSnapshot.competitiveSnapshot !== undefined &&
      !cycleSnapshot.competitiveSnapshot.diagnostic;
    if (!prayer?.getPrayerCustody) {
      if (competitive) throw new Error("duel_prayer_custody_unavailable");
      return;
    }

    await Promise.all(
      agents.map(async (agent) => {
        const playerId = agent.characterId;
        const custody = prayer.getPrayerCustody?.(playerId);
        if (!custody?.ready || !custody.persistenceHealthy) {
          if (competitive) {
            throw new Error(`duel_prayer_state_not_ready:${playerId}`);
          }
          return;
        }
        if (custody.activePrayers.length === 0) return;
        if (!prayer.deactivateAllPrayers) {
          throw new Error(`duel_prayer_deactivation_unavailable:${playerId}`);
        }

        const receipt = await prayer.deactivateAllPrayers(
          playerId,
          `duel-prayer-teardown:${cycleSnapshot.cycleId}:${playerId}`,
        );
        const committed = prayer.getPrayerCustody?.(playerId);
        if (
          !receipt.success ||
          receipt.activePrayers.length > 0 ||
          !committed?.ready ||
          !committed.persistenceHealthy ||
          committed.activePrayers.length > 0 ||
          committed.pointUnits !== receipt.pointUnits
        ) {
          throw new Error(
            `duel_prayer_deactivation_failed:${playerId}:${receipt.reason ?? "state_mismatch"}`,
          );
        }
      }),
    );
  }

  private restoreCycleContestants(
    cycleSnapshot: StreamingDuelCycle,
    suppressTeleportEffect: boolean,
  ): void {
    for (const agent of [cycleSnapshot.agent1, cycleSnapshot.agent2]) {
      if (!agent) continue;

      try {
        this.stopCombat(agent.characterId);
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to stop combat for ${agent.characterId} during cleanup: ${errMsg(err)}`,
        );
      }

      try {
        this.restoreHealth(agent.characterId);
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to restore health for ${agent.characterId} during cleanup: ${errMsg(err)}`,
        );
      }

      try {
        const restorePosition = this.sanitizeRestorePosition(
          agent.originalPosition,
          agent.characterId,
        );
        this.teleportPlayer(
          agent.characterId,
          restorePosition,
          undefined,
          suppressTeleportEffect,
        );
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to restore position for ${agent.characterId} during cleanup: ${errMsg(err)}`,
        );
      }
    }
  }

  isAgentInCurrentCycle(playerId: string): boolean {
    const cycle = this.getCurrentCycle();
    return (
      cycle?.agent1?.characterId === playerId ||
      cycle?.agent2?.characterId === playerId
    );
  }

  async removeDuelFood(
    playerId: string,
    duelFoodSlots: DuelFoodProvisionedSlot[],
  ): Promise<void> {
    if (duelFoodSlots.length === 0) {
      return;
    }

    const inventorySystem = this.getInventorySystem();

    if (!inventorySystem?.getInventory || !inventorySystem?.removeItem) {
      return;
    }

    try {
      const inventory = inventorySystem.getInventory(playerId);
      if (!inventory) return;

      const itemsBySlot = new Map(
        inventory.items.map((item) => [item.slot, item] as const),
      );
      const trackedFoodItemIds = new Set(
        duelFoodSlots.map((entry) => entry.itemId),
      );
      let removed = 0;

      for (const entry of duelFoodSlots) {
        const item = itemsBySlot.get(entry.slot);
        if (!item) continue;

        if (!isDuelFoodItemId(item.itemId, entry.itemId)) {
          continue;
        }

        try {
          await inventorySystem.removeItem({
            playerId,
            itemId: item.itemId,
            quantity: item.quantity,
            slot: item.slot,
          });
          removed++;
        } catch (slotErr) {
          // Continue on error
        }
      }

      // Best effort sweep for any leftovers of this cycle's duel-food item(s).
      const refreshedInventory = inventorySystem.getInventory(playerId);
      if (refreshedInventory) {
        for (const item of refreshedInventory.items) {
          let shouldRemove = false;
          for (const duelFoodItemId of trackedFoodItemIds) {
            if (isDuelFoodItemId(item.itemId, duelFoodItemId)) {
              shouldRemove = true;
              break;
            }
          }
          if (!shouldRemove) continue;

          try {
            await inventorySystem.removeItem({
              playerId,
              itemId: item.itemId,
              quantity: item.quantity,
              slot: item.slot,
            });
            removed++;
          } catch (slotErr) {
            // Continue on error
          }
        }
      }

      if (removed > 0) {
        Logger.info(
          "StreamingDuelScheduler",
          `Removed ${removed} food items from ${playerId}`,
        );
      }
    } catch (err) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to remove duel food: ${errMsg(err)}`,
      );
    }
  }

  stopCombat(playerId: string): void {
    // Tear down CombatSystem internal state (StateService entries, attack
    // cooldowns, animation resets) so the combat tick doesn't re-set entity
    // flags after we clear them below.
    this.forceStopAgentCombat(playerId);

    const entity = this.world.entities.get(playerId);
    if (!entity) return;

    // Clear ALL combat-related entity data fields. The `ct` (serialized
    // combatTarget) and `attackTarget` fields are checked by
    // EmbeddedHyperiaService.getGameState() — leaving them stale causes
    // agents to think they're still in combat and return "idle" from every
    // behavior tick instead of moving or attacking.
    (entity.data as AgentCombatData).combatTarget = null;
    (entity.data as AgentCombatData).inCombat = false;
    (entity.data as AgentCombatData).ct = null;
    (entity.data as AgentCombatData).c = false;
    (entity.data as AgentCombatData).attackTarget = null;

    // Reset emote to idle so victory wave stops when agent teleports out
    entity.data.emote = "idle";
    const network = this.world.network as NetworkWithSend | undefined;
    network?.send?.("entityModified", {
      id: playerId,
      changes: { e: "idle" },
    });

    // Notify other systems (animation, face direction) to stop combat visuals.
    this.world.emit(EventType.COMBAT_STOP_ATTACK, { attackerId: playerId });
  }

  // ============================================================================
  // System Accessors (private helpers)
  // ============================================================================

  /** Get the inventory system with its expected shape. */
  private getInventorySystem(): InventorySystem {
    return this.world.getSystem("inventory") as InventorySystem;
  }

  /** Get the equipment system with its expected shape. */
  private getEquipmentSystem(): EquipmentSystem {
    return this.world.getSystem("equipment") as EquipmentSystem;
  }

  private getPrayerSystem(): PrayerSystemView | null {
    return this.world.getSystem("prayer") as PrayerSystemView | null;
  }

  private getPlayerSystem(): PlayerSystemView | null {
    return this.world.getSystem("player") as PlayerSystemView | null;
  }

  private isDiagnosticProvisioningAllowed(playerId: string): boolean {
    return (
      process.env.NODE_ENV === "test" ||
      ((process.env.NODE_ENV !== "production" ||
        isLocalDiagnosticDuelRuntime(process.env)) &&
        this.isSyntheticDiagnosticAgent(playerId))
    );
  }

  private isDiagnosticMultiStyleAllowed(playerId: string): boolean {
    return (
      this.diagnosticMultiStyleCharacterIds.has(playerId) &&
      isLocalDiagnosticDuelRuntime(process.env)
    );
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /** Reset all owned state for destroy cleanup */
  reset(): void {
    this.stopCombatLoop();
    this.clearCombatRetryTimeout();
    if (this.victoryEmoteTimeout) {
      clearTimeout(this.victoryEmoteTimeout);
      this.victoryEmoteTimeout = null;
    }
    this.stopCombatAIs();
    this.validatedCompetitiveAgentPolicies = null;
    this.duelFoodSlotsByAgent.clear();
    this.combatRolesByAgent.clear();
    this.diagnosticMultiStyleCharacterIds.clear();
    this.debugCombatRoleOverrideByCharacterId.clear();
    this._contestantCache.clear();
    this._contestantCacheExpiry = 0;
    this.combatLoopTickCount = 0;
    this.combatRetryCount = 0;
    this.engagementMetrics = {
      checks: 0,
      retries: 0,
      recoveries: 0,
      failures: 0,
      proximityCorrections: 0,
    };
  }
}
