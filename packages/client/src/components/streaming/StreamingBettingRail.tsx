/**
 * StreamingBettingRail — Public stream CTA for parimutuel / prediction betting.
 *
 * Shown when STREAMING_PUBLIC_BET_URL (or client override) is configured.
 * pointer-events: auto only on the link; rest of overlay stays non-interactive.
 */

import React, { useMemo } from "react";

export interface StreamingBettingConfig {
  configured: boolean;
  betUrl: string | null;
  bettingBridgeEnabled: boolean;
  ready: boolean;
  unavailableReason: string | null;
  checkedAt: number;
  hint?: string | null;
}

function buildBetHref(base: string, duelId: string | null): string {
  if (!duelId) return base;
  try {
    const u = new URL(base, window.location.href);
    u.searchParams.set("duel", duelId);
    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}duel=${encodeURIComponent(duelId)}`;
  }
}

function formatMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface StreamingBettingRailProps {
  config: StreamingBettingConfig | null;
  phase: string | undefined;
  duelId: string | null | undefined;
  agent1Name: string | null | undefined;
  agent2Name: string | null | undefined;
  timeRemainingMs: number;
  /** Exact public arena-staging authority for an announced matchup. */
  arenaReady?: boolean;
  cancelled?: boolean;
}

export function StreamingBettingRail({
  config,
  phase,
  duelId,
  agent1Name,
  agent2Name,
  timeRemainingMs,
  arenaReady = false,
  cancelled = false,
}: StreamingBettingRailProps) {
  const betUrl = config?.betUrl?.trim() || null;
  const configured = config?.configured === true;
  const ready = config?.ready === true;
  const hasMatchup = Boolean(agent1Name && agent2Name);

  const href = useMemo(
    () => (betUrl ? buildBetHref(betUrl, duelId ?? null) : ""),
    [betUrl, duelId],
  );

  if ((!betUrl && !configured) || (!hasMatchup && !cancelled)) return null;

  if (phase === "IDLE" && !cancelled) return null;

  const title = hasMatchup
    ? `${agent1Name} vs ${agent2Name}`
    : "Cancelled round";

  let headline = "Spectate";
  let sub = "Betting link is live for this matchup.";
  let urgency: "open" | "locked" | "done" = "open";
  let actionEnabled = ready;

  if (!ready && cancelled) {
    headline = "No contest";
    sub =
      "No winner was declared. Refund status is temporarily unavailable while betting services recover.";
    urgency = "done";
    actionEnabled = false;
  } else if (!ready) {
    headline = "Betting unavailable";
    sub =
      "Market access will appear when the stream and settlement services are ready.";
    urgency = "locked";
    actionEnabled = false;
  } else if (cancelled) {
    headline = "No contest";
    sub = config?.bettingBridgeEnabled
      ? "No winner was declared. Open the betting app to review this market's refund status."
      : "No winner was declared for this round.";
    urgency = "done";
  } else if (phase === "ANNOUNCEMENT" && !arenaReady) {
    headline = "Arena handoff";
    sub =
      "Betting remains unavailable until both fighters are confirmed in the arena.";
    urgency = "locked";
    actionEnabled = false;
  } else if (phase === "ANNOUNCEMENT") {
    if (timeRemainingMs > 0) {
      headline = "Betting open";
      sub = `Wagers lock at the announced deadline. Closes in ${formatMmSs(timeRemainingMs)}.`;
      urgency = "open";
    } else {
      headline = "Betting locked";
      sub = "Lines are closed while officials complete the final arena checks.";
      urgency = "locked";
    }
  } else if (phase === "COUNTDOWN" || phase === "FIGHTING") {
    headline = "Betting locked";
    sub = "Lines are closed — enjoy the fight.";
    urgency = "locked";
  } else if (phase === "RESOLUTION") {
    headline = "Fight over";
    sub = config?.bettingBridgeEnabled
      ? "On-chain markets resolve after the oracle reports — check your wallet for payouts."
      : "Thanks for watching — see you on the next card.";
    urgency = "done";
  }

  const actionLabel = actionEnabled
    ? urgency === "open"
      ? "Place a bet"
      : "Open betting app"
    : "Betting unavailable";
  const compactStateLabel = headline === actionLabel ? null : headline;

  return (
    <aside
      className={`streaming-betting-rail streaming-betting-rail--${urgency}`}
    >
      <div className="streaming-betting-rail-eyebrow">Pick a side</div>
      <div className="streaming-betting-rail-title">{title}</div>
      <div className="streaming-betting-rail-headline">{headline}</div>
      <p className="streaming-betting-rail-sub">{sub}</p>
      {actionEnabled ? (
        <a
          className="streaming-betting-rail-cta"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {compactStateLabel ? (
            <span className="streaming-betting-rail-cta-state">
              {compactStateLabel}
            </span>
          ) : null}
          <span>{actionLabel}</span>
        </a>
      ) : (
        <span
          className="streaming-betting-rail-cta streaming-betting-rail-cta--disabled"
          aria-disabled="true"
        >
          {compactStateLabel ? (
            <span className="streaming-betting-rail-cta-state">
              {compactStateLabel}
            </span>
          ) : null}
          <span>{actionLabel}</span>
        </span>
      )}
      {config?.hint && urgency === "open" ? (
        <p className="streaming-betting-rail-hint">{config.hint}</p>
      ) : null}
    </aside>
  );
}
