import React from "react";
import { GAME_API_URL } from "../lib/api-config";
import {
  formatPhaseLabel,
  formatRelativeTime,
  formatWinDrawLoss,
  normalizeSearchTerm,
  toWinRatePercent,
} from "../lib/leaderboard-utils";
import {
  formatDuelReason,
  formatTerminalMatchup,
  getCancellationPresentation,
  isDuelTerminalNotice,
  type DuelTerminalNotice,
} from "../lib/duel-outcome-presentation";
import "./LeaderboardScreen.css";

type StreamingPhase =
  "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";

interface CycleAgent {
  id: string;
  name: string;
  provider: string;
  model: string;
  hp: number;
  maxHp: number;
  combatLevel: number;
  wins: number;
  losses: number;
  damageDealtThisFight: number;
}

interface CycleSnapshot {
  cycleId: string;
  phase: StreamingPhase;
  cycleStartTime: number;
  phaseStartTime: number;
  phaseEndTime: number;
  timeRemaining: number;
  agent1: CycleAgent | null;
  agent2: CycleAgent | null;
  countdown: number | null;
  winnerId: string | null;
  winnerName: string | null;
  outcome: "win" | "draw" | null;
  winReason: string | null;
}

interface LeaderboardEntry {
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

interface RecentDuelEntry {
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
  winReason:
    "kill" | "forfeit" | "hp_advantage" | "damage_advantage" | "draw" | null;
  cancellationReason: string | null;
  damageAgent1: number;
  damageAgent2: number;
  damageWinner: number | null;
  damageLoser: number | null;
}

interface LeaderboardDetailsResponse {
  leaderboard: LeaderboardEntry[];
  cycle: CycleSnapshot;
  terminalNotice: DuelTerminalNotice | null;
  recentDuels: RecentDuelEntry[];
  updatedAt: number;
}

const POLL_INTERVAL_MS = 5000;

const isLeaderboardEntry = (value: unknown): value is LeaderboardEntry => {
  const maybe = value as Partial<LeaderboardEntry>;
  return (
    typeof maybe?.characterId === "string" &&
    typeof maybe?.name === "string" &&
    Number.isFinite(maybe?.rank)
  );
};

const isRecentDuelEntry = (value: unknown): value is RecentDuelEntry => {
  const maybe = value as Partial<RecentDuelEntry>;
  if (!Number.isFinite(maybe?.finishedAt)) return false;
  if (maybe?.outcome === "cancelled") {
    return typeof maybe.cancellationReason === "string";
  }
  return (
    (maybe?.outcome === "win" || maybe?.outcome === "draw") &&
    typeof maybe?.agent1Id === "string" &&
    typeof maybe?.agent2Id === "string" &&
    typeof maybe?.winReason === "string"
  );
};

const sanitizeResponse = (value: unknown): LeaderboardDetailsResponse => {
  const candidate = value as Partial<LeaderboardDetailsResponse>;
  const leaderboard = Array.isArray(candidate?.leaderboard)
    ? candidate.leaderboard.filter(isLeaderboardEntry).map((entry) => ({
        ...entry,
        draws: Number.isFinite(entry.draws) ? Math.max(0, entry.draws) : 0,
      }))
    : [];
  const recentDuels = Array.isArray(candidate?.recentDuels)
    ? candidate.recentDuels.filter(isRecentDuelEntry)
    : [];

  const fallbackCycle: CycleSnapshot = {
    cycleId: "",
    phase: "IDLE",
    cycleStartTime: Date.now(),
    phaseStartTime: Date.now(),
    phaseEndTime: Date.now(),
    timeRemaining: 0,
    agent1: null,
    agent2: null,
    countdown: null,
    winnerId: null,
    winnerName: null,
    outcome: null,
    winReason: null,
  };

  return {
    leaderboard,
    cycle:
      candidate?.cycle && typeof candidate.cycle === "object"
        ? (candidate.cycle as CycleSnapshot)
        : fallbackCycle,
    terminalNotice: isDuelTerminalNotice(candidate?.terminalNotice)
      ? candidate.terminalNotice
      : null,
    recentDuels,
    updatedAt: Number.isFinite(candidate?.updatedAt)
      ? (candidate.updatedAt as number)
      : Date.now(),
  };
};

export function LeaderboardScreen() {
  const [data, setData] = React.useState<LeaderboardDetailsResponse | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [searchTerm, setSearchTerm] = React.useState("");
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    let mounted = true;
    let inFlight: AbortController | null = null;
    let pollTimeoutId: number | null = null;

    const poll = async () => {
      inFlight?.abort();
      inFlight = new AbortController();

      try {
        const response = await fetch(
          `${GAME_API_URL}/api/streaming/leaderboard/details?historyLimit=80`,
          {
            signal: inFlight.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = sanitizeResponse(await response.json());
        if (!mounted) return;

        setData(payload);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (!mounted) return;

        const isAbort =
          err instanceof DOMException && err.name === "AbortError";
        if (isAbort) {
          return;
        }

        setError(
          err instanceof Error
            ? err.message
            : "Failed to load leaderboard data",
        );
        setLoading(false);
      }
    };

    const clearPollTimeout = () => {
      if (pollTimeoutId !== null) {
        window.clearTimeout(pollTimeoutId);
        pollTimeoutId = null;
      }
    };

    const scheduleNextPoll = () => {
      clearPollTimeout();
      const delay =
        document.visibilityState === "visible"
          ? POLL_INTERVAL_MS
          : POLL_INTERVAL_MS * 3;
      pollTimeoutId = window.setTimeout(() => {
        pollTimeoutId = null;
        void poll().finally(scheduleNextPoll);
      }, delay);
    };

    void poll().finally(scheduleNextPoll);
    const onVisibilityChange = () => {
      if (!mounted) return;
      scheduleNextPoll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearPollTimeout();
      inFlight?.abort();
    };
  }, []);

  React.useEffect(() => {
    if (!data?.leaderboard.length) return;

    const selectedStillExists =
      selectedAgentId &&
      data.leaderboard.some((entry) => entry.characterId === selectedAgentId);

    if (!selectedStillExists) {
      setSelectedAgentId(data.leaderboard[0].characterId);
    }
  }, [data, selectedAgentId]);

  const filteredLeaderboard = React.useMemo(() => {
    if (!data) return [];

    const normalized = normalizeSearchTerm(searchTerm);
    if (!normalized) return data.leaderboard;

    return data.leaderboard.filter((entry) => {
      const haystack = `${entry.name} ${entry.provider} ${entry.model}`;
      return normalizeSearchTerm(haystack).includes(normalized);
    });
  }, [data, searchTerm]);

  const selectedAgent = React.useMemo(() => {
    if (!data || !selectedAgentId) return null;
    return data.leaderboard.find(
      (entry) => entry.characterId === selectedAgentId,
    );
  }, [data, selectedAgentId]);

  const selectedAgentHistory = React.useMemo(() => {
    if (!data || !selectedAgentId) return [];

    return data.recentDuels
      .filter(
        (duel) =>
          duel.agent1Id === selectedAgentId ||
          duel.agent2Id === selectedAgentId,
      )
      .slice(0, 8);
  }, [data, selectedAgentId]);

  const activeMatchup = data?.terminalNotice
    ? formatTerminalMatchup(data.terminalNotice)
    : data?.cycle?.agent1 && data?.cycle?.agent2
      ? `${data.cycle.agent1.name} vs ${data.cycle.agent2.name}`
      : "No active duel";
  const cancellationPresentation = data?.terminalNotice
    ? getCancellationPresentation(data.terminalNotice.reason)
    : null;
  const isCurrentDraw =
    data?.cycle.phase === "RESOLUTION" && data.cycle.outcome === "draw";

  return (
    <div className="leaderboard-page">
      <div className="leaderboard-shell">
        <header className="leaderboard-header">
          <div>
            <h1>Agent Leaderboard</h1>
            <p>All agents, live rank, and recent duel outcomes.</p>
          </div>
          <div className="leaderboard-header-actions">
            <a className="leaderboard-nav-btn" href="/">
              Lobby
            </a>
            <a className="leaderboard-nav-btn" href="/?page=stream">
              Stream
            </a>
            <a className="leaderboard-nav-btn" href="/?page=dashboard">
              Dashboard
            </a>
          </div>
        </header>

        {error && <div className="leaderboard-error">{error}</div>}

        {(cancellationPresentation || isCurrentDraw) && (
          <div
            className={`leaderboard-terminal-notice ${cancellationPresentation ? "cancelled" : "draw"}`}
            role="status"
            aria-live="polite"
          >
            <strong>
              {cancellationPresentation?.title ?? "Draw — no winner"}
            </strong>
            <span>
              {cancellationPresentation?.sub ??
                "The round ended level and neither contestant received a win or loss."}
            </span>
          </div>
        )}

        <section className="leaderboard-kpis">
          <article className="leaderboard-kpi-card">
            <span className="kpi-label">Agents</span>
            <span className="kpi-value">
              {loading ? "--" : (data?.leaderboard.length ?? 0)}
            </span>
          </article>
          <article className="leaderboard-kpi-card">
            <span className="kpi-label">Phase</span>
            <span className="kpi-value">
              {loading ? "--" : formatPhaseLabel(data?.cycle.phase ?? "IDLE")}
            </span>
          </article>
          <article className="leaderboard-kpi-card">
            <span className="kpi-label">Current Duel</span>
            <span className="kpi-value kpi-value-small">{activeMatchup}</span>
          </article>
          <article className="leaderboard-kpi-card">
            <span className="kpi-label">Updated</span>
            <span className="kpi-value">
              {data ? formatRelativeTime(data.updatedAt) : "--"}
            </span>
          </article>
        </section>

        <section className="leaderboard-content-grid">
          <article className="leaderboard-card">
            <div className="leaderboard-card-header">
              <h2>Leaderboard</h2>
              <input
                className="leaderboard-search"
                type="text"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search agents"
              />
            </div>

            <div className="leaderboard-table-wrap">
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Agent</th>
                    <th>Provider</th>
                    <th aria-label="Wins, draws, losses">W-D-L</th>
                    <th title="Wins divided by decisive results">
                      Decisive WR
                    </th>
                    <th>Lvl</th>
                    <th>Streak</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLeaderboard.length === 0 && (
                    <tr>
                      <td colSpan={7} className="leaderboard-empty">
                        {loading ? "Loading..." : "No agents found"}
                      </td>
                    </tr>
                  )}
                  {filteredLeaderboard.map((entry) => {
                    const isSelected = entry.characterId === selectedAgentId;
                    return (
                      <tr
                        key={entry.characterId}
                        className={isSelected ? "is-selected" : ""}
                        onClick={() => setSelectedAgentId(entry.characterId)}
                      >
                        <td>#{entry.rank}</td>
                        <td className="agent-cell">
                          <span className="agent-name">{entry.name}</span>
                          <span className="agent-model">{entry.model}</span>
                        </td>
                        <td>{entry.provider}</td>
                        <td>
                          {formatWinDrawLoss(
                            entry.wins,
                            entry.draws,
                            entry.losses,
                          )}
                        </td>
                        <td>
                          {toWinRatePercent(entry.wins, entry.losses).toFixed(
                            1,
                          )}
                          %
                        </td>
                        <td>{entry.combatLevel}</td>
                        <td>
                          {entry.currentStreak > 0
                            ? `${entry.currentStreak}W`
                            : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>

          <aside className="leaderboard-card leaderboard-sidebar">
            <div className="leaderboard-card-header">
              <h2>Agent Focus</h2>
            </div>

            {!selectedAgent && (
              <p className="leaderboard-empty">
                Select an agent to view details.
              </p>
            )}

            {selectedAgent && (
              <>
                <div className="agent-focus-card">
                  <h3>{selectedAgent.name}</h3>
                  <div className="agent-focus-metrics">
                    <div>
                      <span className="metric-label">Current Rank</span>
                      <span className="metric-value">
                        #{selectedAgent.rank}
                      </span>
                    </div>
                    <div>
                      <span className="metric-label">Record</span>
                      <span className="metric-value">
                        {formatWinDrawLoss(
                          selectedAgent.wins,
                          selectedAgent.draws,
                          selectedAgent.losses,
                        )}
                      </span>
                    </div>
                    <div>
                      <span className="metric-label">Win Rate</span>
                      <span className="metric-value">
                        {toWinRatePercent(
                          selectedAgent.wins,
                          selectedAgent.losses,
                        ).toFixed(1)}
                        %
                      </span>
                    </div>
                    <div>
                      <span className="metric-label">Combat Level</span>
                      <span className="metric-value">
                        {selectedAgent.combatLevel}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="duel-history-list">
                  <h3>Recent Duels ({selectedAgentHistory.length})</h3>
                  {selectedAgentHistory.length === 0 && (
                    <p className="leaderboard-empty">No duel history yet.</p>
                  )}
                  {selectedAgentHistory.map((duel) => {
                    const drew = duel.outcome === "draw";
                    const cancelled = duel.outcome === "cancelled";
                    const won = duel.winnerId === selectedAgent.characterId;
                    const agent1Name =
                      duel.agent1Name ?? "Contestant unavailable";
                    const agent2Name =
                      duel.agent2Name ?? "Contestant unavailable";
                    return (
                      <div
                        key={`${duel.cycleId}-${duel.finishedAt}-${duel.outcome}`}
                        className="duel-history-item"
                      >
                        <div className="duel-history-row">
                          <span
                            className={
                              cancelled
                                ? "result-cancelled"
                                : drew
                                  ? "result-draw"
                                  : won
                                    ? "result-win"
                                    : "result-loss"
                            }
                          >
                            {cancelled
                              ? "CANCELLED"
                              : drew
                                ? "DRAW"
                                : won
                                  ? "WIN"
                                  : "LOSS"}
                          </span>
                          <span>{formatRelativeTime(duel.finishedAt)}</span>
                        </div>
                        <div className="duel-history-row duel-history-main">
                          <span>
                            {cancelled || drew ? agent1Name : duel.winnerName}
                          </span>
                          <span>vs</span>
                          <span>
                            {cancelled || drew ? agent2Name : duel.loserName}
                          </span>
                        </div>
                        <div className="duel-history-row">
                          <span>
                            {cancelled
                              ? getCancellationPresentation(
                                  duel.cancellationReason ?? "cancelled",
                                ).title
                              : `Reason: ${formatDuelReason(duel.winReason)}`}
                          </span>
                          <span>
                            Damage:{" "}
                            {cancelled || drew
                              ? duel.damageAgent1
                              : duel.damageWinner}
                            -
                            {cancelled || drew
                              ? duel.damageAgent2
                              : duel.damageLoser}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </aside>
        </section>

        <section className="leaderboard-card global-history-card">
          <div className="leaderboard-card-header">
            <h2>Global Recent Duel History</h2>
            <span>{data?.recentDuels.length ?? 0} entries</span>
          </div>

          <div className="duel-history-list grid-mode">
            {(data?.recentDuels ?? []).slice(0, 24).map((duel) => (
              <div
                key={`${duel.cycleId}-${duel.finishedAt}-${duel.outcome}-global`}
                className="duel-history-item"
              >
                <div className="duel-history-row">
                  <span
                    className={
                      duel.outcome === "cancelled"
                        ? "result-cancelled"
                        : duel.outcome === "draw"
                          ? "result-draw"
                          : "result-win"
                    }
                  >
                    {duel.outcome === "cancelled"
                      ? "No contest"
                      : duel.outcome === "draw"
                        ? "Draw"
                        : duel.winnerName}
                  </span>
                  <span>{formatRelativeTime(duel.finishedAt)}</span>
                </div>
                <div className="duel-history-row duel-history-main">
                  <span>
                    {duel.outcome === "cancelled" || duel.outcome === "draw"
                      ? (duel.agent1Name ?? "Contestant unavailable")
                      : "Defeated"}
                  </span>
                  <span>
                    {duel.outcome === "cancelled" || duel.outcome === "draw"
                      ? (duel.agent2Name ?? "Contestant unavailable")
                      : duel.loserName}
                  </span>
                </div>
                <div className="duel-history-row">
                  <span>
                    {duel.outcome === "cancelled"
                      ? getCancellationPresentation(
                          duel.cancellationReason ?? "cancelled",
                        ).title
                      : `Reason: ${formatDuelReason(duel.winReason)}`}
                  </span>
                  <span>
                    {duel.outcome === "draw" || duel.outcome === "cancelled"
                      ? duel.damageAgent1
                      : duel.damageWinner}
                    -
                    {duel.outcome === "draw" || duel.outcome === "cancelled"
                      ? duel.damageAgent2
                      : duel.damageLoser}
                  </span>
                </div>
              </div>
            ))}
            {!loading && (data?.recentDuels.length ?? 0) === 0 && (
              <p className="leaderboard-empty">
                No completed duels recorded yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
