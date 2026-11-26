/**
 * Action Routes Module - Action registry REST API
 *
 * Provides HTTP endpoints for discovering and executing game actions
 * via the action registry system. Actions are dynamically registered
 * by game systems and can be invoked via REST API.
 *
 * Endpoints:
 * - GET /api/actions - List all available actions
 * - GET /api/actions/available - Get actions available in specific context
 * - POST /api/actions/:name - Execute a specific action
 *
 * Usage:
 * ```typescript
 * import { registerActionRoutes } from './routes/action-routes';
 * registerActionRoutes(fastify, world);
 * ```
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { World } from "@hyperforge/shared";
import {
  getActionRateLimit,
  isRateLimitEnabled,
} from "../../infrastructure/rate-limit/rate-limit-config.js";
import { requirePrivyRequestUser } from "../../infrastructure/auth/http-auth.js";
import type { DatabaseSystem } from "../../systems/DatabaseSystem/index.js";

// JSON value type for proper typing
type JSONValue =
  string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

// Route schema interfaces
interface ActionRouteParams {
  name: string;
}

interface ActionRouteBody {
  context?: JSONValue;
  params?: JSONValue;
}

/**
 * Register action registry endpoints
 *
 * Sets up REST API endpoints for the action registry system.
 * Allows clients to discover available actions and execute them
 * with context-based filtering.
 *
 * @param fastify - Fastify server instance
 * @param world - Game world instance with action registry
 */
export function registerActionRoutes(
  fastify: FastifyInstance,
  world: World,
): void {
  // Build route config with rate limiting if enabled
  const actionRouteConfig = isRateLimitEnabled()
    ? { config: { rateLimit: getActionRateLimit() } }
    : {};

  const requireOwnedPlayer = async (
    request: FastifyRequest,
    reply: FastifyReply,
    playerId: unknown,
  ): Promise<string | null> => {
    if (
      typeof playerId !== "string" ||
      playerId.length < 1 ||
      playerId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(playerId)
    ) {
      await reply.status(400).send({ error: "Invalid playerId" });
      return null;
    }

    const authenticatedUserId = await requirePrivyRequestUser(request, reply);
    if (!authenticatedUserId) return null;

    const databaseSystem = world.getSystem("database") as
      DatabaseSystem | undefined;
    if (!databaseSystem) {
      await reply.status(503).send({ error: "Action authority unavailable" });
      return null;
    }
    const characters =
      await databaseSystem.getCharactersAsync(authenticatedUserId);
    if (!characters.some((character) => character.id === playerId)) {
      await reply.status(403).send({ error: "Forbidden" });
      return null;
    }
    return playerId;
  };

  // Get all available actions
  fastify.get(
    "/api/actions",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const actions = world.actionRegistry!.getAll();
      return reply.send({
        success: true,
        actions: actions.map((action: Record<string, unknown>) => ({
          name: action.name as string,
          description: action.description as string,
          parameters: action.parameters,
        })),
      });
    },
  );

  // Get available actions for context
  fastify.get(
    "/api/actions/available",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, unknown>;
      const playerId = query?.playerId
        ? await requireOwnedPlayer(request, reply, query.playerId)
        : undefined;
      if (query?.playerId && !playerId) return;
      const context = {
        world,
        playerId,
      };

      const actions = world.actionRegistry!.getAvailable(context);
      return reply.send({
        success: true,
        actions: actions.map((action: { name: string }) => action.name),
      });
    },
  );

  // Execute action (with rate limiting to prevent action spam)
  fastify.post<{ Params: ActionRouteParams; Body: ActionRouteBody }>(
    "/api/actions/:name",
    actionRouteConfig,
    async (request, reply) => {
      const actionName = request.params.name;
      if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(actionName)) {
        return reply.status(400).send({ error: "Invalid action name" });
      }
      const body = request.body;
      const params =
        body?.params &&
        typeof body.params === "object" &&
        !Array.isArray(body.params)
          ? (body.params as Record<string, unknown>)
          : {};
      const query = request.query as Record<string, JSONValue>;
      const playerId = await requireOwnedPlayer(
        request,
        reply,
        query?.playerId,
      );
      if (!playerId) return;
      const context = {
        world,
        playerId,
      };

      try {
        const result = await world.actionRegistry!.execute(
          actionName,
          context,
          params,
        );

        return reply.send({
          success: true,
          result,
        });
      } catch (err) {
        request.log.error(
          err,
          `[ActionRoutes] Action execution failed: ${actionName}`,
        );
        return reply.status(500).send({
          success: false,
          error: "Action execution failed.",
        });
      }
    },
  );
}
