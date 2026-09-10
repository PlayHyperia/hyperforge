import { describe, expect, it } from "vitest";
import {
  authorizeBettingFeedToken,
  extractBettingFeedToken,
  hasValidBettingFeedToken,
  hasValidBettingFeedTokenSet,
  isBettingFeedAuthorizationActive,
  resolveBettingFeedAccessToken,
  resolveBettingFeedAuthorizationStatus,
  shouldSkipBettingFeedAuth,
} from "../../../src/routes/streaming-betting-auth.js";

describe("streaming-betting-auth", () => {
  it("accepts a matching token", () => {
    expect(hasValidBettingFeedToken("secret-token", "secret-token")).toBe(true);
  });

  it("rejects a missing token", () => {
    expect(hasValidBettingFeedToken("secret-token", null)).toBe(false);
  });

  it("rejects a mismatched token", () => {
    expect(hasValidBettingFeedToken("secret-token", "secret-token-2")).toBe(
      false,
    );
  });

  it("rejects a token with a different length", () => {
    expect(hasValidBettingFeedToken("secret-token", "short")).toBe(false);
  });

  it("accepts either current or previous token during a bounded rotation", () => {
    expect(
      hasValidBettingFeedTokenSet(
        ["current-secret", "previous-secret"],
        "current-secret",
      ),
    ).toBe(true);
    expect(
      hasValidBettingFeedTokenSet(
        ["current-secret", "previous-secret"],
        "previous-secret",
      ),
    ).toBe(true);
    expect(
      hasValidBettingFeedTokenSet(
        ["current-secret", "previous-secret"],
        "retired-secret",
      ),
    ).toBe(false);
  });

  it("extracts a bearer token case-insensitively from the authorization header", () => {
    expect(
      extractBettingFeedToken({
        authorizationHeader: "bearer secret-token",
      }),
    ).toBe("secret-token");
  });

  it("does not accept query tokens unless the route explicitly allows them", () => {
    expect(extractBettingFeedToken({})).toBeNull();
  });

  it("prefers BETTING_FEED_ACCESS_TOKEN over the viewer token", () => {
    expect(
      resolveBettingFeedAccessToken({
        BETTING_FEED_ACCESS_TOKEN: "bet-secret",
        STREAMING_VIEWER_ACCESS_TOKEN: "viewer-secret",
      }),
    ).toEqual({
      token: "bet-secret",
      previousToken: null,
      previousTokenExpiresAtMs: null,
      rotationState: "inactive",
      configurationError: null,
      source: "betting-feed",
    });
  });

  it("does not fall back to STREAMING_VIEWER_ACCESS_TOKEN when needed", () => {
    expect(
      resolveBettingFeedAccessToken({
        BETTING_FEED_ACCESS_TOKEN: "",
        STREAMING_VIEWER_ACCESS_TOKEN: "viewer-secret",
      }),
    ).toEqual({
      token: null,
      previousToken: null,
      previousTokenExpiresAtMs: null,
      rotationState: "inactive",
      configurationError: null,
      source: null,
    });
  });

  it("reports missing auth when neither token is configured", () => {
    expect(resolveBettingFeedAccessToken({})).toEqual({
      token: null,
      previousToken: null,
      previousTokenExpiresAtMs: null,
      rotationState: "inactive",
      configurationError: null,
      source: null,
    });
  });

  it("accepts a distinct previous token only until its exact expiry", () => {
    expect(
      resolveBettingFeedAccessToken(
        {
          BETTING_FEED_ACCESS_TOKEN: "current",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "previous",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2000",
        },
        1_999,
      ),
    ).toEqual({
      token: "current",
      previousToken: "previous",
      previousTokenExpiresAtMs: 2_000,
      rotationState: "active",
      configurationError: null,
      source: "betting-feed",
    });
    expect(
      resolveBettingFeedAccessToken(
        {
          BETTING_FEED_ACCESS_TOKEN: "current",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "previous",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2000",
        },
        2_000,
      ),
    ).toEqual({
      token: "current",
      previousToken: null,
      previousTokenExpiresAtMs: 2_000,
      rotationState: "expired",
      configurationError: null,
      source: "betting-feed",
    });
  });

  it("rejects incomplete, duplicate, orphaned, and malformed rotation settings", () => {
    const invalidCases = [
      {
        env: {
          BETTING_FEED_ACCESS_TOKEN: "current",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "previous",
        },
        error: "previous_token_requires_expiry",
      },
      {
        env: {
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "previous",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2000",
        },
        error: "previous_token_requires_current_token",
      },
      {
        env: {
          BETTING_FEED_ACCESS_TOKEN: "current",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2000",
        },
        error: "previous_token_expiry_without_previous_token",
      },
      {
        env: {
          BETTING_FEED_ACCESS_TOKEN: "same",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "same",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2000",
        },
        error: "previous_token_duplicates_current_token",
      },
      {
        env: {
          BETTING_FEED_ACCESS_TOKEN: "current",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "previous",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2e3",
        },
        error: "previous_token_expiry_invalid",
      },
      {
        env: {
          BETTING_FEED_ACCESS_TOKEN: "current",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "previous",
          BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "9007199254740992",
        },
        error: "previous_token_expiry_invalid",
      },
    ] as const;

    for (const testCase of invalidCases) {
      expect(resolveBettingFeedAccessToken(testCase.env, 1_000)).toMatchObject({
        rotationState: "invalid",
        configurationError: testCase.error,
        previousToken: null,
      });
    }
  });

  it("authorizes the current token indefinitely and the previous token only within the overlap", () => {
    const resolution = resolveBettingFeedAccessToken(
      {
        BETTING_FEED_ACCESS_TOKEN: "current",
        BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "previous",
        BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2000",
      },
      1_000,
    );

    expect(
      authorizeBettingFeedToken(resolution, "current", 1_000),
    ).toMatchObject({
      kind: "current",
      authorizedUntilMs: null,
    });
    expect(
      authorizeBettingFeedToken(resolution, "previous", 1_999),
    ).toMatchObject({
      kind: "previous",
      authorizedUntilMs: 2_000,
    });
    expect(authorizeBettingFeedToken(resolution, "previous", 2_000)).toBeNull();
    expect(authorizeBettingFeedToken(resolution, "retired", 1_000)).toBeNull();
  });

  it("revalidates long-lived credentials across rotation and retirement", () => {
    const original = resolveBettingFeedAccessToken({
      BETTING_FEED_ACCESS_TOKEN: "old-current",
    });
    const authorization = authorizeBettingFeedToken(
      original,
      "old-current",
      1_000,
    );
    expect(authorization).not.toBeNull();

    const overlap = resolveBettingFeedAccessToken(
      {
        BETTING_FEED_ACCESS_TOKEN: "new-current",
        BETTING_FEED_ACCESS_TOKEN_PREVIOUS: "old-current",
        BETTING_FEED_ACCESS_TOKEN_PREVIOUS_EXPIRES_AT_MS: "2000",
      },
      1_500,
    );
    expect(
      isBettingFeedAuthorizationActive(overlap, authorization!, 1_500),
    ).toBe(true);
    expect(
      resolveBettingFeedAuthorizationStatus(overlap, authorization!, 1_500),
    ).toEqual({ active: true, authorizedUntilMs: 2_000 });
    expect(
      isBettingFeedAuthorizationActive(overlap, authorization!, 2_000),
    ).toBe(false);

    const retired = resolveBettingFeedAccessToken({
      BETTING_FEED_ACCESS_TOKEN: "new-current",
    });
    expect(
      isBettingFeedAuthorizationActive(retired, authorization!, 1_500),
    ).toBe(false);
  });

  it("allows skip-auth only in development", () => {
    expect(
      shouldSkipBettingFeedAuth({
        NODE_ENV: "development",
        BETTING_FEED_SKIP_AUTH: "true",
      }),
    ).toBe(true);
    expect(
      shouldSkipBettingFeedAuth({
        NODE_ENV: "staging",
        BETTING_FEED_SKIP_AUTH: "true",
      }),
    ).toBe(false);
  });
});
