/**
 * Error Routes Module - Error reporting endpoints
 *
 * Handles error reporting from clients including frontend JavaScript errors,
 * unhandled promise rejections, and other client-side exceptions.
 *
 * Endpoints:
 * - POST /api/errors/frontend - Report frontend errors to server logs
 *
 * Features:
 * - Structured error logging
 * - Stack trace capture
 * - Context information
 * - User agent tracking
 *
 * Usage:
 * ```typescript
 * import { registerErrorRoutes } from './routes/error-routes';
 * registerErrorRoutes(fastify);
 * ```
 */

import type { FastifyInstance } from "fastify";

const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_STACK_LENGTH = 16_000;
const MAX_URL_LENGTH = 2_048;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_CONTEXT_LENGTH = 4_096;

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, maxLength);
}

export function normalizeFrontendErrorReport(
  body: unknown,
  requestUserAgent: string | undefined,
): {
  message: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  context?: string;
} {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  let context: string | undefined;
  if (record.context !== undefined) {
    try {
      const serialized = JSON.stringify(record.context);
      context =
        typeof serialized === "string"
          ? serialized.slice(0, MAX_CONTEXT_LENGTH)
          : undefined;
    } catch {
      context = "[unserializable]";
    }
  }

  return {
    message:
      boundedString(record.message, MAX_ERROR_MESSAGE_LENGTH) ||
      "Unknown frontend error",
    stack: boundedString(record.stack, MAX_STACK_LENGTH),
    url: boundedString(record.url, MAX_URL_LENGTH),
    userAgent: boundedString(requestUserAgent, MAX_USER_AGENT_LENGTH),
    context,
  };
}

/**
 * Register error reporting endpoints
 *
 * Sets up endpoints for clients to report errors to the server.
 * Errors are logged to console for monitoring and debugging.
 *
 * @param fastify - Fastify server instance
 */
export function registerErrorRoutes(fastify: FastifyInstance): void {
  // Frontend error reporting endpoint
  fastify.post("/api/errors/frontend", async (request, reply) => {
    const report = normalizeFrontendErrorReport(
      request.body,
      request.headers["user-agent"],
    );
    request.log.error({ frontendError: report }, "Frontend error report");

    return reply.send({ success: true, logged: true });
  });
}
