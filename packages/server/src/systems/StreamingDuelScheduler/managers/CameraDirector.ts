/**
 * CameraDirector - Manages camera targeting logic for streaming duel spectator views.
 *
 * Extracted from StreamingDuelScheduler to isolate all camera selection,
 * activity tracking, fight cutaway, and idle preview logic.
 */

import type { World } from "@hyperforge/shared";
import type { StreamingPhase, StreamingDuelCycle } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type AgentCombatData = {
  inCombat?: boolean;
  combatTarget?: string | null;
  ct?: string | null;
  attackTarget?: string | null;
  /** Animation/emote — reveals skilling state (e.g. "chopping", "mining", "fishing") */
  e?: string;
};

type AgentActivityType = "combat" | "skilling" | "moving" | "idle";

type AgentActivitySample = {
  lastPosition: [number, number, number] | null;
  lastSampleTime: number;
  lastInterestingTime: number;
  lastFocusedTime: number;
  motionScore: number;
  combatScore: number;
  eventScore: number;
};

type CameraSwitchTiming = {
  minHoldMs: number;
  maxHoldMs: number;
  idleThresholdMs: number;
};

type CameraCandidateWeight = {
  agentId: string;
  weight: number;
  activityScore: number;
  isInCombat: boolean;
  isContestant: boolean;
};

type CameraPhaseWeightConfig = {
  contestant: number;
  nonContestant: number;
  winner?: number;
};

type NextDuelPair = {
  agent1Id: string;
  agent2Id: string;
  selectedAt: number;
};

// ============================================================================
// Helpers
// ============================================================================

const clampNumber = (value: number, min: number, max: number): number => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

// ============================================================================
// Configuration
// ============================================================================

const CAMERA_DIRECTOR = {
  switchTiming: {
    IDLE: { minHoldMs: 30_000, maxHoldMs: 90_000, idleThresholdMs: 15_000 },
    ANNOUNCEMENT: {
      minHoldMs: 22_000,
      maxHoldMs: 95_000,
      idleThresholdMs: 12_000,
    },
    COUNTDOWN: { minHoldMs: 6_000, maxHoldMs: 24_000, idleThresholdMs: 6_000 },
    FIGHTING: {
      minHoldMs: 28_000,
      maxHoldMs: 90_000,
      idleThresholdMs: 20_000,
    },
    RESOLUTION: { minHoldMs: 8_000, maxHoldMs: 45_000, idleThresholdMs: 8_000 },
  } as Record<StreamingPhase, CameraSwitchTiming>,
  baseWeights: {
    IDLE: { contestant: 1.3, nonContestant: 1.3 },
    ANNOUNCEMENT: { contestant: 8.4, nonContestant: 1.75 },
    COUNTDOWN: { contestant: 10.5, nonContestant: 0.55 },
    FIGHTING: { contestant: 14.0, nonContestant: 0.6 },
    RESOLUTION: { contestant: 2.2, nonContestant: 0.45, winner: 16 },
  } as Record<StreamingPhase, CameraPhaseWeightConfig>,
  activity: {
    maxActivityScore: 12,
    weightPerPoint: 0.12,
  },
  multipliers: {
    inCombat: 2.4,
    currentTargetBias: 1.45,
    recentFocusPenaltyShort: 0.45,
    recentFocusPenaltyLong: 0.78,
    switchRandomChance: 0.12,
    strongerThresholdActive: 1.55,
    strongerThresholdIdle: 1.1,
  },
  idlePenalty: {
    softThresholdMs: 12_000,
    hardThresholdMs: 25_000,
    softMultiplier: 0.75,
    hardContestantMultiplier: 0.78,
    hardNonContestantMultiplier: 0.52,
  },
  nextDuelWeightBoost: {
    IDLE: 1.5,
    ANNOUNCEMENT: 1.95,
    COUNTDOWN: 1.45,
    FIGHTING: 1.25,
    RESOLUTION: 1.15,
  } as Record<StreamingPhase, number>,
  fightingCutaway: {
    initialContestantLockMs: 35_000,
    contestantIdleThresholdMs: 20_000,
    nonContestantSuppressionMultiplier: 0.02,
    nonContestantAllowedMultiplier: 0.6,
    maxSingleCutawayMs: 10_000,
    maxTotalCutawayMs: 30_000,
    cutawayCooldownMs: 50_000,
  },
  /**
   * Idle-phase camera: activity-aware weighted selection so the camera
   * always follows the most interesting agent between duels.
   */
  idle: {
    /** On-deck agents (next duel pair) get strong preference — builds narrative */
    onDeckBoost: 2.8,
    /** Per-activity-type multiplier: combat > skilling > moving >>> idle */
    activityTypeMultiplier: {
      combat: 3.2,
      skilling: 2.0,
      moving: 1.3,
      idle: 0.15,
    } as Record<AgentActivityType, number>,
    /** Hold times vary by what the current target is doing */
    holdByActivity: {
      combat: { minHoldMs: 25_000, maxHoldMs: 75_000 },
      skilling: { minHoldMs: 18_000, maxHoldMs: 55_000 },
      moving: { minHoldMs: 10_000, maxHoldMs: 35_000 },
      idle: { minHoldMs: 6_000, maxHoldMs: 15_000 },
    } as Record<AgentActivityType, { minHoldMs: number; maxHoldMs: number }>,
    /** Mild current-target stickiness so camera doesn't jitter */
    currentTargetBias: 1.15,
    /** Threshold: new candidate must be this much stronger to trigger early switch */
    strongerThreshold: 1.2,
    /** Small random chance to switch for variety (per eligible check) */
    switchRandomChance: 0.18,
  },
  /** Known skilling emotes from PendingGatherManager / PendingCookManager */
  skillingEmotes: new Set([
    "chopping",
    "mining",
    "fishing",
    "cooking",
    "smithing",
    "firemaking",
    "smelting",
  ]),
} as const;

/** Minimum agents required (matches scheduler config). */
const MIN_AGENTS = 2;

// ============================================================================
// CameraDirector
// ============================================================================

export class CameraDirector {
  // ---- Owned state ----

  private _cameraTarget: string | null = null;
  private lastCameraSwitchTime: number = 0;
  private agentActivity: Map<string, AgentActivitySample> = new Map();
  private fightCutawayStartedAt: number | null = null;
  private fightCutawayTotalMs: number = 0;
  private fightLastCutawayEndedAt: number = 0;
  private cachedContestantIds: Set<string> = new Set();
  private pendingIdlePreparationActivityTarget: string | null = null;

  constructor(
    private readonly world: World,
    private readonly getAvailableAgents: () => Set<string>,
    private readonly getCurrentCycle: () => StreamingDuelCycle | null,
    private readonly getNextDuelPair: () => NextDuelPair | null,
    private readonly setNextDuelPairFromRefresh: (
      pair: NextDuelPair | null,
    ) => void,
  ) {}

  // ---- Public accessors ----

  get cameraTarget(): string | null {
    return this._cameraTarget;
  }

  // ---- Lifecycle ----

  reset(): void {
    this._cameraTarget = null;
    this.lastCameraSwitchTime = 0;
    this.agentActivity.clear();
    this.fightCutawayStartedAt = null;
    this.fightCutawayTotalMs = 0;
    this.fightLastCutawayEndedAt = 0;
    this.cachedContestantIds = new Set();
    this.pendingIdlePreparationActivityTarget = null;
  }

  // ---- Agent activity ----

  ensureAgentActivity(agentId: string, now: number): AgentActivitySample {
    const existing = this.agentActivity.get(agentId);
    if (existing) {
      return existing;
    }

    const entity = this.world.entities.get(agentId);
    const startPosition = entity
      ? (this.normalizePosition(
          (
            entity as {
              data?: { position?: unknown };
            }
          ).data?.position,
        ) ??
        this.normalizePosition((entity as { position?: unknown }).position))
      : null;

    const sample: AgentActivitySample = {
      lastPosition: startPosition,
      lastSampleTime: now,
      lastInterestingTime: now,
      lastFocusedTime: 0,
      motionScore: 0,
      combatScore: 0,
      eventScore: 0,
    };
    this.agentActivity.set(agentId, sample);
    return sample;
  }

  decayAgentActivity(sample: AgentActivitySample, now: number): void {
    const elapsedSeconds = (now - sample.lastSampleTime) / 1000;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
      sample.lastSampleTime = now;
      return;
    }

    sample.motionScore *= Math.exp(-1.1 * elapsedSeconds);
    sample.combatScore *= Math.exp(-0.8 * elapsedSeconds);
    sample.eventScore *= Math.exp(-1.45 * elapsedSeconds);
    sample.lastSampleTime = now;
  }

  markAgentInteresting(agentId: string, intensity: number, now: number): void {
    if (!this.getAvailableAgents().has(agentId)) {
      return;
    }

    const sample = this.ensureAgentActivity(agentId, now);
    this.decayAgentActivity(sample, now);

    const clampedIntensity = clampNumber(intensity, 0.1, 6);
    sample.eventScore = clampNumber(
      sample.eventScore + clampedIntensity,
      0,
      18,
    );
    sample.combatScore = clampNumber(
      sample.combatScore + clampedIntensity * 0.45,
      0,
      14,
    );
    sample.lastInterestingTime = now;
  }

  isAgentInCombat(data: AgentCombatData | undefined): boolean {
    if (!data) return false;
    return Boolean(
      data.inCombat === true ||
      (typeof data.combatTarget === "string" && data.combatTarget.length) ||
      (typeof data.ct === "string" && data.ct.length) ||
      (typeof data.attackTarget === "string" && data.attackTarget.length),
    );
  }

  getAgentActivityScore(agentId: string): number {
    const sample = this.agentActivity.get(agentId);
    if (!sample) {
      return 0;
    }

    return (
      sample.motionScore * 0.3 +
      sample.combatScore * 1.05 +
      sample.eventScore * 1.2
    );
  }

  refreshAgentActivity(now: number): void {
    const availableAgents = this.getAvailableAgents();
    for (const agentId of availableAgents) {
      const entity = this.world.entities.get(agentId);
      if (!entity) {
        continue;
      }

      const sample = this.ensureAgentActivity(agentId, now);
      this.decayAgentActivity(sample, now);

      const currentPosition =
        this.normalizePosition(
          (
            entity as {
              data?: { position?: unknown };
            }
          ).data?.position,
        ) ??
        this.normalizePosition((entity as { position?: unknown }).position);

      if (currentPosition && sample.lastPosition) {
        const movedDistance = Math.hypot(
          currentPosition[0] - sample.lastPosition[0],
          currentPosition[2] - sample.lastPosition[2],
        );
        if (movedDistance > 0.05) {
          sample.motionScore = clampNumber(
            sample.motionScore + movedDistance * 2.25,
            0,
            12,
          );
          sample.lastInterestingTime = now;
        }
      }
      sample.lastPosition = currentPosition;

      const entityData = (entity as { data?: AgentCombatData }).data;
      if (this.isAgentInCombat(entityData)) {
        sample.combatScore = clampNumber(sample.combatScore + 0.9, 0, 12);
        sample.lastInterestingTime = now;
      }
    }

    // Keep activity map aligned with live agents.
    for (const agentId of this.agentActivity.keys()) {
      if (!availableAgents.has(agentId)) {
        this.agentActivity.delete(agentId);
      }
    }
  }

  // ---- Contestant helpers ----

  getCycleContestantIds(): Set<string> {
    const cycle = this.getCurrentCycle();
    // Fast path: cache is current if it matches the cycle agents
    const a1 = cycle?.agent1?.characterId;
    const a2 = cycle?.agent2?.characterId;
    if (
      this.cachedContestantIds.size > 0 &&
      (!a1 || this.cachedContestantIds.has(a1)) &&
      (!a2 || this.cachedContestantIds.has(a2))
    ) {
      return this.cachedContestantIds;
    }
    // Recompute
    const ids = new Set<string>();
    if (a1) ids.add(a1);
    if (a2) ids.add(a2);
    this.cachedContestantIds = ids;
    return ids;
  }

  getNextDuelAgentIds(contestantIds: Set<string>): Set<string> {
    const collectIds = (
      pair: NextDuelPair | null,
    ): { ids: Set<string>; validPairMembers: number } => {
      const ids = new Set<string>();
      if (!pair) {
        return { ids, validPairMembers: 0 };
      }

      const pairIds = [pair.agent1Id, pair.agent2Id];
      let validPairMembers = 0;
      for (const agentId of pairIds) {
        if (this.isAgentValidCameraCandidate(agentId)) {
          validPairMembers++;
          if (!contestantIds.has(agentId)) {
            ids.add(agentId);
          }
        }
      }

      return { ids, validPairMembers };
    };

    let { ids, validPairMembers } = collectIds(this.getNextDuelPair());
    if (validPairMembers >= MIN_AGENTS) {
      return ids;
    }

    // Keep next-duel previews available even if a preselected member disconnects.
    this.setNextDuelPairFromRefresh(null);
    ({ ids, validPairMembers } = collectIds(this.getNextDuelPair()));
    if (validPairMembers < MIN_AGENTS) {
      this.setNextDuelPairFromRefresh(null);
      return new Set<string>();
    }

    return ids;
  }

  // ---- Fight cutaway tracking ----

  resetFightCutawayTracking(): void {
    this.fightCutawayStartedAt = null;
    this.fightCutawayTotalMs = 0;
    this.fightLastCutawayEndedAt = 0;
  }

  finishFightCutawayTracking(now: number): void {
    if (this.fightCutawayStartedAt === null) {
      return;
    }
    this.fightCutawayTotalMs += Math.max(0, now - this.fightCutawayStartedAt);
    this.fightCutawayStartedAt = null;
    this.fightLastCutawayEndedAt = now;
  }

  syncFightCutawayTracking(now: number, currentTarget: string | null): void {
    const cycle = this.getCurrentCycle();
    if (!cycle || cycle.phase !== "FIGHTING") {
      this.finishFightCutawayTracking(now);
      return;
    }

    const contestantIds = this.getCycleContestantIds();
    const trackingNonContestantTarget =
      currentTarget !== null && !contestantIds.has(currentTarget);

    if (!trackingNonContestantTarget) {
      this.finishFightCutawayTracking(now);
      return;
    }

    if (this.fightCutawayStartedAt === null) {
      this.fightCutawayStartedAt = now;
    }
  }

  isFightCutawayAllowed(now: number): boolean {
    const cycle = this.getCurrentCycle();
    if (!cycle || cycle.phase !== "FIGHTING") {
      return true;
    }

    const elapsedFightMs = now - cycle.phaseStartTime;
    if (
      elapsedFightMs < CAMERA_DIRECTOR.fightingCutaway.initialContestantLockMs
    ) {
      return false;
    }

    if (
      this.fightCutawayTotalMs >=
      CAMERA_DIRECTOR.fightingCutaway.maxTotalCutawayMs
    ) {
      return false;
    }

    if (this.fightCutawayStartedAt !== null) {
      return true;
    }

    if (
      this.fightLastCutawayEndedAt > 0 &&
      now - this.fightLastCutawayEndedAt <
        CAMERA_DIRECTOR.fightingCutaway.cutawayCooldownMs
    ) {
      return false;
    }

    const contestantIds = this.getCycleContestantIds();
    if (contestantIds.size === 0) {
      return false;
    }

    for (const contestantId of contestantIds) {
      const sample = this.ensureAgentActivity(contestantId, now);
      this.decayAgentActivity(sample, now);
      const entity = this.world.entities.get(contestantId);
      const data = (entity as { data?: AgentCombatData } | undefined)?.data;

      if (this.isAgentInCombat(data)) {
        return false;
      }

      const idleMs = now - sample.lastInterestingTime;
      if (idleMs < CAMERA_DIRECTOR.fightingCutaway.contestantIdleThresholdMs) {
        return false;
      }
    }

    return true;
  }

  isFightCutawayExpired(now: number): boolean {
    if (this.fightCutawayStartedAt === null) {
      return false;
    }
    return (
      now - this.fightCutawayStartedAt >=
      CAMERA_DIRECTOR.fightingCutaway.maxSingleCutawayMs
    );
  }

  // ---- Candidate selection ----

  selectBestContestantCandidate(
    candidates: CameraCandidateWeight[],
    preferredAgentId: string | null,
  ): CameraCandidateWeight | null {
    const contestantCandidates = candidates.filter(
      (candidate) => candidate.isContestant,
    );
    if (contestantCandidates.length === 0) {
      return null;
    }

    if (preferredAgentId) {
      const preferred = contestantCandidates.find(
        (candidate) => candidate.agentId === preferredAgentId,
      );
      if (preferred) {
        return preferred;
      }
    }

    let best = contestantCandidates[0];
    for (let i = 1; i < contestantCandidates.length; i++) {
      if (contestantCandidates[i].weight > best.weight) {
        best = contestantCandidates[i];
      }
    }
    return best;
  }

  setCameraTarget(agentId: string | null, now: number): void {
    if (!agentId || !this.isAgentValidCameraCandidate(agentId)) {
      return;
    }

    const previous = this._cameraTarget;
    if (previous !== agentId) {
      this._cameraTarget = agentId;
      this.lastCameraSwitchTime = now;
    }
    this.markAgentFocused(agentId, now);
    this.syncFightCutawayTracking(now, this._cameraTarget);
  }

  resolveCycleCameraTarget(): string | null {
    const cycle = this.getCurrentCycle();
    const phase = cycle?.phase ?? "IDLE";
    const contestantIds = this.getCycleContestantIds();
    const nextDuelIds = this.getNextDuelAgentIds(contestantIds);
    const currentTarget = this._cameraTarget;
    if (
      typeof currentTarget === "string" &&
      this.isAgentValidCameraCandidate(currentTarget)
    ) {
      const currentIsContestant = contestantIds.has(currentTarget);
      const currentIsNextDuel = nextDuelIds.has(currentTarget);

      if (phase === "ANNOUNCEMENT" || phase === "COUNTDOWN") {
        if (currentIsContestant) {
          return currentTarget;
        }
      } else if (phase === "FIGHTING") {
        if (currentIsContestant || currentIsNextDuel) {
          return currentTarget;
        }
      } else {
        return currentTarget;
      }
    }

    const preferredIds: string[] = [];

    if (phase === "RESOLUTION" && cycle?.winnerId) {
      preferredIds.push(cycle.winnerId);
    }

    preferredIds.push(...contestantIds, ...nextDuelIds);

    const seen = new Set<string>();
    for (const agentId of preferredIds) {
      if (seen.has(agentId)) {
        continue;
      }
      seen.add(agentId);
      if (this.isAgentValidCameraCandidate(agentId)) {
        return agentId;
      }
    }

    const availableAgents = this.getAvailableAgents();
    for (const agentId of availableAgents) {
      if (this.isAgentValidCameraCandidate(agentId)) {
        return agentId;
      }
    }

    return null;
  }

  isAgentValidCameraCandidate(agentId: string | null | undefined): boolean {
    if (!agentId || !this.getAvailableAgents().has(agentId)) {
      return false;
    }
    return Boolean(this.world.entities.get(agentId));
  }

  getCameraSwitchTimingForPhase(phase: StreamingPhase): CameraSwitchTiming {
    return (
      CAMERA_DIRECTOR.switchTiming[phase] ?? CAMERA_DIRECTOR.switchTiming.IDLE
    );
  }

  buildCameraCandidates(
    now: number,
    currentTarget: string | null,
    allowFightCutaway: boolean,
  ): CameraCandidateWeight[] {
    const candidates: CameraCandidateWeight[] = [];
    const cycle = this.getCurrentCycle();
    const phase = cycle?.phase ?? "IDLE";
    const contestantIds = this.getCycleContestantIds();
    const nextDuelIds = this.getNextDuelAgentIds(contestantIds);
    const phaseWeight = CAMERA_DIRECTOR.baseWeights[phase];
    const contestantsOnlyPhase =
      phase === "ANNOUNCEMENT" || phase === "COUNTDOWN";

    const availableAgents = this.getAvailableAgents();
    for (const agentId of availableAgents) {
      const entity = this.world.entities.get(agentId);
      if (!entity) {
        continue;
      }

      const sample = this.ensureAgentActivity(agentId, now);
      this.decayAgentActivity(sample, now);
      const activityScore = this.getAgentActivityScore(agentId);
      const entityData = (entity as { data?: AgentCombatData }).data;
      const isInCombat = this.isAgentInCombat(entityData);
      const isContestant = contestantIds.has(agentId);
      const isNextDuelAgent = nextDuelIds.has(agentId);

      if (contestantsOnlyPhase && !isContestant) {
        continue;
      }

      if (phase === "FIGHTING" && !isContestant && !isNextDuelAgent) {
        continue;
      }

      let weight = isContestant
        ? phaseWeight.contestant
        : phaseWeight.nonContestant;
      if (
        phase === "RESOLUTION" &&
        agentId === cycle?.winnerId &&
        typeof phaseWeight.winner === "number"
      ) {
        weight = phaseWeight.winner;
      }

      if (isInCombat) {
        weight *= CAMERA_DIRECTOR.multipliers.inCombat;
      }

      if (!isContestant && isNextDuelAgent) {
        weight *= CAMERA_DIRECTOR.nextDuelWeightBoost[phase];
      }

      if (phase === "FIGHTING" && !isContestant) {
        weight *= allowFightCutaway
          ? CAMERA_DIRECTOR.fightingCutaway.nonContestantAllowedMultiplier
          : CAMERA_DIRECTOR.fightingCutaway.nonContestantSuppressionMultiplier;
      }

      weight *=
        1 +
        clampNumber(
          activityScore,
          0,
          CAMERA_DIRECTOR.activity.maxActivityScore,
        ) *
          CAMERA_DIRECTOR.activity.weightPerPoint;

      const idleDurationMs = now - sample.lastInterestingTime;
      if (
        !isInCombat &&
        idleDurationMs > CAMERA_DIRECTOR.idlePenalty.hardThresholdMs
      ) {
        weight *= isContestant
          ? CAMERA_DIRECTOR.idlePenalty.hardContestantMultiplier
          : CAMERA_DIRECTOR.idlePenalty.hardNonContestantMultiplier;
      } else if (
        !isInCombat &&
        idleDurationMs > CAMERA_DIRECTOR.idlePenalty.softThresholdMs
      ) {
        weight *= CAMERA_DIRECTOR.idlePenalty.softMultiplier;
      }

      if (sample.lastFocusedTime > 0 && agentId !== currentTarget) {
        const msSinceFocused = now - sample.lastFocusedTime;
        if (msSinceFocused < 25_000) {
          weight *= CAMERA_DIRECTOR.multipliers.recentFocusPenaltyShort;
        } else if (msSinceFocused < 60_000) {
          weight *= CAMERA_DIRECTOR.multipliers.recentFocusPenaltyLong;
        }
      }

      if (agentId === currentTarget) {
        weight *= CAMERA_DIRECTOR.multipliers.currentTargetBias;
      }

      candidates.push({
        agentId,
        weight: Math.max(0.01, weight),
        activityScore,
        isInCombat,
        isContestant,
      });
    }

    return candidates;
  }

  chooseWeightedCameraCandidate(
    candidates: CameraCandidateWeight[],
  ): CameraCandidateWeight | null {
    if (candidates.length === 0) {
      return null;
    }

    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
      return candidates[0];
    }

    let cursor = Math.random() * totalWeight;
    for (const item of candidates) {
      cursor -= item.weight;
      if (cursor <= 0) {
        return item;
      }
    }

    return candidates[candidates.length - 1];
  }

  selectHighestWeightCameraCandidate(
    candidates: CameraCandidateWeight[],
  ): CameraCandidateWeight | null {
    let selected: CameraCandidateWeight | null = null;
    for (const candidate of candidates) {
      if (!selected || candidate.weight > selected.weight) {
        selected = candidate;
      }
    }
    return selected;
  }

  markAgentFocused(agentId: string | null, now: number): void {
    if (!agentId) return;
    const sample = this.ensureAgentActivity(agentId, now);
    sample.lastFocusedTime = now;
  }

  // ---- Activity-type classification ----

  classifyAgentActivity(agentId: string): AgentActivityType {
    const entity = this.world.entities.get(agentId);
    if (!entity) return "idle";

    const data = (entity as { data?: AgentCombatData }).data;

    // Combat is highest-priority signal
    if (this.isAgentInCombat(data)) return "combat";

    // Check emote for skilling animations
    const emote = data?.e;
    if (emote && CAMERA_DIRECTOR.skillingEmotes.has(emote)) return "skilling";

    // Fall back to motion score for movement detection
    const sample = this.agentActivity.get(agentId);
    if (sample && sample.motionScore > 0.5) return "moving";

    return "idle";
  }

  // ---- Idle-phase weighted candidate builder ----

  buildIdleCameraCandidates(
    now: number,
    currentTarget: string | null,
    onDeckIds: Set<string>,
  ): CameraCandidateWeight[] {
    const candidates: CameraCandidateWeight[] = [];
    const availableAgents = this.getAvailableAgents();
    const cfg = CAMERA_DIRECTOR.idle;

    for (const agentId of availableAgents) {
      const entity = this.world.entities.get(agentId);
      if (!entity) continue;

      const sample = this.ensureAgentActivity(agentId, now);
      this.decayAgentActivity(sample, now);
      const activityScore = this.getAgentActivityScore(agentId);
      const entityData = (entity as { data?: AgentCombatData }).data;
      const isInCombat = this.isAgentInCombat(entityData);
      const isOnDeck = onDeckIds.has(agentId);
      const activityType = this.classifyAgentActivity(agentId);

      let weight = 1.0;

      // On-deck boost (narrative: "these two fight next")
      if (isOnDeck) {
        weight *= cfg.onDeckBoost;
      }

      // Activity-type multiplier (combat >> skilling >> moving >> idle)
      weight *= cfg.activityTypeMultiplier[activityType];

      // Activity score bonus (continuous refinement within type)
      weight *=
        1 +
        clampNumber(
          activityScore,
          0,
          CAMERA_DIRECTOR.activity.maxActivityScore,
        ) *
          CAMERA_DIRECTOR.activity.weightPerPoint;

      // Mild current-target stickiness
      if (agentId === currentTarget) {
        weight *= cfg.currentTargetBias;
      }

      // Recency penalty — avoid rapid re-focus on recently-watched agents
      if (sample.lastFocusedTime > 0 && agentId !== currentTarget) {
        const msSinceFocused = now - sample.lastFocusedTime;
        if (msSinceFocused < 25_000) {
          weight *= CAMERA_DIRECTOR.multipliers.recentFocusPenaltyShort;
        } else if (msSinceFocused < 60_000) {
          weight *= CAMERA_DIRECTOR.multipliers.recentFocusPenaltyLong;
        }
      }

      candidates.push({
        agentId,
        weight: Math.max(0.01, weight),
        activityScore,
        isInCombat,
        isContestant: false,
      });
    }

    return candidates;
  }

  updateCameraTarget(now: number): void {
    const cycle = this.getCurrentCycle();
    if (!cycle) return;

    if (cycle.phase === "RESOLUTION") {
      const winnerId = cycle.winnerId;
      if (this.isAgentValidCameraCandidate(winnerId)) {
        this.setCameraTarget(winnerId ?? null, now);
      }
      return;
    }

    const currentTarget = this.isAgentValidCameraCandidate(this._cameraTarget)
      ? this._cameraTarget
      : null;
    this.syncFightCutawayTracking(now, currentTarget);
    const allowFightCutaway = this.isFightCutawayAllowed(now);

    const candidates = this.buildCameraCandidates(
      now,
      currentTarget,
      allowFightCutaway,
    );
    if (candidates.length === 0) {
      const fallback = this.resolveCycleCameraTarget();
      if (fallback) {
        this.setCameraTarget(fallback, now);
      }
      return;
    }

    if (cycle.phase === "FIGHTING" && currentTarget) {
      const contestantIds = this.getCycleContestantIds();
      if (
        !contestantIds.has(currentTarget) &&
        (!allowFightCutaway || this.isFightCutawayExpired(now))
      ) {
        const fallbackContestant = this.selectBestContestantCandidate(
          candidates,
          null,
        );
        if (fallbackContestant) {
          this.setCameraTarget(fallbackContestant.agentId, now);
        } else {
          const fallback = this.resolveCycleCameraTarget();
          if (fallback) {
            this.setCameraTarget(fallback, now);
          }
        }
        return;
      }
    }

    if (!currentTarget) {
      let firstSelection = this.chooseWeightedCameraCandidate(candidates);
      if (
        firstSelection &&
        cycle.phase === "FIGHTING" &&
        !allowFightCutaway &&
        !firstSelection.isContestant
      ) {
        const contestantSelection = this.selectBestContestantCandidate(
          candidates,
          null,
        );
        if (contestantSelection) {
          firstSelection = contestantSelection;
        }
      }
      if (firstSelection) {
        this.setCameraTarget(firstSelection.agentId, now);
      } else {
        const fallback = this.resolveCycleCameraTarget();
        if (fallback) {
          this.setCameraTarget(fallback, now);
        }
      }
      return;
    }

    const timing = this.getCameraSwitchTimingForPhase(cycle.phase);
    const msSinceSwitch = now - this.lastCameraSwitchTime;
    const canSwitch = msSinceSwitch >= timing.minHoldMs;
    const forceSwitch = msSinceSwitch >= timing.maxHoldMs;
    if (!canSwitch && !forceSwitch) {
      return;
    }

    const byAgentId = new Map(candidates.map((item) => [item.agentId, item]));
    const currentCandidate = byAgentId.get(currentTarget);
    if (!currentCandidate) {
      const fallback = this.chooseWeightedCameraCandidate(candidates);
      if (fallback) {
        this.setCameraTarget(fallback.agentId, now);
      }
      return;
    }

    let selected = this.chooseWeightedCameraCandidate(candidates);
    if (!selected) {
      return;
    }

    if (
      cycle.phase === "FIGHTING" &&
      !allowFightCutaway &&
      !selected.isContestant
    ) {
      const contestantSelection = this.selectBestContestantCandidate(
        candidates,
        currentTarget,
      );
      if (contestantSelection) {
        selected = contestantSelection;
      }
    }

    if (
      forceSwitch &&
      selected.agentId === currentTarget &&
      candidates.length > 1
    ) {
      const alternatives = candidates.filter(
        (candidate) =>
          candidate.agentId !== currentTarget &&
          (cycle.phase !== "FIGHTING" ||
            allowFightCutaway ||
            candidate.isContestant),
      );
      const alternateSelection =
        this.chooseWeightedCameraCandidate(alternatives);
      if (alternateSelection) {
        selected = alternateSelection;
      }
    }

    const currentSample = this.ensureAgentActivity(currentTarget, now);
    const currentIdleDurationMs = now - currentSample.lastInterestingTime;
    const currentIsIdle =
      currentIdleDurationMs >= timing.idleThresholdMs &&
      !currentCandidate.isInCombat;

    const selectedIsStronger =
      selected.weight >
      currentCandidate.weight *
        (currentIsIdle
          ? CAMERA_DIRECTOR.multipliers.strongerThresholdIdle
          : CAMERA_DIRECTOR.multipliers.strongerThresholdActive);

    const shouldSwitch =
      forceSwitch ||
      (selected.agentId !== currentTarget &&
        (selectedIsStronger ||
          (currentIsIdle &&
            selected.activityScore >= currentCandidate.activityScore) ||
          Math.random() < CAMERA_DIRECTOR.multipliers.switchRandomChance));

    if (shouldSwitch && selected.agentId !== currentTarget) {
      this.setCameraTarget(selected.agentId, now);
    }
  }

  // ---- Idle preview / camera ----

  isValidIdlePair(pair: NextDuelPair | null): pair is NextDuelPair {
    if (!pair || pair.agent1Id === pair.agent2Id) {
      return false;
    }
    return (
      this.isAgentValidCameraCandidate(pair.agent1Id) &&
      this.isAgentValidCameraCandidate(pair.agent2Id)
    );
  }

  resolveIdlePreviewPair(now: number): NextDuelPair | null {
    const availableAgents = this.getAvailableAgents();
    if (availableAgents.size < MIN_AGENTS) {
      this.setNextDuelPairFromRefresh(null);
      return null;
    }

    const currentPair = this.getNextDuelPair();
    if (this.isValidIdlePair(currentPair)) {
      return currentPair;
    }

    this.setNextDuelPairFromRefresh(null);
    const refreshedPair = this.getNextDuelPair();
    if (this.isValidIdlePair(refreshedPair)) {
      return refreshedPair;
    }

    this.setNextDuelPairFromRefresh(null);
    return null;
  }

  getIdlePreviewPairSnapshot(): NextDuelPair | null {
    const pair = this.getNextDuelPair();
    return this.isValidIdlePair(pair) ? pair : null;
  }

  resolveIdleCameraTarget(now: number, preferredIds: string[]): string | null {
    if (
      this._cameraTarget &&
      this.isAgentValidCameraCandidate(this._cameraTarget) &&
      (preferredIds.length === 0 || preferredIds.includes(this._cameraTarget))
    ) {
      return this._cameraTarget;
    }

    for (const preferredId of preferredIds) {
      if (this.isAgentValidCameraCandidate(preferredId)) {
        return preferredId;
      }
    }

    let bestAgentId: string | null = null;
    let bestScore = -Infinity;
    const availableAgents = this.getAvailableAgents();
    for (const agentId of availableAgents) {
      if (!this.isAgentValidCameraCandidate(agentId)) {
        continue;
      }

      const sample = this.ensureAgentActivity(agentId, now);
      this.decayAgentActivity(sample, now);
      const score = this.getAgentActivityScore(agentId);
      if (score > bestScore) {
        bestScore = score;
        bestAgentId = agentId;
      }
    }

    if (bestAgentId) {
      return bestAgentId;
    }

    for (const agentId of availableAgents) {
      if (this.isAgentValidCameraCandidate(agentId)) {
        return agentId;
      }
    }

    return null;
  }

  getIdleCameraTargetSnapshot(preferredIds: string[]): string | null {
    if (
      this._cameraTarget &&
      this.isAgentValidCameraCandidate(this._cameraTarget) &&
      (preferredIds.length === 0 || preferredIds.includes(this._cameraTarget))
    ) {
      return this._cameraTarget;
    }

    for (const preferredId of preferredIds) {
      if (this.isAgentValidCameraCandidate(preferredId)) {
        return preferredId;
      }
    }

    const availableAgents = this.getAvailableAgents();
    for (const agentId of availableAgents) {
      if (this.isAgentValidCameraCandidate(agentId)) {
        return agentId;
      }
    }

    return null;
  }

  considerIdlePreparationActivityCut(agentId: string, now: number): boolean {
    const previewPair = this.getIdlePreviewPairSnapshot();
    if (
      !previewPair ||
      (agentId !== previewPair.agent1Id && agentId !== previewPair.agent2Id) ||
      !this.isAgentValidCameraCandidate(agentId)
    ) {
      return false;
    }

    const currentTarget =
      this._cameraTarget &&
      this.isAgentValidCameraCandidate(this._cameraTarget) &&
      (this._cameraTarget === previewPair.agent1Id ||
        this._cameraTarget === previewPair.agent2Id)
        ? this._cameraTarget
        : null;
    if (currentTarget === agentId) {
      if (this.pendingIdlePreparationActivityTarget === agentId) {
        this.pendingIdlePreparationActivityTarget = null;
      }
      return false;
    }

    if (
      currentTarget &&
      now - this.lastCameraSwitchTime <
        CAMERA_DIRECTOR.idle.holdByActivity.idle.minHoldMs
    ) {
      this.pendingIdlePreparationActivityTarget = agentId;
      return false;
    }

    this.pendingIdlePreparationActivityTarget = null;
    this.setCameraTarget(agentId, now);
    return true;
  }

  clearIdlePreparationActivityCut(): void {
    this.pendingIdlePreparationActivityTarget = null;
  }

  syncIdlePreviewAndCamera(now: number): void {
    const previewPair = this.resolveIdlePreviewPair(now);
    const onDeckIds = new Set<string>();
    if (previewPair) {
      onDeckIds.add(previewPair.agent1Id);
      onDeckIds.add(previewPair.agent2Id);
    }

    let currentTarget = this.isAgentValidCameraCandidate(this._cameraTarget)
      ? this._cameraTarget
      : null;
    const hasExactOnDeckPair = previewPair !== null && onDeckIds.size === 2;

    if (!hasExactOnDeckPair) {
      this.pendingIdlePreparationActivityTarget = null;
    } else if (this.pendingIdlePreparationActivityTarget) {
      const pendingTarget = this.pendingIdlePreparationActivityTarget;
      if (
        !onDeckIds.has(pendingTarget) ||
        !this.isAgentValidCameraCandidate(pendingTarget)
      ) {
        this.pendingIdlePreparationActivityTarget = null;
      } else if (currentTarget === pendingTarget) {
        this.pendingIdlePreparationActivityTarget = null;
      } else if (
        currentTarget &&
        now - this.lastCameraSwitchTime >=
          CAMERA_DIRECTOR.idle.holdByActivity.idle.minHoldMs
      ) {
        this.pendingIdlePreparationActivityTarget = null;
        this.setCameraTarget(pendingTarget, now);
        return;
      }
    }

    // Preparation coverage is pair-bound. Never retain a bystander merely
    // because its generic IDLE hold has not elapsed; that produces an overlay
    // about one matchup over footage of somebody else.
    if (
      hasExactOnDeckPair &&
      (!currentTarget || !onDeckIds.has(currentTarget))
    ) {
      this.setCameraTarget(previewPair.agent1Id, now);
      currentTarget = previewPair.agent1Id;
    }

    // No current target — pick the best candidate immediately
    if (!currentTarget) {
      const candidates = this.buildIdleCameraCandidates(now, null, onDeckIds);
      const selected = this.chooseWeightedCameraCandidate(candidates);
      if (selected) {
        this.setCameraTarget(selected.agentId, now);
      } else {
        // Absolute fallback: any valid agent
        const fallback = this.resolveIdleCameraTarget(now, [...onDeckIds]);
        if (fallback) this.setCameraTarget(fallback, now);
      }
      return;
    }

    // Determine hold timing based on what the current target is doing.
    // Idle agents get switched off fast; agents in combat get long holds.
    const currentActivity = this.classifyAgentActivity(currentTarget);
    const holdTiming = hasExactOnDeckPair
      ? CAMERA_DIRECTOR.idle.holdByActivity.idle
      : CAMERA_DIRECTOR.idle.holdByActivity[currentActivity];
    const msSinceSwitch = now - this.lastCameraSwitchTime;
    const canSwitch = msSinceSwitch >= holdTiming.minHoldMs;
    const forceSwitch = msSinceSwitch >= holdTiming.maxHoldMs;

    if (!canSwitch && !forceSwitch) {
      return;
    }

    // Build weighted candidates and select
    const candidates = this.buildIdleCameraCandidates(
      now,
      currentTarget,
      onDeckIds,
    ).filter(
      (candidate) => !hasExactOnDeckPair || onDeckIds.has(candidate.agentId),
    );
    if (candidates.length <= 1) {
      return;
    }

    let selected = hasExactOnDeckPair
      ? this.selectHighestWeightCameraCandidate(candidates)
      : this.chooseWeightedCameraCandidate(candidates);
    if (!selected) {
      return;
    }

    // On forced switch, guarantee we actually change target
    if (
      forceSwitch &&
      selected.agentId === currentTarget &&
      candidates.length > 1
    ) {
      const alternatives = candidates.filter(
        (candidate) => candidate.agentId !== currentTarget,
      );
      const alt = hasExactOnDeckPair
        ? this.selectHighestWeightCameraCandidate(alternatives)
        : this.chooseWeightedCameraCandidate(alternatives);
      if (alt) selected = alt;
    }

    if (selected.agentId === currentTarget) {
      return;
    }

    // Decide whether to switch based on relative weight
    const byId = new Map(candidates.map((c) => [c.agentId, c]));
    const currentCandidate = byId.get(currentTarget);

    if (forceSwitch || !currentCandidate) {
      this.setCameraTarget(selected.agentId, now);
      return;
    }

    const selectedIsStronger =
      selected.weight >
      currentCandidate.weight * CAMERA_DIRECTOR.idle.strongerThreshold;
    const currentIsIdle = currentActivity === "idle";

    const shouldSwitch =
      selectedIsStronger ||
      (currentIsIdle &&
        selected.activityScore >= currentCandidate.activityScore) ||
      (!hasExactOnDeckPair &&
        Math.random() < CAMERA_DIRECTOR.idle.switchRandomChance);

    if (shouldSwitch) {
      this.setCameraTarget(selected.agentId, now);
    }
  }

  // ---- Activity map management (for external cleanup) ----

  deleteAgentActivity(agentId: string): void {
    this.agentActivity.delete(agentId);
  }

  // ---- Private helpers ----

  private normalizePosition(
    position: unknown,
  ): [number, number, number] | null {
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
}
