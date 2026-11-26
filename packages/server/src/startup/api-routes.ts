/**
 * API Routes Module - REST endpoint registration coordinator
 *
 * Orchestrates registration of all HTTP API endpoints by delegating to
 * specialized route modules. Each route module handles a specific domain
 * (health, uploads, actions, etc.) for better organization and maintainability.
 *
 * **Modular Architecture**:
 * This file coordinates between specialized route modules:
 * - routes/health-routes.ts - Health check and server status
 * - routes/env-routes.ts - Public environment variables
 * - routes/upload-routes.ts - File upload handling
 * - routes/player-routes.ts - Player management
 * - routes/action-routes.ts - Action registry API
 * - routes/error-routes.ts - Error reporting
 * - routes/admin-routes.ts - Admin/debug endpoints (combat debugging)
 *
 * Endpoints provided:
 * - GET /health - Health check
 * - GET /status - Server status with connected players
 * - GET /env.js - Public environment variables
 * - POST /api/upload - File upload
 * - GET /api/upload-check - File existence check
 * - POST /api/player/disconnect - Player disconnect beacon
 * - GET /api/actions - List all actions
 * - GET /api/actions/available - Context-filtered actions
 * - POST /api/actions/:name - Execute action
 * - POST /api/errors/frontend - Frontend error reporting
 *
 * Usage:
 * ```typescript
 * registerApiRoutes(fastify, world, config);
 * ```
 */

import type { FastifyInstance } from "fastify";
import type { World } from "@hyperforge/shared";
import type { ServerConfig } from "./config.js";

// Import route modules
import { registerHealthRoutes } from "./routes/health-routes.js";
import { registerEnvRoutes } from "./routes/env-routes.js";
import { registerUploadRoutes } from "./routes/upload-routes.js";
import { registerPlayerRoutes } from "./routes/player-routes.js";
import { registerActionRoutes } from "./routes/action-routes.js";
import { registerErrorRoutes } from "./routes/error-routes.js";
import { registerCharacterRoutes } from "./routes/character-routes.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerUserRoutes } from "./routes/user-routes.js";
import { registerTemplateRoutes } from "./routes/template-routes.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerLayoutRoutes } from "./routes/layout-routes.js";
import { registerDataRoutes } from "./routes/data-routes.js";
import { registerProxyRoutes } from "../routes/proxy-routes.js";
import {
  registerStreamingRoutes,
  type StreamingRoutesRuntime,
} from "../routes/streaming.js";
import { registerDuelOracleRoutes } from "./routes/duel-oracle-routes.js";

/**
 * Register all API routes
 *
 * Coordinates registration of all HTTP API endpoints by delegating to
 * specialized route modules. This keeps the codebase organized with each
 * route group in its own file.
 *
 * @param fastify - Fastify server instance
 * @param world - Game world instance
 * @param config - Server configuration
 */
export function registerApiRoutes(
  fastify: FastifyInstance,
  world: World,
  config: ServerConfig,
): StreamingRoutesRuntime {
  console.log("[API] Registering API routes...");

  // Proxy API keys
  registerProxyRoutes(fastify, config);

  // Health and status endpoints
  registerHealthRoutes(fastify, world, config);

  // Environment variables endpoint
  registerEnvRoutes(fastify, config);

  // Upload endpoints
  registerUploadRoutes(fastify, config);

  // Player management
  registerPlayerRoutes(fastify, world);

  // Action registry endpoints
  registerActionRoutes(fastify, world);

  // Error reporting
  registerErrorRoutes(fastify);

  // Character file management and database operations
  registerCharacterRoutes(fastify, world, config);

  // Agent credential management
  registerAgentRoutes(fastify, world);

  // User management
  registerUserRoutes(fastify, world);

  // Character template management
  registerTemplateRoutes(fastify, world);

  // Admin/debug endpoints (combat debugging, anti-cheat)
  registerAdminRoutes(fastify, world, config);

  // Layout preset cloud sync
  registerLayoutRoutes(fastify, world);

  // Static game data endpoints
  registerDataRoutes(fastify);

  // Streaming mode state and leaderboard
  const streamingRoutes = registerStreamingRoutes(fastify, world);

  // Duel arena oracle metadata and inspection
  registerDuelOracleRoutes(fastify, world);

  console.log("[API] ✅ API routes registered");
  return streamingRoutes;
}
