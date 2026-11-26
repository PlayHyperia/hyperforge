import { eq, sql } from "drizzle-orm";
import type {
  StreamingDuelPublicPreparationActivity,
  StreamingDuelPublicPreparationMode,
} from "@hyperforge/shared";

import type { Database } from "../database/client.js";
import {
  agentAutonomyLifecycleEvents,
  agentAutonomyLifecycleHeads,
} from "../database/schema.js";
import type {
  AgentGoal,
  EmbeddedBehaviorAction,
} from "./managers/AgentBehaviorTicker.js";
import {
  AGENT_AUTONOMY_ACTION_TYPES,
  type RuntimeAgentActionOutcome,
} from "./agentAutonomyCheckpoint.js";

export const AGENT_AUTONOMY_LIFECYCLE_STATES = [
  "goal_selection",
  "gathering",
  "training",
  "crafting",
  "provisioning",
  "questing",
  "exploring",
  "reassessment",
] as const;

export type AgentAutonomyLifecycleState =
  (typeof AGENT_AUTONOMY_LIFECYCLE_STATES)[number];
export type AgentAutonomyLifecycleEventSource =
  "runtime" | "restart_recovery" | "restart_reconciliation";
type NonIdleActionType = Exclude<EmbeddedBehaviorAction["type"], "idle">;
type LifecycleHead = typeof agentAutonomyLifecycleHeads.$inferSelect;

export interface AgentAutonomyLifecycleHeadSnapshot {
  state: AgentAutonomyLifecycleState;
  latestActionType: NonIdleActionType | null;
  latestActionStartedAt: number | null;
  headRevision: number;
  updatedAt: number;
}

const LIFECYCLE_STATES = new Set<string>(AGENT_AUTONOMY_LIFECYCLE_STATES);
const NON_IDLE_ACTION_TYPES = new Set<string>(
  AGENT_AUTONOMY_ACTION_TYPES.filter((actionType) => actionType !== "idle"),
);
const TRAVEL_ACTION_TYPES = new Set<NonIdleActionType>([
  "move",
  "navigateTo",
  "homeTeleport",
]);

export interface AgentAutonomyLifecycleAttempt {
  attemptId: string;
  characterId: string;
  goalType: AgentGoal["type"] | null;
  actionType: NonIdleActionType;
  startedAt: number;
}

const CRAFTING_ACTIONS = new Set<NonIdleActionType>([
  "firemake",
  "cook",
  "smelt",
  "smith",
  "runecraft",
  "craft",
  "fletch",
  "tan",
]);
const PROVISIONING_ACTIONS = new Set<NonIdleActionType>([
  "lootGravestone",
  "storeBuy",
  "use",
  "equip",
  "setAutocast",
  "bankDepositAll",
  "bankWithdraw",
]);

/**
 * Derive one bounded lifecycle category from authoritative action intent.
 * Action semantics take precedence over the broader goal so quest gathering,
 * combat, and crafting are visible as the actual work they perform.
 */
export function deriveAgentAutonomyLifecycleState(
  goalType: AgentGoal["type"] | null,
  actionType: NonIdleActionType,
): Exclude<AgentAutonomyLifecycleState, "goal_selection" | "reassessment"> {
  if (actionType === "gather" || actionType === "pickup") {
    return "gathering";
  }
  if (actionType === "attack" || actionType === "bury") return "training";
  if (CRAFTING_ACTIONS.has(actionType)) return "crafting";
  if (PROVISIONING_ACTIONS.has(actionType)) return "provisioning";
  if (actionType === "questAccept" || actionType === "questComplete") {
    return "questing";
  }

  switch (goalType) {
    case "gathering":
      return "gathering";
    case "combat":
      return "training";
    case "cooking":
    case "smelting":
    case "smithing":
      return "crafting";
    case "banking":
    case "provisioning":
      return "provisioning";
    case "questing":
      return "questing";
    case "exploring":
    case "idle":
    case null:
    default:
      return "exploring";
  }
}

/** Map durable internal lifecycle state to the only category exposed publicly. */
export function toPublicPreparationActivity(
  state: AgentAutonomyLifecycleState,
): StreamingDuelPublicPreparationActivity {
  if (state === "goal_selection") return "planning";
  if (state === "reassessment") return "reassessing";
  return state;
}

/**
 * Derive the only public movement dimension from bounded durable state. The
 * exact action remains private; goal selection and reassessment never inherit
 * a stale travel label from the prior operational action.
 */
export function toPublicPreparationMode(
  state: AgentAutonomyLifecycleState,
  latestActionType: NonIdleActionType | null,
): StreamingDuelPublicPreparationMode {
  if (state === "goal_selection" || state === "reassessment") {
    return "working";
  }
  return latestActionType !== null && TRAVEL_ACTION_TYPES.has(latestActionType)
    ? "traveling"
    : "working";
}

/** Read and validate the durable lifecycle head used by public presentation. */
export async function loadAgentAutonomyLifecycleHead(
  db: Database,
  characterId: string,
): Promise<AgentAutonomyLifecycleHeadSnapshot | null> {
  const rows = await db
    .select({
      state: agentAutonomyLifecycleHeads.currentState,
      latestActionType: agentAutonomyLifecycleHeads.latestActionType,
      latestActionStartedAt: agentAutonomyLifecycleHeads.latestActionStartedAt,
      headRevision: agentAutonomyLifecycleHeads.headRevision,
      updatedAt: agentAutonomyLifecycleHeads.updatedAt,
    })
    .from(agentAutonomyLifecycleHeads)
    .where(eq(agentAutonomyLifecycleHeads.characterId, characterId))
    .limit(1);
  const head = rows[0];
  if (!head) return null;
  if (
    !LIFECYCLE_STATES.has(head.state) ||
    (head.latestActionType !== null &&
      !NON_IDLE_ACTION_TYPES.has(head.latestActionType)) ||
    (head.latestActionStartedAt !== null &&
      (!Number.isSafeInteger(head.latestActionStartedAt) ||
        head.latestActionStartedAt < 0)) ||
    (head.latestActionType === null) !==
      (head.latestActionStartedAt === null) ||
    !Number.isSafeInteger(head.headRevision) ||
    head.headRevision < 0 ||
    !Number.isSafeInteger(head.updatedAt) ||
    head.updatedAt < 0
  ) {
    throw new Error("agent_autonomy_lifecycle_head_invalid");
  }
  return Object.freeze({
    state: head.state as AgentAutonomyLifecycleState,
    latestActionType: head.latestActionType as NonIdleActionType | null,
    latestActionStartedAt: head.latestActionStartedAt,
    headRevision: head.headRevision,
    updatedAt: head.updatedAt,
  });
}

async function lockLifecycleHead(
  db: Database,
  characterId: string,
  updatedAt: number,
): Promise<LifecycleHead> {
  await db
    .insert(agentAutonomyLifecycleHeads)
    .values({ characterId, updatedAt })
    .onConflictDoNothing();
  const rows = await db
    .select()
    .from(agentAutonomyLifecycleHeads)
    .where(eq(agentAutonomyLifecycleHeads.characterId, characterId))
    .limit(1)
    .for("update");
  if (!rows[0]) throw new Error("agent_autonomy_lifecycle_head_lock_failed");
  return rows[0];
}

async function updateLifecycleHead(
  db: Database,
  head: LifecycleHead,
  currentState: AgentAutonomyLifecycleState,
  currentGoalType: AgentGoal["type"] | null,
  transitionCount: number,
  occurredAt: number,
  latestActionType?: NonIdleActionType,
): Promise<void> {
  if (transitionCount === 0 && latestActionType === undefined) return;
  const rows = await db
    .update(agentAutonomyLifecycleHeads)
    .set({
      currentState,
      currentGoalType,
      ...(latestActionType === undefined
        ? {}
        : {
            latestActionType,
            latestActionStartedAt: occurredAt,
          }),
      headRevision: sql`${agentAutonomyLifecycleHeads.headRevision} + ${transitionCount}`,
      updatedAt: sql`GREATEST(${agentAutonomyLifecycleHeads.updatedAt}, ${occurredAt})`,
    })
    .where(eq(agentAutonomyLifecycleHeads.characterId, head.characterId))
    .returning({ characterId: agentAutonomyLifecycleHeads.characterId });
  if (!rows[0]) throw new Error("agent_autonomy_lifecycle_head_update_failed");
}

/** Append goal selection plus concrete work-state entry with the action start. */
export async function recordAgentAutonomyLifecycleStart(
  db: Database,
  attempt: AgentAutonomyLifecycleAttempt,
): Promise<void> {
  const head = await lockLifecycleHead(
    db,
    attempt.characterId,
    attempt.startedAt,
  );
  const occurredAt = Math.max(attempt.startedAt, head.updatedAt);
  let currentState = head.currentState as AgentAutonomyLifecycleState;
  let currentGoalType = head.currentGoalType as AgentGoal["type"] | null;
  let transitionCount = 0;

  if (currentGoalType !== attempt.goalType) {
    await db.insert(agentAutonomyLifecycleEvents).values({
      eventKey: `${attempt.attemptId}:lifecycle:goal-start`,
      characterId: attempt.characterId,
      attemptId: attempt.attemptId,
      eventSource: "runtime",
      eventType: attempt.goalType === null ? "goal_cleared" : "goal_selected",
      lifecycleState: "goal_selection",
      previousState: currentState,
      previousGoalType: currentGoalType,
      goalType: attempt.goalType,
      actionType: attempt.actionType,
      occurredAt,
    });
    currentState = "goal_selection";
    currentGoalType = attempt.goalType;
    transitionCount += 1;
  }

  const actionState = deriveAgentAutonomyLifecycleState(
    attempt.goalType,
    attempt.actionType,
  );
  if (currentState !== actionState) {
    await db.insert(agentAutonomyLifecycleEvents).values({
      eventKey: `${attempt.attemptId}:lifecycle:state-start`,
      characterId: attempt.characterId,
      attemptId: attempt.attemptId,
      eventSource: "runtime",
      eventType: "state_entered",
      lifecycleState: actionState,
      previousState: currentState,
      previousGoalType: currentGoalType,
      goalType: currentGoalType,
      actionType: attempt.actionType,
      occurredAt,
    });
    currentState = actionState;
    transitionCount += 1;
  }

  await updateLifecycleHead(
    db,
    head,
    currentState,
    currentGoalType,
    transitionCount,
    occurredAt,
    attempt.actionType,
  );
}

/**
 * Append only terminal lifecycle changes: a goal cleared/replaced by the
 * authoritative result, or mandatory reassessment after rejection/failure.
 */
export async function recordAgentAutonomyLifecycleTerminal(
  db: Database,
  attempt: AgentAutonomyLifecycleAttempt,
  input: {
    eventSource: AgentAutonomyLifecycleEventSource;
    goalType: AgentGoal["type"] | null;
    actionOutcome: RuntimeAgentActionOutcome;
    checkpointRevision: number;
    occurredAt: number;
  },
): Promise<void> {
  const head = await lockLifecycleHead(
    db,
    attempt.characterId,
    input.occurredAt,
  );
  const occurredAt = Math.max(input.occurredAt, head.updatedAt);
  let currentState = head.currentState as AgentAutonomyLifecycleState;
  let currentGoalType = head.currentGoalType as AgentGoal["type"] | null;
  let transitionCount = 0;

  if (currentGoalType !== input.goalType) {
    await db.insert(agentAutonomyLifecycleEvents).values({
      eventKey: `${attempt.attemptId}:lifecycle:goal-terminal`,
      characterId: attempt.characterId,
      attemptId: attempt.attemptId,
      eventSource: input.eventSource,
      eventType: input.goalType === null ? "goal_cleared" : "goal_selected",
      lifecycleState: "goal_selection",
      previousState: currentState,
      previousGoalType: currentGoalType,
      goalType: input.goalType,
      actionType: attempt.actionType,
      actionOutcome: input.actionOutcome,
      checkpointRevision: input.checkpointRevision,
      occurredAt,
    });
    currentState = "goal_selection";
    currentGoalType = input.goalType;
    transitionCount += 1;
  }

  if (
    input.actionOutcome === "rejected" ||
    input.actionOutcome === "failed" ||
    input.actionOutcome === "unknown_after_restart"
  ) {
    await db.insert(agentAutonomyLifecycleEvents).values({
      eventKey: `${attempt.attemptId}:lifecycle:reassess-terminal`,
      characterId: attempt.characterId,
      attemptId: attempt.attemptId,
      eventSource: input.eventSource,
      eventType: "reassessment_required",
      lifecycleState: "reassessment",
      previousState: currentState,
      previousGoalType: currentGoalType,
      goalType: currentGoalType,
      actionType: attempt.actionType,
      actionOutcome: input.actionOutcome,
      checkpointRevision: input.checkpointRevision,
      occurredAt,
    });
    currentState = "reassessment";
    transitionCount += 1;
  }

  await updateLifecycleHead(
    db,
    head,
    currentState,
    currentGoalType,
    transitionCount,
    occurredAt,
  );
}
