/**
 * CombatLog — Live fight event feed for the streaming overlay.
 *
 * Derives events from state deltas (HP changes, heal counts, phase transitions)
 * so no server changes are required. Styled for a dark livestream backdrop.
 */

import React, { useEffect, useRef, useState } from "react";
import type {
  StreamingCombatRole,
  StreamingState,
} from "../../screens/StreamingMode";
import {
  formatStreamingCombatRole,
  resolveActiveStreamingCombatRole,
} from "./streamingCombatRole";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventKind =
  | "fight_start"
  | "fight_end"
  | "hit"
  | "big_hit"
  | "heal"
  | "critical"
  | "kill"
  | "style_switch";

interface LogEvent {
  id: number;
  kind: EventKind;
  text: string;
  ts: number; // Date.now()
}

interface CombatLogProps {
  state: StreamingState | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _evId = 0;
function mkEvent(kind: EventKind, text: string): LogEvent {
  return { id: ++_evId, kind, text, ts: Date.now() };
}

/** Colour per event kind */
function kindColor(kind: EventKind): string {
  switch (kind) {
    case "fight_start":
      return "#60a5fa";
    case "fight_end":
      return "#a78bfa";
    case "big_hit":
      return "#fbbf24";
    case "critical":
      return "#fb923c";
    case "kill":
      return "#f87171";
    case "heal":
      return "#34d399";
    case "style_switch":
      return "#67e8f9";
    case "hit":
      return "#cbd5e1";
    default:
      return "#94a3b8";
  }
}

/** Glyph prefix per event kind */
function kindGlyph(kind: EventKind): string {
  switch (kind) {
    case "fight_start":
      return "⚔";
    case "fight_end":
      return "🏆";
    case "big_hit":
      return "💥";
    case "critical":
      return "🔥";
    case "kill":
      return "☠";
    case "heal":
      return "💚";
    case "style_switch":
      return "↻";
    case "hit":
      return "•";
    default:
      return "·";
  }
}

const MAX_EVENTS = 20;
const MAX_VISIBLE_EVENTS = 7;

/**
 * Remove a shared name prefix when the full names would repeatedly dominate
 * the broadcast. The full identities remain visible in the fight HUD.
 */
export function getStreamingCombatLogName(
  name: string,
  opponentName: string,
): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const opponentTokens = opponentName.trim().split(/\s+/).filter(Boolean);
  let commonPrefixLength = 0;
  while (
    commonPrefixLength < tokens.length - 1 &&
    commonPrefixLength < opponentTokens.length - 1 &&
    tokens[commonPrefixLength]?.toLocaleLowerCase() ===
      opponentTokens[commonPrefixLength]?.toLocaleLowerCase()
  ) {
    commonPrefixLength += 1;
  }
  const candidate = tokens.slice(commonPrefixLength).join(" ") || name.trim();
  return candidate.length > 18
    ? `${candidate.slice(0, 17).trimEnd()}…`
    : candidate;
}

// ---------------------------------------------------------------------------
// Hook: derive events from streaming state deltas
// ---------------------------------------------------------------------------

function useCombatEvents(state: StreamingState | null): LogEvent[] {
  const [eventState, setEventState] = useState<{
    cycleId: string | null;
    events: LogEvent[];
  }>({ cycleId: null, events: [] });

  // Refs for previous-tick values
  const prevCycleIdRef = useRef<string | null>(null);
  const prevPhaseRef = useRef<string | null>(null);
  const prevA1HpRef = useRef<number | null>(null);
  const prevA2HpRef = useRef<number | null>(null);
  const prevA1HealRef = useRef<number>(0);
  const prevA2HealRef = useRef<number>(0);
  const prevA1HitRef = useRef<number>(0);
  const prevA2HitRef = useRef<number>(0);
  const prevA1RoleRef = useRef<StreamingCombatRole | null>(null);
  const prevA2RoleRef = useRef<StreamingCombatRole | null>(null);

  useEffect(() => {
    if (!state) return;
    const { cycle } = state;
    const { cycleId, phase, agent1, agent2, winnerName, winReason } = cycle;
    const agent1LogName = agent1
      ? getStreamingCombatLogName(agent1.name, agent2?.name ?? "")
      : "";
    const agent2LogName = agent2
      ? getStreamingCombatLogName(agent2.name, agent1?.name ?? "")
      : "";

    const isNewCycle = cycleId !== prevCycleIdRef.current;
    if (isNewCycle) {
      prevCycleIdRef.current = cycleId;
      prevPhaseRef.current = null;
      prevA1HpRef.current = null;
      prevA2HpRef.current = null;
      prevA1HealRef.current = 0;
      prevA2HealRef.current = 0;
      prevA1HitRef.current = 0;
      prevA2HitRef.current = 0;
      prevA1RoleRef.current = null;
      prevA2RoleRef.current = null;
    }

    const newEvents: LogEvent[] = [];

    // --- Phase transitions ---
    if (phase !== prevPhaseRef.current) {
      if (phase === "FIGHTING" && agent1 && agent2) {
        newEvents.push(
          mkEvent(
            "fight_start",
            `${agent1LogName} vs ${agent2LogName} — FIGHT!`,
          ),
        );
        // Reset per-fight baselines
        prevA1HpRef.current = agent1.hp;
        prevA2HpRef.current = agent2.hp;
        prevA1HealRef.current = agent1.healsUsed ?? 0;
        prevA2HealRef.current = agent2.healsUsed ?? 0;
        prevA1HitRef.current = agent1.highestHit ?? 0;
        prevA2HitRef.current = agent2.highestHit ?? 0;
        prevA1RoleRef.current = resolveActiveStreamingCombatRole(agent1);
        prevA2RoleRef.current = resolveActiveStreamingCombatRole(agent2);
      }
      if (phase === "RESOLUTION") {
        const reason =
          winReason === "kill"
            ? "by knockout"
            : winReason === "forfeit"
              ? "by forfeit"
              : winReason === "hp_advantage"
                ? "by HP advantage"
                : winReason === "damage_advantage"
                  ? "by damage"
                  : "— draw";
        newEvents.push(
          mkEvent(
            winReason === "kill" ? "kill" : "fight_end",
            winnerName
              ? `${winnerName === agent1?.name ? agent1LogName : winnerName === agent2?.name ? agent2LogName : winnerName} wins ${reason}`
              : "Draw",
          ),
        );
      }
      prevPhaseRef.current = phase;
    }

    // Only track hits/heals during FIGHTING
    if (phase !== "FIGHTING" || !agent1 || !agent2) {
      if (isNewCycle || newEvents.length > 0) {
        setEventState((previous) => ({
          cycleId,
          events: [
            ...(previous.cycleId === cycleId ? previous.events : []),
            ...newEvents,
          ].slice(-MAX_EVENTS),
        }));
      }
      return;
    }

    // --- Authoritative frozen-loadout style switches ---
    const a1Role = resolveActiveStreamingCombatRole(agent1);
    const a2Role = resolveActiveStreamingCombatRole(agent2);
    if (prevA1RoleRef.current && a1Role && a1Role !== prevA1RoleRef.current) {
      newEvents.push(
        mkEvent(
          "style_switch",
          `${agent1LogName} switches to ${formatStreamingCombatRole(a1Role)}`,
        ),
      );
    }
    if (prevA2RoleRef.current && a2Role && a2Role !== prevA2RoleRef.current) {
      newEvents.push(
        mkEvent(
          "style_switch",
          `${agent2LogName} switches to ${formatStreamingCombatRole(a2Role)}`,
        ),
      );
    }
    if (a1Role) prevA1RoleRef.current = a1Role;
    if (a2Role) prevA2RoleRef.current = a2Role;

    const prevA1Hp = prevA1HpRef.current ?? agent1.hp;
    const prevA2Hp = prevA2HpRef.current ?? agent2.hp;

    // --- Damage events ---
    const dmgToA1 = prevA1Hp - agent1.hp; // agent2 hit agent1
    const dmgToA2 = prevA2Hp - agent2.hp; // agent1 hit agent2

    if (dmgToA1 > 0) {
      const isCrit = dmgToA1 >= (agent1.maxHp ?? 100) * 0.15;
      newEvents.push(
        mkEvent(
          isCrit ? "critical" : "hit",
          `${agent2LogName} hits ${agent1LogName} — ${dmgToA1} dmg`,
        ),
      );
    }
    if (dmgToA2 > 0) {
      const isCrit = dmgToA2 >= (agent2.maxHp ?? 100) * 0.15;
      newEvents.push(
        mkEvent(
          isCrit ? "critical" : "hit",
          `${agent1LogName} hits ${agent2LogName} — ${dmgToA2} dmg`,
        ),
      );
    }

    // --- New best-hit events ---
    const a1Hit = agent1.highestHit ?? 0;
    const a2Hit = agent2.highestHit ?? 0;
    if (a1Hit > prevA1HitRef.current && a1Hit > 0) {
      newEvents.push(
        mkEvent("big_hit", `${agent1LogName} new best hit: ${a1Hit}`),
      );
    }
    if (a2Hit > prevA2HitRef.current && a2Hit > 0) {
      newEvents.push(
        mkEvent("big_hit", `${agent2LogName} new best hit: ${a2Hit}`),
      );
    }

    // --- Heal events ---
    const a1Heals = agent1.healsUsed ?? 0;
    const a2Heals = agent2.healsUsed ?? 0;
    if (a1Heals > prevA1HealRef.current) {
      const healed = Math.max(0, agent1.hp - prevA1Hp);
      newEvents.push(
        mkEvent(
          "heal",
          healed > 0
            ? `${agent1LogName} heals +${healed} HP`
            : `${agent1LogName} eats food`,
        ),
      );
    }
    if (a2Heals > prevA2HealRef.current) {
      const healed = Math.max(0, agent2.hp - prevA2Hp);
      newEvents.push(
        mkEvent(
          "heal",
          healed > 0
            ? `${agent2LogName} heals +${healed} HP`
            : `${agent2LogName} eats food`,
        ),
      );
    }

    // --- Update refs ---
    prevA1HpRef.current = agent1.hp;
    prevA2HpRef.current = agent2.hp;
    prevA1HealRef.current = a1Heals;
    prevA2HealRef.current = a2Heals;
    prevA1HitRef.current = a1Hit;
    prevA2HitRef.current = a2Hit;

    if (newEvents.length > 0) {
      setEventState((previous) => ({
        cycleId,
        events: [
          ...(previous.cycleId === cycleId ? previous.events : []),
          ...newEvents,
        ].slice(-MAX_EVENTS),
      }));
    }
  }, [state]);

  return eventState.cycleId === state?.cycle.cycleId ? eventState.events : [];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CombatLog({ state }: CombatLogProps) {
  const events = useCombatEvents(state);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest entry
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const phase = state?.cycle?.phase;
  const visible =
    phase === "FIGHTING" || phase === "RESOLUTION" || phase === "COUNTDOWN";

  if (!visible) return null;

  const emptyCopy =
    phase === "COUNTDOWN"
      ? "Waiting for the opening bell"
      : phase === "FIGHTING"
        ? "Waiting for the opening strike"
        : "Finalizing the result";
  const visibleEvents = events.slice(-MAX_VISIBLE_EVENTS);

  return (
    <div
      className="streaming-combat-log"
      style={styles.root}
      aria-label="Fight log"
      data-total-events={events.length}
      data-visible-events={visibleEvents.length}
    >
      <div style={styles.header}>
        <span style={styles.headerDot} />
        <span style={styles.headerText}>FIGHT LOG</span>
      </div>
      <div ref={scrollRef} style={styles.scroll}>
        {events.length === 0 ? (
          <div className="streaming-combat-log-empty" style={styles.empty}>
            {emptyCopy}
          </div>
        ) : (
          visibleEvents.map((ev) => (
            <div key={ev.id} style={styles.row} data-event-kind={ev.kind}>
              <span style={{ ...styles.glyph, color: kindColor(ev.kind) }}>
                {kindGlyph(ev.kind)}
              </span>
              <span style={{ ...styles.text, color: kindColor(ev.kind) }}>
                {ev.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: "absolute",
    top: 72,
    left: 16,
    width: 232,
    maxHeight: 232,
    display: "flex",
    flexDirection: "column",
    background:
      "linear-gradient(180deg, rgba(6,8,16,0.88) 0%, rgba(8,12,24,0.92) 100%)",
    border: "1px solid rgba(96,165,250,0.18)",
    borderRadius: 10,
    overflow: "hidden",
    boxShadow:
      "0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03) inset",
    backdropFilter: "blur(18px) saturate(1.3)",
    WebkitBackdropFilter: "blur(18px) saturate(1.3)",
    pointerEvents: "none",
    zIndex: 53,
    animation: "streaming-mount-in 0.4s ease-out both",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "6px 10px 5px",
    borderBottom: "1px solid rgba(96,165,250,0.12)",
    background: "rgba(96,165,250,0.05)",
    flexShrink: 0,
  },
  headerDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#ef4444",
    boxShadow: "0 0 6px #ef444488",
    flexShrink: 0,
    // CSS animation via className would need keyframes — using inline static
  },
  headerText: {
    fontSize: "0.6rem",
    fontWeight: 800,
    letterSpacing: "0.2em",
    textTransform: "uppercase",
    color: "rgba(148,163,184,0.7)",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  scroll: {
    overflowY: "auto",
    overflowX: "hidden",
    display: "flex",
    flexDirection: "column",
    gap: 0,
    padding: "3px 0 5px",
    // Hide scrollbar
    scrollbarWidth: "none",
    msOverflowStyle: "none",
  },
  empty: {
    padding: "10px 12px 11px",
    color: "rgba(191,219,254,0.72)",
    fontSize: "0.68rem",
    fontWeight: 600,
    fontFamily: "'IBM Plex Mono', monospace",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  row: {
    display: "flex",
    alignItems: "baseline",
    gap: 7,
    padding: "2px 9px 2px 8px",
    borderRadius: 4,
  },
  glyph: {
    fontSize: "0.72rem",
    flexShrink: 0,
    lineHeight: 1,
  },
  text: {
    fontSize: "0.64rem",
    fontWeight: 600,
    fontFamily: "'IBM Plex Mono', monospace",
    lineHeight: 1.35,
    letterSpacing: "0.01em",
    wordBreak: "break-word",
  },
};
