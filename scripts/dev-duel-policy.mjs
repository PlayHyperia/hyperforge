const DUEL_MODEL_PROVIDER_KEY_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
]);

export function resolveDevDuelAgentMode(environment = {}) {
  return DUEL_MODEL_PROVIDER_KEY_NAMES.some((name) =>
    Boolean(String(environment[name] || "").trim()),
  )
    ? "model"
    : "deterministic";
}

export function assertMinimumConnectedDuelBots(stats, minimumConnected = 2) {
  const connected = Number(stats?.connectedBots);
  const total = Number(stats?.totalBots);
  if (
    !Number.isSafeInteger(minimumConnected) ||
    minimumConnected < 2 ||
    !Number.isSafeInteger(connected) ||
    !Number.isSafeInteger(total) ||
    connected < minimumConnected ||
    total < minimumConnected
  ) {
    throw new Error(
      `Duel startup requires at least ${minimumConnected} connected local agents; received ${Number.isFinite(connected) ? connected : 0}/${Number.isFinite(total) ? total : 0}. Check LOAD_TEST_MODE, the WebSocket URL, and server readiness.`,
    );
  }
  return Object.freeze({ connectedBots: connected, totalBots: total });
}
