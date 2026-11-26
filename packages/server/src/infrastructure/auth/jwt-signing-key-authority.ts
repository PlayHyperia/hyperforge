import { createHash } from "node:crypto";

export const HYPERIA_JWT_ALGORITHM = "HS256" as const;
export const HYPERIA_JWT_ISSUER = "hyperia-server";
export const HYPERIA_JWT_AUDIENCE = "hyperia-runtime";
export const JWT_ACTIVE_KEY_ID_ENV = "JWT_ACTIVE_KEY_ID";
export const JWT_SIGNING_KEYS_ENV = "JWT_SIGNING_KEYS";
export const JWT_LEGACY_SECRET_ENV = "JWT_SECRET";

const DEVELOPMENT_JWT_SECRET = "hyperia-dev-secret-key-12345";
const MINIMUM_PRODUCTION_SECRET_BYTES = 32;
const MAXIMUM_SECRET_BYTES = 4_096;
const MAXIMUM_KEY_RING_JSON_BYTES = 131_072;
const MAXIMUM_KEY_COUNT = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_KEY_IDS = new Set(["legacy-no-kid"]);

export type JwtSigningKeyAuthorityMode =
  "development-fallback" | "legacy" | "key-ring";

export type JwtSigningKeyAuthority = Readonly<
  | {
      activeKeyId: string;
      activeSecret: string;
      keyedVerificationSecrets: ReadonlyMap<string, string>;
      legacyVerificationSecret: string | null;
      mode: "key-ring";
    }
  | {
      activeKeyId: null;
      activeSecret: string;
      keyedVerificationSecrets: ReadonlyMap<string, string>;
      legacyVerificationSecret: string;
      mode: "development-fallback" | "legacy";
    }
>;

export type JwtSigningKeyAuthoritySummary = Readonly<{
  acceptsLegacyNoKidTokens: boolean;
  activeKeyId: string | null;
  keyFingerprints: Readonly<Record<string, string>>;
  mode: JwtSigningKeyAuthorityMode;
}>;

function isProductionLike(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.NODE_ENV === "staging";
}

function readOptionalEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  if (raw.trim() !== raw) {
    throw new Error(`[Security] ${name} must not contain outer whitespace`);
  }
  return raw;
}

function assertStrongSecret(secret: string, label: string): void {
  const secretBytes = Buffer.byteLength(secret, "utf8");
  if (secretBytes < MINIMUM_PRODUCTION_SECRET_BYTES) {
    throw new Error(
      `[Security] ${label} must contain at least ${MINIMUM_PRODUCTION_SECRET_BYTES} bytes`,
    );
  }
  if (secretBytes > MAXIMUM_SECRET_BYTES) {
    throw new Error(
      `[Security] ${label} must not exceed ${MAXIMUM_SECRET_BYTES} bytes`,
    );
  }
}

function parseSigningKeys(raw: string): ReadonlyMap<string, string> {
  if (Buffer.byteLength(raw, "utf8") > MAXIMUM_KEY_RING_JSON_BYTES) {
    throw new Error(
      `[Security] ${JWT_SIGNING_KEYS_ENV} must not exceed ${MAXIMUM_KEY_RING_JSON_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `[Security] ${JWT_SIGNING_KEYS_ENV} must be a JSON object of key IDs to secrets`,
    );
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error(
      `[Security] ${JWT_SIGNING_KEYS_ENV} must be a JSON object of key IDs to secrets`,
    );
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAXIMUM_KEY_COUNT) {
    throw new Error(
      `[Security] ${JWT_SIGNING_KEYS_ENV} must contain between 1 and ${MAXIMUM_KEY_COUNT} keys`,
    );
  }

  const keys = new Map<string, string>();
  const secrets = new Set<string>();
  for (const [keyId, value] of entries) {
    if (!KEY_ID_PATTERN.test(keyId) || RESERVED_KEY_IDS.has(keyId)) {
      throw new Error(
        `[Security] JWT signing key ID ${JSON.stringify(keyId)} is invalid`,
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `[Security] JWT signing key ${JSON.stringify(keyId)} must be a non-empty string`,
      );
    }
    if (value.trim() !== value) {
      throw new Error(
        `[Security] JWT signing key ${JSON.stringify(keyId)} must not contain outer whitespace`,
      );
    }
    assertStrongSecret(value, `JWT signing key ${JSON.stringify(keyId)}`);
    if (secrets.has(value)) {
      throw new Error(
        "[Security] JWT signing key secrets must be unique within the key ring",
      );
    }
    secrets.add(value);
    keys.set(keyId, value);
  }
  return keys;
}

export function resolveJwtSigningKeyAuthority(
  env: NodeJS.ProcessEnv = process.env,
): JwtSigningKeyAuthority {
  const activeKeyId = readOptionalEnvironmentValue(env, JWT_ACTIVE_KEY_ID_ENV);
  const signingKeysRaw = readOptionalEnvironmentValue(
    env,
    JWT_SIGNING_KEYS_ENV,
  );
  const legacySecret = readOptionalEnvironmentValue(env, JWT_LEGACY_SECRET_ENV);

  if (signingKeysRaw !== null) {
    if (activeKeyId === null) {
      throw new Error(
        `[Security] ${JWT_ACTIVE_KEY_ID_ENV} is required when ${JWT_SIGNING_KEYS_ENV} is configured`,
      );
    }
    if (!KEY_ID_PATTERN.test(activeKeyId)) {
      throw new Error(
        `[Security] ${JWT_ACTIVE_KEY_ID_ENV} contains an invalid key ID`,
      );
    }

    const keyedVerificationSecrets = parseSigningKeys(signingKeysRaw);
    const activeSecret = keyedVerificationSecrets.get(activeKeyId);
    if (!activeSecret) {
      throw new Error(
        `[Security] ${JWT_ACTIVE_KEY_ID_ENV} must identify a key in ${JWT_SIGNING_KEYS_ENV}`,
      );
    }
    if (legacySecret !== null && isProductionLike(env)) {
      assertStrongSecret(legacySecret, JWT_LEGACY_SECRET_ENV);
    }
    return Object.freeze({
      activeKeyId,
      activeSecret,
      keyedVerificationSecrets,
      legacyVerificationSecret: legacySecret,
      mode: "key-ring" as const,
    });
  }

  if (activeKeyId !== null) {
    throw new Error(
      `[Security] ${JWT_SIGNING_KEYS_ENV} is required when ${JWT_ACTIVE_KEY_ID_ENV} is configured`,
    );
  }

  if (legacySecret !== null) {
    if (isProductionLike(env)) {
      assertStrongSecret(legacySecret, JWT_LEGACY_SECRET_ENV);
    }
    return Object.freeze({
      activeKeyId: null,
      activeSecret: legacySecret,
      keyedVerificationSecrets: new Map<string, string>(),
      legacyVerificationSecret: legacySecret,
      mode: "legacy" as const,
    });
  }

  if (isProductionLike(env)) {
    throw new Error(
      `[Security] Configure ${JWT_SIGNING_KEYS_ENV} with ${JWT_ACTIVE_KEY_ID_ENV}, or provide ${JWT_LEGACY_SECRET_ENV} during migration`,
    );
  }

  return Object.freeze({
    activeKeyId: null,
    activeSecret: DEVELOPMENT_JWT_SECRET,
    keyedVerificationSecrets: new Map<string, string>(),
    legacyVerificationSecret: DEVELOPMENT_JWT_SECRET,
    mode: "development-fallback" as const,
  });
}

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

export function summarizeJwtSigningKeyAuthority(
  authority: JwtSigningKeyAuthority,
): JwtSigningKeyAuthoritySummary {
  const keyFingerprints: Record<string, string> = {};
  for (const [keyId, secret] of Array.from(
    authority.keyedVerificationSecrets.entries(),
  ).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    keyFingerprints[keyId] = fingerprint(secret);
  }
  if (authority.legacyVerificationSecret !== null) {
    keyFingerprints["legacy-no-kid"] = fingerprint(
      authority.legacyVerificationSecret,
    );
  }
  return Object.freeze({
    acceptsLegacyNoKidTokens: authority.legacyVerificationSecret !== null,
    activeKeyId: authority.activeKeyId,
    keyFingerprints: Object.freeze(keyFingerprints),
    mode: authority.mode,
  });
}

export function assertJwtSigningKeyAuthority(
  env: NodeJS.ProcessEnv = process.env,
): JwtSigningKeyAuthoritySummary {
  return summarizeJwtSigningKeyAuthority(resolveJwtSigningKeyAuthority(env));
}
