/**
 * Canonical stream timing policy for anti-cheat public surfaces.
 *
 * The owned HLS output is canonical unless an operator explicitly configures
 * both another platform and its public player URL. RTMP destinations remain
 * fanout outputs and never silently change the bettor-facing source.
 */

export type StreamingCanonicalPlatform = "hls" | "youtube" | "twitch";

export type StreamingPolicyEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type StreamingCanonicalPolicy = Readonly<{
  platform: StreamingCanonicalPlatform;
  sourceUrl: string;
  publicDelayDefaultMs: number;
  publicDelayMs: number;
  publicDelayOverridden: boolean;
}>;

const DEFAULT_DELAY_BY_PLATFORM_MS: Record<StreamingCanonicalPlatform, number> =
  {
    hls: 4000,
    youtube: 15000,
    twitch: 12000,
  };

const DEFAULT_HLS_SOURCE_URL = "/live/stream.m3u8";

function parseCanonicalPlatform(
  raw: string | undefined,
): StreamingCanonicalPlatform {
  const normalized = (raw || "").trim().toLowerCase() || "hls";
  if (
    normalized === "hls" ||
    normalized === "youtube" ||
    normalized === "twitch"
  ) {
    return normalized;
  }
  throw new Error(
    "STREAMING_CANONICAL_PLATFORM must be one of: hls, youtube, twitch",
  );
}

function parseCanonicalSourceUrl(
  raw: string | undefined,
  platform: StreamingCanonicalPlatform,
): string {
  const value = (raw || "").trim();
  if (!value) {
    if (platform === "hls") return DEFAULT_HLS_SOURCE_URL;
    throw new Error(
      `STREAMING_CANONICAL_SOURCE_URL is required when STREAMING_CANONICAL_PLATFORM=${platform}`,
    );
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    if (value.includes("\\") || value.includes("#")) {
      throw new Error(
        "STREAMING_CANONICAL_SOURCE_URL must be a public HTTP(S) URL or a root-relative path without a fragment",
      );
    }
    return value;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "STREAMING_CANONICAL_SOURCE_URL must be a valid public HTTP(S) URL or root-relative path",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(
      "STREAMING_CANONICAL_SOURCE_URL must be a public HTTP(S) URL without credentials or a fragment",
    );
  }
  return value;
}

function parseDelayOverride(raw: string | undefined): number | null {
  if (!raw || raw.trim().length === 0) return null;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("STREAMING_PUBLIC_DELAY_MS must be a non-negative integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      "STREAMING_PUBLIC_DELAY_MS must be a non-negative safe integer",
    );
  }
  return parsed;
}

export function resolveStreamingCanonicalPolicy(
  environment: StreamingPolicyEnvironment,
): StreamingCanonicalPolicy {
  const platform = parseCanonicalPlatform(
    environment.STREAMING_CANONICAL_PLATFORM,
  );
  const sourceUrl = parseCanonicalSourceUrl(
    environment.STREAMING_CANONICAL_SOURCE_URL,
    platform,
  );
  const publicDelayDefaultMs = DEFAULT_DELAY_BY_PLATFORM_MS[platform];
  const publicDelayOverrideMs = parseDelayOverride(
    environment.STREAMING_PUBLIC_DELAY_MS,
  );

  return {
    platform,
    sourceUrl,
    publicDelayDefaultMs,
    publicDelayMs: publicDelayOverrideMs ?? publicDelayDefaultMs,
    publicDelayOverridden: publicDelayOverrideMs !== null,
  };
}

export const STREAMING_CANONICAL_POLICY = resolveStreamingCanonicalPolicy(
  process.env,
);

export const STREAMING_CANONICAL_PLATFORM = STREAMING_CANONICAL_POLICY.platform;

export const STREAMING_CANONICAL_SOURCE_URL =
  STREAMING_CANONICAL_POLICY.sourceUrl;

export const STREAMING_PUBLIC_DELAY_DEFAULT_MS =
  STREAMING_CANONICAL_POLICY.publicDelayDefaultMs;

export const STREAMING_PUBLIC_DELAY_OVERRIDDEN =
  STREAMING_CANONICAL_POLICY.publicDelayOverridden;

export const STREAMING_PUBLIC_DELAY_MS =
  STREAMING_CANONICAL_POLICY.publicDelayMs;
