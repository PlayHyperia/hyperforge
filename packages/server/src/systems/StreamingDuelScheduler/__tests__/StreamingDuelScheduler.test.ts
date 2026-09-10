import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttackType,
  EventType,
  ITEMS,
  calculateCombatLevel,
  canPlayerPerformPreparationAction,
  getStreamingDuelDamageAuthority,
  isPositionInsideCombatArena,
} from "@hyperforge/shared";
import {
  StreamingDuelScheduler as ProductionStreamingDuelScheduler,
  assertLocalDiagnosticContestantAuthority,
  resolveStreamingDuelDiagnosticAvatarUrl,
  resolveStreamingPublicPreparationMinimumDuration,
  resolveStreamingPreparationDuration,
  selectDiagnosticHarpoonPreparationPositions,
} from "../index";
import {
  digestCompetitiveSnapshot,
  finalizeCompetitiveSnapshot,
  type CompetitivePreparationEvidence,
} from "../competitive-snapshot";
import {
  DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT,
  type PersistedCompetitiveSnapshot,
} from "../preparation";
import { STREAMING_TIMING, type StreamingStateUpdate } from "../types";
import { buildDeterministicCompetitiveTacticalStrategy } from "../competitive-tactical-strategy";
import { buildCompetitiveTerminalProof } from "../competitive-terminal-proof";
import { Logger } from "../../ServerNetwork/services";
/** Legacy constant kept for test assertions. */
const DUEL_FOOD_ITEM = "shark";
const RECOVERY_ALPHA_WEAPON = "bronze_longsword";
const RECOVERY_BETA_WEAPON = "bronze_shortsword";
const recoveryItemPriors = new Map<string, unknown>();
import { isDuelFoodItemId } from "../../duelFood";

const localNoMoneyDiagnosticEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DUEL_LOCAL_SMOKE_MODE: "true",
  LOAD_TEST_MODE: "true",
  DUEL_BETTING_ENABLED: "false",
  DUEL_WITH_HYPERBET: "false",
  STREAMING_DUEL_SCHEDULER_ROLE: "authority",
  PUBLIC_API_URL: "http://127.0.0.1:5555",
  PUBLIC_WS_URL: "ws://127.0.0.1:5555/ws",
});

describe("diagnostic duel avatar boundary", () => {
  it.each([
    "authored-body15-test",
    "authored-body38-test",
    "authored-body38-light01-test",
  ])("permits %s only under the explicit diagnostic boundary", (id) => {
    const candidate = {
      STREAMING_DUEL_DIAGNOSTIC_AVATAR_ID: id,
    };
    expect(
      resolveStreamingDuelDiagnosticAvatarUrl({
        ...localNoMoneyDiagnosticEnv(),
        ...candidate,
      }),
    ).toBe(`asset://avatars/asset-studio-test/${id}.vrm`);
    expect(() => resolveStreamingDuelDiagnosticAvatarUrl(candidate)).toThrow(
      /loopback no-money/u,
    );
    expect(() =>
      resolveStreamingDuelDiagnosticAvatarUrl({
        ...localNoMoneyDiagnosticEnv(),
        ...candidate,
        DUEL_BETTING_ENABLED: "true",
      }),
    ).toThrow(/loopback no-money/u);
    expect(() =>
      resolveStreamingDuelDiagnosticAvatarUrl({
        ...localNoMoneyDiagnosticEnv(),
        ...candidate,
        PUBLIC_API_URL: "https://example.invalid",
      }),
    ).toThrow(/loopback no-money/u);
  });

  it("keeps the canonical rig unless an override is explicitly requested", () => {
    expect(resolveStreamingDuelDiagnosticAvatarUrl({})).toContain(
      "duel-steve.vrm",
    );
  });

  it("allows the vetted KayKit candidate only inside the no-money local boundary", () => {
    expect(
      resolveStreamingDuelDiagnosticAvatarUrl({
        ...localNoMoneyDiagnosticEnv(),
        STREAMING_DUEL_DIAGNOSTIC_AVATAR_ID: "kaykit-knight",
      }),
    ).toContain("duel-kaykit-knight.vrm");
  });

  it("rejects unknown avatars and any override outside the diagnostic boundary", () => {
    expect(() =>
      resolveStreamingDuelDiagnosticAvatarUrl({
        STREAMING_DUEL_DIAGNOSTIC_AVATAR_ID: "kaykit-knight",
      }),
    ).toThrow(/loopback no-money diagnostic boundary/u);
    expect(() =>
      resolveStreamingDuelDiagnosticAvatarUrl({
        ...localNoMoneyDiagnosticEnv(),
        STREAMING_DUEL_DIAGNOSTIC_AVATAR_ID: "not-registered",
      }),
    ).toThrow(/Unknown diagnostic duel avatar/u);
  });
});

describe("diagnostic contestant authority boundary", () => {
  it("accepts only the exact loopback no-money runtime", () => {
    expect(() =>
      assertLocalDiagnosticContestantAuthority(localNoMoneyDiagnosticEnv()),
    ).not.toThrow();
    expect(() =>
      assertLocalDiagnosticContestantAuthority({
        ...localNoMoneyDiagnosticEnv(),
        DUEL_BETTING_ENABLED: "true",
      }),
    ).toThrow(/explicit loopback no-money boundary/u);
  });
});

describe("diagnostic harpoon shoreline selection", () => {
  it("selects two separated walkable banks inside the certified contact envelope", () => {
    const positions = selectDiagnosticHarpoonPreparationPositions([0, 10, 0], {
      getHeightAt: () => 10.2,
      isPositionWalkableFast: (x, z) => Math.hypot(x, z) >= 2,
    });

    for (const [x, y, z] of positions) {
      expect(Math.hypot(x, z)).toBeLessThan(4);
      expect(y - 10).toBeLessThanOrEqual(0.3);
    }
    expect(
      Math.hypot(
        positions[1][0] - positions[0][0],
        positions[1][2] - positions[0][2],
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it("fails closed when the shoreline exceeds the certified strike reach", () => {
    expect(() =>
      selectDiagnosticHarpoonPreparationPositions([0, 10, 0], {
        getHeightAt: () => 10.31,
        isPositionWalkableFast: () => true,
      }),
    ).toThrow(/No two certified dry shoreline positions/u);
  });
});

type SkillMap = Record<string, { level: number; xp: number }>;

type InventoryItem = {
  slot: number;
  itemId: string;
  quantity: number;
};

type MockEntity = {
  id: string;
  type: "player";
  isAgent: boolean;
  isEmbeddedAgent?: boolean;
  data: {
    name: string;
    position: [number, number, number];
    health: number;
    maxHealth: number;
    skills: SkillMap;
    rotation?: number;
    _teleport?: boolean;
    inCombat?: boolean;
    c?: boolean;
    combatTarget?: string | null;
    ct?: string | null;
    attackTarget?: string | null;
    inStreamingDuel?: boolean;
    streamingDuelOpponentId?: string | null;
    streamingDuelCombatRole?: string | null;
    streamingDuelWeaponId?: string | null;
    preventRespawn?: boolean;
    arenaBounds?: unknown;
    alive?: boolean;
    emote?: string;
    selectedSpell?: string | null;
    isAgent?: boolean;
    isEmbeddedAgent?: boolean;
  };
};

type MockWorldContext = {
  world: {
    entities: {
      items: Map<string, MockEntity>;
      get: (id: string) => MockEntity | undefined;
      getAllEntities: () => Map<string, MockEntity>;
    };
    network: {
      send: ReturnType<typeof vi.fn>;
      syncStreamingContestants: ReturnType<typeof vi.fn>;
    };
    on: (event: string, fn: (payload: unknown) => void) => void;
    off: (event: string, fn: (payload: unknown) => void) => void;
    emit: (event: string, payload: unknown) => void;
    getSystem: (name: string) => unknown;
  };
  entities: Map<string, MockEntity>;
  combatCalls: Array<{ attackerId: string; targetId: string }>;
  forceEndCombatCalls: string[];
  equipCalls: Array<{ playerId: string; itemId: string; quantity: number }>;
  recoverPreparationCalls: Array<{
    playerId: string;
    preparationId: string;
  }>;
  getInventory: (playerId: string) => { items: InventoryItem[]; coins: number };
  countFood: (playerId: string) => number;
  hasItemAtSlot: (playerId: string, slot: number, itemId: string) => boolean;
  getEquippedWeapon: (playerId: string) => string | null;
  getEquipmentSlot: (
    playerId: string,
    slot: "weapon" | "arrows" | "shield",
  ) => { itemId: string | null; quantity?: number } | null;
  countItem: (playerId: string, itemId: string) => number;
  setDamageByAttacker: (playerId: string, damage: number) => void;
};

type SchedulerTestHarness = {
  startCountdown(): Promise<void>;
  tick(): void;
  orchestrator: {
    endFightByTimeout(terminalAtOverride?: number): void;
    startResolution(
      winnerId: string,
      loserId: string,
      winReason: "kill" | "forfeit" | "hp_advantage" | "damage_advantage",
      terminalAtOverride?: number,
    ): void;
    setDebugCombatRoleOverride(
      characterId: string,
      role: "melee" | "ranged" | "mage" | "prayer",
    ): void;
  };
};

function asSchedulerHarness(
  scheduler: StreamingDuelScheduler,
): SchedulerTestHarness {
  return scheduler as unknown as SchedulerTestHarness;
}

async function startCountdownAtMarketClose(
  scheduler: StreamingDuelScheduler,
): Promise<void> {
  const betCloseTime = scheduler.getCurrentCycle()?.betCloseTime;
  if (typeof betCloseTime !== "number" || !Number.isSafeInteger(betCloseTime)) {
    throw new Error("test cycle is missing its immutable betting close");
  }
  if (Date.now() < betCloseTime) {
    vi.setSystemTime(betCloseTime);
  }
  await (scheduler as unknown as SchedulerTestHarness)["startCountdown"]();
}

function testPlanEvidence(
  overrides: Partial<CompetitivePreparationEvidence> = {},
): CompetitivePreparationEvidence {
  const primaryStyle = overrides.primaryStyle ?? "melee";
  return {
    primaryStyle,
    availableStyles: ["melee"],
    planningSource: "deterministic",
    planningPolicyVersion: "scheduler-test-policy-v1",
    agentPolicyFingerprint: "ab".repeat(32),
    modelProvider: "test-provider",
    model: "test-model",
    tacticalStrategy:
      buildDeterministicCompetitiveTacticalStrategy(primaryStyle),
    ...overrides,
  };
}

function buildPersistedCompetitiveTestSnapshot(
  scheduler: StreamingDuelScheduler,
  frozenAt: number,
): PersistedCompetitiveSnapshot {
  const schedulerInternal = scheduler as any;
  for (const itemId of [RECOVERY_ALPHA_WEAPON, RECOVERY_BETA_WEAPON]) {
    if (!recoveryItemPriors.has(itemId)) {
      recoveryItemPriors.set(itemId, ITEMS.get(itemId));
    }
    ITEMS.set(itemId, {
      id: itemId,
      name: itemId,
      type: "weapon",
      attackType: AttackType.MELEE,
      weaponType: "LONGSWORD",
      equipSlot: "weapon",
      equipable: true,
    } as never);
  }
  vi.spyOn(
    schedulerInternal.orchestrator as any,
    "isDiagnosticProvisioningAllowed",
  ).mockReturnValue(false);
  vi.spyOn(
    schedulerInternal.orchestrator as any,
    "validateCompetitiveAgentPolicies",
  ).mockResolvedValue({ ok: true });
  vi.spyOn(
    schedulerInternal.orchestrator as any,
    "getPrayerSystem",
  ).mockReturnValue({
    getPrayerCustody: () => ({
      ready: true,
      persistenceHealthy: true,
      pointUnits: 200,
      points: 20,
      maxPoints: 20,
      activePrayers: [],
    }),
  });
  const preparationId = "75effa7e-b61e-4f54-9668-cb11cc451c21";
  const fencingToken = "40";
  const readiness1 =
    schedulerInternal.orchestrator.inspectCompetitiveLoadout("agent-alpha");
  const readiness2 =
    schedulerInternal.orchestrator.inspectCompetitiveLoadout("agent-beta");
  if (!readiness1.ok || !readiness2.ok) {
    throw new Error(
      `test contestants must be competitively ready: ${JSON.stringify([readiness1, readiness2])}`,
    );
  }
  const evidence1 = testPlanEvidence({
    primaryStyle: readiness1.initialCombatRole,
    availableStyles: [...readiness1.availableCombatStyles],
  });
  const evidence2 = testPlanEvidence({
    primaryStyle: readiness2.initialCombatRole,
    availableStyles: [...readiness2.availableCombatStyles],
  });
  const agent1 = schedulerInternal.orchestrator.createContestant(
    "agent-alpha",
    "agent-beta",
  );
  const agent2 = schedulerInternal.orchestrator.createContestant(
    "agent-beta",
    "agent-alpha",
  );
  if (!agent1 || !agent2) throw new Error("test contestants are missing");
  const frozen1 =
    schedulerInternal.orchestrator.freezeCompetitiveLoadout(agent1);
  const frozen2 =
    schedulerInternal.orchestrator.freezeCompetitiveLoadout(agent2);
  if (!frozen1.ok || !frozen2.ok || frozen1.diagnostic || frozen2.diagnostic) {
    throw new Error("test contestants require production competitive custody");
  }
  const snapshotAgent1 = schedulerInternal.buildCompetitiveSnapshotContestant(
    "agent1",
    agent1,
    evidence1,
  );
  const snapshotAgent2 = schedulerInternal.buildCompetitiveSnapshotContestant(
    "agent2",
    agent2,
    evidence2,
  );
  if (!snapshotAgent1 || !snapshotAgent2) {
    throw new Error("test competitive snapshot construction failed");
  }
  const cycleId = "recovered-cycle-1";
  const duelId = `streaming-${cycleId}`;
  const duelKey = schedulerInternal.deriveStreamingDuelKeyHex(cycleId);
  const finalized = finalizeCompetitiveSnapshot({
    draft: {
      diagnostic: false,
      preparationId,
      cycleId,
      duelId,
      duelKey,
      contestants: [snapshotAgent1, snapshotAgent2],
    },
    persisted: true,
    frozenAt,
    betWindowDurationMs: STREAMING_TIMING.ANNOUNCEMENT_DURATION,
    timing: {
      contractVersion: STREAMING_TIMING.CONTRACT_VERSION,
      timeoutPolicy: STREAMING_TIMING.TIMEOUT_POLICY,
      countdownDurationMs: STREAMING_TIMING.COUNTDOWN_DURATION,
      fightingDurationMs: STREAMING_TIMING.FIGHTING_DURATION,
      endWarningDurationMs: STREAMING_TIMING.END_WARNING_DURATION,
      maxFightDurationMs: STREAMING_TIMING.MAX_FIGHT_DURATION,
    },
  });
  schedulerInternal.orchestrator.releaseCompetitiveLoadout("agent-alpha");
  schedulerInternal.orchestrator.releaseCompetitiveLoadout("agent-beta");
  return {
    preparation: {
      preparationId,
      fencingToken,
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "frozen",
      selectedAt: frozenAt - 5_000,
      expiresAt: frozenAt + STREAMING_TIMING.ANNOUNCEMENT_DURATION,
      agent1ReadyAt: frozenAt - 2_000,
      agent2ReadyAt: frozenAt - 1_000,
      agent1PlanEvidence: evidence1,
      agent2PlanEvidence: evidence2,
      frozenAt,
      cancelledAt: null,
      cancellationReason: null,
      version: 4,
    },
    ...finalized,
    lockedAt: null,
    duelStartedAt: null,
    recoveredAt: null,
    lifecycleStatus: "frozen",
    terminal: null,
  };
}

function createAgentEntity(
  id: string,
  name: string,
  position: [number, number, number],
): MockEntity {
  const skills: SkillMap = {
    attack: { level: 10, xp: 0 },
    strength: { level: 10, xp: 0 },
    defense: { level: 10, xp: 0 },
    constitution: { level: 20, xp: 0 },
  };

  return {
    id,
    type: "player",
    isAgent: true,
    data: {
      name,
      position,
      health: 20,
      maxHealth: 20,
      skills,
      inCombat: false,
      combatTarget: null,
      attackTarget: null,
    },
  };
}

function createMockWorld(options?: {
  alphaInventory?: InventoryItem[];
  betaInventory?: InventoryItem[];
  alphaWeaponId?: string | null;
  betaWeaponId?: string | null;
  alphaArrowId?: string | null;
  betaArrowId?: string | null;
  alphaArrowQuantity?: number;
  betaArrowQuantity?: number;
  alphaShieldId?: string | null;
  betaShieldId?: string | null;
  alphaSelectedSpell?: string | null;
  betaSelectedSpell?: string | null;
  extraAgents?: Array<{
    id: string;
    name: string;
    position: [number, number, number];
  }>;
  terrainHeight?: number;
  failOnEmitEvent?: string;
  failOnEmitEventCount?: number;
  equipmentDelayMs?: number;
  equipmentReady?: (playerId: string) => boolean;
  playerReady?: (playerId: string) => boolean;
  recoverPreparationEquipment?: Record<
    string,
    {
      weaponId: string;
      arrowId?: string | null;
      arrowQuantity?: number;
    }
  >;
  damageByAttacker?: Record<string, number>;
  combatStarts?: boolean;
  duelDamagePending?: () => boolean;
  processingQuiescenceSystem?: {
    requestPlayerProcessingQuiescence(playerId: string): void;
    isPlayerProcessingQuiescent(playerId: string): boolean;
  };
}): MockWorldContext {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const entities = new Map<string, MockEntity>();
  const inventories = new Map<
    string,
    { items: InventoryItem[]; coins: number }
  >();
  const combatCalls: Array<{ attackerId: string; targetId: string }> = [];
  const forceEndCombatCalls: string[] = [];
  const combatState = new Set<string>();
  const equipCalls: Array<{
    playerId: string;
    itemId: string;
    quantity: number;
  }> = [];
  const recoverPreparationCalls: Array<{
    playerId: string;
    preparationId: string;
  }> = [];
  type MockEquipmentSlot = {
    itemId: string | null;
    item: { id: string } | null;
    quantity?: number;
  };
  const equipment = new Map<
    string,
    {
      weapon: MockEquipmentSlot;
      arrows: MockEquipmentSlot;
      shield: MockEquipmentSlot;
    }
  >();

  const alpha = createAgentEntity("agent-alpha", "Alpha", [10, 0.2, 10]);
  const beta = createAgentEntity("agent-beta", "Beta", [20, 0.2, 20]);
  entities.set(alpha.id, alpha);
  entities.set(beta.id, beta);
  alpha.data.selectedSpell = options?.alphaSelectedSpell ?? null;
  beta.data.selectedSpell = options?.betaSelectedSpell ?? null;
  equipment.set("agent-alpha", {
    weapon: options?.alphaWeaponId
      ? { itemId: options.alphaWeaponId, item: { id: options.alphaWeaponId } }
      : { itemId: null, item: null },
    arrows: options?.alphaArrowId
      ? {
          itemId: options.alphaArrowId,
          item: { id: options.alphaArrowId },
          quantity: options.alphaArrowQuantity ?? 1,
        }
      : { itemId: null, item: null },
    shield: options?.alphaShieldId
      ? { itemId: options.alphaShieldId, item: { id: options.alphaShieldId } }
      : { itemId: null, item: null },
  });
  equipment.set("agent-beta", {
    weapon: options?.betaWeaponId
      ? { itemId: options.betaWeaponId, item: { id: options.betaWeaponId } }
      : { itemId: null, item: null },
    arrows: options?.betaArrowId
      ? {
          itemId: options.betaArrowId,
          item: { id: options.betaArrowId },
          quantity: options.betaArrowQuantity ?? 1,
        }
      : { itemId: null, item: null },
    shield: options?.betaShieldId
      ? { itemId: options.betaShieldId, item: { id: options.betaShieldId } }
      : { itemId: null, item: null },
  });
  for (const extraAgent of options?.extraAgents ?? []) {
    const extra = createAgentEntity(
      extraAgent.id,
      extraAgent.name,
      extraAgent.position,
    );
    entities.set(extra.id, extra);
    equipment.set(extra.id, {
      weapon: { itemId: null, item: null },
      arrows: { itemId: null, item: null },
      shield: { itemId: null, item: null },
    });
  }

  inventories.set("agent-alpha", {
    items: [...(options?.alphaInventory ?? [])],
    coins: 0,
  });
  inventories.set("agent-beta", {
    items: [...(options?.betaInventory ?? [])],
    coins: 0,
  });
  for (const extraAgent of options?.extraAgents ?? []) {
    inventories.set(extraAgent.id, {
      items: [],
      coins: 0,
    });
  }

  const terrainHeight = options?.terrainHeight ?? 7.25;
  let emitFailuresRemaining =
    options?.failOnEmitEventCount ?? (options?.failOnEmitEvent ? 1 : 0);
  const damageByAttacker: Record<string, number> = {
    "agent-alpha": 8,
    "agent-beta": 1,
    ...(options?.damageByAttacker ?? {}),
  };

  const on = (event: string, fn: (payload: unknown) => void) => {
    const handlers =
      listeners.get(event) ?? new Set<(payload: unknown) => void>();
    handlers.add(fn);
    listeners.set(event, handlers);
  };

  const off = (event: string, fn: (payload: unknown) => void) => {
    listeners.get(event)?.delete(fn);
  };

  const emit = (event: string, payload: unknown) => {
    if (event === options?.failOnEmitEvent && emitFailuresRemaining > 0) {
      emitFailuresRemaining -= 1;
      throw new Error(`Injected event failure: ${event}`);
    }
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(payload);
    }
  };

  const getInventoryState = (playerId: string) => {
    const state = inventories.get(playerId);
    if (!state) {
      const empty = { items: [] as InventoryItem[], coins: 0 };
      inventories.set(playerId, empty);
      return empty;
    }
    return state;
  };

  const inventorySystem = {
    getInventory: (playerId: string) => {
      const state = getInventoryState(playerId);
      return {
        playerId,
        items: state.items,
        coins: state.coins,
      };
    },
    addItemDirect: async (
      playerId: string,
      item: { itemId: string; quantity: number; slot?: number },
    ) => {
      const state = getInventoryState(playerId);
      const existingStack = state.items.find(
        (entry) => entry.itemId === item.itemId,
      );
      if (existingStack && typeof item.slot !== "number") {
        existingStack.quantity += item.quantity;
        return true;
      }
      const usedSlots = new Set(state.items.map((entry) => entry.slot));
      const slot =
        typeof item.slot === "number"
          ? item.slot
          : Array.from({ length: 28 }, (_, i) => i).find(
              (candidate) => !usedSlots.has(candidate),
            );
      if (typeof slot !== "number" || usedSlots.has(slot)) {
        return false;
      }
      state.items.push({
        slot,
        itemId: item.itemId,
        quantity: item.quantity,
      });
      return true;
    },
    removeItem: async (data: {
      playerId: string;
      itemId: string;
      quantity: number;
      slot?: number;
    }) => {
      const state = getInventoryState(data.playerId);
      const index = state.items.findIndex((entry) => {
        if (typeof data.slot === "number") {
          return entry.slot === data.slot && entry.itemId === data.itemId;
        }
        return entry.itemId === data.itemId;
      });
      if (index < 0) return false;
      const entry = state.items[index];
      if (entry.quantity <= data.quantity) {
        state.items.splice(index, 1);
      } else {
        entry.quantity -= data.quantity;
      }
      return true;
    },
    isInventoryReady: () => true,
  };

  const equipmentSystem = {
    getPlayerEquipment: (playerId: string) => equipment.get(playerId),
    isEquipmentReady: (playerId: string) =>
      options?.equipmentReady?.(playerId) ?? true,
    recoverOwnedDuelPreparationPlan: async (
      playerId: string,
      request: { operationId: string; preparationId: string },
    ) => {
      recoverPreparationCalls.push({
        playerId,
        preparationId: request.preparationId,
      });
      const recovered = options?.recoverPreparationEquipment?.[playerId];
      const state = equipment.get(playerId);
      if (recovered && state) {
        state.weapon = {
          itemId: recovered.weaponId,
          item: { id: recovered.weaponId },
          quantity: 1,
        };
        state.arrows = recovered.arrowId
          ? {
              itemId: recovered.arrowId,
              item: { id: recovered.arrowId },
              quantity: recovered.arrowQuantity ?? 1,
            }
          : { itemId: null, item: null };
      }
      return {
        ok: true as const,
        playerId,
        operationId: request.operationId,
        preparationId: request.preparationId,
        requestFingerprint: "recovered-plan",
        changed: false,
        replayed: true,
        committed: {
          bank: [],
          inventory: [],
          equipment: [],
          selectedSpell: null,
        },
        recoveryEvidence: {},
      };
    },
    canPlayerEquipItem: () => true,
    equipItemDirect: async (
      playerId: string,
      itemId: string | number,
      quantity: number = 1,
    ) => {
      if ((options?.equipmentDelayMs ?? 0) > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, options!.equipmentDelayMs),
        );
      }
      const state = equipment.get(playerId);
      if (!state) {
        return {
          success: false,
          error: "Equipment not initialized",
          displacedItems: [],
        };
      }

      const normalizedItemId = String(itemId);
      equipCalls.push({ playerId, itemId: normalizedItemId, quantity });
      const slot = normalizedItemId.includes("arrow")
        ? "arrows"
        : normalizedItemId.includes("shield")
          ? "shield"
          : "weapon";
      const displaced = state[slot].itemId
        ? [
            {
              itemId: state[slot].itemId!,
              slot,
              quantity: state[slot].quantity ?? 1,
            },
          ]
        : [];
      state[slot] = {
        itemId: normalizedItemId,
        item: { id: normalizedItemId },
        quantity,
      };

      return {
        success: true,
        equippedSlot: slot,
        displacedItems: displaced,
      };
    },
    unequipItemDirect: async (
      playerId: string,
      slotName: "weapon" | "arrows" | "shield",
    ) => {
      const state = equipment.get(playerId);
      const slot = state?.[slotName];
      if (!state || !slot?.itemId) {
        return {
          success: false,
          error: "Slot is empty",
          quantity: 0,
        };
      }
      const itemId = slot.itemId;
      const quantity = slot.quantity ?? 1;
      state[slotName] = { itemId: null, item: null };
      return { success: true, itemId, quantity };
    },
  };

  const world = {
    entities: {
      items: entities,
      get: (id: string) => entities.get(id),
      getAllEntities: () => entities,
    },
    network: {
      send: vi.fn(),
      syncStreamingContestants: vi.fn(),
    },
    getPlayer: (id: string) => entities.get(id),
    on,
    off,
    emit,
    getSystem: (name: string) => {
      if (name === "player") {
        return {
          isPlayerReady: (playerId: string) =>
            options?.playerReady?.(playerId) ?? true,
        };
      }
      if (name === "processing" && options?.processingQuiescenceSystem) {
        return options.processingQuiescenceSystem;
      }

      if (name === "terrain") {
        return {
          getHeightAt: () => terrainHeight,
        };
      }

      if (name === "inventory") {
        return inventorySystem;
      }

      if (name === "equipment") {
        return equipmentSystem;
      }

      if (name === "combat") {
        return {
          startCombat: (
            attackerId: string,
            targetId: string,
            _options?: { attackerType?: string; targetType?: string },
          ) => {
            combatCalls.push({ attackerId, targetId });

            const attacker = entities.get(attackerId);
            const target = entities.get(targetId);
            if (!attacker || !target) {
              return false;
            }

            if ((attacker.data.health ?? 0) <= 0) {
              return false;
            }

            if ((target.data.health ?? 0) <= 0) {
              return false;
            }

            const attackerPosition = attacker.data.position;
            const targetPosition = target.data.position;
            const dx = Math.abs(
              Math.floor(attackerPosition[0]) - Math.floor(targetPosition[0]),
            );
            const dz = Math.abs(
              Math.floor(attackerPosition[2]) - Math.floor(targetPosition[2]),
            );
            if (options?.combatStarts === false || dx + dz !== 1) {
              return false;
            }

            combatState.add(attackerId);

            const damage = damageByAttacker[attackerId] ?? 1;
            const nextHealth = Math.max(0, (target.data.health ?? 0) - damage);
            target.data.health = nextHealth;
            target.data.inCombat = nextHealth > 0;
            target.data.combatTarget = attackerId;

            emit(EventType.ENTITY_DAMAGED, {
              attackerId,
              entityId: targetId,
              damage,
            });

            if (nextHealth <= 0) {
              emit(EventType.ENTITY_DEATH, {
                entityId: targetId,
                killedBy: attackerId,
              });
            }

            return true;
          },
          isInCombat: (entityId: string) => combatState.has(entityId),
          getDuelDamageReconciliationStats: () => ({
            pendingOperations: options?.duelDamagePending?.() === true ? 1 : 0,
          }),
          forceEndCombat: (entityId: string) => {
            forceEndCombatCalls.push(entityId);
            combatState.delete(entityId);
          },
        };
      }

      if (name === "database") {
        return null;
      }

      return null;
    },
  };

  return {
    world,
    entities,
    combatCalls,
    forceEndCombatCalls,
    equipCalls,
    recoverPreparationCalls,
    getInventory: (playerId: string) => getInventoryState(playerId),
    countFood: (playerId: string) =>
      getInventoryState(playerId).items.filter((item) =>
        isDuelFoodItemId(item.itemId),
      ).length,
    hasItemAtSlot: (playerId: string, slot: number, itemId: string) =>
      getInventoryState(playerId).items.some(
        (item) => item.slot === slot && item.itemId === itemId,
      ),
    getEquippedWeapon: (playerId: string) =>
      equipment.get(playerId)?.weapon.itemId ?? null,
    getEquipmentSlot: (playerId, slot) => {
      const value = equipment.get(playerId)?.[slot];
      return value ? { itemId: value.itemId, quantity: value.quantity } : null;
    },
    countItem: (playerId: string, itemId: string) =>
      getInventoryState(playerId)
        .items.filter((item) => item.itemId === itemId)
        .reduce((sum, item) => sum + item.quantity, 0),
    setDamageByAttacker: (playerId: string, damage: number) => {
      damageByAttacker[playerId] = damage;
    },
  };
}

/**
 * The scheduler now requires persisted participation authority before it will
 * admit ordinary agents discovered in the world. These database-free unit
 * worlds model agents whose positive preference was already applied by the
 * trusted DB/API boundary, so make that authority explicit before the first
 * competitive tick. Tests of the raw fail-closed boundary instantiate the
 * production class directly.
 */
class StreamingDuelScheduler extends ProductionStreamingDuelScheduler {
  private readonly eligibilityTestWorld: MockWorldContext["world"];

  constructor(
    world: ConstructorParameters<typeof ProductionStreamingDuelScheduler>[0],
  ) {
    super(world);
    this.eligibilityTestWorld = world as unknown as MockWorldContext["world"];
  }

  override init(): void {
    super.init();
    this.eligibilityTestWorld.network.send.mockClear();
    this.eligibilityTestWorld.network.syncStreamingContestants.mockClear();
    for (const [id, entity] of this.eligibilityTestWorld.entities.items) {
      if (
        entity.type === "player" &&
        (entity.isAgent === true ||
          entity.isEmbeddedAgent === true ||
          entity.data.isAgent === true ||
          entity.data.isEmbeddedAgent === true)
      ) {
        this.applyStreamingDuelParticipation(id, true);
      }
    }
    (this as unknown as { tick: () => void }).tick();
    (this as unknown as { broadcastState: () => void }).broadcastState();
  }
}

function collectCycleAbortEvents(ctx: MockWorldContext): unknown[] {
  const events: unknown[] = [];
  ctx.world.on("streaming:cycle:aborted", (payload) => {
    events.push(payload);
  });
  return events;
}

function expectAuthoritativeCycleAbort(
  events: unknown[],
  expected: {
    cycleId: string;
    duelId: string | null;
    duelKeyHex: string | null;
    reason: string;
    agent1Id: string | null;
    agent2Id: string | null;
  },
): void {
  expect(events).toEqual([
    expect.objectContaining({
      cycleId: expected.cycleId,
      duelId: expected.duelId,
      duelKeyHex: expected.duelKeyHex,
      reason: expected.reason,
      agent1Id: expected.agent1Id,
      agent2Id: expected.agent2Id,
    }),
  ]);
}

function expectContestantRestored(
  ctx: MockWorldContext,
  playerId: string,
  originalPosition: [number, number, number],
): void {
  const entity = ctx.entities.get(playerId);
  expect(entity, `${playerId} should still exist`).toBeDefined();
  expect(entity!.data.health).toBe(entity!.data.maxHealth);
  expect(entity!.data.alive).toBe(true);
  expect(entity!.data.position).toEqual(originalPosition);
  expect(entity!.data.inStreamingDuel).toBe(false);
  expect(entity!.data.preventRespawn).toBe(false);
  expect(entity!.data.arenaBounds).toBeNull();
  expect(entity!.data.inCombat).toBe(false);
  expect(entity!.data.c).toBe(false);
  expect(entity!.data.combatTarget).toBeNull();
  expect(entity!.data.ct).toBeNull();
  expect(entity!.data.attackTarget).toBeNull();
  expect(entity!.data.emote).toBe("idle");
}

describe("StreamingDuelScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const [itemId, prior] of recoveryItemPriors) {
      if (prior) ITEMS.set(itemId, prior as never);
      else ITEMS.delete(itemId);
    }
    recoveryItemPriors.clear();
  });

  it("cancels immediately when a selected contestant leaves during announcement", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const aborted = collectCycleAbortEvents(ctx);

    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("ANNOUNCEMENT");

    scheduler.unregisterAgent(cycle.agent1!.characterId);
    await scheduler.waitForShutdownCleanup();

    expectAuthoritativeCycleAbort(aborted, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "contestant_unavailable",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(scheduler.getStreamingState().terminalNotice).toMatchObject({
      cycleId: cycle.cycleId,
      outcome: "cancelled",
      reason: "contestant_unavailable",
    });
    expect(scheduler.getRecentDuels()[0]).toMatchObject({
      cycleId: cycle.cycleId,
      outcome: "cancelled",
      cancellationReason: "contestant_unavailable",
      winnerId: null,
      loserId: null,
    });

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("cancels instead of stalling when a contestant vanishes during asynchronous preparation", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const aborted = collectCycleAbortEvents(ctx);
    scheduler.init();

    const cycle = scheduler.getCurrentCycle()!;
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const prepare = vi
      .spyOn((scheduler as any).orchestrator, "prepareContestantsForDuel")
      .mockReturnValue(preparationGate);

    const countdown = startCountdownAtMarketClose(scheduler);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    ctx.entities.delete(cycle.agent2!.characterId);
    releasePreparation();
    await countdown;
    await scheduler.waitForShutdownCleanup();

    expectAuthoritativeCycleAbort(aborted, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "contestant_unavailable",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(scheduler.getRecentDuels()[0]).toMatchObject({
      cycleId: cycle.cycleId,
      outcome: "cancelled",
      cancellationReason: "contestant_unavailable",
      winnerId: null,
      loserId: null,
    });

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("settles a silently missing countdown contestant as a forfeit before duel-start publication", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const completed = vi.fn();
    const fightStarted = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    ctx.world.on("streaming:fight:start", fightStarted);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("COUNTDOWN");
    ctx.entities.delete(cycle.agent2!.characterId);

    await (scheduler as any).doStartFight(Date.now());

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.outcome).toBe("win");
    expect(cycle.winnerId).toBe(cycle.agent1!.characterId);
    expect(cycle.loserId).toBe(cycle.agent2!.characterId);
    expect(cycle.winReason).toBe("forfeit");
    expect(fightStarted).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        duelId: cycle.duelId,
        winnerId: cycle.agent1!.characterId,
        loserId: cycle.agent2!.characterId,
        reason: "forfeit",
        forfeit: true,
      }),
    );

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("publishes no missing-contestant forfeit until its competitive terminal commits", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const completed = vi.fn();
    const fightStarted = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    ctx.world.on("streaming:fight:start", fightStarted);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "3ee8eb1f-87d6-4707-b857-bb5d578290b5",
    };
    cycle.competitiveSnapshotDigest = "f1".repeat(32);

    let commitTerminal!: (value: { lifecycleStatus: "terminal" }) => void;
    const terminalCommit = new Promise<{ lifecycleStatus: "terminal" }>(
      (resolve) => {
        commitTerminal = resolve;
      },
    );
    const store = {
      markCompetitiveSnapshotTerminal: vi.fn(() => terminalCommit),
      markCompetitiveSnapshotRecovered: vi.fn(
        async ({ recoveredAt }: { recoveredAt: number }) => ({
          lifecycleStatus: "retired" as const,
          terminal: { terminalAt: recoveredAt - 1 },
          lockedAt: null,
          duelStartedAt: null,
          recoveredAt,
        }),
      ),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "73",
    });
    ctx.entities.delete(cycle.agent2!.characterId);

    await (scheduler as any).doStartFight(Date.now());

    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        preparationId: cycle.competitiveSnapshot.preparationId,
        fencingToken: "73",
        snapshotDigest: cycle.competitiveSnapshotDigest,
        terminal: expect.objectContaining({
          outcome: "win",
          winnerId: cycle.agent1!.characterId,
          winReason: "forfeit",
        }),
      }),
    );
    expect(cycle.phase).toBe("COUNTDOWN");
    expect(completed).not.toHaveBeenCalled();
    expect(fightStarted).not.toHaveBeenCalled();

    commitTerminal({ lifecycleStatus: "terminal" });
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.winnerId).toBe(cycle.agent1!.characterId);
    expect(cycle.winReason).toBe("forfeit");
    expect(fightStarted).not.toHaveBeenCalled();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("settles a silently missing fighting contestant once without waiting for timeout", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const completed = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("FIGHTING");
    ctx.entities.delete(cycle.agent2!.characterId);

    asSchedulerHarness(scheduler).tick();
    ctx.world.emit(EventType.PLAYER_LEFT, {
      playerId: cycle.agent2!.characterId,
    });

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.winnerId).toBe(cycle.agent1!.characterId);
    expect(cycle.winReason).toBe("forfeit");
    expect(completed).toHaveBeenCalledOnce();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("cancels malformed authoritative health without fabricating a result", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const aborted = collectCycleAbortEvents(ctx);
    const completed = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    const cycle = scheduler.getCurrentCycle()!;
    ctx.entities.get(cycle.agent2!.characterId)!.data.health = Number.NaN;

    await (scheduler as any).doStartFight(Date.now());
    await scheduler.waitForShutdownCleanup();

    expectAuthoritativeCycleAbort(aborted, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "contestant_health_invalid",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(completed).not.toHaveBeenCalled();
    expect(scheduler.getCurrentCycle()).toBeNull();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("grounds arena teleports and starts combat with HP loss", async () => {
    const ctx = createMockWorld({ terrainHeight: 12.5 });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();
    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");

    const announcementCycle = scheduler.getCurrentCycle()!;
    const announcedAgent1 = ctx.entities.get(
      announcementCycle.agent1!.characterId,
    );
    const announcedAgent2 = ctx.entities.get(
      announcementCycle.agent2!.characterId,
    );
    expect(announcedAgent1?.data.position[1]).toBe(12.5);
    expect(announcedAgent2?.data.position[1]).toBe(12.5);
    expect(scheduler.getCurrentCycle()?.arenaPositions).toEqual({
      agent1: announcedAgent1?.data.position,
      agent2: announcedAgent2?.data.position,
    });
    expect(
      Math.abs(
        Math.floor(announcedAgent1!.data.position[0]) -
          Math.floor(announcedAgent2!.data.position[0]),
      ) +
        Math.abs(
          Math.floor(announcedAgent1!.data.position[2]) -
            Math.floor(announcedAgent2!.data.position[2]),
        ),
    ).toBe(1);

    await startCountdownAtMarketClose(scheduler);

    const alpha = ctx.entities.get("agent-alpha");
    const beta = ctx.entities.get("agent-beta");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha!.data.position[1]).toBe(12.5);
    expect(beta!.data.position[1]).toBe(12.5);
    const countdownAlphaPosition = [...alpha!.data.position];
    const countdownBetaPosition = [...beta!.data.position];
    const countdownDx = Math.abs(
      Math.floor(alpha!.data.position[0]) - Math.floor(beta!.data.position[0]),
    );
    const countdownDz = Math.abs(
      Math.floor(alpha!.data.position[2]) - Math.floor(beta!.data.position[2]),
    );
    expect(countdownDx + countdownDz).toBe(1);
    expect(
      Math.hypot(
        alpha!.data.position[0] - beta!.data.position[0],
        alpha!.data.position[2] - beta!.data.position[2],
      ),
    ).toBeCloseTo(1.3, 5);

    await vi.advanceTimersByTimeAsync(4000);

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(scheduler.getCurrentCycle()?.arenaId).toBe(1);
    expect(ctx.combatCalls.length).toBeGreaterThanOrEqual(2);
    expect(alpha!.data.health).toBeLessThan(alpha!.data.maxHealth);
    expect(beta!.data.health).toBeLessThan(beta!.data.maxHealth);
    const schedulerInternal = scheduler as any;
    const publicActionAi = {
      getStats: () => ({
        tickCount: 7,
        combatRole: "melee",
        lastExecutedTacticalMacro: "pressure",
      }),
    };
    schedulerInternal.orchestrator.combatAIs.set("agent-alpha", publicActionAi);
    const damageContext =
      schedulerInternal.orchestrator.createAuthoritativeDamageObservationContext(
        "agent-alpha",
        "agent-beta",
        3,
      );
    expect(damageContext).toMatchObject({
      actorId: "agent-alpha",
      opponentId: "agent-beta",
      requestedDamage: 3,
      combatRole: "melee",
      tacticalMacro: "pressure",
    });
    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "agent-alpha",
      targetId: "agent-beta",
      damage: 3,
      publicActionObservation: damageContext,
    });
    schedulerInternal.orchestrator.combatAIs.delete("agent-alpha");
    const publicActions =
      scheduler.getStreamingState().cycle.actionObservations;
    expect(publicActions.length).toBeGreaterThan(0);
    expect(publicActions.map(({ sequence }) => sequence)).toEqual(
      publicActions.map((_, index) => index + 1),
    );
    expect(
      publicActions.every(
        (observation) =>
          observation.cycleId === scheduler.getCurrentCycle()?.cycleId &&
          observation.duelId === scheduler.getCurrentCycle()?.duelId &&
          observation.phase === "FIGHTING" &&
          !Object.prototype.hasOwnProperty.call(observation, "reasoning") &&
          !Object.prototype.hasOwnProperty.call(observation, "coordinates") &&
          !Object.prototype.hasOwnProperty.call(observation, "bank") &&
          !Object.prototype.hasOwnProperty.call(observation, "wallet") &&
          !Object.prototype.hasOwnProperty.call(observation, "rawError"),
      ),
    ).toBe(true);
    const dx = Math.abs(
      Math.floor(alpha!.data.position[0]) - Math.floor(beta!.data.position[0]),
    );
    const dz = Math.abs(
      Math.floor(alpha!.data.position[2]) - Math.floor(beta!.data.position[2]),
    );
    expect(dx + dz).toBe(1);
    expect(alpha!.data.position).toEqual(countdownAlphaPosition);
    expect(beta!.data.position).toEqual(countdownBetaPosition);

    scheduler.destroy();
  });

  it("publishes a co-committed lethal terminal without a second persistence edge", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const resolutionStarted = vi.fn();
    const duelCompleted = vi.fn();
    ctx.world.on("streaming:resolution:start", resolutionStarted);
    ctx.world.on(EventType.DUEL_COMPLETED, duelCompleted);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    const schedulerInternal = scheduler as any;
    schedulerInternal.orchestrator.combatAIs.set("agent-alpha", {
      getStats: () => ({
        tickCount: 23,
        combatRole: "melee",
        lastExecutedTacticalMacro: "finish",
      }),
    });
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "00000000-0000-4000-8000-000000000511",
    };
    cycle.competitiveSnapshotDigest = "ab".repeat(32);
    schedulerInternal.preparationFencingToken = "109";
    const authority = getStreamingDuelDamageAuthority(ctx.world as never);
    const commitAuthority = authority?.createDamageObservationContext(
      "agent-alpha",
      "agent-beta",
      4,
    );
    expect(commitAuthority).toMatchObject({
      publicActionObservation: {
        actorId: "agent-alpha",
        opponentId: "agent-beta",
        requestedDamage: 4,
      },
      competitiveAuthority: {
        preparationId: "00000000-0000-4000-8000-000000000511",
        fencingToken: "109",
        snapshotDigest: "ab".repeat(32),
      },
    });
    const observation = commitAuthority!.publicActionObservation;
    const proof = buildCompetitiveTerminalProof({
      duelId: cycle.duelId!,
      cycleId: cycle.cycleId,
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      winReason: "kill",
      fightStartedAt: cycle.fightStartTime!,
      finishedAt: observation.observedAt,
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      damageAgent1: cycle.agent1!.damageDealtThisFight + 4,
      damageAgent2: cycle.agent2!.damageDealtThisFight,
    });
    ctx.entities.get("agent-beta")!.data.health = 0;
    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "agent-alpha",
      targetId: "agent-beta",
      damage: 4,
      publicActionObservation: observation,
      competitiveTerminal: {
        outcome: "win",
        winnerId: "agent-alpha",
        loserId: "agent-beta",
        winReason: "kill",
        terminalAt: observation.observedAt,
        ...proof,
      },
    });

    expect(scheduler.getCurrentCycle()).toMatchObject({
      phase: "RESOLUTION",
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      outcome: "win",
      seed: proof.seed,
      replayHash: proof.replayHash,
    });
    expect(resolutionStarted).toHaveBeenCalledOnce();
    expect(duelCompleted).toHaveBeenCalledOnce();
    ctx.world.emit(EventType.ENTITY_DEATH, {
      entityId: "agent-beta",
      killedBy: "agent-alpha",
    });
    await Promise.resolve();
    expect(resolutionStarted).toHaveBeenCalledOnce();
    expect(duelCompleted).toHaveBeenCalledOnce();

    cycle.competitiveSnapshot.persisted = false;
    schedulerInternal.orchestrator.combatAIs.delete("agent-alpha");
    scheduler.destroy();
  });

  it("does not race the fighting watchdog against an unresolved exact damage commit", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    const abortEvents = collectCycleAbortEvents(ctx);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("FIGHTING");
    cycle.competitiveSnapshot!.persisted = false;
    (scheduler as any).orchestrator.combatAIs.set("agent-alpha", {
      getStats: () => ({
        tickCount: 9,
        combatRole: "melee",
        lastExecutedTacticalMacro: "pressure",
      }),
    });
    const authority = getStreamingDuelDamageAuthority(ctx.world as never)!;
    const commitAuthority = authority.createDamageObservationContext(
      "agent-alpha",
      "agent-beta",
      4,
    );
    expect(commitAuthority).not.toBeNull();
    authority.handleDamageCommitStarted(
      commitAuthority!.publicActionObservation,
    );
    cycle.phaseStartTime = Date.now() - 10_000_000;

    harness.tick();
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(abortEvents).toHaveLength(0);

    (scheduler as any).orchestrator.combatAIs.delete("agent-alpha");
    authority.handleDamageCommitSettled(
      commitAuthority!.publicActionObservation,
    );
    await vi.advanceTimersByTimeAsync(0);
    harness.tick();
    await Promise.resolve();
    await Promise.resolve();
    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "watchdog_fighting_timeout",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });

    scheduler.destroy();
  });

  it("defers a committed lethal presentation until every authored hit settles", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const resolutionStarted = vi.fn();
    ctx.world.on("streaming:resolution:start", resolutionStarted);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot!.persisted = false;
    (scheduler as any).orchestrator.combatAIs.set("agent-alpha", {
      getStats: () => ({
        tickCount: 10,
        combatRole: "melee",
        lastExecutedTacticalMacro: "finish",
      }),
    });
    const authority = getStreamingDuelDamageAuthority(ctx.world as never)!;
    const commitAuthority = authority.createDamageObservationContext(
      "agent-alpha",
      "agent-beta",
      4,
    )!;
    authority.handleDamageCommitStarted(
      commitAuthority.publicActionObservation,
    );
    const proof = buildCompetitiveTerminalProof({
      duelId: cycle.duelId!,
      cycleId: cycle.cycleId,
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      winReason: "kill",
      fightStartedAt: cycle.fightStartTime!,
      finishedAt: commitAuthority.publicActionObservation.observedAt,
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      damageAgent1: cycle.agent1!.damageDealtThisFight + 4,
      damageAgent2: cycle.agent2!.damageDealtThisFight,
    });
    ctx.entities.get("agent-beta")!.data.health = 0;
    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "agent-alpha",
      targetId: "agent-beta",
      damage: 4,
      publicActionObservation: commitAuthority.publicActionObservation,
      competitiveTerminal: {
        outcome: "win",
        winnerId: "agent-alpha",
        loserId: "agent-beta",
        winReason: "kill",
        terminalAt: commitAuthority.publicActionObservation.observedAt,
        ...proof,
      },
    });

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(resolutionStarted).not.toHaveBeenCalled();

    authority.handleDamageCommitSettled(
      commitAuthority.publicActionObservation,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getCurrentCycle()).toMatchObject({
      phase: "RESOLUTION",
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      outcome: "win",
    });
    expect(resolutionStarted).toHaveBeenCalledOnce();

    (scheduler as any).orchestrator.combatAIs.delete("agent-alpha");
    scheduler.destroy();
  });

  it("upgrades a death-first damage fence with the exact atomic terminal receipt", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const resolutionStarted = vi.fn();
    ctx.world.on("streaming:resolution:start", resolutionStarted);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot!.persisted = false;
    (scheduler as any).orchestrator.combatAIs.set("agent-alpha", {
      getStats: () => ({
        tickCount: 12,
        engagementAttempts: 1,
        engagementAccepts: 1,
        engagementRejects: 0,
        engagementErrors: 0,
        lastEngagementFailureReason: null,
        styleChangeAttempts: 1,
        styleChangeAccepts: 1,
        styleChangeRejects: 0,
        styleChangeErrors: 0,
        lastStyleChangeFailureReason: null,
        foodUseAttempts: 0,
        foodDisengageYields: 0,
        totalDamageDealt: 4,
        totalDamageReceived: 0,
        movementRequests: 1,
        movementAccepts: 1,
        movementRejects: 0,
        movementErrors: 0,
        lastMovementFailureReason: null,
        movementPathsActive: 1,
        movementPathsInactive: 0,
        minObservedDistance: 2,
        maxObservedDistance: 4,
        plannedTacticalMacro: "finish",
        combatRole: "ranged",
        lastExecutedTacticalMacro: "finish",
        roleSwitchAttempts: 0,
        roleSwitchDeferrals: 0,
        successfulRoleSwitches: 0,
        roleSwitchFailures: 0,
        lastRoleSwitchFailureReason: null,
        lastObservedOpponentWeapon: null,
        lastObservedOpponentAttackType: null,
        prayerToggleAttempts: 0,
        prayerToggleCommits: 0,
        prayerToggleRejects: 0,
        lastPrayerToggleFailureReason: null,
      }),
      stopAndWaitForIdle: vi.fn(async () => undefined),
    });
    const authority = getStreamingDuelDamageAuthority(ctx.world as never)!;
    const commitAuthority = authority.createDamageObservationContext(
      "agent-alpha",
      "agent-beta",
      4,
    )!;
    authority.handleDamageCommitStarted(
      commitAuthority.publicActionObservation,
    );
    const proof = buildCompetitiveTerminalProof({
      duelId: cycle.duelId!,
      cycleId: cycle.cycleId,
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      winReason: "kill",
      fightStartedAt: cycle.fightStartTime!,
      finishedAt: commitAuthority.publicActionObservation.observedAt,
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      damageAgent1: cycle.agent1!.damageDealtThisFight + 4,
      damageAgent2: cycle.agent2!.damageDealtThisFight,
    });
    ctx.entities.get("agent-beta")!.data.health = 0;

    // PlayerSystem publishes death before CombatSystem publishes the matching
    // damage receipt. Let that microtask establish the plain sporting result.
    ctx.world.emit(EventType.ENTITY_DEATH, {
      entityId: "agent-beta",
      killedBy: "agent-alpha",
    });
    await Promise.resolve();
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    // The atomic damage event carries the terminal identity that was already
    // committed in the same PostgreSQL transaction as lethal HP mutation.
    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "agent-alpha",
      targetId: "agent-beta",
      damage: 4,
      publicActionObservation: commitAuthority.publicActionObservation,
      competitiveTerminal: {
        outcome: "win",
        winnerId: "agent-alpha",
        loserId: "agent-beta",
        winReason: "kill",
        terminalAt: commitAuthority.publicActionObservation.observedAt,
        ...proof,
      },
    });
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    authority.handleDamageCommitSettled(
      commitAuthority.publicActionObservation,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getCurrentCycle()).toMatchObject({
      phase: "RESOLUTION",
      phaseStartTime: commitAuthority.publicActionObservation.observedAt,
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      outcome: "win",
      seed: proof.seed,
      replayHash: proof.replayHash,
    });
    expect(resolutionStarted).toHaveBeenCalledOnce();

    scheduler.destroy();
  });

  it("keeps a settled projectile fenced through its next-turn terminal receipt", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const resolutionStarted = vi.fn();
    ctx.world.on("streaming:resolution:start", resolutionStarted);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "31450f15-4fbd-41ce-a914-5f68b42df288",
    };
    cycle.competitiveSnapshotDigest = "fa".repeat(32);
    const markCompetitiveSnapshotTerminal = vi.fn(async () => {
      throw new Error("redundant terminal persistence must not run");
    });
    Object.assign(scheduler as unknown as Record<string, unknown>, {
      preparationStore: { markCompetitiveSnapshotTerminal },
      preparationFencingToken: "119",
    });
    const orchestrator = (
      scheduler as unknown as {
        orchestrator: {
          combatAIs: Map<
            string,
            {
              getStats(): {
                tickCount: number;
                combatRole: "ranged";
                lastExecutedTacticalMacro: "finish";
              };
              stopAndWaitForIdle(): Promise<void>;
            }
          >;
        };
      }
    ).orchestrator;
    orchestrator.combatAIs.set("agent-alpha", {
      getStats: () => ({
        tickCount: 19,
        combatRole: "ranged",
        lastExecutedTacticalMacro: "finish",
      }),
      stopAndWaitForIdle: vi.fn(async () => undefined),
    });
    const authority = getStreamingDuelDamageAuthority(ctx.world as never)!;
    const commitAuthority = authority.createDamageObservationContext(
      "agent-alpha",
      "agent-beta",
      4,
    )!;
    authority.handleDamageCommitStarted(
      commitAuthority.publicActionObservation,
    );
    const observation = commitAuthority.publicActionObservation;
    const proof = buildCompetitiveTerminalProof({
      duelId: cycle.duelId!,
      cycleId: cycle.cycleId,
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      winReason: "kill",
      fightStartedAt: cycle.fightStartTime!,
      finishedAt: observation.observedAt,
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      damageAgent1: cycle.agent1!.damageDealtThisFight + 4,
      damageAgent2: cycle.agent2!.damageDealtThisFight,
    });
    ctx.entities.get("agent-beta")!.data.health = 0;

    // The combat promise can settle one microtask before its projectile caller
    // emits the co-committed receipt. The scheduler must retain the fence until
    // the next task turn instead of manufacturing a second terminal write.
    authority.handleDamageCommitSettled(observation);
    ctx.world.emit(EventType.ENTITY_DEATH, {
      entityId: "agent-beta",
      killedBy: "agent-alpha",
    });
    await Promise.resolve();
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "agent-alpha",
      targetId: "agent-beta",
      damage: 4,
      publicActionObservation: observation,
      competitiveTerminal: {
        outcome: "win",
        winnerId: "agent-alpha",
        loserId: "agent-beta",
        winReason: "kill",
        terminalAt: observation.observedAt,
        ...proof,
      },
    });
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getCurrentCycle()).toMatchObject({
      phase: "RESOLUTION",
      winnerId: "agent-alpha",
      loserId: "agent-beta",
      seed: proof.seed,
      replayHash: proof.replayHash,
    });
    expect(markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect(resolutionStarted).toHaveBeenCalledOnce();

    cycle.competitiveSnapshot.persisted = false;
    orchestrator.combatAIs.delete("agent-alpha");
    scheduler.destroy();
  });

  it("defers cancellation and contestant restoration behind the same damage fence", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot!.persisted = false;
    (scheduler as any).orchestrator.combatAIs.set("agent-alpha", {
      getStats: () => ({
        tickCount: 11,
        combatRole: "melee",
        lastExecutedTacticalMacro: "pressure",
      }),
    });
    const authority = getStreamingDuelDamageAuthority(ctx.world as never)!;
    const commitAuthority = authority.createDamageObservationContext(
      "agent-alpha",
      "agent-beta",
      4,
    )!;
    authority.handleDamageCommitStarted(
      commitAuthority.publicActionObservation,
    );
    (scheduler as any).orchestrator.combatAIs.delete("agent-alpha");

    const abortPromise = (
      scheduler as unknown as {
        abortCycleToIdle: (reason: string) => Promise<void>;
      }
    ).abortCycleToIdle("damage_reconciliation_test");
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(abortEvents).toHaveLength(0);

    authority.handleDamageCommitSettled(
      commitAuthority.publicActionObservation,
    );
    await vi.advanceTimersByTimeAsync(0);
    await abortPromise;
    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "damage_reconciliation_test",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });

    scheduler.destroy();
  });

  it("broadcasts streaming state immediately on init", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();

    expect(ctx.world.network.send).toHaveBeenCalledWith(
      "streamingState",
      expect.any(Object),
    );
    const cycle = scheduler.getCurrentCycle();
    const publicState = scheduler.getStreamingState();
    const committedContestants = cycle?.competitiveSnapshot?.contestants ?? [];
    for (const publicAgent of [
      publicState.cycle.agent1,
      publicState.cycle.agent2,
    ]) {
      expect(publicAgent?.loadoutFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(publicAgent?.loadoutFingerprint).toBe(
        committedContestants.find(
          (contestant) => contestant.agentId === publicAgent?.id,
        )?.loadoutFingerprint,
      );
      expect(publicAgent?.strategySummary).toMatchObject({
        schemaVersion: 1,
        approach: "balanced",
        attackStyle: "aggressive",
        source: "diagnostic",
        policyVersion: "diagnostic-v1",
      });
      expect(Object.keys(publicAgent?.strategySummary ?? {}).sort()).toEqual([
        "approach",
        "attackStyle",
        "foodThreshold",
        "policyVersion",
        "prayer",
        "preferredCombatRole",
        "schemaVersion",
        "source",
        "switchDefensiveAt",
        "tacticalMacro",
      ]);
      expect(publicAgent?.strategySummary).not.toHaveProperty("reasoning");
      expect(publicAgent?.strategySummary).not.toHaveProperty(
        "agentPolicyFingerprint",
      );
    }
    expect(ctx.world.network.syncStreamingContestants).toHaveBeenCalledWith([
      cycle?.agent1?.characterId,
      cycle?.agent2?.characterId,
    ]);
    (scheduler as unknown as { broadcastState: () => void }).broadcastState();
    const socketState = ctx.world.network.send.mock.calls
      .filter(([event]) => event === "streamingState")
      .at(-1)?.[1] as StreamingStateUpdate | undefined;
    expect(socketState?.cycle.competitiveSnapshot).toBeNull();
    expect(socketState?.cycle.agent1?.strategySummary).toEqual(
      publicState.cycle.agent1?.loadoutFrozen
        ? publicState.cycle.agent1.strategySummary
        : null,
    );
    expect(
      ctx.world.network.syncStreamingContestants.mock.invocationCallOrder[0],
    ).toBeLessThan(ctx.world.network.send.mock.invocationCallOrder[0]);

    expect(ctx.world.network.syncStreamingContestants).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });

  it("does not emit a market event for unprepared production contestants", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const ctx = createMockWorld();
    const scheduled: unknown[] = [];
    ctx.world.on("duel:scheduled", (payload) => scheduled.push(payload));
    const scheduler = new ProductionStreamingDuelScheduler(ctx.world as never);

    try {
      scheduler.init();
      expect(scheduler.getCurrentCycle()).toBeNull();
      expect(scheduled).toEqual([]);
    } finally {
      scheduler.destroy();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("uses one immutable announcement/market close boundary through countdown", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();
    const announcementCycle = scheduler.getCurrentCycle()!;
    const immutableCloseTime = announcementCycle.betCloseTime;
    const immutableFightStartTime = announcementCycle.fightStartTime;
    expect(immutableCloseTime).toBe(
      announcementCycle.phaseStartTime + STREAMING_TIMING.ANNOUNCEMENT_DURATION,
    );
    expect(immutableFightStartTime).toBe(
      immutableCloseTime! + STREAMING_TIMING.COUNTDOWN_DURATION,
    );
    expect(scheduler.getStreamingState().cycle.phaseEndTime).toBe(
      immutableCloseTime,
    );
    expect(scheduler.getStreamingState().cycle.timeRemaining).toBe(
      STREAMING_TIMING.ANNOUNCEMENT_DURATION,
    );

    vi.setSystemTime(immutableCloseTime!);
    await startCountdownAtMarketClose(scheduler);
    expect(scheduler.getCurrentCycle()).toMatchObject({
      phase: "COUNTDOWN",
      betCloseTime: immutableCloseTime,
      fightStartTime: immutableFightStartTime,
    });
    expect(scheduler.getStreamingState().cycle.betCloseTime).toBe(
      immutableCloseTime,
    );

    scheduler.destroy();
  });

  it("persists market lock before countdown and duel start before combat", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "8d61de9b-181f-4b3e-b22b-a88b37d345be",
    };
    cycle.competitiveSnapshotDigest = "ab".repeat(32);
    const store = {
      markCompetitiveSnapshotLocked: vi.fn(async ({ lockedAt }: any) => ({
        lifecycleStatus: "frozen",
        lockedAt,
        duelStartedAt: null,
        recoveredAt: null,
      })),
      markCompetitiveSnapshotDuelStarted: vi.fn(
        async ({ duelStartedAt }: any) => ({
          lifecycleStatus: "frozen",
          lockedAt: cycle.betCloseTime,
          duelStartedAt,
          recoveredAt: null,
        }),
      ),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "55",
    });
    const orchestratorStart = vi.spyOn(
      (scheduler as any).orchestrator,
      "startFight",
    );

    const immutableFightStartTime = cycle.fightStartTime;
    expect(immutableFightStartTime).toBe(
      cycle.betCloseTime! + STREAMING_TIMING.COUNTDOWN_DURATION,
    );
    vi.setSystemTime(cycle.betCloseTime!);
    await startCountdownAtMarketClose(scheduler);
    expect(store.markCompetitiveSnapshotLocked).toHaveBeenCalledWith({
      preparationId: cycle.competitiveSnapshot.preparationId,
      fencingToken: "55",
      snapshotDigest: cycle.competitiveSnapshotDigest,
      lockedAt: cycle.betCloseTime,
    });
    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");

    expect(scheduler.getCurrentCycle()?.fightStartTime).toBe(
      immutableFightStartTime,
    );

    await (scheduler as any).doStartFight(immutableFightStartTime);
    expect(store.markCompetitiveSnapshotDuelStarted).toHaveBeenCalledOnce();
    expect(store.markCompetitiveSnapshotDuelStarted).toHaveBeenCalledWith({
      preparationId: cycle.competitiveSnapshot.preparationId,
      fencingToken: "55",
      snapshotDigest: cycle.competitiveSnapshotDigest,
      duelStartedAt: immutableFightStartTime,
    });
    expect(
      store.markCompetitiveSnapshotDuelStarted.mock.invocationCallOrder[0],
    ).toBeLessThan(orchestratorStart.mock.invocationCallOrder[0]!);
    expect(orchestratorStart).toHaveBeenCalledWith(immutableFightStartTime);
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(scheduler.getCurrentCycle()?.phaseStartTime).toBe(
      immutableFightStartTime,
    );
    expect(scheduler.getCurrentCycle()?.fightStartTime).toBe(
      immutableFightStartTime,
    );
    expect(scheduler.getStreamingState().cycle.phaseEndTime).toBe(
      immutableFightStartTime! +
        STREAMING_TIMING.FIGHTING_DURATION +
        STREAMING_TIMING.END_WARNING_DURATION,
    );

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("does not extend the immutable fight deadline after delayed start persistence", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "18ac9328-1642-4999-a8a8-2aa847d14ff0",
    };
    cycle.competitiveSnapshotDigest = "cd".repeat(32);
    const store = {
      markCompetitiveSnapshotLocked: vi.fn(async ({ lockedAt }: any) => ({
        lifecycleStatus: "frozen",
        lockedAt,
        duelStartedAt: null,
        recoveredAt: null,
      })),
      markCompetitiveSnapshotDuelStarted: vi.fn(
        async ({ duelStartedAt }: any) => {
          vi.setSystemTime(duelStartedAt + 2_000);
          return {
            lifecycleStatus: "frozen",
            lockedAt: cycle.betCloseTime,
            duelStartedAt,
            recoveredAt: null,
          };
        },
      ),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "89",
    });

    await startCountdownAtMarketClose(scheduler);
    const immutableFightStartTime =
      scheduler.getCurrentCycle()!.fightStartTime!;
    await (scheduler as any).doStartFight(immutableFightStartTime);

    const fighting = scheduler.getCurrentCycle()!;
    expect(fighting.phase).toBe("FIGHTING");
    expect(fighting.fightStartTime).toBe(immutableFightStartTime);
    expect(fighting.phaseStartTime).toBe(immutableFightStartTime);
    expect(scheduler.getStreamingState().cycle.timeRemaining).toBe(
      STREAMING_TIMING.FIGHTING_DURATION +
        STREAMING_TIMING.END_WARNING_DURATION -
        2_000,
    );
    expect(scheduler.getStreamingState().cycle.phaseEndTime).toBe(
      immutableFightStartTime +
        STREAMING_TIMING.FIGHTING_DURATION +
        STREAMING_TIMING.END_WARNING_DURATION,
    );

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("fails closed before countdown when the durable lock edge is rejected", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "1b4a2e51-6f6f-4ca9-b238-99677bdc9ab2",
    };
    cycle.competitiveSnapshotDigest = "cd".repeat(32);
    const store = {
      markCompetitiveSnapshotLocked: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "56",
    });
    const aborts = collectCycleAbortEvents(ctx);

    await startCountdownAtMarketClose(scheduler);
    await vi.waitFor(() => expect(aborts).toHaveLength(1));

    expect(aborts[0]).toMatchObject({
      cycleId: cycle.cycleId,
      reason: "competitive_lifecycle_persistence_failed",
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("coalesces terminal persistence retries into one cycle-bound timer", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    if ((scheduler as any).tickInterval) {
      clearInterval((scheduler as any).tickInterval);
      (scheduler as any).tickInterval = null;
    }
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "07d3966e-9d5f-416e-9808-c60ec0a7f0c2",
    };
    cycle.competitiveSnapshotDigest = "ed".repeat(32);
    const store = {
      markCompetitiveSnapshotTerminal: vi.fn(async () => {
        throw new Error("temporary database outage");
      }),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "59",
    });

    (scheduler as any).abortCycleToIdle("operator_cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce();

    for (let attempt = 0; attempt < 20; attempt++) {
      (scheduler as any).abortCycleToIdle("operator_cancelled");
    }
    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledTimes(2);

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("keeps shutdown pending through terminal commit, contestant cleanup, and recovery retirement", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "e6897113-015b-4a19-b8bf-f0c50fcd26c1",
    };
    cycle.competitiveSnapshotDigest = "ec".repeat(32);
    const store = {
      markCompetitiveSnapshotTerminal: vi.fn(async ({ terminal }: any) => ({
        lifecycleStatus: "terminal",
        terminal,
        lockedAt: null,
        duelStartedAt: null,
        recoveredAt: null,
      })),
      markCompetitiveSnapshotRecovered: vi.fn(async ({ recoveredAt }: any) => ({
        lifecycleStatus: "retired",
        terminal: { terminalAt: recoveredAt - 1 },
        lockedAt: null,
        duelStartedAt: null,
        recoveredAt,
      })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "60",
    });
    const cleanup = vi
      .spyOn((scheduler as any).orchestrator, "cleanupAfterAbort")
      .mockResolvedValue(undefined);

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();

    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalled();
    expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledOnce();
    expect(
      store.markCompetitiveSnapshotTerminal.mock.invocationCallOrder[0],
    ).toBeLessThan(cleanup.mock.invocationCallOrder[0]!);
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      store.markCompetitiveSnapshotRecovered.mock.invocationCallOrder[0]!,
    );
  });

  it("retires terminal restart replay only after contestant recovery completes", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "178407d7-fe52-4ad8-bc32-42966372fdb7",
    };
    cycle.competitiveSnapshotDigest = "ef".repeat(32);
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    vi.spyOn(
      (scheduler as any).orchestrator,
      "cleanupAfterAbort",
    ).mockReturnValue(cleanup);
    const store = {
      markCompetitiveSnapshotTerminal: vi.fn(async ({ terminal }: any) => ({
        lifecycleStatus: "terminal",
        terminal,
        lockedAt: null,
        duelStartedAt: null,
        recoveredAt: null,
      })),
      markCompetitiveSnapshotRecovered: vi.fn(async ({ recoveredAt }: any) => ({
        lifecycleStatus: "retired",
        terminal: { terminalAt: recoveredAt - 1 },
        lockedAt: null,
        duelStartedAt: null,
        recoveredAt,
      })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "57",
    });

    (scheduler as any).abortCycleToIdle("operator_cancelled");
    await vi.waitFor(() =>
      expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(
        (scheduler as any).orchestrator.cleanupAfterAbort,
      ).toHaveBeenCalledOnce(),
    );
    expect(store.markCompetitiveSnapshotRecovered).not.toHaveBeenCalled();

    releaseCleanup();
    await scheduler.waitForShutdownCleanup();
    expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledWith({
      preparationId: cycle.competitiveSnapshot.preparationId,
      fencingToken: "57",
      snapshotDigest: cycle.competitiveSnapshotDigest,
      recoveredAt: expect.any(Number),
    });

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("retries the exact recovery edge and blocks a newer cycle until it commits", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.competitiveSnapshot = {
      ...cycle.competitiveSnapshot!,
      persisted: true,
      preparationId: "cf36c8ce-c889-4850-afbe-1d296af59956",
    };
    cycle.competitiveSnapshotDigest = "fa".repeat(32);
    vi.spyOn(
      (scheduler as any).orchestrator,
      "cleanupAfterAbort",
    ).mockResolvedValue(undefined);
    let recoveryAttempts = 0;
    const store = {
      markCompetitiveSnapshotTerminal: vi.fn(async ({ terminal }: any) => ({
        lifecycleStatus: "terminal",
        terminal,
        lockedAt: null,
        duelStartedAt: null,
        recoveredAt: null,
      })),
      markCompetitiveSnapshotRecovered: vi.fn(async ({ recoveredAt }: any) => {
        recoveryAttempts++;
        if (recoveryAttempts === 1) return null;
        return {
          lifecycleStatus: "retired",
          terminal: { terminalAt: recoveredAt - 1 },
          lockedAt: null,
          duelStartedAt: null,
          recoveredAt,
        };
      }),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "58",
      competitiveRecoveryChecked: true,
    });
    (scheduler as any).abortCycleToIdle("operator_cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledOnce();
    const firstRecoveredAt =
      store.markCompetitiveSnapshotRecovered.mock.calls[0]![0].recoveredAt;
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect((scheduler as any)._endCycleInProgress).toBe(true);
    expect(scheduler.getOperationalMetrics().current.recoveryInProgress).toBe(
      true,
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledOnce();
    expect(scheduler.getCurrentCycle()).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await scheduler.waitForShutdownCleanup();
    expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledTimes(2);
    expect(
      store.markCompetitiveSnapshotRecovered.mock.calls[1]![0].recoveredAt,
    ).toBe(firstRecoveredAt);
    expect((scheduler as any)._endCycleInProgress).toBe(false);
    expect(scheduler.getOperationalMetrics().current.recoveryInProgress).toBe(
      false,
    );
    expect((scheduler as any).competitiveRecoveryChecked).toBe(false);

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("re-engages combat within ~3 seconds during fight loop", async () => {
    const ctx = createMockWorld({
      damageByAttacker: {
        "agent-alpha": 0,
        "agent-beta": 0,
      },
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    const baselineCalls = ctx.combatCalls.length;
    expect(baselineCalls).toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(3500);
    expect(ctx.combatCalls.length).toBeGreaterThan(baselineCalls);

    scheduler.destroy();
  });

  it("reasserts mutual spectator facing throughout an active duel tick", async () => {
    const ctx = createMockWorld({
      damageByAttacker: {
        "agent-alpha": 0,
        "agent-beta": 0,
      },
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const faceTargets: unknown[] = [];
    ctx.world.on(EventType.COMBAT_FACE_TARGET, (payload) => {
      faceTargets.push(payload);
    });

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const fightingCycle = scheduler.getCurrentCycle();
    expect(fightingCycle?.phase).toBe("FIGHTING");
    const firstId = fightingCycle!.agent1!.characterId;
    const secondId = fightingCycle!.agent2!.characterId;

    faceTargets.length = 0;
    await vi.advanceTimersByTimeAsync(600);

    expect(faceTargets).toEqual([
      { playerId: firstId, targetId: secondId },
      { playerId: secondId, targetId: firstId },
    ]);

    scheduler.destroy();
  });

  it("publishes mutual spectator facing at the fight boundary", async () => {
    const ctx = createMockWorld({
      damageByAttacker: {
        "agent-alpha": 0,
        "agent-beta": 0,
      },
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const faceTargets: unknown[] = [];
    ctx.world.on(EventType.COMBAT_FACE_TARGET, (payload) => {
      faceTargets.push(payload);
    });

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    const countdownCycle = scheduler.getCurrentCycle()!;
    const firstId = countdownCycle.agent1!.characterId;
    const secondId = countdownCycle.agent2!.characterId;

    faceTargets.length = 0;
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(faceTargets).toContainEqual({
      playerId: firstId,
      targetId: secondId,
    });
    expect(faceTargets).toContainEqual({
      playerId: secondId,
      targetId: firstId,
    });

    scheduler.destroy();
  });

  it("only publishes stream item icons present in the served asset package", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const orchestrator = (scheduler as any).orchestrator;
    const presentItemId = "stream_test_icon_present";
    const missingItemId = "stream_test_icon_missing";
    ITEMS.set(presentItemId, {
      id: presentItemId,
      name: "Present stream icon",
      iconPath: "asset://icons/longsword-bronze.svg",
    } as never);
    ITEMS.set(missingItemId, {
      id: missingItemId,
      name: "Missing stream icon",
      iconPath: "asset://icons/chaos-rune.png",
    } as never);

    try {
      const iconPaths = orchestrator.buildItemIconPathsForLoadout(
        { weapon: presentItemId },
        [{ itemId: missingItemId, quantity: 100 }],
      );

      expect(iconPaths).toEqual({
        [presentItemId]: "asset://icons/longsword-bronze.svg",
      });
    } finally {
      ITEMS.delete(presentItemId);
      ITEMS.delete(missingItemId);
      scheduler.destroy();
    }
  });

  it("keeps current and maximum HP synchronized on immediate damage events", async () => {
    const ctx = createMockWorld({
      damageByAttacker: {
        "agent-alpha": 0,
        "agent-beta": 0,
      },
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);
    const cycle = scheduler.getCurrentCycle()!;
    const alpha = ctx.entities.get("agent-alpha")!;
    alpha.data.health = 54;
    alpha.data.maxHealth = 55;

    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "ambient-attacker",
      entityId: "ambient-target",
      damage: 99,
    });
    expect(cycle.firstHitAt).toBeNull();

    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "agent-beta",
      entityId: "agent-alpha",
      damage: 1,
    });

    const alphaContestant =
      cycle.agent1?.characterId === "agent-alpha" ? cycle.agent1 : cycle.agent2;
    expect(alphaContestant).toMatchObject({ currentHp: 54, maxHp: 55 });
    const betaContestant =
      cycle.agent1?.characterId === "agent-beta" ? cycle.agent1 : cycle.agent2;
    expect(betaContestant?.attacksLanded).toBe(1);
    expect(cycle.firstHitAt).toBeTypeOf("number");
    expect(cycle.firstHitAt).toBeGreaterThanOrEqual(cycle.fightStartTime!);
    const publicCycle = scheduler.getStreamingState().cycle;
    expect(publicCycle.firstHitAt).toBe(cycle.firstHitAt);
    const publicBeta =
      publicCycle.agent1?.id === "agent-beta"
        ? publicCycle.agent1
        : publicCycle.agent2;
    expect(publicBeta).toMatchObject({
      attacksLanded: 1,
      damageDealtThisFight: 1,
      highestHit: 1,
    });
    const firstHitAt = cycle.firstHitAt;
    await vi.advanceTimersByTimeAsync(500);
    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: "agent-beta",
      entityId: "agent-alpha",
      damage: 1,
    });
    expect(cycle.firstHitAt).toBe(firstHitAt);
    scheduler.destroy();
  });

  it("counts only authoritative positive healing and synchronizes it immediately", async () => {
    const ctx = createMockWorld({
      damageByAttacker: {
        "agent-alpha": 0,
        "agent-beta": 0,
      },
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);
    const cycle = scheduler.getCurrentCycle()!;
    const alphaContestant =
      cycle.agent1?.characterId === "agent-alpha" ? cycle.agent1 : cycle.agent2;
    alphaContestant!.currentHp = 7;
    alphaContestant!.maxHp = 20;

    ctx.world.emit(EventType.ENTITY_HEALED, {
      entityId: "agent-alpha",
      healAmount: 5,
      newHealth: 12,
    });
    ctx.world.emit(EventType.ENTITY_HEALED, {
      entityId: "agent-alpha",
      healAmount: 0,
      newHealth: 12,
    });
    ctx.world.emit(EventType.ENTITY_HEALED, {
      entityId: "not-a-contestant",
      healAmount: 5,
      newHealth: 10,
    });

    expect(alphaContestant).toMatchObject({
      currentHp: 12,
      maxHp: 20,
      healsUsed: 1,
    });
    const publicCycle = scheduler.getStreamingState().cycle;
    const publicAlpha =
      publicCycle.agent1?.id === "agent-alpha"
        ? publicCycle.agent1
        : publicCycle.agent2;
    expect(publicAlpha).toMatchObject({ hp: 12, maxHp: 20, healsUsed: 1 });
    scheduler.destroy();
  });

  it("cancels a fight with no combat activity instead of fabricating a result", async () => {
    const ctx = createMockWorld({
      damageByAttacker: {
        "agent-alpha": 0,
        "agent-beta": 0,
      },
    });
    const sendToSpectators = vi.fn();
    (
      ctx.world.network as typeof ctx.world.network & {
        sendToSpectators: typeof sendToSpectators;
      }
    ).sendToSpectators = sendToSpectators;
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    const cycle = scheduler.getCurrentCycle()!;

    (scheduler as any).orchestrator.endFightByTimeout();

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "no_combat_activity",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(scheduler.getStreamingState().terminalNotice).toEqual({
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      outcome: "cancelled",
      reason: "no_combat_activity",
      occurredAt: expect.any(Number),
      expiresAt: expect.any(Number),
      agent1Id: cycle.agent1?.characterId ?? null,
      agent1Name: cycle.agent1?.name ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
      agent2Name: cycle.agent2?.name ?? null,
    });
    (scheduler as unknown as { broadcastState: () => void }).broadcastState();
    expect(sendToSpectators).toHaveBeenLastCalledWith(
      "streamingState",
      expect.objectContaining({
        terminalNotice: expect.objectContaining({
          reason: "insufficient_verified_combat",
        }),
      }),
    );
    expect(scheduler.getStreamingState().terminalNotice?.reason).toBe(
      "no_combat_activity",
    );
    expect(
      scheduler.getStreamingState().terminalNotice!.expiresAt -
        scheduler.getStreamingState().terminalNotice!.occurredAt,
    ).toBe(STREAMING_TIMING.RESOLUTION_DURATION);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.RESOLUTION_DURATION - 1);
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(scheduler.getStreamingState().terminalNotice?.outcome).toBe(
      "cancelled",
    );
    await vi.advanceTimersByTimeAsync(1_001);
    expect(scheduler.getStreamingState().terminalNotice).toBeNull();
    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
    expect(scheduler.getRecentDuels()).toEqual([
      expect.objectContaining({
        cycleId: cycle.cycleId,
        duelId: cycle.duelId,
        outcome: "cancelled",
        winnerId: null,
        loserId: null,
        winReason: null,
        cancellationReason: "no_combat_activity",
        damageAgent1: 0,
        damageAgent2: 0,
      }),
    ]);
    expect(
      scheduler
        .getLeaderboard()
        .every(
          (entry) =>
            entry.wins === 0 && entry.draws === 0 && entry.losses === 0,
        ),
    ).toBe(true);

    scheduler.destroy();
  });

  it("keeps the fight open until the immutable schema-v4 deadline and resolves on that exact boundary", async () => {
    const ctx = createMockWorld({
      damageByAttacker: {
        "agent-alpha": 0,
        "agent-beta": 0,
      },
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    const abortEvents = collectCycleAbortEvents(ctx);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

    const cycle = scheduler.getCurrentCycle()!;
    const timing = cycle.competitiveSnapshot?.timing;
    expect(cycle.phase).toBe("FIGHTING");
    expect(cycle.competitiveSnapshot?.snapshotVersion).toBe(4);
    expect(timing).toMatchObject({
      contractVersion: STREAMING_TIMING.CONTRACT_VERSION,
      timeoutPolicy: STREAMING_TIMING.TIMEOUT_POLICY,
      fightStartTime: cycle.phaseStartTime,
      fightDeadline: cycle.phaseStartTime + STREAMING_TIMING.MAX_FIGHT_DURATION,
    });

    vi.setSystemTime(timing!.fightDeadline - 1);
    harness.tick();
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(abortEvents).toHaveLength(0);

    // The one-second production scheduler cadence can observe expiry after the
    // boundary. Terminal truth must still use the deadline bettors saw.
    vi.setSystemTime(timing!.fightDeadline + 777);
    harness.tick();
    await Promise.resolve();

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "no_combat_activity",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getStreamingState().terminalNotice).toMatchObject({
      outcome: "cancelled",
      reason: "no_combat_activity",
      occurredAt: timing!.fightDeadline,
    });
    expect(scheduler.getRecentDuels()).toEqual([
      expect.objectContaining({
        outcome: "cancelled",
        cancellationReason: "no_combat_activity",
        finishedAt: timing!.fightDeadline,
      }),
    ]);
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
  });

  it.each([
    {
      name: "HP percentage before damage",
      alphaHp: 12,
      alphaMaxHp: 20,
      betaHp: 15,
      betaMaxHp: 30,
      alphaDamage: 4,
      betaDamage: 12,
      expectedReason: "hp_advantage" as const,
    },
    {
      name: "damage after equal HP percentage",
      alphaHp: 15,
      alphaMaxHp: 30,
      betaHp: 10,
      betaMaxHp: 20,
      alphaDamage: 9,
      betaDamage: 6,
      expectedReason: "damage_advantage" as const,
    },
  ])(
    "applies $name at timeout without changing the committed policy order",
    async ({
      alphaHp,
      alphaMaxHp,
      betaHp,
      betaMaxHp,
      alphaDamage,
      betaDamage,
      expectedReason,
    }) => {
      const ctx = createMockWorld({
        damageByAttacker: {
          "agent-alpha": 0,
          "agent-beta": 0,
        },
      });
      const scheduler = new StreamingDuelScheduler(ctx.world as never);

      scheduler.init();
      await startCountdownAtMarketClose(scheduler);
      await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

      const cycle = scheduler.getCurrentCycle()!;
      const alpha =
        cycle.agent1?.characterId === "agent-alpha"
          ? cycle.agent1
          : cycle.agent2!;
      const beta = alpha === cycle.agent1 ? cycle.agent2! : cycle.agent1!;
      alpha.currentHp = alphaHp;
      alpha.maxHp = alphaMaxHp;
      beta.currentHp = betaHp;
      beta.maxHp = betaMaxHp;
      alpha.damageDealtThisFight = alphaDamage;
      beta.damageDealtThisFight = betaDamage;
      cycle.firstHitAt = cycle.phaseStartTime + 1;

      const fightDeadline = cycle.competitiveSnapshot!.timing!.fightDeadline;
      vi.setSystemTime(fightDeadline + 777);
      asSchedulerHarness(scheduler).orchestrator.endFightByTimeout(
        fightDeadline,
      );

      expect(cycle).toMatchObject({
        phase: "RESOLUTION",
        outcome: "win",
        winnerId: "agent-alpha",
        loserId: "agent-beta",
        winReason: expectedReason,
        duelEndTime: fightDeadline,
      });
      expect(cycle.competitiveSnapshot?.timing?.timeoutPolicy).toBe(
        STREAMING_TIMING.TIMEOUT_POLICY,
      );
      scheduler.destroy();
    },
  );

  it("records a true draw with no winner and emits market cancellation", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const alphaOriginalPosition = [
      ...ctx.entities.get("agent-alpha")!.data.position,
    ] as [number, number, number];
    const betaOriginalPosition = [
      ...ctx.entities.get("agent-beta")!.data.position,
    ] as [number, number, number];
    const aborted = vi.fn();
    const completed = vi.fn();
    const cancelled = vi.fn();
    ctx.world.on("streaming:cycle:aborted", aborted);
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    ctx.world.on(EventType.DUEL_CANCELLED, cancelled);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    const cycle = scheduler.getCurrentCycle()!;
    cycle.agent1!.currentHp = 15;
    cycle.agent2!.currentHp = 15;
    cycle.agent1!.damageDealtThisFight = 5;
    cycle.agent2!.damageDealtThisFight = 5;

    const fightDeadline = cycle.competitiveSnapshot!.timing!.fightDeadline;
    vi.setSystemTime(fightDeadline + 777);
    (scheduler as any).orchestrator.endFightByTimeout(fightDeadline);

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.outcome).toBe("draw");
    expect(cycle.duelEndTime).toBe(fightDeadline);
    expect(cycle.winnerId).toBeNull();
    expect(cycle.loserId).toBeNull();
    expect(aborted).toHaveBeenCalledWith(
      expect.objectContaining({ duelId: cycle.duelId, reason: "draw" }),
    );
    expect(cancelled).toHaveBeenCalledWith(
      expect.objectContaining({ duelId: cycle.duelId, reason: "draw" }),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(scheduler.getRecentDuels()[0]).toEqual(
      expect.objectContaining({
        outcome: "draw",
        winnerId: null,
        loserId: null,
        damageAgent1: 5,
        damageAgent2: 5,
      }),
    );
    expect(
      scheduler
        .getLeaderboard()
        .filter((entry) =>
          ["agent-alpha", "agent-beta"].includes(entry.characterId),
        )
        .map((entry) => ({
          characterId: entry.characterId,
          wins: entry.wins,
          draws: entry.draws,
          losses: entry.losses,
        })),
    ).toEqual([
      { characterId: "agent-alpha", wins: 0, draws: 1, losses: 0 },
      { characterId: "agent-beta", wins: 0, draws: 1, losses: 0 },
    ]);

    scheduler.unregisterAgent("agent-beta");
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.RESOLUTION_DURATION);
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.getCurrentCycle()).toBeNull();
    expectContestantRestored(ctx, "agent-alpha", alphaOriginalPosition);
    expectContestantRestored(ctx, "agent-beta", betaOriginalPosition);

    scheduler.destroy();
  });

  it("fully restores a damaged fight after authoritative cancellation", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    const abortEvents = collectCycleAbortEvents(ctx);
    const completed = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    const alphaOriginalPosition = [
      ...ctx.entities.get("agent-alpha")!.data.position,
    ] as [number, number, number];
    const betaOriginalPosition = [
      ...ctx.entities.get("agent-beta")!.data.position,
    ] as [number, number, number];

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("FIGHTING");
    expect(ctx.entities.get("agent-alpha")!.data.health).toBeLessThan(20);
    expect(ctx.entities.get("agent-beta")!.data.health).toBeLessThan(20);

    cycle.phaseStartTime = Date.now() - 10_000_000;
    harness.tick();
    await Promise.resolve();
    await Promise.resolve();

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "watchdog_fighting_timeout",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(completed).not.toHaveBeenCalled();
    expect(scheduler.getCurrentCycle()).toBeNull();
    expectContestantRestored(ctx, "agent-alpha", alphaOriginalPosition);
    expectContestantRestored(ctx, "agent-beta", betaOriginalPosition);

    scheduler.destroy();
  });

  it("completes 100 deterministic full cycles without impossible outcomes, fake damage, stuck phases, or leaked flags", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    const completedEvents: unknown[] = [];
    const cancelledEvents: unknown[] = [];
    const abortEvents: unknown[] = [];
    const damageEvents: Array<{
      attackerId?: string;
      entityId?: string;
      damage?: number;
    }> = [];
    ctx.world.on(EventType.DUEL_COMPLETED, (payload) => {
      completedEvents.push(payload);
    });
    ctx.world.on(EventType.DUEL_CANCELLED, (payload) => {
      cancelledEvents.push(payload);
    });
    ctx.world.on("streaming:cycle:aborted", (payload) => {
      abortEvents.push(payload);
    });
    ctx.world.on(EventType.ENTITY_DAMAGED, (payload) => {
      if (payload && typeof payload === "object") {
        damageEvents.push(
          payload as {
            attackerId?: string;
            entityId?: string;
            damage?: number;
          },
        );
      }
    });

    scheduler.init();
    const seenCycleIds = new Set<string>();
    const seenDuelKeys = new Set<string>();
    let expectedWins = 0;
    let expectedDraws = 0;

    for (let index = 0; index < 100; index += 1) {
      const announcementCycle = scheduler.getCurrentCycle();
      expect(announcementCycle?.phase).toBe("ANNOUNCEMENT");
      expect(announcementCycle?.cycleId).toBeTruthy();
      expect(announcementCycle?.duelKeyHex).toMatch(/^[0-9a-f]{64}$/);
      expect(seenCycleIds.has(announcementCycle!.cycleId)).toBe(false);
      expect(seenDuelKeys.has(announcementCycle!.duelKeyHex!)).toBe(false);
      seenCycleIds.add(announcementCycle!.cycleId);
      seenDuelKeys.add(announcementCycle!.duelKeyHex!);

      const isDraw = index % 5 === 0;
      const alphaShouldWin = !isDraw && index % 2 === 0;
      ctx.setDamageByAttacker(
        "agent-alpha",
        isDraw ? 1 : alphaShouldWin ? 3 : 1,
      );
      ctx.setDamageByAttacker(
        "agent-beta",
        isDraw ? 1 : alphaShouldWin ? 1 : 3,
      );

      const combatCallsBefore = ctx.combatCalls.length;
      const damageEventsBefore = damageEvents.length;
      await startCountdownAtMarketClose(scheduler);
      expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");
      await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

      expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
      // Let the authoritative tick ingest the real entity HP deltas emitted by
      // the combat system before asking the timeout resolver for an outcome.
      await vi.advanceTimersByTimeAsync(
        STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
      );
      const fightingCycle = scheduler.getCurrentCycle();
      expect(fightingCycle?.phase).toBe("FIGHTING");
      expect(ctx.combatCalls.length - combatCallsBefore).toBeGreaterThanOrEqual(
        2,
      );
      expect(damageEvents.length - damageEventsBefore).toBe(
        ctx.combatCalls.length - combatCallsBefore,
      );
      for (const event of damageEvents.slice(damageEventsBefore)) {
        expect(event.damage).toBeGreaterThan(0);
        expect(["agent-alpha", "agent-beta"]).toContain(event.attackerId);
        expect(["agent-alpha", "agent-beta"]).toContain(event.entityId);
        expect(event.attackerId).not.toBe(event.entityId);
      }

      const agent1 = fightingCycle!.agent1!;
      const agent2 = fightingCycle!.agent2!;
      const expectedWinnerId =
        agent1.currentHp !== agent2.currentHp
          ? agent1.currentHp > agent2.currentHp
            ? agent1.characterId
            : agent2.characterId
          : agent1.damageDealtThisFight !== agent2.damageDealtThisFight
            ? agent1.damageDealtThisFight > agent2.damageDealtThisFight
              ? agent1.characterId
              : agent2.characterId
            : null;

      harness.orchestrator.endFightByTimeout();
      const terminalCycle = scheduler.getCurrentCycle();
      expect(terminalCycle?.phase).toBe("RESOLUTION");
      expect(terminalCycle?.winnerId).toBe(expectedWinnerId);
      expect(terminalCycle?.loserId).toBe(
        expectedWinnerId === null
          ? null
          : expectedWinnerId === agent1.characterId
            ? agent2.characterId
            : agent1.characterId,
      );
      expect(terminalCycle?.outcome).toBe(
        expectedWinnerId === null ? "draw" : "win",
      );
      expect(terminalCycle?.seed).toMatch(/^\d+$/);
      expect(terminalCycle?.replayHash).toMatch(/^[0-9a-f]{64}$/);

      const latestDuel = scheduler.getRecentDuels()[0];
      expect(latestDuel?.duelId).toBe(terminalCycle?.duelId);
      expect(latestDuel?.winnerId).toBe(expectedWinnerId);
      expect(latestDuel?.damageAgent1).toBe(agent1.damageDealtThisFight);
      expect(latestDuel?.damageAgent2).toBe(agent2.damageDealtThisFight);
      expect(latestDuel?.agent1OpeningStyle).toBe(
        fightingCycle?.competitiveSnapshot?.contestants.find(
          (contestant) => contestant.agentId === agent1.characterId,
        )?.initialCombatStyle ?? null,
      );
      expect(latestDuel?.agent2OpeningStyle).toBe(
        fightingCycle?.competitiveSnapshot?.contestants.find(
          (contestant) => contestant.agentId === agent2.characterId,
        )?.initialCombatStyle ?? null,
      );
      if (expectedWinnerId === null) {
        expectedDraws += 1;
      } else {
        expectedWins += 1;
      }

      if (index === 99) {
        scheduler.unregisterAgent("agent-beta");
      }
      await vi.advanceTimersByTimeAsync(STREAMING_TIMING.RESOLUTION_DURATION);
      await Promise.resolve();
      await Promise.resolve();

      expect(scheduler.getCurrentCycle()).toBeNull();
      for (const entityId of ["agent-alpha", "agent-beta"]) {
        const entity = ctx.entities.get(entityId)!;
        expect(entity.data.health).toBe(entity.data.maxHealth);
        expect(entity.data.inStreamingDuel).toBe(false);
        expect(entity.data.preventRespawn).toBe(false);
        expect(entity.data.inCombat).toBe(false);
        expect(entity.data.combatTarget).toBeNull();
        expect(entity.data.attackTarget).toBeNull();
      }
      expect(ctx.entities.size).toBe(2);

      if (index < 99) {
        await vi.advanceTimersByTimeAsync(
          STREAMING_TIMING.INTER_CYCLE_DELAY_MS,
        );
        expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
      }
    }

    expect(seenCycleIds.size).toBe(100);
    expect(seenDuelKeys.size).toBe(100);
    expect(expectedWins).toBe(80);
    expect(expectedDraws).toBe(20);
    expect(completedEvents).toHaveLength(80);
    expect(cancelledEvents).toHaveLength(20);
    expect(abortEvents).toHaveLength(20);
    expect(
      abortEvents.every(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          "reason" in event &&
          event.reason === "draw",
      ),
    ).toBe(true);
    const retainedDuels = scheduler.getRecentDuels();
    expect(retainedDuels.length).toBeGreaterThan(0);
    expect(retainedDuels.length).toBeLessThanOrEqual(100);
    expect(new Set(retainedDuels.map((duel) => duel.duelId)).size).toBe(
      retainedDuels.length,
    );
    const leaderboard = scheduler.getLeaderboard();
    expect(leaderboard.reduce((sum, entry) => sum + entry.wins, 0)).toBe(80);
    expect(leaderboard.reduce((sum, entry) => sum + entry.draws, 0)).toBe(40);
    expect(leaderboard.reduce((sum, entry) => sum + entry.losses, 0)).toBe(80);
    expect(scheduler.getOperationalMetrics().historyWindow).toMatchObject({
      size: 100,
      wins: 80,
      draws: 20,
      completed: 100,
      cancelled: 0,
      terminal: 100,
      completionRate: 1,
      cancellationReasons: {},
    });

    scheduler.destroy();
  });

  it("cancels after repeated engagement failures without synthetic damage", async () => {
    const ctx = createMockWorld({ combatStarts: false });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    const cycle = scheduler.getCurrentCycle()!;

    await vi.advanceTimersByTimeAsync(18_500);

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "combat_engagement_failed",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(ctx.entities.get("agent-alpha")?.data.health).toBe(20);
    expect(ctx.entities.get("agent-beta")?.data.health).toBe(20);
    expect(scheduler.getRecentDuels()).toEqual([
      expect.objectContaining({
        cycleId: cycle.cycleId,
        duelId: cycle.duelId,
        outcome: "cancelled",
        winnerId: null,
        loserId: null,
        winReason: null,
        cancellationReason: "combat_engagement_failed",
        damageAgent1: 0,
        damageAgent2: 0,
      }),
    ]);
    expect(scheduler.getOperationalMetrics()).toMatchObject({
      historyWindow: {
        size: 1,
        wins: 0,
        draws: 0,
        completed: 0,
        cancelled: 1,
        terminal: 1,
        completionRate: 0,
        cancellationReasons: { combat_engagement_failed: 1 },
      },
      engagement: {
        checks: 6,
        retries: 5,
        recoveries: 0,
        failures: 1,
        currentRetryCount: 0,
      },
    });

    scheduler.destroy();
  });

  it("does not consume engagement retries while persisted duel damage is settling", async () => {
    let damagePending = true;
    const ctx = createMockWorld({
      combatStarts: false,
      duelDamagePending: () => damagePending,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);
    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    await vi.advanceTimersByTimeAsync(18_500);

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    expect(abortEvents).toHaveLength(0);
    expect(scheduler.getOperationalMetrics().engagement).toMatchObject({
      retries: 0,
      failures: 0,
      currentRetryCount: 0,
    });

    damagePending = false;
    await vi.advanceTimersByTimeAsync(18_500);

    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(abortEvents).toHaveLength(1);
    expect(abortEvents[0]).toMatchObject({
      reason: "combat_engagement_failed",
    });
    expect(scheduler.getOperationalMetrics().engagement).toMatchObject({
      retries: 5,
      failures: 1,
      currentRetryCount: 0,
    });

    scheduler.destroy();
  });

  it("auto-equips a bronze weapon for unarmed duel contestants", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: null,
      betaWeaponId: null,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(ctx.getEquippedWeapon("agent-alpha")).toMatch(/^bronze_/);
    expect(ctx.getEquippedWeapon("agent-beta")).toMatch(/^bronze_/);
    expect(ctx.equipCalls).toHaveLength(2);
    expect(
      ctx.equipCalls.every((call) => call.itemId.startsWith("bronze_")),
    ).toBe(true);

    scheduler.destroy();
  });

  it("does not replace an already-equipped weapon during duel prep", async () => {
    const equippedWeaponId = "test_iron_longsword";
    ITEMS.set(equippedWeaponId, {
      id: equippedWeaponId,
      name: "Test Iron Longsword",
      type: "weapon",
      description: "A classified melee fixture.",
      examine: "A classified melee fixture.",
      tradeable: true,
      rarity: "common",
      modelPath: null,
      equipSlot: "weapon",
      equipable: true,
      tier: "iron",
      weaponType: "LONGSWORD",
      attackType: AttackType.MELEE,
      bonuses: { attack: 10 },
    } as never);
    const ctx = createMockWorld({
      alphaWeaponId: equippedWeaponId,
      betaWeaponId: null,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    try {
      scheduler.init();
      await startCountdownAtMarketClose(scheduler);

      expect(ctx.getEquippedWeapon("agent-alpha")).toBe(equippedWeaponId);
      expect(ctx.getEquippedWeapon("agent-beta")).toMatch(/^bronze_/);
      expect(
        ctx.equipCalls.some((call) => call.playerId === "agent-alpha"),
      ).toBe(false);
      expect(
        ctx.equipCalls.some((call) => call.playerId === "agent-beta"),
      ).toBe(true);
    } finally {
      scheduler.destroy();
      ITEMS.delete(equippedWeaponId);
    }
  });

  it("resolves duel, restores HP, preserves agent food, and returns agents", async () => {
    const ctx = createMockWorld({
      alphaInventory: [
        { slot: 0, itemId: DUEL_FOOD_ITEM, quantity: 1 },
        { slot: 1, itemId: "bronze_sword", quantity: 1 },
      ],
      betaInventory: [{ slot: 5, itemId: DUEL_FOOD_ITEM, quantity: 2 }],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    const alphaOriginalPosition = [
      ...ctx.entities.get("agent-alpha")!.data.position,
    ] as [number, number, number];
    const betaOriginalPosition = [
      ...ctx.entities.get("agent-beta")!.data.position,
    ] as [number, number, number];

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(ctx.countFood("agent-alpha")).toBe(1);
    expect(ctx.countFood("agent-beta")).toBe(1);

    await vi.advanceTimersByTimeAsync(4000);
    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");

    // Prevent immediate next-cycle start so cleanup side effects can be asserted
    // directly on the finished duel agents.
    scheduler.unregisterAgent("agent-beta");

    // Agents stay in the arena during resolution (death animation plays).
    // Advance through the 15s resolution phase to trigger endCycle + cleanup.
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.getCurrentCycle()).toBeNull();

    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;

    expect(alpha.data.health).toBe(alpha.data.maxHealth);
    expect(beta.data.health).toBe(beta.data.maxHealth);

    expect(alpha.data.inStreamingDuel).toBe(false);
    expect(beta.data.inStreamingDuel).toBe(false);
    expect(alpha.data.preventRespawn).toBe(false);
    expect(beta.data.preventRespawn).toBe(false);

    expect(alpha.data.position).toEqual(alphaOriginalPosition);
    expect(beta.data.position).toEqual(betaOriginalPosition);

    expect(ctx.countFood("agent-alpha")).toBe(1);
    expect(ctx.countFood("agent-beta")).toBe(1);
    expect(ctx.hasItemAtSlot("agent-alpha", 0, DUEL_FOOD_ITEM)).toBe(true);
    expect(ctx.hasItemAtSlot("agent-beta", 5, DUEL_FOOD_ITEM)).toBe(true);
    expect(ctx.hasItemAtSlot("agent-alpha", 1, "bronze_sword")).toBe(true);

    expect(alpha.data.combatTarget).toBeNull();
    expect(beta.data.combatTarget).toBeNull();
    expect(alpha.data.inCombat).toBe(false);
    expect(beta.data.inCombat).toBe(false);

    scheduler.destroy();
  });

  it("restores the exact pre-duel loadout, autocast, ammunition, and runes after a win", async () => {
    const ctx = createMockWorld({
      alphaInventory: [
        { slot: 0, itemId: "bronze_arrow", quantity: 37 },
        { slot: 1, itemId: "air_rune", quantity: 11 },
      ],
      betaInventory: [
        { slot: 0, itemId: "mind_rune", quantity: 9 },
        { slot: 1, itemId: "air_rune", quantity: 13 },
      ],
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
      alphaArrowId: "iron_arrow",
      alphaArrowQuantity: 17,
      betaArrowId: "steel_arrow",
      betaArrowQuantity: 23,
      alphaShieldId: "wooden_shield",
      betaShieldId: "bronze_shield",
      alphaSelectedSpell: "water_strike",
      betaSelectedSpell: "earth_strike",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    harness.orchestrator.setDebugCombatRoleOverride("agent-alpha", "ranged");
    harness.orchestrator.setDebugCombatRoleOverride("agent-beta", "mage");

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(ctx.getEquippedWeapon("agent-alpha")).not.toBe("iron_sword");
    expect(ctx.getEquipmentSlot("agent-alpha", "arrows")?.itemId).toBe(
      "bronze_arrow",
    );
    expect(ctx.equipCalls).toContainEqual({
      playerId: "agent-alpha",
      itemId: "bronze_arrow",
      quantity: 500,
    });
    expect(ctx.entities.get("agent-beta")?.data.selectedSpell).not.toBe(
      "earth_strike",
    );
    expect(ctx.countItem("agent-alpha", "bronze_arrow")).toBeGreaterThan(37);
    expect(ctx.countItem("agent-beta", "mind_rune")).toBeGreaterThan(9);

    // Simulate duel consumption from the scheduler-provisioned stacks. Cleanup
    // must remove only the remaining provision and preserve owned baselines.
    const alphaProvisionedArrows = ctx
      .getInventory("agent-alpha")
      .items.find((item) => item.itemId === "bronze_arrow")!;
    const betaProvisionedRunes = ctx
      .getInventory("agent-beta")
      .items.find((item) => item.itemId === "mind_rune")!;
    alphaProvisionedArrows.quantity -= 123;
    betaProvisionedRunes.quantity -= 77;

    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    harness.orchestrator.startResolution("agent-alpha", "agent-beta", "kill");
    scheduler.unregisterAgent("agent-beta");
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.RESOLUTION_DURATION);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.getEquipmentSlot("agent-alpha", "weapon")).toEqual(
      expect.objectContaining({ itemId: "iron_sword" }),
    );
    expect(ctx.getEquipmentSlot("agent-alpha", "arrows")).toEqual({
      itemId: "iron_arrow",
      quantity: 17,
    });
    expect(ctx.getEquipmentSlot("agent-alpha", "shield")).toEqual(
      expect.objectContaining({ itemId: "wooden_shield" }),
    );
    expect(ctx.getEquipmentSlot("agent-beta", "weapon")).toEqual(
      expect.objectContaining({ itemId: "bronze_longsword" }),
    );
    expect(ctx.getEquipmentSlot("agent-beta", "arrows")).toEqual({
      itemId: "steel_arrow",
      quantity: 23,
    });
    expect(ctx.getEquipmentSlot("agent-beta", "shield")).toEqual(
      expect.objectContaining({ itemId: "bronze_shield" }),
    );
    expect(ctx.entities.get("agent-alpha")?.data.selectedSpell).toBe(
      "water_strike",
    );
    expect(ctx.entities.get("agent-beta")?.data.selectedSpell).toBe(
      "earth_strike",
    );
    expect(ctx.countItem("agent-alpha", "bronze_arrow")).toBe(37);
    expect(ctx.countItem("agent-alpha", "air_rune")).toBe(11);
    expect(ctx.countItem("agent-beta", "mind_rune")).toBe(9);
    expect(ctx.countItem("agent-beta", "air_rune")).toBe(13);

    scheduler.destroy();
  });

  it("honors matching explicit sparbot styles without forcing a point-blank ranged role", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    harness.orchestrator.setDebugCombatRoleOverride("agent-alpha", "melee");
    harness.orchestrator.setDebugCombatRoleOverride("agent-beta", "melee");

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(
      (
        harness.orchestrator as unknown as {
          combatRolesByAgent: Map<string, string>;
        }
      ).combatRolesByAgent.get("agent-alpha"),
    ).toBe("melee");
    expect(
      (
        harness.orchestrator as unknown as {
          combatRolesByAgent: Map<string, string>;
        }
      ).combatRolesByAgent.get("agent-beta"),
    ).toBe("melee");
    expect(ctx.getEquippedWeapon("agent-alpha")).not.toBe("shortbow");
    expect(ctx.getEquippedWeapon("agent-beta")).not.toBe("shortbow");

    scheduler.destroy();
  });

  it("records a disconnect as a forfeit and fully restores both contestants", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const completed = vi.fn();
    const aborted = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    ctx.world.on("streaming:cycle:aborted", aborted);
    const alphaOriginalPosition = [
      ...ctx.entities.get("agent-alpha")!.data.position,
    ] as [number, number, number];
    const betaOriginalPosition = [
      ...ctx.entities.get("agent-beta")!.data.position,
    ] as [number, number, number];

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
    );
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("FIGHTING");

    ctx.world.emit(EventType.PLAYER_LEFT, {
      playerId: "agent-beta",
      reconnectGraceActive: true,
      reconnectGraceExpiresAt: Date.now() + 30_000,
    });

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.outcome).toBe("win");
    expect(cycle.winnerId).toBe("agent-alpha");
    expect(cycle.loserId).toBe("agent-beta");
    expect(cycle.winReason).toBe("forfeit");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        duelId: cycle.duelId,
        winnerId: "agent-alpha",
        loserId: "agent-beta",
        reason: "forfeit",
        forfeit: true,
      }),
    );
    expect(aborted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.RESOLUTION_DURATION);
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.getCurrentCycle()).toBeNull();
    expectContestantRestored(ctx, "agent-alpha", alphaOriginalPosition);
    expectContestantRestored(ctx, "agent-beta", betaOriginalPosition);

    scheduler.destroy();
  });

  it("fully restores both contestants after an authoritative death", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const completed = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    const alphaOriginalPosition = [
      ...ctx.entities.get("agent-alpha")!.data.position,
    ] as [number, number, number];
    const betaOriginalPosition = [
      ...ctx.entities.get("agent-beta")!.data.position,
    ] as [number, number, number];

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;
    alpha.data.health = 6;
    beta.data.health = 0;

    ctx.world.emit(EventType.ENTITY_DEATH, {
      entityId: "agent-beta",
      killedBy: "agent-alpha",
    });
    await Promise.resolve();

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.winnerId).toBe("agent-alpha");
    expect(cycle.loserId).toBe("agent-beta");
    expect(cycle.winReason).toBe("kill");
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        duelId: cycle.duelId,
        winnerId: "agent-alpha",
        loserId: "agent-beta",
        reason: "death",
        forfeit: false,
      }),
    );

    scheduler.unregisterAgent("agent-beta");
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.RESOLUTION_DURATION);
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.getCurrentCycle()).toBeNull();
    expectContestantRestored(ctx, "agent-alpha", alphaOriginalPosition);
    expectContestantRestored(ctx, "agent-beta", betaOriginalPosition);

    scheduler.destroy();
  });

  it("sanitizes invalid original restore heights to grounded terrain", async () => {
    const ctx = createMockWorld({ terrainHeight: 14.5 });
    ctx.entities.get("agent-alpha")!.data.position = [10, -250, 10];
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    await vi.advanceTimersByTimeAsync(4000);
    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );

    // Keep cleanup assertions scoped to the finished duel agents.
    scheduler.unregisterAgent("agent-beta");

    // Advance through resolution phase so cleanup + teleport out occurs.
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    await Promise.resolve();

    const alpha = ctx.entities.get("agent-alpha")!;
    expect(alpha.data.position[0]).toBe(10);
    expect(alpha.data.position[2]).toBe(10);
    expect(alpha.data.position[1]).toBe(14.5);

    scheduler.destroy();
  });

  it("does not restore agents into combat arena tiles after duel cleanup", async () => {
    const ctx = createMockWorld({ terrainHeight: 9.5 });
    // Arena 1 bounds include x=70, z=90 with default manifest config.
    ctx.entities.get("agent-alpha")!.data.position = [70, 9.5, 90];

    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    await vi.advanceTimersByTimeAsync(4000);
    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );

    // Keep cleanup assertions scoped to the finished duel agents.
    scheduler.unregisterAgent("agent-beta");

    // Advance through resolution phase so cleanup + teleport out occurs.
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    await Promise.resolve();

    const alpha = ctx.entities.get("agent-alpha")!;
    expect(
      isPositionInsideCombatArena(
        alpha.data.position[0],
        alpha.data.position[2],
      ),
    ).toBe(false);

    scheduler.destroy();
  });

  it("publishes cancellation and fully restores contestants on mid-fight shutdown", async () => {
    const ctx = createMockWorld({
      alphaInventory: [{ slot: 0, itemId: "bronze_arrow", quantity: 7 }],
      betaInventory: [{ slot: 0, itemId: "mind_rune", quantity: 5 }],
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
      alphaArrowId: "iron_arrow",
      alphaArrowQuantity: 12,
      alphaSelectedSpell: "water_strike",
      betaSelectedSpell: "earth_strike",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    harness.orchestrator.setDebugCombatRoleOverride("agent-alpha", "ranged");
    harness.orchestrator.setDebugCombatRoleOverride("agent-beta", "mage");
    const abortEvents = collectCycleAbortEvents(ctx);
    const completed = vi.fn();
    const cancelled = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    ctx.world.on(EventType.DUEL_CANCELLED, cancelled);
    const alphaOriginalPosition = [
      ...ctx.entities.get("agent-alpha")!.data.position,
    ] as [number, number, number];
    const betaOriginalPosition = [
      ...ctx.entities.get("agent-beta")!.data.position,
    ] as [number, number, number];

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("FIGHTING");
    expect(alpha.data.inStreamingDuel).toBe(true);
    expect(beta.data.inStreamingDuel).toBe(true);
    expect(alpha.data.health).toBeLessThan(alpha.data.maxHealth);
    expect(beta.data.health).toBeLessThan(beta.data.maxHealth);

    scheduler.destroy();
    await vi.advanceTimersByTimeAsync(0);

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "scheduler_shutdown",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(completed).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
    expect(scheduler.getCurrentCycle()).toBeNull();
    expectContestantRestored(ctx, "agent-alpha", alphaOriginalPosition);
    expectContestantRestored(ctx, "agent-beta", betaOriginalPosition);
    expect(ctx.getEquippedWeapon("agent-alpha")).toBe("iron_sword");
    expect(ctx.getEquipmentSlot("agent-alpha", "arrows")).toEqual({
      itemId: "iron_arrow",
      quantity: 12,
    });
    expect(ctx.getEquippedWeapon("agent-beta")).toBe("bronze_longsword");
    expect(ctx.entities.get("agent-alpha")?.data.selectedSpell).toBe(
      "water_strike",
    );
    expect(ctx.entities.get("agent-beta")?.data.selectedSpell).toBe(
      "earth_strike",
    );
    expect(ctx.countItem("agent-alpha", "bronze_arrow")).toBe(7);
    expect(ctx.countItem("agent-beta", "mind_rune")).toBe(5);
  });

  it("exposes an awaitable barrier for active-cycle shutdown cleanup", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    vi.spyOn(
      (scheduler as any).orchestrator,
      "cleanupAfterAbort",
    ).mockImplementation(async () => cleanupGate);

    scheduler.destroy();
    let cleanupSettled = false;
    const shutdownBarrier = scheduler.waitForShutdownCleanup().then(() => {
      cleanupSettled = true;
    });

    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    releaseCleanup?.();
    await shutdownBarrier;
    expect(cleanupSettled).toBe(true);
  });

  it("does not cancel an already-terminal result when shutdown begins", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);
    const completed = vi.fn();
    ctx.world.on(EventType.DUEL_COMPLETED, completed);
    const alphaOriginalPosition = [
      ...ctx.entities.get("agent-alpha")!.data.position,
    ] as [number, number, number];
    const betaOriginalPosition = [
      ...ctx.entities.get("agent-beta")!.data.position,
    ] as [number, number, number];

    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
    );
    const cycle = scheduler.getCurrentCycle()!;
    asSchedulerHarness(scheduler).orchestrator.endFightByTimeout();

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.outcome).toBe("win");
    expect(completed).toHaveBeenCalledTimes(1);

    scheduler.destroy();
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.INTER_CYCLE_DELAY_MS * 2,
    );

    expect(abortEvents).toHaveLength(0);
    expect(scheduler.getCurrentCycle()).toBeNull();
    expectContestantRestored(ctx, "agent-alpha", alphaOriginalPosition);
    expectContestantRestored(ctx, "agent-beta", betaOriginalPosition);
  });

  it("waits for in-flight preparation before restoring shutdown loadout state", async () => {
    const ctx = createMockWorld({
      alphaInventory: [{ slot: 0, itemId: "bronze_arrow", quantity: 4 }],
      betaInventory: [{ slot: 0, itemId: "mind_rune", quantity: 6 }],
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
      alphaArrowId: "iron_arrow",
      alphaArrowQuantity: 8,
      alphaSelectedSpell: "water_strike",
      betaSelectedSpell: "earth_strike",
      equipmentDelayMs: 50,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const harness = asSchedulerHarness(scheduler);
    const abortEvents = collectCycleAbortEvents(ctx);
    harness.orchestrator.setDebugCombatRoleOverride("agent-alpha", "ranged");
    harness.orchestrator.setDebugCombatRoleOverride("agent-beta", "mage");

    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    const countdownPromise = startCountdownAtMarketClose(scheduler);
    scheduler.destroy();

    await vi.advanceTimersByTimeAsync(500);
    await countdownPromise;
    await vi.advanceTimersByTimeAsync(0);

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "scheduler_shutdown",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(ctx.getEquippedWeapon("agent-alpha")).toBe("iron_sword");
    expect(ctx.getEquipmentSlot("agent-alpha", "arrows")).toEqual({
      itemId: "iron_arrow",
      quantity: 8,
    });
    expect(ctx.getEquippedWeapon("agent-beta")).toBe("bronze_longsword");
    expect(ctx.entities.get("agent-alpha")?.data.selectedSpell).toBe(
      "water_strike",
    );
    expect(ctx.entities.get("agent-beta")?.data.selectedSpell).toBe(
      "earth_strike",
    );
    expect(ctx.countItem("agent-alpha", "bronze_arrow")).toBe(4);
    expect(ctx.countItem("agent-beta", "mind_rune")).toBe(6);
  });

  it("prefers contestants during early fight lock even when weighted choice points at bystanders", () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
        { id: "agent-delta", name: "Delta", position: [40, 0.2, 40] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phase = "FIGHTING";
    cycle.phaseStartTime = now - 5_000;
    cycle.agent1 = (scheduler as any).orchestrator.createContestant(
      "agent-alpha",
    );
    cycle.agent2 = (scheduler as any).orchestrator.createContestant(
      "agent-beta",
    );
    cycle.winnerId = null;

    (scheduler as any).camera._cameraTarget = "agent-alpha";
    (scheduler as any).camera.lastCameraSwitchTime = now - 60_000;

    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;
    alpha.data.inCombat = true;
    alpha.data.combatTarget = "agent-beta";
    beta.data.inCombat = true;
    beta.data.combatTarget = "agent-alpha";

    (scheduler as any).camera.markAgentInteresting("agent-gamma", 6, now);
    (scheduler as any).camera.markAgentInteresting("agent-delta", 6, now);

    const chooseSpy = vi
      .spyOn((scheduler as any).camera, "chooseWeightedCameraCandidate")
      .mockImplementation((...args: unknown[]) => {
        const candidates = (args[0] ?? []) as Array<{ agentId: string }>;
        return (
          candidates.find((candidate) => candidate.agentId === "agent-gamma") ??
          candidates[0]
        );
      });

    (scheduler as any).camera.updateCameraTarget(now);

    expect(["agent-alpha", "agent-beta"]).toContain(
      (scheduler as any).camera.cameraTarget,
    );

    chooseSpy.mockRestore();
    scheduler.destroy();
  });

  it("locks idle preparation coverage to the exact on-deck pair and alternates both sides deterministically", () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
        { id: "agent-delta", name: "Delta", position: [40, 0.2, 40] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const camera = (scheduler as any).camera;
    (scheduler as any).currentCycle = null;
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: now,
    };
    camera._cameraTarget = "agent-gamma";
    camera.lastCameraSwitchTime = now;
    const random = vi.spyOn(Math, "random").mockReturnValue(0);

    camera.syncIdlePreviewAndCamera(now);
    expect(camera.cameraTarget).toBe("agent-alpha");

    camera.lastCameraSwitchTime = now - 20_000;
    camera.syncIdlePreviewAndCamera(now);
    expect(camera.cameraTarget).toBe("agent-beta");

    camera.lastCameraSwitchTime = now - 20_000;
    camera.syncIdlePreviewAndCamera(now);
    expect(camera.cameraTarget).toBe("agent-alpha");
    expect(random).not.toHaveBeenCalled();

    random.mockRestore();
    scheduler.destroy();
  });

  it("cuts idle preparation coverage to a contestant with a new authoritative activity after the established hold", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const preparationId = "camera-activity-preparation";
    const camera = (scheduler as any).camera;
    (scheduler as any).currentCycle = null;
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: now,
    };
    (scheduler as any).onDeckPreparation = {
      preparationId,
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      status: "preparing",
    };
    (scheduler as any).publicPreparationActivities = {
      preparationId,
      agents: new Map(),
    };
    camera._cameraTarget = "agent-alpha";
    camera.lastCameraSwitchTime = now - 20_000;

    ctx.world.emit("duel:preparation:public_activity", {
      preparationId,
      agentId: "agent-beta",
      activity: "gathering",
      mode: "working",
      occurredAt: now,
      revision: 1,
    });

    expect(camera.cameraTarget).toBe("agent-beta");

    ctx.world.emit("duel:preparation:public_activity", {
      preparationId,
      agentId: "agent-alpha",
      activity: "gathering",
      mode: "working",
      occurredAt: now + 1,
      revision: 1,
    });

    expect(camera.cameraTarget).toBe("agent-beta");

    camera.lastCameraSwitchTime = now - 20_000;
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId,
      agentId: "agent-alpha",
      activity: "gathering",
      mode: "working",
      occurredAt: now + 2,
      revision: 2,
    });

    expect(camera.cameraTarget).toBe("agent-beta");

    ctx.world.emit("duel:preparation:public_activity", {
      preparationId,
      agentId: "agent-alpha",
      activity: "gathering",
      mode: "traveling",
      occurredAt: now + 3,
      revision: 3,
    });

    expect(camera.cameraTarget).toBe("agent-alpha");

    (scheduler as any).currentCycle = { phase: "FIGHTING" };
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId,
      agentId: "agent-alpha",
      activity: "crafting",
      mode: "working",
      occurredAt: now + 4,
      revision: 4,
    });

    expect(camera.cameraTarget).toBe("agent-alpha");

    (scheduler as any).currentCycle = null;
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId,
      agentId: "agent-alpha",
      activity: "exploring",
      mode: "working",
      occurredAt: now + 5,
      revision: 5,
      targetItemId: "private_item_id",
    });

    expect(camera.cameraTarget).toBe("agent-alpha");

    scheduler.destroy();
  });

  it("hydrates the bounded durable preparation trail without manufacturing a restart camera cut", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const preparation = {
      preparationId: "5f50e456-192e-49e8-b485-0e52000fd426",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      status: "preparing",
      selectedAt: now - 1_000,
      expiresAt: now + 60_000,
    };
    Object.assign(scheduler as any, {
      onDeckPreparation: preparation,
      preparationStore: {
        listRecentPublicActivities: vi.fn().mockResolvedValue([
          {
            preparationId: preparation.preparationId,
            agentId: "agent-alpha",
            activity: "planning",
            mode: "working",
            occurredAt: now - 900,
            revision: 101,
          },
          {
            preparationId: preparation.preparationId,
            agentId: "agent-beta",
            activity: "gathering",
            mode: "traveling",
            occurredAt: now - 800,
            revision: 102,
          },
          {
            preparationId: preparation.preparationId,
            agentId: "agent-alpha",
            activity: "provisioning",
            mode: "working",
            occurredAt: now - 700,
            revision: 103,
          },
        ]),
      },
    });
    const camera = (scheduler as any).camera;
    camera._cameraTarget = "agent-beta";
    camera.lastCameraSwitchTime = now - 20_000;

    await (scheduler as any).hydratePublicPreparationActivities(preparation);

    expect(camera.cameraTarget).toBe("agent-beta");
    expect(
      (scheduler as any).publicPreparationActivities.agents.get("agent-alpha"),
    ).toEqual({
      activity: "provisioning",
      mode: "working",
      activityTrail: ["planning", "provisioning"],
      revision: 103,
    });
    expect(
      (scheduler as any).publicPreparationActivities.agents.get("agent-beta"),
    ).toEqual({
      activity: "gathering",
      mode: "traveling",
      activityTrail: ["gathering"],
      revision: 102,
    });
    scheduler.destroy();
  });

  it("retains one pair-bound preparation activity cut until the established hold elapses", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const camera = (scheduler as any).camera;
    (scheduler as any).currentCycle = null;
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: now,
    };
    camera._cameraTarget = "agent-alpha";
    camera.lastCameraSwitchTime = now;

    expect(
      camera.considerIdlePreparationActivityCut("agent-beta", now + 1_000),
    ).toBe(false);
    camera.syncIdlePreviewAndCamera(now + 5_999);
    expect(camera.cameraTarget).toBe("agent-alpha");

    camera.syncIdlePreviewAndCamera(now + 6_000);
    expect(camera.cameraTarget).toBe("agent-beta");

    camera.setCameraTarget("agent-alpha", now + 10_000);
    expect(
      camera.considerIdlePreparationActivityCut("agent-beta", now + 11_000),
    ).toBe(false);
    camera.clearIdlePreparationActivityCut();
    camera.syncIdlePreviewAndCamera(now + 16_000);
    expect(camera.cameraTarget).toBe("agent-alpha");

    scheduler.destroy();
  });

  it("allows fight cutaways after both contestants stay idle long enough", () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
        { id: "agent-delta", name: "Delta", position: [40, 0.2, 40] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phase = "FIGHTING";
    cycle.phaseStartTime = now - 180_000;
    cycle.agent1 = (scheduler as any).orchestrator.createContestant(
      "agent-alpha",
    );
    cycle.agent2 = (scheduler as any).orchestrator.createContestant(
      "agent-beta",
    );
    cycle.winnerId = null;
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-gamma",
      agent2Id: "agent-delta",
      selectedAt: now - 10_000,
    };

    (scheduler as any).camera._cameraTarget = "agent-alpha";
    (scheduler as any).camera.lastCameraSwitchTime = now - 90_000;
    (scheduler as any).camera.fightCutawayStartedAt = null;
    (scheduler as any).camera.fightCutawayTotalMs = 0;
    (scheduler as any).camera.fightLastCutawayEndedAt = 0;

    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;
    alpha.data.inCombat = false;
    alpha.data.combatTarget = null;
    beta.data.inCombat = false;
    beta.data.combatTarget = null;

    const alphaSample = (scheduler as any).camera.ensureAgentActivity(
      "agent-alpha",
      now,
    );
    alphaSample.lastInterestingTime = now - 45_000;
    alphaSample.combatScore = 0;
    const betaSample = (scheduler as any).camera.ensureAgentActivity(
      "agent-beta",
      now,
    );
    betaSample.lastInterestingTime = now - 45_000;
    betaSample.combatScore = 0;

    (scheduler as any).camera.markAgentInteresting("agent-gamma", 6, now);
    (scheduler as any).camera.markAgentInteresting("agent-delta", 4, now);

    const chooseSpy = vi
      .spyOn((scheduler as any).camera, "chooseWeightedCameraCandidate")
      .mockImplementation((...args: unknown[]) => {
        const candidates = (args[0] ?? []) as Array<{ agentId: string }>;
        return (
          candidates.find((candidate) => candidate.agentId === "agent-gamma") ??
          candidates[0]
        );
      });

    (scheduler as any).camera.updateCameraTarget(now);
    expect((scheduler as any).camera.cameraTarget).toBe("agent-gamma");

    chooseSpy.mockRestore();
    scheduler.destroy();
  });

  it("limits announcement camera candidates to current duel contestants", () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
        { id: "agent-delta", name: "Delta", position: [40, 0.2, 40] },
        { id: "agent-epsilon", name: "Epsilon", position: [50, 0.2, 50] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phase = "ANNOUNCEMENT";
    cycle.phaseStartTime = now - 15_000;
    cycle.agent1 = (scheduler as any).orchestrator.createContestant(
      "agent-alpha",
    );
    cycle.agent2 = (scheduler as any).orchestrator.createContestant(
      "agent-beta",
    );
    cycle.winnerId = null;

    const candidates = (scheduler as any).camera.buildCameraCandidates(
      now,
      "agent-alpha",
      true,
    ) as Array<{ agentId: string }>;
    const candidateIds = new Set(
      candidates.map((candidate) => candidate.agentId),
    );

    expect(candidateIds).toEqual(new Set(["agent-alpha", "agent-beta"]));
    expect(candidateIds.has("agent-gamma")).toBe(false);
    expect(candidateIds.has("agent-delta")).toBe(false);
    expect(candidateIds.has("agent-epsilon")).toBe(false);

    scheduler.destroy();
  });

  it("limits fight cutaway candidates to next duel pair members", () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
        { id: "agent-delta", name: "Delta", position: [40, 0.2, 40] },
        { id: "agent-epsilon", name: "Epsilon", position: [50, 0.2, 50] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phase = "FIGHTING";
    cycle.phaseStartTime = now - 180_000;
    cycle.agent1 = (scheduler as any).orchestrator.createContestant(
      "agent-alpha",
    );
    cycle.agent2 = (scheduler as any).orchestrator.createContestant(
      "agent-beta",
    );
    cycle.winnerId = null;
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-gamma",
      agent2Id: "agent-delta",
      selectedAt: now - 15_000,
    };

    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;
    alpha.data.inCombat = false;
    alpha.data.combatTarget = null;
    beta.data.inCombat = false;
    beta.data.combatTarget = null;

    const alphaSample = (scheduler as any).camera.ensureAgentActivity(
      "agent-alpha",
      now,
    );
    alphaSample.lastInterestingTime = now - 45_000;
    const betaSample = (scheduler as any).camera.ensureAgentActivity(
      "agent-beta",
      now,
    );
    betaSample.lastInterestingTime = now - 45_000;

    const candidates = (scheduler as any).camera.buildCameraCandidates(
      now,
      "agent-alpha",
      true,
    ) as Array<{ agentId: string }>;
    const candidateIds = new Set(
      candidates.map((candidate) => candidate.agentId),
    );

    expect(candidateIds.has("agent-alpha")).toBe(true);
    expect(candidateIds.has("agent-beta")).toBe(true);
    expect(candidateIds.has("agent-gamma")).toBe(true);
    expect(candidateIds.has("agent-delta")).toBe(true);
    expect(candidateIds.has("agent-epsilon")).toBe(false);

    scheduler.destroy();
  });

  it("refreshes an invalid next duel pair during fighting camera selection", () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
        { id: "agent-delta", name: "Delta", position: [40, 0.2, 40] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phase = "FIGHTING";
    cycle.phaseStartTime = now - 180_000;
    cycle.agent1 = (scheduler as any).orchestrator.createContestant(
      "agent-alpha",
    );
    cycle.agent2 = (scheduler as any).orchestrator.createContestant(
      "agent-beta",
    );
    cycle.winnerId = null;
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-gamma",
      agent2Id: "agent-missing",
      selectedAt: now - 8_000,
    };

    const nextIds = (scheduler as any).camera.getNextDuelAgentIds(
      new Set(["agent-alpha", "agent-beta"]),
    ) as Set<string>;
    expect(nextIds).toEqual(new Set(["agent-gamma", "agent-delta"]));

    const nextPair = (scheduler as any).matchmaking.nextDuelPair as {
      agent1Id: string;
      agent2Id: string;
    } | null;
    expect(nextPair).toBeTruthy();
    expect(nextPair!.agent1Id).not.toBe(nextPair!.agent2Id);
    expect(["agent-gamma", "agent-delta"]).toContain(nextPair!.agent1Id);
    expect(["agent-gamma", "agent-delta"]).toContain(nextPair!.agent2Id);

    scheduler.destroy();
  });

  // ====================================================================
  // Lifecycle regression tests (Fixes A–G)
  // ====================================================================

  it("Fix A: startCountdown re-entry guard prevents duplicate prep", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");

    // Call startCountdown twice concurrently (simulates two ticks racing).
    const p1 = startCountdownAtMarketClose(scheduler);
    const p2 = startCountdownAtMarketClose(scheduler);
    await Promise.all([p1, p2]);

    // Should still have moved to COUNTDOWN exactly once.
    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");

    // Food should only have been added once per agent.
    const alphaFood = ctx.countFood("agent-alpha");
    const betaFood = ctx.countFood("agent-beta");
    // 28 slots - 0 occupied = 28 food per agent (single prep run)
    expect(alphaFood).toBeLessThanOrEqual(28);
    expect(betaFood).toBeLessThanOrEqual(28);

    scheduler.destroy();
  });

  it("cancels before countdown when the frozen agent policy has drifted", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const aborts = collectCycleAbortEvents(ctx);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    vi.spyOn(
      (scheduler as any).orchestrator,
      "validateCompetitiveAgentPolicies",
    ).mockResolvedValue({
      ok: false,
      reason: "competitive_agent_policy_drift",
    });

    await startCountdownAtMarketClose(scheduler);

    expectAuthoritativeCycleAbort(aborts, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "competitive_agent_policy_drift",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
  });

  it("revalidates the frozen agent policy at the fight bell", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const aborts = collectCycleAbortEvents(ctx);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    const cycle = scheduler.getCurrentCycle()!;
    vi.spyOn(
      (scheduler as any).orchestrator,
      "validateCompetitiveAgentPolicies",
    ).mockResolvedValue({
      ok: false,
      reason: "competitive_agent_policy_drift",
    });

    await (scheduler as any).doStartFight(Date.now());

    expectAuthoritativeCycleAbort(aborts, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "competitive_agent_policy_drift",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
  });

  it("cancels if the verified combat controller cannot start", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const aborts = collectCycleAbortEvents(ctx);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    const cycle = scheduler.getCurrentCycle()!;
    vi.spyOn(
      (scheduler as any).orchestrator,
      "startCombatAIs",
    ).mockRejectedValue(new Error("controller construction failed"));

    await (scheduler as any).doStartFight(Date.now());
    await Promise.resolve();

    expectAuthoritativeCycleAbort(aborts, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "competitive_agent_policy_unavailable",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
  });

  it("cancels on the first combat tick after the executing policy changes", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const aborts = collectCycleAbortEvents(ctx);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("FIGHTING");
    vi.spyOn(
      (scheduler as any).orchestrator,
      "hasCurrentCompetitiveAgentPolicies",
    ).mockReturnValue(false);

    await vi.advanceTimersByTimeAsync(600);

    expectAuthoritativeCycleAbort(aborts, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "competitive_agent_policy_drift",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
  });

  it("aborts failed arena staging before publishing a market", () => {
    const ctx = createMockWorld({
      failOnEmitEvent: "player:teleport",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);
    const scheduled = vi.fn();
    const cycleStarted = vi.fn();
    ctx.world.on("duel:scheduled", scheduled);
    ctx.world.on("streaming:cycle:started", cycleStarted);

    scheduler.init();

    expect(abortEvents).toEqual([
      expect.objectContaining({
        cycleId: expect.any(String),
        duelId: expect.any(String),
        duelKeyHex: expect.any(String),
        reason: "arena_teleport_failed",
      }),
    ]);
    const abortedContestants = abortEvents[0] as {
      agent1Id: string;
      agent2Id: string;
    };
    expect(
      [abortedContestants.agent1Id, abortedContestants.agent2Id].sort(),
    ).toEqual(["agent-alpha", "agent-beta"]);
    expect(scheduled).not.toHaveBeenCalled();
    expect(cycleStarted).not.toHaveBeenCalled();
    expect((scheduler as any)._startCountdownInProgress).toBe(false);
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect((scheduler as any).schedulerState).toBe("IDLE");
    expect(ctx.entities.get("agent-alpha")?.data.inStreamingDuel).toBe(false);
    expect(ctx.entities.get("agent-beta")?.data.inStreamingDuel).toBe(false);

    scheduler.destroy();
  });

  it("resets countdown guard and aborts if restaging fails at lock", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    vi.spyOn(
      (scheduler as any).orchestrator,
      "teleportToArena",
    ).mockImplementation(() => {
      throw new Error("Injected countdown restaging failure");
    });

    await startCountdownAtMarketClose(scheduler);

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "arena_teleport_failed",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect((scheduler as any)._startCountdownInProgress).toBe(false);
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect((scheduler as any).schedulerState).toBe("IDLE");
    expect(ctx.entities.get("agent-alpha")?.data.inStreamingDuel).toBe(false);
    expect(ctx.entities.get("agent-beta")?.data.inStreamingDuel).toBe(false);

    scheduler.destroy();
  });

  it("emits an authoritative cancellation when contestant preparation fails", async () => {
    const ctx = createMockWorld({
      failOnEmitEvent: "player:movement:cancel",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;

    await startCountdownAtMarketClose(scheduler);

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "contestant_prep_failed",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect((scheduler as any).schedulerState).toBe("IDLE");
    expect(ctx.entities.get("agent-alpha")?.data.inStreamingDuel).toBe(false);
    expect(ctx.entities.get("agent-beta")?.data.inStreamingDuel).toBe(false);

    scheduler.destroy();
  });

  it("emits an authoritative cancellation when the phase watchdog expires", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);
    scheduler.init();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phaseStartTime = Date.now() - 1_000_000;

    (scheduler as any).tick();

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "watchdog_announcement_timeout",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect((scheduler as any).schedulerState).toBe("IDLE");
    expect(ctx.entities.get("agent-alpha")?.data.inStreamingDuel).toBe(false);
    expect(ctx.entities.get("agent-beta")?.data.inStreamingDuel).toBe(false);

    scheduler.destroy();
  });

  it("Fix B: startFight guards against wrong phase", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    // Force phase to ANNOUNCEMENT (not COUNTDOWN).
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phase = "ANNOUNCEMENT";

    // Calling startFight should be a no-op.
    (scheduler as any).orchestrator.startFight();
    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");

    scheduler.destroy();
  });

  it("Fix B: startFight resolves to survivor when one agent is dead", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");

    // Kill agent-beta before fight starts.
    const beta = ctx.entities.get("agent-beta")!;
    beta.data.health = 0;

    // Fire startFight (simulating the countdown timeout).
    (scheduler as any).orchestrator.startFight();

    // Should go to RESOLUTION with alpha as winner.
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");
    expect(scheduler.getCurrentCycle()?.winnerId).toBe("agent-alpha");
    expect(scheduler.getCurrentCycle()?.loserId).toBe("agent-beta");

    scheduler.destroy();
  });

  it("Fix B: startFight aborts to idle when both agents are missing", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const abortEvents = collectCycleAbortEvents(ctx);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");
    const cycle = scheduler.getCurrentCycle()!;

    // Remove both agents from the world.
    ctx.entities.delete("agent-alpha");
    ctx.entities.delete("agent-beta");

    await (scheduler as any).doStartFight(Date.now());

    expectAuthoritativeCycleAbort(abortEvents, {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      reason: "both_agents_missing",
      agent1Id: cycle.agent1?.characterId ?? null,
      agent2Id: cycle.agent2?.characterId ?? null,
    });
    expect(scheduler.getCurrentCycle()).toBeNull();

    scheduler.destroy();
  });

  it("Fix C: startResolution is idempotent (double-call is no-op)", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");
    const resolvingContestantIds = [
      scheduler.getCurrentCycle()?.agent1?.characterId,
      scheduler.getCurrentCycle()?.agent2?.characterId,
    ];
    const forceEndCallsBeforeResolution = ctx.forceEndCombatCalls.length;

    // First call should transition to RESOLUTION.
    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");
    expect(scheduler.getCurrentCycle()?.winnerId).toBe("agent-alpha");
    expect(
      ctx.forceEndCombatCalls.slice(forceEndCallsBeforeResolution),
    ).toEqual(resolvingContestantIds);

    // Second call should be a no-op (phase is now RESOLUTION, not FIGHTING).
    (scheduler as any).orchestrator.startResolution(
      "agent-beta",
      "agent-alpha",
      "kill",
    );
    // Winner should still be agent-alpha from first call.
    expect(scheduler.getCurrentCycle()?.winnerId).toBe("agent-alpha");

    scheduler.destroy();
  });

  it("Fix E: queueMicrotask clears flags on correct cycle snapshot", async () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
        { id: "agent-delta", name: "Delta", position: [40, 0.2, 40] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    // Identify which agents were selected for this cycle.
    const cycle = scheduler.getCurrentCycle()!;
    const id1 = cycle.agent1!.characterId;
    const id2 = cycle.agent2!.characterId;
    const entity1 = ctx.entities.get(id1)!;
    const entity2 = ctx.entities.get(id2)!;

    // Verify duel flags are set on the cycle's agents.
    expect(entity1.data.inStreamingDuel).toBe(true);
    expect(entity2.data.inStreamingDuel).toBe(true);
    expect(entity1.data.streamingDuelOpponentId).toBe(id2);
    expect(entity2.data.streamingDuelOpponentId).toBe(id1);
    const combatRoles = (
      (scheduler as any).orchestrator as {
        combatRolesByAgent: Map<string, string>;
      }
    ).combatRolesByAgent;
    expect(entity1.data.streamingDuelCombatRole).toBe(combatRoles.get(id1));
    expect(entity2.data.streamingDuelCombatRole).toBe(combatRoles.get(id2));
    expect(entity1.data.streamingDuelWeaponId).toBe(ctx.getEquippedWeapon(id1));
    expect(entity2.data.streamingDuelWeaponId).toBe(ctx.getEquippedWeapon(id2));

    const allAgentIds = [
      "agent-alpha",
      "agent-beta",
      "agent-gamma",
      "agent-delta",
    ];
    const nextPair = allAgentIds.filter(
      (agentId) => agentId !== id1 && agentId !== id2,
    );
    (scheduler as any).nextDuelPair = {
      agent1Id: nextPair[0],
      agent2Id: nextPair[1],
      selectedAt: Date.now(),
    };

    // Trigger resolution (cleanup is now deferred to endCycle).
    (scheduler as any).orchestrator.startResolution(id1, id2, "kill");

    // Advance through the resolution phase so endCycle + cleanup fires.
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const newCycle = scheduler.getCurrentCycle();
    expect(newCycle?.phase).toBe("ANNOUNCEMENT");

    // Flags should be cleared on the OLD cycle's agents, not corrupted.
    expect(entity1.data.inStreamingDuel).toBe(false);
    expect(entity2.data.inStreamingDuel).toBe(false);
    expect(entity1.data.preventRespawn).toBe(false);
    expect(entity2.data.preventRespawn).toBe(false);
    expect(entity1.data.streamingDuelOpponentId).toBeNull();
    expect(entity2.data.streamingDuelOpponentId).toBeNull();
    expect(entity1.data.streamingDuelCombatRole).toBeNull();
    expect(entity2.data.streamingDuelCombatRole).toBeNull();
    expect(entity1.data.streamingDuelWeaponId).toBeNull();
    expect(entity2.data.streamingDuelWeaponId).toBeNull();

    scheduler.destroy();
  });

  it("does not admit a new cycle until failed contestant cleanup succeeds", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");

    const orchestrator = (scheduler as any).orchestrator;
    const cleanupAfterDuel = orchestrator.cleanupAfterDuel.bind(orchestrator);
    const cleanupSpy = vi
      .spyOn(orchestrator, "cleanupAfterDuel")
      .mockRejectedValueOnce(new Error("cleanup failure"))
      .mockImplementation(cleanupAfterDuel);

    ctx.world.network.send.mockClear();
    (scheduler as any).endCycle();

    expect(ctx.world.network.send).toHaveBeenCalledWith(
      "streamingState",
      expect.objectContaining({
        cycle: expect.objectContaining({ phase: "IDLE" }),
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);

    expect(cleanupSpy).toHaveBeenCalledOnce();
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect((scheduler as any)._endCycleInProgress).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    expect(scheduler.getCurrentCycle()).toBeNull();

    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.INTER_CYCLE_DELAY_MS);

    const newCycle = scheduler.getCurrentCycle();
    expect(newCycle?.phase).toBe("ANNOUNCEMENT");
    expect(newCycle?.agent1?.characterId).toBeTruthy();
    expect(newCycle?.agent2?.characterId).toBeTruthy();

    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;
    expect(alpha.data.inStreamingDuel).toBe(true);
    expect(beta.data.inStreamingDuel).toBe(true);
    expect(alpha.data.preventRespawn).toBe(true);
    expect(beta.data.preventRespawn).toBe(true);

    cleanupSpy.mockRestore();
    scheduler.destroy();
  });

  it("completes cleanup teleports before reselecting the same duelers", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    expect(scheduler.getCurrentCycle()?.phase).toBe("FIGHTING");

    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");

    const teleportSpy = vi.spyOn(
      (scheduler as any).orchestrator,
      "teleportPlayer",
    );
    teleportSpy.mockClear();

    // With only two agents in the pool, the next cycle is the same pair.
    (scheduler as any).endCycle();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.INTER_CYCLE_DELAY_MS);
    const nextCycle = scheduler.getCurrentCycle();
    expect(nextCycle?.phase).toBe("ANNOUNCEMENT");
    expect(
      [
        nextCycle?.agent1?.characterId ?? "",
        nextCycle?.agent2?.characterId ?? "",
      ].sort(),
    ).toEqual(["agent-alpha", "agent-beta"]);

    // Let async cleanup continuation run.
    await Promise.resolve();
    await Promise.resolve();

    // Cleanup is serialized before the next cycle: each agent first returns
    // to its original position, then the new ANNOUNCEMENT stages it in-ring.
    expect(teleportSpy).toHaveBeenCalledTimes(4);
    for (const [agentId, originalPosition] of [
      ["agent-alpha", [10, 0.2, 10]],
      ["agent-beta", [20, 0.2, 20]],
    ] as const) {
      const calls = teleportSpy.mock.calls.filter(
        ([calledAgentId]) => calledAgentId === agentId,
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toEqual(originalPosition);
      const stagedPosition = calls[1]![1] as [number, number, number];
      expect(
        isPositionInsideCombatArena(stagedPosition[0], stagedPosition[2]),
      ).toBe(true);
    }

    teleportSpy.mockRestore();
    scheduler.destroy();
  });

  it("publishes neutral current state for a repeated-pair IDLE preview", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    const cycle = scheduler.getCurrentCycle()!;
    expect(cycle.phase).toBe("FIGHTING");
    const agent1 = cycle.agent1!;
    const agent2 = cycle.agent2!;

    agent1.currentHp = 0;
    agent1.damageDealtThisFight = 60;
    agent1.highestHit = 20;
    agent1.attacksLanded = 4;
    agent1.healsUsed = 3;
    agent2.currentHp = 9;
    agent2.damageDealtThisFight = 11;
    agent2.highestHit = 7;
    agent2.attacksLanded = 2;
    agent2.healsUsed = 1;
    ctx.entities.get(agent1.characterId)!.data.health = 0;
    ctx.entities.get(agent2.characterId)!.data.health = 9;

    (scheduler as any).orchestrator.startResolution(
      agent2.characterId,
      agent1.characterId,
      "kill",
    );
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");

    // Populate the reusable public objects with the terminal fight frame.
    const terminalCycle = scheduler.getStreamingState().cycle;
    const terminalAgent1 =
      terminalCycle.agent1?.id === agent1.characterId
        ? terminalCycle.agent1
        : terminalCycle.agent2;
    expect(terminalAgent1).toMatchObject({
      hp: 0,
      damageDealtThisFight: 60,
      highestHit: 20,
      attacksLanded: 4,
      healsUsed: 3,
    });

    // With only two agents available, IDLE previews the same pair after cleanup.
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: agent1.characterId,
      agent2Id: agent2.characterId,
      selectedAt: Date.now(),
    };
    (scheduler as any).endCycle();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.getCurrentCycle()).toBeNull();
    const idleCycle = scheduler.getStreamingState().cycle;
    expect(idleCycle.phase).toBe("IDLE");
    expect(
      [idleCycle.agent1?.id ?? "", idleCycle.agent2?.id ?? ""].sort(),
    ).toEqual([agent1.characterId, agent2.characterId].sort());

    const previews = [idleCycle.agent1!, idleCycle.agent2!];
    for (const preview of previews) {
      expect(preview.hp).toBe(preview.maxHp);
      expect(preview).toMatchObject({
        damageDealtThisFight: 0,
        highestHit: 0,
        attacksLanded: 0,
        healsUsed: 0,
        loadoutFingerprint: null,
        availableCombatStyles: [],
        combatLoadouts: {},
        loadoutFrozen: false,
      });
    }

    scheduler.destroy();
  });

  it("preserves new-cycle duel food tracking when old cleanup resolves late", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(4000);

    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");

    let releaseRemovals: (() => void) | undefined;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemovals = () => resolve();
    });
    const removeSpy = vi
      .spyOn((scheduler as any).orchestrator, "removeDuelFood")
      .mockImplementation(async () => {
        await removalGate;
      });

    (scheduler as any).endCycle();
    expect(scheduler.getCurrentCycle()).toBeNull();

    const duelFoodSlotsByAgent = (
      scheduler as any
    ).orchestrator.getDuelFoodSlotsByAgent() as Map<
      string,
      Array<{ slot: number; itemId: string }>
    >;
    const nextAlphaSlots = [{ slot: 101, itemId: "shark" }];
    const nextBetaSlots = [{ slot: 103, itemId: "shark" }];
    duelFoodSlotsByAgent.set("agent-alpha", nextAlphaSlots);
    duelFoodSlotsByAgent.set("agent-beta", nextBetaSlots);

    if (!releaseRemovals) {
      throw new Error("Expected removal gate resolver to be initialized");
    }
    releaseRemovals();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.INTER_CYCLE_DELAY_MS);

    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");

    expect(duelFoodSlotsByAgent.get("agent-alpha")).toBe(nextAlphaSlots);
    expect(duelFoodSlotsByAgent.get("agent-beta")).toBe(nextBetaSlots);

    removeSpy.mockRestore();
    scheduler.destroy();
  });

  it("ignores a stale countdown death event for a living contestant", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");

    // Simulate a late event from an earlier fight after cleanup restored HP.
    ctx.world.emit(EventType.ENTITY_DEATH, {
      entityId: "agent-beta",
      killedBy: "agent-alpha",
    });
    await Promise.resolve();

    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");
    expect(scheduler.getCurrentCycle()?.winnerId).toBeNull();

    // A real countdown death still resolves once authoritative health is zero.
    ctx.entities.get("agent-beta")!.data.health = 0;
    ctx.world.emit(EventType.ENTITY_DEATH, {
      entityId: "agent-beta",
      killedBy: "agent-alpha",
    });
    await Promise.resolve();

    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");
    expect(scheduler.getCurrentCycle()?.winnerId).toBe("agent-alpha");
    expect(scheduler.getCurrentCycle()?.loserId).toBe("agent-beta");

    scheduler.destroy();
  });

  it("accounts for the terminal hit before resolving an authoritative death", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

    const cycle = scheduler.getCurrentCycle()!;
    const alpha = cycle.agent1!;
    const beta = cycle.agent2!;
    ctx.entities.get(beta.characterId)!.data.health = 0;
    ctx.world.network.send.mockClear();

    // This is CombatSystem's synchronous order: death is emitted from inside
    // damage application, then COMBAT_DAMAGE_DEALT is emitted by the caller.
    ctx.world.emit(EventType.ENTITY_DEATH, {
      entityId: beta.characterId,
      killedBy: alpha.characterId,
    });
    ctx.world.emit(EventType.COMBAT_DAMAGE_DEALT, {
      attackerId: alpha.characterId,
      targetId: beta.characterId,
      damage: 6,
    });

    expect(cycle.phase).toBe("FIGHTING");
    await Promise.resolve();

    expect(cycle.phase).toBe("RESOLUTION");
    expect(cycle.winnerId).toBe(alpha.characterId);
    expect(alpha.attacksLanded).toBe(1);
    expect(alpha.damageDealtThisFight).toBe(6);
    expect(beta.currentHp).toBe(0);
    expect(ctx.world.network.send).toHaveBeenCalledTimes(1);
    expect(ctx.world.network.send).toHaveBeenCalledWith(
      "streamingState",
      expect.objectContaining({
        cycle: expect.objectContaining({
          phase: "RESOLUTION",
          winnerId: alpha.characterId,
          winReason: "kill",
          agent2: expect.objectContaining({ hp: 0 }),
        }),
      }),
    );

    scheduler.destroy();
  });

  it("synchronizes PlayerSystem's hidden health pool during duel restoration", async () => {
    const ctx = createMockWorld();
    const originalGetSystem = ctx.world.getSystem;
    const restorePlayerHealth = vi.fn(() => true);
    ctx.world.getSystem = (name: string) =>
      name === "player" ? { restorePlayerHealth } : originalGetSystem(name);

    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(restorePlayerHealth).toHaveBeenCalledWith("agent-alpha", 20);
    expect(restorePlayerHealth).toHaveBeenCalledWith("agent-beta", 20);

    const callsAfterPrep = restorePlayerHealth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);
    expect(restorePlayerHealth.mock.calls.length).toBeGreaterThan(
      callsAfterPrep,
    );

    scheduler.destroy();
  });

  it("ignores a completed-duel event from an older cycle", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.COUNTDOWN_DURATION);

    const cycle = scheduler.getCurrentCycle()!;
    const winnerId = cycle.agent1!.characterId;
    const loserId = cycle.agent2!.characterId;
    ctx.world.emit(EventType.DUEL_COMPLETED, {
      duelId: "streaming-older-cycle",
      winnerId,
      loserId,
    });
    expect(cycle.phase).toBe("FIGHTING");

    ctx.world.emit(EventType.DUEL_COMPLETED, {
      duelId: cycle.duelId,
      winnerId,
      loserId,
    });
    expect(cycle.phase).toBe("RESOLUTION");

    scheduler.destroy();
  });

  it("Fix G: endFightByTimeout is no-op when phase is not FIGHTING", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    // Phase is COUNTDOWN, not FIGHTING.
    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");

    // Should be a no-op.
    (scheduler as any).orchestrator.endFightByTimeout();
    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");

    scheduler.destroy();
  });

  it("Fix C: startResolution clears countdown timeout on forfeit during countdown", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    await startCountdownAtMarketClose(scheduler);

    expect(scheduler.getCurrentCycle()?.phase).toBe("COUNTDOWN");
    expect((scheduler as any).countdownTimeout).not.toBeNull();

    // Forfeit during countdown.
    (scheduler as any).orchestrator.startResolution(
      "agent-alpha",
      "agent-beta",
      "kill",
    );

    // Countdown timeout should be cleared.
    expect((scheduler as any).countdownTimeout).toBeNull();
    expect(scheduler.getCurrentCycle()?.phase).toBe("RESOLUTION");

    scheduler.destroy();
  });

  it("locks camera to winner during resolution", () => {
    const ctx = createMockWorld({
      extraAgents: [
        { id: "agent-gamma", name: "Gamma", position: [30, 0.2, 30] },
      ],
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const now = Date.now();
    const cycle = scheduler.getCurrentCycle()!;
    cycle.phase = "RESOLUTION";
    cycle.agent1 = (scheduler as any).orchestrator.createContestant(
      "agent-alpha",
    );
    cycle.agent2 = (scheduler as any).orchestrator.createContestant(
      "agent-beta",
    );
    cycle.winnerId = "agent-beta";

    (scheduler as any).camera._cameraTarget = "agent-gamma";
    (scheduler as any).camera.lastCameraSwitchTime = now - 60_000;

    (scheduler as any).camera.updateCameraTarget(now);
    expect((scheduler as any).camera.cameraTarget).toBe("agent-beta");

    scheduler.destroy();
  });

  it("caches leaderboard and returns same reference when stats are unchanged", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const lb1 = scheduler.getLeaderboard();
    const lb2 = scheduler.getLeaderboard();

    // Same reference — no recomputation
    expect(lb1).toBe(lb2);
    expect(lb1.length).toBeGreaterThan(0);
    expect(lb1.map((entry) => entry.combatLevel)).toEqual([14, 14]);

    scheduler.destroy();
  });

  it("invalidates leaderboard cache after updateStats", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    const lb1 = scheduler.getLeaderboard();

    // Simulate a duel result
    (scheduler as any).matchmaking.updateStats("agent-alpha", "agent-beta");

    const lb2 = scheduler.getLeaderboard();

    // New reference — was recomputed
    expect(lb1).not.toBe(lb2);

    // Verify stats updated
    const alpha = lb2.find(
      (e: { characterId: string }) => e.characterId === "agent-alpha",
    );
    expect(alpha?.wins).toBe(1);

    scheduler.destroy();
  });

  it("prunes inactive agent stats to prevent unbounded memory growth", () => {
    const extraAgents = Array.from({ length: 620 }, (_, i) => ({
      id: `agent-extra-${i}`,
      name: `Extra ${i}`,
      position: [100 + i, 0.2, 100] as [number, number, number],
    }));
    const ctx = createMockWorld({ extraAgents });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    scheduler.registerAgent("agent-alpha");
    scheduler.registerAgent("agent-beta");
    for (const agent of extraAgents) {
      scheduler.registerAgent(agent.id);
    }

    expect(scheduler.getLeaderboard().length).toBeGreaterThan(512);

    for (const agent of extraAgents) {
      scheduler.unregisterAgent(agent.id);
    }

    const leaderboard = scheduler.getLeaderboard();
    expect(leaderboard.length).toBeLessThanOrEqual(512);
    expect(
      leaderboard.some((entry) => entry.characterId === "agent-alpha"),
    ).toBe(true);
    expect(
      leaderboard.some((entry) => entry.characterId === "agent-beta"),
    ).toBe(true);

    scheduler.destroy();
  });

  it("applies a generated standalone sparbot profile to its DB-free live entity", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const profile = {
      attackLevel: 61,
      strengthLevel: 66,
      defenseLevel: 42,
      constitutionLevel: 59,
      rangedLevel: 1,
      magicLevel: 1,
      prayerLevel: 12,
      combatLevel: 68,
    };

    (
      scheduler as unknown as {
        applySparbotStatsToWorldEntity(
          characterId: string,
          skills: typeof profile,
        ): void;
      }
    ).applySparbotStatsToWorldEntity("agent-alpha", profile);

    const alpha = ctx.entities.get("agent-alpha")!;
    expect(alpha.data.health).toBe(59);
    expect(alpha.data.maxHealth).toBe(59);
    expect(alpha.data.skills).toMatchObject({
      attack: { level: 61, xp: 302264 },
      strength: { level: 66, xp: 496229 },
      defense: { level: 42, xp: 45513 },
      constitution: { level: 59, xp: 247862 },
      ranged: { level: 1, xp: 0 },
      magic: { level: 1, xp: 0 },
      prayer: { level: 12, xp: 1580 },
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
    });
    expect(alpha.data).toMatchObject({ combatLevel: 68, level: 68 });

    scheduler.destroy();
  });

  it("derives every generated sparbot tier and style with the canonical combat formula", () => {
    const generate = (
      StreamingDuelScheduler as unknown as {
        sparbotSkills(
          style: "melee" | "ranged" | "mage" | "prayer",
          tier: "novice" | "adept" | "expert",
          profileSeed?: number,
          multiStyle?: boolean,
        ): {
          attackLevel: number;
          strengthLevel: number;
          defenseLevel: number;
          constitutionLevel: number;
          rangedLevel: number;
          magicLevel: number;
          prayerLevel: number;
          combatLevel: number;
        };
      }
    ).sparbotSkills;

    for (const style of ["melee", "ranged", "mage", "prayer"] as const) {
      for (const tier of ["novice", "adept", "expert"] as const) {
        const profile = generate(style, tier);
        expect(profile.combatLevel).toBe(
          calculateCombatLevel({
            attack: profile.attackLevel,
            strength: profile.strengthLevel,
            defense: profile.defenseLevel,
            hitpoints: profile.constitutionLevel,
            ranged: profile.rangedLevel,
            magic: profile.magicLevel,
            prayer: profile.prayerLevel,
          }),
        );
      }
    }

    const seededProfile = generate("melee", "adept", 0x5eed1234);
    expect(generate("melee", "adept", 0x5eed1234)).toEqual(seededProfile);
    expect(generate("melee", "adept", 0x5eed1235)).not.toEqual(seededProfile);
    const multiStyleProfile = generate("melee", "adept", 0x5eed1234, true);
    expect(multiStyleProfile).toEqual(
      generate("melee", "adept", 0x5eed1234, true),
    );
    expect(multiStyleProfile.attackLevel).toBeGreaterThanOrEqual(55);
    expect(multiStyleProfile.strengthLevel).toBeGreaterThanOrEqual(60);
    expect(multiStyleProfile.rangedLevel).toBeGreaterThanOrEqual(60);
    expect(multiStyleProfile.magicLevel).toBeGreaterThanOrEqual(60);
    expect(multiStyleProfile.combatLevel).toBe(
      calculateCombatLevel({
        attack: multiStyleProfile.attackLevel,
        strength: multiStyleProfile.strengthLevel,
        defense: multiStyleProfile.defenseLevel,
        hitpoints: multiStyleProfile.constitutionLevel,
        ranged: multiStyleProfile.rangedLevel,
        magic: multiStyleProfile.magicLevel,
        prayer: multiStyleProfile.prayerLevel,
      }),
    );
    expect(() => generate("melee", "adept", -1)).toThrow(
      "unsigned 32-bit integer",
    );
  });

  it("returns recent duels without unnecessary object cloning", () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();

    // Insert a duel record
    (scheduler as any).matchmaking.recordRecentDuel({
      cycleId: "test-1",
      duelId: "d1",
      finishedAt: Date.now(),
      outcome: "win",
      agent1Id: "agent-alpha",
      agent1Name: "Alpha",
      agent1OpeningStyle: "melee",
      agent2Id: "agent-beta",
      agent2Name: "Beta",
      agent2OpeningStyle: "ranged",
      winnerId: "agent-alpha",
      winnerName: "Alpha",
      loserId: "agent-beta",
      loserName: "Beta",
      winReason: "kill",
      cancellationReason: null,
      damageAgent1: 50,
      damageAgent2: 30,
      damageWinner: 50,
      damageLoser: 30,
    });

    const duels1 = scheduler.getRecentDuels(10);
    const duels2 = scheduler.getRecentDuels(10);

    // Records should be same reference (no cloning)
    expect(duels1[0]).toBe(duels2[0]);

    scheduler.destroy();
  });

  it("requires an explicit bounded private-preparation duration", () => {
    expect(resolveStreamingPreparationDuration({})).toBeNull();
    expect(
      resolveStreamingPreparationDuration({
        STREAMING_DUEL_PREPARATION_MS: "90000",
      }),
    ).toBe(90_000);
    expect(() =>
      resolveStreamingPreparationDuration({
        STREAMING_DUEL_PREPARATION_MS: "999",
      }),
    ).toThrow(/at least 1000/);
    expect(() =>
      resolveStreamingPreparationDuration({
        STREAMING_DUEL_PREPARATION_MS: "not-a-duration",
      }),
    ).toThrow(/base-10 integer/);
    expect(() =>
      resolveStreamingPreparationDuration({
        STREAMING_DUEL_PREPARATION_MS: "90000ms",
      }),
    ).toThrow(/base-10 integer/);
    expect(() =>
      resolveStreamingPreparationDuration({
        STREAMING_DUEL_PREPARATION_MS: "   ",
      }),
    ).toThrow(/base-10 integer/);
  });

  it("keeps the public preparation floor explicit and inside the private deadline", () => {
    expect(resolveStreamingPublicPreparationMinimumDuration({})).toBe(0);
    expect(
      resolveStreamingPublicPreparationMinimumDuration({
        STREAMING_DUEL_PREPARATION_MS: "60000",
        STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS: "10000",
      }),
    ).toBe(10_000);
    expect(
      resolveStreamingPublicPreparationMinimumDuration({
        STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS: "0",
      }),
    ).toBe(0);
    expect(() =>
      resolveStreamingPublicPreparationMinimumDuration({
        STREAMING_DUEL_PREPARATION_MS: "60000",
        STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS: "999",
      }),
    ).toThrow(/zero or at least 1000/);
    expect(() =>
      resolveStreamingPublicPreparationMinimumDuration({
        STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS: "10000",
      }),
    ).toThrow(/requires STREAMING_DUEL_PREPARATION_MS/);
    expect(() =>
      resolveStreamingPublicPreparationMinimumDuration({
        STREAMING_DUEL_PREPARATION_MS: "60000",
        STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS: "60000",
      }),
    ).toThrow(/must be below/);
    expect(() =>
      resolveStreamingPublicPreparationMinimumDuration({
        STREAMING_DUEL_PREPARATION_MS: "60000",
        STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS: "10s",
      }),
    ).toThrow(/base-10 integer/);
  });

  it("resumes the exact persisted competitive snapshot after scheduler authority handoff", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });
    const scheduled: any[] = [];
    const recoveryPresentationOrder: string[] = [];
    let scheduledArenaPositions: unknown = null;
    ctx.world.on("player:teleport", (event: any) => {
      if (event.playerId === "agent-alpha" || event.playerId === "agent-beta") {
        recoveryPresentationOrder.push(`teleport:${event.playerId}`);
      }
    });
    ctx.world.on("duel:scheduled", (event) => {
      recoveryPresentationOrder.push("scheduled");
      scheduledArenaPositions = scheduler.getCurrentCycle()?.arenaPositions;
      scheduled.push(event);
    });

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(scheduler.getCurrentCycle()).not.toBeNull());

    expect(
      store.claimLatestCompetitiveSnapshotForRecovery,
    ).toHaveBeenCalledWith("41");
    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect(scheduler.getCurrentCycle()).toMatchObject({
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      duelKeyHex: competitive.snapshot.duelKey,
      competitiveSnapshotDigest: competitive.digest,
      phase: "ANNOUNCEMENT",
    });
    expect(scheduled).toEqual([
      expect.objectContaining({
        duelId: competitive.snapshot.duelId,
        competitiveSnapshotDigest: competitive.digest,
        recovered: true,
      }),
    ]);
    expect(recoveryPresentationOrder).toEqual([
      "teleport:agent-alpha",
      "teleport:agent-beta",
      "scheduled",
    ]);
    expect(scheduledArenaPositions).toEqual({
      agent1: ctx.entities.get("agent-alpha")?.data.position,
      agent2: ctx.entities.get("agent-beta")?.data.position,
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("replays each immutable whole-plan receipt before reconstructing recovered loadouts", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
      recoverPreparationEquipment: {
        "agent-alpha": { weaponId: RECOVERY_ALPHA_WEAPON },
        "agent-beta": { weaponId: RECOVERY_BETA_WEAPON },
      },
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    const equipmentSystem = ctx.world.getSystem("equipment") as {
      equipItemDirect(playerId: string, itemId: string): Promise<unknown>;
    };
    await equipmentSystem.equipItemDirect("agent-alpha", RECOVERY_BETA_WEAPON);
    await equipmentSystem.equipItemDirect("agent-beta", RECOVERY_ALPHA_WEAPON);
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(scheduler.getCurrentCycle()).not.toBeNull());

    expect(ctx.recoverPreparationCalls).toEqual([
      {
        playerId: "agent-alpha",
        preparationId: competitive.preparation.preparationId,
      },
      {
        playerId: "agent-beta",
        preparationId: competitive.preparation.preparationId,
      },
    ]);
    expect(ctx.getEquippedWeapon("agent-alpha")).toBe(RECOVERY_ALPHA_WEAPON);
    expect(ctx.getEquippedWeapon("agent-beta")).toBe(RECOVERY_BETA_WEAPON);
    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("primes overlapping recovery custody holds before agents can mutate frozen state", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    const secondPreparationId = "00000000-0000-4000-8000-000000000099";
    const events: unknown[] = [];
    ctx.world.on(DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT, (event) => {
      events.push(event);
    });
    const store = {
      listCompetitiveRecoveryCustodyHolds: vi.fn(async () => [
        {
          preparationId: competitive.preparation.preparationId,
          agent1Id: "agent-alpha",
          agent2Id: "agent-beta",
        },
        {
          preparationId: secondPreparationId,
          agent1Id: "agent-alpha",
          agent2Id: "agent-gamma",
        },
      ]),
    };
    Object.assign(scheduler as any, { preparationStore: store });

    await scheduler.primeCompetitiveRecoveryCustodyHolds();

    expect(store.listCompetitiveRecoveryCustodyHolds).toHaveBeenCalledOnce();
    expect(ctx.entities.get("agent-alpha")?.data).toMatchObject({
      inStreamingDuel: true,
      preventRespawn: true,
    });
    expect(ctx.entities.get("agent-beta")?.data).toMatchObject({
      inStreamingDuel: true,
      preventRespawn: true,
    });
    expect(events).toContainEqual({
      preparationId: competitive.preparation.preparationId,
      agentId: "agent-alpha",
      active: true,
    });

    (scheduler as any).releaseCompetitiveRecoveryCustodyHold(
      competitive.preparation.preparationId,
    );
    expect(ctx.entities.get("agent-alpha")?.data.inStreamingDuel).toBe(true);
    expect(ctx.entities.get("agent-beta")?.data.inStreamingDuel).toBe(false);

    (scheduler as any).releaseCompetitiveRecoveryCustodyHold(
      secondPreparationId,
    );
    expect(ctx.entities.get("agent-alpha")?.data.inStreamingDuel).toBe(false);
    expect(events).toContainEqual({
      preparationId: secondPreparationId,
      agentId: "agent-alpha",
      active: false,
    });

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("keeps a frozen market recoverable while cold-start contestants reconnect", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    const alpha = ctx.entities.get("agent-alpha")!;
    const beta = ctx.entities.get("agent-beta")!;
    ctx.entities.delete("agent-alpha");
    ctx.entities.delete("agent-beta");
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "42",
      preparationDurationMs: 60_000,
    });

    scheduler.init();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect((scheduler as any).competitiveRecoveryChecked).toBe(false);
    expect(scheduler.getCurrentCycle()).toBeNull();

    ctx.entities.set("agent-alpha", alpha);
    ctx.entities.set("agent-beta", beta);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(scheduler.getCurrentCycle()).not.toBeNull());

    expect(scheduler.getCurrentCycle()).toMatchObject({
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      duelKeyHex: competitive.snapshot.duelKey,
      phase: "ANNOUNCEMENT",
    });
    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("defers frozen-snapshot recovery while authoritative equipment is hydrating", async () => {
    let equipmentReady = true;
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
      equipmentReady: () => equipmentReady,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    const equipmentSystem = ctx.world.getSystem("equipment") as {
      equipItemDirect(
        playerId: string,
        itemId: string,
      ): Promise<{ success: boolean }>;
      unequipItemDirect(
        playerId: string,
        slotName: string,
      ): Promise<{ success: boolean }>;
    };
    equipmentReady = false;
    await equipmentSystem.unequipItemDirect("agent-alpha", "weapon");
    await equipmentSystem.unequipItemDirect("agent-beta", "weapon");
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "42",
      preparationDurationMs: 60_000,
    });

    scheduler.init();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect((scheduler as any).competitiveRecoveryChecked).toBe(false);
    expect(scheduler.getCurrentCycle()).toBeNull();

    await equipmentSystem.equipItemDirect("agent-alpha", RECOVERY_ALPHA_WEAPON);
    await equipmentSystem.equipItemDirect("agent-beta", RECOVERY_BETA_WEAPON);
    equipmentReady = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(scheduler.getCurrentCycle()).not.toBeNull());

    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect(
      store.claimLatestCompetitiveSnapshotForRecovery.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(scheduler.getCurrentCycle()).toMatchObject({
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      competitiveSnapshotDigest: competitive.digest,
      phase: "ANNOUNCEMENT",
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("defers frozen-snapshot recovery until the full player projection is hydrated", async () => {
    let playerReady = true;
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
      playerReady: () => playerReady,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    playerReady = false;
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "42",
      preparationDurationMs: 60_000,
    });

    scheduler.init();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect((scheduler as any).competitiveRecoveryChecked).toBe(false);
    expect(scheduler.getCurrentCycle()).toBeNull();

    playerReady = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(scheduler.getCurrentCycle()).not.toBeNull());

    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect(scheduler.getCurrentCycle()).toMatchObject({
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      competitiveSnapshotDigest: competitive.digest,
      phase: "ANNOUNCEMENT",
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("durably cancels a recovered snapshot whose immutable betting window elapsed", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - STREAMING_TIMING.ANNOUNCEMENT_DURATION - 1,
    );
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(async ({ terminal }: any) => ({
        ...competitive,
        lifecycleStatus: "terminal",
        terminal,
      })),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });
    const aborts = collectCycleAbortEvents(ctx);

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce(),
    );

    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        preparationId: competitive.preparation.preparationId,
        fencingToken: "41",
        snapshotDigest: competitive.digest,
        terminal: expect.objectContaining({
          outcome: "cancelled",
          cancellationReason: "competitive_snapshot_recovery_window_elapsed",
        }),
      }),
    );
    expectAuthoritativeCycleAbort(aborts, {
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      duelKeyHex: competitive.snapshot.duelKey,
      reason: "competitive_snapshot_recovery_window_elapsed",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("durably cancels recovery when the live agent policy no longer matches the market commitment", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    vi.mocked(
      (scheduler as any).orchestrator.validateCompetitiveAgentPolicies,
    ).mockResolvedValue({
      ok: false,
      reason: "competitive_agent_policy_drift",
    });
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(async ({ terminal }: any) => ({
        ...competitive,
        lifecycleStatus: "terminal",
        terminal,
      })),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });
    const aborts = collectCycleAbortEvents(ctx);

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce(),
    );

    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          cancellationReason: "competitive_snapshot_recovery_policy_drift",
        }),
      }),
    );
    expectAuthoritativeCycleAbort(aborts, {
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      duelKeyHex: competitive.snapshot.duelKey,
      reason: "competitive_snapshot_recovery_policy_drift",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it.each([1, 2] as const)(
    "durably cancels a schema-v%i active snapshot before reinterpreting its loadout contract",
    async (snapshotVersion) => {
      const ctx = createMockWorld({
        alphaWeaponId: RECOVERY_ALPHA_WEAPON,
        betaWeaponId: RECOVERY_BETA_WEAPON,
      });
      const scheduler = new StreamingDuelScheduler(ctx.world as never);
      const current = buildPersistedCompetitiveTestSnapshot(
        scheduler,
        Date.now() - 1_000,
      );
      vi.mocked(
        (scheduler as any).orchestrator.validateCompetitiveAgentPolicies,
      ).mockRestore();
      const legacySnapshot = structuredClone(current.snapshot);
      legacySnapshot.snapshotVersion = snapshotVersion;
      legacySnapshot.combatPolicyVersion = "duel-combat-policy-v1";
      for (const contestant of legacySnapshot.contestants) {
        if (snapshotVersion === 1) {
          delete contestant.preparation.tacticalStrategy;
        }
        for (const loadout of Object.values(contestant.combatLoadouts)) {
          if (loadout) delete loadout.armorIds;
        }
      }
      const competitive: PersistedCompetitiveSnapshot = {
        ...current,
        snapshot: legacySnapshot,
        digest: digestCompetitiveSnapshot(legacySnapshot),
      };
      const store = {
        claimLatestCompetitiveSnapshotForRecovery: vi.fn(
          async () => competitive,
        ),
        markCompetitiveSnapshotTerminal: vi.fn(async ({ terminal }: any) => ({
          ...competitive,
          lifecycleStatus: "terminal",
          terminal,
        })),
        expire: vi.fn(async () => []),
        getActive: vi.fn(async () => null),
      };
      Object.assign(scheduler as any, {
        preparationStore: store,
        preparationFencingToken: "41",
        preparationDurationMs: 60_000,
      });
      const aborts = collectCycleAbortEvents(ctx);

      scheduler.init();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce(),
      );

      expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshotDigest: competitive.digest,
          terminal: expect.objectContaining({
            cancellationReason:
              "competitive_snapshot_recovery_loadout_schema_unavailable",
          }),
        }),
      );
      expectAuthoritativeCycleAbort(aborts, {
        cycleId: competitive.snapshot.cycleId,
        duelId: competitive.snapshot.duelId,
        duelKeyHex: competitive.snapshot.duelKey,
        reason: "competitive_snapshot_recovery_loadout_schema_unavailable",
        agent1Id: "agent-alpha",
        agent2Id: "agent-beta",
      });
      expect(scheduler.getCurrentCycle()).toBeNull();
      scheduler.destroy();
      await scheduler.waitForShutdownCleanup();
    },
  );

  it("cancels rather than replaying a frozen snapshot after live custody drifts", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    ctx.getInventory("agent-alpha").items.push({
      slot: 27,
      itemId: "drifted_item",
      quantity: 1,
    });
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn(async ({ terminal }: any) => ({
        ...competitive,
        lifecycleStatus: "terminal",
        terminal,
      })),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });
    const aborts = collectCycleAbortEvents(ctx);
    const priorLogCount = Logger.getRecentLogs().length;

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce(),
    );

    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          cancellationReason: "competitive_snapshot_recovery_state_drift",
        }),
      }),
    );
    expectAuthoritativeCycleAbort(aborts, {
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      duelKeyHex: competitive.snapshot.duelKey,
      reason: "competitive_snapshot_recovery_state_drift",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
    });
    expect(
      Logger.getRecentLogs()
        .slice(priorLogCount)
        .find(
          (entry) =>
            entry.level === "ERROR" &&
            entry.message.includes(
              "Competitive snapshot recovery integrity failure",
            ),
        ),
    ).toMatchObject({
      message: expect.stringContaining(
        "mismatchPaths=$.contestants[0].inventory.length,$.contestants[0].loadoutFingerprint",
      ),
      data: {
        preparationId: competitive.preparation.preparationId,
        cycleId: competitive.snapshot.cycleId,
        expectedDigest: competitive.digest,
        reconstructedDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        mismatchPaths: expect.arrayContaining([
          "$.contestants[0].inventory.length",
          "$.contestants[0].loadoutFingerprint",
        ]),
      },
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("publishes no cancellation until the exact competitive terminal commits", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - 1_000,
    );
    let commitTerminal!: (value: PersistedCompetitiveSnapshot) => void;
    const terminalCommit = new Promise<PersistedCompetitiveSnapshot>(
      (resolve) => {
        commitTerminal = resolve;
      },
    );
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn((_input: any) => terminalCommit),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });
    const aborts = collectCycleAbortEvents(ctx);

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(scheduler.getCurrentCycle()).not.toBeNull());
    (scheduler as any).abortCycleToIdle("operator_cancelled");

    expect(aborts).toHaveLength(0);
    expect(scheduler.getCurrentCycle()).not.toBeNull();
    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotDigest: competitive.digest,
        terminal: expect.objectContaining({
          outcome: "cancelled",
          cancellationReason: "operator_cancelled",
        }),
      }),
    );

    const requestedTerminal =
      store.markCompetitiveSnapshotTerminal.mock.calls[0]![0].terminal;
    commitTerminal({
      ...competitive,
      lifecycleStatus: "terminal",
      terminal: requestedTerminal,
    });
    await vi.waitFor(() => expect(aborts).toHaveLength(1));

    expect(aborts[0]).toMatchObject({
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      reason: "operator_cancelled",
    });
    expect(scheduler.getCurrentCycle()).toBeNull();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("commits shutdown cancellation before custody cleanup and replays it after restart", async () => {
    const firstContext = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const firstScheduler = new StreamingDuelScheduler(
      firstContext.world as never,
    );
    const competitive = buildPersistedCompetitiveTestSnapshot(
      firstScheduler,
      Date.now() - 1_000,
    );
    let commitTerminal!: (value: PersistedCompetitiveSnapshot) => void;
    const terminalCommit = new Promise<PersistedCompetitiveSnapshot>(
      (resolve) => {
        commitTerminal = resolve;
      },
    );
    const firstStore = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => competitive),
      markCompetitiveSnapshotTerminal: vi.fn((_input: any) => terminalCommit),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(firstScheduler as any, {
      preparationStore: firstStore,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });
    const firstOrchestrator = (firstScheduler as any).orchestrator;
    const cleanup = vi
      .spyOn(firstOrchestrator, "cleanupAfterAbort")
      .mockResolvedValue(undefined);
    const reset = vi.spyOn(firstOrchestrator, "reset");
    const unpublishedAborts = collectCycleAbortEvents(firstContext);

    firstScheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(firstScheduler.getCurrentCycle()).not.toBeNull(),
    );
    firstScheduler.destroy();

    await vi.waitFor(() =>
      expect(firstStore.markCompetitiveSnapshotTerminal).toHaveBeenCalledOnce(),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(unpublishedAborts).toHaveLength(0);
    const requestedTerminal =
      firstStore.markCompetitiveSnapshotTerminal.mock.calls[0]![0].terminal;
    expect(requestedTerminal).toMatchObject({
      outcome: "cancelled",
      cancellationReason: "scheduler_shutdown",
    });
    const persistedTerminal: PersistedCompetitiveSnapshot = {
      ...competitive,
      lifecycleStatus: "terminal",
      terminal: requestedTerminal,
    };
    commitTerminal(persistedTerminal);
    await firstScheduler.waitForShutdownCleanup();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();

    const secondContext = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const secondScheduler = new StreamingDuelScheduler(
      secondContext.world as never,
    );
    const secondStore = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(
        async () => persistedTerminal,
      ),
      markCompetitiveSnapshotTerminal: vi.fn(async () => persistedTerminal),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(secondScheduler as any, {
      preparationStore: secondStore,
      preparationFencingToken: "42",
      preparationDurationMs: 60_000,
    });
    const replayedAborts = collectCycleAbortEvents(secondContext);

    secondScheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(replayedAborts).toHaveLength(1));

    expect(secondStore.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        fencingToken: "42",
        snapshotDigest: competitive.digest,
        terminal: requestedTerminal,
      }),
    );
    expectAuthoritativeCycleAbort(replayedAborts, {
      cycleId: competitive.snapshot.cycleId,
      duelId: competitive.snapshot.duelId,
      duelKeyHex: competitive.snapshot.duelKey,
      reason: "scheduler_shutdown",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
    });
    expect(secondScheduler.getCurrentCycle()).toBeNull();
    secondScheduler.destroy();
    await secondScheduler.waitForShutdownCleanup();
  });

  it("replays persisted terminal truth after restart without recomputing the winner", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const competitive = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - STREAMING_TIMING.ANNOUNCEMENT_DURATION - 10_000,
    );
    const persistedWin: PersistedCompetitiveSnapshot = {
      ...competitive,
      lifecycleStatus: "terminal",
      terminal: {
        outcome: "win",
        winnerId: "agent-beta",
        winReason: "kill",
        cancellationReason: null,
        seed: "42",
        replayHash: "cd".repeat(32),
        terminalAt: Date.now() - 5_000,
      },
    };
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(
        async () => persistedWin,
      ),
      markCompetitiveSnapshotTerminal: vi.fn(),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "41",
      preparationDurationMs: 60_000,
    });
    const resolutions: any[] = [];
    ctx.world.on("streaming:resolution:start", (event) =>
      resolutions.push(event),
    );

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(resolutions).toHaveLength(1));

    expect(resolutions[0]).toMatchObject({
      cycleId: persistedWin.snapshot.cycleId,
      duelId: persistedWin.snapshot.duelId,
      winnerId: "agent-beta",
      outcome: "win",
      seed: "42",
      replayHash: "cd".repeat(32),
      recovered: true,
    });
    expect(scheduler.getCurrentCycle()).toMatchObject({
      phase: "RESOLUTION",
      winnerId: "agent-beta",
      outcome: "win",
      competitiveSnapshotDigest: persistedWin.digest,
    });
    expect(scheduler.getDurableBettingTerminal()).toMatchObject({
      cycle: expect.objectContaining({
        duelId: persistedWin.snapshot.duelId,
        winnerId: "agent-beta",
      }),
      terminal: null,
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("drains every fenced terminal backlog row before selecting a fresh preparation", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const base = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - STREAMING_TIMING.ANNOUNCEMENT_DURATION - 20_000,
    );
    const persistedWin = (ordinal: 1 | 2): PersistedCompetitiveSnapshot => ({
      ...base,
      preparation: {
        ...base.preparation,
        preparationId:
          ordinal === 1
            ? "49e78a73-e663-4087-86b6-f31592ac9763"
            : "955c2b46-c4b1-488a-9604-d2d5c7815744",
        fencingToken: "61",
      },
      snapshot: {
        ...base.snapshot,
        preparationId:
          ordinal === 1
            ? "49e78a73-e663-4087-86b6-f31592ac9763"
            : "955c2b46-c4b1-488a-9604-d2d5c7815744",
        cycleId: `recovered-backlog-${ordinal}`,
        duelId: `streaming-recovered-backlog-${ordinal}`,
        duelKey: (ordinal === 1 ? "31" : "32").repeat(32),
      },
      digest: (ordinal === 1 ? "41" : "42").repeat(32),
      lifecycleStatus: "terminal",
      terminal: {
        outcome: "win",
        winnerId: "agent-beta",
        winReason: "kill",
        cancellationReason: null,
        seed: String(ordinal),
        replayHash: (ordinal === 1 ? "51" : "52").repeat(32),
        terminalAt:
          Date.now() - STREAMING_TIMING.RESOLUTION_DURATION - 60_000 - ordinal,
      },
    });
    const backlog = [persistedWin(2), persistedWin(1)];
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () =>
        backlog.shift(),
      ),
      markCompetitiveSnapshotRecovered: vi.fn(
        async ({ preparationId, recoveredAt }: any) => {
          const source = [persistedWin(1), persistedWin(2)].find(
            (entry) => entry.preparation.preparationId === preparationId,
          );
          return source
            ? {
                ...source,
                lifecycleStatus: "retired" as const,
                recoveredAt,
              }
            : null;
        },
      ),
      markCompetitiveSnapshotTerminal: vi.fn(),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "61",
      preparationDurationMs: 60_000,
    });
    vi.spyOn(
      (scheduler as any).orchestrator,
      "cleanupAfterDuel",
    ).mockResolvedValue(undefined);
    const persistFreshPreparation = vi
      .spyOn(scheduler as any, "persistOnDeckPreparation")
      .mockResolvedValue(undefined);
    const resolutions: any[] = [];
    ctx.world.on("streaming:resolution:start", (event) =>
      resolutions.push(event),
    );

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.waitForShutdownCleanup();
    await vi.waitFor(() =>
      expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledTimes(2),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(resolutions.map((event) => event.cycleId)).toEqual([
      "recovered-backlog-2",
      "recovered-backlog-1",
    ]);
    expect(
      store.claimLatestCompetitiveSnapshotForRecovery,
    ).toHaveBeenCalledTimes(3);
    expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledTimes(2);
    expect(store.markCompetitiveSnapshotTerminal).not.toHaveBeenCalled();
    expect(persistFreshPreparation).toHaveBeenCalled();
    expect(
      store.markCompetitiveSnapshotRecovered.mock.invocationCallOrder[1],
    ).toBeLessThan(persistFreshPreparation.mock.invocationCallOrder[0]!);

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("retires an elapsed recovered cancellation without changing its terminal truth", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: RECOVERY_ALPHA_WEAPON,
      betaWeaponId: RECOVERY_BETA_WEAPON,
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const base = buildPersistedCompetitiveTestSnapshot(
      scheduler,
      Date.now() - STREAMING_TIMING.ANNOUNCEMENT_DURATION - 20_000,
    );
    const terminalAt =
      Date.now() - STREAMING_TIMING.RESOLUTION_DURATION - 30_000;
    const cancelled: PersistedCompetitiveSnapshot = {
      ...base,
      preparation: { ...base.preparation, fencingToken: "62" },
      lifecycleStatus: "terminal",
      terminal: {
        outcome: "cancelled",
        winnerId: null,
        winReason: null,
        cancellationReason: "contestant_unavailable",
        seed: null,
        replayHash: null,
        terminalAt,
      },
    };
    let claimCount = 0;
    const store = {
      claimLatestCompetitiveSnapshotForRecovery: vi.fn(async () => {
        claimCount++;
        return claimCount === 1 ? cancelled : null;
      }),
      markCompetitiveSnapshotTerminal: vi.fn(async () => cancelled),
      markCompetitiveSnapshotRecovered: vi.fn(async ({ recoveredAt }: any) => ({
        ...cancelled,
        lifecycleStatus: "retired" as const,
        recoveredAt,
      })),
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "62",
      preparationDurationMs: 60_000,
    });
    vi.spyOn(
      (scheduler as any).orchestrator,
      "cleanupAfterAbort",
    ).mockResolvedValue(undefined);
    const persistFreshPreparation = vi
      .spyOn(scheduler as any, "persistOnDeckPreparation")
      .mockResolvedValue(undefined);

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.markCompetitiveSnapshotTerminal).toHaveBeenCalledWith({
      preparationId: cancelled.preparation.preparationId,
      fencingToken: "62",
      snapshotDigest: cancelled.digest,
      terminal: cancelled.terminal,
    });
    expect(store.markCompetitiveSnapshotRecovered).toHaveBeenCalledOnce();
    expect(
      store.claimLatestCompetitiveSnapshotForRecovery,
    ).toHaveBeenCalledTimes(2);
    expect(persistFreshPreparation).toHaveBeenCalled();
    expect(scheduler.getCurrentCycle()).toBeNull();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("emits no bettable duel until both private preparations are ready and frozen", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    let preparation: any = null;
    const store = {
      create: vi.fn(async (input: any) => {
        preparation = {
          preparationId: input.preparationId,
          fencingToken: input.fencingToken,
          agent1Id: input.agent1Id,
          agent2Id: input.agent2Id,
          allowedBankActions: [...input.allowedBankActions],
          status: "preparing",
          selectedAt: Date.now(),
          expiresAt: Date.now() + input.durationMs,
          agent1ReadyAt: null,
          agent2ReadyAt: null,
          agent1PlanEvidence: null,
          agent2PlanEvidence: null,
          frozenAt: null,
          cancelledAt: null,
          cancellationReason: null,
          version: 1,
        };
        return preparation;
      }),
      getActive: vi.fn(async () => preparation),
      getContestantUnavailability: vi.fn(async () => null),
      expire: vi.fn(async () => []),
      markReady: vi.fn(
        async ({
          agentId,
          planEvidence,
        }: {
          agentId: string;
          planEvidence: CompetitivePreparationEvidence;
        }) => {
          if (agentId === preparation.agent1Id) {
            preparation.agent1ReadyAt ??= Date.now();
            preparation.agent1PlanEvidence = planEvidence;
          } else if (agentId === preparation.agent2Id) {
            preparation.agent2ReadyAt ??= Date.now();
            preparation.agent2PlanEvidence = planEvidence;
          } else {
            return null;
          }
          preparation.status =
            preparation.agent1ReadyAt !== null &&
            preparation.agent2ReadyAt !== null
              ? "ready"
              : "preparing";
          preparation.version += 1;
          return { ...preparation };
        },
      ),
      freezeWithCompetitiveSnapshot: vi.fn(async (input: any) => {
        if (preparation?.status !== "ready") return null;
        const finalized = finalizeCompetitiveSnapshot({
          draft: input.draft,
          persisted: true,
          frozenAt: Date.now(),
          betWindowDurationMs: input.betWindowDurationMs,
          timing: input.timing,
        });
        preparation = {
          ...preparation,
          status: "frozen",
          frozenAt: finalized.snapshot.frozenAt,
          version: preparation.version + 1,
        };
        return { preparation, ...finalized };
      }),
      cancel: vi.fn(async ({ reason }: { reason: string }) => {
        if (!preparation) return null;
        preparation = {
          ...preparation,
          status: "cancelled",
          cancelledAt: Date.now(),
          cancellationReason: reason,
          version: preparation.version + 1,
        };
        return preparation;
      }),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "1",
      preparationDurationMs: 60_000,
      publicPreparationMinimumDurationMs: 2_000,
    });
    const selections: any[] = [];
    const scheduled: any[] = [];
    ctx.world.on("duel:preparation:selected", (event) =>
      selections.push(event),
    );
    ctx.world.on("duel:scheduled", (event) => scheduled.push(event));
    (scheduler as any).matchmaking.recordRecentDuel({
      cycleId: "prior-head-to-head",
      duelId: "prior-duel",
      finishedAt: Date.now() - 1_000,
      outcome: "win",
      agent1Id: "agent-alpha",
      agent1Name: "Alpha",
      agent1OpeningStyle: "mage",
      agent2Id: "agent-beta",
      agent2Name: "Beta",
      agent2OpeningStyle: "ranged",
      winnerId: "agent-alpha",
      winnerName: "Alpha",
      loserId: "agent-beta",
      loserName: "Beta",
      winReason: "kill",
      cancellationReason: null,
      damageAgent1: 20,
      damageAgent2: 7,
      damageWinner: 20,
      damageLoser: 7,
    });

    scheduler.init();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(selections).toHaveLength(1);
    expect(scheduled).toHaveLength(0);
    expect(scheduler.getCurrentCycle()).toBeNull();

    const selected = selections[0];
    const initialPublicState = scheduler.getStreamingState();
    const initialPublicPreparation = initialPublicState.preparation;
    expect(initialPublicPreparation).toEqual({
      schemaVersion: 2,
      status: "preparing",
      selectedAt: preparation.selectedAt,
      expiresAt: preparation.expiresAt,
      agent1: {
        id: selected.agent1Id,
        ready: false,
        activity: null,
        mode: null,
        activityTrail: [],
      },
      agent2: {
        id: selected.agent2Id,
        ready: false,
        activity: null,
        mode: null,
        activityTrail: [],
      },
    });
    expect(JSON.stringify(initialPublicPreparation)).not.toContain(
      selected.preparationId,
    );
    expect(JSON.stringify(initialPublicPreparation)).not.toContain(
      "allowedBankActions",
    );
    expect(initialPublicState.cycle.phaseEndTime).toBe(preparation.expiresAt);
    expect(initialPublicState.cycle.timeRemaining).toBe(60_000);
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      activity: "forge a private counter",
      mode: "working",
      occurredAt: preparation.selectedAt,
      revision: 1,
    });
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      activity: "planning",
      mode: "working",
      occurredAt: preparation.selectedAt,
      revision: 1,
      targetItemId: "private_item_id",
    });
    expect(scheduler.getStreamingState().preparation).toEqual(
      initialPublicPreparation,
    );
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      activity: "training",
      mode: "traveling",
      occurredAt: preparation.selectedAt,
      revision: 2,
    });
    expect(scheduler.getStreamingState().preparation).toMatchObject({
      agent1:
        selected.agent1Id === preparation.agent1Id
          ? {
              activity: "training",
              mode: "traveling",
              activityTrail: ["training"],
            }
          : { activity: null, mode: null, activityTrail: [] },
      agent2:
        selected.agent1Id === preparation.agent2Id
          ? {
              activity: "training",
              mode: "traveling",
              activityTrail: ["training"],
            }
          : { activity: null, mode: null, activityTrail: [] },
    });
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      activity: "training",
      mode: "working",
      occurredAt: preparation.selectedAt + 1,
      revision: 3,
    });
    expect(scheduler.getStreamingState().preparation).toMatchObject({
      agent1:
        selected.agent1Id === preparation.agent1Id
          ? {
              activity: "training",
              mode: "working",
              activityTrail: ["training"],
            }
          : { activity: null, mode: null, activityTrail: [] },
      agent2:
        selected.agent1Id === preparation.agent2Id
          ? {
              activity: "training",
              mode: "working",
              activityTrail: ["training"],
            }
          : { activity: null, mode: null, activityTrail: [] },
    });
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      activity: "crafting",
      mode: "working",
      occurredAt: preparation.selectedAt + 2,
      revision: 4,
    });
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      activity: "gathering",
      mode: "working",
      occurredAt: preparation.selectedAt + 3,
      revision: 3,
    });
    ctx.world.emit("duel:preparation:public_activity", {
      preparationId: "stale-private-preparation",
      agentId: selected.agent1Id,
      activity: "questing",
      mode: "working",
      occurredAt: preparation.selectedAt + 4,
      revision: 5,
    });
    expect(scheduler.getStreamingState().preparation).toMatchObject({
      agent1:
        selected.agent1Id === preparation.agent1Id
          ? {
              activity: "crafting",
              mode: "working",
              activityTrail: ["training", "crafting"],
            }
          : { activity: null, mode: null, activityTrail: [] },
      agent2:
        selected.agent1Id === preparation.agent2Id
          ? {
              activity: "crafting",
              mode: "working",
              activityTrail: ["training", "crafting"],
            }
          : { activity: null, mode: null, activityTrail: [] },
    });
    const laterActivities = [
      "provisioning",
      "questing",
      "exploring",
      "reassessing",
      "planning",
      "gathering",
      "training",
    ] as const;
    laterActivities.forEach((activity, index) => {
      ctx.world.emit("duel:preparation:public_activity", {
        preparationId: selected.preparationId,
        agentId: selected.agent1Id,
        activity,
        mode: "working",
        occurredAt: preparation.selectedAt + 5 + index,
        revision: 5 + index,
      });
    });
    expect(scheduler.getStreamingState().preparation).toMatchObject({
      agent1:
        selected.agent1Id === preparation.agent1Id
          ? {
              activity: "training",
              activityTrail: [
                "crafting",
                "provisioning",
                "questing",
                "exploring",
                "reassessing",
                "planning",
                "gathering",
                "training",
              ],
            }
          : { activity: null, activityTrail: [] },
      agent2:
        selected.agent1Id === preparation.agent2Id
          ? {
              activity: "training",
              activityTrail: [
                "crafting",
                "provisioning",
                "questing",
                "exploring",
                "reassessing",
                "planning",
                "gathering",
                "training",
              ],
            }
          : { activity: null, activityTrail: [] },
    });
    const expectedHistoryByAgent = {
      "agent-alpha": {
        result: "win",
        ownOpeningStyle: "mage",
        opponentOpeningStyle: "ranged",
        ownDamage: 20,
        opponentDamage: 7,
      },
      "agent-beta": {
        result: "loss",
        ownOpeningStyle: "ranged",
        opponentOpeningStyle: "mage",
        ownDamage: 7,
        opponentDamage: 20,
      },
    } as const;
    expect(selected.agent1OpponentHistory).toEqual([
      expect.objectContaining(
        expectedHistoryByAgent[
          selected.agent1Id as keyof typeof expectedHistoryByAgent
        ],
      ),
    ]);
    expect(selected.agent2OpponentHistory).toEqual([
      expect.objectContaining(
        expectedHistoryByAgent[
          selected.agent2Id as keyof typeof expectedHistoryByAgent
        ],
      ),
    ]);
    // A slow plan must not consume the configured completed-preparation hold.
    // The old selection-relative calculation would launch immediately here.
    await vi.advanceTimersByTimeAsync(10_000);
    ctx.world.emit("duel:preparation:ready", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      planEvidence: testPlanEvidence(),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(0);
    expect(scheduler.getStreamingState().preparation).toMatchObject({
      status: "preparing",
      agent1:
        selected.agent1Id === preparation.agent1Id
          ? { id: selected.agent1Id, ready: true }
          : { id: selected.agent1Id, ready: false },
      agent2:
        selected.agent1Id === preparation.agent2Id
          ? { id: selected.agent2Id, ready: true }
          : { id: selected.agent2Id, ready: false },
    });
    ctx.world.emit("duel:preparation:ready", {
      preparationId: selected.preparationId,
      agentId: selected.agent2Id,
      planEvidence: testPlanEvidence(),
    });
    await Promise.resolve();
    await Promise.resolve();
    (scheduler as any).tick();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.freezeWithCompetitiveSnapshot).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(scheduler.getStreamingState().preparation).toMatchObject({
      status: "ready",
      agent1: { ready: true },
      agent2: { ready: true },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    (scheduler as any).tick();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() =>
      expect(store.freezeWithCompetitiveSnapshot).toHaveBeenCalledOnce(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
    expect(scheduler.getStreamingState().preparation).toBeNull();
    expect(scheduled[0]).toMatchObject({
      agent1Id: selected.agent1Id,
      agent2Id: selected.agent2Id,
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("releases both competitive loadouts when snapshot persistence throws before market open", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const internal = scheduler as any;
    internal.matchmaking.availableAgents.add("agent-alpha");
    internal.matchmaking.availableAgents.add("agent-beta");
    const release = vi.spyOn(
      internal.orchestrator,
      "releaseCompetitiveLoadout",
    );
    Object.assign(internal, {
      preparationStore: {
        freezeWithCompetitiveSnapshot: vi.fn(async () => {
          throw new Error("snapshot_store_unavailable");
        }),
      },
      preparationFencingToken: "77",
      preparationDurationMs: 60_000,
    });
    const now = Date.now();
    const preparation = {
      preparationId: "bb6acf74-cfa8-4558-9726-e821bf3941e2",
      fencingToken: "77",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "ready",
      selectedAt: now - 1_000,
      expiresAt: now + 60_000,
      agent1ReadyAt: now - 500,
      agent2ReadyAt: now - 400,
      agent1PlanEvidence: testPlanEvidence(),
      agent2PlanEvidence: testPlanEvidence(),
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 3,
    };

    await expect(
      internal.startNewCycleInternal(
        {
          agent1Id: "agent-alpha",
          agent2Id: "agent-beta",
          selectedAt: now,
        },
        preparation,
      ),
    ).rejects.toThrow("snapshot_store_unavailable");

    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith("agent-alpha");
    expect(release).toHaveBeenCalledWith("agent-beta");
    expect(scheduler.getCurrentCycle()).toBeNull();
  });

  it("durably cancels both on-deck agents immediately when one plan fails", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    let preparation: any = null;
    const store = {
      create: vi.fn(async (input: any) => {
        preparation = {
          preparationId: input.preparationId,
          fencingToken: input.fencingToken,
          agent1Id: input.agent1Id,
          agent2Id: input.agent2Id,
          allowedBankActions: [...input.allowedBankActions],
          status: "preparing",
          selectedAt: Date.now(),
          expiresAt: Date.now() + input.durationMs,
          agent1ReadyAt: null,
          agent2ReadyAt: null,
          frozenAt: null,
          cancelledAt: null,
          cancellationReason: null,
          version: 1,
        };
        return preparation;
      }),
      getActive: vi.fn(async () => preparation),
      getContestantUnavailability: vi.fn(async () => null),
      expire: vi.fn(async () => []),
      markReady: vi.fn(),
      freeze: vi.fn(),
      cancel: vi.fn(async ({ reason }: { reason: string }) => {
        preparation = {
          ...preparation,
          status: "cancelled",
          cancelledAt: Date.now(),
          cancellationReason: reason,
          version: preparation.version + 1,
        };
        return preparation;
      }),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "31",
      preparationDurationMs: 60_000,
    });
    const selections: any[] = [];
    const failures: any[] = [];
    const cancellations: any[] = [];
    const scheduled: any[] = [];
    ctx.world.on("duel:preparation:selected", (event) =>
      selections.push(event),
    );
    ctx.world.on("duel:preparation:failed", (event) => failures.push(event));
    ctx.world.on("duel:preparation:cancelled", (event) =>
      cancellations.push(event),
    );
    ctx.world.on("duel:scheduled", (event) => scheduled.push(event));
    const deferAgentAfterPreparationFailure = vi.spyOn(
      (scheduler as any).matchmaking,
      "deferAgentAfterPreparationFailure",
    );

    scheduler.init();
    await vi.waitFor(() => expect(selections).toHaveLength(1));
    const selected = selections[0];
    const failureStartedAt = Date.now();
    const failureLog = vi.spyOn(Logger, "warn").mockImplementation(() => {});
    ctx.world.emit("duel:preparation:agent_plan_status", {
      preparationId: selected.preparationId,
      agentId: selected.agent1Id,
      status: "failed",
      failureReason: "private_internal_detail",
    });

    expect(failureLog).toHaveBeenCalledWith(
      "StreamingDuelScheduler",
      `Private preparation ${selected.preparationId} failed for agent ${selected.agent1Id}: private_internal_detail`,
    );

    await vi.waitFor(() => expect(store.cancel).toHaveBeenCalledOnce());
    expect(store.cancel).toHaveBeenCalledWith({
      preparationId: selected.preparationId,
      fencingToken: "31",
      reason: "agent_preparation_failed",
    });
    expect(deferAgentAfterPreparationFailure).toHaveBeenCalledWith(
      selected.agent1Id,
      expect.any(Number),
    );
    const retryAfter = deferAgentAfterPreparationFailure.mock.calls[0]?.[1];
    expect(retryAfter).toBeGreaterThanOrEqual(failureStartedAt + 60_000);
    expect(retryAfter).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(failures).toEqual([
      {
        preparationId: selected.preparationId,
        agent1Id: selected.agent1Id,
        agent2Id: selected.agent2Id,
        failedAgentId: selected.agent1Id,
        reason: "agent_preparation_failed",
      },
    ]);
    expect(cancellations).toEqual([
      expect.objectContaining({
        preparationId: selected.preparationId,
        reason: "agent_preparation_failed",
      }),
    ]);
    expect(scheduled).toHaveLength(0);
    expect(scheduler.getCurrentCycle()).toBeNull();
    expect((scheduler as any).onDeckPreparation).toBeNull();
    expect((scheduler as any).matchmaking.nextDuelPair).toBeNull();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("consumes a cross-process contestant-unavailability report before market publication", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const now = Date.now();
    const preparation = {
      preparationId: "3b86878a-d3e8-407a-a9de-2cab78640361",
      fencingToken: "311",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "ready",
      selectedAt: now - 1_000,
      expiresAt: now + 60_000,
      agent1ReadyAt: now - 500,
      agent2ReadyAt: now - 400,
      agent1PlanEvidence: testPlanEvidence(),
      agent2PlanEvidence: testPlanEvidence(),
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 4,
    };
    const cancelled = {
      ...preparation,
      status: "cancelled",
      cancelledAt: now,
      cancellationReason: "agent_preparation_failed",
      version: 5,
    };
    const store = {
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => preparation),
      getContestantUnavailability: vi.fn(async () => ({
        preparationId: preparation.preparationId,
        agentId: preparation.agent2Id,
        reason: "agent_unavailable",
        reportedAt: now - 100,
      })),
      cancel: vi.fn(async () => cancelled),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "311",
      preparationDurationMs: 60_000,
      competitiveRecoveryChecked: true,
    });
    const startNewCycle = vi
      .spyOn(scheduler as any, "startNewCycle")
      .mockResolvedValue(true);
    const failures: unknown[] = [];
    const cancellations: unknown[] = [];
    ctx.world.on("duel:preparation:failed", (event) => failures.push(event));
    ctx.world.on("duel:preparation:cancelled", (event) =>
      cancellations.push(event),
    );

    await (scheduler as any).advancePrivatePreparationGate(now);

    expect(store.getContestantUnavailability).toHaveBeenCalledWith(
      preparation.preparationId,
    );
    expect(store.cancel).toHaveBeenCalledWith({
      preparationId: preparation.preparationId,
      fencingToken: "311",
      reason: "agent_preparation_failed",
    });
    expect(startNewCycle).not.toHaveBeenCalled();
    expect(failures).toEqual([
      {
        preparationId: preparation.preparationId,
        agent1Id: preparation.agent1Id,
        agent2Id: preparation.agent2Id,
        failedAgentId: preparation.agent2Id,
        reason: "agent_preparation_failed",
      },
    ]);
    expect(cancellations).toEqual([
      expect.objectContaining({
        preparationId: preparation.preparationId,
        reason: "agent_preparation_failed",
      }),
    ]);
    expect((scheduler as any).onDeckPreparation).toBeNull();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("promotes an expired contestant-host lease to the same pre-market cancellation", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const now = Date.now();
    const preparation = {
      preparationId: "6b65826f-3fe8-4676-823e-8ae0eef46e47",
      fencingToken: "312",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: now - 20_000,
      expiresAt: now + 40_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      agent1PlanEvidence: null,
      agent2PlanEvidence: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const report = {
      preparationId: preparation.preparationId,
      agentId: preparation.agent1Id,
      reason: "agent_unavailable",
      reportedAt: now,
    };
    const store = {
      reportExpiredContestantHostLease: vi.fn(async () => report),
      getContestantUnavailability: vi.fn(async () => null),
      cancel: vi.fn(async () => ({
        ...preparation,
        status: "cancelled",
        cancelledAt: now,
        cancellationReason: "agent_preparation_failed",
        version: 2,
      })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "312",
      preparationDurationMs: 60_000,
      preparationHostLeaseConfig: {
        leaseMs: 15_000,
        heartbeatMs: 3_000,
        claimGraceMs: 10_000,
      },
      onDeckPreparation: preparation,
      onDeckPreparationPairKey: "agent-alpha\u0000agent-beta",
    });

    await expect(
      (scheduler as any).consumeReportedContestantUnavailability(preparation),
    ).resolves.toBe(true);

    expect(store.reportExpiredContestantHostLease).toHaveBeenCalledWith({
      preparationId: preparation.preparationId,
      claimGraceMs: 10_000,
    });
    expect(store.getContestantUnavailability).not.toHaveBeenCalled();
    expect(store.cancel).toHaveBeenCalledWith({
      preparationId: preparation.preparationId,
      fencingToken: "312",
      reason: "agent_preparation_failed",
    });
    expect((scheduler as any).onDeckPreparation).toBeNull();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("revokes local preparation authority before a fenced durable cancellation settles", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "f18b3e9a-bfce-4385-a47f-daf946275be3",
      fencingToken: "32",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    let settleCancellation!: (value: null) => void;
    const durableCancellation = new Promise<null>((resolve) => {
      settleCancellation = resolve;
    });
    const store = {
      cancel: vi.fn(() => durableCancellation),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "32",
      preparationDurationMs: 60_000,
      onDeckPreparation: preparation,
      onDeckPreparationPairKey: "agent-alpha\u0000agent-beta",
    });
    const localRevocations: any[] = [];
    const durableCancellations: any[] = [];
    ctx.world.on("duel:preparation:local_revoked", (event) =>
      localRevocations.push(event),
    );
    ctx.world.on("duel:preparation:cancelled", (event) =>
      durableCancellations.push(event),
    );

    const cancellation = (scheduler as any).cancelOnDeckPreparation(
      "lease_renewal_rejected",
    );
    await Promise.resolve();
    const revocationsBeforeDurableSettlement = [...localRevocations];
    settleCancellation(null);
    await cancellation;

    expect(revocationsBeforeDurableSettlement).toEqual([
      expect.objectContaining({
        preparationId: preparation.preparationId,
        reason: "lease_renewal_rejected",
        occurredAt: expect.any(Number),
      }),
    ]);
    expect(store.cancel).toHaveBeenCalledWith({
      preparationId: preparation.preparationId,
      fencingToken: "32",
      reason: "lease_renewal_rejected",
    });
    expect(durableCancellations).toEqual([]);
    expect((scheduler as any).onDeckPreparation).toBeNull();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("cancels the old private pair before reselection when an on-deck agent disconnects", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "90cc1e94-7d92-4af1-aa16-f485a4ae8c0d",
      fencingToken: "32",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const store = {
      cancel: vi.fn(async ({ reason }: { reason: string }) => ({
        ...preparation,
        status: "cancelled",
        cancelledAt: Date.now(),
        cancellationReason: reason,
        version: 2,
      })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "32",
      preparationDurationMs: 60_000,
      onDeckPreparation: preparation,
      onDeckPreparationPairKey: "agent-alpha\u0000agent-beta",
    });
    const matchmaking = (scheduler as any).matchmaking;
    matchmaking.availableAgents = new Set([
      "agent-alpha",
      "agent-beta",
      "agent-gamma",
    ]);
    matchmaking.nextDuelPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: Date.now(),
    };
    const cancellations: any[] = [];
    ctx.world.on("duel:preparation:cancelled", (event) =>
      cancellations.push(event),
    );

    scheduler.unregisterAgent("agent-alpha");

    await vi.waitFor(() => expect(store.cancel).toHaveBeenCalledOnce());
    expect(store.cancel).toHaveBeenCalledWith({
      preparationId: preparation.preparationId,
      fencingToken: "32",
      reason: "pair_cleared",
    });
    expect(matchmaking.nextDuelPair).toBeNull();
    expect(cancellations).toEqual([
      expect.objectContaining({
        preparationId: preparation.preparationId,
        reason: "pair_cleared",
      }),
    ]);

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("suspends an on-deck contestant during reconnect grace without revoking the durable preparation", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "3ad7103c-a852-4782-a96e-7c693ea87e78",
      fencingToken: "37",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      agent1PlanEvidence: null,
      agent2PlanEvidence: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const store = {
      cancel: vi.fn(async ({ reason }: { reason: string }) => ({
        ...preparation,
        status: "cancelled",
        cancelledAt: Date.now(),
        cancellationReason: reason,
        version: 2,
      })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "37",
      preparationDurationMs: 60_000,
      onDeckPreparation: preparation,
      onDeckPreparationPairKey: "agent-alpha\u0000agent-beta",
    });
    const matchmaking = (scheduler as any).matchmaking;
    matchmaking.availableAgents = new Set(["agent-alpha", "agent-beta"]);
    const selectedPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: Date.now(),
    };
    matchmaking.nextDuelPair = selectedPair;
    (scheduler as any).subscribeToEvents();

    ctx.world.emit(EventType.PLAYER_LEFT, {
      playerId: "agent-alpha",
      reconnectGraceActive: true,
      reconnectGraceExpiresAt: Date.now() + 30_000,
    });

    expect(matchmaking.availableAgents.has("agent-alpha")).toBe(false);
    expect(matchmaking.nextDuelPair).toBe(selectedPair);
    expect((scheduler as any).onDeckPreparation).toBe(preparation);
    expect(store.cancel).not.toHaveBeenCalled();

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("cancels an on-deck preparation when a contestant dies and ignores stale death events", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "c8ab83d9-a65e-49a2-b094-64fd608a4a4c",
      fencingToken: "35",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      agent1PlanEvidence: null,
      agent2PlanEvidence: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const store = {
      cancel: vi.fn(async ({ reason }: { reason: string }) => ({
        ...preparation,
        status: "cancelled",
        cancelledAt: Date.now(),
        cancellationReason: reason,
        version: 2,
      })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "35",
      onDeckPreparation: preparation,
      onDeckPreparationPairKey: "agent-alpha\u0000agent-beta",
    });
    const matchmaking = (scheduler as any).matchmaking;
    matchmaking.availableAgents = new Set(["agent-alpha", "agent-beta"]);
    matchmaking.nextDuelPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: Date.now(),
    };
    const cancellations: any[] = [];
    ctx.world.on("duel:preparation:cancelled", (event) =>
      cancellations.push(event),
    );

    // ENTITY_DEATH carries no cycle/preparation identity. A stale event against
    // a living entity must not revoke the current private capability.
    (scheduler as any).handleEntityDeath({ entityId: "agent-alpha" });
    await Promise.resolve();
    expect(store.cancel).not.toHaveBeenCalled();
    expect((scheduler as any).onDeckPreparation).toBe(preparation);

    const alpha = ctx.entities.get("agent-alpha")!;
    alpha.data.health = 0;
    alpha.data.alive = false;
    (scheduler as any).handleEntityDeath({ entityId: "agent-alpha" });

    await vi.waitFor(() => expect(store.cancel).toHaveBeenCalledOnce());
    expect(store.cancel).toHaveBeenCalledWith({
      preparationId: preparation.preparationId,
      fencingToken: "35",
      reason: "contestant_unavailable",
    });
    expect(matchmaking.nextDuelPair).toBeNull();
    expect((scheduler as any).onDeckPreparation).toBeNull();
    expect(cancellations).toEqual([
      expect.objectContaining({
        preparationId: preparation.preparationId,
        reason: "contestant_unavailable",
      }),
    ]);

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("does not cancel a replacement preparation while an old selection unwinds", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const oldPreparation = {
      preparationId: "81f69cb9-6214-46c4-bdac-3840849889f0",
      fencingToken: "33",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const replacementPreparation = {
      ...oldPreparation,
      preparationId: "43b17a03-76b4-4a07-8141-abeb799145e9",
      agent1Id: "agent-gamma",
      agent2Id: "agent-delta",
    };
    let releaseSelection!: () => void;
    const selectionInFlight = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const store = {
      cancel: vi.fn(
        async ({
          preparationId,
          reason,
        }: {
          preparationId: string;
          reason: string;
        }) => ({
          ...(preparationId === oldPreparation.preparationId
            ? oldPreparation
            : replacementPreparation),
          status: "cancelled",
          cancelledAt: Date.now(),
          cancellationReason: reason,
          version: 2,
        }),
      ),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "33",
      preparationDurationMs: 60_000,
      onDeckPreparation: oldPreparation,
      onDeckPreparationPairKey: "agent-alpha\u0000agent-beta",
      preparationSelectionInFlight: selectionInFlight,
      preparationSelectionInFlightPairKey: "agent-alpha\u0000agent-beta",
    });

    const cancellation = (scheduler as any).cancelOnDeckPreparation(
      "pair_cleared",
    );
    expect((scheduler as any).onDeckPreparation).toBeNull();

    Object.assign(scheduler as any, {
      onDeckPreparation: replacementPreparation,
      onDeckPreparationPairKey: "agent-gamma\u0000agent-delta",
    });
    releaseSelection();
    await cancellation;

    expect(store.cancel).toHaveBeenCalledOnce();
    expect(store.cancel).toHaveBeenCalledWith({
      preparationId: oldPreparation.preparationId,
      fencingToken: "33",
      reason: "pair_cleared",
    });
    expect((scheduler as any).onDeckPreparation).toBe(replacementPreparation);
    expect((scheduler as any).onDeckPreparationPairKey).toBe(
      "agent-gamma\u0000agent-delta",
    );

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("auto-readies explicit standalone sparbots through the validated durable gate before selection", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    let preparation = {
      preparationId: "27080dd7-486a-4b4c-a20d-a5d8cab77802",
      fencingToken: "22",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null as number | null,
      agent2ReadyAt: null as number | null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const store = {
      claimContestantHostLease: vi.fn(async (input: any) => ({
        ...input,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + input.leaseDurationMs,
      })),
      heartbeatContestantHostLease: vi.fn(async (input: any) => ({
        ...input,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + input.leaseDurationMs,
      })),
      markReady: vi.fn(async ({ agentId }: { agentId: string }) => {
        preparation = {
          ...preparation,
          agent1ReadyAt:
            agentId === preparation.agent1Id
              ? Date.now()
              : preparation.agent1ReadyAt,
          agent2ReadyAt:
            agentId === preparation.agent2Id
              ? Date.now()
              : preparation.agent2ReadyAt,
          version: preparation.version + 1,
        };
        preparation.status =
          preparation.agent1ReadyAt !== null &&
          preparation.agent2ReadyAt !== null
            ? "ready"
            : "preparing";
        return { ...preparation };
      }),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "22",
      preparationDurationMs: 60_000,
      preparationHostLeaseConfig: {
        leaseMs: 15_000,
        heartbeatMs: 3_000,
        claimGraceMs: 10_000,
      },
      onDeckPreparation: preparation,
      onDeckPreparationPairKey: "agent-alpha\u0000agent-beta",
      standaloneSparbotIds: new Set(["agent-alpha", "agent-beta"]),
    });
    const prayerReadiness = vi
      .spyOn(
        (scheduler as any).orchestrator,
        "preparePrayerForCompetitiveFreeze",
      )
      .mockResolvedValue({ ok: true });
    const loadoutReadiness = vi
      .spyOn((scheduler as any).orchestrator, "inspectCompetitiveLoadout")
      .mockReturnValue({
        ok: true,
        initialCombatRole: "melee",
        availableCombatStyles: ["melee"],
      });
    const selections: any[] = [];
    const readinessEvents: any[] = [];
    ctx.world.on("duel:preparation:selected", (event) =>
      selections.push(event),
    );
    ctx.world.on("duel:preparation:readiness", (event) =>
      readinessEvents.push(event),
    );

    const announced = await (scheduler as any).emitOnDeckPreparationSelected(
      preparation,
    );

    expect(store.markReady.mock.calls.map(([input]) => input.agentId)).toEqual([
      "agent-alpha",
      "agent-beta",
    ]);
    expect(store.claimContestantHostLease).toHaveBeenCalledTimes(2);
    expect(store.heartbeatContestantHostLease).toHaveBeenCalledTimes(2);
    expect(prayerReadiness).toHaveBeenCalledTimes(2);
    // Each standalone contestant is inspected once to derive its diagnostic
    // evidence and again inside the authoritative readiness transition.
    expect(loadoutReadiness).toHaveBeenCalledTimes(4);
    expect(announced).toMatchObject({
      status: "ready",
      agent1ReadyAt: expect.any(Number),
      agent2ReadyAt: expect.any(Number),
      version: 3,
    });
    expect(selections).toEqual([
      expect.objectContaining({ agent1Ready: true, agent2Ready: true }),
    ]);
    expect(readinessEvents).toHaveLength(0);
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("reconciles an already-ready idle preparation immediately instead of waiting for the expiry-bound scheduler tick", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "ff044cd4-1557-47ad-a8d6-caef2e7eb4ee",
      fencingToken: "34",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "ready",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 1_000,
      agent1ReadyAt: Date.now(),
      agent2ReadyAt: Date.now(),
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 3,
    };
    const store = { create: vi.fn(async () => preparation) };
    const reconcile = vi
      .spyOn(scheduler as any, "advancePrivatePreparationGate")
      .mockResolvedValue(undefined);
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "34",
      preparationDurationMs: 1_000,
      preparationSelectionGeneration: 1,
    });
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: preparation.agent1Id,
      agent2Id: preparation.agent2Id,
      selectedAt: Date.now(),
    };

    await (scheduler as any).persistOnDeckPreparation(
      {
        agent1Id: preparation.agent1Id,
        agent2Id: preparation.agent2Id,
      },
      "agent-alpha\u0000agent-beta",
      1,
    );

    expect(store.create).toHaveBeenCalledOnce();
    expect((scheduler as any).onDeckPreparation).toBe(preparation);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.any(Number));
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("keeps an asynchronously ready selection behind the operator maintenance fence", async () => {
    const previousMaintenance = process.env.STREAMING_DUEL_MAINTENANCE_MODE;
    process.env.STREAMING_DUEL_MAINTENANCE_MODE = "true";
    try {
      const ctx = createMockWorld();
      const scheduler = new StreamingDuelScheduler(ctx.world as never);
      const preparation = {
        preparationId: "e9704f89-c93a-41f9-b69b-d6d7050272c5",
        fencingToken: "35",
        agent1Id: "agent-alpha",
        agent2Id: "agent-beta",
        allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
        status: "ready",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1ReadyAt: Date.now(),
        agent2ReadyAt: Date.now(),
        frozenAt: null,
        cancelledAt: null,
        cancellationReason: null,
        version: 3,
      };
      const store = { create: vi.fn(async () => preparation) };
      const announce = vi
        .spyOn(scheduler as any, "emitOnDeckPreparationSelected")
        .mockResolvedValue(preparation);
      const reconcile = vi
        .spyOn(scheduler as any, "advancePrivatePreparationGate")
        .mockResolvedValue(undefined);
      Object.assign(scheduler as any, {
        preparationStore: store,
        preparationFencingToken: "35",
        preparationDurationMs: 60_000,
        preparationSelectionGeneration: 1,
      });
      (scheduler as any).matchmaking.nextDuelPair = {
        agent1Id: preparation.agent1Id,
        agent2Id: preparation.agent2Id,
        selectedAt: preparation.selectedAt,
      };

      await (scheduler as any).persistOnDeckPreparation(
        {
          agent1Id: preparation.agent1Id,
          agent2Id: preparation.agent2Id,
        },
        "agent-alpha\u0000agent-beta",
        1,
      );

      expect(announce).toHaveBeenCalledOnce();
      expect(reconcile).not.toHaveBeenCalled();
      expect((scheduler as any).onDeckPreparation).toBe(preparation);
      scheduler.destroy();
      await scheduler.waitForShutdownCleanup();
    } finally {
      if (previousMaintenance === undefined) {
        delete process.env.STREAMING_DUEL_MAINTENANCE_MODE;
      } else {
        process.env.STREAMING_DUEL_MAINTENANCE_MODE = previousMaintenance;
      }
    }
  });

  it("preserves a durable ready preparation when direct reconciliation overlaps maintenance", async () => {
    const previousMaintenance = process.env.STREAMING_DUEL_MAINTENANCE_MODE;
    process.env.STREAMING_DUEL_MAINTENANCE_MODE = "true";
    try {
      const ctx = createMockWorld();
      const scheduler = new StreamingDuelScheduler(ctx.world as never);
      const preparation = {
        preparationId: "21d42b20-a9ab-4eb3-a225-0f15a715b8f5",
        fencingToken: "36",
        agent1Id: "agent-alpha",
        agent2Id: "agent-beta",
        allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
        status: "ready",
        selectedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        agent1ReadyAt: Date.now(),
        agent2ReadyAt: Date.now(),
        frozenAt: null,
        cancelledAt: null,
        cancellationReason: null,
        version: 3,
      };
      const store = {
        expire: vi.fn(async () => []),
        getActive: vi.fn(async () => preparation),
        getContestantUnavailability: vi.fn(async () => null),
      };
      Object.assign(scheduler as any, {
        preparationStore: store,
        preparationFencingToken: "36",
        preparationDurationMs: 60_000,
        competitiveRecoveryChecked: true,
      });
      (scheduler as any).matchmaking.nextDuelPair = {
        agent1Id: preparation.agent1Id,
        agent2Id: preparation.agent2Id,
        selectedAt: preparation.selectedAt,
      };
      const startNewCycle = vi
        .spyOn(scheduler as any, "startNewCycle")
        .mockResolvedValue(true);

      await (scheduler as any).advancePrivatePreparationGate(Date.now());

      expect(startNewCycle).not.toHaveBeenCalled();
      expect((scheduler as any).onDeckPreparation).toBe(preparation);
      expect((scheduler as any).onDeckPreparationPairKey).toBe(
        "agent-alpha\u0000agent-beta",
      );
      expect((scheduler as any).matchmaking.nextDuelPair).toMatchObject({
        agent1Id: "agent-alpha",
        agent2Id: "agent-beta",
      });
      scheduler.destroy();
      await scheduler.waitForShutdownCleanup();
    } finally {
      if (previousMaintenance === undefined) {
        delete process.env.STREAMING_DUEL_MAINTENANCE_MODE;
      } else {
        process.env.STREAMING_DUEL_MAINTENANCE_MODE = previousMaintenance;
      }
    }
  });

  it("publishes diagnostic gathering through the exact durable public preparation contract", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "9d101da7-154a-47ba-8e5d-c22323677306",
      fencingToken: "37",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "ready",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: Date.now(),
      agent2ReadyAt: Date.now(),
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 3,
    };
    const store = {
      expire: vi.fn(async () => []),
      getActive: vi.fn(async () => preparation),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "37",
      preparationDurationMs: 60_000,
      competitiveRecoveryChecked: true,
    });

    const established = await (
      scheduler as any
    ).ensureDiagnosticPreparationSession(["agent-alpha", "agent-beta"]);
    (scheduler as any).publishDiagnosticPreparationActivity(
      established.preparationId,
      established.agent1Id,
      "gathering",
    );
    (scheduler as any).publishDiagnosticPreparationActivity(
      established.preparationId,
      established.agent2Id,
      "gathering",
    );

    expect(store.expire).toHaveBeenCalledOnce();
    expect(store.getActive).toHaveBeenCalledOnce();
    expect(
      (scheduler as any).getPublicPreparationSummary(
        Date.now(),
        preparation.agent1Id,
        preparation.agent2Id,
      ),
    ).toEqual({
      schemaVersion: 2,
      status: "ready",
      selectedAt: preparation.selectedAt,
      expiresAt: preparation.expiresAt,
      agent1: {
        id: "agent-alpha",
        ready: true,
        activity: "gathering",
        mode: "working",
        activityTrail: ["gathering"],
      },
      agent2: {
        id: "agent-beta",
        ready: true,
        activity: "gathering",
        mode: "working",
        activityTrail: ["gathering"],
      },
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("does not overwrite newer in-memory preparation readiness with a stale concurrent response", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "bf330c8e-3877-49fd-9cc2-663ed2082534",
      fencingToken: "23",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "ready",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: Date.now(),
      agent2ReadyAt: Date.now(),
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 3,
    };
    const stale = {
      ...preparation,
      status: "preparing",
      agent2ReadyAt: null,
      version: 2,
    };
    Object.assign(scheduler as any, {
      preparationStore: { markReady: vi.fn(async () => stale) },
      preparationFencingToken: "23",
      onDeckPreparation: preparation,
    });
    vi.spyOn(
      (scheduler as any).orchestrator,
      "preparePrayerForCompetitiveFreeze",
    ).mockResolvedValue({ ok: true });
    vi.spyOn(
      (scheduler as any).orchestrator,
      "inspectCompetitiveLoadout",
    ).mockReturnValue({ ok: true });
    const readinessEvents: any[] = [];
    ctx.world.on("duel:preparation:readiness", (event) =>
      readinessEvents.push(event),
    );

    await (scheduler as any).confirmOnDeckPreparation(
      preparation.preparationId,
      preparation.agent1Id,
      true,
      testPlanEvidence(),
    );

    expect((scheduler as any).onDeckPreparation).toBe(preparation);
    expect(readinessEvents).toEqual([
      expect.objectContaining({ bothReady: true }),
    ]);
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("retries a transient preparation-readiness serialization conflict without rejecting the contestant", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "b1ee941b-c542-451d-b806-9372f8415f09",
      fencingToken: "24",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const updated = {
      ...preparation,
      agent1ReadyAt: Date.now(),
      version: 2,
    };
    const serializationConflict = Object.assign(
      new Error("could not serialize access due to read/write dependencies"),
      { code: "40001" },
    );
    const store = {
      markReady: vi
        .fn()
        .mockRejectedValueOnce(serializationConflict)
        .mockResolvedValueOnce(updated),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "24",
      onDeckPreparation: preparation,
    });
    const prayerReadiness = vi
      .spyOn(
        (scheduler as any).orchestrator,
        "preparePrayerForCompetitiveFreeze",
      )
      .mockResolvedValue({ ok: true });
    const loadoutReadiness = vi
      .spyOn((scheduler as any).orchestrator, "inspectCompetitiveLoadout")
      .mockReturnValue({ ok: true });
    const readinessEvents: any[] = [];
    const rejectionEvents: any[] = [];
    ctx.world.on("duel:preparation:readiness", (event) =>
      readinessEvents.push(event),
    );
    ctx.world.on("duel:preparation:readiness_rejected", (event) =>
      rejectionEvents.push(event),
    );
    const errorLog = vi.spyOn(Logger, "error").mockImplementation(() => {});

    const confirmation = (scheduler as any).confirmOnDeckPreparation(
      preparation.preparationId,
      preparation.agent1Id,
      true,
      testPlanEvidence(),
    );
    await vi.advanceTimersByTimeAsync(10);
    await confirmation;

    expect(store.markReady).toHaveBeenCalledTimes(2);
    expect(prayerReadiness).toHaveBeenCalledOnce();
    expect(loadoutReadiness).toHaveBeenCalledOnce();
    expect((scheduler as any).onDeckPreparation).toBe(updated);
    expect(readinessEvents).toEqual([
      expect.objectContaining({
        agentId: preparation.agent1Id,
        agent1Ready: true,
        agent2Ready: false,
        bothReady: false,
      }),
    ]);
    expect(rejectionEvents).toEqual([]);
    expect(errorLog).not.toHaveBeenCalledWith(
      "StreamingDuelScheduler",
      expect.stringContaining("Failed to persist preparation readiness"),
    );
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("re-announces a partially ready durable preparation once after scheduler recovery", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "ab218e5d-4ce2-4761-8306-1699e073483f",
      fencingToken: "18",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now() - 5_000,
      expiresAt: Date.now() + 55_000,
      agent1ReadyAt: Date.now() - 1_000,
      agent2ReadyAt: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 2,
    };
    const store = {
      create: vi.fn(),
      getActive: vi.fn(async () => preparation),
      getContestantUnavailability: vi.fn(async () => null),
      expire: vi.fn(async () => []),
      freeze: vi.fn(),
      cancel: vi.fn(),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "18",
      preparationDurationMs: 60_000,
    });
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
    };
    const selections: any[] = [];
    ctx.world.on("duel:preparation:selected", (event) =>
      selections.push(event),
    );

    await (scheduler as any).advancePrivatePreparationGate(Date.now());
    await (scheduler as any).advancePrivatePreparationGate(Date.now());

    expect(store.create).not.toHaveBeenCalled();
    expect(selections).toEqual([
      expect.objectContaining({
        preparationId: preparation.preparationId,
        agent1Ready: true,
        agent2Ready: false,
      }),
    ]);
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("retries a transient preparation-gate serialization conflict without an error log", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const serializationConflict = Object.assign(
      new Error("could not serialize access due to concurrent update"),
      { code: "40001" },
    );
    const store = {
      expire: vi
        .fn()
        .mockRejectedValueOnce(serializationConflict)
        .mockResolvedValueOnce([]),
      getActive: vi.fn(async () => null),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "20",
      preparationDurationMs: 60_000,
      competitiveRecoveryChecked: true,
    });
    (scheduler as any).matchmaking.nextDuelPair = null;
    vi.spyOn(
      (scheduler as any).matchmaking,
      "refreshNextDuelPair",
    ).mockImplementation(() => undefined);
    const errorLog = vi.spyOn(Logger, "error").mockImplementation(() => {});

    const reconciliation = (scheduler as any).advancePrivatePreparationGate(
      Date.now(),
    );
    await vi.advanceTimersByTimeAsync(10);
    await reconciliation;

    expect(store.expire).toHaveBeenCalledTimes(2);
    expect(errorLog).not.toHaveBeenCalledWith(
      "StreamingDuelScheduler",
      expect.stringContaining("Private preparation gate failed closed"),
    );
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("re-announces recovered readiness before starting competitive freeze", async () => {
    const ctx = createMockWorld({
      alphaWeaponId: "iron_sword",
      betaWeaponId: "bronze_longsword",
    });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "fa7547d6-35f4-4898-806c-caa2ba26200d",
      fencingToken: "19",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "ready",
      selectedAt: Date.now() - 5_000,
      expiresAt: Date.now() + 55_000,
      agent1ReadyAt: Date.now() - 2_000,
      agent2ReadyAt: Date.now() - 1_000,
      agent1PlanEvidence: testPlanEvidence(),
      agent2PlanEvidence: testPlanEvidence(),
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 3,
    };
    const store = {
      create: vi.fn(),
      getActive: vi.fn(async () => preparation),
      getContestantUnavailability: vi.fn(async () => null),
      expire: vi.fn(async () => []),
      freeze: vi.fn(),
      cancel: vi.fn(),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "19",
      preparationDurationMs: 60_000,
      competitiveRecoveryChecked: true,
    });
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
    };
    const order: string[] = [];
    ctx.world.on("duel:preparation:selected", () => order.push("selected"));
    const startNewCycle = vi
      .spyOn(scheduler as any, "startNewCycle")
      .mockImplementation(async () => {
        order.push("start");
        return true;
      });

    await (scheduler as any).advancePrivatePreparationGate(Date.now());

    expect(order).toEqual(["selected", "start"]);
    expect(startNewCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        agent1Id: preparation.agent1Id,
        agent2Id: preparation.agent2Id,
      }),
      preparation,
    );
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("coalesces concurrent persistence for the same on-deck pair", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const pair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: Date.now(),
    };
    let resolveCreate!: (value: any) => void;
    const createResult = new Promise<any>((resolve) => {
      resolveCreate = resolve;
    });
    const preparation = {
      preparationId: "42d8c0b7-5e71-47ed-8766-a4e5d5a8fc01",
      fencingToken: "24",
      agent1Id: pair.agent1Id,
      agent2Id: pair.agent2Id,
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const store = {
      create: vi.fn(() => createResult),
      cancel: vi.fn(async () => ({ ...preparation, status: "cancelled" })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "24",
      preparationDurationMs: 60_000,
      competitiveRecoveryChecked: true,
    });
    (scheduler as any).matchmaking.nextDuelPair = pair;

    const first = (scheduler as any).beginOnDeckPreparation(pair);
    await Promise.resolve();
    const second = (scheduler as any).beginOnDeckPreparation(pair);

    expect(store.create).toHaveBeenCalledOnce();
    resolveCreate(preparation);
    await Promise.all([first, second]);

    expect(store.create).toHaveBeenCalledOnce();
    expect(store.cancel).not.toHaveBeenCalled();
    expect((scheduler as any).onDeckPreparation).toMatchObject({
      preparationId: preparation.preparationId,
    });
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("evicts stale in-memory eligibility when durable preparation rejects an opt-out", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const pair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: Date.now(),
    };
    const store = {
      create: vi.fn(async () => {
        throw new Error("competitive_contestant_participation_not_enabled");
      }),
    };
    scheduler.applyStreamingDuelParticipation(pair.agent1Id, true);
    scheduler.applyStreamingDuelParticipation(pair.agent2Id, true);
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "25",
      preparationDurationMs: 60_000,
      competitiveRecoveryChecked: true,
    });
    const reconcile = vi.spyOn(
      scheduler as any,
      "reconcilePersistedStreamingDuelParticipation",
    );
    (scheduler as any).matchmaking.nextDuelPair = pair;
    expect((scheduler as any).getDatabase()).toBeNull();

    await (scheduler as any).beginOnDeckPreparation(pair);

    expect(store.create).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(new Set(reconcile.mock.calls[0]![0] as string[])).toEqual(
      new Set([pair.agent1Id, pair.agent2Id]),
    );
    expect(scheduler.getSchedulerState().availableAgents).toBe(0);
    expect((scheduler as any).matchmaking.nextDuelPair).toBeNull();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("keeps durable reconciliation responsive while same-pair delivery is still in flight", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const pair = {
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      selectedAt: Date.now(),
    };
    let resolveCreate!: (value: any) => void;
    const createResult = new Promise<any>((resolve) => {
      resolveCreate = resolve;
    });
    const preparation = {
      preparationId: "0363eaa5-cade-47c1-843b-4f6876adf1d1",
      fencingToken: "26",
      agent1Id: pair.agent1Id,
      agent2Id: pair.agent2Id,
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "preparing",
      selectedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      agent1ReadyAt: null,
      agent2ReadyAt: null,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 1,
    };
    const store = {
      create: vi.fn(() => createResult),
      getActive: vi.fn(async () => null),
      expire: vi.fn(async () => []),
      cancel: vi.fn(async () => ({ ...preparation, status: "cancelled" })),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "26",
      preparationDurationMs: 60_000,
    });
    (scheduler as any).matchmaking.nextDuelPair = pair;

    const selection = (scheduler as any).beginOnDeckPreparation(pair);
    await Promise.resolve();

    await (scheduler as any).advancePrivatePreparationGate(Date.now());

    expect(store.create).toHaveBeenCalledOnce();
    expect(store.expire).toHaveBeenCalledOnce();
    expect(store.getActive).toHaveBeenCalledOnce();
    expect((scheduler as any).preparationIdleCheckInFlight).toBe(false);

    resolveCreate(preparation);
    await selection;
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("rehydrates live standalone contestants after scheduler authority handoff", async () => {
    for (const [key, value] of Object.entries(localNoMoneyDiagnosticEnv())) {
      if (value !== undefined) vi.stubEnv(key, value);
    }
    const standaloneIds = [
      "sparbot-standalone-multi-00000000-0000-4000-8000-000000000001",
      "sparbot-standalone-00000000-0000-4000-8000-000000000002",
    ];
    const ctx = createMockWorld({
      extraAgents: standaloneIds.map((id, index) => ({
        id,
        name: index === 0 ? "Riven Ash" : "Astra Vale",
        position: [index * 2, 0.2, index * 2] as [number, number, number],
      })),
    });
    ctx.entities.delete("agent-alpha");
    ctx.entities.delete("agent-beta");
    for (const id of standaloneIds) {
      const entity = ctx.entities.get(id)!;
      entity.isAgent = false;
    }
    const scheduler = new StreamingDuelScheduler(ctx.world as never);

    (scheduler as any).scanForExistingAgentsWithEligibility();

    expect(scheduler.getSchedulerState().availableAgents).toBe(2);
    expect((scheduler as any).standaloneSparbotIds).toEqual(
      new Set(standaloneIds),
    );
    expect(
      (scheduler as any).standaloneSparbotMeta.get(standaloneIds[0]),
    ).toEqual(expect.objectContaining({ multiStyle: true }));
    expect(
      (scheduler as any).orchestrator.diagnosticMultiStyleCharacterIds,
    ).toContain(standaloneIds[0]);

    (scheduler as any).matchmaking.availableAgents.clear();
    (scheduler as any).reconcileStandaloneSparbotsFromWorld();

    expect(scheduler.getSchedulerState().availableAgents).toBe(2);
    const idlePreviewState = scheduler.getStreamingState();
    expect(
      new Set([
        idlePreviewState.cycle.agent1?.id,
        idlePreviewState.cycle.agent2?.id,
      ]),
    ).toEqual(new Set(standaloneIds));
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("does not let a production preference lookup evict a joined local standalone contestant", async () => {
    for (const [key, value] of Object.entries(localNoMoneyDiagnosticEnv())) {
      if (value !== undefined) vi.stubEnv(key, value);
    }
    const standaloneId =
      "sparbot-standalone-00000000-0000-4000-8000-000000000004";
    const ctx = createMockWorld({
      extraAgents: [
        {
          id: standaloneId,
          name: "Riven Ash",
          position: [0, 0.2, 0],
        },
      ],
    });
    ctx.entities.delete("agent-alpha");
    ctx.entities.delete("agent-beta");
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const persistedPreferenceLookup = vi.spyOn(
      scheduler as any,
      "registerAgentFromDatabasePreference",
    );

    (scheduler as any).registerAgentIfEligible(standaloneId);
    await Promise.resolve();

    expect(persistedPreferenceLookup).not.toHaveBeenCalled();
    expect(scheduler.getSchedulerState().availableAgents).toBe(1);
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("does not treat a reserved sparbot prefix as production participation authority", () => {
    vi.stubEnv("DUEL_LOCAL_SMOKE_MODE", "false");
    const reservedId =
      "sparbot-standalone-00000000-0000-4000-8000-000000000003";
    const ctx = createMockWorld({
      extraAgents: [
        {
          id: reservedId,
          name: "Unverified",
          position: [0, 0.2, 0],
        },
      ],
    });
    ctx.entities.delete("agent-alpha");
    ctx.entities.delete("agent-beta");
    ctx.entities.get(reservedId)!.isAgent = false;
    const scheduler = new ProductionStreamingDuelScheduler(ctx.world as never);

    (scheduler as any).scanForExistingAgentsWithEligibility();

    expect(scheduler.getSchedulerState().availableAgents).toBe(0);
    expect((scheduler as any).standaloneSparbotIds).toEqual(new Set());
    scheduler.destroy();
  });

  it("rejects debug contestant mutation before changing a production world", async () => {
    vi.stubEnv("DUEL_LOCAL_SMOKE_MODE", "false");
    const ctx = createMockWorld();
    const scheduler = new ProductionStreamingDuelScheduler(ctx.world as never);
    const entityCount = ctx.entities.size;

    await expect(
      scheduler.queueDebugMatchup({
        targetCharacterId: "agent-alpha",
        spawnOpponent: true,
      }),
    ).rejects.toThrow(/explicit loopback no-money boundary/u);
    await expect(scheduler.spawnStandaloneSparbots(2, "melee")).rejects.toThrow(
      /explicit loopback no-money boundary/u,
    );

    expect(ctx.entities.size).toBe(entityCount);
    expect(scheduler.getSchedulerState().availableAgents).toBe(0);
    scheduler.destroy();
  });

  it("does not treat embedded-agent flags as participation authority", () => {
    const ctx = createMockWorld();
    for (const entity of ctx.entities.values()) {
      entity.isAgent = false;
      Object.assign(entity.data, { isEmbeddedAgent: true });
    }
    const scheduler = new ProductionStreamingDuelScheduler(ctx.world as never);

    (scheduler as any).scanForExistingAgentsWithEligibility();

    expect(scheduler.getSchedulerState().availableAgents).toBe(0);
    scheduler.applyStreamingDuelParticipation("agent-alpha", true);
    scheduler.applyStreamingDuelParticipation("agent-beta", true);
    expect(scheduler.getSchedulerState().availableAgents).toBe(2);
    scheduler.destroy();
  });

  it("recovers a ready durable preparation when matchmaking reverses the same pair", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const preparation = {
      preparationId: "677c5c61-70bf-466f-a82e-405f687aec6e",
      fencingToken: "25",
      agent1Id: "agent-alpha",
      agent2Id: "agent-beta",
      allowedBankActions: ["open", "deposit", "withdraw", "deposit_all"],
      status: "ready",
      selectedAt: Date.now() - 5_000,
      expiresAt: Date.now() + 55_000,
      agent1ReadyAt: Date.now() - 2_000,
      agent2ReadyAt: Date.now() - 1_000,
      frozenAt: null,
      cancelledAt: null,
      cancellationReason: null,
      version: 3,
    };
    const frozen = {
      ...preparation,
      status: "frozen",
      frozenAt: Date.now(),
      version: 4,
    };
    const store = {
      create: vi.fn(),
      getActive: vi.fn(async () => preparation),
      getContestantUnavailability: vi.fn(async () => null),
      expire: vi.fn(async () => []),
      cancel: vi.fn(),
    };
    Object.assign(scheduler as any, {
      preparationStore: store,
      preparationFencingToken: "25",
      preparationDurationMs: 60_000,
    });
    (scheduler as any).matchmaking.nextDuelPair = {
      agent1Id: "agent-beta",
      agent2Id: "agent-alpha",
      selectedAt: Date.now(),
    };
    const startNewCycle = vi
      .spyOn(scheduler as any, "startNewCycle")
      .mockResolvedValue(true);

    await (scheduler as any).advancePrivatePreparationGate(Date.now());

    expect(store.create).not.toHaveBeenCalled();
    expect(startNewCycle).toHaveBeenCalledWith(
      {
        agent1Id: preparation.agent1Id,
        agent2Id: preparation.agent2Id,
        selectedAt: preparation.selectedAt,
      },
      preparation,
    );
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("waits inside the durable preparation lease for admitted processing to settle", async () => {
    let quiet = false;
    const processingQuiescenceSystem = {
      requestPlayerProcessingQuiescence: vi.fn(),
      isPlayerProcessingQuiescent: vi.fn(() => quiet),
    };
    const ctx = createMockWorld({ processingQuiescenceSystem });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const internal = scheduler as any;
    const deadline = Date.now() + STREAMING_TIMING.STATE_BROADCAST_INTERVAL * 2;

    const barrier = internal.quiesceContestantsBeforeCompetitiveFreeze(
      ["agent-alpha", "agent-beta"],
      { expiresAt: deadline },
    ) as Promise<boolean>;
    await Promise.resolve();

    expect(
      processingQuiescenceSystem.requestPlayerProcessingQuiescence,
    ).toHaveBeenNthCalledWith(1, "agent-alpha");
    expect(
      processingQuiescenceSystem.requestPlayerProcessingQuiescence,
    ).toHaveBeenNthCalledWith(2, "agent-beta");
    expect(internal.preMarketProcessingFences).toEqual([]);

    quiet = true;
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
    );
    await expect(barrier).resolves.toBe(true);
    expect(internal.preMarketProcessingFences).toHaveLength(2);

    internal.releasePreMarketProcessingFences();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("fails closed at the processing deadline and releases admission only after later settlement", async () => {
    let quiet = false;
    const processingQuiescenceSystem = {
      requestPlayerProcessingQuiescence: vi.fn(),
      isPlayerProcessingQuiescent: vi.fn(() => quiet),
    };
    const ctx = createMockWorld({ processingQuiescenceSystem });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const internal = scheduler as any;

    await expect(
      Promise.resolve(
        internal.quiesceContestantsBeforeCompetitiveFreeze(
          ["agent-alpha", "agent-beta"],
          { expiresAt: Date.now() },
        ),
      ),
    ).resolves.toBe(false);
    expect(internal.deferredProcessingFenceReleases.size).toBe(1);

    quiet = true;
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
    );
    expect(internal.deferredProcessingFenceReleases.size).toBe(0);

    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("revalidates contestant life after admitted processing settles", async () => {
    let quiet = false;
    const processingQuiescenceSystem = {
      requestPlayerProcessingQuiescence: vi.fn(),
      isPlayerProcessingQuiescent: vi.fn(() => quiet),
    };
    const ctx = createMockWorld({ processingQuiescenceSystem });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const internal = scheduler as any;
    internal.matchmaking.availableAgents.add("agent-alpha");
    internal.matchmaking.availableAgents.add("agent-beta");
    const freeze = vi.spyOn(internal.orchestrator, "freezeCompetitiveLoadout");
    const scheduled = vi.fn();
    ctx.world.on("duel:scheduled", scheduled);

    const admission = internal.startNewCycleInternal(undefined, {
      expiresAt: Date.now() + STREAMING_TIMING.STATE_BROADCAST_INTERVAL * 2,
    }) as Promise<void>;
    await Promise.resolve();
    ctx.entities.delete("agent-beta");
    quiet = true;
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
    );
    await admission;

    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(freeze).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(internal.preMarketProcessingFences).toEqual([]);
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("keeps processing fenced while replacement authority rechecks an unsettled receipt", async () => {
    let quiet = false;
    const processingQuiescenceSystem = {
      requestPlayerProcessingQuiescence: vi.fn(),
      isPlayerProcessingQuiescent: vi.fn(() => quiet),
    };
    const ctx = createMockWorld({ processingQuiescenceSystem });
    const first = new StreamingDuelScheduler(ctx.world as never);
    const firstInternal = first as any;
    firstInternal.matchmaking.availableAgents.add("agent-alpha");
    firstInternal.matchmaking.availableAgents.add("agent-beta");
    const firstFreeze = vi.spyOn(
      firstInternal.orchestrator,
      "freezeCompetitiveLoadout",
    );
    const deadline = Date.now() + STREAMING_TIMING.STATE_BROADCAST_INTERVAL * 3;
    const firstAdmission = firstInternal.startNewCycleInternal(undefined, {
      expiresAt: deadline,
    }) as Promise<void>;
    await Promise.resolve();

    expect(
      canPlayerPerformPreparationAction(ctx.world as never, "agent-alpha"),
    ).toBe(false);
    first.destroy();

    const replacement = new StreamingDuelScheduler(ctx.world as never);
    const replacementInternal = replacement as any;
    replacementInternal.matchmaking.availableAgents.add("agent-alpha");
    replacementInternal.matchmaking.availableAgents.add("agent-beta");
    const replacementFreeze = vi.spyOn(
      replacementInternal.orchestrator,
      "freezeCompetitiveLoadout",
    );
    const scheduled = vi.fn();
    ctx.world.on("duel:scheduled", scheduled);
    const replacementAdmission = replacementInternal.startNewCycleInternal(
      undefined,
      { expiresAt: deadline },
    ) as Promise<void>;
    await Promise.resolve();

    expect(firstFreeze).not.toHaveBeenCalled();
    expect(replacementFreeze).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(
      canPlayerPerformPreparationAction(ctx.world as never, "agent-alpha"),
    ).toBe(false);
    expect(
      processingQuiescenceSystem.requestPlayerProcessingQuiescence,
    ).toHaveBeenCalledTimes(4);

    quiet = true;
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
    );
    await Promise.all([firstAdmission, replacementAdmission]);

    expect(first.getCurrentCycle()).toBeNull();
    expect(firstFreeze).not.toHaveBeenCalled();
    expect(replacement.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
    expect(replacementFreeze).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveBeenCalledOnce();

    replacement.destroy();
    await Promise.all([
      first.waitForShutdownCleanup(),
      replacement.waitForShutdownCleanup(),
    ]);
  });

  it("never freezes or publishes a diagnostic matchup while contestant processing is active", async () => {
    let quiet = false;
    const processingQuiescenceSystem = {
      requestPlayerProcessingQuiescence: vi.fn(),
      isPlayerProcessingQuiescent: vi.fn(() => quiet),
    };
    const ctx = createMockWorld({ processingQuiescenceSystem });
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const internal = scheduler as any;
    internal.matchmaking.availableAgents.add("agent-alpha");
    internal.matchmaking.availableAgents.add("agent-beta");
    const freeze = vi.spyOn(internal.orchestrator, "freezeCompetitiveLoadout");
    const scheduled = vi.fn();
    ctx.world.on("duel:scheduled", scheduled);

    await internal.startNewCycleInternal();

    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(freeze).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(
      processingQuiescenceSystem.requestPlayerProcessingQuiescence,
    ).toHaveBeenCalledTimes(2);

    quiet = true;
    await vi.advanceTimersByTimeAsync(
      STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
    );
    await internal.startNewCycleInternal();

    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
    expect(scheduled).toHaveBeenCalledOnce();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("keeps transiently unready connected agents eligible for automatic retry", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const matchmaking = (scheduler as any).matchmaking;
    matchmaking.availableAgents.add("agent-alpha");
    matchmaking.availableAgents.add("agent-beta");
    const orchestrator = (scheduler as any).orchestrator;
    const inspectCompetitiveLoadout =
      orchestrator.inspectCompetitiveLoadout.bind(orchestrator);
    let rejectAlphaOnce = true;
    vi.spyOn(orchestrator, "inspectCompetitiveLoadout").mockImplementation(
      (...args: unknown[]) => {
        const agentId = String(args[0] ?? "");
        if (agentId === "agent-alpha" && rejectAlphaOnce) {
          rejectAlphaOnce = false;
          return { ok: false, reason: "inventory_not_ready" };
        }
        return inspectCompetitiveLoadout(agentId);
      },
    );

    await (scheduler as any).startNewCycleInternal();

    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(matchmaking.availableAgents).toEqual(
      new Set(["agent-alpha", "agent-beta"]),
    );

    await (scheduler as any).startNewCycleInternal();

    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("keeps a dead registered agent out of cycle preflight until authoritative respawn", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    const internal = scheduler as any;
    internal.matchmaking.availableAgents.add("agent-alpha");
    internal.matchmaking.availableAgents.add("agent-beta");
    const beta = ctx.entities.get("agent-beta")!;
    beta.data.health = 0;
    beta.data.alive = false;
    const freeze = vi.spyOn(internal.orchestrator, "freezeCompetitiveLoadout");

    await internal.startNewCycleInternal();

    expect(scheduler.getCurrentCycle()).toBeNull();
    expect(freeze).not.toHaveBeenCalled();
    expect(internal.matchmaking.availableAgents.has("agent-beta")).toBe(true);

    beta.data.health = beta.data.maxHealth;
    beta.data.alive = true;
    await internal.startNewCycleInternal();

    expect(scheduler.getCurrentCycle()?.phase).toBe("ANNOUNCEMENT");
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });

  it("routes every post-cleanup cycle through durable preparation when enabled", async () => {
    const ctx = createMockWorld();
    const scheduler = new StreamingDuelScheduler(ctx.world as never);
    scheduler.init();
    Object.assign(scheduler as any, { preparationStore: {} });
    vi.spyOn(
      (scheduler as any).orchestrator,
      "cleanupAfterDuel",
    ).mockResolvedValue(undefined);
    const advancePreparation = vi
      .spyOn(scheduler as any, "advancePrivatePreparationGate")
      .mockResolvedValue(undefined);
    const startNewCycle = vi.spyOn(scheduler as any, "startNewCycle");

    (scheduler as any).endCycle();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(STREAMING_TIMING.INTER_CYCLE_DELAY_MS);

    expect(advancePreparation).toHaveBeenCalledOnce();
    expect(startNewCycle).not.toHaveBeenCalled();
    scheduler.destroy();
    await scheduler.waitForShutdownCleanup();
  });
});
