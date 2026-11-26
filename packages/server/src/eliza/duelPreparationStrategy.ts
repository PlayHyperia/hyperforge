import { ModelType, type AgentRuntime } from "@elizaos/core";
import {
  DUEL_PREPARATION_ROLE_POLICY_VERSION,
  normalizeExternalDuelPreparationStrategyDecision,
} from "@hyperforge/shared";
import {
  formatUntrustedPromptData,
  normalizeUntrustedPromptText,
  parseOneJsonObject,
} from "./promptSafety.js";
import {
  MAX_DUEL_PREPARATION_OPPONENT_HISTORY,
  type DuelPreparationOpponentHistoryEntry,
  type StreamingDuelWinReason,
} from "../systems/StreamingDuelScheduler/types.js";
import {
  buildDeterministicCompetitiveTacticalStrategy,
  type CompetitiveTacticalStrategy,
} from "../systems/StreamingDuelScheduler/competitive-tactical-strategy.js";
import type { DuelPreparationDecisionOutcome } from "../systems/StreamingDuelScheduler/preparation-decision-receipt.js";

export type DuelPreparationRole = "melee" | "ranged" | "mage";

export type PublicAgentVision = {
  narrative: string;
  pillars: string[];
};

export type DuelPreparationRoleDecision = {
  primaryStyle: DuelPreparationRole;
  source: "model" | "deterministic";
  decisionOutcome: DuelPreparationDecisionOutcome;
  reason: string;
  tacticalStrategy: CompetitiveTacticalStrategy;
  policyVersion: typeof DUEL_PREPARATION_ROLE_POLICY_VERSION;
  latencyMs: number;
};

export { DUEL_PREPARATION_ROLE_POLICY_VERSION };

const DEFAULT_MODEL_TIMEOUT_MS = 3_000;
const MIN_MODEL_BUDGET_MS = 250;
const DEADLINE_RESERVE_MS = 1_000;

const ROLE_SET = new Set<DuelPreparationRole>(["melee", "ranged", "mage"]);
const RESULT_SET = new Set(["win", "loss", "draw"]);
const WIN_REASON_SET = new Set<StreamingDuelWinReason>([
  "kill",
  "forfeit",
  "hp_advantage",
  "damage_advantage",
  "draw",
]);
const OPPONENT_HISTORY_KEYS = new Set([
  "cycleId",
  "finishedAt",
  "result",
  "ownOpeningStyle",
  "opponentOpeningStyle",
  "ownDamage",
  "opponentDamage",
  "winReason",
]);

function boundedText(value: unknown, maxLength: number): string {
  return normalizeUntrustedPromptText(value, maxLength);
}

function formatPublicVision(
  vision: PublicAgentVision | null,
): PublicAgentVision | null {
  if (!vision) return null;
  const narrative = boundedText(vision.narrative, 240) || "not published";
  const pillars = vision.pillars
    .map((pillar) => boundedText(pillar, 64))
    .filter(Boolean)
    .slice(0, 4);
  return { narrative, pillars };
}

const normalizeHistoryRole = (value: unknown): DuelPreparationRole | null =>
  value === null
    ? null
    : ROLE_SET.has(value as DuelPreparationRole)
      ? (value as DuelPreparationRole)
      : null;

/**
 * Validate internal scheduler history before it can influence a prompt or an
 * equipment score. The bound applies before filtering, preventing oversized
 * forged events from consuming unbounded work.
 */
export function normalizeDuelPreparationOpponentHistory(
  value: unknown,
  selectedAt: number = Number.MAX_SAFE_INTEGER,
): DuelPreparationOpponentHistoryEntry[] {
  if (!Array.isArray(value) || !Number.isSafeInteger(selectedAt)) return [];
  const seenCycleIds = new Set<string>();
  const normalized: DuelPreparationOpponentHistoryEntry[] = [];

  for (const candidate of value.slice(
    0,
    MAX_DUEL_PREPARATION_OPPONENT_HISTORY,
  )) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const row = candidate as Record<string, unknown>;
    if (Object.keys(row).some((key) => !OPPONENT_HISTORY_KEYS.has(key))) {
      continue;
    }
    const cycleId = boundedText(row.cycleId, 128);
    const ownOpeningStyle = normalizeHistoryRole(row.ownOpeningStyle);
    const opponentOpeningStyle = normalizeHistoryRole(row.opponentOpeningStyle);
    if (
      !cycleId ||
      seenCycleIds.has(cycleId) ||
      !Number.isSafeInteger(row.finishedAt) ||
      (row.finishedAt as number) < 0 ||
      (row.finishedAt as number) > selectedAt ||
      !RESULT_SET.has(row.result as string) ||
      (row.ownOpeningStyle !== null && ownOpeningStyle === null) ||
      (row.opponentOpeningStyle !== null && opponentOpeningStyle === null) ||
      !Number.isSafeInteger(row.ownDamage) ||
      (row.ownDamage as number) < 0 ||
      !Number.isSafeInteger(row.opponentDamage) ||
      (row.opponentDamage as number) < 0 ||
      !WIN_REASON_SET.has(row.winReason as StreamingDuelWinReason)
    ) {
      continue;
    }
    seenCycleIds.add(cycleId);
    normalized.push({
      cycleId,
      finishedAt: row.finishedAt as number,
      result: row.result as "win" | "loss" | "draw",
      ownOpeningStyle,
      opponentOpeningStyle,
      ownDamage: row.ownDamage as number,
      opponentDamage: row.opponentDamage as number,
      winReason: row.winReason as StreamingDuelWinReason,
    });
  }

  return normalized.sort(
    (left, right) =>
      right.finishedAt - left.finishedAt ||
      left.cycleId.localeCompare(right.cycleId),
  );
}

/** Most frequent observed opening style, with newest observation as tie-break. */
export function inferOpponentDefensiveFocus(
  history: readonly DuelPreparationOpponentHistoryEntry[],
): DuelPreparationRole | null {
  const counts = new Map<
    DuelPreparationRole,
    { count: number; newestIndex: number }
  >();
  history.forEach((entry, index) => {
    const style = entry.opponentOpeningStyle;
    if (!style || !ROLE_SET.has(style)) return;
    const current = counts.get(style);
    counts.set(style, {
      count: (current?.count ?? 0) + 1,
      newestIndex: current?.newestIndex ?? index,
    });
  });
  return (
    [...counts.entries()].sort(
      ([leftStyle, left], [rightStyle, right]) =>
        right.count - left.count ||
        left.newestIndex - right.newestIndex ||
        leftStyle.localeCompare(rightStyle),
    )[0]?.[0] ?? null
  );
}

export function parseDuelPreparationRoleResponse(
  raw: string,
  availableRoles: readonly DuelPreparationRole[],
  availablePrayerIds: readonly string[],
): {
  primaryStyle: DuelPreparationRole;
  reason: string;
  tacticalStrategy: CompetitiveTacticalStrategy;
} | null {
  const parsed = parseOneJsonObject(raw, 2_048);
  if (!parsed) return null;
  const decision = normalizeExternalDuelPreparationStrategyDecision(
    parsed,
    availableRoles,
    availablePrayerIds,
  );
  return decision as {
    primaryStyle: DuelPreparationRole;
    reason: string;
    tacticalStrategy: CompetitiveTacticalStrategy;
  } | null;
}

export async function chooseDuelPreparationRole(input: {
  runtime: Pick<AgentRuntime, "useModel"> | null;
  agentName: string;
  opponentName: string;
  ownPublicVision: PublicAgentVision | null;
  opponentPublicVision: PublicAgentVision | null;
  opponentHistory: readonly DuelPreparationOpponentHistoryEntry[];
  availableRoles: readonly DuelPreparationRole[];
  /** Prayer IDs authored in the live manifest and usable from frozen custody. */
  availablePrayerIds: readonly string[];
  deterministicRole: DuelPreparationRole;
  preparationExpiresAt: number;
  timeoutMs?: number;
  now?: () => number;
}): Promise<DuelPreparationRoleDecision> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const fallback = (
    reason: string,
    decisionOutcome: Exclude<DuelPreparationDecisionOutcome, "model_selected">,
  ): DuelPreparationRoleDecision => ({
    primaryStyle: input.deterministicRole,
    source: "deterministic",
    decisionOutcome,
    reason,
    tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy(
      input.deterministicRole,
      input.availablePrayerIds,
    ),
    policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
    latencyMs: Math.max(0, now() - startedAt),
  });

  if (input.availableRoles.length <= 1) {
    return fallback(
      "Only one complete legal opening style is available.",
      "deterministic_single_legal_role",
    );
  }
  if (!input.availableRoles.includes(input.deterministicRole)) {
    return fallback(
      "The deterministic role was not present in the legal role set.",
      "deterministic_invalid_role_set",
    );
  }
  if (!input.runtime) {
    return fallback(
      "No healthy ElizaOS model runtime was available.",
      "deterministic_runtime_unavailable",
    );
  }

  const requestedTimeout = Math.max(
    MIN_MODEL_BUDGET_MS,
    Math.min(input.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS, 10_000),
  );
  const remainingBudget =
    input.preparationExpiresAt - now() - DEADLINE_RESERVE_MS;
  const timeoutMs = Math.min(requestedTimeout, remainingBudget);
  if (timeoutMs < MIN_MODEL_BUDGET_MS) {
    return fallback(
      "The preparation deadline had insufficient model budget.",
      "deterministic_deadline_exhausted",
    );
  }

  const opponentHistory = normalizeDuelPreparationOpponentHistory(
    input.opponentHistory,
  );

  const prompt = [
    `Choose one OPENING COMBAT STYLE and one bounded TACTICAL STRATEGY for the agent described in the public-data blocks.`,
    `This is a high-level preference only. The game server independently owns inventory, validates every item, and executes only legal actions.`,
    `Choose exactly one style from this allowlist: ${JSON.stringify(input.availableRoles)}.`,
    `The tactical strategy is frozen before the public market and executed later only by deterministic server macros. No model call may alter it after market publication.`,
    `Choose preferredCombatRole as null for deterministic visible-opponent counter-switching, or one exact allowlisted role to hold that role while usable.`,
    `Choose prayer as null or exactly one ID from this usable Prayer allowlist: ${JSON.stringify(input.availablePrayerIds)}.`,
    `Do not request items, quantities, direct actions, or rule changes.`,
    formatUntrustedPromptData("PUBLIC_DUEL_PROFILES", {
      agentName: input.agentName || "agent",
      opponentName: input.opponentName || "opponent",
      ownPublicProfile: formatPublicVision(input.ownPublicVision),
      opponentPublicProfile: formatPublicVision(input.opponentPublicVision),
    }),
    formatUntrustedPromptData("VERIFIED_OPPONENT_HISTORY", {
      newestFirst: opponentHistory,
      observedOpeningStyleFocus:
        inferOpponentDefensiveFocus(opponentHistory) ?? "none",
    }),
    `Return JSON only: {"primaryStyle":"melee|ranged|mage","reason":"one concise public-safe sentence","tacticalStrategy":{"approach":"aggressive|defensive|balanced|outlast","tacticalMacro":"pressure|hold_range|kite|orbit|defensive_reset|finish","attackStyle":"accurate|aggressive|controlled|defensive","prayer":null,"preferredCombatRole":"melee|ranged|mage|null","foodThreshold":40,"switchDefensiveAt":30,"reasoning":"one concise public-safe sentence"}}`,
  ].join("\n");

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const response = await Promise.race([
      input.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 120,
        temperature: 0.2,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("duel preparation role decision timeout")),
          timeoutMs,
        );
      }),
    ]);
    if (typeof response !== "string") {
      return fallback(
        "The model returned no usable role decision.",
        "deterministic_model_empty",
      );
    }
    const parsed = parseDuelPreparationRoleResponse(
      response,
      input.availableRoles,
      input.availablePrayerIds,
    );
    if (!parsed) {
      return fallback(
        "The model role decision failed strict validation.",
        "deterministic_model_rejected",
      );
    }
    return {
      ...parsed,
      source: "model",
      decisionOutcome: "model_selected",
      policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
      latencyMs: Math.max(0, now() - startedAt),
    };
  } catch {
    return fallback(
      "The model role decision timed out or failed.",
      "deterministic_model_failed",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
