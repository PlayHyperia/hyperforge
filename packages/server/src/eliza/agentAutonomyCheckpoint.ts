import { eq, sql } from "drizzle-orm";

import type { Database } from "../database/client.js";
import { agentAutonomyCheckpoints } from "../database/schema.js";
import type {
  AgentGoal,
  AgentInstance,
  EmbeddedBehaviorAction,
} from "./managers/AgentBehaviorTicker.js";

const CHECKPOINT_SCHEMA_VERSION = 3 as const;
const MAX_MEMORIES = 12;
const MAX_PLAN_STEPS = 8;
const MAX_ACTION_LOG_ENTRIES = 8;
const MAX_GOAL_LENGTH = 300;
const MAX_PLAN_STEP_LENGTH = 160;
const MAX_MEMORY_LENGTH = 300;
const MAX_ACTION_LOG_TEXT_LENGTH = 300;

export const AGENT_AUTONOMY_GOAL_TYPES = [
  "questing",
  "combat",
  "gathering",
  "banking",
  "cooking",
  "smelting",
  "smithing",
  "provisioning",
  "exploring",
  "idle",
] as const satisfies readonly AgentGoal["type"][];

const GOAL_TYPES = new Set<AgentGoal["type"]>(AGENT_AUTONOMY_GOAL_TYPES);

export const AGENT_AUTONOMY_ACTION_TYPES = [
  "attack",
  "gather",
  "pickup",
  "lootGravestone",
  "move",
  "questAccept",
  "questComplete",
  "firemake",
  "navigateTo",
  "cook",
  "smelt",
  "smith",
  "runecraft",
  "craft",
  "fletch",
  "tan",
  "storeBuy",
  "use",
  "bury",
  "equip",
  "setAutocast",
  "bankDepositAll",
  "bankWithdraw",
  "homeTeleport",
  "stop",
  "idle",
] as const satisfies readonly EmbeddedBehaviorAction["type"][];

const ACTION_TYPES = new Set<EmbeddedBehaviorAction["type"]>(
  AGENT_AUTONOMY_ACTION_TYPES,
);

const GOAL_OPTIONAL_STRING_FIELDS = [
  "questId",
  "questName",
  "questStageType",
  "questStageTarget",
  "questStartNpc",
] as const;

type AutonomyPlan = NonNullable<AgentInstance["llmPlan"]>;
type RecentActionLog = NonNullable<AgentInstance["recentActionLog"]>;

export const AGENT_ACTION_OUTCOMES = [
  "completed",
  "dispatched",
  "rejected",
  "failed",
  "idle",
  "unknown_after_restart",
  "legacy_unknown",
] as const;

export type AgentActionOutcome = (typeof AGENT_ACTION_OUTCOMES)[number];
export type RuntimeAgentActionOutcome = Exclude<
  AgentActionOutcome,
  "legacy_unknown"
>;

export interface AgentAutonomyActionResult {
  /** The worker/LLM action whose execution was evaluated. */
  attemptedActionType: EmbeddedBehaviorAction["type"];
  /** The action that actually entered or completed an authoritative path. */
  appliedActionType: EmbeddedBehaviorAction["type"] | null;
  outcome: RuntimeAgentActionOutcome;
}

export interface AgentAutonomyCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  characterId: string;
  revision: number;
  goal: AgentGoal | null;
  plan: AutonomyPlan | null;
  memories: string[];
  recentActionLog: RecentActionLog;
  tickCounter: number;
  lastAppliedActionType: EmbeddedBehaviorAction["type"] | null;
  lastAppliedAt: number | null;
  lastAttemptedActionType: EmbeddedBehaviorAction["type"] | null;
  lastActionOutcome: AgentActionOutcome | null;
  lastAttemptedAt: number | null;
  /** Always true on disk: recovery is context, never an executable command. */
  requiresReassessment: true;
  updatedAt: number;
}

export interface AgentAutonomyCheckpointDraft {
  characterId: string;
  goal: AgentGoal | null;
  plan: AutonomyPlan | null;
  memories: string[];
  recentActionLog: RecentActionLog;
  tickCounter: number;
  lastAttemptedActionType: EmbeddedBehaviorAction["type"];
  lastActionOutcome: RuntimeAgentActionOutcome;
  lastAppliedActionType: EmbeddedBehaviorAction["type"] | null;
  lastAttemptedAt: number;
}

export interface AgentAutonomyCheckpointContext {
  goal: AgentGoal | null;
  plan: AutonomyPlan | null;
  memories: string[];
  recentActionLog: RecentActionLog;
  tickCounter: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maxLength: number,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`agent_autonomy_checkpoint_${field}_invalid`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`agent_autonomy_checkpoint_${field}_invalid`);
  }
  return normalized;
}

function nonnegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`agent_autonomy_checkpoint_${field}_invalid`);
  }
  return Number(value);
}

function normalizeGoal(value: unknown): AgentGoal | null {
  if (value == null) return null;
  if (!isRecord(value) || !GOAL_TYPES.has(value.type as AgentGoal["type"])) {
    throw new Error("agent_autonomy_checkpoint_goal_invalid");
  }
  const allowedKeys = new Set([
    "type",
    "description",
    "bankPurpose",
    ...GOAL_OPTIONAL_STRING_FIELDS,
    "questStageCount",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("agent_autonomy_checkpoint_goal_invalid");
  }
  const normalized: AgentGoal = {
    type: value.type as AgentGoal["type"],
    description: boundedString(
      value.description,
      MAX_GOAL_LENGTH,
      "goal_description",
    ),
  };
  if (value.bankPurpose !== undefined) {
    if (
      value.type !== "banking" ||
      (value.bankPurpose !== "survival_food" &&
        value.bankPurpose !== "combat_supply")
    ) {
      throw new Error("agent_autonomy_checkpoint_goal_invalid");
    }
    normalized.bankPurpose = value.bankPurpose;
  }
  for (const field of GOAL_OPTIONAL_STRING_FIELDS) {
    if (value[field] !== undefined) {
      normalized[field] = boundedString(value[field], 160, `goal_${field}`);
    }
  }
  if (value.questStageCount !== undefined) {
    normalized.questStageCount = nonnegativeSafeInteger(
      value.questStageCount,
      "goal_quest_stage_count",
    );
  }
  return normalized;
}

function normalizePlan(value: unknown): AutonomyPlan | null {
  if (value == null) return null;
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["steps", "currentStep", "createdAt", "goal"].includes(key),
    ) ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    value.steps.length > MAX_PLAN_STEPS
  ) {
    throw new Error("agent_autonomy_checkpoint_plan_invalid");
  }
  const steps = value.steps.map((step) =>
    boundedString(step, MAX_PLAN_STEP_LENGTH, "plan_step"),
  );
  const currentStep = nonnegativeSafeInteger(
    value.currentStep,
    "plan_current_step",
  );
  if (currentStep >= steps.length) {
    throw new Error("agent_autonomy_checkpoint_plan_current_step_invalid");
  }
  return {
    steps,
    currentStep,
    createdAt: nonnegativeSafeInteger(value.createdAt, "plan_created_at"),
    goal:
      typeof value.goal === "string" && value.goal.trim() === ""
        ? ""
        : boundedString(value.goal, MAX_GOAL_LENGTH, "plan_goal"),
  };
}

function normalizeMemories(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_MEMORIES) {
    throw new Error("agent_autonomy_checkpoint_memories_invalid");
  }
  return value.map((memory) =>
    boundedString(memory, MAX_MEMORY_LENGTH, "memory"),
  );
}

function normalizeRecentActionLog(value: unknown): RecentActionLog {
  if (!Array.isArray(value) || value.length > MAX_ACTION_LOG_ENTRIES) {
    throw new Error("agent_autonomy_checkpoint_action_log_invalid");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) => !["tick", "action", "result"].includes(key),
      )
    ) {
      throw new Error("agent_autonomy_checkpoint_action_log_invalid");
    }
    return {
      tick: nonnegativeSafeInteger(entry.tick, "action_log_tick"),
      action: boundedString(
        entry.action,
        MAX_ACTION_LOG_TEXT_LENGTH,
        "action_log_action",
      ),
      result: boundedString(
        entry.result,
        MAX_ACTION_LOG_TEXT_LENGTH,
        "action_log_result",
      ),
    };
  });
}

function normalizeActionType(
  value: unknown,
): EmbeddedBehaviorAction["type"] | null {
  if (value == null) return null;
  if (!ACTION_TYPES.has(value as EmbeddedBehaviorAction["type"])) {
    throw new Error("agent_autonomy_checkpoint_action_type_invalid");
  }
  return value as EmbeddedBehaviorAction["type"];
}

function normalizeActionOutcome(value: unknown): AgentActionOutcome | null {
  if (value == null) return null;
  if (!AGENT_ACTION_OUTCOMES.includes(value as AgentActionOutcome)) {
    throw new Error("agent_autonomy_checkpoint_action_outcome_invalid");
  }
  return value as AgentActionOutcome;
}

export function normalizeAgentAutonomyCheckpoint(
  value: unknown,
): AgentAutonomyCheckpoint {
  if (!isRecord(value)) {
    throw new Error("agent_autonomy_checkpoint_invalid");
  }
  if (
    value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
    value.requiresReassessment !== true
  ) {
    throw new Error("agent_autonomy_checkpoint_version_invalid");
  }
  const characterId = boundedString(value.characterId, 128, "character_id");
  const revision = nonnegativeSafeInteger(value.revision, "revision");
  if (revision < 1) {
    throw new Error("agent_autonomy_checkpoint_revision_invalid");
  }
  const updatedAt = nonnegativeSafeInteger(value.updatedAt, "updated_at");
  const lastAppliedAt =
    value.lastAppliedAt == null
      ? null
      : nonnegativeSafeInteger(value.lastAppliedAt, "last_applied_at");
  const lastAttemptedAt =
    value.lastAttemptedAt == null
      ? null
      : nonnegativeSafeInteger(value.lastAttemptedAt, "last_attempted_at");
  const lastAppliedActionType = normalizeActionType(
    value.lastAppliedActionType,
  );
  const lastAttemptedActionType = normalizeActionType(
    value.lastAttemptedActionType,
  );
  const lastActionOutcome = normalizeActionOutcome(value.lastActionOutcome);
  const attemptBundlePresent =
    lastAttemptedActionType !== null ||
    lastActionOutcome !== null ||
    lastAttemptedAt !== null;
  if (
    (lastAppliedActionType === null) !== (lastAppliedAt === null) ||
    (attemptBundlePresent &&
      (lastAttemptedActionType === null ||
        lastActionOutcome === null ||
        lastAttemptedAt === null)) ||
    (!attemptBundlePresent && lastAppliedActionType !== null) ||
    (lastAppliedAt !== null && lastAppliedAt > updatedAt) ||
    (lastAttemptedAt !== null && lastAttemptedAt > updatedAt) ||
    (lastAppliedAt !== null &&
      lastAttemptedAt !== null &&
      lastAppliedAt > lastAttemptedAt) ||
    ((lastActionOutcome === "completed" ||
      lastActionOutcome === "dispatched") &&
      (lastAppliedActionType === null || lastAppliedAt !== lastAttemptedAt)) ||
    (lastActionOutcome === "legacy_unknown" &&
      (lastAppliedActionType !== lastAttemptedActionType ||
        lastAppliedAt !== lastAttemptedAt)) ||
    (lastActionOutcome === "idle" && lastAttemptedActionType !== "idle") ||
    (lastActionOutcome !== null &&
      lastActionOutcome !== "idle" &&
      lastActionOutcome !== "legacy_unknown" &&
      lastAttemptedActionType === "idle")
  ) {
    throw new Error("agent_autonomy_checkpoint_timestamps_invalid");
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    characterId,
    revision,
    goal: normalizeGoal(value.goal),
    plan: normalizePlan(value.plan),
    memories: normalizeMemories(value.memories),
    recentActionLog: normalizeRecentActionLog(value.recentActionLog),
    tickCounter: nonnegativeSafeInteger(value.tickCounter, "tick_counter"),
    lastAppliedActionType,
    lastAppliedAt,
    lastAttemptedActionType,
    lastActionOutcome,
    lastAttemptedAt,
    requiresReassessment: true,
    updatedAt,
  };
}

export function buildAgentAutonomyCheckpointDraft(
  instance: AgentInstance,
  actionResult: AgentAutonomyActionResult,
  now = Date.now(),
): AgentAutonomyCheckpointDraft {
  return buildAgentAutonomyCheckpointDraftFromContext(
    instance.config.characterId,
    captureAgentAutonomyCheckpointContext(instance),
    actionResult,
    now,
  );
}

export function captureAgentAutonomyCheckpointContext(
  instance: AgentInstance,
): AgentAutonomyCheckpointContext {
  return {
    goal: instance.goal ? { ...instance.goal } : null,
    plan: instance.llmPlan
      ? {
          ...instance.llmPlan,
          steps: [...instance.llmPlan.steps],
        }
      : null,
    memories: [...(instance.memories ?? [])],
    recentActionLog: (instance.recentActionLog ?? []).map((entry) => ({
      ...entry,
    })),
    tickCounter: instance.tickCounter ?? 0,
  };
}

export function buildAgentAutonomyCheckpointDraftFromContext(
  characterId: string,
  context: AgentAutonomyCheckpointContext,
  actionResult: AgentAutonomyActionResult,
  now = Date.now(),
): AgentAutonomyCheckpointDraft {
  return normalizeCheckpointDraft({
    characterId,
    goal: context.goal,
    plan: context.plan,
    memories: context.memories,
    recentActionLog: context.recentActionLog,
    tickCounter: context.tickCounter,
    lastAttemptedActionType: actionResult.attemptedActionType,
    lastActionOutcome: actionResult.outcome,
    lastAppliedActionType: actionResult.appliedActionType,
    lastAttemptedAt: now,
  });
}

function normalizeCheckpointDraft(
  draft: AgentAutonomyCheckpointDraft,
): AgentAutonomyCheckpointDraft {
  const lastAttemptedActionType =
    normalizeActionType(draft.lastAttemptedActionType) ?? "idle";
  const lastActionOutcome = normalizeRuntimeActionOutcome(
    draft.lastActionOutcome,
  );
  const lastAppliedActionType = normalizeActionType(
    draft.lastAppliedActionType,
  );
  const appliedOutcome =
    lastActionOutcome === "completed" || lastActionOutcome === "dispatched";
  if (
    appliedOutcome !== (lastAppliedActionType !== null) ||
    (lastActionOutcome === "idle") !== (lastAttemptedActionType === "idle")
  ) {
    throw new Error("agent_autonomy_checkpoint_action_truth_invalid");
  }
  return {
    characterId: boundedString(draft.characterId, 128, "character_id"),
    goal: normalizeGoal(draft.goal),
    plan: normalizePlan(draft.plan),
    memories: normalizeMemories(draft.memories),
    recentActionLog: normalizeRecentActionLog(draft.recentActionLog),
    tickCounter: nonnegativeSafeInteger(draft.tickCounter, "tick_counter"),
    lastAttemptedActionType,
    lastActionOutcome,
    lastAppliedActionType,
    lastAttemptedAt: nonnegativeSafeInteger(
      draft.lastAttemptedAt,
      "last_attempted_at",
    ),
  };
}

function normalizeRuntimeActionOutcome(
  value: unknown,
): RuntimeAgentActionOutcome {
  const outcome = normalizeActionOutcome(value);
  if (outcome === null || outcome === "legacy_unknown") {
    throw new Error("agent_autonomy_checkpoint_action_outcome_invalid");
  }
  return outcome;
}

function normalizeCheckpointRow(row: {
  schemaVersion: number;
  characterId: string;
  revision: number;
  goal: unknown;
  plan: unknown;
  memories: unknown;
  recentActionLog: unknown;
  tickCounter: number;
  lastAppliedActionType: string | null;
  lastAppliedAt: number | null;
  lastAttemptedActionType: string | null;
  lastActionOutcome: string | null;
  lastAttemptedAt: number | null;
  requiresReassessment: boolean;
  updatedAt: number;
}): AgentAutonomyCheckpoint {
  return normalizeAgentAutonomyCheckpoint(row);
}

export async function loadAgentAutonomyCheckpoint(
  db: Database,
  characterId: string,
): Promise<AgentAutonomyCheckpoint | null> {
  const rows = await db
    .select()
    .from(agentAutonomyCheckpoints)
    .where(eq(agentAutonomyCheckpoints.characterId, characterId))
    .limit(1);
  return rows[0] ? normalizeCheckpointRow(rows[0]) : null;
}

export async function saveAgentAutonomyCheckpoint(
  db: Database,
  draft: AgentAutonomyCheckpointDraft,
): Promise<AgentAutonomyCheckpoint> {
  const normalizedDraft = normalizeCheckpointDraft(draft);
  const monotonicAttemptedAt = sql<number>`GREATEST(
    ${agentAutonomyCheckpoints.updatedAt},
    ${normalizedDraft.lastAttemptedAt}
  )`;
  const rows = await db
    .insert(agentAutonomyCheckpoints)
    .values({
      characterId: normalizedDraft.characterId,
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      revision: 1,
      goal: normalizedDraft.goal,
      plan: normalizedDraft.plan,
      memories: normalizedDraft.memories,
      recentActionLog: normalizedDraft.recentActionLog,
      tickCounter: normalizedDraft.tickCounter,
      lastAppliedActionType: normalizedDraft.lastAppliedActionType,
      lastAppliedAt:
        normalizedDraft.lastAppliedActionType === null
          ? null
          : normalizedDraft.lastAttemptedAt,
      lastAttemptedActionType: normalizedDraft.lastAttemptedActionType,
      lastActionOutcome: normalizedDraft.lastActionOutcome,
      lastAttemptedAt: normalizedDraft.lastAttemptedAt,
      requiresReassessment: true,
      updatedAt: normalizedDraft.lastAttemptedAt,
    })
    .onConflictDoUpdate({
      target: agentAutonomyCheckpoints.characterId,
      set: {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        revision: sql`${agentAutonomyCheckpoints.revision} + 1`,
        goal: normalizedDraft.goal,
        plan: normalizedDraft.plan,
        memories: normalizedDraft.memories,
        recentActionLog: normalizedDraft.recentActionLog,
        tickCounter: normalizedDraft.tickCounter,
        lastAppliedActionType:
          normalizedDraft.lastAppliedActionType === null
            ? agentAutonomyCheckpoints.lastAppliedActionType
            : normalizedDraft.lastAppliedActionType,
        lastAppliedAt:
          normalizedDraft.lastAppliedActionType === null
            ? agentAutonomyCheckpoints.lastAppliedAt
            : monotonicAttemptedAt,
        lastAttemptedActionType: normalizedDraft.lastAttemptedActionType,
        lastActionOutcome: normalizedDraft.lastActionOutcome,
        lastAttemptedAt: monotonicAttemptedAt,
        requiresReassessment: true,
        updatedAt: monotonicAttemptedAt,
      },
    })
    .returning();
  if (!rows[0]) {
    throw new Error("agent_autonomy_checkpoint_write_not_confirmed");
  }
  return normalizeCheckpointRow(rows[0]);
}

export function hydrateAgentFromAutonomyCheckpoint(
  instance: AgentInstance,
  checkpoint: AgentAutonomyCheckpoint,
): void {
  if (checkpoint.characterId !== instance.config.characterId) {
    throw new Error("agent_autonomy_checkpoint_character_mismatch");
  }
  instance.goal = checkpoint.goal;
  instance.llmPlan = checkpoint.plan ?? undefined;
  instance.memories = [...checkpoint.memories];
  instance.recentActionLog = checkpoint.recentActionLog.map((entry) => ({
    ...entry,
  }));
  instance.tickCounter = checkpoint.tickCounter;
  instance.pendingLlmResult = undefined;
  instance.autonomyCheckpointRevision = checkpoint.revision;
  instance.autonomyRecoveryPending = true;
}
