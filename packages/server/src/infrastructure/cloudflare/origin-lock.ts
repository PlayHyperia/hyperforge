import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CLOUDFLARE_ORIGIN_SECRET_HEADER } from "./origin-request.js";

export { CLOUDFLARE_ORIGIN_SECRET_HEADER } from "./origin-request.js";

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 512;
const DIGEST_DOMAIN = "hyperia/cloudflare-origin-lock/v1\0";

export type CloudflareOriginLockConfig = {
  enabled: boolean;
  fingerprint?: string;
};

function digestSecret(value: string): Buffer {
  return createHash("sha256").update(DIGEST_DOMAIN).update(value).digest();
}

/**
 * Resolve the optional edge-to-origin credential without silently changing it.
 * Empty means disabled; every configured value must be safe to transport as one
 * HTTP header value and carry enough entropy for a production shared secret.
 */
export function resolveCloudflareOriginSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = env.CLOUDFLARE_ORIGIN_SECRET;
  if (secret === undefined || secret === "") return undefined;

  const byteLength = Buffer.byteLength(secret, "utf8");
  if (byteLength < MIN_SECRET_BYTES || byteLength > MAX_SECRET_BYTES) {
    throw new Error(
      `CLOUDFLARE_ORIGIN_SECRET must be ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} bytes`,
    );
  }

  if (secret.trim() !== secret) {
    throw new Error(
      "CLOUDFLARE_ORIGIN_SECRET must not contain outer whitespace",
    );
  }

  // HTTP intermediaries may coalesce duplicate fields with commas. Excluding
  // commas makes a coalesced value unambiguously invalid.
  if (!/^[\x21-\x2b\x2d-\x7e]+$/.test(secret)) {
    throw new Error(
      "CLOUDFLARE_ORIGIN_SECRET must contain only visible ASCII characters other than commas",
    );
  }

  return secret;
}

export function getCloudflareOriginSecretFingerprint(secret: string): string {
  return digestSecret(secret).toString("hex").slice(0, 16);
}

function isPublicProbe(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const queryIndex = request.url.indexOf("?");
  const pathname =
    queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
  return pathname === "/health" || pathname === "/status";
}

function readSinglePresentedSecret(
  request: FastifyRequest,
): string | undefined {
  let occurrences = 0;
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === CLOUDFLARE_ORIGIN_SECRET_HEADER) {
      occurrences += 1;
    }
  }
  if (occurrences > 1) return undefined;

  const value = request.headers[CLOUDFLARE_ORIGIN_SECRET_HEADER];
  if (typeof value !== "string" || value.includes(",")) return undefined;
  return value;
}

function hasValidPresentedSecret(
  request: FastifyRequest,
  expectedDigest: Buffer,
): boolean {
  const presented = readSinglePresentedSecret(request);
  if (
    presented === undefined ||
    Buffer.byteLength(presented) > MAX_SECRET_BYTES
  ) {
    return false;
  }
  return timingSafeEqual(digestSecret(presented), expectedDigest);
}

/**
 * Install an opt-in edge-to-origin lock. The edge must overwrite the header on
 * every forwarded request; clients must never be given this credential.
 */
export function registerCloudflareOriginLock(
  fastify: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
): CloudflareOriginLockConfig {
  const secret = resolveCloudflareOriginSecret(env);
  if (!secret) return { enabled: false };

  const expectedDigest = digestSecret(secret);
  fastify.addHook("onRequest", async (request, reply) => {
    if (isPublicProbe(request)) return;

    if (!hasValidPresentedSecret(request, expectedDigest)) {
      return reply
        .code(403)
        .header("Cache-Control", "no-store")
        .send({ error: "Forbidden" });
    }
  });

  return {
    enabled: true,
    fingerprint: getCloudflareOriginSecretFingerprint(secret),
  };
}
