/**
 * DuelInfoPanel - Shows the current duel matchup
 *
 * Displays:
 * - Both contestants with avatars
 * - Combat levels
 * - Win/loss records
 * - Time until fight (during announcement)
 */

import React from "react";
import type { AgentInfo } from "../../screens/StreamingMode";

interface DuelInfoPanelProps {
  phase: string;
  agent1: AgentInfo | null;
  agent2: AgentInfo | null;
  timeRemaining: number;
}

export function DuelInfoPanel({
  phase,
  agent1,
  agent2,
  timeRemaining,
}: DuelInfoPanelProps) {
  if (!agent1 || !agent2) {
    return (
      <div style={styles.container}>
        <div style={styles.waitingText}>Waiting for contestants...</div>
      </div>
    );
  }

  const showCountdown = phase === "ANNOUNCEMENT";

  return (
    <div style={styles.container}>
      {/* Title */}
      <div style={styles.title}>
        {phase === "ANNOUNCEMENT" ? "NEXT DUEL" : "CURRENT DUEL"}
      </div>

      {/* Matchup */}
      <div style={styles.matchup}>
        {/* Agent 1 */}
        <div style={styles.agentCard}>
          <div style={styles.agentAvatar}>
            <div style={styles.avatarPlaceholder}>
              {getProviderIcon(agent1.provider)}
            </div>
          </div>
          <div style={styles.agentInfo}>
            <div style={styles.agentName}>{agent1.name}</div>
            <div style={styles.agentMeta}>
              <span style={styles.combatLevel}>Lv {agent1.combatLevel}</span>
              <span style={styles.record}>
                {agent1.wins}W - {agent1.losses}L
              </span>
            </div>
          </div>
        </div>

        {/* VS */}
        <div style={styles.vsContainer}>
          <div style={styles.vs}>VS</div>
        </div>

        {/* Agent 2 */}
        <div style={styles.agentCard}>
          <div style={styles.agentAvatar}>
            <div style={styles.avatarPlaceholder}>
              {getProviderIcon(agent2.provider)}
            </div>
          </div>
          <div style={styles.agentInfo}>
            <div style={styles.agentName}>{agent2.name}</div>
            <div style={styles.agentMeta}>
              <span style={styles.combatLevel}>Lv {agent2.combatLevel}</span>
              <span style={styles.record}>
                {agent2.wins}W - {agent2.losses}L
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Countdown (during announcement) */}
      {showCountdown && (
        <div style={styles.countdownContainer}>
          <div style={styles.countdownLabel}>Fight begins in</div>
          <div style={styles.countdown}>{formatTime(timeRemaining)}</div>
        </div>
      )}
    </div>
  );
}

function getProviderIcon(provider: string): string {
  switch (provider.toLowerCase()) {
    case "openai":
      return "O";
    case "anthropic":
      return "A";
    case "groq":
      return "G";
    default:
      return "?";
  }
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background:
      "linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.7) 100%)",
    border: "2px solid rgba(242, 208, 138, 0.5)",
    borderRadius: "12px",
    padding: "20px 40px",
    minWidth: "500px",
  },
  title: {
    color: "#f2d08a",
    fontSize: "0.9rem",
    fontWeight: "bold",
    textTransform: "uppercase",
    letterSpacing: "3px",
    textAlign: "center",
    marginBottom: "16px",
  },
  matchup: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "20px",
  },
  agentCard: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  agentAvatar: {
    width: "60px",
    height: "60px",
  },
  avatarPlaceholder: {
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "1.5rem",
    fontWeight: "bold",
    border: "2px solid rgba(255,255,255,0.3)",
  },
  agentInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  agentName: {
    color: "#fff",
    fontSize: "1.1rem",
    fontWeight: "bold",
  },
  agentMeta: {
    display: "flex",
    gap: "12px",
    fontSize: "0.85rem",
  },
  combatLevel: {
    color: "#f2d08a",
  },
  record: {
    color: "rgba(255,255,255,0.7)",
  },
  vsContainer: {
    padding: "0 20px",
  },
  vs: {
    color: "#ff6b6b",
    fontSize: "1.5rem",
    fontWeight: "bold",
    textShadow: "0 0 10px rgba(255,107,107,0.5)",
  },
  countdownContainer: {
    marginTop: "20px",
    textAlign: "center",
    borderTop: "1px solid rgba(242, 208, 138, 0.2)",
    paddingTop: "16px",
  },
  countdownLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: "0.8rem",
    textTransform: "uppercase",
    letterSpacing: "2px",
    marginBottom: "4px",
  },
  countdown: {
    color: "#f2d08a",
    fontSize: "2rem",
    fontWeight: "bold",
    fontFamily: "monospace",
  },
  waitingText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: "1rem",
    textAlign: "center",
    padding: "20px",
  },
};
