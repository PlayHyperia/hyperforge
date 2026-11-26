import jsonwebtoken from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HYPERIA_JWT_AUDIENCE,
  HYPERIA_JWT_ISSUER,
} from "../../infrastructure/auth/jwt-signing-key-authority.js";
import { createJWT, verifyJWT } from "../utils.js";

const OLD_SECRET = "old-secret-0123456789abcdef0123456789abcdef";
const NEW_SECRET = "new-secret-0123456789abcdef0123456789abcdef";

function configureKeyRing(
  activeKeyId: "old" | "new" = "new",
  keys: Record<string, string> = { old: OLD_SECRET, new: NEW_SECRET },
  legacySecret = "",
): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("JWT_ACTIVE_KEY_ID", activeKeyId);
  vi.stubEnv("JWT_SIGNING_KEYS", JSON.stringify(keys));
  vi.stubEnv("JWT_SECRET", legacySecret);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("JWT utility key rotation", () => {
  it("issues an exact keyed token and verifies it", async () => {
    configureKeyRing();

    const token = await createJWT({ userId: "account-1" });
    const decoded = jsonwebtoken.decode(token, { complete: true });

    expect(decoded?.header).toMatchObject({
      alg: "HS256",
      kid: "new",
      typ: "JWT",
    });
    expect(decoded?.payload).toMatchObject({
      aud: HYPERIA_JWT_AUDIENCE,
      iss: HYPERIA_JWT_ISSUER,
      userId: "account-1",
    });
    expect(await verifyJWT(token)).toMatchObject({ userId: "account-1" });
  });

  it("accepts an old keyed token during overlap and rejects it after retirement", async () => {
    configureKeyRing("old");
    const oldToken = await createJWT({ userId: "account-old" });

    configureKeyRing("new");
    expect(await verifyJWT(oldToken)).toMatchObject({
      userId: "account-old",
    });

    configureKeyRing("new", { new: NEW_SECRET });
    expect(await verifyJWT(oldToken)).toBeNull();
  });

  it("accepts no-kid tokens only through the explicit legacy bridge", async () => {
    const legacyToken = jsonwebtoken.sign(
      { userId: "legacy-account" },
      OLD_SECRET,
      { algorithm: "HS256", expiresIn: "7d" },
    );

    configureKeyRing("new", { new: NEW_SECRET }, OLD_SECRET);
    expect(await verifyJWT(legacyToken)).toMatchObject({
      userId: "legacy-account",
    });

    configureKeyRing("new", { new: NEW_SECRET });
    expect(await verifyJWT(legacyToken)).toBeNull();
  });

  it("never falls an unknown kid back to the legacy secret", async () => {
    configureKeyRing("new", { new: NEW_SECRET }, OLD_SECRET);
    const token = jsonwebtoken.sign({ userId: "attacker" }, OLD_SECRET, {
      algorithm: "HS256",
      audience: HYPERIA_JWT_AUDIENCE,
      issuer: HYPERIA_JWT_ISSUER,
      keyid: "unknown",
    });

    expect(await verifyJWT(token)).toBeNull();
  });

  it("rejects keyed tokens with the wrong issuer, audience, type, or algorithm", async () => {
    configureKeyRing();
    const sign = (options: jsonwebtoken.SignOptions) =>
      jsonwebtoken.sign({ userId: "account-1" }, NEW_SECRET, options);

    expect(
      await verifyJWT(
        sign({
          algorithm: "HS256",
          audience: HYPERIA_JWT_AUDIENCE,
          issuer: "other-issuer",
          keyid: "new",
        }),
      ),
    ).toBeNull();
    expect(
      await verifyJWT(
        sign({
          algorithm: "HS256",
          audience: "other-audience",
          issuer: HYPERIA_JWT_ISSUER,
          keyid: "new",
        }),
      ),
    ).toBeNull();
    const wrongTypeToken = jsonwebtoken.sign(
      { userId: "account-1" },
      NEW_SECRET,
      {
        algorithm: "HS256",
        audience: HYPERIA_JWT_AUDIENCE,
        header: { alg: "HS256", kid: "new", typ: "not-jwt" },
        issuer: HYPERIA_JWT_ISSUER,
      },
    );
    expect(await verifyJWT(wrongTypeToken)).toBeNull();
    expect(
      await verifyJWT(
        sign({
          algorithm: "HS384",
          audience: HYPERIA_JWT_AUDIENCE,
          issuer: HYPERIA_JWT_ISSUER,
          keyid: "new",
        }),
      ),
    ).toBeNull();
  });

  it("preserves legacy-only issuance during migration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_ACTIVE_KEY_ID", "");
    vi.stubEnv("JWT_SIGNING_KEYS", "");
    vi.stubEnv("JWT_SECRET", OLD_SECRET);

    const token = await createJWT({ userId: "legacy-only" });
    const decoded = jsonwebtoken.decode(token, { complete: true });

    expect(decoded?.header).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(decoded?.header.kid).toBeUndefined();
    expect(await verifyJWT(token)).toMatchObject({ userId: "legacy-only" });
  });

  it("returns null for malformed, tampered, and expired tokens", async () => {
    configureKeyRing();
    const expired = jsonwebtoken.sign({ userId: "expired" }, NEW_SECRET, {
      algorithm: "HS256",
      audience: HYPERIA_JWT_AUDIENCE,
      expiresIn: -1,
      issuer: HYPERIA_JWT_ISSUER,
      keyid: "new",
    });

    expect(await verifyJWT("not-a-jwt")).toBeNull();
    expect(await verifyJWT(`${expired.slice(0, -1)}x`)).toBeNull();
    expect(await verifyJWT(expired)).toBeNull();
  });

  it("rejects missing and overlong lifetime claims", async () => {
    configureKeyRing();
    const baseOptions: jsonwebtoken.SignOptions = {
      algorithm: "HS256",
      audience: HYPERIA_JWT_AUDIENCE,
      issuer: HYPERIA_JWT_ISSUER,
      keyid: "new",
    };
    const noExpiry = jsonwebtoken.sign(
      { userId: "no-expiry" },
      NEW_SECRET,
      baseOptions,
    );
    const overlong = jsonwebtoken.sign({ userId: "overlong" }, NEW_SECRET, {
      ...baseOptions,
      expiresIn: "8d",
    });

    expect(await verifyJWT(noExpiry)).toBeNull();
    expect(await verifyJWT(overlong)).toBeNull();
  });
});
