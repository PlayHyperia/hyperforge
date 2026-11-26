/**
 * Server Utility Functions
 *
 * This module provides core server-side utilities for file hashing and authentication.
 *
 * **File Hashing** (`hashFile`):
 * Creates SHA-256 hashes of uploaded files for content-addressable storage.
 * The hash algorithm matches the client-side implementation exactly to ensure
 * consistent file identification across client and server. This enables:
 * - Deduplication of uploaded assets
 * - Content verification and integrity checking
 * - Cache-friendly filenames based on content
 *
 * **JSON Web Tokens** (`createJWT`, `verifyJWT`):
 * Provides JWT-based authentication for session management and API access.
 * Tokens are signed by the configured JWT key authority and can contain
 * arbitrary user data. Used for:
 * - Session persistence across WebSocket reconnections
 * - Stateless human/spectator verification; agent credentials additionally
 *   require their database-backed active session
 * - Stateless authentication with expiration
 *
 * **Security Notes**:
 * - Production supports a keyed signing ring with exact key selection
 * - JWT_SECRET remains a legacy no-kid migration bridge
 * - Tokens should have reasonable expiration times (set by caller)
 * - Hash algorithm (SHA-256) matches client for consistency
 *
 * **Referenced by**:
 * - index.ts (file upload endpoint)
 * - ServerNetwork.ts (authentication token generation/verification)
 */

import { createHash } from "crypto";
import jsonwebtoken from "jsonwebtoken";
import {
  HYPERIA_JWT_ALGORITHM,
  HYPERIA_JWT_AUDIENCE,
  HYPERIA_JWT_ISSUER,
  resolveJwtSigningKeyAuthority,
} from "../infrastructure/auth/jwt-signing-key-authority.js";
const jwt = jsonwebtoken;
const MAXIMUM_JWT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/**
 * Generates a SHA-256 hash of a file buffer
 *
 * Creates a cryptographic hash of file contents for content-addressable storage.
 * Implementation matches the client-side hashFile function exactly to ensure
 * files are identified consistently across client and server.
 *
 * Used for uploaded asset deduplication - files with the same hash are only
 * stored once, saving disk space and bandwidth.
 *
 * @param buffer - File contents as a Buffer
 * @returns Promise resolving to a 64-character hexadecimal hash string
 *
 * @example
 * const buffer = await fs.readFile('avatar.png')
 * const hash = await hashFile(buffer) // => 'a1b2c3d4...'
 * const filename = `${hash}.png` // => 'a1b2c3d4...png'
 */
export async function hashFile(buffer: Buffer): Promise<string> {
  const hash = createHash("sha256");
  hash.update(buffer);
  return hash.digest("hex");
}

/**
 * JSON Web Token authentication utilities
 *
 * Provides JWT creation and verification for session tokens.
 * New keyed tokens carry an exact `kid`, issuer, audience, algorithm, and
 * seven-day expiry. A no-kid token is accepted only through an explicitly
 * configured JWT_SECRET compatibility bridge (or the local development
 * fallback), never by trying every key in the ring.
 */

/**
 * Creates a signed JSON Web Token containing arbitrary data
 *
 * The token can be used for stateless authentication - verifying the token
 * confirms it was issued by this server without database lookups.
 *
 * @param data - Arbitrary payload to include in the token (user ID, roles, etc.)
 * @returns Promise resolving to a signed JWT string
 *
 * @example
 * const token = await createJWT({ userId: '123', roles: ['player'] })
 * // Send token to client for future requests
 */
export async function createJWT(
  data: Record<string, unknown>,
): Promise<string> {
  const authority = resolveJwtSigningKeyAuthority();
  const options: jsonwebtoken.SignOptions = {
    algorithm: HYPERIA_JWT_ALGORITHM,
    expiresIn: "7d",
  };
  if (authority.mode === "key-ring") {
    options.audience = HYPERIA_JWT_AUDIENCE;
    options.issuer = HYPERIA_JWT_ISSUER;
    options.keyid = authority.activeKeyId;
  }
  return jwt.sign(data, authority.activeSecret, options);
}

/**
 * Verifies and decodes a JSON Web Token
 *
 * Checks the token signature and returns the decoded payload if valid.
 * Returns null if the token is invalid, expired, or tampered with.
 *
 * @param token - JWT string to verify
 * @returns Promise resolving to decoded payload or null if invalid
 *
 * @example
 * const decoded = await verifyJWT(token)
 * if (decoded) {
 *   const userId = decoded.userId as string
 *   // Token is valid, proceed with authenticated request
 * } else {
 *   // Token invalid, reject request
 * }
 */
export async function verifyJWT(
  token: string,
): Promise<Record<string, unknown> | null> {
  try {
    const authority = resolveJwtSigningKeyAuthority();
    const decoded = jwt.decode(token, { complete: true });
    if (
      !decoded ||
      typeof decoded !== "object" ||
      decoded.header.alg !== HYPERIA_JWT_ALGORITHM
    ) {
      return null;
    }

    let secret: string | null = null;
    const options: jsonwebtoken.VerifyOptions = {
      algorithms: [HYPERIA_JWT_ALGORITHM],
    };
    if (decoded.header.kid !== undefined) {
      if (
        authority.mode !== "key-ring" ||
        typeof decoded.header.kid !== "string" ||
        decoded.header.typ !== "JWT"
      ) {
        return null;
      }
      secret =
        authority.keyedVerificationSecrets.get(decoded.header.kid) ?? null;
      if (!secret) return null;
      options.audience = HYPERIA_JWT_AUDIENCE;
      options.issuer = HYPERIA_JWT_ISSUER;
    } else {
      secret = authority.legacyVerificationSecret;
      if (!secret) return null;
    }

    const verified = jwt.verify(token, secret, options);
    if (!verified || typeof verified !== "object" || Array.isArray(verified)) {
      return null;
    }
    const payload = verified as Record<string, unknown>;
    if (
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) >
        MAXIMUM_JWT_LIFETIME_SECONDS
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
