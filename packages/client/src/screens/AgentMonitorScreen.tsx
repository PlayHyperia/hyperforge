/**
 * AgentMonitorScreen - Dashboard for monitoring and controlling duel agents.
 *
 * Layout: Top bar + duel status → sidebar (agent list, leaderboard, recent) | main detail panel.
 * Sharp corners, dense data, utilitarian.
 */

import { GAME_API_URL } from "@/lib/api-config";
import {
  formatDuelReason,
  formatTerminalMatchup,
  getCancellationPresentation,
  type DuelTerminalNotice,
} from "@/lib/duel-outcome-presentation";
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Swords,
  RefreshCw,
  Heart,
  Shield,
  Target,
  Clock,
  MapPin,
  Activity,
  Package,
  User,
  Pause,
  Play,
  Square,
  Trophy,
  Skull,
  ChevronRight,
  X,
  Zap,
  Settings,
  Sparkles,
  Compass,
  ClipboardList,
  MessageCircle,
  Gauge,
  TreePine,
  Pickaxe,
  Fish,
  Hammer,
  Navigation,
  Landmark,
  Flame,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import "./AgentMonitorScreen.css";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AgentGoal {
  type: string;
  description: string;
  progress: number;
  target: number;
  location?: string;
  targetSkill?: string;
  startedAt: number;
  locked: boolean;
}

interface AgentThought {
  id: string;
  type: string;
  content: string;
  timestamp: number;
  decisionPath?: "short-circuit" | "llm" | "scripted" | "planner" | "curiosity";
  providers?: string[];
  health?: {
    current: number;
    max: number;
    percent: number;
    urgency: "critical" | "warning" | "safe";
  };
}

interface PersonalityTraits {
  sociability: number;
  helpfulness: number;
  adventurousness: number;
  chattiness: number;
  aggression: number;
  patience: number;
}

interface DesireScore {
  goalType: string;
  score: number;
  breakdown: string;
}

interface AgentData {
  characterId: string;
  name: string;
  state: "initializing" | "running" | "paused" | "stopped" | "error";
  scriptedRole?: string;
  startedAt: number;
  lastActivity: number;
  error?: string;

  entityId: string | null;
  position: [number, number, number] | null;
  health: number;
  maxHealth: number;
  alive: boolean;
  inCombat: boolean;
  combatTarget: string | null;

  goal: AgentGoal | null;
  goalsPaused: boolean;
  personality: PersonalityTraits | null;
  desireScores: DesireScore[];

  skills: Record<string, { level: number; xp: number }>;
  combatLevel: number;
  totalLevel: number;

  inventory: Array<{ slot: number; itemId: string; quantity: number }>;
  inventoryUsed: number;
  inventoryMax: number;
  coins: number;
  equipment: Record<string, string>;

  recentThoughts: AgentThought[];

  quests: AgentQuest[];
  questPoints: number;

  bankItems: Array<{
    itemId: string;
    quantity: number;
    slot: number;
    tabIndex: number;
  }>;
}

interface AgentQuest {
  questId: string;
  name: string;
  status: string;
  currentStage?: string;
  stageDescription?: string;
  stageProgress?: Record<string, number>;
}

interface MonitorResponse {
  timestamp: number;
  agentCount: number;
  agents: AgentData[];
}

interface DuelContestant {
  characterId: string;
  name: string;
  combatLevel: number;
  currentHp: number;
  maxHp: number;
}

export interface DuelCycle {
  phase: string;
  contestants: DuelContestant[];
  startedAt: number;
  phaseStartedAt: number;
  winner: { characterId: string; name: string } | null;
  outcome: "win" | "draw" | null;
  winReason: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  characterId: string;
  name: string;
  provider: string;
  model: string;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  combatLevel: number;
  currentStreak: number;
}

export interface RecentDuelEntry {
  cycleId: string;
  duelId: string | null;
  finishedAt: number;
  outcome: "win" | "draw" | "cancelled";
  agent1Id: string | null;
  agent1Name: string | null;
  agent2Id: string | null;
  agent2Name: string | null;
  winnerId: string | null;
  winnerName: string | null;
  loserId: string | null;
  loserName: string | null;
  winReason: string | null;
  cancellationReason: string | null;
  damageAgent1: number;
  damageAgent2: number;
  damageWinner: number | null;
  damageLoser: number | null;
}

export interface DuelOperationalMetrics {
  emittedAt: number;
  historyWindow: {
    size: number;
    maxSize: number;
    wins: number;
    draws: number;
    completed: number;
    cancelled: number;
    terminal: number;
    completionRate: number | null;
    cancellationReasons: Record<string, number>;
  };
  engagement: {
    checks: number;
    retries: number;
    recoveries: number;
    failures: number;
    proximityCorrections: number;
    currentRetryCount: number;
  };
  current: {
    cycleId: string | null;
    phase: string;
    firstHitLatencyMs: number | null;
  };
}

export interface DuelStatusResponse {
  currentCycle: DuelCycle | null;
  terminalNotice: DuelTerminalNotice | null;
  leaderboard: LeaderboardEntry[];
  recentDuels: RecentDuelEntry[];
  operationalMetrics: DuelOperationalMetrics | null;
  streamHealth: { rtmpConnected: boolean; viewerCount: number } | null;
}

interface AgentKillEntry {
  npcId: string;
  name: string;
  count: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ADMIN_CODE_KEY = "hyperia_admin_code";
const POLL_INTERVAL_MS = 3000;

type DetailTab =
  | "overview"
  | "skills"
  | "inventory"
  | "quests"
  | "bank"
  | "kills"
  | "duels"
  | "actions"
  | "pipeline";

// ─── XP Table ───────────────────────────────────────────────────────────────

const XP_TABLE = [
  0, 83, 174, 276, 388, 512, 650, 801, 969, 1154, 1358, 1584, 1833, 2107, 2411,
  2746, 3115, 3523, 3973, 4470, 5018, 5624, 6291, 7028, 7842, 8740, 9730, 10824,
  12031, 13363, 14833, 16456, 18247, 20224, 22406, 24815, 27473, 30408, 33648,
  37224, 41171, 45529, 50339, 55649, 61512, 67983, 75127, 83014, 91721, 101333,
  111945, 123660, 136594, 150872, 166636, 184040, 203254, 224466, 247886,
  273742, 302288, 333804, 368599, 407015, 449428, 496254, 547953, 605032,
  668051, 737627, 814445, 899257, 992895, 1096278, 1210421, 1336443, 1475581,
  1629200, 1798808, 1986068, 2192818, 2421087, 2673114, 2951373, 3258594,
  3597792, 3972294, 4385776, 4842295, 5346332, 5902831, 6517253, 7195629,
  7944614, 8771558, 9684577, 10692629, 11805606, 13034431,
];

function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  if (level > 99) return XP_TABLE[98] ?? 13034431;
  return XP_TABLE[level - 1] ?? 0;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}m`;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 1000) return "now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  return `${Math.floor(diff / 3600000)}h`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function hpColor(ratio: number): string {
  if (ratio > 0.6) return "#22c55e";
  if (ratio > 0.3) return "#eab308";
  return "#ef4444";
}

function hpClass(ratio: number): string {
  if (ratio > 0.6) return "high";
  if (ratio > 0.3) return "mid";
  return "low";
}

function formatItemId(itemId: unknown): string {
  if (typeof itemId === "string") {
    return itemId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (itemId && typeof itemId === "object" && "itemId" in itemId) {
    return formatItemId((itemId as { itemId: unknown }).itemId);
  }
  return String(itemId ?? "Unknown");
}

// ─── Phase Colors ───────────────────────────────────────────────────────────

const PHASE_COLORS: Record<string, string> = {
  IDLE: "#55556a",
  ANNOUNCEMENT: "#3b82f6",
  COUNTDOWN: "#eab308",
  FIGHTING: "#ef4444",
  RESOLUTION: "#22c55e",
  CANCELLED: "#94a3b8",
};

// ─── Confirm Modal ─────────────────────────────────────────────────────────

function ConfirmModal({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-modal-backdrop" onClick={onCancel}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal-header">
          <span className="confirm-modal-title">{title}</span>
          <button className="confirm-modal-close" onClick={onCancel}>
            <X size={14} />
          </button>
        </div>
        <div className="confirm-modal-body">{message}</div>
        <div className="confirm-modal-actions">
          <button className="confirm-modal-btn cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="confirm-modal-btn confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Reset Progress Modal ──────────────────────────────────────────────────

type ResetPhase =
  | "confirm"
  | "disconnecting"
  | "wiping"
  | "reconnecting"
  | "verifying"
  | "done"
  | "error";

const RESET_STEPS: { phase: ResetPhase; label: string }[] = [
  { phase: "disconnecting", label: "Disconnecting agent" },
  { phase: "wiping", label: "Wiping account data" },
  { phase: "reconnecting", label: "Reconnecting agent" },
  { phase: "verifying", label: "Verifying fresh state" },
];

function ResetModal({
  agentName,
  phase,
  errorMessage,
  snapshotBefore,
  snapshotAfter,
  onClose,
}: {
  agentName: string;
  phase: ResetPhase;
  errorMessage: string | null;
  snapshotBefore: {
    totalLevel: number;
    coins: number;
    inventoryUsed: number;
  } | null;
  snapshotAfter: {
    totalLevel: number;
    coins: number;
    inventoryUsed: number;
  } | null;
  onClose: () => void;
}) {
  const isActive = phase !== "done" && phase !== "error" && phase !== "confirm";
  const activeIdx = RESET_STEPS.findIndex((s) => s.phase === phase);

  return (
    <div className="confirm-modal-backdrop">
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal-header">
          <span className="confirm-modal-title">
            {phase === "done"
              ? "Reset Complete"
              : phase === "error"
                ? "Reset Failed"
                : `Resetting ${agentName}`}
          </span>
          {(phase === "done" || phase === "error") && (
            <button className="confirm-modal-close" onClick={onClose}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="confirm-modal-body" style={{ padding: 0 }}>
          {/* Step list */}
          <div className="reset-steps">
            {RESET_STEPS.map((step, i) => {
              let status: "pending" | "active" | "done" | "error" = "pending";
              if (phase === "error" && i === activeIdx) status = "error";
              else if (phase === "done" || i < activeIdx) status = "done";
              else if (i === activeIdx && isActive) status = "active";
              return (
                <div className={`reset-step ${status}`} key={step.phase}>
                  <span className="reset-step-indicator">
                    {status === "done" && "\u2713"}
                    {status === "active" && <span className="reset-spinner" />}
                    {status === "error" && "\u2717"}
                    {status === "pending" && "\u2022"}
                  </span>
                  <span className="reset-step-label">{step.label}</span>
                </div>
              );
            })}
          </div>

          {/* Error message */}
          {phase === "error" && errorMessage && (
            <div className="reset-error-msg">{errorMessage}</div>
          )}

          {/* Before / After comparison */}
          {phase === "done" && snapshotBefore && snapshotAfter && (
            <div className="reset-diff">
              <div className="reset-diff-header">Verification</div>
              <div className="reset-diff-row">
                <span className="reset-diff-label">Total Level</span>
                <span className="reset-diff-before">
                  {snapshotBefore.totalLevel}
                </span>
                <span className="reset-diff-arrow">{"\u2192"}</span>
                <span className="reset-diff-after">
                  {snapshotAfter.totalLevel}
                </span>
              </div>
              <div className="reset-diff-row">
                <span className="reset-diff-label">Coins</span>
                <span className="reset-diff-before">
                  {snapshotBefore.coins.toLocaleString()}
                </span>
                <span className="reset-diff-arrow">{"\u2192"}</span>
                <span className="reset-diff-after">
                  {snapshotAfter.coins.toLocaleString()}
                </span>
              </div>
              <div className="reset-diff-row">
                <span className="reset-diff-label">Inventory</span>
                <span className="reset-diff-before">
                  {snapshotBefore.inventoryUsed} items
                </span>
                <span className="reset-diff-arrow">{"\u2192"}</span>
                <span className="reset-diff-after">
                  {snapshotAfter.inventoryUsed} items
                </span>
              </div>
            </div>
          )}
        </div>
        {(phase === "done" || phase === "error") && (
          <div className="confirm-modal-actions">
            <button className="confirm-modal-btn cancel" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Duel Status Bar ────────────────────────────────────────────────────────

export function DuelStatusBar({
  duelStatus,
}: {
  duelStatus: DuelStatusResponse | null;
}) {
  if (!duelStatus) return null;
  const { currentCycle, streamHealth, terminalNotice } = duelStatus;
  if (!currentCycle && !terminalNotice) return null;

  const phase = terminalNotice ? "CANCELLED" : (currentCycle?.phase ?? "IDLE");
  const color = PHASE_COLORS[phase] ?? "#55556a";
  const cancellationPresentation = terminalNotice
    ? getCancellationPresentation(terminalNotice.reason)
    : null;
  const phaseStartedAt =
    terminalNotice?.occurredAt ?? currentCycle?.phaseStartedAt;

  return (
    <div className="duel-status-bar">
      <span
        className="phase-tag"
        style={{ color, borderColor: `${color}60`, background: `${color}12` }}
      >
        {phase}
      </span>
      {terminalNotice ? (
        <span className="matchup">{formatTerminalMatchup(terminalNotice)}</span>
      ) : currentCycle && currentCycle.contestants.length === 2 ? (
        <span className="matchup">
          <strong>{currentCycle.contestants[0].name}</strong>
          {" (Cb "}
          {currentCycle.contestants[0].combatLevel}
          {") vs "}
          <strong>{currentCycle.contestants[1].name}</strong>
          {" (Cb "}
          {currentCycle.contestants[1].combatLevel}
          {")"}
          {phase === "FIGHTING" && (
            <>
              {" — "}
              {currentCycle.contestants[0].currentHp}/
              {currentCycle.contestants[0].maxHp}
              {" vs "}
              {currentCycle.contestants[1].currentHp}/
              {currentCycle.contestants[1].maxHp}
            </>
          )}
        </span>
      ) : null}
      {cancellationPresentation ? (
        <span className="cancelled-tag">
          {cancellationPresentation.title} — no winner declared
        </span>
      ) : currentCycle?.outcome === "draw" ? (
        <span className="draw-tag">Draw — no winner</span>
      ) : currentCycle?.winner ? (
        <span className="winner-tag">
          {currentCycle.winner.name} wins
          {currentCycle.winReason
            ? ` (${currentCycle.winReason.replace(/_/g, " ")})`
            : ""}
        </span>
      ) : null}
      {phaseStartedAt && (
        <span className="timer">
          {formatDuration(Date.now() - phaseStartedAt)}
        </span>
      )}
      {streamHealth && (
        <span className="stream-status">
          <span
            className={`stream-dot ${streamHealth.rtmpConnected ? "on" : "off"}`}
          />
          {streamHealth.rtmpConnected
            ? `${streamHealth.viewerCount} viewers`
            : "Offline"}
        </span>
      )}
    </div>
  );
}

// ─── Agent List Item (sidebar) ──────────────────────────────────────────────

function AgentListItem({
  agent,
  selected,
  onClick,
}: {
  agent: AgentData;
  selected: boolean;
  onClick: () => void;
}) {
  const hpRatio = agent.maxHealth > 0 ? agent.health / agent.maxHealth : 0;
  const hpPct = Math.round(hpRatio * 100);

  return (
    <div
      className={`agent-list-item ${selected ? "selected" : ""}`}
      onClick={onClick}
    >
      <div className="agent-list-row1">
        <span className="agent-list-name">
          <span className={`state-dot ${agent.state}`} />
          {agent.name}
        </span>
        <div className="agent-list-badges">
          {agent.goalsPaused && (
            <span className="agent-paused-badge">PAUSED</span>
          )}
        </div>
      </div>
      <div className="agent-list-row2">
        <span className="combat-tag">Cb {agent.combatLevel}</span>
        <span className={`hp-tag ${hpClass(hpRatio)}`}>
          {agent.health}/{agent.maxHealth} ({hpPct}%)
        </span>
      </div>
      <div className="agent-list-row3">
        {agent.inCombat ? (
          <span className="combat-target">
            Fighting {agent.combatTarget ?? "..."}
          </span>
        ) : agent.goal ? (
          <>
            <span className="goal-type">{agent.goal.type}</span>
            {" — "}
            {agent.goal.description}
          </>
        ) : (
          "Idle"
        )}
      </div>
    </div>
  );
}

// ─── Sidebar Leaderboard ────────────────────────────────────────────────────

function SidebarLeaderboard({
  leaderboard,
  selectedId,
}: {
  leaderboard: LeaderboardEntry[];
  selectedId: string | null;
}) {
  if (leaderboard.length === 0) return null;

  return (
    <div className="sidebar-section sidebar-leaderboard">
      <div className="sidebar-section-header">Leaderboard</div>
      <div className="sidebar-lb-row header">
        <span>#</span>
        <span>Name</span>
        <span>W</span>
        <span>D</span>
        <span>L</span>
        <span>%</span>
      </div>
      {leaderboard.map((e) => (
        <div
          className={`sidebar-lb-row ${e.characterId === selectedId ? "highlight" : ""}`}
          key={e.characterId}
        >
          <span className="rank">{e.rank}</span>
          <span className="name">{e.name}</span>
          <span className="wins">{e.wins}</span>
          <span className="draws">{e.draws ?? 0}</span>
          <span className="losses">{e.losses}</span>
          <span className="rate">{(e.winRate * 100).toFixed(0)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Sidebar Recent Duels ───────────────────────────────────────────────────

export function SidebarRecentDuels({ duels }: { duels: RecentDuelEntry[] }) {
  if (duels.length === 0) return null;

  return (
    <div className="sidebar-section sidebar-recent-duels">
      <div className="sidebar-section-header">Recent Duels</div>
      {duels.slice(0, 8).map((d) => (
        <div className="sidebar-duel-row" key={d.cycleId}>
          <span className="duel-names">
            {d.outcome === "cancelled" ? (
              <>
                <strong>No contest:</strong>{" "}
                {d.agent1Name ?? "Contestant unavailable"} vs{" "}
                {d.agent2Name ?? "Contestant unavailable"}
              </>
            ) : d.outcome === "draw" ? (
              <>
                <strong>{d.agent1Name}</strong> drew with {d.agent2Name}
              </>
            ) : (
              <>
                <strong>{d.winnerName}</strong> beat {d.loserName}
              </>
            )}
          </span>
          <span className="duel-time">{formatTimeAgo(d.finishedAt)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Overview Tab ───────────────────────────────────────────────────────────

function OverviewTab({ agent }: { agent: AgentData }) {
  const hpRatio = agent.maxHealth > 0 ? agent.health / agent.maxHealth : 0;
  const uptime = Date.now() - agent.startedAt;

  return (
    <div>
      <div className="overview-hp-section detail-hp-bar">
        <div className="hp-bar-track">
          <div
            className="hp-bar-fill"
            style={{ width: `${hpRatio * 100}%`, background: hpColor(hpRatio) }}
          />
        </div>
        <div className="hp-bar-label">
          <span>
            <Heart size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
            Health
          </span>
          <span className="hp-value">
            {agent.health} / {agent.maxHealth}
          </span>
        </div>
      </div>

      <div className="overview-grid">
        <div className="overview-row">
          <span className="overview-label">Status</span>
          <span className={`overview-value ${agent.alive ? "green" : "red"}`}>
            {agent.alive ? "Alive" : "Dead"}
          </span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Combat</span>
          <span className={`overview-value ${agent.inCombat ? "red" : ""}`}>
            {agent.inCombat
              ? agent.combatTarget
                ? `vs ${agent.combatTarget}`
                : "Yes"
              : "—"}
          </span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Cb Level</span>
          <span className="overview-value gold">{agent.combatLevel}</span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Total Lv</span>
          <span className="overview-value">{agent.totalLevel}</span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Position</span>
          <span className="overview-value">
            {agent.position
              ? `${agent.position[0].toFixed(0)}, ${agent.position[1].toFixed(0)}, ${agent.position[2].toFixed(0)}`
              : "—"}
          </span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Location</span>
          <span className="overview-value">{agent.goal?.location ?? "—"}</span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Uptime</span>
          <span className="overview-value">{formatDuration(uptime)}</span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Last Active</span>
          <span className="overview-value">
            {formatTimeAgo(agent.lastActivity)}
          </span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Goals</span>
          <span
            className={`overview-value ${agent.goalsPaused ? "gold" : "green"}`}
          >
            {agent.goalsPaused ? "Paused" : "Active"}
          </span>
        </div>
        <div className="overview-row">
          <span className="overview-label">Coins</span>
          <span className="overview-value gold">
            {agent.coins.toLocaleString()}
          </span>
        </div>
        {agent.goal && (
          <div className="overview-row full">
            <span className="overview-label">Goal</span>
            <span className="overview-value gold">
              {agent.goal.type}: {agent.goal.description}
              {agent.goal.target > 0 &&
                ` (${agent.goal.progress}/${agent.goal.target})`}
            </span>
          </div>
        )}
        {agent.scriptedRole && (
          <div className="overview-row full">
            <span className="overview-label">Role</span>
            <span
              className="overview-value"
              style={{ textTransform: "capitalize" }}
            >
              {agent.scriptedRole}
            </span>
          </div>
        )}
        {agent.error && (
          <div className="overview-row full">
            <span className="overview-label">Error</span>
            <span className="overview-value red">{agent.error}</span>
          </div>
        )}
      </div>

      {/* Personality Traits */}
      {agent.personality && (
        <div className="detail-section">
          <div className="detail-section-title">Personality</div>
          <div className="personality-grid">
            {(
              [
                ["Sociability", "sociability"],
                ["Helpfulness", "helpfulness"],
                ["Adventurousness", "adventurousness"],
                ["Chattiness", "chattiness"],
                ["Aggression", "aggression"],
                ["Patience", "patience"],
              ] as const
            ).map(([label, key]) => (
              <div key={key} className="personality-trait">
                <span className="trait-label">{label}</span>
                <div className="trait-bar-track">
                  <div
                    className="trait-bar-fill"
                    style={{
                      width: `${Math.round(agent.personality![key] * 100)}%`,
                    }}
                  />
                </div>
                <span className="trait-value">
                  {Math.round(agent.personality![key] * 100)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Desire Scores */}
      {agent.desireScores && agent.desireScores.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Desire Scores</div>
          <div className="desire-scores">
            {agent.desireScores
              .filter((d) => d.score > 0)
              .map((d) => (
                <div key={d.goalType} className="desire-row">
                  <span className="desire-type">
                    {d.goalType.replace(/_/g, " ")}
                  </span>
                  <div className="desire-bar-track">
                    <div
                      className="desire-bar-fill"
                      style={{
                        width: `${Math.min((d.score / 50) * 100, 100)}%`,
                        background:
                          d.score >= 30
                            ? "#4ade80"
                            : d.score >= 10
                              ? "#facc15"
                              : "#6b7280",
                      }}
                    />
                  </div>
                  <span className="desire-value" title={d.breakdown}>
                    {d.score}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Skills Tab ─────────────────────────────────────────────────────────────

function SkillsTab({ agent }: { agent: AgentData }) {
  const skillEntries = Object.entries(agent.skills);

  if (skillEntries.length === 0) {
    return <div className="action-log-empty">No skill data</div>;
  }

  return (
    <div className="skills-grid">
      {skillEntries.map(([name, skill]) => {
        const currentLevelXp = xpForLevel(skill.level);
        const nextLevelXp = xpForLevel(skill.level + 1);
        const xpRange = nextLevelXp - currentLevelXp;
        const xpProgress =
          xpRange > 0 ? (skill.xp - currentLevelXp) / xpRange : 1;

        return (
          <div className="skill-row" key={name}>
            <span className="skill-name">{name}</span>
            <span className="skill-level">{skill.level}</span>
            <div className="skill-xp-bar">
              <div className="skill-xp-track">
                <div
                  className="skill-xp-fill"
                  style={{
                    width: `${Math.max(0, Math.min(1, xpProgress)) * 100}%`,
                  }}
                />
              </div>
              <div className="skill-xp-text">
                {skill.xp.toLocaleString()} / {nextLevelXp.toLocaleString()}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Inventory Tab ──────────────────────────────────────────────────────────

function InventoryTab({ agent }: { agent: AgentData }) {
  const items = agent.inventory.filter((i) => i.itemId && i.itemId !== "");
  const equipmentEntries = Object.entries(agent.equipment);

  return (
    <div>
      <div className="inventory-section">
        <h3>
          <Package size={11} />
          Inventory
        </h3>
        {items.length > 0 ? (
          <div className="inventory-items">
            {items.map((item, i) => (
              <span className="inventory-item" key={i}>
                {formatItemId(item.itemId)}
                {item.quantity > 1 && (
                  <span className="item-qty"> x{item.quantity}</span>
                )}
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "#55556a" }}>Empty</div>
        )}
        <div className="inventory-summary">
          <span>
            {agent.inventoryUsed}/{agent.inventoryMax} slots
          </span>
          <span className="coins">{agent.coins.toLocaleString()} gp</span>
        </div>
      </div>

      <div className="inventory-section">
        <h3>
          <Shield size={11} />
          Equipment
        </h3>
        {equipmentEntries.length > 0 ? (
          <div className="equipment-grid">
            {equipmentEntries.map(([slot, itemId]) => (
              <div className="equipment-slot" key={slot}>
                <span className="equipment-slot-name">{slot}</span>
                <span className="equipment-slot-item">
                  {formatItemId(itemId)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "#55556a" }}>None</div>
        )}
      </div>
    </div>
  );
}

// ─── Quests Tab ─────────────────────────────────────────────────────────────

function QuestsTab({ agent }: { agent: AgentData }) {
  const inProgress = agent.quests.filter(
    (q) => q.status === "in_progress" || q.status === "ready_to_complete",
  );
  const completed = agent.quests.filter((q) => q.status === "completed");

  return (
    <div>
      <div className="inventory-summary" style={{ marginBottom: 12 }}>
        <span>
          {inProgress.length} active, {completed.length} completed
        </span>
        <span className="coins">{agent.questPoints} QP</span>
      </div>

      {inProgress.length > 0 && (
        <div className="inventory-section">
          <h3>Active</h3>
          <div className="quest-list">
            {inProgress.map((quest) => (
              <div className="quest-entry quest-active" key={quest.questId}>
                <div className="quest-header">
                  <span className="quest-name">{quest.name}</span>
                  <span
                    className={`quest-status quest-status-${quest.status.replace(/_/g, "-")}`}
                  >
                    {quest.status === "ready_to_complete"
                      ? "Ready"
                      : "In Progress"}
                  </span>
                </div>
                {quest.stageDescription && (
                  <div className="quest-stage">{quest.stageDescription}</div>
                )}
                {quest.stageProgress &&
                  Object.keys(quest.stageProgress).length > 0 && (
                    <div className="quest-progress-items">
                      {Object.entries(quest.stageProgress).map(
                        ([key, value]) => (
                          <span className="quest-progress-item" key={key}>
                            {formatItemId(key)}: {value}
                          </span>
                        ),
                      )}
                    </div>
                  )}
              </div>
            ))}
          </div>
        </div>
      )}

      {completed.length > 0 && (
        <div className="inventory-section">
          <h3>Completed</h3>
          <div className="quest-list">
            {completed.map((quest) => (
              <div className="quest-entry quest-completed" key={quest.questId}>
                <span className="quest-name">{quest.name}</span>
                <span className="quest-status quest-status-completed">
                  Done
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {agent.quests.length === 0 && (
        <div className="action-log-empty">No quests</div>
      )}
    </div>
  );
}

// ─── Bank Tab ───────────────────────────────────────────────────────────────

function BankTab({ agent }: { agent: AgentData }) {
  const items = agent.bankItems ?? [];

  if (items.length === 0) {
    return (
      <div className="action-log-empty">
        <Package size={20} style={{ opacity: 0.3 }} />
        <div>Empty bank</div>
      </div>
    );
  }

  const tabs = new Map<number, typeof items>();
  for (const item of items) {
    const tab = item.tabIndex ?? 0;
    if (!tabs.has(tab)) tabs.set(tab, []);
    tabs.get(tab)!.push(item);
  }
  const sortedTabs = Array.from(tabs.entries()).sort((a, b) => a[0] - b[0]);

  return (
    <div>
      <div className="inventory-summary" style={{ marginBottom: 12 }}>
        <span>{items.length} items</span>
        <span className="coins">{sortedTabs.length} tabs</span>
      </div>

      {sortedTabs.map(([tabIndex, tabItems]) => (
        <div className="inventory-section" key={tabIndex}>
          <h3>
            <Package size={11} />
            {tabIndex === 0 ? "Main" : `Tab ${tabIndex}`}
            <span className="bank-slot-count">{tabItems.length}</span>
          </h3>
          <div className="inventory-items">
            {tabItems.map((item, i) => (
              <span className="inventory-item" key={i}>
                {formatItemId(item.itemId)}
                {item.quantity > 1 && (
                  <span className="item-qty"> x{item.quantity}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Kills Tab ──────────────────────────────────────────────────────────────

function KillsTab({
  characterId,
  adminCode,
}: {
  characterId: string;
  adminCode: string;
}) {
  const [kills, setKills] = useState<AgentKillEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${GAME_API_URL}/admin/agents/${characterId}/kills`,
          { headers: { "x-admin-code": adminCode } },
        );
        if (res.ok) {
          const data = (await res.json()) as { kills: AgentKillEntry[] };
          if (!cancelled) setKills(data.kills);
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [characterId, adminCode]);

  if (loading) {
    return (
      <div className="action-log-empty">
        <RefreshCw size={16} className="spinning" style={{ opacity: 0.3 }} />
        <div>Loading...</div>
      </div>
    );
  }

  if (kills.length === 0) {
    return (
      <div className="action-log-empty">
        <Skull size={20} style={{ opacity: 0.3 }} />
        <div>No kills</div>
      </div>
    );
  }

  const totalKills = kills.reduce((sum, k) => sum + k.count, 0);

  return (
    <div>
      <div className="inventory-summary" style={{ marginBottom: 12 }}>
        <span>{kills.length} types</span>
        <span className="coins">{totalKills.toLocaleString()} total</span>
      </div>
      <div className="agent-kills-table">
        <div className="kills-header">
          <span>NPC</span>
          <span>Kills</span>
        </div>
        {kills.map((k) => (
          <div className="kills-row" key={k.npcId}>
            <span className="kills-npc-name">{k.name}</span>
            <span className="kills-count">{k.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Duels Tab ──────────────────────────────────────────────────────────────

export function DuelsTab({
  characterId,
  duelStatus,
}: {
  characterId: string;
  duelStatus: DuelStatusResponse | null;
}) {
  if (!duelStatus) {
    return (
      <div className="action-log-empty">
        <Swords size={20} style={{ opacity: 0.3 }} />
        <div>No duel data</div>
      </div>
    );
  }

  const agentEntry = duelStatus.leaderboard.find(
    (e) => e.characterId === characterId,
  );
  const agentDuels = duelStatus.recentDuels.filter(
    (d) => d.agent1Id === characterId || d.agent2Id === characterId,
  );

  return (
    <div>
      {duelStatus.operationalMetrics && (
        <section className="duel-ops-summary" aria-label="Duel operations">
          <div className="duel-ops-heading">
            Operations window
            <span>
              {duelStatus.operationalMetrics.historyWindow.size}/
              {duelStatus.operationalMetrics.historyWindow.maxSize} terminals
            </span>
          </div>
          <div className="overview-grid">
            <div className="overview-row">
              <span className="overview-label">Completion</span>
              <span className="overview-value green">
                {duelStatus.operationalMetrics.historyWindow.completionRate ==
                null
                  ? "—"
                  : `${(
                      duelStatus.operationalMetrics.historyWindow
                        .completionRate * 100
                    ).toFixed(1)}%`}
              </span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Resolved</span>
              <span className="overview-value">
                {duelStatus.operationalMetrics.historyWindow.completed}
              </span>
            </div>
            <div className="overview-row">
              <span className="overview-label">No contests</span>
              <span className="overview-value red">
                {duelStatus.operationalMetrics.historyWindow.cancelled}
              </span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Engagement retries</span>
              <span className="overview-value">
                {duelStatus.operationalMetrics.engagement.retries}
              </span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Retry recoveries</span>
              <span className="overview-value green">
                {duelStatus.operationalMetrics.engagement.recoveries}
              </span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Engagement failures</span>
              <span className="overview-value red">
                {duelStatus.operationalMetrics.engagement.failures}
              </span>
            </div>
          </div>
          {Object.keys(
            duelStatus.operationalMetrics.historyWindow.cancellationReasons,
          ).length > 0 && (
            <div className="duel-ops-reasons">
              {Object.entries(
                duelStatus.operationalMetrics.historyWindow.cancellationReasons,
              )
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([reason, count]) => (
                  <span key={reason}>
                    {formatDuelReason(reason)}: {count}
                  </span>
                ))}
            </div>
          )}
        </section>
      )}

      {agentEntry ? (
        <div className="agent-duel-stats">
          <div className="overview-grid">
            <div className="overview-row">
              <span className="overview-label">Rank</span>
              <span className="overview-value gold">#{agentEntry.rank}</span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Win Rate</span>
              <span className="overview-value">
                {(agentEntry.winRate * 100).toFixed(0)}%
              </span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Wins</span>
              <span className="overview-value green">{agentEntry.wins}</span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Draws</span>
              <span className="overview-value draw">
                {agentEntry.draws ?? 0}
              </span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Losses</span>
              <span className="overview-value red">{agentEntry.losses}</span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Streak</span>
              <span className="overview-value">{agentEntry.currentStreak}</span>
            </div>
            <div className="overview-row">
              <span className="overview-label">Total</span>
              <span className="overview-value">
                {agentEntry.wins + (agentEntry.draws ?? 0) + agentEntry.losses}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "#55556a", marginBottom: 12 }}>
          No duel record
        </div>
      )}

      {agentDuels.length > 0 && (
        <div className="inventory-section" style={{ marginTop: 12 }}>
          <h3>Recent Duels</h3>
          <div className="duel-recent-list">
            {agentDuels.slice(0, 10).map((d) => {
              const drew = d.outcome === "draw";
              const cancelled = d.outcome === "cancelled";
              const won = d.winnerId === characterId;
              const opponentName =
                (d.agent1Id === characterId ? d.agent2Name : d.agent1Name) ??
                "Contestant unavailable";
              return (
                <div
                  className={`duel-recent-entry ${cancelled ? "cancelled" : drew ? "draw" : won ? "won" : "lost"}`}
                  key={d.cycleId}
                >
                  <span
                    className={`duel-result ${cancelled ? "cancelled" : drew ? "draw" : won ? "win" : "loss"}`}
                  >
                    {cancelled ? "C" : drew ? "D" : won ? "W" : "L"}
                  </span>
                  <span className="duel-opponent">vs {opponentName}</span>
                  <span className="duel-reason">
                    {formatDuelReason(
                      cancelled ? d.cancellationReason : d.winReason,
                    )}
                  </span>
                  <span className="duel-time">
                    {formatTimeAgo(d.finishedAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Action Log Tab ─────────────────────────────────────────────────────────

function ActionLogTab({ agent }: { agent: AgentData }) {
  const [filter, setFilter] = useState<"all" | "actions" | "thoughts">("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const filtered = agent.recentThoughts.filter((t) => {
    if (filter === "actions") return t.type === "action";
    if (filter === "thoughts") return t.type !== "action";
    return true;
  });

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (agent.recentThoughts.length === 0) {
    return (
      <div className="action-log-empty">
        <Activity size={20} style={{ opacity: 0.3 }} />
        <div>No activity</div>
      </div>
    );
  }

  return (
    <div>
      <div className="action-log-filters">
        {(["all", "actions", "thoughts"] as const).map((f) => (
          <button
            key={f}
            className={`action-log-filter ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "actions" ? "Actions" : "Thoughts"}
          </button>
        ))}
      </div>
      <div className="action-log">
        {filtered.map((thought) => {
          const expanded = expandedIds.has(thought.id);
          return (
            <div
              className={`action-log-entry ${thought.type === "action" ? "action-entry" : ""} ${expanded ? "expanded" : ""}`}
              key={thought.id}
              onClick={() => toggleExpand(thought.id)}
            >
              <span className="action-log-time">
                {formatTime(thought.timestamp)}
              </span>
              <span className={`action-log-type type-${thought.type}`}>
                {thought.type}
              </span>
              {thought.decisionPath && (
                <span
                  className={`decision-path-badge dp-${thought.decisionPath}`}
                >
                  {thought.decisionPath === "short-circuit"
                    ? "SC"
                    : thought.decisionPath === "llm"
                      ? "LLM"
                      : thought.decisionPath === "planner"
                        ? "PLAN"
                        : thought.decisionPath === "curiosity"
                          ? "CURIOUS"
                          : "SCRIPT"}
                </span>
              )}
              <ChevronRight
                size={12}
                className={`action-log-chevron ${expanded ? "open" : ""}`}
              />
              <span
                className={`action-log-content ${expanded ? "expanded" : ""}`}
              >
                {thought.content}
              </span>
              {expanded &&
                thought.providers &&
                thought.decisionPath === "llm" && (
                  <div className="provider-chips">
                    {thought.providers.map((p) => (
                      <span key={p} className="provider-chip">
                        {p}
                      </span>
                    ))}
                  </div>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Pipeline Tab (React Flow) ─────────────────────────────────────────────

import {
  ReactFlow,
  Handle,
  Position,
  BaseEdge,
  getSmoothStepPath,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type DecisionPath =
  "short-circuit" | "llm" | "planner" | "curiosity" | "scripted";

const PATH_COLORS: Record<DecisionPath, string> = {
  "short-circuit": "#3b82f6",
  llm: "#a855f7",
  planner: "#22c55e",
  curiosity: "#f97316",
  scripted: "#6b7280",
};

const PATH_CSS_SUFFIX: Record<DecisionPath, string> = {
  "short-circuit": "sc",
  llm: "llm",
  planner: "planner",
  curiosity: "curiosity",
  scripted: "scripted",
};

const ACTIVE_NODES: Record<DecisionPath, string[]> = {
  "short-circuit": ["survival", "short-circuit", "action"],
  llm: ["survival", "providers", "evaluators", "llm", "action"],
  planner: ["personality", "planner", "goal-selection"],
  curiosity: ["curiosity", "action"],
  scripted: ["survival"],
};

const ACTIVE_CONNECTORS: Record<DecisionPath, string[]> = {
  "short-circuit": ["survival→short-circuit", "short-circuit→action"],
  llm: [
    "survival→providers",
    "providers→evaluators",
    "evaluators→llm",
    "llm→action",
  ],
  planner: ["personality→planner", "planner→goal-selection"],
  curiosity: ["curiosity→action"],
  scripted: [],
};

// Node layout — strict 5-column × 3-row grid:
//
//   Col 0         Col 1           Col 2          Col 3         Col 4
//   ─────         ─────           ─────          ─────         ─────
//   [Social]      [Short-Circuit] ─────────────────────────► [Action]    Row 0
//   [Survival] ──►[Providers] ──► [Evaluators] ──► [LLM] ──────► ▲      Row 1
//   [Personality]►[Planner] ────► [Goal Select] ──────────────────┤      Row 2
//                                                  [Curiosity] ──►┘
//
// Columns: x = 0, 230, 460, 690, 920
// Rows:    y = 0, 160, 320

const PIPELINE_NODE_CONFIGS = [
  { id: "social", label: "Social Impulse", x: 0, y: 0 },
  { id: "short-circuit", label: "Short-Circuit", x: 230, y: 0 },
  { id: "action", label: "Action Executor", x: 920, y: 0 },
  { id: "survival", label: "Survival Check", x: 0, y: 160 },
  { id: "providers", label: "Providers", x: 230, y: 160 },
  { id: "evaluators", label: "Evaluators", x: 460, y: 160 },
  { id: "llm", label: "LLM Reasoning", x: 690, y: 160 },
  { id: "curiosity", label: "Curiosity", x: 920, y: 160 },
  { id: "personality", label: "Personality", x: 0, y: 320 },
  { id: "planner", label: "Goal Planner", x: 230, y: 320 },
  { id: "goal-selection", label: "Goal Selection", x: 460, y: 320 },
] as const;

const PIPELINE_EDGE_CONFIGS = [
  {
    id: "e-social-action",
    source: "social",
    target: "action",
    sourceHandle: undefined as string | undefined,
    targetHandle: undefined as string | undefined,
  },
  {
    id: "e-surv-sc",
    source: "survival",
    target: "short-circuit",
    sourceHandle: "top" as string | undefined,
    targetHandle: undefined as string | undefined,
  },
  {
    id: "e-surv-prov",
    source: "survival",
    target: "providers",
    sourceHandle: "right" as string | undefined,
    targetHandle: undefined,
  },
  {
    id: "e-sc-action",
    source: "short-circuit",
    target: "action",
    sourceHandle: undefined,
    targetHandle: undefined,
  },
  {
    id: "e-prov-eval",
    source: "providers",
    target: "evaluators",
    sourceHandle: undefined,
    targetHandle: undefined,
  },
  {
    id: "e-eval-llm",
    source: "evaluators",
    target: "llm",
    sourceHandle: undefined,
    targetHandle: undefined,
  },
  {
    id: "e-llm-action",
    source: "llm",
    target: "action",
    sourceHandle: undefined,
    targetHandle: "bottom" as string | undefined,
  },
  {
    id: "e-pers-plan",
    source: "personality",
    target: "planner",
    sourceHandle: undefined,
    targetHandle: undefined,
  },
  {
    id: "e-plan-goal",
    source: "planner",
    target: "goal-selection",
    sourceHandle: undefined,
    targetHandle: undefined,
  },
  {
    id: "e-goal-eval",
    source: "goal-selection",
    target: "evaluators",
    sourceHandle: undefined,
    targetHandle: "bottom" as string | undefined,
  },
  {
    id: "e-curi-action",
    source: "curiosity",
    target: "action",
    sourceHandle: undefined,
    targetHandle: "bottom" as string | undefined,
  },
];

const CONN_KEY_MAP: Record<string, string> = {
  "e-social-action": "social→action",
  "e-surv-sc": "survival→short-circuit",
  "e-surv-prov": "survival→providers",
  "e-sc-action": "short-circuit→action",
  "e-prov-eval": "providers→evaluators",
  "e-eval-llm": "evaluators→llm",
  "e-llm-action": "llm→action",
  "e-pers-plan": "personality→planner",
  "e-plan-goal": "planner→goal-selection",
  "e-goal-eval": "goal-selection→evaluators",
  "e-curi-action": "curiosity→action",
};

const NODE_ROLES: Record<string, "entry" | "output"> = {
  survival: "entry",
  action: "output",
};

const PATH_DESCRIPTIONS: Record<DecisionPath, string> = {
  "short-circuit": "Fast reflexive response",
  llm: "Full LLM reasoning chain",
  planner: "Goal planning & desire scoring",
  curiosity: "Exploration-driven action",
  scripted: "Scripted behavior fallback",
};

const DECISION_PATH_ORDER: DecisionPath[] = [
  "short-circuit",
  "llm",
  "planner",
  "curiosity",
  "scripted",
];

const RF_PRO_OPTIONS = { hideAttribution: true };
const RF_FIT_VIEW_OPTIONS = { padding: 0.15 };

// ─── Action Category Visuals ──────────────────────────────────────────────
// Maps action names → visual category (color, icon, short label)

type ActionCategory = {
  color: string;
  icon: LucideIcon;
  label: string;
};

const ACTION_CATEGORIES: Record<string, ActionCategory> = {
  // Navigation
  EXPLORE: { color: "#38bdf8", icon: Compass, label: "Exploring" },
  NAVIGATE_TO: { color: "#38bdf8", icon: Navigation, label: "Navigating" },
  MOVE_TO: { color: "#38bdf8", icon: Navigation, label: "Moving" },
  APPROACH_ENTITY: { color: "#38bdf8", icon: Navigation, label: "Approaching" },
  FOLLOW_ENTITY: { color: "#38bdf8", icon: Navigation, label: "Following" },
  HOME_TELEPORT: { color: "#38bdf8", icon: Navigation, label: "Teleporting" },
  // Combat
  ATTACK_ENTITY: { color: "#ef4444", icon: Swords, label: "Fighting" },
  ATTACK_TARGET: { color: "#ef4444", icon: Swords, label: "Fighting" },
  FLEE: { color: "#ef4444", icon: Swords, label: "Fleeing" },
  // Gathering
  MINE_ROCK: { color: "#a78bfa", icon: Pickaxe, label: "Mining" },
  CHOP_TREE: { color: "#4ade80", icon: TreePine, label: "Woodcutting" },
  CATCH_FISH: { color: "#22d3ee", icon: Fish, label: "Fishing" },
  // Crafting
  COOK_FOOD: { color: "#fb923c", icon: Flame, label: "Cooking" },
  LIGHT_FIRE: { color: "#fb923c", icon: Flame, label: "Firemaking" },
  SMELT_ORE: { color: "#fb923c", icon: Hammer, label: "Smelting" },
  SMITH_ITEM: { color: "#fb923c", icon: Hammer, label: "Smithing" },
  FLETCH_ITEM: { color: "#fb923c", icon: Hammer, label: "Fletching" },
  RUNECRAFT: { color: "#c084fc", icon: Sparkles, label: "Runecrafting" },
  // Banking
  BANK_DEPOSIT: { color: "#fbbf24", icon: Landmark, label: "Banking" },
  BANK_WITHDRAW: { color: "#fbbf24", icon: Landmark, label: "Banking" },
  BANK_DEPOSIT_ALL: { color: "#fbbf24", icon: Landmark, label: "Banking" },
  // Commerce
  BUY_ITEM: { color: "#34d399", icon: Package, label: "Shopping" },
  SELL_ITEM: { color: "#34d399", icon: Package, label: "Selling" },
  // Quest / NPC
  TALK_TO_NPC: { color: "#818cf8", icon: ScrollText, label: "Talking" },
  ACCEPT_QUEST: { color: "#818cf8", icon: ScrollText, label: "Quest" },
  COMPLETE_QUEST: { color: "#818cf8", icon: Trophy, label: "Quest Done" },
  // Social
  GREET_PLAYER: { color: "#f472b6", icon: MessageCircle, label: "Social" },
  CHAT_MESSAGE: { color: "#f472b6", icon: MessageCircle, label: "Chatting" },
  // Items
  EQUIP_ITEM: { color: "#94a3b8", icon: Shield, label: "Equipping" },
  USE_ITEM: { color: "#94a3b8", icon: Package, label: "Using Item" },
  PICKUP_ITEM: { color: "#94a3b8", icon: Package, label: "Looting" },
};

const DEFAULT_ACTION_CATEGORY: ActionCategory = {
  color: "#6b7280",
  icon: Play,
  label: "Acting",
};

/** Extract the action name (e.g. "MINE_ROCK") from a thought content string */
function extractActionName(content: string): string {
  // Thought content formats: "MINE_ROCK", "MINE_ROCK: mining copper...", "Executing MINE_ROCK"
  const upper = content.toUpperCase();
  for (const key of Object.keys(ACTION_CATEGORIES)) {
    if (upper.includes(key)) return key;
  }
  return "";
}

// ─── Pipeline Node ─────────────────────────────────────────────────────────

type PipelineNodeData = {
  label: string;
  nodeType: string;
  active: boolean;
  pathColor: string;
  cssSuffix: string;
  frequency: number;
  role: "entry" | "output" | "node";
  // Pre-computed content — avoids passing entire agent to every node
  health: number;
  maxHealth: number;
  thoughtText: string;
  providers: string[];
  evaluatorNames: string[];
  isExploring: boolean;
  isSocial: boolean;
  socialChance: number;
  traitEntries: [string, number][];
  desireType: string;
  desireScore: number;
  goalType: string;
  goalProgress: number;
  goalTarget: number;
  // Action executor specific — current action category visuals
  actionName: string;
  actionColor: string;
};

type PipelineNodeType = Node<PipelineNodeData, "pipeline">;

function PipelineNodeIcon({ nodeType }: { nodeType: string }) {
  const size = 14;
  const sw = 1.5;
  switch (nodeType) {
    case "survival":
      return <Heart size={size} strokeWidth={sw} />;
    case "short-circuit":
      return <Zap size={size} strokeWidth={sw} />;
    case "action":
      return <Play size={size} strokeWidth={sw} />;
    case "providers":
      return <Settings size={size} strokeWidth={sw} />;
    case "evaluators":
      return <Gauge size={size} strokeWidth={sw} />;
    case "llm":
      return <Sparkles size={size} strokeWidth={sw} />;
    case "curiosity":
      return <Compass size={size} strokeWidth={sw} />;
    case "personality":
      return <User size={size} strokeWidth={sw} />;
    case "planner":
      return <Target size={size} strokeWidth={sw} />;
    case "goal-selection":
      return <ClipboardList size={size} strokeWidth={sw} />;
    case "social":
      return <MessageCircle size={size} strokeWidth={sw} />;
    default:
      return null;
  }
}

function PipelineNode({ data }: NodeProps<PipelineNodeType>) {
  const { label, nodeType, active, pathColor, cssSuffix, frequency, role } =
    data;
  const activeClass = active ? `active active-${cssSuffix}` : "";

  // For the action node, use the action category color when available
  const effectiveColor =
    active && nodeType === "action" && data.actionColor
      ? data.actionColor
      : pathColor;

  const accentStyle: React.CSSProperties = {};
  if (active) {
    if (role === "entry") {
      accentStyle.borderLeftColor = effectiveColor;
    } else {
      accentStyle.borderTopColor = effectiveColor;
    }
    accentStyle.boxShadow = `0 0 20px ${effectiveColor}40, 0 0 40px ${effectiveColor}15`;
  }

  return (
    <div className={`pn ${activeClass} pn-${role}`} style={accentStyle}>
      {/* Target handles */}
      {(nodeType === "short-circuit" ||
        nodeType === "llm" ||
        nodeType === "action" ||
        nodeType === "planner" ||
        nodeType === "goal-selection" ||
        nodeType === "evaluators" ||
        nodeType === "providers") && (
        <Handle type="target" position={Position.Left} className="pn-handle" />
      )}
      {(nodeType === "action" || nodeType === "evaluators") && (
        <Handle
          type="target"
          position={Position.Bottom}
          id="bottom"
          className="pn-handle"
        />
      )}

      {/* Header */}
      <div className="pn-header">
        <span className="pn-icon">
          <PipelineNodeIcon nodeType={nodeType} />
        </span>
        <span className="pn-label">{label}</span>
        <span className="pn-freq">{frequency}%</span>
      </div>

      <div
        className="pn-divider"
        style={active ? { background: `${effectiveColor}30` } : undefined}
      />

      <div className="pn-body">
        <PipelineNodeBody data={data} />
      </div>

      {active && (
        <div className="pn-pulse" style={{ background: effectiveColor }} />
      )}

      {/* Source handles */}
      {nodeType === "survival" && (
        <>
          <Handle
            type="source"
            position={Position.Top}
            id="top"
            className="pn-handle"
          />
          <Handle
            type="source"
            position={Position.Right}
            id="right"
            className="pn-handle"
          />
        </>
      )}
      {nodeType === "short-circuit" && (
        <Handle type="source" position={Position.Right} className="pn-handle" />
      )}
      {nodeType === "providers" && (
        <Handle type="source" position={Position.Right} className="pn-handle" />
      )}
      {nodeType === "evaluators" && (
        <Handle type="source" position={Position.Right} className="pn-handle" />
      )}
      {nodeType === "llm" && (
        <Handle type="source" position={Position.Right} className="pn-handle" />
      )}
      {nodeType === "curiosity" && (
        <Handle type="source" position={Position.Top} className="pn-handle" />
      )}
      {nodeType === "personality" && (
        <Handle type="source" position={Position.Right} className="pn-handle" />
      )}
      {nodeType === "planner" && (
        <Handle type="source" position={Position.Right} className="pn-handle" />
      )}
      {nodeType === "goal-selection" && (
        <Handle type="source" position={Position.Top} className="pn-handle" />
      )}
      {nodeType === "social" && (
        <Handle type="source" position={Position.Right} className="pn-handle" />
      )}
    </div>
  );
}

function PipelineNodeBody({ data }: { data: PipelineNodeData }) {
  const { nodeType, active, pathColor } = data;

  switch (nodeType) {
    case "survival": {
      const pct = data.maxHealth > 0 ? (data.health / data.maxHealth) * 100 : 0;
      const color = pct < 25 ? "#ef4444" : pct < 50 ? "#eab308" : "#22c55e";
      return (
        <div className="pn-survival">
          <div className="pn-hp-track">
            <div
              className="pn-hp-fill"
              style={{
                width: `${pct}%`,
                background: color,
                boxShadow: `0 0 8px ${color}60`,
              }}
            />
          </div>
          <div className="pn-hp-label">
            <span style={{ color, fontWeight: 700 }}>{data.health}</span>
            <span className="pn-hp-sep">/</span>
            <span>{data.maxHealth}</span>
          </div>
        </div>
      );
    }
    case "short-circuit":
    case "llm":
      return (
        <div className={`pn-thought ${active ? "active" : ""}`}>
          {data.thoughtText ? (
            `"${data.thoughtText}"`
          ) : (
            <span className="pn-idle">Waiting...</span>
          )}
        </div>
      );
    case "action": {
      const cat = ACTION_CATEGORIES[data.actionName] ?? DEFAULT_ACTION_CATEGORY;
      const ActionIcon = cat.icon;
      const hasAction = !!data.actionName;
      return (
        <div className="pn-action-body">
          {hasAction && (
            <div
              className={`pn-action-badge ${active ? "active" : ""}`}
              style={{
                borderColor: `${cat.color}60`,
                background: `${cat.color}18`,
                color: cat.color,
              }}
            >
              <ActionIcon size={12} strokeWidth={2} />
              <span>{cat.label}</span>
            </div>
          )}
          <div className={`pn-thought ${active ? "active" : ""}`}>
            {data.thoughtText ? (
              `"${data.thoughtText}"`
            ) : (
              <span className="pn-idle">Waiting...</span>
            )}
          </div>
        </div>
      );
    }
    case "providers":
      return (
        <div className="pn-pills">
          {data.providers.length > 0 ? (
            data.providers.map((p) => (
              <span
                key={p}
                className="pn-pill"
                style={
                  active
                    ? {
                        borderColor: `${pathColor}50`,
                        background: `${pathColor}15`,
                      }
                    : undefined
                }
              >
                {p}
              </span>
            ))
          ) : (
            <span className="pn-idle">No providers</span>
          )}
        </div>
      );
    case "evaluators":
      return (
        <div className="pn-pills">
          {data.evaluatorNames.map((e) => (
            <span
              key={e}
              className="pn-pill"
              style={
                active
                  ? {
                      borderColor: `${pathColor}50`,
                      background: `${pathColor}15`,
                    }
                  : undefined
              }
            >
              {e}
            </span>
          ))}
        </div>
      );
    case "social": {
      const pct = Math.round(data.socialChance * 100);
      return (
        <div className="pn-status-badge-wrap">
          <span className={`pn-status-badge ${data.isSocial ? "on" : "off"}`}>
            <span className={`pn-status-dot ${data.isSocial ? "on" : ""}`} />
            {data.isSocial ? "Triggered" : `${pct}% chance`}
          </span>
        </div>
      );
    }
    case "curiosity":
      return (
        <div className="pn-status-badge-wrap">
          <span
            className={`pn-status-badge ${data.isExploring ? "on" : "off"}`}
          >
            <span className={`pn-status-dot ${data.isExploring ? "on" : ""}`} />
            {data.isExploring ? "Exploring" : "Idle"}
          </span>
        </div>
      );
    case "personality":
      if (!data.traitEntries.length)
        return <span className="pn-idle">No data</span>;
      return (
        <div className="pn-traits">
          {data.traitEntries.map(([key, val]) => (
            <div key={key} className="pn-trait-row">
              <span className="pn-trait-name">{key.slice(0, 4)}</span>
              <div className="pn-trait-track">
                <div
                  className="pn-trait-fill"
                  style={{ width: `${val * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      );
    case "planner":
      if (!data.desireType) return <span className="pn-idle">No desires</span>;
      return (
        <div className="pn-desire">
          <span className="pn-desire-type">{data.desireType}</span>
          <span className="pn-desire-score">{data.desireScore.toFixed(1)}</span>
        </div>
      );
    case "goal-selection": {
      if (!data.goalType) return <span className="pn-idle">No goal</span>;
      const pct =
        data.goalTarget > 0 ? (data.goalProgress / data.goalTarget) * 100 : 0;
      return (
        <div className="pn-goal">
          <span className="pn-goal-type">{data.goalType}</span>
          <div className="pn-goal-track">
            <div className="pn-goal-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="pn-goal-nums">
            {data.goalProgress}/{data.goalTarget}
          </span>
        </div>
      );
    }
    default:
      return null;
  }
}

// ─── Pipeline Edge ─────────────────────────────────────────────────────────

type DataFlowEdgeData = {
  active: boolean;
  pathColor: string;
};

type DataFlowEdgeType = Edge<DataFlowEdgeData, "dataFlow">;

function DataFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<DataFlowEdgeType>) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  const isActive = data?.active ?? false;
  const color = data?.pathColor ?? "#2a2a35";

  return (
    <>
      {isActive && (
        <BaseEdge
          id={`${id}-glow`}
          path={edgePath}
          style={{
            stroke: color,
            strokeWidth: 6,
            strokeOpacity: 0.15,
            filter: "blur(3px)",
          }}
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: isActive ? color : "#33334a",
          strokeWidth: isActive ? 2 : 1,
          strokeDasharray: isActive ? undefined : "4 4",
          strokeOpacity: isActive ? 1 : 0.8,
        }}
      />
      {isActive && (
        <>
          <circle
            r="4"
            fill={color}
            opacity="0.9"
            filter={`drop-shadow(0 0 4px ${color})`}
          >
            <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
          </circle>
          <circle r="2" fill="#fff" opacity="0.8">
            <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
          </circle>
        </>
      )}
    </>
  );
}

// Defined outside component to prevent remounting
const pipelineNodeTypes = { pipeline: PipelineNode };
const pipelineEdgeTypes = { dataFlow: DataFlowEdge };

// ─── Pipeline Tab Component ────────────────────────────────────────────────

function PipelineTab({ agent }: { agent: AgentData }) {
  const latestThought = agent.recentThoughts[0] as AgentThought | undefined;
  const activePath: DecisionPath | null =
    (latestThought?.decisionPath as DecisionPath) ?? null;

  const activeNodeSet = new Set(activePath ? ACTIVE_NODES[activePath] : []);
  const activeConnSet = new Set(
    activePath ? ACTIVE_CONNECTORS[activePath] : [],
  );
  const cssSuffix = activePath ? PATH_CSS_SUFFIX[activePath] : "";
  const pathColor = activePath ? PATH_COLORS[activePath] : "#2a2a35";

  // Heat map frequencies
  const counts: Record<string, number> = {
    "short-circuit": 0,
    llm: 0,
    planner: 0,
    curiosity: 0,
    scripted: 0,
  };
  for (const t of agent.recentThoughts) {
    if (t.decisionPath && t.decisionPath in counts) counts[t.decisionPath]++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;

  const llmPct = Math.round((counts.llm / total) * 100);
  const plannerPct = Math.round((counts.planner / total) * 100);
  const nodeFreq: Record<string, number> = {
    social: 0,
    survival: 100,
    "short-circuit": Math.round((counts["short-circuit"] / total) * 100),
    action: Math.round(
      ((counts["short-circuit"] + counts.llm + counts.curiosity) / total) * 100,
    ),
    providers: llmPct,
    evaluators: llmPct,
    llm: llmPct,
    curiosity: Math.round((counts.curiosity / total) * 100),
    personality: plannerPct,
    planner: plannerPct,
    "goal-selection": plannerPct,
  };

  // Pre-compute content — single pass, no repeated .find() per node
  const latestSC = agent.recentThoughts.find(
    (t) => t.decisionPath === "short-circuit",
  );
  const latestLLM = agent.recentThoughts.find((t) => t.decisionPath === "llm");
  const latestAction = agent.recentThoughts.find((t) => t.type === "action");
  const latestCuriosity = agent.recentThoughts.find(
    (t) => t.decisionPath === "curiosity",
  );
  const topDesire = agent.desireScores[0];
  const traitEntries: [string, number][] = agent.personality
    ? (Object.entries(agent.personality).slice(0, 6) as [string, number][])
    : [];

  // Social chance is personality-driven: base 3% + sociability * 5%
  const sociability = agent.personality?.sociability ?? 0.5;
  const socialChance = 0.03 + sociability * 0.05;

  // The 4 evaluators that run on the LLM path
  const evaluatorNames = ["Survival", "Explore", "Social", "Combat"];

  const empty = {
    health: 0,
    maxHealth: 0,
    thoughtText: "",
    providers: [],
    evaluatorNames: [],
    isExploring: false,
    isSocial: false,
    socialChance: 0,
    traitEntries: [] as [string, number][],
    desireType: "",
    desireScore: 0,
    goalType: "",
    goalProgress: 0,
    goalTarget: 0,
    actionName: "",
    actionColor: "",
  };

  const nodeContent: Record<
    string,
    Omit<
      PipelineNodeData,
      | "label"
      | "nodeType"
      | "active"
      | "pathColor"
      | "cssSuffix"
      | "frequency"
      | "role"
    >
  > = {
    social: {
      ...empty,
      isSocial:
        latestAction?.content.includes("GREET") ||
        latestAction?.content.includes("SOCIAL") ||
        false,
      socialChance,
    },
    survival: { ...empty, health: agent.health, maxHealth: agent.maxHealth },
    "short-circuit": {
      ...empty,
      thoughtText: latestSC?.content.slice(0, 38) ?? "",
    },
    action: (() => {
      const actionContent = latestAction?.content ?? "";
      const actionName = extractActionName(actionContent);
      const cat = ACTION_CATEGORIES[actionName] ?? DEFAULT_ACTION_CATEGORY;
      return {
        ...empty,
        thoughtText: actionContent.slice(0, 45),
        actionName,
        actionColor: actionName ? cat.color : "",
      };
    })(),
    providers: {
      ...empty,
      providers: (latestLLM?.providers ?? []).slice(0, 5),
    },
    evaluators: { ...empty, evaluatorNames },
    llm: { ...empty, thoughtText: latestLLM?.content.slice(0, 55) ?? "" },
    curiosity: { ...empty, isExploring: !!latestCuriosity },
    personality: { ...empty, traitEntries },
    planner: {
      ...empty,
      desireType: topDesire?.goalType ?? "",
      desireScore: topDesire?.score ?? 0,
    },
    "goal-selection": {
      ...empty,
      goalType: agent.goal?.type ?? "",
      goalProgress: agent.goal?.progress ?? 0,
      goalTarget: agent.goal?.target ?? 0,
    },
  };

  const nodes: Node<PipelineNodeData>[] = PIPELINE_NODE_CONFIGS.map((n) => ({
    id: n.id,
    type: "pipeline" as const,
    position: { x: n.x, y: n.y },
    data: {
      label: n.label,
      nodeType: n.id,
      active: activeNodeSet.has(n.id),
      pathColor,
      cssSuffix,
      frequency: nodeFreq[n.id] ?? 0,
      role: NODE_ROLES[n.id] ?? ("node" as const),
      ...nodeContent[n.id],
    },
  }));

  const edges: Edge<DataFlowEdgeData>[] = PIPELINE_EDGE_CONFIGS.map((e) => {
    const connKey = CONN_KEY_MAP[e.id];
    const isActive = activeConnSet.has(connKey);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: "dataFlow" as const,
      data: { active: isActive, pathColor: isActive ? pathColor : "#2a2a35" },
    };
  });

  return (
    <div className="pipeline-tab">
      <div className="pipeline-flow-container">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={pipelineNodeTypes}
          edgeTypes={pipelineEdgeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={RF_FIT_VIEW_OPTIONS}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={RF_PRO_OPTIONS}
        ></ReactFlow>
      </div>

      {/* Legend */}
      <div className="pipeline-legend">
        <span className="pipeline-legend-title">Decision Paths</span>
        {DECISION_PATH_ORDER.map((dp) => {
          const isLive = dp === activePath;
          return (
            <span
              key={dp}
              className={`pipeline-legend-item ${isLive ? "live" : ""}`}
            >
              <span
                className="pipeline-legend-dot"
                style={{
                  background: PATH_COLORS[dp],
                  boxShadow: isLive ? `0 0 6px ${PATH_COLORS[dp]}` : undefined,
                }}
              />
              <span className="pipeline-legend-label">{dp}</span>
              <span className="pipeline-legend-pct">
                {Math.round((counts[dp] / total) * 100)}%
              </span>
            </span>
          );
        })}
        {activePath && (
          <span className="pipeline-legend-active">
            <strong>{PATH_DESCRIPTIONS[activePath]}</strong>
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Detail Panel ───────────────────────────────────────────────────────────

function AgentDetailPanel({
  agent,
  adminCode,
  duelStatus,
  onRefresh,
}: {
  agent: AgentData;
  adminCode: string;
  duelStatus: DuelStatusResponse | null;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  // Reset modal state
  const [resetPhase, setResetPhase] = useState<ResetPhase | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [snapshotBefore, setSnapshotBefore] = useState<{
    totalLevel: number;
    coins: number;
    inventoryUsed: number;
  } | null>(null);
  const [snapshotAfter, setSnapshotAfter] = useState<{
    totalLevel: number;
    coins: number;
    inventoryUsed: number;
  } | null>(null);
  const statusTimeoutRef = useRef<number | null>(null);
  const refreshTimeoutRef = useRef<number | null>(null);

  const clearTimeoutRef = useCallback(
    (timeoutRef: React.MutableRefObject<number | null>) => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    return () => {
      clearTimeoutRef(statusTimeoutRef);
      clearTimeoutRef(refreshTimeoutRef);
    };
  }, [clearTimeoutRef]);

  const showStatus = (msg: string, duration = 3000) => {
    setActionStatus(msg);
    clearTimeoutRef(statusTimeoutRef);
    statusTimeoutRef.current = window.setTimeout(() => {
      statusTimeoutRef.current = null;
      setActionStatus(null);
    }, duration);
  };

  const adminPost = async (path: string) => {
    const response = await fetch(`${GAME_API_URL}${path}`, {
      method: "POST",
      headers: { "x-admin-code": adminCode },
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    return response;
  };

  const adminGet = async (path: string) => {
    const response = await fetch(`${GAME_API_URL}${path}`, {
      headers: { "x-admin-code": adminCode },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const handleReset = () => {
    // Capture before-snapshot from current agent data
    setSnapshotBefore({
      totalLevel: agent.totalLevel,
      coins: agent.coins,
      inventoryUsed: agent.inventoryUsed,
    });
    setSnapshotAfter(null);
    setResetError(null);
    setResetPhase("confirm");
  };

  const executeReset = async () => {
    try {
      // Phase 1: Disconnecting
      setResetPhase("disconnecting");
      await new Promise((r) => setTimeout(r, 300));

      // Phase 2: Wiping (the actual API call does disconnect + wipe + reconnect)
      setResetPhase("wiping");
      await adminPost(`/admin/players/${agent.characterId}/reset`);

      // Phase 3: Reconnecting (server already reconnected, wait for entity)
      setResetPhase("reconnecting");
      await new Promise((r) => setTimeout(r, 500));

      // Phase 4: Verify — poll the monitor until we see fresh data
      setResetPhase("verifying");
      let verified = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const result = (await adminGet(
            "/admin/agents/monitor",
          )) as MonitorResponse;
          const fresh = result.agents.find(
            (a) => a.characterId === agent.characterId,
          );
          if (fresh) {
            setSnapshotAfter({
              totalLevel: fresh.totalLevel,
              coins: fresh.coins,
              inventoryUsed: fresh.inventoryUsed,
            });
            verified = true;
            break;
          }
        } catch {
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 800));
      }

      if (!verified) {
        // Agent not yet visible but reset succeeded — show what we can
        setSnapshotAfter({ totalLevel: 0, coins: 0, inventoryUsed: 0 });
      }

      setResetPhase("done");
      onRefresh();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Unknown error");
      setResetPhase("error");
    }
  };

  const closeResetModal = () => {
    setResetPhase(null);
    setResetError(null);
    setSnapshotBefore(null);
    setSnapshotAfter(null);
    onRefresh();
  };

  const handlePauseResume = async () => {
    const action = agent.goalsPaused ? "resume" : "pause";
    setPausing(true);
    setActionStatus(null);
    try {
      await adminPost(`/admin/agents/${agent.characterId}/${action}`);
      showStatus(action === "pause" ? "Paused" : "Resumed");
      clearTimeoutRef(refreshTimeoutRef);
      refreshTimeoutRef.current = window.setTimeout(() => {
        refreshTimeoutRef.current = null;
        onRefresh();
      }, 300);
    } catch (err) {
      showStatus(
        `Failed: ${err instanceof Error ? err.message : "error"}`,
        5000,
      );
    } finally {
      setPausing(false);
    }
  };

  const handleStop = () => {
    setConfirmModal({
      title: "Stop Agent",
      message: `Stop ${agent.name}? This removes the agent from the world. You'll need to restart the server to bring it back.`,
      confirmLabel: "Stop",
      onConfirm: async () => {
        setConfirmModal(null);
        setStopping(true);
        setActionStatus(null);
        try {
          await adminPost(`/admin/agents/${agent.characterId}/stop`);
          showStatus("Stopped");
          clearTimeoutRef(refreshTimeoutRef);
          refreshTimeoutRef.current = window.setTimeout(() => {
            refreshTimeoutRef.current = null;
            onRefresh();
          }, 500);
        } catch (err) {
          showStatus(
            `Failed: ${err instanceof Error ? err.message : "error"}`,
            5000,
          );
        } finally {
          setStopping(false);
        }
      },
    });
  };

  const isStatusError = actionStatus?.includes("Failed");
  const resetting = resetPhase !== null && resetPhase !== "confirm";

  return (
    <div className="agent-detail-panel">
      {/* Reset confirm prompt */}
      {resetPhase === "confirm" && (
        <ConfirmModal
          title="Reset Agent"
          message={`Reset ${agent.name}? This wipes all progress — skills, inventory, quests, bank — and respawns the agent fresh.`}
          confirmLabel="Reset"
          onConfirm={executeReset}
          onCancel={() => setResetPhase(null)}
        />
      )}
      {/* Reset progress modal */}
      {resetPhase && resetPhase !== "confirm" && (
        <ResetModal
          agentName={agent.name}
          phase={resetPhase}
          errorMessage={resetError}
          snapshotBefore={snapshotBefore}
          snapshotAfter={snapshotAfter}
          onClose={closeResetModal}
        />
      )}
      {/* Stop confirm */}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      <div className="agent-detail-header">
        <h2>
          <span className={`state-dot ${agent.state}`} />
          {agent.name}
          <span className={`state-text ${agent.state}`}>{agent.state}</span>
        </h2>
        <div className="agent-detail-controls">
          {actionStatus && (
            <span
              className={`action-status ${isStatusError ? "error" : "success"}`}
            >
              {actionStatus}
            </span>
          )}
          <button
            className="agent-control-btn reset"
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting ? "Resetting..." : "Reset"}
          </button>
          <button
            className={`agent-control-btn ${agent.goalsPaused ? "resume" : "pause"}`}
            onClick={handlePauseResume}
            disabled={pausing}
          >
            {agent.goalsPaused ? <Play size={12} /> : <Pause size={12} />}
            {pausing ? "..." : agent.goalsPaused ? "Resume" : "Pause"}
          </button>
          <button
            className="agent-control-btn stop"
            onClick={handleStop}
            disabled={stopping}
          >
            <Square size={12} />
            {stopping ? "..." : "Stop"}
          </button>
        </div>
      </div>

      <div className="agent-detail-tabs">
        {(
          [
            ["overview", "Overview"],
            ["skills", "Skills"],
            ["inventory", "Inventory"],
            ["quests", "Quests"],
            ["bank", "Bank"],
            ["kills", "Kills"],
            ["duels", "Duels"],
            ["actions", "Log"],
            ["pipeline", "Pipeline"],
          ] as [DetailTab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`agent-detail-tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="agent-detail-content">
        {tab === "overview" && <OverviewTab agent={agent} />}
        {tab === "skills" && <SkillsTab agent={agent} />}
        {tab === "inventory" && <InventoryTab agent={agent} />}
        {tab === "quests" && <QuestsTab agent={agent} />}
        {tab === "bank" && <BankTab agent={agent} />}
        {tab === "kills" && (
          <KillsTab characterId={agent.characterId} adminCode={adminCode} />
        )}
        {tab === "duels" && (
          <DuelsTab characterId={agent.characterId} duelStatus={duelStatus} />
        )}
        {tab === "actions" && <ActionLogTab agent={agent} />}
        {tab === "pipeline" && <PipelineTab agent={agent} />}
      </div>
    </div>
  );
}

// ─── Main Screen ────────────────────────────────────────────────────────────

export const AgentMonitorScreen: React.FC = () => {
  const [adminCode, setAdminCode] = useState(
    () => localStorage.getItem(ADMIN_CODE_KEY) || "",
  );
  const [isAuthed, setIsAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  // True while we auto-check a stored code on mount (shows spinner, not form)
  const [checkingStored, setCheckingStored] = useState(
    () => !!localStorage.getItem(ADMIN_CODE_KEY),
  );

  const [data, setData] = useState<MonitorResponse | null>(null);
  const [duelStatus, setDuelStatus] = useState<DuelStatusResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const pollTimeoutRef = useRef<number | null>(null);
  const fetchInFlightRef = useRef(false);
  const adminCodeRef = useRef(adminCode);
  adminCodeRef.current = adminCode;

  // Simple fetch wrapper that attaches admin code header
  const adminFetch = useCallback(
    async (path: string, options?: RequestInit) => {
      const res = await fetch(`${GAME_API_URL}${path}`, {
        ...options,
        headers: {
          "x-admin-code": adminCodeRef.current,
          "Content-Type": "application/json",
          ...(options?.headers || {}),
        },
      });
      if (res.status === 403) throw new Error("Unauthorized");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    [],
  );

  // Try a code against the server — single attempt, no retry loops
  const tryAuth = useCallback(
    async (code: string): Promise<boolean> => {
      adminCodeRef.current = code;
      try {
        await adminFetch("/admin/stats");
        return true;
      } catch {
        return false;
      }
    },
    [adminFetch],
  );

  // On mount: if we have a stored code, check it once
  useEffect(() => {
    const stored = localStorage.getItem(ADMIN_CODE_KEY);
    if (!stored) {
      setCheckingStored(false);
      return;
    }
    let cancelled = false;
    tryAuth(stored).then((ok) => {
      if (cancelled) return;
      if (ok) {
        setIsAuthed(true);
      } else {
        localStorage.removeItem(ADMIN_CODE_KEY);
      }
      setCheckingStored(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tryAuth]);

  // Manual login button
  const handleLogin = useCallback(async () => {
    const code = adminCodeRef.current;
    if (!code) return;
    setAuthLoading(true);
    setAuthError(null);
    const ok = await tryAuth(code);
    if (ok) {
      setIsAuthed(true);
      localStorage.setItem(ADMIN_CODE_KEY, code);
    } else {
      setAuthError("Invalid code or server unreachable");
    }
    setAuthLoading(false);
  }, [tryAuth]);

  // Fetch dashboard data
  const fetchData = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setLoading(true);
    try {
      const [monitorResult, duelResult] = await Promise.all([
        adminFetch("/admin/agents/monitor") as Promise<MonitorResponse>,
        (
          adminFetch("/admin/duels/status") as Promise<DuelStatusResponse>
        ).catch(() => null),
      ]);
      setData(monitorResult);
      if (duelResult) setDuelStatus(duelResult);
      setFetchError(null);
    } catch (err) {
      if (err instanceof Error && err.message === "Unauthorized") {
        setIsAuthed(false);
        setAuthError("Session expired");
        localStorage.removeItem(ADMIN_CODE_KEY);
      } else if (err instanceof Error) {
        setFetchError(err.message);
      }
    } finally {
      fetchInFlightRef.current = false;
      setLoading(false);
    }
  }, [adminFetch]);

  // Fetch once on auth, then poll
  useEffect(() => {
    if (!isAuthed) return;
    fetchData();
  }, [isAuthed, fetchData]);

  useEffect(() => {
    const clearPollTimeout = () => {
      if (pollTimeoutRef.current !== null) {
        window.clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };

    if (!isAuthed) {
      clearPollTimeout();
      return clearPollTimeout;
    }

    const scheduleNextPoll = () => {
      clearPollTimeout();
      if (!autoRefresh) return;
      const delay =
        document.visibilityState === "visible"
          ? POLL_INTERVAL_MS
          : POLL_INTERVAL_MS * 4;
      pollTimeoutRef.current = window.setTimeout(() => {
        pollTimeoutRef.current = null;
        void fetchData().finally(scheduleNextPoll);
      }, delay);
    };

    scheduleNextPoll();
    const onVisibilityChange = () => {
      if (!autoRefresh) return;
      scheduleNextPoll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearPollTimeout();
    };
  }, [isAuthed, autoRefresh, fetchData]);

  // Keep a cached reference to the selected agent so the detail panel
  // doesn't disappear when the entity is temporarily gone during reset.
  const lastSelectedRef = useRef<AgentData | null>(null);
  const liveAgent =
    selectedId && data
      ? (data.agents.find((a) => a.characterId === selectedId) ?? null)
      : null;
  if (liveAgent) {
    lastSelectedRef.current = liveAgent;
  } else if (!selectedId) {
    lastSelectedRef.current = null;
  }
  const selectedAgent = liveAgent ?? lastSelectedRef.current;

  // ─── Auth Gate ──────────────────────────────────────────────────────

  if (!isAuthed && checkingStored) {
    return (
      <div className="agent-monitor">
        <div className="agent-monitor-auth">
          <div className="agent-monitor-auth-card">
            <RefreshCw
              size={36}
              style={{
                color: "#d4a84b",
                marginBottom: 16,
                animation: "spin 1.5s linear infinite",
              }}
            />
            <h1>Agent Monitor</h1>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthed) {
    return (
      <div className="agent-monitor">
        <div className="agent-monitor-auth">
          <div className="agent-monitor-auth-card">
            <Swords size={36} style={{ color: "#d4a84b", marginBottom: 16 }} />
            <h1>Agent Monitor</h1>
            <p>Enter admin code</p>
            {authError && (
              <div className="agent-monitor-auth-error">{authError}</div>
            )}
            <input
              className="agent-monitor-auth-input"
              type="password"
              placeholder="Admin code"
              value={adminCode}
              onChange={(e) => setAdminCode(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && !authLoading && handleLogin()
              }
              autoFocus
              disabled={authLoading}
            />
            <button
              className="agent-monitor-auth-button"
              onClick={handleLogin}
              disabled={authLoading || !adminCode}
            >
              {authLoading ? "Checking..." : "Authenticate"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Main Layout ───────────────────────────────────────────────────

  return (
    <div className="agent-monitor">
      {/* Top bar */}
      <div className="agent-monitor-topbar">
        <div className="agent-monitor-topbar-left">
          <h1>Agent Monitor</h1>
          <span className="agent-count">
            {data ? `${data.agentCount} agents` : "..."}
          </span>
        </div>
        <div className="agent-monitor-topbar-right">
          <label className="agent-monitor-auto-label">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto {POLL_INTERVAL_MS / 1000}s
          </label>
          <button
            className={`agent-monitor-refresh-btn ${loading ? "spinning" : ""}`}
            onClick={fetchData}
            disabled={loading}
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      {/* Duel status bar */}
      <DuelStatusBar duelStatus={duelStatus} />

      {/* Error banner */}
      {fetchError && <div className="agent-monitor-error">{fetchError}</div>}

      {/* Body: sidebar + main */}
      <div className="agent-monitor-body">
        {/* Sidebar */}
        <div className="agent-monitor-sidebar">
          <div className="sidebar-section agents-section">
            <div className="sidebar-section-header">
              Agents{data ? ` (${data.agentCount})` : ""}
            </div>
            <div className="sidebar-section-scroll">
              {data && data.agents.length > 0 ? (
                data.agents.map((agent) => (
                  <AgentListItem
                    key={agent.characterId}
                    agent={agent}
                    selected={selectedId === agent.characterId}
                    onClick={() =>
                      setSelectedId(
                        selectedId === agent.characterId
                          ? null
                          : agent.characterId,
                      )
                    }
                  />
                ))
              ) : data ? (
                <div
                  style={{
                    padding: "20px 12px",
                    color: "#3a3a48",
                    fontSize: 12,
                    textAlign: "center",
                  }}
                >
                  No agents running
                </div>
              ) : null}
            </div>
          </div>

          <SidebarLeaderboard
            leaderboard={duelStatus?.leaderboard ?? []}
            selectedId={selectedId}
          />

          <SidebarRecentDuels duels={duelStatus?.recentDuels ?? []} />
        </div>

        {/* Main content */}
        <div className="agent-monitor-main">
          {selectedAgent ? (
            <AgentDetailPanel
              agent={selectedAgent}
              adminCode={adminCode}
              duelStatus={duelStatus}
              onRefresh={fetchData}
            />
          ) : (
            <div className="agent-detail-empty">
              <User size={28} style={{ opacity: 0.3 }} />
              <div>Select an agent</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
