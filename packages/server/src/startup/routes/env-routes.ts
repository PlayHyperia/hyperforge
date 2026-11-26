/**
 * Environment Routes Module - Public environment variable exposure
 *
 * Exposes PUBLIC_* environment variables to the client via a JavaScript
 * endpoint that sets global variables in the browser.
 *
 * Endpoints:
 * - GET /env.js - Returns JavaScript that sets globalThis.env with public variables
 *
 * Usage:
 * ```typescript
 * import { registerEnvRoutes } from './routes/env-routes';
 * registerEnvRoutes(fastify, config);
 * ```
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerConfig } from "../config.js";
import { getPublicEnvs } from "../config.js";

function normalizeDevelopmentHost(host: string | undefined): string {
  const normalized = host?.trim();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::") {
    return "localhost";
  }
  return normalized;
}

/**
 * Resolve the public runtime configuration embedded in /env.js.
 *
 * A production client bundle otherwise falls back to production endpoints even
 * when it is served by a local game server. Development defaults are emitted
 * here so any local port selection remains authoritative at runtime. Explicit
 * PUBLIC_* variables always win, and production API/WS topology is never
 * guessed by the server.
 */
export function resolvePublicRuntimeEnvs(
  config: ServerConfig,
  publicEnvs: Record<string, string> = getPublicEnvs(),
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved = { ...publicEnvs };

  resolved["PUBLIC_CDN_URL"] ||= config.cdnUrl;

  if (config.nodeEnv !== "production") {
    const host = normalizeDevelopmentHost(runtimeEnv.SERVER_HOST);
    const websocketPort =
      runtimeEnv.UWS_ENABLED === "false" ? config.port : config.uwsPort;

    resolved["PUBLIC_API_URL"] ||= `http://${host}:${config.port}`;
    resolved["PUBLIC_WS_URL"] ||= `ws://${host}:${websocketPort}/ws`;
  }

  return resolved;
}

/**
 * Register environment variables endpoint
 *
 * Creates a /env.js endpoint that exposes PUBLIC_* environment variables
 * to the client by generating JavaScript code that sets globalThis.env.
 *
 * @param fastify - Fastify server instance
 * @param config - Server configuration
 */
export function registerEnvRoutes(
  fastify: FastifyInstance,
  config: ServerConfig,
): void {
  const publicEnvs = resolvePublicRuntimeEnvs(config);

  const envsCode = `
  if (!globalThis.env) globalThis.env = {}
  globalThis.env = ${JSON.stringify(publicEnvs)}
`;

  fastify.get("/env.js", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type("application/javascript").send(envsCode);
  });
}
