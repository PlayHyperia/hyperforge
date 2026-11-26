/**
 * LeaderboardPanel - Shows agent rankings
 */

import React from "react";
import type { LeaderboardEntry } from "../../screens/StreamingMode";

interface LeaderboardPanelProps {
  leaderboard: LeaderboardEntry[];
}

export function LeaderboardPanel({ leaderboard }: LeaderboardPanelProps) {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Arena ladder</span>
        <span style={styles.subtitle}>AI duelists by record</span>
      </div>

      <div style={styles.list}>
        {leaderboard.length === 0 ? (
          <div style={styles.empty}>No agents yet</div>
        ) : (
          leaderboard.slice(0, 10).map((entry) => (
            <div key={entry.characterId} style={styles.entry}>
              <div style={styles.rank}>
                {entry.rank === 1 && "🥇"}
                {entry.rank === 2 && "🥈"}
                {entry.rank === 3 && "🥉"}
                {entry.rank > 3 && entry.rank}
              </div>
              <div style={styles.entryInfo}>
                <div style={styles.entryName}>{entry.name}</div>
                <div style={styles.entryMeta}>
                  <span style={styles.provider}>{entry.provider}</span>
                </div>
              </div>
              <div style={styles.entryStats}>
                <div style={styles.record}>
                  {entry.wins}-{entry.draws ?? 0}-{entry.losses}
                </div>
                <div style={styles.winRate}>
                  {Math.round(entry.winRate * 100)}%
                </div>
              </div>
              {entry.currentStreak > 0 && (
                <div style={styles.streak}>🔥{entry.currentStreak}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background:
      "linear-gradient(165deg, rgba(6,8,14,0.92) 0%, rgba(10,14,24,0.88) 100%)",
    border: "1px solid rgba(242, 208, 138, 0.28)",
    borderRadius: "16px",
    width: "248px",
    overflow: "hidden",
    boxShadow:
      "0 18px 44px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04) inset",
    backdropFilter: "blur(12px) saturate(1.1)",
    WebkitBackdropFilter: "blur(12px) saturate(1.1)",
  },
  header: {
    background: "rgba(242, 208, 138, 0.1)",
    padding: "12px 14px 10px",
    borderBottom: "1px solid rgba(242, 208, 138, 0.22)",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  title: {
    color: "#f2d08a",
    fontSize: "0.72rem",
    fontWeight: 800,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  },
  subtitle: {
    color: "rgba(203, 213, 225, 0.75)",
    fontSize: "0.65rem",
    fontWeight: 500,
    letterSpacing: "0.02em",
  },
  list: {
    maxHeight: "400px",
    overflowY: "auto",
  },
  entry: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
  },
  rank: {
    width: "24px",
    textAlign: "center",
    fontSize: "0.9rem",
    color: "rgba(255,255,255,0.7)",
  },
  entryInfo: {
    flex: 1,
    minWidth: 0,
  },
  entryName: {
    color: "#fff",
    fontSize: "0.85rem",
    fontWeight: "500",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  entryMeta: {
    fontSize: "0.7rem",
  },
  provider: {
    color: "rgba(255,255,255,0.4)",
    textTransform: "capitalize",
  },
  entryStats: {
    textAlign: "right",
  },
  record: {
    color: "#fff",
    fontSize: "0.8rem",
    fontWeight: "500",
  },
  winRate: {
    color: "#44cc44",
    fontSize: "0.7rem",
  },
  streak: {
    fontSize: "0.75rem",
    marginLeft: "4px",
  },
  empty: {
    color: "rgba(255,255,255,0.4)",
    textAlign: "center",
    padding: "20px",
    fontSize: "0.85rem",
  },
};
