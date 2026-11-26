import { getItem, isFood } from "@hyperforge/shared";
import type {
  AgentQuestInfo,
  AgentQuestProgress,
  NearbyEntityData,
} from "./types.js";
import { isStartableAgentQuest } from "./types.js";
import type { EmbeddedHyperiaService } from "./EmbeddedHyperiaService.js";
import { ServerNetwork } from "../systems/ServerNetwork/index.js";
import { agentThoughts as agentThoughtsTable } from "../database/schema.js";
import type { Database } from "../database/client.js";

type DashboardThought = {
  id?: string;
  type: "situation" | "evaluation" | "thinking" | "decision" | "action";
  content: string;
  timestamp?: number;
  decisionPath?: "short-circuit" | "llm" | "scripted" | "planner" | "curiosity";
  providers?: string[];
};

const DASHBOARD_THOUGHT_TYPES = new Set<DashboardThought["type"]>([
  "situation",
  "evaluation",
  "thinking",
  "decision",
  "action",
]);
const DASHBOARD_DECISION_PATHS = new Set<
  NonNullable<DashboardThought["decisionPath"]>
>(["short-circuit", "llm", "scripted", "planner", "curiosity"]);

function normalizeDashboardThoughtType(
  value: string,
): DashboardThought["type"] {
  return DASHBOARD_THOUGHT_TYPES.has(value as DashboardThought["type"])
    ? (value as DashboardThought["type"])
    : "thinking";
}

function normalizeDashboardDecisionPath(
  value: string | null,
): DashboardThought["decisionPath"] {
  return value &&
    DASHBOARD_DECISION_PATHS.has(
      value as NonNullable<DashboardThought["decisionPath"]>,
    )
    ? (value as NonNullable<DashboardThought["decisionPath"]>)
    : undefined;
}

// ── Thought persistence (batch writes to DB) ──────────────────────────
type PendingThoughtRow = {
  characterId: string;
  type: string;
  content: string;
  decisionPath: string | null;
  timestamp: number;
};

const pendingThoughtWrites: PendingThoughtRow[] = [];
const THOUGHT_FLUSH_INTERVAL_MS = 10_000;
let thoughtFlushTimer: ReturnType<typeof setInterval> | null = null;

// DB handle — set once via setThoughtDb() from server startup
let _thoughtDb: Database | null = null;

/** Set the Drizzle DB instance for thought persistence. Call once at startup. */
export function setThoughtDb(db: Database): void {
  _thoughtDb = db;
}

async function flushPendingThoughts(): Promise<void> {
  if (pendingThoughtWrites.length === 0) return;
  if (!_thoughtDb) return; // No DB configured
  const batch = pendingThoughtWrites.splice(0, pendingThoughtWrites.length);
  try {
    await _thoughtDb.insert(agentThoughtsTable).values(batch);
  } catch (err) {
    // Don't lose thoughts on transient DB errors — re-queue (with cap)
    if (pendingThoughtWrites.length < 500) {
      pendingThoughtWrites.push(...batch);
    }
    console.warn(
      "[dashboardInterop] Failed to flush thoughts to DB:",
      (err as Error).message,
    );
  }
}

function ensureThoughtFlushTimer(): void {
  if (thoughtFlushTimer) return;
  thoughtFlushTimer = setInterval(() => {
    void flushPendingThoughts();
  }, THOUGHT_FLUSH_INTERVAL_MS);
  // Don't block process exit
  if (
    thoughtFlushTimer &&
    typeof thoughtFlushTimer === "object" &&
    "unref" in thoughtFlushTimer
  ) {
    thoughtFlushTimer.unref();
  }
}

/** Call on shutdown to flush any remaining thoughts */
export async function flushAgentThoughtsToDb(): Promise<void> {
  if (thoughtFlushTimer) {
    clearInterval(thoughtFlushTimer);
    thoughtFlushTimer = null;
  }
  await flushPendingThoughts();
}

/**
 * Hydrate in-memory thought cache from DB for a given agent.
 * Call once per agent at startup so historical thoughts are immediately available.
 */
export async function hydrateThoughtsFromDb(
  characterId: string,
): Promise<void> {
  if (!_thoughtDb) return;
  try {
    const { desc, eq } = await import("drizzle-orm");
    const rows = await _thoughtDb
      .select()
      .from(agentThoughtsTable)
      .where(eq(agentThoughtsTable.characterId, characterId))
      .orderBy(desc(agentThoughtsTable.timestamp))
      .limit(ServerNetwork.MAX_THOUGHTS_PER_AGENT);

    if (rows.length === 0) return;

    const existing = ServerNetwork.agentThoughts.get(characterId) || [];
    const existingIds = new Set(existing.map((t: { id: string }) => t.id));

    // Merge DB rows that aren't already in memory
    for (const r of rows) {
      const id = `${r.characterId}-thought-${r.timestamp}`;
      if (!existingIds.has(id)) {
        existing.push({
          id,
          type: normalizeDashboardThoughtType(r.type),
          content: r.content,
          timestamp: r.timestamp,
          decisionPath: normalizeDashboardDecisionPath(r.decisionPath),
        });
      }
    }

    // Sort by timestamp descending and cap
    existing.sort(
      (a: { timestamp: number }, b: { timestamp: number }) =>
        b.timestamp - a.timestamp,
    );
    if (existing.length > ServerNetwork.MAX_THOUGHTS_PER_AGENT) {
      existing.length = ServerNetwork.MAX_THOUGHTS_PER_AGENT;
    }
    ServerNetwork.agentThoughts.set(characterId, existing);
  } catch {
    // Non-critical — agent will still collect new thoughts
  }
}

type CommandData = {
  target?: [number, number, number];
  runMode?: boolean;
  description?: string;
  targetId?: string;
  resourceId?: string;
  itemId?: string;
  quantity?: number;
  questId?: string;
  recipe?: string;
  slot?: string;
  message?: string;
  npcId?: string;
  interaction?: string;
};

type DistancePreference = "nearest" | "furthest";
type HealthPreference = "lowest" | "highest";
type DirectionPreference = "left" | "right" | "front" | "back";

export type ResolvedDashboardIntent = {
  command:
    | "move"
    | "attack"
    | "gather"
    | "pickup"
    | "stop"
    | "use"
    | "equip"
    | "npcInteract"
    | "questAccept"
    | "cook"
    | "smelt"
    | "smith"
    | "bankDepositAll"
    | "bankOpen"
    | "homeTeleport"
    | "drop"
    | "unequip"
    | "follow";
  data: CommandData;
  text: string;
  thought: string;
  targetName?: string;
};

const RECENT_THOUGHT_TTL_MS = 15000;
const recentThoughts = new Map<
  string,
  { signature: string; timestamp: number }
>();

function buildThoughtSignature(
  characterId: string,
  thought: DashboardThought,
): string {
  return [
    characterId,
    thought.type,
    thought.decisionPath || "",
    thought.content.trim().toLowerCase(),
  ].join("::");
}

export function recordAgentThought(
  characterId: string,
  thought: DashboardThought,
): void {
  if (!characterId || !thought.content.trim()) {
    return;
  }

  const now = thought.timestamp ?? Date.now();
  const signature = buildThoughtSignature(characterId, thought);
  const previous = recentThoughts.get(characterId);
  if (
    previous &&
    previous.signature === signature &&
    now - previous.timestamp < RECENT_THOUGHT_TTL_MS
  ) {
    return;
  }

  recentThoughts.set(characterId, { signature, timestamp: now });

  const nextThought = {
    id: thought.id || `${characterId}-thought-${now}`,
    type: thought.type,
    content: thought.content.trim(),
    timestamp: now,
    decisionPath: thought.decisionPath,
    providers: thought.providers,
  };

  const thoughts = ServerNetwork.agentThoughts.get(characterId) || [];
  thoughts.unshift(nextThought);
  if (thoughts.length > ServerNetwork.MAX_THOUGHTS_PER_AGENT) {
    thoughts.length = ServerNetwork.MAX_THOUGHTS_PER_AGENT;
  }
  ServerNetwork.agentThoughts.set(characterId, thoughts);

  // Queue for DB persistence
  pendingThoughtWrites.push({
    characterId,
    type: nextThought.type,
    content: nextThought.content,
    decisionPath: nextThought.decisionPath ?? null,
    timestamp: now,
  });
  ensureThoughtFlushTimer();
}

/** Snapshot of embedded AgentBehaviorTicker.goal (avoid circular import of AgentInstance). */
export type EmbeddedTickerGoalSnapshot = {
  type:
    | "questing"
    | "combat"
    | "gathering"
    | "banking"
    | "cooking"
    | "smelting"
    | "smithing"
    | "provisioning"
    | "exploring"
    | "idle";
  description: string;
  questId?: string;
  questName?: string;
  questStageType?: string;
  questStageTarget?: string;
  questStageCount?: number;
};

const MAX_EMBEDDED_DASHBOARD_ACTIVITY = 100;

function formatSkillLabel(skillId: string): string {
  if (!skillId) {
    return skillId;
  }
  return skillId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Seed a long-term build / playstyle ambition once per character so the dashboard
 * and LLM planner have something to align with before operator or LLM updates it.
 */
export function ensureEmbeddedAgentCharacterVision(
  characterId: string,
  skills: Record<string, { level: number; xp: number }> | undefined,
): void {
  if (!characterId || ServerNetwork.agentCharacterVision.has(characterId)) {
    return;
  }

  const ranked = Object.entries(skills || {})
    .map(([id, v]) => ({ id, level: v.level }))
    .filter((x) => x.level >= 1)
    .sort((a, b) => b.level - a.level)
    .slice(0, 5);

  const pillars = ranked.map((x) => formatSkillLabel(x.id));
  const narrative =
    pillars.length > 0
      ? `Grow into a distinctive build: lean on ${pillars.slice(0, 3).join(", ")} while keeping Constitution fed, quests moving for gear, and a gathering skill for steady gold. Favor actions over many sessions that reinforce these pillars—not only the next tick.`
      : `Become a self-sufficient adventurer: push starter quests for gear and direction, train combat fundamentals with food on hand, and develop one gathering skill for income. Keep long-horizon progression in mind when choosing what to do next.`;

  ServerNetwork.agentCharacterVision.set(characterId, {
    narrative,
    pillars:
      pillars.length > 0
        ? pillars.slice(0, 5)
        : ["Quest progression", "Combat readiness", "Resource income"],
    updatedAt: Date.now(),
    source: "seed",
  });
}

function mapEmbeddedGoalTypeToDashboard(
  t: EmbeddedTickerGoalSnapshot["type"],
): string {
  switch (t) {
    case "combat":
      return "combat_training";
    case "gathering":
      return "gathering";
    case "questing":
      return "questing";
    case "banking":
      return "banking";
    case "cooking":
      return "cooking";
    case "smelting":
      return "smelting";
    case "smithing":
      return "smithing";
    case "provisioning":
      return "shopping";
    case "exploring":
      return "exploration";
    default:
      return "idle";
  }
}

function computeQuestProgressForDashboard(
  questId: string | undefined,
  quests: AgentQuestProgress[],
): { progress: number; target: number } {
  if (!questId) {
    return { progress: 0, target: 1 };
  }
  const q = quests.find((x) => x.questId === questId);
  if (!q) {
    return { progress: 0, target: 1 };
  }
  const target = Math.max(1, q.stageCount ?? 1);
  if (q.status === "ready_to_complete") {
    return { progress: target, target };
  }
  const sum = Object.values(q.stageProgress || {}).reduce((a, b) => a + b, 0);
  return { progress: Math.min(sum, target), target };
}

function activityTypeForBehaviorAction(
  actionType: string,
): "combat" | "skill" | "item" | "goal" | "death" | "movement" {
  switch (actionType) {
    case "attack":
      return "combat";
    case "gather":
    case "firemake":
      return "skill";
    case "pickup":
    case "lootGravestone":
      return "item";
    case "move":
      return "movement";
    case "questAccept":
    case "questComplete":
      return "goal";
    default:
      return "movement";
  }
}

/**
 * Push embedded agent goal + optional activity row into ServerNetwork so
 * GET /api/agents/:agentId/goal and /activity return real data (no Eliza WebSocket).
 */
export function syncEmbeddedAgentDashboardForTick(
  characterId: string,
  embeddedGoal: EmbeddedTickerGoalSnapshot | null,
  questState: AgentQuestProgress[],
  availableQuestDefinitions: AgentQuestInfo[],
  agentStartedAt: number,
  behaviorActionType: string,
  actionDescription: string | null,
): void {
  if (!characterId) {
    return;
  }

  if (!embeddedGoal) {
    ServerNetwork.agentGoals.delete(characterId);
  } else {
    const { progress, target } = computeQuestProgressForDashboard(
      embeddedGoal.questId,
      questState,
    );
    ServerNetwork.agentGoals.set(characterId, {
      type: mapEmbeddedGoalTypeToDashboard(embeddedGoal.type),
      description: embeddedGoal.description,
      progress,
      target,
      startedAt: agentStartedAt,
      locked: false,
      questId: embeddedGoal.questId,
      questName: embeddedGoal.questName,
      questStageType: embeddedGoal.questStageType,
      questStageTarget: embeddedGoal.questStageTarget,
    });
  }

  const availableGoals = availableQuestDefinitions
    .filter(isStartableAgentQuest)
    .slice(0, 16)
    .map((q, i) => ({
      id: q.questId,
      type: "questing" as const,
      description: q.description || q.name,
      priority: Math.max(10, 80 - i * 5),
      reason: `Start at ${q.startNpc}`,
      targetSkill: undefined,
      targetSkillLevel: undefined,
      location: undefined,
    }));
  ServerNetwork.agentAvailableGoals.set(characterId, availableGoals);

  if (!actionDescription || behaviorActionType === "idle") {
    return;
  }

  let bucket = ServerNetwork.agentActivity.get(characterId);
  if (!bucket) {
    bucket = {
      recentActions: [],
      sessionStats: {
        kills: 0,
        deaths: 0,
        totalXpGained: 0,
        goldEarned: 0,
        resourcesGathered: {},
      },
    };
    ServerNetwork.agentActivity.set(characterId, bucket);
  }

  const entry = {
    type: activityTypeForBehaviorAction(behaviorActionType),
    description: actionDescription,
    timestamp: Date.now(),
  };
  bucket.recentActions.unshift(entry);
  if (bucket.recentActions.length > MAX_EMBEDDED_DASHBOARD_ACTIVITY) {
    bucket.recentActions.length = MAX_EMBEDDED_DASHBOARD_ACTIVITY;
  }

  const lower = actionDescription.toLowerCase();
  if (behaviorActionType === "gather") {
    const key =
      embeddedGoal?.questStageTarget?.includes("log") ||
      lower.includes("tree") ||
      lower.includes("wood")
        ? "logs"
        : "resources";
    bucket.sessionStats.resourcesGathered[key] =
      (bucket.sessionStats.resourcesGathered[key] || 0) + 1;
  }
  if (
    behaviorActionType === "pickup" ||
    behaviorActionType === "lootGravestone"
  ) {
    bucket.sessionStats.resourcesGathered.items =
      (bucket.sessionStats.resourcesGathered.items || 0) + 1;
  }
  if (
    behaviorActionType === "attack" &&
    (lower.includes("killed") || lower.includes("defeated"))
  ) {
    bucket.sessionStats.kills += 1;
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeTarget(value: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "to",
    "at",
    "nearest",
    "nearby",
    "that",
    "this",
    "there",
    "please",
    "left",
    "right",
    "front",
    "back",
    "behind",
    "ahead",
    "forward",
    "closest",
    "nearest",
    "furthest",
    "farthest",
    "weakest",
    "strongest",
    "lowest",
    "highest",
    "health",
    "hp",
    "low-health",
    "high-health",
    "injured",
    "hurt",
    "wounded",
    "damaged",
    "something",
    "anything",
    "someone",
    "anyone",
  ]);
  const base = normalizeText(value)
    .split(" ")
    .filter((token) => token && !stopWords.has(token));

  const expanded = new Set<string>();
  for (const t of base) {
    expanded.add(t);
    if (t.length >= 5 && t.endsWith("ies")) {
      expanded.add(`${t.slice(0, -3)}y`);
    } else if (t.length >= 4 && t.endsWith("s") && !t.endsWith("ss")) {
      expanded.add(t.slice(0, -1));
    }
  }
  return [...expanded];
}

function entityHaystack(entity: NearbyEntityData): string {
  return normalizeText(
    `${entity.id} ${entity.name || ""} ${entity.mobType || ""} ${entity.resourceType || ""} ${entity.type}`,
  );
}

function getEntityHealthRatio(entity: NearbyEntityData): number | null {
  if (
    typeof entity.health === "number" &&
    typeof entity.maxHealth === "number" &&
    entity.maxHealth > 0
  ) {
    return entity.health / entity.maxHealth;
  }
  if (typeof entity.health === "number") {
    return entity.health;
  }
  return null;
}

function parseSelectionPreferences(targetPhrase?: string): {
  distance: DistancePreference;
  health: HealthPreference | null;
  direction: DirectionPreference | null;
} {
  const normalized = normalizeText(targetPhrase || "");

  let distance: DistancePreference = "nearest";
  if (/\b(furthest|farthest)\b/.test(normalized)) {
    distance = "furthest";
  }

  let health: HealthPreference | null = null;
  if (
    /\b(weakest|lowest health|low health|low-health|injured|hurt|wounded|damaged)\b/.test(
      normalized,
    )
  ) {
    health = "lowest";
  } else if (
    /\b(strongest|highest health|high health|high-health)\b/.test(normalized)
  ) {
    health = "highest";
  }

  let direction: DirectionPreference | null = null;
  if (/\bleft\b/.test(normalized)) {
    direction = "left";
  } else if (/\bright\b/.test(normalized)) {
    direction = "right";
  } else if (/\b(front|ahead|forward)\b/.test(normalized)) {
    direction = "front";
  } else if (/\b(back|behind)\b/.test(normalized)) {
    direction = "back";
  }

  return { distance, health, direction };
}

function getDirectionalScore(
  entity: NearbyEntityData,
  playerPosition: [number, number, number] | null,
  playerYaw: number | null,
  direction: DirectionPreference | null,
): number {
  if (!direction || !playerPosition || playerYaw === null || !entity.position) {
    return 0;
  }

  const dx = entity.position[0] - playerPosition[0];
  const dz = entity.position[2] - playerPosition[2];
  const length = Math.hypot(dx, dz);
  if (length <= 0.001) {
    return 0;
  }

  const normDx = dx / length;
  const normDz = dz / length;
  const forwardX = -Math.sin(playerYaw);
  const forwardZ = -Math.cos(playerYaw);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  const frontDot = normDx * forwardX + normDz * forwardZ;
  const rightDot = normDx * rightX + normDz * rightZ;

  switch (direction) {
    case "left":
      return -rightDot;
    case "right":
      return rightDot;
    case "front":
      return frontDot;
    case "back":
      return -frontDot;
    default:
      return 0;
  }
}

function compareTokenMatch(
  a: NearbyEntityData,
  b: NearbyEntityData,
  tokens: string[],
): number {
  if (tokens.length === 0) {
    return 0;
  }

  const aHaystack = entityHaystack(a);
  const bHaystack = entityHaystack(b);
  const aCount = tokens.filter((token) => aHaystack.includes(token)).length;
  const bCount = tokens.filter((token) => bHaystack.includes(token)).length;

  if (aCount !== bCount) {
    return bCount - aCount;
  }

  const aAll = aCount === tokens.length;
  const bAll = bCount === tokens.length;
  if (aAll !== bAll) {
    return aAll ? -1 : 1;
  }

  return 0;
}

function selectEntity(
  entities: NearbyEntityData[],
  predicate: (entity: NearbyEntityData) => boolean,
  playerPosition: [number, number, number] | null,
  playerYaw: number | null,
  targetPhrase?: string,
): NearbyEntityData | null {
  const filtered = entities.filter(predicate);
  if (filtered.length === 0) {
    return null;
  }

  const tokens = tokenizeTarget(targetPhrase || "");
  const preferences = parseSelectionPreferences(targetPhrase);
  const ranked = [...filtered].sort((a, b) => {
    const tokenMatch = compareTokenMatch(a, b, tokens);
    if (tokenMatch !== 0) {
      return tokenMatch;
    }

    const directionScoreDiff =
      getDirectionalScore(b, playerPosition, playerYaw, preferences.direction) -
      getDirectionalScore(a, playerPosition, playerYaw, preferences.direction);
    if (Math.abs(directionScoreDiff) > 0.01) {
      return directionScoreDiff > 0 ? 1 : -1;
    }

    if (preferences.health) {
      const aHealth = getEntityHealthRatio(a);
      const bHealth = getEntityHealthRatio(b);
      if (aHealth !== null && bHealth !== null && aHealth !== bHealth) {
        return preferences.health === "lowest"
          ? aHealth - bHealth
          : bHealth - aHealth;
      }
      if (aHealth === null && bHealth !== null) return 1;
      if (aHealth !== null && bHealth === null) return -1;
    }

    if (preferences.distance === "furthest") {
      return b.distance - a.distance;
    }
    return a.distance - b.distance;
  });

  return ranked[0] || null;
}

function extractTargetPhrase(content: string, verbs: string[]): string {
  const normalized = normalizeText(content);
  for (const verb of verbs) {
    const idx = normalized.indexOf(`${verb} `);
    if (idx >= 0) {
      return normalized.slice(idx + verb.length + 1).trim();
    }
  }
  return normalized;
}

/** Strip leading courtesy so "can you go to bank" → "go to bank". */
function stripLeadingCourtesyPhrases(normalized: string): string {
  return normalized
    .replace(
      /^(please\s+|can you\s+|could you\s+|would you\s+|will you\s+|hey\s+|hi\s+|ok\s+|okay\s+|thanks\s+|thank you\s+)+/,
      "",
    )
    .trim();
}

/**
 * Target after a movement verb, including "go wolf" (no "to") and "go to X".
 */
function extractMoveTargetPhrase(normalized: string): string | null {
  const stripped = stripLeadingCourtesyPhrases(normalized);
  const direct = stripped.match(
    /^(?:go|walk|run|head|move|approach|travel|return)(?:\s+to)?\s+(.+)$/,
  );
  if (direct?.[1]?.trim()) {
    return direct[1].trim();
  }
  if (
    /(go to|head to|walk to|move to|travel to|run to|get to|return to)\b/.test(
      stripped,
    )
  ) {
    return extractTargetPhrase(stripped, [
      "go to",
      "head to",
      "walk to",
      "move to",
      "travel to",
      "run to",
      "get to",
      "return to",
    ]);
  }
  return null;
}

function buildMoveEntityPredicate(
  moveTargetPhrase: string,
): (entity: NearbyEntityData) => boolean {
  const n = normalizeText(moveTargetPhrase);
  if (n.includes("bank")) {
    return (entity) => Boolean(entity.position) && isBankEntity(entity);
  }
  const resourceish =
    /\b(tree|trees|oak|maple|willow|yew|wood|log|ore|rock|fish|fishing|spot)\b/.test(
      n,
    );
  const mobish =
    /\b(goblin|bandit|skeleton|zombie|rat|spider|wolf|bear|troll|ogre|dragon|imp|monster|enemy|outlaw|brigand|guard|slayer)\b/.test(
      n,
    );
  if (mobish && !resourceish) {
    return (entity) => Boolean(entity.position) && entity.type === "mob";
  }
  if (resourceish && !mobish) {
    return (entity) =>
      Boolean(entity.position) &&
      (entity.type === "resource" ||
        isTreeEntity(entity) ||
        isOreEntity(entity) ||
        isFishingEntity(entity));
  }
  // Default: never treat arbitrary "walk to X" as "nearest mob" when X is a place name / home / NPC.
  return (entity) => Boolean(entity.position) && entity.type !== "mob";
}

function isTreeEntity(entity: NearbyEntityData): boolean {
  const haystack = entityHaystack(entity);
  return (
    haystack.includes("tree") ||
    haystack.includes("oak") ||
    haystack.includes("willow")
  );
}

function isOreEntity(entity: NearbyEntityData): boolean {
  const haystack = entityHaystack(entity);
  return (
    entity.resourceType === "ore" ||
    haystack.includes("ore") ||
    haystack.includes("rock") ||
    haystack.includes("mining")
  );
}

function isFishingEntity(entity: NearbyEntityData): boolean {
  const haystack = entityHaystack(entity);
  return (
    entity.resourceType === "fish" ||
    haystack.includes("fish") ||
    haystack.includes("fishing") ||
    haystack.includes("spot")
  );
}

function isBankEntity(entity: NearbyEntityData): boolean {
  return entityHaystack(entity).includes("bank");
}

type InventoryEntry = {
  slot: number;
  itemId: string;
  quantity: number;
  name: string;
  haystack: string;
  item: ReturnType<typeof getItem>;
};

function getInventoryEntries(
  service: EmbeddedHyperiaService,
): InventoryEntry[] {
  return service.getInventoryItems().map((entry) => {
    const item = getItem(entry.itemId);
    const name = item?.name || entry.itemId;
    return {
      ...entry,
      name,
      haystack: normalizeText(`${entry.itemId} ${name}`),
      item,
    };
  });
}

function resolveInventoryItem(
  entries: InventoryEntry[],
  targetPhrase: string,
  predicate?: (entry: InventoryEntry) => boolean,
): InventoryEntry | null {
  const candidates = predicate ? entries.filter(predicate) : entries;
  if (candidates.length === 0) {
    return null;
  }

  const tokens = tokenizeTarget(targetPhrase);
  if (tokens.length === 0) {
    return candidates[0] || null;
  }

  const ranked = [...candidates].sort((a, b) => {
    const aCount = tokens.filter((token) => a.haystack.includes(token)).length;
    const bCount = tokens.filter((token) => b.haystack.includes(token)).length;
    if (aCount !== bCount) {
      return bCount - aCount;
    }
    return a.name.localeCompare(b.name);
  });

  const best = ranked[0] || null;
  if (!best) {
    return null;
  }

  if (tokens.length === 0) {
    return best;
  }

  const bestCount = tokens.filter((token) =>
    best.haystack.includes(token),
  ).length;
  return bestCount > 0 ? best : null;
}

function resolveBestHealingItem(
  entries: InventoryEntry[],
): InventoryEntry | null {
  const foods = entries.filter((entry) => isFood(entry.item));
  if (foods.length === 0) {
    return null;
  }

  const ranked = [...foods].sort((a, b) => {
    const aHeal =
      typeof a.item?.healAmount === "number" ? a.item.healAmount : 0;
    const bHeal =
      typeof b.item?.healAmount === "number" ? b.item.healAmount : 0;
    if (aHeal !== bHeal) {
      return bHeal - aHeal;
    }
    return a.name.localeCompare(b.name);
  });
  return ranked[0] || null;
}

function resolveNpcCandidate(
  service: EmbeddedHyperiaService,
  targetPhrase: string,
): { npcId: string; name: string } | null {
  const allNpcs = service.getAllNPCPositions();
  if (allNpcs.length === 0) {
    return null;
  }

  const nearbyIds = new Set(
    service
      .getNearbyEntities()
      .filter((entity) => entity.type === "npc")
      .map((entity) => entity.id),
  );

  const candidates = allNpcs
    .filter((npc) => nearbyIds.size === 0 || nearbyIds.has(npc.id))
    .map((npc) => ({
      npcId: npc.npcId,
      name: npc.name,
      haystack: normalizeText(`${npc.npcId} ${npc.name}`),
      distance:
        service.getNearbyEntities().find((entity) => entity.id === npc.id)
          ?.distance ?? Number.MAX_SAFE_INTEGER,
    }));

  if (candidates.length === 0) {
    return null;
  }

  const tokens = tokenizeTarget(targetPhrase);
  const ranked = [...candidates].sort((a, b) => {
    const aCount = tokens.filter((token) => a.haystack.includes(token)).length;
    const bCount = tokens.filter((token) => b.haystack.includes(token)).length;
    if (aCount !== bCount) {
      return bCount - aCount;
    }
    return a.distance - b.distance;
  });

  const best = ranked[0] || null;
  if (!best) {
    return null;
  }
  if (tokens.length === 0) {
    return best;
  }
  const bestCount = tokens.filter((token) =>
    best.haystack.includes(token),
  ).length;
  return bestCount > 0 ? best : null;
}

function placeNameMatchesPhrase(
  placeNameNorm: string,
  phraseNorm: string,
): boolean {
  if (!placeNameNorm || !phraseNorm) {
    return false;
  }
  if (
    phraseNorm.includes(placeNameNorm) ||
    placeNameNorm.includes(phraseNorm)
  ) {
    return true;
  }
  const placeWords = placeNameNorm.split(" ").filter((w) => w.length >= 3);
  const phraseWords = phraseNorm.split(" ").filter((w) => w.length >= 3);
  for (const w of phraseWords) {
    if (placeNameNorm.includes(w)) {
      return true;
    }
  }
  for (const w of placeWords) {
    if (phraseNorm.includes(w)) {
      return true;
    }
  }
  return false;
}

export function findWorldMapMoveTarget(
  moveTargetPhrase: string,
  service: EmbeddedHyperiaService,
  playerPosition: [number, number, number] | null,
): [number, number, number] | null {
  type ServiceWithWorldMap = {
    getWorldMap?: () => Record<string, unknown>;
  };
  const worldMap = (service as unknown as ServiceWithWorldMap).getWorldMap?.();
  if (!worldMap) return null;
  const n = normalizeText(moveTargetPhrase);

  // World map positions are {x,y,z} objects — normalise to tuples.
  type XYZ = { x: number; y: number; z: number };
  function toTuple(
    pos: XYZ | [number, number, number],
  ): [number, number, number] {
    if (Array.isArray(pos)) return pos;
    return [pos.x, pos.y, pos.z];
  }

  function distSq(pos: XYZ | [number, number, number]): number {
    if (!playerPosition) return 0;
    const t = toTuple(pos);
    const dx = t[0] - playerPosition[0];
    const dz = t[2] - playerPosition[2];
    return dx * dx + dz * dz;
  }

  type WorldPlace = {
    type?: string;
    name?: string;
    position: XYZ | [number, number, number];
  };
  const stations = (worldMap.stations as WorldPlace[]) || [];
  const resources = (worldMap.resources as WorldPlace[]) || [];
  const towns = (worldMap.towns as WorldPlace[]) || [];
  const npcs = (worldMap.npcs as WorldPlace[]) || [];
  const pois =
    ((worldMap.pointsOfInterest || worldMap.pois) as WorldPlace[]) || [];
  const allNamedPlaces = [...towns, ...pois];

  const wantsSettlement =
    /\b(home|town|village|hub|safe\s*zone|safezone|starter|settlement)\b/.test(
      n,
    ) ||
    /\b(back to town|return to town|go to town|head home|go home|run home|walk home|return home|head back|go back)\b/.test(
      n,
    );

  if (wantsSettlement) {
    if (towns.length > 0) {
      return toTuple(
        towns.sort((a, b) => distSq(a.position) - distSq(b.position))[0]
          .position,
      );
    }
    if (allNamedPlaces.length > 0) {
      return toTuple(
        allNamedPlaces.sort(
          (a, b) => distSq(a.position) - distSq(b.position),
        )[0].position,
      );
    }
  }

  if (/\bbank\b/.test(n)) {
    // Check stations first, then NPCs (bank_clerk is an NPC, not a station)
    const bankStations = stations.filter((s) => /bank/i.test(s.type || ""));
    const bankNpcs = npcs.filter((s) => /bank/i.test(s.type || ""));
    const banks = [...bankStations, ...bankNpcs];
    if (banks.length > 0) {
      return toTuple(
        banks.sort((a, b) => distSq(a.position) - distSq(b.position))[0]
          .position,
      );
    }
  }
  for (const keyword of [
    "furnace",
    "anvil",
    "altar",
    "well",
    "chest",
    "range",
  ] as const) {
    if (n.includes(keyword)) {
      const matches = stations.filter((s) =>
        new RegExp(keyword, "i").test(s.type || s.name || ""),
      );
      if (matches.length > 0) {
        return toTuple(
          matches.sort((a, b) => distSq(a.position) - distSq(b.position))[0]
            .position,
        );
      }
    }
  }
  // "cooking" / "cook" → look for range or fire stations
  if (/\b(cook|cooking|range)\b/.test(n)) {
    const cookStations = stations.filter((s) =>
      /range|cook|fire/i.test(s.type || s.name || ""),
    );
    if (cookStations.length > 0) {
      return toTuple(
        cookStations.sort((a, b) => distSq(a.position) - distSq(b.position))[0]
          .position,
      );
    }
  }
  if (/\b(tree|log|wood|woodcut|chop)\b/.test(n)) {
    const trees = resources.filter((r) => /tree/i.test(r.type || ""));
    if (trees.length > 0) {
      return toTuple(
        trees.sort((a, b) => distSq(a.position) - distSq(b.position))[0]
          .position,
      );
    }
  }
  if (/\b(ore|mine|rock)\b/.test(n)) {
    const ores = resources.filter((r) => /ore|rock|mine/i.test(r.type || ""));
    if (ores.length > 0) {
      return toTuple(
        ores.sort((a, b) => distSq(a.position) - distSq(b.position))[0]
          .position,
      );
    }
  }
  if (/\b(fish|fishing|catch)\b/.test(n)) {
    const fishSpots = resources.filter((r) => /fish/i.test(r.type || ""));
    if (fishSpots.length > 0) {
      return toTuple(
        fishSpots.sort((a, b) => distSq(a.position) - distSq(b.position))[0]
          .position,
      );
    }
  }
  // Check NPC names and IDs (e.g., "go to shopkeeper", "forester_wilma")
  for (const npc of npcs) {
    const npcName = normalizeText(npc.name || "");
    const npcId = normalizeText((npc as { id?: string }).id || "");
    if (npcName && placeNameMatchesPhrase(npcName, n)) {
      return toTuple(npc.position);
    }
    if (npcId && placeNameMatchesPhrase(npcId, n)) {
      return toTuple(npc.position);
    }
  }
  for (const place of allNamedPlaces) {
    const placeName = normalizeText(place.name || "");
    if (placeName && placeNameMatchesPhrase(placeName, n)) {
      return toTuple(place.position);
    }
  }
  return null;
}

function findGlobalResourceTarget(
  service: EmbeddedHyperiaService,
  playerPosition: [number, number, number] | null,
  typeKeywords: string[],
): { id: string; position: [number, number, number]; name: string } | null {
  type WorldEntity = {
    entityType?: string;
    type?: string;
    name?: string;
    resourceType?: string;
    depleted?: boolean;
    dead?: boolean;
    isAvailable?: boolean;
    position?: { x: number; y: number; z: number };
    data?: {
      type?: string;
      name?: string;
      resourceType?: string;
      depleted?: boolean;
      dead?: boolean;
      isAvailable?: boolean;
      position?: { x: number; y: number; z: number };
    };
  };
  type ServiceWithWorld = {
    getWorld?: () => { entities?: { items?: Map<string, WorldEntity> } };
  };
  const world = (service as unknown as ServiceWithWorld).getWorld?.();
  const items = world?.entities?.items;
  if (!items) return null;
  const kws = typeKeywords.map((k) => k.toLowerCase());
  let bestId: string | null = null;
  let bestPos: [number, number, number] | null = null;
  let bestName = typeKeywords[0] || "resource";
  let bestDistSq = Number.MAX_SAFE_INTEGER;
  for (const [id, entity] of items) {
    const data = entity.data;
    const etype = (
      (data?.type || entity.type || entity.entityType) ??
      ""
    ).toLowerCase();
    const resType = (
      (data?.resourceType || entity.resourceType) ??
      ""
    ).toLowerCase();
    const resName = ((data?.name || entity.name) ?? "").toLowerCase();
    const isResource =
      etype === "resource" ||
      etype === "tree" ||
      etype === "rock" ||
      etype === "ore" ||
      etype === "fish" ||
      etype === "fishing";
    if (!isResource && !resType) continue;
    const haystack = `${etype} ${resType} ${resName}`;
    const matches = kws.some((kw) => haystack.includes(kw));
    if (!matches) continue;
    if (
      (data?.depleted ?? entity.depleted) === true ||
      (data?.dead ?? entity.dead) === true ||
      (data?.isAvailable ?? entity.isAvailable) === false
    )
      continue;
    const rawPos = entity.position || data?.position;
    if (!rawPos) continue;
    const px = typeof rawPos.x === "number" ? rawPos.x : null;
    const py = typeof rawPos.y === "number" ? rawPos.y : 0;
    const pz = typeof rawPos.z === "number" ? rawPos.z : null;
    if (px === null || pz === null) continue;
    const position: [number, number, number] = [px, py, pz];
    const name = resName || resType || typeKeywords[0] || "resource";
    const dx = playerPosition ? px - playerPosition[0] : 0;
    const dz = playerPosition ? pz - playerPosition[2] : 0;
    const ds = dx * dx + dz * dz;
    if (ds < bestDistSq) {
      bestId = id;
      bestPos = position;
      bestName = name;
      bestDistSq = ds;
    }
  }
  return bestId !== null && bestPos !== null
    ? { id: bestId, position: bestPos, name: bestName }
    : null;
}

function findGlobalMobTarget(
  service: EmbeddedHyperiaService,
  playerPosition: [number, number, number] | null,
  targetPhrase: string,
): { id: string; position: [number, number, number]; name: string } | null {
  type WorldEntity = {
    entityType?: string;
    type?: string;
    name?: string;
    mobType?: string;
    position?: { x: number; y: number; z: number };
  };
  type ServiceWithWorld = {
    getWorld?: () => { entities?: { items?: Map<string, WorldEntity> } };
  };
  const world = (service as unknown as ServiceWithWorld).getWorld?.();
  const items = world?.entities?.items;
  if (!items) return null;
  const tokens = tokenizeTarget(targetPhrase);
  let bestId: string | null = null;
  let bestPos: [number, number, number] | null = null;
  let bestName = "mob";
  let bestScore = -1;
  let bestDistSq = Number.MAX_SAFE_INTEGER;
  for (const [id, ent] of items) {
    const entityType = ent.entityType || ent.type || "";
    if (!/mob/i.test(entityType)) continue;
    const pos = ent.position;
    if (!pos) continue;
    const position: [number, number, number] = [pos.x, pos.y, pos.z];
    const name = ent.name || ent.mobType || "mob";
    const haystack = normalizeText(`${id} ${name} ${ent.mobType || ""}`);
    const matchCount =
      tokens.length > 0 ? tokens.filter((t) => haystack.includes(t)).length : 0;
    if (tokens.length > 0 && matchCount === 0) continue;
    const dx = playerPosition ? pos.x - playerPosition[0] : 0;
    const dz = playerPosition ? pos.z - playerPosition[2] : 0;
    const ds = dx * dx + dz * dz;
    if (
      matchCount > bestScore ||
      (matchCount === bestScore && ds < bestDistSq)
    ) {
      bestId = id;
      bestPos = position;
      bestName = name;
      bestScore = matchCount;
      bestDistSq = ds;
    }
  }
  return bestId !== null && bestPos !== null
    ? { id: bestId, position: bestPos, name: bestName }
    : null;
}

export function resolveDashboardIntent(
  content: string,
  service: EmbeddedHyperiaService,
): ResolvedDashboardIntent | null {
  const raw = normalizeText(content);
  if (!raw) {
    return null;
  }
  const normalized = stripLeadingCourtesyPhrases(raw);
  if (!normalized) {
    return null;
  }

  const nearbyEntities = service.getNearbyEntities();
  const playerPosition = service.getGameState()?.position || null;
  const playerYaw = service.getPlayerYaw();
  const inventoryEntries = getInventoryEntries(service);

  if (/^(stop|idle|wait|hold|cancel|stand down)\b/.test(normalized)) {
    return {
      command: "stop",
      data: {},
      text: "Stopping and clearing the current action.",
      thought: "Operator asked me to stop and clear my current action.",
    };
  }

  if (/\b(heal|eat|recover|use food|consume food)\b/.test(normalized)) {
    const item = resolveBestHealingItem(inventoryEntries);
    if (item) {
      return {
        command: "use",
        data: { itemId: item.itemId },
        text: `Using ${item.name} to heal now.`,
        thought: `Operator asked me to heal, so I selected ${item.name} from inventory.`,
        targetName: item.name,
      };
    }
  }

  if (/\b(equip|wear|wield)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "equip",
      "wear",
      "wield",
    ]);
    const item = resolveInventoryItem(inventoryEntries, targetPhrase, (entry) =>
      Boolean(
        entry.item?.equipable ||
        entry.item?.equipSlot ||
        entry.item?.weaponType ||
        entry.item?.is2h,
      ),
    );
    if (item) {
      return {
        command: "equip",
        data: { itemId: item.itemId },
        text: `Equipping ${item.name}.`,
        thought: `Operator requested equipment change. I resolved that to equipping ${item.name}.`,
        targetName: item.name,
      };
    }
  }

  if (/\b(use|drink|consume)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "use",
      "drink",
      "consume",
    ]);
    const item = resolveInventoryItem(inventoryEntries, targetPhrase);
    if (item) {
      return {
        command: "use",
        data: { itemId: item.itemId },
        text: `Using ${item.name}.`,
        thought: `Operator requested inventory use. I resolved that to using ${item.name}.`,
        targetName: item.name,
      };
    }
  }

  if (/\b(talk|speak|interact|trade)\b/.test(normalized)) {
    const interaction = /\btrade\b/.test(normalized) ? "trade" : "talk";
    const targetPhrase = extractTargetPhrase(normalized, [
      "talk to",
      "speak to",
      "interact with",
      "trade with",
      "talk",
      "speak",
      "interact",
      "trade",
    ]);
    const npc = resolveNpcCandidate(service, targetPhrase);
    if (npc) {
      return {
        command: "npcInteract",
        data: { npcId: npc.npcId, interaction },
        text:
          interaction === "trade"
            ? `Trading with ${npc.name}.`
            : `Talking to ${npc.name}.`,
        thought: `Operator requested NPC interaction. I resolved that to ${interaction} with ${npc.name}.`,
        targetName: npc.name,
      };
    }
  }

  if (
    /(kill|attack|fight|slay|hunt|murder|engage|destroy|waste|crush|beat|strike|slaughter)\b/.test(
      normalized,
    )
  ) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "kill",
      "attack",
      "fight",
      "slay",
      "hunt",
      "murder",
      "engage",
      "destroy",
      "waste",
      "crush",
      "beat",
      "strike",
      "slaughter",
    ]);
    const target = selectEntity(
      nearbyEntities,
      (entity) => entity.type === "mob",
      playerPosition,
      playerYaw,
      targetPhrase,
    );
    if (target) {
      const targetName = target.name || target.mobType || "target";
      return {
        command: "attack",
        data: { targetId: target.id },
        text: `Attacking ${targetName} now.`,
        thought: `Operator ordered combat. I resolved that to attacking ${targetName}${Number.isFinite(target.distance) ? ` (${Math.round(target.distance)}m away)` : ""}.`,
        targetName,
      };
    }
    const globalAttackTarget = findGlobalMobTarget(
      service,
      playerPosition,
      targetPhrase,
    );
    if (globalAttackTarget) {
      return {
        command: "attack",
        data: { targetId: globalAttackTarget.id },
        text: `Attacking ${globalAttackTarget.name}!`,
        thought: `No mobs nearby. Using walk-and-attack pipeline to engage ${globalAttackTarget.name}.`,
        targetName: globalAttackTarget.name,
      };
    }
  }

  if (
    /(chop|woodcut|cut|harvest|farm)\b/.test(normalized) ||
    /\b(get|gather)\s+(some\s+)?(logs?|wood)\b/.test(normalized)
  ) {
    const target = selectEntity(
      nearbyEntities,
      isTreeEntity,
      playerPosition,
      playerYaw,
      normalized,
    );
    if (target) {
      const targetName = target.name || "tree";
      return {
        command: "gather",
        data: { resourceId: target.id },
        text: `Heading to ${targetName} for woodcutting.`,
        thought: `Operator requested woodcutting. I resolved that to gathering from ${targetName}.`,
        targetName,
      };
    }
    const globalTree = findGlobalResourceTarget(service, playerPosition, [
      "tree",
      "oak",
      "willow",
      "maple",
      "yew",
    ]);
    if (globalTree) {
      return {
        command: "gather",
        data: { resourceId: globalTree.id },
        text: `Moving to ${globalTree.name} to chop.`,
        thought: `No trees nearby. Found ${globalTree.name} globally — gathering from it.`,
        targetName: globalTree.name,
      };
    }
    const treePos = findWorldMapMoveTarget("tree", service, playerPosition);
    if (treePos) {
      return {
        command: "move",
        data: { target: treePos, runMode: true },
        text: "Moving to nearest trees for woodcutting.",
        thought: "No trees found globally. Moving to tree area from world map.",
      };
    }
  }

  if (/\b(mine|mining)\b/.test(normalized)) {
    const target = selectEntity(
      nearbyEntities,
      isOreEntity,
      playerPosition,
      playerYaw,
      normalized,
    );
    if (target) {
      const targetName = target.name || "ore";
      return {
        command: "gather",
        data: { resourceId: target.id },
        text: `Mining ${targetName} now.`,
        thought: `Operator requested mining. I resolved that to gathering from ${targetName}.`,
        targetName,
      };
    }
    const globalOre = findGlobalResourceTarget(service, playerPosition, [
      "ore",
      "rock",
      "copper",
      "iron",
      "coal",
      "gold",
      "mithril",
    ]);
    if (globalOre) {
      return {
        command: "gather",
        data: { resourceId: globalOre.id },
        text: `Mining ${globalOre.name}.`,
        thought: `No ore nearby. Found ${globalOre.name} globally — gathering from it.`,
        targetName: globalOre.name,
      };
    }
    const orePos = findWorldMapMoveTarget(
      "ore mine rock",
      service,
      playerPosition,
    );
    if (orePos) {
      return {
        command: "move",
        data: { target: orePos, runMode: true },
        text: "Moving to nearest ore rocks for mining.",
        thought: "No ore found globally. Moving to mining area from world map.",
      };
    }
  }

  if (/\b(fish|fishing|catch)\b/.test(normalized)) {
    const target = selectEntity(
      nearbyEntities,
      isFishingEntity,
      playerPosition,
      playerYaw,
      normalized,
    );
    if (target) {
      const targetName = target.name || "fishing spot";
      return {
        command: "gather",
        data: { resourceId: target.id },
        text: `Moving to ${targetName} to fish.`,
        thought: `Operator requested fishing. I resolved that to gathering from ${targetName}.`,
        targetName,
      };
    }
    const globalFish = findGlobalResourceTarget(service, playerPosition, [
      "fish",
      "fishing",
      "shrimp",
      "trout",
      "salmon",
      "lobster",
    ]);
    if (globalFish) {
      return {
        command: "gather",
        data: { resourceId: globalFish.id },
        text: `Moving to ${globalFish.name} to fish.`,
        thought: `No fishing spots nearby. Found ${globalFish.name} globally — gathering from it.`,
        targetName: globalFish.name,
      };
    }
    const fishPos = findWorldMapMoveTarget("fishing", service, playerPosition);
    if (fishPos) {
      return {
        command: "move",
        data: { target: fishPos, runMode: true },
        text: "Moving to nearest fishing spot.",
        thought:
          "No fishing spots found globally. Moving to fishing area from world map.",
      };
    }
  }

  if (/(pick up|pickup|loot|grab|take|snag)\b/.test(normalized)) {
    const target = selectEntity(
      nearbyEntities,
      (entity) => entity.type === "item",
      playerPosition,
      playerYaw,
      normalized,
    );
    if (target) {
      const targetName = target.name || target.itemId || "item";
      return {
        command: "pickup",
        data: { itemId: target.id },
        text: `Picking up ${targetName}.`,
        thought: `Operator requested looting. I resolved that to picking up ${targetName}.`,
        targetName,
      };
    }
  }

  // ── Banking ──────────────────────────────────────────────────────────
  if (
    /\b(bank|deposit|store items|deposit all|bank all|put.*in.*bank)\b/.test(
      normalized,
    )
  ) {
    return {
      command: "bankDepositAll",
      data: {},
      text: "Depositing all items at the bank.",
      thought: "Operator wants me to bank items. Depositing all inventory.",
    };
  }

  // ── Cooking ─────────────────────────────────────────────────────────
  if (/\b(cook|roast|bake|grill|prepare food)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "cook",
      "roast",
      "bake",
      "grill",
    ]);
    const rawItem = resolveInventoryItem(
      inventoryEntries,
      targetPhrase || "raw",
    );
    if (rawItem) {
      return {
        command: "cook",
        data: { itemId: rawItem.itemId },
        text: `Cooking ${rawItem.name}.`,
        thought: `Operator requested cooking. I resolved that to cooking ${rawItem.name}.`,
        targetName: rawItem.name,
      };
    }
    // No specific item found, try any raw food
    const anyRaw = inventoryEntries.find((e) => e.itemId.startsWith("raw_"));
    if (anyRaw) {
      return {
        command: "cook",
        data: { itemId: anyRaw.itemId },
        text: `Cooking ${anyRaw.name}.`,
        thought: `Operator requested cooking. Found ${anyRaw.name} in inventory.`,
        targetName: anyRaw.name,
      };
    }
  }

  // ── Smelting ────────────────────────────────────────────────────────
  if (/\b(smelt|smelting|melt|refine)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "smelt",
      "smelting",
      "melt",
      "refine",
    ]);
    return {
      command: "smelt",
      data: { recipe: targetPhrase || "bronze_bar" },
      text: `Smelting ${targetPhrase || "bronze bars"}.`,
      thought: `Operator requested smelting. Recipe: ${targetPhrase || "bronze_bar"}.`,
    };
  }

  // ── Smithing ────────────────────────────────────────────────────────
  if (/\b(smith|smithing|forge|hammer)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "smith",
      "smithing",
      "forge",
      "hammer",
    ]);
    return {
      command: "smith",
      data: { recipe: targetPhrase || "bronze_dagger" },
      text: `Smithing ${targetPhrase || "bronze dagger"}.`,
      thought: `Operator requested smithing. Recipe: ${targetPhrase || "bronze_dagger"}.`,
    };
  }

  // ── Home teleport ───────────────────────────────────────────────────
  if (
    /\b(home|teleport home|tele home|go home|return home)\b/.test(normalized) &&
    !/\b(move|go to|walk)\b/.test(normalized)
  ) {
    return {
      command: "homeTeleport",
      data: {},
      text: "Teleporting home.",
      thought: "Operator requested home teleport.",
    };
  }

  // ── Drop items ──────────────────────────────────────────────────────
  if (/\b(drop|discard|throw away|toss)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "drop",
      "discard",
      "throw away",
      "toss",
    ]);
    const item = resolveInventoryItem(inventoryEntries, targetPhrase);
    if (item) {
      return {
        command: "drop",
        data: { itemId: item.itemId, quantity: 1 },
        text: `Dropping ${item.name}.`,
        thought: `Operator requested dropping ${item.name}.`,
        targetName: item.name,
      };
    }
  }

  // ── Unequip ─────────────────────────────────────────────────────────
  if (/\b(unequip|remove|take off)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "unequip",
      "remove",
      "take off",
    ]);
    const slotGuess = targetPhrase?.includes("weapon")
      ? "weapon"
      : targetPhrase?.includes("helm")
        ? "helmet"
        : targetPhrase?.includes("body") || targetPhrase?.includes("chest")
          ? "body"
          : targetPhrase?.includes("leg")
            ? "legs"
            : targetPhrase?.includes("shield")
              ? "shield"
              : targetPhrase?.includes("boot") || targetPhrase?.includes("feet")
                ? "boots"
                : targetPhrase?.includes("glove") ||
                    targetPhrase?.includes("hand")
                  ? "gloves"
                  : targetPhrase?.includes("cape") ||
                      targetPhrase?.includes("cloak")
                    ? "cape"
                    : "weapon";
    return {
      command: "unequip",
      data: { slot: slotGuess },
      text: `Unequipping ${slotGuess}.`,
      thought: `Operator requested unequipping ${slotGuess} slot.`,
    };
  }

  // ── Follow ──────────────────────────────────────────────────────────
  if (/\b(follow|tag along|come with|stick with)\b/.test(normalized)) {
    const targetPhrase = extractTargetPhrase(normalized, [
      "follow",
      "tag along",
      "come with",
      "stick with",
    ]);
    const target = selectEntity(
      nearbyEntities,
      (entity) => entity.type === "player" || entity.type === "mob",
      playerPosition,
      playerYaw,
      targetPhrase,
    );
    if (target) {
      return {
        command: "follow",
        data: { targetId: target.id },
        text: `Following ${target.name || "target"}.`,
        thought: `Operator requested following ${target.name || "target"}.`,
        targetName: target.name,
      };
    }
  }

  // ── Quest accept / begin ────────────────────────────────────────────
  if (
    /\b(begin|start|accept|take|do|try)(\s+the)?\s+quest\b|\bquest\b.*\b(begin|start|accept|take)\b/.test(
      normalized,
    )
  ) {
    // Extract quest name from the message
    const questPhrase = normalized
      .replace(
        /\b(begin|start|accept|take|do|try|please|can you|the|quest|a)\b/g,
        "",
      )
      .trim();

    const availableQuests = service.getAvailableQuests();
    const startable = availableQuests.filter(isStartableAgentQuest);

    if (startable.length > 0 && questPhrase) {
      const questTokens = questPhrase
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 3);

      let bestQuest: (typeof startable)[number] | null = null;
      let bestScore = 0;

      for (const q of startable) {
        const hay = q.name.toLowerCase();
        let score = 0;
        for (const token of questTokens) {
          if (hay.includes(token)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestQuest = q;
        }
      }

      if (bestQuest && bestScore > 0) {
        return {
          command: "questAccept",
          data: { questId: bestQuest.questId },
          text: `Accepting quest "${bestQuest.name}".`,
          thought: `Operator asked to begin quest. Matched "${bestQuest.name}" from available quests.`,
          targetName: bestQuest.name,
        };
      }
    }

    // If no quest name match, try the first available quest
    if (startable.length > 0) {
      const first = startable[0];
      return {
        command: "questAccept",
        data: { questId: first.questId },
        text: `Accepting quest "${first.name}".`,
        thought: `Operator asked to begin a quest. No specific match — picking first available: "${first.name}".`,
        targetName: first.name,
      };
    }
  }

  if (
    /\b(turn\s*in|hand\s*in)\b.*\bquest\b|\bquest\b.*\b(turn\s*in|hand\s*in)\b|\b(complete|finish)(\s+the)?\s+quest\b/.test(
      normalized,
    )
  ) {
    const questHubPos = findWorldMapMoveTarget(
      "town home settlement",
      service,
      playerPosition,
    );
    if (questHubPos) {
      return {
        command: "move",
        data: { target: questHubPos, runMode: true },
        text: "Heading to town to turn in the quest.",
        thought:
          "Operator wants to turn in or complete a quest; moving to the nearest settlement.",
      };
    }
  }

  const moveTargetPhrase = extractMoveTargetPhrase(normalized);
  if (moveTargetPhrase) {
    const worldPos = findWorldMapMoveTarget(
      moveTargetPhrase,
      service,
      playerPosition,
    );
    if (worldPos) {
      return {
        command: "move",
        data: { target: worldPos, runMode: true },
        text: `Moving toward ${moveTargetPhrase}.`,
        thought: `Operator asked to go to "${moveTargetPhrase}"; resolved via world map or settlement (avoids snapping to unrelated nearby mobs).`,
        targetName: moveTargetPhrase,
      };
    }

    const predicate = buildMoveEntityPredicate(moveTargetPhrase);
    const nMove = normalizeText(moveTargetPhrase);
    const resourceishMove =
      /\b(tree|trees|oak|maple|willow|yew|wood|log|ore|rock|fish|fishing|spot)\b/.test(
        nMove,
      );
    const mobishMove =
      /\b(goblin|bandit|skeleton|zombie|rat|spider|wolf|bear|troll|ogre|dragon|imp|monster|enemy|outlaw|brigand|guard|slayer)\b/.test(
        nMove,
      );
    const bankishMove = nMove.includes("bank");

    let target = selectEntity(
      nearbyEntities,
      predicate,
      playerPosition,
      playerYaw,
      moveTargetPhrase,
    );

    const moveTokens = tokenizeTarget(moveTargetPhrase);
    if (
      target &&
      moveTokens.length > 0 &&
      !bankishMove &&
      !resourceishMove &&
      !mobishMove
    ) {
      const hay = entityHaystack(target);
      const tokenHits = moveTokens.filter((t) => hay.includes(t)).length;
      if (tokenHits === 0) {
        target = null;
      }
    }

    if (target?.position) {
      const targetName = target.name || "destination";
      return {
        command: "move",
        data: { target: target.position, runMode: true },
        text: `Moving to ${targetName}.`,
        thought: `Operator requested movement. I resolved that to moving toward ${targetName}.`,
        targetName,
      };
    }
    const globalMobTarget = findGlobalMobTarget(
      service,
      playerPosition,
      moveTargetPhrase,
    );
    if (globalMobTarget) {
      return {
        command: "move",
        data: { target: globalMobTarget.position, runMode: true },
        text: `Moving toward ${globalMobTarget.name}.`,
        thought: `Operator requested moving toward ${globalMobTarget.name}; found it in the world.`,
        targetName: globalMobTarget.name,
      };
    }
  }

  const combatNegation =
    /\b(don'?t|do not|dont|never|avoid|stop|quit|no more)\s+(fight|attack|kill|slay)|\b(no fighting|stay passive|peace mode|do nothing)\b/.test(
      normalized,
    );
  const looseCombatIntent =
    !combatNegation &&
    /\b(fight|fighting|defend yourself|defend me|get aggressive|take action|do something useful|kill them|attack now|start attacking|help me fight|assist me|join (the |this )?fight|why (aren'?t|are not) you (fighting|attacking)|you should (fight|attack)|i need you to (fight|attack|kill)|listen(?: to me)?:?\s*(fight|attack|kill)|engage (the |those )?(enemy|enemies|mobs|monsters|hostiles))\b/.test(
      normalized,
    );
  if (looseCombatIntent) {
    const target = selectEntity(
      nearbyEntities,
      (entity) => entity.type === "mob",
      playerPosition,
      playerYaw,
      normalized,
    );
    if (target) {
      const targetName = target.name || target.mobType || "target";
      return {
        command: "attack",
        data: { targetId: target.id },
        text: `Engaging ${targetName} now.`,
        thought: `Operator pushed for combat; nearest hostile is ${targetName}${Number.isFinite(target.distance) ? ` (${Math.round(target.distance)}m)` : ""}.`,
        targetName,
      };
    }
    const globalLoose = findGlobalMobTarget(service, playerPosition, "");
    if (globalLoose) {
      return {
        command: "attack",
        data: { targetId: globalLoose.id },
        text: `Moving to engage ${globalLoose.name}.`,
        thought: `Operator wants combat but no mobs in nearby scan; walking to nearest mob ${globalLoose.name}.`,
        targetName: globalLoose.name,
      };
    }
  }

  return null;
}

function isGatherableDashboardEntity(entity: NearbyEntityData): boolean {
  return (
    entity.type === "resource" ||
    isTreeEntity(entity) ||
    isOreEntity(entity) ||
    isFishingEntity(entity)
  );
}

/**
 * Validate a JSON action object from dashboard LLM output and map it to a dispatcher intent.
 * Only accepts target/item ids that exist in current nearby scan or inventory.
 */
export function tryResolveDashboardLlmAction(
  parsed: Record<string, unknown>,
  service: EmbeddedHyperiaService,
): ResolvedDashboardIntent | null {
  const actionRaw = parsed.action;
  if (typeof actionRaw !== "string") {
    return null;
  }
  const action = actionRaw.trim().toLowerCase();
  if (action === "none" || action === "") {
    return null;
  }

  const targetId =
    typeof parsed.targetId === "string" ? parsed.targetId.trim() : "";
  const itemId = typeof parsed.itemId === "string" ? parsed.itemId.trim() : "";
  const interactionRaw = parsed.interaction;
  const interaction =
    typeof interactionRaw === "string" &&
    interactionRaw.toLowerCase() === "trade"
      ? "trade"
      : "talk";

  const nearby = service.getNearbyEntities();

  // Exact id match first, then fuzzy name match for LLMs that use display names
  const entityByTargetId = (typeFilter?: string): NearbyEntityData | null => {
    if (!targetId) return null;
    const exact = nearby.find((e) => e.id === targetId);
    if (exact) return exact;
    const lower = targetId.toLowerCase();
    return (
      nearby.find((e) => {
        if (typeFilter && e.type !== typeFilter) return false;
        const name = (e.name || "").toLowerCase();
        return name === lower || name.includes(lower) || lower.includes(name);
      }) ?? null
    );
  };

  if (action === "stop") {
    return {
      command: "stop",
      data: {},
      text: "Stopping and clearing the current action.",
      thought: "Dashboard LLM JSON: stop.",
    };
  }

  if (action === "move") {
    const entity = entityByTargetId();
    if (!entity?.position) {
      // Try resolving targetId as a map location for navigation
      if (targetId) {
        const gameState = service.getGameState();
        const playerPos = gameState?.position ?? null;
        const coords = findWorldMapMoveTarget(targetId, service, playerPos);
        if (coords) {
          return {
            command: "move",
            data: { target: coords, runMode: true, description: targetId },
            text: `Moving toward ${targetId}.`,
            thought: `Dashboard LLM JSON: move to map location ${targetId}.`,
            targetName: targetId,
          };
        }
      }
      return null;
    }
    const name = entity.name || "destination";
    return {
      command: "move",
      data: { target: entity.position, runMode: true },
      text: `Moving to ${name}.`,
      thought: `Dashboard LLM JSON: move to ${name} (${entity.id}).`,
      targetName: name,
    };
  }

  if (action === "attack") {
    const entity = entityByTargetId("mob");
    if (!entity) {
      return null;
    }
    const targetName = entity.name || entity.mobType || "target";
    return {
      command: "attack",
      data: { targetId: entity.id },
      text: `Attacking ${targetName} now.`,
      thought: `Dashboard LLM JSON: attack ${targetName}.`,
      targetName,
    };
  }

  if (action === "gather") {
    const entity = entityByTargetId("resource");
    if (!entity || !isGatherableDashboardEntity(entity)) {
      return null;
    }
    const targetName = entity.name || "resource";
    return {
      command: "gather",
      data: { resourceId: entity.id },
      text: `Gathering at ${targetName}.`,
      thought: `Dashboard LLM JSON: gather ${targetName}.`,
      targetName,
    };
  }

  if (action === "pickup") {
    const entity = entityByTargetId("item");
    if (!entity) {
      return null;
    }
    const targetName = entity.name || entity.itemId || "item";
    return {
      command: "pickup",
      data: { itemId: entity.id },
      text: `Picking up ${targetName}.`,
      thought: `Dashboard LLM JSON: pickup ${targetName}.`,
      targetName,
    };
  }

  if (action === "use") {
    if (!itemId) {
      return null;
    }
    const inv = service.getInventoryItems();
    if (!inv.some((s) => s.itemId === itemId)) {
      return null;
    }
    return {
      command: "use",
      data: { itemId },
      text: `Using ${itemId}.`,
      thought: `Dashboard LLM JSON: use ${itemId}.`,
      targetName: itemId,
    };
  }

  if (action === "equip") {
    if (!itemId) {
      return null;
    }
    const inv = service.getInventoryItems();
    if (!inv.some((s) => s.itemId === itemId)) {
      return null;
    }
    return {
      command: "equip",
      data: { itemId },
      text: `Equipping ${itemId}.`,
      thought: `Dashboard LLM JSON: equip ${itemId}.`,
      targetName: itemId,
    };
  }

  if (action === "npcinteract") {
    const entity = entityByTargetId("npc");
    if (!entity) {
      return null;
    }
    const row = service.getAllNPCPositions().find((n) => n.id === entity.id);
    if (!row) {
      return null;
    }
    return {
      command: "npcInteract",
      data: { npcId: row.npcId, interaction },
      text:
        interaction === "trade"
          ? `Trading with ${row.name}.`
          : `Talking to ${row.name}.`,
      thought: `Dashboard LLM JSON: NPC ${interaction} ${row.name}.`,
      targetName: row.name,
    };
  }

  if (action === "questaccept") {
    const questId =
      typeof parsed.questId === "string" ? parsed.questId.trim() : "";
    if (!questId) return null;
    const available = service.getAvailableQuests();
    if (
      !available.some((q) => q.questId === questId && isStartableAgentQuest(q))
    )
      return null;
    return {
      command: "questAccept",
      data: { questId },
      text: `Accepting quest ${questId}.`,
      thought: `Dashboard LLM JSON: accept quest ${questId}.`,
    };
  }

  if (action === "cook") {
    if (!itemId) return null;
    return {
      command: "cook",
      data: { itemId },
      text: `Cooking ${itemId}.`,
      thought: `Dashboard LLM JSON: cook ${itemId}.`,
    };
  }

  if (action === "smelt") {
    const recipe = itemId || targetId || "";
    if (!recipe) return null;
    return {
      command: "smelt",
      data: { recipe },
      text: `Smelting ${recipe}.`,
      thought: `Dashboard LLM JSON: smelt ${recipe}.`,
    };
  }

  if (action === "smith") {
    const recipe = itemId || targetId || "";
    if (!recipe) return null;
    return {
      command: "smith",
      data: { recipe },
      text: `Smithing ${recipe}.`,
      thought: `Dashboard LLM JSON: smith ${recipe}.`,
    };
  }

  if (
    action === "bank" ||
    action === "bankdepositall" ||
    action === "deposit"
  ) {
    return {
      command: "bankDepositAll",
      data: {},
      text: "Depositing all items at the bank.",
      thought: "Dashboard LLM JSON: bank deposit all.",
    };
  }

  if (action === "hometeleport" || action === "teleport") {
    return {
      command: "homeTeleport",
      data: {},
      text: "Teleporting home.",
      thought: "Dashboard LLM JSON: home teleport.",
    };
  }

  if (action === "drop") {
    if (!itemId) return null;
    return {
      command: "drop",
      data: { itemId, quantity: 1 },
      text: `Dropping ${itemId}.`,
      thought: `Dashboard LLM JSON: drop ${itemId}.`,
    };
  }

  if (action === "follow") {
    const entity = entityByTargetId();
    if (!entity) return null;
    return {
      command: "follow",
      data: { targetId: entity.id },
      text: `Following ${entity.name || "target"}.`,
      thought: `Dashboard LLM JSON: follow ${entity.name || entity.id}.`,
    };
  }

  return null;
}
