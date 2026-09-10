/**
 * PostFightStatsCard - Per-fight stat breakdown shown during RESOLUTION phase
 *
 * Displays side-by-side stats for both combatants:
 * - Damage dealt, highest hit, attacks landed, heals used
 * - Win reason badge
 */

import React from "react";
import type { AgentInfo } from "../../screens/StreamingMode";

interface PostFightStatsCardProps {
  agent1: AgentInfo;
  agent2: AgentInfo;
  winnerId: string;
  winReason: string;
}

const WIN_REASON_LABELS: Record<string, string> = {
  kill: "Knockout",
  forfeit: "Forfeit",
  hp_advantage: "HP Advantage",
  damage_advantage: "Damage Advantage",
  draw: "Draw",
};

export function PostFightStatsCard({
  agent1,
  agent2,
  winnerId,
  winReason,
}: PostFightStatsCardProps) {
  const reasonLabel = WIN_REASON_LABELS[winReason] ?? winReason;

  return (
    <div className="streaming-post-fight-card" style={styles.container}>
      <div style={styles.reasonBadge}>{reasonLabel}</div>
      <div className="streaming-post-fight-table" style={styles.table}>
        <AgentColumn
          agent={agent1}
          isWinner={agent1.id === winnerId}
          side="left"
        />
        <StatLabels />
        <AgentColumn
          agent={agent2}
          isWinner={agent2.id === winnerId}
          side="right"
        />
      </div>
    </div>
  );
}

function AgentColumn({
  agent,
  isWinner,
  side,
}: {
  agent: AgentInfo;
  isWinner: boolean;
  side: "left" | "right";
}) {
  return (
    <div
      className={`streaming-post-fight-agent streaming-post-fight-agent--${side}`}
      style={styles.column}
    >
      <div
        className="streaming-post-fight-agent-name"
        style={{
          ...styles.agentName,
          color: isWinner ? "#f2d08a" : "#94a3b8",
        }}
      >
        {agent.name}
        {isWinner && <span style={styles.crownIcon}> ♛</span>}
      </div>
      <StatValue value={agent.damageDealtThisFight} />
      <StatValue value={agent.highestHit} />
      <StatValue value={agent.attacksLanded} />
      <StatValue value={agent.healsUsed} />
    </div>
  );
}

function StatLabels() {
  return (
    <div style={{ ...styles.column, ...styles.labelColumn }}>
      <div style={styles.labelSpacer} />
      <StatLabel label="Damage" />
      <StatLabel label="Highest Hit" />
      <StatLabel label="Attacks" />
      <StatLabel label="Heals" />
    </div>
  );
}

function StatLabel({ label }: { label: string }) {
  return <div style={styles.statLabel}>{label}</div>;
}

function StatValue({ value }: { value: number }) {
  return <div style={styles.statValue}>{value}</div>;
}

const ROW_HEIGHT = "2rem";

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.75rem 1.25rem",
    background: "rgba(0, 0, 0, 0.72)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "8px",
    backdropFilter: "blur(4px)",
  },
  reasonBadge: {
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "rgba(148, 163, 184, 0.8)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    paddingBottom: "0.4rem",
    width: "100%",
    textAlign: "center",
  },
  table: {
    display: "flex",
    flexDirection: "row",
    gap: "0",
    width: "100%",
  },
  column: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    gap: "0.15rem",
  },
  labelColumn: {
    flex: "0 0 auto",
    alignItems: "center",
    minWidth: "90px",
    padding: "0 0.5rem",
  },
  agentName: {
    fontSize: "0.85rem",
    fontWeight: 700,
    fontFamily: "Impact, sans-serif",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    height: ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
  },
  crownIcon: {
    color: "#f2d08a",
    fontSize: "0.75rem",
  },
  statValue: {
    fontSize: "1rem",
    fontWeight: 600,
    color: "#e2e8f0",
    fontVariantNumeric: "tabular-nums",
    height: ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
  },
  statLabel: {
    fontSize: "0.65rem",
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "rgba(148, 163, 184, 0.7)",
    height: ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
  },
  labelSpacer: {
    height: ROW_HEIGHT,
  },
};
