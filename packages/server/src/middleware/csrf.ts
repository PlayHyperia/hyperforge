/**
 * CSRF Protection Middleware
 *
 * Implements Cross-Site Request Forgery protection using the double-submit cookie pattern:
 * 1. Server generates a cryptographically random token
 * 2. Token is stored in a SameSite=Strict cookie (csrf-token)
 * 3. Client must include the token in X-CSRF-Token header for state-changing requests
 * 4. Server validates header matches cookie
 *
 * This pattern works because:
 * - SameSite=Strict prevents the cookie from being sent in cross-origin requests
 * - Attackers cannot read the cookie value from another origin (same-origin policy)
 * - Attackers cannot set custom headers in cross-origin requests
 *
 * Exemptions:
 * - GET, HEAD, OPTIONS requests (safe methods per RFC 7231)
 * - /health and /status endpoints (monitoring)
 * - WebSocket upgrade requests
 * - Requests with valid Authorization header (API clients)
 */

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  HookHandlerDoneFunction,
} from "fastify";
import crypto from "crypto";

/** CSRF token cookie name */
const CSRF_COOKIE_NAME = "csrf-token";

/** CSRF header name */
const CSRF_HEADER_NAME = "x-csrf-token";

/** Token length in bytes (32 bytes = 256 bits) */
const TOKEN_LENGTH = 32;

/** Cookie max age (24 hours) */
const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Endpoints exempt from CSRF validation */
const EXEMPT_PATHS = new Set([
  "/health",
  "/status",
  "/env.js",
  "/api/errors/frontend", // Error reporting should work even during CSRF issues
]);

/** Safe HTTP methods that don't need CSRF validation */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Known cross-origin client domains.
 * These are protected by Origin header validation (in http-server.ts), so CSRF
 * cookie validation is redundant and doesn't work anyway (SameSite=Strict blocks cookies).
 */
const KNOWN_CROSS_ORIGIN_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/,
  /^https?:\/\/(www\.)?hyperia\.gg$/,
  /^https?:\/\/(www\.)?hyperbet\.win$/,
  /^https?:\/\/(www\.)?hyperia-betting\.pages\.dev$/,
  /^https?:\/\/.+\.hyperia-betting\.pages\.dev$/,
  /^https?:\/\/.+\.hyperbet\.pages\.dev$/,
  /^https?:\/\/.+\.hyperbet-solana\.pages\.dev$/,
  /^https?:\/\/.+\.hyperia\.pages\.dev$/,
];

/**
 * Generate a cryptographically secure CSRF token
 */
function generateCsrfToken(): string {
  return crypto.randomBytes(TOKEN_LENGTH).toString("hex");
}

/**
 * Check if a request should skip CSRF validation
 */
function shouldSkipCsrf(request: FastifyRequest): boolean {
  // Safe methods don't need CSRF protection
  if (SAFE_METHODS.has(request.method)) {
    return true;
  }

  // Exempt paths
  if (EXEMPT_PATHS.has(request.url.split("?")[0])) {
    return true;
  }

  // WebSocket upgrade requests
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    return true;
  }

  // API clients with Authorization header (Bearer token, API key, etc.)
  // These are already authenticated via a different mechanism
  if (request.headers.authorization) {
    return true;
  }

  // Admin requests with X-Admin-Code are already authenticated
  if (request.headers["x-admin-code"]) {
    return true;
  }

  // Cross-origin requests from known clients
  // These are already protected by Origin header validation in http-server.ts.
  // CSRF cookies use SameSite=Strict which doesn't work cross-origin, so we
  // skip CSRF validation for these and rely on Origin validation instead.
  const origin = request.headers.origin;
  if (origin) {
    for (const pattern of KNOWN_CROSS_ORIGIN_PATTERNS) {
      if (pattern.test(origin)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * CSRF token validation hook
 */
function validateCsrfToken(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  // Skip validation for exempt requests
  if (shouldSkipCsrf(request)) {
    done();
    return;
  }

  // Get token from cookie
  const cookies = request.headers.cookie;
  let cookieToken: string | undefined;

  if (cookies) {
    const match = cookies.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`));
    if (match) {
      cookieToken = match[1];
    }
  }

  // Get token from header
  const headerToken = request.headers[CSRF_HEADER_NAME] as string | undefined;

  // Validate both exist and match
  if (!cookieToken || !headerToken) {
    console.warn(
      `[CSRF] Missing token - cookie: ${!!cookieToken}, header: ${!!headerToken}, path: ${request.url}`,
    );
    reply.status(403).send({
      error: "CSRF validation failed",
      message: "Missing CSRF token. Please refresh the page and try again.",
    });
    return;
  }

  // Timing-safe comparison to prevent timing attacks
  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);

  if (
    cookieBuffer.length !== headerBuffer.length ||
    !crypto.timingSafeEqual(cookieBuffer, headerBuffer)
  ) {
    console.warn(
      `[CSRF] Token mismatch - path: ${request.url}, ip: ${request.ip}`,
    );
    reply.status(403).send({
      error: "CSRF validation failed",
      message: "Invalid CSRF token. Please refresh the page and try again.",
    });
    return;
  }

  done();
}

/**
 * Register CSRF protection on a Fastify instance
 *
 * This adds:
 * 1. A preHandler hook that validates CSRF tokens on state-changing requests
 * 2. A GET /api/csrf-token endpoint to get a new token
 *
 * @param fastify - Fastify instance
 */
export function registerCsrfProtection(fastify: FastifyInstance): void {
  // Add CSRF validation hook
  fastify.addHook("preHandler", validateCsrfToken);

  // Endpoint to get a CSRF token
  fastify.get("/api/csrf-token", async (request, reply) => {
    // Generate new token
    const token = generateCsrfToken();

    reply.header("Cache-Control", "no-store");

    // Set cookie with SameSite=Strict
    reply.header(
      "Set-Cookie",
      `${CSRF_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${
        process.env.NODE_ENV === "production" ? "; Secure" : ""
      }`,
    );

    // Also return token in response body for client convenience
    // The client should store this and include in X-CSRF-Token header
    return { token };
  });

  console.log("[CSRF] CSRF protection registered");
}

/**
 * Set SameSite=Strict on all cookies
 *
 * This is a helper to ensure all cookies set by the application
 * have the SameSite=Strict attribute for additional CSRF protection.
 */
export function enforceSameSiteCookies(fastify: FastifyInstance): void {
  fastify.addHook(
    "onSend",
    (
      request: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
      done: HookHandlerDoneFunction,
    ) => {
      const setCookie = reply.getHeader("set-cookie");

      if (setCookie) {
        // Ensure all cookies have SameSite=Strict
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        const updatedCookies = cookies.map((cookie) => {
          if (typeof cookie === "string" && !cookie.includes("SameSite")) {
            return `${cookie}; SameSite=Strict`;
          }
          return cookie;
        });

        reply.header("set-cookie", updatedCookies);
      }

      done();
    },
  );
}

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };
