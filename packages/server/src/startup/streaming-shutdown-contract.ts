export type StreamingDuelShutdownAckConfig = Readonly<{
  url: string | null;
  timeoutMs: number;
}>;

type ShutdownAcknowledgementResponse = {
  running?: unknown;
  health?: {
    markets?: Array<{
      duelId?: unknown;
      lifecycleStatus?: unknown;
    }>;
  } | null;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_SHUTDOWN_ACK_TIMEOUT_MS = 15_000;
const MIN_SHUTDOWN_ACK_TIMEOUT_MS = 1_000;
const MAX_SHUTDOWN_ACK_TIMEOUT_MS = 20_000;

export function resolveStreamingDuelShutdownAckConfig(
  env: Record<string, string | undefined> = process.env,
): StreamingDuelShutdownAckConfig {
  const url = env.STREAMING_DUEL_SHUTDOWN_ACK_URL?.trim() || null;
  const rawTimeout =
    env.STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS?.trim() ||
    String(DEFAULT_SHUTDOWN_ACK_TIMEOUT_MS);
  const timeoutMs = Number.parseInt(rawTimeout, 10);

  if (!url) {
    if (
      env.NODE_ENV === "production" &&
      env.HYPERIA_EXTERNAL_VALUE_ENABLED === "true" &&
      env.STREAMING_DUEL_ENABLED === "true" &&
      env.STREAMING_DUEL_SCHEDULER_ROLE === "authority"
    ) {
      throw new Error(
        "STREAMING_DUEL_SHUTDOWN_ACK_URL is required for an external-value production authority",
      );
    }
    return { url: null, timeoutMs: DEFAULT_SHUTDOWN_ACK_TIMEOUT_MS };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "STREAMING_DUEL_SHUTDOWN_ACK_URL must be credential-free HTTP(S)",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error(
      "STREAMING_DUEL_SHUTDOWN_ACK_URL must be credential-free HTTP(S)",
    );
  }
  if (
    !/^\d+$/u.test(rawTimeout) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_SHUTDOWN_ACK_TIMEOUT_MS ||
    timeoutMs > MAX_SHUTDOWN_ACK_TIMEOUT_MS
  ) {
    throw new Error(
      "STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS must be 1000..20000",
    );
  }

  return { url: parsed.toString(), timeoutMs };
}

export async function waitForStreamingDuelShutdownAcknowledgement(input: {
  config: StreamingDuelShutdownAckConfig;
  duelId: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}): Promise<boolean> {
  if (!input.config.url) return false;
  const duelId = input.duelId.trim();
  if (!duelId) {
    throw new Error("shutdown terminal frame is missing its duel identity");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((durationMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const deadline = now() + input.config.timeoutMs;
  let lastFailure = "keeper acknowledgement was not observed";

  while (now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - now());
      const response = await fetchImpl(input.config.url, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
      });
      let body: ShutdownAcknowledgementResponse | null = null;
      try {
        const candidate = (await response.json()) as unknown;
        if (candidate && typeof candidate === "object") {
          body = candidate as ShutdownAcknowledgementResponse;
        }
      } catch {
        // Status handling below reports the authoritative transport failure.
      }
      const acknowledged =
        body?.running === true &&
        body.health?.markets?.some(
          (market) =>
            market.duelId === duelId && market.lifecycleStatus === "CANCELLED",
        ) === true;
      // The keeper's broad readiness endpoint becomes 503 when its upstream
      // source intentionally disappears during this shutdown. Its exact,
      // running bot-health snapshot is still authoritative evidence that the
      // named market cancellation completed. Never accept status alone.
      if (acknowledged) return true;
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        lastFailure = `duel ${duelId} is not CANCELLED`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = deadline - now();
    if (remainingMs > 0) await sleep(Math.min(250, remainingMs));
  }

  throw new Error(
    `Timed out waiting for shutdown cancellation acknowledgement: ${lastFailure}`,
  );
}
