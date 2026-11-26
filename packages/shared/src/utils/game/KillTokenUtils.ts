/**
 * Kill Token Utilities
 *
 * Binds one authoritative mob death to its killer, timestamp, durable
 * mob-loot operation identity, lethal combat style, and XP damage authority.
 * The helper uses the standard Web Crypto API so it works in the production
 * ESM server without a CommonJS `require` shim.
 */

const MAX_KILL_EVENT_AGE_MS = 5_000;
/** Maximum full-health value accepted as one mob kill-XP authority. */
export const MAX_MOB_COMBAT_DAMAGE = 250_000;
const MOB_LOOT_OPERATION_ID_PATTERN =
  /^ground-item-mob-loot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KILL_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

let secretWarningLogged = false;
let developmentSecret: string | null = null;
let cachedSecret: string | null = null;
let cachedKey: ReturnType<
  NonNullable<typeof globalThis.crypto>["subtle"]["importKey"]
> | null = null;

function getSubtleCrypto():
  NonNullable<typeof globalThis.crypto>["subtle"] | null {
  return globalThis.crypto?.subtle ?? null;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function getSecret(): string {
  const configured =
    typeof process !== "undefined"
      ? process.env?.KILL_TOKEN_SECRET?.trim()
      : undefined;
  if (configured) {
    if (encoder.encode(configured).byteLength < 32) {
      throw new Error("KILL_TOKEN_SECRET must contain at least 32 bytes");
    }
    return configured;
  }

  const isProduction =
    typeof process !== "undefined" && process.env?.NODE_ENV === "production";
  if (isProduction) {
    throw new Error(
      "KILL_TOKEN_SECRET environment variable is required in production",
    );
  }

  if (!secretWarningLogged) {
    console.warn(
      "[KillTokenUtils] Using a process-local development secret. Set KILL_TOKEN_SECRET in production.",
    );
    secretWarningLogged = true;
  }

  if (!developmentSecret) {
    const random = new Uint8Array(32);
    globalThis.crypto?.getRandomValues(random);
    developmentSecret = `dev-${bytesToHex(random)}`;
  }
  return developmentSecret;
}

function serializeKillAuthority(
  mobId: string,
  killedBy: string,
  timestamp: number,
  lootOperationId: string,
  attackStyle: string,
  damageDealt: number,
): string {
  return JSON.stringify({
    version: 3,
    mobId,
    killedBy,
    timestamp,
    lootOperationId,
    attackStyle,
    damageDealt,
  });
}

async function importHmacKey(secret: string) {
  const subtle = getSubtleCrypto();
  if (!subtle) throw new Error("kill_token_crypto_unavailable");
  if (cachedSecret === secret && cachedKey) return cachedKey;
  cachedSecret = secret;
  cachedKey = subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  try {
    return await cachedKey;
  } catch (error) {
    cachedSecret = null;
    cachedKey = null;
    throw error;
  }
}

/** Generate a full HMAC-SHA256 token for one exact mob death occurrence. */
export async function generateKillToken(
  mobId: string,
  killedBy: string,
  timestamp: number,
  lootOperationId: string,
  attackStyle: string,
  damageDealt: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(damageDealt) ||
    damageDealt <= 0 ||
    damageDealt > MAX_MOB_COMBAT_DAMAGE
  ) {
    throw new Error("kill_token_damage_authority_invalid");
  }
  const subtle = getSubtleCrypto();
  if (!subtle) throw new Error("kill_token_crypto_unavailable");
  const key = await importHmacKey(getSecret());
  const signature = await subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      serializeKillAuthority(
        mobId,
        killedBy,
        timestamp,
        lootOperationId,
        attackStyle,
        damageDealt,
      ),
    ),
  );
  return bytesToHex(new Uint8Array(signature));
}

/** Validate exact operation identity and the complete HMAC without an age gate. */
export async function validateKillTokenSignature(
  mobId: string,
  killedBy: string,
  timestamp: number,
  token: string,
  lootOperationId: string,
  attackStyle: string,
  damageDealt: number,
): Promise<boolean> {
  const subtle = getSubtleCrypto();
  if (
    !subtle ||
    !mobId ||
    !killedBy ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !attackStyle ||
    attackStyle.length > 32 ||
    !Number.isSafeInteger(damageDealt) ||
    damageDealt <= 0 ||
    damageDealt > MAX_MOB_COMBAT_DAMAGE ||
    !KILL_TOKEN_PATTERN.test(token) ||
    !MOB_LOOT_OPERATION_ID_PATTERN.test(lootOperationId)
  ) {
    return false;
  }

  try {
    const key = await importHmacKey(getSecret());
    return await subtle.verify(
      "HMAC",
      key,
      hexToBytes(token),
      encoder.encode(
        serializeKillAuthority(
          mobId,
          killedBy,
          timestamp,
          lootOperationId,
          attackStyle,
          damageDealt,
        ),
      ),
    );
  } catch {
    return false;
  }
}

/** Validate freshness, exact operation identity, and the complete HMAC. */
export async function validateKillToken(
  mobId: string,
  killedBy: string,
  timestamp: number,
  token: string,
  lootOperationId: string,
  attackStyle: string,
  damageDealt: number,
): Promise<boolean> {
  if (Math.abs(Date.now() - timestamp) > MAX_KILL_EVENT_AGE_MS) return false;
  return validateKillTokenSignature(
    mobId,
    killedBy,
    timestamp,
    token,
    lootOperationId,
    attackStyle,
    damageDealt,
  );
}

export function isKillTokenValidationAvailable(): boolean {
  return getSubtleCrypto() !== null;
}
