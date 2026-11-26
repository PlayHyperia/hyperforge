import type * as http from "node:http";
import type {
  PluginAppBridge,
  PluginAppBridgeLaunchContext,
  PluginAppBridgeRunContext,
  PluginAppTelemetryValue,
  PluginAppViewerAuthMessage,
} from "@elizaos/core";
import {
  collectHyperiaLaunchDiagnostics,
  ensureHyperiaRuntimeReady,
  prepareHyperiaAppLaunch,
  resolveHyperiaViewerAuthMessage,
  type HyperiaBridgeRuntimeLike,
  type HyperiaLaunchDiagnostic,
  type HyperiaViewerAuthMessage,
} from "./app-runtime.js";

const HYPERIA_APP_NAME = "@hyperforge/plugin-hyperia";
const HYPERIA_ROUTE_SLUG = "hyperia";
const HYPERIA_REQUEST_TIMEOUT_MS = 5_000;

type HyperiaAppSessionMode = "spectate-and-steer";
type HyperiaAppSessionFeature =
  "commands" | "telemetry" | "pause" | "resume" | "suggestions";

interface HyperiaAppViewer {
  url: string;
  embedParams?: Record<string, string>;
  postMessageAuth?: boolean;
  sandbox?: string;
}

interface HyperiaAppSession {
  mode: HyperiaAppSessionMode;
  features?: HyperiaAppSessionFeature[];
}

export interface HyperiaAppMeta {
  displayName: string;
  category?: string;
  launchType?: string;
  launchUrl?: string | null;
  icon?: string | null;
  capabilities?: string[];
  minPlayers?: number | null;
  maxPlayers?: number | null;
  runtimePlugin?: string;
  viewer?: HyperiaAppViewer;
  session?: HyperiaAppSession;
  bridgeExport?: string;
}

export interface HyperiaAppRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url?: URL;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<T | null>;
  json?: (res: http.ServerResponse, data: object, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  runtime?: unknown | null;
}

export type HyperiaLaunchSessionContext = PluginAppBridgeLaunchContext;

export type HyperiaRunSessionContext = PluginAppBridgeRunContext;

export interface HyperiaEmbeddedAgentRecord {
  agentId?: string;
  characterId?: string;
  name?: string;
  state?: string;
  entityId?: string | null;
  lastActivity?: number;
  startedAt?: number;
}

interface HyperiaEmbeddedAgentsResponse {
  success?: boolean;
  agents?: HyperiaEmbeddedAgentRecord[];
  count?: number;
  error?: string;
}

interface HyperiaGoalResponse {
  success?: boolean;
  goal?: {
    description?: string;
    type?: string;
  } | null;
  availableGoals?: HyperiaGoalCandidate[];
  goalsPaused?: boolean;
  message?: string;
  error?: string;
}

interface HyperiaGoalCandidate {
  id?: string;
  type?: string;
  description?: string;
  priority?: number;
  reason?: string;
}

interface HyperiaQuickActionsResponse {
  success?: boolean;
  quickCommands?: Array<{
    label?: string;
    command?: string;
    available?: boolean;
  }>;
  nearbyLocations?: Array<{ name?: string }>;
  availableGoals?: Array<{ description?: string; type?: string }>;
  playerPosition?: [number, number, number] | null;
  message?: string;
  error?: string;
}

interface HyperiaThoughtRecord {
  id?: string;
  type?: string;
  content?: string;
  timestamp?: number;
}

interface HyperiaThoughtsResponse {
  success?: boolean;
  thoughts?: HyperiaThoughtRecord[];
  count?: number;
  error?: string;
}

interface HyperiaAgentMappingResponse {
  success?: boolean;
  agentId?: string;
  characterId?: string;
  accountId?: string;
  agentName?: string;
  error?: string;
}

type HyperiaRequestResult<T> = {
  status: number;
  contentType: string | null;
  text: string;
  data: T | null;
};

type HyperiaSessionState = {
  sessionId: string;
  appName: string;
  mode: HyperiaAppSessionMode;
  status: string;
  displayName: string;
  agentId?: string;
  characterId?: string;
  followEntity?: string;
  canSendCommands: boolean;
  controls: Array<"pause" | "resume">;
  summary: string;
  goalLabel: string | null;
  suggestedPrompts: string[];
  recommendations: Array<{
    id: string;
    label: string;
    type?: string;
    reason?: string | null;
    priority?: number | null;
  }>;
  activity: Array<{
    id: string;
    type: string;
    message: string;
    timestamp?: number | null;
    severity?: "info" | "warning" | "error";
  }>;
  telemetry: Record<string, PluginAppTelemetryValue>;
};

type SessionRefreshResult =
  | { status: "ok"; session: HyperiaSessionState }
  | { status: "missing"; session: null }
  | { status: "unavailable"; session: null; error: Error };

type HyperiaSessionTarget =
  | { kind: "embedded"; agent: HyperiaEmbeddedAgentRecord }
  | {
      kind: "mapped";
      mapping: {
        agentId: string;
        characterId: string;
        accountId?: string;
        agentName?: string;
      };
    };

type HyperiaAppBridgeMethod =
  | "handleAppRoutes"
  | "prepareLaunch"
  | "resolveViewerAuthMessage"
  | "ensureRuntimeReady"
  | "collectLaunchDiagnostics"
  | "resolveLaunchSession"
  | "refreshRunSession";

export type HyperiaAppBridge = {
  [Method in HyperiaAppBridgeMethod]-?: NonNullable<PluginAppBridge[Method]>;
};

export const hyperiaAppMeta: HyperiaAppMeta = {
  displayName: "Hyperia",
  category: "game",
  launchType: "connect",
  launchUrl: "{HYPERIA_CLIENT_URL}",
  runtimePlugin: HYPERIA_APP_NAME,
  bridgeExport: "./app",
  capabilities: [
    "combat",
    "skills",
    "inventory",
    "banking",
    "social-chat",
    "exploration",
    "crafting",
  ],
  viewer: {
    url: "{HYPERIA_CLIENT_URL}",
    embedParams: {
      embedded: "true",
      mode: "spectator",
      surface: "agent-control",
      followEntity: "{HYPERIA_CHARACTER_ID}",
      hiddenUI: "chat,inventory,minimap,hotbar,stats",
      quality: "medium",
    },
    postMessageAuth: true,
    sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
  },
  session: {
    mode: "spectate-and-steer",
    features: ["commands", "telemetry", "pause", "resume", "suggestions"],
  },
};

function asRuntime(
  runtime: unknown | null | undefined,
): HyperiaBridgeRuntimeLike | null {
  return runtime && typeof runtime === "object"
    ? (runtime as HyperiaBridgeRuntimeLike)
    : null;
}

function readRuntimeSetting(
  runtime: HyperiaBridgeRuntimeLike | null | undefined,
  key: string,
): string | null {
  const value = runtime?.getSetting?.(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveHyperiaApiBaseUrl(
  runtime?: HyperiaBridgeRuntimeLike | null,
): string {
  const fromRuntime = readRuntimeSetting(runtime, "HYPERIA_API_URL");
  if (fromRuntime) {
    return fromRuntime.replace(/\/+$/, "");
  }

  const fromEnv = process.env.HYPERIA_API_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  return process.env.NODE_ENV === "production"
    ? "https://hyperia.gg"
    : "http://localhost:5555";
}

function resolveHyperiaClientUrl(
  runtime?: HyperiaBridgeRuntimeLike | null,
): string {
  const runtimeCandidates = [
    "HYPERIA_CLIENT_URL",
    "PUBLIC_APP_URL",
    "CLIENT_URL",
  ] as const;
  for (const key of runtimeCandidates) {
    const value = readRuntimeSetting(runtime, key);
    if (value) {
      return value.replace(/\/+$/, "");
    }
  }

  const envCandidates = [
    process.env.HYPERIA_CLIENT_URL,
    process.env.PUBLIC_APP_URL,
    process.env.CLIENT_URL,
  ];
  for (const value of envCandidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().replace(/\/+$/, "");
    }
  }

  return process.env.NODE_ENV === "production"
    ? "https://hyperia.gg"
    : "http://localhost:3333";
}

function resolveHyperiaAuthorizationHeader(
  runtime?: HyperiaBridgeRuntimeLike | null,
): string | null {
  const runtimeToken = readRuntimeSetting(runtime, "HYPERIA_AUTH_TOKEN");
  if (runtimeToken) {
    return /^Bearer\s+/i.test(runtimeToken)
      ? runtimeToken
      : `Bearer ${runtimeToken}`;
  }

  const envToken = process.env.HYPERIA_AUTH_TOKEN?.trim();
  if (!envToken) return null;
  return /^Bearer\s+/i.test(envToken) ? envToken : `Bearer ${envToken}`;
}

async function requestHyperia<T>(
  method: "GET" | "POST",
  targetPath: string,
  body?: unknown,
  search = "",
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaRequestResult<T>> {
  const upstreamUrl = new URL(targetPath, resolveHyperiaApiBaseUrl(runtime));
  upstreamUrl.search = search;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const authorization = resolveHyperiaAuthorizationHeader(runtime);
  if (authorization) {
    headers.Authorization = authorization;
  }

  const response = await fetch(upstreamUrl.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HYPERIA_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type");

  let data: T | null = null;
  if (contentType?.includes("application/json") && text.trim().length > 0) {
    data = JSON.parse(text) as T;
  }

  return {
    status: response.status,
    contentType,
    text,
    data,
  };
}

function sendUpstreamResult(
  ctx: HyperiaAppRouteContext,
  result: HyperiaRequestResult<unknown>,
): void {
  if (result.contentType) {
    ctx.res.setHeader("Content-Type", result.contentType);
  }
  ctx.res.statusCode = result.status;
  ctx.res.end(result.text);
}

function sendJson(
  ctx: HyperiaAppRouteContext,
  data: object,
  status = 200,
): void {
  if (ctx.json) {
    ctx.json(ctx.res, data, status);
    return;
  }
  ctx.res.setHeader("Content-Type", "application/json");
  ctx.res.statusCode = status;
  ctx.res.end(JSON.stringify(data));
}

function requireJsonData<T extends object>(
  result: HyperiaRequestResult<T>,
  label: string,
): T {
  if (result.status >= 400) {
    const detail =
      typeof result.data === "object" &&
      result.data !== null &&
      "error" in result.data &&
      typeof result.data.error === "string"
        ? result.data.error
        : result.text.trim();
    throw new Error(
      detail
        ? `${label} failed (${result.status}): ${detail}`
        : `${label} failed with status ${result.status}`,
    );
  }
  if (!result.data) {
    throw new Error(`${label} returned malformed JSON`);
  }
  return result.data;
}

async function listEmbeddedAgents(
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaEmbeddedAgentRecord[]> {
  const response = await requestHyperia<HyperiaEmbeddedAgentsResponse>(
    "GET",
    "/api/embedded-agents",
    undefined,
    "",
    runtime,
  );
  const data = requireJsonData(response, "Hyperia embedded agents request");
  return Array.isArray(data.agents) ? data.agents : [];
}

async function resolveSessionAgent(
  sessionId: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaEmbeddedAgentRecord | null> {
  const agents = await listEmbeddedAgents(runtime);
  for (const agent of agents) {
    if (
      agent.agentId === sessionId ||
      agent.characterId === sessionId ||
      agent.entityId === sessionId
    ) {
      return agent;
    }
  }
  return null;
}

async function resolveAgentMapping(
  agentId: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<{
  agentId: string;
  characterId: string;
  accountId?: string;
  agentName?: string;
} | null> {
  const response = await requestHyperia<HyperiaAgentMappingResponse>(
    "GET",
    `/api/agents/mapping/${encodeURIComponent(agentId)}`,
    undefined,
    "",
    runtime,
  );
  if (response.status === 404) {
    return null;
  }
  const data = requireJsonData(response, "Hyperia agent mapping request");
  if (
    typeof data.agentId !== "string" ||
    data.agentId.trim().length === 0 ||
    typeof data.characterId !== "string" ||
    data.characterId.trim().length === 0
  ) {
    throw new Error("Hyperia agent mapping response was malformed.");
  }
  return {
    agentId: data.agentId.trim(),
    characterId: data.characterId.trim(),
    accountId:
      typeof data.accountId === "string" && data.accountId.trim().length > 0
        ? data.accountId.trim()
        : undefined,
    agentName:
      typeof data.agentName === "string" && data.agentName.trim().length > 0
        ? data.agentName.trim()
        : undefined,
  };
}

function buildSessionControls(
  status: string,
  goalsPaused: boolean,
): Array<"pause" | "resume"> {
  if (goalsPaused || status === "paused") {
    return ["resume"];
  }
  if (status === "stopped" || status === "error") {
    return [];
  }
  return ["pause"];
}

function buildGoalLabel(
  goalResponse: HyperiaGoalResponse | null,
): string | null {
  const goal = goalResponse?.goal;
  if (goal?.description) return goal.description;
  if (goal?.type) return goal.type;
  if (goalResponse?.goalsPaused) return "Goals paused";
  return goalResponse?.message ?? null;
}

function buildSuggestedPrompts(
  quickActionsResponse: HyperiaQuickActionsResponse | null,
): string[] {
  return (quickActionsResponse?.quickCommands ?? [])
    .filter((command) => command.available !== false && command.command)
    .map((command) => command.command?.trim() ?? "")
    .filter((command) => command.length > 0)
    .slice(0, 6);
}

function buildSummary(
  status: string,
  goalLabel: string | null,
  agent: HyperiaEmbeddedAgentRecord,
): string {
  const normalizedStatus = status.replace(/_/g, " ");
  if (goalLabel) {
    return `${normalizedStatus}: ${goalLabel}`;
  }
  return agent.name ? `${normalizedStatus}: ${agent.name}` : normalizedStatus;
}

async function loadGoalState(
  agentId?: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaGoalResponse | null> {
  if (!agentId) return null;
  const response = await requestHyperia<HyperiaGoalResponse>(
    "GET",
    `/api/agents/${encodeURIComponent(agentId)}/goal`,
    undefined,
    "",
    runtime,
  );
  return requireJsonData(response, "Hyperia goal request");
}

async function loadQuickActionsState(
  agentId?: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaQuickActionsResponse | null> {
  if (!agentId) return null;
  const response = await requestHyperia<HyperiaQuickActionsResponse>(
    "GET",
    `/api/agents/${encodeURIComponent(agentId)}/quick-actions`,
    undefined,
    "",
    runtime,
  );
  return requireJsonData(response, "Hyperia quick actions request");
}

async function loadThoughtsState(
  agentId?: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaThoughtsResponse | null> {
  if (!agentId) return null;
  const response = await requestHyperia<HyperiaThoughtsResponse>(
    "GET",
    `/api/agents/${encodeURIComponent(agentId)}/thoughts`,
    undefined,
    "?limit=5",
    runtime,
  );
  if (response.status === 404 || response.status === 501) {
    return null;
  }
  return requireJsonData(response, "Hyperia thoughts request");
}

function normalizeRecentThoughts(
  thoughtsResponse: HyperiaThoughtsResponse | null,
): Array<{
  id: string;
  type: string;
  content: string;
  timestamp: number | null;
}> {
  return (thoughtsResponse?.thoughts ?? [])
    .map((thought, index) => {
      const content = thought.content?.trim() ?? "";
      if (content.length === 0) {
        return null;
      }
      return {
        id: thought.id?.trim() || `thought-${index}`,
        type: thought.type?.trim() || "note",
        content,
        timestamp:
          typeof thought.timestamp === "number" ? thought.timestamp : null,
      };
    })
    .filter(
      (
        thought,
      ): thought is {
        id: string;
        type: string;
        content: string;
        timestamp: number | null;
      } => thought !== null,
    )
    .slice(0, 5);
}

function normalizeRecommendedGoals(
  goalResponse: HyperiaGoalResponse | null,
): Array<{
  id: string;
  type: string;
  description: string;
  priority: number | null;
  reason: string | null;
}> {
  return (goalResponse?.availableGoals ?? [])
    .map((goal, index) => {
      const description = goal.description?.trim() ?? "";
      const type = goal.type?.trim() ?? "";
      if (description.length === 0 && type.length === 0) {
        return null;
      }
      return {
        id: goal.id?.trim() || `goal-${index}`,
        type: type || "goal",
        description: description || type,
        priority:
          typeof goal.priority === "number" ? Math.trunc(goal.priority) : null,
        reason: goal.reason?.trim() || null,
      };
    })
    .filter(
      (
        goal,
      ): goal is {
        id: string;
        type: string;
        description: string;
        priority: number | null;
        reason: string | null;
      } => goal !== null,
    )
    .slice(0, 5);
}

function buildSessionRecommendations(
  goalResponse: HyperiaGoalResponse | null,
): HyperiaSessionState["recommendations"] {
  return normalizeRecommendedGoals(goalResponse).map((goal) => ({
    id: goal.id,
    label: goal.description,
    type: goal.type,
    reason: goal.reason,
    priority: goal.priority,
  }));
}

function buildSessionActivity(
  thoughtsResponse: HyperiaThoughtsResponse | null,
): HyperiaSessionState["activity"] {
  return normalizeRecentThoughts(thoughtsResponse).map((thought) => ({
    id: thought.id,
    type: thought.type,
    message: thought.content,
    timestamp: thought.timestamp,
    severity:
      thought.type === "warning" || thought.type === "error"
        ? thought.type
        : "info",
  }));
}

function buildTelemetry(
  goalResponse: HyperiaGoalResponse | null,
  quickActionsResponse: HyperiaQuickActionsResponse | null,
  thoughtsResponse: HyperiaThoughtsResponse | null,
  extra: Record<string, PluginAppTelemetryValue>,
): Record<string, PluginAppTelemetryValue> {
  return {
    ...extra,
    nearbyLocationCount: quickActionsResponse?.nearbyLocations?.length ?? 0,
    availableGoalCount: goalResponse?.availableGoals?.length ?? 0,
    recommendedGoals: normalizeRecommendedGoals(goalResponse),
    recentThoughts: normalizeRecentThoughts(thoughtsResponse),
  };
}

function buildSessionState(
  sessionId: string,
  agent: HyperiaEmbeddedAgentRecord,
  goalResponse: HyperiaGoalResponse | null,
  quickActionsResponse: HyperiaQuickActionsResponse | null,
  thoughtsResponse: HyperiaThoughtsResponse | null,
): HyperiaSessionState {
  const goalsPaused = Boolean(goalResponse?.goalsPaused);
  const status = goalsPaused ? "paused" : agent.state || "unknown";
  const goalLabel = buildGoalLabel(goalResponse);

  return {
    sessionId,
    appName: HYPERIA_APP_NAME,
    mode: "spectate-and-steer",
    status,
    displayName: agent.name ?? "Hyperia",
    agentId: agent.agentId,
    characterId: agent.characterId,
    followEntity: agent.entityId ?? agent.characterId,
    canSendCommands: true,
    controls: buildSessionControls(status, goalsPaused),
    summary: buildSummary(status, goalLabel, agent),
    goalLabel,
    suggestedPrompts: buildSuggestedPrompts(quickActionsResponse),
    recommendations: buildSessionRecommendations(goalResponse),
    activity: buildSessionActivity(thoughtsResponse),
    telemetry: buildTelemetry(
      goalResponse,
      quickActionsResponse,
      thoughtsResponse,
      {
        goalsPaused,
        lastActivity: agent.lastActivity ?? null,
        startedAt: agent.startedAt ?? null,
      },
    ),
  };
}

function isMappedAgentConnected(
  quickActionsResponse: HyperiaQuickActionsResponse | null,
): boolean {
  if (Array.isArray(quickActionsResponse?.playerPosition)) {
    return true;
  }
  const message =
    typeof quickActionsResponse?.message === "string"
      ? quickActionsResponse.message.toLowerCase()
      : "";
  return (
    message.length === 0 ||
    (!message.includes("not connected") && !message.includes("not registered"))
  );
}

function buildMappedSessionState(
  sessionId: string,
  mapping: {
    agentId: string;
    characterId: string;
    accountId?: string;
    agentName?: string;
  },
  goalResponse: HyperiaGoalResponse | null,
  quickActionsResponse: HyperiaQuickActionsResponse | null,
  thoughtsResponse: HyperiaThoughtsResponse | null,
): HyperiaSessionState {
  const goalsPaused = Boolean(goalResponse?.goalsPaused);
  const connected = isMappedAgentConnected(quickActionsResponse);
  const status = connected
    ? goalsPaused
      ? "paused"
      : "running"
    : "connecting";
  const goalLabel = buildGoalLabel(goalResponse);
  const summary = connected
    ? buildSummary(status, goalLabel, {
        agentId: mapping.agentId,
        characterId: mapping.characterId,
        name: mapping.agentName,
        entityId: mapping.characterId,
        state: status,
      })
    : (quickActionsResponse?.message ??
      goalResponse?.message ??
      "Connecting session...");

  return {
    sessionId,
    appName: HYPERIA_APP_NAME,
    mode: "spectate-and-steer",
    status,
    displayName: mapping.agentName ?? "Hyperia",
    agentId: mapping.agentId,
    characterId: mapping.characterId,
    followEntity: mapping.characterId,
    canSendCommands: connected,
    controls: connected ? buildSessionControls(status, goalsPaused) : [],
    summary,
    goalLabel,
    suggestedPrompts: buildSuggestedPrompts(quickActionsResponse),
    recommendations: buildSessionRecommendations(goalResponse),
    activity: buildSessionActivity(thoughtsResponse),
    telemetry: buildTelemetry(
      goalResponse,
      quickActionsResponse,
      thoughtsResponse,
      {
        goalsPaused,
        lastActivity: null,
        startedAt: null,
        playerPosition: quickActionsResponse?.playerPosition ?? null,
      },
    ),
  };
}

async function resolveSessionTarget(
  sessionId: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaSessionTarget | null> {
  const embeddedAgent = await resolveSessionAgent(sessionId, runtime);
  if (embeddedAgent?.characterId) {
    return {
      kind: "embedded",
      agent: embeddedAgent,
    };
  }

  const mapping = await resolveAgentMapping(sessionId, runtime);
  if (!mapping) {
    return null;
  }

  return {
    kind: "mapped",
    mapping,
  };
}

async function loadSessionState(
  sessionId: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaSessionState | null> {
  const target = await resolveSessionTarget(sessionId, runtime);
  if (!target) return null;

  if (target.kind === "embedded") {
    const [goalResponse, quickActionsResponse, thoughtsResponse] =
      await Promise.all([
        loadGoalState(target.agent.agentId, runtime),
        loadQuickActionsState(target.agent.agentId, runtime),
        loadThoughtsState(target.agent.agentId, runtime),
      ]);

    return buildSessionState(
      sessionId,
      target.agent,
      goalResponse,
      quickActionsResponse,
      thoughtsResponse,
    );
  }

  const [goalResponse, quickActionsResponse, thoughtsResponse] =
    await Promise.all([
      loadGoalState(target.mapping.agentId, runtime),
      loadQuickActionsState(target.mapping.agentId, runtime),
      loadThoughtsState(target.mapping.agentId, runtime),
    ]);

  return buildMappedSessionState(
    sessionId,
    target.mapping,
    goalResponse,
    quickActionsResponse,
    thoughtsResponse,
  );
}

function normalizeIdentifier(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function collectLaunchSessionCandidates(
  ctx: HyperiaLaunchSessionContext,
): string[] {
  const candidates = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      candidates.add(trimmed);
    }
  };

  push(ctx.viewer?.authMessage?.agentId);
  push(ctx.viewer?.authMessage?.characterId);
  push(ctx.viewer?.authMessage?.followEntity);
  push(asRuntime(ctx.runtime)?.agentId);

  const runtimeCharacterId = asRuntime(ctx.runtime)?.getSetting?.(
    "HYPERIA_CHARACTER_ID",
  );
  if (typeof runtimeCharacterId === "string") {
    push(runtimeCharacterId);
  }

  return [...candidates];
}

function matchSessionByName(
  agents: HyperiaEmbeddedAgentRecord[],
  name: string,
): HyperiaEmbeddedAgentRecord | null {
  const normalizedName = normalizeIdentifier(name);
  if (!normalizedName) return null;
  const matches = agents.filter(
    (agent) => normalizeIdentifier(agent.name) === normalizedName,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function selectLaunchSessionAgent(
  ctx: HyperiaLaunchSessionContext,
): Promise<HyperiaEmbeddedAgentRecord | null> {
  const runtime = asRuntime(ctx.runtime);
  const agents = await listEmbeddedAgents(runtime);
  if (agents.length === 0) return null;

  const candidates = collectLaunchSessionCandidates(ctx);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeIdentifier(candidate);
    if (!normalizedCandidate) continue;
    const directMatch =
      agents.find(
        (agent) =>
          normalizeIdentifier(agent.agentId) === normalizedCandidate ||
          normalizeIdentifier(agent.characterId) === normalizedCandidate ||
          normalizeIdentifier(agent.entityId) === normalizedCandidate,
      ) ?? null;
    if (directMatch) {
      return directMatch;
    }
  }

  const runtimeCharacterName = runtime?.character?.name;
  if (typeof runtimeCharacterName === "string") {
    const nameMatch = matchSessionByName(agents, runtimeCharacterName);
    if (nameMatch) {
      return nameMatch;
    }
  }

  return agents.length === 1 ? (agents[0] ?? null) : null;
}

async function refreshSessionState(
  sessionId: string,
  runtime?: HyperiaBridgeRuntimeLike | null,
): Promise<SessionRefreshResult> {
  try {
    const session = await loadSessionState(sessionId, runtime);
    if (!session) {
      return { status: "missing", session: null };
    }
    return { status: "ok", session };
  } catch (error) {
    return {
      status: "unavailable",
      session: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function appendRefreshMessage(
  baseMessage: string,
  refresh: SessionRefreshResult,
): string {
  if (refresh.status === "missing") {
    return `${baseMessage} Session is no longer available.`;
  }
  if (refresh.status === "unavailable") {
    return `${baseMessage} Session state refresh unavailable: ${refresh.error.message}`;
  }
  return baseMessage;
}

async function handleSessionStateRoute(
  ctx: HyperiaAppRouteContext,
  sessionId: string,
): Promise<boolean> {
  const runtime = asRuntime(ctx.runtime);
  const sessionState = await loadSessionState(sessionId, runtime);
  if (!sessionState) {
    ctx.error(ctx.res, "Hyperia session not found", 404);
    return true;
  }
  sendJson(ctx, sessionState);
  return true;
}

async function handleSessionMessageRoute(
  ctx: HyperiaAppRouteContext,
  sessionId: string,
): Promise<boolean> {
  const runtime = asRuntime(ctx.runtime);
  const body = await ctx.readJsonBody<{ content?: string }>(ctx.req, ctx.res);
  if (!body) {
    ctx.error(ctx.res, "request body is required", 400);
    return true;
  }

  const content = body.content?.trim();
  if (!content) {
    ctx.error(ctx.res, "content is required", 400);
    return true;
  }

  const target = await resolveSessionTarget(sessionId, runtime);
  if (!target) {
    ctx.error(ctx.res, "Hyperia session not found", 404);
    return true;
  }

  const upstream =
    target.kind === "embedded"
      ? await requestHyperia<{ success?: boolean; message?: string }>(
          "POST",
          `/api/embedded-agents/${encodeURIComponent(target.agent.characterId!)}/command`,
          {
            command: "chat",
            data: { message: content },
          },
          "",
          runtime,
        )
      : await requestHyperia<{ success?: boolean; message?: string }>(
          "POST",
          `/api/agents/${encodeURIComponent(target.mapping.agentId)}/message`,
          {
            content,
          },
          "",
          runtime,
        );

  if (upstream.status >= 400) {
    sendUpstreamResult(ctx, upstream);
    return true;
  }

  const refresh = await refreshSessionState(sessionId, runtime);
  sendJson(ctx, {
    success: true,
    message: appendRefreshMessage(
      upstream.data?.message || "Message sent to Hyperia session.",
      refresh,
    ),
    session: refresh.session,
  });
  return true;
}

async function handleSessionControlRoute(
  ctx: HyperiaAppRouteContext,
  sessionId: string,
): Promise<boolean> {
  const runtime = asRuntime(ctx.runtime);
  const body = await ctx.readJsonBody<{ action?: string }>(ctx.req, ctx.res);
  if (!body) {
    ctx.error(ctx.res, "request body is required", 400);
    return true;
  }

  const action = body.action?.trim();
  if (action !== "pause" && action !== "resume") {
    ctx.error(ctx.res, "action must be pause or resume", 400);
    return true;
  }

  const target = await resolveSessionTarget(sessionId, runtime);
  if (!target) {
    ctx.error(ctx.res, "Hyperia session not found", 404);
    return true;
  }

  const upstream =
    target.kind === "embedded"
      ? await requestHyperia<{ success?: boolean; message?: string }>(
          "POST",
          `/api/embedded-agents/${encodeURIComponent(target.agent.characterId!)}/${action}`,
          undefined,
          "",
          runtime,
        )
      : await requestHyperia<{ success?: boolean; message?: string }>(
          "POST",
          `/api/agents/${encodeURIComponent(target.mapping.agentId)}/goal/${
            action === "pause" ? "stop" : "resume"
          }`,
          undefined,
          "",
          runtime,
        );

  if (upstream.status >= 400) {
    sendUpstreamResult(ctx, upstream);
    return true;
  }

  const refresh = await refreshSessionState(sessionId, runtime);
  sendJson(ctx, {
    success: true,
    message: appendRefreshMessage(
      upstream.data?.message ||
        (action === "pause"
          ? "Hyperia session paused."
          : "Hyperia session resumed."),
      refresh,
    ),
    session: refresh.session,
  });
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHyperiaAppRouteContext(
  value: unknown,
): value is HyperiaAppRouteContext {
  if (!isRecord(value) || !isRecord(value.req) || !isRecord(value.res)) {
    return false;
  }

  return (
    typeof value.method === "string" &&
    typeof value.pathname === "string" &&
    typeof value.readJsonBody === "function" &&
    typeof value.error === "function" &&
    typeof value.res.setHeader === "function" &&
    typeof value.res.end === "function" &&
    (value.json === undefined || typeof value.json === "function")
  );
}

function asHyperiaViewerAuthMessage(
  value: PluginAppViewerAuthMessage | undefined,
): HyperiaViewerAuthMessage | null {
  if (
    value?.type !== "HYPERIA_AUTH" ||
    typeof value.authToken !== "string" ||
    value.authToken.trim().length === 0
  ) {
    return null;
  }

  return {
    type: "HYPERIA_AUTH",
    authToken: value.authToken,
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.characterId === "string"
      ? { characterId: value.characterId }
      : {}),
    ...(typeof value.followEntity === "string"
      ? { followEntity: value.followEntity }
      : {}),
  };
}

export async function handleAppRoutes(ctx: unknown): Promise<boolean> {
  if (!isHyperiaAppRouteContext(ctx)) {
    return false;
  }

  const { req, res, method, pathname } = ctx;

  try {
    if (
      method === "GET" &&
      pathname === `/api/apps/${HYPERIA_ROUTE_SLUG}/embedded-agents`
    ) {
      const upstream = await requestHyperia<unknown>(
        "GET",
        "/api/embedded-agents",
        undefined,
        ctx.url?.search ?? "",
        asRuntime(ctx.runtime),
      );
      sendUpstreamResult(ctx, upstream);
      return true;
    }

    if (
      method === "POST" &&
      pathname === `/api/apps/${HYPERIA_ROUTE_SLUG}/embedded-agents`
    ) {
      const body = await ctx.readJsonBody<Record<string, unknown>>(req, res);
      if (!body) {
        ctx.error(ctx.res, "request body is required", 400);
        return true;
      }
      const upstream = await requestHyperia<unknown>(
        "POST",
        "/api/embedded-agents",
        body,
        "",
        asRuntime(ctx.runtime),
      );
      sendUpstreamResult(ctx, upstream);
      return true;
    }

    const sessionStateMatch = pathname.match(
      /^\/api\/apps\/hyperia\/session\/([^/]+)$/,
    );
    if (method === "GET" && sessionStateMatch?.[1]) {
      return handleSessionStateRoute(
        ctx,
        decodeURIComponent(sessionStateMatch[1]),
      );
    }

    const sessionMessageMatch = pathname.match(
      /^\/api\/apps\/hyperia\/session\/([^/]+)\/message$/,
    );
    if (method === "POST" && sessionMessageMatch?.[1]) {
      return handleSessionMessageRoute(
        ctx,
        decodeURIComponent(sessionMessageMatch[1]),
      );
    }

    const sessionControlMatch = pathname.match(
      /^\/api\/apps\/hyperia\/session\/([^/]+)\/control$/,
    );
    if (method === "POST" && sessionControlMatch?.[1]) {
      return handleSessionControlRoute(
        ctx,
        decodeURIComponent(sessionControlMatch[1]),
      );
    }

    if (method === "POST") {
      const embeddedActionMatch = pathname.match(
        /^\/api\/apps\/hyperia\/embedded-agents\/([^/]+)\/(start|stop|pause|resume|command)$/,
      );
      if (embeddedActionMatch) {
        const characterId = decodeURIComponent(embeddedActionMatch[1]);
        const action = embeddedActionMatch[2];
        const body =
          action === "command"
            ? await ctx.readJsonBody<Record<string, unknown>>(req, res)
            : undefined;
        if (action === "command" && !body) {
          ctx.error(ctx.res, "request body is required", 400);
          return true;
        }
        const upstream = await requestHyperia<unknown>(
          "POST",
          `/api/embedded-agents/${encodeURIComponent(characterId)}/${action}`,
          body,
          "",
          asRuntime(ctx.runtime),
        );
        sendUpstreamResult(ctx, upstream);
        return true;
      }

      const messageMatch = pathname.match(
        /^\/api\/apps\/hyperia\/agents\/([^/]+)\/message$/,
      );
      if (messageMatch) {
        return handleSessionMessageRoute(
          ctx,
          decodeURIComponent(messageMatch[1]),
        );
      }
    }

    if (method === "GET") {
      const goalMatch = pathname.match(
        /^\/api\/apps\/hyperia\/agents\/([^/]+)\/goal$/,
      );
      if (goalMatch) {
        const agentId = decodeURIComponent(goalMatch[1]);
        const upstream = await requestHyperia<unknown>(
          "GET",
          `/api/agents/${encodeURIComponent(agentId)}/goal`,
          undefined,
          "",
          asRuntime(ctx.runtime),
        );
        sendUpstreamResult(ctx, upstream);
        return true;
      }

      const quickActionsMatch = pathname.match(
        /^\/api\/apps\/hyperia\/agents\/([^/]+)\/quick-actions$/,
      );
      if (quickActionsMatch) {
        const agentId = decodeURIComponent(quickActionsMatch[1]);
        const upstream = await requestHyperia<unknown>(
          "GET",
          `/api/agents/${encodeURIComponent(agentId)}/quick-actions`,
          undefined,
          "",
          asRuntime(ctx.runtime),
        );
        sendUpstreamResult(ctx, upstream);
        return true;
      }

      const thoughtsMatch = pathname.match(
        /^\/api\/apps\/hyperia\/agents\/([^/]+)\/thoughts$/,
      );
      if (thoughtsMatch) {
        const agentId = decodeURIComponent(thoughtsMatch[1]);
        const upstream = await requestHyperia<unknown>(
          "GET",
          `/api/agents/${encodeURIComponent(agentId)}/thoughts`,
          undefined,
          ctx.url?.search ?? "",
          asRuntime(ctx.runtime),
        );
        sendUpstreamResult(ctx, upstream);
        return true;
      }
    }
  } catch (err) {
    ctx.error(
      ctx.res,
      err instanceof Error
        ? `Hyperia route failed: ${err.message}`
        : "Hyperia route failed",
      502,
    );
    return true;
  }

  return false;
}

export async function prepareLaunch(ctx: HyperiaLaunchSessionContext): Promise<{
  diagnostics?: HyperiaLaunchDiagnostic[];
  launchUrl?: string | null;
  viewer?: HyperiaAppViewer | null;
} | null> {
  const runtime = asRuntime(ctx.runtime);
  const diagnostics = await prepareHyperiaAppLaunch(runtime);
  const viewerUrl = resolveHyperiaClientUrl(runtime);

  return {
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    launchUrl: viewerUrl,
    viewer: {
      url: viewerUrl,
      embedParams: {
        embedded: "true",
        mode: "spectator",
        surface: "agent-control",
        hiddenUI: "chat,inventory,minimap,hotbar,stats",
        quality: "medium",
      },
      postMessageAuth: true,
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
  };
}

export async function resolveViewerAuthMessage(
  ctx: HyperiaLaunchSessionContext,
): Promise<HyperiaViewerAuthMessage | null> {
  return resolveHyperiaViewerAuthMessage(asRuntime(ctx.runtime));
}

export async function ensureRuntimeReady(
  ctx: HyperiaLaunchSessionContext,
): Promise<void> {
  await ensureHyperiaRuntimeReady(asRuntime(ctx.runtime));
}

export async function collectLaunchDiagnostics(
  ctx: HyperiaRunSessionContext,
): Promise<HyperiaLaunchDiagnostic[]> {
  const runtime = asRuntime(ctx.runtime);
  const session =
    ctx.session && typeof ctx.session === "object" ? ctx.session : null;
  return collectHyperiaLaunchDiagnostics({
    requestedViewerAuth: Boolean(ctx.viewer?.postMessageAuth),
    runtime,
    sessionFound: Boolean(session?.sessionId),
    viewerAuthMessage: asHyperiaViewerAuthMessage(ctx.viewer?.authMessage),
  });
}

export async function resolveLaunchSession(
  ctx: HyperiaLaunchSessionContext,
): Promise<HyperiaSessionState | null> {
  const runtime = asRuntime(ctx.runtime);
  const candidates = collectLaunchSessionCandidates(ctx);
  for (const candidate of candidates) {
    const session = await loadSessionState(candidate, runtime);
    if (session) {
      return session;
    }
  }

  const agent = await selectLaunchSessionAgent(ctx);
  if (!agent) {
    return null;
  }

  const sessionId =
    agent.agentId ?? agent.characterId ?? agent.entityId ?? null;
  return sessionId ? loadSessionState(sessionId, runtime) : null;
}

export async function refreshRunSession(
  ctx: HyperiaRunSessionContext,
): Promise<HyperiaSessionState | null> {
  const runtime = asRuntime(ctx.runtime);
  const sessionId = ctx.session?.sessionId?.trim();
  if (sessionId) {
    return loadSessionState(sessionId, runtime);
  }
  return resolveLaunchSession(ctx);
}

export const hyperiaAppBridge: HyperiaAppBridge = {
  handleAppRoutes,
  prepareLaunch,
  resolveViewerAuthMessage,
  ensureRuntimeReady,
  collectLaunchDiagnostics,
  resolveLaunchSession,
  refreshRunSession,
};
