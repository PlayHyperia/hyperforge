import { createHash, timingSafeEqual } from "node:crypto";

type BettingFeedTokenParams = {
  authorizationHeader?: string | string[];
};

export type BettingFeedAccessTokenResolution = {
  token: string | null;
  previousToken: string | null;
  previousTokenExpiresAtMs: number | null;
  rotationState: "inactive" | "active" | "expired" | "invalid";
  configurationError:
    | "previous_token_requires_current_token"
    | "previous_token_requires_expiry"
    | "previous_token_duplicates_current_token"
    | "previous_token_expiry_without_previous_token"
    | "previous_token_expiry_invalid"
    | null;
  source: "betting-feed" | null;
};

export type BettingFeedAuthorization = {
  kind: "current" | "previous";
  authorizedUntilMs: number | null;
  credentialDigest: string;
};

export type BettingFeedAuthorizationStatus = {
  active: boolean;
  authorizedUntilMs: number | null;
};

export function shouldSkipBettingFeedAuth(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.NODE_ENV === "development" &&
    (env.BETTING_FEED_SKIP_AUTH || "").trim().toLowerCase() === "true"
  );
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function credentialDigest(token: string): string {
  return digestToken(token.trim()).toString("hex");
}

function hasCredentialDigest(token: string, digest: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;
  return timingSafeEqual(digestToken(token.trim()), Buffer.from(digest, "hex"));
}

export function extractBettingFeedToken(
  params: BettingFeedTokenParams,
): string | null {
  const authHeader = Array.isArray(params.authorizationHeader)
    ? params.authorizationHeader[0]
    : params.authorizationHeader;
  const headerToken =
    authHeader && /^Bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^Bearer\s+/i, "").trim()
      : null;
  if (headerToken) {
    return headerToken;
  }
  return null;
}

export function hasValidBettingFeedToken(
  requiredToken: string,
  providedToken: string | null | undefined,
): boolean {
  const expected = requiredToken.trim();
  const presented = providedToken?.trim() ?? "";
  // Early return for missing/empty tokens is intentional: whether a token was
  // provided is already observable from the request headers and is not a secret.
  // Timing-safe comparison only matters when comparing two non-empty values.
  if (!expected || !presented) {
    return false;
  }

  return timingSafeEqual(digestToken(expected), digestToken(presented));
}

export function hasValidBettingFeedTokenSet(
  requiredTokens: Array<string | null | undefined>,
  providedToken: string | null | undefined,
): boolean {
  return requiredTokens.some(
    (requiredToken) =>
      Boolean(requiredToken?.trim()) &&
      hasValidBettingFeedToken(requiredToken!, providedToken),
  );
}

export function resolveBettingFeedAccessToken(
  env: Record<string, string | undefined>,
  nowMs = Date.now(),
): BettingFeedAccessTokenResolution {
  const bettingFeedToken = env.BETTING_FEED_ACCESS_TOKEN?.trim() || null;
  const previousCandidate =
    env.BETTING_FEED_ACCESS_TOKEN_PREVIOUS?.trim() || null;
  const expiryCandidate =
    env.BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS?.trim() || null;
  const base = {
    token: bettingFeedToken,
    previousToken: null,
    previousTokenExpiresAtMs: null,
    source: bettingFeedToken ? ("betting-feed" as const) : null,
  };

  if (!bettingFeedToken && previousCandidate) {
    return {
      ...base,
      rotationState: "invalid",
      configurationError: "previous_token_requires_current_token",
    };
  }
  if (!previousCandidate && expiryCandidate) {
    return {
      ...base,
      rotationState: "invalid",
      configurationError: "previous_token_expiry_without_previous_token",
    };
  }
  if (previousCandidate === bettingFeedToken && previousCandidate) {
    return {
      ...base,
      rotationState: "invalid",
      configurationError: "previous_token_duplicates_current_token",
    };
  }
  if (previousCandidate && !expiryCandidate) {
    return {
      ...base,
      rotationState: "invalid",
      configurationError: "previous_token_requires_expiry",
    };
  }
  if (!previousCandidate) {
    return {
      ...base,
      rotationState: "inactive",
      configurationError: null,
    };
  }

  if (!/^[1-9]\d*$/.test(expiryCandidate!)) {
    return {
      ...base,
      rotationState: "invalid",
      configurationError: "previous_token_expiry_invalid",
    };
  }
  const previousTokenExpiresAtMs = Number(expiryCandidate);
  if (!Number.isSafeInteger(previousTokenExpiresAtMs)) {
    return {
      ...base,
      rotationState: "invalid",
      configurationError: "previous_token_expiry_invalid",
    };
  }
  if (nowMs >= previousTokenExpiresAtMs) {
    return {
      ...base,
      previousTokenExpiresAtMs,
      rotationState: "expired",
      configurationError: null,
    };
  }

  return {
    ...base,
    previousToken: previousCandidate,
    previousTokenExpiresAtMs,
    rotationState: "active",
    configurationError: null,
  };
}

export function authorizeBettingFeedToken(
  resolution: BettingFeedAccessTokenResolution,
  providedToken: string | null | undefined,
  nowMs = Date.now(),
): BettingFeedAuthorization | null {
  const presented = providedToken?.trim() ?? "";
  if (resolution.configurationError || !presented) return null;

  if (
    resolution.token &&
    hasValidBettingFeedToken(resolution.token, presented)
  ) {
    return {
      kind: "current",
      authorizedUntilMs: null,
      credentialDigest: credentialDigest(presented),
    };
  }
  if (
    resolution.previousToken &&
    resolution.previousTokenExpiresAtMs !== null &&
    nowMs < resolution.previousTokenExpiresAtMs &&
    hasValidBettingFeedToken(resolution.previousToken, presented)
  ) {
    return {
      kind: "previous",
      authorizedUntilMs: resolution.previousTokenExpiresAtMs,
      credentialDigest: credentialDigest(presented),
    };
  }
  return null;
}

export function resolveBettingFeedAuthorizationStatus(
  resolution: BettingFeedAccessTokenResolution,
  authorization: BettingFeedAuthorization,
  nowMs = Date.now(),
): BettingFeedAuthorizationStatus {
  if (resolution.configurationError) {
    return { active: false, authorizedUntilMs: null };
  }
  if (
    resolution.token &&
    hasCredentialDigest(resolution.token, authorization.credentialDigest)
  ) {
    return { active: true, authorizedUntilMs: null };
  }
  if (
    resolution.previousToken &&
    resolution.previousTokenExpiresAtMs !== null &&
    nowMs < resolution.previousTokenExpiresAtMs &&
    hasCredentialDigest(
      resolution.previousToken,
      authorization.credentialDigest,
    )
  ) {
    return {
      active: true,
      authorizedUntilMs: resolution.previousTokenExpiresAtMs,
    };
  }
  return { active: false, authorizedUntilMs: null };
}

export function isBettingFeedAuthorizationActive(
  resolution: BettingFeedAccessTokenResolution,
  authorization: BettingFeedAuthorization,
  nowMs = Date.now(),
): boolean {
  return resolveBettingFeedAuthorizationStatus(resolution, authorization, nowMs)
    .active;
}
