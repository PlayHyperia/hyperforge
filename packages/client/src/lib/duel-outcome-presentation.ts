export interface DuelTerminalNotice {
  cycleId: string;
  duelId: string | null;
  outcome: "cancelled";
  reason: string;
  occurredAt: number;
  expiresAt: number;
  agent1Id: string | null;
  agent1Name: string | null;
  agent2Id: string | null;
  agent2Name: string | null;
}

export function isDuelTerminalNotice(
  value: unknown,
): value is DuelTerminalNotice {
  if (!value || typeof value !== "object") return false;
  const notice = value as Partial<DuelTerminalNotice>;
  return (
    notice.outcome === "cancelled" &&
    typeof notice.cycleId === "string" &&
    typeof notice.reason === "string" &&
    Number.isFinite(notice.occurredAt) &&
    Number.isFinite(notice.expiresAt)
  );
}

export function getCancellationPresentation(reason: string): {
  eyebrow: string;
  title: string;
  sub: string;
} {
  const normalized = reason.toLowerCase();
  let explanation =
    "Arena officials stopped the round before an official result.";
  if (
    normalized.includes("no_combat_activity") ||
    normalized.includes("insufficient_verified_combat")
  ) {
    explanation = "The round ended without enough verified combat.";
  } else if (
    normalized.includes("missing") ||
    normalized.includes("lost") ||
    normalized.includes("disconnect") ||
    normalized.includes("contestant_unavailable")
  ) {
    explanation =
      "A contestant became unavailable before the result was official.";
  } else if (
    normalized.includes("shutdown") ||
    normalized.includes("broadcast_interrupted")
  ) {
    explanation = "The broadcast ended before the result was official.";
  }

  return {
    eyebrow: "Round cancelled",
    title: "No contest",
    sub: `${explanation} No winner was declared.`,
  };
}

export function formatDuelReason(reason: string | null | undefined): string {
  if (!reason) return "Result unavailable";
  return reason
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function formatTerminalMatchup(notice: DuelTerminalNotice): string {
  const names = [notice.agent1Name, notice.agent2Name].filter(
    (name): name is string => Boolean(name?.trim()),
  );
  return names.length === 2 ? `${names[0]} vs ${names[1]}` : "Round cancelled";
}
