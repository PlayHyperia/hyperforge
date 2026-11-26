export const toWinRatePercent = (wins: number, losses: number): number => {
  const safeWins = Number.isFinite(wins) ? Math.max(0, wins) : 0;
  const safeLosses = Number.isFinite(losses) ? Math.max(0, losses) : 0;
  const total = safeWins + safeLosses;
  if (total <= 0) {
    return 0;
  }
  return (safeWins / total) * 100;
};

export const formatWinLoss = (wins: number, losses: number): string => {
  const safeWins = Number.isFinite(wins) ? Math.max(0, Math.floor(wins)) : 0;
  const safeLosses = Number.isFinite(losses)
    ? Math.max(0, Math.floor(losses))
    : 0;
  return `${safeWins}-${safeLosses}`;
};

export const formatWinDrawLoss = (
  wins: number,
  draws: number,
  losses: number,
): string => {
  const safeDraws = Number.isFinite(draws) ? Math.max(0, Math.floor(draws)) : 0;
  return `${formatWinLoss(wins, losses).replace("-", `-${safeDraws}-`)}`;
};

export const normalizeSearchTerm = (value: string): string =>
  value.trim().toLowerCase();

export const formatRelativeTime = (
  timestampMs: number,
  nowMs: number = Date.now(),
): string => {
  if (!Number.isFinite(timestampMs)) {
    return "Unknown";
  }

  const diffMs = Math.max(0, nowMs - timestampMs);
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

export const formatPhaseLabel = (phase: string): string => {
  if (!phase) return "Idle";
  const normalized = phase.toLowerCase();
  if (normalized === "announcement") return "Announcement";
  if (normalized === "countdown") return "Countdown";
  if (normalized === "fighting") return "Fighting";
  if (normalized === "resolution") return "Resolution";
  return "Idle";
};
