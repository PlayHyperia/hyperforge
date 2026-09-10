import jsonwebtoken from "jsonwebtoken";
import { describe, expect, it } from "vitest";

import {
  assertJwtSigningKeyAuthority,
  HYPERIA_JWT_AUDIENCE,
  HYPERIA_JWT_ISSUER,
  resolveJwtSigningKeyAuthority,
  summarizeJwtSigningKeyAuthority,
} from "../jwt-signing-key-authority.js";

const OLD_SECRET = "old-secret-0123456789abcdef0123456789abcdef";
const NEW_SECRET = "new-secret-0123456789abcdef0123456789abcdef";

function keyRingEnv(
  activeKeyId = "2026-08-new",
  keys: Record<string, string> = {
    "2026-08-old": OLD_SECRET,
    "2026-08-new": NEW_SECRET,
  },
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    JWT_ACTIVE_KEY_ID: activeKeyId,
    JWT_SIGNING_KEYS: JSON.stringify(keys),
  };
}

describe("JWT signing-key authority", () => {
  it("resolves a keyed authority with an exact active key", () => {
    const authority = resolveJwtSigningKeyAuthority(keyRingEnv());

    expect(authority.mode).toBe("key-ring");
    expect(authority.activeKeyId).toBe("2026-08-new");
    expect(authority.activeSecret).toBe(NEW_SECRET);
    expect(Array.from(authority.keyedVerificationSecrets.keys())).toEqual([
      "2026-08-old",
      "2026-08-new",
    ]);
    expect(authority.legacyVerificationSecret).toBeNull();
  });

  it("retains the legacy no-kid secret only when explicitly configured", () => {
    const authority = resolveJwtSigningKeyAuthority({
      ...keyRingEnv(),
      JWT_SECRET: OLD_SECRET,
    });

    expect(authority.activeSecret).toBe(NEW_SECRET);
    expect(authority.legacyVerificationSecret).toBe(OLD_SECRET);
  });

  it("supports legacy-only and local fallback modes", () => {
    expect(
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_SECRET: OLD_SECRET,
      }).mode,
    ).toBe("legacy");
    expect(resolveJwtSigningKeyAuthority({ NODE_ENV: "test" }).mode).toBe(
      "development-fallback",
    );
  });

  it("fails closed for absent or weak production authority", () => {
    expect(() =>
      resolveJwtSigningKeyAuthority({ NODE_ENV: "production" }),
    ).toThrow("Configure JWT_SIGNING_KEYS");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "staging",
        JWT_SECRET: "too-short",
      }),
    ).toThrow("at least 32 bytes");
  });

  it("rejects incomplete, malformed, ambiguous, and oversized key rings", () => {
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_SIGNING_KEYS: JSON.stringify({ current: NEW_SECRET }),
      }),
    ).toThrow("JWT_ACTIVE_KEY_ID is required");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "current",
      }),
    ).toThrow("JWT_SIGNING_KEYS is required");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "missing",
        JWT_SIGNING_KEYS: JSON.stringify({ current: NEW_SECRET }),
      }),
    ).toThrow("must identify a key");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "bad key",
        JWT_SIGNING_KEYS: JSON.stringify({ "bad key": NEW_SECRET }),
      }),
    ).toThrow("invalid key ID");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "legacy-no-kid",
        JWT_SIGNING_KEYS: JSON.stringify({
          "legacy-no-kid": NEW_SECRET,
        }),
      }),
    ).toThrow("is invalid");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "current",
        JWT_SIGNING_KEYS: "not-json",
      }),
    ).toThrow("must be a JSON object");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "current",
        JWT_SIGNING_KEYS: JSON.stringify({ current: "too-short" }),
      }),
    ).toThrow("at least 32 bytes");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "current",
        JWT_SIGNING_KEYS: JSON.stringify({ current: "x".repeat(4_097) }),
      }),
    ).toThrow("must not exceed 4096 bytes");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "current",
        JWT_SIGNING_KEYS: JSON.stringify({
          current: NEW_SECRET,
          duplicate: NEW_SECRET,
        }),
      }),
    ).toThrow("must be unique");

    const tooMany = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `key-${index}`,
        `${String(index).padStart(2, "0")}-${NEW_SECRET}`,
      ]),
    );
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_ACTIVE_KEY_ID: "key-0",
        JWT_SIGNING_KEYS: JSON.stringify(tooMany),
      }),
    ).toThrow("between 1 and 16 keys");
  });

  it("rejects outer whitespace rather than silently changing key material", () => {
    expect(() =>
      resolveJwtSigningKeyAuthority({
        NODE_ENV: "production",
        JWT_SECRET: ` ${OLD_SECRET}`,
      }),
    ).toThrow("must not contain outer whitespace");
    expect(() =>
      resolveJwtSigningKeyAuthority({
        ...keyRingEnv(),
        JWT_ACTIVE_KEY_ID: " 2026-08-new",
      }),
    ).toThrow("must not contain outer whitespace");
  });

  it("produces stable non-secret fingerprints for replica comparison", () => {
    const summary = summarizeJwtSigningKeyAuthority(
      resolveJwtSigningKeyAuthority({
        ...keyRingEnv(),
        JWT_SECRET: OLD_SECRET,
      }),
    );

    expect(summary).toEqual({
      acceptsLegacyNoKidTokens: true,
      activeKeyId: "2026-08-new",
      keyFingerprints: {
        "2026-08-new": expect.stringMatching(/^[a-f0-9]{16}$/),
        "2026-08-old": expect.stringMatching(/^[a-f0-9]{16}$/),
        "legacy-no-kid": expect.stringMatching(/^[a-f0-9]{16}$/),
      },
      mode: "key-ring",
    });
    expect(JSON.stringify(summary)).not.toContain(OLD_SECRET);
    expect(JSON.stringify(summary)).not.toContain(NEW_SECRET);
  });

  it("exposes a startup assertion over the same strict resolver", () => {
    expect(assertJwtSigningKeyAuthority(keyRingEnv())).toMatchObject({
      activeKeyId: "2026-08-new",
      mode: "key-ring",
    });
  });

  it("defines the exact issuer and audience for keyed tokens", () => {
    const token = jsonwebtoken.sign({ userId: "account-1" }, NEW_SECRET, {
      algorithm: "HS256",
      audience: HYPERIA_JWT_AUDIENCE,
      issuer: HYPERIA_JWT_ISSUER,
      keyid: "2026-08-new",
    });
    const decoded = jsonwebtoken.decode(token, { complete: true });

    expect(decoded?.header).toMatchObject({
      alg: "HS256",
      kid: "2026-08-new",
      typ: "JWT",
    });
    expect(decoded?.payload).toMatchObject({
      aud: HYPERIA_JWT_AUDIENCE,
      iss: HYPERIA_JWT_ISSUER,
    });
  });
});
